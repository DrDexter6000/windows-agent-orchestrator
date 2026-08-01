// src/application/runDeliveryReverify.js
//
// M12-6 Package 3B: audited unchanged-artifact delivery re-verification.
//
// After a delivery's ORIGINAL verification FAILED with an environment/tooling-
// invalid code (command_failed/command_timeout/execution_error/setup_failed/
// setup_timeout/setup_environment_error), a Lead may request ONE audited
// re-verification of the SAME immutable DeliveryRef. The Lead may ADD only setup
// commands; the ORIGINAL assertion commands are re-run BYTE-FOR-BYTE against the
// EXACT same delivery commit. No model is called. No worker is resumed. No
// assertion command is replaced. Nothing is auto accepted/rejected.
//
// This is an EXCEPTIONAL Lead-declared recovery — NOT a retry, NOT command
// replacement, NOT automatic acceptance. The reason records WHY the original
// failure is treated as environment/tooling-invalid.
//
// Phased, reentrant, crash-recovery- and concurrency-safe state machine:
//   Phase 0  read transcript + prove preconditions (workspace-bound, exactly one
//            usable delivery_created, exactly one original FAILED verification
//            outcome with an eligible code, no Lead decision, original assertion
//            commands present). Fail-closed BEFORE any verify/append.
//   Phase 1  lock-scoped CAS append of run.delivery_reverification_requested.
//            Yields to an existing request — a retry/competitor converges on the
//            FIRST caller's recorded setup (deterministic verification).
//   Phase 2  verify — OUTSIDE the transcript lock (contract #5). Reuses the
//            ORIGINAL assertion commands byte-for-byte + the RECORDED new setup
//            (the only thing the Lead may change), against the EXACT same
//            immutable delivery commit.
//   Phase 3  lock-scoped CAS append of the outcome (passed/failed/unavailable).
//            Yields to an existing outcome — a retry resumes after a crash
//            between request and outcome without a second outcome.
//
// Architectural contract:
//   - No argv parsing, no console.log, no process.exit.
//   - Does not import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Depends on transcript.js, delivery.js, deliveryVerification.js, and the
//     workspace-ownership proof module.
//   - Never echoes command text, paths, stderr, secrets, or raw errors in its
//     safe result.

import { join } from "node:path";

import {
  readTranscript,
  findLastEventSeq,
  JsonlTranscript,
  validateDeliveryFacts,
  projectReverifyChain,
  REVERIFY_REASONS,
  REVERIFY_FAILURE_CODES,
  REVERIFY_SETUP_COMMANDS_LIMIT,
  REVERIFY_SETUP_COMMAND_MAX_LENGTH,
  REVERIFY_TIMEOUT_MS_MIN,
  REVERIFY_TIMEOUT_MS_MAX,
  REVERIFY_TIMEOUT_MS_DEFAULT,
} from "../transcript.js";
import { isValidRunId } from "../delivery.js";
import { verifyDelivery } from "../deliveryVerification.js";
import { verifyRunWorkspaceOwnership } from "./runWorkspaceOwnership.js";

export {
  REVERIFY_REASONS,
  REVERIFY_SETUP_COMMANDS_LIMIT,
  REVERIFY_SETUP_COMMAND_MAX_LENGTH,
  REVERIFY_TIMEOUT_MS_MIN,
  REVERIFY_TIMEOUT_MS_MAX,
  REVERIFY_TIMEOUT_MS_DEFAULT,
};

// The original verification outcome types (distinct from the reverify outcome
// types). Used to locate the ORIGINAL failure code that governs eligibility.
const ORIGINAL_VERIFICATION_OUTCOME_TYPES = new Set([
  "run.delivery_verification_passed",
  "run.delivery_verification_failed",
  "run.delivery_verification_unavailable",
]);

// Eligible original verification failure codes — environment/tooling-invalid
// failures a Lead may declare an exceptional reverify for. NEVER includes
// artifact_mutated/artifact_mismatch (content-integrity failures) — those are
// not recoverable by re-running the SAME immutable artifact.
const ELIGIBLE_REVERIFY_FAILURE_CODES = new Set([
  "command_failed",
  "command_timeout",
  "execution_error",
  "setup_failed",
  "setup_timeout",
  "setup_environment_error",
]);

