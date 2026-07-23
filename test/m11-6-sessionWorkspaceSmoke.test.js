// test/m11-6-sessionWorkspaceSmoke.test.js
//
// M11-6 no-model real stdio smoke (acceptance matrix #12).
//
// Proves the end-to-end user-visible outcome over the REAL stdio MCP transport:
//   unbound server → workspace_select(current Git root) → workspace_status
//   confirms lead_session → run_dispatch(fake worker) succeeds with the
//   selected workspace as cwd.
//
// No real model is invoked: the worker is a fake that writes a file and exits 0.
// The server is started WITHOUT --workspace-root, so it begins UNBOUND — proving
// the Lead can recover an unconfigured session by selecting the project.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SHIM = join(REPO_ROOT, "scripts", "wao-node.cjs");
const STDIO_ENTRY = join(REPO_ROOT, "src", "mcp", "stdio.js");
const FAKE_WORKER = join(REPO_ROOT, "test", "fixtures", "fake-worker-writefile.cjs");

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function makeGitRepo(dir) {
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "placeholder.txt"), "initial\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

// Start a stdio MCP server with NO --workspace-root (starts UNBOUND).
async function buildUnboundStdioClient({ registryPath, runDir }) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const childEnv = { ...process.env, WAO_SKIP_VERSION_GUARD: "1" };
  const args = [SHIM, STDIO_ENTRY, "--registry", registryPath, "--run-dir", runDir];
  const transport = new StdioClientTransport({ command: process.execPath, args, env: childEnv });
  const client = new Client({ name: "wao-m116-smoke", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

test("M11-6-SMOKE: unbound → workspace_select → status → dispatch succeeds (no model)", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "wao m116 smoke "));
  const workspaceDir = join(baseDir, "my project");
  const waoDir = join(baseDir, "wao");
  const runDir = join(waoDir, "runs");

  try {
    // 1. Workspace Git repo (the project the Lead will select).
    mkdirSync(workspaceDir, { recursive: true });
    const headCommit = makeGitRepo(workspaceDir);

    // 2. Registry + reliability summary (fake worker, no real model).
    mkdirSync(waoDir, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    const registryPath = join(waoDir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        fake_worker: {
          backend: "claude-code",
          binary: process.execPath,
          prependArgs: [FAKE_WORKER, "m116_output.txt", "m116 smoke ok"],
          cwd: workspaceDir,
          args: [],
        },
      },
    }), "utf8");
    writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({
      workers: { fake_worker: { status: "certified" } },
    }), "utf8");

    // 3. Start UNBOUND stdio server (no --workspace-root).
    const { client, transport } = await buildUnboundStdioClient({ registryPath, runDir });
    try {
      // 4. workspace_status: initially UNBOUND.
      let res = await client.callTool({ name: "workspace_status", arguments: {} });
      let parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(parsed.bound, false, "server starts unbound");
      assert.equal(parsed.source, null);

      // 5. Lead selects the project in-session.
      res = await client.callTool({ name: "workspace_select", arguments: { workspaceRoot: workspaceDir } });
      parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(parsed.bound, true);
      assert.equal(parsed.source, "lead_session");
      assert.equal(parsed.gitHead, headCommit);
      assert.equal(parsed.workspaceRoot.replace(/\\/g, "/"), workspaceDir.replace(/\\/g, "/"));

      // 6. workspace_status confirms lead_session.
      res = await client.callTool({ name: "workspace_status", arguments: {} });
      parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(parsed.bound, true);
      assert.equal(parsed.source, "lead_session");

      // 7. run_dispatch succeeds with the selected workspace as cwd.
      res = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "fake_worker", prompt: "write the smoke output file" },
      });
      parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(parsed.accepted, true, "dispatch accepted");
      assert.equal(parsed.state, "pending");
      const runId = parsed.runId;
      assert.ok(runId);

      // 8. Close client; detached runner continues. Wait for terminal.
      await client.close();
      const { readTranscript, findState } = await import("../src/transcript.js");
      const transcriptPath = join(runDir, `${runId}.jsonl`);
      let state = null;
      for (let i = 0; i < 150; i++) {
        if (existsSync(transcriptPath)) {
          const events = await readTranscript(transcriptPath);
          state = findState(events);
          if (["completed", "failed", "aborted", "timed_out"].includes(state)) break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.equal(state, "completed", "fake worker run completed (no model)");

      // 9. The worker wrote into the SELECTED workspace cwd (proves cwd resolution).
      const outPath = join(workspaceDir, "src", "m116_output.txt");
      assert.ok(existsSync(outPath), "worker output written into the selected workspace");
      assert.equal(readFileSync(outPath, "utf8").trim(), "m116 smoke ok");
    } finally {
      // transport holds the child process; closing the client closes stdio.
      try { await transport.close(); } catch {}
    }
  } finally {
    cleanupDir(baseDir);
  }
});
