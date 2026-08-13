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
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";

import { aggregateLeadPreflight } from "../src/application/leadPreflight.js";
import { REGISTRY_ISSUES_CAP, REGISTRY_ISSUE_CODES } from "../src/application/registryInventory.js";
import { isValidCanonicalAgentId } from "../src/canonicalAgentId.js";

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
      good: { backend: "claude-code", cwd: dir, provider: { protocol: "anthropic-compatible", baseUrl: "https://synthetic.example.com", apiKeyEnv: "TEST_M118_GOOD" } },
      bad: { backend: "claude-code", cwd: dir, provider: { protocol: "anthropic-compatible", baseUrl: "https://synthetic.example.com", apiKeyEnv: "TEST_M118_BAD" } },
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
    const reg = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir, provider: { protocol: "anthropic-compatible", baseUrl: "https://synthetic.example.com", apiKeyEnv: "TEST_M118_SECRET" } } });
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

// M12-25B finding 2: a malformed/null injected inventory result that does NOT
// throw must still fail CLOSED to workers=unknown/null — never observed-empty
// (workers:[] with checkStatus.workers="observed"). ADV2 covers a THROWING
// resolver; this covers the non-throwing null/malformed RETURN, where current
// code does `invResult?.agents ?? []` → [] and observes an empty worker list.
// Unknown must stay null/unknown, distinct from a genuinely empty-but-readable
// registry (PRE-5 observes workers:[] legitimately for a clean empty registry).
test("M12-25-PRE-7: null/malformed injected inventory → workers unknown/null (NOT observed-empty)", async () => {
  for (const bad of [null, undefined, { noAgentsKey: true }, 42, "a-string"]) {
    const result = await aggregateLeadPreflight({
      workspaceBinding: { bound: true, source: "lead_session", root: "/repo", gitHead: "f".repeat(40), dirty: false },
      registryPath: "/r.json", runDir: "/runs", userEnvReader: noopReader,
      getRegistryInventoryFn: async () => bad,
      listRunsFn: async () => ({ runs: [], matchedCount: 0, unresolvedCount: 0 }),
    });
    assert.equal(result.checkStatus.workers, "unknown",
      `malformed injected inventory (${JSON.stringify(bad)}) → workers unknown, not observed`);
    assert.equal(result.workers, null,
      "unknown workers is null (NOT [] — distinct from known-empty / observed-empty)");
  }
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
    selectionRequested: true,
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

// ===== Final truth-boundary RED→GREEN (CTO micro-closeout) =====

// FB-A: registry single read — failed snapshot must NOT trigger a second read.
test("M11-8-FBA: registry failure → exactly ONE read, workers=null (no fallback re-read)", async () => {
  let readCount = 0;
  const failingResolver = async () => { readCount += 1; throw new Error("snapshot failed"); };
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: true, source: "lead_session", root: "/A", gitHead: "a".repeat(40), dirty: false },
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: failingResolver,
    listRunsFn: async () => ({ runs: [], matchedCount: 0 }),
  });
  assert.equal(readCount, 1, "registry read exactly once (no fallback)");
  assert.equal(result.workers, null, "failed read → null, not []");
  assert.equal(result.checkStatus.workers, "unknown");
});

// FB-B1: fresh unbound + selection failed → failed_unbound (NOT failed_using_prior).
test("M11-8-FBB1: fresh unbound + failed selection → failed_unbound", async () => {
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: false },
    selectionRequested: true,
    selectionFailed: true,
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => [],
  });
  assert.equal(result.workspaceSelection, "failed_unbound", "no prior → failed_unbound, not failed_using_prior");
  assert.equal(result.complete, false);
});

// FB-B2: selection succeeded → selected.
test("M11-8-FBB2: successful selection → selected", async () => {
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: true, source: "lead_session", root: "/A", gitHead: "b".repeat(40), dirty: false },
    selectionRequested: true,
    selectionFailed: false,
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => [],
  });
  assert.equal(result.workspaceSelection, "selected");
});

