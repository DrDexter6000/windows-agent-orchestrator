// test/runDispatch.test.js
//
// M9-2A: shared background run dispatch application service — TDD tests.
//
// Proves that CLI background dispatch logic is extracted into a shared,
// argv-free, console-free, MCP-free application service that owns:
//   - runId validation (isValidRunId SSOT, before any file write or fork)
//   - transcript creation + initial durable facts (background_submitted → pending)
//   - rejected (terminal transcript) → structured result, no fork
//   - accepted → detached runner spawn (exactly once, full argv, detached/ignore/unref)
//   - requireCertified actually propagated (no longer silently ignored on background path)
//   - no console output, no commands/mcp imports

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscript, findState, findLatest } from "../src/transcript.js";
import { dispatchRun } from "../src/application/runDispatch.js";

// ===== Helpers =====

function makeRegistry(dir, agents) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return registryPath;
}

function makeSummary(runDir, workers) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({ workers }), "utf8");
  return runDir;
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// Fake spawn: records the call and returns a detached-like handle.
function makeFakeSpawn() {
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { unref() {} };
  };
  return { fakeSpawn, calls };
}

// ===== Tests =====

// ---------------------------------------------------------------------
// M9-2A-01: accepted dispatch writes background_submitted + pending before returning,
//           spawns exactly once with detached/ignore/unref semantics.
// ---------------------------------------------------------------------

test("M9-2A-01: accepted dispatch writes initial durable facts and spawns detached runner once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92a-01-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, {
      coder_low: { backend: "claude-code", cwd: dir, args: ["--model", "glm-5-turbo"] },
    });
    const runDir = join(dir, "runs");

    const result = await dispatchRun({
      agentId: "coder_low",
      prompt: "do the task",
      registryPath,
      runDir,
      spawnFn: fakeSpawn,
    });

    assert.equal(result.accepted, true, "dispatch accepted");
    assert.ok(result.runId, "runId returned");
    assert.equal(result.state, "pending", "state is pending");

    // Transcript must already be readable and contain the initial durable facts.
    const transcriptPath = join(runDir, `${result.runId}.jsonl`);
    assert.ok(existsSync(transcriptPath), "transcript file exists before spawn returns");
    const events = await readTranscript(transcriptPath);
    const submitted = findLatest(events, "run.background_submitted");
    const stateChange = events.find((e) => e.type === "run.state_change" && e.to === "pending");
    assert.ok(submitted, "background_submitted written");
    assert.ok(stateChange, "pending state_change written");
    assert.equal(stateChange.reason, "background_spawned", "pending reason is background_spawned");

    // Spawn exactly once, detached + stdio ignore.
    assert.equal(calls.length, 1, "spawn called exactly once");
    const { opts: spawnOpts } = calls[0];
    assert.equal(spawnOpts.detached, true, "detached:true");
    assert.deepEqual(spawnOpts.stdio, "ignore", "stdio:ignore");
    // unref must be called — fakeSpawn returns an object with unref; verify no throw.
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-2A-02: spawn argv is complete — agentId, prompt, run-dir, run-id, registry, timeouts.
// ---------------------------------------------------------------------

test("M9-2A-02: spawn argv carries all required background runner params", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92a-02-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, {
      coder_low: { backend: "claude-code", cwd: dir, args: ["--model", "glm-5-turbo"] },
    });
    const runDir = join(dir, "runs");

    await dispatchRun({
      agentId: "coder_low",
      prompt: "task content",
      registryPath,
      runDir,
      waitTimeout: 90000,
      pollInterval: 2000,
      cwd: dir,
      spawnFn: fakeSpawn,
    });

    assert.equal(calls.length, 1);
    const argv = calls[0].args;
    // Must include runner path, agentId, prompt, run-dir, run-id, registry, timeouts.
    assert.ok(argv.includes("coder_low"), "argv has agentId");
    assert.ok(argv.includes("--prompt"), "argv has --prompt flag");
    assert.ok(argv.includes("task content"), "argv has prompt value");
    assert.ok(argv.includes("--run-dir"), "argv has --run-dir");
    assert.ok(argv.includes(runDir), "argv has runDir value");
    assert.ok(argv.includes("--run-id"), "argv has --run-id");
    assert.ok(argv.includes("--registry"), "argv has --registry");
    assert.ok(argv.includes(registryPath), "argv has registry path");
    assert.ok(argv.includes("--wait-timeout"), "argv has --wait-timeout");
    assert.ok(argv.includes("90000"), "argv has waitTimeout value");
    assert.ok(argv.includes("--poll-interval"), "argv has --poll-interval");
    assert.ok(argv.includes("--cwd"), "argv has --cwd");
    // requireCertified defaults to false → flag must NOT appear when unset.
    assert.ok(!argv.includes("--require-certified"), "no --require-certified when requireCertified is false/default");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-2A-02b: requireCertified:true → argv carries --require-certified.
