// test/m12-6-fr02-providerReadiness.test.js
//
// M12-6 FR-02: provider readiness truth + entitlement diagnosis — TDD tests.
//
// Proves:
//  (a) production-shaped provider access denials (subscription / org policy /
//      API-key missing / 401 / invalid key) classify as provider_auth with a
//      safe closed-set diagnosis code — never no_effect, never a raw echo;
//  (b) registry_list / lead_preflight never project authenticated / entitled /
//      live-checked without a real provider probe: configurationStatus is
//      always "configured", authenticationStatus/entitlementStatus always
//      "unknown", liveCheckStatus always "not_checked", even when
//      credentialAvailability is "available" or "not_required";
//  (c) the MCP wire schema exposes the strict providerReadiness object and the
//      diagnosis code closed set (single enums, no second hand-maintained list);
//  (d) malformed/attacker-controlled service output fails closed — invalid
//      codes project to null, missing providerReadiness is rejected, and no
//      raw value ever leaks into the wire.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { diagnoseFailure, PROVIDER_DIAGNOSIS_CODES, DIAGNOSIS_CODES } from "../../src/diagnosis.js";
import { getRunDiagnosis } from "../../src/application/runDiagnosis.js";
import { getRegistryInventory } from "../../src/application/registryInventory.js";
import { aggregateLeadPreflight } from "../../src/application/leadPreflight.js";
import { createWaoMcpServer } from "../../src/mcp/server.js";

// The safe closed set this milestone pins. PROVIDER_DIAGNOSIS_CODES is imported
// from the kernel SSOT (src/diagnosis.js) so the MCP wire enum (D1) is compared
// against the real export — a second hand-maintained list cannot drift in.

// ===== Helpers =====

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function jl(obj) {
  return JSON.stringify(obj) + "\n";
}