// FB-B3: no workspaceRoot → not_requested.
test("M11-8-FBB3: no selection requested → not_requested", async () => {
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: true, source: "lead_session", root: "/A", gitHead: "c".repeat(40), dirty: false },
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => [],
  });
  assert.equal(result.workspaceSelection, "not_requested");
});

// FB-B4: selection failed + resolver threw → failed_unknown.
test("M11-8-FBB4: failed selection + resolver threw → failed_unknown", async () => {
  const result = await aggregateLeadPreflight({
    workspaceBinding: null,
    selectionRequested: true,
    selectionFailed: true,
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => [],
  });
  assert.equal(result.workspaceSelection, "failed_unknown");
  assert.equal(result.complete, false);
});

// FB-C: schema enforces maxItems via shared SSOT (prove caps are consistent).
test("M11-8-FBC: ACTIVE_RUNS_CAP and WORKERS_CAP are exported and finite", async () => {
  const { ACTIVE_RUNS_CAP, WORKERS_CAP } = await import("../src/application/leadPreflight.js");
  assert.equal(typeof ACTIVE_RUNS_CAP, "number");
  assert.equal(typeof WORKERS_CAP, "number");
  assert.ok(ACTIVE_RUNS_CAP > 0 && ACTIVE_RUNS_CAP <= 50, "reasonable cap");
  assert.ok(WORKERS_CAP > 0 && WORKERS_CAP <= 256, "reasonable cap");
});

// FB-C2: workers truncated at WORKERS_CAP.
test("M11-8-FBC2: workers truncated at WORKERS_CAP", async () => {
  const { WORKERS_CAP } = await import("../src/application/leadPreflight.js");
  const many = Array.from({ length: WORKERS_CAP + 10 }, (_, i) => ({
    id: `w${i}`, backend: "claude-code", model: "m", certification: null,
    credentialAvailability: "not_required", cwd: "/A", missingCredentialEnvNames: [],
  }));
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: true, source: "lead_session", root: "/A", gitHead: "d".repeat(40), dirty: false },
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => many,
  });
  assert.equal(result.workers.length, WORKERS_CAP, "workers capped");
  assert.ok(result.warnings.some((w) => /truncated/i.test(w)), "truncation warning");
});

// ===== Final evidence: real MCP handler behavior (not just application-layer) =====

// FE-1: real MCP lead_preflight with registry failure → exactly 1 read, workers=null.
test("M11-8-FE1: MCP handler reads registry exactly ONCE on failure (real transport)", async () => {
  const { createWaoMcpServer } = await import("../src/mcp/server.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m118-fe1-"));
  const ws = mkdtempSync(join(tmpdir(), "wao-m118-fe1-ws-"));
  try {
    makeGitRepo(ws);
    const reg = makeRegistry(dir, { w: { backend: "claude-code", cwd: ws } });
    let readCount = 0;
    const server = createWaoMcpServer({
      registryPath: reg, runDir: join(dir, "runs"), userEnvReader: noopReader,
      getRegistryInventoryFn: async () => { readCount += 1; throw new Error("snapshot failed"); },
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "lead_preflight", arguments: { workspaceRoot: ws } });
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(readCount, 1, "registry read exactly once via real MCP handler");
      assert.equal(parsed.workers, null, "failed read → null via MCP");
      assert.equal(parsed.checkStatus.workers, "unknown");
      assert.equal(parsed.complete, false);
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); cleanupDir(ws); }
});

// FE-2: fresh unbound session + illegal workspaceRoot → failed_unbound (NOT failed_using_prior).
test("M11-8-FE2: fresh unbound + bad selection → failed_unbound via real MCP", async () => {
  const { createWaoMcpServer } = await import("../src/mcp/server.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m118-fe2-"));
  const notGit = mkdtempSync(join(tmpdir(), "wao-m118-fe2-nogit-"));
  try {
    const reg = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir } });
    const server = createWaoMcpServer({ registryPath: reg, runDir: join(dir, "runs"), userEnvReader: noopReader });
    const client = await buildClient(server);
    try {
      // NO prior selection — fresh unbound session.
      const res = await client.callTool({ name: "lead_preflight", arguments: { workspaceRoot: notGit } });
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(parsed.workspaceSelection, "failed_unbound", "fresh unbound → failed_unbound, not failed_using_prior");
      assert.equal(parsed.complete, false);
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); cleanupDir(notGit); }
});

