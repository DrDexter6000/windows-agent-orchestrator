// test/isolation-infra/removeWorktreeSourceRepo.test.js
//
// removeWorktree 的执行位置与登记清理契约：删树不经 git（见下），树目录删掉后
// 只**定向删本树自己的管理条目**，不做仓库级 prune（与并发 `worktree add` 有
// --expire 关不掉的竞争）；源仓库从目标树自己的 git 元数据推出。
//
// 第 150 批修正一：removeWorktree 不再调用 `git worktree remove --force`。Windows
// 上 git 删树会跟进树里的 junction，把目标目录（树外！）里的文件一并删掉
//（git 2.50.1.windows.1 实测）。删树主路径改为 fs.rmSync（Node 22 对 junction、
// 目录符号链接、文件符号链接都不跟进）+ 定向清理本树管理条目；归属、上锁、主检出
// 检查照旧。本文件的"真删"用例直接跑真实删除，不用注入失败代替删除。
//
// 先实测钉住两个前提（Windows + git 2.50 实测，本文件把它们作为可回归的
// 事实保留）：
//   P1  git worktree remove --force 以待删目录为 cwd 时自身删除失败（目录是
//       子进程自己的 cwd，Windows 锁死）；
//   P2  目录已删除后以待删目录为 cwd 连 spawn 都起不来（ENOENT）→ 旧实现的
//       prune 是死代码，登记残留（含其他树的 stale 登记）永远清不掉。
// 契约：
//   C1  removeWorktree 后目录消失、本树登记消失；
//   C2  不做仓库级 prune：其他目录已缺失的 stale 登记原样保留（留给 serve
//       维护 / runs verify-commit 的通用清扫）；本树登记由定向清理
//       （removeWorktreeAdminEntry）清除，别的条目（含模拟进行中 add 的裸条目）
//       不被波及；
//   C3  树里的 junction / 目录符号链接 / 文件符号链接都不被跟进：删后树外的目录
//       与文件原样（真删用例）。
// 全部用真 git 临时仓（os.tmpdir() 下），从不触碰真实仓库。

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { execFileSync, spawn } from "node:child_process";

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

test("rmSync 主路径：只删本树管理条目，别的条目不被波及", async () => {
  // 原名"兜底路径：git remove 失败退回 rmSync"：第 150 批起删树不再经 git，rmSync 就是
  // 主路径，原先靠 execFn 缝注入"git remove 失败"来走兜底的写法已无意义（断言不变）。
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

  await removeWorktree(wt);

  assert.ok(!existsSync(wt), "rmSync 应删掉目录");
  const admins = registeredAdminIds(repo);
  assert.ok(!admins.includes("run_fb"), "本树登记应被定向清理清除（gitdir 内容核对归属）");
  assert.ok(admins.includes("run_adding_now"), "进行中 add 的裸条目必须原样保留");
  assert.ok(admins.includes("run_fb_stale"), "其他树的 stale 登记必须原样保留");
});

// ── C3：真删，不跟进链接（第 150 批修正一）──
// 树里放一个指向树外目录（里面有文件）的链接，真跑 removeWorktree：树删掉、登记清掉，
// 树外的目录与文件原样。junction 是 git 删树会跟进的那一种（旧实现下这条红：树外
// 文件被删）；目录符号链接与文件符号链接 git 本来就不跟进，一并钉住不退化。
for (const kind of ["junction", "dir", "file"]) {
  test(`C3：removeWorktree 真删带 ${kind} 链接的树——树与登记删净，树外目录和文件原样`, async (t) => {
    const repo = await makeRepo();
    const runId = `run_c3_${kind}`;
    const wt = worktree(repo, runId);
    const outside = mkdtempSync(join(tmpdir(), "wao-rm-outside-"));
    bases.push(outside);
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "OUTSIDE-SECRET\n");
    try {
      if (kind === "file") symlinkSync(secret, join(wt, "link.txt"), "file");
      else symlinkSync(outside, join(wt, "linkdir"), kind);
    } catch {
      t.skip(`此环境不允许创建 ${kind} 链接，无法构造`);
      return;
    }
    writeFileSync(join(wt, "own.txt"), "tree-own\n");

    await removeWorktree(wt);

    assert.ok(!existsSync(wt), "树目录应删净");
    assert.ok(!registeredAdminIds(repo).includes(runId), "本树登记应清除");
    assert.ok(existsSync(outside), "树外目录还在");
    assert.equal(readFileSync(secret, "utf8"), "OUTSIDE-SECRET\n", "树外文件原样");
  });
}