// The safe-result echo reuses REVERIFY_FAILURE_CODES — the SINGLE closed set of
// verification failure codes, shared with the transcript CAS projection/append
// gate (no second allowlist). Every code verifyDelivery can produce for a failed
// reverify, plus artifact_mutated (priority content-integrity code).
// artifact_mismatch is a thrown pre-check, never a reverify outcome. Unknown
// values are dropped (never echoed).

/**
 * Normalize + bound the optional reverify setupCommands. Each command is a
 * non-empty bounded string (trimmed); the list length is capped. setupCommands
 * is the ONLY thing a Lead may add on a reverify.
 * @param {string[]|undefined} setupCommands
 * @returns {string[]}
 */
function _normalizeSetup(setupCommands) {
  if (setupCommands === undefined || setupCommands === null) return [];
  if (!Array.isArray(setupCommands)) {
    throw new Error("runDeliveryReverify: setupCommands must be an array");
  }
  if (setupCommands.length > REVERIFY_SETUP_COMMANDS_LIMIT) {
    throw new Error(`runDeliveryReverify: setupCommands exceeds ${REVERIFY_SETUP_COMMANDS_LIMIT}`);
  }
  const out = [];
  for (const cmd of setupCommands) {
    if (typeof cmd !== "string") {
      throw new Error("runDeliveryReverify: setupCommands must be strings");
    }
    const trimmed = cmd.trim();
    if (trimmed.length === 0) {
      throw new Error("runDeliveryReverify: setupCommands must be non-empty");
    }
    if (trimmed.length > REVERIFY_SETUP_COMMAND_MAX_LENGTH) {
      throw new Error(`runDeliveryReverify: setupCommand exceeds ${REVERIFY_SETUP_COMMAND_MAX_LENGTH} characters`);
    }
    out.push(trimmed);
  }
  return out;
}

/**
 * Validate the optional timeoutMs: an integer in [MIN, MAX]. Defaults when
 * omitted. Rejects negative / zero / fractional / out-of-range values.
 * @param {number|undefined} timeoutMs
 * @returns {number}
 */
function _validateTimeout(timeoutMs) {
  if (timeoutMs === undefined || timeoutMs === null) return REVERIFY_TIMEOUT_MS_DEFAULT;
  if (
    typeof timeoutMs !== "number"
    || !Number.isInteger(timeoutMs)
    || timeoutMs < REVERIFY_TIMEOUT_MS_MIN
    || timeoutMs > REVERIFY_TIMEOUT_MS_MAX
  ) {
    throw new Error(
      `runDeliveryReverify: timeoutMs must be an integer in [${REVERIFY_TIMEOUT_MS_MIN}, ${REVERIFY_TIMEOUT_MS_MAX}]`,
    );
  }
  return timeoutMs;
}

/**
 * Prove the reverify preconditions from the transcript. Fail-closed: any
 * violation throws BEFORE any Git read or transcript append (contract: the
 * verifier never executes for an ineligible original). Returns the created
 * DeliveryRef + the ORIGINAL assertion commands that govern the reverify.
 *
 * @param {object[]} events
 * @param {string} runId
 * @param {string} authorizedWorkspaceRoot
 * @returns {{createdRef: object, originalCommands: string[]}}
 */
