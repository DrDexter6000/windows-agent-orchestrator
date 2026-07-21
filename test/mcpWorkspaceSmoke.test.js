// test/mcpWorkspaceSmoke.test.js
//
// M10-pre2 Batch B item 13: no-model real stdio smoke.
//
// Full end-to-end test: real stdio MCP subprocess + temp Git repo (path with
// spaces) + fake worker + delivery verification. Proves with EXACT assertions:
//   - workspace_status reports bound=true, source=server_config
//   - terminal state is exactly "completed" (not "failed")
//   - run.delivery_created count is exactly 1
//   - run.delivery_verification_passed count is exactly 1
//   - run.delivery_verification_failed count is 0
//   - run.delivery_failed count is 0
//   - delivery commit exists with correct parent (base = source HEAD)
//   - changed path is exactly src/output.txt (only that file)
//   - committed content is byte-exact equal to fake worker output
//   - source checkout HEAD and porcelain status unchanged before/after
//   - poison cwd has no output, heartbeat cleaned up
//
// Zero real model calls — uses fake-worker-writefile.cjs fixture.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SHIM = join(REPO_ROOT, "scripts", "wao-node.cjs");
const STDIO_ENTRY = join(REPO_ROOT, "src", "mcp", "stdio.js");
const FAKE_WORKER = join(REPO_ROOT, "test", "fixtures", "fake-worker-writefile.cjs");

// The exact content the fake worker writes (matches fake-worker-writefile.cjs
// default: content || "fake output\n").
const EXPECTED_WORKER_OUTPUT = "fake worker output\n";

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

