// test/m12-19-processRecovery.test.js
//
// M12-19: Lead-authorized zero-model delivery recovery after the detached
// runner/provider process disappears.
//
// Causal evidence matrix (RED-first against the SSOT + services):
//   - classifyProcessMissingCandidate: pure durable projection (eligible orphan,
//     every durable rejection incl. pre-existing run.process_missing_confirmed).
//   - proveProcessMissing: runtime liveness (missing/corrupt/fresh/stale owner;
//     child PID alive/dead; EPERM-style unknown rejects).
//   - readOwnerLease: the missing/corrupt/valid freshness/lease SSOT.
//   - isPidAlive consolidation: re-exported from runStop + commands/stop (no
//     second copy); error.code === "ESRCH" is the ONLY dead signal — message
//     text is never authority, EPERM/missing/unknown code/misleading ESRCH
//     message all mean alive.
//   - classifyRecoveryCandidate: the settled process_missing durable record
//     (reason + confirmation fact); lone confirmation/reason-without-pair does
//     NOT classify; backend_failed regression.
//   - getRunDelivery: read-only candidate projection (advisory; zero append;
//     no PID/path leak) and its rejections, incl. a pre-existing confirmation
//     disqualifying a nonterminal orphan BEFORE any mutation.
//   - runDeliveryRepackage: explicit settlement — prove-before-mutate, packages
//     once / verifies once / provenance recoveryKind process_missing / reuses
//     original allowedPaths+base+verificationTimeout; rejected preconditions
//     leave transcript+git unchanged; first-terminal-wins vs concurrent
//     completed rejects; competing process_missing converge; exact runId;
//     pre-existing confirmation rejects BEFORE mutation (zero side effects).
//   - MCP safe projection: run_delivery wire carries candidateKind
//     process_missing + bounded inventory with no PID/path leak; run_delivery_
//     repackage result accepts recoveryKind process_missing through the strict
//     wire schema.
//   - smoke: one synthetic real JSONL transcript driven through the services.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  classifyProcessMissingCandidate,
  proveProcessMissing,
} from "../src/application/processRecovery.js";
import { readOwnerLease, isPidAlive } from "../src/application/ownerLiveness.js";
import {
  classifyRecoveryCandidate,
  RECOVERY_CANDIDATE_KINDS,
  JsonlTranscript,
  readTranscript,
} from "../src/transcript.js";
import { runDeliveryRepackage } from "../src/application/runDeliveryRepackage.js";
import { getRunDelivery, getRunDeliveryReadiness } from "../src/application/runDelivery.js";
import { resolveDeliveryCommit } from "../src/delivery.js";
import { computeCandidateInventory } from "../src/application/candidateInventory.js";

const RUN_ID = "run_m12_19";
const OTHER_RUN = "run_other";
const AGENT_ID = "coder_hq";
const CHILD_PID = 999999;
const OWNER_PID = 888888;

// ── git / transcript helpers ────────────────────────────────────────────────

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
  }).trim();
}

async function cleanupDir(dir) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { await rm(dir, { recursive: true, force: true }); return; } catch {
      if (attempt === 5) return;
      await new Promise((r) => setTimeout(r, 60 * (attempt + 1)));
    }
  }
}

async function makeRepo(prefix = "m12-19-repo-") {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "test@test"], repo);
  git(["config", "user.name", "test"], repo);
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "a.js"), "const a = 1;\n");
  await writeFile(join(repo, ".gitignore"), "node_modules/\n.wao-worktrees/\n");
  git(["add", "."], repo);
  git(["commit", "-m", "init"], repo);
  const baseCommit = git(["rev-parse", "HEAD"], repo);
  return { repo, baseCommit };
}

function makeLinkedWorktree(repo, runId = RUN_ID) {
  const worktreePath = join(repo, ".wao-worktrees", runId);
  git(["worktree", "add", worktreePath, "-b", `wao/${runId}`], repo);
  return worktreePath;
}

function seedTranscript(runDir, runId, events) {
  const filePath = join(runDir, `${runId}.jsonl`);
  const lines = events.map((e, i) => JSON.stringify({
    ts: "2026-08-11T00:00:00.000Z", seq: i + 1, runId, agentId: AGENT_ID, ...e,
  }));
  writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  return filePath;
}

/** Durable facts for a NONTERMINAL process-backed orphan. */
function orphanEvents({
  repo, worktreePath, baseCommit, runId = RUN_ID,
  allowedPaths = ["src"], verificationCommands = ["npm test"],
  verificationUnavailableReason = null, worktreeBranch = `wao/${RUN_ID}`,
  pid = CHILD_PID, backendSessionId, verificationTimeoutMs,
}) {
  const verification = verificationCommands
    ? { verificationCommands }
    : { verificationUnavailableReason };
  return [
    { type: "run.background_submitted", cwd: repo, deliveryRequested: true },
    {
      type: "run.started", backend: "claude-code", cwd: repo,
      worktreePath, worktreeBranch,
      delivery: {
        mode: "git_commit_v1", baseCommit, allowedPaths, ...verification,
        ...(verificationTimeoutMs !== undefined ? { verificationTimeoutMs } : {}),
      },
    },
    {
      type: "session.created", backend: "process",
      backendSessionId: backendSessionId ?? `proc_${pid}`,
    },
    { type: "run.state_change", from: null, to: "pending", reason: "created" },
    { type: "run.state_change", from: "pending", to: "submitted", reason: "spawned" },
    { type: "run.state_change", from: "submitted", to: "running", reason: "first_event" },
  ];
}

// ── liveness fakes ──────────────────────────────────────────────────────────

const deadProbe = () => false;          // every PID proven dead (ESRCH code)
const aliveProbe = () => true;           // every PID alive (EPERM/unknown/no-throw)
const missingLease = () => ({ present: false });
const corruptLease = () => ({ present: true, wellFormed: false });
const freshLease = (pid = OWNER_PID) => () => ({
  present: true, wellFormed: true, fresh: true, heartbeatAt: 5000, pid,
});
const staleLease = (pid = OWNER_PID) => () => ({
  present: true, wellFormed: true, fresh: false, heartbeatAt: 1, pid,
});
/** A probe where exactly the given pids are dead; all others alive. */
function probeDead(deadSet) {
  return (pid) => !deadSet.has(pid);
}
const NOW = () => 100000;

/** Verifier that classifies the delivery as passed without running commands. */
const passedVerifier = async (deliveryRef) => ({
  delivery: {
    ...deliveryRef,
    verification: { ...deliveryRef.verification, status: "passed", verifiedCommit: deliveryRef.deliveryCommit, results: [] },
  },
  outcome: "passed",
});

// =============================================================================
// Group A: classifyProcessMissingCandidate — pure durable projection
// =============================================================================

