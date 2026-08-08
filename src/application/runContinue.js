// src/application/runContinue.js
//
// M12-7: Lead-authorized correction continuation application service.
//
// A Lead reviews a terminal worker delivery, finds a narrow defect, and
// explicitly authorizes ONE correction turn against that parent run. continueRun
// spawns a NEW WAO run/transcript that RESUMES the parent's provider-native
// conversation IN THE PARENT'S RETAINED WORKTREE — no fresh worktree, no fresh
// session, no scope inference, no automatic retry/fallback/accept/reject.
//
// Eligibility is decided READ-ONLY with closed-set refusals BEFORE any mutation:
// no lineage slot is claimed, no worktree is transitioned, no transcript is
// written, no runner is forked until every causal check passes. WAO never
// infers correction, scope, verification, retry, or acceptance — the Lead owns
// all of those. Review/accept/reject of the child delivery stays with the Lead.
//
// Lineage scope: the resumed provider session is keyed by (Lead session +
// canonical workspace + canonical agentId + ROOT runId), reused across one
// lineage only — NOT project-wide coder reuse (that is the lead_workspace
// policy). The opaque provider UUID never leaves the routing envelope.
//
// Architectural contract (mirrors runDispatch.js):
//   - No argv parsing, no console.log, no process.exit.
//   - Does not import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Depends on transcript.js, delivery.js, sessionReuse.js,
//     runWorkspaceOwnership.js, registry.js, credentialReadiness.js, envPolicy.js,
//     and child_process.spawn (injectable for testing).

import { spawn } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  JsonlTranscript,
  readTranscript,
  findState,
  findLatest,
  extractCanonicalAgentId,
  TERMINAL_STATES,
} from "../transcript.js";
import {
  isValidRunId,
  isCanonicalCommitId,
  prepareDeliveryRequest,
  prepareContinuationWorktree,
  proveContinuationWorktree,
  rollbackContinuationWorktree,
} from "../delivery.js";
import {
  releaseLineageContinuationTurn,
  resolveLineageContinuationTurn,
} from "./sessionReuse.js";
import { verifyRunWorkspaceOwnership } from "./runWorkspaceOwnership.js";
import { readRegistry } from "../registry.js";
import { assessWorkerReadiness, createEnvResolver } from "./credentialReadiness.js";
import { inheritedEnvNames } from "../envPolicy.js";
import { CredentialMissingError } from "./runDispatch.js";

// Reuse the dispatch application service's startup-failure error type so the MCP
// boundary collapses a missing credential to the same fixed actionable text.

const DEFAULT_RUNNER_PATH = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "backgroundRunner.js",
);
const DEFAULT_POLL_INTERVAL = 1000;
const ARGV_MAX_TOTAL = 24000;

// M12-7: the closed set of Lead-facing continuation rejection reasons. Every
// read-only eligibility refusal returns one of these — WAO never infers a
// continuation, scope, retry, or acceptance. The MCP schema enum derives from
// this ONE list (no second hand-maintained list at the boundary). Order matches
// the eligibility check order in continueRun (most general → most specific).
export const CONTINUE_REJECTION_REASONS = Object.freeze([
  "malformed_input", // parentRunId / prompt / required-binding shape
  "invalid_delivery", // child delivery contract failed prepareDeliveryRequest
  "parent_not_found", // no parent transcript / no agentId envelope
  "parent_not_terminal", // parent is not in a terminal state
  "parent_accepted", // accepted delivery is immutable; Lead starts a new run instead
  "not_continuable", // parent has no run_lineage session_reuse root (legacy)
  "no_provider_session", // parent never established a provider conversation to resume
  "workspace_mismatch", // parent ownership != authorized workspace
  "no_delivery", // parent run.started lacks canonical base + retained worktree
  "worker_configuration_changed", // current backend/model differs from the parent session
  "unsupported_backend", // backend does not declare supportsSessionReuse
  "missing_worktree", // retained worktree path no longer exists on disk
  "worktree_drift", // retained worktree base/branch/detached state drifted
  "busy", // a non-terminal lineage owner already holds the resume slot
]);

