// test/m12-9-dispatchContractCheck.test.js
//
// M12-9 Package B (RED→GREEN): run_dispatch_contract_check — the OPTIONAL
// read-only / ADVISORY dispatch-contract precheck. It is NOT a gate.
//
// Contract (B1/B4):
//   - Single tool, advisory=true always. warning/unknown/contractValid=false do
//     NOT auto-block an independent run_dispatch (B1).
//   - Shares the SAME MCP input schema + the SAME application validators as
//     run_dispatch (the shared resolver + prepareDeliveryRequest). (B1)
//   - registry/workspace/contract sections settle INDEPENDENTLY; a read failure
//     is "unknown" — never faked as empty or pass. (B4)
//   - Output is bounded/strict/closed-set/safe: advisory, contractValid, section
//     statuses, issueCodes, observations, selected profile (id + setup/assertion
//     counts only). NO prompt, command text, absolute path, credential,
//     PID/session/provider payload. availableProfiles (id + counts + fixed
//     summary, NO commands) only when no profile is selected. (B4)
//   - Zero side effect: never dispatches/forks/writes transcript; run_dispatch
//     does not depend on it having run. (B1)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDispatchContractCheck, CONTRACT_CHECK_ISSUE_CODES } from "../src/application/runDispatchContract.js";
import { EXECUTION_PROFILE_IDS } from "../src/application/executionProfiles.js";
import { JsonlTranscript } from "../src/transcript.js";
import { readRegistry } from "../src/registry.js";

function cleanupDir(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

// A production-parity fake registry (injectable readRegistryFn). It mirrors the
// REAL registry.js contract the precheck now consumes: listAgents() returns the
// snapshot of (minimally-shaped) agents, and getAgent(id) THROWS for a missing
// id — it NEVER returns undefined. The precheck decides presence from the
// listAgents() snapshot by exact-id match; the throwing getAgent is retained
// ONLY as a regression tripwire — if the precheck ever regressed to calling
// getAgent for a missing id, the throw would be caught as registry_unreadable
// and the agent_not_found tests below would fail. (Full registry normalization
// is covered by registry.test.js; the precheck reads agent.id only.)
function fakeRegistry(presentIds) {
  const ids = [...presentIds];
  return async () => ({
    listAgents: () => ids.map((id) => ({ id })),
    getAgent: (id) => {
      if (!ids.includes(id)) throw new Error(`Unknown agent: ${id}`);
      return { id };
    },
  });
}

// Writes a REAL agents.json and returns its path, for causal tests that inject
// the REAL readRegistry (no fake) — proving the missing-agent truth holds under
// production behavior where getAgent THROWS for an absent id.
function writeRealRegistry(dir, agents) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return registryPath;
}

const BOUND = { bound: true, source: "lead_session", root: "/tmp/repo" };

test("B4: output shape is bounded — advisory true, closed-set sections, profile counts only", async () => {
  const r = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "do work",
    delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"] },
    executionProfileId: "node-npm-ci-test-v1",
    workspaceBinding: BOUND,
    registryPath: "ignored",
    readRegistryFn: fakeRegistry(["coder_low"]),
  });
  assert.equal(r.advisory, true);
  assert.equal(r.contractValid, true);
  // Sections are closed-set observed|unknown.
  for (const s of ["workspace", "registry", "contract"]) {
    assert.ok(["observed", "unknown"].includes(r.sections[s]), `section ${s} closed-set`);
    assert.equal(r.sections[s], "observed");
  }
  assert.deepEqual(r.issueCodes, []);
  // Selected profile exposes ONLY id + counts — never command text.
  assert.equal(r.profile.id, "node-npm-ci-test-v1");
  assert.equal(r.profile.setupCommandCount, 1);
  assert.equal(r.profile.assertionCommandCount, 1);
  assert.deepEqual(Object.keys(r.profile).sort(), ["assertionCommandCount", "id", "setupCommandCount"]);
  // availableProfiles omitted once a profile is selected.
  assert.equal(r.availableProfiles, undefined);
  // No prompt/command/path/credential leak anywhere in the payload.
  const blob = JSON.stringify(r);
  assert.ok(!blob.includes("do work"), "no prompt text");
  assert.ok(!blob.includes("npm ci") && !blob.includes("npm test"), "no command text");
  assert.ok(!blob.includes("/tmp/repo"), "no absolute workspace path");
});

test("B4: with no profile selected, bounded availableProfiles (id+counts+summary, no commands) is returned", async () => {
  const r = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "x",
    delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"], verificationCommands: ["npm test"] },
    workspaceBinding: BOUND,
    registryPath: "ignored",
    readRegistryFn: fakeRegistry(["coder_low"]),
  });
  assert.equal(r.profile, null);
  assert.ok(Array.isArray(r.availableProfiles));
  assert.equal(r.availableProfiles.length, EXECUTION_PROFILE_IDS.length);
  for (const ap of r.availableProfiles) {
    assert.deepEqual(Object.keys(ap).sort(), ["assertionCommandCount", "id", "setupCommandCount", "summary"]);
    assert.ok(EXECUTION_PROFILE_IDS.includes(ap.id));
  }
  const blob = JSON.stringify(r.availableProfiles);
  assert.ok(!blob.includes("npm test") && !blob.includes("python -m pytest"), "no command text in availableProfiles");
});

