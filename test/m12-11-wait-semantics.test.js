// test/m12-11-wait-semantics.test.js
//
// M12-11: unified observation-window, execution-deadline, and provider/backend
// failure semantics. TDD RED→GREEN.
//
// A Lead must never guess whether:
//   - a wait window ended (window_expired vs terminal vs read_failure),
//   - WAO actually terminated the worker on an execution deadline (timed_out),
//   - the provider/backend failed (and which side).
//
// This file pins:
//   P-*   the pure backend-neutral projector (runObservationProjection) —
//         observation {outcome, waitedMs, windowMs} + termination truth.
//   W-*   runWait additive facts + red flag A (mid-wait read failure fails
//         closed, NEVER combines stale events with a fresh heartbeat).
//   A-*   runAwaitResult additive facts (observation/termination on every path).
//   RM-*  runManager red flag B (unknown non-null done reason → failed, NEVER
//         timed_out; only waitTimerExpired creates run.timed_out).
//   M-*   real MCP behavior for run_wait + run_await_result: output shape,
//         strict parsed boundary, and the descriptions' transport-recovery
//         contract.
//   X-*   cross-field invariants + cross-run contamination + backward compat.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { JsonlTranscript, readTranscript } from "../src/transcript.js";
import { RunManager } from "../src/runManager.js";
import { createWaoMcpServer } from "../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { rmrfRetry } from "./_rmrfHelper.mjs";

// ===== Helpers =====

function cleanupDir(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

function makeGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "R.md"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: dir });
}

function jl(obj) { return JSON.stringify(obj) + "\n"; }

function clockSleep(start = 1000000) {
  let t = start;
  return { now: () => t, sleep: (ms) => { t += ms; }, get: () => t, set: (v) => { t = v; } };
}

