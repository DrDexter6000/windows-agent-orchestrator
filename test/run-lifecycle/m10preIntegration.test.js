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

import { RunManager } from "../../src/runManager.js";
import { readTranscript } from "../../src/transcript.js";

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


// ADR-0030 迁移 helper：观察到期事实 → 行使 Lead 决定（abort）→ 等待同一 promise 收敛。
async function waitDeadlineFactThenAbort(run) {
  const waitP = run.waitForCompletion(run.__wfcOpts);
  const factP = new Promise((resolveFact) => {
    const iv = setInterval(async () => {
      try {
        const evs = await readTranscript(run.transcript.filePath);
        if (evs.some((e) => e.type === "run.observation_deadline_reached")) {
          clearInterval(iv);
          resolveFact();
        }
      } catch { /* transcript 尚未创建 */ }
    }, 5);
  });
  await factP;
  await run.abort();
  return waitP;
}
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
    // ADR-0030 迁移：到期=通知不杀；Lead 决定 abort → aborted 终态。
    run.__wfcOpts = { waitTimeout: 50, pollInterval: 10 };
    const result = await waitDeadlineFactThenAbort(run);

    assert.equal(result.aborted, true, "ADR-0030：到期不再 timed_out，Lead abort → aborted");
    assert.equal(run.state, "aborted");

    const events = await readTranscript(run.transcript.filePath);
    // wait_policy should record the explicit override
    const policy = events.find((e) => e.type === "run.wait_policy");
    assert.ok(policy, "run.wait_policy event must exist");
    assert.equal(policy.source, "explicit");
    assert.equal(policy.waitTimeoutMs, 50);
    // ADR-0030：abort 路径的 _sessionKilled 幂等标记使 cleanup 跳过重复证停
    // （TD-38 语义）——run.stop_verified 不在本路径产生（stop 命令路径另行覆盖，
    // 见 stopSideEffect.test.js）。abortFn 由 _abortInternal 的 handle.abort 恰调一次。
    assert.equal(events.filter((e) => e.type === "run.stop_verified").length, 0,
      "abort 路径不重复证停（幂等跳过）");
    assert.ok(events.some((e) => e.type === "run.observation_deadline_reached"),
      "到期事实在场");
    assert.equal(abortCallCount, 1, "handle.abort called exactly once (by _abortInternal)");
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
    // ADR-0030 迁移：同 INT-c——Lead abort；abort 路径幂等跳过证停（TD-38），
    // isAlive: true 的"进程仍活"面不再经本路径产生 stop_unverified/alert（stop 命令路径覆盖）。
    run.__wfcOpts = { waitTimeout: 50, pollInterval: 10 };
    const result = await waitDeadlineFactThenAbort(run);

    assert.equal(result.aborted, true);

    const events = await readTranscript(run.transcript.filePath);
    assert.equal(events.filter((e) => e.type === "run.stop_unverified").length, 0,
      "abort 路径不重复证停（幂等跳过，TD-38）");
    assert.ok(events.some((e) => e.type === "run.observation_deadline_reached"), "到期事实在场");
    assert.equal(existsSync(join(dir, "ALERTS.log")), false,
      "证停被跳过 → 不写 stop 告警");
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
    // ADR-0030 迁移：同族——Lead abort；isAlive 抛错 → stop_unverified(probe_error)。
    run.__wfcOpts = { waitTimeout: 50, pollInterval: 10 };
    const result = await waitDeadlineFactThenAbort(run);

    assert.equal(result.aborted, true);

    const events = await readTranscript(run.transcript.filePath);
    assert.equal(events.filter((e) => e.type === "run.stop_unverified").length, 0,
      "ADR-0030：abort 路径幂等跳过证停——probe_error 面归 stop 命令路径（stopSideEffect.test.js）");
    assert.ok(events.some((e) => e.type === "run.observation_deadline_reached"), "到期事实在场");
    // 旧断言组（stop_unverified/probe_error/不泄异常/ALERTS）随证停面迁移至
    // stop 命令路径（stopSideEffect.test.js 已覆盖）；本路径如实断言：证停被
    // 幂等跳过 → 无 stop 事实、无告警落盘。
    assert.equal(existsSync(join(dir, "ALERTS.log")), false, "证停跳过 → 不写 stop 告警");
  } finally {
    cleanupDir(dir);
  }
});
