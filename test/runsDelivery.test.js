// test/runsDelivery.test.js
//
// TD-103 Phase 3C-2: Lead acceptance record — runs delivery <runId>
//
// Tests the transcript-backed Lead acceptance command with atomic
// first-decision-wins behavior.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { JsonlTranscript, readTranscript, findState } from "../src/transcript.js";

// ===== Helpers =====

/** Create a temp dir with a transcript that has a completed delivery lifecycle. */
function makeDeliveryTranscript(prefix = "wao-3c2-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const runId = "run_3c2_test";
  const transcript = new JsonlTranscript(join(dir, `${runId}.jsonl`), {
    runId,
    agentId: "test",
  });
  return { dir, runId, transcript };
}

/** Write a full delivery lifecycle to a transcript: started → created → verified. */
async function writeFullDeliveryLifecycle(transcript, overrides = {}) {
  const deliveryRef = {
    schemaVersion: 1,
    kind: "git_commit",
    runId: transcript.context.runId,
    baseCommit: "b".repeat(40),
    deliveryCommit: "d".repeat(40),
    branch: `wao/${transcript.context.runId}`,
    worktreePath: "/fake/wt",
    changedFiles: ["src/a.js"],
    verification: {
      status: overrides.verificationStatus ?? "passed",
      commands: ["echo ok"],
      verifiedCommit: "d".repeat(40),
      results: [],
      ...(overrides.verificationFailureCode ? { failureCode: overrides.verificationFailureCode } : {}),
    },
    acceptance: { status: "pending", reviewerType: "lead_agent" },
    integration: { status: "pending", targetCommit: null },
    ...overrides.ref,
  };

  await transcript.append("run.started", {
    delivery: {
      mode: "git_commit_v1",
      baseCommit: "b".repeat(40),
      allowedPaths: ["src"],
      verificationCommands: ["echo ok"],
    },
    worktreePath: "/fake/wt",
    worktreeBranch: `wao/${transcript.context.runId}`,
  });
  await transcript.append("run.delivery_created", { delivery: deliveryRef });
  const verificationStatus = overrides.verificationStatus ?? "passed";
  const eventType = verificationStatus === "passed"
    ? "run.delivery_verification_passed"
    : verificationStatus === "failed"
      ? "run.delivery_verification_failed"
      : "run.delivery_verification_unavailable";
  await transcript.append(eventType, { delivery: deliveryRef });
  await transcript.append("run.state_change", { from: "running", to: "completed", reason: "done" });
  return deliveryRef;
}

async function cleanupDir(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { if (attempt === 4) return; await new Promise((r) => setTimeout(r, 50 * (attempt + 1))); }
  }
}

/** Capture console.log output. */
async function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.map(String).join(" ")); };
  try { await fn(); }
  finally { console.log = orig; }
  return lines.join("\n");
}

// ===== 3C-2 Tests =====

/**
 * 3C2-01: query reconstructs pending delivery after verification passed.
 */
test("3C2-Q01: query reconstructs pending delivery after verification passed", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("wao-3c2-q01-");
  try {
    await writeFullDeliveryLifecycle(transcript);

    const { runsDeliveryCommand } = await import("../src/commands/runs.js");
    const out = await captureLog(async () => {
      await runsDeliveryCommand([runId, "--run-dir", dir, "--format", "json"], {});
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.runId, runId);
    assert.equal(parsed.terminalState, "completed");
    assert.ok(parsed.deliveryRef, "must have latest DeliveryRef");
    assert.equal(parsed.deliveryRef.deliveryCommit, "d".repeat(40));
    assert.equal(parsed.verification.status, "passed");
    assert.equal(parsed.acceptance.status, "pending");
  } finally {
    await cleanupDir(dir);
  }
});

/**
 * 3C2-02: accept creates one accepted event and changes only acceptance in the returned DeliveryRef.
 */
