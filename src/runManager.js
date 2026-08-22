import { mkdir } from "node:fs/promises";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { JsonlTranscript, TERMINAL_STATES, STATE_CHANGE_REASON, readTranscript, findState, findLatestBound, findFirstBound, projectCorrections } from "./transcript.js";
import { createWorktree, removeWorktree } from "./isolation.js";
import { checkScorecard } from "./scorecard.js";
import { raiseAlert } from "./alerts.js";
import { writeFrictionLog, frictionLogDirFromRunDir } from "./frictionLog.js";
import { assessRunEvidence } from "./runEvidenceAssessment.js";
import { createSecretRedactor } from "./secretRedaction.js";
import { prepareDeliveryRequest, packageDelivery as defaultPackageDelivery, proveLinkedWorktree, isValidRunId, DeliveryError } from "./delivery.js";
import { verifyDelivery as defaultVerifyDelivery, createCallerGate } from "./deliveryVerification.js";
import { loadRoleContract, composeRoleContractWithIdentity, composeDeliveryExecutionContract } from "./application/roleContract.js";
import { assessWorkerReadiness, createEnvResolver, readWindowsUserEnv } from "./application/credentialReadiness.js";
import { inheritedEnvNames } from "./envPolicy.js";
import { validateSessionReuseRouting } from "./application/sessionReuse.js";
import { WRITE_INTENT_CORRELATION_STATUS, DONE_MARKERS } from "./runEvent.js";
import { ISOLATION_VIOLATION_REASONS } from "./diagnosis.js";
// R11-1: the closed effort set SSOT lives in the registry (its historical
// home since M11-9); the per-dispatch override validators below are hosted
// HERE, with the synthesis site, mirroring the MODEL_OVERRIDE precedent.
// Re-exported so the downward channel (runDispatch.js) hands the CLI/MCP
// boundaries ONE import surface for the whole override SSOT — same hosting
// discipline as MODEL_OVERRIDE_MAX/_WIRE_PATTERN below.
import { REASONING_EFFORTS } from "./registry.js";
export { REASONING_EFFORTS };
// R23-C: the providerKey fingerprint normalizer (single implementation, src
// host) — matchedCertRecord below compares the record-side providerKey against
// the CURRENT agent.provider derivation, same judgment the reliability
// writers (scripts/run-reliability.mjs agentInfo / matrix.normalizeCase) used
// at certification time. Same src-relative import shape as the line above.
import { providerKeyFor } from "./providerFingerprint.js";

/**
 * RunManager 持有活跃 run 的生命周期。
 * 显式状态机：pending → submitted → running → {completed|failed|aborted|timed_out}
 *
 * M0 临时桥接：通过 backend.waitForCompletion 驱动状态转移（而非消费 events 流）。
 * M1 会把 waitForCompletion 替换为消费 AsyncIterable<RunEvent>。
 *
 * 状态转移是代码判定的，绝不依赖 LLM 理解（核心原则）。
 */

// 进程级单例 SIGINT handler：无论创建多少个 RunManager，全局只注册一个 listener。
const activeManagers = new Set();
let sigintHandlerInstalled = false;

export async function gracefulShutdown(reason = STATE_CHANGE_REASON.SIGINT) {
  await Promise.allSettled([...activeManagers].map((m) => m.abortAll(reason)));
}

function installSigintHandler() {
  if (sigintHandlerInstalled) return;
  sigintHandlerInstalled = true;
  process.on("SIGINT", async () => {
    await gracefulShutdown(STATE_CHANGE_REASON.SIGINT);
    process.exit(130);
  });
}

const MAX_PENDING_DELIVERY_WRITE_INTENTS = 256;

// R7-AB: SSOT for the working-directory existence early-refusal shared by the
// two dispatch/execution authorities — RunManager.start (foreground family:
// `run` without --background, workflow agent nodes, daemon `start`, `retry`)
// plus RunManager.resume's replay re-spawn branch (R7-C C-5), and dispatchRun
// (background family: `run --background` / `spawn` / MCP run_dispatch). One
// class definition; runDispatch.js imports it DOWNWARD (application→core,
// same direction as its existing ../transcript.js / ../delivery.js imports)
// and re-exports it so its established typed-error import surface stays
// stable. Hosting here is a precedent-conformance choice, not the only legal
// home — the frozen L4 layering SSOT (test/isolation-infra/layering.test.js)
// forbids core→application upward edges (the whitelist is exactly empty), so
// a sibling src/application/ module is not importable from core, but a NEW
// CORE_TOP module would be legal; this file follows the existing typed-error
// precedent (ReadOnlyWorktreeRequiredError below) rather than widening the
// top-level registry. (daemon `start` goes through manager.start — daemon.js
// has no dispatchRun import — so daemon belongs to the start family above.)
//
// Defect this closes (2026-08-16, 22 researcher spawn_error runs in runs/):
// Node spawn's classic trap — when the cwd option points at a missing
// directory, the ENOENT is blamed on the EXECUTABLE ("spawn <node.exe>
// ENOENT"). Dispatches without an explicit --cwd inherited the example
// registry's placeholder cwd ("D:/projects/your-project",
// config/agents.example.json — placeholder since removed upstream by R8-1,
// which set every template cwd to ".") and failed only at spawn time, with a
// misleading error, after the transcript was already written.
//
// Deliberate deviation from the closed-set no-payload errors: the message
// CARRIES the resolved absolute path and its source. cwd is the Lead's/
// registry's own input, already recorded durably in the transcript
// (run.background_submitted.cwd / run.started.cwd) — never a credential or
// provider payload. The MCP boundary still never echoes it: the run_dispatch
// handler collapses every unrecognized typed error to its fixed dispatch
// error text, so the dynamic message reaches only CLI/local surfaces (stderr),
// where the path is exactly what the operator needs.
export class DispatchCwdNotFoundError extends Error {
  constructor(resolvedPath, source) {
    const fromFlag = source === "flag";
    super(
      `dispatch working directory does not exist: ${resolvedPath} `
      + `(from ${fromFlag ? "the --cwd flag" : "the agent registry entry cwd"}) `
      + "— Node spawn would misreport this as ENOENT on the executable; "
      + `${fromFlag
        ? "point --cwd at an existing directory (or create it first)"
        : "fix the registry entry's cwd (or pass --cwd) to point at an existing directory"}. `
      + "Refused before any side effect (dispatch_cwd_not_found).",
    );
    this.name = "DispatchCwdNotFoundError";
    this.reasonCode = "dispatch_cwd_not_found";
    this.resolvedPath = resolvedPath;
    this.cwdSource = fromFlag ? "flag" : "registry";
  }
}

/**
 * R7-AB: a spawn cwd must be an EXISTING directory. statSync covers both bad
 * faces in one probe: a missing path (throws, → false) and a path that exists
 * but is a plain FILE (isDirectory() === false — spawn would fail on it the
 * same way). Equivalent to existsSync + statSync().isDirectory() without the
 * TOCTOU window between the two calls.
 * @param {string} p
 * @returns {boolean}
 */
function isExistingDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the PREDICTED working directory the worker spawn will run in: the
 * explicit cwd argument when it is a non-empty string, else the registry
 * entry's agent.cwd (registry normalization requires that field non-empty, so
 * a null return is defensive only). Resolved via path.resolve — the same
 * semantics Node spawn applies to a relative cwd (resolved against the
 * dispatching process's cwd).
 * @param {object} input
 * @param {string|undefined} input.explicitCwd — the caller-supplied cwd option
 * @param {string|undefined} input.agentCwd — the registry entry's cwd
 * @returns {{path:string, source:"flag"|"registry"}|null}
 */
function resolvePredictedDispatchCwd({ explicitCwd, agentCwd }) {
  if (typeof explicitCwd === "string" && explicitCwd.length > 0) {
    return { path: resolve(explicitCwd), source: "flag" };
  }
  if (typeof agentCwd === "string" && agentCwd.length > 0) {
    return { path: resolve(agentCwd), source: "registry" };
  }
  return null;
}

/**
 * R8-2: non-throwing advisory probe over the SAME prediction + existence
 * judgment assertExistingDispatchCwd refuses on. Doctor (src/commands/
 * doctor.js) imports this for its per-worker registry-cwd WARN so the
 * existence judgment stays single-source (assert itself routes through this
 * probe — one judgment path, no third copy of the resolve+statSync
 * semantics). Returns null when no predicted cwd can be formed (defensive —
 * registry normalization requires agent.cwd non-empty), else
 * { path, source, exists } with path/source mirroring the typed error's
 * payload fields.
 * @param {object} input — same shape as resolvePredictedDispatchCwd
 * @returns {{path:string, source:"flag"|"registry", exists:boolean}|null}
 */
export function probePredictedDispatchCwd(input) {
  const predicted = resolvePredictedDispatchCwd(input);
  if (predicted === null) return null;
  return { path: predicted.path, source: predicted.source, exists: isExistingDirectory(predicted.path) };
}

/**
 * R7-AB shared early-refusal: throw the typed DispatchCwdNotFoundError when
 * the predicted working directory is not an existing directory (missing, or
 * exists but is a file). Callers invoke this BEFORE any side effect — for
 * dispatchRun: before the credential preflight, any sessionReuse/lineage slot
 * claim, any transcript write, and the fork; for RunManager.start: before the
 * credential check, runDir/transcript creation, worktree creation, and spawn.
 * @param {object} input — same shape as resolvePredictedDispatchCwd
 * @returns {void}
 */
export function assertExistingDispatchCwd(input) {
  const probed = probePredictedDispatchCwd(input);
  if (probed === null || probed.exists) return;
  throw new DispatchCwdNotFoundError(probed.path, probed.source);
}

// R10-A: per-dispatch model override (--model <modelId> on the CLI, `model` on
// MCP run_dispatch) — the SHAPE SSOT every boundary validates through. A model
// id is deliberately NOT the canonicalAgentId alphabet (real ids are
// heterogeneous across providers: "glm-5.3", "gpt-5.6-sol-xhigh",
// "zhipuai/glm-5.2"), so the contract is the minimal structural set the
// transports require: a non-empty bounded string that does not START with "--"
// and contains no whitespace/control characters. The "--" rule is load-bearing
// for the background path exactly as canonicalAgentId discipline is for ids:
// backgroundRunner's parseSimpleFlags treats any "--"-prefixed argv token as
// the next FLAG, so a "--foo" value would silently split the pair and misparse
// the rest of the runner argv. Hosting here (with the synthesis site below)
// follows the DispatchCwdNotFoundError precedent: runDispatch.js imports this
// downward and re-exports it so the application service keeps one SSOT, and the
// CLI/MCP boundaries validate the same contract with zero drift. The exported
// WIRE pattern lets the MCP zod schema serialize the identical regex into
// tools/list (same re-use pattern as canonicalAgentId's exported pattern).
export const MODEL_OVERRIDE_MAX = 128;
export const MODEL_OVERRIDE_WIRE_PATTERN = "^(?!--)[^\\s\\x00-\\x1f\\x7f]+$";
const MODEL_OVERRIDE_INVALID_TEXT =
  "--model must be a non-empty string of at most " + MODEL_OVERRIDE_MAX + " characters, "
  + "must not start with \"--\", and must contain no whitespace or control characters "
  + "(the background runner treats a \"--\"-prefixed value as the next flag)";

/**
 * R10-A: closed-set structural check for a per-dispatch model override id.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidModelOverride(value) {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MODEL_OVERRIDE_MAX) return false;
  if (value.startsWith("--")) return false;
  if (/[\s\x00-\x1f\x7f]/.test(value)) return false;
  return true;
}

/**
 * R10-A: fail-fast form of isValidModelOverride — fixed safe text, never echoes
 * the supplied value (a malformed id could itself be an injection payload).
 * @param {unknown} value
 * @returns {void}
 */
export function assertValidModelOverride(value) {
  if (!isValidModelOverride(value)) {
    throw new Error("RunManager: invalid model override — " + MODEL_OVERRIDE_INVALID_TEXT);
  }
}

// R11-1: per-dispatch reasoning effort override (--reasoning <effort> on the
// CLI, `reasoning` on MCP run_dispatch) — the SHAPE SSOT every boundary
// validates through. Unlike a model id, an effort is a CLOSED SET (the M11-9
// REASONING_EFFORTS enum, exported by registry.js), so the contract is exact
// membership — no length/charset rules needed, and a non-member value is
// malformed regardless of shape. Hosting follows the MODEL_OVERRIDE precedent
// (with the synthesis site below); runDispatch.js imports this downward and
// re-exports it so the application service / CLI / MCP boundaries validate the
// same set with zero drift. The MCP wire schema serializes the enum from the
// same exported array (z.enum — closed-set on the wire, stricter than a regex).
const REASONING_OVERRIDE_INVALID_TEXT =
  "--reasoning must be one of the supported reasoning effort values "
  + "(minimal/low/medium/high/xhigh/max)";

/**
 * R11-1: closed-set membership check for a per-dispatch reasoning effort
 * override. Case-sensitive by design (the enum is lowercase; anything else is
 * malformed, never "normalized" into a member).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidReasoningOverride(value) {
  return typeof value === "string" && REASONING_EFFORTS.includes(value);
}

/**
 * R11-1: fail-fast form of isValidReasoningOverride — fixed safe text, never
 * echoes the supplied value (a malformed effort could itself be an injection
 * payload).
 * @param {unknown} value
 * @returns {void}
 */
export function assertValidReasoningOverride(value) {
  if (!isValidReasoningOverride(value)) {
    throw new Error("RunManager: invalid reasoning override — " + REASONING_OVERRIDE_INVALID_TEXT);
  }
}

// TD-131: certification identity-match SSOT — the ONE rule deciding whether a
// reliability-summary worker record still belongs to the CURRENT registry
// agent (backend/modelId compare whenever the record declares the field —
// undefined = legacy record, dimension skipped; TD-131 adds providerID as a
// compared dimension, but ONLY when BOTH sides declare it, so claude-code-
// shaped agents without model.providerID stay guarded by backend+modelId).
// Agent-side identity is null-normalized (`agent.model?.id ?? null` — never
// undefined-vs-null false mismatches). No agent-registry schema field added.
//
// R23-C (ADR-0026 v2 方向, 2026-08-21): the compared set is now the identity
// QUADRUPLE backend + modelId + providerID (unchanged) + providerKey — the
// normalized-baseUrl + apiKeyEnv-NAME fingerprint from the single-host
// normalizer src/providerFingerprint.js (env NAME, never the secret value).
// Record-side tri-state: undefined = legacy record, dimension skipped;
// explicit null = observed-no-provider — matches an agent with no derivable
// provider block, mismatches an agent with one; a non-null record key must
// byte-equal the agent-side derivation. Re-certification is the only path
// across a provider-wiring change (same lesson as TD-131's backend/model).
//
// Hosting: HERE (core), imported DOWNWARD by src/application/registryInventory.js
// (the display path's former private copy, same direction discipline as the
// R10-A/R11-1 override validators runDispatch.js consumes) — the P1-1 gate
// below and the inventory projection must share ONE judgment, not two. A
// separate src/application module would be an application-bucket file and
// core→application is an upward edge (frozen empty whitelist, TD-122), so the
// R7-AB hosting precedent applies: core hosts, application imports down.
export function matchedCertRecord(agent, record) {
  if (!record) return null;
  if (record.backend !== undefined && record.backend !== agent.backend) return null;
  const modelId = agent.model?.id ?? null;
  if (record.modelId !== undefined && record.modelId !== modelId) return null;
  const providerID = agent.model?.providerID ?? null;
  if (providerID !== null && record.providerID !== undefined && record.providerID !== providerID) return null;
  if (record.providerKey !== undefined && record.providerKey !== providerKeyFor(agent.provider)) return null;
  return record;
}

// Round 4 Bundle B: thrown when a readOnly run's FORCED worktree isolation
// cannot be established (worktree creation failed). Read-only runs refuse the
// legacy degrade-to-source-cwd fallback (runManager.js :524-534) exactly like
// delivery runs (:525-531 precedent): the declaration promises forced
// isolation, and a fallback would silently void both the isolation and the
// observation authority. Fixed closed-set message — no path, argv, or
// operational detail is echoed. Carries the closed-set reason code
// `read_only_worktree_required` for callers/tests.
export class ReadOnlyWorktreeRequiredError extends Error {
  constructor() {
    super(
      "readOnly mode requires an isolated worktree, but worktree creation failed "
      + "(read_only_worktree_required); refusing the source-checkout fallback",
    );
    this.name = "ReadOnlyWorktreeRequiredError";
    this.reasonCode = "read_only_worktree_required";
  }
}

function isConfirmableToolCallId(value) {
  return typeof value === "string"
    && value.trim().length > 0
    && value !== "unknown";
}

async function validateRoleContractTransport(backend, agent, roleContract) {
  if (typeof roleContract !== "string" || roleContract.length === 0) return;
  if (typeof backend.validateRoleContractTransport === "function") {
    await backend.validateRoleContractTransport(agent, { roleContract });
  }
}

// R10-C C-3: when a per-dispatch model override is active and the backend
// refuses the (synthesized) policy, the operator sees a registry-shape error
// for a dispatch they made with --model — the two facts never connect in the
// message (opencode-serve's model-shape text, kimi-code's effort/model pairing
// both read as pure registry complaints). Append ONE bounded sentence naming
// the override whenever it is in play. The verdict itself is untouched: same
// throw, same backend decision, only the message gains the hint (fixed text —
// never echoes the supplied model id).
//
// R11-1: the wrapper now takes BOTH per-dispatch overrides
// ({modelOverride, reasoningOverride}) and names exactly the flag(s) in play —
// three fixed shapes (model-only / reasoning-only / both). When BOTH are
// active, one combined sentence names both flags; a backend that refuses the
// synthesized policy under either override must point the operator at the
// right flag(s), never at a phantom registry complaint. Values are never
// echoed (same :263-264 discipline as R10-C C-3).
const MODEL_OVERRIDE_POLICY_HINT =
  "（当前派发带 --model 覆盖；该 backend 的 model 声明形状与覆盖不兼容）";
const REASONING_OVERRIDE_POLICY_HINT =
  "（当前派发带 --reasoning 覆盖；该 backend 的 reasoning 声明形状与覆盖不兼容）";
const BOTH_OVERRIDES_POLICY_HINT =
  "（当前派发带 --model/--reasoning 覆盖；该 backend 的 model/reasoning 声明形状与覆盖不兼容）";
function validateAgentPolicyWithOverrideHint(backend, agent, { modelOverride, reasoningOverride } = {}) {
  const modelActive = modelOverride !== null && modelOverride !== undefined;
  const reasoningActive = reasoningOverride !== null && reasoningOverride !== undefined;
  try {
    backend.validateAgentPolicy(agent);
  } catch (error) {
    if (modelActive && reasoningActive) {
      error.message += BOTH_OVERRIDES_POLICY_HINT;
    } else if (modelActive) {
      error.message += MODEL_OVERRIDE_POLICY_HINT;
    } else if (reasoningActive) {
      error.message += REASONING_OVERRIDE_POLICY_HINT;
    }
    throw error;
  }
}

function isPathInside(base, target) {
  const rel = relative(base, target);
  return rel === ""
    || (
      rel !== ".."
      && !rel.startsWith(`..${sep}`)
      && !isAbsolute(rel)
    );
}

// M12-14: win32-only MSYS (Git-Bash) drive-path normalization. A Claude worker
// running under Git-Bash reports the in-worktree target in MSYS form
// ("/d/proj/.../src/a.js" for "D:\proj\...\src\a.js"). Without normalization,
// win32 resolve() treats that as a rooted path on the worktree's drive
// ("<drive>:\d\...") — always outside the worktree — falsely terminalizing an
// honest in-worktree write as workdir_escape. Normalize ONLY the anchored
// absolute drive pattern ("/d/..." or exactly "/d") to the equivalent
// drive-root path BEFORE lexical containment. Arbitrary slash paths ("/tmp",
// "//share", relative paths) are never rewritten, and off win32 the input
// passes through unchanged.
const MSYS_DRIVE_PATH_RE = /^\/([A-Za-z])(?:\/|$)/;

function normalizeMsysDrivePath(rawPath) {
  if (process.platform !== "win32" || typeof rawPath !== "string") return rawPath;
  const match = MSYS_DRIVE_PATH_RE.exec(rawPath);
  if (!match) return rawPath;
  return `${match[1].toUpperCase()}:/${rawPath.slice(match[0].length)}`;
}

// M12-14: containment verdicts — the reason suffixes of ISOLATION_VIOLATION_REASONS.
// "inside" passes; "lexical_outside" is a confirmed lexical escape (or an
// unusable/blank path, which cannot be contained); "physical_outside" is a
// confirmed physical escape (junction/link resolves outside); "physical_unresolved"
// means the physical location could not be proven (fail closed without
// claiming outside).
function resolveLexicallyContainedWrite(rawPath, effectiveCwd) {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) return false;
  if (typeof effectiveCwd !== "string" || effectiveCwd.trim().length === 0) return false;
  const candidate = normalizeMsysDrivePath(rawPath);
  const base = resolve(effectiveCwd);
  const target = resolve(base, candidate);
  return isPathInside(base, target) ? { base, target } : false;
}

