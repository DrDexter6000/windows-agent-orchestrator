// test/mcp-surface/mcpRunConsult.test.js
//
// M13-r2 (decision 0039) + 0051 载荷合同 — the `run_consult` MCP tool:
// multi-seat read-only council consult on the Agent Union MCP face.
//
// Contracts under test:
//   A — create mode end-to-end: fan-out via the server's dispatch seam is
//       READ-ONLY per seat (readOnly:true + inline brief kernel + perspective
//       tail); returns a MECHANICAL RECEIPT (0051): no per-seat body text, no
//       excerpts — per-seat {runState, formatState, chars, pages, textFinal} +
//       fieldDiff markers + independence facts; receipt ≤ receipt cap serialized
//       (body-size independent); fieldDiff is marker-only (no conclusion words).
//   B — bounded-wait semantics: waitMs=0 is valid; expiry is an OBSERVATION
//       CUTOFF ONLY — a non-terminal seat stays truthfully running with
//       budgetExpired:true, textFinal:false, and the dispatch count NEVER grows
//       (0039 invariant ③); a missing transcript observes "missing" (chars=0,
//       pages=0); a failed dispatch degrades to dispatch_failed.
//   C — read mode: consultId re-renders the stored group record with ZERO
//       dispatch (receipt view). {consultId, seat, page?} returns ONE PAGE of
//       that seat's final text: each full response ≤12KiB serialized; pages
//       reassemble byte-exact (0051 losslessness); every page carries the same
//       textSha256 (version anchor — mismatch means re-read from page 1);
//       line-boundary split preferred; code-point safe (surrogate pairs never
//       split); escape-dense text paged losslessly.
//   D — closed-set input: mode mutual exclusion (fixed text), 0051 paging
//       refusals (seat/page in create mode / page without seat / unknown seat /
//       no-text seat / out-of-range page), per-seat registry existence, duplicate
//       seats, stray perspectives, waitMs schema bounds — every refusal leaves
//       the dispatch count at 0.
//   E — surface truth: roster slot, dispatch-family annotations, description
//       semantic guards, NOT a drilldown carrier.
//   F — receipt capacity boundary: metadata-max shape ≤ receipt cap (8KiB,
//       Chinese headings + populated field values); body independence
//       (5 seats × 100KB replies → still within cap).
//   G — pure pager edges (paginateConsultText): empty text; envelope-over-cap
//       throws; tiny-cap hard split is code-point safe and lossless.
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
import { createHash } from "node:crypto";

import {
  isValidConsultId,
  projectConsultReceipt,
  paginateConsultText,
  CONSULT_PAGE_CAP_BYTES,
  CONSULT_RECEIPT_CAP_BYTES,
} from "../../src/application/consultService.js";
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

/** 整个 text 通道（=JSON.stringify(structuredContent)）的 UTF-8 字节数。 */
function wireBytes(res) {
  return Buffer.byteLength(res.content[0].text, "utf8");
}

const BRIEF = "会审任务书\n\n## Q1 方案可行吗\n\nQ2: 首选哪个\n";

const sha256 = (t) => createHash("sha256").update(t, "utf8").digest("hex");

// =====================================================================
// A — create mode end-to-end (0051 receipt contract)
// =====================================================================

