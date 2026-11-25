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
//     名字。标题与项目名先脱敏、把绝对路径（盘符 / UNC / POSIX）折成 `…/最后一段`、
//     再清控制字符、最后限长。
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
//     validateDeliveryFacts。settledAt 是交付的收口时刻（决定见 deriveDeliveryFacts）：
//     delivery_settled 取绑定终态事件与该轮有效验证（或已完成的复验）结果事件两者中
//     较晚的时间；packaging_failed / isolation_failed 取绑定终态事件的时间；
//     unsettled / undeterminable 为 null。
//   - 失败与额度：diagnoseFailureWithBasis（src/diagnosis.js）——闭集 category 与
//     code，以及额度结论所依据的那条 run.error 的时间。
//   - 谱系：声明根与合法裁决是 lineageSupersession.js 的纯判定；"被取代"复用
//     createLineageSupersession，把本模型的文件索引经 files / memberFilesForRoot
//     注入——不另起全量枚举，也不做字节预筛。文件集 = 活库 + 归档面（见
//     deriveLineage）；成员按运行折叠（同 runId 的全部副本），与回收计划的 byRoot
//     同一口径。派生有没有得出**结论**由 forRun 的 derived 事实给出：只有结论才
//     缓存；没能推导的下一轮重试、快照里标 supersessionUndeterminable。
//   - 分支：runBranches.js 的枚举，与 lead_preflight 待办事项是同一份答案。
//   - 会审：组记录经 loadConsultRecord 校验；Q1 的取文与 observeSeatRun 同一个
//     extractFinalAssistantText，归组与取值用 attributeReply / compareFields；缓存
//     只存算出的 Q1 值（键 = 席位转录身份 + 记录声明的 Q1 候选），不存回答原文，
//     组记录只留快照需要的字段。
//
// 写清楚、不改的口径（140c 要知道）：
//   - delivery.verification.status 是**有效**验证状态（复验链完成时用复验结果），
//     等于 `wao runs delivery` 的 effectiveVerification.status，不是原始状态。
//   - repo: "available" 表示"最近一次分支枚举成功"，与 branchesObservedAt 一起读；
//     没观测过与观测失败都是 "unknown"，靠 branchesObservedAt 区分（null = 没观测过）。
//   - 项目行的 consultRecords: "available" = 这一轮会审目录列出成功（或目录不存在）；
//     "unknown" = 列不出、单份记录 stat / 读取 I/O 出错（这一轮保留同一 key 上一轮
//     的条目），或同一个 slug 对应多个 key（定位不了会审记录目录），并计入 unreadable
//     （前两种）。
//   - 席位 runState 的值域：RUN_STATES、dispatch_failed、missing，以及读模型自己的
//     unknown（席位记录的形状可用、但没定位到运行且记录没给可采信状态时）。
//   - 转录只解析到最后一个换行为止（140a 约定，防半行）；席位 Q1 也按这份事件算。
//     写转录总是整行带换行一次写入，所以缺尾换行只出现在截断或损坏的文件里。
//   - legalDecision 用 legalDeliveryDecision（末条合法裁决），delivery.acceptance 用
//     validateDeliveryFacts（多条裁决判 malformed）。两者纪律不同，在坏转录里可能
//     不一致，事项推导要按各自的口径读。
//
// 已知局限：
//   - 会审组记录只看现行位置 <项目 key>/.wao/runs/consults/<consultId>.json。项目的
//     状态目录被重定向过的（链接工作树自己的 .wao、改过 stateDir 的项目），记录在
//     别处，这里找不到。
//   - 谱系派生的归档面只读"可能成为成员"的那一部分：子运行一定晚于它的根创建，
//     runId 带创建时间（run_YYYYMMDD…），所以 runId 早于「最老的待派生根 − 24h 时钟
//     容差」的归档文件不可能是成员——只保留文件名（归档枚举本身已对每份文件 lstat），
//     不读内容（真实存储 2,420 份归档里通常只有个位数满足条件）。归档枚举读不出
//     （整根或某个月目录）时，按它能覆盖的时间范围收窄影响面：整根读不出影响全部
//     待派生根，月目录读不出只影响创建时间不晚于「该月末 + 容差」的根；单份文件读
//     不出按该文件 runId 的时间只影响创建时间早于「它 + 容差」的根。理由同前：成员
//     必晚于根。同一毫秒算"可能"。
//   - 时钟容差 24 小时的已知局限：机器时钟回拨超过一天时，时间序判断可能漏掉或
//     多算成员（方向由各处的保守写法决定）。
//   - 席位回答只留算出的 Q1；席位转录的文件身份变了才重读。
//
// 架构契约：不 import src/commands/*、src/mcp/*、MCP SDK 或 zod。

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile as fsReadFile, readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  listProjectRecords,
  listTranscriptsDeep,
  loadBucketIndex,
  SAFE_BUCKET_SLUG_RE,
} from "../projectBuckets.js";
import {
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
import { listArchiveTranscriptFiles } from "./serveMaintenance.js";
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

// 绝对路径的三种形状（决定 0131 §3：快照里不出现路径），三种形状共用同一套段规则：
//   - 段内字符：非空白、非路径分隔符、非引号/尖括号竖线、非中文标点、非破折号 `—`
//     与省略号 `…`；
//   - 目录段默认是单个词；**含空格的目录段**必须同时满足：后面紧跟路径分隔符、由
//     至多 3 个以单个空格相连的词组成、且后面跟着空格的词都不像文件名（不以
//     `.` + 1–8 个字母/数字结尾，如 `x.md`、`run_x.jsonl`）。目录名本身带点
//     （`v1.2/`、`.bin/`）不受影响——它后面是分隔符，不是空格；
//   - 段与段之间的分隔符是一个或多个 `\` 或 `/`（贴 JSON 时常见的转义重复分隔符
//     `D:\\projects\\…`、`/home//secret/…` 按同一个分隔符处理）；
//   - 不满足就回到旧读法：路径到第一个空白为止（最后一段/文件名也到空白为止）；
//   - 宁可多折，不可漏目录，但不能越过文件名吞掉后面的句子。
const PATH_SEGMENT_CHAR = "[^\\s\"'<>|，。；：、！？（）【】《》「」“”‘’—…\\\\/]+";
// 「后面跟着空格的词」的尾部不能像文件名：`.md` / `.jsonl` 之类。
const WORD_END_NOT_FILENAME = "(?<!\\.[A-Za-z0-9]{1,8})";
// 目录段：单个词，或至多 3 个以单个空格相连的词（前两个词后面跟空格，不能像文件名）。
const PATH_DIR_SEGMENT = `(?:${PATH_SEGMENT_CHAR}|${PATH_SEGMENT_CHAR}(?:${WORD_END_NOT_FILENAME}[ ]${PATH_SEGMENT_CHAR}){1,2})`;
// 段与段之间是一个或多个 `\` 或 `/`（提示词里贴 JSON 时常见转义重复的分隔符）；
// 最后一段到空白为止。
const PATH_TAIL = `(?:${PATH_DIR_SEGMENT}[\\\\/]+)*${PATH_SEGMENT_CHAR}`;
// 盘符路径：X:\… / X:/…。前面不能紧跟词字符（https://x 里的 "s:/" 不是盘符路径）；
// 冒号后的分隔符也允许重复（`D:\\projects\\…`）。
const DRIVE_PATH_RE = new RegExp(`(^|[^A-Za-z0-9_])([A-Za-z]:[\\\\/]+${PATH_TAIL})`, "g");
// UNC：\\server\share\…
const UNC_PATH_RE = new RegExp(`(\\\\\\\\${PATH_TAIL})`, "g");
// POSIX 绝对路径：/a/b（也接受 `//server/share` 这种以斜杠开头的写法）。前导只有行首、
// 空白、开括号，或"前面是行首/空白/开括号"的引号才算数——词字符后面的撇号不是前导
// （修订版写法 `R3'/R4' 已 PASS` 原样保留）。
// 整段前导用非捕获组写，外层只留"前导 | 路径"两个捕获组。
const POSIX_PREFIX = `(?:^|[\\s(\\[（【{]|(?:^|[\\s(\\[（【{])["'])`;
const POSIX_PATH_RE = new RegExp(`(${POSIX_PREFIX})(\\/{1,}${PATH_TAIL})`, "g");

/** 路径的最后一段（末尾分隔符不算）；拆不出段时为空串。 */
function lastPathSegment(path) {
  const segments = String(path).split(/[\\/]+/).filter((segment) => segment.length > 0);
  return segments.length === 0 ? "" : segments[segments.length - 1];
}

/**
 * 把绝对路径折成 `…/最后一段`：只保留人认得出是哪个文件的那一段，目录与根全部去掉。
 * 相对路径、普通斜杠词（wao/run_x、Q1/Q2）与 URL（https://…）不动；词字符后面的
 * 撇号不算路径前导。先折路径再做控制字符清理与限长。
 */
function foldAbsolutePaths(text) {
  return text
    .replace(DRIVE_PATH_RE, (match, prefix, path) => `${prefix}…/${lastPathSegment(path)}`)
    .replace(UNC_PATH_RE, (match, path) => `…/${lastPathSegment(path)}`)
    .replace(POSIX_PATH_RE, (match, prefix, path) => `${prefix}…/${lastPathSegment(path)}`);
}

/**
 * 给人看的动态文本走同一条安全链（决定 0131 §3）：脱敏 → 含换行或制表符的空白段
 * 整体折成一个空格 → 绝对路径折成 `…/最后一段` → 清控制字符 → 限长。标题与项目名
 * 共用。顺序不能反：先截断会把跨在截断点上的秘密形状切掉半截，剩下的半段匹配不到
 * 整段规则，脱敏失效；路径折在限长之前，帽里永远不会出现盘符或目录。
 * 加工后为空 → null。
 */
function safeDisplayText(text) {
  if (typeof text !== "string") return null;
  const folded = redactSecretShapes(text).replace(WHITESPACE_RUN_RE, (run) => (/[\r\n\t]/.test(run) ? " " : run));
  const safe = truncateHead(sanitizeControls(foldAbsolutePaths(folded)).trim(), OWNER_TITLE_MAX_CHARS);
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
 *   - settledAtMs：已收口（settlement settled）的交付的收口时刻。delivery_settled 取
 *     绑定终态事件与该轮有效验证结果事件（或已完成的复验结果事件）两者中较晚的时间
 *     （"等裁决"从这一刻算起；结果事件由 validateDeliveryFacts 的
 *     verificationOutcomeEvent / reverifyOutcomeEvent 给出，不在这里另写筛选）；
 *     packaging_failed / isolation_failed 取绑定终态事件的时间；unsettled /
 *     undeterminable 没有收口时刻，为 null。
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
    // 收口时刻与"交付视图可用"无关：打包/隔离失败时没有可用交付视图，但已收口。
    if (settlement.status === "settled" && settlement.reason === "delivery_settled") {
      // 有效验证来自复验链时，结果事件是复验的结果事件；否则是原始验证结果事件
      // （validateDeliveryFacts 选中的那条，不在读模型里另写筛选）。
      const outcome = facts.reverifyStatus === "complete"
        ? facts.reverifyOutcomeEvent
        : facts.verificationOutcomeEvent;
      const times = [tsMs(terminalEvent?.ts), tsMs(outcome?.ts)];
      if (times.every((t) => t !== null)) out.settledAtMs = Math.max(...times);
    } else if (settlement.status === "settled") {
      // 打包失败 / 隔离失败：绑定终态事件的时间就是收口时刻。
      out.settledAtMs = tsMs(terminalEvent?.ts);
    }
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
 * runId 里的创建时刻（epoch ms）。WAO 生成的 runId 是 `run_` + 17 位 UTC 时间戳
 * （YYYYMMDDHHmmss + 毫秒）+ 随机后缀；不是这个形状（测试合成值、别的工具造的值）
 * 就是 null——时间序不可比。
 */
function runCreatedAtMs(runId) {
  if (typeof runId !== "string" || !runId.startsWith("run_")) return null;
  const digits = runId.slice(4, 21);
  if (!/^\d{17}$/.test(digits)) return null;
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const hour = Number(digits.slice(8, 10));
  const minute = Number(digits.slice(10, 12));
  const second = Number(digits.slice(12, 14));
  const milli = Number(digits.slice(14, 17));
  const value = Date.UTC(year, month - 1, day, hour, minute, second, milli);
  if (timeMs(value) === null) return null;
  const at = new Date(value);
  // 越界字段（13 月、32 日）会被 Date.UTC 归一化到别的时刻：按"时间序不可比"处理。
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day
    && at.getUTCHours() === hour && at.getUTCMinutes() === minute && at.getUTCSeconds() === second
    && at.getUTCMilliseconds() === milli
    ? value
    : null;
}

/**
 * 谱系时间序的时钟容差（24 小时）。runId 的时间戳来自机器时钟，转录归档/月目录的
 * 分月也取自事件时间或文件 mtime——两边都可能偏。判"谁可能早于谁"时留出一天的
 * 余量：覆盖机器时钟回拨与归档月份取末事件时间 / mtime 的偏差；回拨超过一天是
 * 已知局限。
 */
const RUN_CLOCK_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/**
 * childRunId 有没有可能声明 rootRunId 为它的谱系根：子运行一定晚于它的根创建
 * （runId 带创建时间）。相等（同一毫秒）算"可能"；再留 `RUN_CLOCK_TOLERANCE_MS`
 * 的容差（根可以比子早最多一天、含恰好一天，仍算可能）。时间序不可比（形状不合）
 * 时保守算"可能"。
 */
function childMayFollowRoot(childRunId, rootRunId) {
  const childAt = runCreatedAtMs(childRunId);
  const rootAt = runCreatedAtMs(rootRunId);
  if (childAt === null || rootAt === null) return true;
  // 恰好等于容差也算"可能"——与归档候选、月目录两处的等号边界一致。
  return rootAt <= childAt + RUN_CLOCK_TOLERANCE_MS;
}

/**
 * 归档月目录 `<yyyy-mm>` 里能装下的最晚 runId 时刻（该月最后一毫秒）。月份目录读不出
 * 时，它可能藏着的成员最晚创建于这个时刻（再留时钟容差）——只有创建时间不晚于
 * 「月末 + 容差」的根才受影响（成员必晚于根）。月份形状不合 → null（时间序不可比，
 * 影响全部）。
 */
function archiveMonthEndMs(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(typeof month === "string" ? month : "");
  if (m === null) return null;
  const year = Number(m[1]);
  const monthNumber = Number(m[2]);
  if (!Number.isInteger(year) || monthNumber < 1 || monthNumber > 12) return null;
  return Date.UTC(year, monthNumber, 1) - 1;
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

/** 转录路径 → runId（文件名不是 run_<合法 runId>.jsonl 时 null）。 */
function runIdFromTranscriptPath(path) {
  if (typeof path !== "string") return null;
  const name = basename(path);
  return isRunTranscriptName(name) ? name.slice(0, -".jsonl".length) : null;
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

/**
 * 读不到的位置在索引里的那一条：事实全空；谱系候选根沿用上一次读得出时的值（从没有过
 * 就是 null）。identityIntact = 这一轮已知它的身份没变（只是读失败）——这时旧根仍可信；
 * 身份变了、或 stat 都失败（身份不可知）时，旧根不再可信：它现在只可能是比它早创建的
 * 根的成员（见 deriveLineage 的 blind 口径）。
 */
function unreadableEntry(entry, previous, { identityIntact = false } = {}) {
  return {
    runId: entry.runId,
    bucket: entry.bucket,
    identity: null,
    hash: null,
    facts: null,
    roots: previous?.roots ?? null,
    trustedRoots: identityIntact === true && previous?.trustedRoots === true,
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

/**
 * 会审行（快照投影：每次快照新建对象，不把缓存里的对象交给调用方）。
 * @param {object} value — 缓存里的会审事实
 */
function projectConsult(value) {
  return {
    consultId: value.consultId,
    projectSlug: value.projectSlug,
    createdAt: value.createdAt,
    reviewedRunId: value.reviewedRunId,
    q1Declared: value.q1Declared,
    seats: value.seats.map((row) => ({ agentId: row.agentId, runId: row.runId, runState: row.runState, q1: row.q1 })),
  };
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
 *   `listArchiveFiles(runDir)` → 归档面 `{ files, skipped }`（缺省
 *   listArchiveTranscriptFiles）、`listDir(dir)` → 文件名数组（会审组记录目录）、
 *   `execGit(args, cwd)` → stdout（只读分支枚举，同步或异步返回值都行）
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
  const listArchiveFiles = io.listArchiveFiles ?? listArchiveTranscriptFiles;
  const listDir = io.listDir ?? fsReaddir;
  const execGit = io.execGit ?? execGitReadOnly;

  // path → { runId, bucket, identity: {size, mtimeNs, ctimeNs, ino}|null, hash, facts,
  //   roots, trustedRoots }（identity 为 null 或 hash / facts 为 null = 那一次读不到，
  //   下轮重试。roots = 这份转录声明的谱系候选根；trustedRoots = 这份 roots 现在还可信
  //   ——身份没变、只是这一轮又读不出时仍可信；从没读出过、或身份变了又读不出时不可信，
  //   它现在只可能是比它早创建的根的成员）
  let fileIndex = new Map();
  // runId → { runId, availability, primaryPath, primaryBucket, locations, facts }
  let runIndex = new Map();
  // slug → 项目名（null = 没有名字）
  let projectNames = new Map();
  // 归档面候选文件 path → { identity, hash, roots }（只为"可能是待派生根的成员"的归档
  // 文件读取；按文件身份缓存它们声明的谱系根，身份没变就不重读）
  let archiveLineage = new Map();
  // rootRunId → { signature, superseded: Map<runId, runId|null> }（"被取代"的派生事实；
  // 只存得出过结论的；该谱系任一候选文件的身份变了才重算，没变就沿用）
  let lineageDerived = new Map();
  // `${slug}\u0000${consultId}` → { identity, spec, value }（会审组记录、快照需要的字段
  // 与算好的投影；记录里的其余内容不留在内存里）
  let consultIndex = new Map();
  // 席位转录 path → { signature, q1Key, q1 }：按"席位转录身份 + 记录声明的 Q1 候选"
  // 缓存的 Q1 值（只缓存算出来的值，不缓存回答原文；读失败不缓存）。
  let seatQ1 = new Map();
  // slug → "available" | "unknown"：这一轮该项目会审目录有没有列出来。
  let consultProjectStatus = new Map();
  // slug → { key, repo, observedAtMs, branches: Set<runId>|null }（分支观测，至多每
  // OWNER_BRANCH_REFRESH_MS 一次；失败如实记 unknown，不沿用过期结果。key 是这一轮
  // 观测的仓库根：同一 slug 改指到另一个仓库时当作没观测过）
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
   *   读不出（stat、读、解析任一失败）的转录（含为谱系派生读取的归档转录），加上读不出
   *   或校验不过的会审组记录。
   *   并发调用共用同一次普查。中途失败则拒绝，已有索引与快照原样保留（失败不改任何
   *   字段；服务层把整份快照标为过期）。
   */
  function refresh() {
    if (inflight === null) {
      inflight = runRefresh()
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
        // 分组里——否则同一运行剩下的副本会被当成唯一可用档。身份不可知：旧根按不可信
        // 处理（它现在只可能是比它早创建的根的成员）。
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
          runId: entry.runId, bucket: entry.bucket, identity, hash, facts, roots: facts.lineageRoots, trustedRoots: true,
        });
      } catch {
        unreadable += 1;
        // 身份与上一轮相同：内容没变，旧根仍可信（读失败只让派生这一轮不推导、下轮重试）。
        const previous = fileIndex.get(entry.path);
        nextFiles.set(entry.path, unreadableEntry(entry, previous, {
          identityIntact: previous?.identity != null && sameIdentity(previous.identity, identity),
        }));
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

    // ⑤ 派生事实（都从上面刚建好的索引取，不另起全量枚举）：谱系取代（含归档面）、
    //    会审结论、项目分支。任何一步抛错都走不到下面的交接，已有索引原样保留。
    const nextKeys = collectProjectKeys();
    const readForFacts = async (path) => {
      derivedReads.add(path);
      return readFile(path);
    };
    const lineage = await deriveLineage({
      files: nextFiles,
      runs: nextRuns,
      read: readForFacts,
      previousArchiveCache: archiveLineage,
      listArchive: () => listArchiveFiles(runDir),
    });
    const consults = await collectConsults({ files: nextFiles, runs: nextRuns, keys: nextKeys, read: readForFacts });
    const branches = await observeBranches(nextRuns, nextKeys);

    fileIndex = nextFiles;
    runIndex = nextRuns;
    projectNames = nextProjectNames;
    archiveLineage = lineage.archiveCache;
    lineageDerived = lineage.derived;
    consultIndex = consults.index;
    consultProjectStatus = consults.projectStatus;
    seatQ1 = consults.seatQ1;
    branchIndex = branches;
    let derivedOnly = 0;
    for (const path of derivedReads) if (!scannedReads.has(path)) derivedOnly += 1;
    return {
      scanned: listed.length,
      reread: reread + derivedOnly,
      added,
      removed,
      moved,
      unreadable: unreadable + consults.unreadable + lineage.unreadable,
    };
  }

  async function isDirectory(path) {
    try {
      return (await statFile(path)).isDirectory();
    } catch {
      return false;
    }
  }

  /** 路径存在（目录、文件或链接目标都算）；读不出（权限等）视为不存在。 */
  async function pathExists(path) {
    try {
      await statFile(path);
      return true;
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
   * 索引）。文件集 = 活库全部转录 + 归档面里"可能是待派生根成员"的那一部分。
   *
   * 归档面为什么只读一部分：子运行一定晚于它的根创建，runId 带创建时间
   * （run_YYYYMMDD…），所以 runId 早于"最老的待派生根 − 时钟容差"的归档文件不可能是
   * 任何待派生根的成员，也不可能是那个根自己。归档枚举（listArchiveTranscriptFiles）
   * 已经对每份归档文件做过目录文件名枚举与 lstat（拒符号链接）；这里对不满足条件的
   * 文件只保留文件名、不再 stat / 不读内容，对候选文件才做 bigint stat 与原始字节解析。
   * 真实存储里 2,420 份归档通常只有个位数满足条件。候选文件与活库条目走同一套身份
   * 与解析（bigint stat + eventsOf），按文件身份缓存它们声明的根，身份没变就不重读。
   *
   * 成员按运行折叠（与 worktreeReclaim 的 byRoot 同一口径）：只要一份文件声明了该根，
   * 这个运行的全部副本（活库 + 归档）都进这条谱系的候选集、也都进签名——否则同一
   * runId 的孪生副本分属两个根时，热刷新会沿用旧答案，冷刷新给出另一个。
   *
   * 三种派生结果（只看 createLineageSupersession.forRun 的 derived 事实，不在读模型里
   * 另写判定）：得出"被取代"、得出"未被取代"都缓存；没能推导（抛错、根/成员读不出、
   * 枚举不全、拒绝等）不缓存——下一轮重试，快照里按 supersessionUndeterminable 发布，
   * 不能把一次瞬时读失败缓存成"确定未被取代"。
   *
   * 读不出/不可信的转录只影响比它早的根：从没读出过的（roots 未知）、身份变了又读不出
   * 的（旧根已不可信）、单份归档文件 lstat 失败——它们属于哪条谱系无从得知，但成员
   * 必晚于根，所以只有创建时间早于「它 + 时钟容差」的待派生根受影响。归档月目录读不出
   * 时，它可能藏着的成员最晚创建于该月末，只有创建时间不晚于「该月末 + 容差」的根受
   * 影响；整个归档根读不出则影响全部。时间序不可比（runId 形状不合）时一律按"可能"
   * 处理。容差见 RUN_CLOCK_TOLERANCE_MS。
   *
   * 刷新失败不改快照（runRefresh 抛错时调用方不交接），所以这里没有"上一轮刷新失败就
   * 全部无法判定"的门。
   */
  async function deriveLineage({ files, runs, read, previousArchiveCache, listArchive }) {
    const derived = new Map();
    const candidates = new Map(); // rootRunId → runId[]
    for (const run of runs.values()) {
      if (run.availability !== "ok" || !run.facts.supersessionCandidate || run.facts.lineageConflict) continue;
      const root = run.facts.lineageRoot;
      if (!candidates.has(root)) candidates.set(root, []);
      candidates.get(root).push(run.runId);
    }
    const roots = [...candidates.keys()].sort();
    // 没有会走到派生的运行：不必碰归档面。
    if (roots.length === 0) return { derived, archiveCache: previousArchiveCache ?? new Map(), unreadable: 0 };

    // ① 归档枚举与它的"未知面"：哪些位置读不出、各自最晚能藏住什么时刻的成员。
    let archive;
    try {
      archive = listArchive();
    } catch {
      archive = { files: [], skipped: [{ reason: "root_readdir_failed" }] };
    }
    let archiveRootUnreadable = false;
    const monthHazards = []; // 读不出的月目录的最晚成员时刻（null = 时间序不可比）
    const blindRunIds = new Set(); // 谱系归属不可信的转录
    for (const skipped of Array.isArray(archive.skipped) ? archive.skipped : []) {
      const reason = skipped?.reason;
      if (reason === "readdir_failed" && typeof skipped.dir === "string") {
        monthHazards.push(archiveMonthEndMs(basename(skipped.dir)));
        continue;
      }
      if ((reason === "lstat_failed" || reason === "symlink_not_followed") && typeof skipped.file === "string") {
        const runId = runIdFromTranscriptPath(skipped.file);
        if (runId !== null) blindRunIds.add(runId);
        else archiveRootUnreadable = true; // 名字都不是转录：不知道它是什么，整面按不可信
        continue;
      }
      // root_readdir_failed 与没见过的形状：整面不可信。
      archiveRootUnreadable = true;
    }

    // ② 归档候选：runId 不早于「最老的待派生根 − 时钟容差」的才可能是成员
    //    （相等算可能；时间序不可比 → 全算候选）。
    const rootClocks = roots.map(runCreatedAtMs);
    const oldestRootAt = rootClocks.some((at) => at === null) ? null : Math.min(...rootClocks);
    const oldestCandidateBound = oldestRootAt === null ? null : oldestRootAt - RUN_CLOCK_TOLERANCE_MS;
    const archiveCandidates = [];
    for (const raw of Array.isArray(archive.files) ? archive.files : []) {
      const path = raw?.path;
      const runId = runIdFromTranscriptPath(path);
      if (typeof path !== "string" || runId === null) continue;
      const fileAt = runCreatedAtMs(runId);
      if (oldestCandidateBound !== null && fileAt !== null && fileAt < oldestCandidateBound) continue;
      archiveCandidates.push({ path, runId });
    }

    // ③ 只读这些候选：身份 + 原始字节（身份没变就沿用上一轮解析出的根）。
    const archiveCache = new Map();
    const archiveEntries = new Map(); // path → 与活库条目同形状的派生索引条目
    let unreadable = 0;
    await eachBatch(archiveCandidates, async ({ path, runId }) => {
      let identity;
      try {
        identity = identityOf(await statFile(path));
      } catch {
        unreadable += 1;
        blindRunIds.add(runId);
        archiveEntries.set(path, { runId, identity: null, hash: null, roots: null, trustedRoots: false });
        return;
      }
      const cached = previousArchiveCache?.get(path);
      if (cached !== undefined && cached.identity !== null && sameIdentity(cached.identity, identity)) {
        archiveCache.set(path, cached);
        archiveEntries.set(path, {
          runId, identity, hash: cached.hash, roots: cached.roots, trustedRoots: cached.roots !== null,
        });
        return;
      }
      try {
        const bytes = toBytes(await read(path));
        const hash = createHash("sha256").update(bytes).digest("hex");
        const declaredRoots = lineageRootsOf(eventsOf(bytes), runId);
        archiveCache.set(path, { identity, hash, roots: declaredRoots });
        archiveEntries.set(path, { runId, identity, hash, roots: declaredRoots, trustedRoots: true });
      } catch {
        // 读/解析失败：不缓存（下一轮重读），根不可信。
        unreadable += 1;
        blindRunIds.add(runId);
        archiveEntries.set(path, { runId, identity, hash: null, roots: null, trustedRoots: false });
      }
    });

    // ④ 派生索引与按运行折叠：每轮建一次清单（不再为每条谱系重建整份文件列表）。
    //    文件名取文件自己的名字（活库与归档条目本来就是 `<runId>.jsonl`）。
    const derivationIndex = new Map();
    const derivationFiles = [];
    for (const [path, entry] of files) {
      derivationIndex.set(path, entry);
      derivationFiles.push({ name: basename(path), path });
    }
    for (const [path, entry] of archiveEntries) {
      derivationIndex.set(path, entry);
      derivationFiles.push({ name: basename(path), path });
    }
    const copies = new Map(); // runId → [{ name, path }]（同 runId 的全部副本）
    const rootsOfRun = new Map(); // rootRunId → Set<runId>（凡有一份文件声明该根的运行）
    for (const [path, entry] of derivationIndex) {
      if (!copies.has(entry.runId)) copies.set(entry.runId, []);
      copies.get(entry.runId).push({ name: basename(path), path });
      if (entry.roots === null || entry.trustedRoots !== true) blindRunIds.add(entry.runId);
      for (const root of entry.roots ?? []) {
        if (!rootsOfRun.has(root)) rootsOfRun.set(root, new Set());
        rootsOfRun.get(root).add(entry.runId);
      }
    }
    const memberFilesFor = (root) => {
      const out = [];
      for (const runId of rootsOfRun.get(root) ?? []) {
        for (const file of copies.get(runId) ?? []) out.push(file);
      }
      return out;
    };

    // ⑤ 未知面折成"最晚能属于哪条谱系"：成员必晚于根，只影响比它早的根（留时钟容差；
    //    同一毫秒算"可能"——相等不能被排除）。
    const rootHasUnknownSurface = (root) => {
      if (archiveRootUnreadable) return true;
      // 读不出的转录：创建时间早于「它 + 容差」的根可能藏在这份转录里。
      for (const blindRunId of blindRunIds) {
        if (childMayFollowRoot(blindRunId, root)) return true;
      }
      // 读不出的归档月目录：创建时间不晚于「月末 + 容差」的根可能藏着它的成员。
      if (monthHazards.length > 0) {
        const rootAt = runCreatedAtMs(root);
        if (rootAt === null) return true;
        for (const monthEnd of monthHazards) {
          if (monthEnd === null || rootAt <= monthEnd + RUN_CLOCK_TOLERANCE_MS) return true;
        }
      }
      return false;
    };

    // ⑥ 逐根派生：与派生器同一次请求共享文件清单与缓存；只有得出过结论的才缓存。
    const supersession = createLineageSupersession({
      runDir,
      readTranscriptFn: async (path) => eventsOf(toBytes(await read(path))),
      // 索引条目不带路径（路径是索引的键）：这里从键取。
      files: derivationFiles,
      memberFilesForRoot: memberFilesFor,
      // 文件清单已注入：派生器不该再枚举。真枚举了就让它失败（= 不推导），不悄悄读盘。
      enumerateFilesFn: () => {
        throw new Error("ownerReadModel: lineage derivation must use the read model's file index");
      },
    });
    await supersession.prepare(roots);
    for (const root of roots) {
      if (rootHasUnknownSurface(root)) continue; // 不推导、不缓存 → 快照按无法判定
      const signature = signatureOf(memberFilesFor(root).map((file) => file.path), derivationIndex);
      const previous = lineageDerived.get(root);
      if (previous !== undefined && previous.signature === signature) {
        derived.set(root, previous);
        continue;
      }
      const superseded = new Map();
      let complete = true;
      for (const runId of candidates.get(root)) {
        try {
          const result = await supersession.forRun({ runId });
          if (result.derived !== true) {
            complete = false; // 没能推导：不缓存，下一轮重试
            break;
          }
          superseded.set(runId, isValidRunId(result.supersededByRunId) ? result.supersededByRunId : null);
        } catch {
          complete = false;
          break;
        }
      }
      if (complete) derived.set(root, { signature, superseded });
    }
    return { derived, archiveCache, unreadable };
  }

  /** 会审索引的键：按 (项目 slug, consultId) 建键——同一 consultId 出现在两个项目时互不覆盖。 */
  const consultKey = (slug, consultId) => `${slug}\u0000${consultId}`;

  /**
   * 会审结论：逐个项目列 <key>/.wao/runs/consults/。组记录按文件身份缓存；缓存里只留
   * 快照需要的字段（投影输入 spec + 算好的 value），不常驻整份组记录，也不常驻席位
   * 回答原文。记录没变时仍要按本轮的运行索引重算席位状态与 Q1——席位转录可能变了；
   * Q1 按"席位转录身份 + 记录声明的 Q1 候选"缓存，命中就不重读。条目记下读取时的
   * key：slug 改指新 key 后，旧 key 的条目不再保留。
   *
   * 读不出时不静默消失：目录列不出 → 保留该项目上一轮的全部条目（同一个 key）、项目行
   * 标 consultRecords: "unknown"；单份记录 stat/读取 I/O 失败 → 保留该记录上一轮的条目、
   * 项目行也标 "unknown"；都计入 unreadable。坏记录（JSON 坏、consultId 与文件名不符）
   * 照旧计 unreadable 并跳过、不保留（内容读到了，只是坏）。读取失败不缓存。
   */
  async function collectConsults({ files, runs, keys, read }) {
    const index = new Map();
    const projectStatus = new Map();
    const nextSeatQ1 = new Map();
    let unreadable = 0;
    await eachBatch([...keys], async ([slug, key]) => {
      // 只保留同一个 key 下读出的条目：slug 改指到新 key 后，旧 key 的条目属于别的仓库。
      const keepPreviousProject = () => {
        const prefix = `${slug}\u0000`;
        for (const [entryKey, entry] of consultIndex) {
          if (entryKey.startsWith(prefix) && entry.key === key) index.set(entryKey, entry);
        }
      };
      const keepPreviousRecord = (consultId) => {
        const previous = consultIndex.get(consultKey(slug, consultId));
        if (previous !== undefined && previous.key === key) index.set(consultKey(slug, consultId), previous);
      };
      if (key === null) {
        // 两个 key 指向同一个 slug：说不清是哪个仓库，没有可列的会审目录——定位不了
        // 就不是"目录列出成功"，项目行的会审可用性如实为 unknown。
        projectStatus.set(slug, "unknown");
        return;
      }
      let keyIsDirectory;
      try {
        keyIsDirectory = (await statFile(key)).isDirectory();
      } catch (error) {
        if (error?.code === "ENOENT") {
          projectStatus.set(slug, "available"); // 项目目录不存在：没有会审记录可列
        } else {
          unreadable += 1;
          projectStatus.set(slug, "unknown");
          keepPreviousProject();
        }
        return;
      }
      if (!keyIsDirectory) {
        projectStatus.set(slug, "available");
        return;
      }
      const dir = join(key, ".wao", "runs", "consults");
      let names;
      try {
        names = await listDir(dir);
      } catch (error) {
        // 没有这个目录 = 这个项目还没开过会审；其余读不出（权限等）时保留上一轮的条目。
        if (error?.code === "ENOENT") {
          projectStatus.set(slug, "available");
        } else {
          unreadable += 1;
          projectStatus.set(slug, "unknown");
          keepPreviousProject();
        }
        return;
      }
      projectStatus.set(slug, "available");
      for (const name of Array.isArray(names) ? names : []) {
        if (typeof name !== "string" || !name.endsWith(".json")) continue;
        const consultId = name.slice(0, -".json".length);
        if (!isValidConsultId(consultId)) continue;
        const path = join(dir, name);
        const entryKey = consultKey(slug, consultId);
        let identity;
        try {
          identity = identityOf(await statFile(path));
        } catch (error) {
          if (error?.code === "ENOENT") continue; // 枚举之后被删：不是"读不出"
          unreadable += 1;
          projectStatus.set(slug, "unknown"); // 这一轮的记录没读全：项目行的会审可用性按 unknown
          keepPreviousRecord(consultId);
          continue;
        }
        const previous = consultIndex.get(entryKey);
        let spec;
        if (previous !== undefined && sameIdentity(previous.identity, identity)) {
          spec = previous.spec; // 记录没变：不重读，只按本轮的运行索引重算与席位有关的部分
        } else {
          // 读取与校验走 loadConsultRecord（consultId 形状、记录里的 consultId 与文件名
          // 一致、JSON 可解析）。这里区分"读不出"（I/O 失败：保留上一轮、下轮重读）与
          // "记录本身坏了"（照旧跳过、不保留）；读到半截内容不等，这一轮按坏记录计。
          // 组记录不是转录，不计进 reread。
          let readError = null;
          let record;
          try {
            record = await loadConsultRecord({
              consultId,
              consultsDir: dir,
              readFileFn: async () => {
                try {
                  return toBytes(await readFile(path)).toString("utf8");
                } catch (error) {
                  readError = error;
                  throw error;
                }
              },
              sleepFn: async () => {},
            });
          } catch (error) {
            if (readError?.code === "ENOENT" || error?.code === "ENOENT") continue; // 记录没了
            unreadable += 1;
            if (readError !== null) {
              // I/O 失败（不是坏记录）：保留上一轮条目，项目行的会审可用性按 unknown。
              projectStatus.set(slug, "unknown");
              keepPreviousRecord(consultId);
            }
            continue; // 坏记录：不保留
          }
          spec = consultSpec(consultId, record);
        }
        const seats = locateSpecSeats(spec, runs);
        index.set(entryKey, {
          key, identity, spec, value: await consultValue(slug, spec, seats, runs, files, read, nextSeatQ1),
        });
      }
    });
    // 席位 Q1 缓存只有这一轮用到的席位（nextSeatQ1 每轮新建，只装本轮算过/命中的）。
    return { index, projectStatus, seatQ1: nextSeatQ1, unreadable };
  }

  /**
   * 组记录的投影输入：只留快照需要的字段（创建时间、被审运行、Q1 候选、席位的身份与
   * 记录里的状态观察）。任务书路径、视角片段、席位回答等都不留在内存里。
   */
  function consultSpec(consultId, record) {
    const declared = record.declaredFields;
    const seats = Array.isArray(record.seats)
      ? record.seats.filter((seat) => seat !== null && typeof seat === "object" && !Array.isArray(seat))
      : [];
    return {
      consultId,
      createdAt: iso(tsMs(record.createdAt)),
      reviewedRunId: isValidRunId(record.reviewedRunId) ? record.reviewedRunId : null,
      // 记录的 Q1 候选原样保留（compareFields 用它们取值）；是不是"结论题"由闭集判。
      q1Candidates: Array.isArray(declared?.Q1)
        ? declared.Q1.filter((value) => typeof value === "string")
        : null,
      seats: seats.map((seat) => ({
        agentId: isValidCanonicalAgentId(seat.agentId) ? seat.agentId : null,
        runId: isValidRunId(seat.runId) ? seat.runId : null,
        // 记录点名了一个 run（哪怕 runId 不合形状）：找不到就按 missing 给，不拿记录里的旧观察顶。
        claimsRun: typeof seat.runId === "string" && seat.runId.length > 0,
        recordedState: memberOf(SEAT_RUN_STATES, seat.runState),
      })),
    };
  }

  /**
   * 记录里的席位与它们在本运行目录里的定位。定位走 resolveRun 同一份逻辑（只认本
   * 运行目录的枚举结果）。
   */
  function locateSpecSeats(spec, runs) {
    return spec.seats.map((seat) => ({
      ...seat,
      located: seat.runId === null ? null : locateIn(runs, seat.runId),
    }));
  }

  /**
   * 一场会审的结论事实。Q1 按决定 0128 重算：取文与 observeSeatRun 同一个
   * extractFinalAssistantText，归组与取值用 attributeReply / compareFields（声明用
   * 记录里的 Q1 候选原样）。只有记录声明了 Q1、且候选值里有闭集结论值时才算，取到的
   * 值也必须是闭集成员——记录是磁盘上可手改的，别的字符串不进快照。
   */
  async function consultValue(projectSlug, spec, seats, runs, files, read, nextSeatQ1) {
    const q1Declared = Array.isArray(spec.q1Candidates)
      && spec.q1Candidates.some((value) => OWNER_CONSULT_Q1_VALUES.includes(value));
    const q1 = q1Declared
      ? { candidates: spec.q1Candidates, key: JSON.stringify([...new Set(spec.q1Candidates)].sort()) }
      : null;
    const rows = [];
    for (const seat of seats) {
      let runState = seat.claimsRun ? "missing" : seat.recordedState;
      let q1Value = null;
      if (seat.located !== null && seat.located.availability === "ok") {
        const run = runs.get(seat.runId);
        runState = run === undefined ? "unknown" : run.facts.state;
        if (q1 !== null && seat.agentId !== null) {
          const answer = await seatQ1Of({ seat, q1, files, read, nextSeatQ1 });
          // 席位转录这一轮读不出：与 rerenderConsultFromRecord 同一口径——这一席按
          // missing 给，且不缓存（下一轮重读）。
          if (!answer.readable) runState = "missing";
          else q1Value = answer.q1;
        }
      }
      rows.push({ agentId: seat.agentId, runId: seat.runId, runState, q1: q1Value });
    }
    return {
      consultId: spec.consultId,
      projectSlug,
      createdAt: spec.createdAt,
      reviewedRunId: spec.reviewedRunId,
      q1Declared,
      seats: rows,
    };
  }

  /**
   * 席位的 Q1 值（取文与 observeSeatRun 同一个函数）。只缓存算出来的 Q1：键是席位
   * 转录的文件身份（签名）+ 记录声明的 Q1 候选；读失败不缓存，下一轮重读。回答原文
   * 不留在内存里。
   */
  async function seatQ1Of({ seat, q1, files, read, nextSeatQ1 }) {
    const path = seat.located.transcriptPath;
    const signature = signatureOf([path], files);
    // 先看这一轮刚算出的（同一席出现在几场会审里时只读一次），再看上一轮留下的缓存。
    const cached = nextSeatQ1.get(path) ?? seatQ1.get(path);
    if (cached !== undefined && cached.signature === signature && cached.q1Key === q1.key) {
      nextSeatQ1.set(path, cached);
      return { readable: true, q1: cached.q1 };
    }
    let text;
    try {
      text = await extractFinalAssistantText(eventsOf(toBytes(await read(path))), { runId: seat.runId, env: {} });
    } catch {
      return { readable: false, q1: null };
    }
    const { fieldValues } = compareFields({ seat: attributeReply(text) }, { Q1: q1.candidates });
    const value = memberOf(OWNER_CONSULT_Q1_VALUES, fieldValues.Q1?.seat);
    nextSeatQ1.set(path, { signature, q1Key: q1.key, q1: value });
    return { readable: true, q1: value };
  }

  /**
   * 分支观测：只对至少有一个请求了交付的运行的项目做，每个项目至多每
   * OWNER_BRANCH_REFRESH_MS 一次（不论成败）；各项目并行枚举（异步执行器下整轮最长
   * 约等于单次超时）。仓库根不存在、不是目录、或 git 失败都如实记 unknown——不拿上一次
   * 的结果冒充这一轮的观测。项目没有仓库事实（没有 key，或 多个 key 指向同一个 slug）
   * 时丢掉旧观测；不再有交付运行的项目，只要 key 没变就留着最后一次观测，但 key 已变 /
   * 已没了 / 已变成 null（或 key 目录不再存在）时丢掉——旧观测属于别的仓库或已不可观测。
   * 观测按 (slug, key) 有效：同一 slug 的 key 换成了另一个仓库时，旧观测作废、立刻重新
   * 观测。只认 key 自己的仓库：没有 `<key>/.git` 的目录（顶层 key、非仓库、仓库子目录、
   * 指向仓库子目录的 junction）按 unknown，不调 git；GIT_CEILING_DIRECTORIES 仍保留，
   * 防空的 .git 目录向上发现祖先仓库。
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
    await Promise.all([...wanted].map(async (slug) => {
      const key = keys.get(slug);
      if (key === undefined || key === null) {
        next.delete(slug);
        return;
      }
      const previous = next.get(slug);
      // key 变了 = 换成另一个仓库：当作没观测过（旧集合与旧时刻都不能用）。
      if (previous !== undefined && previous.key === key && now !== null && previous.observedAtMs !== null
        && previous.observedAtMs <= now && now - previous.observedAtMs < OWNER_BRANCH_REFRESH_MS) {
        return;
      }
      // 仓库根不存在或不是目录、或不是它自己的仓库（没有 <key>/.git）：没有可观测的分支，
      // 不记观测时刻（下一轮再看——stat 很便宜，目录一出现就能观测到）。
      if (!(await isDirectory(key)) || !(await pathExists(join(key, ".git")))) {
        next.set(slug, { key, repo: "unknown", observedAtMs: null, branches: null });
        return;
      }
      let branches = null;
      try {
        branches = new Set(await listRunBranchRunIds(execGit, key));
      } catch {
        branches = null;
      }
      next.set(slug, { key, repo: branches === null ? "unknown" : "available", observedAtMs: now, branches });
    }));
    // F4：不再有交付运行的项目——key 变了或 key 已没了/变成 null/key 目录或它自己的
    // 仓库不再存在时，旧观测属于别的仓库或已不可观测，必须丢掉；key 没变、仓库仍在
    // 才留着最后一次观测。
    for (const slug of [...next.keys()]) {
      if (wanted.has(slug)) continue;
      const key = keys.get(slug);
      if (key === undefined || key === null || next.get(slug)?.key !== key) {
        next.delete(slug);
        continue;
      }
      if (!(await isDirectory(key)) || !(await pathExists(join(key, ".git")))) next.delete(slug);
    }
    return next;
  }

  /**
   * 发布一份快照：用同一个 now 现算每个运行的活性与阶段时效，并当场读心跳租约。
   * 快照里没有任何仓库路径、工作树路径、cwd、转录路径或会审记录路径；项目只给
   * slug、名字、仓库是否可观测、分支观测时刻与会审记录是否可列。
   * 快照里的每个对象都是这次新建的：调用方改动返回值不会污染缓存。
   *
   * @param {{now?: number}} [options] — 缺省取 nowFn()；必须是可表示的 epoch ms
   *   （有限且在 Date 范围内），否则抛 TypeError
   * @returns {{generatedAt: string,
   *   projects: Array<{slug: string, name: string|null, repo: string,
   *     branchesObservedAt: string|null, consultRecords: string}>,
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
          consultRecords: consultProjectStatus.get(slug) === "unknown" ? "unknown" : "available",
        };
      }),
      runs,
      consults: [...consultIndex.values()]
        .map((entry) => projectConsult(entry.value))
        .sort(byConsultCreatedAt),
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

    // "被取代"能不能下结论：只有会走到派生的运行才需要一条得出过结论的派生（派生缓存
    // 里没有 = 这一轮没能推导：盲转录、枚举不全、成员读不出等）。它只管"被取代"一项；
    // legalDecision 只看本运行自己的转录。
    const derivedForRoot = ok && f.lineageRoot !== null ? lineageDerived.get(f.lineageRoot) : undefined;
    const supersessionUndeterminable = ok && f.supersessionCandidate === true && !f.lineageConflict
      && derivedForRoot?.superseded.has(run.runId) !== true;
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
      // 失败与额度：只在状态为 failed 时有。每次快照新建对象，不交出缓存里的那个。
      failure: f === null || f.failure === null ? null : { category: f.failure.category, code: f.failure.code },
      capacity: f === null || f.capacity === null ? null : { code: f.capacity.code, observedAt: iso(f.capacity.observedAtMs) },
      lineageRootRunId: f?.lineageRoot ?? null,
      lineageRootConflict: f?.lineageConflict ?? null,
      supersessionUndeterminable: ok ? supersessionUndeterminable : null,
      legalDecision: f?.legalDecision ?? null,
      supersededByRunId: derivedForRoot?.superseded.get(run.runId) ?? null,
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

  return { refresh, snapshot, resolveRun };
}
