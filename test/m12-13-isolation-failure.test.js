// test/m12-13-isolation-failure.test.js
//
// M12-13 outcome B: a terminal delivery-requested run with EXACTLY ONE safe
// run-bound run.isolation_violation carrying code === "workdir_escape" (a
// top-level durable fact — the transcript spreads event payloads flat)
// — and no higher-priority delivery fact (created/verification/decision) —
// projects delivery readiness "isolation_failed" and surfaces
// isolationFailure = { code: "workdir_escape" } on the delivery view and
// isolationFailureCode on run_await_result.
//
// Hard rules:
//   - delivery facts OUTRANK the isolation fact: any bound created /
//     verification / decision event wins (packaging_failed, waiting_for_*,
//     reviewable, ...) regardless of the violation;
//   - malformed (missing/non-string/other code) or MULTIPLE bound violations,
//     or violations bound to ANOTHER run, are NOT evidence → ambiguous;
//   - this is NOT a packaging failure: no candidateInventory / repackage /
//     salvage / retry / stop / decision surface.
//
// The projection functions are pure: seeded transcript → deterministic
// readiness/view/outcome. RunManager's isolation-vs-delivery interplay is
// covered by m12-3-workdirContainment / m11-8c-closeout.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function jl(obj) { return JSON.stringify(obj) + "\n"; }

function writeTranscript(runDir, runId, lines) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, `${runId}.jsonl`), lines.join(""), "utf8");
}

// Real git repo — required by the MCP handlers' workspace-ownership proof
// (run.background_submitted.cwd must be a git top-level matching the server's
// workspaceRoot). Pure projections (IR-01..07) stay path-agnostic.
function makeGitRepo(dir) {
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# t\n", "utf8");
  execSync("git add README.md", { cwd: dir, stdio: "ignore" });
  execSync("git commit -m init", { cwd: dir, stdio: "ignore" });
}

// ===== Fixture: the minimal terminal delivery-requested run with a safe
// run-bound isolation violation =====

const BASE_COMMIT = "a".repeat(40);
const DELIVERY_COMMIT = "b".repeat(40);
const OTHER_COMMIT = "c".repeat(40);
const WTP = "/w/.wao-worktrees/run_x";

function usableCreatedRef({ runId = "run_x", deliveryCommit = DELIVERY_COMMIT, baseCommit = BASE_COMMIT, verificationTimeoutMs } = {}) {
  return {
    schemaVersion: 1,
    kind: "git_commit",
    runId,
    baseCommit,
    deliveryCommit,
    branch: `wao/${runId}`,
    worktreePath: WTP,
    changedFiles: [],
    verification: {
      status: "pending",
      commands: ["npm test"],
      ...(verificationTimeoutMs !== undefined ? { verificationTimeoutMs } : {}),
    },
    acceptance: { status: "pending", reviewerType: "lead_agent" },
    integration: { status: "pending", targetCommit: null },
  };
}

// Same as usableCreatedRef but with the runId passed through — the ref's
// runId MUST equal the event envelope runId to be USABLE.
function usableCreatedRefFor(runId) {
  return usableCreatedRef({ runId });
}

function verificationRef(status, { runId = "run_x", deliveryCommit = DELIVERY_COMMIT, baseCommit = BASE_COMMIT } = {}) {
  return {
    ...usableCreatedRef({ runId, deliveryCommit, baseCommit }),
    verification: {
      status,
      commands: ["npm test"],
      verifiedCommit: deliveryCommit,
      results: [],
      ...(status === "failed" ? { failureCode: "command_failed" } : {}),
    },
  };
}

function seedDeliveryRequestedRun({ runDir, runId = "run_x", extraEvents = [], cwd = "/w" }) {
  writeTranscript(runDir, runId, [
    jl({ type: "run.submitted", runId, agentId: "coder_low", seq: 1 }),
    jl({ type: "session.created", backend: "claude-code", backendSessionId: "s1", runId, agentId: "coder_low", seq: 2 }),
    jl({ type: "run.started", backend: "claude-code", cwd, worktreePath: WTP, worktreeBranch: `wao/${runId}`, delivery: { mode: "git_commit_v1", baseCommit: BASE_COMMIT, allowedPaths: ["src"], verificationCommands: ["npm test"] }, runId, agentId: "coder_low", seq: 3 }),
    jl({ type: "run.background_submitted", cwd, deliveryRequested: true, runId, agentId: "coder_low", seq: 4 }),
    jl({ type: "run.state_change", from: "running", to: "failed", reason: "completed", runId, agentId: "coder_low", seq: 5 }),
    jl({ type: "run.isolation_violation", code: "workdir_escape", eventKind: "workdir_escape", runId, agentId: "coder_low", seq: 6 }),
    ...extraEvents,
  ]);
}