test("B4: issueCodes is a closed set (CONTRACT_CHECK_ISSUE_CODES)", () => {
  // Every code the service can emit must be a member of the frozen closed set.
  assert.ok(Array.isArray(CONTRACT_CHECK_ISSUE_CODES));
  for (const c of ["profile_unknown", "profile_requires_delivery", "profile_inline_conflict", "delivery_invalid", "invalid_verification_path", "workspace_unbound", "registry_unreadable", "agent_not_found"]) {
    assert.ok(CONTRACT_CHECK_ISSUE_CODES.includes(c), `closed set must include ${c}`);
  }
});

test("B3/B4: unknown profile id → contract section observed, issueCode profile_unknown, contractValid false (advisory)", async () => {
  const r = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "x",
    delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"] },
    executionProfileId: "rust-cargo-test-v1",
    workspaceBinding: BOUND,
    registryPath: null,
  });
  assert.equal(r.contractValid, false);
  assert.ok(r.issueCodes.includes("profile_unknown"));
  assert.equal(r.profile, null);
});

test("B3/B4: profile + inline verification conflict → issueCode profile_inline_conflict", async () => {
  const r = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "x",
    delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"], verificationCommands: ["npm test"] },
    executionProfileId: "node-npm-test-v1",
    workspaceBinding: BOUND,
    registryPath: null,
  });
  assert.equal(r.contractValid, false);
  assert.ok(r.issueCodes.includes("profile_inline_conflict"));
});

test("B3/B4: profile without delivery → issueCode profile_requires_delivery", async () => {
  const r = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "x",
    delivery: undefined,
    executionProfileId: "node-npm-test-v1",
    workspaceBinding: BOUND,
    registryPath: null,
  });
  assert.equal(r.contractValid, false);
  assert.ok(r.issueCodes.includes("profile_requires_delivery"));
});

test("B4: invalid verification path → issueCode invalid_verification_path (shared prepareDeliveryRequest SSOT)", async () => {
  // An absolute path literal in a verification command is statically rejected by
  // prepareDeliveryRequest — the SAME SSOT run_dispatch uses.
  const r = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "x",
    delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"], verificationCommands: ["/etc/passwd"] },
    workspaceBinding: BOUND,
    registryPath: null,
  });
  assert.equal(r.contractValid, false);
  assert.ok(r.issueCodes.includes("invalid_verification_path"));
});

test("B4: sections settle independently — registry read failure is unknown, not faked empty/pass", async () => {
  const r = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "x",
    delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"], verificationCommands: ["npm test"] },
    workspaceBinding: BOUND,
    registryPath: join(tmpdir(), "definitely-missing-agents.json"),
  });
  // registry unreadable → unknown (NOT observed, NOT faked pass).
  assert.equal(r.sections.registry, "unknown");
  assert.ok(r.issueCodes.includes("registry_unreadable"));
  // contract + workspace are STILL settled independently.
  assert.equal(r.sections.contract, "observed");
  assert.equal(r.contractValid, true);
  assert.equal(r.sections.workspace, "observed");
});

test("B4: workspace resolver threw → workspace section unknown (not faked unbound)", async () => {
  const r = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "x",
    delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"], verificationCommands: ["npm test"] },
    workspaceBinding: null, // resolver threw
    registryPath: null,
  });
  assert.equal(r.sections.workspace, "unknown");
  // contract still settles independently.
  assert.equal(r.sections.contract, "observed");
  assert.equal(r.contractValid, true);
});

test("B4: unbound workspace → workspace observed, issueCode workspace_unbound (advisory)", async () => {
  const r = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "x",
    delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"], verificationCommands: ["npm test"] },
    workspaceBinding: { bound: false },
    registryPath: null,
  });
  assert.equal(r.sections.workspace, "observed");
  assert.ok(r.issueCodes.includes("workspace_unbound"));
  // workspace unbound is advisory — the contract itself can still be valid.
  assert.equal(r.contractValid, true);
});

test("B4 (production-parity fake): agent not in snapshot → registry observed + agent_not_found (NOT registry_unreadable)", async () => {
  // The fake's getAgent THROWS for a missing id (production truth). The precheck
  // must decide presence from the listAgents() snapshot, so the throw is never
  // reached; a missing id is agent_not_found, never misread as a read failure.
  const r = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "x",
    delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"], verificationCommands: ["npm test"] },
    workspaceBinding: BOUND,
    registryPath: "ignored",
    readRegistryFn: fakeRegistry(["coder_mm"]),
  });
  assert.equal(r.sections.registry, "observed");
  assert.ok(r.issueCodes.includes("agent_not_found"));
  assert.ok(!r.issueCodes.includes("registry_unreadable"), "missing id must not be misread as registry_unreadable");
});

