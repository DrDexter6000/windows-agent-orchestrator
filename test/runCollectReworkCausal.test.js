// test/runCollectReworkCausal.test.js
//
// M11-4 CTO rework: causal test matrix proving the four blockers are fixed
// AND the full continuation contract holds end-to-end. These are the
// long-term regression guards (the RED reproductions live alongside in
// runCollectReworkRed.test.js).
//
// Coverage map (CTO rework requirements):
//   - default service/MCP path ≥60 messages, all read exactly once (RED-1 GREEN)
//   - process AND serve (mocked HTTP boundary) continuation >50 messages
//   - command/tool/file evidence frozen across pages (RED-2 GREEN)
//   - cursor-less AND cursor continuation projection/schema failure → zero append (RED-3 GREEN + cursor variant)
//   - --cursor missing value rejected before read/append (RED-4 GREEN)
//   - Host restart cursor recovery
//   - legacy raw CLI default + limit=0 unchanged

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectRunMessages } from "../src/application/runCollect.js";
import { projectCollectResult } from "../src/application/runCollectProjection.js";
import { createWaoMcpServer } from "../src/mcp/server.js";

// ===== Helpers =====

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function jl(obj) { return JSON.stringify(obj) + "\n"; }

function buildProcessTranscript(runDir, runId, messageCount, extraEvents = []) {
  mkdirSync(runDir, { recursive: true });
  const lines = [
    jl({ type: "run.submitted", agentId: "w", ts: "2026-07-22T00:00:00.000Z" }),
    jl({ type: "session.created", backend: "process", backendSessionId: "proc_causal", runId, agentId: "w" }),
    jl({ type: "run.started", backend: "claude-code", ts: "2026-07-22T00:00:01.000Z", runId, agentId: "w" }),
  ];
  for (const e of extraEvents) lines.push(jl(e));
  for (let i = 0; i < messageCount; i += 1) {
    lines.push(jl({
      type: "run.event", kind: "message", role: "assistant",
      parts: [{ type: "text", text: `m${i}` }],
      ts: `2026-07-22T00:00:${10 + i}.000Z`, runId, agentId: "w",
    }));
  }
  lines.push(jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-22T00:10:00.000Z", runId, agentId: "w" }));
  writeFileSync(join(runDir, `${runId}.jsonl`), lines.join(""), "utf8");
}

function buildServeTranscript(runDir, runId) {
  mkdirSync(runDir, { recursive: true });
  const lines = [
    jl({ type: "run.submitted", agentId: "w", ts: "2026-07-22T00:00:00.000Z" }),
    jl({ type: "session.created", backend: "opencode-serve", backendSessionId: "srv_causal", serveUrl: "http://127.0.0.1:4298", runId, agentId: "w" }),
    jl({ type: "run.started", backend: "opencode-serve", ts: "2026-07-22T00:00:01.000Z", runId, agentId: "w" }),
    jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-22T00:10:00.000Z", runId, agentId: "w" }),
  ];
  writeFileSync(join(runDir, `${runId}.jsonl`), lines.join(""), "utf8");
}

// Serve fetch mock that simulates the OpenCode serve /message HTTP boundary:
// it receives a `limit` query param and returns up to that many messages.
// This proves the service passes SERVE_PROJECTION_LIMIT (not 50) in
// projection mode, so the full list is retrieved in one call.
function buildMockServeFetch(totalMessages) {
  return async (_serveUrl, _sessionId, opts) => {
    const limit = Number(opts?.limit ?? 50);
    // Serve semantics: return the LAST `limit` messages (matching real
    // OpenCode serve /message?limit=N behavior).
    const all = [];
    for (let i = 0; i < totalMessages; i += 1) {
      all.push({
        info: { role: "assistant" },
        parts: [{ type: "text", text: `serve-m${i}` }],
      });
    }
    const data = all.slice(-limit);
    return { data, cursor: { previous: null, next: null } };
  };
}

function readAuditCount(transcriptPath) {
  try {
    return readFileSync(transcriptPath, "utf8").trim().split("\n")
      .filter((l) => l.includes('"messages.collected"')).length;
  } catch { return 0; }
}

// =====================================================================
// CAUSAL-1: process path — 60 messages all reachable, exactly once, ordered.
// =====================================================================
test("M11-4-CAUSAL-1: process 60 messages via service+projection — all 60 read exactly once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-causal1-"));
  try {
    const runDir = join(dir, "runs");
    const runId = "run_causal1";
    buildProcessTranscript(runDir, runId, 60);
    const collected = [];
    let cursor = null;
    let pages = 0;
    while (true) {
      const raw = await collectRunMessages({
        runId, runDir, cursor, deferAppend: true,
        appendCollectedFn: async () => {},
      });
      const page = projectCollectResult(raw, { runId, cursor });
      collected.push(...page.messages.map((m) => m.text));
      cursor = page.nextCursor;
      pages += 1;
      if (!cursor) break;
      if (pages > 20) throw new Error("runaway");
    }
    assert.equal(collected.length, 60, "all 60 reachable");
    for (let i = 0; i < 60; i += 1) assert.equal(collected[i], `m${i}`, `msg ${i} in order`);
    assert.ok(pages >= 2, `multi-page (${pages})`);
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// CAUSAL-2: serve path (mocked HTTP boundary) — 60 messages retrieved in
// one call (SERVE_PROJECTION_LIMIT), all reachable via continuation.
// =====================================================================
test("M11-4-CAUSAL-2: serve 60 messages via mocked HTTP boundary — full retrieval + continuation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-causal2-"));
  try {
    const runDir = join(dir, "runs");
    const runId = "run_causal2";
    buildServeTranscript(runDir, runId);
    const fetchCalls = [];
    const fetchFn = async (url, sid, opts) => {
      fetchCalls.push({ limit: opts?.limit });
      return buildMockServeFetch(60)(url, sid, opts);
    };

    const collected = [];
    let cursor = null;
    let pages = 0;
    while (true) {
      const raw = await collectRunMessages({
        runId, runDir, cursor, deferAppend: true,
        fetchServeMessagesFn: fetchFn,
        appendCollectedFn: async () => {},
      });
      const page = projectCollectResult(raw, { runId, cursor });
      collected.push(...page.messages.map((m) => m.text));
      cursor = page.nextCursor;
      pages += 1;
      if (!cursor) break;
      if (pages > 20) throw new Error("runaway");
    }
    assert.equal(collected.length, 60, "all 60 serve messages reachable");
    for (let i = 0; i < 60; i += 1) assert.equal(collected[i], `serve-m${i}`, `serve msg ${i} in order`);
    // Every fetch must have used a large limit (projection mode), NOT 50.
    for (const c of fetchCalls) {
      assert.ok(c.limit > 50, `serve fetch used projection limit >50 (got ${c.limit})`);
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// CAUSAL-3: evidence counts frozen across pages when new command/tool/file
// events appear after page 1. (RED-2 GREEN guard.)
// =====================================================================
test("M11-4-CAUSAL-3: evidenceCounts/itemCount frozen across pages despite new evidence after page 1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-causal3-"));
  try {
    const runDir = join(dir, "runs");
    const runId = "run_causal3";
    buildProcessTranscript(runDir, runId, 10, [
      { type: "run.event", kind: "command", command: "rg init", exitCode: 0, ts: "2026-07-22T00:00:05.000Z", runId, agentId: "w" },
    ]);
    const transcriptPath = join(runDir, `${runId}.jsonl`);

    const raw1 = await collectRunMessages({
      runId, runDir, cursor: null, deferAppend: true,
      appendCollectedFn: async () => {},
    });
    const page1 = projectCollectResult(raw1, { runId });
    const p1Command = page1.evidenceCounts.command;
    const p1Item = page1.itemCount;
    assert.equal(p1Command, 1, "page 1 sees 1 command");
    assert.ok(page1.nextCursor);

    // Insert a NEW tool_use + file_written before terminal state_change.
    const events = readFileSync(transcriptPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const insertIdx = events.findIndex((e) => e.type === "run.state_change");
    events.splice(insertIdx, 0,
      { type: "run.event", kind: "tool_use", tool: "Edit", input: { file_path: "a.js" }, ts: "2026-07-22T00:09:30.000Z", runId, agentId: "w" },
      { type: "run.event", kind: "file_written", path: "out.txt", ts: "2026-07-22T00:09:45.000Z", runId, agentId: "w" },
    );
    writeFileSync(transcriptPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    const raw2 = await collectRunMessages({
      runId, runDir, cursor: page1.nextCursor, deferAppend: true,
      appendCollectedFn: async () => {},
    });
    const page2 = projectCollectResult(raw2, { runId, cursor: page1.nextCursor });
    assert.equal(page2.evidenceCounts.command, p1Command, "command count frozen");
    assert.equal(page2.evidenceCounts.toolUse, 0, "toolUse frozen at 0 (new tool_use not counted)");
    assert.equal(page2.evidenceCounts.fileWritten, 0, "fileWritten frozen at 0");
    assert.equal(page2.itemCount, p1Item, "itemCount frozen");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// CAUSAL-4: cursor-less page 1 projection/schema failure → zero audit.
// (RED-3 GREEN guard.)
// =====================================================================
test("M11-4-CAUSAL-4: cursor-less page 1 MCP projection failure → zero audit append", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-causal4-"));
  try {
    const runDir = join(dir, "runs");
    const runId = "run_causal4";
    buildProcessTranscript(runDir, runId, 1);
    const transcriptPath = join(runDir, `${runId}.jsonl`);
    const before = readAuditCount(transcriptPath);

    const server = createWaoMcpServer({
      registryPath: "/server/r.json", runDir,
      collectRunMessagesFn: async () => ({ data: "NOT_ARRAY", reconstructed: true, backend: "process" }),
    });
    const { Client } = await import("@modelcontextprotocol/sdk/client");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      const res = await client.callTool({ name: "run_collect", arguments: { runId } });
      assert.equal(res.isError, true, "projection failure → isError");
    } finally {
      await client.close();
      await server.close();
    }
    const after = readAuditCount(transcriptPath);
    assert.equal(after, before, `zero audit append on page-1 failure (before=${before}, after=${after})`);
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// CAUSAL-5: cursor continuation projection failure → zero audit.
// =====================================================================
test("M11-4-CAUSAL-5: cursor continuation MCP projection failure → zero audit append", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-causal5-"));
  try {
    const runDir = join(dir, "runs");
    const runId = "run_causal5";
    buildProcessTranscript(runDir, runId, 10);
    const transcriptPath = join(runDir, `${runId}.jsonl`);

    // Get a valid cursor from page 1.
    const server1 = createWaoMcpServer({ registryPath: "/server/r.json", runDir });
    const { Client } = await import("@modelcontextprotocol/sdk/client");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const client1 = new Client({ name: "t", version: "0" }, { capabilities: {} });
    const [c1, s1] = InMemoryTransport.createLinkedPair();
    await Promise.all([server1.connect(s1), client1.connect(c1)]);
    let cursor;
    try {
      const res = await client1.callTool({ name: "run_collect", arguments: { runId } });
      cursor = JSON.parse(res.content.find((b) => b.type === "text").text).nextCursor;
    } finally {
      await client1.close();
      await server1.close();
    }
    const before = readAuditCount(transcriptPath);

    // Page 2 with a service that returns malformed data → projection fails.
    const server2 = createWaoMcpServer({
      registryPath: "/server/r.json", runDir,
      collectRunMessagesFn: async () => ({ data: "NOT_ARRAY", reconstructed: true, backend: "process" }),
    });
    const client2 = new Client({ name: "t", version: "0" }, { capabilities: {} });
    const [c2, s2] = InMemoryTransport.createLinkedPair();
    await Promise.all([server2.connect(s2), client2.connect(c2)]);
    try {
      const res = await client2.callTool({ name: "run_collect", arguments: { runId, cursor } });
      assert.equal(res.isError, true, "cursor page projection failure → isError");
    } finally {
      await client2.close();
      await server2.close();
    }
    const after = readAuditCount(transcriptPath);
    assert.equal(after, before, `zero audit append on cursor failure (before=${before}, after=${after})`);
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// CAUSAL-6: successful pages each append exactly one audit event.
// =====================================================================
test("M11-4-CAUSAL-6: successful pages each append exactly one audit event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-causal6-"));
  try {
    const runDir = join(dir, "runs");
    const runId = "run_causal6";
    buildProcessTranscript(runDir, runId, 20);  // 3 pages (8+8+4)
    const transcriptPath = join(runDir, `${runId}.jsonl`);

    let cursor = null;
    let pages = 0;
    while (true) {
      const raw = await collectRunMessages({ runId, runDir, cursor, deferAppend: true });
      const page = projectCollectResult(raw, { runId, cursor });
      if (typeof raw.commitAppend === "function") await raw.commitAppend();
      cursor = page.nextCursor;
      pages += 1;
      if (!cursor) break;
      if (pages > 10) throw new Error("runaway");
    }
    const audits = readAuditCount(transcriptPath);
    assert.equal(pages, 3, "3 pages");
    assert.equal(audits, 3, "exactly 3 audit events for 3 successful pages");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// CAUSAL-7: CLI --cursor with no value rejected before read/append.
// (RED-4 GREEN guard.)
// =====================================================================
test("M11-4-CAUSAL-7: CLI --cursor no value rejected before read/append", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-causal7-"));
  try {
    const runDir = join(dir, "runs");
    const runId = "run_causal7";
    buildProcessTranscript(runDir, runId, 1);
    const transcriptPath = join(runDir, `${runId}.jsonl`);
    const before = readAuditCount(transcriptPath);

    const { collectCommand } = await import("../src/commands/observe.js");
    let threw = false;
    try {
      await collectCommand([runId, "--cursor", "--run-dir", runDir], { runDir });
    } catch {
      threw = true;
    }
    assert.ok(threw, "--cursor with no value must throw");
    assert.equal(readAuditCount(transcriptPath), before, "zero audit append");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// CAUSAL-8: CLI --format json with no value rejected.
// =====================================================================
test("M11-4-CAUSAL-8: CLI --format no value rejected before read/append", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-causal8-"));
  try {
    const runDir = join(dir, "runs");
    const runId = "run_causal8";
    buildProcessTranscript(runDir, runId, 1);
    const { collectCommand } = await import("../src/commands/observe.js");
    let threw = false;
    try {
      await collectCommand([runId, "--format", "--run-dir", runDir], { runDir });
    } catch {
      threw = true;
    }
    assert.ok(threw, "--format with no value must throw");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// CAUSAL-9: CLI --limit rejected in projection mode.
// =====================================================================
test("M11-4-CAUSAL-9: CLI --limit rejected in projection mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-causal9-"));
  try {
    const runDir = join(dir, "runs");
    const runId = "run_causal9";
    buildProcessTranscript(runDir, runId, 1);
    const { collectCommand } = await import("../src/commands/observe.js");
    // --limit + --format json (projection mode) → reject.
    let threw = false;
    try {
      await collectCommand([runId, "--limit", "10", "--format", "json", "--run-dir", runDir], { runDir });
    } catch {
      threw = true;
    }
    assert.ok(threw, "--limit must be rejected in projection mode");
    // --limit alone (raw mode) → allowed (legacy).
    let rawOk = true;
    try {
      await collectCommand([runId, "--limit", "10", "--run-dir", runDir], { runDir });
    } catch {
      rawOk = false;
    }
    assert.ok(rawOk, "--limit allowed in legacy raw mode");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// CAUSAL-10: Host restart — cursor survives a fresh process boundary.
// (Already covered by stdio smoke; this is the application-layer unit proof.)
// =====================================================================
test("M11-4-CAUSAL-10: cursor decodes on fresh call (Host restart recovery)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-causal10-"));
  try {
    const runDir = join(dir, "runs");
    const runId = "run_causal10";
    buildProcessTranscript(runDir, runId, 10);
    const raw1 = await collectRunMessages({
      runId, runDir, cursor: null, deferAppend: true,
      appendCollectedFn: async () => {},
    });
    const page1 = projectCollectResult(raw1, { runId });
    assert.ok(page1.nextCursor);
    // Simulate restart: do NOT reuse any closure. A fresh service call with
    // the opaque cursor must resume correctly.
    const raw2 = await collectRunMessages({
      runId, runDir, cursor: page1.nextCursor, deferAppend: true,
      appendCollectedFn: async () => {},
    });
    const page2 = projectCollectResult(raw2, { runId, cursor: page1.nextCursor });
    assert.equal(page1.messages.length + page2.messages.length, 10);
    assert.equal(page2.nextCursor, null);
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// CAUSAL-11: legacy raw CLI default mode still honors limit (byte-compat).
// =====================================================================
test("M11-4-CAUSAL-11: legacy raw collect honors limit=0 (all) and default tail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-causal11-"));
  try {
    const runDir = join(dir, "runs");
    const runId = "run_causal11";
    buildProcessTranscript(runDir, runId, 60);
    // limit=0 → all 60 (legacy semantics: slice(-0) returns everything).
    const raw0 = await collectRunMessages({ runId, runDir, limit: 0, deferAppend: false, appendCollectedFn: async () => {} });
    assert.equal(raw0.data.length, 60, "limit=0 returns all 60");
    // default limit (50) → last 50 (legacy tail).
    const raw50 = await collectRunMessages({ runId, runDir, deferAppend: false, appendCollectedFn: async () => {} });
    assert.equal(raw50.data.length, 50, "default limit returns last 50");
  } finally {
    cleanupDir(dir);
  }
});
