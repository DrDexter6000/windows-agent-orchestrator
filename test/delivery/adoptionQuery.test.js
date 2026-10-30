// test/delivery/adoptionQuery.test.js
//
// 决定 0098：交付读面显示 adoption（WAO-Adopted-From）。
//
// 覆盖面：
//   - messageDeclaresAdoption（纯函数）：精确命中、前缀碰撞、缩进伪 trailer、
//     正文顶格成句的提及、CRLF、行尾空白、15494b9 形状（trailer 段后空一行再
//     接 Co-Authored-By）、35fc0c5 形状（只有 WAO-Adopted-From）、一个提交带
//     多个 runId、段落全 Key: value 规则。
//   - queryRunAdoption（真实临时仓 + 注入执行器）：found、只在 wao/* 分支 →
//     not_found、主工作树 detached → no_main_branch、扫主分支全历史（不按
//     base 收窄）、上限 5 + truncated、git_error / timeout / unbound（且不调 git）、
//     预筛前缀碰撞被精确核对拒绝、不回显提交消息。
//   - 服务接线：getRunDelivery 每个返回形态都带 adoption（未请求 / 打包失败 /
//     隔离失败 / pending）；getRunDeliveryReadiness 等待路径 git 只在返回前查
//     一次（轮询 N 次不放大）；查询前后转录字节不变。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  messageDeclaresAdoption,
  queryRunAdoption,
  ADOPTION_COMMITS_CAP,
  ADOPTION_STATUSES,
  ADOPTION_UNCHECKED_REASONS,
} from "../../src/application/adoptionQuery.js";
import { getRunDelivery, getRunDeliveryReadiness, DELIVERY_WAIT_MS_MIN } from "../../src/application/runDelivery.js";

// ----- helpers -----

function cleanupDir(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { /* retry */ }
  }
}

function gitOf(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: "2005-04-07T22:13:13", GIT_COMMITTER_DATE: "2005-04-07T22:13:13" },
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  }).trim();
}

/** 临时仓（分支 main，主工作树即该目录）。 */
function makeRepo(dir, { branch = "main" } = {}) {
  mkdirSync(dir, { recursive: true });
  gitOf(dir, ["init", "-b", branch]);
  gitOf(dir, ["config", "user.email", "t@t.c"]);
  gitOf(dir, ["config", "user.name", "T"]);
  writeFileSync(join(dir, "README.md"), "# base\n", "utf8");
  gitOf(dir, ["add", "README.md"]);
  gitOf(dir, ["commit", "-m", "base"]);
  return gitOf(dir, ["rev-parse", "HEAD"]);
}

/** 主分支上一个带 trailer 的空提交，返回 sha。 */
function trailerCommit(cwd, runId, { extra = [] } = {}) {
  const args = ["commit", "--allow-empty", "-m", "adopt after fix"];
  for (const para of [`WAO-Adopted-From: ${runId}`, ...extra]) args.push("-m", para);
  gitOf(cwd, args);
  return gitOf(cwd, ["rev-parse", "HEAD"]);
}

// 注入执行器的固定主分支形状（parseWorktreePorcelain 的一条记录）。
const FAKE_PORCELAIN = "worktree D:/fake/main\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\n";

/** 注入执行器：按子命令分发；默认主分支 main、无候选提交。 */
function fakeGit(over = {}) {
  return (args) => {
    if (args[1] === "worktree") return over.worktree ?? FAKE_PORCELAIN;
    if (args[1] === "log" && args.includes("--format=%H")) return over.log ?? "";
    if (args[1] === "log" && args.includes("--format=%B")) return over.message ?? "";
    throw new Error(`fakeGit: unexpected args ${JSON.stringify(args)}`);
  };
}

// =====================================================================
// messageDeclaresAdoption（纯函数）
// =====================================================================

test("匹配：整行相等 + 自成段落的 trailer 命中", () => {
  assert.equal(messageDeclaresAdoption("fix stuff\n\nWAO-Adopted-From: run_x\n", "run_x"), true);
  assert.equal(messageDeclaresAdoption("fix stuff\n\nWAO-Adopted-From: run_x", "run_x"), true);
});

test("匹配：前缀碰撞不命中（run_x 不匹配 run_x2 的 trailer）", () => {
  assert.equal(messageDeclaresAdoption("t\n\nWAO-Adopted-From: run_x2\n", "run_x"), false);
});

