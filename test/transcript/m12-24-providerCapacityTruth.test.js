// M12-24: control-plane health, static worker readiness, and live provider
// capacity are distinct facts. TDD coverage for truthful Lead projection.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  diagnoseFailure,
  DIAGNOSIS_CATEGORIES,
  DIAGNOSIS_CODES,
  PROVIDER_CAPACITY_DIAGNOSIS_CODES,
  isValidDiagnosisCode,
} from "../../src/diagnosis.js";
import { aggregateLeadPreflight } from "../../src/application/leadPreflight.js";
import { projectObservation } from "../../src/application/runObservationProjection.js";
import { selectSemanticNotes } from "../../src/application/runSemanticsNotes.js";
import { createWaoMcpServer } from "../../src/mcp/server.js";
import { ClaudeStreamParser } from "../../src/backends/parsers/claudeCode.js";
import { getRunDiagnosis } from "../../src/application/runDiagnosis.js";

function failedRunEvents(errorText, runId = "run_capacity") {
  return [
    { type: "run.state_change", to: "pending", reason: "init", runId, ts: "2026-08-13T10:00:00.000Z" },
    { type: "run.state_change", to: "running", reason: "start", runId, ts: "2026-08-13T10:00:01.000Z" },
    { type: "run.error", phase: "wait", error: errorText, runId, ts: "2026-08-13T10:00:02.000Z" },
    { type: "run.state_change", to: "failed", reason: "backend_error", runId, ts: "2026-08-13T10:00:03.000Z" },
  ];
}

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-m1224-test", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("M12-24-PF1: complete preflight explicitly says live auth/entitlement/quota were not checked", async () => {
  const readiness = {
    configurationStatus: "configured",
    authenticationStatus: "unknown",
    entitlementStatus: "unknown",
    liveCheckStatus: "not_checked",
    credentialAvailability: "not_required",
  };
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: true, source: "lead_session", root: "C:/repo", gitHead: "abc", dirty: false },
    getRegistryInventoryFn: async () => [{
      id: "auditor", backend: "claude-code", model: "claude-opus-5",
      reasoningEffort: "xhigh", certification: "certified",
      credentialAvailability: "not_required", providerReadiness: readiness,
    }],
    listRunsFn: async () => ({ runs: [], matchedCount: 0, unresolvedCount: 0 }),
    knownAgentIds: ["auditor"],
  });

  assert.equal(result.complete, true, "all three observations can be complete");
  assert.ok(result.observations.some((line) =>
    /live provider authentication, entitlement, quota, and rate limits were not checked/i.test(line)),
  "the result self-explains that complete is not live execution readiness");
  assert.ok(result.observations.some((line) =>
    /complete means observation completeness, not provider execution readiness/i.test(line)));
});

test("M12-24-D1: terminal 429/rate-limit errors classify as provider_capacity/rate_limited before crash", () => {
  for (const errorText of [
    "process exited with code 1; stderr: provider error [429]: Too Many Requests",
    "process exited with code 1; stderr: rate limit exceeded; retry later",
  ]) {
    const result = diagnoseFailure(failedRunEvents(errorText), "run_capacity");
    assert.equal(result.category, "provider_capacity");
    assert.equal(result.code, "rate_limited");
  }
});

test("M12-24-D2: terminal quota/usage-limit errors classify as provider_capacity/quota_exhausted", () => {
  for (const errorText of [
    "process exited with code 1; stderr: quota exhausted",
    "process exited with code 1; stderr: 1310 usage upper limit exceeded",
    "process exited with code 1; stderr: You've hit your 5-hour limit; resets at 18:00",
  ]) {
    const result = diagnoseFailure(failedRunEvents(errorText), "run_capacity");
    assert.equal(result.category, "provider_capacity");
    assert.equal(result.code, "quota_exhausted");
  }
});

