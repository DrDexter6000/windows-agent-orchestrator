// src/application/runDelivery.js
//
// M9-6A: Shared application services for delivery query and Lead decision.
//
// getRunDelivery: read-only reconstruction of the current delivery state.
// decideRunDelivery: durable Lead decision via tryAppendDecision (first-decision-wins).
//
// Architectural contract:
//   - No argv parsing, no console.log, no process.exit.
//   - Does not import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Depends on transcript.js (readTranscript/findState/JsonlTranscript/findLastEventSeq)
//     and delivery.js (isValidRunId).
//   - The _reconstructDelivery algorithm is migrated here from src/commands/runs.js
//     so CLI and MCP share one reconstruction path.

import { join, resolve } from "node:path";

import { readTranscript, findState, findLastEventSeq, validateDeliveryFacts, JsonlTranscript } from "../transcript.js";
import { isValidRunId } from "../delivery.js";
import { PACKAGING_FAILURE_CODES, safeProjectPackagingCode } from "../deliveryFailureCodes.js";
import { verifyRunWorkspaceOwnership } from "./runWorkspaceOwnership.js";

// M11-8C: packaging failure codes come from the shared safe-projection
// allowlist (deliveryFailureCodes.js). The application projection and the MCP
// schema both consume PACKAGING_FAILURE_CODES — there is no second projection
// list (the producer delivery.js is a separate concern; see that module).

// ===== M11-10: Delivery readiness handshake =====
//
// Extends run_delivery with an OPTIONAL bounded, read-only wait. When waitMs is
// omitted, run_delivery keeps its exact point-in-time output. When provided, the
// service projects a strict closed-set readiness value and waits (non-busy,
// workspace/runId-bound, zero transcript append) until readiness settles or the
// bounded deadline expires. A pending-at-deadline outcome is a truthful fact,
// NOT an error. The wait never stop/retry/accept/rejects — the Lead decides.

// The strict readiness closed set. Consumers (CLI/MCP/tests) must treat this as
// exhaustive; any other value is a bug.
export const DELIVERY_READINESS_STATES = Object.freeze([
  "waiting_for_packaging", // delivery requested, no durable delivery_created yet
  "waiting_for_verification", // durable delivery_created, no final verification outcome yet
  "reviewable", // durable delivery_created + exactly one bound final verification outcome
  "packaging_failed", // durable run.delivery_failed bound to this runId (no committed delivery)
  "not_requested", // no delivery intent declared, no delivery events
  "ambiguous", // conflicting durable facts — fail closed
]);

const WAITING_READINESS_STATES = new Set(["waiting_for_packaging", "waiting_for_verification"]);

const DELIVERY_VERIFICATION_OUTCOME_TYPES = new Set([
  "run.delivery_verification_passed",
  "run.delivery_verification_failed",
  "run.delivery_verification_unavailable",
]);

// Shared waitMs bounds. The MCP zod schema is built FROM these constants (see
// src/mcp/server.js) so the schema and the service business boundary cannot
// drift — there is one waitMs range, locked here.
export const DELIVERY_WAIT_MS_MIN = 1000;
export const DELIVERY_WAIT_MS_MAX = 300000;
const DELIVERY_WAIT_POLL_INTERVAL_MS = 1000;

/**
 * Project the delivery readiness of a run from its transcript events.
 *
 * Strict closed set (DELIVERY_READINESS_STATES). RunId-bound: only events whose
 * envelope runId equals the requested runId count, so a cross-run event in a
 * concatenated/corrupt transcript cannot masquerade as this run's delivery.
 *
 * `reviewable` reuses validateDeliveryFacts (the SAME durable-facts SSOT that
 * tryAppendDecision and run_delivery_review use) as the final authority: it is
 * returned ONLY when validateDeliveryFacts agrees the delivery is unambiguous
 * (exactly one created + one matching final verification outcome) AND the full
 * durable identity chain (event envelopes + DeliveryRefs) binds to the runId.
 * failed/unavailable outcomes are reviewable; the Lead still owns acceptance.
 *
 * Conflicting durable facts (multiple created/verification, commit mismatch,
 * cross-run ref, created+failed) collapse to `ambiguous` — never echo dynamic
 * values; the caller sees only the closed-set label.
 *
 * @param {object[]} events
 * @param {string} runId
 * @returns {string} one of DELIVERY_READINESS_STATES
 */
