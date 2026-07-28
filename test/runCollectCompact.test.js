// test/runCollectCompact.test.js
//
// M12-2A: run_collect compact mode — TDD RED→GREEN.
//
// After a terminal run a Lead usually needs only ONE call to see the last
// assistant verbatim text plus the complete evidence counts, instead of 6-9
// pages of full collection. `mode:"compact"` reads the SAME full safe snapshot
// the existing projection reads, reuses the SAME extractAssistantTexts /
// redaction / sanitization / evidenceCounts SSOT (no duplicated parsing
// algorithm), and returns the existing safe base fields PLUS (compact only)
// view="compact", assistantMessageCount, compactStatus.
//
// compact does NO semantic summary and does NOT decide whether full output is
// needed. compact does NOT accept a cursor (cursor is full-only). Each
// successful compact still appends exactly ONE messages.collected audit; any
// input/projection/schema/service failure appends ZERO.
//
// Contract coverage map (test -> contract point):
//   A1/A2 ........ 3+5 (compact fields added; default full zero-drift)
//   B1/B2/B3 ...... 2+4 (same snapshot/SSOT reuse; available shape, process+serve)
//   C1/C2 ......... 2+8 (exact-secret redaction + C0/C1/DEL sanitization reuse)
//   D1/D2 ......... 4 (exact 4000 available, 4001 too_large, zero partial)
//   E1 ............ 4 (empty state)
//   F1/F2/F3 ...... 1+6 (compact+cursor rejected before service/read/append)
//   G1/G2 ......... 7 (illegal mode fails closed)
//   H1/H2/H3 ...... 6 (success appends 1 / failure appends 0)
//   I1/I2/I3 ...... 5 (default full exact keys + pagination/cursor unchanged)
//   J1/J2/J3 ...... 8 (real MCP Client wire schema + error fixed, no leak)
//   K1..K8 ........ 7 (CLI compact parity + strict parser + default raw unchanged)
//   L1/L2 ......... 2+6 (serve sentinel fail-closed, compact never bypasses)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  projectCollectResult,
  COLLECT_MAX_TEXT_CHARS,
} from "../src/application/runCollectProjection.js";
import { collectRunMessages } from "../src/application/runCollect.js";
import { createWaoMcpServer } from "../src/mcp/server.js";
import { collectCommand } from "../src/cli.js";

// ===== Helpers =====

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function isTransientRmError(error) {
  return error?.code === "EPERM" || error?.code === "EBUSY" || error?.code === "ENOTEMPTY";
}
function rmrfRetry(dir, { retries = 20, delayMs = 50 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch (error) { if (!isTransientRmError(error) || attempt >= retries) throw error; sleepSync(delayMs); }
  }
}

async function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.map(String).join(" ")); };
  try { await fn(); } finally { console.log = orig; }
  return lines.join("\n");
}

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-m122a-client", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// Direct raw-result builders for projection-level unit tests (no service/file IO).
function procResult(items) {
  return { data: items, reconstructed: true, backend: "process", agentId: "researcher" };
}
function assistant(text) { return { kind: "message", role: "assistant", parts: [{ type: "text", text }] }; }
function user(text) { return { kind: "message", role: "user", parts: [{ type: "text", text }] }; }
function command(cmd) { return { kind: "command", command: cmd }; }
function toolUse(tool, input) { return { kind: "tool_use", tool, input }; }
function toolResult(tool, output) { return { kind: "tool_result", tool, output, isError: false }; }
function fileWritten(p) { return { kind: "file_written", path: p }; }
function serveAssistant(text) { return { info: { role: "assistant" }, parts: [{ type: "text", text }] }; }
function serveUser(text) { return { info: { role: "user" }, parts: [{ type: "text", text }] }; }

// Real process transcript on disk (for MCP/CLI integration tests).
function jl(obj) { return JSON.stringify(obj) + "\n"; }
function sessionHeader(runId, agentId = "researcher", backend = "process", extra = {}) {
  return [
    jl({ type: "run.submitted", agentId, ts: "2026-07-28T00:00:00.000Z" }),
    jl({ type: "session.created", backend, backendSessionId: "proc_m122a", runId, agentId, ...extra }),
    jl({ type: "run.started", backend: "claude-code", ts: "2026-07-28T00:00:01.000Z", runId, agentId }),
  ].join("");
}
function msg(runId, text, idx, agentId = "researcher") {
  return jl({
    type: "run.event", kind: "message", role: "assistant",
    parts: [{ type: "text", text }], ts: `2026-07-28T00:00:${10 + idx}.000Z`, runId, agentId,
  });
}
function writeTranscript(runDir, runId, body) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, `${runId}.jsonl`), body, "utf8");
}
function countAudits(transcriptPath) {
  try {
    return readFileSync(transcriptPath, "utf8").trim().split("\n")
      .filter((l) => l.includes('"messages.collected"')).length;
  } catch { return 0; }
}

