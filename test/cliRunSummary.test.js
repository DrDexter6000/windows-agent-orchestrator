// test/cliRunSummary.test.js
//
// P4 融合项 #1（决策A）：run 命令默认人类可读 header + 内联 scorecard/metrics，
// --format json 保留机器可读。一次融合取代 collect/scorecard/metrics 的常见回查。
//
// 决策 0010：让 run 成为唯一需要的命令。它已返回一切，但默认静默阻塞末尾 dump JSON。
// 改成默认打印 header（runId · agent · 结果 · 成本），详细 JSON 走 --format json。
//
// 纯函数 renderRunSummary(waitResult, {agentId, scorecard}) 可单测，不 spawn。

import test from "node:test";
import assert from "node:assert/strict";
import { renderRunSummary } from "../src/cliRunSummary.js";

test("renderRunSummary: completed run → header 含 runId/agent/结果/成本", () => {
  const waitResult = {
    runId: "run_abc123",
    completed: true,
    failed: false,
    timedOut: false,
    metrics: { durationMs: 45000, costUsd: 0.12, tokens: { input: 1000, output: 500, reasoning: 0 } },
  };
  const out = renderRunSummary(waitResult, { agentId: "coder_low" });
  assert.ok(out.includes("run_abc123"), "header 含 runId");
  assert.ok(out.includes("coder_low"), "header 含 agentId");
  assert.ok(/completed/i.test(out), "header 含结果 completed");
  assert.ok(out.includes("0.12"), "header 含成本");
});

test("renderRunSummary: failed run → header 标 failed + error", () => {
  const waitResult = {
    runId: "run_fail",
    completed: false,
    failed: true,
    timedOut: false,
    error: "process exited with code 1",
    metrics: { durationMs: 5000, costUsd: 0.01, tokens: {} },
  };
  const out = renderRunSummary(waitResult, { agentId: "coder_low" });
  assert.ok(/failed/i.test(out), "header 标 failed");
  assert.ok(out.includes("process exited with code 1"), "header 含 error");
});

test("renderRunSummary: timed_out run → header 标 timed out", () => {
  const waitResult = {
    runId: "run_to",
    completed: false,
    failed: false,
    timedOut: true,
    metrics: { durationMs: 120000, costUsd: 0.05, tokens: {} },
  };
  const out = renderRunSummary(waitResult, { agentId: "researcher" });
  assert.ok(/timed ?out/i.test(out), "header 标 timed out");
});

test("renderRunSummary: 无 metrics → 不崩，header 不含成本行（或显示无）", () => {
  const waitResult = { runId: "run_x", completed: true, failed: false, timedOut: false };
  const out = renderRunSummary(waitResult, { agentId: "coder_low" });
  assert.ok(out.includes("run_x"), "仍含 runId");
  // 无 metrics 不应崩——成本/时长行应省略或显示 (none)
  assert.ok(typeof out === "string");
});

test("renderRunSummary: 有 scorecard → 内联 PASS/FAIL 卡片", () => {
  const waitResult = {
    runId: "run_sc",
    completed: true,
    failed: false,
    timedOut: false,
    metrics: { durationMs: 1000, costUsd: 0, tokens: {} },
    scorecard: {
      passed: true,
      checks: [
        { name: "hasDoneEvent", passed: true, evidence: "run.completed present" },
        { name: "filesExist", passed: true, evidence: "1 file_written event(s)" },
      ],
    },
  };
  const out = renderRunSummary(waitResult, { agentId: "coder_hq" });
  assert.ok(/scorecard/i.test(out), "含 scorecard 段");
  assert.ok(/pass/i.test(out), "标 PASS");
  assert.ok(out.includes("filesExist"), "列 check 名");
});

test("renderRunSummary: scorecard FAIL → 标 FAIL + 显示失败 check 的 detail", () => {
  const waitResult = {
    runId: "run_sc_fail",
    completed: true,
    failed: false,
    timedOut: false,
    metrics: { durationMs: 1000, costUsd: 0, tokens: {} },
    scorecard: {
      passed: false,
      checks: [
        { name: "commandsPassed", passed: false, evidence: "0 commands", detail: "not executed: npm test" },
      ],
    },
  };
  const out = renderRunSummary(waitResult, { agentId: "coder_hq" });
  assert.ok(/fail/i.test(out), "标 FAIL");
  assert.ok(out.includes("not executed: npm test"), "含失败 detail");
});

test("renderRunSummary: 无 scorecard → 不输出 scorecard 段（向后兼容 opt-in）", () => {
  const waitResult = { runId: "run_nosc", completed: true, failed: false, timedOut: false, metrics: { durationMs: 1 } };
  const out = renderRunSummary(waitResult, { agentId: "coder_low" });
  assert.ok(!/scorecard/i.test(out), "无 scorecard 时不输出该段");
});
