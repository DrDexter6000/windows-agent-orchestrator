// test/mcpRunDeliveryRepackage.test.js
//
// M12-1S2: run_delivery_repackage MCP adapter — safe projection of the
// model-free delivery repackage application service over the MCP protocol.
//
// Coverage:
//   - tool discovery (current tool count, run_delivery_repackage present) + annotations
//   - strict input (extra keys / non-string allowedPaths / empty array / missing
//     runId rejected BEFORE the service is called)
//   - workspace-bound authorization (no binding → service never called)
//   - safe bounded output on success (no worktreePath / commands / stderr leak)
//   - fixed error on service throw; no structuredContent on error
//   - malicious / malformed service-output attack matrix collapses to fixed error
//   - the adapter passes the bound authorizedWorkspaceRoot to the service

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { createWaoMcpServer } from "../src/mcp/server.js";

// ===== Helpers =====

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-test-m12s2", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

/** A temp dir that is a real git repo so proveWorkspace accepts it as bound. */
function makeGitDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "t@t"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "t"', { cwd: dir, stdio: "ignore" });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.js"), "1\n");
  execSync("git add . && git commit -m init", { cwd: dir, stdio: "ignore" });
  return dir;
}

const GOOD_COMMIT = "d".repeat(40);

/** A well-formed service result the handler must accept. */
function goodServiceResult(runId) {
  return {
    runId,
    deliveryCommit: GOOD_COMMIT,
    verificationStatus: "passed",
    source: "packaged",
    created: true,
    verificationRecorded: true,
    recoveryKind: "disallowed_scope",
  };
}

/** Build a server whose injected service records every call + args. */
function makeServer({ dir, serviceResult, serviceThrow, workspaceRoot = dir }) {
  const calls = [];
  const fake = async (args) => {
    calls.push(args);
    if (serviceThrow) throw new Error(serviceThrow);
    return typeof serviceResult === "function" ? serviceResult(args) : serviceResult;
  };
  const server = createWaoMcpServer({
    registryPath: join(dir, "agents.json"),
    runDir: dir,
    workspaceRoot,
    getRunDeliveryRepackageFn: fake,
  });
  return { server, calls };
}

// =====================================================================
// Group 1: tool discovery + count + annotations
// =====================================================================

