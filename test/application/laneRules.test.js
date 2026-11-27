// test/application/laneRules.test.js
//
// 第 156 批：派发/会审回执新增结构化字段 laneRules 的钉（单一构造 buildLaneRules
// + 单一 stderr 渲染 renderLaneRulesLines；内容只经 laneProfile 投影）：
//   - rules：夹具规则全部、按序、不截断，标明 Owner 原文；
//   - now：同额度池一致才合并成一行；不一致/无池逐条车道；时钟注入钉高峰边界；
//     holidaysRecognized=false（渲染写"法定节假日不识别"）；
//   - 规则不可读/不合法/为空 → rules:null + 固定原因串，绝不静默省略；
//   - 生成函数抛错 → 只降级本字段（{rules:null, now:null}），不抛；
//   - 渲染：每条一行、[wao] 前缀由调用方加（本函数给纯行）、无推荐措辞。
//
// 夹具纪律：规则与车道全用夹具（不钉仓库 6 条规则原文、不钉真实车道名——
// Owner 改规则/改表这里不红）。
process.env.WAO_ALLOW_NESTED_DISPATCH = "1";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildLaneRules,
  renderLaneRulesLines,
  OWNER_RULES_HEADER,
  HOLIDAYS_NOTE,
  RULES_UNAVAILABLE_REASON,
} from "../../src/application/laneRules.js";

// ── 夹具（与 laneFactsLine.test.js 同形）────────────────────────────────────

const unrated = () => ({ stars: null, basis: null });
const scale = { "5": "最强", "4": "强", "3": "堪用", "2": "弱", "1": "不适合" };

const baseEntry = (over = {}) => ({
  ratings: {
    research: unrated(), code: unrated(), review: unrated(), design: unrated(),
    longHorizon: unrated(), writing: unrated(), visual: unrated(),
  },
  ratedAgainst: null,
  cost: "按量计费",
  costTier: null,
  caveats: [],
  contextWindow: { tokens: 1000000, source: "official（测试）" },
  multimodal: { image: true, video: false, source: "official" },
  ...over,
});

const peak = (hours, effect = "高峰单价上浮") => ({ days: "weekdays", hours, effect });

const FIXTURE_RULES = ["夹具规则甲：非高峰优先派低价车道", "夹具规则乙：越过某车道要写理由", "夹具规则丙：特殊场景另有说明"];

// 池甲：两条车道声明完全一致 → 合并一行。池乙：两条声明不一致 → 逐条车道。
// solo：有高峰、无额度池 → 逐条车道。plain：无高峰 → 不出现在 peaks。
const LANES_DOC = {
  ok: true, sha256: "a".repeat(64), issues: [],
  lanes: [
    { id: "pool-a-1", backend: "zcode", model: { id: "m1" }, reasoning: { effort: "max" } },
    { id: "pool-a-2", backend: "zcode", model: { id: "m1" }, reasoning: { effort: "max" } },
    { id: "pool-b-1", backend: "zcode", model: { id: "m1" }, reasoning: { effort: "max" } },
    { id: "pool-b-2", backend: "zcode", model: { id: "m1" }, reasoning: { effort: "max" } },
    { id: "solo", backend: "zcode", model: { id: "m1" }, reasoning: { effort: "max" } },
    { id: "plain", backend: "zcode", model: { id: "m1" }, reasoning: { effort: "max" } },
  ],
};
const withPool = (over) => baseEntry(over);
const TRAITS_OK = {
  state: "ok", path: "fixture.json", sha256: "b".repeat(64), scale,
  costTierScale: "成本档说明", ownerRules: [...FIXTURE_RULES], observations: [],
  traits: {
    "pool-a-1": withPool({ quotaPool: "夹具池甲", peak: peak(["14:00-18:00"]) }),
    "pool-a-2": withPool({ quotaPool: "夹具池甲", peak: peak(["14:00-18:00"]) }),
    "pool-b-1": withPool({ quotaPool: "夹具池乙", peak: peak(["09:00-12:00"]) }),
    "pool-b-2": withPool({ quotaPool: "夹具池乙", peak: peak(["16:00-18:00"]) }),
    "solo": withPool({ peak: peak(["14:00-18:00"], "晚高峰") }),
    "plain": withPool({}),
  },
  invalidIds: [], issues: [],
};

