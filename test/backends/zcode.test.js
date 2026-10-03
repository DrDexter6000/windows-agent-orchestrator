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
// ——第三轮 auditor #5）、create→setModel→setMode(yolo)→send 请求形状（setMode
// 权限帧 + 失败 fail-closed 拒绝派发——scorecard 写拦截修复
// run_20261001213724000cy1b3a）、模型 ref 拆分、完成判定
// （step-finish stop/error）+ 历史含 stop 的 resume 反例（auditor 完成判据反例）、
// stalled 兜底（分相：已有产出后 60 拍 / 零 part 思考预算 120 拍——GLM-5.3 首
// part 延迟实证反例组 ⑥c-⑥e run_20261001195259045cle1ft；步间静默反例 ⑥f——
// 第二轮 live 诊断 run_20261001203009794bb6add，首轮 8 拍门误杀步间 reasoning）、
// tool part 证据投影（④c-④g：write→file_written / bash→command / 未知→tool_use /
// 终态→tool_result，证据先于 assistant 文本、空文本门零证据、非终态不猜——
// bundle zod schema qZe/nor 形状，F2 同族补齐 run_202610012228351231l4qsr）、
// 发射前非空复检（N1）、usage→metrics（cacheReadTokens/
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
 * （setModel/setMode/send/messages/usage/stop）查表 miss 即回 "Session is not
 * active"
 * （zcode.cjs:15245 Xy 的形状）。正是 v2 漏检形状：跳过 session/resume 直发
 * setModel 在这里必然失败（⑨d 直接钉）。
 * messages 脚本：函数 (pollCount) => messages[]（第 1 次调用 = spawn 期基线快照，
 * 其后为事件轮询拍）。
 */
