// src/application/runDeliveryRepackage.js
//
// M12-1S2: model-free delivery repackage for a retained disallowed_path
// packaging failure.
//
// When a delivery run terminally failed with packaging code `disallowed_path`,
// the Lead may pass { runId, allowedPaths } and WAO re-packages by REUSING the
// original run's persisted worktree / base / verification config:
//   - No model is called. No worker is resumed. No path is inferred. No
//     verification command is modified. Nothing is auto accepted/rejected.
//   - The Lead's allowedPaths is the ONLY scope authority: it must include the
//     ORIGINAL allowedPaths and cover EVERY actual changed path.
//   - The ORIGINAL verificationCommands/unavailableReason are reused
//     value-for-value; there is no caller override.
//
// Phased, reentrant, crash-recovery- and concurrency-safe state machine:
//   Phase 0  read transcript + prove preconditions (workspace-bound, terminal
//            failed, exactly one bound disallowed_path failure, original
//            delivery requested, no existing decision, one usable run.started).
//   Phase 1  recompute the FULL candidate inventory; reject on read-fail /
//            truncate / empty; prove the new scope is a superset of the original
//            and covers every actual changed path.
//   Phase 2  resolve the delivery commit (package-or-recover) — OUTSIDE the
//            transcript lock (contract #5). Deterministic: same inputs ⇒ same
//            commit.
//   Phase 3  lock-scoped CAS append of delivery_created + recovery provenance
//            (run.delivery_repackaged). Yields to an existing created event — so
//            a retry/competitor never creates a second commit or overwrites.
//   Phase 4  verify the delivery — OUTSIDE the transcript lock (reuses the
//            ORIGINAL verification config).
//   Phase 5  lock-scoped CAS append of the verification outcome. Yields to an
//            existing outcome — a retry continues from the created stage without
//            re-packaging and without a second outcome.
//
// Architectural contract:
//   - No argv parsing, no console.log, no process.exit.
//   - Does not import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Depends on transcript.js, delivery.js, deliveryVerification.js,
//     candidateInventory.js, and the workspace-ownership proof modules.

import { join } from "node:path";

import {
  readTranscript,
  findState,
  findLastEventSeq,
  JsonlTranscript,
  validateDeliveryFacts,
  findValidRepackageProvenance,
  classifyRecoveryCandidate,
  TERMINAL_STATES,
  RECOVERY_CANDIDATE_KINDS,
  PROCESS_MISSING_RECOVERY_REASON,
  PROCESS_MISSING_CONFIRMED_TYPE,
} from "../transcript.js";
import {
  assertCommittedDeliveryRef,
  isValidRunId,
  isCanonicalCommitId,
  isPathAllowed,
  resolveDeliveryCommit,
  VERIFICATION_TIMEOUT_MS_MIN,
  VERIFICATION_TIMEOUT_MS_MAX,
} from "../delivery.js";
import { verifyDelivery } from "../deliveryVerification.js";
import {
  computeCandidateInventory,
  INVENTORY_PATHS_LIMIT,
} from "./candidateInventory.js";
import { validateProjectedPath } from "./deliveryReview.js";
import { verifyRunWorkspaceOwnership } from "./runWorkspaceOwnership.js";
import { proveWorkspace } from "./workspaceBinding.js";
import { proveProcessMissing } from "./processRecovery.js";

const REPACKAGE_VERIFICATION_OUTCOME_TYPES = new Set([
  "run.delivery_verification_passed",
  "run.delivery_verification_failed",
  "run.delivery_verification_unavailable",
]);

export const REPACKAGE_ALLOWED_PATHS_LIMIT = INVENTORY_PATHS_LIMIT;

/**
 * Normalize + validate a Lead-supplied allowedPaths array to a sorted, deduped,
 * forward-slash repo-relative list. Throws on any malformed entry — never
 * silently rewrites. Reuses the SSOT path validator (isValidRepoRelativePath).
 * @param {string[]} allowedPaths
 * @returns {string[]}
 */
