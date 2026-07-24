// test/roleContractPackageA2.test.js
//
// M11-5 Package A2: close the role-contract architecture boundary.
//
// These tests drive the REAL RunManager.start / .resume to prove the
// capability-driven decision contract:
//   1. RunManager decides role-contract injection by BACKEND CAPABILITY
//      (backend.supportsRoleContract), NOT by runtime name branches.
//   2. start must reject "unsupported capability + systemPrompt" BEFORE
//      transcript creation and spawn.
//   3. resume must EXPLICITLY FAIL (throw) for an unsupported backend with
//      systemPrompt — never silently return null.
//   4. systemPrompt: null is rejected (only absent-attribute or non-empty
//      string allowed).
//   5. Supported backend: role content reloaded and passed to spawn exactly
//      once on resume.
//   6. Unsupported backend resume: zero spawn, transcript bytes unchanged.
//   7. Missing/invalid role file on resume: zero spawn, transcript bytes
//      unchanged.
//   8. No systemPrompt: legacy behavior preserved.
//   9. Architecture guard: the role-contract decision region contains no
//      runtime-name branches.
//
// These are written FIRST (RED) against the current ceb8362 code, then the
// implementation is changed to turn them GREEN.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { RunManager } from "../src/runManager.js";
import { readRegistry, normalizeAgent } from "../src/registry.js";
import { OpenCodeServeBackend } from "../src/backends/opencodeServe.js";
import { ClaudeCodeBackend } from "../src/backends/claudeCode.js";
import { CodexBackend } from "../src/backends/codex.js";
import { KimiCodeBackend } from "../src/backends/kimiCode.js";

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
// supportsRoleContract controls the capability the RunManager must read.
function makeFakeBackend({ supportsRoleContract = false, recordSpawn = null } = {}) {
  const calls = [];
  const backend = {
    supportsRoleContract,
    spawn: async (agent, task) => {
      const entry = {
        agentId: agent?.id,
        prompt: task?.prompt,
        roleContract: task?.roleContract,
      };
      calls.push(entry);
      if (recordSpawn) recordSpawn(entry);
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

// Count jsonl transcript files in runDir.
function transcriptFiles(runDir) {
  return existsSync(runDir) ? readdirSync(runDir).filter((f) => f.endsWith(".jsonl")) : [];
}

// Write a non-terminal process-run transcript seed that matches the REAL
// JsonlTranscript disk format (payload fields flattened to top level, plus
// ts/seq/runId/agentId/type). RunManager.resume reads this via readTranscript
// (raw JSON lines), so the on-disk shape must be exactly what append() writes.
// This produces a run that is in "submitted" state with a live session.
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

// ===== A. Backend capability declaration =====

// ---------------------------------------------------------------------
// A2-CAP1: each backend declares supportsRoleContract via capability, not
//          runtime name. Three process backends = true, opencode = false.
// ---------------------------------------------------------------------
test("M11-5-A2-CAP1: backends declare supportsRoleContract capability", () => {
  assert.equal(new OpenCodeServeBackend().supportsRoleContract, false,
    "opencode-serve must NOT support role contract");
  assert.equal(new ClaudeCodeBackend().supportsRoleContract, true,
    "claude-code supports role contract");
  assert.equal(new CodexBackend().supportsRoleContract, true,
    "codex supports role contract");
  assert.equal(new KimiCodeBackend().supportsRoleContract, true,
    "kimi-code supports role contract");
});

// ---------------------------------------------------------------------
// A2-CAP2: a backend WITHOUT the capability flag defaults to false (a new
//          runtime that forgets to declare must fail safe, not silently
//          inject or silently drop).
// ---------------------------------------------------------------------
test("M11-5-A2-CAP2: missing supportsRoleContract capability defaults to false (fail-safe)", () => {
  // A backend object with no supportsRoleContract at all.
  const bare = { spawn: async () => ({}) };
  assert.equal(Boolean(bare.supportsRoleContract), false,
    "backend without explicit capability defaults to unsupported");
});

// ===== B. start: capability-driven fail-closed =====

// ---------------------------------------------------------------------
// A2-START1: start must reject "unsupported capability + systemPrompt"
//            before transcript creation and spawn. The RunManager must read
//            backend.supportsRoleContract, NOT branch on runtime name.
// ---------------------------------------------------------------------
test("M11-5-A2-START1: start rejects unsupported-capability backend + systemPrompt before transcript/spawn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a2-start1-"));
  try {
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    const rolePath = makeRoleFile(dir, "role.md", "ROLE_A2_START1");
    const registryPath = makeRegistry(dir, {
      coder: { backend: "claude-code", cwd: dir, systemPrompt: rolePath },
    });
    // Inject a backend whose capability is FALSE even though agent.backend
    // is "claude-code". The decision MUST follow capability, not the name.
    const { backend, calls } = makeFakeBackend({ supportsRoleContract: false });
    const mgr = makeManager({ runDir, registryPath, backend });
    let threw = false;
    let errMsg = "";
    try {
      await mgr.start("coder", { prompt: "do task", runDir, registry: registryPath });
    } catch (e) {
      threw = true;
      errMsg = e.message;
    }
    assert.ok(threw, "unsupported capability + systemPrompt must throw");
    assert.match(errMsg, /systemPrompt|role contract/i, "error mentions systemPrompt/role contract");
    assert.equal(calls.length, 0, "zero spawn calls");
    assert.equal(transcriptFiles(runDir).length, 0, "zero transcript files created");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// A2-START2: start allows supported-capability backend to load role and
//            pass content to spawn.
// ---------------------------------------------------------------------
test("M11-5-A2-START2: start loads role and passes content to spawn for supported backend", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a2-start2-"));
  try {
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    const rolePath = makeRoleFile(dir, "role.md", "ROLE_A2_START2");
    const registryPath = makeRegistry(dir, {
      coder: { backend: "claude-code", cwd: dir, systemPrompt: rolePath },
    });
    const { backend, calls } = makeFakeBackend({ supportsRoleContract: true });
    const mgr = makeManager({ runDir, registryPath, backend });
    await mgr.start("coder", { prompt: "do task", runDir, registry: registryPath });
    assert.ok(calls.length >= 1, "spawn was called");
    // M11-8B: roleContract is composed (identity header + role body).
    assert.ok(typeof calls[0].roleContract === "string" && calls[0].roleContract.includes("ROLE_A2_START2"),
      "backend received composed role content (includes role body)");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// A2-START3: start with missing role file on supported backend → zero
//            spawn, zero transcript.
// ---------------------------------------------------------------------
test("M11-5-A2-START3: start missing role file on supported backend → zero spawn, zero transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a2-start3-"));
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
    assert.equal(transcriptFiles(runDir).length, 0, "zero transcript");
  } finally {
    cleanupDir(dir);
  }
});

// ===== C. resume: explicit failure, never silent null =====

// ---------------------------------------------------------------------
// A2-RESUME1: resume of an unsupported-capability backend that HAS
//             systemPrompt must EXPLICITLY THROW — never silently return
//             null. spawn count must be 0; transcript bytes unchanged.
// ---------------------------------------------------------------------
test("M11-5-A2-RESUME1: resume unsupported-capability + systemPrompt throws (no silent null), zero spawn, transcript unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a2-resume1-"));
  try {
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    const rolePath = makeRoleFile(dir, "role.md", "ROLE_A2_RESUME1");
    const registryPath = makeRegistry(dir, {
      coder: { backend: "claude-code", cwd: dir, systemPrompt: rolePath },
    });
    const runId = "run_a2_resume1";
    const transcriptPath = join(runDir, `${runId}.jsonl`);
    writeSeedTranscript(transcriptPath, runId, "coder", { backend: "claude-code", cwd: dir });
    const bytesBefore = fileBytes(transcriptPath);

    // Inject backend with FALSE capability, so resume must fail closed.
    const { backend, calls } = makeFakeBackend({ supportsRoleContract: false });
    const mgr = makeManager({ runDir, registryPath, backend });

    let threw = false;
    let errMsg = "";
    try {
      await mgr.resume(runId, { runDir, registry: registryPath });
    } catch (e) {
      threw = true;
      errMsg = e.message;
    }
    assert.ok(threw, "resume of unsupported-capability backend with systemPrompt must throw");
    assert.match(errMsg, /systemPrompt|role contract/i, "error mentions systemPrompt/role contract");
    assert.equal(calls.length, 0, "zero spawn on resume failure");
    assert.equal(fileBytes(transcriptPath), bytesBefore, "transcript bytes unchanged on resume failure");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// A2-RESUME2: resume of a supported-capability backend reloads role
//             content and passes it to spawn exactly once.
// ---------------------------------------------------------------------
test("M11-5-A2-RESUME2: resume supported backend reloads role, passes content to spawn exactly once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a2-resume2-"));
  try {
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    const rolePath = makeRoleFile(dir, "role.md", "ROLE_A2_RESUME2");
    const registryPath = makeRegistry(dir, {
      coder: { backend: "claude-code", cwd: dir, systemPrompt: rolePath },
    });
    const runId = "run_a2_resume2";
    const transcriptPath = join(runDir, `${runId}.jsonl`);
    writeSeedTranscript(transcriptPath, runId, "coder", { backend: "claude-code", cwd: dir });

    const { backend, calls } = makeFakeBackend({ supportsRoleContract: true });
    const mgr = makeManager({ runDir, registryPath, backend });
    const resumed = await mgr.resume(runId, { runDir, registry: registryPath });
    assert.ok(resumed, "resume returns a Run for supported backend");
    await resumed.waitForCompletion({ waitTimeout: 1000, pollInterval: 5 });
    assert.equal(calls.length, 1, "spawn called exactly once on resume");
    // M11-8B: roleContract is composed (identity header + role body) on resume too.
    assert.ok(typeof calls[0].roleContract === "string" && calls[0].roleContract.includes("ROLE_A2_RESUME2"),
      "composed role content reloaded and passed to spawn (includes role body)");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// A2-RESUME3: resume of a supported backend with a MISSING role file →
//             zero spawn, transcript bytes unchanged.
// ---------------------------------------------------------------------
test("M11-5-A2-RESUME3: resume supported backend + missing role file → zero spawn, transcript unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a2-resume3-"));
  try {
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    const registryPath = makeRegistry(dir, {
      coder: { backend: "claude-code", cwd: dir, systemPrompt: join(dir, "missing.md") },
    });
    const runId = "run_a2_resume3";
    const transcriptPath = join(runDir, `${runId}.jsonl`);
    writeSeedTranscript(transcriptPath, runId, "coder", { backend: "claude-code", cwd: dir });
    const bytesBefore = fileBytes(transcriptPath);

    const { backend, calls } = makeFakeBackend({ supportsRoleContract: true });
    const mgr = makeManager({ runDir, registryPath, backend });
    let threw = false;
    try {
      await mgr.resume(runId, { runDir, registry: registryPath });
    } catch {
      threw = true;
    }
    assert.ok(threw, "missing role file on resume must throw");
    assert.equal(calls.length, 0, "zero spawn");
    assert.equal(fileBytes(transcriptPath), bytesBefore, "transcript bytes unchanged");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// A2-RESUME4: resume of a backend with NO systemPrompt → legacy behavior
//             preserved (roleContract is undefined; no role loading).
// ---------------------------------------------------------------------
test("M11-5-A2-RESUME4: resume backend without systemPrompt → legacy behavior, no role", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a2-resume4-"));
  try {
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    const registryPath = makeRegistry(dir, {
      coder: { backend: "claude-code", cwd: dir },
    });
    const runId = "run_a2_resume4";
    const transcriptPath = join(runDir, `${runId}.jsonl`);
    writeSeedTranscript(transcriptPath, runId, "coder", { backend: "claude-code", cwd: dir });

    const { backend, calls } = makeFakeBackend({ supportsRoleContract: true });
    const mgr = makeManager({ runDir, registryPath, backend });
    const resumed = await mgr.resume(runId, { runDir, registry: registryPath });
    assert.ok(resumed, "resume returns a Run");
    await resumed.waitForCompletion({ waitTimeout: 1000, pollInterval: 5 });
    assert.equal(calls.length, 1, "spawn called once");
    assert.equal(calls[0].roleContract, undefined, "no role loaded when systemPrompt absent");
  } finally {
    cleanupDir(dir);
  }
});

