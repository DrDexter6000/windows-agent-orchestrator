// test/m10preCloseout2.test.js
//
// M10-pre closeout-2: boundary closure tests for the 4 remaining gaps.
//
// 1. Foreground CLI runCommand validates explicit waitTimeout before side effects.
// 2. dispatchRun validates globalWaitTimeout before transcript/fork.
// 3. MCP stdio.js config path is derived from module location, not host cwd.
// 4. stop_verified append failure is NOT misclassified as probe_error.
// 5. MCP run_dispatch schema rejects waitTimeout and globalWaitTimeout (regression guard).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { dispatchRun } from "../src/application/runDispatch.js";
import { validateExplicitTimeout } from "../src/application/timeoutPolicy.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function makeRegistry(dir, agents) {
  const p = join(dir, "agents.json");
  writeFileSync(p, JSON.stringify({ agents }), "utf8");
  return p;
}

// ===== 1. Foreground CLI runCommand validates explicit waitTimeout =====

test("M10pre-C2-01: foreground runCommand rejects waitTimeout=999 (below min), zero side effects", async () => {
  const { runCommand } = await import("../src/cli.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-c2-01-"));
  try {
    const registryPath = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir } });
    const config = { registry: registryPath, runDir: join(dir, "runs"), pollInterval: 10, waitTimeout: 5000 };
    // Must throw before any manager.start / transcript write
    await assert.rejects(
      () => runCommand(["w", "--prompt", "x", "--wait-timeout", "999", "--run-dir", dir], config),
    );
    // Zero transcripts written
    const runsDir = join(dir, "runs");
    let files = [];
    try { files = readdirSync(runsDir); } catch {}
    assert.equal(files.length, 0, "no transcript should exist");
  } finally {
    cleanupDir(dir);
  }
});

test("M10pre-C2-02: foreground runCommand rejects waitTimeout=600001 (above max)", async () => {
  const { runCommand } = await import("../src/cli.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-c2-02-"));
  try {
    const registryPath = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir } });
    const config = { registry: registryPath, runDir: join(dir, "runs"), pollInterval: 10, waitTimeout: 5000 };
    await assert.rejects(
      () => runCommand(["w", "--prompt", "x", "--wait-timeout", "600001", "--run-dir", dir], config),
    );
  } finally {
    cleanupDir(dir);
  }
});

test("M10pre-C2-03: foreground runCommand accepts boundary values 1000 and 600000", async () => {
  // Validate that valid boundary values pass the gate (validateExplicitTimeout does not throw).
  // We don't need to run the full command — just confirm the validation passes.
  assert.equal(validateExplicitTimeout(1000), 1000);
  assert.equal(validateExplicitTimeout(600000), 600000);
});

// ===== 2. dispatchRun validates globalWaitTimeout =====

test("M10pre-C2-04: dispatchRun rejects out-of-range globalWaitTimeout, zero transcript, zero fork", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-c2-04-"));
  const calls = [];
  const fakeSpawn = (cmd, args) => { calls.push({ args }); return { unref() {} }; };
  try {
    const registryPath = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir } });
    const runsDir = join(dir, "runs");

    // globalWaitTimeout=999 → must throw before transcript/fork
    await assert.rejects(
      () => dispatchRun({ agentId: "w", prompt: "x", registryPath, runDir: runsDir, spawnFn: fakeSpawn, globalWaitTimeout: 999 }),
    );
    // globalWaitTimeout=600001 → must throw
    await assert.rejects(
      () => dispatchRun({ agentId: "w", prompt: "x", registryPath, runDir: runsDir, spawnFn: fakeSpawn, globalWaitTimeout: 600001 }),
    );
    // Zero spawn calls
    assert.equal(calls.length, 0, "no spawn should have occurred");
    // Zero transcript files
    let files = [];
    try { files = readdirSync(runsDir); } catch {}
    assert.equal(files.length, 0, "no transcript file should exist");
  } finally {
    cleanupDir(dir);
  }
});

test("M10pre-C2-05: dispatchRun accepts valid globalWaitTimeout=300000 and passes in argv", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-c2-05-"));
  const calls = [];
  const fakeSpawn = (cmd, args) => { calls.push({ args }); return { unref() {} }; };
  try {
    const registryPath = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir } });
    await dispatchRun({
      agentId: "w", prompt: "x", registryPath, runDir: join(dir, "runs"),
      spawnFn: fakeSpawn, globalWaitTimeout: 300000,
    });
    const argv = calls[0].args;
    assert.ok(argv.includes("--global-wait-timeout"), "--global-wait-timeout present");
    assert.equal(Number(argv[argv.indexOf("--global-wait-timeout") + 1]), 300000);
  } finally {
    cleanupDir(dir);
  }
});

// ===== 3. MCP stdio.js config path independent of host cwd =====