// =====================================================================
// Section A — RED actual: compact fields absent today (mode ignored).
// =====================================================================

test("M12-2A-A1: projectCollectResult compact returns view/compactStatus/assistantMessageCount", () => {
  const raw = procResult([assistant("early"), assistant("the final answer")]);
  const out = projectCollectResult(raw, { runId: "run_a1", mode: "compact" });
  // RED today: these are undefined because mode is ignored and a full page is returned.
  assert.equal(out.view, "compact", "compact payload carries view='compact'");
  assert.equal(out.compactStatus, "available", "last assistant text <= 4000 → available");
  assert.equal(out.assistantMessageCount, 2, "counts every assistant text in the full snapshot");
  assert.deepEqual(out.messages, [{ role: "assistant", text: "the final answer", truncated: false }]);
  assert.equal(out.truncated, false);
  assert.equal(out.nextCursor, null);
});

test("M12-2A-A2: full default omits compact fields (regression guard)", () => {
  const raw = procResult([assistant("a"), assistant("b")]);
  const full = projectCollectResult(raw, { runId: "run_a2" });
  assert.equal(full.view, undefined, "full output has no view");
  assert.equal(full.compactStatus, undefined, "full output has no compactStatus");
  assert.equal(full.assistantMessageCount, undefined, "full output has no assistantMessageCount");
  // Existing base fields intact.
  assert.deepEqual(full.messages.map((m) => m.text), ["a", "b"]);
  assert.equal(full.nextCursor, null);
});

// =====================================================================
// Section B — same snapshot / SSOT reuse; available shape (process + serve).
// =====================================================================

test("M12-2A-B1: process compact — last assistant verbatim + FULL-snapshot counts", () => {
  const raw = procResult([
    assistant("first"), assistant("second"), assistant("LAST-body"),
    user("the prompt"),
    command("npm test"),
    toolUse("Bash", { command: "echo hi" }),
    toolResult("Bash", "hi"),
    fileWritten("src/x.js"),
  ]);
  const compact = projectCollectResult(raw, { runId: "run_b1", mode: "compact" });
  const full = projectCollectResult(raw, { runId: "run_b1" });
  // Reuses the SAME evidenceCounts / itemCount / agentId as full (SSOT parity).
  assert.deepEqual(compact.evidenceCounts, full.evidenceCounts, "evidenceCounts from same SSOT");
  assert.equal(compact.itemCount, full.itemCount, "itemCount from full snapshot");
  assert.equal(compact.agentId, full.agentId, "agentId parity");
  // evidenceCounts.message counts EVERY message-shape item (incl. user), while
  // assistantMessageCount counts only assistant-authored texts.
  assert.equal(compact.evidenceCounts.message, 4);
  assert.equal(compact.evidenceCounts.command, 1);
  assert.equal(compact.evidenceCounts.toolUse, 1);
  assert.equal(compact.evidenceCounts.toolResult, 1);
  assert.equal(compact.evidenceCounts.fileWritten, 1);
  assert.equal(compact.itemCount, 8);
  assert.equal(compact.assistantMessageCount, 3, "3 assistant texts");
  // Only the LAST assistant text, verbatim.
  assert.equal(compact.compactStatus, "available");
  assert.deepEqual(compact.messages, [{ role: "assistant", text: "LAST-body", truncated: false }]);
});

test("M12-2A-B2: serve compact — last assistant verbatim (serve message shape)", () => {
  const raw = {
    data: [serveAssistant("srv-a"), serveAssistant("srv-final"), serveUser("srv-u")],
    reconstructed: false, backend: "opencode-serve", agentId: "researcher",
  };
  const compact = projectCollectResult(raw, { runId: "run_b2", mode: "compact" });
  assert.equal(compact.compactStatus, "available");
  assert.equal(compact.assistantMessageCount, 2);
  assert.deepEqual(compact.messages, [{ role: "assistant", text: "srv-final", truncated: false }]);
});

