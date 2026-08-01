// test/runAwaitResultCompat.test.js
//
// M12-6 Package 1: runAwaitResult historical-snapshot compatibility + shape
// hardening. The reference bug: a historical JSONL may contain JSON-valid but
// NON-usable events (null / primitive / array). The shared SSOT projections
// (findLastEventSeq / findState / findRunWorkspaceOwnership / summarizeLiveness)
// read envelope fields directly, so a null entry threw a TypeError that escaped
// as a top-level "run_await_result failed". A primitive/array entry silently
// derived a wrong state/cursor.
//
// The fix is local to runAwaitResult: every snapshot is reduced to its usable
// events before any derive (usable-event shape boundary) + safe derive/readFailure
// helpers. This file pins the contract with minimal desensitized fixtures:
//   - historical collected/failed/delivery/read-only terminal snapshots,
//   - malformed JSON / null / primitive / array events,
//   - circular re-read shape failure (wait loop),
//   - projection failure (observed + unavailable),
//   - leak protection (no err.message/path/prompt/command/raw event),
//   - waitMs=0 current-shape regression,
//   - valid cross-workspace still rejected (NOT converted to read_failure).
//
// Read-only / zero-append / 270s / progress / stop-retry-decision contracts are
// intentionally NOT changed here — they remain pinned by runAwaitResult.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { rmrfRetry } from "./_rmrfHelper.mjs";

// ===== Helpers (mirroring runAwaitResult.test.js) =====

function cleanupDir(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
// rmrfRetry (bounded transient-rm retry, injectable rm/sleep) is the shared
// test-only helper (TD-107) — see test/_rmrfHelper.mjs + test/rmrfRetry.test.js.

function makeGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "R.md"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: dir });
}

function jl(obj) { return JSON.stringify(obj) + "\n"; }

// A clock the sleepFn advances in lockstep, so deadline math is deterministic.
function clockSleep(start = 1000000) {
  let t = start;
  return { now: () => t, sleep: (ms) => { t += ms; }, get: () => t, set: (v) => { t = v; } };
}

// Build a transcript on disk. terminal: false | "completed" | "failed".
// delivery=true appends a delivery_created + verification_passed chain (no
// decision). Returns the lines written so callers may append non-usable lines.
function seedTranscript(runDir, runId, {
  agentId = "coder_low", messages = [], terminal = false, delivery = false, workspaceCwd,
} = {}) {
  mkdirSync(runDir, { recursive: true });
  const a = agentId;
  const lines = [
    jl({ type: "run.submitted", agentId: a, ts: "2026-07-28T00:00:00.000Z", runId }),
    jl({ type: "session.created", backend: "process", backendSessionId: "proc_compat", runId, agentId: a }),
    jl({ type: "run.started", backend: "claude-code", ts: "2026-07-28T00:00:01.000Z", runId, agentId: a }),
    jl({ type: "run.background_submitted", background: true, cwd: workspaceCwd, runId, agentId: a }),
    jl({ type: "run.state_change", to: "running", reason: "first_event", ts: "2026-07-28T00:00:03.000Z", runId, agentId: a }),
  ];
  for (const [i, text] of messages.entries()) {
    lines.push(jl({
      type: "run.event", kind: "message", role: "assistant",
      parts: [{ type: "text", text }], ts: `2026-07-28T00:00:${10 + i}.000Z`, runId, agentId: a,
    }));
  }
  if (terminal === "completed" || terminal === true) {
    lines.push(jl({ type: "run.completed", ts: "2026-07-28T00:10:00.000Z", runId, agentId: a }));
    lines.push(jl({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-07-28T00:10:01.000Z", runId, agentId: a }));
  } else if (terminal === "failed") {
    lines.push(jl({ type: "run.error", ts: "2026-07-28T00:10:00.000Z", runId, agentId: a }));
    lines.push(jl({ type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-07-28T00:10:01.000Z", runId, agentId: a }));
  }
  if (delivery) {
    const commit = "d".repeat(40);
    lines.push(jl({
      type: "run.delivery_created", runId, agentId: a,
      delivery: { runId, baseCommit: "b".repeat(40), deliveryCommit: commit, changedFiles: ["src/a.js"] },
    }));
    lines.push(jl({
      type: "run.delivery_verification_passed", runId, agentId: a,
      delivery: { runId, baseCommit: "b".repeat(40), deliveryCommit: commit, changedFiles: ["src/a.js"] },
    }));
  }
  writeFileSync(join(runDir, `${runId}.jsonl`), lines.join(""), "utf8");
  return lines;
}

function countAudits(transcriptPath) {
  try {
    return readFileSync(transcriptPath, "utf8").trim().split("\n")
      .filter((l) => l.includes('"messages.collected"')).length;
  } catch { return 0; }
}

// =====================================================================
// Historical terminal snapshots — still observed, compact, ZERO append.
// =====================================================================

test("M12-6 historical completed run → compact available, zero append, bytes unchanged", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m126-completed-"));
  try {
    seedTranscript(runDir, "run_done", { messages: ["FINAL answer"], terminal: "completed" });
    const tp = join(runDir, "run_done.jsonl");
    const before = readFileSync(tp);
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: "run_done", runDir, waitMs: 0 });
    assert.equal(out.observationOutcome, "observed");
    assert.equal(out.terminal, true);
    assert.equal(out.state, "completed");
    assert.equal(out.result.status, "available");
    assert.deepEqual(out.result.messages, [{ role: "assistant", text: "FINAL answer", truncated: false }]);
    assert.equal(readFileSync(tp).equals(before), true, "bytes unchanged (read-only)");
    assert.equal(countAudits(tp), 0, "zero messages.collected");
  } finally { rmrfRetry(runDir); }
});

test("M12-6 historical failed run → terminal failed observed, zero append", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m126-failed-"));
  try {
    seedTranscript(runDir, "run_fail", { messages: ["partial work"], terminal: "failed" });
    const tp = join(runDir, "run_fail.jsonl");
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: "run_fail", runDir, waitMs: 0 });
    assert.equal(out.observationOutcome, "observed");
    assert.equal(out.terminal, true);
    assert.equal(out.state, "failed");
    assert.equal(out.result.status, "available");
    assert.equal(countAudits(tp), 0);
  } finally { rmrfRetry(runDir); }
});

