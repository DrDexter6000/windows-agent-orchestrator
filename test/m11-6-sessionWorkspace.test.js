// test/m11-6-sessionWorkspace.test.js
//
// M11-6: Lead session-level workspace selection.
//
// Proves that a Lead can select a Git project in-session without Human Owner
// bind / project config / restart, that the selection drives run_dispatch cwd,
// that two server instances are isolated, and that failures leave session
// state untouched. Drives the GREEN acceptance matrix.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { createWaoMcpServer } from "../src/mcp/server.js";
import { selectSessionWorkspace } from "../src/application/sessionWorkspace.js";

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

// ===== RED facts (current unbound behavior) =====

// RED-1: unbound server → workspace_status reports bound=false, source=null.
test("M11-6-RED-1: unbound server workspace_status = bound:false, source:null", async () => {
  const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs" });
  try {
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "workspace_status", arguments: {} });
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(parsed.bound, false);
      assert.equal(parsed.source, null);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {}
});

// RED-2: workspace_select does not exist yet (pre-fix) OR exists post-fix.
test("M11-6-GREEN-1: workspace_select exists and selects a Git repo in-session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m116-g1-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs" });
    try {
      const client = await buildInMemoryClient(server);
      try {
        // Before: unbound.
        let res = await client.callTool({ name: "workspace_status", arguments: {} });
        let parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
        assert.equal(parsed.bound, false);
        // Select the repo in-session.
        res = await client.callTool({ name: "workspace_select", arguments: { workspaceRoot: dir } });
        parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
        assert.equal(parsed.bound, true);
        assert.equal(parsed.source, "lead_session");
        assert.equal(parsed.dirty, false);
        assert.ok(parsed.gitHead && /^[0-9a-f]{40}$/.test(parsed.gitHead));
        // status now confirms repo A.
        res = await client.callTool({ name: "workspace_status", arguments: {} });
        parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
        assert.equal(parsed.bound, true);
        assert.equal(parsed.source, "lead_session");
      } finally {
        await client.close();
        await server.close();
      }
    } finally {}
  } finally {
    cleanupDir(dir);
  }
});

// ===== GREEN acceptance matrix =====

// GREEN-2: repo A → select repo B → subsequent dispatch uses repo B.
test("M11-6-GREEN-2: switch repo A → repo B, dispatch cwd follows B", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "wao-m116-g2-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wao-m116-g2-b-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m116-g2-runs-"));
  try {
    makeGitRepo(dirA);
    makeGitRepo(dirB);
    const registryPath = join(runDir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dirB } } }), "utf8");

    let capturedCwd = null;
    const server = createWaoMcpServer({
      registryPath, runDir,
      dispatchRunFn: async (args) => { capturedCwd = args.cwd; return { runId: "r1", accepted: true, state: "pending" }; },
    });
    try {
      const client = await buildInMemoryClient(server);
      try {
        await client.callTool({ name: "workspace_select", arguments: { workspaceRoot: dirA } });
        // switch to B
        await client.callTool({ name: "workspace_select", arguments: { workspaceRoot: dirB } });
        await client.callTool({ name: "run_dispatch", arguments: { agentId: "w", prompt: "do" } });
        assert.ok(capturedCwd, "dispatcher was called");
        // canonical root of B (forward slashes for compare)
        const expected = dirB.replace(/\\/g, "/");
        assert.equal(capturedCwd.replace(/\\/g, "/"), expected, "dispatch cwd is repo B");
      } finally {
        await client.close();
        await server.close();
      }
    } finally {}
  } finally {
    cleanupDir(dirA); cleanupDir(dirB); cleanupDir(runDir);
  }
});

// GREEN-3: repeated select of same repo is idempotent.
test("M11-6-GREEN-3: repeated workspace_select of same repo is idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m116-g3-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs" });
    try {
      const client = await buildInMemoryClient(server);
      try {
        const r1 = await client.callTool({ name: "workspace_select", arguments: { workspaceRoot: dir } });
        const r2 = await client.callTool({ name: "workspace_select", arguments: { workspaceRoot: dir } });
        const p1 = JSON.parse(r1.content.find((b) => b.type === "text").text);
        const p2 = JSON.parse(r2.content.find((b) => b.type === "text").text);
        assert.equal(p1.bound, true);
        assert.equal(p2.bound, true);
        assert.equal(p1.gitHead, p2.gitHead);
        assert.equal(p1.source, p2.source);
        assert.ok(!r1.isError && !r2.isError, "neither is an error");
      } finally {
        await client.close();
        await server.close();
      }
    } finally {}
  } finally {
    cleanupDir(dir);
  }
});