test("M12-24-D3: provider-capacity codes are one valid closed category-code set", () => {
  assert.deepEqual([...PROVIDER_CAPACITY_DIAGNOSIS_CODES], ["rate_limited", "quota_exhausted"]);
  assert.ok(DIAGNOSIS_CATEGORIES.includes("provider_capacity"));
  for (const code of PROVIDER_CAPACITY_DIAGNOSIS_CODES) {
    assert.ok(DIAGNOSIS_CODES.includes(code));
    assert.equal(isValidDiagnosisCode("provider_capacity", code), true);
    assert.equal(isValidDiagnosisCode("provider_auth", code), false);
  }
});

test("M12-24-D4: non-terminal capacity text is never promoted to provider_capacity", () => {
  const events = [
    { type: "run.state_change", to: "running", runId: "run_capacity" },
    { type: "run.event", event: { kind: "runtime_status", status: "rate_limited" }, runId: "run_capacity" },
  ];
  const result = diagnoseFailure(events, "run_capacity");
  assert.notEqual(result.category, "provider_capacity");
  assert.equal(result.code, null);
});

test("M12-24-D5: run.error text without an explicit failed transition is not provider capacity", () => {
  const events = [
    { type: "run.state_change", to: "running", runId: "run_capacity" },
    {
      type: "run.error",
      phase: "wait",
      error: "process exited with code 1; stderr: rate limit exceeded",
      runId: "run_capacity",
    },
  ];
  const result = diagnoseFailure(events, "run_capacity");
  assert.notEqual(result.category, "provider_capacity");
  assert.equal(result.code, null);
});

test("M12-24-D6: only the terminal-proximate wait error can establish provider capacity", () => {
  const events = [
    { type: "run.state_change", to: "pending", runId: "run_capacity" },
    { type: "run.state_change", to: "running", runId: "run_capacity" },
    {
      type: "run.error",
      phase: "wait",
      error: "provider error [429]: Too Many Requests; retrying",
      runId: "run_capacity",
    },
    {
      type: "run.error",
      phase: "wait",
      error: "process exited with code 1; stderr: TypeError: worker transport crashed",
      runId: "run_capacity",
    },
    { type: "run.state_change", to: "failed", reason: "backend_error", runId: "run_capacity" },
  ];
  const result = diagnoseFailure(events, "run_capacity");
  assert.equal(result.category, "crash");
  assert.equal(result.code, null);
});

test("M12-24-D7: local resource limits and stack line numbers are not provider capacity", () => {
  for (const errorText of [
    "process exited with code 1; stderr: Disk quota exceeded while writing cache",
    "process exited with code 1; stderr: cgroup cpu quota exceeded",
    "process exited with code 1; stderr: memory usage limit exceeded",
    "process exited with code 1; stderr: TypeError at bundle.js:429:17",
    "process exited with code 1; stderr: retried operation 429 times",
  ]) {
    const result = diagnoseFailure(failedRunEvents(errorText), "run_capacity");
    assert.equal(result.category, "crash", errorText);
    assert.equal(result.code, null);
  }
});

test("M12-24-D8: another run's later events cannot create a capacity fact for this run", () => {
  const expectedEvents = failedRunEvents(
    "process exited with code 1; stderr: TypeError: worker transport crashed",
  );
  const interleaved = [
    ...expectedEvents,
    { type: "run.error", phase: "wait", error: "quota exhausted", runId: "run_other" },
    { type: "run.state_change", to: "failed", runId: "run_other" },
  ];
  const result = diagnoseFailure(interleaved, "run_capacity");
  assert.equal(result.category, "crash");
  assert.equal(result.code, null);
});

test("M12-24-WAIT1: terminal capacity failure projects provider termination and self-explaining notes", () => {
  const events = failedRunEvents("process exited with code 1; quota exhausted");
  const { termination } = projectObservation({
    events,
    runId: "run_capacity",
    currentState: "failed",
    terminal: true,
    readFailure: false,
    waitedMs: 20,
    windowMs: 270_000,
  });
  assert.equal(termination.source, "provider");

  const notes = selectSemanticNotes("run_await_result", {
    outcome: "terminal",
    terminal: true,
    terminationSource: termination.source,
    diagnosisCategory: "provider_capacity",
    deliveryRequested: false,
  });
  assert.ok(notes.some((note) => note.id === "termination.provider"));
  assert.ok(notes.some((note) => note.id === "diagnosis.provider_capacity"));
});

