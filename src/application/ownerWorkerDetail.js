// src/application/ownerWorkerDetail.js
//
// 第 141a 批（决定 0131 §3）：Owner 看板单个 worker 的详情 DTO（GET /api/worker）——侧栏
// 的身份、健康、Run 轴、交付轴、会审轴、交付物与任务书。只读：不追加转录、不写盘、不改
// 状态；也不做语义判断（"这份交付好不好"是 Lead 的事）。
//
// 数据来源（都是既有事实，不另写第二份判定）：
//   - 读模型快照里该运行的行（run）与整份快照（会审组）：身份、活性、阶段、交付摘要、
//     失败、谱系、被取代。时间相关的结论（已运行时长、阶段年龄）用发布快照时的同一个 now。
//   - 这一刻读到的转录事件（events）：交付物细节（validateDeliveryFacts 校验过的提交、
//     changedFiles、验证命令与结果）、任务书（最后一条绑定的 prompt.sent）、调研答复
//     （最后一条助手消息，与会审席取 Q1 同一个 extractFinalAssistantText）、失败诊断
//     （diagnoseFailure）与隔离违规事件。
//   - 交付对象的证明与逐文件增删行：调用方注入的 proveDelivery（createDeliveryProver：提交类型、
//     父提交 = 基线、实际变更清单 = changedFiles，通过后给 git diff --numstat 的增删行；只读
//     Git 对象）。
//   - 一次响应只用一代事实：交付轴（提交、验证、收口、裁决）、交付物与产物接口都从请求当刻读到
//     的同一份转录算（liveDeliveryFacts / currentDelivery）；快照只供转录之外的事实（活性、
//     阶段、谱系、被取代、分支是否还在、会审组）。
//
// 边界：
//   - DTO 走白名单：逐个字段挑出来组装，不整包透传任何应用层对象。gatherDeliveryView 的
//     deliveryRef（带工作树路径）与快照里的项目 key 一律不出去；项目只给 slug 与名字。
//   - 所有自由文本（任务书、调研答复、诊断证据、验证命令、不可验证原因）走同一条出口链
//     （safeBody）：exact + 形状脱敏 → 绝对路径折成 `…/末段`（读模型标题已在用的
//     foldAbsolutePaths）→ 清控制字符 → 限长，复用 runActivityProjection 的 headOfRedactedText；
//     脱敏与折路径都在截断之前。标题、副标题、项目名在读模型里同样先 exact 脱敏再截断。
//     文件清单只给通过仓库相对路径判定（isValidRepoRelativePath：非绝对、无 ..、无空段）的
//     路径，其余给 [path_withheld]。唯一的例外是隔离违规事件自己的路径（reportedPath、
//     resolvedPath、escapedAt）：它们本来就是"越界去了哪里"，只放行 diagnosis.js 共用投影
//     处理过的字段（只有越界类原因才有；先脱敏、主目录换成 ~、用户名段守卫、清控制字符与
//     双向格式控制符、最后才限长），这里不再二次加工。
//   - 每项事实标明出处：source = system_observed（控制面自己观测到的：交付提交、文件清单、
//     增删行、验证命令与结果）或 worker_reported（worker 自己写的：调研答复、会审席的
//     结论）。没有交付物就如实写 none，不按助手的自述补。
//
// 交付物的三种状态（state）：bound（有绑定的 Git 产物，对象读得到且与转录声明对得上；调研
// 答复与会审组有内容也算 bound）、none（尚未观测到交付物）、unavailable（有绑定但对象已不
// 可用：交付事实自相矛盾——含转录声明的提交 / 基线 / 清单与仓库里的实际对象对不上、项目仓库
// 不明、Git 读取失败或对象已被清掉——reason 给闭集原因；转录里的事实仍照给，读不到的只有
// 增删行）。kind 的顺序：会审席 → 生图 → 有绑定的交付事实（写代码）→ 调研角色 → none；
// deliveryRequested 只表示意图（没有交付事实的普通运行是 none）。
//
// 架构契约：不 import src/commands/*、src/mcp/*、MCP SDK 或 zod；只读。

