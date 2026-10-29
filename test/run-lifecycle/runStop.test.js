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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { JsonlTranscript, readTranscript, findState } from "../../src/transcript.js";

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
    // pid 身份门注入：假 pid 不触发真实 PowerShell 探测；"same" 保持击杀语义。
    identify: overrides.identify ?? (async () => ({ verdict: "same", basis: "identity_confirmed" })),
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
    const { stopRun } = await import("../../src/application/runStop.js");
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
    const { stopRun } = await import("../../src/application/runStop.js");
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
    const { stopRun } = await import("../../src/application/runStop.js");
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

    const { stopRun } = await import("../../src/application/runStop.js");
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
    const { stopRun } = await import("../../src/application/runStop.js");
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
    const { stopRun } = await import("../../src/application/runStop.js");
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
    const { stopRun } = await import("../../src/application/runStop.js");
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

    const { stopRun } = await import("../../src/application/runStop.js");
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

    const { stopRun } = await import("../../src/application/runStop.js");
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
    const { stopRun } = await import("../../src/application/runStop.js");
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

// ── TD-233: alert logPath stays inside the run's own runDir ──────────────────
// The raiseAlert call sites used to build logPath from deps.config?.runDir ?? "."
// — when deps.config was missing, the alert landed in the PROCESS CWD
// (production evidence: a stray ALERTS.log at the repo root after a manual
// stop). All three call sites now reuse the resolvedRunDir the transcript
// itself lives in. Every test below omits deps.config entirely — the exact
// pre-fix bug trigger — and pins that the alert target is the runDir's
// ALERTS.log, never the bare process cwd.

function alertCapture(captured) {
  return async (level, message, opts) => { captured.push({ level, message, opts }); };
}

function assertAlertInsideRunDir(captured, dir) {
  assert.equal(captured.length, 1, "exactly one alert");
  const resolvedDir = resolve(dir);
  const actual = resolve(captured[0].opts.logPath);
  assert.equal(actual, join(resolvedDir, "ALERTS.log"),
    "alert logPath must resolve to the runDir's ALERTS.log");
  assert.ok(actual.startsWith(resolvedDir + sep),
    "alert target must stay inside the injected tmp runDir");
  assert.notEqual(actual, join(process.cwd(), "ALERTS.log"),
    "alert must never fall back to the process cwd (pre-TD-233 bug shape)");
}

