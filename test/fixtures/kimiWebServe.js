// test/fixtures/kimiWebServe.js
//
// kimi-web 假服务器共享夹具（61a 批设立）：`kimi-web`（现行唯一的 serve 家族
// 后端，HTTP attach 型——会话活过 WAO 进程）的离线测试构造。零真实服务器、
// 零网络：全部经注入的 fetchImpl 回放上游形状；鉴权 token 用测试自设的假环境
// 变量（withKimiToken / KIMI_TEST_TOKEN_ENV，测完即删），绝不发真实请求。
//
// 两层夹具：
//   1. 底层信封/路由件（kimiServer / envelope / detailEnvelope / turnItem /
//      spawnOkRoutes / turnScriptServer……）——原 test/backends/kimiWeb.test.js
//      的夹具原样迁来（61a 起多文件共用，同一函数只留一份；形状锚 =
//      src/backends/kimiWeb.js 文件头的上游实测）。
//   2. runServer——RunManager 级"驱动一个 run 到完成"的有状态假服务器
//      （spawn 建会话 → F3 静默门 → POST prompts → transcript 轮询见 running →
//      delayMs 后 completed）。语义对齐各测试原 opencode-serve mock fetch：
//      assistantDelay → delayMs、慢回复跨 deadline；writePath/writeContent →
//      提交时写文件（交付测试的 worker 产出）；replies → 逐次回复队列。
//
// runServer 的终态会话卫生形状：turn 一旦终态（completed/aborted），会话端点
// （detail/prompts；messages 没有路由，请求即抛错）改答 code 40401 "session does not exist"（TD-250
// releaseSession 删除后的真实回显形状）。这不是为了测删除，而是让
// RunManager._runCleanup 的停止探针（verifyStopQuiet，硬编码 3 轮 × 2s）落到
// "不可观察 → 立即收口"，与旧 opencode mock 的 404 探针同速——否则每个终态
// run 白等 4s。副作用：终态清理会记 run.stop_unverified（observation
// unavailable）+ releaseSession already_gone——这两条是本夹具形状的既知事实，
// 相关文件不对其断言。

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

/** transcript 信封（data.items 轮粒度 + seq 水位 + has_more；v8 只消费 items）。 */
export function transcriptEnvelope(items, extra = {}) {
  return envelope({ items, seq: 7, has_more: false, ...extra });
}

