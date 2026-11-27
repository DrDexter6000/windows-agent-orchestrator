// src/application/dashboardSession.js
//
// 第 145b 批（决定 0131 第 2 条）：常驻看板的内存会话存储。
//
// 服务端只在内存里保存有效记录：绝对有效期 DASHBOARD_SESSION_TTL_MS（24 小时）、
// 最多 DASHBOARD_SESSION_MAX（32）个、超出按签发先后淘汰；实例重启即全部失效
// （存储随进程消亡，这里没有任何持久化）。令牌与启动码同形（64 位小写十六进制），
// 校验用 timingSafeEqual——长度不等在比较前拒绝。
//
// 架构契约：纯内存、无 I/O；不 import src/commands/*、src/mcp/*、MCP SDK 或 zod。

import { randomBytes, timingSafeEqual } from "node:crypto";

import { DASHBOARD_SESSION_MAX, DASHBOARD_SESSION_TTL_MS } from "./dashboardPaths.js";

const TOKEN_RE = /^[0-9a-f]{64}$/;

const sameToken = (a, b) => {
  const got = Buffer.from(a);
  const want = Buffer.from(b);
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
};

/**
 * 创建一个会话存储。所有输入可注入（测试）。
 *
 * @param {object} [input]
 * @param {Function} [input.now] — 时钟（毫秒）
 * @param {number} [input.ttlMs=DASHBOARD_SESSION_TTL_MS] — 绝对有效期
 * @param {number} [input.max=DASHBOARD_SESSION_MAX] — 条数上限（FIFO 淘汰）
 * @param {Function} [input.randomBytesFn] — 随机源（(size) => Buffer）
 * @returns {{issue: () => {token: string, expiresAt: number}, valid: (token: string) => boolean, size: () => number}}
 */
export function createSessionStore({
  now = Date.now, ttlMs = DASHBOARD_SESSION_TTL_MS, max = DASHBOARD_SESSION_MAX, randomBytesFn = randomBytes,
} = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new TypeError(`createSessionStore: ttlMs must be a positive integer (default ${DASHBOARD_SESSION_TTL_MS})`);
  if (!Number.isInteger(max) || max <= 0) throw new TypeError(`createSessionStore: max must be a positive integer (default ${DASHBOARD_SESSION_MAX})`);
  /** 按签发先后排列的活会话（Map 保持插入序：队首最旧）。 */
  const live = new Map(); // token -> expiresAt

  const prune = (at) => {
    for (const [token, expiresAt] of live) {
      if (expiresAt > at) break; // 插入序 = 到期序（同一个 ttl）：后面都还没到期
      live.delete(token);
    }
  };

  return {
    /**
     * 签发一个会话令牌；超出上限时淘汰最旧的一个。坏随机源（形状不对或撞上已有令牌）
     * 重抽至多 16 次，超了就抛错——绝不无限循环（145b 修正一）。
     */
    issue() {
      let token = null;
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const candidate = randomBytesFn(32).toString("hex");
        if (TOKEN_RE.test(candidate) && !live.has(candidate)) {
          token = candidate;
          break;
        }
      }
      if (token === null) throw new Error("dashboardSession: 随机源无法产出新的会话令牌（重抽上限 16 次）");
      if (live.size >= max) {
        const oldest = live.keys().next().value;
        live.delete(oldest);
      }
      const expiresAt = now() + ttlMs;
      live.set(token, expiresAt);
      return { token, expiresAt };
    },
    /** 令牌此刻仍有效吗（逐条 timingSafeEqual 扫描；过期惰性清理）。 */
    valid(token) {
      if (typeof token !== "string" || !TOKEN_RE.test(token)) return false;
      const at = now();
      prune(at);
      let expiresAt = null;
      for (const [candidate, expiry] of live) {
        if (sameToken(token, candidate)) {
          expiresAt = expiry;
          break;
        }
      }
      return expiresAt !== null && expiresAt > at;
    },
    /** 清理后的活会话数。 */
    size() {
      prune(now());
      return live.size;
    },
  };
}
