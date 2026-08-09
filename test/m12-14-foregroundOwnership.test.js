// test/m12-14-foregroundOwnership.test.js
//
// M12-14: foreground run workspace-ownership truth package.
//
// A foreground RunManager.start run persists `run.started.cwd` but no
// `run.background_submitted`, so the ownership SSOT previously rejected it as
// missing ownership and runs_list / run_delivery_review refused it. This file
// pins the extended contract in src/application/runWorkspaceOwnership.js:
//
//   - BINDING: ownership facts bind to the requested run by EXACT envelope
//     equality (e.runId === requestedRunId); the candidate filter runs
//     BEFORE any cwd is interpreted, and event ORDER carries no authority —
//     a foreign ownership event can neither authorize, conflict with, nor
//     poison the requested run (it simply is not a candidate);
//   - foreground: exactly one bound `run.started` with a valid cwd authorizes;
//   - background: unchanged — exactly one bound `run.background_submitted`;
//     a `run.started` cwd for the SAME run, when ALSO present, must agree
//     after the existing proveWorkspace/pathsMatch normalization (realpath +
//     platform case-fold);
//   - legacy tolerance: runId-less ownership events are attributed to the
//     requested run ONLY when no ownership event in the file carries any
//     runId (mixed bound+unbound ownership fails closed as missing);
//   - fail closed: missing / malformed / duplicate / cross-run-only /
//     conflicting background-vs-started / unprovable / cross-workspace facts;
//   - fixed error messages never echo paths or dynamic values;
//   - stop authorization keeps using the SAME verified ownership SSOT.
//
// Real-git cases use isolated temp repos; fail-closed-before-Git cases use an
// injected proveWorkspaceFn spy that must never be reached by the ownership
// fact (proving the rejection happens before any Git subprocess).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { JsonlTranscript } from "../src/transcript.js";
import { listRuns } from "../src/application/runList.js";
import { stopRun } from "../src/application/runStop.js";
import { resolveRunDeliveryReviewTarget } from "../src/application/runDeliveryReview.js";
import { packageDelivery } from "../src/delivery.js";
import {
  findRunWorkspaceOwnership,
  verifyRunWorkspaceOwnership,
  createRunWorkspaceVerifier,
} from "../src/application/runWorkspaceOwnership.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "R.md"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: dir });
}

function simpleEvent(type, runId, extra = {}) {
  return { type, runId, ts: "2026-01-01T00:00:00Z", seq: 1, ...extra };
}

async function makeRepo(prefix = "wao-fgown-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-b", "main", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "a.js"), "const a = 1;\n");
  await writeFile(join(dir, "src", "b.js"), "const b = 2;\n");
  await writeFile(join(dir, "README.md"), "# test\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir, encoding: "utf8",
  }).trim();
  return { repo: dir, baseCommit };
}

function makeWorktree(repo, runId) {
  const wtPath = join(repo, ".wao-worktrees", runId);
  execFileSync("git", ["worktree", "add", wtPath, "-b", `wao/${runId}`], { cwd: repo });
  return wtPath;
}

async function cleanupRepo(repo) {
  try { execFileSync("git", ["worktree", "prune"], { cwd: repo }); } catch { /* best effort */ }
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await rm(repo, { recursive: true, force: true }); return; }
    catch { if (attempt === 4) return; await new Promise((r) => setTimeout(r, 50 * (attempt + 1))); }
  }
}

/** Real delivery scenario: source repo + linked worktree + committed DeliveryRef. */
async function buildDeliveryScenario(runId) {
  const { repo, baseCommit } = await makeRepo(`wao-fgown-${runId}-`);
  const wtPath = makeWorktree(repo, runId);
  await writeFile(join(wtPath, "src", "a.js"), "const a = 11;\n");
  await writeFile(join(wtPath, "src", "b.js"), "const b = 22;\n");
  const deliveryRef = packageDelivery({
    runId,
    worktreePath: wtPath,
    baseCommit,
    allowedPaths: ["src"],
    isolation: { type: "worktree", strategy: "persistent" },
    verificationCommands: ["npm test"],
  });
  return { repo, baseCommit, wtPath, deliveryRef };
}

