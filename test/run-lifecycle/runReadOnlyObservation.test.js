// test/run-lifecycle/runReadOnlyObservation.test.js
//
// Round 4 Bundle B — the pure, provider-neutral read-only observation
// projector (advisory + in-flight alerting, NO hard gate).
//
// Owner constraint pinned by this file: WAO presents objective observation +
// alerting for a declared read-only run — it NEVER auto-stops, NEVER rewrites
// the terminal state, and has NO hard failure gate. A read-only run whose
// worker writes files anyway reaches its NATURAL terminal state; the observed
// writes surface as the closed-set `writes_observed` fact for the Lead's
// final judgment. Presentation is not action.
//
// Contract under test (src/application/runReadOnlyObservation.js):
//   - authority = exactly ONE bound run.started with an absolute worktreePath
//     (read-only runs are non-delivery — no allowedPaths consulted) PLUS
//     exactly ONE bound run.read_only_declared event;
//   - only confirmed run.event kind=file_written events from the frozen
//     snapshot are considered (never commands, tool_use, worker text, Git
//     status, or filesystem scans);
//   - statuses: no_writes_observed | writes_observed | unknown. status reports
//     the CURRENT snapshot (a non-terminal snapshot may already be
//     writes_observed — the in-flight alert); complete = terminal AND fully
//     evaluable;
//   - ANY unevaluable file-written path voids the observation -> unknown
//     (fail-closed); missing/ambiguous authority and missing/duplicate/
//     cross-run declarations -> unknown;
//   - dedupe actual relative paths before counts, deterministic sort, shared
//     writtenPaths cap + per-path cap; redact/sanitize/bound every dynamic
//     path before it crosses the boundary;
//   - advisory only: no transcript append, no filesystem read/scan, no
//     stop/retry mutation, no semantic decision, NEVER throws;
//   - mounting (via projectRunActivity): readOnlyObservation is attached ONLY
//     when the frozen prefix carries a bound run.read_only_declared fact — an
//     undeclared run keeps the field absent (byte-compatible), and a
//     continuation cursor projects its frozen prefix.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  projectReadOnlyObservation,
  READ_ONLY_OBSERVATION_STATUSES,
  READ_ONLY_OBSERVATION_SOURCE,
  READ_ONLY_WRITTEN_PATHS_CAP,
  READ_ONLY_OBSERVATION_PATH_CAP,
} from "../../src/application/runReadOnlyObservation.js";
import { projectRunActivity } from "../../src/application/runActivityProjection.js";

// ===== Helpers =====

const RUN_ID = "run_ro";
const OTHER_RUN_ID = "run_other";
// A Windows drive-qualified absolute worktree (lexical checks are platform-
// neutral — the projector reasons over the persisted text, never fs).
const WORKTREE = "D:/wao-runs/read_only_1";

function startedEvent(overrides = {}) {
  return {
    ts: "2026-08-16T00:00:00.000Z",
    runId: RUN_ID,
    agentId: "coder_low",
    type: "run.started",
    backend: "claude-code",
    worktreePath: WORKTREE,
    ...overrides,
  };
}

function declaredEvent(overrides = {}) {
  return {
    ts: "2026-08-16T00:00:00.500Z",
    runId: RUN_ID,
    agentId: "coder_low",
    type: "run.read_only_declared",
    ...overrides,
  };
}

function writtenEvent(path, overrides = {}) {
  return {
    ts: "2026-08-16T00:00:01.000Z",
    runId: RUN_ID,
    agentId: "coder_low",
    type: "run.event",
    kind: "file_written",
    path,
    ...overrides,
  };
}

function messageEvent(text, overrides = {}) {
  return {
    ts: "2026-08-16T00:00:02.000Z",
    runId: RUN_ID,
    agentId: "coder_low",
    type: "run.event",
    kind: "message",
    role: "assistant",
    parts: [{ type: "text", text }],
    ...overrides,
  };
}

function stateEvent(to, overrides = {}) {
  return {
    ts: "2026-08-16T00:00:03.000Z",
    runId: RUN_ID,
    agentId: "coder_low",
    type: "run.state_change",
    from: "running",
    to,
    ...overrides,
  };
}

function ro(events, opts = {}) {
  return projectReadOnlyObservation(events, {
    runId: RUN_ID,
    terminal: opts.terminal ?? false,
    env: opts.env,
  });
}