// file_written is post-write evidence, so inability to prove the target's
// physical location fails closed for delivery runs (physical_unresolved).
function classifyReportedWriteContainment(rawPath, effectiveCwd) {
  const lexical = resolveLexicallyContainedWrite(rawPath, effectiveCwd);
  if (!lexical) return "lexical_outside";
  try {
    // A junction/symlink inside the worktree may resolve to an outside target.
    const physicalBase = realpathSync.native(lexical.base);
    const physicalTarget = realpathSync.native(lexical.target);
    return isPathInside(physicalBase, physicalTarget) ? "inside" : "physical_outside";
  } catch {
    return "physical_unresolved";
  }
}

function classifyReportedWriteIntentContainment(rawPath, effectiveCwd) {
  const lexical = resolveLexicallyContainedWrite(rawPath, effectiveCwd);
  if (!lexical) return "lexical_outside";
  let physicalBase;
  try {
    physicalBase = realpathSync.native(lexical.base);
  } catch {
    return "physical_unresolved";
  }
  try {
    // lstat distinguishes a genuinely missing target from a dangling link.
    // Only a genuine ENOENT may use nearest-existing-ancestor validation.
    lstatSync(lexical.target);
  } catch (error) {
    if (error?.code !== "ENOENT") return "physical_unresolved";
    let ancestor = dirname(lexical.target);
    while (true) {
      try {
        const physicalAncestor = realpathSync.native(ancestor);
        return isPathInside(physicalBase, physicalAncestor) ? "inside" : "physical_outside";
      } catch (ancestorError) {
        if (ancestorError?.code !== "ENOENT") return "physical_unresolved";
        const parent = dirname(ancestor);
        if (parent === ancestor) return "physical_unresolved";
        ancestor = parent;
      }
    }
  }
  try {
    const physicalTarget = realpathSync.native(lexical.target);
    return isPathInside(physicalBase, physicalTarget) ? "inside" : "physical_outside";
  } catch {
    // Existing but unresolvable targets (for example dangling links) fail
    // closed; ancestor walking is reserved for lstat ENOENT above.
    return "physical_unresolved";
  }
}

export class RunManager {
  constructor({ config, readRegistry, transcriptDir, backendFor, packageDeliveryFn = defaultPackageDelivery, verifyDeliveryFn = defaultVerifyDelivery, userEnvReader, createWorktreeFn = createWorktree }) {
    this.config = config;
    this.readRegistry = readRegistry;
    this.transcriptDir = transcriptDir;
    this.backendFor = backendFor;
    this.packageDeliveryFn = packageDeliveryFn;
    this.verifyDeliveryFn = verifyDeliveryFn;
    // M11-7: injectable Windows user-env reader for the credential bridge.
    // Default reads HKCU\Environment; tests inject a fake.
    this.userEnvReader = userEnvReader ?? readWindowsUserEnv;
    // M12-6 (P1-A): injectable worktree creator. Tests inject a seam that can
    // mutate the source HEAD between revalidation and `git worktree add` to
    // prove the frozen-base TOCTOU defense. Production uses the real createWorktree.
    this.createWorktreeFn = createWorktreeFn;
    this.activeRuns = new Map();
  }

  _ensureSigintHandler() {
    activeManagers.add(this);
    installSigintHandler();
  }

  async abortAll(reason) {
    if (this.activeRuns.size === 0) return;
    const runs = [...this.activeRuns.values()];
    this.activeRuns.clear();
    await Promise.allSettled(runs.map((run) => run._abortInternal(reason)));
  }

