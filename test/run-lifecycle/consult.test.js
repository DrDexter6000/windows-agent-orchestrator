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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

import {
  parseBriefQuestions,
  attributeReply,
  compareFields,
  deriveSeatStates,
  seatRuntimeFacts,
  runConsult,
  generateConsultId,
  isValidConsultId,
} from "../../src/application/consultService.js";
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

/** transcript 事件桩：state_change + assistant 终稿。 */
function makeTranscript(runId, { state = "completed", finalText = "" } = {}) {
  const events = [{ type: "run.state_change", to: state, reason: "stub", runId, seq: 1 }];
  if (finalText.length > 0) {
    events.push({ type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: finalText }], runId, seq: 2 });
  }
  return events;
}

/**
 * registry 读取桩——必须是**函数形**（与 readRegistry(path) 同参返形状：
 * 接收路径、返回带 getAgent 的 registry 对象）。r1 曾把 registry 对象本身
 * 当读取函数传入，service 的 try/catch 静默降级 null 而 r1 无断言揭穿；
 * BRICK-1 的原始字段断言钉住这一形状。
 * 席位形状覆盖：seat_a 走 wrapper 形（provider.baseUrl，无 model.providerID）、
 * seat_b 走裸 backend 形（无 provider 块）。
 */
function stubRegistryRead() {
  return async () => ({
    getAgent: (id) => (id === "seat_b"
      ? { backend: "codex", cwd: ".", model: { id: `model-${id}` } }
      : {
        backend: "claude-code",
        cwd: ".",
        provider: { protocol: "anthropic-compatible", baseUrl: "https://stub.example/api/anthropic", apiKeyEnv: "STUB_KEY" },
        model: { id: `model-${id}` },
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
    assert.equal(writePaths.length, 1);
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
  const CONTRACT_MARK = "---\n【会审席边界（固定合同，席位级）】";
  for (const c of calls) {
    assert.ok(c.prompt.includes(CONTRACT_MARK), "每席 prompt 都带固定会审合同");
    assert.equal(c.prompt.indexOf(CONTRACT_MARK), c.prompt.lastIndexOf(CONTRACT_MARK), "合同恰一次");
    assert.ok(c.prompt.startsWith(briefText), "brief 逐字节内核在前");
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
  assert.equal(a.backend, "claude-code", "backend 原始字符串直读");
  assert.equal(a.provider, "https://stub.example/api/anthropic", "provider 原始标识（wrapper 形=provider.baseUrl）直读");
  const b = result.seats.find((s) => s.agentId === "seat_b");
  assert.equal(b.backend, "codex");
  assert.equal(b.provider, null, "无 provider 块如实 null——不猜不归类");
  // 0045 W4c：runtimeFacts 增 registryResolution（"ok"|"failed"|"registry-unreadable"）
  // ——解析失败不再静默吞成与"确无 provider"同形的 null。
  assert.deepEqual(result.bricks.runtimeFacts, [
    { agentId: "seat_a", backend: "claude-code", provider: "https://stub.example/api/anthropic", registryResolution: "ok" },
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

test("BRICK-2: seatRuntimeFacts 纯函数——model.providerID 优先于 provider.baseUrl；缺形状如实 null", () => {
  assert.deepEqual(
    seatRuntimeFacts({ backend: "zcode", model: { id: "zhipu/glm-5.3", providerID: "zhipu" }, provider: { baseUrl: "https://other.example" } }),
    { backend: "zcode", provider: "zhipu" },
    "zcode 形 providerID 是首选原始标识",
  );
  assert.deepEqual(
    seatRuntimeFacts({ backend: "claude-code", provider: { protocol: "anthropic-compatible", baseUrl: "https://open.bigmodel.cn/api/anthropic", apiKeyEnv: "X_KEY" } }),
    { backend: "claude-code", provider: "https://open.bigmodel.cn/api/anthropic" },
    "wrapper 形取 provider.baseUrl——该形状下唯一可区分提供方的原始字段",
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
        backend: "claude-code", provider: "https://open.bigmodel.cn/api/anthropic", budgetExpired: false,
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
        { agentId: "seat_a", backend: "claude-code", provider: "https://open.bigmodel.cn/api/anthropic" },
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
  assert.ok(text.includes("seat_a=claude-code @ https://open.bigmodel.cn/api/anthropic"), "厂族砖 backend/provider 原始值在场");
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
      seats: [{ agentId: "seat_a", runId: "run_show_a", runState: "completed", formatState: "structured", backend: "claude-code", provider: "https://open.bigmodel.cn/api/anthropic" }],
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
