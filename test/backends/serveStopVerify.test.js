import test from "node:test";
import assert from "node:assert/strict";

import { verifyStopQuiet, executeStopWithVerification } from "../../src/backends/serveStopVerify.js";

/**
 * mock backend：session() 和 messages() 返回值可控。
 * sessionTokensSeq: 每次调 session() 取下一个值（模拟递增/稳定）。
 * messagesSeq: 同理，每次调 messages() 取下一个数组。
 */
function mockBackend({ sessionTokensSeq, messagesSeq }) {
  let sessionCalls = 0;
  let messagesCalls = 0;
  return {
    calls: () => ({ session: sessionCalls, messages: messagesCalls }),
    async sessionStatus() {
      return null;
    },
    async session() {
      const tokens = sessionTokensSeq[Math.min(sessionCalls, sessionTokensSeq.length - 1)];
      sessionCalls += 1;
      return { tokens, time: { updated: Date.now() } };
    },
    async messages() {
      const msgs = messagesSeq[Math.min(messagesCalls, messagesSeq.length - 1)];
      messagesCalls += 1;
      return { data: msgs, cursor: { previous: null, next: null } };
    },
  };
}

// 一条 MessageAbortedError 尾随 message（abort 副产物，Explore 确认会 +1）
const abortedMsg = {
  info: { role: "assistant", error: { name: "MessageAbortedError" } },
  parts: [],
};
const userMsg = { info: { role: "user" }, parts: [{ type: "text", text: "x" }] };
const assistantMsg = { info: { role: "assistant" }, parts: [{ type: "text", text: "y" }] };

test("S1-2: token 持续递增 → quiet=false（abort 未生效，后台仍在烧）", async () => {
  // 每轮 output 递增：100, 200, 300 → 任一轮增长即未停
  const backend = mockBackend({
    sessionTokensSeq: [
      { input: 1000, output: 100, reasoning: 0 },
      { input: 1000, output: 200, reasoning: 0 },
      { input: 1000, output: 300, reasoning: 0 },
    ],
    messagesSeq: [[userMsg, assistantMsg, abortedMsg]],
  });
  const result = await verifyStopQuiet(backend, "http://x", "ses_test", { cwd: "/tmp", rounds: 3, intervalMs: 1 });
  assert.equal(result.quiet, false, "token 递增说明 abort 未停住后台，必须报 quiet=false");
  assert.ok(result.delta, "应返回 delta 说明增长量");
  assert.ok(result.metric, "应说明是哪个指标检测到增长");
});

test("S1-2: token 连续 3 轮不变 → quiet=true（abort 生效）", async () => {
  const backend = mockBackend({
    sessionTokensSeq: [
      { input: 1000, output: 500, reasoning: 0 },
      { input: 1000, output: 500, reasoning: 0 },
      { input: 1000, output: 500, reasoning: 0 },
    ],
    messagesSeq: [[userMsg, assistantMsg, abortedMsg]],
  });
  const result = await verifyStopQuiet(backend, "http://x", "ses_test", { cwd: "/tmp", rounds: 3, intervalMs: 1 });
  assert.equal(result.quiet, true, "token 3 轮不变说明后台已停");
});

test("S1-2: MessageAbortedError 尾随 message 不被误判为增长（作为 abort 基线）", async () => {
  // 所有轮 messages 都含 abortedMsg（abort 副产物），数量不变 → quiet=true
  const stableMsgs = [userMsg, assistantMsg, abortedMsg];
  const backend = mockBackend({
    sessionTokensSeq: [
      { input: 1000, output: 500, reasoning: 0 },
      { input: 1000, output: 500, reasoning: 0 },
      { input: 1000, output: 500, reasoning: 0 },
    ],
    messagesSeq: [stableMsgs, stableMsgs, stableMsgs],
  });
  const result = await verifyStopQuiet(backend, "http://x", "ses_test", { cwd: "/tmp", rounds: 3, intervalMs: 1 });
  assert.equal(result.quiet, true, "aborted message 是 abort 基线，不算增长");
});

test("S1-2: delayed MessageAbortedError 不被误判为后台继续生成", async () => {
  const backend = mockBackend({
    sessionTokensSeq: [
      { input: 1000, output: 500, reasoning: 0 },
      { input: 1000, output: 500, reasoning: 0 },
      { input: 1000, output: 500, reasoning: 0 },
    ],
    messagesSeq: [
      [userMsg, assistantMsg],
      [userMsg, assistantMsg, abortedMsg],
      [userMsg, assistantMsg, abortedMsg],
    ],
  });
  const result = await verifyStopQuiet(backend, "http://x", "ses_test", {
    cwd: "/tmp",
    rounds: 3,
    intervalMs: 1,
  });
  assert.equal(result.quiet, true, "delayed abort marker is not active generation");
});

test("S1-2: messages 数量增长（新 message 出现）→ quiet=false，即使 token 稳定", async () => {
  // token 不变，但第 2 轮多了一条 assistant message（后台又生成了一轮）
  const backend = mockBackend({
    sessionTokensSeq: [
      { input: 1000, output: 500, reasoning: 0 },
      { input: 1000, output: 500, reasoning: 0 },
      { input: 1000, output: 500, reasoning: 0 },
    ],
    messagesSeq: [
      [userMsg, assistantMsg, abortedMsg],
      [userMsg, assistantMsg, assistantMsg, abortedMsg], // +1 新 assistant
      [userMsg, assistantMsg, assistantMsg, abortedMsg],
    ],
  });
  const result = await verifyStopQuiet(backend, "http://x", "ses_test", { cwd: "/tmp", rounds: 3, intervalMs: 1 });
  assert.equal(result.quiet, false, "message 数量增长也是后台未停的信号");
});