test("3C2-A02: accept creates one accepted event, only acceptance changes", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("wao-3c2-a02-");
  try {
    await writeFullDeliveryLifecycle(transcript);
    const reasonPath = join(dir, "reason.txt");
    writeFileSync(reasonPath, "LGTM — tests pass and code is clean", "utf8");

    const { runsDeliveryCommand } = await import("../src/commands/runs.js");
    const out = await captureLog(async () => {
      await runsDeliveryCommand([runId, "--accept", "--reason-file", reasonPath, "--run-dir", dir, "--format", "json"], {});
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.decisionAccepted, true);
    assert.equal(parsed.delivery.acceptance.status, "accepted");
    assert.equal(parsed.delivery.acceptance.reviewerType, "lead_agent");
    assert.equal(parsed.delivery.verification.status, "passed", "verification unchanged");
    assert.equal(parsed.delivery.deliveryCommit, "d".repeat(40), "deliveryCommit unchanged");

    const events = await readTranscript(transcript.filePath);
    const acceptedEvents = events.filter((e) => e.type === "run.delivery_accepted");
    assert.equal(acceptedEvents.length, 1, "exactly one accepted event");
    assert.equal(acceptedEvents[0].delivery.acceptance.status, "accepted");
    assert.ok(acceptedEvents[0].reason.includes("LGTM"), "reason preserved");
  } finally {
    await cleanupDir(dir);
  }
});

/**
 * 3C2-03: reject creates one rejected event.
 */
test("3C2-A03: reject creates one rejected event", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("wao-3c2-a03-");
  try {
    await writeFullDeliveryLifecycle(transcript);
    const reasonPath = join(dir, "reason.txt");
    writeFileSync(reasonPath, "Missing edge case for empty input", "utf8");

    const { runsDeliveryCommand } = await import("../src/commands/runs.js");
    const out = await captureLog(async () => {
      await runsDeliveryCommand([runId, "--reject", "--reason-file", reasonPath, "--run-dir", dir, "--format", "json"], {});
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.decisionAccepted, true);
    assert.equal(parsed.delivery.acceptance.status, "rejected");

    const events = await readTranscript(transcript.filePath);
    const rejectedEvents = events.filter((e) => e.type === "run.delivery_rejected");
    assert.equal(rejectedEvents.length, 1, "exactly one rejected event");
  } finally {
    await cleanupDir(dir);
  }
});

/**
 * 3C2-04: accept is refused when verification is failed or unavailable.
 */
test("3C2-A04: accept refused when verification failed", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("wao-3c2-a04-");
  try {
    await writeFullDeliveryLifecycle(transcript, {
      verificationStatus: "failed",
      verificationFailureCode: "command_failed",
    });
    const reasonPath = join(dir, "reason.txt");
    writeFileSync(reasonPath, "looks good to me", "utf8");

    const { runsDeliveryCommand } = await import("../src/commands/runs.js");
    await assert.rejects(
      () => runsDeliveryCommand([runId, "--accept", "--reason-file", reasonPath, "--run-dir", dir, "--format", "json"], {}),
      /verification.*passed|cannot accept/i,
      "accept should be refused when verification is failed",
    );

    const events = await readTranscript(transcript.filePath);
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted").length, 0,
      "no accepted event should be written");
  } finally {
    await cleanupDir(dir);
  }
});

/**
 * 3C2-05: reject is allowed for verification failed.
 */
test("3C2-A05: reject allowed for verification failed", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("wao-3c2-a05-");
  try {
    await writeFullDeliveryLifecycle(transcript, {
      verificationStatus: "failed",
      verificationFailureCode: "command_failed",
    });
    const reasonPath = join(dir, "reason.txt");
    writeFileSync(reasonPath, "verification failed, rejecting", "utf8");

    const { runsDeliveryCommand } = await import("../src/commands/runs.js");
    const out = await captureLog(async () => {
      await runsDeliveryCommand([runId, "--reject", "--reason-file", reasonPath, "--run-dir", dir, "--format", "json"], {});
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.decisionAccepted, true);
    assert.equal(parsed.delivery.acceptance.status, "rejected");
  } finally {
    await cleanupDir(dir);
  }
});

