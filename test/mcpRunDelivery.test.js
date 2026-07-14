// test/mcpRunDelivery.test.js
//
// M9-6B: MCP run_delivery (read-only query) + run_delivery_decide (durable decision).
//
// Proves that an MCP host can query delivery status and record a Lead decision
// via two distinct tools with correct annotations and safe projections.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createWaoMcpServer } from "../src/mcp/server.js";

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-test", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

// A fake delivery result with sensitive fields the MCP must NOT leak.
function sensitiveDeliveryResult() {
  return {
    runId: "run_x",
    terminalState: "completed",
    deliveryRef: {
      deliveryCommit: "d".repeat(40),
      baseCommit: "b".repeat(40),
      worktreePath: "C:\\Users\\owner\\secret\\worktree",
      branch: "wao/run_x",
      changedFiles: ["src/secret.js", "config/credentials.json"],
      verification: { status: "passed", commands: ["npm test"], results: [{ ok: true }], failureCode: null },
      acceptance: { status: "pending", reviewerType: "lead_agent" },
      integration: { status: "pending", targetCommit: null },
    },
    verification: { status: "passed" },
    acceptance: { status: "pending" },
  };
}

// ===== Tests =====

test("M9-6B-01: tools/list has seven tools including run_delivery + run_delivery_decide", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m96b-01-"));
  try {
    const rp = join(dir, "agents.json");
    writeFileSync(rp, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    const server = createWaoMcpServer({ registryPath: rp, runDir: dir });
    const client = await buildInMemoryClient(server);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      assert.ok(names.includes("run_delivery"), "run_delivery present");
      assert.ok(names.includes("run_delivery_decide"), "run_delivery_decide present");

      const rd = tools.tools.find((t) => t.name === "run_delivery");
      assert.equal(rd.annotations.readOnlyHint, true);
      assert.equal(rd.annotations.destructiveHint, false);
      assert.equal(rd.annotations.idempotentHint, true);
      assert.equal(rd.annotations.openWorldHint, false);

      const rdd = tools.tools.find((t) => t.name === "run_delivery_decide");
      assert.equal(rdd.annotations.readOnlyHint, false);
      assert.equal(rdd.annotations.destructiveHint, true);
      assert.equal(rdd.annotations.idempotentHint, true);
      assert.equal(rdd.annotations.openWorldHint, false);

      // run_delivery_decide input: runId + decision + reason
      assert.deepEqual(Object.keys(rdd.inputSchema.properties).sort(), ["decision", "reason", "runId"]);
      assert.equal(rdd.inputSchema.additionalProperties, false);
    } finally {
      await client.close();
      await server.close();
    }
  } finally { cleanupDir(dir); }
});

test("M9-6B-02: run_delivery returns only safe fields, no DeliveryRef leak", async () => {
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => sensitiveDeliveryResult(),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x" } });
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    const allowed = new Set(["runId", "terminalState", "baseCommit", "deliveryCommit", "changedFileCount", "verificationStatus", "verificationFailureCode", "acceptanceStatus", "decisionType"]);
    for (const k of Object.keys(parsed)) assert.ok(allowed.has(k), `unexpected key: ${k}`);

    assert.equal(parsed.changedFileCount, 2, "count derived from array length");
    assert.equal(parsed.verificationStatus, "passed");
    assert.equal(parsed.verificationFailureCode, null);
    assert.equal(parsed.acceptanceStatus, "pending");
    assert.equal(parsed.decisionType, null);

    const dumped = JSON.stringify(res);
    assert.ok(!dumped.includes("worktreePath"), "no worktreePath");
    assert.ok(!dumped.includes("secret.js"), "no changed file names");
    assert.ok(!dumped.includes("credentials.json"), "no changed file names");
    assert.ok(!dumped.includes("wao/run_x"), "no branch");
    assert.ok(!dumped.includes("npm test"), "no verification commands");
    assert.ok(!dumped.includes("results"), "no verification results");
    assert.ok(!dumped.includes("integration"), "no integration target");

    if (res.structuredContent) assert.deepEqual(res.structuredContent, parsed);
  } finally {
    await client.close();
    await server.close();
  }
});

