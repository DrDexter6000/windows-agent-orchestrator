// test/runDeliveryService.test.js
//
// M9-6A: shared run delivery application services — TDD tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getRunDelivery, decideRunDelivery } from "../src/application/runDelivery.js";
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

test("M9-6A-04: missing committed delivery fails closed", async () => {
  const { dir, runId, transcript } = makeDeliveryTranscript("s04");
  try {
    await transcript.append("run.state_change", { to: "completed", reason: "done" });
    await assert.rejects(() => getRunDelivery({ runId, runDir: dir }));
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
