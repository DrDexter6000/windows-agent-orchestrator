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
//     raw path. TD-336 exception: a physical_unresolved reason also carries the
//     workspace-relative reported path — but ONLY when the raw reported path
//     contains nothing redactable (redaction is a literal substitution and
//     resolve() normalization can rewrite or stitch secret literals; layer 1
//     withholds, layer 2 still redacts the relative form), and never the
//     absolute form. The raw last-failure code rides as observedErrorCode, only
//     when the closed set reduced it to "other".
//   - TD-336: every physical_unresolved verdict — any error code or none — is
//     retried with the whole classification re-run (25/100/250 ms) before it
//     goes final; no code whitelist decides finality from one observation.
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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { execSync } from "node:child_process";

import { diagnoseFailure, ISOLATION_VIOLATION_REASONS, ISOLATION_PHYSICAL_ERROR_CODES, ISOLATION_DESTINATIONS } from "../../src/diagnosis.js";
import {
  gatherDeliveryView,
  projectDeliveryReadiness,
  projectIsolationViolation,
} from "../../src/application/runDelivery.js";
import { runAwaitResult } from "../../src/application/runAwaitResult.js";
import {
  Run,
  classifyReportedWriteContainment,
  classifyReportedWriteIntentContainment,
  classifyIsolationDestination,
  readIsolationDestinationRoots,
  isTd372RelaxableConfirmation,
  hasNonCanonicalWindowsSegment,
} from "../../src/runManager.js";
import { listWorktreePaths, LIST_WORKTREE_PATHS_TIMEOUT_MS } from "../../src/isolation.js";
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

async function makeFixture({ delivery = true, runId = "run_m1214_reason", redact, isolationRootsFn, containmentDeps } = {}) {
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
    // TD-336: the injected redactor rides the same seam the run uses to redact
    // the persisted violation path (Run reads handle.redact first).
    ...(redact ? { redact } : {}),
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
    ...(isolationRootsFn ? { isolationRootsFn } : {}),
    ...(containmentDeps ? { containmentDeps } : {}),
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

async function createFileLinkOrSkip(t, target, path) {
  try {
    await symlink(target, path, "file");
    return true;
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip(`file symlink creation denied by platform: ${error.code}`);
      return false;
    }
    throw error;
  }
}

// Assert the durable violation fact carries EXACTLY the safe closed-set fields
// (plus transcript envelope) and never an ungated absolute raw path.
// `errorCode` is expected only for the physical_unresolved reasons that carry
// it; passing it pins both its value and its presence, and omitting it keeps
// the assertion that no errorCode key was persisted at all. Same pinning rule
// for the TD-336 extras: `path` (workspace-relative, redacted) and
// `observedErrorCode` (raw last-failure code) are pinned when passed and
// asserted ABSENT when omitted.
//
// TD-373: for a confirmed-outside reason the fact additionally carries
// `destination` (closed set) and the redacted `reportedPath`; `resolvedPath`
// may be withheld by the TD-336 layer-1 rule, and `escapedAt` is physical-only
// and best-effort. `outside` pins the values that the caller knows must exist.
function assertViolationFact(events, {
  eventKind,
  reason,
  errorCode,
  path,
  observedErrorCode,
  outside,
}) {
  const violation = events.find((event) => event.type === "run.isolation_violation");
  assert.ok(violation, "a run.isolation_violation fact is persisted");
  assert.equal(violation.code, "workdir_escape", "code stays workdir_escape (compat)");
  assert.equal(violation.eventKind, eventKind);
  assert.equal(violation.reason, reason);
  if (errorCode !== undefined) assert.equal(violation.errorCode, errorCode);
  if (path !== undefined) assert.equal(violation.path, path);
  if (observedErrorCode !== undefined) assert.equal(violation.observedErrorCode, observedErrorCode);
  const outsideReason = typeof reason === "string"
    && (reason.endsWith("_lexical_outside") || reason.endsWith("_physical_outside"));
  if (outsideReason) {
    assert.ok(ISOLATION_DESTINATIONS.includes(violation.destination),
      `destination is a closed-set member: ${violation.destination}`);
    if (Object.hasOwn(violation, "reportedPath")) assert.equal(typeof violation.reportedPath, "string");
    if (Object.hasOwn(violation, "resolvedPath")) assert.equal(typeof violation.resolvedPath, "string");
    if (Object.hasOwn(violation, "escapedAt")) assert.equal(typeof violation.escapedAt, "string");
  } else {
    for (const key of ["destination", "reportedPath", "resolvedPath", "escapedAt"]) {
      assert.ok(!Object.hasOwn(violation, key), `${reason} never carries TD-373 field ${key}`);
    }
  }
  if (outside) {
    assert.equal(violation.destination, outside.destination);
    if (outside.reportedPath !== undefined) assert.equal(violation.reportedPath, outside.reportedPath);
    if (outside.reportedPathContains !== undefined) {
      assert.ok(violation.reportedPath.includes(outside.reportedPathContains));
    }
    if (outside.resolvedPath !== undefined) assert.equal(violation.resolvedPath, outside.resolvedPath);
    if (outside.resolvedPathContains !== undefined) {
      assert.ok(violation.resolvedPath.includes(outside.resolvedPathContains));
    }
    if (outside.resolvedPathAbsent === true) assert.ok(!Object.hasOwn(violation, "resolvedPath"));
    if (outside.escapedAt !== undefined) assert.equal(violation.escapedAt, outside.escapedAt);
    if (outside.escapedAtAbsent === true) assert.ok(!Object.hasOwn(violation, "escapedAt"));
  }
  const expectedKeys = ["agentId", "code", "eventKind", "reason", "runId", "seq", "ts", "type"];
  if (errorCode !== undefined) expectedKeys.push("errorCode");
  if (path !== undefined) expectedKeys.push("path");
  if (observedErrorCode !== undefined) expectedKeys.push("observedErrorCode");
  if (outsideReason) {
    expectedKeys.push("destination");
    for (const key of ["reportedPath", "resolvedPath", "escapedAt"]) {
      if (Object.hasOwn(violation, key)) expectedKeys.push(key);
    }
  }
  assert.deepEqual(
    Object.keys(violation).sort(),
    expectedKeys.sort(),
    "only closed-set code/eventKind/reason plus the gated extras and the transcript envelope are persisted",
  );
  return violation;
}

// D:\foo\bar → /d/foo/bar (the input shape a Git-Bash/MSYS worker reports).
function toMsysDrivePath(nativePath) {
  return nativePath
    .replace(/^([A-Za-z]):[\\/]/, (m, d) => `/${d.toLowerCase()}/`)
    .replaceAll("\\", "/");
}

