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
//
// Wait / read / cleanup discipline lives in test/_mcpWorkspaceSmokeHelper.mjs:
// bounded round budgets (150 / 300 rounds × 200ms, not wall-clock ceilings);
// success only from a CURRENT successful read (a prior good snapshot is
// diagnostics-only after a read failure or a vanished file); failures stay
// failures with a bounded diagnostic snapshot; cleanup removes only this
// fixture's tree and only after a direct runner-exit proof, otherwise the
// fixture is kept and reported as cleanup "unknown".

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { findState } from "../../src/transcript.js";
import {
  readSmokeSample,
  waitForSmokeTerminal,
  waitForSmokeDeliveryOutcome,
  classifySmokeOutcome,
  countKeyEvents,
  formatSmokeFailure,
  attachFailureDiagnostics,
  cleanupSmokeFixture,
  resolveCleanupReporting,
} from "../_mcpWorkspaceSmokeHelper.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const SHIM = join(REPO_ROOT, "scripts", "wao-node.cjs");
const STDIO_ENTRY = join(REPO_ROOT, "src", "mcp", "stdio.js");
const FAKE_WORKER = join(REPO_ROOT, "test", "fixtures", "fake-worker-writefile.cjs");

// The exact content the fake worker writes (matches fake-worker-writefile.cjs
// default: content || "fake output\n").
const EXPECTED_WORKER_OUTPUT = "fake worker output\n";

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

  // Hoisted so the catch/finally below can see them no matter where a failure
  // happened (client/transport handles, the dispatched runId, and the frozen
  // wait results used for the failure snapshot and the cleanup proof).
  let client = null;
  let transport = null;
  let runId = null;
  let dispatchAttempted = false;
  let terminal = null;
  let delivery = null;
  let primary = null;

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
    ({ client, transport } = await buildStdioClient({
      registryPath, runDir, workspaceRoot: workspaceDir,
    }));

    // 5. workspace_status: verify bound.
    const statusRes = await client.callTool({ name: "workspace_status", arguments: {} });
    const statusParsed = JSON.parse(statusRes.content.find((b) => b.type === "text").text);
    assert.equal(statusParsed.bound, true);
    assert.equal(statusParsed.source, "server_config");
    assert.equal(statusParsed.gitHead, headCommit);
    assert.equal(statusParsed.dirty, false);

    // 6. run_dispatch with delivery. Recorded BEFORE the request is sent: an
    // RPC that took effect but whose response was lost, unparseable, or failed
    // an assertion before runId was assigned still leaves a detached runner
    // behind — so cleanup must keep demanding a runner-exit proof (and keep the
    // fixture without one) even with runId unknown.
    dispatchAttempted = true;
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
    runId = dispatchParsed.runId;
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
    //   Phase 1 waits bounded for a terminal state (150 rounds × 200ms — round
    //   budget, not a wall-clock ceiling). Phase 2 then waits bounded
    //   (300 rounds × 200ms) specifically for ONE durable verification outcome.
    //   The final exact-count assertions below still distinguish passed vs
    //   failed vs unavailable — we never treat "any verification outcome" as
    //   success.
    //
    // No non-delivery inference: this dispatch always requests delivery, and
    // run.delivery_created is written in the SAME atomic batch as the terminal
    // completed transition (runManager.js _finalizeDelivery → transitionState
    // attemptEvents). "Completed without delivery_created" is therefore a hard
    // failure (delivery_created_missing_or_duplicate), never a reason to skip
    // the delivery wait. The former ~5s "no created ⇒ non-delivery" grace only
    // ever shortened this wait — the exact assertions below still rejected a
    // missing delivery_created — but it could report a LATE delivery_created as
    // missing and mislabelled why we stopped waiting, so it is gone.
    const transcriptPath = join(runDir, `${runId}.jsonl`);

    // Phase 1: bounded wait for a terminal state. A non-terminal exhaustion or
    // a read failure is an immediate, classified failure with a fixed
    // diagnostic snapshot (see the catch below) — never a fall-through.
    terminal = await waitForSmokeTerminal({ transcriptPath, runDir, runId });
    if (terminal.kind !== "terminal" || terminal.state !== "completed") {
      const counts = countKeyEvents(terminal.sample?.events ?? []);
      const status = terminal.kind === "read_failure" ? "terminal_read_failure"
        : terminal.kind !== "terminal" ? terminal.kind
          : counts.deliveryFailed > 0 ? "packaging_failed" : "run_failed";
      assert.fail(formatSmokeFailure({ runId, phase: "terminal-wait", status, terminal }));
    }

    // Phase 2: bounded wait for ONE durable delivery outcome (verification
    // passed/failed/unavailable, or delivery_failed). read failures and wait
    // exhaustion are classified failures, not skips.
    delivery = await waitForSmokeDeliveryOutcome({ transcriptPath, runDir, runId });
    const classified = classifySmokeOutcome({ terminal, delivery });
    if (classified.status !== "ok") {
      assert.fail(formatSmokeFailure({
        runId, phase: "delivery-wait", status: classified.status, terminal, delivery,
      }));
    }
    const events = delivery.sample.events;

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

  } catch (err) {
    // Fix the failure evidence BEFORE any cleanup side effect: append (never
    // replace) the bounded diagnostic snapshot derived from the frozen wait
    // results. A success observed later — e.g. during cleanup — cannot wash it.
    primary = err;
    attachFailureDiagnostics(err, { runId: runId ?? null, terminal, delivery });
    throw err;
  } finally {
    // Closing the stdio client does NOT stop the detached runner (the owner
    // lease pid may still be alive), so fixture removal needs its own
    // runner-exit proof. Evidence is already fixed above. The proof is demanded
    // whenever a dispatch was ATTEMPTED — not merely when a runId came back:
    // an effective RPC whose response was lost/unparseable/asserted-away also
    // leaves a runner behind.
    try { await transport?.close(); } catch {}
    let cleanup;
    try {
      cleanup = await cleanupSmokeFixture({
        baseDir,
        runDir,
        runId: runId ?? null,
        workspaceDir,
        runnerPid: delivery?.runnerPid ?? terminal?.runnerPid ?? null,
        terminalState: terminal?.state ?? null,
        authorizedWorkspaceRoot: workspaceDir,
        expectRunner: dispatchAttempted,
      });
    } catch (error) {
      cleanup = {
        status: "error",
        reason: "cleanup_threw",
        error: { code: "cleanup_error", message: String(error?.message ?? error).slice(0, 160) },
        keptDir: baseDir,
      };
    }
    // A cleanup problem must never mask the primary failure (appended to the
    // SAME error object above), and on the success path it is surfaced as its
    // own failure — never silently hidden.
    const surfaced = resolveCleanupReporting(cleanup, primary);
    if (surfaced) throw surfaced;
  }
});