function _proveReverifyPreconditions(events, runId, authorizedWorkspaceRoot) {
  // Workspace ownership — the run must belong to the authorized workspace.
  if (typeof authorizedWorkspaceRoot !== "string" || authorizedWorkspaceRoot.length === 0) {
    throw new Error("runDeliveryReverify: authorizedWorkspaceRoot is required");
  }
  verifyRunWorkspaceOwnership(events, authorizedWorkspaceRoot);

  // No existing decision — once the Lead decided, reverify is not allowed.
  const decision = events.find(
    (e) => e && (e.type === "run.delivery_accepted" || e.type === "run.delivery_rejected") && e.runId === runId,
  );
  if (decision) {
    throw new Error("runDeliveryReverify: a decision already exists for this run");
  }

  // validateDeliveryFacts: single owner of delivery facts — exactly one usable
  // delivery_created + exactly one original verification outcome, identity match,
  // canonical commits. Reuses the SAME validator as tryAppendDecision.
  const facts = validateDeliveryFacts(events);
  if (!facts.valid) {
    throw new Error(`runDeliveryReverify: ${facts.error}`);
  }
  if (facts.decisionEvent) {
    throw new Error("runDeliveryReverify: a decision already exists for this run");
  }

  // The ORIGINAL verification outcome must be FAILED.
  if (facts.verificationStatus !== "failed") {
    throw new Error(
      `runDeliveryReverify: original verification is ${facts.verificationStatus}, must be failed to reverify`,
    );
  }

  // The ORIGINAL failure code must be eligible (environment/tooling-invalid).
  const originalOutcome = events.find(
    (e) => e && ORIGINAL_VERIFICATION_OUTCOME_TYPES.has(e.type) && e.runId === runId,
  );
  const originalFailureCode = originalOutcome?.delivery?.verification?.failureCode;
  if (!ELIGIBLE_REVERIFY_FAILURE_CODES.has(originalFailureCode)) {
    throw new Error(
      `runDeliveryReverify: original failure code is not eligible for reverify`,
    );
  }

  // The ORIGINAL assertion commands are the immutable verification authority.
  const createdRef = facts.createdRef;
  const commands = createdRef?.verification?.commands;
  if (
    !Array.isArray(commands)
    || commands.length === 0
    || !commands.every((c) => typeof c === "string" && c.length > 0)
  ) {
    throw new Error("runDeliveryReverify: delivery_created has no original assertion commands");
  }

  return { createdRef, originalCommands: [...commands] };
}

/**
 * Request + execute one audited re-verification of an unchanged delivery.
 *
 * @param {object} input
 * @param {string} input.runId — must pass isValidRunId
 * @param {string} input.runDir — runs/ directory (host-owned)
 * @param {string} input.authorizedWorkspaceRoot — MCP workspace binding
 * @param {string} input.reason — closed-set reverify reason
 * @param {string[]} [input.setupCommands] — optional new setup (original assertions unchanged)
 * @param {number} [input.timeoutMs] — optional bounded integer
 * @param {Function} [input.verifyDeliveryFn] — injectable (default verifyDelivery)
 * @param {Function} [input.readTranscriptFn] — injectable for testing
 * @param {Function} [input.transcriptFactory] — injectable async (filePath, context) => transcript
 * @returns {Promise<{runId, deliveryCommit, reason, state, requested, outcomeRecorded, verificationStatus, failureCode?}>}
 * @throws {Error} on any precondition / input / verification-append failure
 */
