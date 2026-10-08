// test/delivery/runsVerifyCommit.test.js
//
// TD-240（2026-10-09，consult_20261008164029600fyqngp astra+opus 双席裁定①-⑥）：
// `runs verify-commit` ——采纳协议承载命令的服务 + CLI 适配层测试。
//
// 反例清单逐条（任务书）：
//   跨 run 同仓提交 / 错仓或不存在的 run / 非 delivery run 拒绝 / 多次核验多
//   checkId / 逐命令内容变异（检出后被外部改动→命令 exit 0 也不得记 passed）
//   / 超时子进程收束 / Ctrl-C 模拟 / 审计写失败 / 清理失败 / worker 上下文调用
//   拒绝 / started-only 投影 incomplete / 事件不入判定输入。
//
// 真实面：本文件建真实 scratch git 仓（init+commits）+ 真实 JsonlTranscript 转录
// + 真实 runVerificationCommand 执行（shell 边界）+ 真实 worktree add/remove。
// scratch 依任务书纪律建在本 worktree 的 .wao/runs/ 下；因该路径含 .wao-worktrees
// 组件（本仓交付 worktree 自身所在），happy 路径置 WAO_ALLOW_NESTED_DISPATCH=1
// ——这正是 0047 文档化的"Lead 显式豁免（worktree 内合法测试场景）"；反例测试
// 分别证无豁免时 env-marker / worktree-cwd 双通道拒绝。WAO_VERIFICATION_GATE=off
// 关掉机器租约（单测不入 T3/verifier 串行闸——kill switch 文档化机制）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync,
  readFileSync, readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";

import { JsonlTranscript, readTranscript, validateDeliveryFacts } from "../../src/transcript.js";
import {
  runVerifyCommit,
  projectLeadCommitChecks,
  LEAD_COMMIT_CHECK_STARTED_TYPE,
  LEAD_COMMIT_CHECK_OUTCOME_TYPE,
} from "../../src/application/runVerifyCommit.js";
import { runVerificationCommand } from "../../src/deliveryVerification.js";
import { decideRunDelivery } from "../../src/application/runDelivery.js";
import { recordAcceptance } from "../../src/application/acceptanceRecord.js";
import { nestedDispatchContext } from "../../src/nestedDispatchGuard.js";
import { projectRunActivity } from "../../src/application/runActivityProjection.js";
import { runsCommand, RUNS_SUBCOMMANDS } from "../../src/commands/runs.js";

// ===== scratch 纪律：本 worktree 的 .wao/runs/ 下 =====
const SCRATCH_ROOT = join(resolve(process.cwd()), ".wao", "runs", "verify-commit-tests");
mkdirSync(SCRATCH_ROOT, { recursive: true });

function makeScratch(prefix) {
  return mkdtempSync(join(SCRATCH_ROOT, prefix));
}

function cleanupDir(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      if (attempt === 4) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60 * (attempt + 1));
    }
  }
}

/** happy 路径 env：Lead 显式豁免（0047 文档化）+ 机器闸 kill switch（单测不排队）。 */
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

/** 反例 env：显式清除豁免/闸变量（保存-设置-还原）。 */
function withStrippedEnv(overrides, fn) {
  return async () => {
    const saved = {};
    const keys = ["WAO_ALLOW_NESTED_DISPATCH", "WAO_VERIFICATION_GATE", "WAO_IN_WORKER", "WAO_VERIFICATION_GATE_HELD"];
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    Object.assign(process.env, overrides);
    try {
      await fn();
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };
}

// ===== 真实 scratch 仓 =====

/** 结构化参数 git（不拼 shell 串——cmd.exe 对 ^/引号有转义陷阱）。 */
function gitOf(repoPath, args) {
  return execFileSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

/**
 * 建真实仓：base ← commitA（交付形）← commitChild（含 commitA 的后代），
 * commitAdopted（message 含 WAO-Adopted-From trailer），并提交辅助脚本
 * stallShort.js / fail.js / mutate.js（避免命令行内嵌引号地狱）。
 */
function makeRepo(dir) {
  mkdirSync(dir, { recursive: true });
  gitOf(dir, ["init"]);
  gitOf(dir, ["config", "user.email", "t@t.c"]);
  gitOf(dir, ["config", "user.name", "T"]);
  writeFileSync(join(dir, "README.md"), "# base\n", "utf8");
  writeFileSync(join(dir, "stallShort.js"),
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);\n", "utf8");
  writeFileSync(join(dir, "fail.js"),
    "console.error('boom-tail-marker'); process.exit(3);\n", "utf8");
  writeFileSync(join(dir, "mutate.js"),
    "import { writeFileSync } from \"node:fs\";\nwriteFileSync(\"README.md\", \"# mutated\\n\");\n", "utf8");
  gitOf(dir, ["add", "."]);
  gitOf(dir, ["commit", "-m", "base"]);
  const base = gitOf(dir, ["rev-parse", "HEAD"]);
  writeFileSync(join(dir, "README.md"), "# base\nchange-a\n", "utf8");
  gitOf(dir, ["add", "."]);
  gitOf(dir, ["commit", "-m", "delivery-a"]);
  const commitA = gitOf(dir, ["rev-parse", "HEAD"]);
  writeFileSync(join(dir, "README.md"), "# base\nchange-a\nchange-b\n", "utf8");
  gitOf(dir, ["add", "."]);
  gitOf(dir, ["commit", "-m", "child"]);
  const commitChild = gitOf(dir, ["rev-parse", "HEAD"]);
  writeFileSync(join(dir, "adopt.txt"), "adopted\n", "utf8");
  gitOf(dir, ["add", "."]);
  gitOf(dir, ["commit", "-m", "adopted", "-m", "WAO-Adopted-From: run_vc_target"]);
  const commitAdopted = gitOf(dir, ["rev-parse", "HEAD"]);
  return { path: dir, base, commitA, commitChild, commitAdopted };
}

function makeRef(runId, deliveryCommit, base) {
  return {
    schemaVersion: 1,
    kind: "git_commit",
    runId,
    baseCommit: base,
    deliveryCommit,
    branch: `wao/${runId}`,
    worktreePath: "/fake/wt",
    changedFiles: ["README.md"],
    verification: { status: "pending", commands: ["echo ok"] },
    acceptance: { status: "pending", reviewerType: "lead_agent" },
    integration: { status: "pending", targetCommit: null },
  };
}

/**
 * 写一个 run 转录（真实 JsonlTranscript）：run.started（含 cwd=工作区归属事实）
 * → run.delivery_created → run.completed →（非 legacy 时）终态 run.state_change。
 */
async function writeRunTranscript(runDir, runId, repoPath, deliveryCommit, opts = {}) {
  mkdirSync(runDir, { recursive: true });
  const t = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId: "glm-pro" });
  await t.append("run.started", { cwd: opts.startedCwd ?? repoPath, backend: "fake" });
  await t.append("run.delivery_created", {
    delivery: makeRef(runId, deliveryCommit, opts.baseCommit ?? gitOf(repoPath, ["rev-parse", "HEAD"])),
  });
  await t.append("run.completed", {});
  if (opts.legacy !== true) {
    await t.append("run.state_change", { from: "running", to: "completed", reason: "done" });
  }
  return t;
}

