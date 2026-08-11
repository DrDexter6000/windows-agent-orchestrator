// test/m12-12-semantics-mcp.test.js
//
// M12-12 split — REAL MCP / RESOURCES / CROSS-FIELD / SMOKE slice (manifest
// category: mcp).
//
// This file was split out of test/m12-12-semantics.test.js at its existing
// section boundaries so the canonical wave's per-file process lifetime stays
// inside the SDK request budget under cross-file load. Every assertion is
// preserved verbatim; no test was added, removed, or relaxed.
//
// This slice carries:
//   M-*   REAL MCP handlers (all four) attach semanticNotes before parse; the
//         schema/catalog/resource parity; the review_bundle exclusion; the
//         run_diagnose trust boundary; unchanged 22-tool surface.
//   R-*   RESOURCES: wao://semantics summary + wao://semantics/{id} template;
//         NO per-id static resources; summary/detail parity with the SSOT;
//         unknown/malformed id → fixed safe text, never echoes the id.
//   X-*   Existing exact-key contracts unchanged (availableDrilldowns seven-key
//         coexists with semanticNotes three-key); descriptions carry the new
//         self-explain contract + the detail uri while preserving guarded words.
//   SM-*  Best-effort smoke against representative real transcript files
//         (read-only; skipped if none safely discoverable).
//
// The pure selector/catalog slice (S-*) lives in m12-12-semantics-catalog.test.js.
// This slice spins up the MCP server over an in-memory transport on isolated git
// fixtures. Runs in the dedicated serial mcp wave (mcp category, concurrency 1).

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
        // One bounded virtual interval: a single 180000ms tick advances the
        // virtual clock straight to the window deadline (was 90 × 2000ms re-reads).
        return runWait({ ...input, nowFn: () => clock, pollIntervalMs: 180000, sleepFn: async (ms) => { clock += ms; } });
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

test("M-10: unchanged 22-tool surface; all four tools carry semanticNotes; no extra tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1212-m10-"));
  try {
    makeGitRepo(dir);
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 22, "exactly 22 tools");
      const names = new Set(tools.tools.map((t) => t.name));
      assert.equal(names.size, 22, "22 distinct tool names");
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