export function projectDeliveryReadiness(events, runId) {
  if (!Array.isArray(events)) return "ambiguous";

  const created = events.filter(
    (e) => e && e.type === "run.delivery_created" && e.runId === runId && e.delivery,
  );
  const verification = events.filter(
    (e) => e && DELIVERY_VERIFICATION_OUTCOME_TYPES.has(e.type) && e.runId === runId,
  );
  const failed = events.filter(
    (e) => e && e.type === "run.delivery_failed" && e.runId === runId,
  );

  // Conflicting durable facts → ambiguous (fail closed).
  if (created.length > 1) return "ambiguous";
  if (verification.length > 1) return "ambiguous";
  // Multiple bound failures are conflicting durable facts (no single
  // authoritative failure) → ambiguous. A single bound failure falls through to
  // packaging_failed below.
  if (failed.length > 1) return "ambiguous";
  if (created.length === 1 && failed.length > 0) return "ambiguous";
  // A verification outcome bound to this runId with NO bound delivery_created
  // is an orphan durable fact (broken durable chain) → ambiguous. It must never
  // fall through to waiting_for_packaging / not_requested.
  if (verification.length > 0 && created.length === 0) return "ambiguous";

  if (created.length === 1 && verification.length === 1) {
    const createdRef = created[0].delivery;
    const verificationRef = verification[0].delivery;
    // Full durable-identity binding to the requested runId (cross-run defense)
    // and matching verification commit. Any drift → ambiguous.
    if (createdRef?.runId !== runId) return "ambiguous";
    if (verificationRef?.runId !== runId) return "ambiguous";
    if (createdRef?.deliveryCommit !== verificationRef?.deliveryCommit) return "ambiguous";
    // SSOT authority: validateDeliveryFacts must agree this is an unambiguous,
    // reviewable delivery (exactly one created + one matching final outcome).
    const facts = validateDeliveryFacts(events);
    if (!facts.valid) return "ambiguous";
    return "reviewable";
  }

  if (failed.length > 0) return "packaging_failed";
  if (created.length === 1) return "waiting_for_verification";

  // No committed delivery and no packaging failure. Distinguish "delivery was
  // requested but not yet packaged" from "delivery was never requested".
  // runId-bound: only THIS run's own run.started declares intent. A foreign
  // run's run.started in a concatenated/corrupt transcript must not project
  // this run as waiting.
  const deliveryRequested = events.some(
    (e) => e && e.type === "run.started"
      && e.runId === runId
      && e.delivery && typeof e.delivery.mode === "string" && e.delivery.mode.length > 0,
  );
  return deliveryRequested ? "waiting_for_packaging" : "not_requested";
}

/**
 * Find the latest run.delivery_failed event bound to the given runId.
 * Binding: the event's runId MUST equal the requested runId (defends against a
 * cross-run event in a concatenated/corrupt transcript). Returns null if none.
 * @param {Array} events
 * @param {string} runId
 * @returns {object|null}
 */
function _findBoundDeliveryFailed(events, runId) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.type === "run.delivery_failed" && e.runId === runId) return e;
  }
  return null;
}

// ===== Private: delivery reconstruction (migrated from runs.js) =====

/**
 * Reconstruct the latest delivery ref, decision event, and delivery commit
 * from transcript events. This is the single algorithm — CLI and MCP both
 * use it via getRunDelivery.
 * @param {Array} events
 * @returns {{latestRef: object|null, decisionEvent: object|null, deliveryCommit: string|null}}
 */
function _reconstructDelivery(events) {
  let latestRef = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === "run.delivery_created" && events[i].delivery) {
      latestRef = events[i].delivery;
      break;
    }
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if ((e.type === "run.delivery_verification_passed"
      || e.type === "run.delivery_verification_failed"
      || e.type === "run.delivery_verification_unavailable")
      && e.delivery) {
      latestRef = e.delivery;
      break;
    }
  }
  let decisionEvent = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.type === "run.delivery_accepted" || e.type === "run.delivery_rejected") {
      decisionEvent = e;
      break;
    }
  }
  if (decisionEvent?.delivery) {
    latestRef = decisionEvent.delivery;
  }
  const deliveryCommit = latestRef?.deliveryCommit ?? null;
  return { latestRef, decisionEvent, deliveryCommit };
}