function _normalizeAllowedPaths(allowedPaths) {
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) {
    throw new Error("runDeliveryRepackage: allowedPaths must be a non-empty array");
  }
  if (allowedPaths.length > REPACKAGE_ALLOWED_PATHS_LIMIT) {
    throw new Error(`runDeliveryRepackage: allowedPaths exceeds ${REPACKAGE_ALLOWED_PATHS_LIMIT}`);
  }
  return [...new Set(allowedPaths.map((p) => validateProjectedPath(p)))].sort();
}

/**
 * M12-13: validate the ORIGINAL per-command execution timeout persisted on
 * run.started.delivery.verificationTimeoutMs. Absent (undefined) → returns
 * undefined (zero drift: the verifier's consumer default applies). Present but
 * malformed — null / non-number / non-integer / outside the SHARED bounds —
 * throws BEFORE any inventory read, Git packaging, transcript append, or
 * verification: a corrupt persisted value is never silently defaulted and never
 * widened (fail closed).
 *
 * Reuses the SAME shared bounds as prepareDeliveryRequest (the wire SSOT) and
 * the reverify resolver (REVERIFY_TIMEOUT_MS_*, aliases of these constants), so
 * the repackage cannot drift on what a valid per-command budget is.
 * @param {unknown} value — delivery.verificationTimeoutMs
 * @returns {number|undefined} validated integer ms, or undefined when absent
 */
function _validateVerificationTimeoutMs(value) {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < VERIFICATION_TIMEOUT_MS_MIN
    || value > VERIFICATION_TIMEOUT_MS_MAX
  ) {
    throw new Error(
      `runDeliveryRepackage: persisted verificationTimeoutMs must be an integer in [${VERIFICATION_TIMEOUT_MS_MIN}, ${VERIFICATION_TIMEOUT_MS_MAX}]`,
    );
  }
  return value;
}

/** Newest bound event matching predicate, or null. */
function _findBoundEvent(events, runId, predicate) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e && e.runId === runId && predicate(e)) return e;
  }
  return null;
}

function _deliveryWasRequested(events, runId) {
  return events.some(
    (e) => e && e.runId === runId && (
      (e.type === "run.background_submitted" && e.deliveryRequested === true)
      || (e.type === "run.started" && e.delivery && typeof e.delivery.mode === "string" && e.delivery.mode.length > 0)
    ),
  );
}

/**
 * M12-19: prove the FULL process_missing precondition set BEFORE any durable
 * mutation. Throws on any failure — the transcript and worktree are untouched on
 * a throw (the caller has not yet transitioned state or packaged Git).
 *
 * Proves, in order: workspace ownership; runtime liveness (the detached
 * runner/provider process is provably gone); the original run.started contract;
 * that the Lead's new scope includes the ORIGINAL allowedPaths (no narrowing);
 * and a FULL non-empty untruncated candidate inventory whose every actual
 * changed path is covered by the Lead's new scope. The runtime liveness probes
 * default to the real ownerLease/PID probe; tests inject deterministic fakes.
 *
 * @param {object} opts
 * @private
 */
