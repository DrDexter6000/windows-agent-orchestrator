// src/application/ownerAttention.js
//
// 决定 0131 §7（第 140c 批）：Owner 看板的事项推导。从一份快照（ownerReadModel.snapshot
// 的返回值）算出三栏事项与各处计数：
//   - decide：    值得你拿主意——交付会审结论不一致、交付验证没过 / 没验成 / 收口判定不清、
//                 等裁决超过 2 小时、车道额度耗尽；
//   - anomalies： 异常——24 小时内失败且没有后续成功的运行、静默超过 30 分钟的运行、
//                 只剩进程体征超过 30 分钟的运行、车道被限流 / 上游过载、车道额度用尽
//                 （quota_exhausted 是 decide 那一件的镜像，两栏各一件，见下"额度"）；
//   - resolved：  上面各类里已了结、且了结时刻在 24 小时内的，按了结时刻倒序。
//
// 边界：
//   - 纯函数。只读 snapshot() 的返回值和一个 now：不读盘、不调 git，不另写交付 / 谱系 /
//     会审 / 额度的判定——口径都在快照字段里，这里只做分组、比时间和计数。
//   - 读不到不当成"没有"，更不当成"已了结"。解除只认快照里明确的证据（裁决、被取代、
//     复验通过、后续成功）；该解除的字段读不到、因而确认不了"仍未解除"的，事项状态写
//     unknown。见下文"unknown 的来历"。
//   - id 是稳定的组 ID：同一份快照、同一个 now 算多少次都一样；换 now 只改时效。
//   - 时间一律照抄快照里的 ISO 串；读不到（不是字符串）就是 null。这里只查类型、不校验
//     ISO 形状：形状不合的串原样留在 since / evidence.at 里，参与时间比较时按读不出处理
//     （事项不成立，或不进"已了结"栏）；不替快照补时刻。
//
// 事项（Item）的字段：
//   id、kind、state（open | unknown | resolved）、runIds（事项挂着的运行）、
//   projectSlugs（事项归属的项目，去重排序：会审事项含会审所在项目与被审运行的项目，
//   其余事项含它全部 runIds 的项目）、
//   since（证据事件自己的时间，不是"被观测到"的时间，所以服务重启后能从转录事实重建）、
//   evidence（[{ runId, at, seq }]；seq 是该时间点所取事件的事件号，快照里读不到——旧转录
//   没有 seq——就是 null，不编造）。
//   交付类事项（consult_split、verification_failed / unavailable、delivery_ambiguous、
//   awaiting_decision）另带 commit：当前绑定的交付提交（会审事项取被审运行的）；交付事实
//   自相矛盾、读不出时是 null（"未知"）。consult_split 另带 seatRunIds：会审的全部席位运行
//   （evidence 只列给了结论的席位；牵涉的 worker = runIds 的被审运行 + seatRunIds）。
//   resolvedAt 与 resolution 只在 resolved 时有；此时 evidence 末尾多一条解除证据。
//   个别种类带自己的字段：额度事项带 laneKey 与 capacityCode（quota_exhausted |
//   rate_limited | overloaded，最后一次观测的码）；failed 事项带 failure（快照里的
//   failure.{category, code}），未了结时再带 followUp 与 followUpRuns（exists | none | unknown，见
//   followUpsOf：有链到它的后续运行就是 exists，followUpRuns 列出它们与各自当前状态——运行中、失败等
//   都只是状态；快照读得全、谱系根已知、没有链到它的后续时才是 none；缺一条证据是 unknown。
//   "后续"要求在失败之后才开始）。
//
// 各类事项的 since 与证据取自哪里：
//   - consult_split：since 是会审的 createdAt；证据是每个给了结论的席位（runId 是席位
//     运行，at 取该席位运行的 terminalAt——快照里没有"席位给出结论"这条事件自己的时间，
//     terminalAt 是最接近的事实；席位运行不在快照里或没有终态时刻就是 null）。
//     Q1 为 null 的席位不参与判定，也不进证据。
//   - verification_failed / verification_unavailable：有效验证状态是 failed / unavailable；
//     since 与证据是 settledAt（收口时刻 = 终态与有效验证结果事件里较晚的那个）。
//   - delivery_ambiguous：收口判定为 undeterminable，或理由是 terminal_delivery_ambiguous，
//     且**确有交付记录**（commit 读得到，或交付视图 ambiguous 为真——读模型对"创建与验证
//     引用了不同提交"的交付故意不给 commit、只给 ambiguous）。没有交付记录的失败 / 中止
//     运行（commit 与 ambiguous 都读不出）不算交付事项。since 与证据是终态时刻
//     （undeterminable 没有收口时刻）。
//   - awaiting_decision：delivery_settled、待裁决、等了超过 2 小时；since 与证据是 settledAt。
//     "等了多久"算到解除那一刻：仍待裁决算到现在，已裁决 / 已被取代的算到 resolvedAt。所以
//     收口后不到 2 小时就被裁决的交付哪一栏都不在；等过 3 小时才被裁决的，裁决当下就进
//     "已了结"栏（resolvedAt 在 24 小时内）。
//   - quota_exhausted：额度耗尽，进 decide；Owner 已定额度用尽也计入 Alerts，所以异常栏再列
//     一件镜像（id 为 capacity_alert:<车道键>，其余字段相同；已了结的镜像不进 resolved，
//     避免同一件事列两遍）。rate_limited / overloaded 归 rate_limited，只进 anomalies（同一
//     运行另有 failed 异常照留）。都按车道键分组，since 是最后一次观测的 observedAt，证据是
//     最新的 10 次观测（按观测时刻升序；解除证据附在末尾）。
//   - failed：since 与证据是失败的终态时刻。
//   - silent / process_only：since 与证据是 quietSince。
//
// 解除与它的证据（evidence 里多出的那一条）：
//   - decided：delivery.acceptance.status 是 accepted / rejected，resolvedAt = decidedAt。
//   - superseded：supersededByRunId 非空，resolvedAt 取取代者的 decidedAt，取代者不在快照
//     里或它没有裁决时间就是 null（也就不进"已了结"栏）。
//   - reverify_passed：有效验证状态 passed 且复验链完成，resolvedAt = settledAt（复验完成
//     时它就是复验结果事件的时间）。种类记 verification_failed：能开复验链的原始验证只
//     可能是 failed（runDeliveryReverify 的前置条件），快照本身不留原始状态。
//   - later_success：同车道（额度事项）或同谱系 / retryOf（failed 事项）里，有运行在证据
//     时刻之后完成；多个取最早的那个，resolvedAt = 它的 terminalAt。failed 的"后续"
//     （解除用的后续成功，与未了结时的 followUp: exists）还要求后续运行在失败运行的
//     terminalAt 之后才开始（startedAt >= terminalAt）：并发跑着的兄弟运行不算后续。
//   同一事项多种解除并存时按上面的先后取第一种。awaiting_decision 只认 decided 与
//   superseded；consult_split 不认 reverify_passed。
//
// unknown 的来历（都不是"已了结"，也都不带 resolvedAt / resolution）：
//   - 交付类事项（awaiting_decision 除外，它本来就要求待裁决）：delivery.acceptance.status
//     读不到，或 supersessionUndeterminable 为真；
//   - awaiting_decision：supersessionUndeterminable 为真；或 settledAt 读不到（说不清等了
//     多久，照样列）；
//   - silent / process_only：quietSince 读不到；
//   - 额度事项：最后一次观测之后没有同车道的运行完成，且证据超过 6 小时（说不清现在是否
//     仍然耗尽）。
//   列入窗口（24 小时）按种类——不是所有种类都看年龄：
//   - failed 与额度事项的未了结项（open / unknown）按证据时刻列：证据在 24 小时内才列；
//   - 交付类与会审事项（consult_split、verification_failed / verification_unavailable、
//     delivery_ambiguous、awaiting_decision）不设年龄窗口：只要分支还在
//     （delivery.branchPresent === true）就列，收口 / 会审多老都不影响；
//   - silent / process_only 只看现时状态（活性不再是 silent / process_only 就消失）；
//   - resolved 一律按 resolvedAt 的 24 小时窗口列，与证据多老无关（25 小时前失败、
//     1 小时前有后续成功 → 只进"已了结"栏）。
//   时刻读不到就不在窗口内，事项不成立（交付类与会审事项不受年龄窗口限制）。
//
// 交付类事项的前提（consult_split、三个交付验证类、awaiting_decision）：只看
// delivery.branchPresent === true 的运行。false 说明交付已回收，不再列（已了结的也不进
// "已了结"栏）；null（仓库不可观测）不列，但计入 counts.deliveryUnobservable，不当作 0。
// 验证还在跑（有效状态 pending）不是事项，计入 counts.verifying。
//
// 车道键：laneId，没有时回退 agentId（会审席没有 laneId）。两者都没有的额度证据成不了组，
// 事项不成立。额度事项按车道键跨项目分组（额度是车道的事，与项目无关）；projectSlugs 含
// 全部观测所在的项目（会审所在项目与被审运行项目同理，见上）。
//
// silent / process_only 只有现时状态：活性一旦不是 silent / process_only，事项就从列表消失，
// 不进 resolved（快照里没有能重建"它曾经静默"的事实）。
//
// counts：全局一份、每个项目一份，字段相同——running（非终态）、starting、liveness（各活性
// 值的个数）、verifying、deliveryUnobservable、decide / anomalies 的 open 数与 unknown 数。
// 定不了项目的运行与事项只进全局。projects 按 slug 码元序。
//
// 同源的两个选择函数（接口的 DTO 白名单在服务层，这里只管范围与排序）：
//   - selectOwnerWorkers：Workers 页的默认范围 = 非终态 ∪ 挂着 open / unknown 交付或会审
//     事项的运行 ∪ 终态时刻在 24 小时内的；按 startedAt 倒序（读不到的排最后）。
//     "挂着的事项"只算未了结的（额度、失败事项也算挂着）；"把运行带进范围"只算交付或会审
//     事项。给了 project 时，attentionIds 只列 projectSlugs 含该项目的未了结事项——与
//     /api/attention?project=X 同一筛选，不会"有 id 查不到"。卡片标题：续修运行
//     （lineageRootRunId 不是自己）用谱系根的标题作主标题、本轮标题作副标题；根不在快照里
//     （或根没有标题）就只用本轮标题。
//   - ownerLanes：有运行在跑、或有未了结额度事项的车道各一行；额度摘要取 since 最晚的
//     那一件（同一时刻 quota_exhausted 在前）。额度事项分属 decide（quota_exhausted）与
//     anomalies（rate_limited）两栏，汇总两栏都读。
//
// 快照里还没有、所以这里给不出的事实（详情页那一批再补）：席位给出结论的时刻；
// 原始验证状态。父子边（parentRunId）不用来认后续——failed 的后续（后续成功与
// followUp）只按谱系根与 retryOf 认，且要在失败之后才开始。
//
// 架构契约：不 import src/commands/*、src/mcp/*、MCP SDK 或 zod。

