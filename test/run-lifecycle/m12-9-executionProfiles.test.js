// test/m12-9-executionProfiles.test.js
//
// M12-9 Package B (RED→GREEN): the WAO application-owned, tracked, FROZEN
// trusted catalog of mechanical execution profiles + the shared delivery-
// verification resolver.
//
// Hard contract (B2/B3):
//   - Profiles come ONLY from this frozen in-repo catalog. They never read the
//     target project config and never enter the agent registry.
//   - A profile supplies ONLY verificationSetupCommands/verificationCommands.
//     It must NEVER select a worker, change the prompt, infer/expand
//     allowedPaths, set continuable, set expected workspace/head/dirty, or
//     relax any contract.
//   - profile vs inline verification (verificationSetupCommands /
//     verificationCommands / verificationUnavailableReason) are MUTUALLY
//     EXCLUSIVE — never two authorities. Profile is legal ONLY for a delivery
//     dispatch. Unknown id / conflict / non-delivery are STABLY rejected by the
//     shared resolver (the single source of truth, used by both run_dispatch
//     and run_dispatch_contract_check).
//   - The resolver never echoes command TEXT in its outcome codes; counts only.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EXECUTION_PROFILES,
  EXECUTION_PROFILE_IDS,
  getExecutionProfile,
  listExecutionProfileSummaries,
  resolveDeliveryVerification,
} from "../../src/application/executionProfiles.js";

// ===== B2: frozen trusted catalog =====

test("B2: catalog is frozen and exposes exactly the three Lead-selected mechanical profiles", () => {
  assert.ok(Array.isArray(EXECUTION_PROFILE_IDS));
  // The three initial profiles the Lead explicitly selected.
  assert.deepEqual(
    [...EXECUTION_PROFILE_IDS].sort(),
    ["node-npm-ci-test-v1", "node-npm-test-v1", "python-pytest-v1"].sort(),
  );
  // Frozen: catalog object + id list are frozen.
  assert.ok(Object.isFrozen(EXECUTION_PROFILES));
  assert.ok(Object.isFrozen(EXECUTION_PROFILE_IDS));
});

test("B2: each profile carries ONLY setup/assertion commands — no worker/prompt/scope/continuable fields", () => {
  for (const id of EXECUTION_PROFILE_IDS) {
    const p = getExecutionProfile(id);
    assert.equal(p.id, id);
    // Allowed keys: id, summary, verificationCommands, verificationSetupCommands
    // (alphabetical order).
    const keys = Object.keys(p).sort();
    assert.deepEqual(
      keys,
      ["id", "summary", "verificationCommands", "verificationSetupCommands"],
      `profile ${id} must carry only id/summary/commands/setup`,
    );
    // Commands are non-empty arrays of non-empty strings.
    assert.ok(Array.isArray(p.verificationCommands) && p.verificationCommands.length > 0);
    for (const c of p.verificationCommands) {
      assert.equal(typeof c, "string", `${id} assertion command must be string`);
      assert.ok(c.trim().length > 0, `${id} assertion command must be non-empty`);
    }
    assert.ok(Array.isArray(p.verificationSetupCommands));
    for (const c of p.verificationSetupCommands) {
      assert.equal(typeof c, "string");
      assert.ok(c.trim().length > 0);
    }
    assert.equal(typeof p.summary, "string");
    assert.ok(p.summary.length > 0 && p.summary.length <= 160);
  }
});

test("B2: the three profiles have the exact mechanical commands the Lead selected", () => {
  const t = getExecutionProfile("node-npm-test-v1");
  assert.deepEqual(t.verificationCommands, ["npm test"]);
  assert.deepEqual(t.verificationSetupCommands, []);

  const ci = getExecutionProfile("node-npm-ci-test-v1");
  assert.deepEqual(ci.verificationSetupCommands, ["npm ci"]);
  assert.deepEqual(ci.verificationCommands, ["npm test"]);

  const py = getExecutionProfile("python-pytest-v1");
  assert.deepEqual(py.verificationCommands, ["python -m pytest"]);
  assert.deepEqual(py.verificationSetupCommands, []);
});

test("B2: getExecutionProfile returns undefined for an unknown id (no inference, no fallback)", () => {
  assert.equal(getExecutionProfile("node-npm-test-v2"), undefined);
  assert.equal(getExecutionProfile(""), undefined);
  assert.equal(getExecutionProfile("node-npm-test-v1 "), undefined);
  assert.equal(getExecutionProfile(undefined), undefined);
});

test("B2: listExecutionProfileSummaries exposes ONLY id + counts + fixed summary, never command text", () => {
  const list = listExecutionProfileSummaries();
  assert.equal(list.length, EXECUTION_PROFILE_IDS.length);
  for (const s of list) {
    const keys = Object.keys(s).sort();
    assert.deepEqual(
      keys,
      ["assertionCommandCount", "id", "setupCommandCount", "summary"],
      "summary entry must carry only id/counts/summary",
    );
    assert.ok(EXECUTION_PROFILE_IDS.includes(s.id));
    assert.equal(typeof s.summary, "string");
    assert.ok(s.summary.length > 0);
    assert.equal(s.setupCommandCount, getExecutionProfile(s.id).verificationSetupCommands.length);
    assert.equal(s.assertionCommandCount, getExecutionProfile(s.id).verificationCommands.length);
  }
  // No command TEXT leaks into the serialized summary list. The ids are stable
  // identifiers (fine to expose); the actual command literals must never appear.
  const blob = JSON.stringify(list);
  assert.ok(!blob.includes("npm test"), "summary list must not echo the npm test command literal");
  assert.ok(!blob.includes("python -m pytest"), "summary list must not echo the pytest command literal");
  assert.ok(!blob.includes("npm ci"), "summary list must not echo the npm ci command literal");
});

