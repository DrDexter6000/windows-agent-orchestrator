// test/delivery/td146ReclaimedRunEntryPoints.test.js
//
// TD-146 第四轮第 7 条：决定 0082 已知局限的实证钉——"分支删掉、提交被 gc
// 回收之后，依赖交付提交的命令（verify-commit、repackage、纠偏、续接）对
// 这条运行不再可用"。本文件不改这些命令的代码，只构造该状态并逐入口钉住
// 现状：明确拒绝（闭集拒绝码/可读错误）、报错但含义不清，还是从 main 悄悄
// 重建。四入口实测（2026-10，git 2.50.windows）全部明确拒绝，无任何入口
// 悄悄重建（断言随各测试钉住；若未来行为漂移，测试会先红）。
//
// 状态构造：分支以 `update-ref -d`（reclaim 的比较删除形态）删掉，worktree
// 保留（把"提交被回收"的影响与"树被摘"隔离——续接/repackage 依赖树）。提交
// 回收需两步：worktree 的 HEAD reflog 会保住提交，`git gc --prune=now` 单独
// 不够，先 `git reflog expire --expire=now --expire-unreachable=now --all`。
// 真实 reclaim 流程里树一并被摘（reflog 随管理条目消失），gc 一步即回收。
//
// 全部真 git 临时仓 + os.tmpdir() 下的临时 run 目录，从不触碰真实仓库。

import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  execFileSync,
} from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runVerifyCommit } from "../../src/application/runVerifyCommit.js";
import {
  runDeliveryRepackage, RepackageRejectionError,
} from "../../src/application/runDeliveryRepackage.js";
import { correctRun } from "../../src/application/runCorrection.js";
import { continueRun } from "../../src/application/runContinue.js";

const bases = [];
after(async () => {
  for (const b of bases) await cleanupDir(b);
});

async function mkdtemp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  bases.push(dir);
  return dir;
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
  }).trim();
}

async function cleanupDir(dir) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 60 * (attempt + 1)));
    }
  }
}

function makeRepo(base) {
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "t@t.c"], repo);
  git(["config", "user.name", "T"], repo);
  writeFileSync(join(repo, "README.md"), "# base\n", "utf8");
  git(["add", "."], repo);
  git(["commit", "-m", "base"], repo);
  return { repo, baseCommit: git(["rev-parse", "HEAD"], repo) };
}

/** run 的 worktree + wao/<runId> 分支 + 一个交付提交（父 = base）。 */
function makeRunWorktree(repo, runId, baseCommit) {
  const wt = join(repo, ".wao-worktrees", runId);
  git(["worktree", "add", wt, "-b", `wao/${runId}`], repo);
  writeFileSync(join(wt, "del.txt"), "delivery\n", "utf8");
  git(["add", "."], wt);
  git(["commit", "-m", `wao-delivery: ${runId}`], wt);
  const deliveryCommit = git(["rev-parse", "HEAD"], wt);
  assert.equal(git(["rev-parse", `${deliveryCommit}^`], repo), baseCommit, "前置：交付提交父即 base");
  return { wt, deliveryCommit, branch: `wao/${runId}` };
}

/** 决定 0082 已知局限的状态：分支已删（比较删除形态）+ 提交已被 gc 回收。 */
function deleteBranchAndGc(repo, branch, tip) {
  git(["update-ref", "-d", `refs/heads/${branch}`, tip], repo);
  // worktree 的 HEAD reflog 保住提交：先 expire 再 gc（见文件头注释）。
  git(["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"], repo);
  git(["gc", "--prune=now"], repo);
  assert.throws(() => git(["cat-file", "-e", tip], repo), undefined, "前置：交付提交必须已被回收");
}

