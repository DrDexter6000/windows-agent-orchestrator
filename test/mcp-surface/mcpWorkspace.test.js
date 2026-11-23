// test/mcpWorkspace.test.js
//
// M10-pre2 Batch B: MCP workspace binding, roots, stdio fallback, dispatch integration.
//
// Tests:
// 1. Explicit --workspace-root priority over client roots
// 2. No explicit config + exactly one valid MCP file root → bound
// 3. Zero/multiple/non-file/malformed/unsupported roots → fixed safe failure
// 4. lead_preflight.workspace returns accurate source/head/dirty/root, zero path leak
// 5. (batch 119) the removed binding/select tools are off the surface
// 6. run_dispatch passes canonical root as cwd to dispatcher
// 7. Registry agent cwd is overridden by MCP server-owned binding
// 8. Workspace resolve/proof failure → dispatcher=0, transcript=0, fork=0
// 9. Tool input cwd/workspaceRoot/rootUri/path fields all rejected by strict schema
// 10. CLI --cwd and text/JSON output unchanged (regression guard — checked via existing tests)
// 11. stdio --workspace-root with spaces works; empty/relative/missing/duplicate rejected
// 12. Fixed stderr/MCP error does not leak absolute path or raw exception
// 13. No-model real stdio smoke (moved to mcpWorkspaceSmoke.test.js)
// 14. At least one real SDK client/server integration test for MCP roots
//
// 批 119（v0.10.0）：MCP workspace_status / workspace_select 已真删除——本文件的
// 绑定观察全部改经 lead_preflight 的 workspace 节（不带参数 = 走缺省解析）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { createWaoMcpServer } from "../../src/mcp/server.js";
import { readTranscript, findState, findLatest } from "../../src/transcript.js";

// ===== Helpers =====

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const SHIM = join(REPO_ROOT, "scripts", "wao-node.cjs");
const STDIO_ENTRY = join(REPO_ROOT, "src", "mcp", "stdio.js");

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function makeRegistry(dir, agents) {
  const p = join(dir, "agents.json");
  writeFileSync(p, JSON.stringify({ agents }), "utf8");
  return p;
}

function makeSummary(runDir, workers) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({ workers }), "utf8");
  return runDir;
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

// ===== 4. lead_preflight.workspace returns accurate source/head/dirty/root =====

// 批 119：绑定观察经 lead_preflight.workspace（不带参数 = 缺省解析）。
async function binding(client, args = {}) {
  const res = await client.callTool({ name: "lead_preflight", arguments: args });
  return JSON.parse(res.content.find((b) => b.type === "text").text).workspace;
}

