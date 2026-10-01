// test/backends/zcode.test.js
//
// 第 8 个 backend「zcode」（进程式 stdio app-server，ZCode Protocol v1）的确定性
// 单测。照 test/backends/deepSeekAcp.test.js 的注入式 fake 子进程纪律：零真实
// zcode、零模型调用、零网络——child 是 PassThrough 三流拼的 fake（stdin 可读出
// backend 发出的行分隔 JSON 帧、stdout 由测试喂帧）。wire 事实形状 =
// 2026-10-01 本机 live 实测 + 同日对捆绑 zcode.cjs 的只读源码核证
// （src/backends/zcode.js 文件头，行号在案）。
//
// 覆盖：信封（无 jsonrpc）、server→client 请求应答器（逐方法 schema 合法拒绝
// ——第三轮 auditor #5）、create→setModel→send 请求形状、模型 ref 拆分、完成判定
// （step-finish stop/error）+ 历史含 stop 的 resume 反例（auditor 完成判据反例）、
// stalled 兜底、发射前非空复检（N1）、usage→metrics（cacheReadTokens/
// cacheCreationTokens 上游字段名——auditor #2）、abort（幂等/诚实措辞/传输已关
// 不抛——auditor #4）、resume 轮（先 session/resume 装载再 setModel——auditor #1，
// fake 对端有状态）、真杀隔离守卫（全部构造注入 killFn——auditor #3）、policy
// 拒绝分支、通信失败=进程死、registry zcode 分支。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

import {
  ZcodeBackend,
  ZCODE_ROLE_TASK_SEPARATOR,
  splitZcodeModelRef,
} from "../../src/backends/zcode.js";
import { backendCapabilitySnapshot, backendFor } from "../../src/backends/factory.js";
import { normalizeAgent } from "../../src/registry.js";

const SESSION_ID = "sess_zcode_test_1";

function makeAgent(overrides = {}) {
  return {
    id: "coder_zcode",
    backend: "zcode",
    cwd: "D:/wao-test/zcode-ws",
    // registry 要求绝对路径；spawn 本身被 stub。
    binary: "C:\\Users\\<you>\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs",
    model: { id: "bigmodel-api/GLM-5.3" },
    ...overrides,
  };
}

/** fake 子进程：PassThrough 三流 + spawn 即成功 + kill/end 即 close。 */
function makeFakeChild() {
  const child = new EventEmitter();
  child.pid = 424243;
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
  child.kill = () => {
    child.end(1);
    return true;
  };
  return child;
}

// ===== #3 真杀隔离（auditor 第三轮）：本文件所有 ZcodeBackend 构造必须注入
// killFn——默认 killFn 是真 taskkill（spawn 一个真实 taskkill 进程），测试中绝不
// 允许执行。fakeKill 是与 spawnFn 同款的注入缝：记录调用、置 exitCode（= 进程已
// 死），由 ⑪ 守卫对源码自扫描钉住"凡构造处必有 killFn"。
function fakeKill() {
  const calls = [];
  const killFn = (child) => {
    calls.push(child);
    child.kill();
  };
  return { calls, killFn };
}

/**
 * fake zcode app-server 对端：记录 backend 发出的全部帧（clientFrames），按
 * options 应答。**有状态（auditor #1）**：activeSessions 集合模拟上游每进程一张
 * 的 sessions Map（zcode.cjs:15262）——create/resume 注册，requireSession 系方法
 * （setModel/send/messages/usage/stop）查表 miss 即回 "Session is not active"
 * （zcode.cjs:15245 Xy 的形状）。正是 v2 漏检形状：跳过 session/resume 直发
 * setModel 在这里必然失败（⑨d 直接钉）。
 * messages 脚本：函数 (pollCount) => messages[]（第 1 次调用 = spawn 期基线快照，
 * 其后为事件轮询拍）。
 */
function fakeZcodePeer(child, {
  sessionId = SESSION_ID,
  setModelError = null,      // {code, message} → setModel 返回错误（zod 教学形状）
  accepted = true,           // session/send 的 accepted 值
  messages = () => [],       // (pollCount) => messages[]
  // 上游 CRn 实际字段名（zcode.cjs:15259）：cache 系带 Tokens 后缀（auditor #2）。
  usage = { totalTokens: 101, inputTokens: 60, outputTokens: 30, reasoningTokens: 5, cacheReadTokens: 4, cacheCreationTokens: 2, modelRequestCount: 2 },
  stopError = null,          // session/stop 的错误（abort 失败腿）
  hangCreate = false,        // 不应答 session/create（spawn 期进程死测试用）
  resumeError = null,        // session/resume 的错误帧（fail-closed 测试）
  resumeResult = null,       // 非 null 时 resume 按此原样应答（未知形状测试）
  serverProbeDuringCreate = false, // 收到 create 时先发一个 server→client 请求
} = {}) {
  const activeSessions = new Set();
  const clientFrames = [];
  let polls = 0;
  const send = (obj) => child.stdout.write(JSON.stringify(obj) + "\n");
  const requireActive = (frame) => {
    const sid = frame.params?.sessionId;
    if (!activeSessions.has(sid)) {
      send({
        id: frame.id,
        error: { code: -32009, data: { name: "ProtocolRequestError" }, message: `Session is not active: ${sid}` },
      });
      return false;
    }
    return true;
  };
  const lines = readline.createInterface({ input: child.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    const frame = JSON.parse(line);
    clientFrames.push(frame);
    if (frame.method === undefined) return; // backend 的应答（对 server 请求）——只记录
    if (frame.method === "session/create") {
      if (serverProbeDuringCreate) {
        send({ id: 9001, method: "session/requestRuntimePreferences", params: {} });
        send({ id: 9002, method: "interaction/requestOfficialMcpAuthHeaders", params: {} });
      }
      if (hangCreate) return;
      activeSessions.add(sessionId);
      send({
        id: frame.id,
        result: {
          session: { sessionId, model: "glm-5.3" },
          settings: { model: { available: [{ ref: { providerId: "bigmodel-api", modelId: "GLM-5.3" } }] } },
          projection: { status: "ready" },
        },
      });
      return;
    }
    if (frame.method === "session/resume") {
      // zKo → wRn（zcode.cjs:15256）：按 params.sessionId 装载持久化记录并注册进
      // 会话表；miss 抛 "Session not found"。默认应答 = 与 create 同源 snapshot。
      if (resumeError) {
        send({ id: frame.id, error: resumeError });
        return;
      }
      activeSessions.add(frame.params?.sessionId);
      if (resumeResult !== null) {
        send({ id: frame.id, result: resumeResult });
        return;
      }
      send({
        id: frame.id,
        result: {
          session: { sessionId: frame.params?.sessionId },
          settings: { model: { available: [{ ref: { providerId: "bigmodel-api", modelId: "GLM-5.3" } }] } },
          projection: { status: "ready" },
        },
      });
      return;
    }
    if (frame.method === "session/setModel") {
      if (!requireActive(frame)) return;
      if (setModelError) send({ id: frame.id, error: setModelError });
      else send({ id: frame.id, result: {} });
      return;
    }
    if (frame.method === "session/send") {
      if (!requireActive(frame)) return;
      send({ id: frame.id, result: { accepted, stateRevision: 7 } });
      return;
    }
    if (frame.method === "session/messages") {
      if (!requireActive(frame)) return;
      polls += 1;
      send({ id: frame.id, result: { messages: messages(polls) } });
      return;
    }
    if (frame.method === "session/usage") {
      if (!requireActive(frame)) return;
      send({ id: frame.id, result: usage });
      return;
    }
    if (frame.method === "session/stop") {
      if (!requireActive(frame)) return;
      if (stopError) send({ id: frame.id, error: stopError });
      else send({ id: frame.id, result: { stopped: true } });
      return;
    }
    send({ id: frame.id, result: {} });
  });
  return {
    clientFrames,
    polls: () => polls,
    framesOf: (method) => clientFrames.filter((f) => f.method === method),
    notify: (method, params) => send({ method, params }),
    serverRequest: (id, method, params) => send({ id, method, params }),
    closeTransport: (code = 0) => { child.stdout.end(); child.end(code); },
  };
}