function baseInput({ runDir, runId, repo, commit, commands }, extra = {}) {
  return {
    runId,
    runDir,
    authorizedWorkspaceRoot: repo.path,
    commit,
    commands,
    invocationCwd: repo.path,
    ...extra,
  };
}

async function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.map(String).join(" ")); };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

function findEvent(events, type) {
  return events.filter((e) => e && e.type === type);
}

// ===== ①②③④⑤ 主路径：真实仓 + 真实命令 + 事件族形状 =====

test("TD-240 主路径：真实仓核验通过——事件族形状/关系事实/终态依据/worktree 清理", withLeadExemptionEnv(async () => {
  const scratch = makeScratch("vc-happy-");
  try {
    const repo = makeRepo(join(scratch, "repo"));
    const runDir = join(scratch, "runs");
    await writeRunTranscript(runDir, "run_vc_target", repo.path, repo.commitA);
    const commands = ["echo one", "echo hello  world"];
    const sha = createHash("sha256").update(JSON.stringify(commands)).digest("hex");

    const result = await runVerifyCommit(baseInput({
      runDir, runId: "run_vc_target", repo, commit: repo.commitA, commands,
    }, { commandsFileSha256: sha }));

    assert.equal(result.status, "passed");
    assert.equal(result.cleanup, "ok");
    assert.equal(result.exitCode, 0);
    assert.match(result.checkId, /^[0-9a-f]+$/);
    assert.equal(result.results.length, 2);
    assert.deepEqual(result.results.map((r) => r.index), [0, 1]);
    // 安全结果行不带尾内容/命令文本（闭集）
    assert.deepEqual(Object.keys(result.results[0]).sort(), ["durationMs", "exitCode", "index", "timedOut"]);

    const events = await readTranscript(join(runDir, "run_vc_target.jsonl"));
    const started = findEvent(events, LEAD_COMMIT_CHECK_STARTED_TYPE);
    const outcome = findEvent(events, LEAD_COMMIT_CHECK_OUTCOME_TYPE);
    assert.equal(started.length, 1);
    assert.equal(outcome.length, 1);
    // 裁定⑥边界锁
    assert.equal(started[0].kind, "lead_self_check");
    assert.equal(started[0].independentAuditRequired, true);
    assert.equal(outcome[0].kind, "lead_self_check");
    assert.equal(outcome[0].independentAuditRequired, true);
    // 裁定①信封 agentId 沿用该 run 真实 agentId
    assert.equal(started[0].agentId, "glm-pro");
    assert.equal(started[0].runId, "run_vc_target");
    // 裁定③命令原文 + 文件 sha256
    assert.deepEqual(started[0].commands, commands);
    assert.equal(started[0].commandsFileSha256, sha);
    assert.equal(started[0].commit, repo.commitA);
    assert.equal(started[0].timeoutMs, 300000);
    // 裁定①终态判定依据记录
    assert.deepEqual(started[0].terminality, { state: "completed", basis: "state_change" });
    // 裁定①提交关系事实字段（本例 = 该 run 的 deliveryCommit；git --is-ancestor
    // 语义含自等——commit 对自身 containsDeliveryCommit=true）
    assert.deepEqual(started[0].commitRelations, {
      isDeliveryCommit: true,
      containsDeliveryCommit: true,
      adoptedFromTrailer: false,
    });
    // 裁定② outcome 形状 + checkId 配对 + 绿色零尾
    assert.equal(outcome[0].checkId, started[0].checkId);
    assert.equal(outcome[0].status, "passed");
    assert.equal(outcome[0].cleanup, "ok");
    assert.equal(outcome[0].results.length, 2);
    assert.equal(outcome[0].results[0].stdoutTail, "");
    assert.equal(outcome[0].results[0].stderrTail, "");
    // 裁定④：临时 worktree 用后清理（verify-* 无残留）
    const wtRoot = join(repo.path, ".wao-worktrees");
    assert.ok(!existsSync(wtRoot) || !existsSync(join(wtRoot, `verify-${result.checkId}`)),
      "verify worktree must be removed");
  } finally {
    cleanupDir(scratch);
  }
}));

test("TD-240 裁定①：跨 run 同仓提交可核验——事件落 CLI 指定 runId，关系记事实不设拒", withLeadExemptionEnv(async () => {
  const scratch = makeScratch("vc-crossrun-");
  try {
    const repo = makeRepo(join(scratch, "repo"));
    const runDir = join(scratch, "runs");
    await writeRunTranscript(runDir, "run_vc_target", repo.path, repo.commitA);
    await writeRunTranscript(runDir, "run_vc_other", repo.path, repo.commitChild);
    // 用 run_vc_other 的交付提交（commitChild）核验 run_vc_target——同仓跨 run
    const result = await runVerifyCommit(baseInput({
      runDir, runId: "run_vc_target", repo, commit: repo.commitChild, commands: ["echo ok"],
    }));
    assert.equal(result.status, "passed");
    const events = await readTranscript(join(runDir, "run_vc_target.jsonl"));
    const started = findEvent(events, LEAD_COMMIT_CHECK_STARTED_TYPE);
    assert.equal(started.length, 1);
    assert.equal(started[0].runId, "run_vc_target");
    assert.deepEqual(started[0].commitRelations, {
      isDeliveryCommit: false,          // commitChild ≠ run_vc_target 的 deliveryCommit
      containsDeliveryCommit: true,     // commitChild 是 commitA 的后代
      adoptedFromTrailer: false,
    });
    // 另一形状：adopt trailer 命中（对齐采纳协议第 2 步 trailer）
    const result2 = await runVerifyCommit(baseInput({
      runDir, runId: "run_vc_target", repo, commit: repo.commitAdopted, commands: ["echo ok"],
    }));
    assert.equal(result2.status, "passed");
    const events2 = await readTranscript(join(runDir, "run_vc_target.jsonl"));
    const started2 = findEvent(events2, LEAD_COMMIT_CHECK_STARTED_TYPE);
    assert.equal(started2[1].commitRelations.adoptedFromTrailer, true);
    assert.equal(started2[1].commitRelations.isDeliveryCommit, false);
  } finally {
    cleanupDir(scratch);
  }
}));

