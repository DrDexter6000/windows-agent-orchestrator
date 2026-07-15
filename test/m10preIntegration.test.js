// test/m10preIntegration.test.js
//
// M10-pre closeout: RunManager integration tests for the full timeout precedence,
// wait_policy event, and three stop-verification outcomes.
//
// These tests exercise the REAL waitForCompletion → resolveWaitTimeout → timer →
// abort → _runCleanup → _verifyStopQuietIfCapable → verifyProcessExit chain.
// They do NOT call validateExplicitTimeout (that's the boundary's job, tested in
// timeoutPolicy.test.js). They use small waitTimeout values to test timer mechanics
// fast — resolveWaitTimeout type-checks but does not range-check.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunManager } from "../src/runManager.js";
import { readTranscript } from "../src/transcript.js";

function makeDir() {
  return mkdtempSync(join(tmpdir(), "wao-m10pre-int-"));
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

/**
 * Build a process-backend RunManager with injectable agent + config + handle.
 *
 * The events generator is signal-aware: it hangs until the abort signal fires
 * (simulating a long-running worker), then returns. This mirrors how the real
 * processBackend._streamEvents responds to abort by killing the child and returning.
 */
function makeManager(dir, {
  agentOverrides = {},
  configOverrides = {},
  // If "hang", events waits for abort signal (timeout test).
  // If "done", events yields a done event immediately.
  eventMode = "hang",
  isAlive = false,
  abortFn,
} = {}) {
  const config = {
    registry: "x", runDir: dir, pollInterval: 10,
    waitTimeout: 5000, timeout: 5000, retries: 0, defaultIsolation: "none",
    ...configOverrides,
  };
  const readRegistry = async () => ({
    getAgent(id, overrides = {}) {
      const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
      return { id, backend: "claude-code", cwd: dir, ...agentOverrides, ...defined };
    },
    listAgents() { return []; },
  });

  function makeEvents() {
    if (eventMode === "done") {
      return async function* () {
        yield { kind: "done", reason: "completed" };
      };
    }
    // "hang" mode: wait for signal abort, then return (no events yielded).
    return async function* (signal) {
      await new Promise((resolve) => {
        if (signal?.aborted) { resolve(); return; }
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    };
  }

  const mockBackend = {
    async spawn() {
      return {
        backend: "process",
        backendSessionId: "proc_test",
        events: makeEvents(),
        abort: abortFn ?? (async () => {}),
        isAlive: () => isAlive,
      };
    },
  };
  return new RunManager({ config, readRegistry, backendFor: () => mockBackend });
}

// -----------------------------------------------------------------------
// Test (a): no explicit + agent.waitTimeout=600000 → source=agent
// -----------------------------------------------------------------------

test("M10pre-INT-a: no explicit + agent.waitTimeout → run.wait_policy source=agent", async () => {
  const dir = makeDir();
  try {
    // Agent has waitTimeout, config also has one — agent must win.
    const manager = makeManager(dir, {
      agentOverrides: { waitTimeout: 600000 },
      configOverrides: { waitTimeout: 300000 },
      eventMode: "done",
      isAlive: false,
    });
    const run = await manager.start("test", { prompt: "x" });
    await run.waitForCompletion({});

    const events = await readTranscript(run.transcript.filePath);
    const policy = events.find((e) => e.type === "run.wait_policy");
    assert.ok(policy, "run.wait_policy event must exist");
    assert.equal(policy.source, "agent");
    assert.equal(policy.waitTimeoutMs, 600000);
  } finally {
    cleanupDir(dir);
  }
});

// -----------------------------------------------------------------------
// Test (b): agent missing + global has value → source=global
// -----------------------------------------------------------------------

test("M10pre-INT-b: no agent.waitTimeout + global config → source=global", async () => {
  const dir = makeDir();
  try {
    // No agent.waitTimeout — config.waitTimeout (global) must be used.
    const manager = makeManager(dir, {
      agentOverrides: {}, // no waitTimeout on agent
      configOverrides: { waitTimeout: 300000 },
      eventMode: "done",
      isAlive: false,
    });
    const run = await manager.start("test", { prompt: "x" });
    await run.waitForCompletion({});

    const events = await readTranscript(run.transcript.filePath);
    const policy = events.find((e) => e.type === "run.wait_policy");
    assert.ok(policy, "run.wait_policy event must exist");
    assert.equal(policy.source, "global");
    assert.equal(policy.waitTimeoutMs, 300000);
  } finally {
    cleanupDir(dir);
  }
});

// -----------------------------------------------------------------------
// Test (c): timeout → terminal timed_out + abort called + stop_verified
// -----------------------------------------------------------------------

test("M10pre-INT-c: timeout → timed_out + abort once + stop_verified", async () => {
  const dir = makeDir();
  try {
    let abortCallCount = 0;
    const manager = makeManager(dir, {
      agentOverrides: {},
      configOverrides: { waitTimeout: 5000 },
      eventMode: "hang", // forces timeout
      abortFn: async () => { abortCallCount++; },
      // Process is dead after abort → stop_verified
      isAlive: false,
    });
    const run = await manager.start("test", { prompt: "x" });
    // Small timeout to trigger quickly
    const result = await run.waitForCompletion({ waitTimeout: 50, pollInterval: 10 });

    assert.equal(result.timedOut, true, "must be timed out");
    assert.equal(run.state, "timed_out");

    const events = await readTranscript(run.transcript.filePath);
    // wait_policy should record the explicit override
    const policy = events.find((e) => e.type === "run.wait_policy");
    assert.ok(policy, "run.wait_policy event must exist");
    assert.equal(policy.source, "explicit");
    assert.equal(policy.waitTimeoutMs, 50);
    // stop_verified must be present (process died → quiet)
    const verified = events.find((e) => e.type === "run.stop_verified");
    assert.ok(verified, "run.stop_verified must exist");
    // abort called exactly once (by _runCleanup)
    assert.equal(abortCallCount, 1, "abort called exactly once");
  } finally {
    cleanupDir(dir);
  }
});

// -----------------------------------------------------------------------
// Test (d): process still alive after timeout → stop_unverified + alert
// -----------------------------------------------------------------------

test("M10pre-INT-d: process still alive → stop_unverified + alert written", async () => {
  const dir = makeDir();
  try {
    const manager = makeManager(dir, {
      agentOverrides: {},
      configOverrides: { waitTimeout: 5000 },
      eventMode: "hang",
      abortFn: async () => {},
      // Process NEVER dies → rounds exhausted → unverified
      isAlive: true,
    });
    const run = await manager.start("test", { prompt: "x" });
    const result = await run.waitForCompletion({ waitTimeout: 50, pollInterval: 10 });

    assert.equal(result.timedOut, true);

    const events = await readTranscript(run.transcript.filePath);
    const unverified = events.find((e) => e.type === "run.stop_unverified");
    assert.ok(unverified, "run.stop_unverified must exist");
    // raiseAlert is fire-and-forget async; wait briefly for it to flush to disk.
    // The alert message is visible in stderr even if the file write is pending.
    const alertsPath = join(dir, "ALERTS.log");
    let alertWritten = false;
    for (let i = 0; i < 20; i++) {
      if (existsSync(alertsPath)) { alertWritten = true; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(alertWritten, "ALERTS.log must exist after unverified stop");
  } finally {
    cleanupDir(dir);
  }
});

// -----------------------------------------------------------------------
// Test (e): probe (isAlive) throws → stop_unverified with probe_error + alert
// -----------------------------------------------------------------------

test("M10pre-INT-e: isAlive throws → stop_unverified outcome=probe_error + alert", async () => {
  const dir = makeDir();
  try {
    // handle.isAlive throws — simulate a broken process probe
    const config = {
      registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 5000,
      timeout: 5000, retries: 0, defaultIsolation: "none",
    };
    const readRegistry = async () => ({
      getAgent(id, overrides = {}) {
        const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
        return { id, backend: "claude-code", cwd: dir, ...defined };
      },
      listAgents() { return []; },
    });
    const mockBackend = {
      async spawn() {
        return {
          backend: "process",
          backendSessionId: "proc_probe_err",
          events: async function* (signal) {
            await new Promise((resolve) => {
              if (signal?.aborted) { resolve(); return; }
              signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          },
          abort: async () => {},
          // isAlive THROWS — simulates a broken probe (e.g. EPERM, EINVAL)
          isAlive: () => { throw new Error("probe exploded"); },
        };
      },
    };
    const manager = new RunManager({ config, readRegistry, backendFor: () => mockBackend });
    const run = await manager.start("test", { prompt: "x" });
    const result = await run.waitForCompletion({ waitTimeout: 50, pollInterval: 10 });

    assert.equal(result.timedOut, true);

    const events = await readTranscript(run.transcript.filePath);
    const unverified = events.find((e) => e.type === "run.stop_unverified");
    assert.ok(unverified, "run.stop_unverified must exist even when probe throws");
    assert.equal(unverified.outcome, "probe_error");
    // Must NOT contain the exception message — fail-closed, no leak
    const dumped = JSON.stringify(unverified);
    assert.ok(!dumped.includes("probe exploded"), "must not leak exception message");
    assert.ok(!dumped.includes("Error"), "must not leak exception type");
    // ALERTS.log should exist — raiseAlert is fire-and-forget async; wait briefly.
    const alertsPath = join(dir, "ALERTS.log");
    let alertWritten = false;
    for (let i = 0; i < 20; i++) {
      if (existsSync(alertsPath)) { alertWritten = true; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(alertWritten, "ALERTS.log must exist after probe error");
  } finally {
    cleanupDir(dir);
  }
});
