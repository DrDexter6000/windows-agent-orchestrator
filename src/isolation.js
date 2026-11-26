import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { isValidRunId, gitChildEnv, gitProbeEnv, isCanonicalCommitId } from "./delivery.js";
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
 * 在 <gitCommonDir>/worktrees/ 下找 `gitdir` 文件内容指向 <wtPath>/.git 的那个管理目录
 *（只读，不看 <wtPath> 在不在）。
 *
 * gitdir 的写法有两种：默认是绝对路径；`git worktree add --relative-paths`（或
 * worktree.useRelativePaths=true，git 2.48+）写的是**相对路径，基准是它所在的管理条目目录**
 *（不是 common dir，也不是当前目录）。相对写法要先以条目目录为基准解析成绝对路径再比——
 * 直接拿绝对路径跟相对文本比永远对不上，树删了、登记留着（第 150 批修正二）。
 *
 * @param {string} gitCommonDir 仓库 git common dir（绝对真实路径）
 * @param {string} wtPath 树的路径
 * @returns {string | null} 管理目录的路径；找不到（或读不出）为 null
 */
export function findWorktreeAdminEntry(gitCommonDir, wtPath) {
  try {
    const path = resolve(wtPath);
    const adminRoot = join(gitCommonDir, "worktrees");
    let names;
    try {
      names = readdirSync(adminRoot);
    } catch {
      return null;
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
      const absolute = isAbsolute(content) ? content : resolve(entryDir, content);
      if (norm(absolute) === want) return entryDir;
    }
  } catch {
    /* 读不出：当作没找到 */
  }
  return null;
}

/**
 * 只删一棵树自己的 worktree 管理条目：用 findWorktreeAdminEntry 找到 `gitdir` 指向
 * <wtPath>/.git 的那一项，核对 <wtPath> 目录确实已不在盘上，才删那个管理目录。不碰其他
 * 条目、不做仓库级 prune（竞争说明见 WORKTREE_PRUNE_EXPIRE）。
 *
 * @param {string} gitCommonDir 仓库 git common dir（绝对真实路径）
 * @param {string} wtPath 刚删掉的树的真实路径
 * @returns {boolean} 管理条目是否确实已不在盘上（删掉了，或本来就没有则为 false）
 */
export function removeWorktreeAdminEntry(gitCommonDir, wtPath) {
  try {
    if (pathPresent(resolve(wtPath))) return false; // 树还在：条目是活的，不删
    const entryDir = findWorktreeAdminEntry(gitCommonDir, wtPath);
    if (entryDir === null) return false;
    rmSync(entryDir, { recursive: true, force: true });
    // rmSync 可能只删了一半（Windows 上目录被进程以 cwd 占着：里面的文件删了、目录删不掉）。
    return !existsSync(entryDir);
  } catch {
    /* best-effort：清不掉留给通用清扫 */
  }
  return false;
}