// ===== 反例：错仓 / 不存在 / 非 delivery / 非终态 =====

test("TD-240 反例：错仓（workspace 归属不符）拒绝", withLeadExemptionEnv(async () => {
  const scratch = makeScratch("vc-wrongws-");
  try {
    const repo = makeRepo(join(scratch, "repo"));
    const otherRepo = makeRepo(join(scratch, "other"));
    const runDir = join(scratch, "runs");
    await writeRunTranscript(runDir, "run_vc_target", repo.path, repo.commitA, { startedCwd: otherRepo.path });
    await assert.rejects(
      runVerifyCommit(baseInput({ runDir, runId: "run_vc_target", repo, commit: repo.commitA, commands: ["echo ok"] })),
      /workspace mismatch/,
    );
    // 拒绝发生在任何事件写入之前
    const events = await readTranscript(join(runDir, "run_vc_target.jsonl"));
    assert.equal(findEvent(events, LEAD_COMMIT_CHECK_STARTED_TYPE).length, 0);
  } finally {
    cleanupDir(scratch);
  }
}));

test("TD-240 反例：不存在的 run 拒绝（转录缺失）", withLeadExemptionEnv(async () => {
  const scratch = makeScratch("vc-norun-");
  try {
    const repo = makeRepo(join(scratch, "repo"));
    const runDir = join(scratch, "runs");
    mkdirSync(runDir, { recursive: true });
    await assert.rejects(
      runVerifyCommit(baseInput({ runDir, runId: "run_vc_missing", repo, commit: repo.commitA, commands: ["echo ok"] })),
      /run not found/,
    );
  } finally {
    cleanupDir(scratch);
  }
}));

test("TD-240 反例：非 delivery run 拒绝（无 run.delivery_created）", withLeadExemptionEnv(async () => {
  const scratch = makeScratch("vc-nodelivery-");
  try {
    const repo = makeRepo(join(scratch, "repo"));
    const runDir = join(scratch, "runs");
    const t = new JsonlTranscript(join(runDir, "run_vc_plain.jsonl"), { runId: "run_vc_plain", agentId: "x" });
    await t.append("run.started", { cwd: repo.path, backend: "fake" });
    await t.append("run.completed", {});
    await t.append("run.state_change", { from: "running", to: "completed", reason: "done" });
    await assert.rejects(
      runVerifyCommit(baseInput({ runDir, runId: "run_vc_plain", repo, commit: repo.commitA, commands: ["echo ok"] })),
      /has no run\.delivery_created/,
    );
  } finally {
    cleanupDir(scratch);
  }
}));

test("TD-240 反例：非终态 run 拒绝（含 legacy 终态依据记录的正路径对照）", withLeadExemptionEnv(async () => {
  const scratch = makeScratch("vc-terminal-");
  try {
    const repo = makeRepo(join(scratch, "repo"));
    const runDir = join(scratch, "runs");
    // 非终态：无 state_change、末事件非终态事实
    const t = new JsonlTranscript(join(runDir, "run_vc_live.jsonl"), { runId: "run_vc_live", agentId: "x" });
    await t.append("run.started", { cwd: repo.path, backend: "fake" });
    await t.append("run.metrics", { tokens: {} });
    await assert.rejects(
      runVerifyCommit(baseInput({ runDir, runId: "run_vc_live", repo, commit: repo.commitA, commands: ["echo ok"] })),
      /is not terminal/,
    );
    // legacy 终态（无 state_change、末事件 run.completed 推断）——可核验但依据记录为 legacy_inferred
    await writeRunTranscript(runDir, "run_vc_legacy", repo.path, repo.commitA, { legacy: true });
    const result = await runVerifyCommit(baseInput({
      runDir, runId: "run_vc_legacy", repo, commit: repo.commitA, commands: ["echo ok"],
    }));
    assert.equal(result.status, "passed");
    const events = await readTranscript(join(runDir, "run_vc_legacy.jsonl"));
    const started = findEvent(events, LEAD_COMMIT_CHECK_STARTED_TYPE);
    assert.deepEqual(started[0].terminality, { state: "completed", basis: "legacy_inferred" });
  } finally {
    cleanupDir(scratch);
  }
}));

// ===== 反例：SHA 形状 =====

test("TD-240 裁定③：短形/大写/非 hex SHA 拒绝（全形 40/64 唯一接受）", withLeadExemptionEnv(async () => {
  const scratch = makeScratch("vc-sha-");
  try {
    const repo = makeRepo(join(scratch, "repo"));
    const runDir = join(scratch, "runs");
    await writeRunTranscript(runDir, "run_vc_target", repo.path, repo.commitA);
    for (const bad of [repo.commitA.slice(0, 12), repo.commitA.toUpperCase(), "zz"]) {
      await assert.rejects(
        runVerifyCommit(baseInput({ runDir, runId: "run_vc_target", repo, commit: bad, commands: ["echo ok"] })),
        /canonical full-form 40\/64-hex/,
      );
    }
    // 不存在的提交（全形但仓内无对象）
    await assert.rejects(
      runVerifyCommit(baseInput({
        runDir, runId: "run_vc_target", repo, commit: "f".repeat(40), commands: ["echo ok"],
      })),
      /rev-parse --verify failed/,
    );
  } finally {
    cleanupDir(scratch);
  }
}));

// ===== 反例：命令清单边界 + 绝对路径字面量 =====

