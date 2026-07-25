// test/m11-8c-closeout.test.js
//
// M11-8C CTO closeout: four real gaps from the verdict on a021e56.
//   Gap A: delivery resume did NOT inject the Delivery Execution Contract — a
//          resumed delivery worker could self-commit again.
//   Gap B: run_diagnose classified on ANY run.delivery_failed, not one bound to
//          the requested runId — another run's event could pollute the diagnosis.
//   Gap C: packaging failure codes existed in TWO places (application + MCP);
//          they will drift. Plus an inaccurate comment claimed a superRefine/
//          discriminated schema "auto-guarantees" mutual exclusivity.
//   Gap D: no production-behavior test that a real supportsRoleContract=false
//          delivery dispatch is rejected before side effects.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n", "utf8");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m init", { cwd: dir, stdio: "pipe" });
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function ev(obj) {
  return JSON.stringify(obj) + "\n";
}

function writeTranscript(dir, runId, lines) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.jsonl`), lines, "utf8");
}

async function buildClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-test-client", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

function makeRegistry(dir, agents) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return registryPath;
}

/**
 * Create a real linked git worktree off `repo` so resume's proveLinkedWorktree
 * passes. Returns { path, branch, baseCommit }.
 */
function makeWorktree(repo, branch) {
  const wtPath = join(repo, ".wt-" + branch);
  execSync(`git worktree add "${wtPath}" -b ${branch}`, { cwd: repo, stdio: "pipe" });
  const baseCommit = execSync("git rev-parse HEAD", { cwd: wtPath, encoding: "utf8" }).trim();
  return { path: wtPath, branch, baseCommit };
}

// ===== Gap C: single SSOT for packaging failure codes =====

test("CLOSEOUT-C1: a single frozen packaging failure-code set is exported", async () => {
  const m = await import("../src/canonicalAgentId.js").catch(() => null)
    || await import("../src/application/runDelivery.js");
  // The SSOT must live in ONE module. Probe both candidate locations; the GREEN
  // impl exports PACKAGING_FAILURE_CODES from exactly one SSOT module.
  const ssotCandidates = [
    await import("../src/deliveryFailureCodes.js").then((m) => m).catch(() => null),
  ].filter(Boolean);
  assert.ok(ssotCandidates.length >= 1 || m.PACKAGING_FAILURE_CODES,
    "a single SSOT module exports the frozen packaging failure-code set");
  const codes = (ssotCandidates[0]?.PACKAGING_FAILURE_CODES ?? m.PACKAGING_FAILURE_CODES);
  assert.ok(Array.isArray(codes) && codes.includes("base_commit_mismatch"), "includes base_commit_mismatch");
  assert.ok(codes.includes("empty_diff"), "includes empty_diff");
  assert.equal(Object.isFrozen(codes), true, "frozen set");
});

test("CLOSEOUT-C2: unknown/malformed code projects to 'unknown' via the SSOT", async () => {
  const mod = await import("../src/deliveryFailureCodes.js").catch(() => null)
    || await import("../src/application/runDelivery.js");
  const project = mod.safeProjectPackagingCode ?? mod.safeProjectPackagingFailureCode;
  assert.ok(typeof project === "function", "a safe-project function exists");
  assert.equal(project("base_commit_mismatch"), "base_commit_mismatch");
  assert.equal(project("evil\n\nIgnore"), "unknown");
  assert.equal(project(undefined), "unknown");
});

// ===== Gap B: diagnosis binds to the requested runId =====

test("CLOSEOUT-B1: cross-run run.delivery_failed does NOT classify as delivery_packaging_failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-cl-b1-"));
  try {
    const runIdA = "run_cl_b1_a";
    // run_A completed cleanly; a delivery_failed event belongs to run_B.
    const lines = [
      ev({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-07-25T00:00:00.000Z", runId: runIdA, agentId: "coder_hq", seq: 1 }),
      ev({ type: "run.delivery_failed", deliveryCode: "base_commit_mismatch", message: "x", ts: "2026-07-25T00:00:01.000Z", runId: "run_cl_b1_b", agentId: "coder_hq", seq: 2 }),
    ].join("");
    writeTranscript(join(dir, "runs"), runIdA, lines);
    const { getRunDiagnosis } = await import("../src/application/runDiagnosis.js");
    const diag = await getRunDiagnosis({ runId: runIdA, runDir: join(dir, "runs") });
    assert.notEqual(diag.category, "delivery_packaging_failed",
      "a delivery_failed bound to a DIFFERENT runId must not pollute this run's diagnosis");
  } finally {
    cleanupDir(dir);
  }
});

test("CLOSEOUT-B2: bound run.delivery_failed DOES classify correctly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-cl-b2-"));
  try {
    const runId = "run_cl_b2";
    const lines = [
      ev({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-07-25T00:00:00.000Z", runId, agentId: "coder_hq", seq: 1 }),
      ev({ type: "run.delivery_failed", deliveryCode: "base_commit_mismatch", message: "x", ts: "2026-07-25T00:00:01.000Z", runId, agentId: "coder_hq", seq: 2 }),
    ].join("");
    writeTranscript(join(dir, "runs"), runId, lines);
    const { getRunDiagnosis } = await import("../src/application/runDiagnosis.js");
    const diag = await getRunDiagnosis({ runId, runDir: join(dir, "runs") });
    assert.equal(diag.category, "delivery_packaging_failed", "bound event classifies correctly");
  } finally {
    cleanupDir(dir);
  }
});

// ===== Gap A: delivery resume injects the contract =====

test("CLOSEOUT-A1: delivery resume injects the delivery contract even WITHOUT systemPrompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-cl-a1-"));
  try {
    makeGitRepo(dir);
    const runId = "run_cl_a1";
    // Real linked worktree so resume's proveLinkedWorktree passes.
    const wt = makeWorktree(dir, `wao/${runId}`);
    const lines = [
      ev({ type: "run.started", backend: "claude-code", cwd: dir, worktreePath: wt.path, worktreeBranch: wt.branch, delivery: { mode: "git_commit_v1", baseCommit: wt.baseCommit, allowedPaths: ["src"], verificationCommands: ["echo ok"], scorecardRules: { requireEvidence: true, mode: "warn" } }, scorecardConfigured: true, ts: "2026-07-25T00:00:00.000Z", runId, agentId: "coder_low", seq: 1 }),
      ev({ type: "session.created", backend: "claude-code", backendSessionId: "s1", serveUrl: undefined, ts: "2026-07-25T00:00:00.200Z", runId, agentId: "coder_low", seq: 2 }),
      ev({ type: "prompt.sent", prompt: "Final commit SHA please", ts: "2026-07-25T00:00:00.300Z", runId, agentId: "coder_low", seq: 3 }),
      ev({ type: "run.state_change", from: "pending", to: "submitted", reason: "spawned", ts: "2026-07-25T00:00:00.400Z", runId, agentId: "coder_low", seq: 4 }),
    ].join("");
    writeTranscript(join(dir, "runs"), runId, lines);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });

    const { RunManager } = await import("../src/runManager.js");
    let capturedTask = null;
    let spawnCount = 0;
    const fakeBackend = {
      supportsRoleContract: true, sessionOutlivesProcess: false,
      async spawn(agent, task) {
        spawnCount += 1;
        capturedTask = task;
        return { backend: "claude-code", backendSessionId: "s2", messageId: "m1", admittedSeq: 5,
          async *events() { yield { kind: "done", reason: "completed" }; },
          abort: async () => {} };
      },
      defaultBinary() { return "claude"; },
      credentialEnvNames: () => [],
    };
    const manager = new RunManager({
      config: { registry: registryPath, runDir: join(dir, "runs"), defaultIsolation: "none" },
      readRegistry: async () => { const { readRegistry } = await import("../src/registry.js"); return readRegistry(registryPath); },
      transcriptDir: join(dir, "runs"),
      backendFor: () => fakeBackend,
      userEnvReader: async () => ({}),
    });
    const resumed = await manager.resume(runId, { runDir: join(dir, "runs"), registry: registryPath });
    assert.ok(resumed, "resume returned a Run");
    try { await resumed.waitForCompletion({ pollInterval: 1 }); } catch { /* tolerate */ }

    assert.equal(spawnCount, 1, "spawn called exactly once on resume");
    assert.ok(capturedTask.roleContract, "roleContract set on resume in delivery mode (no systemPrompt)");
    assert.match(capturedTask.roleContract, /git add/i, "delivery contract forbids git add on resume");
    assert.match(capturedTask.roleContract, /commit SHA|final commit|do not.*SHA/i,
      "delivery contract forbids reporting a final commit SHA on resume");
  } finally {
    cleanupDir(dir);
  }
});

test("CLOSEOUT-A2: delivery resume WITH systemPrompt composes delivery contract + role once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-cl-a2-"));
  try {
    makeGitRepo(dir);
    mkdirSync(join(REPO_ROOT, "config", "roles"), { recursive: true });
    const rolePath = "config/roles/_m118c_cl_role.md";
    writeFileSync(join(REPO_ROOT, rolePath), "# Coder\nWrite tested code.\n", "utf8");
    const runId = "run_cl_a2";
    const wt = makeWorktree(dir, `wao/${runId}`);
    const lines = [
      ev({ type: "run.started", backend: "claude-code", cwd: dir, worktreePath: wt.path, worktreeBranch: wt.branch, delivery: { mode: "git_commit_v1", baseCommit: wt.baseCommit, allowedPaths: ["src"], verificationCommands: ["echo ok"], scorecardRules: { requireEvidence: true, mode: "warn" } }, scorecardConfigured: true, ts: "2026-07-25T00:00:00.000Z", runId, agentId: "_m118c_cl", seq: 1 }),
      ev({ type: "session.created", backend: "claude-code", backendSessionId: "s1", serveUrl: undefined, ts: "2026-07-25T00:00:00.200Z", runId, agentId: "_m118c_cl", seq: 2 }),
      ev({ type: "prompt.sent", prompt: "do it", ts: "2026-07-25T00:00:00.300Z", runId, agentId: "_m118c_cl", seq: 3 }),
      ev({ type: "run.state_change", from: "pending", to: "submitted", reason: "spawned", ts: "2026-07-25T00:00:00.400Z", runId, agentId: "_m118c_cl", seq: 4 }),
    ].join("");
    writeTranscript(join(dir, "runs"), runId, lines);
    const registryPath = makeRegistry(dir, { _m118c_cl: { backend: "claude-code", cwd: dir, systemPrompt: rolePath } });

    const { RunManager } = await import("../src/runManager.js");
    let capturedTask = null;
    const fakeBackend = {
      supportsRoleContract: true, sessionOutlivesProcess: false,
      async spawn(agent, task) { capturedTask = task; return { backend: "claude-code", backendSessionId: "s2", messageId: "m1", admittedSeq: 5, async *events() { yield { kind: "done", reason: "completed" }; }, abort: async () => {} }; },
      defaultBinary() { return "claude"; }, credentialEnvNames: () => [],
    };
    const manager = new RunManager({
      config: { registry: registryPath, runDir: join(dir, "runs"), defaultIsolation: "none" },
      readRegistry: async () => { const { readRegistry } = await import("../src/registry.js"); return readRegistry(registryPath); },
      transcriptDir: join(dir, "runs"), backendFor: () => fakeBackend, userEnvReader: async () => ({}),
    });
    const resumed = await manager.resume(runId, { runDir: join(dir, "runs"), registry: registryPath });
    try { await resumed.waitForCompletion({ pollInterval: 1 }); } catch { /* tolerate */ }

    assert.ok(capturedTask.roleContract, "composed roleContract set on resume");
    assert.match(capturedTask.roleContract, /git add/i, "delivery contract present on resume");
    assert.ok(capturedTask.roleContract.includes("Write tested code."), "role body present on resume");
    assert.ok(capturedTask.roleContract.indexOf("git add") < capturedTask.roleContract.indexOf("Write tested code."),
      "delivery contract precedes role body on resume");
  } finally {
    cleanupDir(dir);
    try { rmSync(join(REPO_ROOT, "config", "roles", "_m118c_cl_role.md"), { force: true }); } catch {}
  }
});

test("CLOSEOUT-A3: non-delivery resume has ZERO behavior change (no delivery contract)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-cl-a3-"));
  try {
    makeGitRepo(dir);
    const runId = "run_cl_a3";
    const lines = [
      ev({ type: "run.started", backend: "claude-code", cwd: dir, ts: "2026-07-25T00:00:00.000Z", runId, agentId: "coder_low", seq: 1 }),
      ev({ type: "session.created", backend: "claude-code", backendSessionId: "s1", serveUrl: undefined, ts: "2026-07-25T00:00:00.200Z", runId, agentId: "coder_low", seq: 2 }),
      ev({ type: "prompt.sent", prompt: "normal task", ts: "2026-07-25T00:00:00.300Z", runId, agentId: "coder_low", seq: 3 }),
      ev({ type: "run.state_change", from: "pending", to: "submitted", reason: "spawned", ts: "2026-07-25T00:00:00.400Z", runId, agentId: "coder_low", seq: 4 }),
    ].join("");
    writeTranscript(join(dir, "runs"), runId, lines);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });

    const { RunManager } = await import("../src/runManager.js");
    let capturedTask = null;
    const fakeBackend = {
      supportsRoleContract: true, sessionOutlivesProcess: false,
      async spawn(agent, task) { capturedTask = task; return { backend: "claude-code", backendSessionId: "s2", messageId: "m1", admittedSeq: 5, async *events() { yield { kind: "done", reason: "completed" }; }, abort: async () => {} }; },
      defaultBinary() { return "claude"; }, credentialEnvNames: () => [],
    };
    const manager = new RunManager({
      config: { registry: registryPath, runDir: join(dir, "runs"), defaultIsolation: "none" },
      readRegistry: async () => { const { readRegistry } = await import("../src/registry.js"); return readRegistry(registryPath); },
      transcriptDir: join(dir, "runs"), backendFor: () => fakeBackend, userEnvReader: async () => ({}),
    });
    const resumed = await manager.resume(runId, { runDir: join(dir, "runs"), registry: registryPath });
    try { await resumed.waitForCompletion({ pollInterval: 1 }); } catch { /* tolerate */ }

    assert.ok(capturedTask, "task received");
    // No systemPrompt + non-delivery → roleContract undefined (unchanged).
    assert.equal(capturedTask.roleContract, undefined, "non-delivery resume has no roleContract (unchanged)");
  } finally {
    cleanupDir(dir);
  }
});

test("CLOSEOUT-A4: unsupported backend on delivery resume fails closed, transcript bytes unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-cl-a4-"));
  try {
    makeGitRepo(dir);
    const runId = "run_cl_a4";
    const wt = makeWorktree(dir, `wao/${runId}`);
    const lines = [
      ev({ type: "run.started", backend: "claude-code", cwd: dir, worktreePath: wt.path, worktreeBranch: wt.branch, delivery: { mode: "git_commit_v1", baseCommit: wt.baseCommit, allowedPaths: ["src"], verificationCommands: ["echo ok"], scorecardRules: { requireEvidence: true, mode: "warn" } }, scorecardConfigured: true, ts: "2026-07-25T00:00:00.000Z", runId, agentId: "coder_low", seq: 1 }),
      ev({ type: "session.created", backend: "claude-code", backendSessionId: "s1", serveUrl: undefined, ts: "2026-07-25T00:00:00.200Z", runId, agentId: "coder_low", seq: 2 }),
      ev({ type: "prompt.sent", prompt: "do it", ts: "2026-07-25T00:00:00.300Z", runId, agentId: "coder_low", seq: 3 }),
      ev({ type: "run.state_change", from: "pending", to: "submitted", reason: "spawned", ts: "2026-07-25T00:00:00.400Z", runId, agentId: "coder_low", seq: 4 }),
    ].join("");
    const tPath = join(dir, "runs", `${runId}.jsonl`);
    writeTranscript(join(dir, "runs"), runId, lines);
    const bytesBefore = readFileSync(tPath, "utf8").length;
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });

    const { RunManager } = await import("../src/runManager.js");
    const fakeBackend = {
      supportsRoleContract: false, sessionOutlivesProcess: false,
      async spawn() { throw new Error("should not be called"); },
      defaultBinary() { return "claude"; }, credentialEnvNames: () => [],
    };
    const manager = new RunManager({
      config: { registry: registryPath, runDir: join(dir, "runs"), defaultIsolation: "none" },
      readRegistry: async () => { const { readRegistry } = await import("../src/registry.js"); return readRegistry(registryPath); },
      transcriptDir: join(dir, "runs"), backendFor: () => fakeBackend, userEnvReader: async () => ({}),
    });
    await assert.rejects(
      () => manager.resume(runId, { runDir: join(dir, "runs"), registry: registryPath }),
      /role contract injection|does not support/i,
      "delivery resume with unsupported backend fails closed",
    );
    const bytesAfter = readFileSync(tPath, "utf8").length;
    assert.equal(bytesAfter, bytesBefore, "transcript bytes unchanged (fail-closed before append/spawn)");
  } finally {
    cleanupDir(dir);
  }
});

// ===== Gap D: production-behavior test for supportsRoleContract=false delivery dispatch =====

test("CLOSEOUT-D: real supportsRoleContract=false delivery dispatch rejected before side effects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-cl-d-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const runDir = join(dir, "runs");

    const { RunManager } = await import("../src/runManager.js");
    // A backend that genuinely does NOT support role-contract injection — this is
    // the production-behavior case (not a test-fixture capability override).
    const fakeBackend = {
      supportsRoleContract: false, sessionOutlivesProcess: false,
      async spawn() { throw new Error("should not be called"); },
      defaultBinary() { return "claude"; }, credentialEnvNames: () => [],
    };
    const manager = new RunManager({
      config: { registry: registryPath, runDir, defaultIsolation: "none" },
      readRegistry: async () => { const { readRegistry } = await import("../src/registry.js"); return readRegistry(registryPath); },
      transcriptDir: runDir, backendFor: () => fakeBackend, userEnvReader: async () => ({}),
    });
    await assert.rejects(
      () => manager.start("coder_low", {
        prompt: "x", runDir, registry: registryPath, fireAndForget: false, isolate: true,
        delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"] },
      }),
      /role contract injection|does not support/i,
      "delivery dispatch with a genuinely-unsupported backend is rejected",
    );
    const jsonl = existsSync(runDir) ? readdirSync(runDir).filter((f) => f.endsWith(".jsonl")) : [];
    assert.equal(jsonl.length, 0, "zero transcript created (rejected before side effects)");
  } finally {
    cleanupDir(dir);
  }
});

// ===== Gap C (continued): real MCP shape — success/failure never mix =====

test("CLOSEOUT-C3: MCP run_delivery success and failure variants never mix shape", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-cl-c3-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_hq: { backend: "claude-code", cwd: dir } });
    const { createWaoMcpServer } = await import("../src/mcp/server.js");

    // Failure variant: delivery_failed bound to this run.
    const failRun = "run_cl_c3_fail";
    writeTranscript(join(dir, "runs"), failRun, [
      ev({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-07-25T00:00:00.000Z", runId: failRun, agentId: "coder_hq", seq: 1 }),
      ev({ type: "run.delivery_failed", deliveryCode: "base_commit_mismatch", message: "x", ts: "2026-07-25T00:00:01.000Z", runId: failRun, agentId: "coder_hq", seq: 2 }),
    ].join(""));

    // Success variant: a committed DeliveryRef.
    const base = "a".repeat(40);
    const dc = "b".repeat(40);
    const okRun = "run_cl_c3_ok";
    writeTranscript(join(dir, "runs"), okRun, [
      ev({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-07-25T00:00:00.000Z", runId: okRun, agentId: "coder_hq", seq: 1 }),
      ev({ type: "run.delivery_created", delivery: { schemaVersion: 1, kind: "git_commit", repoRoot: "/p", runId: okRun, baseCommit: base, deliveryCommit: dc, changedFiles: ["src/a.js"], verification: { status: "passed" } }, ts: "2026-07-25T00:00:01.000Z", runId: okRun, agentId: "coder_hq", seq: 2 }),
      ev({ type: "run.delivery_verification_passed", delivery: { schemaVersion: 1, kind: "git_commit", repoRoot: "/p", runId: okRun, baseCommit: base, deliveryCommit: dc, changedFiles: ["src/a.js"], verification: { status: "passed" } }, ts: "2026-07-25T00:00:02.000Z", runId: okRun, agentId: "coder_hq", seq: 3 }),
    ].join(""));

    const server = createWaoMcpServer({ registryPath, runDir: join(dir, "runs"), workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const failRes = await client.callTool({ name: "run_delivery", arguments: { runId: failRun } });
      assert.equal(failRes.structuredContent.deliveryAvailable, false, "failure variant");
      assert.equal(failRes.structuredContent.deliveryFailure.code, "base_commit_mismatch");
      // Failure variant must NOT carry success-only fields as non-null.
      assert.equal(failRes.structuredContent.baseCommit, null, "failure has null baseCommit");
      assert.equal(failRes.structuredContent.deliveryCommit, null, "failure has null deliveryCommit");

      const okRes = await client.callTool({ name: "run_delivery", arguments: { runId: okRun } });
      assert.equal(okRes.structuredContent.deliveryAvailable, true, "success variant");
      assert.equal(okRes.structuredContent.deliveryFailure, null, "success has null deliveryFailure");
      assert.equal(okRes.structuredContent.deliveryCommit, dc, "success carries deliveryCommit");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});
