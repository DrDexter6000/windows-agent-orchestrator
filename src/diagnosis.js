// diagnosis.js
//
// M8-3：故障诊断（🔵 工具起草域——给证据，不给处方）。
//
// 设计铁律：diagnoseFailure 只输出【事实证据】，绝不输出【建议/处方】。
// 处方权（retry/换 worker/接管/放弃）全在 Lead。这是用户理念的核心：
//   "诊断可以工具辅助，但应对策略、下一步做什么由 Lead 实机判断，保留灵活性。"
//
// 实现上，返回结构只有 { category, code, evidence }，没有 recommendation 字段；
// 所有 fact 字符串只陈述发生了什么，不陈述"该做什么"。
// code 是少数诊断类别专属的可空闭集事实码；它永不给处方，也不回显原文。
//
// 完整分类（按优先级归类；信号不足归 unknown，不强归类）：
//   provider_auth               — 401/身份验证失败/unauthor/auth fail；
//                                 M12-6 FR-02 起含 entitlement 拒绝（subscription
//                                 access disabled / org policy denied / API key missing）
//   provider_capacity           — terminal provider rate limit / quota exhausted
//   config_conflict             — 配置层冲突（API key 与登录打架等）
//   timeout                     — run.timed_out 事件
//   budget                      — run.state_change reason:budget_exceeded
//   scorecard_fail              — run.error phase:scorecard / scorecard.checked passed:false（且未 completed）
//   evidence_passed_backend_failed — backend 崩了但证据通过（需人工确认）
//   provider_disconnect         — worker 活跃工作后静默≥120s exit≠0（provider 流式中断，非真崩）
//   no_effect                   — worker 有活动但无产出（无 file_written + 无 command exit0）
//   crash                       — run.error phase:spawn/spawn_fail / 进程异常退出
//   aborted_manual              — run.aborted 事件
//   unknown                     — 有失败终态但无明确信号
//   none                        — 成功 run（无失败终态，无需诊断）
//
// 只读：本函数不接收也不返回可变状态，不改 transcript。

import { findState, TERMINAL_STATES, STATE_CHANGE_REASON } from "./transcript.js";
import { boundReportScope } from "./metrics.js";
import { assessRunEvidence } from "./runEvidenceAssessment.js";

/**
 * Frozen category enum SSOT — the complete set of diagnosis categories.
 * MCP output schema uses this to avoid a second hand-maintained list.
 */
export const DIAGNOSIS_CATEGORIES = Object.freeze([
  "provider_auth",
  "provider_capacity",
  "config_conflict",
  "timeout",
  "budget",
  "scorecard_fail",
  "evidence_passed_backend_failed",
  "provider_disconnect",
  "no_effect",
  "crash",
  "aborted_manual",
  "workdir_escape",
  "delivery_packaging_failed",
  "unknown",
  "none",
]);

// M12-6 FR-02: safe closed-set provider diagnosis codes (nullable on the wire).
// Derived from transcript-visible provider access denial FACTS only — a code
// labels the denial, it never echoes the raw error message/path/command/key.
// `unauthorized` is the fallback for plain 401/身份验证/unauthor matches that
// carry no more specific denial token.
export const PROVIDER_DIAGNOSIS_CODES = Object.freeze([
  "subscription_access_disabled",
  "organization_policy_denied",
  "api_key_missing",
  "unauthorized",
  "invalid_credential",
]);

// M12-24: terminal provider-capacity facts. Credentials and entitlement may be
// valid while the current provider account is rate-limited or out of quota.
// Informational runtime rate-limit events are not consumed here; only a failed
// run with a persisted run.error can carry one of these safe labels.
export const PROVIDER_CAPACITY_DIAGNOSIS_CODES = Object.freeze([
  "rate_limited",
  "quota_exhausted",
]);

// M12-21: completed-empty truth — the closed-set machine fact that labels a
// backend COMPLETION which produced no usable model effect. Distinct from the
// failed no_effect path: this is a successful completion (state=completed,
// exit 0 / parser-done(completed)) that did no model work. Per the Lead M12-21
// correction the wire and the kernel share ONE truth: run_diagnose and
// run_await_result project (category=no_effect, code=completed_empty) through
// the unified DIAGNOSIS_CODES SSOT + isValidDiagnosisCode pair check below, so
// a Lead sees completed_empty directly — never as a raw provider payload.
export const NO_EFFECT_DIAGNOSIS_CODES = Object.freeze([
  "completed_empty",
]);

// ONE general diagnosis-code SSOT. It derives the provider-auth,
// provider-capacity, and completed-empty code sets without merging their
// category meanings. MCP wire schemas derive their enum from this set.
export const DIAGNOSIS_CODES = Object.freeze([
  ...PROVIDER_DIAGNOSIS_CODES,
  ...PROVIDER_CAPACITY_DIAGNOSIS_CODES,
  ...NO_EFFECT_DIAGNOSIS_CODES,
]);