// Build a transcript on disk. terminal: false | "completed" | "failed" | "aborted" | "timed_out".
// waitPolicy may be {ms, source} to append a run.wait_policy fact.
function seedTranscript(runDir, runId, {
  agentId = "coder_low", messages = [], terminal = false, workspaceCwd, waitPolicy,
} = {}) {
  mkdirSync(runDir, { recursive: true });
  const a = agentId;
  const lines = [
    jl({ type: "run.submitted", agentId: a, ts: "2026-08-03T00:00:00.000Z", runId }),
    jl({ type: "session.created", backend: "process", backendSessionId: "proc_m1211", runId, agentId: a }),
    jl({ type: "run.started", backend: "claude-code", ts: "2026-08-03T00:00:01.000Z", runId, agentId: a }),
    jl({ type: "run.background_submitted", background: true, cwd: workspaceCwd, runId, agentId: a }),
    jl({ type: "run.state_change", to: "pending", reason: "created", ts: "2026-08-03T00:00:02.000Z", runId, agentId: a }),
    jl({ type: "run.state_change", to: "running", reason: "first_event", ts: "2026-08-03T00:00:03.000Z", runId, agentId: a }),
  ];
  if (waitPolicy) {
    lines.push(jl({ type: "run.wait_policy", waitTimeoutMs: waitPolicy.ms, source: waitPolicy.source, runId, agentId: a }));
  }
  for (const [i, text] of messages.entries()) {
    lines.push(jl({
      type: "run.event", kind: "message", role: "assistant",
      parts: [{ type: "text", text }], ts: `2026-08-03T00:00:${10 + i}.000Z`, runId, agentId: a,
    }));
  }
  if (terminal === "completed" || terminal === true) {
    lines.push(jl({ type: "run.completed", ts: "2026-08-03T00:10:00.000Z", runId, agentId: a }));
    lines.push(jl({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-08-03T00:10:01.000Z", runId, agentId: a }));
  } else if (terminal === "failed") {
    lines.push(jl({ type: "run.error", phase: "wait", error: "backend reported failure", ts: "2026-08-03T00:10:00.000Z", runId, agentId: a }));
    lines.push(jl({ type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-08-03T00:10:01.000Z", runId, agentId: a }));
  } else if (terminal === "aborted") {
    lines.push(jl({ type: "run.stop_requested", reason: "user", ts: "2026-08-03T00:10:00.000Z", runId, agentId: a }));
    lines.push(jl({ type: "run.aborted", ts: "2026-08-03T00:10:00.500Z", runId, agentId: a }));
    lines.push(jl({ type: "run.state_change", to: "aborted", reason: "user", ts: "2026-08-03T00:10:01.000Z", runId, agentId: a }));
  } else if (terminal === "timed_out") {
    lines.push(jl({ type: "run.timed_out", ts: "2026-08-03T00:10:00.000Z", runId, agentId: a }));
    lines.push(jl({ type: "run.state_change", to: "timed_out", reason: "timeout", ts: "2026-08-03T00:10:01.000Z", runId, agentId: a }));
  }
  writeFileSync(join(runDir, `${runId}.jsonl`), lines.join(""), "utf8");
}

async function buildClient(server) {
  const [c1, s1] = InMemoryTransport.createLinkedPair();
  await server.connect(s1);
  const client = new Client({ name: "test", version: "0" }, { version: "0" });
  await client.connect(c1);
  return client;
}

// =====================================================================
// Section P — PURE PROJECTOR (runObservationProjection).
// Backend-neutral. Consumes ONE trusted snapshot + runId/current state/
// observation mode. No MCP/Zod/commands/backend-name imports, no I/O.
// =====================================================================

test("P0: projector exports frozen closed-set constants", async () => {
  const m = await import("../src/application/runObservationProjection.js");
  assert.deepEqual([...m.OBSERVATION_OUTCOMES].sort(),
    ["point_in_time", "read_failure", "terminal", "window_expired"]);
  assert.deepEqual([...m.TERMINATION_STATES].sort(),
    ["aborted", "completed", "failed", "timed_out"]);
  assert.deepEqual([...m.TERMINATION_SOURCES].sort(),
    ["backend", "completion", "control_plane", "execution_deadline", "manual", "provider", "unknown"]);
  assert.deepEqual([...m.WAIT_POLICY_SOURCES].sort(),
    ["agent", "disabled", "explicit", "global", "unknown"]);
  assert.ok(Object.isFrozen(m.OBSERVATION_OUTCOMES));
  assert.ok(Object.isFrozen(m.TERMINATION_STATES));
  assert.ok(Object.isFrozen(m.TERMINATION_SOURCES));
  assert.ok(Object.isFrozen(m.WAIT_POLICY_SOURCES));
});

test("P1: waitMs=0 nonterminal → point_in_time, termination null", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  const r = projectObservation({
    events: [], runId: "r", currentState: "running", terminal: false,
    readFailure: false, waitedMs: 0, windowMs: 0,
  });
  assert.equal(r.observation.outcome, "point_in_time");
  assert.equal(r.observation.waitedMs, 0);
  assert.equal(r.observation.windowMs, 0);
  assert.equal(r.termination, null);
});

test("P2: positive window fully expired, nonterminal → window_expired, termination null", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  const r = projectObservation({
    events: [], runId: "r", currentState: "running", terminal: false,
    readFailure: false, waitedMs: 270000, windowMs: 270000,
  });
  assert.equal(r.observation.outcome, "window_expired");
  assert.equal(r.termination, null);
});

test("P3: terminal → outcome terminal, termination non-null", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  const events = [
    { type: "run.completed", runId: "r" },
    { type: "run.state_change", to: "completed", reason: "done", runId: "r" },
  ];
  const r = projectObservation({
    events, runId: "r", currentState: "completed", terminal: true,
    readFailure: false, waitedMs: 5000, windowMs: 270000,
  });
  assert.equal(r.observation.outcome, "terminal");
  assert.ok(r.termination, "termination non-null on terminal");
  assert.equal(r.termination.state, "completed");
});

test("P4: read failure → outcome read_failure, termination null", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  const r = projectObservation({
    events: [], runId: "r", currentState: "running", terminal: false,
    readFailure: true, waitedMs: 4000, windowMs: 270000,
  });
  assert.equal(r.observation.outcome, "read_failure");
  assert.equal(r.termination, null);
});

// ---- termination truth: execution deadline + wait policy ----

test("P5: timed_out + bound run.timed_out + explicit policy → execution_deadline", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  const events = [
    { type: "run.wait_policy", waitTimeoutMs: 300000, source: "explicit", runId: "r" },
    { type: "run.timed_out", runId: "r" },
    { type: "run.state_change", to: "timed_out", reason: "timeout", runId: "r" },
  ];
  const r = projectObservation({
    events, runId: "r", currentState: "timed_out", terminal: true,
    readFailure: false, waitedMs: 300000, windowMs: 270000,
  });
  assert.equal(r.termination.state, "timed_out");
  assert.equal(r.termination.source, "execution_deadline");
  assert.equal(r.termination.configuredMs, 300000);
  assert.equal(r.termination.policySource, "explicit");
});

test("P6: timed_out with agent / global policy sources", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  for (const src of ["agent", "global"]) {
    const events = [
      { type: "run.wait_policy", waitTimeoutMs: 120000, source: src, runId: "r" },
      { type: "run.timed_out", runId: "r" },
      { type: "run.state_change", to: "timed_out", reason: "timeout", runId: "r" },
    ];
    const r = projectObservation({
      events, runId: "r", currentState: "timed_out", terminal: true,
      readFailure: false, waitedMs: 120000, windowMs: 270000,
    });
    assert.equal(r.termination.source, "execution_deadline");
    assert.equal(r.termination.policySource, src, `agent/global policy source ${src}`);
    assert.equal(r.termination.configuredMs, 120000);
  }
});

test("P7: valid disabled policy → configuredMs null, policySource disabled", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  // A run that COMPLETED with a disabled deadline (no timer). Realistic combo.
  const events = [
    { type: "run.wait_policy", waitTimeoutMs: null, source: "disabled", runId: "r" },
    { type: "run.completed", runId: "r" },
    { type: "run.state_change", to: "completed", reason: "done", runId: "r" },
  ];
  const r = projectObservation({
    events, runId: "r", currentState: "completed", terminal: true,
    readFailure: false, waitedMs: 0, windowMs: 0,
  });
  assert.equal(r.termination.configuredMs, null);
  assert.equal(r.termination.policySource, "disabled");
  assert.equal(r.termination.source, "completion");
});

test("P8: MISSING wait_policy → configuredMs null, policySource unknown (absence ≠ disabled)", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  const events = [
    { type: "run.timed_out", runId: "r" },
    { type: "run.state_change", to: "timed_out", reason: "timeout", runId: "r" },
  ];
  const r = projectObservation({
    events, runId: "r", currentState: "timed_out", terminal: true,
    readFailure: false, waitedMs: 270000, windowMs: 270000,
  });
  assert.equal(r.termination.configuredMs, null);
  assert.equal(r.termination.policySource, "unknown", "absence must NEVER imply disabled");
  assert.equal(r.termination.source, "execution_deadline");
});

