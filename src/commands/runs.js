// src/commands/runs.js
//
// TD-98 阶段 2b：runs command family 从 cli.js 拆出（行为不变，纯搬迁）。
//
// 命令族：runs list / summary / prune / grep / metrics / scorecard /
//         dashboard / diagnose / delivery / wait
//
// 依赖：
//   - 外部模块：../transcript.js（readTranscript/findState）、../metrics.js
//     （aggregateRunMetrics/aggregateSummary/formatDuration）、../diagnosis.js
//     （diagnoseFailure）、../waoDir.js
//     （getWaoDir）、../waoDeclare.js（summarizeDeclares）、../waoStage.js
//     （summarizeStages）
//   - 共享 service：../application/runWait.js（runs wait 与 MCP run_wait 同一
//     等待服务）、../application/runSemanticsNotes.js（semanticNotes 同一 selector）
//   - 共享工具：./shared.js（parseOptions/resolveTargetCwd，纯函数）
//   - node built-in：fs/promises（readdir/unlink/mkdir/rename/stat）、fs
//     （existsSync）、path（join/resolve/dirname）
//
// 本模块内部 helper：parseDuration（runs prune --older-than 与 runs list
// --since 共用的唯一 duration 解析器，TD-153 提为导出）、loadRunFiles（runs 族
// 专用）、archiveMonthFromTs/mtimeMonth（runs prune --archive 专用，R23-B1）。

import { readdir, unlink, readFile, mkdir, rename, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

import { readTranscript, findState, findFirstBound, TERMINAL_STATES, REVERIFY_FAILURE_CODES } from "../transcript.js";
import { aggregateRunMetrics, aggregateSummary, formatDuration, boundReportScope } from "../metrics.js";
// R18 (TD-128c 同类)：runs metrics/scorecard 的 runId join 前校验复用 delivery.js
// isValidRunId SSOT（与 commands/shared.js loadRun 同款接线；delivery.js 是底层
// 模块——commands → core 下向边，无环）。
import { isValidRunId } from "../delivery.js";
import { diagnoseFailure } from "../diagnosis.js";
// M9-5A: diagnosis delegated to shared application service.
import { getRunDiagnosis } from "../application/runDiagnosis.js";
// M9-6A: delivery query/decision delegated to shared application services.
// M11-10: readiness/wait delegated to the SAME shared service the MCP tool uses.
import {
  getRunDelivery,
  decideRunDelivery,
  getRunDeliveryReadiness,
  DELIVERY_WAIT_MS_MIN,
  DELIVERY_WAIT_MS_MAX,
} from "../application/runDelivery.js";
// M11-3C: delivery review projection delegated to shared application service.
import { getRunDeliveryReview } from "../application/runDeliveryReview.js";
// F5 (2026-10-08): typed cursor-rejection signal (run_activity M12-19 定义、
// runDeliveryReview 解码路径改抛的同一类)——CLI 在此折叠为专属文案。
import { CursorRejectedError } from "../application/runActivityProjection.js";
// M12-6 FR-07 closeout: audited unchanged-artifact reverify delegated to the SAME
// application service the MCP run_delivery_reverify tool uses. The CLI never
// re-implements the algorithm, never parses the transcript, and never copies
// boundary constants — every bound below is the service export.
import {
  runDeliveryReverify,
  REVERIFY_REASONS,
  REVERIFY_SETUP_COMMANDS_LIMIT,
  REVERIFY_SETUP_COMMAND_MAX_LENGTH,
  REVERIFY_TIMEOUT_MS_MIN,
  REVERIFY_TIMEOUT_MS_MAX,
} from "../application/runDeliveryReverify.js";
import {
  runVerifyCommit,
  LEAD_COMMIT_CHECK_STATUSES,
  LEAD_COMMIT_CHECK_CLEANUP_STATUSES,
  VERIFY_COMMIT_TIMEOUT_MS_MIN,
  VERIFY_COMMIT_TIMEOUT_MS_MAX,
} from "../application/runVerifyCommit.js";
import { createHash } from "node:crypto";
import { getWaoDir } from "../waoDir.js";
import { summarizeDeclares } from "../waoDeclare.js";
import { summarizeStages } from "../waoStage.js";
// R23-F/B Round B (TD-130): `runs gate` 出口——同机验证串行化闸的只读查询与
// 人工破锁。commands → core 下向边（与 runs delivery → runDeliveryReverify 同向）。
import {
  VERIFICATION_GATE_OFF_ENV,
  createVerificationGate,
  gateDisabled,
  gateEngaged,
} from "../verificationGate.js";
import { verificationLeasePath } from "../machineGatePaths.js";
import { parseOptions, resolveTargetCwd } from "./shared.js";
// TD-109: `runs wait` delegates to the SAME liveness-aware wait service the
// MCP run_wait tool uses, and attaches notes via the SAME semanticNotes
// selector — no copied algorithm, no copied catalog.
import { runWait, RUN_WAIT_DEFAULT_MS } from "../application/runWait.js";
import { selectSemanticNotes } from "../application/runSemanticsNotes.js";
// M12-8D: `runs dashboard --web` reuses the ownerDashboardServer boundary (which
// reuses the SINGLE application SSOTs — no second parser/classifier/redactor).
// Shared workspace authority (proveWorkspace) + registry IDs (readRegistry).
import { createOwnerDashboardServer } from "../ownerDashboardServer.js";
import { proveWorkspace } from "../application/workspaceBinding.js";
import { readRegistry } from "../registry.js";

// TD-109: the full legal subcommand set of `runs`. `list` was previously only
// reachable through the silent fallthrough; it is now an explicit branch so the
// fail-closed unknown-subcommand error below cannot swallow it.
// TD-200③（2026-10-02）：导出供 docs-consistency 的 MCP↔CLI 映射表守卫派生核对
// （docs/usage.md 映射表是手写值指纹——TD-120 家族，必须绑定断言防静默腐烂）。
// TD-240（2026-10-08）：`verify-commit`——采纳协议承载命令（Lead 侧归因 +
// 集成后终验执行；不满足独立审计证据规格，见 docs/usage.md 采纳协议节）。
export const RUNS_SUBCOMMANDS = [
  "list", "summary", "prune", "grep", "metrics", "scorecard",
  "dashboard", "diagnose", "delivery", "wait", "gate", "verify-commit",
];

async function runsCommand(args, config, deps) {
  const [sub, ...tail] = args;
  if (sub === "list") {
    await runsListCommand(args, config);
    return;
  }
  if (sub === "summary") {
    await runsSummaryCommand(tail, config);
    return;
  }
  if (sub === "prune") {
    await runsPruneCommand(tail, config);
    return;
  }
  if (sub === "grep") {
    await runsGrepCommand(tail, config);
    return;
  }
  if (sub === "metrics") {
    await runsMetricsCommand(tail, config);
    return;
  }
  if (sub === "scorecard") {
    await runsScorecardCommand(tail, config);
    return;
  }
  if (sub === "dashboard") {
    await runsDashboardCommand(tail, config);
    return;
  }
  if (sub === "diagnose") {
    await runsDiagnoseCommand(tail, config);
    return;
  }
  if (sub === "delivery") {
    await runsDeliveryCommand(tail, config);
    return;
  }
  if (sub === "wait") {
    await runsWaitCommand(tail, config, deps);
    return;
  }
  if (sub === "gate") {
    await runsGateCommand(tail, config, deps);
    return;
  }
  if (sub === "verify-commit") {
    await runsVerifyCommitCommand(tail, config, deps);
    return;
  }
  if (sub === "forecast") {
    throw new Error("runs forecast has been removed; use observed run facts instead of token estimates");
  }
  // Bare `runs` — no subcommand (undefined / empty token / flags-only) — keeps
  // the legacy list fallthrough byte-for-byte (TD-109 backward compat).
  if (sub === undefined || sub === "" || sub.startsWith("--")) {
    await runsListCommand(args, config);
    return;
  }
  // TD-109 fail-closed: an unknown non-empty subcommand used to silently fall
  // through to the run list and exit 0. It now throws a fixed error naming
  // every legal subcommand so a typo (e.g. `runs waitx`) cannot masquerade as
  // a successful command.
  throw new Error(
    `unknown runs subcommand: ${sub} (valid subcommands: ${RUNS_SUBCOMMANDS.join(", ")})`,
  );
}

// TD-109: strict flag set for `runs wait`. Unknown flags are rejected so a
// typo'd flag cannot silently produce wrong output (same discipline as
// runs delivery review / reverify).
const RUNS_WAIT_KNOWN_FLAGS = new Set(["--wait-ms", "--format", "--run-dir"]);

/**
 * TD-109: `runs wait <runId> [--wait-ms N] [--format json|text] [--run-dir DIR]`
 *
 * Read-only bounded long-poll. Delegates to the SAME runWait application
 * service the MCP run_wait tool uses — the CLI never re-implements the
 * wait/liveness/observation algorithm and never copies boundary constants.
 * The CLI owns only:
 *   - strict argv parsing (flag-aware positional walk)
 *   - --wait-ms Number() coercion — the SERVICE stays the boundary validator,
 *     so its exact error text reaches the user unmodified. The ONE exception
 *     (D1-D3 closeout, Bug-2): a non-numeric value (NaN after coercion) is
 *     rejected at the CLI with the fixed "--wait-ms must be a number" — NaN
 *     would reach the service as "got: null", hiding the real problem.
 *   - text/JSON rendering (JSON = full service result + semanticNotes via the
 *     SAME selector + facts shape as the MCP run_wait handler)
 *   - SIGINT: print the last known point-in-time snapshot, exit non-zero
 *
 * No authorizedWorkspaceRoot is passed (CLI is human/ops — it does not bind a
 * workspace; same convention as runs list / stop).
 *
 * Window expiry (terminal:false) is a NORMAL outcome: print, exit 0.
 *
 * @param {string[]} args — everything after `runs wait`
 * @param {object} config
 * @param {object} [deps] — { runWaitFn } service injection for testing
 */
async function runsWaitCommand(args, config, deps = {}) {
  const seenFlags = new Set();
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (!RUNS_WAIT_KNOWN_FLAGS.has(a)) throw new Error(`unknown flag for runs wait: ${a}`);
      if (seenFlags.has(a)) throw new Error(`${a} specified multiple times`);
      seenFlags.add(a);
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} requires a value`);
      if (v.trim().length === 0) throw new Error(`${a} must be non-empty`);
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      flags[key] = v;
      i += 1;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length !== 1) {
    throw new Error("runs wait requires exactly one <runId>");
  }
  const runId = positionals[0];
  if (flags.format !== undefined && flags.format !== "json" && flags.format !== "text") {
    throw new Error("--format only supports json|text");
  }
  const asJson = flags.format === "json";
  const runDir = resolve(flags.runDir ?? config.runDir);

  // CLI only coerces; the service is the shared business boundary and throws
  // its own exact error for out-of-range / non-integer values (not reworded).
  // D1-D3 终审收口（Bug-2）: a NON-NUMERIC value (Number() → NaN) is rejected
  // HERE with a fixed safe message — passing NaN through would make the service
  // report "got: null" (JSON.stringify(NaN)), losing the fact that the user's
  // input was not a number at all. Out-of-range / non-integer numbers still go
  // to the service so its exact boundary text reaches the user unmodified.
  let waitMs = RUN_WAIT_DEFAULT_MS;
  if (flags.waitMs !== undefined) {
    waitMs = Number(flags.waitMs);
    if (Number.isNaN(waitMs)) throw new Error("--wait-ms must be a number");
  }

  const service = deps.runWaitFn ?? runWait;

  // SIGINT (Ctrl-C during the blocking window): print the last known
  // point-in-time observation, then exit non-zero (tail --follow precedent,
  // observe.js). The snapshot reuses the SAME readTranscript/findState SSOT
  // AND the same runId-bound filter the service polls with (R19 bound the
  // service's state projection; R20-C closed the gap where this snapshot was
  // still unbound — the "same SSOT" claim above is true again) — no second
  // parser; a read failure degrades to state "unknown" rather than crashing
  // the interrupt path.
  const transcriptPath = join(runDir, `${runId}.jsonl`);
  const onSigint = () => {
    void (async () => {
      let state = "unknown";
      let terminal = false;
      try {
        const events = await readTranscript(transcriptPath);
        // R20-C（TD-128 W2 同族）：中断快照的状态投影绑定到请求 runId（与
        // service R19 初始读/poll 同一过滤形状）——外 run 伪终态尾条不再把
        // 中断快照翻成终态。legacy 全无信封 → findState([])="pending"（与
        // service 同一降级，不可归属永不投影为终态）。
        state = findState(events.filter((e) => e && e.runId === runId));
        terminal = TERMINAL_STATES.includes(state);
      } catch { /* keep the fail-soft unknown snapshot */ }
      if (asJson) {
        console.log(JSON.stringify({ runId, state, terminal, interrupted: true }, null, 2));
      } else {
        console.log(`Run: ${runId} (${state})`);
        console.log(`Terminal: ${terminal ? "yes" : "no"}`);
        console.log("(interrupted before the observation window completed)");
      }
      process.exit(1);
    })();
  };
  process.on("SIGINT", onSigint);
  let result;
  try {
    result = await service({ runId, runDir, waitMs });
  } finally {
    process.off("SIGINT", onSigint);
  }

  if (asJson) {
    // Same selector and facts shape as the MCP run_wait handler — no copied
    // catalog, no adapted semantics.
    const semanticNotes = selectSemanticNotes("run_wait", {
      observationOutcome: result.observationOutcome,
      outcome: result.observation?.outcome,
      terminal: result.terminal,
      terminationSource: result.termination?.source ?? null,
    });
    console.log(JSON.stringify({ ...result, semanticNotes }, null, 2));
    return;
  }
  console.log(`Run: ${result.runId} (${result.state})`);
  console.log(`Terminal: ${result.terminal ? "yes" : "no"}`);
  console.log(`Waited: ${result.observation?.waitedMs ?? 0} ms (window ${result.observation?.windowMs ?? waitMs} ms)`);
  console.log(`Liveness: ${result.liveness}`);
  console.log(`Observation: ${result.observationOutcome}${result.observation ? ` (${result.observation.outcome})` : ""}`);
  // TD-137②：窗口到期（非终态）时服务附带同族上限交叉提示——追加一行，不
  // 改动既有五行结构（runsWait.test.js 的行序锚点保持稳定）。
  if (result.waitWindowHint) {
    console.log(`Hint: ${result.waitWindowHint}`);
  }
}

// R23-F/B Round B (TD-130): strict flag set for `runs gate`（runs wait 同纪律：
// 未知 flag 拒绝，typo 不能静默产生错误输出）。
const RUNS_GATE_KNOWN_FLAGS = new Set(["--format", "--release"]);

/**
 * R23-F/B Round B (TD-130): `runs gate [--format json|text] [--release]`
 *
 * 同机验证串行化闸（verification lease）的运维出口：
 *   - 默认只读查询：free / held（持有者身份齐备）/ corrupt 三态 + kill switch
 *     是否激活。绝不认领、绝不释放——查询不改变闸状态。
 *   - `--release`：人工玻璃破断（breakLock）。文档化的手动场景是"确认没有验证
 *     在跑但租约残留"（如进程被强杀后 STALE_MS 内的等待窗口想立刻清掉）。
 *     破除失败 fail-closed 非零退出；本就无锁是正常结果、如实告知。
 *
 * 闸本体是机器级的（verificationLeasePath()），与 --run-dir 无关。
 *
 * @param {string[]} args — everything after `runs gate`
 * @param {object} config — unused here (machine-global scope); kept for signature parity
 * @param {object} [deps] — { createGate } injection for testing
 */
async function runsGateCommand(args, config, deps = {}) {
  const flags = {};
  const positionals = [];
  let release = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (!RUNS_GATE_KNOWN_FLAGS.has(a)) throw new Error(`unknown flag for runs gate: ${a}`);
      if (a === "--release") {
        if (release) throw new Error(`${a} specified multiple times`);
        release = true;
        continue;
      }
      if (flags[a] !== undefined) throw new Error(`${a} specified multiple times`);
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} requires a value`);
      if (v.trim().length === 0) throw new Error(`${a} must be non-empty`);
      flags[a] = v;
      i += 1;
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length > 0) {
    throw new Error("runs gate takes no positional arguments");
  }
  if (flags["--format"] !== undefined && flags["--format"] !== "json" && flags["--format"] !== "text") {
    throw new Error("--format only supports json|text");
  }
  const asJson = flags["--format"] === "json";

  // 入闸判定对用户可见：engaged=false 说明本进程即使跑验证也不会排队
  // （kill switch 关闭或处于 HELD 继承环境）。
  const engaged = gateEngaged();
  const createGate = deps.createGate
    ?? (() => createVerificationGate({ identity: { owner: "cli/runs-gate" } }));
  const gate = createGate();

  if (release) {
    const result = await gate.breakLock();
    if (result.hadLock && !result.released) {
      throw new Error(
        `runs gate --release: failed to remove the verification lease at ${verificationLeasePath()} `
        + "(file may be locked/permission-denied); resolve manually and retry",
      );
    }
    if (asJson) {
      console.log(JSON.stringify({ engaged, release: result }, null, 2));
      return;
    }
    console.log(result.hadLock
      ? "Verification lease released (manual break-lock)."
      : "No verification lease present; nothing to release.");
    const gateOff = gateDisabled(process.env);
    console.log(engaged ? "gate: engaged" : gateOff ? `kill switch: active (${VERIFICATION_GATE_OFF_ENV}=off)` : "gate: disengaged (verification subprocess inherits HELD — this lane does not contend)");
    return;
  }

  const lease = await gate.status();
  if (asJson) {
    console.log(JSON.stringify({ engaged, lease }, null, 2));
    return;
  }
  if (lease.free) {
    console.log("Verification gate: free (no lease)");
  } else if (lease.corrupt) {
    console.log(`Verification gate: LEASE CORRUPT (unparseable record at ${verificationLeasePath()})`);
  } else {
    console.log("Verification gate: held");
    const h = lease.holder ?? {};
    const who = ["owner", "runId", "sessionId", "agentId"]
      .map((k) => (typeof h[k] === "string" && h[k].length > 0 ? h[k] : null))
      .filter(Boolean)
      .join(" / ");
    console.log(`Holder: ${who || "(unidentified)"}`);
    console.log(`Holder pid: ${h.pid ?? "unknown"} | startedAt: ${h.startedAt ?? "unknown"} | heartbeat age: ${h.ageMs ?? "?"} ms`);
  }
  const gateOff = gateDisabled(process.env);
  console.log(engaged ? "gate: engaged" : gateOff ? `kill switch: active (${VERIFICATION_GATE_OFF_ENV}=off)` : "gate: disengaged (verification subprocess inherits HELD — this lane does not contend)");
}