// Valid (category → code) pairs. Each coded category owns its exact code set;
// every other category has no code.
// This is the single authority for both the kernel projection and the wire
// projections, enforcing the pair discipline the Lead contract requires.
const CATEGORY_CODE_SETS = Object.freeze({
  provider_auth: PROVIDER_DIAGNOSIS_CODES,
  provider_capacity: PROVIDER_CAPACITY_DIAGNOSIS_CODES,
  no_effect: NO_EFFECT_DIAGNOSIS_CODES,
});

/**
 * Is (category, code) a valid diagnosis-code pair? An exact member of the
 * category's closed code set; anything else (wrong category, unknown/absent/
 * attacker-controlled code) is invalid → the caller fails closed to null.
 * @param {unknown} category
 * @param {unknown} code
 * @returns {boolean}
 */
export function isValidDiagnosisCode(category, code) {
  if (typeof category !== "string" || typeof code !== "string") return false;
  const set = CATEGORY_CODE_SETS[category];
  return Array.isArray(set) && set.includes(code);
}

// M12-14: the frozen closed-set SSOT of isolation-violation REASONS — WHY the
// delivery containment gate fired. The compat code stays "workdir_escape"; the
// additive reason distinguishes a confirmed outside path (lexical / physical)
// from a missing/duplicate/pending/unconfirmed write correlation and from an
// unresolvable physical path. Produced ONLY by runManager's delivery
// containment gate; consumed by the delivery/await projections and this
// module's fact wording. This module is the single home because it must stay
// import-pure (the observation projector's architectural contract) while both
// the write side (runManager) and the read side (runDelivery/runAwaitResult/
// MCP schema) need the one set — every consumer imports it from HERE.
export const ISOLATION_VIOLATION_REASONS = Object.freeze([
  // write_intent (pre-write telemetry)
  "write_intent_lexical_outside", // reported intent path is lexically not contained
  "write_intent_physical_outside", // intent resolves (junction/link) outside the worktree
  "write_intent_physical_unresolved", // physical location of the intent cannot be proven
  "write_intent_missing_tool_call_id", // no correlatable tool call id
  "write_intent_duplicate_tool_call_id", // tool call id already has an open write
  "write_intent_pending_limit", // pending write-intent cap reached
  "write_intent_pending_at_completion", // tracked write still unconfirmed at done
  "write_intent_correlation_unconfirmed", // unrecognized correlation state (fail closed)
  // file_written (post-write evidence)
  "file_written_lexical_outside", // reported write path is lexically not contained
  "file_written_physical_outside", // write resolves (junction/link) outside the worktree
  "file_written_physical_unresolved", // physical location of the write cannot be proven
]);

// Static fact wording per reason. Correlation and physical-unresolved facts
// must NEVER claim "outside" — they state a confirmation failure, not an
// escape. A historical (reason-absent) or malformed reason maps to the
// generic fact, which also never invents "outside". No dynamic content ever
// enters these strings.
const ISOLATION_VIOLATION_FACTS = Object.freeze({
  write_intent_lexical_outside: "worker reported an intended write path outside the authorized delivery worktree",
  write_intent_physical_outside: "worker reported an intended write path that physically resolves outside the authorized delivery worktree",
  write_intent_physical_unresolved: "the physical location of an intended write path could not be confirmed inside the authorized delivery worktree",
  write_intent_missing_tool_call_id: "a write intent had no correlatable tool call id, so the write could not be confirmed",
  write_intent_duplicate_tool_call_id: "a write intent reused a tool call id, so the write could not be confirmed",
  write_intent_pending_limit: "the pending write-intent cap was reached, so the write could not be confirmed",
  write_intent_pending_at_completion: "a write intent was still unconfirmed when the worker reported completion",
  write_intent_correlation_unconfirmed: "a write intent's correlation state was not confirmable, so the write could not be confirmed",
  file_written_lexical_outside: "worker reported a file write outside the authorized delivery worktree",
  file_written_physical_outside: "worker reported a file write that physically resolves outside the authorized delivery worktree",
  file_written_physical_unresolved: "the physical location of a reported file write could not be confirmed inside the authorized delivery worktree",
});
const ISOLATION_VIOLATION_FACT_UNKNOWN =
  "the delivery containment gate rejected a reported write (no trusted reason recorded)";

/**
 * Project the safe fact wording for an isolation violation's persisted reason.
 * Only an exact closed-set member selects its wording; anything else (absent,
 * non-string, unknown value) falls back to the generic no-"outside" fact.
 * @param {unknown} reason
 * @returns {string}
 */
function factForIsolationViolation(reason) {
  return typeof reason === "string" && Object.hasOwn(ISOLATION_VIOLATION_FACTS, reason)
    ? ISOLATION_VIOLATION_FACTS[reason]
    : ISOLATION_VIOLATION_FACT_UNKNOWN;
}

