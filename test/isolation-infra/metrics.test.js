import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateRunMetrics,
  aggregateRunUsages,
  aggregateSummary,
  inputIncludesCacheReadForBackend,
  runUsageFacts,
  usageScopeForBackend,
} from "../../src/metrics.js";

function sessionCreated(runId, providerSessionId = "sess_1", backend = "zcode") {
  return { type: "session.created", runId, backend, backendSessionId: providerSessionId };
}

test("aggregateRunMetrics: 提取 tokens + duration + state", () => {
  const events = [
    { type: "run.started", backend: "claude-code", ts: "2026-06-15T10:00:00.000Z" },
    { type: "run.state_change", to: "completed" },
    {
      type: "run.metrics",
      tokens: { input: 100, output: 50, reasoning: 10, cacheRead: 70, cacheWrite: 20 },
      costUsd: 0.01,
    },
    { type: "run.completed", ts: "2026-06-15T10:00:30.000Z" },
  ];
  const m = aggregateRunMetrics(events);
  assert.equal(m.state, "completed");
  assert.deepEqual(m.tokens, {
    input: 100,
    output: 50,
    reasoning: 10,
    cacheRead: 70,
    cacheWrite: 20,
  });
  assert.equal(m.costUsd, 0.01);
  assert.equal(m.durationMs, 30000);
  assert.equal(m.usageScope, "run", "旧事件无 usageScope → 按 claude-code 类声明解释");
  assert.deepEqual(m.selfTokens, m.tokens, "本运行范围：自身用量就是记录值");
  assert.equal(m.cacheRatio, 70 / 170);
});

test("aggregateRunMetrics: 无 metrics 事件时 tokens 为空、自身用量未知", () => {
  const events = [
    { type: "run.started", backend: "claude-code", ts: "2026-06-15T10:00:00.000Z" },
    { type: "run.state_change", to: "failed" },
    { type: "run.completed", ts: "2026-06-15T10:00:10.000Z" },
  ];
  const m = aggregateRunMetrics(events);
  assert.equal(m.state, "failed");
  assert.deepEqual(m.tokens, {});
  assert.equal(m.durationMs, 10000);
  assert.equal(m.selfTokens, null);
  assert.equal(m.selfUsageUnknownReason, "no_usage");
});

test("aggregateRunMetrics: 空事件序列（历史读法，无 usage 事实）", () => {
  const m = aggregateRunMetrics([]);
  assert.equal(m.state, "pending");
  assert.equal(m.durationMs, 0);
  assert.deepEqual(m.tokens, {});
  assert.equal(m.usageScope, "unknown");
  assert.equal(m.selfTokens, null);
  assert.equal(m.selfUsageUnknownReason, "no_usage");
});

test("aggregateRunMetrics: 多条 run.metrics 取最后一条（累计或最新）", () => {
  const events = [
    { type: "run.started", backend: "claude-code", ts: "2026-06-15T10:00:00.000Z" },
    { type: "run.metrics", tokens: { input: 50, output: 20 } },
    { type: "run.metrics", tokens: { input: 100, output: 50 }, costUsd: 0.02 },
    { type: "run.completed", ts: "2026-06-15T10:00:30.000Z" },
  ];
  const m = aggregateRunMetrics(events);
  // 取最后一条（最终累计值）
  assert.equal(m.tokens.input, 100);
  assert.equal(m.costUsd, 0.02);
});

test("aggregateRunMetrics: 首个请求用量（有/无两种）与缓存占比（input 不含缓存）", () => {
  const withFirst = aggregateRunMetrics([
    { type: "run.started", backend: "kimi-web", ts: "2026-06-15T10:00:00.000Z" },
    {
      type: "run.metrics",
      tokens: { input: 90, output: 10, cacheRead: 10 },
      firstRequest: { input: 20, cacheRead: 5 },
    },
  ]);
  assert.equal(withFirst.usageScope, "run");
  assert.deepEqual(withFirst.firstRequest, { input: 20, cacheRead: 5 });
  assert.equal(withFirst.firstRequestCacheRatio, 5 / 25);
  assert.equal(withFirst.cacheRatio, 0.1);

  const withoutFirst = aggregateRunMetrics([
    { type: "run.started", backend: "codex", ts: "2026-06-15T10:00:00.000Z" },
    { type: "run.metrics", tokens: { input: 90, output: 10 } },
  ]);
  assert.equal(withoutFirst.firstRequest, null);
  assert.equal(withoutFirst.firstRequestCacheRatio, null);
});

