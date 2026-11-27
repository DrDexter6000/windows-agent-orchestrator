// src/application/laneRules.js
//
// 第 156 批：派发/会审回执与 CLI stderr 携带 Owner 车道规则原文与"此刻"高峰
// 快照（结构化字段 laneRules）。选车道的依据此前只在 lead_preflight（决定 0097
// 的 laneFacts 只描述所选车道本身，且 CLI --format json 不带）——Lead 筛 JSON 时
// 看不到规则与其他额度池此刻是否高峰；本批从结构上补齐（kimi/sol 会审定稿）。
//
// 契约（任务书 + 会审）：
//   - 单一构造（buildLaneRules）+ 单一 stderr 渲染（renderLaneRulesLines）；
//     四个出口（CLI run、MCP run_dispatch、CLI consult run、MCP run_consult）
//     只做序列化，不各自拼装。
//   - 内容只经 laneProfile 的投影取得（规则原文、now、同池合并的高峰行）——本
//     模块不出现画像文件名、车道名、时段或规则文字（SSOT：画像文件名只在
//     laneProfile.js）。run_continue 不带（车道随谱系固定）。
//   - rules 要么完整原文（按声明顺序、不按场景过滤、不截断、标明是 Owner 原文），
//     要么 null + 固定原因串——绝不静默省略，绝不截半句。
//   - 出错只降级本字段：构造/渲染的任何失败都变成 {rules:null, rulesReason,
//     now:null} 或一行不可用行，绝不把已受理的派发或会审折成错误回执。
//   - 只陈列，不是推荐：WAO 自己的固定措辞不出现"更便宜/建议/应该"（不变量 4/6）；
//     规则原文照录（那是 Owner 的话，提及其他车道不算 WAO 推荐）。
//   - 依赖边（test/registry-roles/laneTraits.test.js 钉）：本模块只准被
//     src/commands/run.js、src/mcp/server.js 与 src/application/consultService.js
//     引用；本模块引用 laneProfile（画像读取与投影的唯一归宿）。
import {
  readLaneTraits,
  projectLaneProfiles,
  OWNER_RULES_CAP,
  OWNER_RULE_MAX_CHARS,
  PROJECTION_ROWS_CAP,
  QUOTA_POOL_MAX_CHARS,
  HOLIDAYS_NOTE,
} from "./laneProfile.js";
import { loadLanesConfig } from "../dispatchResolution.js";
import { escapeControlChars } from "../safeText.js";

// MCP 出参 schema 派生用的上限（laneProfile SSOT 经本模块转出，不复制第二份数值）。
export { OWNER_RULES_CAP, OWNER_RULE_MAX_CHARS, PROJECTION_ROWS_CAP, QUOTA_POOL_MAX_CHARS };
// 法定节假日口径的文字形式只有一个家（laneProfile，与投影 holidaysRecognized 同处）：
// 这里 re-export 给渲染侧与测试引用（不是第二份定义）；wao lanes 经 lanesView 取同一常量。
export { HOLIDAYS_NOTE };

// ── WAO 固定措辞：各定义一次，本模块是唯一归宿 ─────────────────────────────

/** 规则块标头（标明是 Owner 原文、按声明顺序）。 */
export const OWNER_RULES_HEADER = "以下为 Owner 原文（车道规则，按声明顺序）：";
/** 规则不可用的固定原因串（读不出、不合法、为空，或生成途中的任何失败）。 */
export const RULES_UNAVAILABLE_REASON = "ownerRules 缺失、不合法、为空或读取失败";
/** 规则不可用时的整行固定文案。 */
export const RULES_UNAVAILABLE_LINE = `车道规则不可用：${RULES_UNAVAILABLE_REASON}`;
/** 会审回执容量的第二个固定原因串（修正一）：整份回执放不下完整规则时，laneRules
 * 换成 {rules:null, rulesReason:本串, now:null}——帽不抬、规则原文不截断。 */
export const RULES_RECEIPT_CAPACITY_REASON = "回执容量不足，规则原文见 lead_preflight 的 lanes.ownerRules";
/** now.beijing 标签的 wire 上限（"周四 22:15"=7 码元；宽裕上界）。 */
export const BEIJING_LABEL_MAX_CHARS = 16;
/** peaks 行里车道键/池成员的 wire 上限（投影行 id 同界的宽裕上界）。 */
export const PEAK_LANE_ID_MAX_CHARS = 64;

/** 整字段降级形（fail-degrade：受理照常，绝不上抛）。 */
function degraded() {
  return { rules: null, rulesReason: RULES_UNAVAILABLE_REASON, now: null };
}

/**
 * 降级形构造（出口对注入缝兜底用）：出口调用构造函数那一跳若意外抛错
 * （生产实现不会抛；防注入/未来改动），出口用这个拿同一降级形——仍是同一份
 * 固定措辞，不在出口各写一份。
 */
