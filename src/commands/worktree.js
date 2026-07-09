// src/commands/worktree.js
//
// TD-98 阶段 2c：worktree command family 从 cli.js 拆出（行为不变，纯搬迁）。
//
// 命令族：worktree list [--cwd DIR] / worktree remove <path> [--cwd DIR]
//
// 依赖：
//   - 外部模块：../isolation.js（listWorktrees/removeWorktree）
//   - 共享工具：./shared.js（parseOptions，纯函数）
//   - node built-in：path（resolve）

import { resolve } from "node:path";

import { listWorktrees, removeWorktree } from "../isolation.js";
import { parseOptions } from "./shared.js";

/**
 * worktree 命令：列出/删除 worktree（TD-22）。
 *   worktree list [--cwd DIR]
 *   worktree remove <path> [--cwd DIR]
 * 能力层（listWorktrees/removeWorktree）早已实现，本命令只是 CLI 暴露。
 */
async function worktreeCommand(args, config) {
  const [sub, ...rest] = args;
  const options = parseOptions(rest);
  const cwd = resolve(options.cwd ?? config.cwd ?? process.cwd());
  if (sub === "list") {
    const wts = await listWorktrees(cwd);
    console.log(JSON.stringify(wts, null, 2));
    return;
  }
  if (sub === "remove") {
    const target = rest.find((a) => !a.startsWith("--"));
    if (!target) throw new Error("worktree remove requires <path>");
    await removeWorktree(resolve(target));
    console.log(JSON.stringify({ removed: resolve(target) }));
    return;
  }
  throw new Error(`Unknown worktree subcommand: ${sub ?? "(none)"} (expected: list | remove)`);
}

export { worktreeCommand };