// TD-153(d2): runId/wf id 的内嵌时间戳前缀（`run_`/`wf_` + 固定宽 17 位 UTC
// 毫秒时间戳，generateRunId/workflow.js 同款 SSOT 格式）。
const RUN_FILE_TS_RE = /^(?:run|wf)_(\d{17})/;

/**
 * TD-153(d2): 单个 runDir 文件名的时间戳排序键（无时间戳前缀 → null）。纯函数。
 */
export function runFileTimestampKey(name) {
  const m = name.match(RUN_FILE_TS_RE);
  // auditor F2：17 位毫秒时间戳超 Number.MAX_SAFE_INTEGER（≈9.007e15 < 2.026e16），
  // Number 化丢低位精度——相邻毫秒会碰撞后落回字典序（wf_/run_ 形状前缀序错位）。
  // 固定宽 17 位数字串的字典序 ≡ 数值序，直接返回字符串比较。
  return m ? m[1] : null;
}

/**
 * TD-153(d2): runs grep/prune 的输出序 SSOT。
 *
 * 评估结论：裸字典序 `.sort()` 对单一形状前缀的标准 id（等宽 17 位数字时间
 * 戳）恰好等于创建序——但它把两类文件放错位：自定义 runId（派发可指定，仅
 * 字母数字校验、无时间戳保证）落在与创建时间无关的字典序位置；run_* 与
 * wf_* 按形状前缀分组而非按时间交错。修法（最小、无大重构）：按时间戳前缀数值升序
 * （=创建序，run_* 与 wf_* 按时间交错）；无时间戳前缀的文件殿后、彼此保持字典
 * 序；同毫秒并列回退字典序决胜。纯 run_* 标准语料下与旧 `.sort()` 同序
 * （等宽数字串的数值比较 ≡ 字典序）；wf_* 混入时从"形状前缀分组"变为时间
 * 交错、自定义 id 从任意字典序位变为殿后——正是要修的错位。
 *
 * 导出供测试做纯函数验证（零 fs 依赖）。list/summary/metrics/dashboard 不经
 * 此序（各自按 updatedAt 等重排），消费面只有 grep/prune 的输出行序。
 */
export function sortRunFileNames(names) {
  return [...names].sort((a, b) => {
    const ta = runFileTimestampKey(a);
    const tb = runFileTimestampKey(b);
    if (ta !== null && tb !== null && ta !== tb) return ta < tb ? -1 : 1; // 等宽 17 位数字串比较（F2 修复）
    if (ta !== null && tb === null) return -1; // 有时间戳在前，无时间戳殿后
    if (ta === null && tb !== null) return 1;
    return a < b ? -1 : a > b ? 1 : 0; // 并列/双双无时间戳：字典序决胜（总序，跨平台确定）
  });
}

async function loadRunFiles(runDir) {
  if (!existsSync(runDir)) return [];
  const files = await readdir(runDir);
  return sortRunFileNames(files.filter((f) => f.endsWith(".jsonl")));
}

/**
 * TD-102: 只加载 run_*.jsonl（排除 wf_* workflow transcript）。
 * list/summary/metrics --summary/dashboard 使用此函数——
 * workflow transcript 不是 worker run，不应计入 run 聚合。
 * grep/prune 保持 loadRunFiles（所有 .jsonl）。
 */
async function loadRunOnlyFiles(runDir) {
  const files = await loadRunFiles(runDir);
  return files.filter((f) => f.startsWith("run_"));
}

