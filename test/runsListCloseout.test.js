// test/runsListCloseout.test.js
//
// M10 P0-3 micro-closeout: agentId registry shape + activeOnly truthfulness.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { JsonlTranscript } from "../src/transcript.js";
import { createWaoMcpServer } from "../src/mcp/server.js";
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

    const { listRuns } = await import("../src/application/runList.js");
    const result = await listRuns({
      runDir, activeOnly: true, authorizedWorkspaceRoot: dir, knownAgentIds: ["coder_low"],
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

    const { listRuns } = await import("../src/application/runList.js");
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
    const { listRuns } = await import("../src/application/runList.js");
    const result = await listRuns({
      runDir, activeOnly: true, authorizedWorkspaceRoot: dir, knownAgentIds: ["coder_low"],
    });
    const ids = result.runs.map((r) => r.runId);
    assert.ok(ids.includes("run_active"), "running must be returned");
    assert.ok(!ids.includes("run_done"), "completed must be excluded");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});
