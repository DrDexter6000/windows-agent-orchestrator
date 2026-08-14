// test/ownerDashboard.test.js
//
// M12-8C Package C — ownerDashboard composition service (TDD RED→GREEN).
//
// A thin composition over the EXISTING application SSOTs (listRuns,
// readRunActivity, projectRunActivity({audience:"owner"}), checkOwnerLiveness):
//   - bounded workspace-owned recent run list,
//   - selected run owner activity page (owner caps + redaction-before-bound +
//     desc latest-first),
//   - safe liveness {ownerHeartbeat, secondsSinceHeartbeat} — NEVER PID/path/
//     session.
//
// Missing/corrupt/cross-workspace data maps to a small closed-set safe outcome,
// never raw exception text. Every read is a single snapshot — zero transcript
// append, zero worktree mutation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { rmrfRetry } from "../_rmrfHelper.mjs";
import { createOwnerDashboardServer } from "../../src/ownerDashboardServer.js";

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

function gitPorcelain(dir) {
  return execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim();
}

function jl(obj) { return JSON.stringify(obj) + "\n"; }

// Seed a transcript for one run into runDir. workspaceCwd binds ownership.
function seedTranscript(runDir, runId, {
  agentId = "coder_low", messages = [], terminal = false, workspaceCwd,
  backend = "process", seqBase = 0, extraLines = [],
  // M12-20: when provided, the terminal events' ts (and thus the transcript-
  // derived updatedAt) is set to this ISO ts instead of the default 00:20:0x.
  // Used by the history-range test to place each terminal run at a distinct
  // point in time. Default preserves the pre-M12-20 behavior exactly.
  terminalTs = "2026-08-02T00:20:01.000Z",
} = {}) {
  mkdirSync(runDir, { recursive: true });
  const lines = [
    jl({ type: "run.submitted", agentId, ts: "2026-08-02T00:00:00.000Z", runId }),
    jl({ type: "session.created", backend, backendSessionId: "proc_dash_" + runId, runId, agentId }),
    jl({ type: "run.background_submitted", background: true, cwd: workspaceCwd, runId, agentId }),
    jl({ type: "run.state_change", to: "running", reason: "first_event", ts: "2026-08-02T00:00:02.000Z", runId, agentId }),
  ];
  for (const [i, text] of messages.entries()) {
    lines.push(jl({
      type: "run.event", kind: "message", role: "assistant",
      parts: [{ type: "text", text }], ts: `2026-08-02T00:0${seqBase}:0${i}.000Z`, runId, agentId, seq: seqBase * 10 + i + 1,
    }));
  }
  for (const l of extraLines) lines.push(l);
  if (terminal) {
    lines.push(jl({ type: "run.completed", ts: terminalTs, runId, agentId }));
    lines.push(jl({ type: "run.state_change", to: "completed", reason: "done", ts: terminalTs, runId, agentId }));
  }
  writeFileSync(join(runDir, `${runId}.jsonl`), lines.join(""), "utf8");
}

function writeOwnerHeartbeat(runDir, runId, heartbeatAt) {
  writeFileSync(join(runDir, `.owner-${runId}`), JSON.stringify({ heartbeatAt, pid: 99999, path: "/super/secret/session" }), "utf8");
}

// Drive the HTTP handler in-memory with a fake req/res (no real socket). Used by
// the end-to-end env-redaction proof which runs the REAL handler + REAL service
// over a real transcript (git group: fs + git + transcript on disk).
function drive(handler, { method = "GET", url = "/", headers = {} } = {}) {
  const req = { method, url, headers: { ...headers } };
  const state = { statusCode: 200, headers: {}, body: "", ended: false };
  const res = {
    setHeader(k, v) { state.headers[String(k).toLowerCase()] = v; },
    writeHead(status) { state.statusCode = status; },
    write(c) { state.body += typeof c === "string" ? c : Buffer.from(c).toString("utf8"); },
    end(c) { if (c !== undefined) this.write(c); state.ended = true; },
    getHeader(k) { return state.headers[String(k).toLowerCase()]; },
  };
  const p = handler(req, res);
  return Promise.resolve(p).then(() => ({
    status: state.statusCode, headers: state.headers, body: state.body, ended: state.ended,
  }));
}

async function svc() {
  return (await import("../../src/application/ownerDashboard.js"));
}

