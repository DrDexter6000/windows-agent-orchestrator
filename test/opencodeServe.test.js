import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeServeBackend } from "../src/backends/opencodeServe.js";

test("creates an OpenCode v2 session and starts it with prompt_async", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/api/session")) {
      return jsonResponse({
        data: {
          id: "ses_test",
          location: { directory: "D:/projects/worktree" },
          title: "",
          projectID: "global",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 },
        },
      });
    }
    if (String(url).startsWith("http://127.0.0.1:4297/session/ses_test/prompt_async")) {
      return noContentResponse();
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl });
  const result = await backend.spawn(
    {
      id: "glm_worker",
      serveUrl: "http://127.0.0.1:4297",
      agent: "build",
      cwd: "D:/projects/worktree",
      model: { providerID: "zhipuai-coding-plan", id: "glm-5.1" },
    },
    { prompt: "Read README only." },
  );

  assert.equal(result.backendSessionId, "ses_test");
  assert.match(result.messageId, /^msg_/);
  assert.equal(result.admittedSeq, null);
  assert.equal(calls.length, 2);

  assert.equal(calls[0].url, "http://127.0.0.1:4297/api/session");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    agent: "build",
    model: { providerID: "zhipuai-coding-plan", id: "glm-5.1" },
    location: { directory: "D:/projects/worktree" },
  });

  assert.equal(
    calls[1].url,
    "http://127.0.0.1:4297/session/ses_test/prompt_async?directory=D%3A%2Fprojects%2Fworktree",
  );
  const promptBody = JSON.parse(calls[1].init.body);
  assert.equal(promptBody.messageID, result.messageId);
  assert.deepEqual(promptBody, {
    messageID: result.messageId,
    agent: "build",
    model: { providerID: "zhipuai-coding-plan", modelID: "glm-5.1" },
    parts: [{ type: "text", text: "Read README only." }],
  });
});

test("collects legacy session messages and normalizes the response", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("http://127.0.0.1:4297/session/ses_test/message")) {
      return jsonResponse([{ info: { id: "msg_test", role: "assistant" }, parts: [] }]);
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl });

  const messages = await backend.messages("http://127.0.0.1:4297", "ses_test", {
    cwd: "D:/projects/worktree",
    limit: 10,
  });

  assert.equal(
    calls[0].url,
    "http://127.0.0.1:4297/session/ses_test/message?directory=D%3A%2Fprojects%2Fworktree&limit=10",
  );
  assert.equal(calls[0].init.method, "GET");
  assert.deepEqual(messages, {
    data: [{ info: { id: "msg_test", role: "assistant" }, parts: [] }],
    cursor: { previous: null, next: null },
  });
});

test("retries on transient connection errors", async () => {
  let attempt = 0;
  const fetchImpl = async (url, init = {}) => {
    attempt += 1;
    if (attempt <= 2) {
      const error = new TypeError("fetch failed");
      error.cause = new Error("ECONNREFUSED");
      error.cause.code = "ECONNREFUSED";
      throw error;
    }
    return jsonResponse([
      { info: { id: "msg_1", role: "assistant" }, parts: [] },
    ]);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, retries: 3, timeout: 5000 });
  const messages = await backend.messages("http://127.0.0.1:4297", "ses_test", { limit: 10 });
  assert.equal(attempt, 3);
  assert.equal(messages.data.length, 1);
});

test("throws after exhausting retries", async () => {
  const fetchImpl = async () => {
    const error = new TypeError("fetch failed");
    error.cause = new Error("ECONNREFUSED");
    error.cause.code = "ECONNREFUSED";
    throw error;
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, retries: 1, timeout: 5000 });
  await assert.rejects(
    () => backend.messages("http://127.0.0.1:4297", "ses_test"),
    { message: /fetch failed/ },
  );
});

test("does not retry on non-transient errors", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return {
      ok: false,
      status: 404,
      async text() {
        return "not found";
      },
    };
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, retries: 3, timeout: 5000 });
  await assert.rejects(
    () => backend.messages("http://127.0.0.1:4297", "ses_test"),
    { message: /OpenCode request failed 404/ },
  );
  assert.equal(attempts, 1);
});

test("healthCheck returns ok for reachable serve", async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/api/session")) {
      return { ok: true, status: 200 };
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const result = await backend.healthCheck("http://127.0.0.1:4297");
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
});

test("healthCheck returns error for unreachable serve", async () => {
  const fetchImpl = async () => {
    throw new TypeError("fetch failed");
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const result = await backend.healthCheck("http://127.0.0.1:4297");
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("fetch failed"));
});