function baseOrphanFixture(overrides = {}) {
  const evs = orphanEvents({
    repo: "/repo", worktreePath: "/repo/.wao-worktrees/x",
    baseCommit: "b".repeat(40), ...overrides,
  });
  return evs.map((e) => ({ ...e, runId: RUN_ID }));
}

/** A single runId-stamped event for appending to a fixture. */
const ev = (type, extra = {}) => ({ type, runId: RUN_ID, ...extra });

test("A1: eligible orphan → { eligible:true, pid }", () => {
  const r = classifyProcessMissingCandidate(baseOrphanFixture(), RUN_ID);
  assert.equal(r.eligible, true);
  assert.equal(r.pid, CHILD_PID);
});

test("A2: terminal state → ineligible", () => {
  const events = [...baseOrphanFixture(), ev("run.state_change", { from: "running", to: "failed", reason: "x" })];
  assert.equal(classifyProcessMissingCandidate(events, RUN_ID).eligible, false);
});

test("A3: delivery not requested → ineligible", () => {
  const events = baseOrphanFixtureNoRequest();
  assert.equal(classifyProcessMissingCandidate(events, RUN_ID).eligible, false);
});
function baseOrphanFixtureNoRequest() {
  return baseOrphanFixture().map((e) => {
    if (e.type === "run.background_submitted") return { type: "run.background_submitted", runId: RUN_ID, cwd: "/repo" };
    if (e.type === "run.started") {
      const { mode, ...delivery } = e.delivery;
      return { ...e, delivery };
    }
    return e;
  });
}

test("A4: missing / multiple run.started → ineligible", () => {
  const none = baseOrphanFixture().filter((e) => e.type !== "run.started");
  assert.equal(classifyProcessMissingCandidate(none, RUN_ID).eligible, false);
  const two = [...baseOrphanFixture(), ev("run.started", { delivery: { mode: "x", baseCommit: "b".repeat(40), allowedPaths: ["src"] }, worktreePath: "/w" })];
  assert.equal(classifyProcessMissingCandidate(two, RUN_ID).eligible, false);
});

test("A5: run.started contract malformed → ineligible", () => {
  for (const bad of [
    { delivery: { mode: "x", baseCommit: "NOTCANON", allowedPaths: ["src"] }, worktreePath: "/w" },
    { delivery: { mode: "x", baseCommit: "b".repeat(40), allowedPaths: [] }, worktreePath: "/w" },
    { delivery: { mode: "x", baseCommit: "b".repeat(40), allowedPaths: ["src"] }, worktreePath: "" },
    { delivery: { mode: "x", baseCommit: "b".repeat(40), allowedPaths: ["src"] } },
  ]) {
    const events = baseOrphanFixture().map((e) => (e.type === "run.started" ? { ...e, ...bad } : e));
    assert.equal(classifyProcessMissingCandidate(events, RUN_ID).eligible, false);
  }
});

test("A6: missing verification declaration → ineligible", () => {
  const events = baseOrphanFixture().map((e) => (e.type === "run.started"
    ? { ...e, delivery: { mode: "x", baseCommit: "b".repeat(40), allowedPaths: ["src"] } }
    : e));
  assert.equal(classifyProcessMissingCandidate(events, RUN_ID).eligible, false);
});

test("A7: any settled delivery fact → ineligible", () => {
  for (const fact of [
    ev("run.delivery_created"),
    ev("run.delivery_verification_passed"),
    ev("run.delivery_verification_failed"),
    ev("run.delivery_verification_unavailable"),
    ev("run.delivery_accepted"),
    ev("run.delivery_rejected"),
    ev("run.delivery_repackaged"),
    ev("run.delivery_failed", { deliveryCode: "disallowed_path" }),
    // M12-19 correction: the safe confirmation is only ever written atomically
    // with the terminal settlement — a run carrying one is already recovered
    // (or its durable record is corrupt), never a fresh orphan.
    ev("run.process_missing_confirmed"),
  ]) {
    const events = [...baseOrphanFixture(), fact];
    assert.equal(classifyProcessMissingCandidate(events, RUN_ID).eligible, false, fact.type);
  }
});

test("A8: conflict facts → ineligible", () => {
  for (const type of ["run.isolation_violation", "run.budget_exceeded", "run.timed_out", "run.aborted"]) {
    const events = [...baseOrphanFixture(), ev(type)];
    assert.equal(classifyProcessMissingCandidate(events, RUN_ID).eligible, false);
  }
});

test("A9: missing / malformed / multiple session.created → ineligible", () => {
  const noSession = baseOrphanFixture().filter((e) => e.type !== "session.created");
  assert.equal(classifyProcessMissingCandidate(noSession, RUN_ID).eligible, false);
  const bad = baseOrphanFixture({ backendSessionId: "not-proc" });
  assert.equal(classifyProcessMissingCandidate(bad, RUN_ID).eligible, false);
  const two = [...baseOrphanFixture(), ev("session.created", { backend: "process", backendSessionId: "proc_1" })];
  assert.equal(classifyProcessMissingCandidate(two, RUN_ID).eligible, false);
  const zeroPid = baseOrphanFixture({ backendSessionId: "proc_0" });
  assert.equal(classifyProcessMissingCandidate(zeroPid, RUN_ID).eligible, false);
});

test("A10: cross-run binding — foreign-runId events do not satisfy the proof", () => {
  const foreign = baseOrphanFixture().map((e) => ({ ...e, runId: OTHER_RUN }));
  assert.equal(classifyProcessMissingCandidate(foreign, RUN_ID).eligible, false);
});

test("A11: pre-existing bound run.process_missing_confirmed disqualifies a NONTERMINAL candidate (pure projection)", () => {
  // The confirmation fact is only ever written atomically WITH the terminal
  // transition. A nonterminal run carrying one is an inconsistent/corrupt
  // durable record — the pure projection must refuse it, and the runtime proof
  // must short-circuit WITHOUT probing (durable gate first).
  const events = [...baseOrphanFixture(), ev("run.process_missing_confirmed")];
  assert.equal(classifyProcessMissingCandidate(events, RUN_ID).eligible, false);
  let probed = false;
  const r = proveProcessMissing(events, RUN_ID, {
    runDir: "/run", now: NOW(),
    isAliveFn: () => { probed = true; return false; },
    ownerLeaseReader: missingLease,
  });
  assert.equal(r.eligible, false);
  assert.equal(probed, false, "runtime probe must not run when the durable proof already fails");
});

// =============================================================================
// Group B: proveProcessMissing — runtime liveness
// =============================================================================

const RUN_DIR = "/run"; // readOwnerLease is injected, so the dir need not exist

test("B1: missing owner + dead child → eligible", () => {
  const r = proveProcessMissing(baseOrphanFixture(), RUN_ID, {
    runDir: RUN_DIR, now: NOW(), isAliveFn: deadProbe, ownerLeaseReader: missingLease,
  });
  assert.equal(r.eligible, true);
});

