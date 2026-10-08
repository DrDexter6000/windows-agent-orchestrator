// src/application/runVerifyCommit.js
//
// TD-240（2026-10-09，consult_20261008164029600fyqngp astra+opus 双席裁定①-⑥）：
// `runs verify-commit` ——拒收/人工采纳后的 Lead 侧验证承载命令。
//
// 在临时 worktree 检出指定提交 → 依 Lead 提供的 commands-file 执行命令 → 把
// 证据以独立事件族（run.lead_commit_check_started/_outcome）追加进指定 run 的
// 转录 → 清理。义务定位：采纳协议第 1 步（Lead 侧归因）与第 4 步（集成后终验）
// 的执行承载；**不满足第 3 步独立审计证据规格（HEAD+branch --contains+reflog），
// outcome 不得当受审对象替代品**（⑥边界锁，docs/usage.md 采纳协议节钉句）。
//
// 裁定对照（偏离任何一条即回会审）：
//   ① 事件落点 = CLI 指定 runId（不反推提交归属）；仅接受已终态（findState 落
//      TERMINAL_STATES（只认 state_change——legacy 推断拒绝，验收修 F1），判定依据记录进 started
//      事件）且转录含恰好一条可用 run.delivery_created 的 run；信封 agentId
//      沿用该 run 真实 agentId（repackage :754 形态 events[0]?.agentId）；提交
//      关系记事实字段不设拒（isDeliveryCommit/containsDeliveryCommit/
//      adoptedFromTrailer）。
//   ② 事件族 = run.lead_commit_check_started（首命令前写：checkId 随机 nonce、
//      提交全形、命令清单原文+文件字节 sha256）+ run.lead_commit_check_outcome
//      （status∈{passed,failed,aborted}；results[]：index/exitCode/timedOut/
//      durationMs+失败 8KiB 尾；独立 cleanup∈{ok,failed} 字段）。仅 started 无
//      outcome = 合法不完整证据（projectLeadCommitChecks 投影 incomplete，绝不
//      读作通过）。不做恰一条 CAS——允许多次核验，checkId 区分。
//   ③ commands-file = JSON 字符串数组（CLI 复用 reverify --setup-commands-file
//      解析器与边界：≤32 条×每条≤512 字符）；--timeout-ms 单值闭区间
//      [1000,7200000]（delivery.js SSOT 常量）；执行一律走既有
//      runVerificationCommand（系统唯一有意 shell 边界，不另开入口）；SHA 过
//      isCanonicalCommitId 全形（40/64，不接受短形）+ rev-parse --verify
//      --end-of-options ^{commit} 等值校验；复用 detectAbsolutePathLiteral 防
//      命令越出临时 worktree；事件原文记命令（有界，经转录脱敏器）+文件字节
//      sha256。
//   ④ 临时 worktree = git worktree add --detach 于 <repo>/.wao-worktrees/
//      verify-<nonce>/（严禁 os.tmpdir()——worktree 无 node_modules，靠向上解析
//      主仓 node_modules〔isolation.js:50〕，tmpdir 必致 SDK/zod 假红）；启动先
//      git worktree prune + 清残留 verify-* 目录；复用机器验证闸（同 T3/verifier
//      串行，别抢）。
//   ⑤ env 复用 prepareAttemptEnv（TD-240 自 deliveryVerification.js 导出，行为
//      零变化；已含 TD-230 钉/剥 WAO_IN_WORKER/0047 豁免/逐次 TMP 隔离）；调用
//      env 准备之前先过 worker 上下文限制（nestedDispatchGuard——本命令不得成为
//      worker 获取净化环境/嵌套豁免的入口；Lead 主检出语境正常放行）；fixture
//      视角不注入 live config/.wao/runs（TD-214 方案 B；worktree 靠向上解析故
//      无需 npm ci）。
//   ⑥ 边界锁 = 两事件均带 kind:"lead_self_check" + independentAuditRequired:
//      true；CLI 输出与本模块投影不出现 accepted/verified 字样。
//
// 超时/中断/清理语义（裁定②④细化）：命令超时复用 runVerificationCommand 内置
// _killProcessTree，fail-fast 停后续，记 failed+timedOut；Ctrl-C 尽力写
// aborted+清理（interrupt 标志在命令间与命令后检查；子进程随控制台 Ctrl-C 自
// 终止，未终止则 bounded by timeout）；清理失败：结果照记+cleanup:"failed"，
// 整体非零退出；硬杀：只剩 started=合法不完整。
//
// 逐命令内容复证（任务书反例"检出后被外部改动→命令 exit 0 也不得记 passed"
// 的实现选择，交付内核 assertCommittedDeliveryRef 同族轻量版）：每条命令后
// 重证 worktree HEAD 仍为受检提交且 tracked 文件零改动（--untracked-files=no，
// 构建产物不误伤）；漂移 → fail-fast 记 failed，该行 results[i].contentDrift:
// true。
//
// Architectural contract:
//   - No argv parsing, no console.log, no process.exit.
//   - Does not import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Reuses transcript.js / delivery.js / deliveryVerification.js /
//     runWorkspaceOwnership.js / nestedDispatchGuard.js SSOTs — no copied
//     algorithm, no copied boundary constant, no second shell boundary.
//   - Safe result carries closed-set fields only — never commands, tails,
//     paths, or env.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  readTranscript,
  findState,
  findLastEventSeq,
  JsonlTranscript,
  TERMINAL_STATES,
  REVERIFY_SETUP_COMMANDS_LIMIT,
  REVERIFY_SETUP_COMMAND_MAX_LENGTH, transcriptPathFor } from "../transcript.js";
