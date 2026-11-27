// test/application/lanePeak.test.js
//
// 152 批（车道高峰结构化）的钉：
//   - peak 校验（validateTraitEntry 的降级例外）：合法形状通过并原样归一；
//     非法形状（跨午夜、重叠、乱序、超 4 段、days 非 weekdays、effect 超长/
//     缺失、多键、段格式坏）降级为缺席 + 恰一条观察，车道不消失；
//   - "此刻"（peakNowAt / beijingNowLabel，时钟注入）：工作日高峰内与高峰外、
//     两段之间、恰在边界那一刻、周五晚间到周一、周六、周日；untilLocal 同一天
//     不带星期、跨天带星期；宿主时区不参与（TZ 不同的子进程同结果）；
//   - 投影：行带 peakNow（恰三键）、没声明的行不带键、顶层 now；invalid peak
//     降级后行不带 peakNow 且 notices 记观察；
//   - preflight 聚合器：lanes 行 peakNow 与顶层 now 同源透传；worker 上下文
//     lanes 与 now 同 null；MCP 出参过 schema（peakNow 可选、now 可空）；
//   - 真实 config/lane-traits.json：六条 Owner 规则都在 120 字内；四条车道的
//     peak 合法；cost 文本不再携带时段与 UTC 换算；额度池（quotaPool，153 批）
//     每条车道都在 1–40 字内、池内成员按声明序、cost 不再写"共用"。
process.env.WAO_ALLOW_NESTED_DISPATCH = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  validateTraitEntry,
  validPeak,
  validPeakHours,
  peakNowAt,
  beijingNowLabel,
  readLaneTraits,
  projectLaneProfiles,
  PEAK_EFFECT_MAX_CHARS,
  PEAK_HOURS_CAP,
  BEIJING_OFFSET_MS,
  WEEKDAY_LABELS,
  OWNER_RULES_CAP,
  OWNER_RULES_TOTAL_MAX_CHARS,
} from "../../src/application/laneProfile.js";
import { aggregateLeadPreflight } from "../../src/application/leadPreflight.js";
import { loadLanesConfig } from "../../src/dispatchResolution.js";

// ── 夹具（与 laneProfile.test.js 同形）───────────────────────────────────────

const unrated = () => ({ stars: null, basis: null });
const GLM_PEAK = { days: "weekdays", hours: ["14:00-18:00"], effect: "非高峰消耗减半" };
const DS_PEAK = { days: "weekdays", hours: ["09:00-12:00", "14:00-18:00"], effect: "空闲价是高峰价的一半" };

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

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** 北京墙钟 → epoch ms（固定 +08:00；h/m 为北京时、分）。 */
const bjEpoch = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi) - BEIJING_OFFSET_MS;

// ── peak 校验 ────────────────────────────────────────────────────────────────

test("152 peak 校验：合法形状（单段/双段/恰好相接）归一通过、零观察、原样保留", () => {
  for (const peak of [
    GLM_PEAK,
    DS_PEAK,
    { days: "weekdays", hours: ["09:00-12:00", "12:00-14:00"], effect: "x" }, // 相接不算重叠
    { days: "weekdays", hours: ["00:00-01:00"], effect: "凌晨一段" },
  ]) {
    const v = validateTraitEntry("x", validEntry({ peak }));
    assert.equal(v.ok, true, `peak=${JSON.stringify(peak)} 合法`);
    assert.deepEqual(v.entry.peak, peak, "peak 原样归一保留");
    assert.deepEqual(v.observations, [], "合法零观察");
    assert.equal(validPeak(peak), true);
  }
  // validPeakHours 纯函数直测。
  assert.equal(validPeakHours(["14:00-18:00"]), true);
  assert.equal(validPeakHours([]), false, "至少一段");
});

