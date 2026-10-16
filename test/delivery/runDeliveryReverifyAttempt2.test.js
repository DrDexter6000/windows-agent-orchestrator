// test/delivery/runDeliveryReverifyAttempt2.test.js
//
// The EXPLICIT second reverify attempt (attempt: 2) — application-service TDD
// tests.
//
// Hard contract exercised:
//   - A delivery carries at most TWO reverify chains. The second opens only
//     when the FIRST is complete, FAILED, with a failure code in the eligible
//     environment/tooling closed set; no Lead decision exists; the same
//     immutable delivery commit; the original assertion commands byte-for-byte.
//   - First chain passed / artifact_mutated / unavailable / still pending, or
//     an existing decision → attempt 2 is REJECTED (fail closed).
//   - A THIRD application is refused with the closed-set reason
//     `reverify_attempts_exhausted`; WAO never auto-retries.
//   - Reentrancy: repeat attempt-2 calls and crash-resume between request and
//     outcome converge on the SECOND chain with at most one outcome. Repeat
//     attempt-1 (or omitted) calls NEVER run a second verification.
//   - The decision gate: after the second chain passes an explicit accept
//     succeeds; after it fails accept is refused; a request appended after a
//     decision never backs it.
//
// Real git fixtures under os.tmpdir(); verification through the REAL
// verifyDelivery (runCommand injected) so commit immutability is causal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { runDeliveryReverify } from "../../src/application/runDeliveryReverify.js";
import { resolveDeliveryCommit } from "../../src/delivery.js";
import { verifyDelivery } from "../../src/deliveryVerification.js";
import { decideRunDelivery, getRunDelivery } from "../../src/application/runDelivery.js";
import { validateDeliveryFacts } from "../../src/transcript.js";

const RUN_ID = "run_rv2_svc";
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

async function makeRepo(prefix = "rv2-repo-") {
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

function ok() {
  return { exitCode: 0, signal: null, timedOut: false, durationMs: 1, stdoutBytes: 0, stderrBytes: 0 };
}
function fail() {
  return { exitCode: 1, signal: null, timedOut: false, durationMs: 1, stdoutBytes: 0, stderrBytes: 0 };
}

/** "assert-needs-setup" passes only after "setup-prepare" ran. */
function makeFixingRunCommand() {
  let setupRan = false;
  return async (command) => {
    if (command === "setup-prepare") { setupRan = true; return ok(); }
    if (command === "assert-needs-setup") return setupRan ? ok() : fail();
    return fail();
  };
}

function makeAlwaysFailingRunCommand() {
  return async () => fail();
}

function realVerifierWith(runCommand) {
  return (deliveryRef, opts) => verifyDelivery(deliveryRef, { ...opts, runCommand });
}

/**
 * Build a real committed delivery + a transcript whose ORIGINAL verification
 * FAILED with an eligible code. The worktree stays at the exact delivery
 * commit so reverify can re-run assertions there.
 */
async function setupScenario({
  runId = RUN_ID,
  extraEvents = [],
} = {}) {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "rv2-runs-"));
  const worktreePath = makeLinkedWorktree(repo, runId);
  await writeFile(join(worktreePath, "src", "a.js"), "const a = 2;\n");

  const deliveryInput = {
    runId,
    worktreePath,
    baseCommit,
    isolation: { type: "worktree", strategy: "persistent" },
    allowedPaths: ["src"],
    verificationCommands: ["assert-needs-setup"],
  };
  const { ref: deliveryRef } = resolveDeliveryCommit(deliveryInput);
  const deliveryCommit = deliveryRef.deliveryCommit;

  const originalVerificationRef = {
    ...deliveryRef,
    verification: {
      ...deliveryRef.verification,
      status: "failed",
      failureCode: "command_failed",
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
        allowedPaths: ["src"],
        verificationCommands: ["assert-needs-setup"],
      },
    },
    { type: "run.delivery_created", delivery: deliveryRef, deliveryCommit },
    { type: "run.completed" },
    { type: "run.state_change", from: "running", to: "completed", reason: "completed" },
    { type: "run.delivery_verification_failed", delivery: originalVerificationRef, deliveryCommit },
    ...extraEvents,
  ];
  seedTranscript(runDir, runId, events);
  return { repo, baseCommit, runDir, worktreePath, deliveryRef, deliveryCommit };
}

