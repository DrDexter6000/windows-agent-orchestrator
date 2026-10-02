// test/mcp-surface/mcpRunConsult.test.js
//
// M13-r2 (decision 0039) — the `run_consult` MCP tool: multi-seat read-only
// council consult on the Agent Union MCP face.
//
// Contracts under test (task book M13-r2 + 0039 v0.2):
//   A — create mode end-to-end: fan-out via the server's dispatch seam is
//       READ-ONLY per seat (readOnly:true + inline brief kernel + perspective
//       tail); the council-diff snapshot carries each seat's FULL original
//       text (zero truncation — one seat's reply exceeds the 4000-char compact
//       cap on purpose); fieldDiff is marker-only (no conclusion words).
//   B — bounded-wait semantics: waitMs=0 is valid (immediate point-in-time
//       snapshot); expiry is an OBSERVATION CUTOFF ONLY — a non-terminal seat
//       stays truthfully running with budgetExpired:true and the dispatch
//       count NEVER grows (no re-send, 0039 invariant ③); a missing
//       transcript observes "missing"; a failed dispatch degrades to
//       dispatch_failed without breaking the other seats (partial success).
//   C — read mode: consultId re-renders the stored group record with ZERO
//       dispatch (MCP-layer invariant — the dispatch seam count stays 0).
//   D — closed-set input: mode mutual exclusion (fixed text), per-seat
//       registry existence naming the missing seats, duplicate-seat and
//       stray-perspective refusals, waitMs schema bounds — every refusal
//       leaves the dispatch count at 0.
//   E — surface truth: run_consult is on tools/list (registered between
//       run_dispatch_contract_check and run_continue), carries dispatch-family
//       annotations, description semantic guards, and is NOT a drilldown
//       carrier (advisory action tool, not an observation tool).
//
// All filesystem state is tmpdir-anchored (staticRunsGuard discipline): git
// repo + registry + runDir + consultsDir under mkdtempSync; dispatch is a
// stub through the server's injectable dispatchRunFn seam; transcripts are
// real files the service re-reads through the real readTranscript.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { isValidConsultId } from "../../src/application/consultService.js";
import { DRILLDOWN_TOOLS } from "../../src/application/runDrilldowns.js";

// ---- harness ----

function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email t@t.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name t", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n", "utf8");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m init", { cwd: dir, stdio: "pipe" });
}

/** 席位注册表：seat_a wrapper 形（provider.baseUrl），seat_b 裸 backend 形。 */
function makeRegistry(dir) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({
    agents: {
      seat_a: {
        backend: "claude-code",
        cwd: dir,
        provider: { protocol: "anthropic-compatible", baseUrl: "https://stub.example/api/anthropic", apiKeyEnv: "STUB_KEY" },
        model: { id: "model-seat_a" },
      },
      seat_b: { backend: "codex", cwd: dir, model: { id: "model-seat_b" } },
    },
  }), "utf8");
  return registryPath;
}

/** transcript 事件（与 r1 consult 套件同一桩形状：state_change + assistant 终稿）。 */
function makeTranscript(runId, { state = "completed", finalText = "" } = {}) {
  const events = [{ type: "run.state_change", to: state, reason: "stub", runId, seq: 1 }];
  if (finalText.length > 0) {
    events.push({ type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: finalText }], runId, seq: 2 });
  }
  return events;
}

