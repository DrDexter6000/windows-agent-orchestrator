// test/runsWait.test.js
//
// TD-109 (TDD plan v2 D1): CLI `runs wait <runId>` + `runs` unknown-subcommand
// fail-closed.
//
// The command is a thin CLI adapter over the SAME runWait application service
// the MCP run_wait tool uses (src/application/runWait.js). The CLI owns only:
//   - argv parsing (--wait-ms / --format / --run-dir)
//   - Number() coercion of --wait-ms (the SERVICE is the boundary validator —
//     its exact error text must reach the user unmodified)
//   - JSON (full service result + semanticNotes) / text rendering
//   - SIGINT handling
//
// In-process tests inject deps.runWaitFn (stopCommand(args, config, deps)
// precedent) wrapping the real service with a fake clock so the 180s+ window
// expires in milliseconds. One subprocess test proves exit code + stderr for
// the invalid --wait-ms path.
//
// Pure group: tmp runDir, no network, no node_modules imports.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { runsCommand } from "../src/commands/runs.js";
import { runWait } from "../src/application/runWait.js";
import { OBSERVATION_OUTCOMES } from "../src/application/runObservationProjection.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");

// Service-level closed set (mirrors the MCP RUN_WAIT_OUTPUT enum).
const SERVICE_OBSERVATION_OUTCOMES = ["observed", "read_failure"];

function makeRunDir() {
  return mkdtempSync(join(tmpdir(), "wao-runs-wait-"));
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Stamp runId/agentId on every event (the transcript appender always does;
// the observation projector's cross-run binding requires it).
async function writeJsonl(dir, runId, events) {
  const lines = events.map((e) => JSON.stringify({ runId, agentId: "coder_low", ...e }));
  writeFileSync(join(dir, `${runId}.jsonl`), lines.join("\n") + "\n", "utf8");
}

function terminalEvents() {
  return [
    { type: "run.started", backend: "claude-code", ts: "2026-08-14T10:00:00.000Z" },
    { type: "run.state_change", from: "pending", to: "running", reason: "first_event", seq: 1 },
    { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "done" }], seq: 2 },
    { type: "messages.collected", reason: "ops", seq: 3 },
    { type: "run.completed", ts: "2026-08-14T10:00:30.000Z", seq: 4 },
    { type: "run.state_change", from: "running", to: "completed", reason: "done", seq: 5 },
  ];
}

function runningEvents() {
  return [
    { type: "run.started", backend: "claude-code", ts: "2026-08-14T10:00:00.000Z" },
    { type: "run.state_change", from: "pending", to: "running", reason: "first_event", seq: 1 },
  ];
}

async function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.map(String).join("\t")); };
  try { await fn(); }
  finally { console.log = orig; }
  return lines.join("\n");
}

// Fake clock: each _now() call advances 60s, so a 270000 ms window expires
// after ~5 loop iterations with zero real sleeping.
function fakeClock() {
  let t = 1000000;
  return () => (t += 60000);
}

// =====================================================================
// RED-1: terminal fixture → `runs wait <id> --format json` prints the
// service result (JSON.parse-able, terminal, state, returnedEarly).
// =====================================================================