// FE-3: prior selection active + illegal workspaceRoot → failed_using_prior.
test("M11-8-FE3: prior selection + bad selection → failed_using_prior via real MCP", async () => {
  const { createWaoMcpServer } = await import("../src/mcp/server.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m118-fe3-"));
  const wsA = mkdtempSync(join(tmpdir(), "wao-m118-fe3-a-"));
  const notGit = mkdtempSync(join(tmpdir(), "wao-m118-fe3-nogit-"));
  try {
    makeGitRepo(wsA);
    const reg = makeRegistry(dir, { w: { backend: "claude-code", cwd: wsA } });
    const server = createWaoMcpServer({ registryPath: reg, runDir: join(dir, "runs"), userEnvReader: noopReader });
    const client = await buildClient(server);
    try {
      // Select A first.
      await client.callTool({ name: "lead_preflight", arguments: { workspaceRoot: wsA } });
      // Now request illegal B.
      const res = await client.callTool({ name: "lead_preflight", arguments: { workspaceRoot: notGit } });
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(parsed.workspaceSelection, "failed_using_prior", "prior active → failed_using_prior");
      assert.equal(parsed.complete, false);
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); cleanupDir(wsA); cleanupDir(notGit); }
});

// FE-4: real output schema maxItems matches SSOT caps (not just "constant exists").
test("M11-8-FE4: lead_preflight outputSchema maxItems matches SSOT caps", async () => {
  const { ACTIVE_RUNS_CAP, WORKERS_CAP } = await import("../src/application/leadPreflight.js");
  const { createWaoMcpServer } = await import("../src/mcp/server.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m118-fe4-"));
  try {
    const reg = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir } });
    const server = createWaoMcpServer({ registryPath: reg, runDir: join(dir, "runs"), userEnvReader: noopReader });
    const client = await buildClient(server);
    try {
      const { tools } = await client.listTools();
      const t = tools.find((x) => x.name === "lead_preflight");
      assert.ok(t.outputSchema, "output schema declared");
      const schema = t.outputSchema;
      // .nullable() serializes as anyOf; the array branch is anyOf[0].
      const workersSchema = schema.properties?.workers;
      const workersArr = workersSchema?.anyOf ? workersSchema.anyOf[0] : workersSchema;
      assert.equal(workersArr?.maxItems, WORKERS_CAP, `workers.maxItems === WORKERS_CAP (${WORKERS_CAP})`);
      const activeRunsSchema = schema.properties?.activeRuns;
      const activeRunsArr = activeRunsSchema?.anyOf ? activeRunsSchema.anyOf[0] : activeRunsSchema;
      assert.equal(activeRunsArr?.maxItems, ACTIVE_RUNS_CAP, `activeRuns.maxItems === ACTIVE_RUNS_CAP (${ACTIVE_RUNS_CAP})`);
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

// ===== M12-15: stale active-run truth projection =====
//
// lead_preflight consumes the single shared listRuns projection (activeOnly:true)
// and counts ONLY proven-active runs in activeRunCount. Non-terminal runs that
// lack a fresh owner heartbeat are NOT counted active and are NOT inferred
// failed/dead/stopped — they are exposed as unresolvedRunCount plus an advisory
// observation, so an empty activeRuns list is never mistaken for a clean
// workspace. These tests drive the aggregator's listRunsFn directly; the
// matching listRuns behavior is pinned in runsList*.test.js.

const PRE_NOW = 1_700_000_000_000;

function preEvents(runId, cwd) {
  const ts = "2026-07-01T00:00:00Z";
  return [
    { type: "run.started", runId, agentId: "w", ts, seq: 1 },
    { type: "run.background_submitted", runId, agentId: "w", cwd, background: true, ts, seq: 2 },
    { type: "run.state_change", runId, agentId: "w", from: "pending", to: "running", reason: "go", ts, seq: 3 },
  ];
}

function preVerifier(authorizedRoot) {
  return (events) => {
    const cwd = events.find((e) => e.type === "run.background_submitted")?.cwd;
    if (cwd !== authorizedRoot) throw new Error("workspace mismatch");
    return { authorized: true, ownershipCwd: cwd };
  };
}

// PRE-01: activeRunCount counts only proven active; unresolvedRunCount exposed separately.
test("M12-15-PRE-01: activeRunCount counts only proven active; unresolvedRunCount exposed", async () => {
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: true, source: "lead_session", root: "/A", gitHead: "a".repeat(40), dirty: false },
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => [],
    listRunsFn: async () => ({
      runs: [{
        runId: "run_active", agentId: "w", state: "running", terminal: false, updatedAt: null,
        activityStatus: "active", activityBasis: "fresh_owner_heartbeat",
      }],
      matchedCount: 1,
      unresolvedCount: 4, // the four stale June transcripts
    }),
  });
  assert.equal(result.activeRunCount, 1, "only proven-active runs count");
  assert.equal(result.unresolvedRunCount, 4, "unresolved runs exposed separately (not counted active)");
  assert.equal(result.activeRuns.length, 1);
  assert.equal(result.checkStatus.activeRuns, "observed");
});