// ===== Causal registry tests against the REAL production readRegistry =====
// These inject the REAL readRegistry from src/registry.js (no fake), proving the
// missing-agent truth holds under production behavior where getAgent THROWS for
// an absent id and listAgents() is the snapshot SSOT.

test("B4 (real registry): present agent → registry observed, no agent_not_found, no registry_unreadable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dcc-real-present-"));
  try {
    const registryPath = writeRealRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const r = await runDispatchContractCheck({
      agentId: "coder_low",
      prompt: "x",
      delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"], verificationCommands: ["npm test"] },
      workspaceBinding: BOUND,
      registryPath,
      readRegistryFn: readRegistry,
    });
    assert.equal(r.sections.registry, "observed");
    assert.ok(!r.issueCodes.includes("agent_not_found"));
    assert.ok(!r.issueCodes.includes("registry_unreadable"));
  } finally { cleanupDir(dir); }
});

test("B4 (real registry): missing agent → registry observed + agent_not_found (production getAgent THROWS; NOT registry_unreadable)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dcc-real-missing-"));
  try {
    const registryPath = writeRealRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const r = await runDispatchContractCheck({
      agentId: "coder_mm", // absent — production getAgent("coder_mm") would THROW
      prompt: "x",
      delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"], verificationCommands: ["npm test"] },
      workspaceBinding: BOUND,
      registryPath,
      readRegistryFn: readRegistry,
    });
    assert.equal(r.sections.registry, "observed");
    assert.ok(r.issueCodes.includes("agent_not_found"));
    assert.ok(!r.issueCodes.includes("registry_unreadable"), "missing agent must NOT be misreported as registry_unreadable");
  } finally { cleanupDir(dir); }
});

test("B4 (real registry): malformed agent entry → registry_unreadable (genuine normalization failure), NOT agent_not_found", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dcc-real-malformed-"));
  try {
    // Missing backend → normalizeAgent throws inside listAgents() while reading
    // the snapshot. This is a genuine read/normalization failure (the same
    // failure that makes registry_list / getRegistryInventory throw), not a
    // simple absence — so registry_unreadable (section unknown) is correct and
    // agent_not_found must NOT be emitted.
    const registryPath = writeRealRegistry(dir, { coder_low: { cwd: dir } });
    const r = await runDispatchContractCheck({
      agentId: "coder_low",
      prompt: "x",
      delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"], verificationCommands: ["npm test"] },
      workspaceBinding: BOUND,
      registryPath,
      readRegistryFn: readRegistry,
    });
    assert.equal(r.sections.registry, "unknown");
    assert.ok(r.issueCodes.includes("registry_unreadable"));
    assert.ok(!r.issueCodes.includes("agent_not_found"), "a normalization failure is not an agent_not_found");
  } finally { cleanupDir(dir); }
});

test("B1: zero side effect — no transcript write, no dispatch, no fork", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dcc-sideeff-"));
  try {
    const transcriptPath = join(dir, "run_x.jsonl");
    // Nothing writes here. We also assert no fork by passing spies that would
    // throw if the service ever reached for a dispatcher/spawn.
    const r = await runDispatchContractCheck({
      agentId: "coder_low",
      prompt: "x",
      delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"] },
      executionProfileId: "node-npm-test-v1",
      workspaceBinding: BOUND,
      registryPath: "ignored",
      readRegistryFn: fakeRegistry(["coder_low"]),
      dispatchSpy: () => { throw new Error("precheck must never dispatch"); },
      spawnSpy: () => { throw new Error("precheck must never spawn"); },
    });
    assert.equal(r.advisory, true);
    let exists = false;
    try { readFileSync(transcriptPath, "utf8"); exists = true; } catch { /* expected absent */ }
    assert.equal(exists, false, "precheck must not write any transcript");
  } finally { cleanupDir(dir); }
});

test("B1: advisory never blocks — contractValid=false/unknown are reported, not gating", async () => {
  // A precheck that finds problems still returns advisory=true and a structured
  // result (never throws, never returns a permit/deny). run_dispatch is independent.
  const r = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "x",
    delivery: undefined,
    executionProfileId: "node-npm-test-v1",
    workspaceBinding: null,
    registryPath: join(tmpdir(), "missing.json"),
  });
  assert.equal(r.advisory, true);
  assert.equal(r.contractValid, false);
  // No permit/token/gate field is ever produced.
  assert.equal(r.permit, undefined);
  assert.equal(r.passed, undefined);
  assert.equal(r.allowed, undefined);
});

test("B4: profile selected + delivery valid → contractValid true and profile counts reflect the profile", async () => {
  const r = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "x",
    delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"] },
    executionProfileId: "python-pytest-v1",
    workspaceBinding: BOUND,
    registryPath: null,
  });
  assert.equal(r.contractValid, true);
  assert.equal(r.profile.id, "python-pytest-v1");
  assert.equal(r.profile.setupCommandCount, 0);
  assert.equal(r.profile.assertionCommandCount, 1);
});
