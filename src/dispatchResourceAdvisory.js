// src/dispatchResourceAdvisory.js
//
// ADR 0035 S3（.wao/decisions/0035-*.md §Decision 5，2026-09-30 Owner 批准的
// 后续阶段）：派发时 advisory 资源计数行——让 Lead 在派发启动时刻看到仓库
// 资源存量（注册 worktree 总数 + wao/run_* 分支总数）。
//
// 决定 0042（Owner 2026-10-02，治"警报疲劳"）：弹行规则改为三合一——
//   ① **只在数字变化时弹**（去重：与上次弹出的计数一致则静默；下降也弹一次
//     ——清退发生了值得看见）；
//   ② **帽内且无变化不弹**（健康态静默）；
//   ③ **超帽恒弹**（违规保持可见直至清退——配合帽只降不升，违规无法靠抬帽消失）。
//   实测痛点：旧实现每次派发恒弹（单日 20+ 次），Lead 已视而不见——警报失去
//   稀缺性即失效（TD-202）。
//
// 分支帽 SSOT 自 scripts/hygiene.mjs 迁至本模块（决定 0042 修订 ADR 0035
// §Decision 3 的位置细则）：hygiene.mjs 反向 import 并 re-export（scripts→src
// 合法方向）——单一定义保持，位置随裁定修订。**帽只降不升**：上调须 Owner
// 明示并同步 hygieneGitState.test.js 的只降钉（2026-10-02 的 175→185 系最后
// 一次经 declare 的抬升）。
//
// 纪律（先例：src/machineGatePaths.js 的 inflight marker——advisory
// discipline，never block / never fail）：
//   · fail-open：git 子进程失败/超时/输出不可解析 → 返回 null，调用方
//     （src/commands/run.js）完全省略该行——不报错、不加失败码、不影响任何
//     既有输出与 verdict，永不阻塞派发。没有"计数不可用"占位文案，失败面为零。
//   · 计数 I/O 失败面：状态读失败 → 视为"变化"（保守弹一次——状态文件损坏
//     不吃掉信号）；状态写失败 → 静默忽略（下次重弹，同样保守可见）。
//   · 行内容纪律：除两个计数数字外不携带任何动态内容（无路径、无凭据、无
//     runId）——状态文件同样只存两个整数，不带路径。
//
// git 子进程调用方式对齐 src/ 既有先例（src/isolation.js 的 listWorktrees /
// isGitRepo：execSync 命令串 + {cwd, encoding:"utf8", windowsHide:true}），
// 仅追加 timeout 作为 fail-open 的有界等待。两个计数的口径与 scripts/hygiene.mjs
// 的 listWorktreePaths / countRunBranches 保持一致（同一事实、同一观测），但
// 不 import scripts/（产品代码不依赖 dev 侧载体；帽的 SSOT 在本模块，hygiene
// 消费 src）。
//
// 形状：顶层命名函数、零相对出边（node 内置 only）——machineGatePaths 同款
// core 顶层模块（layering 守卫 CORE_TOP 已登记）。子进程执行器与状态目录可
// 注入（exec / stateDir，runDispatch spawnFn 先例），供纯单元测试注入 fake
// 与临时目录。

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * 单次 git 子进程的等待上限（ms）：慢/挂死的 git 不得拖住派发启动。
 * 三计数各一次调用，最坏情况有界 ~3x 本值。
 */
export const ADVISORY_GIT_TIMEOUT_MS = 2000;

/**
 * wao/run_* 分支帽（决定 0042 起 SSOT 在此；hygiene.mjs re-export）。
 * 只降不升——上调须 Owner 明示 + 同步 hygieneGitState 只降钉。
 */
export const BRANCH_CAP = 185; // 2026-09-30 baseline 151 + headroom（2026-10-02 抬至 185——最后一次抬升）

/** ADR 0035 S3 固定行文案（两个计数是仅有的动态内容；无其他动态载荷）。
 * 2026-10-02 指路扩展（Owner 指示）：行尾加清退 SOP 短指路——Lead agent 依此
 * 找到处置规程（场景 7b：分类→批准→bundle→执行→收口五步）。仍为静态文本。 */
function advisoryLine(worktrees, waoRunBranches) {
  return `[wao] advisory: worktrees=${worktrees} waoRunBranches=${waoRunBranches} (npm run hygiene; cleanup SOP: docs/usage.md 场景 7b)`;
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

/** 仓库根（状态键）——`git rev-parse --show-toplevel`。 */
function repoRoot(exec, cwd) {
  return execGit(exec, cwd, "git rev-parse --show-toplevel").trim();
}

/**
 * 上次弹出的计数状态文件：<stateDir>/dispatch-advisory-<sha8(root)>.json，
 * 只存两个整数。读失败 → null（视为"变化"，保守弹一次）。
 */
function readLastState(stateDir, root) {
  try {
    const raw = readFileSync(join(stateDir, `dispatch-advisory-${createHash("sha256").update(root).digest("hex").slice(0, 12)}.json`), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.worktrees === "number" && typeof parsed?.waoRunBranches === "number") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function writeLastState(stateDir, root, counts) {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, `dispatch-advisory-${createHash("sha256").update(root).digest("hex").slice(0, 12)}.json`), JSON.stringify(counts));
  } catch {
    // 状态写失败：静默忽略——下次按"变化"重弹（保守可见，不丢信号）。
  }
}

/**
 * 渲染 ADR 0035 S3 的派发启动 advisory 行，或返回 null（静默/失败均省略）。
 * 决定 0042 弹行规则：变化 OR 超帽 才弹；帽内无变化静默。
 *
 * @param {string} cwd — 采样目录（git 事实 repo 级一致）
 * @param {{exec?: Function, stateDir?: string, branchCap?: number}} [opts]
 *   · exec — 可注入子进程执行器（默认 node execSync）；
 *   · stateDir — 上次计数状态目录（默认 %LOCALAPPDATA%\wao；测试注入 temp）；
 *   · branchCap — 分支帽（默认本模块 BRANCH_CAP）。
 * @returns {string|null} 固定格式行；任一计数失败（含超时、非 git 目录、输出
 *   不可解析）→ null，绝不抛错
 */
export function renderDispatchResourceAdvisory(cwd, { exec = execSync, stateDir, branchCap = BRANCH_CAP } = {}) {
  let worktrees;
  let waoRunBranches;
  let root;
  try {
    worktrees = countWorktrees(exec, cwd);
    waoRunBranches = countRunBranches(exec, cwd);
    root = repoRoot(exec, cwd);
  } catch {
    // fail-open（advisory discipline）：任何失败都省略整行——不报错、
    // 不加失败码、不阻塞派发。
    return null;
  }
  const dir = stateDir ?? join(process.env.LOCALAPPDATA ?? tmpdir(), "wao");
  const prev = readLastState(dir, root);
  const changed = prev === null
    || prev.worktrees !== worktrees
    || prev.waoRunBranches !== waoRunBranches;
  const overCap = waoRunBranches > branchCap;
  if (!changed && !overCap) {
    // 决定 0042 ①②：帽内且与上次一致 → 静默（治警报疲劳）。
    return null;
  }
  if (changed) {
    writeLastState(dir, root, { worktrees, waoRunBranches });
  }
  return advisoryLine(worktrees, waoRunBranches);
}
