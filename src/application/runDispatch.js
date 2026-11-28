// src/application/runDispatch.js
//
// M9-2A: Shared application service for background run dispatch.
//
// This module owns the dispatch side of CLI `run --background` and MCP `run_dispatch`:
// generating/validating a runId, creating the transcript, writing the initial
// durable facts (background_submitted → pending), and spawning the detached
// background runner. It is the single place where CLI and MCP both dispatch a
// supervised background run.
//
// Architectural contract:
//   - No argv parsing, no console.log, no process.exit.
//   - Does not import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Depends on transcript.js (JsonlTranscript), delivery.js (isValidRunId),
//     and runnerLaunch.js (detached runner 的唯一启动口；spawnFn 注入缝经它传递).
//   - prompt stays a bounded task prompt — never injects Lead orchestration context.

import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { JsonlTranscript, STATE_CHANGE_REASON, transcriptPathFor, isPersistableOwnerTaskType } from "../transcript.js";
import { isValidRunId, prepareDeliveryRequest } from "../delivery.js";
import { resolveWaitTimeout, validateBoundedWaitTimeout } from "./timeoutPolicy.js";
import { readRegistry, effectiveRegistryView } from "../registry.js";
import { assessWorkerReadiness, createEnvResolver } from "./credentialReadiness.js";
import { inheritedEnvNames } from "../envPolicy.js";
import { resolveReuseTurn, resolveLineageFirstTurn, releaseLineageFirstTurn, deriveLineageOpaqueUuid } from "./sessionReuse.js";
import { proveWorkspaceRoot } from "./workspaceBinding.js";
import { identifyProjectFromCwd, productionProjectIo, projectFactFromCwd } from "../projectIdentity.js";
import { resolveRunDirForWrite, projectFactForWrite, resolveTranscriptPath, claimRunIdForWrite, releaseRunIdClaim, claimAgeMs, maxNewTranscriptDirLength, TranscriptResolutionError } from "../projectBuckets.js";
import { laneFingerprint as laneFingerprintOf } from "./identityProjection.js";
import { effectiveSessionReuse } from "../dispatchResolution.js";
import { PROMPT_HANDOFF_TIMEOUT_MS, PROMPT_HANDOFF_TIMEOUT_TEXT, promptStdinArgs } from "../runnerPrompt.js";
import { loadRoleContract, roleContractSha256, composeRoleContractWithIdentity, composeDeliveryRoleContract, composeTaskPromptWithDeliveryVerification } from "./roleContract.js";
import { openRunnerStderrFd, runnerStderrPath } from "./runnerStderr.js";
// TD-347（第 93 批）：runner 的唯一启动口——Windows 缺省经 WMI 启动桥（不随宿主
// 重启 MCP 服务而死）；spawnFn 注入 / WAO_RUNNER_LAUNCH=spawn / 非 Windows 走
// 本进程 spawn。同层 application import。
import { launchRunner, runnerLaunchFailureText } from "./runnerLaunch.js";
import { assertExistingDispatchCwd, assertValidModelOverride, assertValidReasoningOverride, resolvePredictedDispatchCwd } from "../runManager.js";
// R7-C (C-2): application→backends is a legal DOWNWARD edge under the frozen
// L4 layering SSOT (backends sits deeper than application). Used only to read
// the declared preflightInvocation capability for the cwd gate below — the
// same SSOT factory every dispatch-adjacent construction point shares.
import { backendFor as defaultBackendFor } from "../backends/factory.js";

// R7-AB: the working-directory existence early-refusal SSOT (the typed
// DispatchCwdNotFoundError + the shared assert) lives in src/runManager.js —
// the core-layer spawn authority — so RunManager.start throws the SAME typed
// error with ONE class definition across both authorities. This module
// imports it DOWNWARD (application→core, the same direction as its existing
// ../transcript.js / ../delivery.js / ../registry.js imports); a sibling
// src/application/ home is not importable from core under the frozen L4
// layering SSOT (core→application is an upward edge and the upward whitelist
// is exactly empty — a NEW CORE_TOP module would be legal, but hosting with
// the spawn authority follows the existing typed-error precedent). Re-exported
// here to keep this module's established typed-error import surface stable
// (callers and tests import the dispatch typed errors from runDispatch.js).
export { DispatchCwdNotFoundError } from "../runManager.js";
// R10-A: re-export the per-dispatch model override SSOT (shape constants +
// validator) from its core home (runManager.js — the synthesis site), keeping
// this module's established "typed-error/SSOT import surface stable" pattern.
// The MCP boundary imports the wire pattern from HERE, never from core
// directly, mirroring the DispatchCwdNotFoundError precedent.
export { isValidModelOverride, assertValidModelOverride, MODEL_OVERRIDE_MAX, MODEL_OVERRIDE_WIRE_PATTERN } from "../runManager.js";
// R11-1: re-export the per-dispatch reasoning effort override SSOT (closed-set
// validators + the REASONING_EFFORTS enum the wire schema serializes) through
// the same downward re-export channel — core (runManager.js, with the
// synthesis site / registry.js, the enum home) holds the SSOT, application
// re-exports, CLI/MCP import from HERE so the boundaries cannot drift from the
// core validator (the MODEL_OVERRIDE hosting precedent).
export { isValidReasoningOverride, assertValidReasoningOverride, REASONING_EFFORTS } from "../runManager.js";

// M11-7: thrown when a worker's REQUIRED credential is missing at dispatch time.
// Carries the missing env NAMES (never values). Callers (MCP) collapse to a
// fixed actionable text.
export class CredentialMissingError extends Error {
  constructor(missingNames) {
    super(`credential missing: ${missingNames.join(", ")}`);
    this.name = "CredentialMissingError";
    this.missingCredentialEnvNames = missingNames;
  }
}

// M11-11C: thrown when a reusable expert already has an active (non-terminal)
// run for the same Lead session + workspace + agent. Carries the active runId
// for server-side routing only — it is NEVER surfaced via MCP. Callers (MCP)
// collapse this to a fixed actionable busy text (contract 6).
export class ReuseBusyError extends Error {
  constructor(activeRunId) {
    super("sessionReuse: prior run still active");
    this.name = "ReuseBusyError";
    this.activeRunId = activeRunId;
  }
}

// Round 4 Bundle B: thrown when a dispatch declares BOTH readOnly and a
// delivery block. A read-only run is advisory observation, never a delivery —
// the combination is contradictory and refused before ANY side effect (zero
// transcript, zero fork). Mirrors the CredentialMissingError form: a typed
// class the MCP adapter recognizes by error.name and collapses to a fixed
// actionable text carrying the closed-set reason code. No dynamic payload.
export class ReadOnlyDeliveryConflictError extends Error {
  constructor() {
    super(
      "dispatchRun: readOnly is mutually exclusive with a delivery block "
      + "(read_only_delivery_conflict) — a read-only run is advisory observation, never a delivery",
    );
    this.name = "ReadOnlyDeliveryConflictError";
    this.reasonCode = "read_only_delivery_conflict";
  }
}

// R10-A: thrown when a per-dispatch model override is combined with a
// provider-session reuse dispatch — EITHER shape: a reusable expert
// (sessionReuse:"lead_workspace") or a continuable delivery lineage root.
// Two turns of one provider-native conversation must run one model; a
// turn-scoped override would silently split the conversation across models
// and break the provider session contract. Mirrors the typed-error form of
// this module (stable error.name + closed-set reasonCode + fixed actionable
// text, no dynamic payload); the MCP adapter recognizes it by error.name and
// collapses it to its own fixed text. Thrown BEFORE any transcript write,
// routing-slot claim, or fork.
export class ModelOverrideConflictError extends Error {
  constructor(reuseShape) {
    const shape = reuseShape === "run_lineage" ? "run_lineage" : "lead_workspace";
    super(
      "dispatchRun: modelOverride is mutually exclusive with provider-session reuse "
      + `(${shape}) — a provider conversation resumed across turns must run one model. `
      + "Drop the model override, or dispatch a non-reusable agent.",
    );
    this.name = "ModelOverrideConflictError";
    this.reasonCode = "model_override_reuse_conflict";
    this.reuseShape = shape;
  }
}

// R11-1: thrown when a per-dispatch reasoning effort override is combined with
// a provider-session reuse dispatch — EITHER shape (a reusable expert or a
// continuable delivery lineage root). Same contract as the model override
// above: two turns of one provider-native conversation must run one reasoning
// effort; a turn-scoped override would silently split the conversation across
// effort levels. Mirrors the ModelOverrideConflictError form (stable
// error.name + closed-set reasonCode `reasoning_override_reuse_conflict` +
// fixed actionable text, no dynamic payload); the MCP adapter recognizes it by
// error.name and collapses it to its own fixed text. Thrown BEFORE any
// transcript write, routing-slot claim, or fork.
export class ReasoningOverrideConflictError extends Error {
  constructor(reuseShape) {
    const shape = reuseShape === "run_lineage" ? "run_lineage" : "lead_workspace";
    super(
      "dispatchRun: reasoningOverride is mutually exclusive with provider-session reuse "
      + `(${shape}) — a provider conversation resumed across turns must run one `
      + "reasoning effort. Drop the reasoning override, or dispatch a non-reusable agent.",
    );
    this.name = "ReasoningOverrideConflictError";
    this.reasonCode = "reasoning_override_reuse_conflict";
    this.reuseShape = shape;
  }
}

// 2026-10-04: continuable/correctable eligibility refusals — typed so the MCP
// boundary can surface fixed reason-code texts instead of the opaque generic
// "run_dispatch failed" (a cross-project session lost two dispatches to that
// opacity and concluded — wrongly — that kimi-web cannot root a continuable
// lineage; the real cause was a stale hand-mirrored backend list in the MCP
// resolver, consult_20261004192559512mefa3k). Family contract as above: stable
// error.name + closed-set reasonCode, thrown BEFORE any transcript write,
// lineage-slot claim, or fork (the capability gates precede the lineage claim
// by construction). Messages are internal (CLI/local stderr); the MCP adapter
// collapses to its own fixed texts — never echoed dynamic payload.
export class ContinuableDeliveryOnlyError extends Error {
  constructor() {
    super("dispatchRun: continuable is delivery-only (a continuation lineage is rooted in a delivery run)");
    this.name = "ContinuableDeliveryOnlyError";
    this.reasonCode = "continuable_delivery_only";
  }
}

