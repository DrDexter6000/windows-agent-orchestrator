// test/run-lifecycle/dispatchCwdExistence.test.js
//
// R7-AB layer 1 — a dispatch's PREDICTED working directory must be an EXISTING
// directory, refused at the dispatch service layer BEFORE any side effect.
//
// Defect being fixed (2026-08-16, 22 researcher spawn_error runs): Node spawn's
// classic trap — when the cwd option points at a missing directory, the ENOENT
// is blamed on the EXECUTABLE ("spawn <node.exe> ENOENT"). Dispatches without an
// explicit --cwd inherited the example registry's placeholder cwd
// ("D:/projects/your-project", config/agents.example.json) and failed only at
// runner spawn time, with a misleading error, after the transcript was written.
//
// The fix (SSOT: src/runManager.js defines DispatchCwdNotFoundError +
// assertExistingDispatchCwd; dispatchRun imports them downward and re-exports
// the class) throws the typed DispatchCwdNotFoundError (reasonCode
// "dispatch_cwd_not_found") after the registry agent is resolved, BEFORE the
// credential preflight, any sessionReuse/lineage slot claim, any transcript
// write, and the fork. The predicted cwd is: the explicit cwd argument when
// non-empty, else the registry entry's agent.cwd (both missing → no check;
// unreachable via readRegistry, which requires agent.cwd non-empty — pinned
// by CE-11).
//
// Boundaries pinned here:
//   1. Refusal faces      — explicit bad --cwd / registry placeholder cwd /
//      exists-but-is-a-file all refuse typed, with ZERO transcripts and ZERO
//      forks (CE-1..CE-3).
//   2. Acceptance faces   — relative "." and a real absolute directory dispatch
//      exactly as before (CE-4, CE-5).
//   3. Slot discipline    — a sessionReuse agent with a bad cwd refuses BEFORE
//      the .session-reuse routing slot is claimed (CE-6).
//   4. Priority pins      — the existing cwd-NON-EMPTY refusals keep priority
//      whenever the registry entry itself is sane: SessionReuseWorkspaceRequired-
//      Error still owns the no-explicit-cwd sessionReuse face (CE-10); a registry
//      agent without any cwd is rejected by the registry SSOT, not by the
//      existence check (CE-11).
//   5. CLI end-to-end     — `run --background` with a bad-cwd registry fixture
//      exits non-zero, prints the typed message + resolved path on stderr, and
//      leaves the run-dir empty (CE-7).
//   6. Typed class shape  — stable name/reasonCode, path + source + fix
//      guidance in the message, identical text for identical inputs (CE-8);
//      the runDispatch export IS the shared SSOT class (CE-12).
//   7. Usage page         — RUN_USAGE_TEXT documents the existence requirement
//      on the --cwd line (CE-9).
//
// Pure group: temp fixtures under os.tmpdir(), fakeSpawn injection, zero git,
// zero real dispatch, zero provider token. The only real subprocess is the CLI
// end-to-end (CE-7), which is REFUSED before any fork.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { dispatchRun, DispatchCwdNotFoundError, SessionReuseWorkspaceRequiredError } from "../../src/application/runDispatch.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ===== Helpers (mirroring deliveryCwdRequirement.test.js) =====

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function makeRegistry(dir, agents) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return registryPath;
}

function makeFakeSpawn() {
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { unref() {} };
  };
  return { fakeSpawn, calls };
}

/** List the .jsonl transcripts in a runs dir (empty list if the dir is absent). */
function listTranscripts(runDir) {
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir).filter((f) => f.endsWith(".jsonl"));
}

const NO_ENV_READER = async () => ({});

// The placeholder cwd shape from the reproduced defect (config/agents.example.json
// researcher entry). Never created on disk in these fixtures.
const PLACEHOLDER_CWD = "D:/projects/your-project";

// =====================================================================
// 1. Refusal faces — typed, zero transcript, zero fork
// =====================================================================

