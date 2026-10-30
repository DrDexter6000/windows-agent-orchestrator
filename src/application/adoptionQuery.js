// src/application/adoptionQuery.js
//
// 决定 0098：交付读面显示"主分支上有提交声明采纳了这个运行"。
//
// 两个共享件住在这里：
//   - messageDeclaresAdoption：`WAO-Adopted-From: <runId>` trailer 的精确匹配
//     （CRLF 归一、容忍行尾空白、整行相等、runId 精确、所在段落全 Key: value 形）。
//     `runs verify-commit` 的 adoptedFromTrailer 事实字段与本查询共用它——
//     trailer 约定的判定只有这一份。
//   - queryRunAdoption：在调用方自己的仓库里按 runId 找声明采纳的提交，
//     只返回闭集事实（状态、提交 sha 列表、截断标记、未查原因），绝不回显
//     提交消息、路径或 stderr。
//
// 架构合同（与 runDelivery.js 同层纪律）：
//   - 不解析 argv、不 console.log、不 process.exit；不 import commands/mcp/
//     SDK/zod。git 一律结构化 argv + --no-optional-locks + gitChildEnv，
//     选项注入防线是 --end-of-options（revision 之前收掉选项解析）。
//   - 只读：不 fetch、不写任何文件、不追加 transcript。
//   - 不核验运行归属（决定 0098 第 3 条）：查询只按 runId 找提交，不证明
//     run 属于该仓库。

import { execFileSync } from "node:child_process";

import { gitChildEnv, isValidRunId } from "../delivery.js";
// "主分支"的判定与 worktree reclaim 共用同一解析（决定 0098 第 2 条）：
// 主工作树当前检出的 refs/heads/* 短名；detached / 非 heads ref → null。
import { parseWorktreePorcelain, mainWorktreeBranch } from "./worktreeReclaim.js";

/** trailer 的键名（家：docs/usage/delivery.md 验证失败采纳协议）。 */
const ADOPTED_FROM_KEY = "WAO-Adopted-From";

// ===== 闭集常量（SSOT——MCP 层的 zod enum 从这里派生，不复制第二份清单） =====

/** adoption 三态：found=主分支上有提交声明采纳；not_found=没有；unchecked=没查成。 */
export const ADOPTION_STATUSES = Object.freeze(["found", "not_found", "unchecked"]);

/** unchecked 的闭集原因。 */
export const ADOPTION_UNCHECKED_REASONS = Object.freeze([
  "unbound", // 调用方没给仓库根（MCP 会话未绑定 / CLI 无 --cwd 来源）
  "no_main_branch", // 主工作树 detached 或检出的不是 refs/heads/*
  "git_error", // 任一只读 git 调用失败
  "timeout", // 任一只读 git 调用超时
]);

/** 返回的提交 sha 列表上限；超出置 truncated（决定 0098 第 1 条）。 */
export const ADOPTION_COMMITS_CAP = 5;

/** 每条 git 调用的缺省超时（本地只读操作，给足裕量）。 */
export const ADOPTION_GIT_TIMEOUT_MS = 10_000;

// 段落里每一行都必须是 Key: value 形：键是字母/数字/连字符，冒号+空格后跟
// 非空白起头的值。git 自带的 trailer 解析认不出 15494b9 的形状（其后空一行
// 再接 Co-Authored-By，不在最后一段），也不要求 35fc0c5 的形状（只有
// WAO-Adopted-From）——所以按约定自己判（决定 0098 第 4 条）。
const KEY_VALUE_LINE = /^[A-Za-z0-9-]+: \S/;

/** 行尾空白（空格/制表）剥除——匹配容忍行尾空白，前导空白不容忍。 */
const rtrim = (line) => line.replace(/[ \t]+$/, "");

const isBlankLine = (line) => rtrim(line).length === 0;

/**
 * 提交消息全文是否声明采纳了这个 runId（决定 0098 第 4 条的精确匹配）。
 * 纯函数；runId 精确（`run_x` 不命中 `run_x2`），缩进/正文句中提及不命中，
 * trailer 所在段落（空行分隔）必须每一行都是 `Key: value` 形。
 * @param {string} message 提交消息全文（%B）
 * @param {string} runId
 * @returns {boolean}
 */
export function messageDeclaresAdoption(message, runId) {
  if (typeof message !== "string" || typeof runId !== "string" || runId.length === 0) return false;
  // \r\n 归一为 \n（Windows 下 %B 可能带 CRLF）；再按行拆。
  const lines = message.replace(/\r\n/g, "\n").split("\n");
  const wanted = `${ADOPTED_FROM_KEY}: ${runId}`;
  for (let i = 0; i < lines.length; i += 1) {
    if (rtrim(lines[i]) !== wanted) continue;
    // 找到整行相等的候选：向两侧扩出它所在的段落（空行分隔）。
    let start = i;
    while (start > 0 && !isBlankLine(lines[start - 1])) start -= 1;
    let end = i;
    while (end + 1 < lines.length && !isBlankLine(lines[end + 1])) end += 1;
    let allKeyValue = true;
    for (let j = start; j <= end; j += 1) {
      if (!KEY_VALUE_LINE.test(rtrim(lines[j]))) {
        allKeyValue = false;
        break;
      }
    }
    if (allKeyValue) return true;
  }
  return false;
}