async function rollbackPreSpawnContinuation({
  worktreePath,
  originalBranch,
  childRunId,
  baseCommit,
  deliveryCommit,
  transcriptPath,
  resolvedRunDir,
  claim,
}) {
  rollbackContinuationWorktree(worktreePath, {
    originalBranch,
    childRunId,
    baseCommit,
    deliveryCommit,
  });
  await rm(transcriptPath, { force: true }).catch(() => {});
  await rm(`${transcriptPath}.seq.lock`, { force: true }).catch(() => {});
  await releaseLineageContinuationTurn({ runDir: resolvedRunDir, claim });
}

/**
 * Generate a runId in the same format RunManager / dispatchRun use.
 * @returns {string}
 */
function generateRunId() {
  return `run_${new Date().toISOString().replace(/[-:.TZ]/g, "")}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Convert a validated (internal-shape) delivery request to the public shape the
 * detached runner + RunManager.start consume. Same conversion SSOT as runDispatch
 * — do not let a second conversion algorithm exist.
 */
function toPublicDelivery(validated) {
  return {
    mode: validated.mode,
    allowedPaths: validated.allowedPaths,
    ...(validated.verification.commands.length > 0
      ? { verificationCommands: validated.verification.commands }
      : { verificationUnavailableReason: validated.verification.unavailableReason }),
    ...(validated.verification.setupCommands?.length > 0
      ? { verificationSetupCommands: validated.verification.setupCommands }
      : {}),
    // M12-13: forward the per-command execution timeout when declared (absent →
    // zero drift on the continuation payload).
    ...(validated.verification.verificationTimeoutMs !== undefined
      ? { verificationTimeoutMs: validated.verification.verificationTimeoutMs }
      : {}),
  };
}

/**
 * Resolve a Lead-authorized correction continuation of a terminal parent run.
 *
 * @param {object} input
 * @param {string} input.parentRunId — the terminal run being continued
 * @param {string} input.prompt — Lead-authored correction prompt (bounded)
 * @param {object} input.delivery — child delivery contract (git_commit_v1 shape)
 * @param {string} input.runDir — runs/ directory (host-owned)
 * @param {string} input.registryPath — path to agents.json
 * @param {string} input.authorizedWorkspaceRoot — MCP workspace binding (canonical git root)
 * @param {string} input.leadSession — server-owned Lead session identity (lineage key input)
 * @param {Function} [input.spawnFn] — injectable spawn (tests)
 * @param {Function} [input.backendFor] — injectable (agent) => backend instance (tests)
 * @param {Function} [input.prepareContinuationWorktreeFn] — injectable transition (tests)
 * @param {string} [input.runnerPath]
 * @param {string} [input.execPath]
 * @param {object} [input.userEnvReader]
 * @param {boolean} [input.requireCertified=false]
 * @param {number} [input.globalWaitTimeout]
 * @param {number} [input.pollInterval]
 * @param {boolean} [input.skipCredentialCheck=false]
 * @returns {Promise<object>} dispatch identity + {parentRunId, continuation:true,
 *   rootRunId} on success; or {accepted:false, rejectionReason, ...} on a
 *   closed-set eligibility refusal. Throws CredentialMissingError on a missing
 *   required credential (environmental, not an eligibility refusal).
 */
export async function continueRun({
  parentRunId,
  prompt,
  delivery,
  runDir,
  registryPath,
  authorizedWorkspaceRoot,
  leadSession,
  spawnFn,
  backendFor,
  prepareContinuationWorktreeFn = prepareContinuationWorktree,
  runnerPath,
  execPath,
  userEnvReader,
  requireCertified = false,
  globalWaitTimeout,
  pollInterval,
  skipCredentialCheck = false,
}) {
  const refuse = (rejectionReason, extra = {}) => ({
    accepted: false,
    parentRunId,
    continuation: true,
    rejectionReason,
    ...extra,
  });

  // ---- Eligibility: read-only, closed-set refusals BEFORE any mutation ----

  // 1. Required inputs + parentRunId/prompt shape.
  if (typeof parentRunId !== "string" || !isValidRunId(parentRunId)) return refuse("malformed_input");
  if (typeof prompt !== "string" || prompt.length === 0) return refuse("malformed_input");
  if (typeof runDir !== "string" || runDir.length === 0) return refuse("malformed_input");
  if (typeof registryPath !== "string" || registryPath.length === 0) return refuse("malformed_input");
  if (typeof authorizedWorkspaceRoot !== "string" || authorizedWorkspaceRoot.length === 0) return refuse("malformed_input");
  if (typeof leadSession !== "string" || leadSession.length === 0) return refuse("malformed_input");

  // 2. Child delivery contract (the Lead's scope authority for the correction).
  let validatedDelivery;
  try {
    validatedDelivery = prepareDeliveryRequest(delivery);
  } catch {
    return refuse("invalid_delivery");
  }
  const publicDelivery = toPublicDelivery(validatedDelivery);

  // 3. Parent transcript must exist and every envelope must bind the requested
  //    runId + one canonical agentId. A single cross-run/corrupt event invalidates
  //    identity rather than donating another run's worker/session lineage.
  const resolvedRunDir = resolve(runDir);
  const parentTranscriptPath = join(resolvedRunDir, `${parentRunId}.jsonl`);
  let parentEvents;
  try {
    parentEvents = await readTranscript(parentTranscriptPath);
  } catch {
    return refuse("parent_not_found");
  }
  if (!Array.isArray(parentEvents) || parentEvents.length === 0) {
    return refuse("parent_not_found");
  }
  const agentId = extractCanonicalAgentId(parentEvents, parentRunId);
  if (agentId === "unknown") return refuse("parent_not_found");

  // 4. Parent must be terminal (a correction continues a FINISHED delivery).
  const parentState = findState(parentEvents);
  if (!parentState || !TERMINAL_STATES.includes(parentState)) {
    return refuse("parent_not_terminal", { parentState: parentState ?? null });
  }

  // An accepted delivery is immutable. Correction continues a rejected or
  // undecided terminal candidate; accepted work requires a new Lead-authored run.
  if (parentEvents.some((e) => e.type === "run.delivery_accepted" && e.runId === parentRunId)) {
    return refuse("parent_accepted");
  }

  // 5. Parent must be a continuable lineage run (run.session_reuse run_lineage).
  //    A plain delivery (no lineage event) is legacy and NOT continuable — WAO
  //    never infers a continuation where the Lead did not opt in.
  const lineageEvent = findLatest(parentEvents, "run.session_reuse");
  if (!lineageEvent
    || lineageEvent.runId !== parentRunId
    || lineageEvent.mode !== "run_lineage"
    || (lineageEvent.turn !== "first" && lineageEvent.turn !== "resume")
    || typeof lineageEvent.rootRunId !== "string"
    || !isValidRunId(lineageEvent.rootRunId)
    || (lineageEvent.turn === "first" && lineageEvent.rootRunId !== parentRunId)) {
    return refuse("not_continuable");
  }
  const rootRunId = lineageEvent.rootRunId;

  if (!parentEvents.some((e) => e.type === "session.created" && e.runId === parentRunId)) {
    return refuse("no_provider_session");
  }

  // 6. Parent workspace ownership must match the authorized binding.
  try {
    verifyRunWorkspaceOwnership(parentEvents, authorizedWorkspaceRoot);
  } catch {
    return refuse("workspace_mismatch");
  }

  // 7. Parent delivery context (run.started): canonical base + retained worktree.
  const started = parentEvents.find((e) => e && e.type === "run.started" && e.runId === parentRunId);
  if (!started || !started.delivery || typeof started.delivery !== "object") {
    return refuse("no_delivery");
  }
  if (!isCanonicalCommitId(started.delivery.baseCommit)) return refuse("no_delivery");
  if (typeof started.worktreePath !== "string" || started.worktreePath.length === 0) {
    return refuse("no_delivery");
  }
  const worktreePath = started.worktreePath;
  const baseCommit = started.delivery.baseCommit;

  // 8. Parent delivery commit (committed) or null (backend-failed / uncommitted).
  let deliveryCommit = null;
  for (let i = parentEvents.length - 1; i >= 0; i -= 1) {
    const e = parentEvents[i];
    if (e && e.type === "run.delivery_created" && e.runId === parentRunId
      && e.delivery && isCanonicalCommitId(e.delivery.deliveryCommit)) {
      deliveryCommit = e.delivery.deliveryCommit;
      break;
    }
  }

  // 9. Backend must support provider session reuse (capability gate, mirror
  //    RunManager.start). No runtime-name branching — the injected backendFor
  //    decides from the declared capability.
  const registry = await readRegistry(resolve(registryPath));
  const agent = registry.getAgent(agentId);
  if (started.backend !== agent.backend
    || JSON.stringify(started.model ?? null) !== JSON.stringify(agent.model ?? null)) {
    return refuse("worker_configuration_changed");
  }
  const backend = typeof backendFor === "function" ? backendFor(agent) : null;
  if (!backend || backend.supportsSessionReuse !== true) {
    return refuse("unsupported_backend");
  }

  // 10. Credential preflight (environmental — throws, like dispatchRun).
  let finalCredentials = {};
  if (!skipCredentialCheck) {
    const readiness = await assessWorkerReadiness({
      agent,
      resolver: createEnvResolver(userEnvReader),
      names: inheritedEnvNames(agent),
    });
    if (readiness.credentialAvailability === "missing") {
      throw new CredentialMissingError(readiness.missingCredentialEnvNames);
    }
    finalCredentials = Object.fromEntries(
      Object.entries(readiness.resolvedEnv ?? {})
        .filter(([, value]) => typeof value === "string" && value.length > 0),
    );
  }

  // 11. Read-only retained-worktree proof (drift / missing) BEFORE the lineage
  //     claim — so a drifted or gone worktree refuses with no stale slot left.
  let worktreeProof;
  try {
    worktreeProof = proveContinuationWorktree(worktreePath, { baseCommit, deliveryCommit });
  } catch {
    return refuse(existsSync(worktreePath) ? "worktree_drift" : "missing_worktree");
  }

  const childRunId = generateRunId();
  if (!isValidRunId(childRunId)) return refuse("malformed_input");

  // 12. Construct every static spawn input BEFORE lineage/worktree/transcript
  //     mutation. A bad argv is a request failure, not a half-created child run.
  const _spawn = spawnFn ?? spawn;
  const _execPath = execPath ?? process.execPath;
  const _runnerPath = runnerPath ?? DEFAULT_RUNNER_PATH;
  const effectivePollInterval = pollInterval ?? DEFAULT_POLL_INTERVAL;
  const childBranch = `wao/${childRunId}`;

  const sessionReuseRouting = {
    mode: "run_lineage",
    // resolveLineageContinuationTurn derives the authoritative opaque UUID; this
    // placeholder is replaced after the claim. Static argv size is independent
    // of UUID value because every valid routing UUID has a fixed length.
    opaqueUuid: "00000000-0000-4000-8000-000000000000",
    turn: "resume",
  };
  const runnerArgs = [
    _runnerPath,
    agentId,
    "--prompt", prompt,
    "--run-dir", resolvedRunDir,
    "--run-id", childRunId,
    "--registry", resolve(registryPath),
    "--poll-interval", String(effectivePollInterval),
    "--cwd", authorizedWorkspaceRoot,
    "--isolate",
    "--delivery-json", JSON.stringify(publicDelivery),
    "--reuse-worktree-json", JSON.stringify({ path: worktreePath, branch: childBranch }),
    "--session-reuse-json", JSON.stringify(sessionReuseRouting),
  ];
  if (globalWaitTimeout !== undefined && globalWaitTimeout !== null) {
    runnerArgs.push("--global-wait-timeout", String(globalWaitTimeout));
  }
  if (requireCertified) runnerArgs.push("--require-certified");

  const totalArgvLen = runnerArgs.reduce((sum, arg) => sum + String(arg).length + 1, 0);
  if (totalArgvLen > ARGV_MAX_TOTAL) {
    throw new Error(`runner argv too long (${totalArgvLen} > ${ARGV_MAX_TOTAL}); reduce prompt/delivery size`);
  }

  // ---- Mutation phase: lineage claim → worktree transition → transcript → fork ----

  // 13. Lineage continuation turn (turn:resume, SAME opaque uuid as the root).
  //     The per-key concurrency gate: a non-terminal lineage owner is busy, so
  //     two concurrent continuations of the same parent cannot both proceed.
  const contTurn = await resolveLineageContinuationTurn({
    runDir: resolvedRunDir,
    runId: childRunId,
    parentRunId,
    rootRunId,
    leadSession,
    workspace: authorizedWorkspaceRoot,
    agentId,
  });
  if (contTurn.kind === "busy") {
    return refuse("busy", { activeRunId: contTurn.activeRunId });
  }
  runnerArgs[runnerArgs.indexOf("--session-reuse-json") + 1] = JSON.stringify(contTurn.routing);
  const claim = contTurn.claim;
  const transcriptPath = join(resolvedRunDir, `${childRunId}.jsonl`);

  // 14. Worktree transition: re-pin the retained worktree to base on the CHILD
  //     branch, preserving the parent delivery/candidate bytes as unstaged
  //     working changes. Re-proves authoritatively (TOCTOU since step 11); a
  //     drift here refuses (the lineage slot self-heals as stale).
  try {
    prepareContinuationWorktreeFn(worktreePath, {
      parentRunId,
      childRunId,
      baseCommit,
      deliveryCommit,
    });
  } catch {
    await releaseLineageContinuationTurn({ runDir: resolvedRunDir, claim });
    return refuse("worktree_drift");
  }

  // 15. Child transcript durable facts, in order: continuation-marked
  //     background_submitted → pending → run.session_reuse (run_lineage resume).
  const transcript = new JsonlTranscript(transcriptPath, { runId: childRunId, agentId });
  try {
    await transcript.append("run.background_submitted", {
      background: true,
      cwd: authorizedWorkspaceRoot,
      scorecardConfigured: false,
      deliveryRequested: true,
      continuation: true,
      parentRunId,
      rootRunId,
    });

    const pendingResult = await transcript.transitionState(null, "pending", "background_spawned");
    if (!pendingResult.accepted) {
      throw new Error("continuation child runId collision");
    }

    await transcript.append("run.session_reuse", {
      mode: contTurn.routing.mode,
      turn: contTurn.routing.turn,
      rootRunId,
    });

    const runnerEnv = { ...process.env, ...finalCredentials };
    _spawn(_execPath, runnerArgs, { detached: true, stdio: "ignore", env: runnerEnv }).unref();
  } catch (error) {
    await rollbackPreSpawnContinuation({
      worktreePath,
      originalBranch: worktreeProof.branch,
      childRunId,
      baseCommit,
      deliveryCommit,
      transcriptPath,
      resolvedRunDir,
      claim,
    });
    throw error;
  }

  return {
    accepted: true,
    runId: childRunId,
    agentId,
    parentRunId,
    continuation: true,
    rootRunId,
    state: "pending",
    transcriptPath,
  };
}