test("152 peak 校验：非法形状降级为缺席 + 恰一条观察，车道照常投影", () => {
  const badCases = [
    { ...GLM_PEAK, hours: ["18:00-02:00"] },                 // 跨午夜（start>=end）
    { ...GLM_PEAK, hours: ["14:00-18:00"], days: "daily" },  // days 非 weekdays
    { ...GLM_PEAK, hours: ["14:00-18:00"], days: "weekends" },
    { ...DS_PEAK, hours: ["09:00-13:00", "12:00-14:00"] },   // 重叠
    { ...DS_PEAK, hours: ["14:00-18:00", "09:00-12:00"] },   // 乱序
    { ...GLM_PEAK, hours: ["09:00-10:00", "10:00-11:00", "11:00-12:00", "13:00-14:00", "15:00-16:00"] }, // 超 4 段
    { ...GLM_PEAK, hours: ["9:00-18:00"] },                  // 段格式坏（一位数时）
    { ...GLM_PEAK, hours: ["14:00–18:00"] },                 // 非半角连字符
    { ...GLM_PEAK, hours: ["14:00"] },                       // 缺终点
    { ...GLM_PEAK, hours: "14:00-18:00" },                   // hours 非数组
    { days: "weekdays", hours: ["14:00-18:00"] },            // 缺 effect
    { days: "weekdays", hours: ["14:00-18:00"], effect: "字".repeat(PEAK_EFFECT_MAX_CHARS + 1) }, // effect 超长
    { days: "weekdays", hours: ["14:00-18:00"], effect: "a\u0007b" }, // 控制字符
    { ...GLM_PEAK, extra: 1 },                               // 多键
    { days: "weekdays", hours: ["24:00-25:00"], effect: "x" }, // 越界钟点
    "14:00-18:00",                                           // 非对象
  ];
  for (const peak of badCases) {
    const v = validateTraitEntry("x", validEntry({ peak }));
    assert.equal(v.ok, true, `peak=${JSON.stringify(peak).slice(0, 60)} 不许让整条车道 invalid`);
    assert.equal("peak" in v.entry, false, `peak=${JSON.stringify(peak).slice(0, 60)} 降级为缺席`);
    assert.equal(v.observations.length, 1, "恰一条观察");
    assert.match(v.observations[0], /peak 不合法，按未给（无高峰）处理/);
    assert.equal(validPeak(peak), false);
  }
  // validPeakHours 各反例直测（段数上限常量、乱序、重叠）。
  assert.equal(validPeakHours(Array.from({ length: PEAK_HOURS_CAP }, (_, i) => `0${i}:00-0${i}:30`)), true);
  assert.equal(validPeakHours(["10:00-11:00", "09:00-10:30"]), false, "乱序");
  // 无 peak 键：entry 无 peak、零观察。
  const plain = validateTraitEntry("x", validEntry());
  assert.equal("peak" in plain.entry, false);
  assert.deepEqual(plain.observations, []);
});

// ── "此刻"计算 ───────────────────────────────────────────────────────────────

test("152 peakNowAt：工作日高峰内与高峰外；untilLocal 同一天不带星期", () => {
  const thu = (h, mi, msAdj = 0) => bjEpoch(2026, 11, 26, h, mi) + msAdj; // 2026-11-26 是周四
  // GLM：工作日 14:00-18:00。
  assert.deepEqual(peakNowAt(GLM_PEAK, thu(15, 0)), {
    state: "peak", until: "2026-11-26T18:00:00+08:00", untilLocal: "18:00",
  });
  assert.deepEqual(peakNowAt(GLM_PEAK, thu(10, 0)), {
    state: "off_peak", until: "2026-11-26T14:00:00+08:00", untilLocal: "14:00",
  });
  // DeepSeek：两段之间（12:00-14:00）与第一段内。
  assert.deepEqual(peakNowAt(DS_PEAK, thu(12, 30)), {
    state: "off_peak", until: "2026-11-26T14:00:00+08:00", untilLocal: "14:00",
  });
  assert.deepEqual(peakNowAt(DS_PEAK, thu(10, 30)), {
    state: "peak", until: "2026-11-26T12:00:00+08:00", untilLocal: "12:00",
  });
  // 相接段：修正一起当成一段连续高峰——12:00 整点与 11:59:59.999 都报至 14:00。
  const touching = { days: "weekdays", hours: ["09:00-12:00", "12:00-14:00"], effect: "x" };
  assert.deepEqual(peakNowAt(touching, thu(12, 0)).untilLocal, "14:00", "接缝整点报合并段的结束");
  assert.equal(peakNowAt(touching, thu(12, 0)).state, "peak");
  assert.deepEqual(peakNowAt(touching, thu(12, 0, -1)).untilLocal, "14:00", "接缝前 1 毫秒报同一个结束");
});

