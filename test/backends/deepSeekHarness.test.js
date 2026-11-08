import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import readline from "node:readline";

import {
  DeepSeekHarnessBackend,
  DeepSeekHarnessEventQueue,
  projectDshEvent,
} from "../../src/backends/deepSeekHarness.js";
import { normalizeAgent } from "../../src/registry.js";
import { inheritedEnvNames, requiredCredentialNames } from "../../src/envPolicy.js";
import { backendFor } from "../../src/commands/shared.js";

const FAKE_RUNTIME = fileURLToPath(new URL("../fixtures/fakeDshJsonRpcRuntime.mjs", import.meta.url));
const FAKE_CONFIG = fileURLToPath(new URL("../../package.json", import.meta.url));

function agent(overrides = {}) {
  return {
    id: "coder_low",
    backend: "deepseek-harness",
    cwd: process.cwd(),
    binary: process.execPath,
    args: [FAKE_RUNTIME],
    dshConfigPath: FAKE_CONFIG,
    credentialEnv: "DEEPSEEK_API_KEY",
    model: { id: "deepseek-v4-flash", contextWindow: 1_000_000 },
    reasoning: { effort: "max" },
    ...overrides,
  };
}

async function collect(handle) {
  const events = [];
  for await (const event of handle.events(new AbortController().signal)) events.push(event);
  return events;
}

test("projectDshEvent: 首个 assistant/message usage → firstRequest；后续消息不覆盖", () => {
  const state = { seen: false, value: null };
  const first = projectDshEvent({
    type: "assistant/message",
    data: {
      message: { content: [] },
      usage: { input_tokens: 10, cache_read_input_tokens: 3, output_tokens: 2 },
    },
  }, new Map(), state);
  const second = projectDshEvent({
    type: "assistant/message",
    data: {
      message: { content: [] },
      usage: { input_tokens: 99, cache_read_input_tokens: 50, output_tokens: 5 },
    },
  }, new Map(), state);
  assert.deepEqual(first[0].firstRequest, { input: 10, cacheRead: 3 });
  assert.deepEqual(second[0].firstRequest, { input: 10, cacheRead: 3 },
    "第一个请求的用量不被后续请求覆盖");
});

test("DSH policy accepts flash/max/1m and rejects unsupported effort", () => {
  const backend = new DeepSeekHarnessBackend();
  assert.doesNotThrow(() => backend.validateAgentPolicy(agent()));
  assert.throws(
    () => backend.validateAgentPolicy(agent({ reasoning: { effort: "xhigh" } })),
    /reasoning\.effort/,
  );
});

// DSH 只把 model.id 交给运行时（DSH_MODEL env）——model.providerID /
// model.variant 配了即拒（kimi-web/zcode 同款纪律，不静默丢弃路由字段；
// providerID 还会进车道身份四元组，静默接受会让认证台账记下不存在的 provider 区分）。
test("DSH policy rejects model.providerID / model.variant; bare model.id still passes", () => {
  const backend = new DeepSeekHarnessBackend();
  assert.throws(
    () => backend.validateAgentPolicy(agent({ model: { id: "deepseek-v4-flash", providerID: "deepseek" } })),
    /cannot express model\.providerID\/model\.variant[\s\S]*DSH_MODEL/,
  );
  assert.throws(
    () => backend.validateAgentPolicy(agent({ model: { id: "deepseek-v4-flash", variant: "stable" } })),
    /cannot express model\.providerID\/model\.variant[\s\S]*DSH_MODEL/,
  );
  assert.doesNotThrow(
    () => backend.validateAgentPolicy(agent({ model: { id: "deepseek-v4-flash" } })),
    "bare model.id（无 providerID/variant）照常通过",
  );
});

test("DSH JSON-RPC buffers pre-response notifications and completes after bound receipt + idle", async () => {
  const backend = new DeepSeekHarnessBackend();
  const handle = await backend.spawn(agent({ env: { FAKE_DSH_MODE: "foreign-first" } }), {
    prompt: "reply",
    roleContract: "bounded role",
    resolvedCredentials: { DEEPSEEK_API_KEY: "secret-value-123" },
  });
  const events = await collect(handle);

  assert.equal(handle.backend, "deepseek-harness");
  assert.ok(events.some((event) => event.kind === "runtime_activity" && event.status === "initialized"));
  assert.ok(events.some((event) => event.kind === "message"
    && event.parts.some((part) => part.text === "DSH_OK deepseek-v4-flash")));
  assert.ok(!events.some((event) => JSON.stringify(event).includes("FOREIGN_OUTPUT")));
  assert.ok(events.some((event) => event.kind === "metrics" && event.tokens.input === 12));
  assert.deepEqual(events.at(-1), { kind: "done", reason: "completed" });
});

