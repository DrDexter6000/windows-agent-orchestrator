// test/runDrilldowns.test.js
//
// M12-8B: bounded Lead progressive-disclosure metadata — application-layer
// TDD RED→GREEN (pure unit tests; no MCP SDK, no filesystem, no transcript).
//
// The module src/application/runDrilldowns.js is the single shared owner of
// the closed-set drilldown catalog, the per-tool fact-driven selection rules,
// and the hard bounds (max entries + serialized-size cap). It MUST:
//   - return entries with the EXACT seven-key shape
//     { tool, view, detail, purpose, reveals, cost, readOnly };
//   - keep every field a small closed/static string chosen by WAO code
//     (never transcript/provider/repository text);
//   - cap results at DRILLDOWN_MAX_ENTRIES with one hard serialized-size cap
//     enforced by the application helper;
//   - be deterministic and deduplicated for identical facts;
//   - set readOnly TRUTHFULLY per advertised tool (false for run_collect's
//     audit-appending entries, true for the genuinely read-only ones);
//   - never advertise destructive or mutating tools;
//   - select entries from ALREADY-AVAILABLE machine facts only — no semantic
//     inference, no prescription, no file choice, no cursor traversal.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  selectDrilldowns,
  validateDrilldownEntry,
  enforceDrilldownBounds,
  DRILLDOWN_MAX_ENTRIES,
  DRILLDOWN_SERIALIZED_MAX_BYTES,
  DRILLDOWN_FIELD_MAX_LEN,
  DRILLDOWN_VIEWS,
  DRILLDOWN_COSTS,
  DRILLDOWN_TOOLS,
} from "../src/application/runDrilldowns.js";

const SEVEN_KEYS = ["tool", "view", "detail", "purpose", "reveals", "cost", "readOnly"].sort();

// The closed set of control tools that mutate run/worker/delivery/session
// state or Git — NONE of these may ever appear in a drilldown. Advertised
// tools are observation tools only; readOnly is truthful per tool (run_collect
// entries are readOnly:false because each call appends one audit record).
const MUTATION_TOOLS = [
  "run_dispatch", "run_stop", "run_continue", "run_delivery_decide",
  "run_delivery_repackage", "run_delivery_reverify", "workspace_select",
];