test("streamEvents emits messages then done(completed)", async () => {
  let pollCount = 0;
  const fetchImpl = async () => {
    pollCount += 1;
    // 前 2 次 poll 返回空，第 3 次返回 user+assistant
    if (pollCount < 3) return jsonResponse([]);
    return jsonResponse([
      { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
      { info: { id: "a1", role: "assistant" }, parts: [{ type: "text", text: "done" }] },
    ]);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents("http://127.0.0.1:4297", "ses_test", {
    interval: 10,
  })) {
    events.push(ev);
  }
  // 应该 emit: message(user), message(assistant), done(completed)
  assert.equal(events.length, 3);
  assert.equal(events[0].kind, "message");
  assert.equal(events[0].role, "user");
  assert.equal(events[1].kind, "message");
  assert.equal(events[1].role, "assistant");
  assert.equal(events[2].kind, "done");
  assert.equal(events[2].reason, "completed");
});

test("snapshot-stable: 从 opencode tool part 提取 command/file/tool_result evidence", async () => {
  const assistantMsg = {
    info: { id: "a1", role: "assistant" },
    parts: [
      { type: "step-start" },
      {
        type: "tool",
        callID: "call_bash",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "node --version" },
          output: "v24.13.1",
          metadata: { exit: 0 },
        },
      },
      {
        type: "tool",
        callID: "call_write",
        tool: "write",
        state: {
          status: "completed",
          input: { filePath: "out.txt" },
          output: "ok",
        },
      },
      { type: "text", text: "done" },
    ],
  };
  let pollCount = 0;
  const fetchImpl = async () => {
    pollCount += 1;
    if (pollCount < 2) return jsonResponse([]);
    return jsonResponse([assistantMsg]);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents("http://127.0.0.1:4297", "ses_test", {
    interval: 5,
  })) {
    events.push(ev);
  }

  const command = events.find((e) => e.kind === "command");
  assert.equal(command?.command, "node --version");
  assert.equal(command?.exitCode, 0);
  const file = events.find((e) => e.kind === "file_written");
  assert.equal(file?.path, "out.txt");
  const toolResults = events.filter((e) => e.kind === "tool_result");
  assert.ok(toolResults.some((e) => e.tool === "call_bash" && e.isError === false));
  assert.ok(toolResults.some((e) => e.tool === "call_write" && e.isError === false));
});