test("M12-2A-B3: multi-page full needs several calls; compact needs ONE (motivation)", () => {
  // 12 assistant messages: full page 1 returns 8 + a cursor; compact returns the
  // last one in a single call with nextCursor:null.
  const items = [];
  for (let i = 0; i < 12; i += 1) items.push(assistant(`m-${i}`));
  const raw = procResult(items);
  const full1 = projectCollectResult(raw, { runId: "run_b3" });
  assert.equal(full1.messages.length, 8, "full page 1 caps at 8");
  assert.ok(full1.nextCursor, "full page 1 has more to read");
  const compact = projectCollectResult(raw, { runId: "run_b3", mode: "compact" });
  assert.equal(compact.assistantMessageCount, 12);
  assert.deepEqual(compact.messages, [{ role: "assistant", text: "m-11", truncated: false }]);
  assert.equal(compact.nextCursor, null, "compact is single-shot, no cursor");
});

// =====================================================================
// Section C — exact-secret redaction + C0/C1/DEL sanitization (reuse SSOT).
// =====================================================================

test("M12-2A-C1: exact secret in last assistant text is redacted (compact available)", () => {
  const secret = "test-secret-c1"; // >=8 chars, unique; scan-safe marker (desensitization ALLOW)
  const raw = procResult([assistant(`result: LEAKED_SECRET=${secret} done`)]);
  const compact = projectCollectResult(raw, {
    runId: "run_c1", mode: "compact", env: { LEAKED_SECRET: secret },
  });
  assert.equal(compact.compactStatus, "available");
  const text = compact.messages[0].text;
  assert.ok(!text.includes(secret), "raw secret value must not appear");
  assert.ok(/\[REDACTED:/.test(text), "secret replaced with a redaction marker");
});

test("M12-2A-C2: C0/C1/DEL control chars sanitized; LF/TAB preserved (compact available)", () => {
  // eslint-disable-next-line no-control-regex
  const raw_text = "a\x00b\x01c\x7fd\x80e\x9ff\nnew\ttab"; // unsafe controls + LF + TAB
  const raw = procResult([assistant(raw_text)]);
  const compact = projectCollectResult(raw, { runId: "run_c2", mode: "compact" });
  assert.equal(compact.compactStatus, "available");
  const text = compact.messages[0].text;
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text), "no C0/DEL/C1 controls remain");
  assert.ok(text.includes("\n"), "LF preserved");
  assert.ok(text.includes("\t"), "TAB preserved");
  assert.ok(text.includes("\uFFFD"), "unsafe controls became replacement char");
});

// =====================================================================
// Section D — exact 4000 boundary: available vs too_large, zero partial.
// =====================================================================

test("M12-2A-D1: last text exactly COLLECT_MAX_TEXT_CHARS (4000) → available, full text", () => {
  const body = "A".repeat(COLLECT_MAX_TEXT_CHARS); // exactly 4000
  const raw = procResult([assistant("prefix"), assistant(body)]);
  const compact = projectCollectResult(raw, { runId: "run_d1", mode: "compact" });
  assert.equal(compact.compactStatus, "available");
  assert.equal(compact.messages.length, 1);
  assert.equal(compact.messages[0].text.length, COLLECT_MAX_TEXT_CHARS, "full 4000-char text");
  assert.equal(compact.messages[0].truncated, false);
});

test("M12-2A-D2: last text 4001 → too_large, ZERO partial, no cursor", () => {
  const body = "A".repeat(COLLECT_MAX_TEXT_CHARS + 1); // 4001
  const raw = procResult([assistant("prefix"), assistant(body)]);
  const compact = projectCollectResult(raw, { runId: "run_d2", mode: "compact" });
  assert.equal(compact.compactStatus, "too_large");
  assert.deepEqual(compact.messages, [], "no partial text on too_large");
  assert.equal(compact.assistantMessageCount, 2, "count still reported");
  assert.equal(compact.truncated, false);
  assert.equal(compact.nextCursor, null, "no cursor in too_large");
});

// =====================================================================
// Section E — empty state.
// =====================================================================