import { createSecretRedactor } from "../secretRedaction.js";
import {
  DIAGNOSIS_CATEGORIES,
  diagnoseFailure,
  isValidDiagnosisCode,
  isolationViolationDetail,
} from "../diagnosis.js";
import { findLatestBound, validateDeliveryFacts } from "../transcript.js";
import { isCanonicalCommitId, isValidRepoRelativePath, isValidRunId } from "../delivery.js";
import { extractFinalAssistantText, stripConsultSeatContract } from "./consultService.js";
import {
  OWNER_CONSULT_Q1_VALUES,
  OWNER_LIVENESS_VALUES,
  OWNER_STAGE_VALUES,
  foldAbsolutePaths,
  liveDeliveryFacts,
  projectDelivery,
} from "./ownerReadModel.js";
import { consultSeatsArrived, ownerLaneKey, ownerRunTitles } from "./ownerAttention.js";
import { DELIVERY_VERIFICATION_FAILURE_CODES, DELIVERY_VERIFICATION_STATUSES } from "./runDelivery.js";
import { headOfRedactedText } from "./runActivityProjection.js";

/** 调研答复正文的字符上限（UTF-16 码元；截断时给出截在哪里）。 */
export const OWNER_ANSWER_MAX_CHARS = 64 * 1024;
/** 任务书正文的字符上限（同上）。 */
export const OWNER_BRIEF_MAX_CHARS = 64 * 1024;
/** 文件清单至多列多少项（total 照实给全量）。 */
export const OWNER_FILES_MAX = 500;
/** 生图文件至多列多少项。 */
export const OWNER_IMAGES_MAX = 100;
/** 单条路径的字符上限。 */
export const OWNER_PATH_MAX_CHARS = 256;
/** 验证命令的字符上限。 */
export const OWNER_COMMAND_MAX_CHARS = 400;
/** 验证命令至多列多少条（setup 与断言各自）。 */
export const OWNER_COMMANDS_MAX = 50;
/** 诊断证据的条数上限与单条字符上限。 */
export const OWNER_DIAGNOSIS_EVIDENCE_MAX = 10;
export const OWNER_DIAGNOSIS_FACT_MAX_CHARS = 400;
/** 具名不可验证的原因文本的字符上限。 */
export const OWNER_UNAVAILABLE_REASON_MAX_CHARS = 400;
/** 关联会审至多列多少场。 */
export const OWNER_REVIEWS_MAX = 10;
/** 一场会审至多列多少个席位行（总数照实给）。 */
export const OWNER_CONSULT_SEATS_MAX = 20;
/** 席位行里 runId 的长度上限（合法字符之外再限长）。 */
export const OWNER_RUN_ID_MAX_CHARS = 128;
/** 产物接口能取的图片扩展名（与它放行的魔数类型对应：png / jpeg / webp）。 */
export const OWNER_IMAGE_EXTENSIONS = Object.freeze([".png", ".jpg", ".jpeg", ".webp"]);
/** 路径判不清或不在仓库内时的占位。 */
export const OWNER_PATH_WITHHELD = "[path_withheld]";

export const OWNER_DELIVERABLE_KINDS = Object.freeze(["code", "image", "consult", "research", "none"]);
export const OWNER_DELIVERABLE_STATES = Object.freeze(["bound", "none", "unavailable"]);
export const OWNER_DELIVERABLE_UNAVAILABLE_REASONS = Object.freeze([
  "delivery_facts_conflict", "repository_unknown", "git_read_failed",
]);

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f]/;

const text = (value) => (typeof value === "string" ? value : null);
const memberOf = (set, value) => (typeof value === "string" && set.includes(value) ? value : null);
const nonNegativeInt = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

function msOf(value) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

// ===== 当前交付（详情与产物接口共用） =====

/**
 * 这个运行当前绑定的交付：validateDeliveryFacts（运行绑定模式）校验过的 delivery_created
 * 引用。详情的交付物与产物接口都从这里取"当前交付提交"与 changedFiles，所以候选提交换了
 * 以后，旧的提交号 / 序号一律对不上。
 *   - state "none"：没有绑定的交付；
 *   - state "conflict"：交付事实自相矛盾（或校验抛错）——"是哪个提交"没有唯一答案；
 *   - state "bound"：commit / baseCommit 是规范提交号，changedFiles 是引用里的数组原样
 *     （元素是否合法由使用方逐项验）。
 * createdAt 是这份交付的 delivery_created 事件的时间（读不到为 null）——会审是不是在这份交付之后
 * 做的要拿它比。
 *
 * @param {object[]} events
 * @param {string} runId
 * @returns {{state: string, commit: string|null, baseCommit: string|null, changedFiles: unknown[], createdAt: string|null, facts: object|null}}
 */