  async start(agentId, options = {}) {
    const {
      prompt,
      cwd,
      registry,
      runId,
      runDir,
      tags,
      isolate,
      scorecard,
      // M8-1：默认 scorecard 模式。warn=默认开启(不阻塞,只留痕) | hard=升级硬闸 | off=完全关闭。
      scorecardMode = "warn",
      // fire-and-forget 语义：调用方是否会在 backend 起来后立即返回（不进 waitForCompletion）。
      // 默认 false = 安全（run/workflow/resume 等都会 wait 或由调用方管理生命周期）。
      // 仅 CLI spawnCommand 在不带 --wait 时显式传 true，触发 P0-1 护栏。
      fireAndForget = false,
      // P1-1 认证新鲜度强制门（opt-in，06-18 事故教训"调度安全不能建立在模型行为假设上"）。
      // 启用时：目标 worker 必须在 runDir/reliability-summary.json 里、记录身份与当前
      // registry 配置一致（TD-131）、status=certified/conditional、且该 worker 自己的
      // lastHealthyRunAt 在 certFreshnessDays 内（TD-132 per-worker 新鲜度，缺失即拒），
      // 否则拒绝派发。默认关（向后兼容 + 不破坏测试）。
      requireCertified = false,
      certFreshnessDays = 30,
      // TD-103 Phase 3A：delivery mode。absent = 普通运行（无 delivery Git 调用/事件）。
      // present = mode 必须为 "git_commit_v1"，要求 persistent worktree 隔离，
      // worker 完成后控制面打包 delivery commit。
      delivery = null,
      // M11-11C: opaque provider-session reuse routing {mode, opaqueUuid, turn},
      // resolved by dispatchRun from the agent's sessionReuse policy. Absent for
      // non-reusable runs. The capability check below gates it provider-neutrally.
      sessionReuse = null,
      // M12-6 (P1-A): server-proven frozen HEAD threaded from the MCP boundary
      // (binding.gitHead). When present, start revalidates the source HEAD against
      // it AS LATE AS PRACTICAL — immediately before the worktree/spawn that
      // derives the delivery base — and pins the worktree to this exact commit.
      // Absent for CLI callers (behavior unchanged). Never model-supplied: the
      // model-owned counterpart is expectedGitHead, consumed at the MCP boundary.
      frozenGitHead = null,
      // M12-7: reuse a retained parent worktree for a Lead-authorized continuation.
      // {path, branch} of an already-transitioned linked worktree
      // (prepareContinuationWorktree re-pinned it to the persisted base on
      // wao/<childRunId>). start() adopts it as effectiveCwd instead of creating
      // a fresh worktree — no createWorktree, no cleanup (persistent). Mutually
      // exclusive with frozenGitHead; requires delivery mode.
      reuseWorktree = null,
    // M12-16: Lead opt-in marking this run correctable — the runner drains the
    // transcript-backed correction queue (appended cross-process by run_correct)
    // and delivers each queued turn to the live provider stdin in
    // waitForCompletion. Requires the backend to declare
    // supportsInFlightCorrection (gated below). Default false = byte-compatible.
    correctable = false,
    // Round 4 Bundle B: Lead read-only DECLARATION (advisory observation, never
    // a gate). readOnly forces persistent worktree isolation (overriding the
    // isolate flag — the CLI rejects the contradictory --no-isolate up front),
    // fails closed when the worktree cannot be created (no source-cwd fallback,
    // typed ReadOnlyWorktreeRequiredError, zero transcript side effects), and
    // persists exactly one `run.read_only_declared` durable fact whose presence
    // is the observation projector's authority input. Non-delivery only
    // (defense-in-depth — the dispatch boundaries already refuse the combo).
    // Observed out-of-bounds writes NEVER stop/fail the run: the run reaches
    // its natural terminal state and the observation is pure presentation.
    readOnly = false,
    // R10-A: per-dispatch model override (--model <modelId> / run_dispatch
    // `model`) — ONE dispatch only, never persisted to the registry. When
    // present, the agent's model policy is synthesized as
    //   model: { ...(agent.model ?? {}), id: modelOverride }
    // AFTER registry resolution and BEFORE validateAgentPolicy / the
    // run.started append below — only `.id` is replaced; every sibling field
    // (canonical contextWindow, opencode-serve providerID/variant) survives.
    // Deliberately NOT a getAgent override: registry.getAgent shallow-merges
    // top-level keys, so passing model there would replace the whole object
    // and silently drop the siblings. Mutually exclusive with requireCertified
    // (the certification matrix is recorded per provider+model — an override
    // voids the certified combination) and with sessionReuse (a resumed
    // provider conversation must run one model across turns); both refusals
    // run at the very top of start, before the registry read, with zero side
    // effects. resume() never accepts a CALLER-SUPPLIED override (the model
    // choice was made once, at dispatch); instead it REBUILDS this run's own
    // persisted run.started.modelOverride fact (R10-C C-1) so a daemon-resumed
    // or hand-resumed run keeps the model it was dispatched with — see the
    // synthesis in resume().
    modelOverride = null,
    // R11-1: per-dispatch reasoning effort override (--reasoning <effort> /
    // run_dispatch `reasoning`) — symmetric to modelOverride: ONE dispatch
    // only, never persisted to the registry. When present, the agent's
    // reasoning policy is synthesized as
    //   reasoning: { ...(agent.reasoning ?? {}), effort: reasoningOverride }
    // (same getAgent shallow-merge caveat — never a getAgent override). The
    // value is gated by the CLOSED-SET SSOT (isValidReasoningOverride above,
    // REASONING_EFFORTS from registry.js). No capability boolean exists by
    // design: inexpressible policies (opencode-serve) and conditional subsets
    // (kimi K3-only, deepseek-harness high|max) refuse naturally through the
    // existing per-backend validateAgentPolicy gate over the synthesized
    // object. Mutually exclusive with requireCertified and sessionReuse by the
    // same reasoning as modelOverride (any override present voids the claim);
    // composable WITH modelOverride (the Owner scenario "gpt-5.6-sol +
    // xhigh"). resume rebuilds this run's own run.started.reasoningOverride
    // fact (R11-1 resume chain) exactly like R10-C C-1 does for the model.
    reasoningOverride = null,
    } = options;

    // R10-A/R11-1 mutual exclusions (flag presence, value-insensitive — a
    // value-aware "compatible override" pass would let a dispatch claim a
    // certified provider+model combination it never proved). ANY override in
    // play refuses the combination: the certified-conflict / reuse-conflict
    // doors below fire for the model override, then again for the reasoning
    // override (the message names the flag(s) actually in play). Both checks
    // sit BEFORE the registry read: zero transcript, zero worktree, zero
    // spawn. start is the authoritative single point — it covers the
    // foreground family (run / workflow agent nodes / daemon start) AND the
    // background family (the detached runner's --model/--reasoning/
    // --require-certified all land here); the CLI re-refuses earlier for the
    // operator's face, and dispatchRun re-refuses the reuse shape before the
    // fork (ModelOverrideConflictError / ReasoningOverrideConflictError).
    if (modelOverride !== null && modelOverride !== undefined) {
      assertValidModelOverride(modelOverride);
      if (requireCertified) {
        throw new Error(
          "RunManager.start: modelOverride is mutually exclusive with requireCertified "
          + "(model_override_certified_conflict) — the certification matrix is recorded per "
          + "provider+model, so a one-off override invalidates the certified combination. "
          + "Drop the model override, or drop requireCertified.",
        );
      }
      if (sessionReuse) {
        throw new Error(
          "RunManager.start: modelOverride is mutually exclusive with sessionReuse "
          + "(model_override_reuse_conflict) — a provider conversation resumed across turns "
          + "must run one model. Drop the model override, or dispatch a non-reusable agent.",
        );
      }
    }
    if (reasoningOverride !== null && reasoningOverride !== undefined) {
      assertValidReasoningOverride(reasoningOverride);
      if (requireCertified) {
        throw new Error(
          "RunManager.start: reasoningOverride is mutually exclusive with requireCertified "
          + "(reasoning_override_certified_conflict) — the certification matrix is recorded per "
          + "provider+model under the registry's reasoning policy, so a one-off effort override "
          + "changes the execution envelope the certified combination was measured under. "
          + "Drop the reasoning override, or drop requireCertified.",
        );
      }
      if (sessionReuse) {
        throw new Error(
          "RunManager.start: reasoningOverride is mutually exclusive with sessionReuse "
          + "(reasoning_override_reuse_conflict) — a provider conversation resumed across turns "
          + "must run one reasoning effort. Drop the reasoning override, or dispatch a non-reusable agent.",
        );
      }
    }

    const registryPath = resolve(registry ?? this.config.registry);
    const loaded = await this.readRegistry(registryPath);
    let agent = loaded.getAgent(agentId, { cwd });
    // R10-A: synthesize the override (see the option comment above). The
    // synthesized object flows through validateAgentPolicy below unchanged —
    // zero NEW validation surface; a backend that cannot express the resulting
    // policy refuses exactly as it would for the same registry-declared shape.
    // For a registry entry without any model this synthesizes a bare {id}.
    if (modelOverride !== null && modelOverride !== undefined) {
      agent = { ...agent, model: { ...(agent.model ?? {}), id: modelOverride } };
    }
    // R11-1: synthesize the reasoning effort override (see the option comment
    // above) — the same post-getAgent, pre-validation slot as the model
    // synthesis. The synthesized object flows through validateAgentPolicy
    // below unchanged: zero NEW validation surface; a backend that cannot
    // express the effort (opencode-serve) or only a conditional subset
    // (kimi-code K3-only, deepseek-harness high|max) refuses exactly as it
    // would for the same registry-declared shape. For a registry entry without
    // any reasoning this synthesizes a bare {effort}.
    if (reasoningOverride !== null && reasoningOverride !== undefined) {
      agent = { ...agent, reasoning: { ...(agent.reasoning ?? {}), effort: reasoningOverride } };
    }

    // M11-5 Package A2: obtain the backend ONCE, up front, so the role-contract
    // decision can read its CAPABILITY (supportsRoleContract) instead of branching
    // on the runtime name. The backend instance is reused for spawn below; it does
    // not touch cwd/binary until spawn, so selecting it from `agent` (pre-worktree)
    // vs `effectiveAgent` (post-worktree) yields the same instance.
    const backend = this.backendFor(agent);

    // M12-16: correctable capability gate (defense-in-depth at the spawn
    // authority — dispatchRun already gates, but RunManager.start is the spawn
    // owner). Only a backend declaring supportsInFlightCorrection may accept a
    // correctable run; fail closed BEFORE any transcript write/spawn. Reads the
    // declared capability — never branches on the runtime name.
    if (correctable && backend?.supportsInFlightCorrection !== true) {
      throw new Error("RunManager.start: correctable requires a backend that declares supportsInFlightCorrection");
    }

    // M11-5（TD-89 修复）：角色合同加载。在 transcript 创建前 fail-closed
    // （零 transcript、零 spawn）。agent.systemPrompt 是 registry 声明的角色
    // 文件路径；由 loadRoleContract 内部的 resolveRoleContractPath 相对 WAO
    // 安装根解析（不依赖 process.cwd()），所以从任意目标项目 cwd 调用都能
    // 找到全局 registry 的角色文件。加载器验证后返回内容字符串，传给
    // backend.spawn（各 backend 用 runtime-native 方式恰好一次注入）。
    // 未配置 systemPrompt 的 agent 保持旧行为（roleContract 为 undefined）。
    //
    // Package A2/C2 决策边界：是否支持角色注入由 backend 能力声明
    // （supportsRoleContract）决定，RunManager 不认识 runtime 名称。若没有
    // 能力门，不支持注入的 backend 配了 systemPrompt 就可能被静默丢弃；
    // 现在严格要求 supportsRoleContract === true，否则在 transcript 创建和
    // spawn 前 fail closed（start）/ 读取既有 transcript 后、append/spawn 前
    // fail closed（resume）。错误是固定安全形状，不回显值/路径/角色内容。
    //
    // Package C2 严格性：只有 backend.supportsRoleContract === true 才允许
    // 带角色合同；字符串/数字/对象/null/undefined 等 truthy 非-true 值一律
    // fail closed（避免 "false"/1/{} 被当作支持）。
    //
    // 安全：transcript 不把角色合同保存为 prompt.sent/control-plane input
    // （只持久化原始 task prompt）。Lead/model 不能覆盖此处的 registry 选定
    // 角色。（注意：worker 输出可能在回答中引用或复述角色，这由模型决定，
    // 不是 WAO 持久化角色正文。）
    let roleContract = undefined;
    if (agent.systemPrompt) {
      if (backend.supportsRoleContract !== true) {
        throw new Error(
          `Agent ${agentId}: systemPrompt is configured but the selected backend does not support role contract injection. ` +
          `Remove systemPrompt from this agent, or switch to a backend that declares supportsRoleContract.`
        );
      }
      roleContract = composeRoleContractWithIdentity({
        roleContract: loadRoleContract(agent.systemPrompt),
        agentId,
      });
    }

    // Validate deterministic delivery inputs before composing the contract and
    // before consulting an external runtime capability. These checks are pure and
    // must retain precedence over network availability/version errors while still
    // happening before every run side effect.
    // Round 4 Bundle B: a read-only run is a non-delivery declaration — refuse
    // the contradictory combination at the spawn authority too (the MCP handler
    // and CLI runCommand already refuse it; this is the same defense-in-depth
    // discipline the correctable gate applies). Zero transcript, zero worktree,
    // zero spawn.
    if (readOnly && delivery) {
      throw new Error(
        "RunManager.start: readOnly is mutually exclusive with delivery "
        + "(read_only_delivery_conflict) — a read-only run is advisory observation, never a delivery",
      );
    }
    // Round 4 Bundle B: readOnly FORCES persistent worktree isolation — the
    // declaration overrides the caller's isolate flag (the CLI rejects the
    // contradictory --no-isolate declaration up front; programmatic callers
    // get the forced-isolation semantics documented on the option).
    const isolationConfig = resolveIsolation(
      readOnly ? true : isolate,
      agent.isolation,
      this.config.defaultIsolation,
    );
    let deliveryPrepared = null;
    if (delivery) {
      deliveryPrepared = prepareDeliveryRequest(delivery);
      if (isolationConfig.type !== "worktree" || isolationConfig.strategy !== "persistent") {
        throw new Error(
          `Delivery mode requires persistent worktree isolation, got: ${JSON.stringify(isolationConfig)}. `
          + `Use isolate:true or agent isolation {type:"worktree", strategy:"persistent"}.`,
        );
      }
    }

    // M11-8C Package A + M12-14 Package 1: delivery-mode runs ALWAYS inject the
    // control-plane-owned Delivery Execution Contract, even when the agent has no
    // systemPrompt. This forbids the worker from running git mutating commands,
    // moving HEAD, or reporting a final commit SHA — the control plane owns the
    // delivery commit. Production RED (run_20260724202209375032648): a delivery
    // task prompt asked for a "Final commit SHA", the worker committed on the
    // isolation branch, and the packager failed with base_commit_mismatch.
    //
    // The delivery contract is composed AHEAD of any role contract so it takes
    // precedence, and is carried via task.roleContract (each backend injects it
    // exactly once through its runtime-native channel). It is NOT persisted into
    // prompt.sent (only the original task prompt is). An unsupported backend
    // fails closed here — BEFORE worktree/transcript/spawn — because the
    // contract cannot be delivered otherwise. No runtime-name branch; this path
    // applies to every backend that declares supportsRoleContract === true.
    //
    // M12-14 Package 1 (Worker-visible Work Order SSOT): the contract is composed
    // FROM the prepared allowedPaths (deliveryPrepared.allowedPaths), so the
    // worker receives the EXACT authorized-paths list the control plane
    // persisted — eliminating the disallowed_path late-failure. prepare runs
    // BEFORE compose (single source of truth); the same allowedPaths is what the
    // packager enforces at closeout, so start and packager can never disagree.
    if (delivery) {
      if (backend.supportsRoleContract !== true) {
        throw new Error(
          `Agent ${agentId}: delivery mode requires role contract injection (to deliver the delivery execution contract), ` +
          `but the selected backend does not support it. ` +
          `Switch to a backend that declares supportsRoleContract.`
        );
      }
      const deliveryContract = composeDeliveryExecutionContract({
        allowedPaths: deliveryPrepared.allowedPaths,
      });
      roleContract = roleContract
        ? `${deliveryContract}\n\n---\n\n${roleContract}`
        : deliveryContract;
    }

    // Runtime-managed transports may need to prove a dynamic capability (for
    // example an OpenCode server version) in addition to the static flag. The
    // hook is provider-neutral and runs before runDir/transcript/worktree/spawn.
    await validateRoleContractTransport(backend, agent, roleContract);

    // M11-9 CTO closeout: validate the backend can express the agent's canonical
    // policy BEFORE any side effect (transcript, runDir, worktree, spawn). This
    // runs AFTER the role-contract / delivery-contract checks (which are more
    // fundamental backend-capability gates). FAIL-CLOSED: when the agent has ANY
    // structured policy (model/reasoning/provider), the backend MUST implement
    // validateAgentPolicy and confirm it can express it. A backend lacking the
    // method + a structured policy = reject. No structured policy → skip.
    const hasStructuredPolicy = agent.model || agent.reasoning || agent.provider;
    if (hasStructuredPolicy) {
      if (typeof backend.validateAgentPolicy !== "function") {
        throw new Error("backend does not implement validateAgentPolicy — cannot confirm it can express the configured policy");
      }
      // R10-C C-3 / R11-1: hint-appending wrapper (see its definition) — start
      // covers the foreground family AND the detached background runner's
      // --model/--reasoning.
      validateAgentPolicyWithOverrideHint(backend, agent, { modelOverride, reasoningOverride });
    }

    // M11-11C: provider-NEUTRAL session-reuse capability gate (contract 7).
    // A backend that cannot express the configured reuse policy (resuming a
    // provider-native conversation) MUST fail closed BEFORE transcript/spawn —
    // it must not silently start a fresh one-off conversation. The decision
    // reads backend.supportsSessionReuse (a boolean capability), never the
    // runtime name. Only claude-code declares it today; the ProcessBackend base
    // leaves it undefined → fail closed. Strict === true (truthy non-true like
    // "false"/1/{} is rejected), mirroring the supportsRoleContract discipline.
    if (sessionReuse) {
      validateSessionReuseRouting(sessionReuse);
      if (backend.supportsSessionReuse !== true) {
        throw new Error(
          `Agent ${agentId}: sessionReuse routing was supplied but the selected backend does not support provider session reuse. ` +
          `Switch to a backend that declares supportsSessionReuse, or remove sessionReuse from this agent.`,
        );
      }
    }

    // R7-AB (layer 2): working-directory existence early-refusal, shared SSOT
    // with dispatchRun (defined in THIS module — DispatchCwdNotFoundError +
    // assertExistingDispatchCwd above; runDispatch imports them downward).
    // Covers the FOREGROUND family that never goes through dispatchRun: `run`
    // without --background (commands/run.js → start), workflow agent nodes
    // (workflow/handlers.js → start), and daemon `start` (daemon.js → start).
    //
    // Mechanism note: the runner's --cwd reaches start as the cwd option;
    // getAgent(agentId, { cwd }) above merges it over the registry entry, so
    // agent.cwd here IS the predicted spawn cwd (explicit non-empty cwd when
    // given, else the registry entry's). The explicit option is still passed
    // separately for the error's source label (--cwd flag vs registry entry).
    //
    // Capability-scoped, provider-neutral: keyed on the SAME declared
    // capability the M12-14 preflightInvocation gate below uses — a backend
    // that implements preflightInvocation composes a LOCAL OS invocation and
    // spawns with cwd: agent.cwd (processBackend.js spawn / deepSeekHarness),
    // so a missing directory hits Node's classic ENOENT-blames-the-executable
    // trap there. OpenCodeServe (an HTTP backend with no preflightInvocation)
    // threads agent.cwd to the serve API as a REMOTE directory hint — no local
    // spawn, no local ENOENT trap — and is unaffected, exactly as it is by the
    // invocation-budget preflight.
    //
    // Position: BEFORE the credential check, mirroring layer 1's ordering —
    // the refusal stays deterministic across environments (machine env cannot
    // mask it) — and BEFORE runDir/transcript creation, worktree creation
    // (the checked path is the worktree SOURCE directory; the worktree itself
    // is WAO-created and always exists), and spawn: zero side effects.
    //
    // TOCTOU boundary (honest): this runs at start preflight. A directory
    // deleted between this check and backend.spawn still fails at spawn time;
    // the residual window is unchanged, but its failure face is now the typed
    // diagnosable one instead of the misleading executable-ENOENT.
    if (typeof backend.preflightInvocation === "function") {
      assertExistingDispatchCwd({ explicitCwd: cwd, agentCwd: agent.cwd });
    }

    // M11-7 (CTO closeout): credential availability check BEFORE transcript
    // creation or spawn (foreground/resume path). Same SSOT as dispatchRun and
    // registry_list. A missing REQUIRED credential throws here (zero transcript,
    // zero worktree, zero spawn). Resolved values (incl. Windows user-env bridge)
    // are passed to backend.spawn so the worker child inherits them and the
    // redactor scrubs them. Values never enter argv/transcript/MCP output.
    // Start resolves ALL inherited env names (required + optional) so optional
    // Kimi/Codex config is bridged. One operation-scoped resolver per start.
    const credentialReadiness = await assessWorkerReadiness({
      agent, resolver: createEnvResolver(this.userEnvReader), names: inheritedEnvNames(agent),
    });
    if (credentialReadiness.credentialAvailability === "missing") {
      throw new Error(
        `Agent ${agentId}: missing required credential env: ${credentialReadiness.missingCredentialEnvNames.join(", ")}. ` +
        `Set it in the current process or Windows User environment.`,
      );
    }
    const resolvedCredentials = credentialReadiness.resolvedEnv;

    // M12-14 Package 1: preflight the process invocation BEFORE any side effect
    // (runDir, transcript, worktree, spawn). For process backends that declare
    // preflightInvocation, resolve the binary + build the argv + run the SAME
    // compileInvocation budget check spawn runs — fail fixed-safe here if the
    // composed role contract would exceed the Windows command-line budget.
    // cmd.exe over-limit behavior is not a safe transport contract (it can
    // reject/truncate/misparse by boundary); WAO refuses deterministically.
    // Failing here means zero transcript bytes, zero worktree, zero spawn.
    //
    // Provider-neutral: keyed on the capability (the method), never the runtime
    // name — OpenCodeServe (an HTTP backend with no preflightInvocation) is
    // unaffected. This is a best-effort EARLY gate, NOT a byte-identity guarantee:
    // it assumes buildArgs and binary resolution are deterministic and
    // cwd-independent for the configured process backends (preflight uses the
    // pre-worktree `agent`). spawn re-runs compileInvocation as the authoritative
    // defense-in-depth check, so a preflight pass can never let an overflowing
    // invocation reach the OS. By this point roleContract already carries the
    // merged delivery contract + scope block, so buildArgs produces the final
    // argv here.
    if (typeof backend.preflightInvocation === "function") {
      await backend.preflightInvocation(agent, {
        prompt,
        roleContract,
        ...(sessionReuse ? { sessionReuse } : {}),
      });
    }

    const finalRunId = runId ?? `run_${new Date().toISOString().replace(/[-:.TZ]/g, "")}${Math.random().toString(36).slice(2, 8)}`;

    // TD-103 Phase 3A security: validate runId before it enters any Git command.
    // Custom runIds reach worktree paths, branch names, and (in delivery mode)
    // commit-tree/update-ref. Reject early to prevent injection. Reuses the same
    // SSOT validator as delivery.js (isValidRunId).
    if (!isValidRunId(finalRunId)) {
      throw new Error(`Invalid runId (contains path separators, shell metacharacters, or traversal): ${JSON.stringify(finalRunId)}`);
    }
    const dir = resolve(runDir ?? this.config.runDir);
    await mkdir(dir, { recursive: true });

    const transcript = new JsonlTranscript(join(dir, `${finalRunId}.jsonl`), {
      runId: finalRunId,
      agentId,
    });

    // M12-7: validate continuation worktree-reuse inputs before any side effect.
    // A continuation always delivers, and the transition already pinned the base,
    // so reuseWorktree is mutually exclusive with frozenGitHead (which re-pins a
    // freshly-created worktree against the live source HEAD).
    if (reuseWorktree) {
      if (!delivery) {
        throw new Error("reuseWorktree requires delivery mode (continuation runs deliver a git_commit_v1)");
      }
      if (frozenGitHead) {
        throw new Error("reuseWorktree and frozenGitHead are mutually exclusive (the continuation transition already pinned the base)");
      }
      if (typeof reuseWorktree.path !== "string" || reuseWorktree.path.length === 0) {
        throw new Error("reuseWorktree.path must be a non-empty string");
      }
      if (typeof reuseWorktree.branch !== "string" || reuseWorktree.branch.length === 0) {
        throw new Error("reuseWorktree.branch must be a non-empty string");
      }
    }

    let worktreeInfo = null;
    let effectiveCwd = agent.cwd;
    let cleanupFn = null;

    // M12-6 (P1-A): frozen-base TOCTOU revalidation. When a server-proven
    // frozenGitHead was threaded (MCP dispatch), re-prove the source HEAD equals
    // it AS LATE AS PRACTICAL — immediately before the worktree/spawn that
    // derives the delivery base. No durable run fact has been written yet (the
    // transcript object exists but run.started is appended only after worktree
    // creation), so a mismatch fails CLOSED: no worktree, no provider spawn, no
    // wrong-base DeliveryRef. The message carries no hash/path/argv — only the
    // closed-set label. (The structural pin below additionally defeats a micro-
    // race between this rev-parse and `git worktree add`.)
    if (frozenGitHead) {
      const sourceHead = String(
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: agent.cwd,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        }),
      ).trim();
      if (sourceHead !== frozenGitHead) {
        throw new Error(
          "frozen_base_mismatch: workspace HEAD moved between the dispatch proof and run start; refusing to spawn from a newer base. Re-prove the workspace (workspace_status) and re-issue run_dispatch with the current expectedGitHead.",
        );
      }
    }

    if (reuseWorktree) {
      // M12-7: adopt the retained parent worktree (already transitioned to
      // wao/<childRunId> at the persisted base by prepareContinuationWorktree).
      // No worktree creation, no cleanup — persistent by design. The base-commit
      // capture below re-reads HEAD (which the transition re-pinned to base) so
      // deliveryContext.baseCommit is the persisted base, value-for-value.
      worktreeInfo = { path: reuseWorktree.path, branch: reuseWorktree.branch };
      effectiveCwd = reuseWorktree.path;
    } else if (isolationConfig.type === "worktree") {
      try {
        worktreeInfo = await this.createWorktreeFn(
          agent.cwd,
          finalRunId,
          // Pin the worktree to the server-proven frozen commit (whenever one is
          // threaded) so a micro-race on the source HEAD cannot silently shift
          // the delivery base. Revalidation above already proved equality at the
          // start of this window; the pin closes the remaining rev-parse→add gap.
          frozenGitHead ? { commitish: frozenGitHead } : {},
        );
        effectiveCwd = worktreeInfo.path;
        if (isolationConfig.strategy === "ephemeral") {
          cleanupFn = () => removeWorktree(worktreeInfo.path);
        }
      } catch (error) {
        if (delivery) {
          // TD-103: delivery mode is fail-closed on worktree creation failure.
          // Do NOT fall back to source checkout — delivery requires an isolated worktree.
          throw new Error(
            `Delivery mode requires an isolated worktree, but worktree creation failed: ${error.message}`,
          );
        }
        if (readOnly) {
          // Round 4 Bundle B: a read-only run plugs the degrade below exactly
          // like delivery above. The declaration promises forced isolation; a
          // source-checkout fallback would silently void both the isolation
          // and the observation authority (worktreePath). Fail-closed typed
          // error at the dispatch preflight — run.started / the declaration /
          // the pending transition have NOT been written yet, so this is a
          // zero-side-effect refusal.
          throw new ReadOnlyWorktreeRequiredError();
        }
        await transcript.append("run.isolation_failed", { error: error.message });
        // 降级：用原 cwd 继续
      }
    }

    // TD-103 Phase 3A: capture base commit AFTER worktree creation, BEFORE backend spawn.
    // The base commit is the full hash of the worktree's HEAD at creation time.
    let deliveryContext = null;
    if (delivery && worktreeInfo) {
      const baseCommit = String(
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: worktreeInfo.path,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        }),
      ).trim();
      deliveryContext = {
        mode: "git_commit_v1",
        runId: finalRunId,
        worktreePath: worktreeInfo.path,
        baseCommit,
        allowedPaths: deliveryPrepared.allowedPaths,
        isolation: { type: "worktree", strategy: "persistent" },
        verificationCommands: deliveryPrepared.verification.commands.length > 0
          ? deliveryPrepared.verification.commands : undefined,
        verificationUnavailableReason: deliveryPrepared.verification.unavailableReason
          ?? undefined,
        // M12-6 (FR-05): Lead-authored environment setup commands (optional).
        verificationSetupCommands: deliveryPrepared.verification.setupCommands?.length > 0
          ? deliveryPrepared.verification.setupCommands : undefined,
        // M12-13: per-command execution timeout/budget (optional). Persisted
        // ONLY when declared — absence means "consumer default applies".
        ...(deliveryPrepared.verification.verificationTimeoutMs !== undefined
          ? { verificationTimeoutMs: deliveryPrepared.verification.verificationTimeoutMs }
          : {}),
      };
      // Clean undefined keys
      if (!deliveryContext.verificationCommands) delete deliveryContext.verificationCommands;
      if (!deliveryContext.verificationUnavailableReason) delete deliveryContext.verificationUnavailableReason;
      if (!deliveryContext.verificationSetupCommands) delete deliveryContext.verificationSetupCommands;
    }

    // worktree 路径（若有）作为 backend 的 cwd
    const effectiveAgent = { ...agent, cwd: effectiveCwd };

    const tagsPayload = tags ? parseTags(tags) : undefined;
    const scorecardRules = resolveScorecardRules(scorecard, agent.scorecard, scorecardMode);

    await transcript.append("run.started", {
      backend: agent.backend,
      cwd: agent.cwd,
      ...(worktreeInfo ? { worktreePath: worktreeInfo.path, worktreeBranch: worktreeInfo.branch } : {}),
      serveUrl: agent.serveUrl,
      model: agent.model,
      // R11-1: the STATIC reasoning policy, recorded unconditionally like
      // `model` above (an audit gap fix — run.started never carried the
      // registry's reasoning before; when the agent has no reasoning the
      // undefined value is dropped by JSON serialization, so ordinary
      // dispatches stay byte-compatible).
      reasoning: agent.reasoning,
      // R23-C §4: the provider ATTACHMENT fingerprint (providerKeyFor —
      // normalized baseUrl + apiKeyEnv NAME). The normalizer DROPS
      // userinfo/query/fragment, so a baseUrl carrying embedded credentials
      // can never reach the transcript the way persisting the raw provider
      // block would. Unconditional key: a lane with no provider block
      // serializes an EXPLICIT null ("observed, no provider attached") —
      // deliberately NOT undefined-dropped like `model`/`reasoning` above, so
      // run_continue's drift check can tell a legacy parent (field absent →
      // dimension skipped) from an observed-bare parent (null — a provider
      // wired after the parent ran must NOT be silently adopted). Same
      // tri-state discipline as matchedCertRecord.
      providerKey: providerKeyFor(agent.provider),
      // R10-A: the EXPLICIT override fact — the Lead's own input, never a
      // secret. `model` above already reflects the synthesized policy (the
      // synthesis precedes this append); modelOverride lets an auditor tell
      // "the registry was changed" apart from "one dispatch overrode it".
      // Absent for ordinary dispatches (byte-compatible run.started payload).
      ...(modelOverride !== null && modelOverride !== undefined
        ? { modelOverride }
        : {}),
      // R11-1: the explicit reasoning-override fact, symmetric to modelOverride
      // (and symmetric to `reasoning` above: the synthesized policy rides the
      // unconditional key, this field marks that THIS dispatch overrode it).
      // Absent for ordinary dispatches (byte-compatible run.started payload).
      ...(reasoningOverride !== null && reasoningOverride !== undefined
        ? { reasoningOverride }
        : {}),
      scorecardConfigured: Boolean(scorecardRules),
      ...(tagsPayload ? { tags: tagsPayload } : {}),
      ...(deliveryContext ? {
        delivery: {
          mode: deliveryContext.mode,
          baseCommit: deliveryContext.baseCommit,
          allowedPaths: deliveryContext.allowedPaths,
          ...(deliveryContext.verificationCommands
            ? { verificationCommands: deliveryContext.verificationCommands }
            : { verificationUnavailableReason: deliveryContext.verificationUnavailableReason }),
          // M12-6 (FR-05): persist Lead-authored setup commands so resume and the
          // exact verifier restore the same environment contract. Absent when
          // none declared (event shape unchanged for ordinary deliveries).
          ...(deliveryContext.verificationSetupCommands
            ? { verificationSetupCommands: deliveryContext.verificationSetupCommands }
            : {}),
          // M12-13: persist the per-command execution timeout/budget so resume
          // and the exact verifier restore the same budget. Absent when not
          // declared (event shape unchanged for ordinary deliveries).
          ...(deliveryContext.verificationTimeoutMs !== undefined
            ? { verificationTimeoutMs: deliveryContext.verificationTimeoutMs }
            : {}),
          // TD-103 Phase 3A: persist resolved scorecardRules inside delivery
          // metadata so resume restores the exact same gate. Ordinary runs
          // (no delivery) keep their original event shape unchanged.
          ...(scorecardRules ? { scorecardRules } : {}),
        },
      } : {}),
    });
    // Round 4 Bundle B: the read-only DECLARATION durable fact — written at
    // start, exactly once (the append is an idempotent CAS, so the foreground
    // and runner paths share ONE single write point). Empty bounded payload:
    // the envelope IS the fact. Its presence in a snapshot is what mounts the
    // advisory readOnlyObservation in the activity projection; it never gates
    // anything.
    if (readOnly) {
      await transcript.appendReadOnlyDeclared();
    }
    const pendingResult = await this._transition(transcript, null, "pending", STATE_CHANGE_REASON.created);
    // TD-99：若 pending rejected（runId 已有终态——如同 runId 复用旧终态 transcript），
    // 不得 spawn backend，立即报已有终态。
    if (!pendingResult.accepted) {
      if (cleanupFn) await safeCleanup(cleanupFn, transcript);
      throw new Error(`Cannot start run ${finalRunId}: transcript already in terminal state "${pendingResult.state}" (first-terminal-wins)`);
    }

    // backend 已在前面（role-contract capability 决策前）由 this.backendFor(agent)
    // 创建一次，这里复用——它只在 spawn 时才读 agent.cwd/binary，所以与 effectiveAgent
    // 选出的实例一致。

    // P1-1 认证新鲜度强制门（opt-in，06-18 事故教训"调度安全不能建立在模型行为假设上"）。
    // 启用时：读 runDir/reliability-summary.json，校验目标 worker。
    // 放行阈值（owner 决策 2026-06-24）：core 全过即放行 —— status ∈ {certified, conditional}。
    //   certified = core+strict+ops 全过；conditional = core 全过、strict/ops 部分。
    //   strict（command/file）是能力画像不是安全闸；core（completion/answer/sentinel）才是安全底线。
    //   draft-only（core 部分过）/rejected（core 失败）= 拒绝。
    // 身份（TD-131 → R23-C 四元组）：记录的 backend/modelId/providerKey
    //   （providerID 双侧声明时同比对；providerKey 记录侧 undefined = legacy 跳过、
    //   显式 null = 已观察无接入方）必须与当前 registry 该 agent 的配置一致
    //   （matchedCertRecord SSOT，与显示层投影共用）——改配置换 backend/model/
    //   接入方后不重跑 reliability，旧组合的认证不得放行。不匹配 → 按未认证拒绝，
    //   固定文案（不回显 summary/registry 值——磁盘数据可能被改）。
    // 新鲜度（TD-132 → R23-C §2）：按 per-worker 的 lastFullHealthyRunAt 判
    //   （仅 full-scope 且全绿的 case 才刷新，scripts/reliability/certification.mjs
    //   写入）；legacy 记录缺该字段 → 回落 lastHealthyRunAt。缺失/不可解析 →
    //   fail-closed 拒绝。旧判据读整份 summary 的 generatedAt——重考任一 worker 即
    //   刷新全本台账，其余 worker 的陈旧认证被"洗白"；且 generatedAt 缺失/不可解析
    //   时旧逻辑竟放行。
    // 例外：w.manualOverride === "cleared" 时强制放行（owner 手动背书，绕过
    //   status/身份/新鲜度——人判断优先；TD-131/132 前后语义不变）。
    // opt-in 默认关：不破坏现有测试/使用；CI 或监督派发场景显式启用。
    const DISPATCHABLE = new Set(["certified", "conditional"]);
    if (requireCertified) {
      const summaryPath = join(dir, "reliability-summary.json");
      let summary = null;
      try { summary = JSON.parse(readFileSync(summaryPath, "utf8")); } catch { /* 缺 summary = 未认证 */ }
      const w = summary?.workers?.[agentId];
      const reasons = [];
      if (!summary) reasons.push("reliability-summary.json 不存在");
      else if (!w) reasons.push(`worker "${agentId}" 未在 reliability-summary 中`);
      else if (w.manualOverride === "cleared") {
        // owner 手动背书，放行（不检查 status / 身份 / 新鲜度——人判断优先）
      } else if (!matchedCertRecord(agent, w)) {
        reasons.push("认证身份不匹配（summary 记录与当前 registry 配置的 backend/modelId/providerID/providerKey 不一致，认证不可继承，需按当前配置重新认证）");
      } else if (!DISPATCHABLE.has(w.status)) {
        reasons.push(`status=${w.status}（需 core 全过：certified/conditional，或 manualOverride=cleared）`);
      } else {
        // R23-C §2：新鲜度读 lastFullHealthyRunAt（仅全量 scope 且全绿才刷新——
        // delta 全绿不得洗白全量口径的派发新鲜度）。半迁移兼容：legacy summary
        // 缺该字段（undefined）→ 回落旧判据 lastHealthyRunAt；显式 null（记录侧
        // 无条件写：从未全量绿）→ fail-closed。文案锚点（无新鲜认证/认证已过期）
        // 与既有断言保持一致；字段名如实标注实际读取的字段。过期 reason 只展示
        // 天数，绝不回显磁盘时间戳原文。
        const freshnessRaw = w.lastFullHealthyRunAt === undefined ? w.lastHealthyRunAt : w.lastFullHealthyRunAt;
        const freshnessField = w.lastFullHealthyRunAt === undefined ? "lastHealthyRunAt" : "lastFullHealthyRunAt";
        const healthyAtMs = typeof freshnessRaw === "string" ? new Date(freshnessRaw).getTime() : Number.NaN;
        if (!Number.isFinite(healthyAtMs)) {
          reasons.push(`无新鲜认证（该 worker 的 ${freshnessField} 缺失或不可解析，按未认证处理——请重跑 reliability 认证）`);
        } else {
          const ageDays = (Date.now() - healthyAtMs) / 86_400_000;
          if (ageDays > certFreshnessDays) {
            reasons.push(`认证已过期（${freshnessField} 距今 ${Math.round(ageDays)}天 > ${certFreshnessDays}天）`);
          }
        }
      }
      if (reasons.length > 0) {
        await transcript.append("run.error", { phase: "certification-gate", agentId, reasons });
        await this._transition(transcript, "pending", "failed", STATE_CHANGE_REASON.certification_gate);
        if (cleanupFn) await safeCleanup(cleanupFn, transcript);
        throw new Error(
          `Refused dispatch: worker "${agentId}" did not pass core certification — ${reasons.join("; ")}. `
          + `Run \`npm run reliability -- --agent ${agentId}\` to certify, or set manualOverride:"cleared" if owner-backed. `
          + `(06-18 lesson: dispatch safety must not rely on model-behavior assumptions). See docs/team-roles.md.`
        );
      }
    }

    // P0-1 护栏（审计 P0 / TD-39 / 2026-06-18 事故）：
    // fire-and-forget + sessionOutlivesProcess 的 backend = 孤儿 session（不经 waitForCompletion
    // 内的三层防线）= 06-18 事故路径。CLI 已在 P2 改为路由 --background runner 托管（不再裸 fire-and-forget），
    // 此处保留作**深度防御**：直接编程调 RunManager（绕过 CLI）仍不可造孤儿。按 backend 属性判定（runtime-agnostic）。
    if (fireAndForget && backend.sessionOutlivesProcess) {
      await transcript.append("run.error", {
        phase: "fire-and-forget-guard",
        backend: agent.backend,
      });
      await this._transition(transcript, "pending", "failed", STATE_CHANGE_REASON.fire_forget_guard);
      if (cleanupFn) await safeCleanup(cleanupFn, transcript);
      throw new Error(
        `Refused fire-and-forget spawn: backend "${agent.backend}" holds sessions outside the WAO process `
        + `(sessionOutlivesProcess=true). Without an owner driving waitForCompletion, this run would bypass `
        + `the token-budget gate, event polling, and cleanup abort — the exact path of the 2026-06-18 quota-drain `
        + `incident (7.4h runaway session). Either call waitForCompletion, or use the detached background runner `
        + `(\`run/spawn --background\`) which owns the lifecycle. See docs/incidents/2026-06-18-glm-quota-drain.md + TD-39.`
      );
    }

    // TD-54 修复（spawn-failure race）：prompt.sent 必须在 backend.spawn 之前持久化。
    // 原 bug：prompt.sent 写在 spawn 之后（下方 line ~206），spawn 失败时 RunManager.start
    // 先写 terminal failed（spawn_error）再 throw，prompt.sent 永远不会从这里写——
    // 靠 backgroundRunner 的 writeStartupFailureTranscript 兜底，但那时 failed 已落盘，
    // 测试（及任何轮询 transcript 的消费者）可能在 failed 之后、prompt.sent 之前快照，
    // 拿不到 prompt。修复：spawn 前先写 prompt.sent {prompt}（不含 messageId，spawn 前还没有），
    // spawn 成功后再写第二条含 messageId/admittedSeq 的 prompt.sent（ProcessBackend 家族该值
    // 为 undefined，序列化丢键——第二写与首写同样裸落盘）；resume/retry 自 R13-C 起用
    // findLatestBound 取最后一条绑定记录，保证 opencode-serve resume 拿得到 messageId。
    await transcript.append("prompt.sent", { prompt });

    let result;
    try {
      result = await backend.spawn(effectiveAgent, {
        prompt,
        roleContract,
        resolvedCredentials,
        // M11-11C: opaque reuse routing → backend compiles --session-id/--resume.
        // Absent for non-reusable runs (backends ignore the field).
        ...(sessionReuse ? { sessionReuse } : {}),
        ...(deliveryContext ? { deliveryMode: true } : {}),
        // M12-16: correctable → backend spawns with a piped stdin + stream-json
        // input and attaches sendCorrection to the handle. Absent = byte-compatible.
        ...(correctable ? { correctable: true } : {}),
      });
    } catch (error) {
      await transcript.append("run.error", { phase: "spawn", error: error.message });
      await this._transition(transcript, "pending", "failed", STATE_CHANGE_REASON.spawn_error);
      if (cleanupFn) await safeCleanup(cleanupFn, transcript);
      throw error;
    }
    await transcript.append("session.created", {
      backend: result.backend,
      backendSessionId: result.backendSessionId,
      serveUrl: agent.serveUrl,
    });
    // spawn 成功后补写带 messageId/admittedSeq 的 prompt.sent（resume opencode-serve 流需要 messageId）。
    // 此时已过 spawn 失败分支，不会产生"terminal 先于 prompt.sent"的 race。
    await transcript.append("prompt.sent", {
      messageId: result.messageId,
      admittedSeq: result.admittedSeq,
      prompt,
    });
    await transcript.append("run.submitted", {});
    const submittedResult = await this._transition(transcript, "pending", "submitted", STATE_CHANGE_REASON.spawned);
    // TD-99：若 submitted rejected（spawn 期间外部写了终态，如 stop/abort），best-effort
    // abort 新 handle、执行 cleanup、不注册 activeRuns、抛明确错误。
    if (!submittedResult.accepted) {
      try { await result.abort?.(); } catch { /* best-effort */ }
      if (cleanupFn) await safeCleanup(cleanupFn, transcript);
      throw new Error(`Run ${finalRunId} became terminal "${submittedResult.state}" during spawn (first-terminal-wins); new handle aborted`);
    }

    const run = new Run({
      runId: finalRunId,
      agentId,
      agent,
      backend,
      handle: result,
      transcript,
      result,
      config: this.config,
      onRemove: () => this.activeRuns.delete(finalRunId),
      cleanup: cleanupFn,
      effectiveCwd,
      scorecardRules,
      deliveryContext,
      packageDeliveryFn: this.packageDeliveryFn,
      verifyDeliveryFn: this.verifyDeliveryFn,
      correctable,
    });
    this.activeRuns.set(finalRunId, run);
    this._ensureSigintHandler();
    return run;
  }

  async resume(runId, options = {}) {
    const { runDir } = options;
    const dir = resolve(runDir ?? this.config.runDir);
    const transcript = new JsonlTranscript(join(dir, `${runId}.jsonl`), {
      runId,
      agentId: "unknown",
    });
    const events = await readTranscript(transcript.filePath);
    if (events.length === 0) {
      return null;
    }
    transcript.context.agentId = events[0]?.agentId ?? "unknown";
    transcript.seq = events.at(-1)?.seq ?? 0;

    // R18 (TD-128 W3)：resume 的终态门改绑定过滤（R15 范式——
    // `findState(events.filter(bound))`，runDelivery.js:364 / sessionReuse.js
    // R15 同款）。注册危害：外 run 伪 running 尾条可把 terminal run 的 resume
    // 拒绝翻成接续（findState 末条胜出）；反向的伪 terminal 尾条误拒合法续接。
    // 绑定后状态只由本 run 自身事件计算。
    // legacy 衔接（R15"不可归属按 busy/拒绝"语义）：全无信封的 pre-envelope
    // transcript 过滤为零事件 → findState([]) = "pending" → 过终态门后由下方
    // R13-C 绑定 session/run.started 读取落入既有 return null 拒绝——与修复前
    // 在终态门拒绝（null）同一外部结果（legacy resume 本就自 R13-C 起拒绝，
    // 见 resumeBoundRead.test.js R13C-RESUME-5），仅拒绝门位置不同。
    const state = findState(events.filter((e) => e && e.runId === runId));
    if (TERMINAL_STATES.includes(state)) {
      return null;
    }

    // R13-C (TD-127 family sweep, auditor P2-1): resume's session/run.started
    // reads are BOUND to this runId and keep their FIRST-match order — the
    // established resume discipline (the authoritative facts are the FIRST
    // appends; a tail append must never hijack attach/replay). The old unbound
    // events.find trusted ANY line of the right type: auditor probe showed a
    // tail-appended foreign prompt/session driving resume (a cross-runId
    // forged prompt.sent got re-spawned verbatim by the replay branch).
    // Legacy no-envelope transcripts (events without runId) no longer match →
    // resume returns null here — the lane's existing refusal shape
    // (Lead-accepted R13-C; same semantics as R12-C C-5).
    const session = findFirstBound(events, "session.created", runId);
    const runStarted = findFirstBound(events, "run.started", runId);
    if (!session?.backendSessionId || !runStarted) {
      return null;
    }

    const registryPath = resolve(options.registry ?? this.config.registry);
    const loaded = await this.readRegistry(registryPath);

    // TD-103 Phase 3A audit: reconstruct delivery context from run.started for resume.
    // Must validate BEFORE spawn/attach: use SSOT prepareDeliveryRequest + prove worktree state.
    const deliveryContext = _reconstructDeliveryContext(runStarted, runId);
    if (runStarted.delivery && !deliveryContext) {
      // Transcript says delivery mode but context is malformed/missing — fail closed.
      return null;
    }
    if (deliveryContext) {
      // Full fail-closed validation: re-validate the delivery request through SSOT,
      // then prove the worktree is still a persistent linked worktree at the correct
      // branch and base commit. This prevents resume from spawning into a stale or
      // missing worktree, or using a corrupted delivery context.
      try {
        prepareDeliveryRequest({
          mode: deliveryContext.mode,
          allowedPaths: deliveryContext.allowedPaths,
          ...(deliveryContext.verificationCommands
            ? { verificationCommands: deliveryContext.verificationCommands }
            : { verificationUnavailableReason: deliveryContext.verificationUnavailableReason }),
          ...(deliveryContext.verificationSetupCommands
            ? { verificationSetupCommands: deliveryContext.verificationSetupCommands }
            : {}),
          // M12-13: re-validate the persisted per-command execution budget
          // through the SAME SSOT. A malformed persisted value makes resume
          // refuse (null) BEFORE any transcript append / spawn / attach /
          // packaging — the persisted value is authoritative and must survive
          // resume exactly as declared.
          ...(deliveryContext.verificationTimeoutMs !== undefined
            ? { verificationTimeoutMs: deliveryContext.verificationTimeoutMs }
            : {}),
        });
        proveLinkedWorktree(deliveryContext);
      } catch {
        // Validation failed — do not spawn/attach
        return null;
      }
    }

    // TD-103 audit: for delivery runs, the agent cwd must be the worktree path,
    // NOT the source repo (runStarted.cwd is the source repo). Non-delivery runs
    // keep using runStarted.cwd as before.
    const resumeCwd = deliveryContext ? deliveryContext.worktreePath : runStarted.cwd;
    let agent = loaded.getAgent(transcript.context.agentId, { cwd: resumeCwd });
    // R10-C C-1: rebuild the per-dispatch model override from run.started — the
    // SAME authoritative source the delivery context above is rebuilt from.
    // run.started.modelOverride is the durable fact that THIS dispatch carried
    // --model; resume re-reading the registry alone would run the back half of
    // the run on the registry model with no model-switch fact anywhere in the
    // transcript (the daemon --resume-on-start takeover path: dispatch with
    // --model → runner dies → daemon resumes → silent model switch). Same
    // synthesis and shape gate as start: present-and-valid → only .id is
    // replaced (every sibling field survives); present-but-INVALID (a corrupt
    // or tampered persisted fact) → fail closed: return null exactly like a
    // malformed delivery context — never spawn a model the transcript does not
    // license. Absent → the registry model, byte-compatible with the old face.
    const resumeModelOverride = runStarted.modelOverride;
    if (resumeModelOverride !== null && resumeModelOverride !== undefined) {
      if (!isValidModelOverride(resumeModelOverride)) return null;
      agent = { ...agent, model: { ...(agent.model ?? {}), id: resumeModelOverride } };
    }
    // R11-1: rebuild the per-dispatch reasoning effort override from the SAME
    // run.started authority (the R10-C C-1 precedent, one fact later). Without
    // this, a daemon-resumed run dispatched with --reasoning would silently
    // run the back half on the registry effort with no override fact anywhere
    // in the transcript — the exact R10-C C-1 accident class. Same synthesis
    // and shape gate as start: present-and-in-the-closed-set → only `.effort`
    // is replaced; present-but-INVALID (a corrupt/tampered persisted fact) →
    // fail closed: return null, zero re-spawns. Absent → the registry
    // reasoning, byte-compatible with the old face.
    const resumeReasoningOverride = runStarted.reasoningOverride;
    if (resumeReasoningOverride !== null && resumeReasoningOverride !== undefined) {
      if (!isValidReasoningOverride(resumeReasoningOverride)) return null;
      agent = { ...agent, reasoning: { ...(agent.reasoning ?? {}), effort: resumeReasoningOverride } };
    }

    // M11-5 Package A2：获取 backend 一次，前置到角色合同决策前——决策由
    // backend 能力（supportsRoleContract）驱动，不认识 runtime 名称。该 backend
    // 实例在下方 spawn/attach 复用。
    const backend = this.backendFor(agent);

    // M11-9 CTO closeout: validate backend policy BEFORE any transcript append
    // or spawn on the resume path (same as start). FAIL-CLOSED only when a
    // structured policy is present. R10-C: the rebuilt override (C-1) rides the
    // same hint-appending wrapper as start, so a daemon-resumed run whose
    // inherited model cannot be expressed gets the --model-naming sentence too.
    // R11-1: the rebuilt reasoning override rides the same wrapper with its own
    // shape (a resumed --reasoning dispatch gets the --reasoning-naming one).
    const resumeHasPolicy = agent.model || agent.reasoning || agent.provider;
    if (resumeHasPolicy) {
      if (typeof backend.validateAgentPolicy !== "function") {
        throw new Error("backend does not implement validateAgentPolicy — cannot confirm it can express the configured policy");
      }
      validateAgentPolicyWithOverrideHint(backend, agent, {
        modelOverride: resumeModelOverride,
        reasoningOverride: resumeReasoningOverride,
      });
    }

    // M11-5（TD-89 修复）：resume 也必须重新经过同一角色合同加载器，不得静默
    // 漏掉。与 start 路径同一 SSOT（roleContract.js），同一 fail-closed 边界。
    // 路径解析同样由 loadRoleContract 内部相对 WAO 安装根处理（不依赖 cwd）。
    // Package A2：不支持角色注入的 backend 配了 systemPrompt 必须显式抛错
    // （不再静默 return null）——resume 不能假装成功然后丢掉角色。错误是固定
    // 安全形状。这里在 spawn/attach 前拒绝，spawn 计数为 0、transcript 字节不变。
    // Package C2 严格性：只有 supportsRoleContract === true 才允许（truthy 非-true 拒绝）。
    let resumeRoleContract = undefined;
    if (agent.systemPrompt) {
      if (backend.supportsRoleContract !== true) {
        throw new Error(
          `Agent ${transcript.context.agentId}: systemPrompt is configured but the selected backend does not support role contract injection. ` +
          `Remove systemPrompt from this agent, or switch to a backend that declares supportsRoleContract.`
        );
      }
      resumeRoleContract = composeRoleContractWithIdentity({
        roleContract: loadRoleContract(agent.systemPrompt),
        agentId: transcript.context.agentId,
      });
    }

    // M11-8C closeout (Gap A): a DELIVERY run that resumes MUST re-inject the
    // control-plane-owned Delivery Execution Contract — the same contract the
    // start path injects. Production RED: the resume path previously omitted it,
    // so a resumed delivery worker could self-commit again and reproduce the
    // base_commit_mismatch incident. The contract is composed AHEAD of any role
    // contract and carried via task.roleContract (each backend injects once).
    // An unsupported backend fails closed here, BEFORE any append/spawn
    // (transcript bytes unchanged) — delivery resume cannot proceed without a
    // way to deliver the no-commit contract.
    //
    // M12-14 Package 1: the contract is composed FROM the persisted
    // deliveryContext.allowedPaths — the exact list the control plane froze at
    // start. start and resume therefore deliver the byte-identical work-order
    // SSOT; a resumed worker sees the same authorized scope it started with.
    if (deliveryContext) {
      if (backend.supportsRoleContract !== true) {
        throw new Error(
          `Agent ${transcript.context.agentId}: delivery resume requires role contract injection (to deliver the delivery execution contract), ` +
          `but the selected backend does not support it. ` +
          `Switch to a backend that declares supportsRoleContract.`
        );
      }
      const deliveryContract = composeDeliveryExecutionContract({
        allowedPaths: deliveryContext.allowedPaths,
      });
      resumeRoleContract = resumeRoleContract
        ? `${deliveryContract}\n\n---\n\n${resumeRoleContract}`
        : deliveryContract;
    }

    // Same dynamic transport proof as start. Resume may read the existing
    // transcript to reconstruct context, but this runs before append/spawn and
    // therefore preserves transcript bytes on refusal.
    await validateRoleContractTransport(backend, agent, resumeRoleContract);

    // M11-7 (CTO closeout): credential availability check on resume too — same
    // SSOT as start/dispatchRun/registry_list. Missing REQUIRED credential →
    // throw (spawn count 0, transcript bytes unchanged). Resolved values are
    // passed to the resume spawn for the worker child env + redactor.
    const resumeReadiness = await assessWorkerReadiness({
      agent, resolver: createEnvResolver(this.userEnvReader), names: inheritedEnvNames(agent),
    });
    if (resumeReadiness.credentialAvailability === "missing") {
      throw new Error(
        `Agent ${transcript.context.agentId}: missing required credential env: ${resumeReadiness.missingCredentialEnvNames.join(", ")}.`,
      );
    }
    const resumeResolvedCredentials = resumeReadiness.resolvedEnv;

    // TD-103 Phase 3A: restore scorecardRules ONLY for delivery runs, from the
    // exact snapshot persisted inside delivery metadata in run.started.
    // Non-delivery resume keeps the 9e25c5c baseline behavior: scorecardRules=null.
    // (A general resume-scorecard fix is a separate concern, not in Phase 3A scope.)
    let resumeScorecardRules = null;
    if (deliveryContext && runStarted.scorecardConfigured) {
      if (!runStarted.delivery?.scorecardRules || typeof runStarted.delivery.scorecardRules !== "object") {
        // Delivery run with scorecard configured but snapshot missing → fail closed.
        return null;
      }
      resumeScorecardRules = runStarted.delivery.scorecardRules;
    }

    // Process-style backends replay the persisted prompt into a fresh process.
    // Production backends declare replayByRespawn explicitly. The capability
    // fallback preserves the long-standing contract for injected/test backends:
    // a backend that can spawn but has no attach stream cannot be treated as an
    // HTTP/session backend. This remains provider-neutral and avoids routing an
    // otherwise resumable backend into a missing streamEvents method.
    if (backend.replayByRespawn === true || typeof backend.streamEvents !== "function") {
      // TD-54：prompt.sent 可能写两条，取最后一条（两条都有 .prompt，无差别）。
      // R13-C：读取带 runId 绑定——尾部追加的外 run 伪造 prompt.sent 不得被
      // 原样重放进新进程（auditor 探针实证修复前会被 RESPAWN）。
      const promptEvent = findLatestBound(events, "prompt.sent", runId);
      if (!promptEvent?.prompt) return null;
      const originalSessionId = session.backendSessionId;
      // R7-C (C-5): same capability-gated cwd existence assert as start (layer
      // 2) — the replay re-spawn is a LOCAL OS spawn with cwd: agent.cwd
      // (non-delivery runs: the run.started.cwd merged via getAgent; delivery
      // runs: the worktree path, which proveLinkedWorktree above already
      // proved exists). Without this, a non-delivery run whose cwd was deleted
      // between start and resume re-spawned into the misleading
      // executable-ENOENT face the R7-AB fix closed at start. Runs BEFORE any
      // append/spawn (transcript bytes unchanged on refusal); HTTP-shape
      // backends (no preflightInvocation) attach, never re-spawn locally, and
      // are unaffected.
      if (typeof backend.preflightInvocation === "function") {
        assertExistingDispatchCwd({ explicitCwd: undefined, agentCwd: agent.cwd });
      }
      // M12-14 Package 1: preflight the re-spawn BEFORE any append/spawn, mirroring
      // start. The persisted prompt + re-composed roleContract (carrying the
      // delivery contract + scope block) feed the SAME compileInvocation budget
      // check spawn runs; an overflow fails fixed-safe here — no run.rerun append,
      // no spawn. Same determinism assumption as start's preflight (best-effort
      // early gate, not a byte-identity guarantee); spawn rechecks authoritatively.
      if (typeof backend.preflightInvocation === "function") {
        await backend.preflightInvocation(agent, {
          prompt: promptEvent.prompt,
          roleContract: resumeRoleContract,
          ...(deliveryContext ? { deliveryMode: true } : {}),
        });
      }
      // 重新 spawn 新进程
      const newResult = await backend.spawn(agent, {
        prompt: promptEvent.prompt,
        roleContract: resumeRoleContract,
        resolvedCredentials: resumeResolvedCredentials,
        ...(deliveryContext ? { deliveryMode: true } : {}),
      });
      await transcript.append("run.rerun", {
        originalSessionId,
        newSessionId: newResult.backendSessionId,
        reason: "replay",
      });
      await this._transition(transcript, state, "submitted", STATE_CHANGE_REASON.replay_respawned);
      const run = new Run({
        runId,
        agentId: transcript.context.agentId,
        agent,
        backend,
        handle: newResult,
        transcript,
        result: newResult,
        config: this.config,
        onRemove: () => this.activeRuns.delete(runId),
        initialState: "submitted",
        ...(deliveryContext ? { effectiveCwd: deliveryContext.worktreePath } : {}),
        scorecardRules: resumeScorecardRules,
        deliveryContext,
        packageDeliveryFn: this.packageDeliveryFn,
        verifyDeliveryFn: this.verifyDeliveryFn,
      });
      this.activeRuns.set(runId, run);
      this._ensureSigintHandler();
      return run;
    }

    // HTTP 类 backend（opencode-serve）→ attach 到已有 session
    const serveUrl = agent.serveUrl;
    const sessionId = session.backendSessionId;
    // TD-103 audit: delivery runs use worktree cwd for streamEvents polling.
    const cwd = resumeCwd;
    // TD-54 修复：prompt.sent 现在可能写两条（spawn 前 {prompt} + spawn 后 {messageId,...}），
    // resume 取最后一条才有 messageId（opencode-serve resume 流需要）。
    // R13-C：读取带 runId 绑定——外 run 尾条不得供给 attach 的
    // messageId/admittedSeq。
    const boundPromptEvent = findLatestBound(events, "prompt.sent", runId);
    const handle = {
      backend: session.backend,
      backendSessionId: sessionId,
      messageId: boundPromptEvent?.messageId,
      admittedSeq: boundPromptEvent?.admittedSeq,
      events: (signal, opts) => backend.streamEvents(serveUrl, sessionId, { cwd, signal, interval: opts?.pollInterval }),
      abort: async () => backend.abort(serveUrl, sessionId),
    };

    const run = new Run({
      runId,
      agentId: transcript.context.agentId,
      agent,
      backend,
      handle,
      transcript,
      result: handle,
      config: this.config,
      onRemove: () => this.activeRuns.delete(runId),
      initialState: state,
      ...(deliveryContext ? { effectiveCwd: deliveryContext.worktreePath } : {}),
      scorecardRules: resumeScorecardRules,
      deliveryContext,
      packageDeliveryFn: this.packageDeliveryFn,
      verifyDeliveryFn: this.verifyDeliveryFn,
    });
    this.activeRuns.set(runId, run);
    this._ensureSigintHandler();
    return run;
  }

  async abort(runId, reason = STATE_CHANGE_REASON.user) {
    const run = this.activeRuns.get(runId);
    if (!run) return false;
    this.activeRuns.delete(runId);
    await run._abortInternal(reason);
    return true;
  }

  list() {
    return [...this.activeRuns.values()];
  }

  async _transition(transcript, from, to, reason) {
    // TD-99：走原子终态仲裁。accepted 才触发 friction hook；rejected 同步不触发。
    const result = await transcript.transitionState(from, to, reason);
    if (result.accepted) {
      // TD-92 debug mode：预生成失败（certification_gate/fire_forget_guard/spawn_error）也捕获 friction
      if (to === "failed" || to === "timed_out" || to === "aborted") {
        const ctx = transcript.context ?? {};
        _maybeWriteFrictionLogFromTranscript(transcript, ctx.runId, ctx.agentId, this.config).catch(() => {});
      }
    }
    return result;
  }
}

