// test/application/laneProfile.test.js
//
// 0087：车道画像（schemaVersion 2）模块钉——校验、待复核判定、preflight 投影
// 与聚合器/MCP 边界的可证伪面：
//   - 校验：每条形状规则正例+反例（未评带 n、measured 缺 n、owner 带 n、
//     ratings 少/多键、车道级未知键、星级 0/6、ratedAgainst 与评分状态矛盾、
//     各长度界、顶层 schemaVersion/scale）；
//   - ratingsState：四种状态、四轴各自不一致、undefined/null 空值归一不算
//     不同、reviewPending 并入 reasons、身份不一致而无 reviewPending 仍 review；
//   - 投影：行序=lanes.json 声明序、caveats 全部投影、null 原样、未评格不投影、
//     每格只投影 {stars,basis,n,note} 且超长 note 截断、每行带暂停说明/上下文
//     窗口/能否看图、invalid 车道省略并回传 id、读失败返回 null；
//   - preflight：worker 上下文 lanes=null、lanes 独立结算（null 不改 complete、
//     不合格子 schema 置 null 不连累其余各节）、投影形状过 LEAD_PREFLIGHT_OUTPUT、
//     只有 lead_preflight 的出参 schema 含画像键。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateTraitEntry } from "../../src/application/laneProfile.js";
import { loadLanesConfig } from "../../src/dispatchResolution.js";
import {
  readLaneTraits,
  ratingsState,
  projectLaneProfiles,
  buildScaleLine,
  RATING_DIMENSIONS,
  DIMENSION_LABELS,
  PROJECTION_ROWS_CAP,
  CAVEATS_CAP,
  CAVEAT_MAX_CHARS,
  COST_MAX_CHARS,
  PROJECTED_NOTE_MAX_CHARS,
  REVIEW_REASON_MAX_CHARS,
  REVIEW_REASONS_CAP,
  SCALE_MAX_CHARS,
} from "../../src/application/laneProfile.js";
import { aggregateLeadPreflight } from "../../src/application/leadPreflight.js";

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ── 夹具 ─────────────────────────────────────────────────────────────────────

const unrated = () => ({ stars: null, basis: null });
const ratedCell = (over = {}) => ({ stars: 3, basis: "measured", n: 5, evidence: "提交 abc1234", ...over });

function validEntry(over = {}) {
  return {
    ratings: {
      research: unrated(), code: unrated(), review: unrated(), design: unrated(),
      longHorizon: unrated(), writing: unrated(), visual: unrated(),
    },
    ratedAgainst: null,
    cost: "按量计费",
    caveats: [],
    contextWindow: { tokens: 1000000, source: "official（测试）" },
    multimodal: { image: true, video: false, source: "official" },
    ...over,
  };
}

// 带一格已评的条目（ratedAgainst 默认与车道声明一致）。
function entryWithRating(cellOver = {}, raOver = {}) {
  return validEntry({
    ratings: {
      research: ratedCell(cellOver), code: unrated(), review: unrated(), design: unrated(),
      longHorizon: unrated(), writing: unrated(), visual: unrated(),
    },
    ratedAgainst: {
      backend: "zcode", modelId: "m1", providerID: null, effort: "max", ...raOver,
    },
  });
}

function validDoc(traits, over = {}) {
  return {
    schemaVersion: 2,
    scale: { "5": "最强", "4": "强", "3": "堪用", "2": "弱", "1": "不适合" },
    traits,
    ...over,
  };
}

const laneDoc = (lanesArr, opts = {}) => ({
  ok: opts.ok ?? true,
  sha256: "sha256" in opts ? opts.sha256 : "a".repeat(64),
  lanes: lanesArr,
  issues: opts.issues ?? [],
});
const LANE_A = { id: "la", backend: "zcode", model: { id: "m1" }, reasoning: { effort: "max" } };
const LANE_B = { id: "lb", backend: "codex", model: { id: "m2", providerID: "p2" }, reasoning: { effort: null } };

/** 经校验器归一的 entry（ratingsState/投影的输入形态与生产一致）。 */
function validated(entry) {
  const v = validateTraitEntry("x", entry);
  assert.equal(v.ok, true, `夹具必须合法：${JSON.stringify(v.fields ?? [])}`);
  return v.entry;
}

// ── 校验 ─────────────────────────────────────────────────────────────────────

test("validateTraitEntry：合法全形状（已评+未评混合）归一通过", () => {
  const v = validateTraitEntry("x", entryWithRating({ note: "样本内最稳" }));
  assert.equal(v.ok, true);
  assert.equal(v.entry.ratings.research.stars, 3);
  assert.equal(v.entry.ratings.code.stars, null);
  assert.equal(v.entry.ratedAgainst.providerID, null);
  // owner 合法形：不带 n、不带 evidence。
  const ownerEntry = entryWithRating();
  ownerEntry.ratings.research = { stars: 4, basis: "owner" };
  assert.equal(validateTraitEntry("x", ownerEntry).ok, true, "owner 不带 n/evidence 合法");
});

test("validateTraitEntry：未评格带 n/note/evidence 即 invalid", () => {
  for (const extra of [{ n: 3 }, { note: "x" }, { evidence: "y" }]) {
    const v = validateTraitEntry("x", validEntry({
      ratings: { ...validEntry().ratings, code: { stars: null, basis: null, ...extra } },
    }));
    assert.equal(v.ok, false, `未评带 ${JSON.stringify(extra)} 必须红`);
  }
});

test("validateTraitEntry：measured 缺 n 或缺 evidence 即 invalid", () => {
  const noN = entryWithRating();
  delete noN.ratings.research.n;
  assert.equal(validateTraitEntry("x", noN).ok, false, "measured 缺 n");
  const noEv = entryWithRating();
  delete noEv.ratings.research.evidence;
  assert.equal(validateTraitEntry("x", noEv).ok, false, "measured 缺 evidence");
});

test("validateTraitEntry：owner/official 带 n 即 invalid；official 缺 evidence 即 invalid", () => {
  const ownerWithN = entryWithRating({ basis: "owner" });
  assert.equal(validateTraitEntry("x", ownerWithN).ok, false, "owner 带 n");
  const officialWithN = entryWithRating({ basis: "official" });
  assert.equal(validateTraitEntry("x", officialWithN).ok, false, "official 带 n");
  const officialNoEv = entryWithRating({ basis: "official", evidence: undefined });
  delete officialNoEv.ratings.research.evidence;
  assert.equal(validateTraitEntry("x", officialNoEv).ok, false, "official 缺 evidence");
});

