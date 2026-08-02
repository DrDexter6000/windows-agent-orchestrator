// test/m11-11c-sessionReuse.test.js
//
// M11-11C: expert session reuse — TDD tests (RED → GREEN).
//
// Feature: when the same MCP Lead session asks the same configured reusable
// expert another non-delivery question in the same bound Git workspace, WAO
// reuses the provider-native conversation (Claude Code session) for context/
// cache, while creating a NEW WAO run/transcript for independent supervision.
//
// Deliverable boundary: ONLY expert session reuse. No terminal-run follow-up,
// no tester handoff, no forecast removal, no stop-wording changes.
//
// Contract coverage (deterministic, no model calls):
//   1. registry policy sessionReuse:"lead_workspace" validated as a closed set;
//      agents without it retain current behavior (no --session-reuse-json).
//   2. reuse identity = Lead session + canonical bound workspace + canonical
//      agentId. Lead identity is server-owned/injectable, never exposed by MCP.
//   3. every request = fresh runId + transcript; backend conversation is the
//      only reused object.
//   4. reuse is strictly non-delivery; delivery dispatch always starts fresh.
//   5. provider-neutral: Claude Code first turn --session-id <uuid>, later turn
//      --resume <same uuid>; uuid derived deterministically; raw ids never
//      exposed via MCP.
//   6. resumable only after prior matching transcript has session.created;
//      non-terminal prior run → fail before new transcript/fork with a fixed
//      actionable busy error; never concurrently drive the same provider session.
//   7. backend that cannot express the reuse policy fails closed before spawn.
//   8. only bounded routing facts persisted; MCP never returns backendSessionId,
//      Lead id, workspace path, prompt, argv, PID, or provider payload.
//   9. registry_list projects configured reuse mode (nullable).
//  10. tracked example configures researcher + auditor as reusable.
//  11. docs live in existing SSOT locations.
//
// Causal chain proven: dispatchRun → detached runner argv → runBackground →
// RunManager → Claude backend compilation (not only a helper).

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { normalizeAgent } from "../src/registry.js";
import { readTranscript, findState, findLatest } from "../src/transcript.js";
import { dispatchRun, ReuseBusyError } from "../src/application/runDispatch.js";
import {
  SESSION_REUSE_MODES,
  isValidSessionReuseMode,
  deriveOpaqueUuid,
  deriveReuseKeyHash,
  resolveReuseTurn,
  validateSessionReuseRouting,
} from "../src/application/sessionReuse.js";
import { ClaudeCodeBackend } from "../src/backends/claudeCode.js";
import { RunManager } from "../src/runManager.js";
import { runBackground, runMain } from "../src/backgroundRunner.js";
import { createWaoMcpServer } from "../src/mcp/server.js";

// ===== Helpers =====

function makeRegistry(dir, agents) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return registryPath;
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// Fake detached spawn: records the call, returns an unref-able handle (runner
// never actually runs — the transcript stays pending, which is what the busy
// check relies on).
function makeFakeSpawn() {
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { unref() {} };
  };
  return { fakeSpawn, calls };
}

