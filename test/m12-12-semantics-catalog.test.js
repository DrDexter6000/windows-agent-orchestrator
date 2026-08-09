// test/m12-12-semantics-catalog.test.js
//
// M12-12 split — PURE SELECTOR/CATALOG slice (manifest category: pure).
//
// This file was split out of test/m12-12-semantics.test.js at its existing
// section boundaries so the canonical wave's per-file process lifetime stays
// inside the SDK request budget under cross-file load. Every assertion is
// preserved verbatim; no test was added, removed, or relaxed.
//
// This slice carries:
//   S-*   PURE selectors: exact three-key shape {id, meaning, doesNotMean};
//         closed-set ids; no dynamic echo; UTF-8 byte cap; max count; unique ids;
//         unknown tool throws; unknown facts degrade deterministically; the
//         selector matrix; read_failure EXCLUDES any termination note; no note
//         is a prescription.
//
// The MCP-handler / resource / cross-field / smoke slices (M, R, X, SM) live in
// m12-12-semantics-mcp.test.js. This file is pure function calls against
// src/application/runSemanticsNotes.js — no I/O, no MCP. Runs in the pure wave.

import { test } from "node:test";
import assert from "node:assert/strict";

// =====================================================================
// S-* — PURE application SSOT (src/application/runSemanticsNotes.js).
// =====================================================================

test("S-01: module exports frozen caps + frozen closed sets", async () => {
  const m = await import("../src/application/runSemanticsNotes.js");
  assert.equal(m.SEMANTIC_NOTE_MAX_ENTRIES, 4);
  assert.equal(m.SEMANTIC_NOTE_SERIALIZED_MAX_BYTES, 2048);
  assert.ok(Number.isInteger(m.SEMANTIC_NOTE_FIELD_MAX_LEN) && m.SEMANTIC_NOTE_FIELD_MAX_LEN >= 120);
  assert.equal(m.SEMANTIC_NOTE_MAX_DOES_NOT_MEAN, 2);
  assert.equal(m.SEMANTIC_DETAIL_URI_PREFIX, "wao://semantics/");
  assert.ok(Object.isFrozen(m.SEMANTIC_NOTE_IDS), "SEMANTIC_NOTE_IDS frozen");
  assert.ok(Object.isFrozen(m.SEMANTIC_SOURCE_TOOLS), "SEMANTIC_SOURCE_TOOLS frozen");
  assert.deepEqual([...m.SEMANTIC_SOURCE_TOOLS].sort(), ["run_await_result", "run_delivery", "run_diagnose", "run_wait"]);
  // Exactly the four contracted namespaces, each non-empty.
  const ns = (p) => m.SEMANTIC_NOTE_IDS.filter((id) => id.startsWith(p + "."));
  for (const p of ["observation", "termination", "delivery", "diagnosis"]) {
    assert.ok(ns(p).length > 0, `namespace ${p} non-empty`);
  }
});

test("S-02: every catalog note has the EXACT three-key shape {id, meaning, doesNotMean}", async () => {
  const { SEMANTIC_NOTE_IDS, getSemanticNoteById } = await import("../src/application/runSemanticsNotes.js");
  for (const id of SEMANTIC_NOTE_IDS) {
    const e = getSemanticNoteById(id);
    assert.ok(e, `${id} resolves`);
    assert.deepEqual(Object.keys(e).sort(), ["doesNotMean", "id", "meaning"], `${id} exact three keys`);
    assert.equal(e.id, id, `${id} id matches key`);
    assert.equal(typeof e.meaning, "string");
    assert.ok(e.meaning.length > 0);
    assert.ok(Array.isArray(e.doesNotMean), `${id} doesNotMean is array`);
    assert.ok(e.doesNotMean.length >= 0 && e.doesNotMean.length <= 2, `${id} doesNotMean 0..2`);
    // No `scope` field and no per-entry semanticsRef.
    assert.equal(e.scope, undefined, `${id} has no scope`);
    assert.equal(e.semanticsRef, undefined, `${id} has no semanticsRef`);
  }
});

