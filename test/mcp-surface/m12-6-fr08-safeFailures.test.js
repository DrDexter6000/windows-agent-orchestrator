// test/m12-6-fr08-safeFailures.test.js
//
// M12-6 FR-08: safe structured failure package — machine-actionable control-plane
// failures without leaking raw errors, plus fixed opaque errors for unexpected
// internal exceptions, plus already-closed FR-07/FR-03/04/08C attachments.
//
// The open gap is the FR-01 READ-FAILURE REASON: run_await_result already
// reports observationOutcome="read_failure", but every read-failure path looks
// identical — a Lead cannot tell a transcript JSON parse failure from a legacy
// non-usable snapshot shape from a residual non-parse failure. This file pins
// the NEW mandatory nullable closed-set field `readFailureReason`:
//   - observed ⇒ readFailureReason=null
//   - transcript read / JSON parse exception ⇒ "transcript_parse_failed"
//   - structurally incompatible legacy event/snapshot shape ⇒ "legacy_event_shape"
//   - any other safe non-parse failure to obtain a usable snapshot
//     (e.g. a residual SSOT derive failure) ⇒ "snapshot_unavailable"
// No error message/path/command/credential ever enters the result — the reason
// is a closed-set code, nothing else.
//
// Sections:
//   A — service-level readFailureReason contract (RED before FR-08 implementation)
//   B — MCP output schema + real-transport structured content (RED before implementation)
//   D — MCP adapter cross-field truth boundary: injected/malformed service
//       results violating observed⇔null / read_failure⇔closed-set must collapse
//       to the fixed opaque error (no silent coercion, no structured content)
//   C — already-closed attachments, verified WITHOUT code change:
//       C1 run_delivery_decide verification rejection → structured rejectionReason (FR-07)
//       C2 run_delivery packaging failure → structured deliveryFailure.code (FR-03/04/08C)
//       C3 unexpected internal exceptions stay fixed opaque MCP errors

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { createWaoMcpServer } from "../../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DeliveryDecisionPolicyError } from "../../src/transcript.js";
import { rmrfRetry } from "../_rmrfHelper.mjs";

// The exact closed set of safe read-failure reasons (single contract for the
// whole file — service outputs AND the MCP schema enum must be these three).
const READ_FAILURE_REASONS = Object.freeze([
  "transcript_parse_failed",
  "legacy_event_shape",
  "snapshot_unavailable",
]);

// ===== Helpers =====

function cleanupDir(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
// rmrfRetry (bounded transient-rm retry, injectable rm/sleep) is the shared
// test-only helper (TD-107) — see test/_rmrfHelper.mjs + test/rmrfRetry.test.js.

function jl(obj) { return JSON.stringify(obj) + "\n"; }

// MCP servers bind to the workspace root — it must be a real Git repo top-level
// (resolveWorkspaceBinding → proveWorkspace), exactly like the other MCP suites.
function makeGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "R.md"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: dir });
}

// A clock the sleepFn advances in lockstep, so deadline math is deterministic.
function clockSleep(start = 1000000) {
  let t = start;
  return { now: () => t, sleep: (ms) => { t += ms; }, get: () => t };
}

