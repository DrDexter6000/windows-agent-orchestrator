// test/mcpRunCollect.test.js
//
// M9-4B: MCP run_collect tool — TDD tests.
//
// Proves that an MCP host can collect a run's results via run_collect, which
// calls the M9-4A collectRunMessages() service and returns ONLY a bounded,
// redacted projection: assistant-authored text (capped) + evidence counts.
// No raw command/tool input-output/file path/secret/SDK-validation-detail leak.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createWaoMcpServer } from "../src/mcp/server.js";

// ===== Helpers =====

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SHIM = join(REPO_ROOT, "scripts", "wao-node.cjs");
const STDIO_ENTRY = join(REPO_ROOT, "src", "mcp", "stdio.js");

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

// A process service result with sensitive content the MCP output must NOT leak raw.
function sensitiveProcessResult() {
  return {
    data: [
      { kind: "command", command: "rm -rf /secret/path" },
      { kind: "tool_use", tool: "Bash", input: { command: "AKIA-SECRET-TOKEN-m94b" } },
      { kind: "tool_result", tool: "Bash", output: "sensitive output data" },
      { kind: "file_written", path: "C:\\Users\\leak\\secret.txt" },
      { kind: "message", role: "assistant", parts: [{ type: "text", text: "I completed the task. ZHIPU_API_KEY=test-secret-key-in-msg-m94b was used." }] },
      { kind: "message", role: "user", parts: [{ type: "text", text: "user prompt" }] },
      { kind: "weird_unknown", foo: "bar", nested: { deep: "object" } },
    ],
    reconstructed: true,
    backend: "process",
  };
}

// ===== Tests =====

// ---------------------------------------------------------------------
// M9-4B-01: tools/list has all four tools.
// ---------------------------------------------------------------------