//            Locks the flag into the runner argv so M9-2A-07's gate proof
//            rests on a verified propagation path, not an assumption.
// ---------------------------------------------------------------------

test("M9-2A-02b: requireCertified:true adds --require-certified to runner argv", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92a-02b-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const runDir = join(dir, "runs");

    await dispatchRun({
      agentId: "coder_low",
      prompt: "x",
      registryPath,
      runDir,
      requireCertified: true,
      spawnFn: fakeSpawn,
    });

    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes("--require-certified"),
      "argv contains --require-certified when requireCertified:true");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-2A-03: terminal transcript → pending rejected, spawn count 0, structured rejection.
// ---------------------------------------------------------------------

test("M9-2A-03: existing terminal transcript rejects pending, no spawn, structured result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92a-03-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, {
      coder_low: { backend: "claude-code", cwd: dir },
    });
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    const runId = "run_preexist_terminal";
    // Pre-seed a terminal transcript so transitionState(null,pending) is rejected.
    const { JsonlTranscript } = await import("../src/transcript.js");
    const t = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId: "coder_low" });
    await t.transitionState(null, "pending", "seed");
    await t.transitionState("pending", "failed", "seed_terminal");

    const result = await dispatchRun({
      agentId: "coder_low",
      prompt: "x",
      registryPath,
      runDir,
      runId,
      spawnFn: fakeSpawn,
    });

    assert.equal(result.accepted, false, "rejected");
    assert.equal(result.runId, runId, "runId echoed");
    assert.ok(result.state, "terminal state reported");
    assert.equal(calls.length, 0, "no spawn when pending rejected");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-2A-04: malicious/path-type/blank runId rejected before file write or spawn.
// ---------------------------------------------------------------------

