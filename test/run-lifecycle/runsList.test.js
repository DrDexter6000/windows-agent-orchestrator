// test/runsList.test.js
//
// M10 P0-3: runs_list service + MCP tool tests.
// Covers ownership SSOT, listRuns service, CLI parity, MCP isolation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { JsonlTranscript } from "../../src/transcript.js";
import { listRuns } from "../../src/application/runList.js";
import { createWaoMcpServer } from "../../src/mcp/server.js";
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
  const { findRunWorkspaceOwnership } = await import("../../src/application/runWorkspaceOwnership.js");
  const events = [
    { type: "run.started", agentId: "a" },
    { type: "run.background_submitted", cwd: "/some/path" },
  ];
  const result = findRunWorkspaceOwnership(events);
  assert.equal(result.cwd, "/some/path");
});

test("OWN-02: missing ownership returns null", async () => {
  const { findRunWorkspaceOwnership } = await import("../../src/application/runWorkspaceOwnership.js");
  const events = [{ type: "run.started", agentId: "a" }];
  assert.equal(findRunWorkspaceOwnership(events), null);
});

test("OWN-03: duplicate ownership throws", async () => {
  const { findRunWorkspaceOwnership } = await import("../../src/application/runWorkspaceOwnership.js");
  const events = [
    { type: "run.background_submitted", cwd: "/a" },
    { type: "run.background_submitted", cwd: "/b" },
  ];
  assert.throws(() => findRunWorkspaceOwnership(events), /ambiguous/);
});

test("OWN-04: malformed ownership throws", async () => {
  const { findRunWorkspaceOwnership } = await import("../../src/application/runWorkspaceOwnership.js");
  const events = [{ type: "run.background_submitted" }]; // no cwd
  assert.throws(() => findRunWorkspaceOwnership(events), /malformed/);
});

