// test/runDeliveryService.test.js
//
// M9-6A: shared run delivery application services — TDD tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getRunDelivery, decideRunDelivery, projectDeliveryReadiness } from "../src/application/runDelivery.js";
import { JsonlTranscript, readTranscript } from "../src/transcript.js";

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function makeDeliveryTranscript(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const runId = `run_${prefix}`;
  const transcript = new JsonlTranscript(join(dir, `${runId}.jsonl`), { runId, agentId: "test" });
  return { dir, runId, transcript };
}

async function writeFullDeliveryLifecycle(transcript, overrides = {}) {
  const status = overrides.verificationStatus ?? "passed";
  const deliveryRef = {
    schemaVersion: 1, kind: "git_commit", runId: transcript.context.runId,
    baseCommit: "b".repeat(40), deliveryCommit: "d".repeat(40),
    branch: `wao/${transcript.context.runId}`, worktreePath: "/fake/wt", changedFiles: ["src/a.js"],
    verification: { status, commands: ["echo ok"], verifiedCommit: "d".repeat(40), results: [],
      ...(overrides.failureCode ? { failureCode: overrides.failureCode } : {}) },
    acceptance: { status: "pending", reviewerType: "lead_agent" },
    integration: { status: "pending", targetCommit: null }, ...overrides.ref,
  };
  await transcript.append("run.started", {
    delivery: { mode: "git_commit_v1", baseCommit: "b".repeat(40), allowedPaths: ["src"], verificationCommands: ["echo ok"] },
    worktreePath: "/fake/wt", worktreeBranch: `wao/${transcript.context.runId}`,
  });
  await transcript.append("run.delivery_created", { delivery: deliveryRef });
  const vType = status === "passed" ? "run.delivery_verification_passed" : status === "failed" ? "run.delivery_verification_failed" : "run.delivery_verification_unavailable";
  await transcript.append(vType, { delivery: deliveryRef });
  await transcript.append("run.state_change", { from: "running", to: overrides.terminalState ?? "completed", reason: "done" });
  return deliveryRef;
}

test("M9-6A-01: query result matches CLI view for pending/accepted/rejected", async () => {
  for (const [label, setup] of [
    ["pending", async (t) => { await writeFullDeliveryLifecycle(t); }],
    ["accepted", async (t) => { await writeFullDeliveryLifecycle(t); await t.tryAppendDecision({ decision: "accepted", reason: "LGTM" }); }],
    ["rejected", async (t) => { await writeFullDeliveryLifecycle(t, { verificationStatus: "failed", failureCode: "command_failed" }); await t.tryAppendDecision({ decision: "rejected", reason: "bad" }); }],
  ]) {
    const { dir, runId, transcript } = makeDeliveryTranscript(`s01${label}`);
    try {
      await setup(transcript);
      const r = await getRunDelivery({ runId, runDir: dir });
      assert.equal(r.runId, runId);
      assert.equal(r.terminalState, "completed");
      assert.ok(r.deliveryRef, `${label} has deliveryRef`);
      if (label === "pending") { assert.equal(r.acceptance.status, "pending"); assert.ok(!r.acceptance.decisionEvent); }
      if (label === "accepted") { assert.equal(r.acceptance.status, "accepted"); assert.equal(r.acceptance.decisionEvent.type, "run.delivery_accepted"); }
      if (label === "rejected") { assert.equal(r.acceptance.status, "rejected"); assert.equal(r.acceptance.decisionEvent.type, "run.delivery_rejected"); }
    } finally { cleanupDir(dir); }
  }
});

test("M9-6A-02: query transcript bytes unchanged after repeated calls", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("s02");
  try {
    await writeFullDeliveryLifecycle(transcript);
    const path = join(dir, `${runId}.jsonl`);
    const before = readFileSync(path, "utf8");
    await getRunDelivery({ runId, runDir: dir });
    await getRunDelivery({ runId, runDir: dir });
    assert.equal(readFileSync(path, "utf8"), before, "bytes unchanged");
  } finally { cleanupDir(dir); }
});

test("M9-6A-03: invalid runId rejected before readTranscript", async () => {
  let readCalls = 0;
  const fakeRead = async () => { readCalls += 1; return []; };
  for (const bad of ["../escape", "run&injected", "", "run/path", ".hidden"]) {
    let threw = false;
    try { await getRunDelivery({ runId: bad, runDir: "/x", readTranscriptFn: fakeRead }); } catch { threw = true; }
    assert.ok(threw, `bad runId ${JSON.stringify(bad)} must throw`);
  }
  assert.equal(readCalls, 0);
});

test("M9-6A-04: ordinary run without delivery request returns structured truth", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("s04");
  try {
    await transcript.append("run.state_change", { to: "completed", reason: "done" });
    assert.deepEqual(await getRunDelivery({ runId, runDir: dir }), {
      runId,
      terminalState: "completed",
      deliveryAvailable: false,
      deliveryRequested: false,
      deliveryFailure: null,
    });
  } finally { cleanupDir(dir); }
});

