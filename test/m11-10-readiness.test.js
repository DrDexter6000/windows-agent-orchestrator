// test/m11-10-readiness.test.js
//
// M11-10: Delivery Readiness Handshake.
//
// Extends the existing run_delivery tool (NO new MCP tool) with an optional
// `waitMs` bounded, read-only wait. When omitted, run_delivery keeps its exact
// point-in-time output. When provided, the application service projects a strict
// closed-set readiness value and waits (non-busy, workspace/runId-bound, zero
// transcript append) until the readiness settles or waitMs expires.
//
// The shared readiness projection + wait live in the application layer
// (src/application/runDelivery.js). CLI and MCP both delegate to the SAME
// service; MCP does not parse the transcript itself and does not shell out to
// the CLI. The wait reuses the run_wait SDK-native progress/timeout pattern.
//
// Coverage:
//   - projectDeliveryReadiness closed set (6 values) + fail-closed ambiguity.
//   - getRunDeliveryReadiness wait: RED→GREEN (delayed verification append →
//     reviewable early), deadline-expired-while-pending is NOT an error,
//     non-waiting states return early, zero transcript append, non-busy poll,
//     workspace/runId binding.
//   - MCP run_delivery waitMs: input schema (shared-constant-locked bounds),
//     output schema (readiness/waitReturnedEarly present iff waitMs provided),
//     point-in-time parity (exact old field set), real Client+InMemoryTransport,
//     progress keepalive (onprogress fires; no token → no notifications),
//     workspace-bound, real default-service RED→GREEN, deadline pending ≠ error.
//   - CLI `runs delivery <runId> --wait-ms N` parity.
//   - Shared constants lock the waitMs schema.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  projectDeliveryReadiness,
  getRunDeliveryReadiness,
  getRunDelivery,
  DELIVERY_READINESS_STATES,
  DELIVERY_WAIT_MS_MIN,
  DELIVERY_WAIT_MS_MAX,
} from "../src/application/runDelivery.js";
import { createWaoMcpServer } from "../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CompatibilityCallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// ===== Helpers =====

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function makeGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "R.md"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: dir });
}

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

/** Write a fresh transcript from a list of partial events (envelope ts/seq added). */
function writeTranscript(runDir, runId, partials) {
  mkdirSync(runDir, { recursive: true });
  const tp = join(runDir, `${runId}.jsonl`);
  let seq = 0;
  const lines = partials.map((p) => JSON.stringify({ ts: "2026-01-01T00:00:00Z", seq: (seq += 1), ...p }));
  writeFileSync(tp, lines.join("\n") + "\n", "utf8");
  return tp;
}

function appendEvent(tp, partial) {
  appendFileSync(tp, JSON.stringify({ ts: "2026-01-01T00:00:00Z", seq: 9999, ...partial }) + "\n", "utf8");
}

function startedWithDelivery(runId) {
  return { type: "run.started", runId, delivery: { mode: "git_commit_v1" }, worktreePath: "/fake/wt" };
}
function startedPlain(runId) {
  return { type: "run.started", runId, backend: "claude-code" };
}
function terminal(runId) {
  return [
    { type: "run.state_change", runId, from: "running", to: "completed", reason: "done" },
    { type: "run.completed", runId },
  ];
}

async function buildClient(server) {
  const [c1, s1] = InMemoryTransport.createLinkedPair();
  await server.connect(s1);
  const client = new Client({ name: "m1110-test", version: "0" }, { version: "0" });
  await client.connect(c1);
  return client;
}

// =====================================================================
// Group 1: projectDeliveryReadiness closed set (pure projection)
// =====================================================================

test("M11-10-READY-01: closed set is exactly the 7 values (M12-13 added isolation_failed)", () => {
  assert.deepEqual(
    [...DELIVERY_READINESS_STATES].sort(),
    ["ambiguous", "isolation_failed", "not_requested", "packaging_failed", "reviewable", "waiting_for_packaging", "waiting_for_verification"].sort(),
  );
});

test("M11-10-READY-02: reviewable — exactly one created + one matching bound verification", () => {
  const runId = "run_r";
  const ref = makeRef(runId);
  const events = [
    startedWithDelivery(runId),
    { type: "run.delivery_created", runId, delivery: ref },
    { type: "run.delivery_verification_passed", runId, delivery: ref },
    ...terminal(runId),
  ];
  assert.equal(projectDeliveryReadiness(events, runId), "reviewable");
  // failed verification is still reviewable (not auto-rejected)
  const failed = makeRef(runId, { verification: { status: "failed", failureCode: "command_failed" } });
  assert.equal(projectDeliveryReadiness([
    startedWithDelivery(runId),
    { type: "run.delivery_created", runId, delivery: failed },
    { type: "run.delivery_verification_failed", runId, delivery: failed },
    ...terminal(runId),
  ], runId), "reviewable");
  // unavailable verification is still reviewable
  assert.equal(projectDeliveryReadiness([
    startedWithDelivery(runId),
    { type: "run.delivery_created", runId, delivery: ref },
    { type: "run.delivery_verification_unavailable", runId, delivery: ref },
    ...terminal(runId),
  ], runId), "reviewable");
});

test("M11-10-READY-03: waiting_for_verification — created present, no verification", () => {
  const runId = "run_wfv";
  const events = [
    startedWithDelivery(runId),
    { type: "run.delivery_created", runId, delivery: makeRef(runId) },
    ...terminal(runId),
  ];
  assert.equal(projectDeliveryReadiness(events, runId), "waiting_for_verification");
});

test("M11-10-READY-04: waiting_for_packaging — delivery requested, no created/failed", () => {
  const runId = "run_wfp";
  const events = [startedWithDelivery(runId)];
  assert.equal(projectDeliveryReadiness(events, runId), "waiting_for_packaging");
});

test("M11-10-READY-04b: terminal delivery intent without packaging outcome is ambiguous", () => {
  const runId = "run_wfp_terminal";
  const events = [startedWithDelivery(runId), ...terminal(runId)];
  assert.equal(projectDeliveryReadiness(events, runId), "ambiguous");
});

test("M11-10-READY-05: packaging_failed — bound run.delivery_failed, no created", () => {
  const runId = "run_pf";
  const events = [
    startedWithDelivery(runId),
    { type: "run.delivery_failed", runId, deliveryCode: "base_commit_mismatch" },
    ...terminal(runId),
  ];
  assert.equal(projectDeliveryReadiness(events, runId), "packaging_failed");
});

test("M11-10-READY-06: not_requested — no delivery mode, no delivery events", () => {
  const runId = "run_nr";
  const events = [startedPlain(runId), ...terminal(runId)];
  assert.equal(projectDeliveryReadiness(events, runId), "not_requested");
});

test("M11-10-READY-07: ambiguous — conflicting durable facts fail closed", () => {
  const runId = "run_am";
  const ref = makeRef(runId);
  // multiple created
  assert.equal(projectDeliveryReadiness([
    { type: "run.delivery_created", runId, delivery: ref },
    { type: "run.delivery_created", runId, delivery: ref },
  ], runId), "ambiguous");
  // multiple verification
  assert.equal(projectDeliveryReadiness([
    { type: "run.delivery_created", runId, delivery: ref },
    { type: "run.delivery_verification_passed", runId, delivery: ref },
    { type: "run.delivery_verification_failed", runId, delivery: ref },
  ], runId), "ambiguous");
  // commit mismatch between created and verification
  const other = makeRef(runId, { deliveryCommit: "e".repeat(40), verification: { status: "passed" } });
  assert.equal(projectDeliveryReadiness([
    { type: "run.delivery_created", runId, delivery: ref },
    { type: "run.delivery_verification_passed", runId, delivery: other },
  ], runId), "ambiguous");
  // cross-run ref: event bound to runId but DeliveryRef.runId differs
  const crossRef = makeRef("run_IMPOSTOR");
  assert.equal(projectDeliveryReadiness([
    { type: "run.delivery_created", runId, delivery: crossRef },
    { type: "run.delivery_verification_passed", runId, delivery: crossRef },
  ], runId), "ambiguous");
  // created + failed is conflicting
  assert.equal(projectDeliveryReadiness([
    { type: "run.delivery_created", runId, delivery: ref },
    { type: "run.delivery_failed", runId, deliveryCode: "base_commit_mismatch" },
  ], runId), "ambiguous");
});

test("M11-10-READY-08: cross-run envelope events are ignored (runId-bound)", () => {
  // A delivery_created for a DIFFERENT runId must not affect this still-running
  // run's readiness. Keeping the target non-terminal makes this test fail if
  // foreign envelope filtering regresses.
  const runId = "run_self";
  const other = "run_other";
  assert.equal(projectDeliveryReadiness([
    startedWithDelivery(runId),
    { type: "run.delivery_created", runId: other, delivery: makeRef(other) },
    { type: "run.delivery_verification_passed", runId: other, delivery: makeRef(other) },
  ], runId), "waiting_for_packaging");
});

// --- M11-10 micro-closeout: fail-closed edge cases (causal RED → GREEN) ---