test("WSB-04: lead_preflight.workspace returns bound=true, source, gitHead, dirty, workspaceRoot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wsb-04-"));
  try {
    const head = makeGitRepo(dir);
    const server = createWaoMcpServer({
      registryPath: "/r.json",
      runDir: "/runs",
      workspaceRoot: dir,
    });
    const client = await buildInMemoryClient(server);
    try {
      const parsed = await binding(client);
      assert.equal(parsed.bound, true);
      assert.equal(parsed.source, "server_config");
      assert.equal(parsed.gitHead, head);
      assert.equal(parsed.dirty, false);
      // 批 119：workspaceRoot 在 preflight.workspace 返回（Lead/host 已显式提交
      // 并经证明的根，非凭据）。必须是 canonical root。
      assert.equal(parsed.workspaceRoot.replace(/\\/g, "/"), dir.replace(/\\/g, "/"),
        "workspaceRoot is the canonical Git root");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ===== 5. unbound contract (no workspace → bound=false) =====

test("WSB-05: lead_preflight with no workspace bound → workspace.bound=false, fields null", async () => {
  const server = createWaoMcpServer({
    registryPath: "/r.json",
    runDir: "/runs",
    // no workspaceRoot, and no roots capability on client
  });
  const client = await buildInMemoryClient(server);
  try {
    const parsed = await binding(client);
    assert.equal(parsed.bound, false);
    assert.equal(parsed.source, null);
    assert.equal(parsed.workspaceRoot, null);
    assert.equal(parsed.gitHead, null);
    assert.equal(parsed.dirty, null);
    assert.equal(parsed.unboundReason, "no_workspace_authority");
  } finally {
    await client.close();
    await server.close();
  }
});

// ===== 6. run_dispatch passes canonical root as cwd to dispatcher =====

test("WSB-06: run_dispatch passes canonical root as cwd to dispatcher", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wsb-06-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { x: { backend: "claude-code", cwd: dir } });
    let captured = null;
    let callCount = 0;
    const fakeDispatch = async (input) => {
      callCount += 1;
      captured = input;
      return { accepted: true, runId: "run_wsb06", state: "pending" };
    };
    const server = createWaoMcpServer({
      registryPath,
      runDir: "/runs",
      workspaceRoot: dir,
      dispatchRunFn: fakeDispatch,
    });
    const client = await buildInMemoryClient(server);
    try {
      // the dispatch target comes from THIS call — pass the project root;
      // the server_config binding below must NOT be the cwd source (it may differ).
      await client.callTool({ name: "run_dispatch", arguments: { agentId: "x", prompt: "y", expectedWorkspaceRoot: dir } });
      assert.equal(callCount, 1);
      assert.ok(captured.cwd, "dispatcher received cwd");
      // cwd must be the canonical root (forward-slash normalized)
      assert.equal(captured.cwd, dir.replace(/\\/g, "/"));
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ===== 8. Workspace resolve/proof failure → dispatcher=0, transcript=0, fork=0 =====

test("WSB-08: run_dispatch with unbound workspace → dispatcher=0, safe error", async () => {
  let callCount = 0;
  const fakeDispatch = async () => { callCount += 1; return { accepted: true, runId: "x", state: "pending" }; };
  const server = createWaoMcpServer({
    registryPath: "/r.json",
    runDir: "/runs",
    // no workspaceRoot, no roots
    dispatchRunFn: fakeDispatch,
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_dispatch", arguments: { agentId: "x", prompt: "y" } });
    assert.equal(callCount, 0, "dispatcher must not be called");
    // Must be an error result
    assert.equal(res.isError, true);
    const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
    assert.ok(/workspace|bound/i.test(text), "error mentions workspace");
  } finally {
    await client.close();
    await server.close();
  }
});

// ===== 9. Tool input cwd/workspaceRoot/rootUri/path fields all rejected =====

test("WSB-09: run_dispatch strict schema rejects cwd/workspaceRoot/rootUri/path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wsb-09-"));
  try {
    makeGitRepo(dir);
    let callCount = 0;
    const fakeDispatch = async () => { callCount += 1; return { accepted: true, runId: "x", state: "pending" }; };
    const server = createWaoMcpServer({
      registryPath: "/r.json",
      runDir: "/runs",
      workspaceRoot: dir,
      dispatchRunFn: fakeDispatch,
    });
    const client = await buildInMemoryClient(server);
    try {
      const badArgs = [
        { agentId: "x", prompt: "y", cwd: "/evil" },
        { agentId: "x", prompt: "y", workspaceRoot: "/evil" },
        { agentId: "x", prompt: "y", rootUri: "file:///evil" },
        { agentId: "x", prompt: "y", path: "/evil" },
        { agentId: "x", prompt: "y", workspacePath: "/evil" },
      ];
      for (const bad of badArgs) {
        let rejected = false;
        try {
          const res = await client.callTool({ name: "run_dispatch", arguments: bad });
          if (res.isError) rejected = true;
        } catch {
          rejected = true;
        }
        assert.ok(rejected, `must reject: ${JSON.stringify(Object.keys(bad))}`);
      }
      assert.equal(callCount, 0, "dispatcher never called");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ===== 1. (batch 119) the removed binding tools are off the surface; preflight input is strict =====

test("WSB-01: removed binding tools absent; lead_preflight input is strict (target + 0129 options)", async () => {
  const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs" });
  const client = await buildInMemoryClient(server);
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    for (const removed of ["workspace_status", "workspace_select", "run_wait"]) {
      assert.ok(!names.includes(removed), `${removed} must NOT be on the surface (v0.10.0)`);
    }
    // 决定 0129：三个只读工具并入幸存者后删除，不得回到工具面；预检工具保留。
    for (const removed of ["registry_list", "runs_list", "run_delivery_review_bundle"]) {
      assert.ok(!names.includes(removed), `${removed} must NOT be on the surface (decision 0129 fold-in)`);
    }
    // 决定 0129 会审修正：run_dispatch_contract_check 保留（check-only 无等价物）。
    assert.ok(names.includes("run_dispatch_contract_check"), "run_dispatch_contract_check stays on the surface (decision 0129)");
    const pre = tools.tools.find((t) => t.name === "lead_preflight");
    assert.ok(pre, "lead_preflight tool exists");
    const inputKeys = Object.keys(pre.inputSchema.properties ?? {}).sort();
    // 决定 0129：输入在 expectedWorkspaceRoot 之外新增可选 detail / recentRuns。
    assert.deepEqual(inputKeys, ["detail", "expectedWorkspaceRoot", "recentRuns"], "input schema is the optional per-call target + the two 0129 options");
    // 决定 0129（会审修正）：recentRuns 补齐原 runs_list 的两种查询——limit 1..100
    // 与 activeOnly（先筛活动再截断）。上限来自应用层 SSOT，不另写一份数字。
    const recent = pre.inputSchema.properties.recentRuns;
    assert.equal(recent.properties.limit.maximum, 100, "recentRuns.limit max = 100 (runs_list parity)");
    assert.equal(recent.properties.activeOnly.type, "boolean", "recentRuns.activeOnly is a boolean");
    assert.equal(recent.additionalProperties, false, "recentRuns strict");
    assert.equal(pre.inputSchema.additionalProperties, false, "strict additionalProperties");
    // 批 119（A3）：聚合器只读（证明与读，不写共享状态）。
    assert.equal(pre.annotations.readOnlyHint, true, "read-only");
    assert.equal(pre.annotations.destructiveHint, false, "non-destructive");
    assert.equal(pre.annotations.idempotentHint, true, "idempotent");
  } finally {
    await client.close();
    await server.close();
  }
});

// ===== 11. stdio --workspace-root strict parsing =====

test("WSB-11: parseMcpArgs parses valid --workspace-root and rejects malformed", async () => {
  const { parseMcpArgs } = await import("../../src/mcp/stdio.js");
  // Valid absolute path (with spaces)
  const r1 = parseMcpArgs(["--workspace-root", "D:/some path/repo"]);
  assert.equal(r1.workspaceRoot, "D:/some path/repo", "valid absolute path with spaces");

  // Missing value — must throw
  assert.throws(() => parseMcpArgs(["--workspace-root"]), /workspace-root/, "missing value throws");

  // Empty string — must throw
  assert.throws(() => parseMcpArgs(["--workspace-root", ""]), /workspace-root/, "empty value throws");

  // Whitespace-only — must throw
  assert.throws(() => parseMcpArgs(["--workspace-root", "   "]), /workspace-root/, "whitespace value throws");

  // Relative path — must throw
  assert.throws(() => parseMcpArgs(["--workspace-root", "relative/path"]), /workspace-root/, "relative path throws");

  // Duplicate — must throw
  assert.throws(() => parseMcpArgs(["--workspace-root", "D:/a", "--workspace-root", "D:/b"]),
    /workspace-root/, "duplicate throws");

  // No --workspace-root — undefined (valid, uses roots fallback)
  const r2 = parseMcpArgs(["--registry", "/r.json"]);
  assert.equal(r2.workspaceRoot, undefined, "no workspaceRoot when flag absent");

  // --registry and --run-dir behavior unchanged (last-wins, lenient)
  const r3 = parseMcpArgs(["--registry", "/a.json", "--run-dir", "/runs"]);
  assert.equal(r3.registryPath, "/a.json");
  assert.equal(r3.runDir, "/runs");
});

// ===== 12. Fixed MCP error does not leak absolute path =====

test("WSB-12: lead_preflight with unprovable server_config root → unbound, no path leak", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wsb-12-"));
  try {
    // Create a non-Git directory
    writeFileSync(join(dir, "file.txt"), "x", "utf8");
    const server = createWaoMcpServer({
      registryPath: "/r.json",
      runDir: "/runs",
      workspaceRoot: dir, // non-Git → proof fails
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "lead_preflight", arguments: {} });
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text).workspace;
      assert.equal(parsed.bound, false);
      assert.equal(parsed.unboundReason, "server_config_git_proof_failed");
      // No path leak in the full response
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes(dir.replace(/\\/g, "/")), "no path leak");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ===== 14. Real SDK client/server roots integration test =====

test("WSB-14: real SDK client roots → server binds to single file root", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wsb-14-"));
  try {
    const head = makeGitRepo(dir);
    const { pathToFileURL } = await import("node:url");
    const server = createWaoMcpServer({
      registryPath: "/r.json",
      runDir: "/runs",
      // No workspaceRoot — rely on client roots
    });
    // Client with roots capability and a single root
    const client = await buildInMemoryClient(server, {
      roots: { listChanged: false },
    });
    try {
      // Override the client's listRoots handler to return our test root.
      // The SDK Client stores a roots list handler set during setRequestHandler.
      // We need to intercept the roots/list request.
      // The InMemoryTransport linked pair will route the request.
      client.setRequestHandler(
        // Use the raw schema from the SDK
        (await import("@modelcontextprotocol/sdk/types.js")).ListRootsRequestSchema,
        async () => ({
          roots: [{ uri: pathToFileURL(dir).href, name: "test-workspace" }],
        }),
      );

      const parsed = await binding(client);
      assert.equal(parsed.bound, true);
      assert.equal(parsed.source, "mcp_root");
      assert.equal(parsed.gitHead, head);
      assert.equal(parsed.dirty, false);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ===== 3b. Multiple roots → fail closed =====

test("WSB-03: multiple roots → bound=false (fail closed, no first-root selection)", async () => {
  const dir1 = mkdtempSync(join(tmpdir(), "wao-wsb-03a-"));
  const dir2 = mkdtempSync(join(tmpdir(), "wao-wsb-03b-"));
  try {
    makeGitRepo(dir1);
    makeGitRepo(dir2);
    const { pathToFileURL } = await import("node:url");
    const { ListRootsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs" });
    const client = await buildInMemoryClient(server, { roots: {} });
    try {
      client.setRequestHandler(ListRootsRequestSchema, async () => ({
        roots: [
          { uri: pathToFileURL(dir1).href, name: "a" },
          { uri: pathToFileURL(dir2).href, name: "b" },
        ],
      }));
      const parsed = await binding(client);
      assert.equal(parsed.bound, false, "multiple roots must fail closed");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir1);
    cleanupDir(dir2);
  }
});