test("S-03: selectSemanticNotes always returns validated 1..4 entries with unique catalog ids", async () => {
  const { selectSemanticNotes, SEMANTIC_NOTE_IDS, SEMANTIC_SOURCE_TOOLS } = await import("../src/application/runSemanticsNotes.js");
  const idSet = new Set(SEMANTIC_NOTE_IDS);
  // Representative fact matrix across all four tools.
  const matrix = [
    ["run_wait", { outcome: "point_in_time" }],
    ["run_wait", { outcome: "window_expired" }],
    ["run_wait", { outcome: "terminal", terminationSource: "completion" }],
    ["run_wait", { outcome: "read_failure" }],
    ["run_await_result", { outcome: "point_in_time" }],
    ["run_await_result", { outcome: "terminal", terminationSource: "execution_deadline" }],
    ["run_await_result", { outcome: "terminal", terminationSource: "backend", diagnosisCategory: "crash", deliveryRequested: false }],
    ["run_await_result", { outcome: "terminal", terminationSource: "completion", deliveryRequested: true, deliveryReadiness: "reviewable" }],
    ["run_await_result", { outcome: "read_failure" }],
    ["run_delivery", { deliveryAvailable: true, deliveryRequested: true, verificationStatus: "passed" }],
    ["run_delivery", { deliveryAvailable: false, deliveryRequested: true, deliveryFailureCode: "commit_failed" }],
    ["run_delivery", { deliveryAvailable: false, deliveryRequested: false }],
    ["run_diagnose", { category: "provider_auth" }],
    ["run_diagnose", { category: "none" }],
  ];
  for (const [tool, facts] of matrix) {
    assert.ok(SEMANTIC_SOURCE_TOOLS.includes(tool), `${tool} is a source tool`);
    const notes = selectSemanticNotes(tool, facts);
    assert.ok(Array.isArray(notes) && notes.length >= 1 && notes.length <= 4, `${tool} ${JSON.stringify(facts)} → 1..4 notes`);
    const ids = new Set();
    for (const n of notes) {
      assert.ok(idSet.has(n.id), `${tool} id ${n.id} in catalog`);
      assert.deepEqual(Object.keys(n).sort(), ["doesNotMean", "id", "meaning"]);
      assert.ok(!ids.has(n.id), `${tool} no duplicate id ${n.id}`);
      ids.add(n.id);
    }
  }
});

test("S-04: NO dynamic echo — every returned string is byte-equal to the static catalog", async () => {
  const { selectSemanticNotes, getSemanticNoteById, SEMANTIC_NOTE_IDS } = await import("../src/application/runSemanticsNotes.js");
  // Hostile fact values that must NEVER appear in any note string.
  const POISONS = ["C:\\secret\\path", "ran --rm evil", "sk-live-KEY", "sess_abc", "claude-code-3.7"];
  const cases = [
    ["run_wait", { outcome: "terminal", terminationSource: "completion" }],
    ["run_await_result", { outcome: "terminal", terminationSource: "provider", diagnosisCategory: "provider_auth" }],
    ["run_delivery", { deliveryAvailable: true, deliveryRequested: true, verificationStatus: "passed" }],
    ["run_diagnose", { category: "crash" }],
  ];
  for (const [tool, facts] of cases) {
    const notes = selectSemanticNotes(tool, facts);
    const blob = JSON.stringify(notes);
    for (const p of POISONS) assert.ok(!blob.includes(p), `${tool}: poison ${p} must not echo`);
    // Every note is byte-equal to its catalog entry (no runtime-generated text).
    for (const n of notes) {
      assert.deepEqual(n, getSemanticNoteById(n.id), `${tool} ${n.id} byte-equal to catalog`);
    }
  }
  // The full catalog text contains none of the poison tokens either.
  for (const id of SEMANTIC_NOTE_IDS) {
    const e = getSemanticNoteById(id);
    const blob = JSON.stringify(e);
    for (const p of POISONS) assert.ok(!blob.includes(p), `catalog ${id}: no poison ${p}`);
  }
});