test("validateTraitEntry：ratings 少一键/多一键即 invalid", () => {
  const missing = entryWithRating();
  delete missing.ratings.visual;
  assert.equal(validateTraitEntry("x", missing).ok, false, "少 visual");
  const extra = entryWithRating();
  extra.ratings.extra = unrated();
  assert.equal(validateTraitEntry("x", extra).ok, false, "多 extra 键");
  // 每格键闭集：未知键即 invalid。
  const cellUnknown = entryWithRating();
  cellUnknown.ratings.research.confidence = 0.9;
  assert.equal(validateTraitEntry("x", cellUnknown).ok, false, "格内未知键");
});

test("validateTraitEntry：车道级未知键即 invalid", () => {
  const v = validateTraitEntry("x", validEntry({ suggestedUses: ["旧字段"] }));
  assert.equal(v.ok, false, "旧 v1 字段 suggestedUses 已退役");
});

test("validateTraitEntry：星级 0/6/非整数即 invalid；1/5 合法", () => {
  for (const stars of [0, 6, 2.5, "3"]) {
    assert.equal(validateTraitEntry("x", entryWithRating({ stars })).ok, false, `stars=${stars} 必须 red`);
  }
  assert.equal(validateTraitEntry("x", entryWithRating({ stars: 1 })).ok, true);
  assert.equal(validateTraitEntry("x", entryWithRating({ stars: 5 })).ok, true);
});

test("validateTraitEntry：ratedAgainst 与评分状态矛盾即 invalid", () => {
  // 有已评格但 ratedAgainst 为 null。
  const ratedNoRa = entryWithRating();
  ratedNoRa.ratedAgainst = null;
  assert.equal(validateTraitEntry("x", ratedNoRa).ok, false, "已评格必须带 ratedAgainst");
  // 全未评但 ratedAgainst 非 null。
  assert.equal(validateTraitEntry("x", validEntry({
    ratedAgainst: { backend: "zcode", modelId: "m1", providerID: null, effort: null },
  })).ok, false, "全未评时 ratedAgainst 必须 null");
  // 全未评但缺 ratedAgainst 键：必须显式写 null。
  const missingRa = validEntry();
  delete missingRa.ratedAgainst;
  assert.equal(validateTraitEntry("x", missingRa).ok, false, "全未评时 ratedAgainst 必须显式为 null，缺键不行");
  // 形状：缺键/多键/类型错。
  assert.equal(validateTraitEntry("x", entryWithRating({}, { modelId: undefined })).ok, false, "缺 modelId");
  assert.equal(validateTraitEntry("x", entryWithRating({}, { extra: 1 })).ok, false, "多键");
  assert.equal(validateTraitEntry("x", entryWithRating({}, { providerID: 42 })).ok, false, "providerID 非字符串非 null");
  assert.equal(validateTraitEntry("x", entryWithRating({}, { backend: "" })).ok, false, "backend 空串");
});

test("validateTraitEntry：长度界——note/evidence/cost/caveats/reviewPending；positioning 不是车道级键", () => {
  assert.equal(validateTraitEntry("x", validEntry({ positioning: "测试定位" })).ok, false,
    "一句定位已并入分项格、cost 与 caveats——出现即未知键");
  assert.equal(validateTraitEntry("x", entryWithRating({ note: "字".repeat(100) })).ok, true);
  assert.equal(validateTraitEntry("x", entryWithRating({ note: "字".repeat(101) })).ok, false);
  assert.equal(validateTraitEntry("x", entryWithRating({ evidence: "字".repeat(200) })).ok, true);
  assert.equal(validateTraitEntry("x", entryWithRating({ evidence: "字".repeat(201) })).ok, false);
  assert.equal(validateTraitEntry("x", validEntry({ cost: null })).ok, true, "cost null 合法");
  assert.equal(validateTraitEntry("x", validEntry({ cost: "字".repeat(COST_MAX_CHARS) })).ok, true);
  assert.equal(validateTraitEntry("x", validEntry({ cost: "字".repeat(COST_MAX_CHARS + 1) })).ok, false);
  assert.equal(validateTraitEntry("x", validEntry({ reviewPending: "待复核" })).ok, true);
  assert.equal(validateTraitEntry("x", validEntry({ reviewPending: "字".repeat(REVIEW_REASON_MAX_CHARS) })).ok, true);
  assert.equal(validateTraitEntry("x", validEntry({ reviewPending: "字".repeat(REVIEW_REASON_MAX_CHARS + 1) })).ok, false);
  const caveatsOf = (n) => Array.from({ length: n }, (_, i) => `c${i}`);
  assert.equal(validateTraitEntry("x", validEntry({ caveats: caveatsOf(CAVEATS_CAP) })).ok, true);
  assert.equal(validateTraitEntry("x", validEntry({ caveats: caveatsOf(CAVEATS_CAP + 1) })).ok, false, "caveats 至多 CAVEATS_CAP 条");
  assert.equal(validateTraitEntry("x", validEntry({ caveats: ["字".repeat(CAVEAT_MAX_CHARS)] })).ok, true);
  assert.equal(validateTraitEntry("x", validEntry({ caveats: ["字".repeat(CAVEAT_MAX_CHARS + 1)] })).ok, false, "单条注意事项超长");
  assert.equal(validateTraitEntry("x", validEntry({ caveats: [] })).ok, true);
});

test("validateTraitEntry：basis 闭集外即 invalid", () => {
  assert.equal(validateTraitEntry("x", entryWithRating({ basis: "vibe" })).ok, false);
});

test("readLaneTraits：schemaVersion/scale 顶层三态", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lp-top-"));
  try {
    const p = join(dir, "t.json");
    writeFileSync(p, JSON.stringify(validDoc({ a: validEntry() })), "utf8");
    const ok = readLaneTraits(p);
    assert.equal(ok.state, "ok");
    assert.ok(ok.traits.a);
    assert.equal(ok.invalidIds.length, 0);
    assert.ok(buildScaleLine(ok.scale).includes("5 最强"));

    writeFileSync(p, JSON.stringify(validDoc({ a: validEntry() }, { schemaVersion: 1 })), "utf8");
    assert.equal(readLaneTraits(p).state, "invalid", "schemaVersion 1");

    writeFileSync(p, "{ not json", "utf8");
    assert.equal(readLaneTraits(p).state, "unreadable");

    const badScale = (scale) => { writeFileSync(p, JSON.stringify(validDoc({ a: validEntry() }, { scale })), "utf8"); };
    badScale({ "5": "a", "4": "a", "3": "a", "2": "a" });
    assert.equal(readLaneTraits(p).state, "invalid", "scale 缺一档");
    badScale({ "5": "a", "4": "a", "3": "a", "2": "a", "1": "a", "6": "a" });
    assert.equal(readLaneTraits(p).state, "invalid", "scale 多一档");
    badScale({ "5": "", "4": "a", "3": "a", "2": "a", "1": "a" });
    assert.equal(readLaneTraits(p).state, "invalid", "scale 空值");

    // 单车道形状错误：文件级 ok、该车道降级 + issue + invalidIds。
    writeFileSync(p, JSON.stringify(validDoc({ a: validEntry(), b: { ...validEntry(), cost: 42 } })), "utf8");
    const mixed = readLaneTraits(p);
    assert.equal(mixed.state, "ok");
    assert.ok(mixed.traits.a);
    assert.deepEqual(mixed.invalidIds, ["b"]);
    assert.ok(mixed.issues.some((s) => s.includes("车道 b 画像形状错误")));
  } finally { cleanupDir(dir); }
});

