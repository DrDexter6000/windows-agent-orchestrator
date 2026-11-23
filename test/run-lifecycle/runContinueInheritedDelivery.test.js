// test/run-lifecycle/runContinueInheritedDelivery.test.js
//
// 第 135 批（决定 0130）：run_continue 的 delivery 可省——省略时子运行继承父
// 运行**已生效**的交付合同（父转录 run.started 已落盘的合同事实，不从别处
// 推断；父运行若是续修，就取它自己 run.started 里那份）。继承不扩大范围：
// 是 Lead 先前已批准的范围；11b 累计范围核照旧在继承来的合同上执行。
//
// Coverage:
//   - INH-01: delivery omitted → the child delivery argv equals the parent's
//     persisted contract verbatim (mode/allowedPaths/verificationCommands)
//   - INH-02: full-contract inheritance (setupCommands + verificationTimeoutMs)
//   - INH-03: parent without a delivery context + omitted delivery → no_delivery
//   - INH-04: persisted contract fails revalidation → invalid_delivery (closed set)
//   - INH-05: continuation parent inherits ITS OWN effective contract (not the
//     root's) — 取"父运行自己已生效的那份"
//   - INH-06: 11b cumulative-scope check still runs on the inherited contract
//     (uncovered retained change → continuation_scope_incomplete)

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { JsonlTranscript } from "../../src/transcript.js";
import { continueRun } from "../../src/application/runContinue.js";

// ----- git + registry + spawn helpers (same shapes as m12-7-runContinue) -----

function git(args, cwd) {
  return String(execSync("git " + args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })).trim();
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "wao-rc-inh-"));
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
    calls.push({ cmd, args, opts, stdinText: null });
    return {
      unref() {},
      stdin: { once() {}, end(text, cb) { calls.at(-1).stdinText = String(text ?? ""); cb?.(); } },
    };
  };
  return { fakeSpawn, calls };
}

function argVal(calls, flag) {
  const a = calls[0].args;
  const i = a.indexOf(flag);
  return i >= 0 ? a[i + 1] : undefined;
}

/** Seed a terminal lineage parent transcript with a fully controllable
 *  run.started delivery contract (the inheritance source). */
async function seedParentWithContract({
  runDir, runId, agentId, cwd, backend = "claude-code",
  worktreePath, worktreeBranch, baseCommit, deliveryCommit = null,
  delivery, rootRunId, turn = "first", terminalState = "completed",
}) {
  mkdirSync(runDir, { recursive: true });
  const t = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId });
  await t.append("run.background_submitted", { background: true, cwd, deliveryRequested: true });
  await t.transitionState(null, "pending", "background_spawned");
  await t.append("run.started", {
    backend,
    cwd,
    ...(worktreePath ? { worktreePath, worktreeBranch } : {}),
    ...(delivery ? { delivery } : {}),
  });
  await t.append("run.session_reuse", { mode: "run_lineage", turn, rootRunId: turn === "first" ? (rootRunId ?? runId) : (rootRunId ?? runId) });
  await t.append("session.created", { backend, backendSessionId: "provider-session-1", serveUrl: null });
  if (deliveryCommit) {
    await t.append("run.delivery_created", {
      deliveryCommit,
      delivery: {
        schemaVersion: 1, kind: "git_commit", runId,
        baseCommit, deliveryCommit, branch: worktreeBranch, worktreePath,
        allowedPaths: delivery?.allowedPaths ?? [],
        changedFiles: ["keep.txt"], verification: { commands: delivery?.verificationCommands ?? [] },
        acceptance: { status: "pending", reviewerType: "lead_agent" },
        integration: { status: "pending", targetCommit: null },
      },
    });
  }
  if (terminalState) {
    await t.transitionState("pending", terminalState, "done");
  }
}