// ===== D. systemPrompt: null rejected =====

// ---------------------------------------------------------------------
// A2-NORM1: normalizeAgent must reject systemPrompt: null. Only absent
//           attribute or a non-empty trimmed string are allowed.
// ---------------------------------------------------------------------
test("M11-5-A2-NORM1: normalizeAgent rejects systemPrompt: null (only absent or non-empty string)", () => {
  // null must now be rejected.
  assert.throws(
    () => normalizeAgent("n_null", { backend: "claude-code", cwd: "/x", systemPrompt: null }),
    /systemPrompt/i,
    "systemPrompt: null must be rejected",
  );
  // The full invalid set (CTO rework spec): null, number, boolean, object,
  // array, whitespace string. undefined-present objects are caught by the
  // "must be string" branch.
  for (const bad of [null, 0, 42, false, true, {}, [], "   ", ""]) {
    assert.throws(
      () => normalizeAgent("n_bad", { backend: "claude-code", cwd: "/x", systemPrompt: bad }),
      /systemPrompt/i,
      `systemPrompt=${JSON.stringify(bad)} must be rejected`,
    );
  }
  // Valid: non-empty string.
  assert.doesNotThrow(() => normalizeAgent("n_ok", { backend: "claude-code", cwd: "/x", systemPrompt: "config/roles/x.md" }));
  // Valid: attribute absent (key not present).
  assert.doesNotThrow(() => normalizeAgent("n_absent", { backend: "claude-code", cwd: "/x" }));
});

