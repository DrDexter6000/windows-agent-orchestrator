// src/application/laneProfile.js
//
// 车道画像（schemaVersion 2，决定 0087；costTier/score/ownerRules 见 0097）的
// 加载、校验、待复核判定与 lead_preflight 紧凑投影。每格带星级与依据
// （measured/official/owner）；打分身份与车道表不一致，或写了 reviewPending，
// 即待复核。
//
// 定位与边界（0087 §5；0097 修订）：
//   - 画像文件名字面量只出现在本模块（隔离守卫 test/registry-roles/laneTraits.test.js
//     白名单只含本文件）；本模块只准被 src/application/lanesView.js（wao lanes
//     视图）、src/application/leadPreflight.js（preflight 聚合器）与
//     src/application/laneFactsLine.js（派发受理回显行，0097）引用。
//   - 画像不进派发解析、门禁、认证与运行时行为；投影出现在 lead_preflight.lanes
//     一处 MCP 出参里，laneFactsLine 只从投影派生一行文字（0097 §5 修订）。
//   - WAO 不按星级排序、不推荐、不路由；未评格不折算成任何星数。
//   - 本模块除加载器（readLaneTraits，readFileFn 可注入）外全部纯函数。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// laneAxes：车道侧四轴（backend/modelId/providerID/effort，null 归一）——与
// explicit 派发 G4、wao lanes 接线轴同一判定来源，不造第二份比较规则。
import { laneAxes, validDispatchHold } from "../dispatchResolution.js";
// 推断族系（0090：会审选不同族系的副审时参考；展示专用非契约，见 modelFamily.js）。
import { modelFamilyOf, familyLabel } from "./modelFamily.js";
// TD-318（二）：画像 JSON 的解析失败不许带出源文本（V8 报错自带原文片段，
// 会随 issues 进 wao lanes 输出；registry 文件同一问题，src/safeText.js）。
import { safeJsonParse } from "../safeText.js";

const WAO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ===== 闭集常量（SSOT——MCP 层的 zod enum 从这里派生，不复制第二份清单） =====

/** 七个评分维度的固定键序（schemaVersion 2 闭集；行/投影都按此序）。 */
export const RATING_DIMENSIONS = Object.freeze([
  "research", "code", "review", "design", "longHorizon", "writing", "visual",
]);

/** 可带 score 的维度（0097）：计数分数只出现在这三个实测维度。MCP 出参 schema
 *  只在这三格放行 score，并从本常量派生——文件校验与 schema 同一清单。 */
export const SCORED_DIMENSIONS = Object.freeze(["research", "code", "review"]);

/** 七个维度的中文名（只在本模块定义一次；视图层与投影都从这里取）。 */
export const DIMENSION_LABELS = Object.freeze({
  research: "调研整理",
  code: "写代码",
  review: "抓 bug/把关",
  design: "方案设计",
  longHorizon: "长程自主",
  writing: "文案",
  visual: "视觉设计",
});

/** 每格依据闭集：measured=Lead 实测（带 n 与 evidence）、official=官方出处、
 *  owner=Owner 体感。 */
export const RATING_BASES = Object.freeze(["measured", "official", "owner"]);

/** ratingsState 闭集：unrated=七格全未评；current=已评且身份一致无待复核；
 *  review=身份不一致或写了 reviewPending；unknown=车道侧事实不可得。 */
export const RATINGS_STATES = Object.freeze(["unrated", "current", "review", "unknown"]);

/** 紧凑投影的行数上限（防异常膨胀；真实车道表远小于此）。 */
export const PROJECTION_ROWS_CAP = 16;

