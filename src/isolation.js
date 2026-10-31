import { execFileSync } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isValidRunId, gitChildEnv, isCanonicalCommitId } from "./delivery.js";
import { ensureWaoWorktreeExclude } from "./gitLocalExclude.js";

/**
 * Worktree 隔离能力层（M3-1）。
 *
 * 提供统一的 git worktree 创建/删除/列举，供 RunManager 调用。
 * 不决定"要不要隔离"（那是 RunManager 读 agent 配置的事）。
 *
 * worktree 放在 <sourceCwd>/.wao-worktrees/<name>。
 * 用 execFileSync 调 git（结构化参数，不拼 shell 字符串）。
 *
 * M11-1B (reframed)：createWorktree 流程为短事务设计——
 *   1. 校验 runId / repo（worktree authority 由 isolation.js 保有）；
 *   2. await ensureWaoWorktreeExclude(cwd)：在 exclude 专用跨进程锁内
 *      完成 read/normalize/atomic-write/read-back verify，锁立即释放；
 *   3. 锁释放后才执行 `git worktree add`（不持 exclude 锁）。
 * `/.wao-worktrees/` 是稳定 repository-local hygiene rule（spec §4.3）：
 * worktree 删除后仍保留；`git worktree add` 失败时不回滚该规则——规则
 * 只在 exclude ensure 自身失败时回滚到 locked-time bytes。
 */

/**
 * 创建一个独立 worktree。
 * @param {string} sourceCwd 源仓库（主工作树）路径
 * @param {string} name worktree 名称（用作目录名 + 分支名）
 * @param {{commitish?: string}} [opts] optional exact commit/ref to pin the
 *   worktree base to. When supplied, `git worktree add` receives the commitish
 *   so a micro-race on the source HEAD cannot silently change the base (frozen-
 *   base TOCTOU defense). The caller is responsible for validating the value
 *   (RunManager passes a canonical-hex frozen head).
 * @returns {Promise<{path: string, branch: string}>}
 */
export async function createWorktree(sourceCwd, name, opts = {}) {
  if (!isValidRunId(name)) {
    throw new Error(`Invalid worktree name (contains path separators, shell metacharacters, or traversal): ${JSON.stringify(name)}`);
  }
  const cwd = resolve(sourceCwd);
  if (!isGitRepo(cwd)) {
    throw new Error(`${cwd} is not a git repository (worktree requires git)`);
  }
  // 1. Ensure the stable exclude rule under the short exclude lock, then
  //    release the lock. The rule is NOT rolled back if step 2 fails.
  await ensureWaoWorktreeExclude(cwd);
  // 2. git worktree add WITHOUT holding the exclude lock. structured args —
  //    no shell-built command string.
  const wtPath = join(cwd, ".wao-worktrees", name);
  const branch = `wao/${name}`;
  const args = ["worktree", "add", wtPath, "-b", branch];
  if (opts && opts.commitish) {
    // Pin the worktree to an exact commit/ref. --end-of-options is defense-in-
    // depth against an option-like commit-ish (the threaded frozen head is
    // already validated as canonical hex elsewhere).
    args.push("--end-of-options", opts.commitish);
  }
  execFileSync("git", args, {
    cwd,
    // TD-236：交付 worktree 创建/检出禁用 replace objects（gitChildEnv SSOT）。
    env: gitChildEnv(),
    stdio: "pipe",
    windowsHide: true,
  });
  return { path: wtPath, branch };
}

/**
 * 仍做仓库级 `git worktree prune` 的通用清扫路径（serve 维护、runs
 * verify-commit）共用的 `--expire` 判龄窗。
 *
 * git 2.50 的 prune 语义（worktree.c 的 should_prune_worktree）：
 *   - `locked` 文件在场的条目永不 prune；
 *   - `--expire` 只对"gitdir 文件在、它指向的工作树目录已消失"的条目判龄，
 *     判龄看的是管理目录里 `worktrees/<id>/index` 的 mtime：窗内（新鲜）即
 *     保留，超窗或 index 不存在才清；
 *   - "没有 locked、也没有 gitdir 文件"的条目（add 在建管理目录与写 locked
 *     之间的微窗）git 无条件清掉，--expire 管不到。
 *
 * 最后一条是无法从调用方关闭的残余竞争：仓库级 prune 与别的会话正在进行的
 * `git worktree add` 之间永远存在清掉其登记的窗口。因此删除路径
 *（isolation.removeWorktree、worktree reclaim apply）不再做仓库级 prune，只
 * 定向删自己刚删掉的那棵树的管理条目（removeWorktreeAdminEntry）；仓库级
 * 清扫只保留给上面两条通用维护路径，它们接受该残余竞争（清扫时机与 add 并
 * 发的概率低，且后果是对方 add 报错可重试）。
 *
 * 代价：目录刚消失但 index 还新鲜（十分钟内活跃过）的登记最长滞留一个窗，
 * 由下一次通用清扫清掉。
 */