test("M11-10-READY-09 (issue 1): verification outcome bound to this runId but NO bound delivery_created → ambiguous", () => {
  const runId = "run_orphan_v";
  const ref = makeRef(runId);
  // (a) delivery-mode run.started present: the orphan verification must NOT be
  // masked as waiting_for_packaging (the old fall-through did exactly that).
  assert.equal(projectDeliveryReadiness([
    startedWithDelivery(runId),
    { type: "run.delivery_verification_passed", runId, delivery: ref },
    ...terminal(runId),
  ], runId), "ambiguous");
  // (b) plain (non-delivery) run.started: the orphan verification must NOT be
  // masked as not_requested either.
  assert.equal(projectDeliveryReadiness([
    startedPlain(runId),
    { type: "run.delivery_verification_passed", runId, delivery: ref },
    ...terminal(runId),
  ], runId), "ambiguous");
});

test("M11-10-READY-10 (issue 2): foreign-run run.started must not project this run as waiting", () => {
  const runId = "run_self";
  // This run started plain (no delivery intent); a DIFFERENT run's run.started
  // carries a delivery mode. deliveryRequested must be runId-bound, so the
  // foreign intent cannot flip this run to waiting_for_packaging.
  assert.equal(projectDeliveryReadiness([
    startedPlain(runId),
    { type: "run.started", runId: "run_FOREIGN", delivery: { mode: "git_commit_v1" } },
    ...terminal(runId),
  ], runId), "not_requested");
  // And a transcript with ONLY the foreign delivery start (no self start) is
  // also not_requested for this runId, never waiting_for_packaging.
  assert.equal(projectDeliveryReadiness([
    { type: "run.started", runId: "run_FOREIGN", delivery: { mode: "git_commit_v1" } },
    ...terminal(runId),
  ], runId), "not_requested");
});

test("M11-10-READY-11 (issue 3): multiple bound run.delivery_failed are conflicting → ambiguous; single → packaging_failed", () => {
  const runId = "run_pf_multi";
  // Regression guard: a single bound failure is still packaging_failed.
  assert.equal(projectDeliveryReadiness([
    startedWithDelivery(runId),
    { type: "run.delivery_failed", runId, deliveryCode: "base_commit_mismatch" },
    ...terminal(runId),
  ], runId), "packaging_failed");
  // Two bound failures are conflicting durable facts → ambiguous (fail closed).
  assert.equal(projectDeliveryReadiness([
    startedWithDelivery(runId),
    { type: "run.delivery_failed", runId, deliveryCode: "base_commit_mismatch" },
    { type: "run.delivery_failed", runId, deliveryCode: "worktree_dirty" },
    ...terminal(runId),
  ], runId), "ambiguous");
});

// --- M11-12A P1: malformed commit literal on a BOUND created/verification ref ---

test("M11-10-READY-12 (M11-12A P1): bound created ref with a malformed commit literal → ambiguous, never waiting_for_verification", () => {
  // Causal root-cause guard. A bound delivery_created (DeliveryRef.runId ===
  // envelope runId, so NOT a cross-run ref) whose baseCommit/deliveryCommit is
  // non-canonical must fail closed to ambiguous — it must NEVER reach
  // waiting_for_verification, which would surface a verification_pending review
  // result with nulls. The canonical check reuses isCanonicalCommitId via
  // _deliveryRefIsUsable (the SSOT _reconstructDelivery already uses); no second
  // regex. (RED on frozen main: _hasConflictDelivery used the weaker
  // _deliveryRefIsBound → these projected waiting_for_verification.)
  const runId = "run_mal_commit";
  const cases = [
    { label: "deliveryCommit=HEAD",       over: { deliveryCommit: "HEAD" } },
    { label: "deliveryCommit short SHA",  over: { deliveryCommit: "d".repeat(7) } },
    { label: "deliveryCommit uppercase",  over: { deliveryCommit: "D".repeat(40) } },
    { label: "deliveryCommit non-hex",    over: { deliveryCommit: "z".repeat(40) } },
    { label: "deliveryCommit missing",    over: { deliveryCommit: undefined } },
    { label: "baseCommit=HEAD",           over: { baseCommit: "HEAD" } },
    { label: "baseCommit missing",        over: { baseCommit: undefined } },
    { label: "baseCommit non-hex",        over: { baseCommit: "g".repeat(40) } },
  ];
  for (const c of cases) {
    const ref = makeRef(runId, c.over);
    const got = projectDeliveryReadiness([
      startedWithDelivery(runId),
      { type: "run.delivery_created", runId, delivery: ref },
      ...terminal(runId),
    ], runId);
    assert.equal(got, "ambiguous", `${c.label}: malformed commit must fail closed to ambiguous`);
  }
  // Boundary contrast: a CANONICAL created ref with no verification stays the
  // legitimate transient pending state. There is NO terminal-state guard before
  // waiting_for_verification (terminal+created+no verification is pending, not
  // ambiguous) — the fix touches only commit-canonicality, not this path.
  assert.equal(
    projectDeliveryReadiness([
      startedWithDelivery(runId),
      { type: "run.delivery_created", runId, delivery: makeRef(runId) },
      ...terminal(runId),
    ], runId),
    "waiting_for_verification",
    "canonical created ref (no verification) stays waiting_for_verification",
  );
});

// =====================================================================
// Group 2: getRunDeliveryReadiness wait service
// =====================================================================

test("M11-10-SVC-01 (RED→GREEN): terminal + delivery_created, verification appended during wait → reviewable early", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "m1110-svc-01-"));
  try {
    const runId = "run_svc01";
    const ref = makeRef(runId);
    const tp = writeTranscript(runDir, runId, [
      startedWithDelivery(runId),
      { type: "run.delivery_created", runId, delivery: ref },
      ...terminal(runId),
      // NO verification yet → waiting_for_verification
    ]);
    const before = readFileSync(tp, "utf8");

    let appended = false;
    let sleepCalls = 0;
    // Deterministic fake clock: advances slowly so the 5000ms deadline is far away.
    let t = 1_000_000;
    const nowFn = () => (t += 5);
    const sleepFn = async () => {
      sleepCalls += 1;
      if (!appended) {
        appended = true;
        appendEvent(tp, { type: "run.delivery_verification_passed", runId, delivery: ref });
      }
    };
    const result = await getRunDeliveryReadiness({
      runId, runDir, waitMs: 5000, sleepFn, nowFn, pollIntervalMs: 50,
    });
    // GREEN: verification landed → reviewable, returned before the deadline.
    assert.equal(result.readiness, "reviewable");
    assert.equal(result.waitReturnedEarly, true);
    assert.equal(result.deliveryAvailable, true);
    assert.ok(result.deliveryRef, "deliveryRef present for reviewable");
    assert.ok(sleepCalls >= 1, "non-busy: at least one sleep before the settling re-read");
    // Zero transcript append BY THE SERVICE: only the test's explicit append changed the file.
    // The service must not have appended anything; the only new line is the verification we added.
    const after = readFileSync(tp, "utf8");
    assert.ok(after.length > before.length, "test appended verification");
    assert.ok(after.includes("run.delivery_verification_passed"), "verification present");
    // No spurious events: count lines increased by exactly 1.
    assert.equal(after.split("\n").filter(Boolean).length, before.split("\n").filter(Boolean).length + 1);
  } finally { cleanupDir(runDir); }
});

test("M11-10-SVC-02: deadline expired while still pending is NOT an error (truthful fact)", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "m1110-svc-02-"));
  try {
    const runId = "run_svc02";
    const tp = writeTranscript(runDir, runId, [
      startedWithDelivery(runId),
      { type: "run.delivery_created", runId, delivery: makeRef(runId) },
      ...terminal(runId),
    ]);
    const before = readFileSync(tp, "utf8");
    // Sleep-coupled clock: time advances only during sleep (like a real clock).
    // Each sleep jumps past waitMs, so exactly one poll runs before the deadline.
    let t = 1_000_000;
    let sleepCalls = 0;
    const nowFn = () => t;
    const sleepFn = async () => { sleepCalls += 1; t += 6000; };
    const result = await getRunDeliveryReadiness({
      runId, runDir, waitMs: 5000,
      sleepFn, nowFn, pollIntervalMs: 50,
    });
    assert.equal(result.readiness, "waiting_for_verification", "still pending is the truthful fact");
    assert.equal(result.waitReturnedEarly, false, "did not return early");
    // NOT an error: the call resolved with a structured fact.
    assert.equal(readFileSync(tp, "utf8"), before, "zero transcript append");
    assert.ok(sleepCalls >= 1);
  } finally { cleanupDir(runDir); }
});

test("M11-10-SVC-03: non-waiting readiness returns immediately (no polling)", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "m1110-svc-03-"));
  try {
    const ref = makeRef("run_svc03");
    writeTranscript(runDir, "run_svc03", [
      startedWithDelivery("run_svc03"),
      { type: "run.delivery_created", runId: "run_svc03", delivery: ref },
      { type: "run.delivery_verification_passed", runId: "run_svc03", delivery: ref },
      ...terminal("run_svc03"),
    ]);
    let sleepCalls = 0;
    const r = await getRunDeliveryReadiness({
      runId: "run_svc03", runDir, waitMs: 5000,
      sleepFn: async () => { sleepCalls += 1; }, nowFn: () => 1_000_000,
    });
    assert.equal(r.readiness, "reviewable");
    assert.equal(r.waitReturnedEarly, true);
    assert.equal(sleepCalls, 0, "no polling when already settled");
  } finally { cleanupDir(runDir); }
});