test("CE-1: explicit --cwd pointing at a nonexistent path → typed DispatchCwdNotFoundError, zero transcript, zero fork", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ce1-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const runDir = join(dir, "runs");
    const badCwd = join(dir, "no-such-target");
    await assert.rejects(
      () => dispatchRun({
        agentId: "coder_low",
        prompt: "x",
        registryPath,
        runDir,
        cwd: badCwd,
        spawnFn: fakeSpawn,
        userEnvReader: NO_ENV_READER,
      }),
      (e) => {
        assert.equal(e.name, "DispatchCwdNotFoundError", "typed closed-set error identity");
        assert.equal(e.reasonCode, "dispatch_cwd_not_found", "closed-set reason code");
        assert.ok(e.message.includes(resolve(badCwd)), "message carries the RESOLVED absolute path");
        assert.match(e.message, /--cwd flag/, "message names the --cwd flag as the source");
        assert.match(e.message, /existing directory/, "message carries fix guidance");
        return true;
      },
    );
    assert.deepEqual(listTranscripts(runDir), [], "zero transcript files (runs dir never created)");
    assert.equal(calls.length, 0, "detached runner never forked");
  } finally {
    cleanupDir(dir);
  }
});

test("CE-2: no explicit cwd, agent.cwd nonexistent (researcher defect shape) → typed refusal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ce2-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    // The exact defect shape: a registry entry whose cwd is the documentation
    // placeholder path (never created on this machine), dispatched with no
    // explicit cwd. Used to reach runner spawn and fail with the misleading
    // "spawn <node.exe> ENOENT" spawn_error after the transcript was written.
    const registryPath = makeRegistry(dir, {
      researcher: { backend: "claude-code", cwd: PLACEHOLDER_CWD },
    });
    const runDir = join(dir, "runs");
    await assert.rejects(
      () => dispatchRun({
        agentId: "researcher",
        prompt: "分析这个模块",
        registryPath,
        runDir,
        spawnFn: fakeSpawn,
        userEnvReader: NO_ENV_READER,
      }),
      (e) => {
        assert.equal(e.name, "DispatchCwdNotFoundError");
        assert.equal(e.reasonCode, "dispatch_cwd_not_found");
        assert.ok(e.message.includes(resolve(PLACEHOLDER_CWD)), "resolved placeholder path in the message");
        assert.match(e.message, /agent registry entry cwd/, "message names the registry entry as the source");
        return true;
      },
    );
    assert.deepEqual(listTranscripts(runDir), [], "zero transcript files");
    assert.equal(calls.length, 0, "zero forks");
  } finally {
    cleanupDir(dir);
  }
});

test("CE-3: predicted cwd exists but is a FILE → refused (spawn would fail on it the same way)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ce3-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const fileCwd = join(dir, "not-a-dir.txt");
    writeFileSync(fileCwd, "x", "utf8");
    await assert.rejects(
      () => dispatchRun({
        agentId: "coder_low",
        prompt: "x",
        registryPath,
        runDir: join(dir, "runs"),
        cwd: fileCwd,
        spawnFn: fakeSpawn,
        userEnvReader: NO_ENV_READER,
      }),
      (e) => {
        assert.equal(e.name, "DispatchCwdNotFoundError");
        assert.equal(e.reasonCode, "dispatch_cwd_not_found");
        assert.ok(e.message.includes(fileCwd), "the offending path is named");
        return true;
      },
    );
    assert.equal(calls.length, 0, "zero forks");
    assert.deepEqual(listTranscripts(join(dir, "runs")), [], "zero transcripts");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 2. Acceptance faces — existing cwds dispatch exactly as before
// =====================================================================

test("CE-4: relative cwd that exists (\".\") → accepted, threaded verbatim to the runner argv", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ce4-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const result = await dispatchRun({
      agentId: "coder_low",
      prompt: "x",
      registryPath,
      runDir: join(dir, "runs"),
      cwd: ".",
      spawnFn: fakeSpawn,
      userEnvReader: NO_ENV_READER,
    });
    assert.equal(result.accepted, true, "a relative-but-existing cwd dispatches as before");
    assert.equal(calls.length, 1, "detached runner forked exactly once");
    const cwdIdx = calls[0].args.indexOf("--cwd");
    assert.ok(cwdIdx >= 0, "explicit cwd threaded");
    assert.equal(calls[0].args[cwdIdx + 1], ".", "threaded verbatim (resolution stays runner-side, spawn semantics)");
  } finally {
    cleanupDir(dir);
  }
});