function seedTranscript(runDir, runId, { agentId = "coder_low", messages = [], terminal = false, workspaceCwd } = {}) {
  mkdirSync(runDir, { recursive: true });
  const lines = [
    jl({ type: "run.submitted", agentId, ts: "2026-07-28T00:00:00.000Z", runId }),
    jl({ type: "session.created", backend: "process", backendSessionId: "proc_fr08", runId, agentId }),
    jl({ type: "run.started", backend: "claude-code", ts: "2026-07-28T00:00:01.000Z", runId, agentId }),
    jl({ type: "run.background_submitted", background: true, cwd: workspaceCwd, runId, agentId }),
    jl({ type: "run.state_change", to: "pending", reason: "created", ts: "2026-07-28T00:00:02.000Z", runId, agentId }),
    jl({ type: "run.state_change", to: "running", reason: "first_event", ts: "2026-07-28T00:00:03.000Z", runId, agentId }),
  ];
  for (const [i, text] of messages.entries()) {
    lines.push(jl({
      type: "run.event", kind: "message", role: "assistant",
      parts: [{ type: "text", text }], ts: `2026-07-28T00:00:${10 + i}.000Z`, runId, agentId,
    }));
  }
  if (terminal) {
    lines.push(jl({ type: "run.completed", ts: "2026-07-28T00:10:00.000Z", runId, agentId }));
    lines.push(jl({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-07-28T00:10:01.000Z", runId, agentId }));
  }
  writeFileSync(join(runDir, `${runId}.jsonl`), lines.join(""), "utf8");
  return lines;
}

async function buildClient(server) {
  const [c1, s1] = InMemoryTransport.createLinkedPair();
  await server.connect(s1);
  const client = new Client({ name: "test", version: "0" }, { version: "0" });
  await client.connect(c1);
  return client;
}

// =====================================================================
// Section A — service-level readFailureReason contract (RED).
// =====================================================================

test("FR-08-A1: observed paths carry readFailureReason=null (terminal, point-in-time, window expiry)", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-fr08-a1-"));
  try {
    seedTranscript(runDir, "run_a1t", { messages: ["final"], terminal: true });
    seedTranscript(runDir, "run_a1n", { messages: [], terminal: false });
    const { runAwaitResult } = await import("../../src/application/runAwaitResult.js");
    const terminal = await runAwaitResult({ runId: "run_a1t", runDir, waitMs: 0 });
    const pit = await runAwaitResult({ runId: "run_a1n", runDir, waitMs: 0 });
    assert.equal(terminal.observationOutcome, "observed");
    assert.equal(terminal.readFailureReason, null, "terminal observed ⇒ null reason");
    assert.equal(pit.observationOutcome, "observed");
    assert.equal(pit.readFailureReason, null, "point-in-time observed ⇒ null reason");
    const clk = clockSleep();
    const expiry = await runAwaitResult({
      runId: "run_a1n", runDir, waitMs: 4000,
      nowFn: clk.now, pollIntervalMs: 2000, sleepFn: async (ms) => { clk.sleep(ms); },
    });
    assert.equal(expiry.observationOutcome, "observed");
    assert.equal(expiry.readFailureReason, null, "window-expiry observed ⇒ null reason");
  } finally { rmrfRetry(runDir); }
});

test("FR-08-A2: transcript read/JSON parse exception → readFailureReason=transcript_parse_failed", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-fr08-a2-"));
  try {
    // (a) Real malformed JSON on disk — readTranscript JSON.parse throws.
    seedTranscript(runDir, "run_a2m", { messages: [], terminal: false });
    const tp = join(runDir, "run_a2m.jsonl");
    writeFileSync(tp, readFileSync(tp, "utf8") + "{not valid json\n", "utf8");
    const { runAwaitResult } = await import("../../src/application/runAwaitResult.js");
    const malformed = await runAwaitResult({ runId: "run_a2m", runDir, waitMs: 0 });
    assert.equal(malformed.observationOutcome, "read_failure");
    assert.equal(malformed.readFailureReason, "transcript_parse_failed",
      "JSON parse exception ⇒ transcript_parse_failed");
    assert.equal(malformed.result.status, "unavailable");
    assert.equal(malformed.state, "unknown", "no facts from an unreadable transcript");

    // (b) Injected reader throwing (file vanished / I/O failure).
    const thrown = await runAwaitResult({
      runId: "run_a2x", runDir, waitMs: 0,
      readTranscriptFn: async () => { throw new Error("ENOENT: no such file"); },
    });
    assert.equal(thrown.observationOutcome, "read_failure");
    assert.equal(thrown.readFailureReason, "transcript_parse_failed",
      "transcript read exception ⇒ transcript_parse_failed");
    assert.equal(thrown.runId, "run_a2x", "trusted runId preserved");
    assert.equal(thrown.agentId, "unknown");
    assert.equal(thrown.cursor, null);
  } finally { rmrfRetry(runDir); }
});

test("FR-08-A3: structurally incompatible legacy event/snapshot shape → readFailureReason=legacy_event_shape", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-fr08-a3-"));
  try {
    // (a) Non-usable entries (null / primitive / array) appended to a clean prefix.
    seedTranscript(runDir, "run_a3s", { messages: [], terminal: false });
    const tp = join(runDir, "run_a3s.jsonl");
    writeFileSync(tp, readFileSync(tp, "utf8") + "null\n42\n[1,2,3]\n", "utf8");
    const { runAwaitResult } = await import("../../src/application/runAwaitResult.js");
    const shape = await runAwaitResult({ runId: "run_a3s", runDir, waitMs: 0 });
    assert.equal(shape.observationOutcome, "read_failure");
    assert.equal(shape.readFailureReason, "legacy_event_shape",
      "non-usable legacy entries ⇒ legacy_event_shape");
    assert.equal(shape.state, "running", "durable state preserved from usable subset");
    assert.equal(shape.result.status, "unavailable");

    // (b) A snapshot that is not an array at all (e.g. an object) is a shape failure.
    const nonArray = await runAwaitResult({
      runId: "run_a3o", runDir, waitMs: 0,
      readTranscriptFn: async () => ({ type: "not", a: "snapshot" }),
    });
    assert.equal(nonArray.observationOutcome, "read_failure");
    assert.equal(nonArray.readFailureReason, "legacy_event_shape",
      "non-array snapshot ⇒ legacy_event_shape");
    // The usable subset is empty: findState truthfully derives the safe
    // baseline state "pending" (no usable events) — not "unknown", which is
    // reserved for the derive-catch path.
    assert.equal(nonArray.state, "pending");
  } finally { rmrfRetry(runDir); }
});