test("M12-6 historical delivery run → terminal + delivery chain, zero append, no decision", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m126-delivery-"));
  try {
    seedTranscript(runDir, "run_deliv", { messages: ["done"], terminal: "completed", delivery: true });
    const tp = join(runDir, "run_deliv.jsonl");
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: "run_deliv", runDir, waitMs: 0 });
    assert.equal(out.terminal, true);
    assert.equal(out.result.status, "available");
    // Read-only: the delivery chain must NOT be mutated, no audit, no decision append.
    assert.equal(countAudits(tp), 0);
    const raw = readFileSync(tp, "utf8");
    assert.ok(!raw.includes("run.delivery_accepted") && !raw.includes("run.delivery_rejected"),
      "advisory tool must not append a decision");
  } finally { rmrfRetry(runDir); }
});

// =====================================================================
// Non-usable events (null / primitive / array) + malformed JSON.
// Invalid shape → read_failure + unavailable; trusted runId/state/terminal
// preserved; cursor/agentId/liveness null/unknown. NO top-level throw.
// =====================================================================

async function readFailureOnShape(extraRawLines, tname) {
  const runDir = mkdtempSync(join(tmpdir(), `wao-m126-${tname}-`));
  try {
    const lines = seedTranscript(runDir, "run_shape", { messages: [], terminal: false });
    // Append non-usable raw lines after the clean usable prefix.
    writeFileSync(join(runDir, "run_shape.jsonl"), lines.join("") + extraRawLines, "utf8");
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: "run_shape", runDir, waitMs: 0 });
    assert.equal(out.observationOutcome, "read_failure", `${tname}: read_failure (not observed)`);
    assert.equal(out.result.status, "unavailable", `${tname}: result unavailable`);
    assert.equal(out.runId, "run_shape", `${tname}: trusted runId preserved`);
    assert.equal(out.state, "running", `${tname}: durable state preserved from usable subset`);
    assert.equal(out.terminal, false, `${tname}: terminal preserved`);
    assert.equal(out.cursor, null, `${tname}: cursor null (untrusted)`);
    assert.equal(out.agentId, "unknown", `${tname}: agentId unknown (untrusted)`);
    assert.equal(out.liveness, "unknown", `${tname}: liveness unknown`);
    assert.equal(out.ownerHeartbeat, "unknown", `${tname}: heartbeat unknown`);
    assert.equal(out.activityEventCount, null);
    assert.equal(out.lastActivityKind, null);
    assert.equal(countAudits(join(runDir, "run_shape.jsonl")), 0, `${tname}: zero append`);
    return out;
  } finally { rmrfRetry(runDir); }
}