/** 跑一个场景：注入 fake spawn/kill → spawn handle（不收事件）。 */
async function runScenario({ agent = makeAgent(), task = { prompt: "do the task" }, peerOptions = {} } = {}) {
  const child = makeFakeChild();
  const spawnCalls = [];
  const kill = fakeKill();
  const backend = new ZcodeBackend({
    spawnFn: (binary, args, opts) => {
      spawnCalls.push({ binary, args, opts });
      return child;
    },
    killFn: kill.killFn,
  });
  const peer = fakeZcodePeer(child, peerOptions);
  const handle = await backend.spawn(agent, task);
  return { backend, child, peer, handle, spawnCalls, killCalls: kill.calls };
}

async function collect(handle, opts = {}) {
  const events = [];
  for await (const event of handle.events(new AbortController().signal, {
    pollInterval: 2,
    ...opts,
  })) {
    events.push(event);
  }
  return events;
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(5);
  }
  return Boolean(predicate());
}

const userMsg = (text) => ({ role: "user", parts: [{ type: "text", text }] });
const assistantMsg = (text, reason = "stop") => ({
  role: "assistant",
  parts: [{ type: "text", text }, { type: "step-finish", reason, tokens: { input: 60, output: 30 } }],
});

// 上游 zod 结果 schema 的最小复刻（bundle 核证 zcode.cjs:72，第三轮 auditor #5）
// ——只复刻"必填字段在场/枚举成员"这一层校验（上游 resolveClientRequest 对 client
// 应答做 resultSchema.parse，zcode.cjs:15262——空对象对带必填字段的方法 = 校验失败）：
const UPSTREAM_RESULT_VALIDATORS = {
  // pGt：nativeSearchEnhancementsEnabled (boolean) 必填，其余字段有缺省。
  "session/requestRuntimePreferences": (r) => typeof r?.nativeSearchEnhancementsEnabled === "boolean",
  // CYe：action ∈ {accept,decline,cancel} 必填（content/reason 可选）。
  "interaction/requestUserInput": (r) => ["accept", "decline", "cancel"].includes(r?.action),
  // JL/jZe：decision ∈ {allow,deny,escalate,modify} 必填（reason 可选）。
  "interaction/requestPermission": (r) => ["allow", "deny", "escalate", "modify"].includes(r?.decision),
  // DGt 判别联合 headersApplied=false 臂（errorMessage 可选）。
  "interaction/requestProviderRuntimeHeaders": (r) => r?.headersApplied === false,
  // OGt 判别联合 ok=false 臂：reason **必填** ∈ PHt 枚举（裸 {ok:false} 过不了）。
  "interaction/requestOfficialMcpAuthHeaders": (r) => r?.ok === false
    && ["official_auth_unavailable", "official_auth_plan_required", "official_mcp_origin_untrusted"].includes(r?.reason),
};

// ===== ① 信封与应答器 =====

test("zcode ①: 请求信封无 jsonrpc（{id, method, params}），server 请求应答器就绪于握手期", async () => {
  const { peer, child } = await runScenario({
    peerOptions: {
      serverProbeDuringCreate: true,
      messages: (n) => (n <= 1 ? [] : [userMsg("do the task"), assistantMsg("answer")]),
    },
  });
  // create 期间上游发的两个 server→client 请求都被应答（不应答则 session/create
  // 15s 超时——live 实测）。
  assert.ok(
    await waitUntil(() => peer.clientFrames.some((f) => f.id === 9001 && f.result)),
    "requestRuntimePreferences 被应答",
  );
  // 信封纪律：backend 发出的全部请求帧不带 jsonrpc 字段（上游 zod 拒收——live 实测）。
  const requests = peer.clientFrames.filter((f) => typeof f.method === "string");
  assert.ok(requests.length >= 4, "create/setModel/send(基线 messages) 至少 4 帧");
  for (const frame of requests) {
    assert.equal(Object.hasOwn(frame, "jsonrpc"), false, "请求帧绝不带 jsonrpc 字段");
    assert.equal(typeof frame.id, "number");
    assert.equal(typeof frame.params, "object");
  }
  // 通知（无 id）被忽略：不致崩溃、不影响完成判定。
  peer.notify("startup", {});
  child.kill();
});

// ===== ①b 应答器逐方法 schema 合法拒绝（auditor #5：绝不自动授权）=====