export function currentDelivery(events, runId) {
  const none = { state: "none", commit: null, baseCommit: null, changedFiles: [], createdAt: null, facts: null };
  let facts;
  try {
    facts = validateDeliveryFacts(events, { expectedRunId: runId, allowVerificationPending: true });
  } catch {
    return { ...none, state: "conflict" };
  }
  if (facts.code === "delivery_malformed") return { ...none, state: "conflict" };
  const ref = facts.createdRef;
  if (ref === null || ref === undefined || typeof ref !== "object") return none;
  if (!isCanonicalCommitId(ref.deliveryCommit) || !isCanonicalCommitId(ref.baseCommit)) return { ...none, state: "conflict" };
  // 校验选中的 created 事件：它的 delivery 就是 createdRef 这个对象。
  const createdEvent = events.find((e) => e !== null && typeof e === "object" && e.type === "run.delivery_created" && e.delivery === ref);
  return {
    state: "bound",
    commit: ref.deliveryCommit,
    baseCommit: ref.baseCommit,
    changedFiles: Array.isArray(ref.changedFiles) ? ref.changedFiles : [],
    createdAt: typeof createdEvent?.ts === "string" ? createdEvent.ts : null,
    facts,
  };
}

// ===== 文本与路径 =====

/**
 * 自由文本的唯一出口链（决定 0131 §3）：精确值 + 形状脱敏 → 绝对路径折成 `…/末段`（读模型标题
 * 已在用的 foldAbsolutePaths）→ 清控制字符 → 限长（取头）。脱敏与折路径都在截断之前作用在
 * 完整文本上。隔离违规的路径字段是已批准的例外，走 diagnosis.js 的共用投影，不经这里。
 *
 * 第 141c 批起导出，给 Owner 活动投影（ownerWorkerActivity.js）复用同一条链；可选的 foldPaths
 * 缺省就是 foldAbsolutePaths——活动投影在它之上再把 CRLF 归一成 LF（同样发生在脱敏之后、
 * 清控制字符之前），其余环节一概不变。
 */
export function safeBody(raw, redactor, maxChars, foldPaths = foldAbsolutePaths) {
  return headOfRedactedText(raw, redactor, maxChars, foldPaths);
}

const safeText = (raw, redactor, maxChars) => safeBody(raw, redactor, maxChars).text;

/** 合法字符且不超长的 runId，否则 null（记录是磁盘上可手改的，runId 不能原样回显）。 */
const safeRunId = (value) => (typeof value === "string" && value.length <= OWNER_RUN_ID_MAX_CHARS && isValidRunId(value) ? value : null);

/** 文件清单里的路径：只给仓库相对路径（无控制字符），其余 [path_withheld]。 */
export function displayPath(raw, redactor) {
  if (typeof raw !== "string" || !isValidRepoRelativePath(raw) || CONTROL_CHAR_RE.test(raw)) return OWNER_PATH_WITHHELD;
  return safeText(raw, redactor, OWNER_PATH_MAX_CHARS);
}

const isImagePath = (raw) => typeof raw === "string"
  && OWNER_IMAGE_EXTENSIONS.some((extension) => raw.toLowerCase().endsWith(extension));

// ===== 谱系轮次与交付轴 =====

/**
 * 续修轮次：沿已证实的父边（parentRunId）往上数；断在快照之外或成环时 complete: false。
 * 第 143a 批起导出：Workers 列表行的轮次标记与侧栏交付轴用同一份口径。
 */
export function continuationRound(run, runsById) {
  let number = 1;
  let complete = true;
  const seen = new Set([run.runId]);
  let cursor = run;
  while (typeof cursor.parentRunId === "string") {
    number += 1; // 声明了父边：至少还有上一轮
    const parent = runsById.get(cursor.parentRunId);
    if (parent === undefined || seen.has(parent.runId)) {
      complete = false;
      break;
    }
    seen.add(parent.runId);
    cursor = parent;
  }
  return { number, complete };
}

/** 一个运行的裁决结果：已裁决给 accepted / rejected；没裁决但被取代给 superseded；其余 null。 */
function decisionResult(row) {
  const status = row?.delivery?.acceptance?.status;
  if (status === "accepted" || status === "rejected") return status;
  return typeof row?.supersededByRunId === "string" ? "superseded" : null;
}

/**
 * 是否在等 Lead 裁决：交付已收口（delivery_settled）、裁决仍 pending、没被取代 → true；
 * 已裁决或已被取代 → false；裁决状态读不到、"是否被取代"没能判定、收口判不出（undeterminable）
 * → null（不替它们下结论）；还没收口 → false。
 */