test("匹配：缩进的伪 trailer 不命中（整行相等，前导空白不容忍）", () => {
  assert.equal(messageDeclaresAdoption("正文提到 WAO-Adopted-From 字样。\n  WAO-Adopted-From: run_x\n", "run_x"), false);
});

test("匹配：正文顶格成句的提及不命中（行内包含但整行不等）", () => {
  assert.equal(messageDeclaresAdoption("我们按 WAO-Adopted-From: run_x 的约定做了采纳\n\nbody\n", "run_x"), false);
});

test("匹配：CRLF 归一后命中", () => {
  assert.equal(messageDeclaresAdoption("fix stuff\r\n\r\nWAO-Adopted-From: run_x\r\n", "run_x"), true);
});

test("匹配：行尾空白（空格/制表）容忍", () => {
  assert.equal(messageDeclaresAdoption("t\n\nWAO-Adopted-From: run_x \t\n", "run_x"), true);
});

test("匹配：15494b9 形状——trailer 段后空一行再接 Co-Authored-By 仍命中", () => {
  const message = [
    "plan: adopt batch 49 fix",
    "",
    "The delivery verification failed for a Lead-side spec error; the artifact",
    "itself needed no change.",
    "",
    "WAO-Adopted-From: run_x",
    "WAO-Original-Delivery: 2222222222222222222222222222222222222222",
    "",
    "Co-Authored-By: Someone <s@example.com>",
    "",
  ].join("\n");
  assert.equal(messageDeclaresAdoption(message, "run_x"), true);
});

test("匹配：35fc0c5 形状——只有 WAO-Adopted-From（无 WAO-Original-Delivery）命中", () => {
  assert.equal(messageDeclaresAdoption("t\n\nWAO-Adopted-From: run_x\n", "run_x"), true);
});

test("匹配：一个提交带多个 runId——各自命中", () => {
  const message = "t\n\nWAO-Adopted-From: run_a\nWAO-Adopted-From: run_b\n";
  assert.equal(messageDeclaresAdoption(message, "run_a"), true);
  assert.equal(messageDeclaresAdoption(message, "run_b"), true);
  assert.equal(messageDeclaresAdoption(message, "run_c"), false);
});

test("匹配：段落规则——trailer 行与非 Key: value 行同段（无空行分隔）不命中", () => {
  assert.equal(messageDeclaresAdoption("adopted the delivery as-is\nWAO-Adopted-From: run_x\n", "run_x"), false);
});

test("匹配：坏输入不命中（非字符串/空 runId）", () => {
  assert.equal(messageDeclaresAdoption(null, "run_x"), false);
  assert.equal(messageDeclaresAdoption("WAO-Adopted-From: run_x", ""), false);
});

// =====================================================================
// queryRunAdoption（真实临时仓）
// =====================================================================

test("查询：主分支上带 trailer 的提交 → found（返回 sha 与分支名）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-adopt-found-"));
  try {
    makeRepo(dir);
    const sha = trailerCommit(dir, "run_adopt_1");
    const result = await queryRunAdoption({ repoRoot: dir, runId: "run_adopt_1" });
    assert.deepEqual(result, {
      status: "found", commits: [sha], truncated: false, uncheckedReason: null, branch: "main",
    });
  } finally { cleanupDir(dir); }
});

test("查询：trailer 只在 wao/* 分支上出现 → not_found", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-adopt-waobranch-"));
  try {
    makeRepo(dir);
    gitOf(dir, ["checkout", "-b", "wao/run_adopt_2"]);
    trailerCommit(dir, "run_adopt_2");
    gitOf(dir, ["checkout", "main"]);
    const result = await queryRunAdoption({ repoRoot: dir, runId: "run_adopt_2" });
    assert.deepEqual(result, {
      status: "not_found", commits: [], truncated: false, uncheckedReason: null, branch: "main",
    });
  } finally { cleanupDir(dir); }
});

test("查询：主工作树 detached → unchecked/no_main_branch（不退回 HEAD）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-adopt-detach-"));
  try {
    makeRepo(dir);
    gitOf(dir, ["checkout", "--detach", "HEAD"]);
    const result = await queryRunAdoption({ repoRoot: dir, runId: "run_adopt_3" });
    assert.equal(result.status, "unchecked");
    assert.equal(result.uncheckedReason, "no_main_branch");
    assert.deepEqual(result.commits, []);
    assert.equal(result.truncated, false);
  } finally { cleanupDir(dir); }
});

