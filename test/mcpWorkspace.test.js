// test/mcpWorkspace.test.js
//
// M10-pre2 Batch B: MCP workspace binding, roots, stdio fallback, dispatch integration.
//
// Tests:
// 1. Explicit --workspace-root priority over client roots
// 2. No explicit config + exactly one valid MCP file root → bound
// 3. Zero/multiple/non-file/malformed/unsupported roots → fixed safe failure
// 4. workspace_status returns accurate source/head/dirty, zero path leak
// 5. workspace_status malformed service result → fixed safe failure
// 6. run_dispatch passes canonical root as cwd to dispatcher
// 7. Registry agent cwd is overridden by MCP server-owned binding
// 8. Workspace resolve/proof failure → dispatcher=0, transcript=0, fork=0
// 9. Tool input cwd/workspaceRoot/rootUri/path fields all rejected by strict schema
// 10. CLI --cwd and text/JSON output unchanged (regression guard — checked via existing tests)
// 11. stdio --workspace-root with spaces works; empty/relative/missing/duplicate rejected
// 12. Fixed stderr/MCP error does not leak absolute path or raw exception
// 13. No-model real stdio smoke: workspace_status → run_dispatch(delivery) → terminal → delivery verification
// 14. At least one real SDK client/server integration test for MCP roots

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { createWaoMcpServer } from "../src/mcp/server.js";
import { readTranscript, findState, findLatest } from "../src/transcript.js";

// ===== Helpers =====

const REPO_ROOT = resolve(import.meta.dirname, "..");
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

// ===== 4. workspace_status returns accurate source/head/dirty, zero path leak =====

test("WSB-04: workspace_status returns bound=true, source, gitHead, dirty, workspaceRoot", async () => {
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
      const res = await client.callTool({ name: "workspace_status", arguments: {} });
      const textBlock = res.content.find((b) => b.type === "text");
      const parsed = JSON.parse(textBlock.text);
      assert.equal(parsed.bound, true);
      assert.equal(parsed.source, "server_config");
      assert.equal(parsed.gitHead, head);
      assert.equal(parsed.dirty, false);
      // M11-6: workspaceRoot is now returned (the Lead/host explicitly submitted
      // the path; it is not a credential to hide). It must be the canonical root.
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

// ===== 5. workspace_status unbound contract (no workspace → bound=false) =====

test("WSB-05: workspace_status with no workspace bound → bound=false, all fields null", async () => {
  const server = createWaoMcpServer({
    registryPath: "/r.json",
    runDir: "/runs",
    // no workspaceRoot, and no roots capability on client
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "workspace_status", arguments: {} });
    const textBlock = res.content.find((b) => b.type === "text");
    const parsed = JSON.parse(textBlock.text);
    assert.equal(parsed.bound, false);
    assert.equal(parsed.source, null);
    assert.equal(parsed.gitHead, null);
    assert.equal(parsed.dirty, null);
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
    let captured = null;
    let callCount = 0;
    const fakeDispatch = async (input) => {
      callCount += 1;
      captured = input;
      return { accepted: true, runId: "run_wsb06", state: "pending" };
    };
    const server = createWaoMcpServer({
      registryPath: "/r.json",
      runDir: "/runs",
      workspaceRoot: dir,
      dispatchRunFn: fakeDispatch,
    });
    const client = await buildInMemoryClient(server);
    try {
      await client.callTool({ name: "run_dispatch", arguments: { agentId: "x", prompt: "y" } });
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

// ===== 1. workspace_status schema is strict empty input =====

test("WSB-01: workspace_status input is strict empty — extra fields rejected", async () => {
  const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs" });
  const client = await buildInMemoryClient(server);
  try {
    const tools = await client.listTools();
    const ws = tools.tools.find((t) => t.name === "workspace_status");
    assert.ok(ws, "workspace_status tool exists");
    const inputKeys = Object.keys(ws.inputSchema.properties ?? {});
    assert.deepEqual(inputKeys, [], "input schema is strict empty");
    assert.equal(ws.inputSchema.additionalProperties, false, "strict additionalProperties");
    // Annotations
    assert.equal(ws.annotations.readOnlyHint, true, "read-only");
    assert.equal(ws.annotations.destructiveHint, false, "non-destructive");
    assert.equal(ws.annotations.idempotentHint, true, "idempotent");
  } finally {
    await client.close();
    await server.close();
  }
});

// ===== 11. stdio --workspace-root strict parsing =====

test("WSB-11: parseMcpArgs parses valid --workspace-root and rejects malformed", async () => {
  const { parseMcpArgs } = await import("../src/mcp/stdio.js");
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

test("WSB-12: workspace_status with invalid workspaceRoot does not leak path in error", async () => {
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
      const res = await client.callTool({ name: "workspace_status", arguments: {} });
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(parsed.bound, false);
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

      const res = await client.callTool({ name: "workspace_status", arguments: {} });
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
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
      const res = await client.callTool({ name: "workspace_status", arguments: {} });
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
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
