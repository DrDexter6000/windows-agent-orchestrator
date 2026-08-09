// test/m12-11-wait-services.test.js
//
// M12-11 split — APPLICATION SERVICES slice (manifest category: git).
//
// This file was split out of test/m12-11-wait-semantics.test.js at its existing
// section boundaries so the canonical wave's per-file process lifetime stays
// inside the SDK request budget under cross-file load. Every assertion is
// preserved verbatim; no test was added, removed, or relaxed.
//
// This slice carries:
//   W-*   runWait additive facts + red flag A (mid-wait read failure fails
//         closed, NEVER combines stale events with a fresh heartbeat).
//   A-*   runAwaitResult additive facts (observation/termination on every path).
//   RM-*  runManager red flag B (unknown non-null done reason → failed, NEVER
//         timed_out; only waitTimerExpired creates run.timed_out).
//
// Uses isolated git repos + (for RM) a process backend on temp fixtures. Runs in
// the filesystem wave (git category).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { readTranscript } from "../src/transcript.js";
import { RunManager } from "../src/runManager.js";
import { rmrfRetry } from "./_rmrfHelper.mjs";

// ===== Helpers =====

function cleanupDir(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

function makeGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "R.md"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: dir });
}

function jl(obj) { return JSON.stringify(obj) + "\n"; }

function clockSleep(start = 1000000) {
  let t = start;
  return { now: () => t, sleep: (ms) => { t += ms; }, get: () => t, set: (v) => { t = v; } };
}

