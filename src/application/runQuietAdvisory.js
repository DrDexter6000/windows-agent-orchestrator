// src/application/runQuietAdvisory.js
//
// 决定 0067 / 0068：控制面不替 Lead 放弃一个还在跑的运行，只把事实摆出来。
// "转录里多久没有新的动作或正文"这一事实只在这里推导（纯函数、零 I/O、转录零
// 写入）：CLI status 的 advisory 行、MCP run_status 的 leadAdvisory、run_wait /
// run_await_result 的 observation.transcript_quiet 语义注记共用它。
//
// "动作或正文"与 completed_empty 判定同一口径（runEventIsUsableEffect）；
// runtime_activity / thinking 只说明运行时还活着。陈述的是转录可见的事实：有的
// 后端到轮末才落正文，工具在途的输出也不进转录——"转录里没有"不等于 worker 没在
// 产出。
//
// Import discipline: transcript-shape helpers only. No src/commands/*, src/mcp/*,
// MCP SDK, or zod.

import { RUN_EVENT_KINDS, RUNTIME_ACTIVITY_STATUSES, runEventIsUsableEffect } from "../runEvent.js";
import { boundReportScope } from "../metrics.js";

// 多久没有新的动作/正文才附 Lead advisory。
export const LEAD_ADVISORY_QUIET_SECONDS = 30 * 60;

// 决定 0069（Owner 2026-10-13）：worker 有明显生命体征（任何一条 worker 事件，
// 含 runtime_activity）的这段时间内，建议不要随意中止。只是建议——stop 不因此
// 被拒，体征距今多久会记进 run.stop_requested。
export const VITAL_SIGN_RECENT_SECONDS = 10 * 60;

// MCP 面 leadAdvisory 的长度上界（模板 + 整数 + 闭集标签；schema 取同一常量）。
export const LEAD_ADVISORY_WIRE_MAX_LEN = 480;

/**
 * 距最近一次动作或正文过了多少秒。从未有过动作时从 run.submitted 起算；连
 * run.submitted 都没有（卡在 pending、从未派出去的运行——真实转录里有这种停了
 * 三周的孤儿）就从转录的第一条事件起算。
 *
 * @param {Array<object>} scopeEvents — 已绑定到请求 runId 的事件作用域
 * @param {number} nowMs
 * @returns {number|null} 无可用时间基准时为 null
 */
export function secondsSinceLastEffect(scopeEvents, nowMs) {
  let baseTs = null;
  for (let i = scopeEvents.length - 1; i >= 0; i -= 1) {
    const e = scopeEvents[i];
    if (e?.type === "run.event" && runEventIsUsableEffect(e)) {
      baseTs = e.ts;
      break;
    }
  }
  baseTs ??= scopeEvents.find((e) => e?.type === "run.submitted")?.ts
    ?? scopeEvents.find((e) => typeof e?.ts === "string")?.ts
    ?? null;
  if (baseTs === null || baseTs === undefined) return null;
  const base = new Date(baseTs).getTime();
  return Number.isFinite(base) ? Math.round((nowMs - base) / 1000) : null;
}

/**
 * 未到终态的运行，转录里是否已达到 advisory 门限没有新的动作或正文。
 * 绑定纪律与 run_status 相同（boundReportScope）。
 *
 * @param {Array<object>} events — 原始转录快照
 * @param {string} runId
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isTranscriptQuiet(events, runId, nowMs) {
  const scope = boundReportScope(events, runId) ?? events;
  const seconds = secondsSinceLastEffect(scope, nowMs);
  return seconds !== null && seconds >= LEAD_ADVISORY_QUIET_SECONDS;
}

/**
 * MCP 面的 advisory 文本：固定英文模板 + 整数 + 闭集标签，不含任何转录文本。
 * 闭集外的 kind / status 一律不回显。
 *
 * @param {object} facts
 * @param {number} facts.secondsSinceEffect
 * @param {string|null} [facts.lastActivityEventKind] — 最近一条 run.event 的 kind
 * @param {string|null} [facts.lastRuntimeStatus] — 该事件为 runtime_activity 时的 status
 * @param {number|null} [facts.secondsSinceActivity]
 * @returns {string}
 */
export function leadAdvisoryWireText({ secondsSinceEffect, lastActivityEventKind, lastRuntimeStatus, secondsSinceActivity }) {
  const kind = RUN_EVENT_KINDS.includes(lastActivityEventKind) ? lastActivityEventKind : null;
  const status = kind === "runtime_activity" && RUNTIME_ACTIVITY_STATUSES.includes(lastRuntimeStatus)
    ? `/${lastRuntimeStatus}`
    : "";
  const age = Number.isFinite(secondsSinceActivity) ? `, ${secondsSinceActivity}s ago` : "";
  const last = kind ? `${kind}${status}${age}` : "none";
  const recent = Number.isFinite(secondsSinceActivity) && secondsSinceActivity < VITAL_SIGN_RECENT_SECONDS
    ? `A vital sign was seen within the last ${VITAL_SIGN_RECENT_SECONDS / 60} min: WAO advises against stopping now without a specific reason. `
    : "";
  return `No new worker action or text in the transcript for ${Math.floor(secondsSinceEffect / 60)} min (last activity: ${last}). `
    + recent
    + "Whether to keep waiting is the Lead's decision. Before stopping: read run_activity, then run_stop with observedSeq and a reason.";
}