test("M12-2A-E1: no assistant text → empty, messages=[]", () => {
  const raw = procResult([user("prompt"), command("ls"), toolUse("Read", { file_path: "x" })]);
  const compact = projectCollectResult(raw, { runId: "run_e1", mode: "compact" });
  assert.equal(compact.compactStatus, "empty");
  assert.deepEqual(compact.messages, []);
  assert.equal(compact.assistantMessageCount, 0);
  assert.equal(compact.truncated, false);
  assert.equal(compact.nextCursor, null);
  // Counts still come from the full snapshot.
  assert.equal(compact.evidenceCounts.message, 1);
  assert.equal(compact.evidenceCounts.command, 1);
  assert.equal(compact.evidenceCounts.toolUse, 1);
});

// =====================================================================
// Section F — compact+cursor rejected BEFORE service/read/append.
// =====================================================================

test("M12-2A-F1: projection compact+cursor throws (defense-in-depth)", () => {
  const raw = procResult([assistant("x")]);
  assert.throws(
    () => projectCollectResult(raw, { runId: "run_f1", mode: "compact", cursor: "anytoken" }),
    /compact.*cursor|cursor.*compact/i,
    "compact+cursor must fail at the projection layer too",
  );
});

test("M12-2A-F2: MCP compact+cursor → service NOT called, fixed error, no leak", async () => {
  let callCount = 0;
  const fakeCollect = async () => { callCount += 1; return { data: [], reconstructed: true, backend: "process" }; };
  const server = createWaoMcpServer({
    registryPath: "/server/r.json", runDir: "/server/runs", collectRunMessagesFn: fakeCollect,
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_collect", arguments: { runId: "run_f2", mode: "compact", cursor: "anytoken" } });
    assert.equal(callCount, 0, "service must NOT be called for compact+cursor");
    assert.equal(res.isError, true, "compact+cursor flagged as error");
    const text = res.content.find((b) => b.type === "text").text;
    assert.equal(text, "run_collect failed", "fixed safe text only");
    assert.ok(!res.structuredContent, "no partial structuredContent");
  } finally {
    await client.close();
    await server.close();
  }
});

test("M12-2A-F3: CLI compact+cursor throws before any read (zero append)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m122a-f3-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, "run_f3",
      sessionHeader("run_f3") + msg("run_f3", "hello", 0) +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-28T00:10:00.000Z", runId: "run_f3", agentId: "researcher" }));
    const tpath = join(runDir, "run_f3.jsonl");
    const before = countAudits(tpath);
    await assert.rejects(
      () => collectCommand(["run_f3", "--mode", "compact", "--cursor", "anytoken", "--run-dir", runDir], { runDir }),
      /compact.*cursor|cursor.*compact/i,
    );
    assert.equal(countAudits(tpath), before, "compact+cursor appends zero before any read");
  } finally {
    rmrfRetry(dir);
  }
});

// =====================================================================
// Section G — illegal mode fails closed.
// =====================================================================

test("M12-2A-G1: MCP illegal mode value rejected, service not called", async () => {
  let callCount = 0;
  const fakeCollect = async () => { callCount += 1; return { data: [], reconstructed: true, backend: "process" }; };
  const server = createWaoMcpServer({
    registryPath: "/server/r.json", runDir: "/server/runs", collectRunMessagesFn: fakeCollect,
  });
  const client = await buildInMemoryClient(server);
  try {
    // Mirrors M9-4B-06: an input-schema violation (illegal enum value) is
    // rejected at the SDK input layer — either by throw or isError:true. The
    // exact collapse-to-fixed-text is a HANDLER concern (covered by J3/F2); the
    // input-layer contract here is: fail closed (service never called).
    let rejected = false;
    let result = null;
    try {
      result = await client.callTool({ name: "run_collect", arguments: { runId: "run_g1", mode: "summary" } });
    } catch {
      rejected = true;
    }
    if (!rejected) {
      assert.equal(result.isError, true, "illegal mode rejected (isError)");
      rejected = true;
    }
    assert.ok(rejected, "illegal mode rejected (throw or isError)");
    assert.equal(callCount, 0, "service never called for illegal mode");
  } finally {
    await client.close();
    await server.close();
  }
});

test("M12-2A-G2: CLI illegal --mode value throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m122a-g2-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, "run_g2",
      sessionHeader("run_g2") + msg("run_g2", "hi", 0) +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-28T00:10:00.000Z", runId: "run_g2", agentId: "researcher" }));
    await assert.rejects(
      () => collectCommand(["run_g2", "--mode", "summary", "--run-dir", runDir], { runDir }),
      /mode/i,
    );
  } finally {
    rmrfRetry(dir);
  }
});

