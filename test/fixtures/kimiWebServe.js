// test/fixtures/kimiWebServe.js
//
// kimi-web 假服务器共享夹具：`kimi-web`（现行唯一的 serve 家族后端，HTTP attach
// 型——会话活过 WAO 进程）的离线测试构造。零真实服务器、零网络：全部经注入的
// fetchImpl 回放上游形状；鉴权 token 用测试自设的假环境变量（withKimiToken /
// KIMI_TEST_TOKEN_ENV，测完即删），绝不发真实请求。
//
// 形状锚 = kimi 2.6.3 的实测响应（test/fixtures/kimi-2.6.3/，src/backends/kimiWeb.js
// 文件头）：GET …/agents/main/turns → {turns[], has_more}；GET …/prompts →
// {active, queued[]}；POST …/prompts → {prompt_id, user_message_id, status}。
//
// 两层夹具：
//   1. 底层信封/路由件（kimiServer / envelope / detailEnvelope / turnsEnvelope /
//      kimiTurn / spawnOkRoutes / turnScriptServer……）。
//   2. runServer——RunManager 级"驱动一个 run 到完成"的有状态假服务器
//      （spawn 建会话 → 静默门 → 提交前 turns 读 → POST prompts → 轮询见 running →
//      delayMs 后 ended/completed）。
//
// runServer 的终态会话卫生形状：轮一旦终态（completed/aborted），会话详情改答
// code 40401 "session does not exist"（TD-250 releaseSession 删除后的真实回显形状），
// prompts 列表答空（{active:null, queued:[]}——事件流收口那一拍先读 prompts 再读
// turns，列表不能先于轮变成"会话不存在"）；messages 没有路由，请求即抛错。这让
// RunManager._runCleanup 的停止探针（verifyStopQuiet）落到"不可观察 → 立即收口"，
// 中止后的复查读到 40401 即视为已停。副作用：终态清理会记 run.stop_unverified
// （observation unavailable）+ releaseSession already_gone——这两条是本夹具形状的
// 既知事实，相关文件不对其断言。

export const KIMI_TEST_SERVE_URL = "http://127.0.0.1:4310";
export const KIMI_TEST_TOKEN_ENV = "KIMI_WEB_TEST_TOKEN";
export const KIMI_TEST_TOKEN_VALUE = "kimi-web-test-token-value-0123456789";

/** 临时设好假 token 再跑 fn，结束后删除（绝不泄漏到其它测试）。 */
export async function withKimiToken(fn, { tokenEnv = KIMI_TEST_TOKEN_ENV, value = KIMI_TEST_TOKEN_VALUE } = {}) {
  process.env[tokenEnv] = value;
  try {
    return await fn();
  } finally {
    delete process.env[tokenEnv];
  }
}