test("TD-240 裁定③：空清单/超长/超条数/绝对路径字面量命令拒绝（reverify 同界）", withLeadExemptionEnv(async () => {
  const scratch = makeScratch("vc-cmdbounds-");
  try {
    const repo = makeRepo(join(scratch, "repo"));
    const runDir = join(scratch, "runs");
    await writeRunTranscript(runDir, "run_vc_target", repo.path, repo.commitA);
    const input = (commands, extra = {}) => baseInput({ runDir, runId: "run_vc_target", repo, commit: repo.commitA, commands }, extra);
    await assert.rejects(runVerifyCommit(input([])), /must not be empty/);
    await assert.rejects(runVerifyCommit(input(["x".repeat(513)])), /exceeds 512 characters/);
    await assert.rejects(runVerifyCommit(input(new Array(33).fill("echo ok"))), /exceeds 32/);
    await assert.rejects(runVerifyCommit(input(["node C:\\tools\\secret.js"])), /absolute path literal/);
    await assert.rejects(runVerifyCommit(input(["echo ok > /tmp/out.txt"])), /absolute path literal/);
    // 越界 timeout（服务单对象入参——timeoutMs 经 input extra 合并）
    await assert.rejects(runVerifyCommit(input(["echo ok"], { timeoutMs: 999 })), /integer in \[1000, 7200000\]/);
    await assert.rejects(runVerifyCommit(input(["echo ok"], { timeoutMs: 7200001 })), /integer in \[1000, 7200000\]/);
  } finally {
    cleanupDir(scratch);
  }
}));

// ===== 反例：逐命令内容变异（exit 0 也不得记 passed） =====

test("TD-240 反例：命令 exit 0 但改动 tracked 文件——记 failed+contentDrift，不记 passed", withLeadExemptionEnv(async () => {
  const scratch = makeScratch("vc-mutate-");
  try {
    const repo = makeRepo(join(scratch, "repo"));
    const runDir = join(scratch, "runs");
    await writeRunTranscript(runDir, "run_vc_target", repo.path, repo.commitA);
    const result = await runVerifyCommit(baseInput({
      runDir, runId: "run_vc_target", repo, commit: repo.commitA,
      commands: ["node mutate.js", "echo never-reached"],
    }));
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 1);
    assert.equal(result.results.length, 1, "fail-fast：漂移后不再执行后续命令");
    assert.equal(result.results[0].exitCode, 0);
    assert.equal(result.results[0].contentDrift, true);
    const events = await readTranscript(join(runDir, "run_vc_target.jsonl"));
    const outcome = findEvent(events, LEAD_COMMIT_CHECK_OUTCOME_TYPE)[0];
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.results[0].contentDrift, true);
  } finally {
    cleanupDir(scratch);
  }
}));

// ===== 反例：超时子进程收束 + 失败尾 =====

test("TD-240 反例：命令超时——timedOut+failed+fail-fast+子进程树收束", withLeadExemptionEnv(async () => {
  const scratch = makeScratch("vc-timeout-");
  try {
    const repo = makeRepo(join(scratch, "repo"));
    const runDir = join(scratch, "runs");
    await writeRunTranscript(runDir, "run_vc_target", repo.path, repo.commitA);
    const startedAt = Date.now();
    const result = await runVerifyCommit(baseInput({
      runDir, runId: "run_vc_target", repo, commit: repo.commitA,
      commands: ["node stallShort.js", "echo never-reached"],
    }, { timeoutMs: 1000 }));
    const elapsed = Date.now() - startedAt;
    assert.equal(result.status, "failed");
    assert.equal(result.results.length, 1, "fail-fast：超时后不再执行后续命令");
    assert.equal(result.results[0].timedOut, true);
    assert.equal(result.results[0].exitCode, null);
    // 子进程树被收束（_killProcessTree）——总时长远小于 stall 的 4s
    assert.ok(elapsed < 3800, `command should be killed at ~1s (elapsed ${elapsed}ms)`);
    const events = await readTranscript(join(runDir, "run_vc_target.jsonl"));
    const outcome = findEvent(events, LEAD_COMMIT_CHECK_OUTCOME_TYPE)[0];
    assert.equal(outcome.results[0].timedOut, true);
  } finally {
    cleanupDir(scratch);
  }
}));

test("TD-240 裁定②：非零退出携带失败 8KiB 尾（stderrTail 诊断内容），绿色零尾", withLeadExemptionEnv(async () => {
  const scratch = makeScratch("vc-tail-");
  try {
    const repo = makeRepo(join(scratch, "repo"));
    const runDir = join(scratch, "runs");
    await writeRunTranscript(runDir, "run_vc_target", repo.path, repo.commitA);
    const result = await runVerifyCommit(baseInput({
      runDir, runId: "run_vc_target", repo, commit: repo.commitA,
      commands: ["echo green-first", "node fail.js"],
    }));
    assert.equal(result.status, "failed");
    const events = await readTranscript(join(runDir, "run_vc_target.jsonl"));
    const outcome = findEvent(events, LEAD_COMMIT_CHECK_OUTCOME_TYPE)[0];
    assert.equal(outcome.results.length, 2);
    assert.equal(outcome.results[0].exitCode, 0);
    assert.equal(outcome.results[0].stdoutTail, "", "绿色命令结构性零尾");
    assert.equal(outcome.results[0].stderrTail, "", "绿色命令结构性零尾");
    assert.equal(outcome.results[1].exitCode, 3);
    assert.ok(outcome.results[1].stderrTail.includes("boom-tail-marker"), "失败尾携带诊断内容");
    // CLI 安全结果不带尾内容
    assert.ok(!result.results.some((r) => JSON.stringify(r).includes("boom-tail-marker")),
      "safe result rows must not carry tail content");
  } finally {
    cleanupDir(scratch);
  }
}));

// ===== 反例：Ctrl-C 模拟 =====

