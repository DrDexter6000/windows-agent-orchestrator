// src/application/runObservationProjection.js
//
// M12-11: the SINGLE pure, backend-neutral observation/termination projector.
//
// A Lead must never guess whether:
//   - a wait window ended (window_expired vs terminal vs read_failure),
//   - WAO actually terminated the worker on an execution deadline (timed_out),
//   - the provider/backend failed (and which side).
//
// This module turns ONE trusted transcript snapshot + the observation mode
// (read-failure / terminal / point-in-time / window-expired) into two additive,
// closed-set, Host-neutral facts consumed by BOTH read-only observation tools
// (run_wait + run_await_result):
//
//   observation : { outcome ∈ OBSERVATION_OUTCOMES, waitedMs, windowMs }
//   termination : null | { state ∈ TERMINATION_STATES,
//                          source ∈ TERMINATION_SOURCES,
//                          configuredMs : number|null,
//                          policySource ∈ WAIT_POLICY_SOURCES }
//
// Architectural contract ( enforced by test X5 ):
//   - PURE. No MCP SDK, no zod, no src/commands/*, no src/mcp/*, no backend
//     name, no process spawn, no filesystem, no network. The only imports are
//     the TERMINAL_STATES constant and the PURE diagnoseFailure projector.
//   - Fail-closed. Any unexpected input collapses to a safe closed-set fact
//     (source "unknown", configuredMs null, policySource "unknown") — it NEVER
//     throws and NEVER echoes a raw error/reason/path/command/credential.
//   - runId-bound. Every durable fact (run.timed_out / run.completed /
//     run.aborted / run.wait_policy / diagnosis signals) is consumed ONLY from
//     events whose runId matches the requested run, so a concatenated/corrupt
//     transcript can never attribute another run's terminal cause (cross-run
//     defense, tests P23/P24). The transcript appender stamps runId on every
//     event (src/transcript.js append), so binding is total on a clean file.
//   - Advisory only. The projector describes what was observed; it never
//     decides, recommends, or mutates state.
//
// READ_FAILURE_REASONS lives HERE (not in runAwaitResult) as the SSOT. It was
// previously defined in runAwaitResult.js, but runWait now needs the same
// closed set and cannot import it from runAwaitResult — runAwaitResult already
// imports summarizeLiveness FROM runWait, so importing the other way would
// create a cycle. runAwaitResult re-exports READ_FAILURE_REASONS from here for
// back-compat (its existing consumers and the MCP schema import unchanged).

import { TERMINAL_STATES } from "../transcript.js";
import { diagnoseFailure } from "../diagnosis.js";

/**
 * Frozen closed set of observation outcomes. A wait response is EXACTLY one of:
 *   - point_in_time : waitMs 0, read once, non-terminal (a snapshot, not a wait)
 *   - window_expired: a positive wait elapsed without observing a terminal
 *   - terminal      : a terminal state was observed within the window
 *   - read_failure  : the snapshot could not be read/trusted (fail-closed)
 * An expired observation window is read-only — it NEVER implies the worker
 * stopped (termination stays null on window_expired / point_in_time /
 * read_failure).
 */
export const OBSERVATION_OUTCOMES = Object.freeze([
  "point_in_time",
  "window_expired",
  "terminal",
  "read_failure",
]);

/**
 * Frozen closed set of terminal run states (mirrors transcript TERMINAL_STATES
 * for the wire schema — single source of truth for the enum).
 */
export const TERMINATION_STATES = Object.freeze([
  "completed",
  "failed",
  "aborted",
  "timed_out",
]);

/**
 * Frozen closed set of termination SOURCES — WHO/WHAT caused the terminal.
 *   - completion        : the backend emitted done(completed) (bound run.completed)
 *   - execution_deadline: WAO's wall-clock deadline timer fired (bound run.timed_out)
 *   - manual            : an owner/operator explicitly stopped it (bound run.aborted/stop_requested)
 *   - provider          : provider-side access denial / stream disconnect
 *   - backend           : backend crash / stream ended / evidence-passed-but-backend-failed
 *   - control_plane     : WAO gate (budget / scorecard / workdir isolation / delivery / config)
 *   - unknown           : no trustworthy bound signal (fail-closed — never guess)
 *
 * Truth rule: "execution_deadline" is asserted ONLY when a bound run.timed_out
 * durable fact exists — i.e. WAO's deadline timer actually fired. A terminal
 * timed_out state WITHOUT that fact is "unknown" (legacy/external), so a Lead
 * can never infer WAO stopped the worker when it did not.
 */
export const TERMINATION_SOURCES = Object.freeze([
  "completion",
  "execution_deadline",
  "manual",
  "provider",
  "backend",
  "control_plane",
  "unknown",
]);

/**
 * Frozen closed set of wait-policy sources (mirrors timeoutPolicy.resolveWaitTimeout
 * sources, plus "unknown" for missing/malformed/conflicting policy facts).
 */