test("P9: MALFORMED wait_policy → null/unknown", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  const events = [
    { type: "run.wait_policy", waitTimeoutMs: "oops", source: "explicit", runId: "r" },
    { type: "run.timed_out", runId: "r" },
    { type: "run.state_change", to: "timed_out", reason: "timeout", runId: "r" },
  ];
  const r = projectObservation({
    events, runId: "r", currentState: "timed_out", terminal: true,
    readFailure: false, waitedMs: 270000, windowMs: 270000,
  });
  assert.equal(r.termination.configuredMs, null);
  assert.equal(r.termination.policySource, "unknown");
});

test("P10: CONFLICTING wait_policies → null/unknown", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  const events = [
    { type: "run.wait_policy", waitTimeoutMs: 120000, source: "explicit", runId: "r" },
    { type: "run.wait_policy", waitTimeoutMs: 300000, source: "global", runId: "r" },
    { type: "run.timed_out", runId: "r" },
    { type: "run.state_change", to: "timed_out", reason: "timeout", runId: "r" },
  ];
  const r = projectObservation({
    events, runId: "r", currentState: "timed_out", terminal: true,
    readFailure: false, waitedMs: 270000, windowMs: 270000,
  });
  assert.equal(r.termination.configuredMs, null);
  assert.equal(r.termination.policySource, "unknown");
});

// ---- termination truth: failed source mapping (reuse diagnoseFailure) ----

test("P11: failed provider_auth → provider", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  const events = [
    { type: "run.error", error: "HTTP 401 unauthorized", runId: "r" },
    { type: "run.state_change", to: "failed", reason: "backend_error", runId: "r" },
  ];
  const r = projectObservation({
    events, runId: "r", currentState: "failed", terminal: true,
    readFailure: false, waitedMs: 0, windowMs: 0,
  });
  assert.equal(r.termination.source, "provider");
});

test("P12: failed provider_disconnect → provider", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  // Strict provider-disconnect signature: ≥3 run.event, ≥120s silence, exit crash.
  const events = [
    { type: "run.event", kind: "tool_use", tool: "x", ts: "2026-08-03T00:00:01.000Z", runId: "r" },
    { type: "run.event", kind: "tool_use", tool: "y", ts: "2026-08-03T00:00:02.000Z", runId: "r" },
    { type: "run.event", kind: "tool_use", tool: "z", ts: "2026-08-03T00:00:03.000Z", runId: "r" },
    { type: "run.error", error: "process exited with code 1", ts: "2026-08-03T00:05:03.000Z", runId: "r" },
    { type: "run.state_change", to: "failed", reason: "backend_error", runId: "r" },
  ];
  const r = projectObservation({
    events, runId: "r", currentState: "failed", terminal: true,
    readFailure: false, waitedMs: 0, windowMs: 0,
  });
  assert.equal(r.termination.source, "provider");
});

test("P13: failed backend_error / backend_stream_ended → backend", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  for (const reason of ["backend_error", "backend_stream_ended"]) {
    const events = [
      { type: "run.error", phase: "wait", error: "backend reported failure", runId: "r" },
      { type: "run.state_change", to: "failed", reason, runId: "r" },
    ];
    const r = projectObservation({
      events, runId: "r", currentState: "failed", terminal: true,
      readFailure: false, waitedMs: 0, windowMs: 0,
    });
    assert.equal(r.termination.source, "backend", `reason ${reason} → backend`);
  }
});

test("P14: failed crash (spawn) → backend", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  const events = [
    { type: "run.error", phase: "spawn", error: "spawn failed", runId: "r" },
    { type: "run.state_change", to: "failed", reason: "backend_error", runId: "r" },
  ];
  const r = projectObservation({
    events, runId: "r", currentState: "failed", terminal: true,
    readFailure: false, waitedMs: 0, windowMs: 0,
  });
  assert.equal(r.termination.source, "backend");
});

test("P15: failed evidence_passed_backend_failed → backend", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  const events = [
    { type: "run.event", kind: "file_written", path: "src/a.js", runId: "r" },
    { type: "run.event", kind: "command", command: "node test.js", exitCode: 0, runId: "r" },
    { type: "run.evidence_audit", passed: true, runId: "r" },
    { type: "run.state_change", to: "failed", reason: "backend_error", runId: "r" },
  ];
  const r = projectObservation({
    events, runId: "r", currentState: "failed", terminal: true,
    readFailure: false, waitedMs: 0, windowMs: 0,
  });
  assert.equal(r.termination.source, "backend");
});

test("P16: failed control-plane failures (budget/scorecard/workdir_escape/delivery/config) → control_plane", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  const cases = [
    [{ type: "run.state_change", to: "failed", reason: "budget_exceeded", runId: "r" }],
    [{ type: "run.error", phase: "scorecard", detail: "x", runId: "r" },
     { type: "run.state_change", to: "failed", reason: "scorecard_failed", runId: "r" }],
    [{ type: "run.isolation_violation", runId: "r" },
     { type: "run.state_change", to: "failed", reason: "workdir_escape", runId: "r" }],
    [{ type: "run.delivery_failed", runId: "r" },
     { type: "run.state_change", to: "failed", reason: "delivery_failed", runId: "r" }],
    [{ type: "run.error", error: "ANTHROPIC_API_KEY takes precedence", runId: "r" },
     { type: "run.state_change", to: "failed", reason: "backend_error", runId: "r" }],
  ];
  for (const events of cases) {
    const r = projectObservation({
      events, runId: "r", currentState: "failed", terminal: true,
      readFailure: false, waitedMs: 0, windowMs: 0,
    });
    assert.equal(r.termination.source, "control_plane", `events ${JSON.stringify(events)} → control_plane`);
  }
});

