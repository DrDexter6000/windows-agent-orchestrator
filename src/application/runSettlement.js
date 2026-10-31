// src/application/runSettlement.js
//
// 决定 0095：收口判定——一个应用层纯函数，CLI `runs wait --until-settled` 的
// 等待器与 MCP `run_delivery` 的有界等待共用。"收口"只保证：运行已终态；有交付
// 时，原始验证与最新 reverify 链都已有结果。它不表示验证通过、不表示 Lead 已
// 验收、也不表示 WAO 的收尾（会话中止核验、树释放）已完成。
//
// 分支顺序镜像 src/application/runDelivery.js 的 projectDeliveryReadiness
//（约 :220-264）：malformed → 交付已创建 → 打包失败 → 未请求交付 → 终态隔离/
// ambiguous。本模块不能 import runDelivery（runDelivery 反向 import 本模块做
// 等待判定，会成环），所以两个被两侧共用的纯谓词——交付请求意向与隔离违例
// 投影——的家在这里；runDelivery.js 再导出它们，既有消费者不改。
//
// Architectural contract:
//   - Pure: no I/O, no clock, no argv parsing, no console.log, no process.exit.
//   - Depends only on transcript.js projections + diagnosis.js closed sets.
//   - Never echoes a raw ref/commit/path — only closed-set labels.

import {
  findState,
  validateDeliveryFacts,
  projectReverifyChain,
  TERMINAL_STATES,
  hasReverifyFact,
} from "../transcript.js";
import { ISOLATION_VIOLATION_REASONS } from "../diagnosis.js";

// The settlement status closed set.
export const RUN_SETTLEMENT_STATUSES = Object.freeze([
  "settled",
  "unsettled",
  "undeterminable",
]);

// The reason closed set (grouped by status). Consumers switch on `reason` for
// the CLI settled line (e.g. packaging/isolation failure → runs diagnose).
export const RUN_SETTLEMENT_REASONS = Object.freeze([
  // unsettled
  "not_terminal",
  "verification_pending",
  "reverify_pending",
  // settled
  "no_delivery_requested",
  "packaging_failed",
  "isolation_failed",
  "delivery_settled",
  // undeterminable
  "invalid_snapshot",
  "delivery_facts_malformed",
  "reverify_malformed",
  "orphan_reverify_chain",
  "packaging_conflict",
  "terminal_delivery_ambiguous",
]);

// M12-13: the closed set of SAFE isolation-violation codes the projection
// accepts as delivery-readiness evidence (moved home — see header). Anything
// else (missing/non-string code, unknown value, multiple violations) is NOT
// evidence → ambiguous. Also consumed by run_await_result (isolationFailureCode).
export const SAFE_ISOLATION_VIOLATION_CODES = Object.freeze(["workdir_escape"]);

/**
 * M12-14: project the isolation-violation evidence for a run, including the
 * additive closed-set REASON (moved home — see header).
 *
 * Exactly ONE run-bound run.isolation_violation whose code (a top-level durable
 * fact — transcript append spreads event payloads flat, the same idiom as
 * deliveryCode / verificationStatus) is a member of the safe closed set →
 * { code, reason }. The reason is an exact ISOLATION_VIOLATION_REASONS member,
 * or null when the durable fact is historical (reason-absent) or malformed.
 * Zero bound violations → null. Multiple bound violations, or a single one with
 * a missing/malformed/non-safe code → "ambiguous" (fail closed).
 *
 * @param {object[]} events
 * @param {string} runId
 * @returns {{code: string, reason: string|null}|"ambiguous"|null}
 */
export function projectIsolationViolation(events, runId) {
  if (!Array.isArray(events)) return null;
  const bound = events.filter(
    (e) => e && e.type === "run.isolation_violation" && e.runId === runId,
  );
  if (bound.length === 0) return null;
  if (bound.length > 1) return "ambiguous";
  const code = bound[0].code;
  if (typeof code !== "string" || !SAFE_ISOLATION_VIOLATION_CODES.includes(code)) {
    return "ambiguous";
  }
  const reason = bound[0].reason;
  return {
    code,
    reason: typeof reason === "string" && ISOLATION_VIOLATION_REASONS.includes(reason)
      ? reason
      : null,
  };
}

