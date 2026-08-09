// test/runsList.test.js
//
// M10 P0-3: runs_list service + MCP tool tests.
// Covers ownership SSOT, listRuns service, CLI parity, MCP isolation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { JsonlTranscript } from "../src/transcript.js";
import { createWaoMcpServer } from "../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// ── helpers ──────────────────────────────────────────────────────────────────

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

// ── Ownership SSOT tests ─────────────────────────────────────────────────────

test("OWN-01: findRunWorkspaceOwnership extracts cwd from events", async () => {
  const { findRunWorkspaceOwnership } = await import("../src/application/runWorkspaceOwnership.js");
  const events = [
    { type: "run.started", agentId: "a" },
    { type: "run.background_submitted", cwd: "/some/path" },
  ];
  const result = findRunWorkspaceOwnership(events);
  assert.equal(result.cwd, "/some/path");
});

test("OWN-02: missing ownership returns null", async () => {
  const { findRunWorkspaceOwnership } = await import("../src/application/runWorkspaceOwnership.js");
  const events = [{ type: "run.started", agentId: "a" }];
  assert.equal(findRunWorkspaceOwnership(events), null);
});

test("OWN-03: duplicate ownership throws", async () => {
  const { findRunWorkspaceOwnership } = await import("../src/application/runWorkspaceOwnership.js");
  const events = [
    { type: "run.background_submitted", cwd: "/a" },
    { type: "run.background_submitted", cwd: "/b" },
  ];
  assert.throws(() => findRunWorkspaceOwnership(events), /ambiguous/);
});

test("OWN-04: malformed ownership throws", async () => {
  const { findRunWorkspaceOwnership } = await import("../src/application/runWorkspaceOwnership.js");
  const events = [{ type: "run.background_submitted" }]; // no cwd
  assert.throws(() => findRunWorkspaceOwnership(events), /malformed/);
});

test("OWN-05: verifyRunWorkspaceOwnership — same root passes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-own-05-"));
  try {
    makeGitRepo(dir);
    const { verifyRunWorkspaceOwnership } = await import("../src/application/runWorkspaceOwnership.js");
    const events = [{ type: "run.background_submitted", cwd: dir }];
    const result = verifyRunWorkspaceOwnership(events, dir);
    assert.equal(result.authorized, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("OWN-06: verifyRunWorkspaceOwnership — other repo rejected", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "wao-own-06a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wao-own-06b-"));
  try {
    makeGitRepo(dirA);
    makeGitRepo(dirB);
    const { verifyRunWorkspaceOwnership } = await import("../src/application/runWorkspaceOwnership.js");
    const events = [{ type: "run.background_submitted", cwd: dirA }];
    assert.throws(() => verifyRunWorkspaceOwnership(events, dirB), /mismatch/);
  } finally { rmSync(dirA, { recursive: true, force: true }); rmSync(dirB, { recursive: true, force: true }); }
});