// A representative facts matrix per source tool — every (tool, facts) pair
// below must produce a valid bounded drilldown list. Covers all six source
// tools and the required representative states: terminal, non-terminal,
// failure, read-failure, delivery-reviewable, delivery-failed.
const FACT_MATRIX = [
  // run_status
  ["run_status", { state: "running", terminal: false }],
  ["run_status", { state: "completed", terminal: true }],
  ["run_status", { state: "failed", terminal: true }],
  ["run_status", { state: "aborted", terminal: true }],
  ["run_status", { state: "timed_out", terminal: true }],
  ["run_status", { state: "stopped", terminal: true }],
  ["run_status", { state: "weird_state", terminal: true }],
  // run_wait
  ["run_wait", { state: "running", terminal: false, liveness: "progress" }],
  ["run_wait", { state: "completed", terminal: true, liveness: "terminal" }],
  ["run_wait", { state: "failed", terminal: true, liveness: "terminal" }],
  // run_await_result
  ["run_await_result", { state: "running", terminal: false, observationOutcome: "observed", readFailureReason: null, liveness: "progress", resultStatus: "not_terminal" }],
  ["run_await_result", { state: "running", terminal: false, observationOutcome: "observed", readFailureReason: null, liveness: "silent", resultStatus: "not_terminal" }],
  ["run_await_result", { state: "completed", terminal: true, observationOutcome: "observed", readFailureReason: null, liveness: "terminal", resultStatus: "available" }],
  ["run_await_result", { state: "completed", terminal: true, observationOutcome: "observed", readFailureReason: null, liveness: "terminal", resultStatus: "empty" }],
  ["run_await_result", { state: "completed", terminal: true, observationOutcome: "observed", readFailureReason: null, liveness: "terminal", resultStatus: "too_large" }],
  ["run_await_result", { state: "running", terminal: false, observationOutcome: "read_failure", readFailureReason: "transcript_parse_failed", liveness: "unknown", resultStatus: "unavailable" }],
  ["run_await_result", { state: "running", terminal: false, observationOutcome: "read_failure", readFailureReason: "legacy_event_shape", liveness: "unknown", resultStatus: "unavailable" }],
  ["run_await_result", { state: "running", terminal: false, observationOutcome: "read_failure", readFailureReason: "snapshot_unavailable", liveness: "unknown", resultStatus: "unavailable" }],
  ["run_await_result", { state: "failed", terminal: true, observationOutcome: "observed", readFailureReason: null, liveness: "terminal", resultStatus: "unavailable" }],
  ["run_await_result", { state: "failed", terminal: true, observationOutcome: "terminal", readFailureReason: null, liveness: "terminal", outcomeReadiness: "isolation_failed", outcomeVerificationStatus: null, resultStatus: null }],
  // run_diagnose
  ["run_diagnose", { state: "failed", terminal: true, category: "delivery_packaging_failed" }],
  ["run_diagnose", { state: "failed", terminal: true, category: "provider_auth" }],
  ["run_diagnose", { state: "failed", terminal: true, category: "timeout" }],
  ["run_diagnose", { state: "failed", terminal: true, category: "workdir_escape" }],
  ["run_diagnose", { state: "failed", terminal: true, category: "unknown" }],
  ["run_diagnose", { state: "failed", terminal: true, category: "none" }],
  // run_collect
  ["run_collect", { view: "full", nextCursor: null }],
  ["run_collect", { view: "full", nextCursor: "abc" }],
  ["run_collect", { view: "compact", compactStatus: "available" }],
  ["run_collect", { view: "compact", compactStatus: "too_large" }],
  ["run_collect", { view: "compact", compactStatus: "empty" }],
  // run_delivery
  ["run_delivery", { deliveryAvailable: true, deliveryRequested: true, terminalState: "completed", verificationStatus: "passed", acceptanceStatus: "pending", readiness: null, deliveryFailureCode: null }],
  ["run_delivery", { deliveryAvailable: true, deliveryRequested: true, terminalState: "completed", verificationStatus: "failed", acceptanceStatus: "pending", readiness: null, deliveryFailureCode: null }],
  ["run_delivery", { deliveryAvailable: true, deliveryRequested: true, terminalState: "completed", verificationStatus: "passed", acceptanceStatus: "accepted", readiness: null, deliveryFailureCode: null }],
  ["run_delivery", { deliveryAvailable: true, deliveryRequested: true, terminalState: "completed", verificationStatus: "passed", acceptanceStatus: "rejected", readiness: null, deliveryFailureCode: null }],
  ["run_delivery", { deliveryAvailable: false, deliveryRequested: true, terminalState: "failed", verificationStatus: null, acceptanceStatus: null, readiness: null, deliveryFailureCode: "commit_failed" }],
  ["run_delivery", { deliveryAvailable: false, deliveryRequested: true, terminalState: "failed", verificationStatus: null, acceptanceStatus: null, readiness: null, deliveryFailureCode: "disallowed_path" }],
  ["run_delivery", { deliveryAvailable: false, deliveryRequested: false, terminalState: "running", verificationStatus: null, acceptanceStatus: null, readiness: null, deliveryFailureCode: null }],
  ["run_delivery", { deliveryAvailable: false, deliveryRequested: true, terminalState: "running", verificationStatus: null, acceptanceStatus: null, readiness: "waiting_for_packaging", deliveryFailureCode: null }],
  ["run_delivery", { deliveryAvailable: false, deliveryRequested: true, terminalState: "running", verificationStatus: null, acceptanceStatus: null, readiness: "waiting_for_verification", deliveryFailureCode: null }],
  ["run_delivery", { deliveryAvailable: false, deliveryRequested: true, terminalState: "failed", verificationStatus: null, acceptanceStatus: null, readiness: "packaging_failed", deliveryFailureCode: null }],
  ["run_delivery", { deliveryAvailable: false, deliveryRequested: true, terminalState: "failed", verificationStatus: null, acceptanceStatus: null, readiness: "isolation_failed", deliveryFailureCode: null }],
  // M12-13: point-in-time path (no readiness) carrying the already
  // safe-projected isolation-escape code — valid bounded list either way.
  ["run_delivery", { deliveryAvailable: false, deliveryRequested: true, terminalState: "failed", verificationStatus: null, acceptanceStatus: null, readiness: null, deliveryFailureCode: null, isolationFailureCode: "workdir_escape" }],
  ["run_delivery", { deliveryAvailable: false, deliveryRequested: false, terminalState: "completed", verificationStatus: null, acceptanceStatus: null, readiness: "not_requested", deliveryFailureCode: null }],
  ["run_delivery", { deliveryAvailable: false, deliveryRequested: null, terminalState: "running", verificationStatus: null, acceptanceStatus: null, readiness: "ambiguous", deliveryFailureCode: null }],
  ["run_delivery", { deliveryAvailable: true, deliveryRequested: true, terminalState: "completed", verificationStatus: "passed", acceptanceStatus: "pending", readiness: "reviewable", deliveryFailureCode: null }],
  // run_activity
  ["run_activity", { terminal: false, nextCursor: null }],
  ["run_activity", { terminal: true, nextCursor: null }],
  ["run_activity", { terminal: false, nextCursor: "tok" }],
  ["run_activity", { terminal: true, nextCursor: "tok" }],
];