test("152 修正一：首尾相接的高峰段当成一段连续高峰——段内/接缝前 1 毫秒/接缝整点同报一个结束", () => {
  const thu = (h, mi, msAdj = 0) => bjEpoch(2026, 11, 26, h, mi) + msAdj;
  // 校验规则不变：相接不算重叠，仍合法。
  const two = { days: "weekdays", hours: ["09:00-12:00", "12:00-18:00"], effect: "x" };
  assert.equal(validPeak(two), true);
  const until18 = { state: "peak", until: "2026-11-26T18:00:00+08:00", untilLocal: "18:00" };
  assert.deepEqual(peakNowAt(two, thu(10, 0)), until18, "段内（10:00）→ 至 18:00");
  assert.deepEqual(peakNowAt(two, thu(12, 0, -1)), until18, "接缝前 1 毫秒（11:59:59.999）→ 至 18:00");
  assert.deepEqual(peakNowAt(two, thu(12, 0)), until18, "接缝那一刻（12:00:00）→ 至 18:00");
  // 非高峰的"至"照旧写到下一个合并后段的开始。
  assert.deepEqual(peakNowAt(two, thu(8, 0)), {
    state: "off_peak", until: "2026-11-26T09:00:00+08:00", untilLocal: "09:00",
  }, "08:00 → 至合并段开始 09:00");

  // 三段首尾相接：整段连续。
  const three = { days: "weekdays", hours: ["09:00-10:00", "10:00-12:00", "12:00-18:00"], effect: "x" };
  assert.equal(validPeak(three), true);
  assert.deepEqual(peakNowAt(three, thu(9, 30)), until18, "第一段内 → 至 18:00");
  assert.deepEqual(peakNowAt(three, thu(12, 0, -1)), until18, "第二、三段接缝前 1 毫秒 → 至 18:00");
  assert.deepEqual(peakNowAt(three, thu(12, 0)), until18, "第二、三段接缝整点 → 至 18:00");

  // 不相接的两段行为不变（DeepSeek 09:00–12:00、14:00–18:00）。
  assert.deepEqual(peakNowAt(DS_PEAK, thu(10, 30)), {
    state: "peak", until: "2026-11-26T12:00:00+08:00", untilLocal: "12:00",
  }, "第一段内照旧至 12:00");
  assert.deepEqual(peakNowAt(DS_PEAK, thu(12, 30)), {
    state: "off_peak", until: "2026-11-26T14:00:00+08:00", untilLocal: "14:00",
  }, "两段之间照旧至 14:00");
  assert.deepEqual(peakNowAt(DS_PEAK, thu(12, 0)), {
    state: "off_peak", until: "2026-11-26T14:00:00+08:00", untilLocal: "14:00",
  }, "第一段结束整点（不相接）照旧出高峰");
});

test("152 peakNowAt：恰在边界的那一刻——开始算高峰、结束算非高峰", () => {
  const thu = (h, mi) => bjEpoch(2026, 11, 26, h, mi);
  const start = peakNowAt(GLM_PEAK, thu(14, 0));
  assert.equal(start.state, "peak", "14:00:00 已在高峰内");
  assert.equal(start.until, "2026-11-26T18:00:00+08:00");
  const end = peakNowAt(GLM_PEAK, thu(18, 0));
  assert.equal(end.state, "off_peak", "18:00:00 已出高峰");
  assert.equal(end.until, "2026-11-27T14:00:00+08:00", "下一个边界=下一工作日第一段的开始");
  assert.equal(end.untilLocal, "周五 14:00", "跨天带星期");
});

