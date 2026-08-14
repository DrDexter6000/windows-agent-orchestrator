// test/m12-14-isolationReason.test.js
//
// M12-14: isolation truth — a frozen closed-set REASON on the durable
// run.isolation_violation fact, plus win32-only MSYS (Git-Bash) drive-path
// normalization before lexical containment.
//
// Mainline gap being fixed: a supervised delivery worker whose runtime reports
// an IN-worktree Windows path in Git-Bash/MSYS form (e.g. "/d/proj/.../src/a.js"
// for "D:\proj\...\src\a.js") was falsely terminalized as workdir_escape — the
// lexical check resolved the MSYS form against the WRONG drive-root. And when
// the gate did fire, the durable fact carried only { code, eventKind }, so
// run_delivery / run_await_result / diagnose could not distinguish a CONFIRMED
// outside path from a missing/duplicate/pending/unconfirmed write correlation
// or an unresolvable physical path.
//
// Contract under test:
//   - ISOLATION_VIOLATION_REASONS is the ONE frozen closed-set reason SSOT.
//     code=workdir_escape is preserved for compatibility; the reason is additive.
//   - Only closed-set code/eventKind/reason are persisted — never the rejected
//     raw path.
//   - A historical (reason-absent) or malformed-reason event projects safely as
//     reason:null (unknown) — it is NEVER upgraded to a closed-set reason and
//     never invents "outside".
//   - Diagnosis fact wording never claims "outside" for correlation or
//     physical-unresolved failures.
//   - win32 only: an absolute MSYS drive path /^\/([A-Za-z])(\/|$)/ is
//     normalized to the equivalent drive-root path BEFORE lexical containment.
//     An in-worktree /d/... missing-target intent passes; an outside /d/...
//     stays rejected; non-drive absolute slash paths are not widened.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execSync } from "node:child_process";

import { diagnoseFailure, ISOLATION_VIOLATION_REASONS } from "../../src/diagnosis.js";
import {
  gatherDeliveryView,
  projectDeliveryReadiness,
  projectIsolationViolation,
} from "../../src/application/runDelivery.js";
import { runAwaitResult } from "../../src/application/runAwaitResult.js";
import { Run } from "../../src/runManager.js";
import { JsonlTranscript, readTranscript } from "../../src/transcript.js";

const WIN32 = process.platform === "win32";

// The 8 reasons the milestone names as the minimum coverage.
const MINIMUM_REASONS = [
  "write_intent_lexical_outside",
  "write_intent_physical_unresolved",
  "write_intent_missing_tool_call_id",
  "write_intent_duplicate_tool_call_id",
  "write_intent_pending_limit",
  "write_intent_pending_at_completion",
  "file_written_lexical_outside",
  "file_written_physical_unresolved",
];

// ===== runManager delivery fixture (same shape as m12-4b) =====

async function makeFixture({ delivery = true, runId = "run_m1214_reason" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "wao-m1214-reason-"));
  const effectiveCwd = join(root, "delivery-worktree");
  const runDir = join(root, "runs");
  const transcriptPath = join(runDir, `${runId}.jsonl`);
  await mkdir(effectiveCwd, { recursive: true });
  const transcript = new JsonlTranscript(transcriptPath, { runId, agentId: "coder_hq" });
  await transcript.append("session.created", {
    backend: "claude-code",
    backendSessionId: "session_m1214",
  });
  let packageCount = 0;
  let eventFactory = async function* eventFactoryDefault() {
    yield { kind: "done", reason: "completed" };
  };
  const handle = {
    backend: "claude-code",
    backendSessionId: "session_m1214",
    events(...args) {
      return eventFactory(...args);
    },
    async abort() {},
  };
  const run = new Run({
    runId,
    agentId: "coder_hq",
    agent: { id: "coder_hq", cwd: effectiveCwd },
    backend: {},
    handle,
    transcript,
    result: {
      backend: "claude-code",
      backendSessionId: "session_m1214",
      messageId: "message_m1214",
      admittedSeq: 1,
    },
    config: { runDir },
    onRemove: () => {},
    initialState: "submitted",
    effectiveCwd,
    deliveryContext: delivery ? { runId } : null,
    packageDeliveryFn: async () => {
      packageCount += 1;
      const error = new Error("fixture stops after containment check");
      error.deliveryCode = "empty_diff";
      throw error;
    },
  });
  return {
    root,
    effectiveCwd,
    runDir,
    transcriptPath,
    run,
    setEvents(factory) {
      eventFactory = factory;
    },
    getPackageCount() {
      return packageCount;
    },
  };
}

