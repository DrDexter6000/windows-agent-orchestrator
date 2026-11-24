// src/application/ownerReadModel.js
//
// 决定 0131 §5–§7（第 140a、140b 批）：Owner 看板的共享读模型——每个运行目录一个、
// 跨全部项目、只在内存。140a 做读模型与派发端的类型固化，140b 补交付、失败、额度、
// 谱系、分支、会审结论几组事实。HTTP 接口、前端、MCP schema 与事项推导都不在这里。
//
// 模型：
//   - 冷普查：第一次 refresh() 用 listTranscriptsDeep（严格模式）枚举全部桶（项目桶、
//     旧平铺、特殊桶），逐个读、提取"事实"。
//   - 增量：之后的 refresh() 只重读文件身份（大小、mtime、ctime、ino）有变化的文件，
//     识别新增、删除与移桶。身份取 bigint stat：同长度改写后再把 mtime 恢复成原值，
//     也会被 ctime 认出来。
//   - 内容按原始字节比对（哈希）——多副本算不算"同一份"只看字节；解码只为了解析。
//   - 未写完的尾行：只解析到最后一个换行为止。活跃运行追加到一半被读到时，末尾那截
//     没有换行的半行不是损坏，忽略它；写完后文件身份变化，下一轮自然重读。
//   - 缓存里只有事实，没有依赖时间的结论；活性与阶段时效在 snapshot({ now }) 里用
//     同一个 now 现算。
//
// 归属：授权从"按工作区匹配运行 cwd"改为"运行属于这个运行目录 + 运行自己的项目
// 事实"。resolveRun 是以后列表、详情、事件流共用的授权入口——只认本运行目录的枚举
// 结果，不做 cwd 匹配。
//
// 边界：
//   - 快照对象里不出现任何仓库路径、工作树路径、cwd 或转录路径；项目只给 slug 与
//     名字。标题与项目名先脱敏、再清控制字符、最后限长。
//   - 同一 runId 出现在两处：字节相同去重；字节不同标 conflict、不选其一；有一份读
//     不出就整份按读不到处理（不比内容不择一）。读不到一律如实 unknown。
//   - 枚举用严格模式：任何一个桶读不出，refresh() 拒绝，已有索引原样保留——不拿
//     看不全的结果下结论。
//   - 刷新中途失败不改动已有索引；并发的 refresh 共用同一次普查。
//   - 只读：零转录追加、零状态变更、零语义判断。事实的口径全部取自既有 SSOT
//     （findStateEvidence / projectExecutionStage / runQuietAdvisory /
//     ownerLiveness / deliveryWasRequested / boundReportScope），不另写第二份判定。
//
// 第 140b 批补的事实（给下一批的事项推导与接口用；同样只用既有判定）：
//   - 交付：收口判定 determineRunSettlement；ambiguous / 打包失败 / 隔离失败三个
//     结局取自交付视图 gatherDeliveryView；提交号与裁决事件取自交付事实校验
//     validateDeliveryFacts。settledAt = 终态事件与该轮有效验证（或复验）结果事件
//     两者中较晚的时间。
//   - 失败与额度：diagnoseFailureWithBasis（src/diagnosis.js）——闭集 category 与
//     code，以及额度结论所依据的那条 run.error 的时间。
//   - 谱系：声明根与合法裁决是 lineageSupersession.js 的纯判定；"被取代"复用
//     createLineageSupersession，把本模型的文件索引经 files / memberFilesForRoot
//     注入——不另起全量枚举，也不做字节预筛。
//   - 分支：runBranches.js 的枚举，与 lead_preflight 待办事项是同一份答案。
//   - 会审：组记录经 loadConsultRecord 校验；Q1 的取文与 observeSeatRun 同一个
//     extractFinalAssistantText，归组与取值用 attributeReply / compareFields。
//
// 已知局限：
//   - 会审组记录只看现行位置 <项目 key>/.wao/runs/consults/<consultId>.json。项目的
//     状态目录被重定向过的（链接工作树自己的 .wao、改过 stateDir 的项目），记录在
//     别处，这里找不到。
//   - 谱系成员与席位转录的事件不留在内存里（只缓存事实）。谱系成员、组记录或席位
//     转录的文件身份变了，才重读相关文件。
//
// 架构契约：不 import src/commands/*、src/mcp/*、MCP SDK 或 zod。

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile as fsReadFile, readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import { join } from "node:path";

import {
  listProjectRecords,
  listTranscriptsDeep,
  loadBucketIndex,
  SAFE_BUCKET_SLUG_RE,
} from "../projectBuckets.js";
import {
  DELIVERY_VERIFICATION_OUTCOME_TYPES,
  findFirstBound,
  findLatestBound,
  findStateEvidence,
  inheritableOwnerTaskType,
  isPersistableOwnerTaskType,
  OWNER_TASK_TYPES,
  parseTranscriptText,
  REVERIFY_REASONS,
  RUN_STATES,
  TERMINAL_STATES,
  validateDeliveryFacts,
} from "../transcript.js";
import { isCanonicalCommitId, isValidRunId } from "../delivery.js";
import {
  DIAGNOSIS_CATEGORIES,
  diagnoseFailureWithBasis,
  ISOLATION_VIOLATION_REASONS,
  isValidDiagnosisCode,
  PROVIDER_CAPACITY_DIAGNOSIS_CODES,
} from "../diagnosis.js";
import { PACKAGING_FAILURE_CODES } from "../deliveryFailureCodes.js";
import { boundReportScope } from "../metrics.js";
import { redactSecretShapes } from "../secretRedaction.js";
import { ID_RE, isValidCanonicalAgentId } from "../canonicalAgentId.js";
import { RUNTIME_ACTIVITY_STATUSES } from "../runEvent.js";
import {
  attributeReply,
  compareFields,
  extractFinalAssistantText,
  isValidConsultId,
  loadConsultRecord,
} from "./consultService.js";
import {
  createLineageSupersession,
  declaredLineageRoot,
  legalDeliveryDecision,
  supersessionCandidateGate,
} from "./lineageSupersession.js";
import {
  DELIVERY_ACCEPTANCE_STATUSES,
  DELIVERY_VERIFICATION_STATUSES,
  gatherDeliveryView,
} from "./runDelivery.js";
import { projectExecutionStage } from "./runStageProjection.js";
import { lastActualEffectAtMs, lastEffectAtMs, lastVitalSignAtMs } from "./runQuietAdvisory.js";
import { readOwnerLease } from "./ownerLiveness.js";
import { execGitReadOnly, listRunBranchRunIds } from "./runBranches.js";
import {
  deliveryWasRequested,
  determineRunSettlement,
  RUN_SETTLEMENT_REASONS,
  RUN_SETTLEMENT_STATUSES,
  SAFE_ISOLATION_VIOLATION_CODES,
} from "./runSettlement.js";

// 闭集 SSOT 在 src/transcript.js（写入侧 runManager 也要引用它）；这里转出，读模型的
// 消费方不必再绕去转录模块。
export { OWNER_TASK_TYPES };

/** 实质动作的时效窗：lastEffectAt 在这么多秒内算 progress。 */
export const OWNER_PROGRESS_WINDOW_SECONDS = 300;
/** 进程体征的时效窗：runtime_activity 或心跳租约在这么多秒内算 process_only。 */
export const OWNER_PROCESS_WINDOW_SECONDS = 120;
/** 标题与项目名的字符帽（超长时帽含省略号）。 */
export const OWNER_TITLE_MAX_CHARS = 80;
/** 每个项目的分支集合至多多久重新观测一次（ms）。 */
export const OWNER_BRANCH_REFRESH_MS = 30_000;
/** 会审结论 Q1 的闭集（决定 0128 的审查写法）。记录声明了别的候选值的 Q1 不是结论题。 */
export const OWNER_CONSULT_Q1_VALUES = Object.freeze(["PASS", "PASS_WITH_NOTES", "FIX_FIRST"]);

export const OWNER_LIVENESS_VALUES = Object.freeze(["terminal", "progress", "process_only", "silent", "unknown"]);
export const OWNER_STAGE_VALUES = Object.freeze(["starting", "active", "terminal", "stage_unknown"]);
export const OWNER_TITLE_BASES = Object.freeze(["heading", "first_line", "none"]);
export const OWNER_TASK_TYPE_BASES = Object.freeze(["persisted", "tag", "role", "none"]);