test("FR-08-A4: poll re-read throw → transcript_parse_failed with prior trusted facts preserved", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-fr08-a4-"));
  try {
    const a = "coder_low", id = "run_a4";
    const clean = [
      { type: "run.submitted", agentId: a, runId: id, seq: 1 },
      { type: "session.created", backend: "process", backendSessionId: "p", runId: id, agentId: a, seq: 2 },
      { type: "run.state_change", to: "running", reason: "first_event", runId: id, agentId: a, seq: 3 },
    ];
    let readCalls = 0;
    const clk = clockSleep();
    const { runAwaitResult } = await import("../../src/application/runAwaitResult.js");
    const out = await runAwaitResult({
      runId: id, runDir, waitMs: 4000,
      nowFn: clk.now, pollIntervalMs: 2000, sleepFn: async (ms) => { clk.sleep(ms); },
      readTranscriptFn: async () => {
        readCalls += 1;
        if (readCalls === 1) return clean;
        throw new Error("transcript vanished mid-wait");
      },
    });
    assert.equal(out.observationOutcome, "read_failure");
    assert.equal(out.readFailureReason, "transcript_parse_failed",
      "re-read exception is still a parse/read failure");
    assert.equal(out.state, "running", "prior trusted state preserved");
    assert.equal(out.agentId, a, "prior trusted agentId preserved");
    assert.equal(out.cursor, 3, "prior trusted cursor preserved");
    assert.equal(out.liveness, "unknown");
    assert.equal(out.ownerHeartbeat, "unknown");
    assert.equal(out.result.status, "unavailable");
  } finally { rmrfRetry(runDir); }
});