export const WORKTREE_PRUNE_EXPIRE = "10.minutes";

/**
 * 只删一棵树自己的 worktree 管理条目：在 <gitCommonDir>/worktrees/ 下找
 * `gitdir` 文件内容指向 <wtPath>/.git 的那一项，核对 <wtPath> 目录确实已不
 * 在盘上，才删那个管理目录。不碰其他条目、不做仓库级 prune（竞争说明见
 * WORKTREE_PRUNE_EXPIRE）。
 *
 * @param {string} gitCommonDir 仓库 git common dir（绝对真实路径）
 * @param {string} wtPath 刚删掉的树的真实路径
 * @returns {boolean} 是否删掉了一个管理条目
 */
export function removeWorktreeAdminEntry(gitCommonDir, wtPath) {
  try {
    const path = resolve(wtPath);
    if (existsSync(path)) return false; // 树还在：条目是活的，不删
    const adminRoot = join(gitCommonDir, "worktrees");
    let names;
    try {
      names = readdirSync(adminRoot);
    } catch {
      return false;
    }
    const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const want = norm(`${path}${sep}.git`);
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const entryDir = join(adminRoot, name);
      let st;
      try {
        st = lstatSync(entryDir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      let content;
      try {
        content = readFileSync(join(entryDir, "gitdir"), "utf8").trim();
      } catch {
        continue;
      }
      if (norm(content) !== want) continue;
      rmSync(entryDir, { recursive: true, force: true });
      return true;
    }
  } catch {
    /* best-effort：清不掉留给通用清扫 */
  }
  return false;
}

/**
 * 删除 worktree（含目录）。
 * @param {string} wtPath worktree 路径
 * @param {{execFn?: Function}} [opts] 测试缝（缺省 execFileSync；execFn 只用于
 *   worktree remove 调用，源仓库自推与定向登记清理仍走真实 fs/git）
 *
 * git worktree remove 在**源仓库**执行（cwd=源仓库），不是待删目录：Windows 上
 * 子进程以待删目录为 cwd 时，该目录因是进程自身 cwd 而锁死，git 自己的目录删除
 * 必然失败、退回 rmSync 兜底。源仓库从目标树自己的 `git rev-parse
 * --git-common-dir` 推出（common dir 的父目录即主工作树根），不依赖调用方传
 * 入——转录里的 cwd 可能是相对路径或已删掉的外层树。
 *
 * 不做仓库级 prune（与并发 `git worktree add` 存在关不掉的竞争，见
 * WORKTREE_PRUNE_EXPIRE）：树目录删掉后，只定向删这棵树自己的管理条目
 * （removeWorktreeAdminEntry，按 gitdir 内容核对归属）；其他目录已缺失的
 * stale 登记留给 serve 维护 / runs verify-commit 的通用清扫。
 *
 * Windows 上 git worktree remove 偶因文件锁 Permission denied（进程持有句柄）。
 * 解法：先试 git worktree remove，失败则 fallback 到 rmSync 强制删目录 +
 * 定向清理本树管理条目。
 */
export function removeWorktree(wtPath, { execFn = execFileSync } = {}) {
  const path = resolve(wtPath);
  if (!existsSync(path)) return Promise.resolve();
  // 源仓库自推：读不动 git 元数据（树已半死）时回退到以待删目录为 cwd 的旧
  // 行为，保持 best-effort。
  let realCommon = null;
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: path,
      // TD-236：refs/对象读取禁用 replace objects（gitChildEnv SSOT）。
      env: gitChildEnv(),
      encoding: "utf8",
      stdio: "pipe",
      windowsHide: true,
    }).toString().trim();
    realCommon = realpathSync(resolve(path, commonDir));
    if (!existsSync(dirname(realCommon))) realCommon = null;
  } catch { /* 自推失败走旧 cwd */ }
  const execCwd = realCommon ? dirname(realCommon) : path;
  // 重试内层：git worktree remove 失败 → rmSync 强删（均落源仓库）。
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 100;
  let attempt = 0;
  let removed = false;
  while (attempt < MAX_RETRIES && !removed) {
    attempt += 1;
    try {
      execFn("git", ["worktree", "remove", "--force", path], {
        cwd: execCwd,
        // TD-236：worktree 清理同样禁用 replace objects（gitChildEnv SSOT）。
        env: gitChildEnv(),
        stdio: "pipe",
        windowsHide: true,
      });
      removed = true;
    } catch {
      // fallback：强制删目录，登记走后面的定向清理
      try {
        rmSync(path, { recursive: true, force: true });
        removed = !existsSync(path);
      } catch { /* 尽力，下次重试 */ }
    }
    // 仍未删除且还有重试机会 → 退避等待（同步 sleep，worktree 删除非热路径，可接受）
    if (!removed && attempt < MAX_RETRIES) {
      const end = Date.now() + RETRY_DELAY_MS * attempt; // 线性退避 100/200ms
      while (Date.now() < end) { /* busy wait */ }
    }
  }
  // 只删本树自己的管理条目：git worktree remove 成功时 git 已自清（这里是无害
  // 的幂等核对）；rmSync 兜底后清残留。树目录仍在（删除失败）时条目是活的，
  // 不清。
  if (realCommon && !existsSync(path)) removeWorktreeAdminEntry(realCommon, path);
  return Promise.resolve();
}