test("streamEvents 等 parts 稳定后才 emit（修复流式追加竞态）", async () => {
  // 模拟 opencode 流式：assistant 消息 parts 逐步追加
  // poll 1: assistant 只有 step-start（没 text）
  // poll 2: assistant 有 step-start + text
  // poll 3: 同 poll 2（稳定）→ 此时才 emit
  const stages = [
    [{ info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
     { info: { id: "a1", role: "assistant" }, parts: [{ type: "step-start" }] }],
    [{ info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
     { info: { id: "a1", role: "assistant" }, parts: [{ type: "step-start" }, { type: "text", text: "reply" }] }],
    // 第 3 次和第 2 次相同 → 稳定
  ];
  let pollCount = 0;
  const fetchImpl = async () => {
    const idx = Math.min(pollCount, stages.length - 1);
    pollCount += 1;
    // 最后阶段持续返回稳定结果
    return jsonResponse(idx < 2 ? stages[idx] : stages[1]);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents("http://127.0.0.1:4297", "ses_test", {
    interval: 10,
  })) {
    events.push(ev);
  }
  // 找 assistant message 事件
  const assistantMsg = events.find((e) => e.kind === "message" && e.role === "assistant");
  assert.ok(assistantMsg, "should emit assistant message");
  const textPart = assistantMsg.parts.find((p) => p.type === "text");
  assert.ok(textPart, "assistant parts should contain text (not just step-start)");
  assert.equal(textPart.text, "reply");
});

test("streamEvents 提取 assistant 消息的 token usage（metrics 事件）", async () => {
  // 第 1-2 次 poll 返回空，第 3 次返回带 tokens 的 assistant 消息，第 4 次相同（稳定）
  const assistantMsg = {
    info: {
      id: "a1", role: "assistant",
      tokens: { input: 300, output: 100, reasoning: 5 },
      cost: 0.03,
    },
    parts: [{ type: "text", text: "done" }],
  };
  // metrics 现从 session endpoint 提取（比 message.info.tokens 可靠）
  const sessionData = {
    id: "ses_test",
    tokens: { input: 300, output: 100, reasoning: 5 },
    cost: 0.03,
  };
  let pollCount = 0;
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("/message")) {
      pollCount += 1;
      if (pollCount < 3) return jsonResponse([]);
      return jsonResponse([assistantMsg]);
    }
    if (u.endsWith("/session/ses_test") || u.includes("/session/ses_test?")) {
      return jsonResponse(sessionData);
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents("http://127.0.0.1:4297", "ses_test", {
    interval: 10,
  })) {
    events.push(ev);
  }
  const metrics = events.find((e) => e.kind === "metrics");
  assert.ok(metrics, "should emit metrics event");
  assert.equal(metrics.tokens.input, 300);
  assert.equal(metrics.tokens.output, 100);
  assert.equal(metrics.tokens.reasoning, 5);
  assert.equal(metrics.costUsd, 0.03);
  // done 仍存在
  assert.ok(events.some((e) => e.kind === "done"));
});

test("streamEvents 无 tokens 时不 emit metrics（不崩溃）", async () => {
  const assistantMsg = {
    info: { id: "a1", role: "assistant" }, // 无 tokens
    parts: [{ type: "text", text: "done" }],
  };
  let pollCount = 0;
  const fetchImpl = async () => {
    pollCount += 1;
    if (pollCount < 3) return jsonResponse([]);
    return jsonResponse([assistantMsg]);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents("http://127.0.0.1:4297", "ses_test", {
    interval: 10,
  })) {
    events.push(ev);
  }
  assert.ok(!events.some((e) => e.kind === "metrics"), "no metrics when no tokens");
  assert.ok(events.some((e) => e.kind === "done"));
});

test("snapshot-stable: metrics 从 session endpoint 提取真实累计 token（不依赖 message.info.tokens）", async () => {
  // 真实场景：message.info.tokens 在流式期间是 0，session.tokens 是 serve 维护的累计值。
  // metrics 必须来自 session endpoint，不是 message。
  const realMsg = {
    info: { id: "a1", role: "assistant", tokens: { input: 0, output: 0, reasoning: 0 }, cost: 0 },
    parts: [{ type: "text", text: "WAO_OK" }],
  };
  const sessionData = {
    id: "ses_test",
    tokens: { input: 26673, output: 5, reasoning: 0 },
    cost: 0.01,
  };
  let pollCount = 0;
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("/message")) {
      pollCount += 1;
      if (pollCount < 3) return jsonResponse([]);
      return jsonResponse([realMsg]);
    }
    // session endpoint（无 /message 后缀）
    if (u.endsWith("/session/ses_test") || u.includes("/session/ses_test?")) {
      return jsonResponse(sessionData);
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents("http://127.0.0.1:4297", "ses_test", {
    interval: 5,
  })) {
    events.push(ev);
  }
  const metrics = events.find((e) => e.kind === "metrics");
  assert.ok(metrics, "应该 emit metrics");
  assert.equal(metrics.tokens.input, 26673, "input 应来自 session endpoint（26673），不是 message 的 0");
  assert.equal(metrics.tokens.output, 5, "output 应来自 session endpoint（5），不是 message 的 0");
});

test("streamEvents emits done(failed) when poll throws", async () => {
  const fetchImpl = async () => {
    throw new Error("connection reset");
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents("http://127.0.0.1:4297", "ses_test", {
    interval: 10,
  })) {
    events.push(ev);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "done");
  assert.equal(events[0].reason, "failed");
  assert.ok(events[0].error.includes("connection reset"));
});

test("streamEvents stops when signal aborts (no done emitted)", async () => {
  // 持续返回空，模拟永不完成。signal abort 应让流终止
  const fetchImpl = async () => jsonResponse([]);
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const controller = new AbortController();
  const events = [];
  // 50ms 后 abort
  setTimeout(() => controller.abort(), 50);
  for await (const ev of backend.streamEvents("http://127.0.0.1:4297", "ses_test", {
    interval: 10,
    signal: controller.signal,
  })) {
    events.push(ev);
  }
  // abort 时不 emit done，流静默结束
  assert.equal(events.length, 0);
});

