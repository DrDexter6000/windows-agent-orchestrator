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
      // Sorted canonical repo-relative paths (real DeliveryRef.changedFiles is sorted).
      changedFiles: ["config/credentials.json", "src/secret.js"],
      verification: { status: "passed", commands: ["npm test"], results: [{ ok: true }], failureCode: null },
      acceptance: { status: "pending", reviewerType: "lead_agent" },
      integration: { status: "pending", targetCommit: null },
    },
    verification: { status: "passed" },
    acceptance: { status: "pending" },
  };
}

// ===== Tests =====

test("M9-6B-01: tools/list includes run_delivery + run_delivery_decide", async () => {
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

test("M9-6B-02: run_delivery returns safe fields incl. bounded changedPaths, no DeliveryRef leak", async () => {
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => sensitiveDeliveryResult(),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x" } });
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    // M11-1A: changedPaths + changedPathsTruncated are now part of the safe output set.
    // M11-8C: deliveryAvailable (success discriminator) + deliveryFailure (null on success).
    // M12-1S1/M12-4A: candidate inventory and its closed-set kind are nullable on success.
    // M12-6 3B2a: ADDITIVE originalVerificationStatus/effectiveVerificationStatus/
    // reverify — the old verificationStatus semantics are preserved exactly, and
    // a service view with no reverify chain yields effective === original and
    // reverify { status:"none", reason:null }.
    // M12-8B: availableDrilldowns added (bounded progressive-disclosure metadata).
    // M12-12: semanticNotes added (REQUIRED self-describing notes; see wao://semantics).
    const allowed = new Set(["runId", "deliveryAvailable", "deliveryRequested", "terminalState", "baseCommit", "deliveryCommit", "changedFileCount", "changedPaths", "changedPathsTruncated", "verificationStatus", "verificationFailureCode", "verificationFailureSummary", "originalVerificationStatus", "effectiveVerificationStatus", "reverify", "acceptanceStatus", "decisionType", "deliveryFailure", "candidateInventory", "candidateKind", "availableDrilldowns", "semanticNotes"]);
    for (const k of Object.keys(parsed)) assert.ok(allowed.has(k), `unexpected key: ${k}`);
    assert.equal(parsed.deliveryAvailable, true, "success variant has deliveryAvailable:true");
    assert.equal(parsed.deliveryRequested, true, "success variant confirms delivery intent");
    assert.equal(parsed.deliveryFailure, null, "no deliveryFailure on success");
    assert.equal(parsed.candidateInventory, null, "no candidateInventory on success (M12-1S1)");
    assert.equal(parsed.candidateKind, null, "no candidateKind on success (M12-4A)");
    assert.equal(parsed.originalVerificationStatus, "passed", "explicit original = old verificationStatus");
    assert.equal(parsed.effectiveVerificationStatus, "passed", "no reverify chain → effective === original");
    assert.deepEqual(parsed.reverify, { status: "none", reason: null }, "no reverify chain → none");

    assert.equal(parsed.changedFileCount, 2, "count derived from array length");
    assert.equal(parsed.verificationStatus, "passed");
    assert.equal(parsed.verificationFailureCode, null);
    assert.equal(parsed.acceptanceStatus, "pending");
    assert.equal(parsed.decisionType, null);

    // M11-1A: changedPaths now exposes the safe repo-relative paths (bounded, validated).
    // The old "no changed file names" contract is replaced by "only safe repo-relative paths".
    assert.ok(Array.isArray(parsed.changedPaths), "changedPaths must be an array");
    assert.equal(parsed.changedPaths.length, 2);
    assert.deepEqual(parsed.changedPaths, ["config/credentials.json", "src/secret.js"].sort(),
      "changedPaths must be sorted, repo-relative, forward-slash");
    assert.equal(parsed.changedPathsTruncated, false, "2 <= 64 cap, not truncated");

    // Still must NOT leak raw DeliveryRef internals / absolute paths / commands / results.
    const dumped = JSON.stringify(res);
    assert.ok(!dumped.includes("worktreePath"), "no worktreePath (absolute worktree path)");
    assert.ok(!dumped.includes("C:\\\\Users"), "no absolute Windows path");
    assert.ok(!dumped.includes("wao/run_x"), "no branch");
    assert.ok(!dumped.includes("npm test"), "no verification commands");
    assert.ok(!dumped.includes("results"), "no verification results");
    assert.ok(!dumped.includes("integration"), "no integration target");
    assert.ok(!dumped.includes("reviewerType"), "no acceptance reviewerType");

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
    // M12-6 3B2a: additive nullable rejectionReason (closed set) on every outcome.
    const allowed = new Set(["runId", "decisionAccepted", "deliveryCommit", "acceptanceStatus", "existingStatus", "rejectionReason"]);
    for (const k of Object.keys(parsed)) assert.ok(allowed.has(k), `unexpected key: ${k}`);
    assert.equal(parsed.decisionAccepted, true);
    assert.equal(parsed.acceptanceStatus, "accepted");
    assert.equal(parsed.existingStatus, null);
    assert.equal(parsed.rejectionReason, null, "winner carries no rejection");

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
    // M12-6 3B2a: a lost decision is a NORMAL structured outcome (first-wins),
    // not an MCP error — with the closed-set rejectionReason.
    assert.equal(res.isError, undefined, "loser is a normal structured outcome");
    assert.equal(parsed.rejectionReason, "already_decided");
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

// ---------------------------------------------------------------------------
// M11-1A: safe changed-path projection in run_delivery.
// ---------------------------------------------------------------------------

test("M11-1A-01: run_delivery output field set is exactly the approved safe projection", async () => {
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => ({
      runId: "run_x",
      terminalState: "completed",
      deliveryRef: {
        deliveryCommit: "d".repeat(40), baseCommit: "b".repeat(40),
        changedFiles: ["src/a.js", "test/a.test.js"],
        verification: { status: "passed" },
        acceptance: { status: "pending" },
      },
      verification: { status: "passed" },
      acceptance: { status: "pending" },
    }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x" } });
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    // M11-8C: added deliveryAvailable (success discriminator) + deliveryFailure (null here).
    // M11-12B: added nullable verificationFailureSummary (null here — status is passed).
    // M12-1S1/M12-4A: added nullable candidateInventory + candidateKind.
    // M12-6 3B2a: added nullable originalVerificationStatus / effectiveVerificationStatus
    // and the strict reverify chain projection — STRICT field set updated, not weakened.
    // M12-8B: added availableDrilldowns (bounded progressive-disclosure metadata).
    // M12-12: added semanticNotes (REQUIRED self-describing notes; see wao://semantics).
    const expectedKeys = new Set([
      "runId", "deliveryAvailable", "deliveryRequested", "terminalState", "baseCommit", "deliveryCommit",
      "changedFileCount", "changedPaths", "changedPathsTruncated",
      "verificationStatus", "originalVerificationStatus", "effectiveVerificationStatus", "reverify",
      "verificationFailureCode", "verificationFailureSummary",
      "acceptanceStatus", "decisionType", "deliveryFailure", "candidateInventory", "candidateKind",
      "availableDrilldowns", "semanticNotes",
    ]);
    assert.deepEqual(new Set(Object.keys(parsed)), expectedKeys,
      `field set mismatch; got ${Object.keys(parsed).sort()}`);
    assert.equal(parsed.deliveryAvailable, true, "success variant");
    assert.equal(parsed.deliveryRequested, true, "delivery intent is explicit");
    // No reverify chain on this run: verificationStatus semantics preserved —
    // all three verification fields equal the ORIGINAL status, chain is "none".
    assert.equal(parsed.verificationStatus, "passed", "verificationStatus = original status");
    assert.equal(parsed.originalVerificationStatus, "passed");
    assert.equal(parsed.effectiveVerificationStatus, "passed");
    assert.deepEqual(parsed.reverify, { status: "none", reason: null });
  } finally { await client.close(); await server.close(); }
});

test("M11-1A-02: run_delivery returns safe repo-relative paths, no raw diff/content/worktree/branch", async () => {
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => ({
      runId: "run_x",
      terminalState: "completed",
      deliveryRef: {
        deliveryCommit: "d".repeat(40), baseCommit: "b".repeat(40),
        worktreePath: "C:\\Users\\owner\\worktree",
        branch: "wao/run_x",
        changedFiles: ["src/a.js", "test/b.test.js"],
        verification: { status: "passed", commands: ["npm test"], results: [{ ok: true }] },
        acceptance: { status: "pending", reviewerType: "lead_agent" },
        integration: { status: "pending", targetCommit: null },
      },
      verification: { status: "passed" },
      acceptance: { status: "pending" },
    }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x" } });
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.deepEqual(parsed.changedPaths, ["src/a.js", "test/b.test.js"]);
    assert.equal(parsed.changedFileCount, 2);
    assert.equal(parsed.changedPathsTruncated, false);
    const dumped = JSON.stringify(res);
    for (const forbidden of ["worktreePath", "C:\\\\Users", "wao/run_x", "npm test", "results", "integration", "reviewerType", "targetCommit"]) {
      assert.ok(!dumped.includes(forbidden), `no ${forbidden} leak`);
    }
  } finally { await client.close(); await server.close(); }
});

test("M11-1A-03: run_delivery caps changedPaths at 64, sets truncated=true when count>64", async () => {
  // 65 sorted canonical paths → first 64 returned, count=65, truncated=true.
  const many = Array.from({ length: 65 }, (_, i) => `src/f${String(i).padStart(3, "0")}.js`).sort();
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => ({
      runId: "run_x",
      terminalState: "completed",
      deliveryRef: {
        deliveryCommit: "d".repeat(40), baseCommit: "b".repeat(40),
        changedFiles: many,
        verification: { status: "passed" },
        acceptance: { status: "pending" },
      },
      verification: { status: "passed" },
      acceptance: { status: "pending" },
    }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x" } });
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.equal(parsed.changedPaths.length, 64, "capped at 64");
    assert.equal(parsed.changedFileCount, 65, "real count preserved");
    assert.equal(parsed.changedPathsTruncated, true, "truncated flag set");
    assert.deepEqual(parsed.changedPaths, many.slice(0, 64), "deterministic first 64");
  } finally { await client.close(); await server.close(); }
});

test("M11-1A-04: run_delivery malformed path in changedFiles → fixed 'run_delivery failed', no leak", async () => {
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => ({
      runId: "run_x",
      terminalState: "completed",
      deliveryRef: {
        deliveryCommit: "d".repeat(40), baseCommit: "b".repeat(40),
        // Malformed: absolute path + traversal — must fail-closed.
        changedFiles: ["C:\\Users\\owner\\secret.js", "../etc/passwd"],
        verification: { status: "passed" },
        acceptance: { status: "pending" },
      },
      verification: { status: "passed" },
      acceptance: { status: "pending" },
    }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x" } });
    assert.equal(res.isError, true, "malformed path must produce error");
    const dumped = JSON.stringify(res);
    assert.ok(dumped.includes("run_delivery failed"), "fixed safe error text");
    // Malicious values must NOT leak through the fixed error.
    assert.ok(!dumped.includes("C:\\\\Users"), "no absolute path leak");
    assert.ok(!dumped.includes("../etc/passwd"), "no traversal leak");
    assert.ok(!dumped.includes("owner"), "no user dir leak");
  } finally { await client.close(); await server.close(); }
});

test("M11-1A-05: run_delivery malformed service result (non-array changedFiles) → fixed error", async () => {
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => ({
      runId: "run_x",
      terminalState: "completed",
      deliveryRef: {
        deliveryCommit: "d".repeat(40), baseCommit: "b".repeat(40),
        changedFiles: "AKIAIOSFODNN7EXAMPLE",
        verification: { status: "passed" },
        acceptance: { status: "pending" },
      },
      verification: { status: "passed" },
      acceptance: { status: "pending" },
    }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x" } });
    assert.equal(res.isError, true, "non-array changedFiles must produce error");
    const dumped = JSON.stringify(res);
    assert.ok(dumped.includes("run_delivery failed"), "fixed safe error text");
    assert.ok(!dumped.includes("AKIA"), "no secret-like value leak");
  } finally { await client.close(); await server.close(); }
});

test("M11-1A-06: run_delivery redacts a changed path that carries a known exact secret value (env-exact redaction)", async () => {
  // RED on prior HEAD: a legitimate repo-relative path that happens to contain
  // a known exact secret value (injected as an env name recognized by
  // createSecretRedactor) was returned verbatim. GREEN: any path changed by the
  // redactor maps to the fixed "[REDACTED]" marker; the raw secret never leaks
  // in content or structuredContent.
  const { createSecretRedactor } = await import("../src/secretRedaction.js");
  const SECRET = "LEAKTOKEN123456";
  // Build a redactor recognizing WAO_TEST_API_KEY=LEAKTOKEN123456 (same shape the
  // production redactor uses against process.env). We inject this env into the
  // process before the server builds its redactor.
  process.env.WAO_TEST_API_KEY = SECRET;
  try {
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: "/runs",
      getRunDeliveryFn: async () => ({
        runId: "run_x",
        terminalState: "completed",
        deliveryRef: {
          deliveryCommit: "d".repeat(40), baseCommit: "b".repeat(40),
          changedFiles: [`src/${SECRET}.js`, "test/ok.test.js"],
          verification: { status: "passed" },
          acceptance: { status: "pending" },
        },
        verification: { status: "passed" },
        acceptance: { status: "pending" },
      }),
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x" } });
      // The path carrying the secret must NOT appear verbatim anywhere.
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes(SECRET), `raw secret '${SECRET}' must not leak in content or structuredContent`);
      // The affected path must be mapped to the fixed [REDACTED] marker.
      assert.ok(dumped.includes("[REDACTED]"), "secret-bearing path must map to fixed [REDACTED]");
      // The other (clean) path still appears verbatim.
      assert.ok(dumped.includes("test/ok.test.js"), "clean path still exposed");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    delete process.env.WAO_TEST_API_KEY;
  }
});

test("M11-1A-07: run_delivery exposes at most 64 changed paths regardless of service-side limit", async () => {
  // RED on prior HEAD: projectDeliveryChangedPaths accepted an arbitrary limit
  // and could return >64. GREEN: the MCP path always caps at CHANGED_PATHS_LIMIT;
  // changedFileCount still reflects the real total.
  const { CHANGED_PATHS_LIMIT } = await import("../src/application/deliveryReview.js");
  const total = 65;
  const many = Array.from({ length: total }, (_, i) => `src/f${String(i).padStart(3, "0")}.js`).sort();
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => ({
      runId: "run_x",
      terminalState: "completed",
      deliveryRef: {
        deliveryCommit: "d".repeat(40), baseCommit: "b".repeat(40),
        changedFiles: many,
        verification: { status: "passed" },
        acceptance: { status: "pending" },
      },
      verification: { status: "passed" },
      acceptance: { status: "pending" },
    }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x" } });
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.ok(Array.isArray(parsed.changedPaths) && parsed.changedPaths.length <= CHANGED_PATHS_LIMIT,
      `changedPaths must be <= ${CHANGED_PATHS_LIMIT}; got ${parsed.changedPaths?.length}`);
    assert.equal(parsed.changedPaths.length, CHANGED_PATHS_LIMIT, "exactly capped at 64");
    assert.equal(parsed.changedFileCount, total, "real total preserved");
    assert.equal(parsed.changedPathsTruncated, true, "truncated=true");
  } finally { await client.close(); await server.close(); }
});

test("M11-1A-08: run_delivery outputSchema declares changedPaths maxItems=64 + items maxLength=512", async () => {
  const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs" });
  const client = await buildInMemoryClient(server);
  try {
    const tools = await client.listTools();
    const rd = tools.tools.find((t) => t.name === "run_delivery");
    const cp = rd.outputSchema?.properties?.changedPaths;
    assert.ok(cp, "run_delivery outputSchema must declare changedPaths");
    // M11-8C: changedPaths is now nullable (success/failure variant), so it
    // serializes as anyOf:[array, null]. Resolve the array branch.
    const arrBranch = cp.type === "array" ? cp : (cp.anyOf ?? []).find((b) => b.type === "array");
    assert.ok(arrBranch, "changedPaths declares an array branch");
    assert.equal(arrBranch.maxItems, 64, "changedPaths outputSchema maxItems must be 64");
    assert.equal(arrBranch.items?.maxLength, 512, "changedPaths items maxLength must be 512");
    assert.equal(arrBranch.items?.minLength, 1, "changedPaths items minLength must be 1");
  } finally { await client.close(); await server.close(); }
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

test("M9-6B-15: failed verification blocks accept as a STRUCTURED rejection, allows reject", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m96b-15-"));
  try {
    const { runDir, rp } = await setupDeliveryRun(dir, "run_i15", "failed");
    // Accept is refused: a normal structured outcome with the closed-set
    // rejectionReason — NOT an MCP isError (M12-6 3B2a). No decision is recorded.
    {
      const server = createWaoMcpServer({ registryPath: rp, runDir });
      const client = await buildInMemoryClient(server);
      try {
        const res = await client.callTool({ name: "run_delivery_decide", arguments: { runId: "run_i15", decision: "accepted", reason: "x" } });
        assert.equal(res.isError, undefined, "policy rejection is a normal structured outcome");
        const p = JSON.parse(res.content.find((b) => b.type === "text").text);
        assert.equal(p.decisionAccepted, false);
        assert.equal(p.rejectionReason, "verification_failed", "closed-set machine-actionable reason");
        assert.equal(p.deliveryCommit, null, "no delivery commit fabricated on rejection");
        assert.equal(p.acceptanceStatus, null);
        assert.equal(p.existingStatus, null);
        const dumped = JSON.stringify(res);
        assert.ok(!dumped.includes("must be passed"), "no raw reason text leaks");
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
        assert.equal(p.rejectionReason, null);
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
      // M12-6 3B2a: the loser is a normal structured outcome with the closed-set reason.
      for (const p of [p1, p2]) {
        if (p.decisionAccepted) assert.equal(p.rejectionReason, null);
        else assert.equal(p.rejectionReason, "already_decided");
      }
    } finally { await c1.close(); await s1.close(); await c2.close(); await s2.close(); }
    const { readTranscript } = await import("../src/transcript.js");
    const events = await readTranscript(join(runDir, "run_i17.jsonl"));
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted").length, 1, "one event");
  } finally { cleanupDir(dir); }
});

// =====================================================================
// M12-6 Package 3B2a: additive original/effective/reverify projection on
// run_delivery + structured policy rejections on run_delivery_decide.
// =====================================================================

test("M12-6-3B2a-01: run_delivery exposes original/effective/reverify additively; old verificationStatus semantics preserved", async () => {
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => ({
      runId: "run_x",
      terminalState: "completed",
      deliveryRef: {
        deliveryCommit: "d".repeat(40), baseCommit: "b".repeat(40), changedFiles: ["src/a.js"],
        verification: { status: "failed", failureCode: "command_failed" },
        acceptance: { status: "pending" },
      },
      verification: { status: "failed", failureCode: "command_failed" },
      effectiveVerification: { status: "passed" },
      reverify: { status: "complete", reason: "tooling_invalid" },
      acceptance: { status: "pending" },
    }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x" } });
    assert.equal(res.isError, undefined);
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    // Old semantics: verificationStatus stays the ORIGINAL durable outcome.
    assert.equal(parsed.verificationStatus, "failed", "verificationStatus = original (unchanged)");
    assert.equal(parsed.originalVerificationStatus, "failed", "explicit original alias");
    assert.equal(parsed.effectiveVerificationStatus, "passed", "effective = reverify outcome");
    assert.deepEqual(parsed.reverify, { status: "complete", reason: "tooling_invalid" });
    assert.equal(parsed.verificationFailureCode, "command_failed", "failure code still from the original");
  } finally { await client.close(); await server.close(); }
});

test("M12-6-3B2a-02: malformed reverify chain — visible malformed status, effective stays original (never looks passed)", async () => {
  // Application truth: chain malformed → effective falls back to the ORIGINAL status.
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => ({
      runId: "run_x",
      terminalState: "completed",
      deliveryRef: {
        deliveryCommit: "d".repeat(40), baseCommit: "b".repeat(40), changedFiles: ["src/a.js"],
        verification: { status: "failed", failureCode: "command_failed" },
        acceptance: { status: "pending" },
      },
      verification: { status: "failed", failureCode: "command_failed" },
      effectiveVerification: { status: "failed" },
      reverify: { status: "malformed", reason: null },
      acceptance: { status: "pending" },
    }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x" } });
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.equal(parsed.verificationStatus, "failed");
    assert.equal(parsed.effectiveVerificationStatus, "failed", "malformed chain cannot change effective status");
    assert.deepEqual(parsed.reverify, { status: "malformed", reason: null }, "malformed is visible, never hidden");
  } finally { await client.close(); await server.close(); }
});

test("M12-6-3B2a-02b: inconsistent service output (malformed chain but effective passed) collapses to fixed error", async () => {
  // Boundary invariant: a NON-complete reverify chain must never yield an
  // effective status different from the original. The transport rejects a
  // service view that violates it — a malformed chain can never look passed.
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => ({
      runId: "run_x",
      terminalState: "completed",
      deliveryRef: {
        deliveryCommit: "d".repeat(40), baseCommit: "b".repeat(40), changedFiles: ["src/a.js"],
        verification: { status: "failed", failureCode: "command_failed" },
        acceptance: { status: "pending" },
      },
      verification: { status: "failed", failureCode: "command_failed" },
      // Violation: chain malformed but effective claimed "passed".
      effectiveVerification: { status: "passed" },
      reverify: { status: "malformed", reason: null },
      acceptance: { status: "pending" },
    }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x" } });
    assert.equal(res.isError, true, "inconsistent effective/malformed projection must fail closed");
    const dumped = JSON.stringify(res);
    assert.ok(!dumped.includes("passed"), "no fabricated pass leaks");
  } finally { await client.close(); await server.close(); }
});

test("M12-6-3B2a-03: failure / not-requested variants carry null additive verification fields", async () => {
  for (const [label, view] of [
    ["packaging failure", {
      runId: "run_x", terminalState: "failed", deliveryAvailable: false, deliveryRequested: true,
      deliveryFailure: { code: "base_commit_mismatch" },
    }],
    ["not requested", {
      runId: "run_x", terminalState: "completed", deliveryAvailable: false, deliveryRequested: false,
      deliveryFailure: null,
    }],
  ]) {
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs", getRunDeliveryFn: async () => view });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x" } });
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(parsed.originalVerificationStatus, null, `${label}: no original status`);
      assert.equal(parsed.effectiveVerificationStatus, null, `${label}: no effective status`);
      assert.equal(parsed.reverify, null, `${label}: no reverify chain`);
      assert.equal(parsed.verificationStatus, null, `${label}: old field also null`);
    } finally { await client.close(); await server.close(); }
  }
});

// ===== Real-service decision tests: reverify chains + structured rejections =====

/**
 * Build a real transcript: original verification FAILED with an eligible code,
 * then a VALID reverify chain (requested + outcome) via the transcript CAS
 * primitives. Returns the run dir + registry path.
 */
async function setupReverifiedDeliveryRun(dir, runId, reverifyOutcome) {
  const { JsonlTranscript } = await import("../src/transcript.js");
  const runDir = join(dir, "runs");
  const transcript = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId: "test" });
  const ref = {
    schemaVersion: 1, kind: "git_commit", runId,
    baseCommit: "b".repeat(40), deliveryCommit: "d".repeat(40),
    branch: "wao/x", worktreePath: "/fake", changedFiles: ["a.js"],
    verification: { status: "failed", commands: ["echo ok"], verifiedCommit: "d".repeat(40), results: [], failureCode: "command_failed" },
    acceptance: { status: "pending" }, integration: { status: "pending", targetCommit: null },
  };
  await transcript.append("run.started", { delivery: { mode: "git_commit_v1" }, worktreePath: "/fake" });
  await transcript.append("run.delivery_created", { delivery: ref });
  await transcript.append("run.delivery_verification_failed", { delivery: ref });
  await transcript.append("run.state_change", { from: "running", to: "completed", reason: "done" });
  // The Lead-declared reverify chain (valid, via the CAS primitives).
  await transcript.tryAppendReverifyRequested({ delivery: ref, reason: "tooling_invalid", setupCommands: ["fix-env"] });
  const outcomeRef = reverifyOutcome === "passed"
    ? { ...ref, verification: { ...ref.verification, status: "passed" } }
    : { ...ref, verification: { ...ref.verification, status: "failed" } };
  await transcript.tryAppendReverifyOutcome({ delivery: outcomeRef, outcome: reverifyOutcome });
  const rp = join(dir, "agents.json");
  writeFileSync(rp, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
  return { runDir, rp };
}