// PRE-02: unresolved runs produce an advisory observation (omitted + do not prove failure/stop).
test("M12-15-PRE-02: unresolved runs → advisory observation (omitted from activeRuns; not failure/stop)", async () => {
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: true, source: "lead_session", root: "/A", gitHead: "b".repeat(40), dirty: false },
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => [],
    listRunsFn: async () => ({ runs: [], matchedCount: 0, unresolvedCount: 4 }),
  });
  assert.equal(result.activeRunCount, 0, "no proven-active run");
  assert.equal(result.unresolvedRunCount, 4);
  assert.ok(result.observations.some((o) => /unresolved/i.test(o)), "observation mentions unresolved");
  assert.ok(
    result.observations.some((o) => /omitted from activeRuns/i.test(o) && /do not prove failure or stop/i.test(o)),
    "observation states unresolved runs were omitted and do not prove failure or stop",
  );
});

// PRE-03: no unresolved advisory when unresolvedRunCount is 0.
test("M12-15-PRE-03: no unresolved advisory observation when unresolvedRunCount is 0", async () => {
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: true, source: "lead_session", root: "/A", gitHead: "c".repeat(40), dirty: false },
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => [],
    listRunsFn: async () => ({ runs: [], matchedCount: 0, unresolvedCount: 0 }),
  });
  assert.equal(result.unresolvedRunCount, 0);
  assert.ok(!result.observations.some((o) => /unresolved/i.test(o)), "no unresolved advisory when zero");
});

// PRE-04: listRuns failure → activeRuns=null + unresolvedRunCount=null (unknown, not faked 0).
test("M12-15-PRE-04: listRuns failure → activeRuns=null + unresolvedRunCount=null (unknown, not faked 0)", async () => {
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: true, source: "lead_session", root: "/A", gitHead: "d".repeat(40), dirty: false },
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => [],
    listRunsFn: async () => { throw new Error("simulated runs_list failure"); },
  });
  assert.equal(result.activeRuns, null);
  assert.equal(result.activeRunCount, null);
  assert.equal(result.unresolvedRunCount, null, "unknown is null, NOT faked 0");
  assert.equal(result.checkStatus.activeRuns, "unknown");
});

// ===== M12-19: recovery truth in the lead_preflight workspace projection =====