test("M12-1S2-M1: run_delivery_repackage registered; total tools = 17; destructive + idempotent", async () => {
  const dir = makeGitDir("m12s2-m1-");
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    const { server } = makeServer({ dir, serviceResult: goodServiceResult("run_x") });
    const client = await buildInMemoryClient(server);
    try {
      const { tools } = await client.listTools();
      const t = tools.find((x) => x.name === "run_delivery_repackage");
      assert.ok(t, "run_delivery_repackage present");
      assert.equal(tools.length, 19, "exactly 19 tools after M12-3B");
      // Packaging moves a branch + appends transcript events: destructive, but
      // reentrant/crash-safe so idempotent in outcome.
      assert.equal(t.annotations.destructiveHint, true);
      assert.equal(t.annotations.idempotentHint, true);
      assert.equal(t.annotations.readOnlyHint, false);
      assert.equal(t.annotations.openWorldHint, false);
      // Strict input: only runId + allowedPaths.
      assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ["allowedPaths", "runId"]);
      assert.equal(t.inputSchema.additionalProperties, false);
      assert.equal(t.inputSchema.properties.allowedPaths.maxItems, 256);
      assert.equal(t.inputSchema.properties.allowedPaths.items.maxLength, 512);
      assert.ok(t.outputSchema, "output schema present");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Group 2: strict input — service never called for malformed input
// =====================================================================

test("M12-1S2-M2: extra key / bad allowedPaths / missing fields rejected before service", async () => {
  const dir = makeGitDir("m12s2-m2-");
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    const { server, calls } = makeServer({ dir, serviceResult: goodServiceResult("run_x") });
    const client = await buildInMemoryClient(server);
    try {
      const cases = [
        { args: { runId: "run_x", allowedPaths: ["src"], unexpected: 1 }, label: "extra key" },
        { args: { runId: "run_x", allowedPaths: "src" }, label: "allowedPaths not array" },
        { args: { runId: "run_x", allowedPaths: [] }, label: "empty allowedPaths" },
        { args: { runId: "run_x", allowedPaths: ["src", 7] }, label: "non-string entry" },
        { args: { runId: "run_x", allowedPaths: ["src", ""] }, label: "empty-string entry" },
        { args: { runId: "run_x", allowedPaths: Array.from({ length: 257 }, (_, i) => `src/${i}`) }, label: "too many entries" },
        { args: { runId: "run_x", allowedPaths: ["x".repeat(513)] }, label: "overlong entry" },
        { args: { allowedPaths: ["src"] }, label: "missing runId" },
        { args: { runId: "run_x" }, label: "missing allowedPaths" },
      ];
      for (const { args, label } of cases) {
        const r = await client.callTool({ name: "run_delivery_repackage", arguments: args }).catch(() => ({ isError: true }));
        assert.equal(r.isError, true, `${label} → error`);
      }
      assert.equal(calls.length, 0, "service never called for malformed input");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Group 3: workspace-bound authorization
// =====================================================================

test("M12-1S2-M3: unbound workspace → service never called, fixed error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m12s2-m3-"));
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    // No workspaceRoot, no roots capability → unbound.
    const { server, calls } = makeServer({ dir, serviceResult: goodServiceResult("run_x"), workspaceRoot: undefined });
    const client = await buildInMemoryClient(server);
    try {
      const r = await client.callTool({ name: "run_delivery_repackage", arguments: { runId: "run_x", allowedPaths: ["src"] } });
      assert.equal(r.isError, true);
      assert.equal(calls.length, 0, "service never called when unbound");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Group 4: safe bounded output on success; authorizedWorkspaceRoot threaded
// =====================================================================

test("M12-1S2-M4: bound success → bounded structured output; authorizedWorkspaceRoot passed", async () => {
  const dir = makeGitDir("m12s2-m4-");
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    const { server, calls } = makeServer({ dir, serviceResult: goodServiceResult("run_m4") });
    const client = await buildInMemoryClient(server);
    try {
      const r = await client.callTool({ name: "run_delivery_repackage", arguments: { runId: "run_m4", allowedPaths: ["src", "root.txt"] } });
      assert.equal(r.isError, undefined, "success");
      const sc = r.structuredContent;
      // Bounded field set — no worktreePath / commands / stderr / reason leak.
      assert.deepEqual(
        Object.keys(sc).sort(),
        ["created", "deliveryCommit", "recoveryKind", "runId", "source", "verificationStatus"],
      );
      assert.equal(sc.runId, "run_m4");
      assert.match(sc.deliveryCommit, /^[0-9a-f]{40}$/, "canonical commit only");
      assert.equal(sc.verificationStatus, "passed");
      assert.equal(sc.source, "packaged");
      assert.equal(sc.created, true);
      assert.equal(sc.recoveryKind, "disallowed_scope");
      // The bound workspace root was threaded into the service call (canonical
      // forward-slash form from proveWorkspace — compare normalized, not raw dir).
      assert.equal(calls.length, 1);
      assert.equal(
        calls[0].authorizedWorkspaceRoot.replace(/\\/g, "/"),
        dir.replace(/\\/g, "/"),
      );
      assert.equal(calls[0].runId, "run_m4");
      assert.deepEqual(calls[0].allowedPaths, ["src", "root.txt"]);
      // No leaked absolute worktree path / commands anywhere in the text content.
      const text = JSON.stringify(r.content);
      assert.ok(!/worktreePath|commands|stderr/i.test(text), "no worktree/commands/stderr leak");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Group 5: service throw → fixed error, no structuredContent, no leak
// =====================================================================

test("M12-1S2-M5: service throw → fixed text, no structuredContent, no leak", async () => {
  const dir = makeGitDir("m12s2-m5-");
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    const { server } = makeServer({ dir, serviceThrow: "boom: C:\\Users\\owner\\secret leak <script>" });
    const client = await buildInMemoryClient(server);
    try {
      const r = await client.callTool({ name: "run_delivery_repackage", arguments: { runId: "run_m5", allowedPaths: ["src"] } });
      assert.equal(r.isError, true);
      assert.equal(r.structuredContent, undefined, "no structuredContent on error");
      const text = r.content[0].text;
      assert.equal(text, "run_delivery_repackage failed", "fixed error text");
      // The dynamic exception message must NOT be concatenated.
      assert.ok(!text.includes("boom") && !text.includes("secret") && !text.includes("script"));
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Group 6: malformed service-output attack matrix → fixed error
// =====================================================================

test("M12-1S2-M6: malformed service output collapses to fixed error (no leak)", async () => {
  const dir = makeGitDir("m12s2-m6-");
  try {
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    const runId = "run_m6";
    const matrix = [
      { label: "non-canonical deliveryCommit", result: { ...goodServiceResult(runId), deliveryCommit: "HEAD" } },
      { label: "bad verificationStatus", result: { ...goodServiceResult(runId), verificationStatus: "maybe" } },
      { label: "bad source", result: { ...goodServiceResult(runId), source: "inferred" } },
      { label: "created not boolean", result: { ...goodServiceResult(runId), created: "yes" } },
      { label: "runId mismatch", result: { ...goodServiceResult("other"), deliveryCommit: GOOD_COMMIT } },
      { label: "missing deliveryCommit", result: { runId, verificationStatus: "passed", source: "packaged", created: true } },
    ];
    for (const { label, result } of matrix) {
      const { server } = makeServer({ dir, serviceResult: result });
      const client = await buildInMemoryClient(server);
      try {
        const r = await client.callTool({ name: "run_delivery_repackage", arguments: { runId, allowedPaths: ["src"] } });
        assert.equal(r.isError, true, `${label} → error`);
        assert.equal(r.structuredContent, undefined, `${label} → no structuredContent`);
        assert.equal(r.content[0].text, "run_delivery_repackage failed", `${label} → fixed text`);
      } finally {
        await client.close();
        await server.close();
      }
    }
  } finally {
    cleanupDir(dir);
  }
});
