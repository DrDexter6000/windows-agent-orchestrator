// test/runStopCloseout.test.js
//
// M10 P0-2 CTO closeout tests: runId escape, subdirectory rejection,
// sideEffectAttempted honesty, MCP concurrency (one client, two calls),
// delivery ownership, SSOT architecture boundary.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stopProof, TEST_STOP_REASON } from "../fixtures/stopProof.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { JsonlTranscript, readTranscript } from "../../src/transcript.js";
import { createWaoMcpServer } from "../../src/mcp/server.js";
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
    const { stopRun } = await import("../../src/application/runStop.js");
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
    const { stopRun } = await import("../../src/application/runStop.js");
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
    const { stopRun } = await import("../../src/application/runStop.js");
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
    const { stopRun } = await import("../../src/application/runStop.js");
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
      const res = await client.callTool({ name: "run_stop", arguments: { runId: "../victim", reason: TEST_STOP_REASON, observedSeq: 0 } });
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
    const { stopRun } = await import("../../src/application/runStop.js");
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
    const { stopRun } = await import("../../src/application/runStop.js");
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

    const { stopRun } = await import("../../src/application/runStop.js");
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
    const { stopRun } = await import("../../src/application/runStop.js");
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
    const { stopRun } = await import("../../src/application/runStop.js");
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

// ── TD-265: host-process stop route ──────────────────────────────────────────
// 会话 id 是 provider 原生 id 的进程式后端在 session.created 里另记 hostPid；
// stop 据此走进程树击杀（此前非 proc_ 一律被当成 serveUrl 路由而报错）。

async function seedSessionRun(runDir, runId, workspaceCwd, session) {
  const t = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId: "a" });
  await t.append("run.started", { backend: session.backend });
  await t.append("run.background_submitted", { background: true, cwd: workspaceCwd });
  await t.append("session.created", session);
  await t.transitionState(null, "pending", "created");
  await t.transitionState("pending", "submitted", "spawned");
  await t.transitionState("submitted", "running", "first_event");
}

