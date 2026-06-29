// costForecast.test.js
//
// M8-4：成本预演（🟢 工具域 bonus，低优先级）。
//
// 设计：forecastCost 基于历史 run 的 token/cost/duration 统计，给 Lead 发射前的
// 估费/估时区间。算法克制：取该 agent 历史 run 的中位数 ± min/max 区间；
// 无历史则 insufficient_data（不编造）。不做"阻断发射"的硬 gate（用户定 bonus 非必须）。
//
// 输入：{ agentIds: string[], history: { [agentId]: Array<{tokens, costUsd?, durationMs?}> } }
//   history 的每项形态 = aggregateRunMetrics 的返回（复用，不重新算）。
// 输出：{ agents: { [agentId]: { median, min, max, sampleSize } | { insufficient_data: true } },
//         total: { medianCostUsd, medianTokens, medianDurationMs } }

import { test } from "node:test";
import assert from "node:assert/strict";
import { forecastCost } from "../src/costForecast.js";

// 有历史的样本（3 个 run，token/cost/duration 各不同）
const history = {
  coder_hq: [
    { tokens: { input: 4000, output: 100 }, costUsd: 0.04, durationMs: 60000 },
    { tokens: { input: 5000, output: 200 }, costUsd: 0.06, durationMs: 120000 },
    { tokens: { input: 6000, output: 300 }, costUsd: 0.08, durationMs: 180000 },
  ],
};

test("M8-4: 有历史的 agent 返回 token/cost/duration 中位数 + min/max 区间", () => {
  const r = forecastCost({ agentIds: ["coder_hq"], history });
  const a = r.agents.coder_hq;
  assert.ok(a, "应有该 agent 的预测");
  assert.equal(a.insufficient_data, undefined, "有历史不应 insufficient_data");
  // 中位数：cost [0.04,0.06,0.08] → 0.06；tokens input [4000,5000,6000] → 5000
  assert.equal(a.cost.median, 0.06);
  assert.equal(a.cost.min, 0.04, "min 区间");
  assert.equal(a.cost.max, 0.08, "max 区间");
  assert.equal(a.tokens.input.median, 5000);
  assert.equal(a.tokens.input.min, 4000);
  assert.equal(a.tokens.input.max, 6000);
  assert.equal(a.durationMs.median, 120000);
  assert.equal(a.sampleSize, 3);
});

test("M8-4: 无历史 agent 返回 insufficient_data（不编造）", () => {
  const r = forecastCost({ agentIds: ["new_worker"], history: { coder_hq: history.coder_hq } });
  const a = r.agents.new_worker;
  assert.equal(a.insufficient_data, true, "无历史应 insufficient_data");
  assert.equal(a.median, undefined, "不应编造中位数");
});

test("M8-4: 多 agent 聚合 + total 合计中位数", () => {
  const history2 = {
    coder_hq: [
      { tokens: { input: 4000, output: 100 }, costUsd: 0.04, durationMs: 60000 },
      { tokens: { input: 6000, output: 300 }, costUsd: 0.08, durationMs: 180000 },
    ],
    researcher: [
      { tokens: { input: 2000, output: 500 }, costUsd: 0.02, durationMs: 90000 },
    ],
  };
  const r = forecastCost({ agentIds: ["coder_hq", "researcher"], history: history2 });
  assert.ok(r.agents.coder_hq);
  assert.ok(r.agents.researcher);
  // total = 两 agent 中位数之和
  // coder_hq cost 中位数 (0.04,0.08) 偶数个 → 取均值 0.06；researcher 0.02 → total 0.08
  assert.ok(r.total.medianCostUsd > 0, "total 应有合计中位数成本");
  assert.ok(r.total.medianTokens > 0);
});

test("M8-4: 单样本 agent → min=max=median", () => {
  const r = forecastCost({
    agentIds: ["solo"],
    history: { solo: [{ tokens: { input: 1000, output: 50 }, costUsd: 0.01, durationMs: 30000 }] },
  });
  const a = r.agents.solo;
  assert.equal(a.cost.median, 0.01);
  assert.equal(a.cost.min, 0.01, "单样本 min=median");
  assert.equal(a.cost.max, 0.01, "单样本 max=median");
  assert.equal(a.sampleSize, 1);
});

test("M8-4: 无 costUsd 字段的 run → cost 段标 unavailable（不报错）", () => {
  const r = forecastCost({
    agentIds: ["nocost"],
    history: { nocost: [{ tokens: { input: 1000, output: 50 }, durationMs: 30000 }] },
  });
  const a = r.agents.nocost;
  assert.equal(a.cost.unavailable, true, "无 costUsd 数据应标 unavailable");
  assert.ok(a.tokens.input.median, 1000, "tokens 仍可预测");
});

test("M8-4: 全部 agent 无历史 → total 标 insufficient_data", () => {
  const r = forecastCost({ agentIds: ["x", "y"], history: {} });
  assert.equal(r.total.insufficient_data, true);
});