export class ContinuableBackendUnsupportedError extends Error {
  constructor() {
    super("dispatchRun: continuable delivery requires a backend that supports provider session reuse");
    this.name = "ContinuableBackendUnsupportedError";
    this.reasonCode = "continuable_backend_unsupported";
  }
}

export class CorrectableBackendUnsupportedError extends Error {
  constructor() {
    super("dispatchRun: correctable requires a backend that declares supportsInFlightCorrection");
    this.name = "CorrectableBackendUnsupportedError";
    this.reasonCode = "correctable_backend_unsupported";
  }
}

// TD-110 (D2 A3): thrown when a sessionReuse:"lead_workspace" agent is
// dispatched WITHOUT a bound workspace (cwd). The message is the pre-existing
// closed-set text (byte-identical to the old bare Error) — the typed class is
// a pure addition so the CLI background dispatch catch can recognize it by
// error.name and append ONE static guidance line naming the --cwd flag.
// No payload is carried: never echoes cwd paths, Lead ids, or provider data.
export class SessionReuseWorkspaceRequiredError extends Error {
  constructor() {
    super("dispatchRun: bound workspace (cwd) is required for a sessionReuse agent");
    this.name = "SessionReuseWorkspaceRequiredError";
  }
}

// Round 6 Bundle R6-A (F-5-12): thrown when a CLI delivery dispatch carries a
// delivery block but NO explicit --cwd. dispatchRun builds the background
// delivery ownership record (run.background_submitted.cwd, appended below from
// this exact input) — the authority `runs delivery review` verifies against.
// Without it the run is only rejected at REVIEW time ("malformed ownership:
// run.background_submitted.cwd is missing or empty"), after the worker has
// already burned the whole execution chain. The CLI boundary
// (commands/run.js) refuses with this typed error at the argv layer, BEFORE
// any side effect (zero transcript, zero fork, zero worktree). Same closed-set
// form as the typed errors above: stable error.name for scriptable capture,
// fixed actionable text, no dynamic payload. The service-level contract is
// deliberately unchanged — the MCP boundary always threads the host-proven
// workspace root as cwd (this error is unreachable there), and direct service
// callers keep the pinned delivery-without-cwd behavior (runDispatch.test.js
// M9-7A / M12-6-FR05 / M12-25-ROUT-5).
export class DeliveryCwdRequiredError extends Error {
  constructor() {
    super(
      "delivery run requires an explicit --cwd <target project> "
      + "— the delivery ownership record (run.background_submitted.cwd) is built from it; "
      + "refusing before any side effect (re-run with --cwd <target project>)",
    );
    this.name = "DeliveryCwdRequiredError";
    this.reasonCode = "delivery_cwd_required";
  }
}

// Default path to the detached runner. Resolved relative to this module so the
// service stays independent of the caller's cwd (CLI vs MCP vs test).
const DEFAULT_RUNNER_PATH = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "backgroundRunner.js",
);

const DEFAULT_POLL_INTERVAL = 1000;

// M12-25 (Outcome 2): the providerSessionRouting closed set — the ROUTING
// REQUEST truth dispatchRun exposes, derived ONLY from the internal routing
// turn it already selected. It states what routing dispatch REQUESTED, never
// whether the provider accepted/resumed:
//   not_used              — no provider-session routing was requested (ordinary
//                           non-reuse dispatch, or a rejected dispatch).
//   first_turn_requested  — dispatch requested the FIRST turn of a provider
//                           session (a reusable expert's first turn, or a
//                           continuable delivery lineage root).
//   resume_requested      — dispatch requested RESUMING an existing provider
//                           session (a reusable expert's follow-up turn).
// The routing MODE (lead_workspace / run_lineage), the opaque session uuid,
// Lead ids, workspace paths, argv, and provider payload are NEVER exposed. The
// MCP wire schema derives its enum from this frozen array (single SSOT).
export const PROVIDER_SESSION_ROUTING = Object.freeze([
  "not_used",
  "first_turn_requested",
  "resume_requested",
]);

/**
 * Derive the bounded providerSessionRouting value from the internal routing
 * turn dispatchRun selected. Only the TURN matters (first → first_turn_requested,
 * resume → resume_requested); the mode, opaque uuid, and priorRunId are
 * intentionally dropped.
 * @param {{mode:string, opaqueUuid:string, turn:string, priorRunId?:string}|null} routing
 * @returns {"not_used"|"first_turn_requested"|"resume_requested"}
 */
function deriveProviderSessionRouting(routing) {
  if (!routing) return "not_used";
  if (routing.turn === "first") return "first_turn_requested";
  if (routing.turn === "resume") return "resume_requested";
  return "not_used";
}

// 决定 0133：缺省（自动）续修没开成时的 continuableOff 闭集——只含派发服务会产出的
// 原因（MCP 输出枚举由它派生），数组顺序即判定的先后：前四项在凭据预检后一次判完
// （autoContinuableOffReason），argv_budget 在写谱系槽之前预判（lineageLaunchOverBudget），
// lineage_slot_unavailable 是写槽本身没成（忙或存储故障）。
// read_only / lead_workspace 不在内：它们与"带交付的派发"互斥在更早处就被拒
// （ReadOnlyDeliveryConflictError；delivery 恒不走 lead_workspace 复用），到不了
// 自动判定。CLI 前台不经本服务，原因恒为 CONTINUABLE_OFF_FOREGROUND（前台 CLI
// 不能建谱系）。
export const CONTINUABLE_OFF_REASONS = Object.freeze([
  "no_workspace",
  "override",
  "backend_unsupported",
  "session_reuse_unavailable",
  "argv_budget",
  "lineage_slot_unavailable",
]);
export const CONTINUABLE_OFF_FOREGROUND = "foreground";

// runner 参数总长的派发前保守上限（Windows 命令行预算之内留余量）。
const ARGV_MAX_TOTAL = 24000;
const argvLength = (args) => args.reduce((sum, a) => sum + String(a).length + 1, 0);

/**
 * 决定 0133：缺省（自动）续修的判定——带交付的派发才会走到这里。返回 null = 开；
 * 否则返回 CONTINUABLE_OFF_REASONS 的成员（任一条件不满足即静默关闭，不报错）。
 * 后端能力只读声明（supportsSessionReuse + 环境条件 sessionReuseUnavailableReason），
 * 不认运行时名。backend 缺省已由调用方回落共享工厂（cwdGateBackend）；只有注入的
 * 解析器对该后端返回 null、或工厂构造不出时才是 null，按不支持处理（fail-closed，
 * 与显式 continuable 的 ContinuableBackendUnsupportedError 同口径）。
 * workspaceRoot：谱系 workspace 的证明结果（与 run_continue 同一个 proveWorkspaceRoot）；
 * 没有绑定工作区、或证明不过（null）都算 no_workspace。
 * @returns {string|null}
 */
function autoContinuableOffReason({ cwd, workspaceRoot, hasOverride, backend, resolvedCredentials }) {
  if (typeof cwd !== "string" || cwd.length === 0 || workspaceRoot === null) return "no_workspace";
  if (hasOverride) return "override";
  if (!backend || backend.supportsSessionReuse !== true) return "backend_unsupported";
  const unavailable = typeof backend.sessionReuseUnavailableReason === "function"
    ? backend.sessionReuseUnavailableReason({ resolvedCredentials })
    : null;
  return unavailable === null || unavailable === undefined ? null : "session_reuse_unavailable";
}

/**
 * 决定 0133：缺省（自动）续修的两层命令行预算预判——快速路径，在写谱系槽之前先把
 * 明显放不下的挡掉（不建槽、不留痕）。返回 true = 开了谱系会放不下（调用方静默关闭，
 * 原因 argv_budget）。【以真实检查为准】：这里的估算（转录目录取上界等）可能低估，
 * 槽写入之后真实的 runner 参数检查若超限，派发里会撤回自己的槽、用不带谱系的参数
 * 重建（见 dispatchRun 的 fallBackToOrdinary）。
 *   1. runner 参数：带上谱系路由 + 身份材料参数，再加转录目录参数（取上界——真实
 *      桶要等 runId claim 之后才定）后超过 ARGV_MAX_TOTAL；
 *   2. worker 启动：后端有 preflightInvocation 就带上会话复用参数用后端自己的预检
 *      再算一遍（与 RunManager.start 的预检同一调用形状，包括 correctable，不复制
 *      预算逻辑）；只有"不带谱系能过、带谱系过不了"才算谱系引起——不带谱系本来就
 *      过不了的派发与谱系无关，不归在这里；后端没有预检就跳过这一层。
 * 副作用：不建目录、不写文件、不留残留；但后端预检在 Windows 上、agent 没配
 * binary 时会起只读的 `where` 查找进程（带谱系的预检失败后为归因再试一次不带谱系的，
 * 最多两次）。
 */
async function lineageLaunchOverBudget({
  buildRunnerArgs, routing, material, transcriptDirBound, backend, agent, prompt, roleContract, correctable,
}) {
  const transcriptDirArgsLength = "--transcript-dir".length + 1 + transcriptDirBound + 1;
  if (argvLength(buildRunnerArgs(routing, material)) + transcriptDirArgsLength > ARGV_MAX_TOTAL) {
    return true;
  }
  if (typeof backend.preflightInvocation !== "function") return false;
  // 与真实 spawn 一致：可纠偏运行 spawn 时带 correctable（claude-code 因此多出
  // --input-format stream-json），预检也要带，否则会放行实际超限的启动。
  const spawnShape = correctable ? { correctable: true } : {};
  try {
    await backend.preflightInvocation(agent, { prompt, roleContract, sessionReuse: routing, ...spawnShape });
    return false;
  } catch {
    // 下面归因：不带谱系也过不了 → 不是谱系引起。
  }
  try {
    await backend.preflightInvocation(agent, { prompt, roleContract, ...spawnShape });
  } catch {
    return false;
  }
  return true;
}

/**
 * 派发前预判用的转录目录路径长度估计：这个 runId 已有转录就取它所在目录（精确），
 * 否则取新桶的最坏长度（maxNewTranscriptDirLength，与桶命名规则同源；displayName
 * 最长 40）。只读。注意它不是处处可证的上界——新 run 可能复用同一项目里更早建的、
 * 更长的桶——所以只作快速路径，真实检查在转录目录定下之后（见 dispatchRun）。
 */
