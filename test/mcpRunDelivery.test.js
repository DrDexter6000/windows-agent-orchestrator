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

// ---------------------------------------------------------------------------
// M9-6B-12: malformed query scalar values → fixed error (CTO P1).
// ---------------------------------------------------------------------------

test("M9-6B-12: malformed query scalar values collapse to fixed error", async () => {
  const mkRef = (over = {}) => ({ baseCommit: "b".repeat(40), deliveryCommit: "d".repeat(40), changedFiles: [], ...over });
  const vectors = [
    ["runId mismatch", { runId: "evil", terminalState: "completed", deliveryRef: mkRef(), verification: { status: "passed" }, acceptance: { status: "pending" } }],
    ["terminalState=secret", { runId: "run_x", terminalState: "C:\\secret", deliveryRef: mkRef(), verification: { status: "passed" }, acceptance: { status: "pending" } }],
    ["bad baseCommit", { runId: "run_x", terminalState: "completed", deliveryRef: mkRef({ baseCommit: "not-hash" }), verification: { status: "passed" }, acceptance: { status: "pending" } }],
    ["null deliveryCommit", { runId: "run_x", terminalState: "completed", deliveryRef: mkRef({ deliveryCommit: null }), verification: { status: "passed" }, acceptance: { status: "pending" } }],
    ["bad verificationStatus", { runId: "run_x", terminalState: "completed", deliveryRef: mkRef(), verification: { status: "AKIA-LEAK" }, acceptance: { status: "pending" } }],
    ["bad acceptanceStatus", { runId: "run_x", terminalState: "completed", deliveryRef: mkRef(), verification: { status: "passed" }, acceptance: { status: "/etc/passwd" } }],
    ["changedFiles not array", { runId: "run_x", terminalState: "completed", deliveryRef: mkRef({ changedFiles: "evil" }), verification: { status: "passed" }, acceptance: { status: "pending" } }],
  ];
  for (const [label, result] of vectors) {
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs", getRunDeliveryFn: async () => result });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x" } });
      assert.equal(res.isError, true, `${label}: must be error`);
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes("C:\\\\"), `${label}: no path`);
      assert.ok(!dumped.includes("AKIA"), `${label}: no secret`);
      assert.ok(!dumped.includes("/etc/passwd"), `${label}: no path`);
      assert.ok(!dumped.includes("not-hash"), `${label}: no bad commit`);
    } finally { await client.close(); await server.close(); }
  }
});

test("M9-6B-13: malformed decide result collapses to fixed error", async () => {
  const vectors = [
    ["loser bad status", { accepted: false, existing: { status: "C:\\secret", deliveryCommit: "d".repeat(40) } }],
    ["loser bad commit", { accepted: false, existing: { status: "accepted", deliveryCommit: "not-hash" } }],
    ["winner bad commit", { accepted: true, event: { deliveryCommit: "evil" } }],
    ["accepted not boolean", { accepted: "yes", event: {} }],
  ];
  for (const [label, result] of vectors) {
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs", decideRunDeliveryFn: async () => result });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_delivery_decide", arguments: { runId: "run_x", decision: "accepted", reason: "x" } });
      assert.equal(res.isError, true, `${label}: must be error`);
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes("C:\\\\"), `${label}: no path`);
      assert.ok(!dumped.includes("secret"), `${label}: no secret`);
      assert.ok(!dumped.includes("not-hash"), `${label}: no bad commit`);
      assert.ok(!dumped.includes("evil"), `${label}: no bad value`);
    } finally { await client.close(); await server.close(); }
  }
});

// Real integration tests using actual JsonlTranscript + default service.

async function setupDeliveryRun(dir, runId, verificationStatus) {
  const { JsonlTranscript } = await import("../src/transcript.js");
  const runDir = join(dir, "runs");
  const transcript = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId: "test" });
  const ref = {
    schemaVersion: 1, kind: "git_commit", runId,
    baseCommit: "b".repeat(40), deliveryCommit: "d".repeat(40),
    branch: "wao/x", worktreePath: "/fake", changedFiles: ["a.js"],
    verification: { status: verificationStatus, commands: [], verifiedCommit: "d".repeat(40), results: [],
      ...(verificationStatus === "failed" ? { failureCode: "command_failed" } : {}) },
    acceptance: { status: "pending" }, integration: { status: "pending", targetCommit: null },
  };
  await transcript.append("run.started", { delivery: { mode: "git_commit_v1" }, worktreePath: "/fake" });
  await transcript.append("run.delivery_created", { delivery: ref });
  const vType = verificationStatus === "passed" ? "run.delivery_verification_passed" : "run.delivery_verification_failed";
  await transcript.append(vType, { delivery: ref });
  await transcript.append("run.state_change", { from: "running", to: "completed", reason: "done" });
  const rp = join(dir, "agents.json");
  writeFileSync(rp, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
  return { runDir, rp };
}