// ===== Private: shared delivery-view gatherer =====
//
// M11-10: the single fact-gathering path used by BOTH getRunDelivery
// (point-in-time) and getRunDeliveryReadiness (bounded wait). Reuses
// _reconstructDelivery + _findBoundDeliveryFailed + safeProjectPackagingCode —
// there is no second reconstruction algorithm.
//
// Returns one of:
//   - success: { runId, terminalState, deliveryAvailable: true, deliveryRef, verification, acceptance }
//   - failure: { runId, terminalState, deliveryAvailable: false, deliveryFailure: { code } }
//   - noDelivery marker: { runId, terminalState, deliveryAvailable: false, noDelivery: true }
//     (no committed delivery AND no bound packaging failure)
function _gatherDeliveryView(events, runId, terminalState) {
  const { latestRef, decisionEvent, deliveryCommit } = _reconstructDelivery(events);

  if (latestRef && deliveryCommit) {
    const verificationStatus = latestRef.verification?.status ?? "pending";
    const acceptanceStatus = decisionEvent
      ? (decisionEvent.type === "run.delivery_accepted" ? "accepted" : "rejected")
      : (latestRef.acceptance?.status ?? "pending");
    return {
      runId,
      terminalState,
      deliveryAvailable: true,
      deliveryRef: latestRef,
      verification: {
        status: verificationStatus,
        ...(latestRef.verification?.failureCode ? { failureCode: latestRef.verification.failureCode } : {}),
      },
      acceptance: {
        status: acceptanceStatus,
        ...(decisionEvent ? { decisionEvent: { type: decisionEvent.type, reason: decisionEvent.reason } } : {}),
      },
    };
  }

  // M11-8C Package B: no committed DeliveryRef, but a durable run.delivery_failed
  // bound to this runId → SAFE STRUCTURED FAILURE variant. The failure code is
  // projected through a closed set; unknown/malformed/injected values map to
  // "unknown" and are never echoed.
  const failedEvent = _findBoundDeliveryFailed(events, runId);
  if (failedEvent) {
    const code = safeProjectPackagingCode(failedEvent.deliveryCode);
    return {
      runId,
      terminalState,
      deliveryAvailable: false,
      deliveryFailure: { code },
    };
  }

  // No committed delivery and no packaging failure.
  return { runId, terminalState, deliveryAvailable: false, noDelivery: true };
}

// ===== Service: getRunDelivery (read-only point-in-time query) =====

/**
 * Get the read-only delivery status for a run.
 *
 * @param {object} input
 * @param {string} input.runId — must pass isValidRunId
 * @param {string} input.runDir — runs/ directory (host-owned)
 * @param {Function} [input.readTranscriptFn] — injectable for testing
 * @returns {Promise<object>} delivery view: {runId, terminalState, deliveryRef, verification, acceptance}
 */
export async function getRunDelivery({ runId, runDir, readTranscriptFn }) {
  if (!runId || typeof runId !== "string") throw new Error("getRunDelivery: runId is required");
  if (!runDir || typeof runDir !== "string") throw new Error("getRunDelivery: runDir is required");
  if (!isValidRunId(runId)) throw new Error(`Invalid runId: ${JSON.stringify(runId)}`);

  const _readTranscript = readTranscriptFn ?? readTranscript;
  const filePath = join(runDir, `${runId}.jsonl`);
  const events = await _readTranscript(filePath);

  const terminalState = findState(events);
  const view = _gatherDeliveryView(events, runId, terminalState);
  if (view.noDelivery) throw new Error(`No committed delivery found for run ${runId}`);
  return view;
}

// ===== Service: getRunDeliveryReadiness (read-only bounded wait) =====
//
// M11-10: project the closed-set readiness and, when it is a waiting state,
// bounded-poll the transcript until it settles or waitMs expires. Strictly
// read-only: zero transcript append, zero owner file, zero state change. It
// never stop/retry/accept/rejects.
//
// Architectural contract (same as runWait / getRunDelivery):
//   - No argv parsing, no console.log, no process.exit.
//   - Does not import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Validates waitMs itself (shared business boundary) using the same
//     constants the MCP schema is built from, so a direct service caller that
//     passes an out-of-range waitMs is rejected.

/**
 * Build the readiness result object from the current view. Centralizes the
 * shape so the early-return and deadline-expired paths cannot diverge.
 * @private */
