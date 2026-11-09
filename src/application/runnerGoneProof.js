// src/application/runnerGoneProof.js
//
// TD-341（第 89 批 B）：runner 已不在的证明入口——收口等待器（runSettlementWait）、
// run_status（runStatus）与 lead_preflight（leadPreflight）共用，不复制。
//
// 三个成员：
//   1. proveRunnerGone —— 第 83 批 B 从 runSettlementWait.js 原样上移：以只读
//      干跑调 settleRun（apply:false），六道门全在 settleRun 里；eligible:true
//      即"非终态、owner 心跳不在、本机无 runner 进程、静默窗、会话形状、无活
//      daemon"全部成立。settleRun 自己重新解析并读取转录。daemon 握手读器由
//      调用面经 deps 注入（application 不 import daemon.js）——缺注入时
//      settleRun 响亮失败，调用方按探测失败处理：不构成死亡证明。
//   2. runnerGonePrefilter —— 证明之前的便宜前置筛选（非终态、owner 心跳不
//      新鲜、最后一条绑定事件已满结算静默窗）。任一不满足就不调证明——省掉注定
//      拒绝的干跑（进程扫描是最贵的一步）。口径与 runSettle 的门 1/门 2 心跳面/
//      门 4 同源；settleRun 的完整六道门仍是唯一权威，这里只做"值得探测吗"。
//      续修（Lead 审后）：不筛"有无后台派发"——settle 门 5 本就允许"有会话、
//      会话进程判 gone"的前台运行结算（只拒无会话且无 background_submitted 的
//      foreground_no_session），筛掉它会让等待器证明不了前台运行的 runner 已
//      不在。会话形状由门 5 权威判定，前置筛选不复制。
//   3. createRunnerGoneProofCache / probeRunnerGoneCached —— run_status 读面的
//      进程内节流：按 runId 缓存证明结果（键含转录最后 seq；seq 变化或心跳变
//      新鲜即失效；时长 RUNNER_GONE_PROOF_CACHE_TTL_MS）；同一 runId、同一 lastSeq
//      的并发调用共用一次在飞的证明。缓存实例由调用面（server 闭包）持有——application
//      层不存全局/持久状态。
//
// Architectural contract:
//   - No argv parsing, no console.log, no process.exit, no process.on.
//   - Does not import src/commands/*, src/mcp/*, MCP SDK, zod, or daemon.js.
//   - Depends on runSettle.js (settleRun + SETTLE_QUIET_WINDOW_MS)、
//     ownerLiveness.js（checkOwnerLiveness 现有读法）、transcript.js
//     （findState/TERMINAL_STATES/findLastEventSeq）。

import { findState, findLastEventSeq, TERMINAL_STATES } from "../transcript.js";
import { settleRun, SETTLE_QUIET_WINDOW_MS, lastQuietWindowBoundMs } from "./runSettle.js";
import { checkOwnerLiveness } from "./ownerLiveness.js";

/** 前置筛选的闭集不通过理由（映射 settle 的门 1/门 2 心跳面/门 4）。 */
export const RUNNER_GONE_PREFILTER_REASONS = Object.freeze([
  "terminal", // 已终态（settle 门 1）
  "no_events", // 转录快照不是事件数组（调用方形状错误——不证明）
  "owner_heartbeat_fresh", // owner 心跳新鲜（监督进程还在——settle 门 2 会拒）
  "quiet_window", // 最后一条绑定事件未满结算静默窗 / 读不出时刻（settle 门 4）
]);

/**
 * 证明（只读干跑 settleRun）。第 83 批 B 原样上移自 runSettlementWait.js，行为
 * 不变：eligible → gone；refused → 闭集理由。reasonText 只是 dry-run 的入参校验
 * 用的占位（结算决定仍归 Lead）。
 *
 * @param {object} input
 * @param {string} input.runId
 * @param {string} input.runDir
 * @param {object} input.deps — 与 settleRun 相同（daemon 读器必注入）
 * @returns {Promise<{gone:true}|{gone:false,refusal:string}>}
 */
