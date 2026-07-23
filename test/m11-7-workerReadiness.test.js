// test/m11-7-workerReadiness.test.js
//
// M11-7: Worker Runtime Readiness + Windows user-env credential bridge.
//
// Proves:
//   A. Credential resolution SSOT (process.env > Windows User > missing),
//      ProcessBackend consumes it (child env + redactor both cover fallback).
//   B. Runtime readiness truth (certification stays distinct from availability;
//      registry_list shows runtimeAvailability; run_dispatch fails BEFORE
//      transcript/fork when a credential is missing).
//
// TDD: written against the current code, drives the GREEN implementation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { resolveCredentialEnv, resolveWorkerCredentialNames, assessWorkerReadiness, CREDENTIAL_SENTINEL } from "../src/application/credentialReadiness.js";

// ===== Helpers =====

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function makeRegistry(dir, agents) {
  const p = join(dir, "agents.json");
  writeFileSync(p, JSON.stringify({ agents }, null, 2), "utf8");
  return p;
}

// A fake user-env reader (injectable) that returns values for requested names.
function fakeUserEnvReader(map) {
  return async (name) => map[name];
}

// Create a Git repo (for workspace_select in dispatch tests).
function makeGitRepo(dir) {
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
}

// ===== Package A: credential resolution SSOT =====

// A-1: resolveCredentialEnv prefers process.env when present.
test("M11-7-A1: process.env present → used, user-env not consulted", async () => {
  const orig = process.env.TEST_M117_PROC;
  process.env.TEST_M117_PROC = "from-process-env";
  try {
    const reader = fakeUserEnvReader({ TEST_M117_PROC: "from-user-env" });
    const result = await resolveCredentialEnv("TEST_M117_PROC", { userEnvReader: reader });
    assert.equal(result.source, "process_env");
    assert.equal(result.value, "from-process-env");
  } finally {
    if (orig === undefined) delete process.env.TEST_M117_PROC; else process.env.TEST_M117_PROC = orig;
  }
});

// A-2: process.env missing, Windows User env has value → fallback used.
test("M11-7-A2: process.env missing, user-env present → fallback used", async () => {
  delete process.env.TEST_M117_FALLBACK;
  const reader = fakeUserEnvReader({ TEST_M117_FALLBACK: "from-user-env" });
  const result = await resolveCredentialEnv("TEST_M117_FALLBACK", { userEnvReader: reader });
  assert.equal(result.source, "user_env");
  assert.equal(result.value, "from-user-env");
});

// A-3: both missing → missing.
test("M11-7-A3: both missing → source=missing, value=undefined", async () => {
  delete process.env.TEST_M117_MISSING;
  const reader = fakeUserEnvReader({});
  const result = await resolveCredentialEnv("TEST_M117_MISSING", { userEnvReader: reader });
  assert.equal(result.source, "missing");
  assert.equal(result.value, undefined);
});

// A-4: user-env reader only receives the EXACT requested name (no bulk import).
test("M11-7-A4: user-env reader receives only the exact requested name", async () => {
  delete process.env.TEST_M117_EXACT;
  const seen = [];
  const reader = async (name) => { seen.push(name); return undefined; };
  await resolveCredentialEnv("TEST_M117_EXACT", { userEnvReader: reader });
  assert.deepEqual(seen, ["TEST_M117_EXACT"], "reader called with exactly the requested name");
});

// A-5: resolveWorkerCredentialNames handles provider.apiKeyEnv + legacy --api-key-env.
test("M11-7-A5: credential names from provider.apiKeyEnv and legacy --api-key-env", () => {
  // provider.apiKeyEnv (first-class)
  const a = resolveWorkerCredentialNames({ backend: "claude-code", provider: { apiKeyEnv: "DEEPSEEK_API_KEY" } });
  assert.ok(a.includes("DEEPSEEK_API_KEY"), "provider.apiKeyEnv resolved");
  // legacy --api-key-env in prependArgs
  const b = resolveWorkerCredentialNames({
    backend: "claude-code",
    prependArgs: ["--api-key-env", "DEEPSEEK_API_KEY", "--"],
  });
  assert.ok(b.includes("DEEPSEEK_API_KEY"), "legacy --api-key-env resolved");
  // codex static names
  const c = resolveWorkerCredentialNames({ backend: "codex" });
  assert.ok(c.includes("OPENAI_API_KEY") && c.includes("CODEX_HOME"), "codex static names");
  // no credential requirement
  const d = resolveWorkerCredentialNames({ backend: "claude-code" });
  assert.ok(Array.isArray(d));
});

// A-6: a worker with no credential names is ready.
test("M11-7-A6: worker with no credential requirement → ready", async () => {
  const r = await assessWorkerReadiness({
    agent: { backend: "claude-code", id: "plain" },
    userEnvReader: fakeUserEnvReader({}),
  });
  assert.equal(r.runtimeAvailability, "ready");
  assert.deepEqual(r.missingCredentialEnvNames, []);
});

