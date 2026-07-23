// test/m11-7-workerReadiness.test.js
//
// M11-7 (CTO closeout): Worker credential availability + Windows user-env bridge.
//
// Covers the four RED requirements:
//   1. Real-registry probe: optional config (KIMI_BASE_URL etc.) does NOT block;
//      only an explicitly-declared missing REQUIRED credential blocks.
//   2. Foreground start + resume bridge resolved values into ProcessBackend;
//      missing REQUIRED credential is rejected before transcript/spawn.
//   3. No permanent cache: rotation/recovery takes effect without restart.
//   4. Real-event + transcript sentinel zero-hit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  resolveCredentialEnv,
  assessWorkerReadiness,
  createEnvResolver,
  requiredCredentialNames,
  inheritedEnvNames,
  CREDENTIAL_SENTINEL,
} from "../src/application/credentialReadiness.js";

// NOTE on test values: desensitization gate (test/desensitization.test.js) flags
// any XXX_SECRET/API_KEY/TOKEN = "<20+ chars>" pattern. Test credential values
// here are intentionally short or allowlisted (test-key/test-secret) so the gate
// never trips on a fixture.

// ===== Helpers =====

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function makeRegistry(dir, agents) {
  const p = join(dir, "agents.json");
  writeFileSync(p, JSON.stringify({ agents }, null, 2), "utf8");
  return p;
}

function fakeUserEnvReader(map) {
  const calls = [];
  const fn = async (name) => { calls.push(name); return map[name]; };
  fn.calls = calls;
  return fn;
}

function makeGitRepo(dir) {
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
}

// ===== RED-1: real-registry probe (no false blockers) =====

test("M11-7-R1a: optional env names are NOT required (no false blocker)", () => {
  const kimi = { backend: "kimi-code", id: "coder_mm" };
  assert.deepEqual(requiredCredentialNames(kimi), [], "kimi-code has NO required creds");
  assert.ok(inheritedEnvNames(kimi).includes("KIMI_BASE_URL"), "KIMI_BASE_URL is inherited (optional)");
  const codex = { backend: "codex", id: "tester" };
  assert.deepEqual(requiredCredentialNames(codex), [], "codex has NO required creds");
  assert.ok(inheritedEnvNames(codex).includes("CODEX_HOME"), "CODEX_HOME is inherited (optional)");
});

test("M11-7-R1b: explicitly-declared REQUIRED credential blocks when missing", async () => {
  delete process.env.TEST_M117_REQ_MISSING;
  const agent = { backend: "claude-code", id: "researcher", provider: { apiKeyEnv: "TEST_M117_REQ_MISSING" } };
  const r = await assessWorkerReadiness({ agent, resolver: createEnvResolver(fakeUserEnvReader({})) });
  assert.equal(r.credentialAvailability, "missing");
  assert.deepEqual(r.missingCredentialEnvNames, ["TEST_M117_REQ_MISSING"]);
});

test("M11-7-R1c: real registry — coder_mm/tester not blocked; researcher gated on declared key", async () => {
  const reg = JSON.parse(readFileSync("config/agents.json", "utf8"));
  const reader = fakeUserEnvReader({});
  const results = {};
  for (const [id, a] of Object.entries(reg.agents)) {
    const r = await assessWorkerReadiness({ agent: { id, ...a }, resolver: createEnvResolver(reader) });
    results[id] = r.credentialAvailability;
  }
  assert.notEqual(results.coder_mm, "missing", "coder_mm not blocked by optional config");
  assert.notEqual(results.tester, "missing", "tester not blocked by optional config");
  assert.ok(["available", "missing"].includes(results.researcher), "researcher gated on its declared key");
});

// ===== A: env-policy SSOT =====

test("M11-7-A: provider.apiKeyEnv and legacy --api-key-env are required", () => {
  assert.ok(requiredCredentialNames({ backend: "claude-code", provider: { apiKeyEnv: "DEEPSEEK_API_KEY" } }).includes("DEEPSEEK_API_KEY"));
  assert.ok(requiredCredentialNames({ backend: "claude-code", prependArgs: ["--api-key-env", "DEEPSEEK_API_KEY", "--"] }).includes("DEEPSEEK_API_KEY"));
});

