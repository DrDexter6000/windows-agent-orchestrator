// src/application/runBranches.js
//
// wao/run_* 分支枚举（只读）。lead_preflight 的待办事项收集（决定 0113，
// leadOpenItems.js）与 Owner 看板的读模型（决定 0131，ownerReadModel.js）共用同一条
// 枚举命令与同一份"只认 wao/run_ 前缀 + 合法 runId"的判法：一条分支在不在，两处
// 必须给出同一个答案。
//
//   listRunBranchRunIds(execGitFn, repoRoot) → Promise<runId[]>（async）：按提交时间
//     新到旧，不截断。两个调用方都要全量（leadOpenItems 只限制列出的条数）。
//     git 失败原样抛出（拒绝），怎么处置由调用方决定：leadOpenItems 省略整段，读模型
//     记 unknown。同步与异步执行器都能用（内部一律 await）。
//   execGitReadOnly(args, cwd) → 缺省的只读 git 执行器（Promise<string>，读模型用）：
//     结构化 argv、不经 shell、--no-optional-locks、有界等待——常驻进程里的刷新不能被
//     挂死的 git 拖住。异步 execFile：一次超时不冻住 Node 线程，多个项目的枚举可以并行，
//     整轮最长约等于单次超时。leadOpenItems 自带同形状的同步执行缝（它的注入面），
//     保持不变。
//
// 判法为什么用完整 refname（%(refname)，不用 %(refname:short)）：同名 tag 存在时，
// short 名会退化/歧义（heads/wao/run_…），被当成不是分支；完整 refname 永远以
// refs/heads/ 开头，去掉前缀后按 wao/run_ + 合法 runId 判，不受同名 tag 影响。
//
// 仓库边界：只问 cwd 这个目录自己的仓库。gitProbeEnv 去掉环境里的定位变量；
// GIT_CEILING_DIRECTORIES 设成 cwd 的父目录（在 gitProbeEnv() 之后追加），git 不再
// 向上发现祖先仓库——项目 key 目录自己没有 git 元数据、但躺在另一个仓库下面时，
// 如实答"不是仓库"，而不是报祖先仓库的分支集。
//
// 架构契约：只读（零写盘，零 git 写命令）；不 import src/commands/**、src/mcp/**、
// MCP SDK 或 zod。

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";

import { gitProbeEnv, isValidRunId } from "../delivery.js";

/** 读模型里一次分支枚举的等待上限（ms）。 */
export const RUN_BRANCH_GIT_TIMEOUT_MS = 10_000;

const RUN_BRANCH_PREFIX = "wao/";
const HEADS_PREFIX = "refs/heads/";

/**
 * 缺省的只读 git 执行器：(args, cwd) → stdout。问的是"这个目录自己的仓库"，所以去掉
 * 环境里会让 git 回答别处仓库的定位变量（gitProbeEnv），再用 GIT_CEILING_DIRECTORIES
 * 把向上发现停在 cwd 的父目录（只认 cwd 本身；cwd 为盘根时 dirname(resolve(cwd)) 还是
 * 盘根，行为不变）。失败（非仓库、超时、git 不在 PATH）以拒绝给出。
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<string>}
 */
export function execGitReadOnly(args, cwd) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["--no-optional-locks", ...args],
      {
        cwd,
        encoding: "utf8",
        // 在 gitProbeEnv() 之后追加 GIT_CEILING_DIRECTORIES：git 不再向上发现祖先仓库。
        env: { ...gitProbeEnv(), GIT_CEILING_DIRECTORIES: dirname(resolve(cwd)) },
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        timeout: RUN_BRANCH_GIT_TIMEOUT_MS,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolvePromise(String(stdout));
      },
    );
  });
}

/**
 * 仓库里现存的 wao/run_* 分支对应的 runId（新到旧，不截断）。只认 refs/heads/ 下的
 * `wao/run_` 前缀且 runId 合法的分支名；其余（别的 wao/ 分支、非法形状）一律不算。
 * 用完整 refname 而不是 short 名：同名 tag 在场时 short 名会变成 heads/wao/run_…
 * 而被过滤掉，存在的分支会被误报为不在。
 *
 * @param {Function} execGitFn — (args, cwd) => stdout | Promise<stdout>；失败抛出/拒绝
 * @param {string} repoRoot
 * @returns {Promise<string[]>}
 * @throws {Error} git 枚举失败时原样抛出
 */
export async function listRunBranchRunIds(execGitFn, repoRoot) {
  const out = await execGitFn(
    ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads/wao/"],
    repoRoot,
  );
  const runIds = [];
  for (const ref of String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    if (!ref.startsWith(HEADS_PREFIX)) continue;
    const branch = ref.slice(HEADS_PREFIX.length);
    if (!branch.startsWith(`${RUN_BRANCH_PREFIX}run_`)) continue;
    const runId = branch.slice(RUN_BRANCH_PREFIX.length);
    if (isValidRunId(runId)) runIds.push(runId);
  }
  return runIds;
}
