// test/runAwaitResult.test.js
//
// M12-3 Package A CORRECTION: runAwaitResult composite read-only service — TDD RED→GREEN.
//
// run_await_result folds (1) a Lead-controlled bounded wait for terminal
// (waitMs 0..270000, default 270000), (2) a truthful run/liveness/cursor
// observation, and (3) a safe terminal-then-compact collection into ONE call.
// It is strictly read-only and advisory:
//   - never appends messages.collected, never invokes commitAppend,
//   - never stop/retry/diagnose/decide/accept/reject/repackage,
//   - never makes a semantic judgment.
//
// This file pins the CORRECTIONS the rejected reference commit (0a041a8) got
// wrong. Contract coverage map (test → correction):
//   S1/S2/S3 .... 1   single final snapshot (read-count + mutation; no post-terminal reread)
//   B1/B2/B3 .... 2+6 total budget: snapshot-only (no serve fetch), elapsed ≤ budget, waitMs=0 once
//   T1/T2/T4 .... 3   truthful null unobserved; empty carries observed zeros; strict int/nonneg
//   O1/O2/O3/O4 .. 4   observationOutcome closed set; read_failure ≠ expiry; no stale+fresh combo
//   P1/P2/P3/P4 .. 5   30s default progress throttle (independent of poll) + upper bound + opt-in
//   C1/C2/C3/C4 .. 7   compact contract reuse: redaction/sanitization/too_large/no raw facts
//   R1/R2/R3 ..... 7+8 read-only/idempotent: zero append, bytes unchanged, repeat deepEqual
//   V1..V4 ....... 9   fail-closed validation before any read; cross-workspace
//   I1 ........... 9   agentId canonical/unknown projection
//   A1/A2/A3 ..... 6+9 architecture purity: no SDK/zod/commands; reuses SSOT; no serve import

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { JsonlTranscript } from "../src/transcript.js";

// ===== Helpers =====

function cleanupDir(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function isTransientRmError(e) { return e?.code === "EPERM" || e?.code === "EBUSY" || e?.code === "ENOTEMPTY"; }
function rmrfRetry(dir, { retries = 20, delayMs = 50 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch (e) { if (!isTransientRmError(e) || attempt >= retries) throw e; sleepSync(delayMs); }
  }
}

function makeGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "R.md"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: dir });
}

function jl(obj) { return JSON.stringify(obj) + "\n"; }

