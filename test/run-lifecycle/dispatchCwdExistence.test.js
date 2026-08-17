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
//   3b. Capability symmetry (R7-C C-2) — an HTTP-shape backend (opencode-serve,
//      no preflightInvocation) is exempt at layer 1 exactly as at layer 2: a
//      bad registry cwd does NOT refuse the dispatch (CE-13).
//   4b. Priority in the corner (R7-C C-3) — a sessionReuse agent with NO
//      explicit cwd AND a bad registry cwd refuses with the TD-110 typed
//      SessionReuseWorkspaceRequiredError, not the existence error (CE-14).
//   5. CLI end-to-end     — `run --background` with a bad-cwd registry fixture
//      exits non-zero, prints the typed message + resolved path on stderr, and
//      leaves the run-dir empty (CE-7).
//   6. Typed class shape  — stable name/reasonCode, path + source + fix
//      guidance in the message, identical text for identical inputs (CE-8);
//      the runDispatch export IS the shared SSOT class (CE-12).
//   7. Usage page         — RUN_USAGE_TEXT documents the existence requirement
//      on the --cwd line (CE-9).
//   11. R10-A model override — per-dispatch --model threading + refusals at
//      the dispatch service / detached runner / RunManager.start authorities:
//      argv pair + effectiveModel echo (MO-1), byte-compat without the flag
//      (MO-2), SSOT shape gate (MO-3), reuse/lineage typed conflict with zero
//      side effects (MO-4/MO-5), the runner→start synthesis chain (MO-6),
//      start-level authoritative refusals (MO-7), sibling-field preservation
//      incl. opencode-serve and no-model shapes (MO-8).
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

import { readTranscript } from "../../src/transcript.js";
import { RunManager } from "../../src/runManager.js";
import { runBackground } from "../../src/backgroundRunner.js";
import { dispatchRun, DispatchCwdNotFoundError, SessionReuseWorkspaceRequiredError, ModelOverrideConflictError } from "../../src/application/runDispatch.js";

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
// researcher entry, pre-R8-1). The shipped template has since been de-placeholdered
// (cwd "." everywhere); these self-built fixtures keep the historical shape purely
// as a deterministic never-exists-on-disk path. Never created on disk here.
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
  // R7-C (C-9): "refused at dispatch" alone misdescribes the foreground family
  // (run/workflow/daemon start never go through the dispatch service — they
  // are refused at START). The precise shared phrasing is dispatch/start.
  assert.match(
    RUN_USAGE_TEXT,
    /a missing or non-directory path is refused at dispatch\/start before any side effect/,
    "the refusal semantics are spelled out (dispatch for background, start for foreground/resume)",
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
// 10b. Registry SSOT fail-closed (R7-C C-8) — a non-string cwd is rejected,
//      never silently skipped by the existence check
// =====================================================================

test("CE-15: non-string cwd ({} / 42) in a registry entry → normalizeAgent rejects; the dispatch never reaches the existence check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ce15-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    // Pre-C-8 a truthy non-string cwd ({} / 42 / true) passed the registry's
    // truthiness check AND silently skipped the R7-AB existence assert
    // (resolvePredictedDispatchCwd only recognizes strings) — a malformed
    // entry dodged both defenses. The registry SSOT now fail-closes it, the
    // same surface `registry validate` reads (listAgents → normalizeAgent).
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: {} } });
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
        assert.match(e.message, /cwd must be a non-empty string/, "the registry SSOT owns the non-string-cwd refusal");
        return true;
      },
    );
    assert.equal(calls.length, 0, "zero forks");
    // The same SSOT face `registry validate` walks (listAgents normalizes
    // every entry) — the refusal is visible there too, not only at dispatch.
    const { readRegistry } = await import("../../src/registry.js");
    const registry = await readRegistry(registryPath);
    assert.throws(
      () => registry.listAgents(),
      /cwd must be a non-empty string/,
      "listAgents (the validate surface) rejects the non-string cwd",
    );
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

// =====================================================================
// 9. Capability symmetry (R7-C C-2) — HTTP backends exempt at layer 1 too
// =====================================================================

