// test/mcpRunDispatch.test.js
//
// M9-2B: MCP run_dispatch tool — TDD tests.
//
// Proves that an MCP host can dispatch a supervised background run via the
// run_dispatch tool, which calls the M9-2A dispatchRun() application service.
// Covers: tool list shape, exactly-once service invocation, server-owned paths,
// fixed requireCertified:true, safe output (no paths/PID/prompt/argv), strict
// input rejection, error redaction, real stdio no-model integration, detached
// runner terminal state after MCP host closes, and CLI/MCP parity.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

import { createWaoMcpServer } from "../src/mcp/server.js";
import { dispatchRun as realDispatchRun } from "../src/application/runDispatch.js";
import { readTranscript, findState, findLatest } from "../src/transcript.js";

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

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-test-client", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function buildStdioSubprocessTransport({ registryPath, runDir, env = {} }) {
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const childEnv = { ...process.env, WAO_SKIP_VERSION_GUARD: "1", ...env };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SHIM, STDIO_ENTRY, "--registry", registryPath, "--run-dir", runDir],
    env: childEnv,
  });
  return transport;
}

// ===== Tests =====

// ---------------------------------------------------------------------
// M9-2B-01: tools/list contains exactly registry_list + run_dispatch with correct
//           schemas and annotations.
// ---------------------------------------------------------------------

test("M9-2B-01: tools/list has registry_list + run_dispatch with strict schema and annotations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92b-01-"));
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const server = createWaoMcpServer({ registryPath, runDir: dir });
    const client = await buildInMemoryClient(server);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      assert.ok(names.includes("run_dispatch"), "run_dispatch present");
      assert.ok(names.includes("registry_list"), "registry_list present");

      const rd = tools.tools.find((t) => t.name === "run_dispatch");
      assert.ok(rd, "run_dispatch present");
      // Strict input: agentId + prompt required, delivery optional.
      const inputKeys = Object.keys(rd.inputSchema.properties ?? {}).sort();
      assert.deepEqual(inputKeys, ["agentId", "delivery", "prompt"],
        "input schema has agentId + prompt + optional delivery",
      );
      assert.equal(rd.inputSchema.additionalProperties, false, "input is strict");
      // Annotations: not read-only, destructive (worker may modify files/run commands),
      // not idempotent, open-world (dispatches real work).
      assert.equal(rd.annotations.readOnlyHint, false, "readOnlyHint:false");
      assert.equal(rd.annotations.destructiveHint, true, "destructiveHint:true (worker can mutate files/execute commands)");
      assert.equal(rd.annotations.idempotentHint, false, "idempotentHint:false");
      assert.equal(rd.annotations.openWorldHint, true, "openWorldHint:true");
      // Output schema declared.
      assert.ok(rd.outputSchema, "output schema declared");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-2B-02: injected dispatcher called exactly once, receives server-owned paths
//           and requireCertified:true; model cannot override paths.
// ---------------------------------------------------------------------