// 绑定角色 → 任务类型（其余角色，含 auditor，推不出类型）。
const ROLE_TASK_TYPES = new Map([
  ["researcher", "research"],
  ["coder", "code"],
  ["tester", "test"],
]);

// ===== 标题 =====

// C0/C1 与 DEL 里的控制字符（与 runActivityProjection 的清洗同一字符类）。换行与
// 制表符在此之前已折成空格，所以这里不必再放过 TAB / LF。
// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;
// 连续的空白段（含空格、制表符、换行）：其中只要有一个换行或制表符，整段折成一个空格。
const WHITESPACE_RUN_RE = /\s+/g;
// 行界：\r\n、单独的 \r、单独的 \n 都算。
const LINE_BREAK_RE = /\r\n|\r|\n/;
// ATX 标题：至多三个前导空格、1–6 个 #、其后是空白或行尾。
const HEADING_RE = /^ {0,3}#{1,6}(?:\s+(.*?))?\s*$/;
// 标题末尾可选的闭合 # 序列（前面是空白或行首）。
const CLOSING_HASHES_RE = /(?:^|\s)#+$/;
// 代码围栏行（CommonMark）：三个以上的反引号或波浪号起头。反引号围栏的信息串里
// 不能再有反引号——像 "```git status``` is the first step" 这样的一行是正文（行内
// 代码），不是围栏；波浪号围栏的信息串没有这个限制。
const FENCE_RE = /^(?:`{3,}[^`]*|~{3,}.*)$/;
// 分隔线：去掉全部空白之后，恰好是三个以上的同一个字符（- * _）。
const THEMATIC_BREAK_RE = /^([-*_])\1{2,}$/;

function sanitizeControls(text) {
  return text.replace(UNSAFE_CONTROL_RE, "\uFFFD");
}

/** 限长（UTF-16 码元；超长截到 maxChars-1 后补 …，帽含省略号；不切开代理对）。 */
function truncateHead(text, maxChars) {
  if (text.length <= maxChars) return text;
  let keep = maxChars - 1; // 留一格给 …
  const last = text.charCodeAt(keep - 1);
  if (last >= 0xd800 && last <= 0xdbff) keep -= 1;
  return `${text.slice(0, keep)}…`;
}

/**
 * 给人看的动态文本走同一条安全链（决定 0131 §3）：脱敏 → 含换行或制表符的空白段
 * 整体折成一个空格 → 清控制字符 → 限长。标题与项目名共用。顺序不能反：先截断会把
 * 跨在截断点上的秘密形状切掉半截，剩下的半段匹配不到整段规则，脱敏失效。
 * 加工后为空 → null。
 */
function safeDisplayText(text) {
  if (typeof text !== "string") return null;
  const folded = redactSecretShapes(text).replace(WHITESPACE_RUN_RE, (run) => (/[\r\n\t]/.test(run) ? " " : run));
  const safe = truncateHead(sanitizeControls(folded).trim(), OWNER_TITLE_MAX_CHARS);
  return safe.length > 0 ? safe : null;
}

/** 取标题并加工（规则见 deriveOwnerTitleFacts）。 */
function finishTitle(text, titleBasis) {
  return { title: safeDisplayText(text), titleBasis };
}

/**
 * 不是正文的结构行：代码围栏（``` / ~~~）与分隔线（--- / *** / ___）。缩进四格起
 * 是代码块里的内容，不算。
 */
function isStructuralLine(line) {
  if (/^ {4}/.test(line)) return false;
  const body = line.trim();
  if (FENCE_RE.test(body)) return true;
  return THEMATIC_BREAK_RE.test(body.replace(/\s+/g, ""));
}

/**
 * 标题与它的出处。来源是该运行最后一条绑定的 `prompt.sent` 的任务正文。
 *   - 按 \r\n、\r、\n 三种切行，取第一个非空行；跳过代码围栏行（按 CommonMark：
 *     反引号围栏的信息串里不能再有反引号）与分隔线（--- / *** / ___）；
 *   - 这一行是 ATX 标题 → 去掉 # 记号，titleBasis = "heading"；否则原样，
 *     titleBasis = "first_line"；
 *   - 都没有（含不是字符串）→ title = null、titleBasis = "none"，页面显示 run 号。
 *
 * 为什么是"第一个非空行"而不是"全文第一个标题"：任务书正文里常有"Q1""背景"这类
 * 小节名，全文找标题会取到正文中段；第一个非空行才是任务的开头。会审席的 prompt
 * 是"任务书 + 视角片段 + 分隔线 + 固定合同"，第一个非空行总在任务书里。
 * 纯函数，零 I/O。
 *
 * @param {unknown} promptText
 * @returns {{title: string|null, titleBasis: string}}
 */
export function deriveOwnerTitleFacts(promptText) {
  if (typeof promptText !== "string" || promptText.length === 0) return { title: null, titleBasis: "none" };
  for (const line of promptText.split(LINE_BREAK_RE)) {
    if (line.trim().length === 0 || isStructuralLine(line)) continue;
    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      const text = (heading[1] ?? "").replace(CLOSING_HASHES_RE, "").trim();
      if (text.length === 0) continue; // 只有 # 记号的空标题不出标题，继续往下取
      return finishTitle(text, "heading");
    }
    return finishTitle(line, "first_line");
  }
  return { title: null, titleBasis: "none" };
}

/**
 * 标题：任务正文的第一个非空行（是 ATX 标题则去掉 # 记号），经安全链加工。
 * 没有可取的行 → null。纯函数；规则见 deriveOwnerTitleFacts。
 * @param {unknown} promptText
 * @returns {string|null}
 */
export function deriveOwnerTitle(promptText) {
  return deriveOwnerTitleFacts(promptText).title;
}

// ===== 任务类型 =====

/** 车道 / 角色 id 必须符合身份字母表（ID_RE），不符合如实为 null。 */
const safeId = (value) => (typeof value === "string" && ID_RE.test(value) ? value : null);

/** rolePin 记的是角色库路径（config/roles/<roleId>.md）：从文件名取回 roleId。 */
function roleIdFromPin(rolePin) {
  const source = typeof rolePin?.systemPrompt === "string" ? rolePin.systemPrompt : "";
  const base = source.replace(/\\/g, "/").split("/").pop() ?? "";
  const roleId = base.endsWith(".md") ? base.slice(0, -".md".length) : base;
  return roleId.length > 0 ? roleId : null;
}

function ownerRoleId(started) {
  const recorded = started?.roleId;
  // 只有 null / 缺席才回退 rolePin——写侧用 null 表示"未指定角色"。空字符串与其余
  // 不合字母表的值都是在场的坏值：如实为 null，不拿 pin 顶替。
  if (recorded === undefined || recorded === null) return safeId(roleIdFromPin(started?.rolePin));
  return safeId(recorded);
}

/**
 * 任务类型的读侧判定（纯函数）。权威顺序：
 *   1. run.started 里固化的 taskType（闭集成员，且不是读侧结论 "untyped"）；
 *   2. run.started.tags.type === "image"（CLI `run --tag type=image`）；
 *   3. 绑定角色推导：researcher → research、coder → code、tester → test。roleId 缺失
 *      时回退 rolePin；不按当前注册表重推。
 * 前两步与续修 / retry 的继承判定同源（inheritableOwnerTaskType）。其余（含 auditor、
 * 非法的标签值或固化值）为 untyped。非法的固化值与缺失同义，继续往下判。
 *
 * @param {object|null|undefined} started — 本 run 绑定的 run.started 事件
 * @returns {{taskType: string, typeBasis: string}}
 */
export function deriveOwnerTaskType(started) {
  const recorded = inheritableOwnerTaskType(started);
  if (recorded !== null) {
    return { taskType: recorded, typeBasis: isPersistableOwnerTaskType(started.taskType) ? "persisted" : "tag" };
  }
  const byRole = ROLE_TASK_TYPES.get(ownerRoleId(started));
  return byRole === undefined
    ? { taskType: "untyped", typeBasis: "none" }
    : { taskType: byRole, typeBasis: "role" };
}

// ===== 事实提取 =====

