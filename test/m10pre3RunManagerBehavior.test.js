// test/m10pre3RunManagerBehavior.test.js
//
// M10-pre3 closeout (P1-D): REAL RunManager behavior tests.
//
// The earlier m10pre3Deadline.test.js only tested the resolver/config/static
// source strings — it never drove a real Run through waitForCompletion. These
// tests use the REAL RunManager + a fake backend with deferred events so the
// disabled-deadline contract is exercised end-to-end:
//
//   1. deadline disabled → no timer → run does NOT produce run.timed_out even
//      after wall-clock time that would have exceeded the old 300000ms default.
//   2. explicit deadline → deterministically produces timed_out + exactly one
//      run.timed_out event.
//   3. deadline disabled → token budget still converts to failed.
//   4. deadline disabled → run.abort()/external stop still stops the run;
//      terminal is NOT misreported as timed_out.
//   5. run.wait_policy durable payload (disabled vs explicit).
//   6. event stream ends with NO done, NO deadline timer, NO external abort →
//      must NOT fabricate run.timed_out; honest failed/backend-stream-ended.
//
// No real 10-minute wait. No relaxation of production input boundaries.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunManager } from "../src/runManager.js";
import { readTranscript, findState } from "../src/transcript.js";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "wao-rmb-"));
}

/**
 * Build a RunManager whose registry/backend are fake and fully controllable.
 * backendFor(agent) returns an object whose spawn() resolves to a handle with
 * an abort() and an events() async generator. The events generator is given
 * by the test, so the test controls exactly what the backend yields and when.
 */
function makeManager(dir, { eventsGenerator, agentOverrides = {}, configOverrides = {} } = {}) {
  const config = {
    registry: "config/agents.json",
    runDir: dir,
    pollInterval: 5,
    timeout: 1000,
    retries: 0,
    // NOTE: waitTimeout intentionally NOT set here → resolveWaitTimeout returns
    // { enabled:false } unless the caller passes options.waitTimeout.
    ...configOverrides,
  };
  const readRegistry = async () => ({
    getAgent(id, overrides = {}) {
      return {
        id,
        backend: "fake",
        cwd: dir,
        ...agentOverrides,
        ...overrides,
      };
    },
    listAgents() { return []; },
  });
  let aborted = false;
  const backendFor = () => ({
    async spawn() {
      return {
        backend: "fake",
        backendSessionId: "ses_fake",
        abort: async () => { aborted = true; },
        events: async function* (_signal, _opts) {
          // Delegate to the test-supplied generator. Pass the signal so the
          // test can observe abort if it wants.
          if (eventsGenerator) {
            yield* eventsGenerator({ signal: _signal, isAborted: () => aborted });
          }
          // If no generator, the stream ends immediately (no done event).
        },
      };
    },
  });
  const manager = new RunManager({ config, readRegistry, transcriptDir: dir, backendFor });
  return { manager, isAborted: () => aborted };
}

// ── 1. Disabled deadline does not kill the run ───────────────────────────────