/**
 * 3C2-06: missing/blank reason file fails before append.
 */
test("3C2-A06: missing/blank reason file fails before append", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("wao-3c2-a06-");
  try {
    await writeFullDeliveryLifecycle(transcript);

    const { runsDeliveryCommand } = await import("../src/commands/runs.js");
    // No reason file at all
    await assert.rejects(
      () => runsDeliveryCommand([runId, "--accept", "--reason-file", join(dir, "nonexistent.txt"), "--run-dir", dir], {}),
      /reason/i,
      "missing reason file should fail",
    );

    // Blank reason file
    const blankPath = join(dir, "blank.txt");
    writeFileSync(blankPath, "   \n  \n", "utf8");
    await assert.rejects(
      () => runsDeliveryCommand([runId, "--accept", "--reason-file", blankPath, "--run-dir", dir], {}),
      /reason/i,
      "blank reason file should fail",
    );

    const events = await readTranscript(transcript.filePath);
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted").length, 0,
      "no accepted event for missing/blank reason");
  } finally {
    await cleanupDir(dir);
  }
});

/**
 * 3C2-07: accept+reject flags together fail before append.
 */
test("3C2-A07: accept+reject together fail before append", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("wao-3c2-a07-");
  try {
    await writeFullDeliveryLifecycle(transcript);
    const reasonPath = join(dir, "reason.txt");
    writeFileSync(reasonPath, "can't decide", "utf8");

    const { runsDeliveryCommand } = await import("../src/commands/runs.js");
    await assert.rejects(
      () => runsDeliveryCommand([runId, "--accept", "--reject", "--reason-file", reasonPath, "--run-dir", dir], {}),
      /mutually exclusive|both/i,
      "accept+reject together should fail",
    );
  } finally {
    await cleanupDir(dir);
  }
});

/**
 * 3C2-08: no delivery / proposed delivery / malformed DeliveryRef fails closed.
 */
test("3C2-A08: no delivery fails closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-3c2-a08-"));
  const runId = "run_3c2_nodelivery";
  const transcript = new JsonlTranscript(join(dir, `${runId}.jsonl`), { runId, agentId: "test" });
  try {
    // Write a completed run with NO delivery events
    await transcript.append("run.started", {});
    await transcript.append("run.state_change", { from: "running", to: "completed", reason: "done" });

    const { runsDeliveryCommand } = await import("../src/commands/runs.js");
    await assert.rejects(
      () => runsDeliveryCommand([runId, "--run-dir", dir], {}),
      /no.*delivery|committed delivery/i,
      "run without delivery should fail closed",
    );
  } finally {
    await cleanupDir(dir);
  }
});

/**
 * 3C2-09: repeated identical decision appends no second event and returns existing decision.
 */
test("3C2-A09: repeated identical decision appends no second event", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("wao-3c2-a09-");
  try {
    await writeFullDeliveryLifecycle(transcript);
    const reasonPath = join(dir, "reason.txt");
    writeFileSync(reasonPath, "approved", "utf8");

    const { runsDeliveryCommand } = await import("../src/commands/runs.js");
    // First accept
    const out1 = await captureLog(async () => {
      await runsDeliveryCommand([runId, "--accept", "--reason-file", reasonPath, "--run-dir", dir, "--format", "json"], {});
    });
    const parsed1 = JSON.parse(out1);
    assert.equal(parsed1.decisionAccepted, true);

    // Second accept (same decision)
    const out2 = await captureLog(async () => {
      await runsDeliveryCommand([runId, "--accept", "--reason-file", reasonPath, "--run-dir", dir, "--format", "json"], {});
    });
    const parsed2 = JSON.parse(out2);
    assert.equal(parsed2.decisionAccepted, false, "second identical decision should be a loser");
    assert.ok(parsed2.existing, "loser should get existing decision");
    assert.equal(parsed2.existing.status, "accepted");

    const events = await readTranscript(transcript.filePath);
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted").length, 1,
      "still exactly one accepted event");
  } finally {
    await cleanupDir(dir);
  }
});