/**
 * M8-2 实时仪表盘聚合（🟢 工具域：纯只读聚合，绝不 retry/stop/改状态）。
 *
 * 把散落在多个 run transcript 里的状态/token/费用/证据聚合成单一视图，省 Lead
 * 在 status/tail/collect/metrics 四个命令间轮询的精力与 token。
 *
 * @param {Array<{runId, events}>} runs - 每个 run 的 runId + 已解析的事件数组。
 * @returns {{rows, summary}} rows 每行含 runId/agentId/state/tokens/costUsd/flagged/ageMs；
 *   summary 含 total/byState/totalCost/running/flagged。
 *
 * flagged（异常标红，提示 Lead 关注，不替 Lead 行动）：
 *   - failed / timed_out
 *   - completed 但 scorecard.warn 无证据（与 M8-1 默认 warn 联动）
 */
export function buildDashboard(runs, selfDeclared = null, stageProgress = null) {
  const rows = runs.map(({ runId, events }) => {
    const agentId = events[0]?.agentId ?? "(unknown)";
    // R20 (TD-128 M3)：dashboard 行的 state/tokens/cost/evidence 读取经
    // boundReportScope 收窄到行 runId 的信封绑定事件——外 run 伪终态/伪
    // metrics/伪 scorecard 尾条不再标红或污染仪表盘行（flagged 由绑定后的
    // state 派生，同受保护）。legacy 全无信封 transcript 保持历史读法
    // （cli.test.js M8-2 系列既有契约）。agentId/ageMs 不在本轮锚点。
    const scope = boundReportScope(events, runId) ?? events;
    const state = findState(scope);
    const metricsEv = scope.find((e) => e.type === "run.metrics");
    const tokens = metricsEv?.tokens ?? {};
    const costUsd = typeof metricsEv?.costUsd === "number" ? metricsEv.costUsd : undefined;

    // 证据：scorecard.checked.passed === true → 有证据；否则看 warn 事件判定。
    const scChecked = scope.find((e) => e.type === "scorecard.checked");
    const hasWarn = scope.some((e) => e.type === "scorecard.warn");
    const evidence = scChecked ? (scChecked.passed ? "✓" : (hasWarn ? "⚠" : "✗")) : "-";

    // age：从首个事件 ts 到最后一个事件 ts 的时长（ms）；无 ts → undefined。
    const firstTs = events[0]?.ts;
    const lastTs = events.at(-1)?.ts;
    let ageMs;
    if (firstTs && lastTs) {
      const a = new Date(firstTs).getTime();
      const b = new Date(lastTs).getTime();
      if (!Number.isNaN(a) && !Number.isNaN(b)) ageMs = b - a;
    }

    // flagged：终态异常 / completed 但 scorecard warn 无证据（M8-1 联动）。
    let flagged = false;
    if (state === "failed" || state === "timed_out") flagged = true;
    if (state === "completed" && hasWarn) flagged = true;

    return { runId, agentId, state, tokens, costUsd, evidence, ageMs, flagged };
  });

  const byState = {};
  let totalCost = 0;
  let running = 0;
  let flagged = 0;
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
    if (row.state === "running") running += 1;
    if (typeof row.costUsd === "number") totalCost += row.costUsd;
    if (row.flagged) flagged += 1;
  }

  return {
    rows,
    summary: {
      total: rows.length,
      byState,
      totalCost,
      running,
      flagged,
      // TD-82：Lead 自做声明（曝光机制——让"没派工"对用户可见）。
      // selfDeclared 来自 .wao/pipeline/ 的 DECL- 文件（runsDashboardCommand 注入），
      // 不是 run events——WAO 看不见 Lead 的非 WAO 工具调用，只能靠 Lead 主动声明。
      selfDeclared: selfDeclared ?? { count: 0, byReason: {} },
      // TD-83：Lead 阶段声明（pipeline 进度曝光——让"跳过 spec/plan/汇总/总结"对用户可见）。
      // stageProgress 来自 .wao/pipeline/ 的 STAGE- 文件（runsDashboardCommand 注入）。
      // declared 是已声明阶段号的 Set，count 是已声明阶段数。
      stageProgress: stageProgress ?? { declared: [], count: 0 },
    },
  };
}

async function runsListCommand(args, config) {
  const options = parseOptions(args);
  const runDir = resolve(options.runDir ?? config.runDir);
  const { listRuns } = await import("../application/runList.js");

  const latestN = options.latest ? Number(options.latest) : null;

  // TD-153: --state <v> / --since <duration> map 1:1 onto listRuns service
  // inputs (stateFilter / sinceMs). The SERVICE is the boundary validator for
  // the state closed set and the --active × --state conflict, so its exact
  // error text reaches the user unmodified (same convention as runs wait
  // --wait-ms). The CLI owns only the parseOptions shapes the service cannot
  // express: a value-less flag parses to literal `true` — reject it here
  // rather than letting a bare flag silently list everything.
  if (options.state === true) {
    throw new Error("--state requires a value (e.g. --state failed)");
  }
  if (options.since === true) {
    throw new Error("--since requires a duration value (e.g. 7d, 24h, 30m)");
  }
  // Same duration parser as prune --older-than (the ONE parser, promoted to a
  // named export for exactly this reuse). The direction inversion is by
  // construction: prune selects runs OLDER than the window, --since keeps
  // runs FRESH within it.
  const sinceMs = options.since !== undefined ? parseDuration(options.since) : undefined;

  // CLI is human/ops — no workspace authorization.
  // knownAgentIds = [] so raw agentId is preserved (CLI doesn't validate).
  const result = await listRuns({
    runDir,
    agentId: options.agent,
    latest: latestN,
    knownAgentIds: [],
    validateAgentIds: false, // CLI preserves raw agentId
    // TD-153(c): --active passthrough to the service-side activeOnly filter
    // (proven-active ONLY: fresh owner heartbeat required; terminal/unknown/
    // unresolved runs are excluded — it is not a "non-terminal" filter).
    // parseOptions shapes: bare `--active` → true; `--active <value>` →
    // string. Only an explicit true/"true" engages the filter — silently
    // narrowing the listing is worse than silently ignoring a value, so
    // "false"/other values do NOT engage it.
    activeOnly: options.active === true || options.active === "true",
    // TD-153: closed-set state filter + freshness window (service-validated;
    // see above). Orthogonal to --agent/--latest and to each other.
    stateFilter: options.state,
    sinceMs,
  });

  // TD-137①：裸 `runs list` 不再恢复文件名升序——直接沿用 listRuns 的默认
  // updatedAt desc（最新优先，null 最后、runId 升序决胜）。--latest N 的截取
  // 语义不变；MCP runs_list 走同一服务投影，不受 CLI 本层影响。

  // TD-86（D2 A1）：--format json 直接序列化 listRuns 结果（服务默认排序），
  // 零新计算；空结果也输出 {runs:[], matchedCount:0} 而非 "No runs found." 文本。
  if (options.format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.runs.length === 0) {
    const jsonlFiles = await loadRunOnlyFiles(runDir);
    if (jsonlFiles.length === 0) {
      console.log("No runs found.");
      return;
    }
    console.log(options.agent ? `No runs found for agent "${options.agent}".` : "No runs found.");
    return;
  }

  for (const s of result.runs) {
    console.log(`${s.runId}\t${s.state}`);
  }
}

async function runsSummaryCommand(args, config) {
  // TD-200②（2026-10-02 前置盘点收口）：位置参数 fail-closed——`runs summary
  // <runId>` 曾静默无视 runId 输出全局统计（子命令名暗示单 run 查询，误导
  // 监督判断）。合法形状 = 仅 flags。
  const knownValueFlags = new Set(["--format", "--run-dir"]);
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (knownValueFlags.has(a)) i += 1;
      continue;
    }
    throw new Error(
      `runs summary is a global-tally command and takes no <runId> (got: ${a}) `
      + "— single-run queries: runs diagnose <runId> / runs wait <runId> / runs metrics <runId>",
    );
  }
  const options = parseOptions(args);
  const runDir = resolve(options.runDir ?? config.runDir);
  const jsonlFiles = await loadRunOnlyFiles(runDir);
  if (jsonlFiles.length === 0) {
    // TD-86（D2 A1）：空目录在 JSON 模式输出结构化零结果，text 路径不变。
    if (options.format === "json") {
      console.log(JSON.stringify({ total: 0, byState: {}, latest: null }, null, 2));
      return;
    }
    console.log("No runs found.");
    return;
  }
  const counts = {};
  let latestTs = null;
  for (const file of jsonlFiles) {
    const events = await readTranscript(join(runDir, file));
    // R20 (TD-128 M3)：byState/latest 的每文件读取经 boundReportScope 收窄到
    // 【文件名 stem 即权威 runId】的信封绑定事件（与 runs metrics --summary
    // R19 同款）——外 run 伪终态/远期 ts 尾条不再污染 summary 计数与 latest。
    // legacy 全无信封文件保持历史读法照常计入（runs.test.js 既有契约）。
    const runId = file.replace(/\.jsonl$/, "");
    const scope = boundReportScope(events, runId) ?? events;
    const state = findState(scope);
    counts[state] = (counts[state] ?? 0) + 1;
    const last = scope.at(-1);
    if (last?.ts && (!latestTs || last.ts > latestTs)) {
      latestTs = last.ts;
    }
  }
  // TD-86（D2 A1）：--format json 输出 {total, byState, latest}（latest 无事件 ts 时为 null）。
  if (options.format === "json") {
    console.log(JSON.stringify({ total: jsonlFiles.length, byState: counts, latest: latestTs }, null, 2));
    return;
  }
  console.log(`Total runs: ${jsonlFiles.length}`);
  for (const [state, count] of Object.entries(counts).sort()) {
    console.log(`${state}: ${count}`);
  }
  if (latestTs) {
    console.log(`Latest: ${latestTs}`);
  }
}

// runs prune --older-than 与 runs list --since 共用的唯一 duration 解析器
// （TD-153 提为导出——不复制第二份解析器）：把 "7d"/"24h"/"30m" 解析为毫秒。
export function parseDuration(input) {
  const match = input.match(/^(\d+)(d|h|m|s)$/);
  if (!match) {
    throw new Error(`Invalid duration: ${input}. Use <number><d|h|m|s> (e.g. 7d, 24h, 30m)`);
  }
  const value = Number(match[1]);
  const unit = match[2];
  const multipliers = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
  return value * multipliers[unit];
}

// R23-B1（2026-08-20，Owner 已批 Option B）：runs prune --archive 的月份分层——
// 返回判龄所用 ts 的 UTC 年月（yyyy-mm，toISOString 前缀，跨机确定性）。ts 无效
// /为 0（含"末事件无 ts 按最老处理"的 ts 0 档）返回 null，调用方按文件 mtime
// 月份兜底。
function archiveMonthFromTs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 7);
}

// R23-B1：文件 mtime 的 UTC 年月（判龄 ts 无效/为 0 时的月份兜底）。
async function mtimeMonth(filePath) {
  const st = await stat(filePath);
  return new Date(st.mtimeMs).toISOString().slice(0, 7);
}