test("M9-6A-05: accept delegates to primitive, exactly one event", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("s05");
  try {
    await writeFullDeliveryLifecycle(transcript);
    const r = await decideRunDelivery({ runId, runDir: dir, decision: "accepted", reason: "LGTM" });
    assert.equal(r.accepted, true);
    assert.equal(r.event.type, "run.delivery_accepted");
    const events = await readTranscript(join(dir, `${runId}.jsonl`));
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted").length, 1);
  } finally { cleanupDir(dir); }
});

test("M9-6A-06: invalid decision and blank reason fail before append", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("s06");
  try {
    await writeFullDeliveryLifecycle(transcript);
    await assert.rejects(() => decideRunDelivery({ runId, runDir: dir, decision: "maybe", reason: "x" }));
    await assert.rejects(() => decideRunDelivery({ runId, runDir: dir, decision: "accepted", reason: "   " }));
    await assert.rejects(() => decideRunDelivery({ runId, runDir: dir, decision: "accepted", reason: "" }));
    const events = await readTranscript(join(dir, `${runId}.jsonl`));
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted" || e.type === "run.delivery_rejected").length, 0);
  } finally { cleanupDir(dir); }
});

test("M9-6A-07: repeated/opposite decisions return existing winner", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("s07");
  try {
    await writeFullDeliveryLifecycle(transcript);
    await decideRunDelivery({ runId, runDir: dir, decision: "accepted", reason: "LGTM" });
    const second = await decideRunDelivery({ runId, runDir: dir, decision: "accepted", reason: "x" });
    assert.equal(second.accepted, false);
    assert.equal(second.existing.status, "accepted");
    const third = await decideRunDelivery({ runId, runDir: dir, decision: "rejected", reason: "no" });
    assert.equal(third.accepted, false);
    const events = await readTranscript(join(dir, `${runId}.jsonl`));
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted" || e.type === "run.delivery_rejected").length, 1);
  } finally { cleanupDir(dir); }
});

test("M9-6A-08: append failure propagates, no success", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("s08");
  try {
    await writeFullDeliveryLifecycle(transcript);
    let threw = false;
    try {
      await decideRunDelivery({ runId, runDir: dir, decision: "accepted", reason: "x",
        transcriptFactory: async () => { throw new Error("disk full"); } });
    } catch (e) { threw = true; assert.match(e.message, /disk full/); }
    assert.ok(threw);
    const events = await readTranscript(join(dir, `${runId}.jsonl`));
    assert.equal(events.filter((e) => e.type === "run.delivery_accepted").length, 0);
  } finally { cleanupDir(dir); }
});