test("TD-109-W1: terminal run → runs wait --format json prints service result + semanticNotes", async () => {
  const dir = makeRunDir();
  try {
    writeFileSync(join(dir, "run_done.jsonl"),
      terminalEvents().map((e) => JSON.stringify({ runId: "run_done", agentId: "coder_low", ...e })).join("\n") + "\n", "utf8");
    const out = await captureLog(() => runsCommand(["wait", "run_done", "--format", "json"], { runDir: dir }));
    const parsed = JSON.parse(out);
    assert.equal(parsed.runId, "run_done");
    assert.equal(parsed.terminal, true);
    assert.equal(parsed.state, "completed");
    assert.equal(parsed.returnedEarly, true);
    assert.equal(parsed.observationOutcome, "observed");
    // semanticNotes reuse the MCP run_wait selector (no copied catalog).
    assert.ok(Array.isArray(parsed.semanticNotes), "semanticNotes must be an array");
    assert.ok(parsed.semanticNotes.length >= 1, "semanticNotes must be non-empty");
    const ids = parsed.semanticNotes.map((n) => n.id);
    assert.ok(ids.includes("observation.terminal"), `notes must include observation.terminal, got: ${ids.join(",")}`);
    for (const n of parsed.semanticNotes) {
      assert.deepEqual(Object.keys(n).sort(), ["doesNotMean", "id", "meaning"]);
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// RED-2: non-terminal run + fake clock → window expiry in milliseconds,
// terminal:false, observationOutcome in the service closed set.
// =====================================================================

test("TD-109-W2: non-terminal run + injected fake clock → window_expired in milliseconds", async () => {
  const dir = makeRunDir();
  try {
    await writeJsonl(dir, "run_active", runningEvents());
    const sleepCalls = [];
    const startedAt = Date.now();
    const out = await captureLog(() => runsCommand(
      ["wait", "run_active", "--format", "json"],
      { runDir: dir },
      {
        runWaitFn: (input) => runWait({
          ...input,
          sleepFn: (ms) => { sleepCalls.push(ms); return Promise.resolve(); },
          nowFn: fakeClock(),
        }),
      },
    ));
    const parsed = JSON.parse(out);
    assert.equal(parsed.terminal, false);
    assert.equal(parsed.returnedEarly, false);
    assert.ok(
      SERVICE_OBSERVATION_OUTCOMES.includes(parsed.observationOutcome),
      `observationOutcome must be in ${SERVICE_OBSERVATION_OUTCOMES.join("|")}, got: ${parsed.observationOutcome}`,
    );
    assert.ok(
      OBSERVATION_OUTCOMES.includes(parsed.observation?.outcome),
      `observation.outcome must be in ${OBSERVATION_OUTCOMES.join("|")}, got: ${parsed.observation?.outcome}`,
    );
    assert.equal(parsed.observation.outcome, "window_expired");
    // The wait loop actually ran (fake clock), but no real sleeping happened.
    assert.ok(sleepCalls.length > 0, "fake-clock wait loop must poll at least once");
    assert.ok(Date.now() - startedAt < 1000, "real elapsed time must stay in the millisecond range");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// RED-3: invalid --wait-ms values → service error text, no waiting entered.
// =====================================================================

test("TD-109-W3: out-of-range / non-integer --wait-ms → service error, wait never entered", async () => {
  const dir = makeRunDir();
  try {
    await writeJsonl(dir, "run_active", runningEvents());
    for (const bad of ["179999", "600001", "1.5", "abc"]) {
      const slept = [];
      const startedAt = Date.now();
      await assert.rejects(
        () => runsCommand(
          ["wait", "run_active", "--wait-ms", bad],
          { runDir: dir },
          {
            runWaitFn: (input) => runWait({
              ...input,
              sleepFn: (ms) => { slept.push(ms); return Promise.resolve(); },
              nowFn: fakeClock(),
            }),
          },
        ),
        (err) => {
          // The SERVICE's exact boundary error — the CLI must not reword it.
          assert.match(err.message, /waitMs must be an integer in \[180000, 600000\]/,
            `--wait-ms ${bad}: service error text required`);
          return true;
        },
        `--wait-ms ${bad} must be rejected`,
      );
      assert.equal(slept.length, 0, `--wait-ms ${bad}: must reject before entering the wait loop`);
      assert.ok(Date.now() - startedAt < 1000, `--wait-ms ${bad}: immediate rejection`);
    }
  } finally {
    cleanupDir(dir);
  }
});

test("TD-109-W3b: invalid runId → service error text (CLI does not swallow/reword)", async () => {
  const dir = makeRunDir();
  try {
    // Single positional token outside the isValidRunId allowlist — reaches the
    // service, which throws its own boundary error.
    await assert.rejects(
      () => runsCommand(["wait", "bad$run$id"], { runDir: dir }),
      (err) => {
        assert.match(err.message, /invalid runId/);
        assert.ok(err.message.includes("bad$run$id"), "service error interpolates the raw input");
        return true;
      },
    );
  } finally {
    cleanupDir(dir);
  }
});

test("TD-109-W3c: subprocess exit code 1 + stderr carries the service error text", () => {
  const dir = makeRunDir();
  try {
    writeFileSync(join(dir, "run_active.jsonl"),
      runningEvents().map((e) => JSON.stringify({ runId: "run_active", agentId: "coder_low", ...e })).join("\n") + "\n", "utf8");
    const r = spawnSync(
      process.execPath,
      ["src/cli.js", "runs", "wait", "run_active", "--wait-ms", "179999", "--run-dir", dir],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 30000,
        env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" },
      },
    );
    assert.notEqual(r.status, 0, `invalid --wait-ms must exit non-zero (got status ${r.status}, stdout=${r.stdout})`);
    assert.match(r.stderr, /waitMs must be an integer in \[180000, 600000\]/,
      "stderr must contain the service boundary error text");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// RED-4: read-only invariant — the transcript bytes are unchanged and no
// audit event is appended by `runs wait`.
// =====================================================================

test("TD-109-W4: runs wait is read-only (transcript bytes unchanged)", async () => {
  const dir = makeRunDir();
  try {
    writeFileSync(join(dir, "run_ro.jsonl"),
      terminalEvents().map((e) => JSON.stringify({ runId: "run_ro", agentId: "coder_low", ...e })).join("\n") + "\n", "utf8");
    const tp = join(dir, "run_ro.jsonl");
    const before = readFileSync(tp);
    const out = await captureLog(() => runsCommand(
      ["wait", "run_ro", "--format", "json"],
      { runDir: dir },
      { runWaitFn: (input) => runWait({ ...input, sleepFn: () => Promise.resolve(), nowFn: fakeClock() }) },
    ));
    const parsed = JSON.parse(out);
    assert.equal(parsed.terminal, true, "wait result must be the service payload");
    // Byte equality subsumes "no new audit events" — the fixture deliberately
    // carries a pre-existing messages.collected event, so any append (or any
    // other mutation) must break this comparison.
    assert.equal(readFileSync(tp).equals(before), true, "transcript bytes unchanged");
    assert.equal(
      readFileSync(tp, "utf8").split("\n").filter(Boolean).length,
      before.toString("utf8").split("\n").filter(Boolean).length,
      "event line count unchanged",
    );
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// WQ-02 state coverage: missing / unparseable transcript → the service's
// fail-closed read_failure closed-set result, printed normally (exit 0 —
// a read failure is an observation outcome, not a command error).
// =====================================================================

test("TD-109-W6: missing transcript → read_failure closed-set result, no throw", async () => {
  const dir = makeRunDir();
  try {
    const out = await captureLog(() => runsCommand(["wait", "run_missing", "--format", "json"], { runDir: dir }));
    const parsed = JSON.parse(out);
    assert.equal(parsed.runId, "run_missing");
    assert.equal(parsed.terminal, false);
    assert.equal(parsed.observationOutcome, "read_failure");
    assert.equal(parsed.readFailureReason, "transcript_parse_failed");
    assert.equal(parsed.liveness, "unknown");
    assert.equal(parsed.termination, null);
    assert.ok(Array.isArray(parsed.semanticNotes) && parsed.semanticNotes.length >= 1);
    assert.deepEqual(parsed.semanticNotes.map((n) => n.id), ["observation.read_failure"]);
  } finally {
    cleanupDir(dir);
  }
});

test("TD-109-W7: corrupt transcript line → read_failure closed-set result, no throw", async () => {
  const dir = makeRunDir();
  try {
    writeFileSync(join(dir, "run_corrupt.jsonl"),
      JSON.stringify({ runId: "run_corrupt", agentId: "coder_low", type: "run.started" }) + "\n{not json\n", "utf8");
    const out = await captureLog(() => runsCommand(["wait", "run_corrupt", "--format", "json"], { runDir: dir }));
    const parsed = JSON.parse(out);
    assert.equal(parsed.observationOutcome, "read_failure");
    assert.equal(parsed.readFailureReason, "transcript_parse_failed");
    assert.equal(parsed.terminal, false);
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// RED-5: unknown non-empty subcommand fails closed; bare `runs` (and the
// legacy flags-only / `runs list` forms) keep listing.
// =====================================================================

test("TD-109-W5: unknown runs subcommand fails closed listing valid subcommands; bare runs still lists", async () => {
  const dir = makeRunDir();
  try {
    writeFileSync(join(dir, "run_done.jsonl"),
      terminalEvents().map((e) => JSON.stringify({ runId: "run_done", agentId: "coder_low", ...e })).join("\n") + "\n", "utf8");
    // Unknown non-empty subcommand → fixed error naming every valid subcommand (incl. wait).
    await assert.rejects(
      () => runsCommand(["waitx"], { runDir: dir }),
      (err) => {
        assert.match(err.message, /unknown runs subcommand/i);
        for (const valid of ["list", "summary", "prune", "grep", "metrics", "scorecard", "dashboard", "diagnose", "delivery", "wait"]) {
          assert.ok(err.message.includes(valid), `error must list subcommand "${valid}"`);
        }
        return true;
      },
    );
    // Bare `runs` keeps the legacy list fallthrough (backward compat).
    const bare = await captureLog(() => runsCommand([], { runDir: dir }));
    assert.match(bare, /run_done\tcompleted/, "bare runs must still list runs");
    // Explicit `runs list` keeps working after fail-closed dispatch.
    const listed = await captureLog(() => runsCommand(["list"], { runDir: dir }));
    assert.match(listed, /run_done\tcompleted/, "runs list must still list runs");
    // Flags-only `runs` (no subcommand) keeps the legacy fallthrough.
    const flagsOnly = await captureLog(() => runsCommand(["--agent", "coder_low"], { runDir: dir }));
    assert.match(flagsOnly, /run_done\tcompleted/, "flags-only runs must still list runs");
  } finally {
    cleanupDir(dir);
  }
});