// PRE-A: bound workspace → unboundReason projects null (never a string when bound).
test("M12-19-PRE-A: bound workspace → unboundReason=null", async () => {
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: true, source: "lead_session", root: "/A", gitHead: "a".repeat(40), dirty: false },
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => [],
  });
  assert.equal(result.workspace.bound, true);
  assert.equal(result.workspace.unboundReason, null);
});

// PRE-B: every closed-set unboundReason projects verbatim (truthful passthrough).
test("M12-19-PRE-B: each closed-set unboundReason projects verbatim", async () => {
  for (const reason of ["lead_session_git_proof_failed", "server_config_git_proof_failed", "no_workspace_authority"]) {
    const result = await aggregateLeadPreflight({
      workspaceBinding: { bound: false, unboundReason: reason },
      registryPath: "/r.json", runDir: "/runs",
      getRegistryInventoryFn: async () => [],
    });
    assert.equal(result.workspace.bound, false);
    assert.equal(result.workspace.unboundReason, reason, `verbatim: ${reason}`);
    assert.equal(result.workspace.source, null);
    assert.equal(result.workspace.gitHead, null);
    assert.equal(result.workspace.dirty, null);
  }
});

// PRE-C: caller-supplied {bound:false} WITHOUT unboundReason (legacy shape) →
// null, never a fabricated value.
test("M12-19-PRE-C: absent unboundReason → null (never fabricated)", async () => {
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: false },
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => [],
  });
  assert.equal(result.workspace.bound, false);
  assert.equal(result.workspace.unboundReason, null);
});

// PRE-F: a dependency-injected or malformed reason OUTSIDE the closed set
// fails closed at the application boundary to null — never returned verbatim,
// never rendered as dynamic text (unknown, not fabricated).
test("M12-19-PRE-F: unknown unboundReason fails closed to null at the application boundary", async () => {
  for (const unknown of ["not_in_closed_set", 42, { code: "x" }, ""]) {
    const result = await aggregateLeadPreflight({
      workspaceBinding: { bound: false, unboundReason: unknown },
      registryPath: "/r.json", runDir: "/runs",
      getRegistryInventoryFn: async () => [],
    });
    assert.equal(result.workspace.bound, false, `still known-unbound for ${JSON.stringify(unknown)}`);
    assert.equal(result.workspace.unboundReason, null, `fails closed to null for ${JSON.stringify(unknown)}`);
  }
});

// PRE-D: real MCP — lead_session selection breaks (repo deleted) →
// lead_preflight reports workspace.unboundReason=lead_session_git_proof_failed
// with workspaceSelection=not_requested (no re-select attempted).
test("M12-19-PRE-D: real MCP — broken lead_session → unboundReason=lead_session_git_proof_failed", async () => {
  const { createWaoMcpServer } = await import("../src/mcp/server.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m1219-pred-"));
  const ws = mkdtempSync(join(tmpdir(), "wao-m1219-pred-ws-"));
  try {
    makeGitRepo(ws);
    const reg = makeRegistry(dir, { w: { backend: "claude-code", cwd: ws } });
    const server = createWaoMcpServer({ registryPath: reg, runDir: join(dir, "runs"), userEnvReader: noopReader });
    const client = await buildClient(server);
    try {
      // Bind via lead_preflight's select.
      const r1 = await client.callTool({ name: "lead_preflight", arguments: { workspaceRoot: ws } });
      assert.equal(JSON.parse(r1.content.find((b) => b.type === "text").text).workspace.bound, true);
      // Break the session repo, then re-run preflight WITHOUT workspaceRoot.
      rmSync(ws, { recursive: true, force: true });
      const r2 = await client.callTool({ name: "lead_preflight", arguments: {} });
      const parsed = JSON.parse(r2.content.find((b) => b.type === "text").text);
      assert.equal(parsed.workspace.bound, false);
      assert.equal(parsed.workspace.unboundReason, "lead_session_git_proof_failed");
      assert.equal(parsed.workspace.source, null);
      assert.equal(parsed.workspaceSelection, "not_requested");
      assert.ok(!r2.isError, "recovery fact is a payload field, never an error");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); cleanupDir(ws); }
});