test("M9-6A-09: no console + dependency guard", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("s09");
  try {
    await writeFullDeliveryLifecycle(transcript);
    const logs = [];
    const oL = console.log, oE = console.error;
    console.log = (...a) => { logs.push(a); }; console.error = (...a) => { logs.push(a); };
    try { await getRunDelivery({ runId, runDir: dir }); } finally { console.log = oL; console.error = oE; }
    assert.equal(logs.length, 0);
    const { readdir, readFile } = await import("node:fs/promises");
    const appDir = join(process.cwd(), "src", "application");
    const forbidden = /(?:from\s+['"](?:\.\.\/commands\/|.*commands\/|\.\.\/mcp\/|.*mcp\/|@modelcontextprotocol|zod))/;
    for (const f of (await readdir(appDir)).filter((f) => f.endsWith(".js"))) {
      for (const line of (await readFile(join(appDir, f), "utf8")).split("\n").filter((l) => l.trim().startsWith("import"))) {
        assert.ok(!forbidden.test(line), `${f}: ${line.trim()}`);
      }
    }
  } finally { cleanupDir(dir); }
});

// ============================================================
// M12-1S2: recovery-aware readiness projection (zero-drift)
// ============================================================
//
// A retained disallowed_path failure that has been model-free repackaged now
// carries a run.delivery_created + run.delivery_repackaged provenance bound to
// the same commit. The projection must NOT collapse created+failed to ambiguous
// when the failure is superseded by that provenance — it must reach reviewable
// (with a verification outcome) or waiting_for_verification (without). The
// pre-recovery state (created absent, only the failed event) stays
// packaging_failed, and a created+failed pair WITHOUT provenance stays
// ambiguous — so the normal completed-run path is untouched.

const S2_RUN = "run_m12s2_svc";
const S2_COMMIT = "d".repeat(40);
const S2_BASE = "b".repeat(40);

function s2Ref(overrides = {}) {
  return {
    schemaVersion: 1, kind: "git_commit", runId: S2_RUN,
    baseCommit: S2_BASE, deliveryCommit: S2_COMMIT, branch: `wao/${S2_RUN}`,
    worktreePath: "/fake/wt", changedFiles: ["root.txt", "src/a.js"],
    verification: { status: "pending", commands: ["npm test"] },
    acceptance: { status: "pending", reviewerType: "lead_agent" },
    integration: { status: "pending", targetCommit: null },
    ...overrides,
  };
}

test("M12-1S2-S1: projectDeliveryReadiness — recovery supersedes the retained failure", () => {
  const created = s2Ref();
  const verified = { ...created, verification: { status: "passed", commands: ["npm test"], verifiedCommit: S2_COMMIT, results: [] } };
  const provenance = {
    type: "run.delivery_repackaged",
    runId: S2_RUN,
    delivery: created,
    approvedAllowedPaths: ["root.txt", "src"],
    source: "packaged",
  };

  // Pre-recovery: only the failed event → packaging_failed.
  const pre = [
    { type: "run.background_submitted", runId: S2_RUN, deliveryRequested: true },
    { type: "run.started", runId: S2_RUN, delivery: { mode: "git_commit_v1", baseCommit: S2_BASE, allowedPaths: ["src"], verificationCommands: ["npm test"] } },
    { type: "run.delivery_failed", runId: S2_RUN, deliveryCode: "disallowed_path" },
    { type: "run.state_change", runId: S2_RUN, from: "running", to: "failed", reason: "delivery_failed" },
  ];
  assert.equal(projectDeliveryReadiness(pre, S2_RUN), "packaging_failed");

  // After repackage, no verification yet → waiting_for_verification (not ambiguous).
  const noVerify = pre.concat([
    { type: "run.delivery_created", runId: S2_RUN, delivery: created },
    provenance,
  ]);
  assert.equal(projectDeliveryReadiness(noVerify, S2_RUN), "waiting_for_verification");

  // After verification passed → reviewable.
  const reviewable = noVerify.concat([{ type: "run.delivery_verification_passed", runId: S2_RUN, delivery: verified }]);
  assert.equal(projectDeliveryReadiness(reviewable, S2_RUN), "reviewable");

  // Duplicate or under-scoped provenance is not a valid recovery chain.
  assert.equal(
    projectDeliveryReadiness(noVerify.concat(provenance), S2_RUN),
    "ambiguous",
  );
  const narrow = noVerify.map((e) => e.type === "run.delivery_repackaged"
    ? { ...e, approvedAllowedPaths: ["src"] }
    : e);
  assert.equal(projectDeliveryReadiness(narrow, S2_RUN), "ambiguous");
});

test("M12-1S2-S2: projectDeliveryReadiness — created+failed WITHOUT provenance stays ambiguous (zero drift)", () => {
  const created = s2Ref();
  // No provenance: a created event coexisting with a bound delivery_failed is the
  // pre-M12-1S2 durable conflict — must still collapse to ambiguous so the
  // normal projection semantics do not drift.
  const events = [
    { type: "run.delivery_failed", runId: S2_RUN, deliveryCode: "disallowed_path" },
    { type: "run.state_change", runId: S2_RUN, from: "running", to: "failed", reason: "delivery_failed" },
    { type: "run.delivery_created", runId: S2_RUN, delivery: created },
  ];
  assert.equal(projectDeliveryReadiness(events, S2_RUN), "ambiguous");
});

test("M12-1S2-S3: decideRunDelivery recovery-accept admits a failed run only via the recovery chain", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("s2s3");
  try {
    // Build a failed disallowed_path run, repackaged (created+provenance),
    // verification passed — then accept must succeed despite terminal=failed.
    const ref = s2Ref({ runId });
    const verified = { ...ref, verification: { status: "passed", commands: ["npm test"], verifiedCommit: S2_COMMIT, results: [] } };
    await transcript.append("run.started", { delivery: { mode: "git_commit_v1", baseCommit: S2_BASE, allowedPaths: ["src"], verificationCommands: ["npm test"] }, worktreePath: "/fake/wt", worktreeBranch: `wao/${runId}` });
    await transcript.append("run.delivery_failed", { deliveryCode: "disallowed_path" });
    await transcript.append("run.state_change", { from: "running", to: "failed", reason: "delivery_failed" });
    await transcript.append("run.delivery_created", { delivery: ref });
    await transcript.append("run.delivery_repackaged", {
      delivery: ref,
      approvedAllowedPaths: ["root.txt", "src"],
      source: "packaged",
    });
    await transcript.append("run.delivery_verification_passed", { delivery: verified });

    const accept = await decideRunDelivery({ runId, runDir: dir, decision: "accepted", reason: "recovery verified" });
    assert.equal(accept.accepted, true);
    assert.equal(accept.event.type, "run.delivery_accepted");
  } finally { cleanupDir(dir); }
});