// Provider access denial facts that classify as provider_auth even when they
// contain no AUTH_SIGNAL token. The production fact "Your organization has
// disabled Claude subscription access for Claude Code ..." contains neither
// AUTH_SIGNAL nor CONFIG_CONFLICT_SIGNAL tokens — without these signals it
// falls through to no_effect, which misreads a real entitlement denial as
// "worker did nothing". Ordered: the FIRST matching signal wins.
const PROVIDER_DENIAL_SIGNALS = Object.freeze([
  { code: "subscription_access_disabled", re: /organization has disabled.{0,80}subscription access|subscription access.{0,40}disabled/i },
  { code: "organization_policy_denied", re: /organization.{0,60}policy.{0,60}(denied|disabled|blocked|does not allow)|policy.{0,40}(denied|blocked|disabled)/i },
  { code: "api_key_missing", re: /missing.{0,60}api[_\s-]?key|api[_\s-]?key.{0,40}(missing|not (set|found|configured|present)|absent)|(no|without) (api[_\s-]?key|credential)/i },
  { code: "invalid_credential", re: /invalid.{0,24}(api[_\s-]?key|credential|key|token)|(api[_\s-]?key|credential|key|token).{0,24}(invalid|incorrect|wrong)/i },
]);

/**
 * Derive the closed-set code for a provider_auth error. Falls back to
 * "unauthorized" for plain 401/身份验证/unauthor matches without a more
 * specific denial token.
 * @param {string} error - run.error text (never echoed back raw).
 * @returns {string} code ∈ PROVIDER_DIAGNOSIS_CODES
 */
function classifyProviderAuthCode(error) {
  for (const s of PROVIDER_DENIAL_SIGNALS) {
    if (s.re.test(error)) return s.code;
  }
  return "unauthorized";
}

// 真正的认证失败：HTTP 401 / 身份验证失败 / unauthorized / 无效 key。
// C2 收紧：去掉宽泛的 "auth.*fail"/裸 "api_key"（会把配置冲突误判为 provider_auth）。
// 真实 401 样本含 "401"/"unauthorized"/"身份验证失败"；配置冲突含 "precedence"/"connectors"。
const AUTH_SIGNAL = /401|身份验证|unauthor|invalid.{0,12}(api[_\s-]?key|key)/i;

// 配置冲突（C2 新增）：API key 与 claude.ai 登录打架等配置层问题。
// 真实例："connectors are disabled because ANTHROPIC_API_KEY...takes precedence"。
// 这不是 401 认证失败，是配置层冲突——归类不同，Lead 处置方式不同。
const CONFIG_CONFLICT_SIGNAL = /precedence|connectors.{0,30}disabled|auth source/i;

// M12-24: capacity matching is intentionally narrow and terminal-only at the
// call site. Local filesystem/cgroup/memory limits are not provider capacity,
// and a bare 429 may be a source line/count rather than an HTTP status.
const QUOTA_EXHAUSTED_SIGNAL = /quota.{0,40}(exhausted|exceeded|depleted|reached)|(?:usage|spending).{0,40}(?:upper\s+)?limit.{0,30}(exceeded|reached|hit)|hit.{0,40}(?:\d+[- ]?hour|usage|message|token).{0,30}limit|(?:\d+[- ]?hour|usage|message|token).{0,40}limit.{0,30}(?:reached|resets?)/i;
const LOCAL_RESOURCE_LIMIT_SIGNAL = /\b(?:disk|filesystem|file system|storage|cgroup|cpu|memory)\b.{0,40}\b(?:quota|usage|limit)\b|\b(?:quota|usage|limit)\b.{0,40}\b(?:disk|filesystem|file system|storage|cgroup|cpu|memory)\b/i;
const RATE_LIMIT_SIGNAL = /too many requests|rate[\s_-]*limit(?:ed|ing)?|\b(?:provider|http|status|response|api|request)\b[^\r\n]{0,32}\b429\b|\b429\b[^\r\n]{0,32}too many requests/i;

function classifyProviderCapacityCode(error) {
  if (LOCAL_RESOURCE_LIMIT_SIGNAL.test(error)) return null;
  if (QUOTA_EXHAUSTED_SIGNAL.test(error)) return "quota_exhausted";
  if (RATE_LIMIT_SIGNAL.test(error)) return "rate_limited";
  return null;
}

function findTerminalProviderError(events, expectedRunId) {
  if (typeof expectedRunId !== "string" || expectedRunId.length === 0) return null;
  const terminalIndex = events.findLastIndex(
    (event) => event.type === "run.state_change"
      && event.runId === expectedRunId
      && TERMINAL_STATES.includes(event.to),
  );
  if (terminalIndex < 0 || events[terminalIndex].to !== "failed") return null;
  for (let index = terminalIndex - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.runId !== expectedRunId || event.type !== "run.error") continue;
    return event.phase === "wait" && typeof event.error === "string" ? event : null;
  }
  return null;
}