// The minimal valid read-only authority: one started + one declaration.
function base(overrides = {}) {
  return [startedEvent(), declaredEvent(), ...(overrides.extra ?? [])];
}

function projSnap(events, terminal = false) {
  return {
    events,
    agentId: "coder_low",
    backend: "claude-code",
    state: terminal ? "completed" : "running",
    terminal,
  };
}

// =====================================================================
// Constants / closed sets (single source shared with the MCP schema)
// =====================================================================

test("RO-C: closed status set, literal source, exported positive caps", () => {
  assert.deepEqual(READ_ONLY_OBSERVATION_STATUSES, [
    "no_writes_observed", "writes_observed", "unknown",
  ]);
  assert.equal(READ_ONLY_OBSERVATION_SOURCE, "transcript_file_events");
  assert.ok(Number.isInteger(READ_ONLY_WRITTEN_PATHS_CAP)
    && READ_ONLY_WRITTEN_PATHS_CAP > 0, "writtenPaths cap is a positive integer");
  assert.ok(Number.isInteger(READ_ONLY_OBSERVATION_PATH_CAP)
    && READ_ONLY_OBSERVATION_PATH_CAP > 0, "per-path cap is a positive integer");
});

// =====================================================================
// no_writes_observed (honest semantics: OBSERVED, not proven-absent)
// =====================================================================

test("RO-1: declared run with zero observed writes -> no_writes_observed, running complete=false", () => {
  const r = ro(base());
  assert.equal(r.status, "no_writes_observed");
  assert.equal(r.source, READ_ONLY_OBSERVATION_SOURCE);
  assert.equal(r.complete, false, "non-terminal snapshot is not complete");
  assert.equal(r.observedFileCount, 0);
  assert.deepEqual(r.writtenPaths, []);
  assert.equal(r.writtenPathCount, 0);
  assert.equal(r.writtenPathsTruncated, false);
});

test("RO-2: no_writes_observed terminal -> complete=true", () => {
  const r = ro(base(), { terminal: true });
  assert.equal(r.status, "no_writes_observed");
  assert.equal(r.complete, true);
});

test("RO-3: non-write events (messages/commands/tool_use) are never writes", () => {
  const r = ro(base({
    extra: [
      messageEvent("I made no changes."),
      { ts: "t", runId: RUN_ID, agentId: "coder_low", type: "run.event", kind: "command", exitCode: 0 },
      { ts: "t", runId: RUN_ID, agentId: "coder_low", type: "run.event", kind: "tool_use", tool: "Read" },
    ],
  }));
  assert.equal(r.status, "no_writes_observed");
  assert.equal(r.observedFileCount, 0);
});

// =====================================================================
// writes_observed (terminal AND non-terminal — the in-flight alert)
// =====================================================================

test("RO-4: relative write inside the worktree -> writes_observed, non-terminal complete=false", () => {
  const r = ro(base({ extra: [writtenEvent("src/a.js")] }));
  assert.equal(r.status, "writes_observed");
  assert.equal(r.complete, false);
  assert.equal(r.observedFileCount, 1);
  assert.deepEqual(r.writtenPaths, ["src/a.js"]);
  assert.equal(r.writtenPathCount, 1);
  assert.equal(r.writtenPathsTruncated, false);
});

test("RO-5: absolute event path proven lexically inside the worktree derives the relative path", () => {
  const r = ro(base({ extra: [writtenEvent(`${WORKTREE}/src/deep/b.js`)] }));
  assert.equal(r.status, "writes_observed");
  assert.equal(r.observedFileCount, 1);
  assert.deepEqual(r.writtenPaths, ["src/deep/b.js"]);
});

test("RO-6: backslash separators normalize to POSIX", () => {
  const r = ro(base({ extra: [writtenEvent(`${WORKTREE}\\src\\c.js`)] }));
  assert.equal(r.status, "writes_observed");
  assert.deepEqual(r.writtenPaths, ["src/c.js"]);
});

test("RO-7: '..' segments that stay inside the worktree normalize and remain evaluable", () => {
  const r = ro(base({ extra: [writtenEvent("src/../docs/d.js")] }));
  assert.equal(r.status, "writes_observed");
  assert.deepEqual(r.writtenPaths, ["docs/d.js"]);
});

test("RO-8: dedupe — the same path written twice is ONE observed fact; sort is deterministic", () => {
  const r = ro(base({
    extra: [writtenEvent("z/z.js"), writtenEvent("src/a.js"), writtenEvent("src/a.js")],
  }));
  assert.equal(r.status, "writes_observed");
  assert.equal(r.observedFileCount, 2);
  assert.deepEqual(r.writtenPaths, ["src/a.js", "z/z.js"]);
});

