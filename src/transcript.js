import { appendFile, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createSecretRedactor } from "./secretRedaction.js";
import { isValidCanonicalAgentId } from "./canonicalAgentId.js";
import {
  isCanonicalCommitId,
  isPathAllowed,
  isValidRepoRelativePath,
  VERIFICATION_TIMEOUT_MS_MIN,
  VERIFICATION_TIMEOUT_MS_MAX,
  VERIFICATION_TIMEOUT_MS_DEFAULT,
} from "./delivery.js";

const APPEND_LOCK_TIMEOUT_MS = 5000;
const APPEND_LOCK_STALE_MS = 30000;
// TD-71: the append-lock poll interval. Reused by BOTH the EEXIST wait path and
// the transient EPERM/EBUSY retry path so there is one timeout/poll policy — no
// second timeout source is introduced by the Windows retry fix.
const APPEND_LOCK_POLL_MS = 5;

export const RUN_STATES = [
  "pending",
  "submitted",
  "running",
  "completed",
  "failed",
  "aborted",
  "timed_out",
];

export const TERMINAL_STATES = ["completed", "failed", "aborted", "timed_out"];

// Round 4 Bundle A（2026-08-16，Owner 批准的冻结契约——TD-120 豁免款）：
// `run.state_change` 事件 `reason` 字段的**写入侧冻结闭集** SSOT。
//
// 诊断（diagnosis.js）、恢复分类（classifyRecoveryCandidate）、失败来源投影
// （runObservationProjection.js）逐字消费这些字符串——拼写漂移会让诊断**静默**
// 失真。此前值散落在生产者代码里、没有单一权威清单；本数组是穷尽清点后的
// 唯一权威（成员变更 = 契约变更，须同步守卫 test/isolation-infra/
// stateChangeReasons.test.js 的 deepEqual 清单）。
//
// 边界（与 REVERIFY_REASONS / CORRECTION_REJECTION_REASONS 同款治理，但语义不同）：
//   - 冻结约束作用于**写入侧生产者**：生产者一律引用 STATE_CHANGE_REASON 成员，
//     不再自带字面量。读侧不校验——历史 transcript 的遗产值（如 start/init）与
//     测试合成值合法存续，不入集。
//   - 同名但属其它事件 payload 的字面量不入集：`replay`（run.rerun payload）、
//     `first_terminal_wins`（run.state_change_rejected payload）、run.aborted 的
//     payload.reason（与同批 state_change reason 同值，经转移调用点枚举）。
//   - 非终态转移（→pending/submitted/running）与终态转移（→completed/failed/
//     aborted/timed_out）共用本闭集：诊断按 to + reason 组合消费。
export const STATE_CHANGE_REASONS = Object.freeze([
  // ── 非终态生命周期 ──
  "created", // RunManager.start / backgroundRunner 启动兜底：初始 pending
  "background_spawned", // runDispatch / runContinue：后台派发初始 pending
  "spawned", // RunManager.start：backend spawn 成功 → submitted
  "replay_respawned", // RunManager.resume：进程类 backend 重放 respawn → submitted
  "first_event", // Run.waitForCompletion markRunningOnce：首个非 message 事件 → running
  "first_message", // Run.waitForCompletion markRunningOnce：首个 message → running
  // ── 终态 completed ──
  "done", // Run.waitForCompletion：backend 报 completed（含 delivery 打包成功路径）
  // ── 终态 timed_out ──
  "timeout", // Run.waitForCompletion：wall-clock deadline timer 触发（唯一 timed_out 来源）
  // ── 终态 aborted（abort 家族；同值随 run.aborted payload.reason 一并落盘）──
  "stop_requested", // runStop processStop/opencodeStop：Lead stop 命令 claim aborted
  "external_signal", // Run.waitForCompletion：外部 AbortSignal 打断等待
  "user", // RunManager.abort / Run.abort 的默认 reason
  "SIGINT", // gracefulShutdown 默认 reason（进程级 SIGINT handler）
  "daemon_stop", // daemon stop()：daemon 关闭时 abortAll
  "ipc_stop", // daemon handleRequest(stop)：IPC stop 命令 abort
  // ── 终态 failed ──
  "spawn_error", // RunManager.start：backend.spawn 抛错
  "startup_error", // backgroundRunner 启动兜底：runner 启动失败
  "delivery_parse_error", // backgroundRunner runMain：--delivery-json 解析失败 fail-closed
  "reuse_worktree_parse_error", // backgroundRunner runMain：--reuse-worktree-json 解析失败 fail-closed
  "certification_gate", // RunManager.start：认证新鲜度门拒绝派发
  "fire_forget_guard", // RunManager.start：fire-and-forget 孤儿 session 护栏拒绝
  "workdir_escape", // Run.waitForCompletion：写越界（isolation violation）
  "budget_exceeded", // Run.waitForCompletion：token 预算硬闸
  "scorecard_failed", // Run.waitForCompletion：scorecard 证据门未过
  "delivery_failed", // Run.waitForCompletion：delivery 打包失败
  "backend_error", // Run.waitForCompletion：backend 报 failed
  "backend_stream_ended", // Run.waitForCompletion：事件流无 done 结束
  "backend_unknown_reason", // Run.waitForCompletion：未知非空 done reason fail-closed
  "process_missing", // runDeliveryRepackage：Lead 授权孤儿进程结算（见 PROCESS_MISSING_RECOVERY_REASON）
]);

// 写入侧成员引用视图：生产者/消费者一律经 `STATE_CHANGE_REASON.<member>` 引用
// 成员（值 === 成员名），使词汇表只存在于上方数组一处。注意：对不存在成员的
// 属性访问得到 undefined——这正是守卫测试钉死成员清单（deepEqual）要暴露给
// 评审的漂移面；从数组移除成员而不更新全部引用会被守卫与关系断言一并打红。
export const STATE_CHANGE_REASON = Object.freeze(
  Object.fromEntries(STATE_CHANGE_REASONS.map((reason) => [reason, reason])),
);

// M12-1S2: the closed set of final delivery verification outcome event types.
// Shared by validateDeliveryFacts, tryAppendRepackageVerification, and the
// repackage idempotency scans so there is one outcome-type set in this module.
const DELIVERY_VERIFICATION_OUTCOME_TYPES = new Set([
  "run.delivery_verification_passed",
  "run.delivery_verification_failed",
  "run.delivery_verification_unavailable",
]);
const DELIVERY_VERIFICATION_OUTCOMES = new Set(["passed", "failed", "unavailable"]);

// M12-6 Package 3B: the reverify audit chain. A Lead may request ONE audited
// re-verification of the SAME immutable DeliveryRef after an environment/
// tooling-invalid verification failure. The reverify chain is a SEPARATE audit
// dimension from the original verification outcome: its event types are
// `run.delivery_reverification_*` (distinct from `run.delivery_verification_*`),
// so validateDeliveryFacts's "exactly one verification outcome" counting is
// unaffected (zero drift for every existing caller). The effective verification
// truth is the reverify outcome ONLY when exactly one bound requested + one
// bound outcome exist; otherwise the original verification status stands, and a
// malformed chain is surfaced (reverifyStatus) — never hidden.
const DELIVERY_REVERIFICATION_OUTCOME_TYPES = new Set([
  "run.delivery_reverification_passed",
  "run.delivery_reverification_failed",
  "run.delivery_reverification_unavailable",
]);
const DELIVERY_REVERIFICATION_OUTCOMES = new Set(["passed", "failed", "unavailable"]);

// M12-6 Package 3B1: the frozen closed set of verification failure codes a
// durable reverify OUTCOME ref may carry — the verification contract's setup/
// assertion phase codes plus artifact_mutated (priority content-integrity
// code). The SINGLE allowlist, shared by the transcript CAS projection + append
// gate and the application service's safe-result echo — there is no second
// allowlist. Defined + frozen here (not the application service) so the
// transcript CAS primitive can validate without an import cycle, same as
// REVERIFY_REASONS.
export const REVERIFY_FAILURE_CODES = Object.freeze([
  "command_failed",
  "command_timeout",
  "execution_error",
  "setup_failed",
  "setup_timeout",
  "setup_environment_error",
  "artifact_mutated",
]);

// M12-6 Package 3B: the frozen closed set of Lead-declared reverify reasons. A
// reverify is an EXCEPTIONAL Lead-declared recovery — never a retry, never
// command replacement, never automatic acceptance. The reason records WHY the
// original verification failure is treated as environment/tooling-invalid.
// Defined + frozen here (not the application service) so the transcript CAS
// primitive can validate it without an import cycle; the application service
// and the MCP schema consume this same SSOT.
export const REVERIFY_REASONS = Object.freeze([
  "tooling_invalid",
  "environment_contaminated",
  "dependency_setup_missing",
]);

// M12-16: the in-flight correction queue. A Lead may queue a bounded follow-up
// user turn to a RUNNING correctable run (opt-in at dispatch) through the
// transcript, which a detached runner reads + claims + delivers over the live
// provider stdin. WAO never interrupts/preempts, never auto-stops/retries, and
// never judges semantics — "delivered" proves only that the bytes were accepted
// by the runtime stdin, NOT that the model executed the turn.
//
// The durable correction lifecycle is a chain of events on the SAME run
// transcript, bound to the runId envelope like every other fact:
//   run.correction_requested { correctionId, prompt }   — MCP appends (queue)
//   run.correction_claimed   { correctionId }            — runner atomically claims
//   run.correction_delivered { correctionId }            — runner wrote to provider stdin
//   run.correction_delivery_failed { correctionId, reason } — stdin write refused
//   run.correction_rejected  { correctionId, reason }    — terminal race / no delivery
//
// correctionId is a Lead-supplied stable id (closed alphabet, ≤64 chars): the
// exactly-once key. prompt is bounded (≤15000 chars) and redacted on store like
// prompt.sent. The prompt is re-read by the runner for delivery; safe query
// surfaces (run_activity) project these events as status only — never the body.
//
// Defined + frozen here so the transcript CAS primitives, the application
// service, and the MCP schema consume ONE closed set (no drift, no import cycle).
const CORRECTION_ID_RE = /^[A-Za-z0-9_-]+$/;
const CORRECTION_ID_MAX_LEN = 64;
const CORRECTION_PROMPT_MAX_LEN = 15000;

// M12-16: the closed set of Lead-facing correction OUTCOMES returned by
// run_correct (queued = just appended this call; pending = already queued, not
// yet delivered; delivered = the runner wrote it to provider stdin; rejected =
// refused or never deliverable). queued≠delivered≠executed.
export const CORRECTION_OUTCOMES = Object.freeze(["queued", "pending", "delivered", "rejected"]);

// M12-16: the closed set of correction rejection / non-delivery reasons. Every
// refusal (at queue time or at delivery time) records one of these — it is a
// normal closed-set outcome, NEVER a generic tool error. The runner's delivery
// failures use stdin_closed / send_failed; terminal race (provider finished
// before the queued turn could be delivered) uses terminal_race; queue-time
// refusals use the rest.
export const CORRECTION_REJECTION_REASONS = Object.freeze([
  "malformed_input", // correctionId / prompt shape failed validation
  "unknown_run", // no transcript / no envelope for the runId
  "workspace_mismatch", // run ownership != authorized workspace
  "not_correctable", // run was not dispatched with correctable:true
  "not_ready", // run not yet at a correctable-eligible state
  "terminal_run", // run already terminal at queue time (queue-time race)
  "duplicate", // correctionId already queued with a DIFFERENT prompt body
  "already_delivered", // correctionId already delivered; re-queue refused
  "terminal_race", // queued but provider terminated before delivery
  "stdin_closed", // provider stdin was closed when delivery was attempted
  "send_failed", // bounded stdin write failed for another reason
]);

