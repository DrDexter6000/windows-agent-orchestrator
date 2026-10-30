// src/application/runNextStep.js
//
// 决定 0095：`nextStep`——等待族工具没等到收口时的一句固定英文模板，按面渲染
//（MCP 只写 MCP 工具名、不含 runId；CLI 写 CLI 命令、带 runId）。它是新字段，
// 不复用 run_status 的 leadAdvisory（那是"静默 30 分钟"的含义），也不进只陈述
// 事实的 semanticNotes。
//
// 措辞纪律：只说"signs of life were last observed N min ago" / "no new signs of
// life in the transcript for N min"，不断言 worker 在推进或已停；不出现宿主名；
// 不建议 accept/reject。长度上限引用 LEAD_ADVISORY_WIRE_MAX_LEN（同值 480），
// 超限抛错（测试钉住）——模板是静态的，超限只可能来自实现错误。
//
// Architectural contract: pure, no I/O, no clock (age 由调用方传入毫秒), no
// src/commands/*, src/mcp/*, MCP SDK, or zod.

import {
  VITAL_SIGN_RECENT_SECONDS,
  LEAD_ADVISORY_QUIET_SECONDS,
  LEAD_ADVISORY_WIRE_MAX_LEN,
} from "./runQuietAdvisory.js";

export const NEXT_STEP_MAX_LEN = LEAD_ADVISORY_WIRE_MAX_LEN;

export const NEXT_STEP_SURFACES = Object.freeze(["mcp", "cli"]);

// 情形闭集。等待类五支（wait_*）由 runWaitNextStep 按终态与体征年龄自动选；
// delivery_unsettled 是 run_delivery 带 waitMs 到期未收口；dispatch_accepted
// 是派发/续跑受理了后台运行；settled_line 是 CLI --until-settled 的收口终行
//（按 settlementReason 再分四支）。
export const NEXT_STEP_SITUATIONS = Object.freeze([
  "wait_vital_recent",
  "wait_vital_ageing",
  "wait_vital_quiet",
  "wait_vital_unobservable",
  "wait_terminal",
  "delivery_unsettled",
  "dispatch_accepted",
  "settled_line",
]);

function minutesFromMs(ageMs) {
  return Math.floor(ageMs / 60000);
}

function render(surface, situation, runId, extras) {
  const m = minutesFromMs(extras.vitalSignAgeMs ?? 0);
  let text;
  switch (situation) {
    case "wait_vital_recent":
      text = surface === "mcp"
        ? `Signs of life were last observed ${m} min ago. Call run_wait again (choose waitMs within the host's tool-call timeout) before ending the turn.`
        : `Signs of life were last observed ${m} min ago. Before ending the turn, attach: wao runs wait ${runId} --until-settled (in the background if your host notifies you when background commands finish, otherwise in the foreground).`;
      break;
    case "wait_vital_ageing":
      text = surface === "mcp"
        ? `Signs of life were last observed ${m} min ago. The worker may be inside a long-running command. Call run_wait again (choose waitMs within the host's tool-call timeout); read run_activity if you need detail.`
        : `Signs of life were last observed ${m} min ago. The worker may be inside a long-running command. Run: wao runs wait ${runId} --until-settled; use wao status ${runId} if you need detail.`;
      break;
    case "wait_vital_quiet":
      text = surface === "mcp"
        ? `No new signs of life in the transcript for ${m} min. Read run_activity and run_diagnose first; the run has not been stopped. run_stop is only for an explicit Lead decision.`
        : `No new signs of life in the transcript for ${m} min. Check wao status ${runId} and wao runs diagnose ${runId} first; the run has not been stopped. The exits are wao runs settle and wao stop — only on an explicit Lead decision.`;
      break;
    case "wait_vital_unobservable":
      text = surface === "mcp"
        ? "Vital-sign age is not observable on this snapshot. Re-read with run_status before deciding anything."
        : `Vital-sign age is not observable on this snapshot. Re-read with wao status ${runId} before deciding anything.`;
      break;
    case "wait_terminal":
      text = surface === "mcp"
        ? "Terminal state reached. If a delivery was requested, call run_delivery with an explicit waitMs (e.g. 45000) to wait for settlement, then review."
        : `Terminal state reached. Wait to settlement with wao runs wait ${runId} --until-settled, or inspect the delivery with wao runs delivery ${runId}.`;
      break;
    case "delivery_unsettled":
      text = surface === "mcp"
        ? "Delivery is not settled yet: the run, its packaging, verification or a reverify chain still has no result. Call run_delivery again with waitMs to keep waiting. Verification passed is not acceptance."
        : `Delivery is not settled yet: the run, its packaging, verification or a reverify chain still has no result. Wait with wao runs wait ${runId} --until-settled. Verification passed is not acceptance.`;
      break;
    case "dispatch_accepted":
      text = surface === "mcp"
        ? "Background run accepted. Before ending the turn, keep a wait attached: call run_wait repeatedly on this run until it settles."
        : `Background run accepted. Before ending the turn, keep a wait attached: wao runs wait ${runId} --until-settled.`;
      break;
    case "settled_line": {
      // CLI 等待器的收口终行（按收口判定的 reason 闭集分支）。
      switch (extras.settlementReason) {
        case "delivery_settled":
          text = extras.acceptanceStatus === "accepted" || extras.acceptanceStatus === "rejected"
            ? `Settled. The Lead decision is recorded: ${extras.acceptanceStatus}. Verification passed is not acceptance.`
            : `Settled. Delivery awaits the Lead's review: wao runs delivery ${runId}. Verification passed is not acceptance.`;
          break;
        case "packaging_failed":
          text = `Settled: packaging failed. Diagnose with wao runs diagnose ${runId}. Verification passed is not acceptance.`;
          break;
        case "isolation_failed":
          text = `Settled: isolation failed (workdir_escape). Diagnose with wao runs diagnose ${runId}. Verification passed is not acceptance.`;
          break;
        case "no_delivery_requested":
          text = `Settled. No delivery was requested; collect the result with wao collect ${runId}. Verification passed is not acceptance.`;
          break;
        default:
          throw new Error(`buildNextStep: settled_line needs a settled settlementReason, got: ${JSON.stringify(extras.settlementReason)}`);
      }
      break;
    }
    default:
      throw new Error(`buildNextStep: unknown situation: ${JSON.stringify(situation)}`);
  }
  if (text.length > NEXT_STEP_MAX_LEN) {
    throw new Error(`buildNextStep: nextStep exceeds ${NEXT_STEP_MAX_LEN} chars (${text.length}): ${situation}/${surface}`);
  }
  return text;
}