test("OWN-07: subdirectory rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-own-07-"));
  try {
    makeGitRepo(dir);
    const subdir = join(dir, "nested");
    mkdirSync(subdir);
    const { verifyRunWorkspaceOwnership } = await import("../src/application/runWorkspaceOwnership.js");
    const events = [{ type: "run.background_submitted", cwd: subdir }];
    assert.throws(() => verifyRunWorkspaceOwnership(events, dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── listRuns service tests ───────────────────────────────────────────────────

test("LIST-01: default returns all runs sorted by runId (CLI mode)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-list-01-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-list-01-rd-"));
  try {
    makeGitRepo(dir);
    await seedRun(runDir, "run_bbb", dir, "running");
    await seedRun(runDir, "run_aaa", dir, "completed");
    const { listRuns } = await import("../src/application/runList.js");
    const result = await listRuns({ runDir, knownAgentIds: [] });
    // Service sorts by updatedAt desc, but CLI re-sorts by runId. Here we test service directly.
    assert.ok(result.runs.length >= 2);
    assert.ok(result.runs.some((r) => r.runId === "run_aaa"));
    assert.ok(result.runs.some((r) => r.runId === "run_bbb"));
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("LIST-02: workspace filter only returns matching runs", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "wao-list-02a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wao-list-02b-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-list-02-rd-"));
  try {
    makeGitRepo(dirA);
    makeGitRepo(dirB);
    await seedRun(runDir, "run_a", dirA);
    await seedRun(runDir, "run_b", dirB);
    const { listRuns } = await import("../src/application/runList.js");
    const result = await listRuns({ runDir, authorizedWorkspaceRoot: dirA, knownAgentIds: [] });
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].runId, "run_a");
  } finally { rmSync(dirA, { recursive: true, force: true }); rmSync(dirB, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("LIST-03: wf_* transcripts excluded", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-list-03-"));
  try {
    writeFileSync(join(runDir, "run_valid.jsonl"), JSON.stringify({ type: "run.started", agentId: "a", runId: "run_valid" }) + "\n");
    writeFileSync(join(runDir, "wf_workflow.jsonl"), JSON.stringify({ type: "workflow.started" }) + "\n");
    const { listRuns } = await import("../src/application/runList.js");
    const result = await listRuns({ runDir, knownAgentIds: [] });
    assert.ok(result.runs.every((r) => r.runId.startsWith("run_")));
    assert.ok(!result.runs.some((r) => r.runId.startsWith("wf_")));
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

test("LIST-04: activeOnly filters terminal runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-list-04-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-list-04-rd-"));
  try {
    makeGitRepo(dir);
    await seedRun(runDir, "run_active", dir, "running");
    await seedRun(runDir, "run_done", dir, "completed");
    const { listRuns } = await import("../src/application/runList.js");
    const result = await listRuns({
      runDir, activeOnly: true, knownAgentIds: [],
      // M12-15: a running run is active only with a FRESH owner heartbeat.
      // Inject a fresh liveness result so run_active is provably active.
      nowMs: 1_700_000_000_000,
      checkLivenessFn: () => ({ fresh: true, heartbeatAt: 1_700_000_000_000 - 1000 }),
    });
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].runId, "run_active");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("LIST-05: malformed transcript skipped silently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-list-05-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-list-05-rd-"));
  try {
    makeGitRepo(dir);
    await seedRun(runDir, "run_good", dir);
    writeFileSync(join(runDir, "run_bad.jsonl"), "NOT VALID JSON\n");
    const { listRuns } = await import("../src/application/runList.js");
    const result = await listRuns({ runDir, knownAgentIds: [] });
    assert.ok(result.runs.some((r) => r.runId === "run_good"));
    assert.ok(!result.runs.some((r) => r.runId === "run_bad"));
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("LIST-06: read-only — transcript bytes unchanged after call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-list-06-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-list-06-rd-"));
  try {
    makeGitRepo(dir);
    await seedRun(runDir, "run_ro", dir);
    const { readFileSync } = await import("node:fs");
    const before = readFileSync(join(runDir, "run_ro.jsonl"));
    const { listRuns } = await import("../src/application/runList.js");
    await listRuns({ runDir, knownAgentIds: [] });
    const after = readFileSync(join(runDir, "run_ro.jsonl"));
    assert.deepEqual(after, before, "transcript bytes must be identical");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// ── MCP runs_list tests ──────────────────────────────────────────────────────

test("MCP-01: tool list includes runs_list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcpruns-01-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      assert.ok(names.includes("runs_list"));
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP-02: only current workspace runs visible", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "wao-mcpruns-02a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wao-mcpruns-02b-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-mcpruns-02-rd-"));
  try {
    makeGitRepo(dirA); makeGitRepo(dirB);
    await seedRun(runDir, "run_a1", dirA, "running", "coder_low");
    await seedRun(runDir, "run_b1", dirB, "running", "coder_hq");
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dirA });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "runs_list", arguments: {} });
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.runs.length, 1);
      assert.equal(parsed.runs[0].runId, "run_a1");
      // Project B run invisible
      assert.ok(!JSON.stringify(parsed).includes("run_b1"));
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dirA, { recursive: true, force: true }); rmSync(dirB, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("MCP-03: workspace not bound → fixed error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcpruns-03-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "runs_list", arguments: {} });
      assert.ok(res.isError);
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP-04: extra args rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcpruns-04-"));
  try {
    makeGitRepo(dir);
    let serviceCalls = 0;
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      listRunsFn: async () => { serviceCalls++; return { runs: [], matchedCount: 0 }; },
    });
    const client = await buildClient(server);
    try {
      await client.callTool({ name: "runs_list", arguments: { evil: true } });
    } catch {
      // zod rejects — OK
    } finally { await client.close(); await server.close(); }
    assert.equal(serviceCalls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP-05: safe output — no path/prompt/command/session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcpruns-05-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-mcpruns-05-rd-"));
  try {
    makeGitRepo(dir);
    await seedRun(runDir, "run_safe", dir, "running", "coder_low");
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "runs_list", arguments: {} });
      const json = res.content[0].text;
      assert.ok(!json.includes(dir), "no absolute path");
      assert.ok(!json.includes("proc_"), "no session id");
      assert.ok(!json.includes("prompt"), "no prompt");
      assert.ok(!json.includes("command"), "no command");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("MCP-06: annotations correct", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcpruns-06-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      const t = tools.tools.find((t) => t.name === "runs_list");
      assert.equal(t.annotations.readOnlyHint, true);
      assert.equal(t.annotations.destructiveHint, false);
      assert.equal(t.annotations.idempotentHint, true);
      assert.equal(t.annotations.openWorldHint, false);
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Architecture boundary ────────────────────────────────────────────────────

test("AGENTID-01: MCP path maps unregistered agentId to 'unknown' even when registry empty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-agentid-01-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-agentid-01-rd-"));
  try {
    makeGitRepo(dir);
    // Seed run with an agentId that won't be in any registry
    await seedRun(runDir, "run_evil_agent", dir, "running", "<<INJECTED>>");
    const { listRuns } = await import("../src/application/runList.js");
    // MCP path: validateAgentIds defaults to true, knownAgentIds=[] → all "unknown"
    const result = await listRuns({
      runDir,
      authorizedWorkspaceRoot: dir,
      knownAgentIds: [],
    });
    assert.ok(result.runs.length > 0);
    assert.equal(result.runs[0].agentId, "unknown", "injected agentId must be mapped to 'unknown'");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("STATE-01: unrecognized state maps to 'unknown' without breaking the list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-state-01-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-state-01-rd-"));
  try {
    makeGitRepo(dir);
    // Seed a good run
    await seedRun(runDir, "run_good", dir, "running");
    // Seed a run with an unrecognized state
    const tp = join(runDir, "run_evil_state.jsonl");
    const t = new JsonlTranscript(tp, { runId: "run_evil_state", agentId: "coder_low" });
    await t.append("run.started", { backend: "claude-code" });
    await t.append("run.background_submitted", { background: true, cwd: dir });
    await t.append("session.created", { backend: "process", backendSessionId: "proc_1" });
    await t.transitionState(null, "pending", "created");
    await t.append("run.state_change", { from: "pending", to: "paused", reason: "evil" }); // not in RUN_STATES
    const { listRuns } = await import("../src/application/runList.js");
    const result = await listRuns({
      runDir, authorizedWorkspaceRoot: dir, knownAgentIds: [],
    });
    // Both runs should appear; evil state mapped to "unknown"
    const good = result.runs.find((r) => r.runId === "run_good");
    const evil = result.runs.find((r) => r.runId === "run_evil_state");
    assert.ok(good, "good run must not be hidden by evil sibling");
    assert.ok(evil, "evil state run must appear (not crash the list)");
    assert.equal(evil.state, "unknown", "unrecognized state must be 'unknown'");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("ARCH-01: runWorkspaceOwnership does not import commands/mcp/SDK/zod", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(join(fileURLToPath(new URL(".", import.meta.url))), "..", "src", "application", "runWorkspaceOwnership.js"), "utf8");
  assert.ok(!src.includes('from "../commands/'), "no commands/");
  assert.ok(!src.includes('from "../mcp/'), "no mcp/");
  assert.ok(!src.includes("@modelcontextprotocol/sdk"), "no SDK");
  assert.ok(!src.includes('from "zod"'), "no zod");
});