test("TD-240 反例：Ctrl-C 模拟——interrupt 标志收敛 aborted（尽力写 aborted+清理）", withLeadExemptionEnv(async () => {
  const scratch = makeScratch("vc-sigint-");
  try {
    const repo = makeRepo(join(scratch, "repo"));
    const runDir = join(scratch, "runs");
    await writeRunTranscript(runDir, "run_vc_target", repo.path, repo.commitA);
    const interrupt = { requested: false };
    // 真实执行首命令；沉降后置 interrupt 标志（模拟控制台 Ctrl-C 已达 CLI 处理器）
    const wrappedRunner = async (command, cwd, opts) => {
      const r = await runVerificationCommand(command, cwd, opts);
      if (command === "echo one") interrupt.requested = true;
      return r;
    };
    const result = await runVerifyCommit(baseInput({
      runDir, runId: "run_vc_target", repo, commit: repo.commitA,
      commands: ["echo one", "echo two", "echo three"],
    }, { interrupt, runCommandFn: wrappedRunner }));
    assert.equal(result.status, "aborted");
    assert.equal(result.exitCode, 1);
    assert.equal(result.results.length, 1, "中断后不再执行后续命令");
    assert.equal(result.cleanup, "ok");
    const events = await readTranscript(join(runDir, "run_vc_target.jsonl"));
    const outcome = findEvent(events, LEAD_COMMIT_CHECK_OUTCOME_TYPE)[0];
    assert.equal(outcome.status, "aborted");
    // started 早于首命令（存在即可证）
    assert.equal(findEvent(events, LEAD_COMMIT_CHECK_STARTED_TYPE).length, 1);
  } finally {
    cleanupDir(scratch);
  }
}));

// ===== 反例：审计写失败 =====

test("TD-240 反例：started 审计写失败——抛错+不执行任何命令+worktree 清理", withLeadExemptionEnv(async () => {
  const scratch = makeScratch("vc-auditfail-");
  try {
    const repo = makeRepo(join(scratch, "repo"));
    const runDir = join(scratch, "runs");
    await writeRunTranscript(runDir, "run_vc_target", repo.path, repo.commitA);
    let executed = 0;
    const failingFactory = async () => ({
      append: async () => { throw new Error("disk full"); },
    });
    await assert.rejects(
      runVerifyCommit(baseInput({
        runDir, runId: "run_vc_target", repo, commit: repo.commitA, commands: ["echo ok"],
      }, {
        transcriptFactory: failingFactory,
        runCommandFn: async (...a) => { executed += 1; return { exitCode: 0 }; },
      })),
      /failed to persist the check-started audit event/,
    );
    assert.equal(executed, 0, "started 写失败时绝不执行命令");
    const events = await readTranscript(join(runDir, "run_vc_target.jsonl"));
    assert.equal(findEvent(events, LEAD_COMMIT_CHECK_STARTED_TYPE).length, 0);
    assert.equal(findEvent(events, LEAD_COMMIT_CHECK_OUTCOME_TYPE).length, 0);
    // worktree 已被 finally 兜底清理
    let residue = [];
    try {
      residue = readdirSync(join(repo.path, ".wao-worktrees"));
    } catch { /* 无目录 = 零残留 */ }
    assert.deepEqual(residue, [], "no verify-* worktree residue");
  } finally {
    cleanupDir(scratch);
  }
}));

test("TD-240 反例：outcome 审计写失败——抛错+只剩 started=合法不完整证据", withLeadExemptionEnv(async () => {
  const scratch = makeScratch("vc-outcomefail-");
  try {
    const repo = makeRepo(join(scratch, "repo"));
    const runDir = join(scratch, "runs");
    await writeRunTranscript(runDir, "run_vc_target", repo.path, repo.commitA);
    let appendCalls = 0;
    const transcript = new JsonlTranscript(join(runDir, "run_vc_target.jsonl"), { runId: "run_vc_target", agentId: "glm-pro" });
    const semiFailingFactory = async () => ({
      append: async (type, payload) => {
        appendCalls += 1;
        if (appendCalls >= 2) throw new Error("disk full on outcome");
        return transcript.append(type, payload);
      },
    });
    await assert.rejects(
      runVerifyCommit(baseInput({
        runDir, runId: "run_vc_target", repo, commit: repo.commitA, commands: ["echo ok"],
      }, { transcriptFactory: semiFailingFactory })),
      /failed to persist the check-outcome audit event/,
    );
    // started 已真实落盘、outcome 缺席 → 投影 incomplete（绝不读作通过）
    const events = await readTranscript(join(runDir, "run_vc_target.jsonl"));
    assert.equal(findEvent(events, LEAD_COMMIT_CHECK_STARTED_TYPE).length, 1);
    assert.equal(findEvent(events, LEAD_COMMIT_CHECK_OUTCOME_TYPE).length, 0);
    const projection = projectLeadCommitChecks(events, "run_vc_target");
    assert.equal(projection.count, 1);
    assert.equal(projection.checks[0].status, "incomplete");
    assert.equal(projection.checks[0].hasOutcome, false);
  } finally {
    cleanupDir(scratch);
  }
}));

// ===== 反例：清理失败 =====

test("TD-240 反例：清理失败——结果照记+cleanup:failed+整体非零退出", withLeadExemptionEnv(async () => {
  const scratch = makeScratch("vc-cleanupfail-");
  let holder = null;
  try {
    const repo = makeRepo(join(scratch, "repo"));
    const runDir = join(scratch, "runs");
    await writeRunTranscript(runDir, "run_vc_target", repo.path, repo.commitA);
    let nonceCounter = 0;
    const fixedNonce = () => `deadbeef${(nonceCounter += 1)}`;
    // 注入 gitFn：worktree remove/prune 抛错（逼出 rm 回退路径）；其余 git 调用
    // 走真实结构化参数执行。
    const throwingGit = (args, opts) => {
      if (args[0] === "worktree" && (args[1] === "remove" || args[1] === "prune")) {
        throw new Error("git worktree blocked (injected)");
      }
      return execFileSync("git", args, {
        cwd: opts?.cwd,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
      });
    };
    const wtPath = join(repo.path, ".wao-worktrees", "verify-deadbeef1");
    const svcPromise = runVerifyCommit(baseInput({
      runDir, runId: "run_vc_target", repo, commit: repo.commitA,
      commands: ["node stallShort.js"],
    }, { gitFn: throwingGit, randomIdFn: fixedNonce }));
    // 命令运行期间（4s 窗口）：①await sleep 轮询（Atomics.wait 忙等会饿死事件
    // 循环）；②worktree 就绪后放一个 cwd 钉在 worktree 内的 detached 占位进程
    // （Windows 上删除"某进程当前目录"必败——Node rm 对打开句柄仍可删，实测
    // r+ 句柄不足以阻断）。
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const deadline = Date.now() + 15000;
    while (!existsSync(join(wtPath, "README.md")) && Date.now() < deadline) {
      await sleep(50);
    }
    assert.ok(existsSync(join(wtPath, "README.md")), "worktree must be checked out during the command window");
    holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      cwd: wtPath,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    holder.unref();
    const result = await svcPromise;
    assert.equal(result.status, "passed", "命令本身绿色——结果照记");
    assert.equal(result.cleanup, "failed");
    assert.equal(result.exitCode, 1, "清理失败 → 整体非零退出");
    assert.ok(existsSync(wtPath), "worktree 残留（清理失败的事实）");
    const events = await readTranscript(join(runDir, "run_vc_target.jsonl"));
    assert.equal(findEvent(events, LEAD_COMMIT_CHECK_OUTCOME_TYPE)[0].cleanup, "failed");
  } finally {
    if (holder !== null && holder.pid) {
      try {
        execFileSync("taskkill", ["/PID", String(holder.pid), "/T", "/F"], { stdio: "ignore" });
      } catch { /* best effort */ }
    }
    cleanupDir(scratch);
  }
}));

