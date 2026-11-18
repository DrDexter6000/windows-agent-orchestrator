// test/registry-roles/laneReviewStats.test.js
//
// 0089（116 批 + 修正轮）：会审席位统计（画像复核的输入）的可证伪面：
//   - inferVerdict 词表与"结论位置"：结论词须在行首或结论标签（含修饰词/否定）
//     之后才算，词内/第 4 行起/句中（测试计数、fail()）不认；PASS 词前紧挨否定
//     改判 FIX_FIRST；连字符/空格拼写变体与中文 PASS_WITH_NOTES 变体归类；
//   - 计数：每车道席位数、作答数（declared/inferred 之和）、各结论次数（含
//     constructor 这类键名）；两种读法都取不到的席位算未作答；
//   - 两两比较：任何一次会审里有 ≥2 席结论属于 VERDICT_RANK 就比较（不论
//     声明还是推断），同车道配对不自比；独立会审运行没有同场席位，不参与比较；
//   - 收集：按 consultId 去重、createdAt 落在 [since, until) 才计、坏记录跳过；
//     席位结论先按声明 Q1 读（declared），读不出再 inferVerdict（inferred）；
//   - 数据源：本检出/工作树/归档目录之外，从 runs/projects/ 桶的转录 project
//     事实发现各项目的 .wao/runs/consults（坏路径跳过不炸）；项目桶（有
//     .project.json）里 roleId auditor/reviewer 且带 runId 绑定只读声明的运行
//     算独立会审（跨桶按 runId 去重；排除面=全部会审记录的席位，不限时间窗）；
//   - CLI：--json 的 standaloneReviews/withTwoPlusRatedSeats；位置参数目录时
//     不做发现、不收独立会审。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  aggregateSeatVerdicts,
  collectConsults,
  collectStandaloneReviews,
  consultSeatRunIds,
  dedupeDirs,
  defaultConsultDirs,
  discoverProjectConsultDirs,
  headReadSync,
  inferVerdict,
  ratedSeatCount,
  renderLaneReviewStats,
} from "../../scripts/reliability/laneReviewStats.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

const MERGE_Q1 = ["PASS", "PASS_WITH_NOTES", "FIX_FIRST"];

function record(consultId, createdAt, seats, q1 = MERGE_Q1) {
  return { consultId, createdAt, ...(q1 === null ? {} : { declaredFields: { Q1: q1 } }), seats };
}

// 合成转录行（形状照真实转录：信封带 runId/agentId/ts/seq/type）。
function envelope(runId, agentId, type, ts, extra = {}) {
  return JSON.stringify({ ts, seq: 1, runId, agentId, type, ...extra });
}

function startedLine(runId, agentId, ts, { laneId, roleId, project } = {}) {
  return envelope(runId, agentId, "run.started", ts, {
    ...(laneId !== undefined ? { laneId } : {}),
    ...(roleId !== undefined ? { roleId } : {}),
    ...(project !== undefined ? { project } : {}),
  });
}

function readOnlyLine(runId, agentId, ts) {
  return envelope(runId, agentId, "run.read_only_declared", ts);
}

function replyLine(runId, agentId, ts, text) {
  return JSON.stringify({
    ts, runId, agentId, type: "run.event", kind: "message", role: "assistant",
    parts: [{ type: "text", text }],
  });
}

/** 造一个项目桶（含 .project.json——项目桶的持久标记）并返回桶路径。 */
function makeProjectBucket(runDir, bucket, key) {
  const dir = join(runDir, "projects", bucket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".project.json"), JSON.stringify({ key, slug: bucket }));
  return dir;
}

// ── inferVerdict ──

test("inferVerdict：Lead 抽查到的误判全部修正", () => {
  assert.equal(inferVerdict("结论：**暂不 MERGE**。以下为……")?.verdict, "FIX_FIRST", "否定改判");
  assert.equal(inferVerdict("评审对象是 a010a0e……相关现有测试 **184 passed**，仅作为……"), null, "测试计数不算结论");
  assert.equal(inferVerdict("发现 7 项实现/文档问题，另有 1 项测试缺口。……基线新测试 **93 passed**。"), null);
  assert.equal(inferVerdict("我只核你列出的收口项：失败分支断言、setdesc 调用顺序、⚠ 断言、fail() 加固……"), null, "句中 fail() 不算");
  assert.equal(inferVerdict("The baseline already contradicts the proposed framing ... blocking ..."), null, "句中 blocking 不算");
});

test("inferVerdict：结论位置（行首或标签+修饰词之后）", () => {
  const hit = (text) => inferVerdict(text)?.verdict ?? null;
  assert.equal(hit("结论：**整体 GO-WITH-CHANGES**"), "FIX_FIRST");
  assert.equal(hit("本席结论：**整体 GO-WITH-CHANGES**"), "FIX_FIRST");
  assert.equal(hit("## 总判定：GO（没有必修项……）"), "PASS");
  assert.equal(hit("**没有发现 FAIL 级问题，PASS**"), null, "句中 FAIL/PASS 都不在结论位置");
  assert.equal(hit("**通过率 0.74（159 条谱系）**"), null, "结论词后紧挨汉字（通过率）不算");
  assert.equal(hit("**Q1: FIX_FIRST**"), "FIX_FIRST");
  assert.equal(hit("### 结论：通过"), "PASS");
  assert.equal(hit("> FAIL"), "FIX_FIRST");
  assert.equal(hit("Verdict: PASS_WITH_NOTES"), "PASS_WITH_NOTES");
  assert.equal(hit("Decision: REJECT"), "FIX_FIRST");
  assert.equal(hit("意见：LGTM"), "PASS");
});

test("inferVerdict：否定与拼写变体", () => {
  const hit = (text) => inferVerdict(text)?.verdict ?? null;
  assert.equal(hit("暂不 MERGE"), "FIX_FIRST");
  assert.equal(hit("未通过"), "FIX_FIRST");
  assert.equal(hit("无法通过"), "FIX_FIRST");
  assert.equal(hit("没有通过"), "FIX_FIRST");
  assert.equal(hit("NOT PASS"), "FIX_FIRST");
  assert.equal(hit("FIX-FIRST"), "FIX_FIRST");
  assert.equal(hit("NO GO"), "FIX_FIRST");
  assert.equal(hit("CHANGES REQUESTED"), "FIX_FIRST");
  assert.equal(hit("BLOCKED"), "FIX_FIRST");
  assert.equal(hit("PASS-WITH-NOTES"), "PASS_WITH_NOTES");
  assert.equal(hit("有条件通过"), "PASS_WITH_NOTES");
  assert.equal(hit("带建议通过"), "PASS_WITH_NOTES");
  assert.equal(hit("LGTM"), "PASS");
  assert.equal(hit("MERGE"), "PASS");
  assert.equal(hit("CLOSED"), "PASS");
  assert.equal(hit("APPROVED"), "PASS");
  assert.equal(hit("GO"), "PASS");
  assert.equal(hit("PASSED"), "PASS");
  assert.equal(hit("APPROVE-WITH-NOTES"), "PASS_WITH_NOTES");
});