test("M9-2A-04: malicious runId rejected before any file write or spawn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92a-04-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const runDir = join(dir, "runs");

    const badIds = ["../escape", "run&injected", "run space", "run;rm", "", "run/path", ".hidden", "-dash"];
    for (const bad of badIds) {
      const before = existsSync(runDir) ? runDir : null;
      let threw = false;
      try {
        await dispatchRun({
          agentId: "coder_low",
          prompt: "x",
          registryPath,
          runDir,
          runId: bad,
          spawnFn: fakeSpawn,
        });
      } catch {
        threw = true;
      }
      assert.ok(threw, `malicious runId ${JSON.stringify(bad)} must throw`);
    }
    assert.equal(calls.length, 0, "no spawn for any malicious runId");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-2A-05: missing/invalid input throws, writes no transcript, spawns nothing.
// ---------------------------------------------------------------------

test("M9-2A-05: missing agentId/prompt throws before any side effect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92a-05-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const runDir = join(dir, "runs");

    // missing agentId
    await assert.rejects(() => dispatchRun({ prompt: "x", registryPath, runDir, spawnFn: fakeSpawn }));
    // missing prompt
    await assert.rejects(() => dispatchRun({ agentId: "coder_low", registryPath, runDir, spawnFn: fakeSpawn }));
    // missing registryPath
    await assert.rejects(() => dispatchRun({ agentId: "coder_low", prompt: "x", runDir, spawnFn: fakeSpawn }));
    // missing runDir
    await assert.rejects(() => dispatchRun({ agentId: "coder_low", prompt: "x", registryPath, spawnFn: fakeSpawn }));

    assert.equal(calls.length, 0, "no spawn for invalid input");
    // runDir should not have been created with any transcript.
    if (existsSync(runDir)) {
      const files = readdirSafe(runDir);
      assert.equal(files.filter((f) => f.endsWith(".jsonl")).length, 0, "no transcript written");
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-2A-06: service does not write to console.
// ---------------------------------------------------------------------

test("M9-2A-06: dispatchRun does not write to console", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92a-06-"));
  const { fakeSpawn } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const runDir = join(dir, "runs");
    const logs = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => { logs.push(["log", ...a]); };
    console.error = (...a) => { logs.push(["err", ...a]); };
    try {
      await dispatchRun({
        agentId: "coder_low",
        prompt: "x",
        registryPath,
        runDir,
        spawnFn: fakeSpawn,
      });
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    assert.equal(logs.length, 0, "service must not write to console.log/error");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-2A-07: requireCertified propagated — uncertified worker fails at the
//           certification gate (not at a later binary/spawn failure).
//           The test proves the flag reaches RunManager by asserting the
//           SPECIFIC failure cause: run.error.phase === "certification-gate",
//           terminal reason === "certification_gate", and the run never entered
//           submitted/running. A nonexistent binary alone cannot explain this —
//           if requireCertified were silently dropped, the worker would proceed
//           past the gate and fail later with a spawn/start error instead.
// ---------------------------------------------------------------------

test("M9-2A-07: requireCertified propagated — fails at certification-gate, never submitted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92a-07-"));
  try {
    const registryPath = makeRegistry(dir, {
      uncertified_worker: {
        backend: "claude-code",
        binary: "definitely-nonexistent-binary-m92a-07",
        cwd: dir,
      },
    });
    const runDir = join(dir, "runs");
    // Fresh summary that does NOT include uncertified_worker → gate must reject.
    makeSummary(runDir, { other_worker: { status: "certified" } });

    const result = await dispatchRun({
      agentId: "uncertified_worker",
      prompt: "x",
      registryPath,
      runDir,
      requireCertified: true,
    });

    const transcriptPath = join(runDir, `${result.runId}.jsonl`);
    let events = [];
    for (let i = 0; i < 80; i += 1) {
      if (existsSync(transcriptPath)) {
        events = await readTranscript(transcriptPath);
        if (["failed", "completed", "aborted", "timed_out"].includes(findState(events))) break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    // Terminal state is failed.
    assert.equal(findState(events), "failed", "uncertified worker reaches failed terminal");

    // The failure must be at the certification gate specifically — this is what
    // proves requireCertified reached RunManager. A dropped flag would let the
    // nonexistent binary fail later with phase:"start", not "certification-gate".
    const runError = findLatest(events, "run.error");
    assert.ok(runError, "a run.error event was written");
    assert.equal(runError.phase, "certification-gate",
      `failure cause is certification-gate (got phase=${JSON.stringify(runError.phase)}); ` +
      `if this is "start" or absent, requireCertified was silently dropped`);

    // The failed transition must carry the certification_gate reason.
    const failedChange = events.find(
      (e) => e.type === "run.state_change" && e.to === "failed",
    );
    assert.ok(failedChange, "failed state_change present");
    assert.equal(failedChange.reason, "certification_gate",
      `terminal reason is certification_gate (got ${JSON.stringify(failedChange.reason)})`);

    // The run must NEVER have entered submitted or running — the gate stops it
    // at pending. If a submitted/running state_change exists, the worker was
    // dispatched despite failing certification.
    const submittedOrRunning = events.filter(
      (e) => e.type === "run.state_change" && (e.to === "submitted" || e.to === "running"),
    );
    assert.equal(submittedOrRunning.length, 0,
      "never entered submitted/running — gate rejects before dispatch");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-2A-08: dependency-direction guard — src/application does not import commands/mcp/SDK/Zod.
// ---------------------------------------------------------------------

test("M9-2A-08: src/application does not import commands/, mcp/, MCP SDK, or zod", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const appDir = join(process.cwd(), "src", "application");
  const files = (await readdir(appDir)).filter((f) => f.endsWith(".js"));
  assert.ok(files.length > 0, "src/application has .js files");
  const forbidden = /(?:from\s+['"](?:\.\.\/commands\/|.*commands\/|\.\.\/mcp\/|.*mcp\/|@modelcontextprotocol|zod))|(?:require\(\s*['"](?:@modelcontextprotocol|zod))/;
  for (const f of files) {
    const content = await readFile(join(appDir, f), "utf8");
    const importLines = content.split("\n").filter((l) => l.trim().startsWith("import") || l.trim().startsWith("export") && l.includes("from"));
    for (const line of importLines) {
      assert.ok(!forbidden.test(line), `src/application/${f} must not import commands/mcp/SDK/zod: ${line.trim()}`);
    }
  }
});

// ===== Utility =====

import { readdirSync } from "node:fs";
function readdirSafe(p) {
  try { return readdirSync(p); } catch { return []; }
}

// ===== M9-7A: delivery-capable dispatch tests =====

test("M9-7A-01: valid delivery passes through prepareDeliveryRequest, argv gets --delivery-json + --isolate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m97a-01-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const result = await dispatchRun({
      agentId: "coder_low",
      prompt: "do it",
      registryPath,
      runDir: join(dir, "runs"),
      spawnFn: fakeSpawn,
      delivery: {
        mode: "git_commit_v1",
        allowedPaths: ["src"],
        verificationCommands: ["npm test"],
      },
    });
    assert.equal(result.accepted, true);
    const argv = calls[0].args;
    // Delivery JSON passed as structured argv.
    const djIdx = argv.indexOf("--delivery-json");
    assert.ok(djIdx >= 0, "argv has --delivery-json");
    const dj = JSON.parse(argv[djIdx + 1]);
    assert.equal(dj.mode, "git_commit_v1");
    assert.deepEqual(dj.allowedPaths, ["src"]);
    assert.deepEqual(dj.verification.commands, ["npm test"]);
    // Isolate forced.
    assert.ok(argv.includes("--isolate"), "argv has --isolate");
  } finally { cleanupDir(dir); }
});

test("M9-7A-02: invalid delivery rejected before transcript/fork", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m97a-02-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    // Missing mode
    await assert.rejects(() => dispatchRun({
      agentId: "coder_low", prompt: "x", registryPath, runDir: join(dir, "runs"),
      spawnFn: fakeSpawn,
      delivery: { allowedPaths: ["src/"], verificationCommands: ["npm test"] },
    }));
    // Both commands and reason
    await assert.rejects(() => dispatchRun({
      agentId: "coder_low", prompt: "x", registryPath, runDir: join(dir, "runs"),
      spawnFn: fakeSpawn,
      delivery: { mode: "git_commit_v1", allowedPaths: ["src/"], verificationCommands: ["npm test"], verificationUnavailableReason: "no" },
    }));
    // Neither commands nor reason
    await assert.rejects(() => dispatchRun({
      agentId: "coder_low", prompt: "x", registryPath, runDir: join(dir, "runs"),
      spawnFn: fakeSpawn,
      delivery: { mode: "git_commit_v1", allowedPaths: ["src/"] },
    }));
    assert.equal(calls.length, 0, "no spawn for invalid delivery");
  } finally { cleanupDir(dir); }
});

test("M9-7A-03: non-delivery dispatch argv unchanged (no --delivery-json, no --isolate)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m97a-03-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    await dispatchRun({
      agentId: "coder_low", prompt: "x", registryPath, runDir: join(dir, "runs"),
      spawnFn: fakeSpawn,
    });
    const argv = calls[0].args;
    assert.ok(!argv.includes("--delivery-json"), "no --delivery-json for non-delivery");
    assert.ok(!argv.includes("--isolate"), "no --isolate for non-delivery");
  } finally { cleanupDir(dir); }
});