/** A durable FIRST reverify chain, causally produced through the service. */
async function runFirstChain(ctx, { reason = "tooling_invalid", verifier } = {}) {
  return runDeliveryReverify({
    runId: RUN_ID,
    runDir: ctx.runDir,
    authorizedWorkspaceRoot: ctx.repo,
    reason,
    verifyDeliveryFn: verifier ?? realVerifierWith(makeAlwaysFailingRunCommand()),
  });
}

// =====================================================================
// Group 1: eligibility for the second attempt
// =====================================================================

test("RV2-S1: first chain failed with an eligible code → attempt 2 allowed; second chain events bind attempt 2; effective flips only via the latest chain", async () => {
  const ctx = await setupScenario();
  try {
    const first = await runFirstChain(ctx);
    assert.equal(first.verificationStatus, "failed");
    assert.equal(first.attempt, 1, "omitted attempt reads 1");
    assert.equal(first.failureCode, "command_failed");

    // The SECOND attempt: a different closed-set reason + a fixing setup —
    // allowed because chain 1 failed with an eligible code.
    const second = await runDeliveryReverify({
      runId: RUN_ID,
      runDir: ctx.runDir,
      authorizedWorkspaceRoot: ctx.repo,
      reason: "environment_contaminated",
      attempt: 2,
      setupCommands: ["setup-prepare"],
      verifyDeliveryFn: realVerifierWith(makeFixingRunCommand()),
    });
    assert.equal(second.state, "created");
    assert.equal(second.attempt, 2);
    assert.equal(second.requested, true);
    assert.equal(second.outcomeRecorded, true);
    assert.equal(second.verificationStatus, "passed");
    assert.equal(second.deliveryCommit, ctx.deliveryCommit, "same immutable delivery commit");
    assert.equal(second.reason, "environment_contaminated");

    // Durable shapes: the FIRST request carries no attempt field (legacy
    // byte-shape); the SECOND carries exactly attempt: 2. Two requests, two
    // outcomes, nothing more.
    const events = readEvents(ctx.runDir);
    const requests = events.filter((e) => e.type === "run.delivery_reverification_requested");
    const outcomes = events.filter((e) => e.type.startsWith("run.delivery_reverification_")
      && e.type !== "run.delivery_reverification_requested");
    assert.equal(requests.length, 2);
    assert.equal(outcomes.length, 2);
    assert.equal("attempt" in requests[0], false, "first request keeps the legacy shape (no attempt field)");
    assert.equal(requests[1].attempt, 2);

    // Facts: original failed, effective = the LATEST chain's outcome.
    const facts = validateDeliveryFacts(readEvents(ctx.runDir), { expectedRunId: RUN_ID });
    assert.equal(facts.valid, true);
    assert.equal(facts.verificationStatus, "failed");
    assert.equal(facts.effectiveVerificationStatus, "passed");
    assert.equal(facts.reverifyStatus, "complete");
  } finally {
    await cleanupDir(ctx.repo);
    await cleanupDir(ctx.runDir);
  }
});