// =====================================================================
// RUN LIST — bounded workspace-owned recent run list
// =====================================================================
test("getOwnerRuns returns only workspace-owned runs (cross-workspace excluded)", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "wao-od-runs-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wao-od-runs-b-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-od-runs-rd-"));
  try {
    makeGitRepo(dirA); makeGitRepo(dirB);
    seedTranscript(runDir, "run_a", { workspaceCwd: dirA, messages: ["a"], terminal: true });
    seedTranscript(runDir, "run_b", { workspaceCwd: dirA, messages: ["b"], terminal: true });
    seedTranscript(runDir, "run_c", { workspaceCwd: dirA, messages: ["c"], terminal: true });
    seedTranscript(runDir, "run_other", { workspaceCwd: dirB, messages: ["x"], terminal: true });
    const { getOwnerRuns } = await svc();
    const res = await getOwnerRuns({ runDir, workspaceRoot: dirA, knownAgentIds: ["coder_low"] });
    const ids = res.runs.map((r) => r.runId).sort();
    assert.deepEqual(ids, ["run_a", "run_b", "run_c"], "only dirA runs visible");
    assert.equal(res.matchedCount, 3);
    assert.equal(res.returnedCount, 3);
    assert.equal(res.truncated, false);
    // Each summary carries ONLY safe closed-set fields (no prompt/path/command/PID).
    const json = JSON.stringify(res.runs);
    assert.ok(!json.includes("super") && !json.includes("99999"), "no path/PID in summaries");
  } finally { cleanupDir(dirA); cleanupDir(dirB); rmrfRetry(runDir); }
});

test("getOwnerRuns honors latest bound and reports truncation; missing runDir → empty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-od-runs-cap-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-od-runs-cap-rd-"));
  try {
    makeGitRepo(dir);
    for (const id of ["run_a", "run_b", "run_c"]) {
      seedTranscript(runDir, id, { workspaceCwd: dir, messages: [id], terminal: true });
    }
    const { getOwnerRuns } = await svc();
    const res = await getOwnerRuns({ runDir, workspaceRoot: dir, latest: 2 });
    assert.equal(res.returnedCount, 2);
    assert.equal(res.matchedCount, 3);
    assert.equal(res.truncated, true);
    // Missing runDir never throws — safe empty list.
    const empty = await getOwnerRuns({ runDir: join(tmpdir(), "wao-od-does-not-exist-" + process.pid), workspaceRoot: dir });
    assert.deepEqual(empty.runs, []);
    assert.equal(empty.matchedCount, 0);
    assert.equal(empty.truncated, false);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

// =====================================================================
// ACTIVITY — owner caps + redaction-before-bound
// =====================================================================
test("getOwnerActivity projects an owner page (owner caps, redaction-before-bound, no raw payload)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-od-act-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-od-act-rd-"));
  try {
    makeGitRepo(dir);
    const SECRET = "test-secret-od-act-1";
    const longText = "z".repeat(6000); // > LEAD cap (4000), < OWNER cap (8000)
    seedTranscript(runDir, "run_act1", {
      workspaceCwd: dir,
      messages: [`safe ${SECRET} tail`, longText],
      terminal: true,
    });
    const { getOwnerActivity } = await svc();
    const res = await getOwnerActivity({
      runId: "run_act1", runDir, workspaceRoot: dir,
      env: { LEAK_TOKEN: SECRET }, now: 1_000_000,
    });
    assert.equal(res.available, true);
    assert.equal(res.unavailableReason, null);
    assert.ok(res.activity, "activity page present");
    // Owner text cap (8000) lets the full 6000-char message through.
    const longMsg = res.activity.entries.find((e) => e.category === "message" && e.text.startsWith("zzzz"));
    assert.ok(longMsg, "long message projected");
    assert.ok(longMsg.text.length > 4000, "owner cap (not lead cap) applied");
    // Secret redacted; never raw payload / backend session / PID / path.
    const dump = JSON.stringify(res);
    assert.ok(!dump.includes(SECRET), "raw secret never crosses");
    assert.ok(dump.includes("[REDACTED"), "redaction marker present");
    assert.ok(!dump.includes("proc_dash_run_act1"), "no backend session id");
    assert.ok(!dump.includes("/super/secret") && !dump.includes("99999"), "no PID/path/session");
    assert.ok(!dump.includes(dir), "no absolute workspace path");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("getOwnerActivity desc gives latest-first owner bootstrap (exact reverse)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-od-desc-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-od-desc-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_desc", {
      workspaceCwd: dir, messages: ["m0", "m1", "m2", "m3", "m4"], terminal: true,
    });
    const { getOwnerActivity } = await svc();
    const asc = await getOwnerActivity({ runId: "run_desc", runDir, workspaceRoot: dir, order: "asc", now: 1 });
    const desc = await getOwnerActivity({ runId: "run_desc", runDir, workspaceRoot: dir, order: "desc", now: 1 });
    const ascTexts = asc.activity.entries.filter((e) => e.category === "message").map((e) => e.text);
    const descTexts = desc.activity.entries.filter((e) => e.category === "message").map((e) => e.text);
    assert.deepEqual(descTexts, [...ascTexts].reverse(), "desc is exact reverse of asc");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

// =====================================================================
// WORKSPACE MISMATCH FAILS BEFORE PROJECTION (no leak, projection never run)
// =====================================================================
test("getOwnerActivity cross-workspace fails BEFORE projection (unavailable: cross_workspace)", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "wao-od-xws-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wao-od-xws-b-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-od-xws-rd-"));
  try {
    makeGitRepo(dirA); makeGitRepo(dirB);
    const SECRET = "test-secret-od-xws-1";
    seedTranscript(runDir, "run_xws", {
      workspaceCwd: dirA, messages: [`leak ${SECRET}`], terminal: false,
    });
    const { getOwnerActivity } = await svc();
    let projectCalled = false;
    const res = await getOwnerActivity({
      runId: "run_xws", runDir, workspaceRoot: dirB,
      env: { LEAK_TOKEN: SECRET }, now: 1_000_000,
      projectRunActivityFn: () => { projectCalled = true; return { entries: [] }; },
    });
    assert.equal(res.available, false);
    assert.equal(res.unavailableReason, "cross_workspace");
    assert.equal(res.activity, null);
    assert.equal(projectCalled, false, "projection NEVER ran on a cross-workspace run");
    // No leak of the cross-workspace content.
    const dump = JSON.stringify(res);
    assert.ok(!dump.includes(SECRET), "no secret leak on cross-workspace refusal");
    // Liveness must not probe a run we do not own.
    assert.equal(res.liveness.ownerHeartbeat, "n/a");
    assert.equal(res.liveness.secondsSinceHeartbeat, null);
  } finally { cleanupDir(dirA); cleanupDir(dirB); rmrfRetry(runDir); }
});

