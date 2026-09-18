#!/usr/bin/env node
// scripts/dispatch-with-liveness.mjs
//
// TD-158：派发活性工具（Lead 工具层脚本，收编 Lead 手写在 %TEMP% 的
// "派发→等 85s→查活性→退避重派"循环）。
//
// 用途：上游间歇空窗期派发会秒败空跑（三次实证，各 ~30s 零产出）。本脚本
// 派发一个 run，观察其活性直至终态，仅当"重派谓词"三条件同时满足时退避重派。
//
// 不变量红线（本文件存在的原因，测试 test/registry-roles/dispatchLiveness.test.js 钉住）：
//   1. 绝不自动重试在飞 run——重派只发生在前一轮 run 已 terminal 之后
//      （observationAction：非终态一律继续观察）。
//   2. 绝不中止在飞 run——本脚本不调用 stop/abort，派发也不挂会杀 worker 的
//      派发侧 --wait-timeout（TD-148 实证：--wait-timeout 到期的控制器 abort 会
//      终止 worker 子进程，--background 同用照样重蹈）。安全组合 = 后台分离派发
//      （run --background，detached runner 拥有生命周期）+ 本脚本独立有界观察
//      （观察窗到期只结束本窗观察，绝不碰 worker）。因此任务原文"前台带
//      --wait-timeout"在此按 TD-148 审计结论落地为后台分离派发——前台形态
//      无法在不误杀的前提下实现"观察窗内活跃即继续等"。
//   3. knsoic 反误判锚点：零产出 ≠ 没在工作。纯调研 run 零文件写入但
//      message/tool_use 活跃是合法工作形态——观察窗内活跃即继续等，绝不因
//      "零写入"误杀或误重派；terminal 后有 assistant 文本的零写入 run 也不是
//      completed_empty（报告即产出）。
//
// 声明：本脚本是 Lead 工具，不是控制面——不改 CLI/MCP 合同、不做 runner 内核
// 扩展。所有状态/诊断/活性/证据判定复用 src 既有 SSOT（零第二实现）：
//   - 终态：      src/transcript.js TERMINAL_STATES / findState / findLastEventSeq
//   - 绑定作用域：src/metrics.js boundReportScope（R20 观测绑定纪律）
//   - 零证据 marker：src/diagnosis.js diagnoseFailure 的 code === "completed_empty"
//                 （DIAGNOSIS_CODES 闭集成 M12-21；与 `runs diagnose --format json`
//                 同一投影——不自造分类框架）
//   - 证据计数：  src/runEvidenceAssessment.js assessRunEvidence（TD-97 统一证据 SSOT）
//   - 活性：      src/application/runWait.js summarizeLiveness（progress/process_only/
//                 silent 闭集，与 `runs wait` 同一算法；message/command/tool_use/
//                 file_written 是其计数内核 ACTIVITY_KIND_MAP 的确定子集）
//   - 证停：      transcript 的 run.stop_verified / run.stop_unverified 事实
//                 （src/runManager.js _verifyStopQuietIfCapable 写入面）
//   - backend 家族：src/registry.js KNOWN_BACKENDS——除 opencode-serve（唯一
//                 sessionOutlivesProcess=true，src/backends/opencodeServe.js）外均为
//                 本地进程式 backend，进程退出即无会话残留
//
// 出处：TD-158（auditor 修正版方案，双席一致）；派发形状依据 TD-148。
// 运行：node scripts/wao-node.cjs scripts/dispatch-with-liveness.mjs ...（Node v22 经 shim）。

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { readTranscript, findState, findLastEventSeq, TERMINAL_STATES } from "../src/transcript.js";
import { boundReportScope } from "../src/metrics.js";
import { diagnoseFailure, DIAGNOSIS_CODES } from "../src/diagnosis.js";
import { assessRunEvidence } from "../src/runEvidenceAssessment.js";
import { summarizeLiveness } from "../src/application/runWait.js";
import { readRegistry, KNOWN_BACKENDS } from "../src/registry.js";
import { checkNodeVersion } from "../src/nodeVersionGuard.js";

