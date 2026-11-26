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
//   - 交付提交的逐文件增删行：调用方注入的 readNumstat（git diff --numstat，只读 Git
//     对象）。
//
// 边界：
//   - DTO 走白名单：逐个字段挑出来组装，不整包透传任何应用层对象。gatherDeliveryView 的
//     deliveryRef（带工作树路径）与快照里的项目 key 一律不出去；项目只给 slug 与名字。
//   - 所有动态文本先过秘密与形状脱敏（exact + 形状）、再清控制字符、再限长，复用
//     runActivityProjection 的同一条管道（headOfRedactedText）。路径：交付物文件清单只给
//     通过仓库相对路径判定（isValidRepoRelativePath：非绝对、无 ..、无空段）的路径，其余
//     给 [path_withheld]。唯一的例外是隔离违规事件自己的脱敏路径（reportedPath、
//     resolvedPath、escapedAt），它们本来就是"越界去了哪里"，读侧仍再清一次控制字符、
//     再限一次长。
//   - 每项事实标明出处：source = system_observed（控制面自己观测到的：交付提交、文件清单、
//     增删行、验证命令与结果）或 worker_reported（worker 自己写的：调研答复、会审席的
//     结论）。没有交付物就如实写 none，不按助手的自述补。
//
// 交付物的三种状态（state）：bound（有绑定的 Git 产物，对象读得到；调研答复与会审组有
// 内容也算 bound）、none（尚未观测到交付物）、unavailable（有绑定但对象已不可用：交付
// 事实自相矛盾、项目仓库不明、Git 读取失败——reason 给闭集原因；转录里的事实仍照给，
// 读不到的只有增删行）。
//
// 架构契约：不 import src/commands/*、src/mcp/*、MCP SDK 或 zod；只读。

import { createSecretRedactor } from "../secretRedaction.js";
import {
  DIAGNOSIS_CATEGORIES,
  diagnoseFailure,
  isValidDiagnosisCode,
  projectWorkdirEscapeFields,
} from "../diagnosis.js";
import { findLatestBound, validateDeliveryFacts } from "../transcript.js";
import { isCanonicalCommitId, isValidRepoRelativePath } from "../delivery.js";
import { extractFinalAssistantText, CONSULT_SEAT_CONTRACT_MARKER } from "./consultService.js";
import { OWNER_CONSULT_Q1_VALUES, OWNER_LIVENESS_VALUES, OWNER_STAGE_VALUES } from "./ownerReadModel.js";
import { ownerLaneKey, ownerRunTitles } from "./ownerAttention.js";
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
/** 隔离违规事件路径类字段的字符上限（与诊断模块同一个上限）。 */
export const OWNER_ISOLATION_FIELD_MAX_CHARS = 300;
/** 关联会审至多列多少场。 */
export const OWNER_REVIEWS_MAX = 10;
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
 *
 * @param {object[]} events
 * @param {string} runId
 * @returns {{state: string, commit: string|null, baseCommit: string|null, changedFiles: unknown[], facts: object|null}}
 */
export function currentDelivery(events, runId) {
  const none = { state: "none", commit: null, baseCommit: null, changedFiles: [], facts: null };
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
  return {
    state: "bound",
    commit: ref.deliveryCommit,
    baseCommit: ref.baseCommit,
    changedFiles: Array.isArray(ref.changedFiles) ? ref.changedFiles : [],
    facts,
  };
}

// ===== 文本与路径 =====

/** 动态文本的安全链：脱敏 → 清控制字符 → 限长（取头）。 */
function safeText(raw, redactor, maxChars) {
  return headOfRedactedText(raw, redactor, maxChars).text;
}

/** 文件清单里的路径：只给仓库相对路径（无控制字符），其余 [path_withheld]。 */
function displayPath(raw, redactor) {
  if (typeof raw !== "string" || !isValidRepoRelativePath(raw) || CONTROL_CHAR_RE.test(raw)) return OWNER_PATH_WITHHELD;
  return safeText(raw, redactor, OWNER_PATH_MAX_CHARS);
}