async function runsPruneCommand(args, config) {
  const options = parseOptions(args);
  if (!options.olderThan) {
    throw new Error("runs prune requires --older-than <duration> (e.g. 7d, 24h, 30m)");
  }
  const cutoff = Date.now() - parseDuration(options.olderThan);
  const runDir = resolve(options.runDir ?? config.runDir);
  // R23-B1：--archive 归档模式——判龄、扫描面、legacy 语义与删除路径完全一致
  // （下方同一段 R20-C 判龄代码，本函数内分支，无第二份判龄分叉）；差别只在
  // 超龄后的处置：移动到归档目录而非 unlink。不带 --archive 时本函数输出与
  // 行为逐字节不变（既有三个 prune 测试钉住）。
  // truthy 判定（非严格 === true）：parseOptions 对 `--archive 值` 形状会给
  // options.archive 赋字符串值——若严格比对会静默落回删除路径（与用户意图相
  // 反）。--archive 是布尔 flag，只要出现即归档（fail-safe 方向：宁可归档，
  // 不可误删）。
  const archiveMode = Boolean(options.archive);
  const jsonlFiles = await loadRunFiles(runDir);
  if (jsonlFiles.length === 0) {
    console.log("No runs found.");
    return;
  }
  let pruned = 0;
  let archived = 0;
  let skipped = 0;
  let kept = 0;
  for (const file of jsonlFiles) {
    const events = await readTranscript(join(runDir, file));
    // R20-C（TD-128，双席终审会聚 P2）：cutoff 删除决策的年龄读取绑定到
    // 【文件名 stem 即权威 runId】的信封绑定事件（与上方 runs summary 的
    // boundReportScope 收窄同款）——只有本 run 自身事件喂年龄：外 run 旧 ts
    // 尾条不再把在役 run 翻成可修剪（unlink 是证据灭失面，重于观测面）。
    // legacy 全无信封文件保持历史读法照常按末事件 ts 判龄（grep/prune 扫全部
    // .jsonl，是最可能碰到 legacy 文件的清理面）。零绑定事件（整份只有外 run
    // 信封行）→ 无可归属年龄 → 沿既有"末事件无 ts 按最老处理"（ts 0）——与
    // 修复前无 ts 事件文件的行为一致。
    const pruneRunId = file.replace(/\.jsonl$/, "");
    const scope = boundReportScope(events, pruneRunId) ?? events;
    const last = scope.at(-1);
    const ts = last?.ts ? new Date(last.ts).getTime() : 0;
    if (ts < cutoff) {
      if (!archiveMode) {
        await unlink(join(runDir, file));
        console.log(`Pruned ${file}`);
        pruned += 1;
      } else {
        // R23-B1 归档：<dirname(runDir)>/runs-archive/<yyyy-mm>/<原文件名>。
        // 文件名原样保留（法医锚：大量 TD/friction 以 runId 文件名为证据锚，
        // 改名=锚灭失）。冲突 fail-safe：目标同名文件已存在 → 不移动、不覆盖，
        // 输出一行冲突报告并计入 skipped——宁可不动，不可丢数据。
        const month = archiveMonthFromTs(ts) ?? await mtimeMonth(join(runDir, file));
        const targetDir = join(dirname(runDir), "runs-archive", month);
        const target = join(targetDir, file);
        if (existsSync(target)) {
          console.log(`Skipped ${file} (conflict: runs-archive/${month}/${file} already exists)`);
          skipped += 1;
        } else {
          await mkdir(targetDir, { recursive: true });
          await rename(join(runDir, file), target);
          console.log(`Archived ${file} -> runs-archive/${month}/${file}`);
          archived += 1;
        }
      }
    } else {
      kept += 1;
    }
  }
  if (archiveMode) {
    console.log(`Archived ${archived}, skipped ${skipped} (conflict), kept ${kept}`);
    return;
  }
  console.log(`Pruned ${pruned}, kept ${kept}`);
}

async function runsGrepCommand(args, config) {
  const [pattern, ...tail] = args;
  if (!pattern) {
    throw new Error("runs grep requires <pattern>");
  }
  const options = parseOptions(tail);
  const runDir = resolve(options.runDir ?? config.runDir);
  const jsonlFiles = await loadRunFiles(runDir);
  if (jsonlFiles.length === 0) {
    // TD-86（D2 A1）：空目录在 JSON 模式输出结构化零结果，text 路径不变。
    if (options.format === "json") {
      console.log(JSON.stringify({ pattern, matched: 0, matches: [] }, null, 2));
      return;
    }
    console.log("No runs found.");
    return;
  }
  const re = new RegExp(pattern, "i");
  let matches = 0;
  // TD-86（D2 A1）：每 run 只记首个命中（与 text 路径的 break 语义一致——schema 不暗示全量）。
  const matchRows = [];
  for (const file of jsonlFiles) {
    const runId = file.replace(/\.jsonl$/, "");
    const events = await readTranscript(join(runDir, file));
    for (const event of events) {
      if (re.test(JSON.stringify(event))) {
        matchRows.push({ runId, type: event.type, ts: event.ts ?? null });
        matches += 1;
        break;
      }
    }
  }
  // TD-86（D2 A1）：--format json 输出 {pattern, matched, matches}。
  if (options.format === "json") {
    console.log(JSON.stringify({ pattern, matched: matches, matches: matchRows }, null, 2));
    return;
  }
  for (const m of matchRows) {
    console.log(`${m.runId}\t${m.type}\t${m.ts ?? ""}`);
  }
  console.log(`Matched ${matches} run(s)`);
}

async function runsMetricsCommand(args, config) {
  const options = parseOptions(args);
  const runDir = resolve(options.runDir ?? config.runDir);

  // --summary: 跨 run 聚合
  if (options.summary) {
    const jsonlFiles = await loadRunOnlyFiles(runDir);
    if (jsonlFiles.length === 0) {
      console.log("No runs found.");
      return;
    }
    const allEvents = await Promise.all(
      jsonlFiles.map((f) => readTranscript(join(runDir, f))),
    );
    // R19 (TD-128 W1 报表污染类，会审补登；L1 勘误：原注释误标 W2——按 TD-128
    // 登记表真实编号，--summary 逐文件聚合属 R18 W1 报表污染类同族)：调用方逐
    // 文件读取，【文件名 stem 即权威 runId】（与 runsGrep 的 runId 推导同款）
    // ——逐文件传入绑定读者（aggregateSummary → aggregateRunMetrics →
    // boundReportScope 单一定义处，R18 导出复用不新写）。单文件内的外 run/
    // 伪造尾条不再污染 --summary 聚合；全无信封的 legacy 文件经 boundReportScope
    // 规则保持历史读法（合法路径零变化）。修正旧注释"无权威 runId"的不实措辞
    // （会审指出）。
    const s = aggregateSummary(allEvents, jsonlFiles.map((f) => f.replace(/\.jsonl$/, "")));
    if (options.format === "json") {
      console.log(JSON.stringify(s, null, 2));
      return;
    }
    console.log(`Total runs: ${s.totalRuns}`);
    console.log(`Success rate: ${(s.successRate * 100).toFixed(0)}%`);
    for (const [state, count] of Object.entries(s.byState).sort()) {
      console.log(`  ${state}: ${count}`);
    }
    console.log(`Avg duration: ${formatDuration(s.avgDurationMs)}`);
    const t = s.totalTokens;
    if (Object.keys(t).length > 0) {
      console.log(`Tokens: input=${t.input ?? 0} output=${t.output ?? 0} reasoning=${t.reasoning ?? 0}`);
    }
    return;
  }

  // 单 run: runs metrics <runId>
  const [runId] = args.filter((a) => !a.startsWith("--"));
  if (!runId) {
    throw new Error("runs metrics requires <runId> (or --summary for aggregate)");
  }
  // R18 (TD-128 W1)：runId 在 join 前过 isValidRunId（shared.js loadRun 同款接线）。
  // 锚点复核结论：runsMetricsCommand/runsScorecardCommand 均不经 loadRun（该
  // helper 服务 status/tail/collect/stop/retry），两命令此前直接 join+read，
  // 校验缺失——路径拼接面（../、绝对路径、分隔符）与 TD-128c 同类。fixed-safe
  // 文案不回显输入。
  if (!isValidRunId(runId)) {
    throw new Error("runId is malformed (expected a run id: letters, digits, underscore, hyphen)");
  }
  const filePath = join(runDir, `${runId}.jsonl`);
  const events = await readTranscript(filePath);
  // R18 (TD-128 W1)：聚合事实读取绑定到本 run 信封（boundReportScope 单一定
  // 义处）——外 run/伪造尾条不再污染 state/tokens/cost/duration。
  const m = aggregateRunMetrics(events, runId);
  if (options.format === "json") {
    console.log(JSON.stringify({ runId, ...m }, null, 2));
    return;
  }
  console.log(`runId:    ${runId}`);
  console.log(`state:    ${m.state}`);
  console.log(`duration: ${formatDuration(m.durationMs)}`);
  const t = m.tokens;
  if (Object.keys(t).length > 0) {
    console.log(`tokens:   input=${t.input ?? 0} output=${t.output ?? 0} reasoning=${t.reasoning ?? 0}`);
  } else {
    console.log(`tokens:   (none recorded)`);
  }
  if (m.costUsd !== undefined) {
    console.log(`cost:     ${m.costUsd.toFixed(4)}`);
  }
}

async function runsScorecardCommand(args, config) {
  const options = parseOptions(args);
  const runDir = resolve(options.runDir ?? config.runDir);
  const [runId] = args.filter((a) => !a.startsWith("--"));
  if (!runId) {
    throw new Error("runs scorecard requires <runId>");
  }
  // R18 (TD-128 W1)：runId join 前过 isValidRunId（与上方 runs metrics 同款接线，
  // loadRun 同款 fixed-safe 文案）。
  if (!isValidRunId(runId)) {
    throw new Error("runId is malformed (expected a run id: letters, digits, underscore, hyphen)");
  }
  const filePath = join(runDir, `${runId}.jsonl`);
  const events = await readTranscript(filePath);
  // R18 (TD-128 W1)：scorecard 事实读取经 boundReportScope 收窄到本 run 信封
  // （首条纪律——与修复前 events.find 的首条序语义一致）：本 run 无自身
  // scorecard.checked 时，外 run 尾条不再伪造出一份 scorecard 报告；reason 推
  // 断的 run.started 读取同款绑定。全无信封 legacy transcript 保持既有读法
  // （boundReportScope 单一定义处的降级选择）。
  const scope = boundReportScope(events, runId);
  const scEvent = scope
    ? findFirstBound(scope, "scorecard.checked", runId)
    : events.find((e) => e.type === "scorecard.checked");
  if (!scEvent) {
    const started = scope
      ? findFirstBound(scope, "run.started", runId)
      : events.find((e) => e.type === "run.started");
    const reason = started?.scorecardConfigured ? "failed_before_scorecard" : "no_rules";
    if (options.format === "json") {
      console.log(JSON.stringify({ runId, scorecard: null, reason }, null, 2));
      return;
    }
    console.log(`runId:      ${runId}`);
    console.log(`scorecard:  (none — ${reason === "failed_before_scorecard" ? "run failed before scorecard gate" : "run had no scorecard rules"})`);
    return;
  }
  if (options.format === "json") {
    console.log(JSON.stringify({ runId, ...scEvent }, null, 2));
    return;
  }
  console.log(`runId:      ${runId}`);
  console.log(`passed:     ${scEvent.passed ? "yes" : "no"}`);
  for (const c of scEvent.checks ?? []) {
    const mark = c.passed ? "✔" : "✖";
    console.log(`  ${mark} ${c.name}: ${c.evidence}${c.detail ? ` — ${c.detail}` : ""}`);
  }
}

