// test/daemonHealth.test.js
//
// P5 / TD-46：daemon 长跑可观测性——健康评估纯函数。
//
// TD-46：长跑（数小时/天）暴露的句柄/内存/进程组累积，单元测试覆盖不到（需真实长跑）。
// 故 T2 只做"可观测+告警"（眼睛），不做"自动修根因"（根因靠 T3 长跑暴露后针对性修）。
// daemon 周期采样 process.memoryUsage + 在飞 run 数 + worktree 残留，写 daemon-health.json；
// assessDaemonHealth 纯函数按阈值判定健康状态，超阈→warn（可单测）。
//
// 纯函数 assessDaemonHealth(sample, thresholds) → {level:"ok"|"warn", issues:[]}

import test from "node:test";
import assert from "node:assert/strict";
import { assessDaemonHealth } from "../src/daemonHealth.js";

const OK_SAMPLE = {
  rssBytes: 80 * 1024 * 1024,   // 80MB
  heapUsedBytes: 30 * 1024 * 1024, // 30MB
  activeRuns: 2,
  worktreeCount: 1,
  uptimeMs: 3600000, // 1h
};

// ===== 全在阈值内 → ok =====
test("全维度在阈值内 → ok，无 issues", () => {
  const r = assessDaemonHealth(OK_SAMPLE);
  assert.equal(r.level, "ok");
  assert.deepEqual(r.issues, []);
});

// ===== RSS 超阈 → warn（内存累积是长跑泄漏主信号）=====
test("RSS 超阈 → warn + 含 memory issue", () => {
  const r = assessDaemonHealth({ ...OK_SAMPLE, rssBytes: 600 * 1024 * 1024 }, { rssWarnBytes: 500 * 1024 * 1024 });
  assert.equal(r.level, "warn");
  assert.ok(r.issues.some((i) => /rss|内存|memory/i.test(i.metric)), "应含 rss/memory issue");
});

// ===== heap used 超阈 → warn =====
test("heap used 超阈 → warn", () => {
  const r = assessDaemonHealth({ ...OK_SAMPLE, heapUsedBytes: 400 * 1024 * 1024 }, { heapWarnBytes: 300 * 1024 * 1024 });
  assert.equal(r.level, "warn");
  assert.ok(r.issues.some((i) => /heap/i.test(i.metric)));
});

// ===== worktree 残留超阈 → warn（进程组/文件累积信号）=====
test("worktree 残留超阈 → warn", () => {
  const r = assessDaemonHealth({ ...OK_SAMPLE, worktreeCount: 15 }, { worktreeWarnCount: 10 });
  assert.equal(r.level, "warn");
  assert.ok(r.issues.some((i) => /worktree/i.test(i.metric)));
});

// ===== 在飞 run 异常多 → warn（可能是 stuck run 累积）=====
test("在飞 run 超阈 → warn", () => {
  const r = assessDaemonHealth({ ...OK_SAMPLE, activeRuns: 25 }, { activeRunsWarnCount: 20 });
  assert.equal(r.level, "warn");
  assert.ok(r.issues.some((i) => /run/i.test(i.metric)));
});

// ===== 多维度同时超 → 全部列出 =====
test("多维度同时超 → issues 全列（不只第一个）", () => {
  const r = assessDaemonHealth({
    rssBytes: 600 * 1024 * 1024, heapUsedBytes: 400 * 1024 * 1024,
    activeRuns: 2, worktreeCount: 1, uptimeMs: 1000,
  }, { rssWarnBytes: 500 * 1024 * 1024, heapWarnBytes: 300 * 1024 * 1024 });
  assert.equal(r.level, "warn");
  assert.ok(r.issues.length >= 2, "应列多个 issue");
});

// ===== 缺字段不崩（某采样维度缺失 → 跳过该判定）=====
test("采样缺字段（如无 worktreeCount）→ 跳过该判定不崩", () => {
  const r = assessDaemonHealth({ rssBytes: 80 * 1024 * 1024, heapUsedBytes: 30 * 1024 * 1024, activeRuns: 1 });
  assert.equal(r.level, "ok", "缺的维度跳过，其余 ok 则 ok");
  assert.deepEqual(r.issues, []);
});

// ===== 坏/空输入 =====
test("空/坏输入 → ok（保守，不误报）", () => {
  assert.equal(assessDaemonHealth(null).level, "ok");
  assert.equal(assessDaemonHealth({}).level, "ok");
  assert.equal(assessDaemonHealth(undefined).level, "ok");
});

// ===== 阈值默认值合理（不传 thresholds 用默认）=====
test("不传 thresholds 用默认值，正常 sample → ok", () => {
  const r = assessDaemonHealth(OK_SAMPLE); // 不传第二参
  assert.equal(r.level, "ok");
});
