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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  withLineage = true, withDeliveryContext = true,
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
