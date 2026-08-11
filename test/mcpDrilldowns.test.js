// test/mcpDrilldowns.test.js
//
// M12-8B: bounded Lead progressive-disclosure metadata — MCP wiring TDD
// RED→GREEN. The REQUIRED `availableDrilldowns` field must appear on EXACTLY
// seven tools: run_wait, run_await_result, run_status, run_diagnose,
// run_collect, run_delivery, run_activity — with the exact bounded entry shape
// { tool, view, detail, purpose, reveals, cost, readOnly }, at most 4 entries,
// readOnly the truthful boolean (false for run_collect's audit-appending
// entries, true otherwise), no mutation tools, no behavior change to any
// existing output field, and no extra transcript appends (run_collect still
// appends exactly one messages.collected on success; the six read-only tools
// append zero). The run_delivery_review_bundle output keeps its established
// nested delivery contract and never acquires the field.
//
// Delivery/diagnosis cases use the DI fakes (getRunDeliveryFn /
// getRunDiagnosisFn) so the drilldown projection is the causal subject; the
// other five tools run through the REAL services against seeded transcripts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

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

function seedTranscript(runDir, runId, { agentId = "coder_low", messages = [], terminal = false, workspaceCwd, extraLines = [] } = {}) {
  mkdirSync(runDir, { recursive: true });
  const lines = [
    jl({ type: "run.submitted", agentId, ts: "2026-07-28T00:00:00.000Z", runId }),
    jl({ type: "session.created", backend: "process", backendSessionId: "proc_drill", runId, agentId }),
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
  for (const l of extraLines) lines.push(l);
  if (terminal) {
    lines.push(jl({ type: "run.completed", ts: "2026-07-28T00:10:00.000Z", runId, agentId }));
    lines.push(jl({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-07-28T00:10:01.000Z", runId, agentId }));
  }
  writeFileSync(join(runDir, `${runId}.jsonl`), lines.join(""), "utf8");
}

function countAudits(transcriptPath) {
  try {
    return readFileSync(transcriptPath, "utf8").trim().split("\n")
      .filter((l) => l.includes('"messages.collected"')).length;
  } catch { return 0; }
}

async function buildClient(server) {
  const [c1, s1] = InMemoryTransport.createLinkedPair();
  await server.connect(s1);
  const client = new Client({ name: "test", version: "0" }, { version: "0" });
  await client.connect(c1);
  return client;
}

const SEVEN_KEYS = ["cost", "detail", "purpose", "readOnly", "reveals", "tool", "view"];

// =====================================================================
// 1. All seven output schemas expose the exact bounded metadata.
// =====================================================================

test("MD-01: seven output schemas REQUIRE availableDrilldowns with the exact bounded shape; the bundle never acquires it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-md01-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      const SEVEN = ["run_wait", "run_await_result", "run_status", "run_diagnose", "run_collect", "run_delivery", "run_activity"];
      for (const name of SEVEN) {
        const t = tools.tools.find((x) => x.name === name);
        assert.ok(t, `${name} discoverable`);
        const props = t.outputSchema.properties ?? {};
        const dd = props.availableDrilldowns;
        assert.ok(dd, `${name} output schema exposes availableDrilldowns`);
        assert.ok(Array.isArray(t.outputSchema.required) && t.outputSchema.required.includes("availableDrilldowns"),
          `${name} output schema REQUIRES availableDrilldowns`);
        assert.equal(dd.type, "array", `${name} availableDrilldowns is an array`);
        assert.equal(dd.minItems, 1, `${name} availableDrilldowns minItems is 1 (every selector yields >=1)`);
        assert.equal(dd.maxItems, 4, `${name} availableDrilldowns maxItems is 4`);
        const items = dd.items ?? {};
        assert.equal(items.additionalProperties, false, `${name} entry schema is strict`);
        assert.deepEqual(Object.keys(items.properties ?? {}).sort(), SEVEN_KEYS,
          `${name} entry schema has exactly the seven keys`);
        assert.deepEqual([...(items.required ?? [])].sort(), SEVEN_KEYS,
          `${name} entry schema requires all seven keys`);
        assert.deepEqual([...(items.properties.tool.enum ?? [])].sort(),
          ["run_activity", "run_collect", "run_delivery", "run_delivery_review", "run_diagnose", "run_status"].sort(),
          `${name} tool enum is the closed observation set (no control tools)`);
        assert.deepEqual([...(items.properties.view.enum ?? [])].sort(),
          ["compact", "delivery", "diagnosis", "evidence", "timeline"].sort(),
          `${name} view enum is the closed five`);
        assert.deepEqual([...(items.properties.cost.enum ?? [])].sort(),
          ["high", "low", "medium"].sort(),
          `${name} cost enum is the closed three`);
        const ro = items.properties.readOnly;
        assert.equal(ro.type, "boolean", `${name} readOnly is a boolean contract (not literal true)`);
      }
      // run_diagnose output is strict (trust boundary): any unknown field at
      // the top level collapses the response to the fixed safe error.
      const diagTool = tools.tools.find((x) => x.name === "run_diagnose");
      assert.equal(diagTool.outputSchema.additionalProperties, false,
        "run_diagnose output schema is strict");
      // No OTHER tool may carry the field.
      for (const t of tools.tools) {
        if (SEVEN.includes(t.name)) continue;
        assert.equal(t.outputSchema?.properties?.availableDrilldowns, undefined,
          `${t.name} must NOT carry availableDrilldowns`);
      }
      // The run_delivery_review_bundle keeps its established nested delivery
      // contract: neither the bundle top level nor its nested delivery schema
      // may carry or require the progressive-disclosure field.
      const bundle = tools.tools.find((x) => x.name === "run_delivery_review_bundle");
      assert.ok(bundle, "bundle discoverable");
      assert.equal(bundle.outputSchema?.properties?.availableDrilldowns, undefined,
        "bundle top level must NOT carry availableDrilldowns");
      assert.ok(!(bundle.outputSchema?.required ?? []).includes("availableDrilldowns"),
        "bundle top level must NOT require availableDrilldowns");
      const nested = bundle.outputSchema?.properties?.delivery ?? {};
      assert.equal(nested.properties?.availableDrilldowns, undefined,
        "bundle nested delivery must NOT carry availableDrilldowns");
      assert.ok(!(nested.required ?? []).includes("availableDrilldowns"),
        "bundle nested delivery must NOT require availableDrilldowns");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// =====================================================================
// 2. Seven handlers return parsed output WITH metadata, legacy fields intact.
// =====================================================================

test("MD-02: run_status returns availableDrilldowns; legacy fields unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-md02-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-md02-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_s", { workspaceCwd: dir, messages: ["hi"], terminal: false });
    const tp = join(runDir, "run_s.jsonl");
    const before = readFileSync(tp, "utf8");
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_status", arguments: { runId: "run_s" } });
      assert.equal(res.isError, undefined);
      const parsed = res.structuredContent;
      // Legacy fields preserved exactly (M12-17 added executionStage — the
      // closed-set submitted-stage projection, additive).
      assert.deepEqual(Object.keys(parsed).sort(),
        ["agentId", "availableDrilldowns", "executionStage", "lastActivity", "lastEvent", "runId", "state", "terminal"].sort());
      assert.equal(parsed.runId, "run_s");
      assert.equal(parsed.state, "running");
      assert.equal(parsed.terminal, false);
      // M12-17: run_s has a run.event message at 00:00:10 → active, sinceTs exact.
      assert.equal(parsed.executionStage.phase, "active", "run_s projects active (first run.event)");
      assert.equal(parsed.executionStage.sinceTs, "2026-07-28T00:00:10.000Z", "sinceTs = first run.event ts");
      assert.ok(parsed.lastEvent && typeof parsed.lastEvent.type === "string", "lastEvent intact");
      assert.ok(parsed.lastActivity && typeof parsed.lastActivity.kind === "string", "lastActivity intact");
      assert.equal(parsed.agentId, "coder_low", "agentId intact");
      // Metadata: non-terminal → activity choice (the status tool itself is
      // not re-advertised).
      assert.deepEqual(parsed.availableDrilldowns.map((e) => e.tool), ["run_activity"]);
      // run_status appends nothing → its drilldown entries are readOnly:true.
      for (const e of parsed.availableDrilldowns) {
        assert.equal(e.readOnly, true, "run_status drilldown entries report readOnly:true");
      }
    } finally { await client.close(); await server.close(); }
    assert.equal(readFileSync(tp, "utf8"), before, "run_status appends NOTHING");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("MD-03: run_status on a failed terminal run advertises diagnosis + activity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-md03-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-md03-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_f", {
      workspaceCwd: dir, messages: [],
      extraLines: [
        jl({ type: "run.error", ts: "2026-07-28T00:05:00.000Z", runId: "run_f", agentId: "coder_low" }),
        jl({ type: "run.state_change", to: "failed", reason: "error", ts: "2026-07-28T00:05:01.000Z", runId: "run_f", agentId: "coder_low" }),
      ],
    });
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_status", arguments: { runId: "run_f" } });
      assert.equal(res.isError, undefined);
      const parsed = res.structuredContent;
      assert.equal(parsed.state, "failed");
      assert.equal(parsed.terminal, true);
      assert.deepEqual(parsed.availableDrilldowns.map((e) => e.tool), ["run_diagnose", "run_activity"]);
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("MD-04: run_await_result — terminal compact → activity+full collect; non-terminal → status+activity; read_failure → status+activity; ZERO append", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-md04-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-md04-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_t", { workspaceCwd: dir, messages: ["draft", "FINAL"], terminal: true });
    seedTranscript(runDir, "run_nt", { workspaceCwd: dir, messages: [], terminal: false });
    // read-failure: JSON-valid but non-usable transcript lines (same shape as
    // MAR-16 — the workspace binding + durable state come from the usable
    // subset, the corrupt lines come after).
    writeFileSync(join(runDir, "run_rf.jsonl"),
      jl({ type: "run.submitted", agentId: "coder_low", ts: "2026-07-28T00:00:00.000Z", runId: "run_rf" })
      + jl({ type: "session.created", backend: "process", backendSessionId: "proc_drill", runId: "run_rf", agentId: "coder_low" })
      + jl({ type: "run.background_submitted", background: true, cwd: dir, runId: "run_rf", agentId: "coder_low" })
      + jl({ type: "run.state_change", to: "running", reason: "first_event", ts: "2026-07-28T00:00:03.000Z", runId: "run_rf", agentId: "coder_low" })
      + "null\n42\n[1,2,3]\n", "utf8");
    const tp = join(runDir, "run_t.jsonl");
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const t = await client.callTool({ name: "run_await_result", arguments: { runId: "run_t", waitMs: 0 } });
      assert.equal(t.isError, undefined);
      assert.equal(t.structuredContent.result.status, "available");
      assert.deepEqual(t.structuredContent.availableDrilldowns.map((e) => e.tool), ["run_activity", "run_collect"]);

      const nt = await client.callTool({ name: "run_await_result", arguments: { runId: "run_nt", waitMs: 0 } });
      assert.equal(nt.structuredContent.result.status, "not_terminal");
      assert.deepEqual(nt.structuredContent.availableDrilldowns.map((e) => e.tool), ["run_status", "run_activity"]);

      const rf = await client.callTool({ name: "run_await_result", arguments: { runId: "run_rf", waitMs: 0 } });
      assert.equal(rf.structuredContent.observationOutcome, "read_failure");
      assert.equal(rf.structuredContent.result.status, "unavailable");
      assert.deepEqual(rf.structuredContent.availableDrilldowns.map((e) => e.tool), ["run_status", "run_activity"]);
    } finally { await client.close(); await server.close(); }
    assert.equal(countAudits(tp), 0, "run_await_result must NOT append messages.collected");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("MD-05: run_await_result too_large → full collect primary; empty → activity only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-md05-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-md05-rd-"));
  try {
    makeGitRepo(dir);
    // too_large: last assistant text > 4000 chars (compact cap).
    seedTranscript(runDir, "run_big", { workspaceCwd: dir, messages: ["x".repeat(4100)], terminal: true });
    seedTranscript(runDir, "run_empty", { workspaceCwd: dir, messages: [], terminal: true });
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const big = await client.callTool({ name: "run_await_result", arguments: { runId: "run_big", waitMs: 0 } });
      assert.equal(big.structuredContent.result.status, "too_large");
      assert.deepEqual(big.structuredContent.availableDrilldowns.map((e) => e.tool), ["run_collect", "run_activity"]);

      const empty = await client.callTool({ name: "run_await_result", arguments: { runId: "run_empty", waitMs: 0 } });
      assert.equal(empty.structuredContent.result.status, "empty");
      assert.deepEqual(empty.structuredContent.availableDrilldowns.map((e) => e.tool), ["run_activity"]);
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("MD-06: run_diagnose — delivery_packaging_failed → delivery+activity; provider_auth → activity+collect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-md06-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      getRunDiagnosisFn: async () => ({
        runId: "run_x", state: "failed", terminal: true,
        category: "delivery_packaging_failed", code: null, evidence: [],
      }),
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_diagnose", arguments: { runId: "run_x" } });
      assert.equal(res.isError, undefined);
      const parsed = res.structuredContent;
      assert.equal(parsed.category, "delivery_packaging_failed");
      assert.deepEqual(parsed.availableDrilldowns.map((e) => e.tool), ["run_delivery", "run_activity"]);
      // Legacy fields intact.
      for (const k of ["runId", "state", "terminal", "code", "signalEventTypes", "signalCount", "signalsTruncated"]) {
        assert.ok(k in parsed, `legacy run_diagnose field ${k} present`);
      }
    } finally { await client.close(); await server.close(); }
    const server2 = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      getRunDiagnosisFn: async () => ({
        runId: "run_y", state: "failed", terminal: true,
        category: "provider_auth", code: "unauthorized", evidence: [],
      }),
    });
    const client2 = await buildClient(server2);
    try {
      const res2 = await client2.callTool({ name: "run_diagnose", arguments: { runId: "run_y" } });
      assert.deepEqual(res2.structuredContent.availableDrilldowns.map((e) => e.tool), ["run_activity", "run_collect"]);
    } finally { await client2.close(); await server2.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MD-07: run_collect — full page with cursor → continue+activity; compact available → full collect+activity; still exactly ONE append", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-md07-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-md07-rd-"));
  try {
    makeGitRepo(dir);
    // 55 assistant messages > COLLECT_LIMIT (50) → page 1 is truncated with a
    // nextCursor; a continuation entry must be advertised.
    const messages = Array.from({ length: 55 }, (_, i) => `m-${i}`);
    seedTranscript(runDir, "run_c", { workspaceCwd: dir, messages, terminal: true });
    const tp = join(runDir, "run_c.jsonl");
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      // Full page 1 (12 messages → paginated, cursor present).
      const full = await client.callTool({ name: "run_collect", arguments: { runId: "run_c" } });
      assert.equal(full.isError, undefined);
      assert.ok(full.structuredContent.nextCursor, "page 1 has a cursor");
      assert.equal(full.structuredContent.view, undefined, "full output carries no view field");
      assert.deepEqual(full.structuredContent.availableDrilldowns.map((e) => e.tool), ["run_collect", "run_activity"]);
      const cont = full.structuredContent.availableDrilldowns[0];
      assert.equal(cont.view, "evidence", "continuation entry is the evidence view");

      // Compact mode → full collect + activity.
      const compact = await client.callTool({ name: "run_collect", arguments: { runId: "run_c", mode: "compact" } });
      assert.equal(compact.isError, undefined);
      assert.equal(compact.structuredContent.view, "compact");
      assert.equal(compact.structuredContent.compactStatus, "available");
      assert.deepEqual(compact.structuredContent.availableDrilldowns.map((e) => e.tool), ["run_collect", "run_activity"]);
      assert.equal(compact.structuredContent.availableDrilldowns[0].view, "evidence", "compact advertises the full read");
      // run_collect appends one messages.collected audit per successful call →
      // every run_collect entry it advertises reports readOnly:false (truthful
      // boolean, matching readOnlyHint:false / idempotentHint:false); the
      // co-advertised run_activity entry stays readOnly:true.
      for (const e of [...full.structuredContent.availableDrilldowns, ...compact.structuredContent.availableDrilldowns]) {
        assert.equal(e.readOnly, e.tool === "run_collect" ? false : true,
          `${e.tool} entry readOnly must match the real tool's readOnly semantics`);
      }

      // A completed single-page full read (≤50 items) → activity only.
      seedTranscript(runDir, "run_one", { workspaceCwd: dir, messages: ["only"], terminal: true });
      const done = await client.callTool({ name: "run_collect", arguments: { runId: "run_one" } });
      assert.equal(done.structuredContent.nextCursor, null);
      assert.deepEqual(done.structuredContent.availableDrilldowns.map((e) => e.tool), ["run_activity"]);
    } finally { await client.close(); await server.close(); }
    assert.equal(countAudits(tp), 2, "two successful run_collect calls on run_c → exactly ONE append each = 2 total");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("MD-08: run_delivery — reviewable → delivery_review+activity; packaging failed → activity+diagnose; not requested → activity+status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-md08-"));
  try {
    makeGitRepo(dir);
    const mk = (view) => createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      getRunDeliveryFn: async () => view,
    });

    // Reviewable: passed verification, acceptance pending. (The service view
    // carries verification/acceptance at TOP level — buildRunDeliveryPayload
    // reads view.verification / view.acceptance, not inside deliveryRef.)
    const s1 = mk({
      runId: "run_a", terminalState: "completed",
      deliveryRef: {
        deliveryCommit: "d".repeat(40), baseCommit: "b".repeat(40),
        changedFiles: ["src/a.js"],
      },
      verification: { status: "passed" },
      acceptance: { status: "pending" },
    });
    const c1 = await buildClient(s1);
    try {
      const res = await c1.callTool({ name: "run_delivery", arguments: { runId: "run_a" } });
      assert.equal(res.isError, undefined);
      const parsed = res.structuredContent;
      assert.equal(parsed.deliveryAvailable, true);
      assert.deepEqual(parsed.availableDrilldowns.map((e) => e.tool), ["run_delivery_review", "run_activity"]);
      // run_delivery / run_delivery_review append nothing → readOnly:true.
      for (const e of parsed.availableDrilldowns) {
        assert.equal(e.readOnly, true, "run_delivery drilldown entries report readOnly:true");
      }
      // Legacy fields intact.
      for (const k of ["baseCommit", "deliveryCommit", "changedFileCount", "changedPaths", "verificationStatus", "acceptanceStatus", "deliveryFailure", "candidateInventory", "candidateKind"]) {
        assert.ok(k in parsed, `legacy run_delivery field ${k} present`);
      }
      assert.equal(parsed.verificationStatus, "passed", "legacy verificationStatus intact");
    } finally { await c1.close(); await s1.close(); }

    // Packaging failure: deliveryAvailable false + closed-set code.
    const s2 = mk({
      runId: "run_b", terminalState: "failed", deliveryAvailable: false,
      deliveryRequested: true, deliveryFailure: { code: "commit_failed" },
    });
    const c2 = await buildClient(s2);
    try {
      const res = await c2.callTool({ name: "run_delivery", arguments: { runId: "run_b" } });
      const parsed = res.structuredContent;
      assert.equal(parsed.deliveryAvailable, false);
      assert.equal(parsed.deliveryFailure.code, "commit_failed");
      assert.deepEqual(parsed.availableDrilldowns.map((e) => e.tool), ["run_activity", "run_diagnose"]);
    } finally { await c2.close(); await s2.close(); }

    // Not requested: deliveryAvailable false, deliveryRequested false, no failure.
    const s3 = mk({
      runId: "run_c", terminalState: "running", deliveryAvailable: false,
      deliveryRequested: false, deliveryFailure: null,
    });
    const c3 = await buildClient(s3);
    try {
      const res = await c3.callTool({ name: "run_delivery", arguments: { runId: "run_c" } });
      const parsed = res.structuredContent;
      assert.equal(parsed.deliveryAvailable, false);
      assert.equal(parsed.deliveryFailure, null);
      assert.deepEqual(parsed.availableDrilldowns.map((e) => e.tool), ["run_activity", "run_status"]);
    } finally { await c3.close(); await s3.close(); }

    // WAIT path (waitMs): the readiness handshake payload must carry the same
    // bounded metadata. reviewable → delivery review + activity.
    const s4 = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      getRunDeliveryReadinessFn: async () => ({
        runId: "run_w", terminalState: "completed", deliveryAvailable: true,
        deliveryRef: {
          deliveryCommit: "e".repeat(40), baseCommit: "f".repeat(40),
          changedFiles: ["src/b.js"],
        },
        verification: { status: "passed" },
        acceptance: { status: "pending" },
        readiness: "reviewable", waitReturnedEarly: true,
      }),
    });
    const c4 = await buildClient(s4);
    try {
      const res = await c4.callTool({ name: "run_delivery", arguments: { runId: "run_w", waitMs: 1000 } });
      assert.equal(res.isError, undefined);
      const parsed = res.structuredContent;
      assert.equal(parsed.readiness, "reviewable");
      assert.equal(parsed.waitReturnedEarly, true);
      assert.deepEqual(parsed.availableDrilldowns.map((e) => e.tool), ["run_delivery_review", "run_activity"]);
    } finally { await c4.close(); await s4.close(); }

    // WAIT path settled as packaging_failed → activity + diagnosis.
    const s5 = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      getRunDeliveryReadinessFn: async () => ({
        runId: "run_w2", terminalState: "failed", deliveryAvailable: false,
        deliveryRequested: true, deliveryFailure: null,
        readiness: "packaging_failed", waitReturnedEarly: true,
      }),
    });
    const c5 = await buildClient(s5);
    try {
      const res = await c5.callTool({ name: "run_delivery", arguments: { runId: "run_w2", waitMs: 1000 } });
      assert.equal(res.isError, undefined);
      const parsed = res.structuredContent;
      assert.equal(parsed.readiness, "packaging_failed");
      assert.deepEqual(parsed.availableDrilldowns.map((e) => e.tool), ["run_activity", "run_diagnose"]);
    } finally { await c5.close(); await s5.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MD-09: run_activity — terminal → compact collect; non-terminal → status; continuation → same-tool continue; ZERO append", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-md09-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-md09-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_a", {
      workspaceCwd: dir, messages: ["a", "b"],
      extraLines: [jl({ type: "run.event", kind: "command", command: "pwd", exitCode: 0, runId: "run_a", agentId: "coder_low" })],
      terminal: true,
    });
    seedTranscript(runDir, "run_na", { workspaceCwd: dir, messages: ["x"], terminal: false });
    const tp = join(runDir, "run_a.jsonl");
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const t = await client.callTool({ name: "run_activity", arguments: { runId: "run_a", pageSize: 1 } });
      assert.equal(t.isError, undefined);
      assert.equal(t.structuredContent.terminal, true);
      assert.ok(t.structuredContent.nextCursor, "small pageSize leaves a cursor");
      assert.deepEqual(t.structuredContent.availableDrilldowns.map((e) => e.tool), ["run_activity"]);
      assert.equal(t.structuredContent.availableDrilldowns[0].detail.includes("continue"), true,
        "continuation entry tells the Lead how to continue");

      const done = await client.callTool({ name: "run_activity", arguments: { runId: "run_a" } });
      assert.equal(done.structuredContent.nextCursor, null);
      assert.deepEqual(done.structuredContent.availableDrilldowns.map((e) => e.tool), ["run_collect"]);

      const nt = await client.callTool({ name: "run_activity", arguments: { runId: "run_na" } });
      assert.equal(nt.structuredContent.terminal, false);
      assert.deepEqual(nt.structuredContent.availableDrilldowns.map((e) => e.tool), ["run_status"]);
    } finally { await client.close(); await server.close(); }
    assert.equal(countAudits(tp), 0, "run_activity must NOT append messages.collected");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("MD-10: drilldown metadata never triggers nested tool invocation or extra appends across all seven tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-md10-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-md10-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_all", { workspaceCwd: dir, messages: ["final"], terminal: true });
    const tp = join(runDir, "run_all.jsonl");
    const auditsBefore = countAudits(tp);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const calls = [
        { name: "run_status", arguments: { runId: "run_all" } },
        { name: "run_wait", arguments: { runId: "run_all", waitMs: 180000 } },
        { name: "run_diagnose", arguments: { runId: "run_all" } },
        { name: "run_await_result", arguments: { runId: "run_all", waitMs: 0 } },
        { name: "run_activity", arguments: { runId: "run_all" } },
      ];
      for (const call of calls) {
        const res = await client.callTool(call);
        assert.equal(res.isError, undefined, `${call.name} succeeds with drilldown metadata`);
        assert.ok(Array.isArray(res.structuredContent.availableDrilldowns),
          `${call.name} carries availableDrilldowns`);
        assert.ok(res.structuredContent.availableDrilldowns.length >= 1
          && res.structuredContent.availableDrilldowns.length <= 4,
          `${call.name} bounded drilldown count`);
      }
      // run_collect still appends exactly one (the metadata path adds none).
      const collect = await client.callTool({ name: "run_collect", arguments: { runId: "run_all" } });
      assert.equal(collect.isError, undefined);
      assert.ok(Array.isArray(collect.structuredContent.availableDrilldowns));
    } finally { await client.close(); await server.close(); }
    assert.equal(countAudits(tp), auditsBefore + 1,
      "only the single run_collect call appends; the metadata feature appends nothing");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("MD-12: run_diagnose trust boundary — an unknown/extra injected field collapses to the fixed safe error with no partial structuredContent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-md12-"));
  try {
    makeGitRepo(dir);
    // A hostile service result carrying an unknown extra field AND a category
    // outside the closed set. The handler's closed projection cannot echo the
    // extra field; the strict output schema rejects the out-of-set category
    // and the whole response collapses to the fixed safe error — never a
    // partial structuredContent, never a leak of the unknown field.
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: dir,
      getRunDiagnosisFn: async () => ({
        runId: "run_z", state: "failed", terminal: true,
        category: "not_a_closed_set_category", code: "unauthorized", evidence: [],
        leakedPath: "C:\\secret\\path", // unknown field on the service result
      }),
    });
    const client = await buildClient(server);
    try {
      const res = await client.callTool({ name: "run_diagnose", arguments: { runId: "run_z" } });
      assert.equal(res.isError, true, "unknown/extra field collapses to the fixed safe error");
      assert.equal(res.structuredContent, undefined, "no partial structuredContent");
      assert.equal(res.content?.[0]?.text, "run_diagnose failed", "fixed safe error text");
      assert.ok(!JSON.stringify(res.content).includes("secret"),
        "fixed error text must not leak the unknown field or path");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