test("RV2-S2: first chain passed → attempt 2 rejected", async () => {
  const ctx = await setupScenario();
  try {
    // A PASSING first chain (a fixing setup on the first attempt itself).
    const passing = await runDeliveryReverify({
      runId: RUN_ID,
      runDir: ctx.runDir,
      authorizedWorkspaceRoot: ctx.repo,
      reason: "tooling_invalid",
      setupCommands: ["setup-prepare"],
      verifyDeliveryFn: realVerifierWith(makeFixingRunCommand()),
    });
    assert.equal(passing.verificationStatus, "passed");
    await assert.rejects(
      () => runDeliveryReverify({
        runId: RUN_ID,
        runDir: ctx.runDir,
        authorizedWorkspaceRoot: ctx.repo,
        reason: "environment_contaminated",
        attempt: 2,
        verifyDeliveryFn: realVerifierWith(makeFixingRunCommand()),
      }),
      /attempt 2 requires a complete first reverify chain/,
    );
  } finally {
    await cleanupDir(ctx.repo);
    await cleanupDir(ctx.runDir);
  }
});

test("RV2-S3: first chain failed artifact_mutated → attempt 2 rejected", async () => {
  const ctx = await setupScenario();
  try {
    // A mutating SETUP command on the first chain → the artifact moved under
    // the assertions → artifact_mutated (content integrity is not recoverable
    // by re-running the same artifact).
    const { appendFile } = await import("node:fs/promises");
    const mutatingRunCommand = async (command, cwd) => {
      if (command === "setup-prepare") {
        await appendFile(join(cwd, "src", "a.js"), "mutation\n");
      }
      return ok();
    };
    const first = await runDeliveryReverify({
      runId: RUN_ID,
      runDir: ctx.runDir,
      authorizedWorkspaceRoot: ctx.repo,
      reason: "tooling_invalid",
      setupCommands: ["setup-prepare"],
      verifyDeliveryFn: (deliveryRef, opts) => verifyDelivery(deliveryRef, { ...opts, runCommand: mutatingRunCommand }),
    });
    assert.equal(first.verificationStatus, "failed");
    assert.equal(first.failureCode, "artifact_mutated");
    // Reset the worktree back to the exact delivery commit so the SECOND call
    // could otherwise pass — the eligibility gate alone must refuse it.
    git(["checkout", "--", "."], ctx.worktreePath);
    git(["clean", "-fd"], ctx.worktreePath);
    await assert.rejects(
      () => runDeliveryReverify({
        runId: RUN_ID,
        runDir: ctx.runDir,
        authorizedWorkspaceRoot: ctx.repo,
        reason: "environment_contaminated",
        attempt: 2,
        verifyDeliveryFn: realVerifierWith(makeFixingRunCommand()),
      }),
      /attempt 2 requires a complete first reverify chain/,
    );
  } finally {
    await cleanupDir(ctx.repo);
    await cleanupDir(ctx.runDir);
  }
});

test("RV2-S4: first chain unavailable / still pending → attempt 2 rejected (seeded durable shapes)", async () => {
  const unavailableOutcomeRef = (ref) => ({
    ...ref,
    verification: {
      ...ref.verification,
      status: "unavailable",
      unavailableReason: "no_assertions",
      verifiedCommit: ref.deliveryCommit,
      results: [],
    },
  });
  const req = (ref, overrides = {}) => ({
    type: "run.delivery_reverification_requested",
    delivery: ref,
    deliveryCommit: ref.deliveryCommit,
    reason: "tooling_invalid",
    ...overrides,
  });
  const out = (type, ref) => ({
    type,
    delivery: unavailableOutcomeRef(ref),
    deliveryCommit: ref.deliveryCommit,
  });

  // unavailable first chain
  {
    const ctx = await setupScenario();
    try {
      const ref = ctx.deliveryRef;
      const base = readEvents(ctx.runDir);
      seedTranscript(ctx.runDir, RUN_ID, [...base, req(ref), out("run.delivery_reverification_unavailable", ref)]);
      await assert.rejects(
        () => runDeliveryReverify({
          runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo,
          reason: "tooling_invalid", attempt: 2,
          verifyDeliveryFn: realVerifierWith(makeFixingRunCommand()),
        }),
        /attempt 2 requires a complete first reverify chain/,
      );
    } finally {
      await cleanupDir(ctx.repo);
      await cleanupDir(ctx.runDir);
    }
  }

  // still-pending first chain
  {
    const ctx = await setupScenario();
    try {
      const ref = ctx.deliveryRef;
      const base = readEvents(ctx.runDir);
      seedTranscript(ctx.runDir, RUN_ID, [...base, req(ref)]);
      await assert.rejects(
        () => runDeliveryReverify({
          runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo,
          reason: "tooling_invalid", attempt: 2,
          verifyDeliveryFn: realVerifierWith(makeFixingRunCommand()),
        }),
        /attempt 2 requires a complete first reverify chain/,
      );
    } finally {
      await cleanupDir(ctx.repo);
      await cleanupDir(ctx.runDir);
    }
  }
});

