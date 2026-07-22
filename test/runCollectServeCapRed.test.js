// test/runCollectServeCapRed.test.js
//
// M11-4 final serve-cap closeout: serve silent-truncation boundary tests.
//
// WAO's current OpenCodeServeBackend.messages adapter issues a single bounded
// `limit` request (it does not consume OpenCode's upstream `before` /
// X-Next-Cursor pagination). If a run has more items than the projection-mode
// cap, the earliest assistant message would be silently dropped AND the
// projection would report nextCursor:null (a false "complete read"). These
// tests prove the fail-closed contract of WAO's current adapter strategy:
//   - 9999 / 10000 items → complete success
//   - 10001+ items → fixed `run_collect failed`, zero partial, zero append
//
// All tests use a REAL stdio MCP subprocess + a REAL local HTTP server
// simulating OpenCode serve /message, so the default OpenCodeServeBackend
// HTTP boundary is exercised (not a fake service).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SHIM = join(REPO_ROOT, "scripts", "wao-node.cjs");
const STDIO_ENTRY = join(REPO_ROOT, "src", "mcp", "stdio.js");

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

async function buildStdioClient({ registryPath, runDir }) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const childEnv = { ...process.env, WAO_SKIP_VERSION_GUARD: "1" };
  const args = [SHIM, STDIO_ENTRY, "--registry", registryPath, "--run-dir", runDir];
  const transport = new StdioClientTransport({ command: process.execPath, args, env: childEnv });
  const client = new Client({ name: "wao-serve-cap", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

// Build a serve fixture with `total` items. Item 0 is the ONLY assistant
// message ("the-answer"); items 1..total-1 are non-assistant evidence.
// Serve returns the LAST `limit` items (real OpenCode semantics).
async function withServeHttpServer(total, fn) {
  const { createServer } = await import("node:http");
  const httpServer = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const all = [];
    all.push({ info: { role: "assistant" }, parts: [{ type: "text", text: "the-answer" }] });
    for (let i = 1; i < total; i += 1) {
      all.push({ info: { role: "user" }, parts: [{ type: "text", text: `u${i}` }] });
    }
    const data = all.slice(-limit);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
  });
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = httpServer.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((r) => httpServer.close(r));
  }
}

async function runCollectOverStdio({ runDir, runId, serveUrl }) {
  // Patch the transcript's serveUrl to the real local port.
  const tpath = join(runDir, `${runId}.jsonl`);
  const lines = readFileSync(tpath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  for (const l of lines) { if (l.type === "session.created") l.serveUrl = serveUrl; }
  writeFileSync(tpath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  // Use a shared registry dir (the agents.json lives next to runDir's parent).
  const registryPath = join(resolve(runDir, ".."), "agents.json");
  const handle = await buildStdioClient({ registryPath, runDir });
  try {
    return await handle.client.callTool({ name: "run_collect", arguments: { runId } });
  } finally {
    await handle.client.close();
    await handle.transport.close();
  }
}

function makeServeFixture(dir, runId) {
  const runDir = join(dir, "runs");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, `${runId}.jsonl`), [
    JSON.stringify({ type: "run.submitted", agentId: "w", ts: "2026-07-22T00:00:00.000Z" }),
    JSON.stringify({ type: "session.created", backend: "opencode-serve", backendSessionId: "srv_cap", serveUrl: "http://127.0.0.1:0", runId, agentId: "w" }),
    JSON.stringify({ type: "run.started", backend: "opencode-serve", ts: "2026-07-22T00:00:01.000Z", runId, agentId: "w" }),
    JSON.stringify({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-22T00:10:00.000Z", runId, agentId: "w" }),
  ].map((l) => l + "\n").join(""), "utf8");
  writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { w: { backend: "opencode-serve", cwd: dir } } }), "utf8");
  return runDir;
}

function countAudits(transcriptPath) {
  try {
    return readFileSync(transcriptPath, "utf8").trim().split("\n")
      .filter((l) => l.includes('"messages.collected"')).length;
  } catch { return 0; }
}