function _proveProcessMissingEligibility({
  events,
  runId,
  runDir,
  authorizedWorkspaceRoot,
  newAllowedPaths,
  computeInventoryFn,
  nowFn,
  isAliveFn,
  ownerLeaseReader,
}) {
  if (typeof authorizedWorkspaceRoot !== "string" || authorizedWorkspaceRoot.length === 0) {
    throw new Error("runDeliveryRepackage: authorizedWorkspaceRoot is required");
  }
  verifyRunWorkspaceOwnership(events, authorizedWorkspaceRoot, runId);

  const livenessDeps = {
    runDir,
    now: typeof nowFn === "function" ? nowFn() : Date.now(),
    ...(typeof isAliveFn === "function" ? { isAliveFn } : {}),
    ...(typeof ownerLeaseReader === "function" ? { ownerLeaseReader } : {}),
  };
  if (proveProcessMissing(events, runId, livenessDeps).eligible !== true) {
    throw new Error("runDeliveryRepackage: process_missing liveness proof failed");
  }

  const started = events.filter((e) => e && e.type === "run.started" && e.runId === runId);
  if (started.length !== 1) {
    throw new Error("runDeliveryRepackage: expected exactly one bound run.started");
  }
  const bound = started[0];
  const delivery = bound.delivery;
  if (
    !delivery || typeof delivery !== "object"
    || !isCanonicalCommitId(delivery.baseCommit)
    || !Array.isArray(delivery.allowedPaths) || delivery.allowedPaths.length === 0
    || typeof bound.worktreePath !== "string" || bound.worktreePath.length === 0
  ) {
    throw new Error("runDeliveryRepackage: run.started delivery contract is malformed");
  }
  const originalAllowedPaths = _normalizeAllowedPaths(delivery.allowedPaths);
  // The Lead may widen but never narrow the original contract.
  for (const orig of originalAllowedPaths) {
    if (!isPathAllowed(orig, newAllowedPaths)) {
      throw new Error("runDeliveryRepackage: new allowedPaths must include the original allowedPaths");
    }
  }

  // FULL non-empty untruncated inventory + coverage of every actual changed path.
  const inventory = computeInventoryFn(bound.worktreePath, delivery.baseCommit, originalAllowedPaths);
  if (!inventory) {
    throw new Error("runDeliveryRepackage: candidate inventory unavailable (read failed)");
  }
  if (
    inventory.actualChangedTruncated
    || inventory.originalAllowedTruncated
    || inventory.disallowedTruncated
  ) {
    throw new Error("runDeliveryRepackage: process_missing candidate inventory is incomplete");
  }
  if (inventory.actualChangedCount === 0 || inventory.actualChangedPaths.length === 0) {
    throw new Error("runDeliveryRepackage: candidate inventory is empty");
  }
  const uncovered = inventory.actualChangedPaths.filter((p) => !isPathAllowed(p, newAllowedPaths));
  if (uncovered.length > 0) {
    throw new Error("runDeliveryRepackage: new allowedPaths do not cover actual changed paths");
  }
}

/**
 * M12-19: settle a NONTERMINAL process_missing orphan with first-terminal-wins.
 *
 * Pre-conditions to enter this path: no existing delivery_created, and the run's
 * authoritative state is NONTERMINAL (terminal runs and idempotent retries are
 * handled by Phase 0). Proves the full precondition set (fail closed BEFORE any
 * mutation), then atomically transitions the orphan to failed carrying the
 * closed-set process_missing reason AND a safe confirmation fact (one
 * appendFile batch, under the cross-process append lock). Re-reads the
 * authoritative events afterward.
 *
 * Race semantics:
 *   - This caller wins the terminal → returns the authoritative (now terminal
 *     process_missing) events.
 *   - A concurrent caller won the terminal → the transition is rejected and only
 *     an audit event is written. This caller proceeds ONLY when the
 *     authoritative terminal facts are independently eligible under an existing
 *     recovery kind (disallowed_scope/backend_failed/process_missing); otherwise
 *     it rejects WITHOUT Git packaging.
 *
 * @param {object} opts
 * @returns {Promise<object[]>} the authoritative events to feed Phase 0
 * @private
 */
