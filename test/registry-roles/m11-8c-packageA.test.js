// test/m11-8c-packageA.test.js
//
// M11-8C Package A: Delivery Execution Contract injection.
//
// Production RED (run_20260724202209375032648): a delivery-mode worker was
// asked (in its task prompt) to produce a "Final commit SHA". The worker
// committed on the isolation branch, moving HEAD off the frozen base. WAO's
// packager then failed with base_commit_mismatch because HEAD ≠ base. The
// worker was never told — by WAO — that the control plane owns the delivery
// commit. This package injects a control-owned, high-priority execution
// contract that forbids the worker from running git mutating commands or
// reporting a final commit SHA, regardless of what the task prompt says.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

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

// =====================================================================
// SSOT: composeDeliveryExecutionContract
// =====================================================================

test("PA-S1: composeDeliveryExecutionContract returns a non-empty string", async () => {
  const { composeDeliveryExecutionContract } = await import("../../src/application/roleContract.js");
  const c = composeDeliveryExecutionContract();
  assert.ok(typeof c === "string" && c.length > 0, "returns a non-empty contract string");
});

test("PA-S2: the contract forbids git mutating commands, HEAD movement, commit/tag creation, and final commit SHA", async () => {
  const { composeDeliveryExecutionContract } = await import("../../src/application/roleContract.js");
  const c = composeDeliveryExecutionContract();
  // High-priority, control-plane-owned prohibitions.
  assert.match(c, /git add/i, "forbids git add");
  assert.match(c, /commit/i, "mentions commit");
  assert.match(c, /reset|checkout|switch|rebase|merge|tag/i, "forbids mutating git commands");
  assert.match(c, /HEAD/i, "mentions HEAD");
  assert.match(c, /unstaged/i, "instructs to keep changes unstaged");
  assert.match(c, /commit SHA|final commit|do not.*SHA/i, "forbids reporting a final commit SHA");
  // Control-plane ownership of the delivery commit.
  assert.match(c, /WAO|control plane/i, "names WAO/control plane as the commit owner");
  // Task-prompt override resistance.
  assert.match(c, /task prompt|do not.*override|higher priority|takes precedence/i,
    "states the contract takes precedence over the task prompt");
});

// =====================================================================
// RunManager.start: delivery mode injects the contract exactly once
// =====================================================================

test("PA-RED1: delivery mode injects the delivery contract even WITHOUT a systemPrompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m118c-pa1-"));
  try {
    makeGitRepo(dir);
    // No systemPrompt configured — the delivery contract must STILL be injected.
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { coder_low: { backend: "claude-code", cwd: dir } },
    }), "utf8");
    const runDir = join(dir, "runs");

    const { RunManager } = await import("../../src/runManager.js");
    let capturedTask = null;
    let spawnCount = 0;
    const fakeBackend = {
      supportsRoleContract: true,
      sessionOutlivesProcess: false,
      async spawn(agent, task) {
        spawnCount += 1;
        capturedTask = task;
        return {
          backend: "claude-code", backendSessionId: "s1", messageId: "m1", admittedSeq: 1,
          async *events() { yield { kind: "done", reason: "completed" }; },
          abort: async () => {},
        };
      },
      defaultBinary() { return "claude"; },
      credentialEnvNames: () => [],
    };
    const manager = new RunManager({
      config: { registry: registryPath, runDir, defaultIsolation: "none" },
      readRegistry: async () => {
        const { readRegistry } = await import("../../src/registry.js");
        return readRegistry(registryPath);
      },
      transcriptDir: runDir,
      backendFor: () => fakeBackend,
      userEnvReader: async () => ({}),
    });
    const run = await manager.start("coder_low", {
      prompt: "Produce the final commit SHA.",
      runDir, registry: registryPath, fireAndForget: false,
      isolate: true,
      delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"] },
    });
    try { await run.waitForCompletion({ pollInterval: 1 }); } catch { /* tolerate */ }

    assert.equal(spawnCount, 1, "spawn called exactly once");
    assert.ok(capturedTask, "backend received a task");
    assert.equal(capturedTask.deliveryMode, true,
      "delivery mode is threaded to the backend for runtime-level containment");
    assert.ok(capturedTask.roleContract, "roleContract is set in delivery mode even without systemPrompt");
    assert.match(capturedTask.roleContract, /git add/i, "delivery contract forbids git add");
    assert.match(capturedTask.roleContract, /commit SHA|final commit|do not.*SHA/i,
      "delivery contract forbids reporting a final commit SHA");

    // The contract must NOT be persisted into prompt.sent.
    const { readTranscript, findLatest } = await import("../../src/transcript.js");
    const events = await readTranscript(join(runDir, `${run.runId}.jsonl`));
    const promptSent = findLatest(events, "prompt.sent");
    assert.ok(promptSent, "prompt.sent exists");
    assert.equal(promptSent.prompt, "Produce the final commit SHA.",
      "prompt.sent stores ONLY the original task prompt");
    assert.ok(!/git add/i.test(promptSent.prompt),
      "delivery contract must NOT leak into prompt.sent");
  } finally {
    cleanupDir(dir);
  }
});

