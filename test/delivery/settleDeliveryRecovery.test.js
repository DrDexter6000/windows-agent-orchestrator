// test/delivery/settleDeliveryRecovery.test.js
//
// 任务第 4 步：runs settle 与交付恢复路径的衔接。
//   - 带交付合同事实的运行经 runs settle 结算后，run_delivery_repackage 仍把它
//     当 process_missing 恢复候选处理（先 settle、再显式 repackage 的链路钉住）；
//   - 没有交付合同事实的运行（派发了交付、runner 在 run.started 前死亡）结算后
//     不是恢复候选：repackage 闭集拒绝，查询面不出现候选键（形状不漂移）；
//   - 查询面（run_delivery 点查）对已结算、仍满足恢复前提的终态运行也投影
//     process_missing（此前只有非终态孤儿投影）。
//
// 真实 git 仓 + linked worktree（proveWorkspace/exact-base 需要真 Git）；
// 结算的进程探测与 repackage 的 liveness 证明全部注入。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { classifyRecoveryCandidate, readTranscript } from "../../src/transcript.js";
import { settleRun } from "../../src/application/runSettle.js";
import { runDeliveryRepackage, RepackageRejectionError } from "../../src/application/runDeliveryRepackage.js";
import { getRunDelivery } from "../../src/application/runDelivery.js";
import { resolveDeliveryCommit } from "../../src/delivery.js";
import { computeCandidateInventory } from "../../src/application/candidateInventory.js";

const RUN_ID = "run_settle_recov";
const AGENT_ID = "coder_hq";

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
  }).trim();
}

async function cleanupDir(dir) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { await rm(dir, { recursive: true, force: true }); return; } catch {
      if (attempt === 5) return;
      await new Promise((r) => setTimeout(r, 60 * (attempt + 1)));
    }
  }
}

async function makeRepo(prefix) {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "test@test"], repo);
  git(["config", "user.name", "test"], repo);
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "a.js"), "const a = 1;\n");
  git(["add", "."], repo);
  git(["commit", "-m", "init"], repo);
  return { repo, baseCommit: git(["rev-parse", "HEAD"], repo) };
}

function makeLinkedWorktree(repo, runId) {
  const worktreePath = join(repo, ".wao-worktrees", runId);
  git(["worktree", "add", worktreePath, "-b", `wao/${runId}`], repo);
  return worktreePath;
}

