// test/m12-11-wait-projection.test.js
//
// M12-11 split — PURE PROJECTOR slice (manifest category: pure).
//
// This file was split out of test/m12-11-wait-semantics.test.js at its existing
// section boundaries so the canonical wave's per-file process lifetime stays
// inside the SDK request budget under cross-file load. Every assertion is
// preserved verbatim; no test was added, removed, or relaxed.
//
// This slice carries:
//   P-*   the pure backend-neutral projector (runObservationProjection) —
//         observation {outcome, waitedMs, windowMs} + termination truth.
//   X5    architecture-only: the projector source imports no MCP/zod/commands/
//         backend-name and performs no I/O.
//
// No Git, no MCP, no filesystem mutation — pure function calls + a read-only
// source-text architecture check. Runs in the pure wave.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

// =====================================================================
// Section P — PURE PROJECTOR (runObservationProjection).
// Backend-neutral. Consumes ONE trusted snapshot + runId/current state/
// observation mode. No MCP/Zod/commands/backend-name imports, no I/O.
// =====================================================================

test("P0: projector exports frozen closed-set constants", async () => {
  const m = await import("../../src/application/runObservationProjection.js");
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
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
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
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
  const r = projectObservation({
    events: [], runId: "r", currentState: "running", terminal: false,
    readFailure: false, waitedMs: 270000, windowMs: 270000,
  });
  assert.equal(r.observation.outcome, "window_expired");
  assert.equal(r.termination, null);
});

test("P3: terminal → outcome terminal, termination non-null", async () => {
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
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
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
  const r = projectObservation({
    events: [], runId: "r", currentState: "running", terminal: false,
    readFailure: true, waitedMs: 4000, windowMs: 270000,
  });
  assert.equal(r.observation.outcome, "read_failure");
  assert.equal(r.termination, null);
});

// ---- termination truth: execution deadline + wait policy ----

test("P5: timed_out + bound run.timed_out + explicit policy → execution_deadline", async () => {
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
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
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
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
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
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
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
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
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
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
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
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
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
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
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
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
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
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
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
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
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
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
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
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
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
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
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
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
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
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
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
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
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
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
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
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
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
  const events = [{ type: "run.state_change", to: "timed_out", reason: "timeout", runId: "r" }];
  const r = projectObservation({
    events, runId: "r", currentState: "timed_out", terminal: true,
    readFailure: false, waitedMs: 0, windowMs: 0,
  });
  assert.equal(r.termination.source, "unknown", "must not claim execution_deadline without run.timed_out");
});

test("P21: aborted state WITHOUT bound abort fact → unknown (legacy)", async () => {
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
  const events = [{ type: "run.state_change", to: "aborted", reason: "user", runId: "r" }];
  const r = projectObservation({
    events, runId: "r", currentState: "aborted", terminal: true,
    readFailure: false, waitedMs: 0, windowMs: 0,
  });
  assert.equal(r.termination.source, "unknown");
});

test("P22: completed state WITHOUT bound completed fact → unknown (legacy)", async () => {
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
  const events = [{ type: "run.state_change", to: "completed", reason: "done", runId: "r" }];
  const r = projectObservation({
    events, runId: "r", currentState: "completed", terminal: true,
    readFailure: false, waitedMs: 0, windowMs: 0,
  });
  assert.equal(r.termination.source, "unknown");
});

// ---- cross-run contamination: events bound to a DIFFERENT runId never contribute ----

test("P23: cross-run run.timed_out / run.completed / run.aborted / wait_policy never contribute", async () => {
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
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
  const { projectObservation } = await import("../../src/application/runObservationProjection.js");
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
// X5 — architecture-only: projector source imports no MCP/zod/commands/
// backend-name and performs no I/O. Read-only source-text check; no Git/MCP.
// =====================================================================

test("X5: architecture — projector imports no MCP/zod/commands/backend-name, no I/O", async () => {
  const { readFileSync: rf } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = rf(join(join(fileURLToPath(new URL(".", import.meta.url))), "../..", "src", "application", "runObservationProjection.js"), "utf8");
  assert.ok(!src.includes('from "../commands/'), "no commands/");
  assert.ok(!src.includes('from "../mcp/'), "no mcp/");
  assert.ok(!src.includes("@modelcontextprotocol/sdk"), "no SDK");
  assert.ok(!src.includes('from "zod"'), "no zod");
  assert.ok(!/readFileSync|readTranscript|writeFile|fetch/.test(src), "no I/O");
});
