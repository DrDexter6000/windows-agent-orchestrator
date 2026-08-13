// test/m12-7-runContinue.test.js
//
// M12-7: Lead-authorized correction continuation application service.
//
// continueRun spawns a NEW child run/transcript that resumes the parent's
// provider-native conversation IN THE PARENT'S RETAINED WORKTREE — no fresh
// worktree, no fresh session, no scope inference. Eligibility is decided
// read-only with closed-set refusals BEFORE any mutation (no lineage claim,
// no worktree transition, no transcript, no fork).
//
// These tests pin the eligibility refusals, the happy-path committed + uncommitted
// transitions, the spawn argv (reuse-worktree + lineage-resume + child delivery),
// the returned dispatch identity (parentRunId + continuation:true + rootRunId),
// and the durability of the parent delivery commit across the transition.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { readTranscript, findState, findLatest, JsonlTranscript } from "../src/transcript.js";
import { continueRun } from "../src/application/runContinue.js";

// ----- git + registry + spawn helpers -----

function git(args, cwd) {
  return String(execSync("git " + args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })).trim();
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "wao-m127-rc-"));
  git("init -b main", repo);
  git("config user.email t@t.com", repo);
  git("config user.name T", repo);
  writeFileSync(join(repo, "README.md"), "# base\n", "utf8");
  git("add -A", repo);
  git("commit -m base", repo);
  return repo;
}

function makeRegistry(dir, agents) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return registryPath;
}

function makeFakeSpawn() {
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { unref() {} };
  };
  return { fakeSpawn, calls };
}

function argVal(calls, flag) {
  const a = calls[0].args;
  const i = a.indexOf(flag);
  return i >= 0 ? a[i + 1] : undefined;
}

// Seed a parent run transcript. cwd must be a real git repo (workspace ownership
// proof). worktreePath/baseCommit/deliveryCommit describe the retained delivery
// worktree (committed when deliveryCommit is set).
async function seedParent({
  runDir, runId, agentId, cwd, backend = "claude-code",
  worktreePath, worktreeBranch, baseCommit, allowedPaths = ["src", "keep.txt"],
  deliveryCommit = null, rootRunId, terminalState = "completed",
  withLineage = true, withDeliveryContext = true, withProviderSession = true,
  decision = null,
}) {
  mkdirSync(runDir, { recursive: true });
  const t = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId });
  await t.append("run.background_submitted", { background: true, cwd, deliveryRequested: true });
  await t.transitionState(null, "pending", "background_spawned");
  await t.append("run.started", {
    backend,
    cwd,
    ...(worktreePath ? { worktreePath, worktreeBranch } : {}),
    ...(withDeliveryContext ? {
      delivery: {
        mode: "git_commit_v1",
        baseCommit,
        allowedPaths,
        verificationCommands: ["node --test"],
      },
    } : {}),
  });
  if (withLineage) {
    await t.append("run.session_reuse", { mode: "run_lineage", turn: "first", rootRunId: rootRunId ?? runId });
  }
  if (withProviderSession) {
    await t.append("session.created", { backend, backendSessionId: "provider-session-1", serveUrl: null });
  }
  if (deliveryCommit) {
    await t.append("run.delivery_created", {
      deliveryCommit,
      delivery: {
        schemaVersion: 1, kind: "git_commit", runId,
        baseCommit, deliveryCommit, branch: worktreeBranch, worktreePath, allowedPaths,
        changedFiles: ["keep.txt"], verification: { commands: ["node --test"] },
        acceptance: { status: "pending", reviewerType: "lead_agent" },
        integration: { status: "pending", targetCommit: null },
      },
    });
  }
  if (terminalState) {
    await t.transitionState("pending", terminalState, "done");
  }
  if (decision) {
    await t.append(`run.delivery_${decision}`, {
      delivery: {
        schemaVersion: 1, kind: "git_commit", runId,
        baseCommit, deliveryCommit, branch: worktreeBranch, worktreePath, allowedPaths,
      },
    });
  }
}

// Build a committed parent: repo + worktree wao/<runId> at base + a delivery commit.
function buildCommittedParent(repo, runId) {
  const wt = join(repo, ".wao-worktrees", runId);
  git(`worktree add -b wao/${runId} "${wt}"`, repo);
  const base = git("rev-parse HEAD", repo);
  writeFileSync(join(wt, "keep.txt"), "keep-changed\n", "utf8");
  git("add -A", wt);
  // Use the WAO delivery identity so the commit is a legitimate delivery commit.
  git('-c user.name="WAO Delivery" -c user.email="wao-delivery@local" commit -m "wao-delivery: ' + runId + '"', wt);
  const deliveryCommit = git("rev-parse HEAD", wt);
  return { wt, base, deliveryCommit, branch: `wao/${runId}` };
}

// M12-22: build a committed parent whose retained worktree carries an arbitrary
// set of changed files (relative to base). The cumulative-scope eligibility
// check derives the inherited changed paths from these real worktree facts.
function buildCommittedParentWithChanges(repo, runId, files) {
  const wt = join(repo, ".wao-worktrees", runId);
  git(`worktree add -b wao/${runId} "${wt}"`, repo);
  const base = git("rev-parse HEAD", repo);
  for (const f of files) {
    const parent = dirname(f);
    if (parent && parent !== ".") mkdirSync(join(wt, parent), { recursive: true });
    writeFileSync(join(wt, f), `changed ${f}\n`, "utf8");
  }
  git("add -A", wt);
  git('-c user.name="WAO Delivery" -c user.email="wao-delivery@local" commit -m "wao-delivery: ' + runId + '"', wt);
  const deliveryCommit = git("rev-parse HEAD", wt);
  return { wt, base, deliveryCommit, branch: `wao/${runId}` };
}

