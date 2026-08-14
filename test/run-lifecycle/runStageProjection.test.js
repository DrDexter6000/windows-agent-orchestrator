// test/runStageProjection.test.js
//
// M12-17: submitted-stage execution semantics — pure SSOT projection tests.
//
// Proves that src/application/runStageProjection.js projects ONE read-only
// transcript snapshot into ONE bounded closed-set stage
// (accepted|spawned|active|terminal|unknown) with:
//   - closed-set basis (only run.submitted/run.background_submitted,
//     run.started, run.event, run.state_change-to-terminal, and the four
//     legacy terminal FACT types can move the stage)
//   - terminal-wins semantics: consistent terminal claims beat later activity,
//     resurrection, and malformed replay noise; DISTINCT conflicting terminal
//     states degrade to unknown (never pick a winner)
//   - fail-closed cross-run binding: foreign-envelope events never influence
//     the stage; missing-envelope legacy lines stay in-scope; invalid runId /
//     invalid snapshot throw before any event is considered
//   - deterministic age (sinceTs raw / secondsSince rounded) via injectable
//     nowFn; null when unknowable
//   - no state mutation, no liveness probe, no stop/retry/reassignment, no
//     payload echo (tests assert the returned shape never contains event
//     payload fields)

import { test } from "node:test";
import assert from "node:assert/strict";

import { projectExecutionStage, EXECUTION_STAGES } from "../../src/application/runStageProjection.js";

// ===== Helpers =====

const RUN = "run_stage_test";

function ev(type, overrides = {}) {
  return { type, ts: "2026-07-14T00:00:00.000Z", runId: RUN, agentId: "w", seq: 1, ...overrides };
}

function project(lines, opts = {}) {
  return projectExecutionStage({ events: lines }, { runId: opts.runId ?? RUN, nowFn: opts.nowFn });
}

// Fixed clock for deterministic ages: events default to 00:00:00, now = 00:00:14.
const FIXED_NOW = () => new Date("2026-07-14T00:00:14.000Z").getTime();
const T0 = "2026-07-14T00:00:00.000Z";

// ===== M12-17-01: closed set frozen (schema SSOT, no drift) =====

test("M12-17-01: EXECUTION_STAGES is the frozen closed set", () => {
  assert.deepEqual([...EXECUTION_STAGES], ["accepted", "spawned", "active", "terminal", "unknown"]);
  assert.ok(Object.isFrozen(EXECUTION_STAGES), "closed set must be frozen");
});

// ===== M12-17-02..06: stage derivation from the bounded basis =====

test("M12-17-02: run.submitted alone → accepted", () => {
  const r = project([ev("run.submitted", { ts: T0 })], { nowFn: FIXED_NOW });
  assert.equal(r.phase, "accepted");
  assert.equal(r.sinceTs, T0);
  assert.equal(r.secondsSince, 14);
});

test("M12-17-03: run.background_submitted alone → accepted", () => {
  const r = project([ev("run.background_submitted", { ts: T0 })], { nowFn: FIXED_NOW });
  assert.equal(r.phase, "accepted");
});

test("M12-17-04: submitted + started → spawned, sinceTs from run.started", () => {
  const r = project(
    [
      ev("run.submitted", { ts: "2026-07-14T00:00:00.000Z" }),
      ev("run.started", { ts: "2026-07-14T00:00:01.000Z" }),
    ],
    { nowFn: FIXED_NOW },
  );
  assert.equal(r.phase, "spawned");
  assert.equal(r.sinceTs, "2026-07-14T00:00:01.000Z");
  assert.equal(r.secondsSince, 13);
});

test("M12-17-05: worker run.event → active, sinceTs from FIRST run.event", () => {
  const r = project(
    [
      ev("run.submitted", { ts: "2026-07-14T00:00:00.000Z" }),
      ev("run.started", { ts: "2026-07-14T00:00:01.000Z" }),
      ev("run.event", { kind: "command", command: "npm test", ts: "2026-07-14T00:00:02.000Z" }),
      ev("run.event", { kind: "message", ts: "2026-07-14T00:00:03.000Z" }),
    ],
    { nowFn: FIXED_NOW },
  );
  assert.equal(r.phase, "active");
  assert.equal(r.sinceTs, "2026-07-14T00:00:02.000Z");
  assert.equal(r.secondsSince, 12);
});