function fakeZcodePeer(child, {
  sessionId = SESSION_ID,
  setModelError = null,      // {code, message} → setModel 返回错误（zod 教学形状）
  setModeError = null,       // {code, message} → setMode 返回错误（fail-closed 测试）
  accepted = true,           // session/send 的 accepted 值
  messages = () => [],       // (pollCount) => messages[]
  // 上游 CRn 实际字段名（zcode.cjs:15259）：cache 系带 Tokens 后缀（auditor #2）。
  usage = { totalTokens: 101, inputTokens: 60, outputTokens: 30, reasoningTokens: 5, cacheReadTokens: 4, cacheCreationTokens: 2, modelRequestCount: 2 },
  usageError = null,         // {code, message} → session/usage 返回错误帧（⑫g：终态后 usage 失败路径）
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
    if (frame.method === "session/setMode") {
      if (!requireActive(frame)) return;
      if (setModeError) send({ id: frame.id, error: setModeError });
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
      if (usageError) {
        send({ id: frame.id, error: usageError });
        return;
      }
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
// 步开始 part（本轮 live 实测形状：GLM-5.3 工具任务产出顺序 echo → step-start →
// 步间 reasoning 静默 → step-finish，run_20261001203009794bb6add 时间线）。完成
// 判定只认末位 step-finish，其余 part 类型一律按「新 part 进展」计（zcode.js
// _streamEvents）——step-start 正是该语义的实测载体。
const stepStartMsg = () => ({ role: "assistant", parts: [{ type: "step-start" }] });

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
  assert.ok(requests.length >= 5, "create/setModel/setMode/send(基线 messages) 至少 5 帧");
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

// ===== ② create→setModel→setMode→send 请求形状 + spawn argv =====

test("zcode ②: spawn argv = node <zcode.cjs> app-server；create/setModel/setMode/send 请求形状逐字段", async () => {
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
  // 权限模式帧（scorecard 写拦截修复 run_20261001213724000cy1b3a）：app-server 的
  // session/create 默认 build（写需许可），无人值守 worker 必须在提交前放开——
  // mode 固定 "yolo"（CLI -p 的 help 默认同款；枚举 = plan|build|edit|yolo|auto，
  // bundle schema $j）。
  const setMode = peer.framesOf("session/setMode")[0];
  assert.deepEqual(
    setMode.params,
    { sessionId: SESSION_ID, mode: "yolo" },
    "setMode 帧形状：提交前放开写许可（对齐其它席位 --dangerously-skip-permissions / permission_mode:\"auto\" 姿态）",
  );
  const indexOf = (method) => peer.clientFrames.findIndex((f) => f.method === method);
  assert.ok(indexOf("session/create") < indexOf("session/setModel"), "create 先于 setModel");
  assert.ok(indexOf("session/setModel") < indexOf("session/setMode"), "setModel 先于 setMode");
  assert.ok(indexOf("session/setMode") < indexOf("session/send"), "setMode 先于 send——次序固定 create→setModel→setMode→send");
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

// 权限模式 fail-closed（delta 认证 scorecard 修复 run_20261001213724000cy1b3a）：
// setMode 失败 = 固定错误拒绝派发——app-server 默认 build（写需许可），权限没放开
// 比派发失败更危险，绝不带病做基线快照/送 prompt。
test("zcode ②d: setMode 失败 → fail-closed 拒绝派发（固定错误），零基线快照/零 send；清理走注入 killFn", async () => {
  const child = makeFakeChild();
  const kill = fakeKill();
  const backend = new ZcodeBackend({ spawnFn: () => child, killFn: kill.killFn });
  const peer = fakeZcodePeer(child, {
    setModeError: { code: -32602, data: { name: "ProtocolRequestError" }, message: "invalid enum value" },
  });
  await assert.rejects(
    () => backend.spawn(makeAgent(), { prompt: "x" }),
    /zcode dispatch refused: session\/setMode did not succeed .*fail-closed/,
    "固定错误前缀 + 有界上游明细（abort 失败腿同款诚实措辞）",
  );
  assert.equal(peer.framesOf("session/messages").length, 0, "绝不带病做基线快照");
  assert.equal(peer.framesOf("session/send").length, 0, "权限未确认放开：绝不 send");
  assert.equal(kill.calls.length, 1, "半握手进程经注入 killFn 回收");
});

// ===== ③ 模型 ref 拆分 + policy 拒绝分支 =====

test("zcode ②e: resolveInvocationPrefix → node 入口前缀（runtimeIdentity 探测消费）；binary 缺失拒绝", async () => {
  const kill = fakeKill();
  const backend = new ZcodeBackend({ killFn: kill.killFn });
  const agent = makeAgent({});
  const prefix = await backend.resolveInvocationPrefix(agent);
  assert.equal(prefix.binary, process.execPath, "zcode.cjs 是 node 脚本——与 spawn argv 一致，必须经 node 入口");
  assert.deepEqual(prefix.args, [agent.binary]);
  await assert.rejects(
    () => backend.resolveInvocationPrefix({ ...agent, binary: "" }),
    /zcode backend requires agent\.binary/,
  );
  // 含空格路径：前缀只承载字符串（引用/转义在 compileInvocation 层），逐字保留。
  const spaced = await backend.resolveInvocationPrefix(
    makeAgent({ binary: "C:/Program Files (x86)/ZCode/resources/glm/zcode.cjs" }),
  );
  assert.deepEqual(spaced.args, ["C:/Program Files (x86)/ZCode/resources/glm/zcode.cjs"]);
});

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

// ===== ④c-④g tool part 证据投影（2026-10-01 补齐——delta 认证证据链，kimi-web
// F2 同族：模型真写了文件但 WAO 无 file_written 事件，hasEvidence 误红）。tool
// part 形状 = bundle zod schema（zcode.cjs:72 qZe/nor）的最小复刻——测试驱动与
// src/backends/zcode.js 投影实现的同一形状依据（详见该函数注释）。=====

// bundle qZe tool 臂 + nor state 联合的形状复刻（.strict() 字段集）：
// {partId, sessionId, messageId, type:"tool", callId, tool, state:{status, input, …}}。
const toolPart = ({ callId, tool, status, input, output, error, raw }) => ({
  partId: `part_${callId}`,
  sessionId: SESSION_ID,
  messageId: "msg_tool_1",
  type: "tool",
  callId,
  tool,
  state: status === "completed"
    ? { status, input, output, title: "done", metadata: {}, startedAt: 1, completedAt: 2 }
    : status === "error"
      ? { status, input, error, metadata: {}, startedAt: 1, completedAt: 2 }
      : status === "running"
        ? { status, input, title: "running", startedAt: 1 }
        : { status, input, raw: raw ?? "" },
});

test("zcode ④c: completed 轮 tool(write) part → file_written + tool_result，证据先于 user echo/assistant 文本（F2 同族补齐）", async () => {
  const writePart = toolPart({
    callId: "call_wao_cert_coder_hq_muq3vm7a",
    tool: "Write",
    status: "completed",
    input: { file_path: "D:/wao-test/zcode-ws/out/wao_cert_coder_hq_muq3vm7a.txt", content: "payload" },
    output: "Created file D:/wao-test/zcode-ws/out/wao_cert_coder_hq_muq3vm7a.txt",
  });
  const { handle, child } = await runScenario({
    peerOptions: {
      messages: (n) => (n <= 1 ? [] : [
        userMsg("do the task"),
        // live 形状：tool part 与 text part 同轮混排（tool → text → step-finish，
        // 完成判据要求 step-finish 收尾）——证据先行与 part 排布位置无关。
        { role: "assistant", parts: [writePart, { type: "text", text: "wrote the probe file" }, { type: "step-finish", reason: "stop", tokens: {} }] },
      ]),
    },
  });
  const events = await collect(handle);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["file_written", "tool_result", "message", "message", "metrics", "done"],
    "顺序锁死：tool part 证据（file_written + tool_result）→ user echo → assistant text → metrics → done",
  );
  // bundle schema：Write input.file_path "must be absolute, not relative"——绝对路径
  // 原样透传（控制面 containment 求值用词法+realpath，投影层不改写）。
  assert.deepEqual(events[0], {
    kind: "file_written",
    path: "D:/wao-test/zcode-ws/out/wao_cert_coder_hq_muq3vm7a.txt",
  });
  assert.deepEqual(events[1], {
    kind: "tool_result",
    tool: "call_wao_cert_coder_hq_muq3vm7a",
    output: "Created file D:/wao-test/zcode-ws/out/wao_cert_coder_hq_muq3vm7a.txt",
    isError: false,
  });
  // 消息投影不变：回显剔除 + text 拼接只认 type:"text"（tool part 不入文本）。
  assert.equal(events[2].role, "user");
  assert.deepEqual(events[2].parts, [{ type: "text", text: "do the task" }]);
  assert.equal(events[3].role, "assistant");
  assert.deepEqual(events[3].parts, [{ type: "text", text: "wrote the probe file" }]);
  assert.equal(events.at(-1).reason, "completed");
  child.kill();
});

test("zcode ④d: bash part → commandEvent（exitCode 恒省略）；未知工具 → toolUseEvent；error state → tool_result isError:true", async () => {
  const bashDone = toolPart({
    callId: "call_bash_ok",
    tool: "Bash",
    status: "completed",
    input: { command: "node scripts/probe.mjs" },
    output: "probe ok",
  });
  const readDone = toolPart({
    callId: "call_read",
    tool: "Read",
    status: "completed",
    input: { path: "README.md" },
    output: "readme body",
  });
  const bashError = toolPart({
    callId: "call_bash_err",
    tool: "Bash",
    status: "error",
    input: { command: "node scripts/failing.mjs" },
    error: "exit status 1",
  });
  const { handle, child } = await runScenario({
    peerOptions: {
      messages: (n) => (n <= 1 ? [] : [
        userMsg("do the task"),
        { role: "assistant", parts: [bashDone, readDone, bashError, { type: "text", text: "done" }, { type: "step-finish", reason: "stop", tokens: {} }] },
      ]),
    },
  });
  const events = await collect(handle);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["command", "tool_result", "tool_use", "tool_result", "command", "tool_result", "message", "message", "metrics", "done"],
    "逐 part 双事件形状（投影在前、终态结果在后）与 opencode/kimi-web 一致",
  );
  // Bash → commandEvent：tool part state schema 无退出码字段（nor 闭集核证），
  // exitCode 恒省略绝不虚构；toolCallId 关联 tool_result。
  assert.deepEqual(events[0], { kind: "command", command: "node scripts/probe.mjs", toolCallId: "call_bash_ok" });
  assert.deepEqual(events[1], { kind: "tool_result", tool: "call_bash_ok", output: "probe ok", isError: false });
  // 非 bash/write 类工具 → toolUseEvent(tool, state.input)。
  assert.deepEqual(events[2], { kind: "tool_use", tool: "Read", input: { path: "README.md" } });
  assert.deepEqual(events[3], { kind: "tool_result", tool: "call_read", output: "readme body", isError: false });
  // error state → 主投影照发 + tool_result isError:true，output 取 error 臂的
  // state.error（bundle nor error 臂形状）。
  assert.deepEqual(events[4], { kind: "command", command: "node scripts/failing.mjs", toolCallId: "call_bash_err" });
  assert.deepEqual(events[5], { kind: "tool_result", tool: "call_bash_err", output: "exit status 1", isError: true });
  assert.equal(events.at(-1).reason, "completed");
  child.kill();
});

test("zcode ④e: 非终态 status（pending|running）只投影主事件不追加 tool_result；write 帧缺 file_path 不虚构 file_written", async () => {
  // 腿 1：pending/running（nor 闭集前两臂）= 工具已发起未收口——command 在场、
  // tool_result 缺席（闭集内非终态绝不猜成终态，镜像 opencodeServe terminal 门）。
  const pending = toolPart({ callId: "call_pending", tool: "Bash", status: "pending", input: { command: "node slow.mjs" }, raw: "queued" });
  const running = toolPart({ callId: "call_running", tool: "Bash", status: "running", input: { command: "node slower.mjs" } });
  const leg1 = await runScenario({
    peerOptions: {
      messages: (n) => (n <= 1 ? [] : [
        userMsg("do the task"),
        { role: "assistant", parts: [pending, running, { type: "text", text: "ok" }, { type: "step-finish", reason: "stop", tokens: {} }] },
      ]),
    },
  });
  const events1 = await collect(leg1.handle);
  assert.deepEqual(
    events1.map((e) => e.kind),
    ["command", "command", "message", "message", "metrics", "done"],
    "非终态 tool part：主投影在场、tool_result 缺席",
  );
  assert.equal(events1.filter((e) => e.kind === "tool_result").length, 0);
  assert.deepEqual(events1[0], { kind: "command", command: "node slow.mjs", toolCallId: "call_pending" });
  assert.deepEqual(events1[1], { kind: "command", command: "node slower.mjs", toolCallId: "call_running" });
  leg1.child.kill();

  // 腿 2：Write 帧 input 缺 file_path → 零 file_written（不虚构）；终态
  // tool_result 仍按 state 投影（与 opencodeServe 逐 part 双事件形状一致）。
  const noPath = toolPart({
    callId: "call_nopath",
    tool: "Write",
    status: "completed",
    input: { content: "orphan" },
    output: "nothing written",
  });
  const leg2 = await runScenario({
    peerOptions: {
      messages: (n) => (n <= 1 ? [] : [
        userMsg("do the task"),
        { role: "assistant", parts: [noPath, { type: "text", text: "ok" }, { type: "step-finish", reason: "stop", tokens: {} }] },
      ]),
    },
  });
  const events2 = await collect(leg2.handle);
  assert.deepEqual(
    events2.map((e) => e.kind),
    ["tool_result", "message", "message", "metrics", "done"],
    "无 file_path 的 Write 帧：零 file_written、终态 tool_result 在场",
  );
  assert.deepEqual(events2[0], { kind: "tool_result", tool: "call_nopath", output: "nothing written", isError: false });
  assert.ok(!events2.some((e) => e.kind === "file_written"));
  leg2.child.kill();
});

test("zcode ④f: 纯文本轮 → 零证据事件（保持——投影只认 type:\"tool\" part）", async () => {
  const { handle, child } = await runScenario({
    peerOptions: {
      messages: (n) => (n <= 1 ? [] : [userMsg("do the task"), assistantMsg("answer")]),
    },
  });
  const events = await collect(handle);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["message", "message", "metrics", "done"],
    "纯文本轮发射序列不变（user echo → assistant text → metrics → done）",
  );
  assert.ok(
    !events.some((e) => ["command", "file_written", "tool_use", "tool_result"].includes(e.kind)),
    "零证据事件",
  );
  child.kill();
});

test("zcode ④g: completed 轮只有 tool part 无 assistant 文本 → done(failed) 但已发生的工具证据保留（TD-199 双席会审再裁定：事实不随失败丢失）", async () => {
  const writePart = toolPart({
    callId: "call_write_only",
    tool: "Write",
    status: "completed",
    input: { file_path: "D:/wao-test/zcode-ws/out.txt", content: "payload" },
    output: "Created file D:/wao-test/zcode-ws/out.txt",
  });
  const { handle, child } = await runScenario({
    peerOptions: {
      messages: (n) => (n <= 1 ? [] : [
        userMsg("do the task"),
        { role: "assistant", parts: [writePart, { type: "step-finish", reason: "stop", tokens: {} }] },
      ]),
    },
  });
  const events = await collect(handle);
  const done = events.at(-1);
  assert.equal(done.reason, "failed");
  assert.match(done.error, /without assistant text/);
  // TD-199（2026-10-02 双席会审）：空文本失败不再压掉已发生的工具事实——
  // 证据先落（file_written + tool_result），随后如实 done(failed)、零伪完成。
  // （旧合同"零证据发射"已废弃：真实工具活动不因无文本而消失。）
  assert.deepEqual(
    events.map((e) => e.kind),
    ["file_written", "tool_result", "done"],
    "证据保留 → done(failed)；零 user echo、零 assistant（不伪造完成）",
  );
  child.kill();
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

test("zcode ⑥: 已有产出后连续 60 拍无新 part → done(failed, turn stalled)", async () => {
  // 第 2 拍出现 user 回显（进展一次），此后恒不变 → 60 拍无进展收口（第二轮
  // 门限 8→60 放宽后的既有不变量：已有产出后的真停滞仍有界收口）。
  const { handle, child } = await runScenario({
    peerOptions: { messages: (n) => (n <= 2 ? [] : [userMsg("do the task")]) },
  });
  const events = await collect(handle);
  const done = events.at(-1);
  assert.equal(done.reason, "failed");
  assert.match(done.error, /turn stalled/);
  child.kill();
});

test("zcode ⑥b: silentTimeout 在场且零新 part → 只以 silentTimeout 为界（停滞门不抢先）", async () => {
  const { handle, child, peer } = await runScenario({
    peerOptions: { messages: () => [] },
  });
  // 补强（2026-10-01 零 part 分相修复；同日第二轮停滞门 8→60 同步本钉）：
  // silentTimeout 放宽到 1000ms，实证收口前已远超 60 拍——停滞门在零 part 阶段
  // 不生效。
  const events = await collect(handle, { pollInterval: 5, silentTimeout: 1000 });
  const done = events.at(-1);
  assert.equal(done.reason, "failed");
  assert.match(done.error, /silent timeout/, "无 turn 等待的上界是 silentTimeout，不是停滞门");
  assert.ok(peer.polls() > 60, `收口前已过 60 拍（实际 ${peer.polls()} 拍）——停滞门（60 拍）零 part 阶段不抢先`);
  child.kill();
});

// ===== ⑥c-⑥f 分相反例组（2026-10-01 两轮 live 实证）。拍号约定：fake 对端的
// n=1 是 spawn 期基线快照，事件拍从 n=2 起。 =====
//
// ⑥c-⑥e = 零 part 相（GLM-5.3 high reasoning 首 part 延迟 >8s——delta 认证
// scorecard drill run_20261001195259045cle1ft 转录在案；旧形状 8 拍门把正常思考
// 中的轮次杀成 turn stalled）。⑥f = 已有产出后的步间静默相（第二轮诊断
// run_20261001203009794bb6add：GLM-5.3 步间 reasoning 实测 8-14s，8 拍门误杀 →
// 门限 8→60）。

// 反例①：前 11 个事件拍零 part，首 part 第 12 拍才出现（无 silentTimeout）→
// 不被杀、正常完成。
test("zcode ⑥c: 反例①——首 part 第 12 拍才出现（前 11 拍零 part，无 silentTimeout）→ 不被停滞门误杀、正常完成", async () => {
  const { handle, child, peer } = await runScenario({
    peerOptions: {
      messages: (n) => (n <= 12 ? [] : [userMsg("do the task"), assistantMsg("answer")]),
    },
  });
  const events = await collect(handle, { pollInterval: 2 });
  const done = events.at(-1);
  assert.equal(done.kind, "done");
  assert.equal(done.reason, "completed", "第 12 拍才出首 part 的思考轮正常完成（停滞门在零 part 阶段不生效）");
  assert.ok(!JSON.stringify(events).includes("turn stalled"), "绝不 turn stalled");
  assert.ok(!JSON.stringify(events).includes("thinking budget"), "远未触及思考预算");
  const assistant = events.filter((e) => e.kind === "message" && e.role === "assistant");
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].parts[0].text, "answer", "正常走完整发射序列");
  // 恰 13 次轮询（基线 + 12 事件拍）——确定性拍号核对。
  assert.equal(peer.polls(), 13);
  child.kill();
});

// 反例②：已有产出后静默满 60 拍 → 仍 done(failed, "turn stalled")；silentTimeout
// 在场也不豁免——宽松只保护零 part 阶段，不保护已有产出后的真停滞。产出形状取
// 本轮 live 实测的步间形状（echo + step-start，run_20261001203009794bb6add 失败
// 时间线的前缀），只是静默永不终结——门必须在第 60 个无进展拍收口。
test("zcode ⑥d (TD-197①): 有 part 后静默段 ≥ 自适应预算（300s floor，恰不紧于旧 60 拍×5s=300s 门）才收口；silentTimeout 在场也不豁免停滞门", async () => {
  // 基线拍 n=1、零 part n=2、n=3 echo+step-start（prime 基线，t=90s），此后恒
  // 不变；假钟 +30s/拍——静默 300s ≥ floor 时收口（无观测 → 预算 = floor）。
  let fakeNow = 0;
  const clock = () => fakeNow;
  const { handle, child, peer } = await runScenario({
    peerOptions: {
      messages: (n) => (n <= 2 ? [] : [userMsg("do the task"), stepStartMsg()]),
    },
  });
  const events = await collect(handle, {
    pollInterval: 2,
    silentTimeout: 6_000_000,
    stallClock: clock,
    onPollTick: () => { fakeNow += 30_000; },
  });
  const done = events.at(-1);
  assert.equal(done.reason, "failed");
  assert.match(done.error, /turn stalled/, "已有产出后的真停滞仍由停滞门有界收口");
  assert.match(done.error, /adaptive budget/, "TD-197① 自适应预算合同");
  assert.match(done.error, /300000ms floor/, "floor = NO_PROGRESS_FLOOR_MS = 300000（改动须有意识更新本钉）");
  assert.ok(!JSON.stringify(events).includes("silent timeout"), "silentTimeout 不豁免已有产出后的停滞门");
  // 确定性拍号：prime t=90（n=3）→ 静默 30×(n-3) ≥ 300 → n=13 收口。
  assert.equal(peer.polls(), 13);
  child.kill();
});

test("zcode ⑥d TD-197① 自放大存活（2026-10-02 误杀形态回归钉）：先验 120s gap → 预算 360s，320s 静默（旧 300s 门必杀）→ step-finish 正常完成", async () => {
  // 复刻 run_20261002144448432xikf8k 的形态：先验间隙 120s（n=9 处 parts 增长，
  // t=180-60=120s → 预算 = max(300, 3×120)=360s），随后恒静默到 n=25（t=500，
  // 静默 320s > 旧门 300s【旧门在 n=24、静默 300s 即杀】、< 360s 预算）才
  // step-finish → 必须放行完成。假钟 +20s/拍。
  let fakeNow = 0;
  const clock = () => fakeNow;
  const { handle, child, peer } = await runScenario({
    peerOptions: {
      messages: (n) => {
        if (n <= 2) return [];
        if (n === 3) return [userMsg("do the task"), stepStartMsg()];
        // n=9 parts 增长（先验 gap 120s 的进度点）；此后保持 3 parts 恒定
        // （回落会触发快照缩短 fail-closed——那不是本钉的对象）。
        if (n >= 9 && n < 25) return [userMsg("do the task"), stepStartMsg(), stepStartMsg()];
        if (n >= 25) return [userMsg("do the task"), stepStartMsg(), assistantMsg("done text", "stop")];
        return [userMsg("do the task"), stepStartMsg()];
      },
    },
  });
  const events = await collect(handle, {
    pollInterval: 2,
    stallClock: clock,
    onPollTick: () => { fakeNow += 20_000; },
  });
  const done = events.at(-1);
  assert.equal(done.reason, "completed", "320s 批间静默（旧门必杀点之后）在 360s 自适应预算下放行到正常完成");
  assert.ok(peer.polls() >= 25);
  child.kill();
});

// 反例③的在场分支见 ⑥b（补强）；此处钉思考预算本身的界：silentTimeout 缺席、
// 零 part 恒持续 → 120 拍有界收口（第二轮起与 NO_PROGRESS_POLL_LIMIT 解耦的
// 固定值，取值沿用上轮裁定）——绝不无限等待、也绝不在停滞门抢先。
test("zcode ⑥e: 思考预算收口——零 part 恒持续 + silentTimeout 缺席 → 120 拍 bounded fail（非停滞门抢先）", async () => {
  const { handle, child, peer } = await runScenario({
    peerOptions: { messages: () => [] },
  });
  const events = await collect(handle, { pollInterval: 1 });
  const done = events.at(-1);
  assert.equal(done.reason, "failed");
  assert.match(done.error, /thinking budget exceeded/);
  assert.match(done.error, /for 120 consecutive polls/, "预算值 = 固定 120（已与 NO_PROGRESS_POLL_LIMIT 解耦——改动须有意识更新本钉）");
  assert.match(done.error, /silentTimeout absent/);
  // 恰 121 次轮询（基线 + 120 事件拍）——既非停滞门抢先、也非无限等待。
  assert.equal(peer.polls(), 121);
  child.kill();
});

// 反例④（第二轮 live 实测形状：run_20261001203009794bb6add + 1s 轮询 part 时间
// 线）——echo → step-start 之后模型步间 reasoning 静默（实测 8-14s），之后才
// step-finish。本反例静默 20 拍：> 旧 8 拍门（旧门会在第 11 拍误杀）、< 新门
// 60 拍 → 必须放行到正常完成。这是门限 8→60 的直接回归钉：回退常量本测试即红。
test("zcode ⑥f: 反例④——echo+step-start 后步间静默 20 拍再 step-finish → 不被杀、正常完成（GLM-5.3 live 形状）", async () => {
  const { handle, child, peer } = await runScenario({
    peerOptions: {
      // 拍号脚本（live 时间线的确定性缩放）：基线 → 第 2 拍 echo（live t=1s）→
      // 第 3 拍 step-start（live t=4s）→ 第 4..23 拍静默 20 拍（live t=4s~18s 的
      // 步间 reasoning）→ 第 24 拍 step-finish(stop)（live t=18s）。
      messages: (n) => {
        if (n <= 1) return [];
        if (n === 2) return [userMsg("do the task")];
        if (n <= 23) return [userMsg("do the task"), stepStartMsg()];
        return [userMsg("do the task"), stepStartMsg(), assistantMsg("answer")];
      },
    },
  });
  const events = await collect(handle, { pollInterval: 2 });
  const done = events.at(-1);
  assert.equal(done.kind, "done");
  assert.equal(done.reason, "completed", "步间静默 20 拍（> 旧 8 拍门）的轮次必须放行到完成");
  assert.ok(!JSON.stringify(events).includes("turn stalled"), "绝不 turn stalled");
  assert.ok(!JSON.stringify(events).includes("thinking budget"), "零 part 预算不适用（第 2 拍起已有产出）");
  const assistant = events.filter((e) => e.kind === "message" && e.role === "assistant");
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].parts[0].text, "answer", "echo 被剔除、step-start 不投影——正常发射序列");
  // 确定性拍号：基线 + 23 个事件拍（第 24 拍完成收口）——静默段恰 20 拍（n=4..23）。
  assert.equal(peer.polls(), 24);
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

test("zcode ⑨: resume 轮不 create，先 session/resume 装载 → setModel → setMode → send（次序固定）", async () => {
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
  assert.ok(indexOf("session/setModel") < indexOf("session/setMode"), "setModel 先于 setMode（写许可放开同 setModel 一样每次派发生效）");
  assert.ok(indexOf("session/setMode") < indexOf("session/send"), "setMode 先于 send");
  const setModel = peer.framesOf("session/setModel")[0];
  assert.equal(setModel.params.sessionId, prior, "setModel 作用于前任会话（配置模型每次派发生效）");
  assert.deepEqual(
    peer.framesOf("session/setMode")[0].params,
    { sessionId: prior, mode: "yolo" },
    "setMode 同样作用于前任会话（resume 轮的写许可不豁免——fail-closed 同款）",
  );
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
  // 零 part 分相修复（2026-10-01）后，本形状（无 silentTimeout、恒零 new part）
  // 由零 part 思考预算有界收口——不是 stalled 门（停滞门在零 part 阶段不生效；
  // GLM-5.3 首 part 延迟实证 run_20261001195259045cle1ft）；不变量不变：绝不
  // completed、零消息发射。
  assert.match(done.error, /thinking budget exceeded/, "由零 part 思考预算有界收口（停滞门不在零 part 阶段生效）");
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
  // P2②b：严格相等。当前实际 = 12 处：runScenario / ②c / ②d / ②e / ③b / ⑦b /
  // ⑦c / ⑨b / ⑨e / ⑨f / ⑨g / ⑩b。加/删构造必须同步更新此数字——不更新即红。
  assert.equal(
    constructions.length,
    12,
    `守卫扫描应找到恰 12 处构造（runScenario/②c/②d/②e/③b/⑦b/⑦c/⑨b/⑨e/⑨f/⑨g/⑩b），实际 ${constructions.length}——加/删构造必须同步更新守卫计数（扫描器失效即守卫空转）`,
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


// ===== ⑫ TD-199 增量证据投影（2026-10-02，双席会审重设：part 投影台账驱动）=====

test("zcode ⑫a: 轮询期增量落盘——running bash 的 command 事件在终态快照送达前即可拉取", async () => {
  // 增量投影的硬证明：消费者 it.next() 在 peer 从未应答过含 step-finish 的快照
  // 时拉到 command（批式实现的第一事件要等到终态投影——本用例对它是红的）。
  const running = toolPart({ callId: "call_inc1", tool: "Bash", status: "running", input: { command: "node long.mjs" } });
  const doneTool = toolPart({ callId: "call_inc1", tool: "Bash", status: "completed", input: { command: "node long.mjs" }, output: "long ok" });
  let maxPoll = 0;
  const { handle, child } = await runScenario({
    peerOptions: {
      messages: (n) => {
        maxPoll = Math.max(maxPoll, n);
        if (n <= 1) return [];
        if (n === 2) return [userMsg("do the task"), { role: "assistant", parts: [running] }];
        return [userMsg("do the task"), { role: "assistant", parts: [doneTool, { type: "text", text: "ok" }, { type: "step-finish", reason: "stop", tokens: {} }] }];
      },
    },
  });
  const gen = handle.events(new AbortController().signal, { pollInterval: 2 });
  const first = await gen.next();
  assert.equal(
    first.value.kind, "command",
    "第一条事件是工具证据且在终态快照存在前到达（maxPoll 此刻 <=2）",
  );
  assert.equal(first.value.command, "node long.mjs");
  assert.ok(maxPoll <= 2, "拉到首事件时 peer 尚未送达任何 step-finish 快照");
  const rest = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) break;
    rest.push(r.value);
  }
  assert.deepEqual(
    rest.map((e) => e.kind),
    ["tool_result", "message", "message", "metrics", "done"],
    "原位收口补 tool_result → echo → assistant → metrics → done（与既有终态合同一致）",
  );
  child.kill();
});

test("zcode ⑫b: 同 part 原位终态（parts.length 不变）→ tool_result 恰一次补发（纯新增切片方案会永久漏发的杀伤用例）", async () => {
  const running = toolPart({ callId: "call_flip", tool: "Bash", status: "running", input: { command: "node flip.mjs" } });
  const flipped = toolPart({ callId: "call_flip", tool: "Bash", status: "completed", input: { command: "node flip.mjs" }, output: "flip ok" });
  let sawSameLengthFlip = false;
  const { handle, child } = await runScenario({
    peerOptions: {
      messages: (n) => {
        if (n <= 1) return [];
        if (n === 2) return [userMsg("do the task"), { role: "assistant", parts: [running] }];
        if (n === 3) {
          sawSameLengthFlip = true;
          return [userMsg("do the task"), { role: "assistant", parts: [flipped] }];
        }
        return [userMsg("do the task"), { role: "assistant", parts: [flipped, { type: "text", text: "ok" }, { type: "step-finish", reason: "stop", tokens: {} }] }];
      },
    },
  });
  const events = await collect(handle);
  assert.ok(sawSameLengthFlip, "场景确实经历了同长原位翻转拍");
  assert.equal(events.filter((e) => e.kind === "command").length, 1, "主事件恰一次（台账防重发）");
  const results = events.filter((e) => e.kind === "tool_result");
  assert.equal(results.length, 1, "原位终态的 tool_result 恰一次被补发");
  assert.deepEqual(results[0], { kind: "tool_result", tool: "call_flip", output: "flip ok", isError: false });
  child.kill();
});

test("zcode ⑫c: live 形状（callId 缺席，toolCallId 回落工具名）——同名多次调用各自独立在场，不因去重坍缩", async () => {
  // live 实证（2026-10-02 三轮 run）：真实转录 tool_result 的 toolCallId 去重后
  // 只剩工具名——台账键必须是 part 序号，同名调用不得坍缩成一个。
  const b1 = { type: "tool", tool: "Bash", state: { status: "completed", input: { command: "npm test one" }, output: "ok1" } };
  const b2 = { type: "tool", tool: "Bash", state: { status: "completed", input: { command: "npm test two" }, output: "ok2" } };
  const { handle, child } = await runScenario({
    peerOptions: {
      messages: (n) => (n <= 1 ? [] : [
        userMsg("do the task"),
        { role: "assistant", parts: [b1, b2, { type: "text", text: "ok" }, { type: "step-finish", reason: "stop", tokens: {} }] },
      ]),
    },
  });
  const events = await collect(handle);
  const commands = events.filter((e) => e.kind === "command");
  const results = events.filter((e) => e.kind === "tool_result");
  assert.equal(commands.length, 2, "两次同名 Bash 调用各有一条 command（未坍缩）");
  assert.deepEqual(commands.map((c) => c.command), ["npm test one", "npm test two"]);
  assert.equal(results.length, 2, "两条 tool_result 各自在场");
  assert.deepEqual(results.map((r) => r.output), ["ok1", "ok2"]);
  assert.ok(commands.every((c) => c.toolCallId === "Bash"), "callId 缺席时回落工具名（live 形状）");
  child.kill();
});

test("zcode ⑫d: 快照缩短（parts.length 回退）→ fail-closed done(failed)，不把错位序号当本轮证据", async () => {
  const running = toolPart({ callId: "call_shrink", tool: "Bash", status: "running", input: { command: "node x.mjs" } });
  const { handle, child } = await runScenario({
    peerOptions: {
      messages: (n) => {
        if (n <= 1) return [];
        if (n === 2) return [userMsg("do the task"), { role: "assistant", parts: [running] }];
        return [userMsg("do the task")];
      },
    },
  });
  const events = await collect(handle);
  const done = events.at(-1);
  assert.equal(done.reason, "failed");
  assert.match(done.error, /snapshot shrank \(1 < 2\)/);
  child.kill();
});

test("zcode ⑫e: pending write（path 在场）零 file_written——completed 收口才发（写意图不冒充成功，RunEvent 契约）", async () => {
  const writePending = toolPart({ callId: "call_w", tool: "Write", status: "running", input: { file_path: "D:/wao-test/zcode-ws/out.txt", content: "x" } });
  const writeDone = toolPart({ callId: "call_w", tool: "Write", status: "completed", input: { file_path: "D:/wao-test/zcode-ws/out.txt", content: "x" }, output: "Created" });
  const { handle, child } = await runScenario({
    peerOptions: {
      messages: (n) => {
        if (n <= 1) return [];
        // pending 拍保持 ~400 拍（@2ms ≈ 800ms）再翻转；每拍追加一个填充 text
        // part 重置无进展计数（停滞门 60 拍不触发——纯 hold 会先 done(stalled)）。
        // 检查点 400ms 落在 pending 期内，"pending 期零事件"可确定断言。
        if (n <= 400) {
          const fillers = Array.from({ length: n }, (_, i) => ({ type: "text", text: `wip ${i}` }));
          return [userMsg("do the task"), { role: "assistant", parts: [writePending, ...fillers] }];
        }
        // 翻转快照必须 ≥ filler 撑大的长度（否则触发缩短守卫 done(shrank)）：
        // write 原位转 completed + 400 fillers + ok + step-finish。
        const fillers = Array.from({ length: 400 }, (_, i) => ({ type: "text", text: `wip ${i}` }));
        return [userMsg("do the task"), { role: "assistant", parts: [writeDone, ...fillers, { type: "text", text: "ok" }, { type: "step-finish", reason: "stop", tokens: {} }] }];
      },
    },
  });
  // 验证会审补强（auditor）：只看终序列抓不住"running 拍提前发 file_written"。
  // 后台泵持续收集（带时间戳）；400ms 检查点断言 pending 期零事件——提前
  // file_written 会在检查点立刻红。
  const gen = handle.events(new AbortController().signal, { pollInterval: 2 });
  const collected = [];
  const pump = (async () => {
    for (;;) {
      const r = await gen.next();
      if (r.done) break;
      collected.push(r.value);
    }
  })();
  await delay(400);
  assert.equal(collected.length, 0, `pending write 拍零事件（提前 file_written 立刻红；实得 ${collected.map((e) => e.kind).join(",")}）`);
  await pump;
  assert.deepEqual(
    collected.map((e) => e.kind),
    ["file_written", "tool_result", "message", "message", "metrics", "done"],
    "completed 收口才 file_written + tool_result",
  );
  child.kill();
});

test("zcode ⑫f: 证据已落后进程死（通信失败）→ done(failed) 且已发证据保留、零双发", async () => {
  const bashDone = toolPart({ callId: "call_dead", tool: "Bash", status: "completed", input: { command: "node a.mjs" }, output: "a ok" });
  const { handle, child } = await runScenario({
    peerOptions: {
      messages: (n) => {
        if (n <= 1) return [];
        if (n === 2) return [userMsg("do the task"), { role: "assistant", parts: [bashDone] }];
        // 拍 3 起：不给终态，外部杀进程（wire closed → done(failed)）
        return [userMsg("do the task"), { role: "assistant", parts: [bashDone] }];
      },
    },
  });
  const gen = handle.events(new AbortController().signal, { pollInterval: 2 });
  const first = await gen.next();
  assert.equal(first.value.kind, "command", "进程死前证据已增量落盘");
  child.kill();
  const rest = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) break;
    rest.push(r.value);
  }
  assert.equal(rest.filter((e) => e.kind === "command").length, 0, "零双发（台账）");
  const done = rest.at(-1);
  assert.equal(done.kind, "done");
  assert.equal(done.reason, "failed");
  child.kill();
});

test("zcode ⑫g: 终态后 session/usage 失败 → done(failed) 且已发证据保留（零 echo/assistant——不伪造完成）", async () => {
  const bashDone = toolPart({ callId: "call_usage", tool: "Bash", status: "completed", input: { command: "node u.mjs" }, output: "u ok" });
  const { handle, child } = await runScenario({
    peerOptions: {
      usageError: { code: -32000, message: "usage backend exploded" },
      messages: (n) => (n <= 1 ? [] : [
        userMsg("do the task"),
        { role: "assistant", parts: [bashDone, { type: "text", text: "ok" }, { type: "step-finish", reason: "stop", tokens: {} }] },
      ]),
    },
  });
  const events = await collect(handle);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["command", "tool_result", "done"],
    "证据保留 → done(failed, usage)；零 echo/assistant/metrics（usage 失败不伪造完成）",
  );
  assert.equal(events.at(-1).reason, "failed");
  assert.match(events.at(-1).error, /session\/usage failed/);
  child.kill();
});