/**
 * M8-3 故障诊断：runs diagnose <runId>（🔵 工具起草域——给证据，不给处方）。
 * 处方权（retry/换 worker/接管/放弃）全在 Lead。本命令只打印【事实证据】，
 * 绝不打印"建议/应该"。详见 src/diagnosis.js 铁律。
 */
async function runsDiagnoseCommand(args, config) {
  const options = parseOptions(args);
  const runDir = resolve(options.runDir ?? config.runDir);
  const [runId] = args.filter((a) => !a.startsWith("--"));
  if (!runId) {
    throw new Error("runs diagnose requires <runId>");
  }
  // M9-5A: diagnosis delegated to shared application service. CLI prints the
  // existing JSON/text output (raw factual evidence for human/ops/debug).
  // M12-6 FR-02: `code` is a closed-set provider diagnosis label (human fact) —
  // null unless category is provider_auth. Never the raw error message.
  const d = await getRunDiagnosis({ runId, runDir });
  if (options.format === "json") {
    // CLI JSON shape: {runId, state, terminal, category, code, evidence} —
    // state/terminal 自 2026-10-02 起补入（脚本消费者读 category:"none" 时原先
    // 分不清非终态与已完成——F-A 实证；additive，MCP 面独立不受影响）。
    console.log(JSON.stringify({ runId: d.runId, state: d.state, terminal: d.terminal, category: d.category, code: d.code ?? null, evidence: d.evidence }, null, 2));
    return;
  }
  console.log(`runId:    ${d.runId}`);
  console.log(`category: ${d.category}`);
  if (d.category === "provider_auth" && d.code) {
    console.log(`code:     ${d.code}`);
  }
  if (d.evidence.length > 0) {
    console.log(`evidence:`);
    for (const e of d.evidence) {
      console.log(`  [${e.eventType}] ${e.fact}`);
    }
  } else if (d.category === "none") {
    // TD-200①（2026-10-02 前置盘点收口）：服务本就返回 terminal/state——非终态
    // run 曾被误称 "run completed successfully"（category none 只说明无失败事实，
    // 不说明已完成）。
    if (d.terminal) {
      console.log(`(no failure to diagnose — run completed successfully)`);
    } else {
      // 会审措辞（auditor）：不带"等终态再诊"尾巴——运行中出现新失败事实同样值得复诊。
      console.log(`(no failure to diagnose yet — run not terminal (state: ${d.state}))`);
    }
  } else {
    console.log(`(no concrete evidence signal; review transcript manually)`);
  }
}

/**
 * M8-2 实时仪表盘：单一视图聚合所有 run 的状态/token/费用/证据，异常标红。
 * 🟢 工具域：只读聚合，绝不 retry/stop/改状态。省 Lead 在多命令间轮询的精力。
 * 支持：--watch N（N 秒重刷）/ --format json / --agent <id> 过滤 / --latest N 取最近 N 个。
 */
export async function runsDashboardCommand(args, config, injections = {}) {
  const options = parseOptions(args);

  // M12-8D: `--web` launches a local read-only Owner dashboard HTTP boundary.
  // It is mutually exclusive with the live text refresh and JSON output. The
  // non-web path below is byte-compatible with the prior behavior.
  if (options.web) {
    if (options.watch !== undefined && options.watch !== false) {
      throw new Error("--web cannot be combined with --watch");
    }
    if (options.format === "json") {
      throw new Error("--web cannot be combined with --format json");
    }
    await runDashboardWeb(options, config, injections);
    return;
  }

  const runDir = resolve(options.runDir ?? config.runDir);
  const agentFilter = options.agent;
  const latestN = options.latest ? Number(options.latest) : null;
  const watchSec = options.watch ? Number(options.watch) : null;
  const asJson = options.format === "json";

  const renderOnce = async () => {
    const jsonlFiles = await loadRunOnlyFiles(runDir);
    let runs = await Promise.all(
      jsonlFiles.map(async (f) => ({
        runId: f.replace(/\.jsonl$/, ""),
        events: await readTranscript(join(runDir, f)),
      })),
    );
    if (agentFilter) runs = runs.filter((r) => r.events[0]?.agentId === agentFilter);
    if (latestN && latestN > 0) {
      // R20-C（TD-128 M3 残余，双席终审清点）：--latest 排序键 = 各 run 自身
      // 【绑定】事件的末条 ts（文件名 stem 即权威 runId，与上方 buildDashboard/
      // summary 的 boundReportScope 收窄同款）——外 run 远期尾条不再顶掉行序。
      // legacy 全无信封文件保持历史末事件 ts 排序；零绑定事件 → "" 排尾（无
      // 可归属年龄，不顶序）。
      runs = runs
        .map((r) => {
          const scope = boundReportScope(r.events, r.runId) ?? r.events;
          return { r, ts: scope.at(-1)?.ts ?? "" };
        })
        .sort((a, b) => b.ts.localeCompare(a.ts))
        .slice(0, latestN)
        .map((x) => x.r);
    }
    // TD-82：读 .wao/pipeline/ 下的 Lead 自做声明，注入 dashboard（曝光机制）。
    // .wao/ 未 init 时静默跳过（count:0），不阻塞 dashboard。
    let selfDeclared = null;
    let stageProgress = null;
    const cwd = resolveTargetCwd(options);
    const waoDir = getWaoDir(cwd, options.stateDir ?? config.stateDir);
    try {
      selfDeclared = await summarizeDeclares(waoDir);
    } catch { /* .wao/ 未 init，无声明——dashboard 照常显示 */ }
    try {
      const stageSummary = await summarizeStages(waoDir);
      stageProgress = {
        declared: [...stageSummary.declared].sort((a, b) => a - b),
        count: stageSummary.count,
      };
    } catch { /* .wao/ 未 init——pipeline 进度留空 */ }
    const dash = buildDashboard(runs, selfDeclared, stageProgress);
    if (asJson) {
      console.log(JSON.stringify(dash, null, 2));
      return;
    }
    if (dash.rows.length === 0) {
      console.log("No runs found.");
      return;
    }
    const tableRows = dash.rows.map((row) => {
      const ti = row.tokens?.input ?? 0;
      const to = row.tokens?.output ?? 0;
      return {
        runId: row.runId,
        agentId: row.agentId,
        state: row.state,
        tokens: `${ti}/${to}`,
        cost: row.costUsd !== undefined ? `$${row.costUsd.toFixed(4)}` : "-",
        evidence: row.evidence,
        age: row.ageMs !== undefined ? formatDuration(row.ageMs) : "-",
        flag: row.flagged ? "  ⚠" : "",
      };
    });
    const widths = {
      runId: Math.max("RUN_ID".length, ...tableRows.map((r) => r.runId.length)),
      agentId: Math.max("AGENT".length, ...tableRows.map((r) => r.agentId.length)),
      state: Math.max("STATE".length, ...tableRows.map((r) => r.state.length)),
      tokens: Math.max("TOKENS(i/o)".length, ...tableRows.map((r) => r.tokens.length)),
      cost: Math.max("COST".length, ...tableRows.map((r) => r.cost.length)),
      evidence: Math.max("EVIDENCE".length, ...tableRows.map((r) => r.evidence.length)),
    };
    console.log(`${"RUN_ID".padEnd(widths.runId)} ${"AGENT".padEnd(widths.agentId)} ${"STATE".padEnd(widths.state)} ${"TOKENS(i/o)".padEnd(widths.tokens)} ${"COST".padEnd(widths.cost)} ${"EVIDENCE".padEnd(widths.evidence)} AGE`);
    for (const row of tableRows) {
      console.log(`${row.runId.padEnd(widths.runId)} ${row.agentId.padEnd(widths.agentId)} ${row.state.padEnd(widths.state)} ${row.tokens.padEnd(widths.tokens)} ${row.cost.padEnd(widths.cost)} ${row.evidence.padEnd(widths.evidence)} ${row.age}${row.flag}`);
    }
    const s = dash.summary;
    console.log(`[summary] total=${s.total} running=${s.running} flagged=${s.flagged} cost=$${s.totalCost.toFixed(4)}` +
      (s.selfDeclared.count > 0
        ? ` | Lead自做=${s.selfDeclared.count} 理由分布=${JSON.stringify(s.selfDeclared.byReason)}`
        : ""));
    // TD-83：pipeline 阶段进度行——让"跳过 spec/plan/汇总/总结"对用户可见（曝光机制）。
    if (s.stageProgress.count > 0 || s.stageProgress.declared.length === 0) {
      const stageNames = ["", "spec", "plan", "派发", "验收", "汇总", "总结"];
      const line = [1, 2, 3, 4, 5, 6]
        .map((n) => `[${n}]${stageNames[n]}${s.stageProgress.declared.includes(n) ? "✓" : "—"}`)
        .join(" ");
      console.log(`[pipeline] ${line}`);
    }
  };

  await renderOnce();
  // --watch N：定时重刷（Lead 用 Ctrl-C 退出）。不做 top 式常驻进程（用户已否决）。
  if (watchSec && watchSec > 0) {
    // 定时器保持进程存活（不 unref）；下面的 never-resolving Promise 是双保险，
    // 确保 setInterval 的回调持续触发直到 SIGINT。Ctrl-C 退出。
    const timer = setInterval(renderOnce, watchSec * 1000);
    await new Promise(() => {});
    clearInterval(timer);
  }
}

/**
 * M12-8D: launch the local Owner read-only dashboard HTTP boundary and stay alive
 * until SIGINT/SIGTERM. Reuses ownerDashboardServer (the single loopback
 * read-only boundary) — there is no second parser/classifier/redactor here.
 *
 * Server-owned inputs (never client-supplied) come from the SHARED authorities:
 *   - runDir         — config.runDir (same SSOT as the text dashboard),
 *   - workspaceRoot  — proveWorkspace(targetCwd) canonical Git root (the SAME
 *                      ownership authority runStop/listRuns use),
 *   - knownAgentIds  — readRegistry() agent ids (the SAME registry authority).
 *
 * It prints exactly one URL — http://127.0.0.1:<port>/#token=<64hex> — plus a
 * Ctrl-C line, then blocks until a shutdown signal. It performs NO control
 * action, opens no browser, writes no config, and changes no selection.
 *
 * Every external dependency is injectable so tests cover startup / fragment /
 * conflict / shutdown WITHOUT a real socket, git, registry, or signal.
 *
 * @param {object} options — parsed CLI options (web/port/runDir/cwd/…)
 * @param {object} config — process config (runDir/registry/stateDir)
 * @param {object} [injections]
 * @param {Function} [injections.createServerFn] — server factory (testing)
 * @param {Function} [injections.proveWorkspaceFn] — workspace authority (testing)
 * @param {Function} [injections.readRegistryFn] — registry reader (testing)
 * @param {{wait:Function, cancel?:Function}} [injections.lifecycle] — shutdown waitable (testing)
 * @param {Function} [injections.log] — stdout sink (testing)
 * @param {string} [injections.targetCwd] — pre-resolved target cwd (M12-8F
 *   `wao dashboard` launcher; absent → legacy resolveTargetCwd chain)
 * @param {string} [injections.workspaceRoot] — pre-resolved STRICT canonical
 *   Git root (M12-8F launcher; absent → legacy fail-soft prove fallback)
 * @param {Function} [injections.afterListen] — advisory post-listen hook,
 *   receives the printed URL (M12-8F auto-open; absent → never opens)
 */
