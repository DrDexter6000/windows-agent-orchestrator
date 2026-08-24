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

import {
  runDispatchContractCheck,
  CONTRACT_CHECK_ISSUE_CODES,
  extractReferencedRelativePaths,
} from "../../src/application/runDispatchContract.js";
import { EXECUTION_PROFILE_IDS } from "../../src/application/executionProfiles.js";
import { JsonlTranscript } from "../../src/transcript.js";
import { readRegistry } from "../../src/registry.js";
import { prepareDeliveryRequest } from "../../src/delivery.js";

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
  for (const c of ["profile_unknown", "profile_requires_delivery", "profile_inline_conflict", "delivery_invalid", "invalid_verification_path", "workspace_unbound", "registry_unreadable", "agent_not_found", "referenced_path_probe_miss"]) {
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

// ===== M12-13 (Problem B): the per-command execution timeout must flow through
// buildEffectiveDelivery to the shared structural validator, so a direct
// application-service contract check cannot report contractValid=true for an
// invalid timeout. Valid + invalid values are classified by the SAME shared
// SSOT run_dispatch uses (prepareDeliveryRequest). Advisory semantics preserved:
// the result never gates or permits run_dispatch.

test("M12-13-CONTRACT-TIMEOUT-OK: a valid contract-check verificationTimeoutMs reaches the shared validator and keeps contractValid true", async () => {
  let captured = null;
  const r = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "x",
    delivery: {
      mode: "git_commit_v1",
      allowedPaths: ["src/**"],
      verificationCommands: ["npm test"],
      verificationTimeoutMs: 600000,
    },
    workspaceBinding: BOUND,
    registryPath: "ignored",
    readRegistryFn: fakeRegistry(["coder_low"]),
    // Delegating spy: record the effective delivery the service built, then
    // delegate to the REAL shared SSOT so classification is authentic.
    prepareDeliveryRequestFn: (delivery) => {
      captured = delivery;
      return prepareDeliveryRequest(delivery);
    },
  });
  // The declared timeout reached the shared structural validator (not dropped).
  assert.equal(captured.verificationTimeoutMs, 600000,
    "buildEffectiveDelivery forwards verificationTimeoutMs to prepareDeliveryRequest");
  assert.equal(r.contractValid, true, "a valid timeout keeps the contract valid");
  assert.ok(!r.issueCodes.includes("delivery_invalid"), "no delivery_invalid for a valid timeout");
  assert.equal(r.advisory, true, "advisory semantics preserved");
});

test("M12-13-CONTRACT-TIMEOUT-OK-PROFILE: a valid verificationTimeoutMs survives the execution-profile fold (profile supplies commands; Lead timeout preserved)", async () => {
  let captured = null;
  const r = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "x",
    delivery: {
      mode: "git_commit_v1",
      allowedPaths: ["src/**"],
      verificationTimeoutMs: 600000,
    },
    executionProfileId: "node-npm-test-v1",
    workspaceBinding: BOUND,
    registryPath: "ignored",
    readRegistryFn: fakeRegistry(["coder_low"]),
    prepareDeliveryRequestFn: (delivery) => { captured = delivery; return prepareDeliveryRequest(delivery); },
  });
  assert.equal(captured.verificationCommands.join(" "), "npm test", "profile still supplies the commands");
  assert.equal(captured.verificationTimeoutMs, 600000, "profile fold must NOT drop the declared timeout");
  assert.equal(r.contractValid, true);
});

test("M12-13-CONTRACT-TIMEOUT-INVALID: an invalid contract-check verificationTimeoutMs is classified by the shared validator as delivery_invalid (contractValid false)", async () => {
  for (const bad of ["600000", 600000.5, 999, 7200001, null]) {
    const r = await runDispatchContractCheck({
      agentId: "coder_low",
      prompt: "x",
      delivery: {
        mode: "git_commit_v1",
        allowedPaths: ["src/**"],
        verificationCommands: ["npm test"],
        verificationTimeoutMs: bad,
      },
      workspaceBinding: BOUND,
      registryPath: "ignored",
      readRegistryFn: fakeRegistry(["coder_low"]),
    });
    assert.equal(r.contractValid, false,
      `invalid timeout ${JSON.stringify(bad)} → contractValid false`);
    assert.ok(r.issueCodes.includes("delivery_invalid"),
      `invalid timeout ${JSON.stringify(bad)} classified by the shared validator as delivery_invalid`);
    assert.equal(r.advisory, true, "advisory semantics preserved even on an invalid contract");
  }
});