// A-7: credential missing → credential_missing with bounded names.
test("M11-7-A7: credential missing → credential_missing + bounded names", async () => {
  delete process.env.TEST_M117_MISSING_A;
  const r = await assessWorkerReadiness({
    agent: { backend: "claude-code", id: "x", provider: { apiKeyEnv: "TEST_M117_MISSING_A" } },
    userEnvReader: fakeUserEnvReader({}),
  });
  assert.equal(r.runtimeAvailability, "credential_missing");
  assert.deepEqual(r.missingCredentialEnvNames, ["TEST_M117_MISSING_A"]);
});

// A-8: certification stays distinct from runtimeAvailability.
test("M11-7-A8: certification and runtimeAvailability are independent fields", async () => {
  // certified BUT credential missing
  delete process.env.TEST_M117_CERT_BUT_MISSING;
  const r = await assessWorkerReadiness({
    agent: { backend: "claude-code", id: "x", provider: { apiKeyEnv: "TEST_M117_CERT_BUT_MISSING" } },
    userEnvReader: fakeUserEnvReader({}),
  });
  assert.equal(r.runtimeAvailability, "credential_missing");
  // certification is NOT a field on the readiness result (it stays in inventory).
  assert.equal(r.certification, undefined, "readiness does not carry certification (kept separate)");
});

// ===== Package B: registry_list + run_dispatch readiness gate =====

// B-1: registry_list includes runtimeAvailability + missingCredentialEnvNames.
test("M11-7-B1: registry_list projects runtimeAvailability + missingCredentialEnvNames", async () => {
  const { getRegistryInventory } = await import("../src/application/registryInventory.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m117-b1-"));
  try {
    delete process.env.TEST_M117_INV_MISSING;
    const registryPath = makeRegistry(dir, {
      good: { backend: "claude-code", cwd: dir, provider: { apiKeyEnv: "TEST_M117_INV_PRESENT" } },
      bad: { backend: "claude-code", cwd: dir, provider: { apiKeyEnv: "TEST_M117_INV_MISSING" } },
    });
    process.env.TEST_M117_INV_PRESENT = "present-val";
    const agents = await getRegistryInventory({
      registryPath, runDir: dir,
      userEnvReader: fakeUserEnvReader({}),
    });
    const good = agents.find((a) => a.id === "good");
    const bad = agents.find((a) => a.id === "bad");
    assert.equal(good.runtimeAvailability, "ready");
    assert.deepEqual(good.missingCredentialEnvNames, []);
    assert.equal(bad.runtimeAvailability, "credential_missing");
    assert.deepEqual(bad.missingCredentialEnvNames, ["TEST_M117_INV_MISSING"]);
  } finally {
    delete process.env.TEST_M117_INV_PRESENT;
    cleanupDir(dir);
  }
});

// B-2: credential value never leaks into registry_list output.
test("M11-7-B2: credential value not in registry_list output", async () => {
  const { getRegistryInventory } = await import("../src/application/registryInventory.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m117-b2-"));
  try {
    process.env.TEST_M117_SECRET_VAL = "SUPER_SECRET_VALUE_12345678";
    const registryPath = makeRegistry(dir, {
      w: { backend: "claude-code", cwd: dir, provider: { apiKeyEnv: "TEST_M117_SECRET_VAL" } },
    });
    const agents = await getRegistryInventory({
      registryPath, runDir: dir,
      userEnvReader: fakeUserEnvReader({}),
    });
    const dumped = JSON.stringify(agents);
    assert.ok(!dumped.includes("SUPER_SECRET_VALUE_12345678"), "no secret value leak in inventory output");
  } finally {
    delete process.env.TEST_M117_SECRET_VAL;
    cleanupDir(dir);
  }
});

// B-3: run_dispatch fails BEFORE transcript/fork when credential missing.
test("M11-7-B3: run_dispatch rejects missing-credential worker (zero transcript, zero fork)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m117-b3-"));
  const wsDir = mkdtempSync(join(tmpdir(), "wao-m117-b3-ws-"));
  try {
    makeGitRepo(wsDir);
    delete process.env.TEST_M117_DISPATCH_MISSING;
    const registryPath = makeRegistry(dir, {
      w: { backend: "claude-code", cwd: wsDir, provider: { apiKeyEnv: "TEST_M117_DISPATCH_MISSING" } },
    });
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    // MCP server with a fake dispatcher that MUST NOT be called.
    let dispatchCalls = 0;
    const { createWaoMcpServer } = await import("../src/mcp/server.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client");
    const server = createWaoMcpServer({
      registryPath, runDir,
      dispatchRunFn: async () => { dispatchCalls += 1; return { runId: "x", accepted: true, state: "pending" }; },
      userEnvReader: fakeUserEnvReader({}),
    });
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      // Bind a workspace first so the rejection is specifically credential_missing.
      await client.callTool({ name: "workspace_select", arguments: { workspaceRoot: wsDir } });
      const res = await client.callTool({ name: "run_dispatch", arguments: { agentId: "w", prompt: "do" } });
      assert.ok(res.isError, "run_dispatch returned an error");
      const text = res.content.find((b) => b.type === "text").text;
      assert.match(text, /missing a required credential/i, "error is the credential-missing rejection");
      assert.equal(dispatchCalls, 0, "dispatcher was NOT called (zero fork)");
      // Zero transcript files created.
      const jsonl = existsSync(runDir) ? readdirSync(runDir).filter((f) => f.endsWith(".jsonl")) : [];
      assert.equal(jsonl.length, 0, "zero transcript files");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir); cleanupDir(wsDir);
  }
});