test("inferVerdict：否定推广与长词不回退（第二修正轮）", () => {
  const hit = (text) => inferVerdict(text)?.verdict ?? null;
  // 否定 + PASS_WITH_NOTES 类 → FIX_FIRST；否定 + FIX_FIRST 类 → 未识别。
  assert.equal(hit("NOT PASS_WITH_NOTES"), "FIX_FIRST");
  assert.equal(hit("结论：暂不有条件通过"), "FIX_FIRST");
  assert.equal(hit("NO CHANGES REQUESTED"), null, "被否定的'要求修改'不是真实结论");
  assert.equal(hit("不需要先修"), null);
  // 长词后边界失败不退回短词；判断后邻前先剥离 **。
  assert.equal(hit("GO-WITH-CHANGES需要补证"), null, "不退回 GO");
  assert.equal(hit("PASS-WITH-NOTES率"), null, "不退回 PASS");
  assert.equal(hit("**通过**率"), null);
  // 函数调用不是结论。
  assert.equal(hit("fail() 加固了空参数校验"), null);
  // 后邻是标点的正常命中（sol 复核确认的口径）。
  assert.equal(hit("通过。"), "PASS");
  assert.equal(hit("通过（两条建议）"), "PASS");
});

test("inferVerdict：词表命中与边界（第 116 批原用例，新规则下仍成立）", () => {
  const cases = [
    ["**FAIL — b2aa2e4 can forward outside the workspace**", "FIX_FIRST", "FAIL"],
    ["Q1. **PASS_WITH_NOTES**：y", "PASS_WITH_NOTES", "PASS_WITH_NOTES"],
    ["FIX_FIRST — 私有克隆方向成立，但……", "FIX_FIRST", "FIX_FIRST"],
    ["Q1: ADJUST", "FIX_FIRST", "ADJUST"],
    ["PASS", "PASS", "PASS"],
    ["Q1：通过", "PASS", "通过"],
    ["> 结论：可以合并", "PASS", "可以合并"],
    ["- **REJECT**：证据不足", "FIX_FIRST", "REJECT"],
    ["不通过", "FIX_FIRST", "不通过"],
    ["NO-GO", "FIX_FIRST", "NO-GO"],
    ["先修：三个问题", "FIX_FIRST", "先修"],
  ];
  for (const [text, verdict, token] of cases) {
    const h = inferVerdict(text);
    assert.ok(h, `应识别：${text}`);
    assert.equal(h.verdict, verdict, text);
    assert.equal(h.token, token, text);
    assert.equal(h.line, text.slice(0, 120), "line 是命中的原始行（截 120）");
  }
  assert.equal(inferVerdict("NO-GO").verdict, "FIX_FIRST");
  assert.equal(inferVerdict("不通过").verdict, "FIX_FIRST");
  // null 面：第 4 个非空行、空串、词内命中（passing 含 pass）、Q1 粘连。
  assert.equal(inferVerdict("开场\n\n铺垫一\n铺垫二\nFAIL"), null, "只看前 3 个非空行");
  assert.equal(inferVerdict(""), null);
  assert.equal(inferVerdict("passing tests are green"), null, "词内命中不算");
  assert.equal(inferVerdict(null), null, "非字符串输入不算");
  assert.equal(inferVerdict("**Q1PASS** 是检查编号，实际结论 FAIL"), null, "Q1 粘连不剥标签");
  assert.equal(inferVerdict("Q1PASS"), null);
  // 多行时返回首个命中行的原文；行截到 120 字符。
  const multi = inferVerdict("第一行铺垫\nFAIL — 证据不足\nPASS");
  assert.equal(multi.verdict, "FIX_FIRST");
  assert.equal(multi.line, "FAIL — 证据不足");
  const longLine = `FAIL — ${"detail ".repeat(40)}`;
  assert.equal(inferVerdict(longLine).line.length, 120);
});

// ── 聚合（纯函数） ──

test("aggregateSeatVerdicts：计数、declared/inferred、未作答、2+ 结论席位的两两比较", () => {
  const lanes = aggregateSeatVerdicts([
    { seats: [{ lane: "sol", q1: "FIX_FIRST", source: "declared" }, { lane: "kimi", q1: "PASS_WITH_NOTES", source: "inferred" }, { lane: "opus", q1: null }] },
    { seats: [{ lane: "sol", q1: "PASS" }, { lane: "kimi", q1: "PASS" }] },
    { seats: [{ lane: "sol", q1: "OK" }, { lane: "kimi", q1: "FOUND" }] },
  ]);
  assert.equal(lanes.sol.seats, 3);
  assert.equal(lanes.sol.answered, 3);
  assert.equal(lanes.sol.declared, 3, "自定义声明值（OK）也算 declared 作答");
  assert.equal(lanes.sol.inferred, 0);
  assert.deepEqual(lanes.sol.verdicts, { FIX_FIRST: 1, PASS: 1, OK: 1 });
  assert.deepEqual(lanes.sol.stricterThan, { kimi: 1 });
  assert.deepEqual(lanes.sol.sameAs, { kimi: 1 });
  assert.equal(lanes.kimi.declared, 2);
  assert.equal(lanes.kimi.inferred, 1);
  assert.deepEqual(lanes.kimi.lenientThan, { sol: 1 });
  assert.equal(lanes.opus.seats, 1);
  assert.equal(lanes.opus.answered, 0, "两种读法都取不到算未作答");
  assert.deepEqual(lanes.opus.stricterThan, {}, "未作答的席位不参与比较");
  assert.deepEqual(lanes.sol.lenientThan, {}, "无 VERDICT_RANK 结论席（OK/FOUND）的会审不比较");
});