test("CE-13: opencode-serve agent (no preflightInvocation) + nonexistent registry cwd → NOT refused, forks exactly as before", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ce13-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    // Symmetry pin: layer 2 (RunManager.start, runManager.js) keys the cwd
    // gate on the declared preflightInvocation capability — an HTTP backend
    // (opencode-serve) threads cwd to the serve API as a REMOTE directory
    // hint, never spawns a local process with that cwd, and is exempt. Layer
    // 1 must not be stricter than layer 2 (the C-2 asymmetry): dispatching
    // the example registry's coder_opencode_fallback shape with a registry
    // cwd that does not exist locally must dispatch exactly as pre-R7 — the
    // detached runner forks; whether the REMOTE directory exists is the serve
    // side's business, not a local spawn failure.
    const registryPath = makeRegistry(dir, {
      coder_opencode_fallback: {
        backend: "opencode-serve",
        cwd: PLACEHOLDER_CWD,
        serveUrl: "http://127.0.0.1:4297",
        model: { providerID: "zhipuai-coding-plan", id: "glm-5.2" },
      },
    });
    const runDir = join(dir, "runs");
    const result = await dispatchRun({
      agentId: "coder_opencode_fallback",
      prompt: "x",
      registryPath,
      runDir,
      spawnFn: fakeSpawn,
      userEnvReader: NO_ENV_READER,
    });
    assert.equal(result.accepted, true, "the HTTP-shape dispatch is NOT refused by the local cwd gate");
    assert.equal(calls.length, 1, "the detached runner forked exactly once");
    assert.equal(calls[0].args.includes("--cwd"), false, "no explicit --cwd was supplied to thread");
    const transcripts = listTranscripts(runDir);
    assert.equal(transcripts.length, 1, "the dispatch transcript was written as usual");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 10. Priority in the corner (R7-C C-3) — TD-110 typed error keeps its face
// =====================================================================

test("CE-14: sessionReuse agent + NO explicit cwd + nonexistent registry cwd → SessionReuseWorkspaceRequiredError (NOT the existence error), zero transcript, zero slot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ce14-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    // The corner R7-AB broke: pre-R7 the TD-110 (D2 A3) typed refusal owned
    // the no-explicit-cwd sessionReuse face regardless of the registry cwd's
    // existence; R7-AB's layer-1 assert fired first when the registry cwd was
    // also bad, losing the documented contract (CLI --cwd guidance). C-3
    // hoists the typed throw ABOVE the existence assert — same face as CE-10,
    // now pinned in the bad-registry-cwd corner too.
    const registryPath = makeRegistry(dir, {
      researcher: { backend: "claude-code", cwd: PLACEHOLDER_CWD, sessionReuse: "lead_workspace" },
    });
    const runDir = join(dir, "runs");
    await assert.rejects(
      () => dispatchRun({
        agentId: "researcher",
        prompt: "q",
        registryPath,
        runDir,
        leadSession: "lead-CE14",
        // no cwd — the SessionReuseWorkspaceRequiredError face
        spawnFn: fakeSpawn,
        userEnvReader: NO_ENV_READER,
      }),
      (e) => {
        assert.ok(e instanceof SessionReuseWorkspaceRequiredError,
          "the TD-110 typed refusal owns the corner, not the existence check");
        assert.equal(e.name, "SessionReuseWorkspaceRequiredError");
        assert.notEqual(e.name, "DispatchCwdNotFoundError");
        assert.match(e.message, /bound workspace \(cwd\) is required for a sessionReuse agent/);
        return true;
      },
    );
    assert.equal(existsSync(join(runDir, ".session-reuse")), false, "no sessionReuse routing slot claimed (hoist precedes resolveReuseTurn)");
    assert.deepEqual(listTranscripts(runDir), [], "zero transcripts");
    assert.equal(calls.length, 0, "zero forks");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 11. R10-A — per-dispatch model override (--model / run_dispatch `model`)
//
// Owner decision 2026-08-17: a single-dispatch, never-persisted model id
// override. Design invariants pinned here:
//   - the override replaces ONLY model.id; siblings (contextWindow /
//     providerID / variant) survive the synthesis (coder_low breakpoint E);
//   - the background chain threads it CLI → dispatchRun --model argv →
//     backgroundRunner parseSimpleFlags → RunManager.start synthesis;
//   - two hard mutual exclusions refuse fail-fast with ZERO side effects:
//     × requireCertified (cert matrix is per provider+model) and × either
//     provider-session reuse shape (one conversation, one model);
//   - the shape SSOT (runManager.js) is enforced at every boundary because
//     a "--"-prefixed value would split parseSimpleFlags' flag pair.
// =====================================================================

const MODEL_OVERRIDE_INVALID_RE = /--model must be a non-empty string of at most 128 characters/;

test("MO-1: dispatchRun modelOverride → runner argv carries the --model pair; effectiveModel echo preserves siblings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mo1-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, {
      coder_low: { backend: "claude-code", cwd: dir, model: { id: "glm-5.3", contextWindow: 1000000 } },
    });
    const runDir = join(dir, "runs");
    const result = await dispatchRun({
      agentId: "coder_low",
      prompt: "x",
      registryPath,
      runDir,
      modelOverride: "gpt-5.6-sol-xhigh",
      spawnFn: fakeSpawn,
      userEnvReader: NO_ENV_READER,
    });
    assert.equal(result.accepted, true);
    assert.equal(calls.length, 1, "detached runner forked exactly once");
    const modelIdx = calls[0].args.indexOf("--model");
    assert.ok(modelIdx >= 0, "runner argv carries --model");
    assert.equal(calls[0].args[modelIdx + 1], "gpt-5.6-sol-xhigh", "threaded verbatim");
    // Effective model echo: id replaced, contextWindow (the GLM [1m] shape)
    // PRESERVED — a shallow getAgent-style swap would drop it and go red here.
    assert.deepEqual(result.effectiveModel, { id: "gpt-5.6-sol-xhigh", contextWindow: 1000000 });
  } finally {
    cleanupDir(dir);
  }
});