test("M12-6 null event → read_failure, no TypeError escape", async () => {
  // Before the fix, findLastEventSeq([..., null]) read null.seq → TypeError →
  // top-level "run_await_result failed". Now it is a structured read_failure.
  await readFailureOnShape("null\n", "null");
});

test("M12-6 primitive event → read_failure (non-usable filtered)", async () => {
  await readFailureOnShape("42\n", "primitive");
});

test("M12-6 array event → read_failure (non-usable filtered)", async () => {
  await readFailureOnShape("[1,2,3]\n", "array");
});

test("M12-6 mixed non-usable (null + primitive + array) → read_failure", async () => {
  await readFailureOnShape("null\n42\n[1,2]\n\"str\"\ntrue\n", "mixed");
});

test("M12-6 malformed JSON line → read_failure (initial read failure)", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m126-malformed-"));
  try {
    // A clean prefix then a syntactically broken JSON line: readTranscript
    // JSON.parse throws → initial read failure → read_failure (no facts).
    seedTranscript(runDir, "run_mal", { messages: [], terminal: false });
    const tp = join(runDir, "run_mal.jsonl");
    writeFileSync(tp, readFileSync(tp, "utf8") + "{not valid json\n", "utf8");
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: "run_mal", runDir, waitMs: 0 });
    assert.equal(out.observationOutcome, "read_failure");
    assert.equal(out.result.status, "unavailable");
    assert.equal(out.state, "unknown", "no facts derivable from an unreadable transcript");
    assert.equal(out.terminal, false);
    assert.equal(out.cursor, null);
  } finally { rmrfRetry(runDir); }
});

// =====================================================================
// Circular re-read: a non-usable event appears between polls during the wait.
// The loop reports read_failure PRESERVING the last trusted agentId/state/cursor
// (same shape as a re-read file failure) — it never combines a corrupt snapshot
// with a fresh owner heartbeat.
// =====================================================================

test("M12-6 shape failure during wait loop → read_failure preserves prior trusted", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m126-loop-"));
  try {
    const a = "coder_low", id = "run_loop";
    const cleanRunning = [
      { type: "run.submitted", agentId: a, runId: id, seq: 1 },
      { type: "session.created", backend: "process", backendSessionId: "p", runId: id, agentId: a, seq: 2 },
      { type: "run.state_change", to: "running", reason: "first_event", runId: id, agentId: a, seq: 3 },
    ];
    // Between polls a null line appears in the durable snapshot.
    const corrupted = [...cleanRunning, null];
    let readCalls = 0;
    const clk = clockSleep();
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({
      runId: id, runDir, waitMs: 4000,
      nowFn: clk.now, pollIntervalMs: 2000, sleepFn: async (ms) => { clk.sleep(ms); },
      readTranscriptFn: async () => { readCalls += 1; return readCalls === 1 ? cleanRunning : corrupted; },
    });
    assert.equal(readCalls, 2, "initial read + one poll reached the corrupt snapshot");
    assert.equal(out.observationOutcome, "read_failure");
    assert.equal(out.state, "running", "prior durable state preserved");
    assert.equal(out.terminal, false);
    assert.equal(out.agentId, a, "prior trusted agentId preserved");
    assert.equal(out.cursor, 3, "prior trusted cursor preserved (max seq)");
    assert.equal(out.liveness, "unknown", "no stale+fresh combination");
    assert.equal(out.ownerHeartbeat, "unknown");
    assert.equal(out.result.status, "unavailable");
    assert.ok(out.waitedMs > 0 && out.waitedMs <= 4000);
  } finally { rmrfRetry(runDir); }
});

// =====================================================================
// Projection failure → observed + unavailable, terminal preserved, NO leak.
// (Shape is valid; the compact projection itself fails.)
// =====================================================================

test("M12-6 projection failure → observed + unavailable, terminal preserved, no error detail", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m126-projfail-"));
  try {
    seedTranscript(runDir, "run_proj", { messages: ["answer"], terminal: "completed" });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({
      runId: "run_proj", runDir, waitMs: 0,
      projectCollectResultFn: () => { throw new Error("boom secret path C:\\x PID=9"); },
    });
    assert.equal(out.observationOutcome, "observed", "projection failure stays observed");
    assert.equal(out.terminal, true, "terminal observation preserved");
    assert.equal(out.state, "completed");
    assert.equal(out.result.status, "unavailable");
    assert.deepEqual(out.result.messages, []);
    const json = JSON.stringify(out);
    assert.ok(!json.includes("secret") && !json.includes("PID=9") && !json.includes("boom"),
      "no error detail (message/path) leaked into the result");
  } finally { rmrfRetry(runDir); }
});

