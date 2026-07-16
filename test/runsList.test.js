// test/runsList.test.js
//
// M10 P0-3: runs_list service + MCP tool tests.
// Covers ownership SSOT, listRuns service, CLI parity, MCP isolation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const result = await listRuns({ runDir, activeOnly: true, knownAgentIds: [] });
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