test("CE-5: legit absolute cwd (real directory) → accepted (regression)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ce5-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const targetProject = join(dir, "target-project");
    mkdirSync(targetProject, { recursive: true });
    const result = await dispatchRun({
      agentId: "coder_low",
      prompt: "deliver",
      registryPath,
      runDir: join(dir, "runs"),
      cwd: targetProject,
      spawnFn: fakeSpawn,
      userEnvReader: NO_ENV_READER,
    });
    assert.equal(result.accepted, true);
    assert.equal(calls.length, 1);
    const events = await import("../../src/transcript.js").then((m) => m.readTranscript(join(dir, "runs", `${result.runId}.jsonl`)));
    const submitted = events.find((e) => e.type === "run.background_submitted");
    assert.equal(submitted.cwd, targetProject, "ownership record still built from the explicit cwd");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 3. Slot discipline — the refusal precedes every sessionReuse/lineage claim
// =====================================================================

test("CE-6: sessionReuse agent + bad explicit cwd → typed refusal BEFORE the reuse slot is claimed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ce6-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, {
      researcher: { backend: "claude-code", cwd: dir, sessionReuse: "lead_workspace" },
    });
    const runDir = join(dir, "runs");
    const badCwd = join(dir, "no-such-workspace");
    await assert.rejects(
      () => dispatchRun({
        agentId: "researcher",
        prompt: "q",
        registryPath,
        runDir,
        cwd: badCwd,
        leadSession: "lead-CE6",
        spawnFn: fakeSpawn,
        userEnvReader: NO_ENV_READER,
      }),
      (e) => e.name === "DispatchCwdNotFoundError",
    );
    // The reuse routing store is only created when a slot is CLAIMED
    // (resolveReuseTurn → writeEntry mkdir). No store dir ⇒ no slot occupied.
    assert.equal(existsSync(join(runDir, ".session-reuse")), false, "no sessionReuse routing slot claimed");
    assert.deepEqual(listTranscripts(runDir), [], "zero transcripts");
    assert.equal(calls.length, 0, "zero forks");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 4. CLI end-to-end — the typed message reaches stderr, the run-dir stays empty
// =====================================================================