test("spawn returns events factory and abort", async () => {
  const fetchImpl = async (url, init = {}) => {
    const urlStr = String(url);
    if (init.method === "POST" && urlStr.endsWith("/api/session")) {
      return jsonResponse({ data: { id: "ses_handle" } });
    }
    if (init.method === "POST" && urlStr.includes("/prompt_async")) {
      return noContentResponse();
    }
    throw new Error(`unexpected ${url}`);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(
    {
      id: "test",
      serveUrl: "http://127.0.0.1:4297",
      agent: "build",
      cwd: "D:/test",
      model: { providerID: "p", id: "m" },
    },
    { prompt: "hi" },
  );
  assert.equal(typeof handle.events, "function");
  assert.equal(typeof handle.abort, "function");
  assert.equal(handle.backendSessionId, "ses_handle");
});

function jsonResponse(value) {
  return {
    ok: true,
    status: 200,
    async json() {
      return value;
    },
    async text() {
      return JSON.stringify(value);
    },
  };
}

function noContentResponse() {
  return {
    ok: true,
    status: 204,
    async json() {
      throw new SyntaxError("Unexpected end of JSON input");
    },
    async text() {
      return "";
    },
  };
}

// ===== first-stable completionMode（解决 DeepSeek 无限多轮）=====

test("first-stable: 首条 assistant 有 step-finish 后判定完成，emit 首条 message", async () => {
  const stableAssistant = {
    info: { id: "a1", role: "assistant", tokens: { input: 100, output: 5 } },
    parts: [
      { type: "step-start" },
      { type: "text", text: "东方" },
      { type: "step-finish", reason: "stop" },
    ],
  };
  let pollCount = 0;
  const abortCalls = [];
  const fetchImpl = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes("/abort")) {
      abortCalls.push(urlStr);
      return noContentResponse();
    }
    if (urlStr.includes("/session/ses_test") && !urlStr.includes("/message")) {
      return jsonResponse({ id: "ses_test", tokens: { input: 100, output: 5 }, cost: 0 });
    }
    pollCount += 1;
    if (pollCount < 2) return jsonResponse([]);
    if (pollCount === 2) {
      return jsonResponse([
        { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
        stableAssistant,
      ]);
    }
    return jsonResponse([
      { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
      stableAssistant,
      { info: { id: "a2", role: "assistant" }, parts: [{ type: "text", text: "已完成" }] },
    ]);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents("http://127.0.0.1:4297", "ses_test", {
    interval: 10,
    completionMode: "first-stable",
  })) {
    if (ev.kind === "done") {
      assert.equal(abortCalls.length, 1, "abort must happen before done is yielded");
    }
    events.push(ev);
  }
  const assistantMsgs = events.filter((e) => e.kind === "message" && e.role === "assistant");
  assert.equal(assistantMsgs.length, 1, "should emit only first assistant message");
  assert.equal(events.at(-1).kind, "done");
  assert.equal(events.at(-1).reason, "completed");
  assert.ok(abortCalls.length > 0, "should call abort to stop background token consumption");
  assert.equal(pollCount, 2, "should not wait an extra confirmation poll after step-finish");
});

test("first-stable: metrics 从 session endpoint 取（不用 message.info.tokens，后者偏小）", async () => {
  // codex 实测：researcher-01 CLI metrics input:408，但 session 实际 29706。
  // message.info.tokens 是首条 message 的瞬时值（偏小），session.tokens 是累计值（真实）。
  // first-stable 完成后必须从 session endpoint 取 metrics（abort 前取）。
  const answerMsg = {
    info: { id: "a1", role: "assistant", tokens: { input: 408, output: 35, reasoning: 48 } },
    parts: [
      { type: "step-start" },
      { type: "text", text: "answer" },
      { type: "step-finish", reason: "stop" },
    ],
  };
  const sessionData = {
    id: "ses_test",
    tokens: { input: 29706, output: 131, reasoning: 86 },
    cost: 0.005,
  };
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("/abort")) return noContentResponse();
    if (u.includes("/session/ses_test") && !u.includes("/message")) {
      return jsonResponse(sessionData);
    }
    return jsonResponse([
      { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "task" }] },
      answerMsg,
    ]);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents("http://127.0.0.1:4297", "ses_test", {
    interval: 5, completionMode: "first-stable",
  })) {
    events.push(ev);
  }
  const metrics = events.find((e) => e.kind === "metrics");
  assert.ok(metrics, "应 emit metrics");
  assert.equal(metrics.tokens.input, 29706, "input 应来自 session endpoint（29706），不是 message 的 408");
  assert.equal(metrics.tokens.output, 131, "output 应来自 session endpoint（131）");
});