// ===== 反例：worker 上下文调用拒绝（裁定⑤） =====

test("TD-240 裁定⑤：worker 上下文（WAO_IN_WORKER=1）拒绝——env 准备之前", withStrippedEnv({ WAO_IN_WORKER: "1" }, async () => {
  const scratch = makeScratch("vc-worker-");
  try {
    const repo = makeRepo(join(scratch, "repo"));
    const runDir = join(scratch, "runs");
    await writeRunTranscript(runDir, "run_vc_target", repo.path, repo.commitA);
    let envPrepCalls = 0;
    await assert.rejects(
      runVerifyCommit(baseInput({
        runDir, runId: "run_vc_target", repo, commit: repo.commitA, commands: ["echo ok"],
      }, {
        prepareAttemptEnvFn: async () => { envPrepCalls += 1; return { env: {}, tempDir: null, isolated: false }; },
      })),
      /nested dispatch refused.*env-marker/s,
    );
    assert.equal(envPrepCalls, 0, "拒绝必须先于任何 env 准备");
  } finally {
    cleanupDir(scratch);
  }
}));

test("TD-240 裁定⑤：worktree cwd 上下文拒绝（无豁免时）；Lead 主检出语境放行", withStrippedEnv({}, async () => {
  // 纯函数面：Lead 主检出（无 worker 标记、路径不含 .wao-worktrees）→ 放行
  assert.equal(nestedDispatchContext({ PATH: "x" }, "D:/lead/main-checkout"), null);
  // 服务面：无豁免时，invocationCwd 含 .wao-worktrees 组件即拒绝。显式构造
  // 该路径（不依赖测试进程 cwd 恰好在 worktree 下——canonical 套件从主检出
  // 跑时环境无关地命中同一拒绝）。
  const scratch = makeScratch("vc-wtcwd-");
  try {
    const repo = makeRepo(join(scratch, "repo"));
    const runDir = join(scratch, "runs");
    await writeRunTranscript(runDir, "run_vc_target", repo.path, repo.commitA);
    await assert.rejects(
      runVerifyCommit(baseInput({
        runDir, runId: "run_vc_target", repo, commit: repo.commitA, commands: ["echo ok"],
      }, { invocationCwd: join(repo.path, ".wao-worktrees", "verify-abcdef01") })),
      /nested dispatch refused.*worktree-cwd/s,
    );
  } finally {
    cleanupDir(scratch);
  }
}));

// ===== 多次核验多 checkId + 投影 =====

test("TD-240 裁定②：多次核验——多 checkId 配对，投影枚举全部且各自完整", withLeadExemptionEnv(async () => {
  const scratch = makeScratch("vc-multi-");
  try {
    const repo = makeRepo(join(scratch, "repo"));
    const runDir = join(scratch, "runs");
    await writeRunTranscript(runDir, "run_vc_target", repo.path, repo.commitA);
    let counter = 0;
    const seqNonce = () => `cafe0000${String((counter += 1)).padStart(8, "0")}`;
    const r1 = await runVerifyCommit(baseInput({
      runDir, runId: "run_vc_target", repo, commit: repo.commitA, commands: ["echo ok"],
    }, { randomIdFn: seqNonce }));
    const r2 = await runVerifyCommit(baseInput({
      runDir, runId: "run_vc_target", repo, commit: repo.commitChild, commands: ["echo ok"],
    }, { randomIdFn: seqNonce }));
    assert.notEqual(r1.checkId, r2.checkId, "多次核验以 checkId 区分（无恰一条 CAS）");
    const events = await readTranscript(join(runDir, "run_vc_target.jsonl"));
    assert.equal(findEvent(events, LEAD_COMMIT_CHECK_STARTED_TYPE).length, 2);
    assert.equal(findEvent(events, LEAD_COMMIT_CHECK_OUTCOME_TYPE).length, 2);
    const projection = projectLeadCommitChecks(events, "run_vc_target");
    assert.equal(projection.count, 2);
    assert.ok(projection.checks.every((c) => c.hasOutcome && c.status === "passed"));
    assert.deepEqual(projection.checks.map((c) => c.checkId).sort(), [r1.checkId, r2.checkId].sort());
    // 外 run 事件不投影
    assert.equal(projectLeadCommitChecks(events, "run_vc_other").count, 0);
  } finally {
    cleanupDir(scratch);
  }
}));

// ===== 事件不入判定输入（裁定⑥） =====

