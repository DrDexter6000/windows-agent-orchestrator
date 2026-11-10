// test/run-lifecycle/consult.test.js
//
// M13-r1（决定 0039 契约 v0.2）：Agent Union consult（多席只读会审）服务 + CLI。
//
// 钉住的三条不变式（0039 §2.2"进机器守卫"，逐条对应）：
//   INV-1 零信息损失 —— attributeReply 三块（preamble+ordered+unclassified）
//          按序拼接逐字节等于原文（多形状夹具：全结构化/半结构化/纯散文/空/超长/重复Qn）。
//   INV-2 标记即提示 —— fieldDiff 只在闭集值不同且非未填时出现；
//          输出永不携带"一致/分歧/agree/disagree"结论词；比对不改动输入内容。
//   INV-3 malformed 零自动重发 —— unstructured 席位收集后 dispatch 桩调用数不变。
//
// 其余钉住面：两维状态独立（completed+unstructured 合法）、runState 取
// transcript 真值（超时不改写为失败）、部分成功降级视图、组记录落
// consultsDir（绝不写 runs/）、导入纪律（不 import delivery/decide/mcp 面）、
// CLI text/json 两渲染形状（未归类区在场、runId 清单在场）、consult show 重渲染。
//
// 纯 DI 桩测试：不真实派发（dispatchFn/readTranscriptFn 全注入）。
//
// r1.1 必改修正（拒收两条的回归钉）：
//   ① 厂族砖只做 registry 原始字段直读（backend/provider），不做族系归类
//      判断——R9（决定 0023）modelFamily 是展示闭集模块，控制面路径不得
//      import（STRUCT-2 + BRICK-1/2 + CLI 渲染断言钉住）。
//   ② 测试不得构造仓库相对 runs/ 的 run-dir/cwd——R23-D 纪律 +
//      staticRunsGuard 机械规则：service 层全 DI 内存桩（不触盘），真实
//      文件面一律 mkdtempSync(tmpdir) + 显式 --run-dir/--cwd 注入。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, resolve } from "node:path";

import {
  parseBriefQuestions,
  attributeReply,
  compareFields,
  deriveSeatStates,
  seatRuntimeFacts,
  runConsult,
  waitForConsult,
  rerenderConsultFromRecord,
  loadConsultRecord,
  loadConsultRecordWithFallback,
  generateConsultId,
  isValidConsultId,
} from "../../src/application/consultService.js";
// 决定 0096：CLI consult 的 nextStep 模板（480 上限与超长回退在这里钉住）。
import { buildNextStep } from "../../src/application/runNextStep.js";

test("会审还在等待预算之内被读取时，没到终态的席位不标预算到期；预算过了才标", async () => {
  const record = {
    consultId: "consult_20261013000000000within",
    createdAt: "2026-10-13T00:00:00.000Z",
    budgetMs: 600000,
    questions: [{ q: 1, heading: "Q1" }],
    seats: [
      { agentId: "seat_a", runId: "run_stub_seat_a", runState: "pending", formatState: "empty" },
      { agentId: "seat_b", runId: "run_stub_seat_b", runState: "pending", formatState: "empty" },
    ],
    fieldDiff: [],
  };
  const { readTranscriptFn } = makeTranscriptStub(new Map([
    ["run_stub_seat_a", makeTranscript("run_stub_seat_a", { state: "running" })],
    ["run_stub_seat_b", makeTranscript("run_stub_seat_b", { state: "completed", finalText: "Q1: OK\n" })],
  ]));
  const created = Date.parse(record.createdAt);
  // 转录读取是桩，这两个目录不会被真的读写；仍用临时目录下的绝对路径，不指向仓库。
  const base = join(tmpdir(), "wao-consult-within-budget");
  const dirs = { runDir: join(base, "r"), consultsDir: join(base, "c") };
  const flags = async (nowFn) => {
    const result = await rerenderConsultFromRecord({ record, ...dirs, readTranscriptFn, env: {}, nowFn });
    return Object.fromEntries(result.seats.map((seat) => [seat.agentId, seat.budgetExpired]));
  };
  assert.deepEqual(await flags(() => created + 60000), { seat_a: false, seat_b: false });
  assert.deepEqual(await flags(() => created + 600001), { seat_a: true, seat_b: false });
  // 旧记录没有 createdAt / budgetMs：按已到期处理。
  const legacy = await rerenderConsultFromRecord({
    record: { ...record, createdAt: undefined, budgetMs: undefined }, ...dirs, readTranscriptFn, env: {},
  });
  assert.equal(legacy.seats.find((seat) => seat.agentId === "seat_a").budgetExpired, true);
});
import { consultCommand, renderCouncilDiffText } from "../../src/commands/consult.js";

// ===== Helpers =====

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** 零信息损失断言：preamble + ordered + unclassified 拼接 === 原文（逐字节）。 */
function assertLossless(replyText, label) {
  const a = attributeReply(replyText);
  const rebuilt = a.preamble + a.ordered.map((e) => e.text).join("") + a.unclassified;
  assert.equal(rebuilt, replyText, `INV-1 ${label}: 三块拼接必须逐字节等于原文`);
  return a;
}

function attrOf(text) {
  return attributeReply(text);
}

/** transcript 事件桩：只读权威（run.started 带 worktreePath）+ 绑定声明 +
 *  state_change + assistant 终稿。决定 0055 的写入证据走真实事件形状
 *  （type:"run.event"、kind:"file_written"，路径按只读观察投影的纯词法派生）。 */
function makeTranscript(runId, { state = "completed", finalText = "", fileWrittenCount = 0, tmpWrittenCount = 0 } = {}) {
  let seq = 0;
  const nextSeq = () => { seq += 1; return seq; };
  const events = [
    { type: "run.started", worktreePath: "C:\\fake\\wt", runId, seq: nextSeq() },
    { type: "run.read_only_declared", runId, seq: nextSeq() },
    { type: "run.state_change", to: state, reason: "stub", runId, seq: nextSeq() },
  ];
  if (finalText.length > 0) {
    events.push({ type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: finalText }], runId, seq: nextSeq() });
  }
  // 工作树内写入 → 违规证据（投影派生相对路径后计数）。
  for (let i = 0; i < fileWrittenCount; i += 1) {
    events.push({ type: "run.event", kind: "file_written", path: `C:\\fake\\wt\\f${i}.txt`, runId, seq: nextSeq() });
  }
  // 系统临时目录里的实验写入 → 不算违规（投影只认工作树内派生路径）。
  for (let i = 0; i < tmpWrittenCount; i += 1) {
    events.push({ type: "run.event", kind: "file_written", path: `C:\\wao-tmp\\exp\\f${i}.txt`, runId, seq: nextSeq() });
  }
  return events;
}

/**
 * registry 读取桩——必须是**函数形**（与 readRegistry(path) 同参返形状：
 * 接收路径、返回带 getAgent 的 registry 对象）。r1 曾把 registry 对象本身
 * 当读取函数传入，service 的 try/catch 静默降级 null 而 r1 无断言揭穿；
 * BRICK-1 的原始字段断言钉住这一形状。
 * 席位形状覆盖：seat_a 走 providerID 形（deepseek-acp 的 model.providerID）、
 * seat_b 走裸 backend 形（无路由字段）。
 */
function stubRegistryRead() {
  return async () => ({
    getAgent: (id) => (id === "seat_b"
      ? { backend: "codex", cwd: ".", model: { id: `model-${id}` } }
      : {
        backend: "deepseek-acp",
        cwd: ".",
        model: { id: `model-${id}`, providerID: "deepseek-official" },
      }),
  });
}

function makeDispatchStub() {
  const calls = [];
  const dispatchFn = async (input) => {
    calls.push(input);
    return { accepted: true, runId: `run_stub_${input.agentId}`, state: "pending" };
  };
  return { dispatchFn, calls };
}

function makeTranscriptStub(transcripts) {
  const reads = [];
  const readTranscriptFn = async (path) => {
    const runId = basename(path, ".jsonl");
    reads.push(runId);
    const events = transcripts.get(runId);
    if (!events) throw new Error(`ENOENT stub: ${path}`);
    return events;
  };
  return { readTranscriptFn, reads };
}

/** 可推进假时钟：sleepFn 每睡 ms 推进 now——永不终态的席位靠它耗尽预算退出循环。 */
function makeFakeClock(start = 0) {
  let now = start;
  return { nowFn: () => now, sleepFn: async (ms) => { now += ms; } };
}

/** 组装一次最小 runConsult 输入（全桩，无真实派发）。 */
function baseInput(overrides = {}) {
  const clock = makeFakeClock();
  // R23-D/staticRunsGuard 纪律（r1.1 必改②）：run-dir 一律 tmpdir 锚定的惰性
  // 路径——IO 全注入，路径只透传给桩，绝不解析进仓库相对 runs/。
  const stubRoot = join(tmpdir(), "wao-consult-stub");
  return {
    briefText: "会审任务书\n\n## Q1 方案可行吗\n\nQ2: 首选哪个\n",
    seats: [{ agentId: "seat_a" }, { agentId: "seat_b" }],
    registryPath: join(stubRoot, "registry.json"),
    runDir: join(stubRoot, "runs"),
    consultsDir: join(stubRoot, "consults"),
    budgetMs: 600000,
    pollIntervalMs: 1000,
    env: {},
    nowFn: clock.nowFn,
    sleepFn: clock.sleepFn,
    registryReadFn: stubRegistryRead(),
    ...overrides,
  };
}