async function writeTranscript(runDir, runId, events) {
  const path = join(runDir, `${runId}.jsonl`);
  await writeFile(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  return path;
}

/** Foreground review transcript: run.started.cwd is the ONLY ownership fact. */
function foregroundReviewEvents(runId, deliveryRef, cwd) {
  return [
    { type: "run.started", runId, cwd, ts: "2026-01-01T00:00:00Z", seq: 1, backend: "claude-code" },
    { type: "run.delivery_created", runId, ts: "2026-01-01T00:00:01Z", seq: 2, delivery: deliveryRef },
    { type: "run.delivery_verification_passed", runId, ts: "2026-01-01T00:00:02Z", seq: 3, delivery: deliveryRef },
    { type: "run.state_change", runId, ts: "2026-01-01T00:00:03Z", seq: 4, from: "running", to: "completed" },
    { type: "run.completed", runId, ts: "2026-01-01T00:00:04Z", seq: 5 },
  ];
}

/** Background review transcript: background_submitted.cwd is the ownership fact. */
function backgroundReviewEvents(runId, deliveryRef, cwd) {
  return [
    { type: "run.started", runId, ts: "2026-01-01T00:00:00Z", seq: 1 },
    { type: "run.background_submitted", runId, cwd, background: true, ts: "2026-01-01T00:00:00Z", seq: 1 },
    { type: "run.delivery_created", runId, ts: "2026-01-01T00:00:01Z", seq: 2, delivery: deliveryRef },
    { type: "run.delivery_verification_passed", runId, ts: "2026-01-01T00:00:02Z", seq: 3, delivery: deliveryRef },
    { type: "run.state_change", runId, ts: "2026-01-01T00:00:03Z", seq: 4, from: "running", to: "completed" },
    { type: "run.completed", runId, ts: "2026-01-01T00:00:04Z", seq: 5 },
  ];
}

async function seedForegroundRun(runDir, runId, workspaceCwd, state = "running", agentId = "coder_low") {
  const t = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId });
  await t.append("run.started", { backend: "claude-code", cwd: workspaceCwd });
  await t.append("session.created", { backend: "process", backendSessionId: "proc_99999" });
  await t.transitionState(null, "pending", "created");
  await t.transitionState("pending", "running", "first_event");
  if (state === "completed") {
    await t.append("run.completed", {});
    await t.transitionState("running", "completed", "done");
  }
}

async function seedBackgroundRun(runDir, runId, workspaceCwd, state = "running", agentId = "coder_low") {
  const t = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId });
  await t.append("run.started", { backend: "claude-code" });
  await t.append("run.background_submitted", { background: true, cwd: workspaceCwd });
  await t.append("session.created", { backend: "process", backendSessionId: "proc_99999" });
  await t.transitionState(null, "pending", "created");
  await t.transitionState("pending", "running", "first_event");
}

function stopDeps() {
  let alive = true; // process starts alive; the kill flips it (SVC-01 mirror)
  return {
    kill: () => { alive = false; return { called: true, exitCode: 0 }; },
    isAlive: () => alive,
    executeStop: async () => ({ verified: true, abortCalled: true, taskkillCalled: false }),
  };
}

// ── FG-OWN-01: valid foreground run is authorized ────────────────────────────