// TD-318（二）：JSON.parse 的 V8 报错自带源文本片段——画像原文不得随 issues
// 进 wao lanes 输出（registry 文件同一问题）。
test("readLaneTraits：坏 JSON——unreadable 态的 issue 只有固定文案，不带源文本", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lp-badjson-"));
  try {
    const p = join(dir, "t.json");
    writeFileSync(p, '{"traits": {"LEAK_SENTINEL_TRAITS": undefined}}', "utf8");
    const r = readLaneTraits(p);
    assert.equal(r.state, "unreadable", "坏 JSON 与文件不可读同一态");
    const joined = r.issues.join("\n");
    assert.ok(!joined.includes("LEAK_SENTINEL_TRAITS"), `issue 不带源文本哨兵（实际：${joined}）`);
    assert.match(r.issues[0], /lane-traits\.json不是合法的 JSON/, "固定文案（文件名标签，无 V8 原文）");
  } finally { cleanupDir(dir); }
});

// ── ratingsState ─────────────────────────────────────────────────────────────

test("ratingsState：四种状态", () => {
  // unrated：七格全未评。
  assert.deepEqual(ratingsState(validated(validEntry()), LANE_A), { state: "unrated", reasons: [] });
  // current：已评且身份一致。
  assert.deepEqual(ratingsState(validated(entryWithRating()), LANE_A), { state: "current", reasons: [] });
  // review：身份不一致（见下）或 reviewPending（见下）。
  // unknown：车道条目缺失（车道表不可读同形——调用方传不进条目）。
  const u = ratingsState(validated(entryWithRating()), null);
  assert.equal(u.state, "unknown");
  assert.equal(u.reasons.length, 1);
});

test("ratingsState：backend/modelId/providerID/effort 各自不一致各产生一条 reason", () => {
  const cases = [
    [{ backend: "codex" }, /backend：打分时 codex，现为 zcode/],
    [{ modelId: "m9" }, /modelId：打分时 m9，现为 m1/],
    [{ providerID: "px" }, /providerID：打分时 px，现为 null/],
    [{ effort: "low" }, /effort：打分时 low，现为 max/],
  ];
  for (const [over, re] of cases) {
    const rs = ratingsState(validated(entryWithRating({}, over)), LANE_A);
    assert.equal(rs.state, "review", `不一致（${JSON.stringify(over)}）=review`);
    assert.equal(rs.reasons.length, 1, `恰好一条 reason（${JSON.stringify(over)}）`);
    assert.match(rs.reasons[0], re);
  }
});

test("ratingsState：一侧缺省（undefined）、另一侧 null 不算不同（空值归一）", () => {
  // ratedAgainst.providerID=undefined vs 车道声明 null：归一后相等。
  const ra = { backend: "zcode", modelId: "m1", effort: "max" };
  const entry = validated(entryWithRating({}, ra));
  assert.equal((entry.ratedAgainst ?? {}).providerID, null, "校验器已归一 undefined→null");
  assert.deepEqual(ratingsState(entry, LANE_A), { state: "current", reasons: [] });
  // 车道侧 reasoning 缺 effort（laneAxes 归一 null）vs 打分 null。
  const laneNoEffort = { id: "la", backend: "zcode", model: { id: "m1" } };
  const rs = ratingsState(validated(entryWithRating({}, { effort: null })), laneNoEffort);
  assert.deepEqual(rs, { state: "current", reasons: [] }, "两侧都归一成 null=一致");
});

test("ratingsState：reviewPending 原文并入 reasons；身份不一致而无 reviewPending 仍是 review", () => {
  const rs = ratingsState(validated(entryWithRating()), LANE_A);
  assert.equal(rs.state, "current", "无 reviewPending 且身份一致=current");

  const pending = validEntry({ reviewPending: "harness 升级，实测格待重测" });
  const rs2 = ratingsState(validated(pending), LANE_A);
  assert.equal(rs2.state, "review", "全未评只免身份比对，reviewPending 照样待复核");
  assert.deepEqual(rs2.reasons, ["harness 升级，实测格待重测"]);
  assert.equal(ratingsState(validated(validEntry()), LANE_A).state, "unrated", "全未评且无 reviewPending=unrated");

  const pendingRated = entryWithRating();
  pendingRated.reviewPending = "服务端换模型，实测格都是旧数据";
  const rs3 = ratingsState(validated(pendingRated), LANE_A);
  assert.equal(rs3.state, "review");
  assert.deepEqual(rs3.reasons, ["服务端换模型，实测格都是旧数据"], "reviewPending 原文进 reasons");

  const driftNoPending = entryWithRating({}, { modelId: "m-changed" });
  const rs4 = ratingsState(validated(driftNoPending), LANE_A);
  assert.equal(rs4.state, "review", "身份不一致没有 reviewPending 仍 review");
  assert.equal(rs4.reasons.length, 1);
});

// ── 投影 ─────────────────────────────────────────────────────────────────────

test("projectLaneProfiles：行序=lanes.json 声明序；只含有画像的车道", () => {
  const traits = { la: validEntry(), lb: entryWithRating() };
  const proj = projectLaneProfiles({
    lanesDoc: laneDoc([LANE_B, LANE_A]),
    traitsResult: { state: "ok", path: "t.json", sha256: "b".repeat(64), scale: validDoc({}).scale, traits, invalidIds: [], issues: [] },
  });
  assert.deepEqual(proj.rows.map((r) => r.id), ["lb", "la"], "行序=声明序（B 先声明）");
});

