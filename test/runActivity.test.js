// test/runActivity.test.js
//
// M12-8 Package A — runActivity read-only reader service (TDD RED→GREEN).
//
// readRunActivity is the SINGLE shared read-only entry over runs/<runId>.jsonl:
//   - reads the transcript EXACTLY ONCE,
//   - verifies workspace ownership (fail-closed before projection),
//   - derives agentId / backend / state / terminal from that one snapshot,
//   - NEVER appends (no messages.collected, no audit, no commitAppend).
//
// Covers matrix items #12 (workspace binding) and #14 (zero append + single
// read) at the service layer, plus reader-derived facts. The pure projection
// and the strict MCP schema are covered by their own test files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { rmrfRetry } from "./_rmrfHelper.mjs";

// ===== Helpers =====

function cleanupDir(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

function makeGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "R.md"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: dir });
}

function jl(obj) { return JSON.stringify(obj) + "\n"; }

// Seed a process transcript with assistant messages + evidence + terminal state.
function seedTranscript(runDir, runId, {
  agentId = "coder_low", messages = [], terminal = false, workspaceCwd,
  backend = "process", extraEvents = [],
} = {}) {
  mkdirSync(runDir, { recursive: true });
  const lines = [
    jl({ type: "run.submitted", agentId, ts: "2026-08-02T00:00:00.000Z", runId }),
    jl({ type: "session.created", backend, backendSessionId: "proc_act", runId, agentId }),
    jl({ type: "run.started", backend: "claude-code", ts: "2026-08-02T00:00:01.000Z", runId, agentId }),
    jl({ type: "run.background_submitted", background: true, cwd: workspaceCwd, runId, agentId }),
    jl({ type: "run.state_change", to: "running", reason: "first_event", ts: "2026-08-02T00:00:02.000Z", runId, agentId }),
  ];
  for (const [i, text] of messages.entries()) {
    lines.push(jl({
      type: "run.event", kind: "message", role: "assistant",
      parts: [{ type: "text", text }], ts: `2026-08-02T00:00:${10 + i}.000Z`, runId, agentId,
    }));
  }
  for (const e of extraEvents) lines.push(jl(e));
  if (terminal) {
    lines.push(jl({ type: "run.completed", ts: "2026-08-02T00:10:00.000Z", runId, agentId }));
    lines.push(jl({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-08-02T00:10:01.000Z", runId, agentId }));
  }
  writeFileSync(join(runDir, `${runId}.jsonl`), lines.join(""), "utf8");
}

function countAudits(transcriptPath) {
  try {
    return readFileSync(transcriptPath, "utf8").trim().split("\n")
      .filter((l) => l.includes('"messages.collected"')).length;
  } catch { return 0; }
}

// =====================================================================
// #14a single read — readRunActivity reads the transcript EXACTLY ONCE.
// =====================================================================
test("#14a readRunActivity performs exactly ONE transcript read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-act14a-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-act14a-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_14a", { workspaceCwd: dir, messages: ["one"], terminal: true });
    const { readTranscript } = await import("../src/transcript.js");
    const { readRunActivity } = await import("../src/application/runActivity.js");
    let reads = 0;
    const snap = await readRunActivity({
      runId: "run_14a", runDir,
      readTranscriptFn: async (p) => { reads++; return readTranscript(p); },
    });
    assert.equal(reads, 1, "exactly one transcript read per call");
    assert.ok(Array.isArray(snap.events));
    assert.equal(snap.agentId, "coder_low");
    assert.equal(snap.backend, "process");
    assert.equal(snap.state, "completed");
    assert.equal(snap.terminal, true);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

// =====================================================================
// #14b zero append — bytes unchanged, no audit events, idempotent.
// =====================================================================
test("#14b readRunActivity appends nothing: bytes unchanged + zero audits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-act14b-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-act14b-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_14b", { workspaceCwd: dir, messages: ["final"], terminal: true });
    const tp = join(runDir, "run_14b.jsonl");
    const before = readFileSync(tp);
    const { readRunActivity } = await import("../src/application/runActivity.js");
    const a = await readRunActivity({ runId: "run_14b", runDir });
    const b = await readRunActivity({ runId: "run_14b", runDir });
    assert.equal(readFileSync(tp).equals(before), true, "transcript bytes unchanged");
    assert.equal(countAudits(tp), 0, "zero messages.collected");
    // idempotent: same snapshot facts across repeated calls.
    assert.equal(a.agentId, b.agentId);
    assert.equal(a.backend, b.backend);
    assert.equal(a.state, b.state);
    assert.equal(a.terminal, b.terminal);
    assert.equal(a.events.length, b.events.length);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

// =====================================================================
// #12 workspace binding — ownership mismatch fails closed (before projection).
// =====================================================================
test("#12a readRunActivity rejects cross-workspace (ownership mismatch)", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "wao-act12a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wao-act12ab-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-act12a-rd-"));
  try {
    makeGitRepo(dirA); makeGitRepo(dirB);
    seedTranscript(runDir, "run_12a", { workspaceCwd: dirA, messages: [], terminal: false });
    const { readRunActivity } = await import("../src/application/runActivity.js");
    await assert.rejects(
      () => readRunActivity({ runId: "run_12a", runDir, authorizedWorkspaceRoot: dirB }),
    );
  } finally { cleanupDir(dirA); cleanupDir(dirB); rmrfRetry(runDir); }
});