test("B2: corrupt owner → ineligible", () => {
  const r = proveProcessMissing(baseOrphanFixture(), RUN_ID, {
    runDir: RUN_DIR, now: NOW(), isAliveFn: deadProbe, ownerLeaseReader: corruptLease,
  });
  assert.equal(r.eligible, false);
});

test("B3: fresh owner → ineligible (owner alive)", () => {
  const r = proveProcessMissing(baseOrphanFixture(), RUN_ID, {
    runDir: RUN_DIR, now: NOW(), isAliveFn: deadProbe, ownerLeaseReader: freshLease(),
  });
  assert.equal(r.eligible, false);
});

test("B4: stale owner + owner alive → ineligible", () => {
  const r = proveProcessMissing(baseOrphanFixture(), RUN_ID, {
    runDir: RUN_DIR, now: NOW(),
    isAliveFn: probeDead(new Set([CHILD_PID])), // child dead, owner alive
    ownerLeaseReader: staleLease(),
  });
  assert.equal(r.eligible, false);
});

test("B5: stale owner + owner dead + child dead → eligible", () => {
  const r = proveProcessMissing(baseOrphanFixture(), RUN_ID, {
    runDir: RUN_DIR, now: NOW(),
    isAliveFn: deadProbe, // both dead
    ownerLeaseReader: staleLease(),
  });
  assert.equal(r.eligible, true);
});

test("B6: child alive (EPERM/unknown) → ineligible", () => {
  const r = proveProcessMissing(baseOrphanFixture(), RUN_ID, {
    runDir: RUN_DIR, now: NOW(), isAliveFn: aliveProbe, ownerLeaseReader: missingLease,
  });
  assert.equal(r.eligible, false);
});

test("B7: durable-ineligible candidate short-circuits (no probe needed)", () => {
  const terminal = [...baseOrphanFixture(), ev("run.state_change", { from: "running", to: "failed", reason: "x" })];
  let probed = false;
  const r = proveProcessMissing(terminal, RUN_ID, {
    runDir: RUN_DIR, now: NOW(),
    isAliveFn: () => { probed = true; return false; },
    ownerLeaseReader: missingLease,
  });
  assert.equal(r.eligible, false);
  assert.equal(probed, false, "runtime probe must not run when the durable proof already fails");
});

test("B8: missing runDir → ineligible", () => {
  const r = proveProcessMissing(baseOrphanFixture(), RUN_ID, { runDir: "", now: NOW() });
  assert.equal(r.eligible, false);
});

// =============================================================================
// Group C: readOwnerLease — missing/corrupt/valid freshness/lease SSOT
// =============================================================================

test("C1: missing owner file → { present:false }", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lease-missing-"));
  try {
    assert.deepEqual(readOwnerLease(dir, RUN_ID, 1000), { present: false });
  } finally { await cleanupDir(dir); }
});

test("C2: corrupt JSON → { present:true, wellFormed:false }", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lease-corrupt-"));
  try {
    writeFileSync(join(dir, `.owner-${RUN_ID}`), "{not json", "utf8");
    assert.deepEqual(readOwnerLease(dir, RUN_ID, 1000), { present: true, wellFormed: false });
  } finally { await cleanupDir(dir); }
});

test("C3: missing/non-numeric heartbeatAt or non-positive pid → wellFormed:false", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lease-bad-"));
  try {
    for (const body of ['{"pid":5}', '{"heartbeatAt":"x","pid":5}', '{"heartbeatAt":1,"pid":0}', '{"heartbeatAt":1,"pid":-3}', '{"heartbeatAt":1}']) {
      writeFileSync(join(dir, `.owner-${RUN_ID}`), body, "utf8");
      assert.deepEqual(readOwnerLease(dir, RUN_ID, 1000), { present: true, wellFormed: false }, body);
    }
  } finally { await cleanupDir(dir); }
});

test("C4: valid + fresh → fresh:true", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lease-fresh-"));
  try {
    writeFileSync(join(dir, `.owner-${RUN_ID}`), JSON.stringify({ pid: OWNER_PID, heartbeatAt: 900 }), "utf8");
    const lease = readOwnerLease(dir, RUN_ID, 1000);
    assert.equal(lease.present, true);
    assert.equal(lease.wellFormed, true);
    assert.equal(lease.fresh, true);
    assert.equal(lease.pid, OWNER_PID);
  } finally { await cleanupDir(dir); }
});

test("C5: valid + stale → fresh:false", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lease-stale-"));
  try {
    writeFileSync(join(dir, `.owner-${RUN_ID}`), JSON.stringify({ pid: OWNER_PID, heartbeatAt: 1 }), "utf8");
    const lease = readOwnerLease(dir, RUN_ID, 50000, 1000);
    assert.equal(lease.wellFormed, true);
    assert.equal(lease.fresh, false);
    assert.equal(lease.pid, OWNER_PID);
  } finally { await cleanupDir(dir); }
});

test("C6: existing checkOwnerLiveness unchanged (regression)", async () => {
  const { checkOwnerLiveness } = await import("../src/application/ownerLiveness.js");
  const dir = await mkdtemp(join(tmpdir(), "lease-regress-"));
  try {
    assert.deepEqual(checkOwnerLiveness(dir, RUN_ID, 1000), { fresh: false, heartbeatAt: null });
    writeFileSync(join(dir, `.owner-${RUN_ID}`), "{bad", "utf8");
    assert.deepEqual(checkOwnerLiveness(dir, RUN_ID, 1000), { fresh: false, heartbeatAt: null });
    writeFileSync(join(dir, `.owner-${RUN_ID}`), JSON.stringify({ pid: OWNER_PID, heartbeatAt: 900 }), "utf8");
    assert.deepEqual(checkOwnerLiveness(dir, RUN_ID, 1000), { fresh: true, heartbeatAt: 900 });
  } finally { await cleanupDir(dir); }
});

// =============================================================================
// Group D: isPidAlive consolidation — one algorithm, re-exported everywhere
// =============================================================================

test("D1: error.code === \"ESRCH\" is the ONLY dead signal — message text is never authority", async () => {
  // Dead ONLY on error.code === "ESRCH".
  const esrch = () => { const e = new Error("boom"); e.code = "ESRCH"; throw e; };
  assert.equal(isPidAlive(1, esrch), false);
  // Misleading ESRCH MESSAGE without the code → alive (never authority).
  assert.equal(isPidAlive(1, () => { throw new Error("ESRCH"); }), true);
  assert.equal(isPidAlive(1, () => { throw new Error("Error: ESRCH"); }), true);
  assert.equal(isPidAlive(1, () => { throw new Error("ESRCH (no such process)"); }), true);
  // EPERM → alive (the process exists but is not ours).
  const eperm = () => { const e = new Error("boom"); e.code = "EPERM"; throw e; };
  assert.equal(isPidAlive(1, eperm), true);
  // Unknown code / missing code → alive (unknown).
  const unknownCode = () => { const e = new Error("boom"); e.code = "UNKNOWN"; throw e; };
  assert.equal(isPidAlive(1, unknownCode), true);
  const noCode = () => { const e = new Error("boom"); throw e; };
  assert.equal(isPidAlive(1, noCode), true);
  // No throw → alive.
  assert.equal(isPidAlive(1, () => {}), true);
});

