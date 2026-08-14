// test/m12-9-mcpDispatchContract.test.js
//
// M12-9 Package B (MCP layer): the run_dispatch_contract_check ADVISORY tool +
// run_dispatch's executionProfileId integration, exercised over the in-memory
// MCP wire (the same path a real host uses).
//
// Contract (B1–B4):
//   - run_dispatch_contract_check shares run_dispatch's INPUT schema (same keys,
//     both strict) and the SAME application validators (shared resolver +
//     prepareDeliveryRequest). (B1)
//   - It is read-only / advisory / NOT a gate. Zero side effect. run_dispatch is
//     INDEPENDENT of it (never required, never reads its result). (B1)
//   - run_dispatch folds a selected profile's verification into the effective
//     delivery; unknown/conflict/no-verification collapse to the fixed dispatch
//     error with the dispatcher call count at 0. (B3)
//   - Output is bounded/strict/closed-set/safe. (B4)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

import { createWaoMcpServer } from "../../src/mcp/server.js";
import { CONTRACT_CHECK_ISSUE_CODES, CONTRACT_CHECK_SECTIONS } from "../../src/application/runDispatchContract.js";
import { EXECUTION_PROFILE_IDS } from "../../src/application/executionProfiles.js";

// ===== Helpers (mirrors mcpRunDispatch.test.js) =====

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function makeRegistry(dir, agents) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return registryPath;
}

function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n", "utf8");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m init", { cwd: dir, stdio: "pipe" });
}

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-test-client", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function withServer(fn, opts) {
  const dir = mkdtempSync(join(tmpdir(), "wao-m129-mcp-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const server = createWaoMcpServer({
      registryPath,
      runDir: dir,
      workspaceRoot: dir,
      ...opts,
    });
    const client = await buildInMemoryClient(server);
    try {
      await fn({ dir, server, client, registryPath });
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
}

// The output boundary (correction #4): a malformed or oversized service result is
// caught by the handler's strict .parse() and MUST collapse to this fixed shape —
// isError + the single opaque error text, with NO structuredContent crossing.
function assertFixedCollapse(res) {
  assert.equal(res.isError, true, "collapsed to isError");
  assert.deepEqual(
    res.content,
    [{ type: "text", text: "run_dispatch_contract_check failed" }],
    "fixed opaque error text — no dynamic/internal detail",
  );
  assert.equal(res.structuredContent, undefined, "no structuredContent crosses on collapse");
}

// ===== B1: schema shared + tool registered =====

test("B1: run_dispatch_contract_check is registered, read-only/idempotent, shares run_dispatch input schema", async () => {
  await withServer(async ({ client }) => {
    const { tools } = await client.listTools();
    const rd = tools.find((t) => t.name === "run_dispatch");
    const cc = tools.find((t) => t.name === "run_dispatch_contract_check");
    assert.ok(rd, "run_dispatch present");
    assert.ok(cc, "run_dispatch_contract_check present");
    // SAME input schema shape (shared RUN_DISPATCH_INPUT).
    const rdKeys = Object.keys(rd.inputSchema.properties ?? {}).sort();
    const ccKeys = Object.keys(cc.inputSchema.properties ?? {}).sort();
    assert.deepEqual(rdKeys, ccKeys, "shared input schema keys");
    assert.deepEqual(
      rdKeys,
      ["agentId", "continuable", "correctable", "delivery", "executionProfileId", "expectedDirty", "expectedGitHead", "expectedWorkspaceRoot", "prompt"],
      "input schema is the full run_dispatch surface (incl. M12-16 correctable)",
    );
    assert.equal(rd.inputSchema.additionalProperties, false, "run_dispatch strict");
    assert.equal(cc.inputSchema.additionalProperties, false, "contract_check strict");
    // Read-only / advisory annotations.
    assert.equal(cc.annotations.readOnlyHint, true, "read-only");
    assert.equal(cc.annotations.destructiveHint, false, "not destructive");
    assert.equal(cc.annotations.idempotentHint, true, "idempotent");
    assert.equal(cc.annotations.openWorldHint, false, "closed world");
    assert.ok(cc.outputSchema, "output schema declared");
  });
});