async function finishFixture(fixture) {
  const result = await fixture.run.waitForCompletion({ pollInterval: 1 });
  const events = await readTranscript(fixture.transcriptPath);
  const rawTranscript = await readFile(fixture.transcriptPath, "utf8");
  return { result, events, rawTranscript };
}

async function createFile(path) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "confirmed", "utf8");
}

async function createJunctionOrSkip(t, target, path) {
  try {
    await symlink(target, path, "junction");
    return true;
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip(`junction creation denied by platform: ${error.code}`);
      return false;
    }
    throw error;
  }
}

// Assert the durable violation fact carries EXACTLY the safe closed-set fields
// (plus transcript envelope) and never the rejected raw path.
function assertViolationFact(events, { eventKind, reason }) {
  const violation = events.find((event) => event.type === "run.isolation_violation");
  assert.ok(violation, "a run.isolation_violation fact is persisted");
  assert.equal(violation.code, "workdir_escape", "code stays workdir_escape (compat)");
  assert.equal(violation.eventKind, eventKind);
  assert.equal(violation.reason, reason);
  assert.deepEqual(
    Object.keys(violation).sort(),
    ["agentId", "code", "eventKind", "reason", "runId", "seq", "ts", "type"].sort(),
    "only closed-set code/eventKind/reason plus the transcript envelope are persisted",
  );
  return violation;
}

// D:\foo\bar → /d/foo/bar (the input shape a Git-Bash/MSYS worker reports).
function toMsysDrivePath(nativePath) {
  return nativePath
    .replace(/^([A-Za-z]):[\\/]/, (m, d) => `/${d.toLowerCase()}/`)
    .replaceAll("\\", "/");
}

// ===== seeded-transcript helpers (projection + MCP sections) =====

function jl(obj) { return JSON.stringify(obj) + "\n"; }

function writeTranscript(runDir, runId, lines) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, `${runId}.jsonl`), lines.join(""), "utf8");
}

function makeGitRepo(dir) {
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# t\n", "utf8");
  execSync("git add README.md", { cwd: dir, stdio: "ignore" });
  execSync("git commit -m init", { cwd: dir, stdio: "ignore" });
}

const BASE_COMMIT = "a".repeat(40);

// A terminal delivery-requested run whose ONLY delivery-relevant fact is one
// safe run-bound isolation violation. `violationExtra` carries the additive
// M12-14 fields under test (reason, or a malformed value).
function seedIsolationRun({ runDir, runId = "run_x", cwd = "/w", violationExtra = {} }) {
  writeTranscript(runDir, runId, [
    jl({ type: "run.started", backend: "claude-code", cwd, worktreePath: "/w/.wao-worktrees/run_x", worktreeBranch: `wao/${runId}`, delivery: { mode: "git_commit_v1", baseCommit: BASE_COMMIT, allowedPaths: ["src"], verificationCommands: ["npm test"] }, runId, agentId: "coder_low", seq: 1 }),
    jl({ type: "run.background_submitted", cwd, deliveryRequested: true, runId, agentId: "coder_low", seq: 2 }),
    jl({ type: "run.state_change", from: "running", to: "failed", reason: "workdir_escape", runId, agentId: "coder_low", seq: 3 }),
    jl({ type: "run.isolation_violation", code: "workdir_escape", eventKind: "write_intent", runId, agentId: "coder_low", seq: 4, ...violationExtra }),
  ]);
}

// =====================================================================
// Section R — the frozen closed-set reason SSOT
// =====================================================================