// 扫主分支全历史、不按交付的 base 收窄：base 常是开发分支上的提交，分支删除后会被
// gc，收窄的范围会让旧运行的查询报错。
test("查询：扫主分支全历史，更早的采纳提交照样可见", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-adopt-history-"));
  try {
    makeRepo(dir);
    const oldSha = trailerCommit(dir, "run_adopt_4");
    writeFileSync(join(dir, "README.md"), "# newer\n", "utf8");
    gitOf(dir, ["commit", "-am", "later work"]);
    const result = await queryRunAdoption({ repoRoot: dir, runId: "run_adopt_4" });
    assert.deepEqual(result.commits, [oldSha]);
  } finally { cleanupDir(dir); }
});

test("查询：预筛的 git log 用完整分支引用、以 -- 收尾，不带范围", async () => {
  const calls = [];
  const git = fakeGit();
  await queryRunAdoption({
    repoRoot: "D:/fake", runId: "run_x",
    gitFn: (args, opts) => { calls.push(args); return git(args, opts); },
  });
  const logCall = calls.find((a) => a[1] === "log" && a.includes("--format=%H"));
  assert.ok(logCall, "预筛调用在场");
  assert.deepEqual(logCall.slice(-2), ["refs/heads/main", "--"], "范围就是主分支本身，写成完整引用");
  assert.ok(!logCall.some((a) => a.includes("..")), "没有 <base>..<branch> 形的范围");
});

test("查询：同名 tag 与同名文件不影响主分支的判定", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-adopt-tagname-"));
  try {
    makeRepo(dir);
    // 侧分支上有采纳提交，再打一个叫 main 的 tag 指向它；主分支本身没有。
    gitOf(dir, ["checkout", "-b", "side"]);
    trailerCommit(dir, "run_adopt_tag");
    gitOf(dir, ["tag", "main"]);
    gitOf(dir, ["checkout", "main"]);
    writeFileSync(join(dir, "main"), "a file named like the branch\n", "utf8");
    const result = await queryRunAdoption({ repoRoot: dir, runId: "run_adopt_tag" });
    assert.equal(result.status, "not_found", "tag main 上的采纳不算主分支的");
    assert.equal(result.uncheckedReason, null, "同名文件不让查询报错");
  } finally { cleanupDir(dir); }
});

test("查询：多个采纳提交 → 上限 5 + truncated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-adopt-cap-"));
  try {
    makeRepo(dir);
    const shas = [];
    for (let i = 0; i < ADOPTION_COMMITS_CAP + 2; i += 1) {
      shas.push(trailerCommit(dir, "run_adopt_6"));
    }
    const result = await queryRunAdoption({ repoRoot: dir, runId: "run_adopt_6" });
    assert.equal(result.status, "found");
    assert.equal(result.commits.length, ADOPTION_COMMITS_CAP);
    assert.equal(result.truncated, true, "第 6 个命中即置 truncated");
    // git log 新者在前：前 5 = 最新 5 个提交。
    assert.deepEqual(result.commits, [...shas].reverse().slice(0, ADOPTION_COMMITS_CAP));
  } finally { cleanupDir(dir); }
});

test("查询：恰好 5 个采纳提交 → 不置 truncated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-adopt-cap5-"));
  try {
    makeRepo(dir);
    for (let i = 0; i < ADOPTION_COMMITS_CAP; i += 1) trailerCommit(dir, "run_adopt_7");
    const result = await queryRunAdoption({ repoRoot: dir, runId: "run_adopt_7" });
    assert.equal(result.commits.length, ADOPTION_COMMITS_CAP);
    assert.equal(result.truncated, false);
  } finally { cleanupDir(dir); }
});

test("查询：预筛的前缀碰撞被精确核对拒绝（run_x 查不到 run_x2 的提交）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-adopt-prefix-"));
  try {
    makeRepo(dir);
    trailerCommit(dir, "run_adopt_8x");
    const result = await queryRunAdoption({ repoRoot: dir, runId: "run_adopt_8" });
    assert.equal(result.status, "not_found", "--fixed-strings 预筛会命中 run_adopt_8x，%B 精确核对必须拒绝");
  } finally { cleanupDir(dir); }
});