test("M12-17-06: terminal state_change → terminal, sinceTs from the transition", () => {
  const r = project(
    [
      ev("run.submitted", { ts: "2026-07-14T00:00:00.000Z" }),
      ev("run.started", { ts: "2026-07-14T00:00:01.000Z" }),
      ev("run.event", { kind: "command", ts: "2026-07-14T00:00:02.000Z" }),
      ev("run.state_change", { to: "completed", reason: "done", ts: "2026-07-14T00:00:05.000Z" }),
    ],
    { nowFn: FIXED_NOW },
  );
  assert.equal(r.phase, "terminal");
  assert.equal(r.sinceTs, "2026-07-14T00:00:05.000Z");
  assert.equal(r.secondsSince, 9);
});

// ===== M12-17-07..09: no basis / corrupt noise =====

test("M12-17-07: empty snapshot → unknown with null ages", () => {
  const r = project([]);
  assert.deepEqual(r, { phase: "unknown", sinceTs: null, secondsSince: null });
});

test("M12-17-08: only bookkeeping (no basis) → unknown, never fabricated", () => {
  const r = project([ev("session.created"), ev("workflow.completed"), ev("delivery.sent")]);
  assert.equal(r.phase, "unknown");
  assert.equal(r.sinceTs, null);
  assert.equal(r.secondsSince, null);
});

test("M12-17-09: corrupt primitive lines are skipped, they cannot move the stage", () => {
  const r = project(
    [
      null,
      42,
      [1, 2, 3],
      "raw string",
      ev("run.event", { kind: "message" }),
    ],
    { nowFn: FIXED_NOW },
  );
  assert.equal(r.phase, "active", "corrupt lines skipped; run.event still establishes active");
  // A corrupt-only snapshot stays unknown.
  const corruptOnly = project([null, 42, [1, 2, 3], "raw string"]);
  assert.equal(corruptOnly.phase, "unknown");
});

// ===== M12-17-10..13: terminal-wins (activity, resurrection, malformed noise) =====

test("M12-17-10: terminal wins over LATER worker activity (malformed replay noise)", () => {
  const r = project(
    [
      ev("run.submitted"),
      ev("run.started"),
      ev("run.event", { kind: "command" }),
      ev("run.state_change", { to: "completed", reason: "done" }),
      // Malformed replay noise: worker activity AFTER the run completed.
      ev("run.event", { kind: "tool_use", tool: "Bash" }),
      ev("run.event", { kind: "command", command: "shred -f /etc/hosts" }),
    ],
    { nowFn: FIXED_NOW },
  );
  assert.equal(r.phase, "terminal", "later activity never moves a terminal stage");
  assert.equal(r.sinceTs, T0, "sinceTs stays the terminal fact's ts");
});

test("M12-17-11: resurrection attempt (terminal then running) never moves the stage", () => {
  const r = project(
    [
      ev("run.state_change", { to: "completed", reason: "done" }),
      ev("run.state_change", { to: "running", reason: "resurrected" }),
      ev("run.state_change", { to: "pending", reason: "reset" }),
    ],
    { nowFn: FIXED_NOW },
  );
  assert.equal(r.phase, "terminal", "non-terminal transitions cannot resurrect a terminal stage");
});

test("M12-17-12: repeated SAME terminal is consistent → terminal", () => {
  const r = project(
    [
      ev("run.completed"), // legacy fact
      ev("run.state_change", { to: "completed", reason: "done" }), // paired transition (TD-99)
    ],
    { nowFn: FIXED_NOW },
  );
  assert.equal(r.phase, "terminal", "consistent claims agree on one terminal state");
});