test("zcode ①b: server 请求逐方法应答 schema 合法拒绝——必填字段在场、枚举成员合法、未知方法显式 -32601", async () => {
  const { peer, child, handle } = await runScenario({
    peerOptions: { messages: (n) => (n <= 1 ? [] : [userMsg("do the task"), assistantMsg("answer")]) },
  });
  // 逐方法发难（handshake 后、终态前——应答器全程在位）。9001/9002 的握手期
  // 就绪由 ① 的 serverProbeDuringCreate 证；这里五个在册方法 + 一个未知方法齐发。
  peer.serverRequest(9001, "session/requestRuntimePreferences", {});
  peer.serverRequest(9002, "interaction/requestOfficialMcpAuthHeaders", {});
  peer.serverRequest(9003, "interaction/requestUserInput", { prompt: "approve?" });
  peer.serverRequest(9004, "interaction/requestPermission", { toolName: "Bash" });
  peer.serverRequest(9005, "interaction/requestProviderRuntimeHeaders", {});
  peer.serverRequest(9006, "automation/create", { prompt: "cron" });
  const answered = await waitUntil(
    () => [9001, 9002, 9003, 9004, 9005, 9006].every(
      (id) => peer.clientFrames.some((f) => f.id === id && (f.result !== undefined || f.error !== undefined)),
    ),
    2000,
  );
  assert.ok(answered, "六个 server 请求全部被应答（不留悬挂的服务端等待）");
  const answerOf = (id) => peer.clientFrames.find((f) => f.id === id);
  // 模拟上游校验：必填字段在场（UPSTREAM_RESULT_VALIDATORS = bundle schema 复刻）。
  for (const [method, id] of [
    ["session/requestRuntimePreferences", 9001],
    ["interaction/requestUserInput", 9003],
    ["interaction/requestPermission", 9004],
    ["interaction/requestProviderRuntimeHeaders", 9005],
  ]) {
    const answer = answerOf(id);
    assert.ok(answer, `${method} 被应答`);
    assert.equal(answer.error, undefined, `${method} 应答是 result 而非错误帧`);
    assert.ok(
      UPSTREAM_RESULT_VALIDATORS[method](answer.result),
      `${method} 应答过上游 schema 复刻校验（必填字段在场）：${JSON.stringify(answer.result)}`,
    );
  }
  // 语义钉：输入/权限类是**显式拒绝**——绝不自动授权。
  assert.equal(answerOf(9003).result.action, "decline", "requestUserInput → decline（无输入可用）");
  assert.equal(answerOf(9004).result.decision, "deny", "requestPermission → deny（绝不自动授权）");
  // official MCP auth：ok:false 且 reason 是 PHt 枚举成员（必填——裸 {ok:false} 过不了 OGt）。
  assert.equal(answerOf(9002).result.ok, false);
  assert.equal(answerOf(9002).result.reason, "official_auth_unavailable");
  assert.ok(
    UPSTREAM_RESULT_VALIDATORS["interaction/requestOfficialMcpAuthHeaders"](answerOf(9002).result),
    "requestOfficialMcpAuthHeaders 应答过 OGt 复刻校验",
  );
  // 未知方法（automation/create）：显式 -32601 错误帧（协议合法的 client 拒绝），
  // 绝不猜 result schema（空对象 result 会撞上未知 schema 的必填字段）。
  const unknown = answerOf(9006);
  assert.equal(unknown.error?.code, -32601, "未知 server 请求 → 显式 -32601 错误帧");
  assert.equal(unknown.result, undefined, "未知方法绝不猜 result");
  await collect(handle);
  child.kill();
});

// ===== ② create→setModel→send 请求形状 + spawn argv =====

test("zcode ②: spawn argv = node <zcode.cjs> app-server；create/setModel/send 请求形状逐字段", async () => {
  const agent = makeAgent({ reasoning: { effort: "high" } });
  const { peer, spawnCalls, handle, child } = await runScenario({
    agent,
    task: { prompt: "do the task", roleContract: "ROLE CONTRACT" },
    peerOptions: { messages: (n) => (n <= 1 ? [] : [userMsg("ROLE CONTRACT" + ZCODE_ROLE_TASK_SEPARATOR + "do the task"), assistantMsg("answer")]) },
  });
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].binary, process.execPath, "zcode.cjs 是 node 脚本——必须经 node 入口跑");
  assert.deepEqual(spawnCalls[0].args, [agent.binary, "app-server"]);
  assert.equal(spawnCalls[0].opts.cwd, agent.cwd, "进程式家族：cwd = agent.cwd");
  assert.equal(spawnCalls[0].opts.env.WAO_TARGET_CWD, agent.cwd);

  const create = peer.framesOf("session/create")[0];
  assert.deepEqual(
    create.params,
    { workspace: { workspacePath: agent.cwd, workspaceKey: "wao-coder_zcode" } },
  );
  const setModel = peer.framesOf("session/setModel")[0];
  assert.deepEqual(
    setModel.params,
    {
      sessionId: SESSION_ID,
      model: { providerId: "bigmodel-api", modelId: "GLM-5.3", options: { reasoningLevel: "high" } },
    },
    "ref 拆分直传 + effort→options.reasoningLevel（live 验证形状）",
  );
  const sent = peer.framesOf("session/send")[0];
  assert.deepEqual(
    sent.params,
    { sessionId: SESSION_ID, content: "ROLE CONTRACT" + ZCODE_ROLE_TASK_SEPARATOR + "do the task" },
    "角色合同拼前缀恰好一次（prompt 级通道）",
  );
  const events = await collect(handle);
  assert.equal(events.at(-1).reason, "completed");
  child.kill();
});

test("zcode ②b: effort 缺省不传 options（部分模型缺 reasoningLevel 才报错——配了才发）", async () => {
  const { peer, handle, child } = await runScenario({
    peerOptions: { messages: (n) => (n <= 1 ? [] : [userMsg("do the task"), assistantMsg("answer")]) },
  });
  const setModel = peer.framesOf("session/setModel")[0];
  assert.deepEqual(
    setModel.params.model,
    { providerId: "bigmodel-api", modelId: "GLM-5.3" },
    "无 options 键",
  );
  await collect(handle);
  child.kill();
});

test("zcode ②c: setModel 上游 zod 教学错误如实透传（code/data.name/message 固定形状）；失败清理走注入 killFn", async () => {
  const child = makeFakeChild();
  const kill = fakeKill();
  const backend = new ZcodeBackend({ spawnFn: () => child, killFn: kill.killFn });
  fakeZcodePeer(child, {
    setModelError: { code: -32001, data: { name: "ZodError" }, message: "Reasoning level is required" },
  });
  await assert.rejects(
    () => backend.spawn(makeAgent(), { prompt: "x" }),
    /zcode session\/setModel failed \(code -32001, ZodError\): Reasoning level is required/,
  );
  // #3：失败清理路径的击杀必须是注入 fake（v2 此处漏注 killFn——默认 killFn 会在
  // 测试里真跑 taskkill）。
  assert.equal(kill.calls.length, 1, "半握手进程经注入 killFn 回收");
});

// ===== ③ 模型 ref 拆分 + policy 拒绝分支 =====

test("zcode ③: splitZcodeModelRef 恰好一个 '/' 且两段非空", () => {
  assert.deepEqual(splitZcodeModelRef("bigmodel-api/GLM-5.3"), { providerId: "bigmodel-api", modelId: "GLM-5.3" });
  assert.deepEqual(splitZcodeModelRef("bigmodel-api/GLM-5.3-Flash"), { providerId: "bigmodel-api", modelId: "GLM-5.3-Flash" });
  for (const bad of ["GLM-5.3", "", null, undefined, "a/b/c", "/b", "a/", 42]) {
    assert.equal(splitZcodeModelRef(bad), null, `非 ref 形状必须 null：${String(bad)}`);
  }
});