export const WAIT_POLICY_SOURCES = Object.freeze([
  "explicit",
  "agent",
  "global",
  "disabled",
  "unknown",
]);

/**
 * Frozen closed set of safe read-failure machine codes (SSOT). `observed`
 * outcomes carry readFailureReason=null; a read_failure carries exactly ONE of
 * these — never an error message/path/command/credential. The MCP schema enum
 * for BOTH run_wait and run_await_result is built from this single set.
 */
export const READ_FAILURE_REASONS = Object.freeze([
  "transcript_parse_failed", // transcript read or JSON parse exception
  "legacy_event_shape", // structurally incompatible legacy event/snapshot shape
  "snapshot_unavailable", // any other safe non-parse failure to obtain a usable snapshot
]);

// Map a failed terminal's state_change reason to a source. Used ONLY as a
// fallback when diagnoseFailure returns no rich signal (unknown/none). These
// are the closed-set transition reasons runManager writes on the failed path.
const FAILED_REASON_TO_SOURCE = {
  backend_error: "backend",
  backend_stream_ended: "backend",
  backend_unknown_reason: "unknown",
  budget_exceeded: "control_plane",
  scorecard_failed: "control_plane",
  workdir_escape: "control_plane",
  delivery_failed: "control_plane",
};

// Keep only events bound to the requested run (cross-run defense). The
// transcript appender stamps runId on every event, so a clean per-run file
// passes through unchanged; a concatenated/corrupt file can never attribute
// another run's facts.
function boundEvents(events, runId) {
  if (!Array.isArray(events)) return [];
  if (typeof runId !== "string" || runId.length === 0) return [];
  const out = [];
  for (const event of events) {
    if (event !== null && typeof event === "object" && !Array.isArray(event)
      && event.runId === runId) {
      out.push(event);
    }
  }
  return out;
}

// Extract the SINGLE bound run.wait_policy durable fact.
//   - absent       → { configuredMs: null, policySource: "unknown" }
//                    (absence is NOT "disabled" — we do not infer a policy)
//   - multiple     → { null, "unknown" } (conflict — fail closed)
//   - malformed    → { null, "unknown" } (bad ms/source shape — fail closed)
//   - valid        → { ms (number|null), source }
// A valid DISABLED policy honestly carries configuredMs:null, policySource:"disabled".
function extractWaitPolicy(events, runId) {
  const policies = events.filter((e) => e && e.type === "run.wait_policy");
  if (policies.length === 0) return { configuredMs: null, policySource: "unknown" };
  if (policies.length > 1) return { configuredMs: null, policySource: "unknown" };
  const p = policies[0];
  const ms = p ? p.waitTimeoutMs : undefined;
  const src = p ? p.source : undefined;
  // ms is valid if it is null (disabled) or a positive integer.
  const msValid = ms === null || (Number.isInteger(ms) && ms > 0);
  const srcValid = typeof src === "string" && WAIT_POLICY_SOURCES.includes(src)
    && src !== "unknown";
  if (!msValid || !srcValid) return { configuredMs: null, policySource: "unknown" };
  return { configuredMs: ms, policySource: src };
}

// Derive the source for a FAILED terminal.
//
// TRUTH RULE (M12-11 correction): execution_deadline is asserted ONLY when a
// bound run.timed_out durable fact exists — i.e. WAO's wall-clock deadline timer
// actually fired. This is checked EXPLICITLY here, BEFORE consulting
// diagnoseFailure, and is the sole basis for a deadline claim on a failed
// terminal. diagnoseFailure's "timeout" category is deliberately NOT trusted for
// this: today it happens to be backed by a run.timed_out event (diagnosis.js),
// but that is an internal detail that could broaden (error text, provider
// stall). Inferring a WAO execution deadline from diagnosis/error text alone is
// forbidden — a failed terminal without a bound run.timed_out always falls
// through to a trustworthy non-deadline source or "unknown".
//
// `diagnose` is an optional test seam (defaults to the real diagnoseFailure);
// production never passes it, so behavior is unchanged.
function deriveFailedSource(events, runId, diagnose) {
  // Explicit truth-rule gate: a deadline claim requires the durable fact.
  if (events.some((e) => e && e.type === "run.timed_out")) {
    return "execution_deadline";
  }
  const diagnoseFn = typeof diagnose === "function" ? diagnose : diagnoseFailure;
  let diag;
  try {
    diag = diagnoseFn(events, runId) || {};
  } catch {
    diag = {};
  }
  switch (diag.category) {
    case "provider_auth":
    case "provider_capacity":
    case "provider_disconnect":
      return "provider";
    case "crash":
    case "evidence_passed_backend_failed":
      return "backend";
    case "budget":
    case "scorecard_fail":
    case "workdir_escape":
    case "delivery_packaging_failed":
    case "config_conflict":
      return "control_plane";
    case "aborted_manual":
      return "manual";
    // "timeout" is intentionally NOT mapped to execution_deadline. It is backed
    // by a run.timed_out event, which the explicit gate above already handled;
    // reaching this case means the bound run.timed_out was stripped (cross-run)
    // or diagnosis broadened — either way, never infer a deadline here. Fall
    // through to the terminal-reason fallback.
    case "no_effect":
    case "none":
    case "unknown":
    case "timeout":
    default:
      // no_effect describes worker OUTPUT (active but no evidence), not WHO
      // failed — it must NOT short-circuit the source. Fall through to the
      // terminal state_change reason, which is the authoritative source signal
      // runManager writes on the failed path (backend_error / backend_stream_ended
      // / backend_unknown_reason / budget_exceeded / scorecard_failed / ...).
      break;
  }
  // Fallback: the terminal state_change reason's explicit closed-set label.
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e && e.type === "run.state_change" && e.to === "failed"
      && typeof e.reason === "string" && FAILED_REASON_TO_SOURCE[e.reason]) {
      return FAILED_REASON_TO_SOURCE[e.reason];
    }
  }
  return "unknown";
}