test("152 peakNowAt：周五晚间、周六、周日 → until 到周一第一段高峰的开始", () => {
  const cases = [
    [bjEpoch(2026, 11, 27, 18, 0), "周五 18:00 整（GLM 刚出高峰）"],
    [bjEpoch(2026, 11, 27, 20, 0), "周五 20:00"],
    [bjEpoch(2026, 11, 28, 10, 0), "周六上午"],
    [bjEpoch(2026, 11, 29, 23, 30), "周日深夜"],
  ];
  for (const [nowMs, name] of cases) {
    assert.deepEqual(peakNowAt(GLM_PEAK, nowMs), {
      state: "off_peak", until: "2026-11-30T14:00:00+08:00", untilLocal: "周一 14:00",
    }, `${name}：GLM 到周一 14:00`);
    assert.deepEqual(peakNowAt(DS_PEAK, nowMs), {
      state: "off_peak", until: "2026-11-30T09:00:00+08:00", untilLocal: "周一 09:00",
    }, `${name}：DeepSeek 到周一 09:00`);
  }
});

test("152 peakNowAt：非法输入返回 null；beijingNowLabel 出固定格式", () => {
  assert.equal(peakNowAt(GLM_PEAK, Number.NaN), null, "nowMs 非有限数");
  assert.equal(peakNowAt({ days: "daily", hours: ["14:00-18:00"], effect: "x" }, bjEpoch(2026, 11, 26, 15, 0)), null,
    "peak 形状不合法 → null（投影侧按缺席处理）");
  assert.equal(beijingNowLabel(bjEpoch(2026, 11, 26, 22, 15)), "周四 22:15");
  assert.equal(beijingNowLabel(bjEpoch(2026, 11, 29, 9, 5)), "周日 09:05");
  assert.deepEqual([...WEEKDAY_LABELS], ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]);
});

// 宿主时区不参与：实现只用 UTC 读数 + 固定偏移。用 TZ 不同的子进程跑同一计算
// 证伪"谁用了本地时区"——两侧结果必须逐字节相等，且与进程内算的相等。
test("152 peakNowAt：宿主时区不是 UTC+8（TZ=Europe/Paris）时结果不变", () => {
  const nowMs = bjEpoch(2026, 11, 26, 12, 30); // 周四 12:30（DeepSeek 两段之间）
  const expected = JSON.stringify(peakNowAt(DS_PEAK, nowMs));
  const script = "import(process.env.LANEPEAK_MOD).then(({ peakNowAt }) => {"
    + "const peak = { days: 'weekdays', hours: ['09:00-12:00', '14:00-18:00'], effect: 'x' };"
    + "process.stdout.write(JSON.stringify(peakNowAt(peak, Number(process.env.LANEPEAK_NOW))));"
    + "})";
  const runWithTz = (tz) => execFileSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: {
      TZ: tz,
      LANEPEAK_MOD: pathToFileURL(join(process.cwd(), "src", "application", "laneProfile.js")).href,
      LANEPEAK_NOW: String(nowMs),
      PATH: process.env.PATH ?? "",
    },
  });
  const shanghai = runWithTz("Asia/Shanghai");
  const paris = runWithTz("Europe/Paris");
  assert.equal(shanghai, expected, "TZ=Asia/Shanghai 与进程内一致");
  assert.equal(paris, expected, "TZ=Europe/Paris（UTC+1）与 UTC+8 一致——宿主时区不参与");
});

// ── 投影 ─────────────────────────────────────────────────────────────────────