// ===== 常量（导出：测试钉默认值） =====

export const DEFAULT_LIVENESS_WINDOW_MS = 85_000;
export const DEFAULT_MAX_ROUNDS = 6;
/** 退避基值：线性退避 = 基值 × 已完成的空跑轮数（20s / 40s / 60s ...）。 */
export const BACKOFF_BASE_MS = 20_000;
/** 观察轮询间隔（对齐 config/default.json pollInterval 5000）。 */
export const POLL_INTERVAL_MS = 5_000;
/** 派发子进程自身的 spawn 上限（后台派发只 fork runner 即返回，120s 足够宽松）。 */
export const DISPATCH_SPAWN_TIMEOUT_MS = 120_000;

/**
 * M12-21 completed-empty 机器事实码。必须是 src/diagnosis.js DIAGNOSIS_CODES
 * 闭集的成员（测试钉住）——绝不在此自造第二分类框架。
 */
export const COMPLETED_EMPTY_MARKER = "completed_empty";

/**
 * "确定活"的四类活动事件（任务指定）。它们是 runWait 计数内核
 * ACTIVITY_KIND_MAP 的确定子集；活性判定本身直接复用 summarizeLiveness
 * SSOT（metrics tick 也计活是仓库既有 TD 决策——run.metrics 曾被漏计致误报
 * silent，见 runWait.js PROGRESS_EVENT_TYPES 注释）。
 */
export const LIVENESS_SIGNAL_KINDS = Object.freeze([
  "message", "command", "tool_use", "file_written",
]);

/**
 * 本地进程式 backend 闭集（由 KNOWN_BACKENDS SSOT 派生，不手抄）：除
 * opencode-serve（唯一 sessionOutlivesProcess=true 的 HTTP serve backend）外，
 * claude-code / codex / kimi-code / deepseek-harness 的 worker 生命周期 = 进程
 * 生命周期，进程退出即无会话残留（usage.md 派发章节同款口径）。
 */
export const PROCESS_BACKEND_IDS = Object.freeze(
  KNOWN_BACKENDS.filter((b) => b !== "opencode-serve"),
);

/**
 * 透传保留 flag（出现即拒绝）：--prompt/--prompt-file/--background/--format 由
 * 脚本自有（派发形状固定）；--wait-timeout/--wait 会给派发挂上杀 worker 的
 * 派发侧上限（TD-148 红线）。
 */
export const RESERVED_PASSTHROUGH_FLAGS = Object.freeze([
  "--prompt", "--prompt-file", "--background", "--format", "--wait-timeout", "--wait",
]);

const KNOWN_VALUE_FLAGS = new Set([
  "--agent", "--prompt-file", "--cwd", "--liveness-window-ms", "--max-rounds",
]);

export const USAGE = `dispatch-with-liveness — TD-158 Lead 派发活性工具
用法:
  node scripts/wao-node.cjs scripts/dispatch-with-liveness.mjs --agent <id> --prompt-file <path> --cwd <dir> [选项] [-- <run 透传 flags>]
选项:
  --agent <id>               必填，agentId（registry 键）
  --prompt-file <path>       必填，任务文本文件（每轮重派原样复用）
  --cwd <dir>                必填，worker 工作目录（必须已存在）
  --liveness-window-ms <n>   观察窗毫秒（默认 ${DEFAULT_LIVENESS_WINDOW_MS}，到期只结束本窗观察，不碰 worker）
  --max-rounds <n>           派发轮次上限（默认 ${DEFAULT_MAX_ROUNDS}）
  --help / -h                本页
透传: "--" 之后的参数原样转给 \`run\`（如 --model / --reasoning / --isolate / --registry / --run-dir）。
保留（拒绝出现于透传）: ${RESERVED_PASSTHROUGH_FLAGS.join(" ")}——脚本自有派发形状，或属 TD-148 红线。
重派谓词（三条件同时满足）: ① 前一轮已 terminal；② completed_empty/零证据 marker；③ run_stop 证停或进程式无会话残留。`;