test("M12-14-FG-OWN-01: valid foreground run (started.cwd only) is authorized", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-fgown-01-"));
  try {
    makeGitRepo(dir);
        const events = [simpleEvent("run.started", "run_fgown_01", { cwd: dir })];
    const result = verifyRunWorkspaceOwnership(events, dir, "run_fgown_01");
    assert.equal(result.authorized, true);
    assert.equal(result.ownershipCwd, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── FG-OWN-02/03: delivery review uses the same ownership SSOT ───────────────

test("M12-14-FG-OWN-02: valid foreground delivery is reviewable", async () => {
  const runId = "run_fgown_02";
  const { repo, deliveryRef } = await buildDeliveryScenario(runId);
  const runDir = await mkdtemp(join(tmpdir(), "wao-fgown-02-td-"));
  try {
    await writeTranscript(runDir, runId, foregroundReviewEvents(runId, deliveryRef, repo));
    const target = await resolveRunDeliveryReviewTarget({
      runId, runDir, authorizedWorkspaceRoot: repo, fileIndex: 0,
    });
    assert.equal(target.deliveryCommit, deliveryRef.deliveryCommit);
    assert.equal(target.changedFileCount, deliveryRef.changedFiles.length);
    assert.equal(target.changedPath, deliveryRef.changedFiles.sort()[0]);
  } finally {
    await cleanupRepo(repo);
    await cleanupRepo(runDir);
  }
});

test("M12-14-FG-OWN-03: existing background delivery remains reviewable", async () => {
  const runId = "run_fgown_03";
  const { repo, deliveryRef } = await buildDeliveryScenario(runId);
  const runDir = await mkdtemp(join(tmpdir(), "wao-fgown-03-td-"));
  try {
    await writeTranscript(runDir, runId, backgroundReviewEvents(runId, deliveryRef, repo));
    const target = await resolveRunDeliveryReviewTarget({
      runId, runDir, authorizedWorkspaceRoot: repo, fileIndex: 0,
    });
    assert.equal(target.deliveryCommit, deliveryRef.deliveryCommit);
    assert.equal(target.changedFileCount, deliveryRef.changedFiles.length);
  } finally {
    await cleanupRepo(repo);
    await cleanupRepo(runDir);
  }
});

// ── FG-OWN-04: foreground run appears in the workspace-bound run list ────────

test("M12-14-FG-OWN-04: valid foreground run appears in run list alongside background", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-fgown-04-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-fgown-04-rd-"));
  try {
    makeGitRepo(dir);
    await seedForegroundRun(runDir, "run_fgown_04fg", dir, "running");
    await seedBackgroundRun(runDir, "run_fgown_04bg", dir, "running");
    const { listRuns } = await import("../src/application/runList.js");
    const result = await listRuns({
      runDir,
      authorizedWorkspaceRoot: dir,
      knownAgentIds: ["coder_low"],
    });
    assert.equal(result.matchedCount, 2);
    const ids = result.runs.map((r) => r.runId).sort();
    assert.deepEqual(ids, ["run_fgown_04bg", "run_fgown_04fg"]);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── FG-OWN-05: background authorization unchanged ────────────────────────────

test("M12-14-FG-OWN-05: existing background remains authorized (bare and with started-no-cwd)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-fgown-05-"));
  try {
    makeGitRepo(dir);
        // bare submitted (OWN-05 shape)
    const bare = verifyRunWorkspaceOwnership(
      [simpleEvent("run.background_submitted", "run_fgown_05", { cwd: dir })],
      dir,
      "run_fgown_05",
    );
    assert.equal(bare.authorized, true);
    // backgroundRunner shape: run.started exists but carries NO cwd
    const runner = verifyRunWorkspaceOwnership(
      [
        { type: "run.started", runId: "run_fgown_05", ts: "2026-01-01T00:00:00Z", seq: 1 },
        { type: "run.background_submitted", runId: "run_fgown_05", cwd: dir, ts: "2026-01-01T00:00:01Z", seq: 2 },
      ],
      dir,
      "run_fgown_05",
    );
    assert.equal(runner.authorized, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── FG-OWN-06: duplicate foreground started facts reject ─────────────────────

test("M12-14-FG-OWN-06: duplicate foreground started facts reject before any Git", () => {
  const proofCalls = [];
  const verifier = createVerifierWithSpy(proofCalls);
  const events = [
    simpleEvent("run.started", "run_fgown_06", { cwd: "C:\\Target\\Repo" }),
    { type: "run.started", runId: "run_fgown_06", cwd: "C:\\Target\\Repo", ts: "2026-01-01T00:00:01Z", seq: 2 },
  ];
  assert.throws(() => verifier(events, "run_fgown_06"), /ambiguous/);
  assert.deepEqual(proofCalls, ["C:\\Target\\Repo"], "duplicate rejection must precede any ownership proof (Git)");
});

// ── FG-OWN-07: cross-run started fact does not authorize ─────────────────────

test("M12-14-FG-OWN-07a: a foreign ownership event appearing FIRST cannot authorize", () => {
  // Causal: event ORDER carries no authority — binding is by exact envelope
  // runId equality. A foreign started fact leading the file is not a candidate
  // for the requested run; it fails closed as MISSING, and its cwd never
  // reaches the Git proof.
  const proofCalls = [];
  const verifier = createVerifierWithSpy(proofCalls);
  const events = [
    { type: "run.started", runId: "run_other", cwd: "C:\\Target\\Repo", ts: "2026-01-01T00:00:00Z", seq: 1 },
    { type: "run.state_change", runId: "run_fgown_07", ts: "2026-01-01T00:00:01Z", seq: 2, from: "running", to: "completed" },
  ];
  assert.throws(() => verifier(events, "run_fgown_07"), /missing ownership/);
  assert.deepEqual(proofCalls, ["C:\\Target\\Repo"], "the foreign cwd must never reach the Git proof");
});

test("M12-14-FG-OWN-07c: foreign envelope on a NON-ownership event does not break binding", () => {
  // The ownership check binds only the OWNERSHIP candidates to the requested
  // runId. A foreign envelope on a non-ownership event (e.g. a delivery/
  // reverify fact appended by a consumer) is that consumer's gate to reject —
  // ownership must not preempt it. P3B-15 in runDeliveryReverify pins the
  // consumer side of this contract.
  const proofCalls = [];
  const verifier = createVerifierWithSpy(proofCalls);
  const events = [
    { type: "run.started", runId: "run_fgown_07c", cwd: "C:\\Target\\Repo", ts: "2026-01-01T00:00:00Z", seq: 1 },
    { type: "run.state_change", runId: "run_fgown_07c", ts: "2026-01-01T00:00:01Z", seq: 2, from: "running", to: "completed" },
    { type: "run.delivery_reverification_requested", runId: "run_foreign", ts: "2026-01-01T00:00:02Z", seq: 3 },
  ];
  const result = verifier(events, "run_fgown_07c");
  assert.equal(result.authorized, true);
  assert.equal(result.ownershipCwd, "C:\\Target\\Repo");
});

test("M12-14-FG-OWN-07b: explicit requested runId binding rejects a foreign started fact", () => {
  const proofCalls = [];
  const verifier = createVerifierWithSpy(proofCalls);
  const events = [simpleEvent("run.started", "run_other", { cwd: "C:\\Target\\Repo" })];
  assert.throws(() => verifier(events, "run_fgown_07b"), /missing ownership/);
  assert.deepEqual(proofCalls, ["C:\\Target\\Repo"], "the foreign cwd must never reach the Git proof");
});

// ── FG-OWN-08: background/started disagreement rejects before Git ────────────

test("M12-14-FG-OWN-08a: background/started cwd disagreement (two real dirs) rejects before any Git", () => {
  const dirA = mkdtempSync(join(tmpdir(), "wao-fgown-08a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wao-fgown-08b-"));
  try {
    const proofCalls = [];
    const verifier = createVerifierWithSpy(proofCalls);
    const events = [
      { type: "run.background_submitted", runId: "run_fgown_08", cwd: dirA, ts: "2026-01-01T00:00:00Z", seq: 1 },
      { type: "run.started", runId: "run_fgown_08", cwd: dirB, ts: "2026-01-01T00:00:01Z", seq: 2 },
    ];
    assert.throws(() => verifier(events, "run_fgown_08"), /conflicting/);
    assert.deepEqual(proofCalls, ["C:\\Target\\Repo"], "conflict rejection must precede any ownership proof (Git)");
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("M12-14-FG-OWN-08b: started cwd that cannot agree (nonexistent path) rejects as conflicting", () => {
  const proofCalls = [];
  const verifier = createVerifierWithSpy(proofCalls);
  const events = [
    { type: "run.background_submitted", runId: "run_fgown_08", cwd: "C:\\Target\\Repo", ts: "2026-01-01T00:00:00Z", seq: 1 },
    { type: "run.started", runId: "run_fgown_08", cwd: "C:\\Definitely\\Missing\\Dir", ts: "2026-01-01T00:00:01Z", seq: 2 },
  ];
  assert.throws(() => verifier(events, "run_fgown_08"), /conflicting/);
  assert.deepEqual(proofCalls, ["C:\\Target\\Repo"]);
});

// ── FG-OWN-09: cross-workspace foreground rejects ────────────────────────────

test("M12-14-FG-OWN-09: foreground cross-workspace ownership rejects", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "wao-fgown-09a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wao-fgown-09b-"));
  try {
    makeGitRepo(dirA);
    makeGitRepo(dirB);
        const events = [simpleEvent("run.started", "run_fgown_09", { cwd: dirA })];
    assert.throws(() => verifyRunWorkspaceOwnership(events, dirB, "run_fgown_09"), /mismatch/);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

// ── FG-OWN-10: fixed errors never leak paths ─────────────────────────────────

test("M12-14-FG-OWN-10: fail-closed errors are fixed and never leak paths", () => {
  const tmpLeakProbe = join(tmpdir(), "wao-fgown-10-leak-probe");
  const proofCalls = [];
  const verifier = createVerifierWithSpy(proofCalls);
  const cases = [
    {
      name: "missing",
      events: [],
      pattern: /missing ownership/,
    },
    {
      name: "malformed background cwd",
      events: [simpleEvent("run.background_submitted", "run_fgown_10", {})],
      pattern: /malformed ownership/,
    },
    {
      name: "ambiguous background",
      events: [
        simpleEvent("run.background_submitted", "run_fgown_10", { cwd: "C:\\Target\\Repo" }),
        { type: "run.background_submitted", runId: "run_fgown_10", cwd: "C:\\Target\\Repo", ts: "2026-01-01T00:00:01Z", seq: 2 },
      ],
      pattern: /ambiguous/,
    },
    {
      name: "duplicate foreground started",
      events: [
        simpleEvent("run.started", "run_fgown_10", { cwd: "C:\\Target\\Repo" }),
        { type: "run.started", runId: "run_fgown_10", cwd: "C:\\Target\\Repo", ts: "2026-01-01T00:00:01Z", seq: 2 },
      ],
      pattern: /ambiguous/,
    },
    {
      name: "foreign-only started (cross-run)",
      events: [
        { type: "run.started", runId: "run_other", cwd: "C:\\Target\\Repo", ts: "2026-01-01T00:00:00Z", seq: 1 },
        { type: "run.state_change", runId: "run_fgown_10", ts: "2026-01-01T00:00:01Z", seq: 2, from: "running", to: "completed" },
      ],
      pattern: /missing ownership/,
    },
    {
      name: "conflicting background-vs-started",
      events: [
        { type: "run.background_submitted", runId: "run_fgown_10", cwd: "C:\\Target\\Repo", ts: "2026-01-01T00:00:00Z", seq: 1 },
        { type: "run.started", runId: "run_fgown_10", cwd: "D:\\Other\\Repo", ts: "2026-01-01T00:00:01Z", seq: 2 },
      ],
      pattern: /conflicting/,
    },
    {
      name: "unprovable ownership",
      events: [simpleEvent("run.started", "run_fgown_10", { cwd: "C:\\Missing\\Repo" })],
      pattern: /unprovable ownership workspace/,
    },
    {
      name: "cross-workspace",
      events: [simpleEvent("run.started", "run_fgown_10", { cwd: "D:\\Other\\Repo" })],
      pattern: /workspace mismatch/,
    },
  ];
  for (const c of cases) {
    let message = null;
    try { verifier(c.events, "run_fgown_10"); } catch (err) { message = err.message; }
    assert.ok(message !== null, `case '${c.name}' must throw`);
    assert.match(message, c.pattern, `case '${c.name}' must use a fixed message`);
    assert.ok(!message.includes(tmpLeakProbe), `case '${c.name}' must not leak the probe path`);
    assert.ok(!message.includes("Target\\Repo") && !message.includes("Other\\Repo"),
      `case '${c.name}' must not leak any ownership path`);
  }
});

// ── FG-OWN-11/12: missing-ownership and agreement pins ───────────────────────

test("M12-14-FG-OWN-11: foreground started without cwd is missing ownership", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-fgown-11-"));
  try {
    makeGitRepo(dir);
    const events = [simpleEvent("run.started", "run_fgown_11", { agentId: "coder_low" })];
    assert.equal(findRunWorkspaceOwnership(events, "run_fgown_11"), null);
    assert.throws(() => verifyRunWorkspaceOwnership(events, dir, "run_fgown_11"), /missing ownership/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M12-14-FG-OWN-12: background with agreeing started cwd is authorized", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-fgown-12-"));
  try {
    makeGitRepo(dir);
        const events = [
      { type: "run.background_submitted", runId: "run_fgown_12", cwd: dir, ts: "2026-01-01T00:00:00Z", seq: 1 },
      { type: "run.started", runId: "run_fgown_12", cwd: dir, ts: "2026-01-01T00:00:01Z", seq: 2, backend: "claude-code" },
    ];
    const result = verifyRunWorkspaceOwnership(events, dir, "run_fgown_12");
    assert.equal(result.authorized, true);
    assert.equal(result.ownershipCwd, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── FG-OWN-13: stop authorization keeps the same ownership SSOT ──────────────

test("M12-14-FG-OWN-13a: foreground run passes the stop authorization gate (same SSOT)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-fgown-13-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-fgown-13-rd-"));
  try {
    makeGitRepo(dir);
    await seedForegroundRun(runDir, "run_fgown_13", dir, "running");
    const result = await stopRun({
      runId: "run_fgown_13",
      runDir,
      authorizedWorkspaceRoot: dir,
      deps: stopDeps(),
    });
    assert.notEqual(result.authorized, false, "proven foreground run must NOT be refused by the authorization gate");
    assert.equal(result.sideEffectAttempted, true, "stop proceeds after ownership is proven");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-14-FG-OWN-13b: cross-workspace foreground stop is refused with zero side effects", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "wao-fgown-13a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wao-fgown-13b-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-fgown-13-rdb-"));
  try {
    makeGitRepo(dirA);
    makeGitRepo(dirB);
    await seedForegroundRun(runDir, "run_fgown_13b", dirA, "running");
    const result = await stopRun({
      runId: "run_fgown_13b",
      runDir,
      authorizedWorkspaceRoot: dirB,
      deps: stopDeps(),
    });
    assert.equal(result.authorized, false);
    assert.equal(result.sideEffectAttempted, false, "stop must not weaken authorization for cross-workspace foreground runs");
    assert.equal(result.terminalAccepted, false);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("M12-14-FG-OWN-13c: conflicting background-vs-started facts refuse stop (fail closed)", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "wao-fgown-13c-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wao-fgown-13c-b-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-fgown-13-rdc-"));
  try {
    makeGitRepo(dirA);
    makeGitRepo(dirB);
    const t = new JsonlTranscript(join(runDir, "run_fgown_13c.jsonl"), { runId: "run_fgown_13c", agentId: "coder_low" });
    await t.append("run.started", { backend: "claude-code", cwd: dirB });
    await t.append("run.background_submitted", { background: true, cwd: dirA });
    await t.append("session.created", { backend: "process", backendSessionId: "proc_99999" });
    await t.transitionState(null, "pending", "created");
    await t.transitionState("pending", "running", "first_event");
    const result = await stopRun({
      runId: "run_fgown_13c",
      runDir,
      authorizedWorkspaceRoot: dirA,
      deps: stopDeps(),
    });
    assert.equal(result.authorized, false);
    assert.equal(result.sideEffectAttempted, false);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

// ── FG-OWN-14/15: causal — foreign facts cannot poison; missing fails closed ─

test("M12-14-FG-OWN-14: mixed foreign ownership events do not poison a valid requested-run fact", () => {
  // Causal: a foreign background_submitted (even with a DIFFERENT cwd) is not
  // a candidate for the requested run — it can neither conflict with the
  // requested foreground fact, nor be proved, nor make the transcript
  // ambiguous. The valid requested-run fact authorizes.
  const proofCalls = [];
  const verifier = createVerifierWithSpy(proofCalls);
  const events = [
    { type: "run.background_submitted", runId: "run_other", cwd: "D:\\Other\\Repo", ts: "2026-01-01T00:00:00Z", seq: 1 },
    { type: "run.started", runId: "run_fgown_14", cwd: "C:\\Target\\Repo", ts: "2026-01-01T00:00:01Z", seq: 2 },
    { type: "run.state_change", runId: "run_fgown_14", ts: "2026-01-01T00:00:02Z", seq: 3, from: "running", to: "completed" },
  ];
  const result = verifier(events, "run_fgown_14");
  assert.equal(result.authorized, true);
  assert.equal(result.ownershipCwd, "C:\\Target\\Repo");
  assert.deepEqual(proofCalls, ["C:\\Target\\Repo"], "the foreign cwd must never reach the Git proof");
});

test("M12-14-FG-OWN-15: missing requested-run ownership fails closed", () => {
  // Causal: a requested run with NO ownership fact of its own (only
  // non-ownership events, or only foreign ownership events — see FG-OWN-07a)
  // fails closed with the fixed missing-ownership message.
  const proofCalls = [];
  const verifier = createVerifierWithSpy(proofCalls);
  const events = [
    { type: "run.started", runId: "run_fgown_15", ts: "2026-01-01T00:00:00Z", seq: 1 }, // no cwd — no ownership fact
    { type: "run.state_change", runId: "run_fgown_15", ts: "2026-01-01T00:00:01Z", seq: 2, from: "pending", to: "running" },
  ];
  assert.throws(() => verifier(events, "run_fgown_15"), /missing ownership/);
  assert.deepEqual(proofCalls, ["C:\\Target\\Repo"]);
});

// ── FG-OWN-16/17: legacy runId-less tolerance is bounded ─────────────────────

test("M12-14-FG-OWN-16: runId-less ownership events are attributed when the file is otherwise unbound (legacy)", () => {
  // Legacy tolerance: an ownership event that GENUINELY lacks a runId envelope
  // is attributed to the requested run when no ownership event in the file
  // carries any runId. A stamped NON-ownership envelope (modern writer) does
  // not block attribution.
  const proofCalls = [];
  const verifier = createVerifierWithSpy(proofCalls);
  const events = [
    { type: "run.background_submitted", cwd: "C:\\Target\\Repo", ts: "2026-01-01T00:00:00Z", seq: 1 },
    { type: "run.state_change", runId: "run_fgown_16", ts: "2026-01-01T00:00:01Z", seq: 2, from: "pending", to: "running" },
  ];
  const result = verifier(events, "run_fgown_16");
  assert.equal(result.authorized, true);
  assert.equal(result.ownershipCwd, "C:\\Target\\Repo");
});

test("M12-14-FG-OWN-17: mixed bound+unbound ownership facts fail closed as missing", () => {
  // A file mixing bound (runId-carrying) and unbound ownership facts cannot be
  // attributed safely: the unbound fact could belong to another run. Fail
  // closed (missing) rather than guess — the unbound cwd never reaches Git.
  const proofCalls = [];
  const verifier = createVerifierWithSpy(proofCalls);
  const events = [
    { type: "run.background_submitted", cwd: "C:\\Target\\Repo", ts: "2026-01-01T00:00:00Z", seq: 1 },
    { type: "run.background_submitted", runId: "run_other", cwd: "D:\\Other\\Repo", ts: "2026-01-01T00:00:01Z", seq: 2 },
  ];
  assert.throws(() => verifier(events, "run_fgown_17"), /missing ownership/);
  assert.deepEqual(proofCalls, ["C:\\Target\\Repo"], "neither cwd may reach the Git proof");
});

// ── helper used by the fail-closed tests ─────────────────────────────────────
// The spy proves ONLY the authorized root (verifier construction). Any call
// with an ownership cwd means the finder let an ownership fact reach the Git
// proof — exactly what the "before Git access" tests forbid.

function createVerifierWithSpy(proofCalls) {
  const proveWorkspaceFn = (path) => {
    proofCalls.push(path);
    if (path === "C:\\Target\\Repo" || path === "C:\\TARGET\\REPO") {
      return { root: "C:/Target/Repo", gitHead: "a".repeat(40), dirty: false };
    }
    if (path === "D:\\Other\\Repo") {
      return { root: "D:/Other/Repo", gitHead: "b".repeat(40), dirty: false };
    }
    if (path === "C:\\Missing\\Repo" || path === "C:\\Definitely\\Missing\\Dir") {
      throw new Error("unprovable probe sentinel must not escape");
    }
    throw new Error("probe sentinel: unexpected ownership path reached Git");
  };
  return createRunWorkspaceVerifier("C:\\Target\\Repo", { proveWorkspaceFn });
}