function gitIn(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
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

test("WSB-SMOKE: workspace_status → run_dispatch(delivery) → completed → delivery verification passed (exact)", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "wao smoke "));
  const workspaceDir = join(baseDir, "my project");
  const waoDir = join(baseDir, "wao");
  const runDir = join(waoDir, "runs");

  try {
    // 1. Create the workspace Git repo with an initial commit.
    mkdirSync(workspaceDir, { recursive: true });
    const headCommit = makeGitRepo(workspaceDir);

    // Capture source porcelain BEFORE dispatch (must be empty = clean).
    // Delivery runs use persistent worktree isolation — .wao-worktrees/ is
    // intentionally left behind. We filter it to compare only the source tree.
    function filterPorcelain(s) {
      return s.split("\n").filter((l) => !l.includes(".wao-worktrees/")).join("\n").trim();
    }
    const sourcePorcelainBefore = filterPorcelain(gitIn(workspaceDir, ["status", "--porcelain"]));

    // 2. Create poison registry cwd.
    const poisonCwd = join(baseDir, "poison cwd");
    mkdirSync(poisonCwd, { recursive: true });
    writeFileSync(join(poisonCwd, "DO_NOT_TOUCH.txt"), "poison\n", "utf8");

    // 3. Create registry with fake worker whose cwd is poison.
    mkdirSync(waoDir, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    const registryPath = join(waoDir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        fake_worker: {
          backend: "claude-code",
          binary: process.execPath,
          // prependArgs go BEFORE the backend's own default args; args go AFTER.
          // The claude-code backend adds --output-format etc. to args, so the
          // fake worker invocation must use prependArgs + empty args (same pattern
          // as test/runDeliveryCli.test.js 3C1-05).
          prependArgs: [FAKE_WORKER, "output.txt", EXPECTED_WORKER_OUTPUT.trim()],
          cwd: poisonCwd,
          args: [],
        },
      },
    }), "utf8");
    writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({
      workers: { fake_worker: { status: "certified" } },
    }), "utf8");

    // 4. Start stdio MCP server.
    const { client, transport } = await buildStdioClient({
      registryPath, runDir, workspaceRoot: workspaceDir,
    });

    try {
      // 5. workspace_status: verify bound.
      const statusRes = await client.callTool({ name: "workspace_status", arguments: {} });
      const statusParsed = JSON.parse(statusRes.content.find((b) => b.type === "text").text);
      assert.equal(statusParsed.bound, true);
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
            // Verification uses shell:true (intentional delivery boundary).
            // "echo ok" works on both Windows and Unix shells.
            verificationCommands: ["echo ok"],
          },
        },
      });
      const dispatchParsed = JSON.parse(dispatchRes.content.find((b) => b.type === "text").text);
      assert.equal(dispatchParsed.accepted, true);
      assert.equal(dispatchParsed.state, "pending");
      const runId = dispatchParsed.runId;
      assert.ok(runId);

      // 7. Close client — detached runner continues.
      await client.close();

      // 8. Wait for terminal state, then for the durable delivery verification outcome.
      //
      // Why two phases (M11-3D pre sync):
      //   Production order in runManager.js is:
      //     run.completed (terminal state_change)
      //       → _runCleanup()
      //       → run.delivery_verification_{passed|failed|unavailable}
      //   Under full-suite concurrency, cleanup + verification can land AFTER the
      //   terminal transition by more than the previous single-loop budget. The
      //   terminal transition alone is therefore NOT a "delivery is done" signal.
      //   Phase 1 waits bounded for a terminal state. Phase 2 then waits bounded
      //   (up to 60s) specifically for ONE durable verification outcome. The final
      //   exact-count assertions below still distinguish passed vs failed vs
      //   unavailable — we never treat "any verification outcome" as success.
      const transcriptPath = join(runDir, `${runId}.jsonl`);
      const { readTranscript, findState, findLatest } = await import("../src/transcript.js");

      // Phase 1: bounded wait for a terminal state (≈30s ceiling preserved).
      let events = [];
      let terminalState = null;
      for (let i = 0; i < 150; i++) {
        if (existsSync(transcriptPath)) {
          events = await readTranscript(transcriptPath);
          const state = findState(events);
          if (["completed", "failed", "aborted", "timed_out"].includes(state)) {
            terminalState = state;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      // Phase 2: bounded wait (up to 60s) for a durable verification outcome.
      // Only relevant for delivery runs; if no delivery_created appears within a
      // short grace window, this is a non-delivery run and we skip to assertions.
      // For delivery runs, refuse to proceed until ONE of the three durable
      // verification events is observed — terminal alone is not sufficient.
      if (terminalState === "completed") {
        let sawCreated = false;
        let createdGrace = 0;
        for (let i = 0; i < 300; i++) { // 300 × 200ms = 60s ceiling
          if (existsSync(transcriptPath)) {
            events = await readTranscript(transcriptPath);
          }
          const hasCreated = events.some((e) => e.type === "run.delivery_created");
          const hasFailed = events.some((e) => e.type === "run.delivery_failed");
          const hasVerification = events.some((e) =>
            e.type === "run.delivery_verification_passed" ||
            e.type === "run.delivery_verification_failed" ||
            e.type === "run.delivery_verification_unavailable");
          // delivery_failed is itself a durable terminal outcome for delivery.
          if (hasFailed || hasVerification) break;
          if (hasCreated) {
            sawCreated = true;
          } else if (!sawCreated) {
            // Non-delivery run (no delivery_created observed): skip the 60s wait.
            // Bounded grace prevents an early exit masking a late delivery_created.
            createdGrace += 1;
            if (createdGrace > 25) break; // ~5s grace
          }
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      // 9. EXACT terminal state assertion — must be "completed", not "failed".
      const finalState = findState(events);
      assert.equal(finalState, "completed",
        `terminal must be exactly "completed" (got "${finalState}") — if failed, packaging/verification broke`);

      // 10. EXACT event count assertions.
      // The three verification outcomes (passed/failed/unavailable) are mutually
      // exclusive durable results. We assert each independently — a failed or
      // unavailable outcome is NOT masked as "verification done, so pass".
      const deliveryCreatedEvents = events.filter((e) => e.type === "run.delivery_created");
      const verificationPassedEvents = events.filter((e) => e.type === "run.delivery_verification_passed");
      const verificationFailedEvents = events.filter((e) => e.type === "run.delivery_verification_failed");
      const verificationUnavailableEvents = events.filter((e) => e.type === "run.delivery_verification_unavailable");
      const deliveryFailedEvents = events.filter((e) => e.type === "run.delivery_failed");
      // Exactly one terminal transition into "completed".
      const completedTransitions = events.filter(
        (e) => e.type === "run.state_change" && e.to === "completed");

      assert.equal(completedTransitions.length, 1, "exactly 1 terminal transition to completed");
      assert.equal(deliveryCreatedEvents.length, 1, "exactly 1 run.delivery_created");
      assert.equal(verificationPassedEvents.length, 1, "exactly 1 run.delivery_verification_passed");
      assert.equal(verificationFailedEvents.length, 0, "0 run.delivery_verification_failed");
      assert.equal(verificationUnavailableEvents.length, 0, "0 run.delivery_verification_unavailable");
      assert.equal(deliveryFailedEvents.length, 0, "0 run.delivery_failed");

      // 11. Delivery commit exists with correct parent.
      // The delivery commit is in the workspace repo (delivery creates a commit on a branch).
      // The delivery_created event contains the deliveryRef with deliveryCommit and baseCommit.
      const deliveryRef = deliveryCreatedEvents[0].deliveryRef ?? deliveryCreatedEvents[0].delivery;
      const deliveryCommit = deliveryRef?.deliveryCommit ?? deliveryCreatedEvents[0].deliveryCommit;
      const baseCommit = deliveryRef?.baseCommit ?? deliveryCreatedEvents[0].baseCommit;
      assert.ok(deliveryCommit, "delivery commit hash must be present");
      assert.equal(baseCommit, headCommit, "base commit must equal source HEAD");

      // 12. Verify delivery commit parent is the base commit.
      const deliveryParent = gitIn(workspaceDir, ["rev-parse", `${deliveryCommit}^`]);
      assert.equal(deliveryParent, headCommit, "delivery commit parent must be source HEAD");

      // 13. Changed path must be exactly src/output.txt — only that file.
      const changedFilesRaw = gitIn(workspaceDir, ["diff", "--name-only", `${headCommit}..${deliveryCommit}`]);
      const changedFiles = changedFilesRaw.split("\n").filter((f) => f.length > 0);
      assert.deepEqual(changedFiles, ["src/output.txt"],
        `changed files must be exactly ["src/output.txt"], got ${JSON.stringify(changedFiles)}`);

      // 14. Committed content must be byte-exact equal to expected worker output.
      const committedContent = gitIn(workspaceDir, ["show", `${deliveryCommit}:src/output.txt`]);
      assert.equal(committedContent, EXPECTED_WORKER_OUTPUT.trim(),
        "committed content must byte-exact match fake worker output");

      // 15. Source workspace HEAD and porcelain unchanged.
      // Delivery creates an ephemeral worktree under .wao-worktrees/ — after
      // _runCleanup removes it, porcelain should match the before state.
      // Wait briefly for cleanup to finish, then verify.
      const sourceHeadAfter = gitIn(workspaceDir, ["rev-parse", "HEAD"]);
      assert.equal(sourceHeadAfter, headCommit, "source workspace HEAD must be unchanged");

      // Wait for delivery completion, then verify source is unchanged.
      // Delivery persistent worktree (.wao-worktrees/) is intentionally left behind;
      // we filter it and compare only the source tree state.
      let sourcePorcelainAfter = "";
      for (let i = 0; i < 30; i++) {
        sourcePorcelainAfter = filterPorcelain(gitIn(workspaceDir, ["status", "--porcelain"]));
        if (sourcePorcelainAfter === sourcePorcelainBefore) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(sourcePorcelainAfter, sourcePorcelainBefore,
        "source workspace porcelain (excluding .wao-worktrees/) must be unchanged before/after");

      // 16. Poison cwd: no output file.
      assert.ok(!existsSync(join(poisonCwd, "src", "output.txt")),
        "poison cwd must not have worker output");

      // 17. Heartbeat file cleaned up.
      const ownerFile = join(runDir, `.owner-${runId}`);
      for (let i = 0; i < 50; i++) {
        if (!existsSync(ownerFile)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(!existsSync(ownerFile), "heartbeat file cleaned up");

    } finally {
      try { await transport.close(); } catch {}
    }
  } finally {
    cleanupDir(baseDir);
  }
});
