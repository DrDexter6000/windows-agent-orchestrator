// test/m12-9-runAwaitOutcome.test.js
//
// M12-9 Package C: the terminal OUTCOME projection added to run_await_result.
//
// Contract (C1–C4):
//   - Outcome is projected ONLY when terminal AND the snapshot was cleanly
//     observed; non-terminal / read_failure / unavailable → outcome=null. (C1)
//   - Closed-set safe facts ONLY: terminalState; diagnosis(category/code/
//     signalCount); delivery(requested/readiness/available/failureCode/
//     verificationStatus/verificationFailureCode/acceptanceStatus/decisionType/
//     isolationFailureCode).
//     NO commit id, changed paths, candidateInventory, diff, command text,
//     message/stderr, absolute path, or recommendation. (C2)
//   - Reuses the diagnosis + delivery SSOTs from ONE snapshot — no second
//     transcript/Git read, no run_collect call, zero messages.collected append. (C3)
//   - Never throws; ambiguous/malformed → safe closed-set fact or null.
//     availableDrilldowns are read-path suggestions only. (C4)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectTerminalOutcome } from "../src/application/runAwaitResult.js";
import { runAwaitResult } from "../src/application/runAwaitResult.js";
import {
  DELIVERY_READINESS_STATES,
  SAFE_ISOLATION_VIOLATION_CODES,
  DELIVERY_VERIFICATION_STATUSES,
  DELIVERY_VERIFICATION_FAILURE_CODES,
  DELIVERY_ACCEPTANCE_STATUSES,
  DELIVERY_DECISION_TYPES,
} from "../src/application/runDelivery.js";
import { DIAGNOSIS_CATEGORIES, DIAGNOSIS_CODES } from "../src/diagnosis.js";
import { PACKAGING_FAILURE_CODES } from "../src/deliveryFailureCodes.js";
import { TERMINAL_STATES } from "../src/transcript.js";

// ===== Helpers =====