// Production-shaped failed run: worker read the task (assistant text + tool_use),
// then the provider rejected it with the given error text, and the run failed.
// No file_written, no command exit0 — so pre-fix the subscription/org-policy/
// api-key-missing cases land in no_effect.
function failedRunEvents({ runId, agentId, errorText }) {
  const ts = "2026-08-01T00:00:00.000Z";
  return [
    { type: "run.state_change", to: "pending", reason: "init", ts, runId, agentId },
    { type: "run.state_change", to: "running", reason: "start", ts: "2026-08-01T00:00:01.000Z", runId, agentId },
    { type: "run.event", kind: "message", role: "assistant", ts: "2026-08-01T00:00:02.000Z", runId, agentId, parts: [{ type: "text", text: "I'll read the task and start working." }] },
    { type: "run.event", kind: "tool_use", ts: "2026-08-01T00:00:03.000Z", runId, agentId, name: "Bash", input: { command: "ls" } },
    { type: "run.error", phase: "wait", error: errorText, ts: "2026-08-01T00:00:04.000Z", runId, agentId },
    { type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-08-01T00:00:05.000Z", runId, agentId },
  ];
}

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-m126-fr02-test", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// ===== (a) Kernel: provider access denials → provider_auth + closed-set code =====

// The REAL production fact: an enterprise org disables Claude subscription
// access for Claude Code. Contains no 401 / 身份验证 / unauthor / invalid-key
// token, so pre-fix it falls through to no_effect (activity, no output).
test("M12-6-FR02-A1: subscription access disabled fact → provider_auth + subscription_access_disabled", () => {
  const d = diagnoseFailure(failedRunEvents({
    runId: "run_sub", agentId: "w",
    errorText: "Error: Your organization has disabled Claude subscription access for Claude Code. Please contact your organization admin to enable subscription access.",
  }));
  assert.equal(d.category, "provider_auth");
  assert.equal(d.code, "subscription_access_disabled");
});

test("M12-6-FR02-A2: missing API key → provider_auth + api_key_missing", () => {
  const d = diagnoseFailure(failedRunEvents({
    runId: "run_key", agentId: "w",
    errorText: "Error: Missing required environment variable ANTHROPIC_API_KEY",
  }));
  assert.equal(d.category, "provider_auth");
  assert.equal(d.code, "api_key_missing");
});

test("M12-6-FR02-A3: organization policy denial → provider_auth + organization_policy_denied", () => {
  const d = diagnoseFailure(failedRunEvents({
    runId: "run_pol", agentId: "w",
    errorText: "Error: Your organization's policy has denied access to this model. Contact your admin for approval.",
  }));
  assert.equal(d.category, "provider_auth");
  assert.equal(d.code, "organization_policy_denied");
});

test("M12-6-FR02-A4: 401 unauthorized → provider_auth + unauthorized", () => {
  const d = diagnoseFailure(failedRunEvents({
    runId: "run_401", agentId: "w",
    errorText: "Error: 401 Unauthorized",
  }));
  assert.equal(d.category, "provider_auth");
  assert.equal(d.code, "unauthorized");
});

test("M12-6-FR02-A5: invalid API key → provider_auth + invalid_credential", () => {
  const d = diagnoseFailure(failedRunEvents({
    runId: "run_inv", agentId: "w",
    errorText: "Error: invalid api key provided",
  }));
  assert.equal(d.category, "provider_auth");
  assert.equal(d.code, "invalid_credential");
});

test("M12-6-FR02-A6: config_conflict keeps precedence → config_conflict + code null", () => {
  const events = failedRunEvents({
    runId: "run_cf", agentId: "w",
    errorText: "ANTHROPIC_API_KEY takes precedence over claude.ai login — connectors are disabled",
  });
  // A genuine 401 later in the stream must NOT override the config conflict.
  events.push({ type: "run.error", phase: "wait", error: "401 unauthorized", ts: "2026-08-01T00:00:06.000Z", runId: "run_cf", agentId: "w" });
  const d = diagnoseFailure(events);
  assert.equal(d.category, "config_conflict");
  assert.equal(d.code, null);
});

test("M12-6-FR02-A7: plain no_effect keeps its category + code null", () => {
  const d = diagnoseFailure(failedRunEvents({
    runId: "run_ne", agentId: "w",
    errorText: "process ended unexpectedly without output",
  }));
  assert.equal(d.category, "no_effect");
  assert.equal(d.code, null);
});

test("M12-6-FR02-A8: timeout / crash keep their categories + code null", () => {
  const timeout = diagnoseFailure([
    { type: "run.state_change", to: "failed", reason: "x", ts: "2026-08-01T00:00:00.000Z", runId: "r", agentId: "w" },
    { type: "run.timed_out", ts: "2026-08-01T00:00:01.000Z", runId: "r", agentId: "w" },
  ]);
  assert.equal(timeout.category, "timeout");
  assert.equal(timeout.code, null);

  // Crash WITHOUT worker activity (spawn failure) — a crash with activity and
  // no output legitimately lands in no_effect (checked before crash).
  const crash = diagnoseFailure([
    { type: "run.state_change", to: "failed", reason: "x", ts: "2026-08-01T00:00:00.000Z", runId: "r", agentId: "w" },
    { type: "run.error", phase: "spawn", error: "backend failed to start", ts: "2026-08-01T00:00:01.000Z", runId: "r", agentId: "w" },
  ]);
  assert.equal(crash.category, "crash");
  assert.equal(crash.code, null);
});

test("M12-6-FR02-A9: PROVIDER_DIAGNOSIS_CODES SSOT is the exact closed set", () => {
  assert.deepEqual([...PROVIDER_DIAGNOSIS_CODES], [
    "subscription_access_disabled",
    "organization_policy_denied",
    "api_key_missing",
    "unauthorized",
    "invalid_credential",
  ]);
  // Every kernel-produced code must come from the closed set (fail closed).
  const samples = [
    "Error: 401 unauthorized",
    "Error: invalid api key",
    "Your organization has disabled Claude subscription access",
    "organization policy denied",
    "Missing API key",
  ];
  for (const s of samples) {
    const d = diagnoseFailure(failedRunEvents({ runId: "r", agentId: "w", errorText: s }));
    assert.ok(PROVIDER_DIAGNOSIS_CODES.includes(d.code), `code ${d.code} ∈ closed set for ${s}`);
  }
});

// ===== (b) Service: run_diagnosis passes the code through =====

test("M12-6-FR02-B1: getRunDiagnosis returns code subscription_access_disabled from real transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m126fr02-b1-"));
  try {
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    const runId = "run_sub_svc";
    const events = failedRunEvents({
      runId, agentId: "w",
      errorText: "Error: Your organization has disabled Claude subscription access for Claude Code.",
    });
    writeFileSync(join(runDir, `${runId}.jsonl`), events.map(jl).join(""), "utf8");
    const result = await getRunDiagnosis({ runId, runDir });
    assert.equal(result.category, "provider_auth");
    assert.equal(result.code, "subscription_access_disabled");
  } finally {
    cleanupDir(dir);
  }
});