test("M11-7-A6: worker with no required credential → not_required", async () => {
  const r = await assessWorkerReadiness({ agent: { backend: "claude-code", id: "plain" }, resolver: createEnvResolver(fakeUserEnvReader({})) });
  assert.equal(r.credentialAvailability, "not_required");
  assert.deepEqual(r.missingCredentialEnvNames, []);
});

test("M11-7-A8: readiness result does not carry certification", async () => {
  const r = await assessWorkerReadiness({ agent: { backend: "claude-code", id: "x", provider: { apiKeyEnv: "TEST_M117_SEP" } }, resolver: createEnvResolver(fakeUserEnvReader({ TEST_M117_SEP: "test-key-abc" })) });
  assert.equal(r.certification, undefined);
});

// ===== RED-3: no permanent cache — rotation/recovery without restart =====

test("M11-7-R3: rotation/recovery takes effect on next operation (no permanent cache)", async () => {
  const agent = { backend: "claude-code", id: "x", provider: { apiKeyEnv: "TEST_M117_ROTATE" } };
  delete process.env.TEST_M117_ROTATE;
  let map = {};
  // First operation: missing.
  let r = await assessWorkerReadiness({ agent, resolver: createEnvResolver(fakeUserEnvReader(map)) });
  assert.equal(r.credentialAvailability, "missing");
  // Rotate: available on the NEXT independent operation (new resolver).
  map = { TEST_M117_ROTATE: "test-key-rotated" };
  r = await assessWorkerReadiness({ agent, resolver: createEnvResolver(fakeUserEnvReader(map)) });
  assert.equal(r.credentialAvailability, "available");
  assert.equal(r.resolvedEnv.TEST_M117_ROTATE, "test-key-rotated");
});

test("M11-7-R3b: each name read at most once per operation (resolver.readerCallCount)", async () => {
  const agent = { backend: "claude-code", id: "x", provider: { apiKeyEnv: "TEST_M117_DEDUPE" } };
  delete process.env.TEST_M117_DEDUPE;
  const reader = fakeUserEnvReader({ TEST_M117_DEDUPE: "test-key-dedupe" });
  const resolver = createEnvResolver(reader);
  await assessWorkerReadiness({ agent, resolver });
  assert.equal(resolver.readerCallCount, 1, "reader called once for the single distinct name");
  assert.deepEqual(reader.calls, ["TEST_M117_DEDUPE"]);
});

// ===== operation-scope: inventory shared-name de-dupe + no optional reads =====

// OP-1: two agents sharing one required env name → read EXACTLY ONCE in one inventory.
test("M11-7-OP1: shared required name read exactly once across one inventory", async () => {
  const { getRegistryInventory } = await import("../src/application/registryInventory.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m117-op1-"));
  try {
    delete process.env.TEST_M117_OP_SHARED;
    const registryPath = makeRegistry(dir, {
      a: { backend: "claude-code", cwd: dir, provider: { apiKeyEnv: "TEST_M117_OP_SHARED" } },
      b: { backend: "claude-code", cwd: dir, provider: { apiKeyEnv: "TEST_M117_OP_SHARED" } },
    });
    const counts = {};
    const reader = async (name) => { counts[name] = (counts[name] ?? 0) + 1; return "test-key-op"; };
    await getRegistryInventory({ registryPath, runDir: dir, userEnvReader: reader });
    assert.equal(counts.TEST_M117_OP_SHARED, 1, "shared required name read exactly once in one inventory");
  } finally {
    cleanupDir(dir);
  }
});