test("M12-6-3B2a-04: failed original + valid PASSED reverify → run_delivery truthful fields + explicit accept succeeds (first durable decision)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "3b2a-04-"));
  try {
    const { runDir, rp } = await setupReverifiedDeliveryRun(dir, "run_3b2a_04", "passed");
    const server = createWaoMcpServer({ registryPath: rp, runDir });
    const client = await buildInMemoryClient(server);
    try {
      // run_delivery: original failed, effective passed, chain complete.
      const rd = await client.callTool({ name: "run_delivery", arguments: { runId: "run_3b2a_04" } });
      assert.equal(rd.isError, undefined);
      const rdP = JSON.parse(rd.content.find((b) => b.type === "text").text);
      assert.equal(rdP.verificationStatus, "failed");
      assert.equal(rdP.originalVerificationStatus, "failed");
      assert.equal(rdP.effectiveVerificationStatus, "passed");
      assert.deepEqual(rdP.reverify, { status: "complete", reason: "tooling_invalid" });

      // Explicit accept after the passed reverify — must succeed.
      const dc = await client.callTool({
        name: "run_delivery_decide",
        arguments: { runId: "run_3b2a_04", decision: "accepted", reason: "reverify passed" },
      });
      assert.equal(dc.isError, undefined);
      const dcP = JSON.parse(dc.content.find((b) => b.type === "text").text);
      assert.equal(dcP.decisionAccepted, true);
      assert.equal(dcP.acceptanceStatus, "accepted");
      assert.equal(dcP.existingStatus, null);
      assert.equal(dcP.rejectionReason, null);

      // The FIRST durable decision wins: a second, opposite decision is a
      // structured already_decided outcome, never an error.
      const dc2 = await client.callTool({
        name: "run_delivery_decide",
        arguments: { runId: "run_3b2a_04", decision: "rejected", reason: "oops" },
      });
      const dc2P = JSON.parse(dc2.content.find((b) => b.type === "text").text);
      assert.equal(dc2.isError, undefined, "first-wins loser is a normal outcome");
      assert.equal(dc2P.decisionAccepted, false);
      assert.equal(dc2P.existingStatus, "accepted");
      assert.equal(dc2P.rejectionReason, "already_decided");
    } finally { await client.close(); await server.close(); }
    const { readTranscript } = await import("../src/transcript.js");
    const events = await readTranscript(join(runDir, "run_3b2a_04.jsonl"));
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted").length, 1, "one durable decision");
    assert.equal(events.filter((e) => e.type === "run.delivery_rejected").length, 0);
  } finally { cleanupDir(dir); }
});

