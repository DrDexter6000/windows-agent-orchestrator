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
// 当前真实调用点（避免漂移，新增时同步本注释）：
//   - src/backends/factory.js（共享工厂内部解析：未显式注入 waoCliPath 时兜底）
//   - src/backgroundRunner.js / src/daemon.js（启动时算好，显式注入工厂）
//   - src/mcp/server.js（resolveBackendFor，M12-7 续跑资格检查的刻意 fail-soft 构造点）

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