function awaitingDecision(run) {
  const delivery = run.delivery;
  const settlement = delivery.settlement;
  if (settlement?.status === "undeterminable") return null;
  if (settlement?.status !== "settled" || settlement?.reason !== "delivery_settled") return false;
  const status = delivery.acceptance?.status ?? null;
  if (status === "accepted" || status === "rejected") return false;
  if (typeof run.supersededByRunId === "string") return false;
  if (status !== "pending" || run.supersessionUndeterminable === true) return null;
  return true;
}

function deliveryAxis(run, runsById) {
  const delivery = run.delivery;
  if (delivery === null || delivery === undefined) return null;
  const round = continuationRound(run, runsById);
  const parent = typeof run.parentRunId === "string" ? runsById.get(run.parentRunId) : undefined;
  const parentDecision = parent === undefined ? null : (decisionResult(parent) ?? (parent.delivery?.acceptance?.status === "pending" ? "pending" : null));
  return {
    commit: text(delivery.commit),
    verification: delivery.verification === null || delivery.verification === undefined
      ? null
      : {
        status: text(delivery.verification.status),
        reverify: { status: text(delivery.verification.reverify?.status), reason: text(delivery.verification.reverify?.reason) },
      },
    settlement: { status: text(delivery.settlement?.status), reason: text(delivery.settlement?.reason) },
    settledAt: text(delivery.settledAt),
    awaitingDecision: awaitingDecision(run),
    decision: {
      result: decisionResult(run),
      decidedAt: text(delivery.acceptance?.decidedAt),
      supersededByRunId: text(run.supersededByRunId),
    },
    ambiguous: delivery.ambiguous === true,
    packagingFailure: text(delivery.packagingFailure),
    isolationFailure: delivery.isolationFailure === null || delivery.isolationFailure === undefined
      ? null
      : { code: text(delivery.isolationFailure.code), reason: text(delivery.isolationFailure.reason) },
    branchPresent: typeof delivery.branchPresent === "boolean" ? delivery.branchPresent : null,
    round: {
      number: round.number,
      complete: round.complete,
      rootRunId: text(run.lineageRootRunId),
      continuesRunId: text(run.parentRunId),
      continuesDecision: parentDecision,
    },
  };
}

// ===== 会审 =====

const hasSeat = (consult, runId) => Array.isArray(consult?.seats) && consult.seats.some((seat) => seat?.runId === runId);

const repliedOf = (seat) => (typeof seat?.replied === "boolean" ? seat.replied : null);

function seatRow(seat, runsById) {
  const runId = safeRunId(seat?.runId);
  const seatRun = runId === null ? undefined : runsById.get(runId);
  return {
    laneKey: (seatRun === undefined ? null : ownerLaneKey(seatRun)) ?? text(seat?.agentId),
    agentId: text(seat?.agentId),
    runId,
    runState: text(seat?.runState),
    q1: memberOf(OWNER_CONSULT_Q1_VALUES, seat?.q1),
    replied: repliedOf(seat),
    source: "worker_reported",
  };
}

/**
 * 一场会审的席位行与结论口径：
 *   - verdictsDiffer：给了有效 Q1 的席位里有两个以上**不同**的值；
 *   - anyFixFirst：任一席是 FIX_FIRST。
 *   两项分开给：Attention 的 consult_split 是"不同 或 任一 FIX_FIRST"，全员 FIX_FIRST 时前者为
 *   否、后者为是，详情不能只给一个"分裂"而与它互相矛盾。没声明 Q1 → 两项都是 null。
 *   结论口径按**全部**席位算；席位行至多 OWNER_CONSULT_SEATS_MAX 行（rowsTruncated 如实标明）。
 */
function consultRows(consult, runsById) {
  const seats = Array.isArray(consult.seats) ? consult.seats : [];
  const q1Declared = consult.q1Declared === true;
  const verdicts = new Set(seats.map((seat) => memberOf(OWNER_CONSULT_Q1_VALUES, seat?.q1)).filter((q1) => q1 !== null));
  return {
    q1Declared,
    verdictsDiffer: q1Declared ? verdicts.size >= 2 : null,
    anyFixFirst: q1Declared ? verdicts.has("FIX_FIRST") : null,
    rowsTruncated: seats.length > OWNER_CONSULT_SEATS_MAX,
    rows: seats.slice(0, OWNER_CONSULT_SEATS_MAX).map((seat) => seatRow(seat, runsById)),
  };
}

/**
 * 会审轴。几席"已到" = 已到终态**且**收到了答复；席位的运行状态、答复、Q1 各自单列（行里），
 * 不用其中一项代替另一项：完成但没有答复不算已到，失败但有答复算已到。收齐 = 至少一席且全部已到。
 */
