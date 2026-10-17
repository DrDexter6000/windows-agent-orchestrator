// test/application/laneProfile.test.js
//
// 0087：车道画像（schemaVersion 2）模块钉——校验、待复核判定、preflight 投影
// 与聚合器/MCP 边界的可证伪面：
//   - 校验：每条形状规则正例+反例（未评带 n、measured 缺 n、owner 带 n、
//     ratings 少/多键、车道级未知键、星级 0/6、ratedAgainst 与评分状态矛盾、
//     各长度界、顶层 schemaVersion/scale）；
//   - ratingsState：四种状态、四轴各自不一致、undefined/null 空值归一不算
//     不同、reviewPending 并入 reasons、身份不一致而无 reviewPending 仍 review；
//   - 投影：行序=lanes.json 声明序、caveats 全部投影、null 原样、每格只投影
//     {stars,basis,n,note} 且超长 note 截断、invalid 车道省略并回传 id、
//     读失败返回 null；
//   - preflight：worker 上下文 lanes=null、lanes 独立结算（null 不改 complete、
//     不合格子 schema 置 null 不连累其余各节）、投影形状过 LEAD_PREFLIGHT_OUTPUT、
//     只有 lead_preflight 的出参 schema 含画像键。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  validateTraitEntry,
  readLaneTraits,
  ratingsState,
  projectLaneProfiles,
  buildScaleLine,
  RATING_DIMENSIONS,
  DIMENSION_LABELS,
  PROJECTION_ROWS_CAP,
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
  assert.equal(validateTraitEntry("x", validEntry({ cost: "字".repeat(200) })).ok, true);
  assert.equal(validateTraitEntry("x", validEntry({ cost: "字".repeat(201) })).ok, false);
  assert.equal(validateTraitEntry("x", validEntry({ reviewPending: "待复核" })).ok, true);
  assert.equal(validateTraitEntry("x", validEntry({ reviewPending: "字".repeat(161) })).ok, false);
  assert.equal(validateTraitEntry("x", validEntry({ caveats: ["a", "b", "c", "d"] })).ok, true);
  assert.equal(validateTraitEntry("x", validEntry({ caveats: ["a", "b", "c", "d", "e"] })).ok, false, "caveats 至多 4 条");
  assert.equal(validateTraitEntry("x", validEntry({ caveats: ["字".repeat(121)] })).ok, false, "caveat 1–120");
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

test("projectLaneProfiles：caveats 全部投影；null 原样保留不折算", () => {
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
  for (const d of RATING_DIMENSIONS) {
    assert.equal(row.ratings[d].stars, null);
    assert.equal(row.ratings[d].n, null, "n 缺失投影为 null");
    assert.equal(row.ratings[d].note, null, "note 缺失投影为 null");
  }
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
  assert.equal(cell.note.length, 80, "截断后总长 80");
  assert.ok(cell.note.endsWith("…") && cell.note.startsWith("字".repeat(79)), "79 字符加 …");
  assert.ok(!JSON.stringify(proj.rows[0]).includes("提交 abc1234"), "evidence 不进投影");
  // 行键闭集与维度中文名。
  assert.deepEqual(
    Object.keys(proj.rows[0]).sort(),
    ["caveats", "cost", "id", "ratings", "ratingsState", "reviewReasons"],
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
        ["caveats", "cost", "id", "ratings", "ratingsState", "reviewReasons"]);
      assert.deepEqual(Object.keys(row.ratings), RATING_DIMENSIONS, "七格固定对象键");
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