async function _settleProcessMissingOrphan({
  events,
  runId,
  runDir,
  authorizedWorkspaceRoot,
  newAllowedPaths,
  computeInventoryFn,
  readTranscriptFn,
  transcriptFactory,
  filePath,
  nowFn,
  isAliveFn,
  ownerLeaseReader,
}) {
  const existingCreated = _findBoundEvent(events, runId, (e) => e.type === "run.delivery_created");
  if (existingCreated) return events;

  const boundState = findState(events.filter((e) => e && e.runId === runId));
  if (TERMINAL_STATES.includes(boundState)) return events;

  // M12-19 correction: a pre-existing bound confirmation fact in a NONTERMINAL
  // run is an inconsistent durable record — the safe confirmation is only ever
  // written ATOMICALLY with the terminal transition, so a nonterminal run
  // carrying one is already recovered (or its record is corrupt). Fail closed
  // BEFORE any mutation: never re-confirm or re-transition an already-recovered
  // orphan, never package on an ambiguous durable record.
  if (events.some((e) => e && e.runId === runId && e.type === PROCESS_MISSING_CONFIRMED_TYPE)) {
    throw new Error("runDeliveryRepackage: run.process_missing_confirmed already exists for this run");
  }

  // Prove the full precondition set BEFORE mutation. A throw leaves the
  // transcript and worktree byte-identical (no state change, no Git op).
  _proveProcessMissingEligibility({
    events,
    runId,
    runDir,
    authorizedWorkspaceRoot,
    newAllowedPaths,
    computeInventoryFn,
    nowFn,
    isAliveFn,
    ownerLeaseReader,
  });

  const context = {
    runId,
    agentId: events[0]?.agentId ?? "unknown",
    initialSeq: findLastEventSeq(events),
  };
  const transcript = transcriptFactory
    ? await transcriptFactory(filePath, context)
    : new JsonlTranscript(filePath, context);
  const termResult = await transcript.transitionState(
    boundState,
    "failed",
    PROCESS_MISSING_RECOVERY_REASON,
    { factEvents: [{ type: PROCESS_MISSING_CONFIRMED_TYPE, payload: {} }] },
  );

  const authoritativeEvents = await readTranscriptFn(filePath);
  if (termResult.accepted) {
    return authoritativeEvents;
  }
  // A concurrent terminal won. Admit ONLY an independently eligible recovery
  // kind; anything else (completed/aborted/timed_out/unknown) rejects without
  // touching Git.
  const authoritativeKind = classifyRecoveryCandidate(authoritativeEvents, runId);
  if (!RECOVERY_CANDIDATE_KINDS.includes(authoritativeKind)) {
    throw new Error("runDeliveryRepackage: a concurrent terminal state is not recovery-eligible");
  }
  return authoritativeEvents;
}

/**
 * Prove the repackage preconditions from the transcript. Fail-closed: any
 * violation throws BEFORE any Git read or transcript append. Returns the
 * reconstructed ORIGINAL delivery context (worktreePath / baseCommit /
 * originalAllowedPaths / verification declaration) that the repackage reuses.
 *
 * @param {object[]} events
 * @param {string} runId
 * @param {string} authorizedWorkspaceRoot
 * @returns {{worktreePath, baseCommit, originalAllowedPaths, verificationCommands?: string[], verificationUnavailableReason?: string, verificationSetupCommands?: string[]}}
 */
