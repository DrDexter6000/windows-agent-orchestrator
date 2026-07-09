// runEvidenceAssessment.test.js
//
// TD-97 统一证据语义测试。
// assessRunEvidence 是 SSOT：从事件数组计算统一事实（hasFileWritten/hasCommandExit0/...）。
// 三处调用方（runManager auditFailure / diagnosis / scorecard）都应读这份评估。
//
// 关键形状挑战（三种输入都要兼容）：
//   1. transcript 落盘形状：run.event { type:"run.event", kind:"message", role, parts }
//   2. scorecard 临时形状：run.message { type:"run.message", role, parts }（不落盘）
//   3. runManager 内存形状：message { info:{ role }, parts }（waitForCompletion 累积）

import { test } from "node:test";
import assert from "node:assert/strict";
import { assessRunEvidence } from "../src/runEvidenceAssessment.js";

// ---------------------------------------------------------------------------
// 形状兼容性（核心：三种 message 形状都能识别 assistant text）
// ---------------------------------------------------------------------------

test("TD-97: transcript 真实形状 run.event kind=message 能识别 assistant text", () => {
  const result = assessRunEvidence([
    { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "done" }] },
  ]);
  assert.equal(result.hasAssistantText, true, "run.event kind=message assistant text 应识别");
  assert.equal(result.assistantTextCount, 1);
});

test("TD-97: scorecard 临时形状 run.message 仍能识别 assistant text（不回退）", () => {
  const result = assessRunEvidence([
    { type: "run.message", role: "assistant", parts: [{ type: "text", text: "answer" }] },
  ]);
  assert.equal(result.hasAssistantText, true, "run.message assistant text 应识别（scorecard 兼容）");
});

test("TD-97: runManager 内存形状 message {info:{role}} 能识别 assistant text", () => {
  const result = assessRunEvidence([
    { info: { role: "assistant" }, parts: [{ type: "text", text: "working" }] },
  ]);
  assert.equal(result.hasAssistantText, true, "内存形状 message assistant text 应识别");
});

test("TD-97: user message 不算 assistant text", () => {
  const result = assessRunEvidence([
    { type: "run.event", kind: "message", role: "user", parts: [{ type: "text", text: "task" }] },
  ]);
  assert.equal(result.hasAssistantText, false, "user message 不是 assistant text");
  assert.equal(result.assistantTextCount, 0);
});

test("TD-97: 空 parts 或空 text 不算 assistant text", () => {
  const result = assessRunEvidence([
    { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "   " }] },
    { type: "run.event", kind: "message", role: "assistant", parts: [] },
    { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "tool" }] },
  ]);
  assert.equal(result.hasAssistantText, false, "空/空白/非 text part 不算 assistant text");
  assert.equal(result.assistantTextCount, 0);
});

// ---------------------------------------------------------------------------
// file_written + command exit0 检测
// ---------------------------------------------------------------------------

test("TD-97: file_written 检测 + count", () => {
  const result = assessRunEvidence([
    { type: "run.event", kind: "file_written", path: "a.js" },
    { type: "run.event", kind: "file_written", path: "b.js" },
    { type: "run.event", kind: "tool_use" },
  ]);
  assert.equal(result.hasFileWritten, true);
  assert.equal(result.fileWrittenCount, 2);
});

test("TD-97: command exit0 检测 + count（排除非0退出）", () => {
  const result = assessRunEvidence([
    { type: "run.event", kind: "command", command: "ok-cmd", exitCode: 0 },
    { type: "run.event", kind: "command", command: "fail-cmd", exitCode: 1 },
  ]);
  assert.equal(result.hasCommandExit0, true);
  assert.equal(result.commandExit0Count, 1, "只计 exit0，不计 exit1");
});

test("TD-97: tool_use 活动检测", () => {
  const result = assessRunEvidence([
    { type: "run.event", kind: "tool_use", name: "Read" },
    { type: "run.event", kind: "tool_result", isError: false },
  ]);
  assert.equal(result.hasToolUse, true);
});