/** 路径本身（不跟进）是不是符号链接 / junction（Node 的 lstat 把两者都报成符号链接）。 */
function isLinkAt(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 路径本身（不跟进链接）是否在盘上。悬空的链接也算在——existsSync 会跟进链接、把悬空链接
 * 看成"不存在"，拿它判"树已经不在了"会把一个还留在盘上的链接报成已删（第 150 批修正二）。
 */
export function pathPresent(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** 树里有目录型链接（junction 或目录符号链接）——保守删除原语的闭集拒绝原因。 */
export const TREE_CONTAINS_JUNCTION = "tree_contains_junction";

/**
 * 不跟进链接地遍历一棵树（只 readdir / stat，不写盘），找出会让 `git worktree remove`
 * 与 `git diff` 读出或删到树外的东西（第 150 批修正一）：Windows 上 git 删树会跟进
 * **junction**，把目标目录里的文件一并删掉（git 2.50.1.windows.1 实测；被忽略的
 * junction 无 --force 也照删），`git diff` 对被换成 junction 的受控目录也会读进目标内容。
 *
 * Node 的 lstat / stat / Dirent / readlink 分不出 junction 与目录符号链接（实测完全一
 * 样），所以凡是"自己是链接、目标不是普通文件"的一律按危险报（保守：多留树，不多删）：
 *   - 链接且 stat 为目录                → why = "directory_link"
 *   - 链接且 stat 失败（悬空、读不出）  → why = "dangling:<code>"
 *   - 目录读不出                        → why = "unreadable:<code>"（证明不了安全）
 * 指向文件的符号链接 git 不跟进，不报。libuv 把 symlink / junction 以外的重解析点
 * （云盘占位等）当普通文件或目录，Node 看不见，本函数覆盖不到——这是已知限制。
 *
 * 已知不防：遍历之后、删除之前有人新建 junction（竞态）。
 *
 * @param {string} treePath 树根（调用方保证它自己不是链接，见 isLinkAt）
 * @param {{skip?: string[], io?: {readdirSync: Function, statSync: Function}}} [opts]
 *   skip：不走进去的相对路径（"/" 分隔、大小写折叠比较；在册嵌套树有自己的条目）；
 *   io：测试缝。
 * @returns {{path: string, why: string} | null} 第一处危险（相对路径，"/" 分隔）；没有则 null
 */
export function findTreeLinkHazard(treePath, { skip = [], io = { readdirSync, statSync } } = {}) {
  const skipSet = new Set(skip.map((s) => String(s).replace(/\\/g, "/").toLowerCase()));
  const stack = [""];
  while (stack.length > 0) {
    const rel = stack.pop();
    let entries;
    try {
      entries = io.readdirSync(rel === "" ? treePath : join(treePath, rel), { withFileTypes: true });
    } catch (error) {
      return { path: rel === "" ? "." : rel, why: `unreadable:${error?.code ?? "error"}` };
    }
    for (const ent of entries) {
      const childRel = rel === "" ? ent.name : `${rel}/${ent.name}`;
      if (skipSet.has(childRel.toLowerCase())) continue;
      if (ent.isSymbolicLink()) {
        let target;
        try {
          target = io.statSync(join(treePath, childRel));
        } catch (error) {
          return { path: childRel, why: `dangling:${error?.code ?? "error"}` };
        }
        if (target.isFile()) continue;
        return { path: childRel, why: "directory_link" };
      }
      if (ent.isDirectory()) stack.push(childRel);
    }
  }
  return null;
}

/**
 * 删除 worktree（含目录）。
 * @param {string} wtPath worktree 路径
 *
 * 第 150 批修正一：**不再调用 `git worktree remove --force`**。Windows 上 git 删树会跟进
 * 树里的 junction，把目标目录（树外！）里的文件一并删掉（git 2.50.1.windows.1 实测）。
 * 删树主路径改为 fs.rmSync(recursive)——Node 22 对 junction、目录符号链接、文件符号链接
 * 都不跟进（只删链接本身，实测）——再定向清理本树自己的管理条目。删除前的归属、上锁、
 * 主检出检查照旧；树根自己是链接时不动（只 unlink 链接会让调用方误以为树已释放，真树
 * 还在目标位置，也绕过管理条目的归属核对）。
 *
 * 源仓库从目标树自己的 `git rev-parse --git-common-dir` 推出（common dir 的父目录即
 * 主工作树根），不依赖调用方传入——转录里的 cwd 可能是相对路径或已删掉的外层树。
 *
 * 不做仓库级 prune（与并发 `git worktree add` 存在关不掉的竞争，见
 * WORKTREE_PRUNE_EXPIRE）：树目录删掉后，只定向删这棵树自己的管理条目
 * （removeWorktreeAdminEntry，按 gitdir 内容核对归属）；其他目录已缺失的
 * stale 登记留给 serve 维护 / runs verify-commit 的通用清扫。
 *
 * Windows 上删目录偶因文件锁 Permission denied（进程持有句柄）：rmSync 带有界重试
 *（线性退避），事后目录仍在如实留着，调用方以"目录仍在"判定没删掉。
 *
 * 只删 git 认得出、没上锁的链接工作树（linkedWorktreeEntry）：上了锁的（`git worktree
 * lock`）git 本就拒删，rmSync 却会照删；git 认不出的（树里的 .git 丢了或指错、主检出、
 * 独立仓库、普通目录）看不出锁没锁，同样不碰。
 *
 * 返回值（第 150 批修正二）：`{ removed, registrationLeft }`。removed = 事后路径本身（lstat，
 * 不跟进链接）已不在盘上——悬空的根链接 existsSync 看不见，不能判成"本来就不在"，树根是
 * 链接（有效或悬空）一律不动、removed:false。registrationLeft = 树已删净但本树的管理条目
 * 没清掉时的管理目录路径（相对路径登记认不出、目录被进程占着删不掉等），否则 null——调用方
 * 必须如实报告，不当成功。树没删净时条目是活的，不算残留。
 * @returns {Promise<{removed: boolean, registrationLeft: string | null}>}
 */
export function removeWorktree(wtPath) {
  const path = resolve(wtPath);
  if (isLinkAt(path)) return Promise.resolve({ removed: false, registrationLeft: null });
  if (!existsSync(path)) return Promise.resolve({ removed: true, registrationLeft: null });
  const entry = linkedWorktreeEntry(path);
  if (!entry || entry.locked) return Promise.resolve({ removed: false, registrationLeft: null });
  // 源仓库自推（只为清理管理条目）：git 刚认出这棵树，推不出几乎不会发生；推不出时
  // 管理条目留给通用清扫。
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
  } catch { /* 自推失败：不清管理条目 */ }
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
    // 仍未删除且还有重试机会 → 退避等待（同步 sleep，worktree 删除非热路径，可接受）
    if (!removed && attempt < MAX_RETRIES) {
      const end = Date.now() + RETRY_DELAY_MS * attempt; // 线性退避 100/200ms
      while (Date.now() < end) { /* busy wait */ }
    }
  }
  // 只删本树自己的管理条目。树目录仍在（删除失败）时条目是活的，不清。清完再核对一次：
  // 条目目录还在盘上就如实报残留（findWorktreeAdminEntry 认得相对路径登记）。
  const gone = !pathPresent(path);
  let registrationLeft = null;
  if (realCommon && gone) {
    const adminDir = findWorktreeAdminEntry(realCommon, path);
    if (adminDir !== null) {
      removeWorktreeAdminEntry(realCommon, path);
      if (existsSync(adminDir)) registrationLeft = adminDir;
    }
  }
  return Promise.resolve({ removed: gone, registrationLeft });
}

