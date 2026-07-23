// test/m11-8-leadPreflight.test.js
//
// M11-8A: Lead single-call preflight (lead_preflight) — advisory aggregator.
//
// Covers the 15 required behaviors + the advisory-independence tests:
//   - single call selects workspace + readiness + active runs
//   - safe projection (no paths/creds/prompts/PIDs)
//   - idempotent re-select
//   - failed selection leaves prior selection intact
//   - each section settles independently (runs_list failure ≠ swallow workspace)
//   - advisory warning does not block an independent run_dispatch
//   - Lead can get a different conclusion from a direct tool
//   - no PASS/FAIL verdict; complete is mechanical readability only

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { aggregateLeadPreflight } from "../src/application/leadPreflight.js";

// ===== Helpers =====

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function makeGitRepo(dir) {
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

function makeRegistry(dir, agents) {
  const p = join(dir, "agents.json");
  writeFileSync(p, JSON.stringify({ agents }, null, 2), "utf8");
  return p;
}

async function buildClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

const noopReader = async () => undefined;

// ===== RED-1: lead_preflight now exists + discoverable =====

test("M11-8-G1: lead_preflight is registered and discoverable", async () => {
  const { createWaoMcpServer } = await import("../src/mcp/server.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m118-g1-"));
  try {
    const reg = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir } });
    const server = createWaoMcpServer({ registryPath: reg, runDir: join(dir, "runs"), userEnvReader: noopReader });
    const client = await buildClient(server);
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.some((t) => t.name === "lead_preflight"), "lead_preflight discoverable");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

// ===== 1. unbound + valid workspaceRoot → source=lead_session =====

test("M11-8-1: unbound + valid workspaceRoot → single call binds lead_session", async () => {
  const { createWaoMcpServer } = await import("../src/mcp/server.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m118-1-"));
  const ws = mkdtempSync(join(tmpdir(), "wao-m118-1-ws-"));
  try {
    makeGitRepo(ws);
    const reg = makeRegistry(dir, { w: { backend: "claude-code", cwd: ws } });
    const server = createWaoMcpServer({ registryPath: reg, runDir: join(dir, "runs"), userEnvReader: noopReader });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "lead_preflight", arguments: { workspaceRoot: ws } });
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(parsed.workspace.bound, true);
      assert.equal(parsed.workspace.source, "lead_session");
      assert.ok(parsed.workspace.gitHead);
      assert.equal(parsed.complete, true);
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); cleanupDir(ws); }
});

// ===== 2. idempotent re-select =====

test("M11-8-2: re-selecting same repo is idempotent", async () => {
  const { createWaoMcpServer } = await import("../src/mcp/server.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m118-2-"));
  const ws = mkdtempSync(join(tmpdir(), "wao-m118-2-ws-"));
  try {
    makeGitRepo(ws);
    const reg = makeRegistry(dir, { w: { backend: "claude-code", cwd: ws } });
    const server = createWaoMcpServer({ registryPath: reg, runDir: join(dir, "runs"), userEnvReader: noopReader });
    const client = await buildClient(server);
    try {
      const r1 = await client.callTool({ name: "lead_preflight", arguments: { workspaceRoot: ws } });
      const r2 = await client.callTool({ name: "lead_preflight", arguments: { workspaceRoot: ws } });
      const p1 = JSON.parse(r1.content.find((b) => b.type === "text").text);
      const p2 = JSON.parse(r2.content.find((b) => b.type === "text").text);
      assert.equal(p1.workspace.source, "lead_session");
      assert.equal(p2.workspace.source, "lead_session");
      assert.equal(p1.workspace.gitHead, p2.workspace.gitHead);
      assert.ok(!r1.isError && !r2.isError);
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); cleanupDir(ws); }
});

// ===== 3. illegal/subdir/non-Git rejected; prior selection intact =====

