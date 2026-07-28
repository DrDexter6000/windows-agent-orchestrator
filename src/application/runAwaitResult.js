// src/application/runAwaitResult.js
//
// M12-3 Package A: runAwaitResult — a read-only, advisory composite that folds
// (1) a Lead-controlled bounded wait for terminal (waitMs 0..270000), (2) a
// truthful run/liveness/cursor observation, and (3) a safe terminal-then-compact
// collection into ONE call. All existing atomic tools (run_wait / run_collect /
// run_status …) remain available for arbitrary re-polling; this tool only adds
// a convenience path.
//
// HARD ADVISORY CONTRACT — it must NEVER:
//   - stop / retry / diagnose / decide / accept / reject / repackage a run,
//   - append transcript events (zero messages.collected, never commitAppend),
//   - make a semantic judgment about worker output,
//   - perform any serve HTTP fetch (snapshot-only local projection).
//
// SINGLE FINAL SNAPSHOT (correction 1): every returned fact — state, terminal,
// cursor, ownership proof, agentId, AND the compact text/counts/backend — is
// derived from ONE explicit transcript event snapshot. There is no second
// parser and no post-terminal reread: the same `events` array feeds both the
// run observation and reconstructItemsFromEvents → projectCollectResult.
//
// TOTAL BUDGET (correction 2): waitMs is ONE shared composition budget. The
// terminal path does no network fetch, no retries, no sleeps beyond the wait
// loop; the compact projection is a bounded local parse of the in-memory
// snapshot. waitMs=0 reads once and returns immediately (point-in-time).
//
// TRUTHFUL UNOBSERVED VALUES (correction 3): for status not_terminal /
// unavailable / read-failure, the fields that were NOT actually collected
// (evidenceCounts, itemCount, assistantMessageCount, reconstructed, backend)
// are null — never fabricated zero/false. status=empty (terminal, observed)
// carries the observed zeros the snapshot actually produced.
//
// OBSERVATION OUTCOME (correction 4): a mandatory closed-set field
// (observationOutcome ∈ {observed, read_failure}) distinguishes a clean final
// read (point-in-time / window expiry / terminal) from a post-initial re-read
// failure. On a read failure the composite reports liveness="unknown" and
// ownerHeartbeat="unknown" — it does NOT call summarizeLiveness, so stale
// event liveness is never combined with a fresh owner heartbeat into an
// apparently-current observation.
//
// REAL THROTTLING (correction 5): the default progress interval is 30000 ms,
// INDEPENDENT of the internal poll interval. The first notification is not
// emitted before one full interval, and a slow notification transport is never
// awaited by the observation loop. Clients without a progress hook receive
// none. Terminal still returns early.
//
// OPEN-WORLD TRUTH (correction 6): the composite uses ONLY durable transcript
// snapshot data — no serve HTTP fetch — so openWorldHint:false stays accurate.
//
// Architectural contract:
//   - Does NOT import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Does NOT import the run-collect message service or the serve backend
//     (snapshot-only: no network fetch path is reachable from this module).
//   - Reuses the M12-2A projection SSOT (projectCollectResult) and the shared
//     snapshot reconstruction (reconstructItemsFromEvents) — no second parser,
//     no duplicated redaction/sanitization internals.
//   - Reuses summarizeLiveness from runWait (zero-drift liveness SSOT).

import { join, resolve } from "node:path";

import { readTranscript, findState, TERMINAL_STATES, findLastEventSeq, extractCanonicalAgentId } from "../transcript.js";
import { isValidRunId } from "../delivery.js";
import { verifyRunWorkspaceOwnership } from "./runWorkspaceOwnership.js";
import { summarizeLiveness } from "./runWait.js";
import { reconstructItemsFromEvents } from "./runCollect.js";
import { projectCollectResult } from "./runCollectProjection.js";

// waitMs is a single composition budget. 0 = pure point-in-time (read once,
// return immediately). The default matches run_wait's default observation
// window. The hard cap (270000) is the maximum a caller may ask this ONE call
// to wait; arbitrary re-polling via run_wait/run_collect remains unbounded by
// this tool's budget.
export const RUN_AWAIT_RESULT_MIN_MS = 0;
export const RUN_AWAIT_RESULT_DEFAULT_MS = 270000;
export const RUN_AWAIT_RESULT_MAX_MS = 270000;