// ---------------------------------------------------------------------------
// executeStopWithVerification（S1-2 高层编排）
//
// 编排：abort → verifyStopQuiet → quiet=false 时强制 taskkill 兜底。
// 返回结构化结果，由 stopCommand 写 transcript。纯函数，不依赖 transcript/CLI。
// ---------------------------------------------------------------------------

function mockBackendWithAbort({ sessionTokensSeq, messagesSeq, abortShouldFail = false }) {
  let abortCalls = 0;
  let taskkillCalls = 0;
  const inner = mockBackend({ sessionTokensSeq, messagesSeq });
  return {
    ...inner,
    async abort() {
      abortCalls += 1;
      if (abortShouldFail) throw new Error("abort failed");
    },
    abortCalls: () => abortCalls,
    // taskkill 兜底钩子（生产里是调用方的树杀实现，测试里计数）
    taskkillCalls: () => taskkillCalls,
    _recordTaskkill: () => { taskkillCalls += 1; },
  };
}

test("S1-2: executeStopWithVerification — quiet=true → verified，不 taskkill", async () => {
  const backend = mockBackendWithAbort({
    sessionTokensSeq: [
      { input: 1000, output: 500, reasoning: 0 },
      { input: 1000, output: 500, reasoning: 0 },
      { input: 1000, output: 500, reasoning: 0 },
    ],
    messagesSeq: [[userMsg, assistantMsg, abortedMsg]],
  });
  const result = await executeStopWithVerification(backend, "http://x", "ses_test", {
    cwd: "/tmp", rounds: 3, intervalMs: 1, taskkill: () => { backend._recordTaskkill(); },
  });
  assert.equal(result.verified, true, "后台已静默 → stop verified");
  assert.equal(result.abortCalled, true);
  assert.equal(result.taskkillCalled, false, "quiet=true 不应 taskkill");
});

test("S1-2: executeStopWithVerification — quiet=false → unverified + taskkill 兜底", async () => {
  const backend = mockBackendWithAbort({
    sessionTokensSeq: [
      { input: 1000, output: 100, reasoning: 0 },
      { input: 1000, output: 200, reasoning: 0 },
      { input: 1000, output: 300, reasoning: 0 },
    ],
    messagesSeq: [[userMsg, assistantMsg, abortedMsg]],
  });
  const result = await executeStopWithVerification(backend, "http://x", "ses_test", {
    cwd: "/tmp", rounds: 3, intervalMs: 1, taskkill: () => { backend._recordTaskkill(); },
  });
  assert.equal(result.verified, false, "后台仍在烧 → stop unverified");
  assert.equal(result.taskkillCalled, true, "quiet=false 必须强制 taskkill 兜底");
  assert.ok(result.verifyResult?.delta, "应带 verify 详情");
});

function stopBackend({ status = null, unavailable = false } = {}) {
  let abortCalls = 0;
  return {
    get abortCalls() {
      return abortCalls;
    },
    async abort() {
      abortCalls += 1;
    },
    async sessionStatus() {
      if (unavailable) throw new Error("status unavailable");
      return status;
    },
    async session() {
      if (unavailable) throw new Error("session unavailable");
      return { tokens: { input: 10, output: 2, reasoning: 0 } };
    },
    async messages() {
      if (unavailable) throw new Error("messages unavailable");
      return { data: [{ info: { role: "assistant" }, parts: [] }] };
    },
  };
}

test("S1-2: 观测不可用 → 绝不记为已核实静止，也不 taskkill", async () => {
  const backend = stopBackend({ unavailable: true });
  let taskkillCalls = 0;
  const result = await executeStopWithVerification(backend, "http://x", "ses_unknown", {
    rounds: 2,
    intervalMs: 1,
    taskkill: async () => {
      taskkillCalls += 1;
    },
  });

  assert.equal(result.abortCalled, true);
  assert.equal(result.verified, false);
  assert.equal(result.verifyResult?.quiet, null);
  assert.equal(result.verifyResult?.observation, "unavailable");
  assert.equal(taskkillCalls, 0, "unknown observation must not kill unrelated sessions on a shared serve");
});

test("S1-2: 未知会话状态 → 不可观察，不是已核实静止", async () => {
  const backend = stopBackend({ status: { type: "future-state" } });
  const result = await verifyStopQuiet(backend, "http://x", "ses_future", {
    rounds: 2,
    intervalMs: 1,
  });

  assert.equal(result.quiet, null);
  assert.equal(result.observation, "unavailable");
});

test("S1-2: 会话状态 busy 压过稳定的计数", async () => {
  const backend = stopBackend({ status: { type: "busy" } });
  const result = await verifyStopQuiet(backend, "http://x", "ses_busy", {
    rounds: 2,
    intervalMs: 1,
  });

  assert.equal(result.quiet, false);
  assert.equal(result.metric, "session_status");
});
