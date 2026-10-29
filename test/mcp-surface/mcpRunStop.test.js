// test/mcpRunStop.test.js
//
// M10 P0-2B: MCP run_stop tool tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stopProof } from "../fixtures/stopProof.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { JsonlTranscript, readTranscript } from "../../src/transcript.js";
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

async function buildClient(server) {
  const [c1, s1] = InMemoryTransport.createLinkedPair();
  await server.connect(s1);
  const client = new Client({ name: "test", version: "0" }, { version: "0" });
  await client.connect(c1);
  return client;
}

async function seedRun(runDir, runId, workspaceCwd, pid = 99999) {
  const tp = join(runDir, `${runId}.jsonl`);
  const t = new JsonlTranscript(tp, { runId, agentId: "a" });
  await t.append("run.started", { backend: "claude-code" });
  await t.append("run.background_submitted", { background: true, cwd: workspaceCwd });
  await t.append("session.created", { backend: "process", backendSessionId: `proc_${pid}` });
  await t.transitionState(null, "pending", "created");
  await t.transitionState("pending", "submitted", "spawned");
  await t.transitionState("submitted", "running", "first_event");
  return tp;
}

/**
 * Create a server with a fake stopRun that tracks kill calls.
 */
function createServerWithFakeStop({ runDir, workspaceRoot, initialAlive = true }) {
  let killCalls = 0;
  let alive = initialAlive;
  const server = createWaoMcpServer({
    registryPath: "/r.json",
    runDir,
    workspaceRoot,
    stopRunFn: async (input) => {
      const { stopRun } = await import("../../src/application/runStop.js");
      return stopRun({
        ...input,
        deps: {
          kill: () => { killCalls++; alive = false; return { called: true, exitCode: 0 }; },
          isAlive: () => alive,
          identify: async () => ({ verdict: "same", basis: "identity_confirmed" }),
          alert: async () => {},
        },
      });
    },
  });
  return { server, getKillCalls: () => killCalls };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("MCP-01: tool list includes run_stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcp-01-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      assert.ok(names.includes("run_stop"), "run_stop must be in tool list");
    } finally {
      await client.close();
      await server.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP-02: extra args rejected, service not called", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcp-02-"));
  try {
    makeGitRepo(dir);
    await seedRun(dir, "run_mcp02", dir);
    let serviceCalls = 0;
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      stopRunFn: async (input) => { serviceCalls++; throw new Error("should not be called"); },
    });
    const client = await buildClient(server);
    try {
      // Extra arg should be rejected by strict schema BEFORE service call
      await client.callTool({ name: "run_stop", arguments: { runId: "run_mcp02", force: true, ...stopProof(dir, "run_mcp02") } });
      assert.equal(serviceCalls, 0, "service must not be called for extra args");
    } catch {
      // SDK may throw on validation — that's OK, service was not called
    } finally {
      await client.close();
      await server.close();
    }
    assert.equal(serviceCalls, 0, "service must not be called for extra args");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP-03: safe output — no PID/path/session/command/stderr", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcp-03-"));
  try {
    makeGitRepo(dir);
    await seedRun(dir, "run_mcp03", dir, 55555);
    const { server } = createServerWithFakeStop({ runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_stop", arguments: { runId: "run_mcp03", expectedWorkspaceRoot: dir, ...stopProof(dir, "run_mcp03") } });
      const textBlock = res.content.find((b) => b.type === "text");
      const parsed = JSON.parse(textBlock.text);
      // Must contain only safe fields
      assert.ok(parsed.runId);
      assert.equal(typeof parsed.terminalAccepted, "boolean");
      assert.ok(["aborted","completed","failed","timed_out","pending","submitted","running"].includes(parsed.terminalState));
      assert.equal(typeof parsed.sideEffectAttempted, "boolean");
      // Must NOT contain unsafe fields
      const json = JSON.stringify(parsed);
      assert.ok(!json.includes("55555"), "no PID");
      assert.ok(!json.includes(dir), "no absolute path");
      assert.ok(!json.includes("session"), "no session id");
      assert.ok(!json.includes("taskkill"), "no taskkill details");
      assert.ok(!json.includes("stderr"), "no stderr");
    } finally {
      await client.close();
      await server.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP-04: other workspace → run_stop failed, zero side effect", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "wao-mcp-04a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wao-mcp-04b-"));
  try {
    makeGitRepo(dirA);
    makeGitRepo(dirB);
    await seedRun(dirA, "run_mcp04", dirA, 44444);
    const { server, getKillCalls } = createServerWithFakeStop({ runDir: dirA, workspaceRoot: dirB });
    const client = await buildClient(server);
    try {
      // the caller names dirB as the target; the run belongs to dirA —
      // the ownership gate rejects with zero side effect.
      const res = await client.callTool({ name: "run_stop", arguments: { runId: "run_mcp04", expectedWorkspaceRoot: dirB, ...stopProof(dirA, "run_mcp04") } });
      assert.ok(res.isError, "must be error");
      const text = res.content[0].text;
      assert.equal(text, "run_stop failed");
      assert.equal(getKillCalls(), 0, "zero kills for other workspace");
    } finally {
      await client.close();
      await server.close();
    }
  } finally { rmSync(dirA, { recursive: true, force: true }); rmSync(dirB, { recursive: true, force: true }); }
});

test("MCP-05: workspace not bound → fixed safe error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcp-05-"));
  try {
    makeGitRepo(dir);
    // No workspaceRoot → not bound
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir });
    const client = await buildClient(server);
    try {
      // no expectedWorkspaceRoot → fixed target-required refusal.
      const res = await client.callTool({ name: "run_stop", arguments: { runId: "run_mcp05", ...stopProof(dir, "run_mcp05") } });
      assert.ok(res.isError, "must be error when workspace not bound");
    } finally {
      await client.close();
      await server.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP-07: run_stop 把启动配置的 registryPath 传给 stop 服务；kimi-web 停止目标解析不出 → 非错误 payload，terminalAccepted/sideEffectAttempted 均 false、终态为原状态", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcp-07-"));
  try {
    makeGitRepo(dir);
    const tp = join(dir, "run_mcp07.jsonl");
    const t = new JsonlTranscript(tp, { runId: "run_mcp07", agentId: "coder_kw" });
    await t.append("run.started", { backend: "kimi-web" });
    await t.append("run.background_submitted", { background: true, cwd: dir });
    await t.append("session.created", { backend: "kimi-web", backendSessionId: "session_kw", serveUrl: "http://127.0.0.1:4310" });
    await t.transitionState(null, "pending", "created");
    await t.transitionState("pending", "submitted", "spawned");
    await t.transitionState("submitted", "running", "first_event");

    const registryPath = join(dir, "absent-agents.json");
    const seen = [];
    const readers = [];
    const userEnvReader = async () => undefined;
    let fetches = 0;
    const server = createWaoMcpServer({
      registryPath, runDir: dir, workspaceRoot: dir, userEnvReader,
      stopRunFn: async (input) => {
        seen.push(input.registryPath);
        readers.push(input.deps?.userEnvReader);
        const { stopRun } = await import("../../src/application/runStop.js");
        return stopRun({
          ...input,
          deps: { fetchImpl: async () => { fetches += 1; throw new Error("no request expected"); }, alert: async () => {} },
        });
      },
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_stop", arguments: { runId: "run_mcp07", expectedWorkspaceRoot: dir, ...stopProof(dir, "run_mcp07") } });
      assert.deepEqual(seen, [registryPath], "registryPath 原样传到 stop 服务");
      assert.deepEqual(readers, [userEnvReader], "派发同一个 user-env 读取器传到 stop 服务");
      assert.ok(!res.isError);
      assert.deepEqual(res.structuredContent, {
        runId: "run_mcp07",
        terminalAccepted: false,
        terminalState: "running",
        sideEffectAttempted: false,
        stopVerified: false,
      });
      assert.equal(fetches, 0, "停止没有发出");
      const events = await readTranscript(tp);
      assert.equal(events.find((e) => e.type === "run.stop_unverified").outcome, "stop_route_unavailable");
    } finally {
      await client.close();
      await server.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP-06: annotations — destructiveHint true, idempotentHint false", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcp-06-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      const stop = tools.tools.find((t) => t.name === "run_stop");
      assert.ok(stop, "run_stop found");
      assert.equal(stop.annotations.destructiveHint, true);
      assert.equal(stop.annotations.idempotentHint, false);
      assert.equal(stop.annotations.readOnlyHint, false);
      assert.equal(stop.annotations.openWorldHint, false);
    } finally {
      await client.close();
      await server.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