test("first-stable: 有 tool part 时不提前 done（等工具完成）", async () => {
  const stages = [
    [],
    [{ info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "write file" }] },
     { info: { id: "a1", role: "assistant" }, parts: [
       { type: "step-start" },
       { type: "tool", tool: "write", state: { status: "completed" } },
     ] }],
    [{ info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "write file" }] },
     { info: { id: "a1", role: "assistant" }, parts: [
       { type: "step-start" },
       { type: "tool", tool: "write", state: { status: "completed" } },
       { type: "text", text: "done" },
       { type: "step-finish", reason: "stop" },
     ] }],
    [{ info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "write file" }] },
     { info: { id: "a1", role: "assistant" }, parts: [
       { type: "step-start" },
       { type: "tool", tool: "write", state: { status: "completed" } },
       { type: "text", text: "done" },
       { type: "step-finish", reason: "stop" },
     ] },
     { info: { id: "a2", role: "assistant" }, parts: [{ type: "text", text: "已确认" }] }],
  ];
  let pollCount = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("/abort")) return noContentResponse();
    if (String(url).includes("/session/ses_test") && !String(url).includes("/message")) {
      return jsonResponse({ id: "ses_test", tokens: { input: 100, output: 5 }, cost: 0 });
    }
    const idx = Math.min(pollCount, stages.length - 1);
    pollCount += 1;
    return jsonResponse(stages[idx]);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents("http://127.0.0.1:4297", "ses_test", {
    interval: 10,
    completionMode: "first-stable",
  })) {
    events.push(ev);
  }
  const done = events.find((e) => e.kind === "done");
  assert.ok(done, "should eventually done");
  assert.equal(done.reason, "completed");
  const assistantMsg = events.find((e) => e.kind === "message" && e.role === "assistant");
  assert.ok(assistantMsg.parts.some((p) => p.type === "tool"), "should wait for tool to complete");
  assert.ok(assistantMsg.parts.some((p) => p.type === "step-finish"), "should have step-finish");
  assert.equal(pollCount, 3, "should stop on the first poll that contains step-finish");
});

test("snapshot-stable（默认）不受 first-stable 影响（向后兼容）", async () => {
  const stableAssistant = {
    info: { id: "a1", role: "assistant" },
    parts: [{ type: "text", text: "hi" }],
  };
  let pollCount = 0;
  const fetchImpl = async () => {
    pollCount += 1;
    if (pollCount < 2) return jsonResponse([]);
    return jsonResponse([stableAssistant]);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents("http://127.0.0.1:4297", "ses_test", {
    interval: 10,
  })) {
    events.push(ev);
  }
  assert.equal(events.at(-1).kind, "done");
  assert.equal(events.at(-1).reason, "completed");
});

// ---------------------------------------------------------------------------
// provider 错误识别（实战事故修复，2026-06-17）
//
// opencode serve 把 provider 错误（401/欠费/限流）包成 assistant message：
//   { info: { role: "assistant", error: { name, data: { message, statusCode } } }, parts: [] }
// parts 为空 → 旧逻辑看不到它 → 卡 submitted 直到超时烧 60s。
// 契约：检测到 message.error 时立即 done(failed) + 透传错误，秒级失败。
// ---------------------------------------------------------------------------

/** 构造 provider 401 错误 message（与真实 serve 响应同构）。 */
function providerErrorAssistant(statusCode = 401, message = "身份验证失败。") {
  return {
    info: {
      id: "a_err",
      role: "assistant",
      error: { name: "APIError", data: { message, statusCode, isRetryable: false } },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
    },
    parts: [],
  };
}