const isImagePath = (raw) => typeof raw === "string"
  && OWNER_IMAGE_EXTENSIONS.some((extension) => raw.toLowerCase().endsWith(extension));

// ===== 谱系轮次与交付轴 =====

/** 续修轮次：沿已证实的父边（parentRunId）往上数；断在快照之外或成环时 complete: false。 */
function continuationRound(run, runsById) {
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

function seatRow(seat, runsById) {
  const seatRun = typeof seat?.runId === "string" ? runsById.get(seat.runId) : undefined;
  return {
    laneKey: (seatRun === undefined ? null : ownerLaneKey(seatRun)) ?? text(seat?.agentId),
    agentId: text(seat?.agentId),
    runId: text(seat?.runId),
    runState: text(seat?.runState),
    q1: memberOf(OWNER_CONSULT_Q1_VALUES, seat?.q1),
    source: "worker_reported",
  };
}

/** 一场会审的席位行与分裂标志：split = 给了结论的席位里有两个以上不同的值；没声明 Q1 → null。 */
function consultRows(consult, runsById) {
  const rows = (Array.isArray(consult.seats) ? consult.seats : []).map((seat) => seatRow(seat, runsById));
  const q1Declared = consult.q1Declared === true;
  return {
    q1Declared,
    split: q1Declared ? new Set(rows.map((row) => row.q1).filter((q1) => q1 !== null)).size >= 2 : null,
    rows,
  };
}

function consultAxis(consult, runId) {
  const seats = Array.isArray(consult.seats) ? consult.seats : [];
  const thisSeat = seats.find((seat) => seat?.runId === runId);
  const arrived = seats.filter((seat) => seat?.runState === "completed").length;
  return {
    consultId: text(consult.consultId),
    createdAt: text(consult.createdAt),
    reviewedRunId: text(consult.reviewedRunId),
    thisSeat: { agentId: text(thisSeat?.agentId), runState: text(thisSeat?.runState) },
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

/** 当前提交的有效验证：状态取校验过的事实，命令与结果取绑定当前提交的验证事件（有复验链就取复验结果）。 */
function verificationBlock(delivery, redactor) {
  const facts = delivery.facts;
  const ref = facts.effectiveRef ?? facts.verificationOutcomeEvent?.delivery ?? facts.createdRef;
  const verification = ref !== null && typeof ref === "object" && ref.verification !== null && typeof ref.verification === "object"
    ? ref.verification
    : {};
  const status = memberOf(DELIVERY_VERIFICATION_STATUSES, facts.effectiveVerificationStatus);
  return {
    source: "system_observed",
    boundCommit: delivery.commit,
    status,
    commands: commandRows(verification.commands, verification.results, redactor),
    setupCommands: commandRows(verification.setupCommands, verification.setupResults, redactor),
    failure: status !== "failed"
      ? null
      : {
        code: memberOf(DELIVERY_VERIFICATION_FAILURE_CODES, verification.failureCode) ?? "unknown",
        phase: verification.failedPhase === "setup" || verification.failedPhase === "assertion" ? verification.failedPhase : null,
        commandIndex: nonNegativeInt(verification.failedCommandIndex),
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

/** 写代码 / 生图的交付物：转录里绑定的交付事实 + 读得到时的增删行。 */
async function gitDeliverable({ kind, events, run, redactor, repoRoot, readNumstat, reviews }) {
  const delivery = currentDelivery(events, run.runId);
  const base = { kind, state: "none", reason: null, commit: null, files: null, verification: null };
  if (delivery.state === "none") return { ...base, ...(kind === "image" ? { images: [] } : { reviews }) };
  if (delivery.state === "conflict") {
    return { ...base, state: "unavailable", reason: "delivery_facts_conflict", ...(kind === "image" ? { images: [] } : { reviews }) };
  }
  let state = "bound";
  let reason = null;
  let stats = null;
  if (repoRoot === null || typeof readNumstat !== "function") {
    state = "unavailable";
    reason = "repository_unknown";
  } else {
    try {
      stats = await readNumstat({ repoRoot, baseCommit: delivery.baseCommit, commit: delivery.commit });
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
  const head = headOfRedactedText(full, redactor, OWNER_ANSWER_MAX_CHARS);
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

/** 最后一条绑定的 prompt.sent；会审席的固定合同包装（唯一落盘的控制面包装）跳过；没有就如实 missing。 */
function briefBlock(events, runId, redactor) {
  const prompt = findLatestBound(events, "prompt.sent", runId)?.prompt;
  let body = typeof prompt === "string" ? prompt : "";
  const wrapperAt = body.lastIndexOf(CONSULT_SEAT_CONTRACT_MARKER);
  if (wrapperAt >= 0) body = body.slice(0, wrapperAt);
  if (body.trim().length === 0) return { state: "missing", text: null, truncated: false, keptChars: 0, totalChars: 0 };
  const head = headOfRedactedText(body, redactor, OWNER_BRIEF_MAX_CHARS);
  return { state: "present", text: head.text, truncated: head.truncated, keptChars: head.text.length, totalChars: head.totalChars };
}

// ===== 失败诊断 =====

function isolationBlock(fields, redactor) {
  if (fields === null) return null;
  const bounded = (value) => (value === null ? null : safeText(value, redactor, OWNER_ISOLATION_FIELD_MAX_CHARS));
  return {
    reason: fields.reason,
    destination: fields.destination,
    reportedPath: bounded(fields.reportedPath),
    resolvedPath: bounded(fields.resolvedPath),
    escapedAt: bounded(fields.escapedAt),
  };
}

/** 失败时的诊断：类别与码取闭集，证据文本先脱敏再限长；workdir_escape 另附隔离违规事件的展示字段。 */
function failureBlock(run, events, redactor) {
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
    isolation: category === "workdir_escape" ? isolationBlock(projectWorkdirEscapeFields(events, run.runId), redactor) : null,
  };
}

// ===== 装配 =====

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
 * @param {Function|null} [input.readNumstat] — ({ repoRoot, baseCommit, commit }) → Promise<Map>
 * @returns {Promise<object>}
 */
export async function projectWorkerDetail({
  run, snapshot, runsById, events, now, env, repoRoot = null, readNumstat = null,
}) {
  const redactor = createSecretRedactor(env ?? process.env);
  const consults = Array.isArray(snapshot?.consults) ? snapshot.consults : [];
  const seatOf = consults.find((consult) => hasSeat(consult, run.runId)) ?? null;
  const reviews = consults
    .filter((consult) => consult.reviewedRunId === run.runId)
    .slice(0, OWNER_REVIEWS_MAX)
    .map((consult) => ({
      consultId: text(consult.consultId),
      createdAt: text(consult.createdAt),
      ...consultRows(consult, runsById),
    }));

  let deliverable;
  if (seatOf !== null) {
    deliverable = { kind: "consult", state: "bound", consultId: text(seatOf.consultId), reviewedRunId: text(seatOf.reviewedRunId), ...consultRows(seatOf, runsById) };
  } else if (run.taskType === "image" || run.deliveryRequested === true) {
    deliverable = await gitDeliverable({
      kind: run.taskType === "image" ? "image" : "code", events, run, redactor, repoRoot, readNumstat, reviews,
    });
  } else if (run.taskType === "research") {
    deliverable = researchDeliverable(events, run, redactor, env);
  } else {
    deliverable = { kind: "none", state: "none" };
  }

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
      lastProcessActiveAt: text(run.lastProcessActiveAt),
      failure: failureBlock(run, events, redactor),
    },
    run: {
      state: text(run.state),
      stage: memberOf(OWNER_STAGE_VALUES, run.stage) ?? "stage_unknown",
      stageSince: text(run.stageSince),
      stageAgeMs: run.stage === "starting" && stageMs !== null ? Math.max(0, now - stageMs) : null,
      terminalAt: text(run.terminalAt),
    },
    delivery: deliveryAxis(run, runsById),
    consult: seatOf === null ? null : consultAxis(seatOf, run.runId),
    deliverable,
    brief: briefBlock(events, run.runId, redactor),
  };
}
