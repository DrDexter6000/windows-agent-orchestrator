// src/dispatchResourceAdvisory.js
//
// ADR 0035 S3（.wao/decisions/0035-*.md §Decision 5，2026-09-30 Owner 批准的
// 后续阶段）：派发时 advisory 资源计数行——让 Lead 在派发启动时刻看到仓库
// 资源存量（注册 worktree 总数 + wao/run_* 分支总数）。
//
// 纪律（先例：src/machineGatePaths.js 的 inflight marker——advisory
// discipline，never block / never fail）：
//   · fail-open：git 子进程失败/超时/输出不可解析 → 返回 null，调用方
//     （src/commands/run.js）完全省略该行——不报错、不加失败码、不影响任何
//     既有输出与 verdict，永不阻塞派发。没有"计数不可用"占位文案，失败面为零。
//   · 产品代码不放阈值/上限（ADR 0035 §Decision 3：W4 的 BRANCH_CAP 等配置
//     只存在于 scripts/hygiene.mjs）；本模块只报 RAW 计数，行文案指路
//     `npm run hygiene` 查详情。
//   · 行内容纪律：除两个计数数字外不携带任何动态内容（无路径、无凭据、无
//     runId）。
//
// git 子进程调用方式对齐 src/ 既有先例（src/isolation.js 的 listWorktrees /
// isGitRepo：execSync 命令串 + {cwd, encoding:"utf8", windowsHide:true}），
// 仅追加 timeout 作为 fail-open 的有界等待——execSync 超时会 kill 子进程并
// 抛错，与失败同一条 catch 路径。两个计数的口径与 scripts/hygiene.mjs 的
// listWorktreePaths / countRunBranches 保持一致（同一事实、同一观测），但
// 不 import scripts/（产品代码不依赖 dev 侧载体）。
//
// 形状：顶层命名函数、零相对出边（node:child_process only）——machineGatePaths
// 同款 core 顶层模块（layering 守卫 CORE_TOP 已登记）。子进程执行器可注入
// （exec 参数，runDispatch spawnFn 先例），供纯单元测试注入 fake。

import { execSync } from "node:child_process";

/**
 * 单次 git 子进程的等待上限（ms）：慢/挂死的 git 不得拖住派发启动。
 * 两计数各一次调用，最坏情况有界 ~2x 本值。
 */
export const ADVISORY_GIT_TIMEOUT_MS = 2000;

/** ADR 0035 S3 固定行文案（两个计数是仅有的动态内容；无其他动态载荷）。 */
function advisoryLine(worktrees, waoRunBranches) {
  return `[wao] advisory: worktrees=${worktrees} waoRunBranches=${waoRunBranches} (npm run hygiene for details)`;
}

/**
 * 单次 git 调用：跑 exec、要求字符串 stdout。非字符串输出（不可解析）与
 * 子进程失败同待遇（抛错 → 上层 catch → 整行省略）。
 */
function execGit(exec, cwd, command) {
  const out = exec(command, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: ADVISORY_GIT_TIMEOUT_MS,
  });
  if (typeof out !== "string") {
    throw new TypeError("dispatchResourceAdvisory: non-string stdout");
  }
  return out;
}

/**
 * 注册 worktree 总数（含主工作树）——`git worktree list --porcelain` 的
 * `worktree ` 条目计数（hygiene.mjs listWorktreePaths 同口径）。
 */
function countWorktrees(exec, cwd) {
  const out = execGit(exec, cwd, "git worktree list --porcelain");
  return out.split(/\r?\n/).filter((line) => line.startsWith("worktree ")).length;
}

/**
 * wao/run_* 分支总数——`git branch --list "wao/run_*"` 的非空行计数
 * （hygiene.mjs countRunBranches 同口径）。
 */
function countRunBranches(exec, cwd) {
  const out = execGit(exec, cwd, 'git branch --list "wao/run_*"');
  return out.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

/**
 * 渲染 ADR 0035 S3 的派发启动 advisory 行，或返回 null（fail-open 省略）。
 *
 * @param {string} cwd — 采样目录（git worktree list / git branch 是 repo 级
 *   事实，同一 repo 的任何 worktree 观测一致，无需复刻 RunManager 的 agent
 *   默认 cwd 解析）
 * @param {{exec?: Function}} [opts] — 可注入的子进程执行器（默认 node
 *   execSync；签名 (command, options) → stdout string），纯单测注伪用
 * @returns {string|null} 固定格式行；任一计数失败（含超时 kill、非 git
 *   目录、输出不可解析）→ null，绝不抛错
 */
export function renderDispatchResourceAdvisory(cwd, { exec = execSync } = {}) {
  let worktrees;
  let waoRunBranches;
  try {
    worktrees = countWorktrees(exec, cwd);
    waoRunBranches = countRunBranches(exec, cwd);
  } catch {
    // fail-open（advisory discipline）：任何失败都省略整行——不报错、
    // 不加失败码、不阻塞派发。
    return null;
  }
  return advisoryLine(worktrees, waoRunBranches);
}