export function degradedLaneRules() {
  return degraded();
}

/**
 * 会审回执容量降级形（修正一）：整份回执放不下完整的 laneRules 时，由回执组装处
 * （projectConsultReceipt，唯一一处）换成这个——具名原因指向 lead_preflight 里
 * 同一份 Owner 规则原文；帽不抬、规则原文不截断。形状仍过 MCP schema。
 */
export function receiptCapacityLaneRules() {
  return { rules: null, rulesReason: RULES_RECEIPT_CAPACITY_REASON, now: null };
}

/**
 * 构造 laneRules（单一构造函数）。规则原文 + 此刻高峰快照，全部经
 * projectLaneProfiles 投影取得（与 wao lanes、lead_preflight 同一投影）；
 * `now` 沿用投影现有结构（beijing、holidaysRecognized）加 peaks（同池合并行，
 * 值就是投影行同格的 peakNow），不造第二种格式。任何失败 → 降级形，不抛。
 * @param {object} [opts]
 * @param {object} [opts.lanesDoc] 车道表（缺省 loadLanesConfig()；派发面传入本次
 *   调用实际使用的表——非默认 --registry 时表停用，随之降级）
 * @param {object} [opts.traitsResult] readLaneTraits 结果（缺省真实读取；测试缝）
 * @param {Function} [opts.nowMsFn] "此刻"时钟缝（缺省 Date.now）
 * @returns {{rules:string[]|null, rulesReason?:string,
 *   now:{beijing:string, holidaysRecognized:boolean,
 *   peaks:({pool:string, lanes:string[], peakNow:object}|{lane:string, peakNow:object})[]}|null}}
 */
export function buildLaneRules({ lanesDoc, traitsResult, nowMsFn = Date.now } = {}) {
  try {
    const lanes = lanesDoc ?? loadLanesConfig();
    const traits = traitsResult ?? readLaneTraits();
    const nowMs = nowMsFn();
    const projection = projectLaneProfiles({ lanesDoc: lanes, traitsResult: traits, nowMs });
    if (projection == null) return degraded();
    // rules：null（缺失/不合法）与空数组同样如实降级（不为空集造默认规则）。
    const rules = Array.isArray(projection.ownerRules) && projection.ownerRules.length > 0
      ? projection.ownerRules
      : null;
    const now = { ...projection.now, peaks: projection.poolPeaks };
    return rules == null
      ? { rules: null, rulesReason: RULES_UNAVAILABLE_REASON, now }
      : { rules, now };
  } catch {
    // 时钟/读取/形状的任何意外都只降级本字段——已受理的派发/会审绝不变错误回执。
    return degraded();
  }
}

/** 单条高峰行 → 一行文字（peakNow 措辞与 laneFactsLine 的"此刻"段同一形制）。 */
function renderPeakRow(row) {
  const seg = row.peakNow?.state === "peak"
    ? `此刻高峰（至 ${row.peakNow?.untilLocal ?? "?"}）`
    : `此刻非高峰（至 ${row.peakNow?.untilLocal ?? "?"}）`;
  if (row.pool != null && Array.isArray(row.lanes)) {
    return `额度池 ${row.pool}（${row.lanes.join("、")}）：${seg}`;
  }
  return `车道 ${row.lane}：${seg}`;
}

/**
 * 渲染 stderr 的那几行（单一渲染函数；`[wao] ` 前缀由调用方加）。规则每条一行
 * （带序号、按声明序、不截断）；"此刻"一行带北京时间与节假日口径，其后每池/每
 * 车道一行。降级时：规则块换成一行不可用行；now:null 时无此刻段。任何输入意外
 * → 一行不可用行（不抛）。
 * @param {object|null} laneRules buildLaneRules 的产物
 * @returns {string[]}
 */
export function renderLaneRulesLines(laneRules) {
  try {
    if (laneRules == null || typeof laneRules !== "object") return [RULES_UNAVAILABLE_LINE];
    const lines = [];
    if (laneRules.rules == null) {
      lines.push(RULES_UNAVAILABLE_LINE);
    } else {
      lines.push(OWNER_RULES_HEADER);
      laneRules.rules.forEach((rule, i) => { lines.push(`${i + 1}. ${rule}`); });
    }
    if (laneRules.now != null) {
      lines.push(`此刻（北京时间 ${laneRules.now.beijing}；${HOLIDAYS_NOTE}）：`);
      for (const row of laneRules.now.peaks ?? []) lines.push(renderPeakRow(row));
    }
    // 动态内容（磁盘上的不可信文本）可见化——不增殖行数（TD-318/319）。
    return lines.map(escapeControlChars);
  } catch {
    return [RULES_UNAVAILABLE_LINE];
  }
}