// =====================================================================
// NO HARD GATE (Owner constraint) — terminal snapshot with writes stays
// writes_observed + complete; nothing is mutated, nothing is escalated.
// =====================================================================

test("RO-G1: TERMINAL snapshot containing file_written -> writes_observed + complete:true, state-machine facts unchanged", () => {
  // The full honest shape: declaration, a write, then a NATURAL terminal
  // transition. The projection must report the write and leave every fact
  // exactly as persisted — no stop/abort/escalation is invented.
  const events = [
    startedEvent(),
    declaredEvent(),
    writtenEvent("src/a.js"),
    writtenEvent("docs/b.md"),
    stateEvent("completed", { reason: "completed" }),
  ];
  // Freeze the input: a pure advisory projector must not mutate the snapshot
  // (no stop/abort side effect can exist if nothing can be written).
  Object.freeze(events);
  for (const e of events) Object.freeze(e);

  const r = ro(events, { terminal: true });
  assert.equal(r.status, "writes_observed");
  assert.equal(r.complete, true);
  assert.deepEqual(r.writtenPaths, ["docs/b.md", "src/a.js"]);
  // The persisted state-machine fact is untouched by observation.
  const terminal = events.find((e) => e.type === "run.state_change");
  assert.equal(terminal.to, "completed", "terminal fact unchanged (natural terminal state)");
  assert.ok(!events.some((e) => e.type === "run.stop_requested" || e.type === "run.aborted"),
    "observation invents no stop/abort fact");
});

test("RO-G2: NON-TERMINAL snapshot with file_written -> writes_observed + complete:false (in-flight alert, not action)", () => {
  const r = ro(base({ extra: [writtenEvent("src/a.js")] }), { terminal: false });
  assert.equal(r.status, "writes_observed");
  assert.equal(r.complete, false,
    "running snapshot alerts honestly without claiming completeness");
});

// =====================================================================
// fail-closed: unevaluable paths / authority / declaration ambiguity
// =====================================================================

test("RO-9: lexical escape ('..' out of the worktree) -> unknown", () => {
  assert.equal(ro(base({ extra: [writtenEvent("../escape.js")] })).status, "unknown");
  assert.equal(ro(base({ extra: [writtenEvent("src/../../escape.js")] })).status, "unknown");
});

test("RO-10: absolute event path outside the worktree -> unknown (not evaluable)", () => {
  assert.equal(ro(base({ extra: [writtenEvent("C:/Outside/evil.exe")] })).status, "unknown");
  assert.equal(ro(base({ extra: [writtenEvent("/etc/passwd")] })).status, "unknown");
});

test("RO-11: ANY unevaluable path voids the observation; observedFileCount keeps the evaluable truth", () => {
  const r = ro(base({ extra: [writtenEvent("src/a.js"), writtenEvent("C:/Outside/x.js")] }));
  assert.equal(r.status, "unknown");
  assert.equal(r.observedFileCount, 1, "evaluable count stays truthful");
  assert.equal(r.writtenPathCount, 0);
  assert.deepEqual(r.writtenPaths, []);
});

test("RO-12: malformed raw path non-leakage — non-string / empty / NUL -> unknown, raw never crosses", () => {
  const r = ro(base({ extra: [writtenEvent(42), writtenEvent("")] }));
  assert.equal(r.status, "unknown");
  const r2 = ro(base({ extra: [writtenEvent("malformed\u0000raw.js")] }));
  assert.equal(r2.status, "unknown");
  assert.ok(!JSON.stringify(r2).includes("malformed"), "raw malformed path never crosses");
  const r3 = ro(base({ extra: [writtenEvent("C:/Windows/system32/key.pem")] }));
  assert.equal(r3.status, "unknown");
  assert.ok(!JSON.stringify(r3).includes("system32"), "absolute outside path never crosses");
});