import { OWNER_CONSULT_Q1_VALUES, OWNER_LIVENESS_VALUES } from "./ownerReadModel.js";
import { TERMINAL_STATES } from "../transcript.js";

/** 等裁决：交付收口后待裁决超过这么久才列（待校准）。 */
export const OWNER_ATTENTION_DECIDE_AFTER_MS = 2 * 60 * 60 * 1000;
/** 额度证据：最后一次观测之后这么久没有后续成功，就说不清现在是否仍然耗尽（待校准）。 */
export const OWNER_ATTENTION_CAPACITY_FRESH_MS = 6 * 60 * 60 * 1000;
/** 静默：非终态运行没有实质动作超过这么久才列（待校准）。 */
export const OWNER_ATTENTION_QUIET_AFTER_MS = 30 * 60 * 1000;
/** 额度事项的证据最多带最近这么多次观测（按观测时刻取最新的；解除证据另加一条）。 */
export const OWNER_ATTENTION_CAPACITY_EVIDENCE_MAX = 10;
/** 窗口：失败、额度观测、已了结、Workers 默认范围里的终态，都只看这么多时间以内的（待校准）。 */
export const OWNER_ATTENTION_WINDOW_MS = 24 * 60 * 60 * 1000;

export const OWNER_ATTENTION_DECIDE_KINDS = Object.freeze([
  "consult_split",
  "verification_failed",
  "verification_unavailable",
  "delivery_ambiguous",
  "awaiting_decision",
  "quota_exhausted",
]);
// quota_exhausted 两栏都出现：值得拿主意（decide），同时计入异常（Owner 已定：车道限流或额度
// 用尽都计入 Alerts）。异常栏里的那一件是 decide 那件的镜像（id 为 capacity_alert:<车道键>）。
export const OWNER_ATTENTION_ANOMALY_KINDS = Object.freeze(["failed", "silent", "process_only", "rate_limited", "quota_exhausted"]);
/** 事项种类的闭集 = decide 栏的 + anomalies 栏的（quota_exhausted 两栏都有，只算一种）。 */
export const OWNER_ATTENTION_KINDS = Object.freeze([...new Set([...OWNER_ATTENTION_DECIDE_KINDS, ...OWNER_ATTENTION_ANOMALY_KINDS])]);
export const OWNER_ATTENTION_STATES = Object.freeze(["open", "unknown", "resolved"]);
export const OWNER_ATTENTION_RESOLUTIONS = Object.freeze(["decided", "superseded", "reverify_passed", "later_success"]);
/** failed 事项的后续：exists 有链到它的后续运行（followUpRuns 带各自当前状态）；none 有证据表明没有；unknown 证据不足。 */
export const OWNER_ATTENTION_FOLLOW_UPS = Object.freeze(["exists", "none", "unknown"]);
/** followUpRuns 至多带这么多个（最近开始的，按开始先后，最新的在最后）。 */
export const OWNER_ATTENTION_FOLLOW_UP_RUNS_MAX = 5;