// ===== B4: bounded output over the wire =====

test("B4: precheck returns bounded advisory result over the wire — closed-set, profile counts only, no leak", async () => {
  await withServer(async ({ client }) => {
    const res = await client.callTool({
      name: "run_dispatch_contract_check",
      arguments: {
        agentId: "coder_low",
        prompt: "secret-prompt-text",
        delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"] },
        executionProfileId: "node-npm-ci-test-v1",
      },
    });
    const r = res.structuredContent ?? JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.equal(r.advisory, true);
    assert.equal(r.contractValid, true);
    for (const s of ["workspace", "registry", "contract"]) {
      assert.ok(["observed", "unknown"].includes(r.sections[s]), `section ${s} closed-set`);
    }
    assert.deepEqual(r.issueCodes, []);
    assert.equal(r.profile.id, "node-npm-ci-test-v1");
    assert.equal(r.profile.setupCommandCount, 1);
    assert.equal(r.profile.assertionCommandCount, 1);
    assert.deepEqual(Object.keys(r.profile).sort(), ["assertionCommandCount", "id", "setupCommandCount"]);
    // NO prompt text, command text, or credential/provider payload leaks.
    const blob = JSON.stringify(r);
    assert.ok(!blob.includes("secret-prompt-text"), "no prompt leak");
    assert.ok(!blob.includes("npm ci") && !blob.includes("npm test"), "no command text leak");
    // No gate/permit/authorization field is ever produced.
    assert.equal(r.permit, undefined);
    assert.equal(r.allowed, undefined);
  });
});

// ===== B4: production-parity missing-agent truth at the published MCP boundary =====
// withServer builds a REAL { coder_low } registry and the tool uses the REAL
// readRegistry (default). Production getAgent THROWS for an absent id, so this
// proves the published boundary reports agent_not_found truthfully (from the
// listAgents snapshot) and does NOT misread the missing id as registry_unreadable.

test("B4 (MCP boundary, production parity): missing agentId over the wire → registry observed + agent_not_found (NOT registry_unreadable)", async () => {
  await withServer(async ({ client }) => {
    const res = await client.callTool({
      name: "run_dispatch_contract_check",
      arguments: {
        agentId: "coder_mm", // absent from the real { coder_low } registry
        prompt: "x",
        delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"], verificationCommands: ["npm test"] },
      },
    });
    assert.equal(res.isError, undefined, "advisory structured result — not an MCP error");
    const r = res.structuredContent ?? JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.equal(r.sections.registry, "observed", "registry was readable");
    assert.ok(r.issueCodes.includes("agent_not_found"), "missing agent reported truthfully");
    assert.ok(!r.issueCodes.includes("registry_unreadable"), "missing agent must NOT be misreported as registry_unreadable at the MCP boundary");
  });
});

test("B4: precheck issueCodes is the frozen closed set; availableProfiles only when no profile selected", async () => {
  await withServer(async ({ client }) => {
    // No profile selected → bounded availableProfiles surfaced.
    const res = await client.callTool({
      name: "run_dispatch_contract_check",
      arguments: {
        agentId: "coder_low",
        prompt: "x",
        delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"], verificationCommands: ["npm test"] },
      },
    });
    const r = res.structuredContent ?? JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.equal(r.profile, null);
    assert.ok(Array.isArray(r.availableProfiles));
    assert.equal(r.availableProfiles.length, EXECUTION_PROFILE_IDS.length);
    for (const ap of r.availableProfiles) {
      assert.deepEqual(Object.keys(ap).sort(), ["assertionCommandCount", "id", "setupCommandCount", "summary"]);
      assert.ok(EXECUTION_PROFILE_IDS.includes(ap.id));
    }
    // Every possible issueCode the tool can emit must be a member of the closed set.
    for (const code of CONTRACT_CHECK_ISSUE_CODES) {
      assert.equal(typeof code, "string");
    }
  });
});

// ===== B1: zero side effect — precheck never dispatches =====