// ----- eligibility refusals (read-only, before any mutation) -----

test("M12-7-RC-01: malformed parentRunId / prompt / delivery refused as malformed_input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m127-rc-mal-"));
  try {
    const r1 = await continueRun({ parentRunId: "bad/id", prompt: "x", delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] }, runDir: dir, registryPath: dir, authorizedWorkspaceRoot: dir, leadSession: "s" });
    assert.equal(r1.accepted, false);
    assert.equal(r1.rejectionReason, "malformed_input");
    assert.equal(r1.continuation, true);

    const r2 = await continueRun({ parentRunId: "run_parent_ok", prompt: "", delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] }, runDir: dir, registryPath: dir, authorizedWorkspaceRoot: dir, leadSession: "s" });
    assert.equal(r2.rejectionReason, "malformed_input");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M12-7-RC-02: invalid child delivery shape refused as invalid_delivery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m127-rc-ivd-"));
  try {
    const r = await continueRun({
      parentRunId: "run_parent_ok", prompt: "fix it",
      delivery: { mode: "git_commit_v1", allowedPaths: ["src"] }, // no verification
      runDir: dir, registryPath: dir, authorizedWorkspaceRoot: dir, leadSession: "s",
    });
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "invalid_delivery");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M12-7-RC-03: missing parent transcript refused as parent_not_found", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m127-rc-pnf-"));
  try {
    const r = await continueRun({
      parentRunId: "run_parent_ghost", prompt: "fix it",
      delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] },
      runDir: dir, registryPath: dir, authorizedWorkspaceRoot: dir, leadSession: "s",
    });
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "parent_not_found");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M12-7-RC-04: non-terminal parent refused as parent_not_terminal", async () => {
  const repo = makeRepo();
  const dir = mkdtempSync(join(tmpdir(), "wao-m127-rc-pnt-"));
  try {
    await seedParent({ runDir: dir, runId: "run_parent_nt", agentId: "coder_hq", cwd: repo, baseCommit: git("rev-parse HEAD", repo), worktreePath: repo, worktreeBranch: "main", terminalState: null });
    const r = await continueRun({
      parentRunId: "run_parent_nt", prompt: "fix it",
      delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] },
      runDir: dir, registryPath: makeRegistry(dir, { coder_hq: { backend: "claude-code", cwd: repo } }),
      authorizedWorkspaceRoot: repo, leadSession: "s",
      backendFor: () => ({ supportsSessionReuse: true }),
    });
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "parent_not_terminal");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("M12-7-RC-05: parent without lineage event refused as not_continuable (legacy)", async () => {
  const repo = makeRepo();
  const dir = mkdtempSync(join(tmpdir(), "wao-m127-rc-leg-"));
  try {
    await seedParent({ runDir: dir, runId: "run_parent_legacy", agentId: "coder_hq", cwd: repo, baseCommit: git("rev-parse HEAD", repo), worktreePath: repo, worktreeBranch: "main", withLineage: false });
    const r = await continueRun({
      parentRunId: "run_parent_legacy", prompt: "fix it",
      delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] },
      runDir: dir, registryPath: makeRegistry(dir, { coder_hq: { backend: "claude-code", cwd: repo } }),
      authorizedWorkspaceRoot: repo, leadSession: "s",
      backendFor: () => ({ supportsSessionReuse: true }),
    });
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "not_continuable");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("M12-7-RC-06: wrong workspace refused as workspace_mismatch", async () => {
  const repo = makeRepo();
  const other = makeRepo();
  const dir = mkdtempSync(join(tmpdir(), "wao-m127-rc-wm-"));
  try {
    await seedParent({ runDir: dir, runId: "run_parent_wm", agentId: "coder_hq", cwd: repo, baseCommit: git("rev-parse HEAD", repo), worktreePath: repo, worktreeBranch: "main" });
    const r = await continueRun({
      parentRunId: "run_parent_wm", prompt: "fix it",
      delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] },
      runDir: dir, registryPath: makeRegistry(dir, { coder_hq: { backend: "claude-code", cwd: repo } }),
      authorizedWorkspaceRoot: other, leadSession: "s", // different workspace
      backendFor: () => ({ supportsSessionReuse: true }),
    });
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "workspace_mismatch");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});

test("M12-7-RC-07: backend without session reuse refused as unsupported_backend", async () => {
  const repo = makeRepo();
  const parent = buildCommittedParent(repo, "run_parent_unsup");
  const dir = mkdtempSync(join(tmpdir(), "wao-m127-rc-uns-"));
  try {
    await seedParent({ runDir: dir, runId: "run_parent_unsup", agentId: "coder_hq", cwd: repo, worktreePath: parent.wt, worktreeBranch: parent.branch, baseCommit: parent.base, deliveryCommit: parent.deliveryCommit });
    const r = await continueRun({
      parentRunId: "run_parent_unsup", prompt: "fix it",
      delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] },
      runDir: dir, registryPath: makeRegistry(dir, { coder_hq: { backend: "claude-code", cwd: repo } }),
      authorizedWorkspaceRoot: repo, leadSession: "s",
      backendFor: () => ({ supportsSessionReuse: false }),
    });
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "unsupported_backend");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("M12-7-RC-08: missing retained worktree refused as missing_worktree", async () => {
  const repo = makeRepo();
  const dir = mkdtempSync(join(tmpdir(), "wao-m127-rc-mw-"));
  try {
    // Persist a worktreePath that does not exist on disk.
    await seedParent({ runDir: dir, runId: "run_parent_mw", agentId: "coder_hq", cwd: repo, worktreePath: join(repo, ".wao-worktrees", "never_existed"), worktreeBranch: "wao/run_parent_mw", baseCommit: git("rev-parse HEAD", repo), deliveryCommit: null });
    const r = await continueRun({
      parentRunId: "run_parent_mw", prompt: "fix it",
      delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] },
      runDir: dir, registryPath: makeRegistry(dir, { coder_hq: { backend: "claude-code", cwd: repo } }),
      authorizedWorkspaceRoot: repo, leadSession: "s",
      backendFor: () => ({ supportsSessionReuse: true }),
    });
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "missing_worktree");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

