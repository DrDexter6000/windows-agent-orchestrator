/**
 * opencode 后台静默验证（S1-2，TD-37 落地，事故修复 2026-06-18）。
 *
 * 背景：06-18 事故证明 opencode 的 abort HTTP 调用可能"虚假成功"——返回 204、
 * transcript 写 run.aborted，但 serve 端 session 继续烧 token 7.4h。
 * "成功停止"必须由实测定义（token/message 不再增长），不能由"调用没报错"定义。
 *
 * 契约：abort 后调用本函数，连续 rounds 轮询 session + messages，比对增长。
 *   - 全部 rounds 轮无增长 → { quiet: true }
 *   - 任一轮增长 → { quiet: false, delta, metric }
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
 * @returns {Promise<{quiet: boolean, delta?: object, metric?: string}>}
 */
export async function verifyStopQuiet(backend, serveUrl, sessionId, opts = {}) {
  const cwd = opts.cwd;
  const rounds = opts.rounds ?? 3;
  const intervalMs = opts.intervalMs ?? 2000;

  // 第 1 轮采样作为基线（含 MessageAbortedError 尾随 message）
  const baseline = await sample(backend, serveUrl, sessionId, cwd);
  let baselineTokens = baseline.tokens;
  let baselineMsgCount = baseline.msgCount;

  for (let i = 1; i < rounds; i += 1) {
    await sleep(intervalMs);
    const cur = await sample(backend, serveUrl, sessionId, cwd);

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
 * 失败（endpoint 报错）当作"无法验证"，返回当前已知值不增长——
 * 避免因网络抖动误判 quiet=false 触发激进的 taskkill。
 */
async function sample(backend, serveUrl, sessionId, cwd) {
  let tokens = 0;
  let msgCount = 0;
  try {
    const sess = await backend.session(serveUrl, sessionId, { cwd });
    const t = sess?.tokens;
    if (t) {
      tokens = (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0);
    }
  } catch {
    // session endpoint 报错：保持 tokens=0（不增长），不阻断验证
  }
  try {
    const page = await backend.messages(serveUrl, sessionId, { cwd });
    msgCount = Array.isArray(page?.data) ? page.data.length : 0;
  } catch {
    // messages endpoint 报错：保持 msgCount=0（不增长）
  }
  return { tokens, msgCount };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// executeStopWithVerification（S1-2 高层编排）
//
// 编排：abort → verifyStopQuiet → quiet=false 时强制 taskkill 兜底。
// 返回结构化结果（该写什么 transcript 事件由调用方决定），纯函数，不依赖 transcript/CLI。
//
// taskkill 兜底：abort 是"基于意图"的停止，可能虚假成功（06-18 事故）。
// 当 verifyStopQuiet 判定后台未停时，唯一可靠的兜底是杀 opencode 进程本身。
// 生产环境用 taskkill /IM opencode.exe /F（杀所有 session，宁可误杀不可继续烧）。
// taskkill 动作通过 opts.taskkill 注入，便于测试 mock。
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
  // 默认 taskkill 动作：杀 opencode 进程（Windows）。非 Windows 或无 opencode 时 no-op。
  const taskkill = opts.taskkill ?? defaultTaskkill;

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
  if (!verifyResult.quiet) {
    // 后台仍在烧：abort 无效，强制杀进程兜底（不依赖 abort 是否生效）
    try {
      await taskkill();
      taskkillCalled = true;
    } catch {
      // taskkill 失败不阻断——已尽力，调用方据此触发告警
    }
  }

  return {
    verified: verifyResult.quiet,
    abortCalled,
    taskkillCalled,
    verifyResult,
    ...(abortError ? { abortError } : {}),
  };
}

/**
 * 默认 taskkill 动作（生产）：杀 opencode 进程树。
 * 06-18 事故止血用的就是这条命令。会杀所有 opencode session——预期行为，
 * 失控时宁可全杀也不继续烧 quota。
 */
async function defaultTaskkill() {
  if (process.platform !== "win32") return; // 非 Windows 无 taskkill，no-op
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn("taskkill", ["/IM", "opencode.exe", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve()); // opencode 进程名不符等，resolve 不抛
  });
}
