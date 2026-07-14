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
 * @param {object} input
 * @param {string} input.runId — must pass isValidRunId
 * @param {string} input.runDir — runs/ directory (host-owned)
 * @param {number} [input.limit=50] — max items to collect
 * @param {Function} [input.readTranscriptFn] — injectable for testing
 * @param {Function} [input.appendCollectedFn] — injectable append (testing)
 * @param {Function} [input.fetchServeMessagesFn] — injectable serve fetch (testing)
 * @returns {Promise<{data: Array, reconstructed?: boolean, backend?: string}>}
 */
export async function collectRunMessages({
  runId,
  runDir,
  limit = DEFAULT_LIMIT,
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

  if (!session.serveUrl) {
    // Process-backed: reconstruct run.event entries from transcript.
    const reconstructed = events
      .filter((e) => e.type === "run.event")
      .map(reconstructProcessEvent)
      .filter((e) => e !== null)
      .slice(-effectiveLimit);

    const _append = appendCollectedFn ?? defaultAppendFn(transcriptPath, runId);
    await _append("messages.collected", {
      backendSessionId: session.backendSessionId,
      backend: "process",
      count: reconstructed.length,
      reconstructed: true,
    });

    return { data: reconstructed, reconstructed: true, backend: "process" };
  }

  // Serve-backed: fetch messages via backend capability.
  const runStarted = findLatest(events, "run.started");
  const _fetch = fetchServeMessagesFn ?? defaultServeFetch();
  const messages = await _fetch(session.serveUrl, session.backendSessionId, {
    cwd: runStarted?.cwd,
    limit: effectiveLimit,
  });

  const _append = appendCollectedFn ?? defaultAppendFn(transcriptPath, runId);
  await _append("messages.collected", {
    backendSessionId: session.backendSessionId,
    count: messages.data?.length ?? 0,
  });

  return messages;
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
