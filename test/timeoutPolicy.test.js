// test/timeoutPolicy.test.js
//
// M10-pre: timeout precedence SSOT + cleanup evidence — TDD tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveWaitTimeout } from "../src/application/timeoutPolicy.js";
import { dispatchRun } from "../src/application/runDispatch.js";

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ===== resolveWaitTimeout SSOT tests =====

test("M10pre-01: explicit request override wins over agent and global", () => {
  const r = resolveWaitTimeout({
    explicit: 99999, agentWaitTimeout: 200000, globalWaitTimeout: 300000,
  });
  assert.equal(r.ms, 99999);
  assert.equal(r.source, "explicit");
});

test("M10pre-02: agent.waitTimeout used when no explicit override", () => {
  const r = resolveWaitTimeout({
    explicit: undefined, agentWaitTimeout: 200000, globalWaitTimeout: 300000,
  });
  assert.equal(r.ms, 200000);
  assert.equal(r.source, "agent");
});

test("M10pre-03: global config fallback when neither explicit nor agent", () => {
  const r = resolveWaitTimeout({
    explicit: undefined, agentWaitTimeout: undefined, globalWaitTimeout: 300000,
  });
  assert.equal(r.ms, 300000);
  assert.equal(r.source, "global");
});

test("M10pre-04: default 300000 when all sources missing", () => {
  const r = resolveWaitTimeout({ explicit: undefined, agentWaitTimeout: undefined, globalWaitTimeout: undefined });
  assert.equal(r.ms, 300000);
  assert.equal(r.source, "default");
});

test("M10pre-05: invalid values rejected", () => {
  for (const bad of [NaN, -1, 0, 999, 600001, "abc", true, Infinity]) {
    assert.throws(() => resolveWaitTimeout({ explicit: bad, agentWaitTimeout: undefined, globalWaitTimeout: undefined }),
      `invalid explicit timeout must throw: ${bad}`);
  }
});

test("M10pre-06: boundary values accepted", () => {
  for (const ok of [1000, 600000, 120000, 300000]) {
    const r = resolveWaitTimeout({ explicit: ok });
    assert.equal(r.ms, ok);
  }
});

// ===== dispatchRun timeout propagation =====

test("M10pre-07: dispatchRun without explicit timeout uses global 300000, not hardcoded 120000", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m10pre-07-"));
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => { calls.push({ args }); return { unref() {} }; };
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    await dispatchRun({
      agentId: "w", prompt: "x", registryPath, runDir: join(dir, "runs"),
      spawnFn: fakeSpawn,
      globalWaitTimeout: 300000,
    });
    const argv = calls[0].args;
    const idx = argv.indexOf("--wait-timeout");
    const val = Number(argv[idx + 1]);
    assert.equal(val, 300000, "dispatchRun must pass global 300000, not hardcoded 120000");
  } finally { cleanupDir(dir); }
});

test("M10pre-08: dispatchRun with agentWaitTimeout param uses agent value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m10pre-08-"));
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => { calls.push({ args }); return { unref() {} }; };
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    await dispatchRun({
      agentId: "w", prompt: "x", registryPath, runDir: join(dir, "runs"),
      spawnFn: fakeSpawn,
      agentWaitTimeout: 450000,
      globalWaitTimeout: 300000,
    });
    const argv = calls[0].args;
    const val = Number(argv[argv.indexOf("--wait-timeout") + 1]);
    assert.equal(val, 450000, "dispatchRun must use agentWaitTimeout 450000");
  } finally { cleanupDir(dir); }
});

test("M10pre-09: explicit CLI override still wins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m10pre-09-"));
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => { calls.push({ args }); return { unref() {} }; };
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir, waitTimeout: 450000 } } }), "utf8");
    await dispatchRun({
      agentId: "w", prompt: "x", registryPath, runDir: join(dir, "runs"),
      spawnFn: fakeSpawn,
      waitTimeout: 99000,
      globalWaitTimeout: 300000,
    });
    const argv = calls[0].args;
    const val = Number(argv[argv.indexOf("--wait-timeout") + 1]);
    assert.equal(val, 99000, "explicit override must win");
  } finally { cleanupDir(dir); }
});

// ===== Dependency guard =====

test("M10pre-10: src/application/timeoutPolicy.js imports no commands/mcp/SDK/zod", async () => {
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