// =====================================================================
// MISSING / CORRUPT → closed-set safe outcomes (never raw exception text)
// =====================================================================
test("getOwnerActivity missing run → unavailable: not_found", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-od-nf-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-od-nf-rd-"));
  try {
    makeGitRepo(dir);
    const { getOwnerActivity } = await svc();
    const res = await getOwnerActivity({ runId: "run_missing", runDir, workspaceRoot: dir, now: 1 });
    assert.equal(res.available, false);
    assert.equal(res.unavailableReason, "not_found");
    assert.equal(res.activity, null);
    assert.equal(res.liveness.ownerHeartbeat, "n/a");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("getOwnerActivity corrupt run → unavailable: corrupt (no raw exception text)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-od-corrupt-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-od-corrupt-rd-"));
  try {
    makeGitRepo(dir);
    // Cross-run envelope: every event carries a runId != the requested one.
    // readRunActivity's assertEventsBoundToRunId throws BEFORE projection.
    const id = "run_corrupt", a = "coder_low";
    const cross = [
      jl({ type: "run.submitted", agentId: a, ts: "2026-08-02T00:00:00.000Z", runId: "run_OTHER" }),
      jl({ type: "session.created", backend: "process", backendSessionId: "p", runId: "run_OTHER", agentId: a }),
      jl({ type: "run.background_submitted", background: true, cwd: dir, runId: "run_OTHER", agentId: a }),
      jl({ type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "raw BOOM text here" }], ts: "2026-08-02T00:00:10.000Z", runId: "run_OTHER", agentId: a }),
    ];
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, `${id}.jsonl`), cross.join(""), "utf8");
    const { getOwnerActivity } = await svc();
    const res = await getOwnerActivity({ runId: id, runDir, workspaceRoot: dir, now: 1 });
    assert.equal(res.available, false);
    assert.equal(res.unavailableReason, "corrupt");
    assert.equal(res.activity, null);
    // No raw exception text / payload leaks into the safe outcome.
    const dump = JSON.stringify(res);
    assert.ok(!dump.includes("BOOM"), "no raw corrupt payload");
    assert.ok(!dump.includes("Error"), "no raw exception text");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

