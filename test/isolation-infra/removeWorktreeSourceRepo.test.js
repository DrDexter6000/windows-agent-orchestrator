// test/isolation-infra/removeWorktreeSourceRepo.test.js
//
// removeWorktree 的执行位置与登记清理契约：git worktree remove 在源仓库（从
// 目标树自己的 git 元数据推出）执行；树目录删掉后只**定向删本树自己的管理
// 条目**，不做仓库级 prune（与并发 `worktree add` 有 --expire 关不掉的竞争）。
//
// 先实测钉住两个前提（Windows + git 2.50 实测，本文件把它们作为可回归的
// 事实保留）：
//   P1  git worktree remove --force 以待删目录为 cwd 时自身删除失败（目录是
//       子进程自己的 cwd，Windows 锁死）→ 旧实现必然退回 rmSync 兜底；
//   P2  目录已删除后以待删目录为 cwd 连 spawn 都起不来（ENOENT）→ 旧实现的
//       prune 是死代码，登记残留（含其他树的 stale 登记）永远清不掉。
// 在 P1/P2 成立的机器上，修复后的契约是：
//   C1  removeWorktree 后目录消失、本树登记消失（git 自己的删除直接成功，
//       不再依赖 rmSync 兜底——不掺重试退避的快路径）；
//   C2  不做仓库级 prune：其他目录已缺失的 stale 登记原样保留（留给 serve
//       维护 / runs verify-commit 的通用清扫）；本树登记在 rmSync 兜底后由
//       定向清理（removeWorktreeAdminEntry）清除，别的条目（含模拟进行中
//       add 的裸条目）不被波及。
// 全部用真 git 临时仓（os.tmpdir() 下），从不触碰真实仓库。

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { removeWorktree, removeWorktreeAdminEntry } from "../../src/isolation.js";

const bases = [];
after(async () => {
  for (const b of bases) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        rmSync(b, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 60 * (attempt + 1)));
      }
    }
  }
});

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  }).trim();
}

async function makeRepo(prefix = "wao-rm-src-") {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  bases.push(repo);
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "t@t"], repo);
  git(["config", "user.name", "t"], repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(["add", "."], repo);
  git(["commit", "-m", "init"], repo);
  return repo;
}

function worktree(repo, runId) {
  const wt = join(repo, ".wao-worktrees", runId);
  git(["worktree", "add", wt, "-b", `wao/${runId}`], repo);
  return wt;
}

/** 登记面：.git/worktrees/<id> 目录名集合（git worktree list 会顺手 prune，
 * 不能用作残留证据——admin 目录才是。）。 */
function registeredAdminIds(repo) {
  const dir = join(repo, ".git", "worktrees");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => !n.startsWith("."));
}

