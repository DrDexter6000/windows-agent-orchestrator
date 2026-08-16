#!/usr/bin/env node
// scripts/wao-node.cjs
//
// WAO 专用 Node v22 启动器（shim）。
//
// 背景：WAO 的 nodeVersionGuard 拒绝 v24（libuv Windows Job Object 回归杀长进程），
// 只放行 v22。但开发者机器的默认 node 常是 v24（PATH 里）。本 shim 让 WAO 的所有
// 入口（cli/smoke/reliability/long-run）自动用 v22 跑，无需改全局 PATH、
// 无需每个项目各塞一份 node.exe。
//
// 定位 v22 的优先级（腿 1/2 行为不变；腿 3 为新增扩展）：
//   1. env WAO_NODE（显式覆盖，换机器/CI 用）
//   2. %LOCALAPPDATA%\Programs\nodejs-v22\node.exe（系统级共享安装，约定路径）
//   3. PATH 上的 node：探测其版本并经 src/nodeVersionGuard.js 判定，
//      放行才使用（当前=v22；未来 guard 放行的版本自动跟进——判定单一真相，
//      不在本文件复制 major 规则）。命中时向 stderr 打一行 using-from-PATH
//      （stdout 保持纯净供管道消费）。
//   4. 兜底：报错并给指引（不静默回退——那会被 guard 拒，反而更困惑）
//
// 腿 3 的 guard 判定用动态 import()（CJS 里 dynamic import ESM 可行）。guard 模块
// 本身无 node 版本副作用，shim 自身进程（可能是 v24）加载它是安全的。
//
// 用法：package.json scripts 里 "cli": "node scripts/wao-node.cjs src/cli.js"
//   任何 WAO 子命令通过本 shim 转发，argv 透传。

const { spawn, spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join, delimiter: PATH_DELIMITER } = require("node:path");
const { pathToFileURL } = require("node:url");

const LOCALAPPDATA = process.env.LOCALAPPDATA || "";
const SYSTEM_V22 =
  process.env.WAO_NODE ||
  join(LOCALAPPDATA, "Programs", "nodejs-v22", "node.exe");

// guard 模块绝对路径 → file URL（CJS dynamic import ESM 需要）。
const GUARD_URL = pathToFileURL(
  join(__dirname, "..", "src", "nodeVersionGuard.js")
).href;

// 透传 argv：本 shim 之后的参数就是要跑的脚本 + 它的参数。
function launch(nodeExe) {
  const args = process.argv.slice(2);
  const child = spawn(nodeExe, args, { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

// 腿 3 辅助：在 PATH 上解析 node 可执行文件的全路径（不经过 shell）。
function resolveNodeOnPath() {
  const exeName = process.platform === "win32" ? "node.exe" : "node";
  const pathVar = process.env.PATH || "";
  for (const dir of pathVar.split(PATH_DELIMITER)) {
    if (!dir) continue;
    const candidate = join(dir, exeName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// 腿 3 辅助：探测候选 node 的版本字符串（"vX.Y.Z"）；探测失败/不可解析返回 null。
function probeVersion(nodeExe) {
  try {
    const r = spawnSync(nodeExe, ["--version"], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    if (r.error || r.status !== 0 || typeof r.stdout !== "string") return null;
    const m = r.stdout.match(/v?(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    return `v${m[1]}.${m[2]}.${m[3]}`;
  } catch {
    return null;
  }
}

// 兜底指引（exit 127）。原两腿文案保持逐字不变，仅追加腿 3 的条目与补救行。
function failAllMissGuidance() {
  process.stderr.write(
    `WAO 需要 Node v22，但在以下位置都没找到：\n` +
      `  - env WAO_NODE = ${process.env.WAO_NODE || "(未设置)"}\n` +
      `  - ${SYSTEM_V22}\n` +
      `  - PATH 上的 node（主版本须为 v22）\n\n` +
      `请安装 Node v22 到 ${join(LOCALAPPDATA, "Programs", "nodejs-v22")}，\n` +
      `或设 env WAO_NODE 指向 v22 node.exe 的全路径，\n` +
      `或安装 Node 22 到 PATH。\n` +
      `（当前默认 node 是 v${process.versions.node}，会被 WAO versionGuard 拒绝。）\n`
  );
  process.exit(127);
}

// 腿 3 命中但版本被 guard 拒绝（v23/v24）：维持 exit 127 + 中文指引，
// reason 直接引用 guard 的判定文案（单一真相，不在 shim 复述版本规则）。
function failRejectedPathNode(pathNode, version, reason) {
  process.stderr.write(
    `WAO 需要 Node v22，但 PATH 上的 node 版本被拒绝：\n` +
      `  - ${pathNode} → ${version}\n` +
      `  - ${reason}\n\n` +
      `请安装 Node v22 到 ${join(LOCALAPPDATA, "Programs", "nodejs-v22")}，\n` +
      `或设 env WAO_NODE 指向 v22 node.exe 的全路径，\n` +
      `或安装 Node 22 到 PATH（替换当前默认 node）。\n` +
      `（当前默认 node 是 v${process.versions.node}，会被 WAO versionGuard 拒绝。）\n`
  );
  process.exit(127);
}

function main() {
  // 腿 1/2（行为不变）：WAO_NODE（或约定路径）命中即转发，无任何额外输出。
  if (existsSync(SYSTEM_V22)) {
    launch(SYSTEM_V22);
    return;
  }

  // 腿 3（新增）：PATH 上有 node 且其版本被 guard 放行 → 使用之。
  const pathNode = resolveNodeOnPath();
  if (pathNode) {
    const version = probeVersion(pathNode);
    if (version) {
      // 判定单一真相：动态 import guard，不复制 major 判断逻辑。
      import(GUARD_URL)
        .then((guard) => {
          const verdict = guard.checkNodeVersion(version);
          if (verdict.ok) {
            // stderr 一行（stdout 保持纯净）；版本串保持 process.version 形态。
            process.stderr.write(
              `wao-node: using node ${version} from PATH (${pathNode})\n`
            );
            launch(pathNode);
          } else {
            failRejectedPathNode(pathNode, version, verdict.reason);
          }
        })
        .catch(() => {
          // guard 模块加载失败（仓损坏等）：按全不命中处理，不静默回退。
          failAllMissGuidance();
        });
      return;
    }
  }

  // 三腿全不命中（含 PATH 上有 node 但探测不出版本）。
  failAllMissGuidance();
}

main();