test("FR-08-A5: poll snapshot shape corruption → legacy_event_shape with prior trusted facts preserved", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-fr08-a5-"));
  try {
    const a = "coder_low", id = "run_a5";
    const clean = [
      { type: "run.submitted", agentId: a, runId: id, seq: 1 },
      { type: "session.created", backend: "process", backendSessionId: "p", runId: id, agentId: a, seq: 2 },
      { type: "run.state_change", to: "running", reason: "first_event", runId: id, agentId: a, seq: 3 },
    ];
    const corrupted = [...clean, null];
    let readCalls = 0;
    const clk = clockSleep();
    const { runAwaitResult } = await import("../../src/application/runAwaitResult.js");
    const out = await runAwaitResult({
      runId: id, runDir, waitMs: 4000,
      nowFn: clk.now, pollIntervalMs: 2000, sleepFn: async (ms) => { clk.sleep(ms); },
      readTranscriptFn: async () => { readCalls += 1; return readCalls === 1 ? clean : corrupted; },
    });
    assert.equal(out.observationOutcome, "read_failure");
    assert.equal(out.readFailureReason, "legacy_event_shape",
      "corrupt snapshot between polls ⇒ legacy_event_shape");
    assert.equal(out.state, "running", "prior trusted state preserved");
    assert.equal(out.agentId, a, "prior trusted agentId preserved");
    assert.equal(out.cursor, 3, "prior trusted cursor preserved");
    assert.equal(out.result.status, "unavailable");
  } finally { rmrfRetry(runDir); }
});

test("FR-08-A6: residual non-parse derive failure → readFailureReason=snapshot_unavailable", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-fr08-a6-"));
  try {
    // A usable-object snapshot whose envelope read throws (a residual SSOT
    // derive failure — NOT a JSON parse error and NOT a shape violation). The
    // composite must classify it snapshot_unavailable and must NOT let the
    // TypeError escape as a top-level throw.
    const sneaky = {
      type: "run.state_change",
      to: "running",
      get seq() { throw new Error("boom C:\\secret\\key.pem PID=4242"); },
      runId: "run_a6",
      agentId: "coder_low",
    };
    const { runAwaitResult } = await import("../../src/application/runAwaitResult.js");
    const out = await runAwaitResult({
      runId: "run_a6", runDir, waitMs: 0,
      readTranscriptFn: async () => [
        { type: "run.submitted", agentId: "coder_low", runId: "run_a6", seq: 1 },
        sneaky,
      ],
    });
    assert.equal(out.observationOutcome, "read_failure");
    assert.equal(out.readFailureReason, "snapshot_unavailable",
      "residual non-parse failure ⇒ snapshot_unavailable");
    assert.equal(out.result.status, "unavailable");
    assert.equal(out.state, "unknown");
    const dumped = JSON.stringify(out);
    assert.ok(!dumped.includes("boom") && !dumped.includes("key.pem") && !dumped.includes("4242"),
      "no raw error detail leaks into the result");
  } finally { rmrfRetry(runDir); }
});

test("FR-08-A7: readFailureReason is exactly the closed set ∪ null on every outcome path", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-fr08-a7-"));
  try {
    seedTranscript(runDir, "run_a7t", { messages: ["x"], terminal: true });
    seedTranscript(runDir, "run_a7n", { messages: [], terminal: false });
    const tp = join(runDir, "run_a7n.jsonl");
    const { runAwaitResult } = await import("../../src/application/runAwaitResult.js");
    const observed = await runAwaitResult({ runId: "run_a7t", runDir, waitMs: 0 });
    writeFileSync(tp, readFileSync(tp, "utf8") + "null\n", "utf8");
    const shape = await runAwaitResult({ runId: "run_a7n", runDir, waitMs: 0 });
    const parse = await runAwaitResult({
      runId: "run_a7p", runDir, waitMs: 0,
      readTranscriptFn: async () => { throw new Error("io"); },
    });
    const residual = await runAwaitResult({
      runId: "run_a7r", runDir, waitMs: 0,
      readTranscriptFn: async () => [{
        type: "run.state_change", to: "running",
        get seq() { throw new Error("x"); },
      }],
    });
    for (const out of [observed, shape, parse, residual]) {
      assert.ok(out.readFailureReason === null || READ_FAILURE_REASONS.includes(out.readFailureReason),
        `closed-set reason on path observationOutcome=${out.observationOutcome}, got ${JSON.stringify(out.readFailureReason)}`);
    }
    assert.equal(observed.readFailureReason, null);
    assert.equal(shape.readFailureReason, "legacy_event_shape");
    assert.equal(parse.readFailureReason, "transcript_parse_failed");
    assert.equal(residual.readFailureReason, "snapshot_unavailable");
  } finally { rmrfRetry(runDir); }
});