/**
 * wtPath 在 git 登记里对应的链接工作树条目：在它里面问 `git worktree list`，它必须是主工作树
 * 之后的某个条目。主检出、独立仓库、--separate-git-dir 仓库、子模块、复制出来或伪造 .git
 * 指针的目录、工作树的子目录都不在其列。路径经 realpathSync.native（展开 junction 与 8.3
 * 短名）后按 win32 语义大小写折叠比较；不是或 git 读不出一律 null。
 * @param {string} wtPath
 * @returns {{path: string, head?: string, branch?: string, locked?: true} | null}
 */
export function linkedWorktreeEntry(wtPath) {
  const real = (p) => realpathSync.native(p).toLowerCase();
  try {
    const target = real(resolve(wtPath));
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: resolve(wtPath),
      env: gitProbeEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return parseWorktreeList(out).slice(1).find((entry) => {
      try {
        return real(entry.path) === target;
      } catch {
        return false;
      }
    }) ?? null;
  } catch {
    return null;
  }
}

// ===== 终态零丢失自动回收（只删树，分支一律保留）============================
//
// 供 Run 终态收尾路径（_runCleanup，停止验证之后）回收普通 persistent 隔离树。
// 与 removeWorktree（rmSync 强删）的差别是安全模型：交给 git 的"不干净就拒绝"、单发、
// 不重试、绝无 rmSync 兜底——删除失败或删后目录仍在时如实返回 false（调用方记
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
 * 第 150 批修正一：调用 git 之前先做一遍**不写入**的检查（findTreeLinkHazard，不跟进链接
 * 遍历整棵树）。无 --force 的 git 对"被忽略的 junction"照样跟进、删掉目标目录里的文件，
 * "不干净就拒绝"保护不到这个形状；发现目录型链接（junction / 目录符号链接）、悬空链接或
 * 读不出的目录，就保留整棵树、返回 TREE_CONTAINS_JUNCTION、不调用 git。不先去删链接：
 * 删掉被跟踪的符号链接会让干净的树变脏，删掉被忽略的链接又会改动 git 本来用来拒删的
 * 内容。git 的"不干净就拒绝"仍是这条路径的安全依据，不改成 rmSync。树根自己是链接时
 * 不动。已知不防：检查之后、git 删除之前有人新建 junction（竞态）。
 *
 * @param {string} wtPath worktree 路径
 * @param {{execFn?: Function}} [opts] 测试缝（缺省 execFileSync）
 * @returns {boolean | typeof TREE_CONTAINS_JUNCTION} true = 目录已不在（含本来就不在）；
 *   false = 删除失败或仍在盘上；TREE_CONTAINS_JUNCTION = 树里有链接危险，没调用 git、树原样
 *   （调用方一律按"没删掉"处理：判 `=== true`，不要判真值）
 */