test("D2: isPidAlive re-exported unchanged from runStop and commands/stop", async () => {
  const { isPidAlive: fromRunStop } = await import("../src/application/runStop.js");
  const { isPidAlive: fromCmdStop } = await import("../src/commands/stop.js");
  const esrch = () => { const e = new Error("boom"); e.code = "ESRCH"; throw e; };
  assert.equal(fromRunStop(1, esrch), false);
  assert.equal(fromCmdStop(1, esrch), false);
  assert.equal(fromRunStop, isPidAlive, "runStop re-exports the SAME binding");
});

// =============================================================================
// Group E: classifyRecoveryCandidate — settled process_missing durable record
// =============================================================================

function settledProcessMissingEvents({ withConfirmation = true, extra = [] } = {}) {
  const base = [
    { type: "run.background_submitted", cwd: "/repo", deliveryRequested: true },
    { type: "run.started", delivery: { mode: "git_commit_v1", baseCommit: "b".repeat(40), allowedPaths: ["src"], verificationCommands: ["npm test"] }, worktreePath: "/w" },
    { type: "session.created", backend: "process", backendSessionId: `proc_${CHILD_PID}` },
    { type: "run.state_change", from: null, to: "pending", reason: "created" },
    { type: "run.state_change", from: "pending", to: "running", reason: "first_event" },
    ...(withConfirmation ? [{ type: "run.process_missing_confirmed" }] : []),
    { type: "run.state_change", from: "running", to: "failed", reason: "process_missing" },
    ...extra,
  ];
  return base.map((ev) => ({ ...ev, runId: RUN_ID }));
}

test("E1: settled process_missing → \"process_missing\"", () => {
  assert.equal(classifyRecoveryCandidate(settledProcessMissingEvents(), RUN_ID), "process_missing");
});

test("E2: process_missing reason WITHOUT confirmation fact → null (defensive)", () => {
  assert.equal(classifyRecoveryCandidate(settledProcessMissingEvents({ withConfirmation: false }), RUN_ID), null);
});

test("E3: process_missing + conflict → null", () => {
  const e = settledProcessMissingEvents({ extra: [{ type: "run.isolation_violation" }] });
  assert.equal(classifyRecoveryCandidate(e, RUN_ID), null);
});

test("E4: process_missing in RECOVERY_CANDIDATE_KINDS closed set", () => {
  assert.ok(RECOVERY_CANDIDATE_KINDS.includes("process_missing"));
});

test("E5: backend_failed + disallowed_scope regression (byte-compatible)", () => {
  const backend = [
    ev("run.started", { delivery: { mode: "x", baseCommit: "b".repeat(40), allowedPaths: ["src"] }, worktreePath: "/w" }),
    ev("run.state_change", { from: null, to: "running", reason: "x" }),
    ev("run.stop_verified"),
    ev("run.state_change", { from: "running", to: "failed", reason: "backend_error" }),
  ];
  assert.equal(classifyRecoveryCandidate(backend, RUN_ID), "backend_failed");
  const disallowed = [ev("run.delivery_failed", { deliveryCode: "disallowed_path" })];
  assert.equal(classifyRecoveryCandidate(disallowed, RUN_ID), "disallowed_scope");
  // nonterminal orphan is NOT a durable recovery kind (liveness is runtime)
  assert.equal(classifyRecoveryCandidate(baseOrphanFixture(), RUN_ID), null);
});

// =============================================================================
// Group F: getRunDelivery — read-only candidate projection
// =============================================================================

test("F1: eligible orphan → candidateKind process_missing + bounded inventory, zero append", async () => {
  const { repo, baseCommit } = await makeRepo("m12-19-f1-");
  const runDir = await mkdtemp(join(tmpdir(), "m12-19-f1-runs-"));
  try {
    const worktreePath = makeLinkedWorktree(repo);
    await writeFile(join(worktreePath, "src", "a.js"), "const a = 2;\n"); // actual change
    const filePath = seedTranscript(runDir, RUN_ID, orphanEvents({ repo, worktreePath, baseCommit }));
    const bytesBefore = readFileSync(filePath, "utf8");

    const view = await getRunDelivery({
      runId: RUN_ID, runDir, authorizedWorkspaceRoot: repo,
      computeInventoryFn: computeCandidateInventory,
      nowFn: NOW, isAliveFn: deadProbe, ownerLeaseReader: missingLease,
    });
    assert.equal(view.candidateKind, "process_missing");
    assert.equal(view.terminalState, "running"); // NOT terminalized (read-only)
    assert.ok(view.candidateInventory);
    assert.ok(view.candidateInventory.actualChangedPaths.includes("src/a.js"));
    assert.equal(view.candidateInventory.actualChangedTruncated, false);

    // Zero transcript append.
    const bytesAfter = readFileSync(filePath, "utf8");
    assert.equal(bytesAfter, bytesBefore, "read-only projection must append nothing");
    // No PID/path leak: the inventory carries only repo-relative candidate paths.
    const wire = JSON.stringify(view.candidateInventory);
    assert.ok(!/proc_|999999|888888/.test(wire), "no PID leak in candidate inventory");
  } finally { await cleanupDir(repo); await cleanupDir(runDir); }
});

test("F2: child alive → no candidate (advisory collapses silently)", async () => {
  const { repo, baseCommit } = await makeRepo("m12-19-f2-");
  const runDir = await mkdtemp(join(tmpdir(), "m12-19-f2-runs-"));
  try {
    const worktreePath = makeLinkedWorktree(repo);
    await writeFile(join(worktreePath, "src", "a.js"), "const a = 2;\n");
    seedTranscript(runDir, RUN_ID, orphanEvents({ repo, worktreePath, baseCommit }));
    for (const [label, deps] of [
      ["child alive", { isAliveFn: aliveProbe, ownerLeaseReader: missingLease }],
      ["fresh owner", { isAliveFn: deadProbe, ownerLeaseReader: freshLease() }],
      ["corrupt owner", { isAliveFn: deadProbe, ownerLeaseReader: corruptLease }],
    ]) {
      const view = await getRunDelivery({
        runId: RUN_ID, runDir, authorizedWorkspaceRoot: repo,
        computeInventoryFn: computeCandidateInventory, nowFn: NOW, ...deps,
      });
      assert.equal(view.candidateKind, null, `${label}: no candidate`);
      assert.equal(view.candidateInventory, null, `${label}: no inventory`);
    }
  } finally { await cleanupDir(repo); await cleanupDir(runDir); }
});