test("查询：git 抛错 → git_error；超时（killed）→ timeout", async () => {
  const boom = () => { throw new Error("git exploded"); };
  const r1 = await queryRunAdoption({ repoRoot: "D:/fake", runId: "run_x", gitFn: boom });
  assert.deepEqual(
    [r1.status, r1.uncheckedReason],
    ["unchecked", "git_error"],
  );
  const killed = () => {
    const e = new Error("spawn killed");
    e.killed = true;
    throw e;
  };
  const r2 = await queryRunAdoption({ repoRoot: "D:/fake", runId: "run_x", gitFn: killed });
  assert.deepEqual(
    [r2.status, r2.uncheckedReason],
    ["unchecked", "timeout"],
  );
});

test("查询：未给仓库根 → unbound 且零 git 调用；坏 runId → 抛错", async () => {
  let calls = 0;
  const counting = () => { calls += 1; return FAKE_PORCELAIN; };
  const result = await queryRunAdoption({ repoRoot: undefined, runId: "run_x", gitFn: counting });
  assert.deepEqual(
    [result.status, result.uncheckedReason, result.commits, calls],
    ["unchecked", "unbound", [], 0],
  );
  await assert.rejects(
    () => queryRunAdoption({ repoRoot: "D:/fake", runId: "bad id!" }),
    /invalid runId/,
  );
});


test("查询：结果不回显提交消息（只有 sha 与闭集事实）", async () => {
  const bodyMarker = "COMMIT-BODY-MARKER-ONLY-IN-MESSAGE";
  const sha = "a".repeat(40);
  const result = await queryRunAdoption({
    repoRoot: "D:/fake",
    runId: "run_x",
    gitFn: fakeGit({ log: `${sha}\n`, message: `subject\n\nWAO-Adopted-From: run_x\n\n${bodyMarker}\n` }),
  });
  assert.equal(result.status, "found");
  const dumped = JSON.stringify(result);
  assert.ok(!dumped.includes(bodyMarker), "提交消息内容不得出现在结果里");
  assert.ok(!dumped.includes("subject"), "提交主题不得出现在结果里");
});

test("闭集 SSOT：三态与未查原因的冻结成员", () => {
  assert.deepEqual(ADOPTION_STATUSES, ["found", "not_found", "unchecked"]);
  assert.deepEqual(ADOPTION_UNCHECKED_REASONS, ["unbound", "no_main_branch", "git_error", "timeout"]);
  assert.equal(ADOPTION_COMMITS_CAP, 5);
});

// =====================================================================
// 服务接线：getRunDelivery 每个返回形态都带 adoption
// =====================================================================

let svcSeq = 0;
function line(runId, obj) {
  svcSeq += 1;
  return JSON.stringify({ runId, agentId: "coder_low", ts: "2026-10-30T00:00:00.000Z", seq: svcSeq, ...obj });
}

function writeRun(dir, runId, lines) {
  writeFileSync(join(dir, `${runId}.jsonl`), `${lines.join("\n")}\n`, "utf8");
}

const startedWithDelivery = (runId) => line(runId, {
  type: "run.started",
  backend: "claude-code",
  delivery: { mode: "git_commit_v1", allowedPaths: ["src"] },
});

test("形态：未请求交付的 run 也带 adoption（not_found）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-adopt-shape-noreq-"));
  try {
    writeRun(dir, "run_shape_1", [
      line("run_shape_1", { type: "run.started", backend: "claude-code" }),
      line("run_shape_1", { type: "run.state_change", from: "running", to: "completed", reason: "done" }),
    ]);
    const view = await getRunDelivery({ runId: "run_shape_1", runDir: dir, adoptionRepoRoot: "D:/fake", adoptionGitFn: fakeGit() });
    assert.equal(view.deliveryRequested, false);
    assert.deepEqual(view.adoption, {
      status: "not_found", commits: [], truncated: false, uncheckedReason: null, branch: "main",
    });
  } finally { cleanupDir(dir); }
});