// =====================================================================
// Section H — success appends 1 / failure appends 0 (compact non-idempotent).
// =====================================================================

test("M12-2A-H1: MCP compact SUCCESS appends exactly one audit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m122a-h1-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, "run_h1",
      sessionHeader("run_h1") + msg("run_h1", "final body", 0) +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-28T00:10:00.000Z", runId: "run_h1", agentId: "researcher" }));
    const tpath = join(runDir, "run_h1.jsonl");
    const server = createWaoMcpServer({ registryPath: "/server/r.json", runDir });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_collect", arguments: { runId: "run_h1", mode: "compact" } });
      assert.equal(res.isError, undefined, "compact success");
      const parsed = res.structuredContent;
      assert.equal(parsed.view, "compact");
      assert.equal(parsed.compactStatus, "available");
      assert.equal(parsed.assistantMessageCount, 1);
      assert.deepEqual(parsed.messages, [{ role: "assistant", text: "final body", truncated: false }]);
    } finally {
      await client.close();
      await server.close();
    }
    assert.equal(countAudits(tpath), 1, "exactly one audit for compact success");
  } finally {
    rmrfRetry(dir);
  }
});

test("M12-2A-H2: MCP compact where service fails appends ZERO", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m122a-h2-"));
  try {
    const runDir = join(dir, "runs");
    // Transcript with NO session.created → real service throws before any append.
    writeTranscript(runDir, "run_h2",
      jl({ type: "run.submitted", agentId: "researcher", ts: "2026-07-28T00:00:00.000Z" }) +
      msg("run_h2", "orphan body", 0));
    const tpath = join(runDir, "run_h2.jsonl");
    const server = createWaoMcpServer({ registryPath: "/server/r.json", runDir });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_collect", arguments: { runId: "run_h2", mode: "compact" } });
      assert.equal(res.isError, true, "service failure → error");
      assert.equal(res.content.find((b) => b.type === "text").text, "run_collect failed");
      assert.ok(!res.structuredContent, "no partial output on service failure");
    } finally {
      await client.close();
      await server.close();
    }
    assert.equal(countAudits(tpath), 0, "zero audit on service failure");
  } finally {
    rmrfRetry(dir);
  }
});

test("M12-2A-H3: CLI compact success appends 1; CLI compact failure appends 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m122a-h3-"));
  try {
    const runDir = join(dir, "runs");
    // success fixture
    writeTranscript(runDir, "run_h3ok",
      sessionHeader("run_h3ok") + msg("run_h3ok", "ok body", 0) +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-28T00:10:00.000Z", runId: "run_h3ok", agentId: "researcher" }));
    // failure fixture (no session → service throws)
    writeTranscript(runDir, "run_h3bad",
      jl({ type: "run.submitted", agentId: "researcher", ts: "2026-07-28T00:00:00.000Z" }) +
      msg("run_h3bad", "orphan", 0));

    const outOk = await captureLog(() => collectCommand(["run_h3ok", "--mode", "compact", "--run-dir", runDir], { runDir }));
    const parsedOk = JSON.parse(outOk);
    assert.equal(parsedOk.view, "compact");
    assert.equal(parsedOk.compactStatus, "available");
    assert.equal(countAudits(join(runDir, "run_h3ok.jsonl")), 1, "success → 1 audit");

    await assert.rejects(
      () => captureLog(() => collectCommand(["run_h3bad", "--mode", "compact", "--run-dir", runDir], { runDir })),
    );
    assert.equal(countAudits(join(runDir, "run_h3bad.jsonl")), 0, "failure → 0 audits");
  } finally {
    rmrfRetry(dir);
  }
});

// =====================================================================
// Section I — default full output: exact keys + pagination/cursor unchanged.
// =====================================================================