test("aggregateSeatVerdicts：ratedSeatCount 阈值、同车道不自比、constructor 键", () => {
  // 只有一个结论席位：不比较，首行 M 也不计。
  const one = [{ seats: [{ lane: "sol", q1: "FIX_FIRST" }, { lane: "kimi", q1: "OK" }] }];
  assert.equal(ratedSeatCount(one[0]), 1, "OK 是作答但不是结论席位");
  assert.equal(one.filter((c) => ratedSeatCount(c) >= 2).length, 0);
  const lanesOne = aggregateSeatVerdicts(one);
  assert.deepEqual(lanesOne.sol.stricterThan, {});
  assert.deepEqual(lanesOne.sol.sameAs, {}, "非 VERDICT_RANK 的作答（OK）不进比较");
  assert.match(renderLaneReviewStats({ consults: one, lanes: lanesOne }), /consults 1 \(with 2\+ rated seats 0\)/,
    "单结论席位的会审不计入首行 M（render 侧阈值）");
  // 两个 sol 席位不自比；sol↔kimi 照比（sol 两席各自对 kimi：一严一同）。
  const lanes = aggregateSeatVerdicts([
    { seats: [{ lane: "sol", q1: "FIX_FIRST" }, { lane: "sol", q1: "PASS" }, { lane: "kimi", q1: "PASS" }] },
  ]);
  assert.deepEqual(lanes.sol.stricterThan, { kimi: 1 }, "同车道配对跳过");
  assert.deepEqual(lanes.sol.lenientThan, {}, "sol 的 FIX_FIRST 席对 kimi 更严、PASS 席相同，无更松对");
  assert.deepEqual(lanes.sol.sameAs, { kimi: 1 }, "sol 的 PASS 席与 kimi 相同；sol 对 sol 不自比");
  assert.deepEqual(lanes.kimi.sameAs, { sol: 1 });
  // constructor 这类键名：计数必须是数字。
  const lanesCtor = aggregateSeatVerdicts([
    { seats: [{ lane: "sol", q1: "constructor", source: "declared" }, { lane: "sol", q1: "__proto__", source: "declared" }] },
  ]);
  assert.equal(lanesCtor.sol.verdicts.constructor, 1);
  assert.equal(lanesCtor.sol.verdicts.__proto__, 1);
});

test("aggregateSeatVerdicts：车道键 constructor/__proto__ 不踩原型", () => {
  const lanes = aggregateSeatVerdicts(
    [{ seats: [{ lane: "__proto__", q1: "FIX_FIRST", source: "inferred" }] }],
    [{ lane: "constructor", q1: "PASS", source: "inferred" }],
  );
  assert.equal(lanes["__proto__"].seats, 1);
  assert.deepEqual(lanes["__proto__"].verdicts, { FIX_FIRST: 1 });
  assert.equal(lanes["constructor"].seats, 1);
  assert.deepEqual(lanes["constructor"].verdicts, { PASS: 1 });
  // 序列化面（CLI --json）也携带这两个键。
  const json = JSON.parse(JSON.stringify(lanes));
  assert.equal(json["constructor"].seats, 1);
  assert.equal(json["__proto__"].seats, 1);
});

test("aggregateSeatVerdicts：独立会审只计数，不参与比较", () => {
  const lanes = aggregateSeatVerdicts(
    [{ seats: [{ lane: "sol", q1: "PASS", source: "declared" }] }],
    [{ lane: "kimi", q1: "FIX_FIRST", source: "inferred" }, { lane: "opus", q1: null }],
  );
  assert.equal(lanes.kimi.seats, 1);
  assert.equal(lanes.kimi.inferred, 1);
  assert.equal(lanes.opus.seats, 1);
  assert.equal(lanes.opus.answered, 0);
  assert.deepEqual(lanes.sol.stricterThan, {}, "独立会审没有同场席位");
  assert.deepEqual(lanes.kimi.stricterThan, {});
});

// ── collectConsults ──

test("collectConsults：去重、时间窗、坏记录跳过；声明读得出记 declared，读不出推断记 inferred", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lrs-"));
  try {
    const a = join(dir, "a");
    const b = join(dir, "b");
    mkdirSync(a);
    mkdirSync(b);
    const seats = [
      { agentId: "sol", runId: "run_s1" },
      { agentId: "kimi", runId: "run_k1" },
      { agentId: "opus", runId: "run_gone" },
    ];
    writeFileSync(join(a, "consult_1.json"), JSON.stringify(record("consult_1", "2026-10-10T08:00:00.000Z", seats)));
    writeFileSync(join(b, "consult_1.json"), JSON.stringify(record("consult_1", "2026-10-10T08:00:00.000Z", seats)));
    writeFileSync(join(a, "consult_old.json"), JSON.stringify(record("consult_old", "2026-10-01T08:00:00.000Z", seats)));
    writeFileSync(join(a, "consult_late.json"), JSON.stringify(record("consult_late", "2026-10-20T08:00:00.000Z", seats)));
    writeFileSync(join(a, "consult_bad.json"), "{not json");
    writeFileSync(join(a, "notes.txt"), "ignored");
    const replies = {
      run_s1: "Q1: FIX_FIRST\n理由", // 声明 Q1 读得出 → declared
      run_k1: "**FAIL — 方向不对**", // 声明 Q1 读不出（FAIL 不在声明值里）→ 推断 FIX_FIRST
    };
    const observeFn = async ({ runId }) => {
      if (!(runId in replies)) throw new Error("transcript unreadable");
      return { finalText: replies[runId] };
    };
    const consults = await collectConsults({ dirs: [a, b], runDir: join(dir, "runs"), since: "2026-10-06", until: "2026-10-18", observeFn });
    assert.deepEqual(consults.map((c) => c.consultId), ["consult_1"], "按 consultId 去重；窗外与坏记录不计");
    assert.deepEqual(consults[0].seats, [
      { lane: "sol", runId: "run_s1", q1: "FIX_FIRST", source: "declared" },
      { lane: "kimi", runId: "run_k1", q1: "FIX_FIRST", source: "inferred" },
      { lane: "opus", runId: "run_gone", q1: null },
    ]);
    const report = renderLaneReviewStats({ consults, lanes: aggregateSeatVerdicts(consults) });
    assert.match(report, /^consults 1 \(with 2\+ rated seats 1\), standalone reviews 0/);
    assert.match(report, /sol: reviews 1, answered 1 \(declared 1, inferred 0\), unrecognized 0 — FIX_FIRST 1/);
    assert.match(report, /kimi: reviews 1, answered 1 \(declared 0, inferred 1\), unrecognized 0 — FIX_FIRST 1/);
    assert.match(report, /opus: reviews 1, answered 0 \(declared 0, inferred 0\), unrecognized 1 — -/);
  } finally { cleanupDir(dir); }
});

