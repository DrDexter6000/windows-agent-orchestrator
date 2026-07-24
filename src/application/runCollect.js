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

import { readTranscript, findLatest, JsonlTranscript, findLastEventSeq, extractCanonicalAgentId } from "../transcript.js";
import { isValidRunId } from "../delivery.js";

const DEFAULT_LIMIT = 50;

// M11-4 final serve-cap closeout: projection mode must NEVER silently report
// a truncated serve tail as a complete read.
//
// Capability note (corrected): the OpenCode /message endpoint DOES support
// upstream pagination (a `before` cursor / X-Next-Cursor header). WAO's
// current OpenCodeServeBackend.messages adapter does NOT consume that — it
// issues a single bounded `limit` request. M11-4 builds on that current
// adapter behavior: we define an explicit maximum acceptable serve snapshot
// (SERVE_PROJECTION_LIMIT) and request cap+1 items (the sentinel). If serve
// returns ≥ sentinel items, the run exceeded our adapter's safe capacity and
// we FAIL CLOSED (throw before any append or projection) — the caller
// (MCP/CLI) collapses this to a fixed `run_collect failed` with zero partial
// output and zero audit append.
//
// 10000 is far above any realistic single-run worker output. If a real run
// ever exceeds it, that is a genuine adapter-capacity limit (not a claim
// that OpenCode itself cannot paginate): the Lead gets an explicit failure
// and must narrow the task. Consuming upstream pagination is a future
// adapter enhancement, out of scope for M11-4.
const SERVE_PROJECTION_LIMIT = 10000;
const SERVE_PROJECTION_SENTINEL = SERVE_PROJECTION_LIMIT + 1;

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
 * M11-4 continuation + CTO rework: when `deferAppend` is true (projection
 * mode — MCP always, CLI --format json / --cursor), the service reads +
 * reconstructs the FULL snapshot but does NOT append the audit event,
 * regardless of whether a cursor is present. It returns a `commitAppend`
 * function the caller MUST invoke after the projection layer has validated
 * the cursor binding (or produced page 1) AND output schema validation
 * succeeded. This guarantees ANY failure — invalid cursor, projection
 * failure, schema failure, serve-cap overflow — results in ZERO audit
 * appends, including on cursor-less page 1 (M11-4 §12 + CTO rework Fix D).
 * When `deferAppend` is false (default, legacy raw CLI back-compat), the
 * service appends exactly once before returning.
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

  // M11-8B closeout: canonical agentId from the transcript envelope, bound to
  // the requested runId. Passed through to the projection so MCP/CLI expose a
  // unified identity. Missing/conflicting/invalid/cross-run → "unknown".
  const agentId = extractCanonicalAgentId(events, runId);

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
  // Serve path: WAO's current OpenCodeServeBackend.messages adapter issues a
  // single bounded `limit` request (it does not consume OpenCode's upstream
  // `before` / X-Next-Cursor pagination). In projection mode we request cap+1
  // (sentinel) items; if serve returns ≥ sentinel, the run exceeds our
  // adapter's safe capacity and we FAIL CLOSED below — never report a
  // truncated tail as a complete read. Process and serve share one
  // continuation contract (shape-driven algorithm, no runtime-name branch).
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
        data: reconstructed, reconstructed: true, backend: "process", agentId,
        commitAppend: buildCommitAppend(appendCollectedFn, transcriptPath, runId, payload),
      };
    }
    const _append = appendCollectedFn ?? defaultAppendFn(transcriptPath, runId);
    await _append("messages.collected", payload);
    return { data: reconstructed, reconstructed: true, backend: "process", agentId };
  }

  // Serve-backed: fetch messages via backend capability.
  // Projection mode: request cap+1 (sentinel) so we can detect a run that
  // exceeds the safe serve snapshot capacity. Legacy mode: tail (limit).
  const runStarted = findLatest(events, "run.started");
  const _fetch = fetchServeMessagesFn ?? defaultServeFetch();
  const serveLimit = isProjectionMode ? SERVE_PROJECTION_SENTINEL : effectiveLimit;
  const messages = await _fetch(session.serveUrl, session.backendSessionId, {
    cwd: runStarted?.cwd,
    limit: serveLimit,
  });

  // M11-4 serve-cap: if serve returned ≥ sentinel items, the run exceeds our
  // safe capacity. Fail closed BEFORE any append or projection — never
  // report a truncated tail as a complete read. This throw propagates to the
  // MCP/CLI handler try/catch which collapses it to a fixed safe text with
  // zero partial output and zero audit append.
  if (isProjectionMode && Array.isArray(messages.data) && messages.data.length >= SERVE_PROJECTION_SENTINEL) {
    throw new Error("serve snapshot exceeds safe capacity");
  }

  const payload = {
    backendSessionId: session.backendSessionId,
    count: messages.data?.length ?? 0,
  };
  if (isProjectionMode) {
    return {
      ...messages,
      agentId,
      commitAppend: buildCommitAppend(appendCollectedFn, transcriptPath, runId, payload),
    };
  }
  const _append = appendCollectedFn ?? defaultAppendFn(transcriptPath, runId);
  await _append("messages.collected", payload);
  return { ...messages, agentId };
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