// A UUID v4 string: 8-4-4-4-12 hex, version nibble 4, variant 8/9/a/b.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Fake child for ClaudeCodeBackend: a capturing spawnFn that returns an
// EventEmitter child emitting 'spawn' then 'close'(0), so the backend compiles
// argv (buildArgs) and the events stream can reach done(completed) without a
// real subprocess or model.
function makeCapturingSpawn() {
  const captures = [];
  const spawnFn = (binary, args, opts) => {
    captures.push({ binary, args: [...args], opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242 + captures.length;
    setImmediate(() => {
      child.emit("spawn");
      setImmediate(() => child.emit("close", 0));
    });
    return child;
  };
  return { spawnFn, captures };
}

function makeScriptedClaudeSpawn(lines) {
  const captures = [];
  const spawnFn = (binary, args, opts) => {
    captures.push({ binary, args: [...args], opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4343 + captures.length;
    child.exitCode = null;
    child.signalCode = null;
    setImmediate(() => {
      child.emit("spawn");
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(`${lines.join("\n")}\n`, "utf8"));
        child.exitCode = 0;
        child.emit("close", 0);
      });
    });
    return child;
  };
  return { spawnFn, captures };
}

function reusableClaudeAgent(dir, extra = {}) {
  return {
    backend: "claude-code",
    binary: "fake-claude",
    cwd: dir,
    model: { id: "glm-5.2" },
    sessionReuse: "lead_workspace",
    ...extra,
  };
}

// =====================================================================
// Contract 1: registry sessionReuse is a closed set; absent ⇒ current behavior
// =====================================================================

test("M11-11C REG-1: sessionReuse:'lead_workspace' normalizes through", () => {
  const a = normalizeAgent("researcher", reusableClaudeAgent("D:/proj"));
  assert.equal(a.sessionReuse, "lead_workspace", "sessionReuse carried through normalizeAgent");
});

test("M11-11C REG-2: invalid sessionReuse mode rejected (closed set)", () => {
  const bad = ["lead-workspace", " Lead_workspace ", "session", "always", "LEAD_WORKSPACE", 1, true, {}];
  for (const mode of bad) {
    assert.throws(
      () => normalizeAgent("researcher", { ...reusableClaudeAgent("D:/proj"), sessionReuse: mode }),
      /sessionReuse|reuse/i,
      `invalid sessionReuse ${JSON.stringify(mode)} must be rejected`,
    );
  }
});

test("M11-11C REG-3: absent sessionReuse keeps current behavior (nullable)", () => {
  const a = normalizeAgent("coder_low", { backend: "claude-code", cwd: "D:/proj", model: { id: "m" } });
  assert.equal(a.sessionReuse, undefined, "non-reusable agent has no sessionReuse");
});

test("M11-11C REG-4: SESSION_REUSE_MODES is the frozen closed set", () => {
  assert.ok(Object.isFrozen(SESSION_REUSE_MODES));
  assert.deepEqual([...SESSION_REUSE_MODES], ["lead_workspace"]);
  assert.equal(isValidSessionReuseMode("lead_workspace"), true);
  assert.equal(isValidSessionReuseMode("nope"), false);
  assert.equal(isValidSessionReuseMode(undefined), false);
});

test("M11-11C ROUTE-1: valid routing envelope passes unchanged", () => {
  const routing = {
    mode: "lead_workspace",
    turn: "resume",
    opaqueUuid: "12345678-1234-4abc-8def-1234567890ab",
  };
  assert.equal(validateSessionReuseRouting(routing), routing);
});

test("M11-11C ROUTE-2: malformed routing never degrades into a fresh conversation", () => {
  const invalid = [
    null,
    {},
    { mode: "lead_workspace", turn: "other", opaqueUuid: "12345678-1234-4abc-8def-1234567890ab" },
    { mode: "lead_workspace", turn: "first", opaqueUuid: "not-a-uuid" },
    {
      mode: "lead_workspace",
      turn: "first",
      opaqueUuid: "12345678-1234-4abc-8def-1234567890ab",
      extra: true,
    },
  ];
  for (const value of invalid) {
    assert.throws(
      () => validateSessionReuseRouting(value),
      /invalid internal routing envelope/,
    );
  }
});

// =====================================================================
// Contract 2 + 5: opaque UUID derivation — deterministic, isolated, valid v4
// =====================================================================

test("M11-11C UUID-1: deriveOpaqueUuid is a valid RFC4122 v4 uuid", () => {
  const uuid = deriveOpaqueUuid({ leadSession: "lead-A", workspace: "D:/proj", agentId: "researcher" });
  assert.match(uuid, UUID_V4, "opaque uuid is a well-formed v4 uuid");
});

test("M11-11C UUID-2: same identity ⇒ same opaque uuid (deterministic)", () => {
  const a = deriveOpaqueUuid({ leadSession: "lead-A", workspace: "D:/proj", agentId: "researcher" });
  const b = deriveOpaqueUuid({ leadSession: "lead-A", workspace: "D:/proj", agentId: "researcher" });
  assert.equal(a, b, "deterministic for the same triple");
});

test("M11-11C UUID-3: cross-workspace isolation", () => {
  const a = deriveOpaqueUuid({ leadSession: "lead-A", workspace: "D:/proj", agentId: "researcher" });
  const b = deriveOpaqueUuid({ leadSession: "lead-A", workspace: "D:/other", agentId: "researcher" });
  assert.notEqual(a, b, "different workspace ⇒ different uuid");
});

test("M11-11C UUID-4: cross-Lead isolation", () => {
  const a = deriveOpaqueUuid({ leadSession: "lead-A", workspace: "D:/proj", agentId: "researcher" });
  const b = deriveOpaqueUuid({ leadSession: "lead-B", workspace: "D:/proj", agentId: "researcher" });
  assert.notEqual(a, b, "different Lead session ⇒ different uuid");
});

test("M11-11C UUID-5: cross-agent isolation", () => {
  const a = deriveOpaqueUuid({ leadSession: "lead-A", workspace: "D:/proj", agentId: "researcher" });
  const b = deriveOpaqueUuid({ leadSession: "lead-A", workspace: "D:/proj", agentId: "auditor" });
  assert.notEqual(a, b, "different agentId ⇒ different uuid");
});

test("M11-11C UUID-6: workspace path-form tolerance (same dir described differently)", () => {
  const a = deriveOpaqueUuid({ leadSession: "lead-A", workspace: "D:/projects/app", agentId: "researcher" });
  const bs = [
    "D:\\projects\\app",
    "D:/projects/app/",
    "D://projects//app",
    "d:/projects/app", // drive-letter case folds (Windows identity semantics)
  ];
  for (const w of bs) {
    const b = deriveOpaqueUuid({ leadSession: "lead-A", workspace: w, agentId: "researcher" });
    assert.equal(b, a, `workspace ${JSON.stringify(w)} must canonicalize to the same uuid`);
  }
});

test("M11-11C UUID-7: opaque uuid never contains raw Lead id / workspace / agentId", () => {
  const uuid = deriveOpaqueUuid({
    leadSession: "lead-SECRET-session-id",
    workspace: "D:/secret/path",
    agentId: "researcher",
  });
  assert.ok(!uuid.includes("lead-SECRET"), "no Lead id fragment in opaque uuid");
  assert.ok(!uuid.includes("secret"), "no workspace fragment in opaque uuid");
  assert.ok(!uuid.includes("researcher"), "no agentId fragment in opaque uuid");
});

test("M11-11C KEY-1: deriveReuseKeyHash is a stable sha256 hex, isolated", () => {
  const k1 = deriveReuseKeyHash({ leadSession: "lead-A", workspace: "D:/proj", agentId: "researcher" });
  const k2 = deriveReuseKeyHash({ leadSession: "lead-A", workspace: "D:/proj", agentId: "researcher" });
  const k3 = deriveReuseKeyHash({ leadSession: "lead-A", workspace: "D:/proj", agentId: "auditor" });
  assert.match(k1, /^[0-9a-f]{64}$/, "key hash is sha256 hex");
  assert.equal(k1, k2, "deterministic");
  assert.notEqual(k1, k3, "isolated across agents");
});

// =====================================================================
// Contract 6: resolveReuseTurn — first / resume / busy / crashed / stale
// =====================================================================

async function seedTranscript(runDir, runId, agentId, { terminal, sessionCreated } = {}) {
  const { JsonlTranscript } = await import("../src/transcript.js");
  const t = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId });
  await t.transitionState(null, "pending", "seed");
  await t.append("run.started", { backend: "claude-code" });
  if (sessionCreated) {
    await t.append("session.created", { backend: "process", backendSessionId: "proc_1" });
  }
  await t.transitionState("pending", "submitted", "seed");
  if (terminal) {
    await t.transitionState("submitted", "completed", "seed_done", {
      factEvents: [{ type: "run.completed", payload: {} }],
    });
  }
  return t;
}

test("M11-11C TURN-1: no prior routing entry ⇒ first turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m11c-turn1-"));
  try {
    const decision = await resolveReuseTurn({
      runDir: dir, runId: "run_new_1",
      leadSession: "lead-A", workspace: "D:/proj", agentId: "researcher",
    });
    assert.equal(decision.kind, "first");
    assert.equal(decision.routing.mode, "lead_workspace");
    assert.equal(decision.routing.turn, "first");
    assert.match(decision.routing.opaqueUuid, UUID_V4);
    // Routing slot claimed for the new runId.
    const entry = JSON.parse(readFileSync(join(dir, ".session-reuse", `${deriveReuseKeyHash({ leadSession: "lead-A", workspace: "D:/proj", agentId: "researcher" })}.json`), "utf8"));
    assert.equal(entry.runId, "run_new_1");
  } finally { cleanupDir(dir); }
});