test("snapshot-stable: provider 401 时立即 done(failed) 并透传错误（不卡超时）", async () => {
  let pollCount = 0;
  const fetchImpl = async () => {
    pollCount += 1;
    // 旧逻辑看不到 parts:[] 的 error message → 会无限 poll；
    // pollCount > 8 时强制抛错兜底，防测试无限挂起
    if (pollCount > 8) throw new Error("test_guard: snapshot-stable 未识别 error，poll 了 8 次");
    return jsonResponse([
      { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
      providerErrorAssistant(401, "身份验证失败。"),
    ]);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents("http://127.0.0.1:4297", "ses_test", {
    interval: 5,
  })) {
    events.push(ev);
  }
  const done = events.find((e) => e.kind === "done");
  assert.ok(done, "应该 emit done");
  assert.equal(done.reason, "failed", "provider 401 应判 failed 而非 completed");
  assert.ok(
    /401|身份验证|验证失败/.test(done.error ?? ""),
    `done.error 应透传 provider 错误详情，实际: ${done.error}`
  );
  assert.ok(pollCount <= 3, `应在几次 poll 内失败，实际 poll ${pollCount} 次`);
});

test("first-stable: provider 401 时立即 done(failed)（不卡超时，不误判 completed）", async () => {
  let pollCount = 0;
  const fetchImpl = async () => {
    pollCount += 1;
    if (pollCount > 8) throw new Error("test_guard: first-stable 未识别 error，poll 了 8 次");
    return jsonResponse([
      { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
      providerErrorAssistant(401, "身份验证失败。"),
    ]);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents("http://127.0.0.1:4297", "ses_test", {
    interval: 5,
    completionMode: "first-stable",
  })) {
    events.push(ev);
  }
  const done = events.find((e) => e.kind === "done");
  assert.ok(done, "应该 emit done");
  assert.equal(done.reason, "failed", "first-stable 下 provider 401 也应判 failed");
  assert.ok(
    /401|身份验证|验证失败/.test(done.error ?? ""),
    `done.error 应透传 provider 错误详情，实际: ${done.error}`
  );
});

test("snapshot-stable: MessageAbortedError（abort 副作用）不误判为 provider failed", async () => {
  // 真实场景：first-stable/_runCleanup 调 abort 后，serve 产生一条
  // { error: { name: "MessageAbortedError" }, parts: [] } 的尾随 message。
  // 这不是 provider 错误，不能判 failed。
  // 这里测 snapshot-stable 看到成功 message + 一条 aborted message 时，
  // 不应因 aborted 而 failed，应正常 completed。
  let pollCount = 0;
  const fetchImpl = async () => {
    pollCount += 1;
    if (pollCount > 8) throw new Error("test_guard");
    return jsonResponse([
      { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
      { info: { id: "a1", role: "assistant", tokens: { input: 10, output: 5 } }, parts: [{ type: "text", text: "done" }] },
      { info: { id: "a2", role: "assistant", error: { name: "MessageAbortedError", data: { message: "Aborted" } } }, parts: [] },
    ]);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents("http://127.0.0.1:4297", "ses_test", {
    interval: 5,
  })) {
    events.push(ev);
  }
  const done = events.find((e) => e.kind === "done");
  assert.ok(done, "应该 emit done");
  assert.equal(done.reason, "completed", "MessageAbortedError 不应让 run failed，应正常 completed");
});

// ---------------------------------------------------------------------------
// first-stable C' 重设计（2026-06-17 实测验证）
//
// 实验证据（snapshot-stable 跑 DeepSeek 多轮任务）：
//   msg[0] = [step-start, reasoning, tool, tool, step-finish]  ← 有 step-finish 但无 text（还在干活）
//   msg[1] = [step-start, reasoning, text, step-finish]        ← 首条含 text（=答案）
//   msg[2+] = 重复 text（无限循环）
//
// 旧判据（step-finish）会在 msg[0] 截断 → 过早完成，没给答案。
// C' 判据：首条含非空 text part 的 assistant message 即完成 + abort。
// 精确区分"还在干活（msg[0]，有 tool 无 text）"和"给出答案（msg[1]，有 text）"。
// ---------------------------------------------------------------------------

test("first-stable C': 工具调用轮（有 step-finish 但无 text）不提前完成", async () => {
  // 真实多轮场景 msg[0]：读了文件，有 step-finish，但还没给 text 答案
  const toolMsg = {
    info: { id: "a1", role: "assistant", tokens: { input: 100, output: 5 } },
    parts: [
      { type: "step-start" },
      { type: "tool", tool: "read", state: { status: "completed" } },
      { type: "tool", tool: "read", state: { status: "completed" } },
      { type: "step-finish", reason: "stop" },
    ],
  };
  let pollCount = 0;
  const abortCalls = [];
  const fetchImpl = async (url) => {
    if (String(url).includes("/abort")) { abortCalls.push(String(url)); return noContentResponse(); }
    pollCount += 1;
    if (pollCount > 8) throw new Error("test_guard: first-stable 在无 text 的 msg 上不应完成");
    // 始终只返回 toolMsg（无 text answer）——模拟模型卡在工具轮
    return jsonResponse([
      { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "task" }] },
      toolMsg,
    ]);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents("http://127.0.0.1:4297", "ses_test", {
    interval: 5, completionMode: "first-stable",
  })) {
    events.push(ev);
  }
  // 没出现 text answer → 不应 done(completed)；应被 test_guard 打断（done failed）
  const done = events.find((e) => e.kind === "done");
  assert.ok(!done || done.reason === "failed",
    "工具轮（有 step-finish 无 text）不应判定 completed——这正是旧 bug");
});

test("first-stable C': 首条含 text part 的 assistant message 即完成 + abort", async () => {
  // 多轮场景：msg[0] 工具轮（无 text）→ msg[1] text 答案 → 完成
  const toolMsg = {
    info: { id: "a1", role: "assistant", tokens: { input: 100, output: 5 } },
    parts: [
      { type: "step-start" },
      { type: "tool", tool: "read", state: { status: "completed" } },
      { type: "step-finish", reason: "stop" },
    ],
  };
  const answerMsg = {
    info: { id: "a2", role: "assistant", tokens: { input: 110, output: 20 } },
    parts: [
      { type: "step-start" },
      { type: "text", text: "This is the answer after reading files." },
      { type: "step-finish", reason: "stop" },
    ],
  };
  let pollCount = 0;
  const abortCalls = [];
  const fetchImpl = async (url) => {
    if (String(url).includes("/abort")) { abortCalls.push(String(url)); return noContentResponse(); }
    pollCount += 1;
    if (pollCount < 2) return jsonResponse([]);
    if (pollCount === 2) {
      // 第一次只看到工具轮
      return jsonResponse([
        { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "task" }] },
        toolMsg,
      ]);
    }
    // 第二次看到工具轮 + 答案轮
    return jsonResponse([
      { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "task" }] },
      toolMsg,
      answerMsg,
    ]);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents("http://127.0.0.1:4297", "ses_test", {
    interval: 5, completionMode: "first-stable",
  })) {
    events.push(ev);
  }
  const done = events.find((e) => e.kind === "done");
  assert.ok(done, "应 emit done");
  assert.equal(done.reason, "completed", "text 答案出现应判定 completed");
  assert.ok(abortCalls.length > 0, "完成应调 abort 防无限循环");
  // 应 emit 含 text 的 answer message
  const assistantMsgs = events.filter((e) => e.kind === "message" && e.role === "assistant");
  assert.ok(assistantMsgs.length > 0, "应 emit assistant message");
});