test("U-01: every selected entry has the EXACT seven-key shape, in the exact schema", () => {
  for (const [tool, facts] of FACT_MATRIX) {
    const entries = selectDrilldowns(tool, facts);
    assert.ok(entries.length >= 1, `${tool} must always yield at least one drilldown`);
    for (const e of entries) {
      assert.deepEqual(Object.keys(e).sort(), SEVEN_KEYS, `${tool} entry must have exactly seven keys`);
      assert.equal(validateDrilldownEntry(e), true, `${tool} entry passes validateDrilldownEntry`);
    }
  }
});

test("U-02: at most 4 entries per result (hard bound), enforced by the application helper", () => {
  for (const [tool, facts] of FACT_MATRIX) {
    const entries = selectDrilldowns(tool, facts);
    assert.ok(entries.length <= DRILLDOWN_MAX_ENTRIES,
      `${tool} returned ${entries.length} entries > ${DRILLDOWN_MAX_ENTRIES}`);
    // The helper must be the enforcement point (throws on violation).
    assert.throws(() => enforceDrilldownBounds(
      Array.from({ length: DRILLDOWN_MAX_ENTRIES + 1 }, () => entries[0]),
    ), /exceed/, "enforceDrilldownBounds rejects > max entries");
  }
});

test("U-03: deterministic ordering + no duplicates for identical facts", () => {
  for (const [tool, facts] of FACT_MATRIX) {
    const first = selectDrilldowns(tool, facts);
    const second = selectDrilldowns(tool, facts);
    assert.deepEqual(second, first, `${tool} must be deterministic for identical facts`);
    // No duplicate entries within one result (same tool+view+detail).
    const keys = first.map((e) => `${e.tool}|${e.view}|${e.detail}`);
    assert.equal(new Set(keys).size, keys.length, `${tool} must not contain duplicate entries`);
    // Repeated selection is stable (identical facts → byte-identical list).
    assert.equal(JSON.stringify(selectDrilldowns(tool, facts)), JSON.stringify(first),
      `${tool} repeated selection is stable`);
  }
});