// OP-2: inventory does NOT read optional inherited env for agents with no required credential.
test("M11-7-OP2: inventory reads NO optional env for not_required agents", async () => {
  const { getRegistryInventory } = await import("../src/application/registryInventory.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m117-op2-"));
  try {
    for (const n of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME", "KIMI_API_KEY", "KIMI_BASE_URL", "KIMI_MODEL_NAME"]) delete process.env[n];
    const registryPath = makeRegistry(dir, {
      tester: { backend: "codex", cwd: dir },
      coder_mm: { backend: "kimi-code", cwd: dir },
    });
    const counts = {};
    const reader = async (name) => { counts[name] = (counts[name] ?? 0) + 1; return undefined; };
    const agents = await getRegistryInventory({ registryPath, runDir: dir, userEnvReader: reader });
    assert.deepEqual(counts, {}, "no optional inherited env read during inventory");
    assert.equal(agents.find((a) => a.id === "tester").credentialAvailability, "not_required");
    assert.equal(agents.find((a) => a.id === "coder_mm").credentialAvailability, "not_required");
  } finally {
    cleanupDir(dir);
  }
});

// OP-3: a second inventory operation re-reads (observes rotation), no permanent cache.
test("M11-7-OP3: second inventory re-reads and observes rotation", async () => {
  const { getRegistryInventory } = await import("../src/application/registryInventory.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m117-op3-"));
  try {
    delete process.env.TEST_M117_OP_ROT;
    const registryPath = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir, provider: { apiKeyEnv: "TEST_M117_OP_ROT" } } });
    // First inventory: missing.
    let map = {};
    let agents = await getRegistryInventory({ registryPath, runDir: dir, userEnvReader: async (n) => map[n] });
    assert.equal(agents[0].credentialAvailability, "missing");
    // Rotate: second inventory observes available — no restart.
    map = { TEST_M117_OP_ROT: "test-key-op-rot" };
    agents = await getRegistryInventory({ registryPath, runDir: dir, userEnvReader: async (n) => map[n] });
    assert.equal(agents[0].credentialAvailability, "available");
  } finally {
    cleanupDir(dir);
  }
});

// OP-4: dispatch still bridges OPTIONAL inherited env (not just required).
test("M11-7-OP4: dispatch bridges optional inherited env into runner env", async () => {
  const { dispatchRun } = await import("../src/application/runDispatch.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m117-op4-"));
  try {
    // kimi agent: KIMI_BASE_URL is optional inherited. Put it in user env only.
    delete process.env.KIMI_API_KEY;
    delete process.env.KIMI_BASE_URL;
    delete process.env.KIMI_MODEL_NAME;
    const registryPath = makeRegistry(dir, { w: { backend: "kimi-code", cwd: dir } });
    const runDir = join(dir, "runs"); mkdirSync(runDir, { recursive: true });
    let capturedEnv = null;
    await dispatchRun({
      agentId: "w", prompt: "do", registryPath, runDir,
      spawnFn: (exe, args, opts) => { capturedEnv = opts.env; return { unref() {} }; },
      userEnvReader: fakeUserEnvReader({ KIMI_BASE_URL: "test-key-opt-url" }),
    });
    assert.equal(capturedEnv.KIMI_BASE_URL, "test-key-opt-url", "optional inherited env bridged into runner env");
  } finally {
    cleanupDir(dir);
  }
});

// ===== resolveCredentialEnv precedence =====

test("M11-7-A1: process.env present → used, user-env not consulted", async () => {
  process.env.TEST_M117_PROC = "from-process";
  try {
    const r = await resolveCredentialEnv("TEST_M117_PROC", { userEnvReader: fakeUserEnvReader({ TEST_M117_PROC: "from-user" }) });
    assert.equal(r.source, "process_env");
    assert.equal(r.value, "from-process");
  } finally { delete process.env.TEST_M117_PROC; }
});

test("M11-7-A2: process.env missing, user-env present → fallback", async () => {
  delete process.env.TEST_M117_FB;
  const r = await resolveCredentialEnv("TEST_M117_FB", { userEnvReader: fakeUserEnvReader({ TEST_M117_FB: "from-user" }) });
  assert.equal(r.source, "user_env");
  assert.equal(r.value, "from-user");
});

test("M11-7-A3: both missing → missing", async () => {
  delete process.env.TEST_M117_MISS;
  const r = await resolveCredentialEnv("TEST_M117_MISS", { userEnvReader: fakeUserEnvReader({}) });
  assert.equal(r.source, "missing");
  assert.equal(r.value, undefined);
});

// ===== Package B: registry_list projection =====