test("RO-13: authority missing/ambiguous -> unknown", () => {
  // no run.started
  assert.equal(ro([declaredEvent()]).status, "unknown");
  // run.started without a worktreePath (degraded/unisolated run)
  assert.equal(ro([startedEvent({ worktreePath: undefined }), declaredEvent()]).status, "unknown");
  // relative worktreePath text is not an absolute authority
  assert.equal(ro([startedEvent({ worktreePath: "relative/wt" }), declaredEvent()]).status, "unknown");
  // duplicate run.started -> ambiguous
  assert.equal(ro([startedEvent(), startedEvent(), declaredEvent()]).status, "unknown");
  // cross-run run.started is not this run's authority
  assert.equal(ro([startedEvent({ runId: OTHER_RUN_ID }), declaredEvent()]).status, "unknown");
});

test("RO-14: declaration missing/duplicate/cross-run/malformed -> unknown", () => {
  // no declaration
  assert.equal(ro([startedEvent()]).status, "unknown");
  // duplicate declarations -> ambiguous
  assert.equal(ro([startedEvent(), declaredEvent(), declaredEvent()]).status, "unknown");
  // cross-run declaration is not this run's declaration
  assert.equal(ro([startedEvent(), declaredEvent({ runId: OTHER_RUN_ID })]).status, "unknown");
});

test("RO-15: cross-run file_written events are NOT counted (binding defense)", () => {
  const r = ro(base({
    extra: [
      writtenEvent("src/a.js"),
      writtenEvent("src/other.js", { runId: OTHER_RUN_ID }),
    ],
  }));
  assert.equal(r.status, "writes_observed");
  assert.equal(r.observedFileCount, 1, "only this run's bound writes count");
  assert.deepEqual(r.writtenPaths, ["src/a.js"]);
});

// =====================================================================
// cap / truncation truth
// =====================================================================

test("RO-16: writtenPathCount retains full truth while writtenPaths is capped; truncated is truthful", () => {
  const writes = [];
  for (let i = 0; i < 30; i += 1) writes.push(writtenEvent(`test/w${i}.js`));
  const r = ro(base({ extra: writes }));
  assert.equal(r.status, "writes_observed");
  assert.equal(r.observedFileCount, 30);
  assert.equal(r.writtenPathCount, 30, "full bounded observation truth");
  assert.equal(r.writtenPaths.length, READ_ONLY_WRITTEN_PATHS_CAP, "list capped at the shared constant");
  assert.equal(r.writtenPathsTruncated, true);
  assert.equal(r.writtenPaths[0], "test/w0.js", "deterministic sort before cap");
  // below the cap: no truncation flag.
  const small = ro(base({ extra: [writtenEvent("test/a.js"), writtenEvent("test/b.js")] }));
  assert.equal(small.writtenPathsTruncated, false);
});

test("RO-17: an over-long written path is bounded after redaction, never crosses unbounded", () => {
  const long = `test/${"x".repeat(300)}.js`;
  const r = ro(base({ extra: [writtenEvent(long)] }));
  assert.equal(r.status, "writes_observed");
  assert.equal(r.writtenPathCount, 1);
  assert.ok(r.writtenPaths[0].length <= READ_ONLY_OBSERVATION_PATH_CAP,
    "path bounded by the shared per-path cap");
});

// =====================================================================
// secret redaction (actual paths drive the decision; output is redacted)
// =====================================================================

test("RO-18: status decided on ACTUAL paths; output paths redacted before crossing", () => {
  const env = { RO_TOKEN: "TKN9SECRET9" };
  const r = ro(base({ extra: [writtenEvent("test/TKN9SECRET9/x.js")] }), { env });
  assert.equal(r.status, "writes_observed", "decision on the actual path");
  assert.equal(r.writtenPathCount, 1);
  assert.ok(r.writtenPaths[0].includes("[REDACTED"), "output path redacted");
  assert.ok(!JSON.stringify(r).includes("TKN9SECRET9"), "raw secret never crosses");
});

test("RO-19: secret-redaction collisions preserve one safe list entry per distinct observed fact", () => {
  const env = { RO_TOKEN: "TKN9SECRET9" };
  const r = ro(base({
    extra: [
      writtenEvent("test/TKN9SECRET9/a.js"),
      writtenEvent("test/[REDACTED:RO_TOKEN]/a.js"),
    ],
  }), { env });
  assert.equal(r.status, "writes_observed");
  assert.equal(r.writtenPathCount, 2);
  assert.equal(r.writtenPaths.length, 2,
    "redaction must not silently collapse two distinct observed paths into one list item");
  assert.ok(!JSON.stringify(r).includes("TKN9SECRET9"));
});

// =====================================================================
// never throws on garbage input; absent facts never break readability
// =====================================================================