test("ARCH-02: runList does not import commands/mcp/SDK/zod/daemon", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(join(fileURLToPath(new URL(".", import.meta.url))), "..", "src", "application", "runList.js"), "utf8");
  assert.ok(!src.includes('from "../commands/'), "no commands/");
  assert.ok(!src.includes('from "../mcp/'), "no mcp/");
  assert.ok(!src.includes("@modelcontextprotocol/sdk"), "no SDK");
  assert.ok(!src.includes('from "zod"'), "no zod");
  assert.ok(!src.includes('from "../daemon'), "no daemon import");
});

// ── M12-15: stale active-run truth (one shared activity projection) ──────────
//
// runs_list(activeOnly:true) and lead_preflight must classify a run as
// activityStatus=active ONLY when a KNOWN NON-TERMINAL transcript has a FRESH
// owner heartbeat (ownerLiveness SSOT). A non-terminal run with a stale /
// missing / corrupt heartbeat is activityStatus=unresolved — NEVER inferred
// failed/dead/stopped, and still discoverable in the ordinary list. Terminal
// and unknown-state runs are never reported active. One nowMs snapshot per
// call; ownerLiveness is called exactly once per eligible (known non-terminal)
// run. All cases below are deterministic through injected nowMs + a liveness
// checker + an injected transcript reader / workspace verifier (no real Git,
// no wall clock, no heartbeat files).

