// test/runWait.test.js
//
// M10-pre3 Batch B: run_wait service tests（CLI runs wait 面）。
// 批 119：MCP run_wait 工具已真删除——原 MCP adapter 段（MCP-WAIT-*、
// RED-01/02、WAIT-13、KEEPALIVE-*、0097 归属拒绝的 MCP 面）随工具退役；
// 等待机制在 MCP 面的覆盖由 mcpRunAwaitResult.test.js 承接（keepalive 同款）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { JsonlTranscript, readTranscript } from "../../src/transcript.js";

function makeGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "R.md"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: dir });
}

async function seedRunningRun(runDir, runId, workspaceCwd) {
  const tp = join(runDir, `${runId}.jsonl`);
  const t = new JsonlTranscript(tp, { runId, agentId: "coder_low" });
  await t.append("run.started", { backend: "claude-code" });
  await t.append("run.background_submitted", { background: true, cwd: workspaceCwd });
  await t.append("session.created", { backend: "process", backendSessionId: "proc_99999" });
  await t.transitionState(null, "pending", "created");
  await t.transitionState("pending", "running", "first_event");
  return tp;
}

async function seedCompletedRun(runDir, runId, workspaceCwd) {
  const tp = join(runDir, `${runId}.jsonl`);
  const t = new JsonlTranscript(tp, { runId, agentId: "coder_low" });
  await t.append("run.started", { backend: "claude-code" });
  await t.append("run.background_submitted", { background: true, cwd: workspaceCwd });
  await t.append("session.created", { backend: "process", backendSessionId: "proc_99999" });
  await t.transitionState(null, "pending", "created");
  await t.transitionState("pending", "running", "first_event");
  await t.append("run.completed", {});
  await t.transitionState("running", "completed", "done");
  return tp;
}

function fakeSleep() {
  const calls = [];
  return { calls, fn: (ms) => { calls.push(ms); return Promise.resolve(); } };
}

function fakeNow(start = 1000000) {
  let t = start;
  return { advance: (ms) => { t += ms; }, fn: () => t };
}

test("WAIT-RUNTIME-1: runtime activity counts as safe progress without exposing provider payload", async () => {
  const { summarizeLiveness } = await import("../../src/application/runWait.js");
  const result = summarizeLiveness({
    events: [{
      type: "run.event",
      kind: "runtime_activity",
      status: "provider_retry",
      error: "SECRET_PROVIDER_ERROR",
      seq: 2,
    }],
    runDir: "D:/does-not-exist",
    runId: "run_runtime_progress",
    activityBaseline: 0,
    now: Date.now(),
  });
  assert.equal(result.liveness, "progress");
  assert.equal(result.activityEventCount, 1);
  assert.equal(result.lastActivityKind, "runtime_status");
  assert.ok(!JSON.stringify(result).includes("SECRET_PROVIDER_ERROR"));
});

// ── Service tests ────────────────────────────────────────────────────────────