function _buildReadinessResult(runId, events, terminalState, readiness, waitReturnedEarly) {
  const view = _gatherDeliveryView(events, runId, terminalState);
  return {
    runId,
    readiness,
    waitReturnedEarly,
    terminalState,
    deliveryAvailable: view.deliveryAvailable,
    deliveryRef: view.deliveryRef ?? null,
    deliveryFailure: view.deliveryFailure ?? null,
    verification: view.verification ?? null,
    acceptance: view.acceptance ?? null,
  };
}

/**
 * Project delivery readiness and optionally wait (bounded, read-only) for it to
 * settle. Workspace/runId-bound: when `authorizedWorkspaceRoot` is supplied the
 * run must belong to that workspace (reuses verifyRunWorkspaceOwnership). The
 * wait is non-busy (it sleeps between re-reads) and writes nothing.
 *
 * @param {object} input
 * @param {string} input.runId — must pass isValidRunId
 * @param {string} input.runDir — runs/ directory (host-owned)
 * @param {number} input.waitMs — integer in [DELIVERY_WAIT_MS_MIN, DELIVERY_WAIT_MS_MAX]
 * @param {string} [input.authorizedWorkspaceRoot] — MCP workspace binding
 * @param {Function} [input.readTranscriptFn] — injectable for testing
 * @param {Function} [input.sleepFn] — injectable sleep (testing)
 * @param {Function} [input.nowFn] — injectable clock (testing)
 * @param {number} [input.pollIntervalMs] — internal poll interval (testing)
 * @param {Function} [input.onPoll] — optional keepalive hook ({index,fraction});
 *   the MCP adapter wires it to notifications/progress. Read-only: a notification, not a write.
 * @returns {Promise<object>} { runId, readiness, waitReturnedEarly, terminalState,
 *   deliveryAvailable, deliveryRef, deliveryFailure, verification, acceptance }
 */
export async function getRunDeliveryReadiness({
  runId,
  runDir,
  waitMs,
  authorizedWorkspaceRoot,
  readTranscriptFn,
  sleepFn,
  nowFn,
  pollIntervalMs,
  onPoll,
}) {
  if (!runId || typeof runId !== "string") throw new Error("getRunDeliveryReadiness: runId is required");
  if (!runDir || typeof runDir !== "string") throw new Error("getRunDeliveryReadiness: runDir is required");
  if (!isValidRunId(runId)) throw new Error(`Invalid runId: ${JSON.stringify(runId)}`);
  // Shared business boundary: validate waitMs independently of any caller schema.
  if (!Number.isInteger(waitMs) || waitMs < DELIVERY_WAIT_MS_MIN || waitMs > DELIVERY_WAIT_MS_MAX) {
    throw new Error(
      `waitMs must be an integer in [${DELIVERY_WAIT_MS_MIN}, ${DELIVERY_WAIT_MS_MAX}], got: ${JSON.stringify(waitMs)}`,
    );
  }

  const _readTranscript = readTranscriptFn ?? readTranscript;
  const _sleep = sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const _now = nowFn ?? (() => Date.now());
  const pollInterval = pollIntervalMs ?? DELIVERY_WAIT_POLL_INTERVAL_MS;

  const filePath = join(resolve(runDir), `${runId}.jsonl`);

  let events = await _readTranscript(filePath);
  if (authorizedWorkspaceRoot !== undefined) {
    verifyRunWorkspaceOwnership(events, authorizedWorkspaceRoot);
  }
  let terminalState = findState(events);
  let readiness = projectDeliveryReadiness(events, runId);

  // Non-waiting readiness settles immediately: reviewable, packaging_failed,
  // not_requested, and ambiguous are durable facts — waiting cannot change them.
  if (!WAITING_READINESS_STATES.has(readiness)) {
    return _buildReadinessResult(runId, events, terminalState, readiness, true);
  }

  // Bounded wait loop (non-busy: sleep between re-reads). Capture the start
  // time ONCE so the deadline and the keepalive fraction share one baseline.
  const startNow = _now();
  const deadline = startNow + waitMs;
  let pollIndex = 0;
  // Set when a re-read fails after the initial read succeeded. The post-loop
  // path uses this to fail closed to `ambiguous` instead of returning the stale
  // waiting snapshot as an ordinary deadline expiry.
  let readFailed = false;

  while (_now() < deadline) {
    const remaining = deadline - _now();
    if (remaining <= 0) break;
    // Non-busy: sleep for the poll interval (or the remaining time, whichever
    // is shorter) before re-reading. This yields the event loop between polls.
    await _sleep(Math.min(pollInterval, remaining));

    try {
      events = await _readTranscript(filePath);
    } catch {
      // Initial read succeeded but a later re-read failed. Do NOT disguise the
      // stale waiting snapshot as an ordinary deadline expiry (that would
      // return readiness:<last waiting>, waitReturnedEarly:false). Fail closed
      // to the EXISTING ambiguous closed-set value and return early below. No
      // new state, no error echo, no auto stop/retry/decision — the Lead decides.
      readFailed = true;
      break;
    }
    terminalState = findState(events);
    readiness = projectDeliveryReadiness(events, runId);
    if (!WAITING_READINESS_STATES.has(readiness)) {
      return _buildReadinessResult(runId, events, terminalState, readiness, true);
    }

    // Keepalive: notify the caller that the poll is still alive. The fraction
    // is clamped to [0,1); the MCP adapter turns this into notifications/progress.
    if (typeof onPoll === "function") {
      pollIndex += 1;
      const elapsed = _now() - startNow;
      const fraction = waitMs > 0 ? Math.min(Math.max(elapsed / waitMs, 0), 0.999) : 0;
      try { await onPoll({ index: pollIndex, fraction }); } catch { /* keepalive failure must not break the wait */ }
    }
  }

  // A re-read failed after the initial read succeeded. The `events` snapshot is
  // now stale and cannot be trusted as a settled waiting fact. Fail closed to
  // the EXISTING closed-set `ambiguous` value and return early (before the
  // deadline-expiry path). This is not a new state, not an echoed error, and it
  // never stop/retry/accept/rejects.
  if (readFailed) {
    return _buildReadinessResult(runId, events, terminalState, "ambiguous", true);
  }

  // Deadline expired while still pending. Return the truthful fact — this is
  // NOT an error: pending is a valid, honest readiness outcome. The caller
  // (Lead) decides what to do; the service never auto-stop/retry/accept/reject.
  return _buildReadinessResult(runId, events, terminalState, readiness, false);
}