// ===== (c) Application: registry inventory + lead preflight truth =====

test("M12-6-FR02-C1: registry inventory projects strict providerReadiness (unknown/not_checked) for available AND not_required", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m126fr02-c1-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        ready: { backend: "claude-code", cwd: dir, provider: { protocol: "anthropic-compatible", baseUrl: "https://synthetic.example.com", apiKeyEnv: "WAO_TEST_M126_REQ" } },
        noCred: { backend: "claude-code", cwd: dir },
      },
    }), "utf8");
    const agents = await getRegistryInventory({
      registryPath, runDir: dir,
      userEnvReader: async (name) => (name === "WAO_TEST_M126_REQ" ? "test-value-m126" : undefined),
    });
    const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
    assert.equal(byId.ready.credentialAvailability, "available");
    assert.equal(byId.noCred.credentialAvailability, "not_required");
    for (const a of agents) {
      assert.deepEqual(a.providerReadiness, {
        configurationStatus: "configured",
        authenticationStatus: "unknown",
        entitlementStatus: "unknown",
        liveCheckStatus: "not_checked",
        credentialAvailability: a.credentialAvailability,
      });
      // The strict truth: none of these may ever be projected without a real probe.
      const dumped = JSON.stringify(a.providerReadiness);
      assert.ok(!dumped.includes("authenticated"), "never claims authenticated");
      assert.ok(!dumped.includes("entitled"), "never claims entitled");
      assert.ok(!dumped.includes('"checked"'), "never claims live-checked");
    }
  } finally {
    cleanupDir(dir);
  }
});

test("M12-6-FR02-C2: lead_preflight worker gets providerReadiness fallback even when inventory omits it", async () => {
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: false },
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => [
      { id: "w", backend: "claude-code", model: "m", certification: null, credentialAvailability: "available", cwd: "/A", missingCredentialEnvNames: [] },
    ],
  });
  assert.equal(result.workers.length, 1);
  assert.deepEqual(result.workers[0].providerReadiness, {
    configurationStatus: "configured",
    authenticationStatus: "unknown",
    entitlementStatus: "unknown",
    liveCheckStatus: "not_checked",
    credentialAvailability: "available",
  });
});

test("M12-6-FR02-C3: lead_preflight passes a service-provided providerReadiness through verbatim", async () => {
  const provided = {
    configurationStatus: "configured",
    authenticationStatus: "unknown",
    entitlementStatus: "unknown",
    liveCheckStatus: "not_checked",
    credentialAvailability: "not_required",
  };
  const result = await aggregateLeadPreflight({
    workspaceBinding: { bound: false },
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => [
      { id: "w", backend: "claude-code", model: "m", certification: null, credentialAvailability: "not_required", providerReadiness: provided, cwd: "/A", missingCredentialEnvNames: [] },
    ],
  });
  assert.deepEqual(result.workers[0].providerReadiness, provided);
});

// ===== (d) MCP wire: schema exposes strict closed sets; handler projects safely =====

test("M12-6-FR02-D1: run_diagnose output schema exposes code enum == general SSOT, nullable", async () => {
  const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs" });
  const client = await buildInMemoryClient(server);
  try {
    const tools = await client.listTools();
    const rd = tools.tools.find((t) => t.name === "run_diagnose");
    const codeSchema = rd.outputSchema.properties.code;
    assert.ok(codeSchema, "code property present");
    // This SDK renders z.enum().nullable() as anyOf: [enum, null].
    const enumBranch = codeSchema.anyOf?.[0] ?? codeSchema;
    // M12-21: the wire enum derives from the single DIAGNOSIS_CODES SSOT
    // (provider-auth codes plus completed_empty) — no second hand-maintained list.
    assert.deepEqual(enumBranch.enum, [...DIAGNOSIS_CODES], "wire enum == general kernel SSOT");
    assert.ok(enumBranch.enum.includes("completed_empty"), "completed_empty is on the wire enum");
    // completed_empty is NOT folded into PROVIDER_DIAGNOSIS_CODES (contract #2).
    assert.ok(!PROVIDER_DIAGNOSIS_CODES.includes("completed_empty"), "completed_empty stays out of PROVIDER_DIAGNOSIS_CODES");
    assert.ok(JSON.stringify(codeSchema).includes('"null"'), "code is nullable");
  } finally {
    await client.close();
    await server.close();
  }
});