test("collectConsults + consultSeatRunIds：坏 seats/坏席位跳过不计，命令不抛", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lrs-badrec-"));
  try {
    const consultsDir = join(dir, "consults");
    mkdirSync(consultsDir);
    const t = "2026-11-02T08:00:00.000Z";
    // 正常记录 + 三种坏形状（seats 非数组、席位 null/非对象、席位缺 agentId/runId）。
    writeFileSync(join(consultsDir, "consult_good.json"), JSON.stringify(record("consult_good", t, [
      { agentId: "sol", runId: "run_bg1" },
      null,
      "not a seat",
      { runId: "run_bg2" }, // 缺 agentId
      { agentId: "kimi" }, // 缺 runId
    ])));
    writeFileSync(join(consultsDir, "consult_seats.json"), JSON.stringify({ consultId: "consult_seats", createdAt: t, seats: "nope" }));
    writeFileSync(join(consultsDir, "consult_null.json"), JSON.stringify({ consultId: "consult_null", createdAt: t, seats: [null] }));
    // 坏席位跳过不计（注释里写明的取舍）：无法回链到运行的席位不是可统计证据。
    const out = await collectConsults({
      dirs: [consultsDir], runDir: join(dir, "runs"),
      observeFn: async ({ runId }) => ({ finalText: runId === "run_bg1" ? "PASS" : "FAIL" }),
    });
    assert.deepEqual(out.map((c) => c.consultId).sort(), ["consult_good", "consult_null", "consult_seats"]);
    assert.deepEqual(out.find((c) => c.consultId === "consult_good").seats, [
      { lane: "sol", runId: "run_bg1", q1: "PASS", source: "inferred" },
    ], "null/非对象/缺 agentId/runId 的席位不计");
    assert.deepEqual(out.find((c) => c.consultId === "consult_seats").seats, [], "seats 非数组按零席位处理");
    assert.deepEqual(out.find((c) => c.consultId === "consult_null").seats, []);
    // 排除面同样只收有效席位的 runId（缺 agentId 的席位一并跳过），不抛。
    assert.deepEqual([...consultSeatRunIds({ dirs: [consultsDir] })].sort(), ["run_bg1"]);
  } finally { cleanupDir(dir); }
});

test("collectConsults：目录不可读（是个文件）时跳过，不抛", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lrs-notdir-"));
  try {
    const notDir = join(dir, "consults-file");
    writeFileSync(notDir, "{}");
    const consults = await collectConsults({ dirs: [notDir], runDir: join(dir, "runs") });
    assert.deepEqual(consults, []);
  } finally { cleanupDir(dir); }
});

test("collectConsults：默认读法从席位转录的最终答复取 Q1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lrs-real-"));
  try {
    const consults = join(dir, "consults");
    const runDir = join(dir, "runs");
    mkdirSync(consults);
    mkdirSync(runDir);
    const event = (text) => replyLine("run_real1", "kimi", "2026-10-10T08:01:00.000Z", text);
    writeFileSync(join(runDir, "run_real1.jsonl"), [event("先看一下文件。"), event("Q1: PASS_WITH_NOTES\n\n理由与证据。")].join("\n") + "\n");
    writeFileSync(join(consults, "consult_r.json"), JSON.stringify(record("consult_r", "2026-10-10T08:00:00.000Z", [{ agentId: "kimi", runId: "run_real1" }])));
    const out = await collectConsults({ dirs: [consults], runDir });
    assert.deepEqual(out[0].seats, [{ lane: "kimi", runId: "run_real1", q1: "PASS_WITH_NOTES", source: "declared" }], "只看最后一条答复");
  } finally { cleanupDir(dir); }
});

test("collectConsults：未声明 Q1 的会审全靠推断", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lrs-nodecl-"));
  try {
    const consults = join(dir, "consults");
    mkdirSync(consults);
    writeFileSync(join(consults, "consult_n.json"), JSON.stringify(record("consult_n", "2026-10-10T08:00:00.000Z", [
      { agentId: "sol", runId: "run_i1" },
      { agentId: "kimi", runId: "run_i2" },
    ], null)));
    const replies = { run_i1: "FAIL — 证据不足\n细节", run_i2: "PASS\n细节" };
    const consultsOut = await collectConsults({
      dirs: [consults], runDir: join(dir, "runs"),
      observeFn: async ({ runId }) => ({ finalText: replies[runId] }),
    });
    assert.deepEqual(consultsOut[0].seats, [
      { lane: "sol", runId: "run_i1", q1: "FIX_FIRST", source: "inferred" },
      { lane: "kimi", runId: "run_i2", q1: "PASS", source: "inferred" },
    ]);
    // 比较放宽：两席都没声明 Q1，推断出 FIX_FIRST 与 PASS → 出现一次更严/更松。
    const lanes = aggregateSeatVerdicts(consultsOut);
    assert.deepEqual(lanes.sol.stricterThan, { kimi: 1 });
    assert.deepEqual(lanes.kimi.lenientThan, { sol: 1 });
    assert.match(renderLaneReviewStats({ consults: consultsOut, lanes }), /with 2\+ rated seats 1/);
  } finally { cleanupDir(dir); }
});

// ── 项目会审目录发现 ──

test("discoverProjectConsultDirs + collectConsults：从转录 project 事实发现项目会审目录", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lrs-disc-"));
  try {
    const projDir = join(dir, "proj-repo");
    const projKey = projDir.replace(/\\/g, "/").toLowerCase();
    const consultsDir = join(projDir, ".wao", "runs", "consults");
    mkdirSync(consultsDir, { recursive: true });
    writeFileSync(join(consultsDir, "consult_x.json"), JSON.stringify(record("consult_x", "2026-11-02T08:00:00.000Z", [{ agentId: "sol", runId: "run_px" }])));
    const runDir = join(dir, "runs");
    const bucket = makeProjectBucket(runDir, "proj-repo-1a2b3c4d", projKey);
    const ghostBucket = join(runDir, "projects", "ghost-00000000");
    mkdirSync(ghostBucket, { recursive: true });
    const projectFact = { kind: "project", rulesVersion: "td190-r3", key: projKey, bucket: "proj-repo-1a2b3c4d" };
    const lines = [
      startedLine("run_px", "sol", "2026-11-02T08:00:00.000Z", { project: projectFact }),
      replyLine("run_px", "sol", "2026-11-02T08:05:00.000Z", "PASS — 方向成立"),
    ];
    writeFileSync(join(bucket, "run_px.jsonl"), lines.join("\n") + "\n");
    writeFileSync(join(ghostBucket, "run_g.jsonl"),
      startedLine("run_g", "sol", "2026-11-02T08:00:00.000Z", { project: { kind: "project", key: "z:/no/such/dir", bucket: "ghost-00000000" } }) + "\n");
    assert.deepEqual(discoverProjectConsultDirs(runDir), [join(projKey, ".wao", "runs", "consults")],
      "目录按转录事实里的 key 形状返回；不存在的目录不收");
    const consults = await collectConsults({
      dirs: discoverProjectConsultDirs(runDir), runDir,
      observeFn: async () => ({ finalText: "FAIL — 先修" }),
    });
    assert.deepEqual(consults.map((c) => c.consultId), ["consult_x"]);
    assert.deepEqual(consults[0].seats, [{ lane: "sol", runId: "run_px", q1: "FIX_FIRST", source: "inferred" }]);
  } finally { cleanupDir(dir); }
});