/** Date 能表示的最大 epoch ms（±8.64e15）；超出就不是时刻。 */
const MAX_TIME_MS = 8.64e15;

/** 可表示的时刻：有限的 epoch ms 且在 Date 范围内；其余一律 null。 */
function timeMs(value) {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_TIME_MS ? value : null;
}

/** ISO 时间串 → epoch ms；不是字符串或读不出 → null（null/undefined 绝不落成 1970）。 */
function tsMs(ts) {
  if (typeof ts !== "string") return null;
  return timeMs(new Date(ts).getTime());
}

/** 时刻 → ISO 串。对任何输入都不抛：表示不了就是 null。 */
const iso = (ms) => {
  const value = timeMs(ms);
  return value === null ? null : new Date(value).toISOString();
};

/** 首事件项目事实给出的桶 slug；没有事实或形状不可用 → null。 */
function factSlugOf(fact) {
  if (fact === null || typeof fact !== "object") return null;
  if (fact.kind === "project") {
    return typeof fact.bucket === "string" && SAFE_BUCKET_SLUG_RE.test(fact.bucket) ? fact.bucket : null;
  }
  if (fact.kind === "sandbox") return "_sandbox";
  if (fact.kind === "scratch") return "_scratch";
  if (fact.kind === "unattributed") return "_unattributed";
  return null;
}

// ===== 交付、失败、额度、谱系：从事件算出的事实（纯函数） =====

/** 闭集成员才放行：是字符串且在集合里 → 原值，否则 null。 */
function memberOf(set, value) {
  return typeof value === "string" && set.includes(value) ? value : null;
}

/** 交付提交号：规范的 40/64 位十六进制才是，其余 null。 */
const canonicalCommit = (value) => (typeof value === "string" && isCanonicalCommitId(value) ? value : null);

/**
 * 事实派生的兜底：某个判定函数对一份转录抛错时如实给 fallback。读得到与否只取决于
 * 读与解析，不能因为下游判定抛错就把整份转录判成读不到。
 */
function safeFact(compute, fallback) {
  try {
    return compute();
  } catch {
    return fallback;
  }
}

const NO_DELIVERY_OUTCOME = Object.freeze({
  commit: null,
  verification: null,
  acceptance: null,
  decidedAtMs: null,
  settledAtMs: null,
  ambiguous: false,
  packagingFailure: null,
  isolationFailure: null,
});

/**
 * 交付事实（只在该运行请求了交付时给）。口径全部是既有判定：
 *   - settlement：determineRunSettlement 的 { status, reason }；
 *   - ambiguous / packagingFailure / isolationFailure：交付视图（gatherDeliveryView）的
 *     三个非交付结局，各给闭集码；
 *   - commit：validateDeliveryFacts 认可的交付提交；交付事实自相矛盾（malformed）时
 *     "是哪个提交"没有唯一答案，不给；
 *   - verification：有效验证状态（复验通过就覆盖原始结果）与复验链的状态。malformed
 *     链的 reason 是事件里的原值、没过形状校验，不进来；
 *   - acceptance：裁决状态；decidedAtMs 是裁决事件自己的时间；
 *   - settledAtMs：已收口的交付里，终态事件与该轮有效验证（或复验）结果事件两者中
 *     较晚的时间（"等裁决"从这一刻算起）；任一取不到就是 null。
 * 不取任何路径：deliveryRef 的 worktreePath、错误原文都不进来。
 *
 * @param {object[]} events
 * @param {string} runId
 * @param {string} state
 * @param {object|null} terminalEvent — 状态依据的那条终态事件
 */
function deliveryFacts(events, runId, state, terminalEvent) {
  return safeFact(() => {
    const settlement = determineRunSettlement(events, runId);
    const view = gatherDeliveryView(events, runId, state);
    const facts = validateDeliveryFacts(events, { expectedRunId: runId, allowVerificationPending: true });
    const out = {
      settlement: {
        status: memberOf(RUN_SETTLEMENT_STATUSES, settlement.status),
        reason: memberOf(RUN_SETTLEMENT_REASONS, settlement.reason),
      },
      ...NO_DELIVERY_OUTCOME,
      ambiguous: view.ambiguous === true,
      packagingFailure: memberOf(PACKAGING_FAILURE_CODES, view.deliveryFailure?.code),
      isolationFailure: view.isolationFailure
        ? {
          code: memberOf(SAFE_ISOLATION_VIOLATION_CODES, view.isolationFailure.code),
          reason: memberOf(ISOLATION_VIOLATION_REASONS, view.isolationFailure.reason),
        }
        : null,
    };
    if (facts.code !== "delivery_malformed") out.commit = canonicalCommit(facts.createdRef?.deliveryCommit);
    if (view.deliveryAvailable !== true) return out;
    out.verification = {
      status: memberOf(DELIVERY_VERIFICATION_STATUSES, view.effectiveVerification?.status),
      reverify: {
        // 复验链的状态由投影器从代码字面量给出（none / pending / complete / malformed）。
        status: view.reverify?.status ?? null,
        reason: view.reverify?.status === "malformed" ? null : memberOf(REVERIFY_REASONS, view.reverify?.reason),
      },
    };
    out.acceptance = { status: memberOf(DELIVERY_ACCEPTANCE_STATUSES, view.acceptance?.status) };
    out.decidedAtMs = facts.decisionEvent ? tsMs(facts.decisionEvent.ts) : null;
    if (settlement.status === "settled" && settlement.reason === "delivery_settled") {
      // 有效验证来自复验链时，结果事件是复验的结果事件；否则是原始验证结果事件。
      const outcome = facts.reverifyStatus === "complete"
        ? facts.reverifyOutcomeEvent
        : events.find((e) => e.runId === runId && DELIVERY_VERIFICATION_OUTCOME_TYPES.has(e.type)) ?? null;
      const times = [tsMs(terminalEvent?.ts), tsMs(outcome?.ts)];
      if (times.every((t) => t !== null)) out.settledAtMs = Math.max(...times);
    }
    return out;
  }, { settlement: { status: null, reason: null }, ...NO_DELIVERY_OUTCOME });
}

/**
 * 失败与额度事实：只在状态为 failed 时给，其余一律 null（不是失败就没有这两项）。
 *   - failure：diagnoseFailureWithBasis 的 category（闭集）与 code（成对校验通过才给）；
 *     证据文本一律不给；
 *   - capacity：category 是 provider_capacity 且 code 属于额度码时给 { code, observedAtMs }；
 *     observedAtMs 是判定所依据的那条 run.error 自己的时间，取不到为 null。
 */
function failureFacts(events, runId, state) {
  if (state !== "failed") return { failure: null, capacity: null };
  return safeFact(() => {
    const diagnosis = diagnoseFailureWithBasis(events, runId);
    const category = memberOf(DIAGNOSIS_CATEGORIES, diagnosis.category);
    const code = isValidDiagnosisCode(diagnosis.category, diagnosis.code) ? diagnosis.code : null;
    const capacityCode = category === "provider_capacity" ? memberOf(PROVIDER_CAPACITY_DIAGNOSIS_CODES, code) : null;
    return {
      failure: { category, code },
      capacity: capacityCode === null
        ? null
        : { code: capacityCode, observedAtMs: tsMs(diagnosis.basisEvent?.ts) },
    };
  }, { failure: { category: null, code: null }, capacity: null });
}

const LINEAGE_ROOT_EVENT_TYPES = new Set(["run.session_reuse", "run.background_submitted"]);

/**
 * 这份转录可能属于哪几条谱系（rootRunId，码元序）：自身，加上绑定本 runId 的
 * run.session_reuse / run.background_submitted 声明的 rootRunId。它只是喂给
 * createLineageSupersession 的候选集（与回收计划的 byRoot 同一口径）；谁算成员由
 * lineageClose 的 enumerateLineageMembers 判，这里不判。
 */
function lineageRootsOf(events, runId) {
  const roots = new Set([runId]);
  for (const e of events) {
    if (e.runId !== runId || !LINEAGE_ROOT_EVENT_TYPES.has(e.type)) continue;
    if (isValidRunId(e.rootRunId)) roots.add(e.rootRunId);
  }
  return [...roots].sort();
}