// =====================================================================
// LIVENESS — never PID/path/session; fresh/stale/n/a closed set
// =====================================================================
test("getOwnerActivity liveness maps fresh/stale/n/a and NEVER exposes PID/path/session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-od-live-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-od-live-rd-"));
  try {
    makeGitRepo(dir);
    const NOW = 100_000;
    seedTranscript(runDir, "run_live", { workspaceCwd: dir, messages: ["x"], terminal: false });
    const { getOwnerActivity } = await svc();

    // fresh: heartbeat 1s ago.
    writeOwnerHeartbeat(runDir, "run_live", NOW - 1000);
    const fresh = await getOwnerActivity({ runId: "run_live", runDir, workspaceRoot: dir, now: NOW });
    assert.equal(fresh.liveness.ownerHeartbeat, "fresh");
    assert.equal(fresh.liveness.secondsSinceHeartbeat, 1);

    // stale: heartbeat 60s ago (threshold 10s).
    writeOwnerHeartbeat(runDir, "run_live", NOW - 60000);
    const stale = await getOwnerActivity({ runId: "run_live", runDir, workspaceRoot: dir, now: NOW });
    assert.equal(stale.liveness.ownerHeartbeat, "stale");
    assert.equal(stale.liveness.secondsSinceHeartbeat, 60);

    // n/a: no owner file (e.g. terminal run / pre-heartbeat).
    rmSync(join(runDir, ".owner-run_live"), { force: true });
    const na = await getOwnerActivity({ runId: "run_live", runDir, workspaceRoot: dir, now: NOW });
    assert.equal(na.liveness.ownerHeartbeat, "n/a");
    assert.equal(na.liveness.secondsSinceHeartbeat, null);

    // Closed-set shape: ONLY ownerHeartbeat + secondsSinceHeartbeat. The owner
    // file deliberately contains a pid + path; neither may ever surface.
    for (const r of [fresh, stale, na]) {
      assert.deepEqual(Object.keys(r.liveness).sort(), ["ownerHeartbeat", "secondsSinceHeartbeat"]);
    }
    const dump = JSON.stringify(fresh) + JSON.stringify(stale);
    assert.ok(!dump.includes("99999"), "PID never surfaces");
    assert.ok(!dump.includes("/super/secret"), "path/session never surfaces");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

// =====================================================================
// READ-ONLY: repeated reads leave transcript bytes + Git worktree unchanged
// =====================================================================
test("getOwnerActivity is read-only: transcript bytes + git worktree unchanged across reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-od-ro-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-od-ro-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_ro", { workspaceCwd: dir, messages: ["one", "two"], terminal: true });
    writeOwnerHeartbeat(runDir, "run_ro", 5_000);
    const tp = join(runDir, "run_ro.jsonl");
    const bytesBefore = readFileSync(tp);
    const porcelainBefore = gitPorcelain(dir);
    assert.equal(porcelainBefore, "", "workspace clean before reads");

    const { getOwnerActivity } = await svc();
    for (let i = 0; i < 5; i += 1) {
      await getOwnerActivity({ runId: "run_ro", runDir, workspaceRoot: dir, now: 6_000 });
    }
    assert.equal(readFileSync(tp).equals(bytesBefore), true, "transcript bytes unchanged");
    assert.equal(gitPorcelain(dir), "", "git worktree still clean");
    // owner file untouched too.
    assert.ok(existsSync(join(runDir, ".owner-run_ro")), "owner file not deleted/mutated");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

// =====================================================================
// HTTP BOUNDARY (end-to-end) — a server-owned env secret is redacted through the
// REAL handler + REAL service + REAL projector over a real transcript. Causal
// proof for Fix 1: env authority threads handler → service → projector redactor,
// so a secret present in the server-owned env is redacted BEFORE bounding and the
// raw secret never appears in the /api/activity response.
// =====================================================================
test("HTTP /api/activity redacts a server-owned env secret end-to-end (real handler+service+projector)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-od-env-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-od-env-rd-"));
  try {
    makeGitRepo(dir);
    const SECRET = "test-secret-od-env-1";
    seedTranscript(runDir, "run_env", {
      workspaceCwd: dir,
      messages: [`plain prefix ${SECRET} trailing suffix`],
      terminal: false,
    });
    // No service fakes: real handler → real getOwnerActivity → real
    // readRunActivity → real projectRunActivity redactor. env authority must
    // thread all the way to createSecretRedactor(env). Redaction is BEFORE
    // bounding (the message is far under the owner text cap; the service unit
    // test covers the straddle-the-bound case).
    const server = createOwnerDashboardServer({
      runDir, workspaceRoot: dir, knownAgentIds: ["coder_low"],
      env: { LEAK_TOKEN: SECRET },
    });
    const r = await drive(server.handler, {
      url: "/api/activity?runId=run_env",
      headers: { authorization: "Bearer " + server.token },
    });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.available, true);
    assert.equal(body.unavailableReason, null);
    // The raw secret never crosses the HTTP boundary; the redaction marker does.
    assert.ok(!r.body.includes(SECRET), "raw server-owned secret never in response body");
    assert.ok(r.body.includes("[REDACTED"), "secret redacted before projection output");
    // No backend session / PID / path / absolute workspace path leaks either.
    assert.ok(!r.body.includes("proc_dash_run_env"), "no backend session id");
    assert.ok(!r.body.includes(dir), "no absolute workspace path");
    assert.ok(!r.body.includes("/super/secret") && !r.body.includes("99999"), "no PID/path/session");
    // Liveness for a run with no owner heartbeat file → n/a (never probes).
    assert.equal(body.liveness.ownerHeartbeat, "n/a");
    assert.equal(body.liveness.secondsSinceHeartbeat, null);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

