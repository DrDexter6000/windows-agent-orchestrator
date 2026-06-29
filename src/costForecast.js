// costForecast.js
//
// M8-4：成本预演（🟢 工具域 bonus，低优先级）。
//
// 发射前给 Lead 一个估费/估时区间，省"跑起来才发现烧爆"。算法克制：
// 取该 agent 历史 run 的中位数 ± min/max 区间；无历史则 insufficient_data（不编造）。
// 不做"阻断发射"的硬 gate（用户定 bonus 非必须）——只算账，不拦发射。
//
// 复用 metrics 的形态：history 每项 = aggregateRunMetrics 返回值（tokens/costUsd?/durationMs）。

/**
 * 取数组中位数（偶数个取中间两数均值）。空数组 → undefined。
 */
function median(nums) {
  if (nums.length === 0) return undefined;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 对一组历史样本算 { median, min, max }。无样本 → undefined。
 */
function stats(nums) {
  if (nums.length === 0) return undefined;
  const sorted = [...nums].sort((a, b) => a - b);
  return { median: median(nums), min: sorted[0], max: sorted[sorted.length - 1] };
}

/**
 * 预测一组 agent 的 token/cost/duration 区间。
 *
 * @param {object} opts
 * @param {string[]} opts.agentIds - 要预测的 agent id 列表。
 * @param {object} opts.history - { [agentId]: Array<{tokens:{input,output?}, costUsd?, durationMs?}> }。
 *   每项形态 = aggregateRunMetrics 返回值。
 * @returns {{agents: object, total: object}}
 *   agents[id] = { tokens:{input:{median,min,max}}, cost:{median,min,max}|{unavailable:true},
 *                  durationMs:{median,min,max}, sampleSize }
 *                | { insufficient_data: true }
 *   total = 合计中位数 { medianCostUsd, medianTokens, medianDurationMs } | { insufficient_data:true }
 */
export function forecastCost({ agentIds, history }) {
  const ids = Array.isArray(agentIds) ? agentIds : [];
  const hist = history ?? {};
  const agents = {};
  const totalCosts = [];
  const totalTokens = [];
  const totalDurations = [];

  for (const id of ids) {
    const samples = hist[id] ?? [];
    if (samples.length === 0) {
      agents[id] = { insufficient_data: true };
      continue;
    }
    const inputTokens = samples.map((s) => s.tokens?.input).filter((n) => typeof n === "number");
    const outputTokens = samples.map((s) => s.tokens?.output).filter((n) => typeof n === "number");
    const costs = samples.map((s) => s.costUsd).filter((n) => typeof n === "number");
    const durations = samples.map((s) => s.durationMs).filter((n) => typeof n === "number");

    const tokenStats = {
      input: stats(inputTokens),
      ...(outputTokens.length > 0 ? { output: stats(outputTokens) } : {}),
    };
    const costStats = costs.length > 0 ? stats(costs) : { unavailable: true };
    const durStats = durations.length > 0 ? stats(durations) : undefined;

    agents[id] = {
      tokens: tokenStats,
      cost: costStats,
      ...(durStats ? { durationMs: durStats } : {}),
      sampleSize: samples.length,
    };

    // 累计到 total（用各 agent 中位数）
    if (tokenStats.input) totalTokens.push(tokenStats.input.median);
    if (costStats.median !== undefined) totalCosts.push(costStats.median);
    if (durStats) totalDurations.push(durStats.median);
  }

  // total：所有有数据的 agent 的中位数之和；全部 insufficient → insufficient
  const hasAnyData = totalCosts.length > 0 || totalTokens.length > 0 || totalDurations.length > 0;
  if (!hasAnyData) {
    return { agents, total: { insufficient_data: true } };
  }
  return {
    agents,
    total: {
      ...(totalCosts.length > 0 ? { medianCostUsd: totalCosts.reduce((a, b) => a + b, 0) } : {}),
      ...(totalTokens.length > 0 ? { medianTokens: totalTokens.reduce((a, b) => a + b, 0) } : {}),
      ...(totalDurations.length > 0 ? { medianDurationMs: totalDurations.reduce((a, b) => a + b, 0) } : {}),
    },
  };
}