/** 假 kimi web 服务器：记录全部请求，按测试提供的 handler 应答。 */
export function kimiServer(handler) {
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
export function envelope(data, { code = 0, msg = "" } = {}) {
  return jsonResponse({ code, msg, data });
}

export function jsonResponse(value, status = 200) {
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

/** 会话已删信封（TD-250：HTTP 200 + code 40401 "session … does not exist"）。 */
export function goneEnvelope(sessionId) {
  return envelope(null, { code: 40401, msg: `session ${sessionId} does not exist` });
}

/** 会话详情健康形状（A4 在场门：id 与 busy/main_turn_active 都必须在场）。 */
export function detailEnvelope(sessionId, busy, mainTurnActive, reason) {
  return envelope({
    id: sessionId,
    busy,
    main_turn_active: mainTurnActive,
    last_turn_reason: reason,
    usage: {},
  });
}

/** turns 页信封（2.6.3：data {turns[], has_more}）。 */
export function turnsEnvelope(turns, { hasMore = false } = {}) {
  return envelope({ turns, has_more: hasMore });
}

/** prompts 列表信封（2.6.3：data {active, queued[]}）；条目可传 id 字符串或完整对象。 */
export function promptsEnvelope(active = null, queued = []) {
  const entry = (value, status) => (typeof value === "string" ? { prompt_id: value, user_message_id: value, status } : value);
  return envelope({
    active: active === null ? null : entry(active, "running"),
    queued: queued.map((value) => entry(value, "queued")),
  });
}

/** user_message 条目（2.6.3 形状）。 */
export function userMessageItem(promptIds = ["msg_q1"], text = "hi", overrides = {}) {
  return {
    type: "user_message",
    item_id: promptIds[0],
    status: "ended",
    outcome: "completed",
    prompt_ids: promptIds,
    placement: "opener",
    origin: { kind: "user" },
    text,
    ...overrides,
  };
}

/** assistant_message 条目（2.6.3 形状）。 */
export function assistantItem(text, stepIndex = 1, overrides = {}) {
  return { type: "assistant_message", item_id: `a_${stepIndex}_${text.length}`, step_index: stepIndex, status: "ended", outcome: "completed", text, ...overrides };
}

/** tool_call 条目（2.6.3 形状；status "ended" 为终态，outcome 非 completed 记为错误）。 */
export function toolCallItem(overrides = {}) {
  return {
    type: "tool_call",
    item_id: "tool_1",
    step_index: 1,
    status: "ended",
    name: "Bash",
    input: { command: "echo hi" },
    display: { kind: "command", command: "echo hi" },
    outcome: "completed",
    output: "hi\n",
    ...overrides,
  };
}

/** 步骤（2.6.3 形状：index 从 1 起；usage 可缺席——打断的步没有 usage）。 */
export function stepItem(overrides = {}) {
  return {
    index: 1,
    outcome: "completed",
    finish_reason: "end_turn",
    usage: { input_other: 100, output: 7, input_cache_read: 10, input_cache_creation: 3 },
    ...overrides,
  };
}

/**
 * 轮（2.6.3 形状）。默认：ended/completed、开场 user_message 带 promptIds、一条
 * assistant_message（answer；null 则不带）、一个步骤；轮级 usage 默认等于步骤 usage
 * 之和（与实测一致）。overrides 原样覆盖（传 items 即整体替换条目）。
 */
export function kimiTurn({ promptIds = ["msg_q1"], prompt = "hi", answer = "answer", ...overrides } = {}) {
  const steps = overrides.steps ?? [stepItem()];
  return {
    turn_id: "t_0",
    ordinal: 0,
    kind: "agent",
    status: "ended",
    outcome: "completed",
    steps,
    items: [userMessageItem(promptIds, prompt), ...(answer === null ? [] : [assistantItem(answer)])],
    usage: sumStepUsage(steps),
    ...overrides,
  };
}

function sumStepUsage(steps) {
  let usage;
  for (const step of steps) {
    if (!step?.usage) continue;
    usage ??= {};
    for (const [key, value] of Object.entries(step.usage)) usage[key] = (usage[key] ?? 0) + value;
  }
  return usage;
}

/** 在跑的轮：status running、没有 outcome、只有开场消息。 */
export function runningTurn({ promptIds = ["msg_q1"], prompt = "hi", ...overrides } = {}) {
  const turn = kimiTurn({ promptIds, prompt, answer: null, steps: [], ...overrides });
  if (!("status" in overrides)) turn.status = "running";
  if (!("outcome" in overrides)) delete turn.outcome;
  if (!("usage" in overrides)) delete turn.usage;
  return turn;
}

const turnsPath = (serveUrl, sessionId) => `${serveUrl}/api/v1/sessions/${sessionId}/agents/main/turns`;

/**
 * spawn 成功所需的最小路由（fresh 轮）。spawn 时序 = POST /sessions → GET 会话详情
 * （提交前静默门，idle 即过）→ GET turns（提交前边界读）→ POST /prompts；preTurns 即
 * 提交前的轮。
 */
export function spawnOkRoutes(sessionId = "session_new", preTurns = [], serveUrl = KIMI_TEST_SERVE_URL) {
  return (url) => {
    if (url === `${serveUrl}/api/v1/sessions`) return envelope({ id: sessionId });
    if (url === `${serveUrl}/api/v1/sessions/${sessionId}`) {
      return detailEnvelope(sessionId, false, false, null);
    }
    if (url === turnsPath(serveUrl, sessionId)) return turnsEnvelope(preTurns);
    if (url.endsWith(`/api/v1/sessions/${sessionId}/prompts`)) {
      return envelope({ prompt_id: "msg_q1", user_message_id: "msg_q1", status: "running" });
    }
    throw new Error(`unexpected ${url}`);
  };
}

/**
 * 事件轮夹具：spawn 阶段（提交前 turns 读）返回 preTurns；markSpawned() 之后每拍按
 * script 回放（script[i-1] 为第 i 拍的轮数组——数组成员或 (pollNumber) => turns 函数；
 * 超出脚本长度恒重复最后一项）。prompts（GET 列表）同理按拍回放：缺省恒为空列表；
 * 给对象 {active, queued} 恒用它，给函数 (pollNumber) => {active, queued}。一拍 = 一次
 * GET prompts（事件流每拍先读 prompts 再读 turns）；polls() 只计事件轮拍数。
 */
export function turnScriptServer(sessionId, {
  promptId = "msg_q1", preTurns = [], script = [], prompts = null, submitStatus = "running",
} = {}, serveUrl = KIMI_TEST_SERVE_URL) {
  let spawned = false;
  let polls = 0;
  const handler = (url, init = {}) => {
    const method = init.method ?? "GET";
    if (url === `${serveUrl}/api/v1/sessions`) return envelope({ id: sessionId });
    if (url === `${serveUrl}/api/v1/sessions/${sessionId}`) {
      return detailEnvelope(sessionId, false, false, null);
    }
    if (method === "GET" && url === `${serveUrl}/api/v1/sessions/${sessionId}/prompts`) {
      if (spawned) polls += 1;
      const listed = typeof prompts === "function" ? prompts(polls) : prompts;
      return promptsEnvelope(listed?.active ?? null, listed?.queued ?? []);
    }
    if (url === turnsPath(serveUrl, sessionId)) {
      if (!spawned) return turnsEnvelope(preTurns);
      const entry = script[Math.min(Math.max(polls, 1) - 1, script.length - 1)];
      const turns = typeof entry === "function" ? entry(polls) : (entry ?? []);
      return turnsEnvelope(turns);
    }
    if (method === "POST" && url.endsWith(`/api/v1/sessions/${sessionId}/prompts`)) {
      return envelope({ prompt_id: promptId, user_message_id: promptId, status: submitStatus });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { handler, markSpawned: () => { spawned = true; }, polls: () => polls };
}

// runServer 的 usage 选项沿用旧的 camelCase 键（inputOther 等）的调用方仍在（交付测试），
// 这里映射到 2.6 的轮级 usage 键；2.6 键原样通过。
const LEGACY_USAGE_KEYS = Object.freeze({
  inputOther: "input_other",
  output: "output",
  inputCacheRead: "input_cache_read",
  inputCacheCreation: "input_cache_creation",
});
function turnUsage(usage) {
  return Object.fromEntries(Object.entries(usage).map(([key, value]) => [LEGACY_USAGE_KEYS[key] ?? key, value]));
}

/**
 * RunManager 级有状态假服务器。
 * 每会话一台小状态机：pending →（POST prompts）→ running →（delayMs 后）
 * completed；abort 走 GET prompts → POST …/{promptId}:abort → aborted（轮
 * ended/interrupted）。
 *
 * 选项：
 *   - delayMs：提交后多少毫秒轮才 ended/completed（0 = 立即；Infinity = 永不完成
 *     ——run 持续 running，停滞预算下限 60s 保证测试窗口内不误收口）。写文件
 *     （writePath）发生在提交时。
 *   - replies：每次提交的回复队列（耗尽后回 "done"）；单回复默认 assistantText。
 *     reply 作为 completed 轮的 assistant_message。
 *   - failTranscriptAfterSubmit：提交后的 turns 轮询一律抛错（等待期 backend 故障——
 *     streamEvents 会把它收成 done(failed)）。true → 固定文案 "backend exploded"，或
 *     直接给字符串当错误文案。（名字沿用 transcript 端点时代，调用方不必改。）
 *   - failAbort：POST …/{promptId}:abort 一律抛错且轮恒在跑（abort 杠杆故障——
 *     abortActivePrompt 复查仍见活动 prompt，收成固定失败文案，run 仍按意图转 aborted）。
 *   - usage：completed 轮的轮级 usage（2.6 键或旧 camelCase 键）。
 *   - calls：全部请求的记录（url/method/body）。
 */
export function runServer(serveUrl = KIMI_TEST_SERVE_URL, {
  assistantText = "Mock response",
  replies = null,
  delayMs = 0,
  writePath = null,
  writeContent = "modified\n",
  failTranscriptAfterSubmit = false,
  failAbort = false,
  usage = null,
} = {}) {
  const calls = [];
  let sessionSeq = 0;
  const sessions = new Map();
  const base = `${serveUrl}/api/v1/sessions`;
  const newSession = () => {
    sessionSeq += 1;
    const id = `session_mock_${sessionSeq}`;
    sessions.set(id, {
      id,
      promptId: null,
      prompt: "",
      replyQueue: replies ? [...replies] : [assistantText],
      submittedAt: null,
      turnState: "pending",
      writePath,
      writeContent,
    });
    return id;
  };
  // 到点即转 completed（prompts 与 turns 两个读口都推进，同一拍内看到一致的终态）。
  // failAbort 的场景是"中止杠杆坏了、轮停不下"：轮恒在跑。
  const advance = (session) => {
    if (failAbort) return;
    if (session.turnState === "running" && session.submittedAt !== null && Date.now() - session.submittedAt >= delayMs) {
      session.turnState = "completed";
    }
  };
  const sessionTurns = (session) => {
    const promptIds = [session.promptId];
    if (session.turnState === "completed") {
      const steps = [stepItem(usage ? { usage: turnUsage(usage) } : {})];
      return [kimiTurn({ turn_id: "t_mock", promptIds, prompt: session.prompt, answer: session.reply ?? "done", steps })];
    }
    if (session.turnState === "aborted") {
      return [kimiTurn({
        turn_id: "t_mock", promptIds, prompt: session.prompt, answer: null,
        steps: [stepItem({ outcome: "interrupted", finish_reason: "interrupted", usage: undefined })],
        outcome: "interrupted", end_reason: "user_cancelled", usage: undefined,
      })];
    }
    return [runningTurn({ turn_id: "t_mock", promptIds, prompt: session.prompt })];
  };
  const fetchImpl = async (url, init = {}) => {
    const urlStr = String(url);
    calls.push({ url: urlStr, method: init.method ?? "GET", body: init.body });
    if (init.method === "POST" && urlStr === base) {
      return envelope({ id: newSession() });
    }
    // 逐会话分派：/sessions/<id>、/sessions/<id>/agents/main/turns、/sessions/<id>/prompts…。
    const rest = urlStr.startsWith(`${base}/`) ? urlStr.slice(base.length + 1) : null;
    const [sid, ...tail] = rest ? rest.split(/[/?]/) : [];
    const session = sessions.get(sid);
    if (!session) throw new Error(`unexpected request ${urlStr}`);
    const sub = tail[0] ?? "";
    const method = init.method ?? "GET";
    // GET 会话详情（静默门 + 停滞证词 + 中止复查 + 停止探针；在跑时同样答 idle——沿用旧形状）。
    if (method === "GET" && sub === "") {
      advance(session);
      if (session.turnState !== "pending" && session.turnState !== "running") {
        return goneEnvelope(sid);
      }
      return detailEnvelope(sid, false, false, null);
    }
    // GET agents/main/turns（提交前边界读 + 事件轮轮询）。
    if (method === "GET" && sub === "agents" && tail[1] === "main" && tail[2] === "turns") {
      if (session.turnState === "pending") return turnsEnvelope([]);
      if (failTranscriptAfterSubmit) {
        throw new Error(typeof failTranscriptAfterSubmit === "string" ? failTranscriptAfterSubmit : "backend exploded");
      }
      advance(session);
      return turnsEnvelope(sessionTurns(session));
    }
    // GET prompts（事件流每拍的结算读 + abort 杠杆的列表读）。
    if (method === "GET" && sub === "prompts" && tail.length === 1) {
      advance(session);
      return promptsEnvelope(session.turnState === "running" ? session.promptId : null);
    }
    // POST prompts/{promptId}:abort（中止活动轮）。须排在提交之前：两者首段都是 prompts。
    if (method === "POST" && sub === "prompts" && typeof tail[1] === "string" && tail[1].endsWith(":abort")) {
      if (failAbort) throw new Error("abort endpoint exploded");
      if (session.turnState === "running") session.turnState = "aborted";
      return envelope({ aborted: true });
    }
    // POST prompts（提交）。
    if (method === "POST" && sub === "prompts" && tail.length === 1) {
      const body = JSON.parse(init.body ?? "{}");
      session.prompt = body.content?.[0]?.text ?? "";
      session.reply = session.replyQueue.shift() ?? "done";
      session.promptId = `msg_mock_${sid}`;
      session.submittedAt = Date.now();
      session.turnState = "running";
      if (session.writePath) {
        const { writeFile: wf } = await import("node:fs/promises");
        await wf(session.writePath, session.writeContent);
      }
      return envelope({ prompt_id: session.promptId, user_message_id: session.promptId, status: "running" });
    }
    throw new Error(`unexpected request ${urlStr}`);
  };
  return { calls, fetchImpl, sessions };
}
