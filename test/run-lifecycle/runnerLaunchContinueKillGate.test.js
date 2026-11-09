// test/run-lifecycle/runnerLaunchContinueKillGate.test.js
//
// TD-347（第 93 批续修 1）：continueRun 对"结束未确认"（runner_kill_unconfirmed）
// 的处置——**不回滚**（不重置工作树、不删子转录、不放续修位），抛出点名子运行
// 的固定文字；对照面：结束已确认的原三个码照旧回滚、线系立即可重试。
// 夹具（git 仓库 + retained worktree + 父转录）取自 m12-7-runContinue.test.js 的
// 形状（本文件只留需要的最小子集）。启动模块经 launchRunnerFn 注入——证明与
// 扫描不在此文件做。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonlTranscript } from "../../src/transcript.js";
import { listTranscriptsDeep } from "../../src/projectBuckets.js";
import { continueRun } from "../../src/application/runContinue.js";

function git(args, cwd) {
  return String(execSync("git " + args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })).trim();
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "wao-ku-repo-"));
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

function buildCommittedParent(repo, runId) {
  const wt = join(repo, ".wao-worktrees", runId);
  git(`worktree add -b wao/${runId} "${wt}"`, repo);
  const base = git("rev-parse HEAD", repo);
  writeFileSync(join(wt, "keep.txt"), "keep-changed\n", "utf8");
  git("add -A", wt);
  git('-c user.name="WAO Delivery" -c user.email="wao-delivery@local" commit -m "wao-delivery: ' + runId + '"', wt);
  const deliveryCommit = git("rev-parse HEAD", wt);
  return { wt, base, deliveryCommit, branch: `wao/${runId}` };
}

async function seedParent({ runDir, runId, agentId, cwd, worktreePath, worktreeBranch, baseCommit, deliveryCommit }) {
  const t = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId });
  await t.append("run.background_submitted", { background: true, cwd, deliveryRequested: true });
  await t.transitionState(null, "pending", "background_spawned");
  await t.append("run.started", {
    backend: "claude-code",
    cwd,
    worktreePath,
    worktreeBranch,
    delivery: {
      mode: "git_commit_v1",
      baseCommit,
      allowedPaths: ["keep.txt"],
      verificationCommands: ["node --test"],
    },
  });
  await t.append("run.session_reuse", { mode: "run_lineage", turn: "first", rootRunId: runId });
  await t.append("session.created", { backend: "claude-code", backendSessionId: "provider-session-1", serveUrl: null });
  await t.append("run.delivery_created", {
    deliveryCommit,
    delivery: {
      schemaVersion: 1, kind: "git_commit", runId,
      baseCommit, deliveryCommit, branch: worktreeBranch, worktreePath, allowedPaths: ["keep.txt"],
      changedFiles: ["keep.txt"], verification: { commands: ["node --test"] },
      acceptance: { status: "pending", reviewerType: "lead_agent" },
      integration: { status: "pending", targetCommit: null },
    },
  });
  await t.transitionState("pending", "completed", "done");
}

const DELIVERY = { mode: "git_commit_v1", allowedPaths: ["keep.txt"], verificationCommands: ["node --test"] };

const KILL_UNCONFIRMED = {
  outcome: "start_failed",
  runnerPid: 42,
  reason: "runner_kill_unconfirmed",
  detail: "bridge_reply_missing",
  killConfirmed: false,
  killScanOk: false,
};

function findTranscript(runDir, runId) {
  return listTranscriptsDeep(runDir).some((entry) => entry.name === `${runId}.jsonl`);
}