// A complete process transcript on disk.
function seedTranscript(runDir, runId, {
  agentId = "coder_low", messages = [], terminal = false, workspaceCwd,
  backend = "process", serveUrl,
} = {}) {
  mkdirSync(runDir, { recursive: true });
  const session = {
    type: "session.created", backend, backendSessionId: "proc_await",
    runId, agentId, ...(serveUrl ? { serveUrl } : {}),
  };
  const lines = [
    jl({ type: "run.submitted", agentId, ts: "2026-07-28T00:00:00.000Z", runId }),
    jl(session),
    jl({ type: "run.started", backend: "claude-code", ts: "2026-07-28T00:00:01.000Z", runId, agentId }),
    jl({ type: "run.background_submitted", background: true, cwd: workspaceCwd, runId, agentId }),
    jl({ type: "run.state_change", to: "pending", reason: "created", ts: "2026-07-28T00:00:02.000Z", runId, agentId }),
    jl({ type: "run.state_change", to: "running", reason: "first_event", ts: "2026-07-28T00:00:03.000Z", runId, agentId }),
  ];
  for (const [i, text] of messages.entries()) {
    lines.push(jl({
      type: "run.event", kind: "message", role: "assistant",
      parts: [{ type: "text", text }], ts: `2026-07-28T00:00:${10 + i}.000Z`, runId, agentId,
    }));
  }
  if (terminal) {
    lines.push(jl({ type: "run.completed", ts: "2026-07-28T00:10:00.000Z", runId, agentId }));
    lines.push(jl({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-07-28T00:10:01.000Z", runId, agentId }));
  }
  writeFileSync(join(runDir, `${runId}.jsonl`), lines.join(""), "utf8");
}

function countAudits(transcriptPath) {
  try {
    return readFileSync(transcriptPath, "utf8").trim().split("\n")
      .filter((l) => l.includes('"messages.collected"')).length;
  } catch { return 0; }
}

// A clock the sleepFn advances in lockstep, so deadline math is deterministic.
function clockSleep(start = 1000000) {
  let t = start;
  return { now: () => t, sleep: (ms) => { t += ms; }, get: () => t, set: (v) => { t = v; } };
}

// =====================================================================
// Section S — SINGLE FINAL SNAPSHOT (correction 1).
// run facts, cursor, ownership proof, compact text, counts, backend and
// agentId must derive from ONE explicit transcript event snapshot. No second
// parser, no post-terminal transcript reread.
// =====================================================================

test("S1: terminal-at-entry performs exactly ONE transcript read (no post-terminal reread)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-s1-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-s1-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_s1", { workspaceCwd: dir, messages: ["the final answer"], terminal: true });
    const { readTranscript } = await import("../src/transcript.js");
    let readCalls = 0;
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({
      runId: "run_s1", runDir, waitMs: 0,
      readTranscriptFn: async (p) => { readCalls++; return readTranscript(p); },
    });
    assert.equal(out.terminal, true);
    assert.equal(out.result.status, "available");
    assert.equal(readCalls, 1, "terminal-at-entry must read the transcript exactly ONCE (collect reuses the snapshot)");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("S2: snapshot mutation — compact result derives from the FIRST snapshot, not a reread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-s2-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-s2-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_s2", { workspaceCwd: dir, messages: ["FIRST answer"], terminal: true });
    const { readTranscript } = await import("../src/transcript.js");
    let readCalls = 0;
    // A second read (if the impl reread after observing terminal) would return
    // MUTATED data. The result MUST reflect the first (only) snapshot.
    function mutatedSnapshot() {
      const a = "coder_low", id = "run_s2";
      const lines = [
        jl({ type: "session.created", backend: "process", backendSessionId: "x", runId: id, agentId: a }),
        jl({ type: "run.background_submitted", background: true, cwd: dir, runId: id, agentId: a }),
        jl({ type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "SECOND mutated" }], runId: id, agentId: a }),
        jl({ type: "run.state_change", to: "completed", reason: "done", runId: id, agentId: a }),
      ];
      return lines.join("").trim().split("\n").map((l) => JSON.parse(l));
    }
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({
      runId: "run_s2", runDir, waitMs: 0,
      readTranscriptFn: async () => {
        readCalls++;
        // Call 1 (initial) → real snapshot. Call 2+ (must not happen) → mutated.
        return readCalls === 1 ? readTranscript(join(runDir, "run_s2.jsonl")) : mutatedSnapshot();
      },
    });
    assert.equal(readCalls, 1, "no second read occurred");
    assert.equal(out.result.status, "available");
    assert.deepEqual(out.result.messages, [{ role: "assistant", text: "FIRST answer", truncated: false }],
      "result derives from the FIRST snapshot, not a reread");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("S3: terminal-during-wait collects from the terminal-observing snapshot (read-count unchanged by collect)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-s3-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-s3-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_s3", { workspaceCwd: dir, messages: ["FINAL body"], terminal: false });
    const tp = join(runDir, "run_s3.jsonl");
    const { readTranscript } = await import("../src/transcript.js");
    let readCalls = 0;
    let sleepCalls = 0;
    const clk = clockSleep();
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({
      runId: "run_s3", runDir, waitMs: 5000,
      nowFn: clk.now, pollIntervalMs: 2000,
      readTranscriptFn: async (p) => { readCalls++; return readTranscript(p); },
      sleepFn: async (ms) => {
        clk.sleep(ms);
        sleepCalls++;
        if (sleepCalls === 1) {
          const t = new JsonlTranscript(tp, { runId: "run_s3", agentId: "coder_low" });
          await t.append("run.completed", {});
          await t.transitionState("running", "completed", "done");
        }
      },
    });
    assert.equal(out.terminal, true);
    assert.equal(out.result.status, "available");
    assert.deepEqual(out.result.messages, [{ role: "assistant", text: "FINAL body", truncated: false }]);
    // initial read + exactly one poll read = 2. Collect adds ZERO reads.
    assert.equal(readCalls, 2, `terminal-during-wait: collect must not add a read (got ${readCalls})`);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("S4: terminal-observing snapshot is re-authorized before its result is projected", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "wao-s4a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wao-s4b-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-s4-rd-"));
  try {
    makeGitRepo(dirA);
    makeGitRepo(dirB);
    seedTranscript(runDir, "run_s4", { workspaceCwd: dirA, messages: ["initial"], terminal: false });
    const { readTranscript } = await import("../src/transcript.js");
    const initial = await readTranscript(join(runDir, "run_s4.jsonl"));
    const replaced = initial
      .filter((event) => event.type !== "run.background_submitted")
      .concat([
        { type: "run.background_submitted", background: true, cwd: dirB, runId: "run_s4", agentId: "coder_low" },
        { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "foreign" }], runId: "run_s4", agentId: "coder_low" },
        { type: "run.state_change", to: "completed", reason: "done", runId: "run_s4", agentId: "coder_low" },
      ]);
    let reads = 0;
    const clk = clockSleep();
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    await assert.rejects(
      () => runAwaitResult({
        runId: "run_s4",
        runDir,
        waitMs: 2000,
        authorizedWorkspaceRoot: dirA,
        nowFn: clk.now,
        pollIntervalMs: 1000,
        sleepFn: async (ms) => { clk.sleep(ms); },
        readTranscriptFn: async () => (++reads === 1 ? initial : replaced),
      }),
    );
    assert.equal(reads, 2, "the replacement snapshot reached the ownership check");
  } finally {
    cleanupDir(dirA);
    cleanupDir(dirB);
    rmrfRetry(runDir);
  }
});

