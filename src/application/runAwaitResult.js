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
// READ-FAILURE REASON (M12-6 FR-08): a read_failure additionally carries a
// mandatory nullable closed-set machine code (readFailureReason) so expected,
// safely classifiable control-plane failures are machine-actionable WITHOUT
// leaking raw errors: transcript read/JSON parse exception ⇒
// "transcript_parse_failed"; structurally incompatible legacy event/snapshot
// shape ⇒ "legacy_event_shape"; any other safe non-parse failure to obtain a
// usable snapshot ⇒ "snapshot_unavailable". observed outcomes always carry
// null. The reason is a closed-set code — no error message/path/command/
// credential ever enters the result.
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
// M12-9 Package C: reuse the diagnosis + delivery SSOTs for the terminal
// outcome. diagnoseFailure / gatherDeliveryView / projectDeliveryReadiness are
// PURE events projectors — the outcome adds NO second transcript/Git read and
// NO run_collect call; it derives from the SAME in-memory snapshot.
import { diagnoseFailure, DIAGNOSIS_CATEGORIES, isValidDiagnosisCode, ISOLATION_VIOLATION_REASONS } from "../diagnosis.js";
// M12-11: the pure backend-neutral observation/termination projector (SSOT).
// projectObservation derives the additive observation {outcome, waitedMs,
// windowMs} + termination facts from the SAME in-memory snapshot, for every
// return path of this composite. READ_FAILURE_REASONS is re-exported from the
// projector so the MCP schema (run_wait + run_await_result) is built from ONE
// closed set, with no import cycle (runWait imports it from the projector too).
import { projectObservation } from "./runObservationProjection.js";
import {
  gatherDeliveryView,
  projectDeliveryReadiness,
  DELIVERY_READINESS_STATES,
  DELIVERY_VERIFICATION_STATUSES,
  DELIVERY_VERIFICATION_FAILURE_CODES,
  DELIVERY_ACCEPTANCE_STATUSES,
  DELIVERY_DECISION_TYPES,
  SAFE_ISOLATION_VIOLATION_CODES,
} from "./runDelivery.js";
import { PACKAGING_FAILURE_CODES } from "../deliveryFailureCodes.js";

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

// M12-6 FR-08 / M12-11: the frozen closed set of safe read-failure reasons.
// `observed` outcomes carry readFailureReason=null; a read_failure carries
// exactly ONE of these machine codes — never an error message/path/command/
// credential. The SSOT now lives in runObservationProjection.js (shared with
// run_wait); re-exported here so existing consumers (and the MCP schema enum)
// import from ONE place with no drift.
export { READ_FAILURE_REASONS } from "./runObservationProjection.js";

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

// M12-6: usable-event snapshot shape boundary.
//
// Historical JSONL may contain JSON-valid but NON-usable entries — null, a
// primitive (number/string/boolean), or an array — that are not transcript
// events. The shared SSOT projections that drive this composite read envelope
// fields directly:
//   - findLastEventSeq reads event.seq (null.seq → TypeError),
//   - findState reads event.type (null.type → TypeError),
//   - findRunWorkspaceOwnership filters on event.type (null.type → TypeError),
//   - summarizeLiveness/countProgressAfterSeq read event.seq/event.type.
// A null entry therefore throws a TypeError that escapes as a top-level
// "run_await_result failed"; a primitive/array entry silently derives a wrong
// state/cursor. Every snapshot that can drive a returned fact is reduced to its
// usable events FIRST, so none of those projections ever reads a field off a
// non-usable entry. A structurally corrupt snapshot is then reported as a
// read_failure (see readFailureResult) — never a clean "observed".
function usableEvents(events) {
  if (!Array.isArray(events)) return [];
  const out = [];
  for (const event of events) {
    if (event !== null && typeof event === "object" && !Array.isArray(event)) {
      out.push(event);
    }
  }
  return out;
}

// A snapshot is shape-invalid if it is not an array, or contains any non-usable
// entry (null / primitive / array). Such a snapshot is unreliable → the
// observation is a read_failure, even when the usable subset still yields a
// durable state.
function snapshotHasInvalidShape(events) {
  if (!Array.isArray(events)) return true;
  for (const event of events) {
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      return true;
    }
  }
  return false;
}

