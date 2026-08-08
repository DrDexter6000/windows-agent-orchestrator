// test/runDeliveryRepackage.test.js
//
// M12-1S2: model-free delivery repackage for a retained disallowed_path
// packaging failure — application-service TDD tests.
//
// These tests are written RED-first against the not-yet-implemented
// runDeliveryRepackage service, the new delivery.js resolveDeliveryCommit
// helper, the new JsonlTranscript lock-scoped idempotent appends, and the
// recovery-aware projection/decide gate.
//
// Hard boundaries exercised:
//   - Reuses the original run's persisted worktree/base/verification config;
//     never calls a model, never resumes a worker, never infers paths, never
//     modifies verification commands, never auto accepts/rejects.
//   - Recomputes the full candidate inventory; rejects on read-fail/truncate/
//     empty; new allowedPaths must include the original scope and cover every
//     actual changed path.
//   - Reentrant, crash-recoverable, concurrency-safe: exactly one
//     run.delivery_created and exactly one final verification outcome for the
//     same input; different scopes never overwrite each other.
//   - No long lock: packaging/verification run outside the transcript lock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { runDeliveryRepackage } from "../src/application/runDeliveryRepackage.js";
import { resolveDeliveryCommit } from "../src/delivery.js";
import { verifyDelivery } from "../src/deliveryVerification.js";
import { computeCandidateInventory } from "../src/application/candidateInventory.js";
import { getRunDelivery, getRunDeliveryReadiness } from "../src/application/runDelivery.js";
import { decideRunDelivery } from "../src/application/runDelivery.js";
import { JsonlTranscript, readTranscript } from "../src/transcript.js";

const RUN_ID = "run_m12s2_test";
const AGENT_ID = "coder_hq";

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

/** Create a real temp git repo with src/a.js committed. */
async function makeRepo(prefix = "m12s2-repo-") {
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

/** Create a real persistent linked worktree on branch wao/<runId> at HEAD. */
function makeLinkedWorktree(repo, runId = RUN_ID) {
  const worktreePath = join(repo, ".wao-worktrees", runId);
  git(["worktree", "add", worktreePath, "-b", `wao/${runId}`], repo);
  return worktreePath;
}

function seedTranscript(runDir, runId, events) {
  const filePath = join(runDir, `${runId}.jsonl`);
  const lines = events.map((e, i) => JSON.stringify({
    ts: "2026-07-01T00:00:00.000Z",
    seq: i + 1,
    runId,
    agentId: AGENT_ID,
    ...e,
  }));
  writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  return filePath;
}

/**
 * Durable transcript facts for a failed delivery run whose packaging failed as
 * disallowed_path. The run.started delivery context carries the ORIGINAL
 * allowedPaths + verification declaration that repackage must reuse verbatim.
 */
function disallowedPathEvents({
  repo,
  worktreePath,
  baseCommit,
  allowedPaths = ["src"],
  verificationCommands = ["npm test"],
  verificationUnavailableReason = null,
  deliveryCode = "disallowed_path",
  verificationTimeoutMs = undefined,
}) {
  const verification = verificationCommands
    ? { verificationCommands }
    : { verificationUnavailableReason };
  return [
    { type: "run.background_submitted", cwd: repo, deliveryRequested: true },
    {
      type: "run.started",
      backend: "test",
      cwd: repo,
      worktreePath,
      worktreeBranch: `wao/${RUN_ID}`,
      delivery: {
        mode: "git_commit_v1",
        baseCommit,
        allowedPaths,
        ...verification,
        // M12-13: the original per-command execution budget is persisted on
        // run.started.delivery.verificationTimeoutMs. Only included when declared
        // (zero drift when absent); malformed values are seeded deliberately in
        // the fail-closed causal tests below.
        ...(verificationTimeoutMs !== undefined ? { verificationTimeoutMs } : {}),
      },
    },
    { type: "run.state_change", from: null, to: "pending", reason: "created" },
    { type: "run.state_change", from: "pending", to: "running", reason: "spawned" },
    { type: "run.delivery_failed", deliveryCode, message: "changes outside allowedPaths detected" },
    { type: "run.error", phase: "delivery", deliveryCode },
    { type: "run.state_change", from: "running", to: "failed", reason: "delivery_failed" },
  ];
}

/** Fake verifier that classifies the delivery as passed without running commands. */
const passedVerifier = async (deliveryRef) => ({
  delivery: {
    ...deliveryRef,
    verification: {
      ...deliveryRef.verification,
      status: "passed",
      verifiedCommit: deliveryRef.deliveryCommit,
      results: [],
    },
  },
  outcome: "passed",
});

const failedVerifier = async (deliveryRef) => ({
  delivery: {
    ...deliveryRef,
    verification: {
      ...deliveryRef.verification,
      status: "failed",
      failureCode: "command_failed",
      verifiedCommit: deliveryRef.deliveryCommit,
      results: [],
    },
  },
  outcome: "failed",
  failureCode: "command_failed",
});

/** Real verifier kernel with an injected runCommand (deterministic, no shell). */
function realVerifierWith(runCommand) {
  return (deliveryRef) => verifyDelivery(deliveryRef, { runCommand });
}

/**
 * Set up a complete disallowed_path scenario: repo + linked worktree at base,
 * a change OUTSIDE the original allowedPaths (so the original packaging failed),
 * and a seeded failed transcript. Returns everything the repackage needs.
 */
async function setupDisallowedScenario({
  allowedPaths = ["src"],
  verificationCommands = ["npm test"],
  verificationUnavailableReason = null,
  verificationTimeoutMs = undefined,
} = {}) {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "m12s2-runs-"));
  const worktreePath = makeLinkedWorktree(repo);
  // A real disallowed change: a new file at the repo root (outside "src").
  await writeFile(join(worktreePath, "root.txt"), "root change\n");
  // Plus an allowed change so the diff is non-empty within scope too.
  await writeFile(join(worktreePath, "src", "a.js"), "const a = 2;\n");
  seedTranscript(runDir, RUN_ID, disallowedPathEvents({
    repo, worktreePath, baseCommit, allowedPaths, verificationCommands,
    verificationUnavailableReason, verificationTimeoutMs,
  }));
  return { repo, baseCommit, runDir, worktreePath };
}

