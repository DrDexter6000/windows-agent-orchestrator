// test/runDeliveryReverify.test.js
//
// M12-6 Package 3B: audited unchanged-artifact delivery re-verification —
// application-service TDD tests.
//
// These tests are written RED-first against the not-yet-implemented
// runDeliveryReverify service, the new JsonlTranscript lock-scoped reverify
// appends, the effective-verification projection in validateDeliveryFacts, and
// the reverify-aware Lead acceptance gate.
//
// Hard contract exercised:
//   - A Lead may request ONE audited re-verification of the SAME immutable
//     DeliveryRef after an environment/tooling-invalid verification failure.
//   - The Lead may ADD only setup commands; the ORIGINAL assertion commands are
//     re-run BYTE-FOR-BYTE against the EXACT same delivery commit. No model, no
//     worker resume, no command replacement, no auto accept/reject.
//   - Eligibility is durable + runId-bound: exactly one usable delivery_created,
//     exactly one original final verification outcome that FAILED with an
//     eligible code (command_failed/command_timeout/execution_error/setup_failed/
//     setup_timeout/setup_environment_error), no Lead decision, unchanged exact
//     delivery identity. Never reverify passed/unavailable/artifact_mutated/
//     artifact_mismatch/ambiguous/cross-run/malformed/already-decided/missing.
//   - Append-only audit chain: ONE run.delivery_reverification_requested and
//     exactly ONE final run.delivery_reverification_passed|failed|unavailable,
//     all runId/delivery-identity bound. One chain maximum. Reentrant retries
//     converge; request-without-outcome resumes after crash. Concurrent calls
//     produce no duplicate events. Verification runs OUTSIDE the transcript lock.
//   - The ORIGINAL verification truth remains projectable; getRunDelivery gains
//     additive original/effective verification fields + reverify reason/status.
//   - tryAppendDecision/validateDeliveryFacts ACCEPT based on the valid effective
//     passed reverify; a failed reverify remains non-acceptable. No auto decision.
//   - Safe result identifies runId, deliveryCommit, created/resumed/idempotent
//     state, reason, effective status/failure code ONLY — never commands, paths,
//     stderr, secrets, or environment internals.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, appendFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { runDeliveryReverify } from "../src/application/runDeliveryReverify.js";
import { resolveDeliveryCommit } from "../src/delivery.js";
import { verifyDelivery } from "../src/deliveryVerification.js";
import { getRunDelivery, decideRunDelivery } from "../src/application/runDelivery.js";
import {
  JsonlTranscript,
  validateDeliveryFacts,
  REVERIFY_REASONS,
} from "../src/transcript.js";

const RUN_ID = "run_m12p3b_test";
const AGENT_ID = "coder_hq";

// ===== git / fs helpers (mirror runDeliveryRepackage.test.js) =====

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  }).trim();
}

async function cleanupDir(dir) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      if (attempt === 5) return;
      await new Promise((r) => setTimeout(r, 60 * (attempt + 1)));
    }
  }
}

async function makeRepo(prefix = "m12p3b-repo-") {
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
    ts: "2026-08-01T00:00:00.000Z",
    seq: i + 1,
    runId,
    agentId: AGENT_ID,
    ...e,
  }));
  writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  return filePath;
}

