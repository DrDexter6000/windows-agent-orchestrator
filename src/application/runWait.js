// src/application/runWait.js
//
// M10-pre3 Batch B: Liveness-aware run wait service.
//
// Provides a bounded long-poll that waits for a run to reach terminal state
// or for the observation period to expire, then returns a liveness summary.
//
// The service is strictly read-only:
//   - Does NOT write transcript events
//   - Does NOT create owner files
//   - Does NOT change any durable fact
//   - Does NOT own stop decisions (Lead decides based on liveness)
//
// Architectural contract:
//   - Does NOT import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Reuses transcript readTranscript/findState, isValidRunId,
//     verifyRunWorkspaceOwnership, and checkOwnerLiveness SSOT.

import { join, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";

import { readTranscript, findState, TERMINAL_STATES, findLastEventSeq, extractCanonicalAgentId } from "../transcript.js";
import { isValidRunId } from "../delivery.js";
import { verifyRunWorkspaceOwnership } from "./runWorkspaceOwnership.js";
import { checkOwnerLiveness } from "./ownerLiveness.js";

// ── Progress event types (closed set) ────────────────────────────────────────
//
// NOTE: run.metrics is a DISTINCT transcript type written by runManager (see
// src/runManager.js:791 — `transcript.append("run.metrics", {tokens, costUsd})`),
// NOT `run.event` with kind=metrics. Earlier this set listed only "run.event"
// and silently dropped standalone metrics events, causing real runs whose only
// window activity was a token-usage tick to be misreported as silent. The
// closed set now names run.metrics explicitly so it always counts.

const PROGRESS_EVENT_TYPES = new Set([
  "run.event",       // durable RunEvent (message/thinking/command/tool_use/tool_result/file_written)
  "run.metrics",     // standalone metrics tick (tokens/cost) — own transcript type
  "run.state_change",
  "run.completed",
  "run.failed",
  "run.aborted",
  "run.timed_out",
  "run.error",
  "run.delivery_created",
  "run.delivery_failed",
  "run.delivery_verification_passed",
  "run.delivery_verification_failed",
  "run.delivery_verification_unavailable",
  "run.delivery_accepted",
  "run.delivery_rejected",
  "scorecard.checked",
]);

/**
 * Activity kinds that count as durable progress.
 * Maps run.event payload kind to a safe summary label.
 * (run.metrics maps to "metrics" via the standalone-type branch below.)
 */
const ACTIVITY_KIND_MAP = {
  message: "message",
  thinking: "thinking",
  command: "command",
  tool_use: "tool_use",
  tool_result: "tool_result",
  file_written: "file_written",
};

/**
 * Determine the safe activity kind label from an event.
 * Returns null if the event has no usable activity kind.
 * Never returns the raw payload — only a closed safe label.
 */
function activityKind(event) {
  // Standalone run.metrics transcript event → safe "metrics" label.
  // (token/cost values are NOT returned; only the kind label is exposed.)
  if (event.type === "run.metrics") return "metrics";
  if (event.type === "run.event" && event.kind) {
    return ACTIVITY_KIND_MAP[event.kind] ?? null;
  }
  // State transitions and delivery events are also progress
  if (PROGRESS_EVENT_TYPES.has(event.type)) {
    if (event.type === "run.state_change") return "state";
    if (event.type.startsWith("run.delivery")) return "delivery";
    if (event.type === "scorecard.checked") return "scorecard";
    return event.type.replace("run.", "");
  }
  return null;
}

/**
 * Count progress events after a given seq.
 */
function countProgressAfterSeq(events, afterSeq) {
  let count = 0;
  let lastKind = null;
  for (const e of events) {
    if (typeof e.seq === "number" && e.seq > afterSeq) {
      const kind = activityKind(e);
      if (kind) {
        count++;
        lastKind = kind;
      }
    }
  }
  return { count, lastKind };
}

/**
 * Wait for a run to reach terminal state or observation period to expire.
 *
 * afterSeq semantics (M10-pre3 closeout, P1-B):
 *   - OMITTED (`afterSeq` key not present on input): the baseline is the max seq
 *     observed at the FIRST transcript read. Only events that arrive DURING the
 *     wait window count as progress. This prevents historical events from being
 *     misreported as progress on a caller's first poll.
 *   - EXPLICIT integer ≥ 0: the caller intentionally opts into counting every
 *     event with seq > afterSeq (including history). This is the incremental
 *     cursor a caller passes after a previous run_wait returned `cursor`.
 *
 * The service is the shared business boundary: it validates afterSeq itself
 * (non-negative integer) and does NOT rely on the MCP zod schema. A direct
 * service caller that passes -1 or 1.5 must be rejected.
 *
 * @param {object} input
 * @param {string} input.runId — must pass isValidRunId
 * @param {string} input.runDir
 * @param {number} [input.afterSeq] — cursor; omitted = baseline-at-first-read
 * @param {number} [input.waitMs=180000] — observation period (>= 180000)
 * @param {string} [input.authorizedWorkspaceRoot] — MCP workspace binding
 * @param {Function} [input.sleepFn] — injectable sleep (testing)
 * @param {Function} [input.nowFn] — injectable clock (testing)
 * @param {Function} [input.readTranscriptFn] — injectable transcript reader (testing)
 * @param {number} [input.pollIntervalMs=2000] — internal poll interval
 * @returns {Promise<object>} liveness summary
 */
export async function runWait(input) {
  const {
    runId,
    runDir,
    waitMs = 180000,
    authorizedWorkspaceRoot,
  } = input;

  // Distinguish omitted afterSeq from explicit 0.
  // Hasown on the input object — explicit undefined is treated as omitted too,
  // since the only honest way to say "count all history" is the literal 0.
  const afterSeqOmitted = !Object.prototype.hasOwnProperty.call(input, "afterSeq")
    || input.afterSeq === undefined;

  // Validate afterSeq independently (P2-A): the service is a shared business
  // boundary, not every caller goes through MCP zod.
  if (!afterSeqOmitted) {
    const as = input.afterSeq;
    if (!Number.isInteger(as) || as < 0) {
      throw new Error(`invalid afterSeq: must be a non-negative integer, got: ${JSON.stringify(as)}`);
    }
  }

  // Validate runId before any file access
  if (!isValidRunId(runId)) {
    throw new Error(`invalid runId: ${JSON.stringify(runId)}`);
  }

  // Validate waitMs — the service is the shared business boundary and must
  // enforce the same 180000..600000 range as the MCP adapter, independent of
  // zod. A direct service caller that passes 179999 or 600001 must be rejected.
  const RUN_WAIT_MIN_MS = 180000;
  const RUN_WAIT_MAX_MS = 600000;
  if (!Number.isInteger(waitMs) || waitMs < RUN_WAIT_MIN_MS || waitMs > RUN_WAIT_MAX_MS) {
    throw new Error(`waitMs must be an integer in [${RUN_WAIT_MIN_MS}, ${RUN_WAIT_MAX_MS}], got: ${JSON.stringify(waitMs)}`);
  }

  const _sleep = input.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const _now = input.nowFn ?? (() => Date.now());
  const _readTranscript = input.readTranscriptFn ?? readTranscript;
  const pollIntervalMs = input.pollIntervalMs ?? 2000;

  const resolvedRunDir = resolve(runDir);
  const transcriptPath = join(resolvedRunDir, `${runId}.jsonl`);

  // Read transcript
  let events;
  try {
    events = await _readTranscript(transcriptPath);
  } catch (err) {
    throw new Error(`cannot read transcript: ${err.message}`);
  }

  // Workspace authorization (MCP path)
  if (authorizedWorkspaceRoot !== undefined) {
    verifyRunWorkspaceOwnership(events, authorizedWorkspaceRoot);
  }

  const state = findState(events);
  const terminal = TERMINAL_STATES.includes(state);
  const cursor = findLastEventSeq(events) ?? 0;

  // M11-8B closeout: canonical agentId from the transcript envelope, bound to
  // the requested runId. Missing/conflicting/invalid/cross-run → "unknown".
  const agentId = extractCanonicalAgentId(events, runId);

  // Resolve the activity baseline:
  //   omitted → cursor at first read (only window-new events count)
  //   explicit → the caller's cursor
  const activityBaseline = afterSeqOmitted ? cursor : input.afterSeq;

  // If already terminal, return immediately
  if (terminal) {
    return {
      runId,
      agentId,
      state,
      terminal: true,
      cursor,
      returnedEarly: true,
      liveness: "terminal",
      activityEventCount: 0,
      lastActivityKind: null,
      ownerHeartbeat: "n/a",
    };
  }

  // Wait loop: poll until terminal or waitMs expires
  // Capture the start time ONCE so the deadline and the keepalive fraction
  // share a single baseline. Reading _now() separately for deadline and start
  // would advance a fake clock twice and skew test determinism.
  const startNow = _now();
  const deadline = startNow + waitMs;
  let currentState = state;
  let currentEvents = events;
  let currentCursor = cursor;

  // M10-pre3 closeout (P1-A): an optional keepalive hook the caller can supply
  // (the MCP adapter wires it to notifications/progress keyed to the client's
  // progressToken). The service invokes it after every successful re-read while
  // still non-terminal, so a long poll keeps the MCP request alive without the
  // service itself knowing anything about MCP. onPoll receives the elapsed
  // fraction of waitMs so the caller can report monotonically increasing
  // progress. This stays read-only: onPoll is a notification, not a write.
  const onPoll = typeof input.onPoll === "function" ? input.onPoll : null;
  let pollIndex = 0;

  while (_now() < deadline) {
    // Sleep for poll interval (or remaining time, whichever is shorter)
    const remaining = deadline - _now();
    if (remaining <= 0) break;
    await _sleep(Math.min(pollIntervalMs, remaining));

    // Re-read transcript
    try {
      currentEvents = await _readTranscript(transcriptPath);
    } catch {
      break; // Can't re-read — return what we have
    }

    currentState = findState(currentEvents);
    currentCursor = findLastEventSeq(currentEvents) ?? currentCursor;

    if (TERMINAL_STATES.includes(currentState)) {
      // Terminal reached — early return
      return {
        runId,
        agentId,
        state: currentState,
        terminal: true,
        cursor: currentCursor,
        returnedEarly: true,
        liveness: "terminal",
        activityEventCount: 0,
        lastActivityKind: null,
        ownerHeartbeat: "n/a",
      };
    }

    // Keepalive: notify the caller that the poll is still alive. The fraction
    // is clamped to [0,1); the MCP adapter turns this into notifications/progress.
    if (onPoll) {
      pollIndex++;
      const elapsed = _now() - startNow;
      const fraction = waitMs > 0 ? Math.min(Math.max(elapsed / waitMs, 0), 0.999) : 0;
      try { await onPoll({ index: pollIndex, fraction }); } catch { /* keepalive failure must not break the wait */ }
    }
  }

  // waitMs expired — compute liveness summary against the resolved baseline
  const progress = countProgressAfterSeq(currentEvents, activityBaseline);
  const ownerLiveness = checkOwnerLiveness(resolvedRunDir, runId, _now());

  let liveness;
  if (progress.count > 0) {
    liveness = "progress";
  } else if (ownerLiveness.fresh) {
    liveness = "process_only";
  } else {
    liveness = "silent";
  }

  return {
    runId,
    agentId,
    state: currentState,
    terminal: false,
    cursor: currentCursor,
    returnedEarly: false,
    liveness,
    activityEventCount: progress.count,
    lastActivityKind: progress.lastKind,
    ownerHeartbeat: ownerLiveness.fresh ? "fresh" : "stale",
  };
}
