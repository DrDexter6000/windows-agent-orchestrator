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
// M12-11: the pure backend-neutral observation/termination projector (SSOT).
// Re-export READ_FAILURE_REASONS from the projector so the MCP schema for BOTH
// run_wait and run_await_result is built from one closed set, with no import
// cycle (runAwaitResult already imports summarizeLiveness from here).
import { projectObservation, READ_FAILURE_REASONS } from "./runObservationProjection.js";

export const RUN_WAIT_MIN_MS = 180000;
export const RUN_WAIT_DEFAULT_MS = 270000;
export const RUN_WAIT_MAX_MS = 600000;

// M12-11: re-export so src/mcp/server.js imports the closed set from ONE place.
export { READ_FAILURE_REASONS };

// M12-11: build the fail-closed read_failure result for run_wait. A snapshot
// that cannot be read/trusted MUST NOT be combined with a fresh owner heartbeat
// into an apparently-current observation (red flag A): liveness/heartbeat go
// "unknown", the activity tally goes null, and termination stays null — the
// observation is stale, not current. This mirrors run_await_result's
// readFailureResult exactly. `reason` is a member of READ_FAILURE_REASONS; no
// raw error/message/path/command/credential is ever placed in the result.
function waitReadFailureResult({ runId, agentId, state, cursor, waitedMs, windowMs, reason }) {
  const { observation, termination } = projectObservation({
    events: [], runId, currentState: state, terminal: false, readFailure: true,
    waitedMs, windowMs,
  });
  return {
    runId,
    agentId,
    state,
    terminal: false,
    cursor,
    returnedEarly: false,
    observationOutcome: "read_failure",
    readFailureReason: reason,
    liveness: "unknown",
    activityEventCount: null,
    lastActivityKind: null,
    ownerHeartbeat: "unknown",
    observation,
    termination,
  };
}

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
  runtime_activity: "runtime_status",
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

