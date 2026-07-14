// test/mcpRunDiagnose.test.js
//
// M9-5B: MCP run_diagnose tool — TDD tests.
//
// Proves that an MCP host can diagnose a run via run_diagnose, which calls the
// M9-5A getRunDiagnosis() service and returns ONLY safe machine fields:
// category + signal event types (no raw fact/error/path/command/payload).
// No recommendation/advice/retry/nextStep.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createWaoMcpServer } from "../src/mcp/server.js";
import { DIAGNOSIS_CATEGORIES } from "../src/diagnosis.js";

// ===== Helpers =====

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-test-client", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// Raw evidence with sensitive content the MCP must NOT leak.
function sensitiveEvidenceResult() {
  return {
    runId: "run_x", state: "failed", terminal: true,
    category: "provider_auth",
    evidence: [
      { eventType: "run.error", fact: "401 unauthorized: AKIA-SECRET-TOKEN-m95b" },
      { eventType: "run.event", fact: "command: rm -rf C:\\Users\\leak\\secret" },
      { eventType: "run.event", fact: "tool input: {\"file_path\":\"/etc/passwd\"}" },
      { eventType: "run.event", fact: "prompt: do evil things" },
      { eventType: "run.error", fact: "stderr: connection reset by peer" },
    ],
  };
}

// ===== Tests =====

// ---------------------------------------------------------------------
// M9-5B-01: tools/list has all five tools + correct schema/annotations.
// ---------------------------------------------------------------------