test("P17: failed with unknown done reason (no signal) → unknown", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  const events = [
    { type: "run.error", phase: "wait", error: "backend done with unknown reason", runId: "r" },
    { type: "run.state_change", to: "failed", reason: "backend_unknown_reason", runId: "r" },
  ];
  const r = projectObservation({
    events, runId: "r", currentState: "failed", terminal: true,
    readFailure: false, waitedMs: 0, windowMs: 0,
  });
  assert.equal(r.termination.source, "unknown");
});

// ---- execution-deadline truth rule on a FAILED terminal (M12-11 correction) ----
// execution_deadline is asserted ONLY when a bound run.timed_out durable fact
// exists. A diagnosis category "timeout" / timeout-like error text / a foreign
// run's run.timed_out must NEVER be collapsed into a WAO deadline claim.

test("P17a: failed + diagnosis 'timeout' + NO bound run.timed_out ⇒ NOT execution_deadline (causal)", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  // A FAILED terminal with NO bound run.timed_out. Inject a diagnosis returning
  // category "timeout" WITHOUT such a fact (simulates a future diagnosis that
  // broadens "timeout" to error text / provider stall). The projector must NOT
  // infer a WAO execution deadline from diagnosis/error text alone.
  const events = [
    { type: "run.error", phase: "wait", error: "request timed out", runId: "r" },
    { type: "run.state_change", to: "failed", reason: "backend_unknown_reason", runId: "r" },
  ];
  const r = projectObservation({
    events, runId: "r", currentState: "failed", terminal: true,
    readFailure: false, waitedMs: 0, windowMs: 0,
    diagnose: () => ({ category: "timeout", code: null, evidence: [] }),
  });
  assert.notEqual(r.termination.source, "execution_deadline",
    "must NOT infer execution_deadline from diagnosis 'timeout' without a bound run.timed_out");
  assert.equal(r.termination.source, "unknown");
});

test("P17b: failed + bound run.timed_out ⇒ execution_deadline (deadline fired; durable fact wins)", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  // Rare but legal: a terminal FAILED state whose bound snapshot also contains a
  // run.timed_out durable fact (the deadline fired; state later recorded failed).
  // The durable fact is authoritative → execution_deadline.
  const events = [
    { type: "run.timed_out", runId: "r" },
    { type: "run.error", phase: "wait", error: "killed after deadline", runId: "r" },
    { type: "run.state_change", to: "failed", reason: "backend_error", runId: "r" },
  ];
  const r = projectObservation({
    events, runId: "r", currentState: "failed", terminal: true,
    readFailure: false, waitedMs: 0, windowMs: 0,
  });
  assert.equal(r.termination.source, "execution_deadline");
});

test("P17c: failed + timeout-like error text + CROSS-RUN run.timed_out ⇒ NOT execution_deadline", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  // A FAILED terminal. Error text screams "timed out" and a run.timed_out event
  // exists but is bound to ANOTHER run. The bound filter strips the foreign fact;
  // no bound run.timed_out remains → never execution_deadline.
  const events = [
    { type: "run.error", phase: "wait", error: "upstream request timed out", runId: "r" },
    { type: "run.timed_out", runId: "run_OTHER" }, // foreign — must NOT contribute
    { type: "run.state_change", to: "failed", reason: "backend_unknown_reason", runId: "r" },
  ];
  const r = projectObservation({
    events, runId: "r", currentState: "failed", terminal: true,
    readFailure: false, waitedMs: 0, windowMs: 0,
  });
  assert.notEqual(r.termination.source, "execution_deadline",
    "cross-run run.timed_out + timeout-like text must never yield execution_deadline");
});

test("P18: aborted with bound abort fact → manual", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  const events = [
    { type: "run.stop_requested", reason: "user", runId: "r" },
    { type: "run.aborted", runId: "r" },
    { type: "run.state_change", to: "aborted", reason: "user", runId: "r" },
  ];
  const r = projectObservation({
    events, runId: "r", currentState: "aborted", terminal: true,
    readFailure: false, waitedMs: 0, windowMs: 0,
  });
  assert.equal(r.termination.source, "manual");
});

test("P19: completed with bound completed fact → completion", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  const events = [
    { type: "run.completed", runId: "r" },
    { type: "run.state_change", to: "completed", reason: "done", runId: "r" },
  ];
  const r = projectObservation({
    events, runId: "r", currentState: "completed", terminal: true,
    readFailure: false, waitedMs: 0, windowMs: 0,
  });
  assert.equal(r.termination.source, "completion");
});

// ---- missing durable terminal facts → unknown (never claim from state alone) ----

test("P20: timed_out state WITHOUT run.timed_out fact → unknown", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  const events = [{ type: "run.state_change", to: "timed_out", reason: "timeout", runId: "r" }];
  const r = projectObservation({
    events, runId: "r", currentState: "timed_out", terminal: true,
    readFailure: false, waitedMs: 0, windowMs: 0,
  });
  assert.equal(r.termination.source, "unknown", "must not claim execution_deadline without run.timed_out");
});

test("P21: aborted state WITHOUT bound abort fact → unknown (legacy)", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  const events = [{ type: "run.state_change", to: "aborted", reason: "user", runId: "r" }];
  const r = projectObservation({
    events, runId: "r", currentState: "aborted", terminal: true,
    readFailure: false, waitedMs: 0, windowMs: 0,
  });
  assert.equal(r.termination.source, "unknown");
});

test("P22: completed state WITHOUT bound completed fact → unknown (legacy)", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  const events = [{ type: "run.state_change", to: "completed", reason: "done", runId: "r" }];
  const r = projectObservation({
    events, runId: "r", currentState: "completed", terminal: true,
    readFailure: false, waitedMs: 0, windowMs: 0,
  });
  assert.equal(r.termination.source, "unknown");
});