test("M11-8-3: bad workspaceRoot rejected, prior selection intact", async () => {
  const { createWaoMcpServer } = await import("../src/mcp/server.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m118-3-"));
  const ws = mkdtempSync(join(tmpdir(), "wao-m118-3-ws-"));
  const notGit = mkdtempSync(join(tmpdir(), "wao-m118-3-nogit-"));
  try {
    makeGitRepo(ws);
    const reg = makeRegistry(dir, { w: { backend: "claude-code", cwd: ws } });
    const server = createWaoMcpServer({ registryPath: reg, runDir: join(dir, "runs"), userEnvReader: noopReader });
    const client = await buildClient(server);
    try {
      // Select valid first.
      await client.callTool({ name: "lead_preflight", arguments: { workspaceRoot: ws } });
      // Now a bad select via lead_preflight.
      const res = await client.callTool({ name: "lead_preflight", arguments: { workspaceRoot: notGit } });
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      // Selection failed → warning, but prior lead_session selection intact.
      assert.ok(parsed.warnings.some((w) => /selection failed/i.test(w)));
      assert.equal(parsed.workspace.bound, true);
      assert.equal(parsed.workspace.source, "lead_session");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); cleanupDir(ws); cleanupDir(notGit); }
});

// ===== 4. worker inventory preserves certified/conditional + credentialAvailability =====

test("M11-8-4: workers preserve certification + credentialAvailability", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m118-4-"));
  try {
    delete process.env.TEST_M118_GOOD;
    process.env.TEST_M118_GOOD = "test-key-good";
    const reg = makeRegistry(dir, {
      good: { backend: "claude-code", cwd: dir, provider: { apiKeyEnv: "TEST_M118_GOOD" } },
      bad: { backend: "claude-code", cwd: dir, provider: { apiKeyEnv: "TEST_M118_BAD" } },
      plain: { backend: "codex", cwd: dir },
    });
    const summaryDir = join(dir, "runs"); mkdirSync(summaryDir, { recursive: true });
    writeFileSync(join(summaryDir, "reliability-summary.json"), JSON.stringify({
      workers: { good: { status: "certified" }, bad: { status: "conditional" } },
    }), "utf8");
    const result = await aggregateLeadPreflight({
      workspaceBinding: { bound: true, source: "lead_session", root: dir, gitHead: "a".repeat(40), dirty: false },
      registryPath: reg, runDir: summaryDir, userEnvReader: noopReader,
    });
    const good = result.workers.find((w) => w.id === "good");
    const bad = result.workers.find((w) => w.id === "bad");
    const plain = result.workers.find((w) => w.id === "plain");
    assert.equal(good.certification, "certified");
    assert.equal(good.credentialAvailability, "available");
    assert.equal(bad.certification, "conditional");
    assert.equal(bad.credentialAvailability, "missing");
    assert.equal(plain.credentialAvailability, "not_required");
  } finally {
    delete process.env.TEST_M118_GOOD;
    cleanupDir(dir);
  }
});

// ===== 5. active runs recoverable; empty list OK =====

test("M11-8-5: active runs recoverable; empty list is fine", async () => {
  let listCalls = 0;
  const fakeListRuns = async () => { listCalls += 1; return { runs: [], matchedCount: 0 }; };
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: true, source: "lead_session", root: "/repo", gitHead: "b".repeat(40), dirty: false },
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => [],
    listRunsFn: fakeListRuns,
  });
  assert.equal(listCalls, 1);
  assert.deepEqual(result.activeRuns, []);
  assert.equal(result.checkStatus.activeRuns, "observed");
});

// ===== 6. no path/cred/prompt/PID/session leak =====