export async function runDeliveryReverify({
  runId,
  runDir,
  authorizedWorkspaceRoot,
  reason,
  setupCommands,
  timeoutMs,
  verifyDeliveryFn,
  readTranscriptFn,
  transcriptFactory,
}) {
  // ===== input validation (fail closed before any read) =====
  if (!runId || typeof runId !== "string") throw new Error("runDeliveryReverify: runId is required");
  if (!runDir || typeof runDir !== "string") throw new Error("runDeliveryReverify: runDir is required");
  if (!isValidRunId(runId)) throw new Error(`Invalid runId: ${JSON.stringify(runId)}`);
  if (!REVERIFY_REASONS.includes(reason)) {
    throw new Error(`runDeliveryReverify: reason must be one of ${REVERIFY_REASONS.join(", ")}`);
  }
  const setup = _normalizeSetup(setupCommands);
  const effectiveTimeoutMs = _validateTimeout(timeoutMs);

  const _readTranscript = readTranscriptFn ?? readTranscript;
  const _verify = verifyDeliveryFn ?? verifyDelivery;

  const filePath = join(runDir, `${runId}.jsonl`);
  const events = await _readTranscript(filePath);

  // Phase 0: preconditions (fail closed before any append/verify).
  const { createdRef, originalCommands } = _proveReverifyPreconditions(
    events,
    runId,
    authorizedWorkspaceRoot,
  );

  // M12-6 Package 3B1: the durable reverify chain must be CLEAN before this call
  // extends it. A malformed chain — a foreign-envelope reverify event, an
  // identity mismatch, or a persisted request with an unknown reason / invalid
  // setup commands — is a durable conflict: fail closed BEFORE any verifier
  // execution or transcript append. A garbage request must never reach
  // verifyDeliveryFn, and a conflict must never be extended.
  const chainBefore = projectReverifyChain(events, runId, createdRef);
  if (chainBefore.status === "malformed") {
    throw new Error("runDeliveryReverify: reverify chain is malformed — refusing to verify or extend it");
  }

  // Phase 1: lock-scoped CAS append of the requested event. Yields to an existing
  // request — a retry/competitor converges on the FIRST caller's recorded setup.
  const context = {
    runId,
    agentId: events[0]?.agentId ?? "unknown",
    initialSeq: findLastEventSeq(events),
  };
  const transcript = transcriptFactory
    ? await transcriptFactory(filePath, context)
    : new JsonlTranscript(filePath, context);
  const requestedResult = await transcript.tryAppendReverifyRequested({
    delivery: createdRef,
    reason,
    setupCommands: setup,
  });
  const requestedThisCall = requestedResult.requested;
  // The RECORDED setup governs verification (deterministic convergence on the
  // first caller's declared setup, even on a resumed/idempotent call).
  const recordedSetup = requestedResult.setupCommands;

  // Phase 2 + 3: verify (outside the lock) + record the outcome (lock-scoped CAS).
  // Idempotent short-circuit: if the chain was already COMPLETE before this call,
  // the recorded outcome is authoritative — skip re-verification.
  let effectiveOutcome;
  let effectiveFailureCode;
  let effectiveRef;
  let outcomeThisCall = false;

  if (!requestedThisCall && chainBefore.status === "complete" && chainBefore.outcomeEvent) {
    effectiveRef = chainBefore.outcomeEvent.delivery;
    effectiveOutcome = chainBefore.effectiveStatus;
    effectiveFailureCode = effectiveOutcome === "failed"
      ? effectiveRef?.verification?.failureCode
      : undefined;
  } else {
    // Build the reverify input: ORIGINAL assertion commands byte-for-byte + the
    // RECORDED new setup (the only thing the Lead may change). The delivery
    // commit, base commit, worktree, and changed files are the EXACT same
    // immutable delivery — verifyDelivery re-proves this via
    // assertCommittedDeliveryRef before/after every command.
    const reverifyInput = {
      ...createdRef,
      verification: {
        status: "pending",
        commands: [...originalCommands],
        ...(recordedSetup.length > 0 ? { setupCommands: [...recordedSetup] } : {}),
      },
    };

    const verifyResult = await _verify(reverifyInput, { timeoutMs: effectiveTimeoutMs });
    effectiveRef = verifyResult.delivery;
    effectiveOutcome = verifyResult.outcome;
    effectiveFailureCode = verifyResult.failureCode;

    const outcomeResult = await transcript.tryAppendReverifyOutcome({
      delivery: effectiveRef,
      outcome: effectiveOutcome,
    });
    outcomeThisCall = outcomeResult.recorded;
    // If a concurrent caller already recorded an outcome, the authoritative one
    // wins (deterministic — both verified the same immutable artifact + setup).
    if (!outcomeThisCall && outcomeResult.ref) {
      effectiveRef = outcomeResult.ref;
      effectiveOutcome = outcomeResult.outcome;
      effectiveFailureCode = effectiveOutcome === "failed"
        ? effectiveRef?.verification?.failureCode
        : undefined;
    }
  }

  // M12-6 Package 3B1: concurrent result-state truth. "created" requires THIS
  // call to have durably created the request AND recorded the final outcome. If
  // a concurrent caller recorded the outcome while we were verifying (verification
  // runs OUTSIDE the transcript lock, contract #5), this call is a duplicate
  // observer for the outcome — it must report idempotent, never created.
  const state = requestedThisCall && outcomeThisCall
    ? "created"
    : (outcomeThisCall ? "resumed" : "idempotent");

  // Safe result: bounded fields only — never commands, paths, stderr, secrets.
  const safeFailureCode = effectiveOutcome === "failed" && REVERIFY_FAILURE_CODES.includes(effectiveFailureCode)
    ? effectiveFailureCode
    : undefined;

  return {
    runId,
    deliveryCommit: createdRef.deliveryCommit,
    reason: requestedResult.reason,
    state,
    requested: requestedThisCall,
    outcomeRecorded: outcomeThisCall,
    verificationStatus: effectiveOutcome,
    ...(safeFailureCode ? { failureCode: safeFailureCode } : {}),
  };
}