/** Minimal valid lineage ROOT transcript (identity source for a continuation parent). */
async function seedRoot({ runDir, runId, agentId, cwd, backend = "claude-code", delivery }) {
  const t = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId });
  await t.append("run.background_submitted", { background: true, cwd, deliveryRequested: true });
  await t.transitionState(null, "pending", "background_spawned");
  await t.append("run.started", { backend, cwd, delivery });
  await t.append("run.session_reuse", { mode: "run_lineage", turn: "first", rootRunId: runId });
  await t.append("session.created", { backend, backendSessionId: "provider-session-root", serveUrl: null });
  await t.transitionState("pending", "completed", "done");
}

/** Committed parent: repo + worktree wao/<runId> at base + a delivery commit. */
function buildCommittedParent(repo, runId, files = ["keep.txt"]) {
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

const SERVICE_ARGS = (over = {}) => ({
  authorizedWorkspaceRoot: over.repo,
  runDir: over.dir,
  registryPath: makeRegistry(over.dir, { coder_hq: { backend: "claude-code", cwd: over.repo } }),
  spawnFn: over.spawnFn,
  backendFor: () => ({ supportsSessionReuse: true }),
});

// ----- tests -----

test("INH-01: delivery omitted — child delivery argv equals the parent's persisted contract verbatim", async () => {
  const repo = makeRepo();
  const parent = buildCommittedParent(repo, "run_parent_inh1");
  const dir = mkdtempSync(join(tmpdir(), "wao-rc-inh1-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    await seedParentWithContract({
      runDir: dir, runId: "run_parent_inh1", agentId: "coder_hq", cwd: repo,
      worktreePath: parent.wt, worktreeBranch: parent.branch, baseCommit: parent.base,
      deliveryCommit: parent.deliveryCommit,
      delivery: { mode: "git_commit_v1", baseCommit: parent.base, allowedPaths: ["src", "keep.txt"], verificationCommands: ["node --test"] },
    });
    const result = await continueRun({
      parentRunId: "run_parent_inh1", prompt: "correct the bug",
      // delivery deliberately omitted — inheritance path.
      runDir: dir, ...SERVICE_ARGS({ repo, dir, spawnFn: fakeSpawn }),
    });
    assert.equal(result.accepted, true, `accepted (rejectionReason=${result.rejectionReason})`);
    assert.equal(calls.length, 1, "spawned once");
    const djson = JSON.parse(argVal(calls, "--delivery-json"));
    assert.deepEqual(djson, {
      mode: "git_commit_v1",
      allowedPaths: ["keep.txt", "src"],
      verificationCommands: ["node --test"],
    }, "child contract is the parent's persisted contract, value-for-value");
    // Explicit-delivery behavior is unchanged: same call WITH an explicit
    // contract produces the same public delivery.
    const repo2 = makeRepo();
    const parent2 = buildCommittedParent(repo2, "run_parent_inh1b");
    const dir2 = mkdtempSync(join(tmpdir(), "wao-rc-inh1b-"));
    try {
      const { fakeSpawn: s2, calls: c2 } = makeFakeSpawn();
      await seedParentWithContract({
        runDir: dir2, runId: "run_parent_inh1b", agentId: "coder_hq", cwd: repo2,
        worktreePath: parent2.wt, worktreeBranch: parent2.branch, baseCommit: parent2.base,
        deliveryCommit: parent2.deliveryCommit,
        delivery: { mode: "git_commit_v1", baseCommit: parent2.base, allowedPaths: ["src", "keep.txt"], verificationCommands: ["node --test"] },
      });
      const r2 = await continueRun({
        parentRunId: "run_parent_inh1b", prompt: "correct the bug",
        delivery: { mode: "git_commit_v1", allowedPaths: ["keep.txt", "src"], verificationCommands: ["node --test"] },
        runDir: dir2, ...SERVICE_ARGS({ repo: repo2, dir: dir2, spawnFn: s2 }),
      });
      assert.equal(r2.accepted, true);
      assert.deepEqual(JSON.parse(argVal(c2, "--delivery-json")), djson, "explicit contract inherits byte-identical public delivery");
    } finally { rmSync(dir2, { recursive: true, force: true }); rmSync(repo2, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("INH-02: full-contract inheritance — setupCommands and verificationTimeoutMs survive into the child argv", async () => {
  const repo = makeRepo();
  const parent = buildCommittedParent(repo, "run_parent_inh2");
  const dir = mkdtempSync(join(tmpdir(), "wao-rc-inh2-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    await seedParentWithContract({
      runDir: dir, runId: "run_parent_inh2", agentId: "coder_hq", cwd: repo,
      worktreePath: parent.wt, worktreeBranch: parent.branch, baseCommit: parent.base,
      deliveryCommit: parent.deliveryCommit,
      delivery: {
        mode: "git_commit_v1", baseCommit: parent.base, allowedPaths: ["keep.txt", "src"],
        verificationCommands: ["node --test"],
        verificationSetupCommands: ["npm ci"],
        verificationTimeoutMs: 600000,
      },
    });
    const result = await continueRun({
      parentRunId: "run_parent_inh2", prompt: "fix",
      runDir: dir, ...SERVICE_ARGS({ repo, dir, spawnFn: fakeSpawn }),
    });
    assert.equal(result.accepted, true, `accepted (rejectionReason=${result.rejectionReason})`);
    const djson = JSON.parse(argVal(calls, "--delivery-json"));
    assert.deepEqual(djson, {
      mode: "git_commit_v1",
      allowedPaths: ["keep.txt", "src"],
      verificationCommands: ["node --test"],
      verificationSetupCommands: ["npm ci"],
      verificationTimeoutMs: 600000,
    }, "the whole effective contract is inherited (setup + budget included)");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("INH-03: parent without a delivery context + omitted delivery → no_delivery (closed set)", async () => {
  const repo = makeRepo();
  const parent = buildCommittedParent(repo, "run_parent_inh3");
  const dir = mkdtempSync(join(tmpdir(), "wao-rc-inh3-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    await seedParentWithContract({
      runDir: dir, runId: "run_parent_inh3", agentId: "coder_hq", cwd: repo,
      worktreePath: parent.wt, worktreeBranch: parent.branch, baseCommit: parent.base,
      deliveryCommit: parent.deliveryCommit,
      delivery: null, // no run.started delivery facts
    });
    const r = await continueRun({
      parentRunId: "run_parent_inh3", prompt: "fix",
      runDir: dir, ...SERVICE_ARGS({ repo, dir, spawnFn: fakeSpawn }),
    });
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "no_delivery", "nothing to inherit → the existing closed-set refusal");
    assert.equal(calls.length, 0, "zero spawn on refusal");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("INH-04: persisted contract fails revalidation → invalid_delivery (closed set, zero side effects)", async () => {
  const repo = makeRepo();
  const parent = buildCommittedParent(repo, "run_parent_inh4");
  const dir = mkdtempSync(join(tmpdir(), "wao-rc-inh4-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    await seedParentWithContract({
      runDir: dir, runId: "run_parent_inh4", agentId: "coder_hq", cwd: repo,
      worktreePath: parent.wt, worktreeBranch: parent.branch, baseCommit: parent.base,
      deliveryCommit: parent.deliveryCommit,
      delivery: { mode: "git_commit_v1", baseCommit: parent.base, allowedPaths: ["src"] }, // no verification declaration
    });
    const r = await continueRun({
      parentRunId: "run_parent_inh4", prompt: "fix",
      runDir: dir, ...SERVICE_ARGS({ repo, dir, spawnFn: fakeSpawn }),
    });
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "invalid_delivery", "corrupt inherited contract refuses on the existing closed-set code");
    assert.equal(calls.length, 0, "zero spawn on refusal");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

// ===== 续修 5（第 135 批续修单）：继承合同按子运行启动的同一套规则校验 =====
// 四种坏持久化合同各一条负例——不补值、不丢字段，一律 invalid_delivery。

/** Seed + run an omitted-delivery continuation; makeDelivery(parent) builds the
 *  bad contract (base must be the REAL canonical base so step 7 passes and the
 *  refusal lands on the contract revalidation, not no_delivery). */
async function inhBadContract(makeDelivery, tag) {
  const repo = makeRepo();
  const parent = buildCommittedParent(repo, `run_parent_${tag}`);
  const dir = mkdtempSync(join(tmpdir(), `wao-rc-${tag}-`));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    await seedParentWithContract({
      runDir: dir, runId: `run_parent_${tag}`, agentId: "coder_hq", cwd: repo,
      worktreePath: parent.wt, worktreeBranch: parent.branch, baseCommit: parent.base,
      deliveryCommit: parent.deliveryCommit,
      delivery: makeDelivery(parent),
    });
    const r = await continueRun({
      parentRunId: `run_parent_${tag}`, prompt: "fix",
      runDir: dir, ...SERVICE_ARGS({ repo, dir, spawnFn: fakeSpawn }),
    });
    return { r, calls };
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
}

test("INH-04a: inherited contract with a missing mode refuses (SSOT must not default a persisted contract)", async () => {
  const { r, calls } = await inhBadContract((parent) => ({
    // 只有 mode 缺失——其余字段完整，让拒绝落在合同校验上。
    baseCommit: parent.base, allowedPaths: ["src"], verificationCommands: ["node --test"],
  }), "inh4a");
  assert.equal(r.accepted, false);
  assert.equal(r.rejectionReason, "invalid_delivery", "missing persisted mode is contract damage");
  assert.equal(calls.length, 0);
});

test("INH-04b: inherited contract with string-form setup commands refuses (never dropped silently)", async () => {
  const { r, calls } = await inhBadContract((parent) => ({
    mode: "git_commit_v1", baseCommit: parent.base, allowedPaths: ["src"],
    verificationCommands: ["node --test"], verificationSetupCommands: "npm ci",
  }), "inh4b");
  assert.equal(r.accepted, false);
  assert.equal(r.rejectionReason, "invalid_delivery", "a string setup value is contract damage");
  assert.equal(calls.length, 0);
});

test("INH-04c: inherited contract with BOTH commands and unavailableReason refuses (no silent field dropping)", async () => {
  const { r, calls } = await inhBadContract((parent) => ({
    mode: "git_commit_v1", baseCommit: parent.base, allowedPaths: ["src"],
    verificationCommands: ["node --test"], verificationUnavailableReason: "no runner",
  }), "inh4c");
  assert.equal(r.accepted, false);
  assert.equal(r.rejectionReason, "invalid_delivery", "the SSOT's commands-wins tiebreak must not apply to a persisted contract");
  assert.equal(calls.length, 0);
});

test("INH-04d: inherited contract with a legacy glob allowedPath refuses (same rules as child start, non-persisted)", async () => {
  const { r, calls } = await inhBadContract((parent) => ({
    mode: "git_commit_v1", baseCommit: parent.base, allowedPaths: ["src/*"],
    verificationCommands: ["node --test"],
  }), "inh4d");
  assert.equal(r.accepted, false);
  assert.equal(r.rejectionReason, "invalid_delivery", "globs are refused on the child-start rules, not persisted leniency");
  assert.equal(calls.length, 0);
});

test("INH-04e: inherited contract with a null mode refuses (第 135 批续修 6：null 不冒充缺省)", async () => {
  const { r, calls } = await inhBadContract((parent) => ({
    mode: null, baseCommit: parent.base, allowedPaths: ["src"], verificationCommands: ["node --test"],
  }), "inh4e");
  assert.equal(r.accepted, false);
  assert.equal(r.rejectionReason, "invalid_delivery");
  assert.equal(calls.length, 0);
});

// Lead close-out after the recheck seat: every PRESENT field goes to the SSOT
// as it is — a blank or null second declaration, or a non-array commands
// field next to a valid reason, refuses instead of being dropped.
for (const [id, extra] of [
  ["INH-04f", { verificationCommands: ["node --test"], verificationUnavailableReason: " " }],
  ["INH-04g", { verificationCommands: ["node --test"], verificationUnavailableReason: null }],
  ["INH-04h", { verificationCommands: "node --test", verificationUnavailableReason: "no runner" }],
]) {
  test(`${id}: inherited contract with a malformed second verification field refuses (never dropped)`, async () => {
    const { r, calls } = await inhBadContract((parent) => ({
      mode: "git_commit_v1", baseCommit: parent.base, allowedPaths: ["src"], ...extra,
    }), id.toLowerCase().replace("-", ""));
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "invalid_delivery");
    assert.equal(calls.length, 0);
  });
}

test("INH-05: continuation parent inherits ITS OWN effective contract, not the lineage root's", async () => {
  const repo = makeRepo();
  const parent = buildCommittedParent(repo, "run_parent_inh5");
  const dir = mkdtempSync(join(tmpdir(), "wao-rc-inh5-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    // The ROOT pinned a different (older) contract; the continuation parent's
    // run.started carries ITS OWN effective one (what it actually ran with).
    await seedRoot({
      runDir: dir, runId: "run_root_inh5", agentId: "coder_hq", cwd: repo,
      delivery: { mode: "git_commit_v1", baseCommit: parent.base, allowedPaths: ["legacy-root-scope"], verificationCommands: ["node root.test.js"] },
    });
    await seedParentWithContract({
      runDir: dir, runId: "run_parent_inh5", agentId: "coder_hq", cwd: repo,
      worktreePath: parent.wt, worktreeBranch: parent.branch, baseCommit: parent.base,
      deliveryCommit: parent.deliveryCommit, rootRunId: "run_root_inh5", turn: "resume",
      delivery: { mode: "git_commit_v1", baseCommit: parent.base, allowedPaths: ["src", "keep.txt"], verificationCommands: ["node --test"] },
    });
    const result = await continueRun({
      parentRunId: "run_parent_inh5", prompt: "fix",
      runDir: dir, ...SERVICE_ARGS({ repo, dir, spawnFn: fakeSpawn }),
    });
    assert.equal(result.accepted, true, `accepted (rejectionReason=${result.rejectionReason})`);
    const djson = JSON.parse(argVal(calls, "--delivery-json"));
    assert.deepEqual(djson.allowedPaths, ["keep.txt", "src"], "the parent's own effective contract wins");
    assert.deepEqual(djson.verificationCommands, ["node --test"], "not the root's older commands");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("INH-06: the 11b cumulative-scope check still runs on the inherited contract — uncovered retained change refuses", async () => {
  const repo = makeRepo();
  const parent = buildCommittedParent(repo, "run_parent_inh6", ["keep.txt", "extra/out.txt"]);
  const dir = mkdtempSync(join(tmpdir(), "wao-rc-inh6-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    await seedParentWithContract({
      runDir: dir, runId: "run_parent_inh6", agentId: "coder_hq", cwd: repo,
      worktreePath: parent.wt, worktreeBranch: parent.branch, baseCommit: parent.base,
      deliveryCommit: parent.deliveryCommit,
      // The persisted contract does NOT cover extra/out.txt.
      delivery: { mode: "git_commit_v1", baseCommit: parent.base, allowedPaths: ["src", "keep.txt"], verificationCommands: ["node --test"] },
    });
    const r = await continueRun({
      parentRunId: "run_parent_inh6", prompt: "fix",
      runDir: dir, ...SERVICE_ARGS({ repo, dir, spawnFn: fakeSpawn }),
    });
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "continuation_scope_incomplete", "inherited contract still goes through the cumulative-scope gate");
    assert.ok(r.uncoveredInheritedPaths.includes("extra/out.txt"), "the uncovered retained path is named");
    assert.equal(calls.length, 0, "zero spawn on refusal");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});