// M12-16: the reasons a runner-side delivery may fail (closed subset of
// CORRECTION_REJECTION_REASONS). The sendCorrection handle contract returns one
// of these; the runner records run.correction_delivery_failed with it.
const CORRECTION_DELIVERY_FAIL_REASONS = Object.freeze(["stdin_closed", "send_failed"]);

// M12-16: internal (richer) per-correction status derived by projectCorrections.
// Excludes "queued" (that is a per-call outcome the service derives, not a
// stored status): a stored requested-but-unclaimed correction is "pending".
const CORRECTION_STATUSES = Object.freeze([
  "pending", // requested, not yet claimed
  "claimed", // runner claimed, delivery not yet recorded
  "delivered", // runner wrote the turn to provider stdin
  "delivery_failed", // delivery attempted, stdin write refused (terminal for it)
  "rejected", // terminal race / never deliverable (terminal for it)
]);

// M12-6 Package 3B: shared input bounds for the reverify setup contract. Bound
// here for the same cycle-free reason as REVERIFY_REASONS — the transcript CAS
// primitive, the application service, and the MCP schema all consume one SSOT.
// setupCommands is OPTIONAL (a reverify may re-run the original assertions with
// no new setup); each declared command is a non-empty bounded string.
export const REVERIFY_SETUP_COMMANDS_LIMIT = 32;
export const REVERIFY_SETUP_COMMAND_MAX_LENGTH = 512;
// M12-13: the reverify timeout IS the per-command execution timeout. The
// REVERIFY_* constants are ALIASES of the shared bounds in delivery.js — one
// range, no second authority — so the reverify CLI/MCP wire bounds cannot drift
// from start/resume verification. The DEFAULT applies only when the field is
// absent; a malformed PRESENT value fails closed.
export const REVERIFY_TIMEOUT_MS_MIN = VERIFICATION_TIMEOUT_MS_MIN;
export const REVERIFY_TIMEOUT_MS_MAX = VERIFICATION_TIMEOUT_MS_MAX;
export const REVERIFY_TIMEOUT_MS_DEFAULT = VERIFICATION_TIMEOUT_MS_DEFAULT;

// M12-9: the frozen closed set of delivery-decision POLICY codes. Defined at
// the transcript decision-facts authority (validateDeliveryFacts +
// tryAppendDecision) so the thrower and the machine protocol share ONE SSOT.
// The application layer re-exports these (appending the non-error
// already_decided outcome); the MCP schema enum is built from that derivation.
// A code is thrown ONLY via DeliveryDecisionPolicyError — never parsed from a
// human message.
export const DELIVERY_DECISION_POLICY_CODES = Object.freeze([
  "verification_failed",
  "delivery_malformed",
  "terminal_not_eligible",
  "delivery_unavailable",
]);

/**
 * M12-9: the dedicated error type for delivery-decision policy rejections.
 *
 * `code` is the machine protocol (a member of DELIVERY_DECISION_POLICY_CODES);
 * `message` is human diagnostics ONLY and is never parsed by consumers — the
 * application classifier accepts nothing but this type + its closed-set code.
 */
export class DeliveryDecisionPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DeliveryDecisionPolicyError";
    this.code = code;
  }
}

export const RECOVERY_CANDIDATE_KINDS = Object.freeze([
  "disallowed_scope",
  "backend_failed",
  "process_missing",
]);
// Round 4 Bundle A: members are referenced from the STATE_CHANGE_REASONS SSOT
// (never retyped literals) and exported so the guard test can assert the
// subset relation BACKEND_RECOVERY_REASONS ⊆ STATE_CHANGE_REASONS.
export const BACKEND_RECOVERY_REASONS = new Set([
  STATE_CHANGE_REASON.backend_error,
  STATE_CHANGE_REASON.backend_stream_ended,
]);

// M12-19: the closed-set terminal reason + safe confirmation fact type that mark
// a Lead-authorized, zero-model settlement of an orphaned process-backed run
// whose detached runner/provider process is provably gone. Defined here (next
// to classifyRecoveryCandidate, the durable authority on the reason) so the
// application liveness SSOT (processRecovery.js) and run_delivery_repackage can
// import them without a circular dependency.
// Round 4 Bundle A: the value derives from the STATE_CHANGE_REASONS SSOT
// (guarded as a member), never a second literal.
export const PROCESS_MISSING_RECOVERY_REASON = STATE_CHANGE_REASON.process_missing;
export const PROCESS_MISSING_CONFIRMED_TYPE = "run.process_missing_confirmed";
const BACKEND_RECOVERY_CONFLICT_TYPES = new Set([
  "run.isolation_violation",
  "run.budget_exceeded",
  "run.timed_out",
  "run.aborted",
]);

function _sameDeliveryIdentity(left, right, runId) {
  return Boolean(
    left
      && right
      && typeof left === "object"
      && typeof right === "object"
      && left.runId === runId
      && right.runId === runId
      && isCanonicalCommitId(left.baseCommit)
      && isCanonicalCommitId(left.deliveryCommit)
      && left.baseCommit === right.baseCommit
      && left.deliveryCommit === right.deliveryCommit,
  );
}

function _normalizeApprovedPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return null;
  if (!paths.every((p) => isValidRepoRelativePath(p))) return null;
  const normalized = [...new Set(paths)].sort();
  if (normalized.length !== paths.length) return null;
  if (normalized.some((p, index) => p !== paths[index])) return null;
  return normalized;
}

// M12-6 Package 3B: normalize + bound the optional reverify setupCommands. Each
// command is a non-empty bounded string (trimmed); the list length is capped.
// setupCommands is the ONLY thing a Lead may add on a reverify (original
// assertion commands are immutable) — so it is validated defensively at the
// transcript CAS layer as well as in the application service.
function _normalizeReverifySetup(setupCommands) {
  if (setupCommands === undefined || setupCommands === null) return [];
  if (!Array.isArray(setupCommands)) {
    throw new Error("setupCommands must be an array");
  }
  if (setupCommands.length > REVERIFY_SETUP_COMMANDS_LIMIT) {
    throw new Error(`setupCommands exceeds ${REVERIFY_SETUP_COMMANDS_LIMIT} entries`);
  }
  const out = [];
  for (const cmd of setupCommands) {
    if (typeof cmd !== "string") {
      throw new Error("setupCommands must be strings");
    }
    const trimmed = cmd.trim();
    if (trimmed.length === 0) {
      throw new Error("setupCommands must be non-empty");
    }
    if (trimmed.length > REVERIFY_SETUP_COMMAND_MAX_LENGTH) {
      throw new Error(`setupCommand exceeds ${REVERIFY_SETUP_COMMAND_MAX_LENGTH} characters`);
    }
    out.push(trimmed);
  }
  return out;
}

function _originalAllowedPaths(events, runId) {
  const started = events.filter(
    (e) => e && e.type === "run.started" && e.runId === runId,
  );
  if (started.length !== 1) return null;
  return _normalizeApprovedPaths(started[0].delivery?.allowedPaths);
}

function _verificationOutcomeFromType(type) {
  if (type === "run.delivery_verification_passed") return "passed";
  if (type === "run.delivery_verification_failed") return "failed";
  if (type === "run.delivery_verification_unavailable") return "unavailable";
  return null;
}

/**
 * Classify the durable origin of a model-free recovery.
 *
 * Pure transcript projection only: it never reads Git or decides whether a
 * candidate is semantically acceptable. The application layer adds workspace,
 * exact-base, and complete-inventory proof before exposing or packaging a
 * backend-failed candidate.
 *
 * For process_missing, the durable proof is a Lead-confirmed settlement: one
 * terminal transition to failed carrying PROCESS_MISSING_RECOVERY_REASON AND
 * exactly one PROCESS_MISSING_CONFIRMED_TYPE confirmation fact, written
 * atomically with the transition by run_delivery_repackage. The conservative
 * liveness proof (owner lease + dead child PID) that justified the settlement is
 * a runtime fact owned by processRecovery.js — this pure projection only
 * recognizes the durable record it left behind. A lone terminal transition
 * carrying the reason WITHOUT the paired confirmation fact does NOT classify
 * (defensive: never recover on an incomplete durable record).
 *
 * @param {object[]} events
 * @param {string} runId
 * @returns {"disallowed_scope"|"backend_failed"|"process_missing"|null}
 */
export function classifyRecoveryCandidate(events, runId) {
  if (!Array.isArray(events) || typeof runId !== "string" || runId.length === 0) return null;
  const bound = events.filter((event) => event && event.runId === runId);
  const failures = bound.filter((event) => event.type === "run.delivery_failed");
  if (failures.length === 1 && failures[0].deliveryCode === "disallowed_path") {
    return "disallowed_scope";
  }
  if (failures.length !== 0) return null;

  const terminalTransitions = bound.filter(
    (event) => event.type === "run.state_change" && TERMINAL_STATES.includes(event.to),
  );
  if (terminalTransitions.length !== 1) return null;
  const terminalTransition = terminalTransitions[0];
  if (terminalTransition.to !== "failed") return null;

  // process_missing: a Lead-confirmed orphan settlement. The closed-set terminal
  // reason + exactly one safe confirmation fact (written atomically with the
  // transition) is the durable record; same conflict / scorecard gates as the
  // other recovery kinds. No stop_verified requirement — the orphaned process
  // died without a clean stop; the confirmation fact is the safe substitute.
  if (terminalTransition.reason === PROCESS_MISSING_RECOVERY_REASON) {
    const confirmations = bound.filter(
      (event) => event.type === PROCESS_MISSING_CONFIRMED_TYPE,
    );
    if (confirmations.length !== 1) return null;
    if (bound.some((event) => BACKEND_RECOVERY_CONFLICT_TYPES.has(event.type))) return null;
    if (bound.some((event) => event.type === "scorecard.checked" && event.passed === false)) return null;
    return "process_missing";
  }

  if (!BACKEND_RECOVERY_REASONS.has(terminalTransition.reason)) return null;
  if (!bound.some((event) => event.type === "run.stop_verified")) return null;
  if (bound.some((event) => event.type === "run.stop_unverified")) return null;
  if (bound.some((event) => BACKEND_RECOVERY_CONFLICT_TYPES.has(event.type))) return null;
  if (bound.some((event) => event.type === "scorecard.checked" && event.passed === false)) return null;
  return "backend_failed";
}

/**
 * Return the one valid recovery provenance for a created DeliveryRef, or null.
 * This is the shared durable-chain authority for readiness and Lead acceptance.
 */
export function findValidRepackageProvenance(events, runId, createdRef) {
  if (!Array.isArray(events) || !_sameDeliveryIdentity(createdRef, createdRef, runId)) return null;
  if (!Array.isArray(createdRef.changedFiles) || createdRef.changedFiles.length === 0) return null;
  if (!createdRef.changedFiles.every((p) => isValidRepoRelativePath(p))) return null;

  const recoveryKind = classifyRecoveryCandidate(events, runId);
  if (!recoveryKind) return null;

  const provenance = events.filter(
    (e) => e && e.type === "run.delivery_repackaged" && e.runId === runId,
  );
  if (provenance.length !== 1) return null;
  const event = provenance[0];
  if (!_sameDeliveryIdentity(event.delivery, createdRef, runId)) return null;
  if (event.source !== "packaged" && event.source !== "recovered") return null;
  // Older disallowed_path recovery events predate recoveryKind. Preserve those
  // durable chains, while requiring every backend-failed provenance to carry
  // the explicit closed-set kind.
  const eventKind = event.recoveryKind
    ?? (recoveryKind === "disallowed_scope" ? "disallowed_scope" : null);
  if (eventKind !== recoveryKind) return null;
  const approved = _normalizeApprovedPaths(event.approvedAllowedPaths);
  if (!approved) return null;
  const original = _originalAllowedPaths(events, runId);
  if (!original || original.some((p) => !isPathAllowed(p, approved))) return null;
  if (createdRef.changedFiles.some((p) => !isPathAllowed(p, approved))) return null;
  return event;
}

