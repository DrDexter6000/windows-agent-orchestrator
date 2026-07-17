// test/m10pre3FinalGate.test.js
//
// M10-pre3 final publication gate (micro).
//
// These tests RED on 75d486f for literal evidence the prior report overclaimed:
//   F1: daemon CLI `start --wait-timeout 50` spawns the child and prints
//       {started:true} before the invalid timeout is validated in the child.
//   F2: PRE3C-07 shutdown test only asserts zero timed_out; does not prove the
//       terminal is exactly one aborted, controllers cleared, backend dead.
//   F3: PRE3C-09c "accepts boundaries" only greps source; never calls runWait.
//   F4: the file comment above KEEPALIVE-01 overclaims a real-time reset.
//
// No real model calls. No real daemon spawn (the CLI test injects a spawn stub).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { startDaemon, connectDaemon } from "../src/daemon.js";
import { readTranscript, findState, JsonlTranscript } from "../src/transcript.js";

function makeRunDir() {
  return mkdtempSync(join(tmpdir(), "wao-gate-"));
}
function uniquePipe() {
  return join("\\\\.\\pipe", `wao-gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}
function makeGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "R.md"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: dir });
}

// Mock fetch that NEVER returns an assistant message (run stays running).
function silentFetch() {
  return async (url, init = {}) => {
    const urlStr = String(url);
    if (init.method === "POST" && urlStr.endsWith("/api/session")) {
      return { ok: true, status: 200, async json() { return { data: { id: "ses_silent" } }; }, async text() { return "{}"; } };
    }
    if (init.method === "POST" && urlStr.includes("/prompt_async")) {
      return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    }
    if (init.method === "GET" && urlStr.includes("/message")) {
      return { ok: true, status: 200, async json() { return []; }, async text() { return "[]"; } };
    }
    if (init.method === "POST" && urlStr.includes("/abort")) {
      return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    }
    return { ok: false, status: 404, async text() { return "x"; } };
  };
}
function mockRegistry(runDir) {
  return { agents: { worker_a: { backend: "opencode-serve", serveUrl: "http://127.0.0.1:4299", agent: "build", cwd: runDir, model: { providerID: "p", id: "m" }, completionMode: "first-stable" } } };
}

// ============================================================
// F1: daemon CLI preflight — invalid waitTimeout must NOT spawn/report success
// ============================================================

async function runDaemonStartCapture({ args, config, runDir }) {
  // Use the test-injectable spawn hook exported by commands/daemon.js.
  const mod = await import("../src/commands/daemon.js");
  let spawnCount = 0;
  let spawnedArgs = null;
  // Inject a no-op spawn that records the call instead of detaching a real child.
  mod._setSpawnForTest(() => {
    spawnCount++;
    return { unref() {}, on() {}, kill() {}, stdin: { end() {} }, stdout: { on() {} }, stderr: { on() {} }, pid: 99999 };
  });
  let printed = "";
  const origLog = console.log;
  console.log = (...a) => { printed += a.join(" ") + "\n"; };
  let threw = false;
  let errMsg = null;
  try {
    await mod.daemonCommand(["start", "--run-dir", runDir, ...args], config);
  } catch (e) {
    threw = true;
    errMsg = e.message;
  } finally {
    console.log = origLog;
    mod._setSpawnForTest(null);
  }
  return { spawnCount, threw, errMsg, printed };
}

test("GATE-F1-01: daemon start --wait-timeout 50 must NOT spawn or report success", async () => {
  const runDir = makeRunDir();
  try {
    const { spawnCount, threw, printed } = await runDaemonStartCapture({
      args: ["--wait-timeout", "50"],
      config: { runDir, registry: "config/agents.json" },
      runDir,
    });
    assert.equal(spawnCount, 0, "invalid timeout (50) must NOT spawn the child");
    assert.equal(threw, true, "invalid timeout must throw before spawn");
    assert.ok(!printed.includes('"started"'), "must not print success on invalid timeout");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("GATE-F1-02: invalid/empty/whitespace/NaN/fractional/above-max all reject before spawn", async () => {
  const runDir = makeRunDir();
  const cases = [
    ["0", "below min"],
    ["999", "below min"],
    ["", "empty"],
    ["  ", "whitespace"],
    ["abc", "NaN"],
    ["1.5", "fractional"],
    ["600001", "above max"],
    ["-1", "negative"],
  ];
  try {
    for (const [val, label] of cases) {
      const { spawnCount, threw } = await runDaemonStartCapture({
        args: val === "" ? ["--wait-timeout", ""] : ["--wait-timeout", String(val)],
        config: { runDir, registry: "config/agents.json" },
        runDir,
      });
      assert.equal(spawnCount, 0, `[${label}] must not spawn`);
      assert.equal(threw, true, `[${label}] must throw`);
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("GATE-F1-03: valid 1000 and 600000 spawn exactly once and forward byte-exact", async () => {
  const runDir = makeRunDir();
  try {
    for (const val of ["1000", "600000"]) {
      const mod = await import("../src/commands/daemon.js");
      let spawnedArgs = null;
      mod._setSpawnForTest((exe, args) => { spawnedArgs = args; return { unref() {}, on() {}, kill() {}, stdin: { end() {} }, stdout: { on() {} }, stderr: { on() {} }, pid: 1 }; });
      const origLog = console.log;
      let printed = "";
      console.log = (...a) => { printed += a.join(" ") + "\n"; };
      try {
        await mod.daemonCommand(["start", "--run-dir", runDir, "--wait-timeout", val], { runDir, registry: "config/agents.json" });
      } finally {
        console.log = origLog;
        mod._setSpawnForTest(null);
      }
      assert.ok(spawnedArgs && spawnedArgs.includes("--wait-timeout") && spawnedArgs.includes(val),
        `valid ${val} must be forwarded byte-exact`);
      assert.ok(printed.includes('"started"'), `valid ${val} must report success`);
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("GATE-F1-04: omitted waitTimeout spawns but does NOT pass --wait-timeout", async () => {
  const runDir = makeRunDir();
  try {
    const mod = await import("../src/commands/daemon.js");
    let spawnedArgs = null;
    mod._setSpawnForTest((exe, args) => { spawnedArgs = args; return { unref() {}, on() {}, kill() {}, stdin: { end() {} }, stdout: { on() {} }, stderr: { on() {} }, pid: 1 }; });
    const origLog = console.log;
    console.log = () => {};
    try {
      await mod.daemonCommand(["start", "--run-dir", runDir], { runDir, registry: "config/agents.json" });
    } finally {
      console.log = origLog;
      mod._setSpawnForTest(null);
    }
    assert.ok(spawnedArgs, "omitted timeout must still spawn");
    assert.ok(!spawnedArgs.includes("--wait-timeout"), "omitted timeout must NOT pass --wait-timeout");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("GATE-F1-05: invalid config.waitTimeout also rejected before spawn", async () => {
  const runDir = makeRunDir();
  try {
    const { spawnCount, threw } = await runDaemonStartCapture({
      args: [],
      config: { runDir, registry: "config/agents.json", waitTimeout: 50 },
      runDir,
    });
    assert.equal(spawnCount, 0, "invalid config.waitTimeout must NOT spawn");
    assert.equal(threw, true, "invalid config.waitTimeout must throw");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// ============================================================
// F2: shutdown proves terminal/fact/controller/process
// ============================================================

test("GATE-F2-01: daemon shutdown → exactly one aborted terminal, controllers cleared, no timed_out", async () => {
  const runDir = makeRunDir();
  const pipe = uniquePipe();
  const daemon = await startDaemon({ runDir, pipe, registry: mockRegistry(runDir), fetchImpl: silentFetch(), pollInterval: 20 });
  try {
    const startRes = await connectDaemon(pipe, { cmd: "start", agentId: "worker_a", prompt: "x" });
    assert.equal(startRes.ok, true);
    // Barrier: let the run enter running before shutdown.
    await new Promise((r) => setTimeout(r, 150));
    await daemon.stop();
    // Barrier: let the abort path settle (deterministic short wait, not the assertion).
    await new Promise((r) => setTimeout(r, 250));

    const events = await readTranscript(join(runDir, `${startRes.runId}.jsonl`));
    // 1. Final terminal state is aborted.
    assert.equal(findState(events), "aborted", "final state must be aborted");
    // 2. Exactly one aborted terminal state change.
    const abortedChanges = events.filter((e) => e.type === "run.state_change" && e.to === "aborted");
    assert.equal(abortedChanges.length, 1, "exactly one aborted state_change");
    // 3. Exactly one accepted abort fact.
    const abortedFacts = events.filter((e) => e.type === "run.aborted");
    assert.equal(abortedFacts.length, 1, "exactly one run.aborted fact");
    // 4. Zero timed_out.
    const timedOut = events.filter((e) => e.type === "run.timed_out");
    assert.equal(timedOut.length, 0, "zero run.timed_out");
    // 5. Controllers cleared after stop.
    assert.equal(daemon.runControllers.size, 0, "runControllers must be empty after stop");
    // 6. No second terminal (no completed/failed fabricated after aborted).
    const otherTerminals = events.filter((e) => e.type === "run.state_change"
      && ["completed", "failed", "timed_out"].includes(e.to));
    assert.equal(otherTerminals.length, 0, "no fabricated second terminal");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// ============================================================
// F3: real runWait boundary calls at 180000 and 600000
// ============================================================

async function seedRunning(runDir, runId, wsDir) {
  const tp = join(runDir, `${runId}.jsonl`);
  const t = new JsonlTranscript(tp, { runId, agentId: "coder_low" });
  await t.append("run.started", { backend: "claude-code" });
  await t.append("run.background_submitted", { background: true, cwd: wsDir });
  await t.append("session.created", { backend: "process", backendSessionId: "p1" });
  await t.transitionState(null, "pending", "created");
  await t.transitionState("pending", "running", "first_event");
  return tp;
}

test("GATE-F3-01: runWait accepts waitMs=180000 (lower bound) — real call, structured result", async () => {
  const wsDir = makeRunDir();
  const runDir = makeRunDir();
  try {
    makeGitRepo(wsDir);
    await seedRunning(runDir, "run_lb", wsDir);
    const { runWait } = await import("../src/application/runWait.js");
    // Fake clock that immediately exhausts the window so the call returns at
    // the boundary without real waiting. Each now() call advances past waitMs.
    const result = await runWait({
      runId: "run_lb", runDir, waitMs: 180000,
      sleepFn: () => Promise.resolve(),
      nowFn: (() => { let t = 1_000_000; return () => (t += 200_000); })(),
    });
    assert.equal(typeof result.liveness, "string");
    assert.equal(result.terminal, false);
    assert.equal(result.runId, "run_lb");
    assert.ok(["progress", "process_only", "silent"].includes(result.liveness),
      `lower-bound call must return a valid liveness; got ${result.liveness}`);
  } finally {
    rmSync(wsDir, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("GATE-F3-02: runWait accepts waitMs=600000 (upper bound) — real call, structured result", async () => {
  const wsDir = makeRunDir();
  const runDir = makeRunDir();
  try {
    makeGitRepo(wsDir);
    await seedRunning(runDir, "run_ub", wsDir);
    const { runWait } = await import("../src/application/runWait.js");
    const result = await runWait({
      runId: "run_ub", runDir, waitMs: 600000,
      sleepFn: () => Promise.resolve(),
      nowFn: (() => { let t = 1_000_000; return () => (t += 700_000); })(),
    });
    assert.equal(typeof result.liveness, "string");
    assert.equal(result.terminal, false);
    assert.equal(result.runId, "run_ub");
    assert.ok(["progress", "process_only", "silent"].includes(result.liveness),
      `upper-bound call must return a valid liveness; got ${result.liveness}`);
  } finally {
    rmSync(wsDir, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