test("TD-240 裁定⑥：事件族不进 validateDeliveryFacts / decide / wao accept 任何判定输入", withLeadExemptionEnv(async () => {
  const scratch = makeScratch("vc-isolation-");
  try {
    const repo = makeRepo(join(scratch, "repo"));
    const runDirWith = join(scratch, "runs-with");
    const runDirWithout = join(scratch, "runs-without");
    // acceptanceRecord 的 runId 校验比 isValidRunId 更严（run_ + 纯字母数字）
    const isoRunId = "run_vcdecide";
    // 带完整验证链的终态 delivery run（decide 可 accept 的形状）
    const buildLifecycle = async (dir) => {
      mkdirSync(dir, { recursive: true });
      const t = new JsonlTranscript(join(dir, `${isoRunId}.jsonl`), { runId: isoRunId, agentId: "glm-pro" });
      const ref = makeRef(isoRunId, repo.commitA, repo.base);
      ref.verification = {
        status: "passed", commands: ["echo ok"], verifiedCommit: repo.commitA, results: [],
      };
      await t.append("run.started", { cwd: repo.path, backend: "fake" });
      await t.append("run.delivery_created", { delivery: ref });
      await t.append("run.delivery_verification_passed", { delivery: ref });
      await t.append("run.completed", {});
      await t.append("run.state_change", { from: "running", to: "completed", reason: "done" });
    };
    await buildLifecycle(runDirWith);
    await buildLifecycle(runDirWithout);

    const before = validateDeliveryFacts(await readTranscript(join(runDirWith, `${isoRunId}.jsonl`)));
    // 追加真实 lead_commit_check 事件族（真实服务跑一遍）
    const result = await runVerifyCommit(baseInput({
      runDir: runDirWith, runId: isoRunId, repo, commit: repo.commitA, commands: ["echo ok"],
    }));
    assert.equal(result.status, "passed");
    const afterEvents = await readTranscript(join(runDirWith, `${isoRunId}.jsonl`));
    assert.equal(findEvent(afterEvents, LEAD_COMMIT_CHECK_STARTED_TYPE).length, 1);
    const after = validateDeliveryFacts(afterEvents);
    // validateDeliveryFacts 结果逐字段一致（事件族不被任何核验/决策计数面消费）
    assert.deepEqual(after, before);

    // decide：有/无 lead_commit_check 事件的 accept 结果一致
    const decideWith = await decideRunDelivery({
      runId: isoRunId, runDir: runDirWith, decision: "accepted", reason: "ok",
    });
    const decideWithout = await decideRunDelivery({
      runId: isoRunId, runDir: runDirWithout, decision: "accepted", reason: "ok",
    });
    assert.equal(decideWith.accepted, true);
    assert.equal(decideWithout.accepted, true);
    assert.equal(decideWith.event.deliveryCommit, decideWithout.event.deliveryCommit);

    // wao accept（acceptance.recorded）：事件族后仍按终态正常落验收
    const accWith = await recordAcceptance({
      runsDir: runDirWith, runId: isoRunId, decision: "accepted", reason: "checked",
    });
    const accWithout = await recordAcceptance({
      runsDir: runDirWithout, runId: isoRunId, decision: "accepted", reason: "checked",
    });
    assert.equal(accWith.appended, true);
    assert.equal(accWithout.appended, true);
  } finally {
    cleanupDir(scratch);
  }
}));

// ===== run_activity 真实转录冒烟（TD-240 红线：不落 [unknown_event]） =====

test("TD-240 红线：真实转录经 run_activity 投影——新事件族被分类消化，不落 [unknown_event]", withLeadExemptionEnv(async () => {
  const scratch = makeScratch("vc-activity-");
  try {
    const repo = makeRepo(join(scratch, "repo"));
    const runDir = join(scratch, "runs");
    await writeRunTranscript(runDir, "run_vc_target", repo.path, repo.commitA);
    const result = await runVerifyCommit(baseInput({
      runDir, runId: "run_vc_target", repo, commit: repo.commitA, commands: ["echo ok"],
    }));
    assert.equal(result.status, "passed");
    const events = await readTranscript(join(runDir, "run_vc_target.jsonl"));
    // 事件确实在转录里（防空调转）
    const leadSeqs = new Set(events
      .filter((e) => e.type === LEAD_COMMIT_CHECK_STARTED_TYPE || e.type === LEAD_COMMIT_CHECK_OUTCOME_TYPE)
      .map((e) => e.seq));
    assert.ok(leadSeqs.size >= 2);
    const projected = projectRunActivity({ events, agentId: "glm-pro" }, { runId: "run_vc_target", pageSize: 50 });
    const out = JSON.stringify(projected);
    // 分类消化 = 两个事件不产生任何时间线条目（SKIP_TYPES 同 acceptance.recorded
    // 先例）；若未被消化，会在各自 seq 出现 other/[unknown_event] 条目。
    const leadEntries = projected.entries.filter((e) => leadSeqs.has(e.seq));
    assert.equal(leadEntries.length, 0, "lead_commit_check 事件族必须被分类消化（不产生时间线条目）");
    assert.ok(!out.includes("lead_commit_check"), "事件名/payload 不得出现在活动投影输出");
    // 对照组：其余事件正常投影（非空时间线）
    assert.ok(projected.entries.length > 0);
  } finally {
    cleanupDir(scratch);
  }
}));

// ===== CLI 适配层（mock service） =====

function mockServiceResult(overrides = {}) {
  return {
    runId: "run_vc_cli",
    checkId: "0123456789abcdef",
    commit: "a".repeat(40),
    status: "passed",
    cleanup: "ok",
    results: [{ index: 0, exitCode: 0, timedOut: false, durationMs: 12 }],
    events: { started: true, outcome: true },
    exitCode: 0,
    ...overrides,
  };
}

function countingService(result) {
  const calls = [];
  const svc = async (input) => { calls.push(input); return result; };
  svc.calls = calls;
  return svc;
}

async function runCli(args, service) {
  const out = await captureLog(async () => {
    await runsCommand(["verify-commit", ...args], { runDir: "runs" }, { runVerifyCommitFn: service });
  });
  return out;
}

test("TD-240 CLI：RUNS_SUBCOMMANDS 收录 + 未知子命令文案", () => {
  assert.ok(RUNS_SUBCOMMANDS.includes("verify-commit"));
  assert.ok(RUNS_SUBCOMMANDS.includes("list"));
});

test("TD-240 CLI：参数纪律（未知 flag/缺 --commit/缺 --commands-file/重复/短 SHA）", async () => {
  const svc = countingService(mockServiceResult());
  await assert.rejects(
    runCli(["run_vc_cli", "--commit", "a".repeat(40), "--commands-file", "x", "--bogus", "1"], svc),
    /unknown flag for runs verify-commit: --bogus/,
  );
  await assert.rejects(
    runCli(["run_vc_cli", "--commands-file", "x"], svc),
    /requires --commit/,
  );
  await assert.rejects(
    runCli(["run_vc_cli", "--commit", "a".repeat(40)], svc),
    /requires --commands-file/,
  );
  await assert.rejects(
    runCli(["run_vc_cli", "extra", "--commit", "a".repeat(40), "--commands-file", "x"], svc),
    /exactly one <runId>/,
  );
  await assert.rejects(
    runCli(["run_vc_cli", "--commit", "a".repeat(12), "--commands-file", "x"], svc),
    /short forms are not accepted/,
  );
  await assert.rejects(
    runCli(["run_vc_cli", "--commit", "A".repeat(40), "--commands-file", "x"], svc),
    /canonical full-form/,
  );
  assert.equal(svc.calls.length, 0, "参数拒绝必须先于服务调用");
});