const M12_15_NOW = 1_700_000_000_000; // fixed ms snapshot

function m1215EmptyRunFile(runDir, runId) {
  writeFileSync(join(runDir, `${runId}.jsonl`), "", "utf8");
}

function m1215Events(runId, cwd, state, agentId = "coder_low") {
  const ts = "2026-07-01T00:00:00Z";
  const ev = [
    { type: "run.started", runId, agentId, ts, seq: 1 },
    { type: "run.background_submitted", runId, agentId, cwd, background: true, ts, seq: 2 },
  ];
  if (state === "running" || state === "completed") {
    ev.push({ type: "run.state_change", runId, agentId, from: "pending", to: "running", reason: "go", ts, seq: 3 });
  }
  if (state === "completed") {
    ev.push({ type: "run.state_change", runId, agentId, from: "running", to: "completed", reason: "done", ts, seq: 4 });
  }
  if (state === "unknown") {
    // "paused" is not in RUN_STATES → maps to "unknown"
    ev.push({ type: "run.state_change", runId, agentId, from: "pending", to: "paused", reason: "evil", ts, seq: 3 });
  }
  return ev;
}

function m1215Reader(eventsByFile) {
  return async (filePath) => eventsByFile.get(basename(filePath));
}

// Authorized-root verifier: authorizes runs whose ownership cwd equals ROOT,
// throws (fail-closed) for any other workspace.
function m1215Verifier(authorizedRoot) {
  return (events) => {
    const cwd = events.find((e) => e.type === "run.background_submitted")?.cwd;
    if (cwd !== authorizedRoot) throw new Error("workspace mismatch");
    return { authorized: true, ownershipCwd: cwd };
  };
}

function m1215LivenessSpy(map) {
  const calls = [];
  return {
    calls,
    fn: (runDir, runId, now, threshold) => {
      calls.push({ runDir, runId, now, threshold });
      return map[runId] ?? { fresh: false, heartbeatAt: null };
    },
  };
}

