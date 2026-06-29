import { findState, findLatest } from "./transcript.js";

/**
 * 从单个 run 的事件序列聚合指标（M4-4）。
 *
 * @param {Array} events transcript 事件序列
 * @returns {{state, tokens, costUsd?, durationMs}}
 */
export function aggregateRunMetrics(events) {
  const state = findState(events);
  const metricsEvent = findLatest(events, "run.metrics");
  const tokens = metricsEvent?.tokens ?? {};
  const costUsd = metricsEvent?.costUsd;

  // duration: run.started.ts → 最后事件的 ts
  const started = events.find((e) => e.type === "run.started");
  const last = events.at(-1);
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
 * @param {Array<Array>} runs 多个 run 的事件序列数组
 * @returns {{totalRuns, byState, successRate, totalTokens, avgDurationMs}}
 */
export function aggregateSummary(runs) {
  if (runs.length === 0) {
    return { totalRuns: 0, byState: {}, successRate: 0, totalTokens: {}, avgDurationMs: 0 };
  }
  const byState = {};
  let successCount = 0;
  const totalTokens = {};
  let totalDuration = 0;

  for (const events of runs) {
    const m = aggregateRunMetrics(events);
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