test("DSH projects shell and write evidence with confirmed file writes", async () => {
  const backend = new DeepSeekHarnessBackend();
  const handle = await backend.spawn(agent({ env: { FAKE_DSH_MODE: "evidence" } }), {
    prompt: "edit",
    roleContract: "bounded role",
  });
  const events = await collect(handle);

  assert.ok(events.some((event) => event.kind === "command"
    && event.command === "Get-Content README.md" && event.toolCallId === "call-shell"));
  assert.ok(events.some((event) => event.kind === "write_intent"
    && event.path === "src/example.js" && event.toolCallId === "call-edit"));
  assert.ok(events.some((event) => event.kind === "file_written"
    && event.path === "src/example.js" && event.toolCallId === "call-edit"));
  assert.ok(events.some((event) => event.kind === "tool_result" && event.tool === "call-edit"));
});

test("DSH fails closed on internal subagents and transport close before completion", async () => {
  for (const mode of ["subagent", "transport-close"]) {
    const backend = new DeepSeekHarnessBackend();
    const handle = await backend.spawn(agent({ env: { FAKE_DSH_MODE: mode } }), {
      prompt: "probe",
      roleContract: "bounded role",
    });
    const events = await collect(handle);
    assert.equal(events.at(-1)?.kind, "done");
    assert.equal(events.at(-1)?.reason, "failed");
  }
});