test("M12-6-3B2a-05: failed reverify outcome → accept returns STRUCTURED verification_failed rejection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "3b2a-05-"));
  try {
    const { runDir, rp } = await setupReverifiedDeliveryRun(dir, "run_3b2a_05", "failed");
    const server = createWaoMcpServer({ registryPath: rp, runDir });
    const client = await buildInMemoryClient(server);
    try {
      const dc = await client.callTool({
        name: "run_delivery_decide",
        arguments: { runId: "run_3b2a_05", decision: "accepted", reason: "x" },
      });
      assert.equal(dc.isError, undefined, "policy rejection is a structured outcome");
      const p = JSON.parse(dc.content.find((b) => b.type === "text").text);
      assert.equal(p.decisionAccepted, false);
      assert.equal(p.rejectionReason, "verification_failed");
      assert.equal(p.deliveryCommit, null);
      const dumped = JSON.stringify(dc);
      assert.ok(!dumped.includes("must be passed"), "no raw gate text leaks");
    } finally { await client.close(); await server.close(); }
    const { readTranscript } = await import("../src/transcript.js");
    const events = await readTranscript(join(runDir, "run_3b2a_05.jsonl"));
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted" || e.type === "run.delivery_rejected").length, 0,
      "rejected decision records nothing");
  } finally { cleanupDir(dir); }
});

