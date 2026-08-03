// test/m12-12-semantics.test.js
//
// M12-12: Self-Describing Results — every successful result from the four
// standalone observation tools (run_wait, run_await_result, run_delivery,
// run_diagnose) carries REQUIRED `semanticNotes`: 1..4 plain-English notes that
// self-explain the CURRENT facts (meaning + what it does NOT mean), with full
// detail for any note at the read-only resource wao://semantics/{id}.
//
// TDD RED→GREEN. The application SSOT is src/application/runSemanticsNotes.js
// (frozen static catalog + pure selectors + hard bounds); the MCP schema derives
// its id enum / bounds from that SSOT (parity by construction), and the MCP
// adapter attaches the notes immediately before the strict output parse.
//
// Contracts under test (the Authorized product contract):
//   S-*   PURE selectors: exact three-key shape {id, meaning, doesNotMean};
//         closed-set ids; no dynamic echo; UTF-8 byte cap; max count; unique ids;
//         unknown tool throws; unknown facts degrade deterministically; the
//         selector matrix; read_failure EXCLUDES any termination note; no note
//         is a prescription.
//   M-*   REAL MCP handlers (all four) attach semanticNotes before parse; the
//         schema/catalog/resource parity; the review_bundle exclusion; the
//         run_diagnose trust boundary; unchanged 21-tool surface.
//   R-*   RESOURCES: wao://semantics summary + wao://semantics/{id} template;
//         NO per-id static resources; summary/detail parity with the SSOT;
//         unknown/malformed id → fixed safe text, never echoes the id.
//   X-*   Existing exact-key contracts unchanged (availableDrilldowns seven-key
//         coexists with semanticNotes three-key); descriptions carry the new
//         self-explain contract + the detail uri while preserving guarded words.
//   SM-*  Best-effort smoke against representative real transcript files
//         (read-only; skipped if none safely discoverable).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createWaoMcpServer } from "../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// ===== Helpers =====

function makeGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "R.md"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: dir });
}

function jl(obj) { return JSON.stringify(obj) + "\n"; }