async function loadEvents(dir, runId) {
  const { readTranscript } = await import("../src/transcript.js");
  return readTranscript(join(dir, `${runId}.jsonl`));
}

async function terminalStateOf(dir, runId) {
  const { findState } = await import("../src/transcript.js");
  const events = await loadEvents(dir, runId);
  return findState(events) ?? "failed";
}

async function project(dir, runId = "run_x") {
  const { projectDeliveryReadiness } = await import("../src/application/runDelivery.js");
  const events = await loadEvents(dir, runId);
  return projectDeliveryReadiness(events, runId);
}

async function view(dir, runId = "run_x") {
  const { gatherDeliveryView } = await import("../src/application/runDelivery.js");
  const events = await loadEvents(dir, runId);
  return gatherDeliveryView(events, runId, await terminalStateOf(dir, runId));
}

// =====================================================================
// Readiness projection
// =====================================================================

test("IR-01: exactly one safe run-bound workdir_escape + terminal + requested + no delivery facts → isolation_failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ir01-"));
  try {
    seedDeliveryRequestedRun({ runDir: dir });
    assert.equal(await project(dir), "isolation_failed");
  } finally {
    cleanupDir(dir);
  }
});

test("IR-02: malformed isolation events are NOT evidence → ambiguous", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ir02-"));
  try {
    // The durable transcript spreads event payloads FLAT (transcript.append /
    // transitionState), so the code is a top-level fact — same idiom as
    // deliveryCode. Malformed = missing/null/non-string/non-safe code.
    for (const [name, extra] of [
      ["missing-code", { eventKind: "workdir_escape" }],
      ["null-code", { code: null, eventKind: "workdir_escape" }],
      ["non-string-code", { code: 42, eventKind: "workdir_escape" }],
      ["other-code", { code: "OTHER", eventKind: "workdir_escape" }],
      ["nested-payload-shape", { payload: { code: "workdir_escape" } }],
    ]) {
      const runId = `run_ir02_${name.replaceAll("-", "_")}`;
      const lines = seedLineEvents({ runId });
      lines.push(jl({ type: "run.isolation_violation", ...extra, runId, agentId: "coder_low", seq: 99 }));
      writeTranscript(dir, runId, lines);
      assert.equal(await project(dir, runId), "ambiguous", `${name} must project ambiguous`);
    }
  } finally {
    cleanupDir(dir);
  }
});

function seedLineEvents({ runId, cwd = "/w" }) {
  return [
    jl({ type: "run.started", backend: "claude-code", cwd, worktreePath: WTP, worktreeBranch: `wao/${runId}`, delivery: { mode: "git_commit_v1", baseCommit: BASE_COMMIT, allowedPaths: ["src"], verificationCommands: ["npm test"] }, runId, agentId: "coder_low", seq: 1 }),
    jl({ type: "run.background_submitted", cwd, deliveryRequested: true, runId, agentId: "coder_low", seq: 2 }),
    jl({ type: "run.state_change", from: "running", to: "failed", reason: "completed", runId, agentId: "coder_low", seq: 3 }),
  ];
}

test("IR-03: MULTIPLE run-bound violations are ambiguous", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ir03-"));
  try {
    const runId = "run_ir03";
    const lines = seedLineEvents({ runId });
    lines.push(jl({ type: "run.isolation_violation", code: "workdir_escape", runId, agentId: "coder_low", seq: 4 }));
    lines.push(jl({ type: "run.isolation_violation", code: "workdir_escape", runId, agentId: "coder_low", seq: 5 }));
    writeTranscript(dir, runId, lines);
    assert.equal(await project(dir, runId), "ambiguous", "two bound violations must be ambiguous");
  } finally {
    cleanupDir(dir);
  }
});