/**
 * TD-92：RunManager 层的 friction 捕获（预生成失败路径，无 Run 实例）。
 * 从 transcript 读 events + 调 writeFrictionLog。fire-and-forget，不阻塞。
 */
async function _maybeWriteFrictionLogFromTranscript(transcript, runId, agentId, config) {
  const events = await readTranscript(transcript.filePath);
  const frictionLogDir = frictionLogDirFromRunDir(config.runDir);
  await writeFrictionLog(runId ?? "unknown", agentId ?? "unknown", events, {
    frictionLogDir,
    debugMode: config.debugMode,
  });
}

function parseTags(tags) {
  const arr = Array.isArray(tags) ? tags : [tags];
  return arr.reduce((acc, t) => {
    const [key, ...rest] = t.split("=");
    acc[key] = rest.join("=");
    return acc;
  }, {});
}

/**
 * 解析隔离配置。优先级：isolate flag > agent.isolation > config default。
 * isolate flag: true=worktree(persistent), false=none
 * agent.isolation: "worktree" | "none" | { type, strategy }
 * 返回 { type: "worktree"|"none", strategy: "persistent"|"ephemeral" }
 */
function resolveIsolation(isolate, agentIsolation, defaultIsolation) {
  // flag 最高优先
  if (isolate === true) return { type: "worktree", strategy: "persistent" };
  if (isolate === false) return { type: "none", strategy: "persistent" };
  // agent 配置
  if (agentIsolation) {
    if (typeof agentIsolation === "string") {
      return { type: agentIsolation, strategy: "persistent" };
    }
    return {
      type: agentIsolation.type ?? "none",
      strategy: agentIsolation.strategy ?? "persistent",
    };
  }
  // config 默认
  return { type: defaultIsolation ?? "none", strategy: "persistent" };
}

