// src/commands/runs.js
//
// TD-98 阶段 2b：runs command family 从 cli.js 拆出（行为不变，纯搬迁）。
//
// 命令族：runs list / summary / prune / grep / metrics / scorecard /
//         dashboard / diagnose
//
// 依赖：
//   - 外部模块：../transcript.js（readTranscript/findState）、../metrics.js
//     （aggregateRunMetrics/aggregateSummary/formatDuration）、../diagnosis.js
//     （diagnoseFailure）、../waoDir.js
//     （getWaoDir）、../waoDeclare.js（summarizeDeclares）、../waoStage.js
//     （summarizeStages）
//   - 共享工具：./shared.js（parseOptions/resolveTargetCwd，纯函数）
//   - node built-in：fs/promises（readdir/unlink）、fs（existsSync）、path（join/resolve）
//
// 本模块内部 helper：parseDuration（runs prune 专用）、loadRunFiles（runs 族专用）。

import { readdir, unlink, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { readTranscript, findState, REVERIFY_FAILURE_CODES } from "../transcript.js";
import { aggregateRunMetrics, aggregateSummary, formatDuration } from "../metrics.js";
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
import { getWaoDir } from "../waoDir.js";
import { summarizeDeclares } from "../waoDeclare.js";
import { summarizeStages } from "../waoStage.js";
import { parseOptions, resolveTargetCwd } from "./shared.js";

async function runsCommand(args, config) {
  const [sub, ...tail] = args;
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
  if (sub === "forecast") {
    throw new Error("runs forecast has been removed; use observed run facts instead of token estimates");
  }
  await runsListCommand(args, config);
}

async function loadRunFiles(runDir) {
  if (!existsSync(runDir)) return [];
  const files = await readdir(runDir);
  return files.filter((f) => f.endsWith(".jsonl")).sort();
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
    const state = findState(events);
    const metricsEv = events.find((e) => e.type === "run.metrics");
    const tokens = metricsEv?.tokens ?? {};
    const costUsd = typeof metricsEv?.costUsd === "number" ? metricsEv.costUsd : undefined;

    // 证据：scorecard.checked.passed === true → 有证据；否则看 warn 事件判定。
    const scChecked = events.find((e) => e.type === "scorecard.checked");
    const hasWarn = events.some((e) => e.type === "scorecard.warn");
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

  // CLI is human/ops — no workspace authorization.
  // knownAgentIds = [] so raw agentId is preserved (CLI doesn't validate).
  const result = await listRuns({
    runDir,
    agentId: options.agent,
    latest: latestN,
    knownAgentIds: [],
    validateAgentIds: false, // CLI preserves raw agentId
  });

  // When --latest is NOT set, restore original file-name ascending order.
  // (The service sorts by updatedAt desc by default; CLI original kept
  // file-name order without --latest.)
  if (!latestN) {
    result.runs.sort((a, b) => a.runId.localeCompare(b.runId));
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
  const options = parseOptions(args);
  const runDir = resolve(options.runDir ?? config.runDir);
  const jsonlFiles = await loadRunOnlyFiles(runDir);
  if (jsonlFiles.length === 0) {
    console.log("No runs found.");
    return;
  }
  const counts = {};
  let latestTs = null;
  for (const file of jsonlFiles) {
    const events = await readTranscript(join(runDir, file));
    const state = findState(events);
    counts[state] = (counts[state] ?? 0) + 1;
    const last = events.at(-1);
    if (last?.ts && (!latestTs || last.ts > latestTs)) {
      latestTs = last.ts;
    }
  }
  console.log(`Total runs: ${jsonlFiles.length}`);
  for (const [state, count] of Object.entries(counts).sort()) {
    console.log(`${state}: ${count}`);
  }
  if (latestTs) {
    console.log(`Latest: ${latestTs}`);
  }
}

// runs prune 专用：把 "7d"/"24h"/"30m" 解析为毫秒。
function parseDuration(input) {
  const match = input.match(/^(\d+)(d|h|m|s)$/);
  if (!match) {
    throw new Error(`Invalid duration: ${input}. Use <number><d|h|m|s> (e.g. 7d, 24h, 30m)`);
  }
  const value = Number(match[1]);
  const unit = match[2];
  const multipliers = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
  return value * multipliers[unit];
}

async function runsPruneCommand(args, config) {
  const options = parseOptions(args);
  if (!options.olderThan) {
    throw new Error("runs prune requires --older-than <duration> (e.g. 7d, 24h, 30m)");
  }
  const cutoff = Date.now() - parseDuration(options.olderThan);
  const runDir = resolve(options.runDir ?? config.runDir);
  const jsonlFiles = await loadRunFiles(runDir);
  if (jsonlFiles.length === 0) {
    console.log("No runs found.");
    return;
  }
  let pruned = 0;
  let kept = 0;
  for (const file of jsonlFiles) {
    const events = await readTranscript(join(runDir, file));
    const last = events.at(-1);
    const ts = last?.ts ? new Date(last.ts).getTime() : 0;
    if (ts < cutoff) {
      await unlink(join(runDir, file));
      console.log(`Pruned ${file}`);
      pruned += 1;
    } else {
      kept += 1;
    }
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
    console.log("No runs found.");
    return;
  }
  const re = new RegExp(pattern, "i");
  let matches = 0;
  for (const file of jsonlFiles) {
    const runId = file.replace(/\.jsonl$/, "");
    const events = await readTranscript(join(runDir, file));
    for (const event of events) {
      if (re.test(JSON.stringify(event))) {
        console.log(`${runId}\t${event.type}\t${event.ts ?? ""}`);
        matches += 1;
        break;
      }
    }
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
    const s = aggregateSummary(allEvents);
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
  const filePath = join(runDir, `${runId}.jsonl`);
  const events = await readTranscript(filePath);
  const m = aggregateRunMetrics(events);
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
  const filePath = join(runDir, `${runId}.jsonl`);
  const events = await readTranscript(filePath);
  const scEvent = events.find((e) => e.type === "scorecard.checked");
  if (!scEvent) {
    const started = events.find((e) => e.type === "run.started");
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
  const d = await getRunDiagnosis({ runId, runDir });
  if (options.format === "json") {
    // CLI JSON shape unchanged: {runId, category, evidence} — no state/terminal.
    console.log(JSON.stringify({ runId: d.runId, category: d.category, evidence: d.evidence }, null, 2));
    return;
  }
  console.log(`runId:    ${d.runId}`);
  console.log(`category: ${d.category}`);
  if (d.evidence.length > 0) {
    console.log(`evidence:`);
    for (const e of d.evidence) {
      console.log(`  [${e.eventType}] ${e.fact}`);
    }
  } else if (d.category === "none") {
    console.log(`(no failure to diagnose — run completed successfully)`);
  } else {
    console.log(`(no concrete evidence signal; review transcript manually)`);
  }
}

/**
 * M8-2 实时仪表盘：单一视图聚合所有 run 的状态/token/费用/证据，异常标红。
 * 🟢 工具域：只读聚合，绝不 retry/stop/改状态。省 Lead 在多命令间轮询的精力。
 * 支持：--watch N（N 秒重刷）/ --format json / --agent <id> 过滤 / --latest N 取最近 N 个。
 */
export async function runsDashboardCommand(args, config) {
  const options = parseOptions(args);
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
      runs.sort((a, b) => (b.events.at(-1)?.ts ?? "").localeCompare(a.events.at(-1)?.ts ?? ""));
      runs = runs.slice(0, latestN);
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

  // cursor must be base64url if provided.
  if (flags.cursor !== undefined) {
    if (!/^[A-Za-z0-9_-]+$/.test(flags.cursor)) {
      throw new Error("--cursor must be a valid opaque token");
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
  const raw = await service({
    runId,
    runDir,
    authorizedWorkspaceRoot: cwd,
    fileIndex,
    ...(flags.cursor !== undefined ? { cursor: flags.cursor } : {}),
  });

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
  let setupCommands;
  if (flags.setupCommandsFile !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(resolve(flags.setupCommandsFile), "utf8"));
    } catch {
      throw new Error(`--setup-commands-file must be valid UTF-8 JSON: ${flags.setupCommandsFile}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error("--setup-commands-file must contain a JSON array of strings");
    }
    if (parsed.length > REVERIFY_SETUP_COMMANDS_LIMIT) {
      throw new Error(`--setup-commands-file exceeds ${REVERIFY_SETUP_COMMANDS_LIMIT} commands`);
    }
    const out = [];
    for (const cmd of parsed) {
      if (typeof cmd !== "string") {
        throw new Error("--setup-commands-file must contain only strings");
      }
      if (cmd.trim().length === 0) {
        throw new Error("--setup-commands-file must not contain blank commands");
      }
      if (cmd.length > REVERIFY_SETUP_COMMAND_MAX_LENGTH) {
        throw new Error(`setup command exceeds ${REVERIFY_SETUP_COMMAND_MAX_LENGTH} characters`);
      }
      out.push(cmd);
    }
    setupCommands = out;
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

export { runsCommand, runsDeliveryCommand };

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