function _proveRepackagePreconditions(events, runId, authorizedWorkspaceRoot, hasCreated) {
  // Workspace ownership — the run must belong to the authorized workspace.
  if (typeof authorizedWorkspaceRoot !== "string" || authorizedWorkspaceRoot.length === 0) {
    throw new Error("runDeliveryRepackage: authorizedWorkspaceRoot is required");
  }
  verifyRunWorkspaceOwnership(events, authorizedWorkspaceRoot, runId);

  // Terminal state must be failed (the retained failure).
  const terminalState = findState(events.filter((e) => e && e.runId === runId));
  if (terminalState !== "failed") {
    throw new Error(`runDeliveryRepackage: run terminal state is ${terminalState}, must be failed`);
  }

  const recoveryKind = classifyRecoveryCandidate(events, runId);
  if (!recoveryKind) {
    throw new Error("runDeliveryRepackage: durable recovery facts are not eligible");
  }

  // No existing decision — once the Lead decided, repackage is not allowed.
  const decision = events.find(
    (e) => e && (e.type === "run.delivery_accepted" || e.type === "run.delivery_rejected") && e.runId === runId,
  );
  if (decision) {
    throw new Error("runDeliveryRepackage: a decision already exists for this run");
  }

  // Original delivery must have been requested.
  if (!_deliveryWasRequested(events, runId)) {
    throw new Error("runDeliveryRepackage: original delivery was not requested");
  }

  // Exactly one bound run.started with a usable delivery context + worktreePath.
  const started = events.filter((e) => e && e.type === "run.started" && e.runId === runId);
  if (started.length !== 1) {
    throw new Error(`runDeliveryRepackage: expected exactly one bound run.started, got ${started.length}`);
  }
  const bound = started[0];
  const delivery = bound.delivery;
  if (!delivery || typeof delivery !== "object") {
    throw new Error("runDeliveryRepackage: run.started has no delivery context");
  }
  if (!isCanonicalCommitId(delivery.baseCommit)) {
    throw new Error("runDeliveryRepackage: run.started delivery.baseCommit is not canonical");
  }
  if (!Array.isArray(delivery.allowedPaths) || delivery.allowedPaths.length === 0) {
    throw new Error("runDeliveryRepackage: run.started has no original allowedPaths");
  }
  if (typeof bound.worktreePath !== "string" || bound.worktreePath.length === 0) {
    throw new Error("runDeliveryRepackage: run.started has no worktreePath");
  }
  // ORIGINAL verification declaration must be present (commands or reason).
  const hasCommands = Array.isArray(delivery.verificationCommands) && delivery.verificationCommands.length > 0
    && delivery.verificationCommands.every((c) => typeof c === "string" && c.trim().length > 0);
  const hasReason = typeof delivery.verificationUnavailableReason === "string"
    && delivery.verificationUnavailableReason.trim().length > 0;
  if (!hasCommands && !hasReason) {
    throw new Error("runDeliveryRepackage: run.started has no original verification declaration");
  }
  // M12-6 (FR-05): reuse the ORIGINAL setup commands too, so a repackaged
  // DeliveryRef preserves the Lead-declared environment contract (otherwise
  // setup would be silently dropped on disallowed_path/backend_failed recovery).
  const hasSetup = Array.isArray(delivery.verificationSetupCommands)
    && delivery.verificationSetupCommands.length > 0
    && delivery.verificationSetupCommands.every((c) => typeof c === "string" && c.trim().length > 0);
  // M12-13: validate the ORIGINAL per-command execution budget persisted on
  // run.started BEFORE any inventory read, Git packaging, transcript append, or
  // verification. Absent → undefined (the verifier's consumer default applies);
  // present-but-malformed/out-of-range → fail closed (never defaulted, never
  // widened). Preserved through reconstruction, the repackage-created ref, and
  // the exact verifier call so a Lead-declared long budget does not drift to the
  // 300000 default.
  const verificationTimeoutMs = _validateVerificationTimeoutMs(delivery.verificationTimeoutMs);
  // The persisted worktreePath must be a real Git worktree top-level (defense).
  // Before the first backend-failure recovery, HEAD must still be the exact
  // original base. After delivery_created exists, idempotent re-entry is bound
  // by the committed DeliveryRef + provenance instead.
  const workspaceProof = proveWorkspace(bound.worktreePath);
  if (
    (recoveryKind === "backend_failed" || recoveryKind === "process_missing")
    && !hasCreated
    && workspaceProof.gitHead !== delivery.baseCommit
  ) {
    throw new Error("runDeliveryRepackage: candidate HEAD does not match the original base");
  }

  const originalAllowedPaths = _normalizeAllowedPaths(delivery.allowedPaths);
  return {
    worktreePath: bound.worktreePath,
    baseCommit: delivery.baseCommit,
    originalAllowedPaths,
    recoveryKind,
    ...(hasCommands ? { verificationCommands: [...delivery.verificationCommands] } : {}),
    ...(hasReason ? { verificationUnavailableReason: delivery.verificationUnavailableReason } : {}),
    ...(hasSetup ? { verificationSetupCommands: [...delivery.verificationSetupCommands] } : {}),
    ...(verificationTimeoutMs !== undefined ? { verificationTimeoutMs } : {}),
  };
}