test("M12-2A-I1: MCP default (no mode) keeps exact full key set + pagination", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m122a-i1-"));
  try {
    const runDir = join(dir, "runs");
    const bodies = [];
    for (let i = 0; i < 12; i += 1) bodies.push(`i1-${i}`);
    writeTranscript(runDir, "run_i1",
      sessionHeader("run_i1") + bodies.map((b, i) => msg("run_i1", b, i)).join("") +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-28T00:10:00.000Z", runId: "run_i1", agentId: "researcher" }));
    const server = createWaoMcpServer({ registryPath: "/server/r.json", runDir });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_collect", arguments: { runId: "run_i1" } });
      const parsed = res.structuredContent;
      // Exact key set — NO compact fields leak into default full output.
      assert.deepEqual(
        Object.keys(parsed).sort(),
        ["agentId", "backend", "evidenceCounts", "itemCount", "messages", "nextCursor", "reconstructed", "runId", "truncated"].sort(),
      );
      assert.equal(parsed.view, undefined);
      assert.equal(parsed.compactStatus, undefined);
      assert.equal(parsed.assistantMessageCount, undefined);
      // Pagination unchanged: 12 messages → page 1 of 8 + cursor.
      assert.equal(parsed.messages.length, 8);
      assert.ok(parsed.nextCursor, "multi-page full still paginates");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmrfRetry(dir);
  }
});

test("M12-2A-I2: omitted mode deep-equals mode full (omitted ≡ full)", () => {
  const items = [];
  for (let i = 0; i < 12; i += 1) items.push(assistant(`p-${i}`));
  const raw = procResult(items);
  const omitted = projectCollectResult(raw, { runId: "run_i2" });
  const explicitFull = projectCollectResult(raw, { runId: "run_i2", mode: "full" });
  assert.deepEqual(omitted, explicitFull, "omitted mode ≡ explicit full");
});

test("M12-2A-I3: full projection never carries compact fields", () => {
  const raw = procResult([assistant("a"), assistant("b")]);
  const full = projectCollectResult(raw, { runId: "run_i3", mode: "full" });
  assert.equal(full.view, undefined);
  assert.equal(full.compactStatus, undefined);
  assert.equal(full.assistantMessageCount, undefined);
});

// =====================================================================
// Section J — real MCP Client wire schema + error fixed, no leak.
// =====================================================================