/**
 * 3C2-10: later opposite decision loses and appends no contradictory event.
 */
test("3C2-A10: later opposite decision loses, no contradictory event", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("wao-3c2-a10-");
  try {
    await writeFullDeliveryLifecycle(transcript);
    const reasonPath = join(dir, "reason.txt");
    writeFileSync(reasonPath, "approved", "utf8");
    const rejectPath = join(dir, "reject.txt");
    writeFileSync(rejectPath, "rejected because bad", "utf8");

    const { runsDeliveryCommand } = await import("../src/commands/runs.js");
    // First: accept
    await captureLog(async () => {
      await runsDeliveryCommand([runId, "--accept", "--reason-file", reasonPath, "--run-dir", dir, "--format", "json"], {});
    });
    // Second: reject (opposite)
    const out2 = await captureLog(async () => {
      await runsDeliveryCommand([runId, "--reject", "--reason-file", rejectPath, "--run-dir", dir, "--format", "json"], {});
    });
    const parsed2 = JSON.parse(out2);
    assert.equal(parsed2.decisionAccepted, false, "opposite decision should lose");
    assert.equal(parsed2.existing.status, "accepted", "existing decision is accepted");

    const events = await readTranscript(transcript.filePath);
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted").length, 1);
    assert.equal(events.filter((e) => e.type === "run.delivery_rejected").length, 0,
      "no contradictory rejected event");
  } finally {
    await cleanupDir(dir);
  }
});

/**
 * 3C2-11: two JsonlTranscript instances racing through Promise.all produce exactly one decision event.
 */
test("3C2-A11: two transcript instances racing → exactly one decision event", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("wao-3c2-a11-");
  try {
    await writeFullDeliveryLifecycle(transcript);
    const reasonPath = join(dir, "reason.txt");
    writeFileSync(reasonPath, "approved by both", "utf8");

    // Two separate transcript instances pointing to the same file
    const t1 = new JsonlTranscript(join(dir, `${runId}.jsonl`), { runId, agentId: "test", initialSeq: 5 });
    const t2 = new JsonlTranscript(join(dir, `${runId}.jsonl`), { runId, agentId: "test", initialSeq: 5 });

    const results = await Promise.all([
      t1.tryAppendDecision({
        deliveryRef: { deliveryCommit: "d".repeat(40), acceptance: { status: "pending", reviewerType: "lead_agent" } },
        decision: "accepted",
        reason: "approved by both",
      }),
      t2.tryAppendDecision({
        deliveryRef: { deliveryCommit: "d".repeat(40), acceptance: { status: "pending", reviewerType: "lead_agent" } },
        decision: "accepted",
        reason: "approved by both",
      }),
    ]);

    const winners = results.filter((r) => r.accepted);
    const losers = results.filter((r) => !r.accepted);
    assert.equal(winners.length, 1, "exactly one winner");
    assert.equal(losers.length, 1, "exactly one loser");

    const events = await readTranscript(transcript.filePath);
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted").length, 1,
      "exactly one accepted event on disk");
  } finally {
    await cleanupDir(dir);
  }
});

/**
 * 3C2-12: two real forked Node processes with IPC ready/go barrier produce exactly one decision event.
 * No sleep-based race test.
 */