// ===== 纯函数区（导出，dry 测试钉住；无 I/O） =====

/** 终态判定——直接转发 transcript.js TERMINAL_STATES SSOT。 */
export function isTerminalState(state) {
  return TERMINAL_STATES.includes(state);
}

/**
 * 解析 argv。形状约定：`--` 之前只允许本脚本的已知 flag；之后全部原样透传。
 * 返回 { help, error, values, passthrough }：
 *   help=true            → 调用方打印 USAGE 退出 0
 *   error=string         → 拒绝原因（固定安全文案，含 flag 名）
 *   values               → { agent, promptFile, cwd, livenessWindowMs, maxRounds,
 *                            registry, runDir }（registry/runDir 从透传提取，供
 *                            脚本自身读 transcript/registry 用；null = 仓库默认）
 *   passthrough          → 原样转给 run 的参数
 */
export function parseDispatchArgs(argv) {
  const raw = Array.isArray(argv) ? argv : [];
  const sep = raw.indexOf("--");
  const own = sep >= 0 ? raw.slice(0, sep) : raw;
  const passthrough = sep >= 0 ? raw.slice(sep + 1) : [];

  if (own.includes("--help") || own.includes("-h")) {
    return { help: true, error: null, values: null, passthrough: [] };
  }

  const bad = (message) => ({ help: false, error: message, values: null, passthrough: [] });

  const flags = {};
  const seen = new Set();
  for (let i = 0; i < own.length; i += 1) {
    const a = own[i];
    if (typeof a !== "string" || !a.startsWith("--")) {
      return bad(`unexpected positional argument: ${String(a)} (flags for \`run\` go after the -- separator)`);
    }
    if (!KNOWN_VALUE_FLAGS.has(a)) {
      return bad(`unknown option: ${a} (flags for \`run\` go after the -- separator)`);
    }
    if (seen.has(a)) return bad(`${a} specified multiple times`);
    seen.add(a);
    const v = own[i + 1];
    if (v === undefined || v.startsWith("--")) return bad(`${a} requires a value`);
    if (String(v).trim().length === 0) return bad(`${a} must be non-empty`);
    flags[a] = String(v);
    i += 1;
  }

  for (const required of ["--agent", "--prompt-file", "--cwd"]) {
    if (flags[required] === undefined) return bad(`${required} is required`);
  }

  let livenessWindowMs = DEFAULT_LIVENESS_WINDOW_MS;
  if (flags["--liveness-window-ms"] !== undefined) {
    const n = Number(flags["--liveness-window-ms"]);
    if (!Number.isInteger(n) || n < 1000) {
      return bad("--liveness-window-ms must be an integer >= 1000");
    }
    livenessWindowMs = n;
  }
  let maxRounds = DEFAULT_MAX_ROUNDS;
  if (flags["--max-rounds"] !== undefined) {
    const n = Number(flags["--max-rounds"]);
    if (!Number.isInteger(n) || n < 1) {
      return bad("--max-rounds must be an integer >= 1");
    }
    maxRounds = n;
  }

  for (const f of passthrough) {
    if (RESERVED_PASSTHROUGH_FLAGS.includes(f)) {
      return bad(
        `${f} is managed by dispatch-with-liveness (fixed dispatch shape / TD-148 red line: dispatch-side wait caps kill workers — supervise via this tool's observation window instead)`,
      );
    }
  }

  return {
    help: false,
    error: null,
    values: {
      agent: flags["--agent"],
      promptFile: flags["--prompt-file"],
      cwd: flags["--cwd"],
      livenessWindowMs,
      maxRounds,
      registry: extractValueFlag(passthrough, "--registry"),
      runDir: extractValueFlag(passthrough, "--run-dir"),
    },
    passthrough,
  };
}