test("M12-15-ACT-01: fresh owner heartbeat → activityStatus=active, basis=fresh_owner_heartbeat", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1215-01-"));
  const ROOT = "C:\\Target\\Repo";
  const runId = "run_20260701170000001alpha";
  m1215EmptyRunFile(runDir, runId);
  const eventsByFile = new Map([[`${runId}.jsonl`, m1215Events(runId, ROOT, "running")]]);
  const liveness = m1215LivenessSpy({ [runId]: { fresh: true, heartbeatAt: M12_15_NOW - 1000 } });
  try {
    const { listRuns } = await import("../src/application/runList.js");
    const result = await listRuns({
      runDir,
      nowMs: M12_15_NOW,
      checkLivenessFn: liveness.fn,
      readTranscriptFn: m1215Reader(eventsByFile),
      createWorkspaceVerifierFn: () => m1215Verifier(ROOT),
      knownAgentIds: ["coder_low"],
    });
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].activityStatus, "active");
    assert.equal(result.runs[0].activityBasis, "fresh_owner_heartbeat");
    assert.equal(result.unresolvedCount, 0);
    // Single nowMs snapshot threaded to the SSOT call.
    assert.deepEqual(liveness.calls.map((c) => c.now), [M12_15_NOW]);
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

test("M12-15-ACT-02: stale owner heartbeat → activityStatus=unresolved, basis=no_fresh_owner_heartbeat", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1215-02-"));
  const ROOT = "C:\\Target\\Repo";
  const runId = "run_20260701170000002bravo";
  m1215EmptyRunFile(runDir, runId);
  const eventsByFile = new Map([[`${runId}.jsonl`, m1215Events(runId, ROOT, "running")]]);
  const liveness = m1215LivenessSpy({ [runId]: { fresh: false, heartbeatAt: M12_15_NOW - 99999 } });
  try {
    const { listRuns } = await import("../src/application/runList.js");
    const result = await listRuns({
      runDir, nowMs: M12_15_NOW, checkLivenessFn: liveness.fn,
      readTranscriptFn: m1215Reader(eventsByFile),
      createWorkspaceVerifierFn: () => m1215Verifier(ROOT),
      knownAgentIds: ["coder_low"],
    });
    assert.equal(result.runs[0].activityStatus, "unresolved");
    assert.equal(result.runs[0].activityBasis, "no_fresh_owner_heartbeat");
    assert.equal(result.unresolvedCount, 1);
    // Unresolved is NEVER relabeled failed/dead/stopped.
    assert.notEqual(result.runs[0].activityStatus, "failed");
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

test("M12-15-ACT-03: missing owner heartbeat (no file) → unresolved (not active)", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1215-03-"));
  const ROOT = "C:\\Target\\Repo";
  const runId = "run_20260701170000003charlie";
  m1215EmptyRunFile(runDir, runId);
  const eventsByFile = new Map([[`${runId}.jsonl`, m1215Events(runId, ROOT, "running")]]);
  // Liveness returns the exact shape checkOwnerLiveness yields for a missing file.
  const liveness = m1215LivenessSpy({ [runId]: { fresh: false, heartbeatAt: null } });
  try {
    const { listRuns } = await import("../src/application/runList.js");
    const result = await listRuns({
      runDir, nowMs: M12_15_NOW, checkLivenessFn: liveness.fn,
      readTranscriptFn: m1215Reader(eventsByFile),
      createWorkspaceVerifierFn: () => m1215Verifier(ROOT),
      knownAgentIds: ["coder_low"],
    });
    assert.equal(result.runs[0].activityStatus, "unresolved");
    assert.equal(result.runs[0].activityBasis, "no_fresh_owner_heartbeat");
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

test("M12-15-ACT-04: terminal transcript → activityStatus=terminal, basis=terminal_state; liveness NOT checked", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1215-04-"));
  const ROOT = "C:\\Target\\Repo";
  const runId = "run_20260701170000004delta";
  m1215EmptyRunFile(runDir, runId);
  const eventsByFile = new Map([[`${runId}.jsonl`, m1215Events(runId, ROOT, "completed")]]);
  const liveness = m1215LivenessSpy({ [runId]: { fresh: true, heartbeatAt: M12_15_NOW } });
  try {
    const { listRuns } = await import("../src/application/runList.js");
    const result = await listRuns({
      runDir, nowMs: M12_15_NOW, checkLivenessFn: liveness.fn,
      readTranscriptFn: m1215Reader(eventsByFile),
      createWorkspaceVerifierFn: () => m1215Verifier(ROOT),
      knownAgentIds: ["coder_low"],
    });
    assert.equal(result.runs[0].activityStatus, "terminal");
    assert.equal(result.runs[0].activityBasis, "terminal_state");
    assert.equal(result.runs[0].terminal, true);
    // Terminal runs are not eligible — ownerLiveness must not be called.
    assert.equal(liveness.calls.length, 0);
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

test("M12-15-ACT-05: unknown transcript state → activityStatus=unknown; fail-closed, not active; liveness NOT checked", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1215-05-"));
  const ROOT = "C:\\Target\\Repo";
  const runId = "run_20260701170000005echo";
  m1215EmptyRunFile(runDir, runId);
  const eventsByFile = new Map([[`${runId}.jsonl`, m1215Events(runId, ROOT, "unknown")]]);
  const liveness = m1215LivenessSpy({});
  try {
    const { listRuns } = await import("../src/application/runList.js");
    const result = await listRuns({
      runDir, nowMs: M12_15_NOW, checkLivenessFn: liveness.fn,
      readTranscriptFn: m1215Reader(eventsByFile),
      createWorkspaceVerifierFn: () => m1215Verifier(ROOT),
      knownAgentIds: ["coder_low"],
    });
    assert.equal(result.runs[0].state, "unknown");
    assert.equal(result.runs[0].activityStatus, "unknown");
    assert.equal(result.runs[0].activityBasis, "unknown_state");
    assert.equal(liveness.calls.length, 0, "unknown state must not trigger a liveness check");
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

test("M12-15-ACT-06: activeOnly returns ONLY proven-active runs (terminal/unknown/unresolved excluded)", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1215-06-"));
  const ROOT = "C:\\Target\\Repo";
  const active = "run_20260701170000006foxtrot";
  const stale = "run_20260701170000007golf";
  const done = "run_20260701170000008hotel";
  const evil = "run_20260701170000009india";
  for (const id of [active, stale, done, evil]) m1215EmptyRunFile(runDir, id);
  const eventsByFile = new Map([
    [`${active}.jsonl`, m1215Events(active, ROOT, "running")],
    [`${stale}.jsonl`, m1215Events(stale, ROOT, "running")],
    [`${done}.jsonl`, m1215Events(done, ROOT, "completed")],
    [`${evil}.jsonl`, m1215Events(evil, ROOT, "unknown")],
  ]);
  const liveness = m1215LivenessSpy({
    [active]: { fresh: true, heartbeatAt: M12_15_NOW - 500 },
    [stale]: { fresh: false, heartbeatAt: M12_15_NOW - 99999 },
  });
  try {
    const { listRuns } = await import("../src/application/runList.js");
    const result = await listRuns({
      runDir, activeOnly: true, nowMs: M12_15_NOW, checkLivenessFn: liveness.fn,
      readTranscriptFn: m1215Reader(eventsByFile),
      createWorkspaceVerifierFn: () => m1215Verifier(ROOT),
      knownAgentIds: ["coder_low"],
    });
    const ids = result.runs.map((r) => r.runId);
    assert.deepEqual(ids, [active], "only the proven-active run is returned");
    assert.equal(result.matchedCount, 1, "matchedCount counts proven-active only");
    assert.equal(result.unresolvedCount, 1, "the stale run is unresolved (not active, not hidden)");
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

test("M12-15-ACT-07: ordinary list (activeOnly:false) keeps unresolved runs discoverable with bounded fields", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1215-07-"));
  const ROOT = "C:\\Target\\Repo";
  const active = "run_20260701170000010juliet";
  const stale = "run_20260701170000011kilo";
  const done = "run_20260701170000012lima";
  const evil = "run_20260701170000013mike";
  for (const id of [active, stale, done, evil]) m1215EmptyRunFile(runDir, id);
  const eventsByFile = new Map([
    [`${active}.jsonl`, m1215Events(active, ROOT, "running")],
    [`${stale}.jsonl`, m1215Events(stale, ROOT, "running")],
    [`${done}.jsonl`, m1215Events(done, ROOT, "completed")],
    [`${evil}.jsonl`, m1215Events(evil, ROOT, "unknown")],
  ]);
  const liveness = m1215LivenessSpy({
    [active]: { fresh: true, heartbeatAt: M12_15_NOW - 500 },
    [stale]: { fresh: false, heartbeatAt: M12_15_NOW - 99999 },
  });
  try {
    const { listRuns } = await import("../src/application/runList.js");
    const result = await listRuns({
      runDir, nowMs: M12_15_NOW, checkLivenessFn: liveness.fn,
      readTranscriptFn: m1215Reader(eventsByFile),
      createWorkspaceVerifierFn: () => m1215Verifier(ROOT),
      knownAgentIds: ["coder_low"],
    });
    const byId = new Map(result.runs.map((r) => [r.runId, r]));
    assert.equal(result.runs.length, 4, "all in-workspace runs remain visible");
    assert.equal(byId.get(active).activityStatus, "active");
    assert.equal(byId.get(stale).activityStatus, "unresolved");
    assert.equal(byId.get(done).activityStatus, "terminal");
    assert.equal(byId.get(evil).activityStatus, "unknown");
    assert.equal(result.unresolvedCount, 1);
    assert.equal(result.matchedCount, 4);
    // Each summary carries the bounded safe activityStatus/activityBasis fields.
    for (const r of result.runs) {
      assert.ok(["terminal", "active", "unresolved", "unknown"].includes(r.activityStatus));
      assert.ok(typeof r.activityBasis === "string" && r.activityBasis.length > 0);
    }
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

test("M12-15-ACT-08: ownerLiveness called exactly once per eligible run; default threshold threaded", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1215-08-"));
  const ROOT = "C:\\Target\\Repo";
  const active = "run_20260701170000014november";
  const stale = "run_20260701170000015oscar";
  const done = "run_20260701170000016papa";
  const evil = "run_20260701170000017quebec";
  const foreign = "run_20260701170000018romeo";
  for (const id of [active, stale, done, evil, foreign]) m1215EmptyRunFile(runDir, id);
  const eventsByFile = new Map([
    [`${active}.jsonl`, m1215Events(active, ROOT, "running")],
    [`${stale}.jsonl`, m1215Events(stale, ROOT, "running")],
    [`${done}.jsonl`, m1215Events(done, ROOT, "completed")],
    [`${evil}.jsonl`, m1215Events(evil, ROOT, "unknown")],
    // foreign run lives in a DIFFERENT workspace → filtered before classification
    [`${foreign}.jsonl`, m1215Events(foreign, "D:\\Other\\Repo", "running")],
  ]);
  const liveness = m1215LivenessSpy({
    [active]: { fresh: true, heartbeatAt: M12_15_NOW - 500 },
    [stale]: { fresh: false, heartbeatAt: M12_15_NOW - 99999 },
    [foreign]: { fresh: true, heartbeatAt: M12_15_NOW },
  });
  try {
    const { listRuns } = await import("../src/application/runList.js");
    const result = await listRuns({
      runDir, nowMs: M12_15_NOW, checkLivenessFn: liveness.fn,
      authorizedWorkspaceRoot: ROOT,
      readTranscriptFn: m1215Reader(eventsByFile),
      createWorkspaceVerifierFn: () => m1215Verifier(ROOT),
      knownAgentIds: ["coder_low"],
    });
    // Eligible = known non-terminal in-workspace runs → active + stale only.
    assert.deepEqual(
      liveness.calls.map((c) => c.runId).sort(),
      [active, stale].sort(),
      "liveness checked once per eligible run; not terminal/unknown/foreign",
    );
    // Each eligible run checked exactly once.
    assert.equal(liveness.calls.length, 2);
    // Default threshold (ownerLiveness SSOT default) is threaded through.
    const { DEFAULT_OWNER_LIVENESS_THRESHOLD_MS } = await import("../src/application/ownerLiveness.js");
    assert.ok(liveness.calls.every((c) => c.threshold === DEFAULT_OWNER_LIVENESS_THRESHOLD_MS));
    // Workspace isolation: foreign run never appears.
    assert.ok(!result.runs.some((r) => r.runId === foreign));
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

test("M12-15-ACT-09: unresolvedCount reflects the FULL scan even when limit truncates runs", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1215-09-"));
  const ROOT = "C:\\Target\\Repo";
  const actives = Array.from({ length: 3 }, (_, i) => `run_2026070117000002${i}sierra`);
  const stales = Array.from({ length: 2 }, (_, i) => `run_2026070117000003${i}tango`);
  for (const id of [...actives, ...stales]) m1215EmptyRunFile(runDir, id);
  const eventsByFile = new Map();
  const livenessMap = {};
  for (const id of actives) {
    eventsByFile.set(`${id}.jsonl`, m1215Events(id, ROOT, "running"));
    livenessMap[id] = { fresh: true, heartbeatAt: M12_15_NOW - 500 };
  }
  for (const id of stales) {
    eventsByFile.set(`${id}.jsonl`, m1215Events(id, ROOT, "running"));
    livenessMap[id] = { fresh: false, heartbeatAt: M12_15_NOW - 99999 };
  }
  const liveness = m1215LivenessSpy(livenessMap);
  try {
    const { listRuns } = await import("../src/application/runList.js");
    // activeOnly=true, limit=1: only 1 active returned, but unresolvedCount is the full-scan count.
    const result = await listRuns({
      runDir, activeOnly: true, latest: 1, nowMs: M12_15_NOW, checkLivenessFn: liveness.fn,
      readTranscriptFn: m1215Reader(eventsByFile),
      createWorkspaceVerifierFn: () => m1215Verifier(ROOT),
      knownAgentIds: ["coder_low"],
    });
    assert.equal(result.runs.length, 1, "limit truncates the returned active runs");
    assert.equal(result.matchedCount, 3, "matchedCount = total proven-active (pre-limit)");
    assert.equal(result.unresolvedCount, 2, "unresolvedCount = full scan, unaffected by limit");
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

// ── M12-15: real in-memory MCP runs_list schema + behavior ───────────────────

test("M12-15-MCP-01: runs_list output declares activityStatus/activityBasis enums + unresolvedCount (SSOT)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1215-mcp01-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const { tools } = await client.listTools();
      const t = tools.find((x) => x.name === "runs_list");
      const schema = t.outputSchema;
      const runItem = schema.properties.runs.items;
      // The per-run closed-set enums are present...
      assert.deepEqual([...runItem.properties.activityStatus.enum].sort(),
        ["active", "terminal", "unknown", "unresolved"].sort());
      assert.deepEqual([...runItem.properties.activityBasis.enum].sort(),
        ["fresh_owner_heartbeat", "no_fresh_owner_heartbeat", "terminal_state", "unknown_state"].sort());
      // ...and unresolvedCount is a top-level field.
      assert.ok(schema.properties.unresolvedCount, "runs_list output declares unresolvedCount");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M12-15-MCP-02: runs_list maps activityStatus/activityBasis + unresolvedCount through the handler", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1215-mcp02-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      listRunsFn: async () => ({
        runs: [{
          runId: "run_20260701170000099zulu", agentId: "coder_low", state: "running",
          terminal: false, updatedAt: "2026-07-01T00:00:00.000Z",
          activityStatus: "active", activityBasis: "fresh_owner_heartbeat",
        }],
        matchedCount: 1,
        unresolvedCount: 2,
      }),
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "runs_list", arguments: { activeOnly: true } });
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.runs.length, 1);
      assert.equal(parsed.runs[0].activityStatus, "active");
      assert.equal(parsed.runs[0].activityBasis, "fresh_owner_heartbeat");
      assert.equal(parsed.unresolvedCount, 2);
      assert.equal(parsed.truncated, false);
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