test("M12-17-13: causal — terminal THEN malformed state_change (unknown `to` / missing `to`) stays terminal", () => {
  for (const malformed of [
    { to: "mystery" }, // unknown target — malformed noise
    {}, // missing `to` — malformed noise
    { to: null },
  ]) {
    const r = project(
      [
        ev("run.state_change", { to: "completed", reason: "done", ts: "2026-07-14T00:00:02.000Z" }),
        ev("run.state_change", { ...malformed, reason: "replay", ts: "2026-07-14T00:00:04.000Z" }),
      ],
      { nowFn: FIXED_NOW },
    );
    assert.equal(r.phase, "terminal", `malformed state_change ${JSON.stringify(malformed)} after terminal is ignored`);
    assert.equal(r.sinceTs, "2026-07-14T00:00:02.000Z", "sinceTs stays the terminal transition's ts");
  }
});

// ===== M12-17-14..16: conflicting terminals degrade to unknown =====

test("M12-17-14: conflicting terminal state_changes (completed vs failed) → unknown", () => {
  const r = project([
    ev("run.state_change", { to: "completed", reason: "done" }),
    ev("run.state_change", { to: "failed", reason: "recount" }),
  ]);
  assert.deepEqual(r, { phase: "unknown", sinceTs: null, secondsSince: null });
});

test("M12-17-15: conflicting legacy facts (run.completed vs run.error) → unknown", () => {
  const r = project([
    ev("run.event", { kind: "command" }),
    ev("run.completed"),
    ev("run.error"),
  ]);
  assert.deepEqual(r, { phase: "unknown", sinceTs: null, secondsSince: null });
});

test("M12-17-16: mixed conflict (terminal state_change vs legacy fact) → unknown", () => {
  const r = project([
    ev("run.state_change", { to: "completed", reason: "done" }),
    ev("run.error"),
  ]);
  assert.deepEqual(r, { phase: "unknown", sinceTs: null, secondsSince: null });
});

// ===== M12-17-17..20: legacy family, intent-not-fact, bounded basis =====

test("M12-17-17: legacy terminal FACT without state_change → terminal (findState family)", () => {
  for (const type of ["run.completed", "run.timed_out", "run.aborted", "run.error"]) {
    const r = project([ev("run.submitted"), ev(type)]);
    assert.equal(r.phase, "terminal", `${type} alone establishes terminal`);
  }
});

test("M12-17-18: run.stop_requested is INTENT, never terminal", () => {
  const r = project([
    ev("run.submitted"),
    ev("run.started"),
    ev("run.event", { kind: "command" }),
    ev("run.stop_requested"),
  ]);
  assert.equal(r.phase, "active", "stop intent does not make the stage terminal");
});

test("M12-17-19: workflow.completed and session bookkeeping never move the stage", () => {
  const r = project([
    ev("run.submitted"),
    ev("workflow.completed"),
    ev("session.created"),
    ev("delivery.sent"),
    ev("correction.applied"),
  ]);
  assert.equal(r.phase, "accepted", "bookkeeping stays outside the bounded basis");
});

test("M12-17-20: unknown event types never move the stage", () => {
  const r = project([ev("run.submitted"), ev("some.future.type")]);
  assert.equal(r.phase, "accepted");
});

// ===== M12-17-21..23: fail-closed cross-run binding =====

test("M12-17-21: foreign-run terminal claim can never make THIS run terminal", () => {
  const r = project(
    [
      ev("run.submitted"),
      ev("run.started"),
      ev("run.event", { kind: "command" }),
      ev("run.state_change", { to: "completed", runId: "run_OTHER" }),
      ev("run.completed", { runId: "run_OTHER" }),
    ],
    { nowFn: FIXED_NOW },
  );
  assert.equal(r.phase, "active", "foreign terminal claims are ignored (no cross-run bleed)");
  assert.equal(r.sinceTs, T0);
});

test("M12-17-22: ONLY foreign events → unknown (never borrowed from another run)", () => {
  const r = project([
    ev("run.state_change", { to: "completed", runId: "run_OTHER" }),
    ev("run.event", { kind: "command", runId: "run_OTHER" }),
  ]);
  assert.equal(r.phase, "unknown");
});