function seedTranscript(runDir, runId, events) {
  mkdirSync(runDir, { recursive: true });
  const filePath = join(runDir, `${runId}.jsonl`);
  writeFileSync(filePath, events.map((e, i) => JSON.stringify({
    ts: "2026-07-01T00:00:00.000Z", seq: i + 1, runId, agentId: "coder_hq", ...e,
  })).join("\n") + "\n", "utf8");
  return filePath;
}

/** verify-commit 夹具（照 test/delivery/runsVerifyCommit.test.js 的形状）。 */
function vcDeliveryRef(runId, deliveryCommit, baseCommit, wt) {
  return {
    schemaVersion: 1, kind: "git_commit", runId,
    baseCommit: baseCommit, deliveryCommit,
    branch: `wao/${runId}`, worktreePath: wt, changedFiles: ["del.txt"],
    verification: { status: "pending", commands: ["echo ok"] },
    acceptance: { status: "pending", reviewerType: "lead_agent" },
    integration: { status: "pending", targetCommit: null },
  };
}

/** happy 路径 env（Lead 显式豁免 + 机器闸 kill switch；照 runsVerifyCommit.test.js）。 */
function withLeadExemptionEnv(fn) {
  return async () => {
    const savedBypass = process.env.WAO_ALLOW_NESTED_DISPATCH;
    const savedGate = process.env.WAO_VERIFICATION_GATE;
    process.env.WAO_ALLOW_NESTED_DISPATCH = "1";
    process.env.WAO_VERIFICATION_GATE = "off";
    try {
      await fn();
    } finally {
      if (savedBypass === undefined) delete process.env.WAO_ALLOW_NESTED_DISPATCH;
      else process.env.WAO_ALLOW_NESTED_DISPATCH = savedBypass;
      if (savedGate === undefined) delete process.env.WAO_VERIFICATION_GATE;
      else process.env.WAO_VERIFICATION_GATE = savedGate;
    }
  };
}

test("入口① runs verify-commit：交付提交被回收 → 明确拒绝（commit does not resolve），不从 main 重建", withLeadExemptionEnv(async () => {
  const base = await mkdtemp("wao-td146-vc-");
  const { repo, baseCommit } = makeRepo(base);
  const { wt, deliveryCommit } = makeRunWorktree(repo, "run_vc7", baseCommit);
  const runDir = join(base, "runs");
  seedTranscript(runDir, "run_vc7", [
    { type: "run.started", cwd: repo, backend: "fake" },
    { type: "run.delivery_created", delivery: vcDeliveryRef("run_vc7", deliveryCommit, baseCommit, wt) },
    { type: "run.completed" },
    { type: "run.state_change", from: "running", to: "completed", reason: "done" },
  ]);
  deleteBranchAndGc(repo, "wao/run_vc7", deliveryCommit);
  await assert.rejects(
    runVerifyCommit({
      runId: "run_vc7", runDir, authorizedWorkspaceRoot: repo, commit: deliveryCommit,
      commands: ["echo ok"], invocationCwd: repo,
    }),
    /commit does not resolve in the authorized repository/,
    "rev-parse --verify 门应明确拒绝被回收的提交",
  );
  // 不从 main 重建：无 verify-* 临时 worktree、分支未复活、主仓 HEAD 未动。
  const wtRoot = join(repo, ".wao-worktrees");
  assert.deepEqual(
    readdirSync(wtRoot).filter((n) => n.startsWith("verify-")),
    [],
    "拒绝发生在临时 worktree 建立之前",
  );
  assert.ok(!existsSync(join(repo, ".git", "refs", "heads", "wao", "run_vc7")), "分支不得复活");
}));