test("discoverProjectConsultDirs：坏路径逐个跳过，整条命令不炸", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lrs-robust-"));
  try {
    const runDir = join(dir, "runs");
    // 好项目：目录存在。
    const goodProj = join(dir, "good");
    const goodKey = goodProj.replace(/\\/g, "/").toLowerCase();
    mkdirSync(join(goodProj, ".wao", "runs", "consults"), { recursive: true });
    // 坏项目 1：consults 是普通文件（不是目录）。
    const fileProj = join(dir, "fileproj");
    const fileKey = fileProj.replace(/\\/g, "/").toLowerCase();
    mkdirSync(join(fileProj, ".wao", "runs"), { recursive: true });
    writeFileSync(join(fileProj, ".wao", "runs", "consults"), "not a dir");
    // 坏项目 2：key 无盘符（\foo 形态）。
    const noDriveBucket = join(runDir, "projects", "nodrive-00000000");
    mkdirSync(noDriveBucket, { recursive: true });
    writeFileSync(join(noDriveBucket, "run_nd.jsonl"),
      startedLine("run_nd", "sol", "2026-11-02T08:00:00.000Z", { project: { kind: "project", key: "\\no\\drive\\path", bucket: "nodrive-00000000" } }) + "\n");
    // 好桶：含一条坏转录（*.jsonl 名字的目录，排序在前确保被读到）+ 一条好转录。
    const bucket = makeProjectBucket(runDir, "good-1a2b3c4d", goodKey);
    mkdirSync(join(bucket, "aaa-weird.jsonl"), { recursive: true });
    const fileProjBucket = makeProjectBucket(runDir, "fileproj-1a2b3c4d", fileKey);
    const fact = (key, name) => ({ kind: "project", rulesVersion: "td190-r3", key, bucket: name });
    writeFileSync(join(bucket, "run_ok.jsonl"),
      startedLine("run_ok", "sol", "2026-11-02T08:00:00.000Z", { project: fact(goodKey, "good-1a2b3c4d") }) + "\n");
    writeFileSync(join(fileProjBucket, "run_fp.jsonl"),
      startedLine("run_fp", "sol", "2026-11-02T08:00:00.000Z", { project: fact(fileKey, "fileproj-1a2b3c4d") }) + "\n");
    assert.deepEqual(discoverProjectConsultDirs(runDir), [join(goodKey, ".wao", "runs", "consults")],
      "consults 非目录、key 无盘符、坏转录都跳过；好项目照收");
  } finally { cleanupDir(dir); }
});

test("discoverProjectConsultDirs：无 projects/ 或无 project 事实时空收，不抛", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lrs-empty-"));
  try {
    assert.deepEqual(discoverProjectConsultDirs(join(dir, "runs")), []);
    const bucket = join(dir, "runs", "projects", "old-00000000");
    mkdirSync(bucket, { recursive: true });
    writeFileSync(join(bucket, "run_old.jsonl"), startedLine("run_old", "sol", "2026-10-01T00:00:00.000Z") + "\n");
    assert.deepEqual(discoverProjectConsultDirs(join(dir, "runs")), [], "无 project 事实的桶不产出目录");
  } finally { cleanupDir(dir); }
});

test("dedupeDirs：大小写、斜杠方向与尾斜杠折叠为一个", () => {
  assert.deepEqual(dedupeDirs([
    "D:/a/b", "d:\\a\\b\\", "D:/a/B/", "D:\\A\\B", "D:/a/other",
  ]), ["D:/a/b", "D:/a/other"]);
});

// ── 独立会审运行 ──