/** 交付或会审事项：Workers 默认范围里，只有它们能把一个终态超过 24 小时的运行带进来。 */
const DELIVERY_CONSULT_KINDS = new Set([
  "consult_split", "verification_failed", "verification_unavailable", "delivery_ambiguous", "awaiting_decision",
]);
/** 额度码 → 事项种类（rate_limited 与 overloaded 同归 rate_limited）。 */
const CAPACITY_KINDS = new Map([
  ["quota_exhausted", "quota_exhausted"],
  ["rate_limited", "rate_limited"],
  ["overloaded", "rate_limited"],
]);
const CAPACITY_ITEM_KINDS = new Set(CAPACITY_KINDS.values());

// ===== 小工具 =====

/** 快照里的字符串字段；不是字符串（含 null / undefined）→ null。 */
const text = (value) => (typeof value === "string" ? value : null);

/** ISO 时刻 → epoch ms；读不出 → null。 */
function msOf(value) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** 在窗口内：年龄（未来时间钳成 0，与读模型的 withinWindow 同口径）不超过窗口；时刻读不到 → false。 */
function withinWindow(atMs, now, windowMs) {
  return atMs !== null && Math.max(0, now - atMs) <= windowMs;
}

const slugOf = (run) => text(run.project?.slug);

/** 项目归属：去重、按码元序；不是字符串的丢弃（读不出项目的运行不凭空造一个项目）。 */
function projectSlugsOf(...slugs) {
  const out = new Set();
  for (const slug of slugs) if (typeof slug === "string") out.add(slug);
  return [...out].sort();
}

/** 车道键：laneId，没有时回退 agentId；两者都没有 → null。 */
export function ownerLaneKey(run) {
  const laneId = text(run?.laneId);
  if (laneId !== null && laneId.length > 0) return laneId;
  const agentId = text(run?.agentId);
  return agentId !== null && agentId.length > 0 ? agentId : null;
}

/**
 * 卡片标题：续修运行（lineageRootRunId 不是自己）用谱系根的标题作主标题、本轮标题作
 * 副标题；根不在快照里（或根没有标题）就只用本轮标题。Workers 列表与单个 worker 详情
 * （第 141 批）共用这一份。
 * @param {object} run — 快照里的运行行
 * @param {Map<string, object>} runsById — 快照里的运行（按 runId）
 * @returns {{title: string|null, subtitle: string|null}}
 */
export function ownerRunTitles(run, runsById) {
  const own = text(run.title);
  const rootId = text(run.lineageRootRunId);
  const rootTitle = rootId !== null && rootId !== run.runId ? text(runsById.get(rootId)?.title) : null;
  return { title: rootTitle ?? own, subtitle: rootTitle === null ? null : own };
}

/** 事件号：快照里记下的 seq（正整数）；读不到（旧转录、没有这项事实）就是 null，不编造。 */
const seqValue = (seq) => (Number.isInteger(seq) && seq > 0 ? seq : null);

/** 一条证据：时间点 at 与它所取事件的事件号 seq（读不到为 null）。 */
const evidenceOf = (runId, at, seq = null) => ({ runId, at: text(at), seq: seqValue(seq) });

/**
 * 会审几席"已到"：已到终态**且**收到了答复——席位的运行状态与答复各自独立，不用一项代替
 * 另一项（完成但没有答复不算，失败但有答复算）。单个 worker 详情的会审轴
 * （ownerWorkerDetail.consultAxis）与 Workers 行上的会审摘要共用这一个口径。
 */
export function consultSeatsArrived(seats) {
  return (Array.isArray(seats) ? seats : []).filter((seat) => TERMINAL_STATES.includes(seat?.runState) && seat?.replied === true).length;
}