// Default progress keepalive interval. This is INDEPENDENT of the internal poll
// interval (pollIntervalMs) — a tiny poll interval must NOT inflate the number
// of notifications. 30000 ms keeps a long poll alive without flooding the
// client, and yields a structural upper bound of floor(waitMs/30000)+1.
export const RUN_AWAIT_RESULT_DEFAULT_PROGRESS_MS = 30000;

// A result partition whose fields were NOT observed (not_terminal / unavailable
// / read-failure). Null — never a fabricated zero/false. The key set is uniform
// with the collected result so callers see one stable shape.
function unobservedResult(status) {
  return {
    status,
    messages: [],
    evidenceCounts: null,
    itemCount: null,
    assistantMessageCount: null,
    reconstructed: null,
    backend: null,
  };
}

/**
 * Project a compact terminal-then-collect result from ONE explicit transcript
 * snapshot, reusing the M12-2A projection SSOT (redaction + C0/C1/DEL
 * sanitization + evidenceCounts + too_large/empty semantics) and the shared
 * snapshot reconstruction. No second parser, no serve fetch. Any projection
 * failure collapses to status=unavailable with NO error detail leaked — the
 * terminal run observation is preserved by the caller.
 *
 * @param {Array<object>} events — explicit transcript event snapshot
 * @param {string} runId
 * @param {string} agentId — canonical agentId derived from the same snapshot
 * @param {object} env — env for the secret redactor
 * @param {Function} projectFn — projectCollectResult (injectable for testing)
 * @returns {Promise<object>} {status, messages, evidenceCounts, itemCount, assistantMessageCount, reconstructed, backend}
 */
function collectCompactFromSnapshot(events, runId, agentId, env, projectFn) {
  try {
    const items = reconstructItemsFromEvents(events);
    const session = [...events].reverse().find((event) =>
      event?.type === "session.created" && event.runId === runId);
    const backend = typeof session?.backend === "string" && session.backend.length > 0
      ? session.backend
      : "unknown";
    const raw = { data: items, reconstructed: true, backend, agentId };
    // compact mode: single-shot, no cursor, reuses the SAME redaction/
    // sanitization/evidenceCounts SSOT as full run_collect. compactStatus is
    // exactly the result.status closed-set member (available|empty|too_large).
    // The production projection is deliberately synchronous local work. Do not
    // accept an async replacement here: awaiting it would turn terminal
    // finalization into a second unbounded phase after the wait budget.
    const proj = projectFn(raw, { runId, mode: "compact", env });
    if (proj && typeof proj.then === "function") {
      throw new Error("async compact projection is not supported");
    }
    return {
      status: proj.compactStatus,
      messages: proj.messages,
      evidenceCounts: proj.evidenceCounts,
      itemCount: proj.itemCount,
      assistantMessageCount: proj.assistantMessageCount,
      reconstructed: proj.reconstructed,
      backend: proj.backend,
    };
  } catch {
    // Projection failure (e.g. injected for testing, or a malformed snapshot):
    // collapse to unavailable. The terminal run facts are preserved upstream;
    // NO error detail is placed in the result (redaction contract).
    return unobservedResult("unavailable");
  }
}

/**
 * Read-only composite: bounded wait + truthful observation + terminal compact.
 *
 * @param {object} input
 * @param {string} input.runId — must pass isValidRunId
 * @param {string} input.runDir — runs/ directory (host-owned)
 * @param {number} [input.afterSeq] — cursor; omitted = baseline-at-first-read
 * @param {number} [input.waitMs=270000] — composition budget (0..270000)
 * @param {string} [input.authorizedWorkspaceRoot] — MCP workspace binding
 * @param {Function} [input.nowFn] — injectable clock (testing)
 * @param {Function} [input.sleepFn] — injectable sleep (testing)
 * @param {Function} [input.readTranscriptFn] — injectable reader (testing)
 * @param {number} [input.pollIntervalMs=2000] — internal poll interval
 * @param {number} [input.progressIntervalMs=30000] — keepalive throttle
 * @param {Function} [input.onProgress] — keepalive hook ({index, fraction, waitedMs})
 * @param {object} [input.env] — env for the secret redactor
 * @param {Function} [input.projectCollectResultFn] — injectable projection (testing)
 * @returns {Promise<object>}
 */