// GREEN-4: relative / nonexistent / non-Git / subdirectory rejected.
test("M11-6-GREEN-4: relative, nonexistent, non-Git, subdirectory all rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m116-g4-"));
  const notGit = mkdtempSync(join(tmpdir(), "wao-m116-g4-nogit-"));
  try {
    makeGitRepo(dir);
    mkdirSync(join(dir, "subdir"), { recursive: true });
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs" });
    try {
      const client = await buildInMemoryClient(server);
      try {
        for (const bad of ["relative/path", join(notGit), join(dir, "subdir")]) {
          const res = await client.callTool({ name: "workspace_select", arguments: { workspaceRoot: bad } });
          assert.ok(res.isError, `rejected: ${bad}`);
        }
      } finally {
        await client.close();
        await server.close();
      }
    } finally {}
  } finally {
    cleanupDir(dir); cleanupDir(notGit);
  }
});

// GREEN-5: failed select leaves the prior valid selection intact.
test("M11-6-GREEN-5: failed select leaves prior repo A valid", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "wao-m116-g5-a-"));
  const notGit = mkdtempSync(join(tmpdir(), "wao-m116-g5-nogit-"));
  try {
    makeGitRepo(dirA);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs" });
    try {
      const client = await buildInMemoryClient(server);
      try {
        const ok = await client.callTool({ name: "workspace_select", arguments: { workspaceRoot: dirA } });
        assert.equal(JSON.parse(ok.content.find((b) => b.type === "text").text).bound, true);
        // attempt a bad select
        const bad = await client.callTool({ name: "workspace_select", arguments: { workspaceRoot: notGit } });
        assert.ok(bad.isError, "bad select is an error");
        // status still A
        const st = await client.callTool({ name: "workspace_status", arguments: {} });
        const parsed = JSON.parse(st.content.find((b) => b.type === "text").text);
        assert.equal(parsed.bound, true);
        assert.equal(parsed.source, "lead_session");
      } finally {
        await client.close();
        await server.close();
      }
    } finally {}
  } finally {
    cleanupDir(dirA); cleanupDir(notGit);
  }
});

// GREEN-6: Windows path case alias normalizes to same canonical root.
test("M11-6-GREEN-6: case-aliased path resolves to same canonical root", async () => {
  if (process.platform !== "win32") return; // case-insensitive only on win32
  const dir = mkdtempSync(join(tmpdir(), "WaoM116G6-Case-"));
  try {
    makeGitRepo(dir);
    // Flip the case of the temp-suffix portion of the path.
    const flipped = dir.replace(/WaoM116G6-Case/i, "wAOm116g6-cASE");
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs" });
    try {
      const client = await buildInMemoryClient(server);
      try {
        const res = await client.callTool({ name: "workspace_select", arguments: { workspaceRoot: flipped } });
        const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
        assert.equal(parsed.bound, true);
        // workspaceRoot returned should be canonical (same as the realpath of dir).
        const canonical = dir.replace(/\\/g, "/");
        assert.equal(parsed.workspaceRoot.replace(/\\/g, "/"), canonical, "canonical root");
      } finally {
        await client.close();
        await server.close();
      }
    } finally {}
  } finally {
    cleanupDir(dir);
  }
});

// GREEN-7: two MCP server instances are strictly isolated.
test("M11-6-GREEN-7: two server instances isolated (A selection does not affect B)", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "wao-m116-g7-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wao-m116-g7-b-"));
  try {
    makeGitRepo(dirA);
    makeGitRepo(dirB);
    const serverA = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs" });
    const serverB = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs" });
    try {
      const [clientA, clientB] = await Promise.all([
        buildInMemoryClient(serverA),
        buildInMemoryClient(serverB),
      ]);
      try {
        await clientA.callTool({ name: "workspace_select", arguments: { workspaceRoot: dirA } });
        // B never selected → must be unbound.
        const stB = await clientB.callTool({ name: "workspace_status", arguments: {} });
        const parsedB = JSON.parse(stB.content.find((b) => b.type === "text").text);
        assert.equal(parsedB.bound, false, "server B unaffected by A's selection");
        // A still bound.
        const stA = await clientA.callTool({ name: "workspace_status", arguments: {} });
        const parsedA = JSON.parse(stA.content.find((b) => b.type === "text").text);
        assert.equal(parsedA.bound, true);
      } finally {
        await Promise.all([clientA.close(), clientB.close()]);
        await Promise.all([serverA.close(), serverB.close()]);
      }
    } finally {}
  } finally {
    cleanupDir(dirA); cleanupDir(dirB);
  }
});