test("BEHAVIOR-1: deadline disabled → no run.timed_out; later completed wins", async () => {
  const dir = makeTempDir();
  try {
    // Backend yields one message then a done after a short real delay.
    // The run has NO waitTimeout → disabled. Even after real wall-clock time
    // passes, no timed_out event must appear.
    const { manager } = makeManager(dir, {
      eventsGenerator: async function* () {
        await new Promise((r) => setTimeout(r, 20));
        yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "hi" }] };
        await new Promise((r) => setTimeout(r, 20));
        yield { kind: "done", reason: "completed" };
      },
    });
    const run = await manager.start("a1", { prompt: "x" });
    const result = await run.waitForCompletion({});

    assert.equal(result.completed, true);
    assert.equal(run.state, "completed");

    const events = await readTranscript(run.transcript.filePath);
    const timedOut = events.filter((e) => e.type === "run.timed_out");
    assert.equal(timedOut.length, 0, "disabled deadline must NEVER write run.timed_out");

    // Sanity: the wait_policy durable fact records the disabled policy.
    const policy = events.find((e) => e.type === "run.wait_policy");
    assert.ok(policy, "run.wait_policy must be recorded");
    assert.equal(policy.waitTimeoutMs, null, "disabled policy must be waitTimeoutMs:null");
    assert.equal(policy.source, "disabled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2. Explicit deadline still produces timed_out deterministically ──────────

test("BEHAVIOR-2: explicit deadline → exactly one run.timed_out + state timed_out", async () => {
  const dir = makeTempDir();
  try {
    // Backend never yields done — hangs. The explicit short deadline must fire.
    const { manager } = makeManager(dir, {
      eventsGenerator: async function* ({ signal, isAborted }) {
        // Block until the deadline timer aborts the controller, OR the backend
        // is externally aborted. Either path unblocks the generator so the test
        // terminates deterministically.
        while (!signal.aborted && !isAborted()) {
          await new Promise((r) => setTimeout(r, 5));
        }
        // generator returns without yielding done → doneReason stays null,
        // but waitTimerExpired is true → timed_out path.
      },
    });
    const run = await manager.start("a2", { prompt: "x" });
    const result = await run.waitForCompletion({ waitTimeout: 60, pollInterval: 5 });

    assert.equal(result.completed, false);
    assert.equal(run.state, "timed_out");

    const events = await readTranscript(run.transcript.filePath);
    const timedOutEvents = events.filter((e) => e.type === "run.timed_out");
    assert.equal(timedOutEvents.length, 1, "must produce EXACTLY one run.timed_out");

    const policy = events.find((e) => e.type === "run.wait_policy");
    assert.equal(policy.waitTimeoutMs, 60);
    assert.equal(policy.source, "explicit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 3. Disabled deadline → token budget still fails ──────────────────────────

test("BEHAVIOR-3: deadline disabled + token budget exceeded → failed (not timed_out)", async () => {
  const dir = makeTempDir();
  try {
    const { manager } = makeManager(dir, {
      agentOverrides: { tokenBudget: 100, tokenBudgetMultiplier: 1 },
      eventsGenerator: async function* () {
        await new Promise((r) => setTimeout(r, 10));
        // effective = (50+40+0)*1 = 90 < 100 ok
        yield { kind: "metrics", tokens: { input: 50, output: 40 } };
        await new Promise((r) => setTimeout(r, 10));
        // effective = (500+400+0)*1 = 900 > 100 → budget exceeded
        yield { kind: "metrics", tokens: { input: 500, output: 400 } };
      },
    });
    const run = await manager.start("a3", { prompt: "x" });
    const result = await run.waitForCompletion({}); // no waitTimeout → disabled

    assert.equal(result.failed, true, "must fail on budget even with disabled deadline");
    assert.equal(run.state, "failed");

    const events = await readTranscript(run.transcript.filePath);
    const timedOut = events.filter((e) => e.type === "run.timed_out");
    assert.equal(timedOut.length, 0, "budget failure must NOT produce timed_out");
    const budget = events.find((e) => e.type === "run.budget_exceeded");
    assert.ok(budget, "must record run.budget_exceeded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 4. Disabled deadline → external abort still stops; not timed_out ─────────

test("BEHAVIOR-4: deadline disabled + run.abort() → aborted, not timed_out", async () => {
  const dir = makeTempDir();
  try {
    const { manager } = makeManager(dir, {
      eventsGenerator: async function* ({ signal, isAborted }) {
        // Hang until aborted (external abort or signal).
        while (!signal.aborted && !isAborted()) {
          await new Promise((r) => setTimeout(r, 5));
        }
      },
    });
    const run = await manager.start("a4", { prompt: "x" });
    const waitPromise = run.waitForCompletion({}); // disabled deadline
    await new Promise((r) => setTimeout(r, 15));
    await run.abort("user");
    const result = await waitPromise;

    assert.equal(result.aborted, true);
    assert.equal(run.state, "aborted");

    const events = await readTranscript(run.transcript.filePath);
    const timedOut = events.filter((e) => e.type === "run.timed_out");
    assert.equal(timedOut.length, 0, "abort must NOT produce timed_out");
    const abortedEvent = events.find((e) => e.type === "run.aborted");
    assert.ok(abortedEvent, "must record run.aborted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 5. wait_policy durable payload (disabled vs explicit) ────────────────────

test("BEHAVIOR-5: wait_policy durable shape — disabled vs explicit", async () => {
  // Disabled
  const dir1 = makeTempDir();
  try {
    const { manager: m1 } = makeManager(dir1, {
      eventsGenerator: async function* () { yield { kind: "done", reason: "completed" }; },
    });
    const r1 = await m1.start("a5a", { prompt: "x" });
    await r1.waitForCompletion({});
    const ev1 = await readTranscript(r1.transcript.filePath);
    const p1 = ev1.find((e) => e.type === "run.wait_policy");
    assert.deepEqual({ waitTimeoutMs: p1.waitTimeoutMs, source: p1.source },
      { waitTimeoutMs: null, source: "disabled" });
  } finally { rmSync(dir1, { recursive: true, force: true }); }

  // Explicit
  const dir2 = makeTempDir();
  try {
    const { manager: m2 } = makeManager(dir2, {
      eventsGenerator: async function* ({ signal, isAborted }) {
        while (!signal.aborted && !isAborted()) await new Promise((r) => setTimeout(r, 5));
      },
    });
    const r2 = await m2.start("a5b", { prompt: "x" });
    await r2.waitForCompletion({ waitTimeout: 55, pollInterval: 5 });
    const ev2 = await readTranscript(r2.transcript.filePath);
    const p2 = ev2.find((e) => e.type === "run.wait_policy");
    assert.deepEqual({ waitTimeoutMs: p2.waitTimeoutMs, source: p2.source },
      { waitTimeoutMs: 55, source: "explicit" });
  } finally { rmSync(dir2, { recursive: true, force: true }); }
});

// ── 6. Stream ends with no done, no timer, no abort → honest, not timed_out ──

test("BEHAVIOR-6: stream ends without done/timer/abort → NOT fabricated timed_out", async () => {
  const dir = makeTempDir();
  try {
    // Backend yields a message then the generator simply RETURNS (no done event).
    // No waitTimeout (disabled), no abort. The honest outcome is a backend-stream
    // ended condition — it must NOT be misreported as run.timed_out.
    const { manager } = makeManager(dir, {
      eventsGenerator: async function* () {
        yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "hi" }] };
        // generator returns here — stream ended, no done.
      },
    });
    const run = await manager.start("a6", { prompt: "x" });
    // The honest outcome is a failed/stream-ended condition: waitForCompletion
    // rejects (matching the existing backend-error behavior), and the terminal
    // state is failed — NOT timed_out.
    await assert.rejects(
      () => run.waitForCompletion({}),
      /backend stream ended without done/,
    );

    const events = await readTranscript(run.transcript.filePath);
    const timedOutEvents = events.filter((e) => e.type === "run.timed_out");

    // The contract: a run with no deadline timer, no abort, and a stream that
    // ended without a done event must NOT fabricate run.timed_out. timedOut
    // is only true when waitTimerExpired || (doneReason===null && signal.aborted).
    // Here neither holds → no timed_out event is honest.
    assert.equal(timedOutEvents.length, 0,
      "stream-ended without timer/abort must NOT fabricate run.timed_out " +
      `(state=${run.state})`);
    // Terminal must be failed (honest), reusing existing terminal arbitration.
    assert.equal(findState(events), "failed",
      "stream-ended must terminal as failed, not timed_out");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