test("TD265-01: 原生会话 id + hostPid → 击杀该进程树并核验，事实带后端名", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td265-01-"));
  try {
    makeGitRepo(dir);
    await seedSessionRun(dir, "run_td265_01", dir, { backend: "zcode", backendSessionId: "sess_native_1", hostPid: 4321 });
    const { stopRun } = await import("../../src/application/runStop.js");
    let alive = true;
    const killed = [];
    const result = await stopRun({
      runId: "run_td265_01", runDir: dir, authorizedWorkspaceRoot: dir,
      deps: defaultDeps({
        kill: (pid) => { killed.push(pid); alive = false; return { called: true, exitCode: 0 }; },
        isAlive: () => alive,
        executeStop: async () => { throw new Error("serveUrl route must not be taken"); },
      }),
    });
    assert.deepEqual(killed, [4321]);
    assert.equal(result.terminalAccepted, true);
    assert.equal(result.terminalState, "aborted");
    assert.equal(result.stopVerified, true);
    assert.equal(result.backend, "zcode");
    assert.equal(result.pid, 4321);
    const events = await readTranscript(join(dir, "run_td265_01.jsonl"));
    assert.equal(events.find((e) => e.type === "run.stop_requested").backend, "zcode");
    assert.equal(events.find((e) => e.type === "run.aborted").backend, "zcode");
    assert.equal(events.find((e) => e.type === "run.stop_verified").backend, "zcode");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("TD265-02: 既无 hostPid 也无 serveUrl → 拒绝并点名后端，零事件零副作用", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td265-02-"));
  try {
    makeGitRepo(dir);
    await seedSessionRun(dir, "run_td265_02", dir, { backend: "zcode", backendSessionId: "sess_native_2" });
    const { stopRun } = await import("../../src/application/runStop.js");
    let killCalls = 0;
    const before = (await readTranscript(join(dir, "run_td265_02.jsonl"))).length;
    await assert.rejects(
      () => stopRun({
        runId: "run_td265_02", runDir: dir, authorizedWorkspaceRoot: dir,
        deps: defaultDeps({ kill: () => { killCalls += 1; return { called: true, exitCode: 0 }; } }),
      }),
      /has no stop route: its session \(backend zcode\) records neither a host process id nor a serveUrl/,
    );
    assert.equal(killCalls, 0);
    assert.equal((await readTranscript(join(dir, "run_td265_02.jsonl"))).length, before, "拒绝早于任何写入");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("TD265-03: 有 serveUrl 的会话不因带 hostPid 改走进程路由；非法 hostPid 不被采信", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td265-03-"));
  try {
    makeGitRepo(dir);
    await seedSessionRun(dir, "run_td265_03a", dir, { backend: "opencode-serve", backendSessionId: "ses_serve", serveUrl: "http://127.0.0.1:9", hostPid: 4321 });
    await seedSessionRun(dir, "run_td265_03b", dir, { backend: "zcode", backendSessionId: "sess_native_3", hostPid: "4321" });
    const { stopRun } = await import("../../src/application/runStop.js");
    let killCalls = 0;
    let serveStops = 0;
    const deps = defaultDeps({
      kill: () => { killCalls += 1; return { called: true, exitCode: 0 }; },
      executeStop: async () => { serveStops += 1; return { verified: true, abortCalled: true, taskkillCalled: false }; },
    });
    const viaServe = await stopRun({ runId: "run_td265_03a", runDir: dir, authorizedWorkspaceRoot: dir, deps });
    assert.equal(serveStops, 1);
    assert.equal(viaServe.terminalState, "aborted");
    await assert.rejects(
      () => stopRun({ runId: "run_td265_03b", runDir: dir, authorizedWorkspaceRoot: dir, deps }),
      /has no stop route/,
    );
    assert.equal(killCalls, 0, "字符串形的 hostPid 不是整数，不采信");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("TD265-04: resume 重放之后 stop 的目标是重放记录的新进程，不是 session.created 里的旧进程", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td265-04-"));
  try {
    makeGitRepo(dir);
    const { stopRun } = await import("../../src/application/runStop.js");
    const killedOf = async (runId, session, rerun) => {
      await seedSessionRun(dir, runId, dir, session);
      const prior = await readTranscript(join(dir, `${runId}.jsonl`));
      const t = new JsonlTranscript(join(dir, `${runId}.jsonl`), { runId, agentId: "a", initialSeq: prior.at(-1).seq });
      await t.append("run.rerun", rerun);
      const alive = new Set([1111, 2222]);
      const killed = [];
      const result = await stopRun({
        runId, runDir: dir, authorizedWorkspaceRoot: dir,
        deps: defaultDeps({
          kill: (pid) => { killed.push(pid); alive.delete(pid); return { called: true, exitCode: 0 }; },
          isAlive: (pid) => alive.has(pid),
        }),
      });
      return { killed, result };
    };
    // 原生会话 id + hostPid 的后端：重放记录带新 hostPid
    const native = await killedOf("run_td265_04a",
      { backend: "zcode", backendSessionId: "sess_native", hostPid: 1111 },
      { originalSessionId: "sess_native", newSessionId: "sess_native", reason: "replay", hostPid: 2222 });
    assert.deepEqual(native.killed, [2222]);
    assert.equal(native.result.pid, 2222);
    assert.equal(native.result.backend, "zcode");
    // proc_<pid> 占位 id 的后端：重放记录的新会话 id 自带新 pid（此前同样指向旧进程）
    const placeholder = await killedOf("run_td265_04b",
      { backend: "process", backendSessionId: "proc_1111" },
      { originalSessionId: "proc_1111", newSessionId: "proc_2222", reason: "replay" });
    assert.deepEqual(placeholder.killed, [2222]);
    assert.equal(placeholder.result.pid, 2222);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("TD265-05: 重放记录没带 hostPid（原生会话 id）→ 不沿用旧 pid，拒绝并零副作用", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td265-05-"));
  try {
    makeGitRepo(dir);
    await seedSessionRun(dir, "run_td265_05", dir, { backend: "zcode", backendSessionId: "sess_native", hostPid: 1111 });
    const prior = await readTranscript(join(dir, "run_td265_05.jsonl"));
    const t = new JsonlTranscript(join(dir, "run_td265_05.jsonl"), { runId: "run_td265_05", agentId: "a", initialSeq: prior.at(-1).seq });
    await t.append("run.rerun", { originalSessionId: "sess_native", newSessionId: "sess_native", reason: "replay" });
    const { stopRun } = await import("../../src/application/runStop.js");
    let killCalls = 0;
    await assert.rejects(
      () => stopRun({
        runId: "run_td265_05", runDir: dir, authorizedWorkspaceRoot: dir,
        deps: defaultDeps({ kill: () => { killCalls += 1; return { called: true, exitCode: 0 }; }, isAlive: () => true }),
      }),
      /has no stop route/,
    );
    assert.equal(killCalls, 0, "旧进程的 pid 不再代表这次运行");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── MCP concurrency ──────────────────────────────────────────────────────────

test("MCP-CONCURRENCY: two concurrent MCP calls through one client → one winner, one loser, one side effect", async () => {
  // Note: this test issues two concurrent run_stop calls through the SAME MCP
  // client/server pair. It does NOT test two independent MCP hosts. The
  // underlying transitionState cross-process arbitration is proven separately
  // in terminalArbitration.test.js. Here we verify the MCP adapter correctly
  // surfaces the winner/loser distinction under concurrent access.
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
        const { stopRun } = await import("../../src/application/runStop.js");
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
      const [r1, r2] = await Promise.all([
        client.callTool({ name: "run_stop", arguments: { runId: "run_conc", ...stopProof(dir, "run_conc") } }),
        client.callTool({ name: "run_stop", arguments: { runId: "run_conc", ...stopProof(dir, "run_conc") } }),
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

// ── Delivery ownership ───────────────────────────────────────────────────────

test("DELIVERY-01: delivery run uses source workspace ownership, not worktree", async () => {
  // A delivery run's background_submitted.cwd is the source workspace root.
  // The actual worker runs in a temporary delivery worktree (.wao-worktrees/).
  // Authorization must use the source ownership fact, not the worktree path.
  const sourceDir = mkdtempSync(join(tmpdir(), "wao-delivery-src-"));
  try {
    makeGitRepo(sourceDir);
    // Create a "delivery worktree" as a subdirectory of sourceDir
    const worktreeDir = join(sourceDir, ".wao-worktrees", "run_delivery_test");
    mkdirSync(worktreeDir, { recursive: true });
    // Initialize as a git worktree-like structure (just a subdir with a git link)
    // The key point: background_submitted.cwd = sourceDir (the ownership fact),
    // NOT worktreeDir (where the worker actually runs).
    const runDir = mkdtempSync(join(tmpdir(), "wao-delivery-rd-"));
    const tp = join(runDir, "run_delivery.jsonl");
    const t = new JsonlTranscript(tp, { runId: "run_delivery", agentId: "a" });
    await t.append("run.started", { backend: "claude-code" });
    // Ownership fact: source workspace root (NOT the delivery worktree)
    await t.append("run.background_submitted", { background: true, cwd: sourceDir });
    await t.append("session.created", {
      backend: "process", backendSessionId: "proc_55555",
      // session.cwd points to the delivery worktree (where worker actually runs)
      cwd: worktreeDir,
    });
    await t.transitionState(null, "pending", "created");
    await t.transitionState("pending", "running", "first_event");

    const { stopRun } = await import("../../src/application/runStop.js");
    // Authorized workspace = source root (matches background_submitted.cwd)
    const result = await stopRun({
      runId: "run_delivery", runDir, authorizedWorkspaceRoot: sourceDir,
      deps: defaultDeps(),
    });
    // Authorization must PASS — source ownership fact matches
    assert.notEqual(result.authorized, false, "delivery run must be authorized via source ownership");
    assert.equal(result.terminalAccepted, true, "must proceed to terminal claim");

    rmSync(runDir, { recursive: true, force: true });
  } finally { rmSync(sourceDir, { recursive: true, force: true }); }
});

test("DELIVERY-02: delivery run rejected if authorized root is the worktree, not source", async () => {
  // If someone tries to authorize using the worktree path instead of the source,
  // it must fail — worktreeDir is a subdirectory of sourceDir, proveWorkspace
  // will reject it as non-top-level (it's not a Git top-level).
  const sourceDir = mkdtempSync(join(tmpdir(), "wao-delivery2-src-"));
  try {
    makeGitRepo(sourceDir);
    const worktreeDir = join(sourceDir, ".wao-worktrees", "run_test2");
    mkdirSync(worktreeDir, { recursive: true });
    const runDir = mkdtempSync(join(tmpdir(), "wao-delivery2-rd-"));
    const tp = join(runDir, "run_delivery2.jsonl");
    const t = new JsonlTranscript(tp, { runId: "run_delivery2", agentId: "a" });
    await t.append("run.started", { backend: "claude-code" });
    await t.append("run.background_submitted", { background: true, cwd: sourceDir });
    await t.append("session.created", { backend: "process", backendSessionId: "proc_44444", cwd: worktreeDir });
    await t.transitionState(null, "pending", "created");
    await t.transitionState("pending", "running", "first_event");

    const { stopRun } = await import("../../src/application/runStop.js");
    // Try to authorize with the worktree path — must fail
    const result = await stopRun({
      runId: "run_delivery2", runDir, authorizedWorkspaceRoot: worktreeDir,
      deps: defaultDeps(),
    });
    assert.equal(result.authorized, false, "worktree path must not authorize — it's a subdirectory");

    rmSync(runDir, { recursive: true, force: true });
  } finally { rmSync(sourceDir, { recursive: true, force: true }); }
});

// ── Architecture ─────────────────────────────────────────────────────────────

test("ARCH-CLOSEOUT: runStop.js does not have hand-written pathsMatch/gitTopLevel", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(
    join(join(fileURLToPath(new URL(".", import.meta.url))), "../..", "src", "application", "runStop.js"),
    "utf8",
  );
  // Must not contain hand-written path algorithms (should use proveWorkspace SSOT)
  assert.ok(!src.includes("function pathsMatch"), "no hand-written pathsMatch");
  assert.ok(!src.includes("function gitTopLevel"), "no hand-written gitTopLevel");
  assert.ok(!src.includes("function normalizePath"), "no hand-written normalizePath");
  // Must not contain platform detection or case-folding for path comparison
  assert.ok(!src.includes("process.platform"), "no process.platform in runStop (use SSOT)");
  assert.ok(!src.includes("toLowerCase"), "no toLowerCase in runStop (use SSOT)");
  // Must delegate to runWorkspaceOwnership SSOT (which uses proveWorkspace)
  assert.ok(src.includes("runWorkspaceOwnership"), "must delegate to runWorkspaceOwnership SSOT");
  // Must use isValidRunId
  assert.ok(src.includes("isValidRunId"), "must use isValidRunId SSOT");
  // Must not have dead imports
  assert.ok(!src.includes("execFileSync"), "no dead execFileSync import");
  assert.ok(!src.includes("realpathSync"), "no dead realpathSync import");
});

// ===== 决定 0069：Lead 面的 stop 先过"理由 + 看到的转录位置"这一关 =====

// 会话记录带 hostPid 的运行，外加一条刚落下的 worker 命令事件。返回这条命令之前
// 的位置（Lead "看到"的位置）与全部事件数。
async function seedRunWithLateCommand(runDir, runId, workspaceCwd) {
  const t = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId: "a" });
  await t.append("run.started", { backend: "zcode" });
  await t.append("run.background_submitted", { background: true, cwd: workspaceCwd });
  await t.append("session.created", { backend: "zcode", backendSessionId: "sess_0069", hostPid: 4321 });
  await t.transitionState(null, "pending", "created");
  await t.transitionState("pending", "submitted", "spawned");
  await t.transitionState("submitted", "running", "first_event");
  await t.append("run.event", { kind: "message", role: "assistant", parts: [{ type: "text", text: "starting" }] });
  const before = await readTranscript(join(runDir, `${runId}.jsonl`));
  const observedSeq = before.at(-1).seq;
  await t.append("run.event", { kind: "command", command: "npm test" });
  return { observedSeq, eventCount: before.length + 1 };
}

function killSpy() {
  const killed = [];
  let alive = true;
  return {
    killed,
    deps: (extra = {}) => defaultDeps({
      kill: (pid) => { killed.push(pid); alive = false; return { called: true, exitCode: 0 }; },
      isAlive: () => alive,
      ...extra,
    }),
  };
}

test("0069-S1: 看到的位置之后 worker 又有了动作、且已过 5 分钟 → 拒绝，零事件、零击杀", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-0069-s1-"));
  try {
    makeGitRepo(dir);
    const { observedSeq, eventCount } = await seedRunWithLateCommand(dir, "run_0069_s1", dir);
    const { stopRun } = await import("../../src/application/runStop.js");
    const spy = killSpy();
    const result = await stopRun({
      runId: "run_0069_s1", runDir: dir, authorizedWorkspaceRoot: dir,
      justification: { reason: "worker looks stuck on the first step", observedSeq },
      deps: spy.deps({ nowFn: () => Date.now() + 6 * 60_000 }),
    });
    assert.equal(result.preconditionFailed, "observation_stale");
    assert.equal(result.newerEventCount, 1);
    assert.equal(result.terminalAccepted, false);
    assert.equal(result.sideEffectAttempted, false);
    assert.equal(result.terminalState, "running");
    assert.deepEqual(spy.killed, []);
    const events = await readTranscript(join(dir, "run_0069_s1.jsonl"));
    assert.equal(events.length, eventCount, "转录一条不多");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("0069-S2: 之后的事件是刚落下的（<5 分钟）→ 照常停；理由、位置、新增事件数、体征距今都记进 run.stop_requested", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-0069-s2-"));
  try {
    makeGitRepo(dir);
    const { observedSeq } = await seedRunWithLateCommand(dir, "run_0069_s2", dir);
    const { stopRun } = await import("../../src/application/runStop.js");
    const spy = killSpy();
    const result = await stopRun({
      runId: "run_0069_s2", runDir: dir, authorizedWorkspaceRoot: dir,
      justification: { reason: "  task was cancelled\tby the owner\n", observedSeq },
      deps: spy.deps({ nowFn: () => Date.now() + 60_000 }),
    });
    assert.equal(result.preconditionFailed, undefined);
    assert.equal(result.terminalAccepted, true);
    assert.deepEqual(spy.killed, [4321]);
    const events = await readTranscript(join(dir, "run_0069_s2.jsonl"));
    const requested = events.find((e) => e.type === "run.stop_requested");
    assert.equal(requested.reason, "user");
    assert.equal(requested.statedReason, "task was cancelled by the owner", "理由去掉控制字符并收拢空白");
    assert.equal(requested.observedSeq, observedSeq);
    assert.equal(requested.newerEventCount, 1);
    assert.ok(requested.secondsSinceVitalSign >= 55 && requested.secondsSinceVitalSign <= 70, `实际 ${requested.secondsSinceVitalSign}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("0069-S3: 理由太短 / 位置缺失 / 位置不在转录里 → 各自的拒绝码，零副作用", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-0069-s3-"));
  try {
    makeGitRepo(dir);
    const { observedSeq, eventCount } = await seedRunWithLateCommand(dir, "run_0069_s3", dir);
    const { stopRun, STOP_PRECONDITION_CODES } = await import("../../src/application/runStop.js");
    const spy = killSpy();
    const attempt = (justification) => stopRun({
      runId: "run_0069_s3", runDir: dir, authorizedWorkspaceRoot: dir, justification, deps: spy.deps(),
    });
    const cases = [
      [{ reason: "stop", observedSeq }, "reason_required"],
      [{ reason: " \t \n ", observedSeq }, "reason_required"],
      [{ reason: "x".repeat(401), observedSeq }, "reason_required"],
      [{ reason: "a real reason for stopping" }, "observation_required"],
      [{ reason: "a real reason for stopping", observedSeq: -1 }, "observation_required"],
      [{ reason: "a real reason for stopping", observedSeq: 1.5 }, "observation_required"],
      [{ reason: "a real reason for stopping", observedSeq: 9999 }, "observation_unknown"],
    ];
    for (const [justification, code] of cases) {
      const result = await attempt(justification);
      assert.equal(result.preconditionFailed, code, JSON.stringify(justification).slice(0, 60));
      assert.ok(STOP_PRECONDITION_CODES.includes(result.preconditionFailed));
      assert.equal(result.sideEffectAttempted, false);
    }
    assert.deepEqual(spy.killed, []);
    assert.equal((await readTranscript(join(dir, "run_0069_s3.jsonl"))).length, eventCount);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("0069-S4: 不带 justification 的服务层调用（内部 / 机制测试路径）不做这项检查，也不写理由字段", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-0069-s4-"));
  try {
    makeGitRepo(dir);
    await seedRunWithLateCommand(dir, "run_0069_s4", dir);
    const { stopRun } = await import("../../src/application/runStop.js");
    const spy = killSpy();
    const result = await stopRun({ runId: "run_0069_s4", runDir: dir, authorizedWorkspaceRoot: dir, deps: spy.deps() });
    assert.equal(result.terminalAccepted, true);
    const requested = (await readTranscript(join(dir, "run_0069_s4.jsonl"))).find((e) => e.type === "run.stop_requested");
    assert.equal("statedReason" in requested, false);
    assert.equal("observedSeq" in requested, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("0069-M1: MCP run_stop —— 两项必填由 schema 拦；观察过时返回固定文案、零击杀；看过最新状态后通过", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-0069-m1-"));
  try {
    makeGitRepo(dir);
    const { observedSeq } = await seedRunWithLateCommand(dir, "run_0069_m1", dir);
    const spy = killSpy();
    let clockSkewMs = 6 * 60_000;
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      stopRunFn: async (input) => {
        const { stopRun } = await import("../../src/application/runStop.js");
        return stopRun({ ...input, deps: spy.deps({ nowFn: () => Date.now() + clockSkewMs }) });
      },
    });
    const client = await buildClient(server);
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === "run_stop");
      assert.deepEqual([...tool.inputSchema.required].sort(), ["observedSeq", "reason", "runId"]);

      const missing = await client.callTool({ name: "run_stop", arguments: { runId: "run_0069_m1" } });
      assert.ok(missing.isError, "缺理由与位置 → schema 拒绝");

      const stale = await client.callTool({
        name: "run_stop",
        arguments: { runId: "run_0069_m1", reason: "the worker has been silent for too long", observedSeq },
      });
      assert.ok(stale.isError);
      assert.match(stale.content[0].text, /^run_stop rejected, no side effect: the worker produced events after your observation more than 5 minutes ago\. Re-read run_activity/);
      assert.ok(!stale.content[0].text.includes("npm test"), "固定文案，不带转录内容");
      assert.deepEqual(spy.killed, []);

      // Lead 重新看过：run_activity 最新一条的 seq 就是新的 observedSeq。
      const activity = await client.callTool({ name: "run_activity", arguments: { runId: "run_0069_m1" } });
      const newest = activity.structuredContent.entries[0];
      assert.equal(newest.category, "command", "缺省最新在前");
      assert.equal(newest.text, "npm test");
      clockSkewMs = 0;
      const ok = await client.callTool({
        name: "run_stop",
        arguments: { runId: "run_0069_m1", reason: "owner cancelled the task; npm test no longer needed", observedSeq: newest.seq },
      });
      assert.equal(ok.isError, undefined);
      assert.equal(ok.structuredContent.terminalAccepted, true);
      assert.deepEqual(spy.killed, [4321]);
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("0069-C1: CLI stop —— 缺 --reason / --observed-seq 即报错并给出两步；带齐后执行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-0069-c1-"));
  try {
    makeGitRepo(dir);
    await seedRunWithLateCommand(dir, "run_0069_c1", dir);
    const { stopCommand } = await import("../../src/commands/stop.js");
    const spy = killSpy();
    await assert.rejects(
      () => stopCommand(["run_0069_c1", "--run-dir", dir], { runDir: dir }, spy.deps()),
      /stop 需要 --observed-seq 与 --reason。先看最新状态：status run_0069_c1/,
    );
    await assert.rejects(
      () => stopCommand(["run_0069_c1", "--run-dir", dir, "--observed-seq", "9999", "--reason", "cancelled by the owner"], { runDir: dir }, spy.deps()),
      /stop 未执行（零副作用）：--observed-seq 不是这个运行转录里的位置/,
    );
    assert.deepEqual(spy.killed, []);
    const { getRunStatus } = await import("../../src/application/runStatus.js");
    const status = await getRunStatus({ runId: "run_0069_c1", runDir: dir });
    const originalLog = console.log;
    const printed = [];
    console.log = (line) => printed.push(String(line));
    try {
      await stopCommand(
        ["run_0069_c1", "--run-dir", dir, "--observed-seq", String(status.observedSeq), "--reason", "cancelled by the owner"],
        { runDir: dir }, spy.deps(),
      );
    } finally { console.log = originalLog; }
    assert.deepEqual(spy.killed, [4321]);
    assert.match(printed.join("\n"), /"terminalState": "aborted"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