test("C3：树根自己是链接 → 不动（只 unlink 链接会让调用方误以为树已释放，真树还在目标位置）", async (t) => {
  const repo = await makeRepo();
  const wt = worktree(repo, "run_c3_root");
  const rootLink = join(repo, "root-link");
  try {
    symlinkSync(wt, rootLink, "junction");
  } catch {
    t.skip("此环境不允许创建 junction，无法构造");
    return;
  }
  await removeWorktree(rootLink);
  assert.ok(existsSync(rootLink), "链接原样");
  assert.ok(existsSync(join(wt, "a.txt")), "真树原样");
  assert.ok(registeredAdminIds(repo).includes("run_c3_root"), "登记原样");
});

// ── 第 150 批修正二：相对路径登记、悬空根链接、登记残留如实上报 ──
// `git worktree add --relative-paths`（或 worktree.useRelativePaths=true）建的树，管理条目里的
// gitdir 是相对路径（相对管理条目所在目录）。旧的清理拿绝对路径与这段相对文本直接比，对不上：
// 树删了、登记留着，CLI 还打印 removed。

/** 用 --relative-paths 建的树；git 不支持这个旗标（< 2.48）返回 null。 */
function relativeWorktree(repo, runId) {
  const wt = join(repo, ".wao-worktrees", runId);
  try {
    git(["worktree", "add", "--relative-paths", wt, "-b", `wao/${runId}`], repo);
  } catch {
    return null;
  }
  return wt;
}

test("相对路径登记：removeWorktree 后树与登记都清净，返回 { removed: true, registrationLeft: null }", async (t) => {
  const repo = await makeRepo();
  const wt = relativeWorktree(repo, "run_rel1");
  if (!wt) { t.skip("此 git 不支持 worktree add --relative-paths"); return; }
  const gitdirText = readFileSync(join(repo, ".git", "worktrees", "run_rel1", "gitdir"), "utf8").trim();
  assert.ok(!isAbsolute(gitdirText), `前置：管理条目里的 gitdir 是相对路径：${gitdirText}`);
  const result = await removeWorktree(wt);
  assert.ok(!existsSync(wt), "树目录应删净");
  assert.ok(!registeredAdminIds(repo).includes("run_rel1"), "相对路径登记也要清掉");
  assert.deepEqual(result, { removed: true, registrationLeft: null });
});

test("相对路径登记：removeWorktreeAdminEntry 以管理条目所在目录为基准解析相对 gitdir；指向别处的不删", async (t) => {
  const repo = await makeRepo();
  const commonDir = join(repo, ".git");
  const gone = relativeWorktree(repo, "run_rel_gone");
  if (!gone) { t.skip("此 git 不支持 worktree add --relative-paths"); return; }
  const other = relativeWorktree(repo, "run_rel_other");
  rmSync(gone, { recursive: true, force: true });
  assert.equal(removeWorktreeAdminEntry(commonDir, `${gone}-lookalike`), false, "不吻合的不删");
  assert.equal(removeWorktreeAdminEntry(commonDir, other), false, "树还在：条目是活的，不删");
  assert.equal(removeWorktreeAdminEntry(commonDir, gone), true, "相对 gitdir 解析后吻合，删除");
  const admins = registeredAdminIds(repo);
  assert.ok(!admins.includes("run_rel_gone"));
  assert.ok(admins.includes("run_rel_other"), "别的树的登记原样");
});

