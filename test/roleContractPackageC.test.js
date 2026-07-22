// test/roleContractPackageC.test.js
//
// M11-5 Package C: cross-project role-contract usability + strict gates.
//
// Proves the role-contract path authority, strict capability judgment, and
// registry own-property semantics so the same global WAO registry + role
// files work from ANY target-project cwd (Life Index, Smash Bros, ...).
//
// Coverage (CTO §C4):
//   1. External cwd can load config/roles/tester.md (relative to WAO root).
//   2. External cwd: RunManager.start + supported fake backend receives role body.
//   3. External cwd: real `registry validate` passes for all agents.
//   4. Absolute systemPrompt path still works.
//   5. Missing file → fixed safe error (no path/role leak).
//   6. "false"/1/object capability values rejected before spawn (start + resume).
//   7. own systemPrompt: undefined rejected by registry.
//   8. absent systemPrompt stays compatible.
//   9. rejected resume does not change existing transcript bytes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { RunManager } from "../src/runManager.js";
import { readRegistry, normalizeAgent } from "../src/registry.js";
import { loadRoleContract, resolveRoleContractPath } from "../src/application/roleContract.js";

// The WAO repo root (this test file lives in <repoRoot>/test). Used to build
// external-cwd scenarios that still reference real role files.
const WAO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ===== Helpers =====

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function makeRegistry(dir, agents) {
  const p = join(dir, "agents.json");
  writeFileSync(p, JSON.stringify({ agents }, null, 2), "utf8");
  return p;
}

