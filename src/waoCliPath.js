// src/waoCliPath.js
//
// SSOT：worker 注入用的 WAO CLI 入口路径（TD-90 fix）。
//
// 问题：原 waoCliPath 指向裸 src/cli.js，worker shell 默认 node 常是 v24，
// 直接 `node $WAO_CLI` 触发 nodeVersionGuard 被拒（dogfood round 7 实证）。
//
// 修复：Windows 上指向 scripts/wao-cli.cmd（内部用 v22 node 绝对路径，不经 PATH），
// worker 调 `$WAO_CLI wao handoff write ...` 直接可用，不用猜 node 版本。
// 非 Windows 回退裸 cli.js（无 v24 guard 问题）。
//
// 三处注入点（cli.js / backgroundRunner.js / daemon.js）都引用本 helper，避免漂移。

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = dirname(fileURLToPath(import.meta.url)); // src/

/**
 * 返回注入给 worker 的 WAO CLI 入口路径。
 * Windows: scripts/wao-cli.cmd（自动用 v22 node）
 * 其他: ../src/cli.js（裸入口，无 v24 guard 问题）
 */
export function getWaoCliPath() {
  if (process.platform === "win32") {
    // scripts/ 是 src/ 的同级目录 → ../scripts/wao-cli.cmd
    return join(SRC_DIR, "..", "scripts", "wao-cli.cmd");
  }
  return join(SRC_DIR, "cli.js");
}