test("缓存占比按后端声明算：codex input 含缓存读取，kimi 缺缓存分量 → 未知", () => {
  const codex = aggregateRunMetrics([
    { type: "run.started", backend: "codex", ts: "2026-06-15T10:00:00.000Z" },
    { type: "run.metrics", tokens: { input: 200, output: 10, cacheRead: 120, cacheWrite: 10 } },
  ]);
  assert.equal(codex.tokens.input, 200, "input 保留上游原值（tokenBudget 口径不变）");
  assert.equal(codex.cacheRatio, 120 / 200, "含缓存：cacheRead ÷ input");

  const kimi = aggregateRunMetrics([
    { type: "run.started", backend: "kimi-web", ts: "2026-06-15T10:00:00.000Z" },
    { type: "run.metrics", tokens: { input: 100, output: 7 } },
  ]);
  assert.equal(kimi.tokens.cacheRead, undefined, "上游没报的缓存不补 0");
  assert.equal(kimi.cacheRatio, null, "缓存分量缺失 → 占比未知");

  assert.equal(inputIncludesCacheReadForBackend("codex"), true);
  assert.equal(inputIncludesCacheReadForBackend("claude-code"), false);
  assert.equal(inputIncludesCacheReadForBackend("no-such-backend"), "unknown");
});