/** 从透传数组提取 (flag, value) 对；值缺失/像 flag → null（run 自会如实报错）。 */
function extractValueFlag(passthrough, flag) {
  const i = passthrough.indexOf(flag);
  if (i < 0) return null;
  const v = passthrough[i + 1];
  if (typeof v !== "string" || v.startsWith("--") || v.trim().length === 0) return null;
  return v;
}

/**
 * 条件③a：run_stop 证停。绑定 runId 的作用域内存在 run.stop_verified 且不存
 * 在 run.stop_unverified（transcript.js 泄漏检测同款两行判据：一条未证停事实
 * 可压掉更早的证停——fail-closed）。
 */
export function deriveStopVerified(events, runId) {
  const evs = Array.isArray(events) ? events : [];
  const bound = typeof runId === "string" && runId.length > 0
    ? evs.filter((e) => e && e.runId === runId)
    : evs;
  const verified = bound.some((e) => e.type === "run.stop_verified");
  const unverified = bound.some((e) => e.type === "run.stop_unverified");
  return verified && !unverified;
}

/**
 * auditor F3：显式未证停事实单独投影——backend 类别（进程式）只证明
 * “该类 backend 进程退出即无会话残留”这一语义，不证明“本 run 的进程已退出”。
 * 存在 run.stop_unverified 时它必须压掉 backendNoSession 臂（fail-closed）。
 */
export function deriveStopUnverified(events, runId) {
  const evs = Array.isArray(events) ? events : [];
  const bound = typeof runId === "string" && runId.length > 0
    ? evs.filter((e) => e && e.runId === runId)
    : evs;
  return bound.some((e) => e.type === "run.stop_unverified");
}

/**
 * 重派谓词（纯函数，TD-158 核心不变量）。三条件同时满足才允许重派：
 *   ① terminal       — state ∈ TERMINAL_STATES（永不重派在飞 run）
 *   ② emptyMarker    — diagnosisCode === "completed_empty"（M12-21 持久 marker，
 *                      DIAGNOSIS_CODES 闭集）或 activityEventCount === 0（零证据
 *                      空跑：无 message/command/tool_use/tool_result/file_written
 *                      任何活动）。零写入但有活动/有产出 ≠ 零证据（knsoic 锚点）。
 *   ③ workerQuiet    — stopVerified（run_stop 证停）或 backendNoSession（本地
 *                      进程式 backend，进程退出即无会话残留）
 * 证据字段缺失 → ② 的零证据臂 fail-closed 不触发（缺数据 ≠ 零证据）。
 *
 * @param {{state?: string, diagnosisCode?: string|null,
 *          evidence?: {activityEventCount?: number},
 *          stopVerified?: boolean, backendNoSession?: boolean}} runSummary
 * @returns {{redispatch: boolean, conditions: {terminal: boolean, emptyMarker: boolean, workerQuiet: boolean}, reasons: string[]}}
 */
export function shouldRedispatch(runSummary) {
  const s = runSummary && typeof runSummary === "object" ? runSummary : {};
  const reasons = [];

  const terminal = isTerminalState(s.state);
  if (!terminal) reasons.push(`condition 1 failed: not terminal (state=${JSON.stringify(s.state ?? null)})`);

  const marker = s.diagnosisCode === COMPLETED_EMPTY_MARKER;
  const activityCount = s.evidence && typeof s.evidence === "object"
    ? s.evidence.activityEventCount
    : undefined;
  const zeroActivity = activityCount === 0; // 严格整数 0；undefined/null 不算（fail-closed）
  const emptyMarker = marker || zeroActivity;
  if (!emptyMarker) {
    reasons.push(
      `condition 2 failed: no completed_empty/zero-evidence marker (diagnosisCode=${JSON.stringify(s.diagnosisCode ?? null)}, activityEventCount=${JSON.stringify(activityCount ?? null)})`,
    );
  }

  // auditor F3：显式未证停事实（run.stop_unverified）必须阻断——backend 类别是
  // 注册表层的类事实（“该类 backend 进程退出即无会话残留”），不是本 run 进程
  // 已退出的证据；终态先于 cleanup 证停写入（runManager._verifyStopQuietIfCapable），
  // 谓词可能抢在证停前跑。stopUnverified=true 时 backendNoSession 臖失效。
  const explicitUnverified = s.stopUnverified === true;
  const workerQuiet = s.stopVerified === true || (s.backendNoSession === true && !explicitUnverified);
  if (!workerQuiet) {
    reasons.push("condition 3 failed: worker not proven quiet (no bound run.stop_verified; backend not process-style/no-session, or explicit run.stop_unverified overrides the class arm)");
  }

  return {
    redispatch: terminal && emptyMarker && workerQuiet,
    conditions: { terminal, emptyMarker, workerQuiet },
    reasons,
  };
}