function consultAxis(consult, runId) {
  const seats = Array.isArray(consult.seats) ? consult.seats : [];
  const thisSeat = seats.find((seat) => seat?.runId === runId);
  const arrived = consultSeatsArrived(seats);
  return {
    consultId: text(consult.consultId),
    createdAt: text(consult.createdAt),
    reviewedRunId: safeRunId(consult.reviewedRunId),
    thisSeat: { agentId: text(thisSeat?.agentId), runState: text(thisSeat?.runState), replied: repliedOf(thisSeat) },
    seatsTotal: seats.length,
    seatsArrived: arrived,
    complete: seats.length > 0 && arrived === seats.length,
  };
}

// ===== 验证 =====

function resultRow(result) {
  if (result === null || typeof result !== "object") return null;
  return {
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
    timedOut: result.timedOut === true,
    durationMs: Number.isFinite(result.durationMs) && result.durationMs >= 0 ? Math.round(result.durationMs) : null,
  };
}

function commandRows(commands, results, redactor) {
  if (!Array.isArray(commands)) return [];
  const resultList = Array.isArray(results) ? results : [];
  return commands.slice(0, OWNER_COMMANDS_MAX).map((command, index) => ({
    index,
    command: typeof command === "string" ? safeText(command, redactor, OWNER_COMMAND_MAX_CHARS) : null,
    result: resultRow(resultList.find((result) => result?.index === index)),
  }));
}

const verificationOf = (ref) => (ref !== null && typeof ref === "object" && ref.verification !== null && typeof ref.verification === "object"
  ? ref.verification
  : null);

/**
 * 当前提交的有效验证：状态取校验过的事实。**执行结果与失败信息只取绑定的验证结果事件**（有复验
 * 链就取复验结果）——还在待验证的 created 引用里带的 results 不是结果，没有结果事件时命令只列
 * 声明、结果为 null。具名不可验证（status unavailable）另给脱敏、折路径后的原因文本。
 */
function verificationBlock(delivery, redactor) {
  const facts = delivery.facts;
  const outcome = verificationOf(facts.effectiveRef ?? facts.verificationOutcomeEvent?.delivery ?? null);
  const declared = outcome ?? verificationOf(facts.createdRef) ?? {};
  const status = memberOf(DELIVERY_VERIFICATION_STATUSES, facts.effectiveVerificationStatus);
  const reason = declared.unavailableReason;
  return {
    source: "system_observed",
    boundCommit: delivery.commit,
    status,
    unavailableReason: status === "unavailable" && typeof reason === "string" && reason.length > 0
      ? safeText(reason, redactor, OWNER_UNAVAILABLE_REASON_MAX_CHARS)
      : null,
    commands: commandRows(declared.commands, outcome?.results, redactor),
    setupCommands: commandRows(declared.setupCommands, outcome?.setupResults, redactor),
    failure: status !== "failed" || outcome === null
      ? null
      : {
        code: memberOf(DELIVERY_VERIFICATION_FAILURE_CODES, outcome.failureCode) ?? "unknown",
        phase: outcome.failedPhase === "setup" || outcome.failedPhase === "assertion" ? outcome.failedPhase : null,
        commandIndex: nonNegativeInt(outcome.failedCommandIndex),
      },
  };
}

// ===== 交付物 =====

function filesBlock(delivery, stats, redactor) {
  const files = delivery.changedFiles;
  const items = files.slice(0, OWNER_FILES_MAX).map((raw, index) => {
    const stat = stats !== null && typeof raw === "string" ? stats.get(raw) : undefined;
    return {
      index,
      path: displayPath(raw, redactor),
      added: stat === undefined ? null : stat.added,
      deleted: stat === undefined ? null : stat.deleted,
      binary: stat?.binary === true,
    };
  });
  return { source: "system_observed", total: files.length, truncated: files.length > OWNER_FILES_MAX, items };
}

function imageItems(delivery, redactor) {
  const out = [];
  for (let index = 0; index < delivery.changedFiles.length && out.length < OWNER_IMAGES_MAX; index += 1) {
    const raw = delivery.changedFiles[index];
    if (!isImagePath(raw)) continue;
    const path = displayPath(raw, redactor);
    if (path !== OWNER_PATH_WITHHELD) out.push({ index, path });
  }
  return out;
}