test("MO-2: dispatchRun WITHOUT modelOverride stays byte-compatible (no --model argv, no effectiveModel)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mo2-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, {
      coder_low: { backend: "claude-code", cwd: dir, model: { id: "glm-5.3" } },
    });
    const result = await dispatchRun({
      agentId: "coder_low",
      prompt: "x",
      registryPath,
      runDir: join(dir, "runs"),
      spawnFn: fakeSpawn,
      userEnvReader: NO_ENV_READER,
    });
    assert.equal(result.accepted, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.includes("--model"), false, "no --model in the ordinary dispatch argv");
    assert.equal("effectiveModel" in result, false, "no effectiveModel field on the ordinary dispatch result");
  } finally {
    cleanupDir(dir);
  }
});

test("MO-3: dispatchRun re-checks the SSOT shape gate — bad ids refuse fixed-text, zero transcript, zero fork", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mo3-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const runDir = join(dir, "runs");
    for (const bad of ["--next-flag", "has space", "", "x".repeat(129), true, { id: "x" }]) {
      await assert.rejects(
        () => dispatchRun({
          agentId: "coder_low",
          prompt: "x",
          registryPath,
          runDir,
          modelOverride: bad,
          spawnFn: fakeSpawn,
          userEnvReader: NO_ENV_READER,
        }),
        (e) => {
          assert.match(e.message, MODEL_OVERRIDE_INVALID_RE, `fixed safe text for ${JSON.stringify(bad)}`);
          assert.doesNotMatch(e.message, /next-flag/, "never echoes the supplied value");
          return true;
        },
      );
    }
    assert.deepEqual(listTranscripts(runDir), [], "zero transcripts across all refusals");
    assert.equal(calls.length, 0, "zero forks");
  } finally {
    cleanupDir(dir);
  }
});

test("MO-4: lead_workspace reuse agent × modelOverride → typed ModelOverrideConflictError BEFORE any slot/transcript/fork", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mo4-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, {
      researcher: { backend: "claude-code", cwd: dir, sessionReuse: "lead_workspace" },
    });
    const runDir = join(dir, "runs");
    await assert.rejects(
      () => dispatchRun({
        agentId: "researcher",
        prompt: "q",
        registryPath,
        runDir,
        cwd: dir,
        leadSession: "lead-MO4",
        modelOverride: "glm-5.3",
        spawnFn: fakeSpawn,
        userEnvReader: NO_ENV_READER,
      }),
      (e) => {
        assert.ok(e instanceof ModelOverrideConflictError, "the typed conflict error owns this face");
        assert.equal(e.name, "ModelOverrideConflictError");
        assert.equal(e.reasonCode, "model_override_reuse_conflict", "closed-set reason code");
        assert.equal(e.reuseShape, "lead_workspace", "carries the reuse shape");
        assert.match(e.message, /mutually exclusive with provider-session reuse/);
        return true;
      },
    );
    assert.equal(existsSync(join(runDir, ".session-reuse")), false, "no reuse routing slot claimed");
    assert.deepEqual(listTranscripts(runDir), [], "zero transcripts");
    assert.equal(calls.length, 0, "zero forks");
  } finally {
    cleanupDir(dir);
  }
});