/**
 * M12-13: project the isolation-violation CODE for a run (moved home — see
 * header). Delegates to projectIsolationViolation so code and reason
 * projections can never diverge on what counts as evidence.
 *
 * @param {object[]} events
 * @param {string} runId
 * @returns {string|null} safe code, "ambiguous", or null
 */
export function projectIsolationViolationCode(events, runId) {
  const violation = projectIsolationViolation(events, runId);
  return violation === "ambiguous" ? "ambiguous" : violation?.code ?? null;
}

/**
 * The runId-bound delivery-intent projection (moved home — see header): did the
 * Lead request a delivery for this run (a background submit that declared it, or
 * a run.started carrying a delivery contract)?
 *
 * @param {object[]} events
 * @param {string} runId
 * @returns {boolean}
 */
export function deliveryWasRequested(events, runId) {
  return events.some(
    (e) => e && e.runId === runId && (
      (e.type === "run.background_submitted" && e.deliveryRequested === true)
      || (
        e.type === "run.started"
        && e.delivery
        && typeof e.delivery.mode === "string"
        && e.delivery.mode.length > 0
      )
    ),
  );
}

function settlementResult(status, reason, facts) {
  return { status, reason, facts };
}

// 任何信封里的 reverify 事实——实现的家已随决定 0101 移入 src/transcript.js
//（"声明无可跑验证"谓词与之共用），这里照旧以同名导出，既有消费者
//（runDelivery 的 readiness 投影等）不改。
export { hasReverifyFact };

/**
 * 决定 0095：在同一份 transcript 快照上判定一个运行是否已收口。
 *
 * 输入是快照原始事件（runId 绑定口径与 runWait/runDelivery 相同：状态投影
 * 只看 `e.runId === runId` 的信封绑定事件；交付事实校验走 validateDeliveryFacts
 * 的 runId-bound pending-aware 模式）。输出 `{ status, reason, facts }`：
 *
 *   unsettled      — 运行未终态；或交付已创建但原始验证仍 pending（即使已有
 *                    拒收决定——验证中拒收是合法路径，验证结果仍要等）；或最新
 *                    reverify 链仍 pending。
 *   undeterminable — 交付事实 malformed；原始验证尚无结果却已有 reverify 事实；
 *                    reverify 链 malformed（它可能与 valid:true 共存）；孤立的
 *                    reverify 链（没有任何 delivery_created）；多个打包失败；终态后请求了交付却既无
 *                    delivery_created 也无 delivery_failed（ambiguous）。
 *   settled        — 其余一切：未请求交付；打包失败；隔离失败；交付的验证与
 *                    reverify 都已有结果。
 *
 * "settled" 不含"验证通过""Lead 已验收""WAO 收尾已完成"。
 *
 * @param {object[]} events — the transcript snapshot (raw, envelope-bearing)
 * @param {string} runId
 * @returns {{status: string, reason: string, facts: object}}
 */