test("S-05: max-count cap — enforceSemanticNoteBounds throws on > SEMANTIC_NOTE_MAX_ENTRIES", async () => {
  const { enforceSemanticNoteBounds, SEMANTIC_NOTE_MAX_ENTRIES, SEMANTIC_NOTE_IDS } = await import("../src/application/runSemanticsNotes.js");
  const mk = (n) => Array.from({ length: n }, (_, i) => ({
    id: SEMANTIC_NOTE_IDS[i], meaning: "m", doesNotMean: [],
  }));
  assert.ok(enforceSemanticNoteBounds(mk(SEMANTIC_NOTE_MAX_ENTRIES)).length === SEMANTIC_NOTE_MAX_ENTRIES);
  assert.throws(() => enforceSemanticNoteBounds(mk(SEMANTIC_NOTE_MAX_ENTRIES + 1)), /exceed cap/);
});

test("S-05b: zero entries are REJECTED — enforceSemanticNoteBounds([]) fails closed (not just selectors non-empty)", async () => {
  const { enforceSemanticNoteBounds } = await import("../src/application/runSemanticsNotes.js");
  // The application contract is 1..4. A direct empty array must fail closed — this
  // is the enforcement authority, independent of any selector returning non-empty.
  assert.throws(() => enforceSemanticNoteBounds([]), /at least one|min|empty/i,
    "enforceSemanticNoteBounds([]) must throw (zero entries is a contract violation)");
});

test("S-06: UTF-8 byte cap — entries that pass per-field length but exceed serialized bytes throw", async () => {
  const { enforceSemanticNoteBounds, SEMANTIC_NOTE_FIELD_MAX_LEN, SEMANTIC_NOTE_MAX_ENTRIES } = await import("../src/application/runSemanticsNotes.js");
  // "€" is 3 UTF-8 bytes per code unit. FIELD_MAX_LEN code units pass the length
  // check, but four such notes serialize far past the 2048-byte cap.
  const euro = "€".repeat(SEMANTIC_NOTE_FIELD_MAX_LEN); // code units OK; bytes = 3× that
  // Distinct catalog ids so the unique-id check passes and the BYTE cap is the
  // binding failure (each entry alone is under the per-field length cap).
  const probeIds = ["observation.point_in_time", "observation.window_expired", "observation.terminal", "observation.read_failure"];
  const entries = Array.from({ length: SEMANTIC_NOTE_MAX_ENTRIES }, (_, i) => ({
    id: probeIds[i], meaning: euro, doesNotMean: [euro],
  }));
  const bytes = Buffer.byteLength(JSON.stringify(entries), "utf8");
  assert.ok(bytes > 2048, `probe exceeds cap (${bytes} bytes)`);
  assert.throws(() => enforceSemanticNoteBounds(entries), /exceeds cap/);
});

test("S-07: determinism — same facts ⇒ deep-equal results; no duplicate ids", async () => {
  const { selectSemanticNotes } = await import("../src/application/runSemanticsNotes.js");
  for (const [tool, facts] of [
    ["run_wait", { outcome: "terminal", terminationSource: "completion" }],
    ["run_await_result", { outcome: "terminal", terminationSource: "backend", diagnosisCategory: "crash", deliveryRequested: true, deliveryReadiness: "reviewable" }],
  ]) {
    const a = selectSemanticNotes(tool, facts);
    const b = selectSemanticNotes(tool, facts);
    assert.deepEqual(a, b, `${tool} deterministic`);
    assert.equal(new Set(a.map((n) => n.id)).size, a.length, `${tool} unique ids`);
  }
});