// Derive the full termination fact for an observed terminal state. `events`
// MUST already be bound to runId by the caller. `diagnose` is an optional test
// seam forwarded to deriveFailedSource (defaults to the real diagnoseFailure).
function deriveTermination(events, runId, currentState, diagnose) {
  const hasType = (type) => events.some((e) => e && e.type === type);
  let source;
  switch (currentState) {
    case "completed":
      // Only a bound run.completed justifies "completion" — a bare completed
      // state_change (legacy) is "unknown".
      source = hasType("run.completed") ? "completion" : "unknown";
      break;
    case "aborted":
      source = (hasType("run.aborted") || hasType("run.stop_requested")) ? "manual" : "unknown";
      break;
    case "timed_out":
      // The truth rule: execution_deadline ONLY when WAO's deadline timer
      // actually fired, evidenced by a bound run.timed_out durable fact.
      source = hasType("run.timed_out") ? "execution_deadline" : "unknown";
      break;
    case "failed":
      source = deriveFailedSource(events, runId, diagnose);
      break;
    default:
      source = "unknown";
  }
  const wp = extractWaitPolicy(events, runId);
  return {
    state: currentState,
    source,
    configuredMs: wp.configuredMs,
    policySource: wp.policySource,
  };
}

function deriveOutcome(readFailure, terminal, windowMs) {
  if (readFailure) return "read_failure";
  if (terminal) return "terminal";
  // Non-terminal, clean read: a zero-width window is a point-in-time snapshot;
  // a positive window that elapsed without terminal is a window expiry.
  if (windowMs === 0) return "point_in_time";
  return "window_expired";
}

function safeNonNegativeInt(v) {
  return Number.isInteger(v) && v >= 0 ? v : 0;
}

/**
 * Project the observation + termination facts from ONE trusted snapshot.
 *
 * @param {object} input
 * @param {object[]} [input.events]    — transcript event snapshot (terminal derivation only)
 * @param {string}  [input.runId]      — the requested run (cross-run binding)
 * @param {string}  [input.currentState] — observed state (terminal derivation only)
 * @param {boolean} [input.terminal]   — whether a terminal state was observed
 * @param {boolean} [input.readFailure] — whether the snapshot could not be read/trusted
 * @param {number}  [input.waitedMs]   — ms actually spent waiting (>= 0)
 * @param {number}  [input.windowMs]   — the requested observation window (>= 0)
 * @param {Function}[input.diagnose]   — optional test seam overriding
 *   diagnoseFailure for the failed-path source derivation (defaults to the real
 *   diagnoseFailure; production never passes it).
 * @returns {{observation: {outcome: string, waitedMs: number, windowMs: number},
 *            termination: null|object}}
 *   termination is null unless a terminal state was cleanly observed. An
 *   observation expiry / transport loss / read failure NEVER produces a
 *   termination fact — it cannot be collapsed into a worker-stop claim.
 */
export function projectObservation(input = {}) {
  const {
    events, runId, currentState, terminal = false, readFailure = false,
    waitedMs, windowMs, diagnose,
  } = input;

  const outcome = deriveOutcome(readFailure, terminal, windowMs);
  const observation = {
    outcome,
    waitedMs: safeNonNegativeInt(waitedMs),
    windowMs: safeNonNegativeInt(windowMs),
  };

  // termination is asserted ONLY on a clean terminal observation. A read
  // failure is fail-closed: even if a terminal state was derived from a prior
  // trusted snapshot, the un-trusted current read must not produce a
  // termination claim.
  let termination = null;
  if (terminal && !readFailure && TERMINAL_STATES.includes(currentState)) {
    const bound = boundEvents(events, runId);
    try {
      termination = deriveTermination(bound, runId, currentState, diagnose);
    } catch {
      termination = null;
    }
  }
  return { observation, termination };
}