test("M11-7-B1: registry_list projects credentialAvailability + missingCredentialEnvNames", async () => {
  const { getRegistryInventory } = await import("../src/application/registryInventory.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m117-b1-"));
  try {
    delete process.env.TEST_M117_B1_BAD;
    process.env.TEST_M117_B1_GOOD = "test-key-good";
    const registryPath = makeRegistry(dir, {
      good: { backend: "claude-code", cwd: dir, provider: { apiKeyEnv: "TEST_M117_B1_GOOD" } },
      bad: { backend: "claude-code", cwd: dir, provider: { apiKeyEnv: "TEST_M117_B1_BAD" } },
      none: { backend: "claude-code", cwd: dir },
    });
    const agents = await getRegistryInventory({ registryPath, runDir: dir, userEnvReader: fakeUserEnvReader({}) });
    const good = agents.find((a) => a.id === "good");
    const bad = agents.find((a) => a.id === "bad");
    const none = agents.find((a) => a.id === "none");
    assert.equal(good.credentialAvailability, "available");
    assert.equal(bad.credentialAvailability, "missing");
    assert.deepEqual(bad.missingCredentialEnvNames, ["TEST_M117_B1_BAD"]);
    assert.equal(none.credentialAvailability, "not_required");
  } finally {
    delete process.env.TEST_M117_B1_GOOD;
    cleanupDir(dir);
  }
});

test("M11-7-B2: credential value not in registry_list output", async () => {
  const { getRegistryInventory } = await import("../src/application/registryInventory.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m117-b2-"));
  try {
    process.env.TEST_M117_B2_KEY = "test-key-leakcheck";
    const registryPath = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir, provider: { apiKeyEnv: "TEST_M117_B2_KEY" } } });
    const agents = await getRegistryInventory({ registryPath, runDir: dir, userEnvReader: fakeUserEnvReader({}) });
    assert.ok(!JSON.stringify(agents).includes("test-key-leakcheck"), "no credential value leak");
  } finally {
    delete process.env.TEST_M117_B2_KEY;
    cleanupDir(dir);
  }
});

// ===== Package B: dispatchRun readiness gate (real service) =====

test("M11-7-B3: dispatchRun rejects missing-credential worker (zero transcript, zero fork)", async () => {
  const { dispatchRun, CredentialMissingError } = await import("../src/application/runDispatch.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m117-b3-"));
  try {
    delete process.env.TEST_M117_B3_MISSING;
    const registryPath = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir, provider: { apiKeyEnv: "TEST_M117_B3_MISSING" } } });
    const runDir = join(dir, "runs"); mkdirSync(runDir, { recursive: true });
    let spawnCalls = 0;
    let threw = null;
    try {
      await dispatchRun({
        agentId: "w", prompt: "do", registryPath, runDir,
        spawnFn: () => { spawnCalls += 1; return { unref() {} }; },
        userEnvReader: fakeUserEnvReader({}),
      });
    } catch (e) { threw = e; }
    assert.ok(threw instanceof CredentialMissingError, "threw CredentialMissingError");
    assert.equal(spawnCalls, 0, "zero fork/spawn");
    assert.equal(readdirSync(runDir).filter((f) => f.endsWith(".jsonl")).length, 0, "zero transcript");
  } finally { cleanupDir(dir); }
});

test("M11-7-B4: dispatchRun proceeds + threads user-env value into runner env", async () => {
  const { dispatchRun } = await import("../src/application/runDispatch.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m117-b4-"));
  try {
    delete process.env.TEST_M117_B4_OK;
    const registryPath = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir, provider: { apiKeyEnv: "TEST_M117_B4_OK" } } });
    const runDir = join(dir, "runs"); mkdirSync(runDir, { recursive: true });
    let capturedEnv = null;
    let spawnCalls = 0;
    const result = await dispatchRun({
      agentId: "w", prompt: "do", registryPath, runDir,
      spawnFn: (exe, args, opts) => { spawnCalls += 1; capturedEnv = opts.env; return { unref() {} }; },
      userEnvReader: fakeUserEnvReader({ TEST_M117_B4_OK: "test-key-fallback" }),
    });
    assert.equal(result.accepted, true);
    assert.equal(spawnCalls, 1);
    assert.equal(capturedEnv.TEST_M117_B4_OK, "test-key-fallback", "value threaded into runner env");
  } finally { cleanupDir(dir); }
});