function readEvents(runDir, runId = RUN_ID) {
  const raw = readFileSync(join(runDir, `${runId}.jsonl`), "utf8");
  return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

// ===== command-runner fakes =====
//
// The command STRINGS are tokens the fake interprets. verifyDelivery still runs
// assertCommittedDeliveryRef (real Git) before/after each command, so the
// worktree is a real linked worktree at the exact delivery commit. This makes the
// tests causal + deterministic without shell-quoting flakiness.
//   "setup-prepare"   — a Lead reverify setup command (the env fix).
//   "assert-needs-setup" — the ORIGINAL assertion; passes only after setup ran.

function ok() {
  return { exitCode: 0, signal: null, timedOut: false, durationMs: 1, stdoutBytes: 0, stderrBytes: 0 };
}
function fail() {
  return { exitCode: 1, signal: null, timedOut: false, durationMs: 1, stdoutBytes: 0, stderrBytes: 0 };
}

/** After "setup-prepare" runs, "assert-needs-setup" flips to passing. */
function makeFixingRunCommand() {
  let setupRan = false;
  return async (command) => {
    if (command === "setup-prepare") { setupRan = true; return ok(); }
    if (command === "assert-needs-setup") return setupRan ? ok() : fail();
    return fail();
  };
}

/** A setup command that mutates a TRACKED artifact → artifact_mutated. */
function makeMutatingRunCommand() {
  return async (command, cwd) => {
    if (command === "setup-prepare") {
      await appendFile(join(cwd, "src", "a.js"), "mutation\n");
      return ok();
    }
    return ok();
  };
}

/** Always-failing assertion (original command_failed that setup cannot fix). */
function makeAlwaysFailingRunCommand() {
  return async () => fail();
}

function realVerifierWith(runCommand) {
  return (deliveryRef, opts) => verifyDelivery(deliveryRef, { ...opts, runCommand });
}

// ===== scenario setup =====

function verificationEventType(status) {
  if (status === "passed") return "run.delivery_verification_passed";
  if (status === "unavailable") return "run.delivery_verification_unavailable";
  return "run.delivery_verification_failed";
}

/**
 * Build a real committed delivery + a transcript whose ORIGINAL verification
 * FAILED with `originalFailureCode` (eligible by default). The worktree stays at
 * the exact delivery commit so reverify can re-run assertions there.
 */
async function setupReverifyScenario({
  runId = RUN_ID,
  originalCommands = ["assert-needs-setup"],
  originalSetupCommands = [],
  originalStatus = "failed",
  originalFailureCode = "command_failed",
  extraEvents = [],
  allowedPaths = ["src"],
} = {}) {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "m12p3b-runs-"));
  const worktreePath = makeLinkedWorktree(repo, runId);
  // A real change within allowedPaths, left UNSTAGED so the packager owns staging.
  await writeFile(join(worktreePath, "src", "a.js"), "const a = 2;\n");

  const deliveryInput = {
    runId,
    worktreePath,
    baseCommit,
    isolation: { type: "worktree", strategy: "persistent" },
    allowedPaths,
    ...(originalCommands.length > 0
      ? { verificationCommands: originalCommands }
      : { verificationUnavailableReason: "no_assertions" }),
    ...(originalSetupCommands.length > 0 ? { verificationSetupCommands: originalSetupCommands } : {}),
  };
  const { ref: deliveryRef } = resolveDeliveryCommit(deliveryInput);
  const deliveryCommit = deliveryRef.deliveryCommit;

  const originalVerificationRef = {
    ...deliveryRef,
    verification: {
      ...deliveryRef.verification,
      status: originalStatus,
      ...(originalStatus === "failed" ? { failureCode: originalFailureCode } : {}),
      ...(originalStatus === "unavailable" ? { unavailableReason: "no_assertions" } : {}),
      verifiedCommit: deliveryCommit,
      results: [],
    },
  };

  const events = [
    { type: "run.background_submitted", cwd: repo, deliveryRequested: true },
    {
      type: "run.started",
      backend: "test",
      cwd: repo,
      worktreePath,
      worktreeBranch: `wao/${runId}`,
      delivery: {
        mode: "git_commit_v1",
        baseCommit,
        allowedPaths,
        ...(originalCommands.length > 0
          ? { verificationCommands: originalCommands }
          : { verificationUnavailableReason: "no_assertions" }),
        ...(originalSetupCommands.length > 0 ? { verificationSetupCommands: originalSetupCommands } : {}),
      },
    },
    { type: "run.delivery_created", delivery: deliveryRef, deliveryCommit },
    { type: "run.completed" },
    { type: "run.state_change", from: "running", to: "completed", reason: "completed" },
    { type: verificationEventType(originalStatus), delivery: originalVerificationRef, deliveryCommit },
    ...extraEvents,
  ];
  seedTranscript(runDir, runId, events);
  return { repo, baseCommit, runDir, worktreePath, deliveryRef, deliveryCommit };
}

// =====================================================================
// Group 1: the happy causal path — original failed → reverify effective passed
// =====================================================================

test("P3B-01: original command_failed + tooling_invalid + added setup → same commit, original assertions identical, one requested + one outcome, effective passed, original failed still visible", async () => {
  const ctx = await setupReverifyScenario();
  try {
    const before = readEvents(ctx.runDir);
    // Original truth: exactly one failed verification, no reverify chain yet.
    const facts0 = validateDeliveryFacts(before);
    assert.equal(facts0.verificationStatus, "failed");
    assert.equal(facts0.effectiveVerificationStatus, "failed");
    assert.equal(facts0.reverifyStatus, "none");

    const result = await runDeliveryReverify({
      runId: RUN_ID,
      runDir: ctx.runDir,
      authorizedWorkspaceRoot: ctx.repo,
      reason: "tooling_invalid",
      setupCommands: ["setup-prepare"],
      verifyDeliveryFn: realVerifierWith(makeFixingRunCommand()),
    });

    // Safe result: bounded fields only.
    assert.equal(result.runId, RUN_ID);
    assert.equal(result.deliveryCommit, ctx.deliveryCommit, "same immutable delivery commit");
    assert.equal(result.reason, "tooling_invalid");
    assert.equal(result.verificationStatus, "passed", "effective verification passed");
    assert.equal(result.state, "created");
    assert.equal(result.requested, true);
    assert.equal(result.outcomeRecorded, true);
    assert.equal(result.failureCode, undefined, "no failureCode on passed");

    const after = readEvents(ctx.runDir);
    const requested = after.filter((e) => e.type === "run.delivery_reverification_requested");
    const outcomes = after.filter((e) => e.type.startsWith("run.delivery_reverification_") && e.type !== "run.delivery_reverification_requested");
    assert.equal(requested.length, 1, "exactly one requested event");
    assert.equal(outcomes.length, 1, "exactly one outcome event");
    assert.equal(outcomes[0].type, "run.delivery_reverification_passed");
    // Delivery-identity bound: same deliveryCommit on every reverify event.
    assert.equal(requested[0].deliveryCommit, ctx.deliveryCommit);
    assert.equal(outcomes[0].deliveryCommit, ctx.deliveryCommit);

    // ORIGINAL assertions re-run byte-for-byte: the passed outcome ref carries
    // the ORIGINAL assertion commands unchanged.
    assert.deepEqual(outcomes[0].delivery.verification.commands, ["assert-needs-setup"]);
    // The NEW setup is recorded on the effective ref (setup was declared).
    assert.deepEqual(outcomes[0].delivery.verification.setupCommands, ["setup-prepare"]);

    // Original verification truth remains projectable.
    const orig = after.filter((e) => e.type === "run.delivery_verification_failed");
    assert.equal(orig.length, 1, "original failed event untouched");
    assert.equal(orig[0].delivery.verification.status, "failed");
    assert.equal(orig[0].delivery.verification.failureCode, "command_failed");
  } finally {
    await cleanupDir(ctx.repo);
    await cleanupDir(ctx.runDir);
  }
});

