// test/backends/kimiWeb.test.js
//
// 第 7 个 backend「kimi-web」（HTTP attach，`kimi web` 本地服务器的官方 REST
// API）的离线单元测试：注入 fetchImpl 的假服务器构造全部上游形状，零真实服务器、
// 零网络（风格镜像 test/backends/opencodeServe.test.js）。上游事实锚点 =
// 2026-09-30 对本机 kimi 2.1.1 的直跑实测（src/backends/kimiWeb.js 文件头）。
//
// 第八轮交付（完成判定迁移到**原厂 transcript 轮次终态原语**）适配：完成判定 =
// triggerPromptId === prompt_id 的 turn 归属（live 双验证）+ state 终态闭集
// （completed|failed|cancelled；state 闭集 queued|running|…）。每拍恰一次 GET
// transcript?agent_id=main（agent_id 必填——缺则 40001；实测 "main" 有效、
// "default" 返回空，客户端恒发 main）；messages/detail 端点退出完成判定
//（messages 仅供停止验证探针；detail 仅供提交前静默门与探针）。v7 的全部
// 启发式（preSubmitIds 消息快照 / preSubmitReason 锚 / WAIT-ACTIVE→IN-TURN→
// SETTLE 活动转移 / messages 双读稳定性）及其测试删除（删除清单见交付汇报）。
// 保留面（第四步不变项）：F3 提交前静默门、abort 固定错误、sendCorrection
// 排队+steer 协议、token 递归清洗、POST 仅 ECONNREFUSED 重试、探针消费者形状、
// fail-closed 形状门（transcript 响应缺 items 数组 ⇒ 固定错误）。
// 能力翻转：reportsTokenUsage false→true（transcript steps[].usage 实测非零；
// completed 轮 usage 求和 → metrics 事件）。
//
// 第九轮交付（R9 定点修复 + 六审盲区反例；transcript 核心架构不动——归属/终态/
// 拼接/usage 既有实现保持）：F1 sessionStatus 非布尔形状 → busy 保守投影（消费侧
// isKnownStatus(null)===true 会虚记 stop_verified——opencodeStopVerify.js:134）；
// F2 turnFailureText 过与 request 层同一 redactToken（HTTP 200 成功路径的
// turn.error 不再绕开清洗）；F3 无 turn 分支只以 silentTimeout 为界（8 拍兜底仅
// silentTimeout 缺席时生效）；F4 闭集外 state 独立有界出口（连续 8 拍、增长不清
// 零）。反例补齐：停滞门增长重置必要性（跨过无重置失败点的确定性构造）、queued
// 单列、提交前静默门 busy 到界零提交、transcript 不可解析 JSON、先见 running 后
// 请求连续失败不复用旧 turn。
//
// 第十轮小交付（2026-10-01 delta 认证证据链补齐）：completed 轮 steps[].frames
// 里 kind:"tool" 的帧（形状 = 2026-10-01 live 探针：{kind:"tool", frameId,
// toolCallId, name, state, input, output}）投影为证据事件——镜像 opencodeServe
// evidenceEventsFromOpenCodeToolPart（bash/shell+command → command、
// write/edit/multiedit+path/file_path → file_written、其余 → tool_use、终态
// done|error|failed 追加 tool_result），证据先于 assistant 文本发射。v1 误以为
// frames 是 thinking|text 闭集：模型真写了文件但 WAO 无 file_written 事件，
// delta scorecard 误红 hasEvidence/filesExist——本轮补齐证据面。

import test, { before, after } from "node:test";
import assert from "node:assert/strict";

import { KimiWebBackend } from "../../src/backends/kimiWeb.js";
import { backendFor, backendCapabilitySnapshot } from "../../src/backends/factory.js";
import { normalizeAgent } from "../../src/registry.js";
import { verifyStopQuiet } from "../../src/backends/opencodeStopVerify.js";

const TOKEN_ENV = "KIMI_WEB_TEST_TOKEN";
const TOKEN_VALUE = "kimi-web-test-token-value-0123456789";

before(() => {
  process.env[TOKEN_ENV] = TOKEN_VALUE;
});
after(() => {
  delete process.env[TOKEN_ENV];
});

function makeAgent(overrides = {}) {
  return {
    id: "coder_kimiweb",
    backend: "kimi-web",
    serveUrl: "http://127.0.0.1:4310",
    cwd: "D:/projects/worktree",
    model: { id: "kimi-code/k3" },
    tokenEnv: TOKEN_ENV,
    ...overrides,
  };
}

/** 假 kimi web 服务器：记录全部请求，按测试提供的 handler 应答。 */
function kimiServer(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const urlStr = String(url);
    calls.push({
      url: urlStr,
      method: init.method ?? "GET",
      body: init.body,
      headers: init.headers ?? {},
    });
    return handler(urlStr, init, calls.length);
  };
  return { calls, fetchImpl };
}

/** kimi web 统一响应信封 {code,msg,data}（code===0 即成功）。 */
function envelope(data, { code = 0, msg = "" } = {}) {
  return jsonResponse({ code, msg, data });
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return value;
    },
    async text() {
      return JSON.stringify(value);
    },
  };
}

/** 会话详情健康形状（A4 在场门：id 与 busy/main_turn_active 都必须在场）。 */
function detailEnvelope(sessionId, busy, mainTurnActive, reason) {
  return envelope({
    id: sessionId,
    busy,
    main_turn_active: mainTurnActive,
    last_turn_reason: reason,
    usage: {},
  });
}

/** transcript 信封（data.items 轮粒度 + seq 水位 + has_more；v8 只消费 items）。 */
function transcriptEnvelope(items, extra = {}) {
  return envelope({ items, seq: 7, has_more: false, ...extra });
}

/** transcript 轮条目（形状锚 = 2026-09-30 live 实测，见 backend 文件头）。 */
function turnItem(overrides = {}) {
  return {
    kind: "turn",
    turnId: "t0",
    triggerPromptId: "msg_q1",
    ordinal: 0,
    state: "completed",
    prompt: "hi",
    endedAt: "2026-09-30T12:00:00.000Z",
    durationMs: 1234,
    error: null,
    steps: [],
    ...overrides,
  };
}

/** transcript step 条目（usage/frames 形状锚 = live 实测）。 */
function stepItem(overrides = {}) {
  return {
    stepId: "s0",
    turnId: "t0",
    ordinal: 0,
    state: "completed",
    usage: { inputOther: 100, output: 7, inputCacheRead: 10, inputCacheCreation: 3 },
    llmTiming: { firstTokenMs: 120, totalMs: 900 },
    frames: [{ kind: "text", text: "answer", role: "assistant" }],
    ...overrides,
  };
}

/**
 * spawn 成功所需的最小路由（fresh 轮）。v8 起 spawn 时序 = POST /sessions →
 * GET 会话详情（F3 提交前静默门，idle 即过）→ GET transcript?agent_id=main
 * （preSubmitTurnIds 观察锚——不参与判定）→ POST /prompts；preTurns 即提交前
 * transcript 内容。
 */
function spawnOkRoutes(sessionId = "session_new", preTurns = []) {
  return (url) => {
    if (url === "http://127.0.0.1:4310/api/v1/sessions") return envelope({ id: sessionId });
    if (url === `http://127.0.0.1:4310/api/v1/sessions/${sessionId}`) {
      return detailEnvelope(sessionId, false, false, null);
    }
    if (url === `http://127.0.0.1:4310/api/v1/sessions/${sessionId}/transcript?agent_id=main`) {
      return transcriptEnvelope(preTurns);
    }
    if (url.endsWith(`/api/v1/sessions/${sessionId}/prompts`)) {
      return envelope({ prompt_id: "msg_q1", status: "running" });
    }
    throw new Error(`unexpected ${url}`);
  };
}

/**
 * 事件轮（transcript 轮询）夹具：spawn 阶段（提交前 transcript 读）返回
 * preTurns；markSpawned() 之后每拍按 script 回放（script[i-1] 为第 i 拍的
 * items——数组成员或 (pollNumber) => items 函数；超出脚本长度恒重复最后一项）。
 * polls() 只计事件轮拍数（不含 spawn 的提交前读）。
 */
function turnScriptServer(sessionId, { promptId = "msg_q1", preTurns = [], script = [] } = {}) {
  let spawned = false;
  let polls = 0;
  const handler = (url) => {
    if (url === "http://127.0.0.1:4310/api/v1/sessions") return envelope({ id: sessionId });
    if (url === `http://127.0.0.1:4310/api/v1/sessions/${sessionId}`) {
      return detailEnvelope(sessionId, false, false, null);
    }
    if (url === `http://127.0.0.1:4310/api/v1/sessions/${sessionId}/transcript?agent_id=main`) {
      if (!spawned) return transcriptEnvelope(preTurns);
      polls += 1;
      const entry = script[Math.min(polls - 1, script.length - 1)];
      const items = typeof entry === "function" ? entry(polls) : (entry ?? []);
      return transcriptEnvelope(items);
    }
    if (url.endsWith(`/api/v1/sessions/${sessionId}/prompts`)) {
      return envelope({ prompt_id: promptId, status: "running" });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { handler, markSpawned: () => { spawned = true; }, polls: () => polls };
}

/**
 * 直调 streamEvents 的最小锚（真实派发恒经 spawn 自带归属锚；此形状仅用于错误
 * 路径等与锚内容无关的用例）。promptId 是 v8 的唯一归属键。
 */
function bareAnchor() {
  return { promptId: "msg_q1", submitAt: Date.now() };
}

// ===== ① validateAgentPolicy：通过分支 + 六个拒绝分支 =====

test("kimi-web ①: validateAgentPolicy 通过分支与全部拒绝分支（无 model.id / 空白 model.id / providerID / variant / reasoning / contextWindow / provider / 无 serveUrl / 无 tokenEnv）", () => {
  const backend = new KimiWebBackend({ fetchImpl: async () => { throw new Error("no network expected"); } });
  assert.doesNotThrow(() => backend.validateAgentPolicy(makeAgent()));
  // 上游缺 model 静默秒败——必须 fail-closed 在派发前（任务书实测坑 3）。
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ model: undefined })), /requires model\.id/);
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ model: {} })), /requires model\.id/);
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ model: { id: "" } })), /requires model\.id/);
  // 修复 D：纯空白串与缺失同罪（空白 id 直传上游 = 事实上的缺 model 静默秒败）。
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ model: { id: "   " } })), /requires model\.id/);
  // 修复 D：kimi-web 无 providerID/variant 表达面（防 opencode 迁移配置静默丢路由字段）。
  assert.throws(
    () => backend.validateAgentPolicy(makeAgent({ model: { id: "kimi-code/k3", providerID: "moonshot" } })),
    /cannot express model\.providerID\/model\.variant/,
  );
  assert.throws(
    () => backend.validateAgentPolicy(makeAgent({ model: { id: "kimi-code/k3", variant: "stable" } })),
    /cannot express model\.providerID\/model\.variant/,
  );
  // prompts thinking 字段值形状未实测——不发明映射，配了即拒。
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ reasoning: { effort: "low" } })), /cannot express reasoning/);
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ model: { id: "kimi-code/k3", contextWindow: 200000 } })), /cannot express model\.contextWindow/);
  assert.throws(
    () => backend.validateAgentPolicy(makeAgent({
      provider: { protocol: "anthropic-compatible", baseUrl: "https://probe.invalid", apiKeyEnv: "K" },
    })),
    /cannot express provider/,
  );
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ serveUrl: undefined })), /requires serveUrl/);
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ serveUrl: "   " })), /requires serveUrl/);
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ tokenEnv: undefined })), /requires tokenEnv/);
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ tokenEnv: " " })), /requires tokenEnv/);
});

// ===== ② spawn（fresh 轮）请求形状 =====

test("kimi-web ②: spawn fresh 轮——POST /sessions → GET detail（F3 静默门）→ GET transcript?agent_id=main（preSubmitTurnIds 观察锚）→ POST prompts（时序锚定）；body 形状与 Bearer 头", async () => {
  const { calls, fetchImpl } = kimiServer(spawnOkRoutes());
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "Read README only." });

  assert.equal(handle.backend, "kimi-web");
  assert.equal(handle.backendSessionId, "session_new");
  assert.equal(handle.serveUrl, "http://127.0.0.1:4310");
  assert.equal(handle.cwd, "D:/projects/worktree");
  assert.equal(typeof handle.events, "function");
  assert.equal(typeof handle.abort, "function");
  assert.equal(typeof handle.sendCorrection, "function");
  assert.equal(calls.length, 4, "fresh 轮恰四个请求：建会话 + 提交前静默门 detail + 提交前 transcript 读 + 发 prompt");

  assert.equal(calls[0].url, "http://127.0.0.1:4310/api/v1/sessions");
  assert.equal(calls[0].method, "POST");
  // metadata.cwd 必填（缺则 40001）——用 agent.cwd 填。
  assert.deepEqual(JSON.parse(calls[0].body), {
    title: "wao",
    metadata: { cwd: "D:/projects/worktree" },
  });
  // F3 静默门先行：建会话后先 GET detail 确认 busy/main_turn_active 严格 false，
  // transcript 读才在门后落定。
  assert.equal(calls[1].url, "http://127.0.0.1:4310/api/v1/sessions/session_new");
  assert.equal(calls[1].method, "GET");
  // 提交前 transcript 读必须在 POST prompts 之前（v8 时序）：agent_id 查询参数
  // 恒在场（实测缺则 40001；"main" 有效、"default" 返回空——绝不缺省）。
  assert.equal(calls[2].url, "http://127.0.0.1:4310/api/v1/sessions/session_new/transcript?agent_id=main");
  assert.equal(calls[2].method, "GET");

  assert.equal(calls[3].url, "http://127.0.0.1:4310/api/v1/sessions/session_new/prompts");
  assert.equal(calls[3].method, "POST");
  assert.deepEqual(JSON.parse(calls[3].body), {
    content: [{ type: "text", text: "Read README only." }],
    model: "kimi-code/k3",
    permission_mode: "auto",
  });

  for (const call of calls) {
    assert.equal(call.headers.authorization, `Bearer ${TOKEN_VALUE}`);
  }
});

test("kimi-web ②: roleContract 作为 prompt 前缀（ROLE_TASK_SEPARATOR 衔接，恰好注入一次）", async () => {
  const { calls, fetchImpl } = kimiServer(spawnOkRoutes());
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  await backend.spawn(makeAgent(), { prompt: "task body", roleContract: "ROLE CONTRACT" });
  const promptBody = JSON.parse(calls[3].body);
  // 修复 G：分隔符对齐 kimiCode.js 的 ROLE_TASK_SEPARATOR（"\n\n---\n\n"）。
  assert.equal(promptBody.content[0].text, "ROLE CONTRACT\n\n---\n\ntask body");
  assert.equal(promptBody.content.length, 1, "role 与 task 同在唯一 text 分段里（恰好一次）");
});