// ===== B3: shared resolver (single authority for both tools) =====

test("B3: resolveDeliveryVerification — no profile, inline verification passes through as source:inline", () => {
  const r = resolveDeliveryVerification({
    delivery: {
      mode: "git_commit_v1",
      allowedPaths: ["src/**"],
      verificationCommands: ["npm test"],
    },
    executionProfileId: undefined,
  });
  assert.equal(r.ok, true);
  assert.equal(r.profileId, null);
  assert.equal(r.source, "inline");
  assert.deepEqual(r.verification.commands, ["npm test"]);
  assert.deepEqual(r.verification.setupCommands, []);
  assert.equal(r.verification.unavailableReason, null);
});

test("B3: resolveDeliveryVerification — profile selected, delivery has NO inline → source:profile", () => {
  const r = resolveDeliveryVerification({
    delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"] },
    executionProfileId: "node-npm-test-v1",
  });
  assert.equal(r.ok, true);
  assert.equal(r.profileId, "node-npm-test-v1");
  assert.equal(r.source, "profile");
  assert.deepEqual(r.verification.commands, ["npm test"]);
  assert.deepEqual(r.verification.setupCommands, []);
  assert.equal(r.verification.unavailableReason, null);
});

test("B3: resolveDeliveryVerification — profile with setup commands (node-npm-ci-test-v1)", () => {
  const r = resolveDeliveryVerification({
    delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"] },
    executionProfileId: "node-npm-ci-test-v1",
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, "profile");
  assert.deepEqual(r.verification.setupCommands, ["npm ci"]);
  assert.deepEqual(r.verification.commands, ["npm test"]);
});

test("B3: unknown profile id is stably rejected with code profile_unknown", () => {
  const r = resolveDeliveryVerification({
    delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"] },
    executionProfileId: "rust-cargo-test-v1",
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "profile_unknown");
});

test("B3: profile + inline verificationCommands is a conflict (mutual exclusivity)", () => {
  const r = resolveDeliveryVerification({
    delivery: {
      mode: "git_commit_v1",
      allowedPaths: ["src/**"],
      verificationCommands: ["npm test"],
    },
    executionProfileId: "node-npm-test-v1",
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "profile_inline_conflict");
});

test("B3: profile + inline verificationSetupCommands is a conflict", () => {
  const r = resolveDeliveryVerification({
    delivery: {
      mode: "git_commit_v1",
      allowedPaths: ["src/**"],
      verificationCommands: ["npm test"],
      verificationSetupCommands: ["npm ci"],
    },
    executionProfileId: "python-pytest-v1",
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "profile_inline_conflict");
});

test("B3: profile + inline verificationUnavailableReason is a conflict", () => {
  const r = resolveDeliveryVerification({
    delivery: {
      mode: "git_commit_v1",
      allowedPaths: ["src/**"],
      verificationUnavailableReason: "manual review only",
    },
    executionProfileId: "node-npm-test-v1",
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "profile_inline_conflict");
});

test("B3: profile without a delivery is rejected (profile is delivery-only)", () => {
  const r = resolveDeliveryVerification({
    delivery: undefined,
    executionProfileId: "node-npm-test-v1",
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "profile_requires_delivery");
});

test("B3: no profile and no delivery resolves to source:none with empty verification", () => {
  const r = resolveDeliveryVerification({ delivery: undefined, executionProfileId: undefined });
  assert.equal(r.ok, true);
  assert.equal(r.source, "none");
  assert.equal(r.profileId, null);
  assert.deepEqual(r.verification.commands, []);
  assert.deepEqual(r.verification.setupCommands, []);
  assert.equal(r.verification.unavailableReason, null);
});

test("B3: resolver never throws — unknown/conflict/non-delivery are stable {ok:false,code}", () => {
  // Defensive: a non-string id must not crash, must be treated as unknown.
  const r = resolveDeliveryVerification({
    delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"] },
    executionProfileId: { evil: true },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "profile_unknown");
});

test("B3: success verification object is a fresh copy — mutating it never touches the frozen catalog", () => {
  const r = resolveDeliveryVerification({
    delivery: { mode: "git_commit_v1", allowedPaths: ["src/**"] },
    executionProfileId: "node-npm-ci-test-v1",
  });
  r.verification.commands.push("INJECTED");
  r.verification.setupCommands.push("INJECTED");
  // The frozen catalog is untouched.
  assert.deepEqual(getExecutionProfile("node-npm-ci-test-v1").verificationCommands, ["npm test"]);
  assert.deepEqual(getExecutionProfile("node-npm-ci-test-v1").verificationSetupCommands, ["npm ci"]);
});