// =====================================================================
// Section B — TOTAL BUDGET (correction 2) + OPEN-WORLD TRUTH (correction 6).
// waitMs is ONE shared composition budget. Snapshot-only local projection: no
// serve HTTP fetch, no retries, no sleeps on the terminal path. openWorldHint
// stays accurate because there is no network I/O.
// =====================================================================

test("B1: serve-shaped terminal transcript performs NO serve HTTP fetch (snapshot-only)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b1-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-b1-rd-"));
  try {
    makeGitRepo(dir);
    // Serve-backed session (serveUrl + backend opencode-serve) BUT with
    // transcript run.event entries. The composite reconstructs from the
    // transcript snapshot and must NEVER call the serve backend.
    seedTranscript(runDir, "run_b1", {
      workspaceCwd: dir, messages: ["serve snapshot answer"], terminal: true,
      backend: "opencode-serve", serveUrl: "http://127.0.0.1:4297",
    });
    const { readTranscript } = await import("../src/transcript.js");
    let readCalls = 0;
    const origFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (...a) => { fetchCalls++; throw new Error("MUST NOT FETCH"); };
    try {
      const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
      const out = await runAwaitResult({
        runId: "run_b1", runDir, waitMs: 0,
        readTranscriptFn: async (p) => { readCalls++; return readTranscript(p); },
      });
      assert.equal(out.terminal, true);
      assert.equal(out.result.status, "available", "compact reconstructed from transcript snapshot");
      assert.deepEqual(out.result.messages, [{ role: "assistant", text: "serve snapshot answer", truncated: false }]);
      assert.equal(out.result.backend, "opencode-serve", "backend derives from the same session snapshot");
      assert.equal(fetchCalls, 0, "snapshot-only: ZERO serve HTTP fetches");
      assert.equal(readCalls, 1, "single snapshot read");
    } finally {
      globalThis.fetch = origFetch;
    }
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("B2: terminal-during-wait elapsed fake-clock time never exceeds the budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b2-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-b2-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_b2", { workspaceCwd: dir, messages: ["x"], terminal: false });
    const tp = join(runDir, "run_b2.jsonl");
    const clk = clockSleep();
    let sleepCalls = 0;
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({
      runId: "run_b2", runDir, waitMs: 5000,
      nowFn: clk.now, pollIntervalMs: 2000,
      sleepFn: async (ms) => {
        clk.sleep(ms);
        sleepCalls++;
        if (sleepCalls === 2) {
          const t = new JsonlTranscript(tp, { runId: "run_b2", agentId: "coder_low" });
          await t.append("run.completed", {});
          await t.transitionState("running", "completed", "done");
        }
      },
    });
    assert.equal(out.terminal, true);
    assert.ok(out.waitedMs <= 5000, `waitedMs (${out.waitedMs}) must not exceed waitMs budget (5000)`);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("B3: waitMs=0 reads once and returns immediately (no sleep, no loop)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b3-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-b3-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_b3", { workspaceCwd: dir, messages: [], terminal: false });
    const { readTranscript } = await import("../src/transcript.js");
    let readCalls = 0;
    let sleeps = 0;
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({
      runId: "run_b3", runDir, waitMs: 0,
      readTranscriptFn: async (p) => { readCalls++; return readTranscript(p); },
      sleepFn: async () => { sleeps++; },
    });
    assert.equal(out.terminal, false);
    assert.equal(out.result.status, "not_terminal");
    assert.equal(readCalls, 1, "point-in-time reads exactly once");
    assert.equal(sleeps, 0, "waitMs=0 never sleeps");
    assert.equal(out.waitedMs, 0);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

// =====================================================================
// Section T — TRUTHFUL UNOBSERVED VALUES (correction 3).
// For status not_terminal/unavailable/read_failure the result fields NOT
// actually collected (evidenceCounts, itemCount, assistantMessageCount,
// reconstructed, backend) must be null — never fabricated zero/false.
// status=empty (terminal, observed) MAY carry observed zero values.
// =====================================================================

test("T1: not_terminal result carries NULL unobserved fields (no fabricated zeros)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-t1-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-t1-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_t1", { workspaceCwd: dir, messages: [], terminal: false });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: "run_t1", runDir, waitMs: 0 });
    assert.equal(out.result.status, "not_terminal");
    assert.equal(out.result.evidenceCounts, null, "evidenceCounts null (unobserved)");
    assert.equal(out.result.itemCount, null, "itemCount null (unobserved)");
    assert.equal(out.result.assistantMessageCount, null, "assistantMessageCount null (unobserved)");
    assert.equal(out.result.reconstructed, null, "reconstructed null (unobserved)");
    assert.equal(out.result.backend, null, "backend null (unobserved)");
    assert.deepEqual(out.result.messages, []);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("T2: terminal empty result carries OBSERVED zero values (status=empty)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-t2-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-t2-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_t2", { workspaceCwd: dir, messages: [], terminal: true });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: "run_t2", runDir, waitMs: 0 });
    assert.equal(out.result.status, "empty");
    // Observed zeros (the snapshot WAS collected) — not null, not fabricated beyond the snapshot.
    assert.equal(out.result.assistantMessageCount, 0);
    assert.equal(out.result.itemCount, 0);
    assert.equal(out.result.reconstructed, true);
    assert.equal(typeof out.result.backend, "string");
    assert.deepEqual(out.result.evidenceCounts, { message: 0, command: 0, toolUse: 0, toolResult: 0, fileWritten: 0, other: 0 });
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("T4: terminal collected numerics are int/nonnegative; result partition key set is uniform", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-t4-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-t4-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_t4", { workspaceCwd: dir, messages: ["a", "b"], terminal: true });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: "run_t4", runDir, waitMs: 0 });
    assert.equal(out.result.status, "available");
    assert.equal(Number.isInteger(out.result.itemCount), true);
    assert.equal(Number.isInteger(out.result.assistantMessageCount), true);
    assert.ok(out.result.itemCount >= 0);
    assert.ok(out.result.assistantMessageCount >= 0);
    // Uniform key set across collected vs not_terminal (both carry the same keys).
    assert.deepEqual(
      Object.keys(out.result).sort(),
      ["assistantMessageCount", "backend", "evidenceCounts", "itemCount", "messages", "reconstructed", "status"].sort(),
    );
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

// =====================================================================
// Section O — OBSERVATION OUTCOME (correction 4).
// A mandatory closed-set field distinguishes a successful final read
// (point-in-time / window expiry / terminal) from a post-initial read
// failure. A read failure must NOT combine stale event liveness with a fresh
// owner heartbeat into an apparently-current observation.
// =====================================================================

test("O1: point-in-time non-terminal → observationOutcome=observed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-o1-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-o1-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_o1", { workspaceCwd: dir, messages: [], terminal: false });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: "run_o1", runDir, waitMs: 0 });
    assert.equal(out.observationOutcome, "observed");
    assert.equal(out.terminal, false);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("O2: window expiry (clean final read) → observationOutcome=observed, not_terminal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-o2-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-o2-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_o2", { workspaceCwd: dir, messages: [], terminal: false });
    const clk = clockSleep();
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({
      runId: "run_o2", runDir, waitMs: 4000,
      nowFn: clk.now, pollIntervalMs: 2000, sleepFn: async (ms) => { clk.sleep(ms); },
    });
    assert.equal(out.observationOutcome, "observed");
    assert.equal(out.terminal, false);
    assert.equal(out.result.status, "not_terminal");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("O3: post-initial re-read failure → read_failure, stale facts, NO fresh-heartbeat combination", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-o3-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-o3-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_o3", { workspaceCwd: dir, messages: [], terminal: false });
    const { readTranscript } = await import("../src/transcript.js");
    let readCalls = 0;
    const clk = clockSleep();
    // A FRESH owner heartbeat file exists at expiry. The composite must NOT
    // combine it with stale events to report process_only/fresh — the read
    // failed, so the observation is stale/unknown.
    writeFileSync(join(runDir, ".owner-run_o3"), JSON.stringify({ pid: 1, heartbeatAt: clk.get() + 99999 }));
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({
      runId: "run_o3", runDir, waitMs: 4000,
      nowFn: clk.now, pollIntervalMs: 2000, sleepFn: async (ms) => { clk.sleep(ms); },
      readTranscriptFn: async (p) => {
        readCalls++;
        if (readCalls === 1) return readTranscript(p); // initial read succeeds
        throw new Error("transcript vanished");        // re-read fails
      },
    });
    assert.equal(out.observationOutcome, "read_failure", "closed-set field marks the read failure");
    assert.equal(out.terminal, false, "must not fabricate terminal");
    assert.equal(out.liveness, "unknown", "liveness must NOT be derived from stale events");
    assert.equal(out.ownerHeartbeat, "unknown", "must NOT consult the fresh heartbeat on a failed read");
    assert.equal(out.activityEventCount, null);
    assert.equal(out.lastActivityKind, null);
    assert.equal(out.result.status, "unavailable");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("O4: observationOutcome is a closed set {observed, read_failure} on every path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-o4-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-o4-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_o4t", { workspaceCwd: dir, messages: ["x"], terminal: true });
    seedTranscript(runDir, "run_o4n", { workspaceCwd: dir, messages: [], terminal: false });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const terminal = await runAwaitResult({ runId: "run_o4t", runDir, waitMs: 0 });
    const pit = await runAwaitResult({ runId: "run_o4n", runDir, waitMs: 0 });
    for (const o of [terminal, pit]) {
      assert.ok(["observed", "read_failure"].includes(o.observationOutcome), "closed set");
    }
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

// =====================================================================
// Section P — REAL THROTTLING (correction 5).
// Default progress interval is 30000 ms, INDEPENDENT of the internal poll
// interval. Provable upper bound on notifications. Clients without a progress
// token receive none. Terminal still returns early.
// =====================================================================

test("P1: default progressIntervalMs is 30000 and independent of pollIntervalMs", async () => {
  const { RUN_AWAIT_RESULT_DEFAULT_PROGRESS_MS } = await import("../src/application/runAwaitResult.js");
  assert.equal(RUN_AWAIT_RESULT_DEFAULT_PROGRESS_MS, 30000, "default progress interval is 30s");
});

test("P2: progress upper bound — notifications ≤ floor(waitMs/30000)+1 even with a tiny poll interval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-p2-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-p2-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_p2", { workspaceCwd: dir, messages: [], terminal: false });
    const clk = clockSleep();
    let polls = 0;
    const notifications = [];
    const WAIT = 90000;
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    // pollIntervalMs tiny (1000), progressIntervalMs DEFAULT (30000) — prove independence.
    const out = await runAwaitResult({
      runId: "run_p2", runDir, waitMs: WAIT,
      nowFn: clk.now, pollIntervalMs: 1000,
      sleepFn: async (ms) => { clk.sleep(ms); polls++; },
      onProgress: async (info) => { notifications.push(info); },
    });
    assert.equal(out.terminal, false);
    const bound = Math.floor(WAIT / 30000) + 1; // = 4
    assert.ok(notifications.length <= bound,
      `progress upper bound violated: ${notifications.length} > ${bound} (polls=${polls})`);
    assert.ok(notifications.length < polls,
      `throttle must emit fewer notifications than polls: ${notifications.length} vs ${polls}`);
    assert.ok(notifications.length >= 1, "at least the first notification fires");
    assert.ok(notifications[0].waitedMs >= 30000,
      `first keepalive must not fire before 30s (got ${notifications[0].waitedMs})`);
    for (let i = 1; i < notifications.length; i += 1) {
      assert.ok(notifications[i].fraction >= notifications[i - 1].fraction, "fraction non-decreasing");
      assert.ok(
        notifications[i].waitedMs - notifications[i - 1].waitedMs >= 30000,
        "keepalives must remain at least 30s apart",
      );
    }
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("P3: no onProgress hook → zero notifications, wait still completes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-p3-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-p3-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_p3", { workspaceCwd: dir, messages: [], terminal: false });
    const clk = clockSleep();
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({
      runId: "run_p3", runDir, waitMs: 3000,
      nowFn: clk.now, pollIntervalMs: 1000, sleepFn: async (ms) => { clk.sleep(ms); },
    });
    assert.equal(out.terminal, false);
    // No hook → nothing to count; the contract is the absence of a side channel.
    assert.equal(out.observationOutcome, "observed");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("P4: a thrown notification does not break the wait", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-p4-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-p4-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_p4", { workspaceCwd: dir, messages: [], terminal: false });
    const clk = clockSleep();
    let throws = 0;
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({
      runId: "run_p4", runDir, waitMs: 3000,
      nowFn: clk.now, pollIntervalMs: 1000, sleepFn: async (ms) => { clk.sleep(ms); },
      progressIntervalMs: 1000,
      onProgress: async () => { throws++; throw new Error("transport down"); },
    });
    assert.equal(out.terminal, false, "wait completed despite notification throws");
    assert.ok(throws > 0, "the hook was invoked");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("P5: a never-settling progress hook cannot consume the composition budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-p5-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-p5-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_p5", { workspaceCwd: dir, messages: [], terminal: false });
    const clk = clockSleep();
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const operation = runAwaitResult({
      runId: "run_p5",
      runDir,
      waitMs: 3000,
      nowFn: clk.now,
      pollIntervalMs: 1000,
      progressIntervalMs: 1000,
      sleepFn: async (ms) => { clk.sleep(ms); },
      onProgress: () => new Promise(() => {}),
    });
    const out = await Promise.race([
      operation,
      new Promise((_, reject) => setTimeout(() => reject(new Error("progress hook blocked the wait")), 100)),
    ]);
    assert.equal(out.terminal, false);
    assert.equal(out.waitedMs, 3000);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

// =====================================================================
// Section C — COMPACT CONTRACT REUSE (correction 7).
// Last assistant text verbatim ≤4000, configured secret redaction + C0/C1/DEL
// sanitization reuse, no raw commands/tool inputs/paths/PIDs/sessions.
// too_large/empty semantics remain truthful.
// =====================================================================

test("C1: exact secret in compact text is redacted (M12-2A SSOT reuse)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-c1-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-c1-rd-"));
  try {
    makeGitRepo(dir);
    const secret = "test-secret-c1"; // >=8; scan-safe marker (desensitization ALLOW)
    seedTranscript(runDir, "run_c1", { workspaceCwd: dir, messages: [`result: LEAKED_SECRET=${secret} done`], terminal: true });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: "run_c1", runDir, waitMs: 0, env: { LEAKED_SECRET: secret } });
    assert.equal(out.result.status, "available");
    const text = out.result.messages[0].text;
    assert.ok(!text.includes(secret), "raw secret must not appear");
    assert.ok(/\[REDACTED:/.test(text), "secret replaced with a redaction marker");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("C2: C0/C1/DEL control chars sanitized; LF/TAB preserved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-c2-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-c2-rd-"));
  try {
    makeGitRepo(dir);
    // eslint-disable-next-line no-control-regex
    const raw = "a\x00b\x01c\x7fd\x80e\x9ff\nnew\ttab";
    seedTranscript(runDir, "run_c2", { workspaceCwd: dir, messages: [raw], terminal: true });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: "run_c2", runDir, waitMs: 0 });
    assert.equal(out.result.status, "available");
    const text = out.result.messages[0].text;
    assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text), "no C0/DEL/C1 controls remain");
    assert.ok(text.includes("\n") && text.includes("\t"), "LF/TAB preserved");
    assert.ok(text.includes("\uFFFD"), "unsafe controls became replacement char");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("C3: too_large (last text > 4000) → no partial text, empty messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-c3-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-c3-rd-"));
  try {
    makeGitRepo(dir);
    const { COLLECT_MAX_TEXT_CHARS } = await import("../src/application/runCollectProjection.js");
    seedTranscript(runDir, "run_c3", { workspaceCwd: dir, messages: ["x".repeat(COLLECT_MAX_TEXT_CHARS + 1)], terminal: true });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: "run_c3", runDir, waitMs: 0 });
    assert.equal(out.result.status, "too_large");
    assert.deepEqual(out.result.messages, []);
    assert.equal(out.result.assistantMessageCount, 1);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("C4: compact output never surfaces raw commands/tool inputs/paths/session id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-c4-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-c4-rd-"));
  try {
    makeGitRepo(dir);
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const a = "coder_low", id = "run_c4";
    const lines = [
      jl({ type: "run.submitted", agentId: a, ts: "2026-07-28T00:00:00.000Z", runId: id }),
      jl({ type: "session.created", backend: "process", backendSessionId: "proc_await_4242", runId: id, agentId: a }),
      jl({ type: "run.background_submitted", background: true, cwd: dir, runId: id, agentId: a }),
      jl({ type: "run.state_change", to: "running", reason: "first_event", ts: "2026-07-28T00:00:03.000Z", runId: id, agentId: a }),
      jl({ type: "run.event", kind: "command", command: `rm -rf / && cat ${secret}`, exitCode: 0, runId: id, agentId: a }),
      jl({ type: "run.event", kind: "tool_use", tool: "Bash", input: { cmd: `/bin/sh -c 'leak ${secret}'` }, runId: id, agentId: a }),
      jl({ type: "run.event", kind: "file_written", path: "C:\\Users\\secret\\key.pem", runId: id, agentId: a }),
      jl({ type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "Done: result is 42." }], ts: "2026-07-28T00:00:10.000Z", runId: id, agentId: a }),
      jl({ type: "run.completed", ts: "2026-07-28T00:10:00.000Z", runId: id, agentId: a }),
      jl({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-07-28T00:10:01.000Z", runId: id, agentId: a }),
    ];
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, `${id}.jsonl`), lines.join(""), "utf8");
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: id, runDir, waitMs: 0 });
    const dumped = JSON.stringify(out);
    assert.equal(out.result.status, "available");
    assert.ok(!dumped.includes(secret), "no secret");
    assert.ok(!dumped.includes("rm -rf"), "no command string");
    assert.ok(!dumped.includes("/bin/sh"), "no tool input/path");
    assert.ok(!dumped.toLowerCase().includes("c:\\\\users\\\\secret"), "no windows path");
    assert.ok(!dumped.includes("4242") && !dumped.includes("proc_await"), "no session id");
    assert.ok(dumped.includes("Done: result is 42."), "benign assistant text IS returned");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

