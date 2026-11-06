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
// Lineage scope: the resumed provider session is keyed by (canonical workspace
// + canonical agentId + ROOT runId + the lane content fingerprint and role
// contract sha256 pinned when the root was dispatched) — reused across one
// lineage only, NOT project-wide coder reuse (that is the lead_workspace
// policy) and NOT keyed by the Lead session, so a restarted host re-derives the
// same provider conversation. The opaque provider UUID never leaves the
// routing envelope.
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
  STATE_CHANGE_REASON, transcriptPathFor } from "../transcript.js";
import { identifyProjectFromCwd, productionProjectIo } from "../projectIdentity.js";
import { resolveRunDirForWrite, projectFactForWrite, resolveTranscriptPath } from "../projectBuckets.js";
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
import { loadLanesConfig, resolveDispatchTarget, listRoleLibrary } from "../dispatchResolution.js";
import { assessWorkerReadiness, createEnvResolver } from "./credentialReadiness.js";
import { inheritedEnvNames } from "../envPolicy.js";
import { CredentialMissingError } from "./runDispatch.js";
import { loadRoleContract, roleContractSha256 } from "./roleContract.js";
import { deriveStartedIdentity, laneFingerprint as laneFingerprintOf } from "./identityProjection.js";
import { isValidCanonicalAgentId } from "../canonicalAgentId.js";
import { PROMPT_HANDOFF_TIMEOUT_TEXT, promptStdinArgs, writeRunnerPrompt } from "../runnerPrompt.js";

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
  "lineage_closed", // TD-254（决定 0058）：根转录 run.lineage_closed 在场——Lead 已显式放弃该线系
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

/**
 * 决定 0112：谱系成员判定纯函数——continueRun 第 5 步的资格条件逐条照搬
 *（不增不减），供资格检查与交付收口时的可续提示（deliveryContinuableHint）
 * 共用，两处对"什么是 continuable 谱系成员"永不分叉。
 *
 * 取绑定本 run 的最后一条 `run.session_reuse`（findLatestBound，与 continueRun
 * 的既有读法一致），满足全部条件时返回 `{ rootRunId, turn }`，否则返回 null。
 * Pure：无 I/O，调用方保证 events 是数组。
 *
 * @param {object[]} events — transcript 快照（envelope-bearing）
 * @param {string} runId
 * @returns {{rootRunId: string, turn: string}|null}
 */
export function continuableLineageFact(events, runId) {
  const lineageEvent = findLatestBound(events, "run.session_reuse", runId);
  if (!lineageEvent
    || lineageEvent.runId !== runId
    || lineageEvent.mode !== "run_lineage"
    || (lineageEvent.turn !== "first" && lineageEvent.turn !== "resume")
    || typeof lineageEvent.rootRunId !== "string"
    || !isValidRunId(lineageEvent.rootRunId)
    || (lineageEvent.turn === "first" && lineageEvent.rootRunId !== runId)) {
    return null;
  }
  return { rootRunId: lineageEvent.rootRunId, turn: lineageEvent.turn };
}

/**
 * 决定 0112：交付收口时的"可续修"提示判定（应用层读侧；MCP 层不读转录，
 * 服务在此算好一个内部布尔交给适配层）。只陈述可以从转录查实的事实——
 * "这次运行是带 continuable 派发的谱系成员、交付未采纳、线系未证明已闭合"
 * ——不断言 run_continue 一定受理：角色正文漂移、registry/后端变化、会话
 * 证据不足、工作树没了，都要到 run_continue 自己的资格检查才知道。
 *
 * 三个条件全部成立才返回 true：
 *   1. continuableLineageFact(events, runId) 非 null；
 *   2. 没有绑定本 run 的 run.delivery_accepted（已采纳不可续）；
 *   3. 线系未被证明已闭合：根就是本 run 时用 lineageClosedIn(events, runId)；
 *      根是别的 run 时按 resolveTranscriptPath 读根转录再判，读不出当未闭合
 *      （与 continueRun 的 lineage_closed 增强门同口径）。
 *
 * 只读：零转录写入、零状态变更、零 spawn。读故障的处置只有一个例外：根转录
 * 读不出当未闭合（返回 true，与 continueRun 的 lineage_closed 增强门同口径——
 * 闭态检查是增强门，读不出不挡提示）；其余形状不符（无谱系/已采纳/根闭合）
 * 一律 false。
 *
 * @param {object} input
 * @param {object[]} input.events — 同一份快照的事件（判定与收口判定共用快照）
 * @param {string} input.runId
 * @param {string} input.runDir — runs/ 目录（根是别的 run 时读根转录）
 * @param {Function} [input.readTranscriptFn] — 可注入读器（测试）
 * @returns {Promise<boolean>}
 */