// =====================================================================
// HTTP BOUNDARY (real-chain causal) — drive the REAL createOwnerDashboardServer
// handler + REAL getOwnerActivity/readRunActivity/projectRunActivity chain (NO
// injected activity fake) over a synthetic workspace/run transcript. Proves the
// full trust boundary in one end-to-end read: secret redacted before bound, every
// sensitive artifact withheld, and the read is non-mutating on transcript + Git.
// =====================================================================
test("HTTP /api/activity real-chain: redacts secret, withholds prompt/command/path/PID/session, read-only on transcript+git", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-od-realchain-ws-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-od-realchain-rd-"));
  try {
    makeGitRepo(dir);
    const NOW = 100_000_000;
    const SECRET = "test-secret-realchain-1";
    const runId = "run_realchain";
    const a = "coder_low";
    const ts = "2026-08-02T00:00:00.000Z";
    // Each sensitive marker lives ONLY in the field that must drop/redact it, so
    // every "absent" assertion below is causally meaningful (not vacuous):
    //   - PROMPT marker  → run.submitted.prompt (skipped type; snapshot has no prompt)
    //   - PROVSID marker → session.created.backendSessionId (skipped; only `backend` label surfaces)
    //   - RAWCMD marker  → run.event kind:command.command (command entry emits no text)
    //   - SECRET         → message text (redacted by the env-threaded redactor)
    const lines = [
      jl({ type: "run.submitted", agentId: a, ts, runId, prompt: "PROMPT_MARKER_xyz the secret task brief" }),
      jl({ type: "session.created", backend: "process", backendSessionId: "PROVSID_xyz_456", runId, agentId: a }),
      jl({ type: "run.background_submitted", background: true, cwd: dir, runId, agentId: a }),
      jl({ type: "run.state_change", to: "running", reason: "first_event", ts, runId, agentId: a }),
      jl({ type: "run.event", kind: "command", command: "rm -rf / && echo RAWCMD_xyz_123", exitCode: 0, ts, runId, agentId: a, seq: 1 }),
      jl({ type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "config value is " + SECRET + " right here" }], ts, runId, agentId: a, seq: 2 }),
    ];
    mkdirSync(runDir, { recursive: true });
    const transcriptPath = join(runDir, `${runId}.jsonl`);
    writeFileSync(transcriptPath, lines.join(""), "utf8");
    // Real owner heartbeat (fresh) carrying a PID + session path that must NEVER surface.
    writeOwnerHeartbeat(runDir, runId, NOW - 1000);

    // REAL handler + REAL service chain. Only nowFn is injected (a clock hook for
    // deterministic liveness — NOT a service fake); getOwnerActivity /
    // readRunActivity / projectRunActivity / checkOwnerLiveness all run for real.
    const server = createOwnerDashboardServer({
      runDir, workspaceRoot: dir, knownAgentIds: ["coder_low"],
      env: { APP_API_TOKEN: SECRET },
      nowFn: () => NOW,
    });

    // Read-only baselines BEFORE the request.
    const bytesBefore = readFileSync(transcriptPath);
    const ownerBefore = readFileSync(join(runDir, `.owner-${runId}`));
    const porcelainBefore = gitPorcelain(dir);
    assert.equal(porcelainBefore, "", "workspace clean before request");

    const auth = { authorization: "Bearer " + server.token };
    let r;
    for (let i = 0; i < 3; i += 1) {
      r = await drive(server.handler, { url: `/api/activity?runId=${runId}`, headers: auth });
    }

    // --- Required: HTTP 200 + available=true ---
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.available, true);
    assert.equal(body.unavailableReason, null);

    // --- Required: redaction marker present, raw secret absent (whole body) ---
    assert.ok(r.body.includes("[REDACTED"), "redaction marker present");
    assert.ok(!r.body.includes(SECRET), "raw configured secret absent from response body");

    // --- Required: no absolute workspace/runDir path, PID, provider session id,
    //     prompt, or raw command appears anywhere in the response body ---
    assert.ok(!r.body.includes("wao-od-realchain-ws-"), "no absolute workspace path");
    assert.ok(!r.body.includes("wao-od-realchain-rd-"), "no absolute runDir path");
    assert.ok(!r.body.includes("99999"), "no PID");
    assert.ok(!r.body.includes("/super/secret"), "no owner session path");
    assert.ok(!r.body.includes("PROVSID_xyz_456"), "no provider session id");
    assert.ok(!r.body.includes("PROMPT_MARKER_xyz"), "no prompt");
    assert.ok(!r.body.includes("RAWCMD_xyz_123"), "no raw command");

    // --- Real projection actually ran (not a fake): a command entry exists and
    //     carries NO text/command field; a message entry exists and was redacted. ---
    const entries = (body.activity && body.activity.entries) || [];
    const cmd = entries.find((e) => e.category === "command");
    const msg = entries.find((e) => e.category === "message");
    assert.ok(cmd, "real projection produced a command entry");
    assert.ok(!("command" in cmd) && !("text" in cmd) && !("args" in cmd), "command entry carries no raw command text");
    assert.ok(msg, "real projection produced a message entry");
    assert.ok(msg.text.includes("[REDACTED"), "real redactor ran on real message text");
    assert.ok(!msg.text.includes(SECRET), "raw secret absent from projected message");

    // --- Liveness is the closed-set shape, fresh from the real heartbeat, no PID ---
    assert.equal(body.liveness.ownerHeartbeat, "fresh");
    assert.equal(body.liveness.secondsSinceHeartbeat, 1);

    // --- Required: read-only — transcript bytes + Git worktree unchanged ---
    assert.equal(readFileSync(transcriptPath).equals(bytesBefore), true, "transcript bytes unchanged across reads");
    assert.equal(readFileSync(join(runDir, `.owner-${runId}`)).equals(ownerBefore), true, "owner heartbeat file unchanged");
    assert.equal(gitPorcelain(dir), "", "Git worktree unchanged across reads");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