// ---- cross-run contamination: events bound to a DIFFERENT runId never contribute ----

test("P23: cross-run run.timed_out / run.completed / run.aborted / wait_policy never contribute", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  // All durable facts are bound to run_OTHER, NOT the requested runId "r".
  const events = [
    { type: "run.wait_policy", waitTimeoutMs: 300000, source: "explicit", runId: "run_OTHER" },
    { type: "run.timed_out", runId: "run_OTHER" },
    { type: "run.completed", runId: "run_OTHER" },
    { type: "run.aborted", runId: "run_OTHER" },
    { type: "run.state_change", to: "timed_out", reason: "timeout", runId: "r" },
  ];
  const r = projectObservation({
    events, runId: "r", currentState: "timed_out", terminal: true,
    readFailure: false, waitedMs: 0, windowMs: 0,
  });
  assert.equal(r.termination.source, "unknown", "cross-run run.timed_out must not contribute");
  assert.equal(r.termination.configuredMs, null, "cross-run wait_policy must not contribute");
  assert.equal(r.termination.policySource, "unknown");
});

test("P24: cross-run failed evidence does not borrow another run's provider_auth", async () => {
  const { projectObservation } = await import("../src/application/runObservationProjection.js");
  const events = [
    { type: "run.error", error: "HTTP 401 unauthorized", runId: "run_OTHER" },
    { type: "run.state_change", to: "failed", reason: "backend_unknown_reason", runId: "r" },
  ];
  const r = projectObservation({
    events, runId: "r", currentState: "failed", terminal: true,
    readFailure: false, waitedMs: 0, windowMs: 0,
  });
  assert.equal(r.termination.source, "unknown", "must not borrow a cross-run provider_auth signal");
});

// =====================================================================
// Section W — runWait additive facts + red flag A (fail-closed read failure).
// =====================================================================

test("W1: window-expiry → observation.outcome=window_expired, termination null; old fields preserved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-w1-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-w1-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_w1", { workspaceCwd: dir, messages: [], terminal: false });
    const clk = clockSleep();
    const { runWait } = await import("../src/application/runWait.js");
    const out = await runWait({
      runId: "run_w1", runDir, waitMs: 180000,
      nowFn: clk.now, pollIntervalMs: 2000, sleepFn: async (ms) => { clk.sleep(ms); },
    });
    assert.equal(out.terminal, false);
    assert.equal(out.observationOutcome, "observed");
    assert.equal(out.readFailureReason, null);
    assert.equal(out.observation.outcome, "window_expired");
    assert.equal(out.observation.windowMs, 180000);
    assert.ok(Number.isInteger(out.observation.waitedMs) && out.observation.waitedMs >= 0);
    assert.equal(out.termination, null);
    // Old fields preserved.
    assert.equal(typeof out.liveness, "string");
    assert.equal(typeof out.cursor, "number");
    assert.equal(out.returnedEarly, false);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("W2: terminal-at-entry → observation.outcome=terminal, termination non-null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-w2-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-w2-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_w2", { workspaceCwd: dir, messages: ["done"], terminal: "completed" });
    const { runWait } = await import("../src/application/runWait.js");
    const out = await runWait({
      runId: "run_w2", runDir, waitMs: 180000,
      sleepFn: () => Promise.resolve(), nowFn: () => Date.now(),
    });
    assert.equal(out.terminal, true);
    assert.equal(out.observation.outcome, "terminal");
    assert.equal(out.observation.waitedMs, 0);
    assert.equal(out.observation.windowMs, 180000);
    assert.ok(out.termination);
    assert.equal(out.termination.state, "completed");
    assert.equal(out.termination.source, "completion");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("W3 (red flag A): mid-wait re-read failure FAILS CLOSED — no stale+fresh combo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-w3-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-w3-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_w3", { workspaceCwd: dir, messages: [], terminal: false });
    const { readTranscript: readReal } = await import("../src/transcript.js");
    let readCalls = 0;
    const clk = clockSleep();
    // A FRESH owner heartbeat exists at expiry. run_wait must NOT combine it
    // with stale events into a clean-looking progress/process_only.
    writeFileSync(join(runDir, ".owner-run_w3"), JSON.stringify({ pid: 1, heartbeatAt: clk.get() + 999999 }));
    const { runWait } = await import("../src/application/runWait.js");
    const out = await runWait({
      runId: "run_w3", runDir, waitMs: 180000,
      nowFn: clk.now, pollIntervalMs: 2000, sleepFn: async (ms) => { clk.sleep(ms); },
      readTranscriptFn: async (p) => {
        readCalls += 1;
        if (readCalls === 1) return readReal(p); // initial read succeeds
        throw new Error("transcript vanished"); // mid-wait re-read fails
      },
    });
    assert.equal(readCalls, 2, "initial read + one failed re-read");
    assert.equal(out.observationOutcome, "read_failure", "must fail CLOSED, not a clean expiry");
    assert.equal(out.terminal, false, "must not fabricate terminal");
    assert.equal(out.liveness, "unknown", "must NOT derive liveness from stale events");
    assert.equal(out.ownerHeartbeat, "unknown", "must NOT consult the fresh heartbeat");
    assert.equal(out.activityEventCount, null);
    assert.equal(out.lastActivityKind, null);
    assert.equal(out.observation.outcome, "read_failure");
    assert.equal(out.termination, null);
    assert.ok(Number.isInteger(out.observation.waitedMs) && out.observation.waitedMs > 0);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("W4: window-expiry does NOT mean worker stopped (termination null, advisory)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-w4-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-w4-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_w4", { workspaceCwd: dir, messages: [], terminal: false });
    const clk = clockSleep();
    const { runWait } = await import("../src/application/runWait.js");
    const out = await runWait({
      runId: "run_w4", runDir, waitMs: 180000,
      nowFn: clk.now, pollIntervalMs: 2000, sleepFn: async (ms) => { clk.sleep(ms); },
    });
    assert.equal(out.terminal, false);
    assert.equal(out.termination, null, "an expired observation window is NOT a worker stop");
    assert.equal(out.observation.outcome, "window_expired");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