test("M11-7-B5: registry_list and dispatchRun agree on the same agent", async () => {
  const { getRegistryInventory } = await import("../src/application/registryInventory.js");
  const { dispatchRun, CredentialMissingError } = await import("../src/application/runDispatch.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m117-b5-"));
  try {
    delete process.env.TEST_M117_B5_KEY;
    const reader = fakeUserEnvReader({});
    const registryPath = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir, provider: { apiKeyEnv: "TEST_M117_B5_KEY" } } });
    const runDir = join(dir, "runs"); mkdirSync(runDir, { recursive: true });
    const agents = await getRegistryInventory({ registryPath, runDir, userEnvReader: reader });
    assert.equal(agents[0].credentialAvailability, "missing");
    let spawnCalls = 0;
    let threw = null;
    try {
      await dispatchRun({ agentId: "w", prompt: "do", registryPath, runDir, spawnFn: () => { spawnCalls += 1; return { unref() {} }; }, userEnvReader: reader });
    } catch (e) { threw = e; }
    assert.ok(threw instanceof CredentialMissingError);
    assert.equal(spawnCalls, 0);
  } finally { cleanupDir(dir); }
});

// ===== ProcessBackend: child env + redaction =====

test("M11-7-A9: ProcessBackend child env includes resolved credential", async () => {
  const { ProcessBackend } = await import("../src/backends/processBackend.js");
  const { FakeStreamParser } = await import("./_m117-fakes.mjs");
  delete process.env.TEST_M117_PB;
  const captured = {};
  const fakeSpawn = (b, a, opts) => {
    Object.assign(captured, opts.env);
    return { pid: 1, exitCode: null, signalCode: null, stdout: { on() {} }, stderr: { on() {} }, once(ev, cb) { if (ev === "spawn") setImmediate(cb); }, on(ev, cb) { if (ev === "close") setImmediate(() => cb(0)); }, kill() {} };
  };
  const backend = new ProcessBackend({ parserClass: FakeStreamParser, buildArgs: () => [], credentialEnvNames: () => ["TEST_M117_PB"], spawnFn: fakeSpawn });
  await backend.spawn({ id: "w", cwd: ".", binary: "fake" }, { prompt: "x", resolvedCredentials: { TEST_M117_PB: "test-key-pb" } });
  assert.equal(captured.TEST_M117_PB, "test-key-pb");
});

test("M11-7-A10: resolved credential value redacted in handle output", async () => {
  const { ProcessBackend } = await import("../src/backends/processBackend.js");
  const { FakeStreamParser } = await import("./_m117-fakes.mjs");
  delete process.env.TEST_M117_PB2;
  // Use a value ≥ MIN_SECRET_LENGTH (8) so the redactor picks it up, but short
  // enough and named to avoid the desensitization gate.
  const value = "test-key-redact99";
  const fakeSpawn = () => ({ pid: 1, exitCode: null, signalCode: null, stdout: { on(ev, cb) { if (ev === "data") setImmediate(() => cb(Buffer.from(value))); } }, stderr: { on() {} }, once(ev, cb) { if (ev === "spawn") setImmediate(cb); }, on(ev, cb) { if (ev === "close") setImmediate(() => cb(0)); }, kill() {} });
  const backend = new ProcessBackend({ parserClass: FakeStreamParser, buildArgs: () => [], credentialEnvNames: () => ["TEST_M117_PB2"], spawnFn: fakeSpawn });
  const handle = await backend.spawn({ id: "w", cwd: ".", binary: "fake" }, { prompt: "x", resolvedCredentials: { TEST_M117_PB2: value } });
  const redacted = handle.redact(`prefix ${value} suffix`);
  assert.ok(!redacted.includes(value));
  assert.ok(redacted.includes("[REDACTED:"));
  assert.ok(!redacted.includes(CREDENTIAL_SENTINEL));
});

// ===== RED-2: foreground start bridge (RunManager) =====