// PRE-E: real MCP — fresh unbound server → workspace.unboundReason=no_workspace_authority.
test("M12-19-PRE-E: real MCP — fresh unbound → unboundReason=no_workspace_authority", async () => {
  const { createWaoMcpServer } = await import("../src/mcp/server.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m1219-pree-"));
  try {
    const reg = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir } });
    const server = createWaoMcpServer({ registryPath: reg, runDir: join(dir, "runs"), userEnvReader: noopReader });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "lead_preflight", arguments: {} });
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(parsed.workspace.bound, false);
      assert.equal(parsed.workspace.unboundReason, "no_workspace_authority");
      assert.ok(!res.isError, "recovery fact is a payload field, never an error");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

// PRE-05: end-to-end composition with the REAL listRuns — stale June runs are
// unresolved, only the fresh-heartbeat run counts as active.
test("M12-15-PRE-05: real listRuns composition — activeRunCount excludes stale June runs", async () => {
  const { listRuns } = await import("../src/application/runList.js");
  const ROOT = "C:\\Target\\Repo";
  const active = "run_20260601120000001juneA";
  const stale = "run_20260601120000002juneB";
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1215-pre05-"));
  try {
    writeFileSync(join(runDir, `${active}.jsonl`), "", "utf8");
    writeFileSync(join(runDir, `${stale}.jsonl`), "", "utf8");
    const eventsByFile = new Map([
      [`${active}.jsonl`, preEvents(active, ROOT)],
      [`${stale}.jsonl`, preEvents(stale, ROOT)],
    ]);
    const livenessMap = {
      [active]: { fresh: true, heartbeatAt: PRE_NOW - 500 },
      [stale]: { fresh: false, heartbeatAt: PRE_NOW - 99999 },
    };
    const livenessFn = (runDir, runId, now) => livenessMap[runId] ?? { fresh: false, heartbeatAt: null };
    const result = await aggregateLeadPreflight({
      workspaceBinding: { bound: true, source: "lead_session", root: ROOT, gitHead: "e".repeat(40), dirty: false },
      registryPath: "/r.json", runDir,
      getRegistryInventoryFn: async () => [],
      listRunsFn: (args) => listRuns({
        ...args,
        nowMs: PRE_NOW,
        checkLivenessFn: livenessFn,
        readTranscriptFn: async (p) => eventsByFile.get(basename(p)),
        createWorkspaceVerifierFn: () => preVerifier(ROOT),
      }),
    });
    assert.equal(result.activeRunCount, 1, "only the fresh-heartbeat run is active");
    assert.equal(result.unresolvedRunCount, 1, "the stale June run is unresolved");
    assert.equal(result.activeRuns.length, 1);
    assert.equal(result.activeRuns[0].runId, active);
    assert.ok(result.observations.some((o) => /unresolved/i.test(o)), "advisory observation present");
  } finally { cleanupDir(runDir); }
});

// =====================================================================
// M12-25 (Outcome 1): lead_preflight surfaces a PARTIAL worker inventory.
//
// When the registry is readable but has a malformed/unsupported entry,
// lead_preflight must NOT hide the healthy workers. It returns the VALID
// workers with checkStatus.workers="warning" (→ complete=false) plus the SAME
// bounded safe per-entry issue facts as registry_list (single shared read).
// A true empty valid registry stays observed/complete. Zero valid entries WITH
// issues is warning/complete=false — it is NOT an observed-clean empty registry.
// =====================================================================

