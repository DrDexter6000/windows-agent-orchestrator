// src/application/runDeliveryReverify.js
//
// M12-6 Package 3B: audited unchanged-artifact delivery re-verification.
//
// After a delivery's ORIGINAL verification FAILED with an environment/tooling-
// invalid code (command_failed/command_timeout/execution_error/setup_failed/
// setup_timeout/setup_environment_error), a Lead may request an audited
// re-verification of the SAME immutable DeliveryRef. A delivery carries at
// most TWO reverify chains: the first (attempt 1, the default) and — only
// after the first chain completed FAILED with one of the same eligible codes —
// one explicit second chance (attempt 2, the last; a third application is
// refused with the closed-set `reverify_attempts_exhausted`; WAO never
// auto-retries). On each attempt the Lead may ADD only setup commands; the
// ORIGINAL assertion commands are re-run BYTE-FOR-BYTE against the EXACT same
// delivery commit. No model is called. No worker is resumed. No assertion
// command is replaced. Nothing is auto accepted/rejected.
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
  pairReverifyLinks,
  REVERIFY_REASONS,
  REVERIFY_FAILURE_CODES,
  REVERIFY_SECOND_ATTEMPT_ELIGIBLE_CODES,
  REVERIFY_ATTEMPT_REJECTION_REASONS,
  REVERIFY_SETUP_COMMANDS_LIMIT,
  REVERIFY_SETUP_COMMAND_MAX_LENGTH,
  REVERIFY_TIMEOUT_MS_MIN,
  REVERIFY_TIMEOUT_MS_MAX,
  REVERIFY_TIMEOUT_MS_DEFAULT } from "../transcript.js";
import { resolveTranscriptPath } from "../projectBuckets.js";
import { isValidRunId } from "../delivery.js";
import { verifyDelivery, createCallerGate } from "../deliveryVerification.js";
import { verifyRunWorkspaceOwnership } from "./runWorkspaceOwnership.js";