const scale = { "5": "最强", "4": "强", "3": "堪用", "2": "弱", "1": "不适合" };
const laneDoc = (lanesArr) => ({ ok: true, sha256: "a".repeat(64), lanes: lanesArr, issues: [] });
const LANE_A = { id: "la", backend: "zcode", model: { id: "m1" }, reasoning: { effort: "max" } };

function traitsResult(traits, over = {}) {
  return {
    state: "ok", path: "t.json", sha256: "b".repeat(64), scale,
    costTierScale: "成本档说明", ownerRules: [], observations: [], issues: [],
    invalidIds: [], traits, ...over,
  };
}

test("152 投影：声明 peak 的行带 peakNow（恰三键）；没声明的行不带键；顶层 now 随注入时钟", () => {
  const nowMs = bjEpoch(2026, 11, 26, 15, 0); // 周四 15:00
  const proj = projectLaneProfiles({
    lanesDoc: laneDoc([LANE_A]),
    traitsResult: traitsResult({ la: validEntry({ peak: GLM_PEAK }) }),
    nowMs,
  });
  assert.deepEqual(proj.rows[0].peakNow, {
    state: "peak", until: "2026-11-26T18:00:00+08:00", untilLocal: "18:00",
  });
  assert.deepEqual(Object.keys(proj.rows[0].peakNow).sort(), ["state", "until", "untilLocal"], "恰三键");
  assert.deepEqual(proj.now, { beijing: "周四 15:00", holidaysRecognized: false }, "顶层 now 随注入时钟");

  const bare = projectLaneProfiles({
    lanesDoc: laneDoc([LANE_A]),
    traitsResult: traitsResult({ la: validEntry() }),
    nowMs,
  });
  assert.equal("peakNow" in bare.rows[0], false, "没声明 peak 的行不带键");
  assert.deepEqual(bare.now, { beijing: "周四 15:00", holidaysRecognized: false }, "now 与 peak 无关，总在场");
});

test("152 投影：非法 peak 降级后行不带 peakNow，notices 记观察", () => {
  const proj = projectLaneProfiles({
    lanesDoc: laneDoc([LANE_A]),
    traitsResult: traitsResult(
      { la: validateTraitEntry("la", validEntry({ peak: { ...GLM_PEAK, hours: ["18:00-02:00"] } })).entry },
      { observations: ["车道 la 画像：peak 不合法，按未给（无高峰）处理"] },
    ),
    nowMs: bjEpoch(2026, 11, 26, 15, 0),
  });
  assert.equal("peakNow" in proj.rows[0], false, "降级=缺席");
  assert.deepEqual(proj.notices, ["车道 la 画像：peak 不合法，按未给（无高峰）处理"]);
});

// ── preflight 聚合器与 MCP 边界 ──────────────────────────────────────────────

const noWorkers = async () => ({ agents: [], issues: [], issuesTruncated: false });
const noRuns = async () => ({ runs: [], matchedCount: 0, unresolvedCount: 0 });
const binding = { bound: true, source: "call_target", root: "/A", gitHead: "a".repeat(40), dirty: false };