/** 安全执行 cleanup，失败只记 transcript 不抛错 */
async function safeCleanup(cleanupFn, transcript) {
  try {
    await cleanupFn();
  } catch (error) {
    await transcript.append("run.cleanup_error", { phase: "spawn_fail", error: error.message });
  }
}

/**
 * TD-103 Phase 3A: reconstruct delivery context from run.started transcript event.
 * Returns null if no delivery was configured, or if required fields are missing.
 * Full validation (mode/allowedPaths/verification) is done by prepareDeliveryRequest
 * after reconstruction. This function only checks structural presence.
 * @param {object} runStarted — run.started event
 * @param {string} runId
 * @returns {object|null} delivery context or null
 */
function _reconstructDeliveryContext(runStarted, runId) {
  if (!runStarted?.delivery) return null;
  const d = runStarted.delivery;
  if (!d.mode || !d.baseCommit || !Array.isArray(d.allowedPaths)) return null;
  if (!runStarted.worktreePath) return null;
  const hasCommands = Array.isArray(d.verificationCommands) && d.verificationCommands.length > 0;
  const hasReason = typeof d.verificationUnavailableReason === "string" && d.verificationUnavailableReason.length > 0;
  if (!hasCommands && !hasReason) return null;
  // M12-6 (FR-05): reconstruct optional setup commands if persisted.
  const hasSetup = Array.isArray(d.verificationSetupCommands) && d.verificationSetupCommands.length > 0;
  // M12-13: reconstruct the persisted per-command execution budget if present.
  // hasOwnProperty distinguishes ABSENT from PRESENT-BUT-MALFORMED: an invalid
  // persisted value IS forwarded, so prepareDeliveryRequest revalidation rejects
  // it and resume refuses (null) — never silently defaults a corrupt value.
  const hasTimeout = Object.prototype.hasOwnProperty.call(d, "verificationTimeoutMs");
  return {
    mode: d.mode,
    runId,
    worktreePath: runStarted.worktreePath,
    baseCommit: d.baseCommit,
    allowedPaths: [...d.allowedPaths],
    isolation: { type: "worktree", strategy: "persistent" },
    ...(hasCommands
      ? { verificationCommands: [...d.verificationCommands] }
      : { verificationUnavailableReason: d.verificationUnavailableReason }),
    ...(hasSetup ? { verificationSetupCommands: [...d.verificationSetupCommands] } : {}),
    ...(hasTimeout ? { verificationTimeoutMs: d.verificationTimeoutMs } : {}),
  };
}