function _reverificationOutcomeFromType(type) {
  if (type === "run.delivery_reverification_passed") return "passed";
  if (type === "run.delivery_reverification_failed") return "failed";
  if (type === "run.delivery_reverification_unavailable") return "unavailable";
  return null;
}

// M12-6 Package 3B1: is this durable reverify REQUEST event envelope-bound to
// runId, identity-bound to createdRef, top-level-commit-bound, and shape-valid
// (closed-set reason, bounded setupCommands)? Any failure — a foreign envelope
// runId, a mismatched embedded identity (runId/commit/base/artifact), a
// missing/noncanonical/different top-level deliveryCommit, an unknown reason,
// or blank/non-string/too-many/too-long setup commands — marks the event as a
// durable CONFLICT: the chain must project "malformed" and the CAS primitives
// must refuse to reuse or extend it.
function _isValidReverifyRequestedEvent(event, runId, createdRef) {
  if (!event || typeof event !== "object") return false;
  if (event.runId !== runId) return false;
  if (!_sameDeliveryIdentity(event.delivery, createdRef, runId)) return false;
  // M12-6 Package 3B1: the event's top-level deliveryCommit must be canonical
  // AND equal to the embedded immutable deliveryCommit (hence the created
  // commit). A missing/noncanonical/different value is a durable conflict —
  // the CAS must never reuse the request for verification.
  if (!isCanonicalCommitId(event.deliveryCommit)) return false;
  if (event.deliveryCommit !== event.delivery.deliveryCommit) return false;
  if (!REVERIFY_REASONS.includes(event.reason)) return false;
  // setupCommands is optional (a reverify may re-run the original assertions
  // with no new setup); when present it must be a bounded list of non-empty
  // bounded strings — the same contract the appender enforces.
  if (event.setupCommands === undefined) return true;
  if (!Array.isArray(event.setupCommands)) return false;
  if (event.setupCommands.length > REVERIFY_SETUP_COMMANDS_LIMIT) return false;
  return event.setupCommands.every(
    (cmd) => typeof cmd === "string"
      && cmd.trim().length > 0
      && cmd.length <= REVERIFY_SETUP_COMMAND_MAX_LENGTH,
  );
}

// M12-6 Package 3B1: is this durable reverify OUTCOME event envelope-bound to
// runId, identity-bound to createdRef, AND top-level-commit-bound (canonical
// top-level deliveryCommit equal to the embedded immutable commit)?
// Verification-contract validation is a separate step
// (_isValidReverifyOutcomeEvent); this helper is the envelope/identity/binding
// half of the conflict test.
function _isBoundReverifyOutcomeEvent(event, runId, createdRef) {
  return Boolean(
    event
      && typeof event === "object"
      && event.runId === runId
      && _sameDeliveryIdentity(event.delivery, createdRef, runId)
      && isCanonicalCommitId(event.deliveryCommit)
      && event.deliveryCommit === event.delivery.deliveryCommit,
  );
}

// M12-6 Package 3B1: does this bound reverify OUTCOME event satisfy the
// verification event contract — the same contract the original verification
// outcome events must satisfy (canonical commit equality + status derived from
// the closed-set type), plus the durable reverify shape:
//   - the event type agrees EXACTLY with the embedded delivery.verification.status;
//   - verifiedCommit is canonical AND equal to the immutable deliveryCommit
//     (the embedded commit — already bound to the created commit above);
//   - a failed ref carries a CLOSED-SET failureCode (REVERIFY_FAILURE_CODES —
//     the single shared allowlist, never duplicated);
//   - an unavailable ref carries a non-empty unavailableReason.
// Any violation is a durable CONFLICT: the chain projects "malformed", the CAS
// never reuses it and never appends onto it, and the decision path never sees
// an effective pass from it.
function _isValidReverifyOutcomeEvent(event, runId, createdRef) {
  if (!_isBoundReverifyOutcomeEvent(event, runId, createdRef)) return false;
  const status = _reverificationOutcomeFromType(event.type);
  const verification = event.delivery?.verification;
  if (!status || !verification || typeof verification !== "object") return false;
  if (verification.status !== status) return false;
  if (!isCanonicalCommitId(verification.verifiedCommit)) return false;
  if (verification.verifiedCommit !== event.delivery.deliveryCommit) return false;
  if (status === "failed") {
    if (!REVERIFY_FAILURE_CODES.includes(verification.failureCode)) return false;
  } else if (status === "unavailable") {
    if (
      typeof verification.unavailableReason !== "string"
      || verification.unavailableReason.trim().length === 0
    ) {
      return false;
    }
  }
  return true;
}

/**
 * M12-6 Package 3B (3B1 fail-closed): project the reverify audit chain for a
 * run/delivery.
 *
 * Strict closed set: "none" | "pending" | "complete" | "malformed". EVERY
 * durable reverify event counts — never pre-filtered by envelope runId first.
 * An event is part of the chain only when it is envelope-bound (runId === runId)
 * AND identity-bound (embedded DeliveryRef matches createdRef: runId/baseCommit/
 * deliveryCommit) AND top-level-commit-bound (canonical top-level deliveryCommit
 * equal to the embedded immutable commit) AND — for a requested event —
 * shape-valid (closed-set reason, bounded setupCommands), and — for an outcome
 * event — verification-contract-valid (type agrees EXACTLY with the embedded
 * delivery.verification.status; verifiedCommit canonical + equal to the
 * immutable deliveryCommit; closed-set failure/unavailable shape). A reverify
 * event in a FOREIGN envelope, or bound but identity/shape/contract-mismatched,
 * is a durable conflict → "malformed" (visible, never filtered away, never
 * echoed as a clean chain).
 *
 *   none      — no valid requested, no valid outcome.
 *   pending   — exactly one valid requested, zero valid outcomes (crash-resumable).
 *   complete  — exactly one valid requested + exactly one valid outcome.
 *   malformed — any other combination (duplicate requested/outcome, orphan
 *               outcome, a foreign-envelope event, or an identity/shape/contract-
 *               mismatched event). effectiveStatus is null → the decision gate
 *               and the effective-pass projection stay at the ORIGINAL status.
 *
 * Pure transcript projection: never reads Git, never verifies, never decides.
 * The application layer adds workspace + eligibility proof before exposing a
 * reverify; this projector only describes the auditable chain shape.
 *
 * @param {object[]} events
 * @param {string} runId
 * @param {object} createdRef
 * @returns {{status, requestedEvent, outcomeEvent, reason, effectiveStatus}}
 */
export function projectReverifyChain(events, runId, createdRef) {
  const empty = {
    status: "none",
    requestedEvent: null,
    outcomeEvent: null,
    reason: null,
    effectiveStatus: null,
  };
  if (!Array.isArray(events) || !_sameDeliveryIdentity(createdRef, createdRef, runId)) {
    return empty;
  }
  // M12-6 Package 3B1: consider ALL durable reverify events — a foreign-envelope
  // event (e.g. a concatenated transcript) is a conflict, never silently ignored.
  const requested = events.filter((e) => e && e.type === "run.delivery_reverification_requested");
  const outcomes = events.filter((e) => e && DELIVERY_REVERIFICATION_OUTCOME_TYPES.has(e.type));
  const reqBound = requested.filter((e) => _isValidReverifyRequestedEvent(e, runId, createdRef));
  const outBound = outcomes.filter((e) => _isValidReverifyOutcomeEvent(e, runId, createdRef));
  // Any reverify event that is not fully bound + shape-valid is a durable
  // conflict → malformed. The conflict is VISIBLE through the status, never
  // filtered away by an envelope pre-filter.
  const hasConflict = requested.length !== reqBound.length || outcomes.length !== outBound.length;
  if (hasConflict) {
    return {
      status: "malformed",
      requestedEvent: reqBound[0] ?? null,
      outcomeEvent: outBound[0] ?? null,
      reason: reqBound[0]?.reason ?? null,
      effectiveStatus: null,
    };
  }
  if (reqBound.length === 0 && outBound.length === 0) {
    // No conflict (above) and no bound events at all → a clean "none" chain.
    return empty;
  }
  if (reqBound.length === 1 && outBound.length === 0) {
    return {
      status: "pending",
      requestedEvent: reqBound[0],
      outcomeEvent: null,
      reason: reqBound[0].reason ?? null,
      effectiveStatus: null,
    };
  }
  if (reqBound.length === 1 && outBound.length === 1) {
    return {
      status: "complete",
      requestedEvent: reqBound[0],
      outcomeEvent: outBound[0],
      reason: reqBound[0].reason ?? null,
      effectiveStatus: _reverificationOutcomeFromType(outBound[0].type),
    };
  }
  return {
    status: "malformed",
    requestedEvent: reqBound[0] ?? null,
    outcomeEvent: outBound[0] ?? null,
    reason: reqBound[0]?.reason ?? null,
    effectiveStatus: null,
  };
}

export class JsonlTranscript {
  constructor(filePath, context) {
    this.filePath = filePath;
    this.context = context;
    this.seq = Number.isInteger(context?.initialSeq) ? context.initialSeq : 0;
    this.redactor = createSecretRedactor();
  }

  redact(value) {
    return this.redactor.redact(value);
  }