/**
 * Repackage a retained disallowed_path failure into an auditable delivery.
 *
 * @param {object} input
 * @param {string} input.runId — must pass isValidRunId
 * @param {string} input.runDir — runs/ directory (host-owned)
 * @param {string[]} input.allowedPaths — the Lead's NEW approved scope (must
 *   include the ORIGINAL allowedPaths and cover every actual changed path)
 * @param {string} input.authorizedWorkspaceRoot — MCP workspace binding
 * @param {Function} [input.resolveDeliveryCommitFn] — injectable (default resolveDeliveryCommit)
 * @param {Function} [input.verifyDeliveryFn] — injectable (default verifyDelivery)
 * @param {Function} [input.computeInventoryFn] — injectable (default computeCandidateInventory)
 * @param {Function} [input.readTranscriptFn] — injectable for testing
 * @param {Function} [input.transcriptFactory] — injectable async (filePath, context) => transcript
 * @param {Function} [input.nowFn] — M12-19: injectable clock for the process_missing liveness proof
 * @param {Function} [input.isAliveFn] — M12-19: injectable conservative PID probe
 * @param {Function} [input.ownerLeaseReader] — M12-19: injectable owner-lease reader
 * @returns {Promise<{runId, deliveryCommit, verificationStatus, outcome, source, created, verificationRecorded}>}
 * @throws {Error} on any precondition / scope / inventory / packaging / proof failure
 */