export async function runDashboardWeb(options, config, injections = {}) {
  const createServer = injections.createServerFn ?? createOwnerDashboardServer;
  const prove = injections.proveWorkspaceFn ?? proveWorkspace;
  const readReg = injections.readRegistryFn ?? readRegistry;
  const lifecycle = injections.lifecycle ?? createProcessLifecycle();
  const log = injections.log ?? ((s) => console.log(s));

  // M12-8F: the `wao dashboard` launcher pre-resolves BOTH the target cwd and
  // the STRICT canonical Git root and threads them in. Legacy `runs dashboard
  // --web` passes neither and keeps the existing resolveTargetCwd + fail-soft
  // prove behavior byte-for-byte.
  const targetCwd = injections.targetCwd ?? resolveTargetCwd(options);
  const runDir = resolve(options.runDir ?? config.runDir);

  // Shared workspace authority: the canonical Git root of the target cwd. If the
  // cwd is not a provable workspace, the dashboard still starts — no run matches
  // ownership (shown as cross_workspace) rather than crashing the command.
  // (M12-8F: the launcher already proved the root strictly before listen.)
  let workspaceRoot;
  if (injections.workspaceRoot !== undefined) {
    workspaceRoot = injections.workspaceRoot;
  } else {
    try {
      workspaceRoot = prove(targetCwd).root;
    } catch {
      workspaceRoot = targetCwd;
    }
  }

  // Shared registry authority: agent ids for agentId validation. Registry
  // unavailable → agentIds render as "unknown" (fail soft, do not crash).
  // P0 (2026-10-03): readRegistry returns {listAgents, getAgent, rawEntries}
  // and NEVER had an `agents` array — the old Array.isArray(reg.agents) check
  // was a day-one wiring defect that silently emptied knownAgentIds (every
  // run showed agentId "unknown" in production; injected test fakes matched
  // the wrong shape and hid it). Same shape family as the M12-25B finding in
  // the MCP path (src/mcp/server.js knownAgentIds block).
  let knownAgentIds = [];
  try {
    const reg = await readReg(resolve(config.registry ?? "config/agents.json"));
    if (reg && typeof reg.listAgents === "function") {
      knownAgentIds = reg.listAgents()
        .map((a) => a && a.id)
        .filter((id) => typeof id === "string");
    }
  } catch { /* registry unavailable → "unknown" agentIds */ }

  // Optional --port: 0 (ephemeral, default) or integer. The server validates the
  // full 0|1024..65535 range fail-closed; here we only coerce the CLI string.
  let port = 0;
  if (options.port !== undefined && options.port !== null && options.port !== true) {
    const n = Number(options.port);
    if (!Number.isInteger(n)) throw new Error("--port must be an integer");
    port = n;
  }

  const server = createServer({ runDir, workspaceRoot, knownAgentIds, port });
  const addr = await server.listen();
  // The token lives ONLY in the URL fragment; the server never receives it.
  const url = `http://127.0.0.1:${addr.port}/#token=${server.token}`;
  log(url);
  log("(Ctrl-C to stop)");

  // M12-8F: advisory post-listen hook — the `wao dashboard` launcher auto-opens
  // the printed URL here (exactly once) unless --no-open. Legacy passes no hook
  // and never opens. A failing hook is ADVISORY: the URL is already printed, so
  // warn concisely and keep serving.
  if (typeof injections.afterListen === "function") {
    try {
      await injections.afterListen(url);
    } catch (error) {
      log(`⚠ 无法自动打开浏览器（${error.message}）——请手动打开上面的 URL。`);
    }
  }

  // Block until SIGINT/SIGTERM, then close the boundary and return.
  try {
    await lifecycle.wait();
  } finally {
    if (typeof server.close === "function") await server.close();
    if (typeof lifecycle.cancel === "function") lifecycle.cancel();
  }
}

/**
 * Production shutdown lifecycle: a promise that resolves on SIGINT or SIGTERM.
 * Registering the listeners suppresses Node's default termination so we can
 * close the HTTP boundary cleanly first.
 */
function createProcessLifecycle() {
  let resolveWait;
  const done = new Promise((resolve) => { resolveWait = resolve; });
  const signals = ["SIGINT", "SIGTERM"];
  const onSignal = () => resolveWait();
  for (const sig of signals) process.on(sig, onSignal);
  return {
    wait: () => done,
    cancel() { for (const sig of signals) process.off(sig, onSignal); },
  };
}

/**
 * M11-3C: `runs delivery review <runId> --file-index N [--cursor TOKEN] [--format json] [--cwd DIR]`
 *
 * CLI adapter for the safe delivery-diff projection. Delegates to the SAME
 * getRunDeliveryReview application service as the MCP adapter. Does NOT parse
 * cursor, does NOT shell out, does NOT decode the diff.
 *
 * Uses narrow strict parsing for --file-index / --cursor / --format so the
 * general parseOptions behaviour is unaffected.
 *
 * @param {string[]} args — everything after `delivery review`
 * @param {object} config
 * @param {object} [hostDeps] — { getRunDeliveryReviewFn } for testing
 */
// F5 (2026-10-08): 坏 cursor 专属 CLI 文案——与 MCP 面 run_delivery_review 的
// 专属拒绝文案同义（静态恢复指引：第 1 页重取、勿手工修改；不透子类型）。
// 本地语法拒绝与服务层 CursorRejectedError 折叠共用。
const REVIEW_CURSOR_REJECTED_TEXT =
  "runs delivery review cursor rejected: the cursor is invalid or expired — re-run " +
  "without --cursor to restart from page 1; a cursor token is opaque and must never be hand-modified";