export function determineRunSettlement(events, runId) {
  if (!Array.isArray(events)) {
    return settlementResult("undeterminable", "invalid_snapshot", {
      state: "unknown",
      terminal: false,
      deliveryRequested: false,
      verificationStatus: null,
      reverifyStatus: null,
      acceptanceStatus: null,
    });
  }
  // 与 runWait / runDelivery 同一绑定口径：状态投影只看绑定事件；全无信封的
  // legacy 快照过滤为零事件 → findState([]) = "pending"（不可归属永不投影终态）。
  const bound = events.filter((e) => e && e.runId === runId);
  const state = findState(bound);
  const terminal = TERMINAL_STATES.includes(state);

  const facts = validateDeliveryFacts(events, {
    expectedRunId: runId,
    allowVerificationPending: true,
  });
  const requested = deliveryWasRequested(events, runId);

  const baseFacts = {
    state,
    terminal,
    deliveryRequested: requested,
    verificationStatus: null,
    reverifyStatus: null,
    acceptanceStatus: null,
  };

  // 规则 1：未终态 → unsettled（同一形状在终态前是正常的等待打包/验证）。
  if (!terminal) {
    return settlementResult("unsettled", "not_terminal", baseFacts);
  }

  // 分支顺序镜像 projectDeliveryReadiness：malformed 先于一切。
  if (facts.code === "delivery_malformed") {
    return settlementResult("undeterminable", "delivery_facts_malformed", baseFacts);
  }

  // 交付已创建（pending-admitted valid，或 authority 未接纳但可读的 legacy
  // createdRef——两者读法都是"验证结果还没落地"）。
  if (facts.valid || facts.createdRef) {
    const createdFacts = {
      ...baseFacts,
      verificationStatus: facts.verificationStatus,
      // reverify 链完备时为其结果，否则同原始验证（validateDeliveryFacts 的口径）。
      effectiveVerificationStatus: facts.effectiveVerificationStatus ?? null,
      acceptanceStatus: facts.decisionEvent
        ? (facts.decisionEvent.type === "run.delivery_accepted" ? "accepted" : "rejected")
        : "pending",
    };
    // 原始验证仍 pending → unsettled；已拒收也要等验证结果（验证中拒收）。
    // 原始验证没有结果时，任何 reverify 事实都是断链：显式 pending 的 ref 已被
    // validateDeliveryFacts 判 malformed，没有状态的 legacy ref 不经这道检查就
    // 会走到这里，所以在这里补查。
    if (facts.verificationStatus === "pending") {
      if (hasReverifyFact(events)) {
        return settlementResult("undeterminable", "delivery_facts_malformed", createdFacts);
      }
      return settlementResult("unsettled", "verification_pending", createdFacts);
    }
    const reverify = projectReverifyChain(events, runId, facts.createdRef);
    const withReverify = {
      ...createdFacts,
      reverifyStatus: reverify.status,
    };
    if (reverify.status === "pending") {
      return settlementResult("unsettled", "reverify_pending", withReverify);
    }
    if (reverify.status === "malformed") {
      return settlementResult("undeterminable", "reverify_malformed", withReverify);
    }
    return settlementResult("settled", "delivery_settled", withReverify);
  }

  // 孤立 reverify 链：存在任何 reverify 事实却没有 delivery_created——断链，
  // 不论其余事实如何都不判收口（validateDeliveryFacts 在这一路给
  // reverifyStatus "none"，所以这里直接按事件类型检测）。
  if (hasReverifyFact(events)) {
    return settlementResult("undeterminable", "orphan_reverify_chain", baseFacts);
  }

  // 打包失败：恰好一条绑定 delivery_failed → settled；多条 → 冲突。
  const failed = events.filter(
    (e) => e && e.type === "run.delivery_failed" && e.runId === runId,
  );
  if (failed.length > 1) {
    return settlementResult("undeterminable", "packaging_conflict", baseFacts);
  }
  if (failed.length === 1) {
    return settlementResult("settled", "packaging_failed", baseFacts);
  }

  // 未请求交付 → settled。
  if (!requested) {
    return settlementResult("settled", "no_delivery_requested", baseFacts);
  }

  // 终态、请求了交付、既无 created 也无 failed：隔离失败是一种收口；其余
  //（含隔离证据 ambiguous、无证据的断链）都是 undeterminable。
  const isolationCode = projectIsolationViolationCode(events, runId);
  if (isolationCode === "workdir_escape") {
    return settlementResult("settled", "isolation_failed", baseFacts);
  }
  return settlementResult("undeterminable", "terminal_delivery_ambiguous", baseFacts);
}