// Build a transcript on disk. terminal: false | "completed" | "failed" | "aborted" | "timed_out".
// waitPolicy may be {ms, source} to append a run.wait_policy fact.
function seedTranscript(runDir, runId, {
  agentId = "coder_low", messages = [], terminal = false, workspaceCwd, waitPolicy,
} = {}) {
  mkdirSync(runDir, { recursive: true });
  const a = agentId;
  const lines = [
    jl({ type: "run.submitted", agentId: a, ts: "2026-08-03T00:00:00.000Z", runId }),
    jl({ type: "session.created", backend: "process", backendSessionId: "proc_m1211", runId, agentId: a }),
    jl({ type: "run.started", backend: "claude-code", ts: "2026-08-03T00:00:01.000Z", runId, agentId: a }),
    jl({ type: "run.background_submitted", background: true, cwd: workspaceCwd, runId, agentId: a }),
    jl({ type: "run.state_change", to: "pending", reason: "created", ts: "2026-08-03T00:00:02.000Z", runId, agentId: a }),
    jl({ type: "run.state_change", to: "running", reason: "first_event", ts: "2026-08-03T00:00:03.000Z", runId, agentId: a }),
  ];
  if (waitPolicy) {
    lines.push(jl({ type: "run.wait_policy", waitTimeoutMs: waitPolicy.ms, source: waitPolicy.source, runId, agentId: a }));
  }
  for (const [i, text] of messages.entries()) {
    lines.push(jl({
      type: "run.event", kind: "message", role: "assistant",
      parts: [{ type: "text", text }], ts: `2026-08-03T00:00:${10 + i}.000Z`, runId, agentId: a,
    }));
  }
  if (terminal === "completed" || terminal === true) {
    lines.push(jl({ type: "run.completed", ts: "2026-08-03T00:10:00.000Z", runId, agentId: a }));
    lines.push(jl({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-08-03T00:10:01.000Z", runId, agentId: a }));
  } else if (terminal === "failed") {
    lines.push(jl({ type: "run.error", phase: "wait", error: "backend reported failure", ts: "2026-08-03T00:10:00.000Z", runId, agentId: a }));
    lines.push(jl({ type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-08-03T00:10:01.000Z", runId, agentId: a }));
  } else if (terminal === "aborted") {
    lines.push(jl({ type: "run.stop_requested", reason: "user", ts: "2026-08-03T00:10:00.000Z", runId, agentId: a }));
    lines.push(jl({ type: "run.aborted", ts: "2026-08-03T00:10:00.500Z", runId, agentId: a }));
    lines.push(jl({ type: "run.state_change", to: "aborted", reason: "user", ts: "2026-08-03T00:10:01.000Z", runId, agentId: a }));
  } else if (terminal === "timed_out") {
    lines.push(jl({ type: "run.timed_out", ts: "2026-08-03T00:10:00.000Z", runId, agentId: a }));
    lines.push(jl({ type: "run.state_change", to: "timed_out", reason: "timeout", ts: "2026-08-03T00:10:01.000Z", runId, agentId: a }));
  }
  writeFileSync(join(runDir, `${runId}.jsonl`), lines.join(""), "utf8");
}

// =====================================================================
// Section W — runWait additive facts + red flag A (fail-closed read failure).
// =====================================================================

test("W1: window-expiry → observation.outcome=window_expired, termination null; old fields preserved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-w1-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-w1-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_w1", { workspaceCwd: dir, messages: [], terminal: false });
    const clk = clockSleep();
    const { runWait } = await import("../src/application/runWait.js");
    const out = await runWait({
      runId: "run_w1", runDir, waitMs: 180000,
      nowFn: clk.now, pollIntervalMs: 2000, sleepFn: async (ms) => { clk.sleep(ms); },
    });
    assert.equal(out.terminal, false);
    assert.equal(out.observationOutcome, "observed");
    assert.equal(out.readFailureReason, null);
    assert.equal(out.observation.outcome, "window_expired");
    assert.equal(out.observation.windowMs, 180000);
    assert.ok(Number.isInteger(out.observation.waitedMs) && out.observation.waitedMs >= 0);
    assert.equal(out.termination, null);
    // Old fields preserved.
    assert.equal(typeof out.liveness, "string");
    assert.equal(typeof out.cursor, "number");
    assert.equal(out.returnedEarly, false);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("W2: terminal-at-entry → observation.outcome=terminal, termination non-null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-w2-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-w2-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_w2", { workspaceCwd: dir, messages: ["done"], terminal: "completed" });
    const { runWait } = await import("../src/application/runWait.js");
    const out = await runWait({
      runId: "run_w2", runDir, waitMs: 180000,
      sleepFn: () => Promise.resolve(), nowFn: () => Date.now(),
    });
    assert.equal(out.terminal, true);
    assert.equal(out.observation.outcome, "terminal");
    assert.equal(out.observation.waitedMs, 0);
    assert.equal(out.observation.windowMs, 180000);
    assert.ok(out.termination);
    assert.equal(out.termination.state, "completed");
    assert.equal(out.termination.source, "completion");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("W3 (red flag A): mid-wait re-read failure FAILS CLOSED — no stale+fresh combo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-w3-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-w3-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_w3", { workspaceCwd: dir, messages: [], terminal: false });
    const { readTranscript: readReal } = await import("../src/transcript.js");
    let readCalls = 0;
    const clk = clockSleep();
    // A FRESH owner heartbeat exists at expiry. run_wait must NOT combine it
    // with stale events into a clean-looking progress/process_only.
    writeFileSync(join(runDir, ".owner-run_w3"), JSON.stringify({ pid: 1, heartbeatAt: clk.get() + 999999 }));
    const { runWait } = await import("../src/application/runWait.js");
    const out = await runWait({
      runId: "run_w3", runDir, waitMs: 180000,
      nowFn: clk.now, pollIntervalMs: 2000, sleepFn: async (ms) => { clk.sleep(ms); },
      readTranscriptFn: async (p) => {
        readCalls += 1;
        if (readCalls === 1) return readReal(p); // initial read succeeds
        throw new Error("transcript vanished"); // mid-wait re-read fails
      },
    });
    assert.equal(readCalls, 2, "initial read + one failed re-read");
    assert.equal(out.observationOutcome, "read_failure", "must fail CLOSED, not a clean expiry");
    assert.equal(out.terminal, false, "must not fabricate terminal");
    assert.equal(out.liveness, "unknown", "must NOT derive liveness from stale events");
    assert.equal(out.ownerHeartbeat, "unknown", "must NOT consult the fresh heartbeat");
    assert.equal(out.activityEventCount, null);
    assert.equal(out.lastActivityKind, null);
    assert.equal(out.observation.outcome, "read_failure");
    assert.equal(out.termination, null);
    assert.ok(Number.isInteger(out.observation.waitedMs) && out.observation.waitedMs > 0);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("W4: window-expiry does NOT mean worker stopped (termination null, advisory)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-w4-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-w4-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_w4", { workspaceCwd: dir, messages: [], terminal: false });
    const clk = clockSleep();
    const { runWait } = await import("../src/application/runWait.js");
    const out = await runWait({
      runId: "run_w4", runDir, waitMs: 180000,
      nowFn: clk.now, pollIntervalMs: 2000, sleepFn: async (ms) => { clk.sleep(ms); },
    });
    assert.equal(out.terminal, false);
    assert.equal(out.termination, null, "an expired observation window is NOT a worker stop");
    assert.equal(out.observation.outcome, "window_expired");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

// =====================================================================
// Section A — runAwaitResult additive facts (observation/termination).
// =====================================================================

test("A1: point-in-time (waitMs=0) nonterminal → observation.outcome=point_in_time, termination null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-a1-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-a1-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_a1", { workspaceCwd: dir, messages: [], terminal: false });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: "run_a1", runDir, waitMs: 0 });
    assert.equal(out.observationOutcome, "observed");
    assert.equal(out.observation.outcome, "point_in_time");
    assert.equal(out.observation.waitedMs, 0);
    assert.equal(out.observation.windowMs, 0);
    assert.equal(out.termination, null);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("A2: window expiry → observation.outcome=window_expired, termination null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-a2-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-a2-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_a2", { workspaceCwd: dir, messages: [], terminal: false });
    const clk = clockSleep();
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({
      runId: "run_a2", runDir, waitMs: 4000,
      nowFn: clk.now, pollIntervalMs: 2000, sleepFn: async (ms) => { clk.sleep(ms); },
    });
    assert.equal(out.observationOutcome, "observed");
    assert.equal(out.observation.outcome, "window_expired");
    assert.equal(out.termination, null);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("A3: terminal → observation.outcome=terminal, termination non-null (completion)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-a3-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-a3-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_a3", { workspaceCwd: dir, messages: ["final"], terminal: "completed" });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: "run_a3", runDir, waitMs: 0 });
    assert.equal(out.observationOutcome, "observed");
    assert.equal(out.observation.outcome, "terminal");
    assert.ok(out.termination);
    assert.equal(out.termination.state, "completed");
    assert.equal(out.termination.source, "completion");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("A4: read failure → observation.outcome=read_failure, termination null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-a4-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-a4-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_a4", { workspaceCwd: dir, messages: [], terminal: false });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({
      runId: "run_a4", runDir, waitMs: 0,
      readTranscriptFn: async () => { throw new Error("gone"); },
    });
    assert.equal(out.observationOutcome, "read_failure");
    assert.equal(out.observation.outcome, "read_failure");
    assert.equal(out.termination, null);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("A5: failed terminal → termination.source derived (backend_error → backend)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-a5-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-a5-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_a5", { workspaceCwd: dir, messages: ["partial"], terminal: "failed" });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: "run_a5", runDir, waitMs: 0 });
    assert.equal(out.terminal, true);
    assert.equal(out.termination.state, "failed");
    assert.equal(out.termination.source, "backend");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