/**
 * 写代码 / 生图的交付物：转录里绑定的交付事实（delivery，请求当刻现算的那一份）+ 仓库证明过之后
 * 的增删行。证明（proveDelivery）每次请求都做：转录只是声明，提交类型、父提交 = 基线、实际变更
 * 清单 = changedFiles 对不上，或对象已被清掉，如实标 unavailable（转录里的事实仍照给，读不到的
 * 只有增删行）。
 */
async function gitDeliverable({ kind, runId, delivery, redactor, repoRoot, proveDelivery, reviews }) {
  const base = { kind, state: "none", reason: null, commit: null, files: null, verification: null };
  if (delivery.state === "none") return { ...base, ...(kind === "image" ? { images: [] } : { reviews }) };
  if (delivery.state === "conflict") {
    return { ...base, state: "unavailable", reason: "delivery_facts_conflict", ...(kind === "image" ? { images: [] } : { reviews }) };
  }
  let state = "bound";
  let reason = null;
  let stats = null;
  if (repoRoot === null || typeof proveDelivery !== "function") {
    state = "unavailable";
    reason = "repository_unknown";
  } else {
    try {
      const proof = await proveDelivery({
        runId, repoRoot, baseCommit: delivery.baseCommit, commit: delivery.commit, changedFiles: delivery.changedFiles,
      });
      if (proof.ok === true) {
        stats = proof.stats;
      } else {
        state = "unavailable";
        reason = proof.reason === "mismatch" ? "delivery_facts_conflict" : "git_read_failed";
      }
    } catch {
      state = "unavailable";
      reason = "git_read_failed";
    }
  }
  return {
    kind,
    state,
    reason,
    commit: { hash: delivery.commit, source: "system_observed" },
    files: filesBlock(delivery, stats, redactor),
    verification: verificationBlock(delivery, redactor),
    ...(kind === "image" ? { images: imageItems(delivery, redactor) } : { reviews }),
  };
}

function researchDeliverable(events, run, redactor, env) {
  const full = extractFinalAssistantText(events, { runId: run.runId, env });
  if (full.trim().length === 0) return { kind: "research", state: "none", answer: null };
  const head = safeBody(full, redactor, OWNER_ANSWER_MAX_CHARS);
  return {
    kind: "research",
    state: "bound",
    answer: {
      source: "worker_reported",
      text: head.text,
      truncated: head.truncated,
      keptChars: head.text.length,
      totalChars: head.totalChars,
    },
  };
}

// ===== 任务书 =====

/**
 * 最后一条绑定的 prompt.sent；没有就如实 missing。会审席（seatConsult 是它所在的那场会审）的
 * prompt 末尾是控制面实际追加的固定合同后缀（唯一落盘的控制面包装）：按该场会审记录里声明的
 * fields 用写入端同一个构造重建这段后缀，精确匹配才剥（stripConsultSeatContract）；匹配不上
 * 就保留全文。普通任务书正文里引用了标记也原样保留。
 */
function briefBlock(events, runId, redactor, seatConsult) {
  const prompt = findLatestBound(events, "prompt.sent", runId)?.prompt;
  let body = typeof prompt === "string" ? prompt : "";
  if (seatConsult !== null) body = stripConsultSeatContract(body, seatConsult.declaredFields);
  if (body.trim().length === 0) return { state: "missing", text: null, truncated: false, keptChars: 0, totalChars: 0 };
  const head = safeBody(body, redactor, OWNER_BRIEF_MAX_CHARS);
  return { state: "present", text: head.text, truncated: head.truncated, keptChars: head.text.length, totalChars: head.totalChars };
}

// ===== 失败诊断 =====

/**
 * 隔离违规事件的展示字段：已批准的例外（它们本来就是"越界去了哪里"，不折成末段）。字段来自
 * isolationViolationDetail（src/diagnosis.js，看板与 MCP run_diagnose 共用的唯一读侧投影）：
 * 只有越界类原因才有 destination 与路径，路径已按写入侧同一条显示规则先脱敏（服务端的 env 精确值与
 * 形状）、主目录换成 ~、用户名段守卫、清控制字符与双向格式控制符、最后才限长。这里只把缺席的键补成
 * null，DTO 形状固定；不再二次加工。
 */
export function isolationBlock(fields) {
  if (fields === null || fields === undefined) return null;
  return {
    reason: fields.reason ?? null,
    destination: fields.destination ?? null,
    reportedPath: fields.reportedPath ?? null,
    resolvedPath: fields.resolvedPath ?? null,
    escapedAt: fields.escapedAt ?? null,
  };
}

