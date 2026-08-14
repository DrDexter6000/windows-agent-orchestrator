// test/m12-16-runCorrection.test.js
//
// M12-16: queued in-flight correction — transcript durable queue + application
// service + detached-runner causal delivery.
//
// WAO is a deterministic transport: "queued" proves a durable append, "delivered"
// proves bytes reached provider stdin — NEITHER proves the model executed the turn
// (queued ≠ delivered ≠ executed). No auto stop/retry/re-scope/accept/reject/semantic
// decision. The prompt is never echoed through any safe query surface.
//
// Contracts under test:
//   T — transcript CAS primitives: exactly-once request, duplicate detection,
//       terminal TOCTOU re-check, atomic claim (single claimer), delivered /
//       delivery_failed, rejectOutstandingCorrections (no stranded requests),
//       projectCorrections / projectCorrectionStatus, no body leak in events.
//   S — correctRun service: malformed/unknown_run/workspace_mismatch/not_correctable/
//       not_ready/terminal_run/duplicate refusals (closed-set, zero append), queued
//       success, idempotent re-queue, two-different-in-order, never echoes prompt.
//   R — detached runner causal delivery (injectable fake child stdin): externally
//       appended requests delivered exactly once in order; provider-done vs
//       correction race; zero delivery after terminal; outstanding durable rejection;
//       no auto stop/retry/state change.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JsonlTranscript,
  readTranscript,
  findState,
  TERMINAL_STATES,
  projectCorrections,
  projectCorrectionStatus,
  CORRECTION_OUTCOMES,
  CORRECTION_REJECTION_REASONS,
} from "../../src/transcript.js";
import { correctRun, CORRECTION_ID_PATTERN } from "../../src/application/runCorrection.js";
import { Run } from "../../src/runManager.js";

const RUN_ID = "run_20260810120000000aaaa";
const AGENT_ID = "coder_hq";

async function makeDir() {
  const dir = await mkdtemp(join(tmpdir(), "wao-m1216-"));
  return dir;
}

// proveWorkspace canonicalizes the Git top-level, so the workspace must be a
// real git repo for the ownership proof (matching how production binds).
function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email t@t.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name t", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m init", { cwd: dir, stdio: "pipe" });
}

// Build a transcript that looks like a running correctable dispatch: the durable
// facts correctRun + the runner need (background_submitted.correctable, pending,
// session.created, run.started). workspaceRoot is recorded so ownership proves.
async function seedCorrectableRun(dir, {
  workspaceRoot = dir, correctable = true, terminal = false,
  // P1 causal variants. `submitted` controls whether the run reaches the
  // live-provider phase (pending → submitted); false leaves it at pending WITH
  // run.started present (the exact P1 hole: started event visible, but the
  // durable state never reached the live-provider phase). `running` advances
  // submitted → running (first assistant message). `spawnError` models a spawn
  // failure (pending → failed; run.started/submitted never land).
  submitted = true, running = false, spawnError = false,
} = {}) {
  makeGitRepo(dir);
  const filePath = join(dir, `${RUN_ID}.jsonl`);
  const t = new JsonlTranscript(filePath, { runId: RUN_ID, agentId: AGENT_ID });
  await t.append("run.background_submitted", {
    background: true,
    cwd: workspaceRoot,
    deliveryRequested: true,
    ...(correctable ? { correctable: true } : {}),
  });
  await t.transitionState(null, "pending", "background_spawned");
  if (spawnError) {
    // Faithful to RunManager.start spawn_error: pending → failed BEFORE the run
    // reaches a live-provider state (run.started/submitted never land). No
    // correction may be queued against this — and so none can be stranded.
    await t.append("run.error", { phase: "spawn", error: "spawn failed" });
    await t.transitionState("pending", "failed", "spawn_error");
    return { filePath, t };
  }
  await t.append("session.created", { backend: "process", backendSessionId: "proc_1" });
  // run.started carries the worktree path the ownership proof reads.
  await t.append("run.started", {
    backend: "claude-code",
    cwd: workspaceRoot,
    worktreePath: workspaceRoot,
    worktreeBranch: "wao/main",
  });
  if (submitted) {
    await t.transitionState("pending", "submitted", "spawned");
    if (running) {
      await t.transitionState("submitted", "running", "first_message");
    }
    if (terminal) {
      const endState = running ? "running" : "submitted";
      await t.transitionState(endState, "completed", "done", {
        factEvents: [{ type: "run.completed", payload: {} }],
      });
    }
  } else if (terminal) {
    // terminal-in-spawn shape: pending → terminal directly.
    await t.transitionState("pending", "completed", "done", {
      factEvents: [{ type: "run.completed", payload: {} }],
    });
  }
  return { filePath, t };
}