test("F3: missing/malformed session.created → no candidate", async () => {
  const { repo, baseCommit } = await makeRepo("m12-19-f3-");
  const runDir = await mkdtemp(join(tmpdir(), "m12-19-f3-runs-"));
  try {
    const worktreePath = makeLinkedWorktree(repo);
    await writeFile(join(worktreePath, "src", "a.js"), "const a = 2;\n");
    for (const bid of ["not-proc", "proc_0"]) {
      seedTranscript(runDir, RUN_ID, orphanEvents({ repo, worktreePath, baseCommit, backendSessionId: bid }));
      const view = await getRunDelivery({
        runId: RUN_ID, runDir, authorizedWorkspaceRoot: repo,
        computeInventoryFn: computeCandidateInventory, nowFn: NOW,
        isAliveFn: deadProbe, ownerLeaseReader: missingLease,
      });
      assert.equal(view.candidateKind, null, `${bid}: no candidate`);
    }
  } finally { await cleanupDir(repo); await cleanupDir(runDir); }
});

test("F4: pre-existing run.process_missing_confirmed → read-only query projects no candidate, zero append", async () => {
  const { repo, baseCommit } = await makeRepo("m12-19-f4-");
  const runDir = await mkdtemp(join(tmpdir(), "m12-19-f4-runs-"));
  try {
    const worktreePath = makeLinkedWorktree(repo);
    await writeFile(join(worktreePath, "src", "a.js"), "const a = 2;\n");
    const events = [
      ...orphanEvents({ repo, worktreePath, baseCommit }),
      { type: "run.process_missing_confirmed" }, // corrupt/nonterminal record
    ];
    const filePath = seedTranscript(runDir, RUN_ID, events);
    const bytesBefore = readFileSync(filePath, "utf8");
    const view = await getRunDelivery({
      runId: RUN_ID, runDir, authorizedWorkspaceRoot: repo,
      computeInventoryFn: computeCandidateInventory,
      nowFn: NOW, isAliveFn: deadProbe, ownerLeaseReader: missingLease,
    });
    assert.equal(view.candidateKind, null, "pre-existing confirmation disqualifies the nonterminal candidate");
    assert.equal(view.candidateInventory, null);
    assert.equal(view.terminalState, "running", "read-only query still does not terminalize");
    assert.equal(readFileSync(filePath, "utf8"), bytesBefore, "zero append");
  } finally { await cleanupDir(repo); await cleanupDir(runDir); }
});

// =============================================================================
// Group R: getRunDeliveryReadiness — fresh liveness per result build
// (Lead correction / independent review). CAUSAL for the rejected delivery: the
// reference captured nowFn() ONCE at wait entry, so an owner lease that was
// FRESH when the wait started could never become eligible after the clock
// crossed the staleness threshold mid-wait. The correction builds fresh liveness
// deps for EVERY _buildReadinessResult invocation, so the deadline build observes
// the CURRENT clock and the now-stale lease + dead owner/child PIDs make the
// nonterminal orphan eligible. This is the case the rejected delivery got wrong.
// =============================================================================

test("R1: lease fresh at wait start, stale by deadline → waitReturnedEarly=false + candidateKind process_missing", async () => {
  const { repo, baseCommit } = await makeRepo("m12-19-r1-");
  const runDir = await mkdtemp(join(tmpdir(), "m12-19-r1-runs-"));
  try {
    const worktreePath = makeLinkedWorktree(repo);
    await writeFile(join(worktreePath, "src", "a.js"), "const a = 2;\n"); // real non-empty inventory
    const filePath = seedTranscript(runDir, RUN_ID, orphanEvents({ repo, worktreePath, baseCommit }));
    const bytesBefore = readFileSync(filePath, "utf8");

    // Clock starts at START_NOW; the owner lease heartbeatAt is also START_NOW,
    // so the lease is FRESH at wait entry. onPoll advances the clock 20s (past
    // the 10s staleness threshold AND past the deadline) mid-wait, so at the
    // deadline build the SAME lease is STALE. The orphan transcript never
    // changes, so readiness stays waiting_for_packaging and the result is built
    // on the deadline path (waitReturnedEarly=false).
    const START_NOW = 100000;
    const THRESHOLD_MS = 10000;
    const STALE_AT = START_NOW + 20000;
    let clock = START_NOW;
    const nowFn = () => clock;
    let polls = 0;
    const onPoll = () => { polls += 1; clock = STALE_AT; };
    // Valid lease whose freshness is a PURE function of the `now` it is read at
    // (exactly how readOwnerLease behaves against a fixed heartbeatAt).
    const observedNows = [];
    const leaseReader = (_runDir, _runId, now) => {
      observedNows.push(now);
      return {
        present: true, wellFormed: true, pid: OWNER_PID, heartbeatAt: START_NOW,
        fresh: (now - START_NOW) <= THRESHOLD_MS,
      };
    };

    const result = await getRunDeliveryReadiness({
      runId: RUN_ID, runDir, waitMs: 1000,
      authorizedWorkspaceRoot: repo,
      computeInventoryFn: computeCandidateInventory,
      sleepFn: async () => {}, pollIntervalMs: 1000, nowFn, onPoll,
      isAliveFn: deadProbe, ownerLeaseReader: leaseReader,
    });

    // The wait actually polled and advanced the clock mid-wait.
    assert.ok(polls >= 1, "the wait polled (clock advanced mid-wait, not captured at entry)");
    // CAUSAL heartbeat: the deadline build ran its liveness proof at the ADVANCED
    // (stale) clock — impossible when nowFn() is captured once at wait entry.
    assert.ok(Math.max(...observedNows) > START_NOW + THRESHOLD_MS, "a proof ran at the stale clock, not the entry clock");
    assert.equal(result.waitReturnedEarly, false, "settled on the deadline path, not a poll early-return");
    assert.equal(result.terminalState, "running", "transcript stays nonterminal (read-only wait)");
    // The headline the rejected delivery got wrong: fresh-at-entry lease is stale
    // at build time + dead owner/child → the advisory process_missing candidate.
    assert.equal(result.candidateKind, "process_missing");
    assert.ok(result.candidateInventory, "bounded advisory inventory projected at deadline");
    assert.equal(readFileSync(filePath, "utf8"), bytesBefore, "read-only wait appends nothing");
  } finally { await cleanupDir(repo); await cleanupDir(runDir); }
});

// =============================================================================
// Group G: runDeliveryRepackage — explicit settlement
// =============================================================================