// ---------------------------------------------------------------------------
// snapshot-stable text 完成判据（codex 实测暴露，2026-06-17）
//
// coder-01 实测：GLM 读了两个文件（tool part），给 step-finish，但无 text 答案。
// snapshot-stable 看到 tool part（非 step-start）→ hasAssistant=true → 两轮稳定 → completed。
// 但实际 assistantTextCount=0，没给答案——伪完成。
//
// 修复：snapshot-stable 的 completed 判定要求至少一条 assistant message 有非空 text part
// （与 first-stable C' 对齐）。tool-only message 不得判 completed。
// ---------------------------------------------------------------------------

test("snapshot-stable: tool-call 轮稳定但无 text 答案时不判 completed（防伪完成）", async () => {
  // GLM 真实场景 msg[0]：[step-start, reasoning, tool, tool, step-finish]——有 tool，无 text
  const toolOnlyMsg = {
    info: { id: "a1", role: "assistant", tokens: { input: 100, output: 5 } },
    parts: [
      { type: "step-start" },
      { type: "tool", tool: "read", state: { status: "completed" } },
      { type: "tool", tool: "read", state: { status: "completed" } },
      { type: "step-finish", reason: "stop" },
    ],
  };
  let pollCount = 0;
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("/session/ses_test") && !u.includes("/message")) {
      // session endpoint for metrics
      return jsonResponse({ id: "ses_test", tokens: { input: 100, output: 5 }, cost: 0 });
    }
    pollCount += 1;
    if (pollCount > 12) throw new Error("test_guard: snapshot-stable 在无 text 时不应 completed");
    // 始终只返回 tool-only message（模拟模型停在工具轮，永不给 text）
    return jsonResponse([
      { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "task" }] },
      toolOnlyMsg,
    ]);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents("http://127.0.0.1:4297", "ses_test", {
    interval: 5,
  })) {
    events.push(ev);
  }
  // 无 text 答案 → 不应 completed；应被 test_guard 打断（done failed）或无 done
  const done = events.find((e) => e.kind === "done");
  assert.ok(!done || done.reason === "failed",
    "tool-call 轮（无 text）即使快照稳定也不应判 completed——这是伪完成 bug");
});

test("snapshot-stable: 快照稳定 + 有 text 答案时正常 completed", async () => {
  // 先 tool-only（观察中），再 tool + text（答案出现）→ 两轮稳定 → completed
  const toolOnlyMsg = {
    info: { id: "a1", role: "assistant", tokens: { input: 100, output: 5 } },
    parts: [
      { type: "step-start" },
      { type: "tool", tool: "read", state: { status: "completed" } },
      { type: "step-finish", reason: "stop" },
    ],
  };
  const answerMsg = {
    info: { id: "a2", role: "assistant", tokens: { input: 110, output: 20 } },
    parts: [
      { type: "step-start" },
      { type: "text", text: "Here is the answer." },
      { type: "step-finish", reason: "stop" },
    ],
  };
  let pollCount = 0;
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("/session/ses_test") && !u.includes("/message")) {
      return jsonResponse({ id: "ses_test", tokens: { input: 210, output: 25 }, cost: 0 });
    }
    pollCount += 1;
    if (pollCount < 2) return jsonResponse([]);
    if (pollCount === 2) {
      return jsonResponse([
        { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "task" }] },
        toolOnlyMsg,
      ]);
    }
    return jsonResponse([
      { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "task" }] },
      toolOnlyMsg,
      answerMsg,
    ]);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents("http://127.0.0.1:4297", "ses_test", {
    interval: 5,
  })) {
    events.push(ev);
  }
  const done = events.find((e) => e.kind === "done");
  assert.ok(done, "应 emit done");
  assert.equal(done.reason, "completed", "有 text 答案 + 快照稳定 → completed");
});