test("IR-04: violations bound to ANOTHER run are not evidence (cross-run ignored)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ir04-"));
  try {
    const runId = "run_ir04";
    const lines = seedLineEvents({ runId });
    // Another run's violation: must be ignored; run_x has NO own facts → ambiguous.
    lines.push(jl({ type: "run.isolation_violation", code: "workdir_escape", runId: "run_other", agentId: "coder_low", seq: 4 }));
    writeTranscript(dir, runId, lines);
    assert.equal(await project(dir, runId), "ambiguous", "cross-run violation must not project isolation_failed");
  } finally {
    cleanupDir(dir);
  }
});

test("IR-05: delivery facts OUTRANK the isolation fact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ir05-"));
  try {
    const cases = [
      ["created", [{ type: "run.delivery_created", delivery: null, deliveryCommit: DELIVERY_COMMIT }], "waiting_for_verification"],
      ["created+verification", [
        { type: "run.delivery_created", delivery: null, deliveryCommit: DELIVERY_COMMIT },
        { type: "run.delivery_verification_passed", delivery: null, deliveryCommit: DELIVERY_COMMIT },
      ], "reviewable"],
      ["verification-failed", [{ type: "run.delivery_verification_failed", delivery: null, deliveryCommit: DELIVERY_COMMIT }], "ambiguous"],
      ["packaging-failed", [{ type: "run.delivery_failed", deliveryCode: "disallowed_path" }], "packaging_failed"],
    ];
    for (const [name, extraEvents, expected] of cases) {
      const runId = `run_ir05_${name.replaceAll(/[^a-z0-9]/gi, "_")}`;
      const lines = seedLineEvents({ runId });
      lines.push(jl({ type: "run.isolation_violation", code: "workdir_escape", runId, agentId: "coder_low", seq: 4 }));
      let seq = 5;
      for (const e of extraEvents) {
        // The ref's runId MUST equal the event envelope runId to be USABLE.
        const ref = e.type === "run.delivery_verification_passed"
          ? verificationRef("passed", { runId })
          : (e.type === "run.delivery_verification_failed"
            ? verificationRef("failed", { runId })
            : usableCreatedRefFor(runId));
        lines.push(jl({ ...e, delivery: ref, runId, agentId: "coder_low", seq: seq++ }));
      }
      writeTranscript(dir, runId, lines);
      assert.equal(await project(dir, runId), expected, `${name} must project ${expected} (facts outrank the isolation fact)`);
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Delivery view + run_await_result outcome
// =====================================================================

test("IR-06: gatherDeliveryView surfaces isolationFailure (and NO candidateInventory)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ir06-"));
  try {
    seedDeliveryRequestedRun({ runDir: dir });
    const v = await view(dir);
    assert.equal(v.deliveryAvailable, false);
    assert.equal(v.deliveryRequested, true);
    assert.equal(Object.prototype.hasOwnProperty.call(v, "ambiguous"), false,
      "isolation-failure view is NOT the ambiguous marker");
    assert.equal(v.deliveryFailure, null);
    // M12-14: the seeded (historical-shaped) violation carries no reason, so the
    // additive closed-set reason projects null — never upgraded, never invented.
    assert.deepEqual(v.isolationFailure, { code: "workdir_escape", reason: null });
    assert.equal(Object.prototype.hasOwnProperty.call(v, "candidateInventory"), false,
      "isolation failure must NOT surface a candidateInventory");
    assert.equal(Object.prototype.hasOwnProperty.call(v, "repackageAvailable"), false);
  } finally {
    cleanupDir(dir);
  }
});

test("IR-07: run_await_result outcome carries isolationFailureCode = workdir_escape", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ir07-"));
  try {
    seedDeliveryRequestedRun({ runDir: dir });
    const { projectTerminalOutcome } = await import("../src/application/runAwaitResult.js");
    const events = await loadEvents(dir, "run_x");
    const outcome = await projectTerminalOutcome(events, "run_x", "failed", {
      diagnoseFn: async () => ({ category: "workdir_escape", evidence: [], cause: "cwd escape" }),
    });
    assert.equal(outcome.delivery.isolationFailureCode, "workdir_escape");
    assert.equal(outcome.delivery.requested, true);
    assert.equal(outcome.delivery.available, false);
    assert.equal(outcome.delivery.failureCode, null);
  } finally {
    cleanupDir(dir);
  }
});