// =====================================================================
// Leak protection: a corrupt snapshot carries secrets/paths/commands. Because a
// non-usable entry makes the shape invalid → read_failure, the compact collect
// never runs, so none of that raw content is projected. No err.message and no
// raw event appear in the result.
// =====================================================================

test("M12-6 leak protection — corrupt snapshot with secret/path/command → read_failure, none leaked", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m126-leak-"));
  try {
    const secret = "AKIAIOSFODNN7EXAMPLE"; // AWS docs example, not a live key
    const a = "coder_low", id = "run_leak";
    const lines = [
      jl({ type: "run.submitted", agentId: a, ts: "2026-07-28T00:00:00.000Z", runId: id }),
      jl({ type: "session.created", backend: "process", backendSessionId: "proc_compat_4242", runId: id, agentId: a }),
      jl({ type: "run.state_change", to: "running", reason: "first_event", ts: "2026-07-28T00:00:03.000Z", runId: id, agentId: a }),
      jl({ type: "run.event", kind: "command", command: `rm -rf / && cat ${secret}`, exitCode: 0, runId: id, agentId: a }),
      jl({ type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: `leak ${secret} now` }], ts: "2026-07-28T00:00:10.000Z", runId: id, agentId: a }),
      jl({ type: "run.event", kind: "file_written", path: "C:\\Users\\secret\\key.pem", runId: id, agentId: a }),
      "null\n", // non-usable → shape invalid → read_failure, collect never runs
    ];
    writeFileSync(join(runDir, `${id}.jsonl`), lines.join(""), "utf8");
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: id, runDir, waitMs: 0 });
    assert.equal(out.observationOutcome, "read_failure");
    assert.equal(out.result.status, "unavailable");
    assert.deepEqual(out.result.messages, []);
    const dumped = JSON.stringify(out);
    assert.ok(!dumped.includes(secret), "no secret");
    assert.ok(!dumped.includes("rm -rf"), "no command string");
    assert.ok(!dumped.toLowerCase().includes("c:\\\\users\\\\secret"), "no windows path");
    assert.ok(!dumped.includes("4242") && !dumped.includes("proc_compat"), "no session id");
    assert.ok(!dumped.includes("TypeError") && !dumped.includes("Cannot read"), "no raw error detail");
  } finally { rmrfRetry(runDir); }
});

// =====================================================================
// Regression: the normal current-shape path is unchanged.
// =====================================================================

test("M12-6 waitMs=0 clean current shape → observed, not_terminal (regression)", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m126-current-"));
  try {
    seedTranscript(runDir, "run_cur", { messages: [], terminal: false });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: "run_cur", runDir, waitMs: 0 });
    assert.equal(out.observationOutcome, "observed");
    assert.equal(out.terminal, false);
    assert.equal(out.state, "running");
    assert.equal(out.result.status, "not_terminal");
    assert.equal(out.agentId, "coder_low", "clean envelope → canonical agentId");
    assert.equal(typeof out.cursor, "number");
  } finally { rmrfRetry(runDir); }
});

test("M12-6 clean current shape with explicit cursor (afterSeq) → observed", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m126-afterseq-"));
  try {
    seedTranscript(runDir, "run_as", { messages: [], terminal: false });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: "run_as", runDir, waitMs: 0, afterSeq: 0 });
    assert.equal(out.observationOutcome, "observed");
    assert.equal(out.terminal, false);
  } finally { rmrfRetry(runDir); }
});

// =====================================================================
// A valid cross-workspace run is STILL rejected — the shape boundary does not
// convert an ownership mismatch into a read_failure.
// =====================================================================

test("M12-6 valid cross-workspace → still rejected (ownership propagates, not read_failure)", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "wao-m126-xws-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wao-m126-xws-b-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m126-xws-rd-"));
  try {
    makeGitRepo(dirA); makeGitRepo(dirB);
    seedTranscript(runDir, "run_xws", { workspaceCwd: dirA, messages: [], terminal: false });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    await assert.rejects(
      () => runAwaitResult({ runId: "run_xws", runDir, waitMs: 0, authorizedWorkspaceRoot: dirB }),
    );
  } finally { cleanupDir(dirA); cleanupDir(dirB); rmrfRetry(runDir); }
});
