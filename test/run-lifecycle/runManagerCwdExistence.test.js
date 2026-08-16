// test/run-lifecycle/runManagerCwdExistence.test.js
//
// R7-AB layer 2 — RunManager.start's PREDICTED working directory must be an
// EXISTING directory, refused in the preflight chain BEFORE any side effect
// (runDir creation, transcript write, worktree creation, spawn). This is the
// FOREGROUND family that never goes through dispatchRun: `run` without
// --background (commands/run.js), workflow agent nodes
// (src/workflow/handlers.js → ctx.runManager.start), and daemon `start`
// (src/daemon.js → manager.start).
//
// Same typed error as layer 1 — single SSOT class defined in
// src/runManager.js (re-exported by runDispatch.js); the prediction semantics
// are identical: the explicit cwd option when non-empty, else the registry
// entry's agent.cwd (after the getAgent(id, {cwd}) merge, agent.cwd IS the
// predicted spawn cwd — pinned by RCE-2/RCE-12).
//
// Capability scoping pinned here (RCE-6): the check is keyed on the SAME
// declared capability the M12-14 invocation-budget preflight uses — a backend
// implementing preflightInvocation composes a LOCAL OS invocation and spawns
// with cwd: agent.cwd (the Node ENOENT-blames-the-executable trap). An HTTP
// backend (opencode-serve shape: no preflightInvocation) threads cwd to the
// serve API as a REMOTE directory hint — no local spawn — and stays unaffected,
// byte-compatible with pre-R7 behavior.
//
// Boundaries pinned:
//   1. Refusal faces   — bad registry cwd / bad explicit cwd / exists-but-file
//      all refuse typed with ZERO runDir, ZERO transcript, ZERO worktree,
//      ZERO spawn (RCE-1..RCE-3, RCE-5).
//   2. Acceptance      — existing absolute cwd runs as before (run.started.cwd
//      still recorded); relative "." threads verbatim (RCE-4, RCE-12).
//   3. Channel e2e     — foreground CLI exit non-zero + typed stderr (RCE-7);
//      workflow engine nodeResults carry the typed message — the stable
//      cross-machine assertion layer for the workflow channel (RCE-8); daemon
//      handleRequest rejects typed (RCE-9).
//   4. Ordering        — the cwd refusal precedes the credential check,
//      mirroring layer 1's determinism argument (RCE-10).
//   5. SSOT identity   — start throws the SAME class layer 1 throws (RCE-11).
//   6. Scope invariant — HTTP-shape backend + bad cwd proceeds exactly as
//      before (RCE-6).
//
// Pure group: temp fixtures under os.tmpdir(), fake backends with injectable
// spawn, zero git (createWorktreeFn recorder), zero real dispatch, zero
// provider token. The only real subprocesses are the CLI end-to-end (RCE-7),
// which is REFUSED before any spawn.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { RunManager, DispatchCwdNotFoundError } from "../../src/runManager.js";
import { readRegistry } from "../../src/registry.js";
import { WorkflowEngine } from "../../src/workflow/engine.js";
import { handleRequest } from "../../src/daemon.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ===== Helpers =====

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function makeRegistry(dir, agents) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return registryPath;
}

/** List the .jsonl transcripts in a runs dir (empty list if the dir is absent). */
function listTranscripts(runDir) {
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir).filter((f) => f.endsWith(".jsonl"));
}

// The placeholder cwd shape from the reproduced defect (config/agents.example.json
// researcher entry). Never created on disk in these fixtures.
const PLACEHOLDER_CWD = "D:/projects/your-project";

/**
 * A fake PROCESS backend: declares preflightInvocation — the same capability
 * marker the M12-14 invocation-budget preflight keys on — so the layer-2 cwd
 * gate applies. spawn is recorded, never a real OS spawn.
 */