test("M12-6-FR02-D2: registry_list output schema exposes strict providerReadiness closed sets", async () => {
  const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs" });
  const client = await buildInMemoryClient(server);
  try {
    const tools = await client.listTools();
    const t = tools.tools.find((x) => x.name === "registry_list");
    const pr = t.outputSchema.properties.agents.items.properties.providerReadiness;
    assert.ok(pr, "providerReadiness property present on agent entry");
    assert.deepEqual(pr.properties.configurationStatus.enum, ["configured"], "configurationStatus closed to configured");
    assert.deepEqual(pr.properties.authenticationStatus.enum, ["unknown"], "authenticationStatus closed to unknown");
    assert.deepEqual(pr.properties.entitlementStatus.enum, ["unknown"], "entitlementStatus closed to unknown");
    assert.deepEqual(pr.properties.liveCheckStatus.enum, ["not_checked"], "liveCheckStatus closed to not_checked");
    assert.deepEqual(pr.properties.credentialAvailability.enum, ["available", "missing", "not_required"]);
    const dumped = JSON.stringify(pr);
    assert.ok(!dumped.includes("authenticated"), "no authenticated state on the wire");
    assert.ok(!dumped.includes("entitled"), "no entitled state on the wire");
    assert.ok(!dumped.includes('"checked"'), "no checked state on the wire");
  } finally {
    await client.close();
    await server.close();
  }
});