// M12-6: read_failure result builder.
//
// Trusted facts — runId, and whatever state/terminal were safely derived — are
// preserved; the fields that depend on a clean FULL snapshot (cursor, agentId,
// liveness, owner heartbeat, collect) are null/unknown/unavailable. No error
// detail (message/path/prompt/command/raw event) is ever placed in the result.
// `agentId`/`cursor` are parameters so the initial-failure (unknown/null) and
// the wait-loop re-read failure (preserve the last trusted values) share ONE
// truthful shape.
//
// M12-6 FR-08: `reason` is the mandatory closed-set machine code (a member of
// READ_FAILURE_REASONS) classifying WHY the read failed — transcript read/JSON
// parse exception, structurally incompatible legacy shape, or another safe
// non-parse failure. The caller classifies; this builder never inspects an
// error object, so no raw error detail can reach the result.
function readFailureResult({ runId, agentId, state, terminal, cursor, waitedMs, windowMs, reason }) {
  // M12-11: the additive observation/termination facts derive from the SAME
  // fail-closed inputs. A read failure is outcome=read_failure with termination
  // null — even if a terminal state was carried over from a prior trusted
  // snapshot, the un-trusted current read must never produce a termination
  // claim (it cannot be collapsed into a worker-stop claim).
  const { observation, termination } = projectObservation({
    events: [], runId, currentState: state, terminal, readFailure: true,
    waitedMs, windowMs,
  });
  return {
    runId,
    agentId,
    state,
    terminal,
    cursor,
    returnedEarly: false,
    waitedMs,
    observationOutcome: "read_failure",
    readFailureReason: reason,
    liveness: "unknown",
    activityEventCount: null,
    lastActivityKind: null,
    ownerHeartbeat: "unknown",
    result: unobservedResult("unavailable"),
    // M12-9 Package C: outcome is unavailable on a read failure — the snapshot
    // was not cleanly observed, so no terminal outcome is projected.
    outcome: null,
    // M12-14: no isolation reason can be projected from an un-trusted read.
    isolationFailureReason: null,
    observation,
    termination,
  };
}

