// test/mcpRunStatus.test.js
//
// M9-3B: MCP run_status tool — TDD tests.
//
// Proves that an MCP host can query the point-in-time status of a run via
// run_status, which calls the M9-3A getRunStatus() service and returns ONLY a
// safe machine subset (no raw event payloads, commands, paths, messages, errors).
// Covers: tool list, schema/annotations, exactly-once service call, server-owned
// runDir, safe output shape, strict input rejection, error redaction, terminal
// states, read-only no-side-effects, real stdio dispatch->status->failed flow.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

import { createWaoMcpServer } from "../src/mcp/server.js";

// ===== Helpers =====

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SHIM = join(REPO_ROOT, "scripts", "wao-node.cjs");
const STDIO_ENTRY = join(REPO_ROOT, "src", "mcp", "stdio.js");

function makeRegistry(dir, agents) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return registryPath;
}

function makeSummary(runDir, workers) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({ workers }), "utf8");
  return runDir;
}

function writeTranscript(dir, runId, lines) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.jsonl`), lines, "utf8");
}

function ev(obj) {
  return JSON.stringify(obj) + "\n";
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function makeGitRepo(dir) {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@test.com', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name Test', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8');
  execSync('git add README.md', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m init', { cwd: dir, stdio: 'pipe' });
}

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-test-client", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// A fixture run.event that contains sensitive content the MCP output must NOT leak.
function sensitiveFixture(runId) {
  return [
    ev({ type: "run.state_change", to: "pending", reason: "background_spawned", ts: "2026-07-14T00:00:00.000Z", runId, agentId: "w", seq: 1 }),
    ev({ type: "run.state_change", to: "running", reason: "started", ts: "2026-07-14T00:00:01.000Z", runId, agentId: "w", seq: 2 }),
    ev({ type: "run.event", kind: "command", command: "rm -rf /secret/path", ts: "2026-07-14T00:00:02.000Z", runId, agentId: "w", seq: 3 }),
    ev({ type: "run.event", kind: "tool_use", tool: "Bash", input: { command: "AKIA-SECRET-TOKEN-m93b" }, ts: "2026-07-14T00:00:03.000Z", runId, agentId: "w", seq: 4 }),
    ev({ type: "run.event", kind: "file_written", path: "C:\\Users\\leak\\secret.txt", ts: "2026-07-14T00:00:04.000Z", runId, agentId: "w", seq: 5 }),
  ].join("");
}

// ===== Tests =====

// ---------------------------------------------------------------------
// M9-3B-01: tools/list has registry_list + run_dispatch + run_status.
// ---------------------------------------------------------------------

test("M9-3B-01: tools/list has registry_list + run_dispatch + run_status with correct schema", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m93b-01-"));
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const server = createWaoMcpServer({ registryPath, runDir: dir });
    const client = await buildInMemoryClient(server);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      assert.ok(names.includes("run_status"), "run_status present");

      const rs = tools.tools.find((t) => t.name === "run_status");
      assert.ok(rs, "run_status present");
      assert.deepEqual(Object.keys(rs.inputSchema.properties ?? {}), ["runId"], "input has only runId");
      assert.equal(rs.inputSchema.additionalProperties, false, "input is strict");
      // Read-only annotations.
      assert.equal(rs.annotations.readOnlyHint, true, "readOnlyHint:true");
      assert.equal(rs.annotations.destructiveHint, false, "destructiveHint:false");
      assert.equal(rs.annotations.idempotentHint, true, "idempotentHint:true");
      assert.equal(rs.annotations.openWorldHint, false, "openWorldHint:false");
      assert.ok(rs.outputSchema, "output schema declared");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-3B-02: injected service called once, receives server-owned runDir.
// ---------------------------------------------------------------------

test("M9-3B-02: run_status calls service once with server-owned runDir", async () => {
  let callCount = 0;
  let captured = null;
  const fakeStatus = async (input) => {
    callCount += 1;
    captured = input;
    return {
      runId: input.runId, state: "running", terminal: false,
      last: null, lastActivityTs: null, secondsSinceActivity: null,
      lastActivityKind: null, lastActivitySummary: null,
      lastEventType: null, lastEventTs: null, lastActivityEventKind: null,
    };
  };

  const server = createWaoMcpServer({
    registryPath: "/server/r.json",
    runDir: "/server/runs",
    getRunStatusFn: fakeStatus,
  });
  const client = await buildInMemoryClient(server);
  try {
    await client.callTool({ name: "run_status", arguments: { runId: "run_abc" } });
    assert.equal(callCount, 1, "service called exactly once");
    assert.equal(captured.runDir, "/server/runs", "server-owned runDir");
    assert.equal(captured.runId, "run_abc");
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// M9-3B-03: output has only safe fields — no secret/path/command/message leak.
// ---------------------------------------------------------------------

test("M9-3B-03: run_status output is safe subset, no raw payload leak", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m93b-03-"));
  try {
    const runId = "run_sensitive_m93b";
    const runDir = join(dir, "runs");
    writeTranscript(runDir, runId, sensitiveFixture(runId));

    const server = createWaoMcpServer({ registryPath: makeRegistry(dir, { w: { backend: "claude-code", cwd: dir } }), runDir });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_status", arguments: { runId } });
      const textBlock = res.content.find((b) => b.type === "text");
      const parsed = JSON.parse(textBlock.text);

      // Only these top-level keys (M11-8B added agentId).
      assert.deepEqual(Object.keys(parsed).sort(), ["agentId", "lastActivity", "lastEvent", "runId", "state", "terminal"],
        "only runId/agentId/state/terminal/lastEvent/lastActivity");
      // M11-8B: the durable agentId from the envelope, not worker text.
      assert.equal(parsed.agentId, "w", "agentId is the durable envelope id");

      // lastEvent has only type + ts.
      assert.deepEqual(Object.keys(parsed.lastEvent).sort(), ["ts", "type"], "lastEvent has only type+ts");

      // lastActivity has only kind + ts + secondsSince.
      assert.deepEqual(Object.keys(parsed.lastActivity).sort(), ["kind", "secondsSince", "ts"], "lastActivity has only kind/ts/secondsSince");

      // No leaks of sensitive content.
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes("rm -rf"), "no command leak");
      assert.ok(!dumped.includes("AKIA-SECRET"), "no token leak");
      assert.ok(!dumped.includes("C:\\\\Users"), "no absolute path leak");
      assert.ok(!dumped.includes("/secret/path"), "no path leak");
      assert.ok(!dumped.includes("lastActivitySummary"), "no lastActivitySummary field");
      assert.ok(!dumped.includes("input"), "no tool input leak");

      // structuredContent mirrors content.
      if (res.structuredContent) {
        assert.deepEqual(res.structuredContent, parsed, "structuredContent matches");
      }
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-3B-04: extra/control-plane args rejected, service count 0.
// ---------------------------------------------------------------------

test("M9-3B-04: control-plane args rejected, service not called", async () => {
  let callCount = 0;
  const fakeStatus = async () => { callCount += 1; return { runId: "x", state: "running", terminal: false }; };

  const server = createWaoMcpServer({
    registryPath: "/server/r.json",
    runDir: "/server/runs",
    getRunStatusFn: fakeStatus,
  });
  const client = await buildInMemoryClient(server);
  try {
    const badArgsList = [
      { runId: "run_x", runDir: "/attacker/runs" },
      { runId: "run_x", path: "/evil" },
      { runId: "run_x", follow: true },
      { runId: "run_x", limit: 100 },
      { runId: "run_x", evil: true },
      { runId: "run_x", registry: "/evil.json" },
    ];
    for (const bad of badArgsList) {
      let rejected = false;
      let result = null;
      try {
        result = await client.callTool({ name: "run_status", arguments: bad });
      } catch {
        rejected = true;
      }
      if (!rejected) {
        assert.equal(result.isError, true, `control-plane arg ${JSON.stringify(Object.keys(bad))} must be rejected`);
        rejected = true;
      }
      assert.ok(rejected, `every control-plane arg rejected: ${JSON.stringify(Object.keys(bad))}`);
    }
    assert.equal(callCount, 0, "service never called for control-plane args");
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// M9-3B-05: service throw with secret/path → fixed "run_status failed".
// ---------------------------------------------------------------------

test("M9-3B-05: service error returns fixed safe text, no leak", async () => {
  const SECRET = "test-secret-status-m93b05";
  const ABS = "C:\\Users\\leak\\status.jsonl";
  const fakeStatus = async () => { throw new Error(`status crashed at ${ABS} key=${SECRET}`); };

  const server = createWaoMcpServer({
    registryPath: "/server/r.json",
    runDir: "/server/runs",
    getRunStatusFn: fakeStatus,
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_status", arguments: { runId: "run_x" } });
    assert.equal(res.isError, true, "error flagged");
    const dumped = JSON.stringify(res);
    assert.ok(!dumped.includes(SECRET), "no secret leak");
    assert.ok(!dumped.includes(ABS), "no path leak");
    const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
    assert.ok(/run_status failed/.test(text), "fixed safe text");
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// M9-3B-05b: malformed service result (lastEventTs=null with lastEventType
//            present) must return fixed "run_status failed", NOT leak the SDK's
//            detailed Output validation error. The payload construction +
//            output-schema validation must be inside the same try/catch as the
//            service call.
// ---------------------------------------------------------------------

test("M9-3B-05b: malformed lastEvent (type present, ts null) returns fixed error, no SDK validation leak", async () => {
  // Service returns a result where lastEventType exists but lastEventTs is null.
  // The raw payload would build {type:"run.event", ts:null}, which violates the
  // output schema (ts must be string). The handler must normalize this to null
  // OR return the fixed error — never let the SDK emit a validation error.
  const malformedNoTs = async () => ({
    runId: "run_x", state: "running", terminal: false,
    last: { type: "run.event", ts: null },
    lastActivityTs: null, secondsSinceActivity: null,
    lastActivityKind: null, lastActivitySummary: null,
    lastEventType: "run.event", lastEventTs: null,
    lastActivityEventKind: null,
  });

  const server = createWaoMcpServer({
    registryPath: "/server/r.json", runDir: "/server/runs",
    getRunStatusFn: malformedNoTs,
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_status", arguments: { runId: "run_x" } });
    const dumped = JSON.stringify(res);
    // Must NOT contain SDK validation error detail.
    assert.ok(!/output validation error/i.test(dumped), "no SDK output-validation error leaked");
    assert.ok(!dumped.includes("expected string"), "no zod 'expected string' detail leaked");
    assert.ok(!dumped.includes("invalid_type"), "no zod invalid_type code leaked");

    if (res.isError) {
      // Fixed-error path: text must be the constant.
      const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
      assert.ok(/run_status failed/.test(text), "fixed safe text on malformed result");
    } else {
      // Normalized path: lastEvent must be null (not {type, ts:null}).
      assert.equal(res.structuredContent.lastEvent, null, "malformed lastEvent normalized to null");
    }
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// M9-3B-05c: malformed activity timestamp (NaN) must not leak a validation error.
// ---------------------------------------------------------------------

test("M9-3B-05c: malformed activity ts (NaN) returns safe result or fixed error", async () => {
  const malformedNaN = async () => ({
    runId: "run_x", state: "running", terminal: false,
    last: { type: "run.event", ts: "2026-07-14T00:00:00.000Z" },
    lastActivityTs: NaN, secondsSinceActivity: NaN,
    lastActivityKind: null, lastActivitySummary: null,
    lastEventType: "run.event", lastEventTs: "2026-07-14T00:00:00.000Z",
    lastActivityEventKind: "command",
  });

  const server = createWaoMcpServer({
    registryPath: "/server/r.json", runDir: "/server/runs",
    getRunStatusFn: malformedNaN,
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_status", arguments: { runId: "run_x" } });
    const dumped = JSON.stringify(res);
    assert.ok(!/output validation error/i.test(dumped), "no SDK validation error leaked");
    assert.ok(!dumped.includes("expected string"), "no zod detail leaked");
    if (res.isError) {
      const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
      assert.ok(/run_status failed/.test(text), "fixed safe text");
    } else {
      // Normalized: lastActivity must be null when ts is not a valid string.
      assert.ok(res.structuredContent.lastActivity === null ||
        typeof res.structuredContent.lastActivity?.ts === "string",
        "malformed activity normalized");
    }
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// M9-3B-06: repeated status calls don't modify transcript.
// ---------------------------------------------------------------------

test("M9-3B-06: repeated status calls leave transcript unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m93b-06-"));
  try {
    const runId = "run_repeat_m93b";
    const runDir = join(dir, "runs");
    writeTranscript(runDir, runId,
      ev({ type: "run.state_change", to: "pending", reason: "init", ts: "2026-07-14T00:00:00.000Z", runId, agentId: "w", seq: 1 }) +
      ev({ type: "run.event", kind: "command", command: "echo hi", ts: "2026-07-14T00:00:01.000Z", runId, agentId: "w", seq: 2 }),
    );
    const transcriptPath = join(runDir, `${runId}.jsonl`);
    const before = readFileSync(transcriptPath, "utf8");

    const server = createWaoMcpServer({ registryPath: makeRegistry(dir, { w: { backend: "claude-code", cwd: dir } }), runDir });
    const client = await buildInMemoryClient(server);
    try {
      await client.callTool({ name: "run_status", arguments: { runId } });
      await client.callTool({ name: "run_status", arguments: { runId } });
      await client.callTool({ name: "run_status", arguments: { runId } });
    } finally {
      await client.close();
      await server.close();
    }

    const after = readFileSync(transcriptPath, "utf8");
    assert.equal(after, before, "transcript bytes unchanged after repeated status calls");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-3B-07: real stdio dispatch -> run_status poll -> failed terminal.
//           No model, no CLI. Proves the full MCP supervise loop.
// ---------------------------------------------------------------------

test("M9-3B-07: real stdio run_dispatch(pending) then run_status polls to failed terminal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m93b-07-"));
  let client;
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, {
      failing_worker: { backend: "claude-code", binary: "nonexistent-m93b-07", cwd: dir },
    });
    const runDir = makeSummary(dir, { failing_worker: { status: "certified" } });

    const { Client } = await import("@modelcontextprotocol/sdk/client");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    client = new Client({ name: "wao-m93b-07", version: "0.0.1" }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SHIM, STDIO_ENTRY, "--registry", registryPath, "--run-dir", runDir, "--workspace-root", dir],
      env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" },
    });
    await client.connect(transport);

    // 1. Dispatch returns pending (the supervised run is accepted, not yet terminal).
    const dispRes = await client.callTool({
      name: "run_dispatch",
      arguments: { agentId: "failing_worker", prompt: "bounded task" },
    });
    const dispPayload = JSON.parse(dispRes.content.find((b) => b.type === "text").text);
    const runId = dispPayload.runId;
    assert.ok(runId, "dispatch returned runId");
    assert.equal(dispPayload.state, "pending", "dispatch response state is pending");

    const transcriptPath = join(runDir, `${runId}.jsonl`);

    // 2. Poll via run_status ONLY until terminal.
    let lastStatus = null;
    for (let i = 0; i < 100; i += 1) {
      const res = await client.callTool({ name: "run_status", arguments: { runId } });
      lastStatus = JSON.parse(res.content.find((b) => b.type === "text").text);
      if (lastStatus.terminal) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(lastStatus.state, "failed", "reached failed terminal via run_status");
    assert.equal(lastStatus.terminal, true, "terminal flag true");

    // 3. Query again after terminal — still failed/terminal.
    const afterRes = await client.callTool({ name: "run_status", arguments: { runId } });
    const afterStatus = JSON.parse(afterRes.content.find((b) => b.type === "text").text);
    assert.equal(afterStatus.state, "failed", "still failed after terminal");
    assert.equal(afterStatus.terminal, true, "still terminal");

    // 4. Prove run_status is read-only: snapshot transcript bytes at terminal,
    //    call run_status once more, then assert exact byte equality (not just
    //    "has events"). This is the real zero-side-effect proof.
    const bytesBeforeStatus = readFileSync(transcriptPath, "utf8");
    await client.callTool({ name: "run_status", arguments: { runId } });
    const bytesAfterStatus = readFileSync(transcriptPath, "utf8");
    assert.equal(bytesAfterStatus, bytesBeforeStatus, "run_status added zero transcript bytes");

    await client.close();
    client = null;

    // 5. Owner heartbeat cleared after runner exit (no orphan process).
    const ownerFile = join(runDir, `.owner-${runId}`);
    for (let i = 0; i < 40; i += 1) {
      if (!existsSync(ownerFile)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(!existsSync(ownerFile), "ownership heartbeat cleared");
  } finally {
    if (client) await client.close();
    cleanupDir(dir);
  }
});