test("S-08: unknown tool throws; unknown/future fact values degrade deterministically (never throw, never echo)", async () => {
  const { selectSemanticNotes } = await import("../src/application/runSemanticsNotes.js");
  assert.throws(() => selectSemanticNotes("run_status", {}), /unknown tool/);
  assert.throws(() => selectSemanticNotes("not_a_tool", {}), /unknown tool/);
  // A future/unknown termination source → safe fallback termination.unknown.
  const a = selectSemanticNotes("run_wait", { outcome: "terminal", terminationSource: "future_source_xyz" });
  assert.ok(a.some((n) => n.id === "termination.unknown"), "unknown source → termination.unknown fallback");
  for (const n of a) assert.ok(!JSON.stringify(n).includes("future_source_xyz"), "fallback never echoes the unknown value");
  // A future/unknown diagnosis category → safe fallback diagnosis.unknown.
  const b = selectSemanticNotes("run_diagnose", { category: "future_category_xyz" });
  assert.deepEqual(b.map((n) => n.id), ["diagnosis.unknown"], "unknown category → diagnosis.unknown");
  // An unknown/future observation outcome on run_wait → safe observation.unknown
  // (NOT observation.point_in_time, which would falsely claim no window elapsed).
  const c = selectSemanticNotes("run_wait", { outcome: "future_outcome_xyz" });
  assert.deepEqual(c.map((n) => n.id), ["observation.unknown"], "unknown outcome → observation.unknown fallback");
  for (const n of c) assert.ok(!JSON.stringify(n).includes("future_outcome_xyz"), "fallback never echoes the unknown value");
  // A MISSING observation outcome on run_wait → observation.unknown too (never throw).
  const cMissing = selectSemanticNotes("run_wait", {});
  assert.deepEqual(cMissing.map((n) => n.id), ["observation.unknown"], "missing outcome → observation.unknown");
  // Same closed-set fallback on run_await_result for an unknown outcome (non-terminal).
  const cAwait = selectSemanticNotes("run_await_result", { outcome: "future_outcome_xyz" });
  assert.deepEqual(cAwait.map((n) => n.id), ["observation.unknown"], "run_await_result unknown outcome → observation.unknown");
  // Missing facts entirely → still a valid 1..4 list, never throws.
  for (const tool of ["run_wait", "run_await_result", "run_delivery", "run_diagnose"]) {
    const n = selectSemanticNotes(tool, {});
    assert.ok(n.length >= 1 && n.length <= 4, `${tool} with no facts still yields bounded notes`);
  }
});

test("S-09: selector matrix — representative facts map to the expected ids", async () => {
  const { selectSemanticNotes } = await import("../src/application/runSemanticsNotes.js");
  const ids = (tool, facts) => selectSemanticNotes(tool, facts).map((n) => n.id);

  // run_wait
  assert.deepEqual(ids("run_wait", { outcome: "read_failure" }), ["observation.read_failure"]);
  assert.deepEqual(ids("run_wait", { outcome: "window_expired" }), ["observation.window_expired"]);
  assert.deepEqual(ids("run_wait", { outcome: "point_in_time" }), ["observation.point_in_time"]);
  // Finding 3: an unknown/future observation outcome → observation.unknown (never point_in_time).
  assert.deepEqual(ids("run_wait", { outcome: "future_outcome_xyz" }), ["observation.unknown"]);
  assert.deepEqual(ids("run_wait", { outcome: "terminal", terminationSource: "completion" }),
    ["observation.terminal", "termination.completion"]);
  assert.deepEqual(ids("run_wait", { outcome: "terminal", terminationSource: "execution_deadline" }),
    ["observation.terminal", "termination.execution_deadline"]);

  // run_await_result: terminal success, no delivery, no failure → obs+termination only
  assert.deepEqual(ids("run_await_result", { outcome: "terminal", terminationSource: "completion", deliveryRequested: false }),
    ["observation.terminal", "termination.completion"]);
  // terminal failure with a real diagnosis category → + diagnosis note
  const failed = ids("run_await_result", { outcome: "terminal", terminationSource: "provider", diagnosisCategory: "provider_auth", deliveryRequested: false });
  assert.deepEqual(failed, ["observation.terminal", "termination.provider", "diagnosis.provider_auth"]);
  // terminal failure with a real diagnosis AND a reviewable delivery → 4 notes (the cap)
  const full = ids("run_await_result", { outcome: "terminal", terminationSource: "control_plane", diagnosisCategory: "scorecard_fail", deliveryRequested: true, deliveryReadiness: "reviewable" });
  assert.deepEqual(full, ["observation.terminal", "termination.control_plane", "diagnosis.scorecard_fail", "delivery.reviewable"]);
  assert.equal(full.length, 4, "terminal failure + delivery can reach the 4-entry cap");

  // run_delivery (wait-path readiness drives the note)
  assert.deepEqual(ids("run_delivery", { readiness: "reviewable", deliveryRequested: true }), ["delivery.reviewable"]);
  assert.deepEqual(ids("run_delivery", { readiness: "packaging_failed", deliveryRequested: true }), ["delivery.packaging_failed"]);
  // M12-13: terminal isolation escape → its OWN note, NEVER delivery.waiting / packaging_failed.
  assert.deepEqual(ids("run_delivery", { readiness: "isolation_failed", deliveryRequested: true }), ["delivery.isolation_failed"]);
  assert.deepEqual(ids("run_await_result", { outcome: "terminal", terminationSource: "control_plane", deliveryRequested: true, deliveryReadiness: "isolation_failed" }),
    ["observation.terminal", "termination.control_plane", "delivery.isolation_failed"]);
  assert.deepEqual(ids("run_delivery", { readiness: "not_requested", deliveryRequested: false }), ["delivery.not_requested"]);
  assert.deepEqual(ids("run_delivery", { readiness: "ambiguous", deliveryRequested: true }), ["delivery.ambiguous"]);
  assert.deepEqual(ids("run_delivery", { readiness: "waiting_for_verification", deliveryRequested: true }), ["delivery.waiting"]);
  // run_delivery (point-in-time path: no readiness → verification drives it)
  assert.deepEqual(ids("run_delivery", { deliveryAvailable: true, deliveryRequested: true, verificationStatus: "passed" }), ["delivery.verification_passed"]);
  assert.deepEqual(ids("run_delivery", { deliveryAvailable: true, deliveryRequested: true, verificationStatus: "failed" }), ["delivery.verification_failed"]);
  assert.deepEqual(ids("run_delivery", { deliveryAvailable: false, deliveryRequested: false }), ["delivery.not_requested"]);
  // Finding 2: requested but NOT yet settled (packaging/verification in flight) → delivery.waiting,
  // NOT delivery.not_requested. deliveryAvailable:false + requested:true + null verification/failure.
  assert.deepEqual(ids("run_delivery", { deliveryAvailable: false, deliveryRequested: true, verificationStatus: null, deliveryFailureCode: null }), ["delivery.waiting"]);
  assert.deepEqual(ids("run_delivery", { deliveryAvailable: false, deliveryRequested: true }), ["delivery.waiting"]);

  // run_diagnose — one note per current closed-set category
  for (const cat of ["provider_auth", "config_conflict", "timeout", "budget", "scorecard_fail",
    "evidence_passed_backend_failed", "provider_disconnect", "no_effect", "crash", "aborted_manual",
    "workdir_escape", "delivery_packaging_failed", "unknown", "none"]) {
    assert.deepEqual(ids("run_diagnose", { category: cat }), [`diagnosis.${cat}`], `diagnosis category ${cat}`);
  }
});

