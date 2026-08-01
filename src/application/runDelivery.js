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

import {
  readTranscript,
  findState,
  findLastEventSeq,
  validateDeliveryFacts,
  projectReverifyChain,
  findValidRepackageProvenance,
  classifyRecoveryCandidate,
  JsonlTranscript,
  TERMINAL_STATES,
  DELIVERY_DECISION_POLICY_CODES,
  DeliveryDecisionPolicyError,
} from "../transcript.js";
import { isValidRunId, isCanonicalCommitId } from "../delivery.js";
import { PACKAGING_FAILURE_CODES, safeProjectPackagingCode } from "../deliveryFailureCodes.js";
import { verifyRunWorkspaceOwnership } from "./runWorkspaceOwnership.js";
import { proveWorkspace } from "./workspaceBinding.js";

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
  "ambiguous", // conflicting or terminal-incomplete durable chain — fail closed
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
// M11-10 closeout: a bound delivery event (envelope runId === requested runId)
// carries a USABLE DeliveryRef iff `delivery` is an object whose own runId equals
// the requested runId. A missing/non-object payload (malformed event) or a ref
// whose runId disagrees with its envelope (cross-run injection) is a durable
// CONFLICT, not merely "no delivery". Shared by projectDeliveryReadiness and
// _reconstructDelivery so the readiness label and the reconstructed view apply
// ONE binding rule.
function _deliveryRefIsBound(e, runId) {
  return !!e && typeof e.delivery === "object" && e.delivery !== null
    && e.delivery.runId === runId;
}

/**
 * A bound created/verification event is a durable conflict unless its DeliveryRef
 * is fully USABLE: bound (a missing/non-object payload, or a ref.runId that
 * disagrees with its envelope = cross-run injection) AND both baseCommit and
 * deliveryCommit canonical lowercase 40/64-hex. The canonical-commit requirement
 * reuses the SAME isCanonicalCommitId SSOT that assertDeliveryCommitInRepository
 * and validateDeliveryFacts enforce — HEAD / short SHA / uppercase / non-hex /
 * missing commit is a conflict, never a usable fact. No second regex, no
 * error-string matching: _deliveryRefIsUsable is the single usability rule,
 * shared with _reconstructDelivery so the readiness label and the reconstructed
 * view cannot diverge (M11-12A P1: projectDeliveryReadiness previously used the
 * weaker _deliveryRefIsBound here, letting a malformed-commit created ref reach
 * waiting_for_verification).
 *
 * @param {object[]} boundEvents — already envelope-bound to runId
 * @param {string} runId
 * @returns {boolean} true if ANY bound event has a malformed/cross-run delivery
 * @private
 */
function _hasConflictDelivery(boundEvents, runId) {
  return boundEvents.some((e) => !_deliveryRefIsUsable(e, runId));
}

/**
 * A bound delivery event carries a USABLE DeliveryRef iff `delivery` is a non-null
 * object whose own runId equals the requested runId (the binding rule shared with
 * _deliveryRefIsBound) AND whose baseCommit and deliveryCommit are both canonical
 * commit ids. The canonical-commit requirement is the SAME immutable-identity
 * contract assertDeliveryCommitInRepository enforces — HEAD / short-SHA /
 * uppercase / non-hex are rejected before any use — reused via isCanonicalCommitId
 * so there is ONE commit validator and NO duplicated regex.
 *
 * Shared by the reconstruction layer (_reconstructDelivery): a malformed-but-
 * truthy commit (e.g. "HEAD") on a created/verification/decision ref is a durable
 * CONFLICT, not a usable fact, so it can never enter a success view.
 * @param {object} e
 * @param {string} runId
 * @returns {boolean}
 * @private
 */
function _deliveryRefIsUsable(e, runId) {
  return _deliveryRefIsBound(e, runId)
    && isCanonicalCommitId(e.delivery?.baseCommit)
    && isCanonicalCommitId(e.delivery?.deliveryCommit);
}