/** transcript 轮条目（形状锚 = 2026-09-30 live 实测，见 backend 文件头）。 */
export function turnItem(overrides = {}) {
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
export function stepItem(overrides = {}) {
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
export function spawnOkRoutes(sessionId = "session_new", preTurns = [], serveUrl = KIMI_TEST_SERVE_URL) {
  return (url) => {
    if (url === `${serveUrl}/api/v1/sessions`) return envelope({ id: sessionId });
    if (url === `${serveUrl}/api/v1/sessions/${sessionId}`) {
      return detailEnvelope(sessionId, false, false, null);
    }
    if (url === `${serveUrl}/api/v1/sessions/${sessionId}/transcript?agent_id=main`) {
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
export function turnScriptServer(sessionId, { promptId = "msg_q1", preTurns = [], script = [] } = {}, serveUrl = KIMI_TEST_SERVE_URL) {
  let spawned = false;
  let polls = 0;
  const handler = (url) => {
    if (url === `${serveUrl}/api/v1/sessions`) return envelope({ id: sessionId });
    if (url === `${serveUrl}/api/v1/sessions/${sessionId}`) {
      return detailEnvelope(sessionId, false, false, null);
    }
    if (url === `${serveUrl}/api/v1/sessions/${sessionId}/transcript?agent_id=main`) {
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
 * RunManager 级有状态假服务器（61a：替代各测试的 opencode-serve mock fetch）。
 * 每会话一台小状态机：pending →（POST prompts）→ running →（delayMs 后）
 * completed；abort 走 GET prompts → POST …/{promptId}:abort → aborted。
 *
 * 选项（对齐旧 opencode mock 的语义）：
 *   - delayMs：提交后多少毫秒 turn 才 completed（0 = 立即；Infinity = 永不完成
 *     ——"silent"假服务器的等价物：run 持续 running，停滞预算下限 60s 保证测试
 *     窗口内不误收口）。写文件（writePath）发生在提交时（同旧 createWorkerFetch
 *     在 prompt_async 里写）。
 *   - replies：每次提交的回复队列（耗尽后回 "done"）；单回复默认
 *     assistantText。reply 作为 completed 轮的 assistant text 帧。
 *   - failTranscriptAfterSubmit：提交后的 transcript 轮询一律抛错（等待期
 *     backend 故障——streamEvents 会把它收成 done(failed)）。true → 固定
 *     文案 "backend exploded"，或直接给字符串当错误文案。
 *   - failAbort：POST …/{promptId}:abort 一律抛错（abort 杠杆故障——
 *     abortActivePrompt 收成固定失败文案，run 仍按意图转 aborted）。
 *   - calls：全部请求的记录（url/method/body）。
 *
 * 会话卫生形状（见文件头）：turn 终态后 detail 与 prompts 答 40401（messages 没有路由，请求即抛错），
 * transcript 端点继续可读（历史轮次留档——与真实 serve 删除后 transcript 仍可
 * 读的实测形状一致，且 resume/replay 走新会话不受影响）。
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
  const completedItems = (session) => [
    turnItem({
      turnId: "t0",
      triggerPromptId: session.promptId,
      ordinal: 0,
      state: "completed",
      prompt: session.prompt,
      steps: [stepItem({
        stepId: "s0",
        ...(usage ? { usage } : {}),
        frames: [{ kind: "text", text: session.reply ?? "done", role: "assistant" }],
      })],
    }),
  ];
  const runningItems = (session) => [
    turnItem({
      turnId: "t0",
      triggerPromptId: session.promptId,
      ordinal: 0,
      state: "running",
      prompt: session.prompt,
      steps: [],
    }),
  ];
  const fetchImpl = async (url, init = {}) => {
    const urlStr = String(url);
    calls.push({ url: urlStr, method: init.method ?? "GET", body: init.body });
    if (init.method === "POST" && urlStr === base) {
      return envelope({ id: newSession() });
    }
    // 逐会话分派：/sessions/<id>、/sessions/<id>/transcript、/sessions/<id>/prompts…。
    const rest = urlStr.startsWith(`${base}/`) ? urlStr.slice(base.length + 1) : null;
    const [sid, ...tail] = rest ? rest.split(/[/?]/) : [];
    const session = sessions.get(sid);
    if (!session) throw new Error(`unexpected request ${urlStr}`);
    const sub = tail[0] ?? "";
    // GET 会话详情（F3 静默门 + 停止探针 sessionStatus/session）。
    if (init.method === "GET" && sub === "") {
      if (session.turnState !== "pending" && session.turnState !== "running") {
        return goneEnvelope(sid);
      }
      return detailEnvelope(sid, false, false, null);
    }
    // GET transcript?agent_id=main（提交前观察锚 + 事件轮轮询）。
    if (init.method === "GET" && sub === "transcript") {
      if (session.turnState === "pending") return transcriptEnvelope([]);
      if (failTranscriptAfterSubmit) {
        throw new Error(typeof failTranscriptAfterSubmit === "string" ? failTranscriptAfterSubmit : "backend exploded");
      }
      if (session.turnState === "aborted" || session.turnState === "completed") {
        return transcriptEnvelope(session.turnState === "completed" ? completedItems(session) : runningItems(session));
      }
      if (session.submittedAt !== null && Date.now() - session.submittedAt >= delayMs) {
        session.turnState = "completed";
        return transcriptEnvelope(completedItems(session));
      }
      return transcriptEnvelope(runningItems(session));
    }
    // GET prompts（abort 杠杆的列表读）。
    if (init.method === "GET" && sub === "prompts") {
      if (session.turnState !== "pending" && session.turnState !== "running") {
        return goneEnvelope(sid);
      }
      return envelope({
        active: session.turnState === "running" ? { prompt_id: session.promptId } : null,
        queued: [],
      });
    }
    // POST prompts/{promptId}:abort（中止活动轮）。须排在提交之前：两者首段都是 prompts。
    if (init.method === "POST" && sub === "prompts" && typeof tail[1] === "string" && tail[1].endsWith(":abort")) {
      if (failAbort) throw new Error("abort endpoint exploded");
      if (session.turnState === "running") session.turnState = "aborted";
      return envelope({ aborted: true });
    }
    // POST prompts（提交）。
    if (init.method === "POST" && sub === "prompts" && tail.length === 1) {
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
      return envelope({ prompt_id: session.promptId, status: "running" });
    }
    throw new Error(`unexpected request ${urlStr}`);
  };
  return { calls, fetchImpl, sessions };
}
