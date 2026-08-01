// test/m12-7-sessionReuseLineage.test.js
//
// M12-7: provider-native conversation reuse scoped to an explicit run LINEAGE
// (Lead-authorized correction continuation), NOT project-wide coder reuse.
//
// These tests pin the lineage-scoped session routing contract that lives in
// src/application/sessionReuse.js alongside the existing lead_workspace policy:
//   - the opaque provider UUID is derived from (Lead session + canonical
//     workspace + canonical agentId + ROOT runId), so it is stable across one
//     lineage and isolated across lineages;
//   - the routing envelope {mode:"run_lineage", opaqueUuid, turn} validates
//     through the SAME closed-shape authority as lead_workspace;
//   - the per-key lock/busy logic is REUSED: first turn claims, continuation
//     resumes with the SAME opaque id, a non-terminal lineage owner is busy,
//     and two concurrent continuations of the same parent cannot both proceed.
//
// Security: the opaque uuid / raw Lead id / workspace are never persisted by
// these functions — only bounded routing facts ({runId, updatedAt}).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveOpaqueUuid,
  deriveReuseKeyHash,
  validateSessionReuseRouting,
  SESSION_REUSE_MODES,
  deriveLineageOpaqueUuid,
  deriveLineageReuseKeyHash,
  resolveLineageFirstTurn,
  resolveLineageContinuationTurn,
} from "../src/application/sessionReuse.js";
import { JsonlTranscript } from "../src/transcript.js";

const LEAD = "lead-session-uuid-1";
const WS = "D:/repos/example";
const AGENT = "coder_hq";
const ROOT = "run_root_20260801";

function tmpRunDir() {
  return mkdtempSync(join(tmpdir(), "wao-m127-lineage-"));
}

// An in-memory, injectable lineage store for deterministic concurrency tests.
function memStore() {
  const entries = new Map();
  let lockedBy = null;
  return {
    lockDir: "/dev/null/mem-lock",
    async readEntry(key) { return entries.get(key) ?? null; },
    async writeEntry(key, entry) { entries.set(key, entry); },
    _entries: entries,
    _lockedBy: () => lockedBy,
  };
}

test("M12-7-LIN-01: lineage opaque uuid is deterministic and root-scoped", () => {
  const a = deriveLineageOpaqueUuid({ leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT });
  const a2 = deriveLineageOpaqueUuid({ leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT });
  // RFC 4122 v4 shaped.
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a, a2, "same lineage inputs -> same opaque uuid");

  // Different root -> different uuid (lineage isolation).
  const b = deriveLineageOpaqueUuid({ leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: "run_root_other" });
  assert.notEqual(a, b, "different rootRunId -> different opaque uuid");
});

test("M12-7-LIN-02: lineage uuid never collides with lead_workspace uuid for the same triple", () => {
  const lineage = deriveLineageOpaqueUuid({ leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT });
  const policy = deriveOpaqueUuid({ leadSession: LEAD, workspace: WS, agentId: AGENT });
  assert.notEqual(lineage, policy, "lineage and lead_workspace reuse must be distinct keyspaces");
});

test("M12-7-LIN-03: lineage reuse key hash is sha256 of the opaque uuid (no uuid on disk path)", () => {
  const opaque = deriveLineageOpaqueUuid({ leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT });
  const key = deriveLineageReuseKeyHash({ leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT });
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(!key.includes(opaque), "key hash must not contain the opaque uuid verbatim");
  // Distinct from the lead_workspace key for the same triple.
  const policyKey = deriveReuseKeyHash({ leadSession: LEAD, workspace: WS, agentId: AGENT });
  assert.notEqual(key, policyKey);
});

test("M12-7-LIN-04: validateSessionReuseRouting accepts run_lineage envelope (closed shape)", () => {
  const opaque = deriveLineageOpaqueUuid({ leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT });
  const ok = validateSessionReuseRouting({ mode: "run_lineage", opaqueUuid: opaque, turn: "resume" });
  assert.equal(ok.mode, "run_lineage");
  assert.equal(ok.turn, "resume");
  // Still rejects malformed envelopes (fail closed -> never a silent fresh chat).
  assert.throws(() => validateSessionReuseRouting({ mode: "run_lineage", opaqueUuid: opaque }), /invalid internal routing envelope/);
  assert.throws(() => validateSessionReuseRouting({ mode: "bogus", opaqueUuid: opaque, turn: "first" }), /invalid internal routing envelope/);
  assert.throws(() => validateSessionReuseRouting({ mode: "run_lineage", opaqueUuid: "not-a-uuid", turn: "first" }), /invalid internal routing envelope/);
});