/** execFileSync 超时杀进程的形态（killed/signal），与其它失败区分开。 */
function isGitTimeout(err) {
  return Boolean(err) && typeof err === "object"
    && (err.killed === true || err.signal === "SIGTERM");
}

/** 缺省 git 执行器：同步、只读、结构化 argv、gitChildEnv 注入。 */
function defaultGit(args, { cwd, timeoutMs }) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitChildEnv(),
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
}

const canonicalSha = (value) => typeof value === "string" && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value);

/**
 * 在 repoRoot 的主分支上找声明采纳了 runId 的提交（决定 0098）。
 *
 * 步骤：runId 先过 isValidRunId（否则抛错——调用方 service 层已在更早处拒绝，
 * 到这里的是程序员错误）；解析主分支（主工作树 detached / 非 refs/heads/* →
 * unchecked/no_main_branch，不退回 HEAD 也不用 --all）；`git log <主分支>` 预筛
 * （--fixed-strings --grep，扫主分支全历史——不按交付的 base 收窄：base 常是开发
 * 分支上的提交，分支删除后会被 gc，收窄会让旧运行的查询报错；runId 带时间戳，
 * 不会早于运行就被引用）；逐候选取 %B 用 messageDeclaresAdoption 精确核对。
 * commits 上限 ADOPTION_COMMITS_CAP，超出置 truncated。
 *
 * @param {object} input
 * @param {string|null} [input.repoRoot] 仓库根；未给 → unchecked/unbound，不跑 git
 * @param {string} input.runId
 * @param {Function} [input.gitFn] 可注入执行器 `(args, {cwd, timeoutMs}) => stdout`
 * @param {number} [input.timeoutMs] 每条 git 调用超时
 * @returns {Promise<{status:("found"|"not_found"|"unchecked"), commits:string[],
 *   truncated:boolean, uncheckedReason:("unbound"|"no_main_branch"|"git_error"|"timeout"|null),
 *   branch:(string|null)}>}
 *   branch 是实际查过的主分支短名（unchecked 在解析出分支之前返回时为 null）；
 *   只供 CLI 文本行使用，MCP 安全投影不携带它。
 */
export async function queryRunAdoption({
  repoRoot,
  runId,
  gitFn = defaultGit,
  timeoutMs = ADOPTION_GIT_TIMEOUT_MS,
}) {
  if (!isValidRunId(runId)) throw new Error("queryRunAdoption: invalid runId");
  const _git = typeof gitFn === "function" ? gitFn : defaultGit;
  // 结构化 argv 里的公共前缀：只读 git 一律 --no-optional-locks。
  const run = (args) => _git(["--no-optional-locks", ...args], { cwd: repoRoot, timeoutMs });
  const unchecked = (uncheckedReason, branch = null) => ({
    status: "unchecked", commits: [], truncated: false, uncheckedReason, branch,
  });
  if (typeof repoRoot !== "string" || repoRoot.length === 0) return unchecked("unbound");

  let branch;
  try {
    const porcelain = run(["worktree", "list", "--porcelain"]);
    branch = mainWorktreeBranch(parseWorktreePorcelain(String(porcelain))[0]);
  } catch (err) {
    return unchecked(isGitTimeout(err) ? "timeout" : "git_error");
  }
  if (branch === null) return unchecked("no_main_branch");

  // 完整引用 refs/heads/<分支>，末尾 `--`：短名会被同名 tag 抢先解析（git 的引用
  // 顺序 tag 在分支前），也会与同名路径冲突。
  let candidateOut;
  try {
    candidateOut = run([
      "log", "--fixed-strings", `--grep=${ADOPTED_FROM_KEY}: ${runId}`,
      "--format=%H", "--end-of-options", `refs/heads/${branch}`, "--",
    ]);
  } catch (err) {
    return unchecked(isGitTimeout(err) ? "timeout" : "git_error", branch);
  }
  const candidates = String(candidateOut).split("\n").map((l) => l.trim()).filter(canonicalSha);

  const commits = [];
  let truncated = false;
  for (const sha of candidates) {
    let message;
    try {
      message = run(["log", "-1", "--format=%B", "--end-of-options", sha]);
    } catch (err) {
      return unchecked(isGitTimeout(err) ? "timeout" : "git_error", branch);
    }
    if (messageDeclaresAdoption(String(message), runId)) {
      if (commits.length >= ADOPTION_COMMITS_CAP) {
        truncated = true;
        break;
      }
      commits.push(sha);
    }
  }
  return {
    status: commits.length > 0 ? "found" : "not_found",
    commits,
    truncated,
    uncheckedReason: null,
    branch,
  };
}
