// test/runStopCloseout.test.js
//
// M10 P0-2 CTO closeout tests: runId escape, subdirectory rejection,
// sideEffectAttempted honesty, MCP concurrency, delivery ownership.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

async function buildClient(server) {
  const [c1, s1] = InMemoryTransport.createLinkedPair();
  await server.connect(s1);
  const client = new Client({ name: "test", version: "0" }, { version: "0" });
  await client.connect(c1);
  return client;
}

async function seedRun(runDir, runId, workspaceCwd, pid = 99999) {
  const tp = join(runDir, `${runId}.jsonl`);
  const t = new JsonlTranscript(tp, { runId, agentId: "a" });
  await t.append("run.started", { backend: "claude-code" });
  await t.append("run.background_submitted", { background: true, cwd: workspaceCwd });
  await t.append("session.created", { backend: "process", backendSessionId: `proc_${pid}` });
  await t.transitionState(null, "pending", "created");
  await t.transitionState("pending", "submitted", "spawned");
  await t.transitionState("submitted", "running", "first_event");
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

// ── FIX-A: runId path escape ─────────────────────────────────────────────────

test("RUNID-01: path traversal runId rejected — zero file read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-runid-01-"));
  try {
    makeGitRepo(dir);
    const { stopRun } = await import("../src/application/runStop.js");
    await assert.rejects(
      () => stopRun({ runId: "../victim", runDir: dir, deps: defaultDeps() }),
      (err) => err.message.includes("invalid runId"),
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("RUNID-02: backslash path escape rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-runid-02-"));
  try {
    makeGitRepo(dir);
    const { stopRun } = await import("../src/application/runStop.js");
    await assert.rejects(
      () => stopRun({ runId: "..\\victim", runDir: dir, deps: defaultDeps() }),
      (err) => err.message.includes("invalid runId"),
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("RUNID-03: absolute path runId rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-runid-03-"));
  try {
    makeGitRepo(dir);
    const { stopRun } = await import("../src/application/runStop.js");
    await assert.rejects(
      () => stopRun({ runId: "C:/evil/path", runDir: dir, deps: defaultDeps() }),
      (err) => err.message.includes("invalid runId"),
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("RUNID-04: shell chars in runId rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-runid-04-"));
  try {
    makeGitRepo(dir);
    const { stopRun } = await import("../src/application/runStop.js");
    await assert.rejects(
      () => stopRun({ runId: "run&evil", runDir: dir, deps: defaultDeps() }),
      (err) => err.message.includes("invalid runId"),
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("RUNID-05: MCP run_stop rejects malicious runId — service count=0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-runid-05-"));
  try {
    makeGitRepo(dir);
    let serviceCalls = 0;
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      stopRunFn: async () => { serviceCalls++; throw new Error("should not be called"); },
    });
    const client = await buildClient(server);
    try {
      // The zod schema z.string().min(1) accepts "../victim", but the service
      // validates isValidRunId and throws → catch → "run_stop failed"
      const res = await client.callTool({ name: "run_stop", arguments: { runId: "../victim" } });
      assert.ok(res.isError, "must be error");
      assert.equal(res.content[0].text, "run_stop failed");
      assert.equal(serviceCalls, 0, "service must not be called for invalid runId");
    } finally {
      await client.close();
      await server.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── FIX-B: workspace subdirectory rejection ──────────────────────────────────

test("SUBDIR-01: ownership cwd is subdirectory → rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-subdir-01-"));
  try {
    makeGitRepo(dir);
    const subdir = join(dir, "nested");
    mkdirSync(subdir);
    await seedRun(dir, "run_sub01", subdir); // ownership cwd = subdirectory!
    const { stopRun } = await import("../src/application/runStop.js");
    const result = await stopRun({
      runId: "run_sub01", runDir: dir, authorizedWorkspaceRoot: dir, deps: defaultDeps(),
    });
    assert.equal(result.authorized, false, "subdirectory must be rejected");
    assert.equal(result.sideEffectAttempted, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SUBDIR-02: authorized root is subdirectory → rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-subdir-02-"));
  try {
    makeGitRepo(dir);
    const subdir = join(dir, "nested");
    mkdirSync(subdir);
    await seedRun(dir, "run_sub02", dir);
    const { stopRun } = await import("../src/application/runStop.js");
    const result = await stopRun({
      runId: "run_sub02", runDir: dir, authorizedWorkspaceRoot: subdir, deps: defaultDeps(),
    });
    assert.equal(result.authorized, false, "subdirectory authorized root must be rejected");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("DUP-01: duplicate ownership fact → fail-closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dup-01-"));
  try {
    makeGitRepo(dir);
    const tp = join(dir, "run_dup01.jsonl");
    const t = new JsonlTranscript(tp, { runId: "run_dup01", agentId: "a" });
    await t.append("run.started", { backend: "claude-code" });
    await t.append("run.background_submitted", { background: true, cwd: dir });
    await t.append("run.background_submitted", { background: true, cwd: dir }); // DUPLICATE!
    await t.append("session.created", { backend: "process", backendSessionId: "proc_33333" });
    await t.transitionState(null, "pending", "created");
    await t.transitionState("pending", "running", "first_event");

    const { stopRun } = await import("../src/application/runStop.js");
    const result = await stopRun({
      runId: "run_dup01", runDir: dir, authorizedWorkspaceRoot: dir, deps: defaultDeps(),
    });
    assert.equal(result.authorized, false, "duplicate ownership must fail-closed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── FIX-C: sideEffectAttempted honesty ───────────────────────────────────────

test("HONEST-01: process already exited → sideEffectAttempted=false, stopVerified=true", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-honest-01-"));
  try {
    makeGitRepo(dir);
    await seedRun(dir, "run_honest01", dir);
    const { stopRun } = await import("../src/application/runStop.js");
    let killCalls = 0;
    const result = await stopRun({
      runId: "run_honest01", runDir: dir, authorizedWorkspaceRoot: dir,
      deps: defaultDeps({
        kill: () => { killCalls++; return { called: true, exitCode: 0 }; },
        isAlive: () => false, // already dead before kill
      }),
    });
    assert.equal(killCalls, 0, "no kill when already dead");
    assert.equal(result.sideEffectAttempted, false, "must report false when no kill attempted");
    assert.equal(result.terminalAccepted, true, "terminal still accepted");
    assert.equal(result.stopVerified, true, "still verified — process is dead");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("HONEST-02: process alive → kill called → sideEffectAttempted=true", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-honest-02-"));
  try {
    makeGitRepo(dir);
    await seedRun(dir, "run_honest02", dir);
    const { stopRun } = await import("../src/application/runStop.js");
    let alive = true;
    let killCalls = 0;
    const result = await stopRun({
      runId: "run_honest02", runDir: dir, authorizedWorkspaceRoot: dir,
      deps: defaultDeps({
        kill: () => { killCalls++; alive = false; return { called: true, exitCode: 0 }; },
        isAlive: () => alive,
      }),
    });
    assert.equal(killCalls, 1, "kill called once");
    assert.equal(result.sideEffectAttempted, true, "must report true when kill attempted");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── MCP concurrency ──────────────────────────────────────────────────────────

test("MCP-CONCURRENCY: two MCP clients → one winner, one loser, one side effect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcp-conc-"));
  try {
    makeGitRepo(dir);
    const runDir = mkdtempSync(join(tmpdir(), "wao-mcp-conc-rd-"));
    await seedRun(runDir, "run_conc", dir);
    let killCalls = 0;
    let alive = true;
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir, workspaceRoot: dir,
      stopRunFn: async (input) => {
        const { stopRun } = await import("../src/application/runStop.js");
        return stopRun({
          ...input,
          deps: {
            kill: () => { killCalls++; alive = false; return { called: true, exitCode: 0 }; },
            isAlive: () => alive,
            alert: async () => {},
          },
        });
      },
    });
    const client = await buildClient(server);
    try {
      // Two concurrent calls through the SAME client/server
      const [r1, r2] = await Promise.all([
        client.callTool({ name: "run_stop", arguments: { runId: "run_conc" } }),
        client.callTool({ name: "run_stop", arguments: { runId: "run_conc" } }),
      ]);
      const p1 = JSON.parse(r1.content[0].text);
      const p2 = JSON.parse(r2.content[0].text);
      const winners = [p1, p2].filter((p) => p.terminalAccepted);
      const losers = [p1, p2].filter((p) => !p.terminalAccepted);
      assert.equal(winners.length, 1, "exactly one winner");
      assert.equal(losers.length, 1, "exactly one loser");
      assert.equal(losers[0].sideEffectAttempted, false, "loser zero side effect");
      assert.equal(killCalls, 1, "exactly one kill");
    } finally {
      await client.close();
      await server.close();
    }
    rmSync(runDir, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Architecture ─────────────────────────────────────────────────────────────

test("ARCH-CLOSEOUT: runStop.js does not have hand-written pathsMatch/gitTopLevel", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(
    join(join(fileURLToPath(new URL(".", import.meta.url))), "..", "src", "application", "runStop.js"),
    "utf8",
  );
  // Must not contain hand-written path algorithms (should use proveWorkspace SSOT)
  assert.ok(!src.includes("function pathsMatch"), "no hand-written pathsMatch");
  assert.ok(!src.includes("function gitTopLevel"), "no hand-written gitTopLevel");
  assert.ok(!src.includes("function normalizePath"), "no hand-written normalizePath");
  // Must use proveWorkspace
  assert.ok(src.includes("proveWorkspace"), "must use proveWorkspace SSOT");
  // Must use isValidRunId
  assert.ok(src.includes("isValidRunId"), "must use isValidRunId SSOT");
});