test("M9-2B-02: run_dispatch calls dispatcher once with server paths and requireCertified:true", async () => {
  let callCount = 0;
  let captured = null;
  const fakeDispatch = async (input) => {
    callCount += 1;
    captured = input;
    return { accepted: true, runId: "run_fake_m92b02", state: "pending", transcriptPath: "/x.jsonl" };
  };

  const server = createWaoMcpServer({
    registryPath: "/server/registry.json",
    runDir: "/server/runs",
    dispatchRunFn: fakeDispatch,
  });
  const client = await buildInMemoryClient(server);
  try {
    await client.callTool({ name: "run_dispatch", arguments: { agentId: "coder_low", prompt: "do it" } });
    assert.equal(callCount, 1, "dispatcher called exactly once");
    assert.equal(captured.registryPath, "/server/registry.json", "server-owned registryPath");
    assert.equal(captured.runDir, "/server/runs", "server-owned runDir");
    assert.equal(captured.requireCertified, true, "requireCertified fixed true");
    assert.equal(captured.agentId, "coder_low");
    assert.equal(captured.prompt, "do it");
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// M9-2B-03: success output contains only runId/accepted/state — no paths/PID/prompt/argv.
// ---------------------------------------------------------------------

test("M9-2B-03: run_dispatch success output has only runId/accepted/state, no leaks", async () => {
  const fakeDispatch = async () => ({
    accepted: true,
    runId: "run_ok_m92b03",
    state: "pending",
    transcriptPath: "/secret/runs/run_ok_m92b03.jsonl",
  });

  const server = createWaoMcpServer({
    registryPath: "/server/registry.json",
    runDir: "/server/runs",
    dispatchRunFn: fakeDispatch,
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_dispatch", arguments: { agentId: "x", prompt: "secret-prompt-value" } });
    const textBlock = res.content.find((b) => b.type === "text");
    const parsed = JSON.parse(textBlock.text);

    // Only these three keys.
    assert.deepEqual(Object.keys(parsed).sort(), ["accepted", "runId", "state"], "only runId/accepted/state");
    assert.equal(parsed.accepted, true);
    assert.equal(parsed.runId, "run_ok_m92b03");
    assert.equal(parsed.state, "pending");

    // No leaks.
    const dumped = JSON.stringify(res);
    assert.ok(!dumped.includes("/secret/runs"), "no transcriptPath leak");
    assert.ok(!dumped.includes("secret-prompt-value"), "no prompt leak");
    assert.ok(!dumped.includes("argv"), "no argv leak");
    // structuredContent mirrors content.
    if (res.structuredContent) {
      assert.deepEqual(res.structuredContent, parsed, "structuredContent matches text JSON");
    }
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// M9-2B-04: extra/control-plane args rejected by strict schema; dispatcher count 0.
// ---------------------------------------------------------------------

test("M9-2B-04: control-plane args rejected, dispatcher not called", async () => {
  let callCount = 0;
  const fakeDispatch = async () => { callCount += 1; return { accepted: true, runId: "x", state: "pending" }; };

  const server = createWaoMcpServer({
    registryPath: "/server/registry.json",
    runDir: "/server/runs",
    dispatchRunFn: fakeDispatch,
  });
  const client = await buildInMemoryClient(server);
  try {
    const badArgsList = [
      { agentId: "x", prompt: "y", registryPath: "/attacker/r.json" },
      { agentId: "x", prompt: "y", runDir: "/attacker/runs" },
      { agentId: "x", prompt: "y", requireCertified: false },
      { agentId: "x", prompt: "y", runId: "run_evil" },
      { agentId: "x", prompt: "y", cwd: "/evil" },
      { agentId: "x", prompt: "y", evil: true },
    ];
    for (const bad of badArgsList) {
      let rejected = false;
      let result = null;
      try {
        result = await client.callTool({ name: "run_dispatch", arguments: bad });
      } catch {
        // A protocol-level rejection (throw) is a valid rejection.
        rejected = true;
      }
      if (!rejected) {
        // If it returned a result, it must be an explicit tool error — never success.
        assert.equal(result.isError, true,
          `control-plane arg ${JSON.stringify(Object.keys(bad))} must be rejected, got success`);
        rejected = true;
      }
      assert.ok(rejected, `every control-plane arg must be rejected: ${JSON.stringify(Object.keys(bad))}`);
    }
    assert.equal(callCount, 0, "dispatcher never called for any control-plane arg");
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// M9-2B-05: dispatcher throw with secret + absolute path → fixed "run_dispatch failed".
// ---------------------------------------------------------------------

test("M9-2B-05: dispatcher error returns fixed safe text, no secret/path leak", async () => {
  const SECRET = "test-secret-dispatch-leak-m92b05";
  const ABS_PATH = "C:\\Users\\leak\\runs\\secret.jsonl";
  const fakeDispatch = async () => {
    throw new Error(`dispatch crashed at ${ABS_PATH} key=${SECRET}`);
  };

  const server = createWaoMcpServer({
    registryPath: "/server/registry.json",
    runDir: "/server/runs",
    dispatchRunFn: fakeDispatch,
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_dispatch", arguments: { agentId: "x", prompt: "y" } });
    assert.equal(res.isError, true, "error flagged");
    const dumped = JSON.stringify(res);
    assert.ok(!dumped.includes(SECRET), "no secret leak");
    assert.ok(!dumped.includes(ABS_PATH), "no absolute path leak");
    assert.ok(!dumped.includes("C:\\\\Users"), "no path fragment leak");
    const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
    assert.ok(/run_dispatch failed/.test(text), "fixed safe text present");
    assert.ok(!/at .*\(.+:\d+:\d+\)/.test(text), "no stack frame");
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// M9-2B-06: real stdio no-model integration — temp registry, fresh summary,
//           nonexistent backend binary. Transcript reaches pending then failed.
// ---------------------------------------------------------------------

test("M9-2B-06: real stdio run_dispatch reaches pending, runner drives to failed terminal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92b-06-"));
  let client;
  try {
    const registryPath = makeRegistry(dir, {
      failing_worker: {
        backend: "claude-code",
        binary: "definitely-nonexistent-m92b-06",
        cwd: dir,
      },
    });
    const runDir = makeSummary(dir, { failing_worker: { status: "certified" } });

    const { Client } = await import("@modelcontextprotocol/sdk/client");
    client = new Client({ name: "wao-m92b-06", version: "0.0.1" }, { capabilities: {} });
    const transport = await buildStdioSubprocessTransport({ registryPath, runDir });
    await client.connect(transport);

    const res = await client.callTool({
      name: "run_dispatch",
      arguments: { agentId: "failing_worker", prompt: "bounded task" },
    });
    const textBlock = res.content.find((b) => b.type === "text");
    const parsed = JSON.parse(textBlock.text);
    assert.equal(parsed.accepted, true, "dispatch accepted");
    assert.equal(parsed.state, "pending", "initial state pending");
    const runId = parsed.runId;
    assert.ok(runId, "runId returned");

    // Transcript must already be readable and pending at return time.
    const transcriptPath = join(runDir, `${runId}.jsonl`);
    assert.ok(existsSync(transcriptPath), "transcript exists at MCP return");
    const earlyEvents = await readTranscript(transcriptPath);
    assert.equal(findState(earlyEvents), "pending", "transcript pending at return");

    // Close MCP host — detached runner must continue independently to failed terminal.
    await client.close();
    client = null;

    let events = earlyEvents;
    for (let i = 0; i < 80; i += 1) {
      events = await readTranscript(transcriptPath);
      if (["failed", "completed", "aborted", "timed_out"].includes(findState(events))) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(findState(events), "failed", "runner drove nonexistent binary to failed");

    // Ownership heartbeat file cleared after runner exit.
    const ownerFile = join(runDir, `.owner-${runId}`);
    for (let i = 0; i < 40; i += 1) {
      if (!existsSync(ownerFile)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(!existsSync(ownerFile), "ownership heartbeat cleared after runner exit");
  } finally {
    if (client) await client.close();
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-2B-07: CLI and MCP dispatch the same agent produce the same initial durable
//           facts (background_submitted + pending) and the same outcome type.
// ---------------------------------------------------------------------

test("M9-2B-07: CLI and MCP dispatch produce same initial durable facts and outcome", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92b-07-"));
  try {
    const registryPath = makeRegistry(dir, {
      parity_worker: {
        backend: "claude-code",
        binary: "nonexistent-parity-m92b-07",
        cwd: dir,
      },
    });
    const runDir = makeSummary(dir, { parity_worker: { status: "certified" } });

    // MCP dispatch via in-memory server + real dispatchRun.
    const mcpServer = createWaoMcpServer({ registryPath, runDir });
    const mcpClient = await buildInMemoryClient(mcpServer);
    let mcpRunId;
    try {
      const res = await mcpClient.callTool({
        name: "run_dispatch",
        arguments: { agentId: "parity_worker", prompt: "parity task" },
      });
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      mcpRunId = parsed.runId;
      await mcpClient.close();
    } finally {
      await mcpServer.close();
    }

    // CLI dispatch (subprocess) with the same registry/runDir.
    const cliRunDir = join(dir, "cli-runs");
    mkdirSync(cliRunDir, { recursive: true });
    // Re-create summary in cli runDir.
    writeFileSync(join(cliRunDir, "reliability-summary.json"), JSON.stringify({ workers: { parity_worker: { status: "certified" } } }), "utf8");
    const cliOut = execSync(
      `node src/cli.js run parity_worker --prompt "parity task" --background --registry ${registryPath} --run-dir ${cliRunDir} --format json`,
      { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" }, timeout: 10000 },
    );
    const cliParsed = JSON.parse(cliOut.slice(cliOut.indexOf("{"), cliOut.lastIndexOf("}") + 1));
    const cliRunId = cliParsed.runId;

    // Wait for both to reach terminal.
    async function waitForTerminal(rd, rid) {
      const tp = join(rd, `${rid}.jsonl`);
      let evs = [];
      for (let i = 0; i < 80; i += 1) {
        if (existsSync(tp)) {
          evs = await readTranscript(tp);
          if (["failed", "completed", "aborted", "timed_out"].includes(findState(evs))) break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      return evs;
    }
    const [mcpEvents, cliEvents] = await Promise.all([
      waitForTerminal(runDir, mcpRunId),
      waitForTerminal(cliRunDir, cliRunId),
    ]);

    // Same initial durable facts.
    assert.ok(findLatest(mcpEvents, "run.background_submitted"), "MCP wrote background_submitted");
    assert.ok(findLatest(cliEvents, "run.background_submitted"), "CLI wrote background_submitted");
    assert.ok(mcpEvents.some((e) => e.type === "run.state_change" && e.to === "pending"), "MCP pending");
    assert.ok(cliEvents.some((e) => e.type === "run.state_change" && e.to === "pending"), "CLI pending");
    // Same outcome type (both failed — nonexistent binary).
    assert.equal(findState(mcpEvents), "failed", "MCP failed terminal");
    assert.equal(findState(cliEvents), "failed", "CLI failed terminal");
  } finally {
    cleanupDir(dir);
  }
});

// ===== M9-7A: delivery-capable dispatch tests =====

test("M9-7A-04: MCP run_dispatch with delivery passes delivery to service", async () => {
  let callCount = 0;
  let captured = null;
  const fakeDispatch = async (input) => {
    callCount += 1;
    captured = input;
    return { accepted: true, runId: "run_delivery_m97a", state: "pending", transcriptPath: "/x.jsonl" };
  };
  const server = createWaoMcpServer({
    registryPath: "/server/r.json", runDir: "/server/runs",
    dispatchRunFn: fakeDispatch,
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({
      name: "run_dispatch",
      arguments: {
        agentId: "coder_low", prompt: "do it",
        delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"] },
      },
    });
    assert.equal(callCount, 1);
    assert.ok(captured.delivery, "service received delivery");
    assert.equal(captured.delivery.mode, "git_commit_v1");
    assert.equal(captured.requireCertified, true, "still forced certified");
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.deepEqual(Object.keys(parsed).sort(), ["accepted", "runId", "state"], "output unchanged");
  } finally {
    await client.close();
    await server.close();
  }
});

test("M9-7A-05: MCP delivery with both commands+reason rejected, service count 0", async () => {
  let callCount = 0;
  const fakeDispatch = async () => { callCount += 1; return { accepted: true, runId: "x", state: "pending" }; };
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs", dispatchRunFn: fakeDispatch,
  });
  const client = await buildInMemoryClient(server);
  try {
    let rejected = false;
    let result = null;
    try {
      result = await client.callTool({
        name: "run_dispatch",
        arguments: {
          agentId: "x", prompt: "y",
          delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"], verificationUnavailableReason: "no" },
        },
      });
    } catch { rejected = true; }
    if (!rejected) { assert.equal(result.isError, true, "both commands+reason rejected"); rejected = true; }
    assert.ok(rejected);
    assert.equal(callCount, 0, "service never called");
  } finally {
    await client.close();
    await server.close();
  }
});

test("M9-7A-06: MCP delivery with no verification rejected, service count 0", async () => {
  let callCount = 0;
  const fakeDispatch = async () => { callCount += 1; return { accepted: true, runId: "x", state: "pending" }; };
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs", dispatchRunFn: fakeDispatch,
  });
  const client = await buildInMemoryClient(server);
  try {
    let rejected = false;
    let result = null;
    try {
      result = await client.callTool({
        name: "run_dispatch",
        arguments: {
          agentId: "x", prompt: "y",
          delivery: { mode: "git_commit_v1", allowedPaths: ["src"] },
        },
      });
    } catch { rejected = true; }
    if (!rejected) { assert.equal(result.isError, true); rejected = true; }
    assert.ok(rejected);
    assert.equal(callCount, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("M9-7A-07: non-delivery dispatch still works identically", async () => {
  let callCount = 0;
  let captured = null;
  const fakeDispatch = async (input) => {
    callCount += 1;
    captured = input;
    return { accepted: true, runId: "r", state: "pending" };
  };
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs", dispatchRunFn: fakeDispatch,
  });
  const client = await buildInMemoryClient(server);
  try {
    await client.callTool({ name: "run_dispatch", arguments: { agentId: "x", prompt: "y" } });
    assert.equal(callCount, 1);
    assert.ok(!captured.delivery, "no delivery forwarded for non-delivery dispatch");
  } finally {
    await client.close();
    await server.close();
  }
});

test("M9-7A-08: empty/whitespace verification values rejected at adapter, service count 0", async () => {
  let callCount = 0;
  const fakeDispatch = async () => { callCount += 1; return { accepted: true, runId: "x", state: "pending" }; };
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs", dispatchRunFn: fakeDispatch,
  });
  const client = await buildInMemoryClient(server);
  try {
    const badInputs = [
      { agentId: "x", prompt: "y", delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: [] } },
      { agentId: "x", prompt: "y", delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["   "] } },
      { agentId: "x", prompt: "y", delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationUnavailableReason: "   " } },
    ];
    for (const bad of badInputs) {
      let rejected = false;
      let result = null;
      try { result = await client.callTool({ name: "run_dispatch", arguments: bad }); }
      catch { rejected = true; }
      if (!rejected) { assert.equal(result.isError, true, `rejected: ${JSON.stringify(Object.keys(bad.delivery || {}))}`); rejected = true; }
      assert.ok(rejected);
    }
    assert.equal(callCount, 0, "service never called for empty/whitespace delivery");
  } finally {
    await client.close();
    await server.close();
  }
});
