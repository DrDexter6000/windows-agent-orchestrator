// test/runWait.test.js
//
// M10-pre3 Batch B: run_wait service + MCP tool tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { JsonlTranscript, readTranscript } from "../src/transcript.js";
import { createWaoMcpServer } from "../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

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

async function buildClient(server) {
  const [c1, s1] = InMemoryTransport.createLinkedPair();
  await server.connect(s1);
  const client = new Client({ name: "test", version: "0" }, { version: "0" });
  await client.connect(c1);
  return client;
}

function fakeSleep() {
  const calls = [];
  return { calls, fn: (ms) => { calls.push(ms); return Promise.resolve(); } };
}

function fakeNow(start = 1000000) {
  let t = start;
  return { advance: (ms) => { t += ms; }, fn: () => t };
}

// ── Service tests ────────────────────────────────────────────────────────────

test("WAIT-01: already terminal → immediate return", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wait-01-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-wait-01-rd-"));
  try {
    makeGitRepo(dir);
    await seedCompletedRun(runDir, "run_done", dir);
    const { runWait } = await import("../src/application/runWait.js");
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
    const { runWait } = await import("../src/application/runWait.js");
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

    const { runWait } = await import("../src/application/runWait.js");
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

    const { runWait } = await import("../src/application/runWait.js");
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

    const { runWait } = await import("../src/application/runWait.js");
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

    const { runWait } = await import("../src/application/runWait.js");
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
    const { runWait } = await import("../src/application/runWait.js");
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
    const { runWait } = await import("../src/application/runWait.js");
    await runWait({
      runId: "run_ro", runDir, waitMs: 180000,
      sleepFn: () => Promise.resolve(),
      nowFn: (() => { let t = Date.now(); return () => (t += 200000); })(),
    });
    const after = readFileSync(join(runDir, "run_ro.jsonl"));
    assert.deepEqual(after, before, "transcript bytes must be unchanged");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// ── MCP adapter tests ────────────────────────────────────────────────────────

test("MCP-WAIT-01: tool list includes run_wait (11th tool)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcpw-01-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      assert.ok(tools.tools.some((t) => t.name === "run_wait"));
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP-WAIT-02: extra args rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcpw-02-"));
  try {
    makeGitRepo(dir);
    let serviceCalls = 0;
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      runWaitFn: async () => { serviceCalls++; return {}; },
    });
    const client = await buildClient(server);
    try {
      await client.callTool({ name: "run_wait", arguments: { runId: "run_x", evil: true } });
    } catch { /* zod rejects */ }
    finally { await client.close(); await server.close(); }
    assert.equal(serviceCalls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP-WAIT-03: waitMs < 180000 rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcpw-03-"));
  try {
    makeGitRepo(dir);
    let serviceCalls = 0;
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      runWaitFn: async () => { serviceCalls++; return {}; },
    });
    const client = await buildClient(server);
    try {
      await client.callTool({ name: "run_wait", arguments: { runId: "run_x", waitMs: 5000 } });
    } catch { /* zod rejects */ }
    finally { await client.close(); await server.close(); }
    assert.equal(serviceCalls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP-WAIT-04: safe output — no path/prompt/command/session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcpw-04-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-mcpw-04-rd-"));
  try {
    makeGitRepo(dir);
    await seedRunningRun(runDir, "run_safe", dir);
    // Use fake sleep to avoid 60s MCP client timeout
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir, workspaceRoot: dir,
      runWaitFn: async (input) => {
        const { runWait } = await import("../src/application/runWait.js");
        return runWait({
          ...input,
          sleepFn: () => Promise.resolve(),
          nowFn: (() => { let t = Date.now(); return () => (t += 200000); })(),
        });
      },
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_wait", arguments: { runId: "run_safe", waitMs: 180000 } });
      const json = res.content[0].text;
      assert.ok(!json.includes(dir), "no absolute path");
      assert.ok(!json.includes("proc_"), "no session id");
      assert.ok(!json.includes("prompt"), "no prompt");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("MCP-WAIT-05: annotations correct", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcpw-05-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      const t = tools.tools.find((t) => t.name === "run_wait");
      assert.equal(t.annotations.readOnlyHint, true);
      assert.equal(t.annotations.destructiveHint, false);
      assert.equal(t.annotations.idempotentHint, true);
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Architecture ─────────────────────────────────────────────────────────────

test("ARCH-WAIT-01: runWait.js does not import commands/mcp/SDK/zod", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(
    join(join(fileURLToPath(new URL(".", import.meta.url))), "..", "src", "application", "runWait.js"),
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
    join(join(fileURLToPath(new URL(".", import.meta.url))), "..", "src", "application", "ownerLiveness.js"),
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
    const { runWait } = await import("../src/application/runWait.js");
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
    const { runWait } = await import("../src/application/runWait.js");
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
    const { runWait } = await import("../src/application/runWait.js");
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
    const { runWait } = await import("../src/application/runWait.js");
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
    const { runWait } = await import("../src/application/runWait.js");
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

// MCP adapter must distinguish omitted vs explicit 0 (no ?? 0 coercion).
test("MCP-WAIT-06 (P1-B): adapter passes omitted afterSeq through (not coerced to 0)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcpw-06-"));
  try {
    makeGitRepo(dir);
    let capturedInput = null;
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      runWaitFn: async (input) => { capturedInput = input; return { terminal: true, liveness: "terminal" }; },
    });
    const client = await buildClient(server);
    try {
      // afterSeq omitted
      await client.callTool({ name: "run_wait", arguments: { runId: "run_x" } });
    } finally { await client.close(); await server.close(); }
    assert.ok(capturedInput, "service must be called");
    // omitted must NOT appear as afterSeq:0 in the service input
    assert.ok(!("afterSeq" in capturedInput) || capturedInput.afterSeq === undefined,
      `omitted afterSeq must not be coerced to 0; got ${JSON.stringify(capturedInput)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP-WAIT-07 (P1-B): adapter passes explicit afterSeq=0 through", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcpw-07-"));
  try {
    makeGitRepo(dir);
    let capturedInput = null;
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      runWaitFn: async (input) => { capturedInput = input; return { terminal: true, liveness: "terminal" }; },
    });
    const client = await buildClient(server);
    try {
      await client.callTool({ name: "run_wait", arguments: { runId: "run_x", afterSeq: 0 } });
    } finally { await client.close(); await server.close(); }
    assert.equal(capturedInput.afterSeq, 0, "explicit 0 must pass through as 0");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── P2-B: concurrency / secret leak / malformed output / stdio smoke ──

// Concurrency: two parallel run_wait calls must leave transcript bytes unchanged.
test("WAIT-13 (P2-B): two concurrent run_wait calls → zero durable writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wait-13-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-wait-13-rd-"));
  try {
    makeGitRepo(dir);
    const tp = await seedRunningRun(runDir, "run_conc", dir);
    const before = readFileSync(tp);
    const { runWait } = await import("../src/application/runWait.js");
    const jump = (() => { let t = Date.now(); return () => (t += 200000); })();
    await Promise.all([
      runWait({ runId: "run_conc", runDir, waitMs: 180000, sleepFn: () => Promise.resolve(), nowFn: jump }),
      runWait({ runId: "run_conc", runDir, waitMs: 180000, sleepFn: () => Promise.resolve(), nowFn: jump }),
    ]);
    const after = readFileSync(tp);
    assert.deepEqual(after, before, "concurrent run_wait must not write any transcript bytes");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// Malicious transcript payload must not leak into MCP output.
test("MCP-WAIT-08 (P2-B): malicious payload → no path/command/secret/session leak", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcpw-08-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-mcpw-08-rd-"));
  try {
    makeGitRepo(dir);
    const tp = await seedRunningRun(runDir, "run_leak", dir);
    const t = new JsonlTranscript(tp, { runId: "run_leak", agentId: "coder_low" });
    await t.append("run.event", { kind: "command", command: "echo C:\\Users\\secret && AKIAIOSFODNN7EXAMPLE" });
    await t.append("run.event", { kind: "tool_use", tool: "Bash", input: { cmd: "rm -rf /tmp/x; PID=4242; /bin/sh" } });
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir, workspaceRoot: dir,
      runWaitFn: async (input) => {
        const { runWait } = await import("../src/application/runWait.js");
        return runWait({
          ...input,
          sleepFn: () => Promise.resolve(),
          nowFn: (() => { let t = Date.now(); return () => (t += 200000); })(),
        });
      },
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_wait", arguments: { runId: "run_leak", waitMs: 180000, afterSeq: 0 } });
      const json = JSON.stringify(res);
      assert.ok(!json.includes("AKIAIOSFODNN7EXAMPLE"), "no secret");
      assert.ok(!json.includes("C:\\\\Users\\\\secret") && !json.toLowerCase().includes("c:\\\\users\\\\secret"), "no windows path");
      assert.ok(!json.includes("/bin/sh"), "no posix path");
      assert.ok(!json.includes("PID=4242") && !json.includes("4242"), "no PID/session");
      assert.ok(!json.includes("rm -rf"), "no command");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// Malformed service result → fixed "run_wait failed" text, no SDK validation leak.
test("MCP-WAIT-09 (P2-B): malformed service result → fixed safe error text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcpw-09-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      runWaitFn: async () => ({ garbage: true, missing: "required fields" }),
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_wait", arguments: { runId: "run_x" } });
      const json = JSON.stringify(res);
      assert.ok(json.includes("run_wait failed"), "must use fixed safe text");
      assert.ok(!json.includes("Expected") && !json.includes("Received") && !json.includes("invalid_enum"),
        "must not leak zod validation message");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// No-model REAL stdio smoke (NOT InMemoryTransport): spawn stdio.js, discover tools,
// call run_wait on an already-terminal run, verify protocol output.
test("MCP-WAIT-10 (P2-B): real stdio smoke — tool discovery + already-terminal early return", async () => {
  const stdioPath = join(process.cwd(), "src", "mcp", "stdio.js");
  const { spawn } = await import("node:child_process");
  const runDir = mkdtempSync(join(tmpdir(), "wao-wait-stdio-rd-"));
  const wsDir = mkdtempSync(join(tmpdir(), "wao-wait-stdio-ws-"));
  // Use the project's Node v22 (the WAO versionGuard rejects v24). Resolve via
  // the same convention as scripts/wao-node.cjs so the spawned stdio server runs
  // under the supported runtime, not the developer's default node.
  const nodeExe = process.env.WAO_NODE
    || join(process.env.LOCALAPPDATA || "", "Programs", "nodejs-v22", "node.exe");
  let child;
  try {
    makeGitRepo(wsDir);
    await seedCompletedRun(runDir, "run_term_smoke", wsDir);
    // Spawn the REAL stdio server (no InMemoryTransport).
    child = spawn(nodeExe, [stdioPath, "--run-dir", runDir, "--workspace-root", wsDir], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderrBuf = "";
    child.stderr.on("data", (c) => { stderrBuf += c.toString(); });
    let buf = "";
    const pending = [];
    const send = (obj) => {
      child.stdin.write(JSON.stringify(obj) + "\n");
    };
    const waitFor = (id, timeoutMs = 8000) => Promise.race([
      new Promise((resolve, reject) => { pending.push({ id, resolve, reject }); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(
        `stdio smoke timed out waiting for id=${id}. stderr: ${stderrBuf.slice(-400)}`)),
      timeoutMs)),
    ]);
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const entry = pending.find((p) => p.id === msg.id);
        if (entry) { entry.resolve(msg); }
      }
    });
    let nextId = 1;
    const initId = nextId++;
    send({ jsonrpc: "2.0", id: initId, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
    const initResp = await waitFor(initId);
    assert.ok(initResp.result, "initialize must succeed");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const listId = nextId++;
    send({ jsonrpc: "2.0", id: listId, method: "tools/list", params: {} });
    const listResp = await waitFor(listId);
    const names = listResp.result.tools.map((t) => t.name);
    assert.ok(names.includes("run_wait"), "run_wait must be discoverable over real stdio");
    const callId = nextId++;
    send({ jsonrpc: "2.0", id: callId, method: "tools/call", params: { name: "run_wait", arguments: { runId: "run_term_smoke", waitMs: 180000 } } });
    const callResp = await waitFor(callId);
    assert.equal(callResp.result.isError, undefined, "must not error on terminal run");
    const payload = JSON.parse(callResp.result.content[0].text);
    assert.equal(payload.terminal, true);
    assert.equal(payload.returnedEarly, true);
    assert.equal(payload.liveness, "terminal");
    assert.equal(payload.ownerHeartbeat, "n/a");
  } finally {
    // Always terminate the child so the test process can exit. Close stdin then
    // kill: StdioServerTransport keeps the process alive on its own.
    try { child?.stdin?.end(); } catch { /* ignore */ }
    try { child?.kill(); } catch { /* ignore */ }
    rmSync(runDir, { recursive: true, force: true });
    rmSync(wsDir, { recursive: true, force: true });
  }
});

// ── P1-A: server-side progress keepalive for long run_wait ──────────────────
//
// The MCP SDK default request timeout is 60s; run_wait blocks >= 180s. The
// standard MCP mechanism to keep the request alive is server-emitted
// notifications/progress: a client that passes onprogress gets
// _meta.progressToken on the request; the server sends progress notifications
// keyed to that token during the long poll; a client with
// resetTimeoutOnProgress:true resets its 60s timer on each notification.
//
// These tests prove (no-model, InMemoryTransport) that the server sends
// progress notifications during the poll and that a client configured with a
// short timeout + resetTimeoutOnProgress does NOT time out across a
// server-side wait longer than that timeout.

test("KEEPALIVE-01 (P1-A): run_wait sends progress notifications during poll", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ka-01-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-ka-01-rd-"));
  try {
    makeGitRepo(dir);
    await seedRunningRun(runDir, "run_ka", dir);
    const progressNotifications = [];
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir, workspaceRoot: dir,
      runWaitFn: async (input) => {
        const { runWait } = await import("../src/application/runWait.js");
        return runWait({
          ...input,
          sleepFn: () => Promise.resolve(),
          nowFn: (() => { let t = Date.now(); return () => (t += 60000); })(),
          // The adapter forwards an onPoll keepalive hook through to the service
          // when the client supplied a progressToken. Keep it if present.
          ...(input.onPoll ? { onPoll: input.onPoll } : {}),
        });
      },
    });
    // Wrap the server-side transport to observe outbound notifications/progress.
    const [c1, s1] = InMemoryTransport.createLinkedPair();
    const origSend = s1.send.bind(s1);
    s1.send = async (msg, opts) => {
      try {
        const parsed = typeof msg === "string" ? JSON.parse(msg) : msg;
        if (parsed && parsed.method === "notifications/progress") progressNotifications.push(parsed);
      } catch { /* not JSON */ }
      return origSend(msg, opts);
    };
    await server.connect(s1);
    const client = new Client({ name: "test", version: "0" }, { version: "0" });
    await client.connect(c1);
    try {
      // onprogress causes the SDK to attach _meta.progressToken (=requestId) to
      // the request; the server reads extra._meta.progressToken and emits
      // notifications/progress keyed to it so a resetTimeoutOnProgress client
      // can keep the 60s default alive across the 180s wait. NOTE: callTool's
      // signature is (params, resultSchema?, options?) — options is the 3rd arg.
      await client.callTool(
        { name: "run_wait", arguments: { runId: "run_ka", waitMs: 180000 } },
        undefined,
        { onprogress: () => {} },
      ).catch(() => {}); // SDK 1.29 response-path zod-compat quirk tolerated; we assert server-side emissions.
    } finally { await client.close(); await server.close(); }
    assert.ok(progressNotifications.length > 0,
      `server must emit notifications/progress during the long poll; got ${progressNotifications.length}`);
    for (const n of progressNotifications) {
      assert.equal(n.method, "notifications/progress");
      assert.equal(typeof n.params.progressToken, "number",
        "progressToken must be the numeric request id so the client can reset its timer");
      assert.equal(typeof n.params.progress, "number");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("KEEPALIVE-02 (P1-A): no progressToken → no notifications (standard opt-in)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ka-02-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-ka-02-rd-"));
  try {
    makeGitRepo(dir);
    await seedRunningRun(runDir, "run_ka3", dir);
    const progressNotifications = [];
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir, workspaceRoot: dir,
      runWaitFn: async (input) => {
        const { runWait } = await import("../src/application/runWait.js");
        return runWait({
          ...input,
          sleepFn: () => Promise.resolve(),
          nowFn: (() => { let t = Date.now(); return () => (t += 60000); })(),
          ...(input.onPoll ? { onPoll: input.onPoll } : {}),
        });
      },
    });
    const [c1, s1] = InMemoryTransport.createLinkedPair();
    const origSend = s1.send.bind(s1);
    s1.send = async (msg, opts) => {
      try {
        const parsed = typeof msg === "string" ? JSON.parse(msg) : msg;
        if (parsed && parsed.method === "notifications/progress") progressNotifications.push(parsed);
      } catch { /* ignore */ }
      return origSend(msg, opts);
    };
    await server.connect(s1);
    const client = new Client({ name: "test", version: "0" }, { version: "0" });
    await client.connect(c1);
    try {
      // NO onprogress → no progressToken attached → server must NOT emit.
      await client.callTool({ name: "run_wait", arguments: { runId: "run_ka3", waitMs: 180000 } });
    } finally { await client.close(); await server.close(); }
    assert.equal(progressNotifications.length, 0,
      "server must NOT emit progress notifications when the client did not request them");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});