test("M9-6B-14: MCP accept through real service appends one event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m96b-14-"));
  try {
    const { runDir, rp } = await setupDeliveryRun(dir, "run_i14", "passed");
    const server = createWaoMcpServer({ registryPath: rp, runDir });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_delivery_decide", arguments: { runId: "run_i14", decision: "accepted", reason: "LGTM" } });
      const p = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(p.decisionAccepted, true);
      assert.equal(p.deliveryCommit, "d".repeat(40));
    } finally { await client.close(); await server.close(); }
    const { readTranscript } = await import("../src/transcript.js");
    const events = await readTranscript(join(runDir, "run_i14.jsonl"));
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted").length, 1);
  } finally { cleanupDir(dir); }
});

test("M9-6B-15: failed verification blocks accept, allows reject", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m96b-15-"));
  try {
    const { runDir, rp } = await setupDeliveryRun(dir, "run_i15", "failed");
    // Accept fails
    {
      const server = createWaoMcpServer({ registryPath: rp, runDir });
      const client = await buildInMemoryClient(server);
      try {
        const res = await client.callTool({ name: "run_delivery_decide", arguments: { runId: "run_i15", decision: "accepted", reason: "x" } });
        assert.equal(res.isError, true, "accept on failed verification must error");
      } finally { await client.close(); await server.close(); }
    }
    // Reject succeeds
    {
      const server = createWaoMcpServer({ registryPath: rp, runDir });
      const client = await buildInMemoryClient(server);
      try {
        const res = await client.callTool({ name: "run_delivery_decide", arguments: { runId: "run_i15", decision: "rejected", reason: "bad" } });
        const p = JSON.parse(res.content.find((b) => b.type === "text").text);
        assert.equal(p.decisionAccepted, true, "reject succeeds");
      } finally { await client.close(); await server.close(); }
    }
    const { readTranscript } = await import("../src/transcript.js");
    const events = await readTranscript(join(runDir, "run_i15.jsonl"));
    assert.equal(events.filter((e) => e.type === "run.delivery_rejected").length, 1);
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted").length, 0);
  } finally { cleanupDir(dir); }
});

test("M9-6B-16: repeated/opposite decisions lose, one total event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m96b-16-"));
  try {
    const { runDir, rp } = await setupDeliveryRun(dir, "run_i16", "passed");
    for (const [decision, reason] of [["accepted", "first"], ["accepted", "second"], ["rejected", "opposite"]]) {
      const server = createWaoMcpServer({ registryPath: rp, runDir });
      const client = await buildInMemoryClient(server);
      try {
        const res = await client.callTool({ name: "run_delivery_decide", arguments: { runId: "run_i16", decision, reason } });
        const p = JSON.parse(res.content.find((b) => b.type === "text").text);
        if (reason === "first") assert.equal(p.decisionAccepted, true);
        else { assert.equal(p.decisionAccepted, false); assert.equal(p.existingStatus, "accepted"); }
      } finally { await client.close(); await server.close(); }
    }
    const { readTranscript } = await import("../src/transcript.js");
    const events = await readTranscript(join(runDir, "run_i16.jsonl"));
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted" || e.type === "run.delivery_rejected").length, 1);
  } finally { cleanupDir(dir); }
});

test("M9-6B-17: concurrent MCP decisions → one winner, one loser, one event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m96b-17-"));
  try {
    const { runDir, rp } = await setupDeliveryRun(dir, "run_i17", "passed");
    const s1 = createWaoMcpServer({ registryPath: rp, runDir });
    const s2 = createWaoMcpServer({ registryPath: rp, runDir });
    const c1 = await buildInMemoryClient(s1);
    const c2 = await buildInMemoryClient(s2);
    try {
      const [r1, r2] = await Promise.all([
        c1.callTool({ name: "run_delivery_decide", arguments: { runId: "run_i17", decision: "accepted", reason: "c1" } }),
        c2.callTool({ name: "run_delivery_decide", arguments: { runId: "run_i17", decision: "accepted", reason: "c2" } }),
      ]);
      const p1 = JSON.parse(r1.content.find((b) => b.type === "text").text);
      const p2 = JSON.parse(r2.content.find((b) => b.type === "text").text);
      assert.equal([p1, p2].filter((p) => p.decisionAccepted).length, 1, "one winner");
      assert.equal([p1, p2].filter((p) => !p.decisionAccepted).length, 1, "one loser");
    } finally { await c1.close(); await s1.close(); await c2.close(); await s2.close(); }
    const { readTranscript } = await import("../src/transcript.js");
    const events = await readTranscript(join(runDir, "run_i17.jsonl"));
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted").length, 1, "one event");
  } finally { cleanupDir(dir); }
});
