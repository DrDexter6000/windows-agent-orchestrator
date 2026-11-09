// src/application/runQuietAdvisory.js
//
// 决定 0067 / 0068：控制面不替 Lead 放弃一个还在跑的运行，只把事实摆出来。
// "转录里多久没有新的动作或正文"这一事实只在这里推导（纯函数、零 I/O、转录零
// 写入）：CLI status 的 advisory 行、MCP run_status 的 leadAdvisory、run_wait /
// run_await_result 的 observation.transcript_quiet 语义注记共用它。
// TD-341（第 89 批 C）：runner 已被证明不在时的 advisory 双语模板同在本模块
//（runnerGoneAdvisoryText / runnerGoneAdvisoryWireText）——advisory 文本单一 SSOT。
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
 * 决定 0095：作用域内最后一条 worker `run.event`（含 runtime_activity）距今
 * 多少毫秒。口径同 runStatus 的心跳（决定 0069），未来时间钳成 0（同 runStop
 * 的事实侧）；时间戳读不出/非有限 → null（"无法观测"）。调用方比较阈值时直接
 * 用毫秒，不先取整。
 *
 * @param {Array<object>} scopeEvents — 已绑定到请求 runId 的事件作用域
 * @param {number} nowMs
 * @returns {number|null} 年龄毫秒数；无法观测时 null
 */
export function vitalSignAgeMs(scopeEvents, nowMs) {
  if (!Number.isFinite(nowMs)) return null;
  let baseTs = null;
  for (let i = scopeEvents.length - 1; i >= 0; i -= 1) {
    const e = scopeEvents[i];
    if (e?.type === "run.event") {
      baseTs = e.ts;
      break;
    }
  }
  if (baseTs === null || baseTs === undefined) return null;
  const base = new Date(baseTs).getTime();
  if (!Number.isFinite(base)) return null;
  return Math.max(0, nowMs - base);
}

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

/**
 * TD-341（第 89 批 C）：runner 已被证明不在时的 advisory 文本（MCP 面固定英文
 * 模板 + 整数；CLI 面对应中文）。口径与决定 0068 同族：固定模板 + 整数 + 闭集
 * 标签，不含 stderr、异常消息或任何自由文本。**不说"转录永不再前进"**——
 * settle、resume 都能合法追加；说的是"观察时没有 WAO 进程能继续驱动它"。
 * 是否结算由 Lead 决定，出口指明先干跑、再加 --apply。
 *
 * 英文模板（wire；runId 以 <id> 占位符出现——模板整体逐字节固定）。
 *
 * @param {object} facts
 * @param {number} facts.quietMinutes — 静默已满的整数分钟（≥ 结算静默窗）
 * @returns {string}
 */
export function runnerGoneAdvisoryWireText({ quietMinutes }) {
  const minutes = Math.max(0, Math.floor(quietMinutes));
  return `At observation time no WAO process can still drive this run (owner heartbeat gone, no runner process on this machine, transcript quiet for ${minutes} min). `
    + "Continued waiting will not settle it on its own. Whether to settle is the Lead's decision: "
    + "first dry-run wao runs settle --run-id <id> --reason-file <file>, then add --apply.";
}

/**
 * 同一条 advisory 的 CLI 面（中文固定模板；命令带实际 runId，与既有安静
 * advisory 的 `wao stop ${runId}` 写法同款）。
 *
 * @param {object} facts
 * @param {string} facts.runId
 * @param {number} facts.quietMinutes
 * @returns {string}
 */
export function runnerGoneAdvisoryText({ runId, quietMinutes }) {
  const minutes = Math.max(0, Math.floor(quietMinutes));
  return `观察时没有 WAO 进程能继续驱动这个运行（owner 心跳已不在、本机无 runner 进程、转录静默已满 ${minutes} 分钟），继续等待不会自行收口。`
    + `是否结算由 Lead 决定：先干跑 wao runs settle --run-id ${runId} --reason-file <文件>，确认后再加 --apply。`;
}