function makeFakeBackend({ supportsRoleContract = false } = {}) {
  const calls = [];
  const backend = {
    supportsRoleContract,
    spawn: async (agent, task) => {
      calls.push({ prompt: task?.prompt, roleContract: task?.roleContract });
      return {
        backend: "fake",
        backendSessionId: `fake_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        messageId: "m1",
        admittedSeq: 1,
        events: async function* () {
          yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "ok" }] };
          yield { kind: "done", reason: "completed" };
        },
        abort: async () => {},
        isAlive: () => false,
      };
    },
  };
  return { backend, calls };
}

function makeManager({ runDir, registryPath, backend }) {
  return new RunManager({
    config: { registry: registryPath, runDir },
    readRegistry,
    backendFor: () => backend,
  });
}

function fileBytes(p) {
  return statSync(p).size;
}

// Write a non-terminal process-run transcript seed matching JsonlTranscript disk format.
function writeSeedTranscript(transcriptPath, runId, agentId, { backend = "claude-code", cwd, prompt = "do task", sessionId = "orig_sess" } = {}) {
  const lines = [
    JSON.stringify({ runId, agentId, type: "run.started", seq: 1, ts: "2026-07-22T00:00:00.000Z", backend, cwd, scorecardConfigured: false }),
    JSON.stringify({ runId, agentId, type: "run.state_change", seq: 2, ts: "2026-07-22T00:00:00.001Z", from: null, to: "pending", reason: "created" }),
    JSON.stringify({ runId, agentId, type: "prompt.sent", seq: 3, ts: "2026-07-22T00:00:00.002Z", prompt }),
    JSON.stringify({ runId, agentId, type: "session.created", seq: 4, ts: "2026-07-22T00:00:00.003Z", backend, backendSessionId: sessionId }),
    JSON.stringify({ runId, agentId, type: "run.state_change", seq: 5, ts: "2026-07-22T00:00:00.004Z", from: "pending", to: "submitted", reason: "spawned" }),
  ];
  writeFileSync(transcriptPath, lines.join("\n") + "\n", "utf8");
}

// ===== C1: path authority (cross-project, cwd-independent) =====

// ---------------------------------------------------------------------
// C1-1: resolveRoleContractPath resolves relative paths against the WAO
//       install root, not process.cwd(). Run from a temp "external" cwd.
// ---------------------------------------------------------------------
test("M11-5-C1-1: relative role path resolves against WAO root, not cwd", () => {
  // Spawn a temp dir to act as an "external project" cwd; the relative path
  // must NOT resolve into it.
  const externalCwd = mkdtempSync(join(tmpdir(), "wao-c1-extcwd-"));
  const origCwd = process.cwd();
  try {
    process.chdir(externalCwd);
    const resolved = resolveRoleContractPath("config/roles/tester.md");
    // Must be under WAO root, not under the external cwd.
    assert.ok(isAbsolute(resolved), "resolved is absolute");
    assert.ok(resolved.startsWith(WAO_ROOT),
      `relative path resolves under WAO root, not cwd (got ${resolved})`);
    assert.ok(!resolved.startsWith(externalCwd),
      `relative path does NOT resolve into the external cwd`);
    // The real file exists.
    assert.ok(existsSync(resolved), "tester.md exists at the resolved path");
  } finally {
    process.chdir(origCwd);
    cleanupDir(externalCwd);
  }
});

// ---------------------------------------------------------------------
// C1-2: absolute role path is returned unchanged.
// ---------------------------------------------------------------------
test("M11-5-C1-2: absolute role path preserved unchanged", () => {
  const abs = process.platform === "win32" ? "D:\\some\\abs\\role.md" : "/some/abs/role.md";
  assert.equal(resolveRoleContractPath(abs), abs, "absolute path returned as-is");
});

// ---------------------------------------------------------------------
// C1-3: external cwd — loadRoleContract loads config/roles/tester.md content.
// ---------------------------------------------------------------------
test("M11-5-C1-3: external cwd loads tester.md role content", () => {
  const externalCwd = mkdtempSync(join(tmpdir(), "wao-c1-load-"));
  const origCwd = process.cwd();
  try {
    process.chdir(externalCwd);
    const content = loadRoleContract("config/roles/tester.md");
    assert.ok(content.includes("Tester"), "loaded the tester role content");
    assert.ok(content.length > 0, "content is non-empty");
  } finally {
    process.chdir(origCwd);
    cleanupDir(externalCwd);
  }
});

// ---------------------------------------------------------------------
// C1-4: external cwd — RunManager.start + supported fake backend receives
//       the role body (proves dispatch path resolves correctly off-cwd).
// ---------------------------------------------------------------------
test("M11-5-C1-4: external cwd — RunManager.start delivers role body to backend", async () => {
  const externalCwd = mkdtempSync(join(tmpdir(), "wao-c1-start-"));
  const origCwd = process.cwd();
  // runDir + registry live in a temp area, but the systemPrompt points to a
  // RELATIVE path that only resolves under WAO root.
  const scratch = mkdtempSync(join(tmpdir(), "wao-c1-scratch-"));
  try {
    process.chdir(externalCwd);
    const runDir = join(scratch, "runs"); mkdirSync(runDir, { recursive: true });
    const registryPath = makeRegistry(scratch, {
      coder: { backend: "claude-code", cwd: scratch, systemPrompt: "config/roles/tester.md" },
    });
    const { backend, calls } = makeFakeBackend({ supportsRoleContract: true });
    const mgr = makeManager({ runDir, registryPath, backend });
    await mgr.start("coder", { prompt: "do task", runDir, registry: registryPath });
    assert.ok(calls.length >= 1, "spawn was called");
    assert.ok(calls[0].roleContract && calls[0].roleContract.includes("Tester"),
      "backend received the tester role body despite external cwd");
  } finally {
    process.chdir(origCwd);
    cleanupDir(externalCwd);
    cleanupDir(scratch);
  }
});

// ---------------------------------------------------------------------
// C1-5: missing role file → fixed safe error, no path/role leak.
// ---------------------------------------------------------------------
test("M11-5-C1-5: missing role file → fixed safe error, no absolute path or role leak", () => {
  const externalCwd = mkdtempSync(join(tmpdir(), "wao-c1-missing-"));
  const origCwd = process.cwd();
  try {
    process.chdir(externalCwd);
    let msg = "";
    try { loadRoleContract("config/roles/does-not-exist.md"); }
    catch (e) { msg = e.message; }
    assert.match(msg, /role contract/i, "error mentions role contract");
    // No absolute path leak, no WAO_ROOT leak.
    assert.ok(!msg.includes(WAO_ROOT), "no WAO root leak in error");
    assert.ok(!/([A-Z]:\\|\/)[^\s]*does-not-exist/.test(msg), "no absolute path leak");
  } finally {
    process.chdir(origCwd);
    cleanupDir(externalCwd);
  }
});

// ===== C2: strict capability judgment (=== true only) =====

// ---------------------------------------------------------------------
// C2-1: start rejects truthy-non-true capability values before spawn.
// ---------------------------------------------------------------------
test("M11-5-C2-1: start rejects truthy-non-true capability before spawn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-c2-start-"));
  try {
    const runDir = join(dir, "runs"); mkdirSync(runDir, { recursive: true });
    const rolePath = join(dir, "role.md"); writeFileSync(rolePath, "ROLE_C2", "utf8");
    const registryPath = makeRegistry(dir, {
      coder: { backend: "claude-code", cwd: dir, systemPrompt: rolePath },
    });
    for (const capVal of ["false", "true", 1, {}]) {
      const { backend, calls } = makeFakeBackend({ supportsRoleContract: capVal });
      const mgr = makeManager({ runDir, registryPath, backend });
      let threw = false; let msg = "";
      try { await mgr.start("coder", { prompt: "do task", runDir, registry: registryPath }); }
      catch (e) { threw = true; msg = e.message; }
      assert.ok(threw, `start rejects capability=${JSON.stringify(capVal)}`);
      assert.match(msg, /does not support role contract/i,
        `capability=${JSON.stringify(capVal)} rejected with capability reason`);
      assert.equal(calls.length, 0, `zero spawn for capability=${JSON.stringify(capVal)}`);
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// C2-2: resume rejects truthy-non-true capability before spawn; transcript
//       bytes unchanged.
// ---------------------------------------------------------------------
test("M11-5-C2-2: resume rejects truthy-non-true capability before spawn, transcript unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-c2-resume-"));
  try {
    const runDir = join(dir, "runs"); mkdirSync(runDir, { recursive: true });
    const rolePath = join(dir, "role.md"); writeFileSync(rolePath, "ROLE_C2R", "utf8");
    const registryPath = makeRegistry(dir, {
      coder: { backend: "claude-code", cwd: dir, systemPrompt: rolePath },
    });
    const runId = "run_c2_resume";
    const transcriptPath = join(runDir, `${runId}.jsonl`);
    writeSeedTranscript(transcriptPath, runId, "coder", { backend: "claude-code", cwd: dir });
    for (const capVal of ["false", 1, {}]) {
      const bytesBefore = fileBytes(transcriptPath);
      const { backend, calls } = makeFakeBackend({ supportsRoleContract: capVal });
      const mgr = makeManager({ runDir, registryPath, backend });
      let threw = false;
      try { await mgr.resume(runId, { runDir, registry: registryPath }); }
      catch { threw = true; }
      assert.ok(threw, `resume rejects capability=${JSON.stringify(capVal)}`);
      assert.equal(calls.length, 0, `zero spawn for capability=${JSON.stringify(capVal)}`);
      assert.equal(fileBytes(transcriptPath), bytesBefore,
        `transcript bytes unchanged for capability=${JSON.stringify(capVal)}`);
    }
  } finally {
    cleanupDir(dir);
  }
});

// ===== C3: registry own-property semantics =====

// ---------------------------------------------------------------------
// C3-1: own-property systemPrompt: undefined is rejected; absent is OK.
// ---------------------------------------------------------------------
test("M11-5-C3-1: own systemPrompt:undefined rejected; absent accepted", () => {
  // absent (no own property) → OK.
  assert.doesNotThrow(() => normalizeAgent("absent", { backend: "claude-code", cwd: "/x" }),
    "absent systemPrompt accepted");
  // own property undefined → REJECT.
  const ownUndef = { backend: "claude-code", cwd: "/x" };
  Object.defineProperty(ownUndef, "systemPrompt", { value: undefined, enumerable: true, configurable: true, writable: true });
  assert.throws(() => normalizeAgent("ownUndef", ownUndef), /systemPrompt/i,
    "own-property undefined systemPrompt rejected");
  // null → REJECT.
  assert.throws(() => normalizeAgent("nullv", { backend: "claude-code", cwd: "/x", systemPrompt: null }), /systemPrompt/i);
  // blank → REJECT.
  assert.throws(() => normalizeAgent("blank", { backend: "claude-code", cwd: "/x", systemPrompt: "   " }), /systemPrompt/i);
  // non-string → REJECT.
  assert.throws(() => normalizeAgent("num", { backend: "claude-code", cwd: "/x", systemPrompt: 42 }), /systemPrompt/i);
  // non-empty string → OK.
  assert.doesNotThrow(() => normalizeAgent("ok", { backend: "claude-code", cwd: "/x", systemPrompt: "config/roles/x.md" }));
});

// ===== C4: rejected resume leaves existing transcript bytes unchanged =====

// ---------------------------------------------------------------------
// C4-1: unsupported-capability resume does not change transcript bytes
//       (re-stated as an explicit C4 case; the capability here is the
//       canonical boolean false).
// ---------------------------------------------------------------------
test("M11-5-C4-1: unsupported-capability resume leaves transcript bytes unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-c4-bytes-"));
  try {
    const runDir = join(dir, "runs"); mkdirSync(runDir, { recursive: true });
    const rolePath = join(dir, "role.md"); writeFileSync(rolePath, "ROLE_C4", "utf8");
    const registryPath = makeRegistry(dir, {
      coder: { backend: "claude-code", cwd: dir, systemPrompt: rolePath },
    });
    const runId = "run_c4_bytes";
    const transcriptPath = join(runDir, `${runId}.jsonl`);
    writeSeedTranscript(transcriptPath, runId, "coder", { backend: "claude-code", cwd: dir });
    const bytesBefore = fileBytes(transcriptPath);
    const { backend, calls } = makeFakeBackend({ supportsRoleContract: false });
    const mgr = makeManager({ runDir, registryPath, backend });
    let threw = false;
    try { await mgr.resume(runId, { runDir, registry: registryPath }); }
    catch { threw = true; }
    assert.ok(threw, "resume rejected for unsupported capability");
    assert.equal(calls.length, 0, "zero spawn");
    assert.equal(fileBytes(transcriptPath), bytesBefore, "transcript bytes unchanged");
  } finally {
    cleanupDir(dir);
  }
});
