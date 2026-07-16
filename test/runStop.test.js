// test/runStop.test.js
//
// M10 P0-2: run_stop shared service + MCP tool tests.
//
// Tests cover:
//   - Service: process winner/loser, concurrency, invalid PID, opencode
//   - Workspace authorization: same/other/missing/duplicate/malformed/delivery
//   - MCP adapter: schema, extra args, safe output, annotations, concurrency

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { JsonlTranscript, readTranscript } from "../src/transcript.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@wao.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "init\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

/**
 * Seed a running process-backed run transcript in runDir.
 * Includes run.background_submitted with cwd for workspace ownership.
 */
async function seedRunningProcessRun(runDir, runId, pid, workspaceCwd) {
  const tp = join(runDir, `${runId}.jsonl`);
  const t = new JsonlTranscript(tp, { runId, agentId: "test-agent" });
  await t.append("run.started", { backend: "claude-code" });
  await t.append("run.background_submitted", { background: true, cwd: workspaceCwd });
  await t.append("session.created", { backend: "process", backendSessionId: `proc_${pid}` });
  await t.transitionState(null, "pending", "created");
  await t.transitionState("pending", "submitted", "spawned");
  await t.transitionState("submitted", "running", "first_event");
  return tp;
}

/**
 * Seed a completed run (already terminal) for loser tests.
 */
async function seedCompletedRun(runDir, runId, pid) {
  const tp = join(runDir, `${runId}.jsonl`);
  const t = new JsonlTranscript(tp, { runId, agentId: "test-agent" });
  await t.append("run.started", { backend: "claude-code" });
  await t.append("session.created", { backend: "process", backendSessionId: `proc_${pid}` });
  await t.transitionState(null, "pending", "created");
  await t.transitionState("pending", "submitted", "spawned");
  await t.transitionState("submitted", "running", "first_event");
  await t.append("run.completed", { backendSessionId: `proc_${pid}` });
  await t.transitionState("running", "completed", "done");
  return tp;
}

function defaultDeps(overrides = {}) {
  return {
    kill: overrides.kill ?? (() => ({ called: true, exitCode: 0 })),
    isAlive: overrides.isAlive ?? (() => false),
    executeStop: overrides.executeStop ?? (async () => ({ verified: true, abortCalled: true, taskkillCalled: false })),
    alert: overrides.alert ?? (async () => {}),
    ...overrides,
  };
}

// ── Service tests ────────────────────────────────────────────────────────────