test("3C2-A12: two forked processes with IPC barrier → exactly one decision event", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("wao-3c2-a12-");
  try {
    await writeFullDeliveryLifecycle(transcript);
    const reasonPath = join(dir, "reason.txt");
    writeFileSync(reasonPath, "fork-approved", "utf8");

    // Fork two child processes that use tryAppendDecision, synchronized via IPC
    const { fork } = await import("node:child_process");
    const { pathToFileURL } = await import("node:url");
    const transcriptUrl = pathToFileURL(resolve(process.cwd(), "src/transcript.js")).href;
    const filePath = join(dir, runId + ".jsonl").replace(/\\/g, "/");
    const workerScript = join(dir, "worker.mjs");
    writeFileSync(workerScript, `
import { JsonlTranscript } from "${transcriptUrl}";
import { pathToFileURL } from "node:url";
const runId = "${runId}";
const filePath = "${filePath}";
const reason = "fork-approved";
const deliveryCommit = "${"d".repeat(40)}";

const t = new JsonlTranscript(filePath, { runId, agentId: "test", initialSeq: 10 });

process.on("message", async (msg) => {
  if (msg === "go") {
    const result = await t.tryAppendDecision({
      deliveryRef: { deliveryCommit, acceptance: { status: "pending", reviewerType: "lead_agent" } },
      decision: "accepted",
      reason,
    });
    process.send({ accepted: result.accepted });
    process.exit(0);
  }
});
process.send("ready");
`, "utf8");

    const children = [fork(workerScript), fork(workerScript)];
    // Wait for both to be ready
    const readyPromises = children.map((c) => new Promise((r) => c.on("message", (m) => { if (m === "ready") r(); })));
    await Promise.all(readyPromises);
    // Send go to both simultaneously
    for (const c of children) c.send("go");
    // Collect results
    const resultPromises = children.map((c) => new Promise((r) => c.on("message", (m) => { if (m && typeof m.accepted === "boolean") r(m); })));
    const results = await Promise.all(resultPromises);
    for (const c of children) c.kill();

    const winners = results.filter((r) => r.accepted);
    assert.equal(winners.length, 1, "exactly one winner across forked processes");

    const events = await readTranscript(transcript.filePath);
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted").length, 1,
      "exactly one accepted event on disk");
  } finally {
    await cleanupDir(dir);
  }
});

/**
 * 3C2-13: accepted/rejected event reason passes through transcript redaction.
 */
test("3C2-A13: decision reason passes through transcript redaction", async () => {
  // Set a test secret in process.env so the redactor picks it up.
  // Value is constructed at runtime to avoid tripping the static secret scanner.
  const testSecret = ["TEST", "SECRET", "VALUE", "12345"].join("_");
  process.env.TEST_API_KEY = testSecret;
  try {
    const { dir, runId, transcript } = makeDeliveryTranscript("wao-3c2-a13-");
    // Create transcript AFTER setting env so redactor captures the secret
    const freshTranscript = new JsonlTranscript(join(dir, `${runId}.jsonl`), { runId, agentId: "test" });
    try {
      await writeFullDeliveryLifecycle(freshTranscript);
      const reasonPath = join(dir, "reason.txt");
      // Include the test secret in the reason
      writeFileSync(reasonPath, `approved — api key is ${testSecret}`, "utf8");

      const { runsDeliveryCommand } = await import("../src/commands/runs.js");
      await captureLog(async () => {
        await runsDeliveryCommand([runId, "--accept", "--reason-file", reasonPath, "--run-dir", dir, "--format", "json"], {});
      });

      const events = await readTranscript(freshTranscript.filePath);
      const acceptedEvent = events.find((e) => e.type === "run.delivery_accepted");
      assert.ok(acceptedEvent, "accepted event must exist");
      const eventJson = JSON.stringify(acceptedEvent);
      assert.ok(!eventJson.includes(testSecret),
        "secret value must be redacted from transcript");
      assert.ok(eventJson.includes("approved"),
        "non-secret part of reason must survive");
      assert.ok(eventJson.includes("[REDACTED:"),
        "redaction marker must be present");
    } finally {
      await cleanupDir(dir);
    }
  } finally {
    delete process.env.TEST_API_KEY;
  }
});

/**
 * 3C2-14: simulated append failure propagates and does not set in-memory success flag.
 */