// ===== TD-157: referenced-path advisory probe (fail-open; never gates) =====
//
// The probe extracts relative-path-looking literals from the RESOLVED effective
// verification assertion+setup commands (inline AND profile states) plus the
// allowedPaths entries, stats them against the bound workspace root through an
// INJECTED predicate (path semantics never touch the real fs here), and emits
// ONE section-level advisory code on a definite miss. contractValid must NEVER
// flip because of it — that is the whole point of TD-157: the probe reports,
// it never gates.

const PROBE_WS = { bound: true, source: "lead_session", root: "/ws" };

// Injected fake-fs existence predicate. The service hands us ABSOLUTE joined
// paths; normalize separators and read the relative tail after the "/ws/"
// binding-root marker. `throwOn` simulates non-ENOENT fs errors (EACCES …) so
// fail-open behavior is provable without touching a real filesystem.
function fakeWorkspaceFs(existingRelPaths, throwOnRelPaths = []) {
  const existing = new Set(existingRelPaths);
  const throwOn = new Set(throwOnRelPaths);
  return (absPath) => {
    const norm = String(absPath).split("\\").join("/");
    const at = norm.lastIndexOf("/ws/");
    if (at < 0) return false;
    const rel = norm.slice(at + 4);
    if (throwOn.has(rel)) {
      const e = new Error(`EACCES: permission denied, stat '${rel}'`);
      e.code = "EACCES";
      throw e;
    }
    return existing.has(rel);
  };
}

test("TD-157-EXTRACT: flags are never collected; bare path-shaped values are", () => {
  // "--input" and "-v" start with "-" → skipped entirely (even though --input
  // carries a value); "app.js"/"data.json"/"tests/unit/a.spec.js" are bare
  // tokens with a common suffix or "/" → collected.
  assert.deepEqual(
    extractReferencedRelativePaths(["node app.js --input data.json -v"]),
    ["app.js", "data.json"],
  );
  assert.deepEqual(
    extractReferencedRelativePaths(['npx vitest run "tests/unit/app.spec.js"']),
    ["tests/unit/app.spec.js"],
    "a quoted region is one literal and its relative path is collected",
  );
});

test("TD-157-EXTRACT: absolute / drive / URL literals are never probed as relative candidates", () => {
  assert.deepEqual(
    extractReferencedRelativePaths([
      "/usr/bin/node build.js",
      "python C:\\tools\\run.py",
      "curl https://api.example.com/v1/data.json",
    ]),
    ["build.js"],
    "only the genuinely relative token survives",
  );
});

test("TD-157-EXTRACT: multi-command extraction is deduplicated across setup + assertion order", () => {
  assert.deepEqual(
    extractReferencedRelativePaths([
      "node src/a.js",
      "npm run lint",
      "bash scripts/setup.sh",
      "node src/a.js",
      "test src/b.json",
    ]),
    ["src/a.js", "scripts/setup.sh", "src/b.json"],
    "repeats collapse to first occurrence; path-less words are ignored",
  );
});

test("TD-157-EXTRACT: glob metacharacters and .. traversal segments are never probed", () => {
  assert.deepEqual(
    extractReferencedRelativePaths(["vitest run 'src/**/*.spec.js'"]),
    [],
    "a glob may legally match nothing as a literal",
  );
  assert.deepEqual(
    extractReferencedRelativePaths(["node ../escape/x.js"]),
    [],
    ".. must never leave the workspace root",
  );
});