test("M9-5B-01: tools/list has five tools, run_diagnose schema/annotations correct", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m95b-01-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    const server = createWaoMcpServer({ registryPath, runDir: dir });
    const client = await buildInMemoryClient(server);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      assert.deepEqual(names, ["registry_list", "run_collect", "run_diagnose", "run_dispatch", "run_status"]);

      const rd = tools.tools.find((t) => t.name === "run_diagnose");
      assert.deepEqual(Object.keys(rd.inputSchema.properties ?? {}), ["runId"], "input has only runId");
      assert.equal(rd.inputSchema.additionalProperties, false, "input strict");
      assert.equal(rd.annotations.readOnlyHint, true, "readOnlyHint:true");
      assert.equal(rd.annotations.destructiveHint, false, "destructiveHint:false");
      assert.equal(rd.annotations.idempotentHint, true, "idempotentHint:true");
      assert.equal(rd.annotations.openWorldHint, false, "openWorldHint:false");
      assert.ok(rd.outputSchema, "output schema declared");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-5B-02: fake service called once with server-owned runDir.
// ---------------------------------------------------------------------

test("M9-5B-02: run_diagnose calls service once with server-owned runDir", async () => {
  let callCount = 0;
  let captured = null;
  const fakeDiag = async (input) => {
    callCount += 1;
    captured = input;
    return { runId: input.runId, state: "failed", terminal: true, category: "unknown", evidence: [] };
  };
  const server = createWaoMcpServer({
    registryPath: "/server/r.json", runDir: "/server/runs",
    getRunDiagnosisFn: fakeDiag,
  });
  const client = await buildInMemoryClient(server);
  try {
    await client.callTool({ name: "run_diagnose", arguments: { runId: "run_abc" } });
    assert.equal(callCount, 1);
    assert.equal(captured.runDir, "/server/runs", "server-owned runDir");
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// M9-5B-03: safe output — only allowed fields, no raw evidence leak.
// ---------------------------------------------------------------------

test("M9-5B-03: output is safe projection, no raw fact/error/path/command leak", async () => {
  const server = createWaoMcpServer({
    registryPath: "/server/r.json", runDir: "/server/runs",
    getRunDiagnosisFn: async () => sensitiveEvidenceResult(),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_diagnose", arguments: { runId: "run_x" } });
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);

    const allowedKeys = new Set(["runId", "state", "terminal", "category", "signalEventTypes", "signalCount", "signalsTruncated"]);
    for (const k of Object.keys(parsed)) {
      assert.ok(allowedKeys.has(k), `unexpected key: ${k}`);
    }
    // signalEventTypes: only event type strings, no raw fact.
    assert.ok(Array.isArray(parsed.signalEventTypes), "signalEventTypes is array");
    for (const t of parsed.signalEventTypes) {
      assert.equal(typeof t, "string", "each signal type is string");
      assert.ok(t.length <= 64, "each type <= 64 chars");
    }
    assert.equal(parsed.signalCount, 5, "signalCount = original evidence count");
    assert.equal(parsed.signalsTruncated, false, "5 <= 8, not truncated");

    // No raw content leaks.
    const dumped = JSON.stringify(res);
    assert.ok(!dumped.includes("AKIA-SECRET"), "no secret leak");
    assert.ok(!dumped.includes("rm -rf"), "no command leak");
    assert.ok(!dumped.includes("C:\\\\Users"), "no path leak");
    assert.ok(!dumped.includes("/etc/passwd"), "no tool input leak");
    assert.ok(!dumped.includes("do evil"), "no prompt leak");
    assert.ok(!dumped.includes("connection reset"), "no stderr leak");
    assert.ok(!dumped.includes("\"fact\""), "no raw fact field");

    if (res.structuredContent) {
      assert.deepEqual(res.structuredContent, parsed, "structuredContent matches");
    }
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// M9-5B-04: category enum from DIAGNOSIS_CATEGORIES SSOT; all 12 pass schema.
// ---------------------------------------------------------------------

test("M9-5B-04: all 12 categories pass output schema", async () => {
  for (const category of DIAGNOSIS_CATEGORIES) {
    const server = createWaoMcpServer({
      registryPath: "/server/r.json", runDir: "/server/runs",
      getRunDiagnosisFn: async () => ({ runId: "r", state: "failed", terminal: true, category, evidence: [] }),
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_diagnose", arguments: { runId: "r" } });
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(parsed.category, category, `category ${category} round-trips`);
    } finally {
      await client.close();
      await server.close();
    }
  }
});

// ---------------------------------------------------------------------
// M9-5B-05: extra/control-plane args rejected, service count 0.
// ---------------------------------------------------------------------

test("M9-5B-05: control-plane args rejected, service not called", async () => {
  let callCount = 0;
  const fakeDiag = async () => { callCount += 1; return { runId: "r", state: "failed", terminal: true, category: "none", evidence: [] }; };
  const server = createWaoMcpServer({
    registryPath: "/server/r.json", runDir: "/server/runs", getRunDiagnosisFn: fakeDiag,
  });
  const client = await buildInMemoryClient(server);
  try {
    const badArgsList = [
      { runId: "r", runDir: "/attacker" },
      { runId: "r", raw: true },
      { runId: "r", includeEvidence: true },
      { runId: "r", recommend: true },
      { runId: "r", retry: true },
      { runId: "r", worker: "evil" },
      { runId: "r", strategy: "x" },
      { runId: "r", evil: true },
    ];
    for (const bad of badArgsList) {
      let rejected = false;
      let result = null;
      try { result = await client.callTool({ name: "run_diagnose", arguments: bad }); }
      catch { rejected = true; }
      if (!rejected) { assert.equal(result.isError, true, `rejected: ${JSON.stringify(Object.keys(bad))}`); rejected = true; }
      assert.ok(rejected);
    }
    assert.equal(callCount, 0, "service never called");
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// M9-5B-06: service error → fixed "run_diagnose failed".
// ---------------------------------------------------------------------

test("M9-5B-06: service error returns fixed safe text, no leak", async () => {
  const SECRET = "test-secret-diag-m95b06";
  const ABS = "C:\\Users\\leak\\diag.jsonl";
  const server = createWaoMcpServer({
    registryPath: "/server/r.json", runDir: "/server/runs",
    getRunDiagnosisFn: async () => { throw new Error(`diag crashed at ${ABS} key=${SECRET}`); },
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_diagnose", arguments: { runId: "r" } });
    assert.equal(res.isError, true);
    const dumped = JSON.stringify(res);
    assert.ok(!dumped.includes(SECRET), "no secret");
    assert.ok(!dumped.includes(ABS), "no path");
    assert.ok(!/output validation error/i.test(dumped), "no SDK validation error");
    const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
    assert.ok(/run_diagnose failed/.test(text), "fixed text");
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// M9-5B-07: >8 evidence → signalCount preserves total, signalEventTypes capped at 8, truncated=true.
// ---------------------------------------------------------------------

test("M9-5B-07: >8 evidence → truncated, signalEventTypes capped", async () => {
  const evidence = [];
  for (let i = 0; i < 12; i += 1) {
    evidence.push({ eventType: "run.event", fact: `redacted ${i}` });
  }
  const server = createWaoMcpServer({
    registryPath: "/server/r.json", runDir: "/server/runs",
    getRunDiagnosisFn: async () => ({ runId: "r", state: "failed", terminal: true, category: "unknown", evidence }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_diagnose", arguments: { runId: "r" } });
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.equal(parsed.signalCount, 12, "total preserved");
    assert.ok(parsed.signalEventTypes.length <= 8, "capped at 8");
    assert.equal(parsed.signalsTruncated, true, "truncated=true");
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// M9-5B-08: no recommendation/advice/retry/nextStep in output or description.
// ---------------------------------------------------------------------

test("M9-5B-08: no prescription fields in output or tool description", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m95b-08-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    const server = createWaoMcpServer({
      registryPath, runDir: dir,
      getRunDiagnosisFn: async () => ({ runId: "r", state: "failed", terminal: true, category: "crash", evidence: [{ eventType: "run.error", fact: "process exited" }] }),
    });
    const client = await buildInMemoryClient(server);
    try {
      const tools = await client.listTools();
      const rd = tools.tools.find((t) => t.name === "run_diagnose");
      const descDumped = JSON.stringify(rd.description ?? "");
      const res = await client.callTool({ name: "run_diagnose", arguments: { runId: "r" } });
      const outputDumped = JSON.stringify(res);
      for (const forbidden of ["recommendation", "advice", "suggest", "retry", "nextStep", "next_step", "应该", "建议", "换 worker", "重派"]) {
        assert.ok(!descDumped.toLowerCase().includes(forbidden.toLowerCase()), `description has no '${forbidden}'`);
        assert.ok(!outputDumped.toLowerCase().includes(forbidden.toLowerCase()), `output has no '${forbidden}'`);
      }
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// M9-5B-09: malformed eventType (paths/control chars/quotes/slashes) → "unknown".
//           CTO P1: the projection must use a conservative ASCII allowlist, not
//           just length checks. Paths, commands, control chars, or secrets in
//           eventType must NEVER reach the output.
// ---------------------------------------------------------------------------

test("M9-5B-09: malformed eventType values map to unknown (allowlist projection)", async () => {
  const maliciousTypes = [
    "C:\\Users\\owner\\secret.txt",
    "/home/owner/secret",
    "run.event\x00null",
    "run\tevent",
    "run\nevent",
    "run\"event",
    "run\\event",
    "run/event",
    "run:event",
    "rm -rf /",
    "AKIA-SECRET-TOKEN-malicious-type-with-secret-value",
    "x".repeat(65),
  ];
  const legitimateTypes = ["run.error", "run.event", "scorecard.checked"];

  const evidence = [];
  // Legitimate first so they fit within the 8-item cap.
  for (const t of legitimateTypes) evidence.push({ eventType: t, fact: "redacted" });
  for (const t of maliciousTypes) evidence.push({ eventType: t, fact: "redacted" });

  const server = createWaoMcpServer({
    registryPath: "/server/r.json", runDir: "/server/runs",
    getRunDiagnosisFn: async () => ({ runId: "r", state: "failed", terminal: true, category: "unknown", evidence }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_diagnose", arguments: { runId: "r" } });
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    const dumped = JSON.stringify(res);

    assert.equal(parsed.signalCount, 15, "signalCount = 15 (12 malicious + 3 legit)");

    for (const t of maliciousTypes) {
      const checkVal = t.replace(/[\x00-\x1f]/g, "");
      if (checkVal.length > 0) {
        assert.ok(!dumped.includes(checkVal), `malicious value must not leak: ${JSON.stringify(t)}`);
      }
    }
    assert.ok(!dumped.includes("secret.txt"), "no Windows path leak");
    assert.ok(!dumped.includes("/home/owner"), "no POSIX path leak");
    assert.ok(!dumped.includes("rm -rf"), "no command leak");
    assert.ok(!dumped.includes("AKIA-SECRET"), "no secret leak");

    assert.ok(parsed.signalEventTypes.includes("run.error"), "legitimate preserved");
    assert.ok(parsed.signalEventTypes.includes("run.event"), "legitimate preserved");
    assert.ok(parsed.signalEventTypes.includes("scorecard.checked"), "legitimate preserved");

    const unknownCount = parsed.signalEventTypes.filter((t) => t === "unknown").length;
    assert.ok(unknownCount > 0, "malicious types mapped to unknown");
  } finally {
    await client.close();
    await server.close();
  }
});
