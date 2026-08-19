import { findState, findLatest, findLatestBound, findFirstBound } from "./transcript.js";

/**
 * R18（TD-128 W1）：观测报表面的 runId 绑定作用域——单一定义处。
 *
 * 注册危害（TD-128 P3 观测面）：append-only transcript 尾部的伪造/外 run 行可
 * 污染 tokens/cost/duration/scorecard 报表值。本函数把报表读取收窄到「请求
 * runId 的信封绑定事件」；首/末条序语义仍由 transcript.js 的绑定读取器 SSOT
 * 承担（findFirstBound/findLatestBound），此处只定义「何时绑定」。
 *
 * 返回值：
 *   - 绑定数组：提供了 runId 且 transcript 存在信封（任一事件带 runId 字段）。
 *   - null：无法绑定——未提供 runId（R19 起 aggregateSummary 的 --summary 调用
 *     方逐文件传入文件名 stem 作为权威 runId，其余调用方缺省），或【全无信封的
 *     legacy transcript】（pre-envelope，事件一律无 runId 字段）。null 时调用方
 *     保持历史无绑定读法。
 *
 * legacy 行为选择（真实判据 = 该面有无既有 pre-envelope 契约钉住，而非
 * "观测面一律降级不设门"——R20-C 勘误，auditor P3-1）：全无信封的 legacy
 * transcript 不拒绝、不出空报表——保持既有读法照常出报表
 * （test/isolation-infra/cli.test.js 的 pre-envelope 三态 JSON 契约钉住该行
 * 为；本函数服务的报表/观测面恰属此类）。任一事件带信封（含伪造尾行）即
 * 严格绑定：外 run/无信封行不可见，宁可让报表可见地缺事实（pending/无
 * tokens），也不静默采信不可归属的值。对照面：同为纯观测的 runDelivery
 * terminalState（R20 M5）无 pre-envelope 契约钉住旧读法，故取严格档——
 * 不可归属直接降 pending、无 legacy 回退；两档分野由"既有契约是否钉住"
 * 决定，不由"是否观测面"决定（M5 纯观测却严格档即为反例）。绑定只杀跨
 * run 注入/错读；同 runId 伪造追加 = runs/ 写权限攻击面，读侧无解
 * （transcript.js 绑定读取器同口径）。
 *
 * @param {Array} events transcript 事件序列
 * @param {string|null} runId 调用方权威 runId（CLI 命令经 isValidRunId 后的用户输入）
 * @returns {Array|null} 绑定事件子集；null = 无法绑定（调用方退回历史读法）
 */
export function boundReportScope(events, runId) {
  if (typeof runId !== "string" || runId.length === 0) return null;
  if (!Array.isArray(events) || !events.some((e) => e && typeof e.runId === "string")) return null;
  return events.filter((e) => e && e.runId === runId);
}

/**
 * 从单个 run 的事件序列聚合指标（M4-4）。
 *
 * R18（TD-128 W1）：三处事实读取（state/run.metrics/run.started）与 duration
 * 终点（末事件 ts）全部经 boundReportScope 收窄——外 run 尾条的 state_change/
 * run.metrics/ts 不再污染报表。序语义保持既有纪律：run.metrics 末条
 * （metrics.test.js 钉住的"取最后一条"）、run.started 首条（R12-C 首写纪律）。
 * 全绑定合法 transcript 上过滤器恒等 → 行为零变化。
 *
 * @param {Array} events transcript 事件序列
 * @param {string|null} [runId] 权威 runId；缺省保持历史无绑定读法
 * @returns {{state, tokens, costUsd?, durationMs}}
 */
export function aggregateRunMetrics(events, runId = null) {
  const scope = boundReportScope(events, runId);
  const scoped = scope ?? events;
  const state = findState(scoped);
  const metricsEvent = scope
    ? findLatestBound(scoped, "run.metrics", runId)
    : findLatest(scoped, "run.metrics");
  const tokens = metricsEvent?.tokens ?? {};
  const costUsd = metricsEvent?.costUsd;

  // duration: run.started.ts → 最后【绑定】事件的 ts
  const started = scope
    ? findFirstBound(scoped, "run.started", runId)
    : scoped.find((e) => e.type === "run.started");
  const last = scoped.at(-1);
  let durationMs = 0;
  if (started?.ts && last?.ts) {
    durationMs = new Date(last.ts).getTime() - new Date(started.ts).getTime();
  }

  const result = { state, tokens, durationMs };
  if (typeof costUsd === "number") result.costUsd = costUsd;
  return result;
}

/**
 * 跨 run 聚合（M4-4）。
 *
 * R19（TD-128 W1 报表污染类；L1 勘误：原注释误标 W2——按 TD-128 登记表真实
 * 编号，--summary 逐文件聚合属 R18 W1 报表污染类同族）：--summary 调用方逐文件读取时【文件名 stem 即权威 runId】，
 * 经 runIds 逐 run 传入绑定读者（boundReportScope 单一定义处复用，不新写）——
 * 单文件内的外 run/伪造尾条不再污染聚合。runIds 缺省（历史调用方/测试）时逐
 * run 无绑定（历史读法）；提供了 stem 时交由 boundReportScope 自身规则：全无
 * 信封的 legacy transcript 保持历史无绑定读法，任一事件带信封即严格绑定（外
 * run/无信封行不可见——宁可可见地缺事实）。全绑定合法 transcript 上过滤器恒
 * 等 → 行为零变化。
 *
 * @param {Array<Array>} runs 多个 run 的事件序列数组
 * @param {string[]|null} [runIds] 与 runs 等长的权威 runId 数组（文件名 stem）；
 *   缺省逐 run 无绑定（历史读法）
 * @returns {{totalRuns, byState, successRate, totalTokens, avgDurationMs}}
 */
export function aggregateSummary(runs, runIds = null) {
  if (runs.length === 0) {
    return { totalRuns: 0, byState: {}, successRate: 0, totalTokens: {}, avgDurationMs: 0 };
  }
  const bound = Array.isArray(runIds) && runIds.length === runs.length;
  const byState = {};
  let successCount = 0;
  const totalTokens = {};
  let totalDuration = 0;

  for (let i = 0; i < runs.length; i += 1) {
    const m = aggregateRunMetrics(runs[i], bound ? runIds[i] : null);
    byState[m.state] = (byState[m.state] ?? 0) + 1;
    if (m.state === "completed") successCount += 1;
    totalDuration += m.durationMs;
    for (const [key, val] of Object.entries(m.tokens)) {
      totalTokens[key] = (totalTokens[key] ?? 0) + val;
    }
  }

  return {
    totalRuns: runs.length,
    byState,
    successRate: successCount / runs.length,
    totalTokens,
    avgDurationMs: Math.round(totalDuration / runs.length),
  };
}

/** 格式化毫秒为人读时长 */
export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m${sec}s`;
}