test("TD-240 CLI：commands-file 解析（共享解析器边界）+ 字节 sha256 传递", async () => {
  const scratch = makeScratch("vc-clicmd-");
  try {
    const commands = ["echo one", "echo two"];
    const file = join(scratch, "cmds.json");
    writeFileSync(file, JSON.stringify(commands), "utf8");
    const svc = countingService(mockServiceResult());
    const out = await runCli(
      ["run_vc_cli", "--commit", "a".repeat(40), "--commands-file", file, "--format", "json"], svc,
    );
    assert.equal(svc.calls.length, 1);
    assert.deepEqual(svc.calls[0].commands, commands);
    assert.equal(svc.calls[0].commit, "a".repeat(40));
    assert.equal(svc.calls[0].runId, "run_vc_cli");
    const expectedSha = createHash("sha256").update(readFileSync(file)).digest("hex");
    assert.equal(svc.calls[0].commandsFileSha256, expectedSha);
    const parsed = JSON.parse(out);
    assert.equal(parsed.status, "passed");
    // JSON 输出闭集字段
    assert.deepEqual(Object.keys(parsed).sort(),
      ["checkId", "cleanup", "commit", "results", "runId", "status"]);
    // 裁定⑥：CLI 输出不出现 accepted/verified 字样
    assert.ok(!/accepted|verified/i.test(out), "CLI output must not contain accepted/verified wording");
    // 服务收到 authorizedWorkspaceRoot（--cwd 可解析）
    assert.ok(typeof svc.calls[0].authorizedWorkspaceRoot === "string");
  } finally {
    cleanupDir(scratch);
  }
});

test("TD-240 CLI：commands-file 反例（非 JSON/非数组/空白/超界）拒绝且不调服务", async () => {
  const scratch = makeScratch("vc-clibad-");
  try {
    const svc = countingService(mockServiceResult());
    const mk = (content) => {
      const f = join(scratch, `c-${Math.random().toString(16).slice(2)}.json`);
      writeFileSync(f, content, "utf8");
      return f;
    };
    await assert.rejects(
      runCli(["run_vc_cli", "--commit", "a".repeat(40), "--commands-file", mk("not-json{")], svc),
      /--commands-file must be valid UTF-8 JSON/,
    );
    await assert.rejects(
      runCli(["run_vc_cli", "--commit", "a".repeat(40), "--commands-file", mk('{"a":1}')], svc),
      /must contain a JSON array of strings/,
    );
    await assert.rejects(
      runCli(["run_vc_cli", "--commit", "a".repeat(40), "--commands-file", mk('["echo ok", ""]')], svc),
      /must not contain blank commands/,
    );
    await assert.rejects(
      runCli(["run_vc_cli", "--commit", "a".repeat(40), "--commands-file", mk(`["${"x".repeat(513)}"]`)], svc),
      /command exceeds 512 characters/,
    );
    await assert.rejects(
      runCli(["run_vc_cli", "--commit", "a".repeat(40), "--commands-file", mk(JSON.stringify(new Array(33).fill("echo ok")))], svc),
      /exceeds 32 commands/,
    );
    await assert.rejects(
      runCli(["run_vc_cli", "--commit", "a".repeat(40), "--commands-file", mk("[]"), "--timeout-ms", "999"], svc),
      /--timeout-ms must be an integer in \[1000, 7200000\]/,
    );
    assert.equal(svc.calls.length, 0);
  } finally {
    cleanupDir(scratch);
  }
});

test("TD-240 CLI：failed/cleanup:failed → process.exitCode 置 1；text 模式输出闭集行", async () => {
  const savedExitCode = process.exitCode;
  const scratch = makeScratch("vc-cliexit-");
  try {
    const file = join(scratch, "cmds.json");
    writeFileSync(file, '["echo ok"]', "utf8");
    const svc = countingService(mockServiceResult({
      status: "failed", cleanup: "failed", exitCode: 1,
      results: [{ index: 0, exitCode: 3, timedOut: false, durationMs: 5, contentDrift: true }],
    }));
    const out = await runCli(["run_vc_cli", "--commit", "a".repeat(40), "--commands-file", file], svc);
    assert.equal(process.exitCode, 1, "非零退出经 process.exitCode 承载");
    assert.match(out, /Status: failed/);
    assert.match(out, /Cleanup: failed/);
    assert.match(out, /\(worktree drift\)/);
    assert.ok(!/accepted|verified/i.test(out));
  } finally {
    process.exitCode = savedExitCode;
    cleanupDir(scratch);
  }
});

test("TD-240 CLI：SIGINT 注册/注销 + interrupt 透传（mock）", async () => {
  const scratch = makeScratch("vc-clisigint-");
  const savedExitCode = process.exitCode;
  try {
    const file = join(scratch, "cmds.json");
    writeFileSync(file, '["echo ok"]', "utf8");
    let seenInterrupt;
    const svc = async (input) => {
      seenInterrupt = input.interrupt;
      return mockServiceResult({ status: "aborted", exitCode: 1 });
    };
    await runCli(["run_vc_cli", "--commit", "a".repeat(40), "--commands-file", file], svc);
    assert.ok(seenInterrupt && typeof seenInterrupt === "object" && "requested" in seenInterrupt,
      "CLI 必须向服务透传 interrupt 标志对象");
    // 注册的 SIGINT 处理器在调用后注销（process.listeners 计数回落）
    const before = process.listenerCount("SIGINT");
    const svc2 = countingService(mockServiceResult());
    await runCli(["run_vc_cli", "--commit", "a".repeat(40), "--commands-file", file], svc2);
    assert.equal(process.listenerCount("SIGINT"), before, "SIGINT 处理器必须被注销");
  } finally {
    process.exitCode = savedExitCode;
    cleanupDir(scratch);
  }
});