// B-4: run_dispatch proceeds when credential is present (via user-env fallback).
test("M11-7-B4: run_dispatch proceeds when credential present via user-env fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m117-b4-"));
  const wsDir = mkdtempSync(join(tmpdir(), "wao-m117-b4-ws-"));
  try {
    makeGitRepo(wsDir);
    delete process.env.TEST_M117_DISPATCH_OK;
    const registryPath = makeRegistry(dir, {
      w: { backend: "claude-code", cwd: wsDir, provider: { apiKeyEnv: "TEST_M117_DISPATCH_OK" } },
    });
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    let dispatchCalls = 0;
    const { createWaoMcpServer } = await import("../src/mcp/server.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client");
    const server = createWaoMcpServer({
      registryPath, runDir,
      dispatchRunFn: async () => { dispatchCalls += 1; return { runId: "r1", accepted: true, state: "pending" }; },
      userEnvReader: fakeUserEnvReader({ TEST_M117_DISPATCH_OK: "fallback-val-12345678" }),
    });
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      await client.callTool({ name: "workspace_select", arguments: { workspaceRoot: wsDir } });
      const res = await client.callTool({ name: "run_dispatch", arguments: { agentId: "w", prompt: "do" } });
      assert.ok(!res.isError, "run_dispatch accepted");
      assert.equal(dispatchCalls, 1, "dispatcher called once");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir); cleanupDir(wsDir);
  }
});

// A-9: ProcessBackend child env includes user-env fallback value.
test("M11-7-A9: ProcessBackend child env includes resolved fallback credential", async () => {
  const { ProcessBackend } = await import("../src/backends/processBackend.js");
  const { FakeStreamParser } = await import("./_m117-fakes.mjs");
  delete process.env.TEST_M117_PB_FALLBACK;
  // Record the spawned child env via a fake spawn.
  const captured = {};
  const fakeSpawn = (binary, args, opts) => {
    Object.assign(captured, opts.env);
    const child = {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      stdout: { on() {} },
      stderr: { on() {} },
      once(ev, cb) { if (ev === "spawn") setImmediate(cb); if (ev === "error") {} },
      on(ev, cb) { if (ev === "close") setImmediate(() => cb(0)); },
      kill() {},
    };
    return child;
  };
  const backend = new ProcessBackend({
    parserClass: FakeStreamParser,
    buildArgs: () => [],
    credentialEnvNames: () => ["TEST_M117_PB_FALLBACK"],
    spawnFn: fakeSpawn,
  });
  // task carries resolvedCredentials (as the runner/RunManager would pass them).
  await backend.spawn(
    { id: "w", cwd: ".", binary: "fake-binary" },
    { prompt: "x", resolvedCredentials: { TEST_M117_PB_FALLBACK: "pb-fallback-val-12345678" } },
  );
  assert.equal(captured.TEST_M117_PB_FALLBACK, "pb-fallback-val-12345678", "child env has the fallback value");
});

// A-10: fallback credential value is redacted (sentinel zero-hit).
test("M11-7-A10: resolved credential value redacted in handle output", async () => {
  const { ProcessBackend } = await import("../src/backends/processBackend.js");
  const { FakeStreamParser } = await import("./_m117-fakes.mjs");
  delete process.env.TEST_M117_PB_REDACT;
  const secret = "REDACTABLE_FALLBACK_SECRET_99";
  let handle;
  const fakeSpawn = () => {
    const child = {
      pid: 1, exitCode: null, signalCode: null,
      stdout: { on(ev, cb) { if (ev === "data") setImmediate(() => cb(Buffer.from(secret))); } },
      stderr: { on() {} },
      once(ev, cb) { if (ev === "spawn") setImmediate(cb); },
      on(ev, cb) { if (ev === "close") setImmediate(() => cb(0)); },
      kill() {},
    };
    return child;
  };
  const backend = new ProcessBackend({
    parserClass: FakeStreamParser,
    buildArgs: () => [],
    credentialEnvNames: () => ["TEST_M117_PB_REDACT"],
    spawnFn: fakeSpawn,
  });
  handle = await backend.spawn(
    { id: "w", cwd: ".", binary: "fake-binary" },
    { prompt: "x", resolvedCredentials: { TEST_M117_PB_REDACT: secret } },
  );
  // The redactor must have scrubbed the secret from a value passed through it.
  const redacted = handle.redact(`prefix ${secret} suffix`);
  assert.ok(!redacted.includes(secret), "resolved secret redacted by handle.redact");
  assert.ok(redacted.includes("[REDACTED:"), "redaction marker present");
  // Sentinel zero-hit assertion.
  assert.ok(!redacted.includes(CREDENTIAL_SENTINEL));
});
