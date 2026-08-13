// test/runDiagnosis.test.js
//
// M9-5A: shared run diagnosis application service — TDD tests.
//
// Proves that CLI diagnosis logic (read transcript → diagnoseFailure → return
// structured result) is extracted into a shared, argv-free, console-free,
// MCP-free read-only service.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getRunDiagnosis } from "../src/application/runDiagnosis.js";
import { diagnoseFailure } from "../src/diagnosis.js";
import { readTranscript, findState, TERMINAL_STATES } from "../src/transcript.js";

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

// ===== Tests =====

// ---------------------------------------------------------------------
// M9-5A-01: service category/evidence deep-equals direct diagnoseFailure for all key categories.
// ---------------------------------------------------------------------

test("M9-5A-01: service diagnosis deep-equals direct diagnoseFailure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m95a-01-"));
  try {
    const cases = [
      { runId: "run_auth", events: [
        jl({ type: "run.state_change", to: "failed", reason: "x", ts: "2026-07-14T00:00:00.000Z", runId: "run_auth", agentId: "w" }),
        jl({ type: "run.error", phase: "wait", error: "401 unauthorized", ts: "2026-07-14T00:00:01.000Z", runId: "run_auth", agentId: "w" }),
      ]},
      { runId: "run_none", events: [
        jl({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-07-14T00:00:00.000Z", runId: "run_none", agentId: "w" }),
      ]},
      { runId: "run_unknown", events: [
        jl({ type: "run.state_change", to: "failed", reason: "x", ts: "2026-07-14T00:00:00.000Z", runId: "run_unknown", agentId: "w" }),
      ]},
    ];
    for (const { runId, events } of cases) {
      const runDir = join(dir, runId);
      writeTranscript(runDir, runId, events.join(""));
      const result = await getRunDiagnosis({ runId, runDir });
      const directEvents = await readTranscript(join(runDir, `${runId}.jsonl`));
      const direct = diagnoseFailure(directEvents);
      assert.deepEqual(result.category, direct.category, `${runId} category matches`);
      assert.deepEqual(result.evidence, direct.evidence, `${runId} evidence matches`);
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-5A-02: state/terminal correct for all terminal states + running.
// ---------------------------------------------------------------------

test("M9-5A-02: state and terminal flag correct", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m95a-02-"));
  try {
    const states = [
      { to: "running", terminal: false },
      { to: "completed", terminal: true },
      { to: "failed", terminal: true },
      { to: "aborted", terminal: true },
      { to: "timed_out", terminal: true },
    ];
    for (const { to, terminal } of states) {
      const runId = `run_${to}`;
      const runDir = join(dir, to);
      writeTranscript(runDir, runId,
        jl({ type: "run.state_change", to: "pending", reason: "init", ts: "2026-07-14T00:00:00.000Z", runId, agentId: "w" }) +
        jl({ type: "run.state_change", to, reason: "test", ts: "2026-07-14T00:00:01.000Z", runId, agentId: "w" }),
      );
      const result = await getRunDiagnosis({ runId, runDir });
      assert.equal(result.state, to, `state is ${to}`);
      assert.equal(result.terminal, terminal, `terminal is ${terminal}`);
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-5A-03: malicious runId rejected before readTranscript.
// ---------------------------------------------------------------------

test("M9-5A-03: malicious runId rejected before read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m95a-03-"));
  let readCalls = 0;
  const fakeRead = async () => { readCalls += 1; return []; };
  try {
    const badIds = ["../escape", "run&injected", "run space", "", "run/path", ".hidden", "-dash"];
    for (const bad of badIds) {
      let threw = false;
      try {
        await getRunDiagnosis({ runId: bad, runDir: dir, readTranscriptFn: fakeRead });
      } catch {
        threw = true;
      }
      assert.ok(threw, `malicious runId ${JSON.stringify(bad)} must throw`);
    }
    assert.equal(readCalls, 0, "readTranscript never called");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-5A-04: missing transcript → fail-closed, no file creation.
// ---------------------------------------------------------------------

test("M9-5A-04: missing transcript fails closed without creating files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m95a-04-"));
  try {
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    let threw = false;
    try {
      await getRunDiagnosis({ runId: "run_missing", runDir });
    } catch {
      threw = true;
    }
    assert.ok(threw, "missing transcript must throw");
    assert.ok(!existsSyncSafe(join(runDir, "run_missing.jsonl")), "no file created");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-5A-05: read-only — transcript bytes unchanged after diagnosis calls.
// ---------------------------------------------------------------------

test("M9-5A-05: diagnosis is read-only — transcript bytes unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m95a-05-"));
  try {
    const runDir = join(dir, "runs");
    const runId = "run_ro";
    writeTranscript(runDir, runId,
      jl({ type: "run.state_change", to: "failed", reason: "x", ts: "2026-07-14T00:00:00.000Z", runId, agentId: "w" }),
    );
    const path = join(runDir, `${runId}.jsonl`);
    const before = readFileSync(path, "utf8");
    await getRunDiagnosis({ runId, runDir });
    await getRunDiagnosis({ runId, runDir });
    const after = readFileSync(path, "utf8");
    assert.equal(after, before, "transcript bytes unchanged after two diagnosis calls");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-5A-06: service writes no console; src/application imports no commands/mcp/SDK/Zod.
// ---------------------------------------------------------------------

test("M9-5A-06: service writes no console + dependency guard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m95a-06-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, "run_x",
      jl({ type: "run.state_change", to: "failed", reason: "x", ts: "2026-07-14T00:00:00.000Z", runId: "run_x", agentId: "w" }),
    );
    const logs = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => { logs.push(a); };
    console.error = (...a) => { logs.push(a); };
    try {
      await getRunDiagnosis({ runId: "run_x", runDir });
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    assert.equal(logs.length, 0, "no console output");

    const { readdir, readFile } = await import("node:fs/promises");
    const appDir = join(process.cwd(), "src", "application");
    const files = (await readdir(appDir)).filter((f) => f.endsWith(".js"));
    const forbidden = /(?:from\s+['"](?:\.\.\/commands\/|.*commands\/|\.\.\/mcp\/|.*mcp\/|@modelcontextprotocol|zod))/;
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

// ===== Utility =====
import { existsSync } from "node:fs";
function existsSyncSafe(p) {
  try { return existsSync(p); } catch { return false; }
}

// ---------------------------------------------------------------------
// M12-21: completed-empty truth — real-transcript smoke via the shared
// read-only diagnosis service.
//
// Writes a production-shaped completed-empty transcript (transport activity,
// zero usable effect), then calls the REAL getRunDiagnosis service (no mock
// reader) to prove: (1) the service surfaces the kernel fact
// { category:"no_effect", code:"completed_empty" }; (2) the call is strictly
// read-only — transcript bytes are byte-identical before and after. No real
// model is involved; this is a transcript replay through repository services.
// ---------------------------------------------------------------------

test("M12-21: completed-empty transcript via real getRunDiagnosis → no_effect/completed_empty, bytes unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1221-diag-"));
  try {
    const runId = "run_ce";
    const runDir = join(dir, "runs");
    writeTranscript(runDir, runId, [
      jl({ type: "run.submitted", runId, agentId: "coder_low", ts: "2026-08-12T10:00:00.000Z" }),
      jl({ type: "run.started", runId, backend: "claude-code", ts: "2026-08-12T10:00:01.000Z" }),
      jl({ type: "run.event", runId, kind: "runtime_activity", status: "initialized", ts: "2026-08-12T10:00:02.000Z" }),
      jl({ type: "run.event", runId, kind: "runtime_activity", status: "streaming", ts: "2026-08-12T10:00:03.000Z" }),
      jl({ type: "run.event", runId, kind: "metrics", tokens: { input: 0, output: 0 }, ts: "2026-08-12T10:00:04.000Z" }),
      jl({ type: "run.state_change", runId, from: "running", to: "completed", reason: "done", ts: "2026-08-12T10:00:05.000Z" }),
    ].join(""));
    const path = join(runDir, `${runId}.jsonl`);
    const before = readFileSync(path, "utf8");

    const result = await getRunDiagnosis({ runId, runDir });

    assert.equal(result.state, "completed");
    assert.equal(result.terminal, true);
    assert.equal(result.category, "no_effect",
      "completed-empty transcript diagnosed no_effect via the real service");
    assert.equal(result.code, "completed_empty",
      "kernel code completed_empty surfaces through the read-only service");

    // Read-only: byte-identical after the diagnosis call.
    const after = readFileSync(path, "utf8");
    assert.equal(after, before, "transcript bytes unchanged by getRunDiagnosis");

    // No provider payload echo in the returned evidence.
    const dumped = JSON.stringify(result);
    assert.ok(!/input_tokens|output_tokens|prompt|secret|argv/i.test(dumped), "no provider payload echo");
  } finally {
    cleanupDir(dir);
  }
});
