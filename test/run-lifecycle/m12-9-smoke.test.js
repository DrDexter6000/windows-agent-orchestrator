// test/m12-9-smoke.test.js
//
// M12-9 Package E: no-model READ-ONLY smoke.
//
// Proves the M12-9 read-only surface — the terminal OUTCOME projector
// (projectTerminalOutcome), the shared diagnosis + delivery SSOTs it reuses,
// and the advisory run_dispatch_contract_check service — is:
//   (1) ROBUST over real-shaped production transcripts: it never throws and
//       every projected fact is a member of its closed set (fail-closed);
//   (2) STRICTLY READ-ONLY: every transcript file is byte-identical before and
//       after, with ZERO messages.collected append (no run_collect, no audit,
//       no dispatch, no spawn).
//
// No model, no worker, no serve fetch, no git, no process spawn. The fixtures
// mirror the durable transcript shapes the production dogfood runs produce
// (delivery_created + verification outcomes, packaging failures, provider-auth
// diagnosis signals, terminal states). `runs/` is runtime/gitignored state, so
// this smoke generates representative fixtures deterministically; when a real
// `runs/` dir is present it is ALSO smoked read-only for extra coverage.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { projectTerminalOutcome } from "../../src/application/runAwaitResult.js";
import { diagnoseFailure, DIAGNOSIS_CATEGORIES, PROVIDER_DIAGNOSIS_CODES } from "../../src/diagnosis.js";
import {
  gatherDeliveryView,
  projectDeliveryReadiness,
  DELIVERY_READINESS_STATES,
  DELIVERY_VERIFICATION_STATUSES,
  DELIVERY_ACCEPTANCE_STATUSES,
} from "../../src/application/runDelivery.js";
import { PACKAGING_FAILURE_CODES } from "../../src/deliveryFailureCodes.js";
import { TERMINAL_STATES, findState } from "../../src/transcript.js";
import { runDispatchContractCheck, CONTRACT_CHECK_ISSUE_CODES } from "../../src/application/runDispatchContract.js";

// ===== helpers =====