test("CE-7: CLI e2e — run --background + bad-cwd registry fixture → exit non-zero, stderr typed + path, run-dir zero .jsonl", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ce7-"));
  try {
    // Registry fixture reproducing the defect shape: the agent's cwd is a path
    // that does not exist; the dispatch carries no explicit --cwd.
    const registryPath = makeRegistry(dir, {
      researcher: { backend: "claude-code", cwd: PLACEHOLDER_CWD },
    });
    const runDir = join(dir, "runs");
    const r = spawnSync(process.execPath, [
      "src/cli.js", "run", "researcher",
      "--prompt", "x",
      "--background",
      "--registry", registryPath,
      "--run-dir", runDir,
    ], { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" }, timeout: 30000 });
    assert.notEqual(r.status, 0, "the refused dispatch must exit non-zero");
    assert.match(r.stderr, /dispatch_cwd_not_found/, "stderr carries the closed-set reason code");
    assert.match(r.stderr, /DispatchCwdNotFoundError|dispatch working directory does not exist/, "stderr carries the typed refusal");
    assert.ok(r.stderr.includes(resolve(PLACEHOLDER_CWD)), `stderr names the resolved path (${resolve(PLACEHOLDER_CWD)})`);
    assert.doesNotMatch(r.stderr, /node\.exe ENOENT/, "no raw libuv spawn error blaming the executable — the defect's misleading face");
    assert.doesNotMatch(r.stdout, /"runId"/, "no ghost runId printed for a refused dispatch");
    assert.deepEqual(listTranscripts(runDir), [], "run-dir has zero .jsonl — no orphaned pending transcript");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 5. Typed class shape (mirrors DC-7)
// =====================================================================

test("CE-8: DispatchCwdNotFoundError is a typed error with stable name/reasonCode and diagnostic payload", () => {
  const err = new DispatchCwdNotFoundError("D:\\x\\no-such-dir", "flag");
  assert.ok(err instanceof Error);
  assert.equal(err.name, "DispatchCwdNotFoundError", "stable error.name for scriptable capture");
  assert.equal(err.reasonCode, "dispatch_cwd_not_found", "closed-set reason code");
  assert.match(err.message, /^dispatch working directory does not exist: /, "message states the fact");
  assert.ok(err.message.includes("D:\\x\\no-such-dir"), "message carries the resolved absolute path");
  assert.ok(err.message.includes("--cwd flag"), "message labels the --cwd flag source");
  assert.match(err.message, /point --cwd at an existing directory/, "flag-source fix guidance");
  assert.ok(err.message.includes("before any side effect"), "states the zero-side-effect refusal semantics");
  assert.equal(err.cwdSource, "flag");
  assert.equal(err.resolvedPath, "D:\\x\\no-such-dir");
  // Registry-source variant labels the other source with its own fix guidance.
  const reg = new DispatchCwdNotFoundError("D:\\x\\no-such-dir", "registry");
  assert.ok(reg.message.includes("agent registry entry cwd"), "registry-source label");
  assert.match(reg.message, /fix the registry entry's cwd/, "registry-source fix guidance");
  assert.equal(reg.cwdSource, "registry");
  // Identical inputs → identical message (deterministic text; the dynamic part
  // is bounded to the path + source label only).
  assert.equal(new DispatchCwdNotFoundError("D:\\x\\no-such-dir", "flag").message, err.message);
});

// =====================================================================
// 6. Usage page (mirrors DC-8)
// =====================================================================

test("CE-9: the run usage page documents the --cwd existence requirement", async () => {
  const { RUN_USAGE_TEXT } = await import("../../src/cliHelp.js");
  assert.match(
    RUN_USAGE_TEXT,
    /--cwd DIR\s+target project directory \(required for --background delivery runs\) — must be an existing directory/,
    "--cwd line carries the existence requirement",
  );
  assert.match(
    RUN_USAGE_TEXT,
    /a missing or non-directory path is refused at dispatch before any side effect/,
    "the refusal semantics are spelled out",
  );
});

// =====================================================================
// 7. Priority pins — the existing non-empty refusals keep their faces
// =====================================================================

test("CE-10: sessionReuse agent, no explicit cwd, EXISTING registry cwd → still SessionReuseWorkspaceRequiredError (priority unchanged)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ce10-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    // The registry cwd EXISTS, so the existence check is a silent no-op and the
    // pre-existing non-empty refusal (TD-110) still owns this face, byte-identical.
    const registryPath = makeRegistry(dir, {
      researcher: { backend: "claude-code", cwd: dir, sessionReuse: "lead_workspace" },
    });
    await assert.rejects(
      () => dispatchRun({
        agentId: "researcher",
        prompt: "q",
        registryPath,
        runDir: join(dir, "runs"),
        leadSession: "lead-CE10",
        // no cwd — the SessionReuseWorkspaceRequiredError face
        spawnFn: fakeSpawn,
        userEnvReader: NO_ENV_READER,
      }),
      (e) => {
        assert.ok(e instanceof SessionReuseWorkspaceRequiredError, "the pre-existing typed refusal, not the existence check");
        assert.equal(e.name, "SessionReuseWorkspaceRequiredError");
        assert.match(e.message, /bound workspace \(cwd\) is required for a sessionReuse agent/);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  } finally {
    cleanupDir(dir);
  }
});

test("CE-11: an agent registry entry without any cwd is rejected by the registry SSOT — the existence check never sees it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ce11-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    // "Both cwds missing" (explicit absent + agent field absent) cannot reach
    // dispatchRun's predicted-cwd logic: normalizeAgent requires agent.cwd
    // non-empty at getAgent time. Pin that boundary so the defensive
    // skip-if-both-missing branch in the service stays dead code via registry.
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code" } });
    await assert.rejects(
      () => dispatchRun({
        agentId: "coder_low",
        prompt: "x",
        registryPath,
        runDir: join(dir, "runs"),
        spawnFn: fakeSpawn,
        userEnvReader: NO_ENV_READER,
      }),
      (e) => {
        assert.notEqual(e.name, "DispatchCwdNotFoundError", "not the existence check");
        assert.match(e.message, /missing cwd/, "the registry SSOT owns the missing-cwd entry refusal");
        return true;
      },
    );
    assert.equal(calls.length, 0, "zero forks");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 8. SSOT identity — one class definition, two export surfaces
// =====================================================================

test("CE-12: DispatchCwdNotFoundError exported from runDispatch.js IS the shared SSOT class (no second definition)", async () => {
  const { DispatchCwdNotFoundError: fromSsot } = await import("../../src/runManager.js");
  assert.strictEqual(DispatchCwdNotFoundError, fromSsot, "runDispatch re-exports the shared class, not a copy");
  // The class thrown at dispatch is instanceof the SSOT class — RunManager.start
  // (layer 2) throws the SAME class, pinned end-to-end in
  // runManagerCwdExistence.test.js.
  const err = new DispatchCwdNotFoundError(join(tmpdir(), "wao-ce12-no-such-dir"), "registry");
  assert.ok(err instanceof fromSsot, "instances satisfy the SSOT class identity");
});