// Test-side mirror of the documented display rule for native absolute paths:
// a leading user-home prefix becomes "~" (win32 case-insensitive).
function tildeNative(nativePath) {
  const value = String(nativePath);
  const home = resolve(homedir());
  const insensitive = process.platform === "win32";
  const left = insensitive ? value.toLowerCase() : value;
  const right = insensitive ? home.toLowerCase() : home;
  if (left === right) return "~";
  if (left.startsWith(`${right}${sep}`) || left.startsWith(`${right}/`)) {
    return `~${value.slice(home.length)}`;
  }
  return value;
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

function assertPathOnlyOnViolationLine(rawTranscript, marker) {
  const lines = rawTranscript.split(/\r?\n/).filter((line) => line.length > 0);
  const hits = lines.filter((line) => line.includes(marker));
  assert.ok(hits.length >= 1, `the redacted path marker appears somewhere: ${marker}`);
  for (const line of lines) {
    if (line.includes(marker)) {
      assert.ok(line.includes("run.isolation_violation"),
        "the outside path appears only on the run.isolation_violation line");
    }
  }
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

test("M12-14-R3: ISOLATION_PHYSICAL_ERROR_CODES is the frozen closed set of recordable codes", () => {
  assert.ok(Object.isFrozen(ISOLATION_PHYSICAL_ERROR_CODES), "error-code set is frozen");
  assert.deepEqual([...ISOLATION_PHYSICAL_ERROR_CODES], [
    "EBUSY", "EPERM", "EACCES", "ENOENT", "ELOOP", "ENOTDIR", "EINVAL", "ENAMETOOLONG", "EIO", "other",
  ]);
  for (const code of ISOLATION_PHYSICAL_ERROR_CODES) {
    assert.match(code, /^([A-Z][A-Z0-9]*|other)$/, `bounded wire-safe token: ${code}`);
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
      outside: {
        destination: "temp",
        reportedPathContains: "outside-w1",
        resolvedPathContains: "outside-w1",
        escapedAtAbsent: true,
      },
    });
    assertPathOnlyOnViolationLine(output.rawTranscript, "outside-w1");
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
      outside: {
        destination: "temp",
        reportedPath: join("linked-w2", "new.js"),
        resolvedPath: tildeNative(join(resolve(outside), "new.js")),
        escapedAt: "linked-w2",
      },
    });
    assertPathOnlyOnViolationLine(output.rawTranscript, "outside-w2");
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
    // The NUL-byte error is not a real filesystem code: the retries run out,
    // the code is recorded as the closed-set "other" and the raw host code
    // rides along as observedErrorCode (TD-336), next to the workspace-
    // relative path of the reported target.
    assertViolationFact(output.events, {
      eventKind: "write_intent",
      reason: "write_intent_physical_unresolved",
      errorCode: "other",
      path: "invalid\0path.js",
      observedErrorCode: "ERR_INVALID_ARG_VALUE",
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
      outside: {
        destination: "temp",
        reportedPathContains: "outside-w9",
        resolvedPathContains: "outside-w9",
        escapedAtAbsent: true,
      },
    });
    assertPathOnlyOnViolationLine(output.rawTranscript, "outside-w9");
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
      outside: {
        destination: "temp",
        reportedPath: join("linked-w10", "escaped.js"),
        resolvedPath: tildeNative(join(resolve(outside), "escaped.js")),
        escapedAt: "linked-w10",
      },
    });
    assertPathOnlyOnViolationLine(output.rawTranscript, "outside-w10");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-14-W11: file_written whose target cannot be resolved persists file_written_physical_unresolved", async () => {
  const fixture = await makeFixture();
  fixture.setEvents(async function* events() {
    // Lexically inside, but the reported target was never materialized —
    // realpath cannot prove its physical location (post-write evidence fails
    // closed for delivery runs) and the recorded ENOENT survives the retries.
    yield { kind: "file_written", path: join("src", "never-created.js") };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_physical_unresolved",
      errorCode: "ENOENT",
      path: join("src", "never-created.js").split(sep).join("/"),
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-14-W12: write_intent on an in-worktree dangling junction fails closed with errorCode ENOENT", async (t) => {
  const fixture = await makeFixture({ runId: "run_m1214_w12" });
  const link = join(fixture.effectiveCwd, "dangling-w12");
  try {
    // Junction on win32, dangling symlink elsewhere: the link itself exists
    // (lstat succeeds) but its target does not, so realpath can never prove
    // where the reported write would land.
    await symlink(join(fixture.root, "missing-w12-target"), link, "junction");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip(`dangling link creation denied by platform: ${error.code}`);
      await rm(fixture.root, { recursive: true, force: true });
      return;
    }
    throw error;
  }
  fixture.setEvents(async function* events() {
    yield { kind: "write_intent", path: link, toolCallId: "w12_intent", correlationStatus: "tracked" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assert.equal(fixture.run.state, "failed");
    assert.equal(output.result.isolationViolation, true);
    // The transient-error retries ran out; the last observed filesystem error
    // is on the durable fact, in the closed set. TD-336: the persisted path is
    // the workspace-relative reported target — the dangling link's name — not
    // the absolute raw path. ENOENT is a closed-set member, so no raw
    // observedErrorCode rides along.
    assertViolationFact(output.events, {
      eventKind: "write_intent",
      reason: "write_intent_physical_unresolved",
      errorCode: "ENOENT",
      path: "dangling-w12",
    });
    assert.ok(
      !output.rawTranscript.includes("delivery-worktree"),
      "no absolute form of the rejected path ever reaches the transcript",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-14-W13: a redactable raw path means the fact carries no path at all", async () => {
  const marker = "unresolved-target-marker";
  const fixture = await makeFixture({
    redact: (value) => (typeof value === "string"
      ? value.replaceAll(marker, "REDACTED-TARGET")
      : value),
  });
  fixture.setEvents(async function* events() {
    // Lexically inside, never materialized: physically unresolved. The raw
    // reported path contains a redactable marker word, so the persisted
    // relative path would no longer match the redactor's literal substitution
    // after resolve() normalization — layer 1 withholds the path entirely
    // (errorCode stays; no path key is persisted).
    yield { kind: "file_written", path: join("src", `${marker}.js`) };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_physical_unresolved",
      errorCode: "ENOENT",
    });
    assert.ok(
      !output.rawTranscript.includes(marker),
      "the raw marker word never reaches the transcript",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-14-W14: a marker containing // is withheld before normalization can launder it", async () => {
  const fixture = await makeFixture({
    redact: (value) => (typeof value === "string"
      ? value.replaceAll("mark//er", "REDACTED-SLASH")
      : value),
  });
  fixture.setEvents(async function* events() {
    // resolve() folds the double slash into a single one, so the normalized
    // path ("mark/er") would no longer match the redactor's literal
    // "mark//er" substitution — layer 1 sees the raw path IS redactable and
    // withholds the relative path instead of persisting a laundered form.
    yield { kind: "file_written", path: "src/mark//er.js" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_physical_unresolved",
      errorCode: "ENOENT",
    });
    assert.ok(!output.rawTranscript.includes("mark//er"), "the raw double-slash marker never reaches the transcript");
    assert.ok(!output.rawTranscript.includes("mark/er"), "the folded single-slash form never reaches it either");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-14-W15: normalization can STITCH a secret literal, so the persisted relative path is still redacted", async () => {
  const fixture = await makeFixture({
    redact: (value) => (typeof value === "string"
      ? value.replaceAll("mark/er", "REDACTED-NORM")
      : value),
  });
  fixture.setEvents(async function* events() {
    // The raw path contains no "mark/er" literal (only "mark//er"), so layer 1
    // passes it through — and resolve() then folds the double slash into
    // exactly the redactable "mark/er" text. Layer 2 redacts the relative form
    // before it lands on the durable fact.
    yield { kind: "file_written", path: "src/mark//er.js" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_physical_unresolved",
      errorCode: "ENOENT",
      path: "src/REDACTED-NORM.js",
    });
    assert.ok(!output.rawTranscript.includes("mark/er"), "the stitched literal never reaches the transcript");
    assert.ok(!output.rawTranscript.includes("mark//er"), "nor does the raw double-slash form");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("M12-14-W16: the write_intent branch also withholds the path when the raw path is redactable", async () => {
  const fixture = await makeFixture({
    redact: (value) => (typeof value === "string"
      ? value.replaceAll("mark//er", "REDACTED-SLASH")
      : value),
  });
  fixture.setEvents(async function* events() {
    // W14's laundering shape on the write_intent branch: the NUL byte makes
    // lstat fail with a non-ENOENT error, so the intent stays physically
    // unresolved and the classifier offers the folded "mark/er" relative
    // path; layer 1 must withhold it because the raw path is redactable.
    yield { kind: "write_intent", path: "src/mark//er\0.js", toolCallId: "w16_intent", correlationStatus: "tracked" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "write_intent",
      reason: "write_intent_physical_unresolved",
      errorCode: "other",
      observedErrorCode: "ERR_INVALID_ARG_VALUE",
    });
    assert.ok(!output.rawTranscript.includes("mark//er"), "the raw double-slash marker never reaches the transcript");
    assert.ok(!output.rawTranscript.includes("mark/er"), "the folded single-slash form never reaches it either");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

// =====================================================================
// Section L — TD-357: unresolved post-write targets fail closed
// =====================================================================
//
// The batch's containment fix is on the parser side only (a codex file_change
// whose status is not "completed" is no longer reported as file_written). The
// post-write classifier itself is unchanged: when realpath cannot prove the
// reported target's physical location, the verdict stays physical_unresolved
// and the run fails. These regressions pin that fail-closed behavior for the
// shapes the incident and later reviews brought up (dangling links, outside
// junctions, junctions removed after the write went through).

async function classifierLandingFixture() {
  const root = await mkdtemp(join(tmpdir(), "wao-m1214-landed-"));
  const base = join(root, "delivery-worktree");
  await mkdir(base, { recursive: true });
  return { root, base };
}

// The retry waits are irrelevant to these verdict tests (every shape here is
// unresolved on each attempt); skip the wall-clock cost.
const NO_SLEEP = { sleep: async () => {} };

test("TD-357-L3: a dangling link at the leaf still fails closed (physical_unresolved)", async (t) => {
  const fixture = await classifierLandingFixture();
  try {
    const link = join(fixture.base, "src", "dangling-file.js");
    await mkdir(dirname(link), { recursive: true });
    if (!await createJunctionOrSkip(t, join(fixture.root, "missing-l3-target"), link)) return;
    const result = await classifyReportedWriteContainment(
      join("src", "dangling-file.js"), fixture.base, NO_SLEEP,
    );
    assert.deepEqual(result, {
      verdict: "physical_unresolved",
      errorCode: "ENOENT",
      path: "src/dangling-file.js",
      unresolvedAt: "target",
    }, "an unresolvable target fails closed");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TD-357-L4: a missing leaf under an outside junction fails closed (physical_unresolved)", async (t) => {
  const fixture = await classifierLandingFixture();
  try {
    const outside = join(fixture.root, "outside-l4");
    await mkdir(outside, { recursive: true });
    if (!await createJunctionOrSkip(t, outside, join(fixture.base, "linked-l4"))) return;
    const result = await classifyReportedWriteContainment(
      join("linked-l4", "missing.js"), fixture.base, NO_SLEEP,
    );
    // The leaf itself cannot be resolved, so the verdict is unresolved even
    // though the junction parent points outside: fail closed, never "inside".
    assert.equal(result.verdict, "physical_unresolved");
    assert.equal(result.errorCode, "ENOENT");
    assert.equal(result.path, "linked-l4/missing.js");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TD-357-L5: a missing leaf under a dangling directory link still fails closed", async (t) => {
  const fixture = await classifierLandingFixture();
  try {
    const link = join(fixture.base, "dangling-dir");
    if (!await createJunctionOrSkip(t, join(fixture.root, "missing-l5-target"), link)) return;
    const result = await classifyReportedWriteContainment(
      join("dangling-dir", "missing.js"), fixture.base, NO_SLEEP,
    );
    assert.equal(result.verdict, "physical_unresolved");
    assert.equal(result.errorCode, "ENOENT");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TD-357-L6: a non-ENOENT failure at the leaf still fails closed", async () => {
  const fixture = await classifierLandingFixture();
  try {
    // A NUL byte makes the filesystem call fail with a non-ENOENT error; the
    // verdict stays physical_unresolved.
    const result = await classifyReportedWriteContainment(
      "src/invalid\0path.js", fixture.base, NO_SLEEP,
    );
    assert.equal(result.verdict, "physical_unresolved");
    assert.equal(result.errorCode, "other");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TD-357-L8 (sol scenario): in-tree junction → write through it → junction removed → physical_unresolved", async (t) => {
  const fixture = await classifierLandingFixture();
  try {
    // A worker mistakes the in-tree junction for an independent copy and writes
    // a test config through it; the test script then removes the junction by
    // routine cleanup before the transcript is classified. The outside file
    // survives and the reported leaf no longer resolves — the classifier must
    // fail closed, never pass it as an in-tree write.
    const outside = join(fixture.root, "outside-l8");
    await mkdir(outside, { recursive: true });
    const link = join(fixture.base, "shared-fixtures");
    if (!await createJunctionOrSkip(t, outside, link)) return;
    await writeFile(join(link, "wao-test-config.json"), "{\"fixture\":true}\n", "utf8");
    await rm(link, { recursive: true, force: true });

    const result = await classifyReportedWriteContainment(
      join("shared-fixtures", "wao-test-config.json"), fixture.base, NO_SLEEP,
    );
    assert.equal(result.verdict, "physical_unresolved", "the target no longer resolves: fail closed");
    assert.equal(result.errorCode, "ENOENT");
    assert.equal(result.path, "shared-fixtures/wao-test-config.json");
    assert.equal(
      await readFile(join(outside, "wao-test-config.json"), "utf8"),
      "{\"fixture\":true}\n",
      "the write really landed outside the worktree",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

// =====================================================================
// Section TD-372 — post-write leaf ENOENT with an inside intent
// =====================================================================
//
// A deepseek-acp worker wrote an in-worktree file with its write tool and then
// removed it; the post-write realpath got ENOENT and three retries ended the
// run as file_written_physical_unresolved. The classifier stays strict (the
// leaf-missing verdict is unchanged); only the delivery violation classifier
// relaxes THIS shape: physical_unresolved + ENOENT + the same toolCallId had a
// write_intent that was classified INSIDE at intent time. A write-through-link
// escape is caught at intent time (the link exists then); swapping the link
// between the intent check and the write is known TOCTOU, not defended.

test("TD-372-A: honest in-worktree write then delete, with an inside intent, is accepted", async () => {
  const fixture = await makeFixture({ runId: "run_td372_a" });
  const relativePath = join("src", "transient-td372.js");
  const absolute = join(fixture.effectiveCwd, relativePath);
  fixture.setEvents(async function* events() {
    yield {
      kind: "write_intent",
      path: relativePath,
      toolCallId: "td372_inside",
      correlationStatus: "tracked",
    };
    await createFile(absolute);
    await rm(absolute, { force: true });
    yield { kind: "file_written", path: relativePath, toolCallId: "td372_inside" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 1, "the honest write must reach packaging");
    assert.ok(!output.events.some((event) => event.type === "run.isolation_violation"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TD-372-B: file_written ENOENT with no matching intent stays file_written_physical_unresolved", async () => {
  const fixture = await makeFixture({ runId: "run_td372_b" });
  const relativePath = join("src", "never-created-td372.js");
  fixture.setEvents(async function* events() {
    yield { kind: "file_written", path: relativePath, toolCallId: "td372_no_intent" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_physical_unresolved",
      errorCode: "ENOENT",
      path: relativePath.split(sep).join("/"),
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TD-372-C: file_written ENOENT whose toolCallId does not match the inside intent stays a violation", async () => {
  const fixture = await makeFixture({ runId: "run_td372_c" });
  fixture.setEvents(async function* events() {
    yield {
      kind: "write_intent",
      path: join("src", "intent-td372.js"),
      toolCallId: "td372_intent",
      correlationStatus: "tracked",
    };
    yield {
      kind: "file_written",
      path: join("src", "other-td372.js"),
      toolCallId: "td372_other_call",
    };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_physical_unresolved",
      errorCode: "ENOENT",
      path: "src/other-td372.js",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TD-372-D: an inside intent does not relax a post-write physical_outside verdict", async (t) => {
  const fixture = await makeFixture({ runId: "run_td372_d" });
  const outside = join(fixture.root, "outside-td372-d");
  await mkdir(outside, { recursive: true });
  await createFile(join(outside, "escaped.js"));
  const link = join(fixture.effectiveCwd, "late-link-td372");
  const probe = join(fixture.effectiveCwd, "junction-probe-td372");
  if (!await createJunctionOrSkip(t, outside, probe)) {
    await rm(fixture.root, { recursive: true, force: true });
    return;
  }
  await rm(probe, { force: true });
  fixture.setEvents(async function* events() {
    // Intent arrives while the link does not exist yet → inside.
    yield {
      kind: "write_intent",
      path: join("late-link-td372", "escaped.js"),
      toolCallId: "td372_swap",
      correlationStatus: "tracked",
    };
    await symlink(outside, link, "junction");
    yield { kind: "file_written", path: join("late-link-td372", "escaped.js"), toolCallId: "td372_swap" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0, "physical_outside is never relaxed");
    assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_physical_outside",
      outside: {
        destination: "temp",
        reportedPath: join("late-link-td372", "escaped.js"),
        resolvedPath: tildeNative(join(resolve(outside), "escaped.js")),
        escapedAt: "late-link-td372",
      },
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TD-372-S2b-a: intent while the junction exists is blocked as write_intent_physical_outside", async (t) => {
  const fixture = await makeFixture({ runId: "run_td372_s2b_a" });
  const outside = join(fixture.root, "outside-td372-s2b");
  await mkdir(outside, { recursive: true });
  const link = join(fixture.effectiveCwd, "linked-td372-s2b");
  if (!await createJunctionOrSkip(t, outside, link)) {
    await rm(fixture.root, { recursive: true, force: true });
    return;
  }
  fixture.setEvents(async function* events() {
    yield {
      kind: "write_intent",
      path: join("linked-td372-s2b", "escaped.js"),
      toolCallId: "td372_s2b_intent",
      correlationStatus: "tracked",
    };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "write_intent",
      reason: "write_intent_physical_outside",
      outside: {
        destination: "temp",
        reportedPath: join("linked-td372-s2b", "escaped.js"),
        resolvedPath: tildeNative(join(resolve(outside), "escaped.js")),
        escapedAt: "linked-td372-s2b",
      },
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TD-372-S2b-b: no intent — write through a junction, remove it, recreate an empty dir → still a violation", async (t) => {
  const fixture = await makeFixture({ runId: "run_td372_s2b_b" });
  const outside = join(fixture.root, "outside-td372-s2b-b");
  await mkdir(outside, { recursive: true });
  const link = join(fixture.effectiveCwd, "linked-td372-s2b-b");
  if (!await createJunctionOrSkip(t, outside, link)) {
    await rm(fixture.root, { recursive: true, force: true });
    return;
  }
  await writeFile(join(link, "escaped.js"), "outside", "utf8");
  await rm(link, { recursive: true, force: true });
  await mkdir(link, { recursive: true }); // empty directory in the original place
  fixture.setEvents(async function* events() {
    yield { kind: "file_written", path: join("linked-td372-s2b-b", "escaped.js") };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(await readFile(join(outside, "escaped.js"), "utf8"), "outside");
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_physical_unresolved",
      errorCode: "ENOENT",
      path: "linked-td372-s2b-b/escaped.js",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TD-372-S8-a: intent while the leaf file link exists is blocked as write_intent_physical_outside", async (t) => {
  const fixture = await makeFixture({ runId: "run_td372_s8_a" });
  const outsideFile = join(fixture.root, "outside-td372-s8-a.js");
  await writeFile(outsideFile, "outside", "utf8");
  const link = join(fixture.effectiveCwd, "leaf-td372-s8-a.js");
  if (!await createFileLinkOrSkip(t, outsideFile, link)) {
    await rm(fixture.root, { recursive: true, force: true });
    return;
  }
  fixture.setEvents(async function* events() {
    yield {
      kind: "write_intent",
      path: "leaf-td372-s8-a.js",
      toolCallId: "td372_s8_intent",
      correlationStatus: "tracked",
    };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "write_intent",
      reason: "write_intent_physical_outside",
      outside: {
        destination: "temp",
        reportedPath: "leaf-td372-s8-a.js",
        resolvedPath: tildeNative(resolve(outsideFile)),
        escapedAt: "leaf-td372-s8-a.js",
      },
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TD-372-S8-b: no intent — write through the file link, delete the link → still a violation", async (t) => {
  const fixture = await makeFixture({ runId: "run_td372_s8_b" });
  const outsideFile = join(fixture.root, "outside-td372-s8-b.js");
  await writeFile(outsideFile, "before", "utf8");
  const link = join(fixture.effectiveCwd, "leaf-td372-s8-b.js");
  if (!await createFileLinkOrSkip(t, outsideFile, link)) {
    await rm(fixture.root, { recursive: true, force: true });
    return;
  }
  await writeFile(link, "outside", "utf8");
  await rm(link, { force: true });
  fixture.setEvents(async function* events() {
    yield { kind: "file_written", path: "leaf-td372-s8-b.js" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(await readFile(outsideFile, "utf8"), "outside");
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_physical_unresolved",
      errorCode: "ENOENT",
      path: "leaf-td372-s8-b.js",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

// ===== TD-372 review fix: qualification is exact, one-shot, canonical =====

test("TD-372-R1: a real junction + `j./x.txt` stays file_written_physical_unresolved", async (t) => {
  if (!WIN32) { t.skip("win32 trailing-dot resolution"); return; }
  const fixture = await makeFixture({ runId: "run_td372_r1" });
  const outside = join(fixture.root, "outside-td372-r1");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "x.txt"), "outside", "utf8");
  const junction = join(fixture.effectiveCwd, "j");
  if (!await createJunctionOrSkip(t, outside, junction)) {
    await rm(fixture.root, { recursive: true, force: true });
    return;
  }
  fixture.setEvents(async function* events() {
    // Node does not strip the trailing dot, so the intent walks to the inside
    // ancestor; Win32 writers do strip it and write through the junction.
    yield { kind: "write_intent", path: join("j.", "x.txt"), toolCallId: "td372_r1", correlationStatus: "tracked" };
    yield { kind: "file_written", path: join("j.", "x.txt"), toolCallId: "td372_r1" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(await readFile(join(outside, "x.txt"), "utf8"), "outside");
    assert.equal(fixture.getPackageCount(), 0, "a trailing-dot segment must not be relaxed");
    assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_physical_unresolved",
      errorCode: "ENOENT",
      path: "j./x.txt",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TD-372-R1b: `j/../x.txt` through a real junction is never relaxed", async (t) => {
  if (!WIN32) { t.skip("win32 junction semantics"); return; }
  const fixture = await makeFixture({ runId: "run_td372_r1b" });
  const outside = join(fixture.root, "outside-td372-r1b");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "x.txt"), "outside", "utf8");
  const junction = join(fixture.effectiveCwd, "j");
  if (!await createJunctionOrSkip(t, outside, junction)) {
    await rm(fixture.root, { recursive: true, force: true });
    return;
  }
  const reportedPath = "j/../x.txt";
  fixture.setEvents(async function* events() {
    // Node collapses `..` lexically, so the intent walks to the inside
    // ancestor; POSIX-physical writers walk through the junction first.
    yield { kind: "write_intent", path: reportedPath, toolCallId: "td372_r1b", correlationStatus: "tracked" };
    yield { kind: "file_written", path: reportedPath, toolCallId: "td372_r1b" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0, "a `..` segment must not be relaxed");
    assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_physical_unresolved",
      errorCode: "ENOENT",
      path: "x.txt",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const [label, reportedPath] of [
  ["NUL", "NUL"],
  ["nul.txt", "nul.txt"],
  ["NUL.", "NUL."],
  ["alternate data stream", "x.txt:s"],
  ["COM superscript", "COM\u00B9"],
  ["trailing space segment", "trail "],
]) {
  test(`TD-372-R2 (${label}): a non-canonical Win32 segment is never relaxed`, async (t) => {
    if (!WIN32) { t.skip("win32 segment semantics"); return; }
    const fixture = await makeFixture({ runId: `run_td372_r2_${label.replaceAll(/[^a-z0-9]/gi, "_")}` });
    fixture.setEvents(async function* events() {
      yield { kind: "write_intent", path: reportedPath, toolCallId: "td372_r2", correlationStatus: "tracked" };
      yield { kind: "file_written", path: reportedPath, toolCallId: "td372_r2" };
      yield { kind: "done", reason: "completed" };
    });
    try {
      const output = await finishFixture(fixture);
      assert.equal(fixture.getPackageCount(), 0);
      assertViolationFact(output.events, {
        eventKind: "file_written",
        reason: "file_written_physical_unresolved",
        errorCode: "ENOENT",
        path: reportedPath.split(sep).join("/"),
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test("TD-372-R3: intent path and file_written path must match byte-for-byte", async () => {
  const fixture = await makeFixture({ runId: "run_td372_r3" });
  fixture.setEvents(async function* events() {
    yield { kind: "write_intent", path: join("src", "a.js"), toolCallId: "td372_r3", correlationStatus: "tracked" };
    yield { kind: "file_written", path: join("src", "b.js"), toolCallId: "td372_r3" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_physical_unresolved",
      errorCode: "ENOENT",
      path: "src/b.js",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TD-372-R4: the relaxation is one-shot — a second file_written for the same id is a violation", async () => {
  const fixture = await makeFixture({ runId: "run_td372_r4" });
  const relativePath = join("src", "twice.js");
  fixture.setEvents(async function* events() {
    yield { kind: "write_intent", path: relativePath, toolCallId: "td372_r4", correlationStatus: "tracked" };
    yield { kind: "file_written", path: relativePath, toolCallId: "td372_r4" };
    yield { kind: "file_written", path: relativePath, toolCallId: "td372_r4" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_physical_unresolved",
      errorCode: "ENOENT",
      path: "src/twice.js",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TD-372-R4b: a first INSIDE confirmation also consumes the qualification", async () => {
  const fixture = await makeFixture({ runId: "run_td372_r4b" });
  const relativePath = join("src", "twice-inside.js");
  const absolute = join(fixture.effectiveCwd, relativePath);
  fixture.setEvents(async function* events() {
    yield { kind: "write_intent", path: relativePath, toolCallId: "td372_r4b", correlationStatus: "tracked" };
    await createFile(absolute);
    yield { kind: "file_written", path: relativePath, toolCallId: "td372_r4b" };
    await rm(absolute, { force: true });
    yield { kind: "file_written", path: relativePath, toolCallId: "td372_r4b" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_physical_unresolved",
      errorCode: "ENOENT",
      path: "src/twice-inside.js",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TD-372-R5: an ENOENT from the worktree root's realpath is never relaxed", async () => {
  const fixture = await makeFixture({ runId: "run_td372_r5" });
  const base = resolve(fixture.effectiveCwd);
  let baseCalls = 0;
  const realpath = (p) => {
    if (resolve(p) === base) {
      baseCalls += 1;
      if (baseCalls >= 3) throw fsError("ENOENT"); // intent needs two base resolutions
    }
    return realpathSync.native(p);
  };
  fixture.run.containmentDeps = { realpath, sleep: async () => {} };
  fixture.setEvents(async function* events() {
    yield { kind: "write_intent", path: "root-failure.js", toolCallId: "td372_r5", correlationStatus: "tracked" };
    yield { kind: "file_written", path: "root-failure.js", toolCallId: "td372_r5" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_physical_unresolved",
      errorCode: "ENOENT",
      path: "root-failure.js",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
test("TD-372-R6: a redaction marker in the reported path is never relaxed", async () => {
  const fixture = await makeFixture({ runId: "run_td372_r6" });
  const reportedPath = join("src", "[REDACTED]-td372.js");
  fixture.setEvents(async function* events() {
    yield { kind: "write_intent", path: reportedPath, toolCallId: "td372_r6", correlationStatus: "tracked" };
    yield { kind: "file_written", path: reportedPath, toolCallId: "td372_r6" };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_physical_unresolved",
      errorCode: "ENOENT",
      path: "src/[REDACTED]-td372.js",
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TD-372-R7: prefixes and a non-target ENOENT fail the pure predicate", () => {
  const base = {
    verdict: "physical_unresolved",
    errorCode: "ENOENT",
    unresolvedAt: "target",
    intentPath: "x.js",
    fileWrittenPath: "x.js",
  };
  assert.equal(isTd372RelaxableConfirmation(base), true);
  assert.equal(isTd372RelaxableConfirmation({ ...base, unresolvedAt: "base" }), false, "root ENOENT");
  assert.equal(isTd372RelaxableConfirmation({ ...base, unresolvedAt: "ancestor" }), false, "ancestor ENOENT");
  for (const parentTraversal of ["real/../x.txt", "a/b/../../c.txt"]) {
    assert.equal(isTd372RelaxableConfirmation({
      ...base,
      intentPath: parentTraversal,
      fileWrittenPath: parentTraversal,
    }), false, `.. is resolved by the writer: ${parentTraversal}`);
  }
  assert.equal(isTd372RelaxableConfirmation({
    ...base,
    intentPath: "dir/./x.js",
    fileWrittenPath: "dir/./x.js",
  }), true, "`.` remains exempt");
  for (const prefix of ["\\\\?\\C:\\work\\x.js", "\\\\.\\C:\\work\\x.js", "\\\\server\\share\\x.js"]) {
    assert.equal(isTd372RelaxableConfirmation({
      ...base,
      intentPath: prefix,
      fileWrittenPath: prefix,
    }), false, prefix);
  }
  if (WIN32) {
    for (const bad of ["NUL", "nul.txt", "NUL.", "x.txt:s", "COM\u00B9", "trail ", "NUL .txt", "nul .tar.gz", "COM1 .log"]) {
      assert.equal(hasNonCanonicalWindowsSegment(bad), true, bad);
      assert.equal(isTd372RelaxableConfirmation({
        ...base,
        intentPath: bad,
        fileWrittenPath: bad,
      }), false, `device base name after trimming: ${bad}`);
    }
    for (const good of ["src/x.js", ".", "..", "dir/./x.js", "C:\\work\\src\\x.js"]) {
      assert.equal(hasNonCanonicalWindowsSegment(good), false, good);
    }
  }
});

test("TD-373-G: listWorktreePaths uses the 5s timeout and parses porcelain", () => {
  let seenOptions = null;
  const paths = listWorktreePaths(tmpdir(), {
    execFn: (file, args, options) => {
      seenOptions = { file, args, options };
      return "worktree C:\\main-checkout\nHEAD abc\n\nworktree C:\\run\nHEAD def\n\n";
    },
  });
  assert.equal(seenOptions.file, "git");
  assert.equal(seenOptions.options.timeout, 5000);
  assert.equal(LIST_WORKTREE_PATHS_TIMEOUT_MS, 5000);
  assert.deepEqual(paths, ["C:\\main-checkout", "C:\\run"]);
});

// =====================================================================
// Section TD-373 — destination / redacted paths on outside violations
// =====================================================================

test("TD-373-A: lexical outside records destination + redacted paths (home ~, controls, 300-char bound)", async () => {
  const fixture = await makeFixture({ runId: "run_td373_a" });
  const longName = `td373-${"x".repeat(400)}.js`;
  const reported = join(homedir(), "wao-td373", `evil\u0007name-${longName}`);
  fixture.setEvents(async function* events() {
    yield { kind: "file_written", path: reported };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    const violation = assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_lexical_outside",
      outside: { destination: "home", escapedAtAbsent: true },
    });
    assert.ok(violation.reportedPath.startsWith("~"), "user home prefix is replaced by ~");
    assert.ok(!violation.reportedPath.includes("\u0007"), "raw control characters are removed");
    assert.ok(violation.reportedPath.length <= 300, "reportedPath is bounded to 300 UTF-16 units");
    assert.ok(violation.resolvedPath.startsWith("~"), "resolvedPath uses the same home replacement");
    assert.ok(!violation.resolvedPath.includes("\u0007"));
    assert.ok(violation.resolvedPath.length <= 300);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TD-373-A2: equivalent home spellings are redacted or the whole field is omitted", async (t) => {
  if (!WIN32) { t.skip("win32 home-path spellings"); return; }
  const home = resolve(homedir());
  const drive = /^([A-Za-z]):/.exec(home)?.[1] ?? "C";
  const user = home.split(sep).filter(Boolean).at(-1);
  assert.ok(user && user.length > 0, "the test machine has a user-name home segment");
  const cases = [
    ["mixed separators", `${home.replaceAll("\\", "/")}/wao-td373-mixed.js`, false],
    ["extended prefix", `\\\\?\\${join(home, "wao-td373-ext.js")}`, false],
    ["extended UNC", `\\\\?\\UNC\\localhost\\${drive}$\\Users\\${user}\\wao-td373-ext-unc.js`, true],
    ["admin share", `\\\\localhost\\${drive}$\\Users\\${user}\\wao-td373-admin.js`, true],
    ["dot segment", `${drive}:\\Users\\.\\${user}\\wao-td373-dot.js`, false],
    ["user trailing dot", `${home}.\\wao-td373-tail-dot.js`, true],
  ];
  for (const [label, reportedPath, omitted] of cases) {
    const fixture = await makeFixture({ runId: `run_td373_a2_${label.replaceAll(/[^a-z0-9]/gi, "_")}` });
    fixture.setEvents(async function* events() {
      yield { kind: "file_written", path: reportedPath };
      yield { kind: "done", reason: "completed" };
    });
    try {
      const output = await finishFixture(fixture);
      assert.equal(fixture.getPackageCount(), 0);
      const violation = output.events.find((event) => event.type === "run.isolation_violation");
      assert.ok(ISOLATION_DESTINATIONS.includes(violation?.destination), `${label}: destination closed set`);
      if (omitted) {
        assert.ok(!Object.hasOwn(violation, "reportedPath"), `${label}: reportedPath omitted`);
        assert.ok(!Object.hasOwn(violation, "resolvedPath"), `${label}: resolvedPath omitted`);
        assert.ok(!output.rawTranscript.toLowerCase().includes(user.toLowerCase()),
          `${label}: the user name never reaches the transcript`);
      } else {
        assert.ok(violation.reportedPath.startsWith("~"), `${label}: home prefix becomes ~`);
        assert.ok(!violation.reportedPath.toLowerCase().split(/[\\/]+/).includes(user.toLowerCase()),
          `${label}: the user name is not left as a segment`);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("TD-373-A3: escapedAt follows the TD-336 layer-1 withholding of resolvedPath", async (t) => {
  const fixture = await makeFixture({
    runId: "run_td373_a3",
    redact: (value) => (typeof value === "string" ? value.replaceAll("secret-link", "[REDACTED]") : value),
  });
  const outside = join(fixture.root, "outside-td373-a3");
  await mkdir(outside, { recursive: true });
  await createFile(join(outside, "escaped.js"));
  const link = join(fixture.effectiveCwd, "secret-link");
  if (!await createJunctionOrSkip(t, outside, link)) {
    await rm(fixture.root, { recursive: true, force: true });
    return;
  }
  const reportedPath = join("secret-link", "escaped.js");
  fixture.setEvents(async function* events() {
    yield { kind: "file_written", path: reportedPath };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_physical_outside",
      outside: {
        destination: "temp",
        reportedPathContains: "[REDACTED]",
        resolvedPathAbsent: true,
        escapedAtAbsent: true,
      },
    });
    assert.ok(!output.rawTranscript.includes("secret-link"), "the raw link name is never persisted");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TD-373-A4: home stream syntax and a TAB-terminated user segment omit the whole field", async (t) => {
  if (!WIN32) { t.skip("win32 stream/control-character spellings"); return; }
  const home = resolve(homedir());
  const user = home.split(sep).filter(Boolean).at(-1);
  assert.ok(user && user.length > 0, "the test machine has a user-name home segment");
  for (const [label, reportedPath] of [
    ["directory stream", `${home}::$INDEX_ALLOCATION\\x.txt`],
    ["named stream", `${home}:$I30:$INDEX_ALLOCATION\\x.txt`],
    ["TAB-terminated user segment", `${home}\t\\x.txt`],
  ]) {
    const fixture = await makeFixture({ runId: `run_td373_a4_${label.replaceAll(/[^a-z0-9]/gi, "_")}` });
    fixture.setEvents(async function* events() {
      yield { kind: "file_written", path: reportedPath };
      yield { kind: "done", reason: "completed" };
    });
    try {
      const output = await finishFixture(fixture);
      assert.equal(fixture.getPackageCount(), 0);
      const violation = output.events.find((event) => event.type === "run.isolation_violation");
      assert.ok(ISOLATION_DESTINATIONS.includes(violation?.destination), `${label}: destination closed set`);
      assert.ok(!Object.hasOwn(violation, "reportedPath"), `${label}: reportedPath omitted`);
      assert.ok(!Object.hasOwn(violation, "resolvedPath"), `${label}: resolvedPath omitted`);
      assert.ok(!output.rawTranscript.toLowerCase().includes(user.toLowerCase()),
        `${label}: the user name never reaches the transcript`);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("TD-373-B: an injected exact secret withholds resolvedPath and never persists the plaintext", async () => {
  const marker = "td373-injected-secret-value";
  const fixture = await makeFixture({
    runId: "run_td373_b",
    redact: (value) => (typeof value === "string" ? value.replaceAll(marker, "[REDACTED]") : value),
  });
  const reported = join(fixture.root, marker, "escaped.js");
  fixture.setEvents(async function* events() {
    yield { kind: "file_written", path: reported };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    const violation = assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_lexical_outside",
      outside: { destination: "temp", resolvedPathAbsent: true, escapedAtAbsent: true },
    });
    assert.ok(!output.rawTranscript.includes(marker), "the injected secret value never reaches the transcript");
    assert.ok(violation.reportedPath.includes("[REDACTED]"), "reportedPath keeps the redacted form");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TD-373-C: a secret-shaped token is replaced and withholds the normalized resolvedPath", async () => {
  const fixture = await makeFixture({ runId: "run_td373_c" });
  const token = `ghp_${"A".repeat(24)}`;
  const reported = join(fixture.root, token, `${"z".repeat(500)}.js`);
  fixture.setEvents(async function* events() {
    yield { kind: "file_written", path: reported };
    yield { kind: "done", reason: "completed" };
  });
  try {
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0);
    const violation = assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_lexical_outside",
      outside: { destination: "temp", resolvedPathAbsent: true, escapedAtAbsent: true },
    });
    assert.ok(!output.rawTranscript.includes(token), "the secret-shaped token never reaches the transcript");
    assert.ok(violation.reportedPath.includes("[REDACTED]"));
    assert.ok(violation.reportedPath.length <= 300, "the final redaction marker is still bounded");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TD-373-D: a throwing destination-roots reader degrades to destination other; the violation is unchanged", async () => {
  const fixture = await makeFixture({
    runId: "run_td373_d",
    isolationRootsFn: () => { throw new Error("roots reader exploded"); },
  });
  const outside = join(fixture.root, "outside-td373-d", "escaped.js");
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
      outside: {
        destination: "other",
        reportedPathContains: "outside-td373-d",
        resolvedPathContains: "outside-td373-d",
        escapedAtAbsent: true,
      },
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

// Destination roots against a real temporary git repository + worktrees. The
// fixture lives under os.tmpdir() and is removed afterwards.
function makeDestinationRepo() {
  const root = mkdtempSync(join(tmpdir(), "wao-td373-roots-"));
  const repo = join(root, "main-checkout");
  const runWorktree = join(repo, ".wao-worktrees", "run-td373");
  const otherWorktree = join(repo, ".wao-worktrees", "other-td373");
  mkdirSync(repo, { recursive: true });
  makeGitRepo(repo);
  execSync(`git worktree add "${runWorktree}" -b td373-run`, { cwd: repo, stdio: "ignore" });
  execSync(`git worktree add "${otherWorktree}" -b td373-other`, { cwd: repo, stdio: "ignore" });
  return { root, repo, runWorktree, otherWorktree };
}

test("TD-373-E: destination roots classify main checkout / other worktree / temp / home / other and deepest wins", () => {
  const fixture = makeDestinationRepo();
  try {
    assert.deepEqual(
      readIsolationDestinationRoots(fixture.runWorktree).map((root) => root.kind).sort(),
      ["home", "main_checkout", "other_worktree", "temp"],
      "the run's own worktree is not a root; main checkout first, other worktrees next",
    );
    assert.equal(classifyIsolationDestination({
      landingPath: join(fixture.repo, "src", "main.js"),
      effectiveCwd: fixture.runWorktree,
    }), "main_checkout");
    assert.equal(classifyIsolationDestination({
      landingPath: join(fixture.otherWorktree, "src", "other.js"),
      effectiveCwd: fixture.runWorktree,
    }), "other_worktree", "the deepest matching root wins (other worktree inside main checkout)");
    assert.equal(classifyIsolationDestination({
      landingPath: join(tmpdir(), "wao-td373-temp-landing.js"),
      effectiveCwd: fixture.runWorktree,
    }), "temp", "temp nested under home wins over home");
    assert.equal(classifyIsolationDestination({
      landingPath: join(homedir(), "wao-td373-home-landing.js"),
      effectiveCwd: fixture.runWorktree,
    }), "home");
    assert.equal(classifyIsolationDestination({
      landingPath: join(dirname(homedir()), "wao-td373-other-landing.js"),
      effectiveCwd: fixture.runWorktree,
    }), "other");
    assert.equal(classifyIsolationDestination({
      landingPath: join(fixture.repo, "src", "main.js"),
      physical: true,
      effectiveCwd: fixture.runWorktree,
    }), "main_checkout", "physical mode compares realpath()'d roots");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("TD-373-F: win32 destination matching is case-insensitive", (t) => {
  if (!WIN32) { t.skip("win32-only path identity"); return; }
  const fixture = makeDestinationRepo();
  try {
    assert.equal(classifyIsolationDestination({
      landingPath: join(fixture.repo.toUpperCase(), "src", "main.js"),
      effectiveCwd: fixture.runWorktree,
    }), "main_checkout");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});


// =====================================================================
// Section T — transient filesystem-error retry (both verdict functions)
// =====================================================================
//
// TD-336: a physical_unresolved observation is never final from one look. A
// writer that replaces a file (temp file + rename, pending delete) can leave
// the reported target momentarily unresolvable, and Windows produces transient
// shapes outside any fixed code whitelist — so EVERY physical_unresolved (any
// code, or none at all) re-runs the WHOLE classification after 25, 100 and
// 250 ms; a redo then uses the existing nearest-existing-ancestor branch when
// the target is gone. Only the confirmed inside/lexical_outside/
// physical_outside verdicts are final immediately. When the retries run out
// the verdict stays physical_unresolved (fail closed) and the result records
// the closed-set errorCode, the workspace-relative path of the reported
// target, and — only when the closed set reduced the code to "other" — the
// well-formed raw code as observedErrorCode. Filesystem calls and the wait
// are injectable seams.

function fsError(code) {
  return Object.assign(new Error(`synthetic ${code}`), { code });
}

// A deterministic sleep that only records its waits (no wall-clock cost).
function recordingSleep(sleeps) {
  return async (ms) => { sleeps.push(ms); };
}

const RETRY_WAITS = [25, 100, 250];

test("M12-14-T1: an intent verdict retries a transient EPERM twice, then passes", async () => {
  const base = resolve(join(tmpdir(), "wao-m1214-t1-worktree"));
  const target = resolve(join(base, "src", "kept.js"));
  const sleeps = [];
  let failuresLeft = 2;
  const realpath = (p) => {
    if (p !== target) return p;
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw fsError("EPERM");
    }
    return target;
  };
  const result = await classifyReportedWriteIntentContainment(target, base, {
    realpath,
    lstat: () => {},
    sleep: recordingSleep(sleeps),
  });
  assert.deepEqual(result, { verdict: "inside" });
  assert.deepEqual(sleeps, [25, 100], "one wait before each redo");
});

test("M12-14-T2: an always-EBUSY intent verdict stays physical_unresolved and records EBUSY", async () => {
  const base = resolve(join(tmpdir(), "wao-m1214-t2-worktree"));
  const target = resolve(join(base, "src", "locked.js"));
  const sleeps = [];
  let targetRealpathCalls = 0;
  const realpath = (p) => {
    if (p !== target) return p;
    targetRealpathCalls += 1;
    throw fsError("EBUSY");
  };
  const result = await classifyReportedWriteIntentContainment(target, base, {
    realpath,
    lstat: () => {},
    sleep: recordingSleep(sleeps),
  });
  // EBUSY is a closed-set member, so no raw observedErrorCode repeats it.
  assert.deepEqual(result, {
    verdict: "physical_unresolved",
    errorCode: "EBUSY",
    path: "src/locked.js",
    unresolvedAt: "target",
  });
  assert.deepEqual(sleeps, RETRY_WAITS, "three redos, each after its wait");
  assert.equal(targetRealpathCalls, 4, "the initial pass plus three redos");
});

test("M12-14-T3: a target that vanishes between lstat and realpath is re-classified through the ancestor branch", async () => {
  const base = resolve(join(tmpdir(), "wao-m1214-t3-worktree"));
  const target = resolve(join(base, "src", "swapped.js"));
  const sleeps = [];
  let lstatCalls = 0;
  let targetRealpathCalls = 0;
  const realpath = (p) => {
    // The worktree and its existing ancestors resolve to themselves; only the
    // target is inside the replace window during the first pass.
    if (p !== target) return p;
    targetRealpathCalls += 1;
    throw fsError("ENOENT");
  };
  const lstat = () => {
    lstatCalls += 1;
    if (lstatCalls === 1) return {}; // exists during the first pass
    throw fsError("ENOENT"); // gone by the time the redo looks
  };
  const result = await classifyReportedWriteIntentContainment(target, base, {
    realpath,
    lstat,
    sleep: recordingSleep(sleeps),
  });
  assert.deepEqual(result, { verdict: "inside" });
  assert.deepEqual(sleeps, [25], "exactly one redo was needed");
  assert.equal(targetRealpathCalls, 1, "the redo resolves the nearest existing ancestor instead");
});

test("M12-14-T4: an ELOOP verdict is retried with everything else, stays unresolved and records ELOOP", async () => {
  const base = resolve(join(tmpdir(), "wao-m1214-t4-worktree"));
  const target = resolve(join(base, "src", "loop.js"));
  const sleeps = [];
  let targetRealpathCalls = 0;
  const result = await classifyReportedWriteIntentContainment(target, base, {
    realpath: (p) => {
      if (p !== target) return p;
      targetRealpathCalls += 1;
      throw fsError("ELOOP");
    },
    lstat: () => {},
    sleep: recordingSleep(sleeps),
  });
  // No whitelist: a code that usually means "real path problem" still gets
  // its three redos before going final (TD-336). ELOOP is a closed-set
  // member, so no raw observedErrorCode repeats it.
  assert.deepEqual(result, {
    verdict: "physical_unresolved",
    errorCode: "ELOOP",
    path: "src/loop.js",
    unresolvedAt: "target",
  });
  assert.deepEqual(sleeps, RETRY_WAITS, "three redos before the final verdict");
  assert.equal(targetRealpathCalls, 4, "the initial pass plus three redos");
});

test("M12-14-T5: an error without a code is retried, recorded as other, and carries no observedErrorCode", async () => {
  const base = resolve(join(tmpdir(), "wao-m1214-t5-worktree"));
  const target = resolve(join(base, "src", "codeless.js"));
  const sleeps = [];
  const result = await classifyReportedWriteIntentContainment(target, base, {
    realpath: (p) => {
      if (p !== target) return p;
      throw new Error("unresolvable");
    },
    lstat: () => {},
    sleep: recordingSleep(sleeps),
  });
  // A missing code is not a shape the observed code may take — the raw value
  // (undefined) never rides along.
  assert.deepEqual(result, {
    verdict: "physical_unresolved",
    errorCode: "other",
    path: "src/codeless.js",
    unresolvedAt: "target",
  });
  assert.deepEqual(sleeps, RETRY_WAITS, "a codeless failure is retried like any unresolved one");
});

test("M12-14-T6: confirmed inside/outside verdicts are never retried", async () => {
  const root = resolve(join(tmpdir(), "wao-m1214-t6"));
  const base = resolve(join(root, "worktree"));
  const outsideTarget = resolve(join(root, "outside", "escaped.js"));
  const sleeps = [];
  const deps = { lstat: () => {}, sleep: recordingSleep(sleeps) };

  // lexical_outside: no filesystem call is made at all.
  const lexical = await classifyReportedWriteIntentContainment(outsideTarget, base, {
    ...deps,
    realpath: () => { throw new Error("realpath must not run for a lexical verdict"); },
  });
  assert.deepEqual(lexical, { verdict: "lexical_outside" });

  // physical_outside: resolved, but outside the worktree.
  const target = resolve(join(base, "src", "linked.js"));
  const physical = await classifyReportedWriteIntentContainment(target, base, {
    ...deps,
    realpath: (p) => (p === target ? outsideTarget : p),
  });
  assert.deepEqual(physical, { verdict: "physical_outside" });

  // inside: resolved inside the worktree.
  const inside = await classifyReportedWriteIntentContainment(target, base, { ...deps, realpath: (p) => p });
  assert.deepEqual(inside, { verdict: "inside" });
  assert.deepEqual(sleeps, [], "no sleep for any confirmed verdict");
});

test("M12-14-T7: a file_written verdict retries a transient EACCES, then passes", async () => {
  const base = resolve(join(tmpdir(), "wao-m1214-t7-worktree"));
  const target = resolve(join(base, "src", "written.js"));
  const sleeps = [];
  let failuresLeft = 1;
  const result = await classifyReportedWriteContainment(target, base, {
    realpath: (p) => {
      if (p !== target) return p;
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw fsError("EACCES");
      }
      return target;
    },
    lstat: () => {},
    sleep: recordingSleep(sleeps),
  });
  assert.deepEqual(result, { verdict: "inside" });
  assert.deepEqual(sleeps, [25]);
});

test("M12-14-T8: an always-EACCES file_written verdict stays physical_unresolved and records EACCES", async () => {
  const base = resolve(join(tmpdir(), "wao-m1214-t8-worktree"));
  const target = resolve(join(base, "src", "written.js"));
  const sleeps = [];
  const result = await classifyReportedWriteContainment(target, base, {
    realpath: (p) => {
      if (p !== target) return p;
      throw fsError("EACCES");
    },
    lstat: () => {},
    sleep: recordingSleep(sleeps),
  });
  // EACCES is a closed-set member, so no raw observedErrorCode repeats it.
  assert.deepEqual(result, {
    verdict: "physical_unresolved",
    errorCode: "EACCES",
    path: "src/written.js",
    unresolvedAt: "target",
  });
  assert.deepEqual(sleeps, RETRY_WAITS);
});

test("M12-14-T9: a redo re-checks the boundary — a target swapped to an outside link during the wait is physical_outside", async () => {
  const base = resolve(join(tmpdir(), "wao-m1214-t9-worktree"));
  const outside = resolve(join(tmpdir(), "wao-m1214-t9-outside", "x.js"));
  const target = resolve(join(base, "src", "swapped.js"));
  for (const classify of [classifyReportedWriteIntentContainment, classifyReportedWriteContainment]) {
    const sleeps = [];
    let first = true;
    const result = await classify(target, base, {
      realpath: (p) => {
        if (p !== target) return p;
        if (first) {
          first = false;
          throw fsError("EPERM");
        }
        return outside;
      },
      lstat: () => {},
      sleep: recordingSleep(sleeps),
    });
    assert.deepEqual(result, { verdict: "physical_outside" }, classify.name);
    assert.deepEqual(sleeps, [25], `${classify.name}: one wait, then the redo resolves outside`);
  }
});

test("M12-14-T10: an intent verdict failing once with UNKNOWN then succeeding is inside (TD-336 shape)", async () => {
  const base = resolve(join(tmpdir(), "wao-m1214-t10-worktree"));
  const target = resolve(join(base, "src", "swapped.js"));
  const sleeps = [];
  let failuresLeft = 1;
  const result = await classifyReportedWriteIntentContainment(target, base, {
    realpath: (p) => {
      if (p !== target) return p;
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw fsError("UNKNOWN");
      }
      return target;
    },
    lstat: () => {},
    sleep: recordingSleep(sleeps),
  });
  // run_20261105150050472aqb094 died on exactly this shape: a just-written
  // in-worktree target failed once with a code outside the old whitelist.
  assert.deepEqual(result, { verdict: "inside" });
  assert.deepEqual(sleeps, [25], "one wait before the redo");
});

test("M12-14-T11: a file_written verdict failing once with UNKNOWN then succeeding is inside", async () => {
  const base = resolve(join(tmpdir(), "wao-m1214-t11-worktree"));
  const target = resolve(join(base, "src", "written.js"));
  const sleeps = [];
  let failuresLeft = 1;
  const result = await classifyReportedWriteContainment(target, base, {
    realpath: (p) => {
      if (p !== target) return p;
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw fsError("UNKNOWN");
      }
      return target;
    },
    lstat: () => {},
    sleep: recordingSleep(sleeps),
  });
  assert.deepEqual(result, { verdict: "inside" });
  assert.deepEqual(sleeps, [25], "one wait before the redo");
});

test("M12-14-T12: a persistent UNKNOWN rides along as observedErrorCode next to the path", async () => {
  const base = resolve(join(tmpdir(), "wao-m1214-t12-worktree"));
  const target = resolve(join(base, "src", "opaque.js"));
  const unknownRealpath = (p) => {
    if (p !== target) return p;
    throw fsError("UNKNOWN");
  };
  const deps = { realpath: unknownRealpath, lstat: () => {} };
  for (const classify of [classifyReportedWriteIntentContainment, classifyReportedWriteContainment]) {
    const sleeps = [];
    const result = await classify(target, base, { ...deps, sleep: recordingSleep(sleeps) });
    // UNKNOWN reduces to the closed-set "other"; the well-formed raw token
    // and the workspace-relative path are recorded so the next identical
    // failure is diagnosable without mtime archaeology (TD-336).
    assert.deepEqual(result, {
      verdict: "physical_unresolved",
      errorCode: "other",
      path: "src/opaque.js",
      observedErrorCode: "UNKNOWN",
      unresolvedAt: "target",
    }, classify.name);
    assert.deepEqual(sleeps, RETRY_WAITS, classify.name);
  }
});

test("M12-14-T13: a code that does not fit the observed-token shape carries no observedErrorCode", async () => {
  const base = resolve(join(tmpdir(), "wao-m1214-t13-worktree"));
  const target = resolve(join(base, "src", "shaped.js"));
  for (const bad of [
    "unknown", // lowercase
    "UNKNOWN CODE", // space
    "UNKNOWN\n", // newline
    `${"A".repeat(32)}X`, // 33 chars
    42, // non-string
    null, // non-string
  ]) {
    const result = await classifyReportedWriteIntentContainment(target, base, {
      realpath: (p) => {
        if (p !== target) return p;
        throw Object.assign(new Error("synthetic"), { code: bad });
      },
      lstat: () => {},
      sleep: recordingSleep([]),
    });
    assert.deepEqual(result, {
      verdict: "physical_unresolved",
      errorCode: "other",
      path: "src/shaped.js",
      unresolvedAt: "target",
    }, `code ${JSON.stringify(bad)} must not surface as observedErrorCode`);
  }
});

test("M12-14-T14: a reported target that IS the worktree root stays unresolved without a path", async () => {
  const base = resolve(join(tmpdir(), "wao-m1214-t14-worktree"));
  for (const classify of [classifyReportedWriteIntentContainment, classifyReportedWriteContainment]) {
    const result = await classify(base, base, {
      // The reported target IS the worktree root: resolve-normalization yields
      // no relative form, so even a fully unresolvable base carries no path.
      realpath: (p) => {
        if (p !== base) return p;
        throw fsError("EPERM");
      },
      lstat: () => {},
      sleep: recordingSleep([]),
    });
    assert.deepEqual(result, {
      verdict: "physical_unresolved",
      errorCode: "EPERM",
      unresolvedAt: "base",
    }, `${classify.name}: root-target unresolved verdict has no path key`);
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
    const violation = assertViolationFact(output.events, {
      eventKind: "write_intent",
      reason: "write_intent_lexical_outside",
      outside: {
        destination: "temp",
        reportedPathContains: "outside-m3",
        resolvedPathContains: "outside-m3",
        escapedAtAbsent: true,
      },
    });
    assert.ok(violation.reportedPath.startsWith("~"), "MSYS home prefix is replaced by ~");
    assertPathOnlyOnViolationLine(output.rawTranscript, "outside-m3");
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
    const violation = assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_lexical_outside",
      outside: {
        destination: "temp",
        reportedPathContains: "outside-m4",
        resolvedPathContains: "outside-m4",
        escapedAtAbsent: true,
      },
    });
    assert.ok(violation.reportedPath.startsWith("~"), "MSYS home prefix is replaced by ~");
    assertPathOnlyOnViolationLine(output.rawTranscript, "outside-m4");
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
        outside: { destination: "other", reportedPath: reported, escapedAtAbsent: true },
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
// Section M2 — Windows path-shape pins (TD-373: pin current behavior only)
// =====================================================================
//
// These shapes are deliberately NOT widened by this batch. They are pinned so a
// future containment change must make its effect on them explicit.

test("TD-373-WIN1 (pin): a drive-relative path on another drive is outside", async (t) => {
  if (!WIN32) { t.skip("win32 drive-relative semantics"); return; }
  const fixture = await classifierLandingFixture();
  try {
    const noSleep = { sleep: async () => {} };
    assert.deepEqual(
      await classifyReportedWriteIntentContainment("E:foo", fixture.base, noSleep),
      { verdict: "lexical_outside" },
      "E:foo resolves against the E: current directory, not the worktree",
    );
    assert.deepEqual(
      await classifyReportedWriteContainment("E:foo", fixture.base, noSleep),
      { verdict: "lexical_outside" },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TD-373-WIN2 (pin): a \\\\?\\ extended-length path pointing inside is still rejected", async (t) => {
  if (!WIN32) { t.skip("win32 extended-length path syntax"); return; }
  const fixture = await classifierLandingFixture();
  try {
    const noSleep = { sleep: async () => {} };
    // Unsupported reported form: the containment contract accepts ordinary
    // drive paths (and the MSYS drive form above), not \\?\ extended-length
    // paths. Rejection is intentional; this pins it.
    const extended = `\\\\?\\${resolve(fixture.base, "src", "inside.js")}`;
    assert.deepEqual(
      await classifyReportedWriteIntentContainment(extended, fixture.base, noSleep),
      { verdict: "lexical_outside" },
    );
    assert.deepEqual(
      await classifyReportedWriteContainment(extended, fixture.base, noSleep),
      { verdict: "lexical_outside" },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("TD-373-WIN3 (pin): NUL with an inside intent still violates at the delivery layer and never packages", async (t) => {
  if (!WIN32) { t.skip("Windows device-name semantics"); return; }
  const fixture = await makeFixture({ runId: "run_td373_win3" });
  try {
    // KNOWN LIMITATION, pinned not fixed: a reported target named NUL is a
    // Windows device name, not an ordinary worktree file. The intent
    // classifier treats lstat ENOENT as "not created yet" and walks to the
    // in-worktree ancestor → inside; writing to that name actually goes to the
    // device (\\.\NUL). The TD-372 review fix keeps this delivery-level result
    // fail-closed: the canonical-segment rule refuses the relaxation.
    fixture.setEvents(async function* events() {
      yield { kind: "write_intent", path: "NUL", toolCallId: "td373_win3", correlationStatus: "tracked" };
      yield { kind: "file_written", path: "NUL", toolCallId: "td373_win3" };
      yield { kind: "done", reason: "completed" };
    });
    const output = await finishFixture(fixture);
    assert.equal(fixture.getPackageCount(), 0, "NUL must never be relaxed/packaged");
    assertViolationFact(output.events, {
      eventKind: "file_written",
      reason: "file_written_physical_unresolved",
      errorCode: "ENOENT",
      path: "NUL",
    });
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