test("M12-17-23: missing-envelope legacy lines stay in-scope (older transcripts / fixtures)", () => {
  // No runId on ANY line — the legacy transcript shape the status path must
  // keep tolerating (no throw, still projected).
  const r = project(
    [
      { type: "run.background_submitted", ts: "2026-07-14T00:00:00.000Z", agentId: "w", seq: 1 },
      { type: "run.state_change", to: "running", ts: "2026-07-14T00:00:01.000Z", agentId: "w", seq: 2 },
      { type: "run.event", kind: "command", command: "npm test", ts: "2026-07-14T00:00:02.000Z", agentId: "w", seq: 3 },
    ],
    { nowFn: FIXED_NOW },
  );
  assert.equal(r.phase, "active");
  assert.equal(r.secondsSince, 12);
});

// ===== M12-17-24..25: fail-closed on invalid input =====

test("M12-17-24: invalid runId throws before any event is considered", () => {
  const badIds = ["../escape", "run&injected", "run space", "", "run/path", ".hidden", "-dash", "run\x00null", null, 42];
  for (const bad of badIds) {
    assert.throws(
      () => projectExecutionStage({ events: [] }, { runId: bad }),
      /invalid runId/,
      `runId ${JSON.stringify(bad)} must throw`,
    );
  }
});

test("M12-17-25: invalid snapshot shape throws", () => {
  for (const bad of [null, undefined, 42, "str", [], { events: null }, { events: "str" }, { events: {} }]) {
    assert.throws(
      () => projectExecutionStage(bad, { runId: RUN }),
      /invalid execution-stage snapshot/,
      `snapshot ${JSON.stringify(bad)} must throw`,
    );
  }
});

// ===== M12-17-26..27: deterministic age =====

test("M12-17-26: deterministic rounded secondsSince with injectable nowFn", () => {
  const r = project(
    [
      ev("run.submitted", { ts: "2026-07-14T00:00:00.000Z" }),
      ev("run.started", { ts: "2026-07-14T00:00:01.500Z" }),
    ],
    { nowFn: FIXED_NOW },
  );
  assert.equal(r.phase, "spawned");
  assert.equal(r.sinceTs, "2026-07-14T00:00:01.500Z", "raw ts is preserved verbatim");
  assert.equal(r.secondsSince, 13, "rounded (14s - 1.5s) → 12.5 → 13");
});

test("M12-17-27: unparseable/absent ts → sinceTs raw string kept, secondsSince null", () => {
  const noTs = project([ev("run.event", { ts: undefined })], { nowFn: FIXED_NOW });
  assert.equal(noTs.phase, "active");
  assert.equal(noTs.sinceTs, null);
  assert.equal(noTs.secondsSince, null);

  const badTs = project([ev("run.event", { ts: "not-a-date" })], { nowFn: FIXED_NOW });
  assert.equal(badTs.phase, "active");
  assert.equal(badTs.sinceTs, "not-a-date", "raw ts preserved even when unparseable");
  assert.equal(badTs.secondsSince, null, "age unknowable → null");
});

// ===== M12-17-28: purity — no payload echo, no mutation =====

test("M12-17-28: projection returns only the closed-shape stage; input events unchanged", () => {
  const lines = [ev("run.submitted"), ev("run.started"), ev("run.event", { kind: "tool_use", tool: "Bash", input: { command: "secret" } })];
  const snapshot = Object.freeze({ events: Object.freeze([...lines]) });
  const r = projectExecutionStage(snapshot, { runId: RUN, nowFn: FIXED_NOW });
  assert.deepEqual(Object.keys(r).sort(), ["phase", "secondsSince", "sinceTs"]);
  // No event payload (kind/tool/input/command/secret) ever leaves the module.
  assert.ok(!JSON.stringify(r).includes("secret") && !JSON.stringify(r).includes("tool_use"));
  assert.deepEqual([...snapshot.events], lines, "input events never mutated");
});