test("M12-25-PRE-1: partial inventory → workers=warning, complete=false, valid workers + issues shown (single read)", async () => {
  let readCount = 0;
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: true, source: "lead_session", root: "/A", gitHead: "a".repeat(40), dirty: false },
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => {
      readCount += 1;
      return {
        agents: [{ id: "good", backend: "claude-code", model: "m", reasoningEffort: null, certification: null, credentialAvailability: "not_required", cwd: "/A", missingCredentialEnvNames: [] }],
        issues: [{ code: "invalid_configuration", agentId: "broken" }],
        issuesTruncated: false,
      };
    },
    listRunsFn: async () => ({ runs: [], matchedCount: 0 }),
  });
  assert.equal(readCount, 1, "registry read exactly once");
  assert.equal(result.checkStatus.workers, "warning", "issues present → warning");
  assert.equal(result.complete, false, "issues present → not complete");
  assert.equal(result.workers.length, 1, "valid worker shown");
  assert.equal(result.workers[0].id, "good");
  assert.ok(Array.isArray(result.registryIssues), "registryIssues exposed");
  assert.equal(result.registryIssues.length, 1);
  assert.equal(result.registryIssues[0].agentId, "broken");
  assert.equal(result.registryIssuesTruncated, false);
});

test("M12-25-PRE-2: empty valid registry (no issues) → workers=observed, complete", async () => {
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: true, source: "lead_session", root: "/A", gitHead: "b".repeat(40), dirty: false },
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => ({ agents: [], issues: [], issuesTruncated: false }),
    listRunsFn: async () => ({ runs: [], matchedCount: 0 }),
  });
  assert.equal(result.checkStatus.workers, "observed", "observed-clean empty");
  assert.equal(result.complete, true, "observed-clean empty → complete (contrast with issues present)");
  assert.deepEqual(result.registryIssues, []);
  assert.equal(result.registryIssuesTruncated, false);
});

test("M12-25-PRE-3: zero valid entries WITH issues → warning, complete=false (NOT observed-clean empty)", async () => {
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: true, source: "lead_session", root: "/A", gitHead: "c".repeat(40), dirty: false },
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => ({
      agents: [],
      issues: [{ code: "invalid_configuration", agentId: "broken" }],
      issuesTruncated: false,
    }),
    listRunsFn: async () => ({ runs: [], matchedCount: 0 }),
  });
  assert.equal(result.checkStatus.workers, "warning", "issues present → warning, NOT observed");
  assert.equal(result.complete, false, "NOT complete — distinct from an observed-clean empty registry");
  assert.deepEqual(result.workers, [], "no valid workers");
  assert.equal(result.registryIssues.length, 1, "issue facts surfaced");
});

test("M12-25-PRE-4: real MCP lead_preflight with a real malformed registry → warning + complete=false + valid worker", async () => {
  const { createWaoMcpServer } = await import("../src/mcp/server.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m1225-pre4-"));
  const ws = mkdtempSync(join(tmpdir(), "wao-m1225-pre4-ws-"));
  try {
    makeGitRepo(ws);
    const reg = makeRegistry(dir, {
      good: { backend: "claude-code", cwd: ws, model: { id: "glm-5.2" } },
      broken: { cwd: ws }, // missing backend → invalid_configuration
    });
    const server = createWaoMcpServer({ registryPath: reg, runDir: join(dir, "runs"), userEnvReader: noopReader });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "lead_preflight", arguments: { workspaceRoot: ws } });
      assert.equal(res.isError, undefined, "partial inventory is a normal result");
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(parsed.checkStatus.workers, "warning", "warning because one entry is malformed");
      assert.equal(parsed.complete, false, "not complete because the workers section is a warning");
      assert.equal(parsed.workers.length, 1, "the valid worker is NOT hidden");
      assert.equal(parsed.workers[0].id, "good");
      assert.ok(Array.isArray(parsed.registryIssues) && parsed.registryIssues.length === 1, "same safe issue facts as registry_list");
      assert.equal(parsed.registryIssues[0].agentId, "broken");
      assert.equal(parsed.registryIssuesTruncated, false);
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); cleanupDir(ws); }
});