test("M11-10-SVC-04: packaging_failed / not_requested / ambiguous return early, no error", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "m1110-svc-04-"));
  try {
    // packaging_failed
    writeTranscript(runDir, "run_pf", [
      startedWithDelivery("run_pf"),
      { type: "run.delivery_failed", runId: "run_pf", deliveryCode: "base_commit_mismatch" },
      ...terminal("run_pf"),
    ]);
    const pf = await getRunDeliveryReadiness({ runId: "run_pf", runDir, waitMs: 1000, sleepFn: async () => {}, nowFn: () => 1 });
    assert.equal(pf.readiness, "packaging_failed");
    assert.equal(pf.waitReturnedEarly, true);
    assert.equal(pf.deliveryAvailable, false);
    assert.ok(pf.deliveryFailure, "packaging_failed carries deliveryFailure");

    // not_requested
    writeTranscript(runDir, "run_nr", [startedPlain("run_nr"), ...terminal("run_nr")]);
    const nr = await getRunDeliveryReadiness({ runId: "run_nr", runDir, waitMs: 1000, sleepFn: async () => {}, nowFn: () => 1 });
    assert.equal(nr.readiness, "not_requested");
    assert.equal(nr.waitReturnedEarly, true);
    assert.equal(nr.deliveryAvailable, false);
    assert.equal(nr.deliveryFailure, null, "not_requested has no failure code");

    // ambiguous (multiple verification)
    const ref = makeRef("run_am");
    writeTranscript(runDir, "run_am", [
      { type: "run.delivery_created", runId: "run_am", delivery: ref },
      { type: "run.delivery_verification_passed", runId: "run_am", delivery: ref },
      { type: "run.delivery_verification_failed", runId: "run_am", delivery: ref },
    ]);
    const am = await getRunDeliveryReadiness({ runId: "run_am", runDir, waitMs: 1000, sleepFn: async () => {}, nowFn: () => 1 });
    assert.equal(am.readiness, "ambiguous");
    assert.equal(am.waitReturnedEarly, true);
  } finally { cleanupDir(runDir); }
});

test("M11-10-SVC-05: wait is workspace/runId-bound — mismatched workspace throws before polling", async () => {
  const repoA = mkdtempSync(join(tmpdir(), "m1110-svc-05a-"));
  const repoB = mkdtempSync(join(tmpdir(), "m1110-svc-05b-"));
  const runDir = mkdtempSync(join(tmpdir(), "m1110-svc-05-rd-"));
  try {
    makeGitRepo(repoA);
    makeGitRepo(repoB);
    const runId = "run_svc05";
    writeTranscript(runDir, runId, [
      startedWithDelivery(runId),
      { type: "run.background_submitted", runId, background: true, cwd: repoA },
      { type: "run.delivery_created", runId, delivery: makeRef(runId) },
      ...terminal(runId),
    ]);
    // mismatched authorized root → throws (workspace-bound)
    await assert.rejects(
      () => getRunDeliveryReadiness({
        runId, runDir, waitMs: 1000, authorizedWorkspaceRoot: repoB,
        sleepFn: async () => {}, nowFn: () => 1,
      }),
      /workspace|mismatch|ownership/i,
    );
    // matching authorized root → resolves (still pending, returns fact)
    const r = await getRunDeliveryReadiness({
      runId, runDir, waitMs: 1000, authorizedWorkspaceRoot: repoA,
      sleepFn: async () => {}, nowFn: (() => { let t = 1; return () => (t += 6000); })(),
    });
    assert.equal(r.readiness, "waiting_for_verification");
  } finally { cleanupDir(repoA); cleanupDir(repoB); cleanupDir(runDir); }
});

test("M11-10-SVC-06: invalid runId / waitMs rejected at the shared business boundary", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "m1110-svc-06-"));
  try {
    for (const bad of ["../escape", "run&injected", "run/path", ""]) {
      await assert.rejects(() => getRunDeliveryReadiness({ runId: bad, runDir, waitMs: 1000 }));
    }
    for (const badMs of [undefined, 999, 300001, 5000.5, "5000", null]) {
      await assert.rejects(() => getRunDeliveryReadiness({ runId: "run_ok", runDir, waitMs: badMs }));
    }
    // bounds are inclusive
    const ref = makeRef("run_bounds");
    writeTranscript(runDir, "run_bounds", [
      { type: "run.delivery_created", runId: "run_bounds", delivery: ref },
      { type: "run.delivery_verification_passed", runId: "run_bounds", delivery: ref },
    ]);
    for (const okMs of [DELIVERY_WAIT_MS_MIN, DELIVERY_WAIT_MS_MAX]) {
      const r = await getRunDeliveryReadiness({ runId: "run_bounds", runDir, waitMs: okMs, sleepFn: async () => {}, nowFn: () => 1 });
      assert.equal(r.readiness, "reviewable", `waitMs ${okMs} accepted`);
    }
  } finally { cleanupDir(runDir); }
});

test("M11-10-SVC-07: zero transcript append across a real multi-poll wait", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "m1110-svc-07-"));
  try {
    const runId = "run_svc07";
    const tp = writeTranscript(runDir, runId, [
      startedWithDelivery(runId),
      { type: "run.delivery_created", runId, delivery: makeRef(runId) },
      ...terminal(runId),
    ]);
    const sizeBefore = statSync(tp).size;
    let t = 1_000_000;
    await getRunDeliveryReadiness({
      runId, runDir, waitMs: 5000,
      sleepFn: async () => {}, nowFn: () => (t += 2000), pollIntervalMs: 50,
    });
    assert.equal(statSync(tp).size, sizeBefore, "transcript bytes unchanged by the wait");
  } finally { cleanupDir(runDir); }
});

test("M11-10-SVC-08: non-busy polling — sleeps between reads, no tight spin", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "m1110-svc-08-"));
  try {
    const runId = "run_svc08";
    writeTranscript(runDir, runId, [
      startedWithDelivery(runId),
      { type: "run.delivery_created", runId, delivery: makeRef(runId) },
      ...terminal(runId),
    ]);
    let reads = 0;
    let t = 1_000_000;
    const readTranscriptFn = async (fp) => { reads += 1; return (await import("../src/transcript.js")).readTranscript(fp); };
    const sleepCalls = [];
    // Sleep-coupled clock: each sleep advances time by ~ms, so multiple polls
    // run before the deadline (proving non-busy repeated polling).
    const nowFn = () => t;
    await getRunDeliveryReadiness({
      runId, runDir, waitMs: 5000,
      sleepFn: async (ms) => { sleepCalls.push(ms); t += ms + 1; },
      nowFn, pollIntervalMs: 700,
      readTranscriptFn,
    });
    assert.ok(sleepCalls.length >= 2, "polled multiple times with sleeps between");
    assert.ok(sleepCalls.every((ms) => ms > 0), "every sleep is positive (non-busy)");
    // Each poll after the initial read must be preceded by a sleep.
    assert.ok(reads >= sleepCalls.length + 1, "initial read + one read per poll");
  } finally { cleanupDir(runDir); }
});

test("M11-10-SVC-09: point-in-time getRunDelivery shape unchanged (backward compat)", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "m1110-svc-09-"));
  try {
    const runId = "run_svc09";
    const ref = makeRef(runId);
    writeTranscript(runDir, runId, [
      startedWithDelivery(runId),
      { type: "run.delivery_created", runId, delivery: ref },
      { type: "run.delivery_verification_passed", runId, delivery: ref },
      ...terminal(runId),
    ]);
    const view = await getRunDelivery({ runId, runDir });
    assert.equal(view.deliveryAvailable, true);
    assert.equal(view.deliveryRequested, true);
    // M12-6 3B2a: ADDITIVE original/effective/reverify projection — the OLD
    // fields are untouched; effectiveVerification + reverify are new keys.
    assert.deepEqual(
      Object.keys(view).sort(),
      [
        "acceptance", "deliveryAvailable", "deliveryRef", "deliveryRequested", "runId",
        "terminalState", "verification", "effectiveVerification", "reverify",
      ].sort(),
    );
    // Zero-drift truth: a plain chain with NO reverify events → effective ===
    // the original status as carried by the ref (makeRef's verification.status
    // is "pending") and a clean "none" reverify projection.
    assert.deepEqual(view.verification, { status: "pending" });
    assert.deepEqual(view.effectiveVerification, { status: "pending" });
    assert.deepEqual(view.reverify, { status: "none" });
  } finally { cleanupDir(runDir); }
});

test("M11-10-SVC-10 (issue 4): initial read ok but a later re-read throws → ambiguous early, not a disguised deadline expiry", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "m1110-svc-10-"));
  try {
    const runId = "run_svc10";
    const tp = writeTranscript(runDir, runId, [
      startedWithDelivery(runId),
      { type: "run.delivery_created", runId, delivery: makeRef(runId) },
      ...terminal(runId),
      // NO verification → waiting_for_verification, so the wait enters the poll loop
    ]);
    const before = readFileSync(tp, "utf8");
    let readCount = 0;
    const readTranscriptFn = async (fp) => {
      readCount += 1;
      if (readCount === 1) {
        // initial read succeeds → projects waiting_for_verification
        const { readTranscript } = await import("../src/transcript.js");
        return readTranscript(fp);
      }
      // every subsequent re-read fails (simulated IO/corruption mid-wait)
      throw new Error("simulated transcript re-read failure");
    };
    // Deterministic clock with a far-away deadline, so the ONLY reason polling
    // stops is the re-read failure — not time expiring.
    let t = 1_000_000;
    const result = await getRunDeliveryReadiness({
      runId, runDir, waitMs: 5000,
      sleepFn: async () => { t += 100; },
      nowFn: () => t,
      pollIntervalMs: 50,
      readTranscriptFn,
    });
    // Fail-closed to the EXISTING ambiguous closed-set value — not a new state,
    // not an echoed error, and NOT the stale waiting snapshot (the old
    // break-then-deadline path returned readiness:"waiting_for_verification",
    // waitReturnedEarly:false, disguising the read failure as a normal expiry).
    assert.equal(result.readiness, "ambiguous");
    assert.equal(result.waitReturnedEarly, true, "returned early; not disguised as a deadline expiry");
    assert.ok(readCount >= 2, "initial successful read + at least one failed re-read");
    assert.equal(readFileSync(tp, "utf8"), before, "zero transcript append on read failure");
  } finally { cleanupDir(runDir); }
});

