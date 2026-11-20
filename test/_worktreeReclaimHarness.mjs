// test/_worktreeReclaimHarness.mjs
//
// worktree reclaim 测试共用构造器：真 git 临时仓 + 转录种子 + 事件构造。
// 一切都在 os.tmpdir() 下（静态 runs/ 守卫的合法形态），从不指向仓库相对
// runs/。

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { baseRepoFixture, copyGitRepo } from "./_gitRepoFixture.mjs";

/** 远旧于任何新鲜阈的事件时间戳。 */
export const OLD_TS = "2026-01-01T00:00:00.000Z";

/** 固定时钟（计划生成与 apply 用；进程启动时刻 + 60 s 的常量，recent 断言两边一致）。
 * 每个测试进程只取一次真实时钟：每次调用都重读时，写心跳与 apply 判新鲜（阈 10 s）之间机器一慢
 * 就超过阈值，"有新鲜心跳 → 跳过"一类断言随之失败。 */
const FIXED_NOW = Date.now() + 60_000;
export function fixedNow() {
  return FIXED_NOW;
}

// makeRepo 复制出的场景仓由本模块登记、进程退出时删除（与 _gitRepoFixture 删母仓
// 同一做法）——调用方（含直接调 makeRepo 造外来仓的场景）不必各自清理。
const createdRepos = new Set();
process.on("exit", () => {
  for (const dir of createdRepos) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

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
  // 只读母仓按 .gitignore 形态缓存一份，场景各取一份整仓复制件（与
  // init/config/add/commit 固定链产物同形）。
  const base = await baseRepoFixture(
    ignoreWaoWorktrees ? "reclaim-wt-ignored" : "reclaim-wt-bare",
    async (dir) => {
      await mkdir(join(dir, "docs"), { recursive: true });
      writeFileSync(join(dir, "a.txt"), "const a = 1;\n");
      writeFileSync(join(dir, ".gitignore"), ignoreWaoWorktrees
        ? "node_modules/\n.wao-worktrees/\n"
        : "node_modules/\n");
      git(["add", "."], dir);
      git(["commit", "-m", "init"], dir);
      return git(["rev-parse", "HEAD"], dir);
    },
  );
  const repo = copyGitRepo(base.dir, prefix);
  createdRepos.add(repo);
  return { repo, mainCommit: base.value };
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

/**
 * 已裁决（decision = accepted|rejected）的交付 run 事件。
 * 第 120 批续修第 2 轮（G3）：计划分类与执行放行都用"合法裁决"——采纳必须过
 * `validateDeliveryFacts`，所以这里给出完整的合法交付链（created + 验证 passed +
 * 决策同形 ref）。runId 从 `wao/<runId>` 分支名取（这些夹具的分支名就是 runId），
 * 也可显式传 `runId`；取不到时退回旧的裸事件形状（只用于变异/反例夹具）。
 */
export function decidedRunEvents({ repo, wt, branch, baseCommit, decision, runId = null }) {
  const started = {
    type: "run.started",
    backend: "test",
    cwd: repo,
    worktreePath: wt,
    worktreeBranch: branch,
    delivery: { mode: "git_commit_v1", baseCommit },
  };
  const running = { type: "run.state_change", from: null, to: "running", reason: "spawned" };
  const completed = { type: "run.state_change", from: "running", to: "completed", reason: "done" };
  const resolvedRunId = runId
    ?? (typeof branch === "string" && branch.startsWith("wao/") ? branch.slice("wao/".length) : null);
  if (resolvedRunId === null) {
    return [
      started,
      running,
      { type: "run.delivery_created" },
      { type: decision === "accepted" ? "run.delivery_accepted" : "run.delivery_rejected" },
      completed,
    ];
  }
  const verified = verifiedDeliveryRef(resolvedRunId, { baseCommit });
  const decided = verifiedDeliveryRef(resolvedRunId, { baseCommit, acceptance: decision });
  return [
    started,
    running,
    { type: "run.delivery_created", delivery: verified },
    { type: "run.delivery_verification_passed", delivery: verified },
    {
      type: `run.delivery_${decision}`,
      delivery: decided,
      deliveryCommit: verified.deliveryCommit,
      reason: "decision",
    },
    completed,
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

// ── 第 120 批：续修谱系的合法交付链（被取代派生要 validateDeliveryFacts 通过）──

const DELIVERY_COMMIT = "d".repeat(40);

/** 已验证的 DeliveryRef（created / outcome / decision 三处同形——绑定口径）。
 * verificationStatus 供"验证仍 pending（未收口）"的反例夹具用。 */
export function verifiedDeliveryRef(runId, { baseCommit, acceptance = "pending", verificationStatus = "passed" } = {}) {
  return {
    schemaVersion: 1,
    kind: "git_commit",
    runId,
    baseCommit,
    deliveryCommit: DELIVERY_COMMIT,
    branch: `wao/${runId}`,
    worktreePath: `D:/fake/${runId}`,
    changedFiles: ["a.txt"],
    verification: { status: verificationStatus, commands: [], verifiedCommit: DELIVERY_COMMIT, results: [] },
    acceptance: { status: acceptance, reviewerType: "lead_agent" },
    integration: { status: "pending", targetCommit: null },
  };
}

/** 已打包 + 验证 passed 的交付链事件（尚未裁决）。 */
export function packagedDeliveryEvents(runId, { baseCommit } = {}) {
  const delivery = verifiedDeliveryRef(runId, { baseCommit });
  return [
    { type: "run.delivery_created", delivery },
    { type: "run.delivery_verification_passed", delivery },
  ];
}

/** 合法采纳决策事件（与 created/outcome 同一 ref 形状）。 */
export function acceptedDecisionEvent(runId, { baseCommit } = {}) {
  const delivery = verifiedDeliveryRef(runId, { baseCommit, acceptance: "accepted" });
  return {
    type: "run.delivery_accepted",
    delivery,
    deliveryCommit: delivery.deliveryCommit,
    reason: "ok",
  };
}

/**
 * 续修谱系根：首事件 run.session_reuse（turn:first，rootRunId = 自己），随后
 * 终态 + 已打包交付链（decision 可选）。
 */
export function lineageRootRunEvents({
  runId, repo, wt = null, branch = null, baseCommit, decision = null,
}) {
  return [
    { type: "run.session_reuse", mode: "run_lineage", turn: "first", rootRunId: runId },
    {
      type: "run.started",
      backend: "test",
      cwd: repo,
      worktreePath: wt,
      worktreeBranch: branch,
      delivery: { mode: "git_commit_v1", baseCommit },
    },
    { type: "run.state_change", from: null, to: "running", reason: "spawned" },
    { type: "run.state_change", from: "running", to: "completed", reason: "done" },
    ...packagedDeliveryEvents(runId, { baseCommit }),
    ...(decision === "accepted" ? [acceptedDecisionEvent(runId, { baseCommit })] : []),
  ];
}

/**
 * 续修子运行：首事件必须是 runId 绑定的 run.background_submitted
 * （continuation:true + parentRunId），随后 run.session_reuse（turn:resume）。
 */
export function lineageChildRunEvents({
  runId, parentRunId, rootRunId, repo, wt = null, branch = null, baseCommit, decision = null,
}) {
  return [
    { type: "run.background_submitted", continuation: true, parentRunId, rootRunId },
    { type: "run.session_reuse", mode: "run_lineage", turn: "resume", rootRunId },
    {
      type: "run.started",
      backend: "test",
      cwd: repo,
      worktreePath: wt,
      worktreeBranch: branch,
      delivery: { mode: "git_commit_v1", baseCommit },
    },
    { type: "run.state_change", from: null, to: "running", reason: "spawned" },
    { type: "run.state_change", from: "running", to: "completed", reason: "done" },
    ...packagedDeliveryEvents(runId, { baseCommit }),
    ...(decision === "accepted" ? [acceptedDecisionEvent(runId, { baseCommit })] : []),
  ];
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