test("B1: precheck has zero side effect — a dispatch spy that throws is never reached", async () => {
  let dispatchCalls = 0;
  await withServer(async ({ client }) => {
    const res = await client.callTool({
      name: "run_dispatch_contract_check",
      arguments: {
        agentId: "coder_low",
        prompt: "x",
        delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"] },
        executionProfileId: "node-npm-test-v1",
      },
    });
    assert.equal(res.isError, undefined, "precheck must not error");
  }, {
    dispatchRunFn: async () => { dispatchCalls += 1; throw new Error("precheck must never dispatch"); },
  });
  assert.equal(dispatchCalls, 0, "precheck never reached the dispatcher");
});

// ===== B1: run_dispatch is INDEPENDENT of the precheck =====

test("B1: run_dispatch works without any prior precheck call (independence)", async () => {
  let dispatchCalls = 0;
  await withServer(async ({ client }) => {
    // No run_dispatch_contract_check call at all — straight to run_dispatch.
    const res = await client.callTool({
      name: "run_dispatch",
      arguments: {
        agentId: "coder_low",
        prompt: "do work",
        delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"], verificationCommands: ["npm test"] },
      },
    });
    assert.equal(res.isError, undefined, "run_dispatch succeeds without precheck");
  }, {
    dispatchRunFn: async (input) => {
      dispatchCalls += 1;
      // M12-25: providerSessionRouting is a required closed-set field on every
      // run_dispatch success output (no MCP fallback).
      return { accepted: true, runId: "run_indep", agentId: input.agentId, state: "pending", transcriptPath: "/x.jsonl", providerSessionRouting: "not_used" };
    },
  });
  assert.equal(dispatchCalls, 1, "dispatcher called exactly once");
});

// ===== B3: run_dispatch folds a selected profile into the effective delivery =====

test("B3: run_dispatch with executionProfileId folds profile verification into the delivery the dispatcher receives", async () => {
  let captured = null;
  let dispatchCalls = 0;
  await withServer(async ({ client }) => {
    const res = await client.callTool({
      name: "run_dispatch",
      arguments: {
        agentId: "coder_low",
        prompt: "do work",
        // delivery has NO inline verification — the profile supplies it.
        delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"] },
        executionProfileId: "node-npm-ci-test-v1",
      },
    });
    assert.equal(res.isError, undefined, "profile dispatch succeeds");
  }, {
    dispatchRunFn: async (input) => {
      dispatchCalls += 1;
      captured = input;
      // M12-25: providerSessionRouting is a required closed-set field on every
      // run_dispatch success output (no MCP fallback).
      return { accepted: true, runId: "run_prof", agentId: input.agentId, state: "pending", transcriptPath: "/x.jsonl", providerSessionRouting: "not_used" };
    },
  });
  assert.equal(dispatchCalls, 1, "dispatcher called once");
  assert.ok(captured.delivery, "dispatcher received a delivery");
  // The profile's verification commands are folded in; mode/allowedPaths are the Lead's.
  assert.deepEqual(captured.delivery.verificationCommands, ["npm test"]);
  assert.deepEqual(captured.delivery.verificationSetupCommands, ["npm ci"]);
  assert.equal(captured.delivery.mode, "git_commit_v1");
  assert.deepEqual(captured.delivery.allowedPaths, ["src/**"]);
});

// ===== B3: run_dispatch rejects bad contracts with the fixed error, count 0 =====

test("B3: run_dispatch with unknown profile id → fixed error, dispatcher count 0", async () => {
  let dispatchCalls = 0;
  await withServer(async ({ client }) => {
    const res = await client.callTool({
      name: "run_dispatch",
      arguments: {
        agentId: "coder_low",
        prompt: "x",
        delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"] },
        executionProfileId: "rust-cargo-test-v1",
      },
    });
    assert.equal(res.isError, true);
    assert.deepEqual(res.content, [{ type: "text", text: "run_dispatch failed" }]);
  }, {
    dispatchRunFn: async () => { dispatchCalls += 1; throw new Error("must not dispatch"); },
  });
  assert.equal(dispatchCalls, 0, "dispatcher never called for unknown profile");
});

