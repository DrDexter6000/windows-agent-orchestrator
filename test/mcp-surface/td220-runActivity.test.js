import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWaoMcpServer } from "../../src/mcp/server.js";
import { ENVELOPE_ACTIVITY_LABELS } from "../../src/application/runActivityProjection.js";

test("TD-220: MCP discovery and response carry strict count-only categories and command sources", async () => {
  const runId = "run_td220_mcp";
  const ts = "2026-10-07T00:00:00Z";
  const items = [
    { kind: "command", exitCode: 0 },
    { kind: "command", exitCode: 2 },
    { kind: "command", toolCallId: "ok" },
    { kind: "command", toolCallId: "fail" },
    { kind: "command" },
    { kind: "tool_result", tool: "ok", isError: false },
    { kind: "tool_result", tool: "fail", isError: true },
    { kind: "thinking", text: "SECRET", payload: "SECRET" },
    { type: "prompt.sent", prompt: "SECRET", kind: "SECRET" },
    { type: "messages.collected", payload: "SECRET" },
    { type: "future", payload: "SECRET" },
  ];
  const server = createWaoMcpServer({
    workspaceRoot: process.cwd(), registryPath: "unused.json", runDir: process.cwd(),
    readRunActivityFn: async () => ({
      events: items.map((e, i) => ({ runId, ts, seq: i + 1, type: "run.event", ...e })),
      backend: "claude-code", agentId: "coder_low", state: "running", terminal: false,
    }),
  });
  const client = new Client({ name: "td220-test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tool = (await client.listTools()).tools.find((t) => t.name === "run_activity");
    const variants = tool.outputSchema.properties.entries.items.anyOf;
    const variant = (category) => variants.find((v) => v.properties.category.const === category);
    const thinking = variant("thinking");
    assert.equal(thinking.additionalProperties, false);
    assert.deepEqual(Object.keys(thinking.properties).sort(), ["category", "seq", "ts"]);
    const envelope = variant("envelope");
    assert.equal(envelope.additionalProperties, false);
    assert.deepEqual(Object.keys(envelope.properties).sort(), ["category", "kind", "seq", "ts"]);
    assert.deepEqual(envelope.properties.kind.enum, [...ENVELOPE_ACTIVITY_LABELS]);
    const command = variant("command");
    assert.deepEqual(command.properties.exitStatusSource.enum, ["wire", "inferred"]);
    assert.equal(command.required.includes("exitStatusSource"), false);

    const res = await client.callTool({ name: "run_activity", arguments: { runId, pageSize: 50 } });
    assert.equal(res.isError, undefined);
    const data = res.structuredContent;
    assert.ok(data, "handler passes strict emitted output validation");
    assert.deepEqual(data.entries.slice(0, 5).map((e) => [e.exitStatus, e.exitStatusSource]), [
      ["ok", "wire"], ["failed", "wire"], ["ok", "inferred"], ["failed", "inferred"], ["unknown", undefined],
    ]);
    assert.equal(Object.hasOwn(data.entries[4], "exitStatusSource"), false);
    assert.deepEqual(data.entries[7], { category: "thinking", ts, seq: 8 });
    assert.deepEqual(data.entries[8], { category: "envelope", ts, seq: 9, kind: "prompt" });
    assert.equal(data.counts.other, 1);
    assert.equal(data.total, 10);
    assert.equal(JSON.stringify(res).includes("SECRET"), false);
    const filtered = await client.callTool({ name: "run_activity", arguments: { runId, categories: ["thinking", "envelope"] } });
    assert.deepEqual(filtered.structuredContent.entries.map((e) => e.category), ["thinking", "envelope"]);
  } finally {
    await client.close();
    await server.close();
  }
});