test("WAIT-01: already terminal → immediate return", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wait-01-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-wait-01-rd-"));
  try {
    makeGitRepo(dir);
    await seedCompletedRun(runDir, "run_done", dir);
    const { runWait } = await import("../../src/application/runWait.js");
    const result = await runWait({
      runId: "run_done", runDir, waitMs: 180000,
      sleepFn: () => Promise.resolve(), nowFn: () => Date.now(),
    });
    assert.equal(result.terminal, true);
    assert.equal(result.returnedEarly, true);
    assert.equal(result.liveness, "terminal");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("WAIT-02: enters terminal during wait → early return", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wait-02-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-wait-02-rd-"));
  try {
    makeGitRepo(dir);
    const tp = await seedRunningRun(runDir, "run_active", dir);
    const { runWait } = await import("../../src/application/runWait.js");
    let callCount = 0;
    const result = await runWait({
      runId: "run_active", runDir, waitMs: 180000,
      sleepFn: (ms) => {
        callCount++;
        if (callCount === 1) {
          // Simulate terminal transition happening during wait
          const t = new JsonlTranscript(tp, { runId: "run_active", agentId: "coder_low" });
          return t.append("run.completed", {}).then(() => t.transitionState("running", "completed", "done"));
        }
        return Promise.resolve();
      },
      nowFn: (() => { let t = 1000000; return () => (t += 1000); })(),
    });
    assert.equal(result.terminal, true);
    assert.equal(result.returnedEarly, true);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("WAIT-03: expired with progress events → liveness=progress", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wait-03-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-wait-03-rd-"));
  try {
    makeGitRepo(dir);
    const tp = await seedRunningRun(runDir, "run_prog", dir);
    // Add progress events
    const t = new JsonlTranscript(tp, { runId: "run_prog", agentId: "coder_low" });
    await t.append("run.event", { kind: "tool_use", tool: "Read" });
    await t.append("run.event", { kind: "command", command: "npm test", exitCode: 0 });

    const { runWait } = await import("../../src/application/runWait.js");
    // Fake time that immediately expires (now > deadline)
    const result = await runWait({
      runId: "run_prog", runDir, waitMs: 180000, afterSeq: 0,
      sleepFn: () => Promise.resolve(),
      nowFn: (() => { let t = 1000000; return () => (t += 200000); })(), // advances past waitMs immediately
    });
    assert.equal(result.terminal, false);
    assert.equal(result.liveness, "progress");
    assert.ok(result.activityEventCount > 0, "must count progress events");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("WAIT-04: no progress + fresh heartbeat → process_only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wait-04-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-wait-04-rd-"));
  try {
    makeGitRepo(dir);
    const tp = await seedRunningRun(runDir, "run_hb", dir);
    const events = await readTranscript(tp);
    const lastSeq = events[events.length - 1].seq;

    // Use a constant nowFn that always returns a fixed value past the deadline.
    // deadline = fixedNow + waitMs = fixedNow + 180000. Since now never changes,
    // _now() < deadline is always true → loop runs forever with sleep.
    // So instead, use a nowFn that jumps past deadline after first call.
    // First call sets deadline. Second call (loop check) must exceed deadline.
    // Final call (liveness) uses the same jumped value.
    const FIXED_NOW = 1000000;
    let callCount = 0;
    writeFileSync(join(runDir, ".owner-run_hb"), JSON.stringify({
      pid: 12345, heartbeatAt: FIXED_NOW + 200000 - 3000, // fresh: within 10s of jumped now
    }));

    const { runWait } = await import("../../src/application/runWait.js");
    const result = await runWait({
      runId: "run_hb", runDir, waitMs: 180000, afterSeq: lastSeq,
      sleepFn: () => Promise.resolve(),
      nowFn: () => {
        callCount++;
        if (callCount === 1) return FIXED_NOW; // initial: sets deadline
        return FIXED_NOW + 200000; // all subsequent: past deadline, heartbeat fresh
      },
    });
    assert.equal(result.liveness, "process_only", `expected process_only, got ${result.liveness}`);
    assert.equal(result.ownerHeartbeat, "fresh");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("WAIT-05: no progress + stale heartbeat → silent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wait-05-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-wait-05-rd-"));
  try {
    makeGitRepo(dir);
    const tp = await seedRunningRun(runDir, "run_silent", dir);
    const events = await readTranscript(tp);
    const lastSeq = events[events.length - 1].seq;

    const FIXED_NOW = 1000000;
    let callCount = 0;
    // Stale heartbeat: far before the jumped now
    writeFileSync(join(runDir, ".owner-run_silent"), JSON.stringify({
      pid: 12345, heartbeatAt: FIXED_NOW + 200000 - 60000, // 60s before now → stale (>10s threshold)
    }));

    const { runWait } = await import("../../src/application/runWait.js");
    const result = await runWait({
      runId: "run_silent", runDir, waitMs: 180000, afterSeq: lastSeq,
      sleepFn: () => Promise.resolve(),
      nowFn: () => {
        callCount++;
        if (callCount === 1) return FIXED_NOW;
        return FIXED_NOW + 200000;
      },
    });
    assert.equal(result.liveness, "silent");
    assert.equal(result.ownerHeartbeat, "stale");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("WAIT-06: afterSeq cursor — only counts events after cursor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wait-06-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-wait-06-rd-"));
  try {
    makeGitRepo(dir);
    const tp = await seedRunningRun(runDir, "run_cursor", dir);
    const t = new JsonlTranscript(tp, { runId: "run_cursor", agentId: "coder_low" });
    await t.append("run.event", { kind: "tool_use", tool: "Read" });
    const events = await readTranscript(tp);
    const lastSeq = events[events.length - 1].seq;

    const { runWait } = await import("../../src/application/runWait.js");
    const result = await runWait({
      runId: "run_cursor", runDir, waitMs: 180000, afterSeq: lastSeq,
      sleepFn: () => Promise.resolve(),
      nowFn: (() => { let t = Date.now(); return () => (t += 200000); })(),
    });
    // No events after lastSeq → no progress
    assert.equal(result.activityEventCount, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("WAIT-07: workspace mismatch → throw", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "wao-wait-07a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wao-wait-07b-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-wait-07-rd-"));
  try {
    makeGitRepo(dirA); makeGitRepo(dirB);
    await seedRunningRun(runDir, "run_xws", dirA);
    const { runWait } = await import("../../src/application/runWait.js");
    await assert.rejects(
      () => runWait({
        runId: "run_xws", runDir, waitMs: 180000, authorizedWorkspaceRoot: dirB,
        sleepFn: () => Promise.resolve(), nowFn: () => Date.now(),
      }),
    );
  } finally { rmSync(dirA, { recursive: true, force: true }); rmSync(dirB, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("WAIT-08: transcript bytes unchanged after wait", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wait-08-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-wait-08-rd-"));
  try {
    makeGitRepo(dir);
    await seedRunningRun(runDir, "run_ro", dir);
    const before = readFileSync(join(runDir, "run_ro.jsonl"));
    const { runWait } = await import("../../src/application/runWait.js");
    await runWait({
      runId: "run_ro", runDir, waitMs: 180000,
      sleepFn: () => Promise.resolve(),
      nowFn: (() => { let t = Date.now(); return () => (t += 200000); })(),
    });
    const after = readFileSync(join(runDir, "run_ro.jsonl"));
    assert.deepEqual(after, before, "transcript bytes must be unchanged");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// ── M12-14 poll-snapshot closeout: re-prove ownership on every re-read ──────

test("M12-14-POLL-OWN-01: a foreign transcript replacement between polls re-proves ownership — it cannot return terminal facts", async () => {
  // Causal: the initial read binds ownership to the requested run (cwd=dirA),
  // so the wait enters the poll loop AUTHORIZED. A replacement snapshot for the
  // SAME runId but a DIFFERENT workspace (cwd=dirB, terminal) must NOT inherit
  // that authorization: every successful re-read must re-prove ownership and
  // fail closed with the SAME authorization error as the initial read — never
  // return the foreign terminal/state facts. (RED on the candidate: the re-read
  // drove currentState="completed" and returned terminal:true.)
  const dirA = mkdtempSync(join(tmpdir(), "wao-pollown-01a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wao-pollown-01b-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-pollown-01-rd-"));
  try {
    makeGitRepo(dirA);
    makeGitRepo(dirB);
    const runId = "run_pollown01";
    // Initial snapshot: valid ownership (cwd=dirA), still running → poll loop.
    const initialEvents = [
      { type: "run.started", runId, cwd: dirA, ts: "2026-01-01T00:00:00Z", seq: 1 },
      { type: "run.state_change", runId, ts: "2026-01-01T00:00:01Z", seq: 2, from: "pending", to: "running" },
    ];
    // Replacement snapshot: SAME runId, DIFFERENT workspace, terminal.
    const replacementEvents = [
      { type: "run.started", runId, cwd: dirB, ts: "2026-01-01T00:00:00Z", seq: 1 },
      { type: "run.completed", runId, ts: "2026-01-01T00:00:01Z", seq: 2 },
      { type: "run.state_change", runId, ts: "2026-01-01T00:00:02Z", seq: 3, from: "running", to: "completed" },
    ];
    let reads = 0;
    const { runWait } = await import("../../src/application/runWait.js");
    let rejection = null;
    try {
      await runWait({
        runId, runDir, waitMs: 180000, authorizedWorkspaceRoot: dirA,
        // Constant clock: the deadline is far away, so only the re-read's
        // authorization failure stops the poll (never time expiry).
        sleepFn: async () => {},
        nowFn: () => 1000000,
        pollIntervalMs: 50,
        readTranscriptFn: async () => {
          reads += 1;
          return reads === 1 ? initialEvents : replacementEvents;
        },
      });
    } catch (err) { rejection = err; }
    assert.ok(rejection, "foreign replacement must fail closed, not return terminal facts");
    assert.match(rejection.message, /workspace mismatch|missing ownership|unprovable/i,
      "same fail-closed authorization error family as the initial read");
    assert.ok(!rejection.message.includes(dirB), "no foreign path echoed");
    assert.ok(reads >= 2, "initial read + at least one re-read (the replacement snapshot)");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

// ── Architecture ─────────────────────────────────────────────────────────────

test("ARCH-WAIT-01: runWait.js does not import commands/mcp/SDK/zod", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(
    join(join(fileURLToPath(new URL(".", import.meta.url))), "../..", "src", "application", "runWait.js"),
    "utf8",
  );
  assert.ok(!src.includes('from "../commands/'), "no commands/");
  assert.ok(!src.includes('from "../mcp/'), "no mcp/");
  assert.ok(!src.includes("@modelcontextprotocol/sdk"), "no SDK");
  assert.ok(!src.includes('from "zod"'), "no zod");
});

test("ARCH-WAIT-02: ownerLiveness.js does not import commands/mcp/SDK/zod", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(
    join(join(fileURLToPath(new URL(".", import.meta.url))), "../..", "src", "application", "ownerLiveness.js"),
    "utf8",
  );
  assert.ok(!src.includes('from "../commands/'), "no commands/");
  assert.ok(!src.includes('from "../mcp/'), "no mcp/");
  assert.ok(!src.includes("@modelcontextprotocol/sdk"), "no SDK");
  assert.ok(!src.includes('from "zod"'), "no zod");
});

// ── P1-B / P1-C / P2-A RED: cursor semantics + metrics + service validation ─

// afterSeq omitted: baseline = max seq at first read, only NEW events count.
test("WAIT-09 (P1-B): afterSeq omitted → history not counted as progress", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wait-09-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-wait-09-rd-"));
  try {
    makeGitRepo(dir);
    const tp = await seedRunningRun(runDir, "run_omitted", dir);
    // Historical events BEFORE the wait window — must NOT be counted.
    const t = new JsonlTranscript(tp, { runId: "run_omitted", agentId: "coder_low" });
    await t.append("run.event", { kind: "tool_use", tool: "Read" });
    await t.append("run.event", { kind: "command", command: "npm test", exitCode: 0 });
    const { runWait } = await import("../../src/application/runWait.js");
    // afterSeq omitted entirely (NOT explicit 0).
    const result = await runWait({
      runId: "run_omitted", runDir, waitMs: 180000,
      sleepFn: () => Promise.resolve(),
      nowFn: (() => { let t = Date.now(); return () => (t += 200000); })(),
    });
    assert.equal(result.activityEventCount, 0, "omitted cursor must NOT count pre-window history");
    assert.notEqual(result.liveness, "progress", "must not falsely report progress from history");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// afterSeq explicit 0: caller INTENDS to count all history.
test("WAIT-10 (P1-B): afterSeq explicit 0 → counts all history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wait-10-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-wait-10-rd-"));
  try {
    makeGitRepo(dir);
    const tp = await seedRunningRun(runDir, "run_explicit0", dir);
    const t = new JsonlTranscript(tp, { runId: "run_explicit0", agentId: "coder_low" });
    await t.append("run.event", { kind: "tool_use", tool: "Read" });
    await t.append("run.event", { kind: "command", command: "npm test", exitCode: 0 });
    const { runWait } = await import("../../src/application/runWait.js");
    // Explicit 0 — caller opts into full-history inventory.
    const result = await runWait({
      runId: "run_explicit0", runDir, waitMs: 180000, afterSeq: 0,
      sleepFn: () => Promise.resolve(),
      nowFn: (() => { let t = Date.now(); return () => (t += 200000); })(),
    });
    assert.ok(result.activityEventCount >= 2, "explicit 0 must count all history");
    assert.equal(result.liveness, "progress");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// run.metrics is a real transcript type written by runManager (NOT run.event kind=metrics).
test("WAIT-11 (P1-C): run.metrics counted as progress, kind=metrics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wait-11-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-wait-11-rd-"));
  try {
    makeGitRepo(dir);
    const tp = await seedRunningRun(runDir, "run_metrics", dir);
    const events = await readTranscript(tp);
    const lastSeq = events[events.length - 1].seq;
    const t = new JsonlTranscript(tp, { runId: "run_metrics", agentId: "coder_low", initialSeq: lastSeq });
    // run.metrics is its own transcript type (see runManager.js:791).
    await t.append("run.metrics", { tokens: { input: 10, output: 5 }, costUsd: 0.001 });
    const { runWait } = await import("../../src/application/runWait.js");
    const result = await runWait({
      runId: "run_metrics", runDir, waitMs: 180000, afterSeq: lastSeq,
      sleepFn: () => Promise.resolve(),
      nowFn: (() => { let t = Date.now(); return () => (t += 200000); })(),
    });
    assert.equal(result.activityEventCount, 1, "run.metrics must be counted");
    assert.equal(result.lastActivityKind, "metrics", "kind must be metrics");
    assert.equal(result.liveness, "progress");
    // Must NOT leak token/cost values.
    const json = JSON.stringify(result);
    assert.ok(!json.includes("0.001"), "must not leak costUsd");
    assert.ok(!json.includes("\"input\":10"), "must not leak raw token values");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// P2-A: service must validate afterSeq itself (not rely on MCP zod).
test("WAIT-12 (P2-A): afterSeq=-1 rejected by service", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wait-12-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-wait-12-rd-"));
  try {
    makeGitRepo(dir);
    await seedRunningRun(runDir, "run_neg", dir);
    const { runWait } = await import("../../src/application/runWait.js");
    await assert.rejects(
      () => runWait({
        runId: "run_neg", runDir, waitMs: 180000, afterSeq: -1,
        sleepFn: () => Promise.resolve(),
        nowFn: (() => { let t = Date.now(); return () => (t += 200000); })(),
      }),
      /afterSeq|invalid/i,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("WAIT-12b (P2-A): afterSeq non-integer rejected by service", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wait-12b-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-wait-12b-rd-"));
  try {
    makeGitRepo(dir);
    await seedRunningRun(runDir, "run_frac", dir);
    const { runWait } = await import("../../src/application/runWait.js");
    await assert.rejects(
      () => runWait({
        runId: "run_frac", runDir, waitMs: 180000, afterSeq: 1.5,
        sleepFn: () => Promise.resolve(),
        nowFn: (() => { let t = Date.now(); return () => (t += 200000); })(),
      }),
      /afterSeq|invalid/i,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// ── 119 续修 4（会审必改）：从父提交 6826b48e 原样恢复两条纯服务测试。───────
// 它们直接调 runWait()（CLI runs wait 面），与已删除的 MCP run_wait 工具无关，
// 上一轮删 MCP 段时被误删；断言逐字保留。

test("M11-11A-RED-01: omitted service wait uses the 270-second observation default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wait-m1111a-01-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-wait-m1111a-01-rd-"));
  try {
    makeGitRepo(dir);
    await seedRunningRun(runDir, "run_default_270", dir);
    const { runWait } = await import("../../src/application/runWait.js");
    let now = 0;
    let slept = 0;
    const result = await runWait({
      runId: "run_default_270",
      runDir,
      pollIntervalMs: 30000,
      nowFn: () => now,
      sleepFn: async (ms) => {
        slept += ms;
        now += ms;
      },
    });
    assert.equal(result.returnedEarly, false);
    assert.equal(slept, 270000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("WAIT-13 (P2-B): two concurrent runWait calls → zero durable writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wait-13-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-wait-13-rd-"));
  try {
    makeGitRepo(dir);
    const tp = await seedRunningRun(runDir, "run_conc", dir);
    const before = readFileSync(tp);
    const { runWait } = await import("../../src/application/runWait.js");
    const jump = (() => { let t = Date.now(); return () => (t += 200000); })();
    await Promise.all([
      runWait({ runId: "run_conc", runDir, waitMs: 180000, sleepFn: () => Promise.resolve(), nowFn: jump }),
      runWait({ runId: "run_conc", runDir, waitMs: 180000, sleepFn: () => Promise.resolve(), nowFn: jump }),
    ]);
    const after = readFileSync(tp);
    assert.deepEqual(after, before, "concurrent runWait must not write any transcript bytes");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

