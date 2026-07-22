// test/runCollectReworkRed.test.js
//
// M11-4 CTO rework: independent RED reproduction of the four blockers.
// These tests are written BEFORE fixes — they MUST fail in a way that
// matches the CTO's diagnosis (not a tooling error). After fixes they
// become GREEN regression guards.

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

// Build a process transcript with N assistant messages.
function buildProcessTranscript(runDir, runId, messageCount, extraEvents = []) {
  mkdirSync(runDir, { recursive: true });
  const lines = [
    jl({ type: "run.submitted", agentId: "w", ts: "2026-07-22T00:00:00.000Z" }),
    jl({ type: "session.created", backend: "process", backendSessionId: "proc_redo", runId, agentId: "w" }),
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

function readAudits(transcriptPath) {
  try {
    return readFileSync(transcriptPath, "utf8").trim().split("\n")
      .filter((l) => l.includes('"messages.collected"')).length;
  } catch { return 0; }
}

// =====================================================================
// RED-1: 60 process assistant messages — default MCP/service path only
// yields the last 50. The first 10 are permanently unreachable.
// =====================================================================
test("M11-4-REWORK-RED-1: 60 messages via default MCP/service path — all 60 must be reachable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-red1-"));
  try {
    const runDir = join(dir, "runs");
    const runId = "run_red1";
    buildProcessTranscript(runDir, runId, 60);
    const transcriptPath = join(runDir, `${runId}.jsonl`);

    // Walk the full continuation chain via the projection layer (simulating
    // what the MCP handler does post-rework: service({deferAppend:true}) →
    // project → cursor). MCP/CLI projection mode ALWAYS defers append, so
    // the service returns the FULL snapshot (no pre-truncation).
    const collected = [];
    let cursor = null;
    let safety = 0;
    while (true) {
      const raw = await collectRunMessages({
        runId, runDir, cursor,
        deferAppend: true,
        appendCollectedFn: async () => {},
      });
      const page = projectCollectResult(raw, { runId, cursor });
      collected.push(...page.messages.map((m) => m.text));
      cursor = page.nextCursor;
      if (!cursor) break;
      safety += 1;
      if (safety > 20) throw new Error("runaway");
    }
    // MUST collect all 60, not just the last 50.
    assert.equal(collected.length, 60, `all 60 messages reachable (got ${collected.length})`);
    for (let i = 0; i < 60; i += 1) {
      assert.equal(collected[i], `m${i}`, `message ${i} present in order`);
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// RED-2: snapshot digest only covers assistant text. Adding command/tool
// events after page 1 is accepted by the same cursor, and evidenceCounts/
// itemCount drift — violating "stable full-snapshot statistics".
// =====================================================================
test("M11-4-REWORK-RED-2: evidenceCounts/itemCount must not drift when non-text events are added after page 1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-red2-"));
  try {
    const runDir = join(dir, "runs");
    const runId = "run_red2";
    // Start with 10 assistant messages + 0 command events.
    buildProcessTranscript(runDir, runId, 10, []);
    const transcriptPath = join(runDir, `${runId}.jsonl`);

    // Page 1 (deferred append to avoid polluting the snapshot).
    const raw1 = await collectRunMessages({
      runId, runDir, cursor: null,
      appendCollectedFn: async () => {},
    });
    const page1 = projectCollectResult(raw1, { runId });
    const page1Command = page1.evidenceCounts.command;
    const page1Item = page1.itemCount;
    assert.ok(page1.nextCursor, "page 1 has a cursor (10 messages > 8 cap)");
    const cursor = page1.nextCursor;

    // Rewrite the transcript to INSERT a new command event before the
    // terminal state_change (simulating a worker still emitting evidence).
    // The frozen page-1 cursor must reject this mutated snapshot OR keep
    // statistics frozen at page-1 values — it must NOT silently accept the
    // new command into evidenceCounts/itemCount.
    const events = readFileSync(transcriptPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const insertIdx = events.findIndex((e) => e.type === "run.state_change");
    events.splice(insertIdx, 0, {
      type: "run.event", kind: "command", command: "rg foo", exitCode: 0,
      ts: "2026-07-22T00:09:00.000Z", runId, agentId: "w",
    });
    writeFileSync(transcriptPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    // Page 2 with the SAME cursor — evidenceCounts/itemCount must NOT drift.
    const raw2 = await collectRunMessages({
      runId, runDir, cursor,
      appendCollectedFn: async () => {},
    });
    const page2 = projectCollectResult(raw2, { runId, cursor });
    assert.equal(page2.evidenceCounts.command, page1Command,
      `command count frozen at page-1 value (${page1Command}), got ${page2.evidenceCounts.command}`);
    assert.equal(page2.itemCount, page1Item,
      `itemCount frozen at page-1 value (${page1Item}), got ${page2.itemCount}`);
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// RED-3: cursor-less page 1 — when projection/schema fails AFTER the
// service succeeded, the audit event must NOT be appended.
// =====================================================================
test("M11-4-REWORK-RED-3: cursor-less page 1 projection/schema failure → zero audit append", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-red3-"));
  try {
    const runDir = join(dir, "runs");
    const runId = "run_red3";
    buildProcessTranscript(runDir, runId, 1);
    const transcriptPath = join(runDir, `${runId}.jsonl`);
    const auditsBefore = readAudits(transcriptPath);

    // Inject a service that returns a result which will FAIL projection:
    // a result whose data is not an array. The MCP handler wraps the whole
    // thing in try/catch and must produce ZERO audit append on failure.
    const server = createWaoMcpServer({
      registryPath: "/server/r.json", runDir,
      collectRunMessagesFn: async () => ({ data: "NOT_AN_ARRAY_WILL_FAIL_PROJECTION", reconstructed: true, backend: "process" }),
    });
    const { Client } = await import("@modelcontextprotocol/sdk/client");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      const res = await client.callTool({ name: "run_collect", arguments: { runId } });
      assert.equal(res.isError, true, "page 1 projection failure → isError");
      assert.ok(/run_collect failed/.test(res.content.find((b) => b.type === "text").text));
    } finally {
      await client.close();
      await server.close();
    }
    const auditsAfter = readAudits(transcriptPath);
    assert.equal(auditsAfter, auditsBefore,
      `zero audit append on page-1 projection failure (before=${auditsBefore}, after=${auditsAfter})`);
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// RED-4: CLI `collect <runId> --cursor` with no value silently runs raw
// collect and appends an audit event. Must be rejected before any read.
// =====================================================================
test("M11-4-REWORK-RED-4: CLI `--cursor` with no value rejected before read/append", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-red4-"));
  try {
    const runDir = join(dir, "runs");
    const runId = "run_red4";
    buildProcessTranscript(runDir, runId, 1);
    const transcriptPath = join(runDir, `${runId}.jsonl`);
    const auditsBefore = readAudits(transcriptPath);

    const { collectCommand } = await import("../src/commands/observe.js");
    let threw = false;
    try {
      // --cursor with NO following value (parseOptions sets cursor=true).
      await collectCommand([runId, "--cursor", "--run-dir", runDir], { runDir });
    } catch {
      threw = true;
    }
    assert.ok(threw, "--cursor with no value must throw, not silently run raw collect");
    const auditsAfter = readAudits(transcriptPath);
    assert.equal(auditsAfter, auditsBefore,
      `zero audit append when --cursor has no value (before=${auditsBefore}, after=${auditsAfter})`);
  } finally {
    cleanupDir(dir);
  }
});
