import test from "node:test";
import assert from "node:assert/strict";
import { aggregateRunMetrics, aggregateSummary } from "../src/metrics.js";

test("aggregateRunMetrics: 提取 tokens + duration + state", () => {
  const events = [
    { type: "run.started", ts: "2026-06-15T10:00:00.000Z" },
    { type: "run.state_change", to: "completed" },
    { type: "run.metrics", tokens: { input: 100, output: 50, reasoning: 10 }, costUsd: 0.01 },
    { type: "run.completed", ts: "2026-06-15T10:00:30.000Z" },
  ];
  const m = aggregateRunMetrics(events);
  assert.equal(m.state, "completed");
  assert.deepEqual(m.tokens, { input: 100, output: 50, reasoning: 10 });
  assert.equal(m.costUsd, 0.01);
  assert.equal(m.durationMs, 30000);
});

test("aggregateRunMetrics: 无 metrics 事件时 tokens 为空", () => {
  const events = [
    { type: "run.started", ts: "2026-06-15T10:00:00.000Z" },
    { type: "run.state_change", to: "failed" },
    { type: "run.completed", ts: "2026-06-15T10:00:10.000Z" },
  ];
  const m = aggregateRunMetrics(events);
  assert.equal(m.state, "failed");
  assert.deepEqual(m.tokens, {});
  assert.equal(m.durationMs, 10000);
});

test("aggregateRunMetrics: 空事件序列", () => {
  const m = aggregateRunMetrics([]);
  assert.equal(m.state, "pending");
  assert.equal(m.durationMs, 0);
  assert.deepEqual(m.tokens, {});
});

test("aggregateRunMetrics: 多条 run.metrics 取最后一条（累计或最新）", () => {
  const events = [
    { type: "run.started", ts: "2026-06-15T10:00:00.000Z" },
    { type: "run.metrics", tokens: { input: 50, output: 20 } },
    { type: "run.metrics", tokens: { input: 100, output: 50 }, costUsd: 0.02 },
    { type: "run.completed", ts: "2026-06-15T10:00:30.000Z" },
  ];
  const m = aggregateRunMetrics(events);
  // 取最后一条（最终累计值）
  assert.equal(m.tokens.input, 100);
  assert.equal(m.costUsd, 0.02);
});

test("aggregateSummary: 多 run 聚合", () => {
  // 模拟两个 run 的事件序列
  const runs = [
    [
      { type: "run.started", ts: "2026-06-15T10:00:00.000Z" },
      { type: "run.state_change", to: "completed" },
      { type: "run.metrics", tokens: { input: 100, output: 50 } },
      { type: "run.completed", ts: "2026-06-15T10:00:30.000Z" },
    ],
    [
      { type: "run.started", ts: "2026-06-15T11:00:00.000Z" },
      { type: "run.state_change", to: "failed" },
      { type: "run.metrics", tokens: { input: 200, output: 0 } },
      { type: "run.completed", ts: "2026-06-15T11:00:10.000Z" },
    ],
  ];
  const s = aggregateSummary(runs);
  assert.equal(s.totalRuns, 2);
  assert.equal(s.byState.completed, 1);
  assert.equal(s.byState.failed, 1);
  assert.equal(s.successRate, 0.5);
  assert.equal(s.totalTokens.input, 300);
  assert.equal(s.totalTokens.output, 50);
  assert.equal(s.avgDurationMs, 20000); // (30000+10000)/2
});

test("aggregateSummary: 空 runs", () => {
  const s = aggregateSummary([]);
  assert.equal(s.totalRuns, 0);
  assert.equal(s.successRate, 0);
});