// =====================================================================
// Section B — MCP output schema + real-transport structured content (RED).
// =====================================================================

test("FR-08-B1: output schema exposes readFailureReason with the exact closed set, nullable, strict", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-fr08-b1-"));
    makeGitRepo(dir);
  try {
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      const t = tools.tools.find((x) => x.name === "run_await_result");
      const props = t.outputSchema.properties ?? {};
      assert.equal(t.outputSchema.additionalProperties, false, "strict output preserved");
      assert.ok(props.readFailureReason, "output has readFailureReason");
      const rfr = props.readFailureReason;
      const rfrEnum = rfr.enum ?? rfr.anyOf?.find((s) => s.enum)?.enum ?? [];
      const enumVals = [...rfrEnum].sort();
      assert.deepEqual(enumVals, [...READ_FAILURE_REASONS].sort(),
        "readFailureReason enum is exactly the closed set");
      const nullable = props.readFailureReason.anyOf?.some((s) => s.type === "null")
        || props.readFailureReason.nullable === true
        || (Array.isArray(props.readFailureReason.type) && props.readFailureReason.type.includes("null"));
      assert.ok(nullable, "readFailureReason must be nullable (null on observed)");
    } finally { await client.close(); await server.close(); }
  } finally { rmrfRetry(dir); }
});

test("FR-08-B2: real client — malformed JSON → schema-valid structured unavailable with transcript_parse_failed, NOT generic MCP error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-fr08-b2-"));
    makeGitRepo(dir);
  const runDir = mkdtempSync(join(tmpdir(), "wao-fr08-b2-rd-"));
  try {
    const secret = "AKIAIOSFODNN7EXAMPLE"; // AWS docs example, not a live key
    const lines = seedTranscript(runDir, "run_b2", { messages: [], terminal: false, workspaceCwd: dir });
    writeFileSync(join(runDir, "run_b2.jsonl"), lines.join("") + `{broken ${secret}\n`, "utf8");
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_await_result", arguments: { runId: "run_b2", waitMs: 0 } });
      const parsed = res.structuredContent;
      assert.ok(parsed, "schema-valid structured result (NOT the fixed error text)");
      assert.equal(res.isError, undefined, "not an MCP error response");
      assert.equal(parsed.observationOutcome, "read_failure");
      assert.equal(parsed.readFailureReason, "transcript_parse_failed");
      assert.equal(parsed.result.status, "unavailable");
      assert.equal(parsed.runId, "run_b2", "trusted runId preserved");
      assert.equal(parsed.state, "unknown");
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes("run_await_result failed"), "no top-level failure text");
      assert.ok(!dumped.includes(secret), "no transcript content leaks via the parse error");
    } finally { await client.close(); await server.close(); }
  } finally { rmrfRetry(dir); rmrfRetry(runDir); }
});

