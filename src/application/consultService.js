// src/application/consultService.js
//
// M13-r1（决定 0039 契约 v0.2 的 r1 切片，CLI only）：多席只读会审
// （Agent Union consult）的共享 application service。
//
// 定位：把 Lead 手搓的"写共享任务书→拼席位尾巴→逐席派发→抠日志→人工对比"
// 产品化为一个动作——机械扇出 + 收集 + council-diff 并列呈现。
// 不做语义合成、不自动重发、不摘要不截断（0039 契约红线）。
//
// 纯函数内核（全部确定性、无 IO）：
//   - parseBriefQuestions(briefText)   从 brief 提取编号问题锚点（Q1..Qn）
//   - attributeReply(replyText)        席位最终回复按同一锚点规则归组
//   - compareFields(perSeat, declared) 闭集声明字段值的字面提取与"字段值不同"标记
//   - deriveSeatStates({...})          每席两维状态（runState × formatState，独立）
//
// 编排函数 runConsult({...deps})：
//   逐席 dispatchRun(readOnly:true) → 轮询各 run transcript 至终态或总预算
//   → 每席取最终 assistant 文本（只读投影，runCollectProjection compact 路径的
//   等价实现但无 4000 字上限——0039 零截断红线）→ 组装 council-diff 事实
//   → 持久写组记录（.wao/runs/consults/<consultId>.json，席位-runId 映射
//   = 意见-决策回链锚点）。
//
// 只读重渲染 rerenderConsultFromRecord({...deps})（M13-r2；0051 修订）：
//   从组记录回读各席位 transcript 重建全量结果对象（CLI consult show 全量渲染；
//   MCP run_consult 读取模式在本内核之上加回执/分页投影层——面合同见决定
//   0051，内核形状不变）——零派发（不持有 dispatch 通道）。
//
// 三条不变式（0039 §2.2，红绿测试钉住于 test/run-lifecycle/consult.test.js）：
//   ① 零信息损失——attributeReply 输出的 preamble+ordered+unclassified 三块
//     按序拼接逐字节等于输入文本；只分组、不摘要、不截断、不重排隐藏。
//   ② 标记即提示——compareFields 对闭集不同值仅产生 fieldDiff 标记，
//     永不输出"一致/分歧/agree/disagree"类结论词。
//   ③ malformed 零自动重发——席位未结构化只是观察事实（formatState），收集
//     阶段不触发任何再次派发。
//
// Architectural contract:
//   - No argv parsing, no console.log, no process.exit.
//   - Does not import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - 结构上不得 import runDelivery*/delivery 写面（不新增 delivery 事件或
//     运行终态；防 metrics 聚合重复计数；永不写认证台账）——测试钉住。
//   - 组记录不写 runs/（防 metrics 聚合双计）；席位子 run 本身是普通只读 run，
//     transcript 落 runDir 由 dispatchRun 拥有。
//   - 依赖（全部可注入，参照 runDispatch/runWait 的 DI 风格）：dispatchRun、
//     readRegistry、readTranscript、fs、时钟、随机后缀。

import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";

import { readTranscript, findState, TERMINAL_STATES, extractCanonicalAgentId, transcriptPathFor } from "../transcript.js";
import { resolveTranscriptPath } from "../projectBuckets.js";
// 第 155 批（TD-385）：会审轮次与第 3 轮起的提醒（只提醒，不阻止）；算法的唯一定义处。
import {
  CONSULT_ROUND_ADVISORY,
  ConsultFollowsRefusalError,
  consultRoundFacts,
  consultRoundOfRecord,
  resolveNewConsultRound,
} from "./consultRound.js";
export { CONSULT_ROUND_ADVISORY, ConsultFollowsRefusalError };
// 决定 0055 判定权威（2026-10-10 kimi 诊断批引入；2026-11-03 改接只读观察投影）：
// 席位写入证据不再自数 transcript 事件，复用只读观察投影的工作树内写入事实。
import { projectReadOnlyObservation } from "./runReadOnlyObservation.js";
// 决定 0096：有未终态席位时回执带 MCP 面 nextStep（模板与长度上限的家在
// runNextStep.js，本模块只提供席位判定并转交）。
import { buildNextStep } from "./runNextStep.js";
// 第 156 批：会审结果带 label（[席位A+席位B] 任务书标题——与 Owner 看板同一取
// 法）与 laneRules（Owner 规则原文 + 此刻高峰快照；CLI 面经 advisorySink 打
// stderr 的那几行也来自同一构造/渲染）。画像只经 laneProfile 的投影——本模块
// 不直接引用 laneProfile（依赖边由 test/registry-roles/laneTraits.test.js 钉：
// laneRules/laneFactsLine ← 本模块）。
import { buildLaneRules, degradedLaneRules, renderLaneRulesLines } from "./laneRules.js";
import { buildConsultLabel } from "./dispatchLabel.js";
import { laneFactsLine } from "./laneFactsLine.js";

function listRoleLibrarySync() { return listRoleLibrary(); }


import { readRegistry } from "../registry.js";
import { boundReportScope } from "../metrics.js";
import { createSecretRedactor } from "../secretRedaction.js";
import { dispatchRun } from "./runDispatch.js";
import { loadLanesConfig, resolveDispatchTarget, listRoleLibrary, laneDispatchHold, dispatchHoldAdvisoryLine } from "../dispatchResolution.js";
import { deriveStartedIdentity, laneFingerprint } from "./identityProjection.js";
// R9（决定 0023）：modelFamily 是展示闭集模块，本文件（dispatch/delivery 控制
// 面路径）不得 import——三块砖①厂族改为 registry 原始字段直读（seatRuntimeFacts）。
// 决定 0095：本模块不再引用 RUN_WAIT_*（run_wait 的下限已随 MCP 面降到 30000，
// consult 的 CLI 等待域保持 180000..600000，见下方显式常量）。

// ===== 锚点规则（brief 解析与席位回复归组共用同一 SSOT）=====
//
// 行首编号问题锚点，两条确定性规则（0039 r1 任务书）：
//   ① Markdown 标题形：/^#{1,3}\s*Q(\d+)\b(?:\*\*)?\s*[.::：]?/
//      —— "## Q1 这个方案可行吗"；0128 续修：可选 ** + 分隔符（. : ：），
//      "## Q1: PASS" 的分隔符不再把值顶开（尾部全可选，锚点判定面不变）。
//   ② 裸编号形：      /^Q(\d+)\s*[.::：]/      —— "Q1: ..." / "Q1：" / "Q1."；
//      行首可带加粗标记 **（"**Q1：…**" / "**Q1**：…"）——席位常把结论行整行加粗
// 不做模糊匹配、不做句子级切分（切错比不切更糟，0039 §2.2 收集规则）。
const ANCHOR_PATTERNS = [
  /^#{1,3}\s*Q(\d+)\b(?:\*\*)?\s*[.::：]?/,
  /^(?:\*\*)?Q(\d+)(?:\*\*)?\s*[.::：]/,
];

/** 匹配一行是否为编号问题锚点；返回 Q 号（整数）或 null。 */
function matchAnchorLine(line) {
  for (const re of ANCHOR_PATTERNS) {
    const m = re.exec(line);
    if (m) {
      const q = Number(m[1]);
      if (Number.isInteger(q) && q > 0) return q;
    }
  }
  return null;
}

/**
 * 从 brief 提取编号问题锚点（纯函数）。按文档出现顺序返回 [{q, heading}]；
 * heading = 锚点行原文（trim）。重复 Q 号保留首次出现（brief 是 Lead 手写物，
 * 重复属笔误；确定性规则：首见胜出）。
 * @param {string} briefText
 * @returns {Array<{q: number, heading: string}>}
 */
export function parseBriefQuestions(briefText) {
  const text = typeof briefText === "string" ? briefText : "";
  const seen = new Set();
  const questions = [];
  for (const line of text.split("\n")) {
    const q = matchAnchorLine(line);
    if (q === null || seen.has(q)) continue;
    seen.add(q);
    questions.push({ q, heading: line.trim() });
  }
  return questions;
}

/**
 * 把席位最终回复按同一锚点规则归组到 Qn（纯函数，不变式①的实现基础）。
 *
 * 归组规则（确定性）：锚点行开启一个块，块延伸到下一锚点行之前（最后一块到
 * 文本末尾）——块内整段保留，禁止句子级切分。ordered 按文档顺序排列；同一
 * Q 号重复出现时产生多个有序条目（不合并、不重排——合并会破坏逐字节平铺）。
 * 首个锚点之前的内容进 preamble；无锚点时全文进 unclassified（纯散文整段
 * 兜底，0039 半结构化规则的"未切"一侧）。
 *
 * 不变式①（测试钉住）：preamble + ordered.map(e => e.text).join("") +
 * unclassified === replyText（逐字节）。
 *
 * @param {string} replyText
 * @returns {{ordered: Array<{q: number, text: string}>, unclassified: string, preamble: string}}
 */
export function attributeReply(replyText) {
  const text = typeof replyText === "string" ? replyText : "";
  // 用字符偏移扫描锚点行（不重建字符串——字节级精确）。
  const anchors = [];
  let pos = 0;
  for (const line of text.split("\n")) {
    const q = matchAnchorLine(line);
    if (q !== null) anchors.push({ q, start: pos });
    pos += line.length + 1; // +1 = 被split吃掉的"\n"
  }
  if (anchors.length === 0) {
    return { ordered: [], unclassified: text, preamble: "" };
  }
  const preamble = text.slice(0, anchors[0].start);
  const ordered = [];
  for (let i = 0; i < anchors.length; i += 1) {
    const end = i + 1 < anchors.length ? anchors[i + 1].start : text.length;
    ordered.push({ q: anchors[i].q, text: text.slice(anchors[i].start, end) });
  }
  return { ordered, unclassified: "", preamble };
}

/**
 * 闭集声明字段值的字面提取 + "字段值不同"标记（纯函数，不变式②；决定 0128
 * 第 2 条收紧提取口径）。
 *
 * declaredFields 形如 {"Q1":["A","B"]}（Lead 声明的闭集候选值）。字段值提取 =
 * 该席 Qn 的每个归组块各按**紧跟规则**取一个值：值必须紧跟该块 Qn 锚点（冒号
 * 形的分隔符已被锚点匹配吃掉；中间只允许空白含换行、** 与反引号；标题形
 * ## Q1 同规则、值允许换行后紧跟），然后按整词匹配声明值（大小写敏感、前后
 * 不紧邻文字/数字/下划线/连字符；同位置取最长的声明值；不猜）。不紧跟 = 该块记未
 * 填——"Q1: 不是 PASS，应为 FIX_FIRST"不再被取成 PASS。同一 Qn 多块取到的
 * 非空值全都相同就是这个值，有不同 = 未填（null）——自相矛盾不再取第一个块。
 * fieldDiff 只在"≥2 席有值 且 值不全同"时收该 Qn——标记即提示，本函数及其
 * 输出永不携带"一致/分歧/agree/disagree"类结论词（测试钉住）。
 *
 * @param {Record<string, {ordered: Array<{q:number,text:string}>, unclassified: string, preamble: string}>} perSeatAttribution
 *   席位 agentId → attributeReply 输出。
 * @param {Record<string, string[]>} declaredFields
 * @returns {{fieldDiff: string[], fieldValues: Record<string, Record<string, string|null>>}}
 *   fieldValues[Qn][agentId] = 提取值或 null（未填）。
 */