test("aggregateSummary: 多 run 聚合（旧事件无范围、后端不可解析 → 历史读法按记下的数）", () => {
  const runs = [
    [
      { type: "run.started", ts: "2026-06-15T10:00:00.000Z" },
      { type: "run.state_change", to: "completed" },
      { type: "run.metrics", tokens: { input: 100, output: 50, cacheRead: 25, cacheWrite: 5 } },
      { type: "run.completed", ts: "2026-06-15T10:00:30.000Z" },
    ],
    [
      { type: "run.started", ts: "2026-06-15T11:00:00.000Z" },
      { type: "run.state_change", to: "failed" },
      { type: "run.metrics", tokens: { input: 200, output: 0, cacheRead: 75, cacheWrite: 15 } },
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
  assert.equal(s.totalTokens.cacheRead, 100);
  assert.equal(s.totalTokens.cacheWrite, 20);
  assert.equal(s.avgDurationMs, 20000); // (30000+10000)/2
  assert.equal(s.unknownSelfUsageCount, 0);
});

test("aggregateSummary: 会话累计三轮 100/160/200 → 自身 100/60/40，合计 200 不是 460", () => {
  const root = [
    { type: "run.started", backend: "zcode", runId: "run_root", ts: "2026-06-15T10:00:00.000Z" },
    sessionCreated("run_root"),
    { type: "run.session_reuse", runId: "run_root", mode: "run_lineage", turn: "first", rootRunId: "run_root" },
    { type: "run.metrics", runId: "run_root", tokens: { input: 100, output: 10 }, usageScope: "session" },
    { type: "run.completed", runId: "run_root", ts: "2026-06-15T10:00:30.000Z" },
  ];
  const child = (runId, parentRunId, ts, input, output) => ([
    { type: "run.started", backend: "zcode", runId, ts },
    sessionCreated(runId),
    {
      type: "run.background_submitted", runId, continuation: true,
      parentRunId, rootRunId: "run_root",
    },
    { type: "run.session_reuse", runId, mode: "run_lineage", turn: "resume", rootRunId: "run_root" },
    { type: "run.metrics", runId, tokens: { input, output }, usageScope: "session" },
    { type: "run.completed", runId, ts },
  ]);
  const child1 = child("run_child1", "run_root", "2026-06-15T10:01:00.000Z", 160, 12);
  const child2 = child("run_child2", "run_child1", "2026-06-15T10:02:00.000Z", 200, 14);
  const runs = [child2, root, child1]; // 输入乱序仍按开始时间还原会话顺序
  const runIds = runs.map((events) => events[0].runId);

  const rows = aggregateRunUsages(runs, runIds);
  const byId = new Map(rows.map((row) => [row.runId, row]));
  assert.deepEqual(byId.get("run_root").selfTokens, { input: 100, output: 10 });
  assert.deepEqual(byId.get("run_child1").selfTokens, { input: 60, output: 2 });
  assert.deepEqual(byId.get("run_child2").selfTokens, { input: 40, output: 2 });

  const s = aggregateSummary(runs, runIds);
  assert.deepEqual(s.totalTokens, { input: 200, output: 14 }, "自身用量相加=200，不是会话累计 460");
  assert.equal(s.unknownSelfUsageCount, 0);
});

test("上一轮按同一 provider 会话里紧邻的前一轮：请求错误的父运行也不取错", () => {
  // 第二轮仍请求续修根运行，但运行时实际接回第一子轮：会话 id 相同，
  // 第三方（child2）的紧邻前一轮是 child1，不是它请求的 root。
  const run = (runId, requestedParent, input, ts) => ([
    { type: "run.started", backend: "zcode", runId, ts },
    sessionCreated(runId, "sess_chain"),
    {
      type: "run.background_submitted", runId, continuation: true,
      parentRunId: requestedParent, rootRunId: "run_root",
    },
    { type: "run.session_reuse", runId, mode: "run_lineage", turn: "resume", rootRunId: "run_root" },
    { type: "run.metrics", runId, tokens: { input, output: 1 }, usageScope: "session" },
  ]);
  const root = [
    { type: "run.started", backend: "zcode", runId: "run_root", ts: "2026-06-15T10:00:00.000Z" },
    sessionCreated("run_root", "sess_chain"),
    { type: "run.session_reuse", runId: "run_root", mode: "run_lineage", turn: "first", rootRunId: "run_root" },
    { type: "run.metrics", runId: "run_root", tokens: { input: 100, output: 1 }, usageScope: "session" },
  ];
  const child1 = run("run_child1", "run_root", 160, "2026-06-15T10:01:00.000Z");
  const child2 = run("run_child2", "run_root", 200, "2026-06-15T10:02:00.000Z");
  const rows = aggregateRunUsages([root, child1, child2], ["run_root", "run_child1", "run_child2"]);
  assert.deepEqual(rows.find((row) => row.runId === "run_child2").selfTokens,
    { input: 40, output: 0 },
    "紧邻前一轮是 child1（160），不是请求的 root（100）");
  const s = aggregateSummary([root, child1, child2], ["run_root", "run_child1", "run_child2"]);
  assert.equal(s.totalTokens.input, 200, "100 + 60 + 40；不是把 child2 当 100 得到 260");
});

test("上一轮按开始时间而不是文件名：run_a→run_z→run_m，run_m 自身 40", () => {
  const run = (runId, input, ts) => ([
    { type: "run.started", backend: "zcode", runId, ts },
    sessionCreated(runId, "sess_time_order"),
    { type: "run.session_reuse", runId, mode: "lead_workspace", turn: runId === "run_a" ? "first" : "resume" },
    { type: "run.metrics", runId, tokens: { input }, usageScope: "session" },
  ]);
  const runA = run("run_a", 100, "2026-06-15T10:00:00.000Z");
  const runZ = run("run_z", 160, "2026-06-15T10:01:00.000Z");
  const runM = run("run_m", 200, "2026-06-15T10:02:00.000Z");
  const rows = aggregateRunUsages([runM, runA, runZ], ["run_m", "run_a", "run_z"]);
  assert.deepEqual(rows.find((row) => row.runId === "run_m").selfTokens, { input: 40 },
    "紧邻前一轮是开始时间更近的 run_z（160），不是文件名首个匹配");
});

test("停止的兄弟轮没有 run.metrics → 后续轮自身用量未知（不拿更早的父轮冒充）", () => {
  const root = [
    { type: "run.started", backend: "zcode", runId: "run_root", ts: "2026-06-15T10:00:00.000Z" },
    sessionCreated("run_root", "sess_sibling"),
    { type: "run.session_reuse", runId: "run_root", mode: "run_lineage", turn: "first", rootRunId: "run_root" },
    { type: "run.metrics", runId: "run_root", tokens: { input: 219059 }, usageScope: "session" },
  ];
  const sibling = [
    { type: "run.started", backend: "zcode", runId: "run_sibling", ts: "2026-06-15T10:01:00.000Z" },
    sessionCreated("run_sibling", "sess_sibling"),
    {
      type: "run.background_submitted", runId: "run_sibling", continuation: true,
      parentRunId: "run_root", rootRunId: "run_root",
    },
    { type: "run.session_reuse", runId: "run_sibling", mode: "run_lineage", turn: "resume", rootRunId: "run_root" },
    // 被用户停止：没有 run.metrics。
  ];
  const next = [
    { type: "run.started", backend: "zcode", runId: "run_next", ts: "2026-06-15T10:02:00.000Z" },
    sessionCreated("run_next", "sess_sibling"),
    {
      type: "run.background_submitted", runId: "run_next", continuation: true,
      parentRunId: "run_root", rootRunId: "run_root",
    },
    { type: "run.session_reuse", runId: "run_next", mode: "run_lineage", turn: "resume", rootRunId: "run_root" },
    { type: "run.metrics", runId: "run_next", tokens: { input: 300948 }, usageScope: "session" },
  ];
  const rows = aggregateRunUsages([root, sibling, next], ["run_root", "run_sibling", "run_next"]);
  const nextRow = rows.find((row) => row.runId === "run_next");
  assert.equal(nextRow.selfTokens, null);
  assert.equal(nextRow.selfUsageUnknownReason, "prior_usage_unreadable");
  const s = aggregateSummary([root, sibling, next], ["run_root", "run_sibling", "run_next"]);
  assert.deepEqual(s.totalTokens, { input: 219059 }, "只计根轮；兄弟轮与后续轮均未知");
  assert.equal(s.unknownSelfUsageCount, 2);
});

test("谱系中间轮读不出 native 会话 id → 下一轮记未知，不得越过它减根轮", () => {
  const root = [
    { type: "run.started", backend: "codex", runId: "run_root", ts: "2026-06-15T10:00:00.000Z" },
    sessionCreated("run_root", "thread_root", "codex"),
    { type: "run.session_reuse", runId: "run_root", mode: "run_lineage", turn: "first", rootRunId: "run_root" },
    { type: "run.metrics", runId: "run_root", tokens: { input: 100 }, usageScope: "session" },
  ];
  const middle = (withMetrics) => ([
    { type: "run.started", backend: "codex", runId: "run_middle", ts: "2026-06-15T10:01:00.000Z" },
    // 被停止的进程型中间轮：只剩 proc_<pid> 占位，没有 native 绑定事实。
    sessionCreated("run_middle", "proc_123", "codex"),
    {
      type: "run.background_submitted", runId: "run_middle", continuation: true,
      parentRunId: "run_root", rootRunId: "run_root",
    },
    { type: "run.session_reuse", runId: "run_middle", mode: "run_lineage", turn: "resume", rootRunId: "run_root" },
    ...(withMetrics
      ? [{ type: "run.metrics", runId: "run_middle", tokens: { input: 160 }, usageScope: "session" }]
      : []),
  ]);
  const next = [
    { type: "run.started", backend: "codex", runId: "run_next", ts: "2026-06-15T10:02:00.000Z" },
    sessionCreated("run_next", "thread_root", "codex"),
    {
      type: "run.background_submitted", runId: "run_next", continuation: true,
      parentRunId: "run_root", rootRunId: "run_root",
    },
    { type: "run.session_reuse", runId: "run_next", mode: "run_lineage", turn: "resume", rootRunId: "run_root" },
    { type: "run.metrics", runId: "run_next", tokens: { input: 200 }, usageScope: "session" },
  ];
  for (const withMetrics of [false, true]) {
    const rows = aggregateRunUsages(
      [root, middle(withMetrics), next],
      ["run_root", "run_middle", "run_next"],
    );
    const nextRow = rows.find((row) => row.runId === "run_next");
    assert.equal(nextRow.selfTokens, null,
      withMetrics
        ? "中间轮有 metrics 但读不出会话 id → 下一轮仍未知，不得减根轮得 100"
        : "中间轮无 metrics 且无 native id → 下一轮未知");
    assert.equal(nextRow.selfUsageUnknownReason, "prior_session_unreadable");
  }
  const s = aggregateSummary(
    [root, middle(false), next],
    ["run_root", "run_middle", "run_next"],
  );
  assert.deepEqual(s.totalTokens, { input: 100 }, "合计只含根轮，不把跨轮消耗算给下一轮");
  assert.equal(s.unknownSelfUsageCount, 2);
});

test("会话第一轮：自身用量按记下的数（无范围字段/后端不可解析也保持历史读法）", () => {
  const legacy = [
    { type: "run.started", ts: "2026-06-15T10:00:00.000Z" },
    { type: "run.metrics", tokens: { input: 100, output: 50 }, costUsd: 0.02 },
  ];
  const s = aggregateSummary([legacy], ["run_legacy"]);
  assert.deepEqual(s.totalTokens, { input: 100, output: 50 });
  assert.equal(s.unknownSelfUsageCount, 0);
  const row = aggregateRunUsages([legacy], ["run_legacy"])[0];
  assert.deepEqual(row.selfTokens, { input: 100, output: 50 });
  assert.equal(row.usageScope, "unknown", "范围不可解析如实显示 unknown，但自身用量走历史读法");
});

test("显式 unknown 范围：第一轮也记未知", () => {
  const events = [
    { type: "run.started", backend: "kimi-code", ts: "2026-06-15T10:00:00.000Z" },
    { type: "run.metrics", tokens: { input: 100 }, usageScope: "unknown" },
  ];
  const m = aggregateRunMetrics(events);
  assert.equal(m.selfTokens, null);
  assert.equal(m.selfUsageUnknownReason, "usage_scope_unknown");
});

test("续轮读不到 provider 会话 id → 自身用量未知", () => {
  const events = [
    { type: "run.started", backend: "zcode", runId: "run_orphan", ts: "2026-06-15T10:00:00.000Z" },
    { type: "run.session_reuse", runId: "run_orphan", mode: "run_lineage", turn: "resume", rootRunId: "run_root" },
    { type: "run.metrics", runId: "run_orphan", tokens: { input: 200 }, usageScope: "session" },
  ];
  const m = aggregateRunMetrics(events, "run_orphan");
  assert.equal(m.selfTokens, null);
  assert.equal(m.selfUsageUnknownReason, "session_unreadable");
});

test("aggregateSummary: 专家复用同一 provider 会话累计减上一轮", () => {
  const run = (runId, turn, input, ts) => ([
    { type: "run.started", backend: "zcode", runId, ts },
    sessionCreated(runId, "sess_expert_1"),
    { type: "run.session_reuse", runId, mode: "lead_workspace", turn },
    { type: "run.metrics", runId, tokens: { input, output: 1 }, usageScope: "session" },
  ]);
  const first = run("run_exp_1", "first", 100, "2026-06-15T10:00:00.000Z");
  const second = run("run_exp_2", "resume", 160, "2026-06-15T10:01:00.000Z");
  const s = aggregateSummary([second, first], ["run_exp_2", "run_exp_1"]);
  assert.deepEqual(s.totalTokens, { input: 160, output: 1 },
    "首轮 100 + 续轮自身 60；不是 100+160");
  assert.equal(s.unknownSelfUsageCount, 0);
});

test("runUsageFacts: 旧转录按后端声明解释范围，不按名字在共享代码分支", () => {
  const zcode = runUsageFacts([
    { type: "run.started", backend: "zcode", ts: "2026-06-15T10:00:00.000Z" },
    { type: "run.metrics", tokens: { input: 10 } },
  ]);
  assert.equal(zcode.usageScope, "session", "zcode 类声明 session");
  const claude = runUsageFacts([
    { type: "run.started", backend: "claude-code", ts: "2026-06-15T10:00:00.000Z" },
    { type: "run.metrics", tokens: { input: 10 } },
  ]);
  assert.equal(claude.usageScope, "run");
  const unknown = runUsageFacts([
    { type: "run.started", backend: "no-such-backend", ts: "2026-06-15T10:00:00.000Z" },
    { type: "run.metrics", tokens: { input: 10 } },
  ]);
  assert.equal(unknown.usageScope, "unknown");
  assert.equal(unknown.scopeState, "unresolved", "不可解析 = 历史读法，不是显式 unknown");
  // 事件写了范围就以事件为准（后端声明只服务旧转录）。
  const explicit = runUsageFacts([
    { type: "run.started", backend: "claude-code", ts: "2026-06-15T10:00:00.000Z" },
    { type: "run.metrics", tokens: { input: 10 }, usageScope: "session" },
  ]);
  assert.equal(explicit.usageScope, "session");
});

test("usageScopeForBackend: 七个后端的计量范围声明（读类声明，不在共享代码按名字分支）", () => {
  assert.equal(usageScopeForBackend("claude-code"), "run");
  assert.equal(usageScopeForBackend("codex"), "session");
  assert.equal(usageScopeForBackend("kimi-code"), "unknown");
  assert.equal(usageScopeForBackend("deepseek-harness"), "unknown");
  assert.equal(usageScopeForBackend("deepseek-acp"), "unknown");
  assert.equal(usageScopeForBackend("kimi-web"), "run");
  assert.equal(usageScopeForBackend("zcode"), "session");
  assert.equal(usageScopeForBackend("no-such-backend"), "unknown");
});

test("aggregateSummary: 空 runs", () => {
  const s = aggregateSummary([]);
  assert.equal(s.totalRuns, 0);
  assert.equal(s.successRate, 0);
  assert.equal(s.unknownSelfUsageCount, 0);
});
