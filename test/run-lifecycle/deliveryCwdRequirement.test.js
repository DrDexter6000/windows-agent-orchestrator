// test/run-lifecycle/deliveryCwdRequirement.test.js
//
// Round 6 Bundle R6-A (F-5-12) — a BACKGROUND delivery dispatch requires an
// explicit --cwd, refused at the CLI argv boundary BEFORE any side effect.
//
// Defect being fixed: `run <agent> --prompt ... --delivery-spec-file ... --isolate
// --background` (no --cwd) used to be accepted and run the WHOLE execution chain
// (worktree/fork/worker tokens/packaging/verification); only `runs delivery review`
// then failed with "malformed ownership: run.background_submitted.cwd is missing
// or empty" — because dispatchRun builds that ownership record from the dispatch
// cwd alone. The fix refuses at dispatch time with the typed closed-set error
// DeliveryCwdRequiredError (SSOT: src/application/runDispatch.js), thrown by the
// argv gate in src/commands/run.js runCommand before loadDeliverySpec /
// loadPrompt / dispatchRun (zero transcript, zero fork, zero worktree).
//
// Boundaries pinned here:
//   1. CLI argv gate      — --background + --delivery-spec-file + no --cwd →
//      typed error, zero transcript files, dispatchRun never entered (proved by
//      a nonexistent registry path still yielding the typed error — readRegistry
//      inside dispatchRun would have failed differently).
//   2. Gate ordering      — the gate precedes prompt/spec file reads (mirrors
//      the M10-pre closeout-3 discipline proven for the timeout checks).
//   3. Contrast: accepted — delivery + explicit --cwd → dispatchRun accepts and
//      background_submitted.cwd IS the explicit cwd (the ownership SSOT resolves
//      it — no malformed-ownership failure downstream).
//   4. Contrast: accepted — NO delivery + NO --cwd → dispatchRun accepts as
//      before (the ordinary-run default resolution is untouched).
//   5. Scope pin          — foreground delivery without --cwd is NOT gated here
//      (its ownership authority is run.started.cwd, a complete fact); it still
//      reaches its own pre-existing checks ("delivery mode requires --isolate").
//   6. Defect anchor      — a background_submitted fact without cwd is exactly
//      the late "malformed ownership" rejection (findRunWorkspaceOwnership SSOT)
//      the gate exists to prevent.
//
// Pure group: temp fixtures under os.tmpdir(), fakeSpawn injection, zero git,
// zero subprocess, zero provider token.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchRun, DeliveryCwdRequiredError } from "../../src/application/runDispatch.js";
import { runCommand } from "../../src/commands/run.js";
import { readTranscript } from "../../src/transcript.js";
import { findRunWorkspaceOwnership } from "../../src/application/runWorkspaceOwnership.js";

// ===== Helpers =====

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

function makeDeliverySpec(dir) {
  const spec = join(dir, "delivery-spec.json");
  writeFileSync(spec, JSON.stringify({
    mode: "git_commit_v1",
    allowedPaths: ["src"],
    verificationCommands: ["node --test"],
  }), "utf8");
  return spec;
}

/** List the .jsonl transcripts in a runs dir (empty list if the dir is absent). */
function listTranscripts(runDir) {
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir).filter((f) => f.endsWith(".jsonl"));
}

const NO_ENV_READER = async () => ({});

// =====================================================================
// 1. CLI argv gate — typed refusal, zero side effects
// =====================================================================

test("DC-1: run --background + --delivery-spec-file without --cwd → typed DeliveryCwdRequiredError, zero transcript, no dispatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dc1-"));
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const spec = makeDeliverySpec(dir);
    const runDir = join(dir, "runs");
    await assert.rejects(
      () => runCommand([
        "coder_low", "--prompt", "x",
        "--delivery-spec-file", spec,
        "--isolate",
        "--background",
        "--registry", registryPath,
        "--run-dir", runDir,
      ], {}),
      (e) => {
        assert.equal(e.name, "DeliveryCwdRequiredError", "typed closed-set error identity");
        assert.equal(e.reasonCode, "delivery_cwd_required", "closed-set reason code");
        assert.match(e.message, /--cwd/, "the fixed text names the missing flag");
        assert.match(e.message, /run\.background_submitted\.cwd/, "the fixed text names the record built from it");
        return true;
      },
    );
    assert.deepEqual(listTranscripts(runDir), [], "zero transcript files (runs dir never created — no orphaned pending run)");
  } finally {
    cleanupDir(dir);
  }
});