// GREEN-8/9: lead_session overrides legacy defaults.
test("M11-6-GREEN-9: lead_session overrides server_config default", async () => {
  const dirConfig = mkdtempSync(join(tmpdir(), "wao-m116-g9-cfg-"));
  const dirSession = mkdtempSync(join(tmpdir(), "wao-m116-g9-sess-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m116-g9-runs-"));
  try {
    makeGitRepo(dirConfig);
    makeGitRepo(dirSession);
    const registryPath = join(runDir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dirSession } } }), "utf8");
    let capturedCwd = null;
    const server = createWaoMcpServer({
      registryPath, runDir, workspaceRoot: dirConfig,
      dispatchRunFn: async (args) => { capturedCwd = args.cwd; return { runId: "r1", accepted: true, state: "pending" }; },
    });
    try {
      const client = await buildInMemoryClient(server);
      try {
        // Initially server_config.
        let st = await client.callTool({ name: "workspace_status", arguments: {} });
        assert.equal(JSON.parse(st.content.find((b) => b.type === "text").text).source, "server_config");
        // Select session repo (overrides).
        await client.callTool({ name: "workspace_select", arguments: { workspaceRoot: dirSession } });
        st = await client.callTool({ name: "workspace_status", arguments: {} });
        assert.equal(JSON.parse(st.content.find((b) => b.type === "text").text).source, "lead_session");
        // dispatch uses session, not config.
        await client.callTool({ name: "run_dispatch", arguments: { agentId: "w", prompt: "do" } });
        assert.equal(capturedCwd.replace(/\\/g, "/"), dirSession.replace(/\\/g, "/"), "dispatch cwd is session repo");
      } finally {
        await client.close();
        await server.close();
      }
    } finally {}
  } finally {
    cleanupDir(dirConfig); cleanupDir(dirSession); cleanupDir(runDir);
  }
});

// GREEN-10: select does not write any persistent config/files in target.
test("M11-6-GREEN-10: workspace_select writes no persistent files in target repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m116-g10-"));
  try {
    makeGitRepo(dir);
    const before = new Set(readdirSync(dir));
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs" });
    try {
      const client = await buildInMemoryClient(server);
      try {
        await client.callTool({ name: "workspace_select", arguments: { workspaceRoot: dir } });
        await client.callTool({ name: "workspace_select", arguments: { workspaceRoot: dir } });
      } finally {
        await client.close();
        await server.close();
      }
    } finally {}
    const after = new Set(readdirSync(dir));
    // No new top-level files/dirs created (no .codex/config.toml, no exclude edits).
    const added = [...after].filter((f) => !before.has(f));
    assert.deepEqual(added, [], `no files created in target repo: ${JSON.stringify(added)}`);
    // No .git/info/exclude changes (dirty should remain false).
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim().length > 0;
    assert.equal(dirty, false, "target repo still clean");
  } finally {
    cleanupDir(dir);
  }
});

// ===== Package A: application-layer unit tests =====

// A-UNIT-1: selectSessionWorkspace delegates to proveWorkspace; returns canonical/head/dirty.
test("M11-6-A-UNIT-1: selectSessionWorkspace returns canonical root/head/dirty", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m116-a1-"));
  try {
    const head = makeGitRepo(dir);
    const result = selectSessionWorkspace({ workspaceRoot: dir });
    assert.equal(result.gitHead, head);
    assert.equal(result.dirty, false);
    assert.equal(result.root.replace(/\\/g, "/"), dir.replace(/\\/g, "/"));
  } finally {
    cleanupDir(dir);
  }
});

// A-UNIT-2: selectSessionWorkspace rejects relative/nonexistent/non-Git/subdirectory; no state change on failure.
test("M11-6-A-UNIT-2: selectSessionWorkspace rejects bad inputs (throws)", () => {
  const notGit = mkdtempSync(join(tmpdir(), "wao-m116-a2-nogit-"));
  try {
    for (const bad of ["relative/path", notGit, 42, null, {}, ""]) {
      // Each bad input must throw (rejected). The exact message shape is not
      // asserted here — the MCP layer collapses all failures to a fixed
      // WORKSPACE_SELECT_ERROR_TEXT. We only assert the selection is rejected.
      assert.throws(() => selectSessionWorkspace({ workspaceRoot: bad }), undefined, `rejects ${JSON.stringify(bad)}`);
    }
  } finally {
    cleanupDir(notGit);
  }
});

// A-UNIT-3: selectSessionWorkspace error message does not leak absolute path of a bad input.
test("M11-6-A-UNIT-3: selectSessionWorkspace error does not leak absolute path", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m116-a3-secret-"));
  try {
    try {
      selectSessionWorkspace({ workspaceRoot: dir });
      assert.fail("should throw (not a git repo)");
    } catch (e) {
      assert.ok(!e.message.includes(dir.replace(/\\/g, "/")), "no path leak in error");
    }
  } finally {
    cleanupDir(dir);
  }
});