test("M12-6-FR02-D3: lead_preflight output schema exposes providerReadiness on workers", async () => {
  const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs" });
  const client = await buildInMemoryClient(server);
  try {
    const tools = await client.listTools();
    const t = tools.tools.find((x) => x.name === "lead_preflight");
    // workers is nullable → anyOf[0] is the array branch.
    const items = t.outputSchema.properties.workers.anyOf?.[0]?.items ?? t.outputSchema.properties.workers.items;
    const pr = items.properties.providerReadiness;
    assert.ok(pr, "workers providerReadiness property present");
    assert.deepEqual(pr.properties.authenticationStatus.enum, ["unknown"]);
    assert.deepEqual(pr.properties.liveCheckStatus.enum, ["not_checked"]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("M12-6-FR02-D4: run_diagnose round-trips provider_auth + closed-set code", async () => {
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDiagnosisFn: async () => ({
      runId: "r", state: "failed", terminal: true,
      category: "provider_auth", code: "subscription_access_disabled",
      evidence: [{ eventType: "run.error", fact: "Your organization has disabled Claude subscription access for Claude Code" }],
    }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_diagnose", arguments: { runId: "r" } });
    assert.equal(res.isError, undefined);
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.equal(parsed.category, "provider_auth");
    assert.equal(parsed.code, "subscription_access_disabled");
  } finally {
    await client.close();
    await server.close();
  }
});

test("M12-6-FR02-D5: attacker-controlled code from service → code null, no raw leak", async () => {
  const ATTACKER = "attacker-controlled-code";
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDiagnosisFn: async () => ({
      runId: "r", state: "failed", terminal: true,
      category: "provider_auth", code: ATTACKER,
      evidence: [{ eventType: "run.error", fact: "redacted" }],
    }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_diagnose", arguments: { runId: "r" } });
    assert.equal(res.isError, undefined);
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.equal(parsed.code, null, "invalid code fails closed to null");
    assert.ok(!JSON.stringify(res).includes(ATTACKER), "attacker code never leaks");
  } finally {
    await client.close();
    await server.close();
  }
});

test("M12-6-FR02-D6: a code under the wrong category (invalid pair) → code null", async () => {
  // M12-21: a provider code under no_effect is an invalid (category, code) pair.
  // no_effect's only valid code is completed_empty; anything else fails closed
  // to null. (The valid no_effect/completed_empty pair is covered separately.)
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDiagnosisFn: async () => ({
      runId: "r", state: "failed", terminal: true,
      category: "no_effect", code: "subscription_access_disabled",
      evidence: [{ eventType: "run.event", fact: "redacted" }],
    }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_diagnose", arguments: { runId: "r" } });
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.equal(parsed.category, "no_effect");
    assert.equal(parsed.code, null, "an invalid category-code pair fails closed to null");
  } finally {
    await client.close();
    await server.close();
  }
});

test("M12-6-FR02-D7: malformed category fails closed with fixed safe text, no leak", async () => {
  const MALFORMED = "totally_made_up_category";
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRunDiagnosisFn: async () => ({
      runId: "r", state: "failed", terminal: true,
      category: MALFORMED, code: "unauthorized",
      evidence: [{ eventType: "run.error", fact: "redacted" }],
    }),
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "run_diagnose", arguments: { runId: "r" } });
    assert.equal(res.isError, true);
    const dumped = JSON.stringify(res);
    assert.ok(!dumped.includes(MALFORMED), "malformed category never leaks");
    assert.ok(!/output validation error/i.test(dumped), "no SDK validation error leak");
    const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
    assert.ok(/run_diagnose failed/.test(text), "fixed safe text");
  } finally {
    await client.close();
    await server.close();
  }
});

test("M12-6-FR02-D8: registry_list service output WITHOUT providerReadiness is rejected, no leak", async () => {
  const SENTINEL = "glm-secret-sentinel-d8";
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => [
      { id: "coder_low", backend: "claude-code", model: SENTINEL, reasoningEffort: null, certification: "certified", cwd: "/repo", sessionReuse: null, credentialAvailability: "available", missingCredentialEnvNames: [] },
    ],
  });
  const client = await buildInMemoryClient(server);
  try {
    let rejected = false;
    let res = null;
    try { res = await client.callTool({ name: "registry_list", arguments: {} }); } catch { rejected = true; }
    assert.ok(rejected || res?.isError === true, "missing providerReadiness must be rejected, not silently projected");
    const dumped = JSON.stringify(res ?? {});
    assert.ok(!dumped.includes(SENTINEL), "no raw agent content leak");
  } finally {
    await client.close();
    await server.close();
  }
});

test("M12-6-FR02-D9: registry_list round-trips providerReadiness through the wire", async () => {
  const pr = {
    configurationStatus: "configured",
    authenticationStatus: "unknown",
    entitlementStatus: "unknown",
    liveCheckStatus: "not_checked",
    credentialAvailability: "not_required",
  };
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs",
    getRegistryInventoryFn: async () => [
      { id: "w", backend: "claude-code", model: "m", reasoningEffort: null, certification: null, cwd: "/r", sessionReuse: null, credentialAvailability: "not_required", missingCredentialEnvNames: [], providerReadiness: pr },
    ],
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "registry_list", arguments: {} });
    assert.equal(res.isError, undefined);
    assert.deepEqual(res.structuredContent.agents[0].providerReadiness, pr, "structuredContent carries providerReadiness");
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.deepEqual(parsed.agents[0].providerReadiness, pr, "text JSON carries providerReadiness");
  } finally {
    await client.close();
    await server.close();
  }
});

// ===== (e) Docs consistency machine guard =====

test("M12-6-FR02-E1: docs state the truth contract (no authenticated/entitled/live claim without probe)", () => {
  const usage = readFileSync(join(process.cwd(), "docs", "usage.md"), "utf8");
  assert.ok(usage.includes("providerReadiness"), "usage.md documents providerReadiness");
  assert.ok(usage.includes("authenticationStatus"), "usage.md documents authenticationStatus");
  assert.ok(usage.includes("liveCheckStatus"), "usage.md documents liveCheckStatus");
  assert.ok(usage.includes("not_checked"), "usage.md documents the not_checked closed value");
  assert.ok(usage.includes("subscription_access_disabled"), "usage.md documents the diagnosis code closed set");
  const arch = readFileSync(join(process.cwd(), "docs", "02-architecture.md"), "utf8");
  assert.ok(arch.includes("providerReadiness"), "architecture.md documents providerReadiness");
});