test("M12-2A-J1: run_collect wire inputSchema exposes mode enum [full,compact], strict", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m122a-j1-"));
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    const server = createWaoMcpServer({ registryPath: join(dir, "agents.json"), runDir: dir });
    const client = await buildInMemoryClient(server);
    try {
      const tools = await client.listTools();
      const rc = tools.tools.find((t) => t.name === "run_collect");
      const props = rc.inputSchema.properties ?? {};
      assert.deepEqual(Object.keys(props).sort(), ["cursor", "mode", "runId"].sort(), "input has runId + cursor + mode");
      assert.equal(rc.inputSchema.additionalProperties, false, "input strict");
      assert.deepEqual(props.mode.enum, ["full", "compact"], "mode is a closed-set enum");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("M12-2A-J2: run_collect wire outputSchema declares bounded optional compact fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m122a-j2-"));
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    const server = createWaoMcpServer({ registryPath: join(dir, "agents.json"), runDir: dir });
    const client = await buildInMemoryClient(server);
    try {
      const tools = await client.listTools();
      const rc = tools.tools.find((t) => t.name === "run_collect");
      const props = rc.outputSchema.properties ?? {};
      assert.ok(props.view, "output schema has optional view");
      // z.literal("compact") renders as JSON-Schema const (enum accepted too).
      assert.ok(props.view.const === "compact" || JSON.stringify(props.view.enum) === JSON.stringify(["compact"]), "view is literal 'compact'");
      assert.deepEqual(props.compactStatus.enum.sort(), ["available", "empty", "too_large"], "compactStatus closed set");
      assert.ok(props.assistantMessageCount, "output schema has assistantMessageCount");
      assert.equal(props.assistantMessageCount.type, "integer");
      assert.ok(props.assistantMessageCount.minimum === 0 || props.assistantMessageCount.minimum === undefined);
      assert.equal(rc.outputSchema.additionalProperties, false, "output strict");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("M12-2A-J3: compact error returns fixed text and leaks no secret/command/path", async () => {
  const secret = "test-secret-j3"; // >=8; scan-safe marker (desensitization ALLOW)
  let callCount = 0;
  // Service throws (simulating a projection/schema/service failure) carrying a
  // secret + path + command in its thrown detail. The handler must collapse it.
  const fakeCollect = async () => {
    callCount += 1;
    throw new Error(`boom ${secret} cmd=rm path=C:\\secret command=evil`);
  };
  const server = createWaoMcpServer({
    registryPath: "/server/r.json", runDir: "/server/runs", collectRunMessagesFn: fakeCollect,
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_collect", arguments: { runId: "run_j3", mode: "compact" } });
    assert.equal(callCount, 1);
    assert.equal(res.isError, true);
    const dumped = JSON.stringify(res);
    assert.equal(res.content.find((b) => b.type === "text").text, "run_collect failed");
    assert.ok(!dumped.includes(secret), "no secret leak");
    assert.ok(!/rm|evil|secret/i.test(dumped), "no command/path/secret detail leak");
    assert.ok(!res.structuredContent, "no partial structuredContent");
  } finally {
    await client.close();
    await server.close();
  }
});

// =====================================================================
// Section K — CLI compact parity, strict parser, default raw unchanged.
// =====================================================================

test("M12-2A-K1: CLI --mode compact --format json → compact payload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m122a-k1-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, "run_k1",
      sessionHeader("run_k1") + msg("run_k1", "alpha", 0) + msg("run_k1", "omega", 1) +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-28T00:10:00.000Z", runId: "run_k1", agentId: "researcher" }));
    const out = await captureLog(() => collectCommand(["run_k1", "--mode", "compact", "--format", "json", "--run-dir", runDir], { runDir }));
    const parsed = JSON.parse(out);
    assert.equal(parsed.view, "compact");
    assert.equal(parsed.compactStatus, "available");
    assert.equal(parsed.assistantMessageCount, 2);
    assert.deepEqual(parsed.messages, [{ role: "assistant", text: "omega", truncated: false }]);
    assert.equal(parsed.nextCursor, null);
  } finally {
    rmrfRetry(dir);
  }
});

test("M12-2A-K2: CLI --mode compact alone (no --format) engages projection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m122a-k2-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, "run_k2",
      sessionHeader("run_k2") + msg("run_k2", "only answer", 0) +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-28T00:10:00.000Z", runId: "run_k2", agentId: "researcher" }));
    const out = await captureLog(() => collectCommand(["run_k2", "--mode", "compact", "--run-dir", runDir], { runDir }));
    const parsed = JSON.parse(out);
    assert.equal(parsed.view, "compact");
    assert.deepEqual(parsed.messages, [{ role: "assistant", text: "only answer", truncated: false }]);
  } finally {
    rmrfRetry(dir);
  }
});

test("M12-2A-K3: CLI --mode full deep-equals --format json (machine-projection parity)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m122a-k3-"));
  try {
    const runDir = join(dir, "runs");
    const bodies = [];
    for (let i = 0; i < 12; i += 1) bodies.push(`k3-${i}`);
    writeTranscript(runDir, "run_k3a",
      sessionHeader("run_k3a") + bodies.map((b, i) => msg("run_k3a", b, i)).join("") +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-28T00:10:00.000Z", runId: "run_k3a", agentId: "researcher" }));
    writeTranscript(runDir, "run_k3b",
      sessionHeader("run_k3b") + bodies.map((b, i) => msg("run_k3b", b, i)).join("") +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-28T00:10:00.000Z", runId: "run_k3b", agentId: "researcher" }));
    const modeFull = JSON.parse(await captureLog(() => collectCommand(["run_k3a", "--mode", "full", "--run-dir", runDir], { runDir })));
    const fmtJson = JSON.parse(await captureLog(() => collectCommand(["run_k3b", "--format", "json", "--run-dir", runDir], { runDir })));
    // Same projection shape; only runId differs.
    assert.equal(modeFull.view, undefined);
    assert.equal(modeFull.messages.length, 8);
    assert.ok(modeFull.nextCursor);
    assert.deepEqual(modeFull.evidenceCounts, fmtJson.evidenceCounts);
    assert.deepEqual(modeFull.messages, fmtJson.messages);
    assert.equal(modeFull.truncated, fmtJson.truncated);
  } finally {
    rmrfRetry(dir);
  }
});

test("M12-2A-K4: CLI --mode with no value throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m122a-k4-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, "run_k4",
      sessionHeader("run_k4") + msg("run_k4", "x", 0) +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-28T00:10:00.000Z", runId: "run_k4", agentId: "researcher" }));
    await assert.rejects(
      () => collectCommand(["run_k4", "--mode", "--run-dir", runDir], { runDir }),
      /mode/i,
    );
  } finally {
    rmrfRetry(dir);
  }
});