test("OWN-05: verifyRunWorkspaceOwnership — same root passes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-own-05-"));
  try {
    makeGitRepo(dir);
    const { verifyRunWorkspaceOwnership } = await import("../../src/application/runWorkspaceOwnership.js");
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
    const { verifyRunWorkspaceOwnership } = await import("../../src/application/runWorkspaceOwnership.js");
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
    const { verifyRunWorkspaceOwnership } = await import("../../src/application/runWorkspaceOwnership.js");
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
    const { listRuns } = await import("../../src/application/runList.js");
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
    const { listRuns } = await import("../../src/application/runList.js");
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
    const { listRuns } = await import("../../src/application/runList.js");
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
    const { listRuns } = await import("../../src/application/runList.js");
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
    const { listRuns } = await import("../../src/application/runList.js");
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
    const { listRuns } = await import("../../src/application/runList.js");
    await listRuns({ runDir, knownAgentIds: [] });
    const after = readFileSync(join(runDir, "run_ro.jsonl"));
    assert.deepEqual(after, before, "transcript bytes must be identical");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

// ── MCP 运行清单测试（决定 0129：runs_list 已删，经 lead_preflight recentRuns）──

test("MCP-01: tool list folds runs_list into lead_preflight (decision 0129)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcpruns-01-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      assert.equal(names.includes("runs_list"), false, "runs_list folded away (decision 0129)");
      assert.ok(names.includes("lead_preflight"), "lead_preflight is the survivor");
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
      const res = await client.callTool({ name: "lead_preflight", arguments: { recentRuns: { limit: 10 } } });
      const parsed = JSON.parse(res.content[0].text);
      assert.ok(parsed.recentRuns, "recentRuns section present when requested");
      assert.equal(parsed.recentRuns.runs.length, 1);
      assert.equal(parsed.recentRuns.runs[0].runId, "run_a1");
      // Project B run invisible
      assert.ok(!JSON.stringify(parsed.recentRuns).includes("run_b1"));
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dirA, { recursive: true, force: true }); rmSync(dirB, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("MCP-02b: recentRuns activeOnly filters proven-active runs BEFORE the limit (runs_list parity)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcpruns-02b-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-mcpruns-02b-rd-"));
  try {
    makeGitRepo(dir);
    // Older run stays non-terminal with a FRESH owner heartbeat → proven active.
    await seedRun(runDir, "run_old_active", dir, "running", "coder_low");
    writeFileSync(
      join(runDir, ".owner-run_old_active"),
      JSON.stringify({ heartbeatAt: Date.now(), pid: process.pid }),
      "utf8",
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    // Newer run is terminal → the plain (newest-first) limit would pick it.
    await seedRun(runDir, "run_new_done", dir, "completed", "coder_low");
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const plain = JSON.parse((await client.callTool({
        name: "lead_preflight", arguments: { recentRuns: { limit: 1 } },
      })).content[0].text);
      assert.deepEqual(plain.recentRuns.runs.map((r) => r.runId), ["run_new_done"],
        "plain limit: newest first, truncated after the limit");
      assert.equal(plain.recentRuns.truncated, true);
      const active = JSON.parse((await client.callTool({
        name: "lead_preflight", arguments: { recentRuns: { limit: 1, activeOnly: true } },
      })).content[0].text);
      assert.deepEqual(active.recentRuns.runs.map((r) => r.runId), ["run_old_active"],
        "activeOnly filters proven-active runs FIRST, then truncates (same as runs_list)");
      assert.equal(active.recentRuns.runs[0].activityStatus, "active");
      assert.equal(active.recentRuns.truncated, false, "only one run matched the active filter");
    } finally { await client.close(); await server.close(); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("MCP-02c: unprovable workspace authority during the scan → recentRuns/activeRuns null (never a fabricated empty list)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcpruns-02c-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({
      registryPath: "/r.json",
      runDir: dir,
      workspaceRoot: dir,
      // 决定 0129（会审修）：复证失败的服务标记必须被 preflight 当成"读不出"，
      // 而不是零条 + complete:true。
      listRunsFn: async () => ({ runs: [], matchedCount: 0, workspaceAuthorizationUnavailable: true }),
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "lead_preflight", arguments: { recentRuns: { limit: 10 } } });
      const parsed = JSON.parse(res.content[0].text);
      assert.notEqual(res.isError, true, "sections settle honestly, not a hard error");
      assert.equal(parsed.recentRuns, null, "requested but unreadable → null, never an empty list");
      assert.equal(parsed.activeRuns, null, "active-run section is unknown too");
      assert.equal(parsed.checkStatus.activeRuns, "unknown");
      assert.equal(parsed.complete, false);
      assert.ok(parsed.warnings.some((w) => /could not be read/.test(w)), "honest warning present");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP-03: workspace not bound → recentRuns null + workspace.bound:false (honest, no scan)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcpruns-03-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir });
    const client = await buildClient(server);
    try {
      // 决定 0129：原 runs_list 的"未绑定固定错误"不再存在——preflight 如实
      // 报 workspace.bound:false，recentRuns 为 null（无可扫描范围，不跨项目）。
      const res = await client.callTool({ name: "lead_preflight", arguments: { recentRuns: { limit: 10 } } });
      const parsed = JSON.parse(res.content[0].text);
      assert.notEqual(res.isError, true, "not an error — sections settle honestly");
      assert.equal(parsed.workspace.bound, false, "workspace reported unbound");
      assert.equal(parsed.recentRuns, null, "recentRuns stays null (never cross-workspace)");
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
      await client.callTool({ name: "lead_preflight", arguments: { recentRuns: { limit: 5 }, evil: true } });
    } catch {
      // zod rejects — OK
    } finally { await client.close(); await server.close(); }
    assert.equal(serviceCalls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP-05: safe recentRuns output — no path/prompt/command/session inside the section", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcpruns-05-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-mcpruns-05-rd-"));
  try {
    makeGitRepo(dir);
    await seedRun(runDir, "run_safe", dir, "running", "coder_low");
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "lead_preflight", arguments: { recentRuns: { limit: 10 } } });
      const parsed = JSON.parse(res.content[0].text);
      assert.ok(parsed.recentRuns, "section present");
      // 决定 0129：workspace.workspaceRoot 是批 119 起的既有事实（Lead 给出并
      // 经证明的 Git 根，刻意在面）；安全边界断言收窄到 recentRuns 节内部。
      const json = JSON.stringify(parsed.recentRuns);
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
      // 决定 0129：runs_list 已删；recentRuns 乘载体的 lead_preflight 保持只读注解。
      const t = tools.tools.find((t) => t.name === "lead_preflight");
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
    const { listRuns } = await import("../../src/application/runList.js");
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
    const { listRuns } = await import("../../src/application/runList.js");
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
  const src = readFileSync(join(join(fileURLToPath(new URL(".", import.meta.url))), "../..", "src", "application", "runWorkspaceOwnership.js"), "utf8");
  assert.ok(!src.includes('from "../commands/'), "no commands/");
  assert.ok(!src.includes('from "../mcp/'), "no mcp/");
  assert.ok(!src.includes("@modelcontextprotocol/sdk"), "no SDK");
  assert.ok(!src.includes('from "zod"'), "no zod");
});