test("B3: run_dispatch with profile + inline verification conflict → fixed error, count 0", async () => {
  let dispatchCalls = 0;
  await withServer(async ({ client }) => {
    const res = await client.callTool({
      name: "run_dispatch",
      arguments: {
        agentId: "coder_low",
        prompt: "x",
        delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"], verificationCommands: ["npm test"] },
        executionProfileId: "node-npm-test-v1",
      },
    });
    assert.equal(res.isError, true);
    assert.deepEqual(res.content, [{ type: "text", text: "run_dispatch failed" }]);
  }, {
    dispatchRunFn: async () => { dispatchCalls += 1; throw new Error("must not dispatch"); },
  });
  assert.equal(dispatchCalls, 0, "dispatcher never called on profile/inline conflict");
});

test("B3: run_dispatch with profile but no delivery → fixed error, count 0", async () => {
  let dispatchCalls = 0;
  await withServer(async ({ client }) => {
    const res = await client.callTool({
      name: "run_dispatch",
      arguments: {
        agentId: "coder_low",
        prompt: "x",
        executionProfileId: "node-npm-test-v1",
      },
    });
    assert.equal(res.isError, true);
  }, {
    dispatchRunFn: async () => { dispatchCalls += 1; throw new Error("must not dispatch"); },
  });
  assert.equal(dispatchCalls, 0, "dispatcher never called for profile without delivery");
});

test("B3: run_dispatch with delivery but no verification and no profile → fixed error, count 0", async () => {
  // Regression guard: removing the schema-level refine must NOT let a verification-
  // less delivery reach the dispatcher. The handler enforces it (call count stays 0).
  let dispatchCalls = 0;
  await withServer(async ({ client }) => {
    const res = await client.callTool({
      name: "run_dispatch",
      arguments: {
        agentId: "coder_low",
        prompt: "x",
        delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"] },
      },
    });
    assert.equal(res.isError, true);
  }, {
    dispatchRunFn: async () => { dispatchCalls += 1; throw new Error("must not dispatch"); },
  });
  assert.equal(dispatchCalls, 0, "dispatcher never called for verification-less delivery");
});

// ===== B1: precheck advisory never blocks — even an unknown profile reports, not errors =====

test("B1: precheck reports an unknown profile as advisory code, never throws/gates", async () => {
  await withServer(async ({ client }) => {
    const res = await client.callTool({
      name: "run_dispatch_contract_check",
      arguments: {
        agentId: "coder_low",
        prompt: "x",
        delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"] },
        executionProfileId: "rust-cargo-test-v1",
      },
    });
    assert.equal(res.isError, undefined, "advisory tool must not error");
    const r = res.structuredContent ?? JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.equal(r.advisory, true);
    assert.equal(r.contractValid, false);
    assert.ok(r.issueCodes.includes("profile_unknown"));
    assert.equal(r.profile, null);
  });
});

// ===== B5/SSOT: the frozen closed sets that bound the output schema =====

test("B5/SSOT: issue/section/profile closed sets are frozen, unique, and of stable shape", () => {
  // These three frozen sets are the single SSOT the MCP output schema derives its
  // maxima from (issueCodes.max / observations.max / availableProfiles.max). A
  // regression that introduces a second hand-maintained allowlist would show up
  // here as a size/shape drift.
  assert.ok(Object.isFrozen(CONTRACT_CHECK_ISSUE_CODES), "issue codes frozen");
  assert.ok(Object.isFrozen(CONTRACT_CHECK_SECTIONS), "sections frozen");
  assert.ok(Object.isFrozen(EXECUTION_PROFILE_IDS), "profile ids frozen");
  // Sections are the advisory surface the service inits from (and observations.max).
  assert.deepEqual([...CONTRACT_CHECK_SECTIONS], ["workspace", "registry", "contract"]);
  // Closed sets are non-empty and de-duplicated.
  assert.ok(CONTRACT_CHECK_ISSUE_CODES.length >= 1);
  assert.equal(new Set(CONTRACT_CHECK_ISSUE_CODES).size, CONTRACT_CHECK_ISSUE_CODES.length, "issue codes unique");
  assert.ok(EXECUTION_PROFILE_IDS.length >= 1);
  assert.equal(new Set(EXECUTION_PROFILE_IDS).size, EXECUTION_PROFILE_IDS.length, "profile ids unique");
});