test("3C2-A14: append failure propagates, no in-memory success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-3c2-a14-"));
  const runId = "run_3c2_a14";
  const realPath = join(dir, `${runId}.jsonl`);
  const transcript = new JsonlTranscript(realPath, { runId, agentId: "test" });
  try {
    await writeFullDeliveryLifecycle(transcript);

    // Create a "blocker" file that makes the target path's parent a file, not a dir.
    // tryAppendDecision does mkdir(recursive) first, which will fail with ENOTDIR
    // because a regular file exists where a directory is expected.
    const blockerDir = join(dir, "blocker_file");
    writeFileSync(blockerDir, "I am a file, not a directory", "utf8");
    const badPath = join(blockerDir, "subdir", `${runId}.jsonl`);
    const badTranscript = new JsonlTranscript(badPath, { runId, agentId: "test", initialSeq: 10 });

    await assert.rejects(
      () => badTranscript.tryAppendDecision({
        deliveryRef: { deliveryCommit: "d".repeat(40), acceptance: { status: "pending", reviewerType: "lead_agent" } },
        decision: "accepted",
        reason: "approved",
      }),
      (err) => err instanceof Error,
      "append failure must propagate (not silently succeed)",
    );

    // No accepted event should be on disk
    const events = await readTranscript(realPath);
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted").length, 0,
      "no accepted event after append failure");
  } finally {
    await cleanupDir(dir);
  }
});

/**
 * 3C2-15: ordinary run/status/runs aggregation behavior is unchanged.
 */
test("3C2-A15: ordinary runs list behavior unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-3c2-a15-"));
  const runId = "run_3c2_ordinary";
  const transcript = new JsonlTranscript(join(dir, `${runId}.jsonl`), { runId, agentId: "test" });
  try {
    // Ordinary run with no delivery
    await transcript.append("run.started", { agentId: "test" });
    await transcript.append("run.state_change", { from: "running", to: "completed", reason: "done" });

    const { runsCommand } = await import("../src/commands/runs.js");
    // runs list should still work
    const out = await captureLog(async () => {
      await runsCommand(["list", "--run-dir", dir], {});
    });
    assert.ok(out.includes(runId), "ordinary run should appear in list");
  } finally {
    await cleanupDir(dir);
  }
});

// ===== Phase 3C-2 audit closeout: durable precondition RED tests =====

/**
 * A. Only run.delivery_created, verification=pending, no verification outcome event.
 * --reject must fail; no run.delivery_rejected must be appended.
 */
test("3C2-PRE-A: reject on pending verification (no outcome event) fails closed", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("wao-3c2-pre-a-");
  try {
    // Write delivery_created but NO verification event
    const ref = {
      schemaVersion: 1, kind: "git_commit", runId,
      baseCommit: "b".repeat(40), deliveryCommit: "d".repeat(40),
      branch: `wao/${runId}`, worktreePath: "/fake/wt", changedFiles: ["src/a.js"],
      verification: { status: "pending", commands: ["echo ok"] },
      acceptance: { status: "pending", reviewerType: "lead_agent" },
      integration: { status: "pending", targetCommit: null },
    };
    await transcript.append("run.started", { delivery: { mode: "git_commit_v1", baseCommit: "b".repeat(40), allowedPaths: ["src"], verificationCommands: ["echo ok"] } });
    await transcript.append("run.delivery_created", { delivery: ref });
    await transcript.append("run.state_change", { from: "running", to: "completed", reason: "done" });

    const reasonPath = join(dir, "reason.txt");
    writeFileSync(reasonPath, "rejecting before verification", "utf8");

    const { runsDeliveryCommand } = await import("../src/commands/runs.js");
    await assert.rejects(
      () => runsDeliveryCommand([runId, "--reject", "--reason-file", reasonPath, "--run-dir", dir, "--format", "json"], {}),
      /verification|cannot reject/i,
      "reject on pending verification must fail",
    );

    const events = await readTranscript(transcript.filePath);
    assert.equal(events.filter((e) => e.type === "run.delivery_rejected").length, 0,
      "no rejected event must be appended");
  } finally {
    await cleanupDir(dir);
  }
});

/**
 * B. Verification outcome completely missing (no verification event at all).
 * Both accept and reject must fail closed; no decision event appended.
 */
