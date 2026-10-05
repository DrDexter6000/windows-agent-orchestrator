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
  findLatestBound,
  extractCanonicalAgentId,
  TERMINAL_STATES,
  STATE_CHANGE_REASON,
} from "../transcript.js";
import {
  isValidRunId,
  isCanonicalCommitId,
  prepareDeliveryRequest,
  prepareContinuationWorktree,
  proveContinuationWorktree,
  rollbackContinuationWorktree,
  listWorktreeChangedPaths,
  isPathAllowed,
} from "../delivery.js";
import {
  releaseLineageContinuationTurn,
  resolveLineageContinuationTurn,
  resolvePriorProviderSessionId,
  resolvePriorProviderSessionIdFromEvents,
} from "./sessionReuse.js";
// M12-22: cumulative-scope truth reuses the existing path-validation SSOT and the
// repository's existing inventory cap — no second path-identity algorithm and no
// second cap. validateProjectedPath is the same MCP-boundary validator the
// candidate inventory uses; INVENTORY_PATHS_LIMIT is the same hard ceiling.
import { validateProjectedPath } from "./deliveryReview.js";
import { INVENTORY_PATHS_LIMIT } from "./candidateInventory.js";
import { verifyRunWorkspaceOwnership } from "./runWorkspaceOwnership.js";
import { readRegistry } from "../registry.js";
// R23-C §4: the provider-attachment fingerprint SSOT (src host — same
// application→core downward direction as the registry import above; the cert
// gate's matchedCertRecord compares records against the SAME derivation).
import { providerKeyFor } from "../providerFingerprint.js";
import { assessWorkerReadiness, createEnvResolver } from "./credentialReadiness.js";
import { inheritedEnvNames } from "../envPolicy.js";
import { CredentialMissingError } from "./runDispatch.js";
import { loadRoleContract, roleContractSha256 } from "./roleContract.js";

// Reuse the dispatch application service's startup-failure error type so the MCP
// boundary collapses a missing credential to the same fixed actionable text.

const DEFAULT_RUNNER_PATH = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "backgroundRunner.js",
);
const DEFAULT_POLL_INTERVAL = 1000;
const ARGV_MAX_TOTAL = 24000;

// TD188-R1 (2026-09-27): internal sentinel for the IN-LOCK prior-session
// validation refusal (the lineage slot's final prior holds no provider session
// this backend can resume). Never crosses the application/MCP boundary —
// continueRun maps it to the existing no_provider_session closed-set reason.
// Scoping matters: resolveLineageContinuationTurn's OTHER failure modes
// (damaged routing entry, lock timeout) keep propagating untouched.
class PriorProviderSessionUnresumableError extends Error {
  constructor() {
    super("sessionReuse: the lineage's resumable prior holds no provider session this backend can resume");
    this.name = "PriorProviderSessionUnresumableError";
  }
}

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
  "worker_configuration_changed", // current backend/model/provider differs from the parent session
  "role_contract_drift", // 0045 R4 洞①：父钉住的角色正文与当前文件不一致/不可加载——同谱系静默换帽拒绝
  "legacy_dispatch_continuable_unsupported", // 0045 W4d：父 envelope agentId=重键前席位名——跨版本谱系拒绝
  "unsupported_backend", // backend does not declare supportsSessionReuse
  "missing_worktree", // retained worktree path no longer exists on disk
  "worktree_drift", // retained worktree base/branch/detached state drifted
  "continuation_scope_incomplete", // retained parent changes fall outside the child allowedPaths (cumulative)
  "busy", // a non-terminal lineage owner already holds the resume slot
]);