/**
 * 解析 scorecard rules（M6-6 + M8-1 默认 warn）。优先级：
 *   显式 options.scorecard > agent.scorecard > scorecardMode 决定的默认 > null
 *
 * M8-1：未传显式 rules 时，按 scorecardMode 决定默认行为（把"防伪完成"从 opt-in 升级为默认）：
 *   - "warn"（默认）：返回 { requireEvidence:true, mode:"warn" } —— 不阻塞完成，只记留痕
 *   - "hard"：返回 { requireEvidence:true, mode:"hard" } —— 无证据 → failed（升级硬闸）
 *   - "off"：返回 null —— 完全关闭（恢复旧 opt-in 行为，向后兼容）
 * 显式 scorecard 不受默认影响（显式优先）。
 *
 * null 表示不开启 scorecard（无 rules = 当前行为不变）。
 * @returns {object|null} rules 对象，或 null（不门控）
 */
function resolveScorecardRules(optionsScorecard, agentScorecard, scorecardMode = "warn") {
  if (optionsScorecard) return optionsScorecard.rules ?? {};
  if (agentScorecard) return agentScorecard.rules ?? {};
  // M8-1：无显式 rules 时按 scorecardMode 决定默认。off = 完全关闭（向后兼容）。
  if (scorecardMode === "off") return null;
  const mode = scorecardMode === "hard" ? "hard" : "warn"; // 默认 + 未知值都降级为 warn
  return { requireEvidence: true, mode };
}

/**
 * Run 是单个运行的句柄。M1 起通过消费 handle.events 流驱动状态机。
 */
export class Run {
  constructor({
    runId,
    agentId,
    agent,
    backend,
    handle,
    transcript,
    result,
    config,
    onRemove,
    initialState = "submitted",
    cleanup = null,
    effectiveCwd = null,
    scorecardRules = null,
    deliveryContext = null,
    packageDeliveryFn = defaultPackageDelivery,
    verifyDeliveryFn = defaultVerifyDelivery,
    correctable = false,
  }) {
    this.runId = runId;
    this.agentId = agentId;
    this.agent = agent;
    this.backend = backend;
    this.handle = handle;
    this.transcript = transcript;
    this._redact = typeof handle.redact === "function"
      ? (value) => handle.redact(value)
      : (typeof transcript.redact === "function"
        ? (value) => transcript.redact(value)
        : createSecretRedactor().redact);
    this.result = result;
    this.config = config;
    this.onRemove = onRemove;
    this.state = initialState;
    this._aborted = false;
    this._removed = false;
    this._cleanup = cleanup;
    this._cleaned = false;
    // 会话兜底 abort 标志（事故修复 2026-06-17）：HTTP 类 backend 的 serve session
    // 在 run 结束后可能继续生成。对无限多轮模型（DeepSeek-v4-flash）是 quota 黑洞。
    // _runCleanup 必须兜底调一次 handle.abort，此 flag 保证只调一次（user-abort 路径
    // 已通过 _abortInternal 调过，不重复）。注意：这只证明已发送 abort，不证明后台静默。
    this._sessionKilled = false;
    this.effectiveCwd = effectiveCwd ?? agent.cwd;
    this.scorecardRules = scorecardRules;
    // TD-103 Phase 3A: delivery context for packaging after completion.
    this.deliveryContext = deliveryContext;
    this._packageDeliveryFn = packageDeliveryFn;
    this._verifyDeliveryFn = verifyDeliveryFn;
    // M12-16: correctable runs drain the transcript-backed correction queue in
    // waitForCompletion (onPollTick) and reject outstanding requests at cleanup.
    this.correctable = correctable === true;
    this._correctionsClosed = false;
    this._deliveryPackaged = false; // guard: package at most once
    // TD-103 Phase 3B concurrency final closeout: transcript-atomic verification.
    //
    // Concurrency state machine for _verifyDeliveryResult:
    //   _verificationComputePromise — shared in-flight Promise for the verifier
    //     computation. Created once; all concurrent callers await the same
    //     Promise so the verifier runs exactly once.
    //   _pendingVerificationResult — immutable result once the compute Promise
    //     resolves. Survives across append retries.
    //   _verificationAppendPromise — shared in-flight Promise for the transcript
    //     append of the outcome event. Created per append attempt; cleared on
    //     failure so an explicit retry can re-attempt.
    //   _verificationRecorded — set true ONLY after the outcome event is on
    //     disk. Once true, _recordedVerificationResult is the idempotent answer.
    this._verificationComputePromise = null;
    this._pendingVerificationResult = null;
    this._verificationAppendPromise = null;
    this._verificationRecorded = false;
    this._recordedVerificationResult = null;
  }

  /**
   * 消费 handle.events 流驱动状态机（M1：events 驱动，替代 M0 桥接）。
   *
   * 职责分工（M1 决策）：
   *   - done 事件由 backend emit（backend 知道何时完成）
   *   - 超时由 RunManager 管（AbortController 打断 events 流）
   */
  async waitForCompletion(options = {}) {
    // M10-pre3: unified timeout precedence via SSOT — default is now disabled.
    const { resolveWaitTimeout } = await import("./application/timeoutPolicy.js");
    const { ms: waitTimeout, source: waitTimeoutSource, enabled: deadlineEnabled } = resolveWaitTimeout({
      explicit: options.waitTimeout,
      agentWaitTimeout: this.agent?.waitTimeout,
      globalWaitTimeout: this.config.waitTimeout,
    });
    const pollInterval = Number(options.pollInterval ?? this.config.pollInterval);
    // silentTimeout：静默无响应早失败（Kimi 白名单 / 不存在的 model）。
    const silentTimeout = options.silentTimeout ?? this.agent?.silentTimeout ?? this.config.silentTimeout;

    // token 预算硬闸门（S1-1）：唯一不依赖 abort 是否生效的防线。
    const tokenBudget = options.tokenBudget ?? this.agent?.tokenBudget ?? this.config.tokenBudget;
    const tokenBudgetMultiplier = options.tokenBudgetMultiplier
      ?? this.agent?.tokenBudgetMultiplier ?? this.config.tokenBudgetMultiplier ?? 100;

    // M10-pre3: record actual wait policy as a safe durable fact.
    // Disabled deadline is honestly expressed as waitTimeoutMs: null.
    await this.transcript.append("run.wait_policy", {
      waitTimeoutMs: waitTimeout,
      source: waitTimeoutSource,
    });

    // M10-pre3: only create the total-duration timer when deadline is enabled.
    // When disabled, the run has no time-based kill — workers run until they
    // complete, fail, are externally aborted, or hit token/resource budget.
    const controller = new AbortController();
    let waitTimerExpired = false;
    let timer = null;
    if (deadlineEnabled) {
      timer = setTimeout(() => {
        waitTimerExpired = true;
        controller.abort();
      }, waitTimeout);
    }
    // M10-pre3C: track an EXTERNAL abort separately from the deadline timer.
    // Both abort the same controller (to unblock the events stream), but only
    // the deadline timer may produce timed_out. An external signal (Run.abort,
    // daemon IPC stop, daemon shutdown, caller-supplied AbortSignal) is abort
    // semantics and must terminal as aborted — never timed_out. Previously the
    // external signal also set controller.signal.aborted, and the downstream
    // `(doneReason === null && controller.signal.aborted)` test conflated the
    // two, so a daemon stop could race into a false timed_out.
    let externalAborted = false;
    if (options.signal) {
      if (options.signal.aborted) {
        externalAborted = true;
        controller.abort();
      } else {
        options.signal.addEventListener("abort", () => {
          externalAborted = true;
          controller.abort();
        }, { once: true });
      }
    }

    const messages = [];
    const evidence = [];
    let doneReason = null;
    let doneError = null;
    // M12-21B gap #1: the closed-set completion marker ProcessBackend stamps on
    // a no-effect completion (only "completed_empty" today). Captured from the
    // accepted done event and persisted on run.completed so diagnoseFailure can
    // consume the durable truth even without a transport-activity event. Only a
    // DONE_MARKERS member is ever captured — raw/unknown values are dropped.
    let doneMarker = null;
    let timedOut = false;
    let metrics = null;
    let budgetExceeded = false;
    let budgetUsed = 0;
    let isolationViolationKind = null;
    let isolationViolationReason = null;
    const pendingDeliveryWriteToolCallIds = new Set();
    // M12-14: classify WHY a reported write fails the delivery containment
    // gate. Returns a closed-set ISOLATION_VIOLATION_REASONS member, or null
    // when the event is not a violating write. Non-delivery runs are never
    // gated (unchanged). Correlation failures are checked BEFORE the path
    // checks, mirroring the prior boolean short-circuit exactly — the gate
    // itself (what fails closed) is unchanged; only the truthful reason is new.
    const classifyDeliveryWriteViolation = (rawEvent) => {
      if (!this.deliveryContext) return null;
      if (rawEvent?.kind === "write_intent") {
        if (rawEvent.correlationStatus !== WRITE_INTENT_CORRELATION_STATUS.TRACKED) {
          switch (rawEvent.correlationStatus) {
            case WRITE_INTENT_CORRELATION_STATUS.MISSING_TOOL_CALL_ID:
              return "write_intent_missing_tool_call_id";
            case WRITE_INTENT_CORRELATION_STATUS.DUPLICATE_TOOL_CALL_ID:
              return "write_intent_duplicate_tool_call_id";
            case WRITE_INTENT_CORRELATION_STATUS.PENDING_LIMIT:
              return "write_intent_pending_limit";
            default:
              return "write_intent_correlation_unconfirmed";
          }
        }
        if (!isConfirmableToolCallId(rawEvent.toolCallId)) {
          return "write_intent_missing_tool_call_id";
        }
        if (pendingDeliveryWriteToolCallIds.has(rawEvent.toolCallId)) {
          return "write_intent_duplicate_tool_call_id";
        }
        if (pendingDeliveryWriteToolCallIds.size >= MAX_PENDING_DELIVERY_WRITE_INTENTS) {
          return "write_intent_pending_limit";
        }
        const verdict = classifyReportedWriteIntentContainment(rawEvent.path, this.effectiveCwd);
        return verdict === "inside" ? null : `write_intent_${verdict}`;
      }
      if (rawEvent?.kind === "file_written") {
        const verdict = classifyReportedWriteContainment(rawEvent.path, this.effectiveCwd);
        return verdict === "inside" ? null : `file_written_${verdict}`;
      }
      return null;
    };
    const markRunningOnce = async (reason) => {
      if (this.state !== "running" && !TERMINAL_STATES.includes(this.state)) {
        await this._transition(this.state, "running", reason);
      }
    };

    try {
      for await (const rawEvent of this.handle.events(controller.signal, {
        pollInterval,
        silentTimeout,
        // M12-16: for a correctable run, drain the transcript-backed correction
        // queue on each wake of THIS control loop (the same loop that consumes
        // backend events — no second semantic owner). The bounded pollInterval
        // wait in _streamEvents guarantees the tick fires periodically even while
        // the provider is silent. Absent for non-correctable runs (byte-compatible).
        ...(this.correctable ? { onPollTick: () => this._pollCorrections() } : {}),
      })) {
        const ev = this._redact(rawEvent);
        // 若已被 abort，停止处理后续事件（避免覆盖 aborted 状态）
        if (this._aborted) break;
        // TD-99：若 _transition 把内存 state 同步为终态（外部写了终态，仲裁 rejected），
        // 不再消费后续 backend events。
        if (TERMINAL_STATES.includes(this.state)) {
          doneReason = null;
          break;
        }
        if (ev.kind === "message") {
          // 首个 message → 转 running
          await markRunningOnce(STATE_CHANGE_REASON.first_message);
          messages.push({ info: { role: ev.role }, parts: ev.parts });
          // N4 修复：message 事件落 transcript（run.event, kind=message）。
          // 原 bug：只 push 内存数组不落盘 → transcript（source of truth）重建不出
          // worker 文字产出（collect/事后审计拿不到 assistant text）。tool 证据早就在落，
          // 这里补齐文字产出，使 transcript 完整可重建。影响所有 backend。
          const { kind, ...msgRest } = ev;
          await this.transcript.append("run.event", { kind, ...msgRest });
        } else if (ev.kind === "metrics") {
          await markRunningOnce(STATE_CHANGE_REASON.first_event);
          metrics = ev;
          await this.transcript.append("run.metrics", { tokens: ev.tokens, ...(ev.costUsd !== undefined ? { costUsd: ev.costUsd } : {}) });
          // 预算闸门检查：累计 effective tokens，超限即标记并打断循环。
          // tokens 是 session 级累计值（非增量），直接比对即可。
          if (typeof tokenBudget === "number" && ev.tokens) {
            const t = ev.tokens;
            budgetUsed = (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0);
            const effective = budgetUsed * tokenBudgetMultiplier;
            if (effective > tokenBudget) {
              budgetExceeded = true;
              break;
            }
          }
        } else if (ev.kind === "done") {
          if (
            this.deliveryContext
            && ev.reason === "completed"
            && pendingDeliveryWriteToolCallIds.size > 0
          ) {
            isolationViolationKind = "write_intent";
            isolationViolationReason = "write_intent_pending_at_completion";
            break;
          }
          doneReason = ev.reason;
          doneError = ev.error;
          // M12-21B gap #1: capture only the closed-set valid marker. The
          // DONE_MARKERS membership check is the gate that guarantees we never
          // persist an unknown/raw value onto the run.completed fact.
          if (ev.reason === "completed"
            && typeof ev.marker === "string"
            && DONE_MARKERS.includes(ev.marker)) {
            doneMarker = ev.marker;
          }
          break;
        } else if (ev.kind === "thinking" || ev.kind === "runtime_activity") {
          await markRunningOnce(STATE_CHANGE_REASON.first_event);
          // Provider activity is a payload-free supervision fact. Persist it
          // for run_wait/run_activity/dashboard visibility, but do not count it
          // as delivery evidence or expose the provider's raw stream payload.
          const { kind, ...rest } = ev;
          await this.transcript.append("run.event", { kind, ...rest });
        } else if (
          ev.kind === "command" ||
          ev.kind === "file_written" ||
          ev.kind === "write_intent" ||
          ev.kind === "tool_use" ||
          ev.kind === "tool_result"
        ) {
          const writeViolationReason = classifyDeliveryWriteViolation(rawEvent);
          if (writeViolationReason) {
            isolationViolationKind = rawEvent.kind;
            isolationViolationReason = writeViolationReason;
            break;
          }
          await markRunningOnce(STATE_CHANGE_REASON.first_event);
          // 证据链事件（M6-2）：落盘到 transcript run.event，收集供 scorecard 核验。
          // 不触发状态转移（和 metrics 一样是旁路信息）。
          const { kind, ...rest } = ev;
          await this.transcript.append("run.event", { kind, ...rest });
          if (this.deliveryContext) {
            if (rawEvent.kind === "write_intent") {
              pendingDeliveryWriteToolCallIds.add(rawEvent.toolCallId);
            } else if (rawEvent.kind === "tool_result" && rawEvent.isError === true) {
              pendingDeliveryWriteToolCallIds.delete(rawEvent.tool);
            } else if (rawEvent.kind === "file_written") {
              pendingDeliveryWriteToolCallIds.delete(rawEvent.toolCallId);
            }
          }
          if (ev.kind !== "write_intent") evidence.push(ev);
        }
      }
      // M10-pre3C: only the deadline timer may set timedOut. An external
      // AbortSignal (Run.abort, daemon IPC stop, daemon shutdown, caller signal)
      // is abort semantics and must NOT become timed_out. The externalAborted
      // flag is routed to _abortInternal below so the run terminals honestly as
      // aborted via the existing atomic terminal arbitration.
      if (waitTimerExpired) {
        timedOut = true;
      }
    } finally {
      clearTimeout(timer);
    }

    this._removeFromManager();

    // M10-pre3C: if an external signal aborted the wait (and no other path has
    // already terminalized this run), route it through _abortInternal so the
    // terminal fact is exactly one aborted — not timed_out, not fabricated.
    // This wins over the stream-ended and timed_out branches below.
    if (externalAborted && !TERMINAL_STATES.includes(this.state) && !this._aborted) {
      await this._abortInternal(STATE_CHANGE_REASON.external_signal);
    }

    if (this._aborted) {
      await this._runCleanup();
      return _loserResult("aborted", { messages, evidence, metrics });
    }

    const externalTerminalState = await this._externalTerminalState();
    if (externalTerminalState) {
      this.state = externalTerminalState;
      await this._runCleanup();
      return _loserResult(externalTerminalState, { messages, evidence, metrics });
    }

    if (isolationViolationKind) {
      // M12-14: persist ONLY the closed-set code/eventKind/reason — never the
      // rejected raw path. The additive reason is persisted only when it is an
      // exact closed-set member; readers treat an absent reason as unknown.
      const isolationReasonPayload = ISOLATION_VIOLATION_REASONS.includes(isolationViolationReason)
        ? { reason: isolationViolationReason }
        : {};
      const tResult = await this._transition(this.state, "failed", STATE_CHANGE_REASON.workdir_escape, {
        factEvents: [
          {
            type: "run.isolation_violation",
            payload: { code: "workdir_escape", eventKind: isolationViolationKind, ...isolationReasonPayload },
          },
          {
            type: "run.error",
            payload: { phase: "isolation", code: "workdir_escape" },
          },
        ],
      });
      await this._runCleanup();
      return _loserResult(tResult.state, {
        messages,
        evidence,
        metrics,
        isolationViolation: true,
      });
    }

    // 预算硬闸门（S1-1）：超限即转 failed + 兜底 abort。独立于 done/timeout，
    // 优先级最高——即使 backend 想报 completed，超预算就是超预算。
    if (budgetExceeded) {
      await this.transcript.append("run.budget_exceeded", {
        budget: tokenBudget,
        used: budgetUsed,
        multiplier: tokenBudgetMultiplier,
        backendSessionId: this.result.backendSessionId,
      });
      // S1-3 告警：超预算是重大事件，立即弹窗 + 写 ALERTS.log（告警失败不阻塞终态）
      raiseAlert("budget",
        `token budget exceeded: used ${budgetUsed}×${tokenBudgetMultiplier} > ${tokenBudget}`,
        { runId: this.runId, logPath: join(this.config.runDir, "ALERTS.log") },
      ).catch(() => { /* 告警失败不影响终态 */ });
      const tResult = await this._transition(this.state, "failed", STATE_CHANGE_REASON.budget_exceeded);
      await this._runCleanup();
      // TD-99：若输给先到的终态（如外部 abort），返回与现有终态一致的结果。
      if (!tResult.accepted) return _loserResult(tResult.state, { messages, evidence, metrics, budgetExceeded: true });
      return _loserResult("failed", { messages, evidence, metrics, budgetExceeded: true });
    }

    if (timedOut) {
      const tResult = await this._transition(this.state, "timed_out", STATE_CHANGE_REASON.timeout, {
        factEvents: [{
          type: "run.timed_out",
          payload: { backendSessionId: this.result.backendSessionId },
        }],
      });
      await this._runCleanup();
      return _loserResult(tResult.state, { messages, evidence, metrics });
    }

    if (doneReason === "completed") {
      // scorecard 门控（M6-6，opt-in）：有 rules 才检查。
      // agent 自报完成只是必要条件，scorecard 验过证据才是充分条件。
      // 不通过 → 转 failed（gate 默认）；P4 决策C：rules.mode==="warn" 时仅记 scorecard.warn
      // 不阻断，run 仍 completed（渐进引导而非硬拦；防伪完成的 requireEvidence 默认可走 warn）。
      if (this.scorecardRules) {
        // 证据事件转成 scorecard 需要的 transcript 事件格式
        const scorecardEvents = [
          ...evidence.map((e) => ({ type: "run.event", ...e })),
          // 附带 messages 供 requireAssistantText 检查（纵深防御：防 completed 但无 text 答案）
          ...messages.map((m) => ({ type: "run.message", role: m.info?.role, parts: m.parts })),
          { type: "run.completed" },
        ];
        const scResult = await checkScorecard({
          events: scorecardEvents,
          cwd: this.effectiveCwd,
          rules: this.scorecardRules,
        });
        await this.transcript.append("scorecard.checked", {
          passed: scResult.passed,
          checks: scResult.checks,
        });
        if (!scResult.passed) {
          const detail = scResult.checks
            .filter((c) => !c.passed)
            .map((c) => `${c.name}: ${c.detail ?? "failed"}`)
            .join("; ");
          // P4 决策C：warn-only。记 warn 事件但不转 failed，继续走 completed。
          if (this.scorecardRules.mode === "warn") {
            await this.transcript.append("scorecard.warn", { detail, checks: scResult.checks });
          } else {
            await this.transcript.append("run.error", { phase: "scorecard", detail });
            const tResult = await this._transition(this.state, "failed", STATE_CHANGE_REASON.scorecard_failed);
            await this._runCleanup();
            if (!tResult.accepted) return _loserResult(tResult.state, { messages, evidence, metrics, scorecard: scResult });
            return _loserResult("failed", { messages, evidence, metrics, scorecard: scResult });
          }
        }
      }
      // TD-99：run.completed 与 completed state_change 同批原子提交（factEvents）。
      // rejected 时不留 run.completed fact。
      // TD-103 Phase 3A: delivery packaging before terminal completion.
      if (this.deliveryContext && !this._deliveryPackaged) {
        this._deliveryPackaged = true;
        // Re-check external terminal before packaging
        const preTerminal = await this._externalTerminalState();
        if (preTerminal) {
          this.state = preTerminal;
          await this._runCleanup();
          return _loserResult(preTerminal, { messages, evidence, metrics });
        }

        const deliveryResult = await this._finalizeDelivery();
        if (deliveryResult.success) {
          // Packaging succeeded — delivery_created as attemptEvent (always written, even if
          // transition rejected), run.completed as factEvent (only on accepted).
          // This eliminates the orphan-delivery-commit window: no matter what happens to
          // the transition, the delivery fact is in the same atomic batch.
          const tResult = await this._transition(this.state, "completed", STATE_CHANGE_REASON.done, {
            attemptEvents: [
              { type: "run.delivery_created", payload: { delivery: deliveryResult.ref } },
            ],
            factEvents: [{
              type: "run.completed",
              payload: {
                backendSessionId: this.result.backendSessionId,
                messageCount: messages.length,
                ...(doneMarker ? { completionMarker: doneMarker } : {}),
              },
            }],
          });
          await this._runCleanup();
          if (!tResult.accepted) {
            // Race lost — delivery_created was written as attemptEvent (atomic with rejection).
            return _loserResult(tResult.state, { messages, evidence, metrics, delivery: deliveryResult.ref });
          }
          // TD-103 Phase 3B: verify the delivery AFTER completion + cleanup.
          // Run terminal stays completed regardless of verification outcome.
          const verifiedRef = await this._verifyDeliveryResult(deliveryResult.ref);
          const baseResult = _loserResult("completed", { messages, evidence, metrics, delivery: verifiedRef.delivery });
          if (verifiedRef.outcome === "failed") {
            return { ...baseResult, verificationFailed: true };
          }
          if (verifiedRef.outcome === "unavailable") {
            return { ...baseResult, verificationUnavailable: true };
          }
          return { ...baseResult, verificationFailed: false };
        } else {
          // Packaging failed — delivery_failed as attemptEvent (always written),
          // run.error as factEvent (only on accepted).
          const errCode = deliveryResult.error.code;
          const errMsg = deliveryResult.error.message;
          const tResult = await this._transition(this.state, "failed", STATE_CHANGE_REASON.delivery_failed, {
            attemptEvents: [
              { type: "run.delivery_failed", payload: { deliveryCode: errCode, message: errMsg } },
            ],
            factEvents: [{
              type: "run.error",
              payload: { phase: "delivery", deliveryCode: errCode },
            }],
          });
          await this._runCleanup();
          if (!tResult.accepted) {
            // Race lost — delivery_failed was written as attemptEvent (atomic with rejection).
            return _loserResult(tResult.state, {
              messages, evidence, metrics,
              deliveryError: { code: errCode, message: errMsg },
            });
          }
          return _loserResult("failed", {
            messages, evidence, metrics,
            deliveryError: { code: errCode, message: errMsg },
          });
        }
      }

      // Non-delivery completed path (existing behavior, unchanged)
      const tResult = await this._transition(this.state, "completed", STATE_CHANGE_REASON.done, {
        factEvents: [{
          type: "run.completed",
          payload: {
            backendSessionId: this.result.backendSessionId,
            messageCount: messages.length,
            ...(doneMarker ? { completionMarker: doneMarker } : {}),
          },
        }],
      });
      await this._runCleanup();
      // TD-99：若输给先到的终态，返回与现有终态一致的结果。
      if (!tResult.accepted) return _loserResult(tResult.state, { messages, evidence, metrics });
      return _loserResult("completed", { messages, evidence, metrics });
    }
    if (doneReason === "failed") {
      // TD-95 #5 复盘：backend 崩了但证据可能已齐（worker 写了文件 + 跑了测试 exit0）。
      // 终态仍 failed（不撒谎——backend 确实崩了），但写 run.evidence_audit 让 Lead 知道
      // "证据其实通过了，任务可能做对了，需人工确认"。诊断靠 Lead，不自动改终态。
      const auditResult = _auditEvidenceOnFailure(evidence, messages);
      if (auditResult.passed) {
        await this.transcript.append("run.evidence_audit", {
          passed: true,
          note: "backend failed but evidence passed (file_written/command exit0 present) — task may be correct, verify manually",
          checks: auditResult.checks,
        });
      }
      await this.transcript.append("run.error", { phase: "wait", error: doneError ?? "unknown" });
      const tResult = await this._transition(this.state, "failed", STATE_CHANGE_REASON.backend_error);
      await this._runCleanup();
      // TD-99：failed claim 若输给先到的 aborted/completed/timed_out，不再 throw failed；
      // 返回与现有终态一致的结构化结果（loser 不改终态）。
      if (!tResult.accepted) return _loserResult(tResult.state, { messages, evidence, metrics });
      throw new Error(doneError ?? "backend reported failure");
    }
    // M10-pre3 closeout (P1-D / honesty discipline): the fallthrough below
    // previously ALWAYS wrote run.timed_out whenever doneReason was neither
    // "completed" nor "failed". That fabricated a timeout even when no deadline
    // timer existed and no abort happened — e.g. a backend whose event stream
    // simply ended without emitting a done event. That is dishonest: timed_out
    // must mean a wall-clock deadline fired.
    //
    // Now we distinguish:
    //   - timedOut === true (waitTimerExpired, or stream ended because the
    //     controller signal was aborted by a real deadline timer) → timed_out.
    //   - timedOut === false AND doneReason === null (stream ended with no done,
    //     no timer, no abort) → honest failed with reason "backend_stream_ended".
    //     Reuses the existing failed terminal arbitration (no second terminal).
    if (!timedOut && doneReason === null) {
      await this.transcript.append("run.error", { phase: "wait", error: "backend stream ended without done" });
      const endedResult = await this._transition(this.state, "failed", STATE_CHANGE_REASON.backend_stream_ended);
      await this._runCleanup();
      if (!endedResult.accepted) return _loserResult(endedResult.state, { messages, evidence, metrics });
      throw new Error("backend stream ended without done");
    }
    // M12-11 RED FLAG B: an unknown non-null done reason is a backend failure,
    // NOT a timeout. Only waitTimerExpired may create run.timed_out (see the
    // `if (timedOut)` branch above). The fallthrough previously ALWAYS wrote
    // run.timed_out for any truthy doneReason that was neither "completed" nor
    // "failed" — so a backend that emitted done("cancelled"/"stream_error"/…)
    // with NO deadline timer was mislabeled as a WAO execution deadline, and a
    // Lead could infer WAO stopped the worker when it did not.
    //
    // It now fails closed: transition to failed with a safe closed-set reason
    // (backend_unknown_reason), record a safe run.error, and throw — exactly
    // like the done(failed) / backend_stream_ended paths. The raw backend
    // reason (doneReason) is NEVER echoed on the wire or in the transition
    // reason; only the safe closed-set label is recorded. This is the ONLY way
    // an unknown terminal reaches failed without a deadline, and it can never
    // produce run.timed_out.
    await this.transcript.append("run.error", {
      phase: "wait",
      error: "backend stream ended with unknown done reason",
    });
    const unknownResult = await this._transition(this.state, "failed", STATE_CHANGE_REASON.backend_unknown_reason);
    await this._runCleanup();
    if (!unknownResult.accepted) {
      return _loserResult(unknownResult.state, { messages, evidence, metrics });
    }
    throw new Error("backend stream ended with unknown done reason");
  }