// ===== 终态零丢失自动回收（只删树，分支一律保留）============================
//
// 供 Run 终态收尾路径（_runCleanup，停止验证之后）回收普通 persistent 隔离树。
// 与 removeWorktree 的差别是安全模型：不加 --force、单发、不重试、绝无
// rmSync(force) 兜底——删除失败或删后目录仍在时如实返回 false（调用方记
// still_present 保留），宁可留着也不强删。判定门在 terminalWorktreeVerdict，
// 通过全部删除条件（内容全净、HEAD 附着在自己的分支 tip、无嵌套、无共享）
// 的树 git 无需 force 即可删除；force 在本路径是多余权力，去掉。

/**
 * 只删一棵树的保守删除原语：`git worktree remove`（无 --force），单发。
 *
 * 源仓库自推同 removeWorktree（在源仓库执行，避免 Windows 上待删目录作为
 * 子进程 cwd 被锁死）；自推失败时以待删目录为 cwd 兜底执行——该形状下 git
 * 会拒绝（不能删除当前工作树），如实返回 false。
 *
 * 成功判定 = 事后目录不在盘上。git worktree remove 成功时自清管理条目；
 * 本函数不做任何 rmSync/管理条目清理（没有 force 兜底就没有残留条目要补）。
 *
 * @param {string} wtPath worktree 路径
 * @param {{execFn?: Function}} [opts] 测试缝（缺省 execFileSync）
 * @returns {boolean} 目录已不在（含本来就不在）；false = 删除失败或仍在盘上
 */
export function removeWorktreeNoForce(wtPath, { execFn = execFileSync } = {}) {
  const path = resolve(wtPath);
  if (!existsSync(path)) return true;
  let execCwd = path;
  try {
    const commonDir = execFn("git", ["rev-parse", "--git-common-dir"], {
      cwd: path,
      env: gitChildEnv(),
      encoding: "utf8",
      stdio: "pipe",
      windowsHide: true,
    }).toString().trim();
    const realCommon = realpathSync(resolve(path, commonDir));
    if (existsSync(dirname(realCommon))) execCwd = dirname(realCommon);
  } catch { /* 自推失败走待删目录为 cwd（git 拒绝 → false） */ }
  try {
    execFn("git", ["worktree", "remove", path], {
      cwd: execCwd,
      env: gitChildEnv(),
      stdio: "pipe",
      windowsHide: true,
    });
  } catch {
    return false;
  }
  return !existsSync(path);
}

const defaultTerminalGit = (cwd, args) => execFileSync("git", ["--no-optional-locks", ...args], {
  cwd,
  encoding: "utf8",
  env: gitChildEnv(),
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  timeout: 30_000,
}).toString();