// =====================================================================
// Section R — READ-ONLY / IDEMPOTENT (corrections 7+8).
// Zero messages.collected on every path; never invoke commitAppend; repeated
// point-in-time calls are deepEqual.
// =====================================================================

test("R1: terminal collect appends ZERO audits and leaves transcript bytes unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r1-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-r1-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_r1", { workspaceCwd: dir, messages: ["final"], terminal: true });
    const tp = join(runDir, "run_r1.jsonl");
    const before = readFileSync(tp);
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: "run_r1", runDir, waitMs: 0 });
    assert.equal(out.result.status, "available");
    assert.equal(readFileSync(tp).equals(before), true, "transcript bytes unchanged");
    assert.equal(countAudits(tp), 0, "zero messages.collected (read-only)");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("R2: repeated point-in-time calls are idempotent (deepEqual) and append zero", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r2-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-r2-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_r2", { workspaceCwd: dir, messages: ["final"], terminal: true });
    const tp = join(runDir, "run_r2.jsonl");
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const a = await runAwaitResult({ runId: "run_r2", runDir, waitMs: 0 });
    const b = await runAwaitResult({ runId: "run_r2", runDir, waitMs: 0 });
    assert.deepEqual(a, b, "repeated calls are idempotent");
    assert.equal(countAudits(tp), 0, "zero audits across both calls");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("R3: projection failure → unavailable, terminal facts preserved, zero append", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r3-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-r3-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_r3", { workspaceCwd: dir, messages: ["answer"], terminal: true });
    const tp = join(runDir, "run_r3.jsonl");
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({
      runId: "run_r3", runDir, waitMs: 0,
      projectCollectResultFn: () => { throw new Error("boom secret path C:\\x PID=9"); },
    });
    assert.equal(out.terminal, true, "terminal observation preserved across projection failure");
    assert.equal(out.result.status, "unavailable");
    assert.deepEqual(out.result.messages, []);
    assert.equal(countAudits(tp), 0);
    const json = JSON.stringify(out);
    assert.ok(!json.includes("secret") && !json.includes("PID=9"), "no error detail in result");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

// =====================================================================
// Section V — FAIL-CLOSED VALIDATION before any read (correction 9).
// =====================================================================

test("V1: invalid runId rejected before any read", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-v1-rd-"));
  try {
    let reads = 0;
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    await assert.rejects(
      () => runAwaitResult({ runId: "../escape", runDir, waitMs: 0, readTranscriptFn: async () => { reads++; return []; } }),
      /runId/i,
    );
    assert.equal(reads, 0);
  } finally { rmrfRetry(runDir); }
});

test("V2: invalid afterSeq rejected (negative / non-integer)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-v2-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-v2-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_v2", { workspaceCwd: dir, messages: [], terminal: false });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    await assert.rejects(() => runAwaitResult({ runId: "run_v2", runDir, waitMs: 0, afterSeq: -1 }), /afterSeq|invalid/i);
    await assert.rejects(() => runAwaitResult({ runId: "run_v2", runDir, waitMs: 0, afterSeq: 1.5 }), /afterSeq|invalid/i);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("V3: invalid waitMs rejected (negative / non-integer / > 270000)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-v3-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-v3-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_v3", { workspaceCwd: dir, messages: [], terminal: false });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    await assert.rejects(() => runAwaitResult({ runId: "run_v3", runDir, waitMs: -1 }), /waitMs/i);
    await assert.rejects(() => runAwaitResult({ runId: "run_v3", runDir, waitMs: 1.5 }), /waitMs/i);
    await assert.rejects(() => runAwaitResult({ runId: "run_v3", runDir, waitMs: 270001 }), /waitMs/i);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("V4: cross-workspace rejected (ownership mismatch)", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "wao-v4a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wao-v4b-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-v4-rd-"));
  try {
    makeGitRepo(dirA); makeGitRepo(dirB);
    seedTranscript(runDir, "run_v4", { workspaceCwd: dirA, messages: [], terminal: false });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    await assert.rejects(
      () => runAwaitResult({ runId: "run_v4", runDir, waitMs: 0, authorizedWorkspaceRoot: dirB }),
    );
  } finally { cleanupDir(dirA); cleanupDir(dirB); rmrfRetry(runDir); }
});