// ===== B4: output boundary — malformed/oversized service output collapses =====
//
// Causal proof of correction #4 (parse RUN_DISPATCH_CONTRACT_CHECK_OUTPUT and
// return only the parsed object) + #5 (maxima derived from the closed sets). The
// service is injected to return a shape that is individually valid but violates
// ONE boundary; the handler's strict .parse() must reject it and collapse to the
// fixed error — the offending value can never reach the wire.

function validAvailableProfile(id) {
  return { id, setupCommandCount: 1, assertionCommandCount: 1, summary: "s" };
}

test("B4/output-boundary: a malformed service result (unknown internal field) collapses, nothing crosses", async () => {
  await withServer(async ({ client }) => {
    const res = await client.callTool({
      name: "run_dispatch_contract_check",
      arguments: {
        agentId: "coder_low",
        prompt: "x",
        delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"] },
        executionProfileId: "node-npm-test-v1",
      },
    });
    assertFixedCollapse(res);
  }, {
    runDispatchContractCheckFn: async () => ({
      advisory: true,
      contractValid: true,
      sections: { workspace: "observed", registry: "observed", contract: "observed" },
      issueCodes: [],
      observations: [],
      profile: null,
      // Unknown/internal field the strict schema must NOT forward to the host.
      internalTranscriptPath: "/tmp/secret.jsonl",
    }),
  });
});

test("B4/output-boundary: an oversized issueCodes array collapses (cap = CONTRACT_CHECK_ISSUE_CODES.length)", async () => {
  await withServer(async ({ client }) => {
    const res = await client.callTool({
      name: "run_dispatch_contract_check",
      arguments: {
        agentId: "coder_low",
        prompt: "x",
        delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"] },
        executionProfileId: "node-npm-test-v1",
      },
    });
    assertFixedCollapse(res);
  }, {
    runDispatchContractCheckFn: async () => ({
      advisory: true,
      contractValid: false,
      sections: { workspace: "observed", registry: "observed", contract: "observed" },
      // Every entry is a valid code; only the LENGTH exceeds the cap.
      issueCodes: [...CONTRACT_CHECK_ISSUE_CODES, CONTRACT_CHECK_ISSUE_CODES[0]],
      observations: [],
      profile: null,
    }),
  });
});

test("B4/output-boundary: an oversized observations array collapses (cap = CONTRACT_CHECK_SECTIONS.length)", async () => {
  await withServer(async ({ client }) => {
    const res = await client.callTool({
      name: "run_dispatch_contract_check",
      arguments: {
        agentId: "coder_low",
        prompt: "x",
        delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"] },
        executionProfileId: "node-npm-test-v1",
      },
    });
    assertFixedCollapse(res);
  }, {
    runDispatchContractCheckFn: async () => ({
      advisory: true,
      contractValid: true,
      sections: { workspace: "observed", registry: "observed", contract: "observed" },
      issueCodes: [],
      // One more observation than sections exist.
      observations: ["a", "b", "c", "d"],
      profile: null,
    }),
  });
});

test("B4/output-boundary: an oversized availableProfiles array collapses (cap = EXECUTION_PROFILE_IDS.length)", async () => {
  await withServer(async ({ client }) => {
    const res = await client.callTool({
      name: "run_dispatch_contract_check",
      arguments: {
        agentId: "coder_low",
        prompt: "x",
        delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"] },
        executionProfileId: "node-npm-test-v1",
      },
    });
    assertFixedCollapse(res);
  }, {
    runDispatchContractCheckFn: async () => ({
      advisory: true,
      contractValid: true,
      sections: { workspace: "observed", registry: "observed", contract: "observed" },
      issueCodes: [],
      observations: [],
      // A profile IS selected (so availableProfiles is unusual here), yet the cap
      // must still bound it — one more entry than the catalog holds.
      profile: { id: "node-npm-test-v1", setupCommandCount: 1, assertionCommandCount: 1 },
      availableProfiles: Array.from({ length: EXECUTION_PROFILE_IDS.length + 1 }, (_, i) =>
        validAvailableProfile(EXECUTION_PROFILE_IDS[i % EXECUTION_PROFILE_IDS.length])),
    }),
  });
});