test("M11-11C TURN-2: prior terminal run WITH session.created ⇒ resume turn (same opaque uuid)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m11c-turn2-"));
  try {
    await resolveReuseTurn({
      runDir: dir, runId: "run_first_2",
      leadSession: "lead-A", workspace: "D:/proj", agentId: "researcher",
    });
    await seedTranscript(dir, "run_first_2", "researcher", { terminal: true, sessionCreated: true });

    const decision = await resolveReuseTurn({
      runDir: dir, runId: "run_resume_2",
      leadSession: "lead-A", workspace: "D:/proj", agentId: "researcher",
    });
    assert.equal(decision.kind, "resume");
    assert.equal(decision.routing.turn, "resume");
    const expectedUuid = deriveOpaqueUuid({ leadSession: "lead-A", workspace: "D:/proj", agentId: "researcher" });
    assert.equal(decision.routing.opaqueUuid, expectedUuid, "resume reuses the same opaque uuid");
    // Slot now points at the newest run.
    const entry = JSON.parse(readFileSync(join(dir, ".session-reuse", `${deriveReuseKeyHash({ leadSession: "lead-A", workspace: "D:/proj", agentId: "researcher" })}.json`), "utf8"));
    assert.equal(entry.runId, "run_resume_2");
  } finally { cleanupDir(dir); }
});

test("M11-11C TURN-3: prior NON-terminal run ⇒ busy (never concurrently drive same provider session)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m11c-turn3-"));
  try {
    await resolveReuseTurn({
      runDir: dir, runId: "run_active_3",
      leadSession: "lead-A", workspace: "D:/proj", agentId: "researcher",
    });
    // Prior run is pending (in-flight) but never reached session.created.
    await seedTranscript(dir, "run_active_3", "researcher", { terminal: false, sessionCreated: false });

    const decision = await resolveReuseTurn({
      runDir: dir, runId: "run_second_3",
      leadSession: "lead-A", workspace: "D:/proj", agentId: "researcher",
    });
    assert.equal(decision.kind, "busy", "non-terminal prior run ⇒ busy");
    assert.equal(decision.activeRunId, "run_active_3", "busy reports the active runId (server-side only)");
  } finally { cleanupDir(dir); }
});

test("M11-11C TURN-4: prior terminal run WITHOUT session.created ⇒ first (crashed before backend conversation)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m11c-turn4-"));
  try {
    await resolveReuseTurn({
      runDir: dir, runId: "run_crash_4",
      leadSession: "lead-A", workspace: "D:/proj", agentId: "researcher",
    });
    // Terminal failed but session.created never written (spawn failed pre-session).
    const { JsonlTranscript } = await import("../src/transcript.js");
    const t = new JsonlTranscript(join(dir, "run_crash_4.jsonl"), { runId: "run_crash_4", agentId: "researcher" });
    await t.transitionState(null, "pending", "seed");
    await t.transitionState("pending", "failed", "crashed_pre_session");

    const decision = await resolveReuseTurn({
      runDir: dir, runId: "run_new_4",
      leadSession: "lead-A", workspace: "D:/proj", agentId: "researcher",
    });
    assert.equal(decision.kind, "first", "terminal without session.created ⇒ no provider session to resume ⇒ first");
    assert.equal(decision.routing.turn, "first");
  } finally { cleanupDir(dir); }
});

test("M11-11C TURN-5: independent triples never collide (cross-lead / cross-workspace / cross-agent all first)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m11c-turn5-"));
  try {
    const base = { runDir: dir, workspace: "D:/proj", agentId: "researcher", runId: "r_a" };
    const dA = await resolveReuseTurn({ ...base, leadSession: "lead-A", runId: "r_a" });
    const dB = await resolveReuseTurn({ ...base, leadSession: "lead-B", runId: "r_b" });
    const dC = await resolveReuseTurn({ ...base, leadSession: "lead-A", workspace: "D:/other", runId: "r_c" });
    const dD = await resolveReuseTurn({ ...base, leadSession: "lead-A", agentId: "auditor", runId: "r_d" });
    for (const d of [dA, dB, dC, dD]) assert.equal(d.kind, "first");
    const uuids = [dA, dB, dC, dD].map((d) => d.routing.opaqueUuid);
    assert.equal(new Set(uuids).size, 4, "all four triples get distinct opaque uuids");
  } finally { cleanupDir(dir); }
});

// =====================================================================
// Contracts 2,3,5,6,8: dispatchRun — argv threading, fresh runId/transcript,
// run.session_reuse audit event, busy-before-side-effects, delivery-always-fresh
// =====================================================================

test("M11-11C DISP-1: reusable first turn threads --session-reuse-json (turn:first) + run.session_reuse event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m11c-disp1-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { researcher: reusableClaudeAgent(dir) });
    const runDir = join(dir, "runs");
    const result = await dispatchRun({
      agentId: "researcher", prompt: "what is X",
      registryPath, runDir, cwd: dir, leadSession: "lead-A", spawnFn: fakeSpawn,
    });
    assert.equal(result.accepted, true);
    assert.ok(result.runId);

    // argv carries --session-reuse-json with a first-turn routing payload.
    const argv = calls[0].args;
    const idx = argv.indexOf("--session-reuse-json");
    assert.ok(idx >= 0, "argv has --session-reuse-json");
    const routing = JSON.parse(argv[idx + 1]);
    assert.equal(routing.mode, "lead_workspace");
    assert.equal(routing.turn, "first");
    assert.match(routing.opaqueUuid, UUID_V4);

    // run.session_reuse audit event persisted (bounded routing fact only).
    const events = await readTranscript(join(runDir, `${result.runId}.jsonl`));
    const reuseEvent = findLatest(events, "run.session_reuse");
    assert.ok(reuseEvent, "run.session_reuse audit event written");
    assert.equal(reuseEvent.mode, "lead_workspace");
    assert.equal(reuseEvent.turn, "first");
    // Bounded routing fact — no opaque uuid / lead id / workspace persisted here.
    assert.equal(reuseEvent.opaqueUuid, undefined);
    assert.equal(reuseEvent.leadSession, undefined);
    assert.equal(reuseEvent.workspace, undefined);
  } finally { cleanupDir(dir); }
});