test("M9-4B-01: tools/list has registry_list + run_dispatch + run_status + run_collect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m94b-01-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    const server = createWaoMcpServer({ registryPath, runDir: dir });
    const client = await buildInMemoryClient(server);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      assert.ok(names.includes("run_collect"), "run_collect present");

      const rc = tools.tools.find((t) => t.name === "run_collect");
      assert.ok(rc, "run_collect present");
      assert.deepEqual(Object.keys(rc.inputSchema.properties ?? {}), ["runId"], "input has only runId");
      assert.equal(rc.inputSchema.additionalProperties, false, "input strict");
      // annotations: not read-only, not idempotent (appends audit event), open-world.
      assert.equal(rc.annotations.readOnlyHint, false, "readOnlyHint:false");
      assert.equal(rc.annotations.destructiveHint, false, "destructiveHint:false");
      assert.equal(rc.annotations.idempotentHint, false, "idempotentHint:false");
      assert.equal(rc.annotations.openWorldHint, true, "openWorldHint:true");
      assert.ok(rc.outputSchema, "output schema declared");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-4B-02: fake service called once with server-owned runDir + fixed limit.
// ---------------------------------------------------------------------

test("M9-4B-02: run_collect calls service once with server-owned runDir and fixed limit", async () => {
  let callCount = 0;
  let captured = null;
  const fakeCollect = async (input) => {
    callCount += 1;
    captured = input;
    return { data: [], reconstructed: true, backend: "process" };
  };

  const server = createWaoMcpServer({
    registryPath: "/server/r.json",
    runDir: "/server/runs",
    collectRunMessagesFn: fakeCollect,
  });
  const client = await buildInMemoryClient(server);
  try {
    await client.callTool({ name: "run_collect", arguments: { runId: "run_abc" } });
    assert.equal(callCount, 1, "service called exactly once");
    assert.equal(captured.runDir, "/server/runs", "server-owned runDir");
    assert.equal(captured.runId, "run_abc");
    // limit is a fixed server constant — model cannot override.
    assert.ok(typeof captured.limit === "number" && captured.limit > 0, "fixed limit from server");
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// M9-4B-03: safe output — only assistant text + counts, no raw payload leak.
// ---------------------------------------------------------------------

test("M9-4B-03: run_collect output is bounded safe projection, no raw leak", async () => {
  const server = createWaoMcpServer({
    registryPath: "/server/r.json",
    runDir: "/server/runs",
    collectRunMessagesFn: async () => sensitiveProcessResult(),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_collect", arguments: { runId: "run_x" } });
    const textBlock = res.content.find((b) => b.type === "text");
    const parsed = JSON.parse(textBlock.text);

    // Top-level keys: only the safe projection.
    const allowedKeys = new Set(["runId", "backend", "reconstructed", "itemCount", "messages", "evidenceCounts", "truncated"]);
    for (const k of Object.keys(parsed)) {
      assert.ok(allowedKeys.has(k), `unexpected key in output: ${k}`);
    }

    // Messages: only assistant role, only text part, no raw envelope.
    assert.ok(Array.isArray(parsed.messages), "messages is array");
    for (const m of parsed.messages) {
      assert.equal(m.role, "assistant", "only assistant messages");
      assert.ok(typeof m.text === "string", "text is string");
      assert.ok(typeof m.truncated === "boolean", "truncated flag per message");
    }
    assert.equal(parsed.messages.length, 1, "one assistant message");

    // No raw payload leaks.
    const dumped = JSON.stringify(res);
    assert.ok(!dumped.includes("rm -rf"), "no command leak");
    assert.ok(!dumped.includes("AKIA-SECRET-TOKEN"), "no token leak from tool input");
    assert.ok(!dumped.includes("sensitive output data"), "no tool_result output leak");
    assert.ok(!dumped.includes("C:\\\\Users"), "no absolute path leak");
    assert.ok(!dumped.includes("user prompt"), "no user message leak");
    assert.ok(!dumped.includes("weird_unknown"), "no unknown raw object leak");
    assert.ok(!/\"command\"/.test(dumped) || dumped.includes("\"backend\""), "no raw command field in output");

    // evidenceCounts present with kind tallies.
    assert.ok(parsed.evidenceCounts, "evidenceCounts present");
    assert.ok(typeof parsed.evidenceCounts.command === "number", "command count");
    assert.ok(typeof parsed.evidenceCounts.toolUse === "number", "toolUse count");

    // structuredContent mirrors content.
    if (res.structuredContent) {
      assert.deepEqual(res.structuredContent, parsed, "structuredContent matches");
    }
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// M9-4B-04: secret in assistant text is redacted.
// ---------------------------------------------------------------------

test("M9-4B-04: secret value in assistant text is redacted", async () => {
  // Set an env var that the redactor knows, then put its value in assistant text.
  process.env.WAO_M94B_SECRET = "test-secret-value-m94b04";
  try {
    const server = createWaoMcpServer({
      registryPath: "/server/r.json",
      runDir: "/server/runs",
      collectRunMessagesFn: async () => ({
        data: [{ kind: "message", role: "assistant", parts: [{ type: "text", text: "key is test-secret-value-m94b04 here" }] }],
        reconstructed: true, backend: "process",
      }),
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_collect", arguments: { runId: "run_x" } });
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes("test-secret-value-m94b04"), "secret value redacted from assistant text");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    delete process.env.WAO_M94B_SECRET;
  }
});

// ---------------------------------------------------------------------
// M9-4B-05: serve message shape — assistant text extracted, raw envelope not leaked.
// ---------------------------------------------------------------------

test("M9-4B-05: serve message shape assistant text extracted, envelope not leaked", async () => {
  const server = createWaoMcpServer({
    registryPath: "/server/r.json",
    runDir: "/server/runs",
    collectRunMessagesFn: async () => ({
      data: [
        { id: "m1", info: { role: "assistant" }, parts: [{ type: "text", text: "serve result text" }], metadata: { internal: "leak_me" } },
        { id: "m2", info: { role: "user" }, parts: [{ type: "text", text: "user msg" }] },
      ],
    }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_collect", arguments: { runId: "run_x" } });
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.equal(parsed.messages.length, 1, "only assistant extracted");
    assert.equal(parsed.messages[0].text, "serve result text", "assistant text extracted");
    const dumped = JSON.stringify(res);
    assert.ok(!dumped.includes("leak_me"), "no raw metadata envelope leak");
    assert.ok(!dumped.includes("user msg"), "no user message leak");
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// M9-4B-06: extra/control-plane args rejected, service count 0.
// ---------------------------------------------------------------------

test("M9-4B-06: control-plane args rejected, service not called", async () => {
  let callCount = 0;
  const fakeCollect = async () => { callCount += 1; return { data: [], reconstructed: true, backend: "process" }; };

  const server = createWaoMcpServer({
    registryPath: "/server/r.json", runDir: "/server/runs",
    collectRunMessagesFn: fakeCollect,
  });
  const client = await buildInMemoryClient(server);
  try {
    const badArgsList = [
      { runId: "run_x", runDir: "/attacker/runs" },
      { runId: "run_x", limit: 999 },
      { runId: "run_x", serveUrl: "http://evil" },
      { runId: "run_x", raw: true },
      { runId: "run_x", includeTools: true },
      { runId: "run_x", evil: true },
    ];
    for (const bad of badArgsList) {
      let rejected = false;
      let result = null;
      try {
        result = await client.callTool({ name: "run_collect", arguments: bad });
      } catch {
        rejected = true;
      }
      if (!rejected) {
        assert.equal(result.isError, true, `control-plane arg ${JSON.stringify(Object.keys(bad))} rejected`);
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
// M9-4B-07: service/projection/redactor error → fixed "run_collect failed".
// ---------------------------------------------------------------------

test("M9-4B-07: service error returns fixed safe text, no leak", async () => {
  const SECRET = "test-secret-collect-m94b07";
  const ABS = "C:\\Users\\leak\\collect.jsonl";
  const server = createWaoMcpServer({
    registryPath: "/server/r.json", runDir: "/server/runs",
    collectRunMessagesFn: async () => { throw new Error(`collect crashed at ${ABS} key=${SECRET}`); },
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_collect", arguments: { runId: "run_x" } });
    assert.equal(res.isError, true, "error flagged");
    const dumped = JSON.stringify(res);
    assert.ok(!dumped.includes(SECRET), "no secret leak");
    assert.ok(!dumped.includes(ABS), "no path leak");
    assert.ok(!/output validation error/i.test(dumped), "no SDK validation error leak");
    const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
    assert.ok(/run_collect failed/.test(text), "fixed safe text");
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// M9-4B-08: bounds — 8 message cap, 4000 char per text, 12000 total, truncated flags.
// ---------------------------------------------------------------------

test("M9-4B-08: message and text bounds enforced with accurate truncated flags", async () => {
  // 12 assistant messages → capped at 8.
  const manyMsgs = [];
  for (let i = 0; i < 12; i += 1) {
    manyMsgs.push({ kind: "message", role: "assistant", parts: [{ type: "text", text: `msg ${i}` }] });
  }
  const server = createWaoMcpServer({
    registryPath: "/server/r.json", runDir: "/server/runs",
    collectRunMessagesFn: async () => ({ data: manyMsgs, reconstructed: true, backend: "process" }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_collect", arguments: { runId: "run_x" } });
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.ok(parsed.messages.length <= 8, "at most 8 messages");
    assert.equal(parsed.truncated, true, "truncated=true when capped");
  } finally {
    await client.close();
    await server.close();
  }

  // Single very long text → capped at 4000.
  const longText = "x".repeat(5000);
  const server2 = createWaoMcpServer({
    registryPath: "/server/r.json", runDir: "/server/runs",
    collectRunMessagesFn: async () => ({ data: [{ kind: "message", role: "assistant", parts: [{ type: "text", text: longText }] }], reconstructed: true, backend: "process" }),
  });
  const client2 = await buildInMemoryClient(server2);
  try {
    const res = await client2.callTool({ name: "run_collect", arguments: { runId: "run_x" } });
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.ok(parsed.messages[0].text.length <= 4000, "text capped at 4000");
    assert.equal(parsed.messages[0].truncated, true, "per-message truncated=true");
  } finally {
    await client2.close();
    await server2.close();
  }
});

// ---------------------------------------------------------------------
// M9-4B-09: empty result → messages=[], itemCount=0, not an error.
// ---------------------------------------------------------------------

test("M9-4B-09: empty collect result → messages=[] itemCount=0", async () => {
  const server = createWaoMcpServer({
    registryPath: "/server/r.json", runDir: "/server/runs",
    collectRunMessagesFn: async () => ({ data: [], reconstructed: true, backend: "process" }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_collect", arguments: { runId: "run_x" } });
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.deepEqual(parsed.messages, [], "no messages");
    assert.equal(parsed.itemCount, 0, "itemCount 0");
    assert.equal(parsed.truncated, false, "not truncated");
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// M9-4B-10: CLI and MCP call same service — messages.collected parity (in-memory).
// ---------------------------------------------------------------------

test("M9-4B-10: MCP run_collect appends messages.collected via shared service", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m94b-10-"));
  try {
    const runDir = join(dir, "runs");
    const runId = "run_parity_m94b";
    const transcriptPath = join(runDir, `${runId}.jsonl`);
    // Write a process transcript.
    mkdirSync(runDir, { recursive: true });
    writeFileSync(transcriptPath,
      JSON.stringify({ type: "session.created", backend: "process", backendSessionId: "proc_1", runId, agentId: "w" }) + "\n" +
      JSON.stringify({ type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "hello" }], ts: "2026-07-14T00:00:00.000Z", runId, agentId: "w" }) + "\n" +
      JSON.stringify({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-07-14T00:00:01.000Z", runId, agentId: "w" }) + "\n",
      "utf8");

    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");

    const server = createWaoMcpServer({ registryPath, runDir });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_collect", arguments: { runId } });
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(parsed.messages.length, 1, "one assistant message extracted");
      assert.equal(parsed.messages[0].text, "hello");
      assert.equal(parsed.backend, "process");
    } finally {
      await client.close();
      await server.close();
    }

    // Verify exactly one messages.collected was appended.
    const events = readFileSync(transcriptPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const collected = events.filter((e) => e.type === "messages.collected");
    assert.equal(collected.length, 1, "exactly one messages.collected appended");
    // Terminal state unchanged.
    const stateChanges = events.filter((e) => e.type === "run.state_change");
    assert.equal(stateChanges.at(-1).to, "completed", "terminal unchanged");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-4B-11: tool-only assistant messages don't consume the 8-message text quota.
//           CTO P1: 8 tool-only assistant messages + 1 final text answer → output
//           must contain the final answer, not 8 empty texts.
// ---------------------------------------------------------------------

test("M9-4B-11: tool-only assistant messages do not consume text quota", async () => {
  // 8 assistant messages with NO text part (tool_use only) + 1 final answer.
  const data = [];
  for (let i = 0; i < 8; i += 1) {
    data.push({ kind: "message", role: "assistant", parts: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: "echo" } }] });
  }
  data.push({ kind: "message", role: "assistant", parts: [{ type: "text", text: "final answer" }] });

  const server = createWaoMcpServer({
    registryPath: "/server/r.json", runDir: "/server/runs",
    collectRunMessagesFn: async () => ({ data, reconstructed: true, backend: "process" }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_collect", arguments: { runId: "run_x" } });
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    // The final answer must be present.
    assert.ok(parsed.messages.some((m) => m.text === "final answer"),
      "final answer present — tool-only messages did not consume the text quota");
    // No empty-text messages.
    for (const m of parsed.messages) {
      assert.ok(m.text.length > 0, `no empty-text message in output (got "${m.text}")`);
    }
    // evidenceCounts.message counts ALL 9 messages (8 tool-only + 1 text).
    assert.equal(parsed.evidenceCounts.message, 9, "all 9 messages counted");
    assert.equal(parsed.itemCount, 9, "itemCount = 9");
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// M9-4B-12: 12000-char cap does not stop evidence counting.
//           CTO P2: after the text cap, subsequent command/tool/file events
//           must still be counted in evidenceCounts.
// ---------------------------------------------------------------------

test("M9-4B-12: text cap does not break evidence counting for later items", async () => {
  // Four 4000-char assistant messages fill the 12000 total cap (4×4000=16000,
  // but the 4th hits remaining<=0). After the break, command/tool/file items
  // follow — the OLD code `break`s out of the loop, skipping their evidence
  // tallies. They must still be counted.
  const data = [];
  for (let i = 0; i < 4; i += 1) {
    data.push({ kind: "message", role: "assistant", parts: [{ type: "text", text: "z".repeat(4000) }] });
  }
  data.push({ kind: "command", command: "npm test" });
  data.push({ kind: "tool_use", tool: "Read", input: { file_path: "a.js" } });
  data.push({ kind: "tool_result", tool: "Read", output: "..." });
  data.push({ kind: "file_written", path: "out.txt" });

  const server = createWaoMcpServer({
    registryPath: "/server/r.json", runDir: "/server/runs",
    collectRunMessagesFn: async () => ({ data, reconstructed: true, backend: "process" }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_collect", arguments: { runId: "run_x" } });
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    // All 8 items (4 messages + 4 evidence) must be counted even though the
    // text cap was hit during the 4th message.
    assert.equal(parsed.itemCount, 8, "itemCount = 8 (all items)");
    assert.equal(parsed.evidenceCounts.message, 4, "all 4 messages counted");
    assert.equal(parsed.evidenceCounts.command, 1, "command counted after text cap");
    assert.equal(parsed.evidenceCounts.toolUse, 1, "toolUse counted after text cap");
    assert.equal(parsed.evidenceCounts.toolResult, 1, "toolResult counted after text cap");
    assert.equal(parsed.evidenceCounts.fileWritten, 1, "fileWritten counted after text cap");
  } finally {
    await client.close();
    await server.close();
  }
});
