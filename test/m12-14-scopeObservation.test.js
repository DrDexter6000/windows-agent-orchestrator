// test/m12-14-scopeObservation.test.js
//
// M12-14 — advisory scope-observation package RED→GREEN causal tests.
//
// The pure, provider-neutral application projector that tells the Lead whether
// the confirmed file_written events in the SAME frozen transcript snapshot are
// still within the persisted delivery.allowedPaths contract. Facts only:
//   - authority = exactly ONE bound run.started with an absolute worktreePath
//     and a non-empty delivery.allowedPaths;
//   - only confirmed run.event kind=file_written events from the frozen
//     snapshot are considered (never commands, tool_use, worker text, Git
//     status, or filesystem scans);
//   - a relative path is derived ONLY when the event path is proven lexically
//     inside the persisted worktreePath, normalized to POSIX, validated with
//     the projected-path SSOT (isValidRepoRelativePath), and compared with the
//     exported delivery.isPathAllowed segment-boundary SSOT;
//   - within / outside / unknown per contract; complete = terminal snapshot
//     AND fully evaluable (never for unknown, never while running);
//   - dedupe actual relative paths before counts, deterministic sort, one
//     exported outsidePaths cap shared with the MCP schema;
//   - redact/sanitize/bound every dynamic path before it crosses the
//     projection boundary — no worktree absolute path, credential, prompt,
//     command, tool input, PID, provider payload, session id, or raw malformed
//     path ever leaks;
//   - advisory only: no transcript append, no filesystem read/scan, no
//     stop/retry/continue/repackage/allowedPaths mutation, no semantic
//     decision; historical/non-delivery transcripts stay readable as unknown
//     and NEVER throw solely because scope facts are absent.
//
// Frozen-cursor truth (via projectRunActivity): a continuation cursor projects
// scopeObservation from its frozen prefix; appending a later outside file
// cannot alter an existing cursor result while a fresh page-1 call may observe
// it. Covers the contract matrix: within, outside, running complete=false,
// terminal complete=true, zero writes, missing/malformed/duplicate contract,
// lexical escape, malformed raw path non-leakage, segment-boundary mismatch,
// dedupe/sort/cap, secret redaction, frozen cursor stability.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  projectScopeObservation,
  SCOPE_OBSERVATION_STATUSES,
  SCOPE_OBSERVATION_SOURCE,
  SCOPE_OBSERVATION_OUTSIDE_PATHS_CAP,
  SCOPE_OBSERVATION_PATH_CAP,
} from "../src/application/runScopeObservation.js";
import { projectRunActivity } from "../src/application/runActivityProjection.js";

// ===== Helpers =====

const RUN_ID = "run_scope";
// A Windows drive-qualified absolute worktree (lexical checks are platform-
// neutral — the projector reasons over the persisted text, never fs).
const WORKTREE = "D:/wao-runs/scope_1";
const ALLOWED = ["src", "test/manifest.json"];

function startedEvent(overrides = {}) {
  return {
    ts: "2026-08-02T00:00:00.000Z",
    runId: RUN_ID,
    agentId: "coder_low",
    type: "run.started",
    backend: "claude-code",
    worktreePath: WORKTREE,
    delivery: {
      mode: "git_commit_v1",
      baseCommit: "a".repeat(40),
      allowedPaths: [...ALLOWED],
      verificationCommands: ["node --test"],
    },
    ...overrides,
  };
}

function writtenEvent(path, overrides = {}) {
  return {
    ts: "2026-08-02T00:00:01.000Z",
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
    ts: "2026-08-02T00:00:02.000Z",
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
    ts: "2026-08-02T00:00:03.000Z",
    runId: RUN_ID,
    agentId: "coder_low",
    type: "run.state_change",
    from: "running",
    to,
    ...overrides,
  };
}