// =====================================================================
// Section RM — runManager red flag B (unknown done reason → failed, never timed_out).
// =====================================================================

function makeProcessManager(dir, mockBackend, { waitTimeout = null } = {}) {
  const config = {
    registry: "x", runDir: dir, pollInterval: 10, waitTimeout,
    timeout: 5000, retries: 0, defaultIsolation: "none",
  };
  const readRegistry = async () => ({
    getAgent(id, overrides = {}) {
      const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
      return { id, backend: "claude-code", cwd: dir, ...defined };
    },
    listAgents() { return []; },
  });
  return new RunManager({ config, readRegistry, backendFor: () => mockBackend });
}

test("RM1 (red flag B): unknown non-null done reason → failed + throw, NEVER timed_out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-rm1-"));
  try {
    const backend = {
      async spawn() {
        return {
          backend: "process",
          backendSessionId: "proc_unknown_reason",
          events: async function* () {
            yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "working" }] };
            yield { kind: "done", reason: "cancelled" }; // unknown non-null reason
          },
          abort: async () => {},
          isAlive: () => false,
        };
      },
    };
    // waitTimeout null → NO execution-deadline timer. The done event is the
    // sole terminal cause. Previously this fabricated run.timed_out.
    const manager = makeProcessManager(dir, backend, { waitTimeout: null });
    const run = await manager.start("test", { prompt: "go" });

    // Like the done(failed) path, an unknown terminal must fail closed + throw.
    await assert.rejects(() => run.waitForCompletion({ pollInterval: 5 }));
    assert.equal(run.state, "failed", "unknown done reason must terminal as FAILED");

    const events = await readTranscript(run.transcript.filePath);
    const terminalChanges = events.filter((e) => e.type === "run.state_change" && ["failed", "timed_out", "aborted", "completed"].includes(e.to));
    assert.equal(terminalChanges.length, 1, "exactly one terminal fact");
    assert.equal(terminalChanges[0].to, "failed");
    assert.equal(events.some((e) => e.type === "run.timed_out"), false, "NO run.timed_out fact was written");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("RM2: genuine waitTimerExpired still produces timed_out (regression guard)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-rm2-"));
  try {
    const backend = {
      async spawn() {
        return {
          backend: "process",
          backendSessionId: "proc_real_timeout",
          events: async function* (signal) {
            // Block until the deadline timer aborts the controller (hang-safe).
            if (!signal.aborted) {
              await new Promise((resolve) => {
                signal.addEventListener("abort", resolve, { once: true });
                setTimeout(resolve, 3000);
              });
            }
            yield { kind: "done", reason: "failed", error: "killed after timeout" };
          },
          abort: async () => {},
          isAlive: () => false,
        };
      },
    };
    const manager = makeProcessManager(dir, backend, { waitTimeout: 20 });
    const run = await manager.start("test", { prompt: "go" });
    const result = await run.waitForCompletion({ pollInterval: 5 });
    assert.equal(result.timedOut, true);
    assert.equal(run.state, "timed_out");
    const events = await readTranscript(run.transcript.filePath);
    assert.equal(events.filter((e) => e.type === "run.state_change" && e.to === "timed_out").length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("RM3: unknown done reason writes a safe backend failure run.error (no raw reason echo on wire)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-rm3-"));
  try {
    const backend = {
      async spawn() {
        return {
          backend: "process",
          backendSessionId: "proc_unknown_3",
          events: async function* () {
            yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "x" }] };
            yield { kind: "done", reason: "stream_error" }; // unknown non-null reason
          },
          abort: async () => {},
          isAlive: () => false,
        };
      },
    };
    const manager = makeProcessManager(dir, backend, { waitTimeout: null });
    const run = await manager.start("test", { prompt: "go" });
    await assert.rejects(() => run.waitForCompletion({ pollInterval: 5 }));
    assert.equal(run.state, "failed");

    const events = await readTranscript(run.transcript.filePath);
    const failedChange = events.find((e) => e.type === "run.state_change" && e.to === "failed");
    assert.ok(failedChange, "terminal failed");
    // The transition reason is a safe closed-set label, not the raw backend reason.
    assert.equal(typeof failedChange.reason, "string");
    assert.ok(!/stream_error|cancelled/.test(failedChange.reason), "raw backend reason must NOT be echoed in the transition reason");
    assert.equal(events.some((e) => e.type === "run.error" && e.phase === "wait"), true, "a safe run.error fact is recorded");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