test("DC-2: the gate precedes ALL file reads — nonexistent prompt/spec/registry still yield the typed error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dc2-"));
  try {
    // Everything downstream is deliberately broken: a nonexistent --prompt-file
    // (loadPrompt), a nonexistent --delivery-spec-file (loadDeliverySpec), and a
    // nonexistent --registry (readRegistry INSIDE dispatchRun — the only spawn
    // path). Getting the typed error anyway proves the gate fired first: no
    // ENOENT, no spec parse error, and dispatchRun was never entered ⇒ no fork.
    await assert.rejects(
      () => runCommand([
        "coder_low",
        "--prompt-file", join(dir, "no-such-prompt.txt"),
        "--delivery-spec-file", join(dir, "no-such-spec.json"),
        "--isolate",
        "--background",
        "--registry", join(dir, "no-such-agents.json"),
        "--run-dir", join(dir, "runs"),
      ], {}),
      (e) => {
        assert.equal(e.name, "DeliveryCwdRequiredError");
        assert.doesNotMatch(e.message, /ENOENT|no such file/i, "not a file-read error — the gate ran first");
        return true;
      },
    );
    assert.equal(existsSync(join(dir, "runs")), false, "no runs dir created");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 2. Contrast — delivery + explicit --cwd is accepted, ownership complete
// =====================================================================

test("DC-3: delivery + explicit --cwd → dispatchRun accepts; background_submitted.cwd IS the explicit cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dc3-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const runDir = join(dir, "runs");
    const targetProject = join(dir, "target-project"); // the explicit --cwd value
    const result = await dispatchRun({
      agentId: "coder_low",
      prompt: "deliver",
      registryPath,
      runDir,
      cwd: targetProject,
      delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] },
      spawnFn: fakeSpawn,
      userEnvReader: NO_ENV_READER,
    });
    assert.equal(result.accepted, true, "accepted with the explicit --cwd");
    assert.equal(calls.length, 1, "detached runner forked exactly once");
    const argv = calls[0].args;
    assert.ok(argv.includes("--delivery-json"), "delivery payload threaded");
    const cwdIdx = argv.indexOf("--cwd");
    assert.ok(cwdIdx >= 0, "explicit cwd threaded to the runner argv");
    assert.equal(argv[cwdIdx + 1], targetProject);

    // The ownership record is complete: the review-time SSOT resolves it instead
    // of throwing the malformed-ownership failure that motivated this fix.
    const events = await readTranscript(join(runDir, `${result.runId}.jsonl`));
    const submitted = events.find((e) => e.type === "run.background_submitted");
    assert.equal(submitted.deliveryRequested, true);
    assert.equal(submitted.cwd, targetProject, "run.background_submitted.cwd is the explicit --cwd");
    const ownership = findRunWorkspaceOwnership(events, result.runId);
    assert.equal(ownership.via, "run.background_submitted");
    assert.equal(ownership.cwd, targetProject, "ownership SSOT accepts the record — no late failure");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 3. Contrast — ordinary run without delivery and without --cwd unchanged
// =====================================================================

test("DC-4: NO delivery + NO --cwd → dispatchRun accepts as before (default resolution untouched)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dc4-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const result = await dispatchRun({
      agentId: "coder_low",
      prompt: "ordinary task",
      registryPath,
      runDir: join(dir, "runs"),
      spawnFn: fakeSpawn,
      userEnvReader: NO_ENV_READER,
    });
    assert.equal(result.accepted, true, "ordinary background dispatch accepted without --cwd");
    assert.equal(calls.length, 1);
    const argv = calls[0].args;
    assert.ok(!argv.includes("--delivery-json"), "no delivery payload");
    const events = await readTranscript(join(dir, "runs", `${result.runId}.jsonl`));
    const submitted = events.find((e) => e.type === "run.background_submitted");
    assert.equal(submitted.deliveryRequested, false, "not a delivery run — the gate's defect face does not apply");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 4. Scope pin — the gate is the BACKGROUND dispatch face only
