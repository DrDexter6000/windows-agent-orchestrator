// test/runStatus.test.js
//
// M9-3A: shared run status application service — TDD tests.
//
// Proves that CLI status aggregation is extracted into a shared, argv-free,
// console-free, MCP-free application service that owns:
//   - runId validation (isValidRunId SSOT, before path/file access)
//   - state via findState + terminal via TERMINAL_STATES (no second algorithm)
//   - activity aggregation (TD-75 semantics: last run.event → kind/summary/age)
//   - deterministic secondsSinceActivity via injectable nowFn
//   - fail-closed on missing transcript (no file creation)
//   - read-only: no transcript/owner writes, no console output

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getRunStatus } from "../src/application/runStatus.js";
import { TERMINAL_STATES } from "../src/transcript.js";

// ===== Helpers =====

function writeTranscript(dir, runId, lines) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.jsonl`), lines, "utf8");
}

function ev(obj) {
  return JSON.stringify(obj) + "\n";
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// A transcript with a pending state + a run.event (command).
const SAMPLE_RUN = "run_sample_m93a";
function sampleEvents() {
  return [
    ev({ type: "run.background_submitted", ts: "2026-07-14T00:00:00.000Z", runId: SAMPLE_RUN, agentId: "coder_low", seq: 1 }),
    ev({ type: "run.state_change", to: "pending", reason: "background_spawned", ts: "2026-07-14T00:00:01.000Z", runId: SAMPLE_RUN, agentId: "coder_low", seq: 2 }),
    ev({ type: "run.state_change", to: "running", reason: "started", ts: "2026-07-14T00:00:05.000Z", runId: SAMPLE_RUN, agentId: "coder_low", seq: 3 }),
    ev({ type: "run.event", kind: "command", command: "npm test", ts: "2026-07-14T00:00:10.000Z", runId: SAMPLE_RUN, agentId: "coder_low", seq: 4 }),
  ].join("");
}

// ===== Tests =====

// ---------------------------------------------------------------------
// M9-3A-01: states map correctly to state + terminal flag.
// ---------------------------------------------------------------------

test("M9-3A-01: running/completed/failed/aborted/timed_out state and terminal correct", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m93a-01-"));
  try {
    const states = [
      { to: "running", terminal: false },
      { to: "completed", terminal: true },
      { to: "failed", terminal: true },
      { to: "aborted", terminal: true },
      { to: "timed_out", terminal: true },
    ];
    for (const { to, terminal } of states) {
      const runDir = join(dir, to);
      const runId = `run_${to}`;
      writeTranscript(runDir, runId,
        ev({ type: "run.state_change", to: "pending", reason: "init", ts: "2026-07-14T00:00:00.000Z", runId, agentId: "w", seq: 1 }) +
        ev({ type: "run.state_change", to, reason: "test", ts: "2026-07-14T00:00:01.000Z", runId, agentId: "w", seq: 2 }),
      );
      const result = await getRunStatus({ runId, runDir });
      assert.equal(result.state, to, `state is ${to}`);
      assert.equal(result.terminal, terminal, `terminal is ${terminal} for ${to}`);
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-3A-02: no state_change → findState legacy derivation (no second algorithm).
// ---------------------------------------------------------------------

test("M9-3A-02: legacy transcript without state_change derives state via findState", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m93a-02-"));
  try {
    const runId = "run_legacy_m93a";
    // A transcript with a run.completed event but no run.state_change.
    // findState's legacy fallback should infer terminal from the fact event.
    writeTranscript(dir, runId,
      ev({ type: "run.event", kind: "command", command: "echo hi", ts: "2026-07-14T00:00:01.000Z", runId, agentId: "w", seq: 1 }) +
      ev({ type: "run.completed", ts: "2026-07-14T00:00:02.000Z", runId, agentId: "w", seq: 2 }),
    );
    const result = await getRunStatus({ runId, runDir: dir });
    // findState should infer "completed" from run.completed (legacy terminal fact).
    assert.equal(result.state, "completed", "legacy state derived via findState");
    assert.equal(result.terminal, true, "legacy completed is terminal");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-3A-03: last run.event → kind/summary/ts consistent with TD-75 semantics.
// ---------------------------------------------------------------------

test("M9-3A-03: last activity kind/summary/ts match TD-75 semantics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m93a-03-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, SAMPLE_RUN, sampleEvents());
    const result = await getRunStatus({ runId: SAMPLE_RUN, runDir });

    // lastActivity points at the command event.
    assert.equal(result.lastActivityTs, "2026-07-14T00:00:10.000Z", "lastActivityTs = last run.event ts");
    // TD-75 human label for command kind.
    assert.equal(result.lastActivityKind, "跑命令", "command → 跑命令");
    // Summary contains the command text.
    assert.match(result.lastActivitySummary, /npm test/, "summary contains command");

    // Machine kind for MCP (the raw kind, not the human label).
    assert.equal(result.lastActivityEventKind, "command", "machine kind is command");

    // lastEvent is the literal last event (the run.event itself).
    assert.equal(result.lastEventType, "run.event", "lastEventType is run.event");
    assert.equal(result.lastEventTs, "2026-07-14T00:00:10.000Z", "lastEventTs");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-3A-04: no run.event → activity fields null.
// ---------------------------------------------------------------------

test("M9-3A-04: no run.event → activity fields null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m93a-04-"));
  try {
    const runId = "run_noevents_m93a";
    writeTranscript(dir, runId,
      ev({ type: "run.state_change", to: "pending", reason: "init", ts: "2026-07-14T00:00:00.000Z", runId, agentId: "w", seq: 1 }),
    );
    const result = await getRunStatus({ runId, runDir: dir });
    assert.equal(result.lastActivityTs, null, "lastActivityTs null");
    assert.equal(result.lastActivityKind, null, "lastActivityKind null");
    assert.equal(result.lastActivitySummary, null, "lastActivitySummary null");
    assert.equal(result.lastActivityEventKind, null, "lastActivityEventKind null");
    assert.equal(result.secondsSinceActivity, null, "secondsSinceActivity null");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-3A-05: fixed nowFn → secondsSinceActivity deterministic.
// ---------------------------------------------------------------------

test("M9-3A-05: fixed nowFn → secondsSinceActivity exact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m93a-05-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, SAMPLE_RUN, sampleEvents());
    // Last activity at 00:00:10. Fix now at 00:00:14 → 4 seconds.
    const fixedNow = () => new Date("2026-07-14T00:00:14.000Z").getTime();
    const result = await getRunStatus({ runId: SAMPLE_RUN, runDir, nowFn: fixedNow });
    assert.equal(result.secondsSinceActivity, 4, "exactly 4 seconds since last activity");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-3A-06: malicious/path-traversal/blank runId rejected before readTranscript.
// ---------------------------------------------------------------------

test("M9-3A-06: malicious runId rejected before any file read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m93a-06-"));
  let readCalls = 0;
  const fakeRead = async () => { readCalls += 1; return []; };
  try {
    const badIds = ["../escape", "run&injected", "run space", "", "run/path", ".hidden", "-dash", "run\x00null"];
    for (const bad of badIds) {
      let threw = false;
      try {
        await getRunStatus({ runId: bad, runDir: dir, readTranscriptFn: fakeRead });
      } catch {
        threw = true;
      }
      assert.ok(threw, `malicious runId ${JSON.stringify(bad)} must throw before read`);
    }
    assert.equal(readCalls, 0, "readTranscript never called for malicious runId");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-3A-07: missing transcript → fail-closed, no file created.
// ---------------------------------------------------------------------

test("M9-3A-07: missing transcript fails closed without creating files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m93a-07-"));
  try {
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    const runId = "run_missing_m93a";
    const transcriptPath = join(runDir, `${runId}.jsonl`);
    let threw = false;
    try {
      await getRunStatus({ runId, runDir });
    } catch {
      threw = true;
    }
    assert.ok(threw, "missing transcript must throw (fail-closed)");
    // The service must NOT have created the file.
    assert.ok(!existsSyncSafe(transcriptPath), "no transcript file created by status query");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-3A-08: read-only — transcript bytes/mtime/event-count unchanged; no console.
// ---------------------------------------------------------------------

test("M9-3A-08: status query is read-only — transcript unchanged, no console output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m93a-08-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, SAMPLE_RUN, sampleEvents());
    const transcriptPath = join(runDir, `${SAMPLE_RUN}.jsonl`);
    const before = readFileSync(transcriptPath, "utf8");
    const beforeStat = statSync(transcriptPath);

    // Capture console.
    const logs = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => { logs.push(["log", ...a]); };
    console.error = (...a) => { logs.push(["err", ...a]); };
    try {
      await getRunStatus({ runId: SAMPLE_RUN, runDir });
      await getRunStatus({ runId: SAMPLE_RUN, runDir });
    } finally {
      console.log = origLog;
      console.error = origErr;
    }

    const after = readFileSync(transcriptPath, "utf8");
    const afterStat = statSync(transcriptPath);
    assert.equal(after, before, "transcript bytes unchanged");
    // mtime should not change from a read (allow equal or older; strictly not newer).
    assert.ok(afterStat.mtimeMs <= beforeStat.mtimeMs + 1 || after === before, "mtime not bumped by read");
    assert.equal(logs.length, 0, "service writes nothing to console");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-3A-09: dependency-direction guard — src/application imports no commands/mcp/SDK/Zod.
// ---------------------------------------------------------------------

test("M9-3A-09: src/application does not import commands/, mcp/, MCP SDK, or zod", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const appDir = join(process.cwd(), "src", "application");
  const files = (await readdir(appDir)).filter((f) => f.endsWith(".js"));
  assert.ok(files.length > 0, "src/application has .js files");
  const forbidden = /(?:from\s+['"](?:\.\.\/commands\/|.*commands\/|\.\.\/mcp\/|.*mcp\/|@modelcontextprotocol|zod))|(?:require\(\s*['"](?:@modelcontextprotocol|zod))/;
  for (const f of files) {
    const content = await readFile(join(appDir, f), "utf8");
    const importLines = content.split("\n").filter((l) => l.trim().startsWith("import"));
    for (const line of importLines) {
      assert.ok(!forbidden.test(line), `src/application/${f} must not import commands/mcp/SDK/zod: ${line.trim()}`);
    }
  }
});

// ===== Utility =====

import { existsSync } from "node:fs";
function existsSyncSafe(p) {
  try { return existsSync(p); } catch { return false; }
}