// =====================================================================
// Group 2: accept ONLY via an explicit Lead call (never automatic)
// =====================================================================

test("P3B-02: before reverify, accept is rejected (original failed); after effective passed, an explicit Lead accept succeeds; WAO never auto-accepts", async () => {
  const ctx = await setupReverifyScenario();
  try {
    // Before reverify: original failed → accept must fail closed.
    await assert.rejects(
      () => decideRunDelivery({ runId: RUN_ID, runDir: ctx.runDir, decision: "accepted", reason: "looks ok" }),
      /must be passed/i,
    );

    await runDeliveryReverify({
      runId: RUN_ID,
      runDir: ctx.runDir,
      authorizedWorkspaceRoot: ctx.repo,
      reason: "tooling_invalid",
      setupCommands: ["setup-prepare"],
      verifyDeliveryFn: realVerifierWith(makeFixingRunCommand()),
    });

    // The reverify appended a chain but did NOT append any decision.
    const mid = readEvents(ctx.runDir);
    assert.equal(mid.filter((e) => e.type === "run.delivery_accepted").length, 0, "no auto-accept");

    // An EXPLICIT Lead accept now succeeds (effective passed, terminal completed).
    const decision = await decideRunDelivery({ runId: RUN_ID, runDir: ctx.runDir, decision: "accepted", reason: "effective verification passed" });
    assert.equal(decision.accepted, true);
    // First-decision-wins preserved: a second accept loses without error.
    const again = await decideRunDelivery({ runId: RUN_ID, runDir: ctx.runDir, decision: "rejected", reason: "changed mind" });
    assert.equal(again.accepted, false);
    assert.equal(again.existing.status, "accepted");
  } finally {
    await cleanupDir(ctx.repo);
    await cleanupDir(ctx.runDir);
  }
});

// =====================================================================
// Group 3: a FAILED reverify stays non-acceptable (effective failed)
// =====================================================================

test("P3B-03: a failed reverify (setup cannot fix) keeps effective failed and remains non-acceptable", async () => {
  const ctx = await setupReverifyScenario();
  try {
    const result = await runDeliveryReverify({
      runId: RUN_ID,
      runDir: ctx.runDir,
      authorizedWorkspaceRoot: ctx.repo,
      reason: "environment_contaminated",
      setupCommands: ["setup-prepare"],
      // Setup runs (passes) but the assertion still fails → command_failed.
      verifyDeliveryFn: realVerifierWith(async (command) => (command === "setup-prepare" ? ok() : fail())),
    });
    assert.equal(result.verificationStatus, "failed");
    assert.equal(result.failureCode, "command_failed");

    // Accept must still fail closed (effective failed).
    await assert.rejects(
      () => decideRunDelivery({ runId: RUN_ID, runDir: ctx.runDir, decision: "accepted", reason: "no" }),
      /must be passed/i,
    );
    // Reject is still allowed.
    const reject = await decideRunDelivery({ runId: RUN_ID, runDir: ctx.runDir, decision: "rejected", reason: "still failing" });
    assert.equal(reject.accepted, true);
  } finally {
    await cleanupDir(ctx.repo);
    await cleanupDir(ctx.runDir);
  }
});

// =====================================================================
// Group 4: reverify setup mutating a tracked artifact → artifact_mutated
// =====================================================================

