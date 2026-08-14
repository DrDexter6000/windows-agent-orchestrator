// test/m12-13-verification-timeout.test.js
//
// M12-13 outcome A: the optional per-command execution timeout
// (`verificationTimeoutMs`) for delivery verification.
//
// Contract (exact semantics):
//   - optional integer ms in SHARED bounds [1000, 7200000], default 300000
//     applied by consumers ONLY when the field is absent;
//   - validated BEFORE any side effect (transcript append, worktree mutation,
//     spawn/attach, packaging, verification) at the shared prepareDeliveryRequest
//     SSOT — an invalid string/fraction/out-of-range value fails closed with
//     ZERO transcript bytes, ZERO worktree, ZERO spawn;
//   - persisted ONLY when declared (zero drift when absent) — in run.started,
//     in the delivery_created ref, and preserved through verification outcome
//     refs;
//   - preserved through start AND resume (a persisted value survives a resume,
//     and a malformed persisted value makes resume REFUSE with zero side
//     effects — transcript bytes and worktree inventory unchanged, spawn 0);
//   - forwarded by EVERY public/shared conversion that rebuilds delivery input:
//     MCP run_dispatch (inline + execution-profile fold), the CLI dispatchRun
//     --delivery-json payload, and the reverify inheritance (an omitted reverify
//     timeoutMs inherits the persisted per-command execution budget; an explicit
//     value must satisfy the same shared bounds on the wire);
//   - the persisted value is authoritative: never widened, never retried.
//
// Terminology: this field is a per-command execution timeout/budget, NOT a
// run_wait observation window.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync, readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync, execFileSync } from "node:child_process";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

// ===== Shared fixtures (real git repo / real linked worktree) =====

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
  }).trim();
}

function makeGitRepo(dir) {
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "# test\n", "utf8");
  git(["add", "README.md"], dir);
  git(["commit", "-m", "init"], dir);
}

function makeWorktree(repo, branch) {
  const path = join(repo, ".wao-worktrees", branch.split("/").pop());
  git(["worktree", "add", path, "-b", branch], repo);
  const baseCommit = git(["rev-parse", "HEAD"], repo);
  return { path, branch, baseCommit };
}

function makeRegistry(dir, agents) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return registryPath;
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function jl(obj) { return JSON.stringify(obj) + "\n"; }

function writeTranscript(runDir, runId, lines) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, `${runId}.jsonl`), lines.join(""), "utf8");
}

async function readWorktreeFromTranscript(runDir, runId) {
  const { readTranscript } = await import("../../src/transcript.js");
  const events = await readTranscript(join(runDir, `${runId}.jsonl`));
  const started = events.find((e) => e.type === "run.started");
  return started?.worktreePath ?? null;
}

/**
 * A backend events generator that waits for run.started to be durable (its
 * worktreePath), writes a change into the worktree's allowedPaths, then yields
 * done — so the REAL packager has exactly one authorized change to commit and
 * the REAL verification flow runs after completion.
 */
function writeAndDoneGenerator({ runDir, runId, relPath = "src/result.txt", content = "ok\n" }) {
  return async function* () {
    let wt = null;
    for (let i = 0; i < 400 && !wt; i += 1) {
      try { wt = await readWorktreeFromTranscript(runDir, runId); } catch { /* not durable yet */ }
      if (!wt) await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(wt, "run.started.worktreePath must be durable before done");
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, relPath), content, "utf8");
    yield { kind: "done", reason: "completed" };
  };
}

/**
 * A fake verification fn that records its opts and returns a PASSED result.
 * The result ref spreads the input ref so persisted fields (verificationTimeoutMs)
 * survive into the outcome ref, exactly like the production verifier.
 */
function makePassingVerify(verifyCalls) {
  return async function (deliveryRef, opts) {
    verifyCalls.push({ deliveryRef, opts });
    return {
      delivery: {
        ...deliveryRef,
        verification: {
          ...deliveryRef.verification,
          status: "passed",
          verifiedCommit: deliveryRef.deliveryCommit,
          results: [],
        },
      },
      outcome: "passed",
      failureCode: undefined,
    };
  };
}