// =====================================================================
// Section I — agentId canonical/unknown projection (correction 9).
// =====================================================================

test("I1: agentId from envelope; cross-run contamination degrades to unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-i1-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-i1-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_i1", { workspaceCwd: dir, agentId: "coder_low", messages: ["x"], terminal: true });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const ok = await runAwaitResult({ runId: "run_i1", runDir, waitMs: 0 });
    assert.equal(ok.agentId, "coder_low");

    // Cross-run contamination: envelope runId "run_i1" but file is run_OTHER.
    const cross = [
      jl({ type: "run.submitted", agentId: "coder_low", ts: "2026-07-28T00:00:00.000Z", runId: "run_i1" }),
      jl({ type: "session.created", backend: "process", backendSessionId: "p2", runId: "run_i1", agentId: "coder_low" }),
      jl({ type: "run.background_submitted", background: true, cwd: dir, runId: "run_i1", agentId: "coder_low" }),
      jl({ type: "run.state_change", to: "running", reason: "x", ts: "2026-07-28T00:00:03.000Z", runId: "run_i1", agentId: "coder_low" }),
    ];
    writeFileSync(join(runDir, "run_OTHER.jsonl"), cross.join(""), "utf8");
    const out = await runAwaitResult({ runId: "run_OTHER", runDir, waitMs: 0 });
    assert.equal(out.agentId, "unknown");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