function cleanupDir(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

function makeRef(runId, over = {}) {
  return {
    schemaVersion: 1,
    kind: "git_commit",
    runId,
    baseCommit: "b".repeat(40),
    deliveryCommit: "d".repeat(40),
    branch: `wao/${runId}`,
    worktreePath: "/fake/wt",
    changedFiles: ["src/a.js"],
    verification: { status: "pending", commands: [], verifiedCommit: "d".repeat(40), results: [] },
    acceptance: { status: "pending", reviewerType: "lead_agent" },
    integration: { status: "pending", targetCommit: null },
    ...over,
  };
}

function startedWithDelivery(runId) {
  return { type: "run.started", runId, delivery: { mode: "git_commit_v1" }, worktreePath: "/fake/wt" };
}

function terminalCompleted(runId) {
  return [
    { type: "run.state_change", runId, from: "running", to: "completed", reason: "done" },
    { type: "run.completed", runId },
  ];
}

function writeTranscript(runDir, runId, partials) {
  mkdirSync(runDir, { recursive: true });
  const tp = join(runDir, `${runId}.jsonl`);
  let seq = 0;
  const lines = partials.map((p) => JSON.stringify({ ts: "2026-01-01T00:00:00Z", seq: (seq += 1), ...p }));
  writeFileSync(tp, lines.join("\n") + "\n", "utf8");
  return tp;
}

// Assert every closed-set field of an outcome is a member of its closed set.
function assertOutcomeClosedSet(o) {
  assert.ok(TERMINAL_STATES.includes(o.terminalState), "terminalState ∈ TERMINAL_STATES");
  assert.ok(DIAGNOSIS_CATEGORIES.includes(o.diagnosis.category), "diagnosis.category ∈ closed set");
  assert.equal(o.diagnosis.code === null || DIAGNOSIS_CODES.includes(o.diagnosis.code), true, "diagnosis.code ∈ general closed set | null");
  assert.equal(Number.isInteger(o.diagnosis.signalCount) && o.diagnosis.signalCount >= 0, true, "signalCount non-negative int");
  assert.ok(DELIVERY_READINESS_STATES.includes(o.delivery.readiness), "readiness ∈ closed set");
  assert.equal(typeof o.delivery.requested, "boolean");
  assert.equal(typeof o.delivery.available, "boolean");
  assert.equal(o.delivery.failureCode === null || PACKAGING_FAILURE_CODES.includes(o.delivery.failureCode), true, "failureCode ∈ closed set | null");
  assert.equal(o.delivery.verificationStatus === null || DELIVERY_VERIFICATION_STATUSES.includes(o.delivery.verificationStatus), true, "verificationStatus ∈ closed set | null");
  assert.equal(o.delivery.verificationFailureCode === null || DELIVERY_VERIFICATION_FAILURE_CODES.includes(o.delivery.verificationFailureCode), true, "verificationFailureCode ∈ closed set | null");
  assert.equal(o.delivery.acceptanceStatus === null || DELIVERY_ACCEPTANCE_STATUSES.includes(o.delivery.acceptanceStatus), true, "acceptanceStatus ∈ closed set | null");
  assert.equal(o.delivery.decisionType === null || DELIVERY_DECISION_TYPES.includes(o.delivery.decisionType), true, "decisionType ∈ closed set | null");
  assert.equal(o.delivery.isolationFailureCode === null || SAFE_ISOLATION_VIOLATION_CODES.includes(o.delivery.isolationFailureCode), true, "isolationFailureCode ∈ closed set | null (M12-13)");
}

// Assert the outcome leaks NO raw dynamic value (commit/path/command/message).
function assertOutcomeNoLeak(o, runId) {
  const blob = JSON.stringify(o);
  // No commit hashes, worktree path, changed file, or runId-as-delivery-ref leak.
  assert.ok(!blob.includes("b".repeat(40)), "no baseCommit leak");
  assert.ok(!blob.includes("d".repeat(40)), "no deliveryCommit leak");
  assert.ok(!blob.includes("/fake/wt"), "no worktree path leak");
  assert.ok(!blob.includes("src/a.js"), "no changed-path leak");
  assert.ok(!blob.includes("npm test") && !blob.includes("pytest"), "no command text leak");
}

// Declared in ALREADY-SORTED order so they compare equal to Object.keys(o).sort().
// M12-13: isolationFailureCode added (nullable; closed-set code only when the
// terminal delivery-requested run carried exactly one safe workdir_escape
// isolation violation with no higher-priority delivery fact).
const DELIVERY_KEYS = ["acceptanceStatus", "available", "decisionType", "failureCode", "isolationFailureCode", "readiness", "requested", "verificationFailureCode", "verificationStatus"];
const DIAGNOSIS_KEYS = ["category", "code", "signalCount"];
const OUTCOME_KEYS = ["delivery", "diagnosis", "terminalState"];

// ===== C2: unit-level projection (in-memory events) =====

test("C2: completed delivery PASSED → reviewable, verificationStatus=passed, bounded shape", () => {
  const runId = "run_pass";
  const ref = makeRef(runId, { verification: { status: "passed" } });
  const events = [
    startedWithDelivery(runId),
    { type: "run.delivery_created", runId, delivery: ref },
    { type: "run.delivery_verification_passed", runId, delivery: ref },
    ...terminalCompleted(runId),
  ];
  const o = projectTerminalOutcome(events, runId, "completed");
  assert.ok(o, "terminal+clean → outcome present");
  assert.deepEqual(Object.keys(o).sort(), OUTCOME_KEYS);
  assert.deepEqual(Object.keys(o.diagnosis).sort(), DIAGNOSIS_KEYS);
  assert.deepEqual(Object.keys(o.delivery).sort(), DELIVERY_KEYS);
  assert.equal(o.terminalState, "completed");
  assert.equal(o.delivery.requested, true);
  assert.equal(o.delivery.available, true);
  assert.equal(o.delivery.readiness, "reviewable");
  assert.equal(o.delivery.verificationStatus, "passed");
  assert.equal(o.delivery.verificationFailureCode, null);
  assert.equal(o.delivery.acceptanceStatus, "pending");
  assert.equal(o.delivery.decisionType, null);
  assertOutcomeClosedSet(o);
  assertOutcomeNoLeak(o, runId);
});

test("C2: completed delivery FAILED verification → verificationStatus=failed + closed-set failureCode", () => {
  const runId = "run_fail";
  const ref = makeRef(runId, { verification: { status: "failed", failureCode: "command_failed" } });
  const events = [
    startedWithDelivery(runId),
    { type: "run.delivery_created", runId, delivery: ref },
    { type: "run.delivery_verification_failed", runId, delivery: ref },
    ...terminalCompleted(runId),
  ];
  const o = projectTerminalOutcome(events, runId, "completed");
  assert.equal(o.delivery.verificationStatus, "failed");
  assert.equal(o.delivery.verificationFailureCode, "command_failed");
  assert.equal(o.delivery.readiness, "reviewable"); // failed verification is still reviewable
  assertOutcomeClosedSet(o);
  assertOutcomeNoLeak(o, runId);
});

test("C2: completed NON-DELIVERY run → requested=false, readiness=not_requested, statuses null", () => {
  const runId = "run_plain";
  const events = [
    { type: "run.started", runId, backend: "claude-code" },
    ...terminalCompleted(runId),
  ];
  const o = projectTerminalOutcome(events, runId, "completed");
  assert.equal(o.diagnosis.category, "none");
  assert.equal(o.delivery.requested, false);
  assert.equal(o.delivery.available, false);
  assert.equal(o.delivery.readiness, "not_requested");
  assert.equal(o.delivery.verificationStatus, null);
  assert.equal(o.delivery.failureCode, null);
  assertOutcomeClosedSet(o);
});

test("C2: failed run with bound packaging failure → readiness=packaging_failed + closed-set failureCode", () => {
  const runId = "run_pkg";
  const events = [
    startedWithDelivery(runId),
    { type: "run.delivery_failed", runId, deliveryCode: "disallowed_path" },
    { type: "run.state_change", runId, from: "running", to: "failed", reason: "packaging" },
    { type: "run.failed", runId },
  ];
  const o = projectTerminalOutcome(events, runId, "failed");
  assert.equal(o.delivery.requested, true);
  assert.equal(o.delivery.available, false);
  assert.equal(o.delivery.readiness, "packaging_failed");
  assert.equal(o.delivery.failureCode, "disallowed_path");
  // Packaging failure is also surfaced as a diagnosis category (closed set).
  assert.equal(o.diagnosis.category, "delivery_packaging_failed");
  assertOutcomeClosedSet(o);
});

test("C2: ambiguous (durable conflict) → readiness=ambiguous, available=false, no raw leak", () => {
  // A bound created ref whose baseCommit is NON-canonical (HEAD / short SHA) is
  // a durable conflict: BOTH projectDeliveryReadiness and gatherDeliveryView
  // fail closed — readiness "ambiguous", deliveryAvailable false — and NO raw
  // ref/commit/path is echoed (only the closed-set label).
  const runId = "run_amb";
  const badRef = makeRef(runId, { baseCommit: "HEAD", verification: { status: "passed" } });
  const events = [
    startedWithDelivery(runId),
    { type: "run.delivery_created", runId, delivery: badRef },
    ...terminalCompleted(runId),
  ];
  const o = projectTerminalOutcome(events, runId, "completed");
  assert.equal(o.delivery.readiness, "ambiguous");
  assert.equal(o.delivery.available, false);
  assert.equal(o.delivery.verificationStatus, null);
  assert.equal(o.delivery.failureCode, null);
  assertOutcomeClosedSet(o);
  assertOutcomeNoLeak(o, runId);
});

test("C1/C4: non-terminal terminalState → outcome null (not projected)", () => {
  const runId = "run_running";
  const events = [{ type: "run.started", runId }, { type: "run.state_change", runId, to: "running" }];
  assert.equal(projectTerminalOutcome(events, runId, "running"), null);
});

test("C4: garbage terminalState → outcome null (fail closed, never echoes the value)", () => {
  const runId = "run_g";
  const events = [...terminalCompleted(runId)];
  assert.equal(projectTerminalOutcome(events, runId, "C:\\not-a-state"), null);
});

test("C4: a throwing SSOT never escapes — outcome null, never a thrown error", () => {
  const runId = "run_throw";
  const events = [...terminalCompleted(runId)];
  const o = projectTerminalOutcome(events, runId, "completed", {
    diagnoseFn: () => { throw new Error("boom"); },
  });
  assert.equal(o, null);
});

test("C3: cross-run delivery event does not pollute this run's outcome", () => {
  // A delivery event bound to ANOTHER runId must not count for this run.
  const other = "run_other";
  const mine = "run_mine";
  const foreignRef = makeRef(other, { verification: { status: "passed" } });
  const events = [
    { type: "run.started", runId: mine, backend: "claude-code" },
    { type: "run.delivery_created", runId: other, delivery: foreignRef },
    { type: "run.delivery_verification_passed", runId: other, delivery: foreignRef },
    ...terminalCompleted(mine),
  ];
  const o = projectTerminalOutcome(events, mine, "completed");
  assert.equal(o.delivery.requested, false);
  assert.equal(o.delivery.readiness, "not_requested");
});

// ===== C1/C3: MCP-level integration over a real terminal transcript =====

test("C1/C2/C3: run_await_result over a terminal delivery-passed transcript projects a bounded outcome (single read, zero append)", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m129-out-"));
  const runId = "run_mcp_pass";
  try {
    const ref = makeRef(runId, { verification: { status: "passed" } });
    const { readTranscript } = await import("../src/transcript.js");
    writeTranscript(runDir, runId, [
      { type: "run.submitted", runId, agentId: "coder_low" },
      startedWithDelivery(runId),
      { type: "run.delivery_created", runId, delivery: ref },
      { type: "run.delivery_verification_passed", runId, delivery: ref },
      ...terminalCompleted(runId),
    ]);
    const before = readFileSync(join(runDir, `${runId}.jsonl`), "utf8");
    let readCalls = 0;
    const out = await runAwaitResult({
      runId, runDir, waitMs: 0,
      readTranscriptFn: async (p) => { readCalls++; return readTranscript(p); },
    });
    // Terminal + observed → outcome present.
    assert.equal(out.terminal, true);
    assert.equal(out.observationOutcome, "observed");
    assert.ok(out.outcome, "terminal observed → outcome projected");
    assert.equal(out.outcome.terminalState, "completed");
    assert.equal(out.outcome.delivery.readiness, "reviewable");
    assert.equal(out.outcome.delivery.verificationStatus, "passed");
    assertOutcomeClosedSet(out.outcome);
    assertOutcomeNoLeak(out.outcome, runId);
    // Single read (no second transcript read for the outcome), zero append.
    assert.equal(readCalls, 1, "outcome adds no second transcript read");
    const after = readFileSync(join(runDir, `${runId}.jsonl`), "utf8");
    assert.equal(after, before, "transcript bytes unchanged (zero append)");
    assert.equal(after.includes("messages.collected"), false, "no messages.collected append");
  } finally {
    cleanupDir(runDir);
  }
});