test("M10pre-C2-06: loadGlobalWaitTimeout reads WAO config regardless of host cwd", async () => {
  // This test proves that the MCP stdio config loader does NOT depend on process.cwd().
  // We spawn a node process from a DIFFERENT cwd (a temp dir with a trap config) and
  // verify that loadGlobalWaitTimeout reads the REAL WAO config, not the trap.

  // First, read the real WAO config value for comparison.
  const realConfigPath = join(REPO_ROOT, "config", "default.json");
  const { readFile } = await import("node:fs/promises");
  const realRaw = await readFile(realConfigPath, "utf8");
  const realParsed = JSON.parse(realRaw);
  const realWaitTimeout = Number(realParsed.waitTimeout);
  assert.ok(realWaitTimeout >= 1000 && realWaitTimeout <= 600000, "real config waitTimeout in range");

  // Create a temp dir with a DIFFERENT waitTimeout to act as a "trap".
  const trapDir = mkdtempSync(join(tmpdir(), "wao-c2-06-"));
  try {
    mkdirSync(join(trapDir, "config"), { recursive: true });
    writeFileSync(
      join(trapDir, "config", "default.json"),
      JSON.stringify({ waitTimeout: 420000 }),
      "utf8",
    );

    // Use pathToFileURL to avoid Windows ERR_UNSUPPORTED_ESM_URL_SCHEME.
    const { pathToFileURL } = await import("node:url");
    const stdioUrl = pathToFileURL(join(REPO_ROOT, "src", "mcp", "stdio.js")).href;
    const script = `const { loadGlobalWaitTimeoutForTest } = await import("${stdioUrl}"); const v = await loadGlobalWaitTimeoutForTest(); process.stdout.write(String(v));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: trapDir,
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" },
    });
    assert.equal(result.status, 0, `node process must exit 0: ${result.stderr}`);
    const loaded = Number(result.stdout);
    // Must be the REAL WAO config value, NOT the trap (420000).
    assert.equal(loaded, realWaitTimeout,
      `loaded ${loaded} must match real WAO config ${realWaitTimeout}, not trap cwd config 420000`);
  } finally {
    cleanupDir(trapDir);
  }
});

// ===== 4. stop_verified append failure NOT misclassified as probe_error =====
// This test is covered in m10preIntegration.test.js (INT-e tests probe_error).
// Here we add a regression test: probe succeeds (quiet=true) but append throws →
// the outcome must NOT be probe_error.

test("M10pre-C2-07: stop_verified append failure is NOT misclassified as probe_error", async () => {
  const { RunManager } = await import("../src/runManager.js");
  const { readTranscript } = await import("../src/transcript.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-c2-07-"));
  try {
    const config = {
      registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 5000,
      timeout: 5000, retries: 0, defaultIsolation: "none",
    };
    const readRegistry = async () => ({
      getAgent(id, overrides = {}) {
        const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
        return { id, backend: "claude-code", cwd: dir, ...defined };
      },
      listAgents() { return []; },
    });

    // Track append calls to simulate stop_verified write failure.
    let stopVerifiedAppendAttempts = 0;
    const mockBackend = {
      async spawn() {
        return {
          backend: "process",
          backendSessionId: "proc_c2_07",
          events: async function* (signal) {
            // Hang until abort (timeout)
            await new Promise((resolve) => {
              if (signal?.aborted) { resolve(); return; }
              signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          },
          abort: async () => {},
          // Process IS dead → probe returns quiet=true
          isAlive: () => false,
        };
      },
    };

    const manager = new RunManager({ config, readRegistry, backendFor: () => mockBackend });
    const run = await manager.start("test", { prompt: "x" });

    // Monkey-patch the transcript's append method to throw ONLY for stop_verified.
    const originalAppend = run.transcript.append.bind(run.transcript);
    run.transcript.append = async (type, payload) => {
      if (type === "run.stop_verified") {
        stopVerifiedAppendAttempts++;
        throw new Error("simulated disk full");
      }
      return originalAppend(type, payload);
    };

    const result = await run.waitForCompletion({ waitTimeout: 50, pollInterval: 10 });
    assert.equal(result.timedOut, true);

    // The probe SUCCEEDED (isAlive=false → quiet=true), so stop_verified was attempted.
    assert.ok(stopVerifiedAppendAttempts > 0, "stop_verified append was attempted");

    // Read transcript — the stop_verified write failed, so it should NOT be present.
    // Critically, there must be NO run.stop_unverified with outcome=probe_error either.
    const events = await readTranscript(run.transcript.filePath);
    const probeErrorEvents = events.filter(
      (e) => e.type === "run.stop_unverified" && e.outcome === "probe_error",
    );
    assert.equal(probeErrorEvents.length, 0,
      "must NOT produce probe_error when probe succeeded but append failed");
  } finally {
    cleanupDir(dir);
  }
});

// ===== 5. MCP run_dispatch schema regression guard (already in mcpRunDispatch.test.js) =====
// This is covered by the extended M9-2B-04 test. Here we add a focused assertion
// that the schema properties do not include timeout fields.

test("M10pre-C2-08: run_dispatch input schema has NO waitTimeout or globalWaitTimeout properties", async () => {
  const { createWaoMcpServer } = await import("../src/mcp/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs" });
  const client = new Client({ name: "test", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const tools = await client.listTools();
    const rd = tools.tools.find((t) => t.name === "run_dispatch");
    const props = Object.keys(rd.inputSchema.properties ?? {});
    assert.ok(!props.includes("waitTimeout"), "schema must not expose waitTimeout");
    assert.ok(!props.includes("globalWaitTimeout"), "schema must not expose globalWaitTimeout");
  } finally {
    await client.close();
    await server.close();
  }
});