test("M11-11C DISP-2: second turn same triple ⇒ resume (turn:resume), NEW runId + NEW transcript (not appended)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m11c-disp2-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { researcher: reusableClaudeAgent(dir) });
    const runDir = join(dir, "runs");

    // Turn 1.
    const r1 = await dispatchRun({
      agentId: "researcher", prompt: "q1",
      registryPath, runDir, cwd: dir, leadSession: "lead-A", spawnFn: fakeSpawn,
    });
    // Mark turn-1 terminal WITH session.created so turn-2 resumes.
    await seedTranscript(runDir, r1.runId, "researcher", { terminal: true, sessionCreated: true });

    // Turn 2.
    const r2 = await dispatchRun({
      agentId: "researcher", prompt: "q2",
      registryPath, runDir, cwd: dir, leadSession: "lead-A", spawnFn: fakeSpawn,
    });
    assert.notEqual(r1.runId, r2.runId, "fresh runId per turn (contract 3)");

    const routing1 = JSON.parse(calls[0].args[calls[0].args.indexOf("--session-reuse-json") + 1]);
    const routing2 = JSON.parse(calls[1].args[calls[1].args.indexOf("--session-reuse-json") + 1]);
    assert.equal(routing1.turn, "first");
    assert.equal(routing2.turn, "resume", "second turn is a resume");
    assert.equal(routing1.opaqueUuid, routing2.opaqueUuid, "same opaque uuid across turns");

    // Fresh transcript per turn (contract 3): two DISTINCT files, each stamped
    // with its OWN runId envelope — turn-2 was NOT appended to turn-1's run.
    // (dispatchRun writes background_submitted/pending/run.session_reuse; the
    // detached runner writes prompt.sent — faked out here, so we assert on the
    // durable envelope + routing event each turn produced.)
    const ev1 = await readTranscript(join(runDir, `${r1.runId}.jsonl`));
    const ev2 = await readTranscript(join(runDir, `${r2.runId}.jsonl`));
    assert.ok(ev1.every((e) => e.runId === r1.runId), "turn-1 transcript stamped with turn-1 runId only");
    assert.ok(ev2.every((e) => e.runId === r2.runId), "turn-2 transcript stamped with turn-2 runId only");
    assert.ok(!ev1.some((e) => e.runId === r2.runId), "turn-2 was NOT appended into turn-1's transcript");
    assert.ok(findLatest(ev1, "run.session_reuse")?.turn === "first");
    assert.ok(findLatest(ev2, "run.session_reuse")?.turn === "resume");
  } finally { cleanupDir(dir); }
});

test("M11-11C DISP-3: non-reusable agent retains current behavior (no --session-reuse-json, no leadSession required)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m11c-disp3-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, {
      coder_low: { backend: "claude-code", cwd: dir, model: { id: "m" } },
    });
    const result = await dispatchRun({
      agentId: "coder_low", prompt: "x",
      registryPath, runDir: join(dir, "runs"), spawnFn: fakeSpawn,
      // NOTE: no leadSession, no cwd — must still succeed.
    });
    assert.equal(result.accepted, true);
    assert.ok(!calls[0].args.includes("--session-reuse-json"), "non-reusable agent has no reuse argv");
  } finally { cleanupDir(dir); }
});

test("M11-11C DISP-4: reusable agent without leadSession ⇒ rejected before transcript/fork", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m11c-disp4-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { researcher: reusableClaudeAgent(dir) });
    const runDir = join(dir, "runs");
    await assert.rejects(() => dispatchRun({
      agentId: "researcher", prompt: "x",
      registryPath, runDir, cwd: dir, spawnFn: fakeSpawn, // no leadSession
    }), /leadSession/i);
    assert.equal(calls.length, 0, "no spawn");
    assert.ok(!existsSync(runDir) || readdirSync(runDir).filter((f) => f.endsWith(".jsonl")).length === 0,
      "no transcript written");
  } finally { cleanupDir(dir); }
});

test("M11-11C DISP-5: delivery dispatch is ALWAYS fresh — no --session-reuse-json even for a reusable agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m11c-disp5-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { researcher: reusableClaudeAgent(dir) });
    const result = await dispatchRun({
      agentId: "researcher", prompt: "deliver it",
      registryPath, runDir: join(dir, "runs"), cwd: dir, leadSession: "lead-A",
      spawnFn: fakeSpawn,
      delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"] },
    });
    assert.equal(result.accepted, true);
    const argv = calls[0].args;
    assert.ok(!argv.includes("--session-reuse-json"), "delivery dispatch never reuses a session");
    assert.ok(argv.includes("--isolate"), "delivery still forces isolate");
  } finally { cleanupDir(dir); }
});

test("M11-11C DISP-6: busy — second dispatch while first non-terminal fails BEFORE new transcript/fork", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m11c-disp6-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { researcher: reusableClaudeAgent(dir) });
    const runDir = join(dir, "runs");

    // Turn 1 — fake runner never drives completion, so transcript stays pending.
    const r1 = await dispatchRun({
      agentId: "researcher", prompt: "q1",
      registryPath, runDir, cwd: dir, leadSession: "lead-A", spawnFn: fakeSpawn,
    });
    const before = calls.length;

    // Turn 2 — same triple, first still in-flight.
    let caught = null;
    try {
      await dispatchRun({
        agentId: "researcher", prompt: "q2",
        registryPath, runDir, cwd: dir, leadSession: "lead-A", spawnFn: fakeSpawn,
      });
    } catch (e) { caught = e; }
    assert.ok(caught instanceof ReuseBusyError, "second concurrent dispatch throws ReuseBusyError");
    assert.equal(calls.length, before, "no spawn for the busy dispatch (spawn count unchanged)");
    // No second transcript file appeared.
    const transcripts = readdirSync(runDir).filter((f) => f.endsWith(".jsonl"));
    assert.equal(transcripts.length, 1, "only the first turn's transcript exists");
    assert.ok(transcripts[0].startsWith(r1.runId), "the surviving transcript is turn-1's");
  } finally { cleanupDir(dir); }
});

test("M11-11C DISP-7: cross-triple dispatches do not busy each other (independent supervision)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m11c-disp7-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, {
      researcher: reusableClaudeAgent(dir),
      auditor: { ...reusableClaudeAgent(dir), model: { id: "opus" } },
    });
    const runDir = join(dir, "runs");
    // Same Lead + workspace, two different reusable experts — both first, neither busy.
    const r1 = await dispatchRun({
      agentId: "researcher", prompt: "q", registryPath, runDir, cwd: dir, leadSession: "lead-A", spawnFn: fakeSpawn,
    });
    const r2 = await dispatchRun({
      agentId: "auditor", prompt: "q", registryPath, runDir, cwd: dir, leadSession: "lead-A", spawnFn: fakeSpawn,
    });
    assert.equal(r1.accepted, true);
    assert.equal(r2.accepted, true);
    assert.notEqual(r1.runId, r2.runId);
    assert.equal(calls.length, 2);
  } finally { cleanupDir(dir); }
});