// 北京墙钟 → epoch ms（固定 +08:00）。2026-11-26 是周四（工作日）。
const bjMs = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi) - 8 * 60 * 60 * 1000;
const THU_15 = bjMs(2026, 11, 26, 15, 0);
const THU_20 = bjMs(2026, 11, 26, 20, 0);

const build = (over = {}) => buildLaneRules({ lanesDoc: LANES_DOC, traitsResult: TRAITS_OK, nowMsFn: () => THU_15, ...over });

// ── 构造：rules ─────────────────────────────────────────────────────────────

test("rules：夹具规则全部、按声明序、不截断（rule 串逐字等于夹具）", () => {
  const { rules } = build();
  assert.deepEqual(rules, FIXTURE_RULES, "全部、按序、逐字不截断");
});

test("now：北京快照 + 同池一致合并一行；不一致逐车道；无池逐车道；无高峰不出现", () => {
  const { now } = build();
  assert.equal(now.beijing, "周四 15:00", "北京时间快照（与 wao lanes 同一标签）");
  assert.equal(now.holidaysRecognized, false, "法定节假日不识别（结构化口径）");
  assert.equal(now.peaks.length, 4, "池甲合并 1 + 池乙逐条 2 + solo 1；plain 无高峰不出现");
  const [mergedA, b1, b2, solo] = now.peaks;
  assert.deepEqual(Object.keys(mergedA).sort(), ["lanes", "peakNow", "pool"], "合并行形制 {pool,lanes,peakNow}");
  assert.equal(mergedA.pool, "夹具池甲");
  assert.deepEqual(mergedA.lanes, ["pool-a-1", "pool-a-2"]);
  assert.deepEqual(mergedA.peakNow, { state: "peak", until: "2026-11-26T18:00:00+08:00", untilLocal: "18:00" },
    "peakNow 形状与投影行同一格式");
  // 池乙声明不一致：逐条车道，绝不用池里第一条代表整个池。
  assert.deepEqual([b1.lane, b2.lane].sort(), ["pool-b-1", "pool-b-2"]);
  assert.equal("pool" in b1, false, "逐条行不带 pool 键");
  assert.deepEqual(b1.peakNow, { state: "off_peak", until: "2026-11-27T09:00:00+08:00", untilLocal: "周五 09:00" });
  assert.deepEqual(b2.peakNow, { state: "off_peak", until: "2026-11-26T16:00:00+08:00", untilLocal: "16:00" });
  assert.deepEqual(solo, { lane: "solo", peakNow: { state: "peak", until: "2026-11-26T18:00:00+08:00", untilLocal: "18:00" } },
    "有高峰无额度池 → 逐条车道行");
  assert.ok(!JSON.stringify(now.peaks).includes("plain"), "无高峰车道不出现");
});

test("时钟边界：周四 20:00 → 池甲合并行转非高峰、跨天带星期（同一 peakNow 判定函数）", () => {
  const { now } = build({ nowMsFn: () => THU_20 });
  const mergedA = now.peaks[0];
  assert.equal(mergedA.peakNow.state, "off_peak");
  assert.equal(mergedA.peakNow.untilLocal, "周五 14:00", "下一边界=下一工作日首段开始（跨天带星期）");
});

// ── 降级：rules null + 固定原因 ─────────────────────────────────────────────

test("ownerRules 不合法（加载器置 null）→ rules:null + 固定原因，now 照常", () => {
  const degraded = build({ traitsResult: { ...TRAITS_OK, ownerRules: null } });
  assert.equal(degraded.rules, null);
  assert.equal(degraded.rulesReason, RULES_UNAVAILABLE_REASON, "固定原因串");
  assert.ok(degraded.now != null && degraded.now.peaks.length === 4, "规则降级不连累 now");
});

test("ownerRules 为空数组 → 同样 rules:null + 原因（不为空集造默认）", () => {
  const degraded = build({ traitsResult: { ...TRAITS_OK, ownerRules: [] } });
  assert.equal(degraded.rules, null);
  assert.equal(degraded.rulesReason, RULES_UNAVAILABLE_REASON);
  assert.ok(degraded.now != null);
});

test("画像不可读/车道表停用 → 整字段降级（rules:null + 原因，now:null），不抛", () => {
  const unreadable = build({ traitsResult: { state: "unreadable", path: "x", sha256: null, scale: null, costTierScale: null, ownerRules: [], traits: {}, invalidIds: [], issues: [], observations: [] } });
  assert.deepEqual(unreadable, { rules: null, rulesReason: RULES_UNAVAILABLE_REASON, now: null });
  const disabledLanes = build({ lanesDoc: { ok: false, sha256: null, lanes: [], issues: ["停用"] } });
  assert.deepEqual(disabledLanes, { rules: null, rulesReason: RULES_UNAVAILABLE_REASON, now: null },
    "非默认 --registry 车道表停用同形");
});

