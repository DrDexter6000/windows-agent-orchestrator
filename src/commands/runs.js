// src/commands/runs.js
//
// TD-98 阶段 2b：runs command family 从 cli.js 拆出（行为不变，纯搬迁）。
//
// 命令族：runs list / summary / prune / grep / metrics / scorecard /
//         dashboard / diagnose / forecast
//
// 依赖：
//   - 外部模块：../transcript.js（readTranscript/findState）、../metrics.js
//     （aggregateRunMetrics/aggregateSummary/formatDuration）、../diagnosis.js
//     （diagnoseFailure）、../costForecast.js（forecastCost）、../waoDir.js
//     （getWaoDir）、../waoDeclare.js（summarizeDeclares）、../waoStage.js
//     （summarizeStages）
//   - 共享工具：./shared.js（parseOptions/resolveTargetCwd，纯函数）
//   - node built-in：fs/promises（readdir/unlink）、fs（existsSync）、path（join/resolve）
//
// 本模块内部 helper：parseDuration（runs prune 专用）、loadRunFiles（runs 族专用）。

import { readdir, unlink, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { readTranscript, findState } from "../transcript.js";
import { aggregateRunMetrics, aggregateSummary, formatDuration } from "../metrics.js";
import { diagnoseFailure } from "../diagnosis.js";
// M9-5A: diagnosis delegated to shared application service.
import { getRunDiagnosis } from "../application/runDiagnosis.js";
import { forecastCost } from "../costForecast.js";
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
    await runsForecastCommand(tail, config);
    return;
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
 * list/summary/metrics --summary/dashboard/forecast 使用此函数——
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
  const jsonlFiles = await loadRunOnlyFiles(runDir);
  if (jsonlFiles.length === 0) {
    console.log("No runs found.");
    return;
  }
  // N3/N5 修复：加 --agent（按 agentId 过滤）和 --latest N（取最近 N 个，按最新事件 ts 倒序）。
  // 原 bug：runs list 列历史所有 run，lead 找"刚才那次"费劲。
  const agentFilter = options.agent;
  const latestN = options.latest ? Number(options.latest) : null;

  // 收集每个 run 的摘要（runId + state + agentId + 最新 ts）
  const summaries = [];
  for (const file of jsonlFiles) {
    const runId = file.replace(/\.jsonl$/, "");
    const events = await readTranscript(join(runDir, file));
    const agentId = events[0]?.agentId;
    if (agentFilter && agentId !== agentFilter) continue;
    const state = findState(events);
    const lastTs = events.at(-1)?.ts ?? "";
    summaries.push({ runId, state, agentId, lastTs });
  }

  // --latest N：按最新事件 ts 倒序取 N 个（ts 不可比时退回 runId 字典序）
  if (latestN && latestN > 0) {
    summaries.sort((a, b) => (b.lastTs ?? "").localeCompare(a.lastTs ?? ""));
    summaries.splice(latestN);
  }

  if (summaries.length === 0) {
    console.log(agentFilter ? `No runs found for agent "${agentFilter}".` : "No runs found.");
    return;
  }
  for (const s of summaries) {
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
 * M8-4 成本预演：runs forecast --agents a,b [--run-dir DIR]（🟢 工具域 bonus）。
 * 基于历史 run 的 token/cost/duration 中位数 ± 区间，给 Lead 发射前估费/估时。
 * 不阻断发射，只算账。无历史 → insufficient_data（不编造）。
 */
async function runsForecastCommand(args, config) {
  const options = parseOptions(args);
  const runDir = resolve(options.runDir ?? config.runDir);
  const agentIds = options.agents
    ? String(options.agents).split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  if (agentIds.length === 0) {
    throw new Error("runs forecast requires --agents a,b (comma-separated agent ids)");
  }

  // 从 runs 目录构建 history：读每个 jsonl，按 agentId 分组，算 aggregateRunMetrics。
  const jsonlFiles = await loadRunOnlyFiles(runDir);
  const history = {};
  for (const f of jsonlFiles) {
    const events = await readTranscript(join(runDir, f));
    const agentId = events[0]?.agentId;
    if (!agentId) continue;
    const m = aggregateRunMetrics(events);
    (history[agentId] ??= []).push(m);
  }

  const r = forecastCost({ agentIds, history });
  if (options.format === "json") {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  for (const id of agentIds) {
    const a = r.agents[id];
    if (a.insufficient_data) {
      console.log(`${id}: (insufficient data — no history)`);
      continue;
    }
    const c = a.cost?.unavailable ? "n/a" : `$${a.cost.median.toFixed(4)} [${a.cost.min.toFixed(4)}–${a.cost.max.toFixed(4)}]`;
    const t = a.tokens?.input ? `${a.tokens.input.median} [${a.tokens.input.min}–${a.tokens.input.max}]` : "n/a";
    console.log(`${id}: cost=${c}  tokens(in)=${t}  samples=${a.sampleSize}`);
  }
  const tot = r.total;
  if (tot.insufficient_data) {
    console.log(`total: (insufficient data)`);
  } else {
    const parts = [];
    if (tot.medianCostUsd !== undefined) parts.push(`cost=$${tot.medianCostUsd.toFixed(4)}`);
    if (tot.medianTokens !== undefined) parts.push(`tokens=${tot.medianTokens}`);
    console.log(`total: ${parts.join("  ")}`);
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

export { runsCommand, runsDeliveryCommand };

// ===== TD-103 Phase 3C-2: Lead acceptance record =====

/**
 * Reconstruct the latest DeliveryRef from transcript events.
 * Looks for delivery_created, then any verification event (which carries
 * an updated DeliveryRef), and checks for existing accepted/rejected events.
 * @param {object[]} events
 * @returns {{latestRef: object|null, decisionEvent: object|null, deliveryCommit: string|null}}
 */
function _reconstructDelivery(events) {
  // Find the latest delivery_created event (has the initial DeliveryRef)
  let latestRef = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === "run.delivery_created" && events[i].delivery) {
      latestRef = events[i].delivery;
      break;
    }
  }
  // If there's a verification event, it carries an updated DeliveryRef
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if ((e.type === "run.delivery_verification_passed"
      || e.type === "run.delivery_verification_failed"
      || e.type === "run.delivery_verification_unavailable")
      && e.delivery) {
      latestRef = e.delivery;
      break;
    }
  }
  // Check for existing decision event
  let decisionEvent = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.type === "run.delivery_accepted" || e.type === "run.delivery_rejected") {
      decisionEvent = e;
      break;
    }
  }
  // If a decision event exists, it carries the final DeliveryRef with updated acceptance
  if (decisionEvent?.delivery) {
    latestRef = decisionEvent.delivery;
  }
  const deliveryCommit = latestRef?.deliveryCommit ?? null;
  return { latestRef, decisionEvent, deliveryCommit };
}