  async abort(reason = STATE_CHANGE_REASON.user) {
    this._removeFromManager();
    await this._abortInternal(reason);
  }

  /**
   * 从 RunManager 的 activeRuns 移除自己。幂等：只执行一次。
   * 防止 waitForCompletion 错误路径与 abort 路径同时触发导致 onRemove 被调两次。
   */
  _removeFromManager() {
    if (this._removed) return;
    this._removed = true;
    if (this.onRemove) this.onRemove();
  }

  async _externalTerminalState() {
    try {
      const events = await readTranscript(this.transcript.filePath);
      // R20 (TD-128 M6，交付丢失向量)：外部终态采纳绑定到本 run runId
      // （this.transcript.context.runId——合法写入车道 stop/abort/backgroundRunner
      // 均经 JsonlTranscript 落盘、每行带 runId 信封，绑定对合法写入透明）。
      // 语义 = 不可归属（外 run 信封 / 无信封裸行 / 零绑定事件）→ 不采纳
      // （null），落回本 run 自身的终态化路径（done(failed)→failed、
      // done(completed)→交付打包等），fail-closed 方向（R18 W3 resume 终态门
      // 注释先例）。修复前 :2192 的无绑定采纳是交付丢失向量：append-only 尾部
      // 的外 run 伪终态行曾使 preTerminal 采纳 → 跳过 _finalizeDelivery → run
      // 以 completed-ish 收场而交付物从未打包；:2080 的流后采纳同受绑定保护
      // （外 run 伪 aborted 不再被采纳为外部终态）。
      const state = findState(events.filter((e) => e && e.runId === this.transcript.context.runId));
      return TERMINAL_STATES.includes(state) ? state : null;
    } catch {
      return null;
    }
  }

  /**
   * TD-103 Phase 3A: finalize delivery by calling the packager.
   * Returns {success:true, ref} or {success:false, error:{code, message}}.
   * Never throws — packaging failures are structured results.
   * @returns {Promise<{success:true, ref:object}|{success:false, error:{code, message}}>}
   */
  async _finalizeDelivery() {
    try {
      const ref = await this._packageDeliveryFn(this.deliveryContext);
      return { success: true, ref };
    } catch (err) {
      // Preserve DeliveryError.deliveryCode when present; map unknown to delivery_error.
      const code = err?.deliveryCode ?? "delivery_error";
      // Sanitize message — no stack traces or stderr leakage
      const message = _sanitizeDeliveryMessage(err?.message ?? "unknown delivery error");
      return { success: false, error: { code, message } };
    }
  }

  /**
   * TD-103 Phase 3B: verify a delivered DeliveryRef.
   * Runs after terminal completed + cleanup. Appends verification event to transcript.
   * Never changes run terminal state.
   * @param {object} deliveryRef — the committed DeliveryRef from packaging
   * @returns {Promise<{delivery: object, outcome: string}>}
   */
  async _verifyDeliveryResult(deliveryRef) {
    // TD-103 Phase 3B concurrency final closeout.
    //
    // Concurrency invariants (verified by RED→GREEN with real concurrent calls):
    //   1. The verifier computation runs exactly once regardless of caller
    //      count. All concurrent callers share _verificationComputePromise.
    //   2. The outcome append runs at most once successfully. Concurrent
    //      callers share _verificationAppendPromise. On failure, all waiters
    //      receive the same error; the promise is cleared so an explicit
    //      retry can re-attempt the append without re-running the verifier.
    //   3. The outcome event must be on disk before we report success.
    //   4. No "unrecorded pass" fallback — ever.
    //   5. DeliveryError(artifact_mismatch) from the verifier propagates as-is
    //      (it is a known proof failure, not an internal crash). Only truly
    //      unknown verifier exceptions map to execution_error.

    // Fast path: already recorded on disk.
    if (this._verificationRecorded) {
      return this._recordedVerificationResult;
    }

    // Phase 1: compute the verifier result exactly once across all callers.
    if (!this._verificationComputePromise) {
      this._verificationComputePromise = this._computeVerification(deliveryRef);
    }
    // _computeVerification always resolves to a result object:
    //   - normal result from verifyDeliveryFn
    //   - DeliveryError → failed result preserving failureCode (not re-thrown)
    //   - unknown error → execution_error result (not re-thrown)
    // Only transcript append failures (Phase 2) propagate to callers.
    const result = await this._verificationComputePromise;

    // Phase 2: append the outcome event — coalesce concurrent appends.
    if (!this._verificationAppendPromise) {
      this._verificationAppendPromise = this._appendVerificationOutcome(result);
    }
    try {
      await this._verificationAppendPromise;
    } catch (err) {
      // Append failed — clear the promise so an explicit retry can re-attempt.
      // All concurrent waiters received the same error via the shared promise.
      this._verificationAppendPromise = null;
      throw err;
    }

    // Phase 3: append succeeded — mark as recorded and return.
    // _verificationRecorded was set inside _appendVerificationOutcome before
    // the promise resolved, so this is a belt-and-suspenders check.
    if (this._verificationRecorded) {
      return this._recordedVerificationResult;
    }
    // Should not reach here — _appendVerificationOutcome sets _verificationRecorded.
    return result;
  }

  /**
   * Run the verifier exactly once. Always resolves to a result object:
   *   - normal result from verifyDeliveryFn
   *   - DeliveryError → failed result preserving the original failureCode
   *     (e.g. artifact_mismatch). Not re-thrown, not downgraded to execution_error.
   *   - unknown error → execution_error result (not re-thrown).
   *
   * Strict DeliveryError identification via instanceof — does not accept
   * forged objects with name/code fields.
   *
   * @param {object} deliveryRef
   * @returns {Promise<object>} resolved result object (never throws)
   */
  async _computeVerification(deliveryRef) {
    try {
      // M12-13: forward the persisted per-command execution budget to the
      // verifier. Absent → empty opts (the verifier's default applies); the
      // persisted value is authoritative — never widened, never retried.
      const verifyOpts = this.deliveryContext
        && Object.prototype.hasOwnProperty.call(this.deliveryContext, "verificationTimeoutMs")
        ? { timeoutMs: this.deliveryContext.verificationTimeoutMs }
        : {};
      // R23-F/B Round B (TD-130): production verification enters the machine
      // serialization gate — but ONLY when this manager relies on the DEFAULT
      // verifier. Injected verifyDeliveryFn (every existing test, internal
      // reuse) must never contend for the real machine lease during npm test.
      // createCallerGate also folds in the kill switch + anti-self-lock HELD
      // guard; null ⇒ byte-identical opts shape as before (zero drift).
      const gate = createCallerGate({
        usesDefaultVerifier: this._verifyDeliveryFn === defaultVerifyDelivery,
        identity: { owner: "RunManager._verifyDeliveryResult", runId: this.runId, agentId: this.agentId },
      });
      const result = await this._verifyDeliveryFn(deliveryRef, {
        ...verifyOpts,
        ...(gate ? { gate } : {}),
      });
      this._pendingVerificationResult = result;
      return result;
    } catch (err) {
      // Known DeliveryError proof failure (artifact_mismatch, etc.) —
      // preserve the failureCode in a structured failed result.
      // Do NOT downgrade to execution_error, do NOT re-throw.
      if (err instanceof DeliveryError) {
        const failureCode = err.deliveryCode;
        const safeRef = {
          ...deliveryRef,
          verification: {
            ...deliveryRef.verification,
            status: "failed",
            failureCode,
            verifiedCommit: deliveryRef.deliveryCommit,
            results: [],
          },
        };
        const mapped = { delivery: safeRef, outcome: "failed", failureCode };
        this._pendingVerificationResult = mapped;
        return mapped;
      }
      // Unknown internal exception → map to safe execution_error result.
      // No stack/message/stderr leakage.
      const safeRef = {
        ...deliveryRef,
        verification: {
          ...deliveryRef.verification,
          status: "failed",
          failureCode: "execution_error",
          verifiedCommit: deliveryRef.deliveryCommit,
          results: [],
        },
      };
      const mapped = { delivery: safeRef, outcome: "failed", failureCode: "execution_error" };
      this._pendingVerificationResult = mapped;
      return mapped;
    }
  }