test("FR-08-B3: real client — legacy non-usable shape → structured legacy_event_shape", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-fr08-b3-"));
    makeGitRepo(dir);
  const runDir = mkdtempSync(join(tmpdir(), "wao-fr08-b3-rd-"));
  try {
    const lines = seedTranscript(runDir, "run_b3", { messages: [], terminal: false, workspaceCwd: dir });
    writeFileSync(join(runDir, "run_b3.jsonl"), lines.join("") + "null\n42\n[1,2]\n", "utf8");
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_await_result", arguments: { runId: "run_b3", waitMs: 0 } });
      const parsed = res.structuredContent;
      assert.ok(parsed, "structured result");
      assert.equal(res.isError, undefined);
      assert.equal(parsed.observationOutcome, "read_failure");
      assert.equal(parsed.readFailureReason, "legacy_event_shape");
      assert.equal(parsed.result.status, "unavailable");
      assert.equal(parsed.state, "running", "durable state preserved from usable subset");
      assert.equal(parsed.cursor, null, "cursor untrusted on a corrupt snapshot");
    } finally { await client.close(); await server.close(); }
  } finally { rmrfRetry(dir); rmrfRetry(runDir); }
});

test("FR-08-B4: real client — success stays observed with readFailureReason=null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-fr08-b4-"));
    makeGitRepo(dir);
  const runDir = mkdtempSync(join(tmpdir(), "wao-fr08-b4-rd-"));
  try {
    seedTranscript(runDir, "run_b4", { messages: ["FINAL"], terminal: true, workspaceCwd: dir });
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_await_result", arguments: { runId: "run_b4", waitMs: 0 } });
      assert.equal(res.isError, undefined);
      assert.equal(res.structuredContent.observationOutcome, "observed");
      assert.equal(res.structuredContent.readFailureReason, null,
        "successful outcomes carry null — never a fabricated reason");
      assert.equal(res.structuredContent.result.status, "available");
    } finally { await client.close(); await server.close(); }
  } finally { rmrfRetry(dir); rmrfRetry(runDir); }
});

// =====================================================================
// Section D — MCP adapter cross-field truth boundary (FR-08 correction).
// The adapter must NEVER silently coerce a missing/invalid service reason to
// null. Before publishing structured content it enforces the cross-field
// invariant:
//   observationOutcome==="observed"     ⇔ readFailureReason===null
//   observationOutcome==="read_failure" ⇔ readFailureReason∈READ_FAILURE_REASONS
// An injected/malformed service result violating either direction must become
// the existing fixed opaque `run_await_result failed` MCP error — no
// structuredContent, no dynamic leakage. (The prior candidate coerced
// invalid reasons to null, which turned an injected read_failure into a
// valid-looking observed-style pair — this section pins that closed.)
// =====================================================================

// High-entropy sentinel: if ANY injected detail reaches the client, this exact
// string appears in the serialized response and the test fails.
const INJECTED_SENTINEL = "SENTINEL_fr08_leak_probe_7f3ac9";

// A service-shaped run_await_result result carrying the FR-08 violation under
// test. `omitReason` removes the readFailureReason key entirely (undefined is
// neither null nor a closed-set member — a missing key is NOT an observed
// null). All other fields are schema-valid so ONLY the cross-field violation
// can trigger the opaque error.
function injectedAwaitResult({ outcome, reason, omitReason = false }) {
  const out = {
    runId: "run_inj",
    agentId: "coder_low",
    state: "running",
    terminal: false,
    cursor: 3,
    returnedEarly: false,
    waitedMs: 0,
    observationOutcome: outcome,
    liveness: "unknown",
    activityEventCount: null,
    lastActivityKind: null,
    ownerHeartbeat: "unknown",
    result: {
      status: "unavailable", messages: [], evidenceCounts: null, itemCount: null,
      assistantMessageCount: null, reconstructed: null, backend: null,
    },
  };
  if (!omitReason) out.readFailureReason = reason;
  return out;
}

// Prove the three required properties on one injected call: fixed opaque
// failure, no structuredContent, and no injected sentinel leak.
async function assertOpaqueFailure(client, runId) {
  const res = await client.callTool({ name: "run_await_result", arguments: { runId, waitMs: 0 } });
  const dumped = JSON.stringify(res);
  assert.equal(res.isError, true, "violating service result must be an MCP error response");
  assert.ok(dumped.includes("run_await_result failed"), "fixed opaque error text");
  assert.ok(!res.structuredContent, "no partial structured content on a violating result");
  assert.ok(!dumped.includes(INJECTED_SENTINEL),
    "injected sentinel never leaks into the response");
  return res;
}