function backendFailureEvents({
  repo,
  worktreePath,
  baseCommit,
  reason = "backend_error",
  allowedPaths = ["src"],
  verificationCommands = ["npm test"],
  extraEvents = [],
  includeStopVerified = true,
  deliveryRequested = true,
  includeDeliveryContext = true,
}) {
  return [
    { type: "run.background_submitted", cwd: repo, deliveryRequested },
    {
      type: "run.started",
      backend: "test",
      cwd: repo,
      worktreePath,
      worktreeBranch: `wao/${RUN_ID}`,
      ...(includeDeliveryContext ? { delivery: {
        mode: "git_commit_v1",
        baseCommit,
        allowedPaths,
        verificationCommands,
      } } : {}),
    },
    { type: "run.state_change", from: null, to: "pending", reason: "created" },
    { type: "run.state_change", from: "pending", to: "running", reason: "spawned" },
    ...extraEvents,
    { type: "run.state_change", from: "running", to: "failed", reason },
    ...(includeStopVerified ? [{ type: "run.stop_verified", path: "_runCleanup" }] : []),
  ];
}

async function setupBackendFailureScenario({
  reason = "backend_error",
  extraEvents = [],
  includeStopVerified = true,
  deliveryRequested = true,
  includeDeliveryContext = true,
} = {}) {
  const { repo, baseCommit } = await makeRepo("m124a-repo-");
  const runDir = await mkdtemp(join(tmpdir(), "m124a-runs-"));
  const worktreePath = makeLinkedWorktree(repo);
  await writeFile(join(worktreePath, "src", "a.js"), "const a = 42;\n");
  seedTranscript(runDir, RUN_ID, backendFailureEvents({
    repo,
    worktreePath,
    baseCommit,
    reason,
    extraEvents,
    includeStopVerified,
    deliveryRequested,
    includeDeliveryContext,
  }));
  return { repo, baseCommit, runDir, worktreePath };
}

function readEvents(runDir, runId = RUN_ID) {
  return readTranscript(join(runDir, `${runId}.jsonl`));
}

test("M12-4A-RED-OK: backend-failed retained candidate is projected and repackaged without a model", async () => {
  for (const reason of ["backend_error", "backend_stream_ended"]) {
    const { repo, baseCommit, runDir } = await setupBackendFailureScenario({ reason });
    try {
      const before = await getRunDelivery({
        runId: RUN_ID,
        runDir,
        authorizedWorkspaceRoot: repo,
        computeInventoryFn: computeCandidateInventory,
      });
      assert.equal(before.terminalState, "failed");
      assert.equal(before.deliveryAvailable, false);
      assert.equal(before.deliveryFailure, null);
      assert.equal(before.candidateKind, "backend_failed");
      assert.deepEqual(before.candidateInventory.actualChangedPaths, ["src/a.js"]);
      assert.equal(before.candidateInventory.actualChangedTruncated, false);

      const result = await runDeliveryRepackage({
        runId: RUN_ID,
        runDir,
        allowedPaths: ["src"],
        authorizedWorkspaceRoot: repo,
        resolveDeliveryCommitFn: resolveDeliveryCommit,
        verifyDeliveryFn: passedVerifier,
        computeInventoryFn: computeCandidateInventory,
      });
      assert.equal(result.recoveryKind, "backend_failed");
      assert.equal(result.verificationStatus, "passed");

      const retry = await runDeliveryRepackage({
        runId: RUN_ID,
        runDir,
        allowedPaths: ["src"],
        authorizedWorkspaceRoot: repo,
        resolveDeliveryCommitFn: resolveDeliveryCommit,
        verifyDeliveryFn: passedVerifier,
        computeInventoryFn: computeCandidateInventory,
      });
      assert.equal(retry.deliveryCommit, result.deliveryCommit);
      assert.equal(retry.created, false);
      assert.equal(retry.verificationRecorded, false);
      assert.equal(retry.recoveryKind, "backend_failed");

      const events = await readEvents(runDir);
      const provenance = events.find((event) => event.type === "run.delivery_repackaged");
      assert.equal(provenance.recoveryKind, "backend_failed");
      assert.equal(events.filter((event) => event.type === "run.delivery_created").length, 1);
      assert.equal(events.filter((event) => event.type === "run.delivery_verification_passed").length, 1);
      assert.equal(events.filter(
        (event) => event.type === "run.state_change" && event.to === "failed",
      ).length, 1);

      const after = await getRunDelivery({
        runId: RUN_ID,
        runDir,
        authorizedWorkspaceRoot: repo,
        computeInventoryFn: computeCandidateInventory,
      });
      assert.equal(after.deliveryAvailable, true);
      assert.equal(after.deliveryRef.baseCommit, baseCommit);
      assert.equal(after.verification.status, "passed");

      const acceptance = await decideRunDelivery({
        runId: RUN_ID,
        runDir,
        decision: "accepted",
        reason: "backend recovery reviewed",
      });
      assert.equal(acceptance.accepted, true);
      const finalEvents = await readEvents(runDir);
      assert.equal(finalEvents.filter((event) => event.type === "run.delivery_accepted").length, 1);
    } finally {
      await cleanupDir(repo);
      await cleanupDir(runDir);
    }
  }
});