test("M11-10-SVC-11 (M12-14 poll closeout): a foreign transcript replacement between polls re-proves ownership — it cannot return readiness facts", async () => {
  // Causal: the initial read binds ownership to the requested run (cwd=repoA)
  // and projects waiting_for_verification, so the wait enters the poll loop
  // AUTHORIZED. A replacement snapshot for the SAME runId from a DIFFERENT
  // workspace (cwd=repoB) carrying a complete reviewable chain must NOT inherit
  // that authorization: every successful poll re-read must re-prove ownership
  // and fail closed with the SAME authorization error as the initial read —
  // never return the foreign readiness/delivery facts. (RED on the candidate:
  // the re-read drove readiness=reviewable and echoed the foreign deliveryRef.)
  const repoA = mkdtempSync(join(tmpdir(), "m1110-svc-11a-"));
  const repoB = mkdtempSync(join(tmpdir(), "m1110-svc-11b-"));
  const runDir = mkdtempSync(join(tmpdir(), "m1110-svc-11-rd-"));
  try {
    makeGitRepo(repoA);
    makeGitRepo(repoB);
    const runId = "run_svc11";
    const ref = makeRef(runId);
    // Initial snapshot: valid ownership (cwd=repoA) + created, NO verification →
    // waiting_for_verification (a waiting state, so the poll loop runs).
    const initialEvents = [
      startedWithDelivery(runId),
      { type: "run.background_submitted", runId, background: true, cwd: repoA },
      { type: "run.delivery_created", runId, delivery: ref },
      ...terminal(runId),
    ];
    // Replacement snapshot: SAME runId, DIFFERENT workspace, complete chain →
    // would project reviewable for the requested runId if not re-authorized.
    const foreignRef = makeRef(runId, {
      deliveryCommit: "f".repeat(40),
      changedFiles: ["SECRET/foreign.js"],
    });
    const replacementEvents = [
      startedWithDelivery(runId),
      { type: "run.background_submitted", runId, background: true, cwd: repoB },
      { type: "run.delivery_created", runId, delivery: foreignRef },
      { type: "run.delivery_verification_passed", runId, delivery: foreignRef },
      ...terminal(runId),
    ];
    let reads = 0;
    let rejection = null;
    try {
      await getRunDeliveryReadiness({
        runId, runDir, waitMs: 1000,
        authorizedWorkspaceRoot: repoA,
        // Constant clock: the deadline is far away, so only the re-read's
        // authorization failure stops the poll (never time expiry).
        sleepFn: async () => {},
        nowFn: () => 1000000,
        pollIntervalMs: 50,
        readTranscriptFn: async () => {
          reads += 1;
          return reads === 1 ? initialEvents : replacementEvents;
        },
      });
    } catch (err) { rejection = err; }
    assert.ok(rejection, "foreign replacement must fail closed, not return readiness facts");
    assert.match(rejection.message, /workspace mismatch|missing ownership|unprovable/i,
      "same fail-closed authorization error family as the initial read");
    assert.ok(!rejection.message.includes(repoB), "no foreign path echoed");
    assert.ok(reads >= 2, "initial read + at least one re-read (the replacement snapshot)");
  } finally { cleanupDir(repoA); cleanupDir(repoB); cleanupDir(runDir); }
});

// =====================================================================
// Group 3: MCP run_delivery waitMs (real Client + InMemoryTransport)
// =====================================================================

test("M11-10-MCP-01: input schema — waitMs optional, shared-constant-locked bounds; extra args rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m1110-mcp-01-"));
  try {
    makeGitRepo(dir);
    let calls = 0;
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      getRunDeliveryReadinessFn: async (i) => { calls += 1; return { runId: i.runId, readiness: "reviewable", waitReturnedEarly: true, terminalState: "completed", deliveryAvailable: true, deliveryRef: makeRef(i.runId), deliveryFailure: null, verification: { status: "passed" }, acceptance: { status: "pending" } }; },
    });
    const client = await buildClient(server);
    try {
      // valid waitMs bounds accepted
      for (const w of [DELIVERY_WAIT_MS_MIN, 5000, DELIVERY_WAIT_MS_MAX]) {
        calls = 0;
        const res = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x", waitMs: w } });
        assert.equal(res.isError, undefined, `waitMs ${w} accepted`);
        assert.equal(calls, 1, `service called for waitMs ${w}`);
      }
      // below min / above max / non-integer rejected before service (a throw OR
      // an isError result both count as rejected — matches M9-6B-03's pattern).
      for (const bad of [DELIVERY_WAIT_MS_MIN - 1, DELIVERY_WAIT_MS_MAX + 1, 5000.5, "5000"]) {
        calls = 0;
        let rejected = false;
        let res = null;
        try { res = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x", waitMs: bad } }); }
        catch { rejected = true; }
        if (!rejected && res?.isError) rejected = true;
        assert.ok(rejected, `waitMs ${bad} rejected`);
        assert.equal(calls, 0, `service NOT called for waitMs ${bad}`);
      }
      // extra arg rejected
      calls = 0;
      let rejected = false;
      let res = null;
      try { res = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x", waitMs: 5000, evil: 1 } }); }
      catch { rejected = true; }
      if (!rejected && res?.isError) rejected = true;
      assert.ok(rejected, "extra arg rejected");
      assert.equal(calls, 0);
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

test("M11-10-MCP-02: output schema — readiness/waitReturnedEarly present iff waitMs provided; safe projection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m1110-mcp-02-"));
  try {
    makeGitRepo(dir);
    // WAIT path: structured output includes readiness + waitReturnedEarly + safe delivery fields.
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      getRunDeliveryReadinessFn: async (i) => ({
        runId: i.runId, readiness: "reviewable", waitReturnedEarly: true, terminalState: "completed",
        deliveryAvailable: true, deliveryRef: makeRef(i.runId), deliveryFailure: null,
        verification: { status: "passed" }, acceptance: { status: "pending" },
      }),
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x", waitMs: 5000 } });
      assert.equal(res.isError, undefined);
      const parsed = res.structuredContent;
      assert.equal(parsed.readiness, "reviewable");
      assert.equal(parsed.waitReturnedEarly, true);
      assert.equal(parsed.deliveryAvailable, true);
      assert.equal(parsed.verificationStatus, "passed");
      // No raw DeliveryRef internals leak.
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes("worktreePath"), "no worktreePath leak");
    } finally { await client.close(); await server.close(); }

    // POINT-IN-TIME path (no waitMs): exact OLD field set, no readiness/waitReturnedEarly.
    const server2 = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      getRunDeliveryFn: async () => ({
        runId: "run_x", terminalState: "completed",
        deliveryRef: makeRef("run_x"), verification: { status: "passed" }, acceptance: { status: "pending" },
      }),
    });
    const client2 = await buildClient(server2);
    try {
      const res = await client2.callTool({ name: "run_delivery", arguments: { runId: "run_x" } });
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      const expectedKeys = new Set([
        "runId", "deliveryAvailable", "deliveryRequested", "terminalState", "baseCommit", "deliveryCommit",
        "changedFileCount", "changedPaths", "changedPathsTruncated",
        "verificationStatus", "verificationFailureCode", "verificationFailureSummary",
        "originalVerificationStatus", "effectiveVerificationStatus", "reverify",
        "acceptanceStatus", "decisionType", "deliveryFailure", "candidateInventory", "candidateKind",
        "availableDrilldowns", "semanticNotes", "isolationFailure",
      ]);
      assert.deepEqual(new Set(Object.keys(parsed)), expectedKeys, "point-in-time field set (M11-12B adds nullable verificationFailureSummary; M12-1S1/M12-4A add nullable candidateInventory + candidateKind; M12-6 3B2a adds additive originalVerificationStatus/effectiveVerificationStatus/reverify; M12-8B adds availableDrilldowns; M12-12 adds semanticNotes; M12-13 adds nullable isolationFailure)");
      assert.equal("readiness" in parsed, false, "no readiness in point-in-time output");
      assert.equal("waitReturnedEarly" in parsed, false, "no waitReturnedEarly in point-in-time output");
      // Additive projection with no reverify chain: effective === original,
      // reverify { status: "none", reason: null }.
      assert.equal(parsed.originalVerificationStatus, "passed");
      assert.equal(parsed.effectiveVerificationStatus, "passed");
      assert.deepEqual(parsed.reverify, { status: "none", reason: null });
    } finally { await client2.close(); await server2.close(); }
  } finally { cleanupDir(dir); }
});