test("TD-157-SVC-PASS: referenced paths that exist under the bound root emit NO issue code", async () => {
  const r = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "x",
    delivery: {
      mode: "git_commit_v1",
      allowedPaths: ["src/**"],
      verificationCommands: ["node scripts/gen.mjs", "bash scripts/setup.sh"],
    },
    workspaceBinding: PROBE_WS,
    registryPath: null,
    pathExistsFn: fakeWorkspaceFs(["scripts/gen.mjs", "scripts/setup.sh", "src"]),
  });
  assert.ok(!r.issueCodes.includes("referenced_path_probe_miss"), "existing refs stay silent");
  assert.equal(r.contractValid, true);
});

test("TD-157-SVC-MISS: a missing referenced path emits the code AND contractValid stays true (fail-open pin)", async () => {
  const r = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "x",
    delivery: {
      mode: "git_commit_v1",
      allowedPaths: ["src/**"],
      verificationCommands: ["node tools/report/gen.mjs"],
    },
    workspaceBinding: PROBE_WS,
    registryPath: null,
    pathExistsFn: fakeWorkspaceFs(["src"]),
  });
  assert.ok(r.issueCodes.includes("referenced_path_probe_miss"), "missing ref is reported");
  assert.equal(r.contractValid, true,
    "the probe is section-level advisory — it must NEVER flip contractValid");
  assert.equal(r.sections.contract, "observed");
  assert.equal(r.advisory, true);
  // Fixed observation text only — dynamic paths are never echoed.
  const blob = JSON.stringify(r);
  assert.ok(!blob.includes("tools/report/gen.mjs"), "no dynamic path in the result");
  assert.ok(!blob.includes("/ws"), "no absolute root echo in the result");
  assert.ok(
    r.observations.some((o) => o === "one or more referenced relative paths were not found under the bound workspace (advisory probe; reported only)"),
    "the fixed observation string accompanies the code",
  );
});

test("TD-157-SVC-SETUP: verificationSetupCommands are probed exactly like assertion commands", async () => {
  const clean = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "x",
    delivery: {
      mode: "git_commit_v1",
      allowedPaths: ["src/**"],
      verificationSetupCommands: ["bash ops/bootstrap/seed.sh"],
      verificationCommands: ["npm test"],
    },
    workspaceBinding: PROBE_WS,
    registryPath: null,
    pathExistsFn: fakeWorkspaceFs(["ops/bootstrap/seed.sh", "src"]),
  });
  assert.ok(!clean.issueCodes.includes("referenced_path_probe_miss"));

  const missing = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "x",
    delivery: {
      mode: "git_commit_v1",
      allowedPaths: ["src/**"],
      verificationSetupCommands: ["bash ops/bootstrap/seed.sh"],
      verificationCommands: ["npm test"],
    },
    workspaceBinding: PROBE_WS,
    registryPath: null,
    pathExistsFn: fakeWorkspaceFs(["src"]),
  });
  assert.ok(missing.issueCodes.includes("referenced_path_probe_miss"),
    "a missing SETUP-referenced path fires the probe too");
  assert.equal(missing.contractValid, true, "still advisory-only for setup commands");
});

test("TD-157-SVC-PROFILE: profile-resolved commands reach the probe (not just inline literals)", async () => {
  // The resolver is injected to return a PROFILE-source resolution whose folded
  // commands reference a missing path — proving the probe consumes the RESOLVED
  // effective commands, so inline and profile states are covered by one path.
  const r = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "x",
    delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"] },
    executionProfileId: "custom-mechanical-v1",
    resolveVerificationFn: () => ({
      ok: true,
      source: "profile",
      profileId: "custom-mechanical-v1",
      verification: {
        commands: ["node audit/check.mjs"],
        setupCommands: [],
        unavailableReason: null,
      },
    }),
    workspaceBinding: PROBE_WS,
    registryPath: null,
    pathExistsFn: fakeWorkspaceFs(["src"]),
  });
  assert.ok(r.issueCodes.includes("referenced_path_probe_miss"),
    "profile-folded commands are probed");
  assert.equal(r.contractValid, true);
});