// M12-3: shared non-terminal liveness summary. Extracted verbatim from the
// runWait expiry path so the read-only runAwaitResult composite reuses the
// EXACT same liveness algorithm (zero drift) rather than a second copy. This is
// the SSOT for "given a clean final transcript read, is the run progressing,
// process-only, or silent?". A read FAILURE must NOT route through here — the
// composite reports observationOutcome="read_failure" with liveness="unknown"
// instead, so stale events are never combined with a fresh owner heartbeat into
// an apparently-current observation.
//
// @param {object} opts
// @param {Array<object>} opts.events — the final transcript event snapshot (CLEAN read)
// @param {string} opts.runDir — resolved runs/ directory (for the owner heartbeat file)
// @param {string} opts.runId
// @param {number} opts.activityBaseline — seq; only events with seq > baseline count
// @param {number} opts.now — current timestamp (ms), for heartbeat freshness
// @returns {{liveness: string, activityEventCount: number, lastActivityKind: string|null, ownerHeartbeat: string}}
export function summarizeLiveness({ events, runDir, runId, activityBaseline, now }) {
  const progress = countProgressAfterSeq(events, activityBaseline);
  const ownerLiveness = checkOwnerLiveness(runDir, runId, now);
  let liveness;
  if (progress.count > 0) {
    liveness = "progress";
  } else if (ownerLiveness.fresh) {
    liveness = "process_only";
  } else {
    liveness = "silent";
  }
  return {
    liveness,
    activityEventCount: progress.count,
    lastActivityKind: progress.lastKind,
    ownerHeartbeat: ownerLiveness.fresh ? "fresh" : "stale",
  };
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
 * @param {number} [input.waitMs=270000] — observation period (>= 180000)
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
    waitMs = RUN_WAIT_DEFAULT_MS,
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
  } catch {
    // M12-11: initial read failure fails CLOSED with the same closed-set
    // semantics as run_await_result — it does NOT throw a generic error. The
    // observation is a read_failure: no state/cursor is invented, liveness and
    // owner heartbeat are "unknown", termination is null. waitedMs is 0 (no
    // waiting occurred). Any throw from the reader is a transcript read/JSON
    // parse exception → transcript_parse_failed. No raw error reaches the result.
    return waitReadFailureResult({
      runId, agentId: "unknown", state: "unknown", cursor: null,
      waitedMs: 0, windowMs: waitMs, reason: "transcript_parse_failed",
    });
  }

  // Workspace authorization (MCP path)
  if (authorizedWorkspaceRoot !== undefined) {
    verifyRunWorkspaceOwnership(events, authorizedWorkspaceRoot, runId);
  }

  // R19 (TD-128 W2 状态投影类，会审补登；L1 勘误：原注释误标 W1——按 TD-128
  // 登记表真实编号，run_wait 属 runAwaitResult W2 状态投影类同族)：run_wait 的状态投影绑定到请求 runId（R15 范式
  // `findState(events.filter(bound))`——runDelivery.js / sessionReuse.js R15、
  // runAwaitResult R18 同款）：findState 的 state_change 末条胜出语义下，外 run
  // 伪 terminal 尾条不再把 run_wait 翻成终态（或反向阻断终态观察）。
  // legacy 行为选择（观测面 = 降级不设门，对齐 runAwaitResult）：全无信封的
  // pre-envelope transcript 过滤为零事件 → findState([]) = "pending"——状态不可
  // 归属时永不投影为终态，不 throw、不转 read_failure，等待窗如实耗尽后如实
  // 返回非终态。cursor/agentId 维持各自既有 SSOT（findLastEventSeq /
  // extractCanonicalAgentId，不在本轮锚点）。
  const state = findState(events.filter((e) => e && e.runId === runId));
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
    const { observation, termination } = projectObservation({
      events, runId, currentState: state, terminal: true, readFailure: false,
      waitedMs: 0, windowMs: waitMs,
    });
    return {
      runId,
      agentId,
      state,
      terminal: true,
      cursor,
      returnedEarly: true,
      observationOutcome: "observed",
      readFailureReason: null,
      liveness: "terminal",
      activityEventCount: 0,
      lastActivityKind: null,
      ownerHeartbeat: "n/a",
      observation,
      termination,
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
      // M12-11 RED FLAG A: a mid-wait re-read failure FAILS CLOSED. Previously
      // this `break`d and then combined the STALE events (from the initial
      // read) with a FRESH owner heartbeat into a clean-looking expiry — so a
      // Lead could believe the window expired normally when in fact the
      // snapshot could no longer be trusted. It now returns the same fail-closed
      // read_failure shape as run_await_result: liveness/heartbeat "unknown",
      // activity tally null, termination null, and the last trusted
      // agentId/state/cursor preserved. No stale+fresh combination is possible.
      return waitReadFailureResult({
        runId, agentId, state: currentState, cursor: currentCursor,
        waitedMs: _now() - startNow, windowMs: waitMs, reason: "transcript_parse_failed",
      });
    }

    // M12-14 poll-snapshot closeout: EVERY successful re-read re-proves
    // workspace ownership BEFORE any state/liveness/result is derived from the
    // new snapshot (same gating and same fail-closed authorization throw as the
    // initial read — it is NOT a read_failure). The initial read's authorization
    // must not carry over: a transcript replaced between polls with facts from
    // outside the authorized workspace must never drive terminal/state/liveness
    // results. The throw propagates, so the caller sees the SAME fixed error the
    // initial read would raise.
    if (authorizedWorkspaceRoot !== undefined) {
      verifyRunWorkspaceOwnership(currentEvents, authorizedWorkspaceRoot, runId);
    }

    // R19 (TD-128 W2 状态投影类；L1 勘误同上)：等待循环内每次 poll 快照的状态投影同款绑定过滤（与初始
    // 读同一 runId、同一 R15 范式）——外 run 伪 terminal 尾条不再把窗口内的 poll
    // 翻成 terminal-during-wait 提前返回（legacy 全无信封同款降级 pending）。
    currentState = findState(currentEvents.filter((e) => e && e.runId === runId));
    currentCursor = findLastEventSeq(currentEvents) ?? currentCursor;

    if (TERMINAL_STATES.includes(currentState)) {
      // Terminal reached — early return.
      const { observation, termination } = projectObservation({
        events: currentEvents, runId, currentState, terminal: true, readFailure: false,
        waitedMs: _now() - startNow, windowMs: waitMs,
      });
      return {
        runId,
        agentId,
        state: currentState,
        terminal: true,
        cursor: currentCursor,
        returnedEarly: true,
        observationOutcome: "observed",
        readFailureReason: null,
        liveness: "terminal",
        activityEventCount: 0,
        lastActivityKind: null,
        ownerHeartbeat: "n/a",
        observation,
        termination,
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

  // waitMs expired — compute liveness summary against the resolved baseline.
  // M12-3: delegate to the shared summarizeLiveness SSOT (zero drift — this is
  // the verbatim extraction of the previous inline computation).
  const liv = summarizeLiveness({
    events: currentEvents,
    runDir: resolvedRunDir,
    runId,
    activityBaseline,
    now: _now(),
  });

  // M12-11: an expired observation window is read-only and advisory — it NEVER
  // means the worker stopped. termination is null; outcome is window_expired.
  const { observation, termination } = projectObservation({
    events: currentEvents, runId, currentState, terminal: false, readFailure: false,
    waitedMs: _now() - startNow, windowMs: waitMs,
  });

  return {
    runId,
    agentId,
    state: currentState,
    terminal: false,
    cursor: currentCursor,
    returnedEarly: false,
    observationOutcome: "observed",
    readFailureReason: null,
    liveness: liv.liveness,
    activityEventCount: liv.activityEventCount,
    lastActivityKind: liv.lastActivityKind,
    ownerHeartbeat: liv.ownerHeartbeat,
    observation,
    termination,
  };
}
