import { mkdtemp, readFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { RunManager, gracefulShutdown } from "../src/runManager.js";
import { OpenCodeServeBackend } from "../src/backends/opencodeServe.js";
import { JsonlTranscript, findLastEventSeq, readTranscript, findState } from "../src/transcript.js";
import { createSecretRedactor } from "../src/secretRedaction.js";

// 复用 integration.test.js 的 mock fetch 模式
function createMockFetch({ assistantDelay = 0 } = {}) {
  const sessions = new Map();
  return async (url, init = {}) => {
    const urlStr = String(url);
    if (init.method === "POST" && urlStr.endsWith("/api/session")) {
      const id = `ses_mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      sessions.set(id, { messages: [], assistantDelay });
      return {
        ok: true, status: 200,
        async json() { return { data: { id } }; },
        async text() { return JSON.stringify({ data: { id } }); },
      };
    }
    if (init.method === "POST" && urlStr.includes("/prompt_async")) {
      const sessionId = new URL(urlStr).pathname.split("/")[2];
      const body = JSON.parse(init.body);
      const session = sessions.get(sessionId);
      if (session) {
        session.messages.push({ info: { id: body.messageID, role: "user" }, parts: body.parts });
        if (session.assistantDelay > 0) {
          await new Promise((r) => setTimeout(r, session.assistantDelay));
        }
        session.messages.push({
          info: { id: "msg_reply", role: "assistant" },
          parts: [{ type: "text", text: "Mock response" }],
        });
      }
      return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    }
    if (init.method === "GET" && urlStr.includes("/message")) {
      const sessionId = new URL(urlStr).pathname.split("/")[2];
      const session = sessions.get(sessionId);
      return {
        ok: true, status: 200,
        async json() { return session?.messages ?? []; },
        async text() { return JSON.stringify(session?.messages ?? []); },
      };
    }
    if (init.method === "POST" && urlStr.includes("/abort")) {
      return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    }
    return { ok: false, status: 404, async text() { return "not found"; } };
  };
}

function createManager(dir, fetchImpl) {
  const config = {
    registry: "config/agents.json",
    runDir: dir,
    pollInterval: 10,
    waitTimeout: 1000,
    timeout: 5000,
    retries: 0,
  };
  const backendFor = (agent) => new OpenCodeServeBackend({ fetchImpl, timeout: 1000, retries: 0 });
  // readRegistry mock：返回一个固定 agent
  const readRegistry = async () => ({
    getAgent(id, overrides = {}) {
      return {
        id,
        backend: "opencode-serve",
        serveUrl: "http://127.0.0.1:4299",
        agent: "build",
        cwd: "D:/test",
        model: { providerID: "p", id: "m" },
        ...overrides,
      };
    },
    listAgents() { return []; },
  });
  return new RunManager({ config, readRegistry, transcriptDir: dir, backendFor });
}

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "wao-rm-"));
  return dir;
}

test("full lifecycle: pending → submitted → running → completed", async () => {
  const dir = await makeTempDir();
  try {
    const fetchImpl = createMockFetch();
    const manager = createManager(dir, fetchImpl);
    const run = await manager.start("test_agent", { prompt: "hello" });

    assert.equal(run.state, "submitted");
    const waitResult = await run.waitForCompletion({});
    assert.equal(waitResult.completed, true);
    assert.equal(run.state, "completed");

    // 验证 transcript 写入了完整的状态转移链
    const events = await readTranscript(run.transcript.filePath);
    const stateChanges = events.filter((e) => e.type === "run.state_change");
    const transitions = stateChanges.map((e) => `${e.from}→${e.to}`);
    assert.deepEqual(transitions, [
      "null→pending",
      "pending→submitted",
      "submitted→running",
      "running→completed",
    ]);
    // seq 单调递增
    const seqs = events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      assert.ok(seqs[i] > seqs[i - 1], `seq not monotonic at ${i}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- N4 修复：message 事件（含 assistant text）必须落 transcript ---
// 原 bug：waitForCompletion 把 message 事件只 push 进内存 messages 数组，不写 transcript。
// 后果：transcript（source of truth）重建不出 worker 的文字产出——tool 证据有，文字回答没有。
// 修复：message 事件也 append 到 transcript（run.event, kind=message），事后可重建。
test("N4: assistant message text 落 transcript（可事后重建产出）", async () => {
  const dir = await makeTempDir();
  try {
    const fetchImpl = createMockFetch();
    const manager = createManager(dir, fetchImpl);
    const run = await manager.start("test_agent", { prompt: "hello" });
    await run.waitForCompletion({});

    const events = await readTranscript(run.transcript.filePath);
    // 找落盘的 message 事件（assistant 文字产出）
    const messageEvents = events.filter(
      (e) => e.type === "run.event" && e.kind === "message",
    );
    assert.ok(messageEvents.length > 0, "transcript 应含 message 事件（assistant text 落盘）");
    // 该 message 应带 assistant role + parts（含文字）
    const assistantMsg = messageEvents.find((e) => e.role === "assistant");
    assert.ok(assistantMsg, "应有 assistant role 的 message 事件");
    assert.ok(Array.isArray(assistantMsg.parts), "message 应带 parts 数组");
    const text = assistantMsg.parts.map((p) => p.text).filter(Boolean).join("");
    assert.ok(text.length > 0, `assistant message 应含非空文字，实际: "${text}"`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGINT handler installed once process-wide regardless of manager count", async () => {
  const dirs = [];
  try {
    const before = process.listenerCount("SIGINT");
    const fetchImpl = createMockFetch();
    for (let i = 0; i < 5; i += 1) {
      const dir = await makeTempDir();
      dirs.push(dir);
      const manager = createManager(dir, fetchImpl);
      await manager.start("test_agent", { prompt: "hello" });
    }
    const after = process.listenerCount("SIGINT");
    // 每个 RunManager 实例不应各自注册一个全局 SIGINT listener；
    // 整个进程最多只应有一个共享 handler。
    assert.ok(after - before <= 1, `expected at most 1 SIGINT listener added, got ${after - before}`);
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});

test("gracefulShutdown aborts all active managers' runs on SIGINT", async () => {
  const dirs = [];
  try {
    const fetchImpl = createMockFetch();
    const managers = [];
    const runs = [];
    for (let i = 0; i < 2; i += 1) {
      const dir = await makeTempDir();
      dirs.push(dir);
      const manager = createManager(dir, fetchImpl);
      const run = await manager.start("test_agent", { prompt: "hello" });
      managers.push(manager);
      runs.push(run);
    }
    assert.equal(managers[0].activeRuns.size, 1);
    assert.equal(managers[1].activeRuns.size, 1);

    await gracefulShutdown("SIGINT");

    for (const manager of managers) assert.equal(manager.activeRuns.size, 0);
    for (const run of runs) assert.equal(run.state, "aborted");
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});

test("timed_out transition when no assistant message appears", async () => {
  const dir = await makeTempDir();
  try {
    // mock fetch 不返回 assistant 消息（只 push user 消息）
    const fetchImpl = async (url, init = {}) => {
      const urlStr = String(url);
      if (init.method === "POST" && urlStr.endsWith("/api/session")) {
        return {
          ok: true, status: 200,
          async json() { return { data: { id: "ses_timeout" } }; },
          async text() { return "{}"; },
        };
      }
      if (init.method === "POST" && urlStr.includes("/prompt_async")) {
        return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
      }
      if (init.method === "GET" && urlStr.includes("/message")) {
        return { ok: true, status: 200, async json() { return []; }, async text() { return "[]"; } };
      }
      return { ok: false, status: 404, async text() { return ""; } };
    };
    const manager = createManager(dir, fetchImpl);
    const run = await manager.start("test_agent", { prompt: "hello" });

    const waitResult = await run.waitForCompletion({ waitTimeout: 50, pollInterval: 10 });
    assert.equal(waitResult.completed, false);
    assert.equal(run.state, "timed_out");

    const events = await readTranscript(run.transcript.filePath);
    const stateChanges = events.filter((e) => e.type === "run.state_change");
    const last = stateChanges.at(-1);
    assert.equal(last.to, "timed_out");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed transition when backend throws during wait", async () => {
  const dir = await makeTempDir();
  try {
    // messages() 抛错 → waitForCompletion 失败
    const fetchImpl = async (url, init = {}) => {
      const urlStr = String(url);
      if (init.method === "POST" && urlStr.endsWith("/api/session")) {
        return {
          ok: true, status: 200,
          async json() { return { data: { id: "ses_fail" } }; },
          async text() { return "{}"; },
        };
      }
      if (init.method === "POST" && urlStr.includes("/prompt_async")) {
        return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
      }
      if (init.method === "GET" && urlStr.includes("/message")) {
        throw new Error("backend exploded");
      }
      return { ok: false, status: 404, async text() { return ""; } };
    };
    const manager = createManager(dir, fetchImpl);
    const run = await manager.start("test_agent", { prompt: "hello" });

    await assert.rejects(
      () => run.waitForCompletion({ waitTimeout: 100, pollInterval: 10 }),
      /backend exploded/,
    );
    assert.equal(run.state, "failed");

    const events = await readTranscript(run.transcript.filePath);
    const errorEvent = events.find((e) => e.type === "run.error");
    assert.ok(errorEvent);
    assert.equal(errorEvent.phase, "wait");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aborted transition via Run.abort()", async () => {
  const dir = await makeTempDir();
  try {
    const fetchImpl = createMockFetch({ assistantDelay: 500 }); // 延迟回 assistant
    const manager = createManager(dir, fetchImpl);
    const run = await manager.start("test_agent", { prompt: "hello" });

    // 在等待过程中 abort
    const waitPromise = run.waitForCompletion({ waitTimeout: 2000, pollInterval: 10 });
    // 给一点时间进入 submitted 状态
    await new Promise((r) => setTimeout(r, 5));
    await run.abort("user");

    const waitResult = await waitPromise;
    // abort 后 waitResult 可能已完成或被打断，但状态必须是 aborted
    assert.equal(run.state, "aborted");
    assert.equal(waitResult.aborted, true);
    assert.equal(waitResult.failed, false);

    const events = await readTranscript(run.transcript.filePath);
    const abortedEvent = events.find((e) => e.type === "run.aborted");
    assert.ok(abortedEvent);
    assert.equal(abortedEvent.reason, "user");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-55: external stop aborted terminal is not overwritten by wait failed path", async () => {
  const dir = await makeTempDir();
  try {
    const config = {
      registry: "config/agents.json",
      runDir: dir,
      pollInterval: 10,
      waitTimeout: 1000,
      timeout: 5000,
      retries: 0,
    };
    const readRegistry = async () => ({
      getAgent(id) {
        return { id, backend: "fake", cwd: dir };
      },
      listAgents() { return []; },
    });
    const backendFor = () => ({
      async spawn() {
        return {
          backend: "fake",
          backendSessionId: "ses_external_stop",
          abort: async () => {},
          events: async function* () {
            await new Promise((r) => setTimeout(r, 50));
            yield { kind: "done", reason: "failed", error: "late backend failure after stop" };
          },
        };
      },
    });
    const manager = new RunManager({ config, readRegistry, transcriptDir: dir, backendFor });
    const run = await manager.start("test_agent", { prompt: "hello", runId: "run_external_stop" });
    const waitPromise = run.waitForCompletion({ waitTimeout: 1000, pollInterval: 10 });

    const beforeStop = await readTranscript(run.transcript.filePath);
    const external = new JsonlTranscript(run.transcript.filePath, {
      runId: run.runId,
      agentId: run.agentId,
      initialSeq: findLastEventSeq(beforeStop),
    });
    await external.append("run.stop_requested", { backendSessionId: "ses_external_stop", reason: "user" });
    await external.append("run.aborted", { backendSessionId: "ses_external_stop", reason: "user" });
    await external.append("run.state_change", { from: "submitted", to: "aborted", reason: "stop_requested" });

    const waitResult = await waitPromise;
    assert.equal(waitResult.completed, false);
    assert.equal(run.state, "aborted");

    const events = await readTranscript(run.transcript.filePath);
    assert.equal(findState(events), "aborted");
    const abortedIndex = events.findIndex((e) => e.type === "run.state_change" && e.to === "aborted");
    const failedAfterAbort = events.findIndex((e, i) => i > abortedIndex && e.type === "run.state_change" && e.to === "failed");
    assert.equal(failedAfterAbort, -1, "wait path must not append failed after external aborted terminal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume returns null for terminal run", async () => {
  const dir = await makeTempDir();
  try {
    const fetchImpl = createMockFetch();
    const manager = createManager(dir, fetchImpl);
    const run = await manager.start("test_agent", { prompt: "hello" });
    await run.waitForCompletion({});

    const resumed = await manager.resume(run.runId);
    assert.equal(resumed, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume rebuilds Run handle for non-terminal run", async () => {
  const dir = await makeTempDir();
  try {
    const fetchImpl = createMockFetch();
    const manager = createManager(dir, fetchImpl);
    const run = await manager.start("test_agent", { prompt: "hello" });
    // 不调 waitForCompletion，run 处于 submitted

    const resumed = await manager.resume(run.runId);
    assert.ok(resumed, "resume should return a Run for non-terminal state");
    assert.equal(resumed.runId, run.runId);
    assert.equal(resumed.state, "submitted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RunManager.list() returns active runs", async () => {
  const dir = await makeTempDir();
  try {
    const fetchImpl = createMockFetch({ assistantDelay: 1000 });
    const manager = createManager(dir, fetchImpl);
    const run = await manager.start("test_agent", { prompt: "hello" });

    const list = manager.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].runId, run.runId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transcript state_change events have from/to/reason fields", async () => {
  const dir = await makeTempDir();
  try {
    const fetchImpl = createMockFetch();
    const manager = createManager(dir, fetchImpl);
    const run = await manager.start("test_agent", { prompt: "hello" });
    await run.waitForCompletion({});

    const events = await readTranscript(run.transcript.filePath);
    for (const e of events.filter((e) => e.type === "run.state_change")) {
      assert.ok(typeof e.from === "string" || e.from === null, "from must be present");
      assert.ok(typeof e.to === "string", "to must be present");
      assert.ok(typeof e.reason === "string", "reason must be present");
    }
    // findState 从 transcript 推算应等于 run 最终状态
    const state = findState(events);
    assert.equal(state, "completed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("onRemove is idempotent: abort + waitForCompletion error don't double-remove", async () => {
  // 覆盖审计发现的技术债：waitForCompletion 错误路径与 abort 同时触发时
  // _removeFromManager 只执行一次，不产生重复 activeRuns 操作
  const dir = await makeTempDir();
  try {
    const fetchImpl = async (url, init = {}) => {
      const urlStr = String(url);
      if (init.method === "POST" && urlStr.endsWith("/api/session")) {
        return {
          ok: true, status: 200,
          async json() { return { data: { id: "ses_idem" } }; },
          async text() { return "{}"; },
        };
      }
      if (init.method === "POST" && urlStr.includes("/prompt_async")) {
        return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
      }
      // messages 抛错 → 触发 waitForCompletion 错误路径
      if (init.method === "GET" && urlStr.includes("/message")) {
        throw new Error("concurrent failure");
      }
      if (init.method === "POST" && urlStr.includes("/abort")) {
        return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
      }
      return { ok: false, status: 404, async text() { return ""; } };
    };
    const manager = createManager(dir, fetchImpl);
    const run = await manager.start("test_agent", { prompt: "hello" });

    // manager.list() 应该含此 run
    assert.equal(manager.list().length, 1);
    // 触发错误路径 → _removeFromManager 执行
    await assert.rejects(() => run.waitForCompletion({ waitTimeout: 100, pollInterval: 10 }));
    // 再调 abort → _removeFromManager 幂等，不应抛错
    await run.abort("user");
    // activeRuns 应已清空
    assert.equal(manager.list().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("abort updates state to aborted even when backend.abort fails", async () => {
  // 覆盖审计发现的技术债：abort 失败时内存 state 必须仍更新到 aborted
  const dir = await makeTempDir();
  try {
    const fetchImpl = async (url, init = {}) => {
      const urlStr = String(url);
      if (init.method === "POST" && urlStr.endsWith("/api/session")) {
        return {
          ok: true, status: 200,
          async json() { return { data: { id: "ses_abortfail" } }; },
          async text() { return "{}"; },
        };
      }
      if (init.method === "POST" && urlStr.includes("/prompt_async")) {
        return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
      }
      if (init.method === "GET" && urlStr.includes("/message")) {
        return { ok: true, status: 200, async json() { return []; }, async text() { return "[]"; } };
      }
      // abort 端点抛错
      if (init.method === "POST" && urlStr.includes("/abort")) {
        throw new Error("backend abort exploded");
      }
      return { ok: false, status: 404, async text() { return ""; } };
    };
    const manager = createManager(dir, fetchImpl);
    const run = await manager.start("test_agent", { prompt: "hello" });
    await run.abort("user");

    // 内存 state 必须是 aborted（即使后端 abort 失败）
    assert.equal(run.state, "aborted");
    // transcript 里也要有 aborted 状态转移
    const events = await readTranscript(run.transcript.filePath);
    const state = findState(events);
    assert.equal(state, "aborted");
    // 且记录了 abort 失败的 error 标记
    const abortedEvent = events.find((e) => e.type === "run.aborted");
    assert.ok(abortedEvent.error, "should record abort failure error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M1 核心切分: 超时由 RunManager 触发，不依赖 backend emit done", async () => {
  // mock 持续返回空（永不完成），且永不 emit done。
  // 超时必须由 RunManager 的 AbortController 触发，而非 backend。
  const dir = await makeTempDir();
  try {
    const fetchImpl = async (url, init = {}) => {
      const urlStr = String(url);
      if (init.method === "POST" && urlStr.endsWith("/api/session")) {
        return {
          ok: true, status: 200,
          async json() { return { data: { id: "ses_never" } }; },
          async text() { return "{}"; },
        };
      }
      if (init.method === "POST" && urlStr.includes("/prompt_async")) {
        return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
      }
      // message 持续返回空——backend 永不 emit done
      if (init.method === "GET" && urlStr.includes("/message")) {
        return { ok: true, status: 200, async json() { return []; }, async text() { return "[]"; } };
      }
      return { ok: false, status: 404, async text() { return ""; } };
    };
    const manager = createManager(dir, fetchImpl);
    const run = await manager.start("test_agent", { prompt: "hello" });

    // waitTimeout 很短，RunManager 内部 AbortController 应触发
    const waitResult = await run.waitForCompletion({ waitTimeout: 50, pollInterval: 10 });
    assert.equal(waitResult.completed, false);
    assert.equal(waitResult.timedOut, true);
    assert.equal(run.state, "timed_out");

    // transcript 应有 timed_out 状态转移，且没有 backend 发的 done
    const events = await readTranscript(run.transcript.filePath);
    const stateChanges = events.filter((e) => e.type === "run.state_change");
    const last = stateChanges.at(-1);
    assert.equal(last.to, "timed_out");
    assert.equal(last.reason, "timeout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M1 核心切分: 完成由 backend emit done(completed)，RunManager 只消费", async () => {
  // backend 看到 assistant 消息后 emit done(completed)，RunManager 据此转 completed。
  // 验证状态转移 reason 是 done（来自 backend），而非 first_message 之类。
  const dir = await makeTempDir();
  try {
    const fetchImpl = createMockFetch();
    const manager = createManager(dir, fetchImpl);
    const run = await manager.start("test_agent", { prompt: "hello" });
    await run.waitForCompletion({});

    const events = await readTranscript(run.transcript.filePath);
    const stateChanges = events.filter((e) => e.type === "run.state_change");
    const transitions = stateChanges.map((e) => `${e.from}→${e.to}(${e.reason})`);
    assert.deepEqual(transitions, [
      "null→pending(created)",
      "pending→submitted(spawned)",
      "submitted→running(first_message)",
      "running→completed(done)",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backend emit done(failed) 时 RunManager 转 failed 并抛错", async () => {
  // backend 的 streamEvents 在轮询抛错时 emit done(failed)。
  // RunManager 应据此转 failed，并 rethrow 让调用方感知。
  const dir = await makeTempDir();
  try {
    const fetchImpl = async (url, init = {}) => {
      const urlStr = String(url);
      if (init.method === "POST" && urlStr.endsWith("/api/session")) {
        return {
          ok: true, status: 200,
          async json() { return { data: { id: "ses_fail_done" } }; },
          async text() { return "{}"; },
        };
      }
      if (init.method === "POST" && urlStr.includes("/prompt_async")) {
        return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
      }
      // message 抛错 → streamEvents emit done(failed)
      if (init.method === "GET" && urlStr.includes("/message")) {
        throw new Error("backend gone");
      }
      return { ok: false, status: 404, async text() { return ""; } };
    };
    const manager = createManager(dir, fetchImpl);
    const run = await manager.start("test_agent", { prompt: "hello" });

    await assert.rejects(
      () => run.waitForCompletion({ waitTimeout: 500, pollInterval: 10 }),
      /backend gone/,
    );
    assert.equal(run.state, "failed");

    const events = await readTranscript(run.transcript.filePath);
    const lastChange = events.filter((e) => e.type === "run.state_change").at(-1);
    assert.equal(lastChange.to, "failed");
    assert.equal(lastChange.reason, "backend_error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===== TD-95 #5: 状态悖论修复——evidence audit on failed backend =====
// 复盘 #5：coder_low 写了文件 + 跑了测试(exit0)，但 backend 进程退出码非零 → done(failed)。
// WAO 终态 failed（不撒谎——backend 确实崩了），但应在 transcript 写 run.evidence_audit
// 让 Lead 知道"证据其实通过了，任务可能做对了，需人工确认"。

test("TD-95 #5: backend done(failed) 但证据通过 → transcript 含 run.evidence_audit passed:true", async () => {
  const dir = await makeTempDir();
  try {
    const config = { registry: "config/agents.json", runDir: dir, pollInterval: 10, waitTimeout: 1000, timeout: 5000, retries: 0 };
    const mockBackend = {
      async spawn() {
        return {
          backend: "process",
          backendSessionId: "ses_evidence_audit",
          events: async function* () {
            yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "done" }] };
            yield { kind: "file_written", path: "src/foo.js" };
            yield { kind: "command", command: "node test.js", exitCode: 0 };
            yield { kind: "done", reason: "failed", error: "process exited with code 1" };
          },
          abort: async () => {},
          isAlive: () => false,
        };
      },
      sessionOutlivesProcess: false,
    };
    const readRegistry = async () => ({
      getAgent(id) { return { id, backend: "process", cwd: dir }; },
      listAgents() { return []; },
    });
    const manager = new RunManager({ config, readRegistry, transcriptDir: dir, backendFor: () => mockBackend });
    const run = await manager.start("test_agent", { prompt: "implement foo" });

    // waitForCompletion 仍 throw（终态 failed 是真的——backend 崩了）
    await assert.rejects(
      () => run.waitForCompletion({ waitTimeout: 500, pollInterval: 10 }),
      /process exited with code 1/,
    );
    assert.equal(run.state, "failed");

    // 但 transcript 应含 run.evidence_audit——让 Lead 知道证据通过了
    const events = await readTranscript(run.transcript.filePath);
    const audit = events.find((e) => e.type === "run.evidence_audit");
    assert.ok(audit, "failed run 有证据时应写 run.evidence_audit 事件");
    assert.equal(audit.passed, true, "evidence audit 应标 passed:true（证据其实通过了）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-95 #5: backend done(failed) 且无证据 → 不写 evidence_audit（真的失败了）", async () => {
  const dir = await makeTempDir();
  try {
    const config = { registry: "config/agents.json", runDir: dir, pollInterval: 10, waitTimeout: 1000, timeout: 5000, retries: 0 };
    const mockBackend = {
      async spawn() {
        return {
          backend: "process",
          backendSessionId: "ses_no_evidence",
          events: async function* () {
            yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "reading..." }] };
            yield { kind: "done", reason: "failed", error: "crash" };
          },
          abort: async () => {},
          isAlive: () => false,
        };
      },
      sessionOutlivesProcess: false,
    };
    const readRegistry = async () => ({
      getAgent(id) { return { id, backend: "process", cwd: dir }; },
      listAgents() { return []; },
    });
    const manager = new RunManager({ config, readRegistry, transcriptDir: dir, backendFor: () => mockBackend });
    const run = await manager.start("test_agent", { prompt: "implement foo" });

    await assert.rejects(
      () => run.waitForCompletion({ waitTimeout: 500, pollInterval: 10 }),
      /crash/,
    );
    const events = await readTranscript(run.transcript.filePath);
    const audit = events.find((e) => e.type === "run.evidence_audit");
    assert.ok(!audit, "无证据的 failed run 不应写 evidence_audit（避免误导 Lead）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===== M3-5: 进程式 resume 测试 =====

/** mock 进程式 backend：spawn 计数 + 返回含 events/abort 的 handle */
function createMockProcessBackend() {
  let spawnCount = 0;
  return {
    spawnCount: () => spawnCount,
    backend: {
      async spawn(agent, task) {
        spawnCount += 1;
        const sessionId = `proc_mock_${spawnCount}`;
        return {
          backend: "process",
          backendSessionId: sessionId,
          events: async function* () {
            yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "replayed" }] };
            yield { kind: "done", reason: "completed" };
          },
          abort: async () => {},
          isAlive: () => false,
        };
      },
    },
  };
}

test("M3-5: 进程式 resume 重放 prompt，产生新 session + run.rerun 事件", async () => {
  const dir = await makeTempDir();
  try {
    const mock = createMockProcessBackend();
    const config = {
      registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 2000,
      timeout: 5000, retries: 0, defaultIsolation: "none",
    };
    const readRegistry = async () => ({
      getAgent(id, overrides = {}) {
        const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
        return { id, backend: "claude-code", cwd: dir, ...defined };
      },
      listAgents() { return []; },
    });
    const manager = new RunManager({
      config, readRegistry, backendFor: () => mock.backend,
    });

    // start 一个进程式 run，但不 waitForCompletion（模拟中断，停在 submitted）
    const run1 = await manager.start("proc_agent", { prompt: "original prompt", runId: "proc_run_1" });
    assert.equal(run1.state, "submitted");

    // resume：应重放 prompt（spawn 被再调一次）
    const resumed = await manager.resume("proc_run_1");
    assert.ok(resumed, "resume should return a Run for process backend");
    await resumed.waitForCompletion({});

    // spawn 被调了 2 次（start + resume 重放）
    assert.equal(mock.spawnCount(), 2, "resume should re-spawn for process backend");

    // transcript 有 run.rerun 事件
    const events = await readTranscript(run1.transcript.filePath);
    const rerunEvent = events.find((e) => e.type === "run.rerun");
    assert.ok(rerunEvent, "should have run.rerun event");
    assert.equal(rerunEvent.reason, "replay");
    assert.notEqual(rerunEvent.newSessionId, rerunEvent.originalSessionId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M3-5: 进程式 resume 终态 run 返回 null（不重放已完成的）", async () => {
  const dir = await makeTempDir();
  try {
    const mock = createMockProcessBackend();
    const config = {
      registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 2000,
      timeout: 5000, retries: 0, defaultIsolation: "none",
    };
    const readRegistry = async () => ({
      getAgent(id, overrides = {}) {
        const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
        return { id, backend: "codex", cwd: dir, ...defined };
      },
      listAgents() { return []; },
    });
    const manager = new RunManager({
      config, readRegistry, backendFor: () => mock.backend,
    });
    const run = await manager.start("proc_agent", { prompt: "done already", runId: "proc_run_2" });
    await run.waitForCompletion({});
    // 已 completed → resume 返回 null
    const resumed = await manager.resume("proc_run_2");
    assert.equal(resumed, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===== M4-3: metrics 消费测试 =====

test("M4-3: metrics 事件被消费并写入 transcript", async () => {
  const dir = await makeTempDir();
  try {
    // mock 进程式 backend：events 流 emit metrics + done
    const mockBackend = {
      async spawn() {
        return {
          backend: "process",
          backendSessionId: "proc_m4",
          events: async function* () {
            yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "hi" }] };
            yield { kind: "metrics", tokens: { input: 100, output: 50 }, costUsd: 0.01 };
            yield { kind: "done", reason: "completed" };
          },
          abort: async () => {},
          isAlive: () => false,
        };
      },
    };
    const config = {
      registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 2000,
      timeout: 5000, retries: 0, defaultIsolation: "none",
    };
    const readRegistry = async () => ({
      getAgent(id, overrides = {}) {
        const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
        return { id, backend: "claude-code", cwd: dir, ...defined };
      },
      listAgents() { return []; },
    });
    const manager = new RunManager({ config, readRegistry, backendFor: () => mockBackend });
    const run = await manager.start("test", { prompt: "hi", runId: "m4_metrics_test" });
    const result = await run.waitForCompletion({});

    assert.equal(result.completed, true);
    assert.ok(result.metrics, "waitResult should have metrics");
    assert.equal(result.metrics.tokens.input, 100);
    assert.equal(result.metrics.tokens.output, 50);
    assert.equal(result.metrics.costUsd, 0.01);

    // transcript 应有 run.metrics 事件
    const events = await readTranscript(run.transcript.filePath);
    const metricsEvent = events.find((e) => e.type === "run.metrics");
    assert.ok(metricsEvent, "transcript should have run.metrics event");
    assert.equal(metricsEvent.tokens.input, 100);
    assert.equal(metricsEvent.costUsd, 0.01);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M4-3: 无 metrics 事件时 waitResult.metrics 为 null（不崩溃）", async () => {
  const dir = await makeTempDir();
  try {
    const mockBackend = {
      async spawn() {
        return {
          backend: "process",
          backendSessionId: "proc_nom",
          events: async function* () {
            yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "hi" }] };
            yield { kind: "done", reason: "completed" };
          },
          abort: async () => {},
          isAlive: () => false,
        };
      },
    };
    const config = {
      registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 2000,
      timeout: 5000, retries: 0, defaultIsolation: "none",
    };
    const readRegistry = async () => ({
      getAgent(id, overrides = {}) {
        const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
        return { id, backend: "claude-code", cwd: dir, ...defined };
      },
      listAgents() { return []; },
    });
    const manager = new RunManager({ config, readRegistry, backendFor: () => mockBackend });
    const run = await manager.start("test", { prompt: "hi", runId: "m4_no_metrics" });
    const result = await run.waitForCompletion({});
    assert.equal(result.metrics, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===== M6-2: 证据事件落盘 =====

/** mock backend，注入含证据事件的流 */
function createMockEvidenceBackend(events) {
  return {
    async spawn(agent, task) {
      return {
        backend: "process",
        backendSessionId: "proc_evidence",
        events: async function* () {
          for (const ev of events) yield ev;
        },
        abort: async () => {},
        isAlive: () => false,
      };
    },
  };
}

function makeProcessManager(dir, mockBackend) {
  const config = {
    registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 5000,
    timeout: 5000, retries: 0, defaultIsolation: "none",
  };
  const readRegistry = async () => ({
    getAgent(id, overrides = {}) {
      const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
      return { id, backend: "claude-code", cwd: dir, ...defined };
    },
    listAgents() { return []; },
  });
  return new RunManager({ config, readRegistry, backendFor: () => mockBackend });
}

test("M6-2: 证据事件写入 transcript run.event，含原始 kind", async () => {
  const dir = await makeTempDir();
  try {
    const events = [
      { kind: "message", role: "assistant", parts: [{ type: "text", text: "working" }] },
      { kind: "command", command: "npm test", exitCode: 0 },
      { kind: "file_written", path: "src/result.js" },
      { kind: "done", reason: "completed" },
    ];
    const manager = makeProcessManager(dir, createMockEvidenceBackend(events));
    const run = await manager.start("test", { prompt: "do it" });
    await run.waitForCompletion({});

    const transcript = await readTranscript(run.transcript.filePath);
    const runEvents = transcript.filter((e) => e.type === "run.event");
    // N4 后 message 也落 run.event（kind=message），故 3 个：message + command + file_written
    assert.equal(runEvents.length, 3, "should have 3 run.event (message + command + file_written)");
    assert.equal(runEvents[0].kind, "message");
    assert.equal(runEvents[0].role, "assistant");
    assert.equal(runEvents[1].kind, "command");
    assert.equal(runEvents[1].command, "npm test");
    assert.equal(runEvents[1].exitCode, 0);
    assert.equal(runEvents[2].kind, "file_written");
    assert.equal(runEvents[2].path, "src/result.js");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M6-2: 证据事件不触发状态转移（state 仍由 message/done 驱动）", async () => {
  const dir = await makeTempDir();
  try {
    const events = [
      { kind: "message", role: "assistant", parts: [{ type: "text", text: "go" }] },
      { kind: "command", command: "echo hi", exitCode: 0 },
      { kind: "tool_use", tool: "Grep", input: { pattern: "x" } },
      { kind: "tool_result", tool: "Grep", output: "no match", isError: false },
      { kind: "done", reason: "completed" },
    ];
    const manager = makeProcessManager(dir, createMockEvidenceBackend(events));
    const run = await manager.start("test", { prompt: "go" });
    await run.waitForCompletion({});

    const transcript = await readTranscript(run.transcript.filePath);
    const stateChanges = transcript.filter((e) => e.type === "run.state_change");
    const transitions = stateChanges.map((e) => `${e.from}→${e.to}(${e.reason})`);
    // 证据事件不应出现在状态转移链里
    assert.deepEqual(transitions, [
      "null→pending(created)",
      "pending→submitted(spawned)",
      "submitted→running(first_message)",
      "running→completed(done)",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-56: first active tool/command/metrics event marks run as running", async () => {
  const cases = [
    { name: "tool_use", event: { kind: "tool_use", tool: "Read", input: { path: "package.json" } } },
    { name: "command", event: { kind: "command", command: "npm test", exitCode: 0 } },
    { name: "metrics", event: { kind: "metrics", tokens: { input: 1, output: 0 }, costUsd: 0.001 } },
  ];

  for (const { name, event } of cases) {
    const dir = await makeTempDir();
    try {
      const manager = makeProcessManager(dir, createMockEvidenceBackend([
        event,
        { kind: "done", reason: "completed" },
      ]));
      const run = await manager.start("test", { prompt: "go", runId: `first_${name}` });
      await run.waitForCompletion({});

      const transcript = await readTranscript(run.transcript.filePath);
      const transitions = transcript
        .filter((e) => e.type === "run.state_change")
        .map((e) => `${e.from}→${e.to}(${e.reason})`);
      assert.deepEqual(transitions, [
        "null→pending(created)",
        "pending→submitted(spawned)",
        "submitted→running(first_event)",
        "running→completed(done)",
      ], `${name} should mark running before completion`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("M6-2: waitForCompletion 返回值含 evidence 数组，顺序与到达一致", async () => {
  const dir = await makeTempDir();
  try {
    const events = [
      { kind: "message", role: "assistant", parts: [{ type: "text", text: "go" }] },
      { kind: "command", command: "npm test", exitCode: 0 },
      { kind: "file_written", path: "a.js" },
      { kind: "file_written", path: "b.js" },
      { kind: "command", command: "echo done", exitCode: 0 },
      { kind: "done", reason: "completed" },
    ];
    const manager = makeProcessManager(dir, createMockEvidenceBackend(events));
    const run = await manager.start("test", { prompt: "go" });
    const result = await run.waitForCompletion({});

    assert.ok(Array.isArray(result.evidence), "evidence should be an array");
    assert.equal(result.evidence.length, 4, "4 evidence events");
    assert.equal(result.evidence[0].kind, "command");
    assert.equal(result.evidence[0].command, "npm test");
    assert.equal(result.evidence[1].kind, "file_written");
    assert.equal(result.evidence[1].path, "a.js");
    assert.equal(result.evidence[3].kind, "command");
    assert.equal(result.evidence[3].command, "echo done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M6-2: 无证据事件的 run，evidence 为空数组（向后兼容）", async () => {
  const dir = await makeTempDir();
  try {
    const events = [
      { kind: "message", role: "assistant", parts: [{ type: "text", text: "hi" }] },
      { kind: "done", reason: "completed" },
    ];
    const manager = makeProcessManager(dir, createMockEvidenceBackend(events));
    const run = await manager.start("test", { prompt: "hi" });
    const result = await run.waitForCompletion({});

    assert.deepEqual(result.evidence, []);
    assert.equal(result.completed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===== M6-6: scorecard 接入状态机（opt-in 硬门控）=====

test("M6-6: 无 scorecard 配置 → done(completed) 直接 completed（旧行为不变）", async () => {
  const dir = await makeTempDir();
  try {
    const events = [
      { kind: "message", role: "assistant", parts: [{ type: "text", text: "hi" }] },
      { kind: "done", reason: "completed" },
    ];
    const manager = makeProcessManager(dir, createMockEvidenceBackend(events));
    const run = await manager.start("test", { prompt: "hi" });
    const result = await run.waitForCompletion({});

    assert.equal(result.completed, true);
    assert.equal(run.state, "completed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M6-6: scorecard rules 在 options 传入，证据满足 → completed", async () => {
  const dir = await makeTempDir();
  try {
    const events = [
      { kind: "message", role: "assistant", parts: [{ type: "text", text: "go" }] },
      { kind: "command", command: "echo hi", exitCode: 0 },
      { kind: "done", reason: "completed" },
    ];
    const manager = makeProcessManager(dir, createMockEvidenceBackend(events));
    const run = await manager.start("test", {
      prompt: "go",
      scorecard: { rules: { requireCommands: ["echo hi"] } },
    });
    const result = await run.waitForCompletion({});

    assert.equal(result.completed, true);
    assert.equal(run.state, "completed");

    const transcript = await readTranscript(run.transcript.filePath);
    const scEvent = transcript.find((e) => e.type === "scorecard.checked");
    assert.ok(scEvent, "should have scorecard.checked event");
    assert.equal(scEvent.passed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M6-6: scorecard requireCommands 不满足 → failed + scorecard.checked passed:false", async () => {
  const dir = await makeTempDir();
  try {
    const events = [
      { kind: "message", role: "assistant", parts: [{ type: "text", text: "go" }] },
      { kind: "command", command: "echo hi", exitCode: 0 },
      { kind: "done", reason: "completed" },
    ];
    const manager = makeProcessManager(dir, createMockEvidenceBackend(events));
    const run = await manager.start("test", {
      prompt: "go",
      scorecard: { rules: { requireCommands: ["npm test"] } },
    });
    const result = await run.waitForCompletion({});

    assert.equal(result.completed, false);
    assert.equal(result.failed, true);
    assert.equal(run.state, "failed");

    const transcript = await readTranscript(run.transcript.filePath);
    const scEvent = transcript.find((e) => e.type === "scorecard.checked");
    assert.ok(scEvent);
    assert.equal(scEvent.passed, false);

    const lastChange = transcript.filter((e) => e.type === "run.state_change").at(-1);
    assert.equal(lastChange.to, "failed");
    assert.equal(lastChange.reason, "scorecard_failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M6-6: scorecard requireFiles 文件不存在 → failed", async () => {
  const dir = await makeTempDir();
  try {
    const events = [
      { kind: "message", role: "assistant", parts: [{ type: "text", text: "go" }] },
      { kind: "file_written", path: "result.js" },
      { kind: "done", reason: "completed" },
    ];
    const manager = makeProcessManager(dir, createMockEvidenceBackend(events));
    const run = await manager.start("test", {
      prompt: "go",
      scorecard: { rules: { requireFiles: ["result.js"] } },
    });
    const result = await run.waitForCompletion({});

    assert.equal(result.completed, false);
    assert.equal(run.state, "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M6-6: scorecard 失败时返回值含 scorecard 结果", async () => {
  const dir = await makeTempDir();
  try {
    const events = [
      { kind: "message", role: "assistant", parts: [{ type: "text", text: "go" }] },
      { kind: "done", reason: "completed" },
    ];
    const manager = makeProcessManager(dir, createMockEvidenceBackend(events));
    const run = await manager.start("test", {
      prompt: "go",
      scorecard: { rules: { requireEvidence: true } },
    });
    const result = await run.waitForCompletion({});

    assert.equal(result.completed, false);
    assert.ok(result.scorecard, "should return scorecard result");
    assert.equal(result.scorecard.passed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M6-6: agent.scorecard 定义（options 不传时用 agent 配置）", async () => {
  const dir = await makeTempDir();
  try {
    const events = [
      { kind: "message", role: "assistant", parts: [{ type: "text", text: "go" }] },
      { kind: "command", command: "npm test", exitCode: 0 },
      { kind: "done", reason: "completed" },
    ];
    // 自定义 readRegistry 让 agent 带 scorecard
    const config = {
      registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 5000,
      timeout: 5000, retries: 0, defaultIsolation: "none",
    };
    const readRegistry = async () => ({
      getAgent(id, overrides = {}) {
        const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
        return {
          id, backend: "claude-code", cwd: dir,
          scorecard: { rules: { requireCommands: ["npm test"] } },
          ...defined,
        };
      },
      listAgents() { return []; },
    });
    const manager = new RunManager({
      config, readRegistry, backendFor: () => createMockEvidenceBackend(events),
    });
    const run = await manager.start("test", { prompt: "go" });
    const result = await run.waitForCompletion({});

    assert.equal(result.completed, true);
    const transcript = await readTranscript(run.transcript.filePath);
    const scEvent = transcript.find((e) => e.type === "scorecard.checked");
    assert.ok(scEvent);
    assert.equal(scEvent.passed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===== P4 融合项 #4（决策C warn-only）：scorecard mode:"warn" 不阻断 completed =====
// 决策C：默认 requireEvidence 可 warn-only——记门结果（scorecard.checked passed:false +
// scorecard.warn 事件）但不转 failed，run 仍 completed。渐进引导而非硬拦。
// 规则里带 mode:"warn" 即 warn-only；不带（默认 gate）仍是 M6-6 硬门。

test("P4-T4 决策C: scorecard rules 带 mode:warn + 证据不满足 → 仍 completed（不阻断）", async () => {
  const dir = await makeTempDir();
  try {
    const events = [
      { kind: "message", role: "assistant", parts: [{ type: "text", text: "go" }] },
      { kind: "command", command: "echo hi", exitCode: 0 },
      { kind: "done", reason: "completed" },
    ];
    const manager = makeProcessManager(dir, createMockEvidenceBackend(events));
    const run = await manager.start("test", {
      prompt: "go",
      // requireCommands 没满足（跑了 echo hi 不是 npm test），但 mode:warn → 不阻断
      scorecard: { rules: { requireCommands: ["npm test"], mode: "warn" } },
    });
    const result = await run.waitForCompletion({});

    assert.equal(result.completed, true, "warn-only：证据不满足仍 completed（不阻断）");
    assert.equal(run.state, "completed");

    const transcript = await readTranscript(run.transcript.filePath);
    const scEvent = transcript.find((e) => e.type === "scorecard.checked");
    assert.ok(scEvent, "仍记 scorecard.checked");
    assert.equal(scEvent.passed, false, "门结果如实记录 passed:false");

    const warnEvent = transcript.find((e) => e.type === "scorecard.warn");
    assert.ok(warnEvent, "warn-only 失败应记 scorecard.warn 事件");

    // 最终态是 completed 不是 failed
    const lastChange = transcript.filter((e) => e.type === "run.state_change").at(-1);
    assert.equal(lastChange.to, "completed", "warn-only 不转 failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P4-T4 决策C: mode:warn 但证据满足 → completed（与 gate 行为一致，无 warn 事件）", async () => {
  const dir = await makeTempDir();
  try {
    const events = [
      { kind: "message", role: "assistant", parts: [{ type: "text", text: "go" }] },
      { kind: "command", command: "npm test", exitCode: 0 },
      { kind: "done", reason: "completed" },
    ];
    const manager = makeProcessManager(dir, createMockEvidenceBackend(events));
    const run = await manager.start("test", {
      prompt: "go",
      scorecard: { rules: { requireCommands: ["npm test"], mode: "warn" } },
    });
    const result = await run.waitForCompletion({});

    assert.equal(result.completed, true);
    const transcript = await readTranscript(run.transcript.filePath);
    assert.equal(transcript.find((e) => e.type === "scorecard.warn"), undefined, "证据满足不应记 warn");
    assert.equal(transcript.find((e) => e.type === "scorecard.checked").passed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P4-T4 决策C: 不带 mode（默认 gate）证据不满足 → 仍 failed（向后兼容不变）", async () => {
  const dir = await makeTempDir();
  try {
    const events = [
      { kind: "message", role: "assistant", parts: [{ type: "text", text: "go" }] },
      { kind: "command", command: "echo hi", exitCode: 0 },
      { kind: "done", reason: "completed" },
    ];
    const manager = makeProcessManager(dir, createMockEvidenceBackend(events));
    const run = await manager.start("test", {
      prompt: "go",
      // 不带 mode → 默认 gate（M6-6 旧行为）
      scorecard: { rules: { requireCommands: ["npm test"] } },
    });
    const result = await run.waitForCompletion({});

    assert.equal(result.completed, false, "默认 gate：证据不满足 → failed（向后兼容）");
    assert.equal(run.state, "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// M8-1：默认 scorecard（warn 模式 + 升级开关）
//
// 设计：run/spawn 不传任何 scorecard 参数时，默认带 { requireEvidence:true, mode:"warn" }。
// 这是把"防伪完成"从 opt-in 升级为默认行为——但用 warn（不阻塞完成，只记留痕）做渐进引导，
// 不用 hard（回归风险高）。Lead 用 --scorecard-mode 在三个状态间切：
//   warn（默认）| hard（升级硬闸，无证据→failed）| off（完全关闭，恢复旧 opt-in 行为）
//
// 契约：start() 新增 scorecardMode 选项；resolveScorecardRules 接收 scorecardMode。
// 优先级：显式 scorecard > scorecardMode（warn/hard/off）。
// ---------------------------------------------------------------------------

test("M8-1: 无任何 scorecard 参数 → 默认 requireEvidence:warn（不阻塞完成，记 warn 事件）", async () => {
  const dir = await makeTempDir();
  try {
    // 无证据：只有 assistant 文本，无 command/file evidence
    const events = [
      { kind: "message", role: "assistant", parts: [{ type: "text", text: "done" }] },
      { kind: "done", reason: "completed" },
    ];
    const manager = makeProcessManager(dir, createMockEvidenceBackend(events));
    const run = await manager.start("test", { prompt: "go" }); // 不传 scorecard 任何参数
    const result = await run.waitForCompletion({});

    assert.equal(result.completed, true, "默认 warn：无证据仍 completed（不阻塞）");
    assert.equal(run.state, "completed");

    const transcript = await readTranscript(run.transcript.filePath);
    const scEvent = transcript.find((e) => e.type === "scorecard.checked");
    assert.ok(scEvent, "默认开启：应记 scorecard.checked（即使无显式 rules）");
    assert.equal(scEvent.passed, false, "无证据 → 门结果 passed:false 如实记录");

    const warnEvent = transcript.find((e) => e.type === "scorecard.warn");
    assert.ok(warnEvent, "默认 warn：无证据应记 scorecard.warn 留痕");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M8-1: scorecardMode:hard 升级 → 无证据 → failed（硬闸升级）", async () => {
  const dir = await makeTempDir();
  try {
    const events = [
      { kind: "message", role: "assistant", parts: [{ type: "text", text: "done" }] },
      { kind: "done", reason: "completed" },
    ];
    const manager = makeProcessManager(dir, createMockEvidenceBackend(events));
    const run = await manager.start("test", { prompt: "go", scorecardMode: "hard" });
    const result = await run.waitForCompletion({});

    assert.equal(result.completed, false, "hard 模式：无证据 → failed");
    assert.equal(run.state, "failed");
    const transcript = await readTranscript(run.transcript.filePath);
    const lastChange = transcript.filter((e) => e.type === "run.state_change").at(-1);
    assert.equal(lastChange.reason, "scorecard_failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M8-1: scorecardMode:off → 完全关闭默认（无 scorecard.checked，恢复旧 opt-in 行为）", async () => {
  const dir = await makeTempDir();
  try {
    const events = [
      { kind: "message", role: "assistant", parts: [{ type: "text", text: "done" }] },
      { kind: "done", reason: "completed" },
    ];
    const manager = makeProcessManager(dir, createMockEvidenceBackend(events));
    const run = await manager.start("test", { prompt: "go", scorecardMode: "off" });
    const result = await run.waitForCompletion({});

    assert.equal(result.completed, true, "off：完全关闭，旧行为不变");
    const transcript = await readTranscript(run.transcript.filePath);
    assert.equal(
      transcript.find((e) => e.type === "scorecard.checked"),
      undefined,
      "off 模式：不应记 scorecard.checked（完全关闭）",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M8-1: 显式 scorecard 优先于 scorecardMode（显式 rules 不受默认影响）", async () => {
  const dir = await makeTempDir();
  try {
    const events = [
      { kind: "message", role: "assistant", parts: [{ type: "text", text: "go" }] },
      { kind: "command", command: "npm test", exitCode: 0 },
      { kind: "done", reason: "completed" },
    ];
    const manager = makeProcessManager(dir, createMockEvidenceBackend(events));
    const run = await manager.start("test", {
      prompt: "go",
      // 显式传 rules，即使全局 scorecardMode 是 hard 也不应被默认覆盖
      scorecard: { rules: { requireCommands: ["npm test"] } },
      scorecardMode: "hard",
    });
    const result = await run.waitForCompletion({});

    assert.equal(result.completed, true, "显式 rules 满足 → completed");
    const transcript = await readTranscript(run.transcript.filePath);
    const scEvent = transcript.find((e) => e.type === "scorecard.checked");
    assert.ok(scEvent);
    assert.equal(scEvent.passed, true, "显式 rules 满足证据");
    // 关键：不应记 warn（显式 rules + 证据满足，hard 模式也放行）
    assert.equal(transcript.find((e) => e.type === "scorecard.warn"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M8-1: 默认 warn + 证据满足 → completed（无 warn 事件，与正常 hard 一致）", async () => {
  const dir = await makeTempDir();
  try {
    const events = [
      { kind: "message", role: "assistant", parts: [{ type: "text", text: "go" }] },
      { kind: "command", command: "npm test", exitCode: 0 },
      { kind: "done", reason: "completed" },
    ];
    const manager = makeProcessManager(dir, createMockEvidenceBackend(events));
    // 不传任何 scorecard 参数 → 默认 warn，但证据满足 → 不应记 warn
    const run = await manager.start("test", { prompt: "go" });
    const result = await run.waitForCompletion({});

    assert.equal(result.completed, true);
    const transcript = await readTranscript(run.transcript.filePath);
    assert.equal(transcript.find((e) => e.type === "scorecard.warn"), undefined, "证据满足不应记 warn");
    assert.equal(transcript.find((e) => e.type === "scorecard.checked").passed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 会话兜底 abort（事故修复，2026-06-17）
//
// 背景：opencode-serve 的 HTTP session 在 run 结束后可能继续生成。
// 对会自然停止的模型（GLM）无害，但对无限多轮模型（DeepSeek-v4-flash）是
// quota 黑洞——run 已 completed/timed_out/failed，serve 端 session 还在无限生成。
//
// 真实事故：一次 researcher(deepseek) run 超时后，RunManager 只写了 run.timed_out，
// 没有发送 serve session abort，DeepSeek 在后台烧光了用户当日 quota。
//
// 契约：RunManager 在任何终态（completed/failed/timed_out）的清理路径里，
// 必须调一次 handle.abort() 兜底发送 serve 端 abort（HTTP 类 backend）。
// 进程式 backend 进程死了就是死了，abort 是 no-op（幂等，不报错）。
// ---------------------------------------------------------------------------

/**
 * 构造一个 mock backend，handle.abort 计数 + events 按 scenario 产出。
 * scenario: "completed" | "failed" | "hang"（hang = 永不 emit done，逼超时）
 */
function createSessionKillBackend(scenario) {
  let abortCalls = 0;
  const backend = {
    async spawn(agent, task) {
      return {
        backend: "opencode-serve",
        backendSessionId: "ses_kill_test",
        messageId: "msg_kill",
        admittedSeq: null,
        // events 工厂：waitForCompletion 传 (signal, opts)
        events: async function* (signal, opts) {
          const interval = opts?.pollInterval ?? 10;
          // 先 emit 一个 message 让状态进 running
          yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "x" }] };
          if (scenario === "completed") {
            yield { kind: "done", reason: "completed" };
          } else if (scenario === "failed") {
            yield { kind: "done", reason: "failed", error: "boom" };
          } else if (scenario === "hang") {
            // 永不 emit done，直到 signal 被 abort（超时打断）
            while (!signal?.aborted) {
              await new Promise((r) => setTimeout(r, interval));
            }
          }
        },
        abort: async () => { abortCalls += 1; },
      };
    },
    // resume 路径用不到，占位
    async streamEvents() { throw new Error("not used"); },
    async abort() { abortCalls += 1; },
  };
  return { backend, abortCalls: () => abortCalls };
}

test("事故修复: run completed 后必须兜底 abort serve session（防 deepseek 黑洞）", async () => {
  const dir = await makeTempDir();
  try {
    const mock = createSessionKillBackend("completed");
    const config = {
      registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 2000,
      timeout: 5000, retries: 0, defaultIsolation: "none",
    };
    const readRegistry = async () => ({
      getAgent(id) { return { id, backend: "opencode-serve", serveUrl: "http://x", cwd: dir }; },
      listAgents() { return []; },
    });
    const manager = new RunManager({ config, readRegistry, backendFor: () => mock.backend });
    const run = await manager.start("a", { prompt: "go" });
    const result = await run.waitForCompletion({ pollInterval: 5 });
    assert.equal(result.completed, true);
    assert.equal(run.state, "completed");
    assert.equal(mock.abortCalls(), 1,
      "completed 后 handle.abort 必须被调一次（兜底发送 serve abort）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("事故修复: run failed 后必须兜底 abort serve session", async () => {
  const dir = await makeTempDir();
  try {
    const mock = createSessionKillBackend("failed");
    const config = {
      registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 2000,
      timeout: 5000, retries: 0, defaultIsolation: "none",
    };
    const readRegistry = async () => ({
      getAgent(id) { return { id, backend: "opencode-serve", serveUrl: "http://x", cwd: dir }; },
      listAgents() { return []; },
    });
    const manager = new RunManager({ config, readRegistry, backendFor: () => mock.backend });
    const run = await manager.start("a", { prompt: "go" });
    await assert.rejects(() => run.waitForCompletion({ pollInterval: 5 }), /boom/);
    assert.equal(run.state, "failed");
    assert.equal(mock.abortCalls(), 1,
      "failed 后 handle.abort 必须被调一次（兜底发送 serve abort）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("事故修复: run timed_out 后必须兜底 abort serve session（事故主因）", async () => {
  const dir = await makeTempDir();
  try {
    const mock = createSessionKillBackend("hang");
    const config = {
      registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 80,
      timeout: 5000, retries: 0, defaultIsolation: "none",
    };
    const readRegistry = async () => ({
      getAgent(id) { return { id, backend: "opencode-serve", serveUrl: "http://x", cwd: dir }; },
      listAgents() { return []; },
    });
    const manager = new RunManager({ config, readRegistry, backendFor: () => mock.backend });
    const run = await manager.start("a", { prompt: "go" });
    const result = await run.waitForCompletion({ pollInterval: 5, waitTimeout: 80 });
    assert.equal(result.timedOut, true);
    assert.equal(run.state, "timed_out");
    assert.equal(mock.abortCalls(), 1,
      "timed_out 后 handle.abort 必须被调一次（这正是事故主因：超时后未发送 serve abort）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// token 预算硬闸门（S1-1，事故修复 2026-06-18）
//
// 背景：06-18 事故证明，即使 abort 被调（TD-35），opencode serve 端 session
// 仍可能继续烧 token（TD-37）。唯一不依赖 abort 是否生效的防线是：本地累计
// token 超阈值即强制终止 run，不再依赖后端"真的停了"。
//
// 契约：waitForCompletion 收到 metrics 事件时累计 effectiveTokens =
//   (input + output + reasoning) × multiplier。超 agent.tokenBudget 即转 failed
//   （reason=budget_exceeded），写 run.budget_exceeded，走 _runCleanup 兜底 abort。
//   未配 tokenBudget 的 agent 不启用闸门（向后兼容）。
//
// 计量口径：opencode session.tokens 比 provider 账单偏小 1-2 数量级（cache read/
// context 重发不计），故用 multiplier（默认 100）逼近 provider 计费。
// ---------------------------------------------------------------------------

/**
 * 构造一个 mock backend，产出可控的 metrics 事件流。
 * mode: "growing" = metrics token 逐次翻倍（模拟失控）；"stable" = 固定值；"normal-completed" = 正常完成
 */
function createBudgetBackend(mode, { stepTokens = 2000, multiplier = 100 } = {}) {
  let abortCalls = 0;
  let metricsCalls = 0;
  const backend = {
    async spawn(agent, task) {
      return {
        backend: "opencode-serve",
        backendSessionId: "ses_budget_test",
        messageId: "msg_budget",
        admittedSeq: null,
        events: async function* (signal, opts) {
          const interval = opts?.pollInterval ?? 10;
          // 先 emit message 进 running
          yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "working" }] };
          if (mode === "normal-completed") {
            yield { kind: "metrics", tokens: { input: 1000, output: 10, reasoning: 0 }, costUsd: 0.001 };
            yield { kind: "done", reason: "completed" };
            return;
          }
          // growing / stable：循环 emit metrics，直到被 abort 打断
          while (!signal?.aborted) {
            metricsCalls += 1;
            if (mode === "growing") {
              // 每轮翻倍：第 1 轮 2000，第 2 轮 4000，第 3 轮 8000...
              const t = stepTokens * Math.pow(2, metricsCalls - 1);
              yield { kind: "metrics", tokens: { input: t, output: 10, reasoning: 0 } };
            } else {
              // stable：固定值，不增长
              yield { kind: "metrics", tokens: { input: stepTokens, output: 10, reasoning: 0 } };
            }
            await new Promise((r) => setTimeout(r, interval));
          }
        },
        abort: async () => { abortCalls += 1; },
      };
    },
    async streamEvents() { throw new Error("not used"); },
    async abort() { abortCalls += 1; },
  };
  return { backend, abortCalls: () => abortCalls, metricsCalls: () => metricsCalls };
}

function budgetManager(dir, mock, agentOverrides = {}) {
  const config = {
    registry: "x", runDir: dir, pollInterval: 5, waitTimeout: 2000,
    timeout: 5000, retries: 0, defaultIsolation: "none",
  };
  const readRegistry = async () => ({
    getAgent(id) {
      return { id, backend: "opencode-serve", serveUrl: "http://x", cwd: dir, ...agentOverrides };
    },
    listAgents() { return []; },
  });
  return new RunManager({ config, readRegistry, backendFor: () => mock.backend });
}

test("S1-1: token 超 budget → failed + run.budget_exceeded + 兜底 abort", async () => {
  const dir = await makeTempDir();
  try {
    // growing：2000, 4000, 8000... multiplier=100 → effective: 20万, 40万, 80万
    // budget=500000 → 第 3 轮（80万）超限触发
    const mock = createBudgetBackend("growing", { stepTokens: 2000 });
    const manager = budgetManager(dir, mock, { tokenBudget: 500000, tokenBudgetMultiplier: 100 });
    const run = await manager.start("a", { prompt: "go" });
    const result = await run.waitForCompletion({ pollInterval: 5 });
    assert.equal(result.completed, false, "超预算不应 completed");
    assert.equal(result.budgetExceeded, true, "应在 result 标记 budgetExceeded");
    assert.equal(run.state, "failed", "超预算终态必须是 failed");

    const events = await readTranscript(run.transcript.filePath);
    const budgetEvent = events.find((e) => e.type === "run.budget_exceeded");
    assert.ok(budgetEvent, "必须写 run.budget_exceeded 事件");
    assert.equal(budgetEvent.budget, 500000);
    assert.ok(budgetEvent.used > 500000 / budgetEvent.multiplier,
      "used 是逻辑 token（未乘 multiplier），effective=used×multiplier 应超 budget");
    assert.equal(budgetEvent.multiplier, 100);
    const lastState = events.filter((e) => e.type === "run.state_change").at(-1);
    assert.equal(lastState.to, "failed");
    assert.equal(lastState.reason, "budget_exceeded");
    assert.ok(mock.abortCalls() >= 1, "budget_exceeded 后必须兜底 abort");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S1-1: agent 不配 tokenBudget → 闸门不启用，正常完成（向后兼容）", async () => {
  const dir = await makeTempDir();
  try {
    const mock = createBudgetBackend("normal-completed");
    const manager = budgetManager(dir, mock); // 无 tokenBudget
    const run = await manager.start("a", { prompt: "go" });
    const result = await run.waitForCompletion({ pollInterval: 5 });
    assert.equal(result.completed, true, "无 budget 配置应正常完成");
    assert.equal(run.state, "completed");
    const events = await readTranscript(run.transcript.filePath);
    assert.ok(!events.some((e) => e.type === "run.budget_exceeded"),
      "未配 budget 不应出现 budget_exceeded 事件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S1-1: multiplier 生效 — 同样 token，multiplier=1 不触发，multiplier=100 触发", async () => {
  // stable 模式：固定 input=2000 output=10。multiplier=1 → effective=2010 < budget(5000) 不触发
  const dir1 = await makeTempDir();
  let run1;
  try {
    const mock1 = createBudgetBackend("stable", { stepTokens: 2000 });
    const manager1 = budgetManager(dir1, mock1, { tokenBudget: 5000, tokenBudgetMultiplier: 1 });
    run1 = await manager1.start("a", { prompt: "go" });
    const r1 = await run1.waitForCompletion({ pollInterval: 5, waitTimeout: 60 });
    // stable 不增长，waitTimeout 到了走 timed_out（没超 budget）
    assert.equal(run1.state, "timed_out", "multiplier=1 时 effective 不超 budget，走超时");
    const ev1 = await readTranscript(run1.transcript.filePath);
    assert.ok(!ev1.some((e) => e.type === "run.budget_exceeded"), "multiplier=1 不应触发闸门");
  } finally {
    rmSync(dir1, { recursive: true, force: true });
  }
  // 同样 stable token，multiplier=100 → effective=201000 > budget(5000) 立即触发
  const dir2 = await makeTempDir();
  try {
    const mock2 = createBudgetBackend("stable", { stepTokens: 2000 });
    const manager2 = budgetManager(dir2, mock2, { tokenBudget: 5000, tokenBudgetMultiplier: 100 });
    const run2 = await manager2.start("a", { prompt: "go" });
    const r2 = await run2.waitForCompletion({ pollInterval: 5 });
    assert.equal(run2.state, "failed", "multiplier=100 时应触发 budget_exceeded → failed");
    assert.equal(r2.failed, true);
    const ev2 = await readTranscript(run2.transcript.filePath);
    assert.ok(ev2.some((e) => e.type === "run.budget_exceeded"), "multiplier=100 应触发闸门");
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

test("TD-105: backend done(failed) caused by wait timer remains timed_out", async () => {
  const dir = await makeTempDir();
  try {
    const backend = {
      async spawn() {
        return {
          backend: "process",
          backendSessionId: "proc_timeout_race",
          async *events(signal) {
            await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
            yield { kind: "done", reason: "failed", error: "process exited with code 1 after taskkill" };
          },
          async abort() {},
          isAlive: () => false,
        };
      },
    };
    const manager = makeProcessManager(dir, backend);
    const run = await manager.start("test", { prompt: "go" });
    const result = await run.waitForCompletion({ waitTimeout: 20 });

    assert.equal(result.timedOut, true);
    assert.equal(result.failed, false);
    assert.equal(run.state, "timed_out");
    const events = await readTranscript(run.transcript.filePath);
    assert.equal(events.some((event) => event.type === "run.error" && event.phase === "wait"), false);
    assert.equal(events.filter((event) => event.type === "run.state_change" && event.to === "timed_out").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-104: worker output is redacted before in-memory results and transcript persistence", async () => {
  const dir = await makeTempDir();
  const previous = process.env.WAO_RESULT_CHANNEL;
  const secret = "result-test-secret-value-104";
  process.env.WAO_RESULT_CHANNEL = secret;
  try {
    const redactor = createSecretRedactor(process.env, ["WAO_RESULT_CHANNEL"]);
    const backend = {
      async spawn() {
        return {
          backend: "process",
          backendSessionId: "proc_redaction",
          async *events() {
            yield { kind: "message", role: "assistant", parts: [{ type: "text", text: `seen ${secret}` }] };
            yield { kind: "tool_result", output: { value: secret } };
            yield { kind: "done", reason: "completed" };
          },
          async abort() {},
          isAlive: () => false,
          redact: (value) => redactor.redact(value),
        };
      },
    };
    const manager = makeProcessManager(dir, backend);
    const run = await manager.start("test", { prompt: "go" });
    const result = await run.waitForCompletion({ waitTimeout: 1000 });
    const raw = await readFile(run.transcript.filePath, "utf8");

    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(raw.includes(secret), false);
    assert.match(JSON.stringify(result), /\[REDACTED:WAO_RESULT_CHANNEL\]/);
  } finally {
    if (previous === undefined) delete process.env.WAO_RESULT_CHANNEL;
    else process.env.WAO_RESULT_CHANNEL = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S1-1: budget_exceeded 后 handle.abort 被调用（独立于 TD-35 的兜底，确认闸门也走 abort）", async () => {
  const dir = await makeTempDir();
  try {
    const mock = createBudgetBackend("growing", { stepTokens: 5000 });
    // budget=100000, multiplier=100 → 第 1 轮 effective=500500 > 100000 立即触发
    const manager = budgetManager(dir, mock, { tokenBudget: 100000, tokenBudgetMultiplier: 100 });
    const run = await manager.start("a", { prompt: "go" });
    await run.waitForCompletion({ pollInterval: 5 });
    assert.equal(run.state, "failed");
    assert.equal(mock.abortCalls(), 1,
      "budget_exceeded 终态必须调一次 handle.abort（和 TD-35 终态一致）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S1-3 集成: budget_exceeded 触发 raiseAlert → ALERTS.log 被写", async () => {
  const dir = await makeTempDir();
  try {
    const mock = createBudgetBackend("growing", { stepTokens: 5000 });
    const manager = budgetManager(dir, mock, { tokenBudget: 100000, tokenBudgetMultiplier: 100 });
    const run = await manager.start("a", { prompt: "go" });
    await run.waitForCompletion({ pollInterval: 5 });
    assert.equal(run.state, "failed");
    // raiseAlert 是 fire-and-forget，等一下让异步写完成
    await new Promise((r) => setTimeout(r, 50));
    const alertsPath = join(dir, "ALERTS.log");
    const { readFileSync, existsSync } = await import("node:fs");
    assert.ok(existsSync(alertsPath), "budget_exceeded 必须触发告警写 ALERTS.log");
    const content = readFileSync(alertsPath, "utf8");
    assert.match(content, /\[budget\]/, "ALERTS.log 必须含 budget 级别");
    assert.match(content, new RegExp(run.runId), "ALERTS.log 必须含 runId");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("并发 start 同毫秒不产生 runId 碰撞（真实 workflow 并行暴露）", async () => {
  const dir = await makeTempDir();
  try {
    const fetchImpl = createMockFetch();
    const manager = createManager(dir, fetchImpl);
    // 同毫秒并行 start 3 个 run（模拟 workflow 同层 Promise.all）
    const runs = await Promise.all([
      manager.start("test_agent", { prompt: "a" }),
      manager.start("test_agent", { prompt: "b" }),
      manager.start("test_agent", { prompt: "c" }),
    ]);
    const runIds = runs.map((r) => r.runId);
    const unique = new Set(runIds);
    assert.equal(unique.size, 3, `runIds must be unique, got: ${runIds.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-5: 多 run 并发 wait 时交叉 abort 不互相干扰", async () => {
  // 并发场景：两个 run 同时处于 waitForCompletion，中途 abort 其中一个，
  // 另一个应正常完成，不受 abort 的干扰（activeRuns 隔离、_aborted flag 各自独立）。
  const dirs = [];
  try {
    const fetchImpl = createMockFetch({ assistantDelay: 100 });
    const dirA = await makeTempDir(); dirs.push(dirA);
    const dirB = await makeTempDir(); dirs.push(dirB);
    const managerA = createManager(dirA, fetchImpl);
    const managerB = createManager(dirB, fetchImpl);
    const runA = await managerA.start("test_agent", { prompt: "a" });
    const runB = await managerB.start("test_agent", { prompt: "b" });

    // 两者同时进入 wait
    const waitA = runA.waitForCompletion({ waitTimeout: 5000, pollInterval: 10 });
    const waitB = runB.waitForCompletion({ waitTimeout: 5000, pollInterval: 10 });
    await new Promise((r) => setTimeout(r, 5)); // 让两者进入 submitted/running

    // 中途只 abort A
    await runA.abort("user");

    const [resA, resB] = await Promise.all([waitA, waitB]);
    // A 必须 aborted
    assert.equal(runA.state, "aborted", "runA 被 abort → state=aborted");
    // B 必须不受影响，正常完成
    assert.equal(runB.state, "completed", "runB 不受 A 的 abort 干扰 → 正常 completed");
    assert.equal(resB.completed, true, "runB 的 waitResult 应 completed:true");
    // 两个 manager 的 activeRuns 都已清空（A 因 abort，B 因完成）
    assert.equal(managerA.activeRuns.size, 0);
    assert.equal(managerB.activeRuns.size, 0);
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-5: 同一 manager 内多 run 并发，一个超时另一个完成", async () => {
  // 同一 manager 内并发两个 run，一个会超时（waitTimeout 小），另一个正常完成。
  // 验证超时不串扰、activeRuns 正确移除。
  const dir = await makeTempDir();
  try {
    const fetchImpl = createMockFetch({ assistantDelay: 50 });
    const manager = createManager(dir, fetchImpl);
    const runFast = await manager.start("test_agent", { prompt: "fast", runId: "concurrent_fast" });
    const runSlow = await manager.start("test_agent", { prompt: "slow", runId: "concurrent_slow" });
    assert.equal(manager.activeRuns.size, 2);

    // fast 给充足时间完成；slow 给极短 timeout 触发超时
    const waitFast = runFast.waitForCompletion({ waitTimeout: 2000, pollInterval: 10 });
    const waitSlow = runSlow.waitForCompletion({ waitTimeout: 1, pollInterval: 5 });
    const [resFast, resSlow] = await Promise.all([waitFast, waitSlow]);

    assert.equal(resFast.completed, true, "fast 应正常完成");
    assert.equal(resSlow.timedOut, true, "slow 应超时");
    assert.equal(runFast.state, "completed");
    assert.equal(runSlow.state, "timed_out");
    // 两个 run 都从 activeRuns 移除
    assert.equal(manager.activeRuns.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- P1-1 认证新鲜度强制门（requireCertified）---
// 守卫已落地的门控逻辑（runManager.js:127-163）。门控在 backend.spawn() 前拒绝，
// 拒绝时 transition pending→failed + 写 run.error(certification-gate) + 抛 Error("Refused dispatch")。

async function writeReliabilitySummary(dir, workers, generatedAt = new Date().toISOString()) {
  const { writeFileSync } = await import("node:fs");
  const summary = {
    version: 1,
    generatedAt,
    counts: {},
    allCertified: false,
    workers,
    cases: [],
  };
  writeFileSync(join(dir, "reliability-summary.json"), JSON.stringify(summary));
}

test("P1-1: requireCertified 默认关 — 不检查 summary，正常派发", async () => {
  const dir = await makeTempDir();
  try {
    // dir 里没有 reliability-summary.json
    const fetchImpl = createMockFetch();
    const manager = createManager(dir, fetchImpl);
    const run = await manager.start("test_agent", { prompt: "hello" }); // 不传 requireCertified
    assert.equal(run.state, "submitted", "默认不检查，应正常进入 submitted");
    await run.waitForCompletion({});
    assert.equal(run.state, "completed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-1: requireCertified + 缺 summary → 拒绝", async () => {
  const dir = await makeTempDir();
  try {
    const fetchImpl = createMockFetch();
    const manager = createManager(dir, fetchImpl);
    await assert.rejects(
      manager.start("test_agent", { prompt: "hello", requireCertified: true }),
      /Refused dispatch/,
      "缺 summary 应在 spawn 前拒绝",
    );
    // 拒绝时状态应为 failed
    const managerInDir = [...manager.allRuns?.values?.() ?? []];
    // 直接验证：dir 下应有 transcript 记录 certification-gate 错误
    const { readdirSync, readFileSync: rf } = await import("node:fs");
    const jsonl = readdirSync(dir).find((f) => f.endsWith(".jsonl"));
    assert.ok(jsonl, "应有 transcript 文件");
    const content = rf(join(dir, jsonl), "utf8");
    assert.ok(content.includes("certification-gate"), "transcript 应记录 certification-gate 拒绝");
    assert.ok(content.includes("reliability-summary.json 不存在"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-1: requireCertified + worker 未在 summary → 拒绝", async () => {
  const dir = await makeTempDir();
  try {
    await writeReliabilitySummary(dir, { other_agent: { agentId: "other_agent", status: "certified" } });
    const fetchImpl = createMockFetch();
    const manager = createManager(dir, fetchImpl);
    await assert.rejects(
      manager.start("test_agent", { prompt: "hello", requireCertified: true }),
      /未在 reliability-summary/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-1: requireCertified + status=rejected → 拒绝", async () => {
  const dir = await makeTempDir();
  try {
    await writeReliabilitySummary(dir, { test_agent: { agentId: "test_agent", status: "rejected" } });
    const fetchImpl = createMockFetch();
    const manager = createManager(dir, fetchImpl);
    await assert.rejects(
      manager.start("test_agent", { prompt: "hello", requireCertified: true }),
      /status=rejected/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-1: requireCertified + status=certified 且新鲜 → 放行", async () => {
  const dir = await makeTempDir();
  try {
    await writeReliabilitySummary(dir, { test_agent: { agentId: "test_agent", status: "certified" } });
    const fetchImpl = createMockFetch();
    const manager = createManager(dir, fetchImpl);
    const run = await manager.start("test_agent", { prompt: "hello", requireCertified: true });
    assert.equal(run.state, "submitted", "certified 且新鲜应放行进入 submitted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-1: requireCertified + status=conditional → 放行（core 全过即放行阈值）", async () => {
  const dir = await makeTempDir();
  try {
    await writeReliabilitySummary(dir, { test_agent: { agentId: "test_agent", status: "conditional" } });
    const fetchImpl = createMockFetch();
    const manager = createManager(dir, fetchImpl);
    const run = await manager.start("test_agent", { prompt: "hello", requireCertified: true });
    assert.equal(run.state, "submitted", "conditional 应放行");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-1: requireCertified + manualOverride=cleared → 放行（即便 status 差）", async () => {
  const dir = await makeTempDir();
  try {
    await writeReliabilitySummary(dir, {
      test_agent: { agentId: "test_agent", status: "rejected", manualOverride: "cleared" },
    });
    const fetchImpl = createMockFetch();
    const manager = createManager(dir, fetchImpl);
    const run = await manager.start("test_agent", { prompt: "hello", requireCertified: true });
    assert.equal(run.state, "submitted", "manualOverride=cleared 应强制放行");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-1: requireCertified + 认证过期 → 拒绝", async () => {
  const dir = await makeTempDir();
  try {
    // generatedAt = 40 天前（certFreshnessDays 默认 30）
    const stale = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await writeReliabilitySummary(dir, { test_agent: { agentId: "test_agent", status: "certified" } }, stale);
    const fetchImpl = createMockFetch();
    const manager = createManager(dir, fetchImpl);
    await assert.rejects(
      manager.start("test_agent", { prompt: "hello", requireCertified: true }),
      /认证已过期/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- TD-99 审计收尾：start rejection 行为 ---

test("TD-99: 已有 terminal transcript + 相同 runId start → spawn 调用次数为 0", async () => {
  const dir = await makeTempDir();
  try {
    const runId = "run_already_terminal";
    const tp = join(dir, `${runId}.jsonl`);
    const seed = new JsonlTranscript(tp, { runId, agentId: "test_agent" });
    await seed.append("run.started", { backend: "test" });
    await seed.transitionState(null, "running", "first_message");
    await seed.transitionState("running", "failed", "backend_error");

    let spawnCalls = 0;
    const backendFor = () => ({
      async spawn() { spawnCalls += 1; return { backend: "fake", backendSessionId: "ses" }; },
    });
    const config = { registry: "config/agents.json", runDir: dir, timeout: 5000, retries: 0 };
    const readRegistry = async () => ({
      getAgent(id) { return { id, backend: "fake", cwd: dir }; },
      listAgents() { return []; },
    });
    const manager = new RunManager({ config, readRegistry, transcriptDir: dir, backendFor });

    await assert.rejects(
      manager.start("test_agent", { prompt: "hello", runId }),
      /already in terminal state/,
    );
    assert.equal(spawnCalls, 0, "pending rejected → backend.spawn 不得调用");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-99: backend.spawn 返回前由第二个 writer claim aborted → submitted rejected + handle abort + 不注册 activeRuns", async () => {
  const dir = await makeTempDir();
  try {
    const runId = "run_spawn_race";
    let handleAborted = false;
    let resolveSpawn;
    const spawnPromise = new Promise((resolve) => { resolveSpawn = resolve; });
    // spawnEntered barrier：spawn 被调用时 resolve，测试据此确定 start 已走到 spawn
    // （pending accepted），无需 setTimeout 猜测时序。
    let signalSpawnEntered;
    const spawnEntered = new Promise((resolve) => { signalSpawnEntered = resolve; });
    const backendFor = () => ({
      async spawn() {
        signalSpawnEntered();
        return spawnPromise.then(() => ({
          backend: "fake",
          backendSessionId: "ses_race",
          abort: async () => { handleAborted = true; },
        }));
      },
    });
    const config = { registry: "config/agents.json", runDir: dir, timeout: 5000, retries: 0 };
    const readRegistry = async () => ({
      getAgent(id) { return { id, backend: "fake", cwd: dir }; },
      listAgents() { return []; },
    });
    const manager = new RunManager({ config, readRegistry, transcriptDir: dir, backendFor });

    const startPromise = manager.start("test_agent", { prompt: "hello", runId });
    // 等 spawn 真正被调用（barrier），此时 pending 已 accepted，start 在等 spawn resolve。
    await spawnEntered;

    // 第二个 writer 在 spawn resolve 前 claim aborted（确定性，不依赖 sleep）。
    const tp = join(dir, `${runId}.jsonl`);
    const externalWriter = new JsonlTranscript(tp, { runId, agentId: "test_agent" });
    await externalWriter.transitionState("pending", "aborted", "external_stop");

    resolveSpawn();

    await assert.rejects(startPromise, /became terminal/);
    assert.equal(handleAborted, true, "rejected 时新 handle 被 abort");
    assert.equal(manager.activeRuns.has(runId), false, "不注册到 activeRuns");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