function makeBackend({ eventsGenerator, onSpawn, spawnThrows = false }) {
  let spawnCount = 0;
  const backend = {
    supportsRoleContract: true,
    sessionOutlivesProcess: false,
    async spawn(agent, task) {
      spawnCount += 1;
      if (spawnThrows) throw new Error("should not be called");
      if (onSpawn) await onSpawn(agent, task);
      return {
        backend: "claude-code",
        backendSessionId: "s1",
        messageId: "m1",
        admittedSeq: 1,
        async *events() { if (eventsGenerator) yield* eventsGenerator(); },
        abort: async () => {},
      };
    },
    defaultBinary() { return "claude"; },
    credentialEnvNames: () => [],
  };
  return { backend, spawnCount: () => spawnCount };
}

// =====================================================================
// A. Leaf: prepareDeliveryRequest SSOT validation + zero drift
// =====================================================================

test("VT-01: prepareDeliveryRequest forwards verificationTimeoutMs only when declared (zero drift)", async () => {
  const { prepareDeliveryRequest } = await import("../../src/delivery.js");
  const base = { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"] };

  const withT = prepareDeliveryRequest({ ...base, verificationTimeoutMs: 600000 });
  assert.equal(withT.verification.verificationTimeoutMs, 600000, "declared value forwarded");

  const withoutT = prepareDeliveryRequest(base);
  assert.equal(
    Object.prototype.hasOwnProperty.call(withoutT.verification, "verificationTimeoutMs"),
    false,
    "absent → NO verificationTimeoutMs key anywhere (zero drift)",
  );
});

test("VT-02: prepareDeliveryRequest rejects invalid verificationTimeoutMs (string/fraction/out-of-range/null)", async () => {
  const { prepareDeliveryRequest } = await import("../../src/delivery.js");
  const base = { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"] };

  for (const bad of ["300000", 300000.5, 999, 7200001, null, NaN]) {
    await assert.rejects(
      async () => prepareDeliveryRequest({ ...base, verificationTimeoutMs: bad }),
      (err) => err?.deliveryCode === "invalid_verification"
        && /verificationTimeoutMs/.test(err?.message ?? ""),
      `must reject ${JSON.stringify(bad)} with DeliveryError invalid_verification`,
    );
  }
  // Boundaries accepted.
  assert.equal(prepareDeliveryRequest({ ...base, verificationTimeoutMs: 1000 }).verification.verificationTimeoutMs, 1000);
  assert.equal(prepareDeliveryRequest({ ...base, verificationTimeoutMs: 7200000 }).verification.verificationTimeoutMs, 7200000);
});

test("VT-03: reverify timeout bounds are ALIASES of the shared per-command execution bounds", async () => {
  const { VERIFICATION_TIMEOUT_MS_MIN, VERIFICATION_TIMEOUT_MS_MAX, VERIFICATION_TIMEOUT_MS_DEFAULT } =
    await import("../../src/delivery.js");
  const { REVERIFY_TIMEOUT_MS_MIN, REVERIFY_TIMEOUT_MS_MAX, REVERIFY_TIMEOUT_MS_DEFAULT } =
    await import("../../src/transcript.js");
  assert.equal(VERIFICATION_TIMEOUT_MS_MIN, 1000);
  assert.equal(VERIFICATION_TIMEOUT_MS_MAX, 7200000);
  assert.equal(VERIFICATION_TIMEOUT_MS_DEFAULT, 300000);
  assert.equal(REVERIFY_TIMEOUT_MS_MIN, VERIFICATION_TIMEOUT_MS_MIN, "reverify min aliases shared min");
  assert.equal(REVERIFY_TIMEOUT_MS_MAX, VERIFICATION_TIMEOUT_MS_MAX, "reverify max aliases shared max");
  assert.equal(REVERIFY_TIMEOUT_MS_DEFAULT, VERIFICATION_TIMEOUT_MS_DEFAULT, "reverify default aliases shared default");
});

// =====================================================================
// B. Causal: real RunManager.start — fail-closed before any side effect
// =====================================================================

test("VT-04: invalid verificationTimeoutMs on start → zero transcript / zero spawn / zero worktree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-vt04-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const runDir = join(dir, "runs");
    const { RunManager } = await import("../../src/runManager.js");
    const { backend, spawnCount } = makeBackend({});
    const manager = new RunManager({
      config: { registry: registryPath, runDir, defaultIsolation: "none" },
      readRegistry: async () => {
        const { readRegistry } = await import("../../src/registry.js");
        return readRegistry(registryPath);
      },
      transcriptDir: runDir,
      backendFor: () => backend,
      userEnvReader: async () => ({}),
    });

    let caught = null;
    try {
      await manager.start("coder_low", {
        prompt: "x", runDir, registry: registryPath, fireAndForget: false, isolate: true,
        delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"], verificationTimeoutMs: "300000" },
      });
    } catch (e) { caught = e; }
    assert.ok(caught, "start must throw on a malformed verificationTimeoutMs");
    assert.equal(caught.deliveryCode, "invalid_verification", "DeliveryError invalid_verification");

    // Zero side effects: no transcript file, no spawn, no linked worktree.
    const jsonl = existsSync(runDir) ? readdirSync(runDir).filter((f) => f.endsWith(".jsonl")) : [];
    assert.equal(jsonl.length, 0, "zero transcript created (fail-closed before side effects)");
    assert.equal(spawnCount(), 0, "zero spawn");
    const wtList = git(["worktree", "list"], dir);
    assert.equal(wtList.split("\n").filter(Boolean).length, 1, "only the main worktree (no new worktree)");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// C. Causal: real RunManager.start — declared value reaches persistence,
//    packaging, and the verifier; absent value is zero drift
// =====================================================================

test("VT-05: declared verificationTimeoutMs → persisted + forwarded to the verifier + preserved through outcome refs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-vt05-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const runDir = join(dir, "runs");
    const runId = "run_vt05";
    const verifyCalls = [];
    const { RunManager } = await import("../../src/runManager.js");
    const { backend, spawnCount } = makeBackend({
      eventsGenerator: writeAndDoneGenerator({ runDir, runId }),
    });
    const manager = new RunManager({
      config: { registry: registryPath, runDir, defaultIsolation: "none" },
      readRegistry: async () => {
        const { readRegistry } = await import("../../src/registry.js");
        return readRegistry(registryPath);
      },
      transcriptDir: runDir,
      backendFor: () => backend,
      userEnvReader: async () => ({}),
      verifyDeliveryFn: makePassingVerify(verifyCalls),
    });

    const run = await manager.start("coder_low", {
      prompt: "x", runId, runDir, registry: registryPath, fireAndForget: false, isolate: true,
      delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"], verificationTimeoutMs: 600000 },
    });
    const result = await run.waitForCompletion({ pollInterval: 1 });

    assert.equal(result.completed, true, "valid declared timeout must not change the completion flow");
    assert.equal(spawnCount(), 1, "spawned exactly once");

    const { readTranscript } = await import("../../src/transcript.js");
    const events = await readTranscript(join(runDir, `${runId}.jsonl`));
    const started = events.find((e) => e.type === "run.started");
    assert.equal(started.delivery.verificationTimeoutMs, 600000, "run.started persists the declared timeout");
    const created = events.find((e) => e.type === "run.delivery_created");
    assert.ok(created, "delivery_created written");
    assert.equal(created.delivery.verification.verificationTimeoutMs, 600000,
      "created ref persists the declared timeout");
    const passed = events.find((e) => e.type === "run.delivery_verification_passed");
    assert.ok(passed, "verification passed (valid flow unchanged)");
    assert.equal(passed.delivery.verification.verificationTimeoutMs, 600000,
      "outcome ref preserves the declared timeout");

    // The verifier received the declared per-command execution budget.
    assert.equal(verifyCalls.length, 1, "verifyDeliveryFn called exactly once");
    assert.equal(verifyCalls[0].opts.timeoutMs, 600000, "verifier opts carry the declared timeout");
  } finally {
    cleanupDir(dir);
  }
});

test("VT-06: absent verificationTimeoutMs → zero drift end-to-end; verifier called with empty opts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-vt06-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const runDir = join(dir, "runs");
    const runId = "run_vt06";
    const verifyCalls = [];
    const { RunManager } = await import("../../src/runManager.js");
    const { backend } = makeBackend({
      eventsGenerator: writeAndDoneGenerator({ runDir, runId }),
    });
    const manager = new RunManager({
      config: { registry: registryPath, runDir, defaultIsolation: "none" },
      readRegistry: async () => {
        const { readRegistry } = await import("../../src/registry.js");
        return readRegistry(registryPath);
      },
      transcriptDir: runDir,
      backendFor: () => backend,
      userEnvReader: async () => ({}),
      verifyDeliveryFn: makePassingVerify(verifyCalls),
    });

    const run = await manager.start("coder_low", {
      prompt: "x", runId, runDir, registry: registryPath, fireAndForget: false, isolate: true,
      delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"] },
    });
    const result = await run.waitForCompletion({ pollInterval: 1 });
    assert.equal(result.completed, true, "absent timeout must not change the completion flow");

    const { readTranscript } = await import("../../src/transcript.js");
    const events = await readTranscript(join(runDir, `${runId}.jsonl`));
    for (const e of events) {
      if (e.type === "run.started") {
        assert.equal(
          Object.prototype.hasOwnProperty.call(e.delivery, "verificationTimeoutMs"),
          false,
          "run.started must NOT gain verificationTimeoutMs when absent",
        );
      }
      if (e.type === "run.delivery_created") {
        assert.equal(
          Object.prototype.hasOwnProperty.call(e.delivery?.verification ?? {}, "verificationTimeoutMs"),
          false,
          "created ref must NOT gain verificationTimeoutMs when absent",
        );
      }
    }
    assert.equal(verifyCalls.length, 1, "verifyDeliveryFn called exactly once");
    const opts = verifyCalls[0].opts ?? {};
    assert.equal(Object.prototype.hasOwnProperty.call(opts, "timeoutMs"), false,
      "verifier must receive NO timeoutMs when the field is absent (default applies)");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// D. Causal: real RunManager.resume — valid persisted value forwarded;
//    malformed persisted value refused with ZERO side effects
// =====================================================================

test("VT-07: resume forwards the persisted verificationTimeoutMs (valid)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-vt07-"));
  try {
    makeGitRepo(dir);
    const runId = "run_vt07";
    const wt = makeWorktree(dir, `wao/${runId}`);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const runDir = join(dir, "runs");
    writeTranscript(runDir, runId, [
      jl({ type: "run.started", backend: "claude-code", cwd: dir, worktreePath: wt.path, worktreeBranch: wt.branch, delivery: { mode: "git_commit_v1", baseCommit: wt.baseCommit, allowedPaths: ["src"], verificationCommands: ["echo ok"], verificationTimeoutMs: 700000 }, ts: "2026-08-05T00:00:00.000Z", runId, agentId: "coder_low", seq: 1 }),
      jl({ type: "session.created", backend: "claude-code", backendSessionId: "s1", ts: "2026-08-05T00:00:00.200Z", runId, agentId: "coder_low", seq: 2 }),
      jl({ type: "prompt.sent", prompt: "do it", ts: "2026-08-05T00:00:00.300Z", runId, agentId: "coder_low", seq: 3 }),
      jl({ type: "run.state_change", from: "pending", to: "submitted", reason: "spawned", ts: "2026-08-05T00:00:00.400Z", runId, agentId: "coder_low", seq: 4 }),
    ]);
    const verifyCalls = [];
    const { RunManager } = await import("../../src/runManager.js");
    const { backend, spawnCount } = makeBackend({
      eventsGenerator: writeAndDoneGenerator({ runDir, runId }),
    });
    const manager = new RunManager({
      config: { registry: registryPath, runDir, defaultIsolation: "none" },
      readRegistry: async () => {
        const { readRegistry } = await import("../../src/registry.js");
        return readRegistry(registryPath);
      },
      transcriptDir: runDir,
      backendFor: () => backend,
      userEnvReader: async () => ({}),
      verifyDeliveryFn: makePassingVerify(verifyCalls),
    });

    const resumed = await manager.resume(runId, { runDir, registry: registryPath });
    assert.ok(resumed, "valid persisted verificationTimeoutMs must NOT block resume");
    const result = await resumed.waitForCompletion({ pollInterval: 1 });
    assert.equal(result.completed, true, "resumed run completes normally");
    assert.equal(spawnCount(), 1, "resume spawns exactly once");

    assert.equal(verifyCalls.length, 1, "verifyDeliveryFn called exactly once on resume");
    assert.equal(verifyCalls[0].opts.timeoutMs, 700000,
      "resumed run forwards the persisted per-command execution budget to the verifier");
    const { readTranscript } = await import("../../src/transcript.js");
    const events = await readTranscript(join(runDir, `${runId}.jsonl`));
    const created = events.find((e) => e.type === "run.delivery_created");
    assert.ok(created, "resumed run packages + writes delivery_created");
    assert.equal(created.delivery.verification.verificationTimeoutMs, 700000,
      "created ref persists the timeout on the resumed path too");
  } finally {
    cleanupDir(dir);
  }
});