test("U-04: static/bounded strings + hard serialized-size cap", () => {
  for (const [tool, facts] of FACT_MATRIX) {
    const entries = selectDrilldowns(tool, facts);
    // Hard serialized cap enforced by the application helper.
    const serialized = JSON.stringify(entries);
    assert.ok(serialized.length <= DRILLDOWN_SERIALIZED_MAX_BYTES,
      `${tool} serialized ${serialized.length} bytes > cap ${DRILLDOWN_SERIALIZED_MAX_BYTES}`);
    for (const e of entries) {
      for (const k of ["detail", "purpose", "reveals"]) {
        assert.equal(typeof e[k], "string", `${tool} ${k} is a string`);
        assert.ok(e[k].length > 0 && e[k].length <= DRILLDOWN_FIELD_MAX_LEN,
          `${tool} ${k} length ${e[k].length} outside (0, ${DRILLDOWN_FIELD_MAX_LEN}]`);
      }
      assert.ok(DRILLDOWN_VIEWS.includes(e.view), `${tool} view ${e.view} ∈ closed views`);
      assert.ok(DRILLDOWN_COSTS.includes(e.cost), `${tool} cost ${e.cost} ∈ closed costs`);
      assert.ok(DRILLDOWN_TOOLS.includes(e.tool), `${tool} tool ${e.tool} ∈ closed drilldown tools`);
    }
  }
  // UTF-8 BYTE cap, not JS code-unit length: two valid entries whose fields
  // are 160 non-ASCII chars each exceed 2048 UTF-8 bytes while their code-unit
  // length stays under the cap. "€" is one code unit but 3 UTF-8 bytes, so
  // this probe discriminates the two measures.
  const euro = "€".repeat(160);
  const a = {
    tool: "run_status", view: "timeline", cost: "low", readOnly: true,
    detail: euro, purpose: euro, reveals: euro,
  };
  const b = { ...a, tool: "run_activity", view: "timeline", cost: "medium" };
  const wide = [a, b];
  const codeUnits = JSON.stringify(wide).length;
  const utf8Bytes = Buffer.byteLength(JSON.stringify(wide), "utf8");
  assert.ok(codeUnits < DRILLDOWN_SERIALIZED_MAX_BYTES,
    `probe must stay under the cap in code units (${codeUnits}) to discriminate UTF-8 bytes`);
  assert.ok(utf8Bytes > DRILLDOWN_SERIALIZED_MAX_BYTES,
    `probe must exceed the cap in UTF-8 bytes (${utf8Bytes})`);
  assert.throws(() => enforceDrilldownBounds(wide), /bytes/,
    "serialized cap enforced in UTF-8 bytes, not JS string length");
});

test("U-05: readOnly is the truthful boolean per advertised tool (never a destructive/mutating tool)", () => {
  // run_collect appends one messages.collected audit per successful call →
  // its entries report readOnly:false; every other advertised observation
  // tool appends nothing and reports readOnly:true. No entry ever advertises
  // a destructive/control tool.
  for (const [tool, facts] of FACT_MATRIX) {
    for (const e of selectDrilldowns(tool, facts)) {
      assert.equal(typeof e.readOnly, "boolean", `${tool} entry readOnly is a boolean`);
      const expected = e.tool === "run_collect" ? false : true;
      assert.equal(e.readOnly, expected,
        `${tool} entry for ${e.tool} must report readOnly:${expected}`);
      assert.ok(!MUTATION_TOOLS.includes(e.tool), `${tool} must never advertise ${e.tool}`);
    }
  }
  // The advertised tool set is exactly the closed observation set.
  for (const t of DRILLDOWN_TOOLS) {
    assert.ok(!MUTATION_TOOLS.includes(t), `closed drilldown tool set contains mutating tool ${t}`);
  }
  // The validator enforces the boolean + per-tool TRUTHFUL contract: the
  // truthful pairs pass, the untruthful pairs (run_status:false,
  // run_collect:true) are rejected, non-boolean readOnly is rejected.
  const base = {
    tool: "run_status", view: "timeline", detail: "d", purpose: "p",
    reveals: "r", cost: "low",
  };
  for (const tool of DRILLDOWN_TOOLS) {
    const truthful = { ...base, tool, readOnly: tool === "run_collect" ? false : true };
    assert.equal(validateDrilldownEntry(truthful), true, `truthful pair ${tool}/${truthful.readOnly} passes`);
  }
  assert.throws(() => validateDrilldownEntry({ ...base, readOnly: false }), /readOnly/,
    "run_status:false rejected (untruthful pair)");
  assert.throws(() => validateDrilldownEntry({ ...base, tool: "run_collect", readOnly: true }), /readOnly/,
    "run_collect:true rejected (untruthful pair)");
  assert.throws(() => validateDrilldownEntry({ ...base, readOnly: "yes" }), /readOnly/,
    "non-boolean readOnly rejected");
  assert.throws(() => validateDrilldownEntry({ ...base, readOnly: null }), /readOnly/,
    "null readOnly rejected");
  // enforceDrilldownBounds validates EVERY entry before accepting the array —
  // an untruthful entry fails closed even though the count is in bounds.
  assert.throws(() => enforceDrilldownBounds([
    { ...base, readOnly: true },
    { ...base, tool: "run_collect", readOnly: true },
  ]), /readOnly/, "enforceDrilldownBounds rejects an untruthful run_collect entry (validates all)");
  assert.throws(() => enforceDrilldownBounds([
    { ...base, readOnly: true },
    { ...base, readOnly: "yes" },
  ]), /readOnly/, "enforceDrilldownBounds rejects a non-boolean readOnly");
  assert.deepEqual(enforceDrilldownBounds([
    { ...base, readOnly: true },
    { ...base, tool: "run_collect", readOnly: false },
  ]), [
    { ...base, readOnly: true },
    { ...base, tool: "run_collect", readOnly: false },
  ], "truthful pairs accepted by enforceDrilldownBounds");
});