test("M12-6-3B2a-06: malformed reverify chain in a real transcript → never passed, structured verification_failed rejection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "3b2a-06-"));
  try {
    const { JsonlTranscript, readTranscript } = await import("../src/transcript.js");
    const runDir = join(dir, "runs");
    const runId = "run_3b2a_06";
    const transcript = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId: "test" });
    const ref = {
      schemaVersion: 1, kind: "git_commit", runId,
      baseCommit: "b".repeat(40), deliveryCommit: "d".repeat(40),
      branch: "wao/x", worktreePath: "/fake", changedFiles: ["a.js"],
      verification: { status: "failed", commands: ["echo ok"], verifiedCommit: "d".repeat(40), results: [], failureCode: "command_failed" },
      acceptance: { status: "pending" }, integration: { status: "pending", targetCommit: null },
    };
    await transcript.append("run.started", { delivery: { mode: "git_commit_v1" }, worktreePath: "/fake" });
    await transcript.append("run.delivery_created", { delivery: ref });
    await transcript.append("run.delivery_verification_failed", { delivery: ref });
    await transcript.append("run.state_change", { from: "running", to: "completed", reason: "done" });
    // A MALFORMED reverify request: unknown reason — a durable conflict.
    await transcript.append("run.delivery_reverification_requested", {
      delivery: ref,
      deliveryCommit: ref.deliveryCommit,
      reason: "INVALID-REASON",
    });
    const rp = join(dir, "agents.json");
    writeFileSync(rp, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");

    const server = createWaoMcpServer({ registryPath: rp, runDir });
    const client = await buildInMemoryClient(server);
    try {
      // run_delivery: the malformed chain is VISIBLE and never looks passed.
      const rd = await client.callTool({ name: "run_delivery", arguments: { runId } });
      const rdP = JSON.parse(rd.content.find((b) => b.type === "text").text);
      assert.equal(rdP.verificationStatus, "failed");
      assert.equal(rdP.originalVerificationStatus, "failed");
      assert.equal(rdP.effectiveVerificationStatus, "failed", "malformed chain cannot look passed");
      assert.deepEqual(rdP.reverify, { status: "malformed", reason: null });

      // Accept stays blocked as a structured verification_failed rejection.
      const dc = await client.callTool({ name: "run_delivery_decide", arguments: { runId, decision: "accepted", reason: "x" } });
      assert.equal(dc.isError, undefined);
      const p = JSON.parse(dc.content.find((b) => b.type === "text").text);
      assert.equal(p.decisionAccepted, false);
      assert.equal(p.rejectionReason, "verification_failed");
      assert.ok(!JSON.stringify(dc).includes("INVALID-REASON"), "no raw reason leak");
    } finally { await client.close(); await server.close(); }
    const events = await readTranscript(join(runDir, `${runId}.jsonl`));
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted" || e.type === "run.delivery_rejected").length, 0);
  } finally { cleanupDir(dir); }
});