// ===== Service: decideRunDelivery (durable decision) =====

/**
 * Record a Lead decision via the transcript primitive's atomic first-decision-wins.
 *
 * Does NOT reimplement terminal/verification/duplicate/commit-match rules —
 * those live inside tryAppendDecision's lock-scoped validation.
 *
 * @param {object} input
 * @param {string} input.runId
 * @param {string} input.runDir
 * @param {string} input.decision — "accepted" | "rejected"
 * @param {string} input.reason — trimmed non-empty
 * @param {Function} [input.readTranscriptFn] — for lock-external context init only
 * @param {Function} [input.transcriptFactory] — injectable for testing (async (filePath, context) => transcript)
 * @returns {Promise<{accepted:true, event} | {accepted:false, existing}>}
 */
export async function decideRunDelivery({ runId, runDir, decision, reason, readTranscriptFn, transcriptFactory }) {
  if (!runId || typeof runId !== "string") throw new Error("decideRunDelivery: runId is required");
  if (!runDir || typeof runDir !== "string") throw new Error("decideRunDelivery: runDir is required");
  if (!isValidRunId(runId)) throw new Error(`Invalid runId: ${JSON.stringify(runId)}`);
  if (decision !== "accepted" && decision !== "rejected") {
    throw new Error(`decision must be "accepted" or "rejected", got: ${JSON.stringify(decision)}`);
  }
  const trimmedReason = typeof reason === "string" ? reason.trim() : "";
  if (trimmedReason.length === 0) throw new Error("reason must be non-empty after trimming");

  const filePath = join(runDir, `${runId}.jsonl`);
  const _readTranscript = readTranscriptFn ?? readTranscript;

  // Lock-external read: initialize transcript context/seq only.
  // Authorization happens IN-LOCK inside tryAppendDecision.
  const events = await _readTranscript(filePath);
  const context = {
    runId,
    agentId: events[0]?.agentId ?? "unknown",
    initialSeq: findLastEventSeq(events),
  };

  let transcript;
  if (transcriptFactory) {
    transcript = await transcriptFactory(filePath, context);
  } else {
    transcript = new JsonlTranscript(filePath, context);
  }

  return transcript.tryAppendDecision({ decision, reason: trimmedReason });
}