/**
 * 线性退避：基值 × 第 N 次重派（1-based）。round ≤ 0 钳到 1。
 * @returns {number} 延迟毫秒
 */
export function backoffDelayMs(round, baseMs = BACKOFF_BASE_MS) {
  const r = Math.max(1, Math.trunc(Number(round) || 0));
  const base = Math.max(0, Math.trunc(Number(baseMs) || 0));
  return base * r;
}

/**
 * 观察动作（红线编码为函数）：terminal → "evaluate"（进入重派谓词判定）；
 * 其余一律 "continue"（继续观察——绝不中止在飞 run，绝不重派在飞 run）。
 * 活性（progress/process_only/silent）只影响报告，不影响动作。
 */
export function observationAction({ state } = {}) {
  return isTerminalState(state) ? "evaluate" : "continue";
}

// ===== IO 区（不导出；全部事实经上方纯函数/SSOT 投影） =====

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => process.stderr.write(`[dispatch-with-liveness] ${line}\n`);

/** 与 npm run cli 同一解释器保证：本脚本已由 wao-node shim 以放行的 node 启动。 */
function assertNodeApproved() {
  const verdict = checkNodeVersion(`v${process.versions.node}`);
  if (!verdict.ok) {
    process.stderr.write(
      `dispatch-with-liveness needs an approved node (got v${process.versions.node}: ${verdict.reason}).\n` +
      "Run via: node scripts/wao-node.cjs scripts/dispatch-with-liveness.mjs ...\n",
    );
    process.exit(127);
  }
}

/**
 * 单轮派发：后台分离派发（TD-148 安全组合），不挂任何派发侧等待上限。
 * 子进程 = process.execPath（本进程即 wao-node 选定的 v22 node）直跑
 * src/cli.js——与 `npm run --silent cli --` 等价；不经 npm.cmd 是因为
 * Node 22 无 shell spawn .cmd 会 EINVAL，而 shell 拼接被任务红线禁止。
 * 返回 { ok, runId, transcript } 或 { ok:false, error }。
 */