test("C1: run_await_result non-terminal (waitMs=0) → outcome null", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m129-nonterm-"));
  const runId = "run_mcp_running";
  try {
    writeTranscript(runDir, runId, [
      { type: "run.submitted", runId, agentId: "coder_low" },
      { type: "run.started", runId, backend: "claude-code" },
      { type: "run.state_change", runId, to: "running" },
    ]);
    const out = await runAwaitResult({ runId, runDir, waitMs: 0 });
    assert.equal(out.terminal, false);
    assert.equal(out.outcome, null, "non-terminal → outcome null");
  } finally {
    cleanupDir(runDir);
  }
});

test("C1: run_await_result read_failure → outcome null", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m129-rf-"));
  const runId = "run_mcp_missing";
  try {
    // No transcript file → initial read throws → read_failure.
    const out = await runAwaitResult({
      runId, runDir, waitMs: 0,
      readTranscriptFn: async () => { throw new Error("read failed"); },
    });
    assert.equal(out.observationOutcome, "read_failure");
    assert.equal(out.outcome, null, "read_failure → outcome null");
  } finally {
    cleanupDir(runDir);
  }
});

test("C2: strict outcome key set — exactly the bounded closed-set fields, nothing dynamic", () => {
  const runId = "run_keys";
  const ref = makeRef(runId, { verification: { status: "passed" } });
  const events = [
    startedWithDelivery(runId),
    { type: "run.delivery_created", runId, delivery: ref },
    { type: "run.delivery_verification_passed", runId, delivery: ref },
    { type: "run.delivery_accepted", runId, delivery: ref, reason: "ok" },
    ...terminalCompleted(runId),
  ];
  const o = projectTerminalOutcome(events, runId, "completed");
  // acceptance settled by a decision event → decisionType closed-set, acceptanceStatus=accepted.
  assert.equal(o.delivery.acceptanceStatus, "accepted");
  assert.equal(o.delivery.decisionType, "run.delivery_accepted");
  // No extra keys anywhere (strict closed shape).
  assert.deepEqual(Object.keys(o).sort(), OUTCOME_KEYS);
  assert.deepEqual(Object.keys(o.diagnosis).sort(), DIAGNOSIS_KEYS);
  assert.deepEqual(Object.keys(o.delivery).sort(), DELIVERY_KEYS);
});