test("续修：结束未确认 → 不回滚（工作树停子分支基线、子转录留、续修位不放），抛出点名子运行", async () => {
  const repo = makeRepo();
  const parent = buildCommittedParent(repo, "run_parent_ku");
  const dir = mkdtempSync(join(tmpdir(), "wao-ku-cont-"));
  try {
    await seedParent({
      runDir: dir, runId: "run_parent_ku", agentId: "coder_hq", cwd: repo,
      worktreePath: parent.wt, worktreeBranch: parent.branch,
      baseCommit: parent.base, deliveryCommit: parent.deliveryCommit,
    });
    const err = await continueRun({
      parentRunId: "run_parent_ku", prompt: "narrow correction",
      delivery: DELIVERY,
      runDir: dir, registryPath: makeRegistry(dir, { coder_hq: { backend: "claude-code", cwd: repo } }),
      authorizedWorkspaceRoot: repo,
      backendFor: () => ({ supportsSessionReuse: true }),
      launchRunnerFn: async () => ({ ...KILL_UNCONFIRMED }),
    }).then(() => null, (e) => e);
    assert.ok(err instanceof Error, "必须抛错");
    assert.match(err.message, /运行保持 pending，用 wao runs settle 判定/);
    const m = /child run (run_[0-9A-Za-z]+)/.exec(err.message);
    assert.ok(m, `抛出文字点名子运行 runId：${err.message}`);
    assert.equal(err.reasonCode, "runner_kill_unconfirmed");
    const childRunId = m[1];

    // 不回滚：工作树停在子分支的 base（prepareContinuationWorktree 的成果保留）。
    assert.equal(git("symbolic-ref --short HEAD", parent.wt), `wao/${childRunId}`, "不重置工作树分支");
    assert.equal(git("rev-parse HEAD", parent.wt), parent.base, "不重置工作树 HEAD");
    // 不回滚：子转录还在（pending，交 settle 判定）。
    assert.ok(findTranscript(dir, childRunId), "不删子转录");
    // 不回滚：续修位不放——立即重试是 busy，不是可续。
    const retry = await continueRun({
      parentRunId: "run_parent_ku", prompt: "retry correction",
      delivery: DELIVERY,
      runDir: dir, registryPath: join(dir, "agents.json"),
      authorizedWorkspaceRoot: repo,
      backendFor: () => ({ supportsSessionReuse: true }),
      launchRunnerFn: async () => ({ outcome: "started", runnerPid: 7 }),
    });
    assert.equal(retry.accepted, false, "线系仍被占");
    assert.equal(retry.rejectionReason, "busy", "续修位没有放出");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("续修：结束已确认（bridge_reply_missing）→ 照旧回滚，线系立即可重试（对照面）", async () => {
  const repo = makeRepo();
  const parent = buildCommittedParent(repo, "run_parent_kc");
  const dir = mkdtempSync(join(tmpdir(), "wao-kc-cont-"));
  try {
    await seedParent({
      runDir: dir, runId: "run_parent_kc", agentId: "coder_hq", cwd: repo,
      worktreePath: parent.wt, worktreeBranch: parent.branch,
      baseCommit: parent.base, deliveryCommit: parent.deliveryCommit,
    });
    const err = await continueRun({
      parentRunId: "run_parent_kc", prompt: "narrow correction",
      delivery: DELIVERY,
      runDir: dir, registryPath: makeRegistry(dir, { coder_hq: { backend: "claude-code", cwd: repo } }),
      authorizedWorkspaceRoot: repo,
      backendFor: () => ({ supportsSessionReuse: true }),
      launchRunnerFn: async () => ({
        outcome: "start_failed", runnerPid: null, reason: "bridge_reply_missing", killConfirmed: true, killScanOk: true,
      }),
    }).then(() => null, (e) => e);
    assert.ok(err instanceof Error);
    assert.match(err.message, /已被结束并确认/);
    assert.equal(err.reasonCode, undefined, "确认路径不带 kill-unconfirmed 标记");

    // 照旧回滚：父树回原分支、HEAD=交付提交；子转录删除。
    assert.equal(git("symbolic-ref --short HEAD", parent.wt), parent.branch, "回滚：父树回到原分支");
    assert.equal(git("rev-parse HEAD", parent.wt), parent.deliveryCommit, "回滚：HEAD 回交付提交");
    const childTranscripts = readdirSync(dir).filter((name) => name.startsWith("run_") && name.endsWith(".jsonl") && name !== "run_parent_kc.jsonl");
    assert.deepEqual(childTranscripts, [], "回滚删掉了子转录（平铺层）");
    assert.equal(listTranscriptsDeep(dir).filter((e) => e.name !== "run_parent_kc.jsonl").length, 0, "桶层也没有子转录");

    // 确认路径放出了续修位：重试立即成功。
    const retry = await continueRun({
      parentRunId: "run_parent_kc", prompt: "retry correction",
      delivery: DELIVERY,
      runDir: dir, registryPath: join(dir, "agents.json"),
      authorizedWorkspaceRoot: repo,
      backendFor: () => ({ supportsSessionReuse: true }),
      launchRunnerFn: async () => ({ outcome: "started", runnerPid: 8 }),
    });
    assert.equal(retry.accepted, true, "线系可立即重试");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