// 画像字段的上限只写在这里：文件校验、紧凑投影的截断，以及 MCP 出参 schema
// （经聚合器转出）都引用这一组值，两层各自把关但数值不会各写一份。
/** 每条车道的注意事项条数（lead_preflight 全部投影；取值见 0088 修订条）。 */
export const CAVEATS_CAP = 6;
/** 每条注意事项的字符数。 */
export const CAVEAT_MAX_CHARS = 120;
/** reviewPending 与投影里每条待复核原因的字符数。 */
export const REVIEW_REASON_MAX_CHARS = 160;
/** 投影里待复核原因的条数。 */
export const REVIEW_REASONS_CAP = 4;
/** cost 的字符数。 */
export const COST_MAX_CHARS = 200;
/** 投影时每格备注截到的字符数（文件里的备注上限另见 validateRatingCell）。 */
export const PROJECTED_NOTE_MAX_CHARS = 80;
/** 投影里刻度行的字符数。 */
export const SCALE_MAX_CHARS = 240;
// 0097（选车道的关键事实）：以下上限同样只写在这里，MCP 出参 schema 经聚合器
// 转出后引用同一组值。
/** costTier 上限（Owner 相对档 0.5–5、步长 0.5；只有 Owner 改）。 */
export const COST_TIER_MAX = 5;
/** costTierScale 说明串的字符数。 */
export const COST_TIER_SCALE_MAX_CHARS = 160;
/** ownerRules 的条数上限（有序，排在前面的优先）。 */
export const OWNER_RULES_CAP = 8;
/** 每条 Owner 规则的字符数（复用注意事项的单条上限）。 */
export const OWNER_RULE_MAX_CHARS = CAVEAT_MAX_CHARS;
/** score.label 的字符数（只给同样本的实测格）。 */
export const SCORE_LABEL_MAX_CHARS = 16;
/** 投影携带的画像观察条数上限（costTier/ownerRules 降级一类）。 */
export const PROJECTION_NOTICES_CAP = 8;
/** 每条投影观察的字符数。 */
export const PROJECTION_NOTICE_MAX_CHARS = 160;

/** 车道级键闭集（schemaVersion 2）。出现未知键即该车道 invalid。 */
const LANE_ENTRY_KEYS = new Set([
  "ratings", "ratedAgainst", "reviewPending", "cost", "costTier",
  "caveats", "contextWindow", "multimodal", "concurrencyNote", "effortNote",
]);

/** 每格键闭集。 */
const RATING_CELL_KEYS = new Set(["stars", "basis", "n", "note", "evidence", "score"]);

/** ratedAgainst 键闭集（恰好四键）。 */
const RATED_AGAINST_KEYS = new Set(["backend", "modelId", "providerID", "effort"]);

const isStr = (v, min, max) => typeof v === "string" && v.length >= min && v.length <= max;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasOnly = (obj, allowed) => isPlainObject(obj) && Object.keys(obj).every((k) => allowed.has(k));
// 0097：ownerRules/score.label 不含控制字符（磁盘上的不可信文本，同 TD-318 的
// 纪律——不让控制字节混进投影）。
const hasControlChars = (v) => typeof v === "string" && /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(v);

/** costTier 合法形（0097）：null，或 0.5–5、步长 0.5 的有限数。 */
export function validCostTier(v) {
  return v === null
    || (Number.isFinite(v) && v > 0 && v <= COST_TIER_MAX && Number.isInteger(v * 2));
}

/** score 合法形（0097）：恰好 {hits,total,label} 三键，只许出现在 measured 格。 */
function validScore(v) {
  return isPlainObject(v)
    && Object.keys(v).length === 3
    && Number.isInteger(v.hits) && Number.isInteger(v.total)
    && v.total >= 1 && v.hits >= 0 && v.hits <= v.total
    && isStr(v.label, 1, SCORE_LABEL_MAX_CHARS) && !hasControlChars(v.label);
}

/** 单格形状校验：未评 {stars:null,basis:null}（不许带别的键）或已评
 *  （stars 1–5 整数、basis 必填、按 basis 的 n/evidence 规则；score 只许
 *  measured 格且形状见 validScore——不合法即整格 invalid，按现有格级纪律
 *  连带整条车道降级 invalid，投影省略该行）。
 *  返回 {ok:true, cell} 或 {ok:false, field}。 */
