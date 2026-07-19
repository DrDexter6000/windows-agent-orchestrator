import { execSync, execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { isValidRunId } from "./delivery.js";
import { ensureWaoWorktreeExclude } from "./gitLocalExclude.js";

/**
 * Worktree 隔离能力层（M3-1）。
 *
 * 提供统一的 git worktree 创建/删除/列举，供 RunManager 调用。
 * 不决定"要不要隔离"（那是 RunManager 读 agent 配置的事）。
 *
 * worktree 放在 <sourceCwd>/.wao-worktrees/<name>。
 * 用 execFileSync 调 git（结构化参数，不拼 shell 字符串）。
 *
 * M11-1B (reframed)：createWorktree 流程为短事务设计——
 *   1. 校验 runId / repo（worktree authority 由 isolation.js 保有）；
 *   2. await ensureWaoWorktreeExclude(cwd)：在 exclude 专用跨进程锁内
 *      完成 read/normalize/atomic-write/read-back verify，锁立即释放；
 *   3. 锁释放后才执行 `git worktree add`（不持 exclude 锁）。
 * `/.wao-worktrees/` 是稳定 repository-local hygiene rule（spec §4.3）：
 * worktree 删除后仍保留；`git worktree add` 失败时不回滚该规则——规则
 * 只在 exclude ensure 自身失败时回滚到 locked-time bytes。
 */

/**
 * 创建一个独立 worktree。
 * @param {string} sourceCwd 源仓库（主工作树）路径
 * @param {string} name worktree 名称（用作目录名 + 分支名）
 * @returns {Promise<{path: string, branch: string}>}
 */
export async function createWorktree(sourceCwd, name) {
  if (!isValidRunId(name)) {
    throw new Error(`Invalid worktree name (contains path separators, shell metacharacters, or traversal): ${JSON.stringify(name)}`);
  }
  const cwd = resolve(sourceCwd);
  if (!isGitRepo(cwd)) {
    throw new Error(`${cwd} is not a git repository (worktree requires git)`);
  }
  // 1. Ensure the stable exclude rule under the short exclude lock, then
  //    release the lock. The rule is NOT rolled back if step 2 fails.
  await ensureWaoWorktreeExclude(cwd);
  // 2. git worktree add WITHOUT holding the exclude lock. structured args —
  //    no shell-built command string.
  const wtPath = join(cwd, ".wao-worktrees", name);
  const branch = `wao/${name}`;
  execFileSync("git", ["worktree", "add", wtPath, "-b", branch], {
    cwd,
    stdio: "pipe",
    windowsHide: true,
  });
  return { path: wtPath, branch };
}

/**
 * 删除 worktree（含目录）。
 * @param {string} wtPath worktree 路径
 *
 * Windows 上 git worktree remove 偶尔因文件锁 Permission denied（进程持有句柄）。
 * 解法：先试 git worktree remove，失败则 fallback 到 rmSync 强制删目录 +
 * git worktree prune 清理元数据。
 */
export function removeWorktree(wtPath) {
  const path = resolve(wtPath);
  if (!existsSync(path)) return Promise.resolve();
  // TD-21：git worktree remove / rmSync 在 Windows 偶发 Permission denied（文件句柄延迟释放，
  // 测试偶发 ~1%）。原实现单次失败即放弃。现改为最多 3 次重试 + 退避延迟，提高成功率。
  // 重试内层：先试 git worktree remove，失败则 rmSync 强删 + prune。
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 100;
  let attempt = 0;
  let removed = false;
  while (attempt < MAX_RETRIES && !removed) {
    attempt += 1;
    try {
      execFileSync("git", ["worktree", "remove", "--force", path], {
        cwd: path,
        stdio: "pipe",
        windowsHide: true,
      });
      removed = true;
    } catch {
      // fallback：强制删目录 + prune 元数据
      try {
        rmSync(path, { recursive: true, force: true });
        removed = !existsSync(path);
      } catch { /* 尽力，下次重试 */ }
      try {
        execSync("git worktree prune", { cwd: path, stdio: "pipe", windowsHide: true });
      } catch { /* prune 失败不阻塞 */ }
    }
    // 仍未删除且还有重试机会 → 退避等待（同步 sleep，worktree 删除非热路径，可接受）
    if (!removed && attempt < MAX_RETRIES) {
      const end = Date.now() + RETRY_DELAY_MS * attempt; // 线性退避 100/200ms
      while (Date.now() < end) { /* busy wait */ }
    }
  }
  return Promise.resolve();
}

/**
 * 列出所有 worktree。
 * @param {string} cwd 仓库路径
 * @returns {Promise<Array<{path: string, branch?: string, head?: string}>>}
 */
export function listWorktrees(cwd) {
  const out = execSync("git worktree list --porcelain", {
    cwd: resolve(cwd),
    encoding: "utf8",
    windowsHide: true,
  });
  return Promise.resolve(parseWorktreeList(out));
}

function parseWorktreeList(porcelain) {
  const entries = [];
  let current = null;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length).trim() };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim();
    } else if (line.trim() === "") {
      if (current) {
        entries.push(current);
        current = null;
      }
    }
  }
  if (current) entries.push(current);
  return entries;
}

function isGitRepo(cwd) {
  try {
    execSync("git rev-parse --git-dir", {
      cwd,
      stdio: "pipe",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}