export async function runDeliveryRepackage({
  runId,
  runDir,
  allowedPaths,
  authorizedWorkspaceRoot,
  resolveDeliveryCommitFn,
  verifyDeliveryFn,
  computeInventoryFn,
  readTranscriptFn,
  transcriptFactory,
  nowFn,
  isAliveFn,
  ownerLeaseReader,
}) {
  if (!runId || typeof runId !== "string") throw new Error("runDeliveryRepackage: runId is required");
  if (!runDir || typeof runDir !== "string") throw new Error("runDeliveryRepackage: runDir is required");
  if (!isValidRunId(runId)) throw new Error(`Invalid runId: ${JSON.stringify(runId)}`);

  // Validate + normalize the Lead's new scope BEFORE any read (fail closed).
  const newAllowedPaths = _normalizeAllowedPaths(allowedPaths);

  const _readTranscript = readTranscriptFn ?? readTranscript;
  const _resolve = resolveDeliveryCommitFn ?? resolveDeliveryCommit;
  const _verify = verifyDeliveryFn ?? verifyDelivery;
  const _inventory = computeInventoryFn ?? computeCandidateInventory;

  const filePath = join(runDir, `${runId}.jsonl`);
  let events = await _readTranscript(filePath);

  // Idempotency pre-read: an existing created/outcome lets us skip the expensive
  // package/verify steps. The lock-scoped CAS methods re-check authoritatively.
  const existingCreated = _findBoundEvent(events, runId, (e) => e.type === "run.delivery_created");
  const existingOutcome = _findBoundEvent(events, runId, (e) => REPACKAGE_VERIFICATION_OUTCOME_TYPES.has(e.type));
  const createdEvents = events.filter(
    (e) => e && e.type === "run.delivery_created" && e.runId === runId,
  );
  const outcomeEvents = events.filter(
    (e) => e && REPACKAGE_VERIFICATION_OUTCOME_TYPES.has(e.type) && e.runId === runId,
  );
  const provenanceEvents = events.filter(
    (e) => e && e.type === "run.delivery_repackaged" && e.runId === runId,
  );
  if (createdEvents.length > 1 || outcomeEvents.length > 1) {
    throw new Error("runDeliveryRepackage: ambiguous durable delivery chain");
  }
  if (outcomeEvents.length > 0 && createdEvents.length === 0) {
    throw new Error("runDeliveryRepackage: orphan verification outcome");
  }
  if (provenanceEvents.length > 1 || (provenanceEvents.length > 0 && createdEvents.length === 0)) {
    throw new Error("runDeliveryRepackage: orphan or ambiguous recovery provenance");
  }

  // Phase -1 (M12-19): process_missing orphan settlement. When the run is a
  // NONTERMINAL orphan whose detached runner/provider process is provably gone,
  // prove the FULL precondition set (workspace + liveness + contract + inventory
  // + coverage) BEFORE any mutation, then first-terminal-wins transition to
  // failed with a safe confirmation fact, and re-read authoritative facts. A
  // concurrent terminal winner is admitted only if it is independently eligible
  // under an existing recovery kind. Terminal/existing-created runs pass through
  // unchanged (Phase 0 handles them).
  events = await _settleProcessMissingOrphan({
    events,
    runId,
    runDir,
    authorizedWorkspaceRoot,
    newAllowedPaths,
    computeInventoryFn: _inventory,
    readTranscriptFn: _readTranscript,
    transcriptFactory,
    filePath,
    nowFn,
    isAliveFn,
    ownerLeaseReader,
  });

  // Phase 0: preconditions.
  const original = _proveRepackagePreconditions(
    events,
    runId,
    authorizedWorkspaceRoot,
    existingCreated !== null,
  );

  // The Lead may widen but never narrow the original contract, including on
  // idempotent retries after a delivery has already been created.
  for (const orig of original.originalAllowedPaths) {
    if (!isPathAllowed(orig, newAllowedPaths)) {
      throw new Error("runDeliveryRepackage: new allowedPaths must include the original allowedPaths");
    }
  }

  // Phase 1: recompute the FULL candidate inventory (NEW scope is validated below,
  // but the inventory is computed vs the ORIGINAL contract to surface every
  // actual changed path). Reject on read-fail / truncate / empty.
  if (!existingCreated) {
    const inventory = await _inventory(original.worktreePath, original.baseCommit, original.originalAllowedPaths);
    if (!inventory) {
      throw new Error("runDeliveryRepackage: candidate inventory unavailable (read failed)");
    }
    if (inventory.actualChangedTruncated) {
      throw new Error("runDeliveryRepackage: candidate inventory truncated — verify manually");
    }
    if (
      (original.recoveryKind === "backend_failed" || original.recoveryKind === "process_missing")
      && (
        inventory.originalAllowedTruncated
        || inventory.disallowedTruncated
      )
    ) {
      throw new Error("runDeliveryRepackage: candidate inventory is incomplete");
    }
    if (inventory.actualChangedCount === 0 || inventory.actualChangedPaths.length === 0) {
      throw new Error("runDeliveryRepackage: candidate inventory is empty");
    }
    // The Lead's scope must COVER every actual changed path.
    const uncovered = inventory.actualChangedPaths.filter((p) => !isPathAllowed(p, newAllowedPaths));
    if (uncovered.length > 0) {
      throw new Error(
        `runDeliveryRepackage: new allowedPaths do not cover actual changed paths: ${uncovered.join(", ")}`,
      );
    }
  }

  // Phase 2: resolve the delivery commit — package-or-recover, OUTSIDE the lock.
  // Skipped when a created event already exists (idempotent retry).
  let resolvedRef;
  let source;
  if (existingCreated) {
    resolvedRef = existingCreated.delivery;
    const provenance = findValidRepackageProvenance(events, runId, resolvedRef);
    if (!provenance) {
      throw new Error("runDeliveryRepackage: existing recovery provenance is invalid");
    }
    if (resolvedRef.changedFiles.some((p) => !isPathAllowed(p, newAllowedPaths))) {
      throw new Error("runDeliveryRepackage: new allowedPaths do not cover the existing delivery");
    }
    assertCommittedDeliveryRef(resolvedRef);
    source = provenance.source;
  } else {
    const deliveryCtx = {
      runId,
      worktreePath: original.worktreePath,
      baseCommit: original.baseCommit,
      isolation: { type: "worktree", strategy: "persistent" },
      allowedPaths: newAllowedPaths,
      ...(original.verificationCommands ? { verificationCommands: original.verificationCommands } : {}),
      ...(original.verificationUnavailableReason
        ? { verificationUnavailableReason: original.verificationUnavailableReason }
        : {}),
      ...(original.verificationSetupCommands
        ? { verificationSetupCommands: original.verificationSetupCommands }
        : {}),
      ...(original.verificationTimeoutMs !== undefined
        ? { verificationTimeoutMs: original.verificationTimeoutMs }
        : {}),
    };
    const resolved = await _resolve(deliveryCtx);
    resolvedRef = resolved.ref;
    source = resolved.source;
  }

  // Phase 3: lock-scoped CAS append of created + provenance. Yields to an
  // existing created event (retry / competing request) — no second commit.
  const context = {
    runId,
    agentId: events[0]?.agentId ?? "unknown",
    initialSeq: findLastEventSeq(events),
  };
  const transcript = transcriptFactory
    ? await transcriptFactory(filePath, context)
    : new JsonlTranscript(filePath, context);
  const createdResult = await transcript.tryAppendRepackageCreated({
    delivery: resolvedRef,
    approvedAllowedPaths: newAllowedPaths,
    source,
    recoveryKind: original.recoveryKind,
  });
  const authoritativeRef = createdResult.ref;
  const authoritativeSource = createdResult.provenance?.source ?? source;
  const authoritativeRecoveryKind = createdResult.provenance?.recoveryKind
    ?? original.recoveryKind;

  // Phase 4 + 5: verify (outside the lock) and record the outcome (lock-scoped
  // CAS). Skipped when an outcome already exists (idempotent retry).
  if (existingOutcome) {
    const facts = validateDeliveryFacts(events);
    if (!facts.valid || facts.deliveryCommit !== authoritativeRef.deliveryCommit) {
      throw new Error("runDeliveryRepackage: existing verification outcome is not bound to the delivery");
    }
    return {
      runId,
      deliveryCommit: authoritativeRef.deliveryCommit,
      verificationStatus: _outcomeFromEventType(existingOutcome.type),
      outcome: _outcomeFromEventType(existingOutcome.type),
      source: authoritativeSource,
      recoveryKind: authoritativeRecoveryKind,
      created: createdResult.created,
      verificationRecorded: false,
    };
  }

  const verifyResult = await _verify(
    authoritativeRef,
    // M12-13: supply the ORIGINAL declared per-command budget as the authoritative
    // timeout. Absent → no timeoutMs key (verifyDelivery applies its consumer
    // default), preserving zero drift. Idempotent existing-created paths remain
    // bound to authoritativeRef; only the budget opts differ by presence.
    original.verificationTimeoutMs !== undefined
      ? { timeoutMs: original.verificationTimeoutMs }
      : {},
  );
  const verificationResult = await transcript.tryAppendRepackageVerification({
    delivery: verifyResult.delivery,
    outcome: verifyResult.outcome,
  });

  return {
    runId,
    deliveryCommit: authoritativeRef.deliveryCommit,
    verificationStatus: verificationResult.outcome,
    outcome: verificationResult.outcome,
    source: authoritativeSource,
    recoveryKind: authoritativeRecoveryKind,
    created: createdResult.created,
    verificationRecorded: verificationResult.recorded,
  };
}

function _outcomeFromEventType(type) {
  if (type === "run.delivery_verification_passed") return "passed";
  if (type === "run.delivery_verification_failed") return "failed";
  if (type === "run.delivery_verification_unavailable") return "unavailable";
  return "pending";
}
