// test/runsListCloseout.test.js
//
// M10 P0-3 micro-closeout: agentId registry shape + activeOnly truthfulness.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";

import { JsonlTranscript } from "../../src/transcript.js";
import { createWaoMcpServer } from "../../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

function makeGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "R.md"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: dir });
}

async function seedRun(runDir, runId, workspaceCwd, state = "running", agentId = "coder_low") {
  const tp = join(runDir, `${runId}.jsonl`);
  const t = new JsonlTranscript(tp, { runId, agentId });
  await t.append("run.started", { backend: "claude-code" });
  await t.append("run.background_submitted", { background: true, cwd: workspaceCwd });
  await t.append("session.created", { backend: "process", backendSessionId: "proc_99999" });
  await t.transitionState(null, "pending", "created");
  await t.transitionState("pending", "running", "first_event");
  if (state === "completed") {
    await t.append("run.completed", {});
    await t.transitionState("running", "completed", "done");
  }
  return tp;
}

async function buildClient(server) {
  const [c1, s1] = InMemoryTransport.createLinkedPair();
  await server.connect(s1);
  const client = new Client({ name: "test", version: "0" }, { version: "0" });
  await client.connect(c1);
  return client;
}

// Real registry inventory returns an ARRAY (not {agents: [...]})
function realRegistryInventory() {
  return async () => [
    { id: "coder_low", backend: "claude-code", model: "glm-5-turbo", certification: "certified", cwd: "/repo" },
    { id: "coder_hq", backend: "claude-code", model: "glm-5.2", certification: "certified", cwd: "/repo" },
    { id: "tester", backend: "codex", model: "default", certification: "certified", cwd: "/repo" },
  ];
}

// ── RED-1: known agentId preserved (not mapped to 'unknown') ─────────────────

