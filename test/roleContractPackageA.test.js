// test/roleContractPackageA.test.js
//
// M11-5 Package A (CTO rework): trust/runtime closure — behavioral tests.
//
// These tests drive the REAL RunManager.start / .resume with a fake backend
// to prove (1) opencode-serve fail-closed, (2) systemPrompt type validation,
// (3) Claude TOCTOU elimination, (4) no-RunManager gap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { RunManager } from "../src/runManager.js";
import { readRegistry, normalizeAgent } from "../src/registry.js";

// ===== Helpers =====

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function makeRoleFile(dir, name, content) {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

function makeRegistry(dir, agents) {
  const p = join(dir, "agents.json");
  writeFileSync(p, JSON.stringify({ agents }, null, 2), "utf8");
  return p;
}

// A fake backend that records what it received and returns a minimal handle.
// supportsRoleContract defaults to false (fail-safe); tests that exercise the
// supported-injection path pass true explicitly.
function makeFakeBackend({ sessionOutlivesProcess = false, supportsRoleContract = false, recordSpawn = null } = {}) {
  const calls = [];
  const backend = {
    sessionOutlivesProcess,
    supportsRoleContract,
    spawn: async (agent, task) => {
      const entry = {
        agentId: agent?.agentId ?? agent?.id,
        prompt: task?.prompt,
        roleContract: task?.roleContract,
        roleContractPath: task?.roleContractPath,
      };
      calls.push(entry);
      if (recordSpawn) recordSpawn(entry);
      return {
        backend: "fake",
        backendSessionId: `fake_${Date.now()}`,
        messageId: "m1",
        admittedSeq: 1,
        events: async () => { const items = []; return items; },
      };
    },
  };
  return { backend, calls };
}

// A RunManager wired to a fake backend + tmpdir transcript dir.
function makeManager({ runDir, registryPath, backend }) {
  return new RunManager({
    config: { registry: registryPath, runDir },
    readRegistry,
    backendFor: () => backend,
  });
}

// ===== RED-1: opencode-serve + systemPrompt must fail closed =====

test("M11-5-A-RED1: opencode-serve + systemPrompt must fail closed before spawn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a-red1-"));
  try {
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    const rolePath = makeRoleFile(dir, "role.md", "ROLE_OP_ENCODE");
    const registryPath = makeRegistry(dir, {
      coder: {
        backend: "opencode-serve",
        cwd: dir,
        serveUrl: "http://127.0.0.1:4298",
        model: { providerID: "test", id: "test-model" },
        systemPrompt: rolePath,
      },
    });
    const { backend, calls } = makeFakeBackend();
    const mgr = makeManager({ runDir, registryPath, backend });
    let threw = false;
    try {
      await mgr.start("coder", { prompt: "do task", runDir, registry: registryPath });
    } catch (e) {
      threw = true;
      assert.match(e.message, /systemPrompt|role contract|opencode/i,
        "error must mention systemPrompt/role/opencode");
    }
    assert.ok(threw, "opencode-serve + systemPrompt must throw");
    assert.equal(calls.length, 0, "zero spawn calls");
    // Zero transcript (no jsonl file created).
    const jsonlFiles = existsSync(runDir) ? readdirSync(runDir).filter(f => f.endsWith(".jsonl")) : [];
    assert.equal(jsonlFiles.length, 0, "zero transcript files");
  } finally {
    cleanupDir(dir);
  }
});

// ===== RED-2: systemPrompt:0 must be rejected at normalizeAgent =====

test("M11-5-A-RED2: systemPrompt must be a non-empty trimmed string (reject 0, {}, [], false)", () => {
  for (const bad of [0, {}, [], false, 42, "   "]) {
    assert.throws(
      () => normalizeAgent("bad", { backend: "claude-code", cwd: "/x", systemPrompt: bad }),
      /systemPrompt/i,
      `systemPrompt=${JSON.stringify(bad)} must be rejected`,
    );
  }
  // Valid: non-empty string.
  assert.doesNotThrow(() => normalizeAgent("ok", { backend: "claude-code", cwd: "/x", systemPrompt: "config/roles/x.md" }));
  // M11-5 Package A2: only absent-attribute is "no role". null is now rejected.
  assert.doesNotThrow(() => normalizeAgent("ok", { backend: "claude-code", cwd: "/x" }));
  assert.throws(() => normalizeAgent("ok", { backend: "claude-code", cwd: "/x", systemPrompt: null }), /systemPrompt/i);
});