test("M12-24-MCP1: run_diagnose projects safe provider capacity facts without raw provider text", async () => {
  // Synthetic provider payload standing in for a private quota fact that must
  // NOT leak. Named to avoid any credential-assignment shape (the desensitization
  // gate keys on API_KEY/TOKEN/SECRET adjacent to an assignment).
  const rawQuotaPayload = "PRIVATE_PROVIDER_QUOTA_PAYLOAD";
  const server = createWaoMcpServer({
    registryPath: "/r.json",
    runDir: "/runs",
    getRunDiagnosisFn: async () => ({
      runId: "run_capacity",
      state: "failed",
      terminal: true,
      category: "provider_capacity",
      code: "quota_exhausted",
      evidence: [{ eventType: "run.error", fact: rawQuotaPayload }],
    }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const response = await client.callTool({ name: "run_diagnose", arguments: { runId: "run_capacity" } });
    assert.equal(response.isError, undefined);
    const parsed = JSON.parse(response.content.find((block) => block.type === "text").text);
    assert.equal(parsed.category, "provider_capacity");
    assert.equal(parsed.code, "quota_exhausted");
    assert.ok(parsed.semanticNotes.some((note) => note.id === "diagnosis.provider_capacity"));
    assert.equal(JSON.stringify(response).includes(rawQuotaPayload), false, "raw provider fact stays behind the projection");
  } finally {
    await client.close();
    await server.close();
  }
});

test("M12-24-MCP2: tools/list exposes only the intended capacity category and codes", async () => {
  const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs" });
  const client = await buildInMemoryClient(server);
  try {
    const tool = (await client.listTools()).tools.find((item) => item.name === "run_diagnose");
    assert.ok(tool, "run_diagnose remains on the frozen tool surface");
    const schema = JSON.stringify(tool.outputSchema);
    assert.match(schema, /provider_capacity/);
    assert.match(schema, /rate_limited/);
    assert.match(schema, /quota_exhausted/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("M12-24-PARSER1: informational Claude rate_limit_event alone remains non-terminal and payload-free", () => {
  const parser = new ClaudeStreamParser();
  const events = parser.feed(
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","secret":"DO_NOT_LEAK"}}\n',
  );
  assert.deepEqual(events, [], "an informational runtime event is not a terminal quota denial");
});

test("M12-24-REAL1: persisted JSONL transcript projects quota exhaustion through the application service", async () => {
  const runId = "run_20260813123456789abc123";
  const runDir = await mkdtemp(join(tmpdir(), "wao-m1224-"));
  const transcriptPath = join(runDir, `${runId}.jsonl`);
  const events = failedRunEvents(
    "process exited with code 1; stderr: You've hit your 5-hour limit; resets later",
    runId,
  );
  await writeFile(transcriptPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

  try {
    const result = await getRunDiagnosis({ runId, runDir });
    assert.equal(result.state, "failed");
    assert.equal(result.terminal, true);
    assert.equal(result.category, "provider_capacity");
    assert.equal(result.code, "quota_exhausted");
    assert.equal(JSON.stringify(result).includes("5-hour"), false, "raw provider text is not projected");
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("M12-24-DOC1: Lead guidance distinguishes static readiness from live capacity", async () => {
  const [skill, usage, architecture] = await Promise.all([
    readFile(new URL("../../SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../../docs/usage.md", import.meta.url), "utf8"),
    readFile(new URL("../../docs/02-architecture.md", import.meta.url), "utf8"),
  ]);
  assert.match(skill, /does \*\*not\*\* probe current provider authentication, entitlement, quota, or rate limits/i);
  assert.match(usage, /complete.*not.*provider.*quota/i);
  assert.match(architecture, /provider-capacity.*no-effect/i);
});