// ── Helper contract cases ─────────────────────────────────────────────────────
// These exercise the DELIVERED helper (test/_mcpWorkspaceSmokeHelper.mjs) that
// the real smoke above uses. WSB-HELP-A uses REAL file reads (no injection) to
// prove the async readTranscript wiring; WSB-HELP-B/C inject only I/O, clock,
// and cleanup edges.

test("WSB-HELP-A: readSmokeSample/waitForSmokeTerminal against REAL files (good JSON, bad JSON, missing)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao help a "));
  try {
    const runId = "run_helpAaaaaaaaaaaaaaaaaa1";
    const runDir = join(dir, "runs");
    const transcriptPath = join(runDir, `${runId}.jsonl`);
    mkdirSync(runDir, { recursive: true });

    // Missing file: a read failure, never a throw, never a success.
    const missing = await readSmokeSample({ transcriptPath, runDir, runId });
    assert.equal(missing.ok, false, "missing transcript file is a read failure");
    assert.equal(missing.readError.code, "ENOENT");
    assert.equal(missing.state, null);

    // Good JSONL: current successful read, state derived from it.
    writeFileSync(transcriptPath, [
      JSON.stringify({ ts: "2026-09-28T00:00:01.000Z", seq: 1, runId, agentId: "fake_worker", type: "run.background_submitted", background: true, cwd: dir }),
      JSON.stringify({ ts: "2026-09-28T00:00:02.000Z", seq: 2, runId, agentId: "fake_worker", type: "run.state_change", from: null, to: "pending", reason: "background_spawned" }),
      JSON.stringify({ ts: "2026-09-28T00:00:03.000Z", seq: 3, runId, agentId: "fake_worker", type: "run.state_change", from: "pending", to: "completed", reason: "done" }),
    ].join("\n") + "\n", "utf8");
    const good = await readSmokeSample({ transcriptPath, runDir, runId });
    assert.equal(good.ok, true, "good JSONL reads as a current successful sample");
    assert.equal(Array.isArray(good.events), true, "events is the parsed ARRAY (the awaited read), not a Promise");
    assert.equal(good.state, "completed");

    // The read is genuinely awaited: waitForSmokeTerminal with DEFAULT deps
    // (real readTranscript, real clock, real sleep) settles on round 1.
    const terminal = await waitForSmokeTerminal({ transcriptPath, runDir, runId });
    assert.equal(terminal.kind, "terminal");
    assert.equal(terminal.state, "completed");
    assert.equal(terminal.roundsUsed, 1);

    // Bad (torn) JSON tail: the async rejection is CAUGHT and classified — it
    // must not escape as a raw SyntaxError and must not look like success.
    writeFileSync(transcriptPath, [
      JSON.stringify({ ts: "2026-09-28T00:00:04.000Z", seq: 4, runId, agentId: "fake_worker", type: "run.state_change", from: "completed", to: "running", reason: "first_event" }),
      '{"ts":"2026-09-28T00:00:05.000Z","seq":5,"type":"run.state_cha',
    ].join("\n") + "\n", "utf8");
    const bad = await readSmokeSample({ transcriptPath, runDir, runId });
    assert.equal(bad.ok, false, "bad JSON is a read failure, not a throw");
    assert.equal(bad.events, null);
    assert.equal(bad.state, null);
    assert.match(String(bad.readError.message), /JSON|Unexpected|position/i);
    await assert.doesNotReject(readSmokeSample({ transcriptPath, runDir, runId }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WSB-HELP-B: wait + classify matrix (injected read/clock only — the real helper)", async () => {
  const RUN_ID = "run_helpBaaaaaaaaaaaaaaa1";
  const P = "/t/run.jsonl";
  const SENTINEL = "SECRET-PAYLOAD-SENTINEL";
  const ev = (seq, type, extra = {}) => ({
    ts: `2026-09-28T00:00:${String(seq).padStart(2, "0")}.000Z`, seq, runId: RUN_ID,
    agentId: "fake_worker", type, ...extra,
  });
  const base = [
    ev(1, "run.background_submitted", { background: true, cwd: "/t/ws", deliveryRequested: true }),
    ev(2, "run.state_change", { from: null, to: "pending", reason: "background_spawned" }),
    ev(3, "run.state_change", { from: "pending", to: "submitted", reason: "spawned" }),
  ];
  const running = [...base, ev(4, "run.state_change", { from: "submitted", to: "running", reason: "first_event" })];
  const completed = [
    ...running,
    ev(5, "run.delivery_created", { delivery: { deliveryCommit: "deadbeef", baseCommit: "cafe" } }),
    ev(6, "run.completed", { backendSessionId: "proc_1", messageCount: 1 }),
    ev(7, "run.state_change", { from: "running", to: "completed", reason: "done" }),
  ];
  const completedWithoutCreated = completed.filter((e) => e.type !== "run.delivery_created");
  const failedTail = [
    ev(5, "run.error", { phase: "wait", error: "backend stream ended", message: SENTINEL }),
    ev(6, "run.state_change", { from: "running", to: "failed", reason: "backend_stream_ended" }),
  ];
  const packagingFailedTail = [
    ...running,
    ev(5, "run.delivery_failed", { deliveryCode: "x", message: "packaging" }),
    ev(6, "run.error", { phase: "delivery", deliveryCode: "x" }),
    ev(7, "run.state_change", { from: "running", to: "failed", reason: "delivery_failed" }),
  ];

  // Scripted ASYNC reader: each poll consumes one frame (last frame repeats).
  // Frames are {events} or {error}.
  const scripted = (frames) => {
    let call = 0;
    return {
      readTranscriptFn: async () => {
        const frame = frames[Math.min(call, frames.length - 1)];
        call += 1;
        if (frame.error) throw frame.error;
        return frame.events.map((e) => ({ ...e }));
      },
    };
  };
  const clock = () => {
    let ms = 0;
    const sleeps = [];
    return {
      now: () => ms,
      sleep: async (v) => { sleeps.push(v); ms += v; },
      sleeps,
    };
  };
  const noLease = () => ({ present: false });

  // name, terminal frames, delivery frames, expected status (+ optional check)
  const cases = [
    {
      name: "normal delivery run",
      terminal: [{ events: base }, { events: running }, { events: completed }],
      delivery: [{ events: completed }, { events: [...completed, ev(8, "run.delivery_verification_passed", { exitCode: 0 })] }],
      expect: { status: "ok" },
    },
    {
      name: "submitted until phase-1 exhaustion (the recorded first-round shape)",
      terminal: [{ events: base }, { events: [...base, ev(4, "session.created", { backendSessionId: "proc_1" })] }],
      delivery: [],
      expect: {
        status: "terminal_wait_exhausted",
        check: (t, d, diag) => {
          assert.equal(t.kind, "terminal_wait_exhausted");
          assert.equal(t.state, "submitted");
          assert.equal(t.roundsUsed, 150, "full 150-round budget burned");
          assert.equal(t.elapsedMs, 149 * 200, "interval-accounted elapsed (no wall-clock claim)");
          assert.ok(diag.includes("rounds=150/150") && diag.includes("state=submitted"),
            "diagnostics carry rounds + last state");
        },
      },
    },
    {
      // Production-consistent timing: created is durable in the SAME atomic
      // batch as terminal completed (see `completed`); what arrives LATE is the
      // verification outcome, after cleanup. The old loop's ~5s grace did not
      // fire here (created was present) — this pins that the wait keeps going.
      name: "verification outcome arrives AFTER the old ~5s grace, still within budget",
      terminal: [{ events: completed }],
      delivery: [
        ...Array.from({ length: 30 }, () => ({ events: completed })),
        { events: [...completed, ev(8, "run.delivery_verification_passed", { exitCode: 0 })] },
      ],
      expect: {
        status: "ok",
        check: (t, d) => {
          assert.equal(d.roundsUsed, 31, "waited past round 25 (the removed ~5s grace)");
          assert.equal(d.elapsedMs, 30 * 200);
        },
      },
    },
    {
      // ANOMALOUS shape, deliberately: this sequence VIOLATES the production
      // atomic order (a delivery-requested run reaching terminal completed must
      // already carry run.delivery_created in the same batch) — it is NOT a
      // normal timing. It exists only to prove budget behaviour: with BOTH
      // created and outcome absent, the old loop exited at ~25 rounds via the
      // unsound non-delivery guess; the helper burns the FULL 300 rounds and
      // returns a classified failure instead.
      name: "created AND outcome both absent — full 300-round exhaustion (old loop exited ~25)",
      terminal: [{ events: completedWithoutCreated }],
      delivery: [{ events: completedWithoutCreated }],
      expect: {
        status: "delivery_wait_exhausted",
        check: (t, d) => {
          assert.equal(d.roundsUsed, 300, "full 300-round budget burned");
          assert.equal(d.elapsedMs, 299 * 200);
        },
      },
    },
    {
      name: "run explicitly failed",
      terminal: [{ events: [...running, ...failedTail] }],
      delivery: [],
      expect: { status: "run_failed" },
    },
    {
      name: "packaging failed",
      terminal: [{ events: packagingFailedTail }],
      delivery: [],
      expect: { status: "packaging_failed" },
    },
    {
      name: "verification failed",
      terminal: [{ events: completed }],
      delivery: [{ events: [...completed, ev(8, "run.delivery_verification_failed", { exitCode: 1 })] }],
      expect: { status: "verification_failed" },
    },
    {
      name: "verification unavailable",
      terminal: [{ events: completed }],
      delivery: [{ events: [...completed, ev(8, "run.delivery_verification_unavailable", { reason: "r" })] }],
      expect: { status: "verification_unavailable" },
    },
    {
      // ANOMALOUS shape (outcome present, created absent — violates the atomic
      // created/completed batch order): must be a classified failure, never a
      // "non-delivery run" skip.
      name: "delivery_created missing while an outcome is present",
      terminal: [{ events: completed }],
      delivery: [{ events: [...completedWithoutCreated, ev(8, "run.delivery_verification_passed", {})] }],
      expect: { status: "delivery_created_missing_or_duplicate" },
    },
    {
      name: "delivery_created duplicated",
      terminal: [{ events: completed }],
      delivery: [{ events: [...completed, ev(9, "run.delivery_created", { delivery: {} }), ev(8, "run.delivery_verification_passed", {})] }],
      expect: { status: "delivery_created_missing_or_duplicate" },
    },
    {
      name: "outcome absent with created present — full 300-round exhaustion",
      terminal: [{ events: completed }],
      delivery: [{ events: completed }],
      expect: {
        status: "delivery_wait_exhausted",
        check: (t, d) => {
          assert.equal(d.kind, "delivery_wait_exhausted");
          assert.equal(d.roundsUsed, 300, "full 300-round budget burned");
        },
      },
    },
    {
      name: "read failure in phase 1 after a good read (stale good sample is not success)",
      terminal: [{ events: base }, { error: Object.assign(new Error("Unterminated string in JSON"), { code: "read_error" }) }],
      delivery: [],
      expect: {
        status: "terminal_read_failure",
        check: (t) => {
          assert.equal(t.kind, "read_failure");
          assert.equal(t.state, "submitted", "last-good state kept for DIAGNOSTICS only");
          assert.equal(t.sample.ok, false);
          assert.equal(t.sample.readError.code, "read_error");
        },
      },
    },
    {
      name: "read failure in phase 2 (terminal sample is not a delivery outcome)",
      terminal: [{ events: completed }],
      delivery: [{ events: completed }, { error: Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }) }],
      expect: {
        status: "delivery_read_failure",
        check: (t, d) => {
          assert.equal(d.kind, "read_failure");
          assert.equal(d.outcome, null);
        },
      },
    },
    {
      name: "file absent at the start, appears later",
      terminal: [{ error: Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }) }, { events: completed }],
      delivery: [{ events: [...completed, ev(8, "run.delivery_verification_passed", {})] }],
      expect: { status: "ok" },
    },
  ];

  for (const c of cases) {
    const tReader = scripted(c.terminal);
    const tClock = clock();
    const terminal = await waitForSmokeTerminal({
      transcriptPath: P, runDir: "/t/runs", runId: RUN_ID,
      deps: { ...tReader, ...tClock, readLeaseFn: noLease },
    });
    const delivery = c.delivery.length
      ? await waitForSmokeDeliveryOutcome({
        transcriptPath: P, runDir: "/t/runs", runId: RUN_ID,
        deps: { ...scripted(c.delivery), ...clock(), readLeaseFn: noLease },
      })
      : null;
    const classified = classifySmokeOutcome({ terminal, delivery });
    assert.equal(classified.status, c.expect.status, `case "${c.name}"`);
    const diag = formatSmokeFailure({
      runId: RUN_ID, phase: "matrix", status: classified.status, terminal, delivery,
    });
    if (c.expect.check) c.expect.check(terminal, delivery, diag);
    // Bounded + payload-safe diagnostics on every path.
    assert.ok(diag.length <= 2000, `case "${c.name}": diagnostics bounded`);
    assert.ok(!diag.includes(SENTINEL), `case "${c.name}": no event payload leaks into diagnostics`);
    assert.ok(diag.includes(`runId=${RUN_ID}`), `case "${c.name}": runId present`);
  }

  // The failure snapshot is FIXED at exhaustion: a transcript that turns good
  // afterwards (e.g. during cleanup) cannot wash the recorded failure.
  const reader = scripted([{ events: base }, { events: completed }]);
  const ck = clock();
  const exhausted = await waitForSmokeTerminal({
    transcriptPath: P, runDir: "/t/runs", runId: RUN_ID, rounds: 1,
    deps: { ...reader, ...ck, readLeaseFn: noLease },
  });
  assert.equal(exhausted.kind, "terminal_wait_exhausted");
  const before = formatSmokeFailure({
    runId: RUN_ID, phase: "fixed", status: "terminal_wait_exhausted", terminal: exhausted,
  });
  await reader.readTranscriptFn(P); // the transcript now turns good
  const after = formatSmokeFailure({
    runId: RUN_ID, phase: "fixed", status: "terminal_wait_exhausted", terminal: exhausted,
  });
  assert.equal(after, before, "snapshot derived from the frozen wait result is unchanged");

  // The catch's OWN attachment logic (attachFailureDiagnostics — the function
  // the real smoke's catch calls): the waits may classify "ok" while a LATER
  // exact assertion still fails, and the appended diagnostics must then read
  // assertion_failed — never ok — on the ORIGINAL Error and message.
  const waitsFor = async (terminalFrames, deliveryFrames) => {
    const terminal = await waitForSmokeTerminal({
      transcriptPath: P, runDir: "/t/runs", runId: RUN_ID,
      deps: { ...scripted(terminalFrames), ...clock(), readLeaseFn: noLease },
    });
    const delivery = await waitForSmokeDeliveryOutcome({
      transcriptPath: P, runDir: "/t/runs", runId: RUN_ID,
      deps: { ...scripted(deliveryFrames), ...clock(), readLeaseFn: noLease },
    });
    return { terminal, delivery };
  };
  const blocks = (s) => s.split("[smoke-failure]").length - 1;

  // (a) duplicate run.delivery_verification_passed: classify only pins
  //     created === 1, so the waits say ok — the exact count assertion is what
  //     fails (duplicates are NOT moved into the classifier).
  {
    const dupPassed = [
      ...completed,
      ev(8, "run.delivery_verification_passed", { exitCode: 0 }),
      ev(9, "run.delivery_verification_passed", { exitCode: 0 }),
    ];
    const { terminal, delivery } = await waitsFor([{ events: completed }], [{ events: dupPassed }]);
    assert.equal(countKeyEvents(delivery.sample.events).verificationPassed, 2);
    assert.equal(classifySmokeOutcome({ terminal, delivery }).status, "ok",
      "the waits themselves are satisfied — the failure is the exact assertion");
    const original = new Error("exactly 1 run.delivery_verification_passed");
    const returned = attachFailureDiagnostics(original, { runId: RUN_ID, terminal, delivery });
    assert.equal(returned, original, "the ORIGINAL Error object is kept");
    assert.ok(original.message.startsWith("exactly 1 run.delivery_verification_passed"),
      "the original message stays first");
    assert.ok(original.message.includes("status=assertion_failed"),
      "status is assertion_failed — never ok");
    assert.equal(blocks(original.message), 1, "exactly one diagnostic block");
    attachFailureDiagnostics(original, { runId: RUN_ID, terminal, delivery });
    assert.equal(blocks(original.message), 1, "attaching twice does not duplicate the block");
  }

  // (b) waits fully ok (normal single events) + a later Git assertion failing.
  {
    const passed = [...completed, ev(8, "run.delivery_verification_passed", { exitCode: 0 })];
    const { terminal, delivery } = await waitsFor([{ events: completed }], [{ events: passed }]);
    assert.equal(classifySmokeOutcome({ terminal, delivery }).status, "ok");
    const original = new Error("delivery commit parent must be source HEAD");
    attachFailureDiagnostics(original, { runId: RUN_ID, terminal, delivery });
    assert.ok(original.message.startsWith("delivery commit parent must be source HEAD"));
    assert.ok(original.message.includes("status=assertion_failed"));
  }

  // (c) a phase-wait failure already carries its block (assert.fail path) — the
  // catch must not append a second one.
  {
    const { terminal } = await waitsFor([{ events: completed }], []);
    const withBlock = new Error("phase message");
    withBlock.message = `${withBlock.message}\n${formatSmokeFailure({
      runId: RUN_ID, phase: "delivery-wait", status: "delivery_wait_exhausted", terminal,
    })}`;
    const before = withBlock.message;
    attachFailureDiagnostics(withBlock, { runId: RUN_ID, terminal, delivery: null });
    assert.equal(withBlock.message, before, "no second block is appended");
  }
});

