// test/m11-6-rootsResolver.test.js
//
// M11-6 CTO closeout B: causal resolver-behavior tests.
//
// Proves the four resolver cases by running the PRODUCTION resolver
// (resolveWorkspaceBinding, reached via workspace_status) with a spy on
// mcp.server.listRoots to assert exact call counts and fallback causality:
//   1. client without roots capability → listRoots NOT called, server_config used.
//   2. client with one valid root → source=mcp_root, wins over server_config.
//   3. client with roots but listRoots throws → falls back to server_config.
//   4. lead_session already selected → listRoots NOT called, source=lead_session.
//   5. failed workspace_select keeps the prior valid selection.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { createWaoMcpServer } from "../src/mcp/server.js";

// ===== Helpers =====

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function makeGitRepo(dir) {
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

async function buildInMemoryClient(server, clientCapabilities = {}) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client(
    { name: "wao-test-client", version: "0.0.1" },
    { capabilities: clientCapabilities },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// Spy on mcp.server.listRoots: wraps the original, counts calls.
function spyListRoots(server) {
  const inner = server.server; // the McpServer wraps a Server at .server
  const original = inner.listRoots.bind(inner);
  let callCount = 0;
  let lastOptions = null;
  inner.listRoots = (params, options) => {
    callCount += 1;
    lastOptions = options;
    return original(params, options);
  };
  return {
    count: () => callCount,
    lastOptions: () => lastOptions,
    restore: () => { inner.listRoots = original; },
  };
}

async function status(client) {
  const res = await client.callTool({ name: "workspace_status", arguments: {} });
  return JSON.parse(res.content.find((b) => b.type === "text").text);
}

// ===== 1. client without roots capability → listRoots NOT called, server_config used =====

test("M11-6-CAUSE-1: no roots capability → listRoots callCount=0, server_config used", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m116-c1-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs", workspaceRoot: dir });
    const spy = spyListRoots(server);
    try {
      // Client with NO roots capability.
      const client = await buildInMemoryClient(server, {});
      try {
        const parsed = await status(client);
        assert.equal(parsed.bound, true);
        assert.equal(parsed.source, "server_config");
        assert.equal(spy.count(), 0, "listRoots NOT called when client has no roots capability");
      } finally {
        await client.close();
      }
    } finally {
      spy.restore();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ===== 2. client with one valid root → source=mcp_root, wins over server_config =====

test("M11-6-CAUSE-2: one valid root → source=mcp_root (wins over server_config)", async () => {
  const dirRoot = mkdtempSync(join(tmpdir(), "wao-m116-c2-root-"));
  const dirCfg = mkdtempSync(join(tmpdir(), "wao-m116-c2-cfg-"));
  try {
    makeGitRepo(dirRoot);
    makeGitRepo(dirCfg);
    const { pathToFileURL } = await import("node:url");
    const { ListRootsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    // server_config points to dirCfg; the client root points to dirRoot.
    // mcp_root must win.
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs", workspaceRoot: dirCfg });
    const spy = spyListRoots(server);
    try {
      const client = await buildInMemoryClient(server, { roots: { listChanged: false } });
      try {
        client.setRequestHandler(ListRootsRequestSchema, async () => ({
          roots: [{ uri: pathToFileURL(dirRoot).href, name: "root" }],
        }));
        const parsed = await status(client);
        assert.equal(parsed.bound, true);
        assert.equal(parsed.source, "mcp_root", "mcp_root wins over server_config");
        assert.equal(parsed.workspaceRoot.replace(/\\/g, "/"), dirRoot.replace(/\\/g, "/"));
        assert.ok(spy.count() >= 1, "listRoots was called");
      } finally {
        await client.close();
      }
    } finally {
      spy.restore();
      await server.close();
    }
  } finally {
    cleanupDir(dirRoot); cleanupDir(dirCfg);
  }
});

// ===== 3. client with roots but listRoots throws → falls back to server_config =====

test("M11-6-CAUSE-3: roots declared but listRoots throws → fallback to server_config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m116-c3-"));
  try {
    makeGitRepo(dir);
    const { ListRootsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs", workspaceRoot: dir });
    const spy = spyListRoots(server);
    try {
      const client = await buildInMemoryClient(server, { roots: { listChanged: false } });
      try {
        // Client handler rejects (simulates a failed/timed-out roots/list).
        client.setRequestHandler(ListRootsRequestSchema, async () => {
          throw new Error("simulated roots/list failure");
        });
        const parsed = await status(client);
        assert.equal(parsed.bound, true);
        assert.equal(parsed.source, "server_config", "falls back to server_config on roots failure");
        assert.equal(parsed.workspaceRoot.replace(/\\/g, "/"), dir.replace(/\\/g, "/"));
        // The call carried the SDK native timeout options.
        const opts = spy.lastOptions();
        assert.equal(opts?.timeout, 5000, "listRoots called with timeout=5000");
        assert.equal(opts?.maxTotalTimeout, 5000, "listRoots called with maxTotalTimeout=5000");
      } finally {
        await client.close();
      }
    } finally {
      spy.restore();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ===== 4. lead_session selected → listRoots NOT called, source=lead_session =====

test("M11-6-CAUSE-4: lead_session selected → listRoots callCount=0, source=lead_session", async () => {
  const dirSession = mkdtempSync(join(tmpdir(), "wao-m116-c4-sess-"));
  const dirCfg = mkdtempSync(join(tmpdir(), "wao-m116-c4-cfg-"));
  try {
    makeGitRepo(dirSession);
    makeGitRepo(dirCfg);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs", workspaceRoot: dirCfg });
    const spy = spyListRoots(server);
    try {
      const client = await buildInMemoryClient(server, { roots: { listChanged: false } });
      try {
        // Select a session workspace first.
        const sel = await client.callTool({ name: "workspace_select", arguments: { workspaceRoot: dirSession } });
        assert.equal(JSON.parse(sel.content.find((b) => b.type === "text").text).source, "lead_session");
        // Reset spy count after the select (select does not call listRoots, but be precise).
        const countAfterSelect = spy.count();
        const parsed = await status(client);
        assert.equal(parsed.bound, true);
        assert.equal(parsed.source, "lead_session", "lead_session used, not mcp_root/server_config");
        assert.equal(parsed.workspaceRoot.replace(/\\/g, "/"), dirSession.replace(/\\/g, "/"));
        assert.equal(spy.count(), countAfterSelect, "listRoots NOT called when lead_session is selected");
      } finally {
        await client.close();
      }
    } finally {
      spy.restore();
      await server.close();
    }
  } finally {
    cleanupDir(dirSession); cleanupDir(dirCfg);
  }
});

// ===== 5. failed workspace_select keeps the prior valid selection =====

test("M11-6-CAUSE-5: failed workspace_select keeps the prior valid selection", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "wao-m116-c5-a-"));
  const notGit = mkdtempSync(join(tmpdir(), "wao-m116-c5-nogit-"));
  try {
    makeGitRepo(dirA);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs" });
    try {
      const client = await buildInMemoryClient(server, {});
      try {
        await client.callTool({ name: "workspace_select", arguments: { workspaceRoot: dirA } });
        const before = await status(client);
        assert.equal(before.source, "lead_session");
        // Attempt a bad select.
        const bad = await client.callTool({ name: "workspace_select", arguments: { workspaceRoot: notGit } });
        assert.ok(bad.isError, "bad select errors");
        // Prior selection intact.
        const after = await status(client);
        assert.equal(after.source, "lead_session");
        assert.equal(after.workspaceRoot.replace(/\\/g, "/"), dirA.replace(/\\/g, "/"));
      } finally {
        await client.close();
      }
    } finally {
      await server.close();
    }
  } finally {
    cleanupDir(dirA); cleanupDir(notGit);
  }
});