test("M12-6-3B2a-07: terminal_not_eligible — passed verification on a non-completed terminal → structured rejection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "3b2a-07-"));
  try {
    const { JsonlTranscript } = await import("../src/transcript.js");
    const runDir = join(dir, "runs");
    const runId = "run_3b2a_07";
    const transcript = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId: "test" });
    const ref = {
      schemaVersion: 1, kind: "git_commit", runId,
      baseCommit: "b".repeat(40), deliveryCommit: "d".repeat(40),
      branch: "wao/x", worktreePath: "/fake", changedFiles: ["a.js"],
      verification: { status: "passed", commands: [], verifiedCommit: "d".repeat(40), results: [] },
      acceptance: { status: "pending" }, integration: { status: "pending", targetCommit: null },
    };
    await transcript.append("run.started", { delivery: { mode: "git_commit_v1" }, worktreePath: "/fake" });
    await transcript.append("run.delivery_created", { delivery: ref });
    await transcript.append("run.delivery_verification_passed", { delivery: ref });
    // NO terminal state_change — the run is still running.
    const rp = join(dir, "agents.json");
    writeFileSync(rp, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");

    const server = createWaoMcpServer({ registryPath: rp, runDir });
    const client = await buildInMemoryClient(server);
    try {
      const dc = await client.callTool({ name: "run_delivery_decide", arguments: { runId, decision: "accepted", reason: "x" } });
      assert.equal(dc.isError, undefined, "policy rejection is a structured outcome");
      const p = JSON.parse(dc.content.find((b) => b.type === "text").text);
      assert.equal(p.decisionAccepted, false);
      assert.equal(p.rejectionReason, "terminal_not_eligible");
      assert.equal(p.deliveryCommit, null);
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

test("M12-6-3B2a-08: delivery_malformed — conflicting durable facts → structured rejection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "3b2a-08-"));
  try {
    const { JsonlTranscript } = await import("../src/transcript.js");
    const runDir = join(dir, "runs");
    const runId = "run_3b2a_08";
    const transcript = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId: "test" });
    const ref = {
      schemaVersion: 1, kind: "git_commit", runId,
      baseCommit: "b".repeat(40), deliveryCommit: "d".repeat(40),
      branch: "wao/x", worktreePath: "/fake", changedFiles: ["a.js"],
      verification: { status: "passed", commands: [], verifiedCommit: "d".repeat(40), results: [] },
      acceptance: { status: "pending" }, integration: { status: "pending", targetCommit: null },
    };
    await transcript.append("run.started", { delivery: { mode: "git_commit_v1" }, worktreePath: "/fake" });
    await transcript.append("run.delivery_created", { delivery: ref });
    // TWO verification outcomes — conflicting durable facts.
    await transcript.append("run.delivery_verification_passed", { delivery: ref });
    await transcript.append("run.delivery_verification_failed", { delivery: ref });
    await transcript.append("run.state_change", { from: "running", to: "completed", reason: "done" });
    const rp = join(dir, "agents.json");
    writeFileSync(rp, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");

    const server = createWaoMcpServer({ registryPath: rp, runDir });
    const client = await buildInMemoryClient(server);
    try {
      const dc = await client.callTool({ name: "run_delivery_decide", arguments: { runId, decision: "accepted", reason: "x" } });
      assert.equal(dc.isError, undefined, "policy rejection is a structured outcome");
      const p = JSON.parse(dc.content.find((b) => b.type === "text").text);
      assert.equal(p.decisionAccepted, false);
      assert.equal(p.rejectionReason, "delivery_malformed");
      const dumped = JSON.stringify(dc);
      assert.ok(!dumped.includes("exactly one required"), "no raw validator text leaks");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

test("M12-6-3B2a-09: delivery_unavailable — no committed delivery → structured rejection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "3b2a-09-"));
  try {
    const { JsonlTranscript } = await import("../src/transcript.js");
    const runDir = join(dir, "runs");
    const runId = "run_3b2a_09";
    const transcript = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId: "test" });
    await transcript.append("run.started", { backend: "claude-code" });
    await transcript.append("run.state_change", { from: "running", to: "completed", reason: "done" });
    const rp = join(dir, "agents.json");
    writeFileSync(rp, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");

    const server = createWaoMcpServer({ registryPath: rp, runDir });
    const client = await buildInMemoryClient(server);
    try {
      const dc = await client.callTool({ name: "run_delivery_decide", arguments: { runId, decision: "accepted", reason: "x" } });
      assert.equal(dc.isError, undefined, "policy rejection is a structured outcome");
      const p = JSON.parse(dc.content.find((b) => b.type === "text").text);
      assert.equal(p.decisionAccepted, false);
      assert.equal(p.rejectionReason, "delivery_unavailable");
      const dumped = JSON.stringify(dc);
      assert.ok(!dumped.includes("run.delivery_created"), "no raw event names leak");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

test("M12-9-MCP-01: transport classification is TYPE-gated — plain Errors and unknown codes stay fixed MCP errors", async () => {
  const { DeliveryDecisionPolicyError } = await import("../src/transcript.js");
  const runId = "run_m12_9";
  // 1. A plain Error carrying the EXACT old gate sentence must NOT classify:
  //    the machine protocol is the typed code, never message text.
  {
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: "/runs",
      decideRunDeliveryFn: async () => {
        throw new Error("Cannot accept: delivery verification is failed, must be passed");
      },
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_delivery_decide", arguments: { runId, decision: "accepted", reason: "x" } });
      assert.equal(res.isError, true, "plain Error with an old sentence stays the fixed MCP error");
      assert.ok(!JSON.stringify(res).includes("rejectionReason"), "no structured rejection for a plain Error");
      assert.ok(!JSON.stringify(res).includes("must be passed"), "no raw gate text leaks");
    } finally { await client.close(); await server.close(); }
  }
  // 2. The DEDICATED type with an ARBITRARY message → structured rejection with
  //    the code; the human wording is irrelevant to classification.
  {
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: "/runs",
      decideRunDeliveryFn: async () => {
        throw new DeliveryDecisionPolicyError("verification_failed", "completely different human wording");
      },
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_delivery_decide", arguments: { runId, decision: "accepted", reason: "x" } });
      assert.equal(res.isError, undefined, "typed policy rejection is a structured outcome");
      const p = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(p.decisionAccepted, false);
      assert.equal(p.rejectionReason, "verification_failed", "code survives arbitrary message wording");
      assert.equal(p.deliveryCommit, null);
      assert.ok(!JSON.stringify(res).includes("completely different human wording"), "no raw message leak");
    } finally { await client.close(); await server.close(); }
  }
  // 3. Unknown code on the dedicated type fails closed → fixed MCP error.
  {
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: "/runs",
      decideRunDeliveryFn: async () => {
        throw new DeliveryDecisionPolicyError("not_a_real_code", "x");
      },
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_delivery_decide", arguments: { runId, decision: "accepted", reason: "x" } });
      assert.equal(res.isError, true, "unknown code fails closed");
    } finally { await client.close(); await server.close(); }
  }
  // 4. already_decided stays a NORMAL OUTCOME (accepted:false/existing) — it is
  //    never expressed through the exception type.
  {
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: "/runs",
      decideRunDeliveryFn: async () => ({
        accepted: false,
        existing: { type: "run.delivery_accepted", status: "accepted", deliveryCommit: "d".repeat(40) },
      }),
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_delivery_decide", arguments: { runId, decision: "accepted", reason: "x" } });
      assert.equal(res.isError, undefined, "already_decided is a normal structured outcome");
      const p = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(p.decisionAccepted, false);
      assert.equal(p.existingStatus, "accepted");
      assert.equal(p.rejectionReason, "already_decided");
    } finally { await client.close(); await server.close(); }
  }
});