/**
 * runs delivery <runId> — Lead acceptance record.
 *
 * Read-only query:
 *   runs delivery <runId> [--format json]
 *
 * Decision:
 *   runs delivery <runId> --accept --reason-file FILE [--format json]
 *   runs delivery <runId> --reject --reason-file FILE [--format json]
 *
 * Records a Lead verdict via transcript-backed atomic first-decision-wins.
 * Never manufactures the verdict or infers semantic correctness.
 */
async function runsDeliveryCommand(args, config) {
  const options = parseOptions(args);
  const runDir = resolve(options.runDir ?? config.runDir);
  const [runId] = args.filter((a) => !a.startsWith("--"));
  if (!runId) {
    throw new Error("runs delivery requires <runId>");
  }
  const filePath = join(runDir, `${runId}.jsonl`);
  const events = await readTranscript(filePath);
  const terminalState = findState(events);
  const { latestRef, decisionEvent, deliveryCommit } = _reconstructDelivery(events);

  // No committed delivery → fail closed
  if (!latestRef || !deliveryCommit) {
    throw new Error(`No committed delivery found for run ${runId}`);
  }

  const verificationStatus = latestRef.verification?.status ?? "pending";
  const acceptanceStatus = decisionEvent
    ? (decisionEvent.type === "run.delivery_accepted" ? "accepted" : "rejected")
    : (latestRef.acceptance?.status ?? "pending");

  // Read-only query (no --accept / --reject)
  if (!options.accept && !options.reject) {
    const view = {
      runId,
      terminalState,
      deliveryRef: latestRef,
      verification: {
        status: verificationStatus,
        ...(latestRef.verification?.failureCode ? { failureCode: latestRef.verification.failureCode } : {}),
      },
      acceptance: {
        status: acceptanceStatus,
        ...(decisionEvent ? { decisionEvent: { type: decisionEvent.type, reason: decisionEvent.reason } } : {}),
      },
    };
    if (options.format === "json") {
      console.log(JSON.stringify(view, null, 2));
    } else {
      console.log(`Run: ${runId} (${terminalState})`);
      console.log(`Delivery: ${deliveryCommit}`);
      console.log(`Verification: ${verificationStatus}`);
      console.log(`Acceptance: ${acceptanceStatus}`);
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

  // Atomic first-decision-wins via transcript primitive.
  // Durable preconditions (exactly-one delivery, matching verification commit,
  // verification final status, terminal state) are re-checked IN-LOCK by
  // tryAppendDecision — the CLI does not gate on lock-external reads.
  const { JsonlTranscript } = await import("../transcript.js");
  const transcript = new JsonlTranscript(filePath, {
    runId,
    agentId: events[0]?.agentId ?? "unknown",
    initialSeq: events[events.length - 1]?.seq ?? 0,
  });
  const result = await transcript.tryAppendDecision({
    decision,
    reason,
  });

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