function writeTranscript(runDir, runId, events) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, `${runId}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

/**
 * 建一套 server+client。dispatch 桩经 dispatchRunFn 注入 seam 记录每次调用
 * （扇出与零派发断言的事实源）；runId 形状确定性（run_consult_stub_<agentId>）
 * 以便预置 transcript 文件。
 */
async function buildConsultClient({ dir, registryPath, runDir, consultsDir, failSeat } = {}) {
  const { createWaoMcpServer } = await import("../../src/mcp/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const dispatchCalls = [];
  const server = createWaoMcpServer({
    registryPath,
    runDir,
    workspaceRoot: dir,
    consultsDir,
    dispatchRunFn: async (input) => {
      dispatchCalls.push(input);
      if (failSeat && input.agentId === failSeat) {
        throw new Error("stub dispatch failure");
      }
      return { accepted: true, runId: `run_consult_stub_${input.agentId}`, state: "pending" };
    },
  });
  const client = new Client({ name: "wao-consult-test", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { server, client, dispatchCalls };
}

/** callTool 包装：SDK 层输入校验拒绝会 throw——如实记 threw，不吞。 */
async function callConsult(client, args) {
  try {
    return { threw: false, res: await client.callTool({ name: "run_consult", arguments: args }) };
  } catch (e) {
    return { threw: true, res: null, err: e };
  }
}

function errText(res) {
  return (res?.content ?? []).map((c) => c.text || "").join(" ");
}

const BRIEF = "会审任务书\n\n## Q1 方案可行吗\n\nQ2: 首选哪个\n";

// =====================================================================
// A — create mode end-to-end
// =====================================================================

test("MRC-A1: create mode fans out read-only per-seat runs and returns a zero-truncation council-diff snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mrc-a1-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir);
    const runDir = join(dir, "runs");
    const consultsDir = join(dir, ".wao", "runs", "consults");
    // seat_a：结构化回复，长度 > 4000（超过 compact 路径的截断上限——零截断证明）。
    const longBody = "理由是成本可控。".repeat(520);
    const seatAText = `Q1: 采纳 A\n${longBody}\n\nQ2: 选 B\n风险可控。\n`;
    assert.ok(seatAText.length > 4000, "测试前提：seat_a 回复超过 4000 字");
    writeTranscript(runDir, "run_consult_stub_seat_a", makeTranscript("run_consult_stub_seat_a", { finalText: seatAText }));
    writeTranscript(runDir, "run_consult_stub_seat_b", makeTranscript("run_consult_stub_seat_b", { finalText: "Q1: 采纳 B\n\nQ2: 选 A\n" }));
    const { server, client, dispatchCalls } = await buildConsultClient({ dir, registryPath, runDir, consultsDir });
    try {
      const { res, threw } = await callConsult(client, {
        brief: BRIEF,
        seats: ["seat_a", "seat_b"],
        perspectives: [{ agentId: "seat_a", text: "你是成本视角：先自测预算是否闭合。" }],
        fields: { Q1: ["A", "B"] },
        waitMs: 0,
      });
      assert.equal(threw, false, "create mode call succeeds");
      assert.notEqual(res.isError, true, `create mode is not an error: ${errText(res)}`);

      // 扇出：每席恰好一次、只读、内联 brief 内核 + 视角尾巴。
      assert.equal(dispatchCalls.length, 2, "one dispatch per seat");
      const aCall = dispatchCalls.find((c) => c.agentId === "seat_a");
      const bCall = dispatchCalls.find((c) => c.agentId === "seat_b");
      assert.ok(aCall && bCall, "both seats dispatched");
      assert.equal(aCall.readOnly, true, "seat_a sub-run is read-only");
      assert.equal(bCall.readOnly, true, "seat_b sub-run is read-only");
      assert.equal(aCall.prompt, `${BRIEF}\n\n你是成本视角：先自测预算是否闭合。`, "brief 逐字节 + 视角尾巴");
      assert.equal(bCall.prompt, BRIEF, "无视角席 = 纯 brief 内核");

      const p = res.structuredContent;
      assert.ok(isValidConsultId(p.consultId), `consultId 形状：${p.consultId}`);
      assert.equal(p.recordPath, join(consultsDir, `${p.consultId}.json`));
      assert.ok(existsSync(p.recordPath), "组记录落盘");
      const record = JSON.parse(readFileSync(p.recordPath, "utf8"));
      assert.equal(record.consultId, p.consultId);
      const mapping = Object.fromEntries(record.seats.map((s) => [s.agentId, s.runId]));
      assert.equal(mapping.seat_a, "run_consult_stub_seat_a");
      assert.equal(mapping.seat_b, "run_consult_stub_seat_b");

      // 零截断快照：每席完整原文在场（seat_a > 4000 字逐字节）。
      const seatA = p.seats.find((s) => s.agentId === "seat_a");
      const seatB = p.seats.find((s) => s.agentId === "seat_b");
      assert.equal(seatA.finalText, seatAText, "seat_a 完整原文逐字节（>4000 字）");
      assert.equal(seatA.attribution.ordered.length, 2, "seat_a 双问归组");
      assert.equal(seatA.formatState, "structured");
      assert.equal(seatA.runState, "completed");
      assert.equal(seatA.budgetExpired, false);
      // 归组零损失（0039 ①）：三块拼接 === 原文。
      const rebuilt = seatA.attribution.preamble
        + seatA.attribution.ordered.map((e) => e.text).join("")
        + seatA.attribution.unclassified;
      assert.equal(rebuilt, seatAText, "MCP 快照归组零信息损失");
      assert.equal(seatA.perspectiveSnippet, "你是成本视角：先自测预算是否闭合。", "视角片段进快照");
      assert.equal(seatB.formatState, "structured");

      // 标记即提示（0039 ②）：fieldDiff 只报 Qn；值并列；无结论词。
      assert.deepEqual(p.fieldDiff, ["Q1"]);
      assert.deepEqual(p.fieldValues.Q1, { seat_a: "A", seat_b: "B" });
      const serialized = JSON.stringify(p);
      for (const word of ["agree", "disagree", "一致", "分歧"]) {
        assert.ok(!serialized.includes(word), `快照不得携带结论词：${word}`);
      }

      // 三块砖①厂族：registry 原始字段直读（wrapper 形 provider.baseUrl）。
      assert.equal(p.bricks.runtimeFacts.find((f) => f.agentId === "seat_a").provider, "https://stub.example/api/anthropic");
      assert.equal(p.bricks.runtimeFacts.find((f) => f.agentId === "seat_b").provider, null);

      // 不进 drilldowns 目录（advisory 动作工具，非观察工具）。
      assert.equal("availableDrilldowns" in p, false, "快照不携带 availableDrilldowns");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// =====================================================================
// B — bounded wait / degraded views (WQ-02 state enumeration)
// =====================================================================

test("MRC-B1: waitMs=0 is valid; non-terminal seat observes truthfully (budgetExpired, never re-dispatched); missing transcript and failed dispatch degrade without breaking the rest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mrc-b1-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir);
    const runDir = join(dir, "runs");
    const consultsDir = join(dir, ".wao", "runs", "consults");
    // seat_a：running（非终态）→ 到期=观察截止，状态如实。
    writeTranscript(runDir, "run_consult_stub_seat_a", makeTranscript("run_consult_stub_seat_a", { state: "running", finalText: "Q1: 初步看 A 可行，仍在核对预算。\n" }));
    // seat_b：不预置 transcript（缺席）。
    const { server, client, dispatchCalls } = await buildConsultClient({ dir, registryPath, runDir, consultsDir });
    try {
      const { res, threw } = await callConsult(client, {
        brief: BRIEF,
        seats: ["seat_a", "seat_b"],
        waitMs: 0,
      });
      assert.equal(threw, false);
      assert.notEqual(res.isError, true, `partial-success snapshot is not an error: ${errText(res)}`);
      const p = res.structuredContent;
      const seatA = p.seats.find((s) => s.agentId === "seat_a");
      const seatB = p.seats.find((s) => s.agentId === "seat_b");
      assert.equal(seatA.runState, "running", "到期不改写状态");
      assert.equal(seatA.budgetExpired, true, "观察截止如实标记");
      // 半结构化：只覆盖 Q1（brief 有 Q1+Q2）→ partial，非 structured。
      assert.equal(seatA.formatState, "partial");
      assert.ok(seatA.finalText.includes("仍在核对预算"), "非终态席的当下文本照常入快照");
      assert.equal(seatB.runState, "missing", "缺席=观察事实");
      assert.equal(seatB.budgetExpired, true);
      assert.equal(seatB.formatState, "empty");
      // ③ 零自动重发：到期/缺席后派发计数不再增长。
      assert.equal(dispatchCalls.length, 2, "each seat dispatched exactly once — no re-send on expiry");
    } finally {
      await client.close();
      await server.close();
    }

    // 派发失败席：runState=dispatch_failed、runId=null，其余席照常（部分成功）。
    const { server: s2, client: c2, dispatchCalls: d2 } = await buildConsultClient({
      dir, registryPath, runDir, consultsDir, failSeat: "seat_b",
    });
    try {
      writeTranscript(runDir, "run_consult_stub_seat_a", makeTranscript("run_consult_stub_seat_a", { finalText: "Q1: A\n\nQ2: B\n" }));
      const { res, threw } = await callConsult(c2, { brief: BRIEF, seats: ["seat_a", "seat_b"], waitMs: 0 });
      assert.equal(threw, false);
      assert.notEqual(res.isError, true, `dispatch-failure seat degrades, not errors: ${errText(res)}`);
      const p = res.structuredContent;
      const seatB = p.seats.find((s) => s.agentId === "seat_b");
      assert.equal(seatB.runState, "dispatch_failed");
      assert.equal(seatB.runId, null);
      assert.equal(p.seats.find((s) => s.agentId === "seat_a").runState, "completed", "其余席不受连坐");
    } finally {
      await c2.close();
      await s2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MRC-B2: malformed (unstructured prose) seat — full prose preserved, zero re-send, no penalty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mrc-b2-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir);
    const runDir = join(dir, "runs");
    const consultsDir = join(dir, ".wao", "runs", "consults");
    const prose = "我认为方案 A 更好。\n理由一：成本低。\n理由二：周期短。\n";
    writeTranscript(runDir, "run_consult_stub_seat_a", makeTranscript("run_consult_stub_seat_a", { finalText: prose }));
    const { server, client, dispatchCalls } = await buildConsultClient({ dir, registryPath, runDir, consultsDir });
    try {
      const { res, threw } = await callConsult(client, { brief: BRIEF, seats: ["seat_a"], waitMs: 0 });
      assert.equal(threw, false);
      assert.notEqual(res.isError, true, errText(res));
      const seat = res.structuredContent.seats[0];
      assert.equal(seat.runState, "completed");
      assert.equal(seat.formatState, "unstructured", "completed+未结构化合法（两维分离）");
      assert.equal(seat.attribution.unclassified, prose, "整段散文原文保留，不做句子级切分");
      assert.equal(dispatchCalls.length, 1, "malformed 零自动重发");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// =====================================================================
// C — read mode: ZERO dispatch (MCP-layer invariant)
// =====================================================================

test("MRC-C1: read mode re-renders the group record with ZERO dispatch; unknown consultId fails closed to the fixed error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mrc-c1-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir);
    const runDir = join(dir, "runs");
    const consultsDir = join(dir, ".wao", "runs", "consults");
    const reply = "Q1: 采纳 A\n\nQ2: 选 B\n";
    const replyB = "Q1: 采纳 B\n\nQ2: 选 A\n";
    writeTranscript(runDir, "run_consult_stub_seat_a", makeTranscript("run_consult_stub_seat_a", { finalText: reply }));
    writeTranscript(runDir, "run_consult_stub_seat_b", makeTranscript("run_consult_stub_seat_b", { finalText: replyB }));
    const { server, client, dispatchCalls } = await buildConsultClient({ dir, registryPath, runDir, consultsDir });
    try {
      const created = await callConsult(client, { brief: BRIEF, seats: ["seat_a", "seat_b"], fields: { Q2: ["A", "B"] }, waitMs: 0 });
      assert.equal(created.threw, false);
      const consultId = created.res.structuredContent.consultId;
      const dispatchesAfterCreate = dispatchCalls.length;

      // 读取模式：零派发（不变式本体）+ 经 runId 回链重读 transcript 重渲染。
      const read = await callConsult(client, { consultId });
      assert.equal(read.threw, false);
      assert.notEqual(read.res.isError, true, errText(read.res));
      const p = read.res.structuredContent;
      assert.equal(p.consultId, consultId);
      assert.equal(dispatchCalls.length, dispatchesAfterCreate, "read mode dispatch count MUST stay 0");
      const seat = p.seats.find((s) => s.agentId === "seat_a");
      assert.equal(seat.finalText, reply, "重渲染回读席位原文（CLI consult show 同一内核）");
      assert.equal(seat.formatState, "structured");
      assert.deepEqual(p.fieldDiff, ["Q2"], "重渲染重新比对字段（两席 Q2 值不同）");
      assert.deepEqual(p.fieldValues.Q2, { seat_a: "B", seat_b: "A" });
      assert.ok(p.recordPath.includes(consultId));

      // 未知 consultId：固定错误文本（fail closed，不泄漏动态内容）。
      const unknown = await callConsult(client, { consultId: "consult_20990101000000000nonexist" });
      assert.equal(unknown.threw, false);
      assert.equal(unknown.res.isError, true);
      assert.equal(errText(unknown.res), "run_consult failed");
      assert.equal(dispatchCalls.length, dispatchesAfterCreate, "unknown consultId never dispatches");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// =====================================================================
// D — closed-set input: every refusal leaves dispatch at 0
// =====================================================================

test("MRC-D1: mode mutual exclusion + seat refusals name the offender; dispatch count stays 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mrc-d1-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir);
    const runDir = join(dir, "runs");
    const consultsDir = join(dir, ".wao", "runs", "consults");
    const { server, client, dispatchCalls } = await buildConsultClient({ dir, registryPath, runDir, consultsDir });
    try {
      // consultId 与创建字段互斥。
      const both = await callConsult(client, { consultId: "consult_20260101000000000aaaaaa", brief: "x", seats: ["seat_a"] });
      assert.equal(both.res.isError, true);
      assert.match(errText(both.res), /exactly one mode/);
      // brief 缺 seats / seats 缺 brief。
      const noSeats = await callConsult(client, { brief: "x" });
      assert.equal(noSeats.res.isError, true);
      assert.match(errText(noSeats.res), /exactly one mode/);
      const noBrief = await callConsult(client, { seats: ["seat_a"] });
      assert.equal(noBrief.res.isError, true);
      assert.match(errText(noBrief.res), /exactly one mode/);
      // 缺席席指名。
      const missing = await callConsult(client, { brief: "x", seats: ["seat_a", "ghost_seat"] });
      assert.equal(missing.res.isError, true);
      assert.match(errText(missing.res), /not in registry: ghost_seat/);
      // 重复席。
      const dup = await callConsult(client, { brief: "x", seats: ["seat_a", "seat_a"] });
      assert.equal(dup.res.isError, true);
      assert.match(errText(dup.res), /seats must be unique/);
      // 视角席不在 seats。
      const stray = await callConsult(client, { brief: "x", seats: ["seat_a"], perspectives: [{ agentId: "seat_b", text: "y" }] });
      assert.equal(stray.res.isError, true);
      assert.match(errText(stray.res), /not in seats: seat_b/);
      // 拒绝后派发计数为 0。
      assert.equal(dispatchCalls.length, 0, "every refusal above dispatched nothing");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MRC-D2: waitMs and fields are wire-validated closed sets (600001 / bad fields key rejected at the schema layer)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mrc-d2-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir);
    const { server, client, dispatchCalls } = await buildConsultClient({
      dir, registryPath, runDir: join(dir, "runs"), consultsDir: join(dir, ".wao", "runs", "consults"),
    });
    try {
      // SDK 输入校验拒绝呈现为 isError 结果（-32602 Input validation error）。
      const over = await callConsult(client, { brief: "x", seats: ["seat_a"], waitMs: 600001 });
      assert.equal(over.threw, false);
      assert.equal(over.res.isError, true, "waitMs=600001 rejected by the input schema");
      assert.match(errText(over.res), /Input validation error|-32602/);
      assert.match(errText(over.res), /too_big|600000/);
      const badKey = await callConsult(client, { brief: "x", seats: ["seat_a"], fields: { Qx: ["A"] } });
      assert.equal(badKey.threw, false);
      assert.equal(badKey.res.isError, true, "fields key outside Qn rejected by the input schema");
      assert.match(errText(badKey.res), /Input validation error|-32602/);
      assert.equal(dispatchCalls.length, 0, "schema-rejected calls never dispatch");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// =====================================================================
// E — surface truth: roster slot, annotations, description guards, no drilldowns
// =====================================================================

test("MRC-E1: run_consult sits between run_dispatch_contract_check and run_continue; dispatch-family annotations; description semantic guards; NOT a drilldown carrier", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mrc-e1-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir);
    const { server, client } = await buildConsultClient({
      dir, registryPath, runDir: join(dir, "runs"), consultsDir: join(dir, ".wao", "runs", "consults"),
    });
    try {
      const tools = (await client.listTools()).tools;
      const names = tools.map((t) => t.name);
      const idx = names.indexOf("run_consult");
      assert.ok(idx !== -1, "run_consult is on the surface");
      assert.equal(names[idx - 1], "run_dispatch_contract_check", "roster slot: after contract check");
      assert.equal(names[idx + 1], "run_continue", "roster slot: before continue");

      const entry = tools[idx];
      assert.deepEqual(entry.annotations, {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      }, "dispatch-family annotations");

      const d = entry.description;
      assert.match(d, /INLINE text/, "brief is inline text, never a file path");
      assert.match(d, /0\.\.600000/);
      assert.match(d, /default 270000/);
      assert.match(d, /observation cutoff only/);
      assert.match(d, /never killed or re-dispatched/);
      assert.match(d, /zero-truncation/);
      assert.match(d, /never synthesizes/);
      assert.match(d, /ZERO dispatch/);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // 闭集目录：run_consult 不是 drilldown 载体（advisory 动作工具）。
  assert.equal(DRILLDOWN_TOOLS.includes("run_consult"), false,
    "run_consult must not be a drilldown carrier (it is an advisory action tool)");
});