test("WSB-HELP-C: cleanup matrix (injected stopRun/probe/rm/sleep) + reporting", async () => {
  const RUN_ID = "run_helpCaaaaaaaaaaaaaaa1";
  const mk = () => {
    const baseDir = mkdtempSync(join(tmpdir(), "wao help c "));
    return { baseDir, runDir: join(baseDir, "wao", "runs"), workspaceDir: join(baseDir, "my project") };
  };

  // terminal run + runner exits on its own: no stopRun, rm exactly once.
  {
    const f = mk();
    const calls = { stop: [], rm: [], sleeps: 0 };
    const out = await cleanupSmokeFixture({
      baseDir: f.baseDir, runDir: f.runDir, runId: RUN_ID, workspaceDir: f.workspaceDir,
      runnerPid: 4242, terminalState: "completed", authorizedWorkspaceRoot: f.workspaceDir,
      deps: {
        stopRunFn: async (i) => { calls.stop.push(i); return { terminalAccepted: true }; },
        isAliveFn: () => false,
        rmrf: (dir) => { calls.rm.push(dir); return 1; },
        sleep: async () => { calls.sleeps += 1; },
      },
    });
    assert.equal(out.status, "clean");
    assert.equal(calls.stop.length, 0, "terminal run: stopRun is not attempted");
    assert.deepEqual(calls.rm, [f.baseDir], "rm targets exactly the fixture root");
    rmSync(f.baseDir, { recursive: true, force: true });
  }

  // non-terminal run: ONE production stopRun WITH the workspace authorization.
  {
    const f = mk();
    const calls = { stop: [] };
    const out = await cleanupSmokeFixture({
      baseDir: f.baseDir, runDir: f.runDir, runId: RUN_ID, workspaceDir: f.workspaceDir,
      runnerPid: 4242, terminalState: "submitted", authorizedWorkspaceRoot: f.workspaceDir,
      deps: {
        stopRunFn: async (i) => { calls.stop.push(i); return { rejected: true, terminalAccepted: false }; },
        isAliveFn: () => false,
        rmrf: () => 1,
        sleep: async () => {},
      },
    });
    assert.equal(out.status, "clean");
    assert.equal(calls.stop.length, 1);
    assert.deepEqual(calls.stop[0], { runId: RUN_ID, runDir: f.runDir, authorizedWorkspaceRoot: f.workspaceDir },
      "stopRun gets exactly the MCP-shape authorization (no extra keys)");
    assert.equal(out.stopRun.rejected, true, "stopRun observation is recorded, bounded");
    rmSync(f.baseDir, { recursive: true, force: true });
  }

  // stopRun throwing is recorded and does not block the exit proof.
  {
    const f = mk();
    const out = await cleanupSmokeFixture({
      baseDir: f.baseDir, runDir: f.runDir, runId: RUN_ID,
      runnerPid: 4242, terminalState: "submitted", authorizedWorkspaceRoot: f.workspaceDir,
      deps: {
        stopRunFn: async () => { throw new Error("no session metadata"); },
        isAliveFn: () => false,
        rmrf: () => 1,
        sleep: async () => {},
      },
    });
    assert.equal(out.status, "clean");
    assert.equal(out.stopRun.threw.code, "error");
    rmSync(f.baseDir, { recursive: true, force: true });
  }

  // runner pid never observed: keep the fixture, never rm.
  {
    const f = mk();
    const calls = { rm: [] };
    const out = await cleanupSmokeFixture({
      baseDir: f.baseDir, runDir: f.runDir, runId: RUN_ID, workspaceDir: f.workspaceDir,
      runnerPid: null, terminalState: "completed", authorizedWorkspaceRoot: f.workspaceDir,
      deps: { stopRunFn: async () => ({}), isAliveFn: () => false, rmrf: (d) => { calls.rm.push(d); }, sleep: async () => {} },
    });
    assert.equal(out.status, "unknown");
    assert.equal(out.reason, "runner_pid_unobserved");
    assert.equal(out.keptDir, f.baseDir);
    assert.equal(calls.rm.length, 0, "nothing deleted without a runner-exit proof");
    rmSync(f.baseDir, { recursive: true, force: true });
  }

  // runner still alive after the bounded exit wait: keep, bounded polling.
  {
    const f = mk();
    const sleeps = [];
    const out = await cleanupSmokeFixture({
      baseDir: f.baseDir, runDir: f.runDir, runId: RUN_ID,
      runnerPid: 4242, terminalState: "completed", authorizedWorkspaceRoot: f.workspaceDir,
      rounds: 5, intervalMs: 200,
      deps: { stopRunFn: async () => ({}), isAliveFn: () => true, rmrf: () => 1, sleep: async (v) => { sleeps.push(v); } },
    });
    assert.equal(out.status, "unknown");
    assert.equal(out.reason, "runner_still_alive");
    assert.equal(out.runnerPid, 4242);
    assert.equal(sleeps.length, 4, "bounded polls (rounds - 1), no unbounded wait");
    assert.equal(out.keptDir, f.baseDir);
    rmSync(f.baseDir, { recursive: true, force: true });
  }

  // scope guard: a runDir that escapes the fixture root is refused (resolve/
  // relative proof, not a string prefix), even when it spells a prefix.
  {
    const f = mk();
    const calls = { rm: [] };
    const out = await cleanupSmokeFixture({
      baseDir: f.baseDir,
      runDir: join(f.baseDir, "..", `${f.baseDir.split(/[\/]/).pop()}-sibling`, "runs"),
      runId: RUN_ID, runnerPid: 4242, terminalState: "completed", authorizedWorkspaceRoot: f.workspaceDir,
      deps: { stopRunFn: async () => ({}), isAliveFn: () => false, rmrf: (d) => { calls.rm.push(d); }, sleep: async () => {} },
    });
    assert.equal(out.status, "error");
    assert.equal(out.reason, "fixture_scope_mismatch");
    assert.equal(calls.rm.length, 0, "nothing deleted on a scope mismatch");
    rmSync(f.baseDir, { recursive: true, force: true });
  }

  // rm failing (non-transient) is an error that KEEPS the dir and — composed
  // the way the real smoke composes it — can never replace the primary failure.
  {
    const f = mk();
    const out = await cleanupSmokeFixture({
      baseDir: f.baseDir, runDir: f.runDir, runId: RUN_ID,
      runnerPid: 4242, terminalState: "completed", authorizedWorkspaceRoot: f.workspaceDir,
      deps: {
        stopRunFn: async () => ({}),
        isAliveFn: () => false,
        rmrf: () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); },
        sleep: async () => {},
      },
    });
    assert.equal(out.status, "error");
    assert.equal(out.reason, "rm_failed");
    assert.equal(out.error.code, "EACCES");
    assert.equal(out.keptDir, f.baseDir);

    const primary = new Error('terminal must be exactly "completed" (got "submitted")');
    const surfaced = resolveCleanupReporting(out, primary);
    assert.equal(surfaced, null, "with a primary failure nothing is thrown — the note is appended");
    assert.ok(primary.message.startsWith('terminal must be exactly "completed"'),
      "the ORIGINAL failure text stays first");
    assert.ok(primary.message.includes("[cleanup] status=error"), "the cleanup note is appended, not hidden");
    rmSync(f.baseDir, { recursive: true, force: true });
  }

  // success path: a cleanup problem surfaces as its own failure (never silent),
  // and a clean cleanup reports nothing.
  {
    const f = mk();
    const notClean = { status: "unknown", reason: "runner_still_alive", runnerPid: 7, keptDir: f.baseDir };
    const surfaced = resolveCleanupReporting(notClean, null);
    assert.ok(surfaced instanceof Error, "no primary failure: the caller gets an Error to throw");
    assert.ok(surfaced.message.includes("status=unknown") && surfaced.message.includes("keptDir="));
    assert.equal(resolveCleanupReporting({ status: "clean" }, null), null);
    rmSync(f.baseDir, { recursive: true, force: true });
  }

  // P1 wiring shape — dispatch ATTEMPTED but no runId came back (RPC took
  // effect, response lost / unparseable / asserted away before assignment). The
  // real finally passes expectRunner: dispatchAttempted; with no owner-lease pid
  // observed the fixture is KEPT and reported unknown — the scene is not
  // deleted, and there is nothing to stop without a runId.
  {
    const f = mk();
    const calls = { rm: [], stop: [] };
    const out = await cleanupSmokeFixture({
      baseDir: f.baseDir, runDir: f.runDir, runId: null, workspaceDir: f.workspaceDir,
      runnerPid: null, terminalState: null, authorizedWorkspaceRoot: f.workspaceDir,
      expectRunner: true, // === dispatchAttempted in the real smoke's finally
      deps: {
        stopRunFn: async (i) => { calls.stop.push(i); return {}; },
        isAliveFn: () => false,
        rmrf: (d) => { calls.rm.push(d); },
        sleep: async () => {},
      },
    });
    assert.equal(out.status, "unknown");
    assert.equal(out.reason, "runner_pid_unobserved");
    assert.equal(out.keptDir, f.baseDir);
    assert.equal(calls.rm.length, 0, "no deletion without a runner-exit proof");
    assert.equal(calls.stop.length, 0, "no stopRun without a runId");
    const primary = new Error("run_dispatch response unparseable");
    assert.equal(resolveCleanupReporting(out, primary), null);
    assert.ok(primary.message.includes("[cleanup] status=unknown"),
      "the primary failure survives with the cleanup note appended");
    rmSync(f.baseDir, { recursive: true, force: true });
  }

  // Contrast: dispatch NEVER attempted (expectRunner false) with no pid — no
  // runner can exist, so cleanup may proceed to delete the fixture root.
  {
    const f = mk();
    const calls = { rm: [] };
    const out = await cleanupSmokeFixture({
      baseDir: f.baseDir, runDir: f.runDir, runId: null, workspaceDir: f.workspaceDir,
      runnerPid: null, terminalState: null, authorizedWorkspaceRoot: f.workspaceDir,
      expectRunner: false, // === dispatchAttempted === false
      deps: { stopRunFn: async () => ({}), isAliveFn: () => false, rmrf: (d) => { calls.rm.push(d); }, sleep: async () => {} },
    });
    assert.equal(out.status, "clean");
    assert.deepEqual(calls.rm, [f.baseDir]);
    rmSync(f.baseDir, { recursive: true, force: true });
  }
});