test("KNOWN-AGENT-01: known agentId 'coder_low' preserved through MCP runs_list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-known-01-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-known-01-rd-"));
  try {
    makeGitRepo(dir);
    await seedRun(runDir, "run_known", dir, "running", "coder_low");
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir, workspaceRoot: dir,
      getRegistryInventoryFn: realRegistryInventory(),
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "runs_list", arguments: {} });
      const parsed = JSON.parse(res.content[0].text);
      const run = parsed.runs.find((r) => r.runId === "run_known");
      assert.ok(run, "run must appear in list");
      assert.equal(run.agentId, "coder_low", "known agentId must be preserved, not 'unknown'");
    } finally {
      await client.close();
      await server.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("KNOWN-AGENT-02: unknown agentId still maps to 'unknown'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-known-02-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-known-02-rd-"));
  try {
    makeGitRepo(dir);
    await seedRun(runDir, "run_unknown_agent", dir, "running", "<<INJECTED>>");
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir, workspaceRoot: dir,
      getRegistryInventoryFn: realRegistryInventory(),
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "runs_list", arguments: {} });
      const parsed = JSON.parse(res.content[0].text);
      const run = parsed.runs.find((r) => r.runId === "run_unknown_agent");
      assert.ok(run);
      assert.equal(run.agentId, "unknown", "unregistered agentId must be 'unknown'");
    } finally {
      await client.close();
      await server.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// ── RED (M12-25B finding 1): the DEFAULT inventory service is the partial
// projection, which returns the OBJECT {agents, issues, issuesTruncated} — NOT a
// bare array. KNOWN-AGENT-01/02 inject an array-shaped fake, so they never
// exercised the default path. The production default path consumed that object
// as if it were an array (Array.isArray(object) === false → knownAgentIds=[]),
// which erased EVERY run's agentId to 'unknown' even for a valid registry. This
// test uses a REAL registry file and injects NOTHING, so the production default
// service runs — it reproduces the erasure and then guards the identity fix.
test("KNOWN-AGENT-03: default partial-inventory service preserves known agentId (real registry, no injected fake)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-known-03-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-known-03-rd-"));
  try {
    makeGitRepo(dir);
    // Real registry the DEFAULT service (getRegistryInventoryWithIssues) reads.
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: {
      coder_low: { backend: "claude-code", cwd: dir, model: { id: "glm-5-turbo" } },
    } }), "utf8");
    await seedRun(runDir, "run_default_service", dir, "running", "coder_low");
    // NOTE: no getRegistryInventoryFn injected → the production default service
    // (object-shaped partial projection) is the code path under test.
    const server = createWaoMcpServer({ registryPath, runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "runs_list", arguments: {} });
      assert.equal(res.isError, undefined, "runs_list must succeed for a valid registry");
      const parsed = JSON.parse(res.content[0].text);
      const run = parsed.runs.find((r) => r.runId === "run_default_service");
      assert.ok(run, "run must appear in list");
      assert.equal(run.agentId, "coder_low",
        "default partial-inventory service must preserve the known agentId, not erase it to 'unknown'");
    } finally {
      await client.close();
      await server.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// ── RED-2: activeOnly excludes unknown state ─────────────────────────────────

test("ACTIVEONLY-01: unknown state run excluded by activeOnly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-active-01-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-active-01-rd-"));
  try {
    makeGitRepo(dir);
    // Seed a known-active run
    await seedRun(runDir, "run_active", dir, "running", "coder_low");
    // Seed a run with unrecognized state
    const tp = join(runDir, "run_evil.jsonl");
    const t = new JsonlTranscript(tp, { runId: "run_evil", agentId: "coder_low" });
    await t.append("run.started", { backend: "claude-code" });
    await t.append("run.background_submitted", { background: true, cwd: dir });
    await t.append("session.created", { backend: "process", backendSessionId: "proc_1" });
    await t.transitionState(null, "pending", "created");
    await t.append("run.state_change", { from: "pending", to: "paused", reason: "evil" });

    const { listRuns } = await import("../../src/application/runList.js");
    const result = await listRuns({
      runDir, activeOnly: true, authorizedWorkspaceRoot: dir, knownAgentIds: ["coder_low"],
      // M12-15: a running run is active only with a FRESH owner heartbeat.
      // Inject a fresh liveness result so run_active is provably active.
      nowMs: 1_700_000_000_000,
      checkLivenessFn: () => ({ fresh: true, heartbeatAt: 1_700_000_000_000 - 1000 }),
    });
    const ids = result.runs.map((r) => r.runId);
    assert.ok(ids.includes("run_active"), "known active run must be returned");
    assert.ok(!ids.includes("run_evil"), "unknown-state run must be excluded by activeOnly");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("ACTIVEONLY-02: unknown state run still visible in normal list (no activeOnly)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-active-02-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-active-02-rd-"));
  try {
    makeGitRepo(dir);
    await seedRun(runDir, "run_ok", dir, "running", "coder_low");
    const tp = join(runDir, "run_unknown_state.jsonl");
    const t = new JsonlTranscript(tp, { runId: "run_unknown_state", agentId: "coder_low" });
    await t.append("run.started", { backend: "claude-code" });
    await t.append("run.background_submitted", { background: true, cwd: dir });
    await t.append("session.created", { backend: "process", backendSessionId: "proc_1" });
    await t.transitionState(null, "pending", "created");
    await t.append("run.state_change", { from: "pending", to: "paused", reason: "evil" });

    const { listRuns } = await import("../../src/application/runList.js");
    const result = await listRuns({
      runDir, authorizedWorkspaceRoot: dir, knownAgentIds: ["coder_low"],
    });
    const evil = result.runs.find((r) => r.runId === "run_unknown_state");
    assert.ok(evil, "unknown-state run must still appear in normal list (not hidden)");
    assert.equal(evil.state, "unknown", "state must be 'unknown'");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("ACTIVEONLY-03: terminal states excluded by activeOnly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-active-03-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-active-03-rd-"));
  try {
    makeGitRepo(dir);
    await seedRun(runDir, "run_active", dir, "running");
    await seedRun(runDir, "run_done", dir, "completed");
    const { listRuns } = await import("../../src/application/runList.js");
    const result = await listRuns({
      runDir, activeOnly: true, authorizedWorkspaceRoot: dir, knownAgentIds: ["coder_low"],
      // M12-15: a running run is active only with a FRESH owner heartbeat.
      // Inject a fresh liveness result so run_active is provably active.
      nowMs: 1_700_000_000_000,
      checkLivenessFn: () => ({ fresh: true, heartbeatAt: 1_700_000_000_000 - 1000 }),
    });
    const ids = result.runs.map((r) => r.runId);
    assert.ok(ids.includes("run_active"), "running must be returned");
    assert.ok(!ids.includes("run_done"), "completed must be excluded");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// ── M12-15: real ownerLiveness SSOT integration (deterministic via nowMs) ────
//
// Proves the REAL checkOwnerLiveness SSOT (no injected checker) classifies
// fresh / stale / missing / corrupt heartbeat files correctly under a single
// injected nowMs snapshot. Transcripts + workspace proof are injected; only the
// heartbeat files are real on disk so the SSOT's existsSync/readFileSync path
// is exercised truthfully.

const CLOSEOUT_NOW = 1_700_000_000_000;

function closeoutReader(eventsByFile) {
  return async (filePath) => eventsByFile.get(basename(filePath));
}

function closeoutEvents(runId, cwd) {
  const ts = "2026-07-01T00:00:00Z";
  return [
    { type: "run.started", runId, agentId: "coder_low", ts, seq: 1 },
    { type: "run.background_submitted", runId, agentId: "coder_low", cwd, background: true, ts, seq: 2 },
    { type: "run.state_change", runId, agentId: "coder_low", from: "pending", to: "running", reason: "go", ts, seq: 3 },
  ];
}

function closeoutVerifier(authorizedRoot) {
  return (events) => {
    const cwd = events.find((e) => e.type === "run.background_submitted")?.cwd;
    if (cwd !== authorizedRoot) throw new Error("workspace mismatch");
    return { authorized: true, ownershipCwd: cwd };
  };
}

test("M12-15-REAL-01: real ownerLiveness — fresh/stale/missing/corrupt heartbeat classified truthfully", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1215-real-01-"));
  const ROOT = "C:\\Target\\Repo";
  const fresh = "run_20260701170000040alpha";
  const stale = "run_20260701170000041bravo";
  const missing = "run_20260701170000042charlie";
  const corrupt = "run_20260701170000043delta";
  for (const id of [fresh, stale, missing, corrupt]) {
    writeFileSync(join(runDir, `${id}.jsonl`), "", "utf8");
  }
  // Real heartbeat files — exactly what backgroundRunner writes to .owner-<runId>.
  writeFileSync(join(runDir, `.owner-${fresh}`), JSON.stringify({ heartbeatAt: CLOSEOUT_NOW - 1000 }));
  writeFileSync(join(runDir, `.owner-${stale}`), JSON.stringify({ heartbeatAt: CLOSEOUT_NOW - 99999 }));
  writeFileSync(join(runDir, `.owner-${corrupt}`), "NOT VALID JSON");
  // `missing` gets NO heartbeat file.
  const eventsByFile = new Map([
    [`${fresh}.jsonl`, closeoutEvents(fresh, ROOT)],
    [`${stale}.jsonl`, closeoutEvents(stale, ROOT)],
    [`${missing}.jsonl`, closeoutEvents(missing, ROOT)],
    [`${corrupt}.jsonl`, closeoutEvents(corrupt, ROOT)],
  ]);
  try {
    const { listRuns } = await import("../../src/application/runList.js");
    const result = await listRuns({
      runDir, nowMs: CLOSEOUT_NOW,
      readTranscriptFn: closeoutReader(eventsByFile),
      createWorkspaceVerifierFn: () => closeoutVerifier(ROOT),
      knownAgentIds: ["coder_low"],
    });
    const byId = new Map(result.runs.map((r) => [r.runId, r]));
    assert.equal(byId.get(fresh).activityStatus, "active", "fresh heartbeat → active");
    assert.equal(byId.get(fresh).activityBasis, "fresh_owner_heartbeat");
    assert.equal(byId.get(stale).activityStatus, "unresolved", "stale heartbeat → unresolved");
    assert.equal(byId.get(missing).activityStatus, "unresolved", "missing heartbeat → unresolved");
    assert.equal(byId.get(corrupt).activityStatus, "unresolved", "corrupt heartbeat → unresolved");
    assert.equal(result.unresolvedCount, 3, "stale + missing + corrupt are all unresolved");

    // activeOnly must surface ONLY the one provably-active run.
    const activeOnly = await listRuns({
      runDir, activeOnly: true, nowMs: CLOSEOUT_NOW,
      readTranscriptFn: closeoutReader(eventsByFile),
      createWorkspaceVerifierFn: () => closeoutVerifier(ROOT),
      knownAgentIds: ["coder_low"],
    });
    assert.deepEqual(activeOnly.runs.map((r) => r.runId), [fresh]);
    assert.equal(activeOnly.matchedCount, 1);
    assert.equal(activeOnly.unresolvedCount, 3);
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

test("M12-15-REAL-02: a legitimately long-running run with a fresh heartbeat stays active (never silently terminal/hidden)", async () => {
  // Independent-review question guard: a long-running / sleeping run MUST NOT be
  // silently labeled terminal/failed/hidden. As long as the owner heartbeat is
  // fresh, it is active — regardless of how long the run has been running.
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1215-real-02-"));
  const ROOT = "C:\\Target\\Repo";
  const longRun = "run_20260601120000000june"; // a "historical June" run id
  writeFileSync(join(runDir, `${longRun}.jsonl`), "", "utf8");
  // Heartbeat updated 1 second ago — the runner is alive RIGHT NOW.
  writeFileSync(join(runDir, `.owner-${longRun}`), JSON.stringify({ heartbeatAt: CLOSEOUT_NOW - 1000 }));
  const eventsByFile = new Map([[`${longRun}.jsonl`, closeoutEvents(longRun, ROOT)]]);
  try {
    const { listRuns } = await import("../../src/application/runList.js");
    const ordinary = await listRuns({
      runDir, nowMs: CLOSEOUT_NOW,
      readTranscriptFn: closeoutReader(eventsByFile),
      createWorkspaceVerifierFn: () => closeoutVerifier(ROOT),
      knownAgentIds: ["coder_low"],
    });
    assert.equal(ordinary.runs[0].activityStatus, "active", "fresh heartbeat → active (not hidden)");
    assert.equal(ordinary.runs[0].activityBasis, "fresh_owner_heartbeat");
    const activeOnly = await listRuns({
      runDir, activeOnly: true, nowMs: CLOSEOUT_NOW,
      readTranscriptFn: closeoutReader(eventsByFile),
      createWorkspaceVerifierFn: () => closeoutVerifier(ROOT),
      knownAgentIds: ["coder_low"],
    });
    assert.deepEqual(activeOnly.runs.map((r) => r.runId), [longRun], "discoverable as active");
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});