// M12-22: continuation cumulative-scope truth.
//
// A child continuation re-packages the CUMULATIVE candidate from the lineage
// base (parent result + this correction), NOT just the correction delta. So the
// child delivery allowedPaths must COVER every retained parent change that is
// still present in the worktree. This read-only helper derives the retained
// candidate's actual changed paths from authoritative Git/worktree facts and
// compares them to the child allowedPaths via the SAME containment SSOT
// (isPathAllowed) the packaging/inspection gate uses — no second boundary
// semantics, no runtime-name branches, no ad-hoc shell parsing.
//
// Mirrors computeCandidateInventory's fail-closed contract: returns null on ANY
// read/validation failure (a throwing reader, a non-array result, or a single
// traversal/absolute/control-char path) — never partial truth. Counts report
// the FULL deduplicated cardinality (not the capped length) so truncation is
// detectable against the repository's existing INVENTORY_PATHS_LIMIT cap.
//
// Pure + strictly read-only: no staging, no reset, no transcript/Git mutation,
// no console.log, no process.exit. Does not import src/commands/*, src/mcp/*,
// the MCP SDK, or zod. Workspace/lineage ownership is the CALLER's job and must
// be settled BEFORE this is invoked; this helper trusts an already-proven
// (worktreePath, baseCommit, childAllowedPaths) triple but validates defensively.
//
// @param {string} worktreePath — the proven retained parent delivery worktree
// @param {string} baseCommit — canonical full hash (lineage base)
// @param {string[]} childAllowedPaths — the child delivery allowedPaths contract
// @param {Function} [listFn] — injectable change-listing reader (tests);
//   defaults to listWorktreeChangedPaths. Must return an array of repo-relative
//   paths or null when either required Git read failed.
// @returns {object|null} {
//   inheritedChangedPaths, inheritedChangedCount, inheritedChangedTruncated,
//   uncoveredInheritedPaths, uncoveredInheritedCount, uncoveredInheritedTruncated,
//   complete,
// } or null on ANY validation/read failure (never partial truth)
export function computeContinuationCumulativeScope(worktreePath, baseCommit, childAllowedPaths, listFn) {
  // Malformed inputs fail closed.
  if (typeof worktreePath !== "string" || worktreePath.length === 0) return null;
  if (!isCanonicalCommitId(baseCommit)) return null;
  if (!Array.isArray(childAllowedPaths) || childAllowedPaths.length === 0) return null;

  // Validate the child contract through the SAME strict projection SSOT so a
  // traversal/absolute/control-char entry can never reach the comparison.
  let allowed;
  try {
    allowed = childAllowedPaths.map((p) => validateProjectedPath(p));
  } catch {
    return null;
  }

  const _list = listFn ?? listWorktreeChangedPaths;
  let raw;
  try {
    raw = _list(worktreePath, baseCommit);
  } catch {
    return null; // a throwing reader is a failed read — never partial truth
  }
  if (!Array.isArray(raw)) return null; // required read failed => null

  // Validate EVERY derived path through the strict projection SSOT; any unsafe
  // path nulls the WHOLE result (no partial truth across the eligibility gate).
  const validated = [];
  try {
    for (const p of raw) validated.push(validateProjectedPath(p));
  } catch {
    return null;
  }

  // Deterministic: deduplicate + sort. Counts report the FULL cardinality of the
  // deduplicated set (not the capped length) so truncation is detectable.
  const allowedCanon = [...new Set(allowed)].sort();
  const inherited = [...new Set(validated)].sort();
  const uncovered = inherited.filter((p) => !isPathAllowed(p, allowedCanon));

  const inheritedPaths = inherited.slice(0, INVENTORY_PATHS_LIMIT);
  const uncoveredPaths = uncovered.slice(0, INVENTORY_PATHS_LIMIT);
  return {
    inheritedChangedPaths: inheritedPaths,
    inheritedChangedCount: inherited.length,
    inheritedChangedTruncated: inherited.length > inheritedPaths.length,
    uncoveredInheritedPaths: uncoveredPaths,
    uncoveredInheritedCount: uncovered.length,
    uncoveredInheritedTruncated: uncovered.length > uncoveredPaths.length,
    complete: uncovered.length === 0,
  };
}

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
 * @param {Function} [input.listChangedPathsFn] — injectable cumulative-scope change reader (tests)
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
  listChangedPathsFn,
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

  // 0045 R3 裁定 H3：explicit（车道+角色组合）派发的父 run 不可被 continue——
  // 续接链路从 registry 重建子 run 且不携带角色，会静默把 explicit 帽换回接线
  // 席位的默认帽（R1 关闭的同族洞）。父档形态从 run.started 一眼可知，故此门
  // 先于 lineage/delivery 门（避免 not_continuable 掩盖真实原因）；legacy 父
  // （无 resolvedFrom 字段）不受影响。直到身份钉住传到 run_continue（0045 §6
  // 第 3 步收口）为止具名拒绝。
  {
    const parentStarted = parentEvents.find((e) => e && e.type === "run.started" && e.runId === parentRunId);
    if (parentStarted?.resolvedFrom === "explicit") {
      return refuse("explicit_dispatch_continuable_unsupported", {
        detail: "the parent run was dispatched as an explicit lane+role combination; run_continue "
          + "rebuilds the child from the registry entry without the explicit role (a silent "
          + "hat switch). Dispatch by agentId for continuable work until 0045 step-3 identity "
          + "pinning reaches run_continue",
      });
    }
  }

  // 0045 R4 洞①关门（P1 只关了 resume 臂）：父 run 钉住的角色正文 sha 与当前
  // 角色文件不一致 → 拒绝续接——否则子 run 会在同一 provider 谱系会话上静默
  // 换帽。父事实一眼可知，故与 H3 同置于 lineage/delivery 门之前（防
  // not_continuable/no_delivery 掩盖真实原因）。钉缺席（P1 前的 legacy 父）跳过
  // 本维（record-side-undefined-skip）。
  {
    const parentStarted = parentEvents.find((e) => e && e.type === "run.started" && e.runId === parentRunId);
    const parentRolePin = parentStarted?.rolePin;
    if (parentRolePin && typeof parentRolePin.sha256 === "string"
      && typeof parentRolePin.systemPrompt === "string") {
    let currentRoleSha = null;
    try {
      currentRoleSha = roleContractSha256(loadRoleContract(parentRolePin.systemPrompt));
    } catch {
      return refuse("role_contract_drift", {
        detail: `the role contract pinned by the parent (${parentRolePin.systemPrompt}) is no longer loadable; a continuation must not silently drop the role`,
      });
    }
    if (currentRoleSha !== parentRolePin.sha256) {
      return refuse("role_contract_drift", {
        detail: `the role contract pinned by the parent (${parentRolePin.systemPrompt}) has changed since dispatch; a continuation would run the SAME provider lineage under a different role — start a new run instead`,
      });
    }
    }
  }

  // 5. Parent must be a continuable lineage run (run.session_reuse run_lineage).
  //    A plain delivery (no lineage event) is legacy and NOT continuable — WAO
  //    never infers a continuation where the Lead did not opt in.
  //    R14 (TD-129d): the read goes through the shared findLatestBound reader —
  //    the last run.session_reuse BOUND to this parent, matching the inline
  //    runId filtering this function already applies at its sibling reads
  //    (delivery_accepted / session.created / run.started / delivery_created).
  //    Anchor honesty (R14 re-verification): step 3's
  //    extractCanonicalAgentId(parentEvents, parentRunId) already fail-closes
  //    ANY foreign or envelope-less line as parent_not_found BEFORE this gate,
  //    so the swap is provably behavior-identical today (every reachable event
  //    carries runId === parentRunId) — it is function-internal discipline
  //    consistency plus defense-in-depth for a future relaxation of the
  //    identity gate, not a live fix. The runId clause below is therefore
  //    tautological after the bound read; kept as belt-and-braces.
  const lineageEvent = findLatestBound(parentEvents, "run.session_reuse", parentRunId);
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
    verifyRunWorkspaceOwnership(parentEvents, authorizedWorkspaceRoot, parentRunId);
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
  // 0045 W4d（R5 §1.3）：重键前父档案的 envelope agentId=席位名（注册表已车道键化）——
  // 跨版本谱系续接待续接具名拒绝（固定文案指路重派，不裸抛 Unknown）。
  {
    const allIds = new Set(registry.listAgents().map((a) => a.id));
    if (agentId !== null && agentId !== undefined && !allIds.has(agentId)) {
      return refuse("legacy_dispatch_continuable_unsupported", {
        detail: `the parent run's envelope agentId ("${agentId}") predates the lane-keyed registry; cross-era continuation is refused by 0045 §1.3 — dispatch a new run instead`,
      });
    }
  }
  const agent = registry.getAgent(agentId);
  // R23-C §4: the provider attachment (baseUrl + apiKeyEnv NAME) joins the
  // drift check — swapping the provider wiring mid-lineage must start a fresh
  // run, not silently resume on the new endpoint. The parent-side durable
  // fact is run.started.providerKey (the providerKeyFor fingerprint persisted
  // since R23-C; userinfo/query/fragment are dropped by the normalizer, so
  // credentials never enter the comparison). Legacy tolerance: parents started
  // before the field existed (undefined on the recorded event) skip this
  // dimension — same record-side-undefined-skip discipline as
  // matchedCertRecord. An explicit null (observed, no provider attached)
  // compares against the CURRENT derivation: it matches a still-bare lane but
  // must NOT adopt a provider wired after the parent ran.
  if (started.backend !== agent.backend
    || JSON.stringify(started.model ?? null) !== JSON.stringify(agent.model ?? null)
    || (started.providerKey !== undefined
      && started.providerKey !== providerKeyFor(agent.provider))) {
    return refuse("worker_configuration_changed");
  }
  const backend = typeof backendFor === "function" ? backendFor(agent) : null;
  if (!backend || backend.supportsSessionReuse !== true) {
    return refuse("unsupported_backend");
  }

  // 9b. TD188 (2026-09-27): COMPLETE resumability preflight — the SAME shared
  //     reader + backend-owned availability judgment the spawn authority
  //     (RunManager.start) applies at resume time, so the two authorities can
  //     never disagree about what the parent transcript licenses. A Kimi/Codex
  //     parent that only ever recorded the process placeholder identity
  //     (proc_<pid>) is refused HERE with the existing no_provider_session
  //     reason — BEFORE the lineage claim, any worktree transition, the child
  //     transcript, and the fork (the pre-fix flow forked a runner that handed
  //     proc_43244 to `kimi -r`: upstream "Session not found", zero tool
  //     execution). A parent that late-bound its runtime-native id
  //     (run.provider_session_bound) resolves to that id; a damaged/duplicated/
  //     conflicting binding fact refuses rather than falling back to the
  //     placeholder. claude-code parents (resume compiles routing.opaqueUuid,
  //     hook overridden to true) stay continuable on the legal opaque path;
  //     ACP native session.created stays valid (no hook → legacy semantics).
  //     Historical proc-only parents are deliberately NOT continuable this
  //     round; a fresh real run records the binding fact going forward.
  let priorProviderSessionId = null;
  try {
    priorProviderSessionId = resolvePriorProviderSessionIdFromEvents(parentEvents, parentRunId);
  } catch {
    return refuse("no_provider_session");
  }
  if (typeof backend.canResumeWithRecoveredSessionId === "function") {
    let hookOk = true;
    try {
      hookOk = backend.canResumeWithRecoveredSessionId(priorProviderSessionId) === true;
    } catch {
      hookOk = false;
    }
    if (!hookOk) return refuse("no_provider_session");
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

  // 11b. M12-22: continuation cumulative-scope truth — STILL read-only, BEFORE
  //      any lineage claim / worktree transition / transcript / spawn. A child
  //      continuation re-packages the CUMULATIVE candidate from the lineage base
  //      (parent result + correction), so the child allowedPaths must cover every
  //      retained parent change. Derive the retained candidate's actual changed
  //      paths from authoritative Git/worktree facts and compare them to the
  //      child allowedPaths via the existing containment SSOT. Uncovered inherited
  //      paths => continuation_scope_incomplete, naming the bounded repo-relative
  //      facts so the Lead can explicitly approve a cumulative scope and retry.
  //      WAO never auto-expands scope, auto-restores files, retries, accepts, or
  //      infers semantic intent — a path authorized here may later be restored to
  //      base and disappear from the final delivery; final packaging stays
  //      governed by the existing containment gate (unchanged).
  const cumulativeScope = computeContinuationCumulativeScope(
    worktreePath,
    baseCommit,
    validatedDelivery.allowedPaths,
    listChangedPathsFn,
  );
  if (cumulativeScope === null) {
    // The authoritative facts could not be derived cleanly after a proven
    // worktree (Git read failure or an unprojectable path). Fail closed: do NOT
    // spawn with an unverified scope. This is an environmental/internal anomaly,
    // not a Lead-eligible condition — it propagates as the existing fixed
    // "run_continue failed" boundary (no path, prompt, or Git error leaked).
    throw new Error("continuation cumulative-scope facts could not be derived");
  }
  if (!cumulativeScope.complete) {
    return refuse("continuation_scope_incomplete", {
      inheritedChangedPaths: cumulativeScope.inheritedChangedPaths,
      inheritedChangedCount: cumulativeScope.inheritedChangedCount,
      inheritedChangedTruncated: cumulativeScope.inheritedChangedTruncated,
      uncoveredInheritedPaths: cumulativeScope.uncoveredInheritedPaths,
      uncoveredInheritedCount: cumulativeScope.uncoveredInheritedCount,
      uncoveredInheritedTruncated: cumulativeScope.uncoveredInheritedTruncated,
    });
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
    // §3.6/R2: resume envelopes carry the prior WAO runId (the direct parent —
    // same fixed-length runId format, so the placeholder is size-stable too).
    priorRunId: parentRunId,
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
  //     TD188-R1: the resume's ACTUAL prior is decided INSIDE this lock — the
  //     lineage slot's previous owner (entry.runId) when one exists, else the
  //     requested parent. validatePriorRunId runs the SAME shared reader +
  //     backend-hook judgment (and maps to the SAME no_provider_session reason)
  //     on that FINAL prior BEFORE the claim is written: a slot owner whose
  //     transcript holds no resumable provider session refuses with ZERO side
  //     effects — entry bytes untouched, no worktree transition, no child
  //     transcript, no fork. The pre-fix flow claimed the slot, transitioned
  //     the worktree, created the child transcript and forked, and only failed
  //     later at RunManager.start (which reads the slot owner, not the
  //     requested parent). The returned routing carries this same verified
  //     prior, so what start re-reads is exactly what was validated here.
  let contTurn;
  try {
    contTurn = await resolveLineageContinuationTurn({
      runDir: resolvedRunDir,
      runId: childRunId,
      parentRunId,
      rootRunId,
      leadSession,
      workspace: authorizedWorkspaceRoot,
      agentId,
      validatePriorRunId: async (finalPriorRunId) => {
        try {
          const recovered = await resolvePriorProviderSessionId({
            runDir: resolvedRunDir,
            priorRunId: finalPriorRunId,
          });
          if (typeof backend.canResumeWithRecoveredSessionId === "function"
            && backend.canResumeWithRecoveredSessionId(recovered) !== true) {
            throw new Error("recovered provider session id is not resumable by this backend");
          }
        } catch (error) {
          // Collapse EVERY validation failure mode (reader refusal, hook
          // refusal, throwing hook) to the sentinel — the closed-set refusal
          // reason carries the semantics; the fixed-text details stay in the
          // reader's own messages for the lanes that surface them.
          throw new PriorProviderSessionUnresumableError();
        }
      },
    });
  } catch (error) {
    if (error instanceof PriorProviderSessionUnresumableError) {
      return refuse("no_provider_session");
    }
    throw error;
  }
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

    const pendingResult = await transcript.transitionState(null, "pending", STATE_CHANGE_REASON.background_spawned);
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
