// src/application/laneFactsLine.js
//
// 0097 §4（修订 0087 §5）：派发受理那一刻，把所选车道的关键事实拼成一行文字
// 回显给 Lead——CLI `wao run` 打到 stderr（带 `[wao] ` 前缀），MCP run_dispatch
// 受理回执带可选字段 laneFacts（同一行文字，不带前缀）。
//
// 契约（决定 0097）：
//   - 只陈列，不是推荐：不出现其他车道名，不出现"更便宜""建议""应该"一类词；
//     WAO 不排序、不路由（不变量 4/6）。只列这条车道已评的维度（Owner 评的写
//     "（Owner）"，未评的不列）；成本档 null 写"成本档未给"；评分待复核写
//     "评分待复核"。
//   - 一行、无换行，长度上限 LANE_FACTS_LINE_MAX_CHARS（≤480 字）。动态内容
//     （车道键等磁盘上的不可信文本）经 escapeControlChars 转义（TD-318/319）。
//   - fail-open：画像读失败或车道不在画像里返回 null，派发照常——本模块的
//     任何失败都不影响派发结果。
//   - 依赖边（test/registry-roles/laneTraits.test.js 钉）：本模块只准被
//     src/commands/run.js 与 src/mcp/server.js 引用；画像只经
//     laneProfile.js 的读取与投影（本模块不出现画像文件名字面量）。
import {
  readLaneTraits,
  projectLaneProfiles,
  RATING_DIMENSIONS,
  DIMENSION_LABELS,
} from "./laneProfile.js";
import { loadLanesConfig } from "../dispatchResolution.js";
import { escapeControlChars } from "../safeText.js";

/** 回显行的长度上限（决定 0097：≤480 字）。MCP 出参 schema 引用同一常量。 */
export const LANE_FACTS_LINE_MAX_CHARS = 480;

/** 评分状态的一词事实（closed set 派生，不造第二种说法）。 */
const RATINGS_STATE_FACTS = Object.freeze({
  current: "评分当前",
  review: "评分待复核",
  unrated: "评分未评",
  unknown: "评分无法判定",
});

// 超长截成 max-1 字符加"…"（总长=max），与 laneProfile 的投影截断同一形制。
function clip(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

/**
 * 所选车道一行事实（只陈列，不是推荐）。输入车道 id，输出一行文字或 null。
 * @param {string} laneId 车道键（explicit/alias 解析所得，或 agentId 直派的键）
 * @param {object} [opts]
 * @param {object} [opts.lanesDoc] 车道表（缺省 loadLanesConfig()；派发面传入
 *   本次调用实际使用的表——非默认 --registry 时表停用，回显随之缺省）
 * @param {object} [opts.traitsResult] readLaneTraits 结果（缺省真实读取；测试缝）
 * @returns {string|null} 一行文字；画像不可用、车道不在画像里、任何读取失败
 *   → null（fail-open，派发照常）
 */
export function laneFactsLine(laneId, opts = {}) {
  // opts 在 try 内取——连调用方传入的异常 getter 也吞掉（fail-open 的兜底）。
  try {
    const { lanesDoc, traitsResult } = opts;
    if (typeof laneId !== "string" || laneId.length === 0) return null;
    const lanes = lanesDoc ?? loadLanesConfig();
    const traits = traitsResult ?? readLaneTraits();
    const projection = projectLaneProfiles({ lanesDoc: lanes, traitsResult: traits });
    if (projection == null) return null;
    const row = projection.rows.find((r) => r && r.id === laneId);
    if (row == null) return null;
    const parts = [];
    parts.push(row.costTier == null
      ? "成本档未给"
      : `成本档 ${row.costTier}（Owner 相对档 0.5–5，非价格倍数）`);
    for (const d of RATING_DIMENSIONS) {
      const cell = row.ratings[d];
      if (cell == null) continue; // 未评的维度不列
      const label = DIMENSION_LABELS[d];
      if (cell.basis === "owner") {
        parts.push(`${label} ${cell.stars}★（Owner）`);
      } else if (cell.basis === "measured") {
        const scoreText = cell.score ? `，${cell.score.hits}/${cell.score.total}` : "";
        parts.push(`${label} ${cell.stars}★（n=${cell.n ?? "?"}${scoreText}）`);
      } else {
        parts.push(`${label} ${cell.stars}★（official）`);
      }
    }
    const stateText = RATINGS_STATE_FACTS[row.ratingsState] ?? `评分状态 ${row.ratingsState}`;
    const line = `所选车道事实（只陈列，不是推荐）：${laneId} · ${parts.join(" · ")} · `
      + `${stateText}；Owner 规则见 lead_preflight 的 lanes.ownerRules`;
    return clip(escapeControlChars(line), LANE_FACTS_LINE_MAX_CHARS);
  } catch {
    // fail-open：任何失败（读文件抛错、形状意外）都只省略这一行。
    return null;
  }
}