// =====================================================================

test("DC-5: foreground delivery without --cwd is NOT gated — it still reaches its own pre-existing checks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dc5-"));
  try {
    const spec = makeDeliverySpec(dir);
    // Foreground (no --background), no --cwd, no --isolate → the PRE-EXISTING
    // "delivery mode requires --isolate" refusal. Proves the new gate did not
    // hijack the foreground path (its ownership authority is run.started.cwd,
    // recorded from the resolved agent cwd — a complete fact).
    await assert.rejects(
      () => runCommand([
        "coder_low", "--prompt", "x",
        "--delivery-spec-file", spec,
        "--registry", join(dir, "no-such-agents.json"),
        "--run-dir", join(dir, "runs"),
      ], {}),
      (e) => {
        assert.notEqual(e.name, "DeliveryCwdRequiredError", "foreground is not the gated face");
        assert.match(e.message, /delivery mode requires --isolate/, "pre-existing foreground check still owns the refusal");
        return true;
      },
    );
    assert.equal(existsSync(join(dir, "runs")), false, "zero side effects on the refusal path");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 5. Defect anchor — the late failure the gate prevents
// =====================================================================

test("DC-6: a background_submitted fact without cwd is exactly the late 'malformed ownership' rejection", () => {
  // The durable shape a no---cwd delivery dispatch USED to produce: delivery
  // requested, ownership record incomplete. The review-time SSOT rejects it —
  // this is the failure that used to surface only after the worker burned the
  // full execution chain.
  const events = [{
    type: "run.background_submitted",
    runId: "run_20260816090000000dc6defect",
    agentId: "coder_low",
    background: true,
    deliveryRequested: true,
    // cwd intentionally absent — the defect shape.
  }];
  assert.throws(
    () => findRunWorkspaceOwnership(events, "run_20260816090000000dc6defect"),
    /malformed ownership: run\.background_submitted\.cwd is missing or empty/,
    "the exact late-failure text from the reproduced defect",
  );
});

// =====================================================================
// 6. Typed class shape + usage-page documentation
// =====================================================================

test("DC-7: DeliveryCwdRequiredError is a closed-set typed error exported from the dispatch SSOT", () => {
  const err = new DeliveryCwdRequiredError();
  assert.ok(err instanceof Error);
  assert.equal(err.name, "DeliveryCwdRequiredError", "stable error.name for scriptable capture");
  assert.equal(err.reasonCode, "delivery_cwd_required", "closed-set reason code");
  assert.match(err.message, /^delivery run requires an explicit --cwd/, "fixed self-explaining text");
  assert.ok(err.message.includes("run.background_submitted.cwd"), "names the record built from the flag");
  assert.ok(err.message.includes("before any side effect"), "states the zero-side-effect refusal semantics");
  // Two throws carry the identical fixed text (closed set — no dynamic payload).
  assert.equal(new DeliveryCwdRequiredError().message, err.message);
});

test("DC-8: the run usage page documents the --cwd requirement for --background delivery runs", async () => {
  const { RUN_USAGE_TEXT } = await import("../../src/cliHelp.js");
  assert.match(
    RUN_USAGE_TEXT,
    /--cwd DIR\s+target project directory \(required for --background delivery runs\)/,
    "--cwd line carries the requirement",
  );
  assert.match(
    RUN_USAGE_TEXT,
    /--delivery-spec-file FILE\s+delivery mode spec \(requires --isolate; a --background delivery run also requires --cwd\)/,
    "--delivery-spec-file line cross-references the requirement",
  );
  assert.match(
    RUN_USAGE_TEXT,
    /--background delivery run additionally requires an explicit --cwd/,
    "Notes explain the ownership record the flag feeds",
  );
});