test("zcode ③b: validateAgentPolicy 全拒绝分支 + 通过分支", () => {
  // #3：纯 policy 判定不经 kill 路径，killFn 仍照注入（守卫 ⑪ 钉全部构造处）。
  const backend = new ZcodeBackend({ killFn: fakeKill().killFn });
  assert.doesNotThrow(() => backend.validateAgentPolicy(makeAgent()));
  assert.doesNotThrow(() => backend.validateAgentPolicy(makeAgent({ reasoning: { effort: "max" } })));
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ model: undefined })), /native ref shape/);
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ model: { id: "GLM-5.3" } })), /native ref shape/);
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ model: { id: "a/b/c" } })), /native ref shape/);
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ model: { id: "bigmodel-api/GLM-5.3", contextWindow: 1000000 } })), /contextWindow/);
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ model: { id: "bigmodel-api/GLM-5.3", providerID: "x" } })), /providerID\/model.variant/);
  assert.throws(() => backend.validateAgentPolicy(makeAgent({
    provider: { protocol: "anthropic-compatible", baseUrl: "https://x.invalid", apiKeyEnv: "K" },
  })), /cannot express provider/);
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ args: ["--yolo"] })), /agent\.args/);
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ prependArgs: ["x.js"] })), /prependArgs/);
});

test("zcode ③c: 能力快照与类声明一致（六轴）", () => {
  assert.ok(backendFor({ backend: "zcode" }) instanceof ZcodeBackend);
  assert.deepEqual(
    backendCapabilitySnapshot({ backend: "zcode" }),
    {
      supportsRoleContract: true,
      supportsSessionReuse: true,
      supportsInFlightCorrection: false,
      replayByRespawn: true,
      reportsTokenUsage: true,
      reportsCommandExitCode: false,
    },
  );
});

// ===== ④ 完成判定（step-finish stop / error）与发射序列 =====

test("zcode ④: step-finish(stop) → user echo + assistant text + metrics + done(completed)", async () => {
  const { peer, handle, child } = await runScenario({
    peerOptions: {
      messages: (n) => (n <= 1
        ? []
        : [userMsg("do the task"), assistantMsg("chunk one "), { role: "assistant", parts: [{ type: "text", text: "chunk two" }, { type: "step-finish", reason: "stop", tokens: {} }] }]),
    },
  });
  const events = await collect(handle);
  const messages = events.filter((e) => e.kind === "message");
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].parts[0].text, "do the task", "user echo = 发送的 content 原文");
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].parts[0].text, "chunk one chunk two", "text parts 按序拼接（跨消息）");
  const metrics = events.filter((e) => e.kind === "metrics");
  assert.equal(metrics.length, 1);
  assert.deepEqual(
    metrics[0].tokens,
    { input: 60, output: 30, reasoning: 5, cacheRead: 4, cacheWrite: 2 },
    "分量 1:1 映射（上游字段 cacheReadTokens/cacheCreationTokens——zcode.cjs:15259；totalTokens 合计不重复计；modelRequestCount 无轴）",
  );
  const done = events.at(-1);
  assert.equal(done.kind, "done");
  assert.equal(done.reason, "completed");
  assert.equal(peer.framesOf("session/usage").length, 1, "usage 恰取一次");
  child.kill();
});

test("zcode ④b: 中间 step-finish(非 stop|error) 不算完成；step-finish(error) → done(failed)", async () => {
  // 轮内多 step：中间 step-finish（如 tool 轮）reason 不在闭集 → 继续等。
  const progressing = (n) => {
    if (n <= 1) return [];
    if (n === 2) return [userMsg("do the task"), { role: "assistant", parts: [{ type: "text", text: "partial" }, { type: "step-finish", reason: "tool-use", tokens: {} }] }];
    return [
      userMsg("do the task"),
      { role: "assistant", parts: [{ type: "text", text: "partial" }, { type: "step-finish", reason: "tool-use", tokens: {} }] },
      assistantMsg("final", "stop"),
    ];
  };
  const { handle, child } = await runScenario({ peerOptions: { messages: progressing } });
  const events = await collect(handle);
  assert.equal(events.at(-1).reason, "completed");
  assert.equal(events.filter((e) => e.kind === "message" && e.role === "assistant").length, 1);
  child.kill();

  // step-finish(error) → done(failed)（固定文案——该 part 未实证携带错误明细）。
  const failed = await runScenario({
    peerOptions: { messages: (n) => (n <= 1 ? [] : [userMsg("do the task"), assistantMsg("boom", "error")]) },
  });
  const failedEvents = await collect(failed.handle);
  const done = failedEvents.at(-1);
  assert.equal(done.reason, "failed");
  assert.match(done.error, /step-finish reason error/);
  assert.equal(failedEvents.filter((e) => e.kind === "message" && e.role === "assistant").length, 0, "失败轮零 assistant 投影");
  failed.child.kill();
});

// ===== ⑤ 发射前非空复检（N1）与 usage 缺席 =====

test("zcode ⑤: completed 轮无 assistant 文本 → done(failed)，绝不伪造完成", async () => {
  // 只有 user 回显 + step-finish(stop)：回显剔除后为空 → N1 收口。
  const { handle, child } = await runScenario({
    peerOptions: {
      messages: (n) => (n <= 1 ? [] : [userMsg("do the task"), { role: "assistant", parts: [{ type: "step-finish", reason: "stop", tokens: {} }] }]),
    },
  });
  const events = await collect(handle);
  const done = events.at(-1);
  assert.equal(done.reason, "failed");
  assert.match(done.error, /without assistant text/);
  assert.equal(events.filter((e) => e.kind === "message").length, 0, "零消息发射（含 user echo）");
  child.kill();
});

test("zcode ⑤b: usage 全分量缺席 → 无 metrics 事件（绝不虚构零值通道）", async () => {
  const { handle, child } = await runScenario({
    peerOptions: {
      usage: { totalTokens: 0, modelRequestCount: 1 },
      messages: (n) => (n <= 1 ? [] : [userMsg("do the task"), assistantMsg("answer")]),
    },
  });
  const events = await collect(handle);
  assert.equal(events.at(-1).reason, "completed");
  assert.equal(events.filter((e) => e.kind === "metrics").length, 0);
  child.kill();
});

// ===== ⑥ stalled 兜底 / silentTimeout 分工 =====

test("zcode ⑥: 连续 8 拍无新 part → done(failed, turn stalled)", async () => {
  // 第 2 拍出现 user 回显（进展一次），此后恒不变 → 8 拍无进展收口。
  const { handle, child } = await runScenario({
    peerOptions: { messages: (n) => (n <= 2 ? [] : [userMsg("do the task")]) },
  });
  const events = await collect(handle);
  const done = events.at(-1);
  assert.equal(done.reason, "failed");
  assert.match(done.error, /turn stalled/);
  child.kill();
});

test("zcode ⑥b: silentTimeout 在场且零新 part → 只以 silentTimeout 为界（8 拍兜底不抢先）", async () => {
  const { handle, child } = await runScenario({
    peerOptions: { messages: () => [] },
  });
  const events = await collect(handle, { pollInterval: 5, silentTimeout: 120 });
  const done = events.at(-1);
  assert.equal(done.reason, "failed");
  assert.match(done.error, /silent timeout/, "无 turn 等待的上界是 silentTimeout，不是 8 拍");
  child.kill();
});

// ===== ⑦ 通信失败 = 进程死 =====

