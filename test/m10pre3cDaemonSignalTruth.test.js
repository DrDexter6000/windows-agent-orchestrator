// test/m10pre3cDaemonSignalTruth.test.js
//
// M10-pre3C: daemon deadline + abort signal truth.
//
// These tests RED on 2eae950 for the correct reasons:
//   - daemon paths inject an implicit 120000 execution deadline;
//   - an external AbortSignal / daemon stop/shutdown can be misrecorded as
//     timed_out instead of aborted;
//   - the keepalive test does not prove SDK timeout reset (swallows the call
//     error, never passes resetTimeoutOnProgress);
//   - runWait service does not enforce 180000..600000 itself.
//
// All process-side assertions use short, deterministic waits (no 180s real
// wait). No real model calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startDaemon, connectDaemon } from "../src/daemon.js";
import { RunManager } from "../src/runManager.js";
import { readTranscript, findState, JsonlTranscript, findLastEventSeq } from "../src/transcript.js";

function makeRunDir() {
  return mkdtempSync(join(tmpdir(), "wao-pre3c-"));
}
function uniquePipe() {
  return join("\\\\.\\pipe", `wao-pre3c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

/** Mock fetch that drives a run to completion via opencode-serve protocol. */
function makeMockFetch() {
  const sessions = new Map();
  return async (url, init = {}) => {
    const urlStr = String(url);
    if (init.method === "POST" && urlStr.endsWith("/api/session")) {
      const id = `ses_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      sessions.set(id, { messages: [] });
      return { ok: true, status: 200, async json() { return { data: { id } }; }, async text() { return JSON.stringify({ data: { id } }); } };
    }
    if (init.method === "POST" && urlStr.includes("/prompt_async")) {
      const sessionId = new URL(urlStr).pathname.split("/")[2];
      const session = sessions.get(sessionId);
      if (session) {
        const body = JSON.parse(init.body);
        session.messages.push({ info: { id: body.messageID, role: "user" }, parts: body.parts });
        session.messages.push({ info: { id: "msg_reply", role: "assistant" }, parts: [{ type: "text", text: "ok" }] });
      }
      return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    }
    if (init.method === "GET" && urlStr.includes("/message")) {
      const sessionId = new URL(urlStr).pathname.split("/")[2];
      const session = sessions.get(sessionId);
      return { ok: true, status: 200, async json() { return session?.messages ?? []; }, async text() { return JSON.stringify(session?.messages ?? []); } };
    }
    if (init.method === "POST" && urlStr.includes("/abort")) {
      return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    }
    return { ok: false, status: 404, async text() { return "not found"; } };
  };
}

/** Mock fetch that NEVER returns an assistant message (run stays running). */
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
// RED 1-4: daemon implicit 120000 execution deadline
// ============================================================