/** 真实转录文件（waitForConsult / consult show 走真实 resolveTranscriptPath + readTranscript）。 */
function writeRealTranscript(runDir, runId, events) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, `${runId}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

/** 真实组记录文件（loadConsultRecord 经真实 readFile 读取）。 */
function writeConsultRecord(consultsDir, record) {
  mkdirSync(consultsDir, { recursive: true });
  writeFileSync(join(consultsDir, `${record.consultId}.json`), JSON.stringify(record), "utf8");
}

// ===== INV-1：零信息损失 =====

test("INV-1a: attributeReply 三块拼接逐字节等于原文（全结构化）", () => {
  const text = "Q1: 采纳 A\n理由是成本低。\n\nQ2: 选 B\n风险可控。\n";
  const a = assertLossless(text, "全结构化");
  assert.equal(a.ordered.length, 2);
  assert.equal(a.ordered[0].q, 1);
  assert.equal(a.ordered[1].q, 2);
  assert.equal(a.preamble, "");
  assert.equal(a.unclassified, "");
});

test("INV-1b: 半结构化（开场散文 + 埋问散文）零损失，未匹配内容整段兜底", () => {
  const text = "总体我认为方向对，但预算存疑。\n\nQ1: A 可行\n\n综上，Q2 我倾向 B，因为人力更省。\n";
  const a = assertLossless(text, "半结构化");
  // 开场散文（首锚点前）进 preamble；"综上…" 段并入 Q1 块（到下一锚点；无句子级切分）。
  assert.equal(a.preamble, "总体我认为方向对，但预算存疑。\n\n");
  assert.equal(a.ordered.length, 1);
  assert.ok(a.ordered[0].text.includes("综上，Q2 我倾向 B"), "埋问散文按整段兜底，不做句子级切分");
});

test("INV-1c: 纯散文回复全文进 unclassified（整段），零损失", () => {
  const text = "我认为方案 A 更好。\n理由一：成本低。\n理由二：周期短。\n";
  const a = assertLossless(text, "纯散文");
  assert.equal(a.ordered.length, 0);
  assert.equal(a.unclassified, text);
  assert.equal(a.preamble, "");
});

test("INV-1d: 空回复三块皆空，零损失", () => {
  const a = assertLossless("", "空回复");
  assert.deepEqual(a, { ordered: [], unclassified: "", preamble: "" });
});

test("INV-1e: 超长回复（>12000 字符，跨 collect 分页上限形状）零损失", () => {
  const longBody = "x".repeat(9000);
  const text = `Q1: ${longBody}\n\nQ2: ${"y".repeat(9000)}\n`;
  const a = assertLossless(text, "超长");
  assert.equal(a.ordered.length, 2);
  assert.ok(a.ordered[0].text.length > 8000, "长段不截断");
});

test("INV-1f: 同一 Qn 重复出现产生多条有序条目（不合并、不重排），零损失", () => {
  const text = "Q1: 第一答\nQ2: 插答\nQ1: 补充第一答\n";
  const a = assertLossless(text, "重复Qn");
  assert.deepEqual(a.ordered.map((e) => e.q), [1, 2, 1]);
});

test("INV-1g: 行首加粗的结论行也是锚点（**Q1：…** / **Q1**：…），零损失、取值照常", () => {
  for (const text of ["**Q1：FIX_FIRST**\n理由", "**Q1**：FIX_FIRST\n理由"]) {
    const a = assertLossless(text, `加粗锚点 ${text.slice(0, 8)}`);
    assert.deepEqual(a.ordered.map((e) => e.q), [1], `${JSON.stringify(text)} 是 Q1 锚点`);
    const { fieldValues } = compareFields({ s: a }, { Q1: ["PASS", "FIX_FIRST"] });
    assert.equal(fieldValues.Q1.s, "FIX_FIRST");
  }
  // 不放宽成模糊匹配：句中加粗、列表前缀、没有冒号的加粗、下划线加粗都不是锚点
  // （下划线是单词字符，__ 包住的结论取不到值）。
  for (const text of ["结论 **Q1：FIX_FIRST**", "1. **Q1：FIX_FIRST**", "**Q1 方案**", "__Q1: FIX_FIRST__"]) {
    assert.equal(attributeReply(text).ordered.length, 0, `${JSON.stringify(text)} 不是锚点`);
  }
});

// ===== INV-2：标记即提示 =====

test("INV-2a: 闭集值不同 → fieldDiff 恰含该 Qn；同值/未填不标", () => {
  const perSeat = {
    seat_a: attrOf("Q1: 采纳 A\n"),
    seat_b: attrOf("Q1: 采纳 B\n"),
    seat_c: attrOf("Q1: 采纳 A\n"),
  };
  const r = compareFields(perSeat, { Q1: ["A", "B"] });
  assert.deepEqual(r.fieldDiff, ["Q1"]);
  assert.equal(r.fieldValues.Q1.seat_a, "A");
  assert.equal(r.fieldValues.Q1.seat_b, "B");
  assert.equal(r.fieldValues.Q1.seat_c, "A");
});

test("INV-2b: 全同值 → 无 fieldDiff；仅一席有值（其余未填）→ 无 fieldDiff", () => {
  const same = compareFields(
    { a: attrOf("Q1: A\n"), b: attrOf("Q1: A\n") },
    { Q1: ["A", "B"] },
  );
  assert.deepEqual(same.fieldDiff, []);
  const oneFilled = compareFields(
    { a: attrOf("Q1: A\n"), b: attrOf("Q1: 未定\n") },
    { Q1: ["A", "B"] },
  );
  assert.deepEqual(oneFilled.fieldDiff, [], "仅一席有值时无可比对象——不标");
  assert.equal(oneFilled.fieldValues.Q1.b, null, "缺席 = 未填(null)");
});

test("INV-2c: 字面匹配大小写敏感、不猜（小写 a 不命中声明 A）", () => {
  const r = compareFields(
    { a: attrOf("Q1: value a\n"), b: attrOf("Q1: value A\n") },
    { Q1: ["A"] },
  );
  assert.equal(r.fieldValues.Q1.a, null, "大小写敏感：小写 a ≠ A → 未填");
  assert.equal(r.fieldValues.Q1.b, "A");
  assert.deepEqual(r.fieldDiff, [], "一席未填一席有值 → 不标");
});

test("INV-2d: 输出永不携带结论词；比对零改动输入内容（标记前后内容集合相等）", () => {
  const before = {
    seat_a: attrOf("Q1: 采纳 A\n理由甲。\n"),
    seat_b: attrOf("Q1: 采纳 B\n理由乙。\n"),
  };
  const beforeSnapshot = JSON.parse(JSON.stringify(before));
  const r = compareFields(before, { Q1: ["A", "B"] });
  const serialized = JSON.stringify(r);
  for (const forbidden of ["一致", "分歧", "agree", "disagree", "consensus"]) {
    assert.ok(!serialized.includes(forbidden), `compareFields 输出不得含结论词：${forbidden}`);
  }
  assert.deepEqual(before, beforeSnapshot, "比对不得改动归组内容");
  // 标记只是提示：有/无 declaredFields 两个世界里的归组文本完全相同。
  assert.deepEqual(before.seat_a.ordered[0].text, "Q1: 采纳 A\n理由甲。\n");
});

test("INV-2e: 声明值按整词匹配——MERGE 不误领 MERGE_AFTER_FIXES 前缀；PASS 不命中 PASSED；中文标点紧邻算边界；长词先出现不遮蔽后文整词", () => {
  // 声明 ["MERGE","MERGE_AFTER_FIXES","REJECT"]、正文写 MERGE_AFTER_FIXES：
  // 取值必须是 MERGE_AFTER_FIXES（整词命中），两席同值 → fieldDiff 不含 Q1。
  const both = compareFields(
    {
      seat_a: attrOf("Q1: MERGE_AFTER_FIXES\n理由甲。\n"),
      seat_b: attrOf("Q1: MERGE_AFTER_FIXES\n理由乙。\n"),
    },
    { Q1: ["MERGE", "MERGE_AFTER_FIXES", "REJECT"] },
  );
  assert.equal(both.fieldValues.Q1.seat_a, "MERGE_AFTER_FIXES");
  assert.equal(both.fieldValues.Q1.seat_b, "MERGE_AFTER_FIXES");
  assert.deepEqual(both.fieldDiff, [], "两席同值 → 不标");
  // 后缀也是词边界违例：声明 PASS 不命中 PASSED。
  const pass = compareFields({ a: attrOf("Q1: PASSED\n") }, { Q1: ["PASS"] });
  assert.equal(pass.fieldValues.Q1.a, null);
  // 中文标点紧邻（"："与"。"）都是词边界——Q1：PASS。 取到 PASS。
  const cn = compareFields({ a: attrOf("Q1：PASS。\n") }, { Q1: ["PASS"] });
  assert.equal(cn.fieldValues.Q1.a, "PASS");
  // 声明值先作为更长单词的一部分出现（非整词）、之后才作为整词出现 → 仍取得到。
  const later = compareFields(
    { a: attrOf("Q1: 首先排除 MERGE_AFTER_FIXES，最终建议 MERGE。\n") },
    { Q1: ["MERGE"] },
  );
  assert.equal(later.fieldValues.Q1.a, "MERGE");
});

// ===== INV-3：malformed 零自动重发 =====

test("INV-3: unstructured 席位收集后 dispatch 桩调用数不变（零自动重发）", async () => {
  const { dispatchFn, calls } = makeDispatchStub();
  const { readTranscriptFn } = makeTranscriptStub(new Map([
    ["run_stub_seat_a", makeTranscript("run_stub_seat_a", { finalText: "Q1: A\nQ2: B\n" })],
    // seat_b 回复纯散文（malformed/unstructured）——0039：不惩罚、零重发。
    ["run_stub_seat_b", makeTranscript("run_stub_seat_b", { finalText: "我整体觉得方案不错，就这样。\n" })],
  ]));
  const result = await runConsult(baseInput({
    dispatchFn,
    readTranscriptFn,
    writeFileFn: async () => {},
    mkdirFn: async () => {},
  }));
  assert.equal(calls.length, 2, "每席恰一次派发");
  assert.equal(result.seats.find((s) => s.agentId === "seat_b").formatState, "unstructured");
  // 收集完成后再断言一次：调用数仍然 2（收集阶段没有补发）。
  assert.equal(calls.length, 2);
  assert.equal(calls.every((c) => c.readOnly === true), true, "全部派发均为 readOnly");
});

// ===== 导入纪律（不 import delivery/decide/mcp 面）=====

test("STRUCT-1: consultService 不 import runDelivery/delivery/mcp/commands 写面", () => {
  const source = readFileSync(join(import.meta.dirname, "../../src/application/consultService.js"), "utf8");
  const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(specifiers.length > 0, "应解析到 import 语句");
  const forbidden = /runDelivery|delivery\.js$|\/mcp\/|commands\/|@modelcontextprotocol|\bzod\b|decide/i;
  for (const spec of specifiers) {
    assert.ok(
      !forbidden.test(spec),
      `consultService 不得 import delivery/decide/mcp 写面：${spec}`,
    );
  }
});

test("STRUCT-2: consultService 不 import modelFamily（R9 展示闭集——控制面路径铁律，r1.1 必改①）", () => {
  const source = readFileSync(join(import.meta.dirname, "../../src/application/consultService.js"), "utf8");
  const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(
    specifiers.every((spec) => !/modelFamily\.js$/.test(spec)),
    "厂族砖只做 registry 原始字段直读（backend/provider）；族系归类是展示闭集能力，dispatch/delivery 控制面不得消费（R9/决定 0023）",
  );
});

// ===== 两维状态独立 + runState 真值 =====

test("STATE-1: completed + unstructured 合法（两维独立）；runState 取 transcript 真值", async () => {
  const { dispatchFn } = makeDispatchStub();
  const { readTranscriptFn } = makeTranscriptStub(new Map([
    ["run_stub_seat_a", makeTranscript("run_stub_seat_a", { state: "completed", finalText: "整体可行，就这么办。\n" })],
    ["run_stub_seat_b", makeTranscript("run_stub_seat_b", { state: "failed", finalText: "Q1: A\n" })],
  ]));
  const result = await runConsult(baseInput({
    dispatchFn,
    readTranscriptFn,
    writeFileFn: async () => {},
    mkdirFn: async () => {},
  }));
  const a = result.seats.find((s) => s.agentId === "seat_a");
  assert.equal(a.runState, "completed");
  assert.equal(a.formatState, "unstructured", "completed+unstructured 合法");
  const b = result.seats.find((s) => s.agentId === "seat_b");
  assert.equal(b.runState, "failed", "runState 来自 transcript 真值（failed 是事实，不是格式判断）");
  assert.equal(b.formatState, "partial");
});

test("STATE-2: deriveSeatStates 纯函数——超时/缺席的 runState 原样透传，不改写为失败", () => {
  const questions = parseBriefQuestions("## Q1 甲\nQ2: 乙\n");
  const running = deriveSeatStates({ runState: "running", questions, attribution: attrOf("Q1: A\n") });
  assert.deepEqual(running, { runState: "running", formatState: "partial" });
  const missing = deriveSeatStates({ runState: "missing", questions, attribution: attrOf("") });
  assert.equal(missing.runState, "missing", "缺席不改写为 failed");
  assert.equal(missing.formatState, "empty");
  const structured = deriveSeatStates({
    runState: "completed",
    questions,
    attribution: attrOf("Q1: A\n\nQ2: B\n"),
  });
  assert.equal(structured.formatState, "structured");
});

// ===== 部分成功降级视图 + 组记录 =====

test("FLOW-1: 两席成功一席预算到期 → 降级视图可出；到期席保持 running 观察事实", async () => {
  let now = 0;
  const { dispatchFn } = makeDispatchStub();
  const { readTranscriptFn } = makeTranscriptStub(new Map([
    ["run_stub_seat_a", makeTranscript("run_stub_seat_a", { finalText: "Q1: A\nQ2: B\n" })],
    ["run_stub_seat_b", makeTranscript("run_stub_seat_b", { finalText: "Q1: A\nQ2: B\n" })],
    ["run_stub_seat_c", makeTranscript("run_stub_seat_c", { state: "running", finalText: "Q1: 还在想\n" })],
  ]));
  const result = await runConsult(baseInput({
    seats: [{ agentId: "seat_a" }, { agentId: "seat_b" }, { agentId: "seat_c" }],
    dispatchFn,
    readTranscriptFn,
    nowFn: () => now,
    sleepFn: async (ms) => { now += ms; },
    pollIntervalMs: 600000,
    writeFileFn: async () => {},
    mkdirFn: async () => {},
  }));
  const c = result.seats.find((s) => s.agentId === "seat_c");
  assert.equal(c.runState, "running", "预算到期不改写状态——保持 transcript 真值");
  assert.equal(c.budgetExpired, true);
  assert.equal(result.seats.filter((s) => s.runState === "completed").length, 2);
  // 降级视图照常组装（render 不 throw）。
  assert.ok(renderCouncilDiffText(result).includes("runId 回链"));
});

test("FLOW-2: 派发失败与缺席席位不阻断其余席位；状态如实记录", async () => {
  const { dispatchFn, calls } = makeDispatchStub();
  // seat_b 派发即拒（凭证缺失形状）。
  const dispatchFnPartial = async (input) => {
    if (input.agentId === "seat_b") throw new Error("credential missing: X_KEY");
    return dispatchFn(input);
  };
  // seat_c 的 transcript 全程不可读（缺席）。
  const { readTranscriptFn } = makeTranscriptStub(new Map([
    ["run_stub_seat_a", makeTranscript("run_stub_seat_a", { finalText: "Q1: A\n" })],
  ]));
  const result = await runConsult(baseInput({
    seats: [{ agentId: "seat_a" }, { agentId: "seat_b" }, { agentId: "seat_c" }],
    dispatchFn: dispatchFnPartial,
    readTranscriptFn,
    writeFileFn: async () => {},
    mkdirFn: async () => {},
  }));
  const b = result.seats.find((s) => s.agentId === "seat_b");
  assert.equal(b.runState, "dispatch_failed");
  assert.equal(b.runId, null);
  const c = result.seats.find((s) => s.agentId === "seat_c");
  assert.equal(c.runState, "missing");
  assert.equal(result.seats.find((s) => s.agentId === "seat_a").runState, "completed");
  assert.ok(calls.length >= 1);
});

test("FLOW-3: 组记录落 consultsDir 单 JSON（席位-runId 映射 + fieldDiff），绝不写 runs/", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-consult-flow3-"));
  try {
    const consultsDir = join(dir, "consults");
    const runDir = join(dir, "runs");
    const writePaths = [];
    const { dispatchFn } = makeDispatchStub();
    const { readTranscriptFn } = makeTranscriptStub(new Map([
      ["run_stub_seat_a", makeTranscript("run_stub_seat_a", { finalText: "Q1: A\nQ2: B\n" })],
      ["run_stub_seat_b", makeTranscript("run_stub_seat_b", { finalText: "Q1: B\nQ2: B\n" })],
    ]));
    const fixedId = "consult_20261002120000000abc123";
    const result = await runConsult(baseInput({
      briefPath: join(dir, "brief.md"),
      dispatchFn,
      readTranscriptFn,
      consultsDir,
      declaredFields: { Q1: ["A", "B"] },
      idFn: () => fixedId,
      writeFileFn: async (p, data) => { writePaths.push(p); mkdirSync(consultsDir, { recursive: true }); writeFileSync(p, data, "utf8"); },
      mkdirFn: async () => {},
    }));
    // 组记录写两次、同一个文件：扇出后先落席位-runId 映射，收集结束再覆盖成完整观察。
    assert.equal(writePaths.length, 2);
    // 第二次不就地覆盖：写同目录的临时文件，再改名换上去（读者不会读到半截内容）。
    assert.ok(writePaths[1].startsWith(`${writePaths[0]}.`) && writePaths[1].endsWith(".tmp"),
      "收尾写的是记录旁边的临时文件");
    assert.deepEqual(readdirSync(consultsDir), [`${fixedId}.json`], "改名之后目录里只剩记录本身");
    assert.equal(basename(writePaths[0]), `${fixedId}.json`);
    assert.ok(writePaths[0].startsWith(consultsDir), "组记录只写 consultsDir");
    assert.ok(!writePaths[0].startsWith(runDir), "组记录绝不写 runs/（防 metrics 双计）");
    const record = JSON.parse(readFileSync(writePaths[0], "utf8"));
    assert.equal(record.consultId, fixedId);
    assert.ok(record.createdAt);
    assert.ok(record.brief.sha256.length === 64);
    assert.equal(record.budgetMs, 600000);
    assert.deepEqual(record.fieldDiff, ["Q1"]);
    const mapping = Object.fromEntries(record.seats.map((s) => [s.agentId, s.runId]));
    assert.equal(mapping.seat_a, "run_stub_seat_a");
    assert.equal(mapping.seat_b, "run_stub_seat_b");
    assert.deepEqual(record.questions.map((q) => q.q), [1, 2]);
    assert.deepEqual(record.declaredFields, { Q1: ["A", "B"] });
    // 组记录不携带回复正文（正文 SSOT 在 run transcript，经 runId 回链）。
    assert.ok(record.seats.every((s) => !("finalText" in s) && !("attribution" in s)));
    assert.equal(result.recordPath, writePaths[0]);
  } finally {
    cleanupDir(dir);
  }
});

test("FLOW-4: 视角片段原样拼接在该席 prompt 尾部（共享内核=brief 逐字节；席位级固定合同始终追加）", async () => {
  const briefText = "共享任务书\n\n## Q1 可行吗\n";
  const perspective = "你是成本视角：先自测预算是否闭合。\n";
  const { dispatchFn, calls } = makeDispatchStub();
  const { readTranscriptFn } = makeTranscriptStub(new Map([
    ["run_stub_seat_a", makeTranscript("run_stub_seat_a", { finalText: "Q1: 可行\n" })],
    ["run_stub_seat_b", makeTranscript("run_stub_seat_b", { finalText: "Q1: 可行\n" })],
  ]));
  await runConsult(baseInput({
    briefText,
    seats: [{ agentId: "seat_a" }, { agentId: "seat_b", perspectiveText: perspective }],
    dispatchFn,
    readTranscriptFn,
    writeFileFn: async () => {},
    mkdirFn: async () => {},
  }));
  // kimi 诊断会审（2026-10-10）：裸车道席位此前收不到 WQ-03——固定会审合同
  // 始终追加（不依赖角色装配）；brief/视角仍逐字节保留在合同段之前。
  // 2026-11-03：文件边界收进控制面只读执行合同（task.roleContract）——席位
  // 边界不再重复"创建或修改文件"。
  const CONTRACT_MARK = "---\n【会审席边界（固定合同，席位级）】";
  for (const c of calls) {
    assert.ok(c.prompt.includes(CONTRACT_MARK), "每席 prompt 都带固定会审合同");
    assert.equal(c.prompt.indexOf(CONTRACT_MARK), c.prompt.lastIndexOf(CONTRACT_MARK), "合同恰一次");
    assert.ok(c.prompt.startsWith(briefText), "brief 逐字节内核在前");
    assert.ok(!c.prompt.includes("创建或修改文件"), "文件边界由只读合同管，席位边界不再重复");
  }
  assert.ok(calls[0].prompt.endsWith("缺证据时报告缺口。"), "无视角席：合同在尾部");
  assert.ok(calls[1].prompt.includes(`\n\n${perspective}\n\n${CONTRACT_MARK}`), "视角片段原样拼接在 brief 与合同之间");
});

test("FLOW-5: 非作者砖——被审 run 作者 ∈ 席位清单 → authorInSeats=true（advisory）", async () => {
  const { dispatchFn } = makeDispatchStub();
  const { readTranscriptFn } = makeTranscriptStub(new Map([
    ["run_stub_seat_a", makeTranscript("run_stub_seat_a", { finalText: "Q1: A\n" })],
    ["run_stub_seat_b", makeTranscript("run_stub_seat_b", { finalText: "Q1: A\n" })],
    ["run_reviewed_1", [
      { type: "run.background_submitted", background: true, agentId: "seat_a", runId: "run_reviewed_1", seq: 1 },
      { type: "run.started", agentId: "seat_a", runId: "run_reviewed_1", seq: 2 },
    ]],
  ]));
  const result = await runConsult(baseInput({
    dispatchFn,
    readTranscriptFn,
    reviewedRunId: "run_reviewed_1",
    writeFileFn: async () => {},
    mkdirFn: async () => {},
  }));
  assert.equal(result.bricks.authorInSeats, true);
  assert.equal(result.bricks.reviewedAgentId, "seat_a");
  assert.equal(result.bricks.sessionIndependence, "未提供", "会话独立性 r1 如实未提供，不伪造");
  assert.equal(result.record.reviewedRunId, "run_reviewed_1");
});

test("FLOW-6: budgetMs 范围校验（同 run_wait 域），越界拒绝", async () => {
  await assert.rejects(
    () => runConsult(baseInput({ budgetMs: 179999, writeFileFn: async () => {}, mkdirFn: async () => {} })),
    /budgetMs must be an integer/,
  );
  await assert.rejects(
    () => runConsult(baseInput({ budgetMs: 600001, writeFileFn: async () => {}, mkdirFn: async () => {} })),
    /budgetMs must be an integer/,
  );
});

test("FLOW-7: 扇出后立刻落组记录并回调 onFanOut——回调时记录已在盘上（pending/dispatch_failed 映射），收集后同路径覆盖为完整观察", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-consult-fanout-"));
  try {
    const consultsDir = join(dir, "consults");
    const runDir = join(dir, "runs");
    const { dispatchFn } = makeDispatchStub();
    const dispatchFnPartial = async (input) => {
      if (input.agentId === "seat_b") throw new Error("credential missing: X_KEY");
      return dispatchFn(input);
    };
    const { readTranscriptFn } = makeTranscriptStub(new Map([
      ["run_stub_seat_a", makeTranscript("run_stub_seat_a", { finalText: "Q1: A\n" })],
    ]));
    const fixedId = "consult_20261002120000000abc123";
    const fanOutCalls = [];
    let earlyRecord = null;
    const result = await runConsult(baseInput({
      runDir,
      consultsDir,
      dispatchFn: dispatchFnPartial,
      readTranscriptFn,
      idFn: () => fixedId,
      onFanOut: (info) => {
        fanOutCalls.push(info);
        // 回调发生时组记录文件已经在盘上（早期记录：席位-runId 映射 + 扇出时刻观察）。
        earlyRecord = JSON.parse(readFileSync(info.recordPath, "utf8"));
      },
    }));
    assert.equal(fanOutCalls.length, 1, "onFanOut 恰被调用一次");
    const info = fanOutCalls[0];
    assert.equal(info.consultId, fixedId);
    assert.equal(info.recordPath, join(consultsDir, `${fixedId}.json`));
    // 第 96 批：派发未成立席位的回调席位对象带加工后的原因（有 runId 的不带）。
    assert.deepEqual(info.seats, [
      { agentId: "seat_a", runId: "run_stub_seat_a" },
      { agentId: "seat_b", runId: null, dispatchError: "credential missing: X_KEY" },
    ]);
    // 早期记录：席位到 runId 的映射在场；成功席 pending、派发失败席 dispatch_failed + runId null + 原因。
    const earlyMapping = Object.fromEntries(earlyRecord.seats.map((s) => [s.agentId, s.runId]));
    assert.equal(earlyMapping.seat_a, "run_stub_seat_a");
    assert.equal(earlyMapping.seat_b, null);
    assert.equal(earlyRecord.seats.find((s) => s.agentId === "seat_a").runState, "pending");
    const earlyB = earlyRecord.seats.find((s) => s.agentId === "seat_b");
    assert.equal(earlyB.runState, "dispatch_failed");
    assert.equal(earlyB.runId, null);
    assert.equal(earlyB.dispatchError, "credential missing: X_KEY", "扇出时的记录就带原因");
    // 收集结束后：同一路径被完整观察覆盖（原因保留）。
    assert.equal(result.recordPath, info.recordPath);
    const finalRecord = JSON.parse(readFileSync(info.recordPath, "utf8"));
    assert.equal(finalRecord.seats.find((s) => s.agentId === "seat_a").runState, "completed");
    assert.equal(finalRecord.seats.find((s) => s.agentId === "seat_b").runState, "dispatch_failed");
    assert.equal(finalRecord.seats.find((s) => s.agentId === "seat_b").dispatchError, "credential missing: X_KEY");
  } finally {
    cleanupDir(dir);
  }
});

// ── 第 96 批：派发失败原因——取因时就地加工（脱敏→控制字符→限长）、进组记
// 录（两次写）、重渲染带出、文本行显示。锚点：2026-11-10 分支工作树两席派发
// 全失败，原因（缺 --registry 的 ENOENT）只在 --format json 里可见。 ────────

test("DERR-1: 原因进结果与组记录（扇出时+收尾两次写都带）；有 runId 的席位不带", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-consult-derr1-"));
  try {
    const consultsDir = join(dir, "consults");
    const reason = "ENOENT: no such file or directory, open 'C:\\wt\\config\\agents.json'";
    const { dispatchFn } = makeDispatchStub();
    const dispatchFnPartial = async (input) => {
      if (input.agentId === "seat_b") throw new Error(reason);
      return dispatchFn(input);
    };
    const { readTranscriptFn } = makeTranscriptStub(new Map([
      ["run_stub_seat_a", makeTranscript("run_stub_seat_a", { finalText: "Q1: A\n" })],
    ]));
    const writes = [];
    const snapshots = [];
    const result = await runConsult(baseInput({
      consultsDir,
      dispatchFn: dispatchFnPartial,
      readTranscriptFn,
      idFn: () => "consult_20261110080000000derr101",
      writeFileFn: async (p, data) => {
        writes.push(p);
        snapshots.push(JSON.parse(data));
        mkdirSync(consultsDir, { recursive: true });
        writeFileSync(p, data, "utf8");
      },
      mkdirFn: async () => {},
    }));
    const seatB = result.seats.find((s) => s.agentId === "seat_b");
    assert.equal(seatB.runId, null);
    assert.equal(seatB.runState, "dispatch_failed");
    assert.equal(seatB.dispatchError, reason, "加工后原因进结果（env 无密钥/无控制字符/未超长 → 原样）");
    assert.ok(!("dispatchError" in result.seats.find((s) => s.agentId === "seat_a")), "有 runId 的席位不带该字段");
    assert.equal(writes.length, 2, "扇出时与收尾各写一次（收尾那份经改名换上）");
    for (const [snapshot, label] of [[snapshots[0], "扇出时"], [snapshots[1], "收尾"]]) {
      const recordB = snapshot.seats.find((s) => s.agentId === "seat_b");
      assert.equal(recordB.dispatchError, reason, `${label}的组记录都带原因`);
      assert.ok(!("dispatchError" in snapshot.seats.find((s) => s.agentId === "seat_a")), `${label}的组记录：有 runId 的席位不带`);
    }
    // 改名换上之后磁盘上的最终文件就是收尾那份。
    const onDisk = JSON.parse(readFileSync(writes[0], "utf8"));
    assert.equal(onDisk.seats.find((s) => s.agentId === "seat_b").dispatchError, reason);
  } finally {
    cleanupDir(dir);
  }
});

test("DERR-2: 脱敏——错误文本里的注入 env 密钥值，结果、组记录、文本输出只见替换标记", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-consult-derr2-"));
  try {
    const consultsDir = join(dir, "consults");
    // 密钥值运行时拼出（不写凭据形状字面量——desensitization 守卫）；名字命中
    // 密钥名规则、值不短于 8 字符 → 脱敏器认识它。
    const envName = "CONSULT_TEST_TOKEN";
    const secretValue = "stub-" + "credential-" + "material-" + "424242";
    const env = { [envName]: secretValue };
    const { dispatchFn } = makeDispatchStub();
    const dispatchFnPartial = async (input) => {
      if (input.agentId === "seat_b") throw new Error(`connect EACCES using ${secretValue} at registry`);
      return dispatchFn(input);
    };
    const { readTranscriptFn } = makeTranscriptStub(new Map([
      ["run_stub_seat_a", makeTranscript("run_stub_seat_a", { finalText: "Q1: A\n" })],
    ]));
    const snapshots = [];
    const result = await runConsult(baseInput({
      consultsDir,
      env,
      dispatchFn: dispatchFnPartial,
      readTranscriptFn,
      idFn: () => "consult_20261110080000000derr201",
      writeFileFn: async (p, data) => {
        snapshots.push(JSON.parse(data));
        mkdirSync(consultsDir, { recursive: true });
        writeFileSync(p, data, "utf8");
      },
      mkdirFn: async () => {},
    }));
    const marker = `[REDACTED:${envName}]`;
    const seatB = result.seats.find((s) => s.agentId === "seat_b");
    assert.ok(seatB.dispatchError.includes(marker), "结果只见替换标记");
    assert.ok(!seatB.dispatchError.includes(secretValue), "结果不泄漏原值");
    assert.equal(snapshots.length, 2, "扇出时与收尾各写一次组记录");
    for (const [snapshot, label] of [[snapshots[0], "扇出时"], [snapshots[1], "收尾"]]) {
      const recordB = snapshot.seats.find((s) => s.agentId === "seat_b");
      assert.ok(recordB.dispatchError.includes(marker), `${label}的组记录只见替换标记`);
      assert.ok(!recordB.dispatchError.includes(secretValue), `${label}的组记录不泄漏原值`);
    }
    const text = renderCouncilDiffText(result);
    assert.ok(text.includes(`派发未成立：connect EACCES using ${marker} at registry`), "文本输出（stateLine/回链行）只见替换标记");
    assert.ok(!text.includes(secretValue), "文本输出不泄漏原值");
    // stateLine 精确匹配——只满足于回链行的 includes 断言挡不住"stateLine 丢原因"。
    const stateLineB = text.split("\n").find((line) => line.startsWith("── seat_b（"));
    assert.equal(stateLineB,
      `── seat_b（（无 run——派发未成立：connect EACCES using ${marker} at registry） · dispatch_failed/empty）`,
      "stateLine 逐字带原因");
  } finally {
    cleanupDir(dir);
  }
});

test("DERR-3: 限长与顺序——超 400 码元截到 400（… 收尾）、代理对不切开、跨截断点的密钥先被完整脱敏、控制字符被清洗", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-consult-derr3-"));
  try {
    const consultsDir = join(dir, "consults");
    const envName = "CONSULT_TEST_SECRET";
    const secretValue = "hf" + "-token-" + "1234567890abcdef"; // 25 码元，运行时拼出
    const env = { [envName]: secretValue };
    // 密钥值跨在 400 截断点上：raw 的 395..419 码元是密钥（先脱敏后截断的靶子）。
    const secretStraddle = "ECONNRESET at " + "x".repeat(381) + secretValue + "y".repeat(300);
    const longPlain = "ENOENT: no such file or directory, open '".concat("p".repeat(500), "'");
    const surrogateStraddle = "a".repeat(398) + "\u{1F680}" + "b".repeat(50);
    const withControls = "spawn failed \u0007bell\u001b[2K end";
    const { dispatchFn } = makeDispatchStub();
    const dispatchFnBySeat = async (input) => {
      if (input.agentId === "seat_b") throw new Error(secretStraddle);
      if (input.agentId === "seat_c") throw new Error(longPlain);
      if (input.agentId === "seat_d") throw new Error(surrogateStraddle);
      if (input.agentId === "seat_e") throw new Error(withControls);
      return dispatchFn(input);
    };
    const { readTranscriptFn } = makeTranscriptStub(new Map([
      ["run_stub_seat_a", makeTranscript("run_stub_seat_a", { finalText: "Q1: A\n" })],
    ]));
    const result = await runConsult(baseInput({
      seats: [
        { agentId: "seat_a" }, { agentId: "seat_b" }, { agentId: "seat_c" },
        { agentId: "seat_d" }, { agentId: "seat_e" },
      ],
      consultsDir,
      env,
      dispatchFn: dispatchFnBySeat,
      readTranscriptFn,
      idFn: () => "consult_20261110080000000derr301",
      writeFileFn: async () => {},
      mkdirFn: async () => {},
    }));
    const stored = (agentId) => result.seats.find((s) => s.agentId === agentId).dispatchError;
    // 普通超长：恰 400 码元，= 前 399 码元 + …（精确匹配，防"至少包含"软断言）。
    const seatC = stored("seat_c");
    assert.equal(seatC.length, 400, "限长帽=400 码元（含 …）");
    assert.ok(seatC.endsWith("…"));
    assert.equal(seatC, longPlain.slice(0, 399) + "…");
    // 跨截断点的密钥：脱敏先于截断——截断位置上是替换标记的前缀 "[RED"，
    // 不是原值前缀 "hf-t"；任何一段原值都不在存储值里。
    const seatB = stored("seat_b");
    assert.equal(seatB.length, 400);
    assert.ok(seatB.endsWith("…"));
    assert.equal(seatB, "ECONNRESET at " + "x".repeat(381) + "[RED…",
      "截断点上是被截的替换标记前缀（证明先脱敏后截断）");
    assert.ok(!seatB.includes(secretValue));
    assert.ok(!seatB.includes(secretValue.slice(0, 4)));
    assert.ok(!seatB.includes("1234567890abcdef"));
    // 截断点落在代理对中间：整体让出一格，不切开代理对。
    const seatD = stored("seat_d");
    assert.equal(seatD, "a".repeat(398) + "…", "截断点回退到码点边界，… 收尾");
    assert.ok(!/[\uD800-\uDFFF]/.test(seatD), "存储值里没有落单代理");
    // 控制字符（C0/DEL 段）替换为 U+FFFD（复用本模块 sanitizeControls 的语义）。
    assert.equal(stored("seat_e"), "spawn failed \uFFFDbell\uFFFD[2K end");
  } finally {
    cleanupDir(dir);
  }
});

test("DERR-4: consult show 重渲染带原因——stateLine、runId 回链行、--out-dir 与 --seat --out 的行都带；旧记录照常渲染", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-consult-derr4-"));
  try {
    const runDir = join(dir, "runs");
    const consultsDir = join(dir, ".wao", "runs", "consults");
    writeRealTranscript(runDir, "run_derr_a", makeTranscript("run_derr_a", { finalText: "Q1: A 可行。\n" }));
    const consultId = "consult_20261110080000000derr401";
    const reason = "ENOENT: no such file or directory, open 'C:\\wt\\config\\agents.json'";
    writeConsultRecord(consultsDir, {
      consultId,
      createdAt: "2026-11-10T08:00:00.000Z",
      brief: { path: null, sha256: "ab".repeat(32) },
      budgetMs: 600000,
      elapsedMs: 100,
      questions: parseBriefQuestions("## Q1 方案可行吗\n"),
      seats: [
        { agentId: "seat_a", runId: "run_derr_a", runState: "completed", formatState: "structured" },
        { agentId: "seat_b", runId: null, runState: "dispatch_failed", formatState: "empty", dispatchError: reason },
      ],
      fieldDiff: [],
    });
    const outDir = join(dir, "final");
    const outDirOut = await captureConsult(() => consultCommand(
      ["show", consultId, "--out-dir", outDir, "--cwd", dir, "--run-dir", runDir], {}, {},
    ));
    assert.match(outDirOut.out, /seat_b \(no run · dispatch_failed: ENOENT[^)]*\): 0 chars written to/, "--out-dir 每席一行带原因");
    // 普通全量渲染（不带 --out-dir/--seat）：stateLine 与 runId 回链行带原因。
    const captured = await captureConsult(() => consultCommand(
      ["show", consultId, "--cwd", dir, "--run-dir", runDir], {}, {},
    ));
    assert.ok(captured.out.includes(`（无 run——派发未成立：${reason}）`), "stateLine 带原因");
    assert.ok(captured.out.includes(`seat_b: （无 run——派发未成立：${reason}）`), "runId 回链行带原因");
    // --seat --out 同一行格式（writeSeatText）。
    const outFile = join(dir, "seat-b.md");
    const seatOut = await captureConsult(() => consultCommand(
      ["show", consultId, "--seat", "seat_b", "--out", outFile, "--cwd", dir, "--run-dir", runDir], {}, {},
    ));
    assert.match(seatOut.out, /seat_b \(no run · dispatch_failed: ENOENT[^)]*\): 0 chars written to/, "--seat --out 行带原因");
    assert.equal(readFileSync(outFile, "utf8"), "", "无终稿席位照写空文件");
    // 旧记录（无 dispatchError）：渲染形状与改动前逐字一致。
    const legacyId = "consult_20261110080000000derr402";
    writeConsultRecord(consultsDir, {
      consultId: legacyId,
      createdAt: "2026-11-10T08:00:00.000Z",
      brief: { path: null, sha256: "ab".repeat(32) },
      budgetMs: 600000,
      elapsedMs: 100,
      questions: parseBriefQuestions("## Q1 方案可行吗\n"),
      seats: [{ agentId: "seat_none", runId: null, runState: "dispatch_failed", formatState: "empty" }],
      fieldDiff: [],
    });
    const legacyOut = await captureConsult(() => consultCommand(
      ["show", legacyId, "--cwd", dir, "--run-dir", runDir], {}, {},
    ));
    assert.ok(legacyOut.out.includes("（无 run——派发未成立）"), "旧记录照常渲染无原因标签");
    assert.ok(!legacyOut.out.includes("派发未成立："), "旧记录不带原因尾巴");
  } finally {
    cleanupDir(dir);
  }
});

test("DERR-5: rerenderConsultFromRecord 只做类型检查——字符串才带、非字符串按缺席、不再二次加工（超 400 含控制字符的记录值逐字读出）", async () => {
  // 组记录里放一个超 400 码元、带控制字符的原因：读取侧若再加工（脱敏/折叠/
  // 限长任一）都会改变它——本断言钉住"读取只做类型检查"。
  const rawRecorded = "r".repeat(380) + "\u0007" + "s".repeat(40);
  assert.ok(rawRecorded.length > 400, "测试前提：记录里的原因超过限长帽");
  const record = JSON.parse(JSON.stringify({
    consultId: "consult_20261110080000000derr501",
    createdAt: "2026-11-10T08:00:00.000Z",
    budgetMs: 600000,
    questions: parseBriefQuestions("## Q1 方案可行吗\n"),
    seats: [
      { agentId: "seat_b", runId: null, runState: "dispatch_failed", formatState: "empty", dispatchError: "ENOENT stub" },
      { agentId: "seat_bad", runId: null, runState: "dispatch_failed", formatState: "empty", dispatchError: 42 },
      { agentId: "seat_raw", runId: null, runState: "dispatch_failed", formatState: "empty", dispatchError: rawRecorded },
    ],
    fieldDiff: [],
  }));
  const result = await rerenderConsultFromRecord({
    record,
    runDir: join(tmpdir(), "wao-consult-derr5", "runs"),
    consultsDir: join(tmpdir(), "wao-consult-derr5", "consults"),
    readTranscriptFn: async () => { throw new Error("ENOENT stub transcript"); },
    env: {},
  });
  assert.equal(result.seats.find((s) => s.agentId === "seat_b").dispatchError, "ENOENT stub", "字符串原样带出");
  assert.ok(!("dispatchError" in result.seats.find((s) => s.agentId === "seat_bad")), "非字符串按缺席");
  assert.equal(result.seats.find((s) => s.agentId === "seat_raw").dispatchError, rawRecorded,
    "超 400 含控制字符的记录值逐字返回——读取侧不再二次加工");
});

test("DERR-6: 扇出 stderr started 行带原因（dispatch_failed: <原因>）；无原因的旧形状照旧只写 dispatch_failed", async () => {
  const config = {
    registry: join(tmpdir(), "wao-consult-derr6", "agents.json"),
    runDir: join(tmpdir(), "wao-consult-derr6", "runs"),
  };
  const fanOutSeats = (seatB) => ({
    runConsult: async (input) => {
      input.onFanOut({
        consultId: "consult_20261110080000000derr601",
        recordPath: "stub-record.json",
        seats: [{ agentId: "a", runId: "run_a" }, seatB],
      });
      return craftedResult();
    },
  });
  const withReason = await captureConsult(() => consultCommand(
    ["run", "brief.md", "--seats", "a,b", "--cwd", "C:/tmp/x"], config,
    fanOutSeats({
      agentId: "b", runId: null,
      dispatchError: "ENOENT: no such file or directory, open 'C:\\wt\\config\\agents.json'",
    }),
  ));
  assert.match(withReason.err, /\[consult\] consult_\w+ started — seats: a=run_a b=dispatch_failed: ENOENT/,
    "started 行把原因跟在 dispatch_failed 后（行尾）");
  const withoutReason = await captureConsult(() => consultCommand(
    ["run", "brief.md", "--seats", "a,b", "--cwd", "C:/tmp/x"], config,
    fanOutSeats({ agentId: "b", runId: null }),
  ));
  assert.match(withoutReason.err, /b=dispatch_failed(?::|\n)/, "无原因照旧只写 dispatch_failed");
  assert.ok(!withoutReason.err.includes("dispatch_failed:"), "无原因不出现冒号形");
});

test("DERR-7: consult wait 的 no seat was dispatched / never dispatched 提示带原因；无原因的旧形状不变", async () => {
  const consultId = "consult_20261110080000000derr701";
  const base = {
    consultId,
    createdAt: "2026-11-10T08:00:00.000Z",
    brief: { path: null, sha256: "ab".repeat(32) },
    budgetMs: 600000,
    elapsedMs: 100,
    questions: parseBriefQuestions("## Q1 方案可行吗\n"),
    fieldDiff: [],
  };
  const reason = "ENOENT: no such file or directory, open 'C:\\wt\\config\\agents.json'";
  const failedSeat = { agentId: "seat_x", runId: null, runState: "dispatch_failed", formatState: "empty", dispatchError: reason };
  const none = { ...base, seats: [failedSeat] };
  const noneOut = await captureConsult(() => consultCommand(["wait", consultId, "--cwd", "C:/tmp/x"], {}, {
    waitForConsult: async () => ({ record: none, allTerminal: true, waitedMs: 0, windowMs: 270000 }),
    readTranscript: async () => [],
  }));
  assert.match(noneOut.err, /no seat was dispatched \(seat_x: dispatch_failed: ENOENT[^)]*\)/, "零派发提示带原因");
  const mixed = { ...base, seats: [
    { agentId: "seat_a", runId: "run_wait_derr", runState: "running", formatState: "partial" }, failedSeat,
  ] };
  const mixedOut = await captureConsult(() => consultCommand(["wait", consultId, "--cwd", "C:/tmp/x"], {}, {
    waitForConsult: async () => ({ record: mixed, allTerminal: true, waitedMs: 1000, windowMs: 270000 }),
    readTranscript: async () => makeTranscript("run_wait_derr", { finalText: "Q1: 可行。\n" }),
  }));
  assert.match(mixedOut.err, /1 seat\(s\) were never dispatched \(seat_x: dispatch_failed: ENOENT[^)]*\)/, "计数提示带原因");
  // 旧记录（无 dispatchError）：提示形状与改动前逐字一致。
  const plain = { ...base, seats: [{ agentId: "seat_x", runId: null, runState: "dispatch_failed", formatState: "empty" }] };
  const plainOut = await captureConsult(() => consultCommand(["wait", consultId, "--cwd", "C:/tmp/x"], {}, {
    waitForConsult: async () => ({ record: plain, allTerminal: true, waitedMs: 0, windowMs: 270000 }),
    readTranscript: async () => [],
  }));
  assert.match(plainOut.err, /no seat was dispatched(?! \()/, "无原因提示形状与改动前一致");
  assert.ok(!plainOut.err.includes("dispatch_failed:"), "无原因不出现冒号形");
});

test("DERR-8: 限长边界——恰 400 码元原样返回（不补 …），401 截到 400（补 …）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-consult-derr8-"));
  try {
    const { dispatchFn } = makeDispatchStub();
    const dispatchFnBySeat = async (input) => {
      if (input.agentId === "seat_b") throw new Error("y".repeat(400));
      if (input.agentId === "seat_c") throw new Error("y".repeat(401));
      return dispatchFn(input);
    };
    const { readTranscriptFn } = makeTranscriptStub(new Map([
      ["run_stub_seat_a", makeTranscript("run_stub_seat_a", { finalText: "Q1: A\n" })],
    ]));
    const result = await runConsult(baseInput({
      seats: [{ agentId: "seat_a" }, { agentId: "seat_b" }, { agentId: "seat_c" }],
      dispatchFn: dispatchFnBySeat,
      readTranscriptFn,
      writeFileFn: async () => {},
      mkdirFn: async () => {},
    }));
    const stored = (agentId) => result.seats.find((s) => s.agentId === agentId).dispatchError;
    assert.equal(stored("seat_b"), "y".repeat(400), "恰 400 码元：原样返回，不补 …");
    assert.equal(stored("seat_c"), "y".repeat(399) + "…", "401 码元：截到 400（399 码元 + …）");
  } finally {
    cleanupDir(dir);
  }
});

test("DERR-9: 原文退回链（空 message→code→name、无 message 对象→code）与空白折叠（\\r\\n\\t 连同两侧空格折成单个空格）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-consult-derr9-"));
  try {
    const errorWithEmptyMessageAndCode = new Error("");
    errorWithEmptyMessageAndCode.code = "ENOENT";
    const errorWithEmptyMessageOnly = new Error(""); // 无 code：落到 name（"Error"）
    const multiline = "spawn failed\n\tat child (line 3)\r\n  exit 1";
    const { dispatchFn } = makeDispatchStub();
    const dispatchFnBySeat = async (input) => {
      if (input.agentId === "seat_b") throw errorWithEmptyMessageAndCode;
      if (input.agentId === "seat_c") throw errorWithEmptyMessageOnly;
      if (input.agentId === "seat_d") throw { code: "EACCES" }; // 无 message 的普通对象
      if (input.agentId === "seat_e") throw new Error(multiline);
      return dispatchFn(input);
    };
    const { readTranscriptFn } = makeTranscriptStub(new Map([
      ["run_stub_seat_a", makeTranscript("run_stub_seat_a", { finalText: "Q1: A\n" })],
    ]));
    const result = await runConsult(baseInput({
      seats: [
        { agentId: "seat_a" }, { agentId: "seat_b" }, { agentId: "seat_c" },
        { agentId: "seat_d" }, { agentId: "seat_e" },
      ],
      dispatchFn: dispatchFnBySeat,
      readTranscriptFn,
      writeFileFn: async () => {},
      mkdirFn: async () => {},
    }));
    const stored = (agentId) => result.seats.find((s) => s.agentId === agentId).dispatchError;
    assert.equal(stored("seat_b"), "ENOENT", "空 message → 退回 code");
    assert.equal(stored("seat_c"), "Error", "空 message 且无 code → 退回 name");
    assert.equal(stored("seat_d"), "EACCES", "无 message 的对象 → 退回 code（不是 [object Object]）");
    assert.equal(stored("seat_e"), "spawn failed at child (line 3) exit 1", "\\r\\n\\t 连同两侧空格折成单个空格");
    for (const agentId of ["seat_b", "seat_c", "seat_d", "seat_e"]) {
      assert.ok(!/[\r\n\t]/.test(stored(agentId)), `${agentId} 的原因不含换行/制表符`);
    }
    // 渲染出的各行都不含换行：stateLine 逐字等于单行期望。
    const text = renderCouncilDiffText(result);
    const stateLineE = text.split("\n").find((line) => line.startsWith("── seat_e（"));
    assert.equal(stateLineE,
      "── seat_e（（无 run——派发未成立：spawn failed at child (line 3) exit 1） · dispatch_failed/empty）",
      "多行报错折叠后在 stateLine 里仍是单行");
  } finally {
    cleanupDir(dir);
  }
});

// ===== waitForConsult：等一场已扇出的会审（各席终态或观察窗到期）=====

test("WAIT-1: 各席转录都到终态 → allTerminal=true", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-consult-wait1-"));
  try {
    const runDir = join(dir, "runs");
    const consultsDir = join(dir, "consults");
    writeRealTranscript(runDir, "run_wait_a", makeTranscript("run_wait_a", { finalText: "Q1: A\n" }));
    writeRealTranscript(runDir, "run_wait_b", makeTranscript("run_wait_b", { state: "failed" }));
    const consultId = "consult_20261002120000000abc123";
    writeConsultRecord(consultsDir, {
      consultId,
      seats: [
        { agentId: "seat_a", runId: "run_wait_a", runState: "running" },
        { agentId: "seat_b", runId: "run_wait_b", runState: "running" },
      ],
    });
    const clock = makeFakeClock();
    const waited = await waitForConsult({
      consultId,
      consultsDir,
      runDir,
      nowFn: clock.nowFn,
      sleepFn: clock.sleepFn,
    });
    assert.equal(waited.allTerminal, true, "两席转录均已终态");
    assert.equal(waited.record.consultId, consultId);
    assert.equal(waited.windowMs, 270000, "缺省观察窗与 runs wait 相同");
  } finally {
    cleanupDir(dir);
  }
});

test("WAIT-2: 观察窗到期仍有席位在跑 → allTerminal=false（注入时钟推进，不真睡）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-consult-wait2-"));
  try {
    const runDir = join(dir, "runs");
    const consultsDir = join(dir, "consults");
    writeRealTranscript(runDir, "run_wait_c", makeTranscript("run_wait_c", { state: "running", finalText: "Q1: 还在想\n" }));
    const consultId = "consult_20261002120000000abc123";
    writeConsultRecord(consultsDir, {
      consultId,
      seats: [{ agentId: "seat_c", runId: "run_wait_c", runState: "running" }],
    });
    const clock = makeFakeClock();
    const waited = await waitForConsult({
      consultId,
      consultsDir,
      runDir,
      waitMs: 180000,
      pollIntervalMs: 60000,
      nowFn: clock.nowFn,
      sleepFn: clock.sleepFn,
    });
    assert.equal(waited.allTerminal, false, "窗口到期席位仍在跑——如实 false");
    assert.equal(waited.windowMs, 180000);
    assert.equal(waited.waitedMs, 180000, "观察窗完整耗尽");
  } finally {
    cleanupDir(dir);
  }
});

test("WAIT-3: waitMs 超出 [180000, 600000] 抛错", async () => {
  const base = {
    consultId: "consult_20261002120000000abc123",
    consultsDir: "C:/stub/consults",
    runDir: "C:/stub/runs",
  };
  await assert.rejects(
    () => waitForConsult({ ...base, waitMs: 179999 }),
    /waitMs must be an integer/,
  );
  await assert.rejects(
    () => waitForConsult({ ...base, waitMs: 600001 }),
    /waitMs must be an integer/,
  );
});

test("WAIT-4: runId=null 的席位不参与等待（只等真实 run，不为其读转录）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-consult-wait4-"));
  try {
    const runDir = join(dir, "runs");
    const consultsDir = join(dir, "consults");
    writeRealTranscript(runDir, "run_wait_d", makeTranscript("run_wait_d", { finalText: "Q1: A\n" }));
    const consultId = "consult_20261002120000000abc123";
    writeConsultRecord(consultsDir, {
      consultId,
      seats: [
        { agentId: "seat_a", runId: null, runState: "dispatch_failed" },
        { agentId: "seat_b", runId: "run_wait_d", runState: "running" },
      ],
    });
    const { readTranscriptFn, reads } = makeTranscriptStub(new Map([
      ["run_wait_d", makeTranscript("run_wait_d", { finalText: "Q1: A\n" })],
    ]));
    const clock = makeFakeClock();
    const waited = await waitForConsult({
      consultId,
      consultsDir,
      runDir,
      readTranscriptFn,
      nowFn: clock.nowFn,
      sleepFn: clock.sleepFn,
    });
    assert.equal(waited.allTerminal, true, "只有真实 run 参与等待且已终态");
    assert.deepEqual(reads, ["run_wait_d"], "不为 runId=null 的席位读转录");
  } finally {
    cleanupDir(dir);
  }
});

// ===== 决定 0111：按 id 读组记录的回退（状态目录 ENOENT → 改动前落点）=====

test("FB-1: 状态目录没有这份记录（ENOENT）、回退目录有 → 从回退目录读，返回真实目录", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-consult-fb1-"));
  try {
    const stateDir = join(dir, "main", "consults");
    const legacyDir = join(dir, "wt", "consults");
    const consultId = "consult_20261002120000000abc123";
    writeConsultRecord(legacyDir, { consultId, seats: [] });
    const { record, consultsDir } = await loadConsultRecordWithFallback({
      consultId, consultsDir: stateDir, fallbackConsultsDir: legacyDir, sleepFn: () => {},
    });
    assert.equal(record.consultId, consultId);
    assert.equal(consultsDir, resolve(legacyDir), "返回实际读到的目录（回显真实位置）");
  } finally {
    cleanupDir(dir);
  }
});

test("FB-2: 状态目录直接有这份记录 → 不碰回退目录；两边都没有 → 原样抛 ENOENT", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-consult-fb2-"));
  try {
    const stateDir = join(dir, "main", "consults");
    const legacyDir = join(dir, "wt", "consults");
    const consultId = "consult_20261002120000000abc123";
    writeConsultRecord(stateDir, { consultId, seats: [] });
    const seen = [];
    const trackingRead = async (p, ...rest) => {
      seen.push(p);
      return readFile(p, ...rest);
    };
    const direct = await loadConsultRecordWithFallback({
      consultId, consultsDir: stateDir, fallbackConsultsDir: legacyDir,
      readFileFn: trackingRead, sleepFn: () => {},
    });
    assert.equal(direct.consultsDir, resolve(stateDir), "状态目录命中，返回状态目录");
    assert.ok(seen.every((p) => p.startsWith(stateDir)), "不读回退目录");
    // 两边都没有：ENOENT 原样抛（回退目录也 ENOENT 时错误不被吞掉）。
    await assert.rejects(
      () => loadConsultRecordWithFallback({
        consultId: "consult_20261002000000000zzzzzz",
        consultsDir: stateDir, fallbackConsultsDir: legacyDir, sleepFn: () => {},
      }),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("FB-3: 只有 ENOENT 触发回退——状态目录里这份记录是坏 JSON → 报错，不用回退目录顶掉", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-consult-fb3-"));
  try {
    const stateDir = join(dir, "main", "consults");
    const legacyDir = join(dir, "wt", "consults");
    const consultId = "consult_20261002120000000abc123";
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, `${consultId}.json`), "{ not json", "utf8");
    writeConsultRecord(legacyDir, { consultId, seats: [] });
    await assert.rejects(
      () => loadConsultRecordWithFallback({
        consultId, consultsDir: stateDir, fallbackConsultsDir: legacyDir, sleepFn: () => {},
      }),
      /consult record unreadable after 5 attempts/,
      "坏 JSON 照旧报错——读取者要看到真实状态，不被旧目录好记录静默顶掉",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("FB-4: waitForConsult 带 fallbackConsultsDir——回退目录读到记录，返回值带真实目录", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-consult-fb4-"));
  try {
    const runDir = join(dir, "runs");
    const stateDir = join(dir, "main", "consults");
    const legacyDir = join(dir, "wt", "consults");
    const consultId = "consult_20261002120000000abc123";
    // 全员派发未成立（runId=null）：等待立即结束，聚焦回退读取本身。
    writeConsultRecord(legacyDir, {
      consultId,
      seats: [{ agentId: "seat_a", runId: null, runState: "dispatch_failed" }],
    });
    const waited = await waitForConsult({
      consultId,
      consultsDir: stateDir,
      fallbackConsultsDir: legacyDir,
      runDir,
      sleepFn: () => {},
    });
    assert.equal(waited.record.consultId, consultId);
    assert.equal(waited.consultsDir, resolve(legacyDir), "等待返回实际读到的目录");
    assert.equal(waited.allTerminal, true, "无已派发席位即全部收口");
  } finally {
    cleanupDir(dir);
  }
});

// ===== 三块砖①厂族：registry 原始字段直读（R9——r1.1 必改①）=====

test("BRICK-1: runConsult 厂族砖=backend/provider 原始字段直读；registry 不可读如实降级 null", async () => {
  const { dispatchFn } = makeDispatchStub();
  const { readTranscriptFn } = makeTranscriptStub(new Map([
    ["run_stub_seat_a", makeTranscript("run_stub_seat_a", { finalText: "Q1: A\n" })],
    ["run_stub_seat_b", makeTranscript("run_stub_seat_b", { finalText: "Q1: B\n" })],
  ]));
  const result = await runConsult(baseInput({
    dispatchFn,
    readTranscriptFn,
    writeFileFn: async () => {},
    mkdirFn: async () => {},
  }));
  const a = result.seats.find((s) => s.agentId === "seat_a");
  assert.equal(a.backend, "deepseek-acp", "backend 原始字符串直读");
  assert.equal(a.provider, "deepseek-official", "provider 原始标识（model.providerID）直读");
  const b = result.seats.find((s) => s.agentId === "seat_b");
  assert.equal(b.backend, "codex");
  assert.equal(b.provider, null, "无路由字段如实 null——不猜不归类");
  // 0045 W4c：runtimeFacts 增 registryResolution（"ok"|"failed"|"registry-unreadable"）
  // ——解析失败不再静默吞成与"确无 provider"同形的 null。
  assert.deepEqual(result.bricks.runtimeFacts, [
    { agentId: "seat_a", backend: "deepseek-acp", provider: "deepseek-official", registryResolution: "ok" },
    { agentId: "seat_b", backend: "codex", provider: null, registryResolution: "ok" },
  ]);
  assert.ok(!("modelFamily" in a), "席位不再携带族系归类字段（R9 控制面铁律）");
  assert.ok(!("modelFamily" in result.record.seats[0]), "组记录席位同样不落族系归类字段");
  // registry 不可读：厂族砖整体降级 null（观察事实，不阻断会审）。
  const degraded = await runConsult(baseInput({
    dispatchFn,
    readTranscriptFn,
    registryReadFn: async () => { throw new Error("ENOENT stub registry"); },
    writeFileFn: async () => {},
    mkdirFn: async () => {},
  }));
  assert.deepEqual(degraded.bricks.runtimeFacts, [
    { agentId: "seat_a", backend: null, provider: null, registryResolution: "registry-unreadable" },
    { agentId: "seat_b", backend: null, provider: null, registryResolution: "registry-unreadable" },
  ]);
});

test("BRICK-2: seatRuntimeFacts 纯函数——model.providerID 直读；缺形状如实 null", () => {
  assert.deepEqual(
    seatRuntimeFacts({ backend: "zcode", model: { id: "zhipu/glm-5.3", providerID: "zhipu" } }),
    { backend: "zcode", provider: "zhipu" },
    "providerID 是首选原始标识",
  );
  assert.deepEqual(seatRuntimeFacts({ backend: "codex" }), { backend: "codex", provider: null });
  assert.deepEqual(seatRuntimeFacts({}), { backend: null, provider: null });
});

// ===== parseBriefQuestions =====

test("PARSE-1: 两种锚点形（## Q1 / Q1: / Q1：）识别；非锚点行与重复 Q 号不收", () => {
  const brief = [
    "# 任务书标题",
    "## Q1 方案可行吗",
    "正文说明……",
    "Q2: 首选哪个",
    "Q3：风险几何",
    "Q4 没有分隔符（不是锚点）",
    "### Q1 重复出现",
    "",
  ].join("\n");
  const qs = parseBriefQuestions(brief);
  assert.deepEqual(qs.map((q) => q.q), [1, 2, 3]);
  assert.equal(qs[0].heading, "## Q1 方案可行吗");
  assert.equal(qs[1].heading, "Q2: 首选哪个");
  assert.equal(qs[2].heading, "Q3：风险几何");
});

test("PARSE-2: consultId 形状（consult_ + 时间戳 + 6 随机）与校验", () => {
  const id = generateConsultId(() => Date.UTC(2026, 9, 2, 12, 0, 0, 123));
  assert.match(id, /^consult_20261002120000123[0-9a-z]{6}$/);
  assert.equal(isValidConsultId(id), true);
  assert.equal(isValidConsultId("../runs/evil"), false);
  assert.equal(isValidConsultId("run_123"), false);
});

// ===== CLI 渲染（text/json 两形状）=====

function craftedResult() {
  return {
    consultId: "consult_20261002120000000abc123",
    recordPath: "C:/tmp/consults/consult_20261002120000000abc123.json",
    questions: parseBriefQuestions("## Q1 方案可行吗\nQ2: 首选哪个\n"),
    brief: { path: "brief.md", sha256: "ab".repeat(32) },
    budgetMs: 600000,
    elapsedMs: 4231,
    seats: [
      {
        agentId: "seat_a", runId: "run_a", runState: "completed", formatState: "structured",
        backend: "deepseek-acp", provider: "deepseek-official", budgetExpired: false,
        attribution: attributeReply("Q1: A 可行\nQ2: 选 B\n"),
        finalText: "Q1: A 可行\nQ2: 选 B\n",
      },
      {
        agentId: "seat_b", runId: "run_b", runState: "completed", formatState: "unstructured",
        backend: "kimi-code", provider: null, budgetExpired: false,
        attribution: attributeReply("整体可行，就这样吧。\n"),
        finalText: "整体可行，就这样吧。\n",
      },
    ],
    fieldDiff: ["Q1"],
    fieldValues: { Q1: { seat_a: "A", seat_b: null } },
    bricks: {
      runtimeFacts: [
        { agentId: "seat_a", backend: "deepseek-acp", provider: "deepseek-official" },
        { agentId: "seat_b", backend: "kimi-code", provider: null },
      ],
      authorInSeats: false,
      reviewedAgentId: "coder_x",
      reviewedRunId: "run_reviewed_9",
      sessionIndependence: "未提供",
    },
  };
}

test("CLI-1: text 渲染——按问题原序并列、未归类区在场、runId 清单在场、无结论词", () => {
  const text = renderCouncilDiffText(craftedResult());
  assert.ok(text.includes("Q1 方案可行吗"), "问题标题在场");
  assert.ok(text.includes("Q2 首选哪个"));
  assert.ok(text.includes("seat_a"), "每问下各席并列");
  assert.ok(text.includes("A 可行"), "席位原文在场");
  assert.ok(text.includes("—— 未归类"), "未归类区在场");
  assert.ok(text.includes("整体可行，就这样吧。"), "未归类整段原文在场");
  assert.ok(text.includes("⚑ 字段值不同(Q1)"), "字段值不同标记在场");
  assert.ok(text.includes("seat_b=未填"), "未填如实展示");
  assert.ok(text.includes("—— runId 回链"), "runId 清单在场");
  assert.ok(text.includes("run_a"));
  assert.ok(text.includes("∉ 席位清单"), "非作者砖事实行在场（authorInSeats=false）");
  assert.ok(text.includes("会话独立性：未提供"), "三块砖之会话独立性如实未提供");
  assert.ok(text.includes("registry 原始字段直读"), "厂族砖声明原始字段直读（不归类）");
  assert.ok(text.includes("seat_a=deepseek-acp @ deepseek-official"), "厂族砖 backend/provider 原始值在场");
  assert.ok(!/\d+ 族）/.test(text), "不做族系计数（R9：归类判断不出现在控制面输出）");
  for (const forbidden of ["一致", "分歧", "agree", "disagree"]) {
    assert.ok(!text.includes(forbidden), `渲染不得含结论词：${forbidden}`);
  }
});

test("CLI-2: consult run --format json 输出结构化全量（每席完整原文，零截断）", async () => {
  const result = craftedResult();
  const lines = [];
  const origLog = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await consultCommand(
      ["run", "brief.md", "--seats", "a,b", "--format", "json", "--cwd", "C:/tmp/x"],
      // R23-D（r1.1 必改②）：run-dir 一律 tmpdir 锚定——绝不写仓库相对 runs/。
      { registry: join(tmpdir(), "wao-consult-cli2", "agents.json"), runDir: join(tmpdir(), "wao-consult-cli2", "runs") },
      { runConsult: async () => result },
    );
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(lines.join("\n"));
  assert.equal(parsed.consultId, result.consultId);
  assert.equal(parsed.seats[0].finalText, "Q1: A 可行\nQ2: 选 B\n", "json 含每席完整原文");
  assert.ok(parsed.fieldValues.Q1.seat_a === "A");
});

test("CLI-3: consult run 参数面——seats 必填、perspective 席位校验、fields 键形状", async () => {
  await assert.rejects(
    () => consultCommand(["run", "brief.md"], {}, { runConsult: async () => craftedResult() }),
    /--seats/,
  );
  await assert.rejects(
    () => consultCommand(
      ["run", "brief.md", "--seats", "a,b", "--perspective", "zzz=p.md"],
      {},
      { runConsult: async () => craftedResult() },
    ),
    /not in --seats/,
  );
  await assert.rejects(
    () => consultCommand(
      ["run", "brief.md", "--seats", "a,b", "--fields", "verdict=A,B"],
      {},
      { runConsult: async () => craftedResult() },
    ),
    /Q1\/Q2/,
  );
  // 重复 --fields 两个都收到。
  const seen = [];
  await consultCommand(
    ["run", "brief.md", "--seats", "a", "--fields", "Q1=A,B", "--fields", "Q2=C", "--cwd", "C:/tmp/x"],
    {},
    {
      runConsult: async (input) => {
        seen.push(input.declaredFields);
        return craftedResult();
      },
    },
  );
  assert.deepEqual(seen[0], { Q1: ["A", "B"], Q2: ["C"] });
});

test("CLI-4: consult show 从组记录重渲染（只读；问题原序 + 席位原文在场）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-consult-show-"));
  try {
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    const consultsDir = join(dir, ".wao", "runs", "consults");
    mkdirSync(consultsDir, { recursive: true });
    const events = makeTranscript("run_show_a", { finalText: "Q1: A 可行\nQ2: 选 B\n" });
    writeFileSync(join(runDir, "run_show_a.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    const record = {
      consultId: "consult_20261002120000000abc123",
      createdAt: "2026-10-02T12:00:00.000Z",
      brief: { path: join(dir, "brief.md"), sha256: "ab".repeat(32) },
      budgetMs: 600000,
      elapsedMs: 100,
      questions: parseBriefQuestions("## Q1 方案可行吗\nQ2: 首选哪个\n"),
      declaredFields: { Q1: ["A", "B"] },
      seats: [{ agentId: "seat_a", runId: "run_show_a", runState: "completed", formatState: "structured", backend: "deepseek-acp", provider: "deepseek-official" }],
      fieldDiff: [],
    };
    writeFileSync(join(consultsDir, "consult_20261002120000000abc123.json"), JSON.stringify(record), "utf8");

    const lines = [];
    const origLog = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try {
      await consultCommand(
        ["show", "consult_20261002120000000abc123", "--cwd", dir, "--run-dir", runDir],
        {},
      );
    } finally {
      console.log = origLog;
    }
    const text = lines.join("\n");
    assert.ok(text.includes("Q1 方案可行吗"), "问题标题来自组记录");
    assert.ok(text.includes("A 可行"), "席位原文经 runId 回链重读");
    assert.ok(text.includes("—— runId 回链"), "回链清单在场");
    assert.ok(text.includes("run_show_a"));
    // show 拒绝路径穿越形状的 consultId。
    await assert.rejects(
      () => consultCommand(["show", "..%2Fevil", "--cwd", dir, "--run-dir", runDir], {}),
      /invalid consultId/,
    );
  } finally {
    cleanupDir(dir);
  }
});

test("CLI-5: 无子命令与 --help 打印用法（含 consult wait）；未知子命令抛错且错误信息带用法", async () => {
  const lines = [];
  const origLog = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await consultCommand([], {});
    await consultCommand(["--help"], {});
  } finally {
    console.log = origLog;
  }
  assert.equal(lines.length, 2, "两次调用各打印一次用法");
  for (const text of lines) {
    assert.ok(text.includes("consult run"), "用法含 consult run");
    assert.ok(text.includes("consult show"), "用法含 consult show");
    assert.ok(text.includes("consult wait"), "用法含 consult wait");
    assert.ok(text.includes("--seat"), "用法解释 --seat/--out");
  }
  await assert.rejects(
    () => consultCommand(["frobnicate"], {}),
    (err) => {
      assert.match(err.message, /unknown subcommand "frobnicate"/);
      assert.ok(err.message.includes("consult wait"), "错误信息附带用法（含 consult wait）");
      return true;
    },
  );
});

test("CLI-6: consult show --seat --out 把该席完整最终文本（>4000 字符）原样写进文件；未知席点名现有席位；只给 --out 不给 --seat 抛错", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-consult-seatout-"));
  try {
    const runDir = join(dir, "runs");
    const consultsDir = join(dir, ".wao", "runs", "consults");
    const longText = `Q1: 采纳 A\n${"席位完整原文，逐字节不截断。".repeat(600)}\n`;
    assert.ok(longText.length > 4000, "测试前提：正文超过 4000 字符");
    writeRealTranscript(runDir, "run_seat_out_a", makeTranscript("run_seat_out_a", { finalText: longText }));
    const consultId = "consult_20261002120000000abc123";
    writeConsultRecord(consultsDir, {
      consultId,
      createdAt: "2026-10-02T12:00:00.000Z",
      brief: { path: join(dir, "brief.md"), sha256: "ab".repeat(32) },
      budgetMs: 600000,
      elapsedMs: 100,
      questions: parseBriefQuestions("## Q1 方案可行吗\n"),
      seats: [{ agentId: "seat_a", runId: "run_seat_out_a", runState: "completed", formatState: "structured" }],
      fieldDiff: [],
    });
    const outFile = join(dir, "seat-a.txt");
    const lines = [];
    const origLog = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try {
      await consultCommand(
        ["show", consultId, "--seat", "seat_a", "--out", outFile, "--cwd", dir, "--run-dir", runDir],
        {},
      );
    } finally {
      console.log = origLog;
    }
    assert.equal(readFileSync(outFile, "utf8"), longText, "文件=该席完整最终文本（零截断）");
    assert.equal(lines.length, 1, "stdout 恰一行");
    assert.ok(lines[0].includes(`): ${longText.length} chars written to `), "stdout 报字符数");
    assert.ok(lines[0].includes(outFile), "stdout 报文件路径");
    // --seat 给了不存在的席位 → 抛错并点名现有席位。
    await assert.rejects(
      () => consultCommand(["show", consultId, "--seat", "ghost", "--cwd", dir, "--run-dir", runDir], {}),
      /seat "ghost" is not in this consult \(seats: seat_a\)/,
    );
    // 只给 --out 不给 --seat → 抛错。
    await assert.rejects(
      () => consultCommand(["show", consultId, "--out", join(dir, "x.txt"), "--cwd", dir, "--run-dir", runDir], {}),
      /--out goes with --seat/,
    );
  } finally {
    cleanupDir(dir);
  }
});

test("CLI-7: consult wait 经 deps.waitForConsult 注入后被调用；--format json 输出带 wait.allTerminal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-consult-waitcmd-"));
  try {
    const runDir = join(dir, "runs");
    const consultsDir = join(dir, ".wao", "runs", "consults");
    const consultId = "consult_20261002120000000abc123";
    const record = {
      consultId,
      createdAt: "2026-10-02T12:00:00.000Z",
      brief: { path: null, sha256: "ab".repeat(32) },
      budgetMs: 600000,
      elapsedMs: 100,
      questions: parseBriefQuestions("## Q1 方案可行吗\n"),
      seats: [{ agentId: "seat_a", runId: null, runState: "dispatch_failed", formatState: "empty" }],
      fieldDiff: [],
    };
    writeConsultRecord(consultsDir, record);
    const seen = [];
    const lines = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => lines.push(a.join(" "));
    console.error = () => {};
    try {
      await consultCommand(
        ["wait", consultId, "--format", "json", "--cwd", dir, "--run-dir", runDir],
        {},
        {
          waitForConsult: async (input) => {
            seen.push(input);
            return { record, allTerminal: false, waitedMs: 4321, windowMs: 600000 };
          },
          readTranscript: async () => [],
        },
      );
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    assert.equal(seen.length, 1, "deps.waitForConsult 恰被调用一次");
    assert.equal(seen[0].consultId, consultId);
    assert.equal(seen[0].consultsDir, consultsDir);
    assert.equal(seen[0].runDir, runDir);
    const parsed = JSON.parse(lines.join("\n"));
    assert.deepEqual(
      parsed.wait,
      { allTerminal: false, waitedMs: 4321, windowMs: 600000 },
      "json 输出携带 wait 块",
    );
    assert.equal(parsed.consultId, consultId);
  } finally {
    cleanupDir(dir);
  }
});

// 决定 0055（Owner 2026-10-10 批准）：只读席位违规自动判 FAIL。
// 2026-11-03 判定权威改接只读观察投影：真实事件形状（run.event/file_written）
// 的工作树内写入才计数；系统临时目录的实验写入不算违规（旧的自数顶层
// type:"file_written" 从未匹配过真实转录，判定从未触发过）。
test("0055: 席位在工作树内有工具写入 → readOnlyViolation FAIL；只在系统临时目录写或零写入 → 不判（不改写 runState）", async () => {
  const { dispatchFn } = makeDispatchStub();
  const { readTranscriptFn } = makeTranscriptStub(new Map([
    ["run_stub_seat_a", makeTranscript("run_stub_seat_a", { finalText: "Q1: 可行\n", fileWrittenCount: 3 })],
    ["run_stub_seat_b", makeTranscript("run_stub_seat_b", { finalText: "Q1: 可行\n" })],
    ["run_stub_seat_c", makeTranscript("run_stub_seat_c", { finalText: "Q1: 可行\n", tmpWrittenCount: 2 })],
    ["run_stub_seat_d", makeTranscript("run_stub_seat_d", { finalText: "Q1: 可行\n", fileWrittenCount: 2, tmpWrittenCount: 1 })],
  ]));
  const result = await runConsult(baseInput({
    briefText: "b\n",
    seats: [{ agentId: "seat_a" }, { agentId: "seat_b" }, { agentId: "seat_c" }, { agentId: "seat_d" }],
    dispatchFn,
    readTranscriptFn,
    writeFileFn: async () => {},
    mkdirFn: async () => {},
  }));
  const seatA = result.seats.find((s) => s.agentId === "seat_a");
  const seatB = result.seats.find((s) => s.agentId === "seat_b");
  const seatC = result.seats.find((s) => s.agentId === "seat_c");
  assert.deepEqual(seatA.readOnlyViolation, { verdict: "FAIL", fileWrittenCount: 3 }, "工作树内写入席位判 FAIL");
  assert.equal(seatA.runState, "completed", "runState 保持自然终态（不改写）");
  assert.equal(seatB.readOnlyViolation, undefined, "零写入席位无该字段");
  assert.equal(seatC.readOnlyViolation, undefined, "只写系统临时目录的席位不判违规");
  assert.equal(seatC.runState, "completed", "实验写入不改写自然终态");
  const seatD = result.seats.find((s) => s.agentId === "seat_d");
  assert.deepEqual(seatD.readOnlyViolation, { verdict: "FAIL", fileWrittenCount: 2 },
    "临时目录的写入不掩盖同一席位在工作树内的写入");
});

// ===== 整词匹配的两个边角；组记录被替换时的读取 =====

test("字段值：同一位置取最长的声明值；多个归组块时取第一个有命中的块", () => {
  const hyphen = compareFields({ a: attributeReply("Q1: PASS-WITH-NOTES\n") }, { Q1: ["PASS", "PASS-WITH-NOTES"] });
  assert.equal(hyphen.fieldValues.Q1.a, "PASS-WITH-NOTES", "连字符后缀不让较短的前缀抢先");
  const reversed = compareFields({ a: attributeReply("Q1: PASS-WITH-NOTES\n") }, { Q1: ["PASS-WITH-NOTES", "PASS"] });
  assert.equal(reversed.fieldValues.Q1.a, "PASS-WITH-NOTES", "与声明顺序无关");
  const blocks = compareFields({ a: attributeReply("Q1:              PASS\nQ1: FAIL\n") }, { Q1: ["PASS", "FAIL"] });
  assert.equal(blocks.fieldValues.Q1.a, "PASS", "后一块里更靠左的值不覆盖先出现的块");
});

test("loadConsultRecord：读到替换中的半截内容时重试；文件不存在不重试；一直解析不了才报错", async () => {
  const consultId = "consult_20261002120000000abc123";
  const good = JSON.stringify({ consultId, seats: [] });
  const sequence = ["", "{\"consultId\":", good];
  let reads = 0;
  const record = await loadConsultRecord({
    consultId, consultsDir: "consults", sleepFn: async () => {},
    readFileFn: async () => sequence[reads++],
  });
  assert.equal(record.consultId, consultId);
  assert.equal(reads, 3);

  let missingReads = 0;
  await assert.rejects(loadConsultRecord({
    consultId, consultsDir: "consults", sleepFn: async () => {},
    readFileFn: async () => { missingReads += 1; throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
  }), /ENOENT/);
  assert.equal(missingReads, 1);

  let badReads = 0;
  await assert.rejects(loadConsultRecord({
    consultId, consultsDir: "consults", sleepFn: async () => {},
    readFileFn: async () => { badReads += 1; return "{not json"; },
  }), /unreadable after 5 attempts/);
  assert.equal(badReads, 5);
});

test("组记录收尾：改名换不上去时退回就地覆盖并清掉临时文件；读取重试的间隔是 100ms", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-consult-rename-"));
  try {
    const consultsDir = join(dir, "consults");
    const { dispatchFn } = makeDispatchStub();
    const { readTranscriptFn } = makeTranscriptStub(new Map([
      ["run_stub_seat_a", makeTranscript("run_stub_seat_a", { finalText: "Q1: A\n" })],
      ["run_stub_seat_b", makeTranscript("run_stub_seat_b", { finalText: "Q1: A\n" })],
    ]));
    const fixedId = "consult_20261002120000000rename";
    const removed = [];
    await runConsult(baseInput({
      briefPath: join(dir, "brief.md"),
      dispatchFn,
      readTranscriptFn,
      consultsDir,
      idFn: () => fixedId,
      renameFn: async () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); },
      rmFn: async (path) => { removed.push(path); rmSync(path, { force: true }); },
    }));
    assert.deepEqual(readdirSync(consultsDir), [`${fixedId}.json`], "临时文件被清掉，只剩记录");
    assert.equal(removed.length, 1);
    const record = JSON.parse(readFileSync(join(consultsDir, `${fixedId}.json`), "utf8"));
    assert.equal(record.seats.every((seat) => seat.runState === "completed"), true, "记录是收尾后的完整观察，不是扇出时那份");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const sleeps = [];
  const consultId = "consult_20261002120000000abc123";
  const sequence = ["", JSON.stringify({ consultId, seats: [] })];
  let reads = 0;
  await loadConsultRecord({
    consultId, consultsDir: join(tmpdir(), "wao-consult-retry-interval"),
    sleepFn: async (ms) => { sleeps.push(ms); },
    readFileFn: async () => sequence[reads++],
  });
  assert.deepEqual(sleeps, [100]);
});

// ── TD-283：席位目标车道带 Owner 暂停说明 → 每席一行 advisory（不拦截） ────────

test("TD-283: 会审席位目标是带 dispatchHold 的车道 → advisorySink 每席一行；其余席位零行", async () => {
  const { laneDispatchHold } = await import("../../src/dispatchResolution.js");
  // 夹具车道表（lanesDocFn 测试缝注入——不读真实 config/lanes.json，解除暂停
  // 改表后这里不红；Owner 原话不抄第二份）。
  const lanesDoc = {
    ok: true, path: "fixture", sha256: "ab".repeat(32), issues: [], rolesHint: [],
    lanes: [
      { id: "held-lane", backend: "claude-code", model: { id: "fixture-m" }, reasoning: null, aliases: {}, dispatchHold: "夹具：暂停说明" },
      { id: "plain-lane", backend: "claude-code", model: { id: "fixture-m" }, reasoning: null, aliases: {} },
    ],
  };
  const heldLane = lanesDoc.lanes[0];
  const advisories = [];
  let now = 0;
  const { dispatchFn, calls } = makeDispatchStub();
  const { readTranscriptFn } = makeTranscriptStub(new Map([
    [`run_stub_${heldLane.id}`, makeTranscript(`run_stub_${heldLane.id}`, { finalText: "Q1: 意见\n" })],
    ["run_stub_seat_b", makeTranscript("run_stub_seat_b", { finalText: "Q1: 意见\n" })],
  ]));
  const result = await runConsult(baseInput({
    seats: [{ agentId: heldLane.id }, { agentId: "seat_b" }],
    dispatchFn,
    readTranscriptFn,
    nowFn: () => now,
    sleepFn: async (ms) => { now += ms; },
    pollIntervalMs: 600000,
    writeFileFn: async () => {},
    mkdirFn: async () => {},
    lanesDocFn: () => lanesDoc,
    advisorySink: (line) => advisories.push(line),
  }));
  assert.equal(calls.length, 2, "两席都照常派发（advisory 不拦截）");
  assert.equal(result.seats.filter((s) => s.runState === "completed").length, 2, "派发照常完成");
  assert.equal(advisories.length, 1, "恰一行（只有带说明的席位）");
  assert.ok(advisories[0].startsWith(`[wao] advisory: lane ${heldLane.id} dispatchHold=`), "advisory 行形制同资源计数行");
  assert.ok(advisories[0].includes(laneDispatchHold(lanesDoc, heldLane.id)), "夹具说明原文入行");
  assert.ok(advisories[0].includes("照常进行"), "文案明示派发照常进行");
});

test("TD-283 consult run：默认注册表 → 服务拿到车道表；非默认 --registry → 停用的空表", async () => {
  const { laneDispatchHold } = await import("../../src/dispatchResolution.js");
  const lanesDoc = {
    ok: true, path: "fixture", sha256: "ab".repeat(32), issues: [], rolesHint: [],
    lanes: [{ id: "held-lane", backend: "claude-code", model: { id: "fixture-m" }, reasoning: null, aliases: {}, dispatchHold: "夹具：暂停说明" }],
  };
  const seen = [];
  const deps = { runConsult: async (input) => { seen.push(input.lanesDocFn()); return craftedResult(); } };
  const config = { registry: "C:/wao/config/agents.json", lanesDocFn: () => lanesDoc };
  await consultCommand(["run", "brief.md", "--seats", "a", "--cwd", "C:/tmp/x"], config, deps);
  await consultCommand(["run", "brief.md", "--seats", "a", "--cwd", "C:/tmp/x", "--registry", "C:/elsewhere/agents.json"], config, deps);
  assert.equal(seen[0], lanesDoc, "默认注册表 → 车道表");
  assert.equal(laneDispatchHold(seen[1], "held-lane"), null, "非默认注册表 → 停用的空表");
});

test("会审的身份事实与席位派发共用同一张车道表：别名两边一致解析；停用的空表下两边都不解析", async () => {
  const laneEntry = { id: "lane-a", backend: "claude-code", cwd: ".", model: { id: "fixture-m" } };
  const registryReadFn = async () => ({
    getAgent: (id) => { if (id === "lane-a") return laneEntry; throw new Error(`Unknown agent: ${id}`); },
    listAgents: () => [laneEntry],
  });
  const aliasTable = {
    ok: true, path: "fixture", sha256: "ab".repeat(32), issues: [], rolesHint: ["coder"],
    lanes: [{ id: "lane-a", backend: "claude-code", model: { id: "fixture-m" }, reasoning: null, aliases: { "alias-seat": { role: "coder" } } }],
  };
  const inactiveTable = { lanes: [], sha256: null, issues: [], rolesHint: [] };
  for (const [name, table, expectTarget, expectBackend] of [
    ["别名表", aliasTable, "lane-a", "claude-code"],
    ["停用的空表", inactiveTable, "alias-seat", null],
  ]) {
    const { dispatchFn, calls } = makeDispatchStub();
    const result = await runConsult(baseInput({
      seats: [{ agentId: "alias-seat" }],
      registryReadFn,
      dispatchFn,
      readTranscriptFn: makeTranscriptStub(new Map()).readTranscriptFn,
      pollIntervalMs: 600000,
      writeFileFn: async () => {},
      mkdirFn: async () => {},
      lanesDocFn: () => table,
    }));
    assert.equal(calls[0].agentId, expectTarget, `${name}：派发目标`);
    assert.equal(result.record.seats[0].backend, expectBackend, `${name}：组记录的 backend 与派发目标同源`);
  }
});

test("会审：注册表键与车道别名同名时，组记录与派发都按别名优先（同一次解析）", async () => {
  const laneEntry = { id: "lane-a", backend: "claude-code", cwd: ".", model: { id: "fixture-m" } };
  const sameName = { id: "alias-seat", backend: "codex", cwd: ".", model: { id: "other-m" } };
  const registryReadFn = async () => ({
    getAgent: (id) => {
      if (id === "lane-a") return laneEntry;
      if (id === "alias-seat") return sameName;
      throw new Error(`Unknown agent: ${id}`);
    },
    listAgents: () => [laneEntry, sameName],
  });
  const aliasTable = {
    ok: true, path: "fixture", sha256: "ab".repeat(32), issues: [], rolesHint: ["coder"],
    lanes: [{ id: "lane-a", backend: "claude-code", model: { id: "fixture-m" }, reasoning: null, aliases: { "alias-seat": { role: "coder" } } }],
  };
  const { dispatchFn, calls } = makeDispatchStub();
  const result = await runConsult(baseInput({
    seats: [{ agentId: "alias-seat" }],
    registryReadFn,
    dispatchFn,
    readTranscriptFn: makeTranscriptStub(new Map()).readTranscriptFn,
    pollIntervalMs: 600000,
    writeFileFn: async () => {},
    mkdirFn: async () => {},
    lanesDocFn: () => aliasTable,
  }));
  assert.equal(calls[0].agentId, "lane-a", "别名优先：派发车道键");
  assert.equal(result.record.seats[0].backend, "claude-code", "组记录与派发目标同源，不取同名注册表条目");
});

// ═══════════════════════════════════════════════════════════════════════════
// 决定 0096：consult 三条 CLI 命令在有未终态席位时给 nextStep（文本末尾一行 /
// JSON 一个字段）；consult wait 的 stderr 不再另说"run consult wait again"。
// ═══════════════════════════════════════════════════════════════════════════

function runningCraftedResult() {
  const result = craftedResult();
  result.seats[1] = { ...result.seats[1], runState: "running", finalText: "" };
  return result;
}

async function captureConsult(fn) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => err.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { out: out.join("\n"), err: err.join("\n"), outLines: out, errLines: err };
}

test("CLI-8: consult run 有未终态席位 → 文本末尾 Next step 行 / JSON nextStep 字段；全终态不带", async () => {
  const result = runningCraftedResult();
  const deps = { runConsult: async () => result };
  const config = {
    registry: join(tmpdir(), "wao-consult-cli8", "agents.json"),
    runDir: join(tmpdir(), "wao-consult-cli8", "runs"),
  };
  const text = await captureConsult(() => consultCommand(
    ["run", "brief.md", "--seats", "a,b", "--cwd", "C:/tmp/x"], config, deps,
  ));
  assert.equal(text.outLines.at(-1),
    "Next step: Seats not terminal yet: run_b. Before ending the turn, attach: "
    + "wao consult wait consult_20261002120000000abc123 --until-settled (in the background if your host notifies you when background "
    + "commands finish; otherwise in the foreground), then re-read with wao consult show "
    + "consult_20261002120000000abc123.");

  const json = await captureConsult(() => consultCommand(
    ["run", "brief.md", "--seats", "a,b", "--format", "json", "--cwd", "C:/tmp/x"], config, deps,
  ));
  const parsed = JSON.parse(json.out);
  assert.equal(typeof parsed.nextStep, "string");
  assert.match(parsed.nextStep, /^Seats not terminal yet: run_b\./);
  assert.equal(parsed.seats[1].finalText, "", "JSON 仍带每席完整字段（nextStep 只加不换）");

  // 全部终态：不带该行/字段（craftedResult 的席位都是 completed）。
  const settledText = await captureConsult(() => consultCommand(
    ["run", "brief.md", "--seats", "a,b", "--cwd", "C:/tmp/x"], config,
    { runConsult: async () => craftedResult() },
  ));
  assert.ok(!settledText.outLines.some((l) => l.startsWith("Next step: ")), "全部终态文本不带 nextStep 行");
  const settledJson = await captureConsult(() => consultCommand(
    ["run", "brief.md", "--seats", "a,b", "--format", "json", "--cwd", "C:/tmp/x"], config,
    { runConsult: async () => craftedResult() },
  ));
  assert.equal("nextStep" in JSON.parse(settledJson.out), false, "全部终态 JSON 不带 nextStep");
});

test("CLI-9: consult show 有未终态席位 → 文本末尾 Next step 行 / JSON nextStep 字段", async () => {
  const consultId = "consult_20261002120000000abc123";
  const record = {
    consultId,
    createdAt: "2026-10-02T12:00:00.000Z",
    brief: { path: null, sha256: "ab".repeat(32) },
    budgetMs: 600000,
    elapsedMs: 100,
    questions: parseBriefQuestions("## Q1 方案可行吗\n"),
    seats: [
      { agentId: "seat_a", runId: "run_show_r", runState: "running", formatState: "partial" },
      { agentId: "seat_b", runId: null, runState: "dispatch_failed", formatState: "empty" },
    ],
    fieldDiff: [],
  };
  const readTranscript = async (path) => {
    const runId = basename(path, ".jsonl");
    if (runId !== "run_show_r") throw new Error(`ENOENT stub: ${path}`);
    return makeTranscript("run_show_r", { state: "running", finalText: "Q1: 仍在核对。\n" });
  };
  const deps = { loadConsultRecord: async () => record, readTranscript };
  const text = await captureConsult(() => consultCommand(["show", consultId, "--cwd", "C:/tmp/x"], {}, deps));
  assert.equal(text.outLines.at(-1),
    "Next step: Seats not terminal yet: run_show_r. Before ending the turn, attach: "
    + `wao consult wait ${consultId} --until-settled (in the background if your host notifies you when background `
    + "commands finish; otherwise in the foreground), then re-read with wao consult show "
    + `${consultId}.`);

  const json = await captureConsult(() => consultCommand(["show", consultId, "--format", "json", "--cwd", "C:/tmp/x"], {}, deps));
  const parsed = JSON.parse(json.out);
  assert.match(parsed.nextStep, /^Seats not terminal yet: run_show_r\./);

  // 无未终态席位（missing 不算、无 runId 不算）→ 不带。
  const allSettled = {
    ...record,
    seats: [
      { agentId: "seat_a", runId: "run_show_done", runState: "completed", formatState: "structured" },
      { agentId: "seat_b", runId: "run_show_missing", runState: "missing", formatState: "empty" },
      { agentId: "seat_c", runId: null, runState: "dispatch_failed", formatState: "empty" },
    ],
  };
  const noStep = await captureConsult(() => consultCommand(["show", consultId, "--cwd", "C:/tmp/x"], {}, {
    loadConsultRecord: async () => allSettled,
    readTranscript: async (path) => (basename(path, ".jsonl") === "run_show_done"
      ? makeTranscript("run_show_done", { finalText: "Q1: 可行。\n" })
      : (() => { throw new Error("ENOENT stub"); })()),
  }));
  assert.ok(!noStep.outLines.some((l) => l.startsWith("Next step: ")), "missing/无 runId 席位不算在跑");
});

test("CLI-10: consult wait 有未终态席位 → 文本 Next step / JSON nextStep；stderr 指向这一行", async () => {
  const consultId = "consult_20261002120000000abc123";
  const record = {
    consultId,
    createdAt: "2026-10-02T12:00:00.000Z",
    brief: { path: null, sha256: "ab".repeat(32) },
    budgetMs: 600000,
    elapsedMs: 100,
    questions: parseBriefQuestions("## Q1 方案可行吗\n"),
    seats: [{ agentId: "seat_a", runId: "run_wait_r", runState: "running", formatState: "partial" }],
    fieldDiff: [],
  };
  const readTranscript = async () => makeTranscript("run_wait_r", { state: "running", finalText: "Q1: 仍在核对。\n" });
  const deps = {
    waitForConsult: async () => ({ record, allTerminal: false, waitedMs: 270000, windowMs: 270000 }),
    readTranscript,
  };
  const text = await captureConsult(() => consultCommand(["wait", consultId, "--cwd", "C:/tmp/x"], {}, deps));
  assert.equal(text.outLines.at(-1),
    "Next step: Seats not terminal yet: run_wait_r. Before ending the turn, attach: "
    + `wao consult wait ${consultId} --until-settled (in the background if your host notifies you when background `
    + "commands finish; otherwise in the foreground), then re-read with wao consult show "
    + `${consultId}.`);
  assert.match(text.err, /see the next step below/);
  assert.ok(!text.err.includes("run consult wait again"), "stderr 不再留第二套说法");

  const json = await captureConsult(() => consultCommand(["wait", consultId, "--format", "json", "--cwd", "C:/tmp/x"], {}, deps));
  const parsed = JSON.parse(json.out);
  assert.match(parsed.nextStep, /^Seats not terminal yet: run_wait_r\./);
  assert.deepEqual(parsed.wait, { allTerminal: false, waitedMs: 270000, windowMs: 270000 });
});

test("CLI-11: consult 的 nextStep 超过 480 字符时改用不列 runId 的版本（8 席）", () => {
  const consultId = "consult_20261002120000000abc123";
  const runIds = Array.from({ length: 8 }, (_, i) => `run_2026100212000000${i}consult`);
  const text = buildNextStep({
    surface: "cli", situation: "consult_seats_running", seatRunIds: runIds, consultId, cliJson: false,
  });
  assert.match(text, /^Seats not terminal yet \(listed above\)\./);
  assert.ok(!runIds.some((id) => text.includes(id)), "文本回退不列 runId");
  assert.ok(text.length <= 480);
  const json = buildNextStep({
    surface: "cli", situation: "consult_seats_running", seatRunIds: runIds, consultId, cliJson: true,
  });
  assert.match(json, /^Seats not terminal yet \(see seats\[\]\.runId\)\./);
  assert.ok(json.length <= 480);
});

test("CLI-12: consult wait 未终态席位全是 missing → stderr 不说 see the next step below，如实说明并指向 consult show", async () => {
  const consultId = "consult_20261002120000000abc123";
  const record = {
    consultId,
    createdAt: "2026-10-02T12:00:00.000Z",
    brief: { path: null, sha256: "ab".repeat(32) },
    budgetMs: 600000,
    elapsedMs: 100,
    questions: parseBriefQuestions("## Q1 方案可行吗\n"),
    seats: [{ agentId: "seat_a", runId: "run_wait_missing", runState: "running", formatState: "partial" }],
    fieldDiff: [],
  };
  // 转录读不到 → 重渲染后该席 runState=missing → selectNonTerminalSeats 不算 →
  // 没有 nextStep。
  const deps = {
    waitForConsult: async () => ({ record, allTerminal: false, waitedMs: 270000, windowMs: 270000 }),
    readTranscript: async () => { throw new Error("ENOENT stub"); },
  };
  const text = await captureConsult(() => consultCommand(["wait", consultId, "--cwd", "C:/tmp/x"], {}, deps));
  assert.ok(!text.err.includes("see the next step below"), "没有 nextStep 行时 stderr 不得指向它");
  assert.match(text.err, /before every dispatched seat was observed terminal/, "如实说窗口到期仍有席位未被观察到终态");
  assert.match(text.err, /1 seat transcript\(s\) could not be read/, "如实说席位转录读不到");
  assert.match(text.err, new RegExp(`consult show ${consultId}`), "指向 consult show");
  assert.ok(!text.outLines.some((l) => l.startsWith("Next step: ")), "stdout 没有 Next step 行");

  const json = await captureConsult(() => consultCommand(["wait", consultId, "--format", "json", "--cwd", "C:/tmp/x"], {}, deps));
  const parsed = JSON.parse(json.out);
  assert.equal("nextStep" in parsed, false, "全 missing 时 JSON 不带 nextStep");
  assert.ok(!json.err.includes("see the next step below"));
  assert.match(json.err, new RegExp(`consult show ${consultId}`));
});

test("CLI-13: consult wait 等待说未全终态、重渲染时席位已全部终态 → stderr 按重渲染结果说全部终态", async () => {
  const consultId = "consult_20261002120000000abc123";
  const record = {
    consultId,
    createdAt: "2026-10-02T12:00:00.000Z",
    brief: { path: null, sha256: "ab".repeat(32) },
    budgetMs: 600000,
    elapsedMs: 100,
    questions: parseBriefQuestions("## Q1 方案可行吗\n"),
    seats: [{ agentId: "seat_a", runId: "run_wait_late_done", runState: "running", formatState: "partial" }],
    fieldDiff: [],
  };
  // 会审复现的竞态：等待窗到期时席位还没终态，重渲染读转录时已经 completed。
  const deps = {
    waitForConsult: async () => ({ record, allTerminal: false, waitedMs: 270000, windowMs: 270000 }),
    readTranscript: async () => makeTranscript("run_wait_late_done", { finalText: "Q1: 可行。\n" }),
  };
  const text = await captureConsult(() => consultCommand(["wait", consultId, "--cwd", "C:/tmp/x"], {}, deps));
  assert.match(text.err, /every dispatched seat reached a terminal state/, "按重渲染结果说全部终态");
  assert.ok(!text.err.includes("could not be read"), "不得归咎于转录读不到");
  assert.ok(!text.err.includes("see the next step below"));
  assert.ok(!text.outLines.some((l) => l.startsWith("Next step: ")), "全部终态没有 Next step 行");
});

test("CLI-14: consult wait 等待已看到全部终态、重渲染时转录暂时读不到 → 不说窗口到期，补一句重读失败", async () => {
  const consultId = "consult_20261002120000000abc123";
  const record = {
    consultId,
    createdAt: "2026-10-02T12:00:00.000Z",
    brief: { path: null, sha256: "ab".repeat(32) },
    budgetMs: 600000,
    elapsedMs: 100,
    questions: parseBriefQuestions("## Q1 方案可行吗\n"),
    seats: [{ agentId: "seat_a", runId: "run_wait_reread_fail", runState: "completed", formatState: "structured" }],
    fieldDiff: [],
  };
  // 会审复现：等待第一次读取就见 completed 并返回，重渲染再读时暂时 EACCES。
  const deps = {
    waitForConsult: async () => ({ record, allTerminal: true, waitedMs: 0, windowMs: 270000 }),
    readTranscript: async () => { throw Object.assign(new Error("EACCES stub"), { code: "EACCES" }); },
  };
  for (const format of ["text", "json"]) {
    const args = ["wait", consultId, "--cwd", "C:/tmp/x", ...(format === "json" ? ["--format", "json"] : [])];
    const captured = await captureConsult(() => consultCommand(args, {}, deps));
    assert.match(captured.err, /every dispatched seat reached a terminal state/, `${format}: 等待已看到全部终态`);
    assert.ok(!captured.err.includes("window expired"), `${format}: 不得说窗口到期`);
    assert.match(captured.err, /1 seat transcript\(s\) could not be read/, `${format}: 补一句重读失败`);
    assert.match(captured.err, new RegExp(`consult show ${consultId}`), `${format}: 指向 consult show`);
  }
});

test("CLI-15: consult wait 有派发未成立的席位（没有 runId）→ stderr 如实计数并指向 consult show；一席都没派发就直说", async () => {
  const consultId = "consult_20261002120000000abc123";
  const base = {
    consultId,
    createdAt: "2026-10-02T12:00:00.000Z",
    brief: { path: null, sha256: "ab".repeat(32) },
    budgetMs: 600000,
    elapsedMs: 100,
    questions: parseBriefQuestions("## Q1 方案可行吗\n"),
    fieldDiff: [],
  };
  const failedSeat = { agentId: "seat_x", runId: null, runState: "dispatch_failed", formatState: "empty" };
  // 一席都没派发：waitForConsult 对空队列给 allTerminal:true，不能据此说"全部终态"。
  const none = { ...base, seats: [failedSeat] };
  const noneOut = await captureConsult(() => consultCommand(["wait", consultId, "--cwd", "C:/tmp/x"], {}, {
    waitForConsult: async () => ({ record: none, allTerminal: true, waitedMs: 0, windowMs: 270000 }),
    readTranscript: async () => [],
  }));
  assert.match(noneOut.err, /no seat was dispatched/, "零派发直说");
  assert.ok(!noneOut.err.includes("every dispatched seat reached a terminal state"), "零派发不得说全部终态");
  assert.match(noneOut.err, new RegExp(`consult show ${consultId}`));
  // 已终态 + 派发未成立：说全部终态，并计数派发未成立的席位。
  const mixed = { ...base, seats: [{ agentId: "seat_a", runId: "run_wait_mixed_done", runState: "running", formatState: "partial" }, failedSeat] };
  const mixedOut = await captureConsult(() => consultCommand(["wait", consultId, "--cwd", "C:/tmp/x"], {}, {
    waitForConsult: async () => ({ record: mixed, allTerminal: true, waitedMs: 1000, windowMs: 270000 }),
    readTranscript: async () => makeTranscript("run_wait_mixed_done", { finalText: "Q1: 可行。\n" }),
  }));
  assert.match(mixedOut.err, /every dispatched seat reached a terminal state; 1 seat\(s\) were never dispatched/);
  assert.match(mixedOut.err, new RegExp(`consult show ${consultId}`));
});
// ═══════════════════════════════════════════════════════════════════════════
// `consult wait <consultId> --until-settled`（决定 0095 收口等待器的 consult 面）
// 与 `consult show <consultId> --out-dir`。
//
// 退出码与 `runs wait --until-settled` 同义：0 全部已派发席位收口；3 一席不可信
// 轮连续 4 次（含无法收口的交付事实）或验证者已不在；4 一席转录冲突；130 中断。
// stderr 点名未收口席位。收口算法分支（轮询/不可信轮/证明/节流）由
// runsWaitUntilSettled.test.js 在 runs wait 面钉住——这里钉命令面的逐席循环、
// 退出码映射、席位点名与返回渲染。退出码经 process.exitCode 断言（保存/恢复）。
// ═══════════════════════════════════════════════════════════════════════════

/** 保存/恢复 process.exitCode 的断言包装（runsWaitUntilSettled.test.js 同纪律）。 */
async function withExitCode(fn) {
  const prev = process.exitCode;
  try {
    return await fn();
  } finally {
    process.exitCode = prev;
  }
}

function settledRecord(consultId, seats) {
  return {
    consultId,
    createdAt: "2026-10-02T12:00:00.000Z",
    brief: { path: null, sha256: "ab".repeat(32) },
    budgetMs: 600000,
    elapsedMs: 100,
    questions: parseBriefQuestions("## Q1 方案可行吗\n"),
    seats,
    fieldDiff: [],
  };
}

const SETTLED_OUTCOME = {
  kind: "settled",
  settlement: { status: "settled", reason: "no_delivery_requested", facts: { state: "completed", terminal: true } },
};

test("SETTLE-1: --until-settled 与 --wait-ms 同用被拒；布尔旗标带值也拒（含旗标写在 consultId 之前的吞词形状）", async () => {
  const consultId = "consult_20261002120000000abc123";
  await withExitCode(async () => {
    await assert.rejects(
      () => consultCommand(["wait", consultId, "--until-settled", "--wait-ms", "200000"], {}, {}),
      /--until-settled and --wait-ms are mutually exclusive/,
    );
    await assert.rejects(
      () => consultCommand(["wait", "--until-settled", consultId], {}, {}),
      /--until-settled is a boolean flag and takes no value/,
      "旗标写在 consultId 之前把位置参数吞成值——按用法错误拒绝，不猜",
    );
    await assert.rejects(
      () => consultCommand(["wait", consultId, "--until-settled", "5000"], {}, {}),
      /--until-settled is a boolean flag and takes no value/,
    );
    // 两旗标同在时先报互斥（waitMs 在场即互斥，不管 untilSettled 的形状）。
    await assert.rejects(
      () => consultCommand(["wait", consultId, "--until-settled", "--wait-ms"], {}, {}),
      /mutually exclusive/,
    );
  });
});

test("SETTLE-2: 真实等待器 + 真实终态转录——全部收口才返回，退出 0，返回输出与有界 consult wait 一致", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-consult-settle2-"));
  await withExitCode(async () => {
    const runDir = join(dir, "runs");
    const consultsDir = join(dir, ".wao", "runs", "consults");
    writeRealTranscript(runDir, "run_settle_a", makeTranscript("run_settle_a", { finalText: "Q1: A 可行。\n" }));
    writeRealTranscript(runDir, "run_settle_b", makeTranscript("run_settle_b", { state: "failed", finalText: "Q1: 有风险。\n" }));
    const consultId = "consult_20261002120000000abc123";
    writeConsultRecord(consultsDir, settledRecord(consultId, [
      { agentId: "seat_a", runId: "run_settle_a", runState: "running", formatState: "empty" },
      { agentId: "seat_b", runId: "run_settle_b", runState: "running", formatState: "empty" },
    ]));
    const captured = await captureConsult(() => consultCommand(
      ["wait", consultId, "--until-settled", "--cwd", dir, "--run-dir", runDir], {}, {},
    ));
    assert.ok(process.exitCode === undefined || process.exitCode === 0, `退出码应为 0（未设置），实际 ${process.exitCode}`);
    assert.match(captured.err, /every dispatched seat reached a terminal state after \d+s/, "stderr 摘要行与有界路径同形");
    assert.ok(!captured.err.includes("window expired"), "无界等待不说窗口到期");
    assert.ok(captured.out.includes("Q1: A 可行。"), "正常渲染在场（council-diff 文本）");
    assert.ok(captured.out.includes("run_settle_a") && captured.out.includes("run_settle_b"), "runId 回链在场");
    assert.ok(!captured.outLines.some((l) => l.startsWith("Next step: ")), "全部收口没有 nextStep 行");
    // --format json：wait 块形状与有界路径一致，windowMs=null 表示无界等待。
    const json = await captureConsult(() => consultCommand(
      ["wait", consultId, "--until-settled", "--format", "json", "--cwd", dir, "--run-dir", runDir], {}, {},
    ));
    const parsed = JSON.parse(json.out);
    assert.equal(parsed.wait.allTerminal, true);
    assert.equal(parsed.wait.windowMs, null);
    assert.ok(Number.isFinite(parsed.wait.waitedMs), "waitedMs 在场");
    assert.equal(parsed.consultId, consultId);
  }).finally(() => cleanupDir(dir));
});

test("SETTLE-3: 注入假收口判定——两席按组记录顺序逐席等，都收口才返回（无 runId 席位不等）", async () => {
  const consultId = "consult_20261002120000000abc123";
  const record = settledRecord(consultId, [
    { agentId: "seat_a", runId: "run_settle_fa", runState: "running", formatState: "empty" },
    { agentId: "seat_none", runId: null, runState: "dispatch_failed", formatState: "empty" },
    { agentId: "seat_b", runId: "run_settle_fb", runState: "running", formatState: "empty" },
  ]);
  const calls = [];
  const deps = {
    loadConsultRecord: async () => record,
    readTranscript: async (path) => makeTranscript(basename(path, ".jsonl"), { finalText: "Q1: 意见。\n" }),
    waitRunSettlement: async (input) => {
      calls.push(input.runId);
      return { ...SETTLED_OUTCOME };
    },
  };
  await withExitCode(async () => {
    const captured = await captureConsult(() => consultCommand(
      ["wait", consultId, "--until-settled", "--cwd", "C:/tmp/x"], {}, deps,
    ));
    assert.deepEqual(calls, ["run_settle_fa", "run_settle_fb"], "逐席调用共用等待器；runId=null 的席位不调");
    assert.ok(process.exitCode === undefined || process.exitCode === 0, `退出码应为 0，实际 ${process.exitCode}`);
    assert.match(captured.err, /every dispatched seat reached a terminal state/);
    assert.match(captured.err, /1 seat\(s\) were never dispatched/, "派发未成立的席位照有界路径口径计数");
  });
});

test("SETTLE-4: 一席无法收口（undeterminable）→ 退出 3 并在 stderr 点名席位；JSON 输出 settled:false + seat", async () => {
  const consultId = "consult_20261002120000000abc123";
  const record = settledRecord(consultId, [
    { agentId: "seat_a", runId: "run_settle_ok", runState: "running", formatState: "empty" },
    { agentId: "seat_bad", runId: "run_settle_bad", runState: "running", formatState: "empty" },
  ]);
  const deps = {
    loadConsultRecord: async () => record,
    readTranscript: async (path) => makeTranscript(basename(path, ".jsonl"), { finalText: "Q1: 意见。\n" }),
    waitRunSettlement: async ({ runId }) => (runId === "run_settle_ok" ? { ...SETTLED_OUTCOME } : {
      kind: "untrusted",
      reason: "undeterminable:terminal_delivery_ambiguous",
      rounds: 4,
      settlement: { status: "undeterminable", reason: "terminal_delivery_ambiguous", facts: { state: "failed", terminal: true } },
    }),
  };
  await withExitCode(async () => {
    const captured = await captureConsult(() => consultCommand(
      ["wait", consultId, "--until-settled", "--cwd", "C:/tmp/x"], {}, deps,
    ));
    assert.equal(process.exitCode, 3, "undeterminable 对应 runs wait 的退出码 3");
    assert.match(captured.err, new RegExp(`\\[consult\\] ${consultId}: seat seat_bad \\(run_settle_bad\\) will not settle:`), "stderr 点名席位");
    assert.match(captured.err, /Undeterminable: the delivery facts cannot settle \(terminal_delivery_ambiguous\); waiting will not change them\./, "与 runs wait 同义的处置行");
    assert.match(captured.err, /Diagnostics: wao runs diagnose run_settle_bad; delivery facts: wao runs delivery run_settle_bad/);
    assert.ok(!captured.out.includes("council-diff"), "失败出口不做整场渲染");
    assert.ok(!captured.outLines.some((l) => l.startsWith("Next step: ")));
  });
  await withExitCode(async () => {
    const json = await captureConsult(() => consultCommand(
      ["wait", consultId, "--until-settled", "--format", "json", "--cwd", "C:/tmp/x"], {}, deps,
    ));
    assert.equal(process.exitCode, 3);
    const parsed = JSON.parse(json.out);
    assert.equal(parsed.settled, false);
    assert.deepEqual(parsed.seat, { agentId: "seat_bad", runId: "run_settle_bad" });
    assert.equal(parsed.reason, "undeterminable:terminal_delivery_ambiguous");
    assert.equal(parsed.state, "failed");
  });
});

test("SETTLE-5: 一席转录冲突 → 退出 4 并点名席位；verifier_gone → 退出 3 并带 Stuck 行", async () => {
  const consultId = "consult_20261002120000000abc123";
  const record = settledRecord(consultId, [
    { agentId: "seat_x", runId: "run_settle_conflict", runState: "running", formatState: "empty" },
  ]);
  const transcript = async (path) => makeTranscript(basename(path, ".jsonl"), { finalText: "Q1: 意见。\n" });
  await withExitCode(async () => {
    const captured = await captureConsult(() => consultCommand(
      ["wait", consultId, "--until-settled", "--cwd", "C:/tmp/x"], {}, {
        loadConsultRecord: async () => record,
        readTranscript: transcript,
        waitRunSettlement: async () => ({
          kind: "conflict",
          settlement: { status: "undeterminable", reason: "packaging_conflict", facts: { state: "completed", terminal: true } },
        }),
      },
    ));
    assert.equal(process.exitCode, 4, "冲突对应 runs wait 的退出码 4");
    assert.match(captured.err, /seat seat_x \(run_settle_conflict\) will not settle:/, "点名席位");
    assert.match(captured.err, /Conflict: run_settle_conflict has multiple distinct transcript copies/);
  });
  await withExitCode(async () => {
    const stuck = await captureConsult(() => consultCommand(
      ["wait", consultId, "--until-settled", "--cwd", "C:/tmp/x"], {}, {
        loadConsultRecord: async () => record,
        readTranscript: transcript,
        waitRunSettlement: async () => ({
          kind: "verifier_gone",
          basis: "lease_missing",
          settlement: { status: "unsettled", reason: "verification_pending", facts: { state: "completed", terminal: true, acceptanceStatus: "pending" } },
        }),
      },
    ));
    assert.equal(process.exitCode, 3, "verifier_gone 对应 runs wait 的退出码 3");
    assert.match(stuck.err, /Stuck: the verification of run_settle_conflict has no outcome and no WAO process that could finish it remains \(lease_missing\)/);
    assert.match(stuck.err, /Next step: Its verification will not finish\./, "带 runs wait 同源的 verifier_gone nextStep");
  });
});

test("SETTLE-5b: runner_gone（注入等待器）→ 退出 3、stderr 三行与 runs wait 逐字一致；JSON 带 reason+runnerStderrTail；等待器收到 runnerGoneProof: true", async () => {
  const consultId = "consult_20261002120000000abc123";
  const record = settledRecord(consultId, [
    { agentId: "seat_r", runId: "run_settle_rg", runState: "running", formatState: "empty" },
  ]);
  // stderr 尾部走真实 runnerStderrTailText（run-dir 指向没有 stderr 文件的临时
  // 目录 → "无 runner stderr 记录"——固定文案，不伪造空证据）。
  const runDir = mkdtempSync(join(tmpdir(), "wao-consult-settle5b-"));
  const seen = [];
  const deps = {
    loadConsultRecord: async () => record,
    readTranscript: async (path) => makeTranscript(basename(path, ".jsonl"), { finalText: "Q1: 意见。\n" }),
    waitRunSettlement: async (input) => {
      seen.push(input);
      return {
        kind: "runner_gone",
        settlement: { status: "unsettled", reason: "not_terminal", facts: { state: "running", terminal: false } },
      };
    },
  };
  try {
    await withExitCode(async () => {
      const captured = await captureConsult(() => consultCommand(
        ["wait", consultId, "--until-settled", "--cwd", "C:/tmp/x", "--run-dir", runDir], {}, deps,
      ));
      assert.equal(process.exitCode, 3, "runner_gone 对应 runs wait 的退出码 3");
      assert.equal(seen.length, 1);
      assert.equal(seen[0].runnerGoneProof, true, "等待器收到 runnerGoneProof: true");
      assert.equal(seen[0].runId, "run_settle_rg");
      assert.equal(seen[0].runDir, runDir);
      // stderr 四行：点名行 + 与 runs wait runner_gone 出口逐字一致的三行。
      assert.deepEqual(captured.errLines, [
        `[consult] ${consultId}: seat seat_r (run_settle_rg) will not settle:`,
        "Stuck: the runner of run_settle_rg is gone (no live owner heartbeat, no process that could still drive it); waiting will not change this.",
        `Runner stderr tail: 无 runner stderr 记录`,
        `Next step: ${buildNextStep({ surface: "cli", situation: "runner_gone", runId: "run_settle_rg" })}`,
      ]);
      assert.ok(!captured.outLines.some((l) => l.startsWith("Next step: ")), "失败出口不渲染整场");
    });
    await withExitCode(async () => {
      const json = await captureConsult(() => consultCommand(
        ["wait", consultId, "--until-settled", "--format", "json", "--cwd", "C:/tmp/x", "--run-dir", runDir], {}, deps,
      ));
      assert.equal(process.exitCode, 3);
      const parsed = JSON.parse(json.out);
      assert.equal(parsed.settled, false);
      assert.deepEqual(parsed.seat, { agentId: "seat_r", runId: "run_settle_rg" });
      assert.equal(parsed.reason, "runner_gone");
      assert.equal(parsed.runnerStderrTail, "无 runner stderr 记录", "JSON 面同一段尾部文本");
      assert.equal(seen.length, 2, "JSON 路径同样带 runnerGoneProof: true");
      assert.equal(seen[1].runnerGoneProof, true);
    });
  } finally {
    cleanupDir(runDir);
  }
});

test("SETTLE-5c: runner_gone（真实等待器 + runnerGoneFn 桩，零真实进程扫描）→ 退出 3、stderr 尾部读真实文件", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-consult-settle5c-"));
  const consultId = "consult_20261002120000000abc123";
  const runId = "run_settle_real";
  const runDir = join(dir, "runs");
  const consultsDir = join(dir, ".wao", "runs", "consults");
  // 非终态安静运行：事件 ts 固定在 QUIET_TS（距注入 now 1 小时 > 15 分钟静默窗）。
  const quietTs = "2026-09-01T00:00:00.000Z";
  writeRealTranscript(runDir, runId, [
    { type: "run.started", worktreePath: "C:\\fake\\wt", runId, ts: quietTs },
    { type: "run.background_submitted", runId, agentId: "coder_low", background: true, ts: quietTs },
  ]);
  writeFileSync(join(runDir, `.runner-${runId}.stderr`), "FATAL: heap OOM\n", "utf8");
  writeConsultRecord(consultsDir, settledRecord(consultId, [
    { agentId: "seat_r", runId, runState: "running", formatState: "empty" },
  ]));
  // 前置筛选的心跳读器全桩（无租约文件）；证明本体打桩——不跑真实进程扫描。
  let proofCalls = 0;
  const deps = {
    nowFn: () => Date.parse("2026-09-01T01:00:00.000Z"),
    runnerGoneFn: async () => { proofCalls += 1; return { gone: true }; },
    runnerProofDeps: { heartbeatReader: () => ({ present: false, fresh: false }) },
  };
  try {
    await withExitCode(async () => {
      const captured = await captureConsult(() => consultCommand(
        ["wait", consultId, "--until-settled", "--cwd", dir, "--run-dir", runDir], {}, deps,
      ));
      assert.equal(process.exitCode, 3, "证明成立且重读仍非终态 → 退出 3");
      assert.equal(proofCalls, 1, "证明恰一次（第一轮即成立）");
      assert.deepEqual(captured.errLines, [
        `[consult] ${consultId}: seat seat_r (${runId}) will not settle:`,
        `Stuck: the runner of ${runId} is gone (no live owner heartbeat, no process that could still drive it); waiting will not change this.`,
        "Runner stderr tail: FATAL: heap OOM",
        `Next step: ${buildNextStep({ surface: "cli", situation: "runner_gone", runId })}`,
      ]);
    });
  } finally {
    cleanupDir(dir);
  }
});

test("SETTLE-6: 中断（等待器返回 interrupted）→ 退出 130 并点名当席；零派发记录不等待、直说 no seat was dispatched", async () => {
  const consultId = "consult_20261002120000000abc123";
  const record = settledRecord(consultId, [
    { agentId: "seat_i", runId: "run_settle_i", runState: "running", formatState: "empty" },
  ]);
  await withExitCode(async () => {
    const captured = await captureConsult(() => consultCommand(
      ["wait", consultId, "--until-settled", "--cwd", "C:/tmp/x"], {}, {
        loadConsultRecord: async () => record,
        readTranscript: async (path) => makeTranscript(basename(path, ".jsonl"), { finalText: "Q1: 意见。\n" }),
        waitRunSettlement: async () => ({ kind: "interrupted", settlement: null, snapshotReadAt: null }),
      },
    ));
    assert.equal(process.exitCode, 130);
    assert.match(captured.err, /interrupted before seat seat_i \(run_settle_i\) settled/);
    assert.equal(captured.out, "", "中断出口不渲染整场");
  });
  await withExitCode(async () => {
    const asJson = await captureConsult(() => consultCommand(
      ["wait", consultId, "--until-settled", "--format", "json", "--cwd", "C:/tmp/x"], {}, {
        loadConsultRecord: async () => record,
        readTranscript: async (path) => makeTranscript(basename(path, ".jsonl"), { finalText: "Q1: 意见。\n" }),
        waitRunSettlement: async () => {
          // 冲突与中断同轮：中断压过冲突，退出 130。
          process.emit("SIGINT");
          return { kind: "conflict", settlement: null, snapshotReadAt: null };
        },
      },
    ));
    assert.equal(process.exitCode, 130);
    const parsed = JSON.parse(asJson.out);
    assert.equal(parsed.interrupted, true);
    assert.equal(parsed.settled, false);
    assert.deepEqual(parsed.seat, { agentId: "seat_i", runId: "run_settle_i" });
  });
  await withExitCode(async () => {
    const none = await captureConsult(() => consultCommand(
      ["wait", consultId, "--until-settled", "--cwd", "C:/tmp/x"], {}, {
        loadConsultRecord: async () => settledRecord(consultId, [
          { agentId: "seat_none", runId: null, runState: "dispatch_failed", formatState: "empty" },
        ]),
        readTranscript: async () => { throw new Error("should not read"); },
        waitRunSettlement: async () => { throw new Error("no dispatched seat — the waiter must not be called"); },
      },
    ));
    assert.ok(process.exitCode === undefined || process.exitCode === 0, "无可等席位不是失败");
    assert.match(none.err, /no seat was dispatched/);
  });
});

test("SETTLE-7: --out-dir 为每个席位写完整终稿（目录不存在就建），每席一行同 --seat --out；与 --seat / --out 互斥", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-consult-outdir-"));
  try {
    const runDir = join(dir, "runs");
    const consultsDir = join(dir, ".wao", "runs", "consults");
    const longText = `Q1: 采纳 A\n${"席位完整终稿，逐字节不截断。".repeat(600)}\n`;
    assert.ok(longText.length > 4000, "测试前提：正文超过 4000 字符");
    writeRealTranscript(runDir, "run_out_dir_a", makeTranscript("run_out_dir_a", { finalText: longText }));
    // seat_none 派发未成立（无 run、无终稿）——照实写空文件，不跳过。
    const consultId = "consult_20261002120000000abc123";
    writeConsultRecord(consultsDir, settledRecord(consultId, [
      { agentId: "seat_a", runId: "run_out_dir_a", runState: "completed", formatState: "structured" },
      { agentId: "seat_none", runId: null, runState: "dispatch_failed", formatState: "empty" },
    ]));
    const outDir = join(dir, "nested", "final");
    const lines = [];
    const origLog = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try {
      await consultCommand(
        ["show", consultId, "--out-dir", outDir, "--cwd", dir, "--run-dir", runDir],
        {},
      );
    } finally {
      console.log = origLog;
    }
    assert.equal(lines.length, 2, "每席恰一行");
    assert.equal(readFileSync(join(outDir, "seat_a.md"), "utf8"), longText, "文件=该席完整终稿（零截断）");
    assert.equal(readFileSync(join(outDir, "seat_none.md"), "utf8"), "", "无终稿席位写空文件");
    assert.ok(lines[0].includes(`): ${longText.length} chars written to ${join(outDir, "seat_a.md")}`), "行格式同 --seat --out（字符数 + 路径）");
    assert.ok(lines[1].includes("seat_none (no run · dispatch_failed): 0 chars written to"), "无 run 席位照实报行");
    // 互斥：与 --seat、与 --out 同用都拒；缺目录路径值也拒。
    await assert.rejects(
      () => consultCommand(["show", consultId, "--seat", "seat_a", "--out-dir", outDir, "--cwd", dir, "--run-dir", runDir], {}),
      /--out-dir cannot be combined with --seat/,
    );
    await assert.rejects(
      () => consultCommand(["show", consultId, "--out", join(dir, "x.md"), "--out-dir", outDir, "--cwd", dir, "--run-dir", runDir], {}),
      /--out-dir cannot be combined with --out/,
    );
    await assert.rejects(
      () => consultCommand(["show", consultId, "--out-dir", "--format", "json", "--cwd", dir, "--run-dir", runDir], {}),
      /--out-dir requires a directory path/,
    );
  } finally {
    cleanupDir(dir);
  }
});