test("VT-08: malformed persisted verificationTimeoutMs → resume REFUSES with zero side effects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-vt08-"));
  try {
    makeGitRepo(dir);
    const runId = "run_vt08";
    const wt = makeWorktree(dir, `wao/${runId}`);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const runDir = join(dir, "runs");
    const tPath = join(runDir, `${runId}.jsonl`);
    writeTranscript(runDir, runId, [
      jl({ type: "run.started", backend: "claude-code", cwd: dir, worktreePath: wt.path, worktreeBranch: wt.branch, delivery: { mode: "git_commit_v1", baseCommit: wt.baseCommit, allowedPaths: ["src"], verificationCommands: ["echo ok"], verificationTimeoutMs: "300000" }, ts: "2026-08-05T00:00:00.000Z", runId, agentId: "coder_low", seq: 1 }),
      jl({ type: "session.created", backend: "claude-code", backendSessionId: "s1", ts: "2026-08-05T00:00:00.200Z", runId, agentId: "coder_low", seq: 2 }),
      jl({ type: "prompt.sent", prompt: "do it", ts: "2026-08-05T00:00:00.300Z", runId, agentId: "coder_low", seq: 3 }),
      jl({ type: "run.state_change", from: "pending", to: "submitted", reason: "spawned", ts: "2026-08-05T00:00:00.400Z", runId, agentId: "coder_low", seq: 4 }),
    ]);
    const bytesBefore = readFileSync(tPath, "utf8").length;
    const worktreesBefore = git(["worktree", "list"], dir).split("\n").filter(Boolean).length;

    const { RunManager } = await import("../../src/runManager.js");
    const { backend, spawnCount } = makeBackend({ spawnThrows: true });
    const manager = new RunManager({
      config: { registry: registryPath, runDir, defaultIsolation: "none" },
      readRegistry: async () => {
        const { readRegistry } = await import("../../src/registry.js");
        return readRegistry(registryPath);
      },
      transcriptDir: runDir,
      backendFor: () => backend,
      userEnvReader: async () => ({}),
    });

    const resumed = await manager.resume(runId, { runDir, registry: registryPath });
    assert.equal(resumed, null, "malformed persisted verificationTimeoutMs must make resume refuse (null)");

    assert.equal(readFileSync(tPath, "utf8").length, bytesBefore, "transcript bytes unchanged (no append)");
    assert.equal(git(["worktree", "list"], dir).split("\n").filter(Boolean).length, worktreesBefore,
      "worktree inventory unchanged (no mutation)");
    assert.equal(spawnCount(), 0, "zero spawn/attach");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// E. Forwarding: MCP run_dispatch (inline + execution-profile fold)
// =====================================================================

test("VT-09: MCP run_dispatch forwards verificationTimeoutMs (inline delivery)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-vt09-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const { createWaoMcpServer } = await import("../../src/mcp/server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

    let captured = null;
    const server = createWaoMcpServer({
      registryPath,
      runDir: "/server/runs",
      workspaceRoot: dir,
      dispatchRunFn: async (input) => { captured = input; return { accepted: true, runId: "run_vt09", state: "pending" }; },
    });
    const client = new Client({ name: "wao-test", version: "0.0.1" }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      await client.callTool({
        name: "run_dispatch",
        arguments: {
          agentId: "coder_low", prompt: "p",
          delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"], verificationTimeoutMs: 600000 },
        },
      });
      assert.ok(captured, "dispatcher called");
      assert.equal(captured.delivery.verificationTimeoutMs, 600000,
        "MCP run_dispatch forwards verificationTimeoutMs to the dispatcher");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("VT-10: MCP run_dispatch profile fold PRESERVES verificationTimeoutMs (profile supplies only commands)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-vt10-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const { createWaoMcpServer } = await import("../../src/mcp/server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

    let captured = null;
    const server = createWaoMcpServer({
      registryPath,
      runDir: "/server/runs",
      workspaceRoot: dir,
      dispatchRunFn: async (input) => { captured = input; return { accepted: true, runId: "run_vt10", state: "pending" }; },
    });
    const client = new Client({ name: "wao-test", version: "0.0.1" }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      await client.callTool({
        name: "run_dispatch",
        arguments: {
          agentId: "coder_low", prompt: "p",
          executionProfileId: "node-npm-test-v1",
          delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationTimeoutMs: 600000 },
        },
      });
      assert.ok(captured, "dispatcher called");
      assert.equal(captured.delivery.verificationCommands.join(" "), "npm test",
        "profile still supplies the verification commands");
      assert.equal(captured.delivery.verificationTimeoutMs, 600000,
        "profile fold must NOT drop the declared per-command execution timeout");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// F. Forwarding: CLI dispatchRun --delivery-json payload
// =====================================================================

test("VT-11: dispatchRun --delivery-json carries verificationTimeoutMs when declared, omits it when absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-vt11-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    makeGitRepo(repo);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: repo } });
    const { dispatchRun } = await import("../../src/application/runDispatch.js");
    const calls = [];
    const fakeSpawn = (cmd, args) => { calls.push({ cmd, args }); return { unref() {} }; };
    const runDir = join(dir, "runs");

    // Declared → the runner argv delivery JSON carries it.
    await dispatchRun({
      agentId: "coder_low",
      prompt: "p",
      registryPath,
      runDir,
      cwd: repo,
      delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"], verificationTimeoutMs: 600000 },
      spawnFn: fakeSpawn,
    });
    const argv = calls[0].args;
    const i = argv.indexOf("--delivery-json");
    assert.ok(i >= 0, "--delivery-json present");
    const payload = JSON.parse(argv[i + 1]);
    assert.equal(payload.verificationTimeoutMs, 600000, "CLI delivery JSON forwards verificationTimeoutMs");

    // Absent → zero drift on the wire payload.
    calls.length = 0;
    await dispatchRun({
      agentId: "coder_low",
      prompt: "p",
      registryPath,
      runDir,
      cwd: repo,
      delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"] },
      spawnFn: fakeSpawn,
    });
    const argv2 = calls[0].args;
    const i2 = argv2.indexOf("--delivery-json");
    const payload2 = JSON.parse(argv2[i2 + 1]);
    assert.equal(Object.prototype.hasOwnProperty.call(payload2, "verificationTimeoutMs"), false,
      "absent → delivery JSON stays byte-identical (zero drift)");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// G. Reverify: omitted timeout inherits the persisted value; explicit value
//    satisfies the shared bounds on the wire; malformed persisted refuses
// =====================================================================

test("VT-12: runDeliveryReverify — omitted timeoutMs inherits the persisted per-command budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-vt12-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    makeGitRepo(repo);
    const runId = "run_vt12";
    const wt = makeWorktree(repo, `wao/${runId}`);
    const runDir = join(dir, "runs");
    writeFileSync(join(wt.path, "src.js"), "const x = 2;\n", "utf8");

    const { resolveDeliveryCommit } = await import("../../src/delivery.js");
    const { ref: deliveryRef } = resolveDeliveryCommit({
      runId,
      worktreePath: wt.path,
      baseCommit: wt.baseCommit,
      isolation: { type: "worktree", strategy: "persistent" },
      allowedPaths: ["src.js"],
      verificationCommands: ["echo ok"],
      verificationTimeoutMs: 700000,
    });
    const deliveryCommit = deliveryRef.deliveryCommit;
    const originalRef = {
      ...deliveryRef,
      verification: {
        ...deliveryRef.verification,
        status: "failed",
        failureCode: "command_failed",
        verifiedCommit: deliveryCommit,
        results: [],
      },
    };
    writeTranscript(runDir, runId, [
      jl({ type: "run.background_submitted", cwd: repo, deliveryRequested: true, runId, agentId: "coder_low", seq: 1 }),
      jl({ type: "run.started", backend: "test", cwd: repo, worktreePath: wt.path, worktreeBranch: wt.branch, delivery: { mode: "git_commit_v1", baseCommit: wt.baseCommit, allowedPaths: ["src.js"], verificationCommands: ["echo ok"], verificationTimeoutMs: 700000 }, runId, agentId: "coder_low", seq: 2 }),
      jl({ type: "run.delivery_created", delivery: deliveryRef, deliveryCommit, runId, agentId: "coder_low", seq: 3 }),
      jl({ type: "run.completed", runId, agentId: "coder_low", seq: 4 }),
      jl({ type: "run.state_change", from: "running", to: "completed", reason: "completed", runId, agentId: "coder_low", seq: 5 }),
      jl({ type: "run.delivery_verification_failed", delivery: originalRef, deliveryCommit, runId, agentId: "coder_low", seq: 6 }),
    ]);

    const { runDeliveryReverify } = await import("../../src/application/runDeliveryReverify.js");
    const verifyCalls = [];
    // timeoutMs OMITTED → must inherit the persisted 700000.
    const res = await runDeliveryReverify({
      runId,
      runDir,
      authorizedWorkspaceRoot: repo,
      reason: "tooling_invalid",
      verifyDeliveryFn: async (ref, opts) => {
        verifyCalls.push(opts);
        return {
          delivery: {
            ...ref,
            verification: {
              ...ref.verification,
              status: "passed",
              verifiedCommit: ref.deliveryCommit,
              results: [],
            },
          },
          outcome: "passed",
          failureCode: undefined,
        };
      },
    });
    assert.equal(res.verificationStatus, "passed");
    assert.equal(verifyCalls.length, 1);
    assert.equal(verifyCalls[0].timeoutMs, 700000,
      "omitted reverify timeoutMs inherits the persisted per-command execution budget");
  } finally {
    cleanupDir(dir);
  }
});

test("VT-13: runDeliveryReverify — explicit timeoutMs overrides; malformed persisted value refuses BEFORE verify/append", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-vt13-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    makeGitRepo(repo);
    const runId = "run_vt13";
    const wt = makeWorktree(repo, `wao/${runId}`);
    const runDir = join(dir, "runs");
    writeFileSync(join(wt.path, "src.js"), "const x = 3;\n", "utf8");

    const { resolveDeliveryCommit } = await import("../../src/delivery.js");
    const { ref: deliveryRef } = resolveDeliveryCommit({
      runId,
      worktreePath: wt.path,
      baseCommit: wt.baseCommit,
      isolation: { type: "worktree", strategy: "persistent" },
      allowedPaths: ["src.js"],
      verificationCommands: ["echo ok"],
      verificationTimeoutMs: 700000,
    });
    const deliveryCommit = deliveryRef.deliveryCommit;
    const originalRef = {
      ...deliveryRef,
      verification: {
        ...deliveryRef.verification,
        status: "failed",
        failureCode: "command_failed",
        verifiedCommit: deliveryCommit,
        results: [],
      },
    };
    const seedLines = [
      jl({ type: "run.background_submitted", cwd: repo, deliveryRequested: true, runId, agentId: "coder_low", seq: 1 }),
      jl({ type: "run.started", backend: "test", cwd: repo, worktreePath: wt.path, worktreeBranch: wt.branch, delivery: { mode: "git_commit_v1", baseCommit: wt.baseCommit, allowedPaths: ["src.js"], verificationCommands: ["echo ok"], verificationTimeoutMs: 700000 }, runId, agentId: "coder_low", seq: 2 }),
      jl({ type: "run.delivery_created", delivery: deliveryRef, deliveryCommit, runId, agentId: "coder_low", seq: 3 }),
      jl({ type: "run.completed", runId, agentId: "coder_low", seq: 4 }),
      jl({ type: "run.state_change", from: "running", to: "completed", reason: "completed", runId, agentId: "coder_low", seq: 5 }),
      jl({ type: "run.delivery_verification_failed", delivery: originalRef, deliveryCommit, runId, agentId: "coder_low", seq: 6 }),
    ];
    writeTranscript(runDir, runId, seedLines);

    const { runDeliveryReverify } = await import("../../src/application/runDeliveryReverify.js");

    // Explicit timeoutMs overrides the persisted value.
    const verifyCalls = [];
    const res = await runDeliveryReverify({
      runId,
      runDir,
      authorizedWorkspaceRoot: repo,
      reason: "tooling_invalid",
      timeoutMs: 123456,
      verifyDeliveryFn: async (ref, opts) => {
        verifyCalls.push(opts);
        return {
          delivery: {
            ...ref,
            verification: {
              ...ref.verification,
              status: "passed",
              verifiedCommit: ref.deliveryCommit,
              results: [],
            },
          },
          outcome: "passed",
          failureCode: undefined,
        };
      },
    });
    assert.equal(res.verificationStatus, "passed");
    assert.equal(verifyCalls[0].timeoutMs, 123456, "explicit timeoutMs overrides the persisted budget");

    // Malformed persisted value + omitted timeoutMs → fail closed BEFORE any
    // verify or transcript append.
    const tPath = join(runDir, `${runId}.jsonl`);
    writeTranscript(runDir, runId, seedLines.map((l) =>
      l.replace('"verificationTimeoutMs":700000', '"verificationTimeoutMs":"oops"'),
    ));
    const bytesBefore = readFileSync(tPath, "utf8").length;
    const verifyCalls2 = [];
    await assert.rejects(
      () => runDeliveryReverify({
        runId,
        runDir,
        authorizedWorkspaceRoot: repo,
        reason: "tooling_invalid",
        verifyDeliveryFn: async (ref, opts) => { verifyCalls2.push(opts); return { delivery: ref, outcome: "passed", failureCode: undefined }; },
      }),
      /verificationTimeoutMs|integer/i,
      "malformed persisted budget must refuse reverify (fail closed)",
    );
    assert.equal(verifyCalls2.length, 0, "verifier never called on malformed persisted budget");
    assert.equal(readFileSync(tPath, "utf8").length, bytesBefore, "transcript bytes unchanged (no request append)");
  } finally {
    cleanupDir(dir);
  }
});

test("VT-14: MCP run_delivery_reverify schema accepts the shared upper bound and rejects above it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-vt14-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const { createWaoMcpServer } = await import("../../src/mcp/server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

    let captured = null;
    let calls = 0;
    const server = createWaoMcpServer({
      registryPath,
      runDir: dir,
      workspaceRoot: dir,
      runDeliveryReverifyFn: async (input) => {
        calls += 1; captured = input;
        return {
          runId: input.runId,
          deliveryCommit: "d".repeat(40),
          state: "created",
          reason: input.reason,
          verificationStatus: "passed",
          failureCode: null,
          requested: true,
          outcomeRecorded: true,
        };
      },
    });
    const client = new Client({ name: "wao-test", version: "0.0.1" }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      // Shared upper bound accepted at the schema and forwarded.
      const res = await client.callTool({
        name: "run_delivery_reverify",
        arguments: { runId: "run_x", reason: "tooling_invalid", timeoutMs: 7200000 },
      });
      assert.ok(res && !res.isError, "shared upper bound accepted by the schema");
      assert.equal(calls, 1, "service called once");
      assert.equal(captured.timeoutMs, 7200000, "wire forwards the shared upper bound");

      // Above the shared bound rejected at the schema (service never called).
      calls = 0;
      let rejected = false;
      try {
        const r2 = await client.callTool({
          name: "run_delivery_reverify",
          arguments: { runId: "run_x", reason: "tooling_invalid", timeoutMs: 7200001 },
        });
        if (r2?.isError) rejected = true;
      } catch { rejected = true; }
      assert.ok(rejected, "7200001 must be rejected by the schema");
      assert.equal(calls, 0, "service never called for out-of-bounds timeoutMs");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});