test("zcode ⑦: 轮询中进程死 → done(failed, transport closed)", async () => {
  const { child, handle } = await runScenario({
    peerOptions: { messages: () => [userMsg("do the task")] },
  });
  const collectPromise = collect(handle);
  child.end(1);
  const events = await collectPromise;
  const done = events.at(-1);
  assert.equal(done.reason, "failed");
  assert.match(done.error, /transport closed/);
});

test("zcode ⑦b: spawn 握手期进程死 → spawn 上抛（transport closed）；失败清理走注入 killFn", async () => {
  const child = makeFakeChild();
  const kill = fakeKill();
  const backend = new ZcodeBackend({ spawnFn: () => child, killFn: kill.killFn });
  const peer = fakeZcodePeer(child, { hangCreate: true, messages: () => [] });
  const spawnPromise = backend.spawn(makeAgent(), { prompt: "x" });
  assert.ok(await waitUntil(() => peer.framesOf("session/create").length === 1));
  child.end(1);
  await assert.rejects(() => spawnPromise, /transport closed/);
  // #3：killFn 照注入（守卫 ⑪ 钉全部构造处）。此处进程在失败清理前已死
  // （child.end 置 exitCode）——_kill 对已退出进程是幂等 no-op，killFn 不被调用
  // 是正确行为（绝不对已死 pid 启动树杀）。
  assert.equal(kill.calls.length, 0, "进程已死：失败清理是幂等 no-op（killFn 零调用）");
});

test("zcode ⑦c: session/messages 响应缺 messages 数组 → fail-closed（spawn 基线 + 轮询两处）", async () => {
  const child = makeFakeChild();
  const kill = fakeKill();
  const backend = new ZcodeBackend({ spawnFn: () => child, killFn: kill.killFn });
  const lines = readline.createInterface({ input: child.stdin });
  lines.on("line", (line) => {
    const frame = JSON.parse(line);
    if (frame.method === "session/create") {
      child.stdout.write(JSON.stringify({ id: frame.id, result: { session: { sessionId: SESSION_ID } } }) + "\n");
      return;
    }
    if (frame.method === "session/setModel") {
      child.stdout.write(JSON.stringify({ id: frame.id, result: {} }) + "\n");
      return;
    }
    // 基线 messages 响应缺 messages 数组。
    child.stdout.write(JSON.stringify({ id: frame.id, result: {} }) + "\n");
  });
  await assert.rejects(
    () => backend.spawn(makeAgent(), { prompt: "x" }),
    /session\/messages response malformed/,
  );
});

test("zcode ⑦d: stdout 非 JSON 行 → 协议破裂 done(failed)（fail-closed，不静默吞）", async () => {
  const { child, handle } = await runScenario({
    peerOptions: { messages: () => [userMsg("do the task")] },
  });
  const collectPromise = collect(handle);
  child.stdout.write("this is not json\n");
  const events = await collectPromise;
  const done = events.at(-1);
  assert.equal(done.reason, "failed");
  assert.match(done.error, /non-JSON stdout line/);
});

// ===== ⑧ abort：session/stop + 树杀两层（auditor #4：幂等/诚实措辞/传输已关不抛） =====