function validateRatingCell(cell) {
  if (!isPlainObject(cell)) return { ok: false, field: "(非对象)" };
  for (const k of Object.keys(cell)) {
    if (!RATING_CELL_KEYS.has(k)) return { ok: false, field: `ratings 未知键 ${k}` };
  }
  if (cell.stars === null && cell.basis === null) {
    if ("n" in cell || "note" in cell || "evidence" in cell || "score" in cell) {
      return { ok: false, field: "未评格不许带 n/note/evidence/score" };
    }
    return { ok: true, cell: { stars: null, basis: null } };
  }
  if (!Number.isInteger(cell.stars) || cell.stars < 1 || cell.stars > 5) {
    return { ok: false, field: "stars 须为 1–5 的整数" };
  }
  if (!RATING_BASES.includes(cell.basis)) {
    return { ok: false, field: "basis 须为 measured/official/owner" };
  }
  if (cell.note !== undefined && !isStr(cell.note, 1, 100)) {
    return { ok: false, field: "note 须为 1–100 字符" };
  }
  if (cell.evidence !== undefined && !isStr(cell.evidence, 1, 200)) {
    return { ok: false, field: "evidence 须为 1–200 字符" };
  }
  if ("score" in cell) {
    if (cell.basis !== "measured") return { ok: false, field: "score 只许出现在 measured 格" };
    if (!validScore(cell.score)) return { ok: false, field: "score 须为 {hits,total,label}（整数、total≥1、0≤hits≤total、label 无控制字符）" };
  }
  const hasN = "n" in cell;
  if (cell.basis === "measured") {
    if (!hasN || !Number.isInteger(cell.n) || cell.n < 1) {
      return { ok: false, field: "measured 须带正整数 n" };
    }
    if (cell.evidence === undefined) return { ok: false, field: "measured 须带 evidence" };
  } else {
    if (hasN) return { ok: false, field: `${cell.basis} 不许带 n` };
    if (cell.basis === "official" && cell.evidence === undefined) {
      return { ok: false, field: "official 须带 evidence" };
    }
  }
  return {
    ok: true,
    cell: {
      stars: cell.stars,
      basis: cell.basis,
      ...(hasN ? { n: cell.n } : {}),
      ...(cell.note !== undefined ? { note: cell.note } : {}),
      ...(cell.evidence !== undefined ? { evidence: cell.evidence } : {}),
      ...("score" in cell ? { score: { hits: cell.score.hits, total: cell.score.total, label: cell.score.label } } : {}),
    },
  };
}

/** traits 单车道形状校验（schemaVersion 2）。任一项不合规即整条车道降级
 *  invalid——不造默认值（与 v1 同纪律）。唯一例外（0097）：costTier 不合法
 *  只把该格当 null 并记一条观察，车道照常投影。纯函数：
 *  返回 {ok:true, entry, observations:[...]} 或 {ok:false, fields:[...]}。 */
