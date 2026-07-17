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

import { readTranscript, findState, TERMINAL_STATES, findLastEventSeq } from "../transcript.js";
import { isValidRunId } from "../delivery.js";
import { verifyRunWorkspaceOwnership } from "./runWorkspaceOwnership.js";
import { checkOwnerLiveness } from "./ownerLiveness.js";

// ── Progress event types (closed set) ────────────────────────────────────────

const PROGRESS_EVENT_TYPES = new Set([
  "run.event",       // durable RunEvent (message/thinking/command/tool_use/tool_result/file_written/metrics)
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
 */
const ACTIVITY_KIND_MAP = {
  message: "message",
  thinking: "thinking",
  command: "command",
  tool_use: "tool_use",
  tool_result: "tool_result",
  file_written: "file_written",
  metrics: "metrics",
};

/**
 * Determine the safe activity kind label from an event.
 * Returns null if the event has no usable activity kind.
 */
function activityKind(event) {
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
 * @param {object} input
 * @param {string} input.runId — must pass isValidRunId
 * @param {string} input.runDir
 * @param {number} [input.afterSeq=0] — cursor for incremental activity
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
    afterSeq = 0,
    waitMs = 180000,
    authorizedWorkspaceRoot,
  } = input;

  // Validate runId before any file access
  if (!isValidRunId(runId)) {
    throw new Error(`invalid runId: ${JSON.stringify(runId)}`);
  }

  // Validate waitMs
  if (!Number.isInteger(waitMs) || waitMs < 180000) {
    throw new Error(`waitMs must be an integer >= 180000, got: ${waitMs}`);
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

  // If already terminal, return immediately
  if (terminal) {
    return {
      runId,
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
  const deadline = _now() + waitMs;
  let currentState = state;
  let currentEvents = events;
  let currentCursor = cursor;

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
  }

  // waitMs expired — compute liveness summary
  const progress = countProgressAfterSeq(currentEvents, afterSeq);
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