test("登记清不掉（Windows：有进程以管理条目目录为 cwd 锁死它）→ removeWorktree 如实报 registrationLeft，不当成功", async (t) => {
  if (process.platform !== "win32") { t.skip("目录被进程 cwd 锁死是 Windows 行为"); return; }
  const repo = await makeRepo();
  const wt = worktree(repo, "run_resid");
  const adminDir = join(repo, ".git", "worktrees", "run_resid");
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: adminDir, stdio: "ignore", windowsHide: true });
  try {
    await new Promise((r) => holder.once("spawn", r));
    const result = await removeWorktree(wt);
    assert.ok(!existsSync(wt), "树本身删净了");
    assert.equal(result.removed, true);
    assert.ok(result.registrationLeft, "管理条目清不掉：如实报残留");
    assert.ok(existsSync(result.registrationLeft), `残留路径指向盘上真实存在的管理目录：${result.registrationLeft}`);
  } finally {
    const exited = new Promise((r) => holder.once("exit", r));
    holder.kill();
    await exited;
  }
});

/** 悬空链接：先建 junction（目标目录存在），再把目标目录删掉。建不出来返回 false。 */
function makeDanglingLink(repo, runId) {
  const link = join(repo, ".wao-worktrees", runId);
  const target = join(repo, `dangling-target-${runId}`);
  mkdirSync(join(repo, ".wao-worktrees"), { recursive: true });
  mkdirSync(target, { recursive: true });
  try {
    symlinkSync(target, link, "junction");
  } catch {
    return null;
  }
  rmdirSync(target);
  return link;
}

test("树根是悬空链接：removeWorktree 不动链接、返回 removed:false（existsSync 看不见悬空链接，不能当成'本来就不在'）", async (t) => {
  const repo = await makeRepo();
  const link = makeDanglingLink(repo, "run_dang1");
  if (!link) { t.skip("此环境不允许创建 junction，无法构造"); return; }
  assert.equal(existsSync(link), false, "前置：existsSync 把悬空链接看成不存在");
  assert.ok(lstatSync(link).isSymbolicLink(), "前置：链接本身在盘上");
  const result = await removeWorktree(link);
  assert.equal(result.removed, false, "链接还在，不算删净");
  assert.ok(lstatSync(link).isSymbolicLink(), "链接原样");
});

test("上锁的树不删：git 拒删后不走 rmSync 兜底，目录、登记与锁原样", async () => {
  const repo = await makeRepo();
  const wt = worktree(repo, "run_locked");
  git(["worktree", "lock", wt], repo);
  const result = await removeWorktree(wt);
  assert.equal(result.removed, false, "没删：如实报告");
  assert.ok(existsSync(join(wt, "a.txt")), "上锁的树目录与文件原样");
  assert.ok(registeredAdminIds(repo).includes("run_locked"), "登记原样");
  assert.ok(existsSync(join(repo, ".git", "worktrees", "run_locked", "locked")), "锁原样");
});

test("git 认不出的不删：.git 指错的上锁树、主检出与普通目录，兜底都不碰", async () => {
  const repo = await makeRepo();
  const wt = worktree(repo, "run_locked_broken");
  git(["worktree", "lock", wt], repo);
  rmSync(join(wt, ".git")); // git 把它设为隐藏文件，Windows 上不能原地覆写
  writeFileSync(join(wt, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "no_such_entry")}\n`);
  const plain = join(repo, "plain-dir");
  mkdirSync(plain);
  writeFileSync(join(plain, "keep.txt"), "keep\n");
  for (const target of [wt, repo, plain]) await removeWorktree(target);
  assert.ok(existsSync(join(wt, "a.txt")), ".git 指错的上锁树原样");
  assert.ok(existsSync(join(repo, ".git", "worktrees", "run_locked_broken", "locked")), "锁原样");
  assert.ok(existsSync(join(repo, "a.txt")), "主检出原样");
  assert.ok(existsSync(join(plain, "keep.txt")), "普通目录原样");
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