export function validateTraitEntry(id, entry) {
  void id; // 键名只在 issue 文案里用（调用方拼），校验本身与 id 无关
  const bad = [];
  const observations = [];
  if (!isPlainObject(entry)) return { ok: false, fields: ["(非对象)"] };
  for (const k of Object.keys(entry)) {
    if (!LANE_ENTRY_KEYS.has(k)) bad.push(`未知键 ${k}`);
  }
  // ratings：恰好七个维度键。
  if (!isPlainObject(entry.ratings)) bad.push("ratings");
  else {
    const keys = Object.keys(entry.ratings);
    for (const d of RATING_DIMENSIONS) {
      if (!keys.includes(d)) bad.push(`ratings 缺 ${d}`);
    }
    for (const k of keys) {
      if (!RATING_DIMENSIONS.includes(k)) bad.push(`ratings 多键 ${k}`);
    }
    if (keys.length === RATING_DIMENSIONS.length && RATING_DIMENSIONS.every((d) => keys.includes(d))) {
      for (const d of RATING_DIMENSIONS) {
        const v = validateRatingCell(entry.ratings[d]);
        if (!v.ok) bad.push(`ratings.${d}（${v.field}）`);
        else if (v.cell.score !== undefined && !SCORED_DIMENSIONS.includes(d)) {
          bad.push(`ratings.${d}（score 只许出现在 ${SCORED_DIMENSIONS.join("/")} 格）`);
        }
      }
    }
  }
  const anyRated = isPlainObject(entry.ratings) && RATING_DIMENSIONS.some(
    (d) => isPlainObject(entry.ratings[d]) && entry.ratings[d].stars !== null && entry.ratings[d].stars !== undefined,
  );
  // ratedAgainst：有已评格必填（四键闭集），全未评必须为 null。
  if (anyRated) {
    if (!isPlainObject(entry.ratedAgainst)) bad.push("ratedAgainst（有已评格时必填）");
    else {
      const rk = Object.keys(entry.ratedAgainst);
      for (const k of RATED_AGAINST_KEYS) if (!rk.includes(k)) bad.push(`ratedAgainst 缺 ${k}`);
      for (const k of rk) if (!RATED_AGAINST_KEYS.has(k)) bad.push(`ratedAgainst 未知键 ${k}`);
      if (isPlainObject(entry.ratedAgainst)) {
        if (!isStr(entry.ratedAgainst.backend, 1, Infinity)) bad.push("ratedAgainst.backend");
        if (!isStr(entry.ratedAgainst.modelId, 1, Infinity)) bad.push("ratedAgainst.modelId");
        for (const k of ["providerID", "effort"]) {
          const v = entry.ratedAgainst[k];
          if (v !== null && typeof v !== "string") bad.push(`ratedAgainst.${k}`);
        }
      }
    }
  } else if (entry.ratedAgainst !== null) {
    bad.push("ratedAgainst（全未评时必须显式为 null）");
  }
  if (entry.reviewPending !== undefined && !isStr(entry.reviewPending, 1, REVIEW_REASON_MAX_CHARS)) bad.push("reviewPending");
  if (entry.cost !== null && entry.cost !== undefined && !isStr(entry.cost, 1, COST_MAX_CHARS)) bad.push("cost");
  if (entry.cost === undefined) bad.push("cost");
  if (!Array.isArray(entry.caveats) || entry.caveats.length > CAVEATS_CAP
    || entry.caveats.some((c) => !isStr(c, 1, CAVEAT_MAX_CHARS))) bad.push("caveats");
  // contextWindow / multimodal / effortNote / concurrencyNote：沿用 v1 规则。
  const cw = entry.contextWindow;
  if (!cw || typeof cw !== "object" || Array.isArray(cw) || !Number.isInteger(cw.tokens) || cw.tokens <= 0
    || typeof cw.source !== "string") bad.push("contextWindow");
  const mm = entry.multimodal;
  if (!mm || typeof mm !== "object" || Array.isArray(mm) || typeof mm.image !== "boolean"
    || typeof mm.video !== "boolean" || typeof mm.source !== "string") bad.push("multimodal");
  if (entry.effortNote !== undefined && typeof entry.effortNote !== "string") bad.push("effortNote");
  if (entry.concurrencyNote !== undefined && typeof entry.concurrencyNote !== "string") bad.push("concurrencyNote");
  if (bad.length > 0) return { ok: false, fields: bad };
  // costTier（0097）：不合法只降级该格为 null + 一条观察，车道不消失。
  const costTierOk = entry.costTier === undefined || validCostTier(entry.costTier);
  const costTier = costTierOk ? (entry.costTier ?? null) : null;
  if (!costTierOk) observations.push("costTier 不合法，按未给（null）处理");
  const ratings = {};
  for (const d of RATING_DIMENSIONS) ratings[d] = validateRatingCell(entry.ratings[d]).cell;
  const ra = anyRated
    ? {
      backend: entry.ratedAgainst.backend,
      modelId: entry.ratedAgainst.modelId,
      providerID: entry.ratedAgainst.providerID ?? null,
      effort: entry.ratedAgainst.effort ?? null,
    }
    : null;
  return {
    ok: true,
    entry: {
      ratings,
      ratedAgainst: ra,
      ...(entry.reviewPending !== undefined ? { reviewPending: entry.reviewPending } : {}),
      cost: entry.cost,
      costTier,
      caveats: [...entry.caveats],
      contextWindow: {
        tokens: cw.tokens,
        source: cw.source,
        ...(typeof cw.shape === "string" ? { shape: cw.shape } : {}),
      },
      multimodal: { image: mm.image, video: mm.video, source: mm.source },
      ...(entry.effortNote !== undefined ? { effortNote: entry.effortNote } : {}),
      ...(entry.concurrencyNote !== undefined ? { concurrencyNote: entry.concurrencyNote } : {}),
    },
    observations,
  };
}