  async append(type, payload = {}) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const releaseLock = await acquireAppendLock(this.filePath);
    try {
      this.seq = Math.max(this.seq, await readMaxSeq(this.filePath)) + 1;
      const event = {
        ...this.redact(payload),
        ts: new Date().toISOString(),
        seq: this.seq,
        runId: this.context.runId,
        agentId: this.context.agentId,
        type,
      };
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
      return event;
    } finally {
      await releaseLock();
    }
  }

  /**
   * TD-99：跨进程原子终态仲裁。
   *
   * 在已有 append lock 内一次完成：读事件 → 检查既有终态 → 分配 seq → 批量 append。
   * 不在持锁期间调公开 append()（避免嵌套锁死锁）——直接在锁内 readFile/appendFile。
   *
   * 仲裁规则（first terminal wins）：
   *   - 历史已有 terminal run.state_change → 拒绝任何新转移（含 running/submitted 复活）。
   *   - 有 state_change 但均非终态 → 不把 run.error/run.completed 等前置事实当终态。
   *   - 完全无 state_change → 用 findState 的 legacy fallback 判断是否有 legacy terminal
   *     fact（旧 transcript 兼容）。
   *
   * TD-100 收尾：options.attemptEvents——意图事件（如 run.stop_requested），无论
   * accepted/rejected 都同批写入。这样 stop 命令不再 claim 前单独 append stop_requested
   * （旧实现会被同一 transcript 的 _detectExistingTerminal 读到导致自拒绝），而是通过
   * attemptEvents 把 stop_requested 作为 claim 批次的一部分提交。持锁读取的旧 events
   * 不含本次 attemptEvents，不自拒绝。
   *
   * terminal 成功时，可将 terminal fact event（如 run.aborted/run.completed）与 state_change
   * 同批写入（options.factEvents），保证终态事实与状态转移原子落盘。
   * rejected 时写 run.state_change_rejected 审计事件（不静默消失），不写 factEvents。
   *
   * @param {string} from - 期望的源状态（信息性，不做严格校验）
   * @param {string} to - 目标状态
   * @param {string} reason
   * @param {{ factEvents?: Array<{type: string, payload?: object}>,
   *           attemptEvents?: Array<{type: string, payload?: object}> }} [options]
   *   factEvents: terminal 成功时同批写入（如 [{type:"run.aborted", payload:{...}}]）。
   *   attemptEvents: 无论 accepted/rejected 都同批写入（如 stop_requested）。
   * @returns {Promise<{accepted:true, state, transition, facts, attempts}|{accepted:false, state, rejection, attempts}>}
   */
  async transitionState(from, to, reason, options = {}) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const releaseLock = await acquireAppendLock(this.filePath);
    try {
      let events = [];
      try {
        events = await readTranscript(this.filePath);
      } catch {
        events = [];
      }
      const existing = _detectExistingTerminal(events);
      const baseSeq = Math.max(this.seq, findLastEventSeq(events));
      const attemptEvents = Array.isArray(options.attemptEvents) ? options.attemptEvents : [];
      const ts = new Date().toISOString();
      const ctx = { runId: this.context.runId, agentId: this.context.agentId };
      const safeReason = this.redactor.redactString(String(reason));

      // 先分配 attemptEvents 的 seq（无论 accepted/rejected 都写）。
      let seq = baseSeq;
      const lines = [];
      const writtenAttempts = [];
      for (const ae of attemptEvents) {
        seq += 1;
        const ev = { ...this.redact(ae.payload ?? {}), ts, seq, ...ctx, type: ae.type };
        lines.push(JSON.stringify(ev));
        writtenAttempts.push(ev);
      }

      if (existing) {
        // 被拒：写审计事件（锁内，与判定原子）。rejected 不写任何 terminal fact。
        const rejectionPayload = {
          attemptedTo: to,
          attemptedReason: safeReason,
          existingTerminal: existing,
          reason: "first_terminal_wins",
        };
        seq += 1;
        const rejectionEvent = { ts, seq, ...ctx, type: "run.state_change_rejected", ...rejectionPayload };
        lines.push(JSON.stringify(rejectionEvent));
        await appendFile(this.filePath, `${lines.join("\n")}\n`, "utf8");
        this.seq = seq;
        return { accepted: false, state: existing, rejection: rejectionPayload, attempts: writtenAttempts };
      }
      // 接受：构造完整 JSONL 字符串（attemptEvents + factEvents + state_change），一次 appendFile 原子落盘。
      const factEvents = Array.isArray(options.factEvents) ? options.factEvents : [];
      const written = [];
      for (const fe of factEvents) {
        seq += 1;
        const ev = { ...this.redact(fe.payload ?? {}), ts, seq, ...ctx, type: fe.type };
        lines.push(JSON.stringify(ev));
        written.push(ev);
      }
      seq += 1;
      const stateEv = { ts, seq, ...ctx, type: "run.state_change", from, to, reason: safeReason };
      lines.push(JSON.stringify(stateEv));
      await appendFile(this.filePath, `${lines.join("\n")}\n`, "utf8");
      this.seq = seq;
      return { accepted: true, state: to, transition: stateEv, facts: written, attempts: writtenAttempts };
    } finally {
      await releaseLock();
    }
  }

  /**
   * TD-103 Phase 3C-2: Atomic first-decision-wins for Lead acceptance.
   *
   * Under the existing cross-process append lock:
   *   1. read current events (in-lock, no TOCTOU);
   *   2. validate durable preconditions from in-lock events;
   *   3. check for an existing accepted/rejected event for the same deliveryCommit;
   *   4. append at most one decision event with the next seq;
   *   5. return {accepted:true, event} to the winner or
   *      {accepted:false, existing} to losers.
   *
   * Durable preconditions (checked in-lock, not in the CLI):
   *   - exactly one run.delivery_created event;
   *   - exactly one verification outcome event (passed/failed/unavailable);
   *   - verification event's deliveryCommit must match delivery_created's;
   *   - reject only allowed when verification status ∈ {passed, failed, unavailable};
   *   - accept requires terminal state completed + verification passed.
   *
   * The event contains a new DeliveryRef value equal to the latest verified
   * DeliveryRef except acceptance.status becomes "accepted" or "rejected",
   * plus deliveryCommit, reviewerType:"lead_agent", and the trimmed+redacted reason.
   *
   * Narrow primitive — not a workflow engine, database, or state machine.
   * Reuses the current redactor. Append failure propagates; never reports
   * acceptance before durable transcript write.
   *
   * @param {{decision: "accepted"|"rejected", reason: string}} input
   * @returns {Promise<{accepted:true, event:object}|{accepted:false, existing:object}>}
   * @throws {DeliveryDecisionPolicyError} with the closed-set code if durable
   *   preconditions are not met (message is human diagnostics only)
   */
  async tryAppendDecision({ decision, reason }) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const releaseLock = await acquireAppendLock(this.filePath);
    try {
      let events = [];
      try {
        events = await readTranscript(this.filePath);
      } catch {
        events = [];
      }

      // In-lock fact validation — single owner of delivery facts.
      const facts = validateDeliveryFacts(events);
      if (facts.error) {
        // M12-9: throw the DEDICATED policy type carrying the structured fact
        // category (facts.code). The human `facts.error` message is retained
        // ONLY for internal diagnostics — it is never the machine protocol.
        throw new DeliveryDecisionPolicyError(facts.code, facts.error);
      }

      // Decision-specific gate (also in-lock).
      const terminalState = findState(events);
      // M12-6 Package 3B: the accept/reject gate consults the EFFECTIVE
      // verification status. With no reverify chain this equals the original
      // status (zero drift). With a complete valid reverify chain it equals the
      // reverify outcome — so a Lead may ACCEPT after a reverify that passed,
      // even though the original verification failed. A malformed reverify chain
      // leaves the effective status at the (still-failed) original, so acceptance
      // fails closed; it is never auto-accepted and never silently hidden.
      const verificationStatus = facts.effectiveVerificationStatus;
      if (decision === "accepted") {
        // Accept ALWAYS requires a passed (effective) verification, for both the
        // normal completed path, the recovery path, and the reverify path.
        if (verificationStatus !== "passed") {
          // M12-9: typed policy rejection; message kept for diagnostics only.
          throw new DeliveryDecisionPolicyError("verification_failed", `Cannot accept: delivery verification is ${verificationStatus}, must be passed`);
        }
        // M12-1S2: widen the terminal gate to admit an explicit recovery accept.
        // A terminally-failed run whose durable failure is exactly disallowed_path
        // AND has been superseded by a provenance-bound model-free repackage
        // (facts.recoveryAcceptable) may be Lead-accepted. The terminal failed is
        // NOT rewritten to completed; this gate merely admits the accept. Any
        // other failed/terminal state still rejects. Normal completed runs are
        // untouched (zero drift).
        const recoveryEligible = terminalState === "failed" && facts.recoveryAcceptable === true;
        if (terminalState !== "completed" && !recoveryEligible) {
          throw new DeliveryDecisionPolicyError(
            "terminal_not_eligible",
            `Cannot accept: run terminal state is ${terminalState}, must be completed (or a recovery-eligible failed run)`,
          );
        }
      } else {
        // reject: only allowed when verification has a final outcome
        if (!["passed", "failed", "unavailable"].includes(verificationStatus)) {
          throw new DeliveryDecisionPolicyError("verification_failed", `Cannot reject: delivery verification is ${verificationStatus}, must be passed/failed/unavailable`);
        }
      }

      const deliveryCommit = facts.deliveryCommit;
      // M12-6 Package 3B: stamp acceptance onto the EFFECTIVE DeliveryRef when a
      // complete reverify chain exists (its outcome ref carries the effective
      // verification status); otherwise the original latest verification ref.
      const deliveryRef = facts.effectiveRef ?? facts.latestRef;
      const decisionType = decision === "accepted"
        ? "run.delivery_accepted"
        : "run.delivery_rejected";

      // Check for existing decision event for the same deliveryCommit.
      if (facts.decisionEvent) {
        return {
          accepted: false,
          existing: {
            type: facts.decisionEvent.type,
            status: facts.decisionEvent.type === "run.delivery_accepted" ? "accepted" : "rejected",
            deliveryCommit: facts.decisionEvent.deliveryCommit,
          },
        };
      }

      // Build the new DeliveryRef with updated acceptance status.
      const newRef = {
        ...deliveryRef,
        acceptance: {
          status: decision,
          reviewerType: "lead_agent",
        },
      };
      const trimmedReason = String(reason).trim();
      const baseSeq = Math.max(this.seq, findLastEventSeq(events));
      const seq = baseSeq + 1;
      const ts = new Date().toISOString();
      const ctx = { runId: this.context.runId, agentId: this.context.agentId };
      const event = {
        ...this.redact({ delivery: newRef, deliveryCommit, reason: trimmedReason }),
        ts, seq, ...ctx, type: decisionType,
      };
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
      this.seq = seq;
      return { accepted: true, event };
    } finally {
      await releaseLock();
    }
  }

  /**
   * M12-1S2: lock-scoped idempotent append of the repackage delivery_created +
   * recovery provenance (run.delivery_repackaged).
   *
   * Under the cross-process append lock: re-read events; if a bound
   * run.delivery_created already exists, yield {created:false, ref}; otherwise
   * validate the candidate DeliveryRef (canonical commits, runId-bound) and
   * append BOTH run.delivery_created and run.delivery_repackaged atomically in a
   * single appendFile (same lock, same batch) — so the provenance can never
   * exist without its created event, and a concurrent/retry caller observes
   * either both or neither.
   *
   * Narrow primitive: it does NOT package, verify, decide, or infer scope. The
   * candidate DeliveryRef + approvedAllowedPaths + source are supplied by the
   * caller (the model-free repackage service), which has already proved them
   * against Git exact objects. Packaging/verification happen OUTSIDE this lock
   * (contract #5); only the short read/validate/CAS-append is lock-scoped.
   *
   * @param {{delivery: object, approvedAllowedPaths: string[],
   *   source: "packaged"|"recovered",
   *   recoveryKind?: "disallowed_scope"|"backend_failed"}} input
   * @returns {Promise<{created:true, ref:object}|{created:false, ref:object}>}
   * @throws {Error} if the candidate DeliveryRef is malformed/non-canonical
   */
  async tryAppendRepackageCreated({
    delivery,
    approvedAllowedPaths,
    source,
    recoveryKind,
  } = {}) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const releaseLock = await acquireAppendLock(this.filePath);
    try {
      let events = [];
      try {
        events = await readTranscript(this.filePath);
      } catch {
        events = [];
      }

      const existingEvents = events.filter(
        (e) => e && e.type === "run.delivery_created" && e.runId === this.context.runId,
      );
      if (existingEvents.length > 1) {
        throw new Error("tryAppendRepackageCreated: multiple delivery_created events");
      }
      if (existingEvents.length === 1) {
        const existing = existingEvents[0];
        const provenance = findValidRepackageProvenance(
          events,
          this.context.runId,
          existing.delivery,
        );
        if (!provenance) {
          throw new Error("tryAppendRepackageCreated: existing recovery chain is invalid");
        }
        const approved = _normalizeApprovedPaths(approvedAllowedPaths);
        if (!approved || existing.delivery.changedFiles.some((p) => !isPathAllowed(p, approved))) {
          throw new Error("tryAppendRepackageCreated: requested scope does not cover existing delivery");
        }
        return { created: false, ref: existing.delivery, provenance };
      }

      // Validate the candidate ref (fail closed before any append).
      if (!delivery || typeof delivery !== "object") {
        throw new Error("tryAppendRepackageCreated: delivery must be an object");
      }
      if (delivery.runId !== this.context.runId) {
        throw new Error("tryAppendRepackageCreated: delivery.runId must match the transcript runId");
      }
      if (!isCanonicalCommitId(delivery.baseCommit) || !isCanonicalCommitId(delivery.deliveryCommit)) {
        throw new Error("tryAppendRepackageCreated: baseCommit/deliveryCommit must be canonical commit ids");
      }
      if (source !== "packaged" && source !== "recovered") {
        throw new Error("tryAppendRepackageCreated: source must be \"packaged\" or \"recovered\"");
      }
      const durableRecoveryKind = classifyRecoveryCandidate(events, this.context.runId);
      const effectiveRecoveryKind = recoveryKind
        ?? (durableRecoveryKind === "disallowed_scope" ? "disallowed_scope" : null);
      if (!durableRecoveryKind || effectiveRecoveryKind !== durableRecoveryKind) {
        throw new Error("tryAppendRepackageCreated: recoveryKind does not match durable recovery facts");
      }
      const approved = _normalizeApprovedPaths(approvedAllowedPaths);
      if (!approved) {
        throw new Error("tryAppendRepackageCreated: approvedAllowedPaths must be canonical, sorted, and unique");
      }
      const original = _originalAllowedPaths(events, this.context.runId);
      if (!original || original.some((p) => !isPathAllowed(p, approved))) {
        throw new Error("tryAppendRepackageCreated: approvedAllowedPaths must cover the original scope");
      }
      if (!Array.isArray(delivery.changedFiles) || delivery.changedFiles.length === 0) {
        throw new Error("tryAppendRepackageCreated: delivery.changedFiles must be non-empty");
      }
      if (delivery.changedFiles.some((p) => !isValidRepoRelativePath(p) || !isPathAllowed(p, approved))) {
        throw new Error("tryAppendRepackageCreated: delivery.changedFiles exceed approvedAllowedPaths");
      }

      // Atomic batch: created + provenance in ONE appendFile.
      const baseSeq = Math.max(this.seq, findLastEventSeq(events));
      const ts = new Date().toISOString();
      const ctx = { runId: this.context.runId, agentId: this.context.agentId };
      const createdEvent = {
        ...this.redact({ delivery }), ts, seq: baseSeq + 1, ...ctx, type: "run.delivery_created",
      };
      const provenanceEvent = {
        ...this.redact({
          delivery,
          approvedAllowedPaths: approved,
          source,
          recoveryKind: effectiveRecoveryKind,
        }),
        ts, seq: baseSeq + 2, ...ctx, type: "run.delivery_repackaged",
      };
      await appendFile(this.filePath, `${JSON.stringify(createdEvent)}\n${JSON.stringify(provenanceEvent)}\n`, "utf8");
      this.seq = baseSeq + 2;
      return { created: true, ref: delivery, provenance: provenanceEvent };
    } finally {
      await releaseLock();
    }
  }

  /**
   * M12-1S2: lock-scoped idempotent append of the repackage verification outcome.
   *
   * Re-reads events under the lock and requires exactly one identity-matching
   * delivery_created event. It yields {recorded:false} if a bound final outcome
   * already exists (so a retry continues from the created stage WITHOUT creating
   * a second outcome). Otherwise it appends exactly one outcome event. The
   * verification itself runs OUTSIDE this lock (contract #5); only this
   * CAS-append is lock-scoped.
   *
   * @param {{delivery: object, outcome: "passed"|"failed"|"unavailable"}} input
   * @returns {Promise<{recorded:true, ref:object}|{recorded:false, ref:object}>}
   * @throws {Error} if delivery/outcome are malformed
   */
  async tryAppendRepackageVerification({ delivery, outcome } = {}) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const releaseLock = await acquireAppendLock(this.filePath);
    try {
      let events = [];
      try {
        events = await readTranscript(this.filePath);
      } catch {
        events = [];
      }

      if (!delivery || typeof delivery !== "object") {
        throw new Error("tryAppendRepackageVerification: delivery must be an object");
      }
      if (!_sameDeliveryIdentity(delivery, delivery, this.context.runId)) {
        throw new Error("tryAppendRepackageVerification: delivery identity is invalid");
      }
      if (!DELIVERY_VERIFICATION_OUTCOMES.has(outcome)) {
        throw new Error("tryAppendRepackageVerification: outcome must be passed|failed|unavailable");
      }

      const createdEvents = events.filter(
        (e) => e && e.type === "run.delivery_created" && e.runId === this.context.runId,
      );
      if (createdEvents.length !== 1) {
        throw new Error("tryAppendRepackageVerification: expected exactly one delivery_created event");
      }
      if (!_sameDeliveryIdentity(createdEvents[0].delivery, delivery, this.context.runId)) {
        throw new Error("tryAppendRepackageVerification: delivery does not match delivery_created");
      }

      // Idempotency: an existing bound final outcome wins.
      const existingEvents = events.filter(
        (e) => e && DELIVERY_VERIFICATION_OUTCOME_TYPES.has(e.type) && e.runId === this.context.runId,
      );
      if (existingEvents.length > 1) {
        throw new Error("tryAppendRepackageVerification: multiple verification outcomes");
      }
      if (existingEvents.length === 1) {
        const existing = existingEvents[0];
        if (!_sameDeliveryIdentity(existing.delivery, delivery, this.context.runId)) {
          throw new Error("tryAppendRepackageVerification: existing outcome belongs to another delivery");
        }
        return {
          recorded: false,
          ref: existing.delivery,
          outcome: _verificationOutcomeFromType(existing.type),
        };
      }

      const type = outcome === "passed"
        ? "run.delivery_verification_passed"
        : outcome === "failed"
          ? "run.delivery_verification_failed"
          : "run.delivery_verification_unavailable";

      const baseSeq = Math.max(this.seq, findLastEventSeq(events));
      const ts = new Date().toISOString();
      const ctx = { runId: this.context.runId, agentId: this.context.agentId };
      const event = { ...this.redact({ delivery }), ts, seq: baseSeq + 1, ...ctx, type };
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
      this.seq = baseSeq + 1;
      return { recorded: true, ref: delivery, outcome };
    } finally {
      await releaseLock();
    }
  }

  /**
   * M12-6 Package 3B (3B1 fail-closed): lock-scoped idempotent append of the
   * reverify REQUEST.
   *
   * Under the cross-process append lock: re-read events and project the FULL
   * durable reverify chain (all envelopes, identity- and shape-validated). If a
   * valid requested event already exists for this runId, yield {requested:false}
   * with the RECORDED reason + setupCommands — so a retry / concurrent competitor
   * converges on the FIRST caller's declared setup (deterministic verification).
   * Any durable conflict — a foreign-envelope reverify event, an identity or
   * shape mismatch, an existing outcome without its request, or duplicate
   * events — is a malformed chain → throw (never append a second request, never
   * coalesce, never reuse garbage). Otherwise validate the inputs (canonical
   * delivery identity, closed-set reason, bounded setup commands) and append
   * exactly one event.
   *
   * Narrow primitive: it does NOT verify, decide, or check eligibility beyond
   * delivery identity + input shape. Eligibility (eligible original failure
   * code, no existing decision) is proved by the application service BEFORE this
   * call; verification runs OUTSIDE this lock (contract #5). Never echoes the
   * recorded command text back in a way that leaks — the returned setupCommands
   * are consumed by the in-process service only (the safe result / MCP output
   * never surfaces them).
   *
   * @param {{delivery: object, reason: string, setupCommands?: string[]}} input
   * @returns {Promise<{requested:true, ref:object, reason:string, setupCommands:string[]}
   *           |{requested:false, ref:object, reason:string, setupCommands:string[]}>}
   * @throws {Error} if delivery identity is invalid, reason is not closed-set,
   *   setupCommands is malformed, or the chain is already malformed.
   */
  async tryAppendReverifyRequested({ delivery, reason, setupCommands = [] } = {}) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const releaseLock = await acquireAppendLock(this.filePath);
    try {
      let events = [];
      try {
        events = await readTranscript(this.filePath);
      } catch {
        events = [];
      }

      // Validate inputs (fail closed before any append).
      if (!delivery || typeof delivery !== "object") {
        throw new Error("tryAppendReverifyRequested: delivery must be an object");
      }
      if (!_sameDeliveryIdentity(delivery, delivery, this.context.runId)) {
        throw new Error("tryAppendReverifyRequested: delivery identity is invalid");
      }
      if (!REVERIFY_REASONS.includes(reason)) {
        throw new Error("tryAppendReverifyRequested: reason must be a closed-set reverify reason");
      }
      const setup = _normalizeReverifySetup(setupCommands);

      // M12-6 Package 3B1: the durable chain — every reverify event in the file,
      // validated for envelope/identity/shape — is the single authority. A
      // malformed chain can never be extended; a valid one yields the RECORDED
      // request (one chain maximum, no duplicate events).
      const chain = projectReverifyChain(events, this.context.runId, delivery);
      if (chain.status === "malformed") {
        throw new Error("tryAppendReverifyRequested: reverify chain is malformed (foreign envelope, identity, or shape conflict)");
      }
      if (chain.status !== "none") {
        // pending/complete: a valid requested event exists → yield the RECORDED
        // reason + setup (deterministic convergence), never the caller's.
        const rec = chain.requestedEvent;
        return {
          requested: false,
          ref: rec.delivery,
          reason: rec.reason,
          setupCommands: Array.isArray(rec.setupCommands) ? [...rec.setupCommands] : [],
        };
      }
      // chain.status === "none": no valid requested event → append exactly one.

      const baseSeq = Math.max(this.seq, findLastEventSeq(events));
      const ts = new Date().toISOString();
      const ctx = { runId: this.context.runId, agentId: this.context.agentId };
      const payload = { delivery, deliveryCommit: delivery.deliveryCommit, reason };
      if (setup.length > 0) payload.setupCommands = setup;
      const event = {
        ...this.redact(payload),
        ts,
        seq: baseSeq + 1,
        ...ctx,
        type: "run.delivery_reverification_requested",
      };
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
      this.seq = baseSeq + 1;
      return { requested: true, ref: delivery, reason, setupCommands: setup };
    } finally {
      await releaseLock();
    }
  }

  /**
   * M12-6 Package 3B (3B1 fail-closed): lock-scoped idempotent append of the
   * reverify OUTCOME.
   *
   * Under the lock: project the FULL durable reverify chain (all envelopes,
   * identity- and shape-validated). Requires exactly one valid
   * run.delivery_reverification_requested for this runId, then appends exactly
   * one outcome event (passed/failed/unavailable). Idempotent: an existing
   * outcome wins — a retry resumes after a crash between request and outcome
   * without recording a second outcome. Any durable conflict — a foreign-envelope
   * reverify event, an identity/shape mismatch, an orphan outcome, or duplicates
   * — is a malformed chain → throw (never append onto a conflict, never extend a
   * garbage request).
   *
   * Narrow primitive: the outcome is supplied by the caller (the reverify
   * service), which ran verifyDelivery OUTSIDE this lock against the exact same
   * immutable delivery commit. This method never verifies and never decides.
   *
   * @param {{delivery: object, outcome: "passed"|"failed"|"unavailable"}} input
   * @returns {Promise<{recorded:true, ref:object, outcome:string}
   *           |{recorded:false, ref:object, outcome:string}>}
   * @throws {Error} if delivery identity is invalid, outcome is not closed-set,
   *   there is no exactly-one valid request, or the chain is malformed.
   */
  async tryAppendReverifyOutcome({ delivery, outcome } = {}) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const releaseLock = await acquireAppendLock(this.filePath);
    try {
      let events = [];
      try {
        events = await readTranscript(this.filePath);
      } catch {
        events = [];
      }

      if (!delivery || typeof delivery !== "object") {
        throw new Error("tryAppendReverifyOutcome: delivery must be an object");
      }
      if (!_sameDeliveryIdentity(delivery, delivery, this.context.runId)) {
        throw new Error("tryAppendReverifyOutcome: delivery identity is invalid");
      }
      if (!DELIVERY_REVERIFICATION_OUTCOMES.has(outcome)) {
        throw new Error("tryAppendReverifyOutcome: outcome must be passed|failed|unavailable");
      }

      // M12-6 Package 3B1: the durable chain — every reverify event in the file,
      // validated for envelope/identity/shape — is the single authority.
      // pending → append exactly one outcome; complete → yield the durable
      // winner; none (orphan outcome) / malformed → throw.
      const chain = projectReverifyChain(events, this.context.runId, delivery);
      if (chain.status === "malformed") {
        throw new Error("tryAppendReverifyOutcome: reverify chain is malformed (foreign envelope, identity, top-level commit, or shape conflict)");
      }
      if (chain.status === "none") {
        throw new Error("tryAppendReverifyOutcome: expected exactly one delivery_reverification_requested event");
      }
      if (chain.status === "complete") {
        return {
          recorded: false,
          ref: chain.outcomeEvent.delivery,
          outcome: chain.effectiveStatus,
        };
      }

      const type = outcome === "passed"
        ? "run.delivery_reverification_passed"
        : outcome === "failed"
          ? "run.delivery_reverification_failed"
          : "run.delivery_reverification_unavailable";

      // M12-6 Package 3B1: the CAS must never write a self-poisoning outcome.
      // The caller-supplied ref must satisfy the SAME verification event
      // contract the projection enforces (status agrees exactly with the
      // declared outcome; verifiedCommit canonical + equal to the immutable
      // deliveryCommit; closed-set failure/unavailable shape) — otherwise the
      // appended event would make the durable chain malformed on the next read.
      if (!_isValidReverifyOutcomeEvent(
        { type, runId: this.context.runId, delivery, deliveryCommit: delivery.deliveryCommit },
        this.context.runId,
        delivery,
      )) {
        throw new Error("tryAppendReverifyOutcome: outcome ref violates the verification event contract (status must agree with the outcome; verifiedCommit canonical + equal to the deliveryCommit; closed-set failure/unavailable shape)");
      }

      const baseSeq = Math.max(this.seq, findLastEventSeq(events));
      const ts = new Date().toISOString();
      const ctx = { runId: this.context.runId, agentId: this.context.agentId };
      const event = {
        ...this.redact({ delivery, deliveryCommit: delivery.deliveryCommit }),
        ts,
        seq: baseSeq + 1,
        ...ctx,
        type,
      };
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
      this.seq = baseSeq + 1;
      return { recorded: true, ref: delivery, outcome };
    } finally {
      await releaseLock();
    }
  }

  // =====================================================================
  // M12-16: in-flight correction queue primitives.
  //
  // The transcript is the cross-process durable queue: the MCP process appends
  // run.correction_requested; the detached runner (a different process holding
  // the provider handle) reads + claims + delivers. Every primitive below runs
  // under the SAME cross-process append lock (acquireAppendLock) so the queue is
  // race-free across processes. They mirror the tryAppendReverify* CAS pattern:
  // read events IN LOCK → re-validate IN LOCK → append IN LOCK.
  // =====================================================================

  /**
   * Atomically append a correction request (the queue enqueue).
   *
   * Under the lock: re-validate correctionId/prompt shape, refuse a duplicate
   * correctionId (return the recorded status), and refuse if the run is already
   * terminal (queue-time terminal race). Only a non-duplicate, non-terminal run
   * gets exactly one run.correction_requested appended. The prompt is redacted
   * on store (consistent with prompt.sent).
   *
   * The broader eligibility checks (workspace ownership, correctable flag) are
   * STABLE facts that do not change after dispatch, so the application service
   * performs them on its own read and calls this primitive for the atomic
   * no-duplicate / non-terminal append that closes the terminal TOCTOU window.
   *
   * @returns {Promise<{queued:true, correctionId}|{queued:false, reason:"duplicate"|"terminal_run", existing?:object}>}
   * @throws {Error} on invalid correctionId/prompt shape (the service validates
   *   first; this is defense-in-depth at the CAS boundary).
   */
  async tryAppendCorrectionRequested({ correctionId, prompt } = {}) {
    if (typeof correctionId !== "string" || !correctionId
      || correctionId.length > CORRECTION_ID_MAX_LEN || !CORRECTION_ID_RE.test(correctionId)) {
      throw new Error("tryAppendCorrectionRequested: correctionId must be 1..64 [A-Za-z0-9_-] chars");
    }
    if (typeof prompt !== "string" || prompt.length === 0
      || prompt.length > CORRECTION_PROMPT_MAX_LEN) {
      throw new Error("tryAppendCorrectionRequested: prompt must be 1..15000 chars");
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    const releaseLock = await acquireAppendLock(this.filePath);
    try {
      let events = [];
      try {
        events = await readTranscript(this.filePath);
      } catch {
        events = [];
      }
      const proj = projectCorrections(events, this.context.runId);
      if (proj.has(correctionId)) {
        return { queued: false, reason: "duplicate", existing: proj.get(correctionId) };
      }
      // Re-check terminal IN LOCK: closes the TOCTOU between the service's read
      // and this append (the run could have terminated in that window).
      const state = findState(events);
      if (TERMINAL_STATES.includes(state)) {
        return { queued: false, reason: "terminal_run" };
      }
      const baseSeq = Math.max(this.seq, findLastEventSeq(events));
      const ts = new Date().toISOString();
      const ctx = { runId: this.context.runId, agentId: this.context.agentId };
      const event = {
        ...this.redact({ correctionId, prompt }),
        ts,
        seq: baseSeq + 1,
        ...ctx,
        type: "run.correction_requested",
      };
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
      this.seq = baseSeq + 1;
      return { queued: true, correctionId };
    } finally {
      await releaseLock();
    }
  }

  /**
   * Atomically claim an outstanding correction for delivery (runner-side).
   *
   * Under the lock: the claim is the durable marker that this correction will
   * be delivered by THIS runner. A correction already claimed/delivered/rejected/
   * delivery_failed is NOT re-claimable (no double turn). A terminal run refuses
   * (the caller then records a terminal_race rejection). Crash-safety: the claim
   * is durable, so a crash after claim but before delivery leaves the correction
   * "claimed" — it is never re-delivered (no double turn); it is rejected at the
   * terminal cleanup.
   *
   * @returns {Promise<{claimed:true, correctionId, prompt}|{claimed:false, reason:"not_found"|"already_handled"|"terminal_run"}>}
   */
  async tryClaimCorrection({ correctionId } = {}) {
    if (typeof correctionId !== "string" || !correctionId || !CORRECTION_ID_RE.test(correctionId)) {
      return { claimed: false, reason: "not_found" };
    }
    const releaseLock = await acquireAppendLock(this.filePath);
    try {
      let events = [];
      try {
        events = await readTranscript(this.filePath);
      } catch {
        events = [];
      }
      const proj = projectCorrections(events, this.context.runId);
      if (!proj.has(correctionId)) return { claimed: false, reason: "not_found" };
      const info = proj.get(correctionId);
      // Only a pending (requested, never claimed) correction is claimable.
      if (info.status !== "pending") return { claimed: false, reason: "already_handled" };
      const state = findState(events);
      if (TERMINAL_STATES.includes(state)) return { claimed: false, reason: "terminal_run" };
      const baseSeq = Math.max(this.seq, findLastEventSeq(events));
      const ts = new Date().toISOString();
      const ctx = { runId: this.context.runId, agentId: this.context.agentId };
      const event = { ts, seq: baseSeq + 1, ...ctx, correctionId, type: "run.correction_claimed" };
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
      this.seq = baseSeq + 1;
      return { claimed: true, correctionId, prompt: info.prompt ?? "" };
    } finally {
      await releaseLock();
    }
  }

  /**
   * Record that a claimed correction was delivered to the provider stdin.
   * Idempotent: if already delivered, no-op. Bounded closed-set, no body echoed.
   * @returns {Promise<{recorded:boolean, correctionId}>}
   */
  async appendCorrectionDelivered({ correctionId } = {}) {
    if (typeof correctionId !== "string" || !correctionId || !CORRECTION_ID_RE.test(correctionId)) {
      throw new Error("appendCorrectionDelivered: invalid correctionId");
    }
    const releaseLock = await acquireAppendLock(this.filePath);
    try {
      let events = [];
      try {
        events = await readTranscript(this.filePath);
      } catch {
        events = [];
      }
      const proj = projectCorrections(events, this.context.runId);
      const info = proj.get(correctionId);
      if (info && info.status === "delivered") return { recorded: false, correctionId };
      const baseSeq = Math.max(this.seq, findLastEventSeq(events));
      const ts = new Date().toISOString();
      const ctx = { runId: this.context.runId, agentId: this.context.agentId };
      const event = { ts, seq: baseSeq + 1, ...ctx, correctionId, type: "run.correction_delivered" };
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
      this.seq = baseSeq + 1;
      return { recorded: true, correctionId };
    } finally {
      await releaseLock();
    }
  }

  /**
   * Record that a delivery attempt was refused by the provider stdin
   * (closed/failed). Closed-set reason only. Terminal for that correction.
   * @returns {Promise<{recorded:boolean, correctionId, reason}>}
   */
  async appendCorrectionDeliveryFailed({ correctionId, reason } = {}) {
    if (typeof correctionId !== "string" || !correctionId || !CORRECTION_ID_RE.test(correctionId)) {
      throw new Error("appendCorrectionDeliveryFailed: invalid correctionId");
    }
    const safeReason = CORRECTION_DELIVERY_FAIL_REASONS.includes(reason) ? reason : "send_failed";
    const releaseLock = await acquireAppendLock(this.filePath);
    try {
      let events = [];
      try {
        events = await readTranscript(this.filePath);
      } catch {
        events = [];
      }
      const proj = projectCorrections(events, this.context.runId);
      const info = proj.get(correctionId);
      // Already terminal for this correction → no-op (no duplicate fact).
      if (info && (info.status === "delivered" || info.status === "delivery_failed"
        || info.status === "rejected")) {
        return { recorded: false, correctionId, reason: safeReason };
      }
      const baseSeq = Math.max(this.seq, findLastEventSeq(events));
      const ts = new Date().toISOString();
      const ctx = { runId: this.context.runId, agentId: this.context.agentId };
      const event = {
        ts, seq: baseSeq + 1, ...ctx, correctionId, reason: safeReason,
        type: "run.correction_delivery_failed",
      };
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
      this.seq = baseSeq + 1;
      return { recorded: true, correctionId, reason: safeReason };
    } finally {
      await releaseLock();
    }
  }

  /**
   * Atomically reject EVERY outstanding (pending/claimed, not yet terminal)
   * correction as terminal_race. Called from Run._runCleanup on every terminal
   * branch so no correction request is ever stranded after the provider done.
   * Closed-set reason only; no body echoed.
   * @param {object} [opts]
   * @param {string} [opts.reason="terminal_race"]
   * @returns {Promise<{rejected:string[], reason:string}>} the correctionIds rejected
   */
  async rejectOutstandingCorrections({ reason = "terminal_race" } = {}) {
    const safeReason = reason === "stdin_closed" ? "stdin_closed" : "terminal_race";
    const releaseLock = await acquireAppendLock(this.filePath);
    try {
      let events = [];
      try {
        events = await readTranscript(this.filePath);
      } catch {
        events = [];
      }
      const proj = projectCorrections(events, this.context.runId);
      const outstanding = [];
      for (const [cid, info] of proj) {
        if (info.status === "pending" || info.status === "claimed") outstanding.push(cid);
      }
      if (outstanding.length === 0) return { rejected: [], reason: safeReason };
      const baseSeq = Math.max(this.seq, findLastEventSeq(events));
      const ts = new Date().toISOString();
      const ctx = { runId: this.context.runId, agentId: this.context.agentId };
      const lines = [];
      let seq = baseSeq;
      const ordered = outstanding.sort(); // deterministic order (independent of Map order)
      for (const cid of ordered) {
        seq += 1;
        lines.push(JSON.stringify({ ts, seq, ...ctx, correctionId: cid, reason: safeReason, type: "run.correction_rejected" }));
      }
      await appendFile(this.filePath, `${lines.join("\n")}\n`, "utf8");
      this.seq = seq;
      return { rejected: ordered, reason: safeReason };
    } finally {
      await releaseLock();
    }
  }
}