test("#12b matching workspace passes ownership and returns the snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-act12b-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-act12b-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_12b", { workspaceCwd: dir, messages: ["ok"], terminal: true });
    const { readRunActivity } = await import("../src/application/runActivity.js");
    const snap = await readRunActivity({ runId: "run_12b", runDir, authorizedWorkspaceRoot: dir });
    assert.equal(snap.agentId, "coder_low");
    assert.equal(snap.terminal, true);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

// =====================================================================
// #12c malformed/missing ownership fact fails closed.
// =====================================================================
test("#12c missing run.background_submitted fails closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-act12c-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-act12c-rd-"));
  try {
    makeGitRepo(dir);
    mkdirSync(runDir, { recursive: true });
    const id = "run_12c", a = "coder_low";
    const lines = [
      jl({ type: "run.submitted", agentId: a, ts: "2026-08-02T00:00:00.000Z", runId: id }),
      jl({ type: "session.created", backend: "process", backendSessionId: "p", runId: id, agentId: a }),
      // NO run.background_submitted fact.
      jl({ type: "run.state_change", to: "running", reason: "x", ts: "2026-08-02T00:00:02.000Z", runId: id, agentId: a }),
    ];
    writeFileSync(join(runDir, `${id}.jsonl`), lines.join(""), "utf8");
    const { readRunActivity } = await import("../src/application/runActivity.js");
    await assert.rejects(() => readRunActivity({ runId: id, runDir, authorizedWorkspaceRoot: dir }));
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

// =====================================================================
// Reader-derived facts: agentId (canonical/unknown), backend, state, terminal.
// =====================================================================
test("reader derives agentId canonical and degrades cross-run to unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-act-id-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-act-id-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_id", { workspaceCwd: dir, agentId: "coder_low", messages: ["x"], terminal: true });
    const { readRunActivity } = await import("../src/application/runActivity.js");
    const ok = await readRunActivity({ runId: "run_id", runDir });
    assert.equal(ok.agentId, "coder_low");

    // Cross-run contamination: file run_OTHER.jsonl carries runId "run_id".
    const cross = [
      jl({ type: "run.submitted", agentId: "coder_low", ts: "2026-08-02T00:00:00.000Z", runId: "run_id" }),
      jl({ type: "session.created", backend: "process", backendSessionId: "p2", runId: "run_id", agentId: "coder_low" }),
      jl({ type: "run.background_submitted", background: true, cwd: dir, runId: "run_id", agentId: "coder_low" }),
      jl({ type: "run.state_change", to: "running", reason: "x", ts: "2026-08-02T00:00:03.000Z", runId: "run_id", agentId: "coder_low" }),
    ];
    writeFileSync(join(runDir, "run_OTHER.jsonl"), cross.join(""), "utf8");
    const out = await readRunActivity({ runId: "run_OTHER", runDir });
    assert.equal(out.agentId, "unknown");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("reader derives backend from session.created and non-terminal state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-act-be-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-act-be-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_be", { workspaceCwd: dir, backend: "claude-code", messages: [], terminal: false });
    const { readRunActivity } = await import("../src/application/runActivity.js");
    const snap = await readRunActivity({ runId: "run_be", runDir });
    assert.equal(snap.backend, "claude-code");
    assert.equal(snap.terminal, false);
    assert.equal(snap.state, "running");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

// =====================================================================
// Invalid runId rejected before any read.
// =====================================================================
test("invalid runId rejected before any read", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-act-rin-rd-"));
  try {
    let reads = 0;
    const { readRunActivity } = await import("../src/application/runActivity.js");
    await assert.rejects(
      () => readRunActivity({ runId: "../escape", runDir, readTranscriptFn: async () => { reads++; return []; } }),
      /runId/i,
    );
    assert.equal(reads, 0);
  } finally { rmrfRetry(runDir); }
});

// =====================================================================
// Architecture purity: runActivity.js imports no commands/mcp/SDK/zod.
// =====================================================================
test("runActivity.js imports no commands/mcp/SDK/zod and reuses SSOTs", async () => {
  const { readFileSync: rf } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = rf(join(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "application", "runActivity.js"), "utf8");
  assert.ok(!src.includes('from "../commands/'), "no commands/");
  assert.ok(!src.includes('from "../mcp/'), "no mcp/");
  assert.ok(!src.includes("@modelcontextprotocol/sdk"), "no SDK");
  assert.ok(!src.includes('from "zod"'), "no zod");
  assert.ok(src.includes("readTranscript"), "reuses readTranscript SSOT");
  assert.ok(src.includes("verifyRunWorkspaceOwnership"), "reuses workspace ownership SSOT");
  assert.ok(src.includes("extractCanonicalAgentId"), "reuses canonical agentId SSOT");
});