/** 大小写折叠路径比较（win32 身份语义，与 worktreeReclaim 的 samePath 同型）。 */
function samePathFold(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

/** child 是否严格位于 ancestor 之下一级以上（段边界，非前缀字符串）。 */
function isBelowPath(child, ancestor) {
  if (typeof child !== "string" || typeof ancestor !== "string" || child.length <= ancestor.length) return false;
  const a = ancestor.endsWith(sep) ? ancestor : ancestor + sep;
  return child.startsWith(a);
}

/**
 * 终态自动回收的树侧判定核心（纯函数，测试可注入 git/io）。求值顺序即安全
 * 顺序，命中即停；任一条读不出按保留处理并给出闭集原因：
 *
 *   gone               目录已不在盘上（already_gone 事实，非失败）
 *   unproven_path      身份不可证：树路径的父段名不是 .wao-worktrees、目录名
 *                      不是本 runId、lstat 非目录/是符号链接或 junction、
 *                      realpath 与词法路径不一致（路径链上有链接）、不在 git
 *                      worktree 登记、是源工作树、真实路径不等于 <run.started
 *                      .cwd 的真实路径>/.wao-worktrees/<runId>（本 run 自己的
 *                      派发目录锚——从关联工作树派发的树同样可证；嵌套树不在
 *                      本路径处置）、与 run.started.cwd 的 common git dir 不同仓
 *   content_present    git status --porcelain=v1 -z --untracked-files=all
 *                      --ignored=matching 非空（staged/unstaged/untracked/
 *                      ignored 都算内容——被 ignore 的产物也是内容）
 *   inventory_unreadable 内容清点不了：status 或 ls-files 读失败、索引带
 *                      skip-worktree/assume-unchanged/非正常缓存位、含子模块
 *                     （gitlink）、.wao-worktrees 子目录扫描失败
 *   not_tip            HEAD 不附着在 wao/<runId>（detached/别的分支），或
 *                      HEAD 不等于该分支 tip，或 git 读不出（归属不可证）
 *   nested_tree_present 树下有登记在册的嵌套 worktree，或 .wao-worktrees/ 下
 *                      有未登记但有内容的子目录
 *   ready              全部门通过，可删
 *
 * 只读 git 调用统一带 --no-optional-locks（裸 git status 会刷新索引=写盘）。
 *
 * @param {object} p
 * @param {string} p.worktreePath 本 run 绑定的 run.started.worktreePath（调用方
 *   保证来自绑定事实，不按名字推导）
 * @param {string} p.runId
 * @param {string} p.repoCwd 绑定的 run.started.cwd（源仓库锚，缺席时用 agent.cwd）
 * @param {Function} [p.git] (cwd, args) => stdout；缺省真实 git
 * @param {object} [p.io] {existsSync, lstatSync, realpathSync, readdirSync}
 * @returns {"gone"|"unproven_path"|"content_present"|"inventory_unreadable"|"not_tip"|"nested_tree_present"|"ready"}
 */
export function terminalWorktreeVerdict({
  worktreePath, runId, repoCwd,
  git = defaultTerminalGit,
  io = { existsSync, lstatSync, realpathSync, readdirSync },
}) {
  if (typeof worktreePath !== "string" || worktreePath.length === 0) return "unproven_path";
  if (!io.existsSync(worktreePath)) return "gone";
  // ── 身份 ──
  // 父段名 = .wao-worktrees（段级、大小写折叠、双分隔符；与验收放树的路径
  // 证明同款归一）。
  const norm = worktreePath.replace(/\//g, "\\").replace(/\\+$/, "");
  const idx = norm.lastIndexOf("\\");
  const parent = idx > 0 ? norm.slice(0, idx) : "";
  const pidx = parent.lastIndexOf("\\");
  const parentName = pidx >= 0 ? parent.slice(pidx + 1) : parent;
  if (parentName.toLowerCase() !== ".wao-worktrees") return "unproven_path";
  if (typeof runId !== "string" || !isValidRunId(runId) || basenameOf(worktreePath) !== runId) {
    return "unproven_path";
  }
  let st;
  try {
    st = io.lstatSync(worktreePath);
  } catch {
    return "unproven_path";
  }
  if (!st?.isDirectory() || st.isSymbolicLink()) return "unproven_path";
  // 路径链无链接：realpath 解析 reparse 目标，与词法 resolve 不一致即链上有
  // symlink/junction/短名（比较按大小写折叠——盘符与目录大小写形态不构成不一致）。
  let wtReal;
  try {
    wtReal = io.realpathSync(worktreePath);
  } catch {
    return "unproven_path";
  }
  if (!samePathFold(wtReal, resolve(worktreePath))) return "unproven_path";
  // git 登记 + 源工作树 + 主检出形状 + 同仓锚。
  let entries;
  try {
    entries = parseWorktreeList(git(wtReal, ["worktree", "list", "--porcelain"]));
  } catch {
    return "unproven_path";
  }
  const registered = entries.map((e) => {
    const raw = resolve(e.path);
    let real = null;
    try {
      real = io.realpathSync(raw);
    } catch { /* 缺失登记不参与身份比较 */ }
    return { raw, real };
  });
  if (!registered.some((e) => e.real != null && samePathFold(e.real, wtReal))) return "unproven_path";
  let mainReal = null;
  try {
    mainReal = io.realpathSync(registered[0].raw);
  } catch {
    return "unproven_path";
  }
  if (samePathFold(mainReal, wtReal)) return "unproven_path"; // 源工作树
  // 身份锚 = 本 run 自己的派发目录：树的真实路径必须等于 <run.started.cwd
  // 的真实路径>/.wao-worktrees/<runId>（createWorktree 恒建在 join(resolve(
  // agent.cwd), ".wao-worktrees", runId)，run.started.cwd 记的就是 agent.cwd）。
  // 从关联工作树派发的树同样可证；主检出不再参与身份判定（同仓归属由下方
  // common git dir 锚钉住）。
  if (typeof repoCwd !== "string" || repoCwd.length === 0) return "unproven_path";
  let repoReal;
  try {
    repoReal = io.realpathSync(repoCwd);
  } catch {
    return "unproven_path";
  }
  if (!samePathFold(wtReal, joinSep(joinSep(repoReal, ".wao-worktrees"), runId))) {
    return "unproven_path";
  }
  let treeCommonReal;
  let repoCommonReal;
  try {
    treeCommonReal = io.realpathSync(resolve(wtReal, git(wtReal, ["rev-parse", "--git-common-dir"]).trim()));
    repoCommonReal = io.realpathSync(resolve(repoCwd, git(repoCwd, ["rev-parse", "--git-common-dir"]).trim()));
  } catch {
    return "unproven_path";
  }
  if (!samePathFold(treeCommonReal, repoCommonReal)) return "unproven_path";
  // ── 内容全净（被 ignore 的产物也算内容；清点不了按保留）──
  let statusOut;
  try {
    // 旗写在调用处（守卫只认调用处）；缺省的 defaultTerminalGit 另有前置，git 接受重复的全局选项。
    statusOut = git(wtReal, [
      "--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching",
    ]);
  } catch {
    return "inventory_unreadable";
  }
  if (statusOut.length > 0) return "content_present";
  let lsVerbose;
  let lsStage;
  try {
    lsVerbose = git(wtReal, ["ls-files", "-v"]);
    lsStage = git(wtReal, ["ls-files", "-s"]);
  } catch {
    return "inventory_unreadable";
  }
  // 正常缓存位是大写 H；S=skip-worktree、小写=assume-unchanged、其余字母=
  // removed/changed/unmerged 等状态——凡清点不了的一律保留。
  if (lsVerbose.split(/\r?\n/).some((line) => line.length > 0 && !line.startsWith("H "))) {
    return "inventory_unreadable";
  }
  if (lsStage.split(/\r?\n/).some((line) => line.startsWith("160000 "))) return "inventory_unreadable";
  // ── 提交都在分支上 ──
  const branch = `wao/${runId}`;
  let head;
  let tip;
  try {
    const short = git(wtReal, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    if (short !== branch && short !== `refs/heads/${branch}`) return "not_tip";
    head = git(wtReal, ["rev-parse", "HEAD"]).trim();
    tip = git(wtReal, ["rev-parse", `refs/heads/${branch}`]).trim();
  } catch {
    return "not_tip"; // git 读不出 = 归属不可证
  }
  if (!/^[0-9a-f]{40}$/.test(head) || !/^[0-9a-f]{40}$/.test(tip)
    || head.toLowerCase() !== tip.toLowerCase()) {
    return "not_tip";
  }
  // ── 结构：无嵌套在册树、无未登记有内容的子目录、不共享 ──
  // 在册嵌套树按登记 raw 路径与真实路径双匹配：子树目录已从盘上消失的悬空
  // 登记（prunable）realpath 失效，但登记仍在册——照字面条件保留（git 对该
  // 形状的父树不加 force 也能删，靠这里挡）。
  const selfRaw = resolve(worktreePath);
  if (registered.some((e) => !samePathFold(e.raw, selfRaw)
    && ((e.real != null && isBelowPath(e.real, wtReal)) || isBelowPath(e.raw, selfRaw)))) {
    return "nested_tree_present";
  }
  const nestedRoot = joinSep(wtReal, ".wao-worktrees");
  let nestedNames;
  try {
    if (io.existsSync(nestedRoot)) {
      const rootSt = io.lstatSync(nestedRoot);
      if (!rootSt.isDirectory() || rootSt.isSymbolicLink()) return "nested_tree_present";
      nestedNames = io.readdirSync(nestedRoot);
    }
  } catch {
    return "inventory_unreadable";
  }
  if (nestedNames) {
    for (const name of nestedNames) {
      const child = joinSep(nestedRoot, name);
      let childSt;
      try {
        childSt = io.lstatSync(child);
      } catch {
        return "inventory_unreadable";
      }
      if (childSt.isSymbolicLink() || !childSt.isDirectory()) return "nested_tree_present";
      let childEntries;
      try {
        childEntries = io.readdirSync(child);
      } catch {
        return "inventory_unreadable";
      }
      if (childEntries.length > 0) return "nested_tree_present"; // 未登记但有内容
    }
  }
  return "ready";
}

/** 词法 basename（不触盘；Windows 两分隔符都认）。 */
function basenameOf(p) {
  const norm = p.replace(/\//g, "\\").replace(/\\+$/, "");
  const i = norm.lastIndexOf("\\");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

/** 以原生分隔符 join（realpath 产出的路径与 node:path join 同分隔符形态）。 */
function joinSep(dir, name) {
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

/**
 * 列出所有 worktree。
 * @param {string} cwd 仓库路径
 * @returns {Promise<Array<{path: string, branch?: string, head?: string}>>}
 */
export function listWorktrees(cwd) {
  const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: resolve(cwd),
    encoding: "utf8",
    env: gitChildEnv(),
    stdio: "pipe",
    windowsHide: true,
  });
  return Promise.resolve(parseWorktreeList(out));
}

/**
 * TD-260（决定 0062 丙′，审核修订版）：回收 ephemeral 只读 run 的 `wao/<runId>` 分支。
 *
 * 前置：调用点（RunManager._releaseDeferredWorktree）只在停止确认后的释放路径调用
 * ——ephemeral 只读（结构性门=deferredWorktreeRelease 赋值点，0057 W1a）与停止确认
 * 两道门已在彼处成立。本函数做第四道门：分支零独有提交——判据=分支可达集减去
 * **其余全部本地分支与本地 tag**（`--not --exclude=<self> --branches/--tags`，参数长度
 * 固定、无命令行长度帽；remote-tracking 不在排除集=仅由 remote 保住的提交会被保守计为
 * 独有——readOnly 只是声明不强制，违规 worker 的独有提交是必须保留的证据）。
 * 这是 0060 例外证据形（tip==main）的**放宽**：被任何其他本地 ref 覆盖的零独有分支
 * 也可回收（0057 修订节明文此差异；提交零丢失性质不变——sol 审核口径统一）。
 *
 * 删除用 `git branch -d`（非 -D）：-d 要求分支已合并进 HEAD（主 checkout 检出处）或
 * 上游——主 checkout 在非 main 分支/detached 时 -d 常态拒绝 → kept{delete_failed}
 * （保守保留；分支仍被在册 worktree 检出时同样拒绝）。
 * 全程 best-effort：探测/删除失败 → 保留 + 闭集 reason，绝不抛出。
 *
 * @param {string} sourceCwd 源仓库（主工作树）路径——worktree 可能已删，git 操作
 *   落在源仓（refs 在 common git dir，仓库级一致）。
 * @param {string} runId 合法 runId（分支名 = wao/<runId>，创建侧同款校验）。
 * @param {{execFn?: Function}} [opts] 测试缝（默认 execFileSync）。
 * @returns {{outcome: "absent"|"recycled"|"kept", uniqueCommits?: number, reason?: "probe_failed"|"delete_failed"}}
 */
export function recycleRunBranch(sourceCwd, runId, { execFn = execFileSync } = {}) {
  if (!isValidRunId(runId)) return { outcome: "absent" };
  const branch = `wao/${runId}`;
  const cwd = resolve(sourceCwd);
  const git = (args) => execFn("git", args, {
    cwd,
    // TD-236 同款：refs 遍历/删除禁用 replace objects（gitChildEnv SSOT）。
    env: gitChildEnv(),
    stdio: "pipe",
    windowsHide: true,
  });
  // 分支存在性：exit 1 = 确定不存在（absent）；其它失败（含 git 不可用）= 探测失败
  // 保留（sol 审核条款：未知不得折叠为 absent）。
  try {
    git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  } catch (err) {
    if (err && err.status === 1) return { outcome: "absent" };
    return { outcome: "kept", reason: "probe_failed" };
  }
  // 零独有判定：正向 revision 用全名（同名 tag 优先于短名解析——opus 审核条款）；
  // 计数解析拒绝非数字/空输出（注入缝不得伪造 0）。--exclude 匹配去前缀名，须在
  // 每个 ref-glob 前重复（git rev-list 语义）。
  let unique;
  try {
    const out = String(git([
      "rev-list", "--count", `refs/heads/${branch}`,
      "--not", `--exclude=${branch}`, "--branches",
      `--exclude=${branch}`, "--tags",
    ])).trim();
    if (!/^\d+$/.test(out)) return { outcome: "kept", reason: "probe_failed" };
    unique = Number(out);
  } catch {
    return { outcome: "kept", reason: "probe_failed" };
  }
  if (unique > 0) return { outcome: "kept", uniqueCommits: unique };
  try {
    git(["branch", "-d", branch]);
  } catch {
    return { outcome: "kept", reason: "delete_failed" };
  }
  return { outcome: "recycled" };
}

// ===== 决定 0102：ephemeral 只读运行的私有克隆原语 ==========================
//
// 链接工作树的 .git 是指向共享 common dir 的一个文件：席位在自己树里跑
// `git config` / `git branch` / `git worktree add`，写的全是共享仓（TD-310 实锤）。
// 私有克隆 = 源仓 .wao-worktrees/<runId> 下的 `git clone --shared --no-checkout`
// 副本：有自己的 .git 目录，一切写仓库的命令都落在克隆里；对象借自源仓
//（alternates 由 git 自己写），分支活在克隆里，源仓既没有它的 worktree 登记
// 也没有它的分支。因此 0062 的链接树分支回收与 removeWorktree 对克隆一律不
// 适用——删除就是删目录（removeReadOnlyClone），删前先做证据检查
//（probeReadOnlyClone）。

/** 克隆 remote.origin.pushurl 的固定不可用值（.invalid 是保留 TLD，永不可达）。 */
export const READ_ONLY_CLONE_PUSHURL = "https://wao.invalid/push-forbidden";

/**
 * 建一个只读运行的私有克隆（决定 0102）。
 *
 * 与 createWorktree 并列的另一形态：createWorktree 不动，它还服务交付与
 * persistent 树。clone 成功之后任一步失败都删掉半建目录再抛出——调用方
 *（RunManager）按现有只读隔离失败路径抛 ReadOnlyWorktreeRequiredError，绝不
 * 回退到源仓。
 *
 * 源仓的本地 config 不复制（git clone 的默认行为）；本机要紧的 core.longpaths /
 * core.autocrlf 是全局配置照常生效。alternates 的路径由 git 按 realpath 落盘，
 * 源仓本身是一棵链接工作树时同样指向 common dir 的对象库。
 *
 * @param {string} sourceCwd 源仓库（主工作树或链接工作树）路径
 * @param {string} runId 运行 id（目录名 + 分支名，校验同 createWorktree）
 * @param {{commitish?: string}} [opts] 冻结基点（调用方负责传 canonical hex）；
 *   缺省取源仓 HEAD 的提交。解析成完整 SHA 后才建克隆——解析不了即拒绝。
 * @returns {Promise<{path: string, branch: string, baseCommit: string, form: "private_clone"}>}
 */
export async function createReadOnlyClone(sourceCwd, runId, { commitish } = {}) {
  if (!isValidRunId(runId)) {
    throw new Error(`Invalid worktree name (contains path separators, shell metacharacters, or traversal): ${JSON.stringify(runId)}`);
  }
  const cwd = resolve(sourceCwd);
  if (!isGitRepo(cwd)) {
    throw new Error(`${cwd} is not a git repository (worktree requires git)`);
  }
  await ensureWaoWorktreeExclude(cwd);
  const clonePath = join(cwd, ".wao-worktrees", runId);
  const branch = `wao/${runId}`;
  // 失败清理只删本次 clone 成功建出的目录：目标已存在且非空时 git clone 自己
  // 拒绝，这里不删别人的东西。
  let cloned = false;
  try {
    // 1. 基点先解析成完整 SHA（--end-of-options 防选项形 commitish，同
    //    createWorktree 的纵深防御）。
    const baseCommit = execFileSync("git", [
      "rev-parse", "--verify", "--end-of-options", `${commitish || "HEAD"}^{commit}`,
    ], {
      cwd,
      env: gitChildEnv(),
      encoding: "utf8",
      stdio: "pipe",
      windowsHide: true,
    }).toString().trim();
    if (!isCanonicalCommitId(baseCommit)) {
      throw new Error(`base commit resolution returned a non-SHA: ${JSON.stringify(baseCommit)}`);
    }
    // 2. 共享克隆（不检出；-- 结束选项区，防源/目标路径以 - 开头）。clone 自己
    //    失败时会删掉它建出的目录。
    execFileSync("git", ["clone", "--shared", "--no-checkout", "--quiet", "--", cwd, clonePath], {
      cwd,
      env: gitChildEnv(),
      stdio: "pipe",
      windowsHide: true,
    });
    cloned = true;
    // 3. 克隆里建 wao/<runId> 并检出冻结基点（--no-checkout 的克隆此刻没有
    //    工作区文件，本步把基点内容落到盘上）。
    execFileSync("git", ["checkout", "-q", "-b", branch, baseCommit], {
      cwd: clonePath,
      env: gitChildEnv(),
      stdio: "pipe",
      windowsHide: true,
    });
    // 4. 挡误用 origin 的推送：pushurl 覆盖 push 方向的 url。只挡克隆→源仓
    //    的误用；席位显式写源仓路径挡不住（决定 0102 已知边界）。
    execFileSync("git", ["config", "remote.origin.pushurl", READ_ONLY_CLONE_PUSHURL], {
      cwd: clonePath,
      env: gitChildEnv(),
      stdio: "pipe",
      windowsHide: true,
    });
    return { path: clonePath, branch, baseCommit, form: "private_clone" };
  } catch (error) {
    // clone 成功之后的步骤失败：半建的克隆不留给普查。clone 之前或 clone 本身
    // 失败（含目标已被别人占用）不删——那不是本次建的。
    if (cloned) {
      try { rmSync(clonePath, { recursive: true, force: true }); } catch { /* 尽力 */ }
    }
    throw error;
  }
}

/**
 * 私有克隆的删前证据检查（决定 0102）：纯读、不抛错，任何 git 失败都按保留
 * 处理（probe_failed）——删克隆丢的是克隆自己对象库里的东西，宁可错留。
 *
 * 求值顺序即安全顺序：
 *   1. 在克隆里列出除 refs/stash 外全部引用与 HEAD 可达、基点不可达的提交，
 *      再到源仓的对象库里逐个查：源仓没有的，就是在克隆里新写的提交（新对象
 *      只写进克隆自己的对象库，删克隆丢的正是这些）。只认对象在哪、不认克隆
 *      里引用的值（引用席位能改）；源仓在运行期间删掉的分支，对象仍在源仓，
 *      不会误算。个数 > 0 → keep 带数；
 *   2. HEAD 不附着在 refs/heads/<branch>（detached / 换了分支）→ head_drift；
 *   3. 克隆里登记了别的工作树 → nested_worktree；
 *   4. 全过 → clean。
 *
 * @param {string} clonePath 克隆目录
 * @param {{branch: string, baseCommit: string, sourceCwd: string}} bound 绑定事实
 *   （branch=wao/<runId>；baseCommit=冻结基点完整 SHA；sourceCwd=建克隆的源仓）。
 *   形制不对按 probe_failed 保留（fail-closed，绑定残缺的克隆绝不删）。
 * @param {{execFn?: Function}} [opts] 测试缝（缺省 execFileSync）。
 * @returns {{outcome: "clean"} | {outcome: "keep", uniqueCommits?: number, reason?: "probe_failed"|"head_drift"|"nested_worktree"}}
 */
export function probeReadOnlyClone(clonePath, { branch, baseCommit, sourceCwd } = {}, { execFn = execFileSync } = {}) {
  const path = resolve(clonePath);
  try {
    if (typeof branch !== "string" || branch.length === 0
      || !isCanonicalCommitId(baseCommit)
      || typeof sourceCwd !== "string" || sourceCwd.length === 0) {
      return { outcome: "keep", reason: "probe_failed" };
    }
    // 只处置真克隆：.git 是目录（链接工作树的 .git 是文件——删目录会丢掉它的
    // 改动并在源仓留下孤儿登记）。
    if (!lstatSync(join(path, ".git")).isDirectory()) return { outcome: "keep", reason: "probe_failed" };
    const gitIn = (cwd, args, input) => String(execFn("git", args, {
      cwd,
      env: gitChildEnv(),
      encoding: "utf8",
      stdio: "pipe",
      windowsHide: true,
      ...(input != null ? { input } : {}),
    }));
    const git = (args) => gitIn(path, args);
    const candidates = git(["rev-list", "--exclude=refs/stash", "--all", "--not", baseCommit])
      .split(/\r?\n/).filter((l) => l.length > 0);
    if (!candidates.every(isCanonicalCommitId)) return { outcome: "keep", reason: "probe_failed" };
    if (candidates.length > 0) {
      const answers = gitIn(resolve(sourceCwd), ["cat-file", "--batch-check"], `${candidates.join("\n")}\n`)
        .split(/\r?\n/).filter((l) => l.length > 0);
      if (answers.length !== candidates.length) return { outcome: "keep", reason: "probe_failed" };
      let uniqueCommits = 0;
      // 答复只认两种形状：`<oid> missing` 与 `<oid> commit <size>`，其余一律读不出。
      for (let i = 0; i < candidates.length; i += 1) {
        if (answers[i] === `${candidates[i]} missing`) uniqueCommits += 1;
        else if (!/^commit \d+$/.test(answers[i].slice(candidates[i].length + 1))
          || !answers[i].startsWith(`${candidates[i]} `)) return { outcome: "keep", reason: "probe_failed" };
      }
      if (uniqueCommits > 0) return { outcome: "keep", uniqueCommits };
    }
    const short = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    if (short !== branch && short !== `refs/heads/${branch}`) {
      return { outcome: "keep", reason: "head_drift" };
    }
    if (parseWorktreeList(git(["worktree", "list", "--porcelain"])).length > 1) {
      return { outcome: "keep", reason: "nested_worktree" };
    }
    return { outcome: "clean" };
  } catch {
    return { outcome: "keep", reason: "probe_failed" };
  }
}

/**
 * 删除私有克隆目录（决定 0102）：有界重试的 rmSync（写法照 removeWorktree 的
 * 重试循环），绝不调 `git worktree remove`——源仓里没有克隆的登记，git 只会
 * 拒绝。路径 resolve 成绝对路径后只落在目录本身，不以克隆为任何进程的 cwd
 *（Windows 上克隆作为进程 cwd 会被锁死）。删除失败不抛出，调用方以
 * existsSync 为准记 worktree_release_failed。
 *
 * @param {string} clonePath 克隆目录
 */
export function removeReadOnlyClone(clonePath) {
  const path = resolve(clonePath);
  if (!existsSync(path)) return;
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 100;
  let attempt = 0;
  let removed = false;
  while (attempt < MAX_RETRIES && !removed) {
    attempt += 1;
    try {
      rmSync(path, { recursive: true, force: true });
      removed = !existsSync(path);
    } catch { /* 尽力，下次重试 */ }
    if (!removed && attempt < MAX_RETRIES) {
      const end = Date.now() + RETRY_DELAY_MS * attempt; // 线性退避 100/200ms
      while (Date.now() < end) { /* busy wait */ }
    }
  }
}

function parseWorktreeList(porcelain) {
  const entries = [];
  let current = null;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length).trim() };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim();
    } else if (line.trim() === "") {
      if (current) {
        entries.push(current);
        current = null;
      }
    }
  }
  if (current) entries.push(current);
  return entries;
}

function isGitRepo(cwd) {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd,
      env: gitChildEnv(),
      stdio: "pipe",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}