function requireNow(now) {
  if (!Number.isFinite(now)) {
    throw new TypeError("ownerAttention: now must be a finite epoch ms");
  }
}

/** 按 since 从早到晚（等得最久的在前），读不到的排最后；同一时刻按 id。 */
function bySince(a, b) {
  const left = msOf(a.since);
  const right = msOf(b.since);
  if (left !== right) return left === null ? 1 : right === null ? -1 : left - right;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 按证据时刻从早到晚；同一时刻按 runId。 */
function byEvidenceAt(a, b) {
  if (a.atMs !== b.atMs) return a.atMs - b.atMs;
  return a.run.runId < b.run.runId ? -1 : a.run.runId > b.run.runId ? 1 : 0;
}

// ===== 解除证据 =====

/** 已裁决：acceptance.status 是 accepted / rejected。 */
function decisionOf(runId, acceptance) {
  return {
    resolution: "decided",
    resolvedAt: text(acceptance.decidedAt),
    evidence: evidenceOf(runId, acceptance.decidedAt, acceptance.decidedSeq),
  };
}

/** 已被取代：resolvedAt 取取代者的裁决时间，取代者不在快照里就是 null。 */
function supersessionOf(run, runsById) {
  const by = text(run.supersededByRunId);
  if (by === null) return null;
  const acceptance = runsById.get(by)?.delivery?.acceptance;
  return { resolution: "superseded", resolvedAt: text(acceptance?.decidedAt), evidence: evidenceOf(by, acceptance?.decidedAt, acceptance?.decidedSeq) };
}

const isDecided = (acceptance) => acceptance?.status === "accepted" || acceptance?.status === "rejected";

/**
 * 候选运行里，在 afterMs 之后完成的最早一个（state 为 completed 且 terminalAt 更晚）。
 * 没有就 null。
 */
function earliestSuccess(runs, isCandidate, afterMs) {
  let best = null;
  for (const other of runs) {
    if (other.state !== "completed" || !isCandidate(other)) continue;
    const atMs = msOf(other.terminalAt);
    if (atMs === null || atMs <= afterMs) continue;
    if (best === null || atMs < best.atMs || (atMs === best.atMs && other.runId < best.run.runId)) best = { run: other, atMs };
  }
  return best === null
    ? null
    : { resolution: "later_success", resolvedAt: text(best.run.terminalAt), evidence: evidenceOf(best.run.runId, best.run.terminalAt, best.run.terminalSeq) };
}

/** failed 事项的后续：同一谱系（lineageRootRunId 相同）或 retryOf 指向它。 */
function isFollowUp(other, run) {
  const sameLineage = typeof run.lineageRootRunId === "string" && other.lineageRootRunId === run.lineageRootRunId;
  return (sameLineage || other.retryOf === run.runId) && other.runId !== run.runId;
}

/**
 * failed 事项的后续成功候选：先得是后续运行，且它是在失败之后才开始
 * （startedAt >= 失败的 terminalAt）——并发跑着的兄弟运行不算解除；开始时刻读不到、
 * 或失败时刻读不到（确认不了"之后"），都不算。
 */
function isLaterFollowUp(other, failed, failedAtMs) {
  if (failedAtMs === null || !isFollowUp(other, failed)) return false;
  const startedMs = msOf(other.startedAt);
  return startedMs !== null && startedMs >= failedAtMs;
}

/**
 * failed 事项的后续：只认链到它的运行（同谱系 lineageRootRunId 或 retryOf），且要在失败之后才开始。
 *   - exists：有这样的运行。followUpRuns 列出它们（按开始先后，至多 OWNER_ATTENTION_FOLLOW_UP_RUNS_MAX 个，
 *     最新的在最后），每个带当前 state——运行中、失败、停止等都只是状态，不是"有没有"的区别。
 *   - none：证据表明没有——快照里每个运行都读得出、没有谱系声明冲突的运行（否则读不出的那个可能就是
 *     后续）、失败运行自己的谱系根已知（否则认不出谁链到它）、链到它的运行开始时刻都读得出（否则
 *     确认不了先后）。这是"没有链到它的后续"的证据，不是"没人再派过同一件事"。
 *   - unknown：以上缺一条。
 * 后续成功的情形走 earliestSuccess（事项已了结），不在这里。
 */
function followUpsOf(runs, run, failedAtMs, censusComplete) {
  const linked = runs.filter((other) => isFollowUp(other, run));
  const later = linked
    .filter((other) => isLaterFollowUp(other, run, failedAtMs))
    .sort((a, b) => msOf(a.startedAt) - msOf(b.startedAt) || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  if (later.length > 0) {
    return {
      followUp: "exists",
      followUpRuns: later.slice(-OWNER_ATTENTION_FOLLOW_UP_RUNS_MAX).map((other) => ({ runId: other.runId, state: text(other.state) })),
    };
  }
  const provable = censusComplete && text(run.lineageRootRunId) !== null && linked.every((other) => msOf(other.startedAt) !== null);
  return { followUp: provable ? "none" : "unknown", followUpRuns: [] };
}

/**
 * 组装一条事项。resolution 为 null 就是未了结（state 取传入的 open / unknown）；否则是
 * resolved，带上 resolvedAt / resolution，证据末尾追加解除证据。extra 是该种类自己的字段。
 */
function makeItem(fields, resolution, extra) {
  const resolved = resolution !== null;
  const item = {
    id: fields.id,
    kind: fields.kind,
    state: resolved ? "resolved" : fields.state,
    runIds: fields.runIds,
    projectSlugs: fields.projectSlugs,
    since: fields.since,
    evidence: resolved ? [...fields.evidence, resolution.evidence] : fields.evidence,
  };
  // 交付类事项带当前交付提交（取自快照里绑定的交付事实；确定不了就是 null）。
  if (fields.commit !== undefined) item.commit = fields.commit;
  if (resolved) {
    item.resolvedAt = resolution.resolvedAt;
    item.resolution = resolution.resolution;
  }
  return extra === undefined ? item : { ...item, ...extra };
}

// ===== 事项推导 =====

function emptyCounts() {
  return {
    running: 0,
    starting: 0,
    liveness: Object.fromEntries(OWNER_LIVENESS_VALUES.map((value) => [value, 0])),
    verifying: 0,
    deliveryUnobservable: 0,
    decide: { open: 0, unknown: 0 },
    anomalies: { open: 0, unknown: 0 },
  };
}

/**
 * 从一份快照推导三栏事项与计数。纯函数，零 I/O；不改动传入的快照。
 *
 * @param {object} snapshot — ownerReadModel.snapshot({ now }) 的返回值
 * @param {{now: number}} options — 与出那份快照同一个 now（epoch ms）
 * @returns {{decide: object[], anomalies: object[], resolved: object[], counts: object}}
 *   decide / anomalies 只含未了结的（open 与 unknown），各按 since 从早到晚；resolved 是
 *   各类里 state === resolved 且 resolvedAt 在 24 小时内的，按 resolvedAt 倒序。
 *   counts 另有 projects：按 slug 码元序的数组，每项 { slug, …与全局相同的计数字段 }。
 */
export function deriveOwnerAttention(snapshot, { now } = {}) {
  requireNow(now);
  const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : [];
  const consults = Array.isArray(snapshot?.consults) ? snapshot.consults : [];
  const runsById = new Map(runs.map((run) => [run.runId, run]));
  // 快照是否"读得全"：没有读不出的运行、没有谱系声明冲突的运行——"没有后续"的证据要以此为前提。
  const censusComplete = runs.every((run) => run.availability === "ok" && run.lineageRootConflict !== true);
  const decide = [];
  const anomalies = [];
  const counts = emptyCounts();
  // slug → { slug, …计数字段 }。快照的项目行先各建一份（没有运行的也如实是 0）。
  const projectCounts = new Map();
  for (const project of Array.isArray(snapshot?.projects) ? snapshot.projects : []) {
    if (typeof project?.slug === "string") projectCounts.set(project.slug, { slug: project.slug, ...emptyCounts() });
  }
  /** 某个项目的计数；slug 读不到 → null（只进全局）。 */
  const countsFor = (slug) => {
    if (typeof slug !== "string") return null;
    let entry = projectCounts.get(slug);
    if (entry === undefined) {
      entry = { slug, ...emptyCounts() };
      projectCounts.set(slug, entry);
    }
    return entry;
  };
  // 两处都加一：全局与该项目（有的话）。
  const bump = (project, key) => {
    counts[key] += 1;
    if (project !== null) project[key] += 1;
  };
  const bumpLiveness = (project, value) => {
    counts.liveness[value] += 1;
    if (project !== null) project.liveness[value] += 1;
  };

  /** 额度观测分组：kind + 车道键 → { kind, laneKey, observations: [{ run, atMs }] }。 */
  const capacityGroups = new Map();
  // 额度事项落栏：quota_exhausted 值得拿主意（decide）；限流 / 上游过载是异常（anomalies）。
  const capacityListFor = (kind) => (kind === "quota_exhausted" ? decide : anomalies);
  /** quota_exhausted 在异常栏里的镜像件（不进 resolved，不重复列已了结）。 */
  const mirrors = new Set();

  for (const run of runs) {
    const project = countsFor(slugOf(run));

    // —— 计数 ——
    if (run.terminal === false) bump(project, "running");
    if (run.stage === "starting") bump(project, "starting");
    bumpLiveness(project, OWNER_LIVENESS_VALUES.includes(run.liveness) ? run.liveness : "unknown");

    // —— 交付类事项（前提：分支还在）——
    const delivery = run.delivery;
    if (delivery !== null && delivery.branchPresent === null) bump(project, "deliveryUnobservable");
    if (delivery !== null && delivery.branchPresent === true) {
      const verification = delivery.verification;
      const effective = text(verification?.status);
      const acceptance = delivery.acceptance;
      const acceptanceStatus = text(acceptance?.status);
      const decided = isDecided(acceptance);
      const settledAt = text(delivery.settledAt);
      if (effective === "pending") bump(project, "verifying");

      const reverifyPassed = effective === "passed" && verification.reverify?.status === "complete";
      const verificationResolution = reverifyPassed
        ? { resolution: "reverify_passed", resolvedAt: settledAt, evidence: evidenceOf(run.runId, settledAt, delivery.settledSeq) }
        : decided
          ? decisionOf(run.runId, acceptance)
          : supersessionOf(run, runsById);
      // 解除不了、也确认不了"仍未解除"：裁决状态读不到，或"是否已被取代"没能判定。
      const unresolvedUnknown = acceptanceStatus === null || run.supersessionUndeterminable === true;
      const base = { runIds: [run.runId], projectSlugs: projectSlugsOf(slugOf(run)), commit: text(delivery.commit) };

      if (effective === "failed" || effective === "unavailable" || reverifyPassed) {
        const kind = effective === "unavailable" ? "verification_unavailable" : "verification_failed";
        decide.push(makeItem({
          ...base,
          id: `${kind}:${run.runId}`,
          kind,
          state: unresolvedUnknown ? "unknown" : "open",
          since: settledAt,
          // 复验通过的：原始失败那条事件的时刻快照里没有，证据只留复验结果这一条。
          evidence: reverifyPassed ? [] : [evidenceOf(run.runId, settledAt, delivery.settledSeq)],
        }, verificationResolution));
      }

      const settlement = delivery.settlement;
      // 没有交付记录（commit 与 ambiguous 都读不出）的失败 / 中止运行不算交付事项：
      // 真实存储里隔离时建的分支没回收，收口判定一直 ambiguous，但它们从未交出东西。
      const hasDeliveryRecord = text(delivery.commit) !== null || delivery.ambiguous === true;
      if (hasDeliveryRecord && (settlement?.status === "undeterminable" || settlement?.reason === "terminal_delivery_ambiguous")) {
        decide.push(makeItem({
          ...base,
          id: `delivery_ambiguous:${run.runId}`,
          kind: "delivery_ambiguous",
          state: unresolvedUnknown ? "unknown" : "open",
          since: text(run.terminalAt),
          evidence: [evidenceOf(run.runId, run.terminalAt, run.terminalSeq)],
        }, verificationResolution));
      }

      if (settlement?.status === "settled" && settlement?.reason === "delivery_settled" && (acceptanceStatus === "pending" || decided)) {
        const resolution = decided ? decisionOf(run.runId, acceptance) : supersessionOf(run, runsById);
        // "等了多久"算到解除那一刻：仍待裁决算到现在，已解除的算到 resolvedAt。
        const settledMs = msOf(settledAt);
        const untilMs = resolution === null ? now : msOf(resolution.resolvedAt);
        const waitedMs = settledMs === null || untilMs === null ? null : untilMs - settledMs;
        // 仍待裁决而收口时刻读不到的说不清等了多久，照样列（unknown）；已解除而说不清它
        // 等过多久的，不进"已了结"栏。
        const raised = waitedMs === null ? resolution === null && settledMs === null : waitedMs > OWNER_ATTENTION_DECIDE_AFTER_MS;
        if (raised) {
          decide.push(makeItem({
            ...base,
            id: `awaiting_decision:${run.runId}`,
            kind: "awaiting_decision",
            state: run.supersessionUndeterminable === true || settledMs === null ? "unknown" : "open",
            since: settledAt,
            evidence: [evidenceOf(run.runId, settledAt, delivery.settledSeq)],
          }, resolution));
        }
      }
    }

    // —— failed ——
    // 列入窗口：未了结的按失败时刻在 24 小时内列；已了结的按 resolvedAt 在 24 小时内列，
    // 与失败多老无关（25 小时前失败、1 小时前有后续成功 → 进"已了结"栏）。
    const failedAtMs = msOf(run.terminalAt);
    if (run.state === "failed") {
      const success = failedAtMs === null
        ? null
        : earliestSuccess(runs, (other) => isLaterFollowUp(other, run, failedAtMs), failedAtMs);
      const acceptance = delivery?.acceptance ?? null;
      const resolution = success !== null
        ? success
        : isDecided(acceptance) ? decisionOf(run.runId, acceptance) : null;
      const listed = resolution === null
        ? withinWindow(failedAtMs, now, OWNER_ATTENTION_WINDOW_MS)
        : withinWindow(msOf(resolution.resolvedAt), now, OWNER_ATTENTION_WINDOW_MS);
      if (listed) {
        // 失败原因只给闭集码；快照里没有这一项（读不出的运行）就是 null。
        const extra = {
          failure: run.failure === null || run.failure === undefined ? null : { category: text(run.failure.category), code: text(run.failure.code) },
        };
        if (resolution === null) {
          // followUp 只对未了结的失败有意义：见 followUpsOf（有后续 / 有证据没有后续 / 证据不足）。
          Object.assign(extra, followUpsOf(runs, run, failedAtMs, censusComplete));
        }
        anomalies.push(makeItem({
          id: `failed:${run.runId}`,
          kind: "failed",
          state: "open",
          runIds: [run.runId],
          projectSlugs: projectSlugsOf(slugOf(run)),
          since: text(run.terminalAt),
          evidence: [evidenceOf(run.runId, run.terminalAt, run.terminalSeq)],
        }, resolution, extra));
      }
    }

    // —— silent / process_only（只有现时状态）——
    if (run.terminal === false && (run.liveness === "silent" || run.liveness === "process_only")) {
      const quietMs = msOf(run.quietSince);
      if (quietMs === null || now - quietMs > OWNER_ATTENTION_QUIET_AFTER_MS) {
        anomalies.push({
          id: `${run.liveness}:${run.runId}`,
          kind: run.liveness,
          state: quietMs === null ? "unknown" : "open",
          runIds: [run.runId],
          projectSlugs: projectSlugsOf(slugOf(run)),
          since: text(run.quietSince),
          evidence: [evidenceOf(run.runId, run.quietSince, run.quietSinceSeq)],
        });
      }
    }

    // —— 额度观测：先收集（不限 24 小时——已了结的事项按 resolvedAt 进窗口），循环后
    //    按车道键分组。观测时刻读不到或没有车道键的成不了组。
    const kind = run.capacity === null || run.capacity === undefined ? undefined : CAPACITY_KINDS.get(run.capacity.code);
    const laneKey = ownerLaneKey(run);
    const observedAtMs = msOf(run.capacity?.observedAt);
    if (kind !== undefined && laneKey !== null && observedAtMs !== null) {
      const key = `${kind}\u0000${laneKey}`;
      if (!capacityGroups.has(key)) capacityGroups.set(key, { kind, laneKey, observations: [] });
      capacityGroups.get(key).observations.push({ run, atMs: observedAtMs });
    }
  }

  // —— consult_split：挂在被审运行上 ——
  for (const consult of consults) {
    if (typeof consult.reviewedRunId !== "string" || consult.q1Declared !== true) continue;
    // 判定只看 Q1：给了结论的席位才参与（Q1 为 null 的不参与）。证据只列得出可指的席位运行。
    const verdicts = Array.isArray(consult.seats)
      ? consult.seats.filter((seat) => OWNER_CONSULT_Q1_VALUES.includes(seat?.q1))
      : [];
    const split = new Set(verdicts.map((seat) => seat.q1)).size >= 2 || verdicts.some((seat) => seat.q1 === "FIX_FIRST");
    const reviewed = runsById.get(consult.reviewedRunId);
    if (!split || reviewed === undefined || reviewed.delivery?.branchPresent !== true) continue;
    const acceptance = reviewed.delivery.acceptance;
    const resolution = isDecided(acceptance) ? decisionOf(reviewed.runId, acceptance) : supersessionOf(reviewed, runsById);
    decide.push(makeItem({
      id: `consult_split:${text(consult.projectSlug) ?? ""}:${text(consult.consultId) ?? ""}`,
      kind: "consult_split",
      state: text(acceptance?.status) === null || reviewed.supersessionUndeterminable === true ? "unknown" : "open",
      runIds: [reviewed.runId],
      projectSlugs: projectSlugsOf(text(consult.projectSlug), slugOf(reviewed)),
      since: text(consult.createdAt),
      evidence: verdicts
        .filter((seat) => typeof seat.runId === "string")
        .map((seat) => evidenceOf(seat.runId, runsById.get(seat.runId)?.terminalAt, runsById.get(seat.runId)?.terminalSeq)),
      commit: text(reviewed.delivery.commit),
    }, resolution, {
      // 牵涉的 worker = 被审运行（runIds）+ 会审的全部席位运行（不论给没给结论；证据只列给了结论的）。
      seatRunIds: [...new Set((Array.isArray(consult.seats) ? consult.seats : []).map((seat) => seat?.runId).filter((id) => typeof id === "string"))],
    }));
  }

  // —— 额度事项：每组取最后一次观测；窗口按解除与否分别看 ——
  for (const { kind, laneKey, observations } of capacityGroups.values()) {
    let latest = observations[0];
    for (const observation of observations) if (observation.atMs >= latest.atMs) latest = observation;
    const resolution = earliestSuccess(runs, (other) => ownerLaneKey(other) === laneKey, latest.atMs);
    // 未了结：按最后一次证据的 24 小时窗口；已了结：按 resolvedAt 的窗口，与证据多老无关。
    const listed = resolution === null
      ? withinWindow(latest.atMs, now, OWNER_ATTENTION_WINDOW_MS)
      : withinWindow(msOf(resolution.resolvedAt), now, OWNER_ATTENTION_WINDOW_MS);
    if (!listed) continue;
    const item = makeItem({
      id: `${kind === "quota_exhausted" ? "capacity" : "rate_limited"}:${laneKey}`,
      kind,
      state: resolution === null && now - latest.atMs > OWNER_ATTENTION_CAPACITY_FRESH_MS ? "unknown" : "open",
      runIds: observations.map((observation) => observation.run.runId),
      projectSlugs: projectSlugsOf(...observations.map((observation) => slugOf(observation.run))),
      since: text(latest.run.capacity.observedAt),
      // 证据只留最近的若干次观测（按观测时刻升序）；已了结时解除证据由 makeItem 追加在末尾。
      evidence: observations
        .slice()
        .sort(byEvidenceAt)
        .slice(-OWNER_ATTENTION_CAPACITY_EVIDENCE_MAX)
        .map((observation) => evidenceOf(observation.run.runId, observation.run.capacity.observedAt, observation.run.capacity.observedSeq)),
    }, resolution, { laneKey, capacityCode: text(latest.run.capacity.code) });
    capacityListFor(kind).push(item);
    if (kind === "quota_exhausted") {
      // Owner 已定：额度用尽也计入 Alerts。同一件事在异常栏再列一件镜像（自己的 id，内容相同），
      // 这样顶部计数、两栏列表与项目标记的数口径一致；已了结的只在 resolved 里出现一次（见下）。
      const mirror = {
        ...item,
        id: `capacity_alert:${laneKey}`,
        runIds: [...item.runIds],
        projectSlugs: [...item.projectSlugs],
        evidence: item.evidence.map((entry) => ({ ...entry })),
      };
      mirrors.add(mirror);
      anomalies.push(mirror);
    }
  }

  decide.sort(bySince);
  anomalies.sort(bySince);

  // —— 已了结：resolvedAt 在 24 小时内的，按 resolvedAt 倒序；resolvedAt 为 null 的不进 ——
  const resolved = [...decide, ...anomalies]
    .filter((item) => item.state === "resolved" && !mirrors.has(item) && withinWindow(msOf(item.resolvedAt), now, OWNER_ATTENTION_WINDOW_MS))
    .sort((a, b) => {
      const left = msOf(a.resolvedAt);
      const right = msOf(b.resolvedAt);
      if (left !== right) return right - left;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  // 前两栏只留未了结的：已了结的只出现在 resolved（窗口外的哪一栏都不在）。
  const pendingDecide = decide.filter((item) => item.state !== "resolved");
  const pendingAnomalies = anomalies.filter((item) => item.state !== "resolved");

  // —— decide / anomalies 的 open 数与 unknown 数：直接数上面两张表 ——
  // 每个项目一行：事项归属的每个项目都计（跨项目额度 / 会审事项在两边都算，与
  // /api/attention?project=X 能查到它一致）。
  for (const [items, key] of [[pendingDecide, "decide"], [pendingAnomalies, "anomalies"]]) {
    for (const item of items) {
      counts[key][item.state] += 1;
      for (const slug of item.projectSlugs) {
        const project = countsFor(slug);
        if (project !== null) project[key][item.state] += 1;
      }
    }
  }

  counts.projects = [...projectCounts.values()].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return { decide: pendingDecide, anomalies: pendingAnomalies, resolved, counts };
}

// ===== Workers 默认范围与车道汇总 =====

/**
 * 席位运行 → 它所在会审组的摘要，外加本席自己已给出的结论 q1（闭集；没答复或结论不在闭集内为 null）。
 * 一个运行同时出现在多个组里时取 createdAt 最早的那个组（快照里的 consults 已按 createdAt 升序）。
 * 没有座位或没有 consultId 的组记录不成摘要。
 */
function consultBySeatRun(snapshot) {
  const out = new Map();
  for (const consult of Array.isArray(snapshot?.consults) ? snapshot.consults : []) {
    const seats = Array.isArray(consult?.seats) ? consult.seats : [];
    const consultId = text(consult?.consultId);
    if (seats.length === 0 || consultId === null) continue;
    const summary = {
      groupId: `${text(consult.projectSlug) ?? ""}:${consultId}`,
      seatsIn: consultSeatsArrived(seats),
      seatsTotal: seats.length,
    };
    for (const seat of seats) {
      // q1: this seat's own verdict (closed set), only for a seat that has answered; null otherwise.
      if (typeof seat?.runId === "string" && !out.has(seat.runId)) {
        out.set(seat.runId, { ...summary, q1: seat.replied === true && OWNER_CONSULT_Q1_VALUES.includes(seat.q1) ? seat.q1 : null });
      }
    }
  }
  return out;
}

/**
 * Workers 页默认范围内的运行，按 startedAt 倒序（读不到的排最后，同一时刻按 runId）。
 * 纯函数；行里带快照行本身（run）与三个派生值，字段白名单由接口的 DTO 负责。
 *
 * @param {object} snapshot
 * @param {object} attention — 同一份快照、同一个 now 的 deriveOwnerAttention 结果
 * @param {{now: number, project?: string|null}} options — now 与那份 attention 同一个；
 *   project 给了就只留该项目的运行
 * @returns {Array<{run: object, laneKey: string|null, title: string|null, subtitle: string|null,
 *   attentionIds: string[], consult: {groupId: string, seatsIn: number, seatsTotal: number, q1: string|null}|null}>}
 *   attentionIds 是该运行挂着的未了结事项的 id（先 decide 后 anomalies，各按列表顺序；给了
 *   project 时只列 projectSlugs 含该项目的事项，与 /api/attention?project=X 一致）；
 *   consult 是这个运行（当会审席位时）所在会审组的摘要：groupId 是 <项目 slug>:<consultId>，
 *   seatsIn 是几席已到（consultSeatsArrived 口径：已到终态且收到答复），seatsTotal 是总席数；
 *   不是会审席位、或没有会审组记录就是 null
 */
export function selectOwnerWorkers(snapshot, attention, { now, project = null } = {}) {
  requireNow(now);
  const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : [];
  const runsById = new Map(runs.map((run) => [run.runId, run]));
  const attached = new Map(); // runId → 事项 id
  const flagged = new Set(); // 挂着 open / unknown 交付或会审事项的运行
  for (const item of [...attention.decide, ...attention.anomalies]) {
    if (item.state === "resolved") continue;
    // 给了项目就与 /api/attention?project=X 同一筛选：只列这个项目能查到的事项。
    if (project !== null && !item.projectSlugs.includes(project)) continue;
    for (const runId of item.runIds) {
      const list = attached.get(runId);
      if (list === undefined) attached.set(runId, [item.id]);
      else list.push(item.id);
      if (DELIVERY_CONSULT_KINDS.has(item.kind)) flagged.add(runId);
    }
  }
  const consultOf = consultBySeatRun(snapshot);
  const rows = [];
  for (const run of runs) {
    if (project !== null && slugOf(run) !== project) continue;
    if (run.terminal !== false && !flagged.has(run.runId) && !withinWindow(msOf(run.terminalAt), now, OWNER_ATTENTION_WINDOW_MS)) continue;
    rows.push({
      run,
      laneKey: ownerLaneKey(run),
      ...ownerRunTitles(run, runsById),
      attentionIds: [...(attached.get(run.runId) ?? [])],
      consult: consultOf.get(run.runId) ?? null,
    });
  }
  rows.sort((a, b) => {
    const left = msOf(a.run.startedAt);
    const right = msOf(b.run.startedAt);
    if (left !== right) return left === null ? 1 : right === null ? -1 : right - left;
    return a.run.runId < b.run.runId ? -1 : a.run.runId > b.run.runId ? 1 : 0;
  });
  return rows;
}

/**
 * 两件未了结额度事项里 a 更适合当车道的摘要：since 更晚；读不到时刻的让给读得到的；
 * 同一时刻（或都读不到）id 小的在前——所以 quota_exhausted 排在 rate_limited 之前。
 */
function laterSummary(a, b) {
  const left = msOf(a.since);
  const right = msOf(b.since);
  if (left === right) return a.id < b.id;
  return left === null ? false : right === null ? true : left > right;
}

/**
 * 车道汇总：有运行在跑、或有未了结额度事项的车道各一行，按车道键码元序。
 *
 * @param {object} snapshot
 * @param {object} attention — 同一份快照、同一个 now 的 deriveOwnerAttention 结果
 * @returns {Array<{laneKey: string, running: number,
 *   capacity: {kind: string, state: string, observedAt: string|null}|null}>}
 *   running 是非终态运行的个数；capacity 是该车道未了结额度事项里 since 最晚的那一件
 *   （见 laterSummary），没有就是 null。
 */
export function ownerLanes(snapshot, attention) {
  const capacityOf = new Map(); // laneKey → 该车道未了结额度事项里当摘要的那一件
  // 额度事项分属两栏（quota_exhausted → decide，rate_limited → anomalies）：两栏都读。
  for (const item of [...attention.decide, ...attention.anomalies]) {
    if (item.state === "resolved" || !CAPACITY_ITEM_KINDS.has(item.kind)) continue;
    const current = capacityOf.get(item.laneKey);
    if (current === undefined || laterSummary(item, current)) capacityOf.set(item.laneKey, item);
  }
  const lanes = new Map();
  const lane = (laneKey) => {
    let entry = lanes.get(laneKey);
    if (entry === undefined) {
      entry = { laneKey, running: 0, capacity: null };
      lanes.set(laneKey, entry);
    }
    return entry;
  };
  for (const run of Array.isArray(snapshot?.runs) ? snapshot.runs : []) {
    const laneKey = ownerLaneKey(run);
    if (run.terminal === false && laneKey !== null) lane(laneKey).running += 1;
  }
  for (const [laneKey, item] of capacityOf) {
    lane(laneKey).capacity = { kind: item.kind, state: item.state, observedAt: item.since };
  }
  return [...lanes.values()].sort((a, b) => (a.laneKey < b.laneKey ? -1 : a.laneKey > b.laneKey ? 1 : 0));
}