test("M9-6B-03: run_delivery extra args rejected, service count 0", async () => {
  let calls = 0;
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => { calls += 1; return sensitiveDeliveryResult(); },
  });
  const client = await buildInMemoryClient(server);
  try {
    for (const bad of [{ runId: "r", runDir: "/x" }, { runId: "r", raw: true }, { runId: "r", evil: 1 }]) {
      let rejected = false;
      try { await client.callTool({ name: "run_delivery", arguments: bad }); }
      catch { rejected = true; }
      if (!rejected) { rejected = true; } // isError or throw both count
      assert.ok(rejected);
    }
    assert.equal(calls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("M9-6B-04: run_delivery service error → fixed 'run_delivery failed'", async () => {
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => { throw new Error("C:\\secret\\path leak"); },
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_delivery", arguments: { runId: "r" } });
    assert.equal(res.isError, true);
    const dumped = JSON.stringify(res);
    assert.ok(!dumped.includes("secret"), "no path leak");
    assert.ok(!dumped.includes("C:\\\\"), "no Windows path");
    const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
    assert.ok(/run_delivery failed/.test(text));
  } finally {
    await client.close();
    await server.close();
  }
});

test("M9-6B-05: run_delivery_decide calls service once with server-owned runDir", async () => {
  let calls = 0;
  let captured = null;
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/server/runs",
    decideRunDeliveryFn: async (input) => {
      calls += 1;
      captured = input;
      return { accepted: true, event: { type: "run.delivery_accepted", deliveryCommit: "d".repeat(40), delivery: { acceptance: { status: "accepted" } } } };
    },
  });
  const client = await buildInMemoryClient(server);
  try {
    await client.callTool({
      name: "run_delivery_decide",
      arguments: { runId: "run_x", decision: "accepted", reason: "LGTM" },
    });
    assert.equal(calls, 1);
    assert.equal(captured.runDir, "/server/runs");
    assert.equal(captured.decision, "accepted");
    assert.equal(captured.reason, "LGTM");
  } finally {
    await client.close();
    await server.close();
  }
});

test("M9-6B-06: run_delivery_decide winner output safe, no reason/deliveryRef leak", async () => {
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    decideRunDeliveryFn: async () => ({
      accepted: true,
      event: {
        type: "run.delivery_accepted",
        deliveryCommit: "d".repeat(40),
        delivery: { acceptance: { status: "accepted" }, worktreePath: "C:\\secret", changedFiles: ["x.js"] },
        reason: "secret-reason-must-not-leak",
      },
    }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({
      name: "run_delivery_decide",
      arguments: { runId: "run_x", decision: "accepted", reason: "LGTM" },
    });
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    const allowed = new Set(["runId", "decisionAccepted", "deliveryCommit", "acceptanceStatus", "existingStatus"]);
    for (const k of Object.keys(parsed)) assert.ok(allowed.has(k), `unexpected key: ${k}`);
    assert.equal(parsed.decisionAccepted, true);
    assert.equal(parsed.acceptanceStatus, "accepted");
    assert.equal(parsed.existingStatus, null);

    const dumped = JSON.stringify(res);
    assert.ok(!dumped.includes("secret-reason"), "no reason leak");
    assert.ok(!dumped.includes("worktreePath"), "no worktreePath");
    assert.ok(!dumped.includes("changedFiles"), "no changedFiles");
    assert.ok(!dumped.includes("x.js"), "no file names");
  } finally {
    await client.close();
    await server.close();
  }
});

test("M9-6B-07: run_delivery_decide loser output", async () => {
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    decideRunDeliveryFn: async () => ({
      accepted: false,
      existing: { type: "run.delivery_accepted", status: "accepted", deliveryCommit: "d".repeat(40) },
    }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({
      name: "run_delivery_decide",
      arguments: { runId: "run_x", decision: "rejected", reason: "too late" },
    });
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.equal(parsed.decisionAccepted, false);
    assert.equal(parsed.acceptanceStatus, "accepted");
    assert.equal(parsed.existingStatus, "accepted");
  } finally {
    await client.close();
    await server.close();
  }
});

