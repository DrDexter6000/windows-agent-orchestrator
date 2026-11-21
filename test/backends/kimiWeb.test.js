// test/backends/kimiWeb.test.js
//
// 「kimi-web」backend（HTTP attach，`kimi web` 本地服务器的官方 REST API）的离线单元
// 测试：注入 fetchImpl 的假服务器构造全部上游形状，零真实服务器、零网络。上游事实锚点
// = kimi 2.6.3 的实测响应（test/fixtures/kimi-2.6.3/，src/backends/kimiWeb.js 文件头）；
// TD-362 加 kimi 2.7.2 的实录（test/fixtures/kimi-2.7.2/，2026-11-20 采集）——2.7 会话
// 详情的 activity 在读取边界投影回 2.6 的 busy/main_turn_active。
//
// 完成判定（第 109 批）：GET …/agents/main/turns 的轮按 user_message.prompt_ids 归属到
// 运行的提示集合（派发 + 被接纳的纠偏）；每个 id 结算后，最终轮（归属轮里 ordinal 最大的）
// ended 才按 outcome 收口。纠偏会让一次运行跨两轮（2.6.3 实测：被转入的纠偏打断当前轮，
// 自己开下一轮做完工作）。每拍先读 GET …/prompts 再翻 turns。解析测试直接回放
// kimi-2.6.3 目录里的真实响应，其余用 test/fixtures/kimiWebServe.js 的 2.6 形状构造。
// 保留面：提交前静默门、sendCorrection 排队+steer 协议、token 递归清洗、POST 仅
// ECONNREFUSED 重试、停止探针消费者形状、fail-closed 形状门、停滞门（时间预算 + serve
// 证词 + 30min 硬顶）、在途工具证据（决定 0071/0072）。

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { KimiWebBackend, createRunPrompts } from "../../src/backends/kimiWeb.js";
import { backendFor, backendCapabilitySnapshot } from "../../src/backends/factory.js";
import { normalizeAgent } from "../../src/registry.js";
import { verifyStopQuiet } from "../../src/backends/serveStopVerify.js";

// 底层信封/路由夹具在共享文件里（多文件共用，同一函数只留一份）。
import {
  KIMI_TEST_TOKEN_ENV,
  KIMI_TEST_TOKEN_VALUE,
  kimiServer,
  envelope,
  jsonResponse,
  detailEnvelope,
  turnsEnvelope,
  promptsEnvelope,
  kimiTurn,
  runningTurn,
  stepItem,
  userMessageItem,
  assistantItem,
  toolCallItem,
  spawnOkRoutes,
  turnScriptServer,
} from "../fixtures/kimiWebServe.js";

const TOKEN_ENV = KIMI_TEST_TOKEN_ENV;
const TOKEN_VALUE = KIMI_TEST_TOKEN_VALUE;

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

/**
 * 直调 streamEvents 的运行提示集合（真实派发恒经 spawn 自建；此形状用于错误路径等与
 * 归属无关的用例，或需要手工摆好纠偏状态的用例）。
 */
function bareRun(promptId = "msg_q1", boundaryOrdinal = -1) {
  return createRunPrompts({ promptId, boundaryOrdinal });
}

/** turnScriptServer + spawn + 跑完事件流（pollInterval 5ms）。 */
async function runScript(sessionId, serverOpts = {}, eventOpts = {}) {
  const { handler, markSpawned, polls } = turnScriptServer(sessionId, serverOpts);
  const { fetchImpl, calls } = kimiServer(handler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  const events = [];
  for await (const ev of handle.events(undefined, { pollInterval: 5, ...eventOpts })) events.push(ev);
  return { events, polls: polls(), calls, handle };
}

// ===== kimi 2.6.3 真实响应（test/fixtures/kimi-2.6.3/）=====
// 每个文件都必须被本文件的某个测试读到（见末尾的覆盖断言）。

const KIMI_263_DIR = new URL("../fixtures/kimi-2.6.3/", import.meta.url);
const kimi263Read = new Set();
/** 读一份实测响应：{http, json}。 */
function kimi263(name) {
  kimi263Read.add(name);
  return JSON.parse(readFileSync(new URL(name, KIMI_263_DIR), "utf8"));
}
/** 实测响应原样回放（HTTP 状态与正文都按录到的）。 */
function replay263(name) {
  const { http, json } = kimi263(name);
  return jsonResponse(json, http);
}
const KIMI_263_SESSION = "session_e6772cf8-e1a2-4eb3-93f8-59d713ed8020";
const KIMI_263_BASE = `http://127.0.0.1:4310/api/v1/sessions/${KIMI_263_SESSION}`;

// ===== kimi 2.7.2 真实响应（test/fixtures/kimi-2.7.2/，2026-11-20 采集）=====
// 只读本批用到的几份（会话详情三态、列表、40401、turns）；不要求整目录覆盖。

const KIMI_272_DIR = new URL("../fixtures/kimi-2.7.2/", import.meta.url);
/** 读一份实测响应：{http, json}。 */
function kimi272(name) {
  return JSON.parse(readFileSync(new URL(name, KIMI_272_DIR), "utf8"));
}
/** 实测响应原样回放（HTTP 状态与正文都按录到的）。 */
function replay272(name) {
  const { http, json } = kimi272(name);
  return jsonResponse(json, http);
}

/**
 * 按拍回放实测响应的假服务器：spawn 期 POST /sessions → create-session、GET 会话详情 →
 * detail（缺省 session-detail-fresh）、GET turns → preTurns、POST prompts → submit；之后
 * 第 i 拍（一拍 = 一次 GET prompts）回放 ticks[i-1] 的 {prompts, turns}（超出恒重复最后
 * 一拍）；纠偏的 POST prompts / steer 按 corrections 队列回放。值可以是 fixture 文件名或
 * 现成的 Response。旧的 transcript 路由答录到的 404。
 */
function kimi263Server({ preTurns, submit, ticks, corrections = [], steers = [], detail = "session-detail-fresh.json" }) {
  const answer = (value) => (typeof value === "string" ? replay263(value) : value);
  let spawned = false;
  let tick = 0;
  const correctionQueue = [...corrections];
  const steerQueue = [...steers];
  return kimiServer((url, init = {}) => {
    const method = init.method ?? "GET";
    if (method === "POST" && url === "http://127.0.0.1:4310/api/v1/sessions") return replay263("create-session.json");
    if (url === KIMI_263_BASE) return answer(typeof detail === "function" ? detail(tick) : detail);
    if (url.startsWith(`${KIMI_263_BASE}/transcript`)) return replay263("old-transcript-endpoint-404.json");
    if (method === "GET" && url === `${KIMI_263_BASE}/prompts`) {
      if (spawned) tick += 1;
      return answer(ticks[Math.min(tick, ticks.length) - 1].prompts);
    }
    if (method === "GET" && url === `${KIMI_263_BASE}/agents/main/turns`) {
      if (!spawned) return answer(preTurns);
      return answer(ticks[Math.min(Math.max(tick, 1), ticks.length) - 1].turns);
    }
    if (method === "POST" && url === `${KIMI_263_BASE}/prompts`) {
      if (!spawned) {
        spawned = true;
        return answer(submit);
      }
      return answer(correctionQueue.shift());
    }
    if (method === "POST" && url === `${KIMI_263_BASE}/prompts:steer`) return answer(steerQueue.shift());
    throw new Error(`unexpected ${method} ${url}`);
  });
}

/** 一份 turns 实测页的某几个轮（按 ordinal 选）——用来摆出录到的两拍之间的形状。 */
function turnsOf(name, keep) {
  const turns = kimi263(name).json.data.turns.filter((turn) => keep(turn.ordinal));
  return turnsEnvelope(turns);
}

async function collect(handle, opts = {}) {
  const events = [];
  for await (const ev of handle.events(undefined, { pollInterval: 5, ...opts })) events.push(ev);
  return events;
}

test("kimi 2.6.3 实测·工具轮：命令 + 写文件 + 回答 DONE → 证据、答案、metrics 与 firstRequest 取实测值；旧 transcript 端点不再请求", async () => {
  const { calls, fetchImpl } = kimi263Server({
    preTurns: turnsEnvelope([]),
    submit: "t1-tools-submit.json",
    ticks: [
      { prompts: "t1-tools-prompts-running.json", turns: "t1-tools-turns-1-opened.json" },
      { prompts: "t1-tools-prompts-after.json", turns: "t1-tools-turns-9-ended.json" },
    ],
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "probe" });
  assert.equal(handle.backendSessionId, KIMI_263_SESSION, "会话 id 取自录到的建会话回执");
  const events = await collect(handle);
  assert.deepEqual(events.map((e) => e.kind), [
    "runtime_activity", // 拍 1：轮已开、只有开场消息
    "command", "tool_result", "file_written", "tool_result",
    "message", "message", "metrics", "done",
  ]);
  assert.deepEqual(events[1], { kind: "command", command: "echo wao-probe", toolCallId: "tool_3LvThrKMuayxMWgN4wCzNAFO" });
  assert.deepEqual(events[2], { kind: "tool_result", tool: "tool_3LvThrKMuayxMWgN4wCzNAFO", output: "wao-probe\n", isError: false });
  assert.deepEqual(events[3], { kind: "file_written", path: "C:/wao-probe/cwd/probe.txt" }, "写路径取 display.path（绝对路径）");
  assert.deepEqual(events[4], { kind: "tool_result", tool: "tool_EZ9ljmlTUacZGd8kt4UNhNHf", output: "Wrote 2 bytes to probe.txt", isError: false });
  assert.equal(events[5].role, "user");
  assert.match(events[5].parts[0].text, /^Use your shell tool to run the command `echo wao-probe`/);
  assert.deepEqual(events[6], { kind: "message", role: "assistant", parts: [{ type: "text", text: "DONE" }] });
  assert.ok(!JSON.stringify(events).includes("I need execute shell"), "reasoning 不进事件流");
  assert.deepEqual(events[7], {
    kind: "metrics",
    tokens: { input: 806, output: 270, cacheRead: 50432, cacheWrite: 0 },
    firstRequest: { input: 253, cacheRead: 16640 },
  }, "轮级 usage；firstRequest = index 最小那一步");
  assert.equal(events[8].reason, "completed");
  assert.ok(!calls.some((c) => c.url.includes("transcript")), "2.6 已删除的 transcript 端点不再请求");
  // 录到的旧端点答复：路由级 404（不是信封错误）。
  await assert.rejects(
    () => backend.request(makeAgent(), `${KIMI_263_BASE}/transcript?agent_id=${"main"}`, { method: "GET" }),
    /kimi web request failed 404: .*Route GET/,
  );
  // 停止探针读录到的会话详情：在跑时 busy，跑完 idle。
  const details = ["t1-tools-session-running.json", "t1-tools-session-after.json"];
  const probe = kimiServer(() => replay263(details.shift()));
  const target = new KimiWebBackend({ fetchImpl: probe.fetchImpl, timeout: 5000, retries: 0 }).stopTarget(makeAgent(), KIMI_263_SESSION);
  assert.deepEqual(await target.sessionStatus(), { type: "busy" });
  assert.deepEqual(await target.sessionStatus(), { type: "idle" });
});

test("kimi 2.6.3 实测·续接轮：历史轮在提交前边界之内——只发射新一轮（答案 ok、用量只计新轮）", async () => {
  const { calls, fetchImpl } = kimi263Server({
    preTurns: "t1-tools-turns-9-ended.json",
    submit: "t2-resume-submit.json",
    ticks: [{ prompts: "t1-tools-prompts-after.json", turns: "t2-resume-turns-ended.json" }],
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), {
    prompt: "What single word did you write into probe.txt? Reply with only that word.",
    sessionReuse: { turn: "resume", priorRunId: "run_prior" },
    priorProviderSessionId: KIMI_263_SESSION,
  });
  assert.ok(!calls.some((c) => c.method === "POST" && c.url.endsWith("/api/v1/sessions")), "续接不建新会话");
  const events = (await collect(handle)).filter((e) => e.kind !== "runtime_activity");
  assert.deepEqual(events.map((e) => e.kind), ["message", "message", "metrics", "done"], "历史轮的工具证据不重放");
  assert.equal(events[0].parts[0].text, "What single word did you write into probe.txt? Reply with only that word.");
  assert.equal(events[1].parts[0].text, "ok");
  assert.ok(!JSON.stringify(events).includes("DONE"), "前一轮的答案不重放");
  assert.deepEqual(events[2], {
    kind: "metrics",
    tokens: { input: 133, output: 37, cacheRead: 17152, cacheWrite: 0 },
    firstRequest: { input: 133, cacheRead: 17152 },
  });
});

test("kimi 2.6.3 实测·纠偏链：t4 转入后 t3 那一轮无回答结束——不在 t3 上提前收口，运行在 t4 那一轮完成、答案取 t4", async () => {
  const t3Active = kimi263("t4-correction-prompts-queued.json").json.data.active;
  let tick = 0;
  let correction = null;
  const { calls, fetchImpl } = kimi263Server({
    preTurns: "t2-resume-turns-ended.json",
    submit: "t3-steer-target-submit.json",
    corrections: ["t4-correction-queued-submit.json"],
    steers: ["t4-correction-steer.json"],
    ticks: [
      // 拍 1：t3 在跑。
      { prompts: promptsEnvelope(t3Active), turns: "t3-steer-target-turns-running.json" },
      // 拍 2（本拍先投递纠偏）：t4 已转入、离开队列；t3 已无回答结束；t4 的轮还没出现。
      { prompts: "t1-tools-prompts-after.json", turns: turnsOf("t3-steer-target-turns-after-steer.json", (o) => o <= 2) },
      // 拍 3：t4 开了下一轮、在跑。
      { prompts: "t3-steer-target-prompts-after.json", turns: "t3-steer-target-turns-after-steer.json" },
      // 拍 4：t4 那一轮完成（录到的终页里另有一个不属于本运行的中止轮）。
      { prompts: "t1-tools-prompts-after.json", turns: "final-turns-all.json" },
    ],
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "ping" });
  const events = await collect(handle, {
    onPollTick: async () => {
      tick += 1;
      if (tick === 2) correction = await handle.sendCorrection("Also, at the end of your answer, add the line STEERED-OK.");
    },
  });
  assert.deepEqual(correction, { ok: true }, "steered:true → 已转入");
  const steer = calls.find((c) => c.url.endsWith("/prompts:steer"));
  assert.deepEqual(JSON.parse(steer.body), { prompt_ids: ["msg_01M7NY9N2TCBYZ34A4SWKS3BMG"] });
  assert.equal(tick, 4, "拍 2（t3 已结束、t4 不可见）与拍 3（t4 在跑）都没有收口");
  const done = events.at(-1);
  assert.equal(done.reason, "completed");
  const assistant = events.filter((e) => e.kind === "message" && e.role === "assistant");
  assert.deepEqual(assistant.map((e) => e.parts[0].text), ["25 replies came back.\n\nSTEERED-OK"]);
  const user = events.find((e) => e.kind === "message" && e.role === "user");
  assert.match(user.parts[0].text, /^Use your shell tool to run `ping -n 25 127\.0\.0\.1`/, "用户回显取第一个归属轮（t3）的开场消息");
  assert.deepEqual(events.filter((e) => e.kind === "command").map((e) => e.command), ["ping -n 25 127.0.0.1"], "t4 那一轮的工具证据");
  assert.ok(!JSON.stringify(events).includes("ping -n 90"), "不属于本运行的轮不发射");
  assert.deepEqual(events.find((e) => e.kind === "metrics"), {
    kind: "metrics",
    tokens: { input: 1608, output: 239, cacheRead: 34304, cacheWrite: 0 },
  }, "各归属轮 usage 之和（t3 被打断那一步没有 usage）；第一个归属轮没有带 usage 的步 → 不写 firstRequest");
});

test("kimi 2.6.3 实测·中止轮：outcome interrupted / end_reason user_cancelled → failed；中止面读录到的 :abort、40402、会话详情与 turns 停止探针", async () => {
  const { fetchImpl } = kimi263Server({
    preTurns: "t3-steer-target-turns-after-steer.json",
    submit: "t5-abort-submit.json", // 录到的回执是 status "queued"（前一轮还在跑）——不是失败
    ticks: [{ prompts: "t1-tools-prompts-after.json", turns: "t5-abort-turns-ended.json" }],
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "ping 90" });
  const events = await collect(handle);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "failed");
  assert.equal(events[0].error, "kimi turn interrupted (turn t_2bacb896b753, end_reason: user_cancelled)");

  // 中止面：GET prompts 有活动 → :abort（录到的 aborted:true）→ 复查：列表空、会话详情
  // （录到的中止后详情）main_turn_active:false → 已停。再中止一次：列表已空，不发 :abort。
  // 对已停的 prompt 再 :abort 录到 40402。停止探针自 TD-362 起读 turns 最新一页
  // （2.7.2 删除了 /messages）——录到的终态轮：计数 = 各轮 items 之和。
  let aborts = 0;
  const abortFetch = kimiServer((url, init = {}) => {
    const method = init.method ?? "GET";
    if (method === "GET" && url === `${KIMI_263_BASE}/prompts`) {
      return aborts === 0 ? promptsEnvelope("msg_01M7NY9Q32GH5VKC88D7ZSMZ5J") : replay263("t1-tools-prompts-after.json");
    }
    if (method === "POST" && url.endsWith(":abort")) {
      aborts += 1;
      return replay263(aborts === 1 ? "t5-abort.json" : "t5-abort-again-40402.json");
    }
    if (url === KIMI_263_BASE) return replay263("t5-abort-session-after.json");
    if (method === "GET" && url.startsWith(`${KIMI_263_BASE}/agents/main/turns`)) return replay263("t5-abort-turns-ended.json");
    throw new Error(`unexpected ${method} ${url}`);
  });
  const stopper = new KimiWebBackend({ fetchImpl: abortFetch.fetchImpl, timeout: 5000, retries: 0, abortSettleMs: 0 });
  await stopper.stopTarget(makeAgent(), KIMI_263_SESSION).abort();
  assert.equal(aborts, 1);
  await stopper.abortActivePrompt(makeAgent(), KIMI_263_SESSION); // 列表已空：不再发 :abort
  assert.equal(aborts, 1);
  const again = await stopper.request(makeAgent(), `${KIMI_263_BASE}/prompts/msg_01M7NY9Q32GH5VKC88D7ZSMZ5J:abort`, { method: "POST", body: "{}" })
    .then(() => null, (error) => error);
  assert.match(again.message, /code 40402/);
  const target = stopper.stopTarget(makeAgent(), KIMI_263_SESSION);
  assert.deepEqual(await target.sessionStatus(), { type: "idle" });
  const page = await target.messages();
  const recordedTurns = kimi263("t5-abort-turns-ended.json").json.data.turns;
  const recordedMessages = kimi263("final-messages.json").json.data.items;
  assert.equal(
    page.data.length,
    recordedTurns.reduce((n, turn) => n + turn.items.length, 0),
    "停止探针计数 = 各轮 items 之和",
  );
  assert.equal(
    page.data.length,
    recordedMessages.length,
    "2.6.3 上 turns items 之和 = 当时 /messages 的条数（换端点后计数口径等价；final-messages.json 是旧端点的历史证据）",
  );
  assert.ok(page.data.length > 10);
});

/** 事件流的一拍 = 一次 GET prompts（每拍先读 prompts 再翻 turns）。假钟按它推进。 */
function isTickRequest(url, init = {}) {
  return (init.method ?? "GET") === "GET" && url.endsWith("/prompts");
}