export async function deliveryContinuableHint({ events, runId, runDir, readTranscriptFn }) {
  if (!Array.isArray(events)) return false;
  const fact = continuableLineageFact(events, runId);
  if (!fact) return false;
  if (events.some((e) => e && e.type === "run.delivery_accepted" && e.runId === runId)) {
    return false;
  }
  // 与 continueRun 内同一动态 import 习惯（同文件、同一依赖、一个写法）。
  const { lineageClosedIn } = await import("./lineageClose.js");
  if (fact.rootRunId === runId) {
    return !lineageClosedIn(events, runId);
  }
  try {
    const rootPath = resolveTranscriptPath(resolve(runDir), fact.rootRunId);
    const rootEvents = await (readTranscriptFn ?? readTranscript)(rootPath);
    if (lineageClosedIn(rootEvents, fact.rootRunId)) return false;
  } catch {
    // 根不可读/被 prune → 当未闭合（continueRun 的 lineage_closed 门同口径）。
  }
  return true;
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

// A lineage's identity is pinned by its ROOT run's own run.started facts: the
// lane content fingerprint (from the recorded lane axes — never the current
// registry) and the role-contract sha256 recorded in rolePin ("none" when the
// root had no role). This is the SAME material the root dispatch derived its
// turn:first opaque uuid from, so every continuation re-derives that exact
// provider conversation (no Lead session in the material).
const LINEAGE_ROLE_SHA_RE = /^(?:[0-9a-f]{64}|none)$/;

function lineageIdentityFromStarted(started) {
  const identity = deriveStartedIdentity(started);
  if (identity === null) return null;
  const pin = started?.rolePin;
  let roleSha256 = "none";
  if (pin !== undefined && pin !== null) {
    if (typeof pin !== "object" || typeof pin.sha256 !== "string" || !LINEAGE_ROLE_SHA_RE.test(pin.sha256)) {
      return null;
    }
    roleSha256 = pin.sha256;
  }
  return { laneFingerprint: laneFingerprintOf(identity), roleSha256 };
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
 * @param {Function} [input.spawnFn] — injectable spawn (tests)
 * @param {number} [input.promptHandoffTimeoutMs] — injectable prompt-handoff bound (tests)
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
  spawnFn,
  promptHandoffTimeoutMs,
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
  // D2-②b：父转录读侧解析链（桶/平铺/全桶扫描——父 run 可能是旧平铺档）。
  const parentTranscriptPath = resolveTranscriptPath(resolvedRunDir, parentRunId);
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

  // 0045 R4 洞①关门（P1 只关了 resume 臂）：父 run 钉住的角色正文 sha 与当前
  // 角色文件不一致 → 拒绝续接——否则子 run 会在同一 provider 谱系会话上静默
  // 换帽。父事实一眼可知，故置于 lineage/delivery 门之前（防
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
  //    identity gate, not a live fix. The runId clause inside the shared
  //    function is therefore tautological after the bound read; kept as
  //    belt-and-braces. 决定 0112：条件本体在 continuableLineageFact（与交付
  //    收口时的可续提示共用，逐条照搬），此处只消费其结果。
  const lineageFact = continuableLineageFact(parentEvents, parentRunId);
  if (!lineageFact) {
    return refuse("not_continuable");
  }
  const rootRunId = lineageFact.rootRunId;

  // The lineage identity material comes ONLY from the ROOT run's pinned facts.
  // The root transcript is also where TD-254's closure fact lives, so read it
  // once. A root whose run.started cannot be read/projected is not a provable
  // lineage root (refuse; never fall back to the current config or Lead session).
  let rootEvents = parentEvents;
  if (rootRunId !== parentRunId) {
    try {
      rootEvents = await readTranscript(resolveTranscriptPath(resolvedRunDir, rootRunId));
    } catch {
      return refuse("not_continuable");
    }
  }
  const rootStarted = rootEvents.find((e) => e && e.type === "run.started" && e.runId === rootRunId);
  const lineageIdentity = rootStarted ? lineageIdentityFromStarted(rootStarted) : null;
  if (!lineageIdentity) {
    return refuse("not_continuable");
  }
  let lineageLaneRole = null;
  if (rootStarted.resolvedFrom === "explicit" || rootStarted.resolvedFrom === "alias") {
    if (!isValidCanonicalAgentId(rootStarted.laneId) || !isValidCanonicalAgentId(rootStarted.roleId)) {
      return refuse("not_continuable");
    }
    lineageLaneRole = { laneId: rootStarted.laneId, roleId: rootStarted.roleId };
  }
  const rootRolePin = rootStarted.rolePin && typeof rootStarted.rolePin === "object"
    ? rootStarted.rolePin
    : null;
  // A root != parent lineage root pin is re-checked against the current role
  // file exactly like the parent pin above (0045 R4); a parent/root pin
  // mismatch is a silent hat switch on the resumed provider session.
  if (rootRunId !== parentRunId) {
    const parentStartedForPin = parentEvents.find((e) => e && e.type === "run.started" && e.runId === parentRunId);
    const parentRolePin = parentStartedForPin?.rolePin && typeof parentStartedForPin.rolePin === "object"
      ? parentStartedForPin.rolePin
      : null;
    if (parentRolePin && rootRolePin
      && (parentRolePin.systemPrompt !== rootRolePin.systemPrompt || parentRolePin.sha256 !== rootRolePin.sha256)) {
      return refuse("role_contract_drift", {
        detail: "the parent run's pinned role differs from the lineage root's pinned role; a continuation would resume the SAME provider lineage under a different role — start a new run instead",
      });
    }
    if (rootRolePin) {
      if (typeof rootRolePin.systemPrompt !== "string" || typeof rootRolePin.sha256 !== "string") {
        return refuse("role_contract_drift", {
          detail: "the lineage root's pinned role is malformed; a continuation must not silently drop the role",
        });
      }
      let currentRootRoleSha = null;
      try {
        currentRootRoleSha = roleContractSha256(loadRoleContract(rootRolePin.systemPrompt));
      } catch {
        return refuse("role_contract_drift", {
          detail: `the role contract pinned by the lineage root (${rootRolePin.systemPrompt}) is no longer loadable; a continuation must not silently drop the role`,
        });
      }
      if (currentRootRoleSha !== rootRolePin.sha256) {
        return refuse("role_contract_drift", {
          detail: `the role contract pinned by the lineage root (${rootRolePin.systemPrompt}) has changed since dispatch; a continuation would run the SAME provider lineage under a different role — start a new run instead`,
        });
      }
    }
  }

  // TD-254（决定 0058）：线系闭合拒绝——根转录 bound run.lineage_closed 在场。
  // 锁侧封口归 lineage-close 的根锁+槽新鲜度门；此处 check→claim 微窗残余显式
  // 记录（0058）。
  try {
    const { lineageClosedIn } = await import("./lineageClose.js");
    if (lineageClosedIn(rootEvents, rootRunId)) return refuse("lineage_closed");
  } catch {
    // 读取故障不阻断（闭态检查是增强门，非授权门——授权门在 decide/闭合侧）。
  }

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
  // getAgent 的 Unknown 信号转具名拒绝（固定文案指路重派，不裸抛；mock 注册表同
  // resume 侧一致以 getAgent 为准）。
  let agent;
  try {
    agent = registry.getAgent(agentId);
  } catch (e) {
    if (String(e?.message ?? "").includes("Unknown agent")) {
      return refuse("legacy_dispatch_continuable_unsupported", {
        detail: `the parent run's envelope agentId ("${agentId}") predates the lane-keyed registry; cross-era continuation is refused by 0045 §1.3 — dispatch a new run instead`,
      });
    }
    throw e;
  }
  // R23-C §4 → 决定 0106：providerKey 维的漂移比对。当前侧恒为 null（provider
  // 通道退役）；父侧事实是 run.started.providerKey（R23-C 起持久化）。Legacy
  // tolerance: parents started before the field existed (undefined on the
  // recorded event) skip this dimension — same record-side-undefined-skip
  // discipline as matchedCertRecord. An explicit null matches the always-null
  // current side; a parent recorded against a pre-0106 provider wiring
  // (non-null string) must NOT be silently adopted — fresh run instead.
  if (started.backend !== agent.backend
    || JSON.stringify(started.model ?? null) !== JSON.stringify(agent.model ?? null)
    || (started.providerKey !== undefined
      && started.providerKey !== null)) {
    return refuse("worker_configuration_changed");
  }
  // The child is rebuilt from the lineage ROOT's pinned role source — never the
  // current registry default. A different current source (seat systemPrompt
  // added/removed/repointed) is a silent hat switch on the resumed provider
  // session: refuse with the existing drift reason.
  const pinnedRoleSource = typeof rootRolePin?.systemPrompt === "string" ? rootRolePin.systemPrompt : null;
  const rebuiltRoleSource = lineageLaneRole
    ? `config/roles/${lineageLaneRole.roleId}.md`
    : (agent.systemPrompt || null);
  if (rebuiltRoleSource !== pinnedRoleSource) {
    return refuse("role_contract_drift", {
      detail: "the role source this continuation would rebuild differs from the role pinned by the lineage root; a continuation must not silently switch roles",
    });
  }
  // An explicit/alias lineage rebuilds its child through the SAME explicit
  // resolution the runner applies (--lane/--role). Prove it BEFORE any mutation:
  // a rewired lanes.json / registry (or a lane that no longer resolves to the
  // same wiring seat) is `worker_configuration_changed`, not a doomed child.
  if (lineageLaneRole) {
    const registryAgents = Object.fromEntries(
      (typeof registry.listAgents === "function" ? registry.listAgents() : []).map((a) => [a.id, a]),
    );
    const resolution = resolveDispatchTarget({
      lane: lineageLaneRole.laneId,
      role: lineageLaneRole.roleId,
      lanesDoc: loadLanesConfig(),
      registryAgents,
      roleLibrary: listRoleLibrary(),
    });
    if (resolution.kind === "error"
      || resolution.source !== "explicit"
      || resolution.agentId !== agentId
      || resolution.laneId !== lineageLaneRole.laneId
      || resolution.roleId !== lineageLaneRole.roleId) {
      return refuse("worker_configuration_changed");
    }
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
    // 提示词经标准输入交给 runner（见下方 spawn），不进命令行；argv 只带它的摘要。
    ...promptStdinArgs(prompt),
    "--run-dir", resolvedRunDir,
    "--run-id", childRunId,
    "--registry", resolve(registryPath),
    "--poll-interval", String(effectivePollInterval),
    "--cwd", authorizedWorkspaceRoot,
    "--isolate",
    "--delivery-json", JSON.stringify(publicDelivery),
    "--reuse-worktree-json", JSON.stringify({ path: worktreePath, branch: childBranch }),
    "--session-reuse-json", JSON.stringify(sessionReuseRouting),
    // 决定 0114 修订：续修把根派发时冻结的同一组身份材料交给 runner 复核
    // （与 run_dispatch 的 --reuse-material-json 同一核对）。资格检查之后、
    // backend spawn 之前若角色正文或车道接线又变了，runner 以既有
    // reuse_material_mismatch 具名失败收口——不得带旧会话换新帽。
    "--reuse-material-json", JSON.stringify(lineageIdentity),
  ];
  // The child is rebuilt from the ROOT's pinned lane+role through the SAME
  // explicit resolution the runner applies (never the seat default role).
  if (lineageLaneRole) {
    runnerArgs.push("--lane", lineageLaneRole.laneId);
    runnerArgs.push("--role", lineageLaneRole.roleId);
  }
  if (globalWaitTimeout !== undefined && globalWaitTimeout !== null) {
    runnerArgs.push("--global-wait-timeout", String(globalWaitTimeout));
  }
  if (requireCertified) runnerArgs.push("--require-certified");

  const totalArgvLen = runnerArgs.reduce((sum, arg) => sum + String(arg).length + 1, 0);
  if (totalArgvLen > ARGV_MAX_TOTAL) {
    throw new Error(`runner argv too long (${totalArgvLen} > ${ARGV_MAX_TOTAL}); reduce delivery size`);
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
      workspace: authorizedWorkspaceRoot,
      agentId,
      ...lineageIdentity,
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
  // D2-②b decide-once：continuation 子转录桶在此决定一次（identity 源=授权
  // 工作区根，与下方首事件事实同源），经 --transcript-dir 显式传 runner。
  const continueIdentity = identifyProjectFromCwd(authorizedWorkspaceRoot, productionProjectIo());
  const continueWrite = resolveRunDirForWrite(resolvedRunDir, continueIdentity);
  runnerArgs.push("--transcript-dir", continueWrite.transcriptDir);
  const transcriptPath = transcriptPathFor(continueWrite.transcriptDir, childRunId);

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
      // 终审 F1（sol）：续接子 run 的首事件同款落档桶归属事实——与
      // dispatch/runManager 同一构造器（口径不分叉）。
      project: projectFactForWrite(continueIdentity, continueWrite),
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
    const runner = _spawn(_execPath, runnerArgs, { detached: true, stdio: ["pipe", "ignore", "ignore"], env: runnerEnv });
    const handoff = await writeRunnerPrompt(runner, prompt, promptHandoffTimeoutMs ? { timeoutMs: promptHandoffTimeoutMs } : {});
    if (handoff === "timeout") {
      // runner 活着却一直不读提示词：结束它（它还没起 worker），抛出后走下方的派发前回滚。
      try { runner.kill(); } catch { /* 已退出 */ }
      throw new Error(PROMPT_HANDOFF_TIMEOUT_TEXT);
    }
    runner.unref();
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