test("projectLaneProfiles：caveats 全部投影；未评格不投影、不折算；null 原样保留", () => {
  const entry = validEntry({
    cost: null,
    caveats: ["一", "二", "三", "四"],
  });
  const proj = projectLaneProfiles({
    lanesDoc: laneDoc([LANE_A]),
    traitsResult: { state: "ok", path: "t.json", sha256: "b".repeat(64), scale: validDoc({}).scale, traits: { la: entry }, invalidIds: [], issues: [] },
  });
  const row = proj.rows[0];
  assert.deepEqual(row.caveats, ["一", "二", "三", "四"], "caveats 全部投影，不截条数");
  assert.equal(row.cost, null, "cost null 原样");
  assert.equal(row.ratingsState, "unrated", "未评不折算");
  assert.deepEqual(row.ratings, {}, "七格全未评 → 一格都不投影");
  assert.ok(proj.scale.endsWith("未列出的维度＝未评"), "刻度行说明缺席即未评");

  const half = projectLaneProfiles({
    lanesDoc: laneDoc([LANE_A]),
    traitsResult: { state: "ok", path: "t.json", sha256: "b".repeat(64), scale: validDoc({}).scale, traits: { la: entryWithRating() }, invalidIds: [], issues: [] },
  });
  assert.deepEqual(Object.keys(half.rows[0].ratings), ["research"], "只投影已评的维度");
});

test("projectLaneProfiles：每行带推断族系（决定 0090），由车道表的 backend 与 modelId 推断", () => {
  const traitsResult = {
    state: "ok", path: "t.json", sha256: "b".repeat(64), scale: validDoc({}).scale,
    traits: { la: validEntry(), lb: validEntry(), lc: validEntry(), ld: validEntry() },
    invalidIds: [], issues: [],
  };
  const proj = projectLaneProfiles({
    lanesDoc: laneDoc([
      LANE_A,
      LANE_B,
      { id: "lc", backend: "codex", model: { id: "gpt-6.1-sol" }, reasoning: { effort: "high" } },
      { id: "ld", backend: "zcode", model: { id: "bigmodel-api/GLM-5.3" }, reasoning: { effort: "max" } },
    ]),
    traitsResult,
  });
  assert.deepEqual(proj.rows.map((r) => r.family), ["未知族系", "GPT", "GPT", "GLM"],
    "认不出的型号按 backend 兜底（codex→GPT，与写了 gpt 型号的同族）；zcode 不兜底（多 provider 宿主），认不出即未知");
});

test("projectLaneProfiles：每行带暂停说明、上下文窗口与能否看图/看视频", () => {
  const traitsResult = {
    state: "ok", path: "t.json", sha256: "b".repeat(64), scale: validDoc({}).scale,
    traits: {
      la: validEntry({ contextWindow: { tokens: 262144, source: "owner" }, multimodal: { image: false, video: true, source: "official" } }),
      lb: validEntry(),
    },
    invalidIds: [], issues: [],
  };
  const proj = projectLaneProfiles({
    lanesDoc: laneDoc([{ ...LANE_A, dispatchHold: "调试中，暂勿派发" }, { ...LANE_B, dispatchHold: "坏\u0007值" }]),
    traitsResult,
  });
  const [a, b] = proj.rows;
  assert.equal(a.dispatchHold, "调试中，暂勿派发", "暂停说明原话照录");
  assert.equal(a.contextWindowTokens, 262144);
  assert.equal(a.imageInput, false);
  assert.equal(a.videoInput, true, "videoInput 紧挨 imageInput 投影（0089：原生理解视频与先抽帧是两回事）");
  assert.equal(b.dispatchHold, null, "形状不合法的暂停说明投影为 null（与车道表读取面同一校验）");
  assert.equal(b.contextWindowTokens, 1000000);
  assert.equal(b.imageInput, true);
  assert.equal(b.videoInput, false);

  const noHold = projectLaneProfiles({ lanesDoc: laneDoc([LANE_A]), traitsResult });
  assert.equal(noHold.rows[0].dispatchHold, null, "没写暂停说明 → null");
});

test("projectLaneProfiles：每格只投影 {stars,basis,n,note}；超长 note 截成 79+…；evidence 不进投影", () => {
  const entry = entryWithRating({ note: "字".repeat(90) });
  const proj = projectLaneProfiles({
    lanesDoc: laneDoc([LANE_A]),
    traitsResult: { state: "ok", path: "t.json", sha256: "b".repeat(64), scale: validDoc({}).scale, traits: { la: entry }, invalidIds: [], issues: [] },
  });
  const cell = proj.rows[0].ratings.research;
  assert.deepEqual(Object.keys(cell).sort(), ["basis", "n", "note", "stars"], "恰好四键");
  assert.equal(cell.n, 5);
  assert.equal(cell.note.length, PROJECTED_NOTE_MAX_CHARS, "截断后总长等于投影上限");
  assert.ok(cell.note.endsWith("…") && cell.note.startsWith("字".repeat(PROJECTED_NOTE_MAX_CHARS - 1)), "上限减一个字符再加 …");
  assert.ok(!JSON.stringify(proj.rows[0]).includes("提交 abc1234"), "evidence 不进投影");
  // 行键闭集与维度中文名。
  assert.deepEqual(
    Object.keys(proj.rows[0]).sort(),
    ["caveats", "contextWindowTokens", "cost", "costTier", "dispatchHold", "family", "id", "imageInput", "ratings", "ratingsState", "reviewReasons", "videoInput"],
  );
  assert.deepEqual(Object.keys(proj.dimensionLabels), RATING_DIMENSIONS);
  assert.equal(proj.dimensionLabels.research, DIMENSION_LABELS.research, "中文名来自同一归宿");
});