/** 假钟每拍推进 stepMs，spawn 后跑完事件流（停滞门测试用）。 */
async function runClocked(handler, markSpawned, stepMs) {
  let fakeNow = 0;
  const { fetchImpl } = kimiServer((url, init, n) => {
    if (isTickRequest(url, init)) fakeNow += stepMs;
    return handler(url, init, n);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  return collect(handle, { pollInterval: 1, stallClock: () => fakeNow });
}

// 决定 0071/0072 的在途证据用例：在跑的轮 / 结束的轮（条目前补开场消息）。
function running0071(items) {
  return [runningTurn({ items: [userMessageItem(), ...items] })];
}
function ended0071(items, extra = {}) {
  return [kimiTurn({ items: [userMessageItem(), ...items], ...extra })];
}
async function collect0071(sessionId, script) {
  const { events } = await runScript(sessionId, { script });
  // streaming 事实按节流发射，与这组断言无关。
  return events.filter((e) => e.kind !== "runtime_activity");
}

const SESSION_URL = "http://127.0.0.1:4310/api/v1/sessions/session_new";
const PROMPTS_URL = `${SESSION_URL}/prompts`;

/**
 * spawn 路由 + 中止路由：GET prompts 缺省在发过 :abort 之后答 afterAbort（中止生效），
 * 之前答 promptsData；onList(abortPosts) 整体接管列表。POST :abort 交给 onAbort（缺省
 * aborted:true）。会话详情由 detail(abortPosts) 给（缺省不在跑）。
 */
function abortServer({
  promptsData, afterAbort = { active: null, queued: [] }, onAbort = () => envelope({ aborted: true }), onList,
  detail = () => detailEnvelope("session_new", false, false, null),
}) {
  let abortPosts = 0;
  return kimiServer((url, init = {}) => {
    if (url.includes("/api/v1/shutdown")) {
      throw new Error("server-level shutdown must never be called by the backend");
    }
    if (url === PROMPTS_URL && (init.method ?? "GET") === "GET") {
      if (onList) return onList(abortPosts);
      return envelope(abortPosts > 0 ? afterAbort : promptsData);
    }
    if (url.endsWith(":abort")) {
      abortPosts += 1;
      return onAbort(url, init);
    }
    if (url === SESSION_URL) return detail(abortPosts);
    return spawnOkRoutes()(url);
  });
}

test("kimi-web ①: validateAgentPolicy 通过分支与全部拒绝分支（无 model.id / 空白 model.id / providerID / variant / reasoning / contextWindow / provider / 无 serveUrl / 无 tokenEnv）", () => {
  const backend = new KimiWebBackend({ fetchImpl: async () => { throw new Error("no network expected"); } });
  assert.doesNotThrow(() => backend.validateAgentPolicy(makeAgent()));
  // 上游缺 model 静默秒败——必须 fail-closed 在派发前（任务书实测坑 3）。
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ model: undefined })), /requires model\.id/);
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ model: {} })), /requires model\.id/);
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ model: { id: "" } })), /requires model\.id/);
  // 修复 D：纯空白串与缺失同罪（空白 id 直传上游 = 事实上的缺 model 静默秒败）。
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ model: { id: "   " } })), /requires model\.id/);
  // 修复 D：kimi-web 无 providerID/variant 表达面（防遗留路由字段被静默丢弃）。
  assert.throws(
    () => backend.validateAgentPolicy(makeAgent({ model: { id: "kimi-code/k3", providerID: "moonshot" } })),
    /cannot express model\.providerID\/model\.variant/,
  );
  assert.throws(
    () => backend.validateAgentPolicy(makeAgent({ model: { id: "kimi-code/k3", variant: "stable" } })),
    /cannot express model\.providerID\/model\.variant/,
  );
  // 2.4.0：reasoning.effort 直传 prompts thinking——只放行 low/high/max，其余档位硬拒。
  for (const effort of ["low", "high", "max"]) {
    assert.doesNotThrow(() => backend.validateAgentPolicy(makeAgent({ reasoning: { effort } })), effort);
  }
  for (const effort of ["minimal", "medium", "xhigh", "off", undefined]) {
    assert.throws(
      () => backend.validateAgentPolicy(makeAgent({ reasoning: { effort } })),
      /supports reasoning\.effort low, high or max only/,
      String(effort),
    );
  }
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ model: { id: "kimi-code/k3", contextWindow: 200000 } })), /cannot express model\.contextWindow/);
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ serveUrl: undefined })), /requires serveUrl/);
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ serveUrl: "   " })), /requires serveUrl/);
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ tokenEnv: undefined })), /requires tokenEnv/);
  assert.throws(() => backend.validateAgentPolicy(makeAgent({ tokenEnv: " " })), /requires tokenEnv/);
});

// ===== ② spawn（fresh 轮）请求形状 =====

test("kimi-web ②: spawn fresh 轮——POST /sessions → GET detail（F3 静默门）→ GET agents/main/turns（提交前边界读）→ POST prompts（时序锚定）；body 形状与 Bearer 头", async () => {
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
  assert.equal(calls.length, 4, "fresh 轮恰四个请求：建会话 + 提交前静默门 detail + 提交前 turns 读 + 发 prompt");

  assert.equal(calls[0].url, "http://127.0.0.1:4310/api/v1/sessions");
  assert.equal(calls[0].method, "POST");
  // metadata.cwd 必填（缺则 40001）——用 agent.cwd 填。
  assert.deepEqual(JSON.parse(calls[0].body), {
    title: "wao",
    metadata: { cwd: "D:/projects/worktree" },
  });
  // F3 静默门先行：建会话后先 GET detail 确认 busy/main_turn_active 严格 false，
  // turns 读才在门后落定。
  assert.equal(calls[1].url, "http://127.0.0.1:4310/api/v1/sessions/session_new");
  assert.equal(calls[1].method, "GET");
  // 提交前 turns 读必须在 POST prompts 之前（记下翻页边界）。
  assert.equal(calls[2].url, "http://127.0.0.1:4310/api/v1/sessions/session_new/agents/main/turns");
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
  // 修复 G：role 与 task 用固定分隔符（"\n\n---\n\n"）拼接。
  assert.equal(promptBody.content[0].text, "ROLE CONTRACT\n\n---\n\ntask body");
  assert.equal(promptBody.content.length, 1, "role 与 task 同在唯一 text 分段里（恰好一次）");
});

test("kimi-web ②: reasoning.effort low/high/max → POST prompts body 带 thinking:<effort>；不配力度时 body 无 thinking 字段", async () => {
  for (const effort of ["low", "high", "max"]) {
    const { calls, fetchImpl } = kimiServer(spawnOkRoutes());
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    await backend.spawn(makeAgent({ reasoning: { effort } }), { prompt: "x" });
    const body = JSON.parse(calls[3].body);
    assert.equal(calls[3].url, "http://127.0.0.1:4310/api/v1/sessions/session_new/prompts");
    assert.equal(body.thinking, effort);
  }
  const { calls, fetchImpl } = kimiServer(spawnOkRoutes());
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  await backend.spawn(makeAgent(), { prompt: "x" });
  assert.ok(!Object.hasOwn(JSON.parse(calls[3].body), "thinking"), "没配力度就不带 thinking");
});

test("kimi-web ②: 不支持的力度在首个 HTTP 请求前拒绝", async () => {
  const { calls, fetchImpl } = kimiServer(() => { throw new Error("no requests expected"); });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  for (const effort of ["minimal", "medium", "xhigh"]) {
    await assert.rejects(
      () => backend.spawn(makeAgent({ reasoning: { effort } }), { prompt: "x" }),
      /supports reasoning\.effort low, high or max only/,
    );
  }
  assert.equal(calls.length, 0);
});

test("kimi-web ②: spawn 前置策略门——坏配置在首个 HTTP 请求前拒绝", async () => {
  const { calls, fetchImpl } = kimiServer(() => { throw new Error("no requests expected"); });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  await assert.rejects(() => backend.spawn(makeAgent({ model: undefined }), { prompt: "x" }), /requires model\.id/);
  await assert.rejects(() => backend.spawn(makeAgent({ tokenEnv: "" }), { prompt: "x" }), /requires tokenEnv/);
  assert.equal(calls.length, 0);
});

// ===== ③ resume 轮（session 复用） =====

