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
