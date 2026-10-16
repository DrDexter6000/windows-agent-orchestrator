// test/_gitRepoFixture.mjs
//
// git 测试夹具共用底座：进程内缓存的只读母仓 + 整仓 cpSync 复制。
// 一个测试文件里几十个场景各自 git init/config/add/commit 的固定链，换成
// 每键只建一次母仓、每场景复制一份（复制件与固定链产物同形：同默认分支、
// 同初始提交、同配置）。母仓只读不改；复制件归场景私有，可任意改动。
// 全部路径都在 os.tmpdir() 下。

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  }).trim();
}

/** git init + 测试身份配置（与各文件原固定链一致）。initArgs 追加到 init。 */
export function initGitRepo(dir, initArgs = []) {
  git(["init", "-b", "main", ...initArgs], dir);
  git(["config", "user.email", "test@test"], dir);
  git(["config", "user.name", "test"], dir);
}

const cache = new Map();
const baseDirs = new Set();

/**
 * 按键缓存一个只读母仓。build(dir) 负责 init 链之后的落盘与初始提交，
 * 返回值随缓存一并持有（如 baseCommit）。并发调用同一键只会构建一次。
 */
export async function baseRepoFixture(key, build, { initArgs = [] } = {}) {
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      const dir = mkdtempSync(join(tmpdir(), `wao-base-${key}-`));
      baseDirs.add(dir);
      initGitRepo(dir, initArgs);
      const value = await build(dir);
      return { dir, value };
    })());
  }
  return cache.get(key);
}

/** 复制母仓为一个新的场景私有仓（含 .git；tmpdir 下独立目录）。 */
export function copyGitRepo(baseDir, prefix) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  cpSync(baseDir, repo, { recursive: true });
  return repo;
}

process.on("exit", () => {
  for (const dir of baseDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
