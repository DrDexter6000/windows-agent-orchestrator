#!/usr/bin/env node
// scripts/wao-node.cjs
//
// WAO 专用 Node v22 启动器（shim）。
//
// 背景：WAO 的 nodeVersionGuard 拒绝 v24（libuv Windows Job Object 回归杀长进程），
// 只放行 v22。但开发者机器的默认 node 常是 v24（PATH 里）。本 shim 让 WAO 的所有
// 入口（cli/smoke/reliability/long-run）自动用系统级 v22 跑，无需改全局 PATH、
// 无需每个项目各塞一份 node.exe。
//
// 定位 v22 的优先级：
//   1. env WAO_NODE（显式覆盖，换机器/CI 用）
//   2. %LOCALAPPDATA%\Programs\nodejs-v22\node.exe（系统级共享安装，约定路径）
//   3. 兜底：报错并给指引（不静默回退到 v24——那会被 guard 拒，反而更困惑）
//
// 用法：package.json scripts 里 "cli": "node scripts/wao-node.cjs src/cli.js"
//   任何 WAO 子命令通过本 shim 转发，argv 透传。

const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const LOCALAPPDATA = process.env.LOCALAPPDATA || "";
const SYSTEM_V22 =
  process.env.WAO_NODE ||
  join(LOCALAPPDATA, "Programs", "nodejs-v22", "node.exe");

if (!existsSync(SYSTEM_V22)) {
  // 不静默回退 v24。给清晰指引。
  process.stderr.write(
    `WAO 需要 Node v22，但在以下位置都没找到：\n` +
      `  - env WAO_NODE = ${process.env.WAO_NODE || "(未设置)"}\n` +
      `  - ${SYSTEM_V22}\n\n` +
      `请安装 Node v22 到 ${join(LOCALAPPDATA, "Programs", "nodejs-v22")}，\n` +
      `或设 env WAO_NODE 指向 v22 node.exe 的全路径。\n` +
      `（当前默认 node 是 v${process.versions.node}，会被 WAO versionGuard 拒绝。）\n`
  );
  process.exit(127);
}

// 透传 argv：本 shim 之后的参数就是要跑的脚本 + 它的参数。
const args = process.argv.slice(2);
const child = spawn(SYSTEM_V22, args, { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