test("TD-97: hasAnyEvidence = 有任意 run.event 证据事件", () => {
  assert.equal(assessRunEvidence([
    { type: "run.event", kind: "tool_use" },
  ]).hasAnyEvidence, true);
  assert.equal(assessRunEvidence([
    { type: "run.submitted" },
  ]).hasAnyEvidence, false);
});

// ---------------------------------------------------------------------------
// 综合事实 + 无处方（只输出事实不输出建议）
// ---------------------------------------------------------------------------

test("TD-97: 完整事实快照（多种事件混合）", () => {
  const result = assessRunEvidence([
    { type: "run.event", kind: "file_written", path: "a.js" },
    { type: "run.event", kind: "command", command: "test", exitCode: 0 },
    { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "done" }] },
    { type: "run.event", kind: "tool_use", name: "Read" },
  ]);
  assert.equal(result.hasFileWritten, true);
  assert.equal(result.hasCommandExit0, true);
  assert.equal(result.hasAssistantText, true);
  assert.equal(result.hasToolUse, true);
  assert.equal(result.hasAnyEvidence, true);
  assert.equal(result.fileWrittenCount, 1);
  assert.equal(result.commandExit0Count, 1);
  assert.equal(result.assistantTextCount, 1);
});

test("TD-97: assessRunEvidence 不输出建议/处方（只输出事实）", () => {
  const result = assessRunEvidence([]);
  // 确认返回结构没有 recommendation/advice/suggestion 等字段
  for (const key of Object.keys(result)) {
    assert.ok(!/recommend|advice|suggest|should|prescription/i.test(key),
      `assessRunEvidence 不应有处方字段: ${key}`);
  }
});

test("TD-97: 空输入 → 全 false + count 0", () => {
  const result = assessRunEvidence([]);
  assert.equal(result.hasFileWritten, false);
  assert.equal(result.hasCommandExit0, false);
  assert.equal(result.hasAssistantText, false);
  assert.equal(result.hasToolUse, false);
  assert.equal(result.hasAnyEvidence, false);
  assert.equal(result.fileWrittenCount, 0);
  assert.equal(result.commandExit0Count, 0);
  assert.equal(result.assistantTextCount, 0);
});

test("小尾巴1: activityEventCount 把 message/tool/command/file 都算活动（不只 evidenceEventCount）", () => {
  // 只有 assistant text（无 tool_use/command/file）的 run：
  // evidenceEventCount=0（message 不算 evidence），但 activityEventCount 应=1（message 是活动）
  const result = assessRunEvidence([
    { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "reading..." }] },
  ]);
  assert.equal(result.evidenceEventCount, 0, "message 不算 evidence（evidenceEventCount 只计 command/file/tool_result）");
  assert.ok(result.activityEventCount >= 1, "activityEventCount 应把 message 算活动（>=1）");

  // 混合活动
  const mixed = assessRunEvidence([
    { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "hi" }] },
    { type: "run.event", kind: "tool_use", name: "Read" },
    { type: "run.event", kind: "file_written", path: "a.js" },
  ]);
  assert.ok(mixed.activityEventCount >= 3, "混合活动应计 3（message+tool_use+file_written）");
});

// ---------------------------------------------------------------------------
// 混合形状同数组（transcript 落盘 + scorecard 临时共存）
// ---------------------------------------------------------------------------

test("TD-97: 混合形状数组——run.event + run.message 共存都能识别", () => {
  // scorecard 构造的 scorecardEvents 会混入 run.message（临时）+ run.event（落盘）
  const result = assessRunEvidence([
    { type: "run.event", kind: "file_written", path: "a.js" },
    { type: "run.message", role: "assistant", parts: [{ type: "text", text: "from scorecard shape" }] },
    { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "from transcript shape" }] },
  ]);
  assert.equal(result.hasFileWritten, true);
  assert.equal(result.hasAssistantText, true);
  assert.equal(result.assistantTextCount, 2, "两种形状的 assistant text 都应计入");
});