test("ARCH-02: runList does not import commands/mcp/SDK/zod/daemon", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(join(fileURLToPath(new URL(".", import.meta.url))), "../..", "src", "application", "runList.js"), "utf8");
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
    const { listRuns } = await import("../../src/application/runList.js");
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
    const { listRuns } = await import("../../src/application/runList.js");
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
    const { listRuns } = await import("../../src/application/runList.js");
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
    const { listRuns } = await import("../../src/application/runList.js");
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
    const { listRuns } = await import("../../src/application/runList.js");
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
    const { listRuns } = await import("../../src/application/runList.js");
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
    const { listRuns } = await import("../../src/application/runList.js");
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
    const { listRuns } = await import("../../src/application/runList.js");
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
    const { DEFAULT_OWNER_LIVENESS_THRESHOLD_MS } = await import("../../src/application/ownerLiveness.js");
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
    const { listRuns } = await import("../../src/application/runList.js");
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

// ── M12-15: real in-memory MCP run-listing schema + behavior（0129：经 recentRuns）──

test("M12-15-MCP-01: recentRuns output declares activityStatus/activityBasis enums + unresolvedCount (SSOT)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1215-mcp01-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const { tools } = await client.listTools();
      // 决定 0129：runs_list 已删——闭集枚举随 recentRuns 节进 lead_preflight schema。
      const t = tools.find((x) => x.name === "lead_preflight");
      const recent = t.outputSchema.properties.recentRuns.anyOf?.[0] ?? t.outputSchema.properties.recentRuns;
      const runItem = recent.properties.runs.items;
      // The per-run closed-set enums are present...
      assert.deepEqual([...runItem.properties.activityStatus.enum].sort(),
        ["active", "terminal", "unknown", "unresolved"].sort());
      assert.deepEqual([...runItem.properties.activityBasis.enum].sort(),
        ["fresh_owner_heartbeat", "no_fresh_owner_heartbeat", "terminal_state", "unknown_state"].sort());
      // ...and unresolvedCount is a section field.
      assert.ok(recent.properties.unresolvedCount, "recentRuns section declares unresolvedCount");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M12-15-MCP-02: recentRuns maps activityStatus/activityBasis + unresolvedCount through the handler", async () => {
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
      // 决定 0129：runs_list 已删——同一投影经 lead_preflight recentRuns 上 wire。
      const res = await client.callTool({ name: "lead_preflight", arguments: { recentRuns: { limit: 10 } } });
      const section = JSON.parse(res.content[0].text).recentRuns;
      assert.equal(section.runs.length, 1);
      assert.equal(section.runs[0].activityStatus, "active");
      assert.equal(section.runs[0].activityBasis, "fresh_owner_heartbeat");
      assert.equal(section.unresolvedCount, 2);
      assert.equal(section.truncated, false);
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── TD-256 验收（opus V2-1/sol#1）：active 门 null 陷阱合同钉 ──
// authorizedWorkspaceRoot: null 会走 createRunWorkspaceVerifier(null) 抛错 →
// fail-closed 返回 {runs:[]}——曾经让 migrate-projects --apply 与 serve recycle
// 的 active 门恒空（门是死的）。两钉：行为钉（null=空集、省略=真实列表）+
// 扫源钉（src/ 不得再出现该调用形状）。
test("TD-256: authorizedWorkspaceRoot null=空集（fail-closed）而省略=真实列表——门调用必须省略该键", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td256-rl-"));
  try {
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "run.started", runId: "run_x1", agentId: "t", cwd: dir, ts: new Date().toISOString(), seq: 0 }),
      JSON.stringify({ type: "run.state_change", runId: "run_x1", to: "completed", ts: new Date().toISOString(), seq: 1 }),
    ];
    writeFileSync(join(dir, "run_x1.jsonl"), lines.join("\n") + "\n", "utf8");
    const withNull = await listRuns({ runDir: dir, activeOnly: true, authorizedWorkspaceRoot: null });
    assert.deepEqual(withNull.runs ?? withNull.items ?? [], [], "null → fail-closed 空集（陷阱形状）");
    const omitted = await listRuns({ runDir: dir, activeOnly: true });
    void omitted;
    // activeOnly 下 completed run 不在列（无心跳）——但关键是不再恒空路径：
    // 列表服务按真实状态机工作。用非 activeOnly 对照证明省略键时列表真实。
    const all = await listRuns({ runDir: dir });
    assert.equal((all.runs ?? all.items ?? []).length, 1, "省略键=真实列表（1 条在册）");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 决定 0129（第 134 批会审修）：非 null 的工作区权威若复证失败，绝不能伪装成