import {
  isValidRunId,
  isCanonicalCommitId,
  detectAbsolutePathLiteral,
  gitChildEnv,
  VERIFICATION_TIMEOUT_MS_MIN,
  VERIFICATION_TIMEOUT_MS_MAX,
  VERIFICATION_TIMEOUT_MS_DEFAULT,
} from "../delivery.js";
import {
  runVerificationCommand,
  prepareAttemptEnv,
  cleanupAttemptEnv,
  createCallerGate,
} from "../deliveryVerification.js";
import { verifyRunWorkspaceOwnership } from "./runWorkspaceOwnership.js";
import { nestedDispatchContext, nestedDispatchRefusalText } from "../nestedDispatchGuard.js";
import { ensureWaoWorktreeExclude } from "../gitLocalExclude.js";

// CLI 层复用的边界常量（service 是边界权威——no copied boundary constants）。
export {
  REVERIFY_SETUP_COMMANDS_LIMIT as VERIFY_COMMIT_COMMANDS_LIMIT,
  REVERIFY_SETUP_COMMAND_MAX_LENGTH as VERIFY_COMMIT_COMMAND_MAX_LENGTH,
  VERIFICATION_TIMEOUT_MS_MIN as VERIFY_COMMIT_TIMEOUT_MS_MIN,
  VERIFICATION_TIMEOUT_MS_MAX as VERIFY_COMMIT_TIMEOUT_MS_MAX,
  VERIFICATION_TIMEOUT_MS_DEFAULT as VERIFY_COMMIT_TIMEOUT_MS_DEFAULT,
};

// ===== 裁定②⑥：事件族常量（闭集 SSOT） =====

export const LEAD_COMMIT_CHECK_STARTED_TYPE = "run.lead_commit_check_started";
export const LEAD_COMMIT_CHECK_OUTCOME_TYPE = "run.lead_commit_check_outcome";
export const LEAD_COMMIT_CHECK_KIND = "lead_self_check";
export const LEAD_COMMIT_CHECK_STATUSES = Object.freeze(["passed", "failed", "aborted"]);
export const LEAD_COMMIT_CHECK_CLEANUP_STATUSES = Object.freeze(["ok", "failed"]);
export const LEAD_COMMIT_CHECK_TERMINALITY_BASES = Object.freeze(["state_change"]); // 会审验收修 F1：legacy 无准入资格，basis 字段保留 legacy_inferred 仅用于拒绝时的依据记录

// ===== 内部 git 执行（delivery.js 同款纪律：结构化参数，绝不拼 shell 串） =====

/**
 * 默认 git 执行缝。结构化参数 + gitChildEnv SSOT（GIT_NO_REPLACE_OBJECTS=1
 * force-last）+ stderr 吞掉。可注入（gitFn）供测试。
 */