// =====================================================================
// Section A — ARCHITECTURE PURITY (corrections 6+9).
// =====================================================================

test("A1: runAwaitResult.js imports no commands/mcp/SDK/zod", async () => {
  const { readFileSync: rf } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = rf(join(join(fileURLToPath(new URL(".", import.meta.url))), "..", "src", "application", "runAwaitResult.js"), "utf8");
  assert.ok(!src.includes('from "../commands/'), "no commands/");
  assert.ok(!src.includes('from "../mcp/'), "no mcp/");
  assert.ok(!src.includes("@modelcontextprotocol/sdk"), "no SDK");
  assert.ok(!src.includes('from "zod"'), "no zod");
});

test("A2: runAwaitResult.js reuses M12-2A projection + shared reconstruction (no second parser)", async () => {
  const { readFileSync: rf } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = rf(join(join(fileURLToPath(new URL(".", import.meta.url))), "..", "src", "application", "runAwaitResult.js"), "utf8");
  assert.ok(src.includes("projectCollectResult"), "reuses projectCollectResult SSOT");
  assert.ok(src.includes('mode: "compact"'), "projects compact (M12-2A)");
  assert.ok(/reconstructItemsFromEvents/.test(src), "uses the shared snapshot reconstruction");
  assert.ok(!/createSecretRedactor|sanitizeControls|extractAssistantTexts/.test(src), "no duplicated redaction/parser internals");
});

test("A3: runAwaitResult.js is snapshot-only — no collectRunMessages / opencodeServe import (no serve fetch)", async () => {
  const { readFileSync: rf } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = rf(join(join(fileURLToPath(new URL(".", import.meta.url))), "..", "src", "application", "runAwaitResult.js"), "utf8");
  assert.ok(!/collectRunMessages/.test(src), "must NOT import collectRunMessages (avoids serve fetch path)");
  assert.ok(!/opencodeServe/.test(src), "must NOT import the serve backend (snapshot-only)");
});