test("kimi-web ②: spawn 前置策略门——坏配置在首个 HTTP 请求前拒绝", async () => {
  const { calls, fetchImpl } = kimiServer(() => { throw new Error("no requests expected"); });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  await assert.rejects(() => backend.spawn(makeAgent({ model: undefined }), { prompt: "x" }), /requires model\.id/);
  await assert.rejects(() => backend.spawn(makeAgent({ tokenEnv: "" }), { prompt: "x" }), /requires tokenEnv/);
  assert.equal(calls.length, 0);
});

// ===== ③ resume 轮（session 复用） =====

test("kimi-web ③: resume 轮不 POST /sessions——GET detail（F3 静默门）→ GET transcript?agent_id=main（历史 turn 观测锚）→ 向前任 id 发 prompts", async () => {
  const { calls, fetchImpl } = kimiServer((url) => {
    if (url === "http://127.0.0.1:4310/api/v1/sessions") {
      throw new Error("resume turn must not create a new session");
    }
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_prior") {
      return detailEnvelope("session_prior", false, false, null);
    }
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_prior/transcript?agent_id=main") {
      return transcriptEnvelope([]);
    }
    if (url.endsWith("/api/v1/sessions/session_prior/prompts")) {
      return envelope({ prompt_id: "msg_q2", status: "running" });
    }
    throw new Error(`unexpected ${url}`);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), {
    prompt: "continue",
    sessionReuse: { turn: "resume", priorRunId: "run_prior" },
    priorProviderSessionId: "session_prior",
  });
  assert.equal(handle.backendSessionId, "session_prior");
  assert.equal(calls.length, 3, "resume 轮恰三个请求：提交前静默门 detail + 提交前 transcript 读 + 发 prompt");
  assert.deepEqual(calls.map((c) => c.method), ["GET", "GET", "POST"]);
  assert.equal(calls[0].url, "http://127.0.0.1:4310/api/v1/sessions/session_prior");
  assert.equal(calls[1].url, "http://127.0.0.1:4310/api/v1/sessions/session_prior/transcript?agent_id=main");
  assert.equal(calls[2].url, "http://127.0.0.1:4310/api/v1/sessions/session_prior/prompts");
  assert.deepEqual(JSON.parse(calls[2].body), {
    content: [{ type: "text", text: "continue" }],
    model: "kimi-code/k3",
    permission_mode: "auto",
  });
});

test("kimi-web ③ ⑥: resume——会话已有历史 turn + 新 prompt 的 turn → 只发射新 turn 内容、usage 只计新 turn（triggerPromptId 归属，历史重放按构造不可能）", async () => {
  // 前任轮：triggerPromptId=msg_old（永不等于本轮 prompt_id——误归属与历史重放
  // 按构造不可能，无需任何基线吸收）；usage 刻意取大值（9999）钉"只计新轮"。
  const priorTurn = turnItem({
    turnId: "t_prev",
    triggerPromptId: "msg_old",
    ordinal: 0,
    prompt: "prior question",
    steps: [stepItem({
      stepId: "s_prev",
      turnId: "t_prev",
      frames: [{ kind: "text", text: "prior answer", role: "assistant" }],
      usage: { inputOther: 9999, output: 9999, inputCacheRead: 9999, inputCacheCreation: 9999 },
    })],
  });
  const newTurn = turnItem({
    turnId: "t_new",
    triggerPromptId: "msg_q2",
    ordinal: 1,
    prompt: "continue",
    steps: [stepItem({
      stepId: "s_new",
      turnId: "t_new",
      frames: [{ kind: "text", text: "new answer", role: "assistant" }],
      usage: { inputOther: 40, output: 6, inputCacheRead: 2, inputCacheCreation: 1 },
    })],
  });
  const { handler, markSpawned, polls } = turnScriptServer("session_prior", {
    promptId: "msg_q2",
    preTurns: [priorTurn],
    script: [[priorTurn, newTurn]],
  });
  const { fetchImpl } = kimiServer(handler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), {
    prompt: "continue",
    sessionReuse: { turn: "resume", priorRunId: "run_prior" },
    priorProviderSessionId: "session_prior",
  });
  markSpawned();
  const events = [];
  for await (const ev of handle.events(undefined, { pollInterval: 5 })) {
    events.push(ev);
  }
  assert.deepEqual(events.map((e) => e.kind), ["message", "message", "metrics", "done"]);
  assert.equal(events.at(-1).reason, "completed");
  // 历史轮永不重放：前任 turn 的 prompt/答案都不进事件流。
  assert.ok(!JSON.stringify(events).includes("prior answer"), "前任 assistant 文本不重放");
  assert.ok(!JSON.stringify(events).includes("prior question"), "前任 user prompt 不重放");
  const messages = events.filter((e) => e.kind === "message");
  assert.equal(messages.length, 2, "本轮 user echo（turn.prompt）+ assistant 各一条");
  assert.equal(messages[0].role, "user");
  assert.deepEqual(messages[0].parts, [{ type: "text", text: "continue" }]);
  assert.equal(messages[1].role, "assistant");
  assert.deepEqual(messages[1].parts, [{ type: "text", text: "new answer" }]);
  // usage 只计新 turn 的 steps（9999 不混入）。
  assert.deepEqual(events[2], { kind: "metrics", tokens: { input: 40, output: 6, cacheRead: 2, cacheWrite: 1 } });
  assert.equal(polls(), 1, "首拍即终态（新 turn 已 completed）");
});

test("kimi-web ③: resume 轮缺 prior id / proc_ 占位 / 空串 → 派发前拒绝且零请求（镜像 kimiCode 实现）", async () => {
  const { calls, fetchImpl } = kimiServer(() => { throw new Error("no requests expected"); });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const task = (prior) => ({
    prompt: "x",
    sessionReuse: { turn: "resume", priorRunId: "run_prior" },
    ...(prior === undefined ? {} : { priorProviderSessionId: prior }),
  });
  await assert.rejects(
    () => backend.spawn(makeAgent(), task(undefined)),
    /prior provider session id.*refusing instead of silently starting a fresh kimi web conversation/s,
  );
  await assert.rejects(() => backend.spawn(makeAgent(), task("")), /prior provider session id/);
  await assert.rejects(() => backend.spawn(makeAgent(), task("proc_43244")), /prior provider session id/);
  assert.equal(calls.length, 0);
});

// ===== ④ sendCorrection（在途纠偏） =====

test("kimi-web ④: sendCorrection——POST prompts 排队 + POST prompts:steer；steered:true → ok:true", async () => {
  const steerBodies = [];
  let promptCount = 0;
  const { fetchImpl } = kimiServer((url, init) => {
    if (url === "http://127.0.0.1:4310/api/v1/sessions") return envelope({ id: "session_c" });
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_c") {
      return detailEnvelope("session_c", false, false, null);
    }
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_c/transcript?agent_id=main") {
      return transcriptEnvelope([]);
    }
    if (url.endsWith("/prompts:steer")) {
      steerBodies.push({ body: JSON.parse(init.body), headers: init.headers ?? {} });
      return envelope({ steered: true });
    }
    if (url.endsWith("/prompts")) {
      promptCount += 1;
      return envelope({ prompt_id: `msg_${promptCount}`, status: "running" });
    }
    throw new Error(`unexpected ${url}`);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });

  const res = await handle.sendCorrection("请改为只读方案");
  assert.deepEqual(res, { ok: true });
  assert.equal(steerBodies.length, 1, "恰一次 steer");
  // 排队拿到的 prompt_id 原样进 steer 信封。
  assert.deepEqual(steerBodies[0].body, { prompt_ids: ["msg_2"] });
  assert.equal(steerBodies[0].headers.authorization, `Bearer ${TOKEN_VALUE}`);
});