test("M11-10-MCP-03: wait path maps every readiness state to a truthful, non-error output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m1110-mcp-03-"));
  try {
    makeGitRepo(dir);
    const cases = [
      { readiness: "reviewable", deliveryAvailable: true, deliveryRef: makeRef("r"), verification: { status: "passed" }, acceptance: { status: "pending" }, deliveryFailure: null },
      { readiness: "waiting_for_verification", deliveryAvailable: true, deliveryRef: makeRef("r"), verification: { status: "pending" }, acceptance: { status: "pending" }, deliveryFailure: null },
      { readiness: "waiting_for_packaging", deliveryAvailable: false, deliveryRef: null, verification: null, acceptance: null, deliveryFailure: null },
      { readiness: "packaging_failed", deliveryAvailable: false, deliveryRef: null, verification: null, acceptance: null, deliveryFailure: { code: "base_commit_mismatch" } },
      { readiness: "not_requested", deliveryAvailable: false, deliveryRef: null, verification: null, acceptance: null, deliveryFailure: null },
      { readiness: "ambiguous", deliveryAvailable: false, deliveryRef: null, verification: null, acceptance: null, deliveryFailure: null },
    ];
    for (const c of cases) {
      const server = createWaoMcpServer({
        registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
        getRunDeliveryReadinessFn: async (i) => ({ runId: i.runId, terminalState: "completed", waitReturnedEarly: true, ...c, deliveryRef: c.deliveryRef ? { ...c.deliveryRef, runId: i.runId } : null }),
      });
      const client = await buildClient(server);
      try {
        const res = await client.callTool({ name: "run_delivery", arguments: { runId: "r", waitMs: 2000 } });
        assert.equal(res.isError, undefined, `${c.readiness}: not an error`);
        assert.equal(res.structuredContent.readiness, c.readiness);
        assert.equal(res.structuredContent.waitReturnedEarly, true);
        assert.equal(res.structuredContent.deliveryAvailable, c.deliveryAvailable);
        if (c.deliveryFailure) assert.equal(res.structuredContent.deliveryFailure.code, "base_commit_mismatch");
        if (c.readiness === "not_requested" || c.readiness === "ambiguous") {
          assert.equal(res.structuredContent.deliveryFailure, null, `${c.readiness}: no failure code`);
        }
      } finally { await client.close(); await server.close(); }
    }
  } finally { cleanupDir(dir); }
});

test("M11-10-MCP-06: wait path exposes additive original/effective/reverify; reverify object validates strictly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m1110-mcp-06-"));
  try {
    makeGitRepo(dir);
    // (a) complete reverify chain: original failed, effective passed — both visible.
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      getRunDeliveryReadinessFn: async (i) => ({
        runId: i.runId, readiness: "reviewable", waitReturnedEarly: true, terminalState: "completed",
        deliveryAvailable: true, deliveryRef: makeRef(i.runId), deliveryFailure: null,
        verification: { status: "failed", failureCode: "command_failed" },
        effectiveVerification: { status: "passed" },
        reverify: { status: "complete", reason: "tooling_invalid" },
        acceptance: { status: "pending" },
      }),
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x", waitMs: 2000 } });
      assert.equal(res.isError, undefined);
      const p = res.structuredContent;
      assert.equal(p.verificationStatus, "failed", "old field keeps original truth");
      assert.equal(p.originalVerificationStatus, "failed");
      assert.equal(p.effectiveVerificationStatus, "passed");
      assert.deepEqual(p.reverify, { status: "complete", reason: "tooling_invalid" });
    } finally { await client.close(); await server.close(); }

    // (b) malformed chain from the service view → reverify malformed, effective
    // must fall back to original; a service claiming otherwise collapses to error.
    for (const [view, expectError] of [
      [{
        runId: "run_x", readiness: "reviewable", waitReturnedEarly: true, terminalState: "completed",
        deliveryAvailable: true, deliveryRef: makeRef("run_x"), deliveryFailure: null,
        verification: { status: "failed", failureCode: "command_failed" },
        effectiveVerification: { status: "failed" },
        reverify: { status: "malformed", reason: null },
        acceptance: { status: "pending" },
      }, false],
      [{
        runId: "run_x", readiness: "reviewable", waitReturnedEarly: true, terminalState: "completed",
        deliveryAvailable: true, deliveryRef: makeRef("run_x"), deliveryFailure: null,
        verification: { status: "failed", failureCode: "command_failed" },
        effectiveVerification: { status: "passed" }, // violation: malformed chain claims pass
        reverify: { status: "malformed", reason: null },
        acceptance: { status: "pending" },
      }, true],
    ]) {
      const server2 = createWaoMcpServer({
        registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
        getRunDeliveryReadinessFn: async () => view,
      });
      const client2 = await buildClient(server2);
      try {
        const res = await client2.callTool({ name: "run_delivery", arguments: { runId: "run_x", waitMs: 2000 } });
        if (expectError) {
          assert.equal(res.isError, true, "inconsistent malformed/passed projection fails closed");
          assert.ok(!JSON.stringify(res).includes('"passed"'), "no fabricated pass leaks");
        } else {
          assert.equal(res.isError, undefined);
          const p = res.structuredContent;
          assert.equal(p.effectiveVerificationStatus, "failed");
          assert.deepEqual(p.reverify, { status: "malformed", reason: null });
        }
      } finally { await client2.close(); await server2.close(); }
    }
  } finally { cleanupDir(dir); }
});

test("M11-10-MCP-04: wait is workspace-bound — no binding → fixed error, service not called", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m1110-mcp-04-"));
  try {
    let calls = 0;
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, // NO workspaceRoot, NO roots capability
      getRunDeliveryReadinessFn: async () => { calls += 1; return { readiness: "reviewable" }; },
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x", waitMs: 2000 } });
      assert.equal(res.isError, true, "no binding → error");
      assert.equal(calls, 0, "service never called without workspace binding");
      const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
      assert.ok(/workspace|bound/i.test(text), "error mentions workspace not bound");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

test("M11-10-MCP-05 (KEEPALIVE): progress notifications fire when client requests progress; none when not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m1110-mcp-05-"));
  try {
    makeGitRepo(dir);
    const runId = "run_ka";
    // Seed a transcript that stays pending so the wait actually polls.
    const runDir = mkdtempSync(join(tmpdir(), "m1110-mcp-05-rd-"));
    writeTranscript(runDir, runId, [
      startedWithDelivery(runId),
      { type: "run.background_submitted", runId, background: true, cwd: dir },
      { type: "run.delivery_created", runId, delivery: makeRef(runId) },
      ...terminal(runId),
    ]);

    const wrapService = () => async (input) => {
      const { getRunDeliveryReadiness } = await import("../src/application/runDelivery.js");
      // Sleep-coupled clock: time advances only during sleep, so the wait
      // actually polls (and emits progress) before the bounded deadline.
      let t = Date.now();
      return getRunDeliveryReadiness({
        ...input,
        sleepFn: () => { t += 1000; return Promise.resolve(); },
        nowFn: () => t,
      });
    };

    // (a) client requests progress → onprogress fires.
    {
      const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir, getRunDeliveryReadinessFn: wrapService() });
      const client = await buildClient(server);
      try {
        let progressCb = 0;
        let rejected = false; let rejectErr = null;
        try {
          await client.callTool(
            { name: "run_delivery", arguments: { runId, waitMs: 5000 } },
            CompatibilityCallToolResultSchema,
            { timeout: 5000, resetTimeoutOnProgress: true, onprogress: () => { progressCb += 1; } },
          );
        } catch (e) { rejected = true; rejectErr = e; }
        assert.equal(rejected, false, `call must not reject; ${rejectErr?.message ?? ""}`);
        assert.ok(progressCb > 0, `onprogress must fire; got ${progressCb}`);
      } finally { await client.close(); await server.close(); }
    }
    // (b) no progressToken → server emits NO progress notifications.
    {
      const progressNotifications = [];
      const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir, getRunDeliveryReadinessFn: wrapService() });
      const [c1, s1] = InMemoryTransport.createLinkedPair();
      const origSend = s1.send.bind(s1);
      s1.send = async (msg, opts) => {
        try { const p = typeof msg === "string" ? JSON.parse(msg) : msg; if (p && p.method === "notifications/progress") progressNotifications.push(p); } catch {}
        return origSend(msg, opts);
      };
      await server.connect(s1);
      const client = new Client({ name: "t", version: "0" }, { version: "0" });
      await client.connect(c1);
      try {
        await client.callTool({ name: "run_delivery", arguments: { runId, waitMs: 5000 } });
      } finally { await client.close(); await server.close(); }
      assert.equal(progressNotifications.length, 0, "no progress notifications without a token");
    }
    cleanupDir(runDir);
  } finally { cleanupDir(dir); }
});

