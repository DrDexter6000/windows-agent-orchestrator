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
// 只读重渲染 rerenderConsultFromRecord({...deps})（M13-r2）：
//   从组记录回读各席位 transcript 重建同形结果对象（CLI consult show 与 MCP
//   run_consult 读取模式共用）——零派发（不持有 dispatch 通道）。
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
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { readTranscript, findState, TERMINAL_STATES, extractCanonicalAgentId } from "../transcript.js";
import { readRegistry } from "../registry.js";
import { boundReportScope } from "../metrics.js";
import { createSecretRedactor } from "../secretRedaction.js";
import { dispatchRun } from "./runDispatch.js";
// 预算范围与 run_wait 同域（0039 r1：--wait-timeout 默认 600000，范围同 run_wait）。
import { RUN_WAIT_MIN_MS, RUN_WAIT_MAX_MS } from "./runWait.js";
// R9（决定 0023）：modelFamily 是展示闭集模块，本文件（dispatch/delivery 控制
// 面路径）不得 import——三块砖①厂族改为 registry 原始字段直读（seatRuntimeFacts）。

// ===== 锚点规则（brief 解析与席位回复归组共用同一 SSOT）=====
//
// 行首编号问题锚点，两条确定性规则（0039 r1 任务书）：
//   ① Markdown 标题形：/^#{1,3}\s*Q(\d+)\b/   —— "## Q1 这个方案可行吗"
//   ② 裸编号形：      /^Q(\d+)\s*[.::：]/      —— "Q1: ..." / "Q1：" / "Q1."
// 不做模糊匹配、不做句子级切分（切错比不切更糟，0039 §2.2 收集规则）。
const ANCHOR_PATTERNS = [
  /^#{1,3}\s*Q(\d+)\b/,
  /^Q(\d+)\s*[.::：]/,
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
 * 闭集声明字段值的字面提取 + "字段值不同"标记（纯函数，不变式②）。
 *
 * declaredFields 形如 {"Q1":["A","B"]}（Lead 声明的闭集候选值）。字段值
 * 提取 = 该席 Qn 各归组块中**首个字面匹配**某个声明值的 token（大小写敏感、
 * indexOf 字面匹配、位置最早者胜、同位置声明序靠前者胜；不猜）。缺席 = 未填
 * （null）。fieldDiff 只在"≥2 席有值 且 值不全同"时收该 Qn——标记即提示，
 * 本函数及其输出永不携带"一致/分歧/agree/disagree"类结论词（测试钉住）。
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

/** Qn 归组块内首个字面命中声明值（位置最早胜；同位置声明序靠前胜）。 */
function firstLiteralMatch(attribution, qn, candidates) {
  let bestValue = null;
  let bestIndex = Infinity;
  for (const entry of attribution?.ordered ?? []) {
    if (entry?.q !== qn) continue;
    for (const value of candidates) {
      const at = String(entry.text ?? "").indexOf(value);
      if (at !== -1 && at < bestIndex) {
        bestIndex = at;
        bestValue = value;
      }
    }
  }
  return bestValue;
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
 * 原始字段：backend 字符串 + provider 标识（zcode 形 model.providerID 优先；
 * wrapper 形取 provider.baseUrl——该形状下唯一可区分提供方的原始字段；
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
    : (typeof agent?.provider?.baseUrl === "string" && agent.provider.baseUrl.length > 0
      ? agent.provider.baseUrl
      : null);
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

export const CONSULT_WAIT_MIN_MS = RUN_WAIT_MIN_MS;
export const CONSULT_WAIT_MAX_MS = RUN_WAIT_MAX_MS;
export const CONSULT_WAIT_DEFAULT_MS = RUN_WAIT_MAX_MS; // 600000

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

/**
 * 只读观察一个席位 run：transcript 真值状态 + 最终 assistant 文本。
 * runConsult 收集阶段与 consult show 重渲染共用（同一投影，零漂移）。
 * @returns {Promise<{runState: string, terminal: boolean, finalText: string}|null>}
 *   null = transcript 不可读（缺席/损坏——观察事实，不 throw）。
 */
export async function observeSeatRun({ runId, runDir, readTranscriptFn = readTranscript, env }) {
  const events = await readTranscriptFn(join(resolve(runDir), `${runId}.jsonl`));
  const scope = boundReportScope(events, runId) ?? events;
  const state = findState(scope);
  return {
    runState: typeof state === "string" ? state : "unknown",
    terminal: TERMINAL_STATES.includes(state),
    finalText: extractFinalAssistantText(events, { runId, env }),
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
 * @returns {Promise<object>} council-diff 结果（含 record 与 render 所需全量事实）
 */
export async function runConsult({
  briefPath,
  briefText,
  seats,
  declaredFields,
  reviewedRunId,
  budgetMs = CONSULT_WAIT_DEFAULT_MS,
  // M13-r2：预算下限按调用面注入——CLI/r1 保持 run_wait 域（180000），MCP
  // run_consult 的 waitMs 闭集是 0..600000（0=扇出后立即取当下观察快照），注入 0。
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
  writeFileFn = writeFile,
  mkdirFn = mkdir,
  nowFn = Date.now,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
  idFn = generateConsultId,
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

  const startNow = nowFn();
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

  // 三块砖①厂族：registry 原始字段直读（backend + provider，不做族系归类
  // 判断——R9：族系归类是展示闭集能力，控制面只报原始事实）。
  let registry = null;
  try {
    registry = await registryReadFn(resolvedRegistry);
  } catch {
    registry = null; // registry 不可读不阻断会审——厂族砖如实降级为 null
  }
  const runtimeFacts = seats.map((seat) => {
    if (!registry) return { agentId: seat.agentId, backend: null, provider: null };
    try {
      const agent = registry.getAgent(seat.agentId);
      return { agentId: seat.agentId, ...seatRuntimeFacts(agent) };
    } catch {
      return { agentId: seat.agentId, backend: null, provider: null };
    }
  });

  // 扇出：逐席后台只读 run（共享内核=brief 逐字节；视角片段原样拼在尾部）。
  const dispatchStates = [];
  for (const seat of seats) {
    const prompt = typeof seat.perspectiveText === "string" && seat.perspectiveText.length > 0
      ? `${text}\n\n${seat.perspectiveText}`
      : text;
    try {
      const result = await dispatchFn({
        agentId: seat.agentId,
        prompt,
        registryPath: resolvedRegistry,
        runDir: resolvedRunDir,
        cwd,
        readOnly: true,
        // CLI 一次性进程：每席一次性 leadSession（可复用专家恒为首轮，
        // 与 commands/run.js 后台派发同款语义）。
        leadSession: randomUUID(),
      });
      dispatchStates.push({ agentId: seat.agentId, runId: result?.runId ?? null, accepted: result?.accepted === true });
    } catch (error) {
      dispatchStates.push({ agentId: seat.agentId, runId: null, accepted: false, dispatchError: error?.message ?? String(error) });
    }
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
        const events = await readTranscriptFn(join(resolvedRunDir, `${seat.runId}.jsonl`));
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
    if (dispatchState.runId === null) {
      runState = "dispatch_failed"; // 派发即拒（零 transcript）——观察事实
    } else {
      let observation = null;
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
      // result 层字段（不进组记录）：
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
      const events = await readTranscriptFn(join(resolvedRunDir, `${reviewedRunId}.jsonl`));
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
    })),
    fieldDiff,
    ...(typeof reviewedRunId === "string" && reviewedRunId.length > 0 ? { reviewedRunId } : {}),
  };

  // 持久写组记录（目录不存在则建；绝不写 runs/、不写认证台账、零 delivery 事件）。
  await mkdirFn(resolvedConsultsDir, { recursive: true });
  const recordPath = join(resolvedConsultsDir, `${consultId}.json`);
  await writeFileFn(recordPath, JSON.stringify(record, null, 2), "utf8");

  return {
    consultId,
    recordPath,
    record,
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
export async function loadConsultRecord({ consultId, consultsDir, readFileFn = readFile }) {
  if (!isValidConsultId(consultId)) {
    throw new Error(`invalid consultId: ${JSON.stringify(consultId)}`);
  }
  if (!consultsDir || typeof consultsDir !== "string") {
    throw new Error("loadConsultRecord: consultsDir is required");
  }
  const raw = await readFileFn(join(resolve(consultsDir), `${consultId}.json`), "utf8");
  const record = JSON.parse(raw);
  if (!record || typeof record !== "object" || record.consultId !== consultId) {
    throw new Error("consult record malformed: consultId mismatch");
  }
  return record;
}

/**
 * 从组记录只读重渲染 council-diff 结果对象（M13-r2：CLI `consult show` 与 MCP
 * `run_consult` 读取模式共用同一实现——同形输出、零漂移；代码自 CLI 适配层
 * 原样上移，CLI 字节面不变）。
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
 * @param {Function} [input.readTranscriptFn]
 * @param {object} [input.env] 脱敏 env
 * @returns {Promise<object>} 与 runConsult 结果同形的结果对象（无 console 副作用）
 */
export async function rerenderConsultFromRecord({
  record,
  runDir,
  consultsDir,
  readTranscriptFn = readTranscript,
  env = process.env,
}) {
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
    seatResults.push({
      agentId: seat.agentId,
      runId: seat.runId,
      runState,
      formatState,
      backend: seat.backend ?? null,
      provider: seat.provider ?? null,
      ...(seat.perspectiveSnippet ? { perspectiveSnippet: seat.perspectiveSnippet } : {}),
      budgetExpired: observation ? !observation.terminal : true,
      attribution,
      ...(observation ? { finalText: observation.finalText } : {}),
    });
  }
  const { fieldDiff, fieldValues } = compareFields(perSeatAttribution, record.declaredFields);

  // 非作者砖：与 runConsult 同一读法（被审 run transcript 的 canonical agentId）。
  let authorInSeats = null;
  let reviewedAgentId = null;
  if (record.reviewedRunId) {
    try {
      const events = await readTranscriptFn(join(runDir, `${record.reviewedRunId}.jsonl`));
      reviewedAgentId = extractCanonicalAgentId(events, record.reviewedRunId);
      authorInSeats = reviewedAgentId !== "unknown"
        && (record.seats ?? []).some((s) => s.agentId === reviewedAgentId);
    } catch {
      authorInSeats = null;
    }
  }

  return {
    consultId: record.consultId,
    recordPath: join(consultsDir, `${record.consultId}.json`),
    record,
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
      reviewedAgentId,
      ...(record.reviewedRunId ? { reviewedRunId: record.reviewedRunId } : {}),
      sessionIndependence: "未提供",
    },
  };
}
