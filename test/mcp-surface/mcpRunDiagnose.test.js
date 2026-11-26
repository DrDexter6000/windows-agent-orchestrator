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
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { createWaoMcpServer } from "../../src/mcp/server.js";
import {
  DIAGNOSIS_CATEGORIES,
  ISOLATION_DESTINATIONS,
  ISOLATION_DISPLAY_PATH_MAX_CHARS,
  ISOLATION_VIOLATION_REASONS,
} from "../../src/diagnosis.js";

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
      assert.ok(names.includes("run_diagnose"), "run_diagnose present");

      const rd = tools.tools.find((t) => t.name === "run_diagnose");
      assert.deepEqual(Object.keys(rd.inputSchema.properties ?? {}), ["runId", "expectedWorkspaceRoot"], "input is runId + optional per-call target (batch 119)");
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

    // M12-6 FR-02: "code" (nullable closed-set provider diagnosis code) is a
    // legitimate output field; it is null here because the fixture is provider_auth
    // without a closed-set code, so the fail-closed projection nulls it.
    // M12-8B: availableDrilldowns added (bounded progressive-disclosure metadata).
    // M12-12: semanticNotes added (REQUIRED self-describing notes; see wao://semantics).
    const allowedKeys = new Set(["runId", "state", "terminal", "category", "code", "signalEventTypes", "signalCount", "signalsTruncated", "availableDrilldowns", "semanticNotes"]);
    assert.equal(parsed.code, null, "provider_auth without a closed-set code projects to null");
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
// M9-5B-04: every category from DIAGNOSIS_CATEGORIES SSOT passes schema.
// ---------------------------------------------------------------------