test("IR-08: MCP run_await_result — real handler + schema expose isolationFailureCode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ir08-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    makeGitRepo(repo);
    seedDeliveryRequestedRun({ runDir: dir, cwd: repo });
    const { createWaoMcpServer } = await import("../src/mcp/server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { runAwaitResult } = await import("../src/application/runAwaitResult.js");

    const server = createWaoMcpServer({
      registryPath: join(dir, "agents.json"),
      runDir: dir,
      workspaceRoot: repo,
      runAwaitResultFn: async (input) => runAwaitResult({ ...input, runDir: dir }),
    });
    const client = new Client({ name: "wao-test", version: "0.0.1" }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const res = await client.callTool({
        name: "run_await_result",
        arguments: { runId: "run_x", waitMs: 1000 },
      });
      assert.ok(res && !res.isError, `handler must succeed: ${JSON.stringify(res)}`);
      const payload = JSON.parse(res.content[0].text);
      assert.equal(payload.outcome.delivery.isolationFailureCode, "workdir_escape",
        "run_await_result outcome.delivery.isolationFailureCode");
      // M12-14: the historical reason-absent violation projects the additive
      // top-level reason as null — never upgraded, never invented.
      assert.equal(payload.isolationFailureReason, null,
        "run_await_result isolationFailureReason (reason-absent → null)");
      assert.equal(payload.outcome.delivery.available, false);
      // The strict output schema validates the new field (no extra keys, closed set).
      assert.ok(payload.outcome, "strict schema parse passed");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("IR-09: MCP run_delivery — point-in-time AND wait path surface isolationFailure + readiness isolation_failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ir09-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    makeGitRepo(repo);
    seedDeliveryRequestedRun({ runDir: dir, cwd: repo });
    const { createWaoMcpServer } = await import("../src/mcp/server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { getRunDelivery } = await import("../src/application/runDelivery.js");
    const { getRunDeliveryReadiness } = await import("../src/application/runDelivery.js");

    const server = createWaoMcpServer({
      registryPath: join(dir, "agents.json"),
      runDir: dir,
      workspaceRoot: repo,
      getRunDeliveryFn: async (input) => getRunDelivery({ ...input, runDir: dir }),
      getRunDeliveryReadinessFn: async (input) => getRunDeliveryReadiness({ ...input, runDir: dir }),
    });
    const client = new Client({ name: "wao-test", version: "0.0.1" }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      // Point-in-time.
      const res = await client.callTool({
        name: "run_delivery",
        arguments: { runId: "run_x" },
      });
      assert.ok(res && !res.isError, `point-in-time must succeed: ${JSON.stringify(res)}`);
      const payload = JSON.parse(res.content[0].text);
      assert.equal(payload.deliveryAvailable, false);
      assert.equal(payload.deliveryRequested, true);
      assert.equal(Object.prototype.hasOwnProperty.call(payload, "ambiguous"), false,
        "isolation-failure payload is NOT the ambiguous marker");
      assert.deepEqual(payload.isolationFailure, { code: "workdir_escape", reason: null });
      // No recovery surface: candidateInventory/candidateKind stay NULL (the
      // wire schema always carries them as nullable) and no repackage surface.
      assert.equal(payload.candidateInventory, null);
      assert.equal(payload.candidateKind, null);
      assert.equal(Object.prototype.hasOwnProperty.call(payload, "repackageAvailable"), false);

      // Wait path resolves immediately (isolation_failed is settled).
      const waitRes = await client.callTool({
        name: "run_delivery",
        arguments: { runId: "run_x", waitMs: 1000 },
      });
      assert.ok(waitRes && !waitRes.isError, `wait path must succeed: ${JSON.stringify(waitRes)}`);
      const waitPayload = JSON.parse(waitRes.content[0].text);
      assert.deepEqual(waitPayload.isolationFailure, { code: "workdir_escape", reason: null });
      assert.equal(waitPayload.readiness, "isolation_failed");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("IR-10: ambiguous isolation evidence → run_delivery fails with the fixed ambiguity error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ir10-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    makeGitRepo(repo);
    const runId = "run_ir10";
    const lines = seedLineEvents({ runId, cwd: repo });
    lines.push(jl({ type: "run.isolation_violation", code: "workdir_escape", runId, agentId: "coder_low", seq: 4 }));
    lines.push(jl({ type: "run.isolation_violation", code: "workdir_escape", runId, agentId: "coder_low", seq: 5 }));
    writeTranscript(dir, runId, lines);
    const { createWaoMcpServer } = await import("../src/mcp/server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { getRunDelivery } = await import("../src/application/runDelivery.js");

    const server = createWaoMcpServer({
      registryPath: join(dir, "agents.json"),
      runDir: dir,
      workspaceRoot: repo,
      getRunDeliveryFn: async (input) => getRunDelivery({ ...input, runDir: dir }),
    });
    const client = new Client({ name: "wao-test", version: "0.0.1" }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const res = await client.callTool({
        name: "run_delivery",
        arguments: { runId: "run_ir10" },
      });
      assert.ok(res.isError, "ambiguous isolation evidence must fail the tool (fail closed)");
      const text = res.content.map((c) => c.text).join("");
      // The handler collapses the ambiguity to the FIXED safe error — no raw
      // isolation evidence is ever echoed on the wire.
      assert.equal(text, "run_delivery failed", `fixed safe error expected, got: ${text}`);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("IR-11: MCP run_delivery point-in-time isolationFailure → delivery.isolation_failed + run_activity/run_diagnose (same intent as readiness:isolation_failed)", async () => {
  // The bug: on the point-in-time path the payload carries isolationFailure but
  // NO readiness label, so the Lead saw delivery.waiting + run_activity/run_status
  // instead of the truthful delivery.isolation_failed + run_activity/run_diagnose.
  // The wait-path workspace-ownership containment (run_delivery(waitMs) on a
  // foreign run) is untouched — this only fixes the safe semantic projection.
  const dir = mkdtempSync(join(tmpdir(), "wao-ir11-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    makeGitRepo(repo);
    seedDeliveryRequestedRun({ runDir: dir, cwd: repo });
    const { createWaoMcpServer } = await import("../src/mcp/server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { getRunDelivery } = await import("../src/application/runDelivery.js");
    const { getRunDeliveryReadiness } = await import("../src/application/runDelivery.js");

    const server = createWaoMcpServer({
      registryPath: join(dir, "agents.json"),
      runDir: dir,
      workspaceRoot: repo,
      getRunDeliveryFn: async (input) => getRunDelivery({ ...input, runDir: dir }),
      getRunDeliveryReadinessFn: async (input) => getRunDeliveryReadiness({ ...input, runDir: dir }),
    });
    const client = new Client({ name: "wao-test", version: "0.0.1" }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      // Point-in-time (no waitMs): no readiness label, but isolationFailure is set.
      const res = await client.callTool({
        name: "run_delivery",
        arguments: { runId: "run_x" },
      });
      assert.ok(res && !res.isError, `point-in-time must succeed: ${JSON.stringify(res)}`);
      const payload = JSON.parse(res.content[0].text);
      assert.deepEqual(payload.isolationFailure, { code: "workdir_escape", reason: null });
      assert.equal(payload.readiness, undefined,
        "point-in-time path carries no readiness label");
      // RED actual today: [delivery.waiting]. GREEN target: [delivery.isolation_failed].
      assert.deepEqual(payload.semanticNotes.map((n) => n.id), ["delivery.isolation_failed"],
        "point-in-time isolationFailure → delivery.isolation_failed (NOT delivery.waiting)");
      // RED actual today: [run_activity, run_status]. GREEN target: [run_activity, run_diagnose].
      const ddTools = payload.availableDrilldowns.map((d) => d.tool);
      assert.deepEqual(ddTools, ["run_activity", "run_diagnose"],
        "point-in-time isolationFailure → run_activity + run_diagnose (NOT run_status)");
      assert.ok(!ddTools.includes("run_delivery_review"),
        "isolation escape must NEVER advertise run_delivery_review");

      // Wait path (readiness:"isolation_failed") must project the EXACT SAME
      // isolation-safe drilldown + semantic intent as the point-in-time path.
      const waitRes = await client.callTool({
        name: "run_delivery",
        arguments: { runId: "run_x", waitMs: 1000 },
      });
      assert.ok(waitRes && !waitRes.isError, `wait path must succeed: ${JSON.stringify(waitRes)}`);
      const waitPayload = JSON.parse(waitRes.content[0].text);
      assert.equal(waitPayload.readiness, "isolation_failed");
      assert.deepEqual(waitPayload.semanticNotes.map((n) => n.id), ["delivery.isolation_failed"]);
      assert.deepEqual(
        waitPayload.availableDrilldowns.map((d) => d.tool),
        payload.availableDrilldowns.map((d) => d.tool),
        "wait-path and point-in-time drilldown intents are identical for an isolation escape");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});