test("M11-10-MCP-06 (RED→GREEN real default service): delayed verification append → reviewable, bytes unchanged by service", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m1110-mcp-06-"));
  const runDir = mkdtempSync(join(tmpdir(), "m1110-mcp-06-rd-"));
  try {
    makeGitRepo(dir);
    const runId = "run_real";
    const ref = makeRef(runId);
    const tp = writeTranscript(runDir, runId, [
      startedWithDelivery(runId),
      { type: "run.background_submitted", runId, background: true, cwd: dir },
      { type: "run.delivery_created", runId, delivery: ref },
      ...terminal(runId),
    ]);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const linesBefore = readFileSync(tp, "utf8").split("\n").filter(Boolean).length;
      // Append the verification outcome shortly after the wait starts. The
      // default service polls every 1s; the append at 50ms lands before the
      // first poll re-reads, so the wait returns reviewable early.
      const timer = setTimeout(() => appendEvent(tp, { type: "run.delivery_verification_passed", runId, delivery: ref }), 50);
      try {
        const res = await client.callTool({ name: "run_delivery", arguments: { runId, waitMs: 3000 } });
        assert.equal(res.isError, undefined, "default-service wait resolves");
        assert.equal(res.structuredContent.readiness, "reviewable");
        assert.equal(res.structuredContent.waitReturnedEarly, true);
      } finally { clearTimeout(timer); }
      // The service appended nothing; the only new line is the verification the
      // test added (exactly +1). This is the zero-transcript-append proof over
      // the real default service + real disk.
      const linesAfter = readFileSync(tp, "utf8").split("\n").filter(Boolean).length;
      assert.equal(linesAfter, linesBefore + 1, "service appended nothing beyond the test's verification line");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); cleanupDir(runDir); }
});

test("M11-10-MCP-07: deadline-expired-while-pending returns a structured fact (NOT an error)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m1110-mcp-07-"));
  const runDir = mkdtempSync(join(tmpdir(), "m1110-mcp-07-rd-"));
  try {
    makeGitRepo(dir);
    const runId = "run_pend";
    writeTranscript(runDir, runId, [
      startedWithDelivery(runId),
      { type: "run.background_submitted", runId, background: true, cwd: dir },
      { type: "run.delivery_created", runId, delivery: makeRef(runId) },
      ...terminal(runId),
    ]);
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir, workspaceRoot: dir,
      getRunDeliveryReadinessFn: async (input) => {
        const { getRunDeliveryReadiness } = await import("../src/application/runDelivery.js");
        // Sleep-coupled clock: each sleep jumps past waitMs, so the deadline
        // expires after one poll while still pending.
        let t = Date.now();
        return getRunDeliveryReadiness({
          ...input,
          sleepFn: () => { t += 6000; return Promise.resolve(); },
          nowFn: () => t,
        });
      },
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_delivery", arguments: { runId, waitMs: 2000 } });
      assert.equal(res.isError, undefined, "pending-at-deadline is not an error");
      assert.equal(res.structuredContent.readiness, "waiting_for_verification");
      assert.equal(res.structuredContent.waitReturnedEarly, false);
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); cleanupDir(runDir); }
});

// =====================================================================
// Group 4: CLI parity (runs delivery <runId> --wait-ms N)
// =====================================================================

test("M11-10-CLI-01: `runs delivery <runId> --wait-ms N --format json` delegates to the shared service", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m1110-cli-01-"));
  try {
    const { runsDeliveryCommand } = await import("../src/commands/runs.js");
    let captured = null;
    let waitMsSeen = null;
    const fake = async (input) => {
      captured = input;
      waitMsSeen = input.waitMs;
      return {
        runId: input.runId, readiness: "reviewable", waitReturnedEarly: true,
        terminalState: "completed", deliveryAvailable: true,
        deliveryRef: makeRef(input.runId), deliveryFailure: null,
        verification: { status: "passed" }, acceptance: { status: "pending" },
      };
    };
    const lines = [];
    const orig = console.log;
    console.log = (...a) => { lines.push(a.map(String).join("\t")); };
    try {
      await runsDeliveryCommand(
        ["run_cli01", "--wait-ms", "2000", "--format", "json", "--run-dir", dir],
        { runDir: dir },
        { getRunDeliveryReadinessFn: fake },
      );
    } finally { console.log = orig; }
    assert.equal(captured.runId, "run_cli01");
    assert.equal(waitMsSeen, 2000);
    const parsed = JSON.parse(lines.join("\n"));
    assert.equal(parsed.readiness, "reviewable");
    assert.equal(parsed.waitReturnedEarly, true);
    assert.equal(parsed.terminalState, "completed");
  } finally { cleanupDir(dir); }
});

test("M11-10-CLI-02: without --wait-ms the query keeps the old shape (no readiness)", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "m1110-cli-02-"));
  try {
    const { runsDeliveryCommand } = await import("../src/commands/runs.js");
    const runId = "run_cli02";
    const ref = makeRef(runId);
    writeTranscript(runDir, runId, [
      startedWithDelivery(runId),
      { type: "run.delivery_created", runId, delivery: ref },
      { type: "run.delivery_verification_passed", runId, delivery: ref },
      ...terminal(runId),
    ]);
    const lines = [];
    const orig = console.log;
    console.log = (...a) => { lines.push(a.map(String).join(" ")); };
    try {
      await runsDeliveryCommand([runId, "--format", "json", "--run-dir", runDir], { runDir });
    } finally { console.log = orig; }
    const parsed = JSON.parse(lines.join("\n"));
    assert.equal(parsed.deliveryAvailable, true);
    assert.equal("readiness" in parsed, false, "no readiness without --wait-ms");
    assert.equal("waitReturnedEarly" in parsed, false);
  } finally { cleanupDir(runDir); }
});

test("M11-10-CLI-03: invalid --wait-ms is rejected before the service is called", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m1110-cli-03-"));
  try {
    const { runsDeliveryCommand } = await import("../src/commands/runs.js");
    let calls = 0;
    for (const bad of ["999", "300001", "abc"]) {
      calls = 0;
      const fake = async () => { calls += 1; return { readiness: "reviewable" }; };
      let threw = false;
      try {
        await runsDeliveryCommand(["run_x", "--wait-ms", bad, "--run-dir", dir], { runDir: dir }, { getRunDeliveryReadinessFn: fake });
      } catch { threw = true; }
      assert.ok(threw, `--wait-ms ${bad} rejected`);
      assert.equal(calls, 0, "service not called for invalid wait-ms");
    }
  } finally { cleanupDir(dir); }
});

// =====================================================================
// Group 5: shared constants lock the waitMs schema
// =====================================================================

test("M11-10-CONST-01: shared waitMs constants lock the schema bounds (1000..300000)", () => {
  assert.equal(DELIVERY_WAIT_MS_MIN, 1000);
  assert.equal(DELIVERY_WAIT_MS_MAX, 300000);
  // The MCP schema is built FROM these constants (see server.js); the behavioral
  // proof is M11-10-MCP-01 (MIN/MAX accepted, MIN-1/MAX+1 rejected).
});

// =====================================================================
// Group 6: M11-10 auditor-blocker closeout (real RED → GREEN)
//
// These tests are written BEFORE the fix and must FAIL on the candidate
// (proving the auditor blockers), then PASS after the GREEN fix. They use the
// REAL application service + real disk transcripts (not stubs) so the causal
// chain — transcript → reconstruction → readiness/view — is exercised end to
// end. Blockers covered:
//   1. projectDeliveryReadiness + validateDeliveryFacts used only
//      `createdCommit !== verificationCommit`; two undefined/null/empty/non-
//      canonical values compared equal and falsely validated as reviewable, with
//      deliveryAvailable:false (the inconsistent boundary).
//   2. _reconstructDelivery scanned created/verification/decision WITHOUT
//      binding by the requested runId, so a concatenated/corrupt transcript
//      leaked a foreign run's commit/changedPaths/acceptance into this run's
//      view (while readiness stayed correctly bound).
//   3. A bound run.delivery_created with a missing/non-object delivery payload
//      was silently filtered into a plain waiting_for_packaging instead of
//      ambiguous.
//   4. MCP-03 title claimed "every readiness state" but omitted
//      waiting_for_packaging; coverage leaned on stubs.
// =====================================================================

// --- Blocker 1: non-canonical commits must never validate as reviewable ---

test("M11-10-BLK1 (projection): created+verification commits both non-canonical → ambiguous (was false reviewable)", () => {
  const runId = "run_blk1";
  for (const bad of [undefined, null, "", "HEAD", "abc123", "g".repeat(40), "d".repeat(39), "D".repeat(40)]) {
    const ref = { ...makeRef(runId), deliveryCommit: bad };
    const events = [
      startedWithDelivery(runId),
      { type: "run.delivery_created", runId, delivery: ref },
      { type: "run.delivery_verification_passed", runId, delivery: ref },
      ...terminal(runId),
    ];
    assert.equal(
      projectDeliveryReadiness(events, runId),
      "ambiguous",
      `non-canonical deliveryCommit ${JSON.stringify(bad)} must not be reviewable`,
    );
  }
});

test("M11-10-BLK1-SVC (real service): non-canonical commits never yield reviewable + deliveryAvailable:false", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "m1110-blk1-svc-"));
  try {
    const runId = "run_blk1svc";
    const ref = { ...makeRef(runId), deliveryCommit: undefined };
    writeTranscript(runDir, runId, [
      startedWithDelivery(runId),
      { type: "run.delivery_created", runId, delivery: ref },
      { type: "run.delivery_verification_passed", runId, delivery: ref },
      ...terminal(runId),
    ]);
    // Sleep-coupled clock: each sleep jumps past waitMs so the bounded wait
    // terminates after one poll even when the readiness stays in a waiting state
    // (e.g. the pre-fix masquerade this test must catch).
    let t = 1_000_000;
    const r = await getRunDeliveryReadiness({
      runId, runDir, waitMs: 1000,
      sleepFn: async () => { t += 6000; },
      nowFn: () => t,
    });
    // Before the fix this was readiness:"reviewable" (undefined === undefined),
    // which is the auditor's reviewable + deliveryAvailable:false inconsistency.
    assert.equal(r.readiness, "ambiguous", "non-canonical commits collapse to ambiguous");
    assert.equal(r.deliveryAvailable, false, "ambiguous carries no available delivery");
    assert.equal(r.deliveryRef, null, "no raw ref echoed for ambiguous");
    // Executable invariant: reviewable ⇒ deliveryAvailable === true. Before the
    // fix this assertion failed (reviewable + false); after it the state is
    // ambiguous so it holds trivially, and the guard enforces it in general.
    assert.ok(
      !(r.readiness === "reviewable" && r.deliveryAvailable !== true),
      "reviewable must never coexist with deliveryAvailable:false",
    );
  } finally { cleanupDir(runDir); }
});

