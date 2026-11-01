// test/runCollect.test.js
//
// M9-4A: shared run collection application service — TDD tests.
//
// Proves that CLI collect logic (transcript reconstruction +
// messages.collected durable fact) is extracted into a shared, argv-free,
// console-free, MCP-free application service. The algorithm exists exactly once;
// CLI and MCP both call it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectRunMessages } from "../../src/application/runCollect.js";
import { readTranscript, findState, findLatest } from "../../src/transcript.js";

// ===== Helpers =====

function writeTranscript(dir, runId, lines) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.jsonl`), lines, "utf8");
}

function jl(obj) {
  return JSON.stringify(obj) + "\n";
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// A process-backed transcript with mixed run.event kinds.
function processTranscript(runId, eventLines) {
  return [
    jl({ type: "run.submitted", agentId: "researcher", ts: "2026-06-28T20:33:52.000Z" }),
    jl({ type: "session.created", backend: "process", backendSessionId: "proc_4242", runId, agentId: "researcher" }),
    jl({ type: "run.started", backend: "claude-code", ts: "2026-06-28T20:33:53.000Z", runId, agentId: "researcher" }),
    ...eventLines,
    jl({ type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-06-28T20:35:00.000Z", runId, agentId: "researcher" }),
  ].join("");
}

const PROCESS_EVENTS = [
  jl({ type: "run.event", kind: "command", command: "rg TODO", exitCode: 0, ts: "2026-06-28T20:34:05.000Z", runId: "run_proc", agentId: "researcher" }),
  jl({ type: "run.event", kind: "tool_use", tool: "Read", input: { file_path: "src/app.py" }, ts: "2026-06-28T20:34:10.000Z", runId: "run_proc", agentId: "researcher" }),
  jl({ type: "run.event", kind: "tool_result", tool: "Read", output: "def main():...", isError: false, ts: "2026-06-28T20:34:11.000Z", runId: "run_proc", agentId: "researcher" }),
  jl({ type: "run.event", kind: "file_written", path: "D:/proj/report.md", ts: "2026-06-28T20:34:30.000Z", runId: "run_proc", agentId: "researcher" }),
  jl({ type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "done" }], ts: "2026-06-28T20:34:20.000Z", runId: "run_proc", agentId: "researcher" }),
];

function readTranscriptSync(p) {
  try {
    return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// ===== Tests =====

// ---------------------------------------------------------------------
// M9-4A-01: process fixture — all kinds reconstructed, order + limit + output compatible.
// ---------------------------------------------------------------------

test("M9-4A-01: process collect reconstructs all kinds in order, limit applied", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m94a-01-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, "run_proc", processTranscript("run_proc", PROCESS_EVENTS));
    const result = await collectRunMessages({ runId: "run_proc", runDir });

    assert.equal(result.backend, "process", "backend is process");
    assert.equal(result.reconstructed, true, "reconstructed flag");
    assert.ok(Array.isArray(result.data), "data is array");
    assert.equal(result.data.length, 5, "all 5 events reconstructed");

    // Order preserved (chronological as in transcript).
    const kinds = result.data.map((e) => e.kind);
    assert.deepEqual(kinds, ["command", "tool_use", "tool_result", "file_written", "message"]);

    // Field compatibility with existing CLI output.
    const cmd = result.data.find((e) => e.kind === "command");
    assert.equal(cmd.command, "rg TODO");
    assert.equal(cmd.exitCode, 0);

    const tu = result.data.find((e) => e.kind === "tool_use");
    assert.equal(tu.tool, "Read");
    assert.deepEqual(tu.input, { file_path: "src/app.py" });

    const msg = result.data.find((e) => e.kind === "message");
    assert.equal(msg.role, "assistant");
    assert.deepEqual(msg.parts, [{ type: "text", text: "done" }]);
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-4A-02: limit applied (existing CLI default semantics).
// ---------------------------------------------------------------------

test("M9-4A-02: limit truncates reconstructed events to the last N", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m94a-02-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, "run_proc", processTranscript("run_proc", PROCESS_EVENTS));
    const result = await collectRunMessages({ runId: "run_proc", runDir, limit: 2 });
    assert.equal(result.data.length, 2, "only last 2 events");
    // Last two are file_written + message.
    assert.equal(result.data[0].kind, "file_written");
    assert.equal(result.data[1].kind, "message");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-4A-03: missing session.created or backendSessionId → fail-closed, no fetch/append.
// ---------------------------------------------------------------------

test("M9-4A-03: missing session.created → fail-closed, no append", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m94a-03-"));
  let appendCalls = 0;
  try {
    const runDir = join(dir, "runs");
    // Transcript with no session.created.
    writeTranscript(runDir, "run_nosession",
      jl({ type: "run.state_change", to: "failed", reason: "x", ts: "2026-07-14T00:00:00.000Z", runId: "run_nosession", agentId: "w" }),
    );
    await assert.rejects(() => collectRunMessages({
      runId: "run_nosession", runDir,
      appendCollectedFn: async () => { appendCalls += 1; },
    }));
    assert.equal(appendCalls, 0, "append not called");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-4A-05: process success → exactly one messages.collected, correct fields, terminal unchanged.
// ---------------------------------------------------------------------

test("M9-4A-05: process success appends exactly one messages.collected, terminal unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m94a-05-"));
  let appendCalls = 0;
  let appendedEvent = null;
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, "run_proc", processTranscript("run_proc", PROCESS_EVENTS));
    const result = await collectRunMessages({
      runId: "run_proc", runDir,
      appendCollectedFn: async (type, payload) => {
        appendCalls += 1;
        appendedEvent = { type, payload };
      },
    });

    assert.equal(appendCalls, 1, "exactly one append");
    assert.equal(appendedEvent.type, "messages.collected", "event type");
    assert.equal(appendedEvent.payload.backend, "process", "backend field");
    assert.equal(appendedEvent.payload.reconstructed, true, "reconstructed field");
    assert.equal(appendedEvent.payload.backendSessionId, "proc_4242", "backendSessionId");
    assert.equal(appendedEvent.payload.count, 5, "count = reconstructed items");
    // Terminal state unchanged: read events, check last state is still failed.
    const events = await readTranscript(join(runDir, "run_proc.jsonl"));
    assert.equal(findState(events), "failed", "terminal unchanged");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-4A-08: append failure propagates, does not return success.
// ---------------------------------------------------------------------

test("M9-4A-08: append failure propagates, no success return", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m94a-08-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, "run_proc", processTranscript("run_proc", PROCESS_EVENTS));
    let threw = false;
    try {
      await collectRunMessages({
        runId: "run_proc", runDir,
        appendCollectedFn: async () => { throw new Error("disk full"); },
      });
    } catch (e) {
      threw = true;
      assert.match(e.message, /disk full/);
    }
    assert.ok(threw, "append failure propagated");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-4A-09: repeated collect → two audit events, terminal unchanged.
// ---------------------------------------------------------------------

test("M9-4A-09: two collects → two messages.collected events, terminal unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m94a-09-"));
  let appendCalls = 0;
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, "run_proc", processTranscript("run_proc", PROCESS_EVENTS));
    const appendFn = async () => { appendCalls += 1; };
    await collectRunMessages({ runId: "run_proc", runDir, appendCollectedFn: appendFn });
    await collectRunMessages({ runId: "run_proc", runDir, appendCollectedFn: appendFn });
    assert.equal(appendCalls, 2, "two appends for two collects");
    const events = await readTranscript(join(runDir, "run_proc.jsonl"));
    assert.equal(findState(events), "failed", "terminal still failed");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-4A-10: malicious/path-traversal/blank runId rejected before read/append.
// ---------------------------------------------------------------------

test("M9-4A-10: malicious runId rejected before read/append", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m94a-10-"));
  let appendCalls = 0;
  let readCalls = 0;
  const fakeRead = async () => { readCalls += 1; return []; };
  try {
    const badIds = ["../escape", "run&injected", "run space", "", "run/path", ".hidden", "-dash"];
    for (const bad of badIds) {
      let threw = false;
      try {
        await collectRunMessages({
          runId: bad, runDir: dir,
          readTranscriptFn: fakeRead,
          appendCollectedFn: async () => { appendCalls += 1; },
        });
      } catch {
        threw = true;
      }
      assert.ok(threw, `malicious runId ${JSON.stringify(bad)} must throw`);
    }
    assert.equal(readCalls, 0, "readTranscript never called");
    assert.equal(appendCalls, 0, "append never called");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-4A-11: service does not console; src/application imports no commands/mcp/SDK/Zod.
// ---------------------------------------------------------------------

test("M9-4A-11: service writes no console + dependency-direction guard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m94a-11-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, "run_proc", processTranscript("run_proc", PROCESS_EVENTS));
    const logs = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => { logs.push(a); };
    console.error = (...a) => { logs.push(a); };
    try {
      await collectRunMessages({ runId: "run_proc", runDir });
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    assert.equal(logs.length, 0, "service writes nothing to console");

    // Dependency guard.
    const { readdir, readFile } = await import("node:fs/promises");
    const appDir = join(process.cwd(), "src", "application");
    const files = (await readdir(appDir)).filter((f) => f.endsWith(".js"));
    const forbidden = /(?:from\s+['"](?:\.\.\/commands\/|.*commands\/|\.\.\/mcp\/|.*mcp\/|@modelcontextprotocol|zod))|(?:require\(\s*['"](?:@modelcontextprotocol|zod))/;
    for (const f of files) {
      const content = await readFile(join(appDir, f), "utf8");
      for (const line of content.split("\n").filter((l) => l.trim().startsWith("import"))) {
        assert.ok(!forbidden.test(line), `src/application/${f} must not import commands/mcp/SDK/zod: ${line.trim()}`);
      }
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-4A-12: messages.collected runId is correctly attributed even when the
//           first transcript event lacks a runId field (Reviewer A F2 regression).
// ---------------------------------------------------------------------

test("M9-4A-12: messages.collected runId correctly attributed when first event lacks runId", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m94a-12-"));
  try {
    const runDir = join(dir, "runs");
    const runId = "run_attrib_test";
    // First event (run.submitted) has NO runId field — like the TD-77 fixtures.
    writeTranscript(runDir, runId,
      jl({ type: "run.submitted", agentId: "researcher", ts: "2026-07-14T00:00:00.000Z" }) +
      jl({ type: "session.created", backend: "process", backendSessionId: "proc_99", runId, agentId: "researcher" }) +
      jl({ type: "run.event", kind: "command", command: "echo", ts: "2026-07-14T00:00:01.000Z", runId, agentId: "researcher" }) +
      jl({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-07-14T00:00:02.000Z", runId, agentId: "researcher" }),
    );
    // Use the default (real) append — no injection — so we verify the persisted event.
    await collectRunMessages({ runId, runDir });

    const events = await readTranscript(join(runDir, `${runId}.jsonl`));
    const collected = events.filter((e) => e.type === "messages.collected");
    assert.equal(collected.length, 1, "one messages.collected");
    // The audit event's runId must be the validated arg, not "unknown".
    assert.equal(collected[0].runId, runId, "messages.collected runId is the validated arg, not unknown");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-4A-14: limit=0 means "all" (existing CLI semantics: slice(-0) = all).
//           CTO P2: the service incorrectly falls back to 50 for limit=0.
// ---------------------------------------------------------------------

test("M9-4A-14: limit=0 returns all reconstructed events (CLI 0=all semantics)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m94a-14-"));
  try {
    const runDir = join(dir, "runs");
    // 55 run.events — more than the default limit of 50. If limit=0 is
    // incorrectly treated as "fall back to 50", only 50 would return.
    // With correct 0=all semantics (slice(-0) = all), all 55 return.
    let lines = jl({ type: "session.created", backend: "process", backendSessionId: "proc_1", runId: "run_lim0", agentId: "w" });
    for (let i = 0; i < 55; i += 1) {
      lines += jl({ type: "run.event", kind: "command", command: `cmd${i}`, ts: "2026-07-14T00:00:01.000Z", runId: "run_lim0", agentId: "w" });
    }
    lines += jl({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-07-14T00:00:04.000Z", runId: "run_lim0", agentId: "w" });
    writeTranscript(runDir, "run_lim0", lines);
    const result = await collectRunMessages({ runId: "run_lim0", runDir, limit: 0 });
    assert.equal(result.data.length, 55, "limit=0 returns all 55 events, not capped at 50");
  } finally {
    cleanupDir(dir);
  }
});