test("形态：打包失败 / 隔离失败 / pending（已请求未打包）都带 adoption", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-adopt-shape-mix-"));
  try {
    writeRun(dir, "run_shape_pkg", [
      line("run_shape_pkg", { type: "run.background_submitted", deliveryRequested: true }),
      line("run_shape_pkg", { type: "run.delivery_failed", deliveryCode: "base_commit_mismatch" }),
    ]);
    writeRun(dir, "run_shape_iso", [
      startedWithDelivery("run_shape_iso"),
      line("run_shape_iso", { type: "run.state_change", from: "running", to: "failed", reason: "workdir_escape" }),
      line("run_shape_iso", { type: "run.isolation_violation", code: "workdir_escape" }),
    ]);
    writeRun(dir, "run_shape_pend", [
      startedWithDelivery("run_shape_pend"),
      line("run_shape_pend", { type: "run.state_change", from: "pending", to: "running", reason: "first_event" }),
    ]);
    for (const runId of ["run_shape_pkg", "run_shape_iso", "run_shape_pend"]) {
      const view = await getRunDelivery({ runId, runDir: dir, adoptionRepoRoot: "D:/fake", adoptionGitFn: fakeGit() });
      assert.ok(view.adoption, `${runId} 带 adoption`);
      assert.equal(view.adoption.status, "not_found");
      assert.deepEqual(view.adoption.commits, []);
    }
  } finally { cleanupDir(dir); }
});

test("形态：服务未给仓库根 → unchecked/unbound 且不跑 git（authorizedWorkspaceRoot 缺席）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-adopt-shape-unbound-"));
  try {
    writeRun(dir, "run_shape_unbound", [
      line("run_shape_unbound", { type: "run.started", backend: "claude-code" }),
      line("run_shape_unbound", { type: "run.state_change", from: "running", to: "completed", reason: "done" }),
    ]);
    let calls = 0;
    const view = await getRunDelivery({
      runId: "run_shape_unbound",
      runDir: dir,
      adoptionGitFn: () => { calls += 1; return FAKE_PORCELAIN; },
    });
    assert.deepEqual(
      [view.adoption.status, view.adoption.uncheckedReason, calls],
      ["unchecked", "unbound", 0],
      "没有仓库根就不跑 git",
    );
  } finally { cleanupDir(dir); }
});

test("等待路径：轮询 N 次只查一次 git（决定 0098 第 5 条）；转录字节不变", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-adopt-wait-"));
  try {
    writeRun(dir, "run_wait_adopt", [
      startedWithDelivery("run_wait_adopt"),
      line("run_wait_adopt", { type: "run.state_change", from: "pending", to: "running", reason: "first_event" }),
    ]);
    const transcriptPath = join(dir, "run_wait_adopt.jsonl");
    const bytesBefore = readFileSync(transcriptPath);

    const gitCalls = [];
    const countingGit = (args) => {
      gitCalls.push(args);
      return fakeGit()(args);
    };
    // 假时钟：每次调用前进 150ms——1s 等待窗内轮询约 3 次（每轮消耗 2 次读数：
    // 循环条件 + remaining）。
    let clock = 0;
    const nowFn = () => { clock += 150; return clock; };
    let polls = 0;
    const result = await getRunDeliveryReadiness({
      runId: "run_wait_adopt",
      runDir: dir,
      waitMs: DELIVERY_WAIT_MS_MIN,
      adoptionRepoRoot: "D:/fake",
      adoptionGitFn: countingGit,
      sleepFn: async () => { polls += 1; },
      nowFn,
      pollIntervalMs: 100,
    });
    assert.equal(result.readiness, "waiting_for_packaging");
    assert.equal(result.waitReturnedEarly, false);
    assert.ok(polls >= 2, `等待循环真的轮询了多轮（polls=${polls}）`);
    assert.equal(result.adoption.status, "not_found");
    // 只有一次查询的 git 调用量：worktree list 恰一次 + log 恰一次（无候选）。
    assert.equal(gitCalls.filter((a) => a[1] === "worktree").length, 1, "worktree list 只调用一次");
    assert.equal(gitCalls.filter((a) => a[1] === "log").length, 1, "log 只调用一次");
    assert.equal(gitCalls.length, 2, "轮询次数不放大 git 调用");
    assert.equal(readFileSync(transcriptPath).equals(bytesBefore), true, "查询前后转录字节不变");
  } finally { cleanupDir(dir); }
});