test("collectStandaloneReviews：auditor/reviewer 只读运行计入；去重与时间窗", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lrs-standalone-"));
  try {
    const runDir = join(dir, "runs");
    const projKey = dir.replace(/\\/g, "/").toLowerCase() + "/repo";
    const bucket = makeProjectBucket(runDir, "proj-repo-1a2b3c4d", projKey);
    const t = (d) => `2026-11-0${d}T08:00:00.000Z`;
    const write = (name, lines) => writeFileSync(join(bucket, name), lines.join("\n") + "\n");
    // 计入：auditor + 只读声明 + 窗内 + 最终答复有结论（laneId ≠ agentId，钉车道取 laneId）。
    write("run_sa1.jsonl", [
      startedLine("run_sa1", "glm-pro", t(2), { laneId: "sol", roleId: "auditor" }),
      readOnlyLine("run_sa1", "glm-pro", t(2)),
      replyLine("run_sa1", "glm-pro", t(2), "**FAIL — b2aa2e4 can forward outside**"),
    ]);
    // 计入：reviewer、缺 laneId → 车道取 agentId；答复为空 → 未识别。
    write("run_sr2.jsonl", [
      startedLine("run_sr2", "glm-pro", t(3), { roleId: "reviewer" }),
      readOnlyLine("run_sr2", "glm-pro", t(3)),
    ]);
    // 不计：没有只读声明。
    write("run_sa3.jsonl", [
      startedLine("run_sa3", "sol", t(4), { laneId: "sol", roleId: "auditor" }),
      replyLine("run_sa3", "sol", t(4), "FAIL"),
    ]);
    // 不计：roleId 不是 auditor/reviewer（首行损坏——扫描器跳坏行后仍能读出 run.started）。
    write("run_sw4.jsonl", [
      "{corrupt first line",
      startedLine("run_sw4", "kimi", t(5), { laneId: "kimi", roleId: "coder" }),
      readOnlyLine("run_sw4", "kimi", t(5)),
      replyLine("run_sw4", "kimi", t(5), "FAIL"),
    ]);
    // 不计：只读声明的 runId 不是本运行的（绑定检查，照 runReadOnlyObservation）。
    write("run_sb5.jsonl", [
      startedLine("run_sb5", "sol", t(6), { laneId: "sol", roleId: "auditor" }),
      readOnlyLine("run_other", "sol", t(6)),
      replyLine("run_sb5", "sol", t(6), "PASS"),
    ]);
    // 不计：run.started 的 runId 不是本文件的（绑定检查）。
    write("run_sc6.jsonl", [
      startedLine("run_zzz", "sol", t(6), { laneId: "sol", roleId: "auditor" }),
      readOnlyLine("run_sc6", "sol", t(6)),
      replyLine("run_sc6", "sol", t(6), "PASS"),
    ]);
    // 不计：runId 已是某会审席位。
    write("run_sd7.jsonl", [
      startedLine("run_sd7", "opus", t(7), { laneId: "opus", roleId: "auditor" }),
      readOnlyLine("run_sd7", "opus", t(7)),
      replyLine("run_sd7", "opus", t(7), "PASS"),
    ]);
    // 不计：_scratch 类非项目桶（无 .project.json）。
    const scratchBucket = join(runDir, "projects", "_scratch");
    mkdirSync(scratchBucket, { recursive: true });
    writeFileSync(join(scratchBucket, "run_sp.jsonl"), [
      startedLine("run_sp", "sol", t(2), { laneId: "sol", roleId: "reviewer" }),
      readOnlyLine("run_sp", "sol", t(2)),
      replyLine("run_sp", "sol", t(2), "PASS"),
    ].join("\n") + "\n");
    // 窗外：ts 早于 since；ts 落在 until 当天也不计（[since, until)）。
    write("run_so8.jsonl", [
      startedLine("run_so8", "sol", "2026-10-01T08:00:00.000Z", { laneId: "sol", roleId: "auditor" }),
      readOnlyLine("run_so8", "sol", "2026-10-01T08:00:00.000Z"),
      replyLine("run_so8", "sol", "2026-10-01T08:00:00.000Z", "FAIL"),
    ]);
    write("run_su0.jsonl", [
      startedLine("run_su0", "sol", "2026-11-08T08:00:00.000Z", { laneId: "sol", roleId: "auditor" }),
      readOnlyLine("run_su0", "sol", "2026-11-08T08:00:00.000Z"),
      replyLine("run_su0", "sol", "2026-11-08T08:00:00.000Z", "FAIL"),
    ]);
    // 计入：reviewer + 标签形结论（Q1: ADJUST → FIX_FIRST）。
    write("run_sa9.jsonl", [
      startedLine("run_sa9", "sol", t(7), { laneId: "sol", roleId: "reviewer" }),
      readOnlyLine("run_sa9", "sol", t(7)),
      replyLine("run_sa9", "sol", t(7), "Q1: ADJUST"),
    ]);
    const out = await collectStandaloneReviews({
      runDir, since: "2026-11-01", until: "2026-11-08",
      excludeRunIds: new Set(["run_sd7"]),
    });
    assert.deepEqual(out, [
      { runId: "run_sa1", lane: "sol", ts: t(2), q1: "FIX_FIRST", source: "inferred" },
      { runId: "run_sa9", lane: "sol", ts: t(7), q1: "FIX_FIRST", source: "inferred" },
      { runId: "run_sr2", lane: "glm-pro", ts: t(3), q1: null },
    ], "桶内按文件名序：run_sa1 < run_sa9 < run_sr2");
    // 聚合进车道：独立会审计入 reviews 与 inferred，不参与比较。
    const lanes = aggregateSeatVerdicts([], out);
    assert.equal(lanes.sol.seats, 2);
    assert.equal(lanes.sol.inferred, 2);
    assert.equal(lanes.sol.answered, 2);
    assert.deepEqual(lanes.sol.stricterThan, {});
    const report = renderLaneReviewStats({ consults: [], standaloneReviews: out, lanes });
    assert.match(report, /^consults 0 \(with 2\+ rated seats 0\), standalone reviews 3/);
  } finally { cleanupDir(dir); }
});

test("collectStandaloneReviews：跨桶同一 runId 只计一次；>64KB 转录只读声明在头窗外仍被收", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lrs-dup-"));
  try {
    const runDir = join(dir, "runs");
    const projKey = dir.replace(/\\/g, "/").toLowerCase() + "/repo";
    const bucketA = makeProjectBucket(runDir, "proj-a-11111111", projKey);
    const bucketB = makeProjectBucket(runDir, "proj-b-22222222", projKey);
    // 两个桶放字节相同的 run_dup.jsonl（sol 复现）。
    const dup = [
      startedLine("run_dup", "sol", "2026-11-02T08:00:00.000Z", { laneId: "sol", roleId: "auditor" }),
      readOnlyLine("run_dup", "sol", "2026-11-02T08:00:00.000Z"),
      replyLine("run_dup", "sol", "2026-11-02T08:00:00.000Z", "PASS"),
    ].join("\n") + "\n";
    writeFileSync(join(bucketA, "run_dup.jsonl"), dup);
    writeFileSync(join(bucketB, "run_dup.jsonl"), dup);
    // >64KB 转录：started 之后一条约 100KB 的单行消息（头窗 64KB 切在它中间），
    // 只读声明在其后；中间混入空行（坏行会让 observeSeatRun 读不了整份转录，
    // 扫描器跳坏行的面由 run_sw4 那个夹具钉）。
    const filler = "x".repeat(100 * 1024);
    const big = [
      startedLine("run_big", "sol", "2026-11-03T08:00:00.000Z", { laneId: "sol", roleId: "auditor" }),
      replyLine("run_big", "sol", "2026-11-03T08:00:00.000Z", filler),
      "",
      readOnlyLine("run_big", "sol", "2026-11-03T08:00:00.000Z"),
      replyLine("run_big", "sol", "2026-11-03T08:05:00.000Z", "结论：暂不 MERGE"),
    ].join("\n") + "\n";
    writeFileSync(join(bucketA, "run_big.jsonl"), big);
    const out = await collectStandaloneReviews({ runDir, since: "2026-11-01", until: "2026-11-08" });
    assert.deepEqual(out.map((r) => r.runId).sort(), ["run_big", "run_dup"], "跨桶去重 + 头窗外回退整读");
    assert.equal(out.find((r) => r.runId === "run_big").q1, "FIX_FIRST", "暂不 MERGE 改判");
    assert.equal(out.find((r) => r.runId === "run_dup").q1, "PASS");
  } finally { cleanupDir(dir); }
});