// 进程被信号杀死 / 异常退出（C1 新增）："process exited with code N"，N≠0。
// 143=SIGTERM(被杀)，137=SIGKILL(OOM/强杀)，1=通用失败，130=SIGINT。
const CRASH_EXIT_SIGNAL = /exited with code\s+(\d+)/i;
const SIGNAL_NAMES = { 143: "SIGTERM", 137: "SIGKILL", 130: "SIGINT" };

// TD-74 provider 流式中断判据（Lead 定的保守阈值）。
// 死前≥3 条 run.event（排除启动即崩）+ 末段静默≥120s（排除活动密集的真崩）。
const PROVIDER_DISCONNECT_MIN_EVENTS = 3;
const PROVIDER_DISCONNECT_SILENCE_MS = 120_000;

/**
 * 诊断一个 run transcript 的失败原因。只给证据，不给处方。
 *
 * M12-6 FR-02: the return carries `code` — a nullable closed-set provider
 * diagnosis code. It is present (∈ PROVIDER_DIAGNOSIS_CODES) ONLY for
 * provider_auth, null for every other category, so a caller can never project
 * a code for a non-auth failure and never receives a raw message echo.
 *
 * @param {Array} events - run transcript 事件数组（按时间序）。
 * @param {string} [expectedRunId] - the runId the caller requested. Binds
 *   control-plane failure classifications so cross-run events cannot pollute
 *   this run's diagnosis.
 * @returns {{category: string, code: string|null, evidence: Array<{eventType: string, fact: string}>}}
 *   category 必属 DIAGNOSIS_CATEGORIES 闭集。
 *   code 仅 coded category 非 null，且必须通过 category-code pair 校验。
 *   evidence 是事实证据（eventType 指向源事件，fact 陈述具体事实）。
 */
export function diagnoseFailure(events, expectedRunId) {
  const raw = diagnoseFailureInner(events, expectedRunId);
  // Fail closed: a closed-set code is surfaced ONLY for a valid (category, code)
  // pair — provider_auth carries a PROVIDER_DIAGNOSIS_CODES member, and no_effect
  // carries the M12-21 completed_empty machine fact. Anything else (a branch that
  // forgot its code, a wrong-category pairing, an attacker-controlled value)
  // collapses to null. The wire projections (run_diagnose / run_await_result) use
  // the SAME isValidDiagnosisCode pair check, so completed_empty reaches a Lead as
  // code=no_effect/completed_empty on the wire (category=no_effect), derived from
  // the single DIAGNOSIS_CODES SSOT — never a raw provider payload echo.
  return {
    ...raw,
    code: kernelDiagnosisCode(raw.category, raw.code),
  };
}

/**
 * Kernel-safe closed-set code projection via the (category, code) pair check.
 * Allows the provider code for provider_auth and completed_empty for no_effect;
 * null otherwise. The wire projections share this exact pair discipline.
 * @param {string} category
 * @param {string|null|undefined} code
 * @returns {string|null}
 */
function kernelDiagnosisCode(category, code) {
  return isValidDiagnosisCode(category, code) ? code : null;
}