// ===== RED-3: Claude TOCTOU — content, not path =====

test("M11-5-A-RED3: Claude backend receives roleContract content, not roleContractPath", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a-red3-"));
  try {
    const rolePath = makeRoleFile(dir, "role.md", "ROLE_A");
    // Import claude backend and check buildArgs uses roleContract (content) not roleContractPath.
    const { ClaudeCodeBackend } = await import("../src/backends/claudeCode.js");
    const b = new ClaudeCodeBackend();
    const args = b.buildArgs({ cwd: dir }, {
      prompt: "task",
      roleContract: "ROLE_A",
    });
    // Must NOT use --append-system-prompt-file (path-based, TOCTOU).
    assert.ok(!args.includes("--append-system-prompt-file"),
      "claude must not use path-based --append-system-prompt-file");
    // Must use --append-system-prompt <content>.
    const flagIdx = args.indexOf("--append-system-prompt");
    assert.ok(flagIdx >= 0, "has --append-system-prompt <content>");
    assert.ok(args[flagIdx + 1]?.includes("ROLE_A"), "flag value carries role content");
    // No roleContractPath in the task contract at all.
    assert.ok(args.every(a => typeof a !== "string" || !a.includes(rolePath)),
      "no file path leak into args");
  } finally {
    cleanupDir(dir);
  }
});

// ===== RED-4: RunManager.start behavioral tests =====

test("M11-5-A-RED4a: RunManager.start passes roleContract to backend spawn (behavioral)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a-red4a-"));
  try {
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    const rolePath = makeRoleFile(dir, "role.md", "ROLE_BEHAVIORAL");
    const registryPath = makeRegistry(dir, {
      coder: { backend: "claude-code", cwd: dir, systemPrompt: rolePath },
    });
    const { backend, calls } = makeFakeBackend({ supportsRoleContract: true });
    const mgr = makeManager({ runDir, registryPath, backend });
    await mgr.start("coder", { prompt: "do task", runDir, registry: registryPath });
    assert.ok(calls.length >= 1, "spawn was called");
    assert.equal(calls[0].roleContract, "ROLE_BEHAVIORAL",
      "backend received the role content");
    // Transcript must NOT contain role body.
    const transcriptPath = join(runDir, `${calls[0].agentId ? "" : ""}`);
    const jsonlFiles = readdirSync(runDir).filter(f => f.endsWith(".jsonl"));
    assert.ok(jsonlFiles.length >= 1, "transcript created");
    const content = readFileSync(join(runDir, jsonlFiles[0]), "utf8");
    assert.ok(!content.includes("ROLE_BEHAVIORAL"), "role body zero-leaked to transcript");
  } finally {
    cleanupDir(dir);
  }
});

test("M11-5-A-RED4b: RunManager.start with missing role file → zero spawn, zero transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a-red4b-"));
  try {
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    const registryPath = makeRegistry(dir, {
      coder: { backend: "claude-code", cwd: dir, systemPrompt: join(dir, "missing.md") },
    });
    const { backend, calls } = makeFakeBackend({ supportsRoleContract: true });
    const mgr = makeManager({ runDir, registryPath, backend });
    let threw = false;
    try {
      await mgr.start("coder", { prompt: "do task", runDir, registry: registryPath });
    } catch {
      threw = true;
    }
    assert.ok(threw, "missing role file must throw");
    assert.equal(calls.length, 0, "zero spawn");
    // runs dir should be empty (no transcript written).
    const jsonlFiles = readdirSync(runDir).filter(f => f.endsWith(".jsonl"));
    assert.equal(jsonlFiles.length, 0, "zero transcript");
  } finally {
    cleanupDir(dir);
  }
});

test("M11-5-A-RED4c: no systemPrompt → legacy byte-compatible (no roleContract, no roleContractPath)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a-red4c-"));
  try {
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    const registryPath = makeRegistry(dir, {
      coder: { backend: "claude-code", cwd: dir },
    });
    const { backend, calls } = makeFakeBackend();
    const mgr = makeManager({ runDir, registryPath, backend });
    await mgr.start("coder", { prompt: "do task", runDir, registry: registryPath });
    assert.ok(calls.length >= 1, "spawn was called");
    assert.equal(calls[0].roleContract, undefined, "no roleContract when systemPrompt absent");
    assert.equal(calls[0].roleContractPath, undefined, "no roleContractPath when systemPrompt absent");
  } finally {
    cleanupDir(dir);
  }
});