// M12-14: additive top-level isolationFailureReason — the closed-set reason
// behind an isolation-failure settlement, projected from the SAME in-memory
// snapshot through the SAME shared delivery view the terminal outcome uses
// (the outcome.delivery key set is a frozen M12-9 contract, so the reason
// rides as a top-level sibling of `outcome`). Null unless the run is terminal
// with a safe workdir_escape isolation failure whose persisted reason is an
// exact ISOLATION_VIOLATION_REASONS member; a historical reason-absent or
// malformed reason is NEVER upgraded and never echoed. Never throws.
function projectIsolationFailureReason(events, runId, terminalState) {
  try {
    if (!TERMINAL_STATES.includes(terminalState)) return null;
    const view = gatherDeliveryView(events, runId, terminalState);
    const reason = view?.isolationFailure?.reason;
    return typeof reason === "string" && ISOLATION_VIOLATION_REASONS.includes(reason)
      ? reason
      : null;
  } catch {
    return null;
  }
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

// M12-9 Package C: project a bounded, FAIL-CLOSED terminal outcome from ONE
// transcript snapshot. Reuses the diagnosis SSOT (diagnoseFailure) and the
// delivery SSOT (gatherDeliveryView + projectDeliveryReadiness) — there is NO
// second transcript read, NO Git read via getRunDelivery, and NO run_collect
// call; every fact derives from the SAME in-memory `events` snapshot the wait
// already holds.
//
// Closed-set safe facts ONLY:
//   - terminalState ∈ TERMINAL_STATES;
//   - diagnosis { category ∈ DIAGNOSIS_CATEGORIES, code ∈ DIAGNOSIS_CODES
//     | null (provider_auth/provider_capacity → their category code,
//     no_effect → completed_empty), signalCount (count of evidence signals) };
//   - delivery { requested, readiness ∈ DELIVERY_READINESS_STATES, available,
//     failureCode ∈ PACKAGING_FAILURE_CODES | null, verificationStatus ∈
//     DELIVERY_VERIFICATION_STATUSES | null, verificationFailureCode ∈
//     DELIVERY_VERIFICATION_FAILURE_CODES | null, acceptanceStatus ∈
//     DELIVERY_ACCEPTANCE_STATUSES | null, decisionType ∈ DELIVERY_DECISION_TYPES
//     | null }.
//
// It NEVER carries a commit id, changed paths, candidateInventory, diff, command
// text, message/stderr, absolute path, or recommendation. ambiguous/malformed
// inputs collapse to a safe closed-set fact (readiness "ambiguous", statuses
// null) — never a raw value. The projector NEVER throws: any unexpected failure
// returns null (outcome unavailable), so it can never turn a wait response into
// a generic error.
//
// @param {object[]} events — explicit transcript event snapshot (already clean)
// @param {string} runId
// @param {string} terminalState
// @param {object} [injectables] — diagnoseFn/gatherViewFn/readinessFn for tests
// @returns {object|null} the bounded outcome, or null when unavailable
export function projectTerminalOutcome(events, runId, terminalState, injectables = {}) {
  try {
    // Defense in depth: the caller only invokes this on a clean terminal
    // snapshot, but a non-terminal/garbage terminalState makes the outcome
    // unavailable rather than echoing an unbounded value.
    if (!TERMINAL_STATES.includes(terminalState)) return null;

    const diagnose = injectables.diagnoseFn ?? diagnoseFailure;
    const gatherView = injectables.gatherViewFn ?? gatherDeliveryView;
    const readinessFn = injectables.readinessFn ?? projectDeliveryReadiness;

    // ===== diagnosis (closed-set category/code + signal count) =====
    const diag = diagnose(events, runId) || {};
    const diagnosis = {
      category: DIAGNOSIS_CATEGORIES.includes(diag.category) ? diag.category : "unknown",
      // M12-21: code is surfaced only for a valid (category, code) pair —
      // provider_auth/provider_capacity → their category code; no_effect →
      // completed_empty; null otherwise. Same pair discipline as run_diagnose.
      code: isValidDiagnosisCode(diag.category, diag.code) ? diag.code : null,
      signalCount: Array.isArray(diag.evidence) ? diag.evidence.length : 0,
    };

    // ===== delivery (bounded closed-set projection from the shared view) =====
    const view = gatherView(events, runId, terminalState) || {};

    let readiness;
    try {
      readiness = readinessFn(events, runId);
    } catch {
      readiness = "ambiguous";
    }
    if (!DELIVERY_READINESS_STATES.includes(readiness)) readiness = "ambiguous";

    // Each raw status is projected through its closed set; unknown/malformed
    // values collapse to null (never echoed). A verificationFailureCode is
    // meaningful ONLY when verificationStatus === "failed".
    const verificationStatus = view.verification
      && DELIVERY_VERIFICATION_STATUSES.includes(view.verification.status)
      ? view.verification.status
      : null;
    const verificationFailureCode = verificationStatus === "failed"
      && view.verification
      && DELIVERY_VERIFICATION_FAILURE_CODES.includes(view.verification.failureCode)
      ? view.verification.failureCode
      : null;
    const acceptanceStatus = view.acceptance
      && DELIVERY_ACCEPTANCE_STATUSES.includes(view.acceptance.status)
      ? view.acceptance.status
      : null;
    const rawDecisionType = view.acceptance?.decisionEvent?.type;
    const decisionType = rawDecisionType && DELIVERY_DECISION_TYPES.includes(rawDecisionType)
      ? rawDecisionType
      : null;
    // gatherDeliveryView already projects deliveryFailure.code through
    // safeProjectPackagingCode; re-check the closed set defensively.
    const failureCode = view.deliveryFailure
      && PACKAGING_FAILURE_CODES.includes(view.deliveryFailure.code)
      ? view.deliveryFailure.code
      : null;

    // M12-13: a structured isolation failure (e.g. workdir_escape) is a SEPARATE
    // settlement from a packaging failure — projected through the shared closed
    // set (SAFE_ISOLATION_VIOLATION_CODES), never echoed raw. Null for every
    // other delivery state.
    const isolationFailureCode = view.isolationFailure
      && SAFE_ISOLATION_VIOLATION_CODES.includes(view.isolationFailure.code)
      ? view.isolationFailure.code
      : null;

    const delivery = {
      requested: view.deliveryRequested === true,
      readiness,
      available: view.deliveryAvailable === true,
      failureCode,
      isolationFailureCode,
      verificationStatus,
      verificationFailureCode,
      acceptanceStatus,
      decisionType,
    };

    return { terminalState, diagnosis, delivery };
  } catch {
    // Fail closed: outcome unavailable. The run observation is preserved by the
    // caller; the outcome is strictly additive and must never break the wait.
    return null;
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
  let rawEvents;
  try {
    rawEvents = await _read(transcriptPath);
  } catch {
    // Initial read failure (file missing / unreadable / malformed JSON line):
    // no facts at all. Report read_failure truthfully; do not invent a
    // state/cursor. waitedMs is 0 (no waiting occurred). Any throw from the
    // reader is a transcript read/JSON parse exception → transcript_parse_failed.
    return readFailureResult({
      runId, agentId: "unknown", state: "unknown", terminal: false, cursor: null, waitedMs: 0,
      windowMs: waitMs, reason: "transcript_parse_failed",
    });
  }

  // M12-6: reduce the snapshot to usable events BEFORE any SSOT derive, so a
  // non-usable entry (null/primitive/array) can never throw a TypeError out of
  // findState / findLastEventSeq / findRunWorkspaceOwnership / summarizeLiveness.
  const events = usableEvents(rawEvents);
  const invalidShape = snapshotHasInvalidShape(rawEvents);

  // Workspace authorization (MCP path) is proved on the usable snapshot only,
  // so a structural TypeError is impossible here. A valid cross-workspace run is
  // STILL rejected — this boundary only prevents a non-usable event from
  // crashing the check; the ownership Error propagates unchanged.
  if (authorizedWorkspaceRoot !== undefined) {
    verifyRunWorkspaceOwnership(events, authorizedWorkspaceRoot, runId);
  }

  // Safe derive over the usable subset. Defense in depth: usable already
  // excludes null/primitive/array, but any residual SSOT derive failure still
  // collapses to read_failure — never a top-level throw.
  let state;
  let cursor;
  let agentId;
  try {
    state = findState(events);
    cursor = findLastEventSeq(events) ?? 0;
    agentId = extractCanonicalAgentId(events, runId);
  } catch {
    // Defense in depth: usable already excludes null/primitive/array, so a
    // residual SSOT derive failure is NOT a shape violation and NOT a parse
    // error — it is another safe non-parse failure → snapshot_unavailable.
    return readFailureResult({
      runId, agentId: "unknown", state: "unknown", terminal: false, cursor: null, waitedMs: 0,
      windowMs: waitMs, reason: "snapshot_unavailable",
    });
  }
  const terminal = TERMINAL_STATES.includes(state);

  // M12-6: a structurally corrupt snapshot is a read_failure — never a clean
  // "observed". The durable runId/state/terminal are preserved as a truthful
  // hint; cursor/agentId/liveness/collect depend on a clean full snapshot and
  // stay null/unknown/unavailable. Non-usable entries are the legacy shape
  // case → legacy_event_shape.
  if (invalidShape) {
    return readFailureResult({
      runId, agentId: "unknown", state, terminal, cursor: null, waitedMs: 0,
      windowMs: waitMs, reason: "legacy_event_shape",
    });
  }

  // Activity baseline: omitted → cursor at first read (only window-new events
  // count); explicit → the caller's cursor.
  const activityBaseline = afterSeqOmitted ? cursor : input.afterSeq;

  // ===== TERMINAL AT ENTRY =====
  // Single snapshot: the same `events` feeds the observation AND the compact
  // collect. No post-terminal reread.
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
      waitedMs: 0,
      observationOutcome: "observed",
      readFailureReason: null,
      liveness: "terminal",
      activityEventCount: 0,
      lastActivityKind: null,
      ownerHeartbeat: "n/a",
      result: collectCompactFromSnapshot(events, runId, agentId, input.env, projectFn),
      // M12-9 Package C: terminal AND cleanly observed → project the bounded
      // outcome from THIS snapshot (diagnosis + delivery SSOTs, single read).
      outcome: projectTerminalOutcome(events, runId, state),
      // M12-14: additive closed-set isolation reason (null unless a safe
      // workdir_escape settlement with an exact-member reason was persisted).
      isolationFailureReason: projectIsolationFailureReason(events, runId, state),
      observation,
      termination,
    };
  }

  // ===== POINT-IN-TIME (waitMs === 0) =====
  // Read once, return immediately. No sleep, no loop.
  if (waitMs === 0) {
    const liv = summarizeLiveness({ events, runDir: resolvedRunDir, runId, activityBaseline, now: _now() });
    const { observation, termination } = projectObservation({
      events, runId, currentState: state, terminal: false, readFailure: false,
      waitedMs: 0, windowMs: 0,
    });
    return {
      runId,
      agentId,
      state,
      terminal: false,
      cursor,
      returnedEarly: false,
      waitedMs: 0,
      observationOutcome: "observed",
      readFailureReason: null,
      liveness: liv.liveness,
      activityEventCount: liv.activityEventCount,
      lastActivityKind: liv.lastActivityKind,
      ownerHeartbeat: liv.ownerHeartbeat,
      result: unobservedResult("not_terminal"),
      // M12-9 Package C: non-terminal → outcome is unavailable (null).
      outcome: null,
      // M12-14: non-terminal → no terminal settlement reason exists.
      isolationFailureReason: null,
      observation,
      termination,
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

    let pollRaw;
    try {
      pollRaw = await _read(transcriptPath);
    } catch {
      // RE-READ FAILURE (file): do NOT combine stale events with a fresh owner
      // heartbeat. Report read_failure with liveness/heartbeat unknown and a
      // null activity tally — the observation is stale, not current. The last
      // trusted agentId/state/cursor are preserved. A re-read throw is still a
      // transcript read/JSON parse exception → transcript_parse_failed.
      return readFailureResult({
        runId, agentId, state: currentState, terminal: false, cursor: currentCursor, waitedMs: _now() - begin,
        windowMs: waitMs, reason: "transcript_parse_failed",
      });
    }

    // M12-6: same usable-event boundary on every poll snapshot, so a non-usable
    // entry that appeared between polls can never throw a TypeError.
    const pollEvents = usableEvents(pollRaw);
    if (snapshotHasInvalidShape(pollRaw)) {
      // SHAPE FAILURE during wait: do NOT combine a corrupt snapshot with a
      // fresh heartbeat. Preserve the last trusted agentId/state/cursor; same
      // truthful read_failure shape as a re-read file failure → legacy shape.
      return readFailureResult({
        runId, agentId, state: currentState, terminal: false, cursor: currentCursor, waitedMs: _now() - begin,
        windowMs: waitMs, reason: "legacy_event_shape",
      });
    }

    // Every snapshot that can drive returned facts must independently prove
    // workspace ownership. A transcript replacement between polls must not let
    // foreign terminal data pass on the authority of the initial snapshot.
    if (authorizedWorkspaceRoot !== undefined) {
      verifyRunWorkspaceOwnership(pollEvents, authorizedWorkspaceRoot, runId);
    }

    currentEvents = pollEvents;
    let pollState;
    let pollCursor;
    try {
      pollState = findState(currentEvents);
      pollCursor = findLastEventSeq(currentEvents) ?? currentCursor;
    } catch {
      // Residual poll derive failure on an otherwise-usable snapshot — the
      // snapshot could not be derived, a safe non-parse reason → snapshot_unavailable.
      return readFailureResult({
        runId, agentId, state: currentState, terminal: false, cursor: currentCursor, waitedMs: _now() - begin,
        windowMs: waitMs, reason: "snapshot_unavailable",
      });
    }
    currentState = pollState;
    currentCursor = pollCursor;

    if (TERMINAL_STATES.includes(currentState)) {
      // TERMINAL DURING WAIT — collect from THIS (terminal-observing) snapshot.
      // Single snapshot: collect adds ZERO extra reads.
      const termAgentId = extractCanonicalAgentId(currentEvents, runId);
      const { observation, termination } = projectObservation({
        events: currentEvents, runId, currentState, terminal: true, readFailure: false,
        waitedMs: _now() - begin, windowMs: waitMs,
      });
      return {
        runId,
        agentId: termAgentId,
        state: currentState,
        terminal: true,
        cursor: currentCursor,
        returnedEarly: true,
        waitedMs: _now() - begin,
        observationOutcome: "observed",
        readFailureReason: null,
        liveness: "terminal",
        activityEventCount: 0,
        lastActivityKind: null,
        ownerHeartbeat: "n/a",
        result: collectCompactFromSnapshot(currentEvents, runId, termAgentId, input.env, projectFn),
        // M12-9 Package C: terminal during wait → project the bounded outcome
        // from THIS (terminal-observing) snapshot. Single read — no extra I/O.
        outcome: projectTerminalOutcome(currentEvents, runId, currentState),
        // M12-14: additive closed-set isolation reason from the same snapshot.
        isolationFailureReason: projectIsolationFailureReason(currentEvents, runId, currentState),
        observation,
        termination,
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
  // M12-11: window expiry is advisory — the worker is NOT stopped. termination
  // stays null; outcome is window_expired (not terminal, not a read failure).
  const { observation, termination } = projectObservation({
    events: currentEvents, runId, currentState, terminal: false, readFailure: false,
    waitedMs: _now() - begin, windowMs: waitMs,
  });
  return {
    runId,
    agentId,
    state: currentState,
    terminal: false,
    cursor: currentCursor,
    returnedEarly: false,
    waitedMs: _now() - begin,
    observationOutcome: "observed",
    readFailureReason: null,
    liveness: liv.liveness,
    activityEventCount: liv.activityEventCount,
    lastActivityKind: liv.lastActivityKind,
    ownerHeartbeat: liv.ownerHeartbeat,
    result: unobservedResult("not_terminal"),
    // M12-9 Package C: window expiry, still non-terminal → outcome unavailable.
    outcome: null,
    // M12-14: window expiry is non-terminal → no terminal settlement reason.
    isolationFailureReason: null,
    observation,
    termination,
  };
}