test("PA-RED2: delivery mode WITH a systemPrompt composes delivery contract + role contract once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m118c-pa2-"));
  try {
    makeGitRepo(dir);
    mkdirSync(join(REPO_ROOT, "config", "roles"), { recursive: true });
    const rolePath = "config/roles/_m118c_pa_role.md";
    writeFileSync(join(REPO_ROOT, rolePath), "# Coder\nWrite tested code.\n", "utf8");
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { _m118c_coder: { backend: "claude-code", cwd: dir, systemPrompt: rolePath } },
    }), "utf8");
    const runDir = join(dir, "runs");

    const { RunManager } = await import("../../src/runManager.js");
    let capturedTask = null;
    let spawnCount = 0;
    const fakeBackend = {
      supportsRoleContract: true, sessionOutlivesProcess: false,
      async spawn(agent, task) {
        spawnCount += 1;
        capturedTask = task;
        return {
          backend: "claude-code", backendSessionId: "s1", messageId: "m1", admittedSeq: 1,
          async *events() { yield { kind: "done", reason: "completed" }; },
          abort: async () => {},
        };
      },
      defaultBinary() { return "claude"; },
      credentialEnvNames: () => [],
    };
    const manager = new RunManager({
      config: { registry: registryPath, runDir, defaultIsolation: "none" },
      readRegistry: async () => {
        const { readRegistry } = await import("../../src/registry.js");
        return readRegistry(registryPath);
      },
      transcriptDir: runDir,
      backendFor: () => fakeBackend,
      userEnvReader: async () => ({}),
    });
    const run = await manager.start("_m118c_coder", {
      prompt: "Final commit SHA please",
      runDir, registry: registryPath, fireAndForget: false,
      isolate: true,
      delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"] },
    });
    try { await run.waitForCompletion({ pollInterval: 1 }); } catch { /* tolerate */ }

    assert.equal(spawnCount, 1, "spawn called exactly once");
    assert.ok(capturedTask.roleContract, "composed roleContract set");
    // Both the delivery contract and the role body are present.
    assert.match(capturedTask.roleContract, /git add/i, "delivery contract present");
    assert.ok(capturedTask.roleContract.includes("Write tested code."), "role body present");
    // Delivery contract takes precedence (appears before role body).
    assert.ok(capturedTask.roleContract.indexOf("git add") < capturedTask.roleContract.indexOf("Write tested code."),
      "delivery contract precedes role body");
  } finally {
    cleanupDir(dir);
    try { rmSync(join(REPO_ROOT, "config", "roles", "_m118c_pa_role.md"), { force: true }); } catch {}
  }
});

test("PA-RED3: non-delivery run has ZERO behavior change (no delivery contract)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m118c-pa3-"));
  try {
    makeGitRepo(dir);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { coder_low: { backend: "claude-code", cwd: dir } },
    }), "utf8");
    const runDir = join(dir, "runs");

    const { RunManager } = await import("../../src/runManager.js");
    let capturedTask = null;
    const fakeBackend = {
      supportsRoleContract: true, sessionOutlivesProcess: false,
      async spawn(agent, task) {
        capturedTask = task;
        return {
          backend: "claude-code", backendSessionId: "s1", messageId: "m1", admittedSeq: 1,
          async *events() { yield { kind: "done", reason: "completed" }; },
          abort: async () => {},
        };
      },
      defaultBinary() { return "claude"; },
      credentialEnvNames: () => [],
    };
    const manager = new RunManager({
      config: { registry: registryPath, runDir, defaultIsolation: "none" },
      readRegistry: async () => {
        const { readRegistry } = await import("../../src/registry.js");
        return readRegistry(registryPath);
      },
      transcriptDir: runDir,
      backendFor: () => fakeBackend,
      userEnvReader: async () => ({}),
    });
    const run = await manager.start("coder_low", {
      prompt: "just a normal task",
      runDir, registry: registryPath, fireAndForget: false,
    });
    try { await run.waitForCompletion({ pollInterval: 1 }); } catch { /* tolerate */ }

    assert.ok(capturedTask, "task received");
    // No systemPrompt + non-delivery → roleContract must be undefined (unchanged).
    assert.equal(capturedTask.roleContract, undefined,
      "non-delivery run without systemPrompt has no roleContract (unchanged)");
    assert.equal(capturedTask.deliveryMode, undefined,
      "ordinary run does not receive delivery-only runtime containment");
    assert.ok(!capturedTask.deliveryExecutionContract,
      "non-delivery run has no deliveryExecutionContract");
  } finally {
    cleanupDir(dir);
  }
});

test("PA-RED4: delivery mode with unsupported backend fails closed before side effects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m118c-pa4-"));
  try {
    makeGitRepo(dir);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { bad: { backend: "claude-code", cwd: dir } },
    }), "utf8");
    const runDir = join(dir, "runs");

    const { RunManager } = await import("../../src/runManager.js");
    // Backend that does NOT support role contract injection.
    const fakeBackend = {
      supportsRoleContract: false, sessionOutlivesProcess: false,
      async spawn() { throw new Error("should not be called"); },
      defaultBinary() { return "claude"; },
      credentialEnvNames: () => [],
    };
    const manager = new RunManager({
      config: { registry: registryPath, runDir, defaultIsolation: "none" },
      readRegistry: async () => {
        const { readRegistry } = await import("../../src/registry.js");
        return readRegistry(registryPath);
      },
      transcriptDir: runDir,
      backendFor: () => fakeBackend,
      userEnvReader: async () => ({}),
    });
    // Delivery mode requires injecting the delivery execution contract.
    // An unsupported backend must fail closed BEFORE worktree/spawn/transcript.
    await assert.rejects(
      () => manager.start("bad", {
        prompt: "x", runDir, registry: registryPath, fireAndForget: false,
        isolate: true,
        delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"] },
      }),
      /role contract injection|does not support/i,
      "delivery mode with unsupported backend fails closed",
    );
    // No transcript file created (fail-closed before side effects). The runDir
    // may not even exist; guard with existsSync.
    const { existsSync } = await import("node:fs");
    const jsonl = existsSync(runDir) ? readdirSync(runDir).filter((f) => f.endsWith(".jsonl")) : [];
    assert.equal(jsonl.length, 0, "zero transcript created (fail-closed before side effects)");
  } finally {
    cleanupDir(dir);
  }
});