test("kimi-web ④: sendCorrection 失败腿——40402 无活动轮（code!==0）/ HTTP 错 / steered 非 true / 空文本 → ok:false, reason send_failed", async () => {
  // 腿 1：steer 响应 code=40402 "no active prompt to steer into"（实测无活动轮形状）。
  {
    const { fetchImpl } = kimiServer((url) => {
      if (url === "http://127.0.0.1:4310/api/v1/sessions") return envelope({ id: "session_c" });
      if (url === "http://127.0.0.1:4310/api/v1/sessions/session_c") {
        return detailEnvelope("session_c", false, false, null);
      }
      if (url.endsWith("/transcript?agent_id=main")) return transcriptEnvelope([]);
      if (url.endsWith("/prompts:steer")) {
        return envelope(null, { code: 40402, msg: "no active prompt to steer into" });
      }
      if (url.endsWith("/prompts")) return envelope({ prompt_id: "msg_q", status: "running" });
      throw new Error(`unexpected ${url}`);
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
    assert.deepEqual(
      await handle.sendCorrection("fix"),
      { ok: false, reason: "send_failed" },
      "40402 无活动轮 → fail-closed send_failed",
    );
  }
  // 腿 2：steer HTTP 500。
  {
    const { fetchImpl } = kimiServer((url) => {
      if (url === "http://127.0.0.1:4310/api/v1/sessions") return envelope({ id: "session_c" });
      if (url === "http://127.0.0.1:4310/api/v1/sessions/session_c") {
        return detailEnvelope("session_c", false, false, null);
      }
      if (url.endsWith("/transcript?agent_id=main")) return transcriptEnvelope([]);
      if (url.endsWith("/prompts:steer")) return jsonResponse({ code: 0, msg: "boom", data: null }, 500);
      if (url.endsWith("/prompts")) return envelope({ prompt_id: "msg_q", status: "running" });
      throw new Error(`unexpected ${url}`);
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
    assert.deepEqual(await handle.sendCorrection("fix"), { ok: false, reason: "send_failed" });
  }
  // 腿 3：steered 非 true（上游返 success 但未转入活动轮）。
  {
    const { fetchImpl } = kimiServer((url) => {
      if (url === "http://127.0.0.1:4310/api/v1/sessions") return envelope({ id: "session_c" });
      if (url === "http://127.0.0.1:4310/api/v1/sessions/session_c") {
        return detailEnvelope("session_c", false, false, null);
      }
      if (url.endsWith("/transcript?agent_id=main")) return transcriptEnvelope([]);
      if (url.endsWith("/prompts:steer")) return envelope({ steered: false });
      if (url.endsWith("/prompts")) return envelope({ prompt_id: "msg_q", status: "running" });
      throw new Error(`unexpected ${url}`);
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
    assert.deepEqual(await handle.sendCorrection("fix"), { ok: false, reason: "send_failed" });
  }
  // 腿 4：空文本直接拒绝（有界闭集 reason，不透传错误细节）。
  {
    const { fetchImpl } = kimiServer(spawnOkRoutes());
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
    assert.deepEqual(await handle.sendCorrection(""), { ok: false, reason: "send_failed" });
  }
});


// ===== ⑤ events 轮询生成器：transcript 轮次终态原语（triggerPromptId 归属 +
// state 终态闭集） =====

test("kimi-web ⑤ ①: completed 轮——turn 挂 triggerPromptId、frames 带 assistant text → 首拍发射 tool 帧证据 + 全文 + usage + completed（thinking 帧不投影、无 role 的 text 帧宽容计入；tool 帧证据先行）", async () => {
  // tool 帧形状 = 2026-10-01 live 探针（delta 证据链）：{kind:"tool", frameId,
  // toolCallId, name, state, input, output}。四类投影各占一帧：Write(done)、
  // Bash(done)、Read(未知类)、Bash(state=error)——逐条 deepEqual 见断言区。
  const turn = turnItem({
    steps: [
      stepItem({
        stepId: "s0",
        frames: [
          { kind: "thinking", text: "(internal reasoning)" },
          {
            kind: "tool", frameId: "f_w", toolCallId: "tc_write", name: "Write", state: "done",
            input: { path: "wao_perm_probe.txt", content: "probe" },
            output: "Wrote 5 bytes to wao_perm_probe.txt",
          },
          { kind: "text", text: "Hello", role: "assistant" },
        ],
        usage: { inputOther: 100, output: 7, inputCacheRead: 10, inputCacheCreation: 3 },
      }),
      stepItem({
        stepId: "s1",
        ordinal: 1,
        frames: [
          {
            kind: "tool", frameId: "f_b", toolCallId: "tc_bash", name: "Bash", state: "done",
            input: { command: "node scripts/probe.mjs" }, output: "probe ok",
          },
          {
            kind: "tool", frameId: "f_r", toolCallId: "tc_read", name: "Read", state: "done",
            input: { path: "README.md" }, output: "readme body",
          },
          {
            kind: "tool", frameId: "f_e", toolCallId: "tc_err", name: "Bash", state: "error",
            input: { command: "node scripts/failing.mjs" }, output: "exit status 1",
          },
          { kind: "text", text: " world" }, // 无 role 的 text 帧（实测宽容形状）
        ],
        usage: { inputOther: 50, output: 5, inputCacheRead: 10, inputCacheCreation: 3 },
      }),
    ],
  });
  const { handler, markSpawned, polls } = turnScriptServer("session_c1", { script: [[turn]] });
  const { fetchImpl } = kimiServer(handler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  const events = [];
  for await (const ev of handle.events(undefined, { pollInterval: 5 })) {
    events.push(ev);
  }
  // 事件顺序（证据先行，同 opencode 惯例）：tool 帧证据逐帧（投影事件 + 终态
  // tool_result）→ user echo → assistant text → metrics → done(completed)。
  assert.deepEqual(
    events.map((e) => e.kind),
    [
      "file_written", "tool_result", // s0: Write 帧（done）
      "command", "tool_result", // s1: Bash 帧（done）
      "tool_use", "tool_result", // s1: Read 帧（非 bash/write 类 → toolUseEvent）
      "command", "tool_result", // s1: Bash 帧（state=error → isError:true）
      "message", "message", "metrics", "done",
    ],
    "tool 帧证据先行（8 条）→ user echo → assistant text → metrics → done",
  );
  // Write 帧 → fileWrittenEvent 带 path（live 探针形状：input.path）。
  assert.deepEqual(events[0], { kind: "file_written", path: "wao_perm_probe.txt" });
  assert.deepEqual(
    events[1],
    { kind: "tool_result", tool: "tc_write", output: "Wrote 5 bytes to wao_perm_probe.txt", isError: false },
  );
  // bash 帧 → commandEvent（kimi 无已证实退出码通道——reportsCommandExitCode=
  // false，exitCode 恒省略；toolCallId 关联 tool_result）。
  assert.deepEqual(
    events[2],
    { kind: "command", command: "node scripts/probe.mjs", toolCallId: "tc_bash" },
  );
  assert.deepEqual(
    events[3],
    { kind: "tool_result", tool: "tc_bash", output: "probe ok", isError: false },
  );
  // 未知工具（非 bash/shell、非 write/edit/multiedit）→ toolUseEvent(name, input)。
  assert.deepEqual(events[4], { kind: "tool_use", tool: "Read", input: { path: "README.md" } });
  assert.deepEqual(
    events[5],
    { kind: "tool_result", tool: "tc_read", output: "readme body", isError: false },
  );
  // 错误 state（error）→ toolResultEvent isError:true。
  assert.deepEqual(
    events[6],
    { kind: "command", command: "node scripts/failing.mjs", toolCallId: "tc_err" },
  );
  assert.deepEqual(
    events[7],
    { kind: "tool_result", tool: "tc_err", output: "exit status 1", isError: true },
  );
  // 消息投影不变：user echo → assistant text（跨 step 按序拼接；tool/thinking
  // 帧不入文本）。
  assert.equal(events[8].role, "user");
  assert.deepEqual(events[8].parts, [{ type: "text", text: "hi" }]);
  assert.equal(events[9].role, "assistant");
  assert.deepEqual(
    events[9].parts,
    [{ type: "text", text: "Hello world" }],
    "两 step 的 text 帧按序拼接为单条 assistant text",
  );
  assert.ok(!JSON.stringify(events).includes("internal reasoning"), "thinking 帧内容不进事件流");
  // ⑩ reportsTokenUsage=true 的 metrics 事件形状：steps[].usage 求和（1:1 映射
  // inputOther→input / output→output / inputCacheRead→cacheRead /
  // inputCacheCreation→cacheWrite；reasoning/costUsd 无 kimi 对应字段——省略）。
  assert.deepEqual(
    events[10],
    { kind: "metrics", tokens: { input: 150, output: 12, cacheRead: 20, cacheWrite: 6 } },
  );
  assert.equal(events[11].reason, "completed");
  assert.equal(polls(), 1, "首拍即终态——轮次原语无需等待窗口/稳定性重读");
});

test("kimi-web ⑤: 混合帧 completed 轮（thinking + tool + text）→ tool 帧证据先于 assistant message（证据先行，同 opencode 惯例；thinking 帧不投影）", async () => {
  const turn = turnItem({
    steps: [stepItem({
      stepId: "s0",
      frames: [
        { kind: "thinking", text: "(plan the probe write)" },
        {
          kind: "tool", frameId: "f_m", toolCallId: "tc_mixed", name: "Write", state: "done",
          input: { path: "out/probe.txt", content: "payload" },
          output: "Wrote 7 bytes to out/probe.txt",
        },
        { kind: "text", text: "wrote the probe file", role: "assistant" },
      ],
      usage: { inputOther: 10, output: 4, inputCacheRead: 1, inputCacheCreation: 1 },
    })],
  });
  const { handler, markSpawned, polls } = turnScriptServer("session_mix", { script: [[turn]] });
  const { fetchImpl } = kimiServer(handler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  const events = [];
  for await (const ev of handle.events(undefined, { pollInterval: 5 })) {
    events.push(ev);
  }
  assert.deepEqual(
    events.map((e) => e.kind),
    ["file_written", "tool_result", "message", "message", "metrics", "done"],
    "顺序锁死：tool 帧证据（file_written + tool_result）→ user echo → assistant message → metrics → done",
  );
  const assistantIndex = events.findIndex((e) => e.kind === "message" && e.role === "assistant");
  const evidenceIndexes = events
    .map((e, i) => (["command", "file_written", "tool_use", "tool_result"].includes(e.kind) ? i : -1))
    .filter((i) => i >= 0);
  assert.ok(evidenceIndexes.length > 0, "tool 帧证据事件在场");
  assert.ok(
    evidenceIndexes.every((i) => i < assistantIndex),
    "全部 tool 帧证据事件先于 assistant message",
  );
  assert.deepEqual(events[0], { kind: "file_written", path: "out/probe.txt" });
  assert.deepEqual(
    events[1],
    { kind: "tool_result", tool: "tc_mixed", output: "Wrote 7 bytes to out/probe.txt", isError: false },
  );
  assert.deepEqual(events[3].parts, [{ type: "text", text: "wrote the probe file" }]);
  assert.ok(!JSON.stringify(events).includes("plan the probe write"), "thinking 帧内容不进事件流");
  assert.equal(events.at(-1).reason, "completed");
  assert.equal(polls(), 1);
});

test("kimi-web ⑤: tool 帧 state 非终态 / 写帧缺 path → 终态闭集 done|error|failed 之外不追加 tool_result、无 path 不虚构 file_written（镜像 opencodeServe 的 terminal-status 门）", async () => {
  // 腿 1：bash 帧 state:"running"（终态闭集外的任意非终态值代表形状）→ 只投影
  // commandEvent，无 tool_result——闭集外 state 绝不猜成终态。
  {
    const turn = turnItem({
      steps: [stepItem({
        usage: undefined,
        frames: [
          {
            kind: "tool", frameId: "f_r", toolCallId: "tc_run", name: "Bash", state: "running",
            input: { command: "node scripts/watch.mjs" },
          },
          { kind: "text", text: "still working", role: "assistant" },
        ],
      })],
    });
    const { handler, markSpawned } = turnScriptServer("session_tr", { script: [[turn]] });
    const { fetchImpl } = kimiServer(handler);
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
    markSpawned();
    const events = [];
    for await (const ev of handle.events(undefined, { pollInterval: 5 })) {
      events.push(ev);
    }
    assert.deepEqual(
      events.map((e) => e.kind),
      ["command", "message", "message", "done"],
      "非终态 tool 帧：投影事件在场、tool_result 缺席",
    );
    assert.deepEqual(
      events[0],
      { kind: "command", command: "node scripts/watch.mjs", toolCallId: "tc_run" },
    );
    assert.ok(!events.some((e) => e.kind === "tool_result"));
    assert.equal(events.at(-1).reason, "completed");
  }
  // 腿 2：Write 帧 input 缺 path/file_path → 不虚构 file_written；终态
  // tool_result 仍按 state 投影（与 opencodeServe 逐 part 双事件形状一致）。
  {
    const turn = turnItem({
      steps: [stepItem({
        usage: undefined,
        frames: [
          {
            kind: "tool", frameId: "f_np", toolCallId: "tc_nopath", name: "Write", state: "done",
            input: { content: "no target path" }, output: "nothing written",
          },
          { kind: "text", text: "no path case", role: "assistant" },
        ],
      })],
    });
    const { handler, markSpawned } = turnScriptServer("session_np", { script: [[turn]] });
    const { fetchImpl } = kimiServer(handler);
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
    markSpawned();
    const events = [];
    for await (const ev of handle.events(undefined, { pollInterval: 5 })) {
      events.push(ev);
    }
    assert.deepEqual(
      events.map((e) => e.kind),
      ["tool_result", "message", "message", "done"],
      "无 path 的 Write 帧：零 file_written、终态 tool_result 在场",
    );
    assert.deepEqual(
      events[0],
      { kind: "tool_result", tool: "tc_nopath", output: "nothing written", isError: false },
    );
    assert.ok(!events.some((e) => e.kind === "file_written"));
  }
});

test("kimi-web ⑤ ⑩: completed 轮 steps 无 usage 数据 → 不发 metrics 事件（绝不虚构零值通道）", async () => {
  const turn = turnItem({
    steps: [stepItem({
      usage: undefined,
      frames: [{ kind: "text", text: "answer without usage", role: "assistant" }],
    })],
  });
  const { handler, markSpawned, polls } = turnScriptServer("session_c2", { script: [[turn]] });
  const { fetchImpl } = kimiServer(handler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  const events = [];
  for await (const ev of handle.events(undefined, { pollInterval: 5 })) {
    events.push(ev);
  }
  assert.deepEqual(
    events.map((e) => e.kind),
    ["message", "message", "done"],
    "usage 数据全缺席 ⇒ 零 metrics 事件（reportsTokenUsage=true 只在有实测数据时发射）",
  );
  assert.equal(events.at(-1).reason, "completed");
  assert.deepEqual(events[1].parts, [{ type: "text", text: "answer without usage" }]);
  assert.equal(polls(), 1);
});

test("kimi-web ⑤ ②: failed 轮（state=failed + error:'Model not set'——live 实测形状）→ 首拍 done(failed, error)，缺 model 静默秒败是一等公民事实", async () => {
  const turn = turnItem({
    state: "failed",
    error: "Model not set",
    endedAt: "2026-09-30T12:00:01.000Z",
    durationMs: 12,
    steps: [],
  });
  const { handler, markSpawned, polls } = turnScriptServer("session_f1", { script: [[turn]] });
  const { fetchImpl } = kimiServer(handler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  const events = [];
  const start = Date.now();
  for await (const ev of handle.events(undefined, { pollInterval: 5, silentTimeout: 60_000 })) {
    events.push(ev);
  }
  assert.equal(events.length, 1, "failed 轮恰一个 done 事件");
  assert.equal(events[0].reason, "failed");
  assert.match(events[0].error, /Model not set/, "turn.error 字段原样透传");
  assert.match(events[0].error, /turn state=failed/);
  assert.equal(polls(), 1, "秒级收口——终态原语，无需归属推断/等待窗口/超时兜底");
  assert.ok(Date.now() - start < 2000);
});

test("kimi-web ⑤: cancelled 轮（终态闭集成员）→ done(failed, 固定文案)；error 字段缺席不虚构原因（failed/cancelled 两腿）", async () => {
  // 腿 1：cancelled 且 error=null（缺席）——固定文案，绝不虚构原因。
  {
    const turn = turnItem({ state: "cancelled", error: null, steps: [] });
    const { handler, markSpawned } = turnScriptServer("session_cc", { script: [[turn]] });
    const { fetchImpl } = kimiServer(handler);
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
    markSpawned();
    const events = [];
    for await (const ev of handle.events(undefined, { pollInterval: 5 })) {
      events.push(ev);
    }
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "failed", "cancelled 也是终态——按 failed 收口");
    assert.match(events[0].error, /kimi turn cancelled/);
    assert.match(events[0].error, /no error field upstream/);
  }
  // 腿 2：failed 且 error=null——同一固定文案形状。
  {
    const turn = turnItem({ state: "failed", error: null, steps: [] });
    const { handler, markSpawned } = turnScriptServer("session_fn", { script: [[turn]] });
    const { fetchImpl } = kimiServer(handler);
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
    markSpawned();
    const events = [];
    for await (const ev of handle.events(undefined, { pollInterval: 5 })) {
      events.push(ev);
    }
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "failed");
    assert.match(events[0].error, /kimi turn failed/);
    assert.match(events[0].error, /no error field upstream/);
  }
});

test("kimi-web ⑤ ③: running→completed 两拍转移——首拍等待（非终态）、次拍终态发射", async () => {
  const running = turnItem({
    state: "running",
    endedAt: null,
    durationMs: null,
    steps: [stepItem({ state: "running", frames: [] })],
  });
  const completed = turnItem({
    steps: [stepItem({ frames: [{ kind: "text", text: "slow answer", role: "assistant" }] })],
  });
  const { handler, markSpawned, polls } = turnScriptServer("session_rc", {
    script: [[running], [completed]],
  });
  const { fetchImpl } = kimiServer(handler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  const events = [];
  for await (const ev of handle.events(undefined, { pollInterval: 5 })) {
    events.push(ev);
  }
  assert.deepEqual(events.map((e) => e.kind), ["message", "message", "metrics", "done"]);
  assert.equal(events.at(-1).reason, "completed");
  assert.deepEqual(events[1].parts, [{ type: "text", text: "slow answer" }]);
  assert.equal(events[2].kind, "metrics");
  assert.equal(polls(), 2, "恰两拍：拍 1 running（等待）、拍 2 completed（终态发射）");
});

test("kimi-web ⑤ ④: 提交滞后——首拍无本轮 turn（他人 turn 在场也不误领）、silentTimeout 到期仍无 → silent fail（相对提交时刻）", async () => {
  // 他人/前任轮：triggerPromptId=msg_FOREIGN ≠ 本轮 msg_q1——归属键不命中，
  // 绝不误领（单 actor 假设破裂形状的 fail-closed 出口）。
  const foreign = turnItem({
    turnId: "t_fx",
    triggerPromptId: "msg_FOREIGN",
    prompt: "someone else's question",
    steps: [stepItem({
      stepId: "s_fx",
      turnId: "t_fx",
      frames: [{ kind: "text", text: "foreign answer", role: "assistant" }],
      usage: { inputOther: 1, output: 1, inputCacheRead: 1, inputCacheCreation: 1 },
    })],
  });
  const { handler, markSpawned, polls } = turnScriptServer("session_lag", {
    script: [[foreign]], // 恒无本轮 turn（提交滞后的持续形状）
  });
  const { fetchImpl } = kimiServer(handler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  const events = [];
  const start = Date.now();
  // pollInterval 30ms：silentTimeout=120ms 的静默退出在第 ~5 拍触发。
  for await (const ev of handle.events(undefined, { pollInterval: 30, silentTimeout: 120 })) {
    events.push(ev);
  }
  const done = events.at(-1);
  assert.equal(done.reason, "failed");
  assert.match(done.error ?? "", /silent timeout: turn for this prompt not observed within 120ms/);
  assert.ok(events.length === 1 && !JSON.stringify(events).includes("foreign answer"), "他人轮内容绝不误领/发射");
  assert.ok(polls() >= 2, `持续等待多拍（实际 ${polls()} 拍）后诚实退出`);
  assert.ok(Date.now() - start < 2000);
});

test("kimi-web ⑤ ⑤a (TD-197①): queued/慢启动静默不再被 8 拍门误杀；静默段 ≥ 自适应预算（60s floor）才 bounded fail", async () => {
  const stalled = turnItem({
    state: "running",
    endedAt: null,
    durationMs: null,
    steps: [stepItem({ state: "running", frames: [] })],
  });
  const { handler, markSpawned, polls } = turnScriptServer("session_st", { script: [[stalled]] });
  // TD-197① 时钟注入缝：假钟在每拍 transcript 轮询请求时推进 10s（停滞轮不产
  // 出事件，钟必须由轮询驱动而非事件驱动）。首拍 turn 现身=进展（noteProgress
  // 基线）；此后每拍静默 +10s——第 6 拍 50s < 60s floor 仍存活（旧 8 拍门在第
  // 9 拍早已误杀），第 7 拍 60s ≥ floor 才收口。
  let fakeNow = 0;
  const clock = () => fakeNow;
  const clockedHandler = (url) => {
    if (url.includes("/transcript")) fakeNow += 10_000;
    return handler(url);
  };
  const { fetchImpl } = kimiServer(clockedHandler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  const events = [];
  const start = Date.now();
  for await (const ev of handle.events(undefined, { pollInterval: 1, stallClock: clock })) {
    events.push(ev);
  }
  assert.equal(events.length, 1, "停滞轮恰一个 done 事件（零 message）");
  const done = events[0];
  assert.equal(done.reason, "failed");
  assert.match(done.error, /turn stalled \(no progress\)/);
  assert.match(done.error, /adaptive budget/);
  assert.match(done.error, /60000ms floor/);
  assert.equal(polls(), 7, "首拍基线 + 6 拍 50s 内存活 + 第 7 拍 60s≥floor 收口");
  assert.ok(Date.now() - start < 2000, "假钟驱动，零真实等待");
});



test("kimi-web ⑤ ⑤b: 有增长 → 计数清零不误触发——每拍 frames 文本增长（>8 拍仍在写），第 9 拍 completed 正常完成（绝不 no-progress 误杀）", async () => {
  // 每拍文本 +1 字符（signature 变化 = 进展 = 清零）；若无清零，第 8 拍已误触
  // 发 no-progress——本用例的存在即证明清零发生。（script 函数成员返回 items
  // 数组——见 turnScriptServer 契约。）
  const growing = (poll) => [turnItem({
    state: "running",
    endedAt: null,
    durationMs: null,
    steps: [stepItem({
      state: "running",
      frames: [{ kind: "text", text: "x".repeat(poll), role: "assistant" }],
    })],
  })];
  const completed = [turnItem({
    steps: [stepItem({ frames: [{ kind: "text", text: "xxxxxxxx", role: "assistant" }] })],
  })];
  const { handler, markSpawned, polls } = turnScriptServer("session_gr", {
    script: [growing, growing, growing, growing, growing, growing, growing, growing, completed],
  });
  const { fetchImpl } = kimiServer(handler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  const events = [];
  for await (const ev of handle.events(undefined, { pollInterval: 5 })) {
    events.push(ev);
  }
  const done = events.at(-1);
  assert.equal(done.reason, "completed", "8+ 拍持续增长的健康轮绝不 no-progress 误杀");
  assert.ok(!JSON.stringify(events).includes("turn stalled"), "从未走无进展出口");
  const messages = events.filter((e) => e.kind === "message");
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1].parts, [{ type: "text", text: "xxxxxxxx" }]);
  assert.equal(polls(), 9, "8 拍增长 + 第 9 拍终态");
});

test("kimi-web ⑤ ⑨: onPollTick 每拍恰一次（tick 数 = transcript 轮询拍数）——首 tick 抛错不杀流（best-effort）", async () => {
  const running = turnItem({ state: "running", endedAt: null, durationMs: null, steps: [] });
  const completed = turnItem({
    steps: [stepItem({ frames: [{ kind: "text", text: "done", role: "assistant" }] })],
  });
  const { handler, markSpawned, polls } = turnScriptServer("session_tk", {
    script: [[running], [running], [completed]],
  });
  const { fetchImpl } = kimiServer(handler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  const events = [];
  let ticks = 0;
  let tickThrew = false;
  for await (const ev of handle.events(undefined, {
    pollInterval: 5,
    // 注入 fake onPollTick——第一次抛错，验证 best-effort 语义。
    onPollTick: async () => {
      ticks += 1;
      if (ticks === 1) {
        tickThrew = true;
        throw new Error("tick blew up (must be best-effort)");
      }
    },
  })) {
    events.push(ev);
  }
  assert.ok(tickThrew, "第一次 tick 确实抛错");
  assert.equal(events.at(-1).reason, "completed", "钩子抛错是 best-effort，不杀死事件流");
  assert.equal(ticks, polls(), "每拍恰一次（tick 数 = transcript 轮询拍数）");
  assert.equal(ticks, 3);
});

test("kimi-web ⑤ ⑦: completed 但 frames 无 assistant text（仅 thinking / 纯空白 text / role=user 的 text / 仅 tool 帧）→ 不伪造完成——done(failed) 收口（N1 教训），零 message 事件", async () => {
  // 腿 1：steps 只有 thinking 帧（无 text）。
  {
    const turn = turnItem({
      steps: [stepItem({ frames: [{ kind: "thinking", text: "(only reasoning)" }] })],
    });
    const { handler, markSpawned, polls } = turnScriptServer("session_e1", { script: [[turn]] });
    const { fetchImpl } = kimiServer(handler);
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
    markSpawned();
    const events = [];
    for await (const ev of handle.events(undefined, { pollInterval: 5 })) {
      events.push(ev);
    }
    assert.equal(events.length, 1, "传输成功不是可用答案——绝不伪造完成");
    assert.equal(events[0].reason, "failed");
    assert.match(events[0].error, /completed without assistant text/);
    assert.equal(polls(), 1);
  }
  // 腿 2：text 帧恒为纯空白（拼接后 trim 为空）。
  {
    const turn = turnItem({
      steps: [stepItem({ frames: [
        { kind: "text", text: "   ", role: "assistant" },
        { kind: "text", text: " " },
      ] })],
    });
    const { handler, markSpawned } = turnScriptServer("session_e2", { script: [[turn]] });
    const { fetchImpl } = kimiServer(handler);
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
    markSpawned();
    const events = [];
    for await (const ev of handle.events(undefined, { pollInterval: 5 })) {
      events.push(ev);
    }
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "failed");
    assert.match(events[0].error, /completed without assistant text/);
  }
  // 腿 3：text 帧带 role="user"（非 assistant、role 在场）——宽容规则不收入。
  {
    const turn = turnItem({
      steps: [stepItem({ frames: [{ kind: "text", text: "user echo frame", role: "user" }] })],
    });
    const { handler, markSpawned } = turnScriptServer("session_e3", { script: [[turn]] });
    const { fetchImpl } = kimiServer(handler);
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
    markSpawned();
    const events = [];
    for await (const ev of handle.events(undefined, { pollInterval: 5 })) {
      events.push(ev);
    }
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "failed");
    assert.match(events[0].error, /completed without assistant text/);
  }
  // 腿 4（tool 帧证据投影的空文本门在先）：completed 轮有 tool 帧（模型真干了
  // 活）但零 assistant text → 仍按 failed 收口、**零证据发射**（N1 语义不因证据
  // 面扩张而松动：无文本的 completed 轮是失败形状，证据只在成功发射路径投影）。
  {
    const turn = turnItem({
      steps: [stepItem({
        frames: [
          {
            kind: "tool", frameId: "f_w2", toolCallId: "tc_w2", name: "Write", state: "done",
            input: { path: "wao_perm_probe.txt", content: "probe" }, output: "Wrote 5 bytes",
          },
        ],
      })],
    });
    const { handler, markSpawned } = turnScriptServer("session_e4", { script: [[turn]] });
    const { fetchImpl } = kimiServer(handler);
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
    markSpawned();
    const events = [];
    for await (const ev of handle.events(undefined, { pollInterval: 5 })) {
      events.push(ev);
    }
    assert.equal(events.length, 1, "tool 帧不改变空文本门的零发射语义");
    assert.equal(events[0].reason, "failed");
    assert.match(events[0].error, /completed without assistant text/);
    assert.ok(!events.some((e) => e.kind === "file_written"), "空文本门在证据投影之前——零 file_written");
  }
});

test("kimi-web ⑤ ⑧: transcript 响应缺 items 数组 → 固定错误 fail-closed（事件流 done(failed) 腿 + spawn 提交前读上抛腿）", async () => {
  // 腿 1：事件流轮询读——transcript 信封缺 data.items。
  {
    const { fetchImpl } = kimiServer((url) => {
      if (url.endsWith("/transcript?agent_id=main")) return envelope({ seq: 7, has_more: false });
      throw new Error(`unexpected ${url}`);
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const events = [];
    for await (const ev of backend.streamEvents(makeAgent(), "ses_m8", { interval: 5, turnAnchor: bareAnchor() })) {
      events.push(ev);
    }
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "failed");
    assert.match(events[0].error, /transcript response malformed/);
    assert.match(events[0].error, /items array is required/);
  }
  // 腿 2：spawn 提交前 transcript 读——同一固定错误在 spawn 侧上抛（绝不回落
  // 猜测形状继续提交）。
  {
    const { calls, fetchImpl } = kimiServer((url) => {
      if (url === "http://127.0.0.1:4310/api/v1/sessions") return envelope({ id: "session_m9" });
      if (url === "http://127.0.0.1:4310/api/v1/sessions/session_m9") {
        return detailEnvelope("session_m9", false, false, null);
      }
      if (url === "http://127.0.0.1:4310/api/v1/sessions/session_m9/transcript?agent_id=main") {
        return envelope({ seq: 7 });
      }
      throw new Error(`unexpected ${url}`);
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    await assert.rejects(
      () => backend.spawn(makeAgent(), { prompt: "hi" }),
      /transcript response malformed/,
    );
    assert.ok(
      calls.every((c) => c.method === "GET" || c.url.endsWith("/api/v1/sessions")),
      "形状不可信即整体不可信——缺 items 后零 POST prompts",
    );
  }
});

test("kimi-web ⑤: 轮询 HTTP 连续失败（重试耗尽）→ done(failed, 错误消息)", async () => {
  const { fetchImpl } = kimiServer(() => {
    const error = new TypeError("fetch failed");
    error.cause = new Error("ECONNRESET");
    error.cause.code = "ECONNRESET";
    throw error;
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents(makeAgent(), "ses_x", { interval: 5, turnAnchor: bareAnchor() })) {
    events.push(ev);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "done");
  assert.equal(events[0].reason, "failed");
  assert.ok(events[0].error.includes("fetch failed"));
});

test("kimi-web ⑤ ⑪: code!==0 信封（40001——agent_id 查询参数缺省时的服务器形状；客户端恒发 agent_id=main 绝不自伤，见 ② 的 URL 锚定）→ done(failed, 含 code 与 msg)", async () => {
  const { fetchImpl } = kimiServer((url) => {
    if (url.endsWith("/transcript?agent_id=main")) {
      return envelope(null, { code: 40001, msg: "agent_id is required" });
    }
    throw new Error(`unexpected ${url}`);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents(makeAgent(), "ses_code", { interval: 5, turnAnchor: bareAnchor() })) {
    events.push(ev);
  }
  assert.equal(events[0].reason, "failed");
  assert.match(events[0].error, /code 40001/);
  assert.match(events[0].error, /agent_id is required/);
});

test("kimi-web ⑤: signal.aborted → 静默结束（不 emit done）", async () => {
  const running = turnItem({ state: "running", endedAt: null, durationMs: null, steps: [] });
  const { fetchImpl } = kimiServer((url) => {
    if (url.endsWith("/transcript?agent_id=main")) return transcriptEnvelope([running]);
    throw new Error(`unexpected ${url}`);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const controller = new AbortController();
  const events = [];
  setTimeout(() => controller.abort(), 30);
  for await (const ev of backend.streamEvents(makeAgent(), "ses_a", {
    interval: 5,
    signal: controller.signal,
    turnAnchor: bareAnchor(),
  })) {
    events.push(ev);
  }
  assert.equal(events.length, 0, "abort 时流静默结束（终态归 RunManager）");
});

test("kimi-web ⑤: 闭集外未知 state 值 → 一律非终态（fail-closed 等待，绝不猜终态），由 R9 F4 unsupported-state 有界出口收口", async () => {
  // state 闭集 = queued|running|completed|failed|cancelled（live 实测）；
  // 闭集外值（上游升级/形状漂移）既不判完成也不判失败——等，但有界：R9 F4
  // 连续 8 拍仍闭集外 → done(failed, "unsupported turn state")（首拍即计数——
  // turn 出现任不能算"闭集外 state 的进展"）。
  const weird = turnItem({ state: "banana", steps: [] });
  const { handler, markSpawned, polls } = turnScriptServer("session_wz", { script: [[weird]] });
  const { fetchImpl } = kimiServer(handler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  const events = [];
  for await (const ev of handle.events(undefined, { pollInterval: 5 })) {
    events.push(ev);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "failed");
  assert.match(events[0].error, /unsupported turn state: banana/);
  assert.equal(polls(), 8, "连续 8 拍闭集外即退出——未知状态绝不无限等待也绝不猜终态");
});

// ===== ⑥ abort：无会话级中止通道 =====

test("kimi-web ⑥: abort 抛固定错误且绝不调用 /api/v1/shutdown（也不探 cancel/interrupt 动作）", async () => {
  const { calls, fetchImpl } = kimiServer((url) => {
    if (url.includes("/api/v1/shutdown")) {
      throw new Error("server-level shutdown must never be called by the backend");
    }
    return spawnOkRoutes()(url);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  await assert.rejects(() => handle.abort(), /no session-level abort channel/);
  assert.ok(!calls.some((c) => c.url.includes("/api/v1/shutdown")), "绝不请求服务器级 shutdown（共享服务器会误杀无关会话）");
  assert.ok(!calls.some((c) => /cancel|interrupt|abort/.test(c.url)), "不虚构上游不存在的中止动作名");
});

test("kimi-web ⑥: handle 探针按 runManager/opencodeStopVerify 真实调用形状 (serveUrl, sessionId, {cwd}) 可观察 busy——sessionStatus busy 投影 + session detail + messages 页形状；serveUrl 形参可忽略", async () => {
  // F3 静默门后夹具分相：spawn 期（静默门 + transcript 读）idle 放行；探针期翻
  // busy——"探针可观察 busy"的意图不变（静默门只约束提交前）。
  let probePhase = false;
  const { calls, fetchImpl } = kimiServer((url) => {
    if (url === "http://127.0.0.1:4310/api/v1/sessions") return envelope({ id: "session_p" });
    if (url.endsWith("/api/v1/sessions/session_p/prompts")) {
      return envelope({ prompt_id: "msg_q1", status: "running" });
    }
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_p") {
      return detailEnvelope("session_p", probePhase, probePhase, null);
    }
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_p/transcript?agent_id=main") {
      return transcriptEnvelope([]);
    }
    if (url.endsWith("/api/v1/sessions/session_p/messages")) {
      return envelope({ items: [{ id: "msg_x", role: "user", content: [] }] });
    }
    throw new Error(`unexpected ${url}`);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const agent = makeAgent();
  const handle = await backend.spawn(agent, { prompt: "hi" });
  probePhase = true;
  assert.equal(typeof handle.session, "function");
  assert.equal(typeof handle.messages, "function");
  assert.equal(typeof handle.sessionStatus, "function");
  // #1：runManager._runCleanup / opencodeStopVerify.sample 的真实调用形状——传
  // 错误的 serveUrl 也必须工作（形参被忽略，会话身份来自 spawn 闭包）。
  const wrongServeUrl = "http://10.255.255.1:9";
  const status = await handle.sessionStatus(wrongServeUrl, handle.backendSessionId, { cwd: handle.cwd });
  assert.deepEqual(status, { type: "busy" }, "busy 投影对齐 opencodeServe.sessionStatus 返回形状");
  const detail = await handle.session(wrongServeUrl, handle.backendSessionId, { cwd: handle.cwd });
  assert.equal(detail.busy, true);
  assert.equal(detail.main_turn_active, true);
  const page = await handle.messages(wrongServeUrl, handle.backendSessionId, { cwd: handle.cwd });
  assert.ok(Array.isArray(page?.data), "messages 返回 {data} 页形状（sample 读 page?.data 计数）");
  assert.equal(page.data.length, 1);
  // 探针是只读 GET（spawn 的建会话 POST + 静默门 detail GET + 提交前 transcript
  // GET + 发 prompt POST 之后不再有写请求）。
  assert.equal(calls.length, 7);
  assert.deepEqual(calls.slice(4).map((c) => c.method), ["GET", "GET", "GET"]);
});

test("kimi-web ⑥: verifyStopQuiet 真实消费者闭环——idle 静默会话 → quiet:true；busy 会话 → quiet:false(session_status)", async () => {
  // 腿 1：idle + 消息不增长 → {quiet:true}（kimi-web 探针经 sessionStatus 投影
  // 第一次真正可观察——不再恒 stop_unverified）。
  {
    const { fetchImpl } = kimiServer((url) => {
      if (url === "http://127.0.0.1:4310/api/v1/sessions") return envelope({ id: "session_v" });
      if (url.endsWith("/api/v1/sessions/session_v/prompts")) {
        return envelope({ prompt_id: "msg_q1", status: "running" });
      }
      if (url === "http://127.0.0.1:4310/api/v1/sessions/session_v") {
        return detailEnvelope("session_v", false, false, "completed");
      }
      if (url === "http://127.0.0.1:4310/api/v1/sessions/session_v/transcript?agent_id=main") {
        return transcriptEnvelope([]);
      }
      if (url.endsWith("/api/v1/sessions/session_v/messages")) {
        return envelope({ items: [{ id: "msg_x", role: "user", content: [] }] });
      }
      throw new Error(`unexpected ${url}`);
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
    const result = await verifyStopQuiet(handle, handle.serveUrl, handle.backendSessionId, {
      cwd: handle.cwd,
      rounds: 2,
      intervalMs: 5,
    });
    assert.deepEqual(result, { quiet: true });
  }
  // 腿 2：busy → {quiet:false, metric:"session_status"}（busy 投影被 isActiveStatus
  // 消费——kimi-web 会话"还在跑"第一次可被停止验证观察到）。F3 静默门后夹具分相：
  // spawn 期 idle 放行，verifyStopQuiet 观察期翻 busy（意图不变）。
  {
    let busyPhase = false;
    const { fetchImpl } = kimiServer((url) => {
      if (url === "http://127.0.0.1:4310/api/v1/sessions") return envelope({ id: "session_v2" });
      if (url.endsWith("/api/v1/sessions/session_v2/prompts")) {
        return envelope({ prompt_id: "msg_q1", status: "running" });
      }
      if (url === "http://127.0.0.1:4310/api/v1/sessions/session_v2") {
        return detailEnvelope("session_v2", busyPhase, busyPhase, null);
      }
      if (url === "http://127.0.0.1:4310/api/v1/sessions/session_v2/transcript?agent_id=main") {
        return transcriptEnvelope([]);
      }
      if (url.endsWith("/api/v1/sessions/session_v2/messages")) {
        return envelope({ items: [] });
      }
      throw new Error(`unexpected ${url}`);
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
    busyPhase = true;
    const result = await verifyStopQuiet(handle, handle.serveUrl, handle.backendSessionId, {
      cwd: handle.cwd,
      rounds: 2,
      intervalMs: 5,
    });
    assert.deepEqual(result, { quiet: false, metric: "session_status" });
  }
});

// ===== ⑦ token：env 读取 + 泄漏防护 =====

test("kimi-web ⑦: token 每请求从 env 读取；env 缺失 → 首个请求前固定安全错误（不含 token 值）", async () => {
  delete process.env[TOKEN_ENV];
  try {
    const { calls, fetchImpl } = kimiServer(() => envelope({ id: "s" }));
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    await assert.rejects(
      () => backend.spawn(makeAgent(), { prompt: "x" }),
      (err) => {
        assert.match(err.message, new RegExp(`bearer token env ${TOKEN_ENV} is not set`));
        assert.ok(!err.message.includes(TOKEN_VALUE), "错误消息不含 token 值");
        return true;
      },
    );
    assert.equal(calls.length, 0, "缺失在首个 HTTP 请求前拒绝");
  } finally {
    process.env[TOKEN_ENV] = TOKEN_VALUE;
  }
});

test("kimi-web ⑦: 失败请求的错误消息不含 token 值（事件流全量扫描）", async () => {
  const { fetchImpl } = kimiServer(() => jsonResponse({ code: 0, msg: "internal", data: null }, 500));
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents(makeAgent(), "ses_t", { interval: 5 })) {
    events.push(ev);
  }
  assert.equal(events[0].reason, "failed");
  assert.match(events[0].error, /kimi web request failed 500/);
  assert.ok(!JSON.stringify(events).includes(TOKEN_VALUE), "token 值绝不进事件/错误消息");
});

test("kimi-web ⑦: 错误文本含 token 值 → 抛出前全量替换 <redacted>（非 2xx 正文 / code!==0 的 msg / fetch 异常文本三腿）", async () => {
  // 腿 1：非 2xx 正文回显了 Authorization 头（现实泄漏向量）。
  {
    const { fetchImpl } = kimiServer(() => jsonResponse(
      { code: 0, msg: `internal error saw Bearer ${TOKEN_VALUE}`, data: null },
      500,
    ));
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const events = [];
    for await (const ev of backend.streamEvents(makeAgent(), "ses_t1", { interval: 5 })) {
      events.push(ev);
    }
    assert.equal(events[0].reason, "failed");
    assert.match(events[0].error, /kimi web request failed 500/);
    assert.ok(events[0].error.includes("<redacted>"), "token 值已替换为 <redacted>");
    assert.ok(!JSON.stringify(events).includes(TOKEN_VALUE), "事件流全量不含 token 值");
  }
  // 腿 2：code!==0 的 msg 含 token（v8 起首请求是 GET transcript——同一信封形状）。
  {
    const { fetchImpl } = kimiServer((url) => {
      if (url.endsWith("/transcript?agent_id=main") || url.endsWith("/api/v1/sessions/ses_t2")) {
        return envelope(null, { code: 40001, msg: `bad token ${TOKEN_VALUE}` });
      }
      throw new Error(`unexpected ${url}`);
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const events = [];
    for await (const ev of backend.streamEvents(makeAgent(), "ses_t2", { interval: 5 })) {
      events.push(ev);
    }
    assert.equal(events[0].reason, "failed");
    assert.match(events[0].error, /code 40001/);
    assert.ok(events[0].error.includes("<redacted>"));
    assert.ok(!JSON.stringify(events).includes(TOKEN_VALUE));
  }
  // 腿 3：fetch 异常文本含 token（抛出前经 sanitizeError 清洗）。
  {
    const { fetchImpl } = kimiServer(async () => {
      throw new Error(`fetch failed for ${TOKEN_VALUE}`);
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const events = [];
    for await (const ev of backend.streamEvents(makeAgent(), "ses_t3", { interval: 5 })) {
      events.push(ev);
    }
    assert.equal(events[0].reason, "failed");
    assert.match(events[0].error, /fetch failed/);
    assert.ok(events[0].error.includes("<redacted>"), "fetch 异常文本同样清洗");
    assert.ok(!JSON.stringify(events).includes(TOKEN_VALUE));
  }
});

test("kimi-web ⑦: cause 链清洗——fetch 异常的 Error.cause 含 token 值 → 抛出错误的 cause.message 全量替换 <redacted>（name 与链保留）", async () => {
  const { fetchImpl } = kimiServer(async () => {
    const outer = new Error("outer request blew up");
    const inner = new Error(`connect failed for Bearer ${TOKEN_VALUE}`);
    inner.name = "TypeError";
    outer.cause = inner;
    throw outer;
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  await assert.rejects(
    () => backend.sessionDetail(makeAgent(), "ses_cause"),
    (err) => {
      assert.equal(err.name, "Error", "外层 name 保留");
      assert.ok(err.cause instanceof Error, "cause 链保留");
      assert.equal(err.cause.name, "TypeError", "cause 的 name 保留");
      assert.ok(err.cause.message.includes("<redacted>"), "cause.message 已替换");
      assert.ok(
        !`${err.message}${err.cause.message}`.includes(TOKEN_VALUE),
        "message 与 cause.message 均无 token 值",
      );
      return true;
    },
  );
});

test("kimi-web ⑦: 非 Error 抛出值清洗——抛 {message:token} 普通对象 / 抛含 token 裸字符串 → String() 后清洗再抛，token 绝不逃逸", async () => {
  // 腿 1：抛 {message: <token>} 普通对象（Error-like 但非 Error）。
  {
    const { fetchImpl } = kimiServer(async () => {
      throw { code: "BOOM", message: `Bearer ${TOKEN_VALUE}` };
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    await assert.rejects(
      () => backend.sessionDetail(makeAgent(), "ses_obj"),
      (err) => {
        assert.ok(err instanceof Error, "清洗后以 Error 形状抛出");
        assert.ok(!String(err.message).includes(TOKEN_VALUE), "对象抛出值的 message 不透传 token");
        // A5：普通对象先 JSON.stringify 再清洗——v5 只得 "[object Object]"，对象
        // 字段内容整段丢失；现在字段被有意义地序列化并清洗。
        assert.ok(err.message.includes("BOOM"), "对象字段被序列化（非 [object Object] 丢内容）");
        assert.ok(err.message.includes("<redacted>"), "序列化后的 token 已替换");
        assert.ok(!JSON.stringify(err).includes(TOKEN_VALUE), "整体无 token 值");
        return true;
      },
    );
  }
  // 腿 2：抛裸字符串（含 token）。
  {
    const { fetchImpl } = kimiServer(async () => {
      throw `auth failed for ${TOKEN_VALUE}`;
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    await assert.rejects(
      () => backend.sessionDetail(makeAgent(), "ses_str"),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("<redacted>"), "字符串清洗后替换为 <redacted>");
        assert.ok(!err.message.includes(TOKEN_VALUE));
        return true;
      },
    );
  }
});

// ===== ⑧ POST 盲重试收紧（#8：cause.code 认定）与超时覆盖正文读取 =====

test("kimi-web ⑧: POST 盲重试收紧——ECONNRESET / fetch failed / 500 正文含 ECONNREFUSED 字样的 POST 不重发；仅 cause.code=ECONNREFUSED 重试；GET 维持既有重试", async () => {
  // 腿 1：POST ECONNRESET（连接已建立后中断——服务器可能已收到）绝不重发。
  {
    const { calls, fetchImpl } = kimiServer(() => {
      const error = new TypeError("fetch failed");
      error.cause = new Error("ECONNRESET");
      error.cause.code = "ECONNRESET";
      throw error;
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 2 });
    await assert.rejects(() => backend.spawn(makeAgent(), { prompt: "x" }), /fetch failed/);
    assert.equal(calls.length, 1, "ECONNRESET 的 POST（建会话）不重发");
  }
  // 腿 2：POST "fetch failed"（无 cause 细节）同样不重发。
  {
    const { calls, fetchImpl } = kimiServer(() => { throw new TypeError("fetch failed"); });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 2 });
    await assert.rejects(() => backend.spawn(makeAgent(), { prompt: "x" }), /fetch failed/);
    assert.equal(calls.length, 1, "fetch failed 的 POST 不重发");
  }
  // 腿 3：POST ECONNREFUSED（cause.code 认定；连接未建立，服务器确定未收到）重试。
  {
    const { calls, fetchImpl } = kimiServer(() => {
      const error = new TypeError("fetch failed");
      error.cause = new Error("ECONNREFUSED");
      error.cause.code = "ECONNREFUSED";
      throw error;
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 1 });
    await assert.rejects(() => backend.spawn(makeAgent(), { prompt: "x" }), /fetch failed/);
    assert.equal(calls.length, 2, "ECONNREFUSED 的 POST 重试（retries:1 = 2 次尝试）");
  }
  // 腿 4：GET ECONNRESET 维持既有瞬态重试（幂等读不收紧）。
  {
    const { calls, fetchImpl } = kimiServer(() => {
      const error = new TypeError("fetch failed");
      error.cause = new Error("ECONNRESET");
      error.cause.code = "ECONNRESET";
      throw error;
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 1 });
    await backend.messages(makeAgent(), "ses_g").catch(() => {});
    assert.equal(calls.length, 2, "GET 的 ECONNRESET 仍重试（既有策略不变）");
  }
  // 腿 5（#8）：HTTP 500 且响应正文含 "ECONNREFUSED" 字样——消息字符串匹配已删
  // 除，绝不据此重发 POST（单次尝试）。
  {
    const { calls, fetchImpl } = kimiServer(() => jsonResponse(
      { code: 0, msg: "upstream proxy said: ECONNREFUSED in body text", data: null },
      500,
    ));
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 2 });
    await assert.rejects(() => backend.spawn(makeAgent(), { prompt: "x" }), /kimi web request failed 500/);
    assert.equal(calls.length, 1, "500 正文含 ECONNREFUSED 字样 ≠ 连接拒绝——单次 POST，不重试");
  }
});

test("kimi-web ⑧: 超时覆盖正文读取——headers 立即返回、正文挂起 > timeout ⇒ 该请求按超时失败（AbortError，单次 POST）", async () => {
  const calls = [];
  // headers 立即返回；text()/json() 挂起且只随 abort 信号拒绝（镜像真实 fetch 的
  // 正文读取与 signal 绑定语义）。
  const hangOnSignal = (signal) => new Promise((_resolve, reject) => {
    const abortError = new Error("This operation was aborted");
    abortError.name = "AbortError";
    if (signal?.aborted) {
      reject(abortError);
      return;
    }
    signal?.addEventListener("abort", () => reject(abortError));
    // 永不 resolve——正文挂起。
  });
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET" });
    return {
      ok: true,
      status: 200,
      async text() {
        return hangOnSignal(init.signal);
      },
      json() {
        return hangOnSignal(init.signal);
      },
    };
  };
  const backend = new KimiWebBackend({ fetchImpl, timeout: 80, retries: 0 });
  const start = Date.now();
  await assert.rejects(
    () => backend.request(makeAgent(), "http://127.0.0.1:4310/api/v1/sessions/ses_h", { method: "POST" }),
    (err) => err.name === "AbortError",
  );
  assert.ok(Date.now() - start >= 75, "按 timeout 失败（不是立即失败）");
  assert.equal(calls.length, 1, "POST 超时不重发");
});

// ===== ⑫-⑮ 保留面（A4 残余形状门 / A5 深层清洗 / ⑮ 重试单 POST 重申） =====
// v8 删除面（被 transcript 轮次归属取代，测试随之删除，清单见交付汇报）：
// ⑨ A1 messages/detail 竞窗、⑩ A2 回执 ID 屏蔽、⑪ A3 detail 非布尔不转移
//（detail 已退出完成判定）、⑭ #4 reason 变化归属两腿、⑰ F2 messages 双读
// 稳定性、⑱ F1 全状态无进展出口（收窄为 turn 停滞出口，见 ⑤⑤a/⑤⑤b）。

test("kimi-web ⑫ A4 缺数据不虚报：detail 缺 id 或 busy/main_turn_active（spawn 静默门读）→ spawn 拒绝；messages 缺 items（探针路径）→ messages() 抛固定错误；sessionStatus 缺形状/不可得/非布尔 → null", async () => {
  // 腿 1：detail 缺 busy/main_turn_active（仅有 id）→ spawn 静默门首读即拒
  //（detail 已退出完成判定——它的 A4 在场门现在守 spawn 门与探针）。
  {
    const { fetchImpl } = kimiServer((url) => {
      if (url === "http://127.0.0.1:4310/api/v1/sessions") return envelope({ id: "ses_m1" });
      if (url.endsWith("/api/v1/sessions/ses_m1")) return envelope({ id: "ses_m1" });
      throw new Error(`unexpected ${url}`);
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    await assert.rejects(
      () => backend.spawn(makeAgent(), { prompt: "hi" }),
      (err) => {
        assert.match(err.message, /session detail malformed/);
        assert.match(err.message, /refusing to guess/);
        return true;
      },
    );
  }
  // 腿 2：detail 缺 id（字段齐全）→ 同一固定错误（fail-closed，不回落 {}）。
  {
    const { fetchImpl } = kimiServer((url) => {
      if (url === "http://127.0.0.1:4310/api/v1/sessions") return envelope({ id: "ses_m2" });
      if (url.endsWith("/api/v1/sessions/ses_m2")) {
        return envelope({ busy: true, main_turn_active: true, last_turn_reason: null });
      }
      throw new Error(`unexpected ${url}`);
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    await assert.rejects(
      () => backend.spawn(makeAgent(), { prompt: "hi" }),
      /session detail malformed/,
    );
  }
  // 腿 3：messages 缺 items 数组 → messages() 直接抛固定错误（v8 起该端点仅供
  // 停止验证探针——A4 门守探针路径）。
  {
    const { fetchImpl } = kimiServer((url) => {
      if (url.endsWith("/messages")) return envelope({ has_more: false });
      throw new Error(`unexpected ${url}`);
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    await assert.rejects(
      () => backend.messages(makeAgent(), "ses_m3"),
      (err) => {
        assert.match(err.message, /messages response malformed/);
        assert.match(err.message, /items array is required/);
        return true;
      },
    );
  }
  // 腿 4：sessionStatus——detail 缺字段 → null（不抛、不虚报 idle）。
  {
    const { fetchImpl } = kimiServer(() => envelope({ id: "ses_m4" }));
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    assert.equal(await backend.sessionStatus(makeAgent(), "ses_m4"), null, "缺形状 → null");
  }
  // 腿 5：sessionStatus——detail 不可得（HTTP 500）→ null。
  {
    const { fetchImpl } = kimiServer(() => jsonResponse({ code: 0, msg: "down", data: null }, 500));
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    assert.equal(await backend.sessionStatus(makeAgent(), "ses_m5"), null, "detail 不可得 → null");
  }
  // 腿 6（R9 F1 更新）：sessionStatus——detail 双字段非布尔（detail 在场、在场门
  // 已过，值形状不符）→ {type:"busy"} 保守投影（旧形状 null 会被消费者
  // isKnownStatus(null)===true 当成"已知且非活跃"，虚记 stop_verified——见
  // opencodeStopVerify.js:134 事实依据；与腿 4/5 的"不可得 → null"分工不同）。
  {
    const { fetchImpl } = kimiServer(() => envelope({ id: "ses_m6", busy: "weird", main_turn_active: "weird", last_turn_reason: null }));
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    assert.deepEqual(
      await backend.sessionStatus(makeAgent(), "ses_m6"),
      { type: "busy" },
      "非布尔形状 → busy 保守投影（宁可虚报忙、绝不虚报停止）",
    );
  }
});

test("kimi-web ⑬ A5 深层清洗：cause 三层嵌套每层含 token（含 name 字段含 token）→ 异常对象与事件流全程无 token；普通对象 cause 的非 message 字段同样清洗；null/undefined 抛出值原样抛出", async () => {
  const makeChain = () => {
    const deep = new Error(`deep transport failure Bearer ${TOKEN_VALUE}`);
    // name 字段含 token——v5 只洗 message 不洗 name，这一层会整段逃逸。
    deep.name = `Conn${TOKEN_VALUE}Error`;
    // 最内层 cause 是普通对象且 token 藏在**非 message** 字段——v5 的
    // {...cause, message} 只洗 message 字段，hint 原样逃逸（深层漏洞本体）。
    deep.cause = { code: "EAI_AGAIN", hint: `Bearer ${TOKEN_VALUE}` };
    const mid = new Error(`mid failure saw ${TOKEN_VALUE}`);
    mid.cause = deep;
    const outer = new Error(`outer fetch failed for ${TOKEN_VALUE}`);
    outer.cause = mid;
    return outer;
  };
  // 腿 1：异常对象链路（sessionDetail 直调）——逐层走 name/message，无 token。
  {
    const { fetchImpl } = kimiServer(async () => { throw makeChain(); });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    await assert.rejects(
      () => backend.sessionDetail(makeAgent(), "ses_deep"),
      (err) => {
        const seen = [];
        let node = err;
        let depth = 0;
        while (node !== null && node !== undefined && depth < 6) {
          if (node instanceof Error) {
            seen.push(`${node.name}: ${node.message}`);
            node = node.cause;
          } else {
            seen.push(String(node));
            node = null;
          }
          depth += 1;
        }
        assert.equal(seen.length, 4, "三层 Error + 一层对象 cause（整体序列化清洗）");
        assert.ok(
          err instanceof Error && err.cause instanceof Error && err.cause.cause instanceof Error,
          "Error 链三层保留（每层新建对象）",
        );
        const objectCause = err.cause.cause.cause;
        assert.equal(typeof objectCause, "string", "最内层普通对象 cause 清洗为字符串");
        assert.ok(objectCause.includes("<redacted>"), "对象 cause 的非 message 字段（hint）同样清洗");
        assert.ok(seen.every((s) => !s.includes(TOKEN_VALUE)), "整链 name/message 无 token");
        assert.ok(seen.some((s) => s.includes("<redacted>")), "每层替换痕迹在场");
        return true;
      },
    );
  }
  // 腿 2：事件流全程（streamEvents done(failed) 路径）——事件 JSON 无 token。
  {
    const { fetchImpl } = kimiServer(async () => { throw makeChain(); });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const events = [];
    for await (const ev of backend.streamEvents(makeAgent(), "ses_deep2", { interval: 5, turnAnchor: bareAnchor() })) {
      events.push(ev);
    }
    assert.equal(events[0].reason, "failed");
    assert.ok(events[0].error.includes("<redacted>"), "外层 message 已清洗");
    assert.ok(!JSON.stringify(events).includes(TOKEN_VALUE), "事件流全量无 token 值");
  }
  // 腿 3：null / undefined 抛出值原样抛出（保留原始异常类型信息，不虚构成 Error）。
  {
    const { fetchImpl } = kimiServer(async () => { throw null; });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const err = await backend
      .request(makeAgent(), "http://127.0.0.1:4310/api/v1/sessions/ses_null", { method: "GET" })
      .then(() => "NOT_REJECTED", (e) => e);
    assert.equal(err, null, "null 抛出值原样抛出（清洗前判空）");
  }
  {
    const { fetchImpl } = kimiServer(async () => { throw undefined; });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const err = await backend
      .request(makeAgent(), "http://127.0.0.1:4310/api/v1/sessions/ses_undef", { method: "GET" })
      .then(() => "NOT_REJECTED", (e) => e);
    assert.equal(err, undefined, "undefined 抛出值原样抛出（清洗前判空）");
  }
});
test("kimi-web ⑮ 重试场景单 POST：retries≥1 配置下 POST /prompts 得 HTTP 500（正文含 ECONNREFUSED 字样）仍恰一次 POST", async () => {
  // 与 ⑧ 腿 5 同判据（isConnRefused 只认 cause.code）但作用在最敏感的非幂等
  // POST（发 prompt——盲重发 = 重复 prompt）上：500 正文里含 "ECONNREFUSED"
  // 字样绝非连接拒绝，retries:2 下仍单次尝试。
  let promptPosts = 0;
  const { fetchImpl } = kimiServer((url) => {
    if (url === "http://127.0.0.1:4310/api/v1/sessions") return envelope({ id: "session_r15" });
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_r15") {
      return detailEnvelope("session_r15", false, false, null);
    }
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_r15/transcript?agent_id=main") {
      return transcriptEnvelope([]);
    }
    if (url.endsWith("/api/v1/sessions/session_r15/prompts")) {
      promptPosts += 1;
      return jsonResponse({ code: 0, msg: "upstream proxy said: ECONNREFUSED in body text", data: null }, 500);
    }
    throw new Error(`unexpected ${url}`);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 2 });
  await assert.rejects(() => backend.spawn(makeAgent(), { prompt: "x" }), /kimi web request failed 500/);
  assert.equal(promptPosts, 1, "POST prompts 恰一次（绝不据正文字样盲重发非幂等 POST）");
});
test("kimi-web ⑲ F6 非 Error 抛出值包裹：fetch 抛 null / undefined → 事件流 done(failed, 'request failed with non-error throw')（非 TypeError 崩溃）", async () => {
  // 腿 1：fetch 抛 null——request() 原样抛出（⑬ 腿 3 的类型事实保留），事件流
  // 消费前包成固定文案（旧实现直接读 error.message 会 TypeError 崩掉生成器）。
  {
    const { fetchImpl } = kimiServer(async () => { throw null; });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const events = [];
    for await (const ev of backend.streamEvents(makeAgent(), "ses_null19", { interval: 5, turnAnchor: bareAnchor() })) {
      events.push(ev);
    }
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "done");
    assert.equal(events[0].reason, "failed");
    assert.equal(events[0].error, "request failed with non-error throw");
    assert.ok(!events[0].error.includes("Cannot read"), "不是 TypeError 文案");
  }
  // 腿 2：fetch 抛 undefined——同一包裹路径。
  {
    const { fetchImpl } = kimiServer(async () => { throw undefined; });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const events = [];
    for await (const ev of backend.streamEvents(makeAgent(), "ses_undef19", { interval: 5, turnAnchor: bareAnchor() })) {
      events.push(ev);
    }
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "failed");
    assert.equal(events[0].error, "request failed with non-error throw");
    assert.ok(!events[0].error.includes("Cannot convert"));
  }
});

// ===== R9 定点修复（F1-F4）与六审盲区反例 =====

test("kimi-web R9 F1: sessionStatus 非布尔形状（detail 在场、值形状不符）→ busy 保守投影——消费级反例：verifyStopQuiet 判 非 quiet（metric session_status），绝不产 stop_verified", async () => {
  // 反例的确定性：session/messages 两指标全程零增长（messages 恒空页）——唯一能
  // 阻止 quiet:true 的就是 status 通道。旧形状 null 下 isKnownStatus(null)===true
  //（opencodeStopVerify.js:134）→ observed 且非 active → quiet:true ⇒ 不可观察
  // 被虚记 stop_verified；F1 后 busy 投影被 isActiveStatus 命中 → 非 quiet。
  let probePhase = false;
  const { fetchImpl } = kimiServer((url) => {
    if (url === "http://127.0.0.1:4310/api/v1/sessions") return envelope({ id: "session_f1" });
    if (url.endsWith("/api/v1/sessions/session_f1/prompts")) {
      return envelope({ prompt_id: "msg_q1", status: "running" });
    }
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_f1") {
      // spawn 期（提交前静默门）idle 放行；观察期翻**非布尔形状**（busy/
      // main_turn_active 在场、在场门已过，但值非布尔——F1 的精确目标形状）。
      return probePhase
        ? envelope({ id: "session_f1", busy: "weird", main_turn_active: "weird", last_turn_reason: null, usage: {} })
        : detailEnvelope("session_f1", false, false, null);
    }
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_f1/transcript?agent_id=main") {
      return transcriptEnvelope([]);
    }
    if (url.endsWith("/api/v1/sessions/session_f1/messages")) {
      return envelope({ items: [] });
    }
    throw new Error(`unexpected ${url}`);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  probePhase = true;
  // 直调级：非布尔形状 → {type:"busy"}（宁可虚报忙、绝不虚报停止）。
  assert.deepEqual(
    await handle.sessionStatus(handle.serveUrl, handle.backendSessionId, { cwd: handle.cwd }),
    { type: "busy" },
  );
  // 消费级：verifyStopQuiet（detail 持续返回非布尔形状）→ 非 quiet。
  const result = await verifyStopQuiet(handle, handle.serveUrl, handle.backendSessionId, {
    cwd: handle.cwd,
    rounds: 2,
    intervalMs: 5,
  });
  assert.deepEqual(result, { quiet: false, metric: "session_status" }, "不可观察 ≠ 已停止——绝不产 stop_verified");
});

test("kimi-web R9 F1: sessionStatus detail 不可得（HTTP 500）→ 保持 null（该腿消费者记 unverified，与非布尔→busy 分工不同）", async () => {
  // F1 只改"detail 在场但值非布尔"的投影；HTTP 500/请求失败腿保持 null——
  // 消费侧把不可得如实记 quiet:null/stop_unverified（行为不同，不动）。
  const { fetchImpl } = kimiServer(() => jsonResponse({ code: 0, msg: "down", data: null }, 500));
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  assert.equal(await backend.sessionStatus(makeAgent(), "ses_f1e"), null, "detail 不可得 → null 保持");
});

test("kimi-web R9 F2: failed 轮 error 字段含 token 值 → done.error 过 redactToken（<redacted> 在场），事件流全程无 token", async () => {
  // turn.error 走 HTTP 200 成功路径（transcript 信封 code===0），不经 request()/
  // sanitizeError 出口——F2 前这是 token 清洗的绕行面。
  const turn = turnItem({
    state: "failed",
    error: `upstream auth rejected Bearer ${TOKEN_VALUE}`,
    steps: [],
  });
  const { handler, markSpawned, polls } = turnScriptServer("session_f2t", { script: [[turn]] });
  const { fetchImpl } = kimiServer(handler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  const events = [];
  for await (const ev of handle.events(undefined, { pollInterval: 5 })) {
    events.push(ev);
  }
  assert.equal(events.length, 1, "failed 轮恰一个 done 事件");
  assert.equal(events[0].reason, "failed");
  assert.match(events[0].error, /turn state=failed/);
  assert.ok(events[0].error.includes("<redacted>"), "turn.error 里的 token 值已替换为 <redacted>");
  assert.ok(!JSON.stringify(events).includes(TOKEN_VALUE), "事件流全程无 token 值");
  assert.equal(polls(), 1);
});

test("kimi-web R9 F3: silentTimeout=60000 在场时无 turn 分支只以 silentTimeout 为界——turn 第 9 拍才出现 → 正常完成（第 8 拍绝不失败）", async () => {
  // 反例锚定旧缺陷：silentTimeout=60s、interval=1s 时第 8 秒即被无进展兜底误杀。
  // 这里 8 拍恒无 turn（8 拍 < silentTimeout），第 9 拍 turn 出现且 completed。
  const completed = [turnItem({
    steps: [stepItem({ frames: [{ kind: "text", text: "late turn", role: "assistant" }] })],
  })];
  const { handler, markSpawned, polls } = turnScriptServer("session_f3a", {
    script: [[], [], [], [], [], [], [], [], completed],
  });
  const { fetchImpl } = kimiServer(handler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  const events = [];
  for await (const ev of handle.events(undefined, { pollInterval: 5, silentTimeout: 60_000 })) {
    events.push(ev);
  }
  assert.equal(events.at(-1).reason, "completed", "第 9 拍出现的 turn 正常完成——慢出现不是失败");
  assert.ok(!JSON.stringify(events).includes("turn stalled"), "8 拍无进展兜底不抢先");
  assert.ok(!JSON.stringify(events).includes("silent timeout"), "未到 silentTimeout 界");
  assert.equal(polls(), 9, "恰 9 拍：8 拍无 turn + 第 9 拍终态");
});

test("kimi-web R9 F3: silentTimeout 缺席 → 8 拍无 turn 兜底保留（turn 恒不出现也有界，绝不无限等待）", async () => {
  const { handler, markSpawned, polls } = turnScriptServer("session_f3b", { script: [[]] });
  const { fetchImpl } = kimiServer(handler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  const events = [];
  for await (const ev of handle.events(undefined, { pollInterval: 5 })) {
    events.push(ev);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "failed");
  assert.match(events[0].error, /turn stalled \(no progress\)/);
  assert.match(events[0].error, /turn not observed for 8 consecutive polls/);
  assert.match(events[0].error, /silentTimeout absent/);
  assert.equal(polls(), 8, "防御形状：第 8 拍有界退出");
});

test("kimi-web R9 F4: state=\"banana\" + frames 持续增长 → 第 8 拍 failed（增长不清零 unsupported 计数——旧形状此构造会永等）", async () => {
  // 每拍 frames 文本增长：旧形状闭集外值折进普通等待分支，signature 每拍变化
  // → 停滞计数恒被清零 → 永等（六审盲区本体）。F4 独立计数不吃增长清零。
  const bananaGrowing = (poll) => [turnItem({
    state: "banana",
    steps: [stepItem({
      state: "banana",
      frames: [{ kind: "text", text: "y".repeat(poll), role: "assistant" }],
    })],
  })];
  const { handler, markSpawned, polls } = turnScriptServer("session_f4a", { script: [bananaGrowing] });
  const { fetchImpl } = kimiServer(handler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  const events = [];
  for await (const ev of handle.events(undefined, { pollInterval: 5 })) {
    events.push(ev);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "failed");
  assert.match(events[0].error, /unsupported turn state: banana/);
  assert.equal(polls(), 8, "连续 8 拍闭集外即退出（增长不延长此界）");
});

test("kimi-web R9 F4: state 恢复闭集内即清零 unsupported 计数（banana×2 → running×2 无增长 → banana×6 → completed；删除 kimiWeb.js:716 清零赋值后本测试必红）", async () => {
  // 逐拍推导（u = unsupportedStatePolls，初值 0；"有清零"列 = 现实现，
  // "无清零"列 = 删除 kimiWeb.js:716 `unsupportedStatePolls = 0` 后的变异形状）：
  //
  //   拍  |  items   | 有清零 u | 无清零 u
  //   ----+----------+---------+---------
  //    1  | banana   |    1    |    1
  //    2  | banana   |    2    |    2
  //    3  | running  |    0    |    2    ← 恢复点：现实现在此清零；变异形状停累不清零
  //    4  | running  |    0    |    2      （running 段无 steps/frames 变化——恢复是
  //    5  | banana   |    1    |    3       状态事件而非内容增长事件；变异形状旧计数
  //    6  | banana   |    2    |    4       从 2 起继续累加）
  //    7  | banana   |    3    |    5
  //    8  | banana   |    4    |    6
  //    9  | banana   |    5    |    7
  //   10  | banana   |    6    |    8 ≥ NO_PROGRESS_POLL_LIMIT(8)
  //        → 无清零形状在此 done(failed, "unsupported turn state: banana")，停轮
  //   11  | completed |  仅"有清零"路径到达：两段闭集外各连续 2/6 拍 < 8，
  //         有界出口不触发，第 11 拍正常完成
  //
  // 证明力：删除 kimiWeb.js:716 的清零赋值后，残留 2 + 第二段 6 = 8，第 10 拍
  // 即 failed，下方 completed / 无 unsupported / polls=11 三断言全红——"恢复清零"
  // 的必要性被本测试钉死。（v10 形状 banana×2 → running → completed 在同款
  // 变异下计数停在 2 且再无闭集外拍，永远到不了 8，测试仍绿——七审缺口 2。
  // 注意 running 段的停滞计数 noProgressPolls 与 u 是两个独立变量，716 变异
  // 不影响它；本构造的判据只经 u 走。）
  const banana = [turnItem({ state: "banana", steps: [] })];
  const running = [turnItem({ state: "running", endedAt: null, durationMs: null, steps: [] })];
  const completed = [turnItem({
    steps: [stepItem({ frames: [{ kind: "text", text: "recovered twice", role: "assistant" }] })],
  })];
  const { handler, markSpawned, polls } = turnScriptServer("session_f4b", {
    script: [
      banana, banana,
      running, running,
      banana, banana, banana, banana, banana, banana,
      completed,
    ],
  });
  const { fetchImpl } = kimiServer(handler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  const events = [];
  for await (const ev of handle.events(undefined, { pollInterval: 5 })) {
    events.push(ev);
  }
  assert.equal(events.at(-1).reason, "completed", "恢复清零生效：两段闭集外各 <8 拍，正常完成");
  assert.ok(!JSON.stringify(events).includes("unsupported turn state"), "无清零变异形状第 10 拍即 failed——到达本断言即证明清零发生");
  assert.equal(polls(), 11, "恰 11 拍（无清零变异形状第 10 拍即 failed，polls 停在 10）");
});

test("kimi-web R9 ⑫: 停滞门增长重置的必要性——拍 4 steps 增长清零计数后连续 7 拍无增长仍完成（删除 kimiWeb.js:725 清零赋值后本测试必红）", async () => {
  // 逐拍推导（n = noProgressPolls，初值 0；"有清零"列 = 现实现，"无清零"列 =
  // 删除 kimiWeb.js:725 `noProgressPolls = 0` 后的变异形状——增长拍只停累不清零）：
  //
  //   拍  |  steps   | 有清零 n | 无清零 n
  //   ----+----------+---------+---------
  //    1  | 1 step   |  0 基线 |  0 基线
  //    2  | 1 step   |    1    |    1
  //    3  | 1 step   |    2    |    2
  //    4  | 2 steps  |    0    |    2    ← 增长拍（signature 变化）：现实现在此
  //    5  | 2 steps  |    1    |    3      清零；变异形状走同一分支但不重置，
  //    6  | 2 steps  |    2    |    4      计数停在 2 继续累加
  //    7  | 2 steps  |    3    |    5
  //    8  | 2 steps  |    4    |    6
  //    9  | 2 steps  |    5    |    7
  //   10  | 2 steps  |    6    |    8 ≥ NO_PROGRESS_POLL_LIMIT(8)
  //        → 无清零形状在此 done(failed, "turn stalled (no progress)")，停轮
  //   11  | 2 steps  |    7    |  （已 failed，不再轮询）
  //   12  | completed |  仅"有清零"路径到达：增长后连续无增长 7 拍 < 8，正常完成
  //
  // 证明力：删除 kimiWeb.js:725 的清零赋值后，2（跨增长残留）+ 增长后 6 拍 = 8，
  // 第 10 拍即 failed，下方 completed / 无 stalled / polls=12 三断言全红——"增长
  // 清零"的必要性被本测试钉死。（v10 形状增长后仅 4 拍无增长，无清零时计数最多
  // 累至 7 < 8，第 10 拍直接 completed，测试仍绿——七审缺口 1。）
  const baseSteps = () => [stepItem({ stepId: "s0", state: "running", frames: [] })];
  const grownSteps = () => [
    stepItem({ stepId: "s0", state: "running", frames: [] }),
    stepItem({ stepId: "s1", ordinal: 1, state: "running", frames: [] }),
  ];
  const running = (steps) => [turnItem({ state: "running", endedAt: null, durationMs: null, steps })];
  const completed = [turnItem({
    steps: [stepItem({ frames: [{ kind: "text", text: "resumed after reset", role: "assistant" }] })],
  })];
  const { handler, markSpawned, polls } = turnScriptServer("session_r912", {
    script: [
      running(baseSteps()), running(baseSteps()), running(baseSteps()),
      running(grownSteps()),
      running(grownSteps()), running(grownSteps()), running(grownSteps()),
      running(grownSteps()), running(grownSteps()), running(grownSteps()),
      running(grownSteps()),
      completed,
    ],
  });
  const { fetchImpl } = kimiServer(handler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  const events = [];
  for await (const ev of handle.events(undefined, { pollInterval: 5 })) {
    events.push(ev);
  }
  assert.equal(events.at(-1).reason, "completed", "增长清零后跨过无清零形状的失败点（第 10 拍），第 12 拍正常完成");
  assert.ok(!JSON.stringify(events).includes("turn stalled"), "从未走无进展出口");
  assert.equal(polls(), 12, "恰 12 拍（无清零变异形状第 10 拍即 failed，polls 停在 10）");
  const messages = events.filter((e) => e.kind === "message");
  assert.equal(messages.length, 2);
});

test("kimi-web R9 ⑬: queued state 单列用例——与 running 分支行为一致但独立断言（queued×2 → completed，等待不误杀、不猜终态）", async () => {
  const queued = () => [turnItem({ state: "queued", endedAt: null, durationMs: null, steps: [] })];
  const completed = [turnItem({
    steps: [stepItem({ frames: [{ kind: "text", text: "queued then done", role: "assistant" }] })],
  })];
  const { handler, markSpawned, polls } = turnScriptServer("session_r913", {
    script: [queued(), queued(), completed],
  });
  const { fetchImpl } = kimiServer(handler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  const events = [];
  for await (const ev of handle.events(undefined, { pollInterval: 5 })) {
    events.push(ev);
  }
  assert.deepEqual(events.map((e) => e.kind), ["message", "message", "metrics", "done"]);
  assert.equal(events.at(-1).reason, "completed", "queued 是受支持的非终态——等待后正常完成");
  assert.deepEqual(events[1].parts, [{ type: "text", text: "queued then done" }]);
  assert.equal(polls(), 3, "拍 1-2 queued（等待）、拍 3 终态");
});

test("kimi-web R9 ⑭: 提交前静默门 busy 持续至上界 → 固定错误 + 零提交（门未过不读 transcript、不发 prompt）", async () => {
  let detailCalls = 0;
  const { calls, fetchImpl } = kimiServer((url) => {
    if (url === "http://127.0.0.1:4310/api/v1/sessions") return envelope({ id: "session_busy" });
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_busy") {
      detailCalls += 1;
      return detailEnvelope("session_busy", true, true, "prior turn still running");
    }
    if (url.includes("/transcript")) throw new Error("transcript must not be read while the gate holds");
    if (url.endsWith("/prompts")) throw new Error("must not submit over a still-running turn");
    throw new Error(`unexpected ${url}`);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  await assert.rejects(
    () => backend.spawn(makeAgent(), { prompt: "hi" }, { silentTimeout: 60, pollInterval: 5 }),
    (err) => {
      assert.match(err.message, /session busy at dispatch/);
      assert.match(err.message, /within 60ms/);
      assert.match(err.message, /pre-submit silent gate/);
      return true;
    },
  );
  assert.ok(detailCalls >= 2, `静默门轮询多拍后才到界（实际 ${detailCalls} 拍）`);
  assert.ok(!calls.some((c) => c.url.endsWith("/prompts")), "零提交——绝不向仍在跑的会话叠提交");
  assert.ok(!calls.some((c) => c.url.includes("/transcript")), "门未过不读 transcript（时序：门在前）");
});

test("kimi-web R9 ⑮: transcript 返回不可解析 JSON（HTTP 200、body 非法）→ done(failed) 有界收口（非崩溃、非静默等待）", async () => {
  // HTTP 200 + json() 抛 SyntaxError：request() 的非 2xx/code!==0 信封判定都
  // 不触及——唯一出口是异常沿重试分类（不可重试）→ sanitizeError → 事件流
  // done(failed)。反例意义：不可解析 ≠ 空 items ≠ 健康观测，绝不回落猜测形状。
  const { fetchImpl } = kimiServer(() => ({
    ok: true,
    status: 200,
    async json() {
      throw new SyntaxError("Unexpected token '<' is not valid JSON");
    },
    async text() {
      return "<html>not json</html>";
    },
  }));
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents(makeAgent(), "ses_r915", { interval: 5, turnAnchor: bareAnchor() })) {
    events.push(ev);
  }
  assert.equal(events.length, 1, "恰一个 done 事件——流有界终止");
  assert.equal(events[0].kind, "done");
  assert.equal(events[0].reason, "failed");
  // 2026-10-02 坑修：裸 SyntaxError（"Unexpected token '<'"，不可诊断）换成
  // 固定形状 typed 错误（含状态码/content-type、不回显正文）——有界收口与
  // "绝不回落猜测形状"的反例意图不变。
  assert.match(events[0].error, /non-JSON body \(status 200/, "typed 错误进 done.error");
});

test("kimi-web R9 ⑯: 先见 running 后请求连续失败 → done(failed)（绝不复用旧 turn 判完成，也不无限等待）", async () => {
  // 反例锚定：拍 1 已见 running turn；拍 2 起 transcript 请求连续失败（重试耗尽）
  // ——完成判定只认**当拍观测**，缓存的旧 turn 既不能用来继续等（观测已断流）
  // 也不能用来伪造完成。
  const running = turnItem({ state: "running", endedAt: null, durationMs: null, steps: [] });
  let spawned = false;
  let polls = 0;
  const handler = (url) => {
    if (url === "http://127.0.0.1:4310/api/v1/sessions") return envelope({ id: "session_r916" });
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_r916") {
      return detailEnvelope("session_r916", false, false, null);
    }
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_r916/transcript?agent_id=main") {
      if (!spawned) return transcriptEnvelope([]);
      polls += 1;
      if (polls === 1) return transcriptEnvelope([running]);
      const error = new TypeError("fetch failed");
      error.cause = new Error("ECONNRESET");
      error.cause.code = "ECONNRESET";
      throw error;
    }
    if (url.endsWith("/api/v1/sessions/session_r916/prompts")) {
      return envelope({ prompt_id: "msg_q1", status: "running" });
    }
    throw new Error(`unexpected ${url}`);
  };
  const { fetchImpl } = kimiServer(handler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  spawned = true;
  const events = [];
  for await (const ev of handle.events(undefined, { pollInterval: 5 })) {
    events.push(ev);
  }
  assert.equal(events.length, 1, "恰一个 done 事件");
  assert.equal(events[0].kind, "done");
  assert.equal(events[0].reason, "failed");
  assert.match(events[0].error, /fetch failed/);
  assert.equal(polls, 2, "拍 1 见 running、拍 2 请求失败即收口");
  assert.ok(!events.some((e) => e.kind === "message"), "绝不复用旧 turn 发射内容");
});

// ===== 注册面（factory / registry 闭集接线） =====

test("kimi-web 注册: factory 构造 + 六轴能力快照 + sessionOutlivesProcess 与设计定案一致", () => {
  const viaFactory = backendFor({ backend: "kimi-web" }, { fetchImpl: async () => envelope({}) });
  assert.ok(viaFactory instanceof KimiWebBackend);
  // sessionOutlivesProcess 不在六轴闭集（runManager 单独读取），直接对实例断言。
  assert.equal(viaFactory.sessionOutlivesProcess, true);
  assert.deepEqual(backendCapabilitySnapshot({ backend: "kimi-web" }), {
    supportsRoleContract: true,
    supportsSessionReuse: true,
    supportsInFlightCorrection: true,
    replayByRespawn: true,
    // v8 翻转：transcript 轮次 steps[].usage 实测非零（2026-09-30 live）。
    reportsTokenUsage: true,
    reportsCommandExitCode: false,
  });
});

test("kimi-web 注册: normalizeAgent 的 serveUrl/model.id/tokenEnv 必填面", () => {
  const ok = normalizeAgent("coder_kimiweb", makeAgent());
  assert.equal(ok.backend, "kimi-web");
  assert.equal(ok.tokenEnv, TOKEN_ENV);
  assert.throws(() => normalizeAgent("bad_serve", makeAgent({ serveUrl: undefined })), /missing serveUrl/);
  assert.throws(() => normalizeAgent("bad_model", makeAgent({ model: undefined })), /missing model\.id/);
  assert.throws(() => normalizeAgent("bad_token", makeAgent({ tokenEnv: " " })), /tokenEnv.*non-blank string/);
});


// ===== ⑫ user-env 桥接 + 非 JSON 守卫（2026-10-02 坑修：token 不继承 / collect HTML 崩溃）=====

test("kimi-web ⑫: spawn 捕获 task.resolvedCredentials 的桥接 token——process.env 缺席时 request 仍带正确 Bearer 头", async () => {
  const saved = process.env[TOKEN_ENV];
  delete process.env[TOKEN_ENV];
  try {
    const { calls, fetchImpl } = kimiServer(spawnOkRoutes());
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    await backend.spawn(makeAgent(), {
      prompt: "Read README only.",
      resolvedCredentials: { [TOKEN_ENV]: "bridged-token-value" },
    });
    assert.equal(calls.length, 4, "spawn fresh 轮四请求照常");
    assert.equal(
      calls[0].headers.authorization,
      "Bearer bridged-token-value",
      "桥接值优先于 process.env（detached runner 不继承 user-env 的坑修）",
    );
  } finally {
    if (saved !== undefined) process.env[TOKEN_ENV] = saved;
  }
});

test("kimi-web ⑫: request 对 200+HTML 抛固定形状错误（不回显正文、不带裸 SyntaxError）", async () => {
  const htmlResponse = {
    ok: true,
    status: 200,
    headers: { get: (n) => (n === "content-type" ? "text/html" : null) },
    async json() { throw new SyntaxError("Unexpected token '<'"); },
    async text() { return "<!doctype html><html>login page</html>"; },
  };
  const backend = new KimiWebBackend({ fetchImpl: async () => htmlResponse, timeout: 5000, retries: 0 });
  await assert.rejects(
    () => backend.request(makeAgent(), "http://127.0.0.1:4310/api/v1/sessions/s1/messages", { method: "GET" }),
    (error) => {
      assert.match(error.message, /non-JSON body \(status 200, content-type text\/html\)/);
      assert.match(error.message, /refusing to guess/);
      assert.equal(error.message.includes("<!doctype"), false, "正文绝不进错误消息");
      return true;
    },
  );
});

test("kimi-web ⑫: envPolicy 把 tokenEnv 纳入必需凭据面（readiness 门与 user-env 桥的前提）", async () => {
  const { requiredCredentialNames } = await import("../../src/envPolicy.js");
  const agent = normalizeAgent("coder_kimiweb", makeAgent());
  assert.deepEqual(requiredCredentialNames(agent), [TOKEN_ENV]);
});

test("kimi-web ⑤ TD-197① 预算自放大（auditor FAIL 修复回归钉）：观测间隙抬升预算，更长的同轮静默不再误杀", async () => {
  // 时间线（假钟在每个 transcript 请求时 +30s；spawn 期有恰好一次 transcript
  // 调用，见 [dbg] 实测）：spawn 调用 t=30（unspawned → preTurns，不建基线）；
  // poll1 t=60 turn 现身 frames "x"（PRIME——首见建立基线，不算静默）；
  // poll2 t=90 frames "xx"（进展——已恢复静默 30s，成为观测值 → 预算 =
  // max(60s, 3×30s)=90s；固定 60s 门在预算上与之区分）；poll3 t=120 静默 30s、
  // poll4 t=150 静默 60s（固定 60s 门此刻即杀——本钉的对照面）、poll5 t=180
  // 静默 90s < 90s？否——恰 ≥ 90s 收口。若预算不放大：poll4 已杀；若放大：
  // poll5 收口。断言 polls=5 且 maxGap=30000ms 双证。
  const growing = (poll) => [turnItem({
    state: "running",
    endedAt: null,
    durationMs: null,
    steps: [stepItem({ state: "running", frames: [{ kind: "text", text: "x".repeat(poll), role: "assistant" }] })],
  })];
  const stalled = [turnItem({
    state: "running",
    endedAt: null,
    durationMs: null,
    steps: [stepItem({ state: "running", frames: [{ kind: "text", text: "xx", role: "assistant" }] })],
  })];
  const { handler, markSpawned, polls } = turnScriptServer("session_ad", {
    script: [growing, growing, stalled],
  });
  let fakeNow = 0;
  const clock = () => fakeNow;
  const clockedHandler = (url) => {
    if (url.includes("/transcript")) fakeNow += 30_000;
    return handler(url);
  };
  const { fetchImpl } = kimiServer(clockedHandler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  const events = [];
  for await (const ev of handle.events(undefined, { pollInterval: 1, stallClock: clock })) {
    events.push(ev);
  }
  const done = events.at(-1);
  assert.equal(done.reason, "failed");
  assert.match(done.error, /adaptive budget/);
  assert.match(done.error, /max recovered gap this turn 30000ms/, "30s 已恢复静默成为观测值");
  // poll1 基线（60）+ poll2 进展（90，gap 30 记录）+ poll3 静默 30（120）+
  // poll4 静默 60（150——固定 60s 门的杀点，对照面）+ poll5 静默 90（180）≥ 90 收口。
  assert.equal(polls(), 5, "预算 3×30s=90s：poll4 的 60s 静默存活（固定门必杀），poll5 才收口");
});

// ── 2026-10-04 会审精度钉（consult_202610042037269516qqzn9）──────────────────
// HTTP 状态失败是服务端语义答复，永不重试。旧瞬态判定按消息子串（"fetch failed"），
// 而 HTTP 错误消息嵌着响应正文——401 正文恰含该词会被误判瞬态重试 GET。两钉都以
// retries=2 证明预算零消耗（恰一次请求）。
test("kimi-web ⑬a: GET 401（普通正文）→ 恰一次请求、错误含状态码——服务端答复非瞬态", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return new Response(JSON.stringify({ code: 40101, msg: "Unauthorized" }), {
      status: 401, headers: { "content-type": "application/json" },
    });
  };
  const backend = new KimiWebBackend({ fetchImpl, timeout: 2000, retries: 2 });
  await assert.rejects(
    () => backend.request(makeAgent(), "http://127.0.0.1:1/api/v1/sessions/s/x"),
    /401/,
  );
  assert.equal(attempts, 1, "401 不吃重试预算——恰一次请求");
});

test("kimi-web ⑬b: GET 401 且正文恰含 \"fetch failed\" → 仍恰一次请求（消息子串不再是瞬态依据）", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return new Response("upstream proxy said: fetch failed for route", {
      status: 401, headers: { "content-type": "text/plain" },
    });
  };
  const backend = new KimiWebBackend({ fetchImpl, timeout: 2000, retries: 2 });
  await assert.rejects(
    () => backend.request(makeAgent(), "http://127.0.0.1:1/api/v1/sessions/s/x"),
    /401/,
  );
  assert.equal(attempts, 1, "正文碰撞词不得把 401 变成瞬态——旧判定此处会重试");
});

// ── 0046 B5 根因修复：活体证词停滞门（Owner 2026-10-06 否决短 brief 降质绕法） ──

/** 可控 detail 的脚本服务器包装：silentDetail 控预算击发时的活体证词。 */
function attestedScriptServer(sessionId, { script, detailMode = "active" }) {
  const inner = turnScriptServer(sessionId, { script });
  let detailCalls = 0;
  let submitted = false;
  const handler = (url, init, n) => {
    if (url === `http://127.0.0.1:4310/api/v1/sessions/${sessionId}`) {
      // 提交前（F3 静默门）恒 idle——active/throw 证词只在提交后的预算复核出现。
      if (!submitted) return detailEnvelope(sessionId, false, false, null);
      detailCalls += 1;
      if (detailMode === "active") return detailEnvelope(sessionId, false, true, null);
      if (detailMode === "throw") throw new Error("detail probe failed");
      return detailEnvelope(sessionId, false, false, null);
    }
    return inner.handler(url, init, n);
  };
  return {
    handler,
    markSpawned: () => { submitted = true; inner.markSpawned(); },
    polls: inner.polls,
    detailCalls: () => detailCalls,
  };
}

test("kimi-web B5①: 预算击发 + serve 证词 main_turn_active=true → 续命不杀，最终 completed", async () => {
  // 场景=当日四杀实录：turn 在场、state running、steps/frames 零增长（K3 首 拍
  // 重思考零帧），静默段超预算——但 serve 说 turn 活着 → noteProgress 续命，
  // 多轮静默多次续命后 transcript 终态完成。
  const frozen = [turnItem({
    state: "running",
    endedAt: null,
    durationMs: null,
    steps: [stepItem({ state: "running", frames: [] })],
  })];
  const completed = [turnItem({
    steps: [stepItem({ frames: [{ kind: "text", text: "long-thought-answer", role: "assistant" }] })],
  })];
  // 15 拍冻结（假钟每拍 transcript +10s：第 7 拍首超 60s 预算、其后每 7 拍左右
  // 再超一次=多轮续命），第 16 拍完成。
  const script = [...Array(15).fill(frozen), completed];
  const { handler, markSpawned, detailCalls } = attestedScriptServer("session_b5a", { script, detailMode: "active" });
  const fakeNow = { v: 0 };
  const clockedHandler = (url, init, n) => {
    if (url.includes("/transcript")) fakeNow.v += 10_000;
    return handler(url, init, n);
  };
  const { fetchImpl } = kimiServer(clockedHandler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  const events = [];
  for await (const ev of handle.events(undefined, { pollInterval: 1, stallClock: () => fakeNow.v })) {
    events.push(ev);
  }
  const done = events.at(-1);
  assert.equal(done.reason, "completed", "活轮绝不因零帧静默被误杀（证词续命）");
  assert.ok(!JSON.stringify(events).includes("turn stalled"), "从未走停滞出口");
  // 自适应预算在证词续命后会放大（3×已恢复间隙），本脚本长度内可能只复核一次——
  // 断言语义：≥1 次证词 + 轮询越过原必死点（无证词时第 7 拍已死，16 拍完成）。
  assert.ok(detailCalls() >= 1, `至少一轮活体复核（实际 ${detailCalls()}）`);
});

test("kimi-web B5②: 证词活着但超 30min 硬墙钟顶 → 收口 failed（真失控保护）", async () => {
  const frozen = [turnItem({
    state: "running",
    endedAt: null,
    durationMs: null,
    steps: [stepItem({ state: "running", frames: [] })],
  })];
  const { handler, markSpawned } = attestedScriptServer("session_b5b", { script: [frozen], detailMode: "active" });
  const fakeNow = { v: 0 };
  const clockedHandler = (url, init, n) => {
    // 每拍大幅推进：6 拍即 31min 墙钟（第 7 拍击 60s 预算→首证词时墙钟已超顶）。
    if (url.includes("/transcript")) fakeNow.v += 310_000;
    return handler(url, init, n);
  };
  const { fetchImpl } = kimiServer(clockedHandler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  const events = [];
  for await (const ev of handle.events(undefined, { pollInterval: 1, stallClock: () => fakeNow.v })) {
    events.push(ev);
  }
  const done = events.at(-1);
  assert.equal(done.reason, "failed");
  assert.match(done.error, /serve-attested active turn exceeded the 30min hard wall cap/);
  assert.match(done.error, /despite liveness/);
});

test("kimi-web B5③: 预算击发 + 证词请求失败 → 照杀（fail-closed：无证词=无续命）", async () => {
  const frozen = [turnItem({
    state: "running",
    endedAt: null,
    durationMs: null,
    steps: [stepItem({ state: "running", frames: [] })],
  })];
  const { handler, markSpawned } = attestedScriptServer("session_b5c", { script: [frozen], detailMode: "throw" });
  const fakeNow = { v: 0 };
  const clockedHandler = (url, init, n) => {
    if (url.includes("/transcript")) fakeNow.v += 10_000;
    return handler(url, init, n);
  };
  const { fetchImpl } = kimiServer(clockedHandler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  const events = [];
  for await (const ev of handle.events(undefined, { pollInterval: 1, stallClock: () => fakeNow.v })) {
    events.push(ev);
  }
  const done = events.at(-1);
  assert.equal(done.reason, "failed");
  assert.match(done.error, /turn stalled \(no progress\)/);
});