async function setupOrphan(prefix) {
  const { repo, baseCommit } = await makeRepo(prefix);
  const runDir = await mkdtemp(join(tmpdir(), prefix + "runs-"));
  const worktreePath = makeLinkedWorktree(repo);
  await writeFile(join(worktreePath, "src", "a.js"), "const a = 2;\n");
  seedTranscript(runDir, RUN_ID, orphanEvents({ repo, worktreePath, baseCommit }));
  return { repo, baseCommit, runDir, worktreePath };
}

test("G1: eligible orphan → settle + package once + verify once + provenance process_missing", async () => {
  const env = await setupOrphan("m12-19-g1-");
  try {
    const filePath = join(env.runDir, `${RUN_ID}.jsonl`);
    const bytesBefore = readFileSync(filePath, "utf8");
    const result = await runDeliveryRepackage({
      runId: RUN_ID, runDir: env.runDir, allowedPaths: ["src"],
      authorizedWorkspaceRoot: env.repo,
      resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier,
      computeInventoryFn: computeCandidateInventory,
      nowFn: NOW, isAliveFn: deadProbe, ownerLeaseReader: missingLease,
    });
    assert.match(result.deliveryCommit, /^[0-9a-f]{40}$/);
    assert.equal(result.verificationStatus, "passed");
    assert.equal(result.source, "packaged");
    assert.equal(result.recoveryKind, "process_missing");
    assert.equal(result.created, true);
    assert.equal(result.verificationRecorded, true);

    const events = await readTranscript(filePath);
    // exactly one confirmation fact + one terminal failed(process_missing)
    assert.equal(events.filter((e) => e.type === "run.process_missing_confirmed").length, 1);
    const failed = events.filter((e) => e.type === "run.state_change" && e.to === "failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].reason, "process_missing");
    // exactly one delivery_created + one verification outcome + one provenance
    assert.equal(events.filter((e) => e.type === "run.delivery_created").length, 1);
    assert.equal(events.filter((e) => e.type === "run.delivery_verification_passed").length, 1);
    assert.equal(events.filter((e) => e.type === "run.delivery_repackaged").length, 1);
    assert.notEqual(readFileSync(filePath, "utf8"), bytesBefore, "transcript advanced");
  } finally { await cleanupDir(env.repo); await cleanupDir(env.runDir); }
});

test("G2: rejected preconditions (child alive) → throw, transcript + git unchanged", async () => {
  const env = await setupOrphan("m12-19-g2-");
  try {
    const filePath = join(env.runDir, `${RUN_ID}.jsonl`);
    const bytesBefore = readFileSync(filePath, "utf8");
    const headBefore = git(["rev-parse", "HEAD"], env.repo);
    await assert.rejects(
      runDeliveryRepackage({
        runId: RUN_ID, runDir: env.runDir, allowedPaths: ["src"],
        authorizedWorkspaceRoot: env.repo,
        resolveDeliveryCommitFn: resolveDeliveryCommit,
        verifyDeliveryFn: passedVerifier,
        computeInventoryFn: computeCandidateInventory,
        nowFn: NOW, isAliveFn: aliveProbe, ownerLeaseReader: missingLease,
      }),
      /process_missing liveness|not recovery-eligible|must be failed/i,
    );
    assert.equal(readFileSync(filePath, "utf8"), bytesBefore, "transcript unchanged");
    assert.equal(git(["rev-parse", "HEAD"], env.repo), headBefore, "repo HEAD unchanged");
    // worktree branch HEAD unchanged too
    assert.equal(git(["rev-parse", "HEAD"], env.worktreePath), env.baseCommit);
  } finally { await cleanupDir(env.repo); await cleanupDir(env.runDir); }
});

test("G3: Lead scope must cover actual changed paths and include original — else reject pre-mutation", async () => {
  const env = await setupOrphan("m12-19-g3-");
  try {
    const filePath = join(env.runDir, `${RUN_ID}.jsonl`);
    const bytesBefore = readFileSync(filePath, "utf8");
    // allowedPaths narrows below the original ["src"] (does not include "src")
    await assert.rejects(
      runDeliveryRepackage({
        runId: RUN_ID, runDir: env.runDir, allowedPaths: ["docs"],
        authorizedWorkspaceRoot: env.repo,
        resolveDeliveryCommitFn: resolveDeliveryCommit,
        verifyDeliveryFn: passedVerifier,
        computeInventoryFn: computeCandidateInventory,
        nowFn: NOW, isAliveFn: deadProbe, ownerLeaseReader: missingLease,
      }),
      /include the original allowedPaths|cover actual changed/i,
    );
    assert.equal(readFileSync(filePath, "utf8"), bytesBefore, "no mutation on rejected scope");
  } finally { await cleanupDir(env.repo); await cleanupDir(env.runDir); }
});

test("G4: first-terminal-wins — a concurrent completed winner rejects packaging", async () => {
  const env = await setupOrphan("m12-19-g4-");
  try {
    const filePath = join(env.runDir, `${RUN_ID}.jsonl`);
    const factoryRacingCompleted = (file, context) => {
      const real = new JsonlTranscript(file, context);
      return {
        transitionState: async (from, to, reason, options) => {
          // A concurrent caller lands a `completed` terminal just before ours.
          await real.append("run.state_change", { from, to: "completed", reason: "concurrent_winner" });
          return real.transitionState(from, to, reason, options);
        },
        tryAppendRepackageCreated: (...a) => real.tryAppendRepackageCreated(...a),
        tryAppendRepackageVerification: (...a) => real.tryAppendRepackageVerification(...a),
      };
    };
    await assert.rejects(
      runDeliveryRepackage({
        runId: RUN_ID, runDir: env.runDir, allowedPaths: ["src"],
        authorizedWorkspaceRoot: env.repo,
        resolveDeliveryCommitFn: resolveDeliveryCommit,
        verifyDeliveryFn: passedVerifier,
        computeInventoryFn: computeCandidateInventory,
        transcriptFactory: factoryRacingCompleted,
        nowFn: NOW, isAliveFn: deadProbe, ownerLeaseReader: missingLease,
      }),
      /concurrent terminal state is not recovery-eligible|must be failed/i,
    );
    // No delivery_created / no commit on the loser path.
    const events = await readTranscript(filePath);
    assert.equal(events.filter((e) => e.type === "run.delivery_created").length, 0);
    assert.equal(git(["rev-parse", "HEAD"], env.worktreePath), env.baseCommit, "worktree not packaged");
  } finally { await cleanupDir(env.repo); await cleanupDir(env.runDir); }
});

test("G5: competing process_missing requests converge — one terminal, one commit, one outcome", async () => {
  const env = await setupOrphan("m12-19-g5-");
  try {
    const filePath = join(env.runDir, `${RUN_ID}.jsonl`);
    // Two real concurrent packages on ONE worktree would race on Git's index/HEAD
    // (the first package moves HEAD off base, breaking the second's exact-base
    // proof). The codebase contract — established by M12-1S2-CONC-SAME — is that
    // concurrent repackages CONVERGE via the lock-scoped CAS layer; the resolver
    // is injectable so the two calls deterministically agree on one ref without
    // real concurrent-Git corruption. This test exercises the process_missing
    // convergence path: Phase -1 first-terminal-wins, then CAS dedup.
    const fakeCommit = "d".repeat(40);
    const fakeRef = {
      schemaVersion: 1, kind: "git_commit", runId: RUN_ID,
      baseCommit: env.baseCommit, deliveryCommit: fakeCommit, branch: `wao/${RUN_ID}`,
      worktreePath: env.worktreePath, changedFiles: ["src/a.js"],
      verification: { status: "pending", commands: ["npm test"] },
      acceptance: { status: "pending", reviewerType: "lead_agent" },
      integration: { status: "pending", targetCommit: null },
    };
    let resolveCalls = 0;
    const fakeResolve = async () => ({
      ref: fakeRef,
      source: resolveCalls++ === 0 ? "packaged" : "recovered",
    });
    let verifyCalls = 0;
    const fakeVerify = async () => {
      const call = verifyCalls++;
      if (call > 0) await new Promise((resolve) => setTimeout(resolve, 40));
      return {
        delivery: {
          ...fakeRef,
          verification: { ...fakeRef.verification, status: "passed", verifiedCommit: fakeCommit, results: [] },
        },
        outcome: "passed",
      };
    };
    const deps = {
      resolveDeliveryCommitFn: fakeResolve,
      verifyDeliveryFn: fakeVerify,
      computeInventoryFn: computeCandidateInventory,
      nowFn: NOW, isAliveFn: deadProbe, ownerLeaseReader: missingLease,
    };
    const [r1, r2] = await Promise.all([
      runDeliveryRepackage({ runId: RUN_ID, runDir: env.runDir, allowedPaths: ["src"], authorizedWorkspaceRoot: env.repo, ...deps }),
      runDeliveryRepackage({ runId: RUN_ID, runDir: env.runDir, allowedPaths: ["src"], authorizedWorkspaceRoot: env.repo, ...deps }),
    ]);
    // Same delivery commit; exactly one created=true (the other yields).
    assert.equal(r1.deliveryCommit, r2.deliveryCommit);
    assert.equal(r1.recoveryKind, "process_missing");
    assert.equal(r2.recoveryKind, "process_missing");
    assert.equal([r1, r2].filter((r) => r.created).length, 1);

    const events = await readTranscript(filePath);
    assert.equal(events.filter((e) => e.type === "run.process_missing_confirmed").length, 1, "one confirmation fact");
    assert.equal(events.filter((e) => e.type === "run.state_change" && e.to === "failed").length, 1, "one terminal failed");
    assert.equal(events.filter((e) => e.type === "run.delivery_created").length, 1, "one delivery_created");
    assert.equal(events.filter((e) => e.type === "run.delivery_verification_passed").length, 1, "one outcome");
  } finally { await cleanupDir(env.repo); await cleanupDir(env.runDir); }
});

test("G6: exact runId / cross-run binding — a foreign runId transcript is not settled", async () => {
  const env = await setupOrphan("m12-19-g6-");
  try {
    const filePath = join(env.runDir, `${RUN_ID}.jsonl`);
    const bytesBefore = readFileSync(filePath, "utf8");
    // Request a DIFFERENT runId than the transcript's bound run.
    await assert.rejects(
      runDeliveryRepackage({
        runId: OTHER_RUN, runDir: env.runDir, allowedPaths: ["src"],
        authorizedWorkspaceRoot: env.repo,
        resolveDeliveryCommitFn: resolveDeliveryCommit,
        verifyDeliveryFn: passedVerifier,
        computeInventoryFn: computeCandidateInventory,
        nowFn: NOW, isAliveFn: deadProbe, ownerLeaseReader: missingLease,
      }),
    );
    assert.equal(readFileSync(filePath, "utf8"), bytesBefore, "foreign-runId request mutates nothing");
  } finally { await cleanupDir(env.repo); await cleanupDir(env.runDir); }
});

test("G7: reuses ORIGINAL allowedPaths/base/verificationTimeout (no drift)", async () => {
  const { repo, baseCommit } = await makeRepo("m12-19-g7-");
  const runDir = await mkdtemp(join(tmpdir(), "m12-19-g7-runs-"));
  try {
    const worktreePath = makeLinkedWorktree(repo);
    await writeFile(join(worktreePath, "src", "a.js"), "const a = 2;\n");
    seedTranscript(runDir, RUN_ID, orphanEvents({
      repo, worktreePath, baseCommit, verificationTimeoutMs: 123456,
    }));
    let observedTimeout;
    const capturingVerifier = async (deliveryRef, opts = {}) => {
      observedTimeout = opts?.timeoutMs;
      return passedVerifier(deliveryRef);
    };
    const result = await runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src"],
      authorizedWorkspaceRoot: repo,
      resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: capturingVerifier,
      computeInventoryFn: computeCandidateInventory,
      nowFn: NOW, isAliveFn: deadProbe, ownerLeaseReader: missingLease,
    });
    assert.equal(result.created, true);
    assert.equal(observedTimeout, 123456, "original verificationTimeoutMs reused, not defaulted");
    const events = await readTranscript(join(runDir, `${RUN_ID}.jsonl`));
    const created = events.find((e) => e.type === "run.delivery_created");
    assert.equal(created.delivery.baseCommit, baseCommit, "reuses original base");
    assert.equal(created.delivery.verification.verificationTimeoutMs, 123456, "created ref preserves declared budget");
  } finally { await cleanupDir(repo); await cleanupDir(runDir); }
});