test("S-10: read_failure EXCLUDES any termination note (run_wait + run_await_result)", async () => {
  const { selectSemanticNotes } = await import("../src/application/runSemanticsNotes.js");
  for (const tool of ["run_wait", "run_await_result"]) {
    const notes = selectSemanticNotes(tool, { outcome: "read_failure", terminationSource: "completion", diagnosisCategory: "crash" });
    const ids = notes.map((n) => n.id);
    assert.ok(ids.includes("observation.read_failure"), `${tool} carries observation.read_failure`);
    assert.ok(!ids.some((id) => id.startsWith("termination.")), `${tool} read_failure MUST NOT carry a termination note`);
  }
});

test("S-11: no note is a prescription — meanings never recommend; doesNotMean are non-implications", async () => {
  const { SEMANTIC_NOTE_IDS, getSemanticNoteById } = await import("../src/application/runSemanticsNotes.js");
  const PRESCRIPTION = /\b(accept|reject|repackage|re-package|retry|dispatch)\b/i;
  for (const id of SEMANTIC_NOTE_IDS) {
    const e = getSemanticNoteById(id);
    // A meaning states a fact; it must not contain a recommendation imperative.
    assert.ok(!PRESCRIPTION.test(e.meaning), `${id} meaning must not prescribe: "${e.meaning}"`);
    // Every doesNotMean is a non-implication (negated).
    for (const d of e.doesNotMean) {
      assert.ok(/\b(no|not|never|without)\b/i.test(d), `${id} doesNotMean must be a negation: "${d}"`);
    }
  }
  // Delivery notes that mention verification-passed must explicitly state it is NOT Lead acceptance.
  const rev = getSemanticNoteById("delivery.reviewable");
  const passed = getSemanticNoteById("delivery.verification_passed");
  for (const e of [rev, passed]) {
    const blob = (e.meaning + " " + e.doesNotMean.join(" ")).toLowerCase();
    assert.ok(/not.*accept|acceptance is not/.test(blob) || blob.includes("not lead acceptance"),
      `${e.id} must state verification passed is NOT Lead acceptance`);
  }
});