// =====================================================================
// Section A — runAwaitResult additive facts (observation/termination).
// =====================================================================

test("A1: point-in-time (waitMs=0) nonterminal → observation.outcome=point_in_time, termination null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-a1-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-a1-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_a1", { workspaceCwd: dir, messages: [], terminal: false });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: "run_a1", runDir, waitMs: 0 });
    assert.equal(out.observationOutcome, "observed");
    assert.equal(out.observation.outcome, "point_in_time");
    assert.equal(out.observation.waitedMs, 0);
    assert.equal(out.observation.windowMs, 0);
    assert.equal(out.termination, null);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("A2: window expiry → observation.outcome=window_expired, termination null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-a2-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-a2-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_a2", { workspaceCwd: dir, messages: [], terminal: false });
    const clk = clockSleep();
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({
      runId: "run_a2", runDir, waitMs: 4000,
      nowFn: clk.now, pollIntervalMs: 2000, sleepFn: async (ms) => { clk.sleep(ms); },
    });
    assert.equal(out.observationOutcome, "observed");
    assert.equal(out.observation.outcome, "window_expired");
    assert.equal(out.termination, null);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("A3: terminal → observation.outcome=terminal, termination non-null (completion)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-a3-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-a3-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_a3", { workspaceCwd: dir, messages: ["final"], terminal: "completed" });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: "run_a3", runDir, waitMs: 0 });
    assert.equal(out.observationOutcome, "observed");
    assert.equal(out.observation.outcome, "terminal");
    assert.ok(out.termination);
    assert.equal(out.termination.state, "completed");
    assert.equal(out.termination.source, "completion");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("A4: read failure → observation.outcome=read_failure, termination null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-a4-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-a4-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_a4", { workspaceCwd: dir, messages: [], terminal: false });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({
      runId: "run_a4", runDir, waitMs: 0,
      readTranscriptFn: async () => { throw new Error("gone"); },
    });
    assert.equal(out.observationOutcome, "read_failure");
    assert.equal(out.observation.outcome, "read_failure");
    assert.equal(out.termination, null);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("A5: failed terminal → termination.source derived (backend_error → backend)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-a5-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-a5-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_a5", { workspaceCwd: dir, messages: ["partial"], terminal: "failed" });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: "run_a5", runDir, waitMs: 0 });
    assert.equal(out.terminal, true);
    assert.equal(out.termination.state, "failed");
    assert.equal(out.termination.source, "backend");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

// =====================================================================
// Section RM — runManager red flag B (unknown done reason → failed, never timed_out).
// =====================================================================

function makeProcessManager(dir, mockBackend, { waitTimeout = null } = {}) {
  const config = {
    registry: "x", runDir: dir, pollInterval: 10, waitTimeout,
    timeout: 5000, retries: 0, defaultIsolation: "none",
  };
  const readRegistry = async () => ({
    getAgent(id, overrides = {}) {
      const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
      return { id, backend: "claude-code", cwd: dir, ...defined };
    },
    listAgents() { return []; },
  });
  return new RunManager({ config, readRegistry, backendFor: () => mockBackend });
}

test("RM1 (red flag B): unknown non-null done reason → failed + throw, NEVER timed_out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-rm1-"));
  try {
    const backend = {
      async spawn() {
        return {
          backend: "process",
          backendSessionId: "proc_unknown_reason",
          events: async function* () {
            yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "working" }] };
            yield { kind: "done", reason: "cancelled" }; // unknown non-null reason
          },
          abort: async () => {},
          isAlive: () => false,
        };
      },
    };
    // waitTimeout null → NO execution-deadline timer. The done event is the
    // sole terminal cause. Previously this fabricated run.timed_out.
    const manager = makeProcessManager(dir, backend, { waitTimeout: null });
    const run = await manager.start("test", { prompt: "go" });

    // Like the done(failed) path, an unknown terminal must fail closed + throw.
    await assert.rejects(() => run.waitForCompletion({ pollInterval: 5 }));
    assert.equal(run.state, "failed", "unknown done reason must terminal as FAILED");

    const events = await readTranscript(run.transcript.filePath);
    const terminalChanges = events.filter((e) => e.type === "run.state_change" && ["failed", "timed_out", "aborted", "completed"].includes(e.to));
    assert.equal(terminalChanges.length, 1, "exactly one terminal fact");
    assert.equal(terminalChanges[0].to, "failed");
    assert.equal(events.some((e) => e.type === "run.timed_out"), false, "NO run.timed_out fact was written");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("RM2: genuine waitTimerExpired still produces timed_out (regression guard)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-rm2-"));
  try {
    const backend = {
      async spawn() {
        return {
          backend: "process",
          backendSessionId: "proc_real_timeout",
          events: async function* (signal) {
            // Block until the deadline timer aborts the controller (hang-safe).
            if (!signal.aborted) {
              await new Promise((resolve) => {
                signal.addEventListener("abort", resolve, { once: true });
                setTimeout(resolve, 3000);
              });
            }
            yield { kind: "done", reason: "failed", error: "killed after timeout" };
          },
          abort: async () => {},
          isAlive: () => false,
        };
      },
    };
    const manager = makeProcessManager(dir, backend, { waitTimeout: 20 });
    const run = await manager.start("test", { prompt: "go" });
    const result = await run.waitForCompletion({ pollInterval: 5 });
    assert.equal(result.timedOut, true);
    assert.equal(run.state, "timed_out");
    const events = await readTranscript(run.transcript.filePath);
    assert.equal(events.filter((e) => e.type === "run.state_change" && e.to === "timed_out").length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("RM3: unknown done reason writes a safe backend failure run.error (no raw reason echo on wire)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-rm3-"));
  try {
    const backend = {
      async spawn() {
        return {
          backend: "process",
          backendSessionId: "proc_unknown_3",
          events: async function* () {
            yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "x" }] };
            yield { kind: "done", reason: "stream_error" }; // unknown non-null reason
          },
          abort: async () => {},
          isAlive: () => false,
        };
      },
    };
    const manager = makeProcessManager(dir, backend, { waitTimeout: null });
    const run = await manager.start("test", { prompt: "go" });
    await assert.rejects(() => run.waitForCompletion({ pollInterval: 5 }));
    assert.equal(run.state, "failed");

    const events = await readTranscript(run.transcript.filePath);
    const failedChange = events.find((e) => e.type === "run.state_change" && e.to === "failed");
    assert.ok(failedChange, "terminal failed");
    // The transition reason is a safe closed-set label, not the raw backend reason.
    assert.equal(typeof failedChange.reason, "string");
    assert.ok(!/stream_error|cancelled/.test(failedChange.reason), "raw backend reason must NOT be echoed in the transition reason");
    assert.equal(events.some((e) => e.type === "run.error" && e.phase === "wait"), true, "a safe run.error fact is recorded");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// =====================================================================