test("入口② 交付 repackage：分支已删、提交已回收（树保留，HEAD 悬空）→ 闭集拒绝 worktree_unusable", async () => {
  const base = await mkdtemp("wao-td146-rp-");
  const { repo, baseCommit } = makeRepo(base);
  const { wt } = makeRunWorktree(repo, "run_rp7", baseCommit);
  const runDir = join(base, "runs");
  // disallowed_path 保留失败形态（照 test/delivery/runDeliveryRepackage.test.js
  // 的 disallowedPathEvents 夹具）：终态 failed、无决定、资格事实齐全——
  // 保证拒绝来自 git 状态而非资格门。
  seedTranscript(runDir, "run_rp7", [
    { type: "run.background_submitted", cwd: repo, deliveryRequested: true },
    {
      type: "run.started", backend: "test", cwd: repo, worktreePath: wt,
      worktreeBranch: "wao/run_rp7",
      delivery: {
        mode: "git_commit_v1", baseCommit, allowedPaths: ["src"],
        verificationCommands: ["npm test"],
      },
    },
    { type: "run.state_change", from: null, to: "pending", reason: "created" },
    { type: "run.state_change", from: "pending", to: "running", reason: "spawned" },
    { type: "run.delivery_failed", deliveryCode: "disallowed_path", message: "changes outside allowedPaths detected" },
    { type: "run.error", phase: "delivery", deliveryCode: "disallowed_path" },
    { type: "run.state_change", from: "running", to: "failed", reason: "delivery_failed" },
  ]);
  // 本形态没有已打包提交：回收的是分支 tip（= base 的子提交占位无——直接用
  // makeRunWorktree 的交付提交作为"曾经打包失败前树上曾有/后来被删"的提交，
  // 关键状态是分支没了 + HEAD 悬空）。
  const tip = git(["rev-parse", "refs/heads/wao/run_rp7"], repo);
  deleteBranchAndGc(repo, "wao/run_rp7", tip);
  await assert.rejects(
    runDeliveryRepackage({
      runId: "run_rp7", runDir, allowedPaths: ["src"], authorizedWorkspaceRoot: repo,
    }),
    (err) => {
      assert.ok(err instanceof RepackageRejectionError, `应为闭集拒绝，实际 ${err?.constructor?.name}: ${err?.message}`);
      assert.equal(err.code, "worktree_unusable");
      return true;
    },
    "proveWorkspace 读不出悬空 HEAD → worktree_unusable（TD-226 闭集）",
  );
  // 不从 main 重建：分支不复活、树上没有新提交（HEAD 仍解析不出）。
  assert.ok(!existsSync(join(repo, ".git", "refs", "heads", "wao", "run_rp7")), "分支不得复活");
  assert.throws(() => git(["rev-parse", "HEAD"], wt), undefined, "worktree HEAD 不得被重建/推进");
});

test("入口③ 纠偏 correction：不触交付提交——终态 run 闭集拒绝 terminal_run；在跑 run 与 git 状态无关照常排队", async () => {
  const base = await mkdtemp("wao-td146-co-");
  const { repo, baseCommit } = makeRepo(base);
  const runDir = join(base, "runs");

  // 3a：reclaim 的真实形态是终态 run（回收类只收终态）——闭集拒绝 terminal_run。
  const { deliveryCommit } = makeRunWorktree(repo, "run_co7t", baseCommit);
  seedTranscript(runDir, "run_co7t", [
    { type: "run.background_submitted", cwd: repo, deliveryRequested: true, correctable: true },
    { type: "run.started", cwd: repo, backend: "fake" },
    { type: "run.state_change", from: null, to: "running", reason: "spawned" },
    { type: "run.state_change", from: "running", to: "completed", reason: "done" },
  ]);
  deleteBranchAndGc(repo, "wao/run_co7t", deliveryCommit);
  const r1 = await correctRun({
    runId: "run_co7t", correctionId: "corr1", prompt: "fix it",
    runDir, authorizedWorkspaceRoot: repo,
  });
  assert.equal(r1.outcome, "rejected");
  assert.equal(r1.reason, "terminal_run");

  // 3b：在跑的可纠偏 run 在同一 git 状态下照常排队——纠偏只写转录，从不读
  // 交付提交（决定 0082 把它列进"依赖交付提交的命令"实际指的是终态形态）。
  const { deliveryCommit: d2 } = makeRunWorktree(repo, "run_co7r", baseCommit);
  seedTranscript(runDir, "run_co7r", [
    { type: "run.background_submitted", cwd: repo, deliveryRequested: true, correctable: true },
    { type: "run.started", cwd: repo, backend: "fake" },
    { type: "run.state_change", from: null, to: "running", reason: "spawned" },
  ]);
  deleteBranchAndGc(repo, "wao/run_co7r", d2);
  const r2 = await correctRun({
    runId: "run_co7r", correctionId: "corr1", prompt: "fix it",
    runDir, authorizedWorkspaceRoot: repo,
  });
  assert.equal(r2.outcome, "queued");
});