test("U-08: purpose/reveals strings are exact one-call semantics (no overclaim)", () => {
  const by = (tool, view, detail) => {
    const found = [];
    for (const [t, facts] of FACT_MATRIX) {
      for (const e of selectDrilldowns(t, facts)) {
        if (e.tool === tool && e.view === view && e.detail === detail) found.push(e);
      }
    }
    assert.ok(found.length >= 1, `catalog entry ${tool}/${view}/${detail} reachable from some facts`);
    return found[0];
  };
  // run_collect full view reveals ONE BOUNDED PAGE of assistant output with
  // evidence counts and continuation state — not all assistant text.
  const full = by("run_collect", "evidence", "bounded worker output page");
  assert.equal(full.reveals,
    "one bounded page of assistant output with evidence counts and continuation state",
    "run_collect full view reveals one bounded page");
  assert.ok(!/all|entire|full worker/i.test(full.reveals), "no all-text overclaim in run_collect full reveals");
  // run_delivery_review reveals one selected bounded diff fragment plus
  // proof-backed file metadata/pagination; it does not itself return the
  // verification result.
  const review = by("run_delivery_review", "delivery", "delivery diff review");
  assert.equal(review.reveals,
    "one selected bounded diff fragment plus proof-backed file metadata and pagination",
    "run_delivery_review reveals one bounded fragment, not the verification result");
  assert.ok(!/verification/i.test(review.reveals),
    "run_delivery_review entry must not claim to return the verification result");
  // run_activity reveals ONE PAGE of the timeline, not the full timeline.
  const act = by("run_activity", "timeline", "activity timeline page");
  assert.ok(/page/i.test(act.detail) && !/full/i.test(act.detail),
    "run_activity entry is one-page semantics");
  // Every reveals string is a single-call factual claim.
  for (const [tool, facts] of FACT_MATRIX) {
    for (const e of selectDrilldowns(tool, facts)) {
      assert.ok(!/^all |^every |full worker/i.test(e.reveals),
        `${tool} entry reveals overclaims: ${e.reveals}`);
    }
  }
});