// --- Blocker 2: foreign-run events must not leak into this run's view ---

test("M11-10-BLK2-SVC (real service): foreign-run events in the transcript must not leak into this run's readiness view", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "m1110-blk2-svc-"));
  try {
    const self = "run_blk2self";
    const foreign = "run_blk2foreign";
    const selfRef = makeRef(self, { changedFiles: ["src/self.js"] });
    const foreignRef = makeRef(foreign, {
      deliveryCommit: "f".repeat(40),
      changedFiles: ["SECRET/foreign.js"],
    });
    writeTranscript(runDir, self, [
      startedWithDelivery(self),
      { type: "run.delivery_created", runId: self, delivery: selfRef },
      { type: "run.delivery_verification_passed", runId: self, delivery: selfRef },
      ...terminal(self),
      // Foreign-run events concatenated into the same transcript file. Their
      // envelope runId is a DIFFERENT run, so they must not contribute to THIS
      // run's reconstruction.
      { type: "run.delivery_created", runId: foreign, delivery: foreignRef },
      { type: "run.delivery_verification_passed", runId: foreign, delivery: foreignRef },
      { type: "run.delivery_accepted", runId: foreign, delivery: { ...foreignRef, acceptance: { status: "accepted" } } },
    ]);

    // Sleep-coupled clock: each sleep jumps past waitMs so the bounded wait
    // terminates after one poll regardless of the projected readiness.
    let t = 1_000_000;
    const r = await getRunDeliveryReadiness({
      runId: self, runDir, waitMs: 1000,
      sleepFn: async () => { t += 6000; },
      nowFn: () => t,
    });
    assert.equal(r.readiness, "reviewable", "self has its own bound reviewable facts");
    assert.equal(r.deliveryAvailable, true);
    // The view must reflect THIS run's delivery — never the foreign artifact.
    assert.equal(r.deliveryRef.deliveryCommit, selfRef.deliveryCommit, "self commit, not foreign");
    assert.equal(r.acceptance.status, "pending", "foreign accepted must not leak; self has no decision");
    assert.ok(!JSON.stringify(r).includes("SECRET/foreign.js"), "no foreign changedPath leak");

    // Point-in-time getRunDelivery shares the SAME reconstruction, so it must
    // also reject the foreign artifact.
    const view = await getRunDelivery({ runId: self, runDir });
    assert.equal(view.deliveryRef.deliveryCommit, selfRef.deliveryCommit);
    assert.equal(view.acceptance.status, "pending");
    assert.ok(!JSON.stringify(view).includes("SECRET/foreign.js"));
  } finally { cleanupDir(runDir); }
});

test("M11-10-BLK2b-SVC (real service): cross-run injection (bound envelope, foreign ref) → ambiguous view, no ref leak", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "m1110-blk2b-svc-"));
  try {
    const self = "run_blk2binj";
    // Envelope runId is bound to `self`, but the DeliveryRef.runId is an
    // impostor. This is an envelope/ref conflict, not a foreign-envelope event.
    const injected = makeRef("run_IMPOSTOR", { changedFiles: ["SECRET/injected.js"] });
    writeTranscript(runDir, self, [
      startedWithDelivery(self),
      { type: "run.delivery_created", runId: self, delivery: injected },
      { type: "run.delivery_verification_passed", runId: self, delivery: injected },
      ...terminal(self),
    ]);
    // Sleep-coupled clock: each sleep jumps past waitMs so the bounded wait
    // terminates after one poll regardless of the projected readiness.
    let t = 1_000_000;
    const r = await getRunDeliveryReadiness({
      runId: self, runDir, waitMs: 1000,
      sleepFn: async () => { t += 6000; },
      nowFn: () => t,
    });
    assert.equal(r.readiness, "ambiguous");
    assert.equal(r.deliveryAvailable, false);
    // Before the fix the readiness was ambiguous BUT the reconstructed view
    // still echoed the injected ref (commit/changedPaths). The truthful
    // reconstruction must fail closed — no raw ref, no path, no echo.
    assert.equal(r.deliveryRef, null, "injected ref must not leak into the view");
    assert.ok(!JSON.stringify(r).includes("SECRET/injected.js"));
    assert.ok(!JSON.stringify(r).includes("run_IMPOSTOR"));
  } finally { cleanupDir(runDir); }
});

// --- Blocker 3: malformed bound delivery_created must be ambiguous, not waiting ---

test("M11-10-BLK3 (projection): bound run.delivery_created with missing/non-object delivery → ambiguous (was waiting)", () => {
  const runId = "run_blk3";
  // (a) delivery field absent → previously filtered to waiting_for_packaging.
  assert.equal(projectDeliveryReadiness([
    startedWithDelivery(runId),
    { type: "run.delivery_created", runId },
    ...terminal(runId),
  ], runId), "ambiguous", "missing delivery payload");
  // (b) delivery: null → previously filtered to waiting_for_packaging.
  assert.equal(projectDeliveryReadiness([
    startedWithDelivery(runId),
    { type: "run.delivery_created", runId, delivery: null },
    ...terminal(runId),
  ], runId), "ambiguous", "null delivery payload");
  // (c) delivery: non-object → previously masked as waiting_for_verification.
  assert.equal(projectDeliveryReadiness([
    startedWithDelivery(runId),
    { type: "run.delivery_created", runId, delivery: "not-a-ref" },
    ...terminal(runId),
  ], runId), "ambiguous", "non-object delivery payload");
  // (d) a malformed bound verification event (missing delivery) is also ambiguous.
  assert.equal(projectDeliveryReadiness([
    startedWithDelivery(runId),
    { type: "run.delivery_created", runId, delivery: makeRef(runId) },
    { type: "run.delivery_verification_passed", runId },
    ...terminal(runId),
  ], runId), "ambiguous", "malformed bound verification event");
});

test("M11-10-BLK3-SVC (real service): this run's malformed delivery_created is ambiguous, not waiting_for_packaging", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "m1110-blk3-svc-"));
  try {
    const runId = "run_blk3svc";
    writeTranscript(runDir, runId, [
      startedWithDelivery(runId),
      { type: "run.delivery_created", runId, delivery: null },
      ...terminal(runId),
    ]);
    // Sleep-coupled clock: each sleep jumps past waitMs so the bounded wait
    // terminates after one poll even when the readiness stays in a waiting state
    // (e.g. the pre-fix masquerade this test must catch).
    let t = 1_000_000;
    const r = await getRunDeliveryReadiness({
      runId, runDir, waitMs: 1000,
      sleepFn: async () => { t += 6000; },
      nowFn: () => t,
    });
    // Before the fix a null delivery payload was filtered out, leaving only the
    // delivery-mode run.started, so the service returned waiting_for_packaging.
    assert.equal(r.readiness, "ambiguous", "malformed delivery_created must not masquerade as waiting");
    assert.equal(r.deliveryAvailable, false);
    assert.equal(r.deliveryRef, null);
  } finally { cleanupDir(runDir); }
});

// --- Blocker 4: MCP-03 must cover waiting_for_packaging, with real service proof ---

test("M11-10-MCP-03b (real default service): waiting_for_packaging maps to a truthful, non-error MCP output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m1110-mcp-03b-"));
  const runDir = mkdtempSync(join(tmpdir(), "m1110-mcp-03b-rd-"));
  try {
    makeGitRepo(dir);
    const runId = "run_wfp_real";
    // Delivery requested (mode set) but no durable delivery_created yet →
    // waiting_for_packaging through the REAL default service (no stub).
    writeTranscript(runDir, runId, [
      startedWithDelivery(runId),
      { type: "run.background_submitted", runId, background: true, cwd: dir },
    ]);
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir, workspaceRoot: dir,
      // Sleep-coupled clock so the bounded wait polls once then expires while
      // still pending — a truthful waiting_for_packaging fact, not an error.
      getRunDeliveryReadinessFn: async (input) => {
        const { getRunDeliveryReadiness } = await import("../src/application/runDelivery.js");
        let t = Date.now();
        return getRunDeliveryReadiness({
          ...input,
          sleepFn: () => { t += 6000; return Promise.resolve(); },
          nowFn: () => t,
        });
      },
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_delivery", arguments: { runId, waitMs: 2000 } });
      assert.equal(res.isError, undefined, "waiting_for_packaging is not an error");
      assert.equal(res.structuredContent.readiness, "waiting_for_packaging");
      assert.equal(res.structuredContent.deliveryAvailable, false);
      assert.equal(res.structuredContent.deliveryFailure, null, "waiting_for_packaging has no failure code");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); cleanupDir(runDir); }
});

