// src/application/upstreamSessionRelease.js
//
// TD-250（A1b，决定 0056，2026-10-10）：delivery 验收（run.delivery_accepted）后的
// 线系上游会话卫生。双席会审（consult_20261010220638436s4gchx kimi 席提案）：
// 验收是持久事实且使线系不可变（runContinue 的 parent_accepted 拒项——
// src/application/runContinue.js:364），此刻线系会话**可证不可续**；而 continuable
// 线系根在 RunManager 清理路径被 routing 门保护（A1 跳过删除），会话+保留
// worktree 会无限滞留——A1b 正是关掉这一类的钩子。
//
// 合同（与 A1 的 runManager 侧事件族完全同源，一果一名）：
//   - 能力门：agent 解析失败 / backend 未声明 supportsSessionRelease / 转录里
//     无 session.created（pre-spawn 形态）→ **零事件零副作用**（静默 no-op）。
//   - 有会话且能力在场 → 恰好一条事件：
//     run.upstream_session_deleted / _already_gone / _delete_skipped{reason} /
//     _delete_failed{reason[,code]}（outcome 映射与 runManager._releaseUpstreamSession
//     逐字相同——两处共享同一闭集语义，不共享代码：一侧在 Run 实例内存事实里，
//     一侧在验收服务的转录事实里，强行抽公共层会造出第三种调用形态）。
//   - best-effort：任何抛错由调用方吞掉，绝不影响验收决定本身的结果。
//   - 载荷绝无 token/上游回显文本（backend.releaseSession 的闭集结果保证）。
//
// 分层：application(1) → registry/transcript(core,2) 与 backends/factory(3) 均为
// 下向静态 import，无披露义务（layering.test.js 语义表）。

import { readRegistry } from "../registry.js";
import { backendFor } from "../backends/factory.js";

const RELEASE_FAILED_REASONS = Object.freeze([
  "bad_request", "timeout", "http_error", "upstream_rejected",
]);

/**
 * 从转录事件里取本 run 最后一条绑定的 session.created.backendSessionId。
 * 取 LAST-bound（与续接读取器的胜出规则同向）：线系子轮的 session.created
 * 记的就是线系共享会话 id，首条与末条同值；有分歧时以最后落盘者为准。
 * @param {Array<object>} events
 * @returns {string|null}
 */
export function sessionIdFromEvents(events) {
  if (!Array.isArray(events)) return null;
  let found = null;
  for (const e of events) {
    if (e && e.type === "session.created"
      && typeof e.backendSessionId === "string" && e.backendSessionId.length > 0) {
      found = e.backendSessionId;
    }
  }
  return found;
}

/**
 * 把 backend.releaseSession 的闭集结果映射为事件名+载荷（A1/A1b 共同语义）。
 * @param {string} sessionId
 * @param {{outcome:string, reason?:string, code?:number}|null} res
 * @returns {{type:string, payload:object}}
 */
export function releaseOutcomeEvent(sessionId, res) {
  if (res?.outcome === "deleted") {
    return { type: "run.upstream_session_deleted", payload: { backendSessionId: sessionId } };
  }
  if (res?.outcome === "already_gone") {
    return { type: "run.upstream_session_already_gone", payload: { backendSessionId: sessionId } };
  }
  if (res?.outcome === "skipped_busy") {
    return {
      type: "run.upstream_session_delete_skipped",
      payload: { backendSessionId: sessionId, reason: "busy" },
    };
  }
  const reason = RELEASE_FAILED_REASONS.includes(res?.reason) ? res.reason : "http_error";
  const payload = { backendSessionId: sessionId, reason };
  if (Number.isInteger(res?.code)) payload.code = res.code;
  return { type: "run.upstream_session_delete_failed", payload };
}

/**
 * 构造验收路径的会话释放函数（decideRunDelivery 的可选依赖）。
 * 返回 async ({ agentId, events, transcript }) => Promise<boolean>
 * ——true=恰写了一条事件；false=能力缺席/无会话的静默 no-op。
 *
 * @param {object} p
 * @param {string} p.registryPath - agents.json 路径（MCP/CLI 启动配置解析）
 * @param {Function} [p.readRegistryFn] - 测试注入
 * @param {Function} [p.backendForFn] - 测试注入（默认 backends/factory.backendFor）
 */
export function makeAcceptedSessionRelease({ registryPath, readRegistryFn, backendForFn }) {
  const _readRegistry = readRegistryFn ?? readRegistry;
  const _backendFor = backendForFn ?? backendFor;
  return async function acceptedSessionRelease({ agentId, events, transcript }) {
    if (typeof agentId !== "string" || agentId.length === 0 || agentId === "unknown") return false;
    const sessionId = sessionIdFromEvents(events);
    if (!sessionId) return false;
    let registry = null;
    try {
      registry = await _readRegistry(registryPath);
    } catch {
      return false; // 注册表读取故障 → 能力无从判定 → 静默 no-op（best-effort）。
    }
    let agent = null;
    try {
      agent = registry?.getAgent?.(agentId) ?? null;
    } catch {
      // 未知 agentId → 能力无从判定 → 静默 no-op（best-effort）。
      return false;
    }
    if (!agent) return false;
    const backend = _backendFor(agent);
    if (backend?.supportsSessionRelease !== true || typeof backend?.releaseSession !== "function") {
      return false;
    }
    const res = await backend.releaseSession(agent, sessionId);
    const { type, payload } = releaseOutcomeEvent(sessionId, res);
    await transcript.append(type, payload);
    return true;
  };
}