/** 失败时的诊断：类别与码取闭集，证据文本先脱敏、折路径再限长；workdir_escape 另附隔离违规事件的展示字段。 */
function failureBlock(run, events, redactor, env) {
  if (run.failure === null || run.failure === undefined) return null;
  let diagnosis;
  try {
    diagnosis = diagnoseFailure(events, run.runId);
  } catch {
    diagnosis = { category: run.failure.category, code: run.failure.code, evidence: [] };
  }
  const category = memberOf(DIAGNOSIS_CATEGORIES, diagnosis.category);
  const evidence = (Array.isArray(diagnosis.evidence) ? diagnosis.evidence : [])
    .slice(0, OWNER_DIAGNOSIS_EVIDENCE_MAX)
    .map((entry) => ({
      eventType: safeText(text(entry?.eventType) ?? "", redactor, 64),
      fact: safeText(text(entry?.fact) ?? "", redactor, OWNER_DIAGNOSIS_FACT_MAX_CHARS),
    }));
  return {
    category,
    code: category !== null && isValidDiagnosisCode(category, diagnosis.code) ? diagnosis.code : null,
    evidence,
    isolation: category === "workdir_escape" ? isolationBlock(isolationViolationDetail(events, run.runId, { env })) : null,
  };
}

// ===== 装配 =====

/**
 * 这个运行在快照里"绑定了事件号"的事实（第 143b 批修正二），作为 Copy ref 的 runId#seq。
 * 这些都是快照里已有的绑定事实，所以事项移出 Attention 的 24 小时窗口以后仍能给出同一个引用。
 *
 * 取与 Attention 证据同样的落点，而不是简单取最大：失败 / 超时取终态事件（有额度观测时取较晚的观测，
 * 与事项的"同一运行多条证据取最大"一致）；其余按当前事实的落点——Lead 裁决 → 交付收口 → 额度观测 →
 * 最后实质进展 → 终态。一个都没有（旧档没有事件号 / 没有这类事实）就是 null，前端回退到裸 run 号，
 * 不编造。
 */
function boundRefSeq(run) {
  const valid = (value) => Number.isInteger(value) && value >= 1;
  if (run?.state === "failed" || run?.state === "timed_out") {
    // A failed run has a failed item (its terminal event) and possibly a capacity item (the observation);
    // the attention evidence of the same run takes the greater of the two.
    const values = [run?.terminalSeq, run?.capacity?.observedSeq].filter(valid);
    return values.length === 0 ? null : Math.max(...values);
  }
  // Otherwise the anchor of the fact in force, in the same order the attention items use it.
  const candidates = [
    run?.delivery?.acceptance?.decidedSeq,
    run?.delivery?.settledSeq,
    run?.capacity?.observedSeq,
    run?.quietSinceSeq,
    run?.terminalSeq,
  ];
  for (const value of candidates) if (valid(value)) return value;
  return null;
}

/**
 * 单个 worker 的详情 DTO。
 *
 * @param {object} input
 * @param {object} input.run — 快照里该运行的行（availability 必须是 ok）
 * @param {object} input.snapshot — 同一份发布的快照（会审组）
 * @param {Map<string, object>} input.runsById — 快照里的运行（按 runId）
 * @param {object[]} input.events — 这一刻读到的该运行的转录事件
 * @param {number} input.now — 发布快照时的 now（epoch ms）
 * @param {object} [input.env] — 脱敏用的环境（缺省 process.env）
 * @param {string|null} [input.repoRoot] — 项目仓库根（服务端持有，不进 DTO）
 * @param {Function|null} [input.proveDelivery] — ({ runId, repoRoot, baseCommit, commit, changedFiles }) →
 *   Promise<{ok: true, stats: Map}|{ok: false, reason}>（createDeliveryProver 的结果）
 * @returns {Promise<object>}
 */