export function removeWorktreeNoForce(wtPath, { execFn = execFileSync } = {}) {
  const path = resolve(wtPath);
  // 先 lstat 判链接、再 existsSync：existsSync 跟进链接，会把悬空的根链接看成"不存在"、返回
  // true（成功），而链接其实还在盘上。根是链接（有效或悬空）一律不动、返回失败。
  if (isLinkAt(path)) return false;
  if (!existsSync(path)) return true;
  if (findTreeLinkHazard(path) !== null) return TREE_CONTAINS_JUNCTION;
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
  if (indexInventoryUnreliable(lsVerbose, lsStage)) return "inventory_unreadable";
  // ── 提交都在分支上 ──
  // 这一段与 lineageClose.isTreeHeadDrifted 是同一条规则（树在 wao/<runId> 上且 HEAD 等于
  // 这条分支此刻的 tip）。core 层不能反向引用 application 层，所以各写一份；
  // test/run-lifecycle/terminalWorktreeRelease.test.js 的同表测试用同一组输入喂两边，
  // 任何一边单独改规则都会红。
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

/**
 * 索引清点是否不可信（终态自动回收与 worktree reclaim 共用，第 150 批 TD-374）：这些
 * 形态会把工作区的改动藏起来，`git status` 看着干净其实不是，凡清点不了的一律保留。
 * 正常缓存位是大写 H；S = skip-worktree、小写 = assume-unchanged、其余字母 = unmerged /
 * removed / changed 等状态；gitlink（模式 160000，子模块）里的未提交内容 diff 看不到。
 * @param {string} lsVerbose `git ls-files -v` 的输出
 * @param {string} lsStage `git ls-files -s` 的输出
 * @returns {boolean} true = 清点不可信
 */
export function indexInventoryUnreliable(lsVerbose, lsStage) {
  if (lsVerbose.split(/\r?\n/).some((line) => line.length > 0 && !line.startsWith("H "))) return true;
  return lsStage.split(/\r?\n/).some((line) => line.startsWith("160000 "));
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
 * @returns {Promise<Array<{path: string, branch?: string, head?: string, locked?: true}>>}
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

export const LIST_WORKTREE_PATHS_TIMEOUT_MS = 5_000;

/**
 * TD-373: synchronous read-only worktree paths for the isolation-destination
 * classifier — `git worktree list --porcelain` executed in the run's own
 * worktree. The first entry is the main checkout; callers exclude their own
 * worktree. `--no-optional-locks` is requested explicitly (the classifier path
 * must not take index locks) and the child environment is the repository's
 * gitChildEnv/gitProbeEnv SSOT. The timeout is deliberately shorter than the
 * owner heartbeat threshold (10s): a hung git must not delay a violation
 * decision past the liveness window. A read failure throws; the caller treats
 * the whole destination determination as "other".
 *
 * @param {string} cwd — the run's worktree
 * @param {{execFn?: Function}} [opts] — test seam (default execFileSync)
 * @returns {string[]} absolute worktree paths, main checkout first
 */
export function listWorktreePaths(cwd, { execFn = execFileSync } = {}) {
  const out = execFn("git", ["--no-optional-locks", "worktree", "list", "--porcelain"], {
    cwd: resolve(cwd),
    encoding: "utf8",
    env: gitProbeEnv(),
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    timeout: LIST_WORKTREE_PATHS_TIMEOUT_MS,
  });
  return parseWorktreeList(out).map((entry) => entry.path);
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
    } else if (current && (line === "locked" || line.startsWith("locked "))) {
      current.locked = true;
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
