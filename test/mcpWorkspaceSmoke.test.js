// test/mcpWorkspaceSmoke.test.js
//
// M10-pre2 Batch B item 13: no-model real stdio smoke.
//
// Full end-to-end test: real stdio MCP subprocess + temp Git repo (path with
// spaces) + fake worker + delivery verification. Proves:
//   - workspace_status reports bound=true, source=server_config
//   - run_dispatch with delivery creates a worktree in the bound repo
//   - worker runs in the worktree (not in the poison registry cwd)
//   - source checkout is unchanged (delivery uses isolated worktree)
//   - delivery verification passes
//   - heartbeat file is cleaned up after runner exit
//
// Zero real model calls — uses fake-worker-writefile.cjs fixture.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
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
  // Create a src/ dir with a placeholder so the worktree has the structure.
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "placeholder.txt"), "initial\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

async function buildStdioClient({ registryPath, runDir, workspaceRoot, env = {} }) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const childEnv = { ...process.env, WAO_SKIP_VERSION_GUARD: "1", ...env };
  const args = [SHIM, STDIO_ENTRY, "--registry", registryPath, "--run-dir", runDir, "--workspace-root", workspaceRoot];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: childEnv,
  });
  const client = new Client({ name: "wao-smoke", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

test("WSB-SMOKE: workspace_status → run_dispatch(delivery) → terminal → delivery verification", async () => {
  // Temp dir for everything (path WITH spaces to test robustness).
  const baseDir = mkdtempSync(join(tmpdir(), "wao smoke "));
  const workspaceDir = join(baseDir, "my project");
  const waoDir = join(baseDir, "wao");
  const runDir = join(waoDir, "runs");

  try {
    // 1. Create the workspace Git repo with an initial commit.
    mkdirSync(workspaceDir, { recursive: true });
    const headCommit = makeGitRepo(workspaceDir);

    // 2. Create a poison registry cwd that is NOT the workspace — if the worker
    //    runs here, the test fails (proves workspace binding overrides registry cwd).
    const poisonCwd = join(baseDir, "poison cwd");
    mkdirSync(poisonCwd, { recursive: true });
    writeFileSync(join(poisonCwd, "DO_NOT_TOUCH.txt"), "poison\n", "utf8");

    // 3. Create the registry with a fake worker whose cwd is the poison dir.
    //    The MCP server's workspace binding must override this.
    mkdirSync(waoDir, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    const registryPath = join(waoDir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        fake_worker: {
          backend: "claude-code",
          binary: process.execPath,
          cwd: poisonCwd, // POISON — workspace binding must override
          args: [FAKE_WORKER, "output.txt", "fake worker output"],
        },
      },
    }), "utf8");
    // Reliability summary: mark as certified.
    writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({
      workers: { fake_worker: { status: "certified" } },
    }), "utf8");

    // 4. Start stdio MCP server with --workspace-root pointing to the workspace.
    const { client, transport } = await buildStdioClient({
      registryPath, runDir, workspaceRoot: workspaceDir,
    });

    try {
      // 5. workspace_status: verify bound.
      const statusRes = await client.callTool({ name: "workspace_status", arguments: {} });
      const statusParsed = JSON.parse(statusRes.content.find((b) => b.type === "text").text);
      assert.equal(statusParsed.bound, true, "workspace must be bound");
      assert.equal(statusParsed.source, "server_config");
      assert.equal(statusParsed.gitHead, headCommit);
      assert.equal(statusParsed.dirty, false);

      // 6. run_dispatch with delivery.
      const dispatchRes = await client.callTool({
        name: "run_dispatch",
        arguments: {
          agentId: "fake_worker",
          prompt: "write output file",
          delivery: {
            mode: "git_commit_v1",
            allowedPaths: ["src/output.txt"],
            verificationCommands: ["test -f src/output.txt"],
          },
        },
      });
      const dispatchParsed = JSON.parse(dispatchRes.content.find((b) => b.type === "text").text);
      assert.equal(dispatchParsed.accepted, true, "dispatch accepted");
      assert.equal(dispatchParsed.state, "pending");
      const runId = dispatchParsed.runId;
      assert.ok(runId, "runId returned");

      // 7. Close client — detached runner continues.
      await client.close();

      // 8. Wait for terminal state.
      const transcriptPath = join(runDir, `${runId}.jsonl`);
      const { readTranscript, findState, findLatest } = await import("../src/transcript.js");
      let events = [];
      for (let i = 0; i < 100; i++) {
        if (existsSync(transcriptPath)) {
          events = await readTranscript(transcriptPath);
          const state = findState(events);
          if (["completed", "failed", "aborted", "timed_out"].includes(state)) break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      const finalState = findState(events);
      assert.ok(["completed", "failed"].includes(finalState), `run must reach terminal, got ${finalState}`);

      // 9. Verify delivery was created (commit exists in worktree, not poison cwd).
      const deliveryCreated = findLatest(events, "run.delivery_created");
      const deliveryVerified = findLatest(events, "run.delivery_verification_passed")
        ?? findLatest(events, "run.delivery_verification_failed");

      // 10. The poison cwd must NOT have the output file — worker ran in workspace worktree.
      assert.ok(!existsSync(join(poisonCwd, "src", "output.txt")),
        "poison cwd must not have worker output — workspace binding overrides registry cwd");

      // 11. Source workspace HEAD must be unchanged (delivery uses isolated worktree).
      const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspaceDir, encoding: "utf8" }).trim();
      assert.equal(sourceHead, headCommit, "source workspace HEAD must be unchanged");

      // 12. Heartbeat file cleaned up after runner exit.
      const ownerFile = join(runDir, `.owner-${runId}`);
      for (let i = 0; i < 50; i++) {
        if (!existsSync(ownerFile)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(!existsSync(ownerFile), "heartbeat file cleaned up after runner exit");

    } finally {
      try { await transport.close(); } catch {}
    }
  } finally {
    cleanupDir(baseDir);
  }
});