test("M12-4A-RED-GATES: backend candidate requires quiet stop, exact base, complete non-empty diff, and no conflicts", async () => {
  const cases = [
    {
      name: "missing stop_verified",
      setup: { includeStopVerified: false },
    },
    {
      name: "stop_unverified",
      setup: { extraEvents: [{ type: "run.stop_unverified", outcome: "still_running" }] },
    },
    {
      // M12-13: the durable isolation fact carries the flat top-level code the
      // system writes (runManager appends { code: "workdir_escape" }); the query
      // stays unambiguous and surfaces isolationFailure — and this run is NOT a
      // recovery candidate (candidateInventory stays null, repackage rejects).
      name: "isolation conflict",
      setup: { extraEvents: [{ type: "run.isolation_violation", code: "workdir_escape" }] },
    },
    {
      // M12-13: a violation WITHOUT a classifiable code is a malformed isolation
      // fact — the delivery view fails closed to ambiguous at the query
      // (identical to the malformed matrix in m12-13-isolation-failure IR-02).
      name: "malformed isolation violation (no code) → ambiguous",
      setup: { extraEvents: [{ type: "run.isolation_violation" }] },
      queryRejects: true,
    },
    {
      name: "failed scorecard",
      setup: { extraEvents: [{ type: "scorecard.checked", passed: false }] },
    },
    {
      name: "budget conflict",
      setup: { extraEvents: [{ type: "run.budget_exceeded" }] },
    },
    {
      name: "timeout conflict",
      setup: { extraEvents: [{ type: "run.timed_out" }] },
    },
    {
      name: "abort conflict",
      setup: { extraEvents: [{ type: "run.aborted" }] },
    },
    {
      name: "non-backend terminal reason",
      setup: { reason: "scorecard_fail" },
    },
    {
      name: "multiple terminal transitions",
      setup: {
        extraEvents: [{
          type: "run.state_change",
          from: "running",
          to: "failed",
          reason: "backend_error",
        }],
      },
    },
    {
      name: "delivery not requested",
      setup: { deliveryRequested: false, includeDeliveryContext: false },
    },
    {
      name: "existing Lead acceptance",
      setup: { extraEvents: [{ type: "run.delivery_accepted" }] },
      queryRejects: true,
    },
    {
      name: "existing Lead rejection",
      setup: { extraEvents: [{ type: "run.delivery_rejected" }] },
      queryRejects: true,
    },
    {
      name: "orphan recovery provenance",
      setup: {
        extraEvents: [{
          type: "run.delivery_repackaged",
          source: "packaged",
          recoveryKind: "backend_failed",
        }],
      },
    },
  ];

  for (const item of cases) {
    const { repo, runDir } = await setupBackendFailureScenario(item.setup);
    try {
      if (item.queryRejects) {
        await assert.rejects(() => getRunDelivery({
          runId: RUN_ID,
          runDir,
          authorizedWorkspaceRoot: repo,
          computeInventoryFn: computeCandidateInventory,
        }), /ambiguous/, item.name);
      } else {
        const view = await getRunDelivery({
          runId: RUN_ID,
          runDir,
          authorizedWorkspaceRoot: repo,
          computeInventoryFn: computeCandidateInventory,
        });
        assert.equal(view.candidateInventory ?? null, null, item.name);
        assert.equal(view.candidateKind ?? null, null, item.name);
      }
      await assert.rejects(
        () => runDeliveryRepackage({
          runId: RUN_ID,
          runDir,
          allowedPaths: ["src"],
          authorizedWorkspaceRoot: repo,
          resolveDeliveryCommitFn: resolveDeliveryCommit,
          verifyDeliveryFn: passedVerifier,
          computeInventoryFn: computeCandidateInventory,
        }),
        /runDeliveryRepackage/,
        item.name,
      );
    } finally {
      await cleanupDir(repo);
      await cleanupDir(runDir);
    }
  }

  const drift = await setupBackendFailureScenario();
  try {
    git(["commit", "--allow-empty", "-m", "advance"], drift.worktreePath);
    const view = await getRunDelivery({
      runId: RUN_ID,
      runDir: drift.runDir,
      authorizedWorkspaceRoot: drift.repo,
      computeInventoryFn: computeCandidateInventory,
    });
    assert.equal(view.candidateInventory ?? null, null);
    await assert.rejects(() => runDeliveryRepackage({
      runId: RUN_ID,
      runDir: drift.runDir,
      allowedPaths: ["src"],
      authorizedWorkspaceRoot: drift.repo,
      resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier,
      computeInventoryFn: computeCandidateInventory,
    }), /base|HEAD|candidate/i);
  } finally {
    await cleanupDir(drift.repo);
    await cleanupDir(drift.runDir);
  }

  const invalidInventory = await setupBackendFailureScenario();
  try {
    for (const inventory of [
      {
        originalAllowedPaths: ["src"],
        originalAllowedCount: 1,
        originalAllowedTruncated: false,
        actualChangedPaths: [],
        actualChangedCount: 0,
        actualChangedTruncated: false,
        disallowedPaths: [],
        disallowedCount: 0,
        disallowedTruncated: false,
      },
      {
        originalAllowedPaths: ["src"],
        originalAllowedCount: 1,
        originalAllowedTruncated: false,
        actualChangedPaths: ["src/a.js"],
        actualChangedCount: 257,
        actualChangedTruncated: true,
        disallowedPaths: [],
        disallowedCount: 0,
        disallowedTruncated: false,
      },
    ]) {
      const view = await getRunDelivery({
        runId: RUN_ID,
        runDir: invalidInventory.runDir,
        authorizedWorkspaceRoot: invalidInventory.repo,
        computeInventoryFn: () => inventory,
      });
      assert.equal(view.candidateInventory ?? null, null);
      await assert.rejects(() => runDeliveryRepackage({
        runId: RUN_ID,
        runDir: invalidInventory.runDir,
        allowedPaths: ["src"],
        authorizedWorkspaceRoot: invalidInventory.repo,
        resolveDeliveryCommitFn: resolveDeliveryCommit,
        verifyDeliveryFn: passedVerifier,
        computeInventoryFn: () => inventory,
      }), /inventory|candidate/i);
    }
  } finally {
    await cleanupDir(invalidInventory.repo);
    await cleanupDir(invalidInventory.runDir);
  }
});

test("M12-4A-SCOPE: backend recovery never narrows original scope or omits an actual path", async () => {
  const narrowing = await setupBackendFailureScenario();
  try {
    await assert.rejects(() => runDeliveryRepackage({
      runId: RUN_ID,
      runDir: narrowing.runDir,
      allowedPaths: ["src/other.js"],
      authorizedWorkspaceRoot: narrowing.repo,
      resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier,
      computeInventoryFn: computeCandidateInventory,
    }), /original|allowedPaths|scope/i);
  } finally {
    await cleanupDir(narrowing.repo);
    await cleanupDir(narrowing.runDir);
  }

  const nonCovering = await setupBackendFailureScenario();
  try {
    await writeFile(join(nonCovering.worktreePath, "root.txt"), "outside original scope\n");
    await assert.rejects(() => runDeliveryRepackage({
      runId: RUN_ID,
      runDir: nonCovering.runDir,
      allowedPaths: ["src"],
      authorizedWorkspaceRoot: nonCovering.repo,
      resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier,
      computeInventoryFn: computeCandidateInventory,
    }), /cover|actual|allowedPaths/i);
  } finally {
    await cleanupDir(nonCovering.repo);
    await cleanupDir(nonCovering.runDir);
  }
});

// ============================================================
// Happy path: success + run_delivery becomes reviewable
// ============================================================