test("M12-25-PRE-5: lead_preflight outputSchema declares registryIssues + registryIssuesTruncated + closed codes", async () => {
  const { createWaoMcpServer } = await import("../src/mcp/server.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m1225-pre5-"));
  try {
    const reg = makeRegistry(dir, { w: { backend: "claude-code", cwd: dir } });
    const server = createWaoMcpServer({ registryPath: reg, runDir: join(dir, "runs"), userEnvReader: noopReader });
    const client = await buildClient(server);
    try {
      const { tools } = await client.listTools();
      const t = tools.find((x) => x.name === "lead_preflight");
      const schemaText = JSON.stringify(t.outputSchema);
      assert.ok(/registryIssues/.test(schemaText), "outputSchema declares registryIssues");
      assert.ok(/registryIssuesTruncated/.test(schemaText), "outputSchema declares registryIssuesTruncated");
      assert.ok(/invalid_id/.test(schemaText), "closed code invalid_id in schema");
      assert.ok(/invalid_configuration/.test(schemaText), "closed code invalid_configuration in schema");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

// M12-25-PRE-6: a malicious/injected resolver passes >REGISTRY_ISSUES_CAP issues
// WITH issuesTruncated:false plus leak-bait fields. The shared SSOT projector must
// bound it to the cap, set issuesTruncated=true, strip every injected field, keep
// only the closed code set + canonical agentId-or-null — and STILL return the
// valid worker (bounded partial result, NOT a whole-registry error).
test("M12-25-PRE-6: injected >cap issues with issuesTruncated:false → bounded partial (cap + truncate + sanitize), valid worker preserved", async () => {
  const over = REGISTRY_ISSUES_CAP + 5;
  const injectedIssues = Array.from({ length: over }, (_, i) => ({
    // Closed-set code for even indices; an out-of-set injection for odd ones.
    code: i % 2 === 0 ? "invalid_configuration" : "EVIL_OUT_OF_SET_CODE",
    // Canonical id for some; a non-canonical injection for others (must null out).
    agentId: i % 3 === 0 ? "coder_low" : "NOT CANONICAL!!",
    // Leak bait — must NEVER survive the projection.
    rawError: `/secret/path/${i} apiKey=sk-leak-${i}`,
    path: `/etc/${i}`,
    config: { secret: i },
  }));
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: true, source: "lead_session", root: "/A", gitHead: "d".repeat(40), dirty: false },
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => ({
      agents: [{ id: "good", backend: "claude-code", model: "m", reasoningEffort: null, certification: null, credentialAvailability: "not_required", cwd: "/A", missingCredentialEnvNames: [] }],
      issues: injectedIssues,
      issuesTruncated: false,
    }),
    listRunsFn: async () => ({ runs: [], matchedCount: 0 }),
  });
  // Bounded partial result, NOT a whole-registry error.
  assert.equal(result.checkStatus.workers, "warning", "issues present → warning");
  assert.equal(result.complete, false, "not complete");
  assert.equal(result.workers.length, 1, "the one VALID worker is preserved (not erased)");
  assert.equal(result.workers[0].id, "good");
  // Cap enforced even though the source lied with issuesTruncated:false.
  assert.equal(result.registryIssues.length, REGISTRY_ISSUES_CAP, "capped at REGISTRY_ISSUES_CAP");
  assert.equal(result.registryIssuesTruncated, true, "over-cap input reports truncation despite source false");
  // Every surviving issue is the safe shape only: closed code + canonical id-or-null.
  for (const issue of result.registryIssues) {
    assert.ok(REGISTRY_ISSUE_CODES.includes(issue.code), `code in closed set: ${issue.code}`);
    assert.ok(issue.agentId === null || isValidCanonicalAgentId(issue.agentId), "agentId canonical or null");
    assert.deepEqual(Object.keys(issue).sort(), ["agentId", "code"], "no injected field survives");
  }
  assert.ok(!JSON.stringify(result).includes("EVIL_OUT_OF_SET_CODE"), "out-of-set code never leaks");
  assert.ok(!JSON.stringify(result).includes("rawError"), "raw error text never leaks");
  assert.ok(!JSON.stringify(result).includes("sk-leak"), "credential bait never leaks");
});