function makeProcessBackend() {
  const spawns = [];
  const backend = {
    supportsRoleContract: true,
    sessionOutlivesProcess: false,
    // Structured-policy gate (runManager.js M11-9 closeout) — no-op: this fake
    // expresses any policy; only the cwd gate is under test here.
    validateAgentPolicy() {},
    async preflightInvocation() { /* capability marker only — budget check is not under test */ },
    async spawn(agent, task) {
      spawns.push({ agent, task });
      return {
        backend: "claude-code",
        backendSessionId: "s1",
        messageId: "m1",
        admittedSeq: 1,
        async *events() {
          yield { type: "message", role: "assistant", text: "ok" };
        },
        abort: async () => {},
        isAlive: () => false,
      };
    },
  };
  return { backend, spawns };
}

/**
 * A fake HTTP backend (opencode-serve shape): NO preflightInvocation — the
 * layer-2 cwd gate must NOT apply (cwd is a remote directory hint there).
 */
function makeHttpBackend() {
  const spawns = [];
  const backend = {
    supportsRoleContract: true,
    sessionOutlivesProcess: false,
    validateAgentPolicy() {},
    async spawn(agent, task) {
      spawns.push({ agent, task });
      return {
        backend: "opencode-serve",
        backendSessionId: "s2",
        messageId: "m2",
        admittedSeq: 1,
        async *events() {
          yield { type: "message", role: "assistant", text: "ok" };
        },
        abort: async () => {},
        isAlive: () => false,
      };
    },
  };
  return { backend, spawns };
}

/** RunManager with the REAL readRegistry (getAgent merge semantics) + fake backend. */
function makeManager({ registryPath, runDir, backend, createWorktreeFn }) {
  return new RunManager({
    config: {
      registry: registryPath,
      runDir,
      pollInterval: 10,
      waitTimeout: 5000,
      timeout: 5000,
      retries: 0,
      defaultIsolation: "none",
    },
    readRegistry,
    backendFor: () => backend,
    userEnvReader: async () => ({}),
    ...(createWorktreeFn ? { createWorktreeFn } : {}),
  });
}

// =====================================================================
// 1. Refusal faces — typed, zero runDir, zero transcript, zero worktree, zero spawn
// =====================================================================

test("RCE-1: foreground start, registry agent.cwd nonexistent (researcher defect shape) → typed refusal, zero side effects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rce1-"));
  const { backend, spawns } = makeProcessBackend();
  const worktrees = [];
  try {
    const registryPath = makeRegistry(dir, {
      researcher: { backend: "claude-code", cwd: PLACEHOLDER_CWD },
    });
    const runDir = join(dir, "runs");
    const manager = makeManager({
      registryPath, runDir, backend,
      createWorktreeFn: async (source) => { worktrees.push(source); return { path: join(dir, "wt"), branch: "wao/x" }; },
    });
    await assert.rejects(
      () => manager.start("researcher", { prompt: "分析这个模块" }),
      (e) => {
        assert.equal(e.name, "DispatchCwdNotFoundError", "the SAME typed error as layer 1");
        assert.equal(e.reasonCode, "dispatch_cwd_not_found");
        assert.ok(e.message.includes(resolve(PLACEHOLDER_CWD)), "resolved placeholder path in the message");
        assert.match(e.message, /agent registry entry cwd/, "registry-entry source label");
        return true;
      },
    );
    assert.equal(existsSync(runDir), false, "runDir never created (mkdir happens after the gate)");
    assert.equal(spawns.length, 0, "zero backend spawns");
    assert.equal(worktrees.length, 0, "zero worktree attempts");
  } finally {
    cleanupDir(dir);
  }
});

test("RCE-2: explicit cwd option pointing at a nonexistent path overrides a GOOD registry cwd → typed refusal with flag source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rce2-"));
  const { backend, spawns } = makeProcessBackend();
  try {
    // Mechanism pin: the runner's --cwd reaches start as the cwd option and
    // getAgent(agentId, { cwd }) merges it OVER the registry entry — so the
    // predicted cwd here is the explicit bad path, not the existing registry dir.
    const registryPath = makeRegistry(dir, {
      researcher: { backend: "claude-code", cwd: dir },
    });
    const badCwd = join(dir, "no-such-target");
    const manager = makeManager({ registryPath, runDir: join(dir, "runs"), backend });
    await assert.rejects(
      () => manager.start("researcher", { prompt: "x", cwd: badCwd }),
      (e) => {
        assert.equal(e.name, "DispatchCwdNotFoundError");
        assert.equal(e.reasonCode, "dispatch_cwd_not_found");
        assert.ok(e.message.includes(resolve(badCwd)), "the explicit path is the one named");
        assert.match(e.message, /--cwd flag/, "flag source label");
        return true;
      },
    );
    assert.equal(spawns.length, 0, "zero spawns");
    assert.deepEqual(listTranscripts(join(dir, "runs")), [], "zero transcripts");
  } finally {
    cleanupDir(dir);
  }
});