test("U-06: representative context-sensitive selections (facts-driven, no inference)", () => {
  const expect = (tool, facts, tools, order = tools) => {
    const got = selectDrilldowns(tool, facts).map((e) => e.tool);
    assert.deepEqual(got, order, `${tool} ${JSON.stringify(facts)} → [${got}]`);
  };

  // non-terminal / silent → point-in-time status + activity choices.
  expect("run_await_result", { state: "running", terminal: false, observationOutcome: "observed", readFailureReason: null, liveness: "silent", resultStatus: "not_terminal" }, ["run_status", "run_activity"]);
  // atomic wait already reports state/liveness; non-terminal work drills directly into activity.
  expect("run_wait", { state: "running", terminal: false, liveness: "progress" }, ["run_activity"]);
  // terminal success exposes activity plus the compact final result.
  expect("run_wait", { state: "completed", terminal: true, liveness: "terminal" }, ["run_activity", "run_collect"]);
  // terminal failure exposes diagnosis plus activity facts.
  expect("run_wait", { state: "failed", terminal: true, liveness: "terminal" }, ["run_diagnose", "run_activity"]);
  // read-failure → point-in-time status + activity choices.
  expect("run_await_result", { state: "running", terminal: false, observationOutcome: "read_failure", readFailureReason: "transcript_parse_failed", liveness: "unknown", resultStatus: "unavailable" }, ["run_status", "run_activity"]);
  // terminal compact result → activity + full collect.
  expect("run_await_result", { state: "completed", terminal: true, observationOutcome: "observed", readFailureReason: null, liveness: "terminal", resultStatus: "available" }, ["run_activity", "run_collect"]);
  // too_large → full collect is primary.
  expect("run_await_result", { state: "completed", terminal: true, observationOutcome: "observed", readFailureReason: null, liveness: "terminal", resultStatus: "too_large" }, ["run_collect", "run_activity"]);
  // failure category → activity/collect facts.
  expect("run_diagnose", { state: "failed", terminal: true, category: "provider_auth" }, ["run_activity", "run_collect"]);
  // delivery packaging failure → delivery facts + activity.
  expect("run_diagnose", { state: "failed", terminal: true, category: "delivery_packaging_failed" }, ["run_delivery", "run_activity"]);
  // delivery reviewable → delivery review + activity.
  expect("run_delivery", { deliveryAvailable: true, deliveryRequested: true, terminalState: "completed", verificationStatus: "passed", acceptanceStatus: "pending", readiness: null, deliveryFailureCode: null }, ["run_delivery_review", "run_activity"]);
  // delivery failed → activity + diagnosis (as facts permit).
  expect("run_delivery", { deliveryAvailable: false, deliveryRequested: true, terminalState: "failed", verificationStatus: null, acceptanceStatus: null, readiness: null, deliveryFailureCode: "commit_failed" }, ["run_activity", "run_diagnose"]);
  // M12-13 isolation_failed → activity + diagnosis, NEVER delivery review/delivery
  // (there is no packaging/diff/decision surface for an isolation escape).
  expect("run_delivery", { deliveryAvailable: false, deliveryRequested: true, terminalState: "failed", verificationStatus: null, acceptanceStatus: null, readiness: "isolation_failed", deliveryFailureCode: null }, ["run_activity", "run_diagnose"]);
  expect("run_await_result", { state: "failed", terminal: true, observationOutcome: "terminal", readFailureReason: null, liveness: "terminal", outcomeReadiness: "isolation_failed", outcomeVerificationStatus: null, resultStatus: null }, ["run_diagnose", "run_activity"]);
  // terminal activity → compact collect.
  expect("run_activity", { terminal: true, nextCursor: null }, ["run_collect"]);
  // non-terminal activity → point-in-time status.
  expect("run_activity", { terminal: false, nextCursor: null }, ["run_status"]);
  // truncated activity → continuation of the same timeline.
  expect("run_activity", { terminal: true, nextCursor: "tok" }, ["run_activity"]);
  // compact available → full collect + activity.
  expect("run_collect", { view: "compact", compactStatus: "available" }, ["run_collect", "run_activity"]);
  // compact too_large → full collect.
  expect("run_collect", { view: "compact", compactStatus: "too_large" }, ["run_collect"]);
  // full with cursor → continue pages + activity.
  expect("run_collect", { view: "full", nextCursor: "tok" }, ["run_collect", "run_activity"]);
});