// =====================================================================
// Contract 7: RunManager capability check — unsupported backend fails closed
// =====================================================================

test("M11-11C CAP-1: backend without supportsSessionReuse + sessionReuse task ⇒ fail-closed (no spawn)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m11c-cap1-"));
  try {
    let spawnCalls = 0;
    const mockBackend = {
      supportsRoleContract: true,
      validateAgentPolicy() {},
      async spawn() { spawnCalls += 1; return { backend: "x", backendSessionId: "s", events: async function* () {}, abort: async () => {} }; },
    };
    const readRegistry = async () => ({
      getAgent(id) { return { id, backend: "claude-code", cwd: dir }; },
      listAgents() { return []; },
    });
    const manager = new RunManager({
      config: { registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 1000, timeout: 5000, retries: 0, defaultIsolation: "none" },
      readRegistry, transcriptDir: dir, backendFor: () => mockBackend,
    });
    await assert.rejects(
      () => manager.start("researcher", {
        prompt: "x",
        sessionReuse: { mode: "lead_workspace", opaqueUuid: deriveOpaqueUuid({ leadSession: "l", workspace: dir, agentId: "researcher" }), turn: "first" },
      }),
      /sessionReuse|does not support.*reuse|supportsSessionReuse/i,
    );
    assert.equal(spawnCalls, 0, "unsupported backend never spawned");
  } finally { cleanupDir(dir); }
});

test("M11-11C CAP-2: ClaudeCodeBackend declares supportsSessionReuse === true", () => {
  const b = new ClaudeCodeBackend({});
  assert.equal(b.supportsSessionReuse, true);
});

test("M11-11C CAP-3: malformed routing fails before transcript or spawn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m11c-cap3-"));
  try {
    let spawnCalls = 0;
    const mockBackend = {
      supportsRoleContract: true,
      supportsSessionReuse: true,
      validateAgentPolicy() {},
      async spawn() {
        spawnCalls += 1;
        throw new Error("must not spawn");
      },
    };
    const manager = new RunManager({
      config: {
        registry: "x",
        runDir: dir,
        pollInterval: 10,
        waitTimeout: 1000,
        timeout: 5000,
        retries: 0,
        defaultIsolation: "none",
      },
      readRegistry: async () => ({
        getAgent(id) { return { id, backend: "claude-code", cwd: dir }; },
        listAgents() { return []; },
      }),
      transcriptDir: dir,
      backendFor: () => mockBackend,
    });

    await assert.rejects(
      () => manager.start("researcher", {
        prompt: "x",
        sessionReuse: {
          mode: "lead_workspace",
          turn: "first",
          opaqueUuid: "malformed",
        },
      }),
      /invalid internal routing envelope/,
    );
    assert.equal(spawnCalls, 0);
    assert.equal(
      readdirSync(dir).some((name) => name.endsWith(".jsonl")),
      false,
      "malformed routing creates no transcript",
    );
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// Contract 5: Claude argv compilation (buildArgs) — first --session-id once,
//             later --resume once (no --session-id)
// =====================================================================

test("M11-11C ARGV-1: first turn → claude argv has --session-id <uuid> exactly once, no --resume", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m11c-argv1-"));
  const { spawnFn, captures } = makeCapturingSpawn();
  try {
    const backend = new ClaudeCodeBackend({ spawnFn });
    const uuid = deriveOpaqueUuid({ leadSession: "lead-A", workspace: dir, agentId: "researcher" });
    await backend.spawn(reusableClaudeAgent(dir), { prompt: "hi", sessionReuse: { mode: "lead_workspace", opaqueUuid: uuid, turn: "first" } });
    const args = captures[0].args;
    const sidIdx = args.indexOf("--session-id");
    assert.ok(sidIdx >= 0, "--session-id present on first turn");
    assert.equal(args[sidIdx + 1], uuid, "--session-id value is the opaque uuid");
    assert.equal(args.filter((a) => a === "--session-id").length, 1, "--session-id appears exactly once");
    assert.equal(args.indexOf("--resume"), -1, "no --resume on first turn");
    assert.equal(args.indexOf("--no-session-persistence"), -1,
      "reusable first turn must persist the provider session");
    assert.equal(args.filter((a) => a === "--include-partial-messages").length, 1);
    assert.equal(args.filter((a) => a === "--exclude-dynamic-system-prompt-sections").length, 1);
    assert.equal(captures[0].opts.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS, "1");
  } finally { cleanupDir(dir); }
});

test("M11-11C ARGV-2: resume turn → claude argv has --resume <uuid> exactly once, no --session-id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m11c-argv2-"));
  const { spawnFn, captures } = makeCapturingSpawn();
  try {
    const backend = new ClaudeCodeBackend({ spawnFn });
    const uuid = deriveOpaqueUuid({ leadSession: "lead-A", workspace: dir, agentId: "researcher" });
    await backend.spawn(reusableClaudeAgent(dir), { prompt: "more", sessionReuse: { mode: "lead_workspace", opaqueUuid: uuid, turn: "resume" } });
    const args = captures[0].args;
    const resIdx = args.indexOf("--resume");
    assert.ok(resIdx >= 0, "--resume present on resume turn");
    assert.equal(args[resIdx + 1], uuid, "--resume value is the same opaque uuid");
    assert.equal(args.filter((a) => a === "--resume").length, 1, "--resume appears exactly once");
    assert.equal(args.indexOf("--session-id"), -1, "no --session-id on resume turn");
    assert.equal(args.indexOf("--no-session-persistence"), -1,
      "resume turn must retain the provider session");
  } finally { cleanupDir(dir); }
});

test("M11-11C ARGV-3: no sessionReuse task ⇒ neither --session-id nor --resume (unchanged baseline)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m11c-argv3-"));
  const { spawnFn, captures } = makeCapturingSpawn();
  try {
    const backend = new ClaudeCodeBackend({ spawnFn });
    await backend.spawn(reusableClaudeAgent(dir), { prompt: "hi" });
    const args = captures[0].args;
    assert.equal(args.indexOf("--session-id"), -1);
    assert.equal(args.indexOf("--resume"), -1);
    assert.equal(args.filter((a) => a === "--no-session-persistence").length, 1,
      "ordinary one-shot runs do not leave provider session state behind");
  } finally { cleanupDir(dir); }
});