test("M11-8-6: output leaks no paths, credential values, prompts, PIDs, sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m118-6-"));
  try {
    process.env.TEST_M118_SECRET = "test-key-leakcheck";
    const reg = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir, provider: { apiKeyEnv: "TEST_M118_SECRET" } } });
    const result = await aggregateLeadPreflight({
      workspaceBinding: { bound: true, source: "lead_session", root: dir, gitHead: "c".repeat(40), dirty: false },
      registryPath: reg, runDir: join(dir, "runs"), userEnvReader: noopReader,
    });
    const dumped = JSON.stringify(result);
    assert.ok(!dumped.includes("test-key-leakcheck"), "no credential value leak");
    assert.ok(!dumped.includes(dir.replace(/\\/g, "/")), "no workspace absolute path leak");
  } finally {
    delete process.env.TEST_M118_SECRET;
    cleanupDir(dir);
  }
});

// ===== 7. no config writes =====

test("M11-8-7: lead_preflight writes no .codex/global/project config", async () => {
  const { createWaoMcpServer } = await import("../src/mcp/server.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m118-7-"));
  const ws = mkdtempSync(join(tmpdir(), "wao-m118-7-ws-"));
  try {
    makeGitRepo(ws);
    const before = new Set(readdirSync(ws));
    const reg = makeRegistry(dir, { w: { backend: "claude-code", cwd: ws } });
    const server = createWaoMcpServer({ registryPath: reg, runDir: join(dir, "runs"), userEnvReader: noopReader });
    const client = await buildClient(server);
    try {
      await client.callTool({ name: "lead_preflight", arguments: { workspaceRoot: ws } });
      await client.callTool({ name: "lead_preflight", arguments: {} });
    } finally { await client.close(); await server.close(); }
    const after = new Set(readdirSync(ws));
    assert.deepEqual([...after].filter((f) => !before.has(f)), [], "no files created in target repo");
  } finally { cleanupDir(dir); cleanupDir(ws); }
});

// ===== 8. no run/transcript/worktree/branch =====

test("M11-8-8: lead_preflight creates no run/transcript/worktree", async () => {
  const { createWaoMcpServer } = await import("../src/mcp/server.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m118-8-"));
  const ws = mkdtempSync(join(tmpdir(), "wao-m118-8-ws-"));
  try {
    makeGitRepo(ws);
    const runDir = join(dir, "runs"); mkdirSync(runDir, { recursive: true });
    const reg = makeRegistry(dir, { w: { backend: "claude-code", cwd: ws } });
    const server = createWaoMcpServer({ registryPath: reg, runDir, userEnvReader: noopReader });
    const client = await buildClient(server);
    try {
      await client.callTool({ name: "lead_preflight", arguments: { workspaceRoot: ws } });
    } finally { await client.close(); await server.close(); }
    const jsonl = existsSync(runDir) ? readdirSync(runDir).filter((f) => f.endsWith(".jsonl")) : [];
    assert.equal(jsonl.length, 0, "no transcript/run files created");
  } finally { cleanupDir(dir); cleanupDir(ws); }
});

// ===== 9. strict input rejects extra fields =====

test("M11-8-9: strict input rejects unknown fields", async () => {
  const { createWaoMcpServer } = await import("../src/mcp/server.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m118-9-"));
  try {
    const reg = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir } });
    const server = createWaoMcpServer({ registryPath: reg, runDir: join(dir, "runs"), userEnvReader: noopReader });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "lead_preflight", arguments: { evil: "x" } });
      assert.ok(res.isError, "extra field rejected");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

// ===== Advisory independence: runs_list failure does not swallow workspace/registry =====

test("M11-8-ADV1: runs_list failure → workspace + workers still returned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m118-adv1-"));
  try {
    const reg = makeRegistry(dir, { w: { backend: "codex", cwd: dir } });
    const result = await aggregateLeadPreflight({
      workspaceBinding: { bound: true, source: "lead_session", root: dir, gitHead: "d".repeat(40), dirty: false },
      registryPath: reg, runDir: join(dir, "runs"), userEnvReader: noopReader,
      listRunsFn: async () => { throw new Error("simulated runs_list failure"); },
    });
    assert.equal(result.workspace.bound, true, "workspace still returned");
    assert.ok(result.workers.length > 0, "workers still returned");
    assert.equal(result.checkStatus.activeRuns, "unknown", "activeRuns unknown");
    assert.ok(result.warnings.some((w) => /runs_list|active-run/i.test(w)), "warning recorded");
    assert.ok(result.manualChecks.length > 0, "manualChecks point at original tools");
  } finally { cleanupDir(dir); }
});