// =====================================================================
// T — transcript CAS primitives
// =====================================================================

test("M12-16-T1: tryAppendCorrectionRequested appends exactly one request; projectCorrections reads it", async () => {
  const dir = await makeDir();
  try {
    const { filePath, t } = await seedCorrectableRun(dir, { workspaceRoot: dir });
    const res = await t.tryAppendCorrectionRequested({ correctionId: "c1", prompt: "fix the bug" });
    assert.equal(res.queued, true);
    const events = await readTranscript(filePath);
    const proj = projectCorrections(events, RUN_ID);
    assert.equal(proj.size, 1);
    const info = proj.get("c1");
    assert.equal(info.status, "pending");
    assert.equal(info.prompt, "fix the bug");
    // exactly one requested event
    assert.equal(events.filter((e) => e.type === "run.correction_requested").length, 1);
    // envelope bound
    assert.equal(events.at(-1).runId, RUN_ID);
    assert.equal(events.at(-1).agentId, AGENT_ID);
    assert.match(String(events.at(-1).seq), /^\d+$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-16-T2: duplicate correctionId → no re-append, returns existing status", async () => {
  const dir = await makeDir();
  try {
    const { t } = await seedCorrectableRun(dir, { workspaceRoot: dir });
    await t.tryAppendCorrectionRequested({ correctionId: "c1", prompt: "first" });
    const second = await t.tryAppendCorrectionRequested({ correctionId: "c1", prompt: "first" });
    assert.equal(second.queued, false);
    assert.equal(second.reason, "duplicate");
    assert.equal(second.existing.status, "pending");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-16-T3: terminal run → tryAppendCorrectionRequested refuses (TOCTOU re-check in lock)", async () => {
  const dir = await makeDir();
  try {
    const { t } = await seedCorrectableRun(dir, { workspaceRoot: dir, terminal: true });
    const res = await t.tryAppendCorrectionRequested({ correctionId: "c1", prompt: "x" });
    assert.equal(res.queued, false);
    assert.equal(res.reason, "terminal_run");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-16-T4: tryClaimCorrection — single claimer wins, second is already_handled", async () => {
  const dir = await makeDir();
  try {
    const { t } = await seedCorrectableRun(dir, { workspaceRoot: dir });
    await t.tryAppendCorrectionRequested({ correctionId: "c1", prompt: "p" });
    const a = await t.tryClaimCorrection({ correctionId: "c1" });
    assert.equal(a.claimed, true);
    assert.equal(a.prompt, "p");
    const b = await t.tryClaimCorrection({ correctionId: "c1" });
    assert.equal(b.claimed, false);
    assert.equal(b.reason, "already_handled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-16-T5: appendCorrectionDelivered marks delivered; idempotent on repeat", async () => {
  const dir = await makeDir();
  try {
    const { filePath, t } = await seedCorrectableRun(dir, { workspaceRoot: dir });
    await t.tryAppendCorrectionRequested({ correctionId: "c1", prompt: "p" });
    await t.tryClaimCorrection({ correctionId: "c1" });
    const r1 = await t.appendCorrectionDelivered({ correctionId: "c1" });
    assert.equal(r1.recorded, true);
    const r2 = await t.appendCorrectionDelivered({ correctionId: "c1" });
    assert.equal(r2.recorded, false); // idempotent
    const info = projectCorrections(await readTranscript(filePath), RUN_ID).get("c1");
    assert.equal(info.status, "delivered");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-16-T6: appendCorrectionDeliveryFailed records closed-set reason; terminal for that correction", async () => {
  const dir = await makeDir();
  try {
    const { filePath, t } = await seedCorrectableRun(dir, { workspaceRoot: dir });
    await t.tryAppendCorrectionRequested({ correctionId: "c1", prompt: "p" });
    await t.tryClaimCorrection({ correctionId: "c1" });
    const r = await t.appendCorrectionDeliveryFailed({ correctionId: "c1", reason: "stdin_closed" });
    assert.equal(r.recorded, true);
    assert.equal(r.reason, "stdin_closed");
    // unknown reason collapses to send_failed (closed set)
    const r2 = await t.appendCorrectionDeliveryFailed({ correctionId: "c2", reason: "bogus" });
    assert.equal(r2.reason, "send_failed");
    const info = projectCorrections(await readTranscript(filePath), RUN_ID).get("c1");
    assert.equal(info.status, "delivery_failed");
    assert.equal(info.reason, "stdin_closed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-16-T7: rejectOutstandingCorrections rejects all pending+claimed as terminal_race; leaves delivered alone", async () => {
  const dir = await makeDir();
  try {
    const { filePath, t } = await seedCorrectableRun(dir, { workspaceRoot: dir });
    await t.tryAppendCorrectionRequested({ correctionId: "c1", prompt: "p1" });
    await t.tryAppendCorrectionRequested({ correctionId: "c2", prompt: "p2" });
    await t.tryClaimCorrection({ correctionId: "c1" }); // claimed
    // c2 stays pending
    await t.tryAppendCorrectionRequested({ correctionId: "c3", prompt: "p3" });
    await t.tryClaimCorrection({ correctionId: "c3" });
    await t.appendCorrectionDelivered({ correctionId: "c3" }); // delivered — must NOT be rejected
    const res = await t.rejectOutstandingCorrections();
    assert.deepEqual([...res.rejected].sort(), ["c1", "c2"]);
    const proj = projectCorrections(await readTranscript(filePath), RUN_ID);
    assert.equal(proj.get("c1").status, "rejected");
    assert.equal(proj.get("c1").reason, "terminal_race");
    assert.equal(proj.get("c2").status, "rejected");
    assert.equal(proj.get("c3").status, "delivered");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-16-T8: projectCorrectionStatus found/not-found; never exposes prompt", async () => {
  const dir = await makeDir();
  try {
    const { filePath, t } = await seedCorrectableRun(dir, { workspaceRoot: dir });
    await t.tryAppendCorrectionRequested({ correctionId: "c1", prompt: "secret-ish" });
    const events = await readTranscript(filePath);
    const found = projectCorrectionStatus(events, RUN_ID, "c1");
    assert.equal(found.found, true);
    assert.equal(found.status, "pending");
    assert.equal("prompt" in found, false, "projectCorrectionStatus must not expose prompt");
    const missing = projectCorrectionStatus(events, RUN_ID, "nope");
    assert.equal(missing.found, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-16-T9: closed sets are frozen and non-empty", () => {
  assert.ok(Object.isFrozen(CORRECTION_OUTCOMES));
  assert.ok(Object.isFrozen(CORRECTION_REJECTION_REASONS));
  assert.ok(CORRECTION_OUTCOMES.length > 0);
  assert.ok(CORRECTION_REJECTION_REASONS.length > 0);
  // queued/delivered/rejected/pending present
  for (const o of ["queued", "pending", "delivered", "rejected"]) {
    assert.ok(CORRECTION_OUTCOMES.includes(o), `outcome ${o} present`);
  }
});

// =====================================================================
// S — correctRun application service
// =====================================================================

test("M12-16-S1: correctRun queues a request on a running correctable run (outcome queued, one append)", async () => {
  const dir = await makeDir();
  try {
    const { filePath } = await seedCorrectableRun(dir, { workspaceRoot: dir });
    const res = await correctRun({
      runId: RUN_ID, correctionId: "fix-1", prompt: "please also add tests",
      runDir: dir, authorizedWorkspaceRoot: dir,
    });
    assert.equal(res.outcome, "queued");
    assert.equal(res.reason, null);
    assert.equal(res.runId, RUN_ID);
    assert.equal(res.correctionId, "fix-1");
    const events = await readTranscript(filePath);
    assert.equal(events.filter((e) => e.type === "run.correction_requested").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-16-S2: correctRun never echoes the prompt in its result", async () => {
  const dir = await makeDir();
  try {
    await seedCorrectableRun(dir, { workspaceRoot: dir });
    const res = await correctRun({
      runId: RUN_ID, correctionId: "c1", prompt: "test-secret-marker-m1216",
      runDir: dir, authorizedWorkspaceRoot: dir,
    });
    const serialized = JSON.stringify(res);
    assert.equal(serialized.includes("test-secret-marker-m1216"), false, "result must not echo prompt");
    assert.equal("prompt" in res, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-16-S3: refusals are closed-set with ZERO transcript append", async () => {
  const dir = await makeDir();
  try {
    const { filePath } = await seedCorrectableRun(dir, { workspaceRoot: dir });
    const before = (await readTranscript(filePath)).length;

    // unknown run
    const unknown = await correctRun({
      runId: "run_20260101000000000zzzz", correctionId: "c", prompt: "x",
      runDir: dir, authorizedWorkspaceRoot: dir,
    });
    assert.equal(unknown.outcome, "rejected");
    assert.equal(unknown.reason, "unknown_run");

    // not correctable
    const dir2 = await makeDir();
    try {
      await seedCorrectableRun(dir2, { workspaceRoot: dir2, correctable: false });
      const notCorr = await correctRun({
        runId: RUN_ID, correctionId: "c", prompt: "x",
        runDir: dir2, authorizedWorkspaceRoot: dir2,
      });
      assert.equal(notCorr.outcome, "rejected");
      assert.equal(notCorr.reason, "not_correctable");
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }

    // terminal run
    const dir3 = await makeDir();
    try {
      await seedCorrectableRun(dir3, { workspaceRoot: dir3, terminal: true });
      const term = await correctRun({
        runId: RUN_ID, correctionId: "c", prompt: "x",
        runDir: dir3, authorizedWorkspaceRoot: dir3,
      });
      assert.equal(term.outcome, "rejected");
      assert.equal(term.reason, "terminal_run");
    } finally {
      await rm(dir3, { recursive: true, force: true });
    }

    // malformed inputs
    const m1 = await correctRun({ runId: RUN_ID, correctionId: "bad id!", prompt: "x", runDir: dir, authorizedWorkspaceRoot: dir });
    assert.equal(m1.reason, "malformed_input");
    const m2 = await correctRun({ runId: RUN_ID, correctionId: "c", prompt: "", runDir: dir, authorizedWorkspaceRoot: dir });
    assert.equal(m2.reason, "malformed_input");

    // no append happened on the main run transcript
    const after = (await readTranscript(filePath)).length;
    assert.equal(after, before, "refusals append nothing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-16-S4: workspace_mismatch refusal (ownership proof fails)", async () => {
  const dir = await makeDir();
  const other = await makeDir();
  try {
    await seedCorrectableRun(dir, { workspaceRoot: dir });
    const res = await correctRun({
      runId: RUN_ID, correctionId: "c", prompt: "x",
      runDir: dir, authorizedWorkspaceRoot: other,
    });
    assert.equal(res.outcome, "rejected");
    assert.equal(res.reason, "workspace_mismatch");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test("M12-16-S5: idempotent re-queue (same correctionId+prompt) returns pending, no re-append", async () => {
  const dir = await makeDir();
  try {
    const { filePath } = await seedCorrectableRun(dir, { workspaceRoot: dir });
    await correctRun({ runId: RUN_ID, correctionId: "c1", prompt: "same", runDir: dir, authorizedWorkspaceRoot: dir });
    const again = await correctRun({ runId: RUN_ID, correctionId: "c1", prompt: "same", runDir: dir, authorizedWorkspaceRoot: dir });
    assert.equal(again.outcome, "pending");
    const events = await readTranscript(filePath);
    assert.equal(events.filter((e) => e.type === "run.correction_requested").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-16-S6: same correctionId DIFFERENT prompt → duplicate refusal (original stands)", async () => {
  const dir = await makeDir();
  try {
    await seedCorrectableRun(dir, { workspaceRoot: dir });
    await correctRun({ runId: RUN_ID, correctionId: "c1", prompt: "first", runDir: dir, authorizedWorkspaceRoot: dir });
    const dup = await correctRun({ runId: RUN_ID, correctionId: "c1", prompt: "different", runDir: dir, authorizedWorkspaceRoot: dir });
    assert.equal(dup.outcome, "rejected");
    assert.equal(dup.reason, "duplicate");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-16-S7: two different corrections queue in order (distinct correctionIds)", async () => {
  const dir = await makeDir();
  try {
    const { filePath } = await seedCorrectableRun(dir, { workspaceRoot: dir });
    await correctRun({ runId: RUN_ID, correctionId: "a", prompt: "pa", runDir: dir, authorizedWorkspaceRoot: dir });
    await correctRun({ runId: RUN_ID, correctionId: "b", prompt: "pb", runDir: dir, authorizedWorkspaceRoot: dir });
    const events = await readTranscript(filePath);
    const reqs = events.filter((e) => e.type === "run.correction_requested");
    assert.deepEqual(reqs.map((e) => e.correctionId), ["a", "b"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-16-S8: correctionId pattern is the safe closed alphabet", () => {
  assert.match("fix_1", CORRECTION_ID_PATTERN);
  assert.match("ABC-123", CORRECTION_ID_PATTERN);
  assert.doesNotMatch("has space", CORRECTION_ID_PATTERN);
  assert.doesNotMatch("slash/here", CORRECTION_ID_PATTERN);
  assert.doesNotMatch("dot.here", CORRECTION_ID_PATTERN);
});

test("M12-16-S9: correctRun is purely additive — run state is unchanged (no auto stop/retry/state decision)", async () => {
  const dir = await makeDir();
  try {
    await seedCorrectableRun(dir, { workspaceRoot: dir });
    const beforeState = findState(await readTranscript(join(dir, `${RUN_ID}.jsonl`)));
    await correctRun({ runId: RUN_ID, correctionId: "c1", prompt: "p", runDir: dir, authorizedWorkspaceRoot: dir });
    const afterState = findState(await readTranscript(join(dir, `${RUN_ID}.jsonl`)));
    assert.equal(afterState, beforeState, "correctRun MUST NOT change run state");
    assert.equal(TERMINAL_STATES.includes(afterState), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// =====================================================================
// R — detached runner causal delivery (injectable fake child stdin)
//
// These construct a REAL Run over a REAL on-disk transcript and drive it with a
// fake provider handle that faithfully reproduces the processBackend contract
// (it invokes onPollTick on each wake and emits done). Only the child is faked —
// the real _pollCorrections / _runCleanup / transitionState run. No CLI is
// spawned (so the host's Node-v24 guard is irrelevant here).
// =====================================================================

// Fake provider handle. `sent` captures every delivered correction line. The
// events() generator reproduces the single control loop: yield one assistant
// message (→ running), then for `ticks` cycles call onPollTick (the runner's
// correction drain) and run `betweenTicks(i)`, then emit done(completed).
// pollBeforeDone=false models "provider finished before any poll tick" (the
// done-vs-correction race). deliver=false models a closed stdin (sendCorrection
// refuses stdin_closed). No isAlive/session/messages → _verifyStopQuietIfCapable
// returns early (no stop probe), keeping the fake minimal.
function makeFakeHandle({ ticks = 5, deliver = true, pollBeforeDone = true, betweenTicks = null } = {}) {
  const sent = [];
  const handle = {
    backend: "process",
    backendSessionId: "proc_fake",
    redact: (value) => value,
    abort: async () => {},
    sendCorrection: async (text) => {
      if (!deliver) return { ok: false, reason: "stdin_closed" };
      sent.push(text);
      return { ok: true };
    },
    events: async function* (_signal, opts = {}) {
      const tick = opts.onPollTick;
      yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "working" }] };
      if (pollBeforeDone) {
        for (let i = 0; i < ticks; i += 1) {
          if (typeof tick === "function") { try { await tick(); } catch { /* best-effort, like _streamEvents */ } }
          if (typeof betweenTicks === "function") betweenTicks(i);
          await new Promise((r) => setTimeout(r, opts.pollInterval ?? 10));
        }
      }
      yield { kind: "done", reason: "completed" };
    },
  };
  return { handle, sent };
}

function makeRun({ dir, transcript, handle, correctable = true }) {
  return new Run({
    runId: RUN_ID,
    agentId: AGENT_ID,
    agent: { cwd: dir },
    backend: {},
    handle,
    transcript,
    result: { backend: "process", backendSessionId: "proc_fake" },
    // waitTimeout absent → deadline disabled (no time-based kill); pollInterval
    // bounds the wake cadence so onPollTick fires promptly.
    config: { pollInterval: 10, runDir: dir },
    onRemove: () => {},
    effectiveCwd: dir,
    correctable,
  });
}

test("M12-16-R1: externally-queued corrections are delivered exactly once, in order, then run completes normally", async () => {
  const dir = await makeDir();
  try {
    const { filePath, t } = await seedCorrectableRun(dir, { workspaceRoot: dir });
    // Two distinct corrections queued by the (cross-process) MCP path.
    await correctRun({ runId: RUN_ID, correctionId: "c1", prompt: "pa", runDir: dir, authorizedWorkspaceRoot: dir });
    await correctRun({ runId: RUN_ID, correctionId: "c2", prompt: "pb", runDir: dir, authorizedWorkspaceRoot: dir });

    const { handle, sent } = makeFakeHandle({ ticks: 5 });
    const run = makeRun({ dir, transcript: t, handle });
    const result = await run.waitForCompletion({ pollInterval: 10 });

    assert.equal(result.completed, true);
    // exactly-once, in order — claim is a single winner across all poll ticks
    assert.equal(sent.length, 2);
    assert.deepEqual(sent, ["pa", "pb"]);
    const proj = projectCorrections(await readTranscript(filePath), RUN_ID);
    assert.equal(proj.get("c1").status, "delivered");
    assert.equal(proj.get("c2").status, "delivered");
    const events = await readTranscript(filePath);
    assert.equal(events.filter((e) => e.type === "run.correction_delivered").length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-16-R2: provider-done beats the correction → NOT delivered (queued≠delivered), then rejected terminal_race (no stranded request)", async () => {
  const dir = await makeDir();
  try {
    const { filePath, t } = await seedCorrectableRun(dir, { workspaceRoot: dir });
    await correctRun({ runId: RUN_ID, correctionId: "c1", prompt: "secret-body", runDir: dir, authorizedWorkspaceRoot: dir });

    // pollBeforeDone=false: the provider emits done with NO poll tick in between,
    // so the queued correction is never claimed during the run.
    const { handle, sent } = makeFakeHandle({ pollBeforeDone: false });
    const run = makeRun({ dir, transcript: t, handle });
    const result = await run.waitForCompletion({ pollInterval: 10 });

    assert.equal(result.completed, true, "run still completes normally — correction is purely additive");
    assert.equal(sent.length, 0, "queued correction must NOT be delivered when done wins the race");
    const proj = projectCorrections(await readTranscript(filePath), RUN_ID);
    assert.equal(proj.get("c1").status, "rejected");
    assert.equal(proj.get("c1").reason, "terminal_race");
    // The no-leak guarantee is about SAFE QUERY SURFACES, not the transcript file
    // (the transcript is the durable queue and carries the bounded prompt, same
    // trust level as prompt.sent). projectCorrectionStatus is a safe surface: it
    // reports status only, never the body.
    const statusOnly = projectCorrectionStatus(await readTranscript(filePath), RUN_ID, "c1");
    assert.equal(statusOnly.found, true);
    assert.equal("prompt" in statusOnly, false, "status projection must never expose the prompt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-16-R3: a correction appended mid-run (cross-process) is delivered; one stranded when done fires is rejected, delivered left alone", async () => {
  const dir = await makeDir();
  try {
    const { filePath, t } = await seedCorrectableRun(dir, { workspaceRoot: dir });
    // c1 is queued BEFORE the run starts — it gets drained on the first tick.
    await correctRun({ runId: RUN_ID, correctionId: "c1", prompt: "pa", runDir: dir, authorizedWorkspaceRoot: dir });

    // ticks=1: exactly one poll cycle. betweenTicks appends c2 AFTER c1 was
    // claimed+delivered but BEFORE the next tick — then done fires, so c2 is
    // never claimed during the run. This models a real cross-process append.
    const { handle, sent } = makeFakeHandle({
      ticks: 1,
      betweenTicks: () => correctRun({ runId: RUN_ID, correctionId: "c2", prompt: "pb", runDir: dir, authorizedWorkspaceRoot: dir }),
    });
    const run = makeRun({ dir, transcript: t, handle });
    const result = await run.waitForCompletion({ pollInterval: 10 });

    assert.equal(result.completed, true);
    assert.deepEqual(sent, ["pa"], "only the pre-queued correction was delivered this run");
    const proj = projectCorrections(await readTranscript(filePath), RUN_ID);
    assert.equal(proj.get("c1").status, "delivered", "delivered correction is never re-rejected");
    assert.equal(proj.get("c2").status, "rejected", "stranded request is rejected at terminal cleanup");
    assert.equal(proj.get("c2").reason, "terminal_race");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-16-R4: a delivery failure (stdin_closed) is recorded delivery_failed, NOT delivered; run still completes (no auto retry/state change)", async () => {
  const dir = await makeDir();
  try {
    const { filePath, t } = await seedCorrectableRun(dir, { workspaceRoot: dir });
    await correctRun({ runId: RUN_ID, correctionId: "c1", prompt: "pa", runDir: dir, authorizedWorkspaceRoot: dir });

    const { handle, sent } = makeFakeHandle({ ticks: 3, deliver: false });
    const run = makeRun({ dir, transcript: t, handle });
    const result = await run.waitForCompletion({ pollInterval: 10 });

    assert.equal(result.completed, true, "delivery failure must NOT change run state or trigger retry");
    assert.equal(sent.length, 0, "nothing was delivered (stdin refused)");
    const proj = projectCorrections(await readTranscript(filePath), RUN_ID);
    assert.equal(proj.get("c1").status, "delivery_failed");
    assert.equal(proj.get("c1").reason, "stdin_closed");
    const events = await readTranscript(filePath);
    assert.equal(events.filter((e) => e.type === "run.correction_delivery_failed").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-16-R5: a non-correctable run never polls corrections (byte-compatible) and completes normally", async () => {
  const dir = await makeDir();
  try {
    const { filePath, t } = await seedCorrectableRun(dir, { workspaceRoot: dir, correctable: false });
    // Even if a correction_requested row somehow existed, a non-correctable run
    // must not poll/deliver it. (No correction is queued here; this asserts the
    // onPollTick path is absent so the legacy wait cadence is unchanged.)
    let pollCalled = false;
    const handle = {
      backend: "process",
      backendSessionId: "proc_fake",
      redact: (v) => v,
      abort: async () => {},
      sendCorrection: async () => { throw new Error("must not be called on a non-correctable run"); },
      events: async function* (_signal, opts = {}) {
        if (typeof opts.onPollTick === "function") pollCalled = true;
        yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "ok" }] };
        yield { kind: "done", reason: "completed" };
      },
    };
    const run = makeRun({ dir, transcript: t, handle, correctable: false });
    const result = await run.waitForCompletion({ pollInterval: 10 });
    assert.equal(result.completed, true);
    assert.equal(pollCalled, false, "non-correctable run must not pass onPollTick (byte-compatible legacy cadence)");
    const events = await readTranscript(filePath);
    assert.equal(events.some((e) => e.type.startsWith("run.correction_")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// =====================================================================
// P1/P2 — causal readiness + concurrency (Lead review closeout)
//
// P1: run_correct readiness is decided by the DURABLE state machine
//     (findState ∈ {submitted, running}), never by the run.started event
//     alone. pending (pre-/during-spawn), any terminal, and unknown return a
//     closed-set truthful refusal with ZERO append — so spawn_error and a
//     first-terminal-in-spawn can never leave a permanently pending correction.
// P2: when the in-lock CAS duplicate race returns the existing record, the
//     service re-compares existing.prompt vs this prompt; same correctionId +
//     different prompt is "duplicate", never pending/delivered.
// =====================================================================

test("M12-16-T10 (P2 data): CAS duplicate returns existing.prompt so the service can re-compare", async () => {
  const dir = await makeDir();
  try {
    const { t } = await seedCorrectableRun(dir, { workspaceRoot: dir });
    await t.tryAppendCorrectionRequested({ correctionId: "c1", prompt: "first" });
    // Same correctionId, DIFFERENT prompt — the CAS must surface the ORIGINAL
    // prompt so the service can detect the conflict (not the incoming one).
    const dup = await t.tryAppendCorrectionRequested({ correctionId: "c1", prompt: "different" });
    assert.equal(dup.queued, false);
    assert.equal(dup.reason, "duplicate");
    assert.equal(typeof dup.existing.prompt, "string");
    assert.equal(dup.existing.prompt, "first", "CAS returns the ORIGINAL prompt for re-comparison");
    assert.notEqual(dup.existing.prompt, "different");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-16-S10 (P1): run.started present but durable state still pending → not_ready + ZERO append", async () => {
  const dir = await makeDir();
  try {
    const { filePath } = await seedCorrectableRun(dir, { workspaceRoot: dir, submitted: false });
    // Sanity: run.started IS present, but the durable state never reached the
    // live-provider phase (pending → submitted never happened).
    const pre = await readTranscript(filePath);
    assert.ok(pre.some((e) => e.type === "run.started"), "sanity: run.started is present");
    assert.equal(findState(pre), "pending", "sanity: durable state is pending (spawn not submitted)");
    const before = pre.length;

    const res = await correctRun({
      runId: RUN_ID, correctionId: "c1", prompt: "p",
      runDir: dir, authorizedWorkspaceRoot: dir,
    });
    assert.equal(res.outcome, "rejected");
    assert.equal(res.reason, "not_ready", "P1: run.started alone must NOT make a run ready");

    const after = await readTranscript(filePath);
    assert.equal(after.length, before, "P1: a not-ready run must append NOTHING");
    assert.equal(after.some((e) => e.type === "run.correction_requested"), false, "no stranded pending correction");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-16-S11 (P1): durable submitted AND running states are queueable (live-provider phase)", async () => {
  for (const running of [false, true]) {
    const dir = await makeDir();
    try {
      const { filePath } = await seedCorrectableRun(dir, { workspaceRoot: dir, running });
      const label = running ? "running" : "submitted";
      assert.equal(findState(await readTranscript(filePath)), label, `sanity: durable state is ${label}`);
      const res = await correctRun({
        runId: RUN_ID, correctionId: "c1", prompt: "p",
        runDir: dir, authorizedWorkspaceRoot: dir,
      });
      assert.equal(res.outcome, "queued", `state ${label} must be queueable`);
      const events = await readTranscript(filePath);
      assert.equal(events.filter((e) => e.type === "run.correction_requested").length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("M12-16-S12 (P1): a spawn_error run (pending → failed) refuses with terminal_run + ZERO append (no stranded request)", async () => {
  const dir = await makeDir();
  try {
    const { filePath } = await seedCorrectableRun(dir, { workspaceRoot: dir, spawnError: true });
    const pre = await readTranscript(filePath);
    assert.equal(findState(pre), "failed", "sanity: spawn_error left the run terminal (failed)");
    assert.equal(pre.some((e) => e.type === "run.started"), false, "sanity: spawn_error never reached run.started");
    const before = pre.length;

    const res = await correctRun({
      runId: RUN_ID, correctionId: "c1", prompt: "p",
      runDir: dir, authorizedWorkspaceRoot: dir,
    });
    assert.equal(res.outcome, "rejected");
    assert.equal(res.reason, "terminal_run");

    const after = await readTranscript(filePath);
    assert.equal(after.length, before, "a terminal run must append NOTHING");
    assert.equal(after.some((e) => e.type === "run.correction_requested"), false, "no stranded pending correction");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-16-S13 (P2): CAS duplicate race — same correctionId, different prompt → duplicate, never pending/delivered", async () => {
  const dir = await makeDir();
  try {
    const { filePath } = await seedCorrectableRun(dir, { workspaceRoot: dir });
    // Freeze a STALE read (state submitted, NO correction yet) so BOTH concurrent
    // calls miss the existing-correction on the read path and BOTH reach the
    // atomic CAS — forcing the in-lock duplicate race the P2 fix targets.
    const staleEvents = await readTranscript(filePath);
    const staleReader = async () => staleEvents;

    const [a, b] = await Promise.all([
      correctRun({ runId: RUN_ID, correctionId: "c1", prompt: "first", runDir: dir, authorizedWorkspaceRoot: dir, readTranscriptFn: staleReader }),
      correctRun({ runId: RUN_ID, correctionId: "c1", prompt: "second", runDir: dir, authorizedWorkspaceRoot: dir, readTranscriptFn: staleReader }),
    ]);

    // Exactly one winner queues; the loser is refused — regardless of which
    // prompt won the lock.
    const outcomes = [a.outcome, b.outcome].sort();
    assert.deepEqual(outcomes, ["queued", "rejected"]);
    const loser = a.outcome === "queued" ? b : a;
    assert.equal(loser.outcome, "rejected");
    assert.equal(loser.reason, "duplicate", "differing prompt under the same correctionId is a duplicate conflict");
    assert.ok(!["pending", "delivered"].includes(loser.outcome), "differing prompt must NOT surface pending/delivered");
    // Exactly one durable request, regardless of who won the race.
    const events = await readTranscript(filePath);
    assert.equal(events.filter((e) => e.type === "run.correction_requested").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-16-S14 (P1+P2): a prior queued correction's status is still reportable after the run goes terminal (idempotent re-query before the gate)", async () => {
  const dir = await makeDir();
  try {
    const { filePath } = await seedCorrectableRun(dir, { workspaceRoot: dir });
    // Queue while running (submitted), then drive the run to terminal.
    await correctRun({ runId: RUN_ID, correctionId: "c1", prompt: "p", runDir: dir, authorizedWorkspaceRoot: dir });
    const t = new JsonlTranscript(join(dir, `${RUN_ID}.jsonl`), { runId: RUN_ID, agentId: AGENT_ID });
    await t.transitionState("submitted", "completed", "done", {
      factEvents: [{ type: "run.completed", payload: {} }],
    });
    assert.equal(findState(await readTranscript(filePath)), "completed");

    // Re-query with the SAME prompt → existing status (pending), NOT terminal_run:
    // the ready gate refuses only NEW queueing; a prior outcome stays readable.
    const again = await correctRun({ runId: RUN_ID, correctionId: "c1", prompt: "p", runDir: dir, authorizedWorkspaceRoot: dir });
    assert.equal(again.outcome, "pending");
    // A DIFFERENT prompt for the same id is still a duplicate, even after terminal.
    const dup = await correctRun({ runId: RUN_ID, correctionId: "c1", prompt: "different", runDir: dir, authorizedWorkspaceRoot: dir });
    assert.equal(dup.outcome, "rejected");
    assert.equal(dup.reason, "duplicate");
    // No second append happened.
    const events = await readTranscript(filePath);
    assert.equal(events.filter((e) => e.type === "run.correction_requested").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