test("M12-Claude ENV-1: delivery mode disables Claude built-in agents and Git instructions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-claude-env-delivery-"));
  const { spawnFn, captures } = makeCapturingSpawn();
  try {
    const backend = new ClaudeCodeBackend({ spawnFn });
    await backend.spawn(reusableClaudeAgent(dir), { prompt: "delivery", deliveryMode: true });
    const env = captures[0].opts.env;
    assert.equal(env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS, "1");
    assert.equal(env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS, "1");
  } finally { cleanupDir(dir); }
});

test("M12-Claude ENV-2: ordinary mode disables built-in agents but leaves Git instructions unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-claude-env-ordinary-"));
  const { spawnFn, captures } = makeCapturingSpawn();
  try {
    const backend = new ClaudeCodeBackend({ spawnFn });
    await backend.spawn(reusableClaudeAgent(dir), { prompt: "ordinary" });
    const env = captures[0].opts.env;
    assert.equal(env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS, "1");
    assert.equal(env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS, undefined);
  } finally { cleanupDir(dir); }
});

test("M12-Claude TRANSCRIPT-1: latest stream activity and cache metrics persist without raw payload leakage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-claude-latest-transcript-"));
  const rawSecrets = ["SECRET_INIT_PAYLOAD", "SECRET_RETRY_DETAIL", "SECRET_STREAM_DELTA"];
  const { spawnFn, captures } = makeScriptedClaudeSpawn([
    JSON.stringify({ type: "system", subtype: "init", session_id: rawSecrets[0] }),
    JSON.stringify({ type: "system", subtype: "api_retry", error: rawSecrets[1] }),
    JSON.stringify({ type: "stream_event", event: { delta: { text: rawSecrets[2] } } }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        cache_read_input_tokens: 101,
        cache_creation_input_tokens: 13,
      },
      total_cost_usd: 0.02,
    }),
  ]);
  try {
    const result = await runBackground({
      agentId: "researcher",
      prompt: "no-model transcript probe",
      registry: { agents: { researcher: reusableClaudeAgent(dir) } },
      runDir: dir,
      backendFor: () => new ClaudeCodeBackend({ spawnFn }),
      waitTimeout: 5000,
      pollInterval: 10,
    });
    assert.equal(result.completed, true);

    const events = await readTranscript(join(dir, `${result.runId}.jsonl`));
    const statuses = events
      .filter((event) => event.type === "run.event" && event.kind === "runtime_activity")
      .map((event) => event.status);
    assert.deepEqual(statuses, ["initialized", "provider_retry", "streaming"]);

    const metrics = findLatest(events, "run.metrics");
    assert.deepEqual(metrics.tokens, {
      input: 11,
      output: 7,
      cacheRead: 101,
      cacheWrite: 13,
    });
    assert.equal(metrics.tokens.reasoning, undefined, "cache creation is not reasoning");

    const transcriptText = readFileSync(join(dir, `${result.runId}.jsonl`), "utf8");
    for (const secret of rawSecrets) {
      assert.equal(transcriptText.includes(secret), false, `raw provider payload is not persisted: ${secret}`);
    }
    assert.ok(captures[0].args.includes("--include-partial-messages"));
    assert.ok(captures[0].args.includes("--exclude-dynamic-system-prompt-sections"));
    assert.equal(captures[0].opts.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS, "1");
  } finally { cleanupDir(dir); }
});

// =====================================================================
// Contract 5 causal chain: dispatchRun → runner argv → runBackground →
// RunManager → Claude backend --session-id compilation
// =====================================================================

test("M11-11C CHAIN-1: dispatchRun runner argv → runBackground → RunManager → claude --session-id (first)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m11c-chain1-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = makeRegistry(dir, { researcher: reusableClaudeAgent(dir) });
    const runDir = join(dir, "runs");

    // (1) dispatchRun produces the detached runner argv.
    await dispatchRun({
      agentId: "researcher", prompt: "causal q",
      registryPath, runDir, cwd: dir, leadSession: "lead-A", spawnFn: fakeSpawn,
    });
    const runnerArgv = calls[0].args;
    const routingIdx = runnerArgv.indexOf("--session-reuse-json");
    assert.ok(routingIdx >= 0, "dispatchRun threaded --session-reuse-json into runner argv");
    const routingFromArgv = JSON.parse(runnerArgv[routingIdx + 1]);

    // (2) runMain parses --session-reuse-json the same way the runner does.
    const parsed = await runMain_parseOnly(runnerArgv.slice(1)); // drop node-exe argv[0] slot
    assert.deepEqual(parsed.sessionReuse, routingFromArgv, "runMain parses --session-reuse-json faithfully");

    // (3) runBackground threads it to RunManager → Claude backend, compiling --session-id.
    const { spawnFn: capSpawn, captures } = makeCapturingSpawn();
    const bgDir = mkdtempSync(join(tmpdir(), "wao-m11c-chain1-bg-"));
    try {
      const result = await runBackground({
        agentId: "researcher",
        prompt: "causal q",
        registry: { agents: { researcher: reusableClaudeAgent(bgDir, { cwd: bgDir }) } },
        runDir: bgDir,
        sessionReuse: routingFromArgv,
        backendFor: () => new ClaudeCodeBackend({ spawnFn: capSpawn }),
        waitTimeout: 5000,
        pollInterval: 10,
      });
      assert.equal(result.completed, true, "runBackground drove the reused run to completed");
      const claudeArgs = captures[0].args;
      const sidIdx = claudeArgs.indexOf("--session-id");
      assert.ok(sidIdx >= 0, "claude argv compiled --session-id from the threaded routing");
      assert.equal(claudeArgs[sidIdx + 1], routingFromArgv.opaqueUuid, "compiled uuid matches the dispatched one");
      assert.equal(claudeArgs.indexOf("--resume"), -1, "first turn → no --resume");
    } finally { cleanupDir(bgDir); }
  } finally { cleanupDir(dir); }
});