export async function proveRunnerGone({ runId, runDir, deps }) {
  const result = await settleRun({
    runId,
    runDir,
    reasonText: "runner_gone proof (read-only dry-run from the settlement wait; settle only on an explicit Lead decision)",
    apply: false,
    deps,
  });
  return result.eligible === true
    ? { gone: true }
    : { gone: false, refusal: result.refused ?? "unknown" };
}

/**
 * 证明之前的便宜前置筛选（见模块头）。任一不满足即 {pass:false, reason}——
 * 调用方不发起证明。所有判定都只读；心跳读法复用 ownerLiveness 的现有读器
 * （deps.heartbeatReader 注入缝，缺省 checkOwnerLiveness）。会话形状不筛
 * （settle 门 5 权威——前台运行有会话同样可证）。
 *
 * @param {object} input
 * @param {object[]} input.events — 转录快照（全量；内部过滤绑定事件）
 * @param {string} input.runId
 * @param {string} input.runDir
 * @param {number} input.now — epoch ms
 * @param {object} [input.deps] — { heartbeatReader }（缺省 checkOwnerLiveness）
 * @returns {{pass:true, quietMs:number}|{pass:false, reason:string}}
 *   quietMs = 最后一条计入静默窗的绑定事件距今毫秒（通过时 ≥ SETTLE_QUIET_WINDOW_MS，供
 *   模板取整数分钟）。
 */
export function runnerGonePrefilter({ events, runId, runDir, now, deps = {} }) {
  if (!Array.isArray(events)) return { pass: false, reason: "no_events" };
  const bound = events.filter((e) => e && e.runId === runId);
  // 门 1 面：已知非终态。
  const state = findState(bound);
  if (TERMINAL_STATES.includes(state)) return { pass: false, reason: "terminal" };
  // 门 2 心跳面：owner 心跳新鲜 → 监督进程还在，不值得探测。
  const heartbeatReader = typeof deps.heartbeatReader === "function" ? deps.heartbeatReader : checkOwnerLiveness;
  try {
    if (heartbeatReader(runDir, runId, now).fresh) {
      return { pass: false, reason: "owner_heartbeat_fresh" };
    }
  } catch {
    // 心跳读失败按"不新鲜"处理（settle 门 2 自有更细的租约判定；这里只是省干跑）。
  }
  // 门 4 面：最后一条计入静默窗的绑定事件（与 settle 门 4 同一取法——被拒的
  // 重打包审计不算活动，见 lastQuietWindowBoundMs）已满结算静默窗。
  const lastTs = lastQuietWindowBoundMs(bound);
  const quietMs = Number.isFinite(lastTs) ? now - lastTs : NaN;
  if (!Number.isFinite(quietMs) || quietMs < SETTLE_QUIET_WINDOW_MS) {
    return { pass: false, reason: "quiet_window" };
  }
  // 会话形状（有会话须进程判 gone；无会话须有 background_submitted）不在这里筛
  // ——settle 门 5 是权威，前置筛选不复制其判定（续修：筛了会让前台运行证明不了）。
  return { pass: true, quietMs };
}

/** run_status 读面的证明结果缓存时长（进程内节流；键含转录最后 seq）。 */
export const RUNNER_GONE_PROOF_CACHE_TTL_MS = 60_000;

/**
 * 证明结果的进程内缓存 + 在飞共用。实例由调用面持有（server 闭包 / CLI 单次
 * 调用可不持有）；本工厂不做任何 I/O。get(runId, {now, lastSeq}) 只在条目未过
 * TTL 且 seq 未变时命中；心跳变新鲜由前置筛选在缓存之前挡下（不在此处重复）。
 * 在飞条目**只在发起时的 lastSeq 相同时共用**（二轮续修 5）：第二个调用带着更新
 * 的快照（seq 已变）加入时，共用旧 seq 的结果会把过时事实面当成当前——各发各的
 * 证明。
 *
 * @returns {{get:Function, set:Function, getInflight:Function, setInflight:Function}}
 */