// Section M — real MCP behavior for run_wait + run_await_result.
// =====================================================================

test("M1: run_wait output schema is strict + exposes observation/termination closed sets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-m1-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      const t = tools.tools.find((x) => x.name === "run_wait");
      const props = t.outputSchema.properties ?? {};
      assert.equal(t.outputSchema.additionalProperties, false, "strict output");
      assert.ok(props.observation, "run_wait exposes observation");
      assert.deepEqual([...(props.observation.properties.outcome.enum ?? [])].sort(),
        ["point_in_time", "read_failure", "terminal", "window_expired"]);
      assert.ok(props.observation.properties.waitedMs, "observation.waitedMs");
      assert.ok(props.observation.properties.windowMs, "observation.windowMs");
      // termination is nullable → serializes as anyOf:[object, null]; drill in.
      const termObj = props.termination?.anyOf?.find((s) => s.type === "object") ?? props.termination;
      assert.ok(termObj, "run_wait exposes termination");
      assert.deepEqual([...(termObj.properties.state.enum ?? [])].sort(),
        ["aborted", "completed", "failed", "timed_out"]);
      assert.deepEqual([...(termObj.properties.source.enum ?? [])].sort(),
        ["backend", "completion", "control_plane", "execution_deadline", "manual", "provider", "unknown"]);
      assert.ok(props.observationOutcome, "run_wait exposes observationOutcome");
      assert.ok(props.readFailureReason, "run_wait exposes readFailureReason");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M2: run_wait window-expiry via real transport → observation/termination, no worker-stopped claim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-m2-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-m2-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_m2", { workspaceCwd: dir, messages: [], terminal: false });
    let clock = 1000000;
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir, workspaceRoot: dir,
      runWaitFn: async (input) => {
        const { runWait } = await import("../src/application/runWait.js");
        return runWait({
          ...input, nowFn: () => clock, pollIntervalMs: 2000,
          sleepFn: async (ms) => { clock += ms; },
        });
      },
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_wait", arguments: { runId: "run_m2", waitMs: 180000 } });
      assert.equal(res.isError, undefined);
      const p = res.structuredContent;
      assert.equal(p.observation.outcome, "window_expired");
      assert.equal(p.termination, null);
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("M3: run_wait read_failure via real transport → structured read_failure (NOT opaque error)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-m3-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-m3-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_m3", { workspaceCwd: dir, messages: [], terminal: false });
    const { readTranscript: readReal } = await import("../src/transcript.js");
    let reads = 0;
    let clock = 1000000;
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir, workspaceRoot: dir,
      runWaitFn: async (input) => {
        const { runWait } = await import("../src/application/runWait.js");
        return runWait({
          ...input, nowFn: () => clock, pollIntervalMs: 2000,
          sleepFn: async (ms) => { clock += ms; },
          readTranscriptFn: async (p) => { reads += 1; if (reads === 1) return readReal(p); throw new Error("gone"); },
        });
      },
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_wait", arguments: { runId: "run_m3", waitMs: 180000 } });
      const p = res.structuredContent;
      assert.ok(p, "structured read_failure returned (NOT opaque error)");
      assert.equal(res.isError, undefined);
      assert.equal(p.observationOutcome, "read_failure");
      assert.equal(p.observation.outcome, "read_failure");
      assert.equal(p.liveness, "unknown");
      assert.equal(p.termination, null);
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("M4: run_await_result output schema strict + observation/termination closed sets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-m4-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      const t = tools.tools.find((x) => x.name === "run_await_result");
      const props = t.outputSchema.properties ?? {};
      assert.equal(t.outputSchema.additionalProperties, false, "strict output");
      assert.ok(props.observation && props.termination, "run_await_result exposes observation + termination");
      assert.deepEqual([...(props.observation.properties.outcome.enum ?? [])].sort(),
        ["point_in_time", "read_failure", "terminal", "window_expired"]);
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M5: run_await_result terminal via real transport → observation terminal + termination completion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-m5-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-m5-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_m5", { workspaceCwd: dir, messages: ["FINAL"], terminal: "completed" });
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_await_result", arguments: { runId: "run_m5", waitMs: 0 } });
      assert.equal(res.isError, undefined);
      const p = res.structuredContent;
      assert.equal(p.observation.outcome, "terminal");
      assert.equal(p.termination.state, "completed");
      assert.equal(p.termination.source, "completion");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("M6: run_wait description carries Host-neutral transport-recovery contract", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-m6-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      const t = tools.tools.find((x) => x.name === "run_wait");
      const d = t.description.toLowerCase();
      // A missing result means observation unknown; these read-only tools did no mutation.
      assert.ok(/observation unknown|unknown observation|no.*mutation|no control-plane/i.test(t.description),
        "description must say a missing result means observation unknown / no mutation");
      // Re-read point-in-time guidance via run_await_result(waitMs:0) or run_status.
      assert.ok(/run_await_result|run_status/.test(t.description), "must name a re-read tool");
      // Must NOT claim worker alive/dead from transport loss.
      assert.ok(!/worker (is )?(alive|dead|stopped)/i.test(t.description), "must not claim worker alive/dead from transport loss");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M7: run_await_result description carries Host-neutral transport-recovery contract", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-m7-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      const t = tools.tools.find((x) => x.name === "run_await_result");
      assert.ok(/observation unknown|unknown observation|no.*mutation|no control-plane/i.test(t.description),
        "description must say a missing result means observation unknown / no mutation");
      assert.ok(/run_await_result|run_status/.test(t.description), "must name a re-read tool");
      assert.ok(!/worker (is )?(alive|dead|stopped)/i.test(t.description), "must not claim worker alive/dead");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// =====================================================================
// Section X — cross-field invariants + backward compatibility.
// =====================================================================

test("X1: terminal ⇒ outcome=terminal AND liveness=terminal AND termination non-null (run_wait + run_await_result)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-x1-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-x1-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_x1", { workspaceCwd: dir, messages: ["done"], terminal: "completed" });
    const { runWait, runAwaitResult: runAwait } = {
      ...(await import("../src/application/runWait.js")),
      ...(await import("../src/application/runAwaitResult.js")),
    };
    for (const out of [
      await runWait({ runId: "run_x1", runDir, waitMs: 180000, sleepFn: () => Promise.resolve(), nowFn: () => 1 }),
      await runAwait({ runId: "run_x1", runDir, waitMs: 0 }),
    ]) {
      assert.equal(out.terminal, true);
      assert.equal(out.liveness, "terminal");
      assert.equal(out.observation.outcome, "terminal");
      assert.ok(out.termination, "termination non-null when terminal");
    }
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("X2: read_failure ⇒ outcome=read_failure AND liveness=unknown AND termination null (run_await_result)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-x2-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-x2-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_x2", { workspaceCwd: dir, messages: [], terminal: false });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({
      runId: "run_x2", runDir, waitMs: 0,
      readTranscriptFn: async () => { throw new Error("gone"); },
    });
    assert.equal(out.observationOutcome, "read_failure");
    assert.equal(out.observation.outcome, "read_failure");
    assert.equal(out.liveness, "unknown");
    assert.equal(out.ownerHeartbeat, "unknown");
    assert.equal(out.termination, null);
    assert.ok(["transcript_parse_failed", "legacy_event_shape", "snapshot_unavailable"].includes(out.readFailureReason),
      "existing readFailureReason closed set preserved");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("X3: backward compat — run_wait old fields still present and typed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-x3-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-x3-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_x3", { workspaceCwd: dir, messages: [], terminal: false });
    const clk = clockSleep();
    const { runWait } = await import("../src/application/runWait.js");
    const out = await runWait({
      runId: "run_x3", runDir, waitMs: 180000,
      nowFn: clk.now, pollIntervalMs: 2000, sleepFn: async (ms) => { clk.sleep(ms); },
    });
    for (const k of ["runId", "agentId", "state", "terminal", "cursor", "returnedEarly",
      "liveness", "activityEventCount", "lastActivityKind", "ownerHeartbeat"]) {
      assert.ok(k in out, `old field ${k} still present`);
    }
    assert.equal(typeof out.cursor, "number");
    assert.equal(typeof out.activityEventCount, "number");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("X4: backward compat — run_await_result old fields still present and typed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-x4-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-x4-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_x4", { workspaceCwd: dir, messages: [], terminal: false });
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: "run_x4", runDir, waitMs: 0 });
    for (const k of ["runId", "agentId", "state", "terminal", "cursor", "returnedEarly",
      "waitedMs", "observationOutcome", "readFailureReason", "liveness", "activityEventCount",
      "lastActivityKind", "ownerHeartbeat", "result", "outcome"]) {
      assert.ok(k in out, `old field ${k} still present`);
    }
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("X5: architecture — projector imports no MCP/zod/commands/backend-name, no I/O", async () => {
  const { readFileSync: rf } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = rf(join(join(fileURLToPath(new URL(".", import.meta.url))), "..", "src", "application", "runObservationProjection.js"), "utf8");
  assert.ok(!src.includes('from "../commands/'), "no commands/");
  assert.ok(!src.includes('from "../mcp/'), "no mcp/");
  assert.ok(!src.includes("@modelcontextprotocol/sdk"), "no SDK");
  assert.ok(!src.includes('from "zod"'), "no zod");
  assert.ok(!/readFileSync|readTranscript|writeFile|fetch/.test(src), "no I/O");
});