test("kimi-web ③: resume 轮不 POST /sessions——GET detail（F3 静默门）→ GET agents/main/turns（提交前边界读）→ 向前任 id 发 prompts", async () => {
  const { calls, fetchImpl } = kimiServer((url) => {
    if (url === "http://127.0.0.1:4310/api/v1/sessions") {
      throw new Error("resume turn must not create a new session");
    }
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_prior") {
      return detailEnvelope("session_prior", false, false, null);
    }
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_prior/agents/main/turns") {
      return turnsEnvelope([]);
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
  assert.equal(calls.length, 3, "resume 轮恰三个请求：提交前静默门 detail + 提交前 turns 读 + 发 prompt");
  assert.deepEqual(calls.map((c) => c.method), ["GET", "GET", "POST"]);
  assert.equal(calls[0].url, "http://127.0.0.1:4310/api/v1/sessions/session_prior");
  assert.equal(calls[1].url, "http://127.0.0.1:4310/api/v1/sessions/session_prior/agents/main/turns");
  assert.equal(calls[2].url, "http://127.0.0.1:4310/api/v1/sessions/session_prior/prompts");
  assert.deepEqual(JSON.parse(calls[2].body), {
    content: [{ type: "text", text: "continue" }],
    model: "kimi-code/k3",
    permission_mode: "auto",
  });
});

test("kimi-web ③: resume 轮同样带 thinking（车道声明或 --reasoning 覆盖合成进 agent.reasoning）", async () => {
  const { calls, fetchImpl } = kimiServer((url) => {
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_prior") {
      return detailEnvelope("session_prior", false, false, null);
    }
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_prior/agents/main/turns") {
      return turnsEnvelope([]);
    }
    if (url.endsWith("/api/v1/sessions/session_prior/prompts")) {
      return envelope({ prompt_id: "msg_q2", status: "running" });
    }
    throw new Error(`unexpected ${url}`);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  await backend.spawn(makeAgent({ reasoning: { effort: "max" } }), {
    prompt: "continue",
    sessionReuse: { turn: "resume", priorRunId: "run_prior" },
    priorProviderSessionId: "session_prior",
  });
  assert.equal(calls[2].url, "http://127.0.0.1:4310/api/v1/sessions/session_prior/prompts");
  assert.deepEqual(JSON.parse(calls[2].body), {
    content: [{ type: "text", text: "continue" }],
    model: "kimi-code/k3",
    permission_mode: "auto",
    thinking: "max",
  });
});

test("kimi-web ③ ⑥: resume——会话已有历史轮 + 新 prompt 的轮 → 只发射新轮内容、usage 只计新轮（prompt_ids 归属：历史轮不含本运行的 id）", async () => {
  // 前任轮：prompt_ids=[msg_old]（永不等于本运行的 prompt id——误归属与历史重放按构造
  // 不可能）；usage 刻意取大值（9999）钉"只计新轮"。
  const priorTurn = kimiTurn({
    turn_id: "t_prev", ordinal: 0, promptIds: ["msg_old"], prompt: "prior question", answer: "prior answer",
    steps: [stepItem({ usage: { input_other: 9999, output: 9999, input_cache_read: 9999, input_cache_creation: 9999 } })],
  });
  const newTurn = kimiTurn({
    turn_id: "t_new", ordinal: 1, promptIds: ["msg_q2"], prompt: "continue", answer: "new answer",
    steps: [stepItem({ usage: { input_other: 40, output: 6, input_cache_read: 2, input_cache_creation: 1 } })],
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
  const events = await collect(handle);
  assert.deepEqual(events.map((e) => e.kind), ["message", "message", "metrics", "done"]);
  assert.equal(events.at(-1).reason, "completed");
  assert.ok(!JSON.stringify(events).includes("prior answer"), "前任 assistant 文本不重放");
  assert.ok(!JSON.stringify(events).includes("prior question"), "前任 user prompt 不重放");
  assert.deepEqual(events[0].parts, [{ type: "text", text: "continue" }]);
  assert.deepEqual(events[1].parts, [{ type: "text", text: "new answer" }]);
  assert.deepEqual(events[2], {
    kind: "metrics",
    tokens: { input: 40, output: 6, cacheRead: 2, cacheWrite: 1 },
    firstRequest: { input: 40, cacheRead: 2 },
  });
  assert.equal(polls(), 1, "首拍即终态（新轮已 ended）");
});

test("kimi-web ③: resume 轮缺 prior id / proc_ 占位 / 空串 → 派发前拒绝且零请求（resume 关联面合同）", async () => {
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
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_c/agents/main/turns") {
      return turnsEnvelope([]);
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
      if (url.endsWith("/agents/main/turns")) return turnsEnvelope([]);
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
      if (url.endsWith("/agents/main/turns")) return turnsEnvelope([]);
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
      if (url.endsWith("/agents/main/turns")) return turnsEnvelope([]);
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


// ===== ⑤ events 轮询生成器：turns 轮按 prompt_ids 归属、最终轮 ended 按 outcome 收口 =====

test("kimi-web ⑤ ①: 完成轮——工具证据先行（Write / Bash / Read / 出错的 Bash）→ 用户回显 → 答案（跨步空一行）→ metrics（轮级 usage）→ completed；reasoning 不投影", async () => {
  const turn = kimiTurn({
    steps: [
      stepItem({ index: 1, finish_reason: "tool_use", usage: { input_other: 100, output: 7, input_cache_read: 10, input_cache_creation: 3 } }),
      stepItem({ index: 2, usage: { input_other: 50, output: 5, input_cache_read: 10, input_cache_creation: 3 } }),
    ],
    items: [
      userMessageItem(["msg_q1"], "hi"),
      { type: "reasoning", item_id: "r_1", step_index: 1, status: "ended", text: "(internal reasoning)" },
      toolCallItem({
        item_id: "tc_write", name: "Write", input: { path: "wao_perm_probe.txt", content: "probe" },
        display: { kind: "file_io", operation: "write", path: "D:/projects/worktree/wao_perm_probe.txt" },
        output: "Wrote 5 bytes to wao_perm_probe.txt",
      }),
      assistantItem("Hello", 1),
      toolCallItem({ item_id: "tc_bash", step_index: 2, input: { command: "node scripts/probe.mjs" }, output: "probe ok" }),
      toolCallItem({ item_id: "tc_read", step_index: 2, name: "Read", input: { path: "README.md" }, display: { kind: "file_io", operation: "read" }, output: "readme body" }),
      toolCallItem({ item_id: "tc_err", step_index: 2, input: { command: "node scripts/failing.mjs" }, outcome: "failed", output: "exit status 1" }),
      assistantItem(" world", 2),
    ],
  });
  const { events, polls } = await runScript("session_c1", { script: [[turn]] });
  assert.deepEqual(events.map((e) => e.kind), [
    "file_written", "tool_result", // Write（display.path）
    "command", "tool_result", // Bash
    "tool_use", "tool_result", // Read（非 shell / 写文件类 → tool_use）
    "command", "tool_result", // 出错的 Bash（outcome 非 completed → isError）
    "message", "message", "metrics", "done",
  ]);
  assert.deepEqual(events[0], { kind: "file_written", path: "D:/projects/worktree/wao_perm_probe.txt" }, "路径取 display.path，不取 input.path");
  assert.deepEqual(events[1], { kind: "tool_result", tool: "tc_write", output: "Wrote 5 bytes to wao_perm_probe.txt", isError: false });
  assert.deepEqual(events[2], { kind: "command", command: "node scripts/probe.mjs", toolCallId: "tc_bash" });
  assert.deepEqual(events[4], { kind: "tool_use", tool: "Read", input: { path: "README.md" } });
  assert.deepEqual(events[7], { kind: "tool_result", tool: "tc_err", output: "exit status 1", isError: true });
  assert.deepEqual(events[8].parts, [{ type: "text", text: "hi" }]);
  assert.deepEqual(events[9].parts, [{ type: "text", text: "Hello\n\n world" }], "不同步之间空一行");
  assert.ok(!JSON.stringify(events).includes("internal reasoning"), "reasoning 不进事件流");
  assert.deepEqual(events[10], {
    kind: "metrics",
    tokens: { input: 150, output: 12, cacheRead: 20, cacheWrite: 6 },
    firstRequest: { input: 100, cacheRead: 10 },
  }, "轮级 usage 求和；firstRequest 取 index 最小那一步");
  assert.equal(events[11].reason, "completed");
  assert.equal(polls, 1);
});


test("kimi-web ⑤: 工具调用非终态 / 写文件缺路径 → status 非 ended 不追加 tool_result；没有路径不虚构 file_written", async () => {
  {
    const turn = kimiTurn({
      steps: [stepItem({ usage: undefined })],
      items: [
        userMessageItem(),
        toolCallItem({ item_id: "tc_run", status: "running", input: { command: "node scripts/watch.mjs" }, outcome: undefined, output: undefined }),
        assistantItem("still working"),
      ],
    });
    const { events } = await runScript("session_tr", { script: [[turn]] });
    assert.deepEqual(events.map((e) => e.kind), ["command", "message", "message", "done"]);
    assert.deepEqual(events[0], { kind: "command", command: "node scripts/watch.mjs", toolCallId: "tc_run" });
  }
  {
    const turn = kimiTurn({
      steps: [stepItem({ usage: undefined })],
      items: [
        userMessageItem(),
        toolCallItem({ item_id: "tc_nopath", name: "Write", input: { content: "no target path" }, display: { kind: "file_io" }, output: "nothing written" }),
        assistantItem("no path case"),
      ],
    });
    const { events } = await runScript("session_np", { script: [[turn]] });
    assert.deepEqual(events.map((e) => e.kind), ["tool_result", "message", "message", "done"]);
    assert.deepEqual(events[0], { kind: "tool_result", tool: "tc_nopath", output: "nothing written", isError: false });
  }
});

test("kimi-web ⑤ ⑩: usage 只报 input/output → metrics 不补 cacheRead/cacheWrite 0（缓存占比未知）", async () => {
  const turn = kimiTurn({ answer: "answer without cache counters", usage: { input_other: 100, output: 7 } });
  const { events } = await runScript("session_c3", { script: [[turn]] });
  const metrics = events.find((event) => event.kind === "metrics");
  assert.deepEqual(metrics.tokens, { input: 100, output: 7 }, "上游没报的缓存分量不补 0");
});

test("kimi-web ⑤ ⑩: 归属轮都没有 usage → 不发 metrics 事件（绝不虚构零值通道）", async () => {
  const turn = kimiTurn({ answer: "answer without usage", steps: [stepItem({ usage: undefined })] });
  const { events, polls } = await runScript("session_c2", { script: [[turn]] });
  assert.deepEqual(events.map((e) => e.kind), ["message", "message", "done"]);
  assert.deepEqual(events[1].parts, [{ type: "text", text: "answer without usage" }]);
  assert.equal(polls, 1);
});

test("kimi-web ⑤ ②: outcome failed（文档在册、未实测）→ 首拍 done(failed)，error 的 code/message 写进文案", async () => {
  const turn = kimiTurn({ outcome: "failed", error: { code: "model_not_set", message: "Model not set" }, answer: null, steps: [] });
  const start = Date.now();
  const { events, polls } = await runScript("session_f1", { script: [[turn]] }, { silentTimeout: 60_000 });
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "failed");
  assert.equal(events[0].error, "kimi turn failed (turn t_0, error: model_not_set: Model not set)");
  assert.equal(polls, 1);
  assert.ok(Date.now() - start < 2000);
});

test("kimi-web ⑤: interrupted / failed 缺原因字段 → done(failed, 固定文案)，不虚构原因；error 为字符串原样写", async () => {
  const legs = [
    [kimiTurn({ outcome: "interrupted", answer: null }), "kimi turn interrupted (turn t_0, no end_reason upstream)"],
    [kimiTurn({ outcome: "failed", error: null, answer: null }), "kimi turn failed (turn t_0, no error field upstream)"],
    [kimiTurn({ outcome: "failed", error: "upstream exploded", answer: null }), "kimi turn failed (turn t_0, error: upstream exploded)"],
  ];
  for (const [turn, text] of legs) {
    const { events } = await runScript("session_cc", { script: [[turn]] });
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "failed");
    assert.equal(events[0].error, text);
  }
});

test("kimi-web ⑤ ③: running→ended 两拍转移——首拍等待（在途事实）、次拍终态发射", async () => {
  const { events, polls } = await runScript("session_rc", {
    script: [[runningTurn()], [kimiTurn({ answer: "slow answer" })]],
  });
  assert.deepEqual(events.map((e) => e.kind), ["runtime_activity", "message", "message", "metrics", "done"]);
  assert.equal(events[0].status, "streaming");
  assert.deepEqual(events[2].parts, [{ type: "text", text: "slow answer" }]);
  assert.equal(polls, 2);
});

test("kimi-web ⑤ ④: 提交滞后——本运行的 prompt 不在任何轮里（他人轮在场也不误领）、silentTimeout 到期 → silent fail（相对提交时刻）", async () => {
  const foreign = kimiTurn({ turn_id: "t_fx", promptIds: ["msg_FOREIGN"], prompt: "someone else's question", answer: "foreign answer" });
  const start = Date.now();
  const { events, polls } = await runScript("session_lag", { script: [[foreign]] }, { pollInterval: 30, silentTimeout: 120 });
  const done = events.at(-1);
  assert.equal(done.reason, "failed");
  assert.match(done.error, /silent timeout: turn for this prompt not observed within 120ms/);
  assert.ok(events.length === 1 && !JSON.stringify(events).includes("foreign answer"), "他人轮内容绝不误领/发射");
  assert.ok(polls >= 2);
  assert.ok(Date.now() - start < 2000);
});

test("kimi-web ⑤ ⑤a (TD-197①): 慢启动静默不被拍数门误杀；静默段 ≥ 自适应预算（60s floor）且 serve 说不活跃才 bounded fail", async () => {
  const { handler, markSpawned, polls } = turnScriptServer("session_st", { script: [[runningTurn()]] });
  // 时钟注入缝：每拍（一次 GET prompts）推进 10s。拍 1 最终轮现身 = 基线；拍 7 静默 60s ≥ floor。
  let fakeNow = 0;
  const { fetchImpl } = kimiServer((url, init) => {
    if (isTickRequest(url, init)) fakeNow += 10_000;
    return handler(url, init);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  const start = Date.now();
  const events = await collect(handle, { pollInterval: 1, stallClock: () => fakeNow });
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "runtime_activity");
  assert.equal(events[1].reason, "failed");
  assert.match(events[1].error, /turn stalled \(no progress\)/);
  assert.match(events[1].error, /60000ms floor/);
  assert.match(events[1].error, /attestation: inactive/);
  assert.equal(polls(), 7);
  assert.ok(Date.now() - start < 2000, "假钟驱动，零真实等待");
});



test("kimi-web ⑤ ⑤b: 每拍答案文本增长（>8 拍仍在写）→ 第 9 拍 ended 正常完成（绝不误杀）", async () => {
  const growing = (poll) => [runningTurn({ items: [userMessageItem(), assistantItem("x".repeat(poll))] })];
  const { events, polls } = await runScript("session_gr", {
    script: [...Array(8).fill(growing), [kimiTurn({ answer: "xxxxxxxx" })]],
  });
  assert.equal(events.at(-1).reason, "completed");
  assert.ok(!JSON.stringify(events).includes("turn stalled"));
  assert.deepEqual(events.filter((e) => e.kind === "message")[1].parts, [{ type: "text", text: "xxxxxxxx" }]);
  assert.equal(polls, 9);
});

test("kimi-web ⑤ ⑨: onPollTick 每拍恰一次且先于观测读——首 tick 抛错不杀流（best-effort）", async () => {
  let ticks = 0;
  let tickThrew = false;
  const { events, polls } = await runScript("session_tk", {
    script: [[runningTurn()], [runningTurn()], [kimiTurn({ answer: "done" })]],
  }, {
    onPollTick: async () => {
      ticks += 1;
      if (ticks === 1) {
        tickThrew = true;
        throw new Error("tick blew up (must be best-effort)");
      }
    },
  });
  assert.ok(tickThrew);
  assert.equal(events.at(-1).reason, "completed");
  assert.equal(ticks, polls);
  assert.equal(ticks, 3);
});

test("kimi-web ⑤ ⑦: completed 但没有回答（仅 reasoning / 纯空白 / 只有开场消息 / 只有工具调用）→ done(failed)（N1：绝不伪造完成），零证据", async () => {
  const legs = [
    [userMessageItem(), { type: "reasoning", item_id: "r", step_index: 1, text: "(only reasoning)" }],
    [userMessageItem(), assistantItem("   "), assistantItem(" ", 2)],
    [userMessageItem()],
    [userMessageItem(), toolCallItem({ item_id: "tc_w2", name: "Write", input: { path: "probe.txt", content: "probe" }, display: { path: "D:/w/probe.txt" }, output: "Wrote 5 bytes" })],
  ];
  for (const items of legs) {
    const { events, polls } = await runScript("session_e1", { script: [[kimiTurn({ items })]] });
    assert.equal(events.length, 1, JSON.stringify(items));
    assert.equal(events[0].reason, "failed");
    assert.match(events[0].error, /completed without assistant text/);
    assert.equal(polls, 1);
  }
});

test("kimi-web ⑤ ⑧: 形状门 fail-closed——turns 缺数组 / has_more 非布尔 / 轮缺 turn_id；prompts 列表缺 queued / queued 非数组 / 条目缺 prompt_id / 缺 active（不当成没有排队）；spawn 提交前读同样上抛", async () => {
  const turnsLegs = [
    envelope({ has_more: false }),
    envelope({ turns: [] }),
    envelope({ turns: [{ ordinal: 0 }], has_more: false }),
    envelope({ turns: [{ turn_id: "t", ordinal: "0" }], has_more: false }),
  ];
  for (const reply of turnsLegs) {
    const { fetchImpl } = kimiServer((url) => {
      if (url.endsWith("/prompts")) return promptsEnvelope();
      if (url.endsWith("/agents/main/turns")) return reply;
      throw new Error(`unexpected ${url}`);
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const events = [];
    for await (const ev of backend.streamEvents(makeAgent(), "ses_m8", { interval: 5, runPrompts: bareRun() })) events.push(ev);
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "failed");
    assert.match(events[0].error, /turns response malformed/);
  }
  const promptsLegs = [
    { active: null },
    { queued: [] },
    { active: null, queued: "msg_q2" },
    { active: null, queued: [{ status: "queued" }] },
    { active: { status: "running" }, queued: [] },
    { active: "msg_q1", queued: [] },
  ];
  for (const data of promptsLegs) {
    const { calls, fetchImpl } = kimiServer((url) => {
      if (url.endsWith("/prompts")) return envelope(data);
      if (url.endsWith("/agents/main/turns")) return turnsEnvelope([kimiTurn()]);
      throw new Error(`unexpected ${url}`);
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const events = [];
    for await (const ev of backend.streamEvents(makeAgent(), "ses_m8p", { interval: 5, runPrompts: bareRun() })) events.push(ev);
    assert.equal(events.length, 1, JSON.stringify(data));
    assert.equal(events[0].reason, "failed", "完成的轮就在那里，也不能当成没有排队而收口");
    assert.match(events[0].error, /prompts list malformed/);
    assert.ok(!calls.some((c) => c.url.endsWith("/turns")), "列表读不可信即收口");
  }
  {
    const { calls, fetchImpl } = kimiServer((url) => {
      if (url === "http://127.0.0.1:4310/api/v1/sessions") return envelope({ id: "session_m9" });
      if (url === "http://127.0.0.1:4310/api/v1/sessions/session_m9") return detailEnvelope("session_m9", false, false, null);
      if (url === "http://127.0.0.1:4310/api/v1/sessions/session_m9/agents/main/turns") return envelope({ has_more: false });
      throw new Error(`unexpected ${url}`);
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    await assert.rejects(() => backend.spawn(makeAgent(), { prompt: "hi" }), /turns response malformed/);
    assert.ok(calls.every((c) => c.method === "GET" || c.url.endsWith("/api/v1/sessions")), "形状不可信即整体不可信——零 POST prompts");
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
  for await (const ev of backend.streamEvents(makeAgent(), "ses_x", { interval: 5, runPrompts: bareRun() })) {
    events.push(ev);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "failed");
  assert.ok(events[0].error.includes("fetch failed"));
});

test("kimi-web ⑤ ⑪: turns 读回 code!==0 信封 → done(failed, 含 code 与 msg)", async () => {
  const { fetchImpl } = kimiServer((url) => {
    if (url.endsWith("/prompts")) return promptsEnvelope();
    if (url.endsWith("/agents/main/turns")) return envelope(null, { code: 40001, msg: "bad request" });
    throw new Error(`unexpected ${url}`);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents(makeAgent(), "ses_code", { interval: 5, runPrompts: bareRun() })) {
    events.push(ev);
  }
  assert.equal(events[0].reason, "failed");
  assert.match(events[0].error, /code 40001/);
  assert.match(events[0].error, /bad request/);
});

test("kimi-web ⑤: signal.aborted → 静默结束（不 emit done）", async () => {
  const { fetchImpl } = kimiServer((url) => {
    if (url.endsWith("/prompts")) return promptsEnvelope("msg_q1");
    if (url.endsWith("/agents/main/turns")) return turnsEnvelope([runningTurn()]);
    throw new Error(`unexpected ${url}`);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const controller = new AbortController();
  const events = [];
  setTimeout(() => controller.abort(), 30);
  for await (const ev of backend.streamEvents(makeAgent(), "ses_a", { interval: 5, signal: controller.signal, runPrompts: bareRun() })) {
    events.push(ev);
  }
  assert.ok(events.every((e) => e.kind === "runtime_activity"), "abort 前只可能有在途事实，绝无 message/done——终态归 RunManager");
});

test("kimi-web ⑤: 闭集外的 status / outcome → 一律非终态，连续 8 拍后 unsupported-state 有界出口收口", async () => {
  for (const [turn, pattern] of [
    [kimiTurn({ status: "banana" }), /unsupported turn state: status=banana outcome=completed/],
    [kimiTurn({ outcome: "exploded" }), /unsupported turn state: status=ended outcome=exploded/],
    [kimiTurn({ status: "queued", outcome: undefined, answer: null }), /unsupported turn state: status=queued outcome=undefined/],
  ]) {
    const { events, polls } = await runScript("session_wz", { script: [[turn]] });
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "failed");
    assert.match(events[0].error, pattern);
    assert.equal(polls, 8);
  }
});

// ===== 运行的提示集合：纠偏记账、逐条结算、翻页、最终轮切换（第 109 批）=====

/**
 * 纠偏用的假服务器：spawn 回 msg_q1；之后的 POST prompts 依次回 corrections 里的回执，
 * steer 依次回 steers 里的答复；GET prompts / turns 按拍回放（同 turnScriptServer）。
 */
function correctionServer(sessionId, { script, prompts = null, corrections = [], steers = [] }) {
  const inner = turnScriptServer(sessionId, { script, prompts });
  let spawned = false;
  const handler = (url, init = {}, n) => {
    const method = init.method ?? "GET";
    if (spawned && method === "POST" && url.endsWith(`/sessions/${sessionId}/prompts`)) return corrections.shift();
    if (method === "POST" && url.endsWith("/prompts:steer")) return steers.shift();
    return inner.handler(url, init, n);
  };
  return { handler, markSpawned: () => { spawned = true; inner.markSpawned(); }, polls: inner.polls };
}

async function runCorrected(sessionId, opts, { correctAt = 2, text = "fix it", ...eventOpts } = {}) {
  const { handler, markSpawned, polls } = correctionServer(sessionId, opts);
  const { fetchImpl, calls } = kimiServer(handler);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  let ticks = 0;
  let sent = null;
  const events = await collect(handle, {
    onPollTick: async () => {
      ticks += 1;
      if (ticks === correctAt) sent = await handle.sendCorrection(text);
    },
    ...eventOpts,
  });
  return { events, polls: polls(), sent, calls };
}

const correctionReceipt = (id, status = "queued") => envelope({ prompt_id: id, user_message_id: id, status });

test("kimi-web 纠偏①: 已转入的纠偏在 prompts 里看不到、它的轮还没出现 → 不收口（哪怕派发那一轮已带回答结束）；纠偏开轮后运行在那一轮收口", async () => {
  const dispatchTurn = kimiTurn({ turn_id: "t_d", ordinal: 0, answer: "first answer" });
  const correctionTurn = kimiTurn({ turn_id: "t_c", ordinal: 1, promptIds: ["msg_c"], prompt: "fix it", answer: "corrected answer" });
  const { events, polls, sent } = await runCorrected("session_cr1", {
    script: [[runningTurn({ turn_id: "t_d" })], [dispatchTurn], [dispatchTurn], [dispatchTurn, correctionTurn]],
    corrections: [correctionReceipt("msg_c")],
    steers: [envelope({ steered: true, prompt_ids: ["msg_c"] })],
  });
  assert.deepEqual(sent, { ok: true });
  assert.equal(polls, 4, "拍 2、3：派发轮已结束、纠偏既不在列表也不在轮里——等");
  assert.equal(events.at(-1).reason, "completed");
  const texts = events.filter((e) => e.kind === "message").map((e) => `${e.role}:${e.parts[0].text}`);
  assert.deepEqual(texts, ["user:hi", "assistant:corrected answer"], "答案取最终轮；回显取第一个归属轮的开场消息");
  assert.deepEqual(events.find((e) => e.kind === "metrics").tokens, { input: 200, output: 14, cacheRead: 20, cacheWrite: 6 }, "两轮 usage 之和");
});

test("kimi-web 纠偏②: 已转入的纠偏一直不出现 → 从它被转入的时刻起算（不用派发的原点），到界失败并写明", async () => {
  // silentTimeout 缺席 → 每条提示各自数 8 拍。派发在拍 1 已入轮；纠偏在拍 3 转入（那时
  // 派发轮已带回答结束），拍 3..10 数满 8 拍 → 拍 10 失败。
  const script = [[runningTurn()], [runningTurn()], [kimiTurn({ answer: "first answer" })]];
  const { events, polls, sent } = await runCorrected("session_cr2", {
    script,
    corrections: [correctionReceipt("msg_c")],
    steers: [envelope({ steered: true })],
  }, { correctAt: 3 });
  assert.deepEqual(sent, { ok: true });
  assert.equal(polls, 10);
  assert.equal(events.at(-1).reason, "failed");
  assert.match(events.at(-1).error, /correction prompt msg_c was steered into the session but no turn ran it within 8 consecutive polls/);
  // silentTimeout 在场：上界相对转入时刻。
  const timed = await runCorrected("session_cr2b", {
    script,
    corrections: [correctionReceipt("msg_c")],
    steers: [envelope({ steered: true })],
  }, { correctAt: 3, pollInterval: 20, silentTimeout: 100 });
  assert.match(timed.events.at(-1).error, /no turn ran it within 100ms of the steer/);
});

test("kimi-web 纠偏③: steer 失败的纠偏（仅接纳）——还在 queued 里不计时；既不在轮里也不在列表里，从它自己的提交时刻起数到界 → 按未执行结算、发 system 消息，运行照常收口", async () => {
  const { events, polls, sent } = await runCorrected("session_cr3", {
    script: [[runningTurn()], [kimiTurn({ answer: "first answer" })]],
    // 拍 2..11 它在 queued 里（服务端还拿着它），之后消失、也没有开轮。
    prompts: (poll) => (poll >= 2 && poll <= 11 ? { active: null, queued: ["msg_c"] } : { active: null, queued: [] }),
    corrections: [correctionReceipt("msg_c")],
    steers: [envelope(null, { code: 40402, msg: "no active prompt to steer into" })],
  });
  assert.deepEqual(sent, { ok: false, reason: "send_failed" }, "返回值含义不变");
  assert.equal(polls, 19, "拍 2..11 在队列里不计；拍 12..19 数满 8 拍");
  const system = events.filter((e) => e.kind === "message" && e.role === "system");
  assert.equal(system.length, 1);
  assert.match(system[0].parts[0].text, /correction prompt msg_c was not executed — its steer had failed/);
  assert.equal(events.at(-1).reason, "completed");
  assert.equal(events.find((e) => e.role === "assistant").parts[0].text, "first answer");
});

test("kimi-web 纠偏④: steer 失败的纠偏之后自己开了一轮 → 照常归属，运行在那一轮收口", async () => {
  const later = kimiTurn({ turn_id: "t_c", ordinal: 1, promptIds: ["msg_c"], prompt: "fix it", answer: "late correction answer" });
  const { events, polls } = await runCorrected("session_cr4", {
    script: [[runningTurn()], [kimiTurn({ answer: "first" })], [kimiTurn({ answer: "first" })], [kimiTurn({ answer: "first" }), later]],
    prompts: (poll) => (poll === 2 || poll === 3 ? { active: null, queued: ["msg_c"] } : { active: null, queued: [] }),
    corrections: [correctionReceipt("msg_c")],
    steers: [envelope({ steered: false })],
  });
  assert.equal(polls, 4);
  assert.equal(events.at(-1).reason, "completed");
  assert.equal(events.find((e) => e.role === "assistant").parts[0].text, "late correction answer");
});

test("kimi-web 纠偏⑤: 回执 blocked/failed 的纠偏不入账（send_failed）；集合里的 id 在 prompts 列表里报 blocked/failed → 运行失败并写明哪条", async () => {
  const blocked = await runCorrected("session_cr5", {
    script: [[runningTurn()], [kimiTurn({ answer: "first" })]],
    corrections: [correctionReceipt("msg_c", "blocked")],
    steers: [],
  }, { correctAt: 1 });
  assert.deepEqual(blocked.sent, { ok: false, reason: "send_failed" });
  assert.ok(!blocked.calls.some((c) => c.url.endsWith("/prompts:steer")), "不对提交即失败的 prompt steer");
  assert.equal(blocked.events.at(-1).reason, "completed", "没入账的纠偏不挡收口");
  const listed = await runCorrected("session_cr5b", {
    script: [[kimiTurn({ answer: "first" })]],
    prompts: (poll) => (poll >= 2 ? { active: null, queued: [{ prompt_id: "msg_c", status: "blocked" }] } : { active: null, queued: [] }),
    corrections: [correctionReceipt("msg_c")],
    steers: [envelope(null, { code: 40402, msg: "no active prompt" })],
  }, { correctAt: 1 });
  assert.equal(listed.events.at(-1).reason, "failed");
  assert.match(listed.events.at(-1).error, /kimi prompt msg_c \(correction\) is blocked in the serve's prompts list/);
});

test("kimi-web 提交即失败: 派发回执 status blocked/failed → 首拍前直接以失败收口（不轮询）", async () => {
  for (const status of ["blocked", "failed"]) {
    const { events, polls } = await runScript("session_sub", { script: [[]], submitStatus: status });
    assert.deepEqual(events.map((e) => e.kind), ["done"]);
    assert.equal(events[0].reason, "failed");
    assert.equal(events[0].error, `kimi prompt msg_q1 was ${status} at submission (the serve will not run it)`);
    assert.equal(polls, 0);
  }
  // 我们的 prompt 还在 active/queued 里：最终轮哪怕已 ended 也不收口。
  const { events, polls } = await runScript("session_listed", {
    script: [[kimiTurn({ answer: "done" })]],
    prompts: (poll) => (poll <= 2 ? { active: "msg_q1", queued: [] } : { active: null, queued: [] }),
  });
  assert.equal(polls, 3);
  assert.equal(events.at(-1).reason, "completed");
});

test("kimi-web 翻页: 最新页 has_more:true → before_ordinal 往回翻到提交前边界；按 turn_id 去重；派发在第二页也能归属，用量两轮求和", async () => {
  const run = createRunPrompts({ promptId: "msg_d", boundaryOrdinal: 5 });
  run.prompts.set("msg_c", { kind: "correction", submittedAt: Date.now(), steeredAt: Date.now(), waitPolls: 0, notExecuted: false });
  const dispatchTurn = kimiTurn({ turn_id: "t6", ordinal: 6, promptIds: ["msg_d"], prompt: "dispatch", answer: null });
  const other = kimiTurn({ turn_id: "t7", ordinal: 7, promptIds: ["msg_x"], answer: "other" });
  const correctionTurn = kimiTurn({ turn_id: "t9", ordinal: 9, promptIds: ["msg_c"], prompt: "fix", answer: "final" });
  const pages = {
    "": turnsEnvelope([kimiTurn({ turn_id: "t8", ordinal: 8, promptIds: ["msg_y"] }), correctionTurn], { hasMore: true }),
    "?before_ordinal=8": turnsEnvelope([dispatchTurn, other], { hasMore: true }),
    "?before_ordinal=6": turnsEnvelope([kimiTurn({ turn_id: "t4", ordinal: 4, promptIds: ["msg_old"] }), kimiTurn({ turn_id: "t5", ordinal: 5, promptIds: ["msg_old2"] })], { hasMore: true }),
  };
  const { calls, fetchImpl } = kimiServer((url) => {
    if (url.endsWith("/prompts")) return promptsEnvelope();
    const turns = url.indexOf("/agents/main/turns");
    if (turns >= 0) return pages[url.slice(turns + "/agents/main/turns".length)];
    throw new Error(`unexpected ${url}`);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents(makeAgent(), "ses_pages", { interval: 5, runPrompts: run })) events.push(ev);
  assert.deepEqual(calls.filter((c) => c.url.includes("/turns")).map((c) => c.url.split("/turns")[1]), ["", "?before_ordinal=8", "?before_ordinal=6"],
    "翻到本页最早的轮 ordinal ≤ 边界为止");
  assert.equal(events.at(-1).reason, "completed");
  assert.deepEqual(events.filter((e) => e.kind === "message").map((e) => e.parts[0].text), ["dispatch", "final"]);
  assert.deepEqual(events.find((e) => e.kind === "metrics").tokens, { input: 200, output: 14, cacheRead: 20, cacheWrite: 6 });
});

test("kimi-web 翻页: 翻不到边界（has_more:true 却给空页 / 往回翻没有前进 / 某页读失败）→ 本拍按观测失败收口，绝不用不完整的轮收口或发 metrics", async () => {
  const legs = [
    { "": turnsEnvelope([kimiTurn({ turn_id: "t9", ordinal: 9 })], { hasMore: true }), "?before_ordinal=9": turnsEnvelope([], { hasMore: true }) },
    { "": turnsEnvelope([kimiTurn({ turn_id: "t9", ordinal: 9 })], { hasMore: true }), "?before_ordinal=9": turnsEnvelope([kimiTurn({ turn_id: "t9b", ordinal: 9 })], { hasMore: true }) },
    { "": turnsEnvelope([kimiTurn({ turn_id: "t9", ordinal: 9 })], { hasMore: true }), "?before_ordinal=9": jsonResponse({ code: 0, msg: "down", data: null }, 500) },
  ];
  for (const pages of legs) {
    const { fetchImpl } = kimiServer((url) => {
      if (url.endsWith("/prompts")) return promptsEnvelope();
      const turns = url.indexOf("/agents/main/turns");
      if (turns >= 0) return pages[url.slice(turns + "/agents/main/turns".length)];
      throw new Error(`unexpected ${url}`);
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const events = [];
    for await (const ev of backend.streamEvents(makeAgent(), "ses_partial", { interval: 5, runPrompts: bareRun("msg_q1", 2) })) events.push(ev);
    assert.deepEqual(events.map((e) => e.kind), ["done"]);
    assert.equal(events[0].reason, "failed");
    assert.match(events[0].error, /paging incomplete|request failed 500/);
  }
});

test("kimi-web 停滞: 最终轮换了（纠偏开了新一轮）算一次进展，产出量最高水位与证词累计按新轮重建", async () => {
  // 假钟每拍 +310s、serve 恒报 active：轮 A（产出量大）冻结 5 次证词（1550s）后，纠偏的
  // 轮 B（产出量小于 A 的最高水位）接手、再冻结 5 次证词。不按新轮重建的话，B 的产出
  // 永远不超过 A 的水位，累计在 B 的第一次证词就过 30min。
  const run = createRunPrompts({ promptId: "msg_q1" });
  run.prompts.set("msg_c", { kind: "correction", submittedAt: Date.now(), steeredAt: Date.now(), waitPolls: 0, notExecuted: false });
  const turnA = kimiTurn({ turn_id: "tA", ordinal: 0, items: [userMessageItem(), assistantItem("a".repeat(500))] });
  const turnB = runningTurn({ turn_id: "tB", ordinal: 1, promptIds: ["msg_c"], prompt: "c" });
  const script = [
    ...Array(6).fill([turnA]),
    ...Array(6).fill([turnA, turnB]),
    [turnA, kimiTurn({ turn_id: "tB", ordinal: 1, promptIds: ["msg_c"], prompt: "c", answer: "b-done" })],
  ];
  let tick = 0;
  let fakeNow = 0;
  let detailCalls = 0;
  const { fetchImpl } = kimiServer((url) => {
    if (url.endsWith("/prompts")) { tick += 1; fakeNow += 310_000; return promptsEnvelope(); }
    if (url.endsWith("/agents/main/turns")) return turnsEnvelope(script[Math.min(tick, script.length) - 1]);
    if (url.endsWith("/ses_switch")) { detailCalls += 1; return detailEnvelope("ses_switch", true, true, null); }
    throw new Error(`unexpected ${url}`);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents(makeAgent(), "ses_switch", { interval: 1, runPrompts: run, stallClock: () => fakeNow })) events.push(ev);
  assert.equal(events.at(-1).reason, "completed", "两段各 1550s < 30min，合计超出也不收口");
  assert.equal(events.find((e) => e.role === "assistant").parts[0].text, "b-done");
  assert.ok(detailCalls >= 10, `两段都吃到证词续命（实际 ${detailCalls}）`);
});


// ===== ⑥ abort：中止排队与活动的 prompt，并有界复查（2.4.0 / 2.6） =====


test("kimi-web ⑥: abort——GET prompts 取 active 的 prompt id → POST …/prompts/{promptId}:abort（body {}）→ 稍等后复查 prompts 与会话详情；绝不调 /api/v1/shutdown", async () => {
  const { calls, fetchImpl } = abortServer({
    promptsData: { active: { prompt_id: "msg_q1", status: "running" }, queued: [] },
    onAbort: () => envelope({ aborted: true, at_seq: 12 }),
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0, abortSettleMs: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  const before = calls.length;
  await handle.abort();
  const abortCalls = calls.slice(before);
  assert.deepEqual(abortCalls.map((c) => [c.method, c.url]), [
    ["GET", PROMPTS_URL],
    ["POST", `${PROMPTS_URL}/msg_q1:abort`],
    ["GET", PROMPTS_URL],
    ["GET", SESSION_URL],
  ]);
  assert.deepEqual(JSON.parse(abortCalls[1].body), {});
  for (const call of abortCalls) assert.equal(call.headers.authorization, `Bearer ${TOKEN_VALUE}`);
  assert.ok(!calls.some((c) => c.url.includes("/api/v1/shutdown")), "绝不请求服务器级 shutdown（共享服务器会误杀无关会话）");
});

test("kimi-web ⑥: 中止后的窗口——已转入、还没开轮的纠偏在中止后自己开了一轮 → 复查看到新的活动 prompt，再中止一次", async () => {
  // 2.6：中止活动轮不清已转入的纠偏；它在中止后成为新的活动轮。
  const listings = [
    { active: { prompt_id: "msg_q1" }, queued: [] },
    { active: { prompt_id: "msg_steered" }, queued: [] }, // 第一次复查：纠偏自己开了一轮
    { active: null, queued: [] },
  ];
  let reads = 0;
  const { calls, fetchImpl } = abortServer({
    onList: () => envelope(listings[Math.min(reads++, listings.length - 1)]),
    detail: () => detailEnvelope("session_new", false, reads >= 1 && reads < 3, null),
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0, abortSettleMs: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  const before = calls.length;
  await handle.abort();
  assert.deepEqual(calls.slice(before).filter((c) => c.method === "POST").map((c) => c.url), [
    `${PROMPTS_URL}/msg_q1:abort`,
    `${PROMPTS_URL}/msg_steered:abort`,
  ]);
  // 列表空了但会话详情仍说 main_turn_active:true（又一轮正在起来）→ 同样再查；有界：
  // 最多 3 轮，仍停不下按 abort 失败。
  let armed = false; // spawn 的静默门要求 idle；之后才一直报在跑
  const stubborn = abortServer({
    promptsData: { active: null, queued: [] },
    detail: () => detailEnvelope("session_new", armed, armed, null),
  });
  const stubbornBackend = new KimiWebBackend({ fetchImpl: stubborn.fetchImpl, timeout: 5000, retries: 0, abortSettleMs: 0 });
  const stubbornHandle = await stubbornBackend.spawn(makeAgent(), { prompt: "hi" });
  armed = true;
  const mark = stubborn.calls.length;
  await assert.rejects(() => stubbornHandle.abort(), /^Error: kimi-web abort failed: .*after 3 abort rounds/);
  const reread = stubborn.calls.slice(mark).filter((c) => c.method === "GET" && c.url === PROMPTS_URL).length;
  assert.equal(reread, 4, "首读 + 3 轮复查");
});

test("kimi-web ⑥: abort——没有活动 prompt（active:null）且会话不在跑：不发 :abort、复查后视为已停", async () => {
  const { calls, fetchImpl } = abortServer({
    promptsData: { active: null, queued: [] },
    onAbort: () => { throw new Error("abort must not be posted without an active prompt"); },
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0, abortSettleMs: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  await handle.abort();
  assert.ok(!calls.some((c) => c.url.endsWith(":abort")));
});

test("kimi-web ⑥: abort 失败腿——上游拒绝 / HTTP 错 / aborted 非 true 且复查仍在跑 / 列表读被拒 / 列表畸形（缺 active、条目缺 prompt_id、旧的 id/promptId/裸字符串形状）/ 传输失败 → 固定文案，不含上游原文、token 或 URL", async () => {
  const echo = `token ${TOKEN_VALUE} at http://127.0.0.1:4310/secret upstream-detail`;
  const live = { active: { prompt_id: "msg_q1" }, queued: [] };
  const legs = [
    { name: "code!==0", promptsData: live, afterAbort: live, onAbort: () => envelope(null, { code: 40001, msg: echo }) },
    { name: "HTTP 500", promptsData: live, afterAbort: live, onAbort: () => jsonResponse({ code: 0, msg: echo }, 500) },
    { name: "aborted:false", promptsData: live, afterAbort: live, onAbort: () => envelope({ aborted: false }) },
    { name: "list rejected", onList: () => envelope(null, { code: 40001, msg: echo }) },
    { name: "list malformed", promptsData: { queued: [] } },
    { name: "active without id", promptsData: { active: { status: "running" }, queued: [] } },
    { name: "legacy id key", promptsData: { active: { id: "msg_a" }, queued: [] } },
    { name: "legacy promptId key", promptsData: { active: { promptId: "msg_a" }, queued: [] } },
    { name: "bare string", promptsData: { active: "msg_a", queued: [] } },
    { name: "queued not array", promptsData: { active: null, queued: "msg_q2" } },
    { name: "queued without id", promptsData: { active: null, queued: [{ status: "queued" }] } },
    { name: "transport", promptsData: live, afterAbort: live, onAbort: () => { throw new TypeError(`fetch failed ${echo}`); } },
  ];
  for (const leg of legs) {
    const { fetchImpl } = abortServer(leg);
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0, abortSettleMs: 0 });
    const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
    await assert.rejects(() => handle.abort(), (error) => {
      assert.match(error.message, /^kimi-web abort failed: /, leg.name);
      assert.ok(!error.message.includes(TOKEN_VALUE), `${leg.name}: 不含 token`);
      assert.ok(!error.message.includes("upstream-detail"), `${leg.name}: 不回显上游原文`);
      assert.ok(!error.message.includes("127.0.0.1"), `${leg.name}: 不含 URL`);
      assert.equal(error.cause, undefined, `${leg.name}: 不挂原错误`);
      return true;
    });
  }
});

test("kimi-web ⑥: abort 竞态——:abort 未获确认（实测 40402 / aborted:false）时以复查为准：已无活动 prompt → 已停；会话已不存在（40401）→ 已停；复查畸形或被拒 → 固定文案", async () => {
  for (const onAbort of [() => envelope(null, { code: 40402, msg: "prompt msg_q1 not found" }), () => envelope({ aborted: false })]) {
    const { calls, fetchImpl } = abortServer({ promptsData: { active: { prompt_id: "msg_q1" }, queued: [] }, onAbort });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0, abortSettleMs: 0 });
    const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
    const before = calls.length;
    await handle.abort();
    assert.deepEqual(calls.slice(before).map((c) => [c.method, c.url]), [
      ["GET", PROMPTS_URL],
      ["POST", `${PROMPTS_URL}/msg_q1:abort`],
      ["GET", PROMPTS_URL],
      ["GET", SESSION_URL],
    ]);
  }
  {
    const { fetchImpl } = abortServer({
      promptsData: { active: { prompt_id: "msg_q1" }, queued: [] },
      afterAbort: null,
      onList: (abortPosts) => (abortPosts > 0
        ? envelope(null, { code: 40401, msg: "session does not exist" })
        : envelope({ active: { prompt_id: "msg_q1" }, queued: [] })),
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0, abortSettleMs: 0 });
    const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
    await handle.abort();
  }
  for (const relist of [() => envelope({ queued: [] }), () => envelope(null, { code: 40001, msg: "nope" })]) {
    const { fetchImpl } = abortServer({
      onList: (abortPosts) => (abortPosts > 0 ? relist() : envelope({ active: { prompt_id: "msg_q1" }, queued: [] })),
      onAbort: () => envelope(null, { code: 40402, msg: "no active prompt" }),
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0, abortSettleMs: 0 });
    const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
    await assert.rejects(() => handle.abort(), /^Error: kimi-web abort failed: /);
  }
});

test("kimi-web ⑥: abort 先逐条中止排队的 prompt、再中止活动的——只停活动的，排队那条会接着跑（2.4.0 实测）", async () => {
  const { calls, fetchImpl } = abortServer({
    promptsData: { active: { prompt_id: "msg_live" }, queued: [{ prompt_id: "msg_q2" }, { prompt_id: "msg_q3" }] },
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0, abortSettleMs: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  const before = calls.length;
  await handle.abort();
  assert.deepEqual(calls.slice(before).map((c) => [c.method, c.url]), [
    ["GET", PROMPTS_URL],
    ["POST", `${PROMPTS_URL}/msg_q2:abort`],
    ["POST", `${PROMPTS_URL}/msg_q3:abort`],
    ["POST", `${PROMPTS_URL}/msg_live:abort`],
    ["GET", PROMPTS_URL],
    ["GET", SESSION_URL],
  ]);
});

test("kimi-web ⑥: abort——没有活动轮、只有排队的也逐条中止", async () => {
  const { calls, fetchImpl } = abortServer({ promptsData: { active: null, queued: [{ prompt_id: "msg_q2" }] } });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0, abortSettleMs: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  const before = calls.length;
  await handle.abort();
  assert.deepEqual(calls.slice(before).map((c) => [c.method, c.url]), [
    ["GET", PROMPTS_URL],
    ["POST", `${PROMPTS_URL}/msg_q2:abort`],
    ["GET", PROMPTS_URL],
    ["GET", SESSION_URL],
  ]);
});

test("kimi-web ⑥: abort 超时 → 固定文案（不含 token）", async () => {
  const { fetchImpl: base } = abortServer({ promptsData: { active: { prompt_id: "msg_q1" }, queued: [] } });
  let hang = false;
  const fetchImpl = (url, init = {}) => {
    if (hang && url.endsWith(":abort")) {
      return new Promise((_, reject) => {
        const abortError = new Error(`This operation was aborted ${TOKEN_VALUE}`);
        abortError.name = "AbortError";
        init.signal?.addEventListener("abort", () => reject(abortError));
      });
    }
    return base(url, init);
  };
  const backend = new KimiWebBackend({ fetchImpl, timeout: 50, retries: 0, abortSettleMs: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  hang = true;
  await assert.rejects(() => handle.abort(), (error) => {
    assert.match(error.message, /^kimi-web abort failed: /);
    assert.ok(!error.message.includes(TOKEN_VALUE));
    return true;
  });
});

test("kimi-web ⑥: abort 幂等——二次调用复用首次结果（成功不重发请求；失败原样重放同一拒绝）", async () => {
  {
    const { calls, fetchImpl } = abortServer({ promptsData: { active: { prompt_id: "msg_q1" }, queued: [] } });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0, abortSettleMs: 0 });
    const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
    const before = calls.length;
    await Promise.all([handle.abort(), handle.abort()]);
    await handle.abort();
    assert.equal(calls.length - before, 4, "GET prompts + :abort + 复查 prompts 与详情各一次");
  }
  {
    const live = { active: { prompt_id: "msg_q1" }, queued: [] };
    const { calls, fetchImpl } = abortServer({ promptsData: live, afterAbort: live, onAbort: () => envelope(null, { code: 40001, msg: "nope" }) });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0, abortSettleMs: 0 });
    const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
    const before = calls.length;
    const first = await handle.abort().catch((e) => e);
    const second = await handle.abort().catch((e) => e);
    assert.ok(first instanceof Error);
    assert.equal(second, first, "同一拒绝原样重放");
    assert.equal(calls.length - before, 10, "首读 + 3 轮（:abort + 复查 prompts + 详情）；失败也不重发");
  }
});

test("kimi-web ⑥: 中止前会话忙、中止后不忙——sessionStatus busy 投影观察到停下", async () => {
  let submitted = false;
  let aborted = false;
  const { fetchImpl } = kimiServer((url, init) => {
    if (url === "http://127.0.0.1:4310/api/v1/sessions") return envelope({ id: "session_new" });
    if (url === SESSION_URL) {
      const busy = submitted && !aborted;
      return detailEnvelope("session_new", busy, busy, null);
    }
    if (url.endsWith("/agents/main/turns")) return turnsEnvelope([]);
    if (url === PROMPTS_URL && init.method === "POST") {
      submitted = true;
      return envelope({ prompt_id: "msg_q1", status: "running" });
    }
    if (url === PROMPTS_URL) return promptsEnvelope(aborted ? null : "msg_q1");
    if (url.endsWith(":abort")) { aborted = true; return envelope({ aborted: true }); }
    throw new Error(`unexpected ${url}`);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0, abortSettleMs: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  const probe = () => handle.sessionStatus(handle.serveUrl, handle.backendSessionId, { cwd: handle.cwd });
  assert.deepEqual(await probe(), { type: "busy" });
  await handle.abort();
  assert.deepEqual(await probe(), { type: "idle" });
});

test("kimi-web ⑥: stopTarget(agent, sessionId)——不经 spawn 的停止面（wao stop 用）：abort 走 GET prompts → :abort → 复查，带 agent 的 Bearer、幂等；探针读会话详情与 turns 消息页", async () => {
  let aborted = false;
  const { calls, fetchImpl } = kimiServer((url) => {
    if (url.includes("/api/v1/shutdown")) throw new Error("server-level shutdown must never be called");
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_old") {
      return detailEnvelope("session_old", !aborted, !aborted, aborted ? "cancelled" : null);
    }
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_old/messages") {
      throw new Error("the removed /messages endpoint must never be requested");
    }
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_old/agents/main/turns?page_size=200") {
      return turnsEnvelope([runningTurn({ items: [userMessageItem(["msg_live"], "hi"), assistantItem("m1")] })]);
    }
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_old/prompts") return promptsEnvelope(aborted ? null : "msg_live");
    if (url.endsWith("/prompts/msg_live:abort")) { aborted = true; return envelope({ aborted: true }); }
    throw new Error(`unexpected ${url}`);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0, abortSettleMs: 0 });
  const target = backend.stopTarget(makeAgent({ serveUrl: "http://127.0.0.1:4310/" }), "session_old");
  assert.deepEqual(Object.keys(target).sort(), ["abort", "messages", "session", "sessionStatus"]);
  assert.deepEqual(await target.sessionStatus("ignored", "ignored", {}), { type: "busy" });
  await Promise.all([target.abort("ignored", "ignored"), target.abort()]);
  await target.abort();
  const abortCalls = calls.filter((c) => c.url.includes("/prompts"));
  assert.deepEqual(abortCalls.map((c) => [c.method, c.url]), [
    ["GET", "http://127.0.0.1:4310/api/v1/sessions/session_old/prompts"],
    ["POST", "http://127.0.0.1:4310/api/v1/sessions/session_old/prompts/msg_live:abort"],
    ["GET", "http://127.0.0.1:4310/api/v1/sessions/session_old/prompts"],
  ], "同一目标恰一次中止（一次 :abort + 一次复查）");
  for (const call of calls) assert.equal(call.headers.authorization, `Bearer ${TOKEN_VALUE}`);
  assert.deepEqual(await target.sessionStatus(), { type: "idle" });
  assert.equal((await target.session()).busy, false);
  const page = await target.messages();
  assert.ok(Array.isArray(page.data));
  assert.equal(page.data.length, 2, "消息页 = turns 最新一页各轮 items 之和");
  assert.ok(!calls.some((c) => c.url.includes("/messages")), "绝不请求已删除的 /messages（2.7.2 回 404）");
});

test("kimi-web ⑥: 停止面的状态读不到时抛错——状态读 HTTP 500、同轮详情读 busy、消息不增长：verifyStopQuiet 记不可观察，绝不判 quiet", async () => {
  let detailReads = 0;
  const { fetchImpl } = kimiServer((url) => {
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_flaky") {
      detailReads += 1;
      // 每轮先读状态（失败），再读详情（仍忙）。
      return detailReads % 2 === 1
        ? jsonResponse({ code: 0, msg: "down", data: null }, 500)
        : detailEnvelope("session_flaky", true, true, null);
    }
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_flaky/agents/main/turns?page_size=200") {
      return turnsEnvelope([]);
    }
    throw new Error(`unexpected ${url}`);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const target = backend.stopTarget(makeAgent(), "session_flaky");
  await assert.rejects(() => target.sessionStatus(), /kimi-web session status unavailable/);
  detailReads = 0;
  const result = await verifyStopQuiet(target, "http://127.0.0.1:4310", "session_flaky", { rounds: 3, intervalMs: 1 });
  assert.deepEqual(result, { quiet: null, observation: "unavailable" }, "不可观察 ≠ 已停止");
});

test("kimi-web ⑥: factory.serverStopTargetFor——按会话记录的 backend 选服务端中止；kimi-web 须 registry agent 同后端同 serveUrl，否则固定文案、零请求", async () => {
  const { serverStopTargetFor, serverStopBackendOf, SERVER_STOP_ROUTE_TEXT } = await import("../../src/backends/factory.js");
  const { calls, fetchImpl } = kimiServer(() => { throw new Error("resolution must not send requests"); });
  const session = { backend: "kimi-web", serveUrl: "http://127.0.0.1:4310", backendSessionId: "session_old" };

  // 会话记录没有 backend 字段时不按任何后端路由——不发请求、
  // 抛 unresolved；backend 字段如实记 null（不猜）。
  let loads = 0;
  const loadAgent = async () => { loads += 1; return makeAgent(); };
  await assert.rejects(
    () => serverStopTargetFor({ serveUrl: "http://127.0.0.1:1" }, { fetchImpl, loadAgent }),
    (error) => error.message === SERVER_STOP_ROUTE_TEXT.unresolved,
  );
  assert.equal(serverStopBackendOf({ serveUrl: "http://127.0.0.1:1" }), null, "无 backend 如实记 null（不猜）");
  assert.equal(loads, 0, "无 backend 不取 registry agent");

  // kimi-web 匹配（serveUrl 尾斜杠不计）→ 停止面。
  const target = await serverStopTargetFor(session, { fetchImpl, loadAgent: async () => makeAgent({ serveUrl: "http://127.0.0.1:4310/" }) });
  assert.deepEqual(Object.keys(target).sort(), ["abort", "messages", "session", "sessionStatus"]);

  const legs = [
    ["no loadAgent", undefined, SERVER_STOP_ROUTE_TEXT.agentUnavailable],
    ["agent null", async () => null, SERVER_STOP_ROUTE_TEXT.agentUnavailable],
    ["registry throws", async () => { throw new Error(`registry at D:/secret/agents.json ${TOKEN_VALUE}`); }, SERVER_STOP_ROUTE_TEXT.agentUnavailable],
    ["backend differs", async () => makeAgent({ backend: "codex" }), SERVER_STOP_ROUTE_TEXT.agentMismatch],
    ["serveUrl differs", async () => makeAgent({ serveUrl: "http://127.0.0.1:4999" }), SERVER_STOP_ROUTE_TEXT.agentMismatch],
  ];
  for (const [name, load, text] of legs) {
    await assert.rejects(() => serverStopTargetFor(session, { fetchImpl, loadAgent: load }), (error) => {
      assert.equal(error.message, text, name);
      assert.ok(!error.message.includes(TOKEN_VALUE) && !error.message.includes("127.0.0.1") && !error.message.includes("secret"), name);
      return true;
    });
  }
  await assert.rejects(
    () => serverStopTargetFor({ backend: "zcode", serveUrl: "http://127.0.0.1:1" }, { fetchImpl, loadAgent }),
    (error) => error.message === SERVER_STOP_ROUTE_TEXT.unsupported,
  );
  assert.equal(calls.length, 0, "解析阶段零请求");
});

test("kimi-web ②: --reasoning 覆盖经 RunManager 合成进 agent.reasoning → POST prompts 带 thinking；不支持的覆盖在首个请求前拒绝", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { RunManager } = await import("../../src/runManager.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-kimiweb-reasoning-"));
  try {
    // 提交后 turns 即给出本运行 ended 的轮，run 自然收口（不留后台轮询）。
    let submitted = false;
    const { calls, fetchImpl } = kimiServer((url, init) => {
      if (url.endsWith("/agents/main/turns")) return turnsEnvelope(submitted ? [kimiTurn()] : []);
      if (url === PROMPTS_URL && init.method === "POST") submitted = true;
      else if (url === PROMPTS_URL) return promptsEnvelope();
      if (url.endsWith(":delete")) return envelope({ deleted: true });
      return spawnOkRoutes()(url);
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const manager = new RunManager({
      config: { registry: "x", runDir: dir, pollInterval: 5, waitTimeout: 2000, timeout: 5000, retries: 0, defaultIsolation: "none" },
      readRegistry: async () => ({
        getAgent(id) { return makeAgent({ id, cwd: dir }); },
        listAgents() { return []; },
      }),
      transcriptDir: dir,
      backendFor: () => backend,
      userEnvReader: async () => ({}),
    });
    const run = await manager.start("coder_kimiweb", { prompt: "x", runId: "run_kimiweb_reasoning1", reasoningOverride: "high" });
    const prompt = calls.find((c) => c.method === "POST" && c.url === PROMPTS_URL);
    assert.equal(JSON.parse(prompt.body).thinking, "high");
    const result = await run.waitForCompletion({});
    assert.equal(result.state ?? run.state, "completed");

    const before = calls.length;
    await assert.rejects(
      () => manager.start("coder_kimiweb", { prompt: "x", runId: "run_kimiweb_reasoning2", reasoningOverride: "medium" }),
      /supports reasoning\.effort low, high or max only/,
    );
    assert.equal(calls.length, before, "被拒的覆盖零请求");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kimi-web ⑥: handle 探针按 runManager/serveStopVerify 真实调用形状 (serveUrl, sessionId, {cwd}) 可观察 busy——sessionStatus busy 投影 + session detail + turns 消息页形状；serveUrl 形参可忽略", async () => {
  // F3 静默门后夹具分相：spawn 期（静默门 + turns 读）idle 放行；探针期翻
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
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_p/agents/main/turns") {
      return turnsEnvelope([]);
    }
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_p/agents/main/turns?page_size=200") {
      return turnsEnvelope([{
        turn_id: "t_p", ordinal: 0,
        items: [{ type: "user_message", prompt_ids: ["msg_q1"], placement: "opener", text: "hi" }],
      }]);
    }
    if (url.endsWith("/api/v1/sessions/session_p/messages")) {
      throw new Error("the removed /messages endpoint must never be requested");
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
  // #1：runManager._runCleanup / serveStopVerify.sample 的真实调用形状——传
  // 错误的 serveUrl 也必须工作（形参被忽略，会话身份来自 spawn 闭包）。
  const wrongServeUrl = "http://10.255.255.1:9";
  const status = await handle.sessionStatus(wrongServeUrl, handle.backendSessionId, { cwd: handle.cwd });
  assert.deepEqual(status, { type: "busy" }, "busy 投影为 {type:\"busy\"} 形状");
  const detail = await handle.session(wrongServeUrl, handle.backendSessionId, { cwd: handle.cwd });
  assert.equal(detail.busy, true);
  assert.equal(detail.main_turn_active, true);
  const page = await handle.messages(wrongServeUrl, handle.backendSessionId, { cwd: handle.cwd });
  assert.ok(Array.isArray(page?.data), "messages 返回 {data} 页形状（sample 读 page?.data 计数）");
  assert.equal(page.data.length, 1);
  // 探针是只读 GET（spawn 的建会话 POST + 静默门 detail GET + 提交前 turns
  // GET + 发 prompt POST 之后不再有写请求）。
  assert.equal(calls.length, 7);
  assert.deepEqual(calls.slice(4).map((c) => c.method), ["GET", "GET", "GET"]);
  assert.ok(!calls.some((c) => c.url.endsWith("/messages")), "消息探针读 turns，不碰已删除的 /messages");
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
      if (url === "http://127.0.0.1:4310/api/v1/sessions/session_v/agents/main/turns") {
        return turnsEnvelope([]);
      }
      if (url === "http://127.0.0.1:4310/api/v1/sessions/session_v/agents/main/turns?page_size=200") {
        return turnsEnvelope([]);
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
      if (url === "http://127.0.0.1:4310/api/v1/sessions/session_v2/agents/main/turns") {
        return turnsEnvelope([]);
      }
      if (url === "http://127.0.0.1:4310/api/v1/sessions/session_v2/agents/main/turns?page_size=200") {
        return turnsEnvelope([]);
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
  // 腿 2：code!==0 的 msg 含 token（每拍首个请求是 GET prompts——同一信封形状）。
  {
    const { fetchImpl } = kimiServer((url) => {
      if (url.endsWith("/prompts") || url.endsWith("/agents/main/turns")) {
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
    await backend.turnsPage(makeAgent(), "ses_g", null, 200).catch(() => {});
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

test("kimi-web ⑫ A4 缺数据不虚报：detail 缺 id 或 busy/main_turn_active（spawn 静默门读）→ spawn 拒绝；停止探针的 turns 页缺形状 → turnsPage 抛固定错误；sessionStatus 缺形状/不可得/非布尔 → null", async () => {
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
  // 腿 3：停止探针的 turns 页缺形状 → turnsPage 直接抛固定错误（TD-362 起消息
  // 探针读 turns 最新一页；A4 门守探针路径，绝不回落空页）。
  {
    const { fetchImpl } = kimiServer((url) => {
      if (url.includes("/agents/main/turns")) return envelope({ turns: [] });
      throw new Error(`unexpected ${url}`);
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    await assert.rejects(
      () => backend.turnsPage(makeAgent(), "ses_m3", null, 200),
      (err) => {
        assert.match(err.message, /turns response malformed/);
        assert.match(err.message, /boolean data\.has_more/);
        return true;
      },
    );
    await assert.rejects(
      () => backend.stopTarget(makeAgent(), "ses_m3").messages(),
      /turns response malformed/,
      "停止探针经同一形状门 fail-closed",
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
  // serveStopVerify isKnownStatus(null)===true 事实依据；与腿 4/5 的"不可得 → null"分工不同）。
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
    for await (const ev of backend.streamEvents(makeAgent(), "ses_deep2", { interval: 5, runPrompts: bareRun() })) {
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
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_r15/agents/main/turns") {
      return turnsEnvelope([]);
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
    for await (const ev of backend.streamEvents(makeAgent(), "ses_null19", { interval: 5, runPrompts: bareRun() })) {
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
    for await (const ev of backend.streamEvents(makeAgent(), "ses_undef19", { interval: 5, runPrompts: bareRun() })) {
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
  //（serveStopVerify isKnownStatus(null)===true）→ observed 且非 active → quiet:true ⇒ 不可观察
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
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_f1/agents/main/turns") {
      return turnsEnvelope([]);
    }
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_f1/agents/main/turns?page_size=200") {
      return turnsEnvelope([]);
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

test("kimi-web R9 F1: sessionStatus detail 不可得（HTTP 500）→ 保持 null（停止面再把 null 转成抛错，与非布尔→busy 分工不同）", async () => {
  // F1 只改"detail 在场但值非布尔"的投影；HTTP 500/请求失败腿本方法保持 null——
  // 停止面（stopTarget）把它转成抛错，验证器记 quiet:null/stop_unverified（见 ⑥ 停止面用例）。
  const { fetchImpl } = kimiServer(() => jsonResponse({ code: 0, msg: "down", data: null }, 500));
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  assert.equal(await backend.sessionStatus(makeAgent(), "ses_f1e"), null, "detail 不可得 → null 保持");
});

test("kimi-web R9 F2: 响应体里的诊断文字含 token 值 → 拼装后过 redactToken（failed 的 error、interrupted 的 end_reason、闭集外状态值、prompts 列表的 failed 条目）", async () => {
  const legs = [
    { script: [[kimiTurn({ outcome: "failed", error: { code: 401, message: `upstream auth rejected Bearer ${TOKEN_VALUE}` }, answer: null })]], pattern: /kimi turn failed .*error: 401: upstream auth rejected Bearer <redacted>/ },
    { script: [[kimiTurn({ outcome: "interrupted", end_reason: `cancelled by ${TOKEN_VALUE}`, answer: null })]], pattern: /end_reason: cancelled by <redacted>/ },
    { script: [[kimiTurn({ status: `odd-${TOKEN_VALUE}` })]], pattern: /unsupported turn state: status=odd-<redacted>/ },
  ];
  for (const leg of legs) {
    const { events } = await runScript("session_f2t", { script: leg.script });
    assert.equal(events.at(-1).reason, "failed");
    assert.match(events.at(-1).error, leg.pattern);
    assert.ok(!JSON.stringify(events).includes(TOKEN_VALUE), "事件流全程无 token 值");
  }
  // 回执状态与列表状态本身不会带 token（闭集比对），但 prompt id 来自响应体：一并清洗。
  const tokenId = `msg_${TOKEN_VALUE}`;
  const { events } = await runScript("session_f2p", {
    promptId: tokenId,
    script: [[]],
    prompts: { active: null, queued: [{ prompt_id: tokenId, status: "failed" }] },
  });
  assert.match(events.at(-1).error, /kimi prompt msg_<redacted> \(dispatch\) is failed in the serve's prompts list/);
  assert.ok(!JSON.stringify(events).includes(TOKEN_VALUE));
});

test("kimi-web R9 F3: silentTimeout=60000 在场时提示未入轮只以 silentTimeout 为界——轮第 9 拍才出现 → 正常完成（第 8 拍绝不失败）", async () => {
  const { events, polls } = await runScript("session_f3a", {
    script: [[], [], [], [], [], [], [], [], [kimiTurn({ answer: "late turn" })]],
  }, { silentTimeout: 60_000 });
  assert.equal(events.at(-1).reason, "completed");
  assert.ok(!JSON.stringify(events).includes("turn stalled"));
  assert.ok(!JSON.stringify(events).includes("silent timeout"));
  assert.equal(polls, 9);
});

test("kimi-web R9 F3: silentTimeout 缺席 → 8 拍兜底保留（提示恒不入轮也有界）", async () => {
  const { events, polls } = await runScript("session_f3b", { script: [[]] });
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "failed");
  assert.match(events[0].error, /turn not observed for 8 consecutive polls/);
  assert.match(events[0].error, /silentTimeout absent/);
  assert.equal(polls, 8);
});

test("kimi-web R9 F4: status=\"banana\" + 内容持续增长 → 第 8 拍 failed（增长不清零 unsupported 计数）", async () => {
  const bananaGrowing = (poll) => [kimiTurn({ status: "banana", items: [userMessageItem(), assistantItem("y".repeat(poll))] })];
  const { events, polls } = await runScript("session_f4a", { script: [bananaGrowing] });
  assert.equal(events.length, 1);
  assert.match(events[0].error, /unsupported turn state: status=banana/);
  assert.equal(polls, 8);
});

test("kimi-web R9 F4: status 恢复闭集内即清零 unsupported 计数（banana×2 → running×2 → banana×6 → ended；不清零则第 10 拍已失败）", async () => {
  const banana = [kimiTurn({ status: "banana", answer: null })];
  const running = [runningTurn()];
  const { events, polls } = await runScript("session_f4b", {
    script: [banana, banana, running, running, banana, banana, banana, banana, banana, banana, [kimiTurn({ answer: "recovered twice" })]],
  });
  assert.equal(events.at(-1).reason, "completed");
  assert.ok(!JSON.stringify(events).includes("unsupported turn state"));
  assert.equal(polls, 11);
});



test("kimi-web R9 ⑭: 提交前静默门 busy 持续至上界 → 固定错误 + 零提交（门未过不读 turns、不发 prompt）", async () => {
  let detailCalls = 0;
  const { calls, fetchImpl } = kimiServer((url) => {
    if (url === "http://127.0.0.1:4310/api/v1/sessions") return envelope({ id: "session_busy" });
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_busy") {
      detailCalls += 1;
      return detailEnvelope("session_busy", true, true, "prior turn still running");
    }
    if (url.includes("/agents/main/turns")) throw new Error("turns must not be read while the gate holds");
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
  assert.ok(!calls.some((c) => c.url.includes("/agents/main/turns")), "门未过不读 turns（时序：门在前）");
});

test("kimi-web R9 ⑮: 轮询读返回不可解析 JSON（HTTP 200、body 非法）→ done(failed) 有界收口（非崩溃、非静默等待）", async () => {
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
  for await (const ev of backend.streamEvents(makeAgent(), "ses_r915", { interval: 5, runPrompts: bareRun() })) {
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

test("kimi-web R9 ⑯: 先见 running 后 turns 请求连续失败 → done(failed)（绝不复用旧轮判完成，也不无限等待）", async () => {
  let spawned = false;
  let polls = 0;
  const { fetchImpl } = kimiServer((url, init = {}) => {
    if (url === "http://127.0.0.1:4310/api/v1/sessions") return envelope({ id: "session_r916" });
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_r916") return detailEnvelope("session_r916", false, false, null);
    if (url.endsWith("/session_r916/agents/main/turns")) {
      if (!spawned) return turnsEnvelope([]);
      polls += 1;
      if (polls === 1) return turnsEnvelope([runningTurn()]);
      const error = new TypeError("fetch failed");
      error.cause = new Error("ECONNRESET");
      error.cause.code = "ECONNRESET";
      throw error;
    }
    if (url.endsWith("/session_r916/prompts")) {
      return (init.method ?? "GET") === "GET" ? promptsEnvelope("msg_q1") : envelope({ prompt_id: "msg_q1", status: "running" });
    }
    throw new Error(`unexpected ${url}`);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  spawned = true;
  const events = await collect(handle);
  assert.deepEqual(events.map((e) => e.kind), ["runtime_activity", "done"]);
  assert.equal(events[1].reason, "failed");
  assert.match(events[1].error, /fetch failed/);
  assert.equal(polls, 2);
});

// ===== 注册面（factory / registry 闭集接线） =====

test("kimi-web 注册: factory 构造 + 能力闭集快照 + sessionOutlivesProcess 与设计定案一致", () => {
  const viaFactory = backendFor({ backend: "kimi-web" }, { fetchImpl: async () => envelope({}) });
  assert.ok(viaFactory instanceof KimiWebBackend);
  // sessionOutlivesProcess 不在能力轴闭集（runManager 单独读取），直接对实例断言。
  assert.equal(viaFactory.sessionOutlivesProcess, true);
  assert.deepEqual(backendCapabilitySnapshot({ backend: "kimi-web" }), {
    supportsRoleContract: true,
    supportsSessionReuse: true,
    supportsInFlightCorrection: true,
    replayByRespawn: true,
    // turns 端点的轮级 usage 实测非零（2.6.3）。
    reportsTokenUsage: true,
    reportsCommandExitCode: false,
    enforcesWriteSandbox: false,
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
  // 假钟每拍（一次 GET prompts）+30s：拍 1 基线；拍 2 增长（已恢复静默 30s → 预算
  // max(60s, 3×30s)=90s）；拍 3/4 静默 30/60s（固定 60s 门在拍 4 已杀）；拍 5 静默 90s 收口。
  const growing = (poll) => [runningTurn({ items: [userMessageItem(), assistantItem("x".repeat(poll))] })];
  const stalled = [runningTurn({ items: [userMessageItem(), assistantItem("xx")] })];
  const { handler, markSpawned, polls } = turnScriptServer("session_ad", { script: [growing, growing, stalled] });
  let fakeNow = 0;
  const { fetchImpl } = kimiServer((url, init) => {
    if (isTickRequest(url, init)) fakeNow += 30_000;
    return handler(url, init);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const handle = await backend.spawn(makeAgent(), { prompt: "hi" });
  markSpawned();
  const events = await collect(handle, { pollInterval: 1, stallClock: () => fakeNow });
  const done = events.at(-1);
  assert.equal(done.reason, "failed");
  assert.match(done.error, /max recovered gap this turn 30000ms/);
  assert.equal(polls(), 5, "预算 3×30s=90s：拍 4 的 60s 静默存活（固定门必杀），拍 5 才收口");
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
      // TD-362：2.7.2 实录的 activity:"turn" 详情（投影后 = 双 true，同样算活）。
      if (detailMode === "activity-turn") return replay272("t1-tools-session-running.json");
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
  const frozen = [runningTurn()];
  const script = [...Array(15).fill(frozen), [kimiTurn({ answer: "long-thought-answer" })]];
  const { handler, markSpawned, detailCalls } = attestedScriptServer("session_b5a", { script, detailMode: "active" });
  const events = await runClocked(handler, markSpawned, 10_000);
  assert.equal(events.at(-1).reason, "completed", "活轮绝不因零产出静默被误杀（证词续命）");
  assert.ok(!JSON.stringify(events).includes("turn stalled"));
  assert.ok(detailCalls() >= 1);
  assert.equal(
    events.filter((e) => e.kind === "runtime_activity" && e.status === "serve_active").length,
    detailCalls(),
    "一次证词续命一条 serve_active（决定 0069）",
  );
});

test("kimi-web B5②: 证词活着但自上次产出增长以来被续命静默 ≥30min → 收口 failed（真锁死保护）", async () => {
  const { handler, markSpawned } = attestedScriptServer("session_b5b", { script: [[runningTurn()]], detailMode: "active" });
  const events = await runClocked(handler, markSpawned, 310_000);
  const done = events.at(-1);
  assert.equal(done.reason, "failed");
  assert.match(done.error, /serve-attested silence since the last output growth exceeded the 30min cap/);
  assert.match(done.error, /never lands output/);
});

test("kimi-web B5②c（会审 sol）: 零产出的轮靠条目状态往返改签名 → 不清硬顶，照样在 30min 收口", async () => {
  // 工具调用条目的 status 每三拍在 running / pending 之间往返：签名变（停滞门的进度），
  // 产出量没有超过最高水位——硬顶不清零。
  const snapshot = (status) => [runningTurn({
    items: [userMessageItem(), toolCallItem({ status, outcome: undefined, output: undefined, input: { command: "sleep 600" } })],
  })];
  const script = Array.from({ length: 40 }, (_, i) => snapshot(Math.floor(i / 3) % 2 === 0 ? "running" : "pending"));
  const { handler, markSpawned, detailCalls, polls } = attestedScriptServer("session_b5c2", { script, detailMode: "active" });
  const events = await runClocked(handler, markSpawned, 310_000);
  const done = events.at(-1);
  assert.equal(done.reason, "failed", "签名抖动不能让零产出的轮无限续命");
  assert.match(done.error, /serve-attested silence since the last output growth exceeded the 30min cap/);
  assert.ok(polls() < 40, `在脚本耗尽之前收口（实际第 ${polls()} 拍）`);
  assert.ok(detailCalls() >= 6);
});

test("kimi-web B5②b（决定 0068）: 中途有产出 → 硬顶清零重计；两段静默合计超 30min 也不收口", async () => {
  const frozen = [runningTurn()];
  const frozenAfterProgress = [runningTurn({ items: [userMessageItem(), assistantItem("partial")] })];
  const script = [...Array(5).fill(frozen), ...Array(6).fill(frozenAfterProgress), [kimiTurn({ answer: "final-answer" })]];
  const { handler, markSpawned, detailCalls } = attestedScriptServer("session_b5b2", { script, detailMode: "active" });
  const events = await runClocked(handler, markSpawned, 310_000);
  assert.equal(events.at(-1).reason, "completed", "产出之后硬顶重新起算");
  assert.ok(!JSON.stringify(events).includes("turn stalled"));
  assert.ok(detailCalls() >= 7);
});

test("kimi-web B5③: 预算击发 + 证词请求失败 → 照杀（fail-closed：无证词=无续命）", async () => {
  const { handler, markSpawned } = attestedScriptServer("session_b5c", { script: [[runningTurn()]], detailMode: "throw" });
  const events = await runClocked(handler, markSpawned, 10_000);
  assert.equal(events.at(-1).reason, "failed");
  assert.match(events.at(-1).error, /turn stalled \(no progress\)/);
  assert.match(events.at(-1).error, /attestation: unavailable/);
});

test("kimi-web B5④: 健康长跑（墙钟>30min 持续产出）后的收尾静默段 → 证词续命不收口", async () => {
  const growing = (n) => [runningTurn({ items: [userMessageItem(), assistantItem("x".repeat(n))] })];
  const frozen = [runningTurn({ items: [userMessageItem(), assistantItem("x".repeat(40))] })];
  const script = [
    ...Array.from({ length: 8 }, (_, i) => growing(i + 1)),
    ...Array(7).fill(frozen),
    [kimiTurn({ answer: "long-run-final-answer" })],
  ];
  const { handler, markSpawned, detailCalls } = attestedScriptServer("session_b5d", { script, detailMode: "active" });
  const events = await runClocked(handler, markSpawned, 260_000);
  assert.equal(events.at(-1).reason, "completed");
  assert.ok(!JSON.stringify(events).includes("turn stalled"));
  assert.ok(detailCalls() >= 1);
});
// ===== Owner 2026-10-10 问2：在途进度呈现（kimi 诊断会审 opus/sol 方案） =====
// 声称：归属 turn 的结构增长 → 节流发射 runtime_activity("streaming")；
// 完成路径的正文/证据发射不变；同签名/节流窗内不重复。

test("kimi-web 问2: 最终轮增长 → 在途 runtime_activity(streaming)；完成正文照旧", async () => {
  const growing = (n) => runningTurn({ items: [userMessageItem(), ...Array.from({ length: n }, (_, i) => assistantItem("chunk", i + 1))] });
  const { events } = await runScript("session_prog", { script: [[growing(1)], [growing(2)], [kimiTurn({ answer: "最终答案" })]] });
  const streaming = events.filter((e) => e.kind === "runtime_activity" && e.status === "streaming");
  assert.ok(streaming.length >= 1);
  const finalText = events.find((e) => e.kind === "message" && e.role === "assistant");
  assert.deepEqual(finalText.parts, [{ type: "text", text: "最终答案" }]);
  assert.equal(events.at(-1).reason, "completed");
  assert.ok(events.indexOf(streaming[0]) < events.indexOf(finalText));
});

test("kimi-web 问2: 签名不变/节流窗内不重复发射（静态 running 拍零在途新增）", async () => {
  const { events } = await runScript("session_quiet", { script: [[runningTurn()], [runningTurn()], [kimiTurn({ answer: "ok" })]] });
  assert.equal(events.filter((e) => e.kind === "runtime_activity" && e.status === "streaming").length, 1);
});

// ===== TD-250（决定 0056）：releaseSession——终态上游会话卫生（A1/A1b 的 backend 原语）=====

test("TD-250: releaseSession 全绿腿——detail 双严格 false → POST :delete {} → deleted；删除恰一枪", async () => {
  const urls = [];
  const { fetchImpl } = kimiServer((url) => {
    urls.push(url);
    if (url.endsWith("/api/v1/sessions/session_r1")) {
      return envelope({ id: "session_r1", busy: false, main_turn_active: false });
    }
    if (url.endsWith("/api/v1/sessions/session_r1:delete")) {
      return envelope({ deleted: true });
    }
    throw new Error(`unexpected ${url}`);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const res = await backend.releaseSession(makeAgent(), "session_r1");
  assert.deepEqual(res, { outcome: "deleted" });
  assert.equal(urls.filter((u) => u.endsWith(":delete")).length, 1, "删除恰一枪（POST 非幂等，绝不重试）");
});

test("TD-250: 删前探针 40401（会话不存在，HTTP 200 信封码）→ already_gone，且不 POST :delete", async () => {
  const { calls, fetchImpl } = kimiServer((url) => {
    if (url.endsWith("/api/v1/sessions/session_gone")) {
      return envelope(null, { code: 40401, msg: "session session_gone does not exist" });
    }
    throw new Error(`unexpected ${url}`);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const res = await backend.releaseSession(makeAgent(), "session_gone");
  assert.deepEqual(res, { outcome: "already_gone" });
  assert.equal(calls.filter((c) => c.url.endsWith(":delete")).length, 0, "已亡会话零删除请求");
});

test("TD-250: busy/main_turn_active 任一严格 true → skipped_busy（纠偏不对称的充分拒绝条件）", async () => {
  for (const [busy, main] of [[true, false], [false, true], [true, true]]) {
    const { calls, fetchImpl } = kimiServer((url) => {
      if (url.endsWith("/api/v1/sessions/session_b")) {
        return envelope({ id: "session_b", busy, main_turn_active: main });
      }
      throw new Error(`unexpected ${url}`);
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const res = await backend.releaseSession(makeAgent(), "session_b");
    assert.deepEqual(res, { outcome: "skipped_busy" }, `busy=${busy} main=${main}`);
    assert.equal(calls.filter((c) => c.url.endsWith(":delete")).length, 0);
  }
});

test("TD-250: 字段值非严格布尔（sessionStatus F5/R9 F1 同款保守折叠）→ skipped_busy", async () => {
  const { fetchImpl } = kimiServer((url) => {
    if (url.endsWith("/api/v1/sessions/session_mb")) {
      // busy 缺席 / 非布尔——一律不可证 idle，保守当忙。
      return envelope({ id: "session_mb", busy: "nope", main_turn_active: false });
    }
    throw new Error(`unexpected ${url}`);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  assert.deepEqual(await backend.releaseSession(makeAgent(), "session_mb"), { outcome: "skipped_busy" });
});

test("TD-250: :delete 回 40401 → already_gone；回其他 code → failed/upstream_rejected（带数值 code，无 msg 回显）", async () => {
  const mk = (code) => kimiServer((url) => {
    if (url.endsWith("/api/v1/sessions/session_d")) {
      return envelope({ id: "session_d", busy: false, main_turn_active: false });
    }
    if (url.endsWith("/api/v1/sessions/session_d:delete")) {
      return envelope(null, { code, msg: `SECRET upstream echo ${TOKEN_VALUE}` });
    }
    throw new Error(`unexpected ${url}`);
  });
  let { fetchImpl } = mk(40401);
  let backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  assert.deepEqual(await backend.releaseSession(makeAgent(), "session_d"), { outcome: "already_gone" });
  ({ fetchImpl } = mk(50001));
  backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const res = await backend.releaseSession(makeAgent(), "session_d");
  assert.deepEqual(res, { outcome: "failed", reason: "upstream_rejected", code: 50001 });
  assert.ok(!JSON.stringify(res).includes("SECRET") && !JSON.stringify(res).includes(TOKEN_VALUE),
    "闭集结果绝不回显上游 msg/token");
});

test("TD-250: 传输失败 → failed/http_error；超时 → failed/timeout（有界，不重试不抛错）", async () => {
  const { fetchImpl: errFetch } = kimiServer(() => { throw new Error("fetch failed ECONNRESET"); });
  const errBackend = new KimiWebBackend({ fetchImpl: errFetch, timeout: 5000, retries: 0 });
  assert.deepEqual(await errBackend.releaseSession(makeAgent(), "session_t1"), { outcome: "failed", reason: "http_error" });

  // 挂起 fetch：尊重 abort 信号（真 fetch 形状——假实现必须转发 signal，否则
  // releaseSession 的 AbortController 超时无法打断挂起正文）。
  const hangFetch = (_url, init = {}) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => {
      reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    });
  });
  const hangBackend = new KimiWebBackend({ fetchImpl: hangFetch, timeout: 40, retries: 0 });
  assert.deepEqual(await hangBackend.releaseSession(makeAgent(), "session_t2"), { outcome: "failed", reason: "timeout" });
});

test("TD-250: 参数形状不符（缺 serveUrl / 空 sessionId / token 缺席）→ failed/bad_request，零网络请求", async () => {
  const { calls, fetchImpl } = kimiServer(() => { throw new Error("must not be called"); });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  assert.deepEqual(await backend.releaseSession({ ...makeAgent(), serveUrl: "" }, "session_x"), { outcome: "failed", reason: "bad_request" });
  assert.deepEqual(await backend.releaseSession(makeAgent(), ""), { outcome: "failed", reason: "bad_request" });
  const saved = process.env[TOKEN_ENV];
  delete process.env[TOKEN_ENV];
  try {
    const noTokBackend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    assert.deepEqual(await noTokBackend.releaseSession(makeAgent(), "session_y"), { outcome: "failed", reason: "bad_request" });
  } finally {
    process.env[TOKEN_ENV] = saved;
  }
  assert.equal(calls.length, 0, "形状/凭据缺席=零网络请求");
});

// ===== 决定 0071：工具调用证据在轮询期即落盘 =====


test("kimi-web 0071①: 命令在输入就绪时落、结果在条目 ended 时落、写文件只在带回答完成时落；整轮结束不重复", async () => {
  const readDone = toolCallItem({ item_id: "tc_r", name: "Read", input: { path: "README.md" }, display: { kind: "file_io" }, output: "hello" });
  const bashStart = toolCallItem({ item_id: "tc_b", status: "running", input: undefined, display: undefined, outcome: undefined, output: undefined });
  const bashReady = { ...bashStart, input: { command: "npm test", timeout: 600 } };
  const bashDone = { ...bashReady, status: "ended", outcome: "completed", output: "# pass 3" };
  const writeRunning = toolCallItem({ item_id: "tc_w", name: "Write", status: "running", input: { path: "out.txt", content: "x" }, display: { kind: "file_io", path: "D:/w/out.txt" }, outcome: undefined, output: undefined });
  const writeDone = { ...writeRunning, status: "ended", outcome: "completed", output: "Wrote 1 bytes" };
  const events = await collect0071("session_0071a", [
    running0071([readDone, bashStart]),
    running0071([readDone, bashReady]),
    running0071([readDone, bashReady]),
    running0071([readDone, bashDone, writeRunning]),
    ended0071([readDone, bashDone, writeDone, assistantItem("all done")]),
  ]);
  assert.deepEqual(
    events.map((e) => (e.kind === "tool_result" ? `tool_result:${e.tool}` : e.kind)),
    [
      "tool_use", "tool_result:tc_r", // Read 首见即 ended：投影 + 结果
      "command", // Bash：输入就绪才落（首见没有 input → 不落，也不被错分成 tool_use）
      "tool_result:tc_b",
      "tool_use", // Write：在途只预告路径（决定 0072）
      "file_written", "tool_result:tc_w", // 写文件证据与结果：整轮带回答完成时才落
      "message", "message", "metrics", "done",
    ],
  );
  assert.equal(events.find((e) => e.kind === "command").command, "npm test");
  assert.equal(events.filter((e) => e.kind === "command").length, 1);
  assert.equal(events.find((e) => e.kind === "file_written").path, "D:/w/out.txt");
});

test("kimi-web 0071②: 失败路径不补发——只留在途时已看到的命令；写文件证据仍只在带回答完成时落（N1 不变）", async () => {
  const bashReady = toolCallItem({ item_id: "tc_b", status: "running", input: { command: "npm test" }, outcome: undefined, output: undefined });
  const bashDone = { ...bashReady, status: "ended", outcome: "completed", output: "# fail 1" };
  const writeDone = toolCallItem({ item_id: "tc_w", name: "Write", input: { path: "out.txt", content: "x" }, display: { path: "D:/w/out.txt" }, output: "Wrote 1 bytes" });
  const failed = await collect0071("session_0071b", [
    running0071([bashReady]),
    ended0071([bashDone, writeDone], { outcome: "failed", error: "upstream exploded" }),
  ]);
  assert.deepEqual(failed.map((e) => e.kind), ["command", "done"]);
  assert.equal(failed.at(-1).reason, "failed");
  const emptyAfterWrite = await collect0071("session_0071c", [
    running0071([writeDone, bashReady]),
    ended0071([writeDone, bashDone]),
  ]);
  assert.deepEqual(emptyAfterWrite.map((e) => e.kind), ["tool_use", "command", "done"], "没有回答的 completed 轮：只有在途的预告与命令，不补证据、不落 file_written");
  assert.match(emptyAfterWrite.at(-1).error, /completed without assistant text/);
  const neverSeen = await collect0071("session_0071d", [ended0071([bashDone])]);
  assert.deepEqual(neverSeen.map((e) => e.kind), ["done"]);
});

test("kimi-web 0071③（会审 sol）: 条目身份靠 item_id——插入、重排都不重复不漏；没有 item_id 的条目在途不投影", async () => {
  const bashRunning = toolCallItem({ item_id: "tc_b", status: "running", input: { command: "npm test" }, outcome: undefined, output: undefined });
  const bashDone = { ...bashRunning, status: "ended", outcome: "completed", output: "# pass 3" };
  const readDone = toolCallItem({ item_id: "tc_r", name: "Read", input: { path: "a.txt" }, display: { kind: "file_io" }, output: "A" });
  const writeDone = toolCallItem({ item_id: "tc_w", name: "Write", input: { path: "out.txt", content: "x" }, display: { path: "D:/w/out.txt" }, output: "Wrote 1 bytes" });
  const reordered = await collect0071("session_0071f", [
    running0071([bashRunning, readDone]),
    ended0071([writeDone, readDone, bashDone, assistantItem("all done")]),
  ]);
  assert.deepEqual(
    reordered.map((e) => (e.kind === "tool_result" ? `tool_result:${e.tool}` : e.kind)),
    [
      "command", "tool_use", "tool_result:tc_r",
      "file_written", "tool_result:tc_w", "tool_result:tc_b",
      "message", "message", "metrics", "done",
    ],
  );
  const anonymous = { ...bashRunning, item_id: undefined, input: { command: "ls" } };
  const anonDone = { ...anonymous, status: "ended", outcome: "completed", output: "a.txt" };
  const noId = await collect0071("session_0071g", [
    running0071([anonymous]),
    running0071([readDone, anonymous]),
    ended0071([readDone, anonDone, assistantItem("all done")]),
  ]);
  assert.deepEqual(noId.filter((e) => e.kind === "command").map((e) => e.command), ["ls"], "只在完成拍落一次");
  assert.deepEqual(noId.map((e) => e.kind).slice(0, 4), ["tool_use", "tool_result", "command", "tool_result"]);
});

test("kimi-web 0071④（会审 sol）: 就绪是形状判据——空对象 / 数组 / 空命令不算就绪，条目 ended 时照旧投影", async () => {
  const inFlight = { status: "running", outcome: undefined, output: undefined, display: undefined };
  const notReady = [
    toolCallItem({ ...inFlight, item_id: "tc_1", name: "Read", input: {} }),
    toolCallItem({ ...inFlight, item_id: "tc_2", name: "Grep", input: ["x"] }),
    toolCallItem({ ...inFlight, item_id: "tc_3", name: "Bash", input: { command: "   " } }),
  ];
  const settled = [
    { ...notReady[0], status: "ended", outcome: "completed", input: { path: "README.md" }, output: "hello" },
    { ...notReady[1], status: "ended", outcome: "completed", input: { pattern: "x" }, output: "1 match" },
    { ...notReady[2], status: "ended", outcome: "completed", input: { command: "echo final" }, output: "final" },
  ];
  const events = await collect0071("session_0071h", [
    running0071(notReady),
    running0071(notReady),
    ended0071([...settled, assistantItem("all done")]),
  ]);
  const projections = events.filter((e) => e.kind === "tool_use" || e.kind === "command");
  assert.equal(projections.length, 3);
  assert.deepEqual(projections[0].input, { path: "README.md" });
  assert.deepEqual(projections[1].input, { pattern: "x" });
  assert.equal(projections[2].command, "echo final");
});

// ===== 决定 0072：写文件类的条目在途预告 =====

test("kimi-web 0072: 写文件条目在途只预告路径（一条 tool_use，不带内容；路径取 display.path，没有再取 input.path）；file_written 仍只在带回答完成时落", async () => {
  const writeStart = toolCallItem({ item_id: "tc_w", name: "Write", status: "running", input: undefined, display: undefined, outcome: undefined, output: undefined });
  const writeReady = { ...writeStart, input: { path: "src/out.txt", content: "FILE-BODY-0072" }, display: { kind: "file_io", operation: "write", path: "D:/w/src/out.txt", content: "FILE-BODY-0072" } };
  const writeDone = { ...writeReady, status: "ended", outcome: "completed", output: "Wrote 14 bytes" };
  const completed = await collect0071("session_0072a", [
    running0071([writeStart]),
    running0071([writeReady]),
    running0071([writeReady]),
    running0071([writeDone]),
    ended0071([writeDone, assistantItem("all done")]),
  ]);
  assert.deepEqual(
    completed.map((e) => (e.kind === "tool_result" ? `tool_result:${e.tool}` : e.kind)),
    ["tool_use", "file_written", "tool_result:tc_w", "message", "message", "metrics", "done"],
  );
  const announced = completed.find((e) => e.kind === "tool_use");
  assert.deepEqual(announced, { kind: "tool_use", tool: "Write", input: { path: "D:/w/src/out.txt" } }, "只带路径");
  assert.ok(!JSON.stringify(announced).includes("FILE-BODY-0072"));
  assert.equal(completed.find((e) => e.kind === "file_written").path, "D:/w/src/out.txt");
  // display 缺席：退到 input.path。
  const inputOnly = { ...writeDone, display: { kind: "file_io" } };
  const fallback = await collect0071("session_0072e", [running0071([inputOnly]), ended0071([inputOnly, assistantItem("ok")])]);
  assert.deepEqual(fallback.find((e) => e.kind === "tool_use").input, { path: "src/out.txt" });
  assert.equal(fallback.find((e) => e.kind === "file_written").path, "src/out.txt");
  // 失败的轮：预告留下，写文件证据与结果都不落。
  const failed = await collect0071("session_0072b", [
    running0071([writeDone]),
    ended0071([writeDone], { outcome: "failed", error: "upstream exploded" }),
  ]);
  assert.deepEqual(failed.map((e) => e.kind), ["tool_use", "done"]);
  // 没有 item_id 或没有路径的写文件条目在途不预告。
  const anonymous = { ...writeReady, item_id: undefined, name: "Edit" };
  const noPath = toolCallItem({ item_id: "tc_n", name: "Write", status: "running", input: { content: "x" }, display: { kind: "file_io" }, outcome: undefined, output: undefined });
  const skipped = await collect0071("session_0072c", [
    running0071([anonymous, noPath]),
    ended0071([anonymous, noPath], { outcome: "failed", error: "boom" }),
  ]);
  assert.deepEqual(skipped.map((e) => e.kind), ["done"]);
  const neverSeen = await collect0071("session_0072d", [ended0071([writeDone, assistantItem("all done")])]);
  assert.deepEqual(neverSeen.map((e) => e.kind), ["file_written", "tool_result", "message", "message", "metrics", "done"]);
});

// ===== 决定 0074：车道声明 kimiHome → 服务器 token 取自该主目录的 server.token =====

test("kimi-web 0074: kimiHome 在场时 bearer token 取自 <kimiHome>/server.token，环境变量不读；文件缺失即拒（只点名路径）", async () => {
  const { mkdtempSync, writeFileSync: writeFile, rmSync: rm } = await import("node:fs");
  const { tmpdir: osTmp } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const { kimiServerTokenFile, requiredCredentialNames, inheritedEnvNames } = await import("../../src/envPolicy.js");
  const home = mkdtempSync(joinPath(osTmp(), "wao-kimihome-"));
  const fileToken = ["home", "file", "tok", "0074"].join("-");
  try {
    // 策略面：声明了 kimiHome 的车道，token 不是环境凭据。
    const withHome = makeAgent({ kimiHome: home });
    assert.equal(kimiServerTokenFile(withHome), `${home}${home.includes("\\") && !home.includes("/") ? "\\" : "/"}server.token`);
    assert.deepEqual(requiredCredentialNames(withHome), []);
    assert.deepEqual(inheritedEnvNames(withHome), []);
    assert.deepEqual(requiredCredentialNames(makeAgent()), [TOKEN_ENV], "未声明 kimiHome 的车道照旧");
    assert.equal(kimiServerTokenFile(makeAgent()), null);
    assert.equal(kimiServerTokenFile({ backend: "codex", kimiHome: home }), null, "只对 kimi-web 生效");

    // 文件缺失：固定错误，点名文件路径，不回落到环境变量（那是别的主目录的 token）。
    const { fetchImpl: neverCalled, calls: noCalls } = kimiServer(() => envelope({}));
    const missing = new KimiWebBackend({ fetchImpl: neverCalled, timeout: 5000, retries: 0 });
    await assert.rejects(
      () => missing.spawn(withHome, { prompt: "hi" }),
      (err) => err.message.includes("server token file") && err.message.includes("server.token")
        && err.message.includes("missing or empty") && !err.message.includes(TOKEN_VALUE),
    );
    assert.equal(noCalls.length, 0, "没有 token 就不发请求");

    // 文件在场：请求带的是文件里的 token（去掉首尾空白），不是环境变量的值。
    writeFile(joinPath(home, "server.token"), `${fileToken}\r\n`, "utf8");
    const { handler, markSpawned } = turnScriptServer("session_0074a", {
      script: [[kimiTurn({ answer: "ok" })]],
    });
    const { fetchImpl, calls } = kimiServer(handler);
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const agent = makeAgent({ kimiHome: home });
    const handle = await backend.spawn(agent, { prompt: "hi", resolvedCredentials: { [TOKEN_ENV]: TOKEN_VALUE } });
    markSpawned();
    for await (const ev of handle.events(undefined, { pollInterval: 5 })) void ev;
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.equal(call.headers.authorization, `Bearer ${fileToken}`, "每个请求都用主目录的 token");
    }

    // 会审（sol）：本次运行用的 bearer 进入转录的精确值脱敏——主目录文件里的 token 不在
    // 进程环境里，缺省脱敏器认不出它。
    assert.equal(typeof handle.redact, "function");
    const scrubbed = handle.redact({ kind: "message", role: "assistant", parts: [{ type: "text", text: `the server said ${fileToken} ok` }] });
    assert.ok(!JSON.stringify(scrubbed).includes(fileToken), "成功路径上的 worker 输出里出现该值也会被遮掉");
    assert.ok(JSON.stringify(scrubbed).includes("[REDACTED:"));
    // 没声明 kimiHome 的车道：经桥解析到的环境 token 同样进脱敏。
    const envLane = turnScriptServer("session_0074b", {
      script: [[kimiTurn({ answer: "ok" })]],
    });
    const envServer = kimiServer(envLane.handler);
    const envBackend = new KimiWebBackend({ fetchImpl: envServer.fetchImpl, timeout: 5000, retries: 0 });
    const envHandle = await envBackend.spawn(makeAgent(), { prompt: "hi", resolvedCredentials: { [TOKEN_ENV]: TOKEN_VALUE } });
    envLane.markSpawned();
    for await (const ev of envHandle.events(undefined, { pollInterval: 5 })) void ev;
    assert.ok(!JSON.stringify(envHandle.redact({ text: `echo ${TOKEN_VALUE}` })).includes(TOKEN_VALUE));

    // 形状（会审 sol）：绝对路径、首尾不带空白——registry 与 backend 同一判据。
    for (const bad of [" ", "relative/home", ` ${home}`, `${home} `, 5, ""]) {
      assert.throws(() => backend.validateAgentPolicy(makeAgent({ kimiHome: bad })), /kimiHome must be an absolute path \(no surrounding whitespace\)/, JSON.stringify(bad));
      assert.throws(() => normalizeAgent("kimi", { ...makeAgent(), kimiHome: bad }), /kimiHome must be an absolute path \(no surrounding whitespace\)/, JSON.stringify(bad));
    }
    assert.equal(normalizeAgent("kimi", { ...makeAgent(), kimiHome: home }).kimiHome, home, "归一化保留该字段");
  } finally {
    rm(home, { recursive: true, force: true });
  }
});

// ===== 决定 0075：车道声明 serveWorkspaceDir → 派发前保证 worker serve 在场 =====

test("kimi-web 0075: 没声明 serveWorkspaceDir 不做任何事；声明了 → 派发前调一次在场保证，拉起过就给 Lead 留一条 system 说明；拉不起来派发即失败", async () => {
  const ws = process.platform === "win32" ? "D:\\wao-serve-ws" : "/wao-serve-ws";
  const oneTurn = () => ({
    script: [[kimiTurn({ answer: "ok" })]],
  });
  const runWith = async (sessionId, agentOverrides, ensureResult) => {
    const ensureCalls = [];
    const lane = turnScriptServer(sessionId, oneTurn());
    const { fetchImpl, calls } = kimiServer(lane.handler);
    const backend = new KimiWebBackend({
      fetchImpl, timeout: 5000, retries: 0,
      ensureServeFn: async (args) => {
        ensureCalls.push({ ...args, fetchCallsBefore: calls.length });
        return ensureResult;
      },
    });
    const handle = await backend.spawn(makeAgent(agentOverrides), { prompt: "hi", resolvedCredentials: { [TOKEN_ENV]: TOKEN_VALUE } });
    lane.markSpawned();
    const events = [];
    for await (const ev of handle.events(undefined, { pollInterval: 5 })) events.push(ev);
    return { ensureCalls, events, calls };
  };
  const systemTexts = (events) => events
    .filter((ev) => ev.kind === "message" && ev.role === "system")
    .map((ev) => ev.parts.map((p) => p.text).join(""));
  const port = new URL(makeAgent().serveUrl).port;

  // 没声明：不调在场保证，事件流里没有 system 说明。
  const plain = await runWith("session_0075a", {}, { started: true, pid: 1, waitedMs: 1, answer: "ok" });
  assert.equal(plain.ensureCalls.length, 0);
  assert.deepEqual(systemTexts(plain.events), []);

  // 声明了、serve 本来就在：调一次（在建会话之前），没有说明。
  const present = await runWith("session_0075b", { serveWorkspaceDir: ws }, null);
  assert.equal(present.ensureCalls.length, 1);
  assert.equal(present.ensureCalls[0].serveUrl, makeAgent().serveUrl);
  assert.equal(present.ensureCalls[0].workspaceDir, ws);
  assert.equal(present.ensureCalls[0].kimiHome, null);
  assert.equal(present.ensureCalls[0].token, TOKEN_VALUE, "探测用的是这条车道解析到的 token");
  assert.equal(present.ensureCalls[0].fetchCallsBefore, 0, "在任何会话请求之前");
  assert.equal(typeof present.ensureCalls[0].startWatchFn, "function", "kimi-web 把空闲看护的启动函数交给拉起流程");
  assert.deepEqual(systemTexts(present.events), []);

  // 声明了、本次派发把 serve 拉了起来：events 的第一条是给 Lead 的说明（只写端口，不写 URL 原文）。
  const started = await runWith("session_0075c", { serveWorkspaceDir: ws }, { started: true, pid: 777, waitedMs: 4200, answer: "ok" });
  assert.equal(started.events[0].kind, "message");
  assert.equal(started.events[0].role, "system");
  assert.equal(
    systemTexts(started.events)[0],
    `kimi-web backend: the worker serve on port ${port} was not running; started it (pid 777; the lane declares serveWorkspaceDir); answering after 4 s`,
  );
  assert.equal(systemTexts(started.events).length, 1);
  assert.ok(!JSON.stringify(started.events).includes(TOKEN_VALUE));
  assert.ok(!systemTexts(started.events)[0].includes(makeAgent().serveUrl));

  // 别的进程在拉，本次只等。
  const waited = await runWith("session_0075d", { serveWorkspaceDir: ws }, { started: false, pid: null, waitedMs: 3000, answer: "ok" });
  assert.match(systemTexts(waited.events)[0], /was not running; it was started by another process \(another dispatch or a recycle\); answering after 3 s$/);

  // 端口有应答但不认这条车道的 token：说明如实写，原因由随后的请求报。
  const rejected = await runWith("session_0075f", { serveWorkspaceDir: ws }, { started: true, pid: 9, waitedMs: 6000, answer: "rejected" });
  assert.match(systemTexts(rejected.events)[0], /started it \(pid 9; .*\); after 6 s the port answers but not with success for this lane's token/);

  // 拉不起来：派发在建会话之前失败，错误原样上抛。
  const lane = turnScriptServer("session_0075e", oneTurn());
  const { fetchImpl, calls } = kimiServer(lane.handler);
  const failing = new KimiWebBackend({
    fetchImpl, timeout: 5000, retries: 0,
    ensureServeFn: async () => { throw new Error("kimi-web backend: the worker serve is not running and could not be started (workspace_dir_invalid)"); },
  });
  await assert.rejects(
    () => failing.spawn(makeAgent({ serveWorkspaceDir: ws }), { prompt: "hi", resolvedCredentials: { [TOKEN_ENV]: TOKEN_VALUE } }),
    /could not be started \(workspace_dir_invalid\)/,
  );
  assert.equal(calls.length, 0, "没有 serve 就不发会话请求");

  // 会审（sol）：serve 拉起来了、但随后的建会话失败——说明跟着错误走（events 这时还没有交出去）。
  const afterStart = new KimiWebBackend({
    fetchImpl: async () => { throw new Error("network down"); }, timeout: 5000, retries: 0,
    ensureServeFn: async () => ({ started: true, pid: 778, waitedMs: 2000, answer: "ok" }),
  });
  await assert.rejects(
    () => afterStart.spawn(makeAgent({ serveWorkspaceDir: ws }), { prompt: "hi", resolvedCredentials: { [TOKEN_ENV]: TOKEN_VALUE } }),
    (err) => err.message.includes("network down")
      && err.message.endsWith(`[kimi-web backend: the worker serve on port ${port} was not running; started it (pid 778; the lane declares serveWorkspaceDir); answering after 2 s]`)
      && !err.message.includes(TOKEN_VALUE),
  );

  // 会审（kimi）：畸形的续接轮在建会话之前就会被拒——不为它拉起 serve。
  let resumeEnsureCalls = 0;
  const resumeBackend = new KimiWebBackend({
    fetchImpl, timeout: 5000, retries: 0, ensureServeFn: async () => { resumeEnsureCalls += 1; return null; },
  });
  await assert.rejects(
    () => resumeBackend.spawn(makeAgent({ serveWorkspaceDir: ws }), { prompt: "hi", sessionReuse: { turn: "resume" }, resolvedCredentials: { [TOKEN_ENV]: TOKEN_VALUE } }),
    /requires the prior provider session id/,
  );
  assert.equal(resumeEnsureCalls, 0);

  // 自己拉起的那个落在了别的端口（目标端口期间被占）：说明里写明它的去向。
  const moved = { started: false, pid: null, waitedMs: 5000, answer: "ok", displaced: { pid: 31, port: 59000, shutdown: "requested" } };
  const displaced = await runWith("session_0075g", { serveWorkspaceDir: ws }, moved);
  assert.equal(
    systemTexts(displaced.events)[0],
    `kimi-web backend: the worker serve on port ${port} was not running; a serve this dispatch started (pid 31) landed on port 59000 because port ${port} was taken meanwhile; it was asked to exit; answering after 5 s`,
  );
  const stuck = await runWith("session_0075h", { serveWorkspaceDir: ws }, { ...moved, displaced: { ...moved.displaced, shutdown: "failed" } });
  assert.match(systemTexts(stuck.events)[0], /asking it to exit failed — stop it by hand; answering after 5 s$/);

  // 空闲看护的结果写进说明（决定 0079：WAO 拉起的 serve 空闲自己退出）。
  const watched = await runWith("session_0075i", { serveWorkspaceDir: ws }, { started: true, pid: 781, waitedMs: 800, answer: "ok", idleWatch: { started: true, pid: 555 } });
  assert.equal(
    systemTexts(watched.events)[0],
    `kimi-web backend: the worker serve on port ${port} was not running; started it (pid 781; the lane declares serveWorkspaceDir); an idle watcher (pid 555) will ask it to exit after 30 idle minutes; answering after 1 s`,
  );
  const unwatched = await runWith("session_0075j", { serveWorkspaceDir: ws }, { started: true, pid: 782, waitedMs: 800, answer: "ok", idleWatch: { started: false, reason: "spawn_failed" } });
  assert.match(systemTexts(unwatched.events)[0], /; the idle watcher could not be started — the serve keeps running until stopped by hand; answering after 1 s$/);
  // 等待者/被挤走的说明不带看护句（看护归属拉起者）。
  assert.ok(!systemTexts(waited.events)[0].includes("idle watcher"));
  assert.ok(!systemTexts(displaced.events)[0].includes("idle watcher"));

  // 形状：绝对路径、首尾不带空白——registry 与 backend 同一判据；归一化保留该字段。
  const shapeBackend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  for (const bad of [" ", "relative/ws", ` ${ws}`, `${ws} `, 5, ""]) {
    assert.throws(() => shapeBackend.validateAgentPolicy(makeAgent({ serveWorkspaceDir: bad })), /serveWorkspaceDir must be an absolute path \(no surrounding whitespace\)/, JSON.stringify(bad));
    assert.throws(() => normalizeAgent("kimi", { ...makeAgent(), serveWorkspaceDir: bad }), /serveWorkspaceDir must be an absolute path \(no surrounding whitespace\)/, JSON.stringify(bad));
  }
  assert.equal(normalizeAgent("kimi", { ...makeAgent(), serveWorkspaceDir: ws }).serveWorkspaceDir, ws);
});

// ===== 分步拼接：同一步的文本帧首尾相接，不同步之间隔一个空行 =====

test("kimi-web 分步: 工具调用之间说的话与最后的答案分属不同 step → 答案里行首的 Q1: 仍在行首；同一步的 assistant_message 首尾相接", async () => {
  const turn = kimiTurn({
    items: [
      userMessageItem(),
      assistantItem("Now let me check the files.", 1),
      toolCallItem({ item_id: "tc_ls", step_index: 1 }),
      assistantItem("Q1: FIX_", 2),
      assistantItem("FIRST\n理由。", 2),
    ],
  });
  const { events } = await runScript("session_steps1", { script: [[turn]] });
  const assistant = events.filter((e) => e.kind === "message" && e.role === "assistant");
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].parts[0].text, "Now let me check the files.\n\nQ1: FIX_FIRST\n理由。");
});

// ===== 答案拼接：旧帧流的重复帧去重已删除 =====

test("kimi-web 答案：相邻的同样文本原样保留（旧帧流的去重启发式已删除），没有 system 说明", async () => {
  const dup = "同一段不短的答案文本，逐字相同。".repeat(20);
  const turn = kimiTurn({ items: [userMessageItem(), assistantItem(dup, 1), assistantItem(dup, 1)] });
  const { events } = await runScript("session_dup", { script: [[turn]] });
  assert.equal(events.find((e) => e.kind === "message" && e.role === "assistant").parts[0].text, `${dup}${dup}`);
  assert.ok(!events.some((e) => e.kind === "message" && e.role === "system"));
});

// ===== 会审补测（第 109 批）=====

test("kimi-web 会审①: 纠偏 prompt id 来自响应体——'已转入但没有轮执行它'的失败文案与'未执行'的 system 消息里 token 值都被清洗", async () => {
  const tokenId = `msg_${TOKEN_VALUE}`;
  const script = [[runningTurn()], [kimiTurn({ answer: "first answer" })]];
  const steered = await runCorrected("session_rv1a", {
    script,
    corrections: [correctionReceipt(tokenId)],
    steers: [envelope({ steered: true })],
  });
  assert.equal(steered.events.at(-1).reason, "failed");
  assert.match(steered.events.at(-1).error, /correction prompt msg_<redacted> was steered into the session but no turn ran it/);
  assert.ok(!JSON.stringify(steered.events).includes(TOKEN_VALUE), "失败文案无 token");
  const acceptedOnly = await runCorrected("session_rv1b", {
    script,
    corrections: [correctionReceipt(tokenId)],
    steers: [envelope(null, { code: 40402, msg: "no active prompt to steer into" })],
  });
  const system = acceptedOnly.events.filter((e) => e.kind === "message" && e.role === "system");
  assert.equal(system.length, 1);
  assert.match(system[0].parts[0].text, /correction prompt msg_<redacted> was not executed/);
  assert.ok(!JSON.stringify(acceptedOnly.events).includes(TOKEN_VALUE), "system 消息无 token");
  assert.equal(acceptedOnly.events.at(-1).reason, "completed");
});

test("kimi-web 会审②: firstRequest = 第一个归属轮 index 最小那一步；那一步没有 usage 就不写，不往后找带 usage 的步", async () => {
  const turn = kimiTurn({
    steps: [
      stepItem({ index: 1, outcome: "interrupted", finish_reason: "interrupted", usage: undefined }),
      stepItem({ index: 2, usage: { input_other: 999, output: 1, input_cache_read: 777, input_cache_creation: 0 } }),
    ],
    answer: "ok",
  });
  const { events } = await runScript("session_rv2", { script: [[turn]] });
  assert.deepEqual(events.find((e) => e.kind === "metrics"), {
    kind: "metrics",
    tokens: { input: 999, output: 1, cacheRead: 777, cacheWrite: 0 },
  }, "第 2 步不是第一个请求——不写 firstRequest");
  // steps 乱序给出时按 index 取最小的那一步。
  const reordered = kimiTurn({
    steps: [
      stepItem({ index: 2, usage: { input_other: 5, output: 1, input_cache_read: 6, input_cache_creation: 0 } }),
      stepItem({ index: 1, usage: { input_other: 7, output: 1, input_cache_read: 8, input_cache_creation: 0 } }),
    ],
    answer: "ok",
  });
  const second = await runScript("session_rv2b", { script: [[reordered]] });
  assert.deepEqual(second.events.find((e) => e.kind === "metrics").firstRequest, { input: 7, cacheRead: 8 });
});

test("kimi-web 会审③: 纠偏的计时原点是它自己的提交 / 转入时刻——派发早已超过 silentTimeout 之后才提交的纠偏不会立即到界", async () => {
  // 派发的提交时刻摆在 10 分钟前（silentTimeout 60s 早已过去；派发本身已入轮、已结算）。
  // 纠偏在拍 2 提交：已转入的那条与 steer 失败的那条都在拍 3 才出现在轮里——用派发的
  // 原点计时会在拍 2 就判到界。
  for (const steer of [envelope({ steered: true }), envelope(null, { code: 40402, msg: "no active prompt" })]) {
    const run = createRunPrompts({ promptId: "msg_q1", submittedAt: Date.now() - 600_000 });
    const dispatchTurn = kimiTurn({ turn_id: "t_d", ordinal: 0, answer: "first" });
    const correctionTurn = kimiTurn({ turn_id: "t_c", ordinal: 1, promptIds: ["msg_c"], prompt: "fix", answer: "corrected" });
    const scripts = [[runningTurn({ turn_id: "t_d" })], [dispatchTurn], [dispatchTurn, correctionTurn]];
    let tick = 0;
    const { fetchImpl } = kimiServer((url, init = {}) => {
      const method = init.method ?? "GET";
      if (method === "GET" && url.endsWith("/prompts")) { tick += 1; return promptsEnvelope(); }
      if (url.endsWith("/agents/main/turns")) return turnsEnvelope(scripts[Math.min(tick, scripts.length) - 1]);
      if (method === "POST" && url.endsWith("/prompts")) return correctionReceipt("msg_c");
      if (url.endsWith("/prompts:steer")) return steer;
      throw new Error(`unexpected ${url}`);
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const agent = makeAgent();
    const events = [];
    for await (const ev of backend.streamEvents(agent, "ses_origin", {
      interval: 5,
      silentTimeout: 60_000,
      runPrompts: run,
      onPollTick: async () => { if (tick === 1) await backend.sendCorrection(agent, "ses_origin", "fix", run); },
    })) events.push(ev);
    assert.equal(events.at(-1).reason, "completed", JSON.stringify(events.at(-1)));
    assert.equal(events.find((e) => e.role === "assistant").parts[0].text, "corrected");
    assert.ok(!events.some((e) => e.role === "system"), "没有被判成未执行");
  }
});

test("kimi-web 会审④: 相邻页重复同一 turn_id（before_ordinal 含边界的形状）→ 按 turn_id 去重，只计一轮：usage 与工具证据都不重复", async () => {
  const run = createRunPrompts({ promptId: "msg_d", boundaryOrdinal: 5 });
  run.prompts.set("msg_c", { kind: "correction", submittedAt: Date.now(), steeredAt: Date.now(), waitPolls: 0, notExecuted: false });
  const dispatchTurn = kimiTurn({
    turn_id: "t8", ordinal: 8, promptIds: ["msg_d"], prompt: "dispatch",
    items: [userMessageItem(["msg_d"], "dispatch"), toolCallItem({ item_id: "tc_dup", input: { command: "npm test" }, output: "ok" })],
  });
  const correctionTurn = kimiTurn({ turn_id: "t9", ordinal: 9, promptIds: ["msg_c"], prompt: "fix", answer: "final" });
  const pages = {
    "": turnsEnvelope([dispatchTurn, correctionTurn], { hasMore: true }),
    "?before_ordinal=8": turnsEnvelope([kimiTurn({ turn_id: "t6", ordinal: 6, promptIds: ["msg_x"] }), kimiTurn({ turn_id: "t7", ordinal: 7, promptIds: ["msg_y"] }), dispatchTurn], { hasMore: true }),
    "?before_ordinal=6": turnsEnvelope([kimiTurn({ turn_id: "t5", ordinal: 5, promptIds: ["msg_old"] })], { hasMore: true }),
  };
  const { fetchImpl } = kimiServer((url) => {
    if (url.endsWith("/prompts")) return promptsEnvelope();
    const at = url.indexOf("/agents/main/turns");
    if (at >= 0) return pages[url.slice(at + "/agents/main/turns".length)];
    throw new Error(`unexpected ${url}`);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const events = [];
  for await (const ev of backend.streamEvents(makeAgent(), "ses_dup", { interval: 5, runPrompts: run })) events.push(ev);
  assert.equal(events.at(-1).reason, "completed");
  assert.deepEqual(events.find((e) => e.kind === "metrics").tokens, { input: 200, output: 14, cacheRead: 20, cacheWrite: 6 }, "t8 只计一次");
  assert.equal(events.filter((e) => e.kind === "command").length, 1);
  assert.equal(events.filter((e) => e.kind === "tool_result" && e.tool === "tc_dup").length, 1);
  assert.deepEqual(events.filter((e) => e.kind === "message").map((e) => e.parts[0].text), ["dispatch", "final"]);
});

test("kimi-web 会审⑤: 跨轮工具证据——较早的归属轮有 Bash 与 Write、最终轮才有回答：整次成功时命令、结果与 Write 的 file_written 都在；整次失败时 file_written 不落", async () => {
  const bash = toolCallItem({ item_id: "tc_bash", input: { command: "npm test" }, output: "# pass 1" });
  const write = toolCallItem({
    item_id: "tc_write", step_index: 1, name: "Write", input: { path: "out.txt", content: "x" },
    display: { kind: "file_io", operation: "write", path: "D:/w/out.txt" }, output: "Wrote 1 bytes",
  });
  // 派发那一轮被纠偏打断、无回答结束（2.6.3 的 t3 形状），工作已做了一半。
  const interrupted = kimiTurn({ turn_id: "t_d", ordinal: 0, items: [userMessageItem(), bash, write] });
  const finalTurn = (extra) => kimiTurn({ turn_id: "t_c", ordinal: 1, promptIds: ["msg_c"], prompt: "fix it", ...extra });
  const run = (sessionId, extra) => runCorrected(sessionId, {
    script: [[runningTurn({ turn_id: "t_d" })], [interrupted], [interrupted, finalTurn(extra)]],
    corrections: [correctionReceipt("msg_c")],
    steers: [envelope({ steered: true })],
  });
  const ok = (await run("session_rv5a", { answer: "done after correction" })).events;
  assert.equal(ok.at(-1).reason, "completed");
  assert.deepEqual(ok.filter((e) => e.kind === "command").map((e) => e.command), ["npm test"]);
  assert.deepEqual(ok.filter((e) => e.kind === "tool_result").map((e) => e.tool).sort(), ["tc_bash", "tc_write"]);
  assert.deepEqual(ok.filter((e) => e.kind === "file_written").map((e) => e.path), ["D:/w/out.txt"], "较早那一轮的写文件证据在整次成功后落");
  const failed = (await run("session_rv5b", { answer: null, outcome: "failed", error: "boom" })).events;
  assert.equal(failed.at(-1).reason, "failed");
  assert.deepEqual(failed.filter((e) => e.kind === "command").map((e) => e.command), ["npm test"], "在途已落的命令留下");
  assert.ok(!failed.some((e) => e.kind === "file_written"), "整次失败：file_written 不落");
});

// ===== TD-362（kimi 2.7.2，2026-11-20 实测）：activity 投影贯通各读取点 =====

test("TD-362: 提交前静默门——2.7 activity:idle 放行；turn/background 到界报 session busy at dispatch", async () => {
  const spawnWithDetail = async (fixtureName) => {
    let posted = 0;
    let detailReads = 0;
    const { calls, fetchImpl } = kimiServer((url, init = {}) => {
      const method = init.method ?? "GET";
      if (url === "http://127.0.0.1:4310/api/v1/sessions") return envelope({ id: "session_gate27" });
      if (url === "http://127.0.0.1:4310/api/v1/sessions/session_gate27") {
        detailReads += 1;
        return replay272(fixtureName);
      }
      if (url === "http://127.0.0.1:4310/api/v1/sessions/session_gate27/agents/main/turns") return turnsEnvelope([]);
      if (method === "POST" && url === "http://127.0.0.1:4310/api/v1/sessions/session_gate27/prompts") {
        posted += 1;
        return envelope({ prompt_id: "msg_q1", status: "running" });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    let error = null;
    try {
      await backend.spawn(makeAgent(), { prompt: "hi" }, { silentTimeout: 60, pollInterval: 5 });
    } catch (caught) {
      error = caught;
    }
    return { error, posted, detailReads, calls };
  };
  const idle = await spawnWithDetail("session-detail-fresh.json");
  assert.equal(idle.error, null, "2.7 idle（投影双 false）放行");
  assert.equal(idle.posted, 1, "放行后提交恰一次");
  for (const fixtureName of ["t1-tools-session-running.json", "t6-background-session-after-turn.json"]) {
    const busy = await spawnWithDetail(fixtureName);
    assert.ok(busy.error, `${fixtureName}：门必须到界`);
    assert.match(busy.error.message, /session busy at dispatch/);
    assert.match(busy.error.message, /within 60ms/);
    assert.equal(busy.posted, 0, `${fixtureName}：零提交`);
    assert.ok(busy.detailReads >= 2, `${fixtureName}：静默门多拍到界（实际 ${busy.detailReads} 拍）`);
    assert.ok(!busy.calls.some((c) => c.url.includes("/agents/main/turns")), "门未过不读提交前边界");
  }
});

test("TD-362: sessionStatus——2.7 activity 三态投影（idle → idle；turn/background → busy）", async () => {
  const statusFor = async (fixtureName) => {
    const backend = new KimiWebBackend({ fetchImpl: async () => replay272(fixtureName), timeout: 5000, retries: 0 });
    return backend.sessionStatus(makeAgent(), "session_27");
  };
  assert.deepEqual(await statusFor("session-detail-fresh.json"), { type: "idle" }, "idle = 双 false");
  assert.deepEqual(await statusFor("t1-tools-session-running.json"), { type: "busy" }, "turn = 双 true");
  assert.deepEqual(
    await statusFor("t6-background-session-after-turn.json"),
    { type: "busy" },
    "background = busy 真而 main_turn_active 假（任一真即忙）",
  );
});

test("TD-362: sessionStatus——activity 闭集外：详情门拒判，停止面/停止验证保守记不可观察（绝不虚报 idle 或 quiet）", async () => {
  // 投影约定：activity 闭集外 → null → sessionDetail 抛 malformed。sessionStatus 的
  // 既有分工把"详情不可得"记 null（不改停止投影逻辑），停止面再把 null 转成抛错、
  // 验证器记 stop_unverified——保守方向是不虚报 idle/quiet（删除路径则独立保守当忙，
  // 见 releaseSession 用例）。
  const unknownDetail = () => jsonResponse({ code: 0, msg: "success", data: { id: "session_27", activity: "paused" } });
  const backend = new KimiWebBackend({ fetchImpl: async () => unknownDetail(), timeout: 5000, retries: 0 });
  assert.equal(await backend.sessionStatus(makeAgent(), "session_27"), null, "详情门拒判 → 不可得");
  const target = backend.stopTarget(makeAgent(), "session_27");
  await assert.rejects(() => target.sessionStatus(), /kimi-web session status unavailable/);
  const result = await verifyStopQuiet(target, "http://127.0.0.1:4310", "session_27", { rounds: 2, intervalMs: 1 });
  assert.deepEqual(result, { quiet: null, observation: "unavailable" }, "不可观察 ≠ 已停止");
});

test("TD-362: releaseSession——2.7 background → skipped_busy；idle → :delete deleted；实录 40401 → already_gone", async () => {
  const release = async (fixtureName, sessionId) => {
    const { calls, fetchImpl } = kimiServer((url) => {
      if (url.endsWith(`/api/v1/sessions/${sessionId}`)) return replay272(fixtureName);
      if (url.endsWith(`/api/v1/sessions/${sessionId}:delete`)) return envelope({ deleted: true });
      throw new Error(`unexpected ${url}`);
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    return { result: await backend.releaseSession(makeAgent(), sessionId), calls };
  };
  const sessionId = "session_e8e6ec53-68d9-4600-8f65-632bc57dd3fb";
  const background = await release("t6-background-session-after-turn.json", sessionId);
  assert.deepEqual(background.result, { outcome: "skipped_busy" }, "background（busy 真）不删");
  assert.equal(background.calls.filter((c) => c.url.endsWith(":delete")).length, 0, "background 零删除请求");

  const idle = await release("session-detail-fresh.json", sessionId);
  assert.deepEqual(idle.result, { outcome: "deleted" });
  assert.equal(idle.calls.filter((c) => c.url.endsWith(":delete")).length, 1, "idle 才走删除（恰一枪）");

  const goneId = "session_719454d9-45f0-4e58-ba1f-c680f2ab4d83";
  const gone = await release("session-detail-gone-40401.json", goneId);
  assert.deepEqual(gone.result, { outcome: "already_gone" }, "2.7 实录的会话不存在（HTTP 200 + 40401）");
  assert.equal(gone.calls.filter((c) => c.url.endsWith(":delete")).length, 0);

  // 闭集外 activity：删前探针不可证 idle → 保守当忙（与字段缺席同款）。
  const unknown = await kimiServer((url) => {
    if (url.endsWith(`/api/v1/sessions/${sessionId}`)) {
      return jsonResponse({ code: 0, msg: "success", data: { id: sessionId, activity: "paused" } });
    }
    throw new Error(`unexpected ${url}`);
  });
  const backend = new KimiWebBackend({ fetchImpl: unknown.fetchImpl, timeout: 5000, retries: 0 });
  assert.deepEqual(await backend.releaseSession(makeAgent(), sessionId), { outcome: "skipped_busy" });
});

test("TD-362: 2.6.3 后台任务详情（busy:true, main_turn_active:false）原样通过——2.6 判定不变：sessionStatus busy、releaseSession 保守不删", async () => {
  const recordedDetail = kimi263("background-task-session-detail.json").json.data;
  assert.equal(recordedDetail.activity, undefined, "2.6 实录没有 activity（投影原样返回）");
  assert.equal(recordedDetail.busy, true);
  assert.equal(recordedDetail.main_turn_active, false);
  const sessionId = "session_270387e8-ced0-4c8e-a8f1-826df7860ff8";
  const backend = new KimiWebBackend({
    fetchImpl: async () => replay263("background-task-session-detail.json"),
    timeout: 5000,
    retries: 0,
  });
  assert.deepEqual(await backend.sessionStatus(makeAgent(), sessionId), { type: "busy" });
  const { calls, fetchImpl } = kimiServer((url) => {
    if (url.endsWith(`/api/v1/sessions/${sessionId}`)) return replay263("background-task-session-detail.json");
    throw new Error(`unexpected ${url}`);
  });
  const releaseBackend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  assert.deepEqual(await releaseBackend.releaseSession(makeAgent(), sessionId), { outcome: "skipped_busy" });
  assert.equal(calls.filter((c) => c.url.endsWith(":delete")).length, 0);
});

test("TD-362: 停滞门活体证词——2.7 activity:turn 算活轮，续命不杀，最终 completed", async () => {
  const frozen = [runningTurn()];
  const script = [...Array(15).fill(frozen), [kimiTurn({ answer: "long-thought-answer" })]];
  const { handler, markSpawned, detailCalls } = attestedScriptServer("session_b5_27", { script, detailMode: "activity-turn" });
  const events = await runClocked(handler, markSpawned, 10_000);
  assert.equal(events.at(-1).reason, "completed", "2.7 的 turn 投影为双 true → 活体证词续命");
  assert.ok(!JSON.stringify(events).includes("turn stalled"));
  assert.ok(detailCalls() >= 1, "预算击发时确实取了证词");
  assert.equal(
    events.filter((e) => e.kind === "runtime_activity" && e.status === "serve_active").length,
    detailCalls(),
    "一次证词续命一条 serve_active（决定 0069）",
  );
});

test("TD-362: stopTarget().messages——读 turns 最新一页（page_size=200），条目数 = 各轮 items 之和；不请求 /messages", async () => {
  const turnsResponse = kimi272("t1-tools-turns-ended.json").json;
  const expected = turnsResponse.data.turns.reduce((n, turn) => n + turn.items.length, 0);
  const { calls, fetchImpl } = kimiServer((url) => {
    if (url.includes("/messages")) throw new Error("the removed /messages endpoint must never be requested");
    if (url === "http://127.0.0.1:4310/api/v1/sessions/session_stop/agents/main/turns?page_size=200") {
      return jsonResponse(turnsResponse);
    }
    throw new Error(`unexpected ${url}`);
  });
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const page = await backend.stopTarget(makeAgent(), "session_stop").messages();
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [[
    "GET",
    "http://127.0.0.1:4310/api/v1/sessions/session_stop/agents/main/turns?page_size=200",
  ]], "只读 turns 一页（带页大小）");
  assert.ok(!calls.some((c) => c.url.includes("/messages")), "2.7.2 已删除 /messages（404）——绝不请求");
  assert.equal(page.data.length, expected, "消息页条目数 = 各轮 items 之和");
  assert.equal(page.data.length, 7, "t1 实录：一轮 7 个条目");
  assert.equal(page.data[0].type, "user_message", "保留 turns 条目原形（计数只读长度）");
});

test("TD-362: releaseSession——activity 非字符串（数组/数字/对象/null）、详情缺 id（2.6/2.7）→ 一律 skipped_busy 且零删除", async () => {
  const sessionId = "session_shape_gap";
  const releaseWithDetail = async (data) => {
    const { calls, fetchImpl } = kimiServer((url) => {
      if (url.endsWith(`/api/v1/sessions/${sessionId}`)) return jsonResponse({ code: 0, msg: "success", data });
      if (url.endsWith(`/api/v1/sessions/${sessionId}:delete`)) return envelope({ deleted: true });
      throw new Error(`unexpected ${url}`);
    });
    const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
    const result = await backend.releaseSession(makeAgent(), sessionId);
    return { result, deletes: calls.filter((c) => c.url.endsWith(":delete")).length };
  };
  // ToPropertyKey 陷阱的端到端反例：["idle"] 若被折叠成 "idle" 就会删掉活会话。
  const nonStringActivities = [["idle"], ["background"], 7, { value: "idle" }, null];
  for (const activity of nonStringActivities) {
    const r = await releaseWithDetail({ id: sessionId, activity });
    assert.deepEqual(r.result, { outcome: "skipped_busy" }, `activity=${JSON.stringify(activity)} 必须拒删`);
    assert.equal(r.deletes, 0);
  }
  // 缺 id 的两代形状：不能证成就是目标会话，删除前探针保守当忙。
  for (const data of [
    { activity: "idle", workspace_id: "w1" }, // 2.7 残件
    { busy: false, main_turn_active: false, workspace_id: "w1" }, // 2.6 缺口
    { id: "", activity: "idle" }, // 空串 id
  ]) {
    const r = await releaseWithDetail(data);
    assert.deepEqual(r.result, { outcome: "skipped_busy" }, JSON.stringify(data));
    assert.equal(r.deletes, 0);
  }
});

function stopProbeServer(sessionId, turnsResponse) {
  return kimiServer((url) => {
    if (url.endsWith(`/api/v1/sessions/${sessionId}`)) {
      return jsonResponse({ code: 0, msg: "success", data: { id: sessionId, busy: false, main_turn_active: false } });
    }
    if (url === `http://127.0.0.1:4310/api/v1/sessions/${sessionId}/agents/main/turns?page_size=200`) {
      return jsonResponse(turnsResponse);
    }
    throw new Error(`unexpected ${url}`);
  });
}

test("TD-362: 停止探针——某轮缺 items 数组 → 抛错，verifyStopQuiet 记不可观察（绝不把看不全当没增长）", async () => {
  const sessionId = "session_stop_items";
  const turnsResponse = { code: 0, data: { turns: [{ turn_id: "t_1", ordinal: 0 }], has_more: false } };
  const { fetchImpl } = stopProbeServer(sessionId, turnsResponse);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const target = backend.stopTarget(makeAgent(), sessionId);
  await assert.rejects(() => target.messages(), /every turn needs an items array/);
  const result = await verifyStopQuiet(target, "http://127.0.0.1:4310", sessionId, { rounds: 2, intervalMs: 1 });
  assert.deepEqual(result, { quiet: null, observation: "unavailable" });
});

test("TD-362: 停止探针——turns 页 has_more:true（超过一页）→ 抛错，verifyStopQuiet 记不可观察", async () => {
  const sessionId = "session_stop_more";
  // 最新一页满窗口且还有更旧的轮：窗口滑动时总数可能不变，增长检测不可信。
  const turnsResponse = {
    code: 0,
    data: {
      turns: [{ turn_id: "t_200", ordinal: 200, items: [{ type: "assistant_message", text: "x" }] }],
      has_more: true,
    },
  };
  const { fetchImpl } = stopProbeServer(sessionId, turnsResponse);
  const backend = new KimiWebBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const target = backend.stopTarget(makeAgent(), sessionId);
  await assert.rejects(() => target.messages(), /turns page has_more:true/);
  const result = await verifyStopQuiet(target, "http://127.0.0.1:4310", sessionId, { rounds: 2, intervalMs: 1 });
  assert.deepEqual(result, { quiet: null, observation: "unavailable" });
});

// ===== 收尾：kimi 2.6.3 实测目录覆盖（须是本文件最后一个测试——前面的测试先读完）=====

test("kimi 2.6.3 实测：目录里每个文件都被本文件读到（README 写明了采集方式）", () => {
  assert.match(readFileSync(new URL("README.md", KIMI_263_DIR), "utf8"), /agents\/main\/turns/);
  kimi263Read.add("README.md");
  const files = readdirSync(KIMI_263_DIR).sort();
  assert.deepEqual(files.filter((name) => !kimi263Read.has(name)), [], "未被读到的实测文件");
});