function scope(events, opts = {}) {
  return projectScopeObservation(events, {
    runId: RUN_ID,
    terminal: opts.terminal ?? false,
    env: opts.env,
  });
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
test("constants: closed status set, literal source, exported positive caps", () => {
  assert.deepEqual(SCOPE_OBSERVATION_STATUSES, [
    "within_declared_paths", "outside_declared_paths", "unknown",
  ]);
  assert.equal(SCOPE_OBSERVATION_SOURCE, "transcript_file_events");
  assert.ok(Number.isInteger(SCOPE_OBSERVATION_OUTSIDE_PATHS_CAP)
    && SCOPE_OBSERVATION_OUTSIDE_PATHS_CAP > 0, "outsidePaths cap is a positive integer");
  assert.ok(Number.isInteger(SCOPE_OBSERVATION_PATH_CAP)
    && SCOPE_OBSERVATION_PATH_CAP > 0, "per-path cap is a positive integer");
});

// =====================================================================
// within_declared_paths
// =====================================================================
test("within: all observed writes inside allowedPaths -> within, running complete=false", () => {
  const r = scope([startedEvent(), writtenEvent("src/a.js")]);
  assert.equal(r.status, "within_declared_paths");
  assert.equal(r.source, SCOPE_OBSERVATION_SOURCE);
  assert.equal(r.complete, false);
  assert.equal(r.observedFileCount, 1);
  assert.deepEqual(r.outsidePaths, []);
  assert.equal(r.outsidePathCount, 0);
  assert.equal(r.outsidePathsTruncated, false);
});

test("within: absolute event path proven lexically inside the worktree derives the relative path", () => {
  const r = scope([startedEvent(), writtenEvent(`${WORKTREE}/src/deep/b.js`)]);
  assert.equal(r.status, "within_declared_paths");
  assert.equal(r.observedFileCount, 1);
});

test("within: backslash separators normalize to POSIX for containment + comparison", () => {
  const r = scope([startedEvent(), writtenEvent(`${WORKTREE}\\src\\c.js`)]);
  assert.equal(r.status, "within_declared_paths");
  assert.equal(r.observedFileCount, 1);
  const r2 = scope([startedEvent(), writtenEvent("test\\manifest.json")]);
  assert.equal(r2.status, "within_declared_paths", "exact-match allowed entry");
});

test("Windows containment: absolute worktree/event path casing differences remain the same path", () => {
  const r = scope([
    startedEvent({ worktreePath: "D:/WAO-Runs/Scope_1" }),
    writtenEvent("d:/wao-runs/scope_1/src/case.js"),
  ]);
  assert.equal(r.status, "within_declared_paths",
    "Windows drive paths are case-insensitive for absolute containment proof");
  assert.equal(r.observedFileCount, 1);
});

test("within: '..' segments that stay inside the worktree normalize and remain evaluable", () => {
  const r = scope([startedEvent(), writtenEvent("src/../test/manifest.json")]);
  assert.equal(r.status, "within_declared_paths", "normalizes to test/manifest.json (allowed)");
  assert.equal(r.observedFileCount, 1);
});

// =====================================================================
// outside_declared_paths
// =====================================================================
test("outside: evaluable relative path outside allowedPaths -> outside_declared_paths", () => {
  const r = scope([startedEvent(), writtenEvent("test/bad.js")]);
  assert.equal(r.status, "outside_declared_paths");
  assert.equal(r.complete, false);
  assert.equal(r.observedFileCount, 1);
  assert.deepEqual(r.outsidePaths, ["test/bad.js"]);
  assert.equal(r.outsidePathCount, 1);
  assert.equal(r.outsidePathsTruncated, false);
});

test("outside: segment-boundary mismatch (src2/a.js vs allowed src) is outside, src/a.js is within", () => {
  const r = scope([startedEvent(), writtenEvent("src2/a.js")]);
  assert.equal(r.status, "outside_declared_paths", "src2/a.js is NOT a descendant of src");
  assert.deepEqual(r.outsidePaths, ["src2/a.js"]);
  const r2 = scope([startedEvent(), writtenEvent("src/a.js")]);
  assert.equal(r2.status, "within_declared_paths", "src/a.js IS a descendant of src");
  const r3 = scope([startedEvent(), writtenEvent("test/manifest.json")]);
  assert.equal(r3.status, "within_declared_paths", "exact-match allowed entry");
});

test("outside: dedupe actual relative paths before counts; deterministic sort", () => {
  const r = scope([
    startedEvent(),
    writtenEvent("test/z.js"),
    writtenEvent("test/a.js"),
    writtenEvent("test/z.js"), // duplicate actual path — counted once
    writtenEvent("test/b.js"),
  ]);
  assert.equal(r.observedFileCount, 3, "deduped actual relative paths");
  assert.equal(r.outsidePathCount, 3);
  assert.deepEqual(r.outsidePaths, ["test/a.js", "test/b.js", "test/z.js"], "sorted deterministically");
});

// =====================================================================
// complete semantics
// =====================================================================
test("complete: true on a terminal snapshot for both within and outside", () => {
  const within = scope([startedEvent(), writtenEvent("src/a.js")], { terminal: true });
  assert.equal(within.status, "within_declared_paths");
  assert.equal(within.complete, true);
  const outside = scope([startedEvent(), writtenEvent("test/bad.js")], { terminal: true });
  assert.equal(outside.status, "outside_declared_paths");
  assert.equal(outside.complete, true);
});

test("complete: false while running, even with a fully evaluable observation", () => {
  const r = scope([startedEvent(), writtenEvent("src/a.js")], { terminal: false });
  assert.equal(r.status, "within_declared_paths");
  assert.equal(r.complete, false);
});

test("complete: unknown is NEVER complete, even on a terminal snapshot", () => {
  const r = scope([startedEvent(), writtenEvent("../escape.js")], { terminal: true });
  assert.equal(r.status, "unknown");
  assert.equal(r.complete, false);
  const r2 = scope([startedEvent({ delivery: undefined })], { terminal: true });
  assert.equal(r2.status, "unknown");
  assert.equal(r2.complete, false);
});

// =====================================================================
// zero writes
// =====================================================================
test("zero writes: valid contract with no file_written events -> within, observedFileCount 0", () => {
  const running = scope([startedEvent()]);
  assert.equal(running.status, "within_declared_paths", "nothing observed outside is vacuously within");
  assert.equal(running.observedFileCount, 0);
  assert.equal(running.outsidePathCount, 0);
  assert.equal(running.complete, false);
  const terminal = scope([startedEvent(), stateEvent("completed")], { terminal: true });
  assert.equal(terminal.status, "within_declared_paths");
  assert.equal(terminal.complete, true);
  assert.equal(terminal.observedFileCount, 0);
});

// =====================================================================
// missing / malformed / ambiguous contract -> unknown
// =====================================================================
test("missing contract: no run.started -> unknown, readable, never throws", () => {
  const r = scope([]);
  assert.equal(r.status, "unknown");
  assert.equal(r.complete, false);
  assert.equal(r.observedFileCount, 0);
  assert.deepEqual(r.outsidePaths, []);
  assert.equal(r.outsidePathCount, 0);
  assert.equal(r.outsidePathsTruncated, false);
  const r2 = scope([writtenEvent("src/a.js")]);
  assert.equal(r2.status, "unknown");
});

test("non-delivery run: run.started without delivery context -> unknown", () => {
  const r = scope([startedEvent({ delivery: undefined }), writtenEvent("src/a.js")]);
  assert.equal(r.status, "unknown");
  assert.equal(r.complete, false);
  const r2 = scope([startedEvent({ worktreePath: undefined }), writtenEvent("src/a.js")]);
  assert.equal(r2.status, "unknown");
});

test("malformed contract: allowedPaths missing / empty / non-array / invalid entry -> unknown", () => {
  for (const allowedPaths of [undefined, [], "src", [".."], ["src/../evil.js"], [42]]) {
    const r = scope([startedEvent({ delivery: { mode: "git_commit_v1", allowedPaths } }), writtenEvent("src/a.js")]);
    assert.equal(r.status, "unknown", `allowedPaths=${JSON.stringify(allowedPaths)} -> unknown`);
    assert.equal(r.complete, false);
  }
});

test("malformed contract: relative or empty worktreePath -> unknown", () => {
  const r = scope([startedEvent({ worktreePath: "relative/workspace" }), writtenEvent("src/a.js")]);
  assert.equal(r.status, "unknown");
  const r2 = scope([startedEvent({ worktreePath: "" }), writtenEvent("src/a.js")]);
  assert.equal(r2.status, "unknown");
});

test("ambiguous contract: duplicate bound run.started events -> unknown", () => {
  const r = scope([startedEvent(), startedEvent({ ts: "2026-08-02T00:00:05.000Z" }), writtenEvent("src/a.js")]);
  assert.equal(r.status, "unknown");
});

test("cross-run: a run.started bound to another runId is not authority -> unknown", () => {
  const r = scope([startedEvent({ runId: "run_other" }), writtenEvent("src/a.js")]);
  assert.equal(r.status, "unknown");
  const r2 = scope([startedEvent(), writtenEvent("src/a.js", { runId: "run_other" })]);
  assert.equal(r2.status, "within_declared_paths", "another run's file write is not observed");
  assert.equal(r2.observedFileCount, 0);
});

// =====================================================================
// lexical escape / malformed raw path -> unknown, never leaked
// =====================================================================
test("lexical escape: '..' escaping the worktree root -> unknown (unevaluable)", () => {
  const r = scope([startedEvent(), writtenEvent("../escape.js")]);
  assert.equal(r.status, "unknown");
  const r2 = scope([startedEvent(), writtenEvent("src/../../escape.js")]);
  assert.equal(r2.status, "unknown");
});

test("absolute event path outside the worktree -> unknown (not evaluable)", () => {
  const r = scope([startedEvent(), writtenEvent("C:/Outside/evil.exe")]);
  assert.equal(r.status, "unknown");
  const r2 = scope([startedEvent(), writtenEvent("/etc/passwd")]);
  assert.equal(r2.status, "unknown");
});

test("malformed raw path non-leakage: non-string / empty / NUL paths -> unknown, raw never crosses", () => {
  const r = scope([startedEvent(), writtenEvent(42), writtenEvent("")]);
  assert.equal(r.status, "unknown");
  const dumped = JSON.stringify(r);
  assert.ok(!dumped.includes("NONSTR"), "raw non-string value never crosses");
  const r2 = scope([startedEvent(), writtenEvent("malformed\u0000raw.js")]);
  assert.equal(r2.status, "unknown");
  assert.ok(!JSON.stringify(r2).includes("malformed"), "raw malformed path never crosses");
  const r3 = scope([startedEvent(), writtenEvent("C:/Windows/system32/key.pem")]);
  assert.equal(r3.status, "unknown");
  assert.ok(!JSON.stringify(r3).includes("system32"), "absolute outside path never crosses");
});

test("unevaluable among evaluable: the whole observation is unknown; observedFileCount keeps the evaluable count", () => {
  const r = scope([startedEvent(), writtenEvent("src/a.js"), writtenEvent("C:/Outside/x.js")]);
  assert.equal(r.status, "unknown", "ANY unevaluable file-written path voids the observation");
  assert.equal(r.observedFileCount, 1, "evaluable count is still truthful");
  assert.equal(r.outsidePathCount, 0);
  assert.deepEqual(r.outsidePaths, []);
});

// =====================================================================
// dedupe / sort / cap
// =====================================================================
test("cap: outsidePathCount retains full truth while outsidePaths is capped; truncated is truthful", () => {
  const writes = [];
  for (let i = 0; i < 30; i += 1) writes.push(writtenEvent(`test/w${i}.js`));
  const r = scope([startedEvent(), ...writes]);
  assert.equal(r.status, "outside_declared_paths");
  assert.equal(r.observedFileCount, 30);
  assert.equal(r.outsidePathCount, 30, "full bounded observation truth");
  assert.equal(r.outsidePaths.length, SCOPE_OBSERVATION_OUTSIDE_PATHS_CAP, "list capped at the shared constant");
  assert.equal(r.outsidePathsTruncated, true);
  assert.equal(r.outsidePaths[0], "test/w0.js", "deterministic sort before cap");
  // below the cap: no truncation flag.
  const small = scope([startedEvent(), writtenEvent("test/a.js"), writtenEvent("test/b.js")]);
  assert.equal(small.outsidePathsTruncated, false);
  assert.deepEqual(small.outsidePaths, ["test/a.js", "test/b.js"]);
});

test("path bound: an over-long outside path is bounded after redaction, never crosses unbounded", () => {
  const long = `test/${"x".repeat(300)}.js`;
  const r = scope([startedEvent(), writtenEvent(long)]);
  assert.equal(r.status, "outside_declared_paths");
  assert.equal(r.outsidePathCount, 1);
  assert.ok(r.outsidePaths[0].length <= SCOPE_OBSERVATION_PATH_CAP, "path bounded by the shared per-path cap");
});

// =====================================================================
// secret redaction (actual paths drive the decision; output is redacted)
// =====================================================================
test("secret redaction: status decided on ACTUAL paths; output paths redacted before crossing", () => {
  const env = { SCOPE_TOKEN: "TKN9SECRET9" };
  const r = scope([startedEvent(), writtenEvent("test/TKN9SECRET9/x.js")], { env });
  assert.equal(r.status, "outside_declared_paths", "decision on the actual path");
  assert.equal(r.outsidePathCount, 1);
  assert.ok(r.outsidePaths[0].includes("[REDACTED"), "output path redacted");
  assert.ok(!JSON.stringify(r).includes("TKN9SECRET9"), "raw secret never crosses");
  const within = scope([startedEvent(), writtenEvent("src/TKN9SECRET9/x.js")], { env });
  assert.equal(within.status, "within_declared_paths", "decision on the actual path (allowed)");
  assert.ok(!JSON.stringify(within).includes("TKN9SECRET9"));
});

test("secret-redaction collisions preserve one safe list entry per distinct outside fact", () => {
  const env = { SCOPE_TOKEN: "TKN9SECRET9" };
  const r = scope([
    startedEvent(),
    writtenEvent("test/TKN9SECRET9/a.js"),
    writtenEvent("test/[REDACTED:SCOPE_TOKEN]/a.js"),
  ], { env });
  assert.equal(r.status, "outside_declared_paths");
  assert.equal(r.outsidePathCount, 2);
  assert.equal(r.outsidePaths.length, 2,
    "redaction must not silently collapse two distinct observed paths into one list item");
  assert.equal(r.outsidePathsTruncated, false);
  assert.ok(!JSON.stringify(r).includes("TKN9SECRET9"));
});

// =====================================================================
// never throws on garbage input; absent scope facts never break readability
// =====================================================================
test("garbage input collapses to unknown — never throws", () => {
  for (const input of [null, undefined, "nope", {}, { events: "x" }, [42]]) {
    const r = projectScopeObservation(input, { runId: RUN_ID });
    assert.equal(r.status, "unknown", `input ${JSON.stringify(input)} -> unknown`);
    assert.equal(r.complete, false);
  }
  const noRunId = projectScopeObservation([startedEvent()], { runId: 42 });
  assert.equal(noRunId.status, "unknown");
});

// =====================================================================
// frozen cursor stability through projectRunActivity (M12-14 contract #5)
// =====================================================================
test("frozen cursor stability: continuation projects the page-1 frozen prefix; fresh page-1 sees the append", () => {
  const base = [
    startedEvent(),
    ...Array.from({ length: 15 }, (_, i) => messageEvent(`m${i}`)),
    writtenEvent("src/a.js"),
  ];
  const page1 = projectRunActivity(projSnap(base), { runId: RUN_ID, audience: "lead", pageSize: 8 });
  assert.ok(page1.nextCursor, "page 1 has a cursor");
  assert.equal(page1.scopeObservation.status, "within_declared_paths");
  assert.equal(page1.scopeObservation.complete, false);

  // Append a later OUTSIDE file write.
  const grown = [...base, writtenEvent("test/bad.js")];
  const page2 = projectRunActivity(projSnap(grown), {
    runId: RUN_ID, audience: "lead", cursor: page1.nextCursor, pageSize: 8,
  });
  assert.equal(page2.scopeObservation.status, "within_declared_paths",
    "a continuation cursor cannot be altered by an appended outside write");
  assert.equal(page2.scopeObservation.observedFileCount, 1, "frozen prefix observation");

  // A FRESH page-1 call observes the appended outside write.
  const fresh = projectRunActivity(projSnap(grown), { runId: RUN_ID, audience: "lead", pageSize: 8 });
  assert.equal(fresh.scopeObservation.status, "outside_declared_paths");
  assert.equal(fresh.scopeObservation.observedFileCount, 2);
  assert.deepEqual(fresh.scopeObservation.outsidePaths, ["test/bad.js"]);
});

test("frozen cursor stability on a terminal snapshot: complete stays true across continuation", () => {
  const baseT = [
    startedEvent(),
    ...Array.from({ length: 15 }, (_, i) => messageEvent(`m${i}`)),
    writtenEvent("src/a.js"),
    stateEvent("completed"),
  ];
  const pageT1 = projectRunActivity(projSnap(baseT, true), { runId: RUN_ID, audience: "lead", pageSize: 8 });
  assert.ok(pageT1.nextCursor, "terminal page 1 has a cursor");
  assert.equal(pageT1.scopeObservation.status, "within_declared_paths");
  assert.equal(pageT1.scopeObservation.complete, true);

  const grownT = [...baseT, writtenEvent("test/bad.js")];
  const pageT2 = projectRunActivity(projSnap(grownT, true), {
    runId: RUN_ID, audience: "lead", cursor: pageT1.nextCursor, pageSize: 8,
  });
  assert.equal(pageT2.scopeObservation.status, "within_declared_paths", "frozen prefix observation");
  assert.equal(pageT2.scopeObservation.complete, true, "terminal frozen prefix keeps complete=true");

  const freshT = projectRunActivity(projSnap(grownT, true), { runId: RUN_ID, audience: "lead", pageSize: 8 });
  assert.equal(freshT.scopeObservation.status, "outside_declared_paths");
  assert.equal(freshT.scopeObservation.complete, true);
});

test("non-delivery snapshot through projectRunActivity: readable as unknown, zero throw, entries intact", () => {
  const events = [startedEvent({ delivery: undefined }), messageEvent("hello"), writtenEvent("src/a.js")];
  const r = projectRunActivity(projSnap(events), { runId: RUN_ID, audience: "lead" });
  assert.equal(r.scopeObservation.status, "unknown");
  assert.equal(r.scopeObservation.complete, false);
  assert.equal(r.scopeObservation.source, SCOPE_OBSERVATION_SOURCE);
  assert.equal(r.entries.length, 2, "activity entries still project normally");
});