test("G8: pre-existing run.process_missing_confirmed on a NONTERMINAL run → reject BEFORE mutation (zero side effects)", async () => {
  const env = await setupOrphan("m12-19-g8-");
  try {
    const filePath = join(env.runDir, `${RUN_ID}.jsonl`);
    // A nonterminal run already carrying the safe confirmation fact (corrupt /
    // inconsistent durable record): the confirmation is only ever written
    // atomically WITH the terminal transition, so this candidate must be
    // disqualified BEFORE any mutation — no re-confirmation, no transition,
    // no Git packaging, no inventory-driven write.
    await import("node:fs/promises").then(({ appendFile }) => appendFile(
      filePath,
      `${JSON.stringify({ ts: "2026-08-11T00:00:00.000Z", seq: 99, runId: RUN_ID, agentId: AGENT_ID, type: "run.process_missing_confirmed" })}\n`,
      "utf8",
    ));
    const bytesBefore = readFileSync(filePath, "utf8");
    const headBefore = git(["rev-parse", "HEAD"], env.repo);
    await assert.rejects(
      runDeliveryRepackage({
        runId: RUN_ID, runDir: env.runDir, allowedPaths: ["src"],
        authorizedWorkspaceRoot: env.repo,
        resolveDeliveryCommitFn: resolveDeliveryCommit,
        verifyDeliveryFn: passedVerifier,
        computeInventoryFn: computeCandidateInventory,
        nowFn: NOW, isAliveFn: deadProbe, ownerLeaseReader: missingLease,
      }),
      /process_missing_confirmed already exists/i,
    );
    assert.equal(readFileSync(filePath, "utf8"), bytesBefore, "transcript byte-identical (no re-confirmation/transition)");
    assert.equal(git(["rev-parse", "HEAD"], env.repo), headBefore, "repo HEAD unchanged");
    assert.equal(git(["rev-parse", "HEAD"], env.worktreePath), env.baseCommit, "worktree not packaged");
    // No terminal transition, no created event, no second confirmation.
    const events = await readTranscript(filePath);
    assert.equal(events.filter((e) => e.type === "run.state_change" && e.to === "failed").length, 0);
    assert.equal(events.filter((e) => e.type === "run.delivery_created").length, 0);
    assert.equal(events.filter((e) => e.type === "run.process_missing_confirmed").length, 1, "still exactly the pre-existing fact");
  } finally { await cleanupDir(env.repo); await cleanupDir(env.runDir); }
});