test("P3B-04: reverify setup that mutates a tracked artifact → outcome failed/artifact_mutated, cannot accept", async () => {
  const ctx = await setupReverifyScenario();
  try {
    const result = await runDeliveryReverify({
      runId: RUN_ID,
      runDir: ctx.runDir,
      authorizedWorkspaceRoot: ctx.repo,
      reason: "dependency_setup_missing",
      setupCommands: ["setup-prepare"],
      verifyDeliveryFn: realVerifierWith(makeMutatingRunCommand()),
    });
    assert.equal(result.verificationStatus, "failed");
    assert.equal(result.failureCode, "artifact_mutated");
    // The worktree was left dirty by the mutating setup; clean it so the accept
    // gate's later assertCommittedDeliveryRef paths are deterministic. The point
    // under test is that artifact_mutated is recorded and stays non-acceptable.
    await assert.rejects(
      () => decideRunDelivery({ runId: RUN_ID, runDir: ctx.runDir, decision: "accepted", reason: "no" }),
      /must be passed/i,
    );
  } finally {
    await cleanupDir(ctx.repo);
    await cleanupDir(ctx.runDir);
  }
});

// =====================================================================
// Group 5: ineligible originals reject BEFORE verifier execution + append
// =====================================================================

test("P3B-05: ineligible original outcomes reject before verifier + append (artifact_mutated / artifact_mismatch / passed / unavailable / already-decided / missing / cross-run)", async () => {
  let calls = 0;
  const countingVerifier = (ref, opts) => { calls += 1; return realVerifierWith(makeFixingRunCommand())(ref, opts); };

  // artifact_mutated original
  {
    const ctx = await setupReverifyScenario({ originalFailureCode: "artifact_mutated" });
    try {
      await assert.rejects(
        () => runDeliveryReverify({ runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo, reason: "tooling_invalid", setupCommands: ["setup-prepare"], verifyDeliveryFn: countingVerifier }),
        /not eligible|must be failed|eligible/i,
      );
      assert.equal(readEvents(ctx.runDir).filter((e) => e.type === "run.delivery_reverification_requested").length, 0, "no requested appended (artifact_mutated)");
    } finally { await cleanupDir(ctx.repo); await cleanupDir(ctx.runDir); }
  }
  // artifact_mismatch original
  {
    const ctx = await setupReverifyScenario({ originalFailureCode: "artifact_mismatch" });
    try {
      await assert.rejects(
        () => runDeliveryReverify({ runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo, reason: "tooling_invalid", setupCommands: ["setup-prepare"], verifyDeliveryFn: countingVerifier }),
        /eligible/i,
      );
    } finally { await cleanupDir(ctx.repo); await cleanupDir(ctx.runDir); }
  }
  // passed original
  {
    const ctx = await setupReverifyScenario({ originalStatus: "passed" });
    try {
      await assert.rejects(
        () => runDeliveryReverify({ runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo, reason: "tooling_invalid", setupCommands: ["setup-prepare"], verifyDeliveryFn: countingVerifier }),
        /must be failed|eligible/i,
      );
    } finally { await cleanupDir(ctx.repo); await cleanupDir(ctx.runDir); }
  }
  // unavailable original
  {
    const ctx = await setupReverifyScenario({ originalStatus: "unavailable", originalCommands: [] });
    try {
      await assert.rejects(
        () => runDeliveryReverify({ runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo, reason: "tooling_invalid", verifyDeliveryFn: countingVerifier }),
        /must be failed|eligible|commands/i,
      );
    } finally { await cleanupDir(ctx.repo); await cleanupDir(ctx.runDir); }
  }
  // already-decided (proper)
  {
    const ctx = await setupReverifyScenario();
    try {
      // Append a real rejected decision first.
      await decideRunDelivery({ runId: RUN_ID, runDir: ctx.runDir, decision: "rejected", reason: "nope" });
      await assert.rejects(
        () => runDeliveryReverify({ runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo, reason: "tooling_invalid", setupCommands: ["setup-prepare"], verifyDeliveryFn: countingVerifier }),
        /decision/i,
      );
    } finally { await cleanupDir(ctx.repo); await cleanupDir(ctx.runDir); }
  }
  // missing delivery (no delivery_created). A real Git workspace so workspace
  // ownership proof passes and the DELIVERY-facts error is what surfaces.
  {
    const { repo } = await makeRepo();
    const runDir = await mkdtemp(join(tmpdir(), "m12p3b-runs-"));
    try {
      seedTranscript(runDir, RUN_ID, [
        { type: "run.background_submitted", cwd: repo, deliveryRequested: true },
      ]);
      await assert.rejects(
        () => runDeliveryReverify({ runId: RUN_ID, runDir, authorizedWorkspaceRoot: repo, reason: "tooling_invalid", verifyDeliveryFn: countingVerifier }),
        /delivery|created|eligible/i,
      );
    } finally { await cleanupDir(repo); await cleanupDir(runDir); }
  }
  // cross-run / commit mismatch: verification deliveryCommit != created deliveryCommit
  {
    const ctx = await setupReverifyScenario();
    try {
      const events = readEvents(ctx.runDir);
      const vIdx = events.findIndex((e) => e.type === "run.delivery_verification_failed");
      // Mutate the verification event's deliveryCommit to a different canonical hash.
      events[vIdx] = { ...events[vIdx], deliveryCommit: "e".repeat(40), delivery: { ...events[vIdx].delivery, deliveryCommit: "e".repeat(40) } };
      writeFileSync(join(ctx.runDir, `${RUN_ID}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
      await assert.rejects(
        () => runDeliveryReverify({ runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo, reason: "tooling_invalid", setupCommands: ["setup-prepare"], verifyDeliveryFn: countingVerifier }),
        /match|eligible|ambiguous/i,
      );
    } finally { await cleanupDir(ctx.repo); await cleanupDir(ctx.runDir); }
  }
  // Verifier must never have run for any ineligible case.
  assert.equal(calls, 0, "verifier never executed for ineligible originals");
});

// =====================================================================
// Group 6: reentrant + concurrent → exactly one requested + one outcome
// =====================================================================

test("P3B-06: repeated calls converge on one requested + one outcome (idempotent)", async () => {
  const ctx = await setupReverifyScenario();
  try {
    const r1 = await runDeliveryReverify({ runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo, reason: "tooling_invalid", setupCommands: ["setup-prepare"], verifyDeliveryFn: realVerifierWith(makeFixingRunCommand()) });
    const r2 = await runDeliveryReverify({ runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo, reason: "tooling_invalid", setupCommands: ["setup-prepare"], verifyDeliveryFn: realVerifierWith(makeFixingRunCommand()) });
    assert.equal(r1.state, "created");
    assert.equal(r2.state, "idempotent");
    assert.equal(r2.requested, false);
    assert.equal(r2.outcomeRecorded, false);
    const after = readEvents(ctx.runDir);
    assert.equal(after.filter((e) => e.type === "run.delivery_reverification_requested").length, 1);
    assert.equal(after.filter((e) => e.type === "run.delivery_reverification_passed").length, 1);
  } finally {
    await cleanupDir(ctx.repo);
    await cleanupDir(ctx.runDir);
  }
});

test("P3B-07: concurrent calls produce one requested + one outcome", async () => {
  const ctx = await setupReverifyScenario();
  try {
    const call = () => runDeliveryReverify({ runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo, reason: "tooling_invalid", setupCommands: ["setup-prepare"], verifyDeliveryFn: realVerifierWith(makeFixingRunCommand()) });
    const [a, b] = await Promise.all([call(), call()]);
    // Both succeed (one created, one idempotent/resumed) — never duplicate events.
    const states = new Set([a.state, b.state]);
    assert.ok(states.has("created"), "one caller created the chain");
    const after = readEvents(ctx.runDir);
    assert.equal(after.filter((e) => e.type === "run.delivery_reverification_requested").length, 1, "one requested");
    assert.equal(after.filter((e) => e.type === "run.delivery_reverification_passed").length, 1, "one outcome");
  } finally {
    await cleanupDir(ctx.repo);
    await cleanupDir(ctx.runDir);
  }
});

// =====================================================================
// Group 7: crash recovery — request-without-outcome resumes without a 2nd request
// =====================================================================

test("P3B-08: a requested event without an outcome resumes (no second requested event)", async () => {
  const ctx = await setupReverifyScenario();
  try {
    // Simulate a crash AFTER requested was appended but BEFORE the outcome: append
    // the requested event directly via the transcript primitive.
    const events = readEvents(ctx.runDir);
    const context = { runId: RUN_ID, agentId: AGENT_ID, initialSeq: events.length };
    const t = new JsonlTranscript(join(ctx.runDir, `${RUN_ID}.jsonl`), context);
    await t.tryAppendReverifyRequested({
      delivery: ctx.deliveryRef,
      reason: "tooling_invalid",
      setupCommands: ["setup-prepare"],
    });
    const afterReq = readEvents(ctx.runDir);
    assert.equal(afterReq.filter((e) => e.type === "run.delivery_reverification_requested").length, 1);
    assert.equal(afterReq.filter((e) => e.type === "run.delivery_reverification_passed").length, 0, "no outcome yet");

    // A retry resumes: uses the RECORDED setup, verifies, appends exactly one outcome.
    const result = await runDeliveryReverify({ runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo, reason: "tooling_invalid", setupCommands: ["setup-prepare"], verifyDeliveryFn: realVerifierWith(makeFixingRunCommand()) });
    assert.equal(result.state, "resumed");
    assert.equal(result.requested, false);
    assert.equal(result.outcomeRecorded, true);

    const final = readEvents(ctx.runDir);
    assert.equal(final.filter((e) => e.type === "run.delivery_reverification_requested").length, 1, "still one requested");
    assert.equal(final.filter((e) => e.type === "run.delivery_reverification_passed").length, 1, "one outcome");
  } finally {
    await cleanupDir(ctx.repo);
    await cleanupDir(ctx.runDir);
  }
});

// =====================================================================
// Group 8: fail-closed on bad input (unknown reason / unsafe setup / bad timeout)
// =====================================================================

test("P3B-09: unknown reason / unsafe setup / non-positive / fractional timeout fail closed before append", async () => {
  const ctx = await setupReverifyScenario();
  try {
    const base = { runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo, verifyDeliveryFn: realVerifierWith(makeFixingRunCommand()) };
    // unknown reason
    await assert.rejects(() => runDeliveryReverify({ ...base, reason: "not_a_real_reason", setupCommands: ["setup-prepare"] }), /reason/i);
    // unsafe setup: empty string entry
    await assert.rejects(() => runDeliveryReverify({ ...base, reason: "tooling_invalid", setupCommands: [""] }), /setup|command/i);
    // unsafe setup: non-string entry
    await assert.rejects(() => runDeliveryReverify({ ...base, reason: "tooling_invalid", setupCommands: ["ok", 7] }), /setup|command/i);
    // unsafe setup: too many entries
    await assert.rejects(() => runDeliveryReverify({ ...base, reason: "tooling_invalid", setupCommands: Array.from({ length: 33 }, () => "x") }), /setup|limit|exceed/i);
    // non-positive timeout
    await assert.rejects(() => runDeliveryReverify({ ...base, reason: "tooling_invalid", setupCommands: ["setup-prepare"], timeoutMs: 0 }), /timeout/i);
    await assert.rejects(() => runDeliveryReverify({ ...base, reason: "tooling_invalid", setupCommands: ["setup-prepare"], timeoutMs: -5 }), /timeout/i);
    // fractional timeout
    await assert.rejects(() => runDeliveryReverify({ ...base, reason: "tooling_invalid", setupCommands: ["setup-prepare"], timeoutMs: 1.5 }), /timeout/i);
    // Nothing was appended for any of these.
    assert.equal(readEvents(ctx.runDir).filter((e) => e.type.startsWith("run.delivery_reverification")).length, 0);
  } finally {
    await cleanupDir(ctx.repo);
    await cleanupDir(ctx.runDir);
  }
});

test("P3B-10: invalid runId and missing workspace root fail closed", async () => {
  const ctx = await setupReverifyScenario();
  try {
    await assert.rejects(
      () => runDeliveryReverify({ runId: "bad runId", runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo, reason: "tooling_invalid" }),
      /runId/i,
    );
    await assert.rejects(
      () => runDeliveryReverify({ runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: "", reason: "tooling_invalid" }),
      /workspace/i,
    );
  } finally {
    await cleanupDir(ctx.repo);
    await cleanupDir(ctx.runDir);
  }
});

// =====================================================================
// Group 9: getRunDelivery additive projection (original + effective + reverify)
// =====================================================================

test("P3B-11: getRunDelivery projects original verification + additive effective/reverify fields; existing callers stay byte-compatible", async () => {
  const ctx = await setupReverifyScenario();
  try {
    // Before reverify: effective == original == failed; reverify status none.
    const before = await getRunDelivery({ runId: RUN_ID, runDir: ctx.runDir });
    assert.equal(before.verification.status, "failed", "original status unchanged");
    assert.equal(before.effectiveVerification.status, "failed");
    assert.equal(before.reverify.status, "none");

    await runDeliveryReverify({ runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo, reason: "tooling_invalid", setupCommands: ["setup-prepare"], verifyDeliveryFn: realVerifierWith(makeFixingRunCommand()) });

    const after = await getRunDelivery({ runId: RUN_ID, runDir: ctx.runDir });
    // ORIGINAL truth still projectable.
    assert.equal(after.verification.status, "failed", "original failed still visible");
    assert.equal(after.verification.failureCode, "command_failed");
    // ADDITIVE effective truth.
    assert.equal(after.effectiveVerification.status, "passed");
    assert.equal(after.reverify.status, "complete");
    assert.equal(after.reverify.reason, "tooling_invalid");
    // Existing fields stay byte-compatible (delivery commit unchanged).
    assert.equal(after.deliveryCommit ?? after.deliveryRef?.deliveryCommit, ctx.deliveryCommit);
  } finally {
    await cleanupDir(ctx.repo);
    await cleanupDir(ctx.runDir);
  }
});

// =====================================================================
// Group 10: no-setup reverify (original assertions only) is allowed
// =====================================================================

test("P3B-12: reverify with no new setup (original assertions only) is allowed and re-runs byte-for-byte", async () => {
  // Original failed with setup_timeout; reverify re-runs the SAME assertions with
  // NO setup override (setup is dropped). A fixing verifier that passes the
  // assertion models the environment having been repaired out-of-band.
  const ctx = await setupReverifyScenario({ originalFailureCode: "setup_timeout", originalSetupCommands: ["old-setup"] });
  try {
    const result = await runDeliveryReverify({
      runId: RUN_ID,
      runDir: ctx.runDir,
      authorizedWorkspaceRoot: ctx.repo,
      reason: "environment_contaminated",
      // No setupCommands: re-run original assertions only.
      verifyDeliveryFn: realVerifierWith(async (command) => command === "assert-needs-setup" ? ok() : fail()),
    });
    assert.equal(result.verificationStatus, "passed");
    const after = readEvents(ctx.runDir);
    const outcome = after.find((e) => e.type === "run.delivery_reverification_passed");
    assert.deepEqual(outcome.delivery.verification.commands, ["assert-needs-setup"]);
    // No setup was declared for the reverify, so none is persisted on the ref.
    assert.equal(outcome.delivery.verification.setupCommands, undefined);
  } finally {
    await cleanupDir(ctx.repo);
    await cleanupDir(ctx.runDir);
  }
});

// =====================================================================
// Group 11: the reason closed set is frozen
// =====================================================================

test("P3B-13: REVERIFY_REASONS is the frozen closed set containing the three required reasons", () => {
  assert.ok(Object.isFrozen(REVERIFY_REASONS));
  for (const r of ["tooling_invalid", "environment_contaminated", "dependency_setup_missing"]) {
    assert.ok(REVERIFY_REASONS.includes(r), `contains ${r}`);
  }
});

// =====================================================================
// Group 12 (M12-6 Package 3B1): fail-closed + identity-bound durable chain
// =====================================================================

test("P3B-14: when a concurrent caller records the final outcome, the loser reports the durable winner's truth (state idempotent, never created) — verification runs OUTSIDE the transcript lock", async () => {
  const ctx = await setupReverifyScenario();
  try {
    const filePath = join(ctx.runDir, `${RUN_ID}.jsonl`);
    let competitorRecorded = false;
    const competingVerifier = async (ref) => {
      // Simulate a concurrent caller completing the chain WHILE this call is
      // still verifying. This is a lock-scoped CAS append — it would deadlock
      // (5s append-lock timeout) if runDeliveryReverify held the transcript
      // lock during verification. Succeeding here proves contract #5: the
      // verifier executes outside the lock.
      const t = new JsonlTranscript(filePath, {
        runId: RUN_ID,
        agentId: AGENT_ID,
        initialSeq: readEvents(ctx.runDir).length,
      });
      const res = await t.tryAppendReverifyOutcome({ delivery: ref, outcome: "passed" });
      competitorRecorded = res.recorded;
      return { delivery: ref, outcome: "passed", failureCode: undefined };
    };

    const result = await runDeliveryReverify({
      runId: RUN_ID,
      runDir: ctx.runDir,
      authorizedWorkspaceRoot: ctx.repo,
      reason: "tooling_invalid",
      setupCommands: ["setup-prepare"],
      verifyDeliveryFn: competingVerifier,
    });

    assert.equal(competitorRecorded, true, "the concurrent caller recorded the final outcome first");
    assert.equal(result.requested, true, "this call created the requested event");
    assert.equal(result.outcomeRecorded, false, "this call did NOT record the outcome");
    assert.equal(result.state, "idempotent", "the loser must not claim created — the final outcome is the durable winner's");
    assert.equal(result.verificationStatus, "passed", "reports the durable winner's outcome");
    const after = readEvents(ctx.runDir);
    assert.equal(after.filter((e) => e.type === "run.delivery_reverification_requested").length, 1, "one requested");
    assert.equal(after.filter((e) => e.type === "run.delivery_reverification_passed").length, 1, "one outcome");
  } finally {
    await cleanupDir(ctx.repo);
    await cleanupDir(ctx.runDir);
  }
});

test("P3B-15: malformed durable reverify chains (unknown reason / blank setup / foreign envelope / identity mismatch) fail closed BEFORE the verifier runs and append nothing", async () => {
  const makeCountingVerifier = () => {
    let calls = 0;
    const v = (ref, opts) => {
      calls += 1;
      return realVerifierWith(makeFixingRunCommand())(ref, opts);
    };
    return { count: () => calls, v };
  };
  const seedAfter = (ctx, extraEvents) => {
    const all = readEvents(ctx.runDir);
    all.push(...extraEvents.map((e, i) => ({
      ts: "2026-08-01T00:01:00.000Z",
      seq: all.length + i + 1,
      runId: RUN_ID,
      agentId: AGENT_ID,
      ...e,
    })));
    writeFileSync(join(ctx.runDir, `${RUN_ID}.jsonl`), all.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  };
  const reverifyCount = (runDir) => readEvents(runDir).filter((e) => e.type.startsWith("run.delivery_reverification")).length;
  const base = (ctx) => ({
    runId: RUN_ID,
    runDir: ctx.runDir,
    authorizedWorkspaceRoot: ctx.repo,
    reason: "tooling_invalid",
    setupCommands: ["setup-prepare"],
  });

  // 1. Persisted request with UNKNOWN reason + a passed outcome. Today this
  //    short-circuits as "idempotent" with effective passed — it must instead
  //    fail closed, and the verifier must never run.
  {
    const ctx = await setupReverifyScenario();
    try {
      const { count, v } = makeCountingVerifier();
      seedAfter(ctx, [
        { type: "run.delivery_reverification_requested", delivery: ctx.deliveryRef, deliveryCommit: ctx.deliveryCommit, reason: "not_a_real_reason" },
        {
          type: "run.delivery_reverification_passed",
          delivery: { ...ctx.deliveryRef, verification: { status: "passed", commands: ["assert-needs-setup"], verifiedCommit: ctx.deliveryCommit, results: [] } },
          deliveryCommit: ctx.deliveryCommit,
        },
      ]);
      await assert.rejects(
        () => runDeliveryReverify({ ...base(ctx), verifyDeliveryFn: v }),
        /malformed|reason/i,
      );
      assert.equal(count(), 0, "verifier never executed for an unknown-reason request");
      assert.equal(reverifyCount(ctx.runDir), 2, "nothing appended to the malformed chain");
    } finally { await cleanupDir(ctx.repo); await cleanupDir(ctx.runDir); }
  }
  // 2. Persisted request with a BLANK setup command.
  {
    const ctx = await setupReverifyScenario();
    try {
      const { count, v } = makeCountingVerifier();
      seedAfter(ctx, [
        { type: "run.delivery_reverification_requested", delivery: ctx.deliveryRef, deliveryCommit: ctx.deliveryCommit, reason: "tooling_invalid", setupCommands: ["  "] },
      ]);
      await assert.rejects(
        () => runDeliveryReverify({ ...base(ctx), verifyDeliveryFn: v }),
        /malformed|setup|reason/i,
      );
      assert.equal(count(), 0, "verifier never executed for a blank setup command");
      assert.equal(reverifyCount(ctx.runDir), 1, "nothing appended");
    } finally { await cleanupDir(ctx.repo); await cleanupDir(ctx.runDir); }
  }
  // 3. FOREIGN-ENVELOPE requested event whose embedded DeliveryRef targets this
  //    run (valid reason + identity): must be a visible conflict, not ignored.
  {
    const ctx = await setupReverifyScenario();
    try {
      const { count, v } = makeCountingVerifier();
      seedAfter(ctx, [
        { type: "run.delivery_reverification_requested", runId: "run_foreign", delivery: ctx.deliveryRef, deliveryCommit: ctx.deliveryCommit, reason: "tooling_invalid" },
      ]);
      await assert.rejects(
        () => runDeliveryReverify({ ...base(ctx), verifyDeliveryFn: v }),
        /malformed|conflict|chain/i,
      );
      assert.equal(count(), 0, "verifier never executed on a foreign-envelope request");
      assert.equal(reverifyCount(ctx.runDir), 1, "no second request appended");
    } finally { await cleanupDir(ctx.repo); await cleanupDir(ctx.runDir); }
  }
  // 4. FOREIGN-ENVELOPE passed outcome whose embedded DeliveryRef targets this
  //    run: must be a visible conflict, never treated as pending/complete.
  {
    const ctx = await setupReverifyScenario();
    try {
      const { count, v } = makeCountingVerifier();
      seedAfter(ctx, [
        {
          type: "run.delivery_reverification_passed",
          runId: "run_foreign",
          delivery: { ...ctx.deliveryRef, verification: { status: "passed", commands: ["assert-needs-setup"], verifiedCommit: ctx.deliveryCommit, results: [] } },
          deliveryCommit: ctx.deliveryCommit,
        },
      ]);
      await assert.rejects(
        () => runDeliveryReverify({ ...base(ctx), verifyDeliveryFn: v }),
        /malformed|conflict|chain/i,
      );
      assert.equal(count(), 0, "verifier never executed on a foreign-envelope outcome");
      assert.equal(reverifyCount(ctx.runDir), 1, "nothing appended");
    } finally { await cleanupDir(ctx.repo); await cleanupDir(ctx.runDir); }
  }
  // 5. Envelope-bound outcome with MISMATCHED embedded identity (different
  //    canonical deliveryCommit): today the verifier RUNS and only the outcome
  //    CAS throws afterwards — the chain gate must catch it before execution.
  {
    const ctx = await setupReverifyScenario();
    try {
      const { count, v } = makeCountingVerifier();
      seedAfter(ctx, [
        {
          type: "run.delivery_reverification_passed",
          runId: RUN_ID,
          delivery: { ...ctx.deliveryRef, deliveryCommit: "e".repeat(40) },
          deliveryCommit: "e".repeat(40),
        },
      ]);
      await assert.rejects(
        () => runDeliveryReverify({ ...base(ctx), verifyDeliveryFn: v }),
        /malformed|identity|another delivery|chain/i,
      );
      assert.equal(count(), 0, "verifier never executed on an identity-mismatched outcome");
      assert.equal(reverifyCount(ctx.runDir), 1, "nothing appended");
    } finally { await cleanupDir(ctx.repo); await cleanupDir(ctx.runDir); }
  }
});