async function runsDeliveryReviewCommand(args, config, hostDeps = {}) {
  // M11-3C closeout: strict flag parsing — every flag value must be non-empty /
  // non-whitespace; no duplicates; exactly one positional; format must be json
  // (or omitted = text); cursor must be base64url.
  const KNOWN_FLAGS = new Set(["--file-index", "--cursor", "--format", "--cwd", "--run-dir"]);
  const seenFlags = new Set();
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--file-index" || a === "--cursor" || a === "--format" || a === "--cwd" || a === "--run-dir") {
      if (seenFlags.has(a)) throw new Error(`${a} specified multiple times`);
      seenFlags.add(a);
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} requires a value`);
      if (v.trim().length === 0) throw new Error(`${a} must be non-empty`);
      const key = a.slice(2).replace(/-([a-z])/, (_, c) => c.toUpperCase());
      flags[key] = v;
      i += 1;
    } else if (a.startsWith("--")) {
      throw new Error(`unknown flag for delivery review: ${a}`);
    } else {
      positionals.push(a);
    }
  }

  if (positionals.length !== 1) {
    throw new Error("runs delivery review requires exactly one <runId>");
  }
  const runId = positionals[0];
  if (runId.trim().length === 0 || !/^[A-Za-z0-9_-]+$/.test(runId)) {
    throw new Error("runs delivery review requires a valid <runId>");
  }

  if (flags.fileIndex === undefined) {
    throw new Error("runs delivery review requires --file-index");
  }
  if (!/^\d+$/.test(flags.fileIndex)) {
    throw new Error("--file-index must be a non-negative integer");
  }
  const fileIndex = Number(flags.fileIndex);

  // cursor must be base64url if provided. F5: 语法拒绝也走专属恢复文案。
  if (flags.cursor !== undefined) {
    if (!/^[A-Za-z0-9_-]+$/.test(flags.cursor)) {
      throw new Error(REVIEW_CURSOR_REJECTED_TEXT);
    }
  }

  // format must be json or omitted (text).
  if (flags.format !== undefined && flags.format !== "json") {
    throw new Error("--format only supports 'json' (text mode is default)");
  }

  // Resolve authorized workspace root via the existing CLI workspace mechanism.
  const cwd = flags.cwd ? resolve(flags.cwd) : resolveTargetCwd({ cwd: undefined }, config);
  const runDir = resolve(flags.runDir ?? config.runDir);

  const service = hostDeps.getRunDeliveryReviewFn ?? getRunDeliveryReview;
  // F5: 服务层解码/校验路径抛出的 CursorRejectedError 折叠为专属恢复文案；
  // 其余错误原样上抛（保持既有失败形状）。
  let raw;
  try {
    raw = await service({
      runId,
      runDir,
      authorizedWorkspaceRoot: cwd,
      fileIndex,
      ...(flags.cursor !== undefined ? { cursor: flags.cursor } : {}),
    });
  } catch (error) {
    if (error instanceof CursorRejectedError) {
      throw new Error(REVIEW_CURSOR_REJECTED_TEXT);
    }
    throw error;
  }

  // M11-3C closeout: use the SAME shared safe-output projection as the MCP
  // adapter. Never output the raw service result directly.
  const { projectReviewResult } = await import("../application/deliveryReviewProjection.js");
  const result = projectReviewResult(raw, { runId });

  if (flags.format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Text mode. verification_pending is advisory, NOT a file identity and NOT an
  // error: there is no proof-backed metadata to print (changedPath/count are
  // null), so the normal "File: … (i/count)" line must be skipped entirely.
  if (!result.available && result.unavailableReason === "verification_pending") {
    console.log("[not reviewable yet: verification_pending]");
    console.log("Exact delivery verification has not been recorded; no diff is available yet.");
    console.log("Advisory only — wait via `runs delivery <runId> --wait-ms N` or retry review later.");
    console.log(`requested fileIndex: ${result.fileIndex}`);
    return;
  }

  // Text mode: safe file identity + fragment or unavailable status + cursor.
  console.log(`File: ${result.changedPath} (${result.fileIndex + 1}/${result.changedFileCount})`);
  if (result.available) {
    console.log(result.fragment);
    if (result.nextCursor) {
      console.log(`--- next cursor: ${result.nextCursor} ---`);
    }
  } else {
    console.log(`[unavailable: ${result.unavailableReason}]`);
  }
}

/**
 * M12-6 FR-07 / TD-240③（2026-10-08）：UTF-8 JSON 字符串数组 commands-file 的
 * 唯一解析器——`--setup-commands-file`（runs delivery reverify）与
 * `--commands-file`（runs verify-commit）共用同一解析器与边界（≤32 条×每条
 * ≤512 字符，REVERIFY_* service 导出——无第二份边界常量）。TD-240 裁定③"复用
 * reverify --setup-commands-file 的解析器与边界"的落地形态：自 reverify CLI
 * 内联块提取为具名函数；reverify 旗标的历史错误文案逐字节保持（flagName +
 * echoValue + exceedLabel 参数化，reverify 路径传原字面量）。
 */
async function parseCommandsFileBuffer(buf, flagName, echoValue, exceedLabel) {
  let parsed;
  try {
    parsed = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new Error(`${flagName} must be valid UTF-8 JSON: ${echoValue}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${flagName} must contain a JSON array of strings`);
  }
  if (parsed.length > REVERIFY_SETUP_COMMANDS_LIMIT) {
    throw new Error(`${flagName} exceeds ${REVERIFY_SETUP_COMMANDS_LIMIT} commands`);
  }
  const out = [];
  for (const cmd of parsed) {
    if (typeof cmd !== "string") {
      throw new Error(`${flagName} must contain only strings`);
    }
    if (cmd.trim().length === 0) {
      throw new Error(`${flagName} must not contain blank commands`);
    }
    if (cmd.length > REVERIFY_SETUP_COMMAND_MAX_LENGTH) {
      throw new Error(`${exceedLabel} exceeds ${REVERIFY_SETUP_COMMAND_MAX_LENGTH} characters`);
    }
    out.push(cmd);
  }
  return out;
}

/**
 * M12-6 FR-07: `runs delivery reverify <runId> --reason <code>`
 * `[--setup-commands-file FILE] [--timeout-ms N] [--run-dir DIR] [--cwd DIR] [--format json]`
 *
 * CLI fallback for the audited unchanged-artifact re-verification. Delegates to
 * the SAME runDeliveryReverify application service the MCP run_delivery_reverify
 * tool uses — no copied algorithm, no transcript parsing, no second set of
 * boundary constants.
 *
 * The CLI owns only:
 *   - strict argv parsing (reverify recognized before ordinary delivery parsing)
 *   - --setup-commands-file: UTF-8 JSON string array; missing = empty array;
 *     rejects non-array / extra semantics / blank / oversize (service exports)
 *   - --timeout-ms: strict integer in the service [MIN, MAX] (service exports)
 *   - authorizedWorkspaceRoot from the existing cwd/workspace proof path —
 *     caller input cannot name a workspace root
 *   - safe JSON/text output of the service-approved closed-set fields ONLY
 *
 * No reverify auto-accepts/rejects. The original verification and its assertion
 * commands are permanently preserved by the service; the CLI exposes NO
 * assertion-command override flag.
 *
 * @param {string[]} args — everything after `delivery reverify`
 * @param {object} config
 * @param {object} [hostDeps] — { runDeliveryReverifyFn } for testing
 */
async function runsDeliveryReverifyCommand(args, config, hostDeps = {}) {
  // Narrow strict parsing (same discipline as runs delivery review): every
  // flag value must be non-empty / non-whitespace; no duplicates; exactly one
  // positional; unknown flags rejected (the ONLY way to reach the service).
  const KNOWN_FLAGS = new Set([
    "--reason", "--setup-commands-file", "--timeout-ms",
    "--run-dir", "--cwd", "--format",
  ]);
  const seenFlags = new Set();
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (KNOWN_FLAGS.has(a)) {
      if (seenFlags.has(a)) throw new Error(`${a} specified multiple times`);
      seenFlags.add(a);
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} requires a value`);
      if (v.trim().length === 0) throw new Error(`${a} must be non-empty`);
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      flags[key] = v;
      i += 1;
    } else if (a.startsWith("--")) {
      throw new Error(`unknown flag for delivery reverify: ${a}`);
    } else {
      positionals.push(a);
    }
  }

  if (positionals.length !== 1) {
    throw new Error("runs delivery reverify requires exactly one <runId>");
  }
  const runId = positionals[0];
  if (runId.trim().length === 0 || !/^[A-Za-z0-9_-]+$/.test(runId)) {
    throw new Error("runs delivery reverify requires a valid <runId>");
  }

  // Closed-set reason — the exact REVERIFY_REASONS SSOT the service validates.
  if (flags.reason === undefined) {
    throw new Error(
      "runs delivery reverify requires --reason (tooling_invalid | environment_contaminated | dependency_setup_missing)",
    );
  }
  if (!REVERIFY_REASONS.includes(flags.reason)) {
    throw new Error(`--reason must be one of: ${REVERIFY_REASONS.join(", ")}`);
  }

  // --setup-commands-file: UTF-8 JSON string array. Missing = empty array (the
  // service default). Rejected: non-JSON / non-array / non-string elements /
  // blank elements / oversize (bounded by the SERVICE exports — no second copy).
  // TD-240③: the parse itself is delegated to the ONE shared commands-file
  // parser (parseCommandsFileBuffer) with this command's historical texts.
  let setupCommands;
  if (flags.setupCommandsFile !== undefined) {
    let buf;
    try {
      buf = await readFile(resolve(flags.setupCommandsFile));
    } catch {
      throw new Error(`--setup-commands-file must be valid UTF-8 JSON: ${flags.setupCommandsFile}`);
    }
    setupCommands = await parseCommandsFileBuffer(
      buf, "--setup-commands-file", flags.setupCommandsFile, "setup command",
    );
  }

  // --timeout-ms: strict integer in the service [MIN, MAX]; missing = service
  // default (bounded by the SERVICE exports — no second copy).
  let timeoutMs;
  if (flags.timeoutMs !== undefined) {
    if (!/^\d+$/.test(flags.timeoutMs)) {
      throw new Error(`--timeout-ms must be an integer in [${REVERIFY_TIMEOUT_MS_MIN}, ${REVERIFY_TIMEOUT_MS_MAX}]`);
    }
    const n = Number(flags.timeoutMs);
    if (!Number.isInteger(n) || n < REVERIFY_TIMEOUT_MS_MIN || n > REVERIFY_TIMEOUT_MS_MAX) {
      throw new Error(`--timeout-ms must be an integer in [${REVERIFY_TIMEOUT_MS_MIN}, ${REVERIFY_TIMEOUT_MS_MAX}]`);
    }
    timeoutMs = n;
  }

  // format must be json or omitted (text).
  if (flags.format !== undefined && flags.format !== "json") {
    throw new Error("--format only supports 'json' (text mode is default)");
  }

  // Resolve the authorized workspace root via the EXISTING CLI cwd/workspace
  // proof path (same as runs delivery review). Caller input cannot name a
  // workspace root directly — only --cwd, resolved like every other cwd flag.
  const cwd = flags.cwd ? resolve(flags.cwd) : resolveTargetCwd({ cwd: undefined }, config);
  const runDir = resolve(flags.runDir ?? config.runDir);

  const service = hostDeps.runDeliveryReverifyFn ?? runDeliveryReverify;
  const raw = await service({
    runId,
    runDir,
    authorizedWorkspaceRoot: cwd,
    reason: flags.reason,
    ...(setupCommands !== undefined ? { setupCommands } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });

  // Safe projection: the SAME closed-set fields the MCP tool approves, each
  // validated through its closed set. Any violation fails closed — no
  // command/path/stderr/env/raw-event is ever echoed.
  if (raw.runId !== runId) throw new Error("reverify runId mismatch");
  if (!/^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/.test(raw.deliveryCommit)) {
    throw new Error("reverify bad deliveryCommit");
  }
  if (!["created", "resumed", "idempotent"].includes(raw.state)) {
    throw new Error("reverify bad state");
  }
  if (!REVERIFY_REASONS.includes(raw.reason)) throw new Error("reverify bad reason");
  if (!["passed", "failed", "unavailable"].includes(raw.verificationStatus)) {
    throw new Error("reverify bad verificationStatus");
  }
  if (
    raw.failureCode !== null && raw.failureCode !== undefined
    && !REVERIFY_FAILURE_CODES.includes(raw.failureCode)
  ) {
    throw new Error("reverify bad failureCode");
  }
  if (typeof raw.requested !== "boolean") throw new Error("reverify requested not boolean");
  if (typeof raw.outcomeRecorded !== "boolean") throw new Error("reverify outcomeRecorded not boolean");

  const result = {
    runId,
    deliveryCommit: raw.deliveryCommit,
    state: raw.state,
    reason: raw.reason,
    verificationStatus: raw.verificationStatus,
    failureCode: raw.failureCode ?? null,
    requested: raw.requested,
    outcomeRecorded: raw.outcomeRecorded,
  };

  if (flags.format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Run: ${result.runId}`);
  console.log(`Delivery: ${result.deliveryCommit}`);
  console.log(`Reason: ${result.reason} (${result.state})`);
  console.log(`Verification: ${result.verificationStatus}${result.failureCode ? ` (${result.failureCode})` : ""}`);
}

/**
 * TD-240（2026-10-08，裁定①-⑥）: `runs verify-commit <runId> --commit <sha>`
 * `--commands-file FILE [--timeout-ms N] [--run-dir DIR] [--cwd DIR] [--format json]`
 *
 * 采纳协议承载命令：在临时 worktree 检出指定提交 → 执行 commands-file 的命令
 * → 以 run.lead_commit_check_started/_outcome 事件族追加证据 → 清理。
 * Delegates to the SAME runVerifyCommit application service——CLI 不重实现算法、
 * 不解析转录、不复制边界常量。CLI owns only:
 *   - strict argv parsing（runs wait/reverify 同纪律：未知 flag 拒绝）
 *   - --commit 全形 canonical SHA 语法前置（40/64 小写 hex——短形拒绝；服务端
 *     再 rev-parse 等值校验）
 *   - --commands-file 读取 + 字节 sha256 + 共享解析器（parseCommandsFileBuffer，
 *     reverify 同一解析器与边界）
 *   - --timeout-ms 严格整数闭区间 [1000,7200000]（service 导出常量）
 *   - authorizedWorkspaceRoot 由既有 cwd/workspace proof 路径产生
 *   - SIGINT 尽力路径：置 interrupt 标志（服务在命令间/命令后收敛为 aborted）
 *   - 安全输出：闭集字段 only——绝不出现 accepted/verified 措辞（裁定⑥）、
 *     绝不回显命令文本/尾内容/路径/env
 *
 * outcome 非 passed 或 cleanup 失败 → 打印结果后置 process.exitCode=1
 * （清理失败"结果照记+整体非零退出"）。
 *
 * @param {string[]} args — everything after `verify-commit`
 * @param {object} config
 * @param {object} [hostDeps] — { runVerifyCommitFn } service injection for testing
 */
const RUNS_VERIFY_COMMIT_KNOWN_FLAGS = new Set([
  "--commit", "--commands-file", "--timeout-ms",
  "--run-dir", "--cwd", "--format",
]);

async function runsVerifyCommitCommand(args, config, hostDeps = {}) {
  const seenFlags = new Set();
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (RUNS_VERIFY_COMMIT_KNOWN_FLAGS.has(a)) {
      if (seenFlags.has(a)) throw new Error(`${a} specified multiple times`);
      seenFlags.add(a);
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} requires a value`);
      if (v.trim().length === 0) throw new Error(`${a} must be non-empty`);
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      flags[key] = v;
      i += 1;
    } else if (a.startsWith("--")) {
      throw new Error(`unknown flag for runs verify-commit: ${a}`);
    } else {
      positionals.push(a);
    }
  }

  if (positionals.length !== 1) {
    throw new Error("runs verify-commit requires exactly one <runId>");
  }
  const runId = positionals[0];
  if (runId.trim().length === 0 || !/^[A-Za-z0-9_-]+$/.test(runId)) {
    throw new Error("runs verify-commit requires a valid <runId>");
  }

  // 裁定③：SHA 过 isCanonicalCommitId 全形（40/64 小写 hex）——短形不接受。
  if (flags.commit === undefined) {
    throw new Error("runs verify-commit requires --commit <sha>");
  }
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(flags.commit)) {
    throw new Error("--commit must be a canonical full-form 40/64-hex commit id (short forms are not accepted)");
  }

  // 裁定③：commands-file 必填；读字节（sha256 基于同一份字节）+ 共享解析器。
  if (flags.commandsFile === undefined) {
    throw new Error("runs verify-commit requires --commands-file FILE (UTF-8 JSON string array)");
  }
  let commandsBuf;
  try {
    commandsBuf = await readFile(resolve(flags.commandsFile));
  } catch {
    throw new Error(`--commands-file must be valid UTF-8 JSON: ${flags.commandsFile}`);
  }
  const commands = await parseCommandsFileBuffer(
    commandsBuf, "--commands-file", flags.commandsFile, "command",
  );
  const commandsFileSha256 = createHash("sha256").update(commandsBuf).digest("hex");

  // 裁定③：--timeout-ms 单值闭区间 [1000,7200000]（service 导出边界——无第二份）。
  let timeoutMs;
  if (flags.timeoutMs !== undefined) {
    if (!/^\d+$/.test(flags.timeoutMs)) {
      throw new Error(`--timeout-ms must be an integer in [${VERIFY_COMMIT_TIMEOUT_MS_MIN}, ${VERIFY_COMMIT_TIMEOUT_MS_MAX}]`);
    }
    const n = Number(flags.timeoutMs);
    if (!Number.isInteger(n) || n < VERIFY_COMMIT_TIMEOUT_MS_MIN || n > VERIFY_COMMIT_TIMEOUT_MS_MAX) {
      throw new Error(`--timeout-ms must be an integer in [${VERIFY_COMMIT_TIMEOUT_MS_MIN}, ${VERIFY_COMMIT_TIMEOUT_MS_MAX}]`);
    }
    timeoutMs = n;
  }

  if (flags.format !== undefined && flags.format !== "json") {
    throw new Error("--format only supports 'json' (text mode is default)");
  }

  // authorizedWorkspaceRoot 走既有 cwd/workspace proof 路径（reverify/review 同款）
  // ——调用方输入不能直接命名 workspace root。
  const cwd = flags.cwd ? resolve(flags.cwd) : resolveTargetCwd({ cwd: undefined }, config);
  const runDir = resolve(flags.runDir ?? config.runDir);

  // SIGINT（Ctrl-C）尽力路径：置 interrupt 标志；服务在当前命令沉降后收敛为
  // aborted（子进程随控制台 Ctrl-C 自终止；未终止则 bounded by --timeout-ms）。
  const interrupt = { requested: false };
  const onSigint = () => { interrupt.requested = true; };
  process.on("SIGINT", onSigint);
  let raw;
  try {
    const service = hostDeps.runVerifyCommitFn ?? runVerifyCommit;
    raw = await service({
      runId,
      runDir,
      authorizedWorkspaceRoot: cwd,
      commit: flags.commit,
      commands,
      commandsFileSha256,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      invocationCwd: cwd,
      interrupt,
    });
  } finally {
    process.off("SIGINT", onSigint);
  }

  // 安全投影：闭集字段逐项校验（fail closed——服务结果形状不被信任直传）。
  if (raw.runId !== runId) throw new Error("verify-commit runId mismatch");
  if (raw.commit !== flags.commit) throw new Error("verify-commit commit mismatch");
  if (!/^[0-9a-f]{16,64}$/.test(String(raw.checkId ?? ""))) throw new Error("verify-commit bad checkId");
  if (!LEAD_COMMIT_CHECK_STATUSES.includes(raw.status)) throw new Error("verify-commit bad status");
  if (!LEAD_COMMIT_CHECK_CLEANUP_STATUSES.includes(raw.cleanup)) throw new Error("verify-commit bad cleanup");
  if (!Array.isArray(raw.results)) throw new Error("verify-commit bad results");
  for (const r of raw.results) {
    if (!r || typeof r.index !== "number" || typeof r.timedOut !== "boolean") {
      throw new Error("verify-commit bad result row");
    }
  }
  const result = {
    runId,
    checkId: raw.checkId,
    commit: raw.commit,
    status: raw.status,
    cleanup: raw.cleanup,
    results: raw.results.map((r) => ({
      index: r.index,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
      ...(r.contentDrift === true ? { contentDrift: true } : {}),
    })),
  };

  if (flags.format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    // 裁定⑥：text 输出绝不出现 accepted/verified 字样。
    console.log(`Run: ${result.runId}`);
    console.log(`Check: ${result.checkId}`);
    console.log(`Commit: ${result.commit}`);
    console.log(`Status: ${result.status}`);
    console.log(`Cleanup: ${result.cleanup}`);
    console.log(`Commands run: ${result.results.length}`);
    for (const r of result.results) {
      const drift = r.contentDrift === true ? " (worktree drift)" : "";
      console.log(`  [${r.index}] exit=${r.exitCode ?? "null"} timedOut=${r.timedOut} ${r.durationMs}ms${drift}`);
    }
  }
  // 清理失败/failed/aborted → 整体非零退出（结果已照记）。
  if (raw.exitCode !== 0) process.exitCode = 1;
}