// ---------------------------------------------------------------------
// CAP-9999: 9999 serve items → complete success, assistant message present.
// ---------------------------------------------------------------------
test("M11-4-SERVE-CAP-9999: 9999 items → complete success, the-answer present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-cap9999-"));
  try {
    const runId = "run_cap9999";
    const runDir = makeServeFixture(dir, runId);
    await withServeHttpServer(9999, async (serveUrl) => {
      const res = await runCollectOverStdio({ runDir, runId, serveUrl });
      assert.equal(res.isError, undefined, "9999 items must succeed");
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.ok(parsed.messages.some((m) => m.text === "the-answer"), "the-answer present");
      assert.equal(parsed.nextCursor, null, "single-page terminal");
      // messages array holds ONLY assistant text extracts; evidenceCounts.message
      // counts every message-shape item (incl. user). Here 1 assistant → 1 text.
      assert.equal(parsed.messages.length, 1, "1 assistant text extracted");
    });
    // Successful page appended exactly one audit.
    assert.equal(countAudits(join(runDir, `${runId}.jsonl`)), 1, "1 audit for success");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// CAP-10000: 10000 items (exactly at cap) → complete success.
// ---------------------------------------------------------------------
test("M11-4-SERVE-CAP-10000: 10000 items (at cap) → complete success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-cap10000-"));
  try {
    const runId = "run_cap10000";
    const runDir = makeServeFixture(dir, runId);
    await withServeHttpServer(10000, async (serveUrl) => {
      const res = await runCollectOverStdio({ runDir, runId, serveUrl });
      assert.equal(res.isError, undefined, "10000 items (at cap) must succeed");
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.ok(parsed.messages.some((m) => m.text === "the-answer"), "the-answer present at cap");
    });
    assert.equal(countAudits(join(runDir, `${runId}.jsonl`)), 1, "1 audit for success");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// CAP-10001 (RED→GREEN): 10001 items → fail closed, zero partial, zero append.
// ---------------------------------------------------------------------
test("M11-4-SERVE-CAP-10001: 10001 items → fail closed, zero partial, zero append", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-cap10001-"));
  try {
    const runId = "run_cap10001";
    const runDir = makeServeFixture(dir, runId);
    const tpath = join(runDir, `${runId}.jsonl`);
    const auditsBefore = countAudits(tpath);
    await withServeHttpServer(10001, async (serveUrl) => {
      const res = await runCollectOverStdio({ runDir, runId, serveUrl });
      assert.equal(res.isError, true, "10001 items must fail closed");
      const text = res.content.find((b) => b.type === "text").text;
      assert.ok(/run_collect failed/.test(text), "fixed safe text");
      assert.ok(!res.structuredContent, "no partial structuredContent");
      const dumped = JSON.stringify(res);
      assert.ok(!/the-answer/.test(dumped), "no partial message leak");
      assert.ok(!/nextCursor/.test(dumped) || /null/.test(res.structuredContent?.nextCursor ?? "null"),
        "no false nextCursor");
    });
    const auditsAfter = countAudits(tpath);
    assert.equal(auditsAfter, auditsBefore, `zero audit append on cap failure (before=${auditsBefore}, after=${auditsAfter})`);
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// CAP-10001-ASSISTANT-FIRST: 10001 items where the dropped item is the ONLY
// assistant message — the exact CTO probe shape. Proves the fail-closed
// contract catches the worst case (answer permanently lost without it).
// (This is the original RED; kept as the canonical regression guard.)
// ---------------------------------------------------------------------
test("M11-4-SERVE-CAP-10001-ASSISTANT-FIRST: earliest assistant lost → fail closed (CTO probe shape)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-cap10001-af-"));
  try {
    const runId = "run_cap10001_af";
    const runDir = makeServeFixture(dir, runId);
    await withServeHttpServer(10001, async (serveUrl) => {
      const res = await runCollectOverStdio({ runDir, runId, serveUrl });
      assert.equal(res.isError, true, "fail closed");
      assert.ok(/run_collect failed/.test(res.content.find((b) => b.type === "text").text));
    });
  } finally {
    cleanupDir(dir);
  }
});
