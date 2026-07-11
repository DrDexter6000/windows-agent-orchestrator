import { execSync, execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { existsSync, rmSync } from "node:fs";

/**
 * Worktree 隔离能力层（M3-1）。
 *
 * 提供统一的 git worktree 创建/删除/列举，供 RunManager 调用。
 * 不决定"要不要隔离"（那是 RunManager 读 agent 配置的事）。
 *
 * worktree 放在 <sourceCwd>/.wao-worktrees/<name>。
 * 用 execFileSync 调 git（结构化参数，不拼 shell 字符串）。
 */

/**
 * 防御性 name 校验——防止 worktree name 进入路径/分支/shell 时注入。
 * 与 delivery.js 的 isValidRunId SSOT 一致（但不反向依赖 delivery 模块）。
 * @param {string} name
 * @returns {boolean}
 */
function isValidWorktreeName(name) {
  if (typeof name !== "string" || name.length === 0) return false;
  if (/[\\/]/.test(name)) return false;
  if (name.includes("\0")) return false;
  if (name.includes("..")) return false;
  if (/\s/.test(name)) return false;
  if (/[~^:?*\[\]"&|<>$`';!(){}]/.test(name)) return false;
  if (/^[.-]/.test(name)) return false;
  return true;
}

/**
 * 创建一个独立 worktree。
 * @param {string} sourceCwd 源仓库（主工作树）路径
 * @param {string} name worktree 名称（用作目录名 + 分支名）
 * @returns {Promise<{path: string, branch: string}>}
 */
export function createWorktree(sourceCwd, name) {
  if (!isValidWorktreeName(name)) {
    throw new Error(`Invalid worktree name (contains path separators, shell metacharacters, or traversal): ${JSON.stringify(name)}`);
  }
  const cwd = resolve(sourceCwd);
  if (!isGitRepo(cwd)) {
    throw new Error(`${cwd} is not a git repository (worktree requires git)`);
  }
  const wtPath = join(cwd, ".wao-worktrees", name);
  const branch = `wao/${name}`;
  // execFileSync with structured args — no shell-built command string.
  execFileSync("git", ["worktree", "add", wtPath, "-b", branch], {
    cwd,
    stdio: "pipe",
    windowsHide: true,
  });
  return Promise.resolve({ path: wtPath, branch });
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
      execSync(`git worktree remove --force "${path}"`, {
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