/**
 * M12-16: project the durable correction chain for one run into a Map keyed by
 * correctionId → { status, reason, prompt }. Pure function over an event array
 * (no I/O). status ∈ CORRECTION_STATUSES. Events whose envelope runId !== runId
 * or whose correctionId is malformed are skipped (defensive; the snapshot is
 * already run-bound by readers). Map insertion order = first-requested order, so
 * the runner delivers in queue order.
 *
 * @param {object[]} events
 * @param {string} runId
 * @returns {Map<string, {status:string, reason:string|null, prompt:string}>}
 */
export function projectCorrections(events, runId) {
  const map = new Map();
  if (!Array.isArray(events)) return map;
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    if (typeof runId === "string" && runId.length > 0 && ev.runId !== runId) continue;
    const cid = ev.correctionId;
    if (typeof cid !== "string" || !cid || !CORRECTION_ID_RE.test(cid)) continue;
    let entry = map.get(cid);
    if (!entry) {
      entry = { status: null, reason: null, prompt: "" };
      map.set(cid, entry);
    }
    if (ev.type === "run.correction_requested") {
      // A fresh request resets the chain (defensive: should only happen once).
      entry.status = "pending";
      entry.reason = null;
      if (typeof ev.prompt === "string") entry.prompt = ev.prompt;
    } else if (ev.type === "run.correction_claimed") {
      if (entry.status === "pending") entry.status = "claimed";
    } else if (ev.type === "run.correction_delivered") {
      entry.status = "delivered";
      entry.reason = null;
    } else if (ev.type === "run.correction_delivery_failed") {
      if (entry.status !== "delivered" && entry.status !== "rejected") {
        entry.status = "delivery_failed";
        entry.reason = CORRECTION_DELIVERY_FAIL_REASONS.includes(ev.reason) ? ev.reason : "send_failed";
      }
    } else if (ev.type === "run.correction_rejected") {
      if (entry.status !== "delivered") {
        entry.status = "rejected";
        entry.reason = CORRECTION_REJECTION_REASONS.includes(ev.reason) ? ev.reason : "terminal_race";
      }
    }
  }
  // Any correctionId that appeared only via a non-request event (orphan) with no
  // resolved status defaults to pending defensively; an entry with status null
  // (should not happen for a bound request) is dropped.
  for (const [cid, entry] of map) {
    if (entry.status === null) map.delete(cid);
  }
  return map;
}