// =====================================================================
// Group 7: M11-10 closeout — Lead-review residue (real service RED → GREEN)
//
// Three narrow invariants the candidate left open, proven end to end with the
// REAL application service + real disk transcripts (not stubs):
//   CLZ1. A malformed-but-TRUTHY deliveryCommit (HEAD / short SHA / uppercase /
//      non-hex) already collapses the readiness LABEL to ambiguous (via
//      validateDeliveryFacts), but the reconstructed VIEW still entered the
//      success path and echoed deliveryAvailable:true + deliveryRef/changedPaths.
//      The reconstruction layer must fail closed too: such a ref is a durable
//      conflict, so deliveryAvailable=false and no ref/path is echoed.
//   CLZ2. A formal run.delivery_accepted/rejected event always carries a
//      delivery ref (see JsonlTranscript.tryAppendDecision). A decision bound to
//      this runId that is missing delivery / non-object / foreign-ref /
//      non-canonical is a durable conflict — it must NOT project acceptance and
//      must NOT echo. (A missing delivery was previously tolerated.)
//   CLZ3. The reconstruction must FULL-scan each category for a conflict before
//      selecting the newest usable fact; a reverse-order `break` would shadow an
//      earlier malformed event behind a newer valid one (comment said ANY, code
//      only checked up to the first valid event).
// =====================================================================

// --- CLZ1: malformed-but-truthy deliveryCommit/baseCommit → ambiguous, no echo ---

test("M11-10-CLZ1-SVC (real service): non-canonical-but-truthy commit on created/verification → ambiguous, no ref/path echo", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "m1110-clz1-svc-"));
  try {
    // Truthy but non-canonical commit ids — each is rejected by the shared
    // isCanonicalCommitId (no regex copied here). Applied to deliveryCommit on
    // BOTH the created and verification ref (so the commits "match" — this
    // isolates the canonical-check bug from the commit-mismatch bug).
    const badCommits = ["HEAD", "abc1234", "D".repeat(40), "g".repeat(40)];
    for (const bad of badCommits) {
      const runId = "run_clz1";
      const ref = { ...makeRef(runId), deliveryCommit: bad };
      writeTranscript(runDir, runId, [
        startedWithDelivery(runId),
        { type: "run.delivery_created", runId, delivery: ref },
        { type: "run.delivery_verification_passed", runId, delivery: ref },
        ...terminal(runId),
      ]);
      // Non-waiting: created+verification with a non-canonical commit projects
      // ambiguous via validateDeliveryFacts, so the service returns early.
      const r = await getRunDeliveryReadiness({
        runId, runDir, waitMs: 1000,
        sleepFn: async () => {}, nowFn: () => 1_000_000,
      });
      assert.equal(r.readiness, "ambiguous", `deliveryCommit ${JSON.stringify(bad)} → ambiguous`);
      assert.equal(r.deliveryAvailable, false, `deliveryCommit ${JSON.stringify(bad)} → not available`);
      assert.equal(r.deliveryRef, null, `deliveryCommit ${JSON.stringify(bad)} → no ref echoed`);
      // No dynamic ref/path/commit value may leak on the ambiguous path.
      const dumped = JSON.stringify(r);
      assert.ok(!dumped.includes(bad), `non-canonical commit ${JSON.stringify(bad)} not echoed`);
      assert.ok(!dumped.includes("src/a.js"), `changedPath not echoed for deliveryCommit ${JSON.stringify(bad)}`);
    }

    // A non-canonical BASE commit (deliveryCommit canonical) is equally a
    // conflict: the canonical DeliveryRef requirement covers baseCommit too, so
    // the reconstruction must not echo a ref whose baseCommit is "HEAD" even when
    // validateDeliveryFacts (which only checks deliveryCommit) would pass.
    {
      const runId = "run_clz1";
      const ref = { ...makeRef(runId), baseCommit: "HEAD" };
      writeTranscript(runDir, runId, [
        startedWithDelivery(runId),
        { type: "run.delivery_created", runId, delivery: ref },
        { type: "run.delivery_verification_passed", runId, delivery: ref },
        ...terminal(runId),
      ]);
      const r = await getRunDeliveryReadiness({
        runId, runDir, waitMs: 1000,
        sleepFn: async () => {}, nowFn: () => 1_000_000,
      });
      assert.equal(r.readiness, "ambiguous", "non-canonical baseCommit → ambiguous");
      assert.equal(r.deliveryAvailable, false, "non-canonical baseCommit → not available");
      assert.equal(r.deliveryRef, null, "non-canonical baseCommit → no ref echoed");
      assert.ok(!JSON.stringify(r).includes("HEAD"), "non-canonical baseCommit not echoed");
    }
  } finally { cleanupDir(runDir); }
});

// --- CLZ2: malformed bound decision event → ambiguous, no acceptance projected ---

test("M11-10-CLZ2-SVC (real service): malformed bound decision event → ambiguous, no acceptance/ref echo", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "m1110-clz2-svc-"));
  try {
    const runId = "run_clz2";
    const goodRef = makeRef(runId); // canonical commits
    // Each case seeds a fully valid created+verification (so the projection is
    // reviewable and the ONLY reason to fail closed is the malformed bound
    // decision), plus a bound run.delivery_accepted whose delivery violates the
    // formal event contract (tryAppendDecision always writes a delivery ref).
    const cases = [
      { label: "missing delivery", decision: { type: "run.delivery_accepted", runId, reason: "leak-missing" } },
      { label: "null delivery", decision: { type: "run.delivery_accepted", runId, delivery: null, reason: "leak-null" } },
      { label: "string delivery", decision: { type: "run.delivery_accepted", runId, delivery: "not-a-ref", reason: "leak-string" } },
      { label: "foreign ref.runId", decision: { type: "run.delivery_accepted", runId, delivery: makeRef("run_IMPOSTOR"), reason: "leak-foreign" } },
      { label: "non-canonical commit", decision: { type: "run.delivery_accepted", runId, delivery: { ...makeRef(runId), deliveryCommit: "HEAD" }, reason: "leak-noncanonical" } },
    ];
    for (const c of cases) {
      writeTranscript(runDir, runId, [
        startedWithDelivery(runId),
        { type: "run.delivery_created", runId, delivery: goodRef },
        { type: "run.delivery_verification_passed", runId, delivery: goodRef },
        ...terminal(runId),
        c.decision,
      ]);
      const r = await getRunDeliveryReadiness({
        runId, runDir, waitMs: 1000,
        sleepFn: async () => {}, nowFn: () => 1_000_000,
      });
      assert.equal(r.readiness, "ambiguous", `${c.label}: malformed decision → ambiguous`);
      assert.equal(r.deliveryAvailable, false, `${c.label}: not available`);
      assert.equal(r.deliveryRef, null, `${c.label}: no ref echoed`);
      // A malformed decision must never project acceptance.
      assert.equal(r.acceptance, null, `${c.label}: acceptance must NOT be projected`);
      // The malformed decision's reason / impostor ref must not leak either.
      const dumped = JSON.stringify(r);
      assert.ok(!dumped.includes(c.decision.reason), `${c.label}: decision reason not echoed`);
      assert.ok(!dumped.includes("run_IMPOSTOR"), `${c.label}: impostor ref not echoed`);
    }
  } finally { cleanupDir(runDir); }
});

// --- CLZ3: full-scan — an earlier malformed event is not shadowed ---

test("M11-10-CLZ3-SVC (real service): earlier malformed created not shadowed by newer valid one → ambiguous, no echo", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "m1110-clz3-svc-"));
  try {
    const runId = "run_clz3";
    // Older created: bound object, but a NON-canonical (truthy) deliveryCommit.
    // Newer created: fully canonical. A reverse-order `break` on the newer valid
    // event would skip the older malformed one and leave conflict=false, so the
    // view echoed the newer ref while the projection said ambiguous. The
    // durable-facts contract is "ANY bound malformed event fails closed", so the
    // full scan must record the older conflict and void the whole view.
    const olderRef = { ...makeRef(runId), deliveryCommit: "HEAD", changedFiles: ["OLDER/leak.js"] };
    const newerRef = { ...makeRef(runId), deliveryCommit: "c".repeat(40), changedFiles: ["src/newer.js"] };
    writeTranscript(runDir, runId, [
      startedWithDelivery(runId),
      { type: "run.delivery_created", runId, delivery: olderRef }, // older, malformed
      { type: "run.delivery_created", runId, delivery: newerRef }, // newer, valid
      { type: "run.delivery_verification_passed", runId, delivery: newerRef },
      ...terminal(runId),
    ]);
    const r = await getRunDeliveryReadiness({
      runId, runDir, waitMs: 1000,
      sleepFn: async () => {}, nowFn: () => 1_000_000,
    });
    // Projection: two bound created events → ambiguous (count). The VIEW must
    // agree by fail-closing on the older malformed event — not by echoing the
    // newer valid ref (which a `break`-on-first-valid scan would do).
    assert.equal(r.readiness, "ambiguous");
    assert.equal(r.deliveryAvailable, false, "the older malformed event voids the view");
    assert.equal(r.deliveryRef, null);
    const dumped = JSON.stringify(r);
    assert.ok(!dumped.includes("OLDER/leak.js"), "older malformed changedPath not echoed");
    assert.ok(!dumped.includes("src/newer.js"), "newer valid changedPath not echoed either (whole view fail-closed)");
    assert.ok(!dumped.includes("HEAD"), "older non-canonical commit not echoed");
  } finally { cleanupDir(runDir); }
});