function dispatchOnce(values, passthrough) {
  const args = [
    join(REPO_ROOT, "src", "cli.js"),
    "run", values.agent,
    "--prompt-file", values.promptFile,
    "--cwd", values.cwd,
    "--background", "--format", "json",
    ...passthrough,
  ];
  const r = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: DISPATCH_SPAWN_TIMEOUT_MS,
    windowsHide: true,
  });
  if (r.error) {
    return { ok: false, error: `dispatch spawn failed: ${r.error.message}` };
  }
  if (r.status !== 0) {
    const tail = String(r.stderr ?? "").trim().split(/\r?\n/).slice(-5).join("\n");
    return { ok: false, error: `dispatch exited ${r.status}:\n${tail}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(r.stdout ?? "").trim());
  } catch {
    return { ok: false, error: `dispatch stdout is not JSON:\n${String(r.stdout ?? "").trim().slice(0, 400)}` };
  }
  if (parsed && parsed.terminalAccepted === false) {
    return { ok: false, error: `dispatch not accepted (transcript already terminal: ${parsed.terminalState ?? "?"}) runId=${parsed.runId ?? "?"}` };
  }
  if (!parsed || typeof parsed.runId !== "string" || parsed.background !== true) {
    return { ok: false, error: `unexpected dispatch output shape: ${JSON.stringify(parsed).slice(0, 400)}` };
  }
  return { ok: true, runId: parsed.runId, transcript: parsed.transcript };
}

/**
 * 观察直至终态。观察窗（livenessWindowMs）到期只结束本窗观察并打印
 * summarizeLiveness SSOT 的活性摘要，随后开新窗——绝不 abort、绝不 stop。
 * 返回终态时刻的事件快照（供谓词组装）。
 */
async function observeUntilTerminal(runId, runDir, windowMs) {
  const transcriptPath = join(runDir, `${runId}.jsonl`);
  let events = [];
  // 后台派发 JSON 打印时 transcript 已创建；仍留短重试防御启动竞态。
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      events = await readTranscript(transcriptPath);
      break;
    } catch (error) {
      if (attempt === 9) throw error;
      await sleep(1000);
    }
  }
  let baseline = findLastEventSeq(events) ?? 0;

  for (;;) {
    const deadline = Date.now() + windowMs;
    let state = findState(boundReportScope(events, runId) ?? events);
    let readFailedNotified = false;
    while (!isTerminalState(state)) {
      await sleep(POLL_INTERVAL_MS);
      try {
        events = await readTranscript(transcriptPath);
        readFailedNotified = false;
      } catch {
        if (!readFailedNotified) {
          log(`observe ${runId}: transcript read failed (retrying each poll; worker untouched)`);
          readFailedNotified = true;
        }
      }
      state = findState(boundReportScope(events, runId) ?? events);
      if (isTerminalState(state)) break;
      if (Date.now() >= deadline) break;
    }
    if (isTerminalState(state)) return events;

    const liv = summarizeLiveness({
      events, runDir, runId,
      activityBaseline: baseline,
      now: Date.now(),
    });
    log(
      `observe ${runId}: state=${state} liveness=${liv.liveness} ` +
      `(window events=${JSON.stringify(liv.activityEventCount)} last=${JSON.stringify(liv.lastActivityKind)} owner=${liv.ownerHeartbeat}) ` +
      "— in-flight, keep observing (never abort in-flight runs)",
    );
    baseline = findLastEventSeq(events) ?? baseline;
  }
}

/** 组装谓词输入：全部字段经 src SSOT 投影（diagnoseFailure / assessRunEvidence / deriveStopVerified）。 */
function collectRunSummary(events, runId, backendNoSession) {
  const scope = boundReportScope(events, runId) ?? events;
  const state = findState(scope);
  const diagnosis = diagnoseFailure(events, runId);
  const evidence = assessRunEvidence(scope);
  return {
    runId,
    state,
    terminal: isTerminalState(state),
    diagnosisCategory: diagnosis.category,
    diagnosisCode: diagnosis.code,
    evidence: {
      activityEventCount: evidence.activityEventCount,
      evidenceEventCount: evidence.evidenceEventCount,
      fileWrittenCount: evidence.fileWrittenCount,
      commandExit0Count: evidence.commandExit0Count,
      assistantTextCount: evidence.assistantTextCount,
    },
    stopVerified: deriveStopVerified(events, runId),
    stopUnverified: deriveStopUnverified(events, runId),
    backendNoSession,
  };
}

/** registry 读取失败/未知 agent → false（条件③ fail-closed：只剩证停一臂）。 */
async function resolveBackendNoSession(registryPath, agentId) {
  try {
    const registry = await readRegistry(registryPath);
    const agent = registry.getAgent(agentId);
    return PROCESS_BACKEND_IDS.includes(agent?.backend);
  } catch {
    return false;
  }
}

/**
 * auditor F4：监督主循环提取为可注入纯编排函数（不 process.exit、不真 I/O——
 * 副作用全部经参数注入 dispatchRound/observeRound/sleepFn/logLine/collectSummary）。
 * 返回 {outcome, lastSummary, exitCode}——exit 语义与 finish 契约一致：
 * 真完成（completed 且非空跑）=0；失败/谓词不满足/轮次耗尽 =1。
 */
export async function supervisionLoop({
  maxRounds,
  agent,
  dispatchRound,
  observeRound,
  backendNoSession,
  collectSummary = null,
  sleepFn = () => Promise.resolve(),
  logLine = () => {},
}) {
  let lastSummary = null;
  for (let round = 1; round <= maxRounds; round += 1) {
    if (round > 1) {
      const delay = backoffDelayMs(round - 1);
      logLine(`backoff ${Math.round(delay / 1000)}s before round ${round}/${maxRounds}`);
      await sleepFn(delay);
    }
    const dispatch = await dispatchRound(round);
    if (!dispatch.ok) {
      logLine(`round ${round}/${maxRounds}: ${dispatch.error}`);
      return { outcome: "dispatch_failed", lastSummary, exitCode: 1 };
    }
    logLine(`round ${round}/${maxRounds}: dispatched ${dispatch.runId} (${agent}, background)`);
    const events = await observeRound(dispatch.runId);
    const summary = collectSummary
      ? collectSummary(events, dispatch.runId)
      : { backendNoSession, ...events };
    lastSummary = summary;
    const verdict = shouldRedispatch(summary);
    logLine(
      `round ${round}/${maxRounds}: ${summary.runId} state=${summary.state} ` +
        `quiet=${summary.stopVerified ? "stop_verified" : (summary.backendNoSession && summary.stopUnverified !== true ? "process_no_session" : "no")} ` +
        `→ ${verdict.redispatch ? "redispatch" : "stop"}`,
    );
    if (!verdict.redispatch) {
      // 如实退出：真完成（completed 且非空跑）= 0；其余（失败/空跑但不满足谓词）= 1。
      const completedWithWork = summary.state === "completed" && !verdict.conditions.emptyMarker;
      return { outcome: "no_redispatch", lastSummary, exitCode: completedWithWork ? 0 : 1 };
    }
  }
  logLine(`max rounds (${maxRounds}) reached — giving up honestly`);
  return { outcome: "max_rounds_reached", lastSummary, exitCode: 1 };
}

async function main() {
  assertNodeApproved();
  const parsed = parseDispatchArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (parsed.error) {
    process.stderr.write(`dispatch-with-liveness: ${parsed.error}\n\n${USAGE}\n`);
    process.exit(2);
  }
  const { values, passthrough } = parsed;
  if (!existsSync(values.promptFile)) {
    process.stderr.write(`dispatch-with-liveness: --prompt-file not found: ${values.promptFile}\n`);
    process.exit(2);
  }

  const runDir = resolve(REPO_ROOT, values.runDir ?? "runs");
  const registryPath = resolve(REPO_ROOT, values.registry ?? "config/agents.json");
  const backendNoSession = await resolveBackendNoSession(registryPath, values.agent);
  if (!backendNoSession) {
    log(`backend for ${values.agent} is not process-style/no-session (or registry unreadable) — condition 3 will require run.stop_verified`);
  }

  process.on("SIGINT", () => {
    process.stderr.write(
      "\n[dispatch-with-liveness] interrupted — supervisor only; any dispatched run keeps its detached runner. Supervise with `runs wait <runId>`.\n",
    );
    process.exit(130);
  });

  const result = await supervisionLoop({
    maxRounds: values.maxRounds,
    agent: values.agent,
    dispatchRound: () => dispatchOnce(values, passthrough),
    observeRound: (runId) => observeUntilTerminal(runId, runDir, values.livenessWindowMs),
    backendNoSession,
    collectSummary: (events, runId) => collectRunSummary(events, runId, backendNoSession),
  });
  finish(result.outcome, result.lastSummary, result.exitCode);
}

function finish(outcome, lastRun, code) {
  const final = {
    tool: "dispatch-with-liveness",
    td: "TD-158",
    outcome,
    lastRun,
    exitCode: code,
  };
  process.stdout.write(`${JSON.stringify(final, null, 2)}\n`);
  process.exit(code);
}

// 直接运行守卫：被测试 import 时不执行 main。
const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`dispatch-with-liveness: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