// ===== Advisory independence: registry failure does not swallow workspace =====

test("M11-8-ADV2: registry failure → workspace still returned; workers=null (not [])", async () => {
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: true, source: "lead_session", root: "/repo", gitHead: "e".repeat(40), dirty: false },
    registryPath: "/missing.json", runDir: "/runs", userEnvReader: noopReader,
  });
  assert.equal(result.workspace.bound, true, "workspace still returned");
  assert.equal(result.checkStatus.workers, "unknown", "workers unknown");
  assert.equal(result.workers, null, "unknown workers is null (NOT [] — distinct from known-empty)");
  assert.ok(result.warnings.some((w) => /registry_list|inventory/i.test(w)));
});

// ===== Advisory: warning does not block independent run_dispatch =====

test("M11-8-ADV3: advisory warning does not block independent run_dispatch", async () => {
  const { createWaoMcpServer } = await import("../src/mcp/server.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m118-adv3-"));
  const ws = mkdtempSync(join(tmpdir(), "wao-m118-adv3-ws-"));
  try {
    makeGitRepo(ws);
    const reg = makeRegistry(dir, { w: { backend: "claude-code", cwd: ws } });
    let dispatchCalls = 0;
    const server = createWaoMcpServer({
      registryPath: reg, runDir: join(dir, "runs"), userEnvReader: noopReader,
      dispatchRunFn: async () => { dispatchCalls += 1; return { runId: "r1", accepted: true, state: "pending" }; },
    });
    const client = await buildClient(server);
    try {
      // preflight with a warning (e.g. missing worker) — advisory only.
      const pf = await client.callTool({ name: "lead_preflight", arguments: { workspaceRoot: ws } });
      const parsed = JSON.parse(pf.content.find((b) => b.type === "text").text);
      // Even if there are warnings, run_dispatch must still be callable independently.
      await client.callTool({ name: "run_dispatch", arguments: { agentId: "w", prompt: "do" } });
      assert.equal(dispatchCalls, 1, "run_dispatch still callable despite preflight warnings");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); cleanupDir(ws); }
});

// ===== Advisory: no PASS/FAIL verdict; complete is mechanical readability =====

test("M11-8-ADV4: no PASS/FAIL verdict; complete is mechanical readability", async () => {
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: false },
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => [],
  });
  const dumped = JSON.stringify(result);
  assert.ok(!/\bPASS\b|\bFAIL\b/i.test(dumped), "no PASS/FAIL verdict");
  assert.equal(typeof result.complete, "boolean");
  assert.ok(result.checkStatus, "checkStatus present (observed/warning/unknown per section)");
});

// ===== Advisory: Lead can get different conclusion from direct tool =====

test("M11-8-ADV5: manualChecks point at original tools for independent re-verify", async () => {
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: true, source: "lead_session", root: "/repo", gitHead: "f".repeat(40), dirty: false },
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => [],
  });
  assert.ok(result.manualChecks.some((m) => /workspace_status/.test(m)));
  assert.ok(result.manualChecks.some((m) => /registry_list/.test(m)));
  assert.ok(result.manualChecks.some((m) => /runs_list/.test(m)));
});

// ===== Truthfulness/boundedness RED→GREEN (CTO micro-closeout) =====