/**
 * 构造一句 nextStep。surface "cli" 必须给 runId（模板带 runId）；"mcp" 的模板
 * 不含 runId（传了也不会渲染）。settled_line 需要 settlementReason（收口判定
 * 的 settled 类 reason）与可选 acceptanceStatus。长度超上限抛错。
 *
 * @param {object} input
 * @param {"mcp"|"cli"} input.surface
 * @param {string} input.situation — NEXT_STEP_SITUATIONS 成员
 * @param {string} [input.runId]
 * @param {number|null} [input.vitalSignAgeMs] — 毫秒（vitalSignAgeMs 共享函数的输出）
 * @param {string|null} [input.settlementReason]
 * @param {string|null} [input.acceptanceStatus]
 * @returns {string}
 */
export function buildNextStep({ surface, situation, runId = null, vitalSignAgeMs = null, settlementReason = null, acceptanceStatus = null }) {
  if (!NEXT_STEP_SURFACES.includes(surface)) {
    throw new Error(`buildNextStep: surface must be "mcp" or "cli", got: ${JSON.stringify(surface)}`);
  }
  if (!NEXT_STEP_SITUATIONS.includes(situation)) {
    throw new Error(`buildNextStep: unknown situation: ${JSON.stringify(situation)}`);
  }
  if (surface === "cli" && (typeof runId !== "string" || runId.length === 0)) {
    throw new Error(`buildNextStep: surface "cli" renders commands with a runId, got: ${JSON.stringify(runId)}`);
  }
  if (vitalSignAgeMs !== null && !Number.isFinite(vitalSignAgeMs)) {
    vitalSignAgeMs = null;
  }
  return render(surface, situation, runId, { vitalSignAgeMs, settlementReason, acceptanceStatus });
}

/**
 * 等待族（run_wait / runs wait）的 nextStep：按终态与体征年龄自动选支。
 * 阈值直接引用 runQuietAdvisory 的两个常量（10 分钟 / 30 分钟），毫秒直比，
 * 不预取整——恰好 10 分钟不算 recent（同 runStatus 的 < 口径），恰好 30 分钟
 * 已算 quiet（同 advisory 的 >= 口径）。
 *
 * @param {object} input
 * @param {"mcp"|"cli"} input.surface
 * @param {boolean} input.terminal
 * @param {number|null} input.vitalSignAgeMs
 * @param {string} [input.runId]
 * @returns {string}
 */
export function runWaitNextStep({ surface, terminal, vitalSignAgeMs, runId }) {
  if (terminal) {
    return buildNextStep({ surface, situation: "wait_terminal", runId });
  }
  if (vitalSignAgeMs === null || !Number.isFinite(vitalSignAgeMs)) {
    return buildNextStep({ surface, situation: "wait_vital_unobservable", runId });
  }
  if (vitalSignAgeMs < VITAL_SIGN_RECENT_SECONDS * 1000) {
    return buildNextStep({ surface, situation: "wait_vital_recent", runId, vitalSignAgeMs });
  }
  if (vitalSignAgeMs < LEAD_ADVISORY_QUIET_SECONDS * 1000) {
    return buildNextStep({ surface, situation: "wait_vital_ageing", runId, vitalSignAgeMs });
  }
  return buildNextStep({ surface, situation: "wait_vital_quiet", runId, vitalSignAgeMs });
}