test("152 preflight：lanes 行 peakNow 与顶层 now 同源透传；worker 上下文两者同 null", async () => {
  const projection = projectLaneProfiles({
    lanesDoc: laneDoc([LANE_A]),
    traitsResult: traitsResult({ la: validEntry({ peak: GLM_PEAK }) }),
    nowMs: bjEpoch(2026, 11, 26, 22, 15), // 周四 22:15
  });
  const result = await aggregateLeadPreflight({
    workspaceBinding: binding,
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: noWorkers,
    listRunsFn: noRuns,
    workerContextFn: () => null,
    laneProfilesFn: async () => projection,
  });
  assert.deepEqual(result.now, { beijing: "周四 22:15", holidaysRecognized: false }, "顶层 now=投影的 now");
  // 周四 22:15 在 GLM 高峰（14:00-18:00）外 → off_peak，至周五 14:00。
  assert.deepEqual(result.lanes.rows[0].peakNow, {
    state: "off_peak", until: "2026-11-27T14:00:00+08:00", untilLocal: "周五 14:00",
  }, "行 peakNow 透传");
  assert.equal("now" in result.lanes, false, "lanes 子对象不带 now（now 在顶层）");

  const worker = await aggregateLeadPreflight({
    workspaceBinding: binding,
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: noWorkers,
    listRunsFn: noRuns,
    workerContextFn: () => ({ reason: "env-marker", detail: "fixture" }),
    laneProfilesFn: async () => projection,
  });
  assert.equal(worker.lanes, null);
  assert.equal(worker.now, null, "worker 上下文 now 与 lanes 同 null");

  const unreadable = await aggregateLeadPreflight({
    workspaceBinding: binding,
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: noWorkers,
    listRunsFn: noRuns,
    workerContextFn: () => null,
    laneProfilesFn: async () => null,
  });
  assert.equal(unreadable.now, null, "画像读不出 → now null（同一次结算，不单独读时钟）");
});

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
  const client = new Client({ name: "wao-lanepeak-test", version: "0.0.1" }, { capabilities: {} });
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