/**
 * M12-16: project the status of ONE correctionId, or {found:false}. The status
 * object never echoes the prompt body (the Lead-facing outcome derives status +
 * reason only; prompt is internal-to-runner delivery data).
 *
 * @returns {{found:true, status:string, reason:string|null}|{found:false}}
 */
export function projectCorrectionStatus(events, runId, correctionId) {
  const map = projectCorrections(events, runId);
  if (!map.has(correctionId)) return { found: false };
  const info = map.get(correctionId);
  return { found: true, status: info.status, reason: info.reason };
}

/**
 * TD-103 Phase 3C-2: Single owner of delivery fact validation.
 *
 * Validates durable preconditions from a transcript event array:
 *   - exactly one run.delivery_created event;
 *   - exactly one verification outcome event (passed/failed/unavailable);
 *   - verification event's deliveryCommit must match delivery_created's;
 *   - identifies any existing decision event.
 *
 * M11-3A: exported as validateDeliveryFacts so the read-only review service can
 * reuse the SAME durable-facts validator as tryAppendDecision, without altering
 * tryAppendDecision or introducing a second reconstruction algorithm.
 *
 * @param {object[]} events
 * @returns {{valid:boolean, latestRef:object|null, deliveryCommit:string|null, verificationStatus:string, decisionEvent:object|null, code:string|null, error:string|null}}
 */
