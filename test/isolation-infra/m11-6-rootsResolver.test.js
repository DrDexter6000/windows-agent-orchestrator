// test/isolation-infra/m11-6-rootsResolver.test.js
//
// M11-6 CTO closeout B: causal resolver-behavior tests.
//
// 批 119（v0.10.0）起，绑定解析只剩两档（MCP roots → 启动配置 → 未绑定），
// 会话级选择档已随其工具真删除；绑定事实经 `lead_preflight` 的 `workspace`
// 节观测（source/workspaceRoot/unboundReason）。本文件用 PRODUCTION resolver
// （resolveWorkspaceBinding，经 lead_preflight 触达）+ spy on
// mcp.server.listRoots 断言精确调用计数与回退因果：
//   1. client without roots capability → listRoots NOT called, server_config used.
//   2. client with one valid root → source=mcp_root, wins over server_config.
//   3. client with roots but listRoots throws → falls back to server_config.
//   4. (batch 119) expectedWorkspaceRoot given → source=call_target, listRoots
//      NOT called, and the call_target wins over every default authority.
//   5. (M12-19 recovery truth) server_config root fails proof →
//      unboundReason=server_config_git_proof_failed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { createWaoMcpServer } from "../../src/mcp/server.js";

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

// 批 119：绑定事实经 lead_preflight.workspace 观测（不带参数 = 走缺省解析）。
async function binding(client) {
  const res = await client.callTool({ name: "lead_preflight", arguments: {} });
  return JSON.parse(res.content.find((b) => b.type === "text").text).workspace;
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
        const parsed = await binding(client);
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
        const parsed = await binding(client);
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
        const parsed = await binding(client);
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

// ===== 4. (batch 119) expectedWorkspaceRoot wins over every default authority =====

test("M11-6-CAUSE-4: expectedWorkspaceRoot given → source=call_target, listRoots NOT called", async () => {
  const dirTarget = mkdtempSync(join(tmpdir(), "wao-m116-c4-target-"));
  const dirRoot = mkdtempSync(join(tmpdir(), "wao-m116-c4-root-"));
  const dirCfg = mkdtempSync(join(tmpdir(), "wao-m116-c4-cfg-"));
  try {
    makeGitRepo(dirTarget);
    makeGitRepo(dirRoot);
    makeGitRepo(dirCfg);
    const { pathToFileURL } = await import("node:url");
    const { ListRootsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    // Both default authorities are valid but point elsewhere; the call target wins.
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs", workspaceRoot: dirCfg });
    const spy = spyListRoots(server);
    try {
      const client = await buildInMemoryClient(server, { roots: { listChanged: false } });
      try {
        client.setRequestHandler(ListRootsRequestSchema, async () => ({
          roots: [{ uri: pathToFileURL(dirRoot).href, name: "root" }],
        }));
        const res = await client.callTool({
          name: "lead_preflight",
          arguments: { expectedWorkspaceRoot: dirTarget },
        });
        const payload = JSON.parse(res.content.find((b) => b.type === "text").text);
        assert.equal(payload.workspace.bound, true);
        assert.equal(payload.workspace.source, "call_target", "per-call target wins over roots + server_config");
        assert.equal(payload.workspace.workspaceRoot.replace(/\\/g, "/"), dirTarget.replace(/\\/g, "/"));
        assert.equal(spy.count(), 0, "listRoots NOT consulted when the call target is given");
      } finally {
        await client.close();
      }
    } finally {
      spy.restore();
      await server.close();
    }
  } finally {
    cleanupDir(dirTarget); cleanupDir(dirRoot); cleanupDir(dirCfg);
  }
});

// ===== 5. (M12-19) recovery truth in the resolver =====

// M12-19-CAUSE-5: server_config root whose Git proof fails (not a repo) →
// unboundReason=server_config_git_proof_failed (distinct from no_workspace_authority).
test("M11-6-M12-19-CAUSE-5: server_config root fails proof → unboundReason=server_config_git_proof_failed", async () => {
  const notGit = mkdtempSync(join(tmpdir(), "wao-m116-m1219-c5-nogit-"));
  try {
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs", workspaceRoot: notGit });
    const spy = spyListRoots(server);
    try {
      // Client WITHOUT roots capability: server_config is the only authority.
      const client = await buildInMemoryClient(server, {});
      try {
        const parsed = await binding(client);
        assert.equal(parsed.bound, false);
        assert.equal(parsed.unboundReason, "server_config_git_proof_failed");
        assert.equal(parsed.source, null);
        assert.equal(spy.count(), 0, "listRoots NOT called (no roots capability)");
      } finally {
        await client.close();
      }
    } finally {
      spy.restore();
      await server.close();
    }
  } finally {
    cleanupDir(notGit);
  }
});