function seedTranscript(runDir, runId, events) {
  const filePath = join(runDir, `${runId}.jsonl`);
  const lines = events.map((e, i) => JSON.stringify({
    ts: "2026-09-01T00:00:00.000Z", seq: i + 1, runId, agentId: AGENT_ID, ...e,
  }));
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

/** 结算通道的全注入 deps（六门全过）。handshakeReader 是三态读器契约。 */
const settlePassDeps = {
  ownerLeaseReader: () => ({ present: false }),
  identifyFn: async () => ({ verdict: "gone", basis: "pid_exited" }),
  runnerScanFn: async () => ({ alive: false }),
  handshakeReader: () => ({ present: false }),
  daemonAliveFn: () => false,
};

const deadProbe = () => false;
const missingLease = () => ({ present: false });
const passedVerifier = async (deliveryRef) => ({
  delivery: {
    ...deliveryRef,
    verification: { ...deliveryRef.verification, status: "passed", verifiedCommit: deliveryRef.deliveryCommit, results: [] },
  },
  outcome: "passed",
});

test("RECOV-1: 带合同的运行先经 runs settle 结算、再显式 repackage——全链可用", async () => {
  const { repo, baseCommit } = await makeRepo("settle-recov1-");
  const runDir = await mkdtemp(join(tmpdir(), "settle-recov1-runs-"));
  try {
    const worktreePath = makeLinkedWorktree(repo, RUN_ID);
    await writeFile(join(worktreePath, "src", "a.js"), "const a = 2;\n"); // 真实非空 inventory
    const filePath = seedTranscript(runDir, RUN_ID, [
      { type: "run.background_submitted", cwd: repo, deliveryRequested: true },
      {
        type: "run.started", backend: "claude-code", cwd: repo,
        worktreePath, worktreeBranch: `wao/${RUN_ID}`,
        delivery: { mode: "git_commit_v1", baseCommit, allowedPaths: ["src"], verificationCommands: ["npm test"] },
      },
      { type: "session.created", backend: "process", backendSessionId: "proc_999999" },
      { type: "run.state_change", from: null, to: "pending", reason: "background_spawned" },
      { type: "run.state_change", from: "pending", to: "running", reason: "first_event" },
    ]);

    // 第一步：runs settle 结算（写 failed/process_missing + 确认事实）。
    const settled = await settleRun({
      runId: RUN_ID, runDir,
      reasonText: "机器重启后 runner 与会话进程都不在了，转录无终态记录。",
      apply: true,
      deps: settlePassDeps,
    });
    assert.equal(settled.settled, true, "结算成功");
    assert.equal(settled.sessionShape, "process_session");

    // 结算后的 durable 记录 classifyRecoveryCandidate 仍认 process_missing。
    const events = await readTranscript(filePath);
    assert.equal(classifyRecoveryCandidate(events, RUN_ID), "process_missing",
      "与载荷字段无关：终态 failed/process_missing + 恰好一条确认事实即认");

    // 第二步：显式 repackage 恢复（真实打包 + 注入 verifier）。
    const result = await runDeliveryRepackage({
      runId: RUN_ID, runDir: runDir, allowedPaths: ["src"],
      authorizedWorkspaceRoot: repo,
      resolveDeliveryCommitFn: resolveDeliveryCommit,
      verifyDeliveryFn: passedVerifier,
      computeInventoryFn: computeCandidateInventory,
      nowFn: () => 100000, isAliveFn: deadProbe, ownerLeaseReader: missingLease,
    });
    assert.match(result.deliveryCommit, /^[0-9a-f]{40}$/);
    assert.equal(result.recoveryKind, "process_missing");
    assert.equal(result.verificationStatus, "passed");
    assert.equal(result.source, "packaged");
  } finally { await cleanupDir(repo); await cleanupDir(runDir); }
});

test("RECOV-2: 无合同运行（runner 在 run.started 前死亡）结算后不是恢复候选", async () => {
  const { repo } = await makeRepo("settle-recov2-");
  const runDir = await mkdtemp(join(tmpdir(), "settle-recov2-runs-"));
  try {
    const filePath = seedTranscript(runDir, RUN_ID, [
      { type: "run.background_submitted", cwd: repo, deliveryRequested: true },
      { type: "run.state_change", from: null, to: "pending", reason: "background_spawned" },
    ]);
    const settled = await settleRun({
      runId: RUN_ID, runDir,
      reasonText: "runner 在建会话与 run.started 之前就死了。",
      apply: true,
      deps: settlePassDeps,
    });
    assert.equal(settled.settled, true);
    assert.equal(settled.sessionShape, "no_session");

    // repackage 闭集拒绝：没有可用的 run.started 交付合同。
    await assert.rejects(
      () => runDeliveryRepackage({
        runId: RUN_ID, runDir, allowedPaths: ["src"],
        authorizedWorkspaceRoot: repo,
        computeInventoryFn: computeCandidateInventory,
        nowFn: () => 100000, isAliveFn: deadProbe, ownerLeaseReader: missingLease,
      }),
      (err) => err instanceof RepackageRejectionError && err.code === "candidate_contract_malformed",
    );
  } finally { await cleanupDir(repo); await cleanupDir(runDir); }
});

test("RECOV-3: 查询面——已结算带合同的终态运行投影 process_missing；无合同运行无候选键", async () => {
  const { repo, baseCommit } = await makeRepo("settle-recov3-");
  const runDir = await mkdtemp(join(tmpdir(), "settle-recov3-runs-"));
  try {
    const worktreePath = makeLinkedWorktree(repo, RUN_ID);
    await writeFile(join(worktreePath, "src", "a.js"), "const a = 2;\n");
    seedTranscript(runDir, RUN_ID, [
      { type: "run.background_submitted", cwd: repo, deliveryRequested: true },
      {
        type: "run.started", backend: "claude-code", cwd: repo,
        worktreePath, worktreeBranch: `wao/${RUN_ID}`,
        delivery: { mode: "git_commit_v1", baseCommit, allowedPaths: ["src"], verificationCommands: ["npm test"] },
      },
      { type: "session.created", backend: "process", backendSessionId: "proc_999999" },
      { type: "run.state_change", from: null, to: "pending", reason: "background_spawned" },
      { type: "run.state_change", from: "pending", to: "running", reason: "first_event" },
    ]);
    const settled = await settleRun({
      runId: RUN_ID, runDir,
      reasonText: "runner 已死，Lead 结算。",
      apply: true,
      deps: settlePassDeps,
    });
    assert.equal(settled.settled, true);

    // 终态已结算：查询面仍给 process_missing 候选（inventory 真实计算）。
    const view = await getRunDelivery({
      runId: RUN_ID, runDir,
      authorizedWorkspaceRoot: repo,
      computeInventoryFn: computeCandidateInventory,
      nowFn: () => 100000, isAliveFn: deadProbe, ownerLeaseReader: missingLease,
    });
    assert.equal(view.terminalState, "failed");
    assert.equal(view.candidateKind, "process_missing", "已结算终态运行仍投影 process_missing");
    assert.ok(view.candidateInventory, "候选 inventory 在场");
    assert.equal(view.candidateKind === "process_missing", true,
      "candidateKind 是既有闭集值（线上形状不变）");

    // 无合同运行：不出现候选键（legacy absent-key 形状不漂移）。
    const noContractId = "run_settle_nocontract";
    seedTranscript(runDir, noContractId, [
      { type: "run.background_submitted", cwd: repo, deliveryRequested: true },
      { type: "run.state_change", from: null, to: "pending", reason: "background_spawned" },
    ]);
    const noContractSettled = await settleRun({
      runId: noContractId, runDir,
      reasonText: "runner 在 run.started 前死亡，无交付合同。",
      apply: true,
      deps: settlePassDeps,
    });
    assert.equal(noContractSettled.settled, true);
    const plain = await getRunDelivery({
      runId: noContractId, runDir,
      authorizedWorkspaceRoot: repo,
      computeInventoryFn: computeCandidateInventory,
    });
    assert.equal(plain.terminalState, "failed");
    assert.ok(!("candidateKind" in plain), "非交付运行不出现候选键（形状不漂移）");
    assert.ok(!("candidateInventory" in plain));
  } finally { await cleanupDir(repo); await cleanupDir(runDir); }
});
