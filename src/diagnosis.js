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
//   provider_disconnect         — provider 侧流中断（非 runtime 真崩）。判据三条：
//                                 ① worker 活跃工作后静默≥120s 且 exit≠0；
//                                 ② zcode/kimi-web 静默收口文案——backend 在静默到点后
//                                   有界收口。kimi-web 逐门判定（见
//                                   KIMI_WEB_SILENT_CLOSEOUT_GATES）：serve 作证本轮
//                                   不活跃 / 输出到封顶 → provider_disconnect；
//                                   serve 不应答（状态未知）→ unknown。zcode 的文案
//                                   不带摘要 → 本类（收口本身不带上游原因）；带摘要
//                                   且链尾（本轮最后一个主轮请求）failed、状态码在
//                                   认证/限流闭集（429/401/403）→ 先升级 provider_
//                                   capacity/provider_auth（升级出的类别与通用规则
//                                   同款优先级——先于 evidence_passed_backend_
//                                   failed；转录里有通过的证据审计时补「有产出」
//                                   静态事实）；带摘要但不升级 → 本类的「带摘要
//                                   事实」变体（事实带链尾状态与次数）；
//                                 ③ zcode 以失败结束本轮的文案（step-finish
//                                   reason error）带摘要：链尾 failed/stream_stalled/
//                                   retry_scheduled → 本类；链尾 started/completed
//                                   （请求已完成、轮次却失败）→ 照原路径走
//                                   （evidence_passed_backend_failed/no_effect/
//                                   unknown 等），只附摘要事实
//   no_effect                   — worker 有活动但无产出（无 file_written + 无 command exit0）
//   crash                       — run.error phase:spawn/spawn_fail / 进程异常退出
//   aborted_manual              — run.aborted 事件
//   unknown                     — 有失败终态但无明确信号
//   none                        — 成功 run（无失败终态，无需诊断）
//
// 只读：本函数不接收也不返回可变状态，不改 transcript。

import { findState, TERMINAL_STATES, STATE_CHANGE_REASON, PROCESS_MISSING_CONFIRMED_TYPE } from "./transcript.js";
import { boundReportScope } from "./metrics.js";
import { assessRunEvidence } from "./runEvidenceAssessment.js";
import { isObservedVitalSign } from "./runEvent.js";

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