// =====================================================================
// M12-20 — active-first / history-on-demand (getOwnerRuns threads scanScope)
//   The composition service is a THIN pass-through to the ONE listRuns SSOT:
//   it threads scanScope / historyRange / now / readSummaryFn and echoes
//   scanScope in its result so the HTTP client can guard mode/epoch races.
//   The service result NEVER carries unresolvedCount (it is dropped at this
//   layer for every scope), so "absent, never 0" holds trivially here.
// =====================================================================
test("M12-20 getOwnerRuns active scope: only fresh-lease runs; scanScope echoed; never unresolvedCount", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-od-act-ws-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-od-act-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_active", { workspaceCwd: dir, terminal: false });
    seedTranscript(runDir, "run_done", { workspaceCwd: dir, terminal: true });
    const NOW = 100_000_000;
    // A CURRENT owner lease on the non-terminal run → it is an active candidate.
    writeOwnerHeartbeat(runDir, "run_active", NOW - 1000);
    // run_done is terminal and has NO lease → not an active candidate.
    const { getOwnerRuns } = await svc();
    const res = await getOwnerRuns({
      runDir, workspaceRoot: dir, knownAgentIds: ["coder_low"],
      scanScope: "active", now: NOW,
    });
    assert.equal(res.scanScope, "active", "active scope is echoed for the client race guard");
    assert.deepEqual(res.runs.map((r) => r.runId), ["run_active"], "only the proven-active run");
    assert.equal(res.runs[0].activityStatus, "active");
    assert.ok(!("unresolvedCount" in res), "service result never carries unresolvedCount");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("M12-20 getOwnerRuns history scope: bounded inclusive range on transcript updatedAt; scanScope echoed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-od-hist-ws-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-od-hist-rd-"));
  try {
    makeGitRepo(dir);
    // Three terminal runs whose LAST event ts places each one in time. The range
    // is keyed on the transcript-derived updatedAt (the terminal event's ts via
    // terminalTs), NOT on filesystem mtime.
    const before = "run_hist_before";
    const insideA = "run_hist_inside_a";
    const insideB = "run_hist_inside_b";
    const at = (hh, mm, ss) => `2026-08-02T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.000Z`;
    seedTranscript(runDir, before, { workspaceCwd: dir, terminal: true, terminalTs: at(0, 0, 1) });
    seedTranscript(runDir, insideA, { workspaceCwd: dir, terminal: true, terminalTs: at(0, 10, 0) });
    seedTranscript(runDir, insideB, { workspaceCwd: dir, terminal: true, terminalTs: at(0, 20, 0) });
    const fromMs = Date.parse(at(0, 5, 0));
    const toMs = Date.parse(at(0, 25, 0));
    const { getOwnerRuns } = await svc();
    const res = await getOwnerRuns({
      runDir, workspaceRoot: dir, knownAgentIds: ["coder_low"],
      scanScope: "history", historyRange: { fromMs, toMs },
    });
    assert.equal(res.scanScope, "history");
    assert.deepEqual(res.runs.map((r) => r.runId).sort(), [insideA, insideB].sort(), "inclusive of in-range; before excluded");
    assert.ok(!("unresolvedCount" in res));
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

test("M12-20 getOwnerRuns default scope: unchanged result shape (no scanScope field)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-od-def-ws-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-od-def-rd-"));
  try {
    makeGitRepo(dir);
    seedTranscript(runDir, "run_a", { workspaceCwd: dir, messages: ["a"], terminal: true });
    seedTranscript(runDir, "run_b", { workspaceCwd: dir, messages: ["b"], terminal: true });
    const { getOwnerRuns } = await svc();
    const res = await getOwnerRuns({ runDir, workspaceRoot: dir, knownAgentIds: ["coder_low"] });
    assert.ok(!("scanScope" in res), "default scope (no scanScope) is byte-identical: no scanScope field");
    assert.equal(res.runs.length, 2);
    assert.deepEqual(Object.keys(res).sort(), ["matchedCount", "returnedCount", "runs", "truncated"]);
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});

// =====================================================================
// ARCHITECTURE PURITY
// =====================================================================
test("ownerDashboard.js imports no commands/mcp/SDK/zod and reuses the SSOTs", async () => {
  const { readFileSync: rf } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = rf(join(fileURLToPath(new URL(".", import.meta.url)), "../..", "src", "application", "ownerDashboard.js"), "utf8");
  assert.ok(!src.includes('from "../commands/'), "no commands/");
  assert.ok(!src.includes('from "../mcp/'), "no mcp/");
  assert.ok(!src.includes("@modelcontextprotocol/sdk"), "no SDK");
  assert.ok(!src.includes('from "zod"'), "no zod");
  assert.ok(src.includes("listRuns"), "reuses listRuns SSOT");
  assert.ok(src.includes("readRunActivity"), "reuses readRunActivity SSOT");
  assert.ok(src.includes("projectRunActivity"), "reuses projectRunActivity SSOT");
  assert.ok(src.includes("checkOwnerLiveness"), "reuses checkOwnerLiveness SSOT");
});