export async function projectWorkerDetail({
  run, snapshot, runsById, events, now, env, repoRoot = null, proveDelivery = null,
}) {
  const redactor = createSecretRedactor(env ?? process.env);
  const consults = Array.isArray(snapshot?.consults) ? snapshot.consults : [];
  const seatOf = consults.find((consult) => hasSeat(consult, run.runId)) ?? null;
  // 一次响应只用一代事实：当前交付只在请求当刻的转录上算这一次，交付物、交付轴与"会审是不是在
  // 这份交付之后"都从它出（产物接口也用同一个 currentDelivery）。
  const delivery = currentDelivery(events, run.runId);
  const createdMs = msOf(delivery.createdAt);
  const reviews = consults
    .filter((consult) => consult.reviewedRunId === run.runId)
    .slice(0, OWNER_REVIEWS_MAX)
    .map((consult) => {
      const consultMs = msOf(consult.createdAt);
      return {
        consultId: text(consult.consultId),
        createdAt: text(consult.createdAt),
        // 这场会审的 createdAt 不早于当前交付的 created 事件时：意见针对的是这份交付；
        // 否则针对的是更早的候选。两个时刻读不出就不下结论（null）。
        afterCurrentDelivery: createdMs === null || consultMs === null ? null : consultMs >= createdMs,
        ...consultRows(consult, runsById),
      };
    });

  // kind 的顺序：会审席 → 生图 → 有绑定的交付事实（写代码）→ 调研角色 → none。deliveryRequested
  // 只表示意图：不能盖过调研类型，也不是历史交付（没有请求标记、但转录里有绑定交付事实）成为
  // 写代码交付物的前提；只有意图、没有交付事实的普通运行是 none（不按意图补一个写代码交付物）。
  let deliverable;
  if (seatOf !== null) {
    deliverable = { kind: "consult", state: "bound", consultId: text(seatOf.consultId), reviewedRunId: safeRunId(seatOf.reviewedRunId), ...consultRows(seatOf, runsById) };
  } else if (run.taskType === "image") {
    deliverable = await gitDeliverable({ kind: "image", runId: run.runId, delivery, redactor, repoRoot, proveDelivery, reviews });
  } else if (delivery.state !== "none") {
    deliverable = await gitDeliverable({ kind: "code", runId: run.runId, delivery, redactor, repoRoot, proveDelivery, reviews });
  } else if (run.taskType === "research") {
    deliverable = researchDeliverable(events, run, redactor, env);
  } else {
    deliverable = { kind: "none", state: "none" };
  }

  // 交付轴与交付物同一代：交付事实在请求当刻读到的转录上现算（与快照同一个提取），快照里只有
  // 转录之外的事实（分支是否还在）才沿用。这一次读到的转录里没有请求标记、或读不出交付事实 →
  // 交付轴清空（null），**不回退**快照里的旧一代：否则同一响应里交付物是新提交、交付轴还是旧提交。
  const liveFacts = liveDeliveryFacts(events, run.runId);
  const axisRun = {
    ...run,
    delivery: liveFacts === null
      ? null
      : { ...projectDelivery(run.runId, liveFacts, undefined), branchPresent: run.delivery?.branchPresent ?? null },
  };

  const startedMs = msOf(run.startedAt);
  const terminalMs = msOf(run.terminalAt);
  const stageMs = msOf(run.stageSince);
  let elapsedMs = null;
  if (startedMs !== null) {
    if (run.terminal === true) elapsedMs = terminalMs === null ? null : Math.max(0, terminalMs - startedMs);
    else elapsedMs = Math.max(0, now - startedMs);
  }
  const titles = ownerRunTitles(run, runsById);

  return {
    runId: run.runId,
    // The Copy ref's event number: the greatest bound snapshot fact of THIS run (see boundRefSeq). It is
    // independent of the attention item, which may have left the 24-hour window already.
    refSeq: boundRefSeq(run),
    identity: {
      title: titles.title,
      subtitle: titles.subtitle,
      taskType: text(run.taskType),
      laneKey: ownerLaneKey(run),
      roleId: text(run.roleId),
      project: run.project === null || run.project === undefined ? null : { slug: text(run.project.slug), name: text(run.project.name) },
      startedAt: text(run.startedAt),
      elapsedMs,
    },
    health: {
      liveness: memberOf(OWNER_LIVENESS_VALUES, run.liveness) ?? "unknown",
      lastEffectAt: text(run.lastEffectAt),
      lastVitalAt: text(run.lastVitalAt),
      lastHeartbeatAt: text(run.lastHeartbeatAt),
      lastProcessActiveAt: text(run.lastProcessActiveAt),
      failure: failureBlock(run, events, redactor, env),
    },
    run: {
      state: text(run.state),
      stage: memberOf(OWNER_STAGE_VALUES, run.stage) ?? "stage_unknown",
      stageSince: text(run.stageSince),
      stageAgeMs: run.stage === "starting" && stageMs !== null ? Math.max(0, now - stageMs) : null,
      terminalAt: text(run.terminalAt),
    },
    delivery: deliveryAxis(axisRun, runsById),
    consult: seatOf === null ? null : consultAxis(seatOf, run.runId),
    deliverable,
    brief: briefBlock(events, run.runId, redactor, seatOf),
  };
}