test("DSH drains a terminal fact queued while the event iterator is paused", async () => {
  const backend = new DeepSeekHarnessBackend();
  const queue = new DeepSeekHarnessEventQueue();
  const iterator = backend._events(queue, { exitCode: null, signalCode: null });
  queue.push({ kind: "runtime_activity", status: "streaming" });

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { kind: "runtime_activity", status: "streaming" },
  });
  queue.push({ kind: "done", reason: "failed", error: "transport closed" });
  queue.close();

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { kind: "done", reason: "failed", error: "transport closed" },
  });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test("DSH 0072: an event queued while the iterator is paused is delivered without waiting for the next push", async () => {
  const backend = new DeepSeekHarnessBackend();
  const queue = new DeepSeekHarnessEventQueue();
  const iterator = backend._events(queue, { exitCode: null, signalCode: null });
  queue.push({ kind: "runtime_activity", status: "streaming" });
  assert.equal((await iterator.next()).value.status, "streaming");
  // The consumer is still busy with the event above; the queue stays open and nothing else is pushed.
  const command = { kind: "command", command: "sleep 600", toolCallId: "call_1" };
  queue.push(command);
  const step = await Promise.race([
    iterator.next(),
    new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
  ]);
  assert.ok(step !== null, "the queued command must not wait for a later push");
  assert.deepEqual(step, { done: false, value: command });
  queue.close();
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test("DSH coalesces streaming chunks into one bounded runtime activity fact", async () => {
  const backend = new DeepSeekHarnessBackend();
  const handle = await backend.spawn(agent({ env: { FAKE_DSH_MODE: "streaming" } }), {
    prompt: "reply",
    roleContract: "bounded role",
  });
  const events = await collect(handle);

  assert.equal(
    events.filter((event) => event.kind === "runtime_activity" && event.status === "streaming").length,
    1,
  );
  assert.deepEqual(events.at(-1), { kind: "done", reason: "completed" });
});

test("DSH validates runtime identity before returning a handle", async () => {
  const backend = new DeepSeekHarnessBackend();
  await assert.rejects(
    backend.spawn(agent({ env: { FAKE_DSH_MODE: "bad-identity" } }), {
      prompt: "probe",
      roleContract: "bounded role",
    }),
    /runtime identity/,
  );
});

test("DSH registry, credential policy, and production backend factory share the new backend", () => {
  const normalized = normalizeAgent("coder_low", agent());
  assert.equal(normalized.backend, "deepseek-harness");
  assert.deepEqual(requiredCredentialNames(normalized), ["DEEPSEEK_API_KEY"]);
  assert.ok(inheritedEnvNames(normalized).includes("DEEPSEEK_API_KEY"));
  assert.ok(backendFor(normalized) instanceof DeepSeekHarnessBackend);

  assert.throws(
    () => normalizeAgent("bad", { ...agent(), dshConfigPath: "" }),
    /dshConfigPath/,
  );
  assert.throws(
    () => normalizeAgent("bad", { ...agent(), credentialEnv: undefined }),
    /credentialEnv/,
  );
  assert.throws(
    () => normalizeAgent("bad", { ...agent(), credentialEnv: "" }),
    /credentialEnv/,
  );
});

// ── 第 83 批 A：子进程死后写 stdin（EPIPE）不得打死 runner ──────────────────
//
// 现场（2026-11-07）同族：子进程退出后下一次 stdin 写的回调收 EPIPE，**同时**管道
// 发出无人监听的 'error' 事件——runner 整个进程退出码 1。写失败已由 request 的写
// 回调拒掉在途请求（shutdown 由 _shutdown 的 catch 收口），本例钉的是：子进程已死
// 而 close 尚未到达（EPIPE 先于 close，与现场同时序）时，终态照常 failed 收口、
// 测试进程不崩。删掉 deepSeekHarness.js 的常驻 stdin 'error' 监听后，helper 里的
// emit("error") 无监听 → 未捕获异常 → 本测试文件判红。
// 本文件其余用例跑真实 fake runtime 子进程；这一例走注入 spawnFn 的 fake 子进程，
// 以便在"进程已死、close 未到"的窗口里确定性地断掉 stdin。

/** fake 子进程（deepSeekAcp.test.js 同款）：PassThrough 三流 + spawn 即成功。 */
function makeFakeChild() {
  const child = new EventEmitter();
  child.pid = 424244;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  const originalOnce = child.once.bind(child);
  child.once = (event, listener) => {
    originalOnce(event, listener);
    if (event === "spawn") queueMicrotask(() => listener());
    return child;
  };
  child.end = (code = 0) => {
    if (child.exitCode !== null) return;
    child.exitCode = code;
    child.emit("close", code, null);
  };
  return child;
}

/** 断管：就地破坏同一个 stdin 对象（对象身份不变——backend 在 spawn 时挂上的
 * 常驻 'error' 监听正是挂在它上面；换对象会把监听留在旧流上，测不到实现）。
 * 每次 write 的回调收到错误，同时（与真实流同一次序：先回调、后事件）发出
 * 'error' 事件；EPIPE 之后才轮到 close。真实流的错误由 OS 异步送达，这里用
 * setImmediate 模拟同样的异步时序。exitCode 同步置位，_kill 对已退出进程是
 * 幂等 no-op（绝不对假 pid 跑真 taskkill）。 */
function breakStdin(child) {
  const stdin = child.stdin;
  stdin.write = (_data, cb) => {
    const error = new Error("write EPIPE");
    setImmediate(() => {
      child.exitCode = 0;
      (typeof cb === "function" ? cb : () => {})(error);
      stdin.emit("error", error);
      // close 再晚一拍：让写回调的拒绝先被消费（现场的 EPIPE 也先于 close 到达）。
      setImmediate(() => child.emit("close", 0, null));
    });
    return true;
  };
}

test("DSH EPIPE：子进程死、stdin 断（close 未到）→ 终态路径照常 failed 收口，进程不崩", async () => {
  const child = makeFakeChild();
  const backend = new DeepSeekHarnessBackend({ spawnFn: () => child });
  let stdinBroke = false;
  // 迷你对端：initialize / session/prompt 照答（runtime 身份 + prompt 回执），
  // prompt 应答后立刻以该会话为父推 subagent.started（queueTerminal(failed) 的
  // 最短路径，不需要 prompt 回执之外的任何事件形状）。
  const lines = readline.createInterface({ input: child.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    const frame = JSON.parse(line);
    if (frame.method === "initialize") {
      child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { serverInfo: { name: "deepseek-harness-sdk-runtime" } } }) + "\n");
      return;
    }
    if (frame.method === "session/prompt") {
      child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { messageId: "m_epipe_1" } }) + "\n");
      // 先摘掉本对端挂在 child.stdin 上的 readline：readline 自带一个会抛错的
      // 'error' 监听（真实现从不在 stdin 上放 readline），不断管它会盖过被测的
      // 常驻监听。然后子进程"死亡"：stdin 断（不 emit close——现场里 EPIPE 先于
      // close 到达）。
      lines.close();
      breakStdin(child);
      stdinBroke = true;
      // 终态触发：未授权内部 subagent → queueTerminal(failed) → _shutdown 写
      // shutdown 请求 → EPIPE（写回调拒掉该请求，_shutdown 的 catch 收口）。
      child.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "subagent.started", params: { parentSessionId: frame.params?.sessionId, childSessionId: "child-1" } }) + "\n");
    }
  });

  const handle = await backend.spawn(agent(), { prompt: "probe", roleContract: "bounded role" });
  const events = await collect(handle);
  assert.ok(stdinBroke, "断管已装上（prompt 写入之后）");
  assert.equal(child.exitCode, 0, "EPIPE 后 close 到达，进程死事实落定");
  const done = events.at(-1);
  assert.equal(done.kind, "done");
  assert.equal(done.reason, "failed");
  assert.match(done.error, /unauthorized internal subagent/);
});