// 打包环境类别 → 固定文案事实（runManager 从错误对象结构化属性分出闭集
// errorClass 后写入 run.delivery_failed；诊断面按值追加一条事实）。闭集成员
// 的 SSOT 是 src/deliveryErrorClass.js 的 DELIVERY_ERROR_CLASSES——本映射的键集
// 与之对账（test/delivery/deliveryErrorClass.test.js）。只认闭集值：未知/
// malformed 值查不到 → 不产出附加事实；文案固定，不回显路径或消息原文，
// 不自动重试、不替 Lead 决定。
export const DELIVERY_ERROR_CLASS_FACTS = Object.freeze({
  git_index_locked: "the worktree's git index lock file (index.lock) was present when packaging ran: a git process was still writing the index, or one that exited left the lock behind; this failure has no repackage candidate (docs/troubleshooting.md §4.6)",
  file_locked: "a worktree file was locked or unmodifiable (EBUSY/EPERM) while packaging ran",
  permission_denied: "packaging was denied filesystem access (EACCES)",
  disk_full: "packaging ran out of disk space (ENOSPC)",
  git_spawn_failed: "git could not be started (spawn failed, e.g. git missing from PATH)",
  git_timeout: "the git process was killed or timed out during packaging",
  git_command_failed: "a git command exited non-zero during packaging",
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

// The frozen closed-set SSOT of filesystem error codes an isolation violation may
// record when the physical location of a reported write stayed unprovable. Only
// these tokens (and the catch-all "other") ever reach the durable fact: an
// exception without a code, or with any code outside this set, is recorded as
// "other" — the raw value is never echoed. Hosted HERE for the same reason as
// ISOLATION_VIOLATION_REASONS above: this module must stay import-pure while the
// write side (runManager's containment gate) and the read side (this module's
// fact wording) both need the one set.
export const ISOLATION_PHYSICAL_ERROR_CODES = Object.freeze([
  "EBUSY", // the target is held by another handle (pending delete/replace)
  "EPERM", // the operation is refused while the file is being swapped
  "EACCES", // access is denied during the swap window
  "ENOENT", // the target is momentarily absent (temp-write + rename replace)
  "ELOOP", // too many links — a real path problem, not a transient one
  "ENOTDIR", // a path component is not a directory
  "EINVAL", // the filesystem rejected the argument
  "ENAMETOOLONG", // the path exceeds the platform limit
  "EIO", // device I/O error
  "other", // any other code, or none at all
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
 *
 * A physical_unresolved reason additionally states WHICH filesystem error kept
 * the location unprovable — appended only when the persisted errorCode is an
 * exact ISOLATION_PHYSICAL_ERROR_CODES member, so no value outside the closed
 * set can ever enter the fact text. An absent or non-member code leaves the
 * wording byte-identical to the reason-only fact (historical transcripts).
 * @param {unknown} reason
 * @param {unknown} errorCode
 * @returns {string}
 */
function factForIsolationViolation(reason, errorCode) {
  const knownReason = typeof reason === "string" && Object.hasOwn(ISOLATION_VIOLATION_FACTS, reason);
  const fact = knownReason ? ISOLATION_VIOLATION_FACTS[reason] : ISOLATION_VIOLATION_FACT_UNKNOWN;
  return knownReason
    && reason.endsWith("_physical_unresolved")
    && typeof errorCode === "string"
    && ISOLATION_PHYSICAL_ERROR_CODES.includes(errorCode)
    ? `${fact} (filesystem error code: ${errorCode})`
    : fact;
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
// 401 只匹配独立数字（\b401\b，写法同 RATE_LIMIT_SIGNAL 的 429 边界）：zcode 静默收口
// 文案里的毫秒读数（如 "silent stretch 401872ms"、"max recovered gap this turn
// 14010ms"）与 kimi 信封码 40401 都不得判成认证失败。
const AUTH_SIGNAL = /\b401\b|身份验证|unauthor|invalid.{0,12}(api[_\s-]?key|key)/i;

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

// zcode 静默收口文案 → provider_disconnect。zcode 车道上游额度窗口用尽时模型流停下来，
// 收口本身不带上游原因；backend 自 2026-10-15 起消费 `v4/telemetry/event` 通知里的
// model.request.status，链尾已知时在文案末尾追加有界上游摘要（见 parseUpstreamSummary
// ——摘要的升级/归类规则见 diagnoseFailureInner 的 4.4/4.6 槽注释）。backend 在静默
// 到点后有界收口，run.error(phase:wait) 的文案由控制面自己写、以三道门之一开头
//（src/backends/zcode.js closeGate 文案）。锚定前缀 = 只匹配这三道门的原文案，
// 不匹配恰好引用这些句子的其它错误；gate 名沿用 backend 的 closeGate 闭集。
const SILENT_CLOSEOUT_GATES = Object.freeze([
  { gate: "silent_timeout", re: /^silent timeout: no turn parts observed within / },
  { gate: "zero_part", re: /^zcode thinking budget exceeded \(no turn parts observed for / },
  { gate: "stalled", re: /^zcode turn stalled \(/ },
]);
// 静态门名事实（闭集映射，无原文回显）。
const SILENT_CLOSEOUT_GATE_FACTS = Object.freeze({
  silent_timeout: "silent_timeout 门：silentTimeout 到点仍零 turn part",
  zero_part: "zero_part 门：零 part 阶段思考预算拍数用尽（silentTimeout 缺席）",
  stalled: "stalled 门：已有产出后的停滞预算到点",
});

// kimi-web 静默收口文案 → 逐门判定（src/backends/kimiWeb.js 的收口门文案）。kimi-web
// 车道的 turn 迟迟没有进展时 backend 有界收口，run.error(phase:wait) 的文案由控制面
// 自己写、以门表前缀开头。收口本身不带上游原因；收口时 serve 有没有被问到、当时怎么
// 答，决定能写哪些事实、归哪一类：
//   - turn 一直没出现（silentTimeout 到点 / silentTimeout 缺席时的拍数兜底）：收口时
//     没有向 serve 取证——上游拒绝、serve 未受理与网络中断在转录内无法区分；
//   - 停滞到点且 serve 作证本轮不活跃 → provider_disconnect（serve 的状态已知）；
//   - 停滞到点且 serve 不应答 → unknown（真挂死与探针失败在转录内无法区分，不冒充
//     已知的 provider 侧中断）；
//   - serve 一直作证本轮在跑、输出不增长到封顶 → provider_disconnect；
//   - 两道历史门（8 拍无增长 / 不带证词子句的自适应停滞）：收口时不问 serve。
// 锚定前缀 = 只匹配这些收口文案的开头，不匹配恰好引用这些句子的其它错误；带
// attestation 子句的两道停滞门必须排在历史兜底门之前（它们同以 silent stretch 开头）。
// 静态事实句是闭集映射，无原文回显（毫秒读数与拍数不进证据）。
const KIMI_WEB_SILENT_CLOSEOUT_NO_CAUSE = "收口本身不带上游原因";
const KIMI_WEB_SILENT_CLOSEOUT_TURN_ABSENT_NO_CAUSE =
  "收口本身不带上游原因——上游拒绝、serve 未受理与网络中断在本转录内无法区分";
const KIMI_WEB_SILENT_CLOSEOUT_GATES = Object.freeze([
  {
    gate: "silent_timeout",
    category: "provider_disconnect",
    re: /^silent timeout: turn for this prompt not observed within /,
    fact: "silentTimeout 到点仍未见本轮 turn（turn 一直没有出现）",
    causeFact: KIMI_WEB_SILENT_CLOSEOUT_TURN_ABSENT_NO_CAUSE,
  },
  {
    gate: "turn_absent",
    category: "provider_disconnect",
    re: /^turn stalled \(no progress\): turn not observed for /,
    fact: "silentTimeout 缺席时无进展拍数兜底到点仍未见本轮 turn",
    causeFact: KIMI_WEB_SILENT_CLOSEOUT_TURN_ABSENT_NO_CAUSE,
  },
  {
    gate: "stalled_attestation_inactive",
    category: "provider_disconnect",
    re: /^turn stalled \(no progress\): silent stretch [^\r\n]*attestation: inactive\b/,
    fact: "停滞到点时 serve 作证本轮已不活跃",
    causeFact: KIMI_WEB_SILENT_CLOSEOUT_NO_CAUSE,
  },
  {
    gate: "stalled_attestation_unavailable",
    category: "unknown",
    re: /^turn stalled \(no progress\): silent stretch [^\r\n]*attestation: unavailable\b/,
    fact: "停滞到点时 serve 不应答，serve 的状态未知",
    causeFact: KIMI_WEB_SILENT_CLOSEOUT_NO_CAUSE,
  },
  {
    gate: "serve_attested_cap",
    category: "provider_disconnect",
    re: /^turn stalled: serve-attested silence since the last output growth exceeded the /,
    fact: "serve 一直作证本轮在跑，但输出一直不增长，直到封顶",
    causeFact: KIMI_WEB_SILENT_CLOSEOUT_NO_CAUSE,
  },
  {
    gate: "legacy_poll_no_growth",
    category: "provider_disconnect",
    re: /^turn stalled \(no progress\): turn state unchanged and no steps\/frames growth for /,
    fact: "8 拍无增长的停滞到点（历史门，收口时没有向 serve 取证）",
    causeFact: KIMI_WEB_SILENT_CLOSEOUT_NO_CAUSE,
  },
  {
    gate: "legacy_adaptive_budget",
    category: "provider_disconnect",
    re: /^turn stalled \(no progress\): silent stretch /,
    fact: "自适应预算的停滞到点（历史门，文案不带证词子句，收口时没有向 serve 取证）",
    causeFact: KIMI_WEB_SILENT_CLOSEOUT_NO_CAUSE,
  },
]);

// zcode 自己以失败结束本轮的文案（backend 固定句式，step-finish reason error
// 的 part 不带错误明细）。
const ZCODE_TURN_FAILED_SIGNAL = /^zcode turn failed \(step-finish reason error/;

// zcode 收口/失败文案末尾的上游主轮请求摘要（backend summarySuffix 生成，格式
// 锚定在句尾）：`; upstream: last main-turn request <status> (statusCode N,
// attempt A/M)`——statusCode 段与 attempt 段按已知性取舍。解析只读这一段，只
// 取闭集 status 与整数；解析不出 = 当作没有摘要，走既有路径。
const UPSTREAM_SUMMARY_STATUS_SET = new Set([
  "model_request_started",
  "model_request_completed",
  "model_request_failed",
  "model_retry_scheduled",
  "model_stream_stalled",
]);
const UPSTREAM_SUMMARY_RE = /; upstream: last main-turn request ([a-z_]+?)(?: \(([^()]*)\))?$/;

/**
 * 解析 zcode 收口文案末尾的上游摘要。只接受 backend 生成过的三种形状（带
 * statusCode+attempt / 仅 attempt / 仅 status）；闭集外的 status、越界的
 * statusCode、认不出的括号内容一律返回 null（fail-closed，不当摘要消费）。
 * @param {string} error - run.error 文本
 * @returns {{status: string, statusCode: number|null, attempt: number|null, maxAttempts: number|null}|null}
 */
function parseUpstreamSummary(error) {
  if (typeof error !== "string") return null;
  const m = error.match(UPSTREAM_SUMMARY_RE);
  if (!m || !UPSTREAM_SUMMARY_STATUS_SET.has(m[1])) return null;
  const summary = { status: m[1], statusCode: null, attempt: null, maxAttempts: null };
  if (m[2] === undefined) return summary;
  const codeMatch = m[2].match(/^statusCode (\d+)(?:, attempt (\d+)\/(\d+))?$/);
  const attemptMatch = m[2].match(/^attempt (\d+)\/(\d+)$/);
  if (codeMatch) {
    const statusCode = Number(codeMatch[1]);
    if (statusCode < 100 || statusCode > 599) return null;
    summary.statusCode = statusCode;
    if (codeMatch[2] !== undefined) {
      summary.attempt = Number(codeMatch[2]);
      summary.maxAttempts = Number(codeMatch[3]);
    }
    return summary;
  }
  if (attemptMatch) {
    summary.attempt = Number(attemptMatch[1]);
    summary.maxAttempts = Number(attemptMatch[2]);
    return summary;
  }
  return null;
}

/**
 * 剥掉 zcode 收口/失败文案末尾的上游摘要段。只剥 parseUpstreamSummary 认得出、
 * 锚定在句尾的那一段（backend summarySuffix 生成）；标记子串之后不是合法摘要
 * 时原文不动。通用文本规则（PROVIDER_DENIAL_SIGNALS / AUTH_SIGNAL / 终态额度
 * 匹配）一律对剥离结果匹配——摘要里的 "statusCode 401" 是控制面自己的投影，
 * 不是上游发来的错误文本；不是摘要的文本照常参与匹配。
 * @param {string} text
 * @returns {string}
 */
function stripUpstreamSummary(text) {
  if (parseUpstreamSummary(text) === null) return text;
  return text.slice(0, text.match(UPSTREAM_SUMMARY_RE).index);
}

// 摘要事实句（闭集字段拼接，无原文回显）。两副面孔：
//   - disconnect 版：归 provider_disconnect 时用——剩余原因不可区分的收尾成立；
//   - 中性版：链尾 started/completed、照原路径走时附加——只陈述链尾，不断言
//     流中断（请求已完成、轮次却失败不是"流中断"）。
function upstreamDetailText(u) {
  return u.statusCode !== null
    ? `（statusCode ${u.statusCode}${u.attempt !== null ? `，attempt ${u.attempt}/${u.maxAttempts}` : ""}）`
    : u.attempt !== null ? `（attempt ${u.attempt}/${u.maxAttempts}）` : "";
}
function upstreamRecoveredNote(u) {
  return u.status === "model_request_started" || u.status === "model_request_completed"
    ? "（链尾已见 started/completed——此前的失败若有过即已恢复，不当根因）"
    : "";
}
function upstreamDisconnectFact(u) {
  return `上游主轮请求摘要：最后状态 ${u.status}${upstreamDetailText(u)}${upstreamRecoveredNote(u)}；剩余原因在本转录内无法进一步区分（provider 流中断）`;
}
function upstreamNeutralFact(u) {
  return `上游主轮请求摘要：最后状态 ${u.status}${upstreamDetailText(u)}${upstreamRecoveredNote(u)}`;
}

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
    // malformed value is never echoed. A physical_unresolved reason also names
    // the filesystem error code, and only when it is a closed-set member.
    return {
      category: "workdir_escape",
      evidence: [{
        eventType: "run.isolation_violation",
        fact: factForIsolationViolation(isolationViolation.reason, isolationViolation.errorCode),
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
    // 闭集标记 workerDeclared（runManager 在空 diff + worker 按角色合同上报越界
    // 停手时写入）：追加一条静态事实——"明确拒绝并说明了原因"≠"什么都没做"。
    // 只认闭集值、只出固定文案（路径与理由仍不回显，Lead 经 collect 读原文）。
    const declaredStop = deliveryFailed.workerDeclared === "scope_expansion_required";
    // 打包环境类别同理：闭集 errorClass → 固定文案事实（键集与
    // src/deliveryErrorClass.js 对账）；未知/缺失值不出附加事实。只认自有键：
    // transcript 里的 "constructor"、"__proto__" 之类不得取到继承属性。
    const errorClassFact = typeof deliveryFailed.errorClass === "string"
      && Object.hasOwn(DELIVERY_ERROR_CLASS_FACTS, deliveryFailed.errorClass)
      && typeof DELIVERY_ERROR_CLASS_FACTS[deliveryFailed.errorClass] === "string"
      ? DELIVERY_ERROR_CLASS_FACTS[deliveryFailed.errorClass]
      : undefined;
    return {
      category: "delivery_packaging_failed",
      evidence: [
        { eventType: "run.delivery_failed", fact: "delivery packaging failed (control-plane-owned commit could not be created)" },
        ...(declaredStop
          ? [{ eventType: "run.delivery_failed", fact: "worker stopped on purpose and reported SCOPE_EXPANSION_REQUIRED (role-contract stop, not an idle run) — read its final message for the path and reason" }]
          : []),
        ...(errorClassFact
          ? [{ eventType: "run.delivery_failed", fact: errorClassFact }]
          : []),
      ],
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

  // 1.5) zcode 摘要的事实准备（只绑定真正终局的那条错误）：摘要只在**本运行
  //      最后一条** run.error 是带摘要的 zcode 收口/失败文案时才算数——较早的
  //      带摘要收口不抢其后真终局错误（认证/额度文本、进程退出等）的分类。升级
  //      动作在 4.4 槽执行（后于通用文本规则与既有终局原因、先于
  //      evidence_passed_backend_failed）；不升级的归类在 4.6 槽，4.6 的收口
  //      门表规则（zcode、kimi-web）同样只认 lastErrorEvent。
  //      通用文本规则（denial/auth/终态额度）一律对 stripUpstreamSummary 之后
  //      的文本匹配——不靠排序防止摘要里的 401 被误抢。
  let lastErrorEvent = null;
  for (let i = evs.length - 1; i >= 0; i -= 1) {
    const e = evs[i];
    if (e.type === "run.error" && typeof e.error === "string") { lastErrorEvent = e; break; }
  }
  const lastUpstream = lastErrorEvent !== null
    && (SILENT_CLOSEOUT_GATES.some((g) => g.re.test(lastErrorEvent.error))
      || ZCODE_TURN_FAILED_SIGNAL.test(lastErrorEvent.error))
    ? parseUpstreamSummary(lastErrorEvent.error)
    : null;
  // 未被升级/流中断消费的中性摘要事实：链尾 started/completed（请求已完成、轮次
  // 却失败）时收口走原路径，结论只附这条事实——只陈述链尾，不断言流中断。
  const pendingUpstreamFact = lastUpstream !== null
    && (lastUpstream.status === "model_request_started" || lastUpstream.status === "model_request_completed")
    ? { eventType: "run.error", fact: upstreamNeutralFact(lastUpstream) }
    : null;

  // 2) provider_auth：真正的 401/身份验证/unauthorized/无效 key（最优先，常见且确定）。
  // M12-6 FR-02: subscription/org-policy/API-key denial FACTS also classify as
  // provider_auth even when they carry no 401/unauthorized token (production
  // fact: "Your organization has disabled Claude subscription access ...").
  // The code is a closed-set label from PROVIDER_DENIAL_SIGNALS — the evidence
  // fact carries the code, never the raw error message.
  // 文本匹配对 stripUpstreamSummary 之后的文本做（zcode 收口文案末尾的上游摘要
  // 不是上游错误文本——摘要里的 "statusCode 401" 不得触发认证规则）。
  const denialError = evs.find(
    (e) => e.type === "run.error" && typeof e.error === "string"
      && PROVIDER_DENIAL_SIGNALS.some((s) => s.re.test(stripUpstreamSummary(e.error))),
  );
  if (denialError) {
    const code = classifyProviderAuthCode(stripUpstreamSummary(denialError.error));
    evidence.push({ eventType: "run.error", fact: `provider access denied（${code}）` });
    return { category: "provider_auth", code, evidence };
  }

  const authError = evs.find(
    (e) => e.type === "run.error" && typeof e.error === "string"
      && AUTH_SIGNAL.test(stripUpstreamSummary(e.error)),
  );
  if (authError) {
    evidence.push({ eventType: "run.error", fact: `认证/身份验证类错误：${authError.error}` });
    return { category: "provider_auth", code: classifyProviderAuthCode(stripUpstreamSummary(authError.error)), evidence };
  }

  // A capacity limit is a bound terminal execution fact, not static registry
  // readiness. Use only the last run.error immediately preceding an explicit,
  // same-run failed transition. This prevents findState's legacy run.error
  // fallback, an earlier transient 429, or cross-run text from preempting the
  // actual terminal cause. Process backends report provider exits in phase=wait.
  const terminalError = findTerminalProviderError(evs, expectedRunId);
  const capacityError = terminalError
    && classifyProviderCapacityCode(stripUpstreamSummary(terminalError.error)) !== null
    ? terminalError
    : null;
  if (capacityError) {
    const code = classifyProviderCapacityCode(stripUpstreamSummary(capacityError.error));
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

  // 4.4) zcode 上游摘要升级：本运行最后一条 run.error 是带摘要的 zcode 收口/
  //      失败文案，且链尾（本轮最后一个主轮请求）model_request_failed、状态码
  //      在限流/认证闭集（429/401/403）→ 按状态码升级根因。排序：后于通用
  //      auth/config/capacity 文本规则与 timeout/budget/scorecard（真错误文本与
  //      既有终局原因先判——结论不被摘要覆盖），先于
  //      evidence_passed_backend_failed（升级出的 provider_capacity/
  //      provider_auth 与通用规则同款优先级：上游终态失败是更具体的根因）。
  //      升级时转录里有通过的证据审计（run.evidence_audit passed:true）→ 补一条
  //      静态事实「有产出」，Lead 不因升级漏看产出事实。
  if (state === "failed" && lastUpstream !== null
    && lastUpstream.status === "model_request_failed"
    && (lastUpstream.statusCode === 429 || lastUpstream.statusCode === 401
      || lastUpstream.statusCode === 403)) {
    const detail = upstreamDetailText(lastUpstream);
    const evidenceAudit = evs.find((e) => e.type === "run.evidence_audit" && e.passed === true);
    if (lastUpstream.statusCode === 429) {
      evidence.push({
        eventType: "run.error",
        fact: `zcode 上游摘要：本轮最后一个主轮请求以 model_request_failed 结束${detail}——限流类信号（rate_limited）；单凭 429 不能断言额度耗尽`,
      });
      if (evidenceAudit) {
        evidence.push({ eventType: "run.evidence_audit", fact: "有产出（证据审计通过），需人工确认" });
      }
      return { category: "provider_capacity", code: "rate_limited", evidence };
    }
    evidence.push({
      eventType: "run.error",
      fact: `zcode 上游摘要：本轮最后一个主轮请求以 model_request_failed 结束${detail}——认证/授权类失败（unauthorized）`,
    });
    if (evidenceAudit) {
      evidence.push({ eventType: "run.evidence_audit", fact: "有产出（证据审计通过），需人工确认" });
    }
    return { category: "provider_auth", code: "unauthorized", evidence };
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
      // 收口带 started/completed 链尾的摘要时（不升级、不归流中断）附中性摘要
      // 事实——只陈述链尾，结论仍是「有产出需人工确认」。
      if (pendingUpstreamFact !== null) evidence.push(pendingUpstreamFact);
      return { category: "evidence_passed_backend_failed", evidence };
    }
  }

  // 4.55) runs settle 结算的 process_missing 运行：终态 failed、理由
  //      process_missing、带确认事实（与 classifyRecoveryCandidate 同一判据族，
  //      与载荷字段无关）。排在 evidence_passed_backend_failed 之后——M12-19
  //      交付恢复运行若带通过的证据审计仍归后者，不因本规则翻成 unknown；
  //      排在 provider_disconnect/no_effect/crash 之前——结算运行没有终态
  //      run.error 事实，不应被活动类规则抢归类。只在转录里没有 run.error
  //      时适用：runner 写完 run.error、没来得及写终态就死了的运行，结算后
  //      原因仍在转录里，交给下面按 run.error 归类的规则。
  if (state === "failed" && !evs.some((e) => e.type === "run.error")) {
    const settledChange = evs.find(
      (e) => e.type === "run.state_change"
        && e.to === "failed"
        && e.reason === STATE_CHANGE_REASON.process_missing,
    );
    if (settledChange && evs.some((e) => e.type === PROCESS_MISSING_CONFIRMED_TYPE)) {
      return {
        category: "unknown",
        evidence: [
          {
            eventType: PROCESS_MISSING_CONFIRMED_TYPE,
            fact: "runner 与会话进程都已不在，转录里没有终态记录，由 Lead 事后结算",
          },
          {
            eventType: PROCESS_MISSING_CONFIRMED_TYPE,
            fact: "原因不在转录内",
          },
        ],
      };
    }
  }

  // 4.6) provider_disconnect：provider 侧流中断（非 runtime 真崩）。判据：
  //      ① 本运行最后一条 run.error 是 zcode 静默收口文案——上游额度窗口用尽时
  //      模型流停下来，backend 有界收口（三道门之一）。无上游摘要的文案（历史
  //      转录，或本轮主轮请求链状态
  //      未知）：收口本身不带上游原因。带摘要但不升级的文案走本条的「带摘要
  //      事实」变体——事实带链尾状态与次数，不再写「收口本身不带上游原因」。
  //      这类 run 此前落 no_effect/crash，且文案里的毫秒读数曾把 AUTH_SIGNAL 的
  //      裸 401 误触发成 provider_auth（已改 \b401\b）。排序：真认证/配置冲突/
  //      额度规则之后（上游真给了错误文本的仍按那些规则判），
  //      evidence_passed_backend_failed 之后（有产出的运行仍归后者），
  //      no_effect/crash 之前。证据只给事实；不给处方、不回显原文。
  if (state === "failed") {
    const gate = lastErrorEvent !== null
      ? SILENT_CLOSEOUT_GATES.find((g) => g.re.test(lastErrorEvent.error))
      : undefined;
    if (gate) {
      // "无生命体征"只在收口文案自己带着取样结论时才写：进程活动取样不可用时，零 part 两道
      // 门的文案不带这一句。
      const silence = /no vital signs/.test(lastErrorEvent.error) ? "无生命体征的静默后" : "静默到点后";
      evidence.push({
        eventType: "run.error",
        fact: `zcode 有界收口（${SILENT_CLOSEOUT_GATE_FACTS[gate.gate]}）：${silence}由控制面收口，run 以 failed 终态`,
      });
      evidence.push({
        eventType: "run.error",
        fact: lastUpstream !== null
          ? upstreamDisconnectFact(lastUpstream)
          : "静默收口本身不带上游原因——额度窗口用尽、限流与网络中断在本转录内无法区分（provider 流中断）",
      });
      return { category: "provider_disconnect", evidence };
    }
    // ①' zcode 以失败结束本轮（step-finish reason error）的文案带摘要（绑定本
    //    运行最后一条 run.error）：链尾 failed/stream_stalled/retry_scheduled →
    //    provider_disconnect（轮次失败且请求没有成功完成——流中断仍是最诚实的
    //    归因）；链尾 started/completed → 不归本类（请求已完成、轮次却失败，
    //    不虚构「流中断」），照原路径走、只附 pendingUpstreamFact。
    if (lastUpstream !== null && ZCODE_TURN_FAILED_SIGNAL.test(lastErrorEvent.error)
      && (lastUpstream.status === "model_request_failed"
        || lastUpstream.status === "model_stream_stalled"
        || lastUpstream.status === "model_retry_scheduled")) {
      evidence.push({
        eventType: "run.error",
        fact: "zcode 以失败结束本轮（step-finish reason error）",
      });
      evidence.push({
        eventType: "run.error",
        fact: upstreamDisconnectFact(lastUpstream),
      });
      return { category: "provider_disconnect", evidence };
    }
  }

  // 4.6) 本运行最后一条 run.error 是 kimi-web 静默收口文案 → 逐门判定（与 zcode
  //      同一槽位、同一绑定；门表见
  //      KIMI_WEB_SILENT_CLOSEOUT_GATES）。kimi-web 车道的 turn 迟迟没有进展时
  //      backend 有界收口，文案由控制面自己写。证据只写门表里的静态事实——哪道门
  //      收的口、serve 当时怎么说（turn 未出现两道门与两道历史门没有问 serve；停滞门
  //      记 serve 的作证状态），以及收口本身不带上游原因；毫秒读数与拍数不回显、不给
  //      处方。排序与 zcode 相同：auth/config/capacity 之后（上游真给了错误文本的仍
  //      按那些规则判，如 "kimi turn failed (… 429 …)" 归 provider_capacity），
  //      no_effect/crash 之前；空答复收口（"kimi turn completed without assistant
  //      text …"）不在门表内，照既有优先级走。
  if (state === "failed") {
    const gate = lastErrorEvent !== null
      ? KIMI_WEB_SILENT_CLOSEOUT_GATES.find((g) => g.re.test(lastErrorEvent.error))
      : undefined;
    if (gate) {
      evidence.push({
        eventType: "run.error",
        fact: `kimi-web 有界收口（${gate.gate} 门）：${gate.fact}；run 以 failed 终态`,
      });
      evidence.push({ eventType: "run.error", fact: gate.causeFact });
      return { category: gate.category, evidence };
    }
  }

  //      ② TD-74 严格签名：worker 活跃工作后，末段静默 ≥阈值 才 exit≠0。
  //      判据保守（Lead 定：静默阈值 120s、死前≥3 run.event、宁漏贴勿误贴）。
  //      M9-5P 修复：此严格签名必须优先于通用 no_effect——否则一个同时满足
  //      "有活动无产出"（no_effect）和 "≥3 events + ≥120s 静默 + exit crash"
  //      （provider_disconnect）的 run 会被 no_effect 抢先误判。真实样本
  //      run_202607082124125368q0r9t（14 events, 266s 静默, exit 1）即此 case。
  //      排在 crash 之前：否则会被 CRASH_EXIT_SIGNAL 抢归 crash。
  const exitCrashForPd = evs.find(
    (e) => e.type === "run.error" && typeof e.error === "string" && CRASH_EXIT_SIGNAL.test(e.error),
  );
  if (state === "failed" && exitCrashForPd && !evs.some((e) => e.type === "run.completed")) {
    // 控制面自己观察到的体征（进程在干活 / 文件有变化 / 服务端自述）不是 provider
    // 流里出来的事件——不计入"曾在出流"的条数，也不当作最后活动。
    const activityEvents = evs.filter((e) => e.type === "run.event" && !isObservedVitalSign(e));
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
      if (pendingUpstreamFact !== null) evidence.push(pendingUpstreamFact);
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
    // TD-180（Owner 2026-10-12 裁定：不自动重试，把事实和已知经验交给 Lead）：
    // 进程退出前一条 worker 事件都没有时，把这一点单列出来。本模块只给事实
    // （铁律：不给处方）——看不到事件不等于没有副作用；"同形故障此前怎么处置"
    // 属于知识，放在 docs/troubleshooting.md，这里只留指针。
    if (!evs.slice(0, evs.indexOf(exitCrash)).some((e) => e.type === "run.event" && !isObservedVitalSign(e))) {
      const sessionAt = Date.parse(evs.find((e) => e.type === "session.created")?.ts);
      const exitAt = Date.parse(exitCrash.ts);
      const life = Number.isFinite(sessionAt) && Number.isFinite(exitAt)
        ? `（会话建立后 ${Math.max(0, Math.round((exitAt - sessionAt) / 1000))}s 退出）`
        : "";
      evidence.push({
        eventType: "run.error",
        fact: `进程退出前未观察到任何 worker 事件${life}；未观察到事件不等于没有副作用（零 worker 事件退出的既往案例见 docs/troubleshooting.md §7.15）`,
      });
    }
    return { category: "crash", evidence };
  }

  // 7) 有失败终态但无明确信号 → unknown（不强归类）。zcode 收口带 started/
  //    completed 链尾的摘要时仍附中性摘要事实（只陈述链尾）。
  if (state === "failed" || state === "aborted" || state === "timed_out") {
    return { category: "unknown", evidence: pendingUpstreamFact !== null ? [pendingUpstreamFact] : [] };
  }

  // 空输入 / 无状态（无法判断）→ unknown。仍在运行（非终态）→ none（无失败可诊断）。
  if (!state) return { category: "unknown", evidence: [] };
  return { category: "none", evidence: [] };
}