/** 顶层 scale 形状：恰好 "5".."1" 五键、值非空字符串。 */
function validScale(scale) {
  if (!isPlainObject(scale)) return false;
  const keys = Object.keys(scale);
  if (keys.length !== 5) return false;
  for (const k of ["5", "4", "3", "2", "1"]) {
    if (!keys.includes(k) || typeof scale[k] !== "string" || scale[k].length === 0) return false;
  }
  return true;
}

/**
 * 加载并形状校验 config/lane-traits.json（schemaVersion 2；读取根=WAO 安装根，
 * 与 loadLanesConfig 同纪律；readFileFn 可注入）。三态：ok（单车道形状错误降级
 * 为该车道 invalid + issue + invalidIds）/ unreadable（缺失或 JSON 不可解析）/
 * invalid（可解析但顶层形状坏——schemaVersion/scale/traits）。只读展示面：
 * 任何失败都不抛。ok 时额外携带 scale（五档刻度原文）、costTierScale 与
 * ownerRules（0097：顶层两键，坏值只降级自身并记观察）；observations 携带
 * 全部降级观察（costTier/ownerRules/costTierScale 一类，供视图与投影上报）。
 */
export function readLaneTraits(explicitPath, readFileFn = null) {
  const path = typeof explicitPath === "string"
    ? (isAbsolute(explicitPath) ? explicitPath : join(WAO_ROOT, explicitPath))
    : join(WAO_ROOT, "config", "lane-traits.json");
  const read = readFileFn ?? ((p) => readFileSync(p, "utf8"));
  let raw;
  try {
    raw = read(path);
  } catch {
    return { state: "unreadable", path, sha256: null, scale: null, costTierScale: null, ownerRules: [], traits: {}, invalidIds: [], issues: [`画像文件不可读：${path}`], observations: [] };
  }
  const text = typeof raw === "string" ? raw : String(raw);
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  let doc;
  try {
    // TD-318（二）：解析失败只报"lane-traits.json不是合法的 JSON（第 X 行第
    // Y 列）"，不携带源文本。
    doc = safeJsonParse(text, "lane-traits.json");
  } catch (e) {
    return { state: "unreadable", path, sha256, scale: null, costTierScale: null, ownerRules: [], traits: {}, invalidIds: [], issues: [e.message], observations: [] };
  }
  if (!isPlainObject(doc) || doc.schemaVersion !== 2 || !validScale(doc.scale)
    || !isPlainObject(doc.traits)) {
    return {
      state: "invalid", path, sha256, scale: null, costTierScale: null, ownerRules: [], traits: {}, invalidIds: [],
      issues: ["画像文件顶层形状错误（应含 schemaVersion 2、五档 scale、traits 对象）"],
      observations: [],
    };
  }
  // 0097 顶层两键：坏值只降级自身 + 一条观察，不连累 traits（与 costTier 同纪律）。
  const observations = [];
  const costTierScale = isStr(doc.costTierScale, 1, COST_TIER_SCALE_MAX_CHARS) && !hasControlChars(doc.costTierScale)
    ? doc.costTierScale
    : null;
  if (costTierScale === null) observations.push("costTierScale 缺失或不合法，按未给（null）处理");
  const ownerRulesValid = Array.isArray(doc.ownerRules) && doc.ownerRules.length <= OWNER_RULES_CAP
    && doc.ownerRules.every((r) => isStr(r, 1, OWNER_RULE_MAX_CHARS) && !hasControlChars(r));
  const ownerRules = doc.ownerRules === undefined ? [] : (ownerRulesValid ? [...doc.ownerRules] : null);
  if (doc.ownerRules !== undefined && ownerRules === null) observations.push("ownerRules 不合法，置 null（各车道行照常投影）");
  const traits = {};
  const invalidIds = [];
  const issues = [];
  for (const [id, entry] of Object.entries(doc.traits)) {
    const v = validateTraitEntry(id, entry);
    if (v.ok) {
      traits[id] = v.entry;
      for (const obs of v.observations) observations.push(`车道 ${id} 画像：${obs}`);
    } else {
      invalidIds.push(id);
      issues.push(`车道 ${id} 画像形状错误（${v.fields.join("/")}）`);
    }
  }
  return { state: "ok", path, sha256, scale: doc.scale, costTierScale, ownerRules, traits, invalidIds, issues, observations };
}