export function validateDeliveryFacts(events) {
  const createdEvents = events.filter((e) => e.type === "run.delivery_created" && e.delivery);
  if (createdEvents.length === 0) {
    // M12-9: structured fact category — no committed delivery → delivery_unavailable.
    return { valid: false, latestRef: null, deliveryCommit: null, verificationStatus: "pending", decisionEvent: null, code: "delivery_unavailable", error: "No committed delivery found (missing run.delivery_created)" };
  }
  if (createdEvents.length > 1) {
    // M12-9: conflicting durable facts → delivery_malformed.
    return { valid: false, latestRef: null, deliveryCommit: null, verificationStatus: "pending", decisionEvent: null, code: "delivery_malformed", error: `Multiple delivery_created events found (${createdEvents.length}); exactly one required` };
  }

  const createdRef = createdEvents[0].delivery;
  const createdCommit = createdRef.deliveryCommit;

  // Find verification outcome events
  const verificationEvents = events.filter((e) =>
    DELIVERY_VERIFICATION_OUTCOME_TYPES.has(e.type));

  if (verificationEvents.length === 0) {
    // M12-9: no verification outcome → delivery_unavailable.
    return { valid: false, latestRef: createdRef, deliveryCommit: createdCommit, verificationStatus: "pending", decisionEvent: null, code: "delivery_unavailable", error: "No verification outcome event found (missing run.delivery_verification_*)" };
  }
  if (verificationEvents.length > 1) {
    // M12-9: conflicting durable facts → delivery_malformed.
    return { valid: false, latestRef: createdRef, deliveryCommit: createdCommit, verificationStatus: "pending", decisionEvent: null, code: "delivery_malformed", error: `Multiple verification outcome events found (${verificationEvents.length}); exactly one required` };
  }

  const verificationEvent = verificationEvents[0];
  const verificationRef = verificationEvent.delivery;
  const verificationCommit = verificationRef?.deliveryCommit;

  // M11-10 closeout (auditor blocker 1): both commits must be CANONICAL commit
  // ids AND equal. Reuses isCanonicalCommitId (the single commit validator from
  // delivery.js) — no second regex here. Previously this block only compared
  // `verificationCommit !== createdCommit`, so two undefined/null/empty/non-
  // canonical values compared equal (`undefined !== undefined` is false) and
  // falsely validated the delivery as reviewable. Now any non-canonical commit
  // on either side fails closed.
  if (!isCanonicalCommitId(createdCommit) || !isCanonicalCommitId(verificationCommit)) {
    // M12-9: non-canonical commit → delivery_malformed.
    return { valid: false, latestRef: createdRef, deliveryCommit: createdCommit, verificationStatus: "pending", decisionEvent: null, code: "delivery_malformed", error: "delivery_created and verification deliveryCommit must both be canonical 40/64-hex commit ids" };
  }

  // Verification commit must match delivery_created commit
  if (verificationCommit !== createdCommit) {
    // M12-9: commit mismatch → delivery_malformed.
    return { valid: false, latestRef: createdRef, deliveryCommit: createdCommit, verificationStatus: "pending", decisionEvent: null, code: "delivery_malformed", error: `Verification deliveryCommit (${verificationCommit}) does not match delivery_created commit (${createdCommit})` };
  }

  // Extract verification status
  const verificationStatus = verificationEvent.type === "run.delivery_verification_passed"
    ? "passed"
    : verificationEvent.type === "run.delivery_verification_failed"
      ? "failed"
      : "unavailable";

  // The latest DeliveryRef is the one from the verification event (has updated verification status)
  const latestRef = verificationRef;

  // Check for existing decision event
  const decisionEvent = events.find((e) =>
    e.type === "run.delivery_accepted" || e.type === "run.delivery_rejected") ?? null;

  // M12-1S2: recoveryAcceptable — the strict recovery chain that lets a
  // terminally-failed disallowed_path run be Lead-ACCEPTED after a model-free
  // repackage. Additive flag only — it does NOT alter valid/latestRef/decision
  // semantics, so the normal completed-run accept path is untouched. Requires:
  //   - exactly one bound run.delivery_failed with code "disallowed_path";
  //   - a run.delivery_repackaged provenance bound to the created commit; AND
  //   - verification status "passed".
  // The terminal failed is never rewritten to completed here — the decide gate
  // consults this flag to admit an explicit Lead accept on the failed run.
  const createdRunId = createdEvents[0].runId ?? null;
  const recoveryProvenance = findValidRepackageProvenance(events, createdRunId, createdRef);
  const recoveryAcceptable = recoveryProvenance !== null && verificationStatus === "passed";

  // M12-6 Package 3B: project the reverify audit chain (ADDITIVE). The
  // effective verification status used for the Lead accept/reject decision
  // becomes the reverify outcome ONLY when exactly one bound requested + one
  // bound outcome exist (status "complete"). A malformed chain is NEVER hidden:
  // it leaves effectiveVerificationStatus at the original status (so acceptance
  // fails closed against a still-failed original) and surfaces reverifyStatus
  // "malformed" for the Lead to see. Original verificationStatus + latestRef are
  // unchanged, so every existing caller (no reverify chain) sees zero drift.
  const reverifyChain = projectReverifyChain(events, createdRunId, createdRef);
  const effectiveVerificationStatus =
    reverifyChain.status === "complete" && reverifyChain.effectiveStatus
      ? reverifyChain.effectiveStatus
      : verificationStatus;
  // The effective DeliveryRef is the reverify outcome's ref (with the effective
  // verification status baked in) ONLY for a complete chain; otherwise the
  // original verification ref stands. tryAppendDecision stamps acceptance onto
  // this ref.
  const effectiveRef =
    reverifyChain.status === "complete" && reverifyChain.outcomeEvent?.delivery
      ? reverifyChain.outcomeEvent.delivery
      : null;

  // M11-3A closeout: also surface the created ref and both envelope runIds so a
  // read-only consumer (runDeliveryReview) can bind the full durable identity
  // chain (created event/ref + verification event/ref) to the requested runId
  // before any Git proof. tryAppendDecision ignores these extra fields.
  return {
    valid: true,
    latestRef,
    createdRef,
    deliveryCommit: createdCommit,
    verificationStatus,
    effectiveVerificationStatus,
    effectiveRef,
    decisionEvent,
    recoveryAcceptable,
    reverifyStatus: reverifyChain.status,
    reverifyReason: reverifyChain.reason,
    reverifyRequestedEvent: reverifyChain.requestedEvent,
    reverifyOutcomeEvent: reverifyChain.outcomeEvent,
    createdEventRunId: createdEvents[0].runId ?? null,
    verificationEventRunId: verificationEvent.runId ?? null,
    code: null,
    error: null,
  };
}

/**
 * TD-99 内部：检测事件序列中是否已有"已 claim 的终态"。
 * - 从后向前扫所有 run.state_change，只要历史中出现过 terminal state_change → 返回
 *   最后一个 terminal（旧双终态 transcript 兼容：last-terminal-wins）。
 *   这堵住"终态后被错误地写了非终态 running"导致复活的后门。
 * - 有 state_change 但均非终态 → 返回 null（前置事实不算已 claim）。
 * - 完全无 state_change → 用 findState 的 legacy fallback（旧 transcript 兼容）。
 *
 * TD-100 收尾：SSOT 统一——legacy fallback 与 findState/inferStateFromLegacyEvent 完全一致，
 * 不再排除 run.stop_requested。stop 命令的 stop_requested 不再 claim 前单独写入，而是通过
 * transitionState 的 attemptEvents 同批提交——因此持锁读取的旧 events 中不会包含本次的
 * stop_requested，不会自拒绝。
 */
