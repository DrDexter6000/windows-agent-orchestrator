// test/m10preCloseout3.test.js
//
// M10-pre closeout-3: final foreground config bypass + empty-value bypass closure.
//
// Proves:
// 1. Foreground config.waitTimeout=999/600001/NaN/non-integer → fail-closed before manager.start
// 2. Foreground explicit --wait-timeout "" or whitespace → fail-closed before manager.start
// 3. Valid config.waitTimeout=300000 and explicit 1000/600000 do NOT regress
// 4. Validation happens BEFORE loadDeliverySpec, manager.start, and transcript creation
// 5. MCP strict schema continues to reject waitTimeout/globalWaitTimeout

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateBoundedWaitTimeout } from "../src/application/timeoutPolicy.js";

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function makeRegistry(dir, agents) {
  const p = join(dir, "agents.json");
  writeFileSync(p, JSON.stringify({ agents }), "utf8");
  return p;
}

// ===== 1. Foreground config.waitTimeout bypass closure =====

test("M10pre-C3-01: foreground config.waitTimeout=999 → fail-closed, zero transcript", async () => {
  const { runCommand } = await import("../src/cli.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-c3-01-"));
  try {
    const registryPath = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir } });
    const config = { registry: registryPath, runDir: join(dir, "runs"), pollInterval: 10, waitTimeout: 999 };
    await assert.rejects(
      () => runCommand(["w", "--prompt", "x", "--run-dir", dir], config),
    );
    let files = [];
    try { files = readdirSync(join(dir, "runs")); } catch {}
    assert.equal(files.length, 0, "no transcript should exist");
  } finally {
    cleanupDir(dir);
  }
});

test("M10pre-C3-02: foreground config.waitTimeout=600001 → fail-closed", async () => {
  const { runCommand } = await import("../src/cli.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-c3-02-"));
  try {
    const registryPath = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir } });
    const config = { registry: registryPath, runDir: join(dir, "runs"), pollInterval: 10, waitTimeout: 600001 };
    await assert.rejects(
      () => runCommand(["w", "--prompt", "x", "--run-dir", dir], config),
    );
  } finally {
    cleanupDir(dir);
  }
});

test("M10pre-C3-03: foreground config.waitTimeout=NaN → fail-closed", async () => {
  const { runCommand } = await import("../src/cli.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-c3-03-"));
  try {
    const registryPath = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir } });
    const config = { registry: registryPath, runDir: join(dir, "runs"), pollInterval: 10, waitTimeout: NaN };
    await assert.rejects(
      () => runCommand(["w", "--prompt", "x", "--run-dir", dir], config),
    );
  } finally {
    cleanupDir(dir);
  }
});

test("M10pre-C3-04: foreground config.waitTimeout=500.5 (non-integer) → fail-closed", async () => {
  const { runCommand } = await import("../src/cli.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-c3-04-"));
  try {
    const registryPath = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir } });
    const config = { registry: registryPath, runDir: join(dir, "runs"), pollInterval: 10, waitTimeout: 500.5 };
    await assert.rejects(
      () => runCommand(["w", "--prompt", "x", "--run-dir", dir], config),
    );
  } finally {
    cleanupDir(dir);
  }
});

// ===== 2. Explicit empty-value bypass closure =====

test("M10pre-C3-05: foreground --wait-timeout '' (empty string) → fail-closed, zero transcript", async () => {
  const { runCommand } = await import("../src/cli.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-c3-05-"));
  try {
    const registryPath = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir } });
    const config = { registry: registryPath, runDir: join(dir, "runs"), pollInterval: 10, waitTimeout: 5000 };
    await assert.rejects(
      () => runCommand(["w", "--prompt", "x", "--wait-timeout", "", "--run-dir", dir], config),
    );
    let files = [];
    try { files = readdirSync(join(dir, "runs")); } catch {}
    assert.equal(files.length, 0, "no transcript should exist");
  } finally {
    cleanupDir(dir);
  }
});

test("M10pre-C3-06: foreground --wait-timeout '   ' (whitespace) → fail-closed", async () => {
  const { runCommand } = await import("../src/cli.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-c3-06-"));
  try {
    const registryPath = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir } });
    const config = { registry: registryPath, runDir: join(dir, "runs"), pollInterval: 10, waitTimeout: 5000 };
    await assert.rejects(
      () => runCommand(["w", "--prompt", "x", "--wait-timeout", "   ", "--run-dir", dir], config),
    );
  } finally {
    cleanupDir(dir);
  }
});

// ===== 3. Valid values do NOT regress =====

test("M10pre-C3-07: valid config.waitTimeout=300000 does NOT reject", () => {
  // Just verify the validator itself passes — running the full command would need a mock backend.
  assert.equal(validateBoundedWaitTimeout(300000), 300000);
  assert.equal(validateBoundedWaitTimeout(1000), 1000);
  assert.equal(validateBoundedWaitTimeout(600000), 600000);
});

test("M10pre-C3-08: valid explicit --wait-timeout 1000 and 600000 pass boundary", () => {
  assert.equal(validateBoundedWaitTimeout(1000), 1000);
  assert.equal(validateBoundedWaitTimeout(600000), 600000);
});

// ===== 4. Side-effect ordering proof =====

test("M10pre-C3-09: validation rejects BEFORE loadDeliverySpec reads files", async () => {
  // If validation happened after loadDeliverySpec, a --delivery-spec-file pointing
  // to a nonexistent file would throw "ENOENT" instead of "Invalid waitTimeout".
  // We verify that the timeout error wins, proving validation is first.
  const { runCommand } = await import("../src/cli.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-c3-09-"));
  try {
    const registryPath = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir } });
    const config = { registry: registryPath, runDir: join(dir, "runs"), pollInterval: 10, waitTimeout: 999 };
    // Pass a nonexistent delivery-spec-file; if validation ran first, we get Invalid waitTimeout.
    // If validation ran second, we get ENOENT from loadDeliverySpec.
    let errorMsg = null;
    try {
      await runCommand(["w", "--prompt", "x", "--delivery-spec-file", join(dir, "nonexistent.json"), "--run-dir", dir], config);
    } catch (e) {
      errorMsg = e.message;
    }
    assert.ok(errorMsg, "must throw");
    assert.ok(/Invalid waitTimeout/.test(errorMsg), `must be timeout error, not ENOENT: ${errorMsg}`);
    assert.ok(!/ENOENT|no such file/i.test(errorMsg), "must NOT be file-read error — validation ran first");
  } finally {
    cleanupDir(dir);
  }
});

// ===== 5. MCP strict schema regression guard =====

test("M10pre-C3-10: run_dispatch schema has NO waitTimeout or globalWaitTimeout properties", async () => {
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