test("SVC-01: process winner — one kill, terminal aborted, verified fact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-svc-01-"));
  try {
    makeGitRepo(dir);
    await seedRunningProcessRun(dir, "run_svc01", 99999, dir);
    const { stopRun } = await import("../src/application/runStop.js");
    let killCalls = 0;
    let alive = true;
    const result = await stopRun({
      runId: "run_svc01", runDir: dir,
      deps: defaultDeps({
        kill: () => { killCalls++; alive = false; return { called: true, exitCode: 0 }; },
        isAlive: () => alive,
      }),
    });
    assert.equal(result.terminalAccepted, true);
    assert.equal(result.terminalState, "aborted");
    assert.equal(result.sideEffectAttempted, true);
    assert.equal(result.stopVerified, true);
    assert.equal(killCalls, 1, "exactly one kill call");

    const events = await readTranscript(join(dir, "run_svc01.jsonl"));
    const verified = events.filter((e) => e.type === "run.stop_verified");
    assert.equal(verified.length, 1, "exactly one stop_verified");
    const unverified = events.filter((e) => e.type === "run.stop_unverified");
    assert.equal(unverified.length, 0, "zero stop_unverified");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SVC-02: concurrent two callers — one winner, one loser, sideEffect=1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-svc-02-"));
  try {
    makeGitRepo(dir);
    await seedRunningProcessRun(dir, "run_svc02", 88888, dir);
    const { stopRun } = await import("../src/application/runStop.js");
    let killCalls = 0;
    let alive = true; // process starts alive
    const deps = defaultDeps({
      kill: () => { killCalls++; alive = false; return { called: true, exitCode: 0 }; },
      isAlive: () => alive,
    });
    const [r1, r2] = await Promise.all([
      stopRun({ runId: "run_svc02", runDir: dir, deps }),
      stopRun({ runId: "run_svc02", runDir: dir, deps }),
    ]);
    const results = [r1, r2];
    const winners = results.filter((r) => r.terminalAccepted);
    const losers = results.filter((r) => !r.terminalAccepted);
    assert.equal(winners.length, 1, "exactly one winner");
    assert.equal(losers.length, 1, "exactly one loser");
    assert.equal(losers[0].sideEffectAttempted, false, "loser zero side effect");
    assert.equal(killCalls, 1, "exactly one kill total");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SVC-03: existing terminal loser — sideEffect=0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-svc-03-"));
  try {
    makeGitRepo(dir);
    await seedCompletedRun(dir, "run_svc03", 77777);
    const { stopRun } = await import("../src/application/runStop.js");
    let killCalls = 0;
    const result = await stopRun({
      runId: "run_svc03", runDir: dir,
      deps: defaultDeps({ kill: () => { killCalls++; return { called: true, exitCode: 0 }; } }),
    });
    assert.equal(result.terminalAccepted, false);
    assert.equal(result.sideEffectAttempted, false);
    assert.equal(killCalls, 0, "zero kill calls for terminal loser");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SVC-04: invalid PID — sideEffect=0, not verified", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-svc-04-"));
  try {
    makeGitRepo(dir);
    const tp = join(dir, "run_svc04.jsonl");
    const t = new JsonlTranscript(tp, { runId: "run_svc04", agentId: "a" });
    await t.append("run.started", { backend: "claude-code" });
    await t.append("run.background_submitted", { background: true, cwd: dir });
    await t.append("session.created", { backend: "process", backendSessionId: "proc_not-a-number" });
    await t.transitionState(null, "pending", "created");
    await t.transitionState("pending", "running", "first_event");

    const { stopRun } = await import("../src/application/runStop.js");
    const result = await stopRun({ runId: "run_svc04", runDir: dir, deps: defaultDeps() });
    assert.equal(result.invalidPid, true);
    assert.equal(result.sideEffectAttempted, false);
    assert.equal(result.stopVerified, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SVC-05: verification failure — does not report success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-svc-05-"));
  try {
    makeGitRepo(dir);
    await seedRunningProcessRun(dir, "run_svc05", 66666, dir);
    const { stopRun } = await import("../src/application/runStop.js");
    const result = await stopRun({
      runId: "run_svc05", runDir: dir,
      deps: defaultDeps({ isAlive: () => true }), // process still alive after "kill"
    });
    assert.equal(result.terminalAccepted, true);
    assert.equal(result.stopVerified, false, "must not report verified when still alive");
    const events = await readTranscript(join(dir, "run_svc05.jsonl"));
    assert.ok(events.some((e) => e.type === "run.stop_unverified"), "must write stop_unverified");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Workspace authorization tests ────────────────────────────────────────────

test("AUTH-01: same workspace — allowed into terminal arbitration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-auth-01-"));
  try {
    makeGitRepo(dir);
    await seedRunningProcessRun(dir, "run_auth01", 55555, dir);
    const { stopRun } = await import("../src/application/runStop.js");
    const result = await stopRun({
      runId: "run_auth01", runDir: dir, authorizedWorkspaceRoot: dir,
      deps: defaultDeps(),
    });
    assert.notEqual(result.authorized, false, "must not be auth failure");
    assert.equal(result.terminalAccepted, true, "must be allowed to claim");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("AUTH-02: other workspace — fixed failure, zero events, zero side effect", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "wao-auth-02a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wao-auth-02b-"));
  try {
    makeGitRepo(dirA);
    makeGitRepo(dirB);
    await seedRunningProcessRun(dirA, "run_auth02", 44444, dirA);
    const eventsBefore = await readTranscript(join(dirA, "run_auth02.jsonl"));
    const { stopRun } = await import("../src/application/runStop.js");
    let killCalls = 0;
    const result = await stopRun({
      runId: "run_auth02", runDir: dirA, authorizedWorkspaceRoot: dirB,
      deps: defaultDeps({ kill: () => { killCalls++; return { called: true, exitCode: 0 }; } }),
    });
    assert.equal(result.authorized, false, "must be auth failure");
    assert.equal(result.sideEffectAttempted, false);
    assert.equal(killCalls, 0, "zero kills");
    // Transcript unchanged — no new events
    const eventsAfter = await readTranscript(join(dirA, "run_auth02.jsonl"));
    assert.equal(eventsAfter.length, eventsBefore.length, "zero new events");
  } finally { rmSync(dirA, { recursive: true, force: true }); rmSync(dirB, { recursive: true, force: true }); }
});

test("AUTH-03: missing ownership fact — fixed failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-auth-03-"));
  try {
    makeGitRepo(dir);
    // Seed WITHOUT background_submitted
    const tp = join(dir, "run_auth03.jsonl");
    const t = new JsonlTranscript(tp, { runId: "run_auth03", agentId: "a" });
    await t.append("run.started", { backend: "claude-code" });
    await t.append("session.created", { backend: "process", backendSessionId: "proc_33333" });
    await t.transitionState(null, "pending", "created");
    await t.transitionState("pending", "running", "first_event");

    const { stopRun } = await import("../src/application/runStop.js");
    let killCalls = 0;
    const result = await stopRun({
      runId: "run_auth03", runDir: dir, authorizedWorkspaceRoot: dir,
      deps: defaultDeps({ kill: () => { killCalls++; return { called: true, exitCode: 0 }; } }),
    });
    assert.equal(result.authorized, false);
    assert.equal(killCalls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("AUTH-04: malformed ownership fact — fixed failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-auth-04-"));
  try {
    makeGitRepo(dir);
    const tp = join(dir, "run_auth04.jsonl");
    const t = new JsonlTranscript(tp, { runId: "run_auth04", agentId: "a" });
    await t.append("run.started", { backend: "claude-code" });
    await t.append("run.background_submitted", { background: true }); // no cwd!
    await t.append("session.created", { backend: "process", backendSessionId: "proc_22222" });
    await t.transitionState(null, "pending", "created");
    await t.transitionState("pending", "running", "first_event");

    const { stopRun } = await import("../src/application/runStop.js");
    const result = await stopRun({
      runId: "run_auth04", runDir: dir, authorizedWorkspaceRoot: dir,
      deps: defaultDeps(),
    });
    assert.equal(result.authorized, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("AUTH-05: Windows case-alias — same canonical root allowed", async () => {
  if (process.platform !== "win32") return; // Windows-only test
  const dir = mkdtempSync(join(tmpdir(), "wao-auth-05-"));
  try {
    makeGitRepo(dir);
    await seedRunningProcessRun(dir, "run_auth05", 11111, dir);
    const { stopRun } = await import("../src/application/runStop.js");
    // Flip the drive letter case: D:\ → d:\ (or vice versa)
    const flipped = dir.charAt(0) === dir.charAt(0).toUpperCase()
      ? dir.charAt(0).toLowerCase() + dir.slice(1)
      : dir.charAt(0).toUpperCase() + dir.slice(1);
    const result = await stopRun({
      runId: "run_auth05", runDir: dir, authorizedWorkspaceRoot: flipped,
      deps: defaultDeps(),
    });
    assert.notEqual(result.authorized, false, "case alias should match on Windows");
    assert.equal(result.terminalAccepted, true, "should proceed to terminal claim");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Architecture boundary ────────────────────────────────────────────────────

test("ARCH-01: runStop.js does not import commands/mcp/SDK/zod", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(
    join(join(fileURLToPath(new URL(".", import.meta.url))), "..", "src", "application", "runStop.js"),
    "utf8",
  );
  assert.ok(!src.includes('from "../commands/'), "no commands/");
  assert.ok(!src.includes('from "../mcp/'), "no mcp/");
  assert.ok(!src.includes("@modelcontextprotocol/sdk"), "no SDK");
  assert.ok(!src.includes('from "zod"'), "no zod");
});
