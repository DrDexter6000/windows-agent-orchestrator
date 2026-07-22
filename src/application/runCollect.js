// src/application/runCollect.js
//
// M9-4A: Shared application service for run result collection.
//
// This module owns the collect algorithm: reconstructing process-backed worker
// output from transcript run.event entries, or fetching serve-backed messages
// via the backend capability, then appending exactly one `messages.collected`
// durable audit event per successful call.
//
// CLI `collect` and MCP `run_collect` both call it so the algorithm exists once.
//
// Architectural contract:
//   - No argv parsing, no console.log, no process.exit.
//   - Does not import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Depends on transcript.js (readTranscript/findLatest/JsonlTranscript) and
//     delivery.js (isValidRunId).
//   - collect is NOT read-only and NOT idempotent: each successful call appends
//     one messages.collected audit event. This is the existing CLI contract.

import { join } from "node:path";

import { readTranscript, findLatest, JsonlTranscript, findLastEventSeq } from "../transcript.js";
import { isValidRunId } from "../delivery.js";

const DEFAULT_LIMIT = 50;

// M11-4 CTO rework (Fix B): the OpenCode serve /message endpoint only
// supports a `limit` query param (no cursor, no "fetch all"). In projection
// mode we request a large limit to retrieve the complete message list in a
// single call. 10000 is far above any realistic single-run worker output;
// if a real run ever exceeds it, serve continuation degrades gracefully
// (returns what serve gave) and the residual is documented. This is the
// narrowest compatible serve-equivalent — no second algorithm, no
// runtime-name branch in shared code.
const SERVE_PROJECTION_LIMIT = 10000;

// ===== Process event reconstruction (migrated from observe.js, TD-77) =====

/**
 * TD-77: Reconstruct a single run.event into a collect timeline entry.
 * Unknown kinds pass through (forward-compat). thinking is not persisted → null.
 * @param {object} ev
 * @returns {object|null}
 */
function reconstructProcessEvent(ev) {
  switch (ev.kind) {
    case "message":
      return { kind: "message", role: ev.role, parts: ev.parts };
    case "command":
      return { kind: "command", command: ev.command, ...(ev.exitCode !== undefined ? { exitCode: ev.exitCode } : {}) };
    case "tool_use":
      return { kind: "tool_use", tool: ev.tool, input: ev.input };
    case "tool_result":
      return { kind: "tool_result", tool: ev.tool, output: ev.output, isError: ev.isError };
    case "file_written":
      return { kind: "file_written", path: ev.path };
    case "thinking":
      return null;
    default:
      return { kind: ev.kind ?? "unknown", ...ev };
  }
}

// ===== Default append implementation (writes to the real transcript) =====

/**
 * Build a default appendCollectedFn that writes to the real transcript file.
 * Uses the validated runId argument (not events[0].runId) for the transcript
 * context so the audit event is always correctly attributed even if the first
 * event lacks a runId field.
 * @param {string} transcriptPath
 * @param {string} runId — the validated runId argument (authoritative)
 * @returns {Function}
 */
function defaultAppendFn(transcriptPath, runId) {
  return async (type, payload) => {
    // Re-read to get the latest seq + agentId (the file may have grown).
    let events = [];
    try { events = await readTranscript(transcriptPath); } catch { events = []; }
    const ctx = events[0] ?? {};
    const t = new JsonlTranscript(transcriptPath, {
      runId,
      agentId: ctx.agentId ?? "unknown",
      initialSeq: findLastEventSeq(events),
    });
    await t.append(type, payload);
  };
}

// ===== Service =====

/**
 * Collect a run's worker output and append one messages.collected audit event.
 *
 * Process-backed runs (no serveUrl): reconstruct run.event entries from the
 * transcript. Serve-backed runs (serveUrl present): fetch messages via the
 * backend capability (or injected fetchServeMessagesFn).
 *
 * M11-4 continuation: when `cursor` is provided AND `deferAppend` is true,
 * the service reads + reconstructs the snapshot but does NOT append the audit
 * event. It returns a `commitAppend` function the caller MUST invoke after
 * the projection layer has validated the cursor binding and produced a
 * successful page. This guarantees invalid cursors and projection failures
 * result in ZERO audit appends (M11-4 §12). When `deferAppend` is false
 * (default, M9-4A back-compat), the service appends exactly once before
 * returning, preserving the existing CLI/M9-4A contract.
 *
 * @param {object} input
 * @param {string} input.runId — must pass isValidRunId
 * @param {string} input.runDir — runs/ directory (host-owned)
 * @param {number} [input.limit=50] — max items to collect
 * @param {string} [input.cursor] — opaque continuation token (M11-4)
 * @param {boolean} [input.deferAppend=false] — when true, do not append; return
 *        commitAppend for the caller to invoke after projection success
 * @param {Function} [input.readTranscriptFn] — injectable for testing
 * @param {Function} [input.appendCollectedFn] — injectable append (testing)
 * @param {Function} [input.fetchServeMessagesFn] — injectable serve fetch (testing)
 * @returns {Promise<{data: Array, reconstructed?: boolean, backend?: string, commitAppend?: Function}>}
 */