test("RV2-S5: an existing Lead decision → attempt 2 rejected (a request after the decision cannot back it)", async () => {
  const ctx = await setupScenario();
  try {
    const first = await runFirstChain(ctx);
    assert.equal(first.verificationStatus, "failed");
    // The Lead rejects on chain 1's failed truth.
    const decision = await decideRunDelivery({
      runId: RUN_ID, runDir: ctx.runDir, decision: "rejected", reason: "chain 1 failed",
    });
    assert.equal(decision.accepted, true);
    await assert.rejects(
      () => runDeliveryReverify({
        runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo,
        reason: "environment_contaminated", attempt: 2,
        verifyDeliveryFn: realVerifierWith(makeFixingRunCommand()),
      }),
      /a decision already exists/,
    );
    // Nothing was appended by the refused call.
    const requests = readEvents(ctx.runDir).filter((e) => e.type === "run.delivery_reverification_requested");
    assert.equal(requests.length, 1, "no second request after a decision");
  } finally {
    await cleanupDir(ctx.repo);
    await cleanupDir(ctx.runDir);
  }
});

test("RV2-S6: a THIRD application is refused with the closed-set reason reverify_attempts_exhausted; other bad attempt values are shape errors", async () => {
  const ctx = await setupScenario();
  try {
    await assert.rejects(
      () => runDeliveryReverify({
        runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo,
        reason: "tooling_invalid", attempt: 3,
        verifyDeliveryFn: realVerifierWith(makeFixingRunCommand()),
      }),
      (err) => {
        assert.match(err.message, /reverify_attempts_exhausted/);
        return true;
      },
    );
    for (const bad of [0, -1, 1.5, "2"]) {
      await assert.rejects(
        () => runDeliveryReverify({
          runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo,
          reason: "tooling_invalid", attempt: bad,
        }),
        /attempt must be the integer 1 or 2/,
        `attempt ${JSON.stringify(bad)} is a shape error`,
      );
    }
  } finally {
    await cleanupDir(ctx.repo);
    await cleanupDir(ctx.runDir);
  }
});

// =====================================================================
// Group 2: reentrancy — convergence, crash resume, no drift for attempt 1
// =====================================================================