test("projectLaneProfiles：invalid 车道省略该行并回传 id；读失败返回 null", () => {
  const proj = projectLaneProfiles({
    lanesDoc: laneDoc([LANE_A, LANE_B]),
    traitsResult: {
      state: "ok", path: "t.json", sha256: "b".repeat(64), scale: validDoc({}).scale,
      traits: { la: validEntry() }, invalidIds: ["lb", "ghost"],
      issues: ["车道 lb 画像形状错误（cost）", "车道 ghost 画像形状错误（cost）"],
    },
  });
  assert.deepEqual(proj.rows.map((r) => r.id), ["la"]);
  assert.deepEqual(proj.omittedLaneIds, ["lb"], "车道表里的 invalid 车道回传 id（表外孤儿不回传）");

  assert.equal(projectLaneProfiles({
    lanesDoc: laneDoc([LANE_A]),
    traitsResult: { state: "unreadable", path: "t.json", sha256: null, scale: null, traits: {}, invalidIds: [], issues: [] },
  }), null, "画像文件不可读 → null");
  assert.equal(projectLaneProfiles({
    lanesDoc: laneDoc([LANE_A]),
    traitsResult: { state: "invalid", path: "t.json", sha256: "b".repeat(64), scale: null, traits: {}, invalidIds: [], issues: [] },
  }), null, "画像文件顶层不合法 → null");
  assert.equal(projectLaneProfiles({
    lanesDoc: laneDoc([], { ok: false, issues: ["结构坏"] }),
    traitsResult: { state: "ok", path: "t.json", sha256: "b".repeat(64), scale: validDoc({}).scale, traits: { la: validEntry() }, invalidIds: [], issues: [] },
  }), null, "车道表结构非法 → null");
  assert.equal(projectLaneProfiles({
    lanesDoc: laneDoc([], { sha256: null }),
    traitsResult: { state: "ok", path: "t.json", sha256: "b".repeat(64), scale: validDoc({}).scale, traits: { la: validEntry() }, invalidIds: [], issues: [] },
  }), null, "车道表文件缺失（sha256=null）→ null");
});

test("projectLaneProfiles：行数至多 PROJECTION_ROWS_CAP；不排序不加推荐字段", () => {
  const many = Array.from({ length: PROJECTION_ROWS_CAP + 5 }, (_, i) => ({
    id: `lane${i}`, backend: "zcode", model: { id: `m${i}` }, reasoning: { effort: null },
  }));
  const traits = Object.fromEntries(many.map((l) => [l.id, validEntry()]));
  const proj = projectLaneProfiles({
    lanesDoc: laneDoc(many),
    traitsResult: { state: "ok", path: "t.json", sha256: "b".repeat(64), scale: validDoc({}).scale, traits, invalidIds: [], issues: [] },
  });
  assert.equal(proj.rows.length, PROJECTION_ROWS_CAP, "行数封顶");
  assert.deepEqual(proj.rows.map((r) => r.id).slice(0, 3), ["lane0", "lane1", "lane2"], "声明序不排序");
  assert.ok(!("recommended" in proj) && !("score" in proj), "无推荐字段");
});

// ── preflight 聚合器 ─────────────────────────────────────────────────────────

const noWorkers = async () => ({ agents: [], issues: [], issuesTruncated: false });
const noRuns = async () => ({ runs: [], matchedCount: 0, unresolvedCount: 0 });
const binding = { bound: true, source: "lead_session", root: "/A", gitHead: "a".repeat(40), dirty: false };
const goodProjection = () => projectLaneProfiles({
  lanesDoc: laneDoc([LANE_A]),
  traitsResult: {
    state: "ok", path: "t.json", sha256: "b".repeat(64), scale: validDoc({}).scale,
    traits: { la: entryWithRating() }, invalidIds: [], issues: [],
  },
});

test("preflight：worker 上下文 → lanes=null + 观察一句；不进 checkStatus", async () => {
  const result = await aggregateLeadPreflight({
    workspaceBinding: binding,
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: noWorkers,
    listRunsFn: noRuns,
    workerContextFn: () => ({ reason: "env-marker", detail: "fixture" }),
    laneProfilesFn: goodProjection,
  });
  assert.equal(result.lanes, null, "worker 上下文不投影画像");
  assert.ok(result.observations.some((o) => /not shown in a worker context/.test(o)));
  assert.ok(!("lanes" in result.checkStatus), "lanes 不进 checkStatus");
  assert.equal(result.complete, true, "lanes 不影响 complete");
});

test("preflight：lanes 独立结算——投影 null/抛错各记一条观察；不改变 complete", async () => {
  const base = {
    workspaceBinding: binding,
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: noWorkers,
    listRunsFn: noRuns,
    workerContextFn: () => null,
  };
  const withLanes = await aggregateLeadPreflight({ ...base, laneProfilesFn: goodProjection });
  assert.equal(withLanes.complete, true);
  assert.ok(withLanes.lanes != null, "非 worker 上下文投影在场");
  assert.deepEqual(withLanes.lanes.rows.map((r) => r.id), ["la"]);

  const nullLanes = await aggregateLeadPreflight({ ...base, laneProfilesFn: async () => null });
  assert.equal(nullLanes.lanes, null);
  assert.ok(nullLanes.observations.some((o) => /lane profiles could not be read — use wao lanes/.test(o)));
  assert.equal(nullLanes.complete, true, "lanes=null 不改变 complete");

  const throwing = await aggregateLeadPreflight({ ...base, laneProfilesFn: async () => { throw new Error("boom"); } });
  assert.equal(throwing.lanes, null);
  assert.ok(throwing.observations.some((o) => /lane profiles could not be read/.test(o)));
  assert.equal(throwing.complete, true);

  // 被省略的非法车道各记一条观察。
  const omitting = await aggregateLeadPreflight({
    ...base,
    laneProfilesFn: async () => ({ ...goodProjection(), rows: [], omittedLaneIds: ["lb"] }),
  });
  assert.equal(omitting.lanes.rows.length, 0);
  assert.ok(omitting.observations.some((o) => /lane lb profile is invalid/.test(o)));
});

// ── MCP 边界 ─────────────────────────────────────────────────────────────────

async function buildServerClient({ dir, registryPath, overrides = {} }) {
  const { createWaoMcpServer } = await import("../../src/mcp/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createWaoMcpServer({
    registryPath,
    runDir: join(dir, "runs"),
    workspaceRoot: dir,
    ...overrides,
  });
  const client = new Client({ name: "wao-laneprofile-test", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { server, client };
}

function makeRegistry(dir) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(
    registryPath,
    JSON.stringify({ agents: { coder_low: { backend: "claude-code", cwd: dir } } }),
    "utf8",
  );
  return registryPath;
}