test("MO-5: continuable delivery root × modelOverride → typed conflict (run_lineage), zero transcript, zero fork", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mo5-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const runDir = join(dir, "runs");
    await assert.rejects(
      () => dispatchRun({
        agentId: "coder_low",
        prompt: "q",
        registryPath,
        runDir,
        cwd: dir,
        leadSession: "lead-MO5",
        continuable: true,
        delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"] },
        modelOverride: "glm-5.3",
        spawnFn: fakeSpawn,
        userEnvReader: NO_ENV_READER,
        // capability seam: only the supportsSessionReuse boolean is read
        // before the refusal fires
        backendFor: () => ({ supportsSessionReuse: true }),
      }),
      (e) => {
        assert.equal(e.name, "ModelOverrideConflictError");
        assert.equal(e.reuseShape, "run_lineage", "the lineage shape is named");
        return true;
      },
    );
    assert.equal(existsSync(join(runDir, ".session-reuse")), false, "no lineage slot claimed");
    assert.deepEqual(listTranscripts(runDir), [], "zero transcripts");
    assert.equal(calls.length, 0, "zero forks");
  } finally {
    cleanupDir(dir);
  }
});

test("MO-6: runBackground threads modelOverride → RunManager.start synthesis; run.started carries model + modelOverride", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mo6-"));
  const runDir = join(dir, "runs");
  try {
    const spawnedModels = [];
    const fakeBackend = {
      validateAgentPolicy(agent) {
        // The synthesized policy MUST reach the ordinary validation surface —
        // a no-model registry entry synthesizes a bare {id}, which flips
        // hasStructuredPolicy true. Receiving it here proves the synthesis
        // happened BEFORE validateAgentPolicy.
        assert.ok(agent.model && typeof agent.model.id === "string", "synthesized model present at policy validation");
      },
      async spawn(agent) {
        spawnedModels.push(agent.model);
        return {
          backend: "claude-code",
          backendSessionId: "s_mo6",
          messageId: "m_mo6",
          admittedSeq: 1,
          async *events() {
            yield { kind: "done", reason: "completed" };
          },
          abort: async () => {},
          isAlive: () => false,
        };
      },
    };
    const result = await runBackground({
      agentId: "mo_worker",
      prompt: "x",
      registry: { agents: { mo_worker: { backend: "claude-code", cwd: dir, model: { id: "glm-5.3", contextWindow: 1000000 } } } },
      runDir,
      modelOverride: "gpt-5.6-sol-xhigh",
      backendFor: () => fakeBackend,
      waitTimeout: 3000,
      pollInterval: 10,
    });
    assert.equal(result.completed, true, `run completes (error: ${result.error})`);
    assert.deepEqual(spawnedModels, [{ id: "gpt-5.6-sol-xhigh", contextWindow: 1000000 }],
      "the spawn authority received the synthesized policy — id replaced, contextWindow preserved");
    const events = await readTranscript(join(runDir, `${result.runId}.jsonl`));
    const started = events.find((e) => e.type === "run.started");
    assert.deepEqual(started.model, { id: "gpt-5.6-sol-xhigh", contextWindow: 1000000 },
      "run.started.model reflects the synthesized policy (append after synthesis)");
    assert.equal(started.modelOverride, "gpt-5.6-sol-xhigh",
      "run.started carries the EXPLICIT override fact (auditable one-off vs registry change)");
  } finally {
    cleanupDir(dir);
  }
});

test("MO-6b: runBackground WITHOUT modelOverride stays byte-compatible (run.started has no modelOverride field)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mo6b-"));
  const runDir = join(dir, "runs");
  try {
    const fakeBackend = {
      // the registry entry declares a model policy, so the (fake) backend must
      // declare the ordinary validation capability — pre-existing semantics,
      // unchanged by R10-A (no synthesis happens without the override).
      validateAgentPolicy() {},
      async spawn(agent) {
        return {
          backend: "claude-code",
          backendSessionId: "s_mo6b",
          messageId: "m_mo6b",
          admittedSeq: 1,
          async *events() {
            yield { kind: "done", reason: "completed" };
          },
          abort: async () => {},
          isAlive: () => false,
        };
      },
    };
    const result = await runBackground({
      agentId: "mo_worker",
      prompt: "x",
      registry: { agents: { mo_worker: { backend: "claude-code", cwd: dir, model: { id: "glm-5.3" } } } },
      runDir,
      backendFor: () => fakeBackend,
      waitTimeout: 3000,
      pollInterval: 10,
    });
    assert.equal(result.completed, true, `run completes (error: ${result.error})`);
    const events = await readTranscript(join(runDir, `${result.runId}.jsonl`));
    const started = events.find((e) => e.type === "run.started");
    assert.equal("modelOverride" in started, false, "ordinary dispatches keep the run.started payload byte-shape");
    assert.deepEqual(started.model, { id: "glm-5.3" });
  } finally {
    cleanupDir(dir);
  }
});