function _detectExistingTerminal(events) {
  let lastTerminal = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const ev = events[index];
    if (ev.type === "run.state_change") {
      if (TERMINAL_STATES.includes(ev.to)) {
        // 从后向前找到的第一个 terminal state_change = 最近的 terminal。
        // 对旧双终态 transcript（如 aborted 后又 failed）返回最后写入的 terminal（last-wins 兼容）。
        lastTerminal = ev.to;
        break;
      }
      // 这条非终态——继续往前找是否有更早的 terminal（防"终态后错误 running"复活）。
    }
  }
  if (lastTerminal) return lastTerminal;
  // 有 state_change 但扫完全部均非终态。
  if (events.some((e) => e.type === "run.state_change")) {
    return null;
  }
  // 完全无 state_change：legacy fallback——与 findState 同源（inferStateFromLegacyEvent）。
  const inferred = findState(events);
  return TERMINAL_STATES.includes(inferred) ? inferred : null;
}

// TD-71: minimal filesystem/clock seam for the append-lock subsystem ONLY
// (acquireAppendLock + removeStaleLock). Production resolves to the real
// node:fs/promises primitives + Date.now()/setTimeout; tests override it via
// __setAppendLockFsForTest to deterministically simulate a transient Windows
// EPERM/EBUSY on lock creation and advance the clock, WITHOUT depending on the
// OS to reproduce a lock race. The rest of this module's I/O (appendFile, mkdir,
// readTranscript, readMaxSeq, ...) is untouched and always uses the real
// primitives — the seam never widens past the lock subsystem.
const _realAppendLockFs = {
  open,
  readFile,
  unlink,
  now: () => Date.now(),
  sleep,
};
let _appendLockFs = _realAppendLockFs;

/**
 * TD-71 test-only seam: override one or more append-lock filesystem/clock
 * primitives for deterministic retry tests. Pass a PARTIAL object; unspecified
 * primitives keep their real defaults. Always pair with
 * __resetAppendLockFsForTest() in a finally block so the seam cannot leak.
 */
export function __setAppendLockFsForTest(seam) {
  _appendLockFs = { ..._realAppendLockFs, ...seam };
}

/** TD-71 test-only seam: restore the real append-lock filesystem/clock primitives. */
export function __resetAppendLockFsForTest() {
  _appendLockFs = _realAppendLockFs;
}

export async function acquireAppendLock(filePath) {
  const lockPath = `${filePath}.seq.lock`;
  const fs = _appendLockFs;
  const start = fs.now();
  // TD-71: the most recent RETRIABLE error, preserved as the timeout's `.cause`
  // so a bound-exhaustion failure stays truthful about WHY (e.g. repeated Windows
  // EPERM, or sustained lock contention) instead of masking a real
  // permission/configuration problem. Non-retriable errors throw before this is
  // ever read, so it only ever holds EEXIST/EPERM/EBUSY.
  let lastRetriedError = null;
  while (true) {
    // ── Lock CREATION: the only step whose EPERM/EBUSY is a Windows-transient
    // retryable failure. EEXIST is the ONLY code routed to stale-lock recovery
    // (it is the only code that means "another process holds the lock"); EPERM/
    // EBUSY retry within the SAME timeout/poll budget and NEVER delete a lock
    // (none was created). Any other code throws immediately, cause preserved.
    let handle;
    try {
      handle = await fs.open(lockPath, "wx");
    } catch (error) {
      const code = error?.code;
      if (code === "EEXIST") {
        await removeStaleLock(lockPath);
      } else if (code === "EPERM" || code === "EBUSY") {
        // TD-71: Windows-transient filesystem errors (antivirus / indexer /
        // filter briefly blocking the new lock path). Retried below; no lock was
        // created, so stale-lock deletion must NOT run.
      } else {
        // Non-transient (ENOSPC, EACCES, EMFILE, ...): throw immediately and
        // preserve the causal code verbatim. The retry set is intentionally the
        // closed {EEXIST, EPERM, EBUSY} — never widened to swallow real errors.
        throw error;
      }
      lastRetriedError = error;
      // Single bound for EEXIST, EPERM, and EBUSY — no second timeout source.
      if (fs.now() - start > APPEND_LOCK_TIMEOUT_MS) {
        throw new Error(
          `Timed out waiting for transcript append lock: ${lockPath}`,
          { cause: lastRetriedError },
        );
      }
      await fs.sleep(APPEND_LOCK_POLL_MS);
      continue;
    }
    // ── Lock OWNED: fs.open succeeded, so THIS invocation created the lock.
    // The metadata write is NOT a retryable open failure. If it fails for ANY
    // code, close the owned handle and unlink ONLY this lock path, then throw
    // the original causal error unchanged — no second open, no retry, no stale
    // logic. (Otherwise the owned handle + lock leak, and the next open EEXISTs
    // on our own just-created lock.)
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, ts: fs.now() }), "utf8");
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.unlink(lockPath).catch(() => {});
      throw error;
    }
    return async () => {
      await handle.close().catch(() => {});
      await fs.unlink(lockPath).catch(() => {});
    };
  }
}

async function removeStaleLock(lockPath) {
  try {
    const raw = await _appendLockFs.readFile(lockPath, "utf8");
    const data = JSON.parse(raw);
    if (_appendLockFs.now() - Number(data.ts) > APPEND_LOCK_STALE_MS) {
      await _appendLockFs.unlink(lockPath).catch(() => {});
    }
  } catch {
    // If the lock is unreadable, let the normal timeout path decide.
  }
}

async function readMaxSeq(filePath) {
  try {
    return findLastEventSeq(await readTranscript(filePath));
  } catch {
    return 0;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readTranscript(filePath) {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function findLatest(events, type) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === type) {
      return events[index];
    }
  }
  return undefined;
}

/**
 * 从事件序列推算当前 RunState。
 * 优先取最后一条 run.state_change 的 to；
 * 若无 state_change（旧 transcript），用旧逻辑——最后事件 type 兜底推断，
 * 保持与重构前 runs list 行为一致。
 */
export function findState(events) {
  const stateChangeIndex = findLatestIndex(events, "run.state_change");
  const stateChange = stateChangeIndex >= 0 ? events[stateChangeIndex] : undefined;
  if (stateChange) {
    if (!TERMINAL_STATES.includes(stateChange.to)) {
      for (let index = events.length - 1; index > stateChangeIndex; index -= 1) {
        const inferred = inferStateFromLegacyEvent(events[index].type);
        if (TERMINAL_STATES.includes(inferred)) {
          return inferred;
        }
      }
    }
    return stateChange.to;
  }
  const last = events.at(-1);
  if (!last) {
    return "pending";
  }
  // TD-102: workflow.completed {completed:false} is a failed workflow, not completed.
  // 读取 workflow.completed 事件的 payload——type 映射只看类型名，不看 completed 字段。
  if (last.type === "workflow.completed" && last.completed === false) {
    return "failed";
  }
  return inferStateFromLegacyEvent(last.type);
}

function findLatestIndex(events, type) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === type) {
      return index;
    }
  }
  return -1;
}

/**
 * 旧 transcript 兜底：把最后事件的 type 映射到状态。
 * 严格复刻重构前 runs list / runs summary 的行为（用最后事件 type 作为状态）。
 */
function inferStateFromLegacyEvent(type) {
  const legacyMap = {
    "run.completed": "completed",
    "workflow.completed": "completed",
    "run.timed_out": "timed_out",
    "run.aborted": "aborted",
    "run.error": "failed",
    "run.stop_requested": "aborted",
  };
  if (legacyMap[type]) {
    return legacyMap[type];
  }
  // 非终态事件：run 已创建并在跑，归为 running（旧 transcript 无 pending/submitted 概念）
  return "running";
}

/**
 * 返回事件序列里的最大 seq。用于 resume 时定位续读点。
 * 旧 transcript 无 seq 字段时返回 0。
 */
export function findLastEventSeq(events) {
  let max = 0;
  for (const event of events) {
    if (typeof event.seq === "number" && event.seq > max) {
      max = event.seq;
    }
  }
  return max;
}

/**
 * M11-8B: Derive the canonical WAO agentId from a transcript event sequence.
 *
 * This is the SSOT for structured worker identity. The agentId is the value
 * stamped on the WAO transcript envelope by the control plane (see
 * JsonlTranscript.append / transitionState / tryAppendDecision — every event
 * carries `agentId: this.context.agentId`). It is NEVER inferred from:
 *   - assistant message text (a worker may self-report "/root", "Coder-HQ",
 *     or nothing at all — none of that changes the durable agentId);
 *   - OS user, cwd, model name, backend output, or role title.
 *
 * Trust-boundary derivation (M11-8B closeout):
 *   - The id is returned ONLY when EVERY event in the sequence carries:
 *       (a) a `runId` equal to `expectedRunId`, AND
 *       (b) the SAME `agentId`, AND
 *       (c) that agentId is a valid canonical id (closed-set alphabet).
 *   - Any deviation — a missing agentId on any event, a runId that does not
 *     match the request, a conflicting agentId, an invalid/non-canonical id,
 *     or an empty/missing sequence — returns "unknown".
 *   - "unknown" is NEVER a throw and NEVER a gate: the tool stays usable and
 *     the Lead keeps human judgment. A corrupt or stale transcript degrades
 *     honestly rather than fabricating a trusted identity.
 *
 * `expectedRunId` binds the read to the request: events from a different run
 * (e.g. a transcript concatenated across runs, or a stale cursor replay) are
 * rejected. Callers (status/wait/collect) pass the runId they were asked about.
 *
 * This function reads ONLY the already-loaded event array. It performs no
 * extra transcript, registry, or filesystem read — callers pass the snapshot
 * they already have (status/wait/collect all read the transcript once).
 *
 * @param {object[]} events — transcript event array (already read)
 * @param {string} [expectedRunId] — the runId the caller requested
 * @returns {string} the canonical agentId, or "unknown"
 */
export function extractCanonicalAgentId(events, expectedRunId) {
  if (!Array.isArray(events) || events.length === 0) return "unknown";
  const first = events[0];
  const candidate = first?.agentId;
  // The candidate must be a valid canonical id (closed-set alphabet). An
  // invalid/non-canonical id on the very first event → unknown, no throw.
  if (!isValidCanonicalAgentId(candidate)) return "unknown";
  // Every event must carry the SAME valid agentId AND the expected runId.
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    if (ev?.agentId !== candidate) return "unknown";
    if (expectedRunId !== undefined && ev?.runId !== expectedRunId) return "unknown";
  }
  return candidate;
}

/**
 * Fail-closed runId envelope binding (M12-8 activity path SSOT).
 *
 * Strictly stronger than extractCanonicalAgentId's degrade-to-"unknown"
 * behavior: EVERY object event in the snapshot must carry a `runId` string
 * field EXACTLY equal to the requested runId. Missing (undefined/null/empty/
 * non-string), mismatched, or conflicting (mixed runIds within one snapshot)
 * envelope facts THROW — the caller must fail closed BEFORE deriving any
 * structured output (backend/state/terminal/agentId/activity) from the
 * snapshot. Never returns a degraded value.
 *
 * Non-object lines (corrupt primitives such as null/numbers/raw strings)
 * cannot influence state/backend/terminal/activity output — classification
 * skips them — so they are skipped here; they remain inside the raw-snapshot
 * cursor digest, so they are still bound to the frozen-prefix cursor.
 *
 * @param {object[]} events — transcript event array (untrusted)
 * @param {string} runId — the caller-requested runId
 * @throws {Error} when any object event carries a missing or mismatched runId
 */
export function assertEventsBoundToRunId(events, runId) {
  if (!Array.isArray(events)) throw new Error("invalid activity snapshot: events must be an array");
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    if (ev === null || typeof ev !== "object") continue; // corrupt primitive line — cannot influence output
    if (typeof ev.runId !== "string" || ev.runId.length === 0) {
      throw new Error("runId binding failed: event envelope missing runId");
    }
    if (ev.runId !== runId) {
      throw new Error("runId binding failed: event envelope runId mismatch");
    }
  }
}