test("RV2-R1: repeat attempt-2 calls converge on the second chain — at most one outcome, verifier not re-run", async () => {
  const ctx = await setupScenario();
  try {
    await runFirstChain(ctx);
    let verifierCalls = 0;
    const countingFixing = async (deliveryRef, opts) => {
      verifierCalls += 1;
      return verifyDelivery(deliveryRef, { ...opts, runCommand: makeFixingRunCommand() });
    };
    const second = await runDeliveryReverify({
      runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo,
      reason: "environment_contaminated", attempt: 2, setupCommands: ["setup-prepare"],
      verifyDeliveryFn: countingFixing,
    });
    assert.equal(second.state, "created");
    assert.equal(verifierCalls, 1, "the second chain verified once through this call's verifier");

    const repeat = await runDeliveryReverify({
      runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo,
      reason: "environment_contaminated", attempt: 2, setupCommands: ["setup-prepare"],
      verifyDeliveryFn: countingFixing,
    });
    assert.equal(repeat.state, "idempotent");
    assert.equal(repeat.requested, false);
    assert.equal(repeat.outcomeRecorded, false);
    assert.equal(repeat.verificationStatus, "passed");
    assert.equal(repeat.attempt, 2);
    assert.equal(verifierCalls, 1, "the settled second chain is NOT re-verified");

    const events = readEvents(ctx.runDir);
    const requests = events.filter((e) => e.type === "run.delivery_reverification_requested");
    const outcomes = events.filter((e) => e.type.startsWith("run.delivery_reverification_")
      && e.type !== "run.delivery_reverification_requested");
    assert.equal(requests.length, 2);
    assert.equal(outcomes.length, 2, "at most one outcome per chain");
  } finally {
    await cleanupDir(ctx.repo);
    await cleanupDir(ctx.runDir);
  }
});

test("RV2-R2: crash between the second request and its outcome resumes (seeded bare attempt-2 request)", async () => {
  const ctx = await setupScenario();
  try {
    const ref = ctx.deliveryRef;
    // Durable state after a crash: chain 1 complete (failed, eligible), chain
    // 2's request recorded, no outcome yet.
    const base = readEvents(ctx.runDir);
    seedTranscript(ctx.runDir, RUN_ID, [
      ...base,
      {
        type: "run.delivery_reverification_requested",
        delivery: ref,
        deliveryCommit: ref.deliveryCommit,
        reason: "tooling_invalid",
      },
      {
        type: "run.delivery_reverification_failed",
        delivery: {
          ...ref,
          verification: {
            ...ref.verification,
            status: "failed",
            failureCode: "command_timeout",
            verifiedCommit: ref.deliveryCommit,
            results: [],
          },
        },
        deliveryCommit: ref.deliveryCommit,
      },
      {
        type: "run.delivery_reverification_requested",
        delivery: ref,
        deliveryCommit: ref.deliveryCommit,
        reason: "environment_contaminated",
        attempt: 2,
        setupCommands: ["setup-prepare"],
      },
    ]);

    const resumed = await runDeliveryReverify({
      runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo,
      reason: "environment_contaminated", attempt: 2, setupCommands: ["setup-prepare"],
      verifyDeliveryFn: realVerifierWith(makeFixingRunCommand()),
    });
    assert.equal(resumed.state, "resumed", "the recorded request was reused, the outcome recorded now");
    assert.equal(resumed.requested, false);
    assert.equal(resumed.outcomeRecorded, true);
    assert.equal(resumed.attempt, 2);
    assert.equal(resumed.verificationStatus, "passed");

    const events = readEvents(ctx.runDir);
    const requests = events.filter((e) => e.type === "run.delivery_reverification_requested");
    const outcomes = events.filter((e) => e.type.startsWith("run.delivery_reverification_")
      && e.type !== "run.delivery_reverification_requested");
    assert.equal(requests.length, 2);
    assert.equal(outcomes.length, 2, "exactly one outcome for the resumed second chain");
  } finally {
    await cleanupDir(ctx.repo);
    await cleanupDir(ctx.runDir);
  }
});

test("RV2-R3: repeat attempt-1 (and omitted) calls NEVER run a second verification after chain 1 settles", async () => {
  const ctx = await setupScenario();
  try {
    await runFirstChain(ctx);
    let verifierCalls = 0;
    const counting = async (deliveryRef, opts) => {
      verifierCalls += 1;
      return verifyDelivery(deliveryRef, opts);
    };
    for (const attempt of [undefined, 1]) {
      const r = await runDeliveryReverify({
        runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo,
        reason: "tooling_invalid", ...(attempt !== undefined ? { attempt } : {}),
        verifyDeliveryFn: counting,
      });
      assert.equal(r.state, "idempotent", `attempt ${attempt ?? "omitted"} converges on chain 1`);
      assert.equal(r.attempt, 1);
      assert.equal(r.verificationStatus, "failed");
      assert.equal(r.failureCode, "command_failed");
    }
    assert.equal(verifierCalls, 0, "no verification re-run for attempt-1 repeats");
    const requests = readEvents(ctx.runDir).filter((e) => e.type === "run.delivery_reverification_requested");
    assert.equal(requests.length, 1, "no second chain was created");
  } finally {
    await cleanupDir(ctx.repo);
    await cleanupDir(ctx.runDir);
  }
});