test("FR-08-D1: injected read_failure + null reason → fixed opaque error (never coerced into a valid observed-style pair)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-fr08-d1-"));
  makeGitRepo(dir);
  try {
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      runAwaitResultFn: async () => injectedAwaitResult({ outcome: "read_failure", reason: null }),
    });
    const client = await buildClient(server);
    try {
      await assertOpaqueFailure(client, "run_inj");
    } finally { await client.close(); await server.close(); }
  } finally { rmrfRetry(dir); }
});

test("FR-08-D2: injected read_failure + unknown string reason → fixed opaque error (closed-set only, sentinel never passes)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-fr08-d2-"));
  makeGitRepo(dir);
  try {
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      runAwaitResultFn: async () => injectedAwaitResult({ outcome: "read_failure", reason: INJECTED_SENTINEL }),
    });
    const client = await buildClient(server);
    try {
      await assertOpaqueFailure(client, "run_inj");
    } finally { await client.close(); await server.close(); }
  } finally { rmrfRetry(dir); }
});

test("FR-08-D3: injected observed + non-null reason → fixed opaque error (a clean read never carries a fabricated reason)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-fr08-d3-"));
  makeGitRepo(dir);
  try {
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      runAwaitResultFn: async () => injectedAwaitResult({ outcome: "observed", reason: "transcript_parse_failed" }),
    });
    const client = await buildClient(server);
    try {
      await assertOpaqueFailure(client, "run_inj");
    } finally { await client.close(); await server.close(); }
  } finally { rmrfRetry(dir); }
});

test("FR-08-D4: injected missing readFailureReason → fixed opaque error (absent key is neither null nor a closed-set member)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-fr08-d4-"));
  makeGitRepo(dir);
  try {
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      runAwaitResultFn: async () => injectedAwaitResult({ outcome: "read_failure", reason: INJECTED_SENTINEL, omitReason: true }),
    });
    const client = await buildClient(server);
    try {
      await assertOpaqueFailure(client, "run_inj");
    } finally { await client.close(); await server.close(); }
  } finally { rmrfRetry(dir); }
});

// =====================================================================
// Section C — already-closed attachments (verified WITHOUT code change).
// These pin the FR-08 boundary in this focused suite: FR-07 structured
// decision rejection, FR-03/04/08C structured packaging failure, and the
// fixed-opaque-error boundary for unexpected internal exceptions.
// =====================================================================

test("FR-08-C1 attachment: run_delivery_decide verification rejection is ALREADY structured (FR-07 closed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-fr08-c1-"));
  try {
    // The durable gate throws the dedicated policy error type; the MCP adapter
    // must map it to a structured outcome with the closed-set rejectionReason —
    // never an MCP error, never raw gate text.
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      decideRunDeliveryFn: async () => {
        throw new DeliveryDecisionPolicyError(
          "verification_failed",
          "Cannot accept: delivery verification is pending, must be passed",
        );
      },
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({
        name: "run_delivery_decide",
        arguments: { runId: "run_x", decision: "accepted", reason: "looks good" },
      });
      assert.equal(res.isError, undefined, "policy rejection is NOT an MCP error");
      const parsed = res.structuredContent;
      assert.equal(parsed.decisionAccepted, false);
      assert.equal(parsed.rejectionReason, "verification_failed", "closed-set machine code");
      assert.equal(parsed.deliveryCommit, null);
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes("pending") && !dumped.includes("Cannot accept"),
        "no raw gate message leaks");
    } finally { await client.close(); await server.close(); }
  } finally { rmrfRetry(dir); }
});