function seedTranscript(runDir, runId, {
  agentId = "coder_low", messages = [], terminal = false, workspaceCwd, extraLines = [],
} = {}) {
  mkdirSync(runDir, { recursive: true });
  const lines = [
    jl({ type: "run.submitted", agentId, ts: "2026-08-03T00:00:00.000Z", runId }),
    jl({ type: "session.created", backend: "process", backendSessionId: "proc_m1212", runId, agentId }),
    jl({ type: "run.started", backend: "claude-code", ts: "2026-08-03T00:00:01.000Z", runId, agentId }),
    jl({ type: "run.background_submitted", background: true, cwd: workspaceCwd, runId, agentId }),
    jl({ type: "run.state_change", to: "pending", reason: "created", ts: "2026-08-03T00:00:02.000Z", runId, agentId }),
    jl({ type: "run.state_change", to: "running", reason: "first_event", ts: "2026-08-03T00:00:03.000Z", runId, agentId }),
  ];
  for (const [i, text] of messages.entries()) {
    lines.push(jl({
      type: "run.event", kind: "message", role: "assistant",
      parts: [{ type: "text", text }], ts: `2026-08-03T00:00:${10 + i}.000Z`, runId, agentId,
    }));
  }
  for (const l of extraLines) lines.push(l);
  if (terminal === "completed" || terminal === true) {
    lines.push(jl({ type: "run.completed", ts: "2026-08-03T00:10:00.000Z", runId, agentId }));
    lines.push(jl({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-08-03T00:10:01.000Z", runId, agentId }));
  } else if (terminal === "failed_auth") {
    lines.push(jl({ type: "run.error", error: "HTTP 401 unauthorized", ts: "2026-08-03T00:10:00.000Z", runId, agentId }));
    lines.push(jl({ type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-08-03T00:10:01.000Z", runId, agentId }));
  } else if (terminal === "failed_backend") {
    lines.push(jl({ type: "run.error", phase: "wait", error: "backend reported failure", ts: "2026-08-03T00:10:00.000Z", runId, agentId }));
    lines.push(jl({ type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-08-03T00:10:01.000Z", runId, agentId }));
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

const FOUR_TOOLS = ["run_wait", "run_await_result", "run_delivery", "run_diagnose"];

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

// =====================================================================
// M-* — REAL MCP handlers (all four) attach semanticNotes before parse.
// =====================================================================

test("M-01: four output schemas REQUIRE semanticNotes; schema/catalog parity; bundle excludes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1212-m01-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const { SEMANTIC_NOTE_MAX_ENTRIES, SEMANTIC_NOTE_FIELD_MAX_LEN, SEMANTIC_NOTE_MAX_DOES_NOT_MEAN,
        SEMANTIC_NOTE_ID_MAX_LEN, SEMANTIC_NOTE_ID_PATTERN }
        = await import("../src/application/runSemanticsNotes.js");
      const tools = await client.listTools();
      for (const name of FOUR_TOOLS) {
        const t = tools.tools.find((x) => x.name === name);
        assert.ok(t, `${name} discoverable`);
        const props = t.outputSchema.properties ?? {};
        const sn = props.semanticNotes;
        assert.ok(sn, `${name} exposes semanticNotes`);
        assert.ok(Array.isArray(t.outputSchema.required) && t.outputSchema.required.includes("semanticNotes"),
          `${name} REQUIRES semanticNotes`);
        assert.equal(sn.type, "array");
        assert.equal(sn.minItems, 1, `${name} minItems 1`);
        assert.equal(sn.maxItems, SEMANTIC_NOTE_MAX_ENTRIES, `${name} maxItems === SSOT cap`);
        const items = sn.items ?? {};
        assert.equal(items.additionalProperties, false, `${name} entry strict`);
        assert.deepEqual(Object.keys(items.properties ?? {}).sort(), ["doesNotMean", "id", "meaning"],
          `${name} entry exact three keys`);
        assert.deepEqual([...(items.required ?? [])].sort(), ["doesNotMean", "id", "meaning"],
          `${name} entry requires all three keys`);
        // Finding 4: the output schema carries a BOUNDED id SHAPE — namespace pattern +
        // bounded length from the SSOT — NOT the full catalog enum (serializing a 33+-id
        // enum once per output schema dominated the tools/list wire). The application SSOT
        // (validateSemanticNote → ID_SET) remains the exact catalog-membership authority;
        // handlers only ever emit catalog ids (see M-11).
        const idSchema = items.properties.id ?? {};
        assert.equal(idSchema.enum, undefined, `${name} id schema must NOT inline the full catalog enum`);
        assert.equal(idSchema.type, "string", `${name} id is a bounded string`);
        assert.equal(idSchema.maxLength, SEMANTIC_NOTE_ID_MAX_LEN, `${name} id maxLength === SSOT`);
        assert.ok(typeof idSchema.pattern === "string" && idSchema.pattern.length > 0,
          `${name} id carries the namespace pattern`);
        // The SSOT pattern source is exactly the four frozen namespaces.
        assert.equal(SEMANTIC_NOTE_ID_PATTERN.source, idSchema.pattern,
          `${name} id pattern === SSOT SEMANTIC_NOTE_ID_PATTERN`);
        assert.equal(items.properties.meaning.maxLength, SEMANTIC_NOTE_FIELD_MAX_LEN, `${name} meaning maxLength === SSOT`);
        assert.equal(items.properties.doesNotMean.maxItems, SEMANTIC_NOTE_MAX_DOES_NOT_MEAN, `${name} doesNotMean maxItems === SSOT`);
        assert.equal(items.properties.doesNotMean.minItems, 0, `${name} doesNotMean minItems 0`);
      }
      // No OTHER tool carries semanticNotes.
      for (const t of tools.tools) {
        if (FOUR_TOOLS.includes(t.name)) continue;
        assert.equal(t.outputSchema?.properties?.semanticNotes, undefined, `${t.name} must NOT carry semanticNotes`);
      }
      // run_delivery_review_bundle: neither top level nor nested delivery carries/requires it.
      const bundle = tools.tools.find((x) => x.name === "run_delivery_review_bundle");
      assert.ok(bundle, "bundle discoverable");
      assert.equal(bundle.outputSchema?.properties?.semanticNotes, undefined, "bundle top level no semanticNotes");
      assert.ok(!(bundle.outputSchema?.required ?? []).includes("semanticNotes"), "bundle top level does not require it");
      const nested = bundle.outputSchema?.properties?.delivery ?? {};
      assert.equal(nested.properties?.semanticNotes, undefined, "bundle nested delivery no semanticNotes");
      assert.ok(!(nested.required ?? []).includes("semanticNotes"), "bundle nested delivery does not require it");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M-02: run_wait window_expired → [observation.window_expired] (no termination note); legacy fields intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1212-m02-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1212-m02-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_m2", { workspaceCwd: dir, messages: [], terminal: false });
    let clock = 1000000;
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir, workspaceRoot: dir,
      runWaitFn: async (input) => {
        const { runWait } = await import("../src/application/runWait.js");
        return runWait({ ...input, nowFn: () => clock, pollIntervalMs: 2000, sleepFn: async (ms) => { clock += ms; } });
      },
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_wait", arguments: { runId: "run_m2", waitMs: 180000 } });
      assert.equal(res.isError, undefined);
      const p = res.structuredContent;
      assert.deepEqual(p.semanticNotes.map((n) => n.id), ["observation.window_expired"]);
      assert.ok(!p.semanticNotes.some((n) => n.id.startsWith("termination.")), "no termination note on window expiry");
      // Legacy fields intact (M12-8B availableDrilldowns coexists).
      assert.ok(Array.isArray(p.availableDrilldowns), "availableDrilldowns still present");
      assert.equal(p.observation.outcome, "window_expired");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("M-03: run_wait terminal completed → [observation.terminal, termination.completion]", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1212-m03-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1212-m03-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_m3", { workspaceCwd: dir, messages: ["FINAL"], terminal: "completed" });
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir, workspaceRoot: dir,
      runWaitFn: async (input) => {
        const { runWait } = await import("../src/application/runWait.js");
        return runWait({ ...input, sleepFn: () => Promise.resolve(), nowFn: () => 1 });
      },
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_wait", arguments: { runId: "run_m3", waitMs: 180000 } });
      assert.equal(res.isError, undefined);
      assert.deepEqual(res.structuredContent.semanticNotes.map((n) => n.id),
        ["observation.terminal", "termination.completion"]);
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("M-04: run_wait read_failure → [observation.read_failure] (NO termination note)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1212-m04-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1212-m04-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_m4", { workspaceCwd: dir, messages: [], terminal: false });
    const { readTranscript: readReal } = await import("../src/transcript.js");
    let reads = 0;
    let clock = 1000000;
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir, workspaceRoot: dir,
      runWaitFn: async (input) => {
        const { runWait } = await import("../src/application/runWait.js");
        return runWait({
          ...input, nowFn: () => clock, pollIntervalMs: 2000, sleepFn: async (ms) => { clock += ms; },
          readTranscriptFn: async (p) => { reads += 1; if (reads === 1) return readReal(p); throw new Error("gone"); },
        });
      },
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_wait", arguments: { runId: "run_m4", waitMs: 180000 } });
      assert.equal(res.isError, undefined);
      const p = res.structuredContent;
      assert.equal(p.observationOutcome, "read_failure");
      assert.deepEqual(p.semanticNotes.map((n) => n.id), ["observation.read_failure"]);
      assert.ok(!p.semanticNotes.some((n) => n.id.startsWith("termination.")), "read_failure MUST NOT carry a termination note");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("M-05: run_await_result terminal completed → [observation.terminal, termination.completion]", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1212-m05-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1212-m05-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_m5", { workspaceCwd: dir, messages: ["FINAL"], terminal: "completed" });
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_await_result", arguments: { runId: "run_m5", waitMs: 0 } });
      assert.equal(res.isError, undefined);
      assert.deepEqual(res.structuredContent.semanticNotes.map((n) => n.id),
        ["observation.terminal", "termination.completion"]);
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("M-06: run_await_result failed provider_auth → obs+termination.provider+diagnosis.provider_auth", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1212-m06-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1212-m06-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_m6", { workspaceCwd: dir, messages: ["partial"], terminal: "failed_auth" });
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_await_result", arguments: { runId: "run_m6", waitMs: 0 } });
      assert.equal(res.isError, undefined);
      const ids = res.structuredContent.semanticNotes.map((n) => n.id);
      assert.deepEqual(ids, ["observation.terminal", "termination.provider", "diagnosis.provider_auth"]);
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("M-07: run_delivery reviewable / packaging_failed / not_requested via DI fakes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1212-m07-"));
  try {
    makeGitRepo(dir);
    // Point-in-time path (no readiness): verification passed → delivery.verification_passed.
    const s1 = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      getRunDeliveryFn: async () => ({
        runId: "run_a", terminalState: "completed",
        deliveryRef: { deliveryCommit: "d".repeat(40), baseCommit: "b".repeat(40), changedFiles: ["src/a.js"] },
        verification: { status: "passed" }, acceptance: { status: "pending" },
      }),
    });
    const c1 = await buildClient(s1);
    try {
      const res = await c1.callTool({ name: "run_delivery", arguments: { runId: "run_a" } });
      assert.equal(res.isError, undefined);
      assert.deepEqual(res.structuredContent.semanticNotes.map((n) => n.id), ["delivery.verification_passed"]);
    } finally { await c1.close(); await s1.close(); }

    // Wait-path readiness reviewable → delivery.reviewable.
    const s2 = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      getRunDeliveryReadinessFn: async () => ({
        runId: "run_w", terminalState: "completed", deliveryAvailable: true,
        deliveryRef: { deliveryCommit: "e".repeat(40), baseCommit: "f".repeat(40), changedFiles: ["src/b.js"] },
        verification: { status: "passed" }, acceptance: { status: "pending" },
        readiness: "reviewable", waitReturnedEarly: true,
      }),
    });
    const c2 = await buildClient(s2);
    try {
      const res = await c2.callTool({ name: "run_delivery", arguments: { runId: "run_w", waitMs: 1000 } });
      assert.equal(res.isError, undefined);
      assert.deepEqual(res.structuredContent.semanticNotes.map((n) => n.id), ["delivery.reviewable"]);
    } finally { await c2.close(); await s2.close(); }

    // Packaging failure → delivery.packaging_failed.
    const s3 = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      getRunDeliveryFn: async () => ({
        runId: "run_b", terminalState: "failed", deliveryAvailable: false,
        deliveryRequested: true, deliveryFailure: { code: "commit_failed" },
      }),
    });
    const c3 = await buildClient(s3);
    try {
      const res = await c3.callTool({ name: "run_delivery", arguments: { runId: "run_b" } });
      assert.deepEqual(res.structuredContent.semanticNotes.map((n) => n.id), ["delivery.packaging_failed"]);
    } finally { await c3.close(); await s3.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M-08: run_diagnose via DI fake → one diagnosis note for the current category", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1212-m08-"));
  try {
    makeGitRepo(dir);
    for (const category of ["provider_auth", "scorecard_fail", "delivery_packaging_failed", "unknown"]) {
      const server = createWaoMcpServer({
        registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
        getRunDiagnosisFn: async () => ({ runId: "run_x", state: "failed", terminal: true, category, code: null, evidence: [] }),
      });
      const client = await buildClient(server);
      try {
        const res = await client.callTool({ name: "run_diagnose", arguments: { runId: "run_x" } });
        assert.equal(res.isError, undefined);
        assert.deepEqual(res.structuredContent.semanticNotes.map((n) => n.id), [`diagnosis.${category}`]);
      } finally { await client.close(); await server.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M-09: run_diagnose trust boundary — unknown/extra field collapses to fixed error, no semanticNotes leak", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1212-m09-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      getRunDiagnosisFn: async () => ({
        runId: "run_z", state: "failed", terminal: true,
        category: "not_a_closed_set_category", code: "unauthorized", evidence: [],
        leakedPath: "C:\\secret\\path",
      }),
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_diagnose", arguments: { runId: "run_z" } });
      assert.equal(res.isError, true);
      assert.equal(res.structuredContent, undefined, "no partial structuredContent");
      assert.equal(res.content?.[0]?.text, "run_diagnose failed");
      assert.ok(!JSON.stringify(res.content).includes("secret"), "no leak");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M-10: unchanged 21-tool surface; all four tools carry semanticNotes; no extra tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1212-m10-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 21, "exactly 21 tools");
      const names = new Set(tools.tools.map((t) => t.name));
      assert.equal(names.size, 21, "21 distinct tool names");
      for (const n of FOUR_TOOLS) assert.ok(names.has(n), `${n} present`);
      // No new tools named anything semantic-related.
      assert.ok(![...names].some((n) => /semantic/i.test(n)), "no semantic-named tool added");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M-11: handler results ONLY contain catalog ids (selector is the closed-set authority under the bounded schema)", async () => {
  // Finding 4: the output schema is a bounded id SHAPE (pattern + length), not the
  // full enum. A non-catalog-but-pattern-matching id would pass the schema, so this
  // test proves the real handlers can never emit one — the application selector only
  // ever emits catalog ids, and the strict parse runs after attachment.
  const { SEMANTIC_NOTE_IDS } = await import("../src/application/runSemanticsNotes.js");
  const { DIAGNOSIS_CATEGORIES } = await import("../src/diagnosis.js");
  const idSet = new Set(SEMANTIC_NOTE_IDS);
  const dir = mkdtempSync(join(tmpdir(), "wao-m1212-m11-"));
  try {
    makeGitRepo(dir);

    // run_diagnose: every closed-set category emits exactly one catalog diagnosis id.
    for (const category of DIAGNOSIS_CATEGORIES) {
      const server = createWaoMcpServer({
        registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
        getRunDiagnosisFn: async () => ({ runId: "run_x", terminal: true, state: "failed", category }),
      });
      const client = await buildClient(server);
      try {
        const res = await client.callTool({ name: "run_diagnose", arguments: { runId: "run_x" } });
        const notes = res.structuredContent.semanticNotes;
        assert.equal(notes.length, 1, `diagnose ${category}: one note`);
        assert.ok(idSet.has(notes[0].id), `diagnose ${category}: id ${notes[0].id} is a catalog member`);
      } finally { await client.close(); await server.close(); }
    }

    // run_delivery point-in-time success → delivery.verification_passed (catalog).
    {
      const server = createWaoMcpServer({
        registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
        getRunDeliveryFn: async () => ({
          runId: "run_x", terminalState: "completed",
          deliveryRef: { deliveryCommit: "d".repeat(40), baseCommit: "b".repeat(40), changedFiles: ["src/a.js"], verification: { status: "passed" }, acceptance: { status: "pending" } },
          verification: { status: "passed" }, acceptance: { status: "pending" },
        }),
      });
      const client = await buildClient(server);
      try {
        const res = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x" } });
        const notes = res.structuredContent.semanticNotes;
        assert.equal(notes.length, 1, "delivery success: one note");
        assert.ok(idSet.has(notes[0].id), `delivery success: id ${notes[0].id} is a catalog member`);
      } finally { await client.close(); await server.close(); }
    }

    // run_delivery waitMs readiness packaging_failed → delivery.packaging_failed (catalog).
    {
      const server = createWaoMcpServer({
        registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
        getRunDeliveryReadinessFn: async () => ({ runId: "run_x", readiness: "packaging_failed", waitReturnedEarly: true, terminalState: "failed", deliveryAvailable: false, deliveryRef: null, deliveryFailure: { code: "commit_failed" } }),
      });
      const client = await buildClient(server);
      try {
        const res = await client.callTool({ name: "run_delivery", arguments: { runId: "run_x", waitMs: 1000 } });
        const notes = res.structuredContent.semanticNotes;
        assert.equal(notes.length, 1, "delivery packaging_failed: one note");
        assert.ok(idSet.has(notes[0].id), `delivery packaging_failed: id ${notes[0].id} is a catalog member`);
      } finally { await client.close(); await server.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// =====================================================================
// R-* — RESOURCES: wao://semantics summary + wao://semantics/{id} template.
// =====================================================================

const SUMMARY_URI = "wao://semantics";
const detailUri = (id) => `wao://semantics/${id}`;

function readText(readResult) {
  return (readResult?.contents ?? []).map((c) => c.text ?? "").join("");
}

test("R-s1: resources/list has the summary; templates/list has the {id} template; NO per-id static resources", async () => {
  const server = createWaoMcpServer({ registryPath: "/x", runDir: "/x" });
  const client = await buildClient(server);
  try {
    const { resources } = await client.listResources();
    const uris = new Set(resources.map((r) => r.uri));
    assert.ok(uris.has(SUMMARY_URI), "wao://semantics summary present");
    const { SEMANTIC_NOTE_IDS } = await import("../src/application/runSemanticsNotes.js");
    // NO per-id static resource: ids are served by the template, not enumerated.
    for (const id of SEMANTIC_NOTE_IDS) {
      assert.ok(!uris.has(detailUri(id)), `${id} must NOT be a static resource (template serves it)`);
    }

    const { resourceTemplates } = await client.listResourceTemplates();
    const semTemplates = resourceTemplates.filter((t) => t.uriTemplate.startsWith("wao://semantics"));
    assert.ok(semTemplates.some((t) => t.uriTemplate === "wao://semantics/{id}"), "{id} template present");
  } finally { await client.close(); await server.close(); }
});

test("R-s2: read wao://semantics → validated summary (id + meaning, exact 2 keys, SSOT order)", async () => {
  const server = createWaoMcpServer({ registryPath: "/x", runDir: "/x" });
  const client = await buildClient(server);
  try {
    const { SEMANTIC_NOTE_IDS, getSemanticSummary } = await import("../src/application/runSemanticsNotes.js");
    const res = await client.readResource({ uri: SUMMARY_URI });
    const parsed = JSON.parse(readText(res));
    const list = parsed.semantics ?? parsed;
    assert.ok(Array.isArray(list) && list.length === SEMANTIC_NOTE_IDS.length, "summary lists every id");
    assert.deepEqual(list.map((s) => s.id), [...SEMANTIC_NOTE_IDS], "summary ids in SSOT order");
    for (const s of list) {
      assert.deepEqual(Object.keys(s).sort(), ["id", "meaning"], "summary entry exact two keys");
    }
    // Parity with the SSOT.
    assert.deepEqual(list, getSemanticSummary(), "summary resource == SSOT getSemanticSummary");
    assert.equal(res.contents[0].mimeType, "application/json");
  } finally { await client.close(); await server.close(); }
});

test("R-s3: read wao://semantics/{known id} → full note, id-bound, 3 keys, equal to SSOT", async () => {
  const { SEMANTIC_NOTE_IDS, getSemanticNoteById } = await import("../src/application/runSemanticsNotes.js");
  // Spot-check one id per namespace.
  for (const id of ["observation.window_expired", "termination.execution_deadline", "delivery.reviewable", "diagnosis.provider_auth"]) {
    assert.ok(SEMANTIC_NOTE_IDS.includes(id));
    const server = createWaoMcpServer({ registryPath: "/x", runDir: "/x" });
    const client = await buildClient(server);
    try {
      const res = await client.readResource({ uri: detailUri(id) });
      const parsed = JSON.parse(readText(res));
      const note = parsed.note ?? parsed;
      assert.deepEqual(Object.keys(note).sort(), ["doesNotMean", "id", "meaning"], `${id} 3 keys`);
      assert.equal(note.id, id, `${id} id-bound`);
      assert.deepEqual(note, getSemanticNoteById(id), `${id} equal to SSOT`);
      assert.equal(res.contents[0].mimeType, "application/json");
    } finally { await client.close(); await server.close(); }
  }
});

test("R-s4: read unknown/malformed id → fixed safe text, NEVER echoes the id in the text", async () => {
  const server = createWaoMcpServer({ registryPath: "/x", runDir: "/x" });
  const client = await buildClient(server);
  try {
    const { getSemanticSummary } = await import("../src/application/runSemanticsNotes.js");
    const meanings = getSemanticSummary().map((s) => s.meaning);
    for (const bad of ["does-not-exist-xyz", "observation..bad", "totally-fake-id"]) {
      const res = await client.readResource({ uri: detailUri(bad) });
      const text = readText(res);
      assert.equal(text, "semantics detail failed", `${bad}: fixed safe text`);
      assert.ok(!text.includes(bad), `${bad}: fixed text does not echo the id`);
      // No catalog note body (meaning text) leaks anywhere in the result.
      const dumped = JSON.stringify(res);
      for (const m of meanings) {
        assert.ok(!dumped.includes(m), `${bad}: no note meaning body leaks`);
      }
    }
  } finally { await client.close(); await server.close(); }
});

test("R-s5: no workspace binding / runDir dependency; resources create no files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1212-rs5-"));
  try {
    const server = createWaoMcpServer({ registryPath: "/nonexistent", runDir: dir });
    const client = await buildClient(server);
    try {
      const before = new Set(readdirSync(dir));
      const summary = await client.readResource({ uri: SUMMARY_URI });
      const list = JSON.parse(readText(summary)).semantics;
      assert.ok(list.length > 0, "summary works without workspace binding");
      const detail = await client.readResource({ uri: detailUri("termination.unknown") });
      JSON.parse(readText(detail)).note; // parses
      const after = new Set(readdirSync(dir));
      assert.deepEqual([...after].filter((f) => !before.has(f)), [], "no files created");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// =====================================================================
// X-* — Existing exact-key contracts coexist; descriptions updated.
// =====================================================================

test("X-01: availableDrilldowns (7-key) and semanticNotes (3-key) coexist; drilldown shape unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1212-x01-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      for (const name of FOUR_TOOLS) {
        const t = tools.tools.find((x) => x.name === name);
        const props = t.outputSchema.properties ?? {};
        // availableDrilldowns entry shape unchanged (exact seven keys).
        const ddItems = props.availableDrilldowns?.items ?? {};
        assert.deepEqual(Object.keys(ddItems.properties ?? {}).sort(),
          ["cost", "detail", "purpose", "readOnly", "reveals", "tool", "view"],
          `${name} availableDrilldowns entry still exactly seven keys`);
        // semanticNotes entry shape (exact three keys).
        const snItems = props.semanticNotes?.items ?? {};
        assert.deepEqual(Object.keys(snItems.properties ?? {}).sort(),
          ["doesNotMean", "id", "meaning"], `${name} semanticNotes entry exactly three keys`);
      }
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("X-02: four descriptions mention semanticNotes self-explain + detail uri; guarded words preserved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1212-x02-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      for (const name of FOUR_TOOLS) {
        const t = tools.tools.find((x) => x.name === name);
        assert.ok(/semanticNotes/i.test(t.description), `${name} mentions semanticNotes`);
        assert.ok(/wao:\/\/semantics\/\{id\}/.test(t.description), `${name} names the detail uri`);
      }
      // run_wait guarded keywords (runWait.test.js M11-11A-RED-02) preserved.
      const wait = tools.tools.find((x) => x.name === "run_wait").description;
      assert.ok(/270000|270 seconds|4\.5 min/i.test(wait), "run_wait keeps the 270000/4.5 min default");
      // run_diagnose keeps "Lead" (m12-10 G guard).
      assert.ok(/lead/i.test(tools.tools.find((x) => x.name === "run_diagnose").description), "run_diagnose keeps Lead");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// =====================================================================
// SM-* — Best-effort smoke against representative real transcript files.
// Read-only; skipped if none are safely discoverable. Never modifies runs.
// =====================================================================

test("SM-01: pure selector handles real transcript event shapes (read-only; skip if none)", async () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const runsDir = join(repoRoot, "runs");
  if (!existsSync(runsDir)) return; // no real runs in this checkout — skip
  let files = [];
  try {
    for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(runsDir, entry.name));
      if (entry.isDirectory()) {
        try {
          for (const f of readdirSync(join(runsDir, entry.name))) {
            if (f.endsWith(".jsonl")) files.push(join(runsDir, entry.name, f));
          }
        } catch { /* best effort */ }
      }
    }
  } catch { /* best effort */ }
  files = files.slice(0, 8); // bounded, representative
  if (files.length === 0) return; // nothing to smoke — skip
  const { selectSemanticNotes } = await import("../src/application/runSemanticsNotes.js");
  for (const f of files) {
    let events;
    try {
      events = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    } catch { continue; /* unparseable — skip this file, do not mutate */ }
    if (!Array.isArray(events) || events.length === 0) continue;
    const runIds = [...new Set(events.map((e) => e?.runId).filter((x) => typeof x === "string"))];
    if (runIds.length === 0) continue;
    const runId = runIds[0];
    const bound = events.filter((e) => e?.runId === runId);
    const terminal = bound.some((e) => e?.type === "run.completed" || e?.type === "run.aborted" || e?.type === "run.timed_out"
      || (e?.type === "run.state_change" && ["completed", "failed", "aborted", "timed_out"].includes(e?.to)));
    // Pure selector on a real-shape fact bundle: must never throw, must yield bounded notes.
    const notes = selectSemanticNotes("run_await_result", {
      outcome: terminal ? "terminal" : "point_in_time",
      terminal,
      terminationSource: terminal ? "unknown" : null,
      diagnosisCategory: null,
      deliveryRequested: false,
    });
    assert.ok(notes.length >= 1 && notes.length <= 4, `${f}: bounded notes on real data`);
    for (const n of notes) {
      assert.deepEqual(Object.keys(n).sort(), ["doesNotMean", "id", "meaning"]);
    }
  }
});