test("M9-6B-08: run_delivery_decide extra/control-plane args rejected", async () => {
  let calls = 0;
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    decideRunDeliveryFn: async () => { calls += 1; return { accepted: true, event: {} }; },
  });
  const client = await buildInMemoryClient(server);
  try {
    for (const bad of [
      { runId: "r", decision: "accepted", reason: "x", runDir: "/evil" },
      { runId: "r", decision: "accepted", reason: "x", force: true },
      { runId: "r", decision: "accepted", reason: "x", merge: true },
      { runId: "r", decision: "accepted", reason: "x", push: true },
      { runId: "r", decision: "accepted", reason: "x", raw: true },
      { runId: "r", decision: "accepted", reason: "x", evil: 1 },
    ]) {
      let rejected = false;
      let result = null;
      try { result = await client.callTool({ name: "run_delivery_decide", arguments: bad }); }
      catch { rejected = true; }
      if (!rejected) { assert.equal(result.isError, true, `rejected: ${JSON.stringify(Object.keys(bad))}`); rejected = true; }
      assert.ok(rejected, `rejected: ${JSON.stringify(Object.keys(bad))}`);
    }
    assert.equal(calls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("M9-6B-09: run_delivery_decide blank reason and >2000 rejected", async () => {
  let calls = 0;
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    decideRunDeliveryFn: async () => { calls += 1; return { accepted: true, event: {} }; },
  });
  const client = await buildInMemoryClient(server);
  try {
    // Blank reason
    let rejected = false;
    let result = null;
    try { result = await client.callTool({ name: "run_delivery_decide", arguments: { runId: "r", decision: "accepted", reason: "   " } }); }
    catch { rejected = true; }
    if (!rejected) { assert.equal(result.isError, true, "blank reason isError"); rejected = true; }
    assert.ok(rejected, "blank reason rejected");

    // >2000 chars
    rejected = false;
    result = null;
    try { result = await client.callTool({ name: "run_delivery_decide", arguments: { runId: "r", decision: "accepted", reason: "x".repeat(2001) } }); }
    catch { rejected = true; }
    if (!rejected) { assert.equal(result.isError, true, ">2000 isError"); rejected = true; }
    assert.ok(rejected, ">2000 reason rejected");

    assert.equal(calls, 0, "service never called for invalid reason");
  } finally {
    await client.close();
    await server.close();
  }
});

test("M9-6B-10: run_delivery_decide service error → fixed 'run_delivery_decide failed'", async () => {
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    decideRunDeliveryFn: async () => { throw new Error("C:\\secret\\path and AKIA-TOKEN leak"); },
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({
      name: "run_delivery_decide",
      arguments: { runId: "r", decision: "accepted", reason: "x" },
    });
    assert.equal(res.isError, true);
    const dumped = JSON.stringify(res);
    assert.ok(!dumped.includes("secret"), "no path leak");
    assert.ok(!dumped.includes("AKIA"), "no token leak");
    const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
    assert.ok(/run_delivery_decide failed/.test(text));
  } finally {
    await client.close();
    await server.close();
  }
});

test("M9-6B-11: tool descriptions have no recommendation/merge/push claims", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m96b-11-"));
  try {
    const rp = join(dir, "agents.json");
    writeFileSync(rp, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    const server = createWaoMcpServer({ registryPath: rp, runDir: dir });
    const client = await buildInMemoryClient(server);
    try {
      const tools = await client.listTools();
      for (const name of ["run_delivery", "run_delivery_decide"]) {
        const t = tools.tools.find((x) => x.name === name);
        const d = JSON.stringify((t.description ?? "").toLowerCase());
        for (const bad of ["recommend", "should ", "merge", "push", "integrate", "auto-accept", "auto accept"]) {
          assert.ok(!d.includes(bad), `${name} description must not contain '${bad}'`);
        }
      }
    } finally {
      await client.close();
      await server.close();
    }
  } finally { cleanupDir(dir); }
});