test("3C2-PRE-B: missing verification outcome → accept/reject both fail closed", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("wao-3c2-pre-b-");
  try {
    const ref = {
      schemaVersion: 1, kind: "git_commit", runId,
      baseCommit: "b".repeat(40), deliveryCommit: "d".repeat(40),
      branch: `wao/${runId}`, worktreePath: "/fake/wt", changedFiles: ["src/a.js"],
      verification: { status: "pending", commands: ["echo ok"] },
      acceptance: { status: "pending", reviewerType: "lead_agent" },
      integration: { status: "pending", targetCommit: null },
    };
    await transcript.append("run.started", {});
    await transcript.append("run.delivery_created", { delivery: ref });
    await transcript.append("run.state_change", { from: "running", to: "completed", reason: "done" });

    const reasonPath = join(dir, "reason.txt");
    writeFileSync(reasonPath, "some reason", "utf8");

    const { runsDeliveryCommand } = await import("../src/commands/runs.js");
    await assert.rejects(
      () => runsDeliveryCommand([runId, "--accept", "--reason-file", reasonPath, "--run-dir", dir], {}),
      /verification|cannot accept/i,
      "accept with missing verification must fail",
    );
    await assert.rejects(
      () => runsDeliveryCommand([runId, "--reject", "--reason-file", reasonPath, "--run-dir", dir], {}),
      /verification|cannot reject/i,
      "reject with missing verification must fail",
    );

    const events = await readTranscript(transcript.filePath);
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted" || e.type === "run.delivery_rejected").length, 0,
      "no decision event must be appended");
  } finally {
    await cleanupDir(dir);
  }
});

/**
 * C. Two run.delivery_created events (duplicate delivery).
 * Accept/reject must fail closed; must not "take the latest and proceed".
 */
test("3C2-PRE-C: two delivery_created events → fail closed", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("wao-3c2-pre-c-");
  try {
    const ref1 = {
      schemaVersion: 1, kind: "git_commit", runId,
      baseCommit: "b".repeat(40), deliveryCommit: "d1".padEnd(40, "1"),
      branch: `wao/${runId}`, worktreePath: "/fake/wt", changedFiles: ["src/a.js"],
      verification: { status: "passed", commands: ["echo ok"], verifiedCommit: "d1".padEnd(40, "1"), results: [] },
      acceptance: { status: "pending", reviewerType: "lead_agent" },
      integration: { status: "pending", targetCommit: null },
    };
    const ref2 = {
      ...ref1,
      deliveryCommit: "d2".padEnd(40, "2"),
      verification: { ...ref1.verification, verifiedCommit: "d2".padEnd(40, "2") },
    };
    await transcript.append("run.started", {});
    await transcript.append("run.delivery_created", { delivery: ref1 });
    await transcript.append("run.delivery_verification_passed", { delivery: ref1 });
    await transcript.append("run.delivery_created", { delivery: ref2 });
    await transcript.append("run.delivery_verification_passed", { delivery: ref2 });
    await transcript.append("run.state_change", { from: "running", to: "completed", reason: "done" });

    const reasonPath = join(dir, "reason.txt");
    writeFileSync(reasonPath, "which one?", "utf8");

    const { runsDeliveryCommand } = await import("../src/commands/runs.js");
    await assert.rejects(
      () => runsDeliveryCommand([runId, "--accept", "--reason-file", reasonPath, "--run-dir", dir], {}),
      /multiple|exactly one|ambiguous/i,
      "accept with duplicate delivery must fail",
    );

    const events = await readTranscript(transcript.filePath);
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted").length, 0,
      "no accepted event for duplicate delivery");
  } finally {
    await cleanupDir(dir);
  }
});

/**
 * D. Verification event's deliveryCommit does not match delivery_created's deliveryCommit.
 * Accept/reject must fail closed.
 */
