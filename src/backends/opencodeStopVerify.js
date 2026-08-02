/**
 * opencode 后台静默验证（S1-2，TD-37 落地，事故修复 2026-06-18）。
 *
 * 背景：06-18 事故证明 opencode 的 abort HTTP 调用可能"虚假成功"——返回 204、
 * transcript 写 run.aborted，但 serve 端 session 继续烧 token 7.4h。
 * "成功停止"必须由实测定义（token/message 不再增长），不能由"调用没报错"定义。
 *
 * 契约：abort 后调用本函数，连续 rounds 轮询 status + session + messages。
 *   - 全部 rounds 轮无增长 → { quiet: true }
 *   - 任一轮增长 → { quiet: false, delta, metric }
 *   - 任一事实面不可观察 → { quiet: null, observation: "unavailable" }
 *
 * 两个独立指标（任一增长都算未停）：
 *   1. session.tokens（input+output+reasoning 累计，session 级，比 message 级可靠）
 *   2. messages 数量（新 message 出现 = 又生成了一轮）
 *
 * MessageAbortedError 处理：abort 副产物会在 messages 末尾追加一条
 * { info: { error: { name: "MessageAbortedError" } }, parts: [] }。这条 message
 * 是 abort 的正常表现，不是"后台还在跑"。第 1 轮采样时把它计入基线，
 * 后续轮次相比基线增长才算"未停"。
 *
 * 不读 opencode.db（那是取证手段，运行时不依赖直接读 serve 内部库）。
 */

/**
 * @param {object} backend OpenCodeServeBackend 实例（需有 session() 和 messages()）
 * @param {string} serveUrl
 * @param {string} sessionId
 * @param {{cwd?: string, rounds?: number, intervalMs?: number}} opts
 * @returns {Promise<{quiet: boolean|null, delta?: object, metric?: string, observation?: string}>}
 */
export async function verifyStopQuiet(backend, serveUrl, sessionId, opts = {}) {
  const cwd = opts.cwd;
  const rounds = opts.rounds ?? 3;
  const intervalMs = opts.intervalMs ?? 2000;

  // 第 1 轮采样作为基线（含 MessageAbortedError 尾随 message）
  const baseline = await sample(backend, serveUrl, sessionId, cwd);
  if (!baseline.observed) {
    return { quiet: null, observation: "unavailable" };
  }
  if (isActiveStatus(baseline.status)) {
    return { quiet: false, metric: "session_status" };
  }
  let baselineTokens = baseline.tokens;
  let baselineMsgCount = baseline.msgCount;

  for (let i = 1; i < rounds; i += 1) {
    await sleep(intervalMs);
    const cur = await sample(backend, serveUrl, sessionId, cwd);
    if (!cur.observed) {
      return { quiet: null, observation: "unavailable" };
    }
    if (isActiveStatus(cur.status)) {
      return { quiet: false, metric: "session_status" };
    }

    // 指标 1：session tokens 增长
    if (cur.tokens > baselineTokens) {
      return {
        quiet: false,
        delta: { from: baselineTokens, to: cur.tokens, diff: cur.tokens - baselineTokens },
        metric: "session_tokens",
      };
    }
    // 指标 2：messages 数量增长（排除基线已含的 aborted message）
    if (cur.msgCount > baselineMsgCount) {
      return {
        quiet: false,
        delta: { from: baselineMsgCount, to: cur.msgCount, diff: cur.msgCount - baselineMsgCount },
        metric: "message_count",
      };
    }
    // 更新基线为当前值（检测"持续增长"而非"只比第 1 轮"）
    baselineTokens = cur.tokens;
    baselineMsgCount = cur.msgCount;
  }
  return { quiet: true };
}

/**
 * 采样一次：取 session tokens 累计 + messages 数量。
 * 任一 endpoint 报错都标为不可观察。不可观察既不是 quiet，也不是
 * active；调用方必须报告 unverified，且不得据此杀掉其他 session。
 */
async function sample(backend, serveUrl, sessionId, cwd) {
  let tokens = 0;
  let msgCount = 0;
  let status = null;
  let statusObserved = false;
  let sessionObserved = false;
  let messagesObserved = false;
  try {
    if (typeof backend?.sessionStatus !== "function") {
      throw new Error("session status unavailable");
    }
    status = await backend.sessionStatus(serveUrl, sessionId, { cwd });
    statusObserved = isKnownStatus(status);
  } catch {
    statusObserved = false;
  }
  try {
    const sess = await backend.session(serveUrl, sessionId, { cwd });
    const t = sess?.tokens;
    if (t) {
      tokens = (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0);
    }
    sessionObserved = true;
  } catch {
    sessionObserved = false;
  }
  try {
    const page = await backend.messages(serveUrl, sessionId, { cwd });
    msgCount = Array.isArray(page?.data)
      ? page.data.filter((message) => message?.info?.error?.name !== "MessageAbortedError").length
      : 0;
    messagesObserved = true;
  } catch {
    messagesObserved = false;
  }
  return {
    tokens,
    msgCount,
    status,
    observed: statusObserved && sessionObserved && messagesObserved,
  };
}

function isActiveStatus(status) {
  const type = typeof status === "string" ? status : status?.type;
  return type === "busy" || type === "retry";
}

function isKnownStatus(status) {
  if (status === null || status === undefined) return true;
  const type = typeof status === "string" ? status : status?.type;
  return type === "idle" || type === "busy" || type === "retry";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// executeStopWithVerification（S1-2 高层编排）
//
// 编排：abort → verifyStopQuiet → optionally invoke an explicit caller-owned
// fallback only when the session is positively observed active.
// 返回结构化结果（该写什么 transcript 事件由调用方决定），纯函数，不依赖 transcript/CLI。
//
// WAO must not turn an unknown observation into either verified success or a
// global process kill. A taskkill callback is therefore explicit and optional;
// the default path never kills unrelated OpenCode sessions.
// ---------------------------------------------------------------------------

/**
 * @param {object} backend OpenCodeServeBackend 实例（abort/session/messages）
 * @param {string} serveUrl
 * @param {string} sessionId
 * @param {{cwd?: string, rounds?: number, intervalMs?: number, taskkill?: () => Promise<void>}} opts
 * @returns {Promise<{verified: boolean, abortCalled: boolean, taskkillCalled: boolean, verifyResult?: object, abortError?: string}>}
 */
export async function executeStopWithVerification(backend, serveUrl, sessionId, opts = {}) {
  const cwd = opts.cwd;
  const rounds = opts.rounds ?? 3;
  const intervalMs = opts.intervalMs ?? 2000;
  const taskkill = opts.taskkill;

  let abortCalled = false;
  let abortError = null;
  try {
    await backend.abort(serveUrl, sessionId);
    abortCalled = true;
  } catch (error) {
    abortCalled = true;
    abortError = error.message ?? String(error);
    // abort 失败不阻断——继续验证，若未停则 taskkill 兜底
  }

  const verifyResult = await verifyStopQuiet(backend, serveUrl, sessionId, { cwd, rounds, intervalMs });

  let taskkillCalled = false;
  if (verifyResult.quiet === false && typeof taskkill === "function") {
    // Positive active evidence permits an explicit caller-owned fallback.
    try {
      await taskkill();
      taskkillCalled = true;
    } catch {
      // taskkill 失败不阻断——已尽力，调用方据此触发告警
    }
  }

  return {
    verified: verifyResult.quiet === true,
    abortCalled,
    taskkillCalled,
    verifyResult,
    ...(abortError ? { abortError } : {}),
  };
}