test("S-12: detailUriForId is mechanical wao://semantics/{id}", async () => {
  const { detailUriForId, SEMANTIC_NOTE_IDS } = await import("../src/application/runSemanticsNotes.js");
  for (const id of SEMANTIC_NOTE_IDS) {
    assert.equal(detailUriForId(id), `wao://semantics/${id}`);
  }
});

test("S-13: M12-13 point-in-time isolationFailure (no readiness) → delivery.isolation_failed, same as readiness path", async () => {
  const { selectSemanticNotes, getSemanticNoteById } = await import("../src/application/runSemanticsNotes.js");
  const ids = (tool, facts) => selectSemanticNotes(tool, facts).map((n) => n.id);
  // Point-in-time path: NO readiness label, but the payload carries the already
  // safe-projected isolation-escape code. It must project the SAME note as the
  // authoritative readiness:"isolation_failed" path: delivery.isolation_failed
  // (NEVER delivery.waiting / delivery.packaging_failed).
  const pointInTime = {
    deliveryAvailable: false, deliveryRequested: true, verificationStatus: null,
    readiness: null, deliveryFailureCode: null, isolationFailureCode: "workdir_escape",
  };
  const viaReadiness = {
    deliveryAvailable: false, deliveryRequested: true, verificationStatus: null,
    readiness: "isolation_failed", deliveryFailureCode: null,
  };
  assert.deepEqual(ids("run_delivery", pointInTime), ["delivery.isolation_failed"],
    "point-in-time isolationFailure → delivery.isolation_failed (NOT delivery.waiting)");
  assert.deepEqual(ids("run_delivery", pointInTime), ids("run_delivery", viaReadiness),
    "point-in-time code path == readiness:isolation_failed path");
  // Byte-equal to the catalog entry — proves no dynamic echo of any payload
  // value (the note IS the frozen catalog text). The catalog's own meaning
  // mentions the closed-set word "workdir_escape"; that is static, not an echo
  // of the payload, so we assert byte-equality rather than substring absence.
  const notes = selectSemanticNotes("run_delivery", pointInTime);
  assert.deepEqual(notes[0], getSemanticNoteById("delivery.isolation_failed"),
    "isolation_failed note is byte-equal to the catalog entry");
});

test("S-13b: M12-13 malformed/unknown/missing isolationFailureCode does NOT promote to delivery.isolation_failed", async () => {
  const { selectSemanticNotes } = await import("../src/application/runSemanticsNotes.js");
  const ids = (tool, facts) => selectSemanticNotes(tool, facts).map((n) => n.id);
  const base = {
    deliveryAvailable: false, deliveryRequested: true, verificationStatus: null,
    readiness: null, deliveryFailureCode: null,
  };
  // Missing / null / unknown code → the existing point-in-time waiting note,
  // NOT isolation_failed. The code must never be promoted or echoed.
  assert.deepEqual(ids("run_delivery", base), ["delivery.waiting"], "missing code → delivery.waiting");
  assert.deepEqual(ids("run_delivery", { ...base, isolationFailureCode: null }),
    ["delivery.waiting"], "null code → delivery.waiting");
  assert.deepEqual(ids("run_delivery", { ...base, isolationFailureCode: "other" }),
    ["delivery.waiting"], "unknown code → delivery.waiting");
  // Readiness stays authoritative when present, even with the code also set: a
  // reviewable readiness projects delivery.reviewable, NOT isolation_failed.
  assert.deepEqual(ids("run_delivery", {
    deliveryAvailable: true, deliveryRequested: true, verificationStatus: "passed",
    readiness: "reviewable", deliveryFailureCode: null, isolationFailureCode: "workdir_escape",
  }), ["delivery.reviewable"],
    "readiness authoritative when present, even with isolationFailureCode set");
});