/** 把五档刻度拼成一行（视图表头与 preflight 投影共用）；末尾一句说明未评怎么表示。 */
export function buildScaleLine(scale, unratedNote = "null 未评") {
  if (!validScale(scale)) return null;
  return ["5", "4", "3", "2", "1"].map((k) => `${k} ${scale[k]}`).join("；") + `；${unratedNote}`;
}

/**
 * 判定一条（已校验的）画像条目相对当前车道声明的评分状态。纯函数。
 * @param {object} entry validateTraitEntry 归一后的条目
 * @param {object|null} lane config/lanes.json 的车道条目（null/undefined=车道侧
 *   事实不可得——条目缺失或车道表不可读，由调用方在能区分时另行报告）
 * @returns {{state:("unrated"|"current"|"review"|"unknown"), reasons:string[]}}
 *   待复核取"或"：身份不一致或写了 reviewPending 都是 review——删掉
 *   reviewPending 不能消除身份不一致（0087 §2）。
 */
export function ratingsState(entry, lane) {
  if (!isPlainObject(entry) || !isPlainObject(entry.ratings)) {
    return { state: "unknown", reasons: ["画像条目形状不可用——无法判定评分状态"] };
  }
  const anyRated = RATING_DIMENSIONS.some((d) => entry.ratings[d]?.stars !== null && entry.ratings[d]?.stars !== undefined);
  const pending = typeof entry.reviewPending === "string" && entry.reviewPending.length > 0;
  // 全未评的车道不参与身份比对，但 reviewPending 照样标待复核。
  if (!anyRated) return pending ? { state: "review", reasons: [entry.reviewPending] } : { state: "unrated", reasons: [] };
  if (!isPlainObject(lane)) {
    return { state: "unknown", reasons: ["车道表条目缺失或不可读——无法比对打分身份"] };
  }
  const reasons = [];
  const rated = entry.ratedAgainst ?? {};
  const declared = laneAxes(lane);
  const norm = (v) => (v === undefined ? null : v);
  for (const axis of ["backend", "modelId", "providerID", "effort"]) {
    const a = norm(rated[axis]);
    const b = declared[axis];
    if (a !== b) reasons.push(`${axis}：打分时 ${a === null ? "null" : a}，现为 ${b === null ? "null" : b}`);
  }
  if (pending) reasons.push(entry.reviewPending);
  return reasons.length > 0 ? { state: "review", reasons } : { state: "current", reasons: [] };
}

/** 车道的推断族系展示标签：由车道表的 backend 与 modelId 推断（0090）。 */
export function laneFamilyLabel(lane) {
  const axes = laneAxes(lane);
  return familyLabel(modelFamilyOf({ modelId: axes.modelId, backend: axes.backend }));
}

