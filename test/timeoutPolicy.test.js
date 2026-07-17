// test/timeoutPolicy.test.js
//
// M10-pre closeout: timeout precedence SSOT + explicit range validation — TDD tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveWaitTimeout, validateExplicitTimeout } from "../src/application/timeoutPolicy.js";

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ===== resolveWaitTimeout SSOT precedence tests =====

test("M10pre-01: explicit request override wins over agent and global", () => {
  const r = resolveWaitTimeout({ explicit: 99999, agentWaitTimeout: 200000, globalWaitTimeout: 300000 });
  assert.equal(r.ms, 99999);
  assert.equal(r.source, "explicit");
});

test("M10pre-02: agent.waitTimeout used when no explicit override", () => {
  const r = resolveWaitTimeout({ explicit: undefined, agentWaitTimeout: 200000, globalWaitTimeout: 300000 });
  assert.equal(r.ms, 200000);
  assert.equal(r.source, "agent");
});

test("M10pre-03: global config fallback when neither explicit nor agent", () => {
  const r = resolveWaitTimeout({ explicit: undefined, agentWaitTimeout: undefined, globalWaitTimeout: 300000 });
  assert.equal(r.ms, 300000);
  assert.equal(r.source, "global");
});

test("M10pre-04: disabled when all sources missing (M10-pre3)", () => {
  const r = resolveWaitTimeout({ explicit: undefined, agentWaitTimeout: undefined, globalWaitTimeout: undefined });
  assert.equal(r.ms, null);
  assert.equal(r.source, "disabled");
  assert.equal(r.enabled, false);
});

// resolveWaitTimeout is a pure type-checker (positive integer), NOT a range gate.
// Range enforcement for the explicit tier is the boundary's job.
test("M10pre-04b: resolveWaitTimeout type-checks but does not range-check", () => {
  for (const ok of [1, 50, 1000, 600000, 999999]) {
    const r = resolveWaitTimeout({ explicit: ok });
    assert.equal(r.ms, ok);
  }
});

test("M10pre-05: invalid types rejected by resolveWaitTimeout", () => {
  for (const bad of [NaN, -1, 0, "abc", Infinity, 0.5]) {
    assert.throws(() => resolveWaitTimeout({ explicit: bad }),
      `invalid timeout must throw: ${bad}`);
  }
});

// ===== validateExplicitTimeout: production boundary gate =====

test("M10pre-06: validateExplicitTimeout accepts in-range values", () => {
  for (const ok of [1000, 600000, 120000, 300000, 99999]) {
    assert.equal(validateExplicitTimeout(ok), ok);
  }
});

test("M10pre-06b: validateExplicitTimeout rejects below minimum (999)", () => {
  for (const bad of [999, 1, 50, 0]) {
    assert.throws(() => validateExplicitTimeout(bad), `must reject: ${bad}`);
  }
});

test("M10pre-06c: validateExplicitTimeout rejects above maximum (600001)", () => {
  for (const bad of [600001, 999999]) {
    assert.throws(() => validateExplicitTimeout(bad), `must reject: ${bad}`);
  }
});

test("M10pre-06d: validateExplicitTimeout rejects non-integer/non-finite", () => {
  for (const bad of [NaN, Infinity, "abc", 500.5, null]) {
    assert.throws(() => validateExplicitTimeout(bad), `must reject: ${bad}`);
  }
});

// ===== dispatchRun: explicit timeout validation BEFORE transcript/fork =====

test("M10pre-07: dispatchRun without explicit timeout omits --wait-timeout from argv", async () => {
  const { dispatchRun } = await import("../src/application/runDispatch.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m10pre-07-"));
  const calls = [];
  const fakeSpawn = (cmd, args) => { calls.push({ args }); return { unref() {} }; };
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    await dispatchRun({ agentId: "w", prompt: "x", registryPath, runDir: join(dir, "runs"), spawnFn: fakeSpawn });
    const argv = calls[0].args;
    assert.ok(!argv.includes("--wait-timeout"), "no --wait-timeout when not explicitly set");
  } finally { cleanupDir(dir); }
});

test("M10pre-08: dispatchRun with explicit timeout passes it in argv", async () => {
  const { dispatchRun } = await import("../src/application/runDispatch.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m10pre-08-"));
  const calls = [];
  const fakeSpawn = (cmd, args) => { calls.push({ args }); return { unref() {} }; };
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    await dispatchRun({ agentId: "w", prompt: "x", registryPath, runDir: join(dir, "runs"), spawnFn: fakeSpawn, waitTimeout: 99000 });
    const argv = calls[0].args;
    assert.ok(argv.includes("--wait-timeout"), "--wait-timeout present when explicit");
    assert.equal(Number(argv[argv.indexOf("--wait-timeout") + 1]), 99000);
  } finally { cleanupDir(dir); }
});

test("M10pre-08b: dispatchRun passes --global-wait-timeout when provided", async () => {
  const { dispatchRun } = await import("../src/application/runDispatch.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m10pre-08b-"));
  const calls = [];
  const fakeSpawn = (cmd, args) => { calls.push({ args }); return { unref() {} }; };
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    await dispatchRun({
      agentId: "w", prompt: "x", registryPath, runDir: join(dir, "runs"),
      spawnFn: fakeSpawn, globalWaitTimeout: 300000,
    });
    const argv = calls[0].args;
    assert.ok(argv.includes("--global-wait-timeout"), "--global-wait-timeout present");
    assert.equal(Number(argv[argv.indexOf("--global-wait-timeout") + 1]), 300000);
  } finally { cleanupDir(dir); }
});

test("M10pre-09: dispatchRun with out-of-range explicit timeout throws, zero transcript, zero fork", async () => {
  const { dispatchRun } = await import("../src/application/runDispatch.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m10pre-09-"));
  const calls = [];
  const fakeSpawn = (cmd, args) => { calls.push({ args }); return { unref() {} }; };
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    const runsDir = join(dir, "runs");
    // 999 < MIN(1000) → must throw before any transcript/fork
    await assert.rejects(
      () => dispatchRun({ agentId: "w", prompt: "x", registryPath, runDir: runsDir, spawnFn: fakeSpawn, waitTimeout: 999 }),
    );
    // 600001 > MAX(600000) → must throw
    await assert.rejects(
      () => dispatchRun({ agentId: "w", prompt: "x", registryPath, runDir: runsDir, spawnFn: fakeSpawn, waitTimeout: 600001 }),
    );
    // Zero spawn calls — no fork happened
    assert.equal(calls.length, 0, "no spawn should have occurred");
    // Zero transcript files written
    let files = [];
    try { files = readdirSync(runsDir); } catch {}
    assert.equal(files.length, 0, "no transcript file should exist");
  } finally { cleanupDir(dir); }
});

// ===== Dependency guard =====

test("M10pre-10: src/application imports no commands/mcp/SDK/zod", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const appDir = join(process.cwd(), "src", "application");
  const forbidden = /(?:from\s+['"](?:\.\.\/commands\/|.*commands\/|\.\.\/mcp\/|.*mcp\/|@modelcontextprotocol|zod))/;
  for (const f of (await readdir(appDir)).filter((f) => f.endsWith(".js"))) {
    const content = await readFile(join(appDir, f), "utf8");
    for (const line of content.split("\n").filter((l) => l.trim().startsWith("import"))) {
      assert.ok(!forbidden.test(line), `src/application/${f}: ${line.trim()}`);
    }
  }
});