test("FR-08-C2 attachment: run_delivery packaging failure is ALREADY structured (FR-03/04/08C closed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-fr08-c2-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-fr08-c2-rd-"));
  try {
    const a = "coder_hq", id = "run_c2";
    const lines = [
      jl({ type: "run.started", backend: "claude-code", cwd: "/p", delivery: { mode: "git_commit_v1", baseCommit: "a".repeat(40), allowedPaths: ["src"] }, ts: "2026-07-24T20:00:00.000Z", runId: id, agentId: a, seq: 1 }),
      jl({ type: "run.state_change", from: "pending", to: "submitted", reason: "spawned", ts: "2026-07-24T20:00:01.000Z", runId: id, agentId: a, seq: 2 }),
      jl({ type: "run.state_change", from: "submitted", to: "completed", reason: "done", ts: "2026-07-24T20:30:00.000Z", runId: id, agentId: a, seq: 3 }),
      jl({ type: "run.completed", backendSessionId: "s1", messageCount: 1, ts: "2026-07-24T20:30:00.100Z", runId: id, agentId: a, seq: 4 }),
      jl({ type: "run.delivery_failed", deliveryCode: "base_commit_mismatch", message: "delivery packaging error", ts: "2026-07-24T20:30:01.000Z", runId: id, agentId: a, seq: 5 }),
    ];
    writeFileSync(join(runDir, `${id}.jsonl`), lines.join(""), "utf8");
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_delivery", arguments: { runId: id } });
      assert.equal(res.isError, undefined, "packaging failure is NOT an MCP error");
      const parsed = res.structuredContent;
      assert.equal(parsed.deliveryAvailable, false);
      assert.ok(parsed.deliveryFailure, "structured deliveryFailure present");
      assert.equal(parsed.deliveryFailure.code, "base_commit_mismatch",
        "closed-set packaging code projected (workdir/base failure)");
      assert.equal(parsed.baseCommit, null);
      assert.equal(parsed.deliveryCommit, null);
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes("delivery packaging error"), "raw failure message never leaks");
    } finally { await client.close(); await server.close(); }
  } finally { rmrfRetry(dir); rmrfRetry(runDir); }
});

test("FR-08-C3 attachment: unexpected internal exceptions stay fixed opaque MCP errors (no leak)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-fr08-c3-"));
    makeGitRepo(dir);
  try {
    const secret = "AKIAIOSFODNN7EXAMPLE"; // AWS docs example, not a live key
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      runAwaitResultFn: async () => {
        throw new Error(`internal boom ${secret} C:\\Users\\secret\\key.pem PID=4242`);
      },
      decideRunDeliveryFn: async () => {
        throw new Error(`internal boom ${secret} C:\\Users\\secret\\key.pem PID=4242`);
      },
    });
    const client = await buildClient(server);
    try {
      const awaitRes = await client.callTool({ name: "run_await_result", arguments: { runId: "run_x", waitMs: 0 } });
      const awaitDump = JSON.stringify(awaitRes);
      assert.ok(awaitDump.includes("run_await_result failed"), "fixed opaque text");
      assert.ok(!awaitDump.includes(secret) && !awaitDump.includes("key.pem") && !awaitDump.includes("4242"),
        "run_await_result internal exception: nothing leaks");
      assert.ok(!awaitRes.structuredContent, "no partial structured content");

      const decideRes = await client.callTool({
        name: "run_delivery_decide",
        arguments: { runId: "run_x", decision: "accepted", reason: "r" },
      });
      const decideDump = JSON.stringify(decideRes);
      assert.ok(decideDump.includes("run_delivery_decide failed"), "fixed opaque text");
      assert.ok(!decideDump.includes(secret) && !decideDump.includes("key.pem") && !decideDump.includes("4242"),
        "run_delivery_decide internal exception: nothing leaks");
    } finally { await client.close(); await server.close(); }
  } finally { rmrfRetry(dir); }
});