export async function collectRunMessages({
  runId,
  runDir,
  limit = DEFAULT_LIMIT,
  cursor,
  deferAppend = false,
  readTranscriptFn,
  appendCollectedFn,
  fetchServeMessagesFn,
}) {
  if (!runId || typeof runId !== "string") {
    throw new Error("collectRunMessages: runId is required");
  }
  if (!runDir || typeof runDir !== "string") {
    throw new Error("collectRunMessages: runDir is required");
  }
  // Validate runId BEFORE any path construction, file read, fetch, or append.
  if (!isValidRunId(runId)) {
    throw new Error(`Invalid runId: ${JSON.stringify(runId)}`);
  }

  const _readTranscript = readTranscriptFn ?? readTranscript;
  const transcriptPath = join(runDir, `${runId}.jsonl`);

  const events = await _readTranscript(transcriptPath);

  // Session capability determines process vs serve path.
  const session = findLatest(events, "session.created");
  if (!session?.backendSessionId) {
    throw new Error(`Run ${runId} has no session metadata (no session.created event)`);
  }

  // limit=0 means "all" (existing CLI semantics: slice(-0) returns everything).
  // Negative/NaN/non-number falls back to the default. MCP always passes 50.
  const numericLimit = Number(limit);
  const effectiveLimit = Number.isFinite(numericLimit) && numericLimit >= 0
    ? Math.floor(numericLimit)
    : DEFAULT_LIMIT;

  // M11-4 CTO rework (Fix A+C): the projection/continuation path (any call
  // with deferAppend=true, i.e. MCP and CLI --format json / --cursor) MUST
  // read the COMPLETE worker-authored snapshot, not a pre-truncated tail.
  // The old code always sliced to the last `effectiveLimit` items BEFORE
  // pagination, permanently hiding earlier messages (RED-1: 60 messages →
  // only last 50 reachable). Now: projection mode reads ALL run.event
  // entries; the legacy raw CLI mode (deferAppend=false) keeps the
  // slice(-limit) behavior byte-compatible.
  //
  // Serve path: the backend /message endpoint only supports a `limit` query
  // param (no "fetch all"). In projection mode we pass a large limit
  // (SERVE_PROJECTION_LIMIT) to retrieve the complete message list in one
  // call; if a real worker run ever exceeds it, continuation degrades
  // gracefully (returns what serve gave). This is the narrowest compatible
  // serve-equivalent; no second algorithm, no runtime-name branch.
  const isProjectionMode = deferAppend;

  if (!session.serveUrl) {
    // Process-backed: reconstruct run.event entries from transcript.
    const reconstructedAll = events
      .filter((e) => e.type === "run.event")
      .map(reconstructProcessEvent)
      .filter((e) => e !== null);
    const reconstructed = isProjectionMode
      ? reconstructedAll                     // full snapshot — pagination handles bounds
      : reconstructedAll.slice(-effectiveLimit);  // legacy raw CLI tail behavior

    const payload = {
      backendSessionId: session.backendSessionId,
      backend: "process",
      count: reconstructed.length,
      reconstructed: true,
    };
    if (isProjectionMode) {
      return {
        data: reconstructed, reconstructed: true, backend: "process",
        commitAppend: buildCommitAppend(appendCollectedFn, transcriptPath, runId, payload),
      };
    }
    const _append = appendCollectedFn ?? defaultAppendFn(transcriptPath, runId);
    await _append("messages.collected", payload);
    return { data: reconstructed, reconstructed: true, backend: "process" };
  }

  // Serve-backed: fetch messages via backend capability.
  // Projection mode: request the full list (large limit). Legacy mode: tail.
  const runStarted = findLatest(events, "run.started");
  const _fetch = fetchServeMessagesFn ?? defaultServeFetch();
  const serveLimit = isProjectionMode ? SERVE_PROJECTION_LIMIT : effectiveLimit;
  const messages = await _fetch(session.serveUrl, session.backendSessionId, {
    cwd: runStarted?.cwd,
    limit: serveLimit,
  });

  const payload = {
    backendSessionId: session.backendSessionId,
    count: messages.data?.length ?? 0,
  };
  if (isProjectionMode) {
    return {
      ...messages,
      commitAppend: buildCommitAppend(appendCollectedFn, transcriptPath, runId, payload),
    };
  }
  const _append = appendCollectedFn ?? defaultAppendFn(transcriptPath, runId);
  await _append("messages.collected", payload);
  return messages;
}

/**
 * Build a commitAppend closure that invokes the real (or injected) append
 * with the prepared payload. The caller invokes this only after the projection
 * layer has validated the cursor and produced a successful page.
 */
function buildCommitAppend(appendCollectedFn, transcriptPath, runId, payload) {
  return async () => {
    const _append = appendCollectedFn ?? defaultAppendFn(transcriptPath, runId);
    await _append("messages.collected", payload);
  };
}

/**
 * Build a default serve fetch that uses the real OpenCodeServeBackend.
 * Imported lazily to keep the module boundary clean (only needed for serve path).
 * @returns {Function}
 */
function defaultServeFetch() {
  return async (serveUrl, sessionId, opts) => {
    const { OpenCodeServeBackend } = await import("../backends/opencodeServe.js");
    const backend = new OpenCodeServeBackend();
    return backend.messages(serveUrl, sessionId, opts);
  };
}

export { reconstructProcessEvent };
