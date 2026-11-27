// src/application/dispatchLabel.js
//
// 第 156 批（TD-384）：派发/会审结果带 label——`[<车道>] <任务名>`。宿主的后台
// 任务列表里那一行此前全靠 Lead 手写；label 给出结构化名字，不为某一个 harness
// 专门优化（不出现宿主名与专有参数）。
//
// 契约：
//   - 车道段=本次实际派发的车道键或 agent id（调用方传解析所得键）；会审是席位
//     列表 `席位A+席位B`。
//   - 任务名与 Owner 看板同源：复用 ownerReadModel 的 deriveOwnerTitle（取第一
//     个非空行、跳过围栏/分隔线、去 # 记号、脱敏、清控制字符、限长），不另写
//     一套；同一输入两边逐字相同。
//   - 整个 label ≤DISPATCH_LABEL_MAX_CHARS（80），超出截断加省略号；取不到标题
//     时退回 `[<车道>] <runId>`（会审退 consultId）；连 id 也没有 → null（键缺省）。
//   - 纯函数、零 I/O；动态文本过 escapeControlChars（TD-318/319，行结构不破）。
import { deriveOwnerTitle } from "./ownerReadModel.js";
import { escapeControlChars } from "../safeText.js";

/** 整个 label 的长度上限（车道段+任务名/fallbackId 合计）。MCP 出参 schema 引用同一常量。 */
export const DISPATCH_LABEL_MAX_CHARS = 80;

// 超长截成 max-1 字符加"…"（与 laneProfile/laneFactsLine 的应用层截断同一形制）。
function clip(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function assemble(bracketPart, body) {
  return clip(escapeControlChars(`[${bracketPart}] ${body}`), DISPATCH_LABEL_MAX_CHARS);
}

/**
 * 派发 label：`[<车道>] <任务名>`；取不到标题退回 `[<车道>] <runId>`。
 * @param {object} input
 * @param {string} input.lane 本次实际派发的车道键或 agent id（解析所得键）
 * @param {unknown} input.prompt 任务书正文（标题取法与 Owner 看板同源）
 * @param {string|null} [input.fallbackId] 取不到标题时退回的 runId
 * @returns {string|null} null=连车道键或 fallbackId 都没有（调用方键缺省）
 */
export function buildDispatchLabel({ lane, prompt, fallbackId }) {
  if (typeof lane !== "string" || lane.length === 0) return null;
  const title = deriveOwnerTitle(prompt);
  const body = title ?? (typeof fallbackId === "string" && fallbackId.length > 0 ? fallbackId : null);
  if (body == null) return null;
  return assemble(lane, body);
}

/**
 * 会审 label：`[席位A+席位B] <任务书标题>`；取不到标题退回 consultId。
 * @param {object} input
 * @param {string[]} input.seats 席位（别名原样，非解析键——席位名就是 Lead 认得的名字）
 * @param {unknown} input.brief 任务书原文
 * @param {string|null} [input.fallbackId] 取不到标题时退回的 consultId
 * @returns {string|null}
 */
export function buildConsultLabel({ seats, brief, fallbackId }) {
  const ids = (Array.isArray(seats) ? seats : []).filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return null;
  const title = deriveOwnerTitle(brief);
  const body = title ?? (typeof fallbackId === "string" && fallbackId.length > 0 ? fallbackId : null);
  if (body == null) return null;
  return assemble(ids.join("+"), body);
}

/**
 * nextStep/派发 note 末尾的宿主无关短提示（第 156 批）：`（后台任务可命名 <label>）`。
 * 不写任何宿主名或专有参数。放不下（超过 maxLen）只丢提示、原句不动——已受理的
 * 派发不因为一句提示变成报错（第 147 批 resourceAdvisory 同款纪律）；无 label
 * 原样返回（label 本身已在回执字段里）。
 * @param {string} text 原句
 * @param {string|null} label
 * @param {number} [maxLen=Infinity] 整句上限（字符）
 * @returns {string}
 */
export function appendLabelHint(text, label, maxLen = Infinity) {
  if (typeof text !== "string" || typeof label !== "string" || label.length === 0) return text;
  const withHint = `${text} （后台任务可命名 ${label}）`;
  return withHint.length <= maxLen ? withHint : text;
}