// "没有可见运行"；listRuns 如实给失败标记（preflight 据此给 null）。TD-256 的
// null 死形状保持原意：刻意的空集，不带失败标记。
test("0129: an unprovable non-null workspace authority is surfaced as a failure marker (null stays the dead-shape empty set)", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-0129-rl-marker-"));
  const nonGit = mkdtempSync(join(tmpdir(), "wao-0129-rl-nongit-"));
  try {
    const { listRuns } = await import("../../src/application/runList.js");
    const failed = await listRuns({ runDir, authorizedWorkspaceRoot: nonGit });
    assert.deepEqual(failed.runs, [], "no fabricated runs");
    assert.equal(failed.workspaceAuthorizationUnavailable, true,
      "unprovable authority is surfaced, not silently read as zero runs");
    const dead = await listRuns({ runDir, authorizedWorkspaceRoot: null });
    assert.deepEqual(dead.runs, [], "null dead shape keeps its fail-closed empty set");
    assert.equal(dead.workspaceAuthorizationUnavailable, undefined,
      "null is intentional gate-disabled, not a read failure");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(nonGit, { recursive: true, force: true });
  }
});

test("TD-256: 扫源钉——src/ 零处 authorizedWorkspaceRoot: null（active 门禁用死形状）", () => {
  const offenders = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const pp = join(d, name);
      if (statSync(pp).isDirectory()) walk(pp);
      else if (name.endsWith(".js")) {
        if (readFileSync(pp, "utf8").includes("authorizedWorkspaceRoot: null")) offenders.push(pp);
      }
    }
  };
  walk(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src"));
  assert.deepEqual(offenders, [], `active 门死形状再现：${offenders.join(", ")}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// TD-341（第 89 批 C2）：unresolved 候选的有界保留——同一次扫描收集，按
// updatedAt 新到旧、上限截断；不设置选项时返回形状逐字节不变。
// ═══════════════════════════════════════════════════════════════════════════

test("TD-341-C2: unresolvedCandidatesCap → 有界候选（新到旧、上限截断）；缺省不携带", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-td341c2-list-"));
  // 续修 7：`\T`/`\R` 在字符串里会被吃掉（实际值成了 C:TargetRepo）——转义。
  const ROOT = "C:\\Target\\Repo";
  try {
    // 7 个非终态运行（全部无新鲜心跳 → unresolved），updatedAt 各不相同；
    // m1215Events 的 ts 固定，这里在 reader 层逐 run 变 ts 以拉开 updatedAt。
    const stamps = {
      run_td341_l1: "2026-07-01T01:00:00Z",
      run_td341_l2: "2026-07-01T06:00:00Z",
      run_td341_l3: "2026-07-01T03:00:00Z",
      run_td341_l4: "2026-07-01T07:00:00Z",
      run_td341_l5: "2026-07-01T02:00:00Z",
      run_td341_l6: "2026-07-01T05:00:00Z",
      run_td341_l7: "2026-07-01T04:00:00Z",
    };
    for (const runId of Object.keys(stamps)) m1215EmptyRunFile(runDir, runId);
    const eventsByFile = new Map(Object.entries(stamps).map(([runId, ts]) => {
      const events = m1215Events(runId, ROOT, "running").map((e) => ({ ...e, ts }));
      return [`${runId}.jsonl`, events];
    }));
    const liveness = m1215LivenessSpy(Object.fromEntries(
      Object.keys(stamps).map((runId) => [runId, { fresh: false, heartbeatAt: 1 }]),
    ));
    const base = {
      runDir, nowMs: M12_15_NOW, checkLivenessFn: liveness.fn,
      readTranscriptFn: m1215Reader(eventsByFile),
      createWorkspaceVerifierFn: () => m1215Verifier(ROOT),
      knownAgentIds: ["coder_low"],
    };
    // 缺省：返回不带 unresolvedCandidates（runs list 的 CLI/MCP 输出形状不变）。
    const plain = await listRuns(base);
    assert.equal(plain.unresolvedCount, 7);
    assert.equal("unresolvedCandidates" in plain, false, "缺省不携带候选字段");
    // 上限 5：新到旧的前 5 个（l4 06:00、l2 06:00? 按 ts 降序：l4 07>l2 06>l7 04? 重算：
    // ts 降序 = l4(07) l2(06) l6(05) l7(04) l3(03) l5(02) l1(01) → 前 5 = l4 l2 l6 l7 l3。
    const capped = await listRuns({ ...base, unresolvedCandidatesCap: 5 });
    assert.equal(capped.unresolvedCount, 7, "计数仍是全量（在截断之前）");
    assert.deepEqual(
      capped.unresolvedCandidates.map((c) => c.runId),
      ["run_td341_l4", "run_td341_l2", "run_td341_l6", "run_td341_l7", "run_td341_l3"],
      "按 updatedAt 新到旧取前 5；超出上限的照旧只计入 unresolvedCount",
    );
    for (const c of capped.unresolvedCandidates) {
      assert.deepEqual(Object.keys(c).sort(), ["runId", "updatedAt"], "候选只有 {runId, updatedAt}");
    }
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});