test("MRC-A1: create mode fans out read-only per-seat runs and returns a capped mechanical receipt (no body text)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mrc-a1-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir);
    const runDir = join(dir, "runs");
    const consultsDir = join(dir, ".wao", "runs", "consults");
    // seat_a：结构化长回复（多页体量；正文只经分页读出，回执零携带）。
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
      assert.equal(p.view, "receipt", "0051：create 成功 → 机械回执");
      assert.ok(isValidConsultId(p.consultId), `consultId 形状：${p.consultId}`);
      assert.equal(p.recordPath, join(consultsDir, `${p.consultId}.json`));
      assert.ok(existsSync(p.recordPath), "组记录落盘");
      const record = JSON.parse(readFileSync(p.recordPath, "utf8"));
      assert.equal(record.consultId, p.consultId);
      const mapping = Object.fromEntries(record.seats.map((s) => [s.agentId, s.runId]));
      assert.equal(mapping.seat_a, "run_consult_stub_seat_a");
      assert.equal(mapping.seat_b, "run_consult_stub_seat_b");

      // 回执零正文：finalText/attribution/正文片段一律不在（任何通道）。
      const serialized = JSON.stringify(p);
      for (const banned of ["finalText", "attribution", "理由是成本可控", "风险可控"]) {
        assert.ok(!serialized.includes(banned), `回执不得携带正文/归组拷贝：${banned}`);
      }
      // 回执分页元数据：chars=正文长度；pages≥2（长文多页）；textFinal=终态。
      const seatA = p.seats.find((s) => s.agentId === "seat_a");
      const seatB = p.seats.find((s) => s.agentId === "seat_b");
      assert.equal(seatA.chars, seatAText.length, "chars=正文 UTF-16 长度");
      assert.ok(seatA.pages >= 2, `长文席 pages≥2（实测 ${seatA.pages}）`);
      assert.equal(seatA.textFinal, true, "completed → textFinal");
      assert.equal(seatA.runState, "completed");
      assert.equal(seatA.formatState, "structured");
      assert.equal(seatA.budgetExpired, false);
      assert.ok(!("perspectiveSnippet" in seatA), "视角全文不进回执（recordPath 取——验收批 M3a）");
      assert.equal(JSON.parse(readFileSync(p.recordPath, "utf8")).seats.find((x) => x.agentId === "seat_a").perspectiveSnippet,
        "你是成本视角：先自测预算是否闭合。", "视角全文在组记录（回链锚点不丢）");
      assert.equal(seatB.pages, 1, "短文席单页");
      assert.equal(seatB.textFinal, true);

      // 0051 容量：整个 text 通道（=JSON.stringify(structuredContent)）≤回执帽。
      assert.ok(wireBytes(res) <= CONSULT_RECEIPT_CAP_BYTES,
        `回执 text 通道 ≤${CONSULT_RECEIPT_CAP_BYTES}B（实测 ${wireBytes(res)}B）`);

      // 标记即提示（0039 ②）：fieldDiff 只报 Qn；值并列；无结论词。
      assert.deepEqual(p.fieldDiff, ["Q1"]);
      assert.deepEqual(p.fieldValues.Q1, { seat_a: "A", seat_b: "B" });
      for (const word of ["agree", "disagree", "一致", "分歧"]) {
        assert.ok(!serialized.includes(word), `回执不得携带结论词：${word}`);
      }

      // 三块砖①厂族：registry 原始字段直读（wrapper 形 provider.baseUrl）。
      assert.equal(p.bricks.runtimeFacts.find((f) => f.agentId === "seat_a").provider, "https://stub.example/api/anthropic");
      assert.equal(p.bricks.runtimeFacts.find((f) => f.agentId === "seat_b").provider, null);

      // 不进 drilldowns 目录（advisory 动作工具，非观察工具；0051 维持六工具闭集）。
      assert.equal("availableDrilldowns" in p, false, "回执不携带 availableDrilldowns");
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

test("MRC-B1: waitMs=0 is valid; non-terminal seat observes truthfully (budgetExpired, textFinal:false, never re-dispatched); missing transcript and failed dispatch degrade without breaking the rest", async () => {
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
      assert.notEqual(res.isError, true, `partial-success receipt is not an error: ${errText(res)}`);
      const p = res.structuredContent;
      const seatA = p.seats.find((s) => s.agentId === "seat_a");
      const seatB = p.seats.find((s) => s.agentId === "seat_b");
      assert.equal(p.view, "receipt");
      assert.equal(seatA.runState, "running", "到期不改写状态");
      assert.equal(seatA.budgetExpired, true, "观察截止如实标记");
      assert.equal(seatA.textFinal, false, "非终态席 textFinal=false（分页边界仍会漂移）");
      assert.ok(seatA.chars > 0 && seatA.pages >= 1, "非终态席当下文本可分页读取");
      // 半结构化：只覆盖 Q1（brief 有 Q1+Q2）→ partial，非 structured。
      assert.equal(seatA.formatState, "partial");
      assert.equal(seatB.runState, "missing", "缺席=观察事实");
      assert.equal(seatB.budgetExpired, true);
      assert.equal(seatB.formatState, "empty");
      assert.equal(seatB.chars, 0, "缺席席零正文");
      assert.equal(seatB.pages, 0, "缺席席零页");
      assert.equal(seatB.textFinal, false);
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
      assert.equal(seatB.pages, 0, "派发失败席零页");
      assert.equal(p.seats.find((s) => s.agentId === "seat_a").runState, "completed", "其余席不受连坐");
    } finally {
      await c2.close();
      await s2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MRC-B2: malformed (unstructured prose) seat — prose paged verbatim, zero re-send, no penalty", async () => {
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
      const receipt = res.structuredContent;
      const seat = receipt.seats[0];
      assert.equal(seat.runState, "completed");
      assert.equal(seat.formatState, "unstructured", "completed+未结构化合法（两维分离）");
      assert.equal(seat.chars, prose.length, "散文字符数如实");
      assert.equal(seat.pages, 1, "短散文单页");
      // 正文经分页无损读出（不做句子级切分——整段散文原文）。
      const page = await callConsult(client, { consultId: receipt.consultId, seat: "seat_a", page: 1 });
      assert.notEqual(page.res.isError, true, errText(page.res));
      assert.equal(page.res.structuredContent.pageText, prose, "分页读出=整段散文原文逐字节");
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
// C — read mode: ZERO dispatch (MCP-layer invariant) + 0051 seat paging
// =====================================================================

test("MRC-C1: read mode re-renders the group record as the SAME receipt shape with ZERO dispatch; unknown consultId fails closed to the fixed error", async () => {
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

      // 读取模式（无 seat）：零派发（不变式本体）+ 同一回执形状（0051：不造
      // 第三种形状——create 与 read-no-seat 共用同一投影函数）。
      const read = await callConsult(client, { consultId });
      assert.equal(read.threw, false);
      assert.notEqual(read.res.isError, true, errText(read.res));
      const p = read.res.structuredContent;
      assert.equal(p.view, "receipt", "read 无 seat = 回执重渲染");
      assert.equal(p.consultId, consultId);
      assert.equal(dispatchCalls.length, dispatchesAfterCreate, "read mode dispatch count MUST stay 0");
      const seat = p.seats.find((s) => s.agentId === "seat_a");
      assert.equal(seat.chars, reply.length, "重渲染回读席位正文长度（CLI consult show 同一内核）");
      assert.equal(seat.formatState, "structured");
      assert.deepEqual(p.fieldDiff, ["Q2"], "重渲染重新比对字段（两席 Q2 值不同）");
      assert.deepEqual(p.fieldValues.Q2, { seat_a: "B", seat_b: "A" });
      assert.ok(p.recordPath.includes(consultId));
      assert.ok(wireBytes(read.res) <= CONSULT_RECEIPT_CAP_BYTES, "read 回执同受回执帽");

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

test("MRC-C2: seat paging — every page ≤12KiB serialized, pages reassemble byte-exact, one textSha256 across pages, line-boundary preferred, default page=1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mrc-c2-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir);
    const runDir = join(dir, "runs");
    const consultsDir = join(dir, ".wao", "runs", "consults");
    // 中文密集长文（≈48KB UTF-8 → ≥4 页；每行短句 → 行边界优先可证）。
    const lines = [];
    for (let i = 0; i < 2000; i++) lines.push(`第${i}行：理由是成本可控，风险可测，边界可守。`);
    const seatAText = `Q1: 采纳 A\n${lines.join("\n")}\nQ2: 选 B\n`;
    writeTranscript(runDir, "run_consult_stub_seat_a", makeTranscript("run_consult_stub_seat_a", { finalText: seatAText }));
    const { server, client, dispatchCalls } = await buildConsultClient({ dir, registryPath, runDir, consultsDir });
    try {
      const created = await callConsult(client, { brief: BRIEF, seats: ["seat_a"], waitMs: 0 });
      const receipt = created.res.structuredContent;
      const seatA = receipt.seats[0];
      assert.ok(seatA.pages >= 3, `长文席至少 3 页（实测 ${seatA.pages}）`);
      assert.ok(wireBytes(created.res) <= CONSULT_RECEIPT_CAP_BYTES, "回执不随正文膨胀（回执帽）");

      // 逐页取：每页整响应（text 通道=JSON.stringify(structuredContent)）≤12KiB。
      const pages = [];
      const shas = new Set();
      for (let n = 1; n <= seatA.pages; n++) {
        const args = { consultId: receipt.consultId, seat: "seat_a" };
        if (n > 1) args.page = n; // n=1 故意省略 page → 默认第 1 页
        const page = await callConsult(client, args);
        assert.equal(page.threw, false);
        assert.notEqual(page.res.isError, true, errText(page.res));
        const sp = page.res.structuredContent;
        assert.equal(sp.view, "seatPage");
        assert.equal(sp.page, n, "页码如实");
        assert.equal(sp.totalPages, seatA.pages, "页数与回执一致（同一把尺）");
        assert.equal(sp.textFinal, true);
        assert.ok(wireBytes(page.res) <= CONSULT_PAGE_CAP_BYTES,
          `第 ${n} 页整响应 ≤${CONSULT_PAGE_CAP_BYTES}B（实测 ${wireBytes(page.res)}B）`);
        shas.add(sp.textSha256);
        pages.push(sp.pageText);
      }
      // 无损（0051 的零截断兑现）：各页按序拼接逐字节 === 原文。
      assert.equal(pages.join(""), seatAText, "分页拼回=原文逐字节");
      // 版本锚：同一正文的全部页携带同一 sha（跨页不一致=版本变化信号）。
      assert.equal(shas.size, 1, "同版本全页同一 textSha256");
      assert.equal([...shas][0], sha256(seatAText), "textSha256=全文 sha256");
      // 行边界优先：非末页以换行收尾（fixture 全短行可达成）。
      for (let n = 0; n < pages.length - 1; n++) {
        assert.ok(pages[n].endsWith("\n"), `第 ${n + 1} 页行边界收尾`);
      }
      // 分页零派发。
      assert.equal(dispatchCalls.length, 1, "paging never dispatches");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MRC-C3: hostile text fixtures — escape-dense and no-newline surrogate text page losslessly under the cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mrc-c3-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir);
    const runDir = join(dir, "runs");
    const consultsDir = join(dir, ".wao", "runs", "consults");
    // 逃逸密集：引号/反斜杠/制表/换行混排（JSON 转义放大）。
    const dense = "引号\"反斜杠\\制表\t换行\n".repeat(900);
    // 无换行+代理对：强制码点硬切，绝不允许切开代理对。
    const emoji = "🚀🚀🚀".repeat(3000);
    writeTranscript(runDir, "run_consult_stub_seat_a", makeTranscript("run_consult_stub_seat_a", { finalText: dense }));
    writeTranscript(runDir, "run_consult_stub_seat_b", makeTranscript("run_consult_stub_seat_b", { finalText: emoji }));
    const { server, client } = await buildConsultClient({ dir, registryPath, runDir, consultsDir });
    try {
      const created = await callConsult(client, { brief: BRIEF, seats: ["seat_a", "seat_b"], waitMs: 0 });
      const receipt = created.res.structuredContent;
      for (const [seatId, original] of [["seat_a", dense], ["seat_b", emoji]]) {
        const meta = receipt.seats.find((s) => s.agentId === seatId);
        const pages = [];
        for (let n = 1; n <= meta.pages; n++) {
          const page = await callConsult(client, { consultId: receipt.consultId, seat: seatId, page: n });
          assert.equal(page.threw, false);
          assert.notEqual(page.res.isError, true, errText(page.res));
          assert.ok(wireBytes(page.res) <= CONSULT_PAGE_CAP_BYTES,
            `${seatId} 第 ${n} 页 ≤${CONSULT_PAGE_CAP_BYTES}B（实测 ${wireBytes(page.res)}B）`);
          pages.push(page.res.structuredContent.pageText);
        }
        assert.equal(pages.join(""), original, `${seatId} 恶劣文本分页拼回=原文逐字节`);
        assert.ok(meta.pages >= 2, `${seatId} 多页（实测 ${meta.pages}）`);
      }
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

test("MRC-D1: mode mutual exclusion + seat refusals + 0051 paging refusals name the offender; dispatch count stays 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mrc-d1-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir);
    const runDir = join(dir, "runs");
    const consultsDir = join(dir, ".wao", "runs", "consults");
    writeTranscript(runDir, "run_consult_stub_seat_a", makeTranscript("run_consult_stub_seat_a", { finalText: "Q1: A\n\nQ2: B\n" }));
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
      // 0051：create 模式禁带分页参数。
      const pagingInCreate = await callConsult(client, { brief: "x", seats: ["seat_a"], seat: "seat_a" });
      assert.equal(pagingInCreate.res.isError, true);
      assert.match(errText(pagingInCreate.res), /read-mode-only/);
      const pageInCreate = await callConsult(client, { brief: "x", seats: ["seat_a"], page: 1 });
      assert.equal(pageInCreate.res.isError, true);
      assert.match(errText(pageInCreate.res), /read-mode-only/);

      // 0051 读模式分页拒绝面（先建一份真实 consult）。
      const created = await callConsult(client, { brief: BRIEF, seats: ["seat_a", "seat_b"], waitMs: 0 });
      assert.equal(created.threw, false);
      const consultId = created.res.structuredContent.consultId;
      const dispatchesAfterCreate = dispatchCalls.length;
      // page 无 seat。
      const pageNoSeat = await callConsult(client, { consultId, page: 1 });
      assert.equal(pageNoSeat.res.isError, true);
      assert.match(errText(pageNoSeat.res), /page requires seat/);
      // 未知席位（不在组记录）。
      const unknownSeat = await callConsult(client, { consultId, seat: "ghost", page: 1 });
      assert.equal(unknownSeat.res.isError, true);
      assert.match(errText(unknownSeat.res), /seat not in this consult record: ghost/);
      // 无正文席（seat_b 缺席 transcript）。
      const noText = await callConsult(client, { consultId, seat: "seat_b", page: 1 });
      assert.equal(noText.res.isError, true);
      assert.match(errText(noText.res), /has no final text to page/);
      assert.match(errText(noText.res), /runState: missing/);
      // 越界页（seat_a 单页）。
      const outOfRange = await callConsult(client, { consultId, seat: "seat_a", page: 2 });
      assert.equal(outOfRange.res.isError, true);
      assert.match(errText(outOfRange.res), /page 2 out of range \(totalPages: 1\)/);
      // 拒绝后派发计数为 0（读模式拒绝同样零派发）。
      assert.equal(dispatchCalls.length, dispatchesAfterCreate, "every refusal above dispatched nothing");
      assert.equal(dispatchesAfterCreate, 2, "前置：create 恰好两席各一次");
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
      // seat/page 同受 schema 闭集约束（负数页/空席名）。
      const badPage = await callConsult(client, { consultId: "consult_20260101000000000aaaaaa", seat: "seat_a", page: 0 });
      assert.equal(badPage.threw, false);
      assert.equal(badPage.res.isError, true, "page=0 rejected by the input schema");
      assert.match(errText(badPage.res), /Input validation error|-32602/);
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
      assert.match(d, /MECHANICAL RECEIPT/, "0051：create 返回机械回执");
      assert.match(d, /no per-seat body text, no excerpts/, "回执零正文零预览（0039 ①：预览=选择性截断）");
      assert.match(d, /12KiB serialized/, "页帽单位=整页序列化字节");
      assert.match(d, /reassemble byte-exact/, "分页无损");
      assert.match(d, /textSha256/, "版本锚");
      assert.match(d, /restart from page 1/);
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

// =====================================================================
// F — receipt capacity boundary (pure projection; body independence)
// =====================================================================

test("MRC-F1: receipt within cap for the honest metadata-max shape (Chinese headings + populated field values, no snippets) and body-size independent", () => {
  // 验收批修订（sol 反例实跑：71 字 ASCII 标题+空 fieldValues 的旧夹具量出
  // 4916B，中文 120 字标题=7786B、字段值在场=6896B——旧 6KiB 帽不可证）：
  // ①视角 snippet（真实记录全文 265-607 字/席）整体出回执；②帽重冻 8KiB；
  // ③夹具改中文标题+在场字段值。成立边界：≤5 席 × ≤32 字 id × ≤10 问 ×
  // ≤120 字中文标题 × 短字段值、无视角原文。schema 上限（id 128 字/brief
  // 派生问题无帽）超界或字段值病态长可破帽——已知未收紧；正文体积完全无关。
  const longId = "s".repeat(32);
  const questions = Array.from({ length: 10 }, (_, i) => ({ q: i + 1, heading: `问题标题第${i}号`.repeat(10) }));
  const body = "正文不应进回执。".repeat(8000); // ~100KB
  const fieldDiff = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8", "Q9", "Q10"];
  const fieldValues = Object.fromEntries(fieldDiff.map((q, i) => [q, Object.fromEntries(
    Array.from({ length: 5 }, (_, j) => [`席位_${j}`, `选项${i}`]),
  )]));
  const mkSeat = (i) => ({
    agentId: i === 0 ? longId : `${longId}_${i}`,
    runId: "run_20260101000000000aaaaaa",
    runState: "completed",
    formatState: "structured",
    backend: "claude-code",
    provider: null,
    perspectiveSnippet: "视角全文不进回执。".repeat(100), // 病态长也必须被剥离
    budgetExpired: false,
    finalText: body, // 100KB 正文——投影后必须消失
    attribution: { ordered: [{ q: 1, text: body }], unclassified: "", preamble: "" },
  });
  const result = {
    consultId: "consult_20260101000000000aaaaaa",
    recordPath: "x".repeat(80),
    record: { consultId: "consult_20260101000000000aaaaaa" }, // 投影必须丢弃
    questions,
    brief: { path: null, sha256: "a".repeat(64) },
    budgetMs: 600000,
    elapsedMs: 123456,
    seats: Array.from({ length: 5 }, (_, i) => mkSeat(i)),
    fieldDiff,
    fieldValues,
    bricks: {
      runtimeFacts: Array.from({ length: 5 }, (_, i) => ({ agentId: `${longId}_${i}`, backend: "claude-code", provider: null })),
      authorInSeats: null,
      reviewedAgentId: null,
      sessionIndependence: "未提供",
    },
  };
  // 与 server.js 同一信封测度（页帽语义：整页序列化字节；占位=text.length
  // 已证明上界——sol 验收修正：9999 非证明上界）。
  const measure = (seat, candidate) => Buffer.byteLength(JSON.stringify({
    view: "seatPage", consultId: result.consultId, seat: seat.agentId, runId: seat.runId,
    runState: seat.runState, formatState: seat.formatState, budgetExpired: seat.budgetExpired,
    textFinal: true, page: body.length, totalPages: body.length, totalChars: body.length,
    textSha256: "a".repeat(64), pageText: candidate,
  }), "utf8");
  const receipt = projectConsultReceipt(result, { pageMeasure: measure });
  const serialized = Buffer.byteLength(JSON.stringify(receipt), "utf8");
  assert.ok(serialized <= CONSULT_RECEIPT_CAP_BYTES,
    `诚实边界回执 ≤${CONSULT_RECEIPT_CAP_BYTES}B（实测 ${serialized}B；边界=5席×32字id×10问×120字中文标题×在场字段值×无snippet）`);
  assert.ok(!JSON.stringify(receipt).includes("正文不应进回执"), "正文不进回执（body-size 无关）");
  assert.ok(!JSON.stringify(receipt).includes("视角全文不进回执"), "视角全文不进回执（病态长也被剥离）");
  assert.ok(!("record" in receipt), "组记录副本不进回执（recordPath 指针承载）");
  for (const seat of receipt.seats) {
    assert.equal(seat.chars, body.length);
    assert.ok(seat.pages >= 1, "100KB 正文页数如实（仅计数进回执）");
    assert.equal(seat.textFinal, true);
    assert.ok(!("backend" in seat) && !("provider" in seat), "backend/provider 去重（bricks 已携带）");
  }
});

// =====================================================================
// G — pure pager edges (paginateConsultText)
// =====================================================================

test("MRC-G1: pure pager — empty text yields zero pages; envelope-over-cap throws; tiny-cap hard split is code-point safe and lossless", () => {
  const naive = (slack) => (candidate) => Buffer.byteLength(candidate, "utf8") + slack;

  // 空文本 → 零页。
  const empty = paginateConsultText("", { measure: naive(300) });
  assert.deepEqual(empty, { pages: [], totalChars: 0 });

  // 外壳自身超帽 → 如实抛（cap 配置错误，不静默）。
  assert.throws(() => paginateConsultText("x", { capBytes: 10, measure: naive(300) }), /envelope alone exceeds capBytes/);

  // 极小帽（只装得下少量码点）：码点硬切不拆代理对、无损拼回。
  const emojiText = "🚀🚀🚀🚀🚀🚀🚀🚀"; // 8 个 emoji=16 个 UTF-16 码元
  const tiny = paginateConsultText(emojiText, { capBytes: 4 + 300, measure: naive(300) });
  assert.ok(tiny.pages.length === 8, `每页恰一个 emoji（实测 ${tiny.pages.length} 页）`);
  assert.equal(tiny.pages.join(""), emojiText, "硬切无损拼回");
  for (const page of tiny.pages) {
    assert.equal(page, "🚀", "每页是完整代理对，无孤立半对");
  }

  // 行边界优先：短行文本在极小帽下仍按行切。
  const lines = "一行\n两行\n三行\n";
  const byLine = paginateConsultText(lines, { capBytes: 3 * 3 + 300, measure: naive(300) });
  assert.equal(byLine.pages.join(""), lines, "行切无损");
  assert.ok(byLine.pages.slice(0, -1).every((p) => p.endsWith("\n")), "非末页行边界收尾");

  // sol 验收反例（逐位前缀测度非单调）：JSON.stringify 把落单高位代理转义成
  // 6 字节 ud-XXX 形式，比完整代理对（4 字节 UTF-8）更大——逐位二分在三个
  // rocket、cap=6 时误判"装不下"。码点边界搜索修复后：每页恰一个完整 emoji。
  const jsonMeasure = (candidate) => Buffer.byteLength(JSON.stringify(candidate), "utf8");
  const threeRocket = "🚀🚀🚀";
  const fixed = paginateConsultText(threeRocket, { capBytes: 6, measure: jsonMeasure });
  assert.equal(fixed.pages.length, 3, "cap=6 时每页恰一个完整 emoji（非单调反例修复）");
  assert.equal(fixed.pages.join(""), threeRocket, "修复后仍无损");
});