test("zcode ⑧: abort 调 session/stop {sessionId}；失败腿抛固定错误（措辞只声明「树杀已启动」）", async () => {
  const ok = await runScenario({ peerOptions: { messages: () => [userMsg("do the task")] } });
  await ok.handle.abort();
  const stops = ok.peer.framesOf("session/stop");
  assert.equal(stops.length, 1, "abort 恰发一次 session/stop");
  assert.deepEqual(stops[0].params, { sessionId: SESSION_ID });
  assert.notEqual(ok.child.exitCode, null, "注入 killFn 被调用（fake kill 置 exitCode）");
  // stop 请求绝不带 jsonrpc；应答帧（result）不是请求。
  assert.equal(Object.hasOwn(stops[0], "jsonrpc"), false);

  const failing = await runScenario({
    peerOptions: {
      messages: () => [userMsg("do the task")],
      stopError: { code: -32000, message: "unknown shape" },
    },
  });
  await assert.rejects(
    () => failing.handle.abort(),
    /zcode abort: session\/stop failed.*launched as the backstop \(launching the kill is not a verified kill/,
    "#4② 诚实措辞：taskkill 启动 ≠ 树杀成功——检查退出码前不得断言 killed",
  );
  assert.notEqual(failing.child.exitCode, null, "stop 失败也启动树杀（注入 killFn 观察到）");
});

test("zcode ⑧b: abort 幂等——共享 Promise 复用首次结果，二次调用不重发 stop、拒绝原样重放", async () => {
  const ok = await runScenario({ peerOptions: { messages: () => [userMsg("do the task")] } });
  const p1 = ok.handle.abort();
  const p2 = ok.handle.abort();
  assert.equal(p1, p2, "二次调用返回同一共享 Promise（#4①）");
  await p1;
  await p2;
  assert.equal(ok.peer.framesOf("session/stop").length, 1, "两次调用只发一次 session/stop");
  assert.equal(ok.killCalls.length, 1, "两次调用只杀一次树（注入 killFn 计数）");

  // 失败腿同样幂等：首次的拒绝原样重放（同一 Error 实例），不重发 stop、不再杀树。
  const failing = await runScenario({
    peerOptions: {
      messages: () => [userMsg("do the task")],
      stopError: { code: -32000, message: "unknown shape" },
    },
  });
  const err1 = await failing.handle.abort().then(() => null, (e) => e);
  const err2 = await failing.handle.abort().then(() => null, (e) => e);
  assert.ok(err1 instanceof Error, "首次 abort 拒绝（stop 失败如实上抛）");
  assert.equal(err1, err2, "二次调用复用首次的拒绝（同 Error 实例）");
  assert.equal(failing.peer.framesOf("session/stop").length, 1, "失败腿也只发一次 stop");
  assert.equal(failing.killCalls.length, 1, "失败腿也只杀一次树");
});

test("zcode ⑧c: 传输已关（进程死）后 abort 不抛、不发 stop——无可停止物（#4①）", async () => {
  const scenario = await runScenario({
    peerOptions: { messages: () => [userMsg("do the task")] },
  });
  // 终态前杀进程（模拟 RunManager 侧 signal 先杀——abort() 的 stop 仅在进程仍活
  // 时可达，两层语义见 zcode.js abort 注释）。
  scenario.child.end(1);
  await assert.doesNotReject(() => scenario.handle.abort(), "传输已关：不试 stop、不抛");
  await assert.doesNotReject(() => scenario.handle.abort(), "幂等复用同一（已 resolve 的）结果");
  assert.equal(scenario.peer.framesOf("session/stop").length, 0, "进程已死，stop 无人应答——绝不发");
});

test("zcode ⑧d: 状态面穷举——终态后 abort 幂等 no-op；协议破裂（fatal 但进程活）如实上抛", async () => {
  // 状态 1：终态已发射（completed 轮回收完毕）——abort 是幂等 no-op，不发 stop。
  const done1 = await runScenario({
    peerOptions: { messages: (n) => (n <= 1 ? [] : [userMsg("do the task"), assistantMsg("answer")]) },
  });
  const events = await collect(done1.handle);
  assert.equal(events.at(-1).reason, "completed");
  await assert.doesNotReject(() => done1.handle.abort(), "终态后 abort = no-op（进程已回收）");
  assert.equal(done1.peer.framesOf("session/stop").length, 0, "终态后绝不发 stop");

  // 状态 2：协议破裂（fatalError 置位）但进程仍活、终态未发射——stop 请求被 fatal
  // 短路拒绝，如实上抛固定错误且树杀仍被启动（诚实措辞：启动 ≠ 树杀成功）。
  const fatal = await runScenario({
    peerOptions: { messages: () => [userMsg("do the task")] },
  });
  fatal.child.stdout.write("this is not json\n");
  await assert.rejects(
    () => fatal.handle.abort(),
    /zcode abort: session\/stop failed.*launched as the backstop/,
    "fatal-but-alive：stop 不可达，失败如实上抛 + 树杀已启动",
  );
  assert.equal(fatal.killCalls.length, 1, "树杀仍被启动（注入 killFn 观察到）");
});

// ===== ⑨ resume 轮：先装载（session/resume）再 setModel→send（auditor #1）=====

const RESUME_ROUTING = {
  mode: "lead_workspace",
  opaqueUuid: "00000000-0000-4000-8000-000000000000",
  turn: "resume",
  priorRunId: "run_20261001000000000aaaaa",
};

// resume 场景的历史：含 assistant+step-finish(stop)——历史尾部即是一个"完成形状"，
// 任何以历史 stop 判完成的实现都会在这里误报（⑨/⑨c 的基线正确性证明用）。
const RESUME_HISTORY = [userMsg("old question"), assistantMsg("old answer")];

test("zcode ⑨: resume 轮不 create，先 session/resume 装载 → setModel → send（次序固定）", async () => {
  const prior = "sess_prior_run_1";
  const { peer, handle, child } = await runScenario({
    task: { prompt: "continue", sessionReuse: RESUME_ROUTING, priorProviderSessionId: prior },
    peerOptions: {
      messages: (n) => (n <= 1
        ? RESUME_HISTORY
        : [...RESUME_HISTORY, userMsg("continue"), assistantMsg("answer")]),
    },
  });
  assert.equal(peer.framesOf("session/create").length, 0, "resume 轮绝不 create");
  // #1 次序链：resume 先于 setModel 先于 send（上游会话表每进程一张，zcode.cjs:
  // 15262；setModel 走 requireSession——15256 QKo→15245 Xy，未装载必抛
  // "Session is not active"）。
  const resume = peer.framesOf("session/resume")[0];
  assert.ok(resume, "resume 轮必须先发 session/resume");
  assert.deepEqual(resume.params, { sessionId: prior }, "resume params = 前任 sess_ id（rGt：sessionId 必填，zcode.cjs:72）");
  const indexOf = (method) => peer.clientFrames.findIndex((f) => f.method === method);
  assert.ok(indexOf("session/resume") < indexOf("session/setModel"), "resume 先于 setModel");
  assert.ok(indexOf("session/setModel") < indexOf("session/send"), "setModel 先于 send");
  const setModel = peer.framesOf("session/setModel")[0];
  assert.equal(setModel.params.sessionId, prior, "setModel 作用于前任会话（配置模型每次派发生效）");
  assert.deepEqual(peer.framesOf("session/send")[0].params, { sessionId: prior, content: "continue" });
  // 基线含历史（含历史 step-finish(stop)）：完成判定只认基线之后的 parts——历史
  // 文本/stop 永不重放。
  assert.equal(handle.backendSessionId, prior, "resume 轮 backendSessionId = 前任 native id");
  const events = await collect(handle);
  assert.equal(events.at(-1).reason, "completed");
  const assistant = events.filter((e) => e.kind === "message" && e.role === "assistant");
  assert.equal(assistant[0].parts[0].text, "answer", "只投影本轮 answer——历史 old answer 不重放");
  child.kill();
});

test("zcode ⑨b: resume 轮 prior id 缺失/占位 → 派发前拒绝（spawn + preflight 双拒绝点）", async () => {
  const child = makeFakeChild();
  const spawnCalls = [];
  const backend = new ZcodeBackend({
    spawnFn: (binary, args, opts) => {
      spawnCalls.push({ binary, args, opts });
      return child;
    },
    killFn: fakeKill().killFn,
  });
  for (const bad of [undefined, "", "proc_424243"]) {
    await assert.rejects(
      () => backend.spawn(makeAgent(), {
        prompt: "x",
        sessionReuse: { ...RESUME_ROUTING },
        ...(bad === undefined ? {} : { priorProviderSessionId: bad }),
      }),
      /prior provider session id.*refusing instead of silently starting a fresh zcode conversation/s,
      `spawn 拒绝：${String(bad)}`,
    );
    await assert.rejects(
      () => backend.preflightInvocation(makeAgent(), {
        prompt: "x",
        sessionReuse: { ...RESUME_ROUTING },
        ...(bad === undefined ? {} : { priorProviderSessionId: bad }),
      }),
      /prior provider session id/,
      `preflight 拒绝：${String(bad)}`,
    );
  }
  // backend-owned 纯判定钩子：占位恒 false、native id 恒 true（TD188 形状）。
  assert.equal(backend.canResumeWithRecoveredSessionId("proc_424243"), false);
  assert.equal(backend.canResumeWithRecoveredSessionId("sess_ok"), true);
  assert.equal(backend.canResumeWithRecoveredSessionId(""), false);
  // 预检先于进程创建：拒绝路径上零 spawn（绝不先起 app-server 再拒绝）。
  assert.equal(spawnCalls.length, 0, "prior id 拒绝发生在 spawn 之前");
});

// auditor 完成判据反例：历史含 assistant+step-finish(stop) 的 resume 会话、新轮
// prompt 已发但新轮 parts 未现——**不得以历史 stop 判完成**（基线=历史长度切片的
// 正确性证明：历史 stop 的序号必 < baselineParts，判据的 >= 守卫必须挡住它）。
test("zcode ⑨c: 反例——历史尾部 step-finish(stop) + 新轮无新 part ≠ 完成（有界收口，零误报）", async () => {
  const { handle, child, peer } = await runScenario({
    task: { prompt: "continue", sessionReuse: RESUME_ROUTING, priorProviderSessionId: "sess_prior_run_1" },
    peerOptions: {
      // 恒定历史（含尾部 stop）：新轮 prompt 已发（send accepted）但新轮 parts 永不出现。
      messages: () => RESUME_HISTORY,
    },
  });
  assert.equal(peer.framesOf("session/send").length, 1, "新轮 prompt 已发出且被接受");
  const events = await collect(handle);
  const done = events.at(-1);
  assert.equal(done.kind, "done");
  assert.equal(done.reason, "failed", "绝不 completed——历史 stop 不是本轮完成信号");
  assert.match(done.error, /turn stalled|silent timeout/, "由无进展/静默兜底有界收口");
  assert.equal(
    events.filter((e) => e.kind === "message").length, 0,
    "零消息发射——历史 old answer 绝不被当作本轮 assistant 产出",
  );
  child.kill();
});

// auditor #1 的直接钉：fake 对端有状态——未经 create/resume 注册的 sessionId 上
// setModel 必失败（"Session is not active"，zcode.cjs:15245 形状）。v2 的（错误的）
// "复用 id 直发 setModel" 序列撞上真上游就是这个形状——本测试用不经 backend 的
// 手动 wire 驱动把它钉成回归防线（若有人删掉 spawn 里的 session/resume，⑨ 会在
// 本形状上变红，这里则直接证明 fake 能看见它）。
test("zcode ⑨d: fake 对端有状态——未装载的 sessionId 上 setModel 即「Session is not active」（v2 漏检形状）", async () => {
  const child = makeFakeChild();
  fakeZcodePeer(child, {});
  const replies = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => replies.push(JSON.parse(line)));
  // 模拟 v2 的直发序列：跳过 session/resume，直接对未注册 id 发 setModel。
  child.stdin.write(JSON.stringify({
    id: 1,
    method: "session/setModel",
    params: { sessionId: "sess_never_loaded", model: { providerId: "bigmodel-api", modelId: "GLM-5.3" } },
  }) + "\n");
  assert.ok(await waitUntil(() => replies.some((f) => f.id === 1 && f.error)));
  const reply = replies.find((f) => f.id === 1);
  assert.match(reply.error.message, /Session is not active: sess_never_loaded/);
});