// ----- happy path: committed parent -----

test("M12-7-RC-09: committed parent → child resumes in retained worktree; parent commit intact; argv carries reuse+resume+delivery", async () => {
  const repo = makeRepo();
  const parent = buildCommittedParent(repo, "run_parent_happy");
  const dir = mkdtempSync(join(tmpdir(), "wao-m127-rc-hap-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    await seedParent({ runDir: dir, runId: "run_parent_happy", agentId: "coder_hq", cwd: repo, worktreePath: parent.wt, worktreeBranch: parent.branch, baseCommit: parent.base, deliveryCommit: parent.deliveryCommit });

    const result = await continueRun({
      parentRunId: "run_parent_happy", prompt: "correct the bug",
      delivery: { mode: "git_commit_v1", allowedPaths: ["src", "keep.txt"], verificationCommands: ["node --test"] },
      runDir: dir, registryPath: makeRegistry(dir, { coder_hq: { backend: "claude-code", cwd: repo } }),
      authorizedWorkspaceRoot: repo, leadSession: "lead-session-1",
      spawnFn: fakeSpawn,
      backendFor: () => ({ supportsSessionReuse: true }),
    });

    // Dispatch identity + continuation lineage.
    assert.equal(result.accepted, true);
    assert.equal(result.parentRunId, "run_parent_happy");
    assert.equal(result.continuation, true);
    assert.equal(result.rootRunId, "run_parent_happy");
    assert.equal(result.agentId, "coder_hq");
    assert.ok(result.runId && result.runId !== "run_parent_happy", "child runId generated");
    assert.equal(result.state, "pending");

    // Spawned exactly once, detached + ignored stdio.
    assert.equal(calls.length, 1, "spawned once");
    assert.equal(calls[0].opts.detached, true);
    assert.deepEqual(calls[0].opts.stdio, "ignore");

    // argv: reuses the worktree, resumes the lineage session, ships the child delivery.
    const reuse = JSON.parse(argVal(calls, "--reuse-worktree-json"));
    assert.equal(reuse.branch, `wao/${result.runId}`);
    assert.equal(reuse.path, parent.wt);
    const routing = JSON.parse(argVal(calls, "--session-reuse-json"));
    assert.equal(routing.mode, "run_lineage");
    assert.equal(routing.turn, "resume");
    assert.ok(calls[0].args.includes("--isolate"));
    const djson = JSON.parse(argVal(calls, "--delivery-json"));
    assert.equal(djson.mode, "git_commit_v1");
    // frozen-git-head must NOT be present (reuseWorktree is mutually exclusive).
    assert.ok(!calls[0].args.includes("--frozen-git-head"), "no frozen-git-head on continuation");

    // Worktree transitioned to the CHILD branch at base; parent delivery tree is
    // unstaged working changes; the parent commit object is still reviewable.
    assert.equal(git("symbolic-ref --short HEAD", parent.wt), `wao/${result.runId}`);
    assert.equal(git("rev-parse HEAD", parent.wt), parent.base);
    const status = git("status --porcelain=v1 --untracked-files=all", parent.wt);
    assert.match(status, /keep\.txt/);
    assert.equal(git(`cat-file -e ${parent.deliveryCommit}`, parent.wt), "", "parent commit object intact");

    // Child transcript durable facts: continuation-marked background_submitted +
    // run.session_reuse (run_lineage resume) + pending.
    const childEvents = await readTranscript(join(dir, `${result.runId}.jsonl`));
    const submitted = findLatest(childEvents, "run.background_submitted");
    assert.equal(submitted.continuation, true);
    assert.equal(submitted.parentRunId, "run_parent_happy");
    const reuseEvt = findLatest(childEvents, "run.session_reuse");
    assert.equal(reuseEvt.mode, "run_lineage");
    assert.equal(reuseEvt.turn, "resume");
    assert.equal(findState(childEvents), "pending");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("M12-7-RC-10: busy lineage slot refused as busy (concurrent continuation), no worktree mutation", async () => {
  const repo = makeRepo();
  const parent = buildCommittedParent(repo, "run_parent_busy");
  const dir = mkdtempSync(join(tmpdir(), "wao-m127-rc-busy-"));
  try {
    await seedParent({ runDir: dir, runId: "run_parent_busy", agentId: "coder_hq", cwd: repo, worktreePath: parent.wt, worktreeBranch: parent.branch, baseCommit: parent.base, deliveryCommit: parent.deliveryCommit });
    // Pre-seed the lineage store with a non-terminal owner (an in-flight child).
    const { resolveLineageFirstTurn } = await import("../src/application/sessionReuse.js");
    await resolveLineageFirstTurn({ runDir: dir, runId: "run_parent_busy", leadSession: "lead-session-1", workspace: repo, agentId: "coder_hq", rootRunId: "run_parent_busy", now: 1000 });
    // A non-terminal child occupying the slot.
    const ct = new JsonlTranscript(join(dir, "run_child_inflight.jsonl"), { runId: "run_child_inflight", agentId: "coder_hq" });
    await ct.append("run.started", { backend: "claude-code" });
    await ct.transitionState(null, "pending", "created");
    await ct.append("run.session_reuse", { mode: "run_lineage", turn: "resume", rootRunId: "run_parent_busy" });
    // Overwrite the lineage entry to point at the in-flight child (non-terminal owner).
    const { default: fsp } = await import("node:fs/promises");
    const { join: j } = await import("node:path");
    const { createHash } = await import("node:crypto");
    // Recompute the lineage key the same way the module does, then write the entry.
    const { deriveLineageReuseKeyHash } = await import("../src/application/sessionReuse.js");
    const key = deriveLineageReuseKeyHash({ leadSession: "lead-session-1", workspace: repo, agentId: "coder_hq", rootRunId: "run_parent_busy" });
    await fsp.mkdir(j(dir, ".lineage-reuse"), { recursive: true });
    await fsp.writeFile(j(dir, ".lineage-reuse", `${key}.json`), JSON.stringify({ runId: "run_child_inflight", updatedAt: 2000 }));

    const r = await continueRun({
      parentRunId: "run_parent_busy", prompt: "correct the bug",
      delivery: { mode: "git_commit_v1", allowedPaths: ["src", "keep.txt"], verificationCommands: ["node --test"] },
      runDir: dir, registryPath: makeRegistry(dir, { coder_hq: { backend: "claude-code", cwd: repo } }),
      authorizedWorkspaceRoot: repo, leadSession: "lead-session-1",
      backendFor: () => ({ supportsSessionReuse: true }),
    });
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "busy");
    assert.equal(r.activeRunId, "run_child_inflight");
    // Parent worktree untouched (still on the parent branch at the delivery commit).
    assert.equal(git("symbolic-ref --short HEAD", parent.wt), "wao/run_parent_busy");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("M12-7-RC-11: accepted parent is immutable and refused as parent_accepted", async () => {
  const repo = makeRepo();
  const parent = buildCommittedParent(repo, "run_parent_accepted");
  const dir = mkdtempSync(join(tmpdir(), "wao-m127-rc-accepted-"));
  try {
    await seedParent({
      runDir: dir, runId: "run_parent_accepted", agentId: "coder_hq", cwd: repo,
      worktreePath: parent.wt, worktreeBranch: parent.branch, baseCommit: parent.base,
      deliveryCommit: parent.deliveryCommit, decision: "accepted",
    });
    const r = await continueRun({
      parentRunId: "run_parent_accepted", prompt: "change it again",
      delivery: { mode: "git_commit_v1", allowedPaths: ["keep.txt"], verificationCommands: ["node --test"] },
      runDir: dir, registryPath: makeRegistry(dir, { coder_hq: { backend: "claude-code", cwd: repo } }),
      authorizedWorkspaceRoot: repo, leadSession: "lead-session-1",
      backendFor: () => ({ supportsSessionReuse: true }),
    });
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "parent_accepted");
    assert.equal(git("symbolic-ref --short HEAD", parent.wt), parent.branch);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("M12-7-RC-12: no provider session cannot be resumed", async () => {
  const repo = makeRepo();
  const parent = buildCommittedParent(repo, "run_parent_no_session");
  const dir = mkdtempSync(join(tmpdir(), "wao-m127-rc-no-session-"));
  try {
    await seedParent({
      runDir: dir, runId: "run_parent_no_session", agentId: "coder_hq", cwd: repo,
      worktreePath: parent.wt, worktreeBranch: parent.branch, baseCommit: parent.base,
      deliveryCommit: parent.deliveryCommit, withProviderSession: false,
    });
    const r = await continueRun({
      parentRunId: "run_parent_no_session", prompt: "fix",
      delivery: { mode: "git_commit_v1", allowedPaths: ["keep.txt"], verificationCommands: ["node --test"] },
      runDir: dir, registryPath: makeRegistry(dir, { coder_hq: { backend: "claude-code", cwd: repo } }),
      authorizedWorkspaceRoot: repo, leadSession: "lead-session-1",
      backendFor: () => ({ supportsSessionReuse: true }),
    });
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "no_provider_session");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("M12-7-RC-13: cross-run envelope injection invalidates parent identity before mutation", async () => {
  const repo = makeRepo();
  const parent = buildCommittedParent(repo, "run_parent_cross");
  const dir = mkdtempSync(join(tmpdir(), "wao-m127-rc-cross-"));
  try {
    await seedParent({
      runDir: dir, runId: "run_parent_cross", agentId: "coder_hq", cwd: repo,
      worktreePath: parent.wt, worktreeBranch: parent.branch, baseCommit: parent.base,
      deliveryCommit: parent.deliveryCommit,
    });
    appendFileSync(join(dir, "run_parent_cross.jsonl"), `${JSON.stringify({
      type: "run.session_reuse", runId: "run_attacker", agentId: "coder_hq",
      ts: new Date().toISOString(), seq: 999, mode: "run_lineage", turn: "resume",
      rootRunId: "run_attacker",
    })}\n`, "utf8");
    const r = await continueRun({
      parentRunId: "run_parent_cross", prompt: "fix",
      delivery: { mode: "git_commit_v1", allowedPaths: ["keep.txt"], verificationCommands: ["node --test"] },
      runDir: dir, registryPath: makeRegistry(dir, { coder_hq: { backend: "claude-code", cwd: repo } }),
      authorizedWorkspaceRoot: repo, leadSession: "lead-session-1",
      backendFor: () => ({ supportsSessionReuse: true }),
    });
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "parent_not_found");
    assert.equal(git("symbolic-ref --short HEAD", parent.wt), parent.branch);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("M12-7-RC-14: Windows user-env credential bridge reaches the continuation runner", async () => {
  const repo = makeRepo();
  const parent = buildCommittedParent(repo, "run_parent_cred");
  const dir = mkdtempSync(join(tmpdir(), "wao-m127-rc-cred-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  const keyName = "WAO_M127_TEST_KEY";
  const oldValue = process.env[keyName];
  delete process.env[keyName];
  try {
    await seedParent({
      runDir: dir, runId: "run_parent_cred", agentId: "coder_hq", cwd: repo,
      worktreePath: parent.wt, worktreeBranch: parent.branch, baseCommit: parent.base,
      deliveryCommit: parent.deliveryCommit,
    });
    const r = await continueRun({
      parentRunId: "run_parent_cred", prompt: "fix",
      delivery: { mode: "git_commit_v1", allowedPaths: ["keep.txt"], verificationCommands: ["node --test"] },
      runDir: dir,
      registryPath: makeRegistry(dir, { coder_hq: {
        backend: "claude-code", cwd: repo,
        provider: { protocol: "anthropic-compatible", baseUrl: "https://synthetic.invalid", apiKeyEnv: keyName },
      } }),
      authorizedWorkspaceRoot: repo, leadSession: "lead-session-1",
      backendFor: () => ({ supportsSessionReuse: true }),
      userEnvReader: async (name) => (name === keyName ? "user-env-secret" : undefined),
      spawnFn: fakeSpawn,
    });
    assert.equal(r.accepted, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.env[keyName], "user-env-secret");
  } finally {
    if (oldValue === undefined) delete process.env[keyName]; else process.env[keyName] = oldValue;
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("M12-7-RC-14b: changed backend/model cannot inherit a different provider session", async () => {
  const repo = makeRepo();
  const parent = buildCommittedParent(repo, "run_parent_config");
  const dir = mkdtempSync(join(tmpdir(), "wao-m127-rc-config-"));
  try {
    await seedParent({
      runDir: dir, runId: "run_parent_config", agentId: "coder_hq", cwd: repo,
      worktreePath: parent.wt, worktreeBranch: parent.branch, baseCommit: parent.base,
      deliveryCommit: parent.deliveryCommit,
    });
    const r = await continueRun({
      parentRunId: "run_parent_config", prompt: "fix",
      delivery: { mode: "git_commit_v1", allowedPaths: ["keep.txt"], verificationCommands: ["node --test"] },
      runDir: dir,
      registryPath: makeRegistry(dir, { coder_hq: { backend: "codex", cwd: repo, model: { id: "other" } } }),
      authorizedWorkspaceRoot: repo, leadSession: "lead-session-1",
      backendFor: () => ({ supportsSessionReuse: true }),
    });
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "worker_configuration_changed");
    assert.equal(git("symbolic-ref --short HEAD", parent.wt), parent.branch);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("M12-7-RC-15: argv rejection is pre-mutation and leaves the lineage immediately retryable", async () => {
  const repo = makeRepo();
  const parent = buildCommittedParent(repo, "run_parent_argv");
  const dir = mkdtempSync(join(tmpdir(), "wao-m127-rc-argv-"));
  try {
    await seedParent({
      runDir: dir, runId: "run_parent_argv", agentId: "coder_hq", cwd: repo,
      worktreePath: parent.wt, worktreeBranch: parent.branch, baseCommit: parent.base,
      deliveryCommit: parent.deliveryCommit,
    });
    await assert.rejects(() => continueRun({
      parentRunId: "run_parent_argv", prompt: "x".repeat(25000),
      delivery: { mode: "git_commit_v1", allowedPaths: ["keep.txt"], verificationCommands: ["node --test"] },
      runDir: dir, registryPath: makeRegistry(dir, { coder_hq: { backend: "claude-code", cwd: repo } }),
      authorizedWorkspaceRoot: repo, leadSession: "lead-session-1",
      backendFor: () => ({ supportsSessionReuse: true }),
      spawnFn: () => { throw new Error("must not spawn"); },
    }), /argv too long/);
    assert.equal(git("symbolic-ref --short HEAD", parent.wt), parent.branch, "argv guard runs before worktree transition");

    const { fakeSpawn, calls } = makeFakeSpawn();
    const retry = await continueRun({
      parentRunId: "run_parent_argv", prompt: "narrow correction",
      delivery: { mode: "git_commit_v1", allowedPaths: ["keep.txt"], verificationCommands: ["node --test"] },
      runDir: dir, registryPath: join(dir, "agents.json"),
      authorizedWorkspaceRoot: repo, leadSession: "lead-session-1",
      backendFor: () => ({ supportsSessionReuse: true }), spawnFn: fakeSpawn,
    });
    assert.equal(retry.accepted, true, "no stale claim blocks an immediate valid retry");
    assert.equal(calls.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("M12-7-RC-16: synchronous spawn failure rolls back worktree, transcript, and lineage claim", async () => {
  const repo = makeRepo();
  const parent = buildCommittedParent(repo, "run_parent_spawn");
  const dir = mkdtempSync(join(tmpdir(), "wao-m127-rc-spawn-"));
  try {
    await seedParent({
      runDir: dir, runId: "run_parent_spawn", agentId: "coder_hq", cwd: repo,
      worktreePath: parent.wt, worktreeBranch: parent.branch, baseCommit: parent.base,
      deliveryCommit: parent.deliveryCommit,
    });
    await assert.rejects(() => continueRun({
      parentRunId: "run_parent_spawn", prompt: "narrow correction",
      delivery: { mode: "git_commit_v1", allowedPaths: ["keep.txt"], verificationCommands: ["node --test"] },
      runDir: dir, registryPath: makeRegistry(dir, { coder_hq: { backend: "claude-code", cwd: repo } }),
      authorizedWorkspaceRoot: repo, leadSession: "lead-session-1",
      backendFor: () => ({ supportsSessionReuse: true }),
      spawnFn: () => { throw new Error("synthetic spawn failure"); },
    }), /synthetic spawn failure/);
    assert.equal(git("symbolic-ref --short HEAD", parent.wt), parent.branch);
    assert.equal(git("rev-parse HEAD", parent.wt), parent.deliveryCommit);
    const childTranscripts = (await import("node:fs")).readdirSync(dir)
      .filter((name) => name.startsWith("run_") && name.endsWith(".jsonl") && name !== "run_parent_spawn.jsonl");
    assert.deepEqual(childTranscripts, [], "failed pre-spawn child leaves no orphan transcript");

    const { fakeSpawn, calls } = makeFakeSpawn();
    const retry = await continueRun({
      parentRunId: "run_parent_spawn", prompt: "retry correction",
      delivery: { mode: "git_commit_v1", allowedPaths: ["keep.txt"], verificationCommands: ["node --test"] },
      runDir: dir, registryPath: join(dir, "agents.json"),
      authorizedWorkspaceRoot: repo, leadSession: "lead-session-1",
      backendFor: () => ({ supportsSessionReuse: true }), spawnFn: fakeSpawn,
    });
    assert.equal(retry.accepted, true);
    assert.equal(calls.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("M12-7-RC-17: second-proof drift is reported without overwriting external worktree state", async () => {
  const repo = makeRepo();
  const parent = buildCommittedParent(repo, "run_parent_toctou");
  const dir = mkdtempSync(join(tmpdir(), "wao-m127-rc-toctou-"));
  try {
    await seedParent({
      runDir: dir, runId: "run_parent_toctou", agentId: "coder_hq", cwd: repo,
      worktreePath: parent.wt, worktreeBranch: parent.branch, baseCommit: parent.base,
      deliveryCommit: parent.deliveryCommit,
    });
    const r = await continueRun({
      parentRunId: "run_parent_toctou", prompt: "narrow correction",
      delivery: { mode: "git_commit_v1", allowedPaths: ["keep.txt"], verificationCommands: ["node --test"] },
      runDir: dir, registryPath: makeRegistry(dir, { coder_hq: { backend: "claude-code", cwd: repo } }),
      authorizedWorkspaceRoot: repo, leadSession: "lead-session-1",
      backendFor: () => ({ supportsSessionReuse: true }),
      prepareContinuationWorktreeFn: (worktreePath) => {
        git("branch external-drift", worktreePath);
        git("symbolic-ref HEAD refs/heads/external-drift", worktreePath);
        writeFileSync(join(worktreePath, "external.txt"), "external-owner-state\n", "utf8");
        throw new Error("synthetic second-proof drift");
      },
      spawnFn: () => { throw new Error("must not spawn"); },
    });
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "worktree_drift");
    assert.equal(git("symbolic-ref --short HEAD", parent.wt), "external-drift");
    assert.equal((await import("node:fs")).readFileSync(join(parent.wt, "external.txt"), "utf8"), "external-owner-state\n");
    const childTranscripts = (await import("node:fs")).readdirSync(dir)
      .filter((name) => name.startsWith("run_") && name.endsWith(".jsonl") && name !== "run_parent_toctou.jsonl");
    assert.deepEqual(childTranscripts, []);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

// ----- M12-22: continuation cumulative-scope truth (read-only eligibility) -----
//
// A Lead continuing a terminal rejected/undecided delivery must learn BEFORE
// dispatch whether the retained parent changes are outside the child scope. The
// cumulative-scope check derives the retained candidate's actual changed paths
// from authoritative Git/worktree facts and compares them to the child delivery
// allowedPaths. Uncovered inherited paths => continuation_scope_incomplete, a
// safe structured refusal naming the bounded repo-relative facts so the Lead can
// explicitly approve a cumulative scope and retry. It runs read-only BEFORE any
// lineage claim / worktree transition / transcript / spawn, so a refusal has
// zero side effects.

function childTranscriptsFor(dir, parentRunId) {
  return readdirSync(dir)
    .filter((name) => name.startsWith("run_") && name.endsWith(".jsonl") && name !== `${parentRunId}.jsonl`);
}

test("M12-22-RC-01: parent retains A/B/C; child allows only D => continuation_scope_incomplete with bounded facts, zero side effects", async () => {
  const repo = makeRepo();
  const parent = buildCommittedParentWithChanges(repo, "run_parent_scope", ["a.txt", "b.txt", "c.txt"]);
  const dir = mkdtempSync(join(tmpdir(), "wao-m1222-rc01-"));
  try {
    await seedParent({
      runDir: dir, runId: "run_parent_scope", agentId: "coder_hq", cwd: repo,
      worktreePath: parent.wt, worktreeBranch: parent.branch, baseCommit: parent.base,
      deliveryCommit: parent.deliveryCommit, allowedPaths: ["a.txt", "b.txt", "c.txt"],
    });
    const r = await continueRun({
      parentRunId: "run_parent_scope", prompt: "narrow correction",
      // Child scope is only D — it does NOT cover the inherited A/B/C.
      delivery: { mode: "git_commit_v1", allowedPaths: ["d.txt"], verificationCommands: ["node --test"] },
      runDir: dir, registryPath: makeRegistry(dir, { coder_hq: { backend: "claude-code", cwd: repo } }),
      authorizedWorkspaceRoot: repo, leadSession: "lead-session-1",
      backendFor: () => ({ supportsSessionReuse: true }),
      spawnFn: () => { throw new Error("must not spawn"); },
    });

    // Closed-set refusal + continuation marker.
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "continuation_scope_incomplete");
    assert.equal(r.continuation, true);

    // Exact bounded, sorted, deduplicated inherited + uncovered facts.
    assert.deepEqual(r.inheritedChangedPaths, ["a.txt", "b.txt", "c.txt"]);
    assert.equal(r.inheritedChangedCount, 3);
    assert.equal(r.inheritedChangedTruncated, false);
    assert.deepEqual(r.uncoveredInheritedPaths, ["a.txt", "b.txt", "c.txt"]);
    assert.equal(r.uncoveredInheritedCount, 3);
    assert.equal(r.uncoveredInheritedTruncated, false);

    // Zero side effects: parent worktree untouched (still on parent branch at the
    // delivery commit), no child transcript written, no spawn.
    assert.equal(git("symbolic-ref --short HEAD", parent.wt), parent.branch);
    assert.equal(git("rev-parse HEAD", parent.wt), parent.deliveryCommit);
    assert.deepEqual(childTranscriptsFor(dir, "run_parent_scope"), []);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("M12-22-RC-02: child allowedPaths is a cumulative superset (A/B/C/D) => continuation proceeds in the same worktree/session", async () => {
  const repo = makeRepo();
  const parent = buildCommittedParentWithChanges(repo, "run_parent_superset", ["a.txt", "b.txt", "c.txt"]);
  const dir = mkdtempSync(join(tmpdir(), "wao-m1222-rc02-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    await seedParent({
      runDir: dir, runId: "run_parent_superset", agentId: "coder_hq", cwd: repo,
      worktreePath: parent.wt, worktreeBranch: parent.branch, baseCommit: parent.base,
      deliveryCommit: parent.deliveryCommit, allowedPaths: ["a.txt", "b.txt", "c.txt"],
    });
    const r = await continueRun({
      parentRunId: "run_parent_superset", prompt: "narrow correction",
      // Cumulative superset: covers inherited A/B/C plus the correction delta D.
      // A path authorized here may later be restored to base and disappear from
      // the final delivery; WAO does not interpret that semantic choice — final
      // packaging stays governed by the existing containment gate (unchanged).
      delivery: { mode: "git_commit_v1", allowedPaths: ["a.txt", "b.txt", "c.txt", "d.txt"], verificationCommands: ["node --test"] },
      runDir: dir, registryPath: makeRegistry(dir, { coder_hq: { backend: "claude-code", cwd: repo } }),
      authorizedWorkspaceRoot: repo, leadSession: "lead-session-1",
      spawnFn: fakeSpawn,
      backendFor: () => ({ supportsSessionReuse: true }),
    });

    assert.equal(r.accepted, true);
    assert.equal(r.continuation, true);
    assert.equal(r.rootRunId, "run_parent_superset");
    assert.equal(calls.length, 1, "spawned once");
    // Same retained worktree + lineage resume: no fresh worktree/session.
    const reuse = JSON.parse(argVal(calls, "--reuse-worktree-json"));
    assert.equal(reuse.path, parent.wt);
    const routing = JSON.parse(argVal(calls, "--session-reuse-json"));
    assert.equal(routing.turn, "resume");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("M12-22-RC-03: directory allowedPaths cover descendants on a segment boundary; sibling/outside paths are uncovered", async () => {
  // Positive: "src" covers src/x.js and src/y.js on the segment boundary.
  const repo1 = makeRepo();
  const parent1 = buildCommittedParentWithChanges(repo1, "run_parent_dir_ok", ["src/x.js", "src/y.js"]);
  const dir1 = mkdtempSync(join(tmpdir(), "wao-m1222-rc03a-"));
  const { fakeSpawn: spawn1, calls: calls1 } = makeFakeSpawn();
  try {
    await seedParent({
      runDir: dir1, runId: "run_parent_dir_ok", agentId: "coder_hq", cwd: repo1,
      worktreePath: parent1.wt, worktreeBranch: parent1.branch, baseCommit: parent1.base,
      deliveryCommit: parent1.deliveryCommit, allowedPaths: ["src"],
    });
    const r1 = await continueRun({
      parentRunId: "run_parent_dir_ok", prompt: "narrow correction",
      delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] },
      runDir: dir1, registryPath: makeRegistry(dir1, { coder_hq: { backend: "claude-code", cwd: repo1 } }),
      authorizedWorkspaceRoot: repo1, leadSession: "lead-session-1",
      spawnFn: spawn1, backendFor: () => ({ supportsSessionReuse: true }),
    });
    assert.equal(r1.accepted, true, "directory allowedPath covers its descendants");
    assert.equal(calls1.length, 1);
  } finally { rmSync(dir1, { recursive: true, force: true }); rmSync(repo1, { recursive: true, force: true }); }

  // Negative: "src" does NOT cover src2/z.js (segment boundary) nor other.js.
  const repo2 = makeRepo();
  const parent2 = buildCommittedParentWithChanges(repo2, "run_parent_dir_no", ["src/x.js", "src2/z.js", "other.js"]);
  const dir2 = mkdtempSync(join(tmpdir(), "wao-m1222-rc03b-"));
  try {
    await seedParent({
      runDir: dir2, runId: "run_parent_dir_no", agentId: "coder_hq", cwd: repo2,
      worktreePath: parent2.wt, worktreeBranch: parent2.branch, baseCommit: parent2.base,
      deliveryCommit: parent2.deliveryCommit, allowedPaths: ["src"],
    });
    const r2 = await continueRun({
      parentRunId: "run_parent_dir_no", prompt: "narrow correction",
      delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] },
      runDir: dir2, registryPath: makeRegistry(dir2, { coder_hq: { backend: "claude-code", cwd: repo2 } }),
      authorizedWorkspaceRoot: repo2, leadSession: "lead-session-1",
      backendFor: () => ({ supportsSessionReuse: true }),
      spawnFn: () => { throw new Error("must not spawn"); },
    });
    assert.equal(r2.accepted, false);
    assert.equal(r2.rejectionReason, "continuation_scope_incomplete");
    // Segment boundary: src2/z.js and other.js are uncovered; src/x.js is covered.
    assert.deepEqual(r2.inheritedChangedPaths, ["other.js", "src/x.js", "src2/z.js"]);
    assert.deepEqual(r2.uncoveredInheritedPaths, ["other.js", "src2/z.js"]);
    assert.equal(r2.uncoveredInheritedCount, 2);
    // Zero side effects.
    assert.equal(git("symbolic-ref --short HEAD", parent2.wt), parent2.branch);
    assert.deepEqual(childTranscriptsFor(dir2, "run_parent_dir_no"), []);
  } finally { rmSync(dir2, { recursive: true, force: true }); rmSync(repo2, { recursive: true, force: true }); }
});

test("M12-22-RC-04: malformed/absolute/traversal derived facts fail closed without leaking; cross-run stays parent_not_found", async () => {
  const { computeContinuationCumulativeScope } = await import("../src/application/runContinue.js");
  const base = "0".repeat(40);

  // Pure helper: traversal / absolute / backslash / read-failure / throwing
  // reader all collapse to null — never partial truth, never an echo.
  assert.equal(computeContinuationCumulativeScope("/wt", base, ["src"], () => ["../etc/passwd"]), null);
  assert.equal(computeContinuationCumulativeScope("/wt", base, ["src"], () => ["/abs/secret"]), null);
  assert.equal(computeContinuationCumulativeScope("/wt", base, ["src"], () => ["C:\\secrets\\key"]), null);
  assert.equal(computeContinuationCumulativeScope("/wt", base, ["src"], () => null), null);
  assert.equal(computeContinuationCumulativeScope("/wt", base, ["src"], () => { throw new Error("git boom"); }), null);
  // Malformed child allowedPaths also fail closed (defense in depth).
  assert.equal(computeContinuationCumulativeScope("/wt", base, ["../bad"], () => ["src/x.js"]), null);

  // Service-level: a proven parent whose injected reader yields a traversal path
  // fails closed (generic, non-leaking error) with zero side effects — the
  // malformed path never reaches the refusal facts or the error text.
  const repo = makeRepo();
  const parent = buildCommittedParent(repo, "run_parent_mal");
  const dir = mkdtempSync(join(tmpdir(), "wao-m1222-rc04-"));
  try {
    await seedParent({
      runDir: dir, runId: "run_parent_mal", agentId: "coder_hq", cwd: repo,
      worktreePath: parent.wt, worktreeBranch: parent.branch, baseCommit: parent.base,
      deliveryCommit: parent.deliveryCommit,
    });
    const leakToken = "../escape/secret.txt";
    let captured;
    await assert.rejects(() => continueRun({
      parentRunId: "run_parent_mal", prompt: "x",
      delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] },
      runDir: dir, registryPath: makeRegistry(dir, { coder_hq: { backend: "claude-code", cwd: repo } }),
      authorizedWorkspaceRoot: repo, leadSession: "lead-session-1",
      backendFor: () => ({ supportsSessionReuse: true }),
      spawnFn: () => { throw new Error("must not spawn"); },
      listChangedPathsFn: () => [leakToken],
    }), (err) => { captured = err; return true; });
    assert.ok(captured instanceof Error);
    assert.ok(!String(captured.message).includes(leakToken), "malformed path never leaks into the error");
    assert.equal(git("symbolic-ref --short HEAD", parent.wt), parent.branch, "zero worktree mutation");
    assert.deepEqual(childTranscriptsFor(dir, "run_parent_mal"), [], "zero transcript mutation");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("M12-22-RC-05: cumulative-scope inventory caps at the existing inventory limit with truthful truncation flags", async () => {
  const { computeContinuationCumulativeScope } = await import("../src/application/runContinue.js");
  const { INVENTORY_PATHS_LIMIT } = await import("../src/application/candidateInventory.js");
  const base = "0".repeat(40);

  // 300 covered paths under "cov/" — complete, but the inherited list truncates.
  const manyCovered = Array.from({ length: 300 }, (_, i) => `cov/file${i}.js`);
  const r1 = computeContinuationCumulativeScope("/wt", base, ["cov"], () => manyCovered);
  assert.equal(r1.complete, true);
  assert.equal(r1.inheritedChangedCount, 300);
  assert.equal(r1.inheritedChangedPaths.length, INVENTORY_PATHS_LIMIT);
  assert.equal(r1.inheritedChangedTruncated, true);
  assert.equal(r1.uncoveredInheritedCount, 0);
  assert.equal(r1.uncoveredInheritedPaths.length, 0);
  assert.equal(r1.uncoveredInheritedTruncated, false);

  // 300 uncovered paths under "out/" — incomplete, BOTH lists truncate.
  const manyOutside = Array.from({ length: 300 }, (_, i) => `out/file${i}.js`);
  const r2 = computeContinuationCumulativeScope("/wt", base, ["cov"], () => manyOutside);
  assert.equal(r2.complete, false);
  assert.equal(r2.inheritedChangedCount, 300);
  assert.equal(r2.inheritedChangedTruncated, true);
  assert.equal(r2.uncoveredInheritedCount, 300);
  assert.equal(r2.uncoveredInheritedPaths.length, INVENTORY_PATHS_LIMIT);
  assert.equal(r2.uncoveredInheritedTruncated, true);
});