test("U-07: unknown source tool fails closed; unknown fact values degrade deterministically", () => {
  assert.throws(() => selectDrilldowns("run_stop", {}), /unknown tool/,
    "a mutating tool name is never a valid drilldown source");
  assert.throws(() => selectDrilldowns("not_a_tool", {}), /unknown tool/);
  // Unknown/missing fact values never throw — they degrade to the same
  // deterministic fallback list.
  const a = selectDrilldowns("run_status", { state: "??", terminal: false });
  const b = selectDrilldowns("run_status", {});
  assert.deepEqual(a, b, "missing/unknown facts are deterministic");
  assert.ok(a.length >= 1);
});

test("U-09: M12-13 point-in-time isolationFailure (no readiness) projects the SAME drilldowns as readiness:isolation_failed", () => {
  // The point-in-time path carries NO readiness label, but the payload already
  // holds the safe-projected isolation-escape code. It must project the SAME
  // isolation-safe drilldown intent as the authoritative readiness:"isolation_failed"
  // path: run_activity + run_diagnose — NEVER run_delivery_review / repackage /
  // decision (an isolation escape has no packaging/diff/decision surface).
  const pointInTime = {
    deliveryAvailable: false, deliveryRequested: true, terminalState: "failed",
    verificationStatus: null, acceptanceStatus: null, readiness: null,
    deliveryFailureCode: null, isolationFailureCode: "workdir_escape",
  };
  const viaReadiness = {
    deliveryAvailable: false, deliveryRequested: true, terminalState: "failed",
    verificationStatus: null, acceptanceStatus: null, readiness: "isolation_failed",
    deliveryFailureCode: null,
  };
  const ptTools = selectDrilldowns("run_delivery", pointInTime).map((e) => e.tool);
  const rdTools = selectDrilldowns("run_delivery", viaReadiness).map((e) => e.tool);
  assert.deepEqual(ptTools, rdTools,
    "point-in-time isolationFailure must match readiness:isolation_failed drilldown intent");
  assert.deepEqual(ptTools, ["run_activity", "run_diagnose"],
    `point-in-time isolationFailure → run_activity + run_diagnose, got [${ptTools}]`);
  assert.ok(!ptTools.includes("run_delivery_review"),
    "isolation escape must NEVER advertise run_delivery_review");
});

test("U-09b: M12-13 malformed/unknown/missing isolationFailureCode does NOT promote to isolation-safe drilldowns", () => {
  // Only the EXACT safe code "workdir_escape" promotes; anything else keeps the
  // existing point-in-time behavior (activity + status). Readiness stays
  // authoritative when present, even if the code is also set.
  const base = {
    deliveryAvailable: false, deliveryRequested: true, terminalState: "failed",
    verificationStatus: null, acceptanceStatus: null, readiness: null,
    deliveryFailureCode: null,
  };
  assert.deepEqual(
    selectDrilldowns("run_delivery", base).map((e) => e.tool),
    ["run_activity", "run_status"], "missing code → waiting path, NOT isolation");
  assert.deepEqual(
    selectDrilldowns("run_delivery", { ...base, isolationFailureCode: null }).map((e) => e.tool),
    ["run_activity", "run_status"], "null code → waiting path, NOT isolation");
  assert.deepEqual(
    selectDrilldowns("run_delivery", { ...base, isolationFailureCode: "other" }).map((e) => e.tool),
    ["run_activity", "run_status"], "unknown code → waiting path, NOT isolation");
  // Readiness present wins (authoritative) even when the code is also set: a
  // reviewable readiness yields run_delivery_review, which the isolation path
  // would NEVER advertise.
  assert.deepEqual(
    selectDrilldowns("run_delivery", {
      deliveryAvailable: true, deliveryRequested: true, terminalState: "completed",
      verificationStatus: "passed", acceptanceStatus: "pending",
      readiness: "reviewable", deliveryFailureCode: null,
      isolationFailureCode: "workdir_escape",
    }).map((e) => e.tool),
    ["run_delivery_review", "run_activity"],
    "readiness authoritative when present, even with isolationFailureCode set");
});