test("zcode ⑨e: resume 帧失败 → fail-closed 拒绝派发（固定错误），绝不带病 setModel/send", async () => {
  const child = makeFakeChild();
  const kill = fakeKill();
  const backend = new ZcodeBackend({ spawnFn: () => child, killFn: kill.killFn });
  const prior = "sess_prior_run_1";
  const peer = fakeZcodePeer(child, {
    resumeError: { code: -32009, data: { name: "ProtocolRequestError" }, message: `Session not found: ${prior}` },
  });
  await assert.rejects(
    () => backend.spawn(makeAgent(), {
      prompt: "continue",
      sessionReuse: RESUME_ROUTING,
      priorProviderSessionId: prior,
    }),
    /zcode session\/resume failed \(code -32009, ProtocolRequestError\): Session not found/,
    "resume 错误帧如实上抛（上游 wRn 装载 miss 的真实形状，zcode.cjs:15256）",
  );
  assert.equal(peer.framesOf("session/setModel").length, 0, "resume 失败后绝不 setModel");
  assert.equal(peer.framesOf("session/send").length, 0, "resume 失败后绝不 send");
  assert.equal(kill.calls.length, 1, "半握手进程经注入 killFn 回收");
});

test("zcode ⑨f: resume 响应未知形状 → fail-closed 拒绝派发（固定错误，绝不猜）", async () => {
  const child = makeFakeChild();
  const kill = fakeKill();
  const backend = new ZcodeBackend({ spawnFn: () => child, killFn: kill.killFn });
  const prior = "sess_prior_run_1";
  const peer = fakeZcodePeer(child, { resumeResult: {} });
  await assert.rejects(
    () => backend.spawn(makeAgent(), {
      prompt: "continue",
      sessionReuse: RESUME_ROUTING,
      priorProviderSessionId: prior,
    }),
    /zcode session\/resume returned an unexpected shape \(expected result\.session\.sessionId/,
  );
  assert.equal(peer.framesOf("session/setModel").length, 0);
  assert.equal(kill.calls.length, 1, "半握手进程经注入 killFn 回收");
});

// 第四轮 auditor P3：resume 应答携带**不同但非空**的 sessionId（sess_other）——
// 上游装载的会话与请求恢复的会话身份不一致。此时 fail-closed 拒绝派发（固定
// 错误），绝不改用返回的新 id、绝不带病 setModel/send、绝不回落新会话。
test("zcode ⑨g: resume 返回不同但非空的 sessionId → fail-closed 拒绝派发（身份不匹配），零 setModel/send", async () => {
  const child = makeFakeChild();
  const kill = fakeKill();
  const backend = new ZcodeBackend({ spawnFn: () => child, killFn: kill.killFn });
  const prior = "sess_prior_run_1";
  const peer = fakeZcodePeer(child, { resumeResult: { session: { sessionId: "sess_other" } } });
  await assert.rejects(
    () => backend.spawn(makeAgent(), {
      prompt: "continue",
      sessionReuse: RESUME_ROUTING,
      priorProviderSessionId: prior,
    }),
    /zcode session\/resume returned an unexpected shape \(expected result\.session\.sessionId === "sess_prior_run_1", got "sess_other" — refusing to guess\)/,
    "resume 应答 id ≠ 请求 id = 身份不匹配——固定错误拒绝，绝不猜、绝不改用返回的新 id",
  );
  assert.equal(peer.framesOf("session/setModel").length, 0, "身份不匹配：绝不 setModel");
  assert.equal(peer.framesOf("session/send").length, 0, "身份不匹配：绝不 send");
  assert.equal(peer.framesOf("session/create").length, 0, "绝不回落新会话");
  assert.equal(kill.calls.length, 1, "半握手进程经注入 killFn 回收");
});

// ===== ⑩ registry zcode 分支 + ref 形状互钉 =====

test("zcode ⑩: normalizeAgent zcode 分支（binary 绝对路径必填 + model.id ref 形状）", () => {
  const base = { backend: "zcode", cwd: "D:/proj" };
  const valid = normalizeAgent("coder_zcode", {
    ...base,
    binary: "D:/tools/zcode.cjs",
    model: { id: "bigmodel-api/GLM-5.3-Flash" },
  });
  assert.equal(valid.backend, "zcode");
  assert.throws(() => normalizeAgent("coder_zcode", { ...base, model: { id: "bigmodel-api/GLM-5.3" } }),
    /zcode requires binary/);
  assert.throws(() => normalizeAgent("coder_zcode", { ...base, binary: "zcode.cjs", model: { id: "bigmodel-api/GLM-5.3" } }),
    /absolute path/, "相对路径拒绝（桌面更新会漂移——必须显式绝对路径）");
  assert.throws(() => normalizeAgent("coder_zcode", { ...base, binary: "D:/tools/zcode.cjs" }),
    /missing model\.id/);
  // ref 形状与 backend 的 splitZcodeModelRef 互钉（core 不 import backends，两处
  // 独立实现——形状漂移在此变红）。
  for (const id of ["GLM-5.3", "a/b/c", "/b", "a/", "bigmodel-api/GLM-5.3/extra"]) {
    assert.equal(splitZcodeModelRef(id), null, `backend 拆分拒绝：${id}`);
    assert.throws(
      () => normalizeAgent("coder_zcode", { ...base, binary: "D:/tools/zcode.cjs", model: { id } }),
      /native ref shape/,
      `registry 同形状拒绝：${id}`,
    );
  }
});

test("zcode ⑩b: preflightInvocation 预算预检（node <binary> app-server 的 compile 形状）", async () => {
  // #3：纯预检不经 kill 路径，killFn 仍照注入（守卫 ⑪ 钉全部构造处）。
  const backend = new ZcodeBackend({ platform: "win32", killFn: fakeKill().killFn });
  const compiled = await backend.preflightInvocation(makeAgent(), { prompt: "x" });
  assert.equal(compiled.binary, process.execPath);
  assert.deepEqual(compiled.args, [makeAgent().binary, "app-server"]);
  assert.equal(compiled.windowsVerbatimArguments, false, "node .exe 无 cmd 包裹");
  await assert.rejects(
    () => backend.preflightInvocation(makeAgent({ binary: undefined }), { prompt: "x" }),
    /requires agent\.binary/,
  );
});

// ===== ⑪ 真杀隔离守卫（auditor #3）：全部构造处必须注入 killFn =====
//
// 默认 killFn 是真 taskkill（defaultTreeKill spawn 一个真实 taskkill 进程）——测试
// 中绝不允许执行（v2 在 ②c/⑦b/⑦c 三处漏注，失败清理路径曾真跑 taskkill）。本守卫
// 对本文件自身源码做静态扫描：每一处构造表达式的实参块都必须含 killFn 注入。
//
// v4（auditor P2）三处加固：
//   - ②a 构造识别改正则（含空格/换行变体——v3 的 indexOf 单空格字面量识别不到
//     跨行/多空格形状）；
//   - ②b 计数与当前实际构造数**严格相等**（v3 的 >= 7 宽松下界会让"删构造"静默
//     通过）——加/删构造不更新守卫即红，这正是守卫目的；
//   - ②c killFn 检查限定在**该构造的括号范围**内（从构造的 `(` 起配平圈出实参块，
//     块内命中才算注入——别的构造块/无关文本里的 killFn 不算数），扫描器独立成
//     函数供 ⑪b 负例直接驱动。
// 自扫描安全性：识别正则以字面量书写——模式文本里 "new" 后随反斜杠（\s）而非
// 空白，扫描不会命中自己；⑪b 的样本串运行时拼装（join），源码无字面邻接。
function scanZcodeConstructions(source) {
  const CTOR_RE = /new\s+ZcodeBackend\s*\(/g;
  const constructions = [];
  const violations = [];
  for (let match = CTOR_RE.exec(source); match !== null; match = CTOR_RE.exec(source)) {
    // 括号配平：match[0] 已含构造自己的 `(`——从其后起 depth=1 配平到闭括号，
    // 圈出该构造的实参块（含 new 表达式与外侧括号）。
    let depth = 1;
    let end = match.index + match[0].length;
    while (end < source.length && depth > 0) {
      const ch = source[end];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      end += 1;
    }
    const block = source.slice(match.index, end);
    constructions.push(block);
    // P2②c：killFn 必须出现在**该构造的括号范围内**（实参块内文本命中）。
    if (!/killFn\s*:/.test(block)) violations.push(block);
  }
  return { constructions, violations };
}

test("zcode ⑪: 真杀隔离守卫——本文件全部构造处均注入 killFn（正则识别 + 计数严格相等 + 块级检查）", () => {
  const source = readFileSync(new URL(import.meta.url), "utf8");
  const { constructions, violations } = scanZcodeConstructions(source);
  // P2②b：严格相等。当前实际 = 10 处：runScenario / ②c / ③b / ⑦b / ⑦c / ⑨b /
  // ⑨e / ⑨f / ⑨g / ⑩b。加/删构造必须同步更新此数字——不更新即红。
  assert.equal(
    constructions.length,
    10,
    `守卫扫描应找到恰 10 处构造（runScenario/②c/③b/⑦b/⑦c/⑨b/⑨e/⑨f/⑨g/⑩b），实际 ${constructions.length}——加/删构造必须同步更新守卫计数（扫描器失效即守卫空转）`,
  );
  assert.deepEqual(
    violations,
    [],
    "每个构造的实参块内必须显式注入 killFn（默认 killFn = 真 taskkill，测试中绝不执行）",
  );
});

// P2②c 负例：守卫的判红路径必须可验证（扫描器独立可调用，直接喂样本串断言变红
// ——不经真实源码，负例形状可精确控制）。样本串运行时拼装，源码无字面邻接。
test("zcode ⑪b: 守卫负例——无 killFn 构造判红；跨块文本命中不算注入；空格/换行变体仍可识别", () => {
  const CTOR = ["new", "ZcodeBackend"].join(" ");
  // 负例 1：实参块内无 killFn → 判红。
  const bad1 = `const b = ${CTOR}({ spawnFn: () => child });`;
  // 负例 2：killFn 文本出现在**另一构造**的实参块内——被测构造仍判红
  // （violations 恰为缺 killFn 的一块；注入到位的一块不误伤）。
  const bad2 = [
    `const a = ${CTOR}({ spawnFn: () => child, killFn: fakeKill().killFn });`,
    `const b = ${CTOR}({ spawnFn: () => child });`,
  ].join("\n");
  // 负例 3（P2②a）：跨行变体——v3 的 indexOf 单空格字面量识别不到，正则必须
  // 识别且同样判红。
  const bad3 = `const b = ${CTOR.split(" ").join("\n  ")}({ spawnFn: () => child });`;
  for (const [label, sample] of [["无 killFn", bad1], ["跨行变体", bad3]]) {
    const { constructions, violations } = scanZcodeConstructions(sample);
    assert.equal(constructions.length, 1, `${label}：构造被识别`);
    assert.equal(violations.length, 1, `${label}：判红（violations = 全部构造）`);
    assert.match(violations[0], /spawnFn/, `${label}：判红块即该构造实参块`);
  }
  {
    const { constructions, violations } = scanZcodeConstructions(bad2);
    assert.equal(constructions.length, 2, "两处构造都被识别");
    assert.equal(violations.length, 1, "跨块文本命中不算注入——只有缺 killFn 的一块判红");
    assert.match(violations[0], /spawnFn/, "判红的是缺 killFn 的那一块");
  }
  // 正例对照：注入到位（含多空格变体）→ 零判红，不误伤。
  const good = [
    `const a = ${CTOR}({ spawnFn: () => child, killFn: fakeKill().killFn });`,
    `const b = ${CTOR.split(" ").join("  ")}({ platform: "win32", killFn: fakeKill().killFn });`,
  ].join("\n");
  const goodScan = scanZcodeConstructions(good);
  assert.equal(goodScan.constructions.length, 2, "多空格变体构造被识别（P2②a）");
  assert.deepEqual(goodScan.violations, [], "注入齐全零判红");
});