test("生成途中的任何异常 → 只降级本字段，不上抛（受理绝不变错误回执）", () => {
  const boom = build({ nowMsFn: () => { throw new Error("clock boom"); } });
  assert.deepEqual(boom, { rules: null, rulesReason: RULES_UNAVAILABLE_REASON, now: null });
  const boomLanes = build({ lanesDoc: { get ok() { throw new Error("boom"); } } });
  assert.deepEqual(boomLanes, { rules: null, rulesReason: RULES_UNAVAILABLE_REASON, now: null });
});

// ── 渲染：stderr 的那几行 ─────────────────────────────────────────────────────

test("渲染：标头标明 Owner 原文；规则每条一行、按序带序号；此刻行带节假日口径", () => {
  const lines = renderLaneRulesLines(build());
  assert.equal(lines[0], OWNER_RULES_HEADER, "标头（含“以下为 Owner 原文”）");
  assert.deepEqual(lines.slice(1, 4), ["1. 夹具规则甲：非高峰优先派低价车道", "2. 夹具规则乙：越过某车道要写理由", "3. 夹具规则丙：特殊场景另有说明"],
    "每条一行、按声明序");
  const nowLine = lines[4];
  assert.equal(nowLine, `此刻（北京时间 周四 15:00；${HOLIDAYS_NOTE}）：`);
  assert.deepEqual(lines.slice(5), [
    "额度池 夹具池甲（pool-a-1、pool-a-2）：此刻高峰（至 18:00）",
    "车道 pool-b-1：此刻非高峰（至 周五 09:00）",
    "车道 pool-b-2：此刻非高峰（至 16:00）",
    "车道 solo：此刻高峰（至 18:00）",
  ], "池合并行在前、逐车道行在后；peakNow 措辞与 laneFactsLine 同一形制");
  for (const line of lines) assert.ok(!/[\u0000-\u001f]/.test(line), "行内无原始控制字节");
  // WAO 固定措辞不出现推荐语（夹具规则原文除外——那是 Owner 原文，照录）。
  for (const line of [lines[0], nowLine, ...lines.slice(5)]) {
    for (const banned of ["更便宜", "建议", "应该"]) {
      assert.ok(!line.includes(banned), `固定行不出现推荐词"${banned}"：${line}`);
    }
  }
});

test("渲染降级：rules:null → 恰一行不可用行（固定文案）；now:null 时无此刻段", () => {
  const degradedLines = renderLaneRulesLines(build({ traitsResult: { ...TRAITS_OK, ownerRules: null } }));
  assert.deepEqual(degradedLines.slice(0, 1), [`车道规则不可用：${RULES_UNAVAILABLE_REASON}`]);
  assert.ok(degradedLines[1].startsWith("此刻（北京时间"), "now 仍在 → 此刻段照常");
  const goneLines = renderLaneRulesLines(build({ lanesDoc: { ok: false, sha256: null, lanes: [], issues: [] } }));
  assert.deepEqual(goneLines, [`车道规则不可用：${RULES_UNAVAILABLE_REASON}`], "整字段降级 → 恰一行");
  assert.deepEqual(renderLaneRulesLines(null), [`车道规则不可用：${RULES_UNAVAILABLE_REASON}`],
    "null 输入 → 同一行（防御）");
});

test("渲染安全：池名/车道键里的控制字符可见化（不增殖行数）", () => {
  const evil = build({
    lanesDoc: { ok: true, sha256: "a".repeat(64), issues: [], lanes: [
      { id: "evil\u0007lane", backend: "zcode", model: { id: "m1" }, reasoning: { effort: "max" } },
    ] },
    traitsResult: { ...TRAITS_OK, traits: { "evil\u0007lane": withPool({ peak: peak(["14:00-18:00"]) }) } },
  });
  const lines = renderLaneRulesLines(evil);
  const laneLine = lines.find((l) => l.includes("evil"));
  assert.ok(laneLine.includes("evil\\u0007lane"), "控制字节可见化（\\u0007 写法）");
  assert.ok(!/[\u0000-\u001f]/.test(laneLine), "行内无原始控制字节");
});