test("TD-157-SVC-ALLOWEDPATH: entry + parent both missing is a strong typo signal; parent-exists / top-level misses stay silent", async () => {
  const call = (allowedPaths, existing) => runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "x",
    delivery: {
      mode: "git_commit_v1",
      allowedPaths,
      verificationCommands: ["npm test"],
    },
    workspaceBinding: PROBE_WS,
    registryPath: null,
    pathExistsFn: fakeWorkspaceFs(existing),
  });

  const typo = await call(["lib-typo/deep/**"], ["src"]);
  assert.ok(typo.issueCodes.includes("referenced_path_probe_miss"),
    "neither the entry base nor its parent exists → strong typo signal");

  const parentExists = await call(["docs/new-guide.md"], ["docs"]);
  assert.ok(!parentExists.issueCodes.includes("referenced_path_probe_miss"),
    "parent directory exists → plausibly a NEW file being added, not a typo");

  const topLevel = await call(["brand-new-top.md"], []);
  assert.ok(!topLevel.issueCodes.includes("referenced_path_probe_miss"),
    "a top-level entry's parent IS the bound root — a lone top-level miss never fires");
});

test("TD-157-SVC-DEDUPE: many simultaneous misses still emit the code exactly once", async () => {
  const r = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "x",
    delivery: {
      mode: "git_commit_v1",
      allowedPaths: ["lib-typo/deep/**"],
      verificationCommands: ["node gone/a.mjs"],
      verificationSetupCommands: ["bash gone/b.sh"],
    },
    workspaceBinding: PROBE_WS,
    registryPath: null,
    pathExistsFn: fakeWorkspaceFs([]),
  });
  assert.equal(
    r.issueCodes.filter((c) => c === "referenced_path_probe_miss").length,
    1,
    "one closed-set label per check, however many references missed",
  );
  assert.equal(r.contractValid, true);
});

test("TD-157-SVC-FILOPEN: fs errors are silently skipped — uncertainty never becomes a defect", async () => {
  const throwing = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "x",
    delivery: {
      mode: "git_commit_v1",
      allowedPaths: ["src/**"],
      verificationCommands: ["node gone/a.mjs"],
    },
    workspaceBinding: PROBE_WS,
    registryPath: null,
    pathExistsFn: fakeWorkspaceFs([], ["gone/a.mjs"]), // EACCES on the only candidate
  });
  assert.ok(!throwing.issueCodes.includes("referenced_path_probe_miss"),
    "an fs error on a candidate is skipped, not mis-reported as a miss");
  assert.equal(throwing.contractValid, true);

  const granular = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "x",
    delivery: {
      mode: "git_commit_v1",
      allowedPaths: ["src/**"],
      verificationCommands: ["node gone/a.mjs gone/b.mjs"],
    },
    workspaceBinding: PROBE_WS,
    registryPath: null,
    // One candidate throws, the other definitely misses — skip is PER-CHECK:
    // the definite miss still surfaces while the erroring one stays silent.
    pathExistsFn: fakeWorkspaceFs([], ["gone/a.mjs"]),
  });
  assert.ok(granular.issueCodes.includes("referenced_path_probe_miss"),
    "per-check fail-open: other candidates are still probed after one errors");
});

test("TD-157-SVC-GATE: no probe without a usable contract or a bound root", async () => {
  const unbound = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "x",
    delivery: {
      mode: "git_commit_v1",
      allowedPaths: ["gone/deep/**"],
      verificationCommands: ["node gone/a.mjs"],
    },
    workspaceBinding: { bound: false },
    registryPath: null,
    pathExistsFn: fakeWorkspaceFs([]),
  });
  assert.ok(unbound.issueCodes.includes("workspace_unbound"));
  assert.ok(!unbound.issueCodes.includes("referenced_path_probe_miss"),
    "unbound workspace has nothing to check against — probe stays silent");

  const conflict = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "x",
    delivery: {
      mode: "git_commit_v1",
      allowedPaths: ["gone/deep/**"],
      verificationCommands: ["node gone/a.mjs"],
    },
    executionProfileId: "node-npm-test-v1",
    workspaceBinding: PROBE_WS,
    registryPath: null,
    pathExistsFn: fakeWorkspaceFs([]),
  });
  assert.ok(conflict.issueCodes.includes("profile_inline_conflict"));
  assert.ok(!conflict.issueCodes.includes("referenced_path_probe_miss"),
    "when the resolver rejects the contract there are no resolved commands to probe");
});