function transcriptDirLengthBound(runDir, runId, workspace) {
  try {
    return dirname(resolveTranscriptPath(runDir, runId, { forAppend: true })).length;
  } catch {
    // 新 run（桶还没定）或解析冲突——真实流程会在后面照常抛，这里只要保守估计。
  }
  try {
    return maxNewTranscriptDirLength(runDir, identifyProjectFromCwd(workspace, productionProjectIo()));
  } catch {
    // 身份读不出：按最长的项目桶名估（displayName 上限 40）。
    return maxNewTranscriptDirLength(runDir, { kind: "project", displayName: "x".repeat(40) });
  }
}

/**
 * runner 起动时交给后端预检的最终角色合同（身份头 + 角色正文 + 交付合同），与
 * RunManager.start 同一拼法：同样的加载器、composeRoleContractWithIdentity、
 * composeDeliveryRoleContract（allowedPaths 取与 runner 一致的 prepareDeliveryRequest
 * 结果）。后端不承载角色注入时 runner 会在更早处拒绝，这里返回 undefined。
 */
function composeLaunchRoleContract({
  agentId, backend, roleShaSource, executedRoleId, resolvedLane, publicDelivery,
}) {
  if (backend.supportsRoleContract !== true) return undefined;
  let roleContract;
  if (roleShaSource) {
    const identity = typeof resolvedLane === "string" && typeof executedRoleId === "string"
      ? { laneId: resolvedLane, roleId: executedRoleId }
      : undefined;
    roleContract = composeRoleContractWithIdentity({
      roleContract: loadRoleContract(roleShaSource),
      agentId,
      ...(identity ? { identity } : {}),
    });
  }
  return composeDeliveryRoleContract({
    roleContract,
    allowedPaths: prepareDeliveryRequest(publicDelivery).allowedPaths,
    backendSupplement: backend.deliveryContractSupplement,
  });
}

/**
 * Generate a runId in the same format RunManager uses.
 * @returns {string}
 */