// =============================================================================
// Group M: MCP safe projection — process_missing on the wire, no PID/path leak
// =============================================================================

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-test", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

test("M1: run_delivery wire carries candidateKind process_missing with bounded inventory, no PID/path leak", async () => {
  const { createWaoMcpServer } = await import("../src/mcp/server.js");
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDeliveryFn: async () => ({
      runId: RUN_ID,
      terminalState: "running",
      deliveryAvailable: false,
      deliveryRequested: true,
      deliveryFailure: null,
      candidateKind: "process_missing",
      candidateInventory: {
        originalAllowedPaths: ["src"],
        originalAllowedCount: 1,
        originalAllowedTruncated: false,
        actualChangedPaths: ["src/a.js"],
        actualChangedCount: 1,
        actualChangedTruncated: false,
        disallowedPaths: [],
        disallowedCount: 0,
        disallowedTruncated: false,
      },
    }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_delivery", arguments: { runId: RUN_ID } });
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.equal(parsed.candidateKind, "process_missing");
    assert.ok(parsed.candidateInventory, "bounded inventory on the wire");
    assert.deepEqual(parsed.candidateInventory.actualChangedPaths, ["src/a.js"]);
    assert.equal(parsed.terminalState, "running", "advisory only — never terminalized");
    // No PID/path/error leakage on the wire.
    const dumped = JSON.stringify(res);
    for (const forbidden of ["proc_", String(CHILD_PID), String(OWNER_PID), "999999", "888888", "error"]) {
      assert.ok(!dumped.toLowerCase().includes(forbidden.toLowerCase()), `no ${forbidden} leak`);
    }
  } finally { await client.close(); await server.close(); }
});

test("M2: run_delivery_repackage wire accepts recoveryKind process_missing through the strict schema", async () => {
  const { createWaoMcpServer } = await import("../src/mcp/server.js");
  // The repackage adapter enforces a bound Git workspace before the service is
  // called (M12-1S2 authorization) — provide a committed repo + registry so
  // the wire path runs.
  const { repo } = await makeRepo("m12-19-m2-");
  await writeFile(join(repo, "agents.json"), JSON.stringify({ agents: { w: { backend: "claude-code", cwd: repo } } }), "utf8");
  const server = createWaoMcpServer({
    registryPath: join(repo, "agents.json"), runDir: "/runs", workspaceRoot: repo,
    getRunDeliveryRepackageFn: async () => ({
      runId: RUN_ID,
      deliveryCommit: "d".repeat(40),
      verificationStatus: "passed",
      outcome: "passed",
      source: "packaged",
      recoveryKind: "process_missing",
      created: true,
      verificationRecorded: true,
    }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({
      name: "run_delivery_repackage",
      arguments: { runId: RUN_ID, allowedPaths: ["src"] },
    });
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.equal(parsed.recoveryKind, "process_missing");
    assert.equal(parsed.source, "packaged");
    assert.equal(parsed.created, true);
    const dumped = JSON.stringify(res);
    assert.ok(!dumped.includes("proc_"), "no PID leak");
  } finally { await client.close(); await server.close(); await cleanupDir(repo); }
});

// =============================================================================
// Group H: smoke — synthetic real JSONL through the services (no model)
// =============================================================================

test("H1: smoke — point-in-time projects advisory candidate, then explicit repackage settles it", async () => {
  const { repo, baseCommit } = await makeRepo("m12-19-h1-");
  const runDir = await mkdtemp(join(tmpdir(), "m12-19-h1-runs-"));
  try {
    const worktreePath = makeLinkedWorktree(repo);
    await writeFile(join(worktreePath, "src", "a.js"), "const a = 2;\n");
    seedTranscript(runDir, RUN_ID, orphanEvents({ repo, worktreePath, baseCommit }));

    // 1) Read-only point-in-time query: advisory candidate, no settlement.
    const view = await getRunDelivery({
      runId: RUN_ID, runDir, authorizedWorkspaceRoot: repo,
      computeInventoryFn: computeCandidateInventory,
      nowFn: NOW, isAliveFn: deadProbe, ownerLeaseReader: missingLease,
    });
    assert.equal(view.candidateKind, "process_missing");
    assert.equal(view.terminalState, "running");

    // 2) Lead explicitly settles via repackage.
    const result = await runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src"],
      authorizedWorkspaceRoot: repo,
      resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier,
      computeInventoryFn: computeCandidateInventory,
      nowFn: NOW, isAliveFn: deadProbe, ownerLeaseReader: missingLease,
    });
    assert.equal(result.recoveryKind, "process_missing");
    assert.equal(result.verificationStatus, "passed");

    // 3) After settlement, the read-only query no longer projects an orphan.
    //    A settled run owns a delivery_created (deliveryAvailable=true), so no
    //    candidate branch applies and candidateKind is absent — the same shape
    //    every non-candidate state uses. Assert the orphan is gone, not a
    //    specific null-vs-undefined distinction.
    const after = await getRunDelivery({
      runId: RUN_ID, runDir, authorizedWorkspaceRoot: repo,
      computeInventoryFn: computeCandidateInventory,
      nowFn: NOW, isAliveFn: deadProbe, ownerLeaseReader: missingLease,
    });
    assert.notEqual(after.candidateKind, "process_missing", "orphan candidate no longer projected");
    assert.equal(after.deliveryAvailable, true);
    assert.equal(after.terminalState, "failed"); // settled, not completed
  } finally { await cleanupDir(repo); await cleanupDir(runDir); }
});