test("zcode ⑫h: 输入晚来——Bash 首拍 input 空壳不投占位/不锁台账，command 补齐后补发 commandEvent（验证会审发现）", async () => {
  const shellEmpty = { type: "tool", callId: "call_late", tool: "Bash", state: { status: "running", input: {} } };
  const shellFilled = toolPart({ callId: "call_late", tool: "Bash", status: "completed", input: { command: "node late.mjs" }, output: "late ok" });
  const { handle, child } = await runScenario({
    peerOptions: {
      messages: (n) => {
        if (n <= 1) return [];
        if (n === 2) return [userMsg("do the task"), { role: "assistant", parts: [shellEmpty] }];
        return [userMsg("do the task"), { role: "assistant", parts: [shellFilled, { type: "text", text: "ok" }, { type: "step-finish", reason: "stop", tokens: {} }] }];
      },
    },
  });
  const events = await collect(handle);
  const commands = events.filter((e) => e.kind === "command");
  assert.equal(commands.length, 1, "空壳拍零 tool_use 占位；command 补齐后恰一次补发");
  assert.equal(commands[0].command, "node late.mjs");
  assert.equal(events.filter((e) => e.kind === "tool_use").length, 0, "Bash 家族永不落 tool_use 占位");
  const results = events.filter((e) => e.kind === "tool_result");
  assert.equal(results.length, 1);
  child.kill();
});