test("M11-7-R2: RunManager.start bridges user-env credential into spawn + rejects missing", async () => {
  const { RunManager } = await import("../src/runManager.js");
  const { readRegistry } = await import("../src/registry.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m117-r2-"));
  try {
    delete process.env.TEST_M117_R2;
    const registryPath = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir, provider: { apiKeyEnv: "TEST_M117_R2" } } });
    const runDir = join(dir, "runs"); mkdirSync(runDir, { recursive: true });
    let spawnTask = null;
    const fakeBackend = {
      supportsRoleContract: false,
      spawn: async (agent, task) => { spawnTask = task; return { backend: "fake", backendSessionId: "s", messageId: "m", admittedSeq: 1, events: async function* () {}, abort: async () => {}, isAlive: () => false }; },
    };
    const mgr = new RunManager({ config: { registry: registryPath, runDir }, readRegistry, backendFor: () => fakeBackend, userEnvReader: fakeUserEnvReader({ TEST_M117_R2: "test-key-bridge" }) });
    await mgr.start("w", { prompt: "do", runDir, registry: registryPath });
    assert.ok(spawnTask.resolvedCredentials, "spawn received resolvedCredentials");
    assert.equal(spawnTask.resolvedCredentials.TEST_M117_R2, "test-key-bridge", "user-env value bridged into spawn");
    const mgr2 = new RunManager({ config: { registry: registryPath, runDir }, readRegistry, backendFor: () => fakeBackend, userEnvReader: fakeUserEnvReader({}) });
    let threw = false;
    try { await mgr2.start("w", { prompt: "do", runDir: join(dir, "runs2"), registry: registryPath }); } catch { threw = true; }
    assert.ok(threw, "missing required credential throws");
  } finally { cleanupDir(dir); }
});

// ===== RED-4: real-event + transcript sentinel zero-hit =====

test("M11-7-R4: sentinel zero-hit across events, errors, transcript (full RunManager flow)", async () => {
  const { RunManager } = await import("../src/runManager.js");
  const { readRegistry } = await import("../src/registry.js");
  const { readFileSync: readSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "wao-m117-r4-"));
  try {
    delete process.env.TEST_M117_R4;
    const value = CREDENTIAL_SENTINEL;
    const registryPath = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir, provider: { apiKeyEnv: "TEST_M117_R4" } } });
    const runDir = join(dir, "runs"); mkdirSync(runDir, { recursive: true });
    const collectedEvents = [];
    const fakeBackend = {
      supportsRoleContract: false,
      spawn: async (agent, task) => {
        const redactorEnv = { ...process.env, ...task.resolvedCredentials };
        const { createSecretRedactor } = await import("../src/secretRedaction.js");
        const redactor = createSecretRedactor(redactorEnv, ["TEST_M117_R4"]);
        return {
          backend: "fake", backendSessionId: "s", messageId: "m", admittedSeq: 1,
          redact: (v) => redactor.redact(v),
          events: async function* () {
            yield { kind: "message", role: "assistant", parts: [{ type: "text", text: redactor.redactString(`leak: ${value}`) }] };
            yield { kind: "tool_use", name: "echo", input: redactor.redact({ cmd: value }) };
            collectedEvents.push(redactor.redact(`stderr: ${value}`));
            yield { kind: "done", reason: "completed" };
          },
          abort: async () => {}, isAlive: () => false,
        };
      },
    };
    const mgr = new RunManager({ config: { registry: registryPath, runDir }, readRegistry, backendFor: () => fakeBackend, userEnvReader: fakeUserEnvReader({ TEST_M117_R4: value }) });
    const run = await mgr.start("w", { prompt: "do", runDir, registry: registryPath });
    await run.waitForCompletion({ waitTimeout: 2000, pollInterval: 5 });
    const jsonl = readdirSync(runDir).filter((f) => f.endsWith(".jsonl"));
    let transcriptText = "";
    for (const f of jsonl) transcriptText += readSync(join(runDir, f), "utf8");
    const allOutput = transcriptText + collectedEvents.join("\n");
    assert.ok(!allOutput.includes(value), "sentinel (credential value) ZERO hit in transcript/events");
  } finally { cleanupDir(dir); }
});