/** 应用层截断：超长截成 max-1 字符加"…"（总长=max），不超长原样。 */
function clip(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

/**
 * lead_preflight 的紧凑投影（0087 §4；caveats 全部带上，见 0088；未评格不投影、
 * 每行带暂停说明、上下文窗口与能否看图，见 0089；推断族系见 0090；行带
 * costTier、格带 score、顶层带 costTierScale 与 ownerRules，见 0097）。行序=
 * lanes.json 声明序；只含车道表里有画像的车道；不排序、不加推荐字段。所有
 * 字符串在应用层截到 MCP schema 上限，保证投影总能通过校验。
 * @returns {{scale:string, dimensionLabels:Object, costTierScale:(string|null),
 *   ownerRules:(string[]|null), rows:object[], omittedLaneIds:string[],
 *   notices:string[]}|null}
 *   单车道 invalid 时省略该行并把 id 放进 omittedLaneIds（供调用方写观察）；
 *   notices 携带降级观察（0097：costTier/ownerRules/costTierScale 一类，有界）；
 *   画像文件不可读/不合法或车道表不可用时返回 null。
 */
export function projectLaneProfiles({ lanesDoc, traitsResult }) {
  if (!traitsResult || traitsResult.state !== "ok" || traitsResult.scale == null) return null;
  if (!lanesDoc || lanesDoc.ok !== true || lanesDoc.sha256 == null || !Array.isArray(lanesDoc.lanes)) return null;
  const scaleLine = buildScaleLine(traitsResult.scale, "未列出的维度＝未评");
  if (scaleLine == null) return null;
  const rows = [];
  const laneList = lanesDoc.lanes;
  for (const lane of laneList) {
    const id = lane?.id;
    if (typeof id !== "string") continue; // 结构守卫已在 loadLanesConfig 报过
    if (!Object.prototype.hasOwnProperty.call(traitsResult.traits, id)) continue;
    if (rows.length >= PROJECTION_ROWS_CAP) break;
    const entry = traitsResult.traits[id];
    const rs = ratingsState(entry, lane);
    const ratings = {};
    for (const d of RATING_DIMENSIONS) {
      const cell = entry.ratings[d];
      if (cell.stars === null) continue; // 未评不投影：dimensionLabels 列全七项，缺席即未评
      ratings[d] = {
        stars: cell.stars,
        basis: cell.basis,
        n: cell.n ?? null,
        note: cell.note == null ? null : clip(cell.note, PROJECTED_NOTE_MAX_CHARS),
        ...(cell.score !== undefined ? {
          score: {
            hits: cell.score.hits,
            total: cell.score.total,
            label: clip(cell.score.label, SCORE_LABEL_MAX_CHARS),
          },
        } : {}),
      };
    }
    rows.push({
      id,
      family: laneFamilyLabel(lane),
      costTier: entry.costTier ?? null,
      ratings,
      ratingsState: rs.state,
      reviewReasons: rs.reasons.slice(0, REVIEW_REASONS_CAP).map((s) => clip(s, REVIEW_REASON_MAX_CHARS)),
      caveats: [...entry.caveats],
      cost: entry.cost,
      dispatchHold: validDispatchHold(lane.dispatchHold),
      contextWindowTokens: entry.contextWindow.tokens,
      imageInput: entry.multimodal.image,
    });
  }
  // invalid 车道：形状错误被加载器降级的、且确实在车道表里的——省略行 + 回传 id。
  const tableIds = new Set(laneList.map((l) => l?.id).filter((x) => typeof x === "string"));
  const omittedLaneIds = (traitsResult.invalidIds ?? []).filter((id) => tableIds.has(id));
  const notices = (traitsResult.observations ?? [])
    .slice(0, PROJECTION_NOTICES_CAP)
    .map((s) => clip(s, PROJECTION_NOTICE_MAX_CHARS));
  return {
    scale: clip(scaleLine, SCALE_MAX_CHARS),
    dimensionLabels: { ...DIMENSION_LABELS },
    costTierScale: traitsResult.costTierScale == null
      ? null
      : clip(traitsResult.costTierScale, COST_TIER_SCALE_MAX_CHARS),
    ownerRules: traitsResult.ownerRules == null
      ? null
      : [...traitsResult.ownerRules].map((r) => clip(r, OWNER_RULE_MAX_CHARS)),
    rows,
    omittedLaneIds,
    notices,
  };
}