function generateRunId() {
  return `run_${new Date().toISOString().replace(/[-:.TZ]/g, "")}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Dispatch a supervised background run.
 *
 * Writes the initial transcript durable facts and spawns the detached runner
 * that owns the worker handle lifecycle. Returns a structured result; the
 * caller (CLI/MCP) is responsible for any console output formatting.
 *
 * @param {object} input
 * @param {string} input.agentId — required worker id
 * @param {string} input.prompt — required bounded task prompt
 * @param {string} input.registryPath — path to agents.json
 * @param {string} input.runDir — path to runs/ directory
 * @param {string} [input.runId] — optional custom runId (validated)
 * @param {string} [input.cwd] — optional worker cwd. REQUIRED in practice for a
 *   delivery dispatch: it is the sole source of the background ownership record
 *   (run.background_submitted.cwd). The CLI boundary refuses a delivery dispatch
 *   without it up front (typed DeliveryCwdRequiredError, commands/run.js argv
 *   gate); the MCP boundary always supplies the host-proven workspace root.
 *   R7-AB: the PREDICTED cwd (this argument when non-empty, else the registry
 *   entry's agent.cwd) must resolve to an existing directory — otherwise the
 *   dispatch is refused with DispatchCwdNotFoundError before any side effect
 *   (R7-C C-2: capability-gated on the selected backend's preflightInvocation
 *   — HTTP backends, whose cwd is a remote directory hint, are exempt,
 *   mirroring RunManager.start).
 * @param {number} [input.waitTimeout] — explicit override (range-validated 1000..600000)
 * @param {number} [input.globalWaitTimeout] — server-owned global config.waitTimeout (trusted)
 * @param {number} [input.pollInterval]
 * @param {string} [input.scorecardRules] — raw JSON string
 * @param {string} [input.scorecardMode]
 * @param {boolean} [input.requireCertified=false] — propagated to runner + RunManager
 * @param {Function} [input.spawnFn] — injectable spawn (tests)
 * @param {Function} [input.launchRunnerFn] — injectable runner-launch module (tests; default launchRunner)
 * @param {number} [input.promptHandoffTimeoutMs] — injectable prompt-handoff bound (tests)
 * @param {string} [input.runnerPath] — override detached runner path
 * @param {string} [input.execPath] — override node executable (defaults to process.execPath)
 * @returns {Promise<{accepted:boolean, runId:string, state:string, transcriptPath?:string, terminalState?:string}>}
 */
export async function dispatchRun({
  agentId,
  prompt,
  registryPath,
  runDir,
  runId,
  cwd,
  waitTimeout,
  globalWaitTimeout,
  pollInterval,
  scorecardRules,
  scorecardMode,
  requireCertified = false,
  spawnFn,
  // 第 93 批续修 1：启动模块注入缝（测试用；缺省 launchRunner）。
  launchRunnerFn,
  promptHandoffTimeoutMs,
  runnerPath,
  execPath,
  delivery,
  resolvedCredentials,
  userEnvReader,
  // M11-11C: server-owned Lead session identity. Required for a
  // lead_workspace reuse dispatch only (a run_lineage root derives its identity
  // from the lineage's own pinned facts, never the Lead session). Generated/
  // injected by the MCP server (stable per server/Lead session) — never supplied
  // by the model, never returned via MCP. CLI callers pass a one-shot id
  // (always first turn).
  leadSession,
  // M12-6 (P1-A): server-proven frozen HEAD (the MCP boundary's binding.gitHead),
  // threaded to the detached runner as --frozen-git-head so RunManager.start can
  // revalidate the source HEAD against it and pin the worktree base. Never model-
  // supplied — expectedGitHead is the model-owned counterpart and is consumed at
  // the MCP boundary. Absent for CLI callers (argv unchanged).
  frozenGitHead,
  // Optional backend resolver (MCP / CLI inject the shared factory wrapper;
  // absent → the shared factory default). The ONE constructed instance
  // (cwdGateBackend) serves the cwd gate and the continuable capability checks
  // — explicit and auto alike — so unsupported runtimes fail (explicit) or turn
  // auto off (默认) before the lineage slot/transcript/fork. 决定 0133.
  backendFor,
  // M12-7: marks this delivery as the root of a continuable lineage: dispatch
  // establishes the lineage provider session with turn:first so a future
  // Lead-authorized run_continue can resume the SAME provider-native
  // conversation in the retained worktree.
  // 决定 0133 三态：true = 显式开（delivery-only；做不到按具名错误拒绝）；
  // false = 显式关（不建谱系）；缺省 = 自动——带交付的派发在 autoContinuableOffReason
  // 全部满足时才开，任一不满足就静默关闭、派发照常（与非续修派发逐字节相同）。
  // 非布尔值一律按缺省（自动）处理。
  continuable,
  // M12-16: Lead opt-in marking this run as correctable — a follow-up user turn
  // may be queued to the RUNNING provider process via run_correct (the
  // transcript-backed durable queue the detached runner drains over stdin).
  // Requires the selected backend to declare supportsInFlightCorrection (gated
  // below, before any transcript write/fork). Default false = byte-compatible
  // ordinary dispatch (argv/stdin/events unchanged).
  correctable = false,
  // 决定 0133 测试缝：谱系槽存储（缺省真实 .lineage-reuse；测试注入失败形状的
  // createLineageStore(runDir, io)）。写槽与撤槽都走它。
  lineageStore,
  // M11-7: skip the credential preflight (e.g. when the caller already did it
  // and is passing resolvedCredentials). Default false = always check.
  skipCredentialCheck = false,
  // Round 4 Bundle B: Lead read-only DECLARATION (advisory observation, never
  // a gate). readOnly is mutually exclusive with a delivery block (typed
  // ReadOnlyDeliveryConflictError before any side effect) and compatible with
  // correctable / sessionReuse (a correction is a Lead-ordered instruction —
  // declaration and observation coexist). Threaded to the detached runner as
  // --isolate --read-only so RunManager.start forces isolation and writes the
  // exactly-once run.read_only_declared fact. Default false = byte-compatible.
  readOnly = false,
  // 隔离三态（前台 --isolate/--no-isolate 的原样穿线）：true → runner argv 得
  // --isolate；false → --no-isolate；undefined（都不给）→ 不传，runner 沿用
  // 配置。delivery 与 readOnly 的强制隔离不受它影响（冲突组合在 CLI 边界
  // runCommand 已有拒绝）。
  isolate,
  // 标签（--tag key=value，可重复）：全部穿线到 runner argv（每个一条
  // --tag），runner 收齐后按与前台相同的形状传 RunManager.start（parseTags
  // 接受 string | string[]）。undefined（不给）= argv 无 --tag。
  tags,
  // 决定 0131 §5：派发时已知的任务类型（会审席给 plan_review / delivery_review），
  // 以 --task-type 交给 runner，由 RunManager.start 固化进 run.started.taskType。
  // 闭集 SSOT = transcript.js 的 OWNER_TASK_TYPES（且不是 "untyped"）；null /
  // undefined = 不传（argv 与事件字节不变）。
  taskType = null,
  // R10-A: per-dispatch model override (--model <modelId> on the CLI, `model`
  // on MCP run_dispatch) — ONE dispatch only, never persisted to the registry.
  // Validated against the core SSOT (assertValidModelOverride) BEFORE any
  // transcript write or fork; mutually exclusive with EITHER provider-session
  // reuse shape (typed ModelOverrideConflictError below). Threaded to the
  // detached runner as --model <id> (the --cwd precedent), restored by
  // backgroundRunner's parseSimpleFlags, and applied by RunManager.start's
  // synthesis (siblings preserved — see runManager.js). The shape gate's
  // "--"-prefix rule is what keeps parseSimpleFlags from splitting the pair.
  // Absent = byte-compatible dispatch (argv unchanged).
  modelOverride = null,
  // R11-1: per-dispatch reasoning effort override (--reasoning <effort> on the
  // CLI, `reasoning` on MCP run_dispatch) — ONE dispatch only, never persisted
  // to the registry. Validated against the core SSOT (assertValidReasoning-
  // Override — the closed REASONING_EFFORTS set) BEFORE any transcript write
  // or fork; mutually exclusive with EITHER provider-session reuse shape (typed
  // ReasoningOverrideConflictError below); composable with modelOverride.
  // Threaded to the detached runner as --reasoning <effort> (the --model pair
  // precedent), restored by backgroundRunner's parseSimpleFlags, and applied by
  // RunManager.start's synthesis ({...(agent.reasoning ?? {}), effort} —
  // sibling fields preserved). Absent = byte-compatible dispatch (argv
  // unchanged).
  reasoningOverride = null,
  // 0045 W2b：显式车道+角色派发（CLI --lane/--role 穿线；MCP 面第 5 步再开）。
  resolvedLane = null,
  resolvedRole = null,
  // 0045 W4b：别名/显式派发的解析角色（生效复用策略按角色取——R4 裁定归角色）。
  // 决定 0114 修订：只给此值不给 resolvedRole 时，同一值也进 runner 的 --role
  // 与冻结材料——runner 复核的角色必须就是它实际执行的角色。
  resolvedRoleId = null,
  // 0045 W4d：解析来源注记。别名派发也走 --lane/--role（执行语义）时由 CLI
  // 显式带上 "--resolved-from alias"，runner 仍把 run.started.resolvedFrom 记成
  // alias（身份注记不退化成 explicit）；缺席=不传、字节兼容。
  resolvedFrom = null,
  // 0052 P0-3：fresh 逃生口——Lead 裁量的会话重置（强制 first + epoch+1）。
  // 只作用于 lead_workspace 复用决策；delivery 本就永远 fresh（无操作语义）；
  // 不旁路 busy（Contract 6）。对 continuable 谱系无操作（谱系代数=谱系自辖）。
  fresh = false,
  // TD-341（第 89 批 A）：runner stderr 文件打开器注入缝（缺省 openRunnerStderrFd；
  // 测试注入"打开失败"形状）。返回值作为 spawn stdio[2] 的 fd。
  openRunnerStderrFn,
  // b158a：车道四轴合并的启用车道表（null/undefined = 停用）。由调用方按
  // lanesDocForCall / isPairedDefaultRegistry 的同一配对规则显式传入；启用时
  // 本函数解析的 agent（凭据预检/复用身份/谱系材料/runner argv 的来源）走
  // effectiveRegistryView 的生效条目，车道表不可用即以 lanes_merge_unavailable
  // 拒绝（不回退私有旧四轴）。
  lanesMerge = null,
}) {
  if (!agentId || typeof agentId !== "string") {
    throw new Error("dispatchRun: agentId is required");
  }
  if (!prompt || typeof prompt !== "string") {
    throw new Error("dispatchRun: prompt is required");
  }
  if (!registryPath || typeof registryPath !== "string") {
    throw new Error("dispatchRun: registryPath is required");
  }
  if (!runDir || typeof runDir !== "string") {
    throw new Error("dispatchRun: runDir is required");
  }

  // Round 4 Bundle B: readOnly × delivery is a contradictory declaration —
  // refuse it FIRST, before any validation side effect, transcript write, or
  // fork (zero orphaned pending transcript). readOnly × continuable needs no
  // new code: continuable is delivery-only, so the existing gate below
  // ("continuable is delivery-only") naturally refuses that combination.
  if (readOnly && delivery) {
    throw new ReadOnlyDeliveryConflictError();
  }

  // R10-A: shape-validate a supplied model override BEFORE any transcript
  // write or fork (the CLI/MCP boundaries validate the same SSOT contract —
  // this is the service-level re-check for direct programmatic callers). A
  // malformed id must fail-closed with zero transcripts and zero forks; the
  // fixed text never echoes the supplied value.
  if (modelOverride !== null && modelOverride !== undefined) {
    assertValidModelOverride(modelOverride);
  }

  // R11-1: shape-validate a supplied reasoning effort override BEFORE any
  // transcript write or fork (the same service-level re-check discipline as
  // the model override above). A value outside the closed set must fail-closed
  // with zero transcripts and zero forks; the fixed text never echoes the
  // supplied value.
  if (reasoningOverride !== null && reasoningOverride !== undefined) {
    assertValidReasoningOverride(reasoningOverride);
  }
  // 决定 0131 §5：taskType 的服务层形状门——同上两道（任何转录写入与 fork 之前；
  // 固定文案不回显收到的值）。
  if (taskType !== null && taskType !== undefined && !isPersistableOwnerTaskType(taskType)) {
    throw new Error(
      "dispatchRun: taskType must be a member of OWNER_TASK_TYPES other than \"untyped\" "
      + "(task_type_invalid) — omit it, or pass one of the closed-set values.",
    );
  }

  // M10-pre closeout: validate explicit waitTimeout BEFORE any transcript write or fork.
  // The explicit value comes from CLI --wait-timeout or a trusted internal caller.
  // MCP run_dispatch schema does NOT accept waitTimeout — the model cannot set it.
  // It must pass full production range [1000, 600000]. An invalid value must fail-closed
  // with zero transcript, zero fork — no orphaned pending transcript.
  // validateBoundedWaitTimeout throws on out-of-range/NaN/non-integer.
  if (waitTimeout !== undefined && waitTimeout !== null) {
    validateBoundedWaitTimeout(waitTimeout);
  }
  // M10-pre closeout-2: validate server-owned globalWaitTimeout too.
  // A corrupted config/default.json or broken internal caller could pass an out-of-range
  // value. Same boundary gate, same fail-closed semantics: zero transcript, zero fork.
  // MCP run_dispatch schema does NOT accept globalWaitTimeout — the model cannot set it.
  if (globalWaitTimeout !== undefined && globalWaitTimeout !== null) {
    validateBoundedWaitTimeout(globalWaitTimeout);
  }

  // Validate runId BEFORE any file write or fork. Custom runIds reach transcript
  // paths and runner argv; reject early to prevent path traversal / injection.
  // Reuses the isValidRunId SSOT (same as runManager.js / delivery.js).
  const finalRunId = runId ?? generateRunId();
  if (!isValidRunId(finalRunId)) {
    throw new Error(
      `Invalid runId (contains path separators, shell metacharacters, or traversal): ${JSON.stringify(finalRunId)}`,
    );
  }

  // M9-7A: validate delivery BEFORE any transcript write or fork.
  // prepareDeliveryRequest is the SSOT — it enforces mode/path/verification rules.
  // The validated result has internal shape {verification:{commands,unavailableReason}},
  // but RunManager.start expects the public shape {verificationCommands|verificationUnavailableReason}.
  // Convert to public shape here — do NOT let runner or RunManager re-implement conversion.
  const validatedDelivery = delivery ? prepareDeliveryRequest(delivery) : null;
  const publicDelivery = validatedDelivery ? {
    mode: validatedDelivery.mode,
    allowedPaths: validatedDelivery.allowedPaths,
    ...(validatedDelivery.verification.commands.length > 0
      ? { verificationCommands: validatedDelivery.verification.commands }
      : { verificationUnavailableReason: validatedDelivery.verification.unavailableReason }),
    // M12-6 (FR-05): forward Lead-authored setup commands when declared.
    ...(validatedDelivery.verification.setupCommands?.length > 0
      ? { verificationSetupCommands: validatedDelivery.verification.setupCommands }
      : {}),
    // M12-13: forward the per-command execution timeout when declared. Absent →
    // the --delivery-json payload stays byte-identical (zero drift on the wire).
    ...(validatedDelivery.verification.verificationTimeoutMs !== undefined
      ? { verificationTimeoutMs: validatedDelivery.verification.verificationTimeoutMs }
      : {}),
  } : null;

  // 第 157 批（TD-386）：runner 交给后端的最终任务正文 = Lead 的原始正文 + 本轮生效的
  // 验证清单块（同一个组装函数，开始/续修/resume 与这里字节一致）。提示词放命令行的
  // 后端会把这份正文编译进 argv，所以下面的启动预算预判必须看到加块之后的该正文——
  // 用原始正文会低估，放行一个真实启动必拒的派发。prompt.sent / 转录不记这一块。
  const taskPrompt = composeTaskPromptWithDeliveryVerification(prompt, validatedDelivery?.verification);

  const resolvedRunDir = resolve(runDir);
  const resolvedRegistry = resolve(registryPath);

  // M11-7: credential preflight BEFORE any transcript write or fork. Reads the
  // registry to resolve the agent, then assesses credential availability via the
  // shared SSOT. A missing REQUIRED credential throws CredentialMissingError
  // (zero transcript, zero fork). The resolved VALUES are threaded into the
  // runner env so the worker child inherits them (and the redactor scrubs them).
  // Dispatch resolves ALL inherited env names (required + optional) so optional
  // Codex config is bridged too — unlike lead_preflight workers, which only read
  // required names. One operation-scoped resolver per dispatch (no cross-op cache).
  //
  // M11-11C: the agent is ALWAYS resolved here (not only when credential
  // preflight runs) so the sessionReuse policy can be read for reuse resolution
  // below. The credential check reuses the same agent instance.
  let finalCredentials = resolvedCredentials ?? {};
  const registry = effectiveRegistryView(await readRegistry(resolvedRegistry), lanesMerge);
  const agent = registry.getAgent(agentId);
  // TD-198 (2026-10-03): the ABSOLUTE ownership cwd for the background
  // ownership record + the detached runner argv, derived through the SAME
  // resolvePredictedDispatchCwd authority RunManager.start normalizes with —
  // explicit --cwd wins, else the registry entry's cwd, resolved against THIS
  // process's cwd (exactly the semantics the runner child would apply: it
  // inherits this process's cwd). A relative fact carries no workspace
  // identity (the ownership verifier rejects it); this makes every NEW
  // background ownership fact absolute from birth.
  const ownershipCwd = resolvePredictedDispatchCwd({ explicitCwd: cwd, agentCwd: agent.cwd })?.path;

  // R7-C (C-3, hoisted precedence): the TD-110 (D2 A3) typed refusal for a
  // sessionReuse agent dispatched WITHOUT a bound workspace must keep its
  // documented contract in the corner where the registry entry's cwd is ALSO
  // bad — pre-R7-AB that typed error (with the CLI's --cwd guidance) owned the
  // face; the R7-AB existence assert below took it over. Same relative order
  // as the reuse block (leadSession first, then cwd) is preserved, and BOTH
  // sit before resolveReuseTurn, so the zero-routing-slot discipline (CE-6)
  // is unchanged. The checks inside the reuse block below remain as
  // defense-in-depth.
  // 0045 R4/W4b："终局复用策略归角色"——生效政策经 effectiveSessionReuse（角色
  // 政策优先；席位字段仅在派发角色=席位原生角色时兼容生效；跨帽/显式绝不继承）。
  // 0052 洞②修订：显式派发（lane 与/或 role）不再被排除出复用路由——生效政策
  // 本身就是分级开关（显式 role 派发读 roles.json[roleId]，lane-only/裸派对齐
  // 席位兼容语义）。delivery 永远 fresh 不变；护栏（失败即弃/epoch/fresh）在
  // resolveReuseTurn 内。
  // 决定 0114 修订（材料复核同源）：runner 实际执行的角色是唯一的权威值——
  // 调用方给了 resolvedRole 就用它；只给 resolvedRoleId（如会审别名席位）时，
  // 同一个值既进 runner 的 --role，也进冻结材料，不再让派发侧与 runner 复核
  // 侧各算一个角色（角色政策仍按 resolvedRoleId 注解取）。无角色 dispatch
  // 仍回落席位 systemPrompt。
  const executedRoleId = resolvedRole !== null && resolvedRole !== undefined
    ? resolvedRole
    : (resolvedRoleId !== null && resolvedRoleId !== undefined ? resolvedRoleId : null);
  const effectiveReuse = effectiveSessionReuse({
    roleId: resolvedRoleId,
    agent,
  });
  const reuseEligible = effectiveReuse === "lead_workspace" && !publicDelivery;
  // 0045 §1.6/R4 键材料升维（只增不减）：可复用/可续接的新 run，键材料追加
  // 车道内容指纹 + 角色正文指纹（无角色="none" 显式标记）。派发时刻从注册表
  // 冻结（run.started 尚未写）——角色文件不可载在此具名失败（零转录零 fork）。
  // 0052 P0-2：角色指纹取【这次实际交给 runner 执行的角色】正文，席位
  // systemPrompt 只作无角色 dispatch 的 legacy 兜底。
  const roleShaSource = executedRoleId !== null
    ? `config/roles/${executedRoleId}.md`
    : (agent.systemPrompt || null);
  const buildReuseIdentityMaterial = () => ({
    laneFingerprint: laneFingerprintOf({
      backend: agent.backend,
      modelId: agent.model?.id ?? null,
      providerID: agent.model?.providerID ?? null,
      // 决定 0106：providerKey 维恒为 null（provider 通道退役）。
      providerKey: null,
    }),
    roleSha256: roleShaSource
      ? roleContractSha256(loadRoleContract(roleShaSource))
      : "none",
  });
  // 决定 0133：显式 true 与复用专家在此照旧冻结；缺省（自动）续修要等凭据预检、
  // correctable 资格检查之后才知道开不开，开了再冻结（见下方谱系块；角色合同
  // 加载出错不盖掉前面的拒绝码）。
  let reuseIdentityMaterial = (reuseEligible || continuable === true)
    ? buildReuseIdentityMaterial()
    : {};
  // R10-A: a per-dispatch model override can never ride a provider-session
  // reuse dispatch — EITHER shape. lead_workspace: a resumed expert
  // conversation spans turns that must run one model. run_lineage (continuable
  // delivery root): the same contract for the lineage conversation (and
  // run_continue later re-reads the registry without any override —
  // runManager.js resume — so turn N+1 could not even honor the override).
  // Refused HERE — before the routing-slot claims, transcript writes, and the
  // fork — with the typed ModelOverrideConflictError (zero side effects).
  // R11-1: the SAME refusal now fires for ANY override in play — a reasoning
  // effort override must not split a resumed conversation across effort levels
  // either (typed ReasoningOverrideConflictError). When BOTH overrides are
  // supplied the model conflict fires first (deterministic; both are refused).
  const hasOverride = (modelOverride !== null && modelOverride !== undefined)
    || (reasoningOverride !== null && reasoningOverride !== undefined);
  if (hasOverride && (reuseEligible || continuable === true)) {
    if (modelOverride !== null && modelOverride !== undefined) {
      throw new ModelOverrideConflictError(reuseEligible ? "lead_workspace" : "run_lineage");
    }
    throw new ReasoningOverrideConflictError(reuseEligible ? "lead_workspace" : "run_lineage");
  }
  if (reuseEligible) {
    if (typeof leadSession !== "string" || leadSession.length === 0) {
      throw new Error("dispatchRun: leadSession is required for a sessionReuse agent (server-owned Lead session identity)");
    }
    if (typeof cwd !== "string" || cwd.length === 0) {
      throw new SessionReuseWorkspaceRequiredError();
    }
  }

  // R7-AB (layer 1): working-directory existence early-refusal, shared SSOT
  // with RunManager.start (../runManager.js — same typed error, same
  // prediction semantics). The PREDICTED cwd is the directory the worker spawn
  // will run in: the explicit cwd argument when it is a non-empty string, else
  // the registry entry's agent.cwd (registry normalization requires that field
  // non-empty, so the skip branch inside the assert is defensive only). A
  // missing directory — or a path that exists but is a file — refuses with the
  // typed DispatchCwdNotFoundError BEFORE the credential preflight, any
  // sessionReuse/lineage slot claim, any transcript write, and the fork: a
  // nonexistent cwd used to surface only at runner spawn time as a misleading
  // "spawn <node.exe> ENOENT" spawn_error (Node blames the cwd option on the
  // executable), after the transcript was already written. Sitting between the
  // registry resolution and the credential preflight keeps the refusal
  // deterministic across environments (machine env cannot mask it).
  //
  // R7-C (C-2): capability-gated, mirroring layer 2 (runManager.js) — the SAME
  // declared capability the M12-14 invocation-budget preflight keys on. A
  // backend implementing preflightInvocation composes a LOCAL OS invocation
  // and spawns with cwd: agent.cwd (the ENOENT-blames-the-executable trap); an
  // HTTP backend (no preflightInvocation) threads cwd to
  // the serve API as a REMOTE directory hint — no local spawn, no local
  // ENOENT trap — and is exempt, exactly as docs/usage.md promises and as
  // layer 2 already exempts it (symmetric semantics: local-spawn backends are
  // checked at BOTH layers, HTTP backends at NEITHER). The backend instance is
  // resolved through the caller-injected backendFor when present (the
  // continuable/correctable precedent) and the shared factory otherwise —
  // construction is side-effect-free, and agent.backend has already passed
  // registry normalization, so the factory cannot throw here.
  const cwdGateBackend = typeof backendFor === "function"
    ? backendFor(agent)
    : defaultBackendFor(agent);
  if (typeof cwdGateBackend?.preflightInvocation === "function") {
    assertExistingDispatchCwd({ explicitCwd: cwd, agentCwd: agent.cwd });
  }

  if (!skipCredentialCheck) {
    const resolver = createEnvResolver(userEnvReader);
    const readiness = await assessWorkerReadiness({
      agent, resolver, names: inheritedEnvNames(agent),
    });
    if (readiness.credentialAvailability === "missing") {
      throw new CredentialMissingError(readiness.missingCredentialEnvNames);
    }
    finalCredentials = Object.fromEntries(
      Object.entries({ ...finalCredentials, ...readiness.resolvedEnv })
        .filter(([, v]) => typeof v === "string" && v.length > 0),
    );
  }

  // 决定 0133：续修谱系根的最终判定。显式 true 照旧（下方 continuable 块里按
  // 具名错误拒绝）；显式 false 不建；缺省（自动）只对带交付的派发判定——凭据预检
  // 已完成，令牌类环境条件（backend.sessionReuseUnavailableReason）用的就是预检解析
  // 出的 finalCredentials。能力解析器只读已构造的后端（构造零副作用，不按名分支）。
  // 自动关闭时 continuableOff 带回闭集原因（回显给调用方）；非交付派发不带。
  // 能力判定（自动与显式一样）用已构造好的 cwdGateBackend——注入的解析器优先，
  // 缺省回落共享工厂，不再取决于调用方传没传解析器。
  const lineageBackend = cwdGateBackend;
  // 谱系 workspace = 与 run_continue 同一个证明函数（proveWorkspaceRoot：realpath +
  // git 给出的盘上大小写的 Git 顶层）得出的根——不是 path.resolve 的结果，否则大小写
  // 不同的写法、junction 路径会让首轮与续修算出不同的 opaque uuid（claude-code 的
  // --resume 指向一个从未建立的会话）。MCP 传进来的本来就是证明过的根，结果不变。
  // 证明不过（非 Git 顶层、不存在……）= null：自动按 no_workspace 关闭，显式 true
  // 用现有的"需要工作区"错误拒绝（见谱系块）。只对可能建谱系的交付派发证明。
  let lineageWorkspace = null;
  if (publicDelivery && continuable !== false && typeof cwd === "string" && cwd.length > 0) {
    try {
      lineageWorkspace = proveWorkspaceRoot(ownershipCwd ?? cwd).root;
    } catch {
      lineageWorkspace = null;
    }
  }
  let lineageRoot = continuable === true;
  let continuableOff = null;
  if (typeof continuable !== "boolean" && publicDelivery) {
    continuableOff = autoContinuableOffReason({
      cwd, workspaceRoot: lineageWorkspace, hasOverride, backend: lineageBackend, resolvedCredentials: finalCredentials,
    });
    lineageRoot = continuableOff === null;
  }

  // M11-11C: expert session reuse — strictly NON-DELIVERY (delivery dispatch
  // always starts a fresh backend conversation). Resolve the reuse turn
  // (first/resume/busy) BEFORE the transcript write or fork. On busy, throw
  // ReuseBusyError (zero transcript, zero fork — contract 6). The opaque
  // routing {mode, opaqueUuid, turn[, priorRunId]} is threaded to the detached
  // runner via argv; the opaque uuid is the ONLY identifier handed to the
  // provider (--session-id/--resume). ADR-0031 §3.6/R2: the RESUME envelope
  // additionally carries the prior WAO runId (internal identifier, never a
  // credential) so the runner can recover the provider session id from the
  // prior transcript SSOT — the provider session id itself never enters argv.
  // Raw Lead id / workspace / agentId never enter MCP output or the bounded
  // audit event. The routing slot is claimed under a per-key file lock so two
  // concurrent dispatches for the same identity cannot both fork (the second
  // observes the first as busy). §3.6 fail-closed: a damaged routing entry or
  // an unaddressable prior session refuses here (zero transcript, zero fork).
  //
  // R7-C (C-3): reuseEligible and its two refusals (leadSession / cwd-empty)
  // are computed/hoisted ABOVE the cwd existence assert — see the hoisted
  // block near the registry resolution. The two checks repeated inside this
  // block are defense-in-depth (unreachable via this path; they keep the
  // block self-contained if the hoist is ever restructured).
  let sessionReuseRouting = null;
  if (reuseEligible) {
    if (typeof leadSession !== "string" || leadSession.length === 0) {
      throw new Error("dispatchRun: leadSession is required for a sessionReuse agent (server-owned Lead session identity)");
    }
    if (typeof cwd !== "string" || cwd.length === 0) {
      throw new SessionReuseWorkspaceRequiredError();
    }
    const reuseDecision = await resolveReuseTurn({
      runDir: resolvedRunDir,
      runId: finalRunId,
      leadSession,
      workspace: cwd,
      agentId,
      fresh,
      ...reuseIdentityMaterial,
    });
    if (reuseDecision.kind === "busy") {
      throw new ReuseBusyError(reuseDecision.activeRunId);
    }
    sessionReuseRouting = reuseDecision.routing;
  }

  // M12-16: correctable opt-in gate. Only a backend that declares
  // supportsInFlightCorrection (a provider-neutral capability boolean) may
  // accept a correctable run — read the declared capability, never branch on
  // the runtime name. This runs BEFORE the continuable lineage-slot claim (and
  // before any transcript write / fork) so a dispatch opting into BOTH
  // continuable + correctable on a backend that supports session reuse but NOT
  // in-flight correction fails closed WITHOUT first claiming — and so leaking —
  // a busy lineage slot. Non-opt-in dispatch skips this entirely (byte-compatible).
  if (correctable) {
    const correctionBackend = typeof backendFor === "function" ? backendFor(agent) : null;
    if (!correctionBackend || correctionBackend.supportsInFlightCorrection !== true) {
      throw new CorrectableBackendUnsupportedError();
    }
  }

  // Construct runner argv BEFORE any transcript write. All static preflight
  // (argv length guard, delivery validation) must happen before a single
  // durable fact is written — otherwise a rejected dispatch leaves an
  // orphaned pending transcript with no owner.
  // 决定 0133：构造收成 buildRunnerArgs(routing, material)——缺省（自动）续修在写
  // 谱系槽之前要用它预判"带上谱系参数后放不放得下"，真正的 runnerArgs 在谱系块
  // 之后用同一个函数构造（不复制）。
  const _execPath = execPath ?? process.execPath;
  // 第 93 批续修 1：启动模块注入缝（缺省真实 launchRunner；测试注入失败形状）。
  const _launchRunner = launchRunnerFn ?? launchRunner;
  const _runnerPath = runnerPath ?? DEFAULT_RUNNER_PATH;
  // TD-341：runner stderr 打开器注入缝（缺省真实打开；测试注入失败形状）。
  const _openRunnerStderrFd = openRunnerStderrFn ?? openRunnerStderrFd;
  // M10-pre: only pass --wait-timeout to runner when explicitly set.
  // RunManager resolves timeout from agent > config > default internally.
  const effectivePollInterval = pollInterval ?? DEFAULT_POLL_INTERVAL;

  const buildRunnerArgs = (routing, material) => {
    const runnerArgs = [
      _runnerPath,
      agentId,
      // 提示词经标准输入交给 runner（见下方 spawn），不进命令行；argv 只带它的摘要。
      ...promptStdinArgs(prompt),
      "--run-dir", resolvedRunDir,
      "--run-id", finalRunId,
      "--registry", resolvedRegistry,
      "--poll-interval", String(effectivePollInterval),
    ];
    // M10-pre: only pass --wait-timeout when explicitly provided (CLI override).
    // RunManager resolves from agent.waitTimeout > config.waitTimeout > default.
    if (waitTimeout !== undefined && waitTimeout !== null) {
      runnerArgs.push("--wait-timeout", String(waitTimeout));
    }
    // M10-pre closeout: thread server-owned global config.waitTimeout to the runner.
    // This is NOT --wait-timeout (which would become "explicit" in precedence).
    // The runner sets RunManager config.waitTimeout from this value, so the full
    // precedence explicit > agent > global > default is preserved in the detached process.
    if (globalWaitTimeout !== undefined && globalWaitTimeout !== null) {
      runnerArgs.push("--global-wait-timeout", String(globalWaitTimeout));
    }
    // TD-198: the runner argv keeps threading the RAW --cwd flag value when one
    // was given — the runner's RunManager.start normalizes idempotently against
    // its inherited cwd (the CLI's), and HTTP backends treat
    // cwd as a REMOTE hint that must not be silently replaced by a locally
    // resolved path. The ABSOLUTE ownership fact lives in
    // run.background_submitted.cwd above, not in the argv.
    if (cwd) runnerArgs.push("--cwd", cwd);
    // R10-A: thread the per-dispatch model override to the detached runner (the
    // --cwd pair precedent). Included in the argv-length guard below by
    // construction (the reduce covers the whole runnerArgs array).
    if (modelOverride !== null && modelOverride !== undefined) {
      runnerArgs.push("--model", modelOverride);
    }
    // R11-1: thread the per-dispatch reasoning effort override to the detached
    // runner (the --model pair precedent). Included in the argv-length guard
    // below by construction. A closed-set member can never start with "--", so
    // parseSimpleFlags restores the pair exactly.
    if (reasoningOverride !== null && reasoningOverride !== undefined) {
      runnerArgs.push("--reasoning", reasoningOverride);
    }
    // 0045 W2b：显式车道+角色派发穿线到 detached runner（--model 对先例）。runner
    // 侧经 dispatchResolution 单一真相重解析（R3 裁定"启动前重查一致性"——CLI 与
    // runner 起动间 lanes.json/注册表可能已变）；配对完整性由解析器闭集把关。
    if (resolvedLane !== undefined && resolvedLane !== null) {
      runnerArgs.push("--lane", resolvedLane);
    }
    if (executedRoleId !== null) {
      runnerArgs.push("--role", executedRoleId);
    }
    if (resolvedFrom === "alias") {
      runnerArgs.push("--resolved-from", "alias");
    }
    if (scorecardRules) runnerArgs.push("--scorecard-rules", scorecardRules);
    if (scorecardMode) runnerArgs.push("--scorecard-mode", scorecardMode);
    if (requireCertified) runnerArgs.push("--require-certified");
    if (publicDelivery) {
      runnerArgs.push("--isolate");
      runnerArgs.push("--delivery-json", JSON.stringify(publicDelivery));
    }
    // Round 4 Bundle B: a read-only declaration forces isolation on the runner
    // path too (this closes the gap above — the --isolate push used to be
    // delivery-only, so a non-delivery readOnly dispatch would have reached the
    // runner unisolated) and threads the declaration as --read-only so
    // RunManager.start persists the exactly-once declaration fact. Mutually
    // exclusive with delivery (refused above) — the two blocks never coexist.
    if (readOnly) {
      runnerArgs.push("--isolate");
      runnerArgs.push("--read-only");
    }
    // 隔离三态穿线（--isolate→true / --no-isolate→false / 都不给→不传）。
    // delivery 与 readOnly 已在上方强制 --isolate，此时不再叠加用户旗标
    //（它们与 --no-isolate 的冲突由 CLI 边界 runCommand 拒绝，这里保持 argv 干净）。
    if (!publicDelivery && !readOnly) {
      if (isolate === true) {
        runnerArgs.push("--isolate");
      } else if (isolate === false) {
        runnerArgs.push("--no-isolate");
      }
    }
    // 标签穿线：--tag key=value 可重复，全部进 argv（runner 侧收齐多值）。
    if (tags !== undefined && tags !== null) {
      const tagList = Array.isArray(tags) ? tags : [tags];
      for (const tag of tagList) {
        runnerArgs.push("--tag", tag);
      }
    }
    // 决定 0131 §5：任务类型交给 runner（--model 对先例）。闭集成员不会以 "--" 开头，
    // parseSimpleFlags 原样还原这一对；缺席 = argv 不变。
    if (isPersistableOwnerTaskType(taskType)) {
      runnerArgs.push("--task-type", taskType);
    }
    // M12-6 (P1-A): thread the server-proven frozen HEAD to the detached runner so
    // RunManager.start can revalidate/pin the base. Server-side argv only (never
    // returned via MCP); absent for CLI callers.
    if (frozenGitHead) {
      runnerArgs.push("--frozen-git-head", frozenGitHead);
    }
    // M11-11C: thread the resolved reuse routing to the detached runner. The
    // payload is opaque ({mode, opaqueUuid, turn[, priorRunId]}) — it carries no
    // raw Lead id, workspace path, agentId, or provider session id. The resume
    // turn's priorRunId is a WAO runId (internal handle to the transcript SSOT).
    // Detached-runner argv is server-side (never returned via MCP); the prompt
    // already travels the same channel.
    if (routing) {
      runnerArgs.push("--session-reuse-json", JSON.stringify(routing));
      // 0045 W3c（R4"runner 钉前比对"）：键材料冻结值随路由穿给 runner——runner
      // 从注册表重算并比对，不等=注册表在派发与起动间被改，具名 fail-closed。
      runnerArgs.push("--reuse-material-json", JSON.stringify(material));
    }
    // M12-16: thread correctable to the detached runner so RunManager.start spawns
    // the child with a piped stdin + the stream-json input format and drains the
    // correction queue. Server-side argv only (never returned via MCP).
    if (correctable) {
      runnerArgs.push("--correctable");
    }
    return runnerArgs;
  };

  // M12-7: continuable delivery = lineage ROOT. Establish the lineage provider
  // session (turn:first) under the lineage key (canonical workspace + agent +
  // rootRunId + the lane fingerprint and role sha pinned by THIS dispatch). A
  // future Lead-authorized run_continue resumes the SAME provider conversation
  // (turn:resume) against this rootRunId, reusing the retained worktree. The
  // key carries no Lead session, so a restarted host still resumes it.
  // Mutually exclusive with lead_workspace above (that gate is
  // non-delivery-only). 显式 true：delivery-only，忙碌的谱系槽在任何转录写入或
  // fork 之前拒绝。
  //
  // 决定 0133：谱系 workspace 取 lineageWorkspace（上方 proveWorkspaceRoot 证明的根，
  // 与 run_continue 重算 uuid 的那一份同源），不再用 CLI 传入的原样相对路径或
  // path.resolve 的结果——两边 opaque uuid 才对得上。
  //
  // 缺省（自动）：能力条件已在上方判完；这里先预判命令行预算（lineageLaunchOverBudget，
  // 快速路径、在写槽之前）再写槽。槽忙或槽存储故障（LineageSlotStorageError——只接这
  // 一类，编程错误照常抛）静默关闭（lineage_slot_unavailable）。写槽之后若真实的
  // 参数检查放不下、或同 runId 的转录仲裁被拒，撤回自己的槽（releaseAutoSlot，按内容
  // 核对只动自己那条）——自动模式绝不能把原本能派的任务变成派不出去，也不留槽记录。
  // 角色合同冻结放在 correctable 资格检查之后（上方），出错不盖掉原有拒绝码。
  let lineageRootRunId = null;
  let slotClaim = null; // 自动模式写下的谱系槽的撤回凭据（显式 true 不撤回，照旧）
  if (lineageRoot) {
    if (!publicDelivery) {
      throw new ContinuableDeliveryOnlyError();
    }
    if (typeof cwd !== "string" || cwd.length === 0 || lineageWorkspace === null) {
      throw new Error("dispatchRun: bound workspace (cwd) is required for a continuable delivery");
    }
    if (!lineageBackend || lineageBackend.supportsSessionReuse !== true) {
      throw new ContinuableBackendUnsupportedError();
    }
    const claimLineageSlot = () => resolveLineageFirstTurn({
      runDir: resolvedRunDir,
      runId: finalRunId,
      workspace: lineageWorkspace,
      agentId,
      ...reuseIdentityMaterial,
      rootRunId: finalRunId,
      reuseStore: lineageStore,
    });
    let firstTurn = null;
    if (continuable === true) {
      firstTurn = await claimLineageSlot();
      if (firstTurn.kind === "busy") {
        throw new ReuseBusyError(firstTurn.activeRunId);
      }
    } else {
      reuseIdentityMaterial = buildReuseIdentityMaterial();
      const probeRouting = {
        mode: "run_lineage",
        opaqueUuid: deriveLineageOpaqueUuid({
          workspace: lineageWorkspace, agentId, rootRunId: finalRunId, ...reuseIdentityMaterial,
        }),
        turn: "first",
      };
      if (await lineageLaunchOverBudget({
        buildRunnerArgs,
        routing: probeRouting,
        material: reuseIdentityMaterial,
        transcriptDirBound: transcriptDirLengthBound(resolvedRunDir, finalRunId, ownershipCwd ?? cwd),
        backend: lineageBackend,
        agent,
        // 第 157 批：预判看到 runner 交给后端的最终正文（含验证清单块）。
        prompt: taskPrompt,
        roleContract: composeLaunchRoleContract({
          agentId, backend: lineageBackend, roleShaSource, executedRoleId, resolvedLane, publicDelivery,
        }),
        correctable,
      })) {
        continuableOff = "argv_budget";
      } else {
        try {
          firstTurn = await claimLineageSlot();
        } catch (error) {
          if (error?.name !== "LineageSlotStorageError") throw error;
          firstTurn = null;
        }
        if (firstTurn === null || firstTurn.kind === "busy") {
          firstTurn = null;
          continuableOff = "lineage_slot_unavailable";
        } else {
          slotClaim = firstTurn.claim;
        }
      }
      if (firstTurn === null) {
        lineageRoot = false;
        reuseIdentityMaterial = {};
      }
    }
    if (firstTurn !== null) {
      sessionReuseRouting = firstTurn.routing;
      lineageRootRunId = finalRunId;
    }
  }

  // 自动模式写下的槽：撤回（compare-and-restore，只动 runId 是自己的那一条；
  // 撤回本身出错也不掩盖原路径的结果）。显式 true / 没写槽 = 无操作。
  const releaseAutoSlot = async () => {
    if (slotClaim === null) return;
    const claim = slotClaim;
    slotClaim = null;
    try {
      await releaseLineageFirstTurn({ runDir: resolvedRunDir, claim, reuseStore: lineageStore });
    } catch {
      // 撤回尽力而为——槽存储本来就可能是出故障的那一环。
    }
  };
  // 自动模式槽已写、但真实检查发现开不成：撤槽，路由与材料清空，回显关闭原因，
  // 调用方用不带谱系的参数重建。返回是否发生了回退（显式 true / 没谱系 = false）。
  const fallBackToOrdinary = async (reason) => {
    if (slotClaim === null) return false;
    await releaseAutoSlot();
    sessionReuseRouting = null;
    reuseIdentityMaterial = {};
    lineageRoot = false;
    lineageRootRunId = null;
    continuableOff = reason;
    return true;
  };

  let runnerArgs = buildRunnerArgs(sessionReuseRouting, reuseIdentityMaterial);

  // Conservative total argv length guard — BEFORE transcript write.
  // 决定 0133：真实检查为准——自动谱系把参数撑过上限时，不拒绝派发，回退成普通派发。
  if (argvLength(runnerArgs) > ARGV_MAX_TOTAL && await fallBackToOrdinary("argv_budget")) {
    runnerArgs = buildRunnerArgs(null, {});
  }
  const totalArgvLen = argvLength(runnerArgs);
  if (totalArgvLen > ARGV_MAX_TOTAL) {
    throw new Error(`runner argv too long (${totalArgvLen} > ${ARGV_MAX_TOTAL}); reduce delivery/scorecard size`);
  }

  // All preflight passed — now decide the transcript bucket ONCE (TD-190 D2-②b
  // decide-once：桶目录在本进程决定，经 --transcript-dir 显式传给 runner；
  // runner/RunManager 收到即用不重推——防 projects/x/projects/x 双重分桶与
  // "旧父进程配新 runner"孤儿形态，规格 §6.11-1）。
  const ownershipIdentity = identifyProjectFromCwd(ownershipCwd ?? cwd, productionProjectIo());
  // runId 跨层唯一性（M9-2A-03 合同保持）：已有转录（旧平铺或既有桶）→ 写
  // 原位（pending 终态拒绝等既有语义在该档上照常仲裁，不制造孪生）——复用
  // 分支同样传 --transcript-dir 指向既有档目录（验收批 S1：防 runner
  // legacyFlat 兜底在别层再造孪生）；全新 runId → 中心 .claims 原子仲裁
  // （并发首建竞态修复）→ 决定新桶。孪生冲突等具名错误如实上抛。
  let writeTarget = null;
  let transcriptPath;
  let claimed = false; // 复验 F1：claim 成功→首条事实落盘窗口标记
  let claimNonce = null; // 三轮 sol①：持有者标识（释放校验）
  try {
    transcriptPath = resolveTranscriptPath(resolvedRunDir, finalRunId, { forAppend: true });
    runnerArgs.push("--transcript-dir", dirname(transcriptPath));
  } catch (e) {
    if (e?.code !== "transcript-not-found") {
      await releaseAutoSlot();
      throw e;
    }
    const claim = claimRunIdForWrite(resolvedRunDir, finalRunId);
    if (!claim.claimed) {
      // 并发写者正在建同 runId：按既有档重解析一次；仍找不到=如实冲突（附
      // claim 年龄与 TTL 提示——三轮 R3：中段泄漏的报错不得误导为永久并发）。
      let claimAgeNote = "";
      const ageMs = claimAgeMs(resolvedRunDir, finalRunId);
      if (ageMs !== null) claimAgeNote = ` (existing claim age ${Math.round(ageMs / 1000)}s; stale claims self-heal after 600s)`;
      try {
        transcriptPath = resolveTranscriptPath(resolvedRunDir, finalRunId, { forAppend: true });
        runnerArgs.push("--transcript-dir", dirname(transcriptPath));
      } catch {
        await releaseAutoSlot();
        throw new TranscriptResolutionError("transcript-resolution-conflict",
          `runId ${finalRunId} concurrently claimed by another writer (or claim I/O failure — permission/disk) and not resolvable after re-check${claimAgeNote}`);
      }
    } else {
      // 复验 F1：claim 生命周期=仲裁成功→首条事实落盘（background_submitted）。
      // 窗口内任何抛错（含下方零副作用拒绝）都释放；落盘后同 runId 走既有档
      // 分支，claim 即废。释放=对持有代加 .released 标记（nonce 校验，不删文件）。
      claimNonce = claim.nonce;
      try {
        writeTarget = resolveRunDirForWrite(resolvedRunDir, ownershipIdentity);
        transcriptPath = transcriptPathFor(writeTarget.transcriptDir, finalRunId);
        runnerArgs.push("--transcript-dir", writeTarget.transcriptDir);
        claimed = true;
      } catch (e2) {
        releaseRunIdClaim(resolvedRunDir, finalRunId, { nonce: claimNonce });
        await releaseAutoSlot();
        throw e2;
      }
    }
  }
  // 三轮 sol⑥：argv 终检覆盖**所有路径决定分支**（既有档复用分支同样在
  // --transcript-dir 追加后必须复查——只查新建分支曾漏检 24041>24000）。
  // 决定 0133：这是真实检查（转录目录已定）。自动谱系把它撑过上限时，不拒绝派发：
  // 撤回自己的槽，用不带谱系的参数（+同一个 --transcript-dir）重建，再按普通派发
  // 复查——与显式 false 逐字节相同；显式 true 照旧报错。
  {
    let finalArgvLen = argvLength(runnerArgs);
    if (finalArgvLen > ARGV_MAX_TOTAL && slotClaim !== null) {
      const dirArg = runnerArgs[runnerArgs.lastIndexOf("--transcript-dir") + 1];
      if (await fallBackToOrdinary("argv_budget")) {
        runnerArgs = [...buildRunnerArgs(null, {}), "--transcript-dir", dirArg];
        finalArgvLen = argvLength(runnerArgs);
      }
    }
    if (finalArgvLen > ARGV_MAX_TOTAL) {
      if (claimed) releaseRunIdClaim(resolvedRunDir, finalRunId, { nonce: claimNonce });
      await releaseAutoSlot();
      throw new Error(`runner argv too long after transcript-dir (${finalArgvLen} > ${ARGV_MAX_TOTAL}); reduce delivery/scorecard size`);
    }
  }

  // All preflight passed — now write transcript durable facts.（复验 F1：构造/
  // 首条追加若抛错同样释放 claim——窗口终点=background_submitted 落盘。）
  let transcript;
  try {
    transcript = new JsonlTranscript(transcriptPath, { runId: finalRunId, agentId });
  } catch (e3) {
    if (claimed) releaseRunIdClaim(resolvedRunDir, finalRunId, { nonce: claimNonce });
    await releaseAutoSlot();
    throw e3;
  }

  // Initial durable facts, in order: background_submitted, then pending.
  try {
    await transcript.append("run.background_submitted", {
    background: true,
    // B 审计臂（kimi 诊断批 2026-10-10，Owner 批准）：MCP 实例启动时解析的父进程
    // 镜像名（stdio.js 置于本进程 env；经 buildChildEnv 白名单不进 worker）。
    // 只记录不拦截——MCP-launched 派发的溯源事实（如 kimi.exe 拉起的 MCP 实例）。
    // CLI/runner 等非 MCP 进程无此变量=字段缺席（byte-compatible）。
    ...(typeof process.env.WAO_MCP_PARENT_IMAGE === "string" && process.env.WAO_MCP_PARENT_IMAGE.length > 0
      && process.env.WAO_MCP_PARENT_IMAGE.length <= 64
      ? { mcpParentImage: process.env.WAO_MCP_PARENT_IMAGE }
      : {}),
    // TD-198: the ABSOLUTE resolved ownership cwd (explicit --cwd or the
    // registry entry, resolved) — a relative fact is unprovable workspace
    // identity. ownershipCwd is null only in the defensive no-prediction
    // corner; fall back to the raw flag value so the fact is never silently
    // dropped.
    cwd: ownershipCwd ?? cwd,
    scorecardConfigured: Boolean(scorecardRules),
    // Durable before the detached runner starts so startup failures still
    // preserve whether the Lead requested a delivery.
    deliveryRequested: Boolean(publicDelivery),
    // M12-16: durable correctable marker. The MCP correction service reads this
    // stable fact to gate run_correct (a correction may only queue against a
    // run dispatched correctable). Written before the runner forks.
    ...(correctable ? { correctable: true } : {}),
    // TD-190 D2-②a/②b：首事件落档有界桶归属事实——读侧以记录事实为准不再重
    // 推导，规则演进不拆旧桶；bucket 记**最终写入位置**（resolveRunDirForWrite
    // 的结果，碰撞扩长后与目录一致——规格 §6.1）。
    project: writeTarget
      ? projectFactForWrite(ownershipIdentity, writeTarget)
      : projectFactFromCwd(ownershipCwd ?? cwd),
    });
  } catch (e4) {
    if (claimed) releaseRunIdClaim(resolvedRunDir, finalRunId, { nonce: claimNonce });
    await releaseAutoSlot();
    throw e4;
  }

  // 复验 F1：首条持久事实已落盘——同 runId 的并发写者此后经既有档分支可
  // 见本档，claim 使命完成即释放（不残留、不阻断后续同名新档仲裁）。
  if (claimed) releaseRunIdClaim(resolvedRunDir, finalRunId, { nonce: claimNonce });

  // pending via transitionState — first-terminal-wins arbitration. If the
  // runId was reused against an already-terminal transcript, this is rejected
  // and we must NOT fork the detached runner.
  const pendingResult = await transcript.transitionState(null, "pending", STATE_CHANGE_REASON.background_spawned);
  if (!pendingResult.accepted) {
    // 决定 0133：被拒的派发没 fork、没建成谱系根——自动模式写下的槽撤回（不留记录）。
    await releaseAutoSlot();
    return {
      accepted: false,
      runId: finalRunId,
      agentId,
      state: pendingResult.state,
      transcriptPath,
      terminalState: pendingResult.state,
      // M12-25: a rejected dispatch never requested a provider session.
      providerSessionRouting: "not_used",
      // 决定 0133：被拒的派发没有建成谱系根。
      continuable: false,
    };
  }

  // M11-11C: persist a BOUNDED routing audit fact for reusable runs (contract
  // 8). Carries only {mode, turn} — never the opaque uuid, Lead id, workspace,
  // prompt, argv, or provider payload. Non-reusable runs write nothing here.
  if (sessionReuseRouting) {
    await transcript.append("run.session_reuse", {
      mode: sessionReuseRouting.mode,
      turn: sessionReuseRouting.turn,
      // M12-7: persist the lineage root for run_lineage routing so a future
      // run_continue can resolve the lineage key from any parent transcript.
      // Absent for lead_workspace (zero drift). Carries only the WAO runId —
      // never the opaque uuid, Lead id, or workspace.
      ...(sessionReuseRouting.mode === "run_lineage" && lineageRootRunId
        ? { rootRunId: lineageRootRunId }
        : {}),
    });
  }

  // detached: runner survives CLI/MCP process exit; stdin carries the prompt
  // (written and closed here), stdout ignored (runner writes transcript).
  // unref so the parent does not wait for it.
  // TD-347（第 93 批）：spawn 的形状与提示词/stderr 交接收进启动模块 runnerLaunch
  // ——Windows 缺省经 WMI 启动桥（宿主重启 MCP 服务不再连坐 runner），spawnFn
  // 注入 / WAO_RUNNER_LAUNCH=spawn / 非 Windows 走本进程直起（形状不变）。
  // TD-341（第 89 批 A）：stderr 落每运行文件 .runner-<runId>.stderr（打开失败
  // 退回 "ignore"）。runner 以码 0 退出且文件为空时由其退出钩子删除该文件，
  // 其余情形（非空、失败、被杀、V8 abort）都留下。
  // M11-7: thread resolved credential VALUES into the runner's env (NOT argv —
  // values must never appear in argv). The runner's ProcessBackend then inherits
  // them via process.env (buildChildEnv) and redacts them (createSecretRedactor).
  //   凭据经 env 进载荷（WMI 路径）或直接进 spawn env（spawn 路径），绝不出现在
  //   桥的命令行里。
  const runnerEnv = { ...process.env, ...finalCredentials };
  const launch = await _launchRunner({
    execPath: _execPath,
    args: runnerArgs,
    env: runnerEnv,
    cwd: process.cwd(),
    prompt,
    stderrPath: runnerStderrPath(resolvedRunDir, finalRunId),
    runId: finalRunId,
    timeoutMs: promptHandoffTimeoutMs ?? PROMPT_HANDOFF_TIMEOUT_MS,
    spawnFn,
    openStderrFn: () => _openRunnerStderrFd(resolvedRunDir, finalRunId),
  });
  if (launch.outcome !== "started") {
    // 结束未确认（runner_kill_unconfirmed，续修 1）：runner 可能还活着——只写
    // run.error，**不转 failed**（转录保持 pending，交给 wao runs settle 判定），
    // 抛固定文字。其余失败码统一收口（可能已起的 runner 已由启动模块结束并
    // 确认）：run.error + failed + 抛错，不留 pending 转录。提示词交接超时沿用
    // 既有事实形状与文案；spawn 抛错保留原始错误对象（M12-7-RC-16 同款语义在
    // 调用侧不变）。
    if (launch.reason === "runner_kill_unconfirmed") {
      // 文字点名 runId：Lead 要拿它去 settle（MCP 报错面不带 runId）。
      const text = `${runnerLaunchFailureText(launch.reason)}（run ${finalRunId}）`;
      await transcript.append("run.error", { phase: "runner_start", error: text });
      const unconfirmed = new Error(text);
      unconfirmed.reasonCode = launch.reason;
      unconfirmed.runId = finalRunId;
      throw unconfirmed;
    }
    const isPromptHandoff = launch.reason === "handoff_timeout" || launch.reason === "prompt_handoff_timeout";
    const thrown = launch.reason === "spawn_error" && launch.detail instanceof Error
      ? launch.detail
      : new Error(runnerLaunchFailureText(launch.reason));
    await transcript.append("run.error", {
      phase: isPromptHandoff ? "prompt_handoff" : "runner_start",
      error: isPromptHandoff ? PROMPT_HANDOFF_TIMEOUT_TEXT : String(thrown.message ?? runnerLaunchFailureText(launch.reason)),
    });
    await transcript.transitionState("pending", "failed", STATE_CHANGE_REASON.startup_error);
    throw thrown;
  }

  return {
    accepted: true,
    runId: finalRunId,
    // M11-8B: echo the canonical agentId so the Lead gets a unified identity
    // from dispatch onward. This is the registry id the caller supplied —
    // the same value the transcript envelope will carry — never worker text.
    agentId,
    state: "pending",
    transcriptPath,
    // R10-A: the EFFECTIVE model this dispatch will run — the registry model
    // with ONLY `.id` replaced by the override (siblings preserved, mirroring
    // RunManager.start's synthesis over the same registry read). Advisory
    // echo so a mistyped model id is visible at dispatch time, before the
    // provider rejects it turns later. Present ONLY when an override was
    // supplied; the MCP handler selects its own exact output keys, so this
    // field never reaches the MCP wire.
    ...(modelOverride !== null && modelOverride !== undefined
      ? { effectiveModel: { ...(agent.model ?? {}), id: modelOverride } }
      : {}),
    // R11-1: the EFFECTIVE reasoning policy this dispatch will run — the
    // registry reasoning with ONLY `.effort` replaced by the override
    // (siblings preserved, mirroring RunManager.start's synthesis over the
    // same registry read). Advisory echo symmetric to effectiveModel; present
    // ONLY when an override was supplied; the MCP handler selects its own
    // exact output keys, so this field never reaches the MCP wire.
    ...(reasoningOverride !== null && reasoningOverride !== undefined
      ? { effectiveReasoning: { ...(agent.reasoning ?? {}), effort: reasoningOverride } }
      : {}),
    // M12-25: ROUTING REQUEST truth, derived only from the routing turn selected
    // above. Describes what dispatch requested, never provider success. Exposes
    // only the closed-set value — never the mode, opaque uuid, Lead id, or workspace.
    providerSessionRouting: deriveProviderSessionRouting(sessionReuseRouting),
    // 决定 0133：这次派发是不是续修谱系根（所有派发都带）；缺省（自动）下带交付的
    // 派发没开成时再带闭集原因 continuableOff（非交付派发、显式关闭都不带）。
    continuable: lineageRoot,
    ...(continuableOff !== null ? { continuableOff } : {}),
  };
}