test("MCP lead_preflight：投影不合子 schema → lanes 置 null + 观察，其余各节照常", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lp-mcp-bad-"));
  try {
    const badProjection = () => ({
      scale: "5 x；1 y",
      dimensionLabels: { ...DIMENSION_LABELS },
      rows: [{ id: "la", ratings: Object.fromEntries(RATING_DIMENSIONS.map((d) => [d, { stars: 9, basis: "measured", n: 1, note: null }])), ratingsState: "current", reviewReasons: [], caveats: [], cost: null }],
      omittedLaneIds: [],
    });
    const { server, client } = await buildServerClient({
      dir,
      registryPath: makeRegistry(dir),
      overrides: { laneProfilesFn: badProjection, workerContextFn: () => null },
    });
    try {
      const res = await client.callTool({ name: "lead_preflight", arguments: {} });
      assert.ok(!res.isError, "不合格投影绝不连累整个 preflight");
      const parsed = res.structuredContent;
      assert.equal(parsed.lanes, null, "不合子 schema 的投影被置 null");
      assert.ok(parsed.observations.some((o) => /failed output validation — use wao lanes/.test(o)));
      assert.notEqual(parsed.workspace, null, "workspace 节照常");
      assert.notEqual(parsed.workers, null, "workers 节照常");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

test("MCP lead_preflight：合法投影过整份出参 schema（形状即 LEAD_PREFLIGHT_OUTPUT）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lp-mcp-ok-"));
  try {
    const { server, client } = await buildServerClient({
      dir,
      registryPath: makeRegistry(dir),
      overrides: { laneProfilesFn: goodProjection, workerContextFn: () => null },
    });
    try {
      const res = await client.callTool({ name: "lead_preflight", arguments: {} });
      assert.ok(!res.isError, "出参已通过 LEAD_PREFLIGHT_OUTPUT.parse（此处无错即合规）");
      const lanes = res.structuredContent.lanes;
      assert.ok(lanes != null, "投影在场");
      assert.equal(typeof lanes.scale, "string");
      assert.deepEqual(Object.keys(lanes.dimensionLabels), RATING_DIMENSIONS);
      const row = lanes.rows[0];
      assert.deepEqual(Object.keys(row).sort(),
        ["caveats", "contextWindowTokens", "cost", "costTier", "dispatchHold", "family", "id", "imageInput", "ratings", "ratingsState", "reviewReasons", "videoInput"]);
      assert.deepEqual(Object.keys(row.ratings), ["research"], "只含已评维度（夹具只评了 research）");
      assert.equal(row.ratingsState, "current");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

test("MCP 面：只有 lead_preflight 的出参 schema 含画像投影键", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lp-mcp-only-"));
  try {
    const { server, client } = await buildServerClient({ dir, registryPath: makeRegistry(dir) });
    try {
      const { tools } = await client.listTools();
      const offenders = [];
      for (const t of tools) {
        const schemaText = JSON.stringify(t.outputSchema ?? {});
        if (/ratingsState|dimensionLabels/.test(schemaText)) offenders.push(t.name);
      }
      assert.deepEqual(offenders, ["lead_preflight"], "画像投影键只出现在 lead_preflight 出参");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

test("画像字段上限只在 laneProfile.js 定义一次；改值要有意改这里（0088 修订条）", () => {
  assert.deepEqual(
    { CAVEATS_CAP, CAVEAT_MAX_CHARS, REVIEW_REASON_MAX_CHARS, REVIEW_REASONS_CAP, COST_MAX_CHARS, PROJECTED_NOTE_MAX_CHARS, SCALE_MAX_CHARS, PROJECTION_ROWS_CAP },
    { CAVEATS_CAP: 6, CAVEAT_MAX_CHARS: 120, REVIEW_REASON_MAX_CHARS: 160, REVIEW_REASONS_CAP: 4, COST_MAX_CHARS: 200, PROJECTED_NOTE_MAX_CHARS: 80, SCALE_MAX_CHARS: 240, PROJECTION_ROWS_CAP: 16 },
  );
});

// ── 0097：costTier / score / ownerRules / costTierScale ─────────────────────

import {
  COST_TIER_MAX,
  COST_TIER_SCALE_MAX_CHARS,
  OWNER_RULES_CAP,
  OWNER_RULE_MAX_CHARS,
  SCORE_LABEL_MAX_CHARS,
  SCORED_DIMENSIONS,
  PROJECTION_NOTICES_CAP,
  validCostTier,
} from "../../src/application/laneProfile.js";

test("0097 costTier 校验：0.5/1/5/null 合法；0/0.25/5.5/字符串/NaN 只降级该格为 null + 一条观察，车道照常", () => {
  const withCostTier = (val) => {
    const e = validEntry({ costTier: val });
    e.ratings = entryWithRating().ratings;
    e.ratedAgainst = entryWithRating().ratedAgainst;
    return e;
  };
  for (const okVal of [0.5, 1, 2.5, 5, null]) {
    const r = validateTraitEntry("x", withCostTier(okVal));
    assert.equal(r.ok, true, `costTier=${okVal} 车道必须合法`);
    assert.equal(r.entry.costTier, okVal, `costTier=${okVal} 原样保留`);
    assert.deepEqual(r.observations, [], `costTier=${okVal} 零观察`);
  }
  for (const badVal of [0, 0.25, 5.5, "1", NaN]) {
    const r = validateTraitEntry("x", withCostTier(badVal));
    assert.equal(r.ok, true, `costTier=${badVal} 不许让整条车道 invalid`);
    assert.equal(r.entry.costTier, null, `costTier=${badVal} 该格当 null`);
    assert.ok(r.traits === undefined && r.entry != null, "车道照常归一");
    assert.equal(r.observations.length, 1, `costTier=${badVal} 恰一条观察`);
    assert.match(r.observations[0], /costTier 不合法/);
  }
  // 缺省 costTier：null、零观察（旧形状兼容——整节 lanes 不消失）。
  const plain = validateTraitEntry("x", entryWithRating());
  assert.equal(plain.entry.costTier, null);
  assert.deepEqual(plain.observations, []);
  // validCostTier 纯函数直测。
  assert.equal(validCostTier(0.5), true);
  assert.equal(validCostTier(1), true);
  assert.equal(validCostTier(5), true);
  assert.equal(validCostTier(null), true);
  for (const bad of [0, -1, 0.25, 5.5, 6, "1", NaN, undefined]) {
    assert.equal(validCostTier(bad), false, `validCostTier(${bad})=false`);
  }
});

test("0097 score 校验：measured 带合法 score 通过；形状坏/非 measured 格带 score 即整车道 invalid", () => {
  const good = entryWithRating({ score: { hits: 3, total: 5, label: "与终裁一致" } });
  const g = validateTraitEntry("x", good);
  assert.equal(g.ok, true, "合法 score 通过");
  assert.deepEqual(g.entry.ratings.research.score, { hits: 3, total: 5, label: "与终裁一致" });
  for (const bad of [
    { hits: 6, total: 5, label: "x" },       // hits > total
    { hits: -1, total: 5, label: "x" },      // hits < 0
    { hits: 1, total: 0, label: "x" },       // total < 1
    { hits: 1.5, total: 5, label: "x" },     // 非整数
    { hits: 1, total: 5, label: "" },        // 空标签
    { hits: 1, total: 5, label: "x".repeat(SCORE_LABEL_MAX_CHARS + 1) }, // 超长
    { hits: 1, total: 5, label: "a\u0007b" }, // 控制字符
    { hits: 1, total: 5 },                   // 缺 label
    { total: 5, label: "x" },                // 缺 hits
    { hits: 1, total: 5, label: "x", extra: 1 }, // 多键
  ]) {
    assert.equal(validateTraitEntry("x", entryWithRating({ score: bad })).ok, false,
      `score=${JSON.stringify(bad)} 按现有格级纪律：整条车道 invalid`);
  }
  // 非 measured 格不许 score：owner 格与未评格。
  const ownerScored = entryWithRating({ basis: "owner" });
  ownerScored.ratings.research.score = { hits: 1, total: 2, label: "x" };
  assert.equal(validateTraitEntry("x", ownerScored).ok, false, "owner 格带 score 即 invalid");
  const unratedScored = validEntry();
  unratedScored.ratings.code = { stars: null, basis: null, score: { hits: 1, total: 2, label: "x" } };
  assert.equal(validateTraitEntry("x", unratedScored).ok, false, "未评格带 score 即 invalid");
  // 只有 SCORED_DIMENSIONS 的格可带 score（MCP 出参 schema 从同一清单派生）：
  // 别的维度带 score 在文件校验就让车道 invalid，不会过了校验再让 MCP 层整节失败。
  assert.deepEqual([...SCORED_DIMENSIONS], ["research", "code", "review"]);
  const writingScored = entryWithRating();
  writingScored.ratings.writing = { stars: 3, basis: "measured", n: 2, evidence: "e", score: { hits: 1, total: 2, label: "x" } };
  const w = validateTraitEntry("x", writingScored);
  assert.equal(w.ok, false, "writing 格带 score 即整车道 invalid");
  assert.ok(w.fields.some((f) => f.includes("score 只许出现在 research/code/review 格")), "issue 写明可带 score 的维度");
  const writingPlain = entryWithRating();
  writingPlain.ratings.writing = { stars: 3, basis: "measured", n: 2, evidence: "e" };
  assert.equal(validateTraitEntry("x", writingPlain).ok, true, "同一格不带 score 照常合法");
});

test("0097 ownerRules/costTierScale 顶层校验：缺省/合法/坏值", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lp-0097-top-"));
  try {
    const p = join(dir, "t.json");
    const write = (over) => writeFileSync(p, JSON.stringify(validDoc({ a: entryWithRating() }, over)), "utf8");
    // 缺省：ownerRules=[]、costTierScale=null + 一条观察。
    write({});
    let r = readLaneTraits(p);
    assert.equal(r.state, "ok");
    assert.deepEqual(r.ownerRules, []);
    assert.equal(r.costTierScale, null);
    assert.equal(r.observations.length, 1, "缺 costTierScale 记一条观察");
    assert.match(r.observations[0], /costTierScale 缺失或不合法/);
    // 合法。
    write({
      costTierScale: "成本档：Owner 给的相对档位，0.5–5，数越小越便宜",
      ownerRules: ["规则一", "规则二"],
    });
    r = readLaneTraits(p);
    assert.deepEqual(r.ownerRules, ["规则一", "规则二"]);
    assert.equal(r.costTierScale, "成本档：Owner 给的相对档位，0.5–5，数越小越便宜");
    assert.deepEqual(r.observations, [], "合法时零观察");
    // 坏 ownerRules（条数超上限/空串/超长/控制字符/非数组）→ null + 一条观察，traits 照常。
    const badRules = [
      42,
      Array.from({ length: OWNER_RULES_CAP + 1 }, (_, i) => `r${i}`),
      [""],
      ["x".repeat(OWNER_RULE_MAX_CHARS + 1)],
      ["a\u0007b"],
    ];
    // 带上合法的 costTierScale，观察里就只剩 ownerRules 这一条。
    const okScale = "成本档：Owner 给的相对档位，0.5–5，数越小越便宜";
    for (const rules of badRules) {
      write({ costTierScale: okScale, ownerRules: rules });
      r = readLaneTraits(p);
      assert.equal(r.state, "ok", `ownerRules=${JSON.stringify(rules).slice(0, 30)} 不连累文件`);
      assert.equal(r.ownerRules, null, "坏 ownerRules 置 null");
      assert.ok(r.traits.a, "车道照常");
      assert.equal(r.observations.length, 1, "恰一条观察");
      assert.match(r.observations[0], /ownerRules 不合法/);
    }
    // 坏 costTierScale（非字符串/超长/控制字符）→ null + 观察。
    for (const bad of [42, "", "x".repeat(COST_TIER_SCALE_MAX_CHARS + 1), "a\u0007b"]) {
      write({ costTierScale: bad });
      r = readLaneTraits(p);
      assert.equal(r.costTierScale, null, `costTierScale=${JSON.stringify(bad)} → null`);
      assert.equal(r.observations.length, 1, "恰一条观察");
      assert.match(r.observations[0], /costTierScale 缺失或不合法/);
    }
    // 车道级 costTier 降级观察进 observations（带车道前缀）。
    const e = entryWithRating();
    e.costTier = 0;
    write({});
    writeFileSync(p, JSON.stringify(validDoc({ a: e })), "utf8");
    r = readLaneTraits(p);
    assert.ok(r.traits.a, "costTier 坏值车道照常存在");
    assert.equal(r.traits.a.costTier, null);
    assert.ok(r.observations.some((o) => o.startsWith("车道 a 画像：costTier 不合法")));
  } finally { cleanupDir(dir); }
});

test("0097 投影：行带 costTier、格带 score、顶层带 costTierScale/ownerRules、notices 有界", () => {
  const traits = {
    la: (() => {
      const e = entryWithRating({ score: { hits: 3, total: 5, label: "与终裁一致" } });
      e.costTier = 1;
      return e;
    })(),
  };
  const proj = projectLaneProfiles({
    lanesDoc: laneDoc([LANE_A]),
    traitsResult: {
      state: "ok", path: "t.json", sha256: "b".repeat(64), scale: validDoc({}).scale,
      costTierScale: "成本档说明", ownerRules: ["规则一"], traits, invalidIds: [], issues: [],
      observations: ["车道 la 画像：costTier 不合法，按未给（null）处理"],
    },
  });
  assert.equal(proj.costTierScale, "成本档说明");
  assert.deepEqual(proj.ownerRules, ["规则一"]);
  assert.equal(proj.rows[0].costTier, 1);
  const cell = proj.rows[0].ratings.research;
  assert.deepEqual(cell.score, { hits: 3, total: 5, label: "与终裁一致" }, "score 进投影");
  assert.deepEqual(proj.notices, ["车道 la 画像：costTier 不合法，按未给（null）处理"]);
  // 无 score 的格不携带 score 键；costTier 未给为 null；顶层缺省为 null/[]。
  const projBare = projectLaneProfiles({
    lanesDoc: laneDoc([LANE_A]),
    traitsResult: {
      state: "ok", path: "t.json", sha256: "b".repeat(64), scale: validDoc({}).scale,
      costTierScale: null, ownerRules: null, traits: { la: entryWithRating() }, invalidIds: [], issues: [],
      observations: [],
    },
  });
  assert.equal(!("score" in projBare.rows[0].ratings.research), true, "无 score 不带键");
  assert.equal(projBare.rows[0].costTier, null);
  assert.equal(projBare.costTierScale, null);
  assert.equal(projBare.ownerRules, null);
  assert.deepEqual(projBare.notices, []);
  // notices 上限。
  const many = Array.from({ length: PROJECTION_NOTICES_CAP + 3 }, (_, i) => `观察${i}`);
  const projMany = projectLaneProfiles({
    lanesDoc: laneDoc([LANE_A]),
    traitsResult: {
      state: "ok", path: "t.json", sha256: "b".repeat(64), scale: validDoc({}).scale,
      costTierScale: null, ownerRules: [], traits: { la: entryWithRating() }, invalidIds: [], issues: [],
      observations: many,
    },
  });
  assert.equal(projMany.notices.length, PROJECTION_NOTICES_CAP);
});

test("0097 preflight 聚合器：lanes 带 costTierScale/ownerRules；notices 各记一条观察", async () => {
  const projection = projectLaneProfiles({
    lanesDoc: laneDoc([LANE_A]),
    traitsResult: {
      state: "ok", path: "t.json", sha256: "b".repeat(64), scale: validDoc({}).scale,
      costTierScale: "成本档说明", ownerRules: ["规则一"],
      traits: { la: entryWithRating() }, invalidIds: [], issues: [],
      observations: ["车道 la 画像：costTier 不合法，按未给（null）处理"],
    },
  });
  const result = await aggregateLeadPreflight({
    workspaceBinding: binding,
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: noWorkers,
    listRunsFn: noRuns,
    workerContextFn: () => null,
    laneProfilesFn: async () => projection,
  });
  assert.equal(result.lanes.costTierScale, "成本档说明");
  assert.deepEqual(result.lanes.ownerRules, ["规则一"]);
  assert.equal(result.lanes.rows[0].costTier, null);
  assert.ok(result.observations.some((o) => o.includes("lane profiles: 车道 la 画像：costTier 不合法")));
  assert.equal(result.complete, true, "观察不改 complete");
});

// ── 0097 真实数据：config/lane-traits.json 本身 ─────────────────────────────

// 只钉形状，不钉 Owner 给的值：成本档与规则条文的家是画像文件，Owner 改值不该红这里。
test("0097 真实数据：校验与投影零 issue 零观察；Owner 规则与每条车道的成本档在场", () => {
  const r = readLaneTraits();
  assert.equal(r.state, "ok", "真实画像文件必须可读且顶层合法");
  assert.deepEqual(r.issues, [], "零 issue");
  assert.deepEqual(r.observations, [], "零降级观察");
  assert.ok(Array.isArray(r.ownerRules) && r.ownerRules.length > 0, "Owner 规则在场");
  assert.equal(typeof r.costTierScale, "string", "成本档说明在场");
  const lanesDoc = loadLanesConfig();
  for (const lane of lanesDoc.lanes) {
    const entry = r.traits[lane.id];
    assert.ok(entry, `${lane.id} 在画像里`);
    assert.ok(validCostTier(entry.costTier), `${lane.id}.costTier 是 0.5–5 步长 0.5 的数或 null`);
  }
  const proj = projectLaneProfiles({ lanesDoc, traitsResult: r });
  assert.ok(proj != null, "真实投影非 null");
  assert.deepEqual(proj.notices, [], "真实投影零 notices");
  assert.deepEqual(proj.ownerRules, r.ownerRules, "规则原样投影");
});

test("0097 真实数据：进了 score 的那组数字不再出现在同格 note（每格一条断言）", () => {
  const r = readLaneTraits();
  assert.equal(r.state, "ok");
  const proj = projectLaneProfiles({ lanesDoc: loadLanesConfig(), traitsResult: r });
  const cases = [
    ["glm-pro", "research", "137/174"],
    ["glm-flash", "research", "68/99"],
    ["glm-flash", "code", "27/28"],
    ["glm-flash", "review", "1/8"],
    ["kimi", "research", "68/99"],
    // kimi.code：本格数字 26/28 与同轮 deepseek-flash 恰好同分，note 里保留的
    // 是对照事实（"同轮 deepseek-flash 26/28"）——自报位置（"隐藏测试 26/28"）
    // 已删。此格断言自报短语，其余各格断言数字本身。
    ["kimi", "code", "隐藏测试 26/28"],
    ["kimi", "review", "5/8"],
    ["deepseek-flash", "research", "277/396"],
    ["deepseek-flash", "code", "107/112"],
    ["deepseek-flash", "review", "24/32"],
  ];
  for (const [laneId, dim, num] of cases) {
    const row = proj.rows.find((x) => x.id === laneId);
    assert.ok(row, `${laneId} 行在场`);
    const cell = row.ratings[dim];
    assert.ok(cell?.score, `${laneId}.${dim} 带 score`);
    if (/^\d+\/\d+$/.test(num)) {
      assert.equal(`${cell.score.hits}/${cell.score.total}`, num,
        `${laneId}.${dim} score 数字与台账一致`);
    }
    assert.equal((cell.note ?? "").includes(num), false,
      `${laneId}.${dim} note 不再重复 ${num}（数字只留在 score）`);
  }
});

test("真实画像：videoInput 只有 kimi 为 true（0089：其余车道要先抽帧截图）", () => {
  const r = readLaneTraits();
  assert.equal(r.state, "ok");
  const proj = projectLaneProfiles({ lanesDoc: loadLanesConfig(), traitsResult: r });
  assert.ok(proj, "真实画像可投影");
  const videoTrue = proj.rows.filter((x) => x.videoInput === true).map((x) => x.id);
  assert.deepEqual(videoTrue, ["kimi"], "原生理解视频的车道只有 kimi");
  assert.ok(proj.rows.length > 1, "其余车道在列（它们的 videoInput 均为 false）");
});