function _defaultGitFn(args, opts = {}) {
  return execFileSync("git", args, {
    cwd: opts.cwd,
    encoding: opts.encoding ?? "utf8",
    env: gitChildEnv(),
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
}

// ===== 投影（裁定②：仅 started 无 outcome = incomplete，绝不读作通过） =====

/**
 * 把一个 run 转录里的 lead-commit-check 事件族投影为按 checkId 配对的只读
 * 清单。started 无对应 outcome → status "incomplete"（合法不完整证据）；有
 * outcome → 闭集 status（passed/failed/aborted）+ cleanup（ok/failed）。同一
 * checkId 多条 outcome 时最后一条为权威（append-only 账本的最新事实）。输出
 * 仅闭集字段与既验证形状的 commit/checkId——绝不合成"通过"结论。
 *
 * @param {object[]} events
 * @param {string} runId
 * @returns {{count: number, checks: Array<{checkId, commit, status, hasOutcome, cleanup?}>}}
 */
export function projectLeadCommitChecks(events, runId) {
  if (!Array.isArray(events)) return { count: 0, checks: [] };
  const started = [];
  const outcomes = new Map();
  for (const e of events) {
    if (!e || typeof e !== "object" || e.runId !== runId) continue;
    if (typeof e.checkId !== "string" || e.checkId.length === 0) continue;
    if (e.type === LEAD_COMMIT_CHECK_STARTED_TYPE) {
      started.push(e);
    } else if (e.type === LEAD_COMMIT_CHECK_OUTCOME_TYPE) {
      outcomes.set(e.checkId, e);
    }
  }
  const checks = started.map((s) => {
    const o = outcomes.get(s.checkId);
    const status = o && LEAD_COMMIT_CHECK_STATUSES.includes(o.status) ? o.status : "incomplete";
    return {
      checkId: s.checkId,
      commit: typeof s.commit === "string" && isCanonicalCommitId(s.commit) ? s.commit : null,
      status,
      hasOutcome: Boolean(o),
      ...(o && LEAD_COMMIT_CHECK_CLEANUP_STATUSES.includes(o.cleanup) ? { cleanup: o.cleanup } : {}),
    };
  });
  return { count: checks.length, checks };
}

// ===== 内部 helper =====

/**
 * 裁定② results[] 行：index/exitCode/timedOut/durationMs + 字节数 + 失败 8KiB
 * 尾（runVerificationCommand 的滚动尾窗口已 8KiB 封顶——TAIL_MAX_BYTES 同源）。
 * 绿色（exit 0 且非超时且非启动失败）结构性零尾——与交付内核 _recordResult 同
 * 契约。命令原文不进 results 行（started 事件已记清单原文，index 对位）。
 */
function _resultRow(index, result) {
  const green = result.exitCode === 0 && !result.timedOut && !result.launchError;
  return {
    index,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    stdoutTail: green || typeof result.stdoutTail !== "string" ? "" : result.stdoutTail,
    stderrTail: green || typeof result.stderrTail !== "string" ? "" : result.stderrTail,
  };
}

/** CLI 安全投影行：闭集字段 only——绝不带尾内容/命令文本/路径。 */
function _safeResultRow(row) {
  return {
    index: row.index,
    exitCode: row.exitCode,
    timedOut: row.timedOut,
    durationMs: row.durationMs,
    ...(row.contentDrift === true ? { contentDrift: true } : {}),
  };
}

/**
 * 每条命令后的 worktree 完整性复证（轻量版 assertCommittedDeliveryRef）：
 * HEAD 仍为受检提交 且 tracked 文件零改动（--untracked-files=no——构建产物
 * 不误伤）。任何 git 读失败按漂移处理（fail-closed）。
 */
function _worktreeIntact(gitFn, wtPath, commit) {
  try {
    const head = String(gitFn(["rev-parse", "HEAD"], { cwd: wtPath })).trim();
    if (head !== commit) return false;
    const porcelain = String(gitFn(
      ["status", "--porcelain=v1", "-z", "--untracked-files=no"],
      { cwd: wtPath },
    ));
    if (porcelain.trim().length > 0) return false;
    // 会审验收修（F4，astra）：assume-unchanged / skip-worktree 位可对
    // status/diff 隐身改动——ls-files -v 里小写 h（assume-unchanged）与
    // S（skip-worktree）即异常标志，在场一律按漂移处理（fail-closed，不
    // 信任索引标志，强制走真实 tracked 内容检查面）。
    const ls = String(gitFn(["ls-files", "-v"], { cwd: wtPath }));
    if (/(^|\n)([a-z]|S)/.test(ls)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 裁定④：启动卫生——git worktree prune + 清残留 verify-* 目录（崩溃前次
 * 遗留）。全部 best-effort：prune/清扫失败不阻塞本次核验（worktree add 自带
 * 目录名随机性，碰撞概率可忽略；残留只会占磁盘）。
 */
export async function _sweepStaleVerifyWorktrees(gitFn, repoRoot) {
  try {
    gitFn(["worktree", "prune"], { cwd: repoRoot });
  } catch { /* best-effort */ }
  // 会审验收修（F2，astra+opus）：只回收"可证明失活"的目录——仍在
  // `git worktree list` 注册中的 verify-* 属于可能活着的并发核验（或未及
  // self-clean 的本实例），一律跳过；仅清除未注册的孤儿目录（崩溃残留）。
  // 调用点在闸前：安全性由注册检查承担（worktree add 即注册，活实例恒在册）；
  let registered = new Set();
  // 归一化（分隔符/大小写——Windows 上 porcelain 与 join 的路径形态不一致）
  const norm = (p) => String(p).replace(/[\\/]+/g, "\\").toLowerCase();
  const listRegistered = () => {
    const list = String(gitFn(["worktree", "list", "--porcelain"], { cwd: repoRoot }));
    const s = new Set();
    // 复核会审修：路径取整行余部（\S+ 漏含空格路径），trim 收边。
    for (const m of list.matchAll(/^worktree (.+)$/gm)) s.add(norm(m[1].trim()));
    return s;
  };
  try {
    registered = listRegistered();
  } catch { /* 读不出注册表=无法证明失活——放弃本轮清扫 */ }
  if (registered.size === 0) return;
  const wtRoot = join(repoRoot, ".wao-worktrees");
  let entries;
  try {
    entries = await readdir(wtRoot);
  } catch {
    return; // 无 .wao-worktrees 目录（首次核验）——正常
  }
  for (const name of entries) {
    if (!name.startsWith("verify-")) continue;
    const dir = join(wtRoot, name);
    if (registered.has(norm(dir))) continue; // 注册中=可能在役，不回收
    // 复核会审修（astra）：快照后新建的并发 worktree 会落进本循环——删除前
    // 重查一次注册表，命中即跳过；重查失败同样跳过（无法证明失活=不删）。
    try {
      if (listRegistered().has(norm(dir))) continue;
    } catch {
      continue; // 第三轮会审修（astra 反例）：重查失败不得落穿到 rm
    }
    try {
      await rm(dir, { recursive: true, force: true });
    } catch { /* best-effort：残留交给下次 */ }
  }
}

/**
 * 清理临时 worktree：git worktree remove --force（cwd=repoRoot），失败回退
 * rmSync 形强删 + prune；最多 3 次退避重试（isolation.removeWorktree 同款
 * Windows 文件锁纪律）。返回闭集 "ok"|"failed"（目录消失即 ok）。
 */
async function _removeVerifyWorktree(gitFn, repoRoot, wtPath) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      gitFn(["worktree", "remove", "--force", wtPath], { cwd: repoRoot });
    } catch {
      try {
        await rm(wtPath, { recursive: true, force: true });
      } catch { /* 尽力，走重试 */ }
      try {
        gitFn(["worktree", "prune"], { cwd: repoRoot });
      } catch { /* prune 失败不阻塞 */ }
    }
    if (!existsSync(wtPath)) {
      try {
        gitFn(["worktree", "prune"], { cwd: repoRoot });
      } catch { /* best-effort */ }
      return "ok";
    }
    await new Promise((r) => setTimeout(r, 100 * attempt));
  }
  return existsSync(wtPath) ? "failed" : "ok";
}

/** 裁定①：终态判定 + 依据。bound = 本 runId 信封绑定事件。
 * 会审验收修（F1，astra+opus 一致）：只认终态 run.state_change 作准入——
 * legacy"末条事件推断"的 run 一律拒绝。原因：findState 的 legacy 分支按最后
 * 一条事件推断，追加本命令的两条自检事件会把 completed 翻成 running，间接
 * 污染 acceptanceRecord 消费的状态（违反裁定⑥"不改任何判定输入"）。 */
function _terminality(bound) {
  const hasTerminalStateChange = bound.some(
    (e) => e && e.type === "run.state_change" && TERMINAL_STATES.includes(e.to),
  );
  return {
    state: findState(bound),
    terminal: hasTerminalStateChange,
    basis: hasTerminalStateChange ? "state_change" : "legacy_inferred",
  };
}

// ===== 主入口 =====

/**
 * 执行一次 Lead 侧提交核验（TD-240）。详见模块头裁定对照①-⑥。
 *
 * @param {object} input
 * @param {string} input.runId — 必过 isValidRunId
 * @param {string} input.runDir — runs/ 目录（host-owned）
 * @param {string} input.authorizedWorkspaceRoot — CLI workspace proof 产生的
 *        权威仓根（临时 worktree 创建于此仓 .wao-worktrees/ 下）
 * @param {string} input.commit — 全形 canonical SHA（40/64；短形在 CLI/服务
 *        双层拒绝）
 * @param {string[]} input.commands — Lead commands-file 解析出的命令清单
 *        （原文执行、原文记事件）
 * @param {string} [input.commandsFileSha256] — commands-file 字节 sha256
 * @param {number} [input.timeoutMs] — 单值闭区间 [1000,7200000]（每命令预算）
 * @param {string} [input.invocationCwd] — 调用语境 cwd（worker 上下文门探测；
 *        缺省 process.cwd()）
 * @param {object} [input.env] — worker 上下文门探测 env（缺省 process.env）
 * @param {{requested?: boolean}} [input.interrupt] — 中断标志（Ctrl-C 尽力路径）
 * @param {Function} [input.readTranscriptFn] — 注入（缺省 readTranscript）
 * @param {Function} [input.transcriptFactory] — 注入 (filePath, context) => transcript
 * @param {Function} [input.runCommandFn] — 注入（缺省 runVerificationCommand；
 *        注入时入机器闸判定 usesDefaultVerifier=false，不争真实租约）
 * @param {Function} [input.prepareAttemptEnvFn] — 注入（缺省 prepareAttemptEnv）
 * @param {Function} [input.cleanupAttemptEnvFn] — 注入（缺省 cleanupAttemptEnv）
 * @param {Function} [input.gitFn] — 注入（缺省结构化参数 execFileSync + gitChildEnv）
 * @param {Function} [input.randomIdFn] — 注入（缺省 randomBytes(8).hex）
 * @returns {Promise<{runId, checkId, commit, status, cleanup, results, events: {started: boolean, outcome: boolean}, exitCode}>}
 * @throws {Error} 任何前置拒绝 / 基础设施失败（此时已尽力清理临时 worktree）
 */
export async function runVerifyCommit({
  runId,
  runDir,
  authorizedWorkspaceRoot,
  commit,
  commands,
  commandsFileSha256,
  timeoutMs,
  invocationCwd = process.cwd(),
  env = process.env,
  interrupt = { requested: false },
  readTranscriptFn,
  transcriptFactory,
  runCommandFn,
  prepareAttemptEnvFn,
  cleanupAttemptEnvFn,
  gitFn,
  randomIdFn,
}) {
  // ===== 输入校验（fail closed before any read/write） =====
  if (!runId || typeof runId !== "string") throw new Error("runVerifyCommit: runId is required");
  if (!runDir || typeof runDir !== "string") throw new Error("runVerifyCommit: runDir is required");
  if (!isValidRunId(runId)) throw new Error(`Invalid runId: ${JSON.stringify(runId)}`);
  if (typeof authorizedWorkspaceRoot !== "string" || authorizedWorkspaceRoot.length === 0) {
    throw new Error("runVerifyCommit: authorizedWorkspaceRoot is required");
  }
  // 裁定③：全形 canonical SHA（40/64 小写 hex）——短形不接受（TD-238 短形只用于期望锚）。
  if (!isCanonicalCommitId(commit)) {
    throw new Error("runVerifyCommit: commit must be a canonical full-form 40/64-hex commit id (short forms are not accepted)");
  }
  // 裁定③：命令清单闭界（与 reverify --setup-commands-file 同界——≤32×≤512）。
  if (!Array.isArray(commands)) throw new Error("runVerifyCommit: commands must be an array");
  if (commands.length === 0) throw new Error("runVerifyCommit: commands must not be empty");
  if (commands.length > REVERIFY_SETUP_COMMANDS_LIMIT) {
    throw new Error(`runVerifyCommit: commands exceeds ${REVERIFY_SETUP_COMMANDS_LIMIT}`);
  }
  for (const cmd of commands) {
    if (typeof cmd !== "string") throw new Error("runVerifyCommit: commands must be strings");
    if (cmd.trim().length === 0) throw new Error("runVerifyCommit: commands must be non-empty");
    if (cmd.length > REVERIFY_SETUP_COMMAND_MAX_LENGTH) {
      throw new Error(`runVerifyCommit: command exceeds ${REVERIFY_SETUP_COMMAND_MAX_LENGTH} characters`);
    }
  }
  if (commandsFileSha256 !== undefined && commandsFileSha256 !== null
    && !/^[0-9a-f]{64}$/.test(commandsFileSha256)) {
    throw new Error("runVerifyCommit: commandsFileSha256 must be a 64-hex digest");
  }
  // 裁定③：--timeout-ms 单值闭区间 [1000,7200000]（delivery.js SSOT 常量）。
  const effectiveTimeoutMs = timeoutMs === undefined || timeoutMs === null
    ? VERIFICATION_TIMEOUT_MS_DEFAULT
    : timeoutMs;
  if (
    typeof effectiveTimeoutMs !== "number"
    || !Number.isInteger(effectiveTimeoutMs)
    || effectiveTimeoutMs < VERIFICATION_TIMEOUT_MS_MIN
    || effectiveTimeoutMs > VERIFICATION_TIMEOUT_MS_MAX
  ) {
    throw new Error(
      `runVerifyCommit: timeoutMs must be an integer in [${VERIFICATION_TIMEOUT_MS_MIN}, ${VERIFICATION_TIMEOUT_MS_MAX}]`,
    );
  }
  if (!interrupt || typeof interrupt !== "object") {
    throw new Error("runVerifyCommit: interrupt must be an object");
  }

  const _git = gitFn ?? _defaultGitFn;
  const _rand = randomIdFn ?? (() => randomBytes(8).toString("hex"));
  const _read = readTranscriptFn ?? readTranscript;
  const _runCommand = runCommandFn ?? runVerificationCommand;
  const _prepareEnv = prepareAttemptEnvFn ?? prepareAttemptEnv;
  const _cleanupEnv = cleanupAttemptEnvFn ?? cleanupAttemptEnv;

  // ===== 裁定⑤：worker 上下文限制先于一切 env 准备 =====
  // 本命令不得成为 worker 获取净化环境/嵌套豁免的入口；Lead 主检出语境正常
  // 放行（nestedDispatchGuard 同一判定，零分叉；WAO_ALLOW_NESTED_DISPATCH=1 是
  // Lead 显式豁免的既有文档化机制——如 worktree 内合法测试场景）。
  for (const probeCwd of [process.cwd(), invocationCwd]) {
    const workerCtx = nestedDispatchContext(env, probeCwd);
    if (workerCtx !== null) {
      throw new Error(nestedDispatchRefusalText(workerCtx));
    }
  }

  // ===== 裁定①：前置（转录存在 / workspace 归属 / 终态 / delivery_created） =====
  const filePath = transcriptPathFor(runDir, runId);
  let events;
  try {
    events = await _read(filePath);
  } catch {
    throw new Error(`runVerifyCommit: run not found (transcript missing: runs/${runId}.jsonl)`);
  }
  verifyRunWorkspaceOwnership(events, authorizedWorkspaceRoot, runId);

  const bound = events.filter((e) => e && e.runId === runId);
  const terminality = _terminality(bound);
  if (!terminality.terminal) {
    throw new Error(
      `runVerifyCommit: run ${runId} is not terminal (state: ${terminality.state}) — lead commit checks only append to terminal runs`,
    );
  }
  const createdEvents = bound.filter(
    (e) => e && e.type === "run.delivery_created" && e.delivery && typeof e.delivery === "object",
  );
  if (createdEvents.length === 0) {
    throw new Error(`runVerifyCommit: run ${runId} has no run.delivery_created — lead commit checks require a delivery run`);
  }
  if (createdEvents.length > 1) {
    throw new Error(`runVerifyCommit: multiple run.delivery_created events found (${createdEvents.length}); exactly one required`);
  }
  const createdRef = createdEvents[0].delivery;
  if (!isCanonicalCommitId(createdRef.deliveryCommit)) {
    throw new Error("runVerifyCommit: delivery_created DeliveryRef has no canonical deliveryCommit");
  }

  // 裁定①：信封 agentId 沿用该 run 真实 agentId（repackage :754 形态——取
  // 转录首事件 agentId，防 extractCanonicalAgentId 降级路径）。
  const context = {
    runId,
    agentId: events[0]?.agentId ?? "unknown",
    initialSeq: findLastEventSeq(events),
  };

  // ===== 裁定③：SHA 等值校验 + 裁定①：提交关系事实字段（不设拒） =====
  let resolved;
  try {
    resolved = String(_git(
      ["rev-parse", "--verify", "--end-of-options", `${commit}^{commit}`],
      { cwd: authorizedWorkspaceRoot },
    )).trim();
  } catch {
    throw new Error("runVerifyCommit: commit does not resolve in the authorized repository (rev-parse --verify failed)");
  }
  if (resolved !== commit) {
    throw new Error("runVerifyCommit: commit does not resolve to itself (rev-parse canonicalization mismatch)");
  }
  let containsDeliveryCommit = false;
  try {
    _git(
      ["merge-base", "--is-ancestor", "--end-of-options", createdRef.deliveryCommit, commit],
      { cwd: authorizedWorkspaceRoot },
    );
    containsDeliveryCommit = true;
  } catch {
    containsDeliveryCommit = false;
  }
  let adoptedFromTrailer = false;
  try {
    const message = String(_git(
      ["log", "-1", "--format=%B", "--end-of-options", commit],
      { cwd: authorizedWorkspaceRoot },
    ));
    // 会审验收修（F3，astra+opus）：行锚定精确匹配——includes 会把前缀碰撞
    // （run_example2 命中 run_example）与正文伪 trailer 一并误报。
    adoptedFromTrailer = new RegExp(
      `^WAO-Adopted-From: ${runId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      "m",
    ).test(message);
  } catch {
    adoptedFromTrailer = false;
  }
  const commitRelations = {
    isDeliveryCommit: commit === createdRef.deliveryCommit,
    containsDeliveryCommit,
    adoptedFromTrailer,
  };

  // ===== 裁定③：绝对路径字面量扫描（防命令越出临时 worktree） =====
  for (const cmd of commands) {
    if (detectAbsolutePathLiteral(cmd) !== null) {
      throw new Error(
        "runVerifyCommit: command contains a statically identifiable absolute path literal; use a portable workspace-relative command",
      );
    }
  }

  // ===== 裁定④：临时 worktree（prune + 清残留 + exclude 规则 + --detach 检出） =====
  await _sweepStaleVerifyWorktrees(_git, authorizedWorkspaceRoot);
  await ensureWaoWorktreeExclude(authorizedWorkspaceRoot);
  const dirNonce = _rand();
  const wtPath = join(authorizedWorkspaceRoot, ".wao-worktrees", `verify-${dirNonce}`);
  try {
    _git(
      ["worktree", "add", "--detach", wtPath, "--end-of-options", commit],
      { cwd: authorizedWorkspaceRoot },
    );
  } catch (err) {
    throw new Error(`runVerifyCommit: temporary worktree checkout failed (${err instanceof Error ? err.name : "git error"})`);
  }

  // ===== 裁定②：started 事件（首命令前写） =====
  const checkId = _rand();
  const transcript = transcriptFactory
    ? await transcriptFactory(filePath, context)
    : new JsonlTranscript(filePath, context);

  let cleanupStatus = "failed";
  try {
    if (interrupt.requested === true) {
      // Ctrl-C 早于 started：未开始即止——不写任何事件（无 started 即无配对
      // 义务），清理后以 aborted 收口、非零退出。
      cleanupStatus = await _removeVerifyWorktree(_git, authorizedWorkspaceRoot, wtPath);
      return {
        runId, checkId, commit,
        status: "aborted",
        cleanup: cleanupStatus,
        results: [],
        events: { started: false, outcome: false },
        exitCode: 1,
      };
    }
    try {
      await transcript.append(LEAD_COMMIT_CHECK_STARTED_TYPE, {
        checkId,
        commit,
        commands: [...commands],
        ...(commandsFileSha256 !== undefined && commandsFileSha256 !== null
          ? { commandsFileSha256 }
          : {}),
        timeoutMs: effectiveTimeoutMs,
        kind: LEAD_COMMIT_CHECK_KIND,
        independentAuditRequired: true,
        terminality: { state: terminality.state, basis: terminality.basis },
        commitRelations,
      });
    } catch (err) {
      throw new Error(`runVerifyCommit: failed to persist the check-started audit event (${err instanceof Error ? err.name : "append error"}) — no commands were executed`);
    }

    // ===== 裁定④：机器验证闸（同 T3/verifier 串行）+ 裁定②⑤：命令执行 =====
    const results = [];
    let status = "passed";
    const gate = createCallerGate({
      usesDefaultVerifier: runCommandFn === undefined,
      identity: { owner: "runVerifyCommit", sessionId: null, runId },
    });
    const runCommands = async (gateHeld) => {
      for (let i = 0; i < commands.length; i += 1) {
        if (interrupt.requested === true) {
          status = "aborted";
          return;
        }
        const attempt = await _prepareEnv(gateHeld);
        let result;
        try {
          result = await _runCommand(commands[i], wtPath, { timeoutMs: effectiveTimeoutMs, env: attempt.env });
        } finally {
          await _cleanupEnv(attempt);
        }
        const row = _resultRow(i, result);
        // 内容复证：命令 exit 0 但 worktree 漂移（tracked 改动/HEAD 移动）→
        // 不得记 passed——fail-fast 记 failed。
        if (!_worktreeIntact(_git, wtPath, commit)) {
          row.contentDrift = true;
          results.push(row);
          status = "failed";
          return;
        }
        results.push(row);
        if (interrupt.requested === true) {
          status = "aborted";
          return;
        }
        if (result.launchError || result.timedOut || result.exitCode !== 0) {
          status = "failed";
          return;
        }
      }
    };
    if (gate) {
      const handle = await gate.acquire();
      if (!handle) {
        await runCommands(false); // fail-open（闸已向 sink 打 WARNING）
      } else {
        try {
          await runCommands(true);
        } finally {
          await handle.release();
        }
      }
    } else {
      await runCommands(false);
    }

    // ===== 清理（结果照记；失败 → cleanup:"failed"） =====
    cleanupStatus = await _removeVerifyWorktree(_git, authorizedWorkspaceRoot, wtPath);

    // ===== 裁定②：outcome 事件（清理结果照记；追加失败 → 抛错，只剩 started
    // = 合法不完整证据，绝不读作通过） =====
    try {
      await transcript.append(LEAD_COMMIT_CHECK_OUTCOME_TYPE, {
        checkId,
        commit,
        status,
        results,
        cleanup: cleanupStatus,
        kind: LEAD_COMMIT_CHECK_KIND,
        independentAuditRequired: true,
      });
    } catch (err) {
      throw new Error(`runVerifyCommit: failed to persist the check-outcome audit event (${err instanceof Error ? err.name : "append error"}) — the started event remains as legal incomplete evidence`);
    }

    return {
      runId,
      checkId,
      commit,
      status,
      cleanup: cleanupStatus,
      results: results.map(_safeResultRow),
      events: { started: true, outcome: true },
      // 清理失败/失败/中断 → 整体非零退出（裁定②④细化）。
      exitCode: status === "passed" && cleanupStatus === "ok" ? 0 : 1,
    };
  } finally {
    // 抛错路径（审计写失败/意外异常）的兜底清理——已在上方正常路径清过的，
    // 目录不存在时 remove 是 no-op（existsSync 先行）。
    if (existsSync(wtPath)) {
      await _removeVerifyWorktree(_git, authorizedWorkspaceRoot, wtPath);
    }
  }
}
