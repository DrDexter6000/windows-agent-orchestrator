// src/application/runBranches.js
//
// wao/run_* 分支枚举（只读）。lead_preflight 的待办事项收集（决定 0113，
// leadOpenItems.js）与 Owner 看板的读模型（决定 0131，ownerReadModel.js）共用同一条
// 枚举命令与同一份"只认 wao/run_ 前缀 + 合法 runId"的判法：一条分支在不在，两处
// 必须给出同一个答案。
//
//   listRunBranchRunIds(execGitFn, repoRoot) → runId[]：按提交时间新到旧，不截断。
//     查看帽是调用方的事——leadOpenItems 只看前若干条，读模型要全量。git 失败原样
//     抛出，怎么处置由调用方决定：leadOpenItems 省略整段，读模型记 unknown。
//   execGitReadOnly(args, cwd) → 缺省的只读 git 执行器（读模型用）：结构化 argv、
//     不经 shell、--no-optional-locks、有界等待——常驻进程里的刷新不能被挂死的 git
//     拖住。leadOpenItems 自带同形状的执行缝（它的注入面），保持不变。
//
// 架构契约：只读（零写盘，零 git 写命令）；不 import src/commands/**、src/mcp/**、
// MCP SDK 或 zod。

import { execFileSync } from "node:child_process";

import { gitProbeEnv, isValidRunId } from "../delivery.js";

/** 读模型里一次分支枚举的等待上限（ms）。 */
export const RUN_BRANCH_GIT_TIMEOUT_MS = 10_000;

const RUN_BRANCH_PREFIX = "wao/";

/**
 * 缺省的只读 git 执行器：(args, cwd) → stdout。问的是"这个目录自己的仓库"，所以去掉
 * 环境里会让 git 回答别处仓库的定位变量（gitProbeEnv）。失败（非仓库、超时、git 不
 * 在 PATH）抛出。
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
export function execGitReadOnly(args, cwd) {
  return execFileSync("git", ["--no-optional-locks", ...args], {
    cwd,
    encoding: "utf8",
    env: gitProbeEnv(),
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout: RUN_BRANCH_GIT_TIMEOUT_MS,
  }).toString();
}

/**
 * 仓库里现存的 wao/run_* 分支对应的 runId（新到旧，不截断）。只认 `wao/run_` 前缀且
 * runId 合法的分支名；其余（别的 wao/ 分支、非法形状）一律不算。
 *
 * @param {Function} execGitFn — (args, cwd) => stdout；失败抛出
 * @param {string} repoRoot
 * @returns {string[]}
 * @throws {Error} git 枚举失败时原样抛出
 */
export function listRunBranchRunIds(execGitFn, repoRoot) {
  const out = execGitFn(
    ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads/wao/"],
    repoRoot,
  );
  const runIds = [];
  for (const ref of String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    if (!ref.startsWith(`${RUN_BRANCH_PREFIX}run_`)) continue;
    const runId = ref.slice(RUN_BRANCH_PREFIX.length);
    if (isValidRunId(runId)) runIds.push(runId);
  }
  return runIds;
}