  /**
   * Append the verification outcome event to the transcript.
   * Sets _verificationRecorded + _recordedVerificationResult on success.
   * Throws on append failure (callers clear _verificationAppendPromise to
   * allow retry).
   * @param {object} result — the computed verifier result
   */
  async _appendVerificationOutcome(result) {
    const eventType = result.outcome === "passed"
      ? "run.delivery_verification_passed"
      : result.outcome === "failed"
        ? "run.delivery_verification_failed"
        : "run.delivery_verification_unavailable";

    await this.transcript.append(eventType, { delivery: result.delivery });

    // Successfully on disk — safe to mark as final.
    this._verificationRecorded = true;
    this._recordedVerificationResult = result;
  }

  /** 终态时清理 worktree（ephemeral 策略）。幂等，失败不阻塞。 */
  async _runCleanup() {
    // M12-16: a correctable run must leave NO correction request stranded. On
    // every terminal branch, atomically reject every still-outstanding
    // (pending/claimed) correction as terminal_race (the provider finished
    // before the queued turn could be delivered). This runs BEFORE the session
    // abort so the rejection is durable regardless of abort outcome. Best-effort
    // (never blocks terminal) and runs at most once.
    if (this.correctable && !this._correctionsClosed) {
      this._correctionsClosed = true;
      try {
        await this.transcript.rejectOutstandingCorrections({ reason: "terminal_race" });
      } catch { /* best-effort: never block terminal */ }
    }
    // 会话兜底 abort（事故修复 2026-06-17）：无论哪条终态路径（completed/failed/
    // timed_out/user-abort），清理时都必须向 serve 端 session 发送 abort。
    // HTTP 类 backend（opencode-serve）的 session 不一定随 run 结束自行死——
    // 对无限多轮模型（DeepSeek-v4-flash）会持续烧 token 直到 quota 耗尽。
    // handle.abort 幂等：user-abort 路径已调过则 _sessionKilled 挡住重复调用；
    // 进程式 backend abort 是 no-op（进程已死），不报错。
    if (!this._sessionKilled) {
      this._sessionKilled = true;
      try {
        await this.handle?.abort?.();
      } catch {
        // 兜底 abort 失败不影响已定的终态（和 _abortInternal 一致：状态机以意图为准）
      }
      // C6（TD-38，审计 P0 收口）：opencode 类 backend 的 abort 可能虚假成功（06-18 事故根因）。
      // _runCleanup 是 waitForCompletion 终态后的兜底路径（TD-35 修），此处的 abort 同样要验证。
      // 复用 verifyStopQuiet：abort 后轮询 session/message，未停则标记 + 告警（不阻断终态）。
      // 只对有 session/messages 方法的 backend（opencode 类）验证；进程式（claude-code/kimi/codex）
      // abort 是 no-op 且进程已死，跳过验证。
      await this._verifyStopQuietIfCapable().catch(() => { /* 验证失败不影响终态 */ });
    }
    if (this._cleaned || !this._cleanup) return;
    this._cleaned = true;
    try {
      await this._cleanup();
      await this.transcript.append("run.cleanup_done", {});
    } catch (error) {
      await this.transcript.append("run.cleanup_error", { error: error.message });
    }
  }

  /**
   * M12-16: drain the transcript-backed correction queue. Invoked as the
   * onPollTick of the waitForCompletion event loop (the single control loop that
   * also consumes backend events — no second semantic owner). For each
   * OUTSTANDING correction (requested, never claimed), atomically claim it IN
   * LOCK, deliver it to the live provider stdin via handle.sendCorrection, then
   * record delivered / delivery_failed. A claimed-but-undelivered correction
   * (crash window) is never re-claimed — no double turn; it is rejected at the
   * terminal cleanup. "delivered" proves byte delivery, NOT model execution.
   *
   * Never changes run state, never stops/retries/re-scopes the run (purely
   * additive transport). Best-effort: any error is swallowed so it can never
   * kill the event stream.
   */
  async _pollCorrections() {
    if (!this.correctable || this._correctionsClosed) return;
    let events;
    try {
      events = await readTranscript(this.transcript.filePath);
    } catch {
      return;
    }
    const proj = projectCorrections(events, this.runId);
    for (const [correctionId, info] of proj) {
      if (info.status !== "pending") continue; // only claim un-claimed requests
      let claim;
      try {
        claim = await this.transcript.tryClaimCorrection({ correctionId });
      } catch {
        continue;
      }
      if (!claim.claimed) continue; // already handled or terminal race
      const handle = this.handle;
      if (!handle || typeof handle.sendCorrection !== "function") {
        try {
          await this.transcript.appendCorrectionDeliveryFailed({ correctionId, reason: "send_failed" });
        } catch { /* best-effort */ }
        continue;
      }
      let res;
      try {
        res = await handle.sendCorrection(info.prompt ?? claim.prompt ?? "");
      } catch {
        res = { ok: false, reason: "send_failed" };
      }
      try {
        if (res && res.ok) {
          await this.transcript.appendCorrectionDelivered({ correctionId });
        } else {
          const reason = res && (res.reason === "stdin_closed" || res.reason === "send_failed")
            ? res.reason : "send_failed";
          await this.transcript.appendCorrectionDeliveryFailed({ correctionId, reason });
        }
      } catch { /* best-effort: the claim is durable, cleanup will reject if needed */ }
    }
  }

  /**
   * C6（TD-38）：_runCleanup 的 abort 后静默验证（仅 opencode 类 backend）。
   * 判断 handle 是否有 session/messages 方法（opencode 有，进程式无）。
   * 有则复用 verifyStopQuiet 验证后台是否真停；未停写 run.stop_unverified + 告警。
   * 失败/无能力 → 降级，不阻断终态。
   */
  async _verifyStopQuietIfCapable() {
    const h = this.handle;
    if (!h) return;

    // M10-pre Batch B: process-backed workers — verify process actually died.
    // M10-pre closeout-2: the try/catch ONLY wraps the probe (verifyProcessExit).
    // The transcript append is OUTSIDE the probe catch so a write failure is never
    // misclassified as a probe_error.
    if (typeof h.isAlive === "function") {
      let probeResult;
      let probeThrew = false;
      try {
        const { verifyProcessExit } = await import("./application/processStopVerify.js");
        probeResult = await verifyProcessExit({
          isAlive: () => h.isAlive(),
          rounds: 3,
          intervalMs: 1000,
        });
      } catch {
        // Probe threw — we do NOT know if the process died. Fail-closed.
        // Never record exception message/PID/command/path/stderr.
        probeThrew = true;
      }

      if (probeThrew) {
        // Probe error path: write stop_unverified with fixed safe outcome.
        // Transcript append failure triggers an evidence-write alert — it is NOT
        // reclassified as probe_error (the probe already succeeded or failed above).
        try {
          await this.transcript.append("run.stop_unverified", {
            backend: this.result?.backend ?? "process",
            path: "_runCleanup",
            outcome: "probe_error",
          });
        } catch {
          // Transcript write itself failed — cannot record the probe_error fact.
          // Do NOT silently swallow: fire a safe evidence-write alert.
          raiseAlert("stop_unverified",
            `_runCleanup evidence write failed (run ${this.runId}): probe error unrecordable`,
            { runId: this.runId, logPath: join(this.config.runDir, "ALERTS.log") },
          ).catch(() => {});
        }
        raiseAlert("stop_unverified",
          `_runCleanup process stop unverified (run ${this.runId}): probe error`,
          { runId: this.runId, logPath: join(this.config.runDir, "ALERTS.log") },
        ).catch(() => {});
      } else if (probeResult.quiet) {
        // Probe succeeded: process is quiet. Write stop_verified.
        // Write failure here is an evidence-write failure, NOT a probe error —
        // do not fall through to the probe_error branch.
        try {
          await this.transcript.append("run.stop_verified", {
            backend: this.result?.backend ?? "process",
            path: "_runCleanup",
            roundsUsed: probeResult.roundsUsed,
          });
        } catch {
          raiseAlert("stop_unverified",
            `_runCleanup evidence write failed (run ${this.runId}): stop_verified unrecordable`,
            { runId: this.runId, logPath: join(this.config.runDir, "ALERTS.log") },
          ).catch(() => {});
        }
      } else {
        // Probe succeeded: process still alive. Write stop_unverified (alive).
        try {
          await this.transcript.append("run.stop_unverified", {
            backend: this.result?.backend ?? "process",
            path: "_runCleanup",
            roundsUsed: probeResult.roundsUsed,
          });
        } catch {
          raiseAlert("stop_unverified",
            `_runCleanup evidence write failed (run ${this.runId}): stop_unverified unrecordable`,
            { runId: this.runId, logPath: join(this.config.runDir, "ALERTS.log") },
          ).catch(() => {});
        }
        raiseAlert("stop_unverified",
          `_runCleanup process stop not verified (run ${this.runId}): process may still be running`,
          { runId: this.runId, logPath: join(this.config.runDir, "ALERTS.log") },
        ).catch(() => {});
      }
      return;
    }

    // opencode 类 backend：取 serveUrl + sessionId 用于验证
    if (typeof h.session !== "function" || typeof h.messages !== "function") {
      return;
    }
    // opencode 类：取 serveUrl + sessionId 用于验证
    const serveUrl = this.result?.serveUrl;
    const sessionId = this.result?.backendSessionId;
    if (!serveUrl || !sessionId) return;
    const { verifyStopQuiet } = await import("./backends/opencodeStopVerify.js");
    const result = await verifyStopQuiet(h, serveUrl, sessionId, {
      cwd: this.result?.cwd, rounds: 3, intervalMs: 2000,
    });
    if (result.quiet) {
      await this.transcript.append("run.stop_verified", { backendSessionId: sessionId, path: "_runCleanup" });
    } else {
      await this.transcript.append("run.stop_unverified", {
        backendSessionId: sessionId, path: "_runCleanup", delta: result.delta, metric: result.metric,
      });
      // 告警：_runCleanup 路径的 abort 未验证，后台可能仍在烧（TD-38 缺口）
      raiseAlert("stop_unverified",
        `_runCleanup stop not verified (run ${this.runId}): backend may still be running`,
        { runId: this.runId, logPath: join(this.config.runDir, "ALERTS.log") },
      ).catch(() => { /* 告警失败不影响终态 */ });
    }
  }

  async _abortInternal(reason) {
    this._aborted = true;
    // 标记会话已被显式 abort，_runCleanup 兜底时不再重复调（幂等）
    this._sessionKilled = true;
    let abortError;
    try {
      // 优先用 handle.abort（封装了 serveUrl/sessionId），fallback 到 backend.abort
      if (this.handle?.abort) {
        await this.handle.abort();
      } else {
        await this.backend.abort(this.agent.serveUrl, this.result.backendSessionId);
      }
    } catch (error) {
      abortError = error.message ?? "abort_failed";
    }
    // TD-99：run.aborted 与 aborted state_change 同批原子提交（factEvents）。
    // rejected 时不留 run.aborted fact（输给先到的终态）。
    // 无论 backend.abort 成功与否，run 都进入 aborted 状态（状态机以意图为准，不以后端成败为准）。
    await this._transition(this.state, "aborted", reason, {
      factEvents: [{
        type: "run.aborted",
        payload: {
          backendSessionId: this.result.backendSessionId,
          reason,
          ...(abortError ? { error: abortError } : {}),
        },
      }],
    });
    await this._runCleanup();
  }

  async _transition(from, to, reason, options = {}) {
    // TD-99：走原子终态仲裁（first-terminal-wins）。
    // accepted：this.state = to + 触发 friction hook。terminal fact（run.completed/
    //   run.timed_out/run.aborted）通过 options.factEvents 与 state_change 同批原子提交。
    // rejected：this.state 同步为现有终态（不复活），不写任何 terminal fact，返回结果
    //   让调用方据现有终态分支。
    const result = await this.transcript.transitionState(from, to, reason, options);
    if (result.accepted) {
      this.state = to;
      // TD-92 debug mode：失败终态自动捕获 friction（镜像 raiseAlert，fire-and-forget 不阻塞终态）
      if (to === "failed" || to === "timed_out" || to === "aborted") {
        _maybeWriteFrictionLog(this).catch(() => {});
      }
    } else {
      // 输给先到的终态——同步 this.state，不改终态。
      this.state = result.state;
    }
    return result;
  }
}

/**
 * TD-99：构造"loser 结果"——当 _transition rejected（输给先到的终态）时，
 * waitForCompletion 各终态路径返回与现有终态一致的结构化结果。
 * 不改终态，不 throw failed——loser 尊重 first-terminal-wins。
 */
function _loserResult(existingTerminal, base) {
  return {
    ...base,
    completed: existingTerminal === "completed",
    failed: existingTerminal === "failed",
    aborted: existingTerminal === "aborted",
    timedOut: existingTerminal === "timed_out",
  };
}

/**
 * TD-103 Phase 3A: sanitize delivery error messages for transcript/result.
 * Returns a concise, non-secret summary. Raw error messages may contain file
 * paths, stderr, or secrets — the structured deliveryCode carries the
 * machine-readable category; this message is a safe human-readable label only.
 */
function _sanitizeDeliveryMessage(msg) {
  if (typeof msg !== "string" || msg.length === 0) return "delivery packaging error";
  // For known DeliveryError codes, use a safe fixed description.
  // For unknown errors, do NOT echo the raw message — it may contain secrets.
  // The deliveryCode field carries the machine-readable category.
  const lower = msg.toLowerCase();
  if (lower.includes("empty_diff") || lower.includes("no changes")) return "empty diff — no changes to package";
  if (lower.includes("disallowed_path")) return "changes outside allowed paths";
  if (lower.includes("pre_staged")) return "pre-staged changes detected";
  if (lower.includes("not_a_git_repo")) return "worktree is not a git repository";
  if (lower.includes("primary_checkout")) return "worktree is primary checkout, not isolated";
  if (lower.includes("wrong_branch")) return "worktree on wrong branch";
  if (lower.includes("base_commit_mismatch")) return "worktree HEAD does not match base commit";
  if (lower.includes("detached_head")) return "worktree HEAD is detached";
  if (lower.includes("commit_integrity") || lower.includes("integrity")) return "delivery commit integrity check failed";
  if (lower.includes("staging_mismatch")) return "staged paths do not match inspected changes";
  if (lower.includes("commit_failed") || lower.includes("commit-tree")) return "git commit-tree failed";
  if (lower.includes("cleanup_failed")) return "delivery cleanup failed";
  // Unknown error — do not leak raw message
  return "delivery packaging error";
}

/**
 * TD-92：读 transcript + 调 writeFrictionLog。fire-and-forget，失败降级不阻塞终态。
 * 在 Run._transition 的失败终态路径调用。不抛——friction 捕获失败只是少一个 log 文件。
 */
async function _maybeWriteFrictionLog(run) {
  const events = await readTranscript(run.transcript.filePath);
  const frictionLogDir = frictionLogDirFromRunDir(run.config.runDir);
  // metrics 从 transcript 提取（最后一条 run.metrics）
  const metricsEvent = [...events].reverse().find((e) => e.type === "run.metrics");
  const metrics = metricsEvent ? {
    costUsd: metricsEvent.costUsd,
    tokens: metricsEvent.tokens?.total,
    durationMs: metricsEvent.durationMs,
  } : {};
  await writeFrictionLog(run.runId, run.agentId, events, {
    frictionLogDir,
    debugMode: run.config.debugMode,
    metrics,
  });
}

/**
 * TD-95 #5 / TD-97：backend done(failed) 时审计已累积的证据。
 *
 * TD-97：复用 assessRunEvidence（SSOT），不再自己判 file_written/command/assistant text。
 * 不跑完整 scorecard（hasDoneEvent 会 fail——failed 路径无 run.completed 事件）。
 * 只查"正面证据信号"：有 file_written 或 command(exitCode===0) → passed:true。
 *
 * 目的：worker 可能写对了文件 + 跑对了测试，只是 backend 进程退出码非零。
 * 让 Lead 知道"证据其实通过了"，而非被迫从 raw transcript 手动翻找。
 *
 * @param {object[]} evidence — waitForCompletion 累积的 evidence 数组（RunEvent 形状 {kind,...}）
 * @param {object[]} messages — 累积的 messages（内存形状 {info:{role},parts}）
 * @returns {{passed: boolean, checks: object[]}}
 */
function _auditEvidenceOnFailure(evidence, messages) {
  // TD-97：合并 evidence + messages 后调统一评估（assessRunEvidence 兼容三种形状）
  const all = [...(evidence ?? []), ...(messages ?? [])];
  const a = assessRunEvidence(all);
  const checks = [
    { name: "evidence_file_written", passed: a.hasFileWritten },
    { name: "evidence_command_exit0", passed: a.hasCommandExit0 },
    { name: "evidence_assistant_text", passed: a.hasAssistantText },
  ];
  // passed = 有产出证据（文件写入 或 命令成功）——任一即说明 worker 做了实事
  const passed = a.hasFileWritten || a.hasCommandExit0;
  return { passed, checks };
}
