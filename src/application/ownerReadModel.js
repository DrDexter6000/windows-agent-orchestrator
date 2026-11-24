// src/application/ownerReadModel.js
//
// 决定 0131 §5–§7（第 140a 批）：Owner 看板的共享读模型——每个运行目录一个、跨
// 全部项目、只在内存。本批只做读模型与派发端的类型固化；HTTP 接口、前端与 MCP
// schema 不在这里。
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
// 架构契约：不 import src/commands/*、src/mcp/*、MCP SDK 或 zod。

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";

import { listProjectRecords, listTranscriptsDeep, SAFE_BUCKET_SLUG_RE } from "../projectBuckets.js";
import {
  findFirstBound,
  findLatestBound,
  findStateEvidence,
  inheritableOwnerTaskType,
  isPersistableOwnerTaskType,
  OWNER_TASK_TYPES,
  parseTranscriptText,
  RUN_STATES,
  TERMINAL_STATES,
} from "../transcript.js";
import { isValidRunId } from "../delivery.js";
import { boundReportScope } from "../metrics.js";
import { redactSecretShapes } from "../secretRedaction.js";
import { ID_RE, isValidCanonicalAgentId } from "../canonicalAgentId.js";
import { RUNTIME_ACTIVITY_STATUSES } from "../runEvent.js";
import { projectExecutionStage } from "./runStageProjection.js";
import { lastActualEffectAtMs, lastEffectAtMs, lastVitalSignAtMs } from "./runQuietAdvisory.js";
import { readOwnerLease } from "./ownerLiveness.js";
import { deliveryWasRequested } from "./runSettlement.js";

// 闭集 SSOT 在 src/transcript.js（写入侧 runManager 也要引用它）；这里转出，读模型的
// 消费方不必再绕去转录模块。
export { OWNER_TASK_TYPES };

/** 实质动作的时效窗：lastEffectAt 在这么多秒内算 progress。 */
export const OWNER_PROGRESS_WINDOW_SECONDS = 300;
/** 进程体征的时效窗：runtime_activity 或心跳租约在这么多秒内算 process_only。 */
export const OWNER_PROCESS_WINDOW_SECONDS = 120;
/** 标题与项目名的字符帽（超长时帽含省略号）。 */
export const OWNER_TITLE_MAX_CHARS = 80;

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
  return {
    factSlug: factSlugOf(first?.project),
    agentId: isValidCanonicalAgentId(agentId) ? agentId : null,
    laneId: safeId(started?.laneId),
    roleId: ownerRoleId(started),
    readOnly: scope.some((e) => e.type === "run.read_only_declared"),
    deliveryRequested: deliveryWasRequested(events, runId),
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
  };
}

const toBytes = (raw) => (Buffer.isBuffer(raw) ? raw : Buffer.from(raw));

/**
 * 一份转录的原始字节 → 事实。只解析到最后一个换行为止（保留那个 LF）：其后没有
 * 换行结尾的尾部片段是还没写完的半行，忽略（写完后文件身份变化，下一轮会重读）。
 * LF 必须保留——CRLF 转录里把最后的 LF 切掉会留下一个孤立的 \r，完整的前缀
 * 反而被判读不到。完整行里有坏 JSON、一个完整行都没有、或出现非对象行 → 抛出，
 * 调用方按读不到处理。
 */
function factsOf(bytes, runId) {
  const end = bytes.lastIndexOf(0x0a);
  if (end < 0) throw new Error("ownerReadModel: transcript has no complete line");
  const events = parseTranscriptText(bytes.subarray(0, end + 1).toString("utf8"));
  if (events.length === 0 || events.some((e) => e === null || typeof e !== "object" || Array.isArray(e))) {
    throw new Error("ownerReadModel: transcript has no readable events");
  }
  return extractFacts(events, runId);
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
 *   `stat(path)` → bigint stat、`listFiles(runDir, { strict })`
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

  // path → { runId, bucket, identity: {size, mtimeNs, ctimeNs, ino}|null, hash, facts }
  //（identity 为 null 或 hash / facts 为 null = 那一次读不到，下轮重试）
  let fileIndex = new Map();
  // runId → { runId, availability, primaryPath, primaryBucket, locations, facts }
  let runIndex = new Map();
  // slug → 项目名（null = 没有名字）
  let projectNames = new Map();
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
   *   scanned = 本次枚举到的 run 转录数；reread = 本次实际读取内容的文件数；
   *   added / removed = 新出现 / 消失的运行数（按 runId）；moved = 换了位置、旧位置
   *   一个不剩的运行数；unreadable = 本次读不出（stat、读、解析任一失败）的文件数。
   *   并发调用共用同一次普查。中途失败则拒绝，已有索引与快照原样保留。
   */
  function refresh() {
    if (inflight === null) {
      inflight = runRefresh().finally(() => {
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
        nextFiles.set(entry.path, { runId: entry.runId, bucket: entry.bucket, identity: null, hash: null, facts: null });
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
        const hash = createHash("sha256").update(bytes).digest("hex");
        const twin = earlier
          .map((path) => nextFiles.get(path))
          .find((record) => record !== undefined && record.hash === hash && record.facts !== null);
        const facts = twin !== undefined ? twin.facts : factsOf(bytes, entry.runId);
        nextFiles.set(entry.path, { runId: entry.runId, bucket: entry.bucket, identity, hash, facts });
      } catch {
        unreadable += 1;
        nextFiles.set(entry.path, { runId: entry.runId, bucket: entry.bucket, identity: null, hash: null, facts: null });
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

    fileIndex = nextFiles;
    runIndex = nextRuns;
    projectNames = nextProjectNames;
    return {
      scanned: listed.length,
      reread,
      added,
      removed,
      moved,
      unreadable,
    };
  }

  /**
   * 发布一份快照：用同一个 now 现算每个运行的活性与阶段时效，并当场读心跳租约。
   * 快照里没有任何仓库路径、工作树路径、cwd 或转录路径。
   *
   * @param {{now?: number}} [options] — 缺省取 nowFn()；必须是可表示的 epoch ms
   *   （有限且在 Date 范围内），否则抛 TypeError
   * @returns {{generatedAt: string, projects: Array<{slug: string, name: string|null}>, runs: object[]}}
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
      projects: [...slugs].sort().map((slug) => ({ slug, name: projectNames.get(slug) ?? null })),
      runs,
    };
  }

  function projectRun(run, now) {
    const ok = run.availability === "ok";
    const f = ok ? run.facts : null;
    // conflict 时两处可能属于不同项目：不选。读不到时位置事实仍可用。
    const slug = run.availability === "conflict"
      ? null
      : (f !== null ? f.factSlug ?? safeSlug(run.primaryBucket) : safeSlug(run.primaryBucket));
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
    if (!isValidRunId(runId)) return null;
    const run = runIndex.get(runId);
    if (run === undefined) return null;
    const singleUnreadable = run.availability === "unreadable" && run.locations.length === 1;
    if (run.availability !== "ok" && !singleUnreadable) return null;
    return { runId, availability: run.availability, transcriptPath: run.primaryPath, bucket: run.primaryBucket };
  }

  return { refresh, snapshot, resolveRun };
}
