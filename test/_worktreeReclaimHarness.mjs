// test/_worktreeReclaimHarness.mjs
//
// worktree reclaim 测试共用构造器：真 git 临时仓 + 转录种子 + 事件构造。
// 一切都在 os.tmpdir() 下（静态 runs/ 守卫的合法形态），从不指向仓库相对
// runs/。

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** 远旧于任何新鲜阈的事件时间戳。 */
export const OLD_TS = "2026-01-01T00:00:00.000Z";

/** 固定时钟（计划生成用；比真实时钟略前，recent 断言两边一致）。 */
export function fixedNow() {
  return Date.now() + 60_000;
}

export function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  }).trim();
}

/**
 * 真 git 临时仓：main 分支一个初始提交。opts.ignoreWaoWorktrees 缺省 true——
 * .gitignore 预置 node_modules/ 与 .wao-worktrees/；false 复现从未派发过、
 * 没有预置 .wao-worktrees/ 忽略规则的宿主。
 */
export async function makeRepo(prefix = "wao-reclaim-", { ignoreWaoWorktrees = true } = {}) {
  const repo = await mkdtemp(prefix);
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "test@test"], repo);
  git(["config", "user.name", "test"], repo);
  await mkdir(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "a.txt"), "const a = 1;\n");
  writeFileSync(join(repo, ".gitignore"), ignoreWaoWorktrees
    ? "node_modules/\n.wao-worktrees/\n"
    : "node_modules/\n");
  git(["add", "."], repo);
  git(["commit", "-m", "init"], repo);
  return { repo, mainCommit: git(["rev-parse", "HEAD"], repo) };
}

export async function mkdtemp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return dir;
}

async function mkdir(p) {
  mkdirSync(p, { recursive: true });
  return p;
}

/** 在 <repo>/.wao-worktrees/<runId> 建登记 worktree + wao/<runId> 分支。 */
export function makeWorktree(repo, runId, extraArgs = []) {
  const wt = join(repo, ".wao-worktrees", runId);
  git(["worktree", "add", wt, "-b", `wao/${runId}`, ...extraArgs], repo);
  return wt;
}

/** 关联（开发）工作树：git worktree add <path> -b <branch>，非运行树。 */
export function makeLinkedWorktree(repo, path, branch) {
  git(["worktree", "add", path, "-b", branch], repo);
  return path;
}

/**
 * 在某个检出里"派发"出的运行树：<checkout>/.wao-worktrees/<runId> + wao/<runId>
 * 分支（对齐 src/isolation.js createWorktree 的位置与分支形状；checkout 可以是
 * 主检出，也可以是关联工作树——运行树嵌在关联工作树里的形态）。
 */
export function makeRunTreeIn(checkout, runId) {
  const wt = join(checkout, ".wao-worktrees", runId);
  git(["worktree", "add", wt, "-b", `wao/${runId}`], checkout);
  return wt;
}

/** 在某个检出里提交一个文件，返回新 HEAD。 */
export function commitIn(checkout, file, content) {
  writeFileSync(join(checkout, file), content);
  git(["add", file], checkout);
  git(["commit", "-m", `add ${file}`], checkout);
  return git(["rev-parse", "HEAD"], checkout);
}

/**
 * 种转录。where：缺省 = runs/ 平铺；{ bucket: "slug" } = runs/projects/<slug>/；
 * { archiveMonth: "yyyy-mm" } = dirname(runDir)/runs-archive/<yyyy-mm>/。
 * 事件逐条注 ts/seq/runId/agentId（事件自带 ts 优先——recent 断言用）。
 */
export function seedTranscript(runDir, runId, events, where = {}) {
  let dir = runDir;
  if (where.bucket) dir = join(runDir, "projects", where.bucket);
  if (where.archiveMonth) dir = join(dirname(String(runDir).replace(/[\\/]+$/, "")), "runs-archive", where.archiveMonth);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${runId}.jsonl`);
  writeFileSync(filePath, events.map((e, i) => JSON.stringify({
    ts: OLD_TS,
    seq: i + 1,
    runId,
    agentId: "coder_hq",
    ...e,
  })).join("\n") + "\n", "utf8");
  return filePath;
}

/** 终态干净 run 的事件（无交付）。 */
export function cleanRunEvents({ repo, wt, branch }) {
  return [
    { type: "run.started", backend: "test", cwd: repo, worktreePath: wt, worktreeBranch: branch },
    { type: "run.state_change", from: null, to: "pending", reason: "created" },
    { type: "run.state_change", from: "pending", to: "running", reason: "spawned" },
    { type: "run.state_change", from: "running", to: "completed", reason: "done" },
  ];
}

/** 已裁决（decision = accepted|rejected）的交付 run 事件。 */
export function decidedRunEvents({ repo, wt, branch, baseCommit, decision }) {
  return [
    {
      type: "run.started",
      backend: "test",
      cwd: repo,
      worktreePath: wt,
      worktreeBranch: branch,
      delivery: { mode: "git_commit_v1", baseCommit },
    },
    { type: "run.state_change", from: null, to: "running", reason: "spawned" },
    { type: "run.delivery_created" },
    { type: decision === "accepted" ? "run.delivery_accepted" : "run.delivery_rejected" },
    { type: "run.state_change", from: "running", to: "completed", reason: "done" },
  ];
}

/** 复用线系成员事件（bound session_reuse rootRunId，与根共享同一棵树）。 */
export function memberRunEvents({ repo, wt, branch, rootRunId, terminal = true }) {
  const events = [
    { type: "run.session_reuse", rootRunId },
    {
      type: "run.started",
      backend: "test",
      cwd: repo,
      worktreePath: wt,
      worktreeBranch: branch,
    },
    { type: "run.state_change", from: null, to: "running", reason: "spawned" },
  ];
  if (terminal) events.push({ type: "run.state_change", from: "running", to: "completed", reason: "done" });
  return events;
}

/** best-effort 清理临时目录（Windows 文件锁下有界重试）。 */
export async function cleanupDir(dir) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 60 * (attempt + 1)));
    }
  }
}