test("collectStandaloneReviews：头窗短读（每次最多 3 字节）仍能读全判定事实", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lrs-shortread-"));
  try {
    const runDir = join(dir, "runs");
    const projKey = dir.replace(/\\/g, "/").toLowerCase() + "/repo";
    const bucket = makeProjectBucket(runDir, "proj-repo-1a2b3c4d", projKey);
    const t = "2026-11-02T08:00:00.000Z";
    writeFileSync(join(bucket, "run_sh.jsonl"), [
      startedLine("run_sh", "sol", t, { laneId: "sol", roleId: "auditor" }),
      readOnlyLine("run_sh", "sol", t),
      replyLine("run_sh", "sol", t, "PASS"),
    ].join("\n") + "\n");
    // 注入每次最多读 3 字节的 readSync：单次短读被当 EOF 的话，run.started 都读不完。
    const { readSync: realReadSync } = await import("node:fs");
    headReadSync.fn = (fd, buf, offset, length, position) => realReadSync(fd, buf, offset, Math.min(length, 3), position);
    try {
      const out = await collectStandaloneReviews({ runDir, since: "2026-11-01", until: "2026-11-08" });
      assert.deepEqual(out.map((r) => r.runId), ["run_sh"], "循环 readSync 读满或到真 EOF");
      assert.equal(out[0].q1, "PASS");
    } finally {
      headReadSync.fn = null;
    }
  } finally { cleanupDir(dir); }
});

test("consultSeatRunIds + collectStandaloneReviews：排除面用全部会审记录（不限时间窗）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lrs-excl-"));
  try {
    // 会审记录 createdAt 在窗外（2026-11-20 > until 11-08），但其席位 run_s8 的
    // 独立运行 ts 在窗内——不得被当成独立会审。
    const consultsDir = join(dir, "proj", ".wao", "runs", "consults");
    mkdirSync(consultsDir, { recursive: true });
    writeFileSync(join(consultsDir, "consult_c.json"),
      JSON.stringify(record("consult_c", "2026-11-20T08:00:00.000Z", [{ agentId: "sol", runId: "run_s8" }])));
    const runDir = join(dir, "runs");
    const projKey = dir.replace(/\\/g, "/").toLowerCase() + "/proj";
    const bucket = makeProjectBucket(runDir, "proj-1a2b3c4d", projKey);
    const t = "2026-11-02T08:00:00.000Z";
    writeFileSync(join(bucket, "run_s8.jsonl"), [
      startedLine("run_s8", "sol", t, { laneId: "sol", roleId: "auditor" }),
      readOnlyLine("run_s8", "sol", t),
      replyLine("run_s8", "sol", t, "PASS"),
    ].join("\n") + "\n");
    const excludeRunIds = consultSeatRunIds({ dirs: [consultsDir] });
    assert.deepEqual([...excludeRunIds], ["run_s8"], "不限时间窗读全部席位 runId");
    const out = await collectStandaloneReviews({ runDir, since: "2026-11-01", until: "2026-11-08", excludeRunIds });
    assert.deepEqual(out, [], "窗外会审的席位不当独立会审");
  } finally { cleanupDir(dir); }
});

// ── CLI（子进程） ──

test("CLI：--json 钉住 standaloneReviews 与 withTwoPlusRatedSeats；位置参数时不发现不收独立会审", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lrs-cli-"));
  try {
    // 夹具：一个项目（会审记录 + 两席转录）+ 一个独立会审运行。
    const projDir = join(dir, "proj");
    const projKey = projDir.replace(/\\/g, "/").toLowerCase();
    const consultsDir = join(projDir, ".wao", "runs", "consults");
    mkdirSync(consultsDir, { recursive: true });
    const runDir = join(dir, "runs");
    const bucket = makeProjectBucket(runDir, "proj-1a2b3c4d", projKey);
    const projectFact = { kind: "project", rulesVersion: "td190-r3", key: projKey, bucket: "proj-1a2b3c4d" };
    const t = "2026-11-02T08:00:00.000Z";
    writeFileSync(join(consultsDir, "consult_cli.json"), JSON.stringify(record("consult_cli", t, [
      { agentId: "sol", runId: "run_cli1" },
      { agentId: "kimi", runId: "run_cli2" },
    ])));
    // 只有一个结论席位的会审：计 consults 不计 withTwoPlusRatedSeats（阈值钉子）。
    writeFileSync(join(consultsDir, "consult_one.json"), JSON.stringify(record("consult_one", t, [
      { agentId: "sol", runId: "run_cli3" },
      { agentId: "kimi", runId: "run_cli4" },
    ], ["FIX_FIRST", "OK"])));
    writeFileSync(join(bucket, "run_cli3.jsonl"), [
      startedLine("run_cli3", "sol", t),
      replyLine("run_cli3", "sol", t, "Q1: FIX_FIRST"),
    ].join("\n") + "\n");
    writeFileSync(join(bucket, "run_cli4.jsonl"), [
      startedLine("run_cli4", "kimi", t),
      replyLine("run_cli4", "kimi", t, "Q1: OK"),
    ].join("\n") + "\n");
    // 窗外会审（createdAt 11-20 > until 11-08）+ 它的席位运行（ts 在窗内）：
    // 排除集不受时间窗影响，这个席位不得被当成独立会审。
    writeFileSync(join(consultsDir, "consult_out.json"), JSON.stringify(record("consult_out", "2026-11-20T08:00:00.000Z", [
      { agentId: "sol", runId: "run_cli_fx2" },
    ])));
    // 第二个项目：只有通过发现才能读到的另一条会审（钉"位置参数时不做发现"）。
    const projDir2 = join(dir, "proj2");
    const projKey2 = projDir2.replace(/\\/g, "/").toLowerCase();
    mkdirSync(join(projDir2, ".wao", "runs", "consults"), { recursive: true });
    writeFileSync(join(projDir2, ".wao", "runs", "consults", "consult_disc.json"),
      JSON.stringify(record("consult_disc", t, [{ agentId: "opus", runId: "run_cli5" }])));
    const bucket2 = makeProjectBucket(runDir, "proj2-2a2b3c4d", projKey2);
    writeFileSync(join(bucket2, "run_disc.jsonl"),
      startedLine("run_disc", "opus", t, { project: { kind: "project", rulesVersion: "td190-r3", key: projKey2, bucket: "proj2-2a2b3c4d" } }) + "\n");
    writeFileSync(join(bucket, "run_cli1.jsonl"), [
      startedLine("run_cli1", "sol", t, { project: projectFact }),
      replyLine("run_cli1", "sol", t, "Q1: FIX_FIRST"),
    ].join("\n") + "\n");
    writeFileSync(join(bucket, "run_cli2.jsonl"), [
      startedLine("run_cli2", "kimi", t),
      replyLine("run_cli2", "kimi", t, "Q1: PASS"),
    ].join("\n") + "\n");
    writeFileSync(join(bucket, "run_cli_fx1.jsonl"), [
      startedLine("run_cli_fx1", "glm-pro", t, { laneId: "sol", roleId: "auditor" }),
      readOnlyLine("run_cli_fx1", "glm-pro", t),
      replyLine("run_cli_fx1", "glm-pro", t, "PASS"),
    ].join("\n") + "\n");
    writeFileSync(join(bucket, "run_cli_fx2.jsonl"), [
      startedLine("run_cli_fx2", "glm-pro", t, { laneId: "sol", roleId: "auditor" }),
      readOnlyLine("run_cli_fx2", "glm-pro", t),
      replyLine("run_cli_fx2", "glm-pro", t, "PASS"),
    ].join("\n") + "\n");
    const runCli = (args) => {
      const r = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "lane-review-stats-cli.mjs"), ...args], {
        encoding: "utf8",
        timeout: 120000,
      });
      assert.equal(r.status, 0, `CLI 退出码 0（stderr: ${r.stderr}）`);
      return JSON.parse(r.stdout);
    };
    // 无位置参数：做项目发现、收独立会审（defaultConsultDirs 在不同机器贡献的
    // consults 数不定，两个钉住的字段不受影响：真实席位的转录在夹具 runDir 下不存在）。
    const discovered = runCli(["--run-dir", runDir, "--since", "2026-11-01", "--until", "2026-11-08", "--json"]);
    assert.equal(typeof discovered.consults, "number");
    assert.equal(discovered.standaloneReviews, 1, "fx1 计 1；fx2 是窗外会审的席位，排除集不受时间窗影响");
    assert.equal(discovered.withTwoPlusRatedSeats, 1, "夹具会审两席（FIX_FIRST/PASS）计 1");
    // 位置参数目录：只读这些目录，不做发现（projDir2 的 consult_disc 不读）、不收独立会审。
    const positional = runCli(["--run-dir", runDir, "--since", "2026-11-01", "--until", "2026-11-08", "--json", consultsDir]);
    assert.equal(positional.consults, 2, "只读显式目录的两条窗内会审（consult_cli/consult_one）");
    assert.equal(positional.standaloneReviews, 0, "给了目录就不收独立会审");
    assert.equal(positional.withTwoPlusRatedSeats, 1, "单结论席位的会审不计入 2+ 阈值");
  } finally { cleanupDir(dir); }
});