function diagnoseFailureInner(events, expectedRunId) {
  const raw = Array.isArray(events) ? events : [];
  const hasValidExpectedRunId = typeof expectedRunId === "string" && expectedRunId.length > 0;
  // R20 (TD-128 M4)：提供了合法 expectedRunId 时，全部失败分类事实（state/
  // stop·aborted·timeout·budget·scorecard·evidence_audit·run.event 活动，以及
  // auth/config/capacity/crash 的 run.error 匹配）只从该 runId 的信封绑定事件
  // 读取——尾部追加的外 run 伪终态/伪 401/伪 scorecard 行不再抢分类或翻转
  // 状态。既有绑定事实（isolation_violation/delivery_failed/completed_marker/
  // findTerminalProviderError）的逐事件 runId 检查在过滤后恒等保留（fail-closed
  // 门语义不变）。legacy 行为选择（锚点复核既有语义后取 boundReportScope 语义，
  // metrics.js 单一定义处）：全无信封的 pre-envelope transcript 保持历史分类
  // 读法（frictionLog TD-92 契约钉住——debug 模式对无信封失败 transcript 仍要
  // 分类写档）；任一事件带信封即严格绑定，零绑定事件（信封存在但全不可归属）
  // → 复用既有空输入降级 { category:"unknown" }，不 throw（诊断只给证据，宁
  // 缺勿错归）。expectedRunId 缺省/无效：保持历史无绑定读法（既有调用方契约
  // 不变）。
  const evs = hasValidExpectedRunId
    ? (boundReportScope(raw, expectedRunId) ?? raw)
    : raw;
  // 空输入：无法判断发生了什么 → unknown。
  if (evs.length === 0) return { category: "unknown", evidence: [] };
  const state = findState(evs);

  // M12-13: consume an isolation violation ONLY when it carries the safe
  // structured code "workdir_escape" (string, top-level durable fact — the
  // transcript spreads event payloads flat). A malformed/missing code or an
  // unknown value is NOT this diagnosis — the safe-code check keeps the signal
  // type-bound, matching the readiness projection's safe closed set.
  const isolationViolation = hasValidExpectedRunId
    ? evs.find(
      (e) => e.type === "run.isolation_violation"
        && e.runId === expectedRunId
        && e.code === "workdir_escape",
    )
    : undefined;
  if (isolationViolation) {
    // M12-14: the fact wording is reason-aware. Only an exact closed-set
    // reason selects its wording (confirmed-outside reasons may say
    // "outside"; correlation/physical-unresolved reasons state a confirmation
    // failure instead). A historical reason-absent or malformed reason falls
    // back to the generic fact — it never invents "outside" and the raw
    // malformed value is never echoed.
    return {
      category: "workdir_escape",
      evidence: [{
        eventType: "run.isolation_violation",
        fact: factForIsolationViolation(isolationViolation.reason),
      }],
    };
  }

  // M11-8C closeout (Gap B + final gate): a durable run.delivery_failed means
  // the WAO control plane could not package the delivery. This is checked
  // BEFORE the completed-state short circuit (a delivery run may
  // terminal=completed then fail packaging). FAIL-CLOSED BINDING: a delivery
  // failure is consumed ONLY when a valid expectedRunId is provided AND the
  // event's runId matches it. When expectedRunId is missing/invalid, NO
  // run.delivery_failed is consumed — an unbound caller must never attribute a
  // delivery failure (defends against cross-run pollution in concatenated/
  // corrupt transcripts). The signal uses only the safe event TYPE (no
  // message/path/code echo). No prescription/retry.
  const deliveryFailed = hasValidExpectedRunId
    ? evs.find((e) => e.type === "run.delivery_failed" && e.runId === expectedRunId)
    : undefined;
  if (deliveryFailed) {
    return {
      category: "delivery_packaging_failed",
      evidence: [{ eventType: "run.delivery_failed", fact: "delivery packaging failed (control-plane-owned commit could not be created)" }],
    };
  }

  // M12-21: completed-empty truth (provider-neutral). A backend COMPLETION
  // that produced NO usable model effect must not read as an ordinary
  // completed run — a Lead must never mistake "runtime exited 0 after doing
  // no model work" for a valid completed review or delivery. Usable effect =
  // non-blank assistant text, command activity, file-written evidence, or
  // tool use/result. Runtime init / thinking / (zero- or non-zero) usage
  // metrics are TRANSPORT activity (the runtime initialized/streamed) but NOT
  // usable effect. A minimal synthetic stub with no transport activity is NOT
  // completed-empty (no evidence the backend even ran) — it stays "none",
  // preserving the m12-9 completed contract. Both reach state=completed here:
  // the parser-done(completed) path and the process exit-code-0 fallback.
  // Closed-set code "completed_empty"; no provider text/argv/path/prompt is
  // exposed.
  //
  // M12-21B gap #1 / M12-21C trust boundary: consume the durable marker FIRST,
  // but ONLY under a fail-closed run binding. RunManager persists
  // completionMarker on the accepted run.completed fact — the closed-set
  // completed_empty value ProcessBackend stamps when a completion did no
  // usable model work. It is a control-plane fact, so it is consumed ONLY when
  // a valid expectedRunId is provided AND the run.completed event's runId
  // matches it — same fail-closed shape as run.delivery_failed /
  // run.isolation_violation above. No expectedRunId, a cross-run marker
  // (runId !== expectedRunId), a missing runId, or an unknown marker value
  // must NOT drive no_effect/completed_empty: an unbound caller must never
  // attribute completed-empty, defending against cross-run pollution in
  // concatenated/corrupt transcripts. The evidence-based retrofit below is
  // retained exactly as before for historical transcripts without a bound
  // marker (it does not consult completionMarker).
  if (state === "completed") {
    const completedMarkerFact = hasValidExpectedRunId
      ? evs.find(
        (e) => e.type === "run.completed"
          && e.runId === expectedRunId
          && e.completionMarker === "completed_empty",
      )
      : undefined;
    if (completedMarkerFact) {
      return {
        category: "no_effect",
        code: "completed_empty",
        evidence: [{
          eventType: "run.completed",
          fact: "worker completed with no usable effect (durable completionMarker=completed_empty)",
        }],
      };
    }
    const a = assessRunEvidence(evs);
    const hasUsableEffect = a.hasAssistantText || a.hasAnyEvidence;
    if (!hasUsableEffect && a.hasTransportActivity) {
      return {
        category: "no_effect",
        code: "completed_empty",
        evidence: [{
          eventType: "run.state_change",
          fact: `worker completed with no usable effect: transport activity observed (${a.activityEventCount} activity event(s)) but no assistant text, command activity, file write, or tool use`,
        }],
      };
    }
    return { category: "none", evidence: [] };
  }

  const evidence = [];

  // 0) TD-99 legacy 兼容：旧双终态 transcript（aborted 先 claim 成功，failed 被 race 写入覆盖）。
  //    新世界不会产生双终态（first-terminal-wins），这只出现在历史 transcript。
  //    窄兼容规则（全部满足才按 legacy aborted_manual 解释）：
  //      - 有明确 stop_requested 或 run.aborted 证据
  //      - terminal state_change 至少两条（双终态特征）
  //      - 第一条 terminal state_change.to === "aborted"（aborted 是真正意图，先到达）
  //      - 不存在 run.state_change_rejected（新世界 rejected 的不归此路径）
  //    findState 仍返回 last-wins（不改），但诊断按 legacy 给 aborted_manual。
  const stopRequestedLegacy = evs.find((e) => e.type === "run.stop_requested");
  const abortedLegacy = evs.find((e) => e.type === "run.aborted");
  if (stopRequestedLegacy || abortedLegacy) {
    const terminalChanges = evs.filter((e) => e.type === "run.state_change" && TERMINAL_STATES.includes(e.to));
    const hasRejected = evs.some((e) => e.type === "run.state_change_rejected");
    if (terminalChanges.length >= 2 && terminalChanges[0].to === "aborted" && !hasRejected) {
      const source = stopRequestedLegacy ?? abortedLegacy ?? terminalChanges[0];
      evidence.push({
        eventType: source.type,
        fact: `被显式中止（reason=${source.reason ?? "unknown"}）[legacy 双终态兼容]`,
      });
      return { category: "aborted_manual", evidence };
    }
  }

  // 1) aborted_manual：显式 stop/abort，且当前终态确实是 aborted。
  //    TD-99：failed/completed/timed_out 已赢时，迟到的 run.stop_requested 不得抢分类——
  //    只有 findState==="aborted" 才归 aborted_manual。无 state_change 的旧 transcript
  //    若 legacy fallback 推出 aborted（run.aborted/run.stop_requested 兜底），也保留。
  const stopRequested = evs.find((e) => e.type === "run.stop_requested");
  const aborted = evs.find((e) => e.type === "run.aborted");
  const abortedChange = evs.find((e) => e.type === "run.state_change" && e.to === "aborted");
  if (state === "aborted" && (stopRequested || aborted || abortedChange)) {
    const source = stopRequested ?? aborted ?? abortedChange;
    evidence.push({
      eventType: source.type,
      fact: `被显式中止（reason=${source.reason ?? "unknown"}）`,
    });
    return { category: "aborted_manual", evidence };
  }

  // 1) config_conflict（C2）：配置层冲突（API key 与登录打架等）。
  //    必须在 provider_auth 之前判——配置冲突的 error 也常含 "auth"/"API_KEY" 字样，
  //    但本质是配置问题不是认证失败。真实例：ANTHROPIC_API_KEY takes precedence。
  const configError = evs.find(
    (e) => e.type === "run.error" && typeof e.error === "string" && CONFIG_CONFLICT_SIGNAL.test(e.error),
  );
  if (configError) {
    evidence.push({ eventType: "run.error", fact: `配置冲突：${configError.error}` });
    return { category: "config_conflict", evidence };
  }

  // 2) provider_auth：真正的 401/身份验证/unauthorized/无效 key（最优先，常见且确定）。
  // M12-6 FR-02: subscription/org-policy/API-key denial FACTS also classify as
  // provider_auth even when they carry no 401/unauthorized token (production
  // fact: "Your organization has disabled Claude subscription access ...").
  // The code is a closed-set label from PROVIDER_DENIAL_SIGNALS — the evidence
  // fact carries the code, never the raw error message.
  const denialError = evs.find(
    (e) => e.type === "run.error" && typeof e.error === "string"
      && PROVIDER_DENIAL_SIGNALS.some((s) => s.re.test(e.error)),
  );
  if (denialError) {
    const code = classifyProviderAuthCode(denialError.error);
    evidence.push({ eventType: "run.error", fact: `provider access denied（${code}）` });
    return { category: "provider_auth", code, evidence };
  }

  const authError = evs.find(
    (e) => e.type === "run.error" && typeof e.error === "string" && AUTH_SIGNAL.test(e.error),
  );
  if (authError) {
    evidence.push({ eventType: "run.error", fact: `认证/身份验证类错误：${authError.error}` });
    return { category: "provider_auth", code: classifyProviderAuthCode(authError.error), evidence };
  }

  // A capacity limit is a bound terminal execution fact, not static registry
  // readiness. Use only the last run.error immediately preceding an explicit,
  // same-run failed transition. This prevents findState's legacy run.error
  // fallback, an earlier transient 429, or cross-run text from preempting the
  // actual terminal cause. Process backends report provider exits in phase=wait.
  const terminalError = findTerminalProviderError(evs, expectedRunId);
  const capacityError = terminalError
    && classifyProviderCapacityCode(terminalError.error) !== null
    ? terminalError
    : null;
  if (capacityError) {
    const code = classifyProviderCapacityCode(capacityError.error);
    evidence.push({ eventType: "run.error", fact: `provider capacity unavailable（${code}）` });
    return { category: "provider_capacity", code, evidence };
  }

  // 3) timeout：run.timed_out 事件。
  const timedOut = evs.find((e) => e.type === "run.timed_out");
  if (timedOut) {
    evidence.push({ eventType: "run.timed_out", fact: "等待超时，控制器 abort 打断事件流" });
    return { category: "timeout", evidence };
  }

  // 3) budget：超 token 预算硬闸。
  const budgetChange = evs.find(
    (e) => e.type === "run.state_change" && e.reason === STATE_CHANGE_REASON.budget_exceeded,
  );
  if (budgetChange) {
    evidence.push({ eventType: "run.state_change", fact: "token 预算超限，触发硬闸转 failed" });
    return { category: "budget", evidence };
  }

  // 4) scorecard_fail：scorecard 证据门未过。
  const scError = evs.find((e) => e.type === "run.error" && e.phase === "scorecard");
  const scChecked = evs.find((e) => e.type === "scorecard.checked" && e.passed === false);
  if (scError || scChecked) {
    const failedChecks = (scChecked?.checks ?? [])
      .filter((c) => !c.passed)
      .map((c) => c.name);
    if (failedChecks.length > 0) {
      evidence.push({
        eventType: "scorecard.checked",
        fact: `scorecard 证据门未过，失败检查项：${failedChecks.join(", ")}`,
      });
    } else if (scError) {
      evidence.push({ eventType: "run.error", fact: `scorecard 门失败：${scError.detail ?? "未提供详情"}` });
    }
    return { category: "scorecard_fail", evidence };
  }

  // 4.5) TD-95 #5 + TD-80 evidence_passed_backend_failed：backend 崩了但证据通过了。
  //   runManager 的 _auditEvidenceOnFailure 在 failed 路径写 run.evidence_audit {passed:true}。
  //   必须在 crash/provider_disconnect/no_effect 之前判——否则会被 exit code 抢归 crash。
  //   让 Lead 知道"任务可能做对了，需人工确认"，而非被 'crash' 误导。
  //   TD-80：TD-95 之前的历史 transcript 没有 run.evidence_audit，这类 legacy run
  //   原本被 crash 抢归（如 run_20260702142549160dfqmrt：命令轮询有产出但 backend 非零退出）。
  //   Fail-closed 规则（不削弱终态 truthfulness）：
  //     - 只要存在任意 run.evidence_audit 事件，audit 就是唯一权威——仅 passed===true
  //       提升；显式 passed:false 或畸形值绝不被重建的原始证据推翻。
  //     - 无任何 audit（legacy）时，用同一 assessRunEvidence SSOT 重建证据，仅当
  //       hasFileWritten || hasCommandExit0 才提升——assistant text / tool_use 只是
  //       活动，不是"证据通过"，不得提升。
  //     - 优先级槽位不变：仍先于 provider_disconnect/no_effect/crash，后于
  //       auth/config/timeout/budget/scorecard。
  const hasEvidenceAudit = evs.some((e) => e.type === "run.evidence_audit");
  if (state === "failed") {
    // TD-97：复用统一证据评估获取 file/command 计数
    const a = assessRunEvidence(evs);
    const evidenceAudit = hasEvidenceAudit
      ? evs.find((e) => e.type === "run.evidence_audit" && e.passed === true)
      : undefined;
    if (evidenceAudit || (!hasEvidenceAudit && (a.hasFileWritten || a.hasCommandExit0))) {
      evidence.push({
        eventType: hasEvidenceAudit ? "run.evidence_audit" : "run.event",
        fact: `backend 进程失败但证据通过：${a.fileWrittenCount} 个文件写入 + ${a.commandExit0Count} 个命令 exit0。任务可能做对了，需人工确认`,
      });
      return { category: "evidence_passed_backend_failed", evidence };
    }
  }

  // 4.6) provider_disconnect：worker 活跃工作后，末段静默 ≥阈值 才 exit≠0 →
  //      provider 网关流式中断（非 runtime 真崩）。判据保守（Lead 定：静默阈值
  //      120s、死前≥3 run.event、宁漏贴勿误贴）。
  //      M9-5P 修复：此严格签名必须优先于通用 no_effect——否则一个同时满足
  //      "有活动无产出"（no_effect）和 "≥3 events + ≥120s 静默 + exit crash"
  //      （provider_disconnect）的 run 会被 no_effect 抢先误判。真实样本
  //      run_202607082124125368q0r9t（14 events, 266s 静默, exit 1）即此 case。
  //      排在 crash 之前：否则会被 CRASH_EXIT_SIGNAL 抢归 crash。
  const exitCrashForPd = evs.find(
    (e) => e.type === "run.error" && typeof e.error === "string" && CRASH_EXIT_SIGNAL.test(e.error),
  );
  if (state === "failed" && exitCrashForPd && !evs.some((e) => e.type === "run.completed")) {
    const activityEvents = evs.filter((e) => e.type === "run.event");
    const lastActivity = activityEvents.at(-1);
    if (lastActivity && activityEvents.length >= PROVIDER_DISCONNECT_MIN_EVENTS) {
      const silenceMs = new Date(exitCrashForPd.ts).getTime() - new Date(lastActivity.ts).getTime();
      if (silenceMs >= PROVIDER_DISCONNECT_SILENCE_MS) {
        evidence.push({
          eventType: "run.event",
          fact: `死前最后活动 ${lastActivity.ts}（${activityEvents.length} 条 run.event），末段静默 ${Math.round(silenceMs / 1000)}s`,
        });
        evidence.push({
          eventType: exitCrashForPd.type,
          fact: `${silenceMs >= PROVIDER_DISCONNECT_SILENCE_MS ? "静默 ≥阈值" : ""}后进程 ${exitCrashForPd.error}（provider 流式中断特征：worker 正常产出后静默断流，非启动即崩）`,
        });
        return { category: "provider_disconnect", evidence };
      }
    }
  }

  // 4.7) TD-95 #4 no_effect：worker 读了上下文但没产出（无 file_written + 无 command exit0）。
  //   必须在 crash 之前判——但要求有 tool_use/assistant text 活动（worker 确实干了事但没产出），
  //   否则纯进程崩溃（无活动）仍是 crash，不是 no_effect。
  //   M9-5P：排在 provider_disconnect 之后——不满足严格断流签名（<120s 静默或 <3 events）
  //   的"有活动无产出" run 仍归 no_effect。
  //   TD-97：复用统一证据评估，不再自己判 file/command/tool_use/assistant text。
  if (state === "failed") {
    const a = assessRunEvidence(evs);
    // 只有"有活动但无产出"才是 no_effect。无活动的纯崩溃仍是 crash。
    if (!a.hasFileWritten && !a.hasCommandExit0 && (a.hasToolUse || a.hasAssistantText)) {
      evidence.push({
        eventType: "run.event",
        fact: `worker 有 ${a.activityEventCount} 条活动事件但无 file_written / 无 command exit0（读完上下文没产出）`,
      });
      return { category: "no_effect", evidence };
    }
  }

  // 6) crash：进程崩溃/被杀。
  //    两条路径：① spawn/spawn_fail 阶段错误（backend 起不来）；
  //    ② wait 阶段的 "process exited with code N"（N≠0，含 143=SIGTERM 被 kill、
  //    137=SIGKILL/OOM、130=SIGINT、1=通用失败）。后者是 C1 新增——真实 transcript
  //    里 run.error phase:wait error:"process exited with code 143" 此前漏到 unknown。
  //    排在 auth/config 之后：若 stderr 里含 401 等，前面 provider_auth 已抢先归类。
  const spawnCrash = evs.find(
    (e) => e.type === "run.error" && (e.phase === "spawn" || e.phase === "spawn_fail"),
  );
  const exitCrash = evs.find(
    (e) => e.type === "run.error" && typeof e.error === "string" && CRASH_EXIT_SIGNAL.test(e.error),
  );
  if (spawnCrash) {
    evidence.push({
      eventType: "run.error",
      fact: `启动阶段失败（phase=${spawnCrash.phase}）：${spawnCrash.error ?? "未提供详情"}`,
    });
    return { category: "crash", evidence };
  }
  if (exitCrash) {
    const m = exitCrash.error.match(CRASH_EXIT_SIGNAL);
    const code = m ? Number(m[1]) : null;
    const sigName = code !== null ? SIGNAL_NAMES[code] : null;
    const detail = sigName
      ? `进程退出码 ${code}（${sigName}，可能被外部信号杀死）`
      : `进程异常退出，退出码 ${code}`;
    evidence.push({ eventType: "run.error", fact: `${detail}：${exitCrash.error}` });
    return { category: "crash", evidence };
  }

  // 7) 有失败终态但无明确信号 → unknown（不强归类）。
  if (state === "failed" || state === "aborted" || state === "timed_out") {
    return { category: "unknown", evidence: [] };
  }

  // 空输入 / 无状态（无法判断）→ unknown。仍在运行（非终态）→ none（无失败可诊断）。
  if (!state) return { category: "unknown", evidence: [] };
  return { category: "none", evidence: [] };
}