// =====================================================================
// Group 3: the decision gate after the second chain
// =====================================================================

test("RV2-G1: after the second chain passes, an explicit accept succeeds; after it fails, accept is refused", async () => {
  // Passing second chain → accept.
  {
    const ctx = await setupScenario();
    try {
      await runFirstChain(ctx);
      await runDeliveryReverify({
        runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo,
        reason: "environment_contaminated", attempt: 2, setupCommands: ["setup-prepare"],
        verifyDeliveryFn: realVerifierWith(makeFixingRunCommand()),
      });
      const decision = await decideRunDelivery({
        runId: RUN_ID, runDir: ctx.runDir, decision: "accepted", reason: "second chain passed",
      });
      assert.equal(decision.accepted, true);
      // run_delivery reads the latest chain as the effective truth.
      const view = await getRunDelivery({ runId: RUN_ID, runDir: ctx.runDir });
      assert.equal(view.effectiveVerification.status, "passed");
      assert.equal(view.reverify.status, "complete");
      assert.equal(view.reverify.reason, "environment_contaminated");
      assert.equal(view.verification.status, "failed", "original truth unchanged");
    } finally {
      await cleanupDir(ctx.repo);
      await cleanupDir(ctx.runDir);
    }
  }

  // Failing second chain → accept fails closed.
  {
    const ctx = await setupScenario();
    try {
      await runFirstChain(ctx);
      await runDeliveryReverify({
        runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo,
        reason: "environment_contaminated", attempt: 2,
        verifyDeliveryFn: realVerifierWith(makeAlwaysFailingRunCommand()),
      });
      await assert.rejects(
        () => decideRunDelivery({
          runId: RUN_ID, runDir: ctx.runDir, decision: "accepted", reason: "no",
        }),
        (err) => {
          assert.match(err.message, /must be passed/);
          return true;
        },
      );
      // A reject on the same truth stays available (the Lead decides).
      const reject = await decideRunDelivery({
        runId: RUN_ID, runDir: ctx.runDir, decision: "rejected", reason: "still failing",
      });
      assert.equal(reject.accepted, true);
    } finally {
      await cleanupDir(ctx.repo);
      await cleanupDir(ctx.runDir);
    }
  }
});

test("RV2-G2: a reverify run against a transcript whose chain is malformed is refused (fail closed)", async () => {
  const ctx = await setupScenario();
  try {
    const ref = ctx.deliveryRef;
    const base = readEvents(ctx.runDir);
    // An attempt-2 request with NO first chain at all → malformed projection.
    seedTranscript(ctx.runDir, RUN_ID, [
      ...base,
      {
        type: "run.delivery_reverification_requested",
        delivery: ref,
        deliveryCommit: ref.deliveryCommit,
        reason: "tooling_invalid",
        attempt: 2,
      },
    ]);
    await assert.rejects(
      () => runDeliveryReverify({
        runId: RUN_ID, runDir: ctx.runDir, authorizedWorkspaceRoot: ctx.repo,
        reason: "tooling_invalid",
        verifyDeliveryFn: realVerifierWith(makeFixingRunCommand()),
      }),
      /reverify chain is malformed/,
    );
  } finally {
    await cleanupDir(ctx.repo);
    await cleanupDir(ctx.runDir);
  }
});