test("M12-7-LIN-05: lead_workspace policy set is unchanged (run_lineage is routing-only, not an agent policy)", () => {
  // run_lineage must NOT become an agent-declarable sessionReuse policy.
  assert.deepEqual([...SESSION_REUSE_MODES], ["lead_workspace"]);
});

test("M12-7-LIN-06: first turn claims the lineage slot and reports turn:first", async () => {
  const runDir = tmpRunDir();
  try {
    const store = memStore();
    const r = await resolveLineageFirstTurn({
      runDir, runId: ROOT, leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT, reuseStore: store, now: 1000,
    });
    assert.equal(r.kind, "first");
    assert.equal(r.routing.mode, "run_lineage");
    assert.equal(r.routing.turn, "first");
    assert.match(r.routing.opaqueUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Slot claimed for the root run.
    const key = deriveLineageReuseKeyHash({ leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT });
    assert.equal(store._entries.get(key).runId, ROOT);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("M12-7-LIN-07: continuation resumes with the SAME opaque id as the first turn", async () => {
  const runDir = tmpRunDir();
  try {
    const store = memStore();
    const first = await resolveLineageFirstTurn({
      runDir, runId: ROOT, leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT, reuseStore: store, now: 1000,
    });
    // Parent (root) is terminal with a session.created -> eligible to resume.
    await seedTerminalTranscript(runDir, ROOT, AGENT);
    const cont = await resolveLineageContinuationTurn({
      runDir, runId: "run_child_1", parentRunId: ROOT, rootRunId: ROOT,
      leadSession: LEAD, workspace: WS, agentId: AGENT, reuseStore: store, now: 2000,
    });
    assert.equal(cont.kind, "resume");
    assert.equal(cont.routing.turn, "resume");
    assert.equal(cont.routing.opaqueUuid, first.routing.opaqueUuid, "continuation reuses the SAME opaque provider id");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("M12-7-LIN-08: a non-terminal lineage owner is busy (no concurrent driving)", async () => {
  const runDir = tmpRunDir();
  try {
    const store = memStore();
    await resolveLineageFirstTurn({
      runDir, runId: ROOT, leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT, reuseStore: store, now: 1000,
    });
    // Root still non-terminal (running) -> continuation must be busy.
    await seedNonTerminalTranscript(runDir, ROOT, AGENT);
    const cont = await resolveLineageContinuationTurn({
      runDir, runId: "run_child_1", parentRunId: ROOT, rootRunId: ROOT,
      leadSession: LEAD, workspace: WS, agentId: AGENT, reuseStore: store, now: 2000,
    });
    assert.equal(cont.kind, "busy");
    assert.equal(cont.activeRunId, ROOT);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("M12-7-LIN-09: concurrent duplicate continuation of the same parent -> loser is busy", async () => {
  const runDir = tmpRunDir();
  try {
    const store = memStore();
    await resolveLineageFirstTurn({
      runDir, runId: ROOT, leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT, reuseStore: store, now: 1000,
    });
    await seedTerminalTranscript(runDir, ROOT, AGENT);
    // First continuation claims the slot as a non-terminal child.
    const c1 = await resolveLineageContinuationTurn({
      runDir, runId: "run_child_1", parentRunId: ROOT, rootRunId: ROOT,
      leadSession: LEAD, workspace: WS, agentId: AGENT, reuseStore: store, now: 2000,
    });
    assert.equal(c1.kind, "resume");
    // The child it spawned is non-terminal (no transcript yet / running) -> a
    // second concurrent continuation must observe it as busy, not fork a rival.
    const c2 = await resolveLineageContinuationTurn({
      runDir, runId: "run_child_2", parentRunId: ROOT, rootRunId: ROOT,
      leadSession: LEAD, workspace: WS, agentId: AGENT, reuseStore: store, now: 3000,
    });
    assert.equal(c2.kind, "busy");
    assert.equal(c2.activeRunId, "run_child_1");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// ---- helpers: write minimal transcripts that findState() treats as terminal / non-terminal ----

async function seedTerminalTranscript(runDir, runId, agentId) {
  const t = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId });
  await t.append("run.started", { backend: "claude-code" });
  await t.transitionState(null, "pending", "created");
  await t.append("session.created", { backend: "claude-code", backendSessionId: "abc", serveUrl: null });
  await t.transitionState("pending", "completed", "done");
}

async function seedNonTerminalTranscript(runDir, runId, agentId) {
  const t = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId });
  await t.append("run.started", { backend: "claude-code" });
  await t.transitionState(null, "pending", "created");
  await t.append("session.created", { backend: "claude-code", backendSessionId: "abc", serveUrl: null });
  await t.transitionState("pending", "submitted", "spawned");
}