export function compareFields(perSeatAttribution, declaredFields) {
  const seats = perSeatAttribution && typeof perSeatAttribution === "object"
    ? Object.keys(perSeatAttribution)
    : [];
  const declared = declaredFields && typeof declaredFields === "object"
    ? declaredFields
    : {};
  const fieldValues = {};
  const fieldDiff = [];
  for (const key of Object.keys(declared)) {
    if (!/^Q\d+$/.test(key)) continue;
    const qn = Number(key.slice(1));
    const candidates = Array.isArray(declared[key])
      ? declared[key].filter((v) => typeof v === "string" && v.length > 0)
      : [];
    if (candidates.length === 0) continue;
    const perSeat = {};
    for (const seat of seats) {
      perSeat[seat] = firstLiteralMatch(perSeatAttribution[seat], qn, candidates);
    }
    fieldValues[key] = perSeat;
    const filled = Object.values(perSeat).filter((v) => v !== null);
    if (filled.length >= 2 && new Set(filled).size > 1) {
      fieldDiff.push(key);
    }
  }
  return { fieldDiff, fieldValues };
}

// 紧跟桥接（决定 0128）：锚点与值之间只允许空白（含换行）、*（覆盖 **）与反引号。
const ANCHOR_VALUE_BRIDGE_RE = /^[\s*`]+/;

/** 取 text[index] 起的完整字符（按码点，代理对不拆；越界返回 ""）。 */
function charAt(text, index) {
  const code = text.codePointAt(index);
  return code === undefined ? "" : String.fromCodePoint(code);
}

/** at 前紧邻的完整字符（at-1 落在代理对后半时回退一格，取整个星面字符）。 */
function charBefore(text, at) {
  if (at <= 0) return "";
  let i = at - 1;
  const c = text.charCodeAt(i);
  if (c >= 0xdc00 && c <= 0xdfff && i > 0) i -= 1;
  return charAt(text, i);
}

/** text 在 at 处以整词开始 value：前缀匹配且前后紧邻的完整字符（按码点取，
 * 代理对不拆——PASS𝟙 的 𝟙 是一个码点）都不在共用字符类里（字母任何文字/
 * 数字/_/-，与候选值白名单同一处定义）——声明值 `MERGE` 不会命中
 * `MERGE_AFTER_FIXES` 的前缀；只声明 `PASS` 时 `PASSé`、`PASS𝟙`、
 * `PASS-WITH-NOTES`、`通过理由` 都记未填。中文因此也有边界；标点、空白、
 * 行首行尾都是边界。 */
function wholeTokenAt(text, at, value) {
  if (!text.startsWith(value, at)) return false;
  return !WORD_CHAR.test(charBefore(text, at)) && !WORD_CHAR.test(charAt(text, at + value.length));
}

/**
 * 一个归组块按紧跟规则取值（决定 0128 第 2 条）。块文本以锚点行开头，直接用
 * ANCHOR_PATTERNS 匹配锚点行（两形的分隔符 [.::：] 连同其前置 ** 都已被锚点
 * 匹配吃掉——标题形 0128 续修起也吃可选分隔符，"## Q1: PASS" 不再把值顶开）；
 * 锚点之后先吃桥接（空白含换行、*、反引号——标题形的值允许换行后紧跟），再在
 * 该位置按整词匹配声明值，同位置取最长（`PASS-WITH-NOTES` 胜过它的前缀
 * `PASS`）。桥接之后第一个词不是声明值 → null（不再在块内任意位置找首个命中）。
 */
function valueAfterAnchor(entry, candidates) {
  const text = String(entry?.text ?? "");
  const nl = text.indexOf("\n");
  const line = nl === -1 ? text : text.slice(0, nl);
  for (const re of ANCHOR_PATTERNS) {
    const m = re.exec(line);
    if (!m) continue;
    let at = m[0].length;
    at += ANCHOR_VALUE_BRIDGE_RE.exec(text.slice(at))?.[0].length ?? 0;
    for (const value of [...candidates].sort((a, b) => b.length - a.length)) {
      if (wholeTokenAt(text, at, value)) return value;
    }
    return null;
  }
  return null;
}

/**
 * Qn 的每个归组块各按紧跟规则取一个值（决定 0128 第 2 条"多块规则"；历史名
 * firstLiteralMatch 保留）：取到的非空值全都相同就是这个值；有不同 = 未填
 * （null），不再取第一个有命中的块；一块都取不到也是未填。
 */
function firstLiteralMatch(attribution, qn, candidates) {
  const filled = [];
  for (const entry of attribution?.ordered ?? []) {
    if (entry?.q !== qn) continue;
    const value = valueAfterAnchor(entry, candidates);
    if (value !== null) filled.push(value);
  }
  if (filled.length === 0) return null;
  return new Set(filled).size === 1 ? filled[0] : null;
}

/**
 * 每席两维状态（纯函数；两维独立——completed+unstructured 合法）。
 *
 *   runState    来自 transcript 真值（pending/running/completed/failed/…；
 *               席位超时/缺席是 runState 的观察事实，本函数原样透传，
 *               永不改写为失败——0039 §2.2）。
 *   formatState 回复形状观察：empty（无最终文本）/ unstructured（有文本、
 *               零锚点）/ partial（有锚点，但并非所有 brief 问题被归组、
 *               或 preamble/unclassified 有实质内容——半结构化兜底在此）/
 *               structured（全部问题归组且无未归类残留）。
 *
 * @param {object} input
 * @param {string} input.runState transcript 真值状态（透传）
 * @param {Array<{q:number}>} input.questions parseBriefQuestions 输出
 * @param {object} input.attribution attributeReply 输出
 * @returns {{runState: string, formatState: "structured"|"partial"|"unstructured"|"empty"}}
 */
export function deriveSeatStates({ runState, questions, attribution }) {
  const qs = Array.isArray(questions) ? questions : [];
  const attr = attribution ?? { ordered: [], unclassified: "", preamble: "" };
  const residue = `${attr.unclassified ?? ""}${attr.preamble ?? ""}`.trim().length > 0;
  const hasText = (attr.ordered?.length ?? 0) > 0 || residue;
  const covered = new Set((attr.ordered ?? []).map((e) => e?.q));
  const allCovered = qs.length > 0 && qs.every((q) => covered.has(q.q));
  let formatState;
  if (!hasText) {
    formatState = "empty";
  } else if ((attr.ordered?.length ?? 0) === 0) {
    formatState = "unstructured";
  } else if (allCovered && !residue) {
    formatState = "structured";
  } else {
    formatState = "partial";
  }
  // runState 原样透传（字符串化防御：非字符串输入不改写为失败，保持观察事实）。
  return { runState: typeof runState === "string" ? runState : "unknown", formatState };
}

/**
 * 席位后端/提供方原始字段直读（纯函数；三块砖①厂族的事实源）。
 *
 * R9（决定 0023）：modelFamily 是展示闭集模块，dispatch/delivery 控制面路径
 * 不得消费——本服务属控制面，因此不做族系归类判断，只原样透出 registry 的
 * 原始字段：backend 字符串 + provider 标识（deepseek-acp 形 model.providerID，
 * 均缺 → null）。"厂族是否不同"的判断是 Lead 的事，工具只报事实。
 * @param {object} agent registry 条目
 * @returns {{backend: string|null, provider: string|null}}
 */
export function seatRuntimeFacts(agent) {
  const backend = typeof agent?.backend === "string" && agent.backend.length > 0
    ? agent.backend
    : null;
  const provider = typeof agent?.model?.providerID === "string" && agent.model.providerID.length > 0
    ? agent.model.providerID
    : null;
  return { backend, provider };
}

// ===== 只读投影：最终 assistant 文本（runCollectProjection compact 路径的等价实现）=====
//
// 与 compact 路径同纪律（同一 redactor SSOT + C0/C1/DEL 控制字符 sanitize），
// 但不设 4000 字上限——0039 零截断红线；council-diff 与组记录携带的是完整原文
// （脱敏后）。取最后一条 assistant 消息（compact 同语义：最终回复）。

// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

function sanitizeControls(text) {
  return String(text).replace(UNSAFE_CONTROL_RE, "\uFFFD");
}

// 派发失败原因的限长帽（UTF-16 码元，含末尾省略号）。spawn 报错可能整段几百字，
// 文本行与组记录都不该被它撑爆；帽值是工程裕度选择，不是推导值。
const DISPATCH_ERROR_MAX_UNITS = 400;

/** 限长（UTF-16 码元；超长截到 maxUnits-1 个码元后补 …，帽含省略号；截断点
 * 落在代理对中间时整体让出一格，不切开代理对）。 */
function truncateCodeUnits(text, maxUnits) {
  if (text.length <= maxUnits) return text;
  let keep = maxUnits - 1; // 留一个码元给 …
  const last = text.charCodeAt(keep - 1);
  if (last >= 0xd800 && last <= 0xdbff) keep -= 1;
  return `${text.slice(0, keep)}…`;
}

/** 派发错误的原文取法：非空字符串 message 优先，其次 code、name（字符串且
 * 非空才用），最后 String(error) 兜底。系统错误的 code（如 ENOENT）与无
 * message 对象的 name 比 "[object Object]" 有用；message 为空串的 Error 由此
 * 落到 name（"Error"），不再是空串。 */
function dispatchErrorRawText(error) {
  for (const field of ["message", "code", "name"]) {
    const value = error?.[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return String(error);
}

// 折叠空白：连续的 \r、\n、\t 连同两侧空格折成一个空格。sanitizeControls 有意
// 保留这三个字符（正文零加工红线），多行报错会把 stateLine、started 行、wait
// 提示拆成多行——派发原因这条链在进入去控制字符之前先折行，正文链不动。
const REASON_WHITESPACE_RE = /[ \t]*[\r\n\t]+[ \t]*/g;

function foldReasonWhitespace(text) {
  return String(text).replace(REASON_WHITESPACE_RE, " ");
}

/**
 * 派发失败原因的单一加工链（取原因时就地做好，后面所有面——结果、组记录、
 * MCP 回执、文本行——只用这一个值）：脱敏（env 密钥值整段替换）→ 折叠空白
 * （\r\n\t 连同两侧空格折成单个空格）→ 去控制字符 → 限长。顺序不能反：先截断
 * 再脱敏会让跨在截断点上的密钥漏掉一半（截断后的半段匹配不到整段密钥，替换
 * 失效）；先折叠再脱敏同理——折行可能把整段密钥切碎。
 */
function prepareDispatchError(error, env) {
  const redacted = createSecretRedactor(env ?? process.env).redactString(dispatchErrorRawText(error));
  return truncateCodeUnits(sanitizeControls(foldReasonWhitespace(redacted)), DISPATCH_ERROR_MAX_UNITS);
}

/**
 * 会审席 prompt 里固定合同的起点（任务书与视角片段之后；该席 prompt.sent 原样落盘，
 * 它是转录里唯一的控制面固定包装）。写入处与读侧（Owner 看板任务书跳过固定包装）共用
 * 这一份。
 */
export const CONSULT_SEAT_CONTRACT_MARKER = "\n\n---\n【会审席边界（固定合同，席位级）】";

/** 标记之后的固定合同正文（每席同一句；席位 prompt 的实际后缀 = 标记 + 这句 + 声明字段段）。
 * 第 155 批（TD-385）起末尾带审查口径：以全局为重，边缘情形可以提但要标【边缘】。 */
export const CONSULT_SEAT_CONTRACT_TEXT = "你只负责逐问给出意见。禁止实现方案、派发或召集其他 agent。任务书中的后续阶段是评审对象，不是执行授权。不得代 Lead 作验收、排期或开阶段决定；缺证据时报告缺口。以全局为重：先报影响正确性、数据安全、可用性和既定约定的问题；边缘或概率极小的情形可以提，但须在该条开头标注【边缘】，并写明触发条件与可能性。";

/** 第 155 批之前写入的固定合同正文（历史会审 prompt 落盘的就是它）。读侧剥离时依次尝试
 * 当前版与这些历史版——改文案不能让旧记录的任务书露出旧合同。 */
const CONSULT_SEAT_CONTRACT_TEXT_HISTORY = Object.freeze([
  "你只负责逐问给出意见。禁止实现方案、派发或召集其他 agent。任务书中的后续阶段是评审对象，不是执行授权。不得代 Lead 作验收、排期或开阶段决定；缺证据时报告缺口。",
]);

/**
 * 一个会审席的 prompt：任务书 + 视角片段（seatBody）之后机械追加固定合同后缀——写入端
 * （runConsult 扇出）与读侧（stripConsultSeatContract）共用这一份构造，后缀的形状只有一处定义。
 * 决定 0128 第 2 条"声明即合同"：declaredFields 有值时，固定合同之后追加结论字段格式段
 * （每席同一份；没有时追加空串——prompt 逐字节不变）。
 *
 * @param {string} seatBody
 * @param {object} [declaredFields]
 * @returns {string}
 */
export function buildConsultSeatPrompt(seatBody, declaredFields) {
  return `${seatBody}${consultSeatSuffix(declaredFields)}`;
}

/** 写入端追加在席位 prompt 末尾的整段后缀：标记 + 固定句 + 声明字段段。 */
function consultSeatSuffix(declaredFields, contractText = CONSULT_SEAT_CONTRACT_TEXT) {
  return `${CONSULT_SEAT_CONTRACT_MARKER}${contractText}${buildDeclaredFieldsContract(declaredFields)}`;
}

/**
 * 会审席 prompt 去掉实际追加的固定合同后缀，剩下任务书与视角片段（Owner 看板的任务书用）。
 * 按**该场会审记录里实际声明的 fields** 用写入端同一个构造重建后缀（候选值原样取，多行候选
 * 也一样），prompt 恰好以这段后缀结尾才剥；对不上（任务书正文自己引用了标记、记录与 prompt
 * 声明不一致、后缀后面还有别的内容）一律原样返回，不截断。固定句依次按当前版、历史版重建
 * （历史会审的 prompt 落盘的是改文案之前的那一句）。
 *
 * @param {string} prompt
 * @param {object} [declaredFields] — 组记录里的 declaredFields（没有声明就不传）
 * @returns {string}
 */
export function stripConsultSeatContract(prompt, declaredFields) {
  for (const text of [CONSULT_SEAT_CONTRACT_TEXT, ...CONSULT_SEAT_CONTRACT_TEXT_HISTORY]) {
    const suffix = consultSeatSuffix(declaredFields, text);
    if (prompt.endsWith(suffix)) return prompt.slice(0, prompt.length - suffix.length);
  }
  return prompt;
}

/**
 * 从 transcript 事件快照提取最终 assistant 文本（只读、脱敏、不截断）。
 * @param {Array<object>} events transcript 事件序列
 * @param {object} [opts]
 * @param {string} [opts.runId] 绑定作用域（boundReportScope SSOT；legacy 无信封快照保持全量读法）
 * @param {object} [opts.env] 脱敏 env（默认 process.env）
 * @returns {string} 最终 assistant 文本（无则 ""）
 */
export function extractFinalAssistantText(events, { runId, env } = {}) {
  const scope = boundReportScope(events, runId) ?? (Array.isArray(events) ? events : []);
  let last = null;
  for (const e of scope) {
    if (!e || e.type !== "run.event" || e.kind !== "message" || e.role !== "assistant") continue;
    const parts = Array.isArray(e.parts) ? e.parts : [];
    const texts = parts
      .filter((p) => p && p.type === "text" && typeof p.text === "string" && p.text.length > 0)
      .map((p) => p.text);
    if (texts.length > 0) last = texts.join("\n");
  }
  if (last === null) return "";
  return sanitizeControls(createSecretRedactor(env ?? process.env).redactString(last));
}

// ===== 编排 =====

// 决定 0095：consult 的 CLI 等待域显式写死，不再引用 RUN_WAIT_*——run_wait 的
// 下限已降到 30000（MCP 面），consult 的 CLI 语义不变。两个 CLI 缺省（创建
// 600000 / 再等 270000）各自成文，不从一个常量合成。
export const CONSULT_WAIT_MIN_MS = 180000;
export const CONSULT_WAIT_MAX_MS = 600000;
export const CONSULT_WAIT_DEFAULT_MS = 600000; // `consult run`（runConsult budgetMs）的创建缺省
export const CONSULT_REWAIT_DEFAULT_MS = 270000; // `consult wait`（waitForConsult）的再等缺省

/** consultId 形如 consult_<YYYYMMDDHHMMSSsss><6位base36随机>（与 runId 同时间戳形状）。 */
export function generateConsultId(nowFn = Date.now) {
  const ts = new Date(nowFn()).toISOString().replace(/[-:.TZ]/g, "");
  const rand = Math.random().toString(36).slice(2, 8);
  return `consult_${ts}${rand}`;
}

/** consultId 形状校验（show 路径进文件名前的防穿越门）。 */
export function isValidConsultId(id) {
  return typeof id === "string" && /^consult_[A-Za-z0-9_-]+$/.test(id) && id.length <= 128;
}

// 决定 0128 续修：候选值白名单与整词边界共用同一字符类（只写这一处）——字母
//（任何文字，含中文）、数字、下划线、连字符。黑名单只要漏一个字符就有歧义
//（标题形锚点的可选分隔符 . : ： 会吃掉以分隔符开头的候选首字符；空白会切开
// 格式行；* 与反引号会被紧跟桥接先吃掉；顿号让 "A、B" 与 ["A","B"] 同形）。
// 整词边界用同一类：PASSé/PASS𝟙/通过理由 都不再是前缀的整词，中文因此也有
// 边界（"Q1: 通过，理由" 取到、"Q1: 通过理由" 记未填），无需 CJK 例外。
const VALUE_CHAR_SOURCE = "[\\p{L}\\p{N}_-]";
const DECLARED_FIELD_VALUE_RE = new RegExp(`^${VALUE_CHAR_SOURCE}+$`, "u");
// 词字符集（wholeTokenAt 的整词判定）与候选值白名单同源——见上。
const WORD_CHAR = new RegExp(VALUE_CHAR_SOURCE, "u");

/** 候选值合法性（纯函数）：非空，且只由字母（任何文字）、数字、下划线、连字符组成。 */
export function isValidDeclaredFieldValue(value) {
  return typeof value === "string" && DECLARED_FIELD_VALUE_RE.test(value);
}

/** 创建面的固定拒绝文案（不回显候选值原文——值内容不可信；Qn 键是已过形状门的
 * 有界串，安全具名）。这句话会直接出现在 MCP 面上，不带内部函数名前缀；CLI
 * 透出本层 throw，MCP 侧识别本错误类后原样回给调用者。 */
const DECLARED_FIELD_VALUE_REFUSAL = (key) =>
  `declared field values for ${key} must be non-empty and use only letters, digits, _ and -`;

/** 键规范化拒绝文案（0128 续修）：Q01 的格式行会被读取端归到第 1 题、Q0 生成
 * 格式行却永远取不到——声明键必须不带前导零、不能是 Q0。 */
const DECLARED_FIELD_KEY_REFUSAL = (key) =>
  `declared field key ${key} must be Q1, Q2, ... with no leading zero (Q0 is not a question number)`;

/** 空候选列表拒绝文案（0128 复核）：{"Q1":[]} 不生成格式行、统计却按"声明了 Q1"
 * 计——声明一个 Qn 至少要给一个候选值。 */
const DECLARED_FIELD_EMPTY_REFUSAL = (key) =>
  `declared field ${key} needs at least one candidate value`;

/**
 * 决定 0128 续修：声明字段不合格的创建拒绝——专门错误类，供 MCP 面 instanceof
 * 可靠判别后原样回文案（通用 catch 只回"零派发"文案，只接 MCP 的 Lead 无从
 * 知道是哪个 Qn 不合格）。message 是上面的固定文案（只含 Qn 键）；CLI 行为不变。
 */
export class DeclaredFieldRefusalError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeclaredFieldRefusalError";
  }
}

/**
 * 决定 0128 第 2 条"声明即合同"：fields 有值时追加在每席提示词固定会审合同
 * 之后的格式段。按声明顺序机械生成，每个声明的 Qn 一行；候选值从 fields 原样
 * 取、不改写。声明键不是 Qn 形或候选为空 → 该行不生成（与 compareFields 的
 * 读取口径一致）；一行都不生成时返回 ""——提示词与没有 fields 时逐字节相同。
 */
export function buildDeclaredFieldsContract(declaredFields) {
  const declared = declaredFields && typeof declaredFields === "object" ? declaredFields : {};
  const lines = [];
  for (const key of Object.keys(declared)) {
    if (!/^Q\d+$/.test(key)) continue;
    const candidates = Array.isArray(declared[key])
      ? declared[key].filter((v) => typeof v === "string" && v.length > 0)
      : [];
    if (candidates.length === 0) continue;
    lines.push(`- ${key} 单独起一行写成「${key}: <值>」，值只能是 ${candidates.join("、")} 之一，这一行不写别的`);
  }
  if (lines.length === 0) return "";
  return `\n\n【结论字段格式（声明即合同）】\n${lines.join("\n")}`;
}

/**
 * 只读观察一个席位 run：transcript 真值状态 + 最终 assistant 文本。
 * runConsult 收集阶段与 consult show 重渲染共用（同一投影，零漂移）。
 * @returns {Promise<{runState: string, terminal: boolean, finalText: string}|null>}
 *   null = transcript 不可读（缺席/损坏——观察事实，不 throw）。
 */
export async function observeSeatRun({ runId, runDir, readTranscriptFn = readTranscript, env }) {
  const events = await readTranscriptFn(resolveTranscriptPath(resolve(runDir), runId));
  const scope = boundReportScope(events, runId) ?? events;
  const state = findState(scope);
  // kimi 诊断批（2026-10-10，Owner 批准的合同变更）：只读席位违规自动判 FAIL。
  // 写入证据=只读观察投影在同一冻结快照上的工作树内写入事实（真实事件形状是
  // type:"run.event"、kind:"file_written"——旧的顶层 type:"file_written" 自数
  // 从未匹配过任何真实转录，判定从未触发）。取它数出的工作树内写入文件数
  //（observedFileCount）：写在系统临时目录里的实验文件不在工作树派生面内，不算
  // 违规；同一席位另有工作树外的写入时投影 status 变 unknown，但工作树内那几笔
  // 仍照数，不被临时目录的写入掩盖。只计数+叠加判定，不改写 runState 自然终态。
  const fileWrittenCount = projectReadOnlyObservation(events, { runId, env }).observedFileCount ?? 0;
  return {
    runState: typeof state === "string" ? state : "unknown",
    terminal: TERMINAL_STATES.includes(state),
    finalText: extractFinalAssistantText(events, { runId, env }),
    fileWrittenCount,
  };
}

/**
 * 召集一次多席只读会审：扇出 → 轮询收集 → council-diff 事实 → 持久写组记录。
 *
 * 状态枚举（WQ-02）：
 *   正常（终态+文本）/ 超时（预算到期仍非终态——runState 保持观察值 +
 *   budgetExpired:true，不改写为失败）/ 缺席（transcript 全程不可读——
 *   runState:"missing"）/ malformed（formatState:unstructured——零重发）/
 *   派发失败（dispatch 抛错——runState:"dispatch_failed"，runId:null）/
 *   部分成功（以上任意混合，降级视图照常组装，永不 throw 中断其余席位）。
 *
 * @param {object} input
 * @param {string} [input.briefPath] brief 文件路径（briefText 未注入时读取；进组记录）
 * @param {string} [input.briefText] brief 原文（注入优先——共享内核逐字节）
 * @param {Array<{agentId: string, perspectiveText?: string}>} input.seats 席位清单
 * @param {Record<string, string[]>} [input.declaredFields] 闭集声明字段（{"Q1":["A","B"]}）
 * @param {string} [input.reviewedRunId] 可选被审 run（非作者砖）
 * @param {string} [input.follows] 可选：这是哪一场会审的下一轮（轮次 = 那一场 + 1）；那一场
 *   读不出就具名拒绝（ConsultFollowsRefusalError，零派发）
 * @param {string} [input.fallbackConsultsDir] 决定 0111 保留的旧落点（同 consult show）：读 follows
 *   记录的回退目录，数同谱系会审记录时也与状态目录合并（按 consultId 去重）
 * @param {number} [input.budgetMs=600000] 总预算（范围同 run_wait）
 * @param {string} input.registryPath
 * @param {string} input.runDir
 * @param {string} input.consultsDir 组记录目录（不存在则建）
 * @param {string} [input.cwd] 派发 cwd 透传（缺省用 registry 各席 cwd）
 * @param {number} [input.pollIntervalMs=1000]
 * @param {object} [input.env] 脱敏 env
 * @param {Function} [input.dispatchFn] 可注入派发（默认 dispatchRun）
 * @param {Function} [input.registryReadFn] 可注入 registry 读取
 * @param {Function} [input.readTranscriptFn] 可注入 transcript 读取
 * @param {Function} [input.readFileFn] / [input.writeFileFn] / [input.mkdirFn]
 * @param {Function} [input.nowFn] / [input.sleepFn] / [input.idFn]
 * @param {Function} [input.onFanOut] 扇出完成、组记录已落盘时调用一次：
 *   ({consultId, recordPath, seats: [{agentId, runId, dispatchError?}]})——
 *   dispatchError 仅派发未成立（runId:null）的席位携带（已按加工链处理）。
 *   调用面用它提前报出 consultId。
 * @returns {Promise<object>} council-diff 结果（含 record 与 render 所需全量事实）
 */
export async function runConsult({
  briefPath,
  briefText,
  seats,
  declaredFields,
  reviewedRunId,
  follows,
  fallbackConsultsDir,
  budgetMs = CONSULT_WAIT_DEFAULT_MS,
  // M13-r2：预算下限按调用面注入——CLI/r1 保持 consult 域（CONSULT_WAIT_MIN_MS
  // 180000，决定 0095 起与 run_wait 域解耦），MCP run_consult 的 waitMs 闭集是
  // 0..600000（0=扇出后立即取当下观察快照），注入 0。
  // 上限恒为 CONSULT_WAIT_MAX_MS，不可注入。
  budgetFloorMs = CONSULT_WAIT_MIN_MS,
  registryPath,
  runDir,
  consultsDir,
  cwd,
  pollIntervalMs = 1000,
  env = process.env,
  dispatchFn = dispatchRun,
  registryReadFn = readRegistry,
  readTranscriptFn = readTranscript,
  readFileFn = readFile,
  readdirFn = readdir,
  writeFileFn = writeFile,
  renameFn = rename,
  rmFn = rm,
  mkdirFn = mkdir,
  nowFn = Date.now,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
  idFn = generateConsultId,
  onFanOut,
  // TD-283：席位派发 advisory 下沉（服务层零 console——CLI 注入 console.error，
  // MCP 面缺省 no-op）。每席目标车道带 Owner 暂停说明时恰一行，只提示不拦截。
  // 第 156 批：Owner 规则原文 + 此刻高峰（开始时一次）与每席一行所选车道事实
  // 也走同一通道——MCP 面不注入 sink，天然零输出（其回执带结构化字段）。
  advisorySink = () => {},
  // 车道表读取面：席位别名解析与 TD-283 暂停提示共用。CLI 在非默认 --registry
  // 时传入停用的空表（防跨绑，规则同 run 命令）；测试注入夹具；缺省真实表。
  lanesDocFn = loadLanesConfig,
  // 第 156 批：laneRules 构造与每席车道事实行的测试缝（缺省=单一构造/单一实现；
  // 注入夹具，测试不读真实画像）。
  laneRulesFn = buildLaneRules,
  laneFactsLineFn = laneFactsLine,
}) {
  if (!Array.isArray(seats) || seats.length === 0) {
    throw new Error("runConsult: seats is required (at least one seat)");
  }
  const seatIds = seats.map((s) => s?.agentId);
  if (seatIds.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new Error("runConsult: every seat requires a non-empty agentId");
  }
  if (new Set(seatIds).size !== seatIds.length) {
    throw new Error("runConsult: seat agentIds must be unique");
  }
  if (!registryPath || typeof registryPath !== "string") {
    throw new Error("runConsult: registryPath is required");
  }
  if (!runDir || typeof runDir !== "string") {
    throw new Error("runConsult: runDir is required");
  }
  if (!consultsDir || typeof consultsDir !== "string") {
    throw new Error("runConsult: consultsDir is required");
  }
  if (!Number.isInteger(budgetMs) || budgetMs < budgetFloorMs || budgetMs > CONSULT_WAIT_MAX_MS) {
    throw new Error(`budgetMs must be an integer in [${budgetFloorMs}, ${CONSULT_WAIT_MAX_MS}], got: ${JSON.stringify(budgetMs)}`);
  }
  // 决定 0128 续修：声明键规范化 + 候选值约束——创建面（CLI 与 MCP 共用本
  // service）有一项不合格即整次拒绝，发生在任何派发之前（零席位派出）。键先
  // 过 ^Q\d+$ 宽形状门（不过的直接跳过：MCP wire 层与 CLI 解析层各自拒绝），
  // 再要求 ^Q[1-9]\d*$（无前导零、非 Q0）。重渲染旧记录不做这两项校验
  //（rerenderConsultFromRecord 照旧读记录里的声明）。
  for (const key of Object.keys(declaredFields ?? {})) {
    if (!/^Q\d+$/.test(key) || !Array.isArray(declaredFields[key])) continue;
    if (!/^Q[1-9]\d*$/.test(key)) {
      throw new DeclaredFieldRefusalError(DECLARED_FIELD_KEY_REFUSAL(key));
    }
    if (declaredFields[key].length === 0) {
      throw new DeclaredFieldRefusalError(DECLARED_FIELD_EMPTY_REFUSAL(key));
    }
    if (!declaredFields[key].every(isValidDeclaredFieldValue)) {
      throw new DeclaredFieldRefusalError(DECLARED_FIELD_VALUE_REFUSAL(key));
    }
  }

  const resolvedRegistry = resolve(registryPath);
  const resolvedRunDir = resolve(runDir);
  const resolvedConsultsDir = resolve(consultsDir);

  // brief 共享内核：逐字节原文（每席 prompt 的公共前段）。briefText 注入优先
  // （r1 契约，FLOW-3 钉住）；"内联 vs 文件二选一"由各调用面结构性保证——CLI
  // 只传 briefPath，MCP run_consult 只传 briefText（其输入无文件参数，M13-r2）。
  let text = briefText;
  if (text === undefined || text === null) {
    if (!briefPath || typeof briefPath !== "string") {
      throw new Error("runConsult: briefPath or briefText is required");
    }
    text = await readFileFn(resolve(briefPath), "utf8");
  }
  if (typeof text !== "string") {
    throw new Error("runConsult: briefText must be a string");
  }
  const briefSha256 = createHash("sha256").update(text, "utf8").digest("hex");
  const questions = parseBriefQuestions(text);
  const consultId = idFn(nowFn);
  const createdAt = new Date(nowFn()).toISOString();

  // 第 155 批（TD-385）：轮次在任何派发之前算出（follows 读不出 = 具名拒绝，零派发）。
  // 第 3 轮起经 advisory 通道打一行提醒——只提醒，不阻止、不改任何结果。历史扫描可能很慢，
  // 所以放在席位等待计时（startNow）开始之前：查询耗时不吃席位的等待预算。
  const followsId = typeof follows === "string" ? follows : undefined;
  if (follows !== undefined && follows !== null && !isValidConsultId(follows)) {
    throw new ConsultFollowsRefusalError(follows);
  }
  const { round, lineageRoot, roundMayBeLow } = await resolveNewConsultRound(
    {
      reviewedRunId,
      follows: followsId,
      loadFollowed: (id) => loadConsultRecordWithFallback({
        consultId: id, consultsDir: resolvedConsultsDir, fallbackConsultsDir, readFileFn, sleepFn,
      }),
    },
    { consultsDir: resolvedConsultsDir, fallbackConsultsDir, runDir: resolvedRunDir, readTranscriptFn, readdirFn, readFileFn },
  );
  const roundFacts = consultRoundFacts(round);
  if (roundFacts.roundAdvisory) advisorySink(roundFacts.roundAdvisory);

  const startNow = nowFn();

  // 三块砖①厂族：registry 原始字段直读（backend + provider，不做族系归类
  // 判断——R9：族系归类是展示闭集能力，控制面只报原始事实）。
  let registry = null;
  try {
    registry = await registryReadFn(resolvedRegistry);
  } catch {
    registry = null; // registry 不可读不阻断会审——厂族砖如实降级为 null
  }
  // 0045 W4c（R5 点名）：getAgent 抛错不再静默吞成 null——如实标注
  // registryResolution（"ok" | "failed" | "registry-unreadable"），渲染层区分
  // "席位已不在注册表"与"确无 provider 标识"，独立性判断不因此静默塌成 unknown。
  // 车道表与注册表映射本次会审各取一次：身份事实、席位别名解析与暂停提示共用，
  // 组记录写的车道与实际派发的目标同源。CLI 在非默认 --registry 时传入停用的
  // 空表（防跨绑，规则同 run 命令）；读不到 = null（解析透传、无提示）。
  let consultLanesDoc = null;
  try { consultLanesDoc = lanesDocFn(); } catch { consultLanesDoc = null; }
  // 第 156 批：会审 label（[席位A+席位B] 任务书标题；取不到退 consultId）与
  // laneRules（Owner 规则原文 + 此刻高峰快照）。label 随组记录持久（读取模式经
  // 记录回放）；laneRules 是创建时点的快照，只在结果上携带、不持久。开始时经
  // advisory 通道打一次（规则每条一行 + 此刻；MCP 面的 sink 是 no-op，零输出）。
  const label = buildConsultLabel({ seats: seatIds, brief: text, fallbackId: consultId });
  // 构造那一跳的意外抛错（生产实现不会抛；防注入/未来改动）只降级本字段——
  // 会审照常扇出（与 run_dispatch 受理回执同一纪律）。
  let laneRules;
  try {
    laneRules = laneRulesFn({ ...(consultLanesDoc ? { lanesDoc: consultLanesDoc } : {}) });
  } catch {
    laneRules = degradedLaneRules();
  }
  for (const line of renderLaneRulesLines(laneRules)) advisorySink(line);
  let consultRegistryAgents = {};
  try {
    consultRegistryAgents = registry ? Object.fromEntries(registry.listAgents().map((a) => [a.id, a])) : {};
  } catch { consultRegistryAgents = {}; }
  // 0045 W4d：席位名可能是车道别名（别名=执行；未入别名表的键原样透传）。每席的
  // 派发目标只解析一次，身份事实与派发共用——注册表键与别名同名时两边同样按
  // 解析器的别名优先。注册表读不到时不解析，原样透传。
  const seatTargets = new Map(); // agentId → {dispatchAgentId, policy}
  for (const seat of seats) {
    if (seatTargets.has(seat.agentId)) continue;
    let target = { dispatchAgentId: seat.agentId, policy: null };
    if (registry) {
      try {
        const resolution = resolveDispatchTarget({
          agentId: seat.agentId, lanesDoc: consultLanesDoc,
          registryAgents: consultRegistryAgents, roleLibrary: listRoleLibrarySync(),
        });
        if (resolution.kind === "resolved" && resolution.source === "alias") {
          target = {
            dispatchAgentId: resolution.agentId,
            policy: { laneId: resolution.laneId, roleId: resolution.roleId, resolvedTarget: resolution },
          };
        }
      } catch { /* 解析面不可用=照旧透传 */ }
    }
    seatTargets.set(seat.agentId, target);
  }
  const runtimeFacts = seats.map((seat) => {
    if (!registry) return { agentId: seat.agentId, backend: null, provider: null, registryResolution: "registry-unreadable" };
    const lookupId = seatTargets.get(seat.agentId).dispatchAgentId;
    try {
      const agent = registry.getAgent(lookupId);
      return { agentId: seat.agentId, ...seatRuntimeFacts(agent), registryResolution: "ok" };
    } catch {
      return { agentId: seat.agentId, backend: null, provider: null, registryResolution: "failed" };
    }
  });

  // 扇出：逐席后台只读 run（共享内核=brief 逐字节；视角片段原样拼在尾部）。
  // kimi 诊断会审（2026-10-10，opus+sol）：裸车道（无角色）会审席此前完全收不到
  // 角色合同的 WQ-03 禁令（角色装配条件不满足→prompt 裸奔），P1 kimi 席自我
  // 升格（自组内层会审+自己实现+24 文件写入）的前提之一。固定会审合同始终
  // 追加在每席 prompt 尾部（不依赖车道有没有角色；有角色合同时 WQ-03 已在——
  // 本段不重复禁令语义，只钉会审边界）。
  const dispatchStates = [];
  const seatPolicies = new Map(); // agentId → {laneId, roleId, resolvedTarget}（W4d 别名解析缓存）
  for (const seat of seats) {
    const seatBody = typeof seat.perspectiveText === "string" && seat.perspectiveText.length > 0
      ? `${text}\n\n${seat.perspectiveText}`
      : text;
    // 固定会审合同后缀（含决定 0128 第 2 条"声明即合同"的结论字段格式段）见
    // buildConsultSeatPrompt——读侧（Owner 看板任务书）按同一个构造剥离。
    const prompt = buildConsultSeatPrompt(seatBody, declaredFields);
    try {
      // 派发目标取扇出前的那次解析（seatTargets），与身份事实同源。
      const { dispatchAgentId, policy } = seatTargets.get(seat.agentId);
      if (policy) seatPolicies.set(seat.agentId, policy);
      // TD-283：席位目标（别名解析后的车道键，或裸键本身）带 Owner 暂停说明 →
      // 一行 advisory。车道表不可用（ok:false、停用或读取失败）= null，静默。
      {
        const holdLine = dispatchHoldAdvisoryLine(dispatchAgentId, laneDispatchHold(consultLanesDoc, dispatchAgentId));
        if (holdLine) advisorySink(holdLine);
      }
      // 第 156 批：每席一行所选车道事实（laneFactsLine 同一实现，fail-open——
      // 返回 null 不打印；车道不在画像/表停用都静默）。
      {
        const seatFacts = laneFactsLineFn(dispatchAgentId, {
          ...(consultLanesDoc ? { lanesDoc: consultLanesDoc } : {}),
        });
        if (seatFacts) advisorySink(seatFacts);
      }
      const seatPolicy = seatPolicies.get(seat.agentId);
      const result = await dispatchFn({
        agentId: dispatchAgentId,
        // 决定 0114 修订：会审别名席位按“车道 + 别名角色”执行——`--lane/--role`
        // 与冻结材料必须来自同一个角色值；`resolvedFrom` 保留 alias 注记。
        ...(seatPolicy?.laneId ? { resolvedLane: seatPolicy.laneId } : {}),
        ...(seatPolicy?.roleId
          ? { resolvedRole: seatPolicy.roleId, resolvedRoleId: seatPolicy.roleId }
          : {}),
        ...(seatPolicy?.resolvedTarget?.source === "alias" ? { resolvedFrom: "alias" } : {}),
        prompt,
        registryPath: resolvedRegistry,
        runDir: resolvedRunDir,
        cwd,
        readOnly: true,
        // 决定 0131 §5：会审席的任务类型在派发时固化进 run.started.taskType——有被审
        // run 是交付会审，否则是方案会审。条件与组记录写 reviewedRunId 的那一条同一。
        taskType: typeof reviewedRunId === "string" && reviewedRunId.length > 0
          ? "delivery_review"
          : "plan_review",
        // CLI 一次性进程：每席一次性 leadSession（可复用专家恒为首轮，
        // 与 commands/run.js 后台派发同款语义）。
        leadSession: randomUUID(),
      });
      dispatchStates.push({ agentId: seat.agentId, runId: result?.runId ?? null, accepted: result?.accepted === true });
    } catch (error) {
      // 取原因时就按脱敏→控制字符→限长加工（第 96 批）——后面所有面只用这个值。
      dispatchStates.push({ agentId: seat.agentId, runId: null, accepted: false, dispatchError: prepareDispatchError(error, env) });
    }
  }

  // 组记录在扇出后立刻落盘（席位-runId 映射）：会审还在跑时，按 consultId 的
  // `consult show` / `consult wait` 与 MCP 读取模式就能读到当下观察。收集结束后
  // 用完整观察覆盖同一文件。
  await mkdirFn(resolvedConsultsDir, { recursive: true });
  const recordPath = join(resolvedConsultsDir, `${consultId}.json`);
  await writeFileFn(recordPath, JSON.stringify({
    consultId,
    createdAt,
    // 第 156 批：会审 label（扇出时算好；读取模式经记录回放，不再重算）。
    ...(label != null ? { label } : {}),
    round,
    ...(followsId ? { follows: followsId } : {}),
    ...(lineageRoot !== undefined ? { lineageRoot } : {}),
    ...(roundMayBeLow ? { roundMayBeLow: true } : {}),
    brief: { path: briefPath ? resolve(briefPath) : null, sha256: briefSha256 },
    budgetMs,
    elapsedMs: nowFn() - startNow,
    questions,
    ...(declaredFields && Object.keys(declaredFields).length > 0 ? { declaredFields } : {}),
    seats: seats.map((seat, i) => ({
      agentId: seat.agentId,
      runId: dispatchStates[i].runId,
      runState: dispatchStates[i].runId === null ? "dispatch_failed" : "pending",
      formatState: "empty",
      backend: runtimeFacts[i].backend,
      provider: runtimeFacts[i].provider,
      ...(typeof seat.perspectiveText === "string" && seat.perspectiveText.length > 0
        ? { perspectiveSnippet: seat.perspectiveText }
        : {}),
      // 派发未成立（runId:null）的席位存加工后的原因；有 runId 的席位不带。
      ...(dispatchStates[i].runId === null && dispatchStates[i].dispatchError
        ? { dispatchError: dispatchStates[i].dispatchError }
        : {}),
      budgetExpired: false,
    })),
    fieldDiff: [],
    ...(typeof reviewedRunId === "string" && reviewedRunId.length > 0 ? { reviewedRunId } : {}),
  }, null, 2), "utf8");
  if (typeof onFanOut === "function") {
    onFanOut({
      consultId,
      recordPath,
      seats: dispatchStates.map((s) => ({
        agentId: s.agentId,
        runId: s.runId,
        ...(s.dispatchError ? { dispatchError: s.dispatchError } : {}),
      })),
    });
  }

  // 轮询：各 run transcript 至终态或总预算。读失败按瞬时处理（下轮重试），
  // 预算耗尽后席位保持最后观察状态（超时是观察事实，不改写为失败）。
  const live = dispatchStates.filter((s) => s.runId !== null);
  const lastState = new Map(); // runId → 最后成功读取观察到的 state
  const deadline = startNow + budgetMs;
  let pending = [...live];
  while (pending.length > 0 && nowFn() < deadline) {
    const remaining = deadline - nowFn();
    if (remaining > 0) await sleepFn(Math.min(pollIntervalMs, remaining));
    for (const seat of pending) {
      try {
        const events = await readTranscriptFn(resolveTranscriptPath(resolvedRunDir, seat.runId));
        const scope = boundReportScope(events, seat.runId) ?? events;
        const state = findState(scope);
        lastState.set(seat.runId, state);
        if (TERMINAL_STATES.includes(state)) seat.terminal = true;
      } catch {
        // 瞬时读失败：保留上一轮观察，下轮重试直至预算耗尽。
      }
    }
    pending = pending.filter((s) => !s.terminal);
  }

  // 收集：每席最终 assistant 文本（只读投影；缺席=transcript 不可读）。
  const perSeatAttribution = {};
  const seatResults = [];
  for (let i = 0; i < seats.length; i += 1) {
    const seat = seats[i];
    const dispatchState = dispatchStates[i];
    const facts = runtimeFacts[i];
    let runState;
    let finalText = null;
    let budgetExpired = false;
    let observation = null;
    if (dispatchState.runId === null) {
      runState = "dispatch_failed"; // 派发即拒（零 transcript）——观察事实
    } else {
      try {
        observation = await observeSeatRun({ runId: dispatchState.runId, runDir: resolvedRunDir, readTranscriptFn, env });
      } catch {
        observation = null; // 缺席：收集时点 transcript 不可读
      }
      if (observation === null) {
        runState = "missing";
        budgetExpired = true;
      } else {
        runState = observation.runState;
        budgetExpired = !observation.terminal;
        finalText = observation.finalText;
      }
    }
    const attribution = finalText === null
      ? { ordered: [], unclassified: "", preamble: "" }
      : attributeReply(finalText);
    perSeatAttribution[seat.agentId] = attribution;
    const { formatState } = deriveSeatStates({ runState, questions, attribution });
    // 只读违规自动 FAIL（Owner 2026-10-10）：有写入证据即席位判 FAIL（叠加判定，
    // runState 保持观察值）。缺席/派发失败无 transcript 事实——如实 null。
    const fileWrittenCount = observation !== null && observation.fileWrittenCount > 0 ? observation.fileWrittenCount : null;
    seatResults.push({
      agentId: seat.agentId,
      runId: dispatchState.runId,
      runState,
      formatState,
      backend: facts.backend,
      provider: facts.provider,
      ...(typeof seat.perspectiveText === "string" && seat.perspectiveText.length > 0
        ? { perspectiveSnippet: seat.perspectiveText }
        : {}),
      budgetExpired,
      ...(fileWrittenCount !== null ? { readOnlyViolation: { verdict: "FAIL", fileWrittenCount } } : {}),
      // result 层字段（不进组记录；dispatchError 例外——派发未成立席位的
      // 原因也进组记录，见下方 record.seats 的同名展开）：
      attribution,
      ...(finalText !== null ? { finalText } : {}),
      ...(dispatchState.dispatchError ? { dispatchError: dispatchState.dispatchError } : {}),
    });
  }

  const { fieldDiff, fieldValues } = compareFields(perSeatAttribution, declaredFields);

  // 三块砖②非作者：被审 run 的 agentId ∈ 席位清单 → 黄牌提示（advisory 不拦截）。
  let authorInSeats = null;
  let reviewedAgentId = null;
  if (typeof reviewedRunId === "string" && reviewedRunId.length > 0) {
    try {
      const events = await readTranscriptFn(resolveTranscriptPath(resolvedRunDir, reviewedRunId));
      reviewedAgentId = extractCanonicalAgentId(events, reviewedRunId);
      authorInSeats = reviewedAgentId !== "unknown" && seatIds.includes(reviewedAgentId);
    } catch {
      authorInSeats = null; // 被审 transcript 不可读：如实"无法判定"，不猜
    }
  }

  const elapsedMs = nowFn() - startNow;

  // 组记录（席位-runId 映射 = 意见-决策回链锚点）。只存映射与观察事实，
  // 不存回复正文（正文 SSOT 在各 run transcript，经 runId 回链）。
  const record = {
    consultId,
    createdAt,
    // 第 156 批：会审 label 随记录持久（与扇出落盘那份同一字段）。
    ...(label != null ? { label } : {}),
    round,
    ...(followsId ? { follows: followsId } : {}),
    ...(lineageRoot !== undefined ? { lineageRoot } : {}),
    ...(roundMayBeLow ? { roundMayBeLow: true } : {}),
    brief: { path: briefPath ? resolve(briefPath) : null, sha256: briefSha256 },
    budgetMs,
    elapsedMs,
    questions,
    ...(declaredFields && Object.keys(declaredFields).length > 0 ? { declaredFields } : {}),
    seats: seatResults.map((s) => ({
      agentId: s.agentId,
      runId: s.runId,
      runState: s.runState,
      formatState: s.formatState,
      backend: s.backend,
      provider: s.provider,
      ...(s.perspectiveSnippet ? { perspectiveSnippet: s.perspectiveSnippet } : {}),
      ...(s.budgetExpired ? { budgetExpired: true } : {}),
      // 派发未成立（runId:null）的席位存加工后的原因；有 runId 的席位不带。
      ...(s.runId === null && s.dispatchError ? { dispatchError: s.dispatchError } : {}),
    })),
    fieldDiff,
    ...(typeof reviewedRunId === "string" && reviewedRunId.length > 0 ? { reviewedRunId } : {}),
  };

  // 持久写组记录（替换扇出时落的那一份；绝不写 runs/、不写认证台账、零 delivery 事件）。
  // 扇出之后这份文件随时可能被 show / wait / MCP 读取模式读到，所以不就地覆盖（就地
  // 写会先把文件截空）：写到同目录的临时文件再改名换上去。改名被读者占住时退回就地
  // 覆盖——读的一侧对半截内容有重试。
  const finalJson = JSON.stringify(record, null, 2);
  const tempPath = `${recordPath}.${randomUUID()}.tmp`;
  await writeFileFn(tempPath, finalJson, "utf8");
  try {
    await renameFn(tempPath, recordPath);
  } catch {
    await writeFileFn(recordPath, finalJson, "utf8");
    await rmFn(tempPath, { force: true }).catch(() => {});
  }

  return {
    consultId,
    recordPath,
    record,
    ...roundFacts,
    // 第 156 批：label（与记录同一份）与 laneRules（创建时点快照，不持久）。
    ...(label != null ? { label } : {}),
    laneRules,
    questions,
    brief: record.brief,
    budgetMs,
    elapsedMs,
    seats: seatResults,
    fieldDiff,
    fieldValues,
    bricks: {
      runtimeFacts,
      authorInSeats,
      reviewedAgentId,
      ...(typeof reviewedRunId === "string" && reviewedRunId.length > 0 ? { reviewedRunId } : {}),
      // 三块砖③会话独立性：provider 会话号不在现有投影面——如实"未提供"，不伪造。
      sessionIndependence: "未提供",
    },
  };
}

/**
 * 读取一个会审组记录（consult show 的入口；只读）。
 * @returns {Promise<object>} record
 */

/**
 * 0045 R4（consult_…j6ixxl 裁定）：车道独立性三枚举派生（纯函数）。
 * laneGroup=等价类编号（首现顺序；null=无 run.started 事实）；authorRelation/
 * modelRelation ∈ same_lane|different_lane|unknown（或 same_model|different_model）；
 * providerSessionRelation 恒 "unknown"（会话关联未记录在转录——如实，不猜）。
 * 缺事实=unknown（不折叠成 false——R4：unknown≠false）。
 */
export function deriveIndependenceRelations({ seatFacts, authorFacts = null }) {
  const groupOf = new Map();
  let nextGroup = 1;
  const seats = (seatFacts ?? []).map((f) => {
    let laneGroup = null;
    if (typeof f.laneFingerprint === "string") {
      if (!groupOf.has(f.laneFingerprint)) groupOf.set(f.laneFingerprint, nextGroup++);
      laneGroup = groupOf.get(f.laneFingerprint);
    }
    const authorRelation = authorFacts === null || typeof authorFacts.laneFingerprint !== "string"
      ? "unknown"
      : (typeof f.laneFingerprint === "string"
        ? (f.laneFingerprint === authorFacts.laneFingerprint ? "same_lane" : "different_lane")
        : "unknown");
    const modelRelation = authorFacts === null || typeof authorFacts.modelId !== "string"
      ? "unknown"
      : (typeof f.modelId === "string"
        ? (f.modelId === authorFacts.modelId ? "same_model" : "different_model")
        : "unknown");
    return {
      agentId: f.agentId ?? null, runId: f.runId ?? null,
      laneGroup, authorRelation, modelRelation,
      providerSessionRelation: "unknown",
    };
  });
  const authorLaneInSeats = authorFacts === null || typeof authorFacts.laneFingerprint !== "string"
    ? null
    : seats.some((x, i) => x.authorRelation === "same_lane" ? true : false) || null;
  return { seats, authorLaneInSeats: authorLaneInSeats === null ? null : Boolean(authorLaneInSeats) };
}

const RECORD_READ_ATTEMPTS = 5;
const RECORD_READ_RETRY_MS = 100;

export async function loadConsultRecord({
  consultId,
  consultsDir,
  readFileFn = readFile,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  if (!isValidConsultId(consultId)) {
    throw new Error(`invalid consultId: ${JSON.stringify(consultId)}`);
  }
  if (!consultsDir || typeof consultsDir !== "string") {
    throw new Error("loadConsultRecord: consultsDir is required");
  }
  // 记录在会审收尾时会被替换一次；恰好读到替换中的半截内容时等一下再读，几次都
  // 解析不了才算记录坏了。文件不存在等读取错误不重试，原样抛出。
  const path = join(resolve(consultsDir), `${consultId}.json`);
  let parseError = null;
  for (let attempt = 0; attempt < RECORD_READ_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleepFn(RECORD_READ_RETRY_MS);
    const raw = await readFileFn(path, "utf8");
    let record;
    try {
      record = JSON.parse(raw);
    } catch (error) {
      parseError = error;
      continue;
    }
    if (!record || typeof record !== "object" || record.consultId !== consultId) {
      throw new Error("consult record malformed: consultId mismatch");
    }
    return record;
  }
  throw new Error(`consult record unreadable after ${RECORD_READ_ATTEMPTS} attempts: ${parseError?.message ?? "not JSON"}`);
}

/**
 * 决定 0111：按 id 读组记录的回退读取——CLI `consult show` / `consult wait`
 * （含 --until-settled）与 MCP run_consult 读取模式共用。
 *
 * 先在状态目录（consultsDir——链接工作树里已重定向到主工作树）读；只有文件
 * 不存在（ENOENT）且 fallbackConsultsDir（改动前的落点：按原配置、不重定向
 * 算出的目录）与它不同、且那边有这份记录时才从回退目录读。权限错误、坏
 * JSON 等其它失败不触发回退（loadConsultRecord 原样抛出——不能让一份坏记录
 * 被旧目录的好记录静默顶掉，读取者要看到真实状态）。
 *
 * @returns {Promise<{record: object, consultsDir: string}>}
 *   consultsDir=实际读到的目录（resolve 后）——回显 recordPath 用真实位置，
 *   调用方把它继续传给 rerenderConsultFromRecord 等下游。
 */
export async function loadConsultRecordWithFallback({
  consultId,
  consultsDir,
  fallbackConsultsDir,
  loadFn = loadConsultRecord,
  readFileFn = readFile,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  // loadFn 是 CLI 的测试缝（deps.loadConsultRecord）；生产恒为 loadConsultRecord。
  const read = (dir) => loadFn({ consultId, consultsDir: dir, readFileFn, sleepFn });
  try {
    const record = await read(consultsDir);
    return { record, consultsDir: resolve(consultsDir) };
  } catch (error) {
    if (typeof fallbackConsultsDir === "string" && fallbackConsultsDir.length > 0
      && resolve(fallbackConsultsDir) !== resolve(consultsDir) && error?.code === "ENOENT") {
      let record;
      try {
        record = await read(fallbackConsultsDir);
      } catch (fallbackError) {
        // 两边都没有：报状态目录那一份的错（读者找的是现在的落点）。
        throw fallbackError?.code === "ENOENT" ? error : fallbackError;
      }
      return { record, consultsDir: resolve(fallbackConsultsDir) };
    }
    throw error;
  }
}

/**
 * 等一场已经扇出的会审：各席都到终态或观察窗到期即返回（零派发、只读转录）。
 * 会审的等待预算到期之后，用它接着等；可以反复调用。
 * @param {object} input
 * @param {string} input.consultId
 * @param {string} input.consultsDir
 * @param {string} [input.fallbackConsultsDir] 决定 0111 的回退目录（状态目录里
 *   没有这份记录且是 ENOENT 时才读它；缺省无回退）
 * @param {string} input.runDir
 * @param {number} [input.waitMs] 观察窗，[CONSULT_WAIT_MIN_MS, CONSULT_WAIT_MAX_MS]；缺省 CONSULT_REWAIT_DEFAULT_MS
 *   （270000）——调用方自己的命令超时往往只有几分钟，缺省不取上限
 * @returns {Promise<{record: object, consultsDir: string, allTerminal: boolean, waitedMs: number, windowMs: number}>}
 *   consultsDir=实际读到组记录的目录（决定 0111——回显真实位置）
 */
export async function waitForConsult({
  consultId,
  consultsDir,
  fallbackConsultsDir,
  runDir,
  waitMs = CONSULT_REWAIT_DEFAULT_MS,
  pollIntervalMs = 2000,
  readFileFn = readFile,
  readTranscriptFn = readTranscript,
  nowFn = Date.now,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  if (!Number.isInteger(waitMs) || waitMs < CONSULT_WAIT_MIN_MS || waitMs > CONSULT_WAIT_MAX_MS) {
    throw new Error(`waitMs must be an integer in [${CONSULT_WAIT_MIN_MS}, ${CONSULT_WAIT_MAX_MS}], got: ${JSON.stringify(waitMs)}`);
  }
  const { record, consultsDir: usedDir } = await loadConsultRecordWithFallback({
    consultId, consultsDir, fallbackConsultsDir, readFileFn, sleepFn,
  });
  const resolvedRunDir = resolve(runDir);
  const started = nowFn();
  const deadline = started + waitMs;
  let pending = (record.seats ?? []).filter((seat) => typeof seat.runId === "string" && seat.runId.length > 0);
  for (;;) {
    const still = [];
    for (const seat of pending) {
      let terminal = false;
      try {
        const events = await readTranscriptFn(resolveTranscriptPath(resolvedRunDir, seat.runId));
        terminal = TERMINAL_STATES.includes(findState(boundReportScope(events, seat.runId) ?? events));
      } catch {
        terminal = false; // 瞬时读失败：下一轮再读
      }
      if (!terminal) still.push(seat);
    }
    pending = still;
    const remaining = deadline - nowFn();
    if (pending.length === 0 || remaining <= 0) break;
    await sleepFn(Math.min(pollIntervalMs, remaining));
  }
  return {
    record,
    consultsDir: usedDir,
    allTerminal: pending.length === 0,
    waitedMs: nowFn() - started,
    windowMs: waitMs,
  };
}

/**
 * 从组记录只读重渲染 council-diff 结果对象（M13-r2；0051 修订：CLI `consult
 * show` 与 MCP `run_consult` 读取模式共用本内核——但"MCP 面同形输出"合同已废
 * 止，MCP 面在本内核之上加回执/按席分页投影层（见 server.js 投影与决定 0051）；
 * 代码自 CLI 适配层原样上移，CLI 字节面不变）。
 *
 * 重渲染语义：经组记录的席位-runId 映射回读各 transcript，重新归组/比对；
 * runState/formatState 按当前 transcript 真值重导出（show 是当下观察）；组
 * 记录中的历史观察值保留在返回的 record 字段里。零派发——本函数不持有任何
 * dispatch 通道（MCP 读取模式不变式的实现基础）。
 *
 * @param {object} input
 * @param {object} input.record loadConsultRecord 输出
 * @param {string} input.runDir
 * @param {string} input.consultsDir（recordPath 回显用）
 * @param {string[]} [input.lineageDirs] 旧记录现算轮次时一起数的会审记录目录（状态目录 +
 *   决定 0111 的旧落点；与 consultsDir 合并、按 consultId 去重）
 * @param {Function} [input.readTranscriptFn]
 * @param {object} [input.env] 脱敏 env
 * @returns {Promise<object>} 与 runConsult 结果同形的结果对象（无 console 副作用）
 */
export async function rerenderConsultFromRecord({
  record,
  runDir,
  consultsDir,
  lineageDirs,
  readTranscriptFn = readTranscript,
  readdirFn = readdir,
  readFileFn = readFile,
  env = process.env,
  nowFn = Date.now,
}) {
  // 组记录在扇出时就落盘，所以这里可能读到一场还在等待预算之内的会审：席位没到终态
  // 只有在预算确实过了之后才算"预算到期"。记录缺 createdAt / budgetMs（旧记录）时按
  // 已到期处理，与此前的读法一致。
  const createdMs = Date.parse(record.createdAt ?? "");
  const withinBudget = Number.isFinite(createdMs) && Number.isFinite(record.budgetMs)
    && nowFn() < createdMs + record.budgetMs;
  const seatResults = [];
  const perSeatAttribution = {};
  for (const seat of record.seats ?? []) {
    let observation = null;
    if (seat.runId) {
      try {
        observation = await observeSeatRun({ runId: seat.runId, runDir, readTranscriptFn, env });
      } catch {
        observation = null;
      }
    }
    const runState = observation ? observation.runState : (seat.runId ? "missing" : seat.runState);
    const attribution = observation
      ? attributeReply(observation.finalText)
      : { ordered: [], unclassified: "", preamble: "" };
    perSeatAttribution[seat.agentId] = attribution;
    const { formatState } = deriveSeatStates({ runState, questions: record.questions ?? [], attribution });
    // 迟到收取路径同样判只读违规（与 runConsult 收集层同一投影零漂移）。
    const fileWrittenCount = observation !== null && observation.fileWrittenCount > 0 ? observation.fileWrittenCount : null;
    seatResults.push({
      agentId: seat.agentId,
      runId: seat.runId,
      runState,
      formatState,
      backend: seat.backend ?? null,
      provider: seat.provider ?? null,
      ...(seat.perspectiveSnippet ? { perspectiveSnippet: seat.perspectiveSnippet } : {}),
      budgetExpired: observation ? !observation.terminal && !withinBudget : !withinBudget,
      // 组记录里派发未成立席位的原因（写入侧已按脱敏→控制字符→限长加工，
      // 读取只做类型检查——字符串才带，不再二次加工；旧记录按缺席）。
      ...(typeof seat.dispatchError === "string" ? { dispatchError: seat.dispatchError } : {}),
      ...(fileWrittenCount !== null ? { readOnlyViolation: { verdict: "FAIL", fileWrittenCount } } : {}),
      attribution,
      ...(observation ? { finalText: observation.finalText } : {}),
    });
  }
  const { fieldDiff, fieldValues } = compareFields(perSeatAttribution, record.declaredFields);

  // 非作者砖：与 runConsult 同一读法（被审 run transcript 的 canonical agentId）。
  let authorInSeats = null;
  let reviewedAgentId = null;
  let authorIdentityFacts = null;
  if (record.reviewedRunId) {
    try {
      const events = await readTranscriptFn(resolveTranscriptPath(runDir, record.reviewedRunId));
      reviewedAgentId = extractCanonicalAgentId(events, record.reviewedRunId);
      authorInSeats = reviewedAgentId !== "unknown"
        && (record.seats ?? []).some((s) => s.agentId === reviewedAgentId);
      const authorStarted = events.find((e) => e && e.type === "run.started" && e.runId === record.reviewedRunId);
      const authorIdentity = authorStarted ? deriveStartedIdentity(authorStarted) : null;
      authorIdentityFacts = authorIdentity === null ? null : {
        laneFingerprint: laneFingerprint(authorIdentity),
        modelId: authorIdentity.modelId,
      };
    } catch {
      authorInSeats = null;
    }
  }
  // 0045 R4 独立性三枚举：每席从自己的 run.started 事实派生（缺事实=unknown）。
  const seatFactsForRelations = [];
  for (const seat of seatResults) {
    try {
      const evs = await readTranscriptFn(resolveTranscriptPath(runDir, seat.runId));
      const st = evs.find((e) => e && e.type === "run.started" && e.runId === seat.runId);
      const identity = st ? deriveStartedIdentity(st) : null;
      seatFactsForRelations.push({
        agentId: seat.agentId, runId: seat.runId,
        laneFingerprint: identity ? laneFingerprint(identity) : undefined,
        modelId: identity ? identity.modelId : undefined,
      });
    } catch {
      seatFactsForRelations.push({ agentId: seat.agentId, runId: seat.runId });
    }
  }
  const relations = deriveIndependenceRelations({
    seatFacts: seatFactsForRelations,
    authorFacts: authorIdentityFacts,
  });
  const relationsByRunId = new Map(relations.seats.map((r) => [r.runId, r]));
  for (const seat of seatResults) {
    const r = relationsByRunId.get(seat.runId);
    if (r) {
      seat.laneGroup = r.laneGroup;
      seat.authorRelation = r.authorRelation;
      seat.modelRelation = r.modelRelation;
      seat.providerSessionRelation = r.providerSessionRelation;
    }
  }

  // 第 155 批（TD-385）：记录里写了 round 直接用；旧记录按谱系现算（不回写）。第 3 轮起
  // 带 {round, roundAdvisory}，第 1、2 轮结果与改前逐字节相同。
  const roundFacts = consultRoundFacts(
    await consultRoundOfRecord(record, { consultsDir, lineageDirs, runDir, readTranscriptFn, readdirFn, readFileFn }),
  );

  return {
    consultId: record.consultId,
    recordPath: join(consultsDir, `${record.consultId}.json`),
    record,
    ...roundFacts,
    // 第 156 批：读取模式经记录回放 label（旧记录没有该字段 → 键缺省，不重算——
    // 任务书原文不在记录里，重算只会得到 consultId 回退形，不如如实缺省）。
    ...(typeof record.label === "string" && record.label.length > 0 ? { label: record.label } : {}),
    questions: record.questions ?? [],
    brief: record.brief,
    budgetMs: record.budgetMs,
    elapsedMs: record.elapsedMs ?? null,
    seats: seatResults,
    fieldDiff,
    fieldValues,
    bricks: {
      runtimeFacts: (record.seats ?? []).map((s) => ({
        agentId: s.agentId,
        backend: s.backend ?? null,
        provider: s.provider ?? null,
      })),
      authorInSeats,
      authorLaneInSeats: relations.authorLaneInSeats,
      reviewedAgentId,
      ...(record.reviewedRunId ? { reviewedRunId: record.reviewedRunId } : {}),
      sessionIndependence: "未提供",
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 0051 载荷合同：MCP 面机械回执 + 按席分页（CLI 全量内核不变）。
//
// 背景（TD-241 C3 实证 + 决定 0051）：MCP run_consult 原样返回全量结果对象
// 双通道（text=JSON.stringify(parsed) + structuredContent=parsed），每席正文
// 经 finalText 与 attribution 双份携带，codex 实测 ~21KB/通道即截断。本层提供
// 纯投影/分页函数；MCP 面消费，CLI consult show 继续走全量内核（0039 不变式
// ①的作用域=存储/渲染内核与 CLI 面；MCP 面零摘要零截断的兑现方式=回执无正文
// + 分页无损拼回，不是选择性预览）。
// ─────────────────────────────────────────────────────────────────────────────

/** 单页响应（含外壳元数据）序列化后 UTF-8 字节的默认帽（TD-241 C3：codex
 * 0.159.2 实测 ~21KB 截断；12KiB 初始帽是工程裕度选择，非 21KB÷1.75 的推导）。 */
export const CONSULT_PAGE_CAP_BYTES = 12 * 1024;

/** 机械回执（含外壳元数据）序列化后 UTF-8 字节的文档化帽。成立边界（测试钉
 * MRC-F1，验收批修订 2026-10-09：中文标题+字段值实测下 6KiB 不可证、视角
 * snippet 携全文故整体剥离）：≤5 席 × ≤32 字席位 id × ≤10 问 × ≤120 字中文
 * 标题 × 短字段值、无视角原文（recordPath 取）——schema 上限超界或字段值
 * 病态长可破帽（已知未收紧）；正文体积完全无关。派发失败原因每席至多 400
 * 码元，不在这个成立边界内。 */
export const CONSULT_RECEIPT_CAP_BYTES = 8 * 1024;

/** 席位正文 sha256（hex）——分页版本锚：跨页拼接时调用方比对每页的
 * textSha256，不一致=正文在读取间隙变化，必须从第 1 页重读（不静默混拼）。 */
export function consultTextSha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** text 的全部码点边界位置（升序，含 0 与 text.length；代理对不拆开）。
 * JSON 序列化测度在码点边界上严格单调（每追加一个完整码点，序列化串至少
 * 增 1 字节——含转义形式；而落在代理对中间的前缀会把落单高位代理转义成
 * 6 字节 \udXXX，比完整代理对的 4 字节更大，即 UTF-16 逐位前缀**非单调**，
 * sol 验收反例：🚀🚀🚀 cap=6 时逐位二分会误判"装不下"）——分页搜索只在
 * 码点边界上进行，单调性得以成立。 */
function codePointBoundaries(text) {
  const bounds = [0];
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    i += (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length
      && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) ? 2 : 1;
    bounds.push(i);
  }
  return bounds;
}

/**
 * 把席位正文切成确定性页序列（纯函数，无 IO）。
 *
 * - measure(candidatePageText) 由调用方注入：返回"以 candidate 为 pageText 的
 *   完整 seatPage 结果对象 JSON 序列化后的 UTF-8 字节数"——页帽作用于整页响应
 *   （含外壳与转义），不是 JS 字符串长度（12K 个中文字符按字符数算约 36KB，
 *   必截断——会审必改）。
 * - 切页规则（会审定稿 + 验收批修订）：行边界优先（候选区间内最后一个 "\n"
 *   之后且不浪费超过候选一半，防"开头一个换行+超长无换行"退化成 1 页 1 字）；
 *   单行超帽时按码点硬切（绝不切开代理对）；全部原文无损保留——各页 pageText
 *   按序拼接逐字节等于输入文本。
 * - 返回 { pages: string[], totalChars }；空文本 → pages=[]。
 */
export function paginateConsultText(text, { capBytes = CONSULT_PAGE_CAP_BYTES, measure }) {
  if (typeof text !== "string") throw new Error("paginateConsultText: text must be a string");
  if (typeof measure !== "function") throw new Error("paginateConsultText: measure(repr) is required");
  if (!Number.isInteger(capBytes) || capBytes <= 0) throw new Error("paginateConsultText: capBytes must be a positive integer");
  if (text.length === 0) return { pages: [], totalChars: 0 };
  if (measure("") > capBytes) {
    throw new Error("paginateConsultText: envelope alone exceeds capBytes — cap misconfigured");
  }
  const cpBounds = codePointBoundaries(text);
  const pages = [];
  let offset = 0;
  while (offset < text.length) {
    // 本页候选=码点边界二分（测度在码点边界上严格单调）；每个 UTF-16 码元
    // 序列化后至少 1 字节 ⇒ 可装前缀长度 ≤ capBytes（opus S1 上界收紧）。
    const idxLimit = Math.min(text.length, offset + capBytes);
    // lo/hi 为 cpBounds 中的下标：lo 恒可装（measure("")≤cap 且非空页至少要
    // 一个码点——首个码点装不下会在下面如实抛出）。
    let lo = cpBounds.findIndex((b) => b > offset) - 1; // 指向 offset 自身边界
    let hi = cpBounds.length - 1;
    while (cpBounds[hi] > idxLimit) hi -= 1;
    if (hi <= lo) hi = lo + 1 <= cpBounds.length - 1 ? lo + 1 : lo;
    // 整段剩余装得下（未截上界且末边界可装）→ 最后一页。
    if (hi === cpBounds.length - 1 && measure(text.slice(offset, cpBounds[hi])) <= capBytes) {
      pages.push(text.slice(offset));
      break;
    }
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (measure(text.slice(offset, cpBounds[mid])) <= capBytes) lo = mid;
      else hi = mid - 1;
    }
    // cpBounds[lo+1] 必存在（剩余非空 ⇒ 后面还有边界）；lo 停在"装得下"的最
    // 大边界。lo 自身=offset（空页）说明首码点都装不下 → 如实抛。
    if (cpBounds[lo] <= offset) {
      throw new Error("paginateConsultText: cannot fit a single code point under capBytes");
    }
    let take = cpBounds[lo] - offset;
    // 行边界优先（S2：回退不浪费超过候选一半）。
    const nl = text.lastIndexOf("\n", offset + take - 1);
    if (nl >= offset) {
      const lineEnd = nl + 1 - offset;
      if (lineEnd >= Math.ceil(take / 2) && measure(text.slice(offset, offset + lineEnd)) <= capBytes) {
        take = lineEnd;
      }
    }
    pages.push(text.slice(offset, offset + take));
    offset += take;
  }
  return { pages, totalChars: text.length };
}

/**
 * 决定 0096：仍是"在跑"的席位——有 runId，当前 runState 不在 TERMINAL_STATES，
 * 且不是转录读不到的 `missing`。没有 runId 的席位（派发未成立）与 missing 席位
 * 都不算（CLI 与 MCP 回执共用同一判定，不各写一份）。
 * @param {Array<object>} seats
 * @returns {Array<object>}
 */
export function selectNonTerminalSeats(seats) {
  return (Array.isArray(seats) ? seats : []).filter((seat) =>
    seat && typeof seat.runId === "string" && seat.runId.length > 0
    && seat.runState !== "missing"
    && !TERMINAL_STATES.includes(seat.runState));
}

/**
 * 全量结果 → MCP 机械回执（纯投影）。create 成功与 read 无 seat 两路径共用
 * 同一函数（会审必改：不造第三种形状）。
 *
 * 剥离：每席 finalText（正文）与 attribution（正文第二份拷贝——会审补充靶点
 * 事实）、record（组记录副本——席位-runId 回链锚点已由回执 seats 自带
 * runId 承载，持久记录在 recordPath）、每席 backend/provider（bricks.
 * runtimeFacts 已携带，去重）、每席 perspectiveSnippet（视角**全文**——验收批
 * 实测 265-607 字/席，是回执帽的主要破帽项；原文在 recordPath）。保留：
 * fieldDiff/fieldValues/bricks（体积小且是 0039 不变式②标记机制本身）。回执
 * 不含任何正文摘录/预览（0039 不变式①：预览=有选择的截断）。
 *
 * 决定 0096：有未终态席位时附 MCP 面 nextStep（不落席位 id；第 136 批起末尾的
 * CLI 半句带这场会审的 consultId）；全部终态时不带该字段。席位分页视图不带。
 *
 * pageMeasure(seat, candidatePageText) 由调用方注入（与 seatPage 视图同一
 * 信封构造器）——回执里每席的 pages 与后续分页读同一把尺，计数不漂移。
 */
export function projectConsultReceipt(result, { pageMeasure } = {}) {
  if (!result || typeof result !== "object") throw new Error("projectConsultReceipt: result object required");
  if (typeof pageMeasure !== "function") throw new Error("projectConsultReceipt: pageMeasure(seat, repr) is required");
  const seats = (result.seats ?? []).map((seat) => {
    const { finalText, attribution, backend, provider, perspectiveSnippet, ...rest } = seat;
    const text = typeof finalText === "string" ? finalText : "";
    let pages = 0;
    if (text.length > 0) {
      pages = paginateConsultText(text, { measure: (candidate) => pageMeasure(seat, candidate) }).pages.length;
    }
    return {
      ...rest,
      chars: text.length,
      pages,
      textFinal: TERMINAL_STATES.includes(seat.runState),
    };
  });
  const nonTerminal = selectNonTerminalSeats(seats);
  const nextStep = nonTerminal.length > 0
    ? buildNextStep({
      surface: "mcp",
      situation: "consult_seats_running",
      seatCount: seats.length,
      nonTerminalSeatCount: nonTerminal.length,
      consultId: result.consultId,
    })
    : null;
  return {
    view: "receipt",
    consultId: result.consultId,
    recordPath: result.recordPath,
    // 第 155 批：第 3 轮起（result 带了才有）回执携带 round 与提醒原文；第 1、2 轮不带。
    ...(typeof result.roundAdvisory === "string" ? { round: result.round, roundAdvisory: result.roundAdvisory } : {}),
    // 第 156 批：会审 label（创建与读取都经 result 携带；旧记录缺 → 键缺省）与
    // laneRules（创建时点快照；读取路径 result 不带 → 键缺省）。
    ...(typeof result.label === "string" && result.label.length > 0 ? { label: result.label } : {}),
    ...(result.laneRules != null ? { laneRules: result.laneRules } : {}),
    questions: result.questions,
    brief: result.brief,
    budgetMs: result.budgetMs,
    elapsedMs: result.elapsedMs,
    ...(nextStep === null ? {} : { nextStep }),
    seats,
    fieldDiff: result.fieldDiff,
    fieldValues: result.fieldValues,
    bricks: result.bricks,
  };
}