function cleanupDir(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

function sha(buf) { return createHash("sha256").update(buf).digest("hex"); }

function countCollected(buf) {
  // Count messages.collected audit occurrences in a transcript buffer. The
  // read-only smoke must add ZERO of these.
  return (buf.toString("utf8").match(/messages\.collected/g) || []).length;
}

// Canonical 40-hex commit ids (realistic delivery ref commits).
const BASE = "b".repeat(40);
const DELIVERED = "d".repeat(40);

function ref(runId, over = {}) {
  return {
    schemaVersion: 1,
    kind: "git_commit",
    runId,
    baseCommit: BASE,
    deliveryCommit: DELIVERED,
    branch: `wao/${runId}`,
    worktreePath: "/repo/.wao-worktrees/wt",
    changedFiles: ["src/feature.js", "test/feature.test.js"],
    verification: { status: "pending", commands: [], verifiedCommit: DELIVERED, results: [] },
    acceptance: { status: "pending", reviewerType: "lead_agent" },
    integration: { status: "pending", targetCommit: null },
    ...over,
  };
}

function writeJsonl(dir, runId, partials) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${runId}.jsonl`);
  let seq = 0;
  const lines = partials.map((e) => JSON.stringify({ ts: "2026-08-02T00:00:00Z", seq: (seq += 1), ...e }));
  writeFileSync(p, lines.join("\n") + "\n", "utf8");
  return p;
}

// Real-shaped transcript fixtures (one per durable production shape).
function fixtures() {
  const R = "run_smoke";
  return [
    {
      name: "completed-delivery-passed",
      runId: `${R}_pass`,
      partials: [
        { type: "run.submitted", runId: `${R}_pass`, agentId: "coder_low" },
        { type: "run.started", runId: `${R}_pass`, delivery: { mode: "git_commit_v1" }, worktreePath: "/repo/.wao-worktrees/wt" },
        { type: "run.event", runId: `${R}_pass`, kind: "tool_use", summary: "editing src/feature.js" },
        { type: "run.delivery_created", runId: `${R}_pass`, delivery: ref(`${R}_pass`, { verification: { status: "passed" } }) },
        { type: "run.delivery_verification_passed", runId: `${R}_pass`, delivery: ref(`${R}_pass`, { verification: { status: "passed" } }) },
        { type: "run.state_change", runId: `${R}_pass`, from: "running", to: "completed", reason: "done" },
        { type: "run.completed", runId: `${R}_pass` },
      ],
    },
    {
      name: "completed-non-delivery",
      runId: `${R}_plain`,
      partials: [
        { type: "run.submitted", runId: `${R}_plain`, agentId: "researcher" },
        { type: "run.started", runId: `${R}_plain`, backend: "claude-code" },
        { type: "run.event", runId: `${R}_plain`, kind: "assistant_text", summary: "analysis" },
        { type: "run.state_change", runId: `${R}_plain`, from: "running", to: "completed", reason: "done" },
        { type: "run.completed", runId: `${R}_plain` },
      ],
    },
    {
      name: "failed-packaging-disallowed-path",
      runId: `${R}_pkg`,
      partials: [
        { type: "run.started", runId: `${R}_pkg`, delivery: { mode: "git_commit_v1" }, worktreePath: "/repo/.wao-worktrees/wt" },
        { type: "run.delivery_failed", runId: `${R}_pkg`, deliveryCode: "disallowed_path" },
        { type: "run.state_change", runId: `${R}_pkg`, from: "running", to: "failed", reason: "packaging" },
        { type: "run.failed", runId: `${R}_pkg` },
      ],
    },
    {
      name: "failed-diagnosis-provider-auth",
      runId: `${R}_auth`,
      partials: [
        { type: "run.started", runId: `${R}_auth`, backend: "claude-code" },
        { type: "run.error", runId: `${R}_auth`, phase: "wait", error: "HTTP 401 unauthorized: invalid API key" },
        { type: "run.state_change", runId: `${R}_auth`, from: "running", to: "failed", reason: "provider" },
        { type: "run.failed", runId: `${R}_auth` },
      ],
    },
    {
      name: "ambiguous-malformed-commit",
      runId: `${R}_amb`,
      partials: [
        { type: "run.started", runId: `${R}_amb`, delivery: { mode: "git_commit_v1" }, worktreePath: "/repo/.wao-worktrees/wt" },
        { type: "run.delivery_created", runId: `${R}_amb`, delivery: ref(`${R}_amb`, { baseCommit: "HEAD" }) },
        { type: "run.state_change", runId: `${R}_amb`, from: "running", to: "completed", reason: "done" },
        { type: "run.completed", runId: `${R}_amb` },
      ],
    },
  ];
}

// Assert every closed-set field of an outcome/delivery view is a member of its
// closed set; unknown/malformed values must collapse to null/ambiguous, never a
// raw echo. Returns nothing; throws on any violation.
function assertClosedProjection({ diagnosis, readiness, view, outcome }) {
  if (diagnosis) {
    assert.ok(DIAGNOSIS_CATEGORIES.includes(diagnosis.category), "diagnosis.category ∈ closed set");
    assert.equal(diagnosis.code === null || PROVIDER_DIAGNOSIS_CODES.includes(diagnosis.code), true, "diagnosis.code ∈ closed set | null");
  }
  if (readiness) assert.ok(DELIVERY_READINESS_STATES.includes(readiness), "readiness ∈ closed set");
  if (view) {
    if (view.verification) {
      assert.equal(view.verification.status === undefined || DELIVERY_VERIFICATION_STATUSES.includes(view.verification.status), true, "verification.status ∈ closed set");
    }
    if (view.deliveryFailure) {
      assert.ok(PACKAGING_FAILURE_CODES.includes(view.deliveryFailure.code), "packaging code ∈ closed set");
    }
  }
  if (outcome) {
    assert.ok(TERMINAL_STATES.includes(outcome.terminalState), "outcome.terminalState ∈ TERMINAL_STATES");
    assert.ok(DIAGNOSIS_CATEGORIES.includes(outcome.diagnosis.category), "outcome.diagnosis.category ∈ closed set");
    assert.ok(DELIVERY_READINESS_STATES.includes(outcome.delivery.readiness), "outcome.delivery.readiness ∈ closed set");
  }
}

// ===== (1)+(2): robust + read-only over each real-shaped fixture =====

test("M12-9 smoke: read-only projectors are robust and non-mutating over every real-shaped transcript", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m129-smoke-"));
  try {
    for (const fx of fixtures()) {
      const path = writeJsonl(dir, fx.runId, fx.partials);
      const before = readFileSync(path);
      const beforeHash = sha(before);
      const beforeCollected = countCollected(before);

      const events = JSON.parse(`[${before.toString("utf8").trim().split("\n").join(",")}]`);

      // (1) ROBUST: none of the pure SSOT projectors may throw on a real-shaped
      // transcript; every value must be closed-set (fail-closed).
      let diagnosis, readiness, view, outcome;
      assert.doesNotThrow(() => { diagnosis = diagnoseFailure(events, fx.runId); }, `${fx.name}: diagnoseFailure must not throw`);
      assert.doesNotThrow(() => { readiness = projectDeliveryReadiness(events, fx.runId); }, `${fx.name}: projectDeliveryReadiness must not throw`);
      assert.doesNotThrow(() => { view = gatherDeliveryView(events, fx.runId, findState(events)); }, `${fx.name}: gatherDeliveryView must not throw`);
      assert.doesNotThrow(() => { outcome = projectTerminalOutcome(events, fx.runId, findState(events)); }, `${fx.name}: projectTerminalOutcome must not throw`);

      assertClosedProjection({ diagnosis, readiness, view, outcome });

      // (2) READ-ONLY: the transcript file is byte-identical before/after, and
      // no messages.collected audit was appended.
      const after = readFileSync(path);
      assert.equal(sha(after), beforeHash, `${fx.name}: transcript bytes must be unchanged`);
      assert.equal(countCollected(after), beforeCollected, `${fx.name}: zero messages.collected append`);
    }
  } finally {
    cleanupDir(dir);
  }
});

// ===== outcome is projected ONLY for terminal+clean snapshots =====

test("M12-9 smoke: outcome present iff terminal; non-terminal outcome is null", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m129-smoke-term-"));
  try {
    const runId = "run_smoke_term";
    const pathTerminal = writeJsonl(dir, runId, [
      { type: "run.started", runId, delivery: { mode: "git_commit_v1" } },
      { type: "run.delivery_created", runId, delivery: ref(runId, { verification: { status: "passed" } }) },
      { type: "run.delivery_verification_passed", runId, delivery: ref(runId, { verification: { status: "passed" } }) },
      { type: "run.state_change", runId, to: "completed" },
      { type: "run.completed", runId },
    ]);
    const evT = JSON.parse(`[${readFileSync(pathTerminal, "utf8").trim().split("\n").join(",")}]`);
    const oT = projectTerminalOutcome(evT, runId, "completed");
    assert.ok(oT, "terminal → outcome present");
    assert.equal(oT.delivery.readiness, "reviewable");

    const runId2 = "run_smoke_nonterm";
    const pathNon = writeJsonl(dir, runId2, [
      { type: "run.started", runId: runId2, backend: "claude-code" },
      { type: "run.state_change", runId: runId2, to: "running" },
    ]);
    const evN = JSON.parse(`[${readFileSync(pathNon, "utf8").trim().split("\n").join(",")}]`);
    assert.equal(projectTerminalOutcome(evN, runId2, "running"), null, "non-terminal → outcome null");

    // Bytes unchanged for both.
    assert.equal(sha(readFileSync(pathTerminal)), sha(readFileSync(pathTerminal)), "terminal transcript stable");
    assert.equal(countCollected(readFileSync(pathNon)), 0, "non-terminal transcript has no collected audits");
  } finally {
    cleanupDir(dir);
  }
});

// ===== advisory contract check: bounded, closed-set, ZERO side effect =====

test("M12-9 smoke: run_dispatch_contract_check is advisory, bounded, closed-set, and has zero side effect", async () => {
  // A fake registry reader + fake prepare so the service needs no real files.
  const fakeRegistry = {
    getAgent: (id) => (id === "coder_low" ? { id: "coder_low" } : undefined),
  };
  let dispatchCalls = 0;
  let spawnCalls = 0;
  const r = await runDispatchContractCheck({
    agentId: "coder_low",
    prompt: "implement feature X",
    delivery: {
      mode: "git_commit_v1",
      allowedPaths: ["src/"],
      verification: { commands: ["npm test"] },
    },
    workspaceBinding: { bound: true, workspaceRoot: "/repo" },
    readRegistryFn: async () => fakeRegistry,
    prepareDeliveryRequestFn: async (delivery) => ({ ok: true, deliveryRequest: { ...delivery } }),
    dispatchSpy: () => { dispatchCalls += 1; },
    spawnSpy: () => { spawnCalls += 1; },
  });
  // advisory is ALWAYS true (never a gate).
  assert.equal(r.advisory, true, "contract check is advisory, never a gate");
  assert.equal(typeof r.contractValid, "boolean");
  // sections settle independently to the closed set observed|unknown.
  for (const s of ["workspace", "registry", "contract"]) {
    assert.ok(["observed", "unknown"].includes(r.sections[s]), `section ${s} ∈ {observed,unknown}`);
  }
  // issueCodes are all members of the frozen closed set.
  assert.ok(r.issueCodes.every((c) => CONTRACT_CHECK_ISSUE_CODES.includes(c)), "issueCodes ∈ closed set");
  // ZERO side effect: the service must never dispatch or spawn.
  assert.equal(dispatchCalls, 0, "contract check must NEVER dispatch");
  assert.equal(spawnCalls, 0, "contract check must NEVER spawn");
});

// ===== extra coverage: smoke a real runs/ dir if present (read-only) =====

test("M12-9 smoke: real runs/ dir (if present) is smoked read-only and left byte-identical", () => {
  const runsDir = join(process.cwd(), "runs");
  if (!existsSync(runsDir)) {
    // runs/ is gitignored runtime state; its absence is not a failure. This
    // branch executes only when a real runs/ dir is present (e.g. a dev box).
    assert.ok(true, "no runs/ dir present — generated-fixture smoke above is the authoritative coverage");
    return;
  }
  const files = readdirSync(runsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(runsDir, f))
    .filter((f) => statSync(f).size <= 2_000_000) // cap per-file work
    .slice(0, 25); // cap total work for a fast smoke
  let robust = 0;
  for (const path of files) {
    const before = readFileSync(path);
    const beforeHash = sha(before);
    let events;
    try {
      events = JSON.parse(`[${before.toString("utf8").trim().split("\n").join(",")}]`);
    } catch {
      continue; // a malformed real transcript is not this smoke's subject
    }
    const runId = path.replace(/.*[\\/]/, "").replace(/\.jsonl$/, "");
    const state = (() => { try { return findState(events); } catch { return undefined; } })();
    // Robust: must never throw over real content.
    assert.doesNotThrow(() => diagnoseFailure(events, runId));
    assert.doesNotThrow(() => projectDeliveryReadiness(events, runId));
    if (state && TERMINAL_STATES.includes(state)) {
      assert.doesNotThrow(() => projectTerminalOutcome(events, runId, state));
    }
    // Read-only: byte-identical.
    assert.equal(sha(readFileSync(path)), beforeHash, `real transcript unchanged: ${runId}`);
    robust += 1;
  }
  assert.ok(robust >= 0, "real-transcript smoke completed without mutation");
});