/**
 * 从一份转录的事件里提取这个运行的事实（全部与时间无关；时效结论不在这里）。
 * 绑定口径同 runs list / runQuietAdvisory：boundReportScope 收窄到该 runId 的信封
 * 绑定事件，全无信封的旧转录保持历史读法。
 *
 * @param {object[]} events — 已确认每条都是对象的解析结果
 * @param {string} runId — 文件名给出的权威 runId（已过 isValidRunId）
 */
function extractFacts(events, runId) {
  const scope = boundReportScope(events, runId) ?? events;
  const first = scope[0] ?? null;
  const started = scope.find((e) => e.type === "run.started") ?? null;
  const submitted = findFirstBound(events, "run.background_submitted", runId) ?? null;
  const promptEvent = findLatestBound(events, "prompt.sent", runId);
  const { title, titleBasis } = deriveOwnerTitleFacts(promptEvent?.prompt);

  // state 与 terminalAt 取同一条事件：findStateEvidence 给出状态与它的依据事件。
  const evidence = findStateEvidence(scope);
  const state = RUN_STATES.includes(evidence.state) ? evidence.state : "unknown";
  const terminal = TERMINAL_STATES.includes(state);
  const terminalEvent = terminal ? scope[evidence.index] ?? null : null;

  // 阶段只取不随时间变的 phase 与起点；年龄在发布快照时按同一个 now 现算。
  const stage = projectExecutionStage({ events: scope }, { runId, nowFn: () => 0 });

  let lastProcessActiveAtMs = null;
  for (let i = scope.length - 1; i >= 0; i -= 1) {
    const e = scope[i];
    if (e.type === "run.event" && e.kind === "runtime_activity" && RUNTIME_ACTIVITY_STATUSES.includes(e.status)) {
      lastProcessActiveAtMs = tsMs(e.ts);
      break;
    }
  }

  const agentId = first?.agentId;
  const deliveryRequested = deliveryWasRequested(events, runId);
  const lineage = declaredLineageRoot(events, runId);
  return {
    factSlug: factSlugOf(first?.project),
    agentId: isValidCanonicalAgentId(agentId) ? agentId : null,
    laneId: safeId(started?.laneId),
    roleId: ownerRoleId(started),
    readOnly: scope.some((e) => e.type === "run.read_only_declared"),
    deliveryRequested,
    title,
    titleBasis,
    ...deriveOwnerTaskType(started),
    state,
    terminal,
    startedAtMs: tsMs(started?.ts),
    terminalAtMs: terminalEvent === null ? null : tsMs(terminalEvent.ts),
    stagePhase: stage.phase,
    stageSinceMs: tsMs(stage.sinceTs),
    // lastEffectAt 只认实质动作；quietSince 是静默门限的回退起点（run.submitted 或
    // 首事件）。两者与 runQuietAdvisory 的两个基准同口径。
    lastEffectAtMs: lastActualEffectAtMs(scope),
    quietSinceMs: lastEffectAtMs(scope),
    lastVitalEventAtMs: lastVitalSignAtMs(scope),
    lastProcessActiveAtMs,
    retryOf: isValidRunId(started?.retryOf) && started.retryOf !== runId ? started.retryOf : null,
    // 只认已证实的父边：run.background_submitted 的 parentRunId（续修派发器写的持久事实）。
    parentRunId: isValidRunId(submitted?.parentRunId) && submitted.parentRunId !== runId
      ? submitted.parentRunId
      : null,
    // 第 140b 批：交付、失败、额度、谱系。没请求交付就没有交付事实；没失败就没有失败
    // 与额度事实。声明根互相矛盾（同一转录里出现多个 rootRunId）时根为 null 并标明。
    delivery: deliveryRequested ? deliveryFacts(events, runId, state, terminalEvent) : null,
    ...failureFacts(events, runId, state),
    lineageRoot: lineage.conflict ? null : lineage.rootRunId,
    lineageConflict: lineage.conflict,
    legalDecision: safeFact(() => legalDeliveryDecision(events, runId), null),
    // 只有它会真正走到谱系派生（有谱系引用、已打包、自身未裁决、已收口）时才需要读别的成员。
    supersessionCandidate: safeFact(() => supersessionCandidateGate(events, runId).candidate === true, false),
    lineageRoots: safeFact(() => lineageRootsOf(events, runId), [runId]),
  };
}

const toBytes = (raw) => (Buffer.isBuffer(raw) ? raw : Buffer.from(raw));

/**
 * 一份转录的原始字节 → 事件。只解析到最后一个换行为止（保留那个 LF）：其后没有
 * 换行结尾的尾部片段是还没写完的半行，忽略（写完后文件身份变化，下一轮会重读）。
 * LF 必须保留——CRLF 转录里把最后的 LF 切掉会留下一个孤立的 \r，完整的前缀
 * 反而被判读不到。完整行里有坏 JSON、一个完整行都没有、或出现非对象行 → 抛出，
 * 调用方按读不到处理。
 */
function eventsOf(bytes) {
  const end = bytes.lastIndexOf(0x0a);
  if (end < 0) throw new Error("ownerReadModel: transcript has no complete line");
  const events = parseTranscriptText(bytes.subarray(0, end + 1).toString("utf8"));
  if (events.length === 0 || events.some((e) => e === null || typeof e !== "object" || Array.isArray(e))) {
    throw new Error("ownerReadModel: transcript has no readable events");
  }
  return events;
}

/** 一份转录的原始字节 → 事实（解析口径见 eventsOf）。 */
function factsOf(bytes, runId) {
  return extractFacts(eventsOf(bytes), runId);
}

/** 文件身份（bigint stat 的四个字段，转成字符串比较）。 */
function identityOf(st) {
  return { size: String(st.size), mtimeNs: String(st.mtimeNs), ctimeNs: String(st.ctimeNs), ino: String(st.ino) };
}

function sameIdentity(a, b) {
  return a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.ino === b.ino;
}

// ===== 读模型 =====

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

function isRunTranscriptName(name) {
  return name.startsWith("run_") && name.endsWith(".jsonl") && isValidRunId(name.slice(0, -".jsonl".length));
}

const safeSlug = (bucket) => (typeof bucket === "string" && SAFE_BUCKET_SLUG_RE.test(bucket) ? bucket : null);

