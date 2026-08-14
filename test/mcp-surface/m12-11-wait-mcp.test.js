// test/m12-11-wait-mcp.test.js
//
// M12-11 split — REAL MCP + CROSS-FIELD slice (manifest category: mcp).
//
// This file was split out of test/m12-11-wait-semantics.test.js at its existing
// section boundaries so the canonical wave's per-file process lifetime stays
// inside the SDK request budget under cross-file load. Every assertion is
// preserved verbatim; no test was added, removed, or relaxed.
//
// This slice carries:
//   M-*   real MCP behavior for run_wait + run_await_result: output shape,
//         strict parsed boundary, and the descriptions' transport-recovery
//         contract.
//   X-*   cross-field invariants + cross-run contamination + backward compat
//         (X1-X4); the architecture-only X5 lives in m12-11-wait-projection.
//
// Spins up the MCP server over an in-memory transport on isolated git fixtures.
// Runs in the dedicated serial mcp wave (mcp category, concurrency 1).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { createWaoMcpServer } from "../../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { rmrfRetry } from "../_rmrfHelper.mjs";

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
        const { runWait } = await import("../../src/application/runWait.js");
        return runWait({
          // One bounded virtual interval: a single 180000ms tick advances the
          // virtual clock straight to the window deadline (was 90 × 2000ms re-reads).
          ...input, nowFn: () => clock, pollIntervalMs: 180000,
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
    const { readTranscript: readReal } = await import("../../src/transcript.js");
    let reads = 0;
    let clock = 1000000;
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir, workspaceRoot: dir,
      runWaitFn: async (input) => {
        const { runWait } = await import("../../src/application/runWait.js");
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
// Section X — cross-field invariants + backward compatibility (X1-X4).
// (X5, the architecture-only projector source check, lives in
// m12-11-wait-projection.test.js — it is pure and carries no MCP I/O.)
// =====================================================================

test("X1: terminal ⇒ outcome=terminal AND liveness=terminal AND termination non-null (run_wait + run_await_result)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1211-x1-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1211-x1-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_x1", { workspaceCwd: dir, messages: ["done"], terminal: "completed" });
    const { runWait, runAwaitResult: runAwait } = {
      ...(await import("../../src/application/runWait.js")),
      ...(await import("../../src/application/runAwaitResult.js")),
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
    const { runAwaitResult } = await import("../../src/application/runAwaitResult.js");
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
    const { runWait } = await import("../../src/application/runWait.js");
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
    const { runAwaitResult } = await import("../../src/application/runAwaitResult.js");
    const out = await runAwaitResult({ runId: "run_x4", runDir, waitMs: 0 });
    for (const k of ["runId", "agentId", "state", "terminal", "cursor", "returnedEarly",
      "waitedMs", "observationOutcome", "readFailureReason", "liveness", "activityEventCount",
      "lastActivityKind", "ownerHeartbeat", "result", "outcome"]) {
      assert.ok(k in out, `old field ${k} still present`);
    }
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});