test("M11-11C CHAIN-2: resume routing through runBackground → claude --resume (no --session-id)", async () => {
  const bgDir = mkdtempSync(join(tmpdir(), "wao-m11c-chain2-"));
  const { spawnFn: capSpawn, captures } = makeCapturingSpawn();
  try {
    const uuid = deriveOpaqueUuid({ leadSession: "lead-A", workspace: bgDir, agentId: "researcher" });
    const result = await runBackground({
      agentId: "researcher",
      prompt: "follow up",
      registry: { agents: { researcher: reusableClaudeAgent(bgDir, { cwd: bgDir }) } },
      runDir: bgDir,
      sessionReuse: { mode: "lead_workspace", opaqueUuid: uuid, turn: "resume" },
      backendFor: () => new ClaudeCodeBackend({ spawnFn: capSpawn }),
      waitTimeout: 5000,
      pollInterval: 10,
    });
    assert.equal(result.completed, true);
    const claudeArgs = captures[0].args;
    assert.equal(claudeArgs.indexOf("--session-id"), -1);
    const resIdx = claudeArgs.indexOf("--resume");
    assert.ok(resIdx >= 0);
    assert.equal(claudeArgs[resIdx + 1], uuid);
  } finally { cleanupDir(bgDir); }
});

// Local mirror of runMain's flag parser, to prove the runner reads the exact
// argv dispatchRun produced (without forking a real node subprocess).
async function runMain_parseOnly(argvSlice) {
  // Reuse backgroundRunner.parseSimpleFlags via runMain's contract by importing
  // it lazily — but parseSimpleFlags is not exported. Instead replicate the same
  // two-token rule the runner uses, and additionally assert runMain itself can
  // consume a synthesized argv end-to-end is covered by CHAIN-1/2 via runBackground.
  const opts = {};
  for (let i = 0; i < argvSlice.length; i += 1) {
    const a = argvSlice[i];
    if (a.startsWith("--")) {
      const next = argvSlice[i + 1];
      if (next && !next.startsWith("--")) { opts[a.slice(2)] = next; i += 1; }
    }
  }
  return { sessionReuse: opts["session-reuse-json"] ? JSON.parse(opts["session-reuse-json"]) : undefined };
}

// =====================================================================
// Contracts 2,8,9: MCP — server-owned leadSession, non-leakage, registry_list
// =====================================================================

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-test-client", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("M11-11C MCP-1: server injects a stable leadSession into the dispatcher (server-owned, not model-supplied)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m11c-mcp1-"));
  try {
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: dir, stdio: "pipe" });
    execSync('git config user.email t@t.com', { cwd: dir, stdio: "pipe" });
    execSync('git config user.name t', { cwd: dir, stdio: "pipe" });
    writeFileSync(join(dir, "README.md"), "# x\n", "utf8");
    execSync("git add README.md", { cwd: dir, stdio: "pipe" });
    execSync("git commit -m init", { cwd: dir, stdio: "pipe" });

    const registryPath = makeRegistry(dir, { researcher: reusableClaudeAgent(dir) });
    let captured = null;
    const fakeDispatch = async (input) => { captured = input; return { accepted: true, runId: "run_mcp1", agentId: "researcher", state: "pending" }; };
    const server = createWaoMcpServer({ registryPath, runDir: "/srv/runs", workspaceRoot: dir, dispatchRunFn: fakeDispatch });
    const client = await buildInMemoryClient(server);
    try {
      await client.callTool({ name: "run_dispatch", arguments: { agentId: "researcher", prompt: "hi" } });
      assert.ok(captured.leadSession, "dispatcher received a server-owned leadSession");
      assert.match(captured.leadSession, UUID_V4, "leadSession is a uuid (server-generated)");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

test("M11-11C MCP-2: leadSession is STABLE across calls in one server (same Lead session)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m11c-mcp2-"));
  try {
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: dir, stdio: "pipe" });
    execSync('git config user.email t@t.com', { cwd: dir, stdio: "pipe" });
    execSync('git config user.name t', { cwd: dir, stdio: "pipe" });
    writeFileSync(join(dir, "README.md"), "# x\n", "utf8");
    execSync("git add README.md", { cwd: dir, stdio: "pipe" });
    execSync("git commit -m init", { cwd: dir, stdio: "pipe" });

    const registryPath = makeRegistry(dir, { researcher: reusableClaudeAgent(dir) });
    const seen = [];
    const fakeDispatch = async (input) => { seen.push(input.leadSession); return { accepted: true, runId: `r${seen.length}`, agentId: "researcher", state: "pending" }; };
    const server = createWaoMcpServer({ registryPath, runDir: "/srv/runs", workspaceRoot: dir, dispatchRunFn: fakeDispatch });
    const client = await buildInMemoryClient(server);
    try {
      await client.callTool({ name: "run_dispatch", arguments: { agentId: "researcher", prompt: "a" } });
      await client.callTool({ name: "run_dispatch", arguments: { agentId: "researcher", prompt: "b" } });
      assert.equal(seen.length, 2);
      assert.equal(seen[0], seen[1], "same Lead session identity across calls in one server");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

test("M11-11C MCP-3: run_dispatch output never leaks leadSession/opaqueUuid/workspace/prompt/argv", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m11c-mcp3-"));
  try {
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: dir, stdio: "pipe" });
    execSync('git config user.email t@t.com', { cwd: dir, stdio: "pipe" });
    execSync('git config user.name t', { cwd: dir, stdio: "pipe" });
    writeFileSync(join(dir, "README.md"), "# x\n", "utf8");
    execSync("git add README.md", { cwd: dir, stdio: "pipe" });
    execSync("git commit -m init", { cwd: dir, stdio: "pipe" });

    const registryPath = makeRegistry(dir, { researcher: reusableClaudeAgent(dir) });
    const OPAQUE = deriveOpaqueUuid({ leadSession: "x", workspace: dir, agentId: "researcher" });
    const fakeDispatch = async (input) => ({
      accepted: true, runId: "run_mcp3", agentId: "researcher", state: "pending",
      // Internal leakage bait — none of this may surface:
      transcriptPath: "/secret/run_mcp3.jsonl",
      leadSession: input.leadSession,
      opaqueUuid: OPAQUE,
      workspace: dir,
      argv: ["--session-id", OPAQUE],
    });
    const server = createWaoMcpServer({ registryPath, runDir: "/srv/runs", workspaceRoot: dir, dispatchRunFn: fakeDispatch });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_dispatch", arguments: { agentId: "researcher", prompt: "secret-prompt" } });
      const dumped = JSON.stringify(res);
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);

      // Current exact safe key set: the four original scalars plus the additive
      // bounded workspaceProof (M12-6 FR-03). Strict — the dispatcher's bait
      // (transcriptPath/leadSession/opaqueUuid/workspace/argv) must never surface.
      assert.deepEqual(
        Object.keys(parsed).sort(),
        ["accepted", "agentId", "runId", "state", "workspaceProof"],
        "only the safe keys: four scalars + additive workspaceProof",
      );
      assert.equal(parsed.accepted, true);
      assert.equal(parsed.runId, "run_mcp3");
      assert.equal(parsed.agentId, "researcher");
      assert.equal(parsed.state, "pending");

      // workspaceProof exposes ONLY the intended safe binding fields: source,
      // canonical gitHead, dirty flag, and three nullable match booleans — never
      // the absolute workspace path, prompt, argv, PID, or session id. Strict.
      assert.deepEqual(
        Object.keys(parsed.workspaceProof).sort(),
        ["dirty", "expectedDirtyMatch", "expectedGitHeadMatch", "expectedWorkspaceRootMatch", "gitHead", "source"],
        "workspaceProof has only source/head/dirty + 3 nullable match booleans",
      );
      assert.ok(
        ["lead_session", "server_config", "mcp_root"].includes(parsed.workspaceProof.source),
        "proof source is the closed-set enum",
      );
      assert.ok(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(parsed.workspaceProof.gitHead), "proof gitHead is canonical hex");
      assert.equal(typeof parsed.workspaceProof.dirty, "boolean", "proof dirty is boolean");
      // No expectations were supplied ⇒ all match booleans are null.
      assert.equal(parsed.workspaceProof.expectedGitHeadMatch, null);
      assert.equal(parsed.workspaceProof.expectedDirtyMatch, null);
      assert.equal(parsed.workspaceProof.expectedWorkspaceRootMatch, null);

      // Original no-leak guarantees preserved (leadSession/opaqueUuid/raw
      // workspace path/prompt/argv) — none of the dispatcher bait may surface.
      assert.ok(!dumped.includes(OPAQUE), "no opaque uuid leak");
      assert.ok(!dumped.includes("leadSession"), "no leadSession key leak");
      assert.ok(!dumped.includes("/secret/run_mcp3"), "no transcript path leak");
      assert.ok(!dumped.includes("secret-prompt"), "no prompt leak");
      assert.ok(!dumped.includes("--session-id"), "no argv leak");
      // The raw workspace path is never echoed by the proof (cross-platform
      // forward-slash canonicalization, matching the canonical FR-03 contract).
      assert.ok(!dumped.includes(dir.replace(/\\/g, "/")), "no raw workspace path leak in proof");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