test("P1：git worktree remove 以待删目录为 cwd 在 Windows 自身删除失败", async () => {
  const repo = await makeRepo();
  const wt = worktree(repo, "run_p1");
  let failed = false;
  try {
    execFileSync("git", ["worktree", "remove", "--force", wt], {
      cwd: wt,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    failed = true;
  }
  // 前提钉：失败 == 旧实现每次都走 rmSync 兜底。若未来 git 修好 cwd 锁，
  // 本断言变红——届时 C1/C2 仍应绿（修复不依赖前提，只是前提失效）。
  assert.ok(failed, "git worktree remove (cwd=待删目录) 应失败——否则 P1 前提漂移，需重审");
  assert.ok(existsSync(wt), "失败的 git 尝试后目录应仍在");
});

test("P2：目录已删除后以待删目录为 cwd 的 git 无法 spawn（旧 prune 是死代码）", async () => {
  const repo = await makeRepo();
  const wt = worktree(repo, "run_p2");
  rmSync(wt, { recursive: true, force: true });
  assert.ok(!existsSync(wt));
  let spawnFailed = false;
  try {
    execFileSync("git", ["worktree", "prune"], {
      cwd: wt,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    spawnFailed = true;
  }
  assert.ok(spawnFailed, "cwd=已删目录的 git 应 ENOENT——旧实现的 prune 从未生效");
  assert.ok(registeredAdminIds(repo).includes("run_p2"), "残留登记应在（证明 P2 的后果）");
});

test("C1：removeWorktree 在源仓库执行——目录删净、本树登记清（不做仓库级 prune）", async () => {
  const repo = await makeRepo();
  const wt = worktree(repo, "run_c1");
  // 预置另一个 stale 登记：目录直接 rmSync（不经 git），admin 残留。
  const stale = worktree(repo, "run_stale");
  rmSync(stale, { recursive: true, force: true });
  assert.ok(registeredAdminIds(repo).includes("run_stale"), "前置：stale 登记存在");

  await removeWorktree(wt);

  assert.ok(!existsSync(wt), "目标树目录应删除");
  const admins = registeredAdminIds(repo);
  assert.ok(!admins.includes("run_c1"), "本树登记应清除");
  // 不再做仓库级 prune（与并发 worktree add 的竞争关不掉）：其他树的 stale
  // 登记原样保留，留给 serve 维护 / runs verify-commit 的通用清扫。
  assert.ok(admins.includes("run_stale"), "其他树的 stale 登记应原样保留（无仓库级 prune）");
});

test("兜底路径：git remove 失败退回 rmSync——只删本树管理条目，别的条目不被波及", async () => {
  const repo = await makeRepo();
  const wt = worktree(repo, "run_fb");
  // 模拟另一会话 `git worktree add` 在建管理目录与写 locked 之间的登记形态：
  // admin 目录既没有 locked、也没有 gitdir——仓库级 prune 对这种条目无条件
  // 清掉，--expire 管不到；定向清理按 gitdir 内容核对归属，永不波及它。
  const midAdd = join(repo, ".git", "worktrees", "run_adding_now");
  mkdirSync(midAdd, { recursive: true });
  // 再预置一个 stale 登记（目录外部删掉、admin 残留）。
  const stale = worktree(repo, "run_fb_stale");
  rmSync(stale, { recursive: true, force: true });
  assert.ok(registeredAdminIds(repo).includes("run_adding_now"), "前置：进行中 add 条目存在");
  assert.ok(registeredAdminIds(repo).includes("run_fb_stale"), "前置：stale 登记存在");

  // execFn 缝：只让 `git worktree remove` 失败（源仓库自推走真实 git），强退
  // rmSync 兜底——确定性注入，代替独占文件锁。
  const realExec = execFileSync;
  await removeWorktree(wt, {
    execFn: (file, args, opts) => {
      if (args[0] === "worktree" && args[1] === "remove") throw new Error("injected remove failure");
      return realExec(file, args, opts);
    },
  });

  assert.ok(!existsSync(wt), "兜底 rmSync 应删掉目录");
  const admins = registeredAdminIds(repo);
  assert.ok(!admins.includes("run_fb"), "本树登记应被定向清理清除（gitdir 内容核对归属）");
  assert.ok(admins.includes("run_adding_now"), "进行中 add 的裸条目必须原样保留");
  assert.ok(admins.includes("run_fb_stale"), "其他树的 stale 登记必须原样保留");
});

test("removeWorktreeAdminEntry 归属核对：树在不动；树不在且 gitdir 吻合才删；指向别处不删", async () => {
  const repo = await makeRepo();
  const commonDir = join(repo, ".git");
  const kept = worktree(repo, "run_ae_kept");
  // 树还在（活的登记）：返回 false、条目不动。
  assert.equal(removeWorktreeAdminEntry(commonDir, kept), false);
  assert.ok(registeredAdminIds(repo).includes("run_ae_kept"));

  // 树删掉（外部 rmSync）：gitdir 内容指向它 → 定向删除，返回 true。
  const gone = worktree(repo, "run_ae_gone");
  rmSync(gone, { recursive: true, force: true });
  assert.equal(removeWorktreeAdminEntry(commonDir, gone), true);
  assert.ok(!registeredAdminIds(repo).includes("run_ae_gone"));

  // gitdir 指向别处的条目（同名但不同树）：指向不吻合 → 不删。
  const other = worktree(repo, "run_ae_other");
  assert.equal(removeWorktreeAdminEntry(commonDir, `${gone}-lookalike`), false);
  assert.ok(registeredAdminIds(repo).includes("run_ae_other"));
});

test("幂等：路径不存在时直接 resolve，无副作用", async () => {
  const repo = await makeRepo();
  await removeWorktree(join(repo, ".wao-worktrees", "run_never"));
  assert.ok(existsSync(repo));
});

test("源仓库自推不依赖调用方：从任意 cwd 调 removeWorktree 仍清理干净", async () => {
  const repo = await makeRepo();
  const wt = worktree(repo, "run_any");
  // 传入的路径与执行 cwd 无关（源仓库从树自己的 git 元数据推出）。
  const oldCwd = process.cwd();
  try {
    process.chdir(tmpdir());
    await removeWorktree(wt);
  } finally {
    process.chdir(oldCwd);
  }
  assert.ok(!existsSync(wt));
  assert.ok(!registeredAdminIds(repo).includes("run_any"));
});

// mkdirSync 复用占位（保持导入形状稳定）。
void mkdirSync;