test("MO-7: RunManager.start authoritative refusals — certified conflict, reuse conflict, and the shape gate, all zero-side-effect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mo7-"));
  try {
    const runDir = join(dir, "runs");
    const manager = new RunManager({
      config: { registry: "x", runDir, pollInterval: 10, waitTimeout: 3000 },
      readRegistry: async () => ({
        getAgent: (id) => ({ id, backend: "claude-code", cwd: dir, model: { id: "base-id" } }),
        listAgents: () => [],
      }),
      transcriptDir: runDir,
      backendFor: () => ({ validateAgentPolicy() {} }),
    });
    await assert.rejects(
      () => manager.start("a", { prompt: "p", modelOverride: "x-id", requireCertified: true }),
      (e) => {
        assert.match(e.message, /model_override_certified_conflict/, "closed-set certified-conflict code");
        assert.match(e.message, /certification matrix is recorded per provider\+model/, "states the why");
        return true;
      },
    );
    await assert.rejects(
      () => manager.start("a", {
        prompt: "p",
        modelOverride: "x-id",
        sessionReuse: { mode: "lead_workspace", opaqueUuid: "u", turn: "first" },
      }),
      (e) => {
        assert.match(e.message, /model_override_reuse_conflict/, "closed-set reuse-conflict code");
        return true;
      },
    );
    await assert.rejects(
      () => manager.start("a", { prompt: "p", modelOverride: "--bad" }),
      MODEL_OVERRIDE_INVALID_RE,
    );
    assert.deepEqual(listTranscripts(runDir), [], "all three refusals precede every side effect (zero transcripts)");
  } finally {
    cleanupDir(dir);
  }
});

test("MO-8: sibling preservation — opencode-serve {providerID,id,variant} and the no-model tester shape", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mo8-"));
  try {
    const runDir = join(dir, "runs");
    const spawnedModels = [];
    const fakeBackend = {
      validateAgentPolicy() {},
      async spawn(agent) {
        spawnedModels.push(agent.model);
        return {
          backend: "claude-code",
          backendSessionId: "s_mo8",
          messageId: "m_mo8",
          admittedSeq: 1,
          async *events() {
            yield { kind: "done", reason: "completed" };
          },
          abort: async () => {},
          isAlive: () => false,
        };
      },
    };
    const makeManager = (agentEntry) => new RunManager({
      config: { registry: "x", runDir, pollInterval: 10, waitTimeout: 3000 },
      readRegistry: async () => ({ getAgent: (id) => ({ id, ...agentEntry }), listAgents: () => [] }),
      transcriptDir: runDir,
      backendFor: () => fakeBackend,
    });

    // opencode-serve legacy model shape: providerID + variant survive the
    // id replacement (a whole-object swap would silently drop them).
    await makeManager({
      backend: "opencode-serve",
      serveUrl: "http://127.0.0.1:4297",
      cwd: dir,
      model: { providerID: "zhipuai-coding-plan", id: "glm-5.2", variant: "stable" },
    }).start("a", { prompt: "p", modelOverride: "glm-5.3" });
    assert.deepEqual(
      spawnedModels.at(-1),
      { providerID: "zhipuai-coding-plan", id: "glm-5.3", variant: "stable" },
      "opencode-serve shape: only .id replaced, providerID/variant preserved",
    );

    // tester shape (registry entry without any model): synthesizes a bare {id}.
    await makeManager({ backend: "claude-code", cwd: dir }).start("a", { prompt: "p", modelOverride: "probe-model" });
    assert.deepEqual(spawnedModels.at(-1), { id: "probe-model" }, "no-model entry synthesizes {id: override}");
  } finally {
    cleanupDir(dir);
  }
});