export function createRunnerGoneProofCache() {
  const entries = new Map(); // runId → { gone, lastSeq, at }
  const inflight = new Map(); // runId → { lastSeq, promise }
  return {
    get(runId, { now, lastSeq }) {
      const entry = entries.get(runId);
      if (!entry) return null;
      if (now - entry.at >= RUNNER_GONE_PROOF_CACHE_TTL_MS) return null;
      if (entry.lastSeq !== lastSeq) return null; // 转录长过：事实面可能已变
      return { gone: entry.gone };
    },
    set(runId, { gone, now, lastSeq }) {
      entries.set(runId, { gone, lastSeq, at: now });
    },
    getInflight(runId, lastSeq) {
      const entry = inflight.get(runId);
      return entry && entry.lastSeq === lastSeq ? entry.promise : null;
    },
    setInflight(runId, lastSeq, promise) {
      const entry = { lastSeq, promise };
      inflight.set(runId, entry);
      promise.finally(() => {
        if (inflight.get(runId) === entry) inflight.delete(runId);
      }).catch(() => {});
    },
  };
}

/**
 * 前置筛选 + 缓存 + 在飞共用 + 证明的组合读面（run_status / preflight 候选共用）：
 *   1. 前置筛选不过 → { gone:false, prefilter }（不碰缓存、不发证明）；
 *   2. 缓存命中（未过 TTL 且 seq 未变）→ 直接返回；
 *   3. 有同一 lastSeq 的在飞证明 → 共用同一次（seq 不同各发各的）；
 *   4. 否则发证明（proveFn 可注入），结果进缓存后返回。
 * 证明抛错按"探测失败"处理：gone:false，不缓存（下一次读面可重试）。
 *
 * @param {object} input
 * @param {string} input.runId
 * @param {string} input.runDir
 * @param {object[]} input.events — 转录快照（前置筛选用）
 * @param {object} [input.cache] — createRunnerGoneProofCache() 实例（缺省不缓存）
 * @param {object} input.deps — 证明 deps（daemon 读器必注入）+ 可选 heartbeatReader
 * @param {Function} [input.proveFn] — 证明注入缝（缺省 proveRunnerGone）
 * @param {Function} [input.nowFn] — 缺省 Date.now
 * @returns {Promise<{gone:boolean, prefilter?:string, quietMs?:number}>}
 */
export async function probeRunnerGoneCached({
  runId,
  runDir,
  events,
  cache = null,
  deps,
  proveFn = proveRunnerGone,
  nowFn = Date.now,
}) {
  const now = nowFn();
  const pre = runnerGonePrefilter({ events, runId, runDir, now, deps });
  if (!pre.pass) return { gone: false, prefilter: pre.reason };
  const lastSeq = findLastEventSeq(events);
  if (cache) {
    const hit = cache.get(runId, { now, lastSeq });
    if (hit) return { gone: hit.gone, quietMs: pre.quietMs };
    // 在飞共用只在同一 lastSeq 时成立（二轮续修 5）：seq 已变的快照各发各的证明。
    const inflightProof = cache.getInflight(runId, lastSeq);
    if (inflightProof) {
      try {
        return { gone: await inflightProof, quietMs: pre.quietMs };
      } catch {
        return { gone: false, probeFailed: true, quietMs: pre.quietMs };
      }
    }
  }
  const proofPromise = (async () => {
    const proof = await proveFn({ runId, runDir, deps });
    if (cache) cache.set(runId, { gone: proof.gone, now: nowFn(), lastSeq });
    return proof.gone;
  })();
  if (cache) cache.setInflight(runId, lastSeq, proofPromise);
  try {
    return { gone: await proofPromise, quietMs: pre.quietMs };
  } catch {
    return { gone: false, probeFailed: true, quietMs: pre.quietMs };
  }
}