test("TD-233-01: process unverified stop — alert lands in runDir even with deps.config missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td233-01-"));
  try {
    makeGitRepo(dir);
    await seedRunningProcessRun(dir, "run_td23301", 41001, dir);
    const { stopRun } = await import("../../src/application/runStop.js");
    const captured = [];
    const result = await stopRun({
      runId: "run_td23301", runDir: dir,
      deps: {
        kill: () => ({ called: true, exitCode: 0 }),
        isAlive: () => true, // process survives ⇒ unverified path
        alert: alertCapture(captured),
      },
    });
    assert.equal(result.stopVerified, false);
    assertAlertInsideRunDir(captured, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("TD-233-02: invalid PID — alert lands in runDir even with deps.config missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td233-02-"));
  try {
    makeGitRepo(dir);
    const tp = join(dir, "run_td23302.jsonl");
    const t = new JsonlTranscript(tp, { runId: "run_td23302", agentId: "a" });
    await t.append("run.started", { backend: "claude-code" });
    await t.append("run.background_submitted", { background: true, cwd: dir });
    await t.append("session.created", { backend: "process", backendSessionId: "proc_not-a-number" });
    await t.transitionState(null, "pending", "created");
    await t.transitionState("pending", "running", "first_event");

    const { stopRun } = await import("../../src/application/runStop.js");
    const captured = [];
    const result = await stopRun({
      runId: "run_td23302", runDir: dir,
      deps: { alert: alertCapture(captured) },
    });
    assert.equal(result.invalidPid, true);
    assertAlertInsideRunDir(captured, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("TD-233-03: opencode unverified stop — alert lands in runDir even with deps.config missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td233-03-"));
  try {
    makeGitRepo(dir);
    const tp = join(dir, "run_td23303.jsonl");
    const t = new JsonlTranscript(tp, { runId: "run_td23303", agentId: "a" });
    await t.append("run.started", { backend: "opencode" });
    await t.append("run.background_submitted", { background: true, cwd: dir });
    await t.append("session.created", {
      backend: "opencode-serve", backendSessionId: "sess_td23303", serveUrl: "http://127.0.0.1:9",
    });
    await t.transitionState(null, "pending", "created");
    await t.transitionState("pending", "submitted", "spawned");
    await t.transitionState("submitted", "running", "first_event");

    const { stopRun } = await import("../../src/application/runStop.js");
    const captured = [];
    const result = await stopRun({
      runId: "run_td23303", runDir: dir,
      deps: {
        executeStop: async () => ({ verified: false, taskkillCalled: false }),
        alert: alertCapture(captured),
      },
    });
    assert.equal(result.stopVerified, false);
    assertAlertInsideRunDir(captured, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("TD-233-04: runDir omitted — alert follows the cwd-derived default (<cwd>/runs), never bare cwd", async () => {
  // resolveRunDir's no-input default anchors the process cwd's runs/
  // subdirectory — the same directory the transcript is read from. Exercised
  // in a child process whose cwd is the tmp dir so the default cannot touch
  // the repo's real runs/.
  const dir = mkdtempSync(join(tmpdir(), "wao-td233-04-"));
  try {
    mkdirSync(join(dir, "runs"));
    await seedRunningProcessRun(join(dir, "runs"), "run_td23304", 41004, dir);
    const runStopUrl = pathToFileURL(join(
      fileURLToPath(new URL(".", import.meta.url)), "..", "..", "src", "application", "runStop.js",
    ));
    const script = `
import { stopRun } from ${JSON.stringify(runStopUrl.href)};
import { writeFileSync } from "node:fs";
const captured = [];
const result = await stopRun({
  runId: "run_td23304",
  deps: {
    kill: () => ({ called: true, exitCode: 0 }),
    isAlive: () => true,
    alert: async (level, message, opts) => { captured.push(opts.logPath); },
  },
});
writeFileSync(${JSON.stringify(join(dir, "td23304-out.json"))}, JSON.stringify({
  stopVerified: result.stopVerified,
  alertPaths: captured,
}));
`;
    writeFileSync(join(dir, "td23304-child.mjs"), script, "utf8");
    const child = spawnSync(process.execPath, [join(dir, "td23304-child.mjs")], {
      cwd: dir, encoding: "utf8",
    });
    assert.equal(child.status, 0, `child process failed: ${child.stderr}`);
    const out = JSON.parse(readFileSync(join(dir, "td23304-out.json"), "utf8"));
    assert.equal(out.stopVerified, false);
    assert.equal(out.alertPaths.length, 1, "exactly one alert");
    assert.equal(resolve(out.alertPaths[0]), join(resolve(dir), "runs", "ALERTS.log"),
      "alert must follow the cwd-derived <cwd>/runs default (same dir as the transcript)");
    assert.notEqual(resolve(out.alertPaths[0]), join(resolve(dir), "ALERTS.log"),
      "alert must never land at the bare process cwd");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 服务端中止按会话记录的 backend 选实现：kimi-web ─────────────────────────────

const KW_TOKEN_ENV = "WAO_RUNSTOP_KW_TEST_TOKEN";
const KW_TOKEN = "fake-key-runstop-kw-9f8e7d6c5b4a";
const KW_SERVE = "http://127.0.0.1:4310";
const KW_SESSION_URL = `${KW_SERVE}/api/v1/sessions/session_kw`;

async function seedKimiWebRun(runDir, runId, { agentId = "coder_kw", serveUrl = KW_SERVE } = {}) {
  const tp = join(runDir, `${runId}.jsonl`);
  const t = new JsonlTranscript(tp, { runId, agentId });
  await t.append("run.started", { backend: "kimi-web" });
  await t.append("run.background_submitted", { background: true, cwd: runDir });
  await t.append("session.created", { backend: "kimi-web", backendSessionId: "session_kw", serveUrl });
  await t.transitionState(null, "pending", "created");
  await t.transitionState("pending", "submitted", "spawned");
  await t.transitionState("submitted", "running", "first_event");
  return tp;
}

function writeKwRegistry(dir, agents) {
  const path = join(dir, "agents.json");
  writeFileSync(path, JSON.stringify({ agents }), "utf8");
  return path;
}

function kwAgent(dir, overrides = {}) {
  return {
    backend: "kimi-web", cwd: dir, serveUrl: `${KW_SERVE}/`, tokenEnv: KW_TOKEN_ENV,
    model: { id: "kimi-code/k3" }, ...overrides,
  };
}

/** 假 kimi web 服务器：abort 前会话忙；stillBusy=true 时中止后仍报忙。 */
function kwServer({ stillBusy = false } = {}) {
  const calls = [];
  let aborted = false;
  const reply = (data) => ({ ok: true, status: 200, async text() { return JSON.stringify({ code: 0, msg: "", data }); } });
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method ?? "GET", authorization: init.headers?.authorization });
    if (u === `${KW_SESSION_URL}/prompts`) return reply({ active: aborted ? null : { prompt_id: "msg_live" }, queued: [] });
    if (u === `${KW_SESSION_URL}/prompts/msg_live:abort`) { aborted = true; return reply({ aborted: true }); }
    if (u === KW_SESSION_URL) {
      const busy = stillBusy || !aborted;
      return reply({ id: "session_kw", busy, main_turn_active: busy, last_turn_reason: aborted ? "cancelled" : null });
    }
    if (u === `${KW_SESSION_URL}/messages`) return reply({ items: [] });
    throw new Error(`unexpected request ${u}`);
  };
  return { calls, fetchImpl };
}

async function withKwToken(fn) {
  process.env[KW_TOKEN_ENV] = KW_TOKEN;
  try { return await fn(); } finally { delete process.env[KW_TOKEN_ENV]; }
}

test("KW-01: kimi-web 会话的 stop——GET prompts → POST :abort 带 agent 的 Bearer；中止后不忙 → stop_verified{backend:kimi-web}，终态 aborted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-kw-01-"));
  try {
    const tp = await seedKimiWebRun(dir, "run_kw01");
    const registryPath = writeKwRegistry(dir, { coder_kw: kwAgent(dir) });
    const { stopRun } = await import("../../src/application/runStop.js");
    const { calls, fetchImpl } = kwServer();
    const captured = [];
    const result = await withKwToken(() => stopRun({
      runId: "run_kw01", runDir: dir, registryPath,
      justification: { reason: "worker loops on the same edit", observedSeq: 0 },
      deps: { fetchImpl, alert: alertCapture(captured), stopVerify: { rounds: 1, intervalMs: 0 } },
    }));
    assert.equal(result.terminalAccepted, true);
    assert.equal(result.terminalState, "aborted");
    assert.equal(result.sideEffectAttempted, true);
    assert.equal(result.stopVerified, true);
    const promptCalls = calls.filter((c) => c.url.includes("/prompts"));
    assert.deepEqual(promptCalls.map((c) => [c.method, c.url]), [
      ["GET", `${KW_SESSION_URL}/prompts`],
      ["POST", `${KW_SESSION_URL}/prompts/msg_live:abort`],
    ]);
    for (const call of calls) assert.equal(call.authorization, `Bearer ${KW_TOKEN}`);
    assert.equal(captured.length, 0, "已核实停止不告警");

    const events = await readTranscript(tp);
    assert.equal(events.find((e) => e.type === "run.aborted").backend, "kimi-web");
    const verified = events.filter((e) => e.type === "run.stop_verified");
    assert.equal(verified.length, 1);
    assert.equal(verified[0].backend, "kimi-web");
    assert.equal(verified[0].method, "abort+verify");
    assert.equal(events.filter((e) => e.type === "run.stop_unverified").length, 0);
    assert.ok(!readFileSync(tp, "utf8").includes(KW_TOKEN), "token 不进转录");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("KW-02: kimi-web 中止后会话仍忙 → stop_unverified{backend:kimi-web}，终态已认领，告警点名 kimi-web 且不含 token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-kw-02-"));
  try {
    const tp = await seedKimiWebRun(dir, "run_kw02");
    const registryPath = writeKwRegistry(dir, { coder_kw: kwAgent(dir) });
    const { stopRun } = await import("../../src/application/runStop.js");
    const { calls, fetchImpl } = kwServer({ stillBusy: true });
    const captured = [];
    const result = await withKwToken(() => stopRun({
      runId: "run_kw02", runDir: dir, registryPath,
      deps: { fetchImpl, alert: alertCapture(captured), stopVerify: { rounds: 1, intervalMs: 0 } },
    }));
    assert.equal(result.terminalAccepted, true);
    assert.equal(result.terminalState, "aborted");
    assert.equal(result.stopVerified, false);
    assert.ok(calls.some((c) => c.url.endsWith(":abort")), "中止已发出");
    const events = await readTranscript(tp);
    const unverified = events.filter((e) => e.type === "run.stop_unverified");
    assert.equal(unverified.length, 1);
    assert.equal(unverified[0].backend, "kimi-web");
    assert.equal(unverified[0].method, "abort+verify");
    assert.equal(captured.length, 1);
    assert.equal(captured[0].message, "stop run_kw02 not verified: kimi-web session may still be active");
    assert.ok(!readFileSync(tp, "utf8").includes(KW_TOKEN), "token 不进转录");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("KW-03: 停止目标解析失败各腿 → 不认领终态、对服务器零请求、固定文案、outcome stop_route_unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-kw-03-"));
  try {
    const { stopRun } = await import("../../src/application/runStop.js");
    const { SERVER_STOP_ROUTE_TEXT } = await import("../../src/backends/factory.js");
    const legs = [
      { name: "no registry path", registryPath: undefined, text: SERVER_STOP_ROUTE_TEXT.agentUnavailable },
      { name: "registry unreadable", registryPath: join(dir, "missing", "agents.json"), text: SERVER_STOP_ROUTE_TEXT.agentUnavailable },
      { name: "agent not registered", agents: { other_kw: kwAgent(dir) }, text: SERVER_STOP_ROUTE_TEXT.agentUnavailable },
      {
        name: "backend differs",
        agents: { coder_kw: { backend: "opencode-serve", cwd: dir, serveUrl: KW_SERVE, model: { providerID: "p", id: "m" } } },
        text: SERVER_STOP_ROUTE_TEXT.agentMismatch,
      },
      { name: "serveUrl differs", agents: { coder_kw: kwAgent(dir, { serveUrl: "http://127.0.0.1:4999" }) }, text: SERVER_STOP_ROUTE_TEXT.agentMismatch },
    ];
    for (const [index, leg] of legs.entries()) {
      const runId = `run_kw03_${index}`;
      const tp = await seedKimiWebRun(dir, runId);
      const registryPath = leg.agents ? writeKwRegistry(dir, leg.agents) : leg.registryPath;
      const { calls, fetchImpl } = kwServer();
      const captured = [];
      const result = await withKwToken(() => stopRun({
        runId, runDir: dir, registryPath,
        justification: { reason: "worker loops on the same edit", observedSeq: 0 },
        deps: { fetchImpl, alert: alertCapture(captured), stopVerify: { rounds: 1, intervalMs: 0 } },
      }));
      assert.equal(calls.length, 0, `${leg.name}: 对服务器零请求`);
      assert.equal(result.stopRouteUnavailable, true, leg.name);
      assert.equal(result.terminalAccepted, false, leg.name);
      assert.equal(result.terminalState, "running", leg.name);
      assert.equal(result.sideEffectAttempted, false, leg.name);
      assert.equal(result.stopVerified, false, leg.name);
      assert.equal(result.outcome, "stop_route_unavailable", leg.name);
      assert.equal(result.routeError, leg.text, leg.name);

      const events = await readTranscript(tp);
      const stateChanges = events.filter((e) => e.type === "run.state_change");
      assert.equal(stateChanges.at(-1).to, "running", `${leg.name}: 终态未认领（没有新的 state_change）`);
      assert.equal(stateChanges.length, 3, leg.name);
      assert.equal(findState(events), "running", `${leg.name}: 投影仍是原状态（stop_requested 只是意图）`);
      assert.equal(events.filter((e) => e.type === "run.aborted").length, 0, leg.name);
      const requested = events.filter((e) => e.type === "run.stop_requested");
      assert.equal(requested.length, 1, leg.name);
      assert.equal(requested[0].statedReason, "worker loops on the same edit", `${leg.name}: 同一份 stop_requested 载荷`);
      const unverified = events.filter((e) => e.type === "run.stop_unverified");
      assert.equal(unverified.length, 1, leg.name);
      assert.equal(unverified[0].backendSessionId, "session_kw");
      assert.equal(unverified[0].backend, "kimi-web");
      assert.equal(unverified[0].outcome, "stop_route_unavailable");
      assert.equal(unverified[0].taskkillCalled, false);

      assert.equal(captured.length, 1, `${leg.name}: 一次告警`);
      assert.equal(captured[0].level, "stop_unverified");
      assert.equal(captured[0].message, `stop ${runId} not sent, run not marked aborted: ${leg.text}`);
      for (const text of [captured[0].message, result.routeError, readFileSync(tp, "utf8")]) {
        assert.ok(!text.includes(KW_TOKEN), `${leg.name}: 不含 token`);
      }
      for (const text of [captured[0].message, result.routeError]) {
        assert.ok(!text.includes("127.0.0.1") && !text.includes("agents.json"), `${leg.name}: 不回显 URL / registry`);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("KW-04: opencode-serve 路由不读 registry——registry 坏档照样停下，事件与告警文案不变", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-kw-04-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, "{ not json", "utf8");
    const tp = join(dir, "run_kw04.jsonl");
    const t = new JsonlTranscript(tp, { runId: "run_kw04", agentId: "a" });
    await t.append("run.started", { backend: "opencode-serve" });
    await t.append("session.created", { backend: "opencode-serve", backendSessionId: "ses_kw04", serveUrl: "http://127.0.0.1:9" });
    await t.transitionState(null, "pending", "created");
    await t.transitionState("pending", "running", "first_event");
    const { stopRun } = await import("../../src/application/runStop.js");
    const { OpenCodeServeBackend } = await import("../../src/backends/opencodeServe.js");
    const captured = [];
    let target = null;
    const result = await stopRun({
      runId: "run_kw04", runDir: dir, registryPath,
      deps: {
        executeStop: async (b) => { target = b; return { verified: false, taskkillCalled: false }; },
        alert: alertCapture(captured),
      },
    });
    assert.ok(target instanceof OpenCodeServeBackend, "opencode-serve 仍用 OpenCodeServeBackend");
    assert.equal(result.terminalAccepted, true);
    assert.equal(result.stopRouteUnavailable, undefined);
    const events = await readTranscript(tp);
    assert.equal(events.find((e) => e.type === "run.aborted").backend, "opencode-serve");
    const unverified = events.find((e) => e.type === "run.stop_unverified");
    assert.deepEqual(
      { backendSessionId: unverified.backendSessionId, backend: unverified.backend, method: unverified.method, taskkillCalled: unverified.taskkillCalled },
      { backendSessionId: "ses_kw04", backend: "opencode-serve", method: "abort+verify", taskkillCalled: false },
    );
    assert.equal(captured[0].message, "stop run_kw04 not verified: opencode session may still be active");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("KW-05: 已在终态的 kimi-web 运行——不解析停止目标，认领被拒、零副作用（registry 解析不出也不告警）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-kw-05-"));
  try {
    const tp = await seedKimiWebRun(dir, "run_kw05");
    await new JsonlTranscript(tp, { runId: "run_kw05", agentId: "coder_kw" })
      .transitionState("running", "completed", "done");
    const { stopRun } = await import("../../src/application/runStop.js");
    const { calls, fetchImpl } = kwServer();
    const captured = [];
    const result = await withKwToken(() => stopRun({
      runId: "run_kw05", runDir: dir,
      deps: { fetchImpl, alert: alertCapture(captured), stopVerify: { rounds: 1, intervalMs: 0 } },
    }));
    assert.equal(result.rejected, true);
    assert.equal(result.terminalAccepted, false);
    assert.equal(result.terminalState, "completed");
    assert.equal(result.sideEffectAttempted, false);
    assert.equal(result.stopRouteUnavailable, undefined, "终态运行不走解析失败面");
    assert.equal(calls.length, 0, "对服务器零请求");
    assert.equal(captured.length, 0, "不告警");
    const events = await readTranscript(tp);
    assert.equal(events.filter((e) => e.type === "run.stop_unverified").length, 0);
    assert.equal(findState(events), "completed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("KW-07: 终态只来自旧式事实（非终态 state_change 之后的 run.aborted）——认领不被挡，停止目标照常解析：opencode 目标非空；kimi-web 解析不出时不认领", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-kw-07-"));
  try {
    const { stopRun } = await import("../../src/application/runStop.js");
    const { OpenCodeServeBackend } = await import("../../src/backends/opencodeServe.js");
    {
      const tp = join(dir, "run_kw07a.jsonl");
      const t = new JsonlTranscript(tp, { runId: "run_kw07a", agentId: "a" });
      await t.append("run.started", { backend: "opencode-serve" });
      await t.append("session.created", { backend: "opencode-serve", backendSessionId: "ses_kw07", serveUrl: "http://127.0.0.1:9" });
      await t.transitionState(null, "pending", "created");
      await t.transitionState("pending", "running", "first_event");
      await t.append("run.aborted", { backendSessionId: "ses_kw07" });
      assert.equal(findState(await readTranscript(tp)), "aborted", "前提：读侧从旧式事实推断出终态");
      let target = null;
      const result = await stopRun({
        runId: "run_kw07a", runDir: dir,
        deps: { executeStop: async (b) => { target = b; return { verified: true, taskkillCalled: false }; }, alert: async () => {} },
      });
      assert.equal(result.terminalAccepted, true, "仲裁没见到已认领的终态，认领被接受");
      assert.ok(target instanceof OpenCodeServeBackend, "认领之后真的发出中止（目标非空）");
    }
    {
      const tp = join(dir, "run_kw07b.jsonl");
      const t = new JsonlTranscript(tp, { runId: "run_kw07b", agentId: "coder_kw" });
      await t.append("run.started", { backend: "kimi-web" });
      await t.append("session.created", { backend: "kimi-web", backendSessionId: "session_kw", serveUrl: KW_SERVE });
      await t.transitionState(null, "pending", "created");
      await t.transitionState("pending", "running", "first_event");
      await t.append("run.aborted", { backendSessionId: "session_kw" });
      const { calls, fetchImpl } = kwServer();
      let executed = false;
      const result = await withKwToken(() => stopRun({
        runId: "run_kw07b", runDir: dir,
        deps: {
          fetchImpl, alert: async () => {}, stopVerify: { rounds: 1, intervalMs: 0 },
          executeStop: async () => { executed = true; return { verified: true, taskkillCalled: false }; },
        },
      }));
      assert.equal(executed, false, "没有目标就不认领、不执行");
      assert.equal(result.stopRouteUnavailable, true);
      assert.equal(result.terminalAccepted, false);
      assert.equal(calls.length, 0, "对服务器零请求");
      const events = await readTranscript(tp);
      assert.equal(events.filter((e) => e.type === "run.state_change" && e.to === "aborted").length, 0, "没有认领");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("KW-06: token 只在 Windows 用户环境里——停止按派发时的同一条桥解析；哪里都取不到 → 不认领终态、零请求、固定文案", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-kw-06-"));
  delete process.env[KW_TOKEN_ENV];
  try {
    const registryPath = writeKwRegistry(dir, { coder_kw: kwAgent(dir) });
    const { stopRun } = await import("../../src/application/runStop.js");
    const { SERVER_STOP_ROUTE_TEXT } = await import("../../src/backends/factory.js");
    {
      const tp = await seedKimiWebRun(dir, "run_kw06a");
      const { calls, fetchImpl } = kwServer();
      const asked = [];
      const result = await stopRun({
        runId: "run_kw06a", runDir: dir, registryPath,
        deps: {
          fetchImpl, alert: alertCapture([]), stopVerify: { rounds: 1, intervalMs: 0 },
          userEnvReader: async (name) => { asked.push(name); return name === KW_TOKEN_ENV ? KW_TOKEN : undefined; },
        },
      });
      assert.deepEqual(asked, [KW_TOKEN_ENV], "只解析该 agent 声明的凭据名");
      assert.equal(result.terminalAccepted, true);
      assert.equal(result.stopVerified, true);
      assert.ok(calls.some((c) => c.url.endsWith(":abort")), "中止已发出");
      for (const call of calls) assert.equal(call.authorization, `Bearer ${KW_TOKEN}`);
      assert.ok(!readFileSync(tp, "utf8").includes(KW_TOKEN), "token 不进转录");
    }
    {
      const tp = await seedKimiWebRun(dir, "run_kw06b");
      const { calls, fetchImpl } = kwServer();
      const captured = [];
      const result = await stopRun({
        runId: "run_kw06b", runDir: dir, registryPath,
        deps: { fetchImpl, alert: alertCapture(captured), stopVerify: { rounds: 1, intervalMs: 0 }, userEnvReader: async () => undefined },
      });
      assert.equal(calls.length, 0, "对服务器零请求");
      assert.equal(result.stopRouteUnavailable, true);
      assert.equal(result.terminalAccepted, false);
      assert.equal(result.routeError, SERVER_STOP_ROUTE_TEXT.credentialUnavailable);
      assert.equal(captured.length, 1);
      const events = await readTranscript(tp);
      assert.equal(findState(events), "running", "未认领终态");
      assert.equal(events.find((e) => e.type === "run.stop_unverified").outcome, "stop_route_unavailable");
    }
  } finally {
    delete process.env[KW_TOKEN_ENV];
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Architecture boundary ────────────────────────────────────────────────────

test("ARCH-01: runStop.js does not import commands/mcp/SDK/zod", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(
    join(join(fileURLToPath(new URL(".", import.meta.url))), "../..", "src", "application", "runStop.js"),
    "utf8",
  );
  assert.ok(!src.includes('from "../commands/'), "no commands/");
  assert.ok(!src.includes('from "../mcp/'), "no mcp/");
  assert.ok(!src.includes("@modelcontextprotocol/sdk"), "no SDK");
  assert.ok(!src.includes('from "zod"'), "no zod");
});

// ── pid 身份门在 stop 通道上的三个分支（判定表本身由 ownerLivenessIdentity 钉）──

test("SVC-ID-1: 身份判 gone（pid 被复用）→ 不调用 kill、不等待，按 already_exited 记，事实带依据", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-svc-id1-"));
  try {
    makeGitRepo(dir);
    await seedRunningProcessRun(dir, "run_svcid1", 77771, dir);
    const { stopRun } = await import("../../src/application/runStop.js");
    let killCalls = 0;
    const result = await stopRun({
      runId: "run_svcid1", runDir: dir,
      deps: defaultDeps({
        kill: () => { killCalls++; return { called: true, exitCode: 0 }; },
        isAlive: () => true, // 复用者占着这个 pid
        identify: async () => ({ verdict: "gone", basis: "pid_reused" }),
      }),
    });
    assert.equal(killCalls, 0, "复用者不得被杀");
    assert.equal(result.outcome, "already_exited");
    assert.equal(result.stopVerified, true);
    assert.equal(result.sideEffectAttempted, false);
    const events = await readTranscript(join(dir, "run_svcid1.jsonl"));
    const verified = events.filter((e) => e.type === "run.stop_verified");
    assert.equal(verified.length, 1);
    assert.equal(verified[0].pidIdentity, "pid_reused");
    assert.equal(events.filter((e) => e.type === "run.stop_unverified").length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SVC-ID-2: 身份判不出 → 不调用 kill，记未核验并告警说明跳过了击杀", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-svc-id2-"));
  try {
    makeGitRepo(dir);
    await seedRunningProcessRun(dir, "run_svcid2", 77772, dir);
    const { stopRun } = await import("../../src/application/runStop.js");
    let killCalls = 0;
    const alerts = [];
    const result = await stopRun({
      runId: "run_svcid2", runDir: dir,
      deps: defaultDeps({
        kill: () => { killCalls++; return { called: true, exitCode: 0 }; },
        isAlive: () => true,
        identify: async () => ({ verdict: "unknown", basis: "identity_unknown" }),
        alert: async (level, msg) => { alerts.push({ level, msg }); },
      }),
    });
    assert.equal(killCalls, 0, "身份核不了就不强杀");
    assert.equal(result.stopVerified, false, "进程仍活，不得报停止成功");
    assert.equal(result.sideEffectAttempted, false);
    const events = await readTranscript(join(dir, "run_svcid2.jsonl"));
    const unverified = events.filter((e) => e.type === "run.stop_unverified");
    assert.equal(unverified.length, 1);
    assert.equal(unverified[0].pidIdentity, "identity_unknown");
    assert.equal(events.filter((e) => e.type === "run.stop_verified").length, 0);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0].msg, /kill skipped/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SVC-ID-3: 重放过的运行——身份门拿重放记录的 pid 与它自己的时刻锚", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-svc-id3-"));
  try {
    makeGitRepo(dir);
    const tp = await seedRunningProcessRun(dir, "run_svcid3", 77773, dir);
    const t = new JsonlTranscript(tp, { runId: "run_svcid3", agentId: "test-agent" });
    await new Promise((r) => setTimeout(r, 20));
    await t.append("run.rerun", { originalSessionId: "proc_77773", newSessionId: "proc_77774" });
    const events = await readTranscript(tp);
    const created = events.find((e) => e.type === "session.created");
    const rerun = events.find((e) => e.type === "run.rerun");
    assert.ok(Date.parse(rerun.ts) > Date.parse(created.ts), "夹具：重放晚于建会话");
    const { stopRun } = await import("../../src/application/runStop.js");
    const seen = [];
    let alive = true;
    await stopRun({
      runId: "run_svcid3", runDir: dir,
      deps: defaultDeps({
        kill: () => { alive = false; return { called: true, exitCode: 0 }; },
        isAlive: () => alive,
        identify: async (pid, anchorAt) => { seen.push({ pid, anchorAt }); return { verdict: "same", basis: "identity_confirmed" }; },
      }),
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].pid, 77774, "停的是重放出来的新进程");
    assert.equal(seen[0].anchorAt, Date.parse(rerun.ts), "时刻锚取重放那条记录的 ts，不取旧 session.created 的");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