test("RCE-3: predicted cwd exists but is a FILE → refused (spawn would fail on it the same way)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rce3-"));
  const { backend, spawns } = makeProcessBackend();
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const fileCwd = join(dir, "not-a-dir.txt");
    writeFileSync(fileCwd, "x", "utf8");
    const manager = makeManager({ registryPath, runDir: join(dir, "runs"), backend });
    await assert.rejects(
      () => manager.start("coder_low", { prompt: "x", cwd: fileCwd }),
      (e) => {
        assert.equal(e.name, "DispatchCwdNotFoundError");
        assert.ok(e.message.includes(fileCwd), "the offending path is named");
        return true;
      },
    );
    assert.equal(spawns.length, 0, "zero spawns");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 2. Acceptance faces — existing cwds run exactly as before
// =====================================================================

test("RCE-4: legit registry cwd → start proceeds, run.started.cwd recorded (regression)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rce4-"));
  const { backend, spawns } = makeProcessBackend();
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const runDir = join(dir, "runs");
    const manager = makeManager({ registryPath, runDir, backend });
    const run = await manager.start("coder_low", { prompt: "hello" });
    assert.ok(run.runId, "start resolves and returns a run handle");
    assert.equal(spawns.length, 1, "backend spawned exactly once");
    assert.equal(spawns[0].agent.cwd, dir, "effective cwd is the (existing) registry cwd");
    const { readTranscript } = await import("../../src/transcript.js");
    const events = await readTranscript(join(runDir, `${run.runId}.jsonl`));
    const started = events.find((e) => e.type === "run.started");
    assert.equal(started.cwd, dir, "run.started.cwd still recorded from the resolved agent cwd");
  } finally {
    cleanupDir(dir);
  }
});