test("M12-1S2-OK: repackage succeeds, records provenance, run_delivery reviewable", async () => {
  const { repo, baseCommit, runDir, worktreePath } = await setupDisallowedScenario();
  try {
    const result = await runDeliveryRepackage({
      runId: RUN_ID,
      runDir,
      allowedPaths: ["src", "root.txt"],
      authorizedWorkspaceRoot: repo,
      resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier,
      computeInventoryFn: computeCandidateInventory,
    });

    // Canonical delivery commit, recovered/packaged source.
    assert.ok(result.deliveryCommit, "deliveryCommit present");
    assert.match(result.deliveryCommit, /^[0-9a-f]{40}$/, "canonical 40-hex");
    assert.equal(result.verificationStatus, "passed");
    assert.equal(result.source, "packaged");
    assert.equal(result.created, true);
    assert.equal(result.verificationRecorded, true);

    // Exactly one delivery_created + one recovery provenance + one verification.
    const events = await readEvents(runDir);
    assert.equal(events.filter((e) => e.type === "run.delivery_created").length, 1);
    assert.equal(events.filter((e) => e.type === "run.delivery_repackaged").length, 1);
    assert.equal(events.filter((e) => e.type === "run.delivery_verification_passed").length, 1);

    // The recovery provenance binds the unique DeliveryRef + approved scope.
    const provenance = events.find((e) => e.type === "run.delivery_repackaged");
    assert.equal(provenance.delivery.deliveryCommit, result.deliveryCommit);
    assert.deepEqual(provenance.approvedAllowedPaths, ["root.txt", "src"]);

    // Verification config reused value-for-value from the original run.started.
    const created = events.find((e) => e.type === "run.delivery_created");
    assert.deepEqual(created.delivery.verification.commands, ["npm test"]);

    // The original terminal failed is NOT rewritten to completed.
    const view = await getRunDelivery({ runId: RUN_ID, runDir, authorizedWorkspaceRoot: repo });
    assert.equal(view.terminalState, "failed");
    assert.equal(view.deliveryAvailable, true);
    assert.equal(view.verification.status, "passed");

    // run_delivery projects reviewable via the readiness handshake.
    const readiness = await getRunDeliveryReadiness({
      runId: RUN_ID, runDir, waitMs: 1000, authorizedWorkspaceRoot: repo,
    });
    assert.equal(readiness.readiness, "reviewable");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("M12-1S2-OK-REAL: real verifier kernel classifies a passing command as passed", async () => {
  const { repo, runDir } = await setupDisallowedScenario();
  try {
    const runCommand = async () => ({
      exitCode: 0, signal: null, timedOut: false, durationMs: 1, stdoutBytes: 0, stderrBytes: 0,
    });
    const result = await runDeliveryRepackage({
      runId: RUN_ID,
      runDir,
      allowedPaths: ["src", "root.txt"],
      authorizedWorkspaceRoot: repo,
      resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: realVerifierWith(runCommand),
      computeInventoryFn: computeCandidateInventory,
    });
    assert.equal(result.verificationStatus, "passed");
    const events = await readEvents(runDir);
    assert.equal(events.filter((e) => e.type === "run.delivery_verification_passed").length, 1);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

// ============================================================
// Recovery accept chain (contract #8)
// ============================================================

test("M12-1S2-ACCEPT: Lead accept succeeds only on the strict recovery chain", async () => {
  const { repo, runDir } = await setupDisallowedScenario();
  try {
    await runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier, computeInventoryFn: computeCandidateInventory,
    });
    // Recovery accept: terminal=failed + disallowed_path + provenance + passed.
    const accept = await decideRunDelivery({
      runId: RUN_ID, runDir, decision: "accepted", reason: "recovery verified",
    });
    assert.equal(accept.accepted, true);
    assert.equal(accept.event.type, "run.delivery_accepted");
    const events = await readEvents(runDir);
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted").length, 1);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("M12-1S2-ACCEPT-DENY: accept rejected when verification not passed", async () => {
  const { repo, runDir } = await setupDisallowedScenario();
  try {
    await runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: failedVerifier, computeInventoryFn: computeCandidateInventory,
    });
    await assert.rejects(() => decideRunDelivery({
      runId: RUN_ID, runDir, decision: "accepted", reason: "nope",
    }), /must be passed/);
    const events = await readEvents(runDir);
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted").length, 0);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("M12-1S2-ACCEPT-DENY-NO-PROVENANCE: accept rejected without recovery provenance", async () => {
  // A normal failed run with a NON-disallowed failure code has no recovery path.
  const { repo, baseCommit, runDir, worktreePath } = await setupDisallowedScenario();
  try {
    // Rewrite the transcript so the failure is empty_diff (not disallowed_path),
    // and seed a synthetic delivery_created+verification_passed so facts validate
    // — but with NO recovery provenance. Accept must be rejected.
    const fakeCommit = "c".repeat(40);
    const fakeBase = "b".repeat(40);
    const ref = {
      schemaVersion: 1, kind: "git_commit", runId: RUN_ID,
      baseCommit: fakeBase, deliveryCommit: fakeCommit, branch: `wao/${RUN_ID}`,
      worktreePath, changedFiles: ["src/a.js"],
      verification: { status: "passed", commands: ["npm test"], verifiedCommit: fakeCommit, results: [] },
      acceptance: { status: "pending", reviewerType: "lead_agent" },
      integration: { status: "pending", targetCommit: null },
    };
    seedTranscript(runDir, RUN_ID, [
      { type: "run.background_submitted", cwd: repo, deliveryRequested: true },
      { type: "run.started", backend: "test", cwd: repo, worktreePath,
        delivery: { mode: "git_commit_v1", baseCommit: fakeBase, allowedPaths: ["src"], verificationCommands: ["npm test"] } },
      { type: "run.state_change", from: null, to: "failed", reason: "empty_diff" },
      { type: "run.delivery_created", delivery: ref },
      { type: "run.delivery_verification_passed", delivery: ref },
    ]);
    await assert.rejects(() => decideRunDelivery({
      runId: RUN_ID, runDir, decision: "accepted", reason: "x",
    }), /completed|recovery/);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

// ============================================================
// Verification failed/unavailable stays reviewable; never auto-reject (#9)
// ============================================================

test("M12-1S2-VERIFY-FAILED: failed verification is reviewable; Lead may reject", async () => {
  const { repo, runDir } = await setupDisallowedScenario();
  try {
    const result = await runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: failedVerifier, computeInventoryFn: computeCandidateInventory,
    });
    assert.equal(result.verificationStatus, "failed");
    const events = await readEvents(runDir);
    assert.equal(events.filter((e) => e.type === "run.delivery_verification_failed").length, 1);
    // No automatic decision recorded.
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted" || e.type === "run.delivery_rejected").length, 0);
    // Still reviewable; Lead may reject.
    const readiness = await getRunDeliveryReadiness({
      runId: RUN_ID, runDir, waitMs: 1000, authorizedWorkspaceRoot: repo,
    });
    assert.equal(readiness.readiness, "reviewable");
    const reject = await decideRunDelivery({
      runId: RUN_ID, runDir, decision: "rejected", reason: "bad",
    });
    assert.equal(reject.accepted, true);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

// ============================================================
// Crash recovery: branch moved but created-append failed (#6)
// ============================================================

test("M12-1S2-CRASH-CREATED: retry recovers the SAME commit from Git exact objects", async () => {
  const { repo, runDir, worktreePath } = await setupDisallowedScenario();
  try {
    // First call: packaging moves the branch, but the created-append throws.
    let failCreated = true;
    const failingFactory = async (filePath, context) => {
      const t = new JsonlTranscript(filePath, context);
      const orig = t.tryAppendRepackageCreated.bind(t);
      t.tryAppendRepackageCreated = async (input) => {
        if (failCreated) { failCreated = false; throw new Error("disk full"); }
        return orig(input);
      };
      return t;
    };
    await assert.rejects(() => runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier, computeInventoryFn: computeCandidateInventory,
      transcriptFactory: failingFactory,
    }), /disk full/);

    // The branch MOVED to the delivery commit, but no delivery_created event.
    const movedCommit = git(["rev-parse", "HEAD"], worktreePath);
    assert.notEqual(movedCommit, git(["rev-parse", "HEAD^"], worktreePath));
    let events = await readEvents(runDir);
    assert.equal(events.filter((e) => e.type === "run.delivery_created").length, 0);

    // Second call (normal): recover the SAME commit, do NOT re-package / lose it.
    const result = await runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier, computeInventoryFn: computeCandidateInventory,
    });
    assert.equal(result.deliveryCommit, movedCommit, "recovered the exact same commit");
    assert.equal(result.source, "recovered");
    assert.equal(result.created, true);

    // Still exactly one commit in base..HEAD (no second delivery commit).
    assert.equal(git(["rev-list", "--count", `${git(["rev-parse", "HEAD^"], worktreePath)}..HEAD`], worktreePath), "1");

    events = await readEvents(runDir);
    assert.equal(events.filter((e) => e.type === "run.delivery_created").length, 1);
    assert.equal(events.filter((e) => e.type === "run.delivery_verification_passed").length, 1);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

// ============================================================
// created persisted but verify throws / append fails (#7)
// ============================================================

test("M12-1S2-CREATED-VERIFY-THROWS: retry does NOT re-package after created persisted", async () => {
  const { repo, runDir, worktreePath } = await setupDisallowedScenario();
  try {
    // First call: created appended, but the verifier throws.
    let verifyCalls = 0;
    const throwingVerifier = async (ref) => { verifyCalls += 1; throw new Error("verify boom"); };
    await assert.rejects(() => runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: throwingVerifier, computeInventoryFn: computeCandidateInventory,
    }), /verify boom/);

    const commitAfterFirst = git(["rev-parse", "HEAD"], worktreePath);
    let events = await readEvents(runDir);
    assert.equal(events.filter((e) => e.type === "run.delivery_created").length, 1, "created persisted");
    assert.equal(events.filter((e) => e.type === "run.delivery_verification_passed").length, 0);

    // Second call: must NOT re-package (same commit), just verify + record outcome.
    const result = await runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier, computeInventoryFn: computeCandidateInventory,
    });
    assert.equal(result.deliveryCommit, commitAfterFirst, "no second delivery commit");
    assert.equal(result.created, false, "created already existed");

    events = await readEvents(runDir);
    assert.equal(events.filter((e) => e.type === "run.delivery_created").length, 1, "still exactly one created");
    assert.equal(events.filter((e) => e.type === "run.delivery_verification_passed").length, 1);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("M12-1S2-VERIFY-APPEND-FAIL: retry records outcome without re-packaging; exactly one outcome", async () => {
  const { repo, runDir, worktreePath } = await setupDisallowedScenario();
  try {
    let failOutcome = true;
    const failingFactory = async (filePath, context) => {
      const t = new JsonlTranscript(filePath, context);
      const orig = t.tryAppendRepackageVerification.bind(t);
      t.tryAppendRepackageVerification = async (input) => {
        if (failOutcome) { failOutcome = false; throw new Error("append boom"); }
        return orig(input);
      };
      return t;
    };
    await assert.rejects(() => runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier, computeInventoryFn: computeCandidateInventory,
      transcriptFactory: failingFactory,
    }), /append boom/);

    const commitAfterFirst = git(["rev-parse", "HEAD"], worktreePath);
    let events = await readEvents(runDir);
    assert.equal(events.filter((e) => e.type === "run.delivery_created").length, 1);
    assert.equal(events.filter((e) => e.type === "run.delivery_verification_passed").length, 0);

    const result = await runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier, computeInventoryFn: computeCandidateInventory,
    });
    assert.equal(result.deliveryCommit, commitAfterFirst, "no re-package");
    events = await readEvents(runDir);
    assert.equal(events.filter((e) => e.type === "run.delivery_created").length, 1);
    assert.equal(events.filter((e) => e.type === "run.delivery_verification_passed").length, 1, "exactly one outcome");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

// ============================================================
// No long lock: a slow package/verify probe does not block transcript append (#5)
// ============================================================

test("M12-1S2-NO-LONG-LOCK: slow packaging probe does not hold the transcript append lock", async () => {
  const { repo, baseCommit, runDir, worktreePath } = await setupDisallowedScenario();
  try {
    let releasePackaging;
    let packagingEntered = false;
    const slowResolve = async (input) => {
      packagingEntered = true;
      await new Promise((res) => { releasePackaging = res; });
      return resolveDeliveryCommit(input);
    };
    const repackageP = runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: slowResolve,
      verifyDeliveryFn: passedVerifier, computeInventoryFn: computeCandidateInventory,
    });
    // Wait until packaging has entered (it now represents a >30s hold via the
    // controlled promise — no real wall-clock wait required).
    for (let i = 0; i < 200 && !packagingEntered; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(packagingEntered, true, "packaging entered");

    // While packaging is pending, an ordinary transcript append must complete
    // immediately — proving the append lock is NOT held during packaging.
    const sideTranscript = new JsonlTranscript(join(runDir, `${RUN_ID}.jsonl`), { runId: RUN_ID, agentId: "side" });
    let sideAppendDone = false;
    await Promise.race([
      (async () => { await sideTranscript.append("run.note", { probe: "side" }); sideAppendDone = true; })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("append blocked >2s")), 2000)),
    ]);
    assert.equal(sideAppendDone, true, "side append completed while packaging pending");

    // Release packaging and let the repackage finish.
    releasePackaging();
    await repackageP;
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

// ============================================================
// Concurrency: same input → exactly one created + one outcome (#4)
// ============================================================

test("M12-1S2-CONC-SAME: two concurrent same-input repackages yield exactly one created + outcome", async () => {
  const { repo, runDir } = await setupDisallowedScenario();
  try {
    // Inject a deterministic resolver/verifier so the two calls converge on the
    // same ref without real concurrent-Git corruption in one worktree.
    const fakeCommit = "d".repeat(40);
    const fakeRef = {
      schemaVersion: 1, kind: "git_commit", runId: RUN_ID,
      baseCommit: "b".repeat(40), deliveryCommit: fakeCommit, branch: `wao/${RUN_ID}`,
      worktreePath: "/fake", changedFiles: ["root.txt", "src/a.js"],
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
      const outcome = call === 0 ? "passed" : "failed";
      return {
        delivery: {
          ...fakeRef,
          verification: {
            ...fakeRef.verification,
            status: outcome,
            verifiedCommit: fakeCommit,
            results: [],
          },
        },
        outcome,
      };
    };

    const results = await Promise.all([
      runDeliveryRepackage({ runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"], authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: fakeResolve, verifyDeliveryFn: fakeVerify, computeInventoryFn: computeCandidateInventory }),
      runDeliveryRepackage({ runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"], authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: fakeResolve, verifyDeliveryFn: fakeVerify, computeInventoryFn: computeCandidateInventory }),
    ]);
    const created = results.filter((r) => r.created).length;
    const recorded = results.filter((r) => r.verificationRecorded).length;
    assert.equal(created, 1, "exactly one created");
    assert.equal(recorded, 1, "exactly one outcome recorded");
    assert.deepEqual(results.map((r) => r.verificationStatus), ["passed", "passed"]);
    const events = await readEvents(runDir);
    assert.equal(events.filter((e) => e.type === "run.delivery_created").length, 1);
    assert.equal(events.filter((e) => e.type === "run.delivery_verification_passed").length, 1);
    const provenance = events.filter((e) => e.type === "run.delivery_repackaged");
    assert.equal(provenance.length, 1, "exactly one provenance");
    assert.ok(
      provenance[0].source === "packaged" || provenance[0].source === "recovered",
      "persisted source is closed-set",
    );
    assert.deepEqual(
      results.map((r) => r.source),
      [provenance[0].source, provenance[0].source],
      "both callers return the persisted winning source",
    );
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

// ============================================================
// Different allowedPaths competing requests never overwrite (#4)
// ============================================================

test("M12-1S2-CONC-DIFF-SCOPE: a later different-scope repackage yields to the existing delivery", async () => {
  const { repo, runDir } = await setupDisallowedScenario();
  try {
    const first = await runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier, computeInventoryFn: computeCandidateInventory,
    });
    // A second repackage with a DIFFERENT (but still-valid) scope must not
    // overwrite the first: it yields to the existing delivery commit.
    const second = await runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["root.txt", "src", "docs"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier, computeInventoryFn: computeCandidateInventory,
    });
    assert.equal(second.deliveryCommit, first.deliveryCommit, "same commit, no overwrite");
    assert.equal(second.created, false, "second yielded to existing created");
    const events = await readEvents(runDir);
    assert.equal(events.filter((e) => e.type === "run.delivery_created").length, 1, "still one created");
    assert.equal(events.filter((e) => e.type === "run.delivery_repackaged").length, 1, "still one provenance");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("M12-1S2-RETRY-SCOPE: an idempotent retry must still cover the existing delivery", async () => {
  const { repo, runDir } = await setupDisallowedScenario();
  try {
    await runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier, computeInventoryFn: computeCandidateInventory,
    });
    const before = await readEvents(runDir);
    await assert.rejects(
      () => runDeliveryRepackage({
        runId: RUN_ID, runDir, allowedPaths: ["src"],
        authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
        verifyDeliveryFn: passedVerifier, computeInventoryFn: computeCandidateInventory,
      }),
      /cover the existing delivery/i,
    );
    assert.deepEqual(await readEvents(runDir), before, "rejected retry leaves transcript unchanged");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("M12-1S2-RECOVERY-SCOPE: recovery re-proves committed paths against the current Lead scope", async () => {
  const { repo, worktreePath, baseCommit, runDir } = await setupDisallowedScenario();
  try {
    await runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier, computeInventoryFn: computeCandidateInventory,
    });
    assert.throws(
      () => resolveDeliveryCommit({
        runId: RUN_ID,
        worktreePath,
        baseCommit,
        isolation: { type: "worktree", strategy: "persistent" },
        allowedPaths: ["src"],
        verificationCommands: ["npm test"],
      }),
      /outside allowedPaths|disallowed/i,
    );
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

// ============================================================
// Fail-closed: every precondition violation rejects (#1, #2, #10)
// ============================================================

test("M12-1S2-FAIL-CLOSED: precondition violations reject without mutating the transcript", async () => {
  // foreign runId / cross-workspace: run ownership belongs to a different repo.
  const { repo, runDir } = await setupDisallowedScenario();
  const otherRepo = await makeRepo("m12s2-other-");
  try {
    await assert.rejects(() => runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"],
      authorizedWorkspaceRoot: otherRepo,
      resolveDeliveryCommitFn: resolveDeliveryCommit, verifyDeliveryFn: passedVerifier,
      computeInventoryFn: computeCandidateInventory,
    }), /workspace|ownership|mismatch/i);
    // No delivery_created appended for the failed precondition.
    const events = await readEvents(runDir);
    assert.equal(events.filter((e) => e.type === "run.delivery_created").length, 0);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
    await cleanupDir(otherRepo);
  }
});

test("M12-1S2-FAIL-CLOSED-PATHS: malformed / non-superset / non-covering allowedPaths reject", async () => {
  const { repo, runDir } = await setupDisallowedScenario();
  try {
    // Malformed path (traversal).
    await assert.rejects(() => runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["../evil"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier, computeInventoryFn: computeCandidateInventory,
    }));
    // Does NOT include the original scope (drops "src").
    await assert.rejects(() => runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["root.txt"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier, computeInventoryFn: computeCandidateInventory,
    }), /original|include|scope|cover/i);
    // Does NOT cover an actual changed path (root.txt left uncovered).
    await assert.rejects(() => runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier, computeInventoryFn: computeCandidateInventory,
    }), /cover|actual|scope/i);
    const events = await readEvents(runDir);
    assert.equal(events.filter((e) => e.type === "run.delivery_created").length, 0);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("M12-1S2-FAIL-CLOSED-STATE: terminal/non-disallowed/decided/not-requested all reject", async () => {
  const { repo, baseCommit, runDir, worktreePath } = await setupDisallowedScenario();
  try {
    const base = (extra) => disallowedPathEvents({
      repo, worktreePath, baseCommit, allowedPaths: ["src"], verificationCommands: ["npm test"],
    }).concat(extra);

    // terminal completed (not failed).
    seedTranscript(runDir, "run_completed1", base([{ type: "run.state_change", from: "running", to: "completed", reason: "done" }]).map((e) => e.type === "run.state_change" && e.to === "failed" ? { ...e, to: "completed", reason: "done" } : e).map((e, i) => ({ ...e, runId: "run_completed1", seq: i + 1 })));
    await assert.rejects(() => runDeliveryRepackage({ runId: "run_completed1", runDir, allowedPaths: ["src", "root.txt"], authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit, verifyDeliveryFn: passedVerifier, computeInventoryFn: computeCandidateInventory }));

    // non-disallowed failure code.
    seedTranscript(runDir, "run_emptydiff1", disallowedPathEvents({ repo, worktreePath, baseCommit, allowedPaths: ["src"], verificationCommands: ["npm test"], deliveryCode: "empty_diff" }).map((e, i) => ({ ...e, runId: "run_emptydiff1", seq: i + 1 })));
    await assert.rejects(() => runDeliveryRepackage({ runId: "run_emptydiff1", runDir, allowedPaths: ["src", "root.txt"], authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit, verifyDeliveryFn: passedVerifier, computeInventoryFn: computeCandidateInventory }));

    // already decided.
    const decidedRef = { schemaVersion: 1, kind: "git_commit", runId: "run_decided1", baseCommit: "b".repeat(40), deliveryCommit: "d".repeat(40), branch: "wao/run_decided1", worktreePath, changedFiles: ["src/a.js"], verification: { status: "passed", commands: ["npm test"], verifiedCommit: "d".repeat(40), results: [] }, acceptance: { status: "rejected", reviewerType: "lead_agent" }, integration: { status: "pending", targetCommit: null } };
    seedTranscript(runDir, "run_decided1", disallowedPathEvents({ repo, worktreePath, baseCommit, allowedPaths: ["src"], verificationCommands: ["npm test"] }).concat([
      { type: "run.delivery_created", delivery: decidedRef },
      { type: "run.delivery_repackaged", delivery: decidedRef, approvedAllowedPaths: ["src", "root.txt"], source: "packaged" },
      { type: "run.delivery_verification_passed", delivery: decidedRef },
      { type: "run.delivery_rejected", delivery: decidedRef, deliveryCommit: decidedRef.deliveryCommit, reason: "no" },
    ]).map((e, i) => ({ ...e, runId: "run_decided1", seq: i + 1 })));
    await assert.rejects(() => runDeliveryRepackage({ runId: "run_decided1", runDir, allowedPaths: ["src", "root.txt"], authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit, verifyDeliveryFn: passedVerifier, computeInventoryFn: computeCandidateInventory }));
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("M12-1S2-FAIL-CLOSED-ORPHAN: verification without created rejects before transcript mutation", async () => {
  const { repo, worktreePath, baseCommit, runDir } = await setupDisallowedScenario();
  try {
    const ref = {
      schemaVersion: 1, kind: "git_commit", runId: RUN_ID,
      baseCommit, deliveryCommit: "d".repeat(40), branch: `wao/${RUN_ID}`,
      worktreePath, changedFiles: ["src/a.js"],
      verification: { status: "failed", commands: ["npm test"], verifiedCommit: "d".repeat(40), results: [] },
      acceptance: { status: "pending", reviewerType: "lead_agent" },
      integration: { status: "pending", targetCommit: null },
    };
    const filePath = join(runDir, `${RUN_ID}.jsonl`);
    const t = new JsonlTranscript(filePath, { runId: RUN_ID, agentId: AGENT_ID });
    await t.append("run.delivery_verification_failed", { delivery: ref });
    const before = await readEvents(runDir);
    await assert.rejects(
      () => runDeliveryRepackage({
        runId: RUN_ID, runDir, allowedPaths: ["root.txt", "src"],
        authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
        verifyDeliveryFn: passedVerifier, computeInventoryFn: computeCandidateInventory,
      }),
      /orphan verification/i,
    );
    assert.deepEqual(await readEvents(runDir), before);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("M12-1S2-FAIL-CLOSED-INVENTORY: empty/partial/truncated inventory rejects", async () => {
  const { repo, runDir } = await setupDisallowedScenario();
  try {
    // null inventory (read failure).
    await assert.rejects(() => runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier, computeInventoryFn: async () => null,
    }), /inventory/i);
    // empty actual changed paths.
    await assert.rejects(() => runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier,
      computeInventoryFn: async () => ({ originalAllowedPaths: ["src/a.js"], originalAllowedCount: 1, originalAllowedTruncated: false, actualChangedPaths: [], actualChangedCount: 0, actualChangedTruncated: false, disallowedPaths: [], disallowedCount: 0, disallowedTruncated: false }),
    }), /inventory|empty/i);
    // truncated inventory.
    await assert.rejects(() => runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier,
      computeInventoryFn: async () => ({ originalAllowedPaths: ["src/a.js"], originalAllowedCount: 1, originalAllowedTruncated: false, actualChangedPaths: ["src/a.js"], actualChangedCount: 300, actualChangedTruncated: true, disallowedPaths: ["root.txt"], disallowedCount: 1, disallowedTruncated: false }),
    }), /inventory|truncat/i);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

// ============================================================
// Idempotent re-entry: a full retry returns the same essential result (#4)
// ============================================================

test("M12-1S2-IDEMPOTENT: retrying a completed repackage yields the same delivery + outcome", async () => {
  const { repo, runDir } = await setupDisallowedScenario();
  try {
    const first = await runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier, computeInventoryFn: computeCandidateInventory,
    });
    const second = await runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier, computeInventoryFn: computeCandidateInventory,
    });
    assert.equal(second.deliveryCommit, first.deliveryCommit);
    assert.equal(second.verificationStatus, first.verificationStatus);
    assert.equal(second.created, false);
    assert.equal(second.verificationRecorded, false);
    const events = await readEvents(runDir);
    assert.equal(events.filter((e) => e.type === "run.delivery_created").length, 1);
    assert.equal(events.filter((e) => e.type === "run.delivery_verification_passed").length, 1);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

// ============================================================
// M12-13: the ORIGINAL per-command execution budget must survive
// reconstruction and reach the verifier (Problem A). Absent stays zero-drift;
// present-but-malformed fails closed before any side effect.
// ============================================================

test("M12-13-REPKG-TIMEOUT-OK: a valid long persisted verificationTimeoutMs is preserved through reconstruction, the repackage-created ref, and the verifier call", async () => {
  const { repo, runDir } = await setupDisallowedScenario({
    // A Lead-declared long per-command budget (10 min) that would otherwise drift
    // to the 300000 default if dropped during reconstruction.
    verificationTimeoutMs: 600000,
  });
  try {
    const verifyCalls = [];
    const result = await runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: async (ref, opts) => {
        verifyCalls.push({ ref, opts });
        return {
          delivery: {
            ...ref,
            verification: {
              ...ref.verification,
              status: "passed",
              verifiedCommit: ref.deliveryCommit,
              results: [],
            },
          },
          outcome: "passed",
        };
      },
      computeInventoryFn: computeCandidateInventory,
    });
    assert.equal(result.verificationStatus, "passed");

    // The verifier received the ORIGINAL declared per-command budget — NOT the
    // 300000 default.
    assert.equal(verifyCalls.length, 1, "verifier called exactly once");
    assert.equal(verifyCalls[0].opts.timeoutMs, 600000,
      "repackage verification is supplied the authoritative declared timeout");

    // The repackage-created DeliveryRef carries the declared budget (preserved
    // through reconstruction -> packaging).
    const events = await readEvents(runDir);
    const created = events.find((e) => e.type === "run.delivery_created");
    assert.equal(created.delivery.verification.verificationTimeoutMs, 600000,
      "repackage-created DeliveryRef persists the declared timeout");

    // An idempotent retry must still supply the SAME authoritative budget to the
    // (now-skipped) verifier path — the bound ref + budget survive re-entry.
    const retryVerifyCalls = [];
    const retry = await runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: async (ref, opts) => {
        retryVerifyCalls.push(opts);
        return { delivery: { ...ref, verification: { ...ref.verification, status: "passed", verifiedCommit: ref.deliveryCommit, results: [] } }, outcome: "passed" };
      },
      computeInventoryFn: computeCandidateInventory,
    });
    assert.equal(retry.created, false, "idempotent retry yielded to the existing delivery");
    assert.equal(retry.verificationRecorded, false, "outcome already recorded");
    // No re-verify on the idempotent path (existing outcome is authoritative).
    assert.equal(retryVerifyCalls.length, 0);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("M12-13-REPKG-TIMEOUT-ABSENT: absent verificationTimeoutMs is zero drift — verifier receives no timeoutMs, created ref gains no key", async () => {
  const { repo, runDir } = await setupDisallowedScenario();
  try {
    const verifyCalls = [];
    await runDeliveryRepackage({
      runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"],
      authorizedWorkspaceRoot: repo, resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: async (ref, opts = {}) => {
        verifyCalls.push(opts);
        return { delivery: { ...ref, verification: { ...ref.verification, status: "passed", verifiedCommit: ref.deliveryCommit, results: [] } }, outcome: "passed" };
      },
      computeInventoryFn: computeCandidateInventory,
    });
    assert.equal(verifyCalls.length, 1);
    assert.equal(
      Object.prototype.hasOwnProperty.call(verifyCalls[0], "timeoutMs"),
      false,
      "absent timeout → verifier receives NO timeoutMs (consumer default applies)",
    );
    const events = await readEvents(runDir);
    const created = events.find((e) => e.type === "run.delivery_created");
    assert.equal(
      Object.prototype.hasOwnProperty.call(created.delivery.verification, "verificationTimeoutMs"),
      false,
      "absent timeout → created ref gains NO verificationTimeoutMs key (zero drift)",
    );
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("M12-13-REPKG-TIMEOUT-MALFORMED: a malformed/out-of-range persisted verificationTimeoutMs fails closed BEFORE inventory / packaging / append / verification", async () => {
  // A present-but-malformed persisted value must never be silently defaulted or
  // widened: it rejects in Phase 0 (preconditions) BEFORE any inventory read, Git
  // packaging, transcript append, or verifier execution. All closed-set malformations
  // (string / fraction / below-min / above-max / null) must behave identically.
  for (const bad of ["600000", 600000.5, 999, 7200001, null, "oops"]) {
    const { repo, runDir } = await setupDisallowedScenario({ verificationTimeoutMs: bad });
    const filePath = join(runDir, `${RUN_ID}.jsonl`);
    const bytesBefore = readFileSync(filePath, "utf8").length;
    let inventoryCalls = 0;
    let resolveCalls = 0;
    let verifyCalls = 0;
    let transcriptCalls = 0;
    try {
      await assert.rejects(
        () => runDeliveryRepackage({
          runId: RUN_ID, runDir, allowedPaths: ["src", "root.txt"],
          authorizedWorkspaceRoot: repo,
          computeInventoryFn: async () => { inventoryCalls += 1; return null; },
          resolveDeliveryCommitFn: async () => { resolveCalls += 1; throw new Error("must not package"); },
          verifyDeliveryFn: async () => { verifyCalls += 1; throw new Error("must not verify"); },
          transcriptFactory: async () => { transcriptCalls += 1; throw new Error("must not append"); },
        }),
        /verificationTimeoutMs|integer/i,
        `malformed ${JSON.stringify(bad)} must fail closed`,
      );
      assert.equal(inventoryCalls, 0, `inventory NOT called for ${JSON.stringify(bad)}`);
      assert.equal(resolveCalls, 0, `resolve NOT called for ${JSON.stringify(bad)}`);
      assert.equal(verifyCalls, 0, `verify NOT called for ${JSON.stringify(bad)}`);
      assert.equal(transcriptCalls, 0, `transcript append NOT called for ${JSON.stringify(bad)}`);
      assert.equal(
        readFileSync(filePath, "utf8").length,
        bytesBefore,
        `transcript bytes unchanged for ${JSON.stringify(bad)}`,
      );
    } finally {
      await cleanupDir(repo);
      await cleanupDir(runDir);
    }
  }
});