test("M9-5B-04: all diagnosis categories pass output schema", async () => {
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

test("M12-3-ISO-MCP: workdir_escape projects as one safe signal without path leakage", async () => {
  const leakedPath = "C:\\Users\\owner\\source-checkout\\escaped.js";
  const server = createWaoMcpServer({
    registryPath: "/server/r.json",
    runDir: "/server/runs",
    getRunDiagnosisFn: async () => ({
      runId: "run_m123",
      state: "failed",
      terminal: true,
      category: "workdir_escape",
      evidence: [{
        eventType: "run.isolation_violation",
        fact: `worker reported an escaped write at ${leakedPath}`,
      }],
    }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({
      name: "run_diagnose",
      arguments: { runId: "run_m123" },
    });
    assert.equal(res.isError, undefined);
    const parsed = JSON.parse(res.content.find((block) => block.type === "text").text);
    assert.equal(parsed.category, "workdir_escape");
    assert.equal(parsed.signalCount, 1);
    assert.equal(parsed.signalsTruncated, false);
    assert.deepEqual(parsed.signalEventTypes, ["run.isolation_violation"]);
    assert.ok(!JSON.stringify(res).includes(leakedPath));
    assert.ok(!JSON.stringify(res).includes("source-checkout"));
  } finally {
    await client.close();
    await server.close();
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
// M9-5B-09: malformed eventType values map to unknown (exact-set projection).
//           CTO P1/P1-rework: the projection must use the exact set of event
//           types diagnoseFailure can produce — NOT a character-class allowlist.
//           Each malicious vector is tested INDIVIDUALLY (single-item evidence)
//           so the assertion cannot be hidden by the 8-item cap.
// ---------------------------------------------------------------------------

test("M9-5B-09: each malicious eventType individually maps to unknown", async () => {
  const maliciousVectors = [
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
    "AKIAIOSFODNN7EXAMPLE",
    "x".repeat(65),
    "",
    "unknown_custom_type",
    "messages.collected",
  ];

  for (const bad of maliciousVectors) {
    const server = createWaoMcpServer({
      registryPath: "/server/r.json", runDir: "/server/runs",
      getRunDiagnosisFn: async () => ({
        runId: "r", state: "failed", terminal: true, category: "unknown",
        evidence: [{ eventType: bad, fact: "redacted" }],
      }),
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_diagnose", arguments: { runId: "r" } });
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      const dumped = JSON.stringify(res);

      // Single-item evidence, within the 8-item cap — no truncation to hide behind.
      assert.equal(parsed.signalCount, 1, `signalCount=1 for ${JSON.stringify(bad)}`);
      assert.equal(parsed.signalsTruncated, false, `not truncated for ${JSON.stringify(bad)}`);
      assert.deepEqual(parsed.signalEventTypes, ["unknown"],
        `malicious eventType must map to exactly ["unknown"]: ${JSON.stringify(bad)}`);

      // The raw value must not appear anywhere in the output.
      const checkVal = typeof bad === "string" ? bad.replace(/[\x00-\x1f]/g, "") : "";
      if (checkVal.length > 0 && checkVal !== "unknown") {
        assert.ok(!dumped.includes(checkVal),
          `raw malicious value must not appear in output: ${JSON.stringify(bad)}`);
      }
    } finally {
      await client.close();
      await server.close();
    }
  }
});

test("M9-5B-09b: each legitimate eventType passes through verbatim", async () => {
  const legitTypes = [
    "run.stop_requested", "run.aborted", "run.state_change", "run.error",
    "run.timed_out", "scorecard.checked", "run.evidence_audit", "run.event",
  ];
  // All 8 fit within the cap.
  const evidence = legitTypes.map((t) => ({ eventType: t, fact: "redacted" }));
  const server = createWaoMcpServer({
    registryPath: "/server/r.json", runDir: "/server/runs",
    getRunDiagnosisFn: async () => ({ runId: "r", state: "failed", terminal: true, category: "unknown", evidence }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_diagnose", arguments: { runId: "r" } });
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.equal(parsed.signalCount, 8);
    assert.equal(parsed.signalsTruncated, false);
    assert.deepEqual(parsed.signalEventTypes, legitTypes, "all legitimate types preserved verbatim");
  } finally {
    await client.close();
    await server.close();
  }
});

// =====================================================================
// M12-21: completed-empty truth — run_diagnose wire parity.
//
// The kernel SSOT (diagnoseFailure) projects a completed completion-with-no-
// usable-effect as { category:"no_effect", code:"completed_empty" }. Per the
// Lead M12-21 correction, the wire exposes BOTH the category AND the code:
// completed_empty is a Lead-visible machine fact derived from the single
// DIAGNOSIS_CODES SSOT (provider codes + completed_empty) with valid
// category-code pair checks. So run_diagnose returns category=no_effect,
// code=completed_empty — never a raw provider payload echo.
// =====================================================================

test("M12-21: run_diagnose exposes no_effect category AND completed_empty code on the wire", async () => {
  // Inject the kernel-level completed-empty diagnosis directly (what the real
  // diagnoseFailure produces for a completed-empty transcript).
  const server = createWaoMcpServer({
    registryPath: "/server/r.json", runDir: "/server/runs",
    getRunDiagnosisFn: async () => ({
      runId: "run_ce", state: "completed", terminal: true,
      category: "no_effect", code: "completed_empty",
      // The raw evidence FACT carries provider-shaped payload the handler must
      // strip — only its eventType is projected, never the fact text.
      evidence: [{ eventType: "run.state_change", fact: "RAW_PROVIDER_STDERR sk-leak-9f3a --prompt hidden-secret" }],
    }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_diagnose", arguments: { runId: "run_ce" } });
    assert.equal(res.isError, undefined, "completed-empty diagnosis is a valid wire value, not an error");
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    // Category AND code are both surfaced — a Lead must not mistake completed-empty
    // for a valid completion, and the closed-set code names the machine fact.
    assert.equal(parsed.category, "no_effect", "the no_effect category is exposed on the wire");
    assert.equal(parsed.code, "completed_empty", "completed_empty code is exposed on the wire (Lead-visible fact)");
    // The closed-set marker rides alone: the raw evidence fact (provider payload)
    // must NOT be echoed — only its eventType is projected.
    const dumped = JSON.stringify(parsed);
    assert.ok(!dumped.includes("sk-leak-9f3a"), "raw provider secret from evidence fact does not leak");
    assert.ok(!dumped.includes("hidden-secret"), "raw prompt text from evidence fact does not leak");
  } finally {
    await client.close();
    await server.close();
  }
});

// =====================================================================
// 第 141b 批（TD-373 的 MCP 面）：隔离违规的结构化事实进 run_diagnose。
//
// run.isolation_violation 事件对越界原因多记了闭集 destination、脱敏后的
// reportedPath / resolvedPath，以及物理越界时的 escapedAt——此前只有 CLI
// `runs diagnose` 的文字证据能看到。这里是机读面：可选对象 isolationViolation，
// 只在类别是 workdir_escape、且事件绑定本 runId 时出现；这些字段在读侧一律当
// 不可信文本：闭集外不回显、控制字符再转义一次、再限长一次（共用
// ISOLATION_DISPLAY_PATH_MAX_CHARS）、escapedAt 只给 *_physical_outside。
// =====================================================================

function jl(obj) { return JSON.stringify(obj) + "\n"; }

/** 写一份带一条 run.isolation_violation 的失败转录（flat 布局，服务经 resolveTranscriptPath 读）。 */
function seedIsolationTranscript(runDir, runId, violation, { code = "workdir_escape", violationRunId = runId } = {}) {
  mkdirSync(runDir, { recursive: true });
  const base = { agentId: "coder_low", runId };
  writeFileSync(join(runDir, `${runId}.jsonl`), [
    jl({ type: "run.submitted", ts: "2026-11-26T09:00:00.000Z", seq: 1, ...base }),
    jl({ type: "run.started", backend: "claude-code", ts: "2026-11-26T09:00:01.000Z", seq: 2, ...base }),
    jl({ type: "run.state_change", to: "running", reason: "first_event", ts: "2026-11-26T09:00:02.000Z", seq: 3, ...base }),
    jl({
      type: "run.isolation_violation", code, eventKind: "file_written",
      ts: "2026-11-26T09:00:03.000Z", seq: 4, agentId: "coder_low", runId: violationRunId, ...violation,
    }),
    jl({ type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-11-26T09:00:04.000Z", seq: 5, ...base }),
  ].join(""), "utf8");
}

async function diagnoseSeeded(violation, opts = {}) {
  const runDir = mkdtempSync(join(tmpdir(), "wao-141b-diag-"));
  try {
    const runId = opts.runId ?? "run_141b_diag";
    seedIsolationTranscript(runDir, runId, violation, opts);
    const server = createWaoMcpServer({ registryPath: "/server/r.json", runDir });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_diagnose", arguments: { runId } });
      assert.equal(res.isError, undefined, `调用成功（实测：${res.content?.[0]?.text ?? ""}）`);
      return { res, parsed: JSON.parse(res.content.find((b) => b.type === "text").text) };
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(runDir);
  }
}

test("141b-ISO-1: 物理越界（file_written_physical_outside）→ isolationViolation 带 reason / destination / reportedPath / resolvedPath / escapedAt", async () => {
  const { res, parsed } = await diagnoseSeeded({
    reason: "file_written_physical_outside",
    destination: "temp",
    reportedPath: "linked/evil.js",
    resolvedPath: "C:\\outside\\evil.js",
    escapedAt: "linked",
  });
  assert.equal(parsed.category, "workdir_escape");
  assert.deepEqual(parsed.isolationViolation, {
    reason: "file_written_physical_outside",
    destination: "temp",
    reportedPath: "linked/evil.js",
    resolvedPath: "C:\\outside\\evil.js",
    escapedAt: "linked",
  });
  assert.deepEqual(res.structuredContent.isolationViolation, parsed.isolationViolation, "文本块与 structuredContent 一致");
});

test("141b-ISO-2: write_intent_physical_outside 同样带 escapedAt", async () => {
  const { parsed } = await diagnoseSeeded({
    reason: "write_intent_physical_outside", destination: "other",
    reportedPath: "junction/x.txt", resolvedPath: "D:\\elsewhere\\x.txt", escapedAt: "junction",
  });
  assert.equal(parsed.isolationViolation.escapedAt, "junction");
});

test("141b-ISO-3: 词法越界（*_lexical_outside）→ 没有 escapedAt，即使转录事件里带了这个字段", async () => {
  for (const reason of ["file_written_lexical_outside", "write_intent_lexical_outside"]) {
    const { parsed } = await diagnoseSeeded({
      reason, destination: "home",
      reportedPath: "~/notes.txt", resolvedPath: "C:\\Users\\x\\notes.txt",
      escapedAt: "SHOULD_NOT_APPEAR", // 写入侧不会给词法越界记这个；读侧也绝不能给
    });
    assert.deepEqual(parsed.isolationViolation, {
      reason, destination: "home", reportedPath: "~/notes.txt", resolvedPath: "C:\\Users\\x\\notes.txt",
    }, `${reason}：恰这四项，没有 escapedAt`);
    assert.equal(Object.hasOwn(parsed.isolationViolation, "escapedAt"), false);
  }
});

test("141b-ISO-4: 非越界类 reason（物理无法确认等）+ 带 escapedAt 的事件 → 没有 escapedAt", async () => {
  const { parsed } = await diagnoseSeeded({
    reason: "file_written_physical_unresolved", escapedAt: "SHOULD_NOT_APPEAR", errorCode: "EBUSY",
  });
  assert.equal(parsed.category, "workdir_escape");
  assert.deepEqual(parsed.isolationViolation, { reason: "file_written_physical_unresolved" },
    "只带 reason；errorCode 等其余键不进这个对象");
});

test("141b-ISO-4b: 按原因放行——只有闭集内 *_lexical_outside / *_physical_outside 才给 destination 与两个路径；缺失、未知、unresolved、相关性失败的原因带路径也不给", async () => {
  const paths = { destination: "temp", reportedPath: "linked/evil.js", resolvedPath: "C:\\outside\\evil.js", escapedAt: "linked" };
  // 缺失原因：没有任何可放行的字段 → 不带对象。
  const missing = (await diagnoseSeeded({ ...paths })).parsed;
  assert.equal(missing.category, "workdir_escape");
  assert.equal(Object.hasOwn(missing, "isolationViolation"), false, "缺失原因 + 路径：不给");
  // 未知原因（含"像越界"的伪后缀）：同上。
  for (const reason of ["something_else", "file_written_physical_outside_EXTRA", "evil_lexical_outside", "OUTSIDE"]) {
    const out = (await diagnoseSeeded({ reason, ...paths })).parsed;
    assert.equal(Object.hasOwn(out, "isolationViolation"), false, `未知原因 ${reason}：不给`);
  }
  // 闭集内但不是越界：只给原因本身（说不清是不是越界，不带"逃去了哪里"）。
  for (const reason of ISOLATION_VIOLATION_REASONS.filter((r) => !/_(lexical|physical)_outside$/.test(r))) {
    const out = (await diagnoseSeeded({ reason, ...paths })).parsed;
    assert.deepEqual(out.isolationViolation, { reason }, `${reason}：只给原因`);
  }
  // 对照：闭集内的两类越界照常给（词法没有 escapedAt）。
  const physical = (await diagnoseSeeded({ reason: "write_intent_physical_outside", ...paths })).parsed;
  assert.deepEqual(physical.isolationViolation, { reason: "write_intent_physical_outside", ...paths });
  const lexical = (await diagnoseSeeded({ reason: "write_intent_lexical_outside", ...paths })).parsed;
  assert.equal(lexical.isolationViolation.reportedPath, "linked/evil.js");
  assert.equal(Object.hasOwn(lexical.isolationViolation, "escapedAt"), false);
});

test("141b-ISO-5: 畸形字段——非字符串、闭集外、带控制字符、超长——不回显或被清理、截断", async () => {
  // 非字符串：整项不出现。
  const nonString = (await diagnoseSeeded({
    reason: "file_written_physical_outside", destination: 5,
    reportedPath: 42, resolvedPath: { path: "C:\\leak" }, escapedAt: ["linked"],
  })).parsed;
  assert.deepEqual(nonString.isolationViolation, { reason: "file_written_physical_outside" }, "非字符串一律不回显");

  // 闭集外：reason / destination 不回显；原因不在闭集 = 说不清是不是越界，路径一并不给
  // （第 141 批会审：此前"闭集外的原因 + 合法路径"会被读成已确认越界）。
  const outsideSet = (await diagnoseSeeded({
    reason: "file_written_physical_outside_EXTRA", destination: "C:\\Users\\owner\\secret",
    reportedPath: "a.txt",
  })).parsed;
  assert.equal(outsideSet.category, "workdir_escape");
  assert.equal(Object.hasOwn(outsideSet, "isolationViolation"), false, "闭集外的 reason：没有可放行的字段，不带对象");
  assert.ok(!JSON.stringify(outsideSet).includes("EXTRA") && !JSON.stringify(outsideSet).includes("owner") && !JSON.stringify(outsideSet).includes("a.txt"));

  // 控制字符：转义成可见写法，原始控制字符一个都不出现在线上。
  const dirty = (await diagnoseSeeded({
    reason: "file_written_physical_outside", destination: "temp",
    reportedPath: "a\u0007b\nc\u001b[31mred\u0085\u2028",
    resolvedPath: "C:\\x\ty",
    escapedAt: "lin\u0000k",
  })).parsed;
  assert.equal(dirty.isolationViolation.reportedPath, "a\\u0007b\\nc\\u001b[31mred\\u0085\\u2028");
  assert.equal(dirty.isolationViolation.resolvedPath, "C:\\x\\ty");
  assert.equal(dirty.isolationViolation.escapedAt, "lin\\u0000k");
  for (const key of ["reportedPath", "resolvedPath", "escapedAt"]) {
    assert.doesNotMatch(dirty.isolationViolation[key], /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/,
      `${key}：解码后的值里没有裸控制字符`);
  }

  // 超长：限到 ISOLATION_DISPLAY_PATH_MAX_CHARS；代理对不被切开。
  const long = (await diagnoseSeeded({
    reason: "file_written_physical_outside",
    reportedPath: "r".repeat(5000),
    resolvedPath: "\u{1F600}".repeat(400), // 每个 2 个 UTF-16 单元
    escapedAt: "e".repeat(ISOLATION_DISPLAY_PATH_MAX_CHARS + 1),
  })).parsed;
  assert.equal(long.isolationViolation.reportedPath.length, ISOLATION_DISPLAY_PATH_MAX_CHARS);
  assert.ok(long.isolationViolation.resolvedPath.length <= ISOLATION_DISPLAY_PATH_MAX_CHARS, "代理对按单元计也不超限");
  assert.equal(/[\uD800-\uDBFF]$/.test(long.isolationViolation.resolvedPath), false, "不留落单的高代理");
  assert.equal(long.isolationViolation.escapedAt.length, ISOLATION_DISPLAY_PATH_MAX_CHARS);

  // 整个对象都没有可信内容 → 不带这个键（类别照旧 workdir_escape）。
  const empty = (await diagnoseSeeded({ reason: 7, destination: null, reportedPath: "", resolvedPath: false })).parsed;
  assert.equal(empty.category, "workdir_escape");
  assert.equal(Object.hasOwn(empty, "isolationViolation"), false, "没有任何可信字段 → 不带空对象");
});

test("141b-ISO-6: 不是 workdir_escape → 没有 isolationViolation（别的类别、事件码不对、事件属于别的 runId）", async () => {
  // 事件码不是 workdir_escape：内核不当它是越界。
  const wrongCode = (await diagnoseSeeded(
    { reason: "file_written_physical_outside", destination: "temp", reportedPath: "x" },
    { code: "something_else" },
  )).parsed;
  assert.notEqual(wrongCode.category, "workdir_escape");
  assert.equal(Object.hasOwn(wrongCode, "isolationViolation"), false, "事件码不对");

  // 事件绑定别的 runId：不绑定本 run，不消费。
  const otherRun = (await diagnoseSeeded(
    { reason: "file_written_physical_outside", destination: "temp", reportedPath: "x" },
    { violationRunId: "run_someone_else" },
  )).parsed;
  assert.notEqual(otherRun.category, "workdir_escape");
  assert.equal(Object.hasOwn(otherRun, "isolationViolation"), false, "事件属于别的 runId");
});

test("141b-ISO-7: 注入的服务即使带了 isolationViolation，类别不是 workdir_escape 也不上线", async () => {
  const server = createWaoMcpServer({
    registryPath: "/server/r.json", runDir: "/server/runs",
    getRunDiagnosisFn: async () => ({
      runId: "r", state: "failed", terminal: true, category: "provider_auth", code: null, evidence: [],
      isolationViolation: { reason: "file_written_physical_outside", reportedPath: "leak.txt" },
    }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_diagnose", arguments: { runId: "r" } });
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.equal(parsed.category, "provider_auth");
    assert.equal(Object.hasOwn(parsed, "isolationViolation"), false);
    assert.ok(!JSON.stringify(res).includes("leak.txt"));
  } finally {
    await client.close();
    await server.close();
  }
});

test("141b-ISO-8: 读侧不信任服务：注入的脏 isolationViolation 在 MCP 边界再清一次（闭集、转义、限长、escapedAt 门、多余键丢弃）", async () => {
  const run = async (isolationViolation) => {
    const server = createWaoMcpServer({
      registryPath: "/server/r.json", runDir: "/server/runs",
      getRunDiagnosisFn: async () => ({
        runId: "r", state: "failed", terminal: true, category: "workdir_escape", code: null,
        evidence: [{ eventType: "run.isolation_violation", fact: "RAW_FACT_SHOULD_NOT_CROSS" }],
        isolationViolation,
      }),
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_diagnose", arguments: { runId: "r" } });
      assert.equal(res.isError, undefined, `不会因脏数据整体报错（实测：${res.content?.[0]?.text ?? ""}）`);
      return { res, parsed: JSON.parse(res.content.find((b) => b.type === "text").text) };
    } finally {
      await client.close();
      await server.close();
    }
  };

  const dirty = await run({
    reason: "file_written_lexical_outside", // 词法 → escapedAt 不给
    destination: "temp",
    reportedPath: `p\u0007${"z".repeat(1000)}`,
    resolvedPath: "ok",
    escapedAt: "must-not-pass",
    unrelatedField: "EXTRA_FIELD_SHOULD_NOT_CROSS", // 多余键
  });
  assert.deepEqual(Object.keys(dirty.parsed.isolationViolation).sort(), ["destination", "reason", "reportedPath", "resolvedPath"]);
  assert.equal(dirty.parsed.isolationViolation.reportedPath.length, ISOLATION_DISPLAY_PATH_MAX_CHARS);
  assert.ok(dirty.parsed.isolationViolation.reportedPath.startsWith("p\\u0007z"), "控制字符转义在先、限长在后");
  assert.ok(!JSON.stringify(dirty.res).includes("EXTRA_FIELD_SHOULD_NOT_CROSS"));
  assert.ok(!JSON.stringify(dirty.res).includes("RAW_FACT_SHOULD_NOT_CROSS"), "evidence 的 fact 原文仍不跨边界");

  for (const bad of [null, undefined, "string", 42, ["file_written_physical_outside"], { reason: "nope", destination: "nope" }, {}]) {
    const out = await run(bad);
    assert.equal(out.parsed.category, "workdir_escape");
    assert.equal(Object.hasOwn(out.parsed, "isolationViolation"), false, `${JSON.stringify(bad)} 不产出对象`);
  }

  // 物理越界 + 合法 escapedAt 经边界仍在（对照：门只拦词法）。
  const physical = await run({ reason: "write_intent_physical_outside", escapedAt: "linked" });
  assert.deepEqual(physical.parsed.isolationViolation, { reason: "write_intent_physical_outside", escapedAt: "linked" });
});

test("141b-ISO-9: tools/list——isolationViolation 是出参里的可选严格对象，字段有上界；入参与描述不变", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-141b-iso9-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    const server = createWaoMcpServer({ registryPath, runDir: dir });
    const client = await buildInMemoryClient(server);
    try {
      const rd = (await client.listTools()).tools.find((t) => t.name === "run_diagnose");
      const out = rd.outputSchema;
      assert.equal((out.required ?? []).includes("isolationViolation"), false, "可选，不是必填");
      const iv = out.properties.isolationViolation;
      assert.equal(iv.type, "object");
      assert.equal(iv.additionalProperties, false, "严格对象");
      assert.deepEqual(Object.keys(iv.properties).sort(), ["destination", "escapedAt", "reason", "reportedPath", "resolvedPath"]);
      assert.deepEqual(iv.properties.destination.enum, [...ISOLATION_DESTINATIONS], "destination 是闭集，与 SSOT 同源");
      assert.deepEqual(iv.properties.reason.enum, [...ISOLATION_VIOLATION_REASONS], "reason 是闭集，与 SSOT 同源");
      for (const key of ["reportedPath", "resolvedPath", "escapedAt"]) {
        assert.equal(iv.properties[key].maxLength, ISOLATION_DISPLAY_PATH_MAX_CHARS, `${key} 的上界就是共用常量`);
      }
      assert.deepEqual(Object.keys(rd.inputSchema.properties), ["runId", "expectedWorkspaceRoot"], "入参不变");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("141b-ISO-10: 读侧再脱敏——合法原因 + 转录里写的原始用户目录路径 + 秘密值 + U+202E：content 与 structuredContent 里没有用户名、秘密和双向控制符", async () => {
  const home = homedir();
  const userName = basename(home);
  const exactName = "WAO_141B_PROBE_API_KEY";
  const exactValue = "probe-exact-value-141b-0001";
  const shapeSecret = "sk-placeholder0123456789";
  const bidi = ["\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069", "\u200e", "\u200f"];
  process.env[exactName] = exactValue;
  try {
    const { res, parsed } = await diagnoseSeeded({
      reason: "file_written_physical_outside",
      destination: "home",
      // 主目录下的路径：换成 ~；秘密（精确值与形状）脱敏；双向控制符清掉。
      reportedPath: join(home, "Documents", `${exactValue}-${shapeSecret}\u202e`, "report.txt"),
      // 用户名出现在主目录前缀之外：证明不了脱敏干净 → 整个字段不给。
      resolvedPath: `D:\\backup\\${userName}\\notes.txt`,
      escapedAt: join(home, `lin\u202ek\u2067`),
    });
    assert.equal(parsed.category, "workdir_escape");
    const iv = parsed.isolationViolation;
    assert.equal(iv.reason, "file_written_physical_outside");
    assert.equal(iv.destination, "home");
    assert.ok(iv.reportedPath.startsWith("~"), `主目录前缀换成 ~（实测 ${iv.reportedPath}）`);
    assert.ok(iv.reportedPath.includes("report.txt"));
    assert.equal(Object.hasOwn(iv, "resolvedPath"), false, "用户名段还在 → 整个字段不给");
    assert.ok(iv.escapedAt.startsWith("~"));
    assert.deepEqual(res.structuredContent, parsed, "文本块与 structuredContent 一致");

    const blobs = [res.content.find((b) => b.type === "text").text, JSON.stringify(res.structuredContent)];
    for (const blob of blobs) {
      assert.ok(!blob.includes(exactValue), "精确值秘密脱敏");
      assert.ok(!blob.includes(shapeSecret), "形状秘密脱敏");
      assert.ok(!blob.includes(home) && !blob.includes(JSON.stringify(home).slice(1, -1)), "主目录原样不出现");
      for (const ch of bidi) assert.ok(!blob.includes(ch), `没有双向控制符 U+${ch.codePointAt(0).toString(16).toUpperCase()}`);
    }
    for (const key of ["reportedPath", "escapedAt"]) {
      const segments = iv[key].split(/[\\/]+/).map((s) => s.toLowerCase());
      assert.ok(!segments.includes(userName.toLowerCase()), `${key} 里没有用户名段`);
    }
    // 先脱敏、后限长：秘密跨在 300 的截断点上也不留半截。
    const straddle = (await diagnoseSeeded({
      reason: "write_intent_lexical_outside",
      reportedPath: `${"p".repeat(ISOLATION_DISPLAY_PATH_MAX_CHARS - 6)} ${exactValue}`,
    })).parsed.isolationViolation.reportedPath;
    assert.ok(straddle.length <= ISOLATION_DISPLAY_PATH_MAX_CHARS);
    assert.ok(!straddle.includes(exactValue.slice(0, 5)), `跨截断点的秘密没有留下前缀（实测 ${straddle.slice(-24)}）`);
  } finally {
    delete process.env[exactName];
  }
});