test("入口④ 续接 continue：分支已删、提交已回收 → 闭集拒绝 worktree_drift；树也没了时 missing_worktree，均不从 main 重建", async () => {
  const base = await mkdtemp("wao-td146-ct-");
  const { repo, baseCommit } = makeRepo(base);
  const runId = "run_ct7";
  const { wt, deliveryCommit } = makeRunWorktree(repo, runId, baseCommit);
  const runDir = join(base, "runs");
  const registryPath = join(base, "agents.json");
  writeFileSync(registryPath, JSON.stringify({
    agents: { coder_hq: { backend: "claude-code", cwd: repo } },
  }), "utf8");
  seedTranscript(runDir, runId, [
    { type: "run.background_submitted", background: true, cwd: repo, deliveryRequested: true },
    { type: "run.started", backend: "claude-code", cwd: repo, worktreePath: wt, worktreeBranch: `wao/${runId}`, delivery: { mode: "git_commit_v1", baseCommit, allowedPaths: ["src"], verificationCommands: ["node --test"] } },
    { type: "run.session_reuse", mode: "run_lineage", turn: "first", rootRunId: runId },
    { type: "session.created", backend: "claude-code", backendSessionId: "provider-session-1", serveUrl: null },
    { type: "run.delivery_created", deliveryCommit, delivery: { schemaVersion: 1, kind: "git_commit", runId, baseCommit, deliveryCommit, branch: `wao/${runId}`, worktreePath: wt, allowedPaths: ["src"], changedFiles: ["del.txt"], verification: { commands: ["node --test"] }, acceptance: { status: "pending", reviewerType: "lead_agent" }, integration: { status: "pending", targetCommit: null } } },
    { type: "run.state_change", from: null, to: "running", reason: "spawned" },
    { type: "run.state_change", from: "running", to: "completed", reason: "done" },
  ]);
  deleteBranchAndGc(repo, `wao/${runId}`, deliveryCommit);

  const delivery = { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] };
  const call = () => continueRun({
    parentRunId: runId, prompt: "narrow correction", delivery,
    runDir, registryPath, authorizedWorkspaceRoot: repo, leadSession: "lead-session-1",
    backendFor: () => ({ supportsSessionReuse: true }),
    spawnFn: () => { throw new Error("must not spawn"); },
    skipCredentialCheck: true,
  });
  const r1 = await call();
  assert.equal(r1.accepted, false);
  assert.equal(r1.rejectionReason, "worktree_drift", "proveContinuationWorktree 读不出被回收的交付提交 → 闭集拒绝");
  // 不从 main 重建：分支不复活、HEAD 仍解析不出。
  assert.ok(!existsSync(join(repo, ".git", "refs", "heads", "wao", runId)), "分支不得复活");
  assert.throws(() => git(["rev-parse", "HEAD"], wt), undefined, "worktree HEAD 不得被重建/推进");

  // 完整 reclaim 形态（树也摘了）：missing_worktree。
  rmSync(wt, { recursive: true, force: true });
  const r2 = await call();
  assert.equal(r2.accepted, false);
  assert.equal(r2.rejectionReason, "missing_worktree");
});