test("M12-14-R1: ISOLATION_VIOLATION_REASONS is frozen and covers the milestone minimum", () => {
  assert.ok(Object.isFrozen(ISOLATION_VIOLATION_REASONS), "reason set is frozen");
  for (const reason of MINIMUM_REASONS) {
    assert.ok(ISOLATION_VIOLATION_REASONS.includes(reason), `missing minimum reason: ${reason}`);
  }
});

test("M12-14-R2: every reason is a bounded write_intent_/file_written_ wire-safe token", () => {
  for (const reason of ISOLATION_VIOLATION_REASONS) {
    assert.match(reason, /^(write_intent|file_written)_[a-z0-9_]+$/, `bounded shape: ${reason}`);
    assert.ok(reason.length <= 48, `bounded length: ${reason}`);
  }
});

// =====================================================================
// Section W — runManager persists the closed-set reason (write side)
// =====================================================================

test("M12-14-W1: write_intent lexical outside persists write_intent_lexical_outside", async () => {
  const fixture = await makeFixture();
  const outside = join(fixture.root, "outside-w1", "escaped-intent.js");
  fixture.setEvents(async function* events() {
    yield { kind: "write_intent", path: outside, toolCallId: "w1_intent", correlationStatus: "tracked" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assert.equal(fixture.run.state, "failed");
    assert.equal(output.result.isolationViolation, true);
    assertViolationFact(output.events, {
      eventKind: "write_intent",
      reason: "write_intent_lexical_outside",
    });
    assert.ok(!output.rawTranscript.includes("outside-w1"), "rejected raw path is never persisted");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-14-W2: write_intent through an outside junction ancestor persists write_intent_physical_outside", async (t) => {
  const fixture = await makeFixture();
  const outside = join(fixture.root, "outside-w2");
  await mkdir(outside, { recursive: true });
  const linked = join(fixture.effectiveCwd, "linked-w2");
  if (!await createJunctionOrSkip(t, outside, linked)) {
    await rm(fixture.root, { recursive: true, force: true });
    return;
  }
  fixture.setEvents(async function* events() {
    yield { kind: "write_intent", path: join("linked-w2", "new.js"), toolCallId: "w2_intent", correlationStatus: "tracked" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "write_intent",
      reason: "write_intent_physical_outside",
    });
    assert.ok(!output.rawTranscript.includes("outside-w2"), "rejected raw path is never persisted");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-14-W3: write_intent with an unresolvable physical path persists write_intent_physical_unresolved", async () => {
  const fixture = await makeFixture();
  fixture.setEvents(async function* events() {
    // Lexically inside, but lstat fails with a non-ENOENT error (NUL byte) —
    // the physical target can neither be resolved nor ancestor-proven.
    yield { kind: "write_intent", path: "invalid\0path.js", toolCallId: "w3_intent", correlationStatus: "tracked" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "write_intent",
      reason: "write_intent_physical_unresolved",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-14-W4: write_intent missing a tool call id persists write_intent_missing_tool_call_id", async () => {
  const fixture = await makeFixture();
  fixture.setEvents(async function* events() {
    yield { kind: "write_intent", path: join("src", "x.js"), toolCallId: "unknown", correlationStatus: "missing_tool_call_id" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "write_intent",
      reason: "write_intent_missing_tool_call_id",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-14-W5: write_intent reusing an open tool call id persists write_intent_duplicate_tool_call_id", async () => {
  const fixture = await makeFixture();
  fixture.setEvents(async function* events() {
    yield { kind: "write_intent", path: join("src", "first.js"), toolCallId: "w5_dup", correlationStatus: "tracked" };
    yield { kind: "write_intent", path: join("src", "second.js"), toolCallId: "w5_dup", correlationStatus: "tracked" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "write_intent",
      reason: "write_intent_duplicate_tool_call_id",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-14-W6: pending write-intent cap persists write_intent_pending_limit", async () => {
  const fixture = await makeFixture();
  fixture.setEvents(async function* events() {
    for (let i = 0; i < 257; i += 1) {
      yield { kind: "write_intent", path: join("src", `f${i}.js`), toolCallId: `w6_cap_${i}`, correlationStatus: "tracked" };
    }
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "write_intent",
      reason: "write_intent_pending_limit",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-14-W7: a tracked write still pending at completion persists write_intent_pending_at_completion", async () => {
  const fixture = await makeFixture();
  fixture.setEvents(async function* events() {
    yield { kind: "write_intent", path: join("src", "pending.js"), toolCallId: "w7_pending", correlationStatus: "tracked" };
    yield { kind: "tool_result", tool: "w7_pending", output: "ok", isError: false };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "write_intent",
      reason: "write_intent_pending_at_completion",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-14-W8: an unrecognized correlation status persists write_intent_correlation_unconfirmed", async () => {
  const fixture = await makeFixture();
  fixture.setEvents(async function* events() {
    // Fail closed with a truthful reason when the parser emits a correlation
    // status the control plane does not recognize.
    yield { kind: "write_intent", path: join("src", "x.js"), toolCallId: "w8_unknown", correlationStatus: "some_future_status" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "write_intent",
      reason: "write_intent_correlation_unconfirmed",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-14-W9: file_written lexical outside persists file_written_lexical_outside", async () => {
  const fixture = await makeFixture();
  const outside = join(fixture.root, "outside-w9", "escaped-written.js");
  await createFile(outside);
  fixture.setEvents(async function* events() {
    yield { kind: "file_written", path: outside };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_lexical_outside",
    });
    assert.ok(!output.rawTranscript.includes("outside-w9"), "rejected raw path is never persisted");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-14-W10: file_written through an outside junction persists file_written_physical_outside", async (t) => {
  const fixture = await makeFixture();
  const outside = join(fixture.root, "outside-w10");
  await mkdir(outside, { recursive: true });
  await createFile(join(outside, "escaped.js"));
  const linked = join(fixture.effectiveCwd, "linked-w10");
  if (!await createJunctionOrSkip(t, outside, linked)) {
    await rm(fixture.root, { recursive: true, force: true });
    return;
  }
  fixture.setEvents(async function* events() {
    yield { kind: "file_written", path: join("linked-w10", "escaped.js") };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_physical_outside",
    });
    assert.ok(!output.rawTranscript.includes("outside-w10"), "rejected raw path is never persisted");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-14-W11: file_written whose target cannot be resolved persists file_written_physical_unresolved", async () => {
  const fixture = await makeFixture();
  fixture.setEvents(async function* events() {
    // Lexically inside, but the reported target was never materialized —
    // realpath cannot prove its physical location (post-write evidence fails
    // closed for delivery runs).
    yield { kind: "file_written", path: join("src", "never-created.js") };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_physical_unresolved",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

// =====================================================================
// Section M — win32-only MSYS (Git-Bash) drive-path normalization
// =====================================================================
//
// The mainline bug: Claude under Git-Bash reports the in-worktree target as
// "/d/.../delivery-worktree/src/a.js". Without normalization, win32 resolve()
// treats that as a rooted path on the worktree's drive (<drive>:\d\...) — always
// OUTSIDE the worktree — so an honest in-worktree write was falsely
// terminalized as workdir_escape. Normalization maps ONLY the anchored drive
// pattern /^\/([A-Za-z])(\/|$)/ to its drive-root equivalent before lexical
// containment; arbitrary slash paths are never widened.

test("M12-14-M1: in-worktree MSYS write_intent with a missing target passes containment", async (t) => {
  if (!WIN32) { t.skip("MSYS normalization is win32-only"); return; }
  const fixture = await makeFixture();
  const msysTarget = toMsysDrivePath(join(fixture.effectiveCwd, "src", "msys-intent.js"));
  fixture.setEvents(async function* events() {
    yield { kind: "write_intent", path: msysTarget, toolCallId: "m1_intent", correlationStatus: "tracked" };
    yield { kind: "tool_result", tool: "m1_intent", output: "denied", isError: true };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 1, "in-worktree /d/... intent must reach packaging");
    assert.ok(!output.events.some((event) => event.type === "run.isolation_violation"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-14-M2: in-worktree MSYS file_written passes containment", async (t) => {
  if (!WIN32) { t.skip("MSYS normalization is win32-only"); return; }
  const fixture = await makeFixture();
  const nativeTarget = join(fixture.effectiveCwd, "src", "msys-written.js");
  await createFile(nativeTarget);
  const msysTarget = toMsysDrivePath(nativeTarget);
  fixture.setEvents(async function* events() {
    yield { kind: "file_written", path: msysTarget, toolCallId: "m2_written" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 1, "in-worktree /d/... file_written must reach packaging");
    assert.ok(!output.events.some((event) => event.type === "run.isolation_violation"));
    assert.ok(output.events.some(
      (event) => event.type === "run.event" && event.kind === "file_written" && event.path === msysTarget,
    ), "the accepted event is persisted verbatim (containment ran on the normalized form)");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-14-M3: outside MSYS write_intent stays rejected as lexical outside", async (t) => {
  if (!WIN32) { t.skip("MSYS normalization is win32-only"); return; }
  const fixture = await makeFixture();
  const msysOutside = toMsysDrivePath(join(fixture.root, "outside-m3", "escaped-intent.js"));
  fixture.setEvents(async function* events() {
    yield { kind: "write_intent", path: msysOutside, toolCallId: "m3_intent", correlationStatus: "tracked" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0, "an outside /d/... path must still be rejected");
    assertViolationFact(output.events, {
      eventKind: "write_intent",
      reason: "write_intent_lexical_outside",
    });
    assert.ok(!output.rawTranscript.includes("outside-m3"), "rejected raw path is never persisted");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-14-M4: outside MSYS file_written stays rejected as lexical outside", async (t) => {
  if (!WIN32) { t.skip("MSYS normalization is win32-only"); return; }
  const fixture = await makeFixture();
  const outside = join(fixture.root, "outside-m4", "escaped-written.js");
  await createFile(outside);
  const msysOutside = toMsysDrivePath(outside);
  fixture.setEvents(async function* events() {
    yield { kind: "file_written", path: msysOutside };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0, "an outside /d/... path must still be rejected");
    assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_lexical_outside",
    });
    assert.ok(!output.rawTranscript.includes("outside-m4"), "rejected raw path is never persisted");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-14-M5: non-drive absolute slash paths are not widened", async (t) => {
  if (!WIN32) { t.skip("MSYS normalization is win32-only"); return; }
  for (const [label, reported] of [
    ["posix absolute", "/tmp/m1214-non-drive-escape.js"],
    ["double-slash", "//d/m1214-double-slash-escape.js"],
    ["drive root only", "/d"],
  ]) {
    const fixture = await makeFixture({ runId: `run_m1214_m5_${label.replaceAll(/[^a-z0-9]/gi, "_")}` });
    fixture.setEvents(async function* events() {
      yield { kind: "file_written", path: reported };
      yield { kind: "done", reason: "completed" };
    });
    try {
      const output = await finishFixture(fixture);
      assert.equal(fixture.getPackageCount(), 0, `${label} must not be widened into the worktree`);
      assertViolationFact(output.events, {
        eventKind: "file_written",
        reason: "file_written_lexical_outside",
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("M12-14-M6: uppercase MSYS drive letter normalizes too", async (t) => {
  if (!WIN32) { t.skip("MSYS normalization is win32-only"); return; }
  const fixture = await makeFixture();
  const nativeTarget = join(fixture.effectiveCwd, "src", "msys-upper.js");
  await createFile(nativeTarget);
  const upper = toMsysDrivePath(nativeTarget).replace(/^\/([a-z])\//, (m, d) => `/${d.toUpperCase()}/`);
  fixture.setEvents(async function* events() {
    yield { kind: "file_written", path: upper, toolCallId: "m6_written" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 1, "uppercase /D/... in-worktree path must pass");
    assert.ok(!output.events.some((event) => event.type === "run.isolation_violation"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

// =====================================================================
// Section D — diagnosis fact wording (truth per reason; no "outside" claim
// for correlation/unresolved failures; historical events never invent it)
// =====================================================================

function diagnoseIsolation(extra) {
  const events = [{
    type: "run.isolation_violation",
    runId: "run_d",
    code: "workdir_escape",
    eventKind: "write_intent",
    ...extra,
  }];
  return diagnoseFailure(events, "run_d");
}

test("M12-14-D1: correlation/unresolved reasons never claim outside in the diagnosis fact", () => {
  for (const reason of ISOLATION_VIOLATION_REASONS) {
    const d = diagnoseIsolation({ reason });
    assert.equal(d.category, "workdir_escape", `${reason} keeps the compat category`);
    assert.equal(d.code, null, "provider code stays null for workdir_escape");
    assert.equal(d.evidence.length, 1);
    assert.equal(d.evidence[0].eventType, "run.isolation_violation");
    if (/lexical_outside|physical_outside/.test(reason)) {
      assert.match(d.evidence[0].fact, /outside/i, `${reason} may truthfully say outside`);
    } else {
      assert.ok(!/outside/i.test(d.evidence[0].fact), `${reason} must NOT claim outside`);
    }
  }
});

test("M12-14-D2: historical reason-absent violation projects a generic fact without inventing outside", () => {
  const d = diagnoseIsolation({});
  assert.equal(d.category, "workdir_escape", "code=workdir_escape is preserved for historical events");
  assert.equal(d.evidence.length, 1);
  assert.ok(!/outside/i.test(d.evidence[0].fact), "no outside claim without a trusted reason");
});

test("M12-14-D3: malformed/unknown reason projects the generic fact and never echoes the raw value", () => {
  for (const bad of [42, null, "OTHER", "C:\\evil\\escaped.js", "file_written_lexical_outside "]) {
    const d = diagnoseIsolation({ reason: bad });
    assert.equal(d.category, "workdir_escape");
    assert.ok(!/outside/i.test(d.evidence[0].fact), `malformed reason ${JSON.stringify(bad)} must not invent outside`);
    if (typeof bad === "string") {
      assert.ok(!d.evidence[0].fact.includes(bad), "the raw malformed reason is never echoed");
    }
  }
});

// =====================================================================
// Section P — application projections (runDelivery / runAwaitResult)
// =====================================================================

test("M12-14-P1: projectIsolationViolation returns {code,reason} | ambiguous | null", () => {
  const base = { type: "run.isolation_violation", runId: "r", code: "workdir_escape", eventKind: "write_intent" };
  // Zero bound violations → null.
  assert.equal(projectIsolationViolation([], "r"), null);
  assert.equal(projectIsolationViolation("garbage", "r"), null);
  // Valid code + valid reason → both.
  assert.deepEqual(
    projectIsolationViolation([{ ...base, reason: "write_intent_pending_limit" }], "r"),
    { code: "workdir_escape", reason: "write_intent_pending_limit" },
  );
  // Valid code + absent reason → reason null (historical), NOT ambiguous.
  assert.deepEqual(projectIsolationViolation([base], "r"), { code: "workdir_escape", reason: null });
  // Valid code + malformed reasons → reason null, never upgraded.
  for (const bad of [42, null, "OTHER", "write_intent_lexical_outside "]) {
    assert.deepEqual(
      projectIsolationViolation([{ ...base, reason: bad }], "r"),
      { code: "workdir_escape", reason: null },
      `malformed reason ${JSON.stringify(bad)} projects null`,
    );
  }
  // Malformed code / multiple bound violations → ambiguous (unchanged M12-13 rule).
  assert.equal(projectIsolationViolation([{ ...base, code: "OTHER" }], "r"), "ambiguous");
  assert.equal(projectIsolationViolation([base, base], "r"), "ambiguous");
  // Cross-run violations are not evidence.
  assert.equal(projectIsolationViolation([{ ...base, runId: "other" }], "r"), null);
});

test("M12-14-P2: gatherDeliveryView surfaces isolationFailure {code, reason}", () => {
  const mk = (extra) => [
    { type: "run.started", runId: "r", delivery: { mode: "git_commit_v1" } },
    { type: "run.state_change", runId: "r", to: "failed" },
    { type: "run.isolation_violation", runId: "r", code: "workdir_escape", eventKind: "file_written", ...extra },
  ];
  const withReason = gatherDeliveryView(mk({ reason: "file_written_physical_unresolved" }), "r", "failed");
  assert.deepEqual(withReason.isolationFailure, {
    code: "workdir_escape",
    reason: "file_written_physical_unresolved",
  });
  assert.equal(withReason.deliveryFailure, null, "isolation settlement stays separate from packaging failure");
  const historical = gatherDeliveryView(mk({}), "r", "failed");
  assert.deepEqual(historical.isolationFailure, { code: "workdir_escape", reason: null });
  const malformed = gatherDeliveryView(mk({ reason: "C:\\evil\\escaped.js" }), "r", "failed");
  assert.deepEqual(malformed.isolationFailure, { code: "workdir_escape", reason: null });
  // Readiness is reason-agnostic: the safe code alone settles isolation_failed.
  assert.equal(projectDeliveryReadiness(mk({}), "r"), "isolation_failed");
  assert.equal(projectDeliveryReadiness(mk({ reason: 42 }), "r"), "isolation_failed");
});

test("M12-14-P3: runAwaitResult projects a top-level isolationFailureReason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1214-p3-"));
  try {
    seedIsolationRun({
      runDir: dir,
      violationExtra: { reason: "write_intent_pending_at_completion" },
    });
    const out = await runAwaitResult({ runId: "run_x", runDir: dir, waitMs: 0 });
    assert.equal(out.terminal, true);
    assert.equal(out.outcome?.delivery?.isolationFailureCode, "workdir_escape", "compat code preserved");
    assert.equal(out.isolationFailureReason, "write_intent_pending_at_completion");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-14-P4: historical/malformed reason projects isolationFailureReason null (never upgraded)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1214-p4-"));
  try {
    for (const [label, extra] of [
      ["absent", {}],
      ["unknown-value", { reason: "OTHER" }],
      ["non-string", { reason: 42 }],
    ]) {
      const runId = `run_p4_${label.replaceAll("-", "_")}`;
      seedIsolationRun({ runDir: dir, runId, violationExtra: extra });
      const out = await runAwaitResult({ runId, runDir: dir, waitMs: 0 });
      assert.equal(out.outcome?.delivery?.isolationFailureCode, "workdir_escape", `${label}: code survives`);
      assert.equal(out.isolationFailureReason, null, `${label}: reason is never upgraded`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-14-P5: no isolation failure → isolationFailureReason null; read failure → null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1214-p5-"));
  try {
    // Ordinary completed non-delivery run.
    writeTranscript(dir, "run_ok", [
      jl({ type: "run.started", backend: "claude-code", cwd: "/w", runId: "run_ok", agentId: "a", seq: 1 }),
      jl({ type: "run.state_change", from: "running", to: "completed", reason: "done", runId: "run_ok", agentId: "a", seq: 2 }),
      jl({ type: "run.completed", runId: "run_ok", agentId: "a", seq: 3 }),
    ]);
    const ok = await runAwaitResult({ runId: "run_ok", runDir: dir, waitMs: 0 });
    assert.equal(ok.isolationFailureReason, null);
    // Missing transcript → read_failure → reason unavailable (null), never invented.
    const missing = await runAwaitResult({ runId: "run_missing", runDir: dir, waitMs: 0 });
    assert.equal(missing.observationOutcome, "read_failure");
    assert.equal(missing.isolationFailureReason, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// =====================================================================
// Section MCP — wire projection through run_delivery and run_await_result
// =====================================================================

async function buildMcpClient(dir, repo, extra = {}) {
  const { createWaoMcpServer } = await import("../../src/mcp/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { getRunDelivery, getRunDeliveryReadiness } = await import("../../src/application/runDelivery.js");
  const server = createWaoMcpServer({
    registryPath: join(dir, "agents.json"),
    runDir: dir,
    workspaceRoot: repo,
    getRunDeliveryFn: async (input) => getRunDelivery({ ...input, runDir: dir }),
    getRunDeliveryReadinessFn: async (input) => getRunDeliveryReadiness({ ...input, runDir: dir }),
    runAwaitResultFn: async (input) => runAwaitResult({ ...input, runDir: dir }),
    ...extra,
  });
  const client = new Client({ name: "wao-test", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { server, client };
}

test("M12-14-MCP1: run_delivery surfaces isolationFailure {code, reason} on both paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1214-mcp1-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    makeGitRepo(repo);
    seedIsolationRun({
      runDir: dir,
      cwd: repo,
      violationExtra: { reason: "write_intent_missing_tool_call_id" },
    });
    const { server, client } = await buildMcpClient(dir, repo);
    try {
      const res = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x" } });
      assert.ok(res && !res.isError, `point-in-time must succeed: ${JSON.stringify(res)}`);
      const payload = JSON.parse(res.content[0].text);
      assert.deepEqual(payload.isolationFailure, {
        code: "workdir_escape",
        reason: "write_intent_missing_tool_call_id",
      });
      const waitRes = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x", waitMs: 1000 } });
      assert.ok(waitRes && !waitRes.isError, `wait path must succeed: ${JSON.stringify(waitRes)}`);
      const waitPayload = JSON.parse(waitRes.content[0].text);
      assert.equal(waitPayload.readiness, "isolation_failed");
      assert.deepEqual(waitPayload.isolationFailure, {
        code: "workdir_escape",
        reason: "write_intent_missing_tool_call_id",
      });
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-14-MCP2: run_delivery projects reason null for historical/malformed reasons and never leaks the raw value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1214-mcp2-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    makeGitRepo(repo);
    const rawBadReason = "C:\\evil\\m1214-leaked-escape.js";
    for (const [label, extra] of [
      ["absent", {}],
      ["malformed", { reason: rawBadReason }],
    ]) {
      const runId = `run_mcp2_${label}`;
      seedIsolationRun({ runDir: dir, runId, cwd: repo, violationExtra: extra });
      const { server, client } = await buildMcpClient(dir, repo);
      try {
        const res = await client.callTool({ name: "run_delivery", arguments: { runId } });
        assert.ok(res && !res.isError, `${label} must succeed: ${JSON.stringify(res)}`);
        const payload = JSON.parse(res.content[0].text);
        assert.deepEqual(payload.isolationFailure, { code: "workdir_escape", reason: null },
          `${label}: unknown reason is never upgraded`);
        assert.ok(!JSON.stringify(res).includes(rawBadReason), "raw malformed reason never crosses MCP");
      } finally {
        await client.close();
        await server.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-14-MCP3: run_await_result wire carries top-level isolationFailureReason (null when unknown)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1214-mcp3-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    makeGitRepo(repo);
    seedIsolationRun({
      runDir: dir,
      cwd: repo,
      violationExtra: { reason: "file_written_physical_unresolved" },
    });
    seedIsolationRun({ runDir: dir, runId: "run_hist", cwd: repo });
    const { server, client } = await buildMcpClient(dir, repo);
    try {
      const res = await client.callTool({ name: "run_await_result", arguments: { runId: "run_x", waitMs: 0 } });
      assert.ok(res && !res.isError, `must succeed: ${JSON.stringify(res)}`);
      const payload = JSON.parse(res.content[0].text);
      assert.equal(payload.outcome.delivery.isolationFailureCode, "workdir_escape", "compat code preserved");
      assert.equal(payload.isolationFailureReason, "file_written_physical_unresolved");
      const hist = await client.callTool({ name: "run_await_result", arguments: { runId: "run_hist", waitMs: 0 } });
      const histPayload = JSON.parse(hist.content[0].text);
      assert.equal(histPayload.outcome.delivery.isolationFailureCode, "workdir_escape");
      assert.equal(histPayload.isolationFailureReason, null, "historical reason-absent event stays unknown");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