export { runsCommand, runsDeliveryCommand, runsGateCommand };

// ===== TD-103 Phase 3C-2: Lead acceptance record =====
// M9-6A: _reconstructDelivery migrated to src/application/runDelivery.js
// so CLI and MCP share one reconstruction algorithm.

/**
 * runs delivery <runId> — Lead acceptance record.
 *
 * Read-only query:
 *   runs delivery <runId> [--format json]
 *
 * Read-only bounded wait (M11-10):
 *   runs delivery <runId> --wait-ms N [--format json]
 *
 * Decision:
 *   runs delivery <runId> --accept --reason-file FILE [--format json]
 *   runs delivery <runId> --reject --reason-file FILE [--format json]
 *
 * Records a Lead verdict via transcript-backed atomic first-decision-wins.
 * Never manufactures the verdict or infers semantic correctness.
 *
 * M9-6A: query/decision logic delegated to shared application services
 * (getRunDelivery / decideRunDelivery). CLI owns argv parsing + text/JSON I/O only.
 * M11-10: --wait-ms delegates to the SAME readiness/wait service the MCP
 * run_delivery tool uses (getRunDeliveryReadiness); the CLI never re-parses the
 * transcript or invents its own readiness algorithm.
 */

/**
 * Coerce the argv `--wait-ms` value into an integer in the shared bounds.
 * Validates at the CLI boundary using the SAME constants the application
 * service and the MCP zod schema are built from, so an invalid value is rejected
 * before any service is called (and before the transcript is read).
 * @private
 */
function _coerceWaitMs(raw) {
  // parseOptions yields either the literal true (flag with no value) or a string.
  if (raw === true || typeof raw !== "string") {
    throw new Error("--wait-ms requires an integer value");
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < DELIVERY_WAIT_MS_MIN || n > DELIVERY_WAIT_MS_MAX) {
    throw new Error(
      `--wait-ms must be an integer in [${DELIVERY_WAIT_MS_MIN}, ${DELIVERY_WAIT_MS_MAX}], got: ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/** Human-readable rendering of a readiness result (non-json --wait-ms output). */
function _printReadinessText(result) {
  console.log(`Run: ${result.runId} (${result.terminalState})`);
  console.log(
    `Readiness: ${result.readiness}${result.waitReturnedEarly ? " (settled)" : " (wait expired)"}`,
  );
  // TD-137②：等待窗到期（waitReturnedEarly:false）时服务附带的同族上限交叉
  // 提示——settled 路径服务不带该字段，此处自然不打印。
  if (result.waitWindowHint) {
    console.log(`Hint: ${result.waitWindowHint}`);
  }
  if (result.deliveryAvailable) {
    console.log(`Delivery: ${result.deliveryRef?.deliveryCommit ?? "(none)"}`);
    console.log(`Verification: ${result.verification?.status ?? "(none)"}`);
    console.log(`Acceptance: ${result.acceptance?.status ?? "(none)"}`);
  } else if (result.deliveryFailure) {
    console.log(`Packaging failed: ${result.deliveryFailure.code}`);
  } else if (result.deliveryRequested) {
    console.log("Delivery: (requested, not packaged yet)");
  } else {
    console.log("Delivery: (not requested)");
  }
}

async function runsDeliveryCommand(args, config, hostDeps) {
  // M11-3C: `runs delivery review` sub-command — must be recognized BEFORE the
  // ordinary query/accept/reject parsing so "review" is not mistaken for a runId.
  if (args[0] === "review") {
    await runsDeliveryReviewCommand(args.slice(1), config, hostDeps);
    return;
  }
  // M12-6 FR-07: `runs delivery reverify` sub-command — recognized BEFORE the
  // ordinary query/accept/reject parsing so "reverify" is not mistaken for a
  // runId. Same dispatch discipline as "review".
  if (args[0] === "reverify") {
    await runsDeliveryReverifyCommand(args.slice(1), config, hostDeps);
    return;
  }

  const options = parseOptions(args);
  const runDir = resolve(options.runDir ?? config.runDir);
  const [runId] = args.filter((a) => !a.startsWith("--"));
  if (!runId) {
    throw new Error("runs delivery requires <runId>");
  }

  // Read-only query (no --accept / --reject)
  if (!options.accept && !options.reject) {
    // M11-10: optional bounded, read-only wait. The CLI delegates to the SAME
    // readiness/wait service the MCP run_delivery tool uses — no second
    // algorithm, no direct transcript parsing, zero transcript append.
    if (options.waitMs !== undefined) {
      const waitMs = _coerceWaitMs(options.waitMs);
      const readinessService = hostDeps?.getRunDeliveryReadinessFn ?? getRunDeliveryReadiness;
      const result = await readinessService({ runId, runDir, waitMs });
      if (options.format === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        _printReadinessText(result);
      }
      return;
    }
    const view = await getRunDelivery({ runId, runDir });
    if (options.format === "json") {
      console.log(JSON.stringify(view, null, 2));
    } else {
      console.log(`Run: ${view.runId} (${view.terminalState})`);
      if (view.deliveryAvailable) {
        console.log(`Delivery: ${view.deliveryRef.deliveryCommit}`);
        console.log(`Verification: ${view.verification.status}`);
        console.log(`Acceptance: ${view.acceptance.status}`);
      } else if (view.deliveryFailure) {
        console.log(`Packaging failed: ${view.deliveryFailure.code}`);
      } else if (view.deliveryRequested) {
        console.log("Delivery: (requested, not packaged yet)");
      } else {
        console.log("Delivery: (not requested)");
      }
    }
    return;
  }

  // Decision mode
  if (options.accept && options.reject) {
    throw new Error("--accept and --reject are mutually exclusive");
  }
  const decision = options.accept ? "accepted" : "rejected";

  // Reason file is mandatory
  if (!options.reasonFile) {
    throw new Error("--reason-file is required for --accept or --reject");
  }
  let rawReason;
  try {
    rawReason = await readFile(resolve(options.reasonFile), "utf8");
  } catch {
    throw new Error(`--reason-file could not be read: ${options.reasonFile}`);
  }
  const reason = rawReason.trim();
  if (reason.length === 0) {
    throw new Error("--reason-file must contain non-empty UTF-8 text");
  }

  // Delegate to shared service — tryAppendDecision does in-lock validation.
  const result = await decideRunDelivery({ runId, runDir, decision, reason });

  if (options.format === "json") {
    if (result.accepted) {
      console.log(JSON.stringify({
        decisionAccepted: true,
        delivery: result.event.delivery,
        deliveryCommit: result.event.deliveryCommit,
        reason: result.event.reason,
      }, null, 2));
    } else {
      console.log(JSON.stringify({
        decisionAccepted: false,
        existing: result.existing,
      }, null, 2));
    }
  } else {
    if (result.accepted) {
      console.log(`Decision recorded: ${decision} for ${result.event.deliveryCommit}`);
    } else {
      console.log(`Decision not recorded: existing ${result.existing.status} for ${result.existing.deliveryCommit}`);
    }
  }
}