// ---------------------------------------------------------------------
// A2-NORM2: error message must NOT echo the supplied value, path, role
//           content, or sentinel. A fixed safe shape only.
// ---------------------------------------------------------------------
test("M11-5-A2-NORM2: normalizeAgent systemPrompt error is a fixed safe shape (no value echo)", () => {
  const sentinel = "M115_A2_SENTINEL_VALUE_XYZ";
  for (const bad of [sentinel + "!!", 999, { evil: sentinel }, [sentinel], "   " + sentinel + "   "]) {
    try {
      normalizeAgent("n_leak", { backend: "claude-code", cwd: "/x", systemPrompt: bad });
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(!e.message.includes(sentinel),
        `error must not echo supplied value; got: ${e.message}`);
    }
  }
});

// ===== E. Architecture guard: no runtime-name branch in role-contract region =====

// ---------------------------------------------------------------------
// A2-ARCH1: the role-contract decision region in runManager.js must not
//           contain runtime-name branches (opencode-serve / claude-code /
//           codex / kimi-code). The decision must be capability-driven.
//
//           We isolate the role-contract region (start + resume load) and
//           assert it references supportsRoleContract, not runtime names.
// ---------------------------------------------------------------------
test("M11-5-A2-ARCH1: runManager role-contract region is capability-driven, no runtime-name branch", () => {
  const src = readFileSync(resolve(process.cwd(), "src/runManager.js"), "utf8");
  // The role-contract load in start must query capability, not runtime name.
  assert.ok(/supportsRoleContract/.test(src),
    "RunManager reads supportsRoleContract capability");
  // No runtime-name branch in the role-contract decision. We look for the
  // specific anti-pattern: `agent.backend === "opencode-serve"` or
  // `backend === "...runtime..."` used to decide role injection.
  // The old code had: if (agent.backend === "opencode-serve") { throw ... }
  // for the role contract. That must be gone.
  // We check that no "opencode-serve" comparison appears in a role-contract
  // context by ensuring the capability is the sole gate.
  // Strict guard: the start role-contract block must not branch on runtime.
  // Package C1: path resolution moved into loadRoleContract (no call-site resolve()).
  const startRoleBlock = src.match(/let roleContract[\s\S]*?loadRoleContract\(agent\.systemPrompt\)/);
  assert.ok(startRoleBlock, "found start role-contract block");
  const block = startRoleBlock[0];
  assert.ok(!/opencode-serve|claude-code|codex|kimi-code/.test(block),
    "start role-contract block has NO runtime-name branch");
  assert.ok(/supportsRoleContract/.test(block),
    "start role-contract block uses supportsRoleContract capability");
});