export {
  REVERIFY_REASONS,
  REVERIFY_SECOND_ATTEMPT_ELIGIBLE_CODES,
  REVERIFY_ATTEMPT_REJECTION_REASONS,
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
// not recoverable by re-running the SAME immutable artifact. Same six codes as
// the second-attempt chain-shape authority: the shared
// REVERIFY_SECOND_ATTEMPT_ELIGIBLE_CODES SSOT (src/transcript.js) — no second
// allowlist here.
const ELIGIBLE_REVERIFY_FAILURE_CODES = new Set(REVERIFY_SECOND_ATTEMPT_ELIGIBLE_CODES);

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
 * Validate an EXPLICIT timeoutMs: an integer in the SHARED bounds
 * [REVERIFY_TIMEOUT_MS_MIN, REVERIFY_TIMEOUT_MS_MAX] (aliases of the per-command
 * execution bounds). Omitted (undefined/null) → undefined (the caller resolves
 * the persisted value / default). Rejects negative / zero / fractional /
 * out-of-range values BEFORE any transcript read.
 * @param {number|undefined} timeoutMs
 * @returns {number|undefined}
 */
function _validateTimeout(timeoutMs) {
  if (timeoutMs === undefined || timeoutMs === null) return undefined;
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
 * M12-13: resolve the EFFECTIVE reverify timeout (per-command execution budget).
 *   - an EXPLICIT timeoutMs wins (already validated);
 *   - when omitted, the PERSISTED budget on the created ref is authoritative:
 *     inherited when it is a valid integer in bounds, REFUSED (throw) when
 *     present-but-malformed — a corrupt persisted value is never silently
 *     defaulted (fail closed before any append/verify);
 *   - only when the field is entirely ABSENT does the shared default apply.
 * @param {number|undefined} explicitTimeoutMs
 * @param {object|null} createdRef — the delivery_created DeliveryRef
 * @returns {number}
 */
function resolveEffectiveTimeoutMs(explicitTimeoutMs, createdRef) {
  if (explicitTimeoutMs !== undefined) return explicitTimeoutMs;
  const persisted = createdRef?.verification ?? {};
  if (Object.prototype.hasOwnProperty.call(persisted, "verificationTimeoutMs")) {
    const value = persisted.verificationTimeoutMs;
    if (
      typeof value !== "number"
      || !Number.isInteger(value)
      || value < REVERIFY_TIMEOUT_MS_MIN
      || value > REVERIFY_TIMEOUT_MS_MAX
    ) {
      throw new Error(
        `runDeliveryReverify: persisted verificationTimeoutMs must be an integer in [${REVERIFY_TIMEOUT_MS_MIN}, ${REVERIFY_TIMEOUT_MS_MAX}]`,
      );
    }
    return value;
  }
  return REVERIFY_TIMEOUT_MS_DEFAULT;
}

/**
 * Normalize + validate the optional explicit reverify attempt. Omitted
 * (undefined/null) → 1 (the first chain; legacy callers see zero drift). The
 * value must be the integer 1 or 2 — an integer of 3 or more is the THIRD
 * application for a delivery capped at two chains and is refused with the
 * closed-set reason `reverify_attempts_exhausted` (WAO never auto-retries; the
 * second attempt is the last explicit chance). Anything else (0, negative,
 * fractional, non-number) is an input-shape failure. Rejected BEFORE any
 * transcript read.
 * @param {number|undefined} attempt
 * @returns {number} 1 or 2
 */
function _validateAttempt(attempt) {
  if (attempt === undefined || attempt === null) return 1;
  if (!Number.isInteger(attempt)) {
    throw new Error("runDeliveryReverify: attempt must be the integer 1 or 2");
  }
  if (attempt >= 3) {
    throw new Error(
      `runDeliveryReverify: ${REVERIFY_ATTEMPT_REJECTION_REASONS[0]} — a delivery carries at most two reverify chains and the second is the last`,
    );
  }
  if (attempt !== 1 && attempt !== 2) {
    throw new Error("runDeliveryReverify: attempt must be the integer 1 or 2");
  }
  return attempt;
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
  verifyRunWorkspaceOwnership(events, authorizedWorkspaceRoot, runId);

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
 * @param {number} [input.attempt] — explicit reverify attempt: 1 (default,
 *   omitted/null → 1, legacy zero drift) or 2 (the second and FINAL chance —
 *   requires a complete first chain that failed with an eligible code; an
 *   integer ≥ 3 is refused with the closed-set `reverify_attempts_exhausted`)
 * @param {string[]} [input.setupCommands] — optional new setup (original assertions unchanged)
 * @param {number} [input.timeoutMs] — optional per-command execution budget
 *   (bounded integer). When omitted, the persisted budget on the delivery ref
 *   is inherited (fail closed on a malformed persisted value); the shared
 *   default applies only when the field is absent.
 * @param {Function} [input.verifyDeliveryFn] — injectable (default verifyDelivery)
 * @param {Function} [input.readTranscriptFn] — injectable for testing
 * @param {Function} [input.transcriptFactory] — injectable async (filePath, context) => transcript
 * @returns {Promise<{runId, deliveryCommit, attempt, reason, state, requested, outcomeRecorded, verificationStatus, failureCode?}>}
 * @throws {Error} on any precondition / input / verification-append failure
 */
export async function runDeliveryReverify({
  runId,
  runDir,
  authorizedWorkspaceRoot,
  reason,
  attempt,
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
  const normalizedAttempt = _validateAttempt(attempt);
  const setup = _normalizeSetup(setupCommands);
  const explicitTimeoutMs = _validateTimeout(timeoutMs);

  const _readTranscript = readTranscriptFn ?? readTranscript;
  const _verify = verifyDeliveryFn ?? verifyDelivery;

  const filePath = resolveTranscriptPath(runDir, runId, { forAppend: true });
  const events = await _readTranscript(filePath);

  // Phase 0: preconditions (fail closed before any append/verify).
  const { createdRef, originalCommands } = _proveReverifyPreconditions(
    events,
    runId,
    authorizedWorkspaceRoot,
  );

  // The durable reverify chain must be CLEAN before this call extends it. A
  // malformed chain — a foreign-envelope reverify event, an identity mismatch,
  // or a persisted request with an unknown reason / invalid attempt / invalid
  // setup commands / an unqualified second attempt — is a durable conflict:
  // fail closed BEFORE any verifier execution or transcript append. A garbage
  // request must never reach verifyDeliveryFn, and a conflict must never be
  // extended.
  const pairing = pairReverifyLinks(events, runId, createdRef);
  if (!pairing.ok) {
    throw new Error("runDeliveryReverify: reverify chain is malformed — refusing to verify or extend it");
  }
  // The link THIS call targets (its attempt number). Every consumer takes the
  // LATEST chain as the current reverify truth; a call only ever converges on
  // or opens the chain of its OWN attempt — an attempt-1 (or legacy omitted)
  // call never runs a second verification.
  const targetBefore = pairing.links.find((link) => link.attempt === normalizedAttempt) ?? null;
  if (normalizedAttempt === 2 && !targetBefore) {
    const first = pairing.links[0] ?? null;
    const firstCode = first?.outcomeEvent?.delivery?.verification?.failureCode;
    if (!first
      || first.status !== "complete"
      || first.effectiveStatus !== "failed"
      || !REVERIFY_SECOND_ATTEMPT_ELIGIBLE_CODES.includes(firstCode)) {
      throw new Error(
        "runDeliveryReverify: attempt 2 requires a complete first reverify chain that FAILED with an eligible environment/tooling code (artifact_mutated / unavailable / pending / absent never qualify)",
      );
    }
  }

  // M12-13: resolve the effective per-command execution budget BEFORE any
  // transcript append — an explicit value wins; an omitted value inherits the
  // persisted budget on the created ref (fail closed on a malformed persisted
  // value); the shared default applies only when the field is absent.
  const effectiveTimeoutMs = resolveEffectiveTimeoutMs(explicitTimeoutMs, createdRef);

  // Phase 1: lock-scoped CAS append of the requested event. Yields to an existing
  // request for THIS attempt — a retry/competitor converges on the FIRST
  // caller's recorded setup.
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
    attempt: normalizedAttempt,
  });
  const requestedThisCall = requestedResult.requested;
  // The RECORDED setup governs verification (deterministic convergence on the
  // first caller's declared setup, even on a resumed/idempotent call).
  const recordedSetup = requestedResult.setupCommands;

  // Phase 2 + 3: verify (outside the lock) + record the outcome (lock-scoped CAS).
  // Idempotent short-circuit: if the TARGET attempt's chain was already
  // COMPLETE before this call, its recorded outcome is authoritative — skip
  // re-verification. The outcome CAS binds the outcome to this attempt's own
  // chain, so a late attempt-1 call can never close a second chain.
  let effectiveOutcome;
  let effectiveFailureCode;
  let effectiveRef;
  let outcomeThisCall = false;

  if (!requestedThisCall && targetBefore?.status === "complete" && targetBefore.outcomeEvent) {
    effectiveRef = targetBefore.outcomeEvent.delivery;
    effectiveOutcome = targetBefore.effectiveStatus;
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

    // R23-F/B Round B (TD-130): production reverify enters the machine gate —
    // but ONLY on the default verifier. An injected verifyDeliveryFn (every
    // existing test / internal reuse) never contends for the real lease;
    // createCallerGate folds in kill switch + HELD anti-self-lock, and null
    // keeps the opts shape byte-identical to before (zero drift).
    const gate = createCallerGate({
      usesDefaultVerifier: verifyDeliveryFn === undefined,
      identity: { owner: "runDeliveryReverify", sessionId: null, runId }, // leadSession 仅 MCP handler 层持有，service 层无此入参
    });
    const verifyResult = await _verify(reverifyInput, {
      timeoutMs: effectiveTimeoutMs,
      ...(gate ? { gate } : {}),
    });
    effectiveRef = verifyResult.delivery;
    effectiveOutcome = verifyResult.outcome;
    effectiveFailureCode = verifyResult.failureCode;

    const outcomeResult = await transcript.tryAppendReverifyOutcome({
      delivery: effectiveRef,
      outcome: effectiveOutcome,
      attempt: normalizedAttempt,
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
    attempt: normalizedAttempt,
    reason: requestedResult.reason,
    state,
    requested: requestedThisCall,
    outcomeRecorded: outcomeThisCall,
    verificationStatus: effectiveOutcome,
    ...(safeFailureCode ? { failureCode: safeFailureCode } : {}),
  };
}
