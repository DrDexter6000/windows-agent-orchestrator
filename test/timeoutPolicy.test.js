// test/timeoutPolicy.test.js
//
// M10-pre: timeout precedence SSOT + cleanup evidence — TDD tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveWaitTimeout } from "../src/application/timeoutPolicy.js";

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ===== resolveWaitTimeout SSOT tests =====

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

test("M10pre-04: default 300000 when all sources missing", () => {
  const r = resolveWaitTimeout({ explicit: undefined, agentWaitTimeout: undefined, globalWaitTimeout: undefined });
  assert.equal(r.ms, 300000);
  assert.equal(r.source, "default");
});

test("M10pre-05: invalid values rejected", () => {
  for (const bad of [NaN, -1, 0, "abc", Infinity]) {
    assert.throws(() => resolveWaitTimeout({ explicit: bad }),
      `invalid explicit timeout must throw: ${bad}`);
  }
});

test("M10pre-06: boundary values accepted", () => {
  for (const ok of [1, 50, 1000, 600000, 120000, 300000]) {
    const r = resolveWaitTimeout({ explicit: ok });
    assert.equal(r.ms, ok);
  }
});

// ===== dispatchRun: no default timeout in argv =====

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