test("M12-2A-K5: CLI unknown flag in projection mode is rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m122a-k5-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, "run_k5",
      sessionHeader("run_k5") + msg("run_k5", "x", 0) +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-28T00:10:00.000Z", runId: "run_k5", agentId: "researcher" }));
    // Bare --bogus (no value) so the unknown-flag path fires (a valued token
    // after an unknown flag would instead trip the positional guard).
    await assert.rejects(
      () => collectCommand(["run_k5", "--bogus", "--mode", "compact", "--run-dir", runDir], { runDir }),
      /unknown flag|--bogus/i,
    );
  } finally {
    rmrfRetry(dir);
  }
});

test("M12-2A-K6: CLI duplicate --mode throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m122a-k6-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, "run_k6",
      sessionHeader("run_k6") + msg("run_k6", "x", 0) +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-28T00:10:00.000Z", runId: "run_k6", agentId: "researcher" }));
    await assert.rejects(
      () => collectCommand(["run_k6", "--mode", "compact", "--mode", "full", "--run-dir", runDir], { runDir }),
      /duplicate/i,
    );
  } finally {
    rmrfRetry(dir);
  }
});

test("M12-2A-K7: default raw `collect <runId>` stays byte-compatible (no projection fields)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m122a-k7-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, "run_k7",
      sessionHeader("run_k7") + msg("run_k7", "one", 0) + msg("run_k7", "two", 1) +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-28T00:10:00.000Z", runId: "run_k7", agentId: "researcher" }));
    const out = await captureLog(() => collectCommand(["run_k7", "--run-dir", runDir], { runDir }));
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed.data), "raw data shape preserved");
    assert.equal(parsed.reconstructed, true);
    assert.equal(parsed.nextCursor, undefined, "no projection fields in raw mode");
    assert.equal(parsed.view, undefined);
    assert.equal(parsed.compactStatus, undefined);
    assert.equal(parsed.assistantMessageCount, undefined);
  } finally {
    rmrfRetry(dir);
  }
});

// =====================================================================
// Section L — serve sentinel fail-closed; compact never bypasses it.
// =====================================================================

test("M12-2A-L1: serve sentinel (>=10001) throws before projection — compact bypass impossible", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m122a-l1-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, "run_l1",
      sessionHeader("run_l1", "researcher", "opencode-serve", { serveUrl: "http://127.0.0.1:4297" }) +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-28T00:10:00.000Z", runId: "run_l1", agentId: "researcher" }));
    // Inject a serve fetch that returns the sentinel count.
    const fetchServe = async () => ({ data: Array(10001).fill(serveAssistant("x")) });
    // Projection mode (deferAppend) MUST hit the service sentinel and throw,
    // so projectCollectResult(compact) is never reached.
    await assert.rejects(
      () => collectRunMessages({ runId: "run_l1", runDir, deferAppend: true, fetchServeMessagesFn: fetchServe }),
      /serve snapshot exceeds safe capacity/,
    );
    assert.equal(countAudits(join(runDir, "run_l1.jsonl")), 0, "zero append on sentinel");
  } finally {
    rmrfRetry(dir);
  }
});

test("M12-2A-L2: MCP compact collapses serve-sentinel throw to fixed error, zero append", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m122a-l2-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, "run_l2",
      sessionHeader("run_l2", "researcher", "process") + msg("run_l2", "x", 0) +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-28T00:10:00.000Z", runId: "run_l2", agentId: "researcher" }));
    const tpath = join(runDir, "run_l2.jsonl");
    // Fake service throws the exact sentinel message.
    const fakeCollect = async () => { throw new Error("serve snapshot exceeds safe capacity"); };
    const server = createWaoMcpServer({ registryPath: "/server/r.json", runDir, collectRunMessagesFn: fakeCollect });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_collect", arguments: { runId: "run_l2", mode: "compact" } });
      assert.equal(res.isError, true);
      assert.equal(res.content.find((b) => b.type === "text").text, "run_collect failed");
      assert.ok(!res.structuredContent);
    } finally {
      await client.close();
      await server.close();
    }
    assert.equal(countAudits(tpath), 0, "zero append on sentinel via MCP");
  } finally {
    rmrfRetry(dir);
  }
});