// ---------------------------------------------------------------------
// A2-ARCH2: resume role-contract region is also capability-driven and
//           no longer silently returns null for unsupported backends.
// ---------------------------------------------------------------------
test("M11-5-A2-ARCH2: resume role-contract region is capability-driven, no silent null", () => {
  const src = readFileSync(resolve(process.cwd(), "src/runManager.js"), "utf8");
  // The resume role-contract block: from resumeRoleContract declaration to
  // the loadRoleContract call. Package C1: path resolution moved into
  // loadRoleContract (no call-site resolve()).
  const resumeRoleBlock = src.match(/let resumeRoleContract[\s\S]*?loadRoleContract\(agent\.systemPrompt\)/);
  assert.ok(resumeRoleBlock, "found resume role-contract block");
  const block = resumeRoleBlock[0];
  assert.ok(!/opencode-serve|claude-code|codex|kimi-code/.test(block),
    "resume role-contract block has NO runtime-name branch");
  assert.ok(/supportsRoleContract/.test(block),
    "resume role-contract block uses supportsRoleContract capability");
});

// ---------------------------------------------------------------------
// A2-ARCH3: residual comments mentioning the old path-based flag
//           (--append-system-prompt-file) and roleContractPath are removed
//           from runManager.js.
// ---------------------------------------------------------------------
test("M11-5-A2-ARCH3: runManager has no residual roleContractPath / append-system-prompt-file references", () => {
  const src = readFileSync(resolve(process.cwd(), "src/runManager.js"), "utf8");
  assert.ok(!/roleContractPath/.test(src),
    "no roleContractPath residue in runManager.js");
  assert.ok(!/append-system-prompt-file/.test(src),
    "no --append-system-prompt-file residue in runManager.js");
});