test("RO-20: garbage input collapses to unknown — never throws", () => {
  for (const input of [null, undefined, "nope", {}, [42], [null]]) {
    const r = projectReadOnlyObservation(input, { runId: RUN_ID });
    assert.equal(r.status, "unknown", `input ${JSON.stringify(input)} -> unknown`);
    assert.equal(r.complete, false);
  }
  const noRunId = projectReadOnlyObservation([startedEvent(), declaredEvent()], { runId: 42 });
  assert.equal(noRunId.status, "unknown");
});

// =====================================================================
// mounting via projectRunActivity (input-side discrimination)
// =====================================================================

test("RO-M1: an UNDECLARED run keeps readOnlyObservation absent (byte-compatible ordinary payload)", () => {
  const page = projectRunActivity(projSnap([startedEvent(), writtenEvent("src/a.js")]), {
    runId: RUN_ID,
    audience: "lead",
  });
  assert.equal("readOnlyObservation" in page, false, "field absent for an undeclared run");
  // The ordinary contract is intact.
  assert.ok(page.scopeObservation, "scopeObservation remains the always-on advisory");
  assert.ok(Array.isArray(page.entries));
});

test("RO-M2: a DECLARED run attaches readOnlyObservation from the same frozen snapshot", () => {
  const page = projectRunActivity(
    projSnap([startedEvent(), declaredEvent(), writtenEvent("src/a.js")]),
    { runId: RUN_ID, audience: "lead" },
  );
  assert.ok(page.readOnlyObservation, "field present for a declared run");
  assert.equal(page.readOnlyObservation.status, "writes_observed");
  assert.equal(page.readOnlyObservation.complete, false);
  // The declaration is control-plane bookkeeping — no timeline entry for it.
  assert.equal(page.counts.other, 0, "run.read_only_declared adds no activity entry");
});

test("RO-M3: declared run via cursor continuation projects the FROZEN prefix; fresh page-1 sees the append", () => {
  const prefix = [
    startedEvent(),
    declaredEvent(),
    ...Array.from({ length: 15 }, (_, i) => messageEvent(`m${i}`)),
  ];
  const page1 = projectRunActivity(projSnap(prefix), {
    runId: RUN_ID, audience: "lead", pageSize: 8,
  });
  assert.ok(page1.nextCursor, "page 1 has a cursor");
  assert.equal(page1.readOnlyObservation.status, "no_writes_observed");

  // Append a later write while the run is still running.
  const grownRunning = [...prefix, writtenEvent("src/late.js")];
  const cont = projectRunActivity(projSnap(grownRunning), {
    runId: RUN_ID, audience: "lead", pageSize: 8, cursor: page1.nextCursor,
  });
  assert.equal(cont.readOnlyObservation.status, "no_writes_observed",
    "continuation stays bound to the frozen prefix (append-only stable)");
  assert.equal(cont.readOnlyObservation.complete, false, "snapshot still running");

  const freshRunning = projectRunActivity(projSnap(grownRunning), {
    runId: RUN_ID, audience: "lead", pageSize: 8,
  });
  assert.equal(freshRunning.readOnlyObservation.status, "writes_observed",
    "fresh page-1 observes the appended write (in-flight alert)");
  assert.equal(freshRunning.readOnlyObservation.complete, false);

  // After the natural terminal transition, a fresh read is complete.
  const grownTerminal = [...grownRunning, stateEvent("completed")];
  const freshTerminal = projectRunActivity(projSnap(grownTerminal, true), {
    runId: RUN_ID, audience: "lead", pageSize: 8,
  });
  assert.equal(freshTerminal.readOnlyObservation.status, "writes_observed");
  assert.equal(freshTerminal.readOnlyObservation.complete, true);
  assert.deepEqual(freshTerminal.readOnlyObservation.writtenPaths, ["src/late.js"]);
});

test("RO-M4: a snapshot carrying a foreign-run event fails closed at the envelope (before any projection)", () => {
  // Cross-run binding defense lives at the snapshot envelope: every event must
  // carry the requested runId, so a foreign declaration can never even reach
  // the mounting decision. (The pure-projector cross-run cases are RO-13..15.)
  assert.throws(
    () => projectRunActivity(
      projSnap([startedEvent(), declaredEvent({ runId: OTHER_RUN_ID })]),
      { runId: RUN_ID, audience: "lead" },
    ),
    /runId binding failed/,
    "envelope binding rejects the foreign event fail-closed",
  );
});
