// src/application/runBranches.js
//
// wao/run_* 分支枚举（只读）。lead_preflight 的待办事项收集（决定 0113，
// leadOpenItems.js）与 Owner 看板的读模型（决定 0131，ownerReadModel.js）共用同一条
// 枚举命令与同一份"只认 wao/run_ 前缀 + 合法 runId"的判法：一条分支在不在，两处
// 必须给出同一个答案。
//
//   listWaoRunBranches(execGitFn, repoRoot) → Promise<string[]>（async）：按提交时间
//     新到旧，不截断，**全部分支名**（`wao/run_…`，不管 runId 形状是否合法）。分支帽
//     的计数口径与 dispatchResourceAdvisory 一致：违反形状的同前缀分支也占帽。
//   listRunBranchRunIds(execGitFn, repoRoot) → Promise<runId[]>（async）：同一份枚举里
//     只留合法 runId 的（待办归类用；读模型要全量）。不截断——查看/归类由调用方负责。
//     git 失败原样抛出（拒绝），怎么处置由调用方决定：leadOpenItems 给一行"分支账
//     读不出"固定文案，读模型记 unknown。同步与异步执行器都能用（内部一律 await）。
//   runCreatedAtMs(runId) → epoch ms|null：runId 内的创建时刻（第 147 批修正：从
//     ownerReadModel 挪来，两处共用一份；写进去什么、读出来什么必须一一对应）。
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

/** wao/ 分支名前缀（去掉它得到 runId，形如 `run_xxx`）。 */
export const WAO_BRANCH_PREFIX = "wao/";
/** wao/run_ 分支名前缀（枚举与分支帽计数共用）。 */
const WAO_RUN_BRANCH_PREFIX = `${WAO_BRANCH_PREFIX}run_`;

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
 * 仓库里现存的 wao/run_* 分支名（短名，形如 `wao/run_xxx`；新到旧，不截断）。
 * 只认 refs/heads/ 下 `wao/run_` 前缀的分支；**不校验 runId 形状**——分支帽计数
 * 与 dispatchResourceAdvisory 同口径（同前缀分支都算）。用完整 refname 而不是
 * short 名：同名 tag 在场时 short 名会变成 heads/wao/run_… 而被过滤掉，存在的
 * 分支会被误报为不在。
 *
 * @param {Function} execGitFn — (args, cwd) => stdout | Promise<stdout>；失败抛出/拒绝
 * @param {string} repoRoot
 * @returns {Promise<string[]>}
 * @throws {Error} git 枚举失败时原样抛出
 */
export async function listWaoRunBranches(execGitFn, repoRoot) {
  const out = await execGitFn(
    ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads/wao/"],
    repoRoot,
  );
  const branches = [];
  for (const ref of String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    if (!ref.startsWith(HEADS_PREFIX)) continue;
    const branch = ref.slice(HEADS_PREFIX.length);
    if (!branch.startsWith(WAO_RUN_BRANCH_PREFIX)) continue;
    branches.push(branch);
  }
  return branches;
}

/**
 * 仓库里现存的 wao/run_* 分支对应的 runId（新到旧，不截断）。只认 refs/heads/
 * 下 `wao/run_` 前缀且 runId 合法的分支（同一枚举见 listWaoRunBranches）。
 *
 * @param {Function} execGitFn — (args, cwd) => stdout | Promise<stdout>；失败抛出/拒绝
 * @param {string} repoRoot
 * @returns {Promise<string[]>}
 * @throws {Error} git 枚举失败时原样抛出
 */
export async function listRunBranchRunIds(execGitFn, repoRoot) {
  const runIds = [];
  for (const branch of await listWaoRunBranches(execGitFn, repoRoot)) {
    const runId = branch.slice(WAO_BRANCH_PREFIX.length);
    if (isValidRunId(runId)) runIds.push(runId);
  }
  return runIds;
}

/** Date 能表示的最大 epoch ms（±8.64e15）；超出就不是时刻。 */
const MAX_TIME_MS = 8.64e15;

/**
 * runId 里的创建时刻（epoch ms）。WAO 生成的 runId 是 `run_` + 17 位 UTC 时间戳
 * （YYYYMMDDHHmmss + 毫秒）+ 随机后缀；不是这个形状（测试合成值、别的工具造的值）
 * 就是 null——时间序不可比。
 *
 * 第 147 批修正：解析出的字段必须与写进去的一一对应（`getUTC*` 回读比对）。越界字段
 * （13 月、32 日、0 日）会被 Date.UTC 归一化到别的时刻，不能当成"创建时刻"。
 *
 * @param {string} runId
 * @returns {number|null}
 */
export function runCreatedAtMs(runId) {
  if (typeof runId !== "string" || !runId.startsWith("run_")) return null;
  const digits = runId.slice(4, 21);
  if (!/^\d{17}$/.test(digits)) return null;
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const hour = Number(digits.slice(8, 10));
  const minute = Number(digits.slice(10, 12));
  const second = Number(digits.slice(12, 14));
  const milli = Number(digits.slice(14, 17));
  const value = Date.UTC(year, month - 1, day, hour, minute, second, milli);
  if (!Number.isFinite(value) || Math.abs(value) > MAX_TIME_MS) return null;
  const at = new Date(value);
  // 越界字段（13 月、32 日、0 日）会被 Date.UTC 归一化到别的时刻：按"时间序不可比"处理。
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day
    && at.getUTCHours() === hour && at.getUTCMinutes() === minute && at.getUTCSeconds() === second
    && at.getUTCMilliseconds() === milli
    ? value
    : null;
}