// T-1: bound A, request select illegal B → must NOT be complete; explicit failed_using_prior.
test("M11-8-T1: failed selection → workspaceSelection=failed_using_prior, complete=false", async () => {
  // All other sections succeed, so WITHOUT the fix complete would be true.
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: true, source: "lead_session", root: "/A", gitHead: "a".repeat(40), dirty: false },
    selectionFailed: true,
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => [{ id: "w", backend: "claude-code", model: "m", certification: null, credentialAvailability: "not_required", cwd: "/A", missingCredentialEnvNames: [] }],
    listRunsFn: async () => ({ runs: [], matchedCount: 0 }),
  });
  assert.equal(result.workspaceSelection, "failed_using_prior");
  assert.equal(result.checkStatus.workspace, "warning");
  assert.equal(result.complete, false, "failed selection MUST NOT be complete even if other sections observed");
  assert.ok(result.warnings.some((w) => /selection failed/i.test(w)), "explicit warning about prior selection");
});

// T-2: resolver threw (binding null) → workspace=null + unknown (not faked bound:false).
test("M11-8-T2: resolver threw → workspace=null, checkStatus.workspace=unknown", async () => {
  const result = await aggregateLeadPreflight({
    workspaceBinding: null,
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => [],
  });
  assert.equal(result.workspace, null, "unknown workspace is null (NOT {bound:false})");
  assert.equal(result.checkStatus.workspace, "unknown");
});

// T-3: registry throws → workers=null; listRuns throws → activeRuns=null (distinct from known-empty).
test("M11-8-T3: registry/runs throw → null (not empty array)", async () => {
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: true, source: "lead_session", root: "/A", gitHead: "b".repeat(40), dirty: false },
    registryPath: "/missing.json", runDir: "/runs",
    listRunsFn: async () => { throw new Error("boom"); },
  });
  assert.equal(result.workers, null, "unreadable workers = null (not [])");
  assert.equal(result.activeRuns, null, "unreadable activeRuns = null (not [])");
  assert.equal(result.checkStatus.workers, "unknown");
  assert.equal(result.checkStatus.activeRuns, "unknown");
});

// T-4: >10 active runs → capped at 10, activeRunCount + truncated reported.
test("M11-8-T4: many active runs → capped at 10, count + truncated", async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ runId: `run_${i}`, agentId: "w", state: "running", terminal: false, updatedAt: null }));
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: true, source: "lead_session", root: "/A", gitHead: "c".repeat(40), dirty: false },
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => [],
    listRunsFn: async () => ({ runs: many, matchedCount: 25 }),
  });
  assert.ok(result.activeRuns.length <= 10, "active runs capped at 10");
  assert.equal(result.activeRunCount, 25, "true count reported");
  assert.equal(result.activeRunsTruncated, true, "truncation flag set");
});

// T-5: failed selection via real MCP tool → payload has workspaceSelection + complete=false.
test("M11-8-T5: MCP lead_preflight failed selection → explicit failed_using_prior, not complete", async () => {
  const { createWaoMcpServer } = await import("../src/mcp/server.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m118-t5-"));
  const wsA = mkdtempSync(join(tmpdir(), "wao-m118-t5-a-"));
  const notGit = mkdtempSync(join(tmpdir(), "wao-m118-t5-nogit-"));
  try {
    makeGitRepo(wsA);
    const reg = makeRegistry(dir, { w: { backend: "claude-code", cwd: wsA } });
    const server = createWaoMcpServer({ registryPath: reg, runDir: join(dir, "runs"), userEnvReader: noopReader });
    const client = await buildClient(server);
    try {
      // Select A first.
      await client.callTool({ name: "lead_preflight", arguments: { workspaceRoot: wsA } });
      // Request B (illegal) — must report failed_using_prior, NOT complete.
      const res = await client.callTool({ name: "lead_preflight", arguments: { workspaceRoot: notGit } });
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(parsed.workspaceSelection, "failed_using_prior");
      assert.equal(parsed.complete, false);
      // The reported workspace is still A (prior), explicitly flagged.
      assert.equal(parsed.workspace.bound, true);
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); cleanupDir(wsA); cleanupDir(notGit); }
});