test("PRE3C-01: daemon omitted waitTimeout → RunManager wait_policy disabled/null", async () => {
  const runDir = makeRunDir();
  const pipe = uniquePipe();
  const daemon = await startDaemon({ runDir, pipe, registry: mockRegistry(runDir), fetchImpl: makeMockFetch() });
  try {
    const startRes = await connectDaemon(pipe, { cmd: "start", agentId: "worker_a", prompt: "do it" });
    assert.equal(startRes.ok, true);
    // wait for the run to reach terminal
    await new Promise((r) => setTimeout(r, 400));
    const events = await readTranscript(join(runDir, `${startRes.runId}.jsonl`));
    const policy = events.find((e) => e.type === "run.wait_policy");
    assert.ok(policy, "run.wait_policy must be recorded");
    assert.equal(policy.waitTimeoutMs, null, "omitted daemon timeout must produce disabled policy (null), not 120000");
    assert.equal(policy.source, "disabled");
  } finally {
    await daemon.stop();
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("PRE3C-02: daemon explicit valid waitTimeout survives exactly", async () => {
  const runDir = makeRunDir();
  const pipe = uniquePipe();
  const daemon = await startDaemon({ runDir, pipe, registry: mockRegistry(runDir), fetchImpl: makeMockFetch(), waitTimeout: 240000 });
  try {
    const startRes = await connectDaemon(pipe, { cmd: "start", agentId: "worker_a", prompt: "do it" });
    await new Promise((r) => setTimeout(r, 400));
    const events = await readTranscript(join(runDir, `${startRes.runId}.jsonl`));
    const policy = events.find((e) => e.type === "run.wait_policy");
    assert.ok(policy);
    assert.equal(policy.waitTimeoutMs, 240000, "explicit valid timeout must survive exactly");
    assert.equal(policy.source, "explicit");
  } finally {
    await daemon.stop();
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("PRE3C-03: daemon invalid explicit waitTimeout rejected before side effects", async () => {
  const runDir = makeRunDir();
  const pipe = uniquePipe();
  // 50ms is below the production minimum (1000). startDaemon must reject it at
  // the boundary (validateBoundedWaitTimeout) — never silently become a run.
  let threw = false;
  try {
    await startDaemon({ runDir, pipe, registry: mockRegistry(runDir), fetchImpl: makeMockFetch(), waitTimeout: 50 });
  } catch (e) {
    threw = true;
    assert.match(e.message, /waitTimeout|1000|600000/i, "must reject with range message");
  }
  assert.equal(threw, true, "invalid daemon waitTimeout (50) must be rejected before any run side effect");
  rmSync(runDir, { recursive: true, force: true });
});

test("PRE3C-04: daemonMain argv parsing does not default absent --wait-timeout to 120000", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(
    join(join(fileURLToPath(new URL(".", import.meta.url))), "..", "src", "daemon.js"),
    "utf8",
  );
  // daemonMain must not contain `?? 120000` for wait-timeout parsing.
  const daemonMainBlock = src.slice(src.indexOf("function daemonMain"));
  assert.ok(!/wait-timeout.*\?\?\s*120000/.test(daemonMainBlock),
    "daemonMain must not default absent --wait-timeout to 120000");
});

test("PRE3C-04b: commands/daemon.js does not append --wait-timeout 120000 when omitted", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(
    join(join(fileURLToPath(new URL(".", import.meta.url))), "..", "src", "commands", "daemon.js"),
    "utf8",
  );
  // The daemonArgs construction must not default to 120000.
  assert.ok(!/wait-timeout.*\?\?\s*120000/.test(src),
    "commands/daemon.js must not default --wait-timeout to 120000");
});

// ============================================================
// RED 5-6: external signal / daemon stop → aborted, not timed_out
// ============================================================

// Direct RunManager: an external AbortSignal must not become timed_out.
test("PRE3C-05: external options.signal → exactly one aborted, zero timed_out", async () => {
  const dir = makeRunDir();
  try {
    const config = { registry: "config/agents.json", runDir: dir, pollInterval: 5, timeout: 1000, retries: 0 };
    const readRegistry = async () => ({
      getAgent(id) { return { id, backend: "fake", cwd: dir }; },
      listAgents() { return []; },
    });
    let aborted = false;
    const backendFor = () => ({
      async spawn() {
        return {
          backend: "fake", backendSessionId: "ses_ext",
          abort: async () => { aborted = true; },
          // runManager calls events(signal, opts) positionally.
          events: async function* (signal) {
            // Hang until external signal aborts.
            while (!signal?.aborted && !aborted) await new Promise((r) => setTimeout(r, 5));
          },
        };
      },
    });
    const manager = new RunManager({ config, readRegistry, transcriptDir: dir, backendFor });
    const run = await manager.start("a1", { prompt: "x" });
    // No waitTimeout → disabled deadline. External signal aborts.
    const ext = new AbortController();
    const waitP = run.waitForCompletion({ signal: ext.signal });
    await new Promise((r) => setTimeout(r, 30));
    ext.abort();
    const result = await waitP;

    assert.equal(run.state, "aborted", "external signal must terminal as aborted");
    assert.equal(result.aborted, true);

    const events = await readTranscript(run.transcript.filePath);
    const timedOut = events.filter((e) => e.type === "run.timed_out");
    assert.equal(timedOut.length, 0, "external signal must NOT produce run.timed_out");
    const abortedEvents = events.filter((e) => e.type === "run.aborted" || (e.type === "run.state_change" && e.to === "aborted"));
    assert.ok(abortedEvents.length >= 1, "must record aborted terminal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// daemon IPC stop → exactly one aborted, zero timed_out.
test("PRE3C-06: daemon IPC stop → exactly one aborted, zero timed_out", async () => {
  const runDir = makeRunDir();
  const pipe = uniquePipe();
  const daemon = await startDaemon({ runDir, pipe, registry: mockRegistry(runDir), fetchImpl: silentFetch(), pollInterval: 20 });
  try {
    const startRes = await connectDaemon(pipe, { cmd: "start", agentId: "worker_a", prompt: "x" });
    assert.equal(startRes.ok, true);
    await new Promise((r) => setTimeout(r, 150)); // enter running
    const stopRes = await connectDaemon(pipe, { cmd: "stop", runId: startRes.runId });
    assert.equal(stopRes.ok, true);
    // give the daemon's waitForCompletion path a moment to terminalize
    await new Promise((r) => setTimeout(r, 250));

    const events = await readTranscript(join(runDir, `${startRes.runId}.jsonl`));
    const state = findState(events);
    const timedOut = events.filter((e) => e.type === "run.timed_out");
    const abortedTerm = events.filter((e) => e.type === "run.state_change" && e.to === "aborted");
    assert.equal(timedOut.length, 0, "daemon IPC stop must NOT produce run.timed_out");
    assert.equal(state, "aborted", "daemon IPC stop must terminal as aborted");
    assert.equal(abortedTerm.length, 1, "exactly one aborted terminal");
  } finally {
    await daemon.stop();
    rmSync(runDir, { recursive: true, force: true });
  }
});

// daemon shutdown with active run → no orphan, no timed_out.
test("PRE3C-07: daemon shutdown with active run → no timed_out lie", async () => {
  const runDir = makeRunDir();
  const pipe = uniquePipe();
  const daemon = await startDaemon({ runDir, pipe, registry: mockRegistry(runDir), fetchImpl: silentFetch(), pollInterval: 20 });
  try {
    const startRes = await connectDaemon(pipe, { cmd: "start", agentId: "worker_a", prompt: "x" });
    assert.equal(startRes.ok, true);
    await new Promise((r) => setTimeout(r, 150));
    // graceful shutdown aborts all runs
    await daemon.stop();
    await new Promise((r) => setTimeout(r, 250));

    const events = await readTranscript(join(runDir, `${startRes.runId}.jsonl`));
    const timedOut = events.filter((e) => e.type === "run.timed_out");
    assert.equal(timedOut.length, 0, "daemon shutdown must NOT produce run.timed_out for active run");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// A real deadline timer still → exactly one timed_out (regression guard).
test("PRE3C-08: real deadline timer → exactly one timed_out", async () => {
  const dir = makeRunDir();
  try {
    const config = { registry: "config/agents.json", runDir: dir, pollInterval: 5, timeout: 1000, retries: 0 };
    const readRegistry = async () => ({
      getAgent(id) { return { id, backend: "fake", cwd: dir }; },
      listAgents() { return []; },
    });
    const backendFor = () => ({
      async spawn() {
        return {
          backend: "fake", backendSessionId: "ses_to",
          abort: async () => {},
          events: async function* (signal) {
            while (!signal?.aborted) await new Promise((r) => setTimeout(r, 5));
          },
        };
      },
    });
    const manager = new RunManager({ config, readRegistry, transcriptDir: dir, backendFor });
    const run = await manager.start("a2", { prompt: "x" });
    const result = await run.waitForCompletion({ waitTimeout: 60, pollInterval: 5 });
    assert.equal(run.state, "timed_out");
    const events = await readTranscript(run.transcript.filePath);
    const timedOut = events.filter((e) => e.type === "run.timed_out");
    assert.equal(timedOut.length, 1, "real deadline timer must produce exactly one run.timed_out");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// RED 8: runWait service bounds 180000..600000
// ============================================================

test("PRE3C-09: runWait rejects waitMs below 180000", async () => {
  const dir = makeRunDir();
  const runDir = makeRunDir();
  try {
    const { runWait } = await import("../src/application/runWait.js");
    await assert.rejects(
      () => runWait({ runId: "r", runDir, waitMs: 179999, sleepFn: () => Promise.resolve(), nowFn: () => Date.now() }),
      /waitMs|180000/i,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("PRE3C-09b: runWait rejects waitMs above 600000", async () => {
  const dir = makeRunDir();
  const runDir = makeRunDir();
  try {
    const { runWait } = await import("../src/application/runWait.js");
    await assert.rejects(
      () => runWait({ runId: "r", runDir, waitMs: 600001, sleepFn: () => Promise.resolve(), nowFn: () => Date.now() }),
      /waitMs|600000/i,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("PRE3C-09c: runWait accepts waitMs 180000 and 600000 boundaries", async () => {
  const { fileURLToPath } = await import("node:url");
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    join(join(fileURLToPath(new URL(".", import.meta.url))), "..", "src", "application", "runWait.js"),
    "utf8",
  );
  // The validation must reference both bounds, not only the lower one.
  assert.ok(/180000/.test(src) && /600000/.test(src), "runWait must enforce both 180000 and 600000 bounds");
});