test("RCE-5: delivery run, worktree SOURCE directory (agent.cwd) missing → typed refusal BEFORE worktree creation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rce5-"));
  const { backend, spawns } = makeProcessBackend();
  const worktrees = [];
  try {
    // The checked path is the worktree SOURCE directory (agent.cwd / explicit
    // cwd) — the worktree itself is WAO-created and always exists.
    const registryPath = makeRegistry(dir, {
      coder_low: { backend: "claude-code", cwd: PLACEHOLDER_CWD },
    });
    const runDir = join(dir, "runs");
    const manager = makeManager({
      registryPath, runDir, backend,
      createWorktreeFn: async (source) => { worktrees.push(source); return { path: join(dir, "wt"), branch: "wao/x" }; },
    });
    await assert.rejects(
      () => manager.start("coder_low", {
        prompt: "deliver",
        isolate: true,
        delivery: {
          mode: "git_commit_v1",
          allowedPaths: ["src"],
          verificationCommands: ["npm test"],
        },
      }),
      (e) => e.name === "DispatchCwdNotFoundError",
    );
    assert.equal(worktrees.length, 0, "zero worktree creation attempts (refusal precedes)");
    assert.equal(existsSync(runDir), false, "runDir never created");
    assert.equal(spawns.length, 0, "zero spawns");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 3. Scope invariant — HTTP-shape backend is unaffected (byte-compatible)
// =====================================================================

test("RCE-6: HTTP-shape backend (no preflightInvocation) + nonexistent cwd → gate skipped, start proceeds exactly as before", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rce6-"));
  const { backend, spawns } = makeHttpBackend();
  try {
    // opencode-serve shape: agent.cwd is threaded to the serve API as a REMOTE
    // directory hint — there is no local spawn with that cwd, so no local
    // ENOENT trap, and the existence gate must not fire. This also pins the
    // compat contract the repo's own opencode-serve fixtures rely on.
    const registryPath = makeRegistry(dir, {
      surveyor: { backend: "opencode-serve", cwd: PLACEHOLDER_CWD, serveUrl: "http://127.0.0.1:4299", model: { providerID: "p", id: "m" } },
    });
    const manager = makeManager({ registryPath, runDir: join(dir, "runs"), backend });
    const run = await manager.start("surveyor", { prompt: "x" });
    assert.ok(run.runId, "start proceeds (pre-R7 behavior preserved)");
    assert.equal(spawns.length, 1, "spawn reached, cwd threaded as before");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 4. Channel end-to-end — foreground CLI / workflow engine / daemon
// =====================================================================

test("RCE-7: CLI e2e — foreground run + bad-cwd registry fixture → exit non-zero, stderr typed + path, run-dir zero .jsonl", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rce7-"));
  try {
    const registryPath = makeRegistry(dir, {
      researcher: { backend: "claude-code", cwd: PLACEHOLDER_CWD },
    });
    const runDir = join(dir, "runs");
    // Foreground (no --background): commands/run.js → manager.start directly.
    const r = spawnSync(process.execPath, [
      "src/cli.js", "run", "researcher",
      "--prompt", "x",
      "--registry", registryPath,
      "--run-dir", runDir,
    ], { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" }, timeout: 30000 });
    assert.notEqual(r.status, 0, "the refused run must exit non-zero");
    assert.match(r.stderr, /dispatch_cwd_not_found/, "stderr carries the closed-set reason code");
    assert.match(r.stderr, /dispatch working directory does not exist/, "stderr carries the typed refusal");
    assert.ok(r.stderr.includes(resolve(PLACEHOLDER_CWD)), `stderr names the resolved path, got: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /node\.exe ENOENT/, "no misleading executable-ENOENT face");
    assert.deepEqual(listTranscripts(runDir), [], "run-dir has zero .jsonl — runDir never created");
  } finally {
    cleanupDir(dir);
  }
});

test("RCE-8: workflow agent node, bad registry cwd → node result carries the typed message (engine nodeResults = the stable layer)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rce8-"));
  const { backend, spawns } = makeProcessBackend();
  try {
    // Workflow agent nodes go through ctx.runManager.start (handlers.js),
    // NOT dispatchRun. The engine's per-node catch (engine.js) folds a thrown
    // start error into { completed:false, error: message } — nodeResults is
    // where the typed text is stably assertable across machines (the CLI
    // summary intentionally prints only {completed, runId}).
    const registryPath = makeRegistry(dir, {
      researcher: { backend: "claude-code", cwd: PLACEHOLDER_CWD },
    });
    const wfRunDir = join(dir, "wf-runs");
    const manager = makeManager({ registryPath, runDir: wfRunDir, backend });
    const engine = new WorkflowEngine({ runManager: manager });
    const result = await engine.execute({
      id: "rce8-wf",
      nodes: [
        { id: "research_a", type: "agent", agentId: "researcher", prompt: "研究 {{topic}}" },
      ],
      edges: [],
    }, { registry: registryPath, runDir: wfRunDir });
    assert.equal(result.completed, false, "the node failure marks the workflow incomplete");
    const node = result.nodeResults.research_a;
    assert.equal(node.completed, false, "agent node failed");
    assert.match(node.error, /dispatch_cwd_not_found/, "node error carries the closed-set reason code");
    assert.match(node.error, /dispatch working directory does not exist/, "node error carries the typed refusal");
    assert.ok(node.error.includes(resolve(PLACEHOLDER_CWD)), "node error names the resolved path");
    assert.equal(spawns.length, 0, "zero spawns for the refused node");
    assert.deepEqual(listTranscripts(wfRunDir), [], "zero run transcripts in the workflow run-dir");
  } finally {
    cleanupDir(dir);
  }
});

test("RCE-9: daemon channel — handleRequest start + bad-cwd registry → typed rejection, zero transcripts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rce9-"));
  const { backend, spawns } = makeProcessBackend();
  try {
    // daemon `start` (daemon.js) calls manager.start directly (no cwd option —
    // the registry entry's cwd is the prediction). handleRequest is the pure
    // IPC logic unit, so the pin is cheap and socket-free; the daemon server
    // wrapper folds a rejected handleRequest into { ok:false, error: message }
    // for the IPC client (same message surface).
    const registryPath = makeRegistry(dir, {
      researcher: { backend: "claude-code", cwd: PLACEHOLDER_CWD },
    });
    const runDir = join(dir, "runs");
    const manager = makeManager({ registryPath, runDir, backend });
    await assert.rejects(
      () => handleRequest({ cmd: "start", agentId: "researcher", prompt: "x" }, manager, { registryPath, runDir }),
      (e) => {
        assert.equal(e.name, "DispatchCwdNotFoundError");
        assert.equal(e.reasonCode, "dispatch_cwd_not_found");
        assert.ok(e.message.includes(resolve(PLACEHOLDER_CWD)));
        return true;
      },
    );
    assert.equal(spawns.length, 0, "zero spawns");
    assert.deepEqual(listTranscripts(runDir), [], "zero transcripts");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 5. Ordering + SSOT identity
// =====================================================================

test("RCE-10: bad cwd AND missing required credential → the cwd refusal wins (deterministic, env-independent — mirrors layer 1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rce10-"));
  const { backend, spawns } = makeProcessBackend();
  try {
    // The agent ALSO lacks its required credential env (machine-dependent
    // face). The cwd gate sits BEFORE the credential check — mirroring layer
    // 1's ordering — so the refusal is the deterministic, env-independent one.
    const registryPath = makeRegistry(dir, {
      coder_low: {
        backend: "claude-code",
        cwd: PLACEHOLDER_CWD,
        provider: { protocol: "anthropic-compatible", baseUrl: "https://synthetic.example.com", apiKeyEnv: "RCE10_NO_SUCH_KEY" },
      },
    });
    const manager = makeManager({ registryPath, runDir: join(dir, "runs"), backend });
    await assert.rejects(
      () => manager.start("coder_low", { prompt: "x" }),
      (e) => {
        assert.equal(e.name, "DispatchCwdNotFoundError", "the cwd refusal, not the credential error");
        assert.doesNotMatch(e.message, /missing required credential/i);
        return true;
      },
    );
    assert.equal(spawns.length, 0);
  } finally {
    cleanupDir(dir);
  }
});

test("RCE-11: start throws the SAME SSOT class layer 1 throws (single class definition, two authorities)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rce11-"));
  const { backend } = makeProcessBackend();
  const { DispatchCwdNotFoundError: fromDispatch } = await import("../../src/application/runDispatch.js");
  try {
    const registryPath = makeRegistry(dir, {
      researcher: { backend: "claude-code", cwd: PLACEHOLDER_CWD },
    });
    const manager = makeManager({ registryPath, runDir: join(dir, "runs"), backend });
    await assert.rejects(
      () => manager.start("researcher", { prompt: "x" }),
      (e) => {
        assert.ok(e instanceof DispatchCwdNotFoundError, "instanceof the SSOT class");
        assert.ok(e instanceof fromDispatch, "instanceof the class re-exported by runDispatch.js (layer 1 surface)");
        return true;
      },
    );
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 6. Acceptance — relative cwd threads verbatim (spawn semantics unchanged)
// =====================================================================

test("RCE-12: explicit relative cwd that exists (\".\") → accepted, threaded verbatim to the backend", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rce12-"));
  const { backend, spawns } = makeProcessBackend();
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const manager = makeManager({ registryPath, runDir: join(dir, "runs"), backend });
    const run = await manager.start("coder_low", { prompt: "x", cwd: "." });
    assert.ok(run.runId, "a relative-but-existing cwd starts as before");
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].agent.cwd, ".", "threaded verbatim (resolution stays spawn-side semantics)");
  } finally {
    cleanupDir(dir);
  }
});