export async function runAwaitResult(input) {
  const { runId, runDir, waitMs = RUN_AWAIT_RESULT_DEFAULT_MS, authorizedWorkspaceRoot } = input;

  // Distinguish omitted afterSeq from explicit 0 (same semantic as run_wait).
  const afterSeqOmitted = !Object.prototype.hasOwnProperty.call(input, "afterSeq")
    || input.afterSeq === undefined;
  if (!afterSeqOmitted) {
    const as = input.afterSeq;
    if (!Number.isInteger(as) || as < 0) {
      throw new Error(`invalid afterSeq: must be a non-negative integer, got: ${JSON.stringify(as)}`);
    }
  }

  // Validate runId BEFORE any path construction or file read.
  if (!isValidRunId(runId)) {
    throw new Error(`invalid runId: ${JSON.stringify(runId)}`);
  }

  // Validate waitMs — the service is a shared business boundary, not every
  // caller goes through MCP zod.
  if (!Number.isInteger(waitMs) || waitMs < RUN_AWAIT_RESULT_MIN_MS || waitMs > RUN_AWAIT_RESULT_MAX_MS) {
    throw new Error(`waitMs must be an integer in [${RUN_AWAIT_RESULT_MIN_MS}, ${RUN_AWAIT_RESULT_MAX_MS}], got: ${JSON.stringify(waitMs)}`);
  }

  const _now = input.nowFn ?? (() => Date.now());
  const _sleep = input.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const _read = input.readTranscriptFn ?? readTranscript;
  const pollIntervalMs = input.pollIntervalMs ?? 2000;
  const progressIntervalMs = input.progressIntervalMs ?? RUN_AWAIT_RESULT_DEFAULT_PROGRESS_MS;
  const onProgress = typeof input.onProgress === "function" ? input.onProgress : null;
  const projectFn = input.projectCollectResultFn ?? projectCollectResult;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("pollIntervalMs must be a positive integer");
  }
  if (!Number.isInteger(progressIntervalMs) || progressIntervalMs <= 0) {
    throw new Error("progressIntervalMs must be a positive integer");
  }

  const resolvedRunDir = resolve(runDir);
  const transcriptPath = join(resolvedRunDir, `${runId}.jsonl`);

  // Single baseline for deadline + waitedMs + progress fraction. Captured once
  // so a fake clock is not advanced twice (test determinism).
  const begin = _now();

  // ===== INITIAL READ (read #1) =====
  let events;
  try {
    events = await _read(transcriptPath);
  } catch {
    // Initial read failure: no facts at all. Report read_failure truthfully;
    // do not invent a state/cursor. waitedMs is 0 (no waiting occurred).
    return {
      runId,
      agentId: "unknown",
      state: "unknown",
      terminal: false,
      cursor: null,
      returnedEarly: false,
      waitedMs: 0,
      observationOutcome: "read_failure",
      liveness: "unknown",
      activityEventCount: null,
      lastActivityKind: null,
      ownerHeartbeat: "unknown",
      result: unobservedResult("unavailable"),
    };
  }

  // Workspace authorization (MCP path) — needs the events snapshot.
  if (authorizedWorkspaceRoot !== undefined) {
    verifyRunWorkspaceOwnership(events, authorizedWorkspaceRoot);
  }

  const state = findState(events);
  const terminal = TERMINAL_STATES.includes(state);
  const cursor = findLastEventSeq(events) ?? 0;
  const agentId = extractCanonicalAgentId(events, runId);

  // Activity baseline: omitted → cursor at first read (only window-new events
  // count); explicit → the caller's cursor.
  const activityBaseline = afterSeqOmitted ? cursor : input.afterSeq;

  // ===== TERMINAL AT ENTRY =====
  // Single snapshot: the same `events` feeds the observation AND the compact
  // collect. No post-terminal reread.
  if (terminal) {
    return {
      runId,
      agentId,
      state,
      terminal: true,
      cursor,
      returnedEarly: true,
      waitedMs: 0,
      observationOutcome: "observed",
      liveness: "terminal",
      activityEventCount: 0,
      lastActivityKind: null,
      ownerHeartbeat: "n/a",
      result: collectCompactFromSnapshot(events, runId, agentId, input.env, projectFn),
    };
  }

  // ===== POINT-IN-TIME (waitMs === 0) =====
  // Read once, return immediately. No sleep, no loop.
  if (waitMs === 0) {
    const liv = summarizeLiveness({ events, runDir: resolvedRunDir, runId, activityBaseline, now: _now() });
    return {
      runId,
      agentId,
      state,
      terminal: false,
      cursor,
      returnedEarly: false,
      waitedMs: 0,
      observationOutcome: "observed",
      liveness: liv.liveness,
      activityEventCount: liv.activityEventCount,
      lastActivityKind: liv.lastActivityKind,
      ownerHeartbeat: liv.ownerHeartbeat,
      result: unobservedResult("not_terminal"),
    };
  }

  // ===== BOUNDED WAIT LOOP =====
  const deadline = begin + waitMs;
  let currentEvents = events;
  let currentState = state;
  let currentCursor = cursor;

  // Progress throttle: no eager notification. The first keepalive is due only
  // after one complete interval, then at most once per interval.
  let nextNotifyAt = begin + progressIntervalMs;
  let pollIndex = 0;

  while (_now() < deadline) {
    const remaining = deadline - _now();
    if (remaining <= 0) break;
    await _sleep(Math.min(pollIntervalMs, remaining));

    let pollEvents;
    try {
      pollEvents = await _read(transcriptPath);
    } catch {
      // RE-READ FAILURE: do NOT combine stale events with a fresh owner
      // heartbeat. Report read_failure with liveness/heartbeat unknown and a
      // null activity tally — the observation is stale, not current.
      return {
        runId,
        agentId,
        state: currentState,
        terminal: false,
        cursor: currentCursor,
        returnedEarly: false,
        waitedMs: _now() - begin,
        observationOutcome: "read_failure",
        liveness: "unknown",
        activityEventCount: null,
        lastActivityKind: null,
        ownerHeartbeat: "unknown",
        result: unobservedResult("unavailable"),
      };
    }

    // Every snapshot that can drive returned facts must independently prove
    // workspace ownership. A transcript replacement between polls must not let
    // foreign terminal data pass on the authority of the initial snapshot.
    if (authorizedWorkspaceRoot !== undefined) {
      verifyRunWorkspaceOwnership(pollEvents, authorizedWorkspaceRoot);
    }

    currentEvents = pollEvents;
    currentState = findState(currentEvents);
    currentCursor = findLastEventSeq(currentEvents) ?? currentCursor;

    if (TERMINAL_STATES.includes(currentState)) {
      // TERMINAL DURING WAIT — collect from THIS (terminal-observing) snapshot.
      // Single snapshot: collect adds ZERO extra reads.
      const termAgentId = extractCanonicalAgentId(currentEvents, runId);
      return {
        runId,
        agentId: termAgentId,
        state: currentState,
        terminal: true,
        cursor: currentCursor,
        returnedEarly: true,
        waitedMs: _now() - begin,
        observationOutcome: "observed",
        liveness: "terminal",
        activityEventCount: 0,
        lastActivityKind: null,
        ownerHeartbeat: "n/a",
        result: collectCompactFromSnapshot(currentEvents, runId, termAgentId, input.env, projectFn),
      };
    }

    // Progress keepalive (throttled, opt-in). A thrown hook must not break the
    // wait — the observation is what matters, not the side channel.
    if (onProgress) {
      const nowMs = _now();
      if (nowMs >= nextNotifyAt) {
        while (nextNotifyAt <= nowMs) nextNotifyAt += progressIntervalMs;
        pollIndex += 1;
        const fraction = waitMs > 0 ? Math.min(Math.max((nowMs - begin) / waitMs, 0), 0.999) : 0;
        try {
          const pending = onProgress({ index: pollIndex, fraction, waitedMs: nowMs - begin });
          if (pending && typeof pending.catch === "function") {
            void pending.catch(() => {});
          }
        } catch { /* keepalive failure must not break the wait */ }
      }
    }
  }

  // ===== WINDOW EXPIRY (clean final read) =====
  const liv = summarizeLiveness({ events: currentEvents, runDir: resolvedRunDir, runId, activityBaseline, now: _now() });
  return {
    runId,
    agentId,
    state: currentState,
    terminal: false,
    cursor: currentCursor,
    returnedEarly: false,
    waitedMs: _now() - begin,
    observationOutcome: "observed",
    liveness: liv.liveness,
    activityEventCount: liv.activityEventCount,
    lastActivityKind: liv.lastActivityKind,
    ownerHeartbeat: liv.ownerHeartbeat,
    result: unobservedResult("not_terminal"),
  };
}