test("152 MCP lead_preflight：peakNow 行与顶层 now 过整份出参 schema；无 peak 投影 now=null 仍合规", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lanepeak-mcp-"));
  try {
    const projection = projectLaneProfiles({
      lanesDoc: laneDoc([LANE_A]),
      traitsResult: traitsResult({ la: validEntry({ peak: DS_PEAK, quotaPool: "测试额度池" }) }),
      nowMs: bjEpoch(2026, 11, 26, 12, 30),
    });
    const { server, client } = await buildServerClient({
      dir,
      registryPath: makeRegistry(dir),
      overrides: { laneProfilesFn: async () => projection, workerContextFn: () => null },
    });
    try {
      const res = await client.callTool({ name: "lead_preflight", arguments: {} });
      assert.ok(!res.isError, "带 peakNow/now/quotaPool 的投影过 LEAD_PREFLIGHT_OUTPUT");
      assert.deepEqual(res.structuredContent.now, { beijing: "周四 12:30", holidaysRecognized: false });
      const row = res.structuredContent.lanes.rows[0];
      assert.deepEqual(row.peakNow, {
        state: "off_peak", until: "2026-11-26T14:00:00+08:00", untilLocal: "14:00",
      });
      assert.equal(row.quotaPool, "测试额度池", "行带 quotaPool 过 schema（153 批）");

      // 无 peak、无 now 的旧形状投影（0097 形）：now=null、行不带 peakNow，仍合规；
      // quotaPool 闭环内没给即 null（不造默认值）。
      const legacy = { ...projectLaneProfiles({
        lanesDoc: laneDoc([LANE_A]),
        traitsResult: traitsResult({ la: validEntry() }),
        nowMs: bjEpoch(2026, 11, 26, 12, 30),
      }) };
      delete legacy.now;
      const { server: s2, client: c2 } = await buildServerClient({
        dir,
        registryPath: makeRegistry(dir),
        overrides: { laneProfilesFn: async () => legacy, workerContextFn: () => null },
      });
      try {
        const res2 = await c2.callTool({ name: "lead_preflight", arguments: {} });
        assert.ok(!res2.isError, "旧形状投影仍合规");
        assert.equal(res2.structuredContent.now, null, "投影无 now → null（同源缺席）");
        assert.equal("peakNow" in res2.structuredContent.lanes.rows[0], false);
        assert.equal(res2.structuredContent.lanes.rows[0].quotaPool, null, "没给 quotaPool → null");
      } finally { await c2.close(); await s2.close(); }
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

// ── 真实数据：config/lane-traits.json 本身 ───────────────────────────────────

// 只钉形状与口径，不钉 Owner 给的值。
test("152 真实数据：Owner 规则在条数与总字数预算内；四条车道的 peak 合法；cost 无时段与 UTC 换算", () => {
  const r = readLaneTraits();
  assert.equal(r.state, "ok", "真实画像文件必须可读且顶层合法");
  assert.deepEqual(r.issues, [], "零 issue");
  assert.deepEqual(r.observations, [], "零降级观察");
  // 条数与字数是 Owner 的值，只钉上限（决定 0135：至多 OWNER_RULES_CAP 条、合计不超总预算）。
  assert.ok(Array.isArray(r.ownerRules) && r.ownerRules.length >= 1 && r.ownerRules.length <= OWNER_RULES_CAP,
    "Owner 规则非空且不超条数上限");
  const totalChars = r.ownerRules.reduce((sum, rule) => sum + rule.length, 0);
  assert.ok(totalChars <= OWNER_RULES_TOTAL_MAX_CHARS, `规则合计 ${totalChars} 字，不超总预算`);
  const peakLanes = ["glm-flash", "glm-pro", "deepseek-flash", "deepseek-pro"];
  const lanesDoc = loadLanesConfig();
  for (const lane of lanesDoc.lanes) {
    const entry = r.traits[lane.id];
    assert.ok(entry, `${lane.id} 在画像里`);
    if (peakLanes.includes(lane.id)) {
      assert.equal(validPeak(entry.peak), true, `${lane.id}.peak 合法`);
    } else {
      assert.equal("peak" in entry, false, `${lane.id} 不声明 peak`);
    }
    assert.equal((entry.cost ?? "").includes("UTC"), false, `${lane.id}.cost 不再携带 UTC 换算`);
  }
  // 高峰时段与 cost 的价档对应：GLM 单段 14-18；DeepSeek 双段。
  assert.deepEqual(r.traits["glm-flash"].peak.hours, ["14:00-18:00"]);
  assert.deepEqual(r.traits["glm-pro"].peak.hours, ["14:00-18:00"]);
  assert.deepEqual(r.traits["deepseek-flash"].peak.hours, ["09:00-12:00", "14:00-18:00"]);
  assert.deepEqual(r.traits["deepseek-pro"].peak.hours, ["09:00-12:00", "14:00-18:00"]);
  // 153 批：额度池结构化——每条车道带 1–40 字的 quotaPool；同名=共用一份额度，
  // 池内成员按车道表声明序；同一事实只写一处（cost 不再写"共用"字样）。
  const pools = {};
  for (const lane of lanesDoc.lanes) {
    const p = r.traits[lane.id].quotaPool;
    assert.ok(typeof p === "string" && p.length >= 1 && p.length <= 40, `${lane.id}.quotaPool 1–40 字`);
    (pools[p] ??= []).push(lane.id);
    assert.equal((r.traits[lane.id].cost ?? "").includes("共用"), false, `${lane.id}.cost 不再携带共用额度字样`);
  }
  assert.deepEqual(pools, {
    "GLM Coding Plan": ["glm-flash", "glm-pro"],
    "Kimi 订阅": ["kimi"],
    "codex 订阅": ["astra", "sol"],
    "DeepSeek API 余额": ["deepseek-pro", "deepseek-flash"],
    "Claude 订阅": ["opus", "fable", "sonnet"],
  }, "额度池分组（池内=声明序）");
  // 真实投影零 notices；此刻计算可用（用真实当前时钟跑一次，只验形状）。
  const proj = projectLaneProfiles({ lanesDoc, traitsResult: r });
  assert.ok(proj != null && proj.now != null, "真实投影带顶层 now");
  assert.deepEqual(proj.notices, [], "真实投影零 notices");
  for (const row of proj.rows) {
    if (peakLanes.includes(row.id)) {
      assert.ok(row.peakNow != null && ["peak", "off_peak"].includes(row.peakNow.state),
        `${row.id}.peakNow 形状合法`);
    } else {
      assert.equal("peakNow" in row, false);
    }
    assert.equal(typeof row.quotaPool, "string", `${row.id} 投影行带 quotaPool`);
  }
});
