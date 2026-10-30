// test/isolation-infra/projectIdentityLinkedWorktreeGit.test.js
//
// 决定 0099（R8）真实 git 冒烟：os.tmpdir() 下 mkdtemp 建夹具、结构化 argv 调
// git、user.name/user.email 夹具仓内本地配置、finally 清理。io 用
// { ...productionProjectIo(), tmpdir: "" } 绕开 R5（夹具在临时目录下）。
// 注入面的形状矩阵（相对/绝对/CRLF/junction/坏形状）在
// projectIdentityLinkedWorktree.test.js；这里只验"真 git 写出来的东西"。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identifyProjectFromCwd, projectFactFromCwd, productionProjectIo } from "../../src/projectIdentity.js";

function gitOf(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: "2005-04-07T22:13:13", GIT_COMMITTER_DATE: "2005-04-07T22:13:13" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

/** 主检出仓（main 分支，一次提交）。 */
function makeRepo(dir) {
  mkdirSync(dir, { recursive: true });
  gitOf(dir, ["init", "-b", "main"]);
  gitOf(dir, ["config", "user.email", "t@t.c"]);
  gitOf(dir, ["config", "user.name", "T"]);
  writeFileSync(join(dir, "README.md"), "# base\n", "utf8");
  gitOf(dir, ["add", "README.md"]);
  gitOf(dir, ["commit", "-m", "base"]);
  return dir;
}

const fwd = (p) => p.replace(/\\/g, "/");
const IO = () => ({ ...productionProjectIo(), tmpdir: "" });
const identify = (p, io = IO()) => identifyProjectFromCwd(fwd(p), io);
const identifyNoR8 = (p) => identifyProjectFromCwd(fwd(p), { ...IO(), readGitFile: undefined });

function gitVersion() {
  const m = gitOf(process.cwd(), ["--version"]).match(/(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

test("0099 R8 真git: git worktree add → 主项目（与主检出同 key 同 bucket）", () => {
  const root = mkdtempSync(join(tmpdir(), "wao-r8g-"));
  try {
    const main = makeRepo(join(root, "proj"));
    const wt = join(root, "proj-wt");
    gitOf(root, ["-C", main, "worktree", "add", wt]);
    const wtId = identify(wt);
    const mainId = identify(main);
    assert.equal(wtId.kind, "project");
    assert.deepEqual(wtId, mainId, "链接工作树身份=主检出身份（key+displayName 同源）");
    assert.equal(projectFactFromCwd(fwd(wt), IO()).bucket, projectFactFromCwd(fwd(main), IO()).bucket);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0099 R8 真git: worktree add --relative-paths → 主项目（不支持时跳过并说明）", { skip: (() => {
  const [maj, min] = gitVersion();
  return (maj * 100 + min) < 248 ? `git ${maj}.${min} < 2.48（--relative-paths 未引入）` : false;
})() }, () => {
  const root = mkdtempSync(join(tmpdir(), "wao-r8gr-"));
  try {
    const main = makeRepo(join(root, "proj"));
    const wt = join(root, "proj-wt-rel");
    gitOf(root, ["-C", main, "worktree", "add", "--relative-paths", wt]);
    assert.deepEqual(identify(wt), identify(main), "相对 gitdir 写法同归主项目");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0099 R8 真git: 裸仓库 x.git 加工作树 → 照旧（工作树自身项目）", () => {
  const root = mkdtempSync(join(tmpdir(), "wao-r8gb-"));
  try {
    const seed = makeRepo(join(root, "seed"));
    const bare = join(root, "stores", "proj.git");
    mkdirSync(join(root, "stores"), { recursive: true });
    gitOf(root, ["clone", "--bare", fwd(seed), bare]);
    const wt = join(root, "proj-wt-bare");
    gitOf(root, ["-C", bare, "worktree", "add", wt]);
    assert.deepEqual(identify(wt), identifyNoR8(wt), "共同目录叫 proj.git（非 .git）→ 与不加 R8 相同");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0099 R8 真git: git clone --bare 到 proj/.git 再加工作树 → proj", () => {
  const root = mkdtempSync(join(tmpdir(), "wao-r8gd-"));
  try {
    const seed = makeRepo(join(root, "seed"));
    const proj = join(root, "stores", "proj"); // 裸仓落在 proj/.git
    mkdirSync(proj, { recursive: true });
    gitOf(root, ["clone", "--bare", fwd(seed), join(proj, ".git")]);
    const wt = join(root, "proj-wt-baregit");
    gitOf(root, ["-C", proj, "worktree", "add", wt]);
    const id = identify(wt);
    assert.equal(id.kind, "project");
    assert.equal(id.displayName, "proj", "主工作树=共同目录的父目录");
    assert.deepEqual(id, identify(proj), "与 proj 主检出的身份一致（git worktree list 第一行同源）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0099 R8 真git: git init --separate-git-dir（非 .git 名）主检出与链接工作树都照旧", () => {
  const root = mkdtempSync(join(tmpdir(), "wao-r8gs-"));
  try {
    const mainWt = join(root, "main-wt");
    const sgd = join(root, "sgd");
    gitOf(root, ["init", "--separate-git-dir", sgd, mainWt]);
    gitOf(mainWt, ["config", "user.email", "t@t.c"]);
    gitOf(mainWt, ["config", "user.name", "T"]);
    writeFileSync(join(mainWt, "README.md"), "# base\n", "utf8");
    gitOf(mainWt, ["add", "README.md"]);
    gitOf(mainWt, ["commit", "-m", "base"]);
    // 主检出：.git 文件 → sgd，sgd 无 commondir → 照旧
    assert.deepEqual(identify(mainWt), identifyNoR8(mainWt), "主检出照旧");
    // 链接工作树：commondir → sgd（basename 非 .git）→ 照旧
    const wt = join(root, "sgd-wt");
    gitOf(root, ["-C", mainWt, "worktree", "add", wt]);
    assert.deepEqual(identify(wt), identifyNoR8(wt), "sgd 名字不是 .git → 照旧");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0099 R8 真git: 子模块与其链接工作树 → 照旧", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wao-r8gm-"));
  try {
    let sub;
    let subWt;
    try {
      const upstream = makeRepo(join(root, "upstream"));
      const sup = makeRepo(join(root, "sup"));
      gitOf(sup, ["-c", "protocol.file.allow=always", "submodule", "add", fwd(upstream), "sub"]);
      gitOf(sup, ["commit", "-m", "add submodule"]);
      // 子模块检出本身：.git 文件 → <sup>/.git/modules/sub（自含，无 commondir 或不叫 .git）
      sub = join(sup, "sub");
      // 子模块自己的链接工作树：commondir → .../.git/modules/sub（basename=sub）→ 照旧
      subWt = join(root, "sub-wt");
      gitOf(sub, ["worktree", "add", subWt]);
    } catch (error) {
      // 只兜夹具构建失败，且记成 skip（不当作通过）；断言失败必须红（同形状的
      // 注入面用例在 projectIdentityLinkedWorktree.test.js 第 6 组）
      t.skip(`子模块夹具在本机构建失败：${error?.message ?? error}`);
      return;
    }
    assert.deepEqual(identify(sub), identifyNoR8(sub), "子模块检出照旧");
    assert.deepEqual(identify(subWt), identifyNoR8(subWt), "子模块链接工作树照旧");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0099 R8 真git: worktree prune 删了 admin 目录、树目录还在 → 照旧", () => {
  const root = mkdtempSync(join(tmpdir(), "wao-r8gp-"));
  try {
    const main = makeRepo(join(root, "proj"));
    const wt = join(root, "proj-wt-p");
    const stash = join(root, "stash");
    gitOf(root, ["-C", main, "worktree", "add", wt]);
    renameSync(wt, stash); // 树挪走 → prune 认它没了
    gitOf(main, ["worktree", "prune"]);
    renameSync(stash, wt); // 树挪回来：目录在、admin 目录没了
    assert.deepEqual(identify(wt), identifyNoR8(wt), "gitdir 死链（realpath 失败）→ 照旧");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