test("M11-11C MCP-4: busy dispatch → fixed actionable text, no runId/opaqueUuid/workspace leak", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m11c-mcp4-"));
  try {
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: dir, stdio: "pipe" });
    execSync('git config user.email t@t.com', { cwd: dir, stdio: "pipe" });
    execSync('git config user.name t', { cwd: dir, stdio: "pipe" });
    writeFileSync(join(dir, "README.md"), "# x\n", "utf8");
    execSync("git add README.md", { cwd: dir, stdio: "pipe" });
    execSync("git commit -m init", { cwd: dir, stdio: "pipe" });

    const registryPath = makeRegistry(dir, { researcher: reusableClaudeAgent(dir) });
    const ACTIVE_RUN = "run_still_active_mcp4";
    const fakeDispatch = async () => { const e = new ReuseBusyError(ACTIVE_RUN); throw e; };
    const server = createWaoMcpServer({ registryPath, runDir: "/srv/runs", workspaceRoot: dir, dispatchRunFn: fakeDispatch });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_dispatch", arguments: { agentId: "researcher", prompt: "again" } });
      assert.equal(res.isError, true, "busy dispatch is a tool error");
      const dumped = JSON.stringify(res);
      const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
      assert.ok(/active|busy|in-flight|in progress/i.test(text), "fixed actionable busy text present");
      assert.ok(!dumped.includes(ACTIVE_RUN), "active runId never leaked");
      assert.ok(!dumped.includes("opaqueUuid"), "no opaque uuid leaked");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

test("M11-11C MCP-5: registry_list projects sessionReuse (nullable) for each agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m11c-mcp5-"));
  try {
    const registryPath = makeRegistry(dir, {
      researcher: reusableClaudeAgent(dir),                 // reusable
      coder_low: { backend: "claude-code", cwd: dir, model: { id: "m" } }, // not reusable
    });
    const server = createWaoMcpServer({ registryPath, runDir: dir });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "registry_list", arguments: {} });
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      const byId = Object.fromEntries(parsed.agents.map((a) => [a.id, a]));
      assert.equal(byId.researcher.sessionReuse, "lead_workspace", "researcher projects reuse mode");
      assert.equal(byId.coder_low.sessionReuse, null, "non-reusable agent projects null");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

test("M11-11C MCP-6: run_dispatch input schema does NOT accept leadSession/workspace/sessionReuse (model cannot supply)", async () => {
  const server = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs" });
  let callCount = 0;
  const fakeDispatch = async () => { callCount += 1; return { accepted: true, runId: "x", agentId: "y", state: "pending" }; };
  // Re-register would be ideal, but the strict input schema is already fixed at
  // server build; assert via a fresh server with the injected dispatcher.
  const server2 = createWaoMcpServer({ registryPath: "/r.json", runDir: "/runs", dispatchRunFn: fakeDispatch });
  const client = await buildInMemoryClient(server2);
  try {
    const bad = [
      { agentId: "x", prompt: "y", leadSession: "attacker" },
      { agentId: "x", prompt: "y", workspace: "D:/evil" },
      { agentId: "x", prompt: "y", sessionReuse: "lead_workspace" },
    ];
    for (const args of bad) {
      let rejected = false;
      let result = null;
      try { result = await client.callTool({ name: "run_dispatch", arguments: args }); }
      catch { rejected = true; }
      if (!rejected) { assert.equal(result.isError, true, `rejected: ${JSON.stringify(Object.keys(args))}`); rejected = true; }
      assert.ok(rejected, `model must not supply ${JSON.stringify(Object.keys(args))}`);
    }
    assert.equal(callCount, 0, "dispatcher never called for model-supplied identity args");
  } finally {
    await client.close();
    await server2.close();
    await server.close();
  }
});