// ---------------------------------------------------------------------------
// 静默 timeout 早失败（codex 实测建议，2026-06-17）
//
// Kimi 白名单 / 不存在的 model：serve 不产生 error message，也不产生 assistant message。
// 旧逻辑只能等完整 waitTimeout。加 silentTimeout：超过该时长仍无 assistant 无 error → done(failed)。
// ---------------------------------------------------------------------------

test("snapshot-stable: 静默无响应（无 assistant 无 error）超过 silentTimeout 时早失败", async () => {
  // 模拟 Kimi 白名单静默拒绝：永远只返回 user message，无 assistant，无 error
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("/session/ses_test") && !u.includes("/message")) {
      return jsonResponse({ id: "ses_test", tokens: { input: 0, output: 0 }, cost: 0 });
    }
    return jsonResponse([
      { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "task" }] },
    ]);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  const start = Date.now();
  for await (const ev of backend.streamEvents("http://127.0.0.1:4297", "ses_test", {
    interval: 50,
    silentTimeout: 300,  // 300ms 无响应即失败（测试用短值）
  })) {
    events.push(ev);
  }
  const elapsed = Date.now() - start;
  const done = events.find((e) => e.kind === "done");
  assert.ok(done, "应 emit done");
  assert.equal(done.reason, "failed", "静默无响应应早失败 done(failed)");
  assert.match(done.error ?? "", /silent|no.*response|无.*响应/i, "应有静默失败说明");
  assert.ok(elapsed < 2000, `应在 silentTimeout 附近失败（<2s），实际 ${elapsed}ms`);
});

test("first-stable: 静默无响应（无 assistant 无 error）超过 silentTimeout 时早失败", async () => {
  const fetchImpl = async () => {
    return jsonResponse([
      { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "task" }] },
    ]);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  const start = Date.now();
  for await (const ev of backend.streamEvents("http://127.0.0.1:4297", "ses_test", {
    interval: 50,
    completionMode: "first-stable",
    silentTimeout: 300,
  })) {
    events.push(ev);
  }
  const elapsed = Date.now() - start;
  const done = events.find((e) => e.kind === "done");
  assert.ok(done, "应 emit done");
  assert.equal(done.reason, "failed", "first-stable 静默无响应也应早失败");
  assert.ok(elapsed < 2000, `应在 silentTimeout 附近失败（<2s），实际 ${elapsed}ms`);
});

// ---------------------------------------------------------------------------
// S1-1 回归：周期性 metrics（2026-06-23 真实验证暴露的缺陷修复）
//
// 缺陷：原版只在完成判定后取 session token → 失控 run 永不完成 → 永不 emit metrics
// → 挂在 metrics 事件上的 token 预算闸门永不触发。
// 修复：streamEvents 每 METRICS_POLL_EVERY 轮主动取 session token 并 yield metrics。
// 此测试锁死该修复——run 未完成（还在轮询）时也必须出现 metrics 事件。
// ---------------------------------------------------------------------------

test("S1-1 回归: 失控 run（永不完成）也必须周期性 yield metrics（否则预算闸门永不触发）", async () => {
  let messagePolls = 0;
  const fetchImpl = async (url) => {
    const u = String(url);
    // messages 永远只返回 user message（无 assistant）→ 永不触发完成判定 → 模拟失控
    if (u.includes("/message")) {
      messagePolls += 1;
      return jsonResponse([
        { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "do not finish" }] },
      ]);
    }
    // session endpoint 返回递增 token（模拟后台持续烧 token）
    if (u.endsWith("/session/ses_runaway") || u.includes("/session/ses_runaway?")) {
      return jsonResponse({
        tokens: { input: 1000 * messagePolls, output: 100 * messagePolls, reasoning: 0 },
        cost: 0.001 * messagePolls,
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  const controller = new AbortController();
  // 跑足够多轮让 METRICS_POLL_EVERY(5) 触发至少一次 metrics，然后 abort 退出
  setTimeout(() => controller.abort(), 400);
  for await (const ev of backend.streamEvents("http://127.0.0.1:4297", "ses_runaway", {
    interval: 30,
    completionMode: "snapshot-stable",
    signal: controller.signal,
  })) {
    events.push(ev);
    if (events.length > 50) break; // 安全兜底
  }
  const metricsEvents = events.filter((e) => e.kind === "metrics");
  assert.ok(metricsEvents.length > 0,
    `失控 run 必须周期性 yield metrics（否则预算闸门永不触发），got ${metricsEvents.length}`);
  // 验证 metrics 值确实是递增的（反映后台 token 增长）
  assert.ok(metricsEvents[0].tokens.input > 0, "metrics token 应非零");
});