/** 定位顺序：桶优先于旧平铺，同类按路径码元序——与解析链的回退顺序同向。 */
function locationOrder(a, b) {
  if ((a.bucket === null) !== (b.bucket === null)) return a.bucket === null ? 1 : -1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

const byRunId = (a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0);

/** 会审按组记录的 createdAt 升序；没有可用时间的排在最后；同一时刻按 consultId 码元序。 */
function byConsultCreatedAt(a, b) {
  const left = tsMs(a.createdAt);
  const right = tsMs(b.createdAt);
  if (left !== right) return left === null ? 1 : right === null ? -1 : left - right;
  return a.consultId < b.consultId ? -1 : a.consultId > b.consultId ? 1 : 0;
}

/** 读不到的位置在索引里的那一条：事实全空；谱系候选根沿用上一次读得出时的值（从没有过就是 null）。 */
function unreadableEntry(entry, previous) {
  return {
    runId: entry.runId, bucket: entry.bucket, identity: null, hash: null, facts: null, roots: previous?.roots ?? null,
  };
}

/** 运行的项目 slug。conflict 时两处可能属于不同项目：不选。读不到时位置事实仍可用。 */
function projectSlugOf(run) {
  if (run.availability === "conflict") return null;
  return run.facts !== null ? run.facts.factSlug ?? safeSlug(run.primaryBucket) : safeSlug(run.primaryBucket);
}

/** 组记录里可以照抄进快照的席位状态（其余记录值不采信）。 */
const SEAT_RUN_STATES = Object.freeze([...RUN_STATES, "dispatch_failed", "missing"]);

/**
 * 运行行的交付事实（快照投影：逐字段取，不整包透传）。branches 是该项目最近一次
 * 观测到的分支集合；没有可用的观测（仓库 unknown、还没观测过、项目定不了）就是
 * undefined，branchPresent 如实给 null。
 */
function projectDelivery(runId, delivery, branches) {
  return {
    settlement: { status: delivery.settlement.status, reason: delivery.settlement.reason },
    commit: delivery.commit,
    verification: delivery.verification === null ? null : {
      status: delivery.verification.status,
      reverify: { status: delivery.verification.reverify.status, reason: delivery.verification.reverify.reason },
    },
    acceptance: { status: delivery.acceptance === null ? null : delivery.acceptance.status, decidedAt: iso(delivery.decidedAtMs) },
    settledAt: iso(delivery.settledAtMs),
    ambiguous: delivery.ambiguous,
    packagingFailure: delivery.packagingFailure,
    isolationFailure: delivery.isolationFailure === null
      ? null
      : { code: delivery.isolationFailure.code, reason: delivery.isolationFailure.reason },
    branchPresent: branches === undefined || branches === null ? null : branches.has(runId),
  };
}

/** "在窗口内"：年龄（未来时间钳成 0）不超过窗口；atMs 为 null（无从观测）→ false。 */
function withinWindow(atMs, now, windowSeconds) {
  return atMs !== null && Math.max(0, now - atMs) <= windowSeconds * 1000;
}

const STAGE_DISPLAY = Object.freeze({
  accepted: "starting",
  spawned: "starting",
  active: "active",
  terminal: "terminal",
  unknown: "stage_unknown",
});

/**
 * 建一个 Owner 读模型。
 *
 * @param {object} input
 * @param {string} input.runDir — 运行目录（runs/）
 * @param {Function} [input.nowFn=Date.now] — 注入时钟
 * @param {number} [input.batchSize=200] — 每批读取的文件数；批与批之间让出事件循环
 * @param {object} [input.io] — 注入缝（测试用）：`readFile(path)` → 原始字节、
 *   `stat(path)` → bigint stat、`listFiles(runDir, { strict })` → 转录清单、
 *   `listDir(dir)` → 文件名数组（会审组记录目录）、`execGit(args, cwd)` → stdout（只读
 *   分支枚举）
 * @returns {{refresh: Function, snapshot: Function, resolveRun: Function}}
 */
export function createOwnerReadModel({ runDir, nowFn = Date.now, batchSize = 200, io = {} } = {}) {
  if (typeof runDir !== "string" || runDir.length === 0) {
    throw new Error("createOwnerReadModel: runDir is required");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("createOwnerReadModel: batchSize must be a positive integer");
  }
  const readFile = io.readFile ?? fsReadFile;
  const statFile = io.stat ?? ((path) => fsStat(path, { bigint: true }));
  const listFiles = io.listFiles ?? listTranscriptsDeep;
  const listDir = io.listDir ?? fsReaddir;
  const execGit = io.execGit ?? execGitReadOnly;

  // path → { runId, bucket, identity: {size, mtimeNs, ctimeNs, ino}|null, hash, facts, roots }
  //（identity 为 null 或 hash / facts 为 null = 那一次读不到，下轮重试。roots = 这份
  // 转录声明的谱系候选根；读不到时沿用上一次读得出时的值，从没读得出过就是 null）
  let fileIndex = new Map();
  // runId → { runId, availability, primaryPath, primaryBucket, locations, facts }
  let runIndex = new Map();
  // slug → 项目名（null = 没有名字）
  let projectNames = new Map();
  // rootRunId → 谱系候选文件路径
  let lineageMembers = new Map();
  // rootRunId → { signature, superseded: Map<runId, runId|null> }（"被取代"的派生事实；
  // 该谱系任一候选文件的身份变了才重算，没变就沿用）
  let lineageDerived = new Map();
  // 有从没读得出过的转录：它属于哪条谱系无从得知，出快照时"被取代"与"合法裁决"一律
  // 按无法判定给（派生照常做并缓存，见 deriveLineage）。
  let lineageBlind = false;
  // 上一次刷新失败：文件索引可能已经看不全，"被取代"按无法判定给出，直到下一次刷新成功。
  let lineageStale = false;
  // consultId → { identity, record, seatKeys, value }（会审组记录与由它算出的事实）
  let consultIndex = new Map();
  // 席位转录路径 → { signature, text }：最终 assistant 文本（取结论用），text 是
  // Promise<string|null>。只缓存真正当过席位的转录；文件身份变了才重读。
  let finalTexts = new Map();
  // slug → { repo, observedAtMs, branches: Set<runId>|null }（分支观测，至多每
  // OWNER_BRANCH_REFRESH_MS 一次；失败如实记 unknown，不沿用过期结果）
  let branchIndex = new Map();
  let inflight = null;

  async function eachBatch(items, visit) {
    for (let start = 0; start < items.length; start += batchSize) {
      for (const item of items.slice(start, start + batchSize)) await visit(item);
      await yieldToEventLoop();
    }
  }

  /**
   * 刷新索引。第一次是冷普查（每个运行都记进 added）；之后只重读文件身份（大小、
   * mtime、ctime、ino）有变化的文件，以及上次读不到的文件。
   *
   * @returns {Promise<{scanned: number, reread: number, added: number, removed: number,
   *   moved: number, unreadable: number}>}
   *   scanned = 本次枚举到的 run 转录数；reread = 本次实际读取内容的转录文件数（含为
   *   谱系派生与席位结论重读的）；added / removed = 新出现 / 消失的运行数（按 runId）；
   *   moved = 换了位置、旧位置一个不剩的运行数；unreadable = 本次读不出的文件数——
   *   读不出（stat、读、解析任一失败）的转录，加上读不出或校验不过的会审组记录。
   *   并发调用共用同一次普查。中途失败则拒绝，已有索引与快照原样保留；只有谱系的
   *   "被取代"与"合法裁决"两项改为按无法判定给出（文件索引可能已经看不全）。
   */
  function refresh() {
    if (inflight === null) {
      inflight = runRefresh()
        .catch((error) => {
          lineageStale = true;
          throw error;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  async function runRefresh() {
    let listed;
    try {
      // 严格模式：任何一个桶读不出就抛。宽举会悄悄漏掉那个桶，把同一运行剩下的副本
      // 当成唯一可用档。
      listed = listFiles(runDir, { strict: true });
    } catch (error) {
      // 运行目录本身不存在 = 空存储（如实报告零个运行）；其余枚举失败一律拒绝。
      if (error?.code === "ENOENT" && !existsSync(runDir)) listed = [];
      else throw error;
    }
    listed = listed
      .filter((entry) => isRunTranscriptName(entry.name))
      .map((entry) => ({ path: entry.path, bucket: entry.bucket ?? null, runId: entry.name.slice(0, -".jsonl".length) }));
    // 项目名来自磁盘上可手改的 .project.json：进快照前过同一条安全链。
    const nextProjectNames = new Map(
      listProjectRecords(runDir)
        .filter((r) => r.slug !== null)
        .map((r) => [r.slug, safeDisplayText(r.displayName)]),
    );

    // ① 先 stat（读之前取身份：读到的新于 stat 时下一轮会重读，不会漏）。
    const located = [];
    const nextFiles = new Map();
    const scannedReads = new Set(); // ③ 里实际读了内容的转录路径
    const derivedReads = new Set(); // ⑤ 里为派生事实重读的转录路径
    let reread = 0;
    let unreadable = 0;
    await eachBatch(listed, async (entry) => {
      let identity;
      try {
        identity = identityOf(await statFile(entry.path));
      } catch (error) {
        if (error?.code === "ENOENT") return; // 枚举之后被删：不算任何一项
        // stat 失败（权限等）：这个位置这一轮读不到，也不去读它的内容。仍留在运行的
        // 分组里——否则同一运行剩下的副本会被当成唯一可用档。
        unreadable += 1;
        nextFiles.set(entry.path, unreadableEntry(entry, fileIndex.get(entry.path)));
        located.push({ entry, identity: null });
        return;
      }
      located.push({ entry, identity });
    });

    // ② 按运行归并，定出每个运行的主位置，挑出需要读的文件。
    const groups = new Map();
    for (const item of located) {
      if (!groups.has(item.entry.runId)) groups.set(item.entry.runId, []);
      groups.get(item.entry.runId).push(item);
    }
    const jobs = [];
    for (const items of groups.values()) {
      items.sort((a, b) => locationOrder(a.entry, b.entry));
      items.forEach((item, index) => {
        if (item.identity === null) return; // stat 失败：上面已记为读不到
        const { entry, identity } = item;
        const prev = fileIndex.get(entry.path);
        if (prev !== undefined && prev.hash !== null && prev.identity !== null && sameIdentity(prev.identity, identity)) {
          nextFiles.set(entry.path, { ...prev, runId: entry.runId, bucket: entry.bucket });
          return;
        }
        jobs.push({ entry, identity, earlier: items.slice(0, index).map((other) => other.entry.path) });
      });
    }

    // ③ 读：按原始字节算哈希并提取事实，都存进索引——之后无论结论怎么变（conflict
    //   消失、主位置被删），都没必要再读一份没变的文件。同一运行里字节相同的多处
    //   只解析第一处；字节不同就各存各的，但运行整体不可用。
    await eachBatch(jobs, async ({ entry, identity, earlier }) => {
      try {
        const bytes = toBytes(await readFile(entry.path));
        reread += 1;
        scannedReads.add(entry.path);
        const hash = createHash("sha256").update(bytes).digest("hex");
        const twin = earlier
          .map((path) => nextFiles.get(path))
          .find((record) => record !== undefined && record.hash === hash && record.facts !== null);
        const facts = twin !== undefined ? twin.facts : factsOf(bytes, entry.runId);
        nextFiles.set(entry.path, {
          runId: entry.runId, bucket: entry.bucket, identity, hash, facts, roots: facts.lineageRoots,
        });
      } catch {
        unreadable += 1;
        nextFiles.set(entry.path, unreadableEntry(entry, fileIndex.get(entry.path)));
      }
    });

    // ④ 定每个运行的可用性。
    const nextRuns = new Map();
    let added = 0;
    let removed = 0;
    let moved = 0;
    for (const [runId, items] of groups) {
      const previous = runIndex.get(runId);
      const primary = items[0].entry;
      const records = items.map((item) => nextFiles.get(item.entry.path) ?? null);
      const primaryRecord = records[0];
      let availability;
      if (records.some((r) => r === null || r.hash === null || r.facts === null)) availability = "unreadable";
      else if (records.some((r) => r.hash !== primaryRecord.hash)) availability = "conflict";
      else availability = "ok";

      const locations = items.map((item) => item.entry.path);
      nextRuns.set(runId, {
        runId,
        availability,
        primaryPath: primary.path,
        primaryBucket: primary.bucket,
        locations,
        facts: availability === "ok" ? primaryRecord.facts : null,
      });
      if (previous === undefined) added += 1;
      else if (previous.locations.every((p) => !locations.includes(p))) moved += 1;
    }
    for (const runId of runIndex.keys()) {
      if (!nextRuns.has(runId)) removed += 1;
    }

    // ⑤ 派生事实（都从上面刚建好的索引取，不另起枚举）：谱系取代、会审结论、项目分支。
    //    任何一步抛错都走不到下面的交接，已有索引原样保留。
    const nextKeys = collectProjectKeys();
    const readForFacts = async (path) => {
      derivedReads.add(path);
      return readFile(path);
    };
    const lineage = await deriveLineage(nextFiles, nextRuns, readForFacts);
    const consults = await collectConsults({ files: nextFiles, runs: nextRuns, keys: nextKeys, read: readForFacts });
    const branches = await observeBranches(nextRuns, nextKeys);

    fileIndex = nextFiles;
    runIndex = nextRuns;
    projectNames = nextProjectNames;
    lineageMembers = lineage.members;
    lineageDerived = lineage.derived;
    lineageBlind = lineage.blind;
    lineageStale = false;
    consultIndex = consults.index;
    branchIndex = branches;
    for (const path of finalTexts.keys()) if (!nextFiles.has(path)) finalTexts.delete(path);
    let derivedOnly = 0;
    for (const path of derivedReads) if (!scannedReads.has(path)) derivedOnly += 1;
    return {
      scanned: listed.length,
      reread: reread + derivedOnly,
      added,
      removed,
      moved,
      unreadable: unreadable + consults.unreadable,
    };
  }

  async function isDirectory(path) {
    try {
      return (await statFile(path)).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * slug → 项目仓库的主工作树根（.project.json 的 key；null = 多个 key 指向同一个 slug）。
   * 绝对路径，只用来定位会审组记录目录和枚举分支，不进快照。每次都从各桶的
   * .project.json 重建（那是权威；中心索引只是缓存，写失败时会缺条目）。读不出就是
   * 空表：所有项目仓库按 unknown 给。
   */
  function collectProjectKeys() {
    const keys = new Map();
    let entries;
    try {
      entries = loadBucketIndex(runDir, { forceRebuild: true }).entries;
    } catch {
      return keys;
    }
    for (const [key, slug] of Object.entries(entries)) {
      if (typeof slug !== "string" || !SAFE_BUCKET_SLUG_RE.test(slug)) continue;
      // 两个 key 指向同一个 slug：说不清是哪个仓库。
      keys.set(slug, keys.has(slug) && keys.get(slug) !== key ? null : key);
    }
    return keys;
  }

  /** 一组文件的身份签名：路径 + 文件身份 + 内容哈希。任一文件变了、增了、没了，签名就变。 */
  function signatureOf(paths, files) {
    return paths.slice().sort().map((path) => {
      const entry = files.get(path);
      const identity = entry === undefined || entry.identity === null
        ? "-"
        : `${entry.identity.size}:${entry.identity.mtimeNs}:${entry.identity.ctimeNs}:${entry.identity.ino}`;
      return `${path}\u0000${identity}\u0000${entry?.hash ?? "-"}`;
    }).join("\u0001");
  }

  /**
   * 谱系的"被取代"派生（createLineageSupersession 是判定与派生的唯一实现；这里只喂
   * 索引）。候选根索引 lineageRootsOf 给出，成员判定仍在 lineageClose。
   *   - 只为会走到派生的运行建派生器（supersessionCandidateGate：有谱系引用、已打包、
   *     自身未裁决、已收口）；其余运行的"被取代"按同一条门的规则就是 null。
   *   - 一条谱系的候选文件身份没变，就沿用上一次的派生结果，不读任何文件。派生结果
   *     只取决于这条谱系的成员，所以缓存按成员身份有效。
   *   - 有从没读得出过的转录时（blind）：它属于哪条谱系无从得知，就不能断言别的谱系
   *     里没有它——这时照常派生并缓存，但出快照时一律不发布（见 projectRun）。不把
   *     blind 传成 filesIncomplete：那会把这一轮的空结果缓存下来，等那份转录读得出
   *     之后，与它无关的谱系会一直命中那份空结果。
   *   - 读得出过的转录后来读不到了，仍留在它声明过的谱系的候选里——派生器读到读不出，
   *     整条谱系如实不推导。
   */
  async function deriveLineage(files, runs, read) {
    const members = new Map();
    let blind = false;
    for (const [path, entry] of files) {
      if (entry.roots === null) blind = true;
      for (const root of entry.roots ?? [entry.runId]) {
        if (!members.has(root)) members.set(root, []);
        members.get(root).push(path);
      }
    }
    const candidates = new Map(); // rootRunId → runId[]
    for (const run of runs.values()) {
      if (run.availability !== "ok" || !run.facts.supersessionCandidate || run.facts.lineageConflict) continue;
      const root = run.facts.lineageRoot;
      if (!candidates.has(root)) candidates.set(root, []);
      candidates.get(root).push(run.runId);
    }
    const fileOf = (path) => ({ name: `${files.get(path).runId}.jsonl`, path });
    const derived = new Map();
    await eachBatch([...candidates.keys()].sort(), async (root) => {
      const signature = signatureOf(members.get(root) ?? [], files);
      const previous = lineageDerived.get(root);
      if (previous !== undefined && previous.signature === signature) {
        derived.set(root, previous);
        return;
      }
      const supersession = createLineageSupersession({
        runDir,
        readTranscriptFn: async (path) => eventsOf(toBytes(await read(path))),
        // 索引条目不带路径（路径是索引的键）：这里从键取。
        files: [...files].map(([path, entry]) => ({ name: `${entry.runId}.jsonl`, path })),
        memberFilesForRoot: (rootRunId) => (members.get(rootRunId) ?? []).map(fileOf),
        // 文件清单已注入：派生器不该再枚举。真枚举了就让它失败（= 不推导），不悄悄读盘。
        enumerateFilesFn: () => {
          throw new Error("ownerReadModel: lineage derivation must use the read model's file index");
        },
      });
      const superseded = new Map();
      for (const runId of candidates.get(root)) {
        let by = null;
        try {
          const result = await supersession.forRun({ runId });
          by = isValidRunId(result.supersededByRunId) ? result.supersededByRunId : null;
        } catch {
          by = null; // 派生读不出：不推导
        }
        superseded.set(runId, by);
      }
      derived.set(root, { signature, superseded });
    });
    return { members, derived, blind };
  }

  /**
   * 会审结论：逐个项目列 <key>/.wao/runs/consults/，按文件身份缓存组记录。组记录没变、
   * 席位转录也没变就不重算；重算时，席位转录的文件身份没变就不重读（最终回答文本按
   * 文件身份缓存）。坏记录计入 unreadable，不中断刷新。
   */
  async function collectConsults({ files, runs, keys, read }) {
    const index = new Map();
    let unreadable = 0;
    await eachBatch([...keys], async ([slug, key]) => {
      if (key === null || !(await isDirectory(key))) return;
      const dir = join(key, ".wao", "runs", "consults");
      let names;
      try {
        names = await listDir(dir);
      } catch (error) {
        // 没有这个目录 = 这个项目还没开过会审；其余读不出（权限等）如实计数。
        if (error?.code !== "ENOENT") unreadable += 1;
        return;
      }
      for (const name of Array.isArray(names) ? names : []) {
        if (typeof name !== "string" || !name.endsWith(".json")) continue;
        const consultId = name.slice(0, -".json".length);
        if (!isValidConsultId(consultId)) continue;
        const path = join(dir, name);
        let identity;
        try {
          identity = identityOf(await statFile(path));
        } catch (error) {
          if (error?.code !== "ENOENT") unreadable += 1;
          continue;
        }
        const previous = consultIndex.get(consultId);
        let record = previous !== undefined && sameIdentity(previous.identity, identity) ? previous.record : null;
        if (record === null) {
          record = await loadConsultRecordSafe(consultId, dir, path);
          if (record === null) {
            unreadable += 1;
            continue;
          }
        }
        const seats = locateSeats(record, runs);
        const seatKeys = JSON.stringify(seats.map((seat) => seatKey(seat, files)));
        if (previous !== undefined && record === previous.record && previous.seatKeys === seatKeys) {
          index.set(consultId, previous);
          continue;
        }
        index.set(consultId, {
          identity, record, seatKeys, value: await consultValue(slug, record, seats, runs, files, read),
        });
      }
    });
    return { index, unreadable };
  }

  async function loadConsultRecordSafe(consultId, dir, path) {
    try {
      // 校验（consultId 形状、记录里的 consultId 与文件名一致、JSON 可解析）走
      // loadConsultRecord。它读到半截内容会隔 100ms 重读几次；读模型本来就每轮刷新
      // 重来一次，这里不等——半截的记录这一轮按坏记录计，下一轮自然重读。
      // 直接走读缝：组记录不是转录，不计进 reread。
      return await loadConsultRecord({
        consultId,
        consultsDir: dir,
        readFileFn: async () => toBytes(await readFile(path)).toString("utf8"),
        sleepFn: async () => {},
      });
    } catch {
      return null;
    }
  }

  /**
   * 组记录里的席位与它们在本运行目录里的定位。定位走 resolveRun 同一份逻辑（只认本
   * 运行目录的枚举结果）；记录里的 agentId / runId 不合形状就是 null。
   */
  function locateSeats(record, runs) {
    const seats = Array.isArray(record.seats)
      ? record.seats.filter((seat) => seat !== null && typeof seat === "object" && !Array.isArray(seat))
      : [];
    return seats.map((seat) => ({
      agentId: isValidCanonicalAgentId(seat.agentId) ? seat.agentId : null,
      runId: isValidRunId(seat.runId) ? seat.runId : null,
      // 记录点名了一个 run（哪怕 runId 不合形状）：找不到就按 missing 给，不拿记录里的旧观察顶。
      claimsRun: typeof seat.runId === "string" && seat.runId.length > 0,
      recordedState: memberOf(SEAT_RUN_STATES, seat.runState),
      located: isValidRunId(seat.runId) ? locateIn(runs, seat.runId) : null,
    }));
  }

  /** 席位转录在这一轮的键：定位不到、读不到、或文件身份 + 内容哈希。 */
  function seatKey(seat, files) {
    const entry = seat.located === null ? undefined : files.get(seat.located.transcriptPath);
    if (seat.located === null) return "missing";
    if (entry === undefined || entry.facts === null) return "unreadable";
    return signatureOf([seat.located.transcriptPath], files);
  }

  /**
   * 一场会审的结论事实。Q1 按决定 0128 重算：取文与 observeSeatRun 同一个
   * extractFinalAssistantText，归组与取值用 attributeReply / compareFields（声明用组记录
   * 里的 declaredFields 原样）。只有记录声明了 Q1、且候选值里有闭集结论值时才算，取到的
   * 值也必须是闭集成员——记录是磁盘上可手改的，别的字符串不进快照。
   */
  async function consultValue(projectSlug, record, seats, runs, files, read) {
    const declared = record.declaredFields;
    const q1Declared = Array.isArray(declared?.Q1)
      && declared.Q1.some((v) => typeof v === "string" && OWNER_CONSULT_Q1_VALUES.includes(v));
    const attribution = {};
    const rows = [];
    for (const seat of seats) {
      let runState = seat.claimsRun ? "missing" : seat.recordedState;
      let text = null;
      if (seat.located !== null && seat.located.availability === "ok") {
        runState = runs.get(seat.runId).facts.state;
        text = await seatText(seat, files, read);
      }
      if (seat.agentId !== null && text !== null) attribution[seat.agentId] = attributeReply(text);
      rows.push({ agentId: seat.agentId, runId: seat.runId, runState, q1: null });
    }
    const { fieldValues } = compareFields(attribution, declared);
    for (const row of rows) {
      row.q1 = q1Declared && row.agentId !== null
        ? memberOf(OWNER_CONSULT_Q1_VALUES, fieldValues.Q1?.[row.agentId])
        : null;
    }
    return {
      consultId: record.consultId,
      projectSlug,
      createdAt: iso(tsMs(record.createdAt)),
      reviewedRunId: isValidRunId(record.reviewedRunId) ? record.reviewedRunId : null,
      q1Declared,
      seats: rows,
    };
  }

  /**
   * 席位的最终 assistant 文本（取文与 observeSeatRun 同一个函数；读不到 → null）。按
   * 转录的文件身份缓存：身份没变就不重读；同一轮里几场会审共用同一席时也只读一次。
   */
  function seatText(seat, files, read) {
    const path = seat.located.transcriptPath;
    const signature = signatureOf([path], files);
    const cached = finalTexts.get(path);
    if (cached !== undefined && cached.signature === signature) return cached.text;
    const runId = seat.runId;
    const text = (async () => {
      try {
        return extractFinalAssistantText(eventsOf(toBytes(await read(path))), { runId, env: {} });
      } catch {
        return null;
      }
    })();
    finalTexts.set(path, { signature, text });
    return text;
  }

  /**
   * 分支观测：只对至少有一个请求了交付的运行的项目做，每个项目至多每
   * OWNER_BRANCH_REFRESH_MS 一次（不论成败）。仓库根不存在、不是目录、或 git 失败都如实
   * 记 unknown——不拿上一次的结果冒充这一轮的观测。项目没有仓库事实（没有 key，或
   * 多个 key 指向同一个 slug）时丢掉旧观测；不再有交付运行的项目留着最后一次观测，
   * 它的时刻一并给出。
   */
  async function observeBranches(runs, keys) {
    const next = new Map(branchIndex);
    const now = timeMs(nowFn());
    const wanted = new Set();
    for (const run of runs.values()) {
      if (run.availability !== "ok" || run.facts.deliveryRequested !== true) continue;
      const slug = projectSlugOf(run);
      if (slug !== null) wanted.add(slug);
    }
    for (const slug of wanted) {
      const key = keys.get(slug);
      if (key === undefined || key === null) {
        next.delete(slug);
        continue;
      }
      const previous = next.get(slug);
      if (previous !== undefined && now !== null && previous.observedAtMs !== null
        && previous.observedAtMs <= now && now - previous.observedAtMs < OWNER_BRANCH_REFRESH_MS) {
        continue;
      }
      // 仓库根不存在或不是目录：没有可观测的分支，不记观测时刻（下一轮再看——stat 很便宜，
      // 目录一出现就能观测到）。
      if (!(await isDirectory(key))) {
        next.set(slug, { repo: "unknown", observedAtMs: null, branches: null });
        continue;
      }
      let branches = null;
      try {
        branches = new Set(listRunBranchRunIds(execGit, key));
      } catch {
        branches = null;
      }
      next.set(slug, { repo: branches === null ? "unknown" : "available", observedAtMs: now, branches });
    }
    return next;
  }

  /**
   * 发布一份快照：用同一个 now 现算每个运行的活性与阶段时效，并当场读心跳租约。
   * 快照里没有任何仓库路径、工作树路径、cwd、转录路径或会审记录路径；项目只给
   * slug、名字、仓库是否可观测与分支观测时刻。
   *
   * @param {{now?: number}} [options] — 缺省取 nowFn()；必须是可表示的 epoch ms
   *   （有限且在 Date 范围内），否则抛 TypeError
   * @returns {{generatedAt: string,
   *   projects: Array<{slug: string, name: string|null, repo: string, branchesObservedAt: string|null}>,
   *   runs: object[], consults: object[]}}
   *   consults 按组记录的 createdAt 升序（没有可用时间的排在最后）。
   */
  function snapshot({ now } = {}) {
    const at = now === undefined ? nowFn() : now;
    // now 必须是可表示的时刻：否则 generatedAt 会变成 null，与返回类型不符。这是
    // 调用方的错误（传错单位、时钟坏了），抛 TypeError 而不是发一份残缺的快照。
    if (timeMs(at) === null) {
      throw new TypeError("ownerReadModel.snapshot: now must be a representable epoch ms (finite and within the Date range)");
    }
    const runs = [...runIndex.values()].sort(byRunId).map((run) => projectRun(run, at));
    const slugs = new Set([...projectNames.keys()]);
    for (const run of runs) if (run.project !== null) slugs.add(run.project.slug);
    return {
      generatedAt: iso(at),
      projects: [...slugs].sort().map((slug) => {
        const observed = branchIndex.get(slug);
        return {
          slug,
          name: projectNames.get(slug) ?? null,
          repo: observed?.repo === "available" ? "available" : "unknown",
          branchesObservedAt: iso(observed?.observedAtMs ?? null),
        };
      }),
      runs,
      consults: [...consultIndex.values()].map((entry) => entry.value).sort(byConsultCreatedAt),
    };
  }

  function projectRun(run, now) {
    const ok = run.availability === "ok";
    const f = ok ? run.facts : null;
    const slug = projectSlugOf(run);
    let heartbeatAtMs = null;
    if (ok && f.terminal !== true) {
      try {
        const lease = readOwnerLease(runDir, run.runId, now);
        // 表示不了的心跳（超出 Date 范围）不是时刻：按没有这项体征处理。
        heartbeatAtMs = lease.wellFormed === true ? timeMs(lease.heartbeatAt) : null;
      } catch {
        heartbeatAtMs = null; // 租约读不出 = 没有这项体征
      }
    }

    let liveness = "unknown";
    if (ok) {
      if (f.terminal) liveness = "terminal";
      else if (withinWindow(f.lastEffectAtMs, now, OWNER_PROGRESS_WINDOW_SECONDS)) liveness = "progress";
      else if (withinWindow(f.lastProcessActiveAtMs, now, OWNER_PROCESS_WINDOW_SECONDS)
        || withinWindow(heartbeatAtMs, now, OWNER_PROCESS_WINDOW_SECONDS)) liveness = "process_only";
      else liveness = "silent";
    }
    const vital = [ok ? f.lastVitalEventAtMs : null, heartbeatAtMs].filter((ms) => ms !== null);

    // 谱系两项无法判定：上一轮刷新失败、有从没读得出过的转录、或本谱系里有读不出的成员。
    // 这时不给"被取代"的结论，"合法裁决"也一并按无法判定给；声明根是本转录自己的事实，照给。
    const undeterminable = ok
      && (lineageStale || lineageBlind || memberUnreadable(f.lineageRoot));
    const branches = slug === null ? undefined : branchIndex.get(slug)?.branches;
    return {
      runId: run.runId,
      project: slug === null ? null : { slug, name: projectNames.get(slug) ?? null },
      availability: run.availability,
      state: f?.state ?? null,
      terminal: f?.terminal ?? null,
      liveness,
      stage: ok ? (STAGE_DISPLAY[f.stagePhase] ?? "stage_unknown") : "stage_unknown",
      agentId: f?.agentId ?? null,
      laneId: f?.laneId ?? null,
      roleId: f?.roleId ?? null,
      readOnly: f?.readOnly ?? null,
      deliveryRequested: f?.deliveryRequested ?? null,
      title: f?.title ?? null,
      titleBasis: f?.titleBasis ?? null,
      taskType: f?.taskType ?? null,
      typeBasis: f?.typeBasis ?? null,
      startedAt: iso(f?.startedAtMs ?? null),
      terminalAt: iso(f?.terminalAtMs ?? null),
      stageSince: iso(f?.stageSinceMs ?? null),
      // lastEffectAt 只给实质动作（没有就是 null）；quietSince 是静默门限的起点。
      lastEffectAt: iso(f?.lastEffectAtMs ?? null),
      quietSince: iso(f?.quietSinceMs ?? null),
      lastVitalAt: iso(vital.length === 0 ? null : Math.max(...vital)),
      lastProcessActiveAt: iso(f?.lastProcessActiveAtMs ?? null),
      retryOf: f?.retryOf ?? null,
      parentRunId: f?.parentRunId ?? null,
      // 交付：没请求交付就是 null。branchPresent = 该运行的 wao/<runId> 分支还在不在；
      // 仓库 unknown 或还没观测过就是 null（不当作"不在"）。
      delivery: f === null || f.delivery === null ? null : projectDelivery(run.runId, f.delivery, branches),
      // 失败与额度：只在状态为 failed 时有。
      failure: f?.failure ?? null,
      capacity: f === null || f.capacity === null ? null : { code: f.capacity.code, observedAt: iso(f.capacity.observedAtMs) },
      lineageRootRunId: f?.lineageRoot ?? null,
      lineageRootConflict: f?.lineageConflict ?? null,
      lineageUndeterminable: ok ? undeterminable : null,
      legalDecision: undeterminable ? null : f?.legalDecision ?? null,
      supersededByRunId: undeterminable ? null : lineageDerived.get(f?.lineageRoot)?.superseded.get(run.runId) ?? null,
    };
  }

  /**
   * 授权入口（服务端用）。只在两种情况返回定位，并带上 availability：
   *   - availability === "ok"；
   *   - 读不到、且这个运行只有一个位置（服务端读它时自行得到读失败）。
   * 多个位置里有任一份读不到、或 conflict → null（读其中可读的那份等于替它选边）。
   * 不做 cwd 匹配。首次 refresh() 完成前一律 null——服务端要先等冷普查。
   *
   * @param {unknown} runId
   * @returns {{runId: string, availability: string, transcriptPath: string, bucket: string|null}|null}
   */
  function resolveRun(runId) {
    return locateIn(runIndex, runId);
  }

  /** resolveRun 的定位逻辑，对任意一份运行索引求值（刷新中途的会审席位定位用新索引）。 */
  function locateIn(index, runId) {
    if (!isValidRunId(runId)) return null;
    const run = index.get(runId);
    if (run === undefined) return null;
    const singleUnreadable = run.availability === "unreadable" && run.locations.length === 1;
    if (run.availability !== "ok" && !singleUnreadable) return null;
    return { runId, availability: run.availability, transcriptPath: run.primaryPath, bucket: run.primaryBucket };
  }

  /** 本谱系的候选文件里有读不出的成员 → "被取代"无从推导。 */
  function memberUnreadable(root) {
    return root !== null && (lineageMembers.get(root) ?? []).some((path) => fileIndex.get(path)?.facts == null);
  }

  return { refresh, snapshot, resolveRun };
}