export function projectDeliveryReadiness(events, runId) {
  if (!Array.isArray(events)) return "ambiguous";

  // Envelope-bound durable events: the event runId MUST equal the requested
  // runId. A foreign-envelope event belongs to another run and is ignored (it is
  // NOT a conflict — only an envelope/ref mismatch within a bound event is).
  const boundCreated = events.filter(
    (e) => e && e.type === "run.delivery_created" && e.runId === runId,
  );
  const boundVerification = events.filter(
    (e) => e && DELIVERY_VERIFICATION_OUTCOME_TYPES.has(e.type) && e.runId === runId,
  );
  const failed = events.filter(
    (e) => e && e.type === "run.delivery_failed" && e.runId === runId,
  );

  // M11-10 closeout (auditor blockers 2 & 3) + M11-12A P1: a bound created/
  // verification event is a durable conflict unless its DeliveryRef is fully
  // USABLE — a missing/non-object payload, a DeliveryRef.runId that disagrees
  // with its envelope (cross-run injection), OR a non-canonical baseCommit /
  // deliveryCommit (HEAD / short SHA / uppercase / non-hex / missing; reuses
  // isCanonicalCommitId via _deliveryRefIsUsable). Such an event must NEVER reach
  // waiting_for_verification — which would surface a verification_pending review
  // result — so it fails closed to ambiguous. No malformed/injected value is
  // echoed (only the closed-set label).
  if (_hasConflictDelivery(boundCreated, runId)) return "ambiguous";
  if (_hasConflictDelivery(boundVerification, runId)) return "ambiguous";

  // After the conflict checks, every bound created/verification event carries a
  // usable, runId-bound DeliveryRef.
  const created = boundCreated;
  const verification = boundVerification;

  // M12-1S2: a bound run.delivery_failed is SUPERSEDED when a recovery provenance
  // (run.delivery_repackaged) binds the same delivery commit as the single bound
  // delivery_created. A model-free repackage of a retained disallowed_path
  // failure appends exactly that provenance atomically with delivery_created, so
  // the pre-existing failure is no longer a durable conflict — it is the
  // recovered state of the run. Without this, created+failed would collapse to
  // ambiguous and the recovered delivery could never become reviewable.
  const failureSuperseded = created.length === 1
    && findValidRepackageProvenance(events, runId, created[0].delivery) !== null;

  // Conflicting durable facts → ambiguous (fail closed).
  if (created.length > 1) return "ambiguous";
  if (verification.length > 1) return "ambiguous";
  // Multiple bound failures are conflicting durable facts (no single
  // authoritative failure) → ambiguous. A single bound failure falls through to
  // packaging_failed below.
  if (failed.length > 1) return "ambiguous";
  // created+failed is a durable conflict UNLESS the failure was superseded by a
  // recovery provenance bound to the created commit (M12-1S2).
  if (created.length === 1 && failed.length > 0 && !failureSuperseded) return "ambiguous";
  // A verification outcome bound to this runId with NO bound delivery_created
  // is an orphan durable fact (broken durable chain) → ambiguous. It must never
  // fall through to waiting_for_packaging / not_requested.
  if (verification.length > 0 && created.length === 0) return "ambiguous";

  if (created.length === 1 && verification.length === 1) {
    const createdRef = created[0].delivery;
    const verificationRef = verification[0].delivery;
    // Full durable-identity binding to the requested runId (cross-run defense)
    // and matching verification commit. Any drift → ambiguous.
    if (createdRef.runId !== runId) return "ambiguous";
    if (verificationRef.runId !== runId) return "ambiguous";
    if (createdRef.deliveryCommit !== verificationRef.deliveryCommit) return "ambiguous";
    // SSOT authority: validateDeliveryFacts must agree this is an unambiguous,
    // reviewable delivery (exactly one created + one matching final outcome, both
    // commits canonical). Only THIS run's envelope-bound events are passed, so a
    // foreign event in a concatenated/corrupt transcript cannot poison the
    // durable-facts validator. The canonical-commit requirement lives in
    // validateDeliveryFacts (single commit validator) — no second regex here.
    const facts = validateDeliveryFacts(events.filter((e) => e && e.runId === runId));
    if (!facts.valid) return "ambiguous";
    return "reviewable";
  }

  if (failed.length > 0 && !failureSuperseded) return "packaging_failed";
  if (created.length === 1) return "waiting_for_verification";

  // No committed delivery and no packaging failure. Distinguish "delivery was
  // requested but not yet packaged" from "delivery was never requested" using
  // the shared runId-bound intent projection.
  if (!_deliveryWasRequested(events, runId)) return "not_requested";

  // A terminal run cannot truthfully be "waiting" for its first packaging
  // outcome. With no created/failed fact, the durable chain is incomplete.
  // Fail closed to the existing ambiguous state so bounded readiness queries
  // return immediately instead of burning their full wait window.
  const boundState = findState(events.filter((e) => e && e.runId === runId));
  if (TERMINAL_STATES.includes(boundState)) return "ambiguous";

  return "waiting_for_packaging";
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

function _deliveryWasRequested(events, runId) {
  return events.some(
    (e) => e && e.runId === runId && (
      (e.type === "run.background_submitted" && e.deliveryRequested === true)
      || (
        e.type === "run.started"
        && e.delivery
        && typeof e.delivery.mode === "string"
        && e.delivery.mode.length > 0
      )
    ),
  );
}

// ===== Private: delivery reconstruction (migrated from runs.js) =====

/**
 * Reconstruct the latest delivery ref, decision event, and delivery commit
 * from transcript events. This is the single algorithm — point-in-time
 * getRunDelivery and the wait/readiness handshake both use it via
 * _gatherDeliveryView.
 *
 * M11-10 closeout (auditor blocker 2 + Lead-review residue): created/
 * verification/decision scans are ALL bound by the requested runId, so a
 * foreign-run event in a concatenated/corrupt transcript cannot leak its
 * commit/changedPaths/acceptance into this run's view. An envelope-bound event
 * whose DeliveryRef is NOT USABLE — missing/non-object payload, a ref.runId that
 * disagrees with its envelope (cross-run injection), or a non-canonical
 * baseCommit/deliveryCommit (HEAD/short-SHA/uppercase/non-hex; reused via
 * isCanonicalCommitId) — is a durable CONFLICT: it sets `conflict` and is NOT
 * used as a success fact. The caller fail-closes a conflict to ambiguous — it
 * must never be disguised as "no delivery" by silently filtering it out, and no
 * ref/path/commit is echoed.
 *
 * Each category is FULL-scanned (newest→oldest) for a conflict BEFORE the newest
 * usable fact is selected. The scan does NOT break on the first usable event:
 * a reverse-order `break` would shadow an earlier malformed bound event behind a
 * newer valid one (leaving conflict=false while the view echoed the newer ref).
 * The durable-facts contract is "ANY bound malformed/injected/non-canonical
 * event fails closed", so every conflict is recorded first.
 *
 * A formal run.delivery_accepted/rejected event always carries a delivery ref
 * (see JsonlTranscript.tryAppendDecision); a decision missing delivery is a
 * conflict, never a tolerated "decision without ref" that projects acceptance.
 * @param {Array} events
 * @param {string} runId
 * @returns {{latestRef: object|null, decisionEvent: object|null, deliveryCommit: string|null, conflict: boolean}}
 */
function _reconstructDelivery(events, runId) {
  let conflict = false;
  let createdRef = null;
  let verificationRef = null;
  let decisionEvent = null;
  let decisionRef = null;

  // For each category: scan newest→oldest over ALL bound events (envelope
  // runId === requested runId). Record a conflict for ANY event whose ref is not
  // USABLE; the newest USABLE ref (first usable encountered) is the category's
  // candidate. No `break`: an earlier malformed bound event must still set
  // conflict even when a newer usable event exists.
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (!e || e.type !== "run.delivery_created" || e.runId !== runId) continue;
    if (!_deliveryRefIsUsable(e, runId)) { conflict = true; continue; }
    if (!createdRef) createdRef = e.delivery;
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (!e || !DELIVERY_VERIFICATION_OUTCOME_TYPES.has(e.type) || e.runId !== runId) continue;
    if (!_deliveryRefIsUsable(e, runId)) { conflict = true; continue; }
    if (!verificationRef) verificationRef = e.delivery;
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (!e || (e.type !== "run.delivery_accepted" && e.type !== "run.delivery_rejected") || e.runId !== runId) continue;
    // A bound decision that is missing delivery / non-object delivery / foreign
    // ref.runId / non-canonical commit is a durable CONFLICT — it must never
    // project acceptance. (Previously a missing delivery was tolerated.)
    if (!_deliveryRefIsUsable(e, runId)) { conflict = true; continue; }
    if (!decisionEvent) { decisionEvent = e; decisionRef = e.delivery; }
  }

  // Priority matches the prior algorithm: a usable decision overrides a usable
  // verification, which overrides a usable created. When conflict is true the
  // caller ignores latestRef entirely (ambiguous marker), so a conflict found in
  // any category voids the whole view.
  const latestRef = decisionRef ?? verificationRef ?? createdRef;
  const deliveryCommit = latestRef?.deliveryCommit ?? null;
  return { latestRef, createdRef, decisionEvent, deliveryCommit, conflict };
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
//   - no-delivery view: { runId, terminalState, deliveryAvailable: false,
//       deliveryRequested, deliveryFailure: null }
//     (no committed delivery AND no bound packaging failure)
//   - ambiguous marker: { runId, terminalState, deliveryAvailable: false, ambiguous: true }
//     (a durable conflict: malformed bound event / cross-run injection. Never
//     echoes a raw ref/commit/path; the caller fail-closes to ambiguous.)
function _gatherDeliveryView(events, runId, terminalState) {
  const { latestRef, createdRef, decisionEvent, deliveryCommit, conflict } = _reconstructDelivery(events, runId);

  // M11-10 closeout (auditor blocker 2): a durable conflict detected by the
  // runId-bound reconstruction must NOT be disguised as "no delivery" (which
  // would let a malformed/injected event masquerade as a clean waiting state)
  // and must NOT echo the conflicting ref. Fail closed to the ambiguous marker.
  if (conflict) {
    return {
      runId,
      terminalState,
      deliveryAvailable: false,
      deliveryRequested: _deliveryWasRequested(events, runId),
      ambiguous: true,
    };
  }

  if (latestRef && deliveryCommit) {
    const verificationStatus = latestRef.verification?.status ?? "pending";
    const acceptanceStatus = decisionEvent
      ? (decisionEvent.type === "run.delivery_accepted" ? "accepted" : "rejected")
      : (latestRef.acceptance?.status ?? "pending");
    // M12-6 Package 3B: ADDITIVE original/effective/reverify projection. The
    // `verification` field stays the ORIGINAL truth (the durable verification
    // outcome on the run) so existing callers see zero drift. The effective
    // verification status equals the reverify outcome ONLY when exactly one bound
    // requested + one bound outcome exist (status "complete"); otherwise it
    // equals the original. projectReverifyChain never reads Git and never
    // echoes a raw ref/commit/path — only the closed-set status/reason.
    const reverify = createdRef
      ? projectReverifyChain(events, runId, createdRef)
      : { status: "none", reason: null, effectiveStatus: null };
    const effectiveStatus = reverify.status === "complete" && reverify.effectiveStatus
      ? reverify.effectiveStatus
      : verificationStatus;
    return {
      runId,
      terminalState,
      deliveryAvailable: true,
      deliveryRequested: true,
      deliveryRef: latestRef,
      verification: {
        status: verificationStatus,
        ...(latestRef.verification?.failureCode ? { failureCode: latestRef.verification.failureCode } : {}),
      },
      effectiveVerification: { status: effectiveStatus },
      reverify: {
        status: reverify.status,
        ...(reverify.reason ? { reason: reverify.reason } : {}),
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
      deliveryRequested: true,
      deliveryFailure: { code },
    };
  }

  // No committed delivery and no packaging failure. This is normal for an
  // ordinary non-delivery run and a truthful pending state for a delivery run
  // that has not packaged yet; neither is an application error.
  return {
    runId,
    terminalState,
    deliveryAvailable: false,
    deliveryRequested: _deliveryWasRequested(events, runId),
    deliveryFailure: null,
  };
}

// ===== Private: M12-1S1 candidate inventory (read-only, fail-closed) =====
//
// When the durable bound packaging failure is exactly `disallowed_path`, the
// failure view gains an additive nullable `candidateInventory`: the candidate's
// ACTUAL changed paths vs the persisted ORIGINAL base/allowedPaths contract.
// Advisory only — never expands scope, repackages, stops/retries, or decides.
//
// Every gate below runs BEFORE the inventory reader is invoked; ANY failure
// collapses to null (never partial truth, never an unbound read):
//   1. an inventory reader was injected (the service never defaults the kernel);
//   2. a non-empty authorizedWorkspaceRoot authority was supplied;
//   3. workspace ownership proof (verifyRunWorkspaceOwnership SSOT);
//   4. exactly ONE bound run.started (envelope runId === requested runId) with a
//      usable delivery context (canonical baseCommit, non-empty allowedPaths)
//      and a worktreePath;
//   5. linked-worktree-at-base proof: the persisted worktreePath is a real Git
//      worktree top-level whose HEAD is EXACTLY the persisted original
//      baseCommit (proveWorkspace SSOT) — HEAD drift voids the proof.
// Only then is the reader invoked; a throwing reader also collapses to null.

/**
 * @param {object[]} events
 * @param {string} runId
 * @param {string} [authorizedWorkspaceRoot]
 * @param {Function} [computeInventoryFn]
 * @returns {object|null} the inventory, or null on any proof/read failure
 * @private
 */
function _computeSafeCandidateInventory(events, runId, authorizedWorkspaceRoot, computeInventoryFn) {
  try {
    if (typeof computeInventoryFn !== "function") return null;
    if (typeof authorizedWorkspaceRoot !== "string" || authorizedWorkspaceRoot.length === 0) return null;
    verifyRunWorkspaceOwnership(events, authorizedWorkspaceRoot);
    const started = events.filter((e) => e && e.type === "run.started" && e.runId === runId);
    if (started.length !== 1) return null;
    const bound = started[0];
    const delivery = bound.delivery;
    if (!delivery || typeof delivery !== "object") return null;
    if (!isCanonicalCommitId(delivery.baseCommit)) return null;
    if (!Array.isArray(delivery.allowedPaths) || delivery.allowedPaths.length === 0) return null;
    if (typeof bound.worktreePath !== "string" || bound.worktreePath.length === 0) return null;
    // Linked-worktree-at-base proof (reuses the proveWorkspace SSOT: the path
    // must be a real Git worktree TOP-LEVEL — never a subdirectory — and all
    // Git failures throw). HEAD must be EXACTLY the persisted original base.
    const proof = proveWorkspace(bound.worktreePath);
    if (proof.gitHead !== delivery.baseCommit) return null;
    const inventory = computeInventoryFn(bound.worktreePath, delivery.baseCommit, delivery.allowedPaths);
    return inventory ?? null;
  } catch {
    return null;
  }
}

function _computeSafeBackendCandidateInventory(
  events,
  runId,
  authorizedWorkspaceRoot,
  computeInventoryFn,
) {
  if (classifyRecoveryCandidate(events, runId) !== "backend_failed") return null;
  const boundEvents = events.filter((event) => event.runId === runId);
  if (boundEvents.some((event) => (
    event.type === "run.delivery_repackaged"
    || event.type === "run.delivery_created"
    || event.type === "run.delivery_verification_passed"
    || event.type === "run.delivery_verification_failed"
    || event.type === "run.delivery_verification_unavailable"
    || event.type === "run.delivery_accepted"
    || event.type === "run.delivery_rejected"
  ))) {
    return null;
  }
  const inventory = _computeSafeCandidateInventory(
    events,
    runId,
    authorizedWorkspaceRoot,
    computeInventoryFn,
  );
  if (!inventory) return null;
  if (
    inventory.originalAllowedTruncated
    || inventory.actualChangedTruncated
    || inventory.disallowedTruncated
    || inventory.actualChangedCount === 0
    || inventory.actualChangedPaths.length === 0
  ) {
    return null;
  }
  return inventory;
}

// ===== Service: getRunDelivery (read-only point-in-time query) =====

/**
 * Get the read-only delivery status for a run.
 *
 * @param {object} input
 * @param {string} input.runId — must pass isValidRunId
 * @param {string} input.runDir — runs/ directory (host-owned)
 * @param {string} [input.authorizedWorkspaceRoot] — M12-1S1: authority for the
 *   read-only candidate inventory (omitted => candidateInventory null, no read)
 * @param {Function} [input.computeInventoryFn] — M12-1S1: injectable inventory
 *   reader; the service never defaults the kernel reader
 * @param {Function} [input.readTranscriptFn] — injectable for testing
 * @returns {Promise<object>} delivery view: {runId, terminalState, deliveryRef, verification, acceptance}
 */
export async function getRunDelivery({ runId, runDir, authorizedWorkspaceRoot, computeInventoryFn, readTranscriptFn }) {
  if (!runId || typeof runId !== "string") throw new Error("getRunDelivery: runId is required");
  if (!runDir || typeof runDir !== "string") throw new Error("getRunDelivery: runDir is required");
  if (!isValidRunId(runId)) throw new Error(`Invalid runId: ${JSON.stringify(runId)}`);

  const _readTranscript = readTranscriptFn ?? readTranscript;
  const filePath = join(runDir, `${runId}.jsonl`);
  const events = await _readTranscript(filePath);

  const terminalState = findState(events);
  const view = _gatherDeliveryView(events, runId, terminalState);
  // M11-10 closeout: a durable conflict (cross-run injection / malformed bound
  // event) must fail closed for the point-in-time query too — never echo a raw
  // ref/path. Fixed message; no dynamic ref content is leaked.
  if (view.ambiguous) throw new Error("delivery facts ambiguous");
  // Candidate inventory is additive and authority-bound. The original
  // disallowed_path recovery and M12-4A backend-failure recovery share the
  // same exact-base inventory proof; every other state omits the fields.
  if (view.deliveryFailure?.code === "disallowed_path") {
    view.candidateInventory = _computeSafeCandidateInventory(
      events, runId, authorizedWorkspaceRoot, computeInventoryFn,
    );
    view.candidateKind = view.candidateInventory ? "disallowed_scope" : null;
  } else if (
    view.deliveryAvailable === false
    && view.deliveryFailure === null
    && view.deliveryRequested === true
    && view.terminalState === "failed"
  ) {
    const candidateInventory = _computeSafeBackendCandidateInventory(
      events, runId, authorizedWorkspaceRoot, computeInventoryFn,
    );
    if (candidateInventory) {
      view.candidateInventory = candidateInventory;
      view.candidateKind = "backend_failed";
    }
  }
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
 *
 * M11-10 closeout (auditor blockers 1 & 2): the readiness projection and the
 * runId-bound reconstruction share ONE truth, enforced here:
 *   - If the reconstruction detected a durable conflict (cross-run injection /
 *     malformed bound event), the readiness collapses to `ambiguous` — never
 *     echo the conflicting ref (the ambiguous view already carries no ref).
 *   - Executable invariant: `reviewable ⇒ deliveryAvailable === true`. If the
 *     two authorities ever disagree (e.g. a non-canonical commit slipped past
 *     the label but the reconstruction found no usable delivery), fail closed to
 *     `ambiguous` instead of surfacing an inconsistent reviewable +
 *     deliveryAvailable:false state. The label and the view never carry raw
 *     ref/path/reason on this path.
 * @param {object} [inventoryOpts] — M12-1S1: { authorizedWorkspaceRoot,
 *   computeInventoryFn } for the additive nullable candidateInventory
 * @private */
function _buildReadinessResult(runId, events, terminalState, readiness, waitReturnedEarly, inventoryOpts = {}) {
  const view = _gatherDeliveryView(events, runId, terminalState);
  let effectiveReadiness = view.ambiguous ? "ambiguous" : readiness;
  if (effectiveReadiness === "reviewable" && view.deliveryAvailable !== true) {
    effectiveReadiness = "ambiguous";
  }
  const result = {
    runId,
    readiness: effectiveReadiness,
    waitReturnedEarly,
    terminalState,
    deliveryAvailable: view.deliveryAvailable,
    deliveryRequested: view.deliveryRequested,
    deliveryRef: view.deliveryRef ?? null,
    deliveryFailure: view.deliveryFailure ?? null,
    verification: view.verification ?? null,
    // M12-6 Package 3B2a: forward the additive original/effective/reverify
    // projection from the shared view gatherer — same truth as the
    // point-in-time query, so the wait and point-in-time paths cannot diverge.
    effectiveVerification: view.effectiveVerification ?? null,
    reverify: view.reverify ?? null,
    acceptance: view.acceptance ?? null,
  };
  // Same candidate projection and proof gates as the point-in-time query.
  if (result.deliveryFailure?.code === "disallowed_path") {
    result.candidateInventory = _computeSafeCandidateInventory(
      events, runId, inventoryOpts.authorizedWorkspaceRoot, inventoryOpts.computeInventoryFn,
    );
    result.candidateKind = result.candidateInventory ? "disallowed_scope" : null;
  } else if (
    result.deliveryAvailable === false
    && result.deliveryFailure === null
    && result.deliveryRequested === true
    && result.terminalState === "failed"
  ) {
    const candidateInventory = _computeSafeBackendCandidateInventory(
      events, runId, inventoryOpts.authorizedWorkspaceRoot, inventoryOpts.computeInventoryFn,
    );
    if (candidateInventory) {
      result.candidateInventory = candidateInventory;
      result.candidateKind = "backend_failed";
    }
  }
  return result;
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
 * @param {Function} [input.computeInventoryFn] — injectable candidate
 *   inventory reader for an eligible recovery candidate
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
  computeInventoryFn,
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
  // Candidate-inventory authority/reader, threaded into every readiness
  // result build and consumed only by an eligible recovery candidate.
  const inventoryOpts = { authorizedWorkspaceRoot, computeInventoryFn };

  // Non-waiting readiness settles immediately: reviewable, packaging_failed,
  // not_requested, and ambiguous are durable facts — waiting cannot change them.
  if (!WAITING_READINESS_STATES.has(readiness)) {
    return _buildReadinessResult(runId, events, terminalState, readiness, true, inventoryOpts);
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
      return _buildReadinessResult(runId, events, terminalState, readiness, true, inventoryOpts);
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
    return _buildReadinessResult(runId, events, terminalState, "ambiguous", true, inventoryOpts);
  }

  // Deadline expired while still pending. Return the truthful fact — this is
  // NOT an error: pending is a valid, honest readiness outcome. The caller
  // (Lead) decides what to do; the service never auto-stop/retry/accept/reject.
  return _buildReadinessResult(runId, events, terminalState, readiness, false, inventoryOpts);
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

// ===== M12-6 Package 3B2a + M12-9: decision-rejection classification (single authority) =====
//
// The MCP transport maps EXPECTED policy rejections to structured outcomes with
// a CLOSED-SET rejectionReason instead of MCP isError. This module is the ONE
// application-level authority for that classification — the transport never
// regex-matches error text itself. It covers every durable gate the decision
// primitives can raise:
//   - tryAppendDecision gate errors (verification / terminal / reject-gate)
//   - validateDeliveryFacts durable-facts errors (unavailable / malformed)
// "already_decided" is not a throw: the primitive returns {accepted:false,
// existing}, and the transport emits it on that result path.
//
// M12-9: the machine protocol is a TYPED code, never a parsed message. The
// decision authority (transcript.js) throws the dedicated
// DeliveryDecisionPolicyError carrying a code from its frozen
// DELIVERY_DECISION_POLICY_CODES SSOT. This module DERIVES its rejection codes
// from that SSOT (appending the non-error already_decided outcome code) and
// classifies ONLY the dedicated type whose code is in the SSOT set. A plain
// Error — even with byte-identical old gate wording — is never classified
// (stays a fixed safe MCP error); an unknown code fails closed the same way.
// The classifier never returns raw message text.

export const DELIVERY_DECISION_REJECTION_CODES = Object.freeze([
  ...DELIVERY_DECISION_POLICY_CODES,
  "already_decided",
]);

/**
 * Classify a thrown policy error into the closed-set rejection code, or null
 * when the error is not a recognized policy rejection (unexpected/internal —
 * the caller keeps it a fixed safe error).
 * @param {unknown} err
 * @returns {string|null} one of DELIVERY_DECISION_REJECTION_CODES, or null
 */
export function classifyDeliveryDecisionRejection(err) {
  if (!(err instanceof DeliveryDecisionPolicyError)) return null;
  if (!DELIVERY_DECISION_POLICY_CODES.includes(err.code)) return null;
  return err.code;
}