test("3C2-PRE-D: verification commit mismatch → fail closed", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("wao-3c2-pre-d-");
  try {
    const createdRef = {
      schemaVersion: 1, kind: "git_commit", runId,
      baseCommit: "b".repeat(40), deliveryCommit: "d".repeat(40),
      branch: `wao/${runId}`, worktreePath: "/fake/wt", changedFiles: ["src/a.js"],
      verification: { status: "pending", commands: ["echo ok"] },
      acceptance: { status: "pending", reviewerType: "lead_agent" },
      integration: { status: "pending", targetCommit: null },
    };
    const verifiedRef = {
      ...createdRef,
      deliveryCommit: "e".repeat(40), // different commit!
      verification: { status: "passed", commands: ["echo ok"], verifiedCommit: "e".repeat(40), results: [] },
    };
    await transcript.append("run.started", {});
    await transcript.append("run.delivery_created", { delivery: createdRef });
    await transcript.append("run.delivery_verification_passed", { delivery: verifiedRef });
    await transcript.append("run.state_change", { from: "running", to: "completed", reason: "done" });

    const reasonPath = join(dir, "reason.txt");
    writeFileSync(reasonPath, "accepting mismatched", "utf8");

    const { runsDeliveryCommand } = await import("../src/commands/runs.js");
    await assert.rejects(
      () => runsDeliveryCommand([runId, "--accept", "--reason-file", reasonPath, "--run-dir", dir], {}),
      /mismatch|inconsistent|deliveryCommit/i,
      "accept with commit mismatch must fail",
    );

    const events = await readTranscript(transcript.filePath);
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted").length, 0,
      "no accepted event for commit mismatch");
  } finally {
    await cleanupDir(dir);
  }
});

/**
 * E. Stale caller TOCTOU: CLI pre-reads, then transcript gets a duplicate delivery
 * before the atomic claim. The in-lock check must reject based on latest transcript.
 */
test("3C2-PRE-E: stale caller — in-lock recheck rejects duplicate added after pre-read", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("wao-3c2-pre-e-");
  try {
    // Write a valid delivery lifecycle
    await writeFullDeliveryLifecycle(transcript);

    const reasonPath = join(dir, "reason.txt");
    writeFileSync(reasonPath, "stale caller accept", "utf8");

    // Pre-read the transcript (simulating CLI's lock-external read)
    const preEvents = await readTranscript(transcript.filePath);
    const { latestRef } = _reconstructDeliveryExported(preEvents);
    assert.ok(latestRef, "pre-read must find a delivery ref");

    // Now inject a SECOND delivery_created before the decision attempt
    const secondRef = {
      ...latestRef,
      deliveryCommit: "f".repeat(40),
      verification: { status: "passed", commands: ["echo ok"], verifiedCommit: "f".repeat(40), results: [] },
    };
    await transcript.append("run.delivery_created", { delivery: secondRef });
    await transcript.append("run.delivery_verification_passed", { delivery: secondRef });

    // The decision command should fail because the in-lock check sees two deliveries
    const { runsDeliveryCommand } = await import("../src/commands/runs.js");
    await assert.rejects(
      () => runsDeliveryCommand([runId, "--accept", "--reason-file", reasonPath, "--run-dir", dir], {}),
      /multiple|exactly one|ambiguous/i,
      "in-lock recheck must detect duplicate delivery added after pre-read",
    );

    const events = await readTranscript(transcript.filePath);
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted").length, 0,
      "no accepted event despite stale caller having a valid pre-read");
  } finally {
    await cleanupDir(dir);
  }
});

/** Exported wrapper for testing _reconstructDelivery (not part of public API). */
function _reconstructDeliveryExported(events) {
  // Inline copy of the logic for test-side pre-read verification
  let latestRef = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === "run.delivery_created" && events[i].delivery) {
      latestRef = events[i].delivery;
      break;
    }
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if ((e.type === "run.delivery_verification_passed"
      || e.type === "run.delivery_verification_failed"
      || e.type === "run.delivery_verification_unavailable")
      && e.delivery) {
      latestRef = e.delivery;
      break;
    }
  }
  return { latestRef };
}