test("CLI：无盘符 project.key 指向当前盘真实目录也不收", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lrs-nodrive-"));
  try {
    const t = "2026-11-02T08:00:00.000Z";
    const runDir = join(dir, "runs");
    // 好项目：带盘符的 key。
    const goodProj = join(dir, "good");
    const goodKey = goodProj.replace(/\\/g, "/").toLowerCase();
    mkdirSync(join(goodProj, ".wao", "runs", "consults"), { recursive: true });
    writeFileSync(join(goodProj, ".wao", "runs", "consults", "consult_g.json"),
      JSON.stringify(record("consult_g", t, [{ agentId: "zz-good-probe", runId: "run_ng1" }])));
    const goodBucket = makeProjectBucket(runDir, "good-1a2b3c4d", goodKey);
    writeFileSync(join(goodBucket, "run_ok.jsonl"),
      startedLine("run_ok", "sol", t, { project: { kind: "project", rulesVersion: "td190-r3", key: goodKey, bucket: "good-1a2b3c4d" } }) + "\n");
    // 坏项目：key 去掉盘符（\\… 形态），但指向的 consults 目录真实存在——子进程
    // cwd 设在夹具根，无盘符路径按当前盘解析确实能找到；盘符门槛必须把它挡下。
    const ndProj = join(dir, "nodrive");
    mkdirSync(join(ndProj, ".wao", "runs", "consults"), { recursive: true });
    writeFileSync(join(ndProj, ".wao", "runs", "consults", "consult_nd.json"),
      JSON.stringify(record("consult_nd", t, [{ agentId: "zz-nodrive-probe", runId: "run_ng2" }])));
    const ndBucket = makeProjectBucket(runDir, "nodrive-00000000", "whatever");
    const ndKey = ndProj.replace(/^[A-Za-z]:/, ""); // 去盘符，保留反斜杠
    writeFileSync(join(ndBucket, "run_nd.jsonl"),
      startedLine("run_nd", "kimi", t, { project: { kind: "project", rulesVersion: "td190-r3", key: ndKey, bucket: "nodrive-00000000" } }) + "\n");
    const r = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "lane-review-stats-cli.mjs"),
      "--run-dir", runDir, "--since", "2026-11-01", "--until", "2026-11-08", "--json"], {
      cwd: dir, // 当前盘 = 夹具所在盘：\\… 无盘符路径在此盘上真实存在
      encoding: "utf8",
      timeout: 120000,
    });
    assert.equal(r.status, 0, `CLI 退出码 0（stderr: ${r.stderr}）`);
    const parsed = JSON.parse(r.stdout);
    // 探针车道名不会与真实数据撞名：本机/主检出的默认目录贡献多少条都不影响断言。
    assert.equal(parsed.lanes["zz-good-probe"]?.seats, 1, "好项目经发现被收集");
    assert.equal(parsed.lanes["zz-nodrive-probe"], undefined, "无盘符 key 的项目不收");
  } finally { cleanupDir(dir); }
});

test("defaultConsultDirs：本检出、各开发工作树与归档目录，只列存在的", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lrs-dirs-"));
  try {
    mkdirSync(join(dir, ".wao", "runs", "consults"), { recursive: true });
    mkdirSync(join(dir, ".dev", "wt", "batch1", ".wao", "runs", "consults"), { recursive: true });
    mkdirSync(join(dir, ".dev", "wt", "batch2"), { recursive: true });
    mkdirSync(join(dir, "runs-archive", "2026-10", "consult-records-dev-worktrees", "batch0"), { recursive: true });
    assert.deepEqual(defaultConsultDirs(dir), [
      join(dir, ".wao", "runs", "consults"),
      join(dir, ".dev", "wt", "batch1", ".wao", "runs", "consults"),
      join(dir, "runs-archive", "2026-10", "consult-records-dev-worktrees", "batch0"),
    ]);
  } finally { cleanupDir(dir); }
});
