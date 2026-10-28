// src/application/worktreeReclaim.js
//
// `wao worktree reclaim`——存量 worktree 与 wao/* 分支的 Owner 批准清退。
// 两段式：plan（只读普查+分类+写计划，打印计划 sha256）与 apply（只执行
// sha256 绑定的已批准计划）。分类闭集与求值顺序是本模块的权威，命中即停：
//
//   1 undeterminable    任一需要的事实读不出来（转录损坏/twin 转录/引用文本
//                       读不出/清单遍历失败/git 失败/路径解析失败/线系枚举拒绝/
//                       登记指向的目录已不存在（registered_missing）/登记身份
//                       无法唯一判定（registration_ambiguous：不同父树下重名、
//                       同路径多处登记、可读转录声明的工作树与登记树不一致）；
//                       有树但三处找不到转录也归此类——多半是 runDir 不对，找
//                       不到不等于不在跑）
//   2 out_of_scope      源工作树本身 / 路径不是允许范围根（主检出的
//                       .wao-worktrees，或经核验关联工作树自己的同名根）下的
//                       一级 <合法 runId> 子目录 / 符号链接或 junction / 不属
//                       于这个仓库的 worktree
//   3 running           非终态 / 最后一条绑定事件 15 分钟内 / 新鲜 owner 心跳
//   4 reuse_open        只对真有复用关系的运行（自身绑过 rootRunId 或线系里有
//                       别的成员）求值：线系成员非终态 / 槽目录新鲜认领 /
//                       线系既未关闭也未 accepted
//   5 pending_lead      交付已打包未裁决 / 未裁决且树有未提交、暂存、未跟踪或
//                       被忽略的内容（只读与普通运行没有决定，一律算未裁决）
//   6 owner_nomination  只对未并入主分支的分支求值：tip 短 SHA 被被清退仓库的
//                       docs/、.wao/decisions/、README.md 引用 / 三处找不到转录
//                       且未并入（已并入的分支不做引用检查——删掉后提交仍在
//                       主分支上，引用不受影响）。只有分支、没有树的项走本类；
//                       有树的缺转录项在第 1 类就保留。--include 点名豁免，
//                       点名者按第 8 类处理并记"Owner 点名"
//   7 tree_protection   头指针漂移（detached/换了分支/tip 不等）/ 嵌套保护 /
//                       空壳非空
//   8 reclaim           已裁决或线系已关（树脏不阻塞，按放弃处理并标注）/
//                       未裁决且树完全干净 / 空壳目录（不在 git 登记里且为空）
//
// 安全模型：分支凡删必先进 bundle（完整历史；是否零独有只是信息字段，不是
// 不保全的理由——两条待删分支可能互相覆盖同一个别处没有的提交）。指纹四件套
// （HEAD / 工作区 diff sha256 / 暂存 diff sha256 / 未跟踪+被忽略清单 sha256）
// 只用于判断"批准之后有没有变化"，不是内容备份。所有只读 git 调用带
// --no-optional-locks——裸 `git status` 会刷新索引，等于写盘。
//
// 路径语义：登记路径（git 记录的 raw path）用于目录名推 runId、git 操作与
// 符号链接/junction 检测（lstat raw）；realpath 用于身份比较（源工作树、
// 是否在范围根下、嵌套、apply 的"真实路径没变"复核——计划记计划期
// realpath，apply 重算比对）。
//
// 范围根：主检出的 .wao-worktrees 恒为允许根；每个关联工作树再按四条资格
// 入列——在 porcelain 登记、与主检出同一 common git dir、自己的
// .wao-worktrees 目录在盘、登记路径逐级无符号链接/junction。嵌套项（父树
// 是关联工作树）在计划里记范围证明（scopeRoot=父树真实路径、
// scopeGitCommonDir、treeRealPath=目标真实路径），apply 删前逐项重证：父
// 树仍在册、仍同仓、真实路径未变、目标仍是 <父树>/.wao-worktrees/<runId>、
// 父树根到中间级逐级非链接；证明字段缺席（旧形状计划）或任一不成立即跳过，
// 树与分支都保留——旧计划不会因为换了新代码就自动扩域。
//
// 复用面：线系成员枚举（enumerateLineageMembers + lineageMemberFiles，归档
// 转录并进文件集、归档枚举 skipped 不丢弃）、槽目录占用（lineageSlotClaimBusy）、
// owner 心跳（ownerLiveness）、定向 worktree 管理条目清理
//（isolation.removeWorktreeAdminEntry）全部走既有单一实现，本模块不另写。
//
// 性能：转录只读、只解析一次（buildTranscriptFacts 的共享 readMemo），建好
// byRun（runId → 事实）、byRoot（rootRunId → 候选文件集）、byDeclaredReal
//（声明工作树 realpath → runId 集）三个索引与 per-file 事实（声明绑定 + 线系
// 归属 + (size, mtimeMs)戳），计划面全部 runId 与 apply 面的普查级事实共用；
// 线系枚举按 byRoot 预筛后仍走 enumerateLineageMembers 单一实现。apply 删每
// 棵树前的复核按磁盘现状**增量刷新**（refreshTranscriptFacts）：现枚举逐文件
// stat，新出现或 size/mtime 变了的文件现读重算，未变的沿用索引事实（转录只
// 追加——size/mtime 不变即内容不变）；成员名单与线系候选集都用刷新后的聚合，
// 不用 apply 开头那份。普查与分类用索引，删除前复核读最新。

import { execFileSync, spawn } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  realpathSync, rmdirSync, statSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { gitChildEnv, isValidRunId } from "../delivery.js";
import { createPrivateIndexCopy } from "../gitPrivateIndex.js";
import { readTranscript, TERMINAL_STATES } from "../transcript.js";
import { checkOwnerLiveness } from "./ownerLiveness.js";
import {
  enumerateLineageMembers, lineageClosedIn, lineageMemberFiles, lineageRootFromEvents, lineageSlotClaimBusy,
} from "./lineageClose.js";
import { removeWorktreeAdminEntry } from "../isolation.js";

/** 类别闭集（计划 items[].category 与计数键）。 */
export const RECLAIM_CATEGORIES = Object.freeze([
  "undeterminable", "out_of_scope", "running", "reuse_open", "pending_lead",
  "owner_nomination", "tree_protection", "tree_shared", "reclaim",
]);

/** 保留理由闭集（action=keep 的 items[].reason）。 */
export const RECLAIM_KEEP_REASONS = Object.freeze([
  "transcript_unreadable", "twin_transcripts", "transcript_missing", "git_fact_failed", "lineage_refused",
  "registered_missing", "registration_ambiguous",
  "source_worktree", "outside_worktrees_dir", "symlink_or_junction", "foreign_worktree",
  "non_terminal", "recent_event", "fresh_owner_heartbeat",
  "lineage_member_active", "slot_claim_fresh", "lineage_not_closed",
  "delivery_packaged_undecided", "undecided_dirty_tree",
  "referenced_short_sha", "transcript_missing_unmerged", "reference_scan_failed",
  "head_drift", "has_kept_descendant",
  "shared_tree_kept", "husk_not_empty",
]);

/** apply 整体拒绝码闭集。拒绝 = 不再执行任何删除；其中 bundle_* 三码发生时
 * 保全目录与 bundle 文件可能已写盘（无害残留：目录名带时刻、不覆盖既有记
 * 录），其余码零删除、零写盘。 */
export const RECLAIM_REFUSAL_CODES = Object.freeze([
  "plan_unreadable", "sha_mismatch", "repo_identity_mismatch",
  "preserve_dir_inside_target", "run_dir_inside_target", "run_dir_mismatch",
  "bundle_create_failed", "bundle_verify_failed", "bundle_heads_mismatch",
]);

/** 最后一条绑定事件的新鲜阈（第 3 类）。 */
export const RECENT_BOUND_EVENT_MS = 15 * 60_000;

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

function gitText(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitChildEnv(),
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
}

function gitReadOnly(args, cwd) {
  return gitText(["--no-optional-locks", ...args], cwd);
}

function gitOk(args, cwd) {
  try {
    gitText(args, cwd);
    return true;
  } catch {
    return false;
  }
}

/** --git-common-dir 在子目录里输出相对路径（../../.git 形态）：先 resolve 到
 * 调用 cwd 再 realpath，才能得到可比的绝对身份。 */
function commonDirOf(cwd) {
  return realpathSync(resolve(cwd, gitReadOnly(["rev-parse", "--git-common-dir"], cwd).trim()));
}

/** 流式哈希 git 输出（大 diff --binary 不整块落内存）。callerEnv：子进程的完整
 * env（如带私有索引副本 GIT_INDEX_FILE 的 process.env 副本；缺省 process.env），
 * 经 gitChildEnv 强制注入后传给子进程。 */
function hashGitOutput(args, cwd, callerEnv) {
  return new Promise((resolveHash, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: gitChildEnv(callerEnv),
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const hash = createHash("sha256");
    child.stdout.on("data", (chunk) => hash.update(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveHash(hash.digest("hex"));
      else reject(new Error(`git ${args.join(" ")} exited ${code}`));
    });
  });
}

function isBelow(child, ancestor) {
  if (typeof child !== "string" || typeof ancestor !== "string" || child.length <= ancestor.length) return false;
  const a = ancestor.endsWith(sep) ? ancestor : ancestor + sep;
  return child.startsWith(a);
}

function samePath(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

/** 解析 `git worktree list --porcelain`（含 detached 行）。 */
export function parseWorktreePorcelain(out) {
  const entries = [];
  let current = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length).trim(), detached: false };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim();
    } else if (current && line.trim() === "detached") {
      current.detached = true;
    } else if (line.trim() === "") {
      if (current) { entries.push(current); current = null; }
    }
  }
  if (current) entries.push(current);
  return entries;
}

/** git status -z 记录解析：[{x, y, path}]（?? /!! 单状态；目录条目以 / 结尾）。 */
function parseStatusZ(out) {
  const records = [];
  for (const raw of out.split("\0")) {
    if (raw.length < 4) continue;
    let p = raw.slice(3);
    if (p.endsWith("/")) p = p.slice(0, -1);
    records.push({ x: raw[0], y: raw[1], path: p });
  }
  return records;
}

function dirtyFlagsFromStatus(records) {
  return {
    staged: records.some((r) => r.x !== " " && r.x !== "?" && r.x !== "!"),
    unstaged: records.some((r) => r.y !== " " && r.y !== "?" && r.y !== "!"),
    untracked: records.some((r) => r.x === "?" && r.y === "?"),
    ignored: records.some((r) => r.x === "!" && r.y === "!"),
  };
}

/**
 * 未跟踪+被忽略清单：逐文件记相对路径、字节数、mtimeMs，按路径排序后取
 * sha256。git status --ignored 对整目录只报一行，目录在这里递归展开；遍历用
 * lstat，不跟随符号链接与 junction（链接本身记一行，不深入目标）。记字节数
 * 和 mtime 而不逐文件哈希，是为了不在大的忽略目录（如 node_modules）上花
 * 太久——这是有意取舍：指纹只回答"变没变"，不回答"变成了什么"。
 *
 * 读不出就失败（抛错，由调用方归 undeterminable / 跳过）：清单不完整会让
 * "变没变"的比对静默失真，不能跳过读不出的条目。
 *
 * nestedExcluded：在册嵌套 worktree 的相对路径集（"/" 分隔）。嵌套树有自己的
 * 计划条目与指纹，不并入外树清单——否则内树先删、外树重算清单就变了，外树
 * 被误判 content_changed，嵌套要两轮 apply 才清得完。
 *
 * io：读缝（测试注入 readdir/lstat 失败用；生产缺省 node:fs）。
 */
export function untrackedIgnoredManifest(treePath, records, nestedExcluded = [], io = { readdirSync, lstatSync }) {
  const lines = [];
  const excludedLower = new Set(nestedExcluded.map((p) => p.toLowerCase()));
  const isExcluded = (rel) => {
    const lower = rel.toLowerCase();
    if (excludedLower.has(lower)) return true;
    // 防御：record 落在嵌套树内部时按祖先前缀排除。
    let prefix = lower;
    for (let i = lower.indexOf("/"); i > 0; i = lower.indexOf("/", i + 1)) {
      prefix = lower.slice(0, i);
      if (excludedLower.has(prefix)) return true;
    }
    return false;
  };
  const recordLine = (rel, st) => lines.push(`${rel}\t${st.size}\t${st.mtimeMs}\n`);
  const walk = (relDir) => {
    let names;
    try {
      names = io.readdirSync(join(treePath, relDir), { withFileTypes: true });
    } catch (error) {
      throw new Error(`untrackedIgnoredManifest: readdir failed under ${relDir}: ${error?.code ?? error?.message}`);
    }
    for (const ent of names) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (isExcluded(rel)) continue;
      let st;
      try {
        st = io.lstatSync(join(treePath, rel));
      } catch (error) {
        throw new Error(`untrackedIgnoredManifest: lstat failed for ${rel}: ${error?.code ?? error?.message}`);
      }
      if (st.isSymbolicLink() || st.isFile()) recordLine(rel, st);
      else if (st.isDirectory()) walk(rel);
    }
  };
  for (const r of records) {
    if (isExcluded(r.path)) continue;
    let st;
    try {
      st = io.lstatSync(join(treePath, r.path));
    } catch (error) {
      throw new Error(`untrackedIgnoredManifest: lstat failed for ${r.path}: ${error?.code ?? error?.message}`);
    }
    if (st.isSymbolicLink() || st.isFile()) recordLine(r.path, st);
    else if (st.isDirectory()) walk(r.path);
  }
  lines.sort();
  return Buffer.from(lines.join(""), "utf8");
}

/**
 * 树的内容指纹四件套 + 脏位。任一 git 调用或清单遍历失败 → 抛错（计划侧归
 * undeterminable，apply 侧归跳过）。
 * @param {string} treePath
 * @param {{nestedExcluded?: string[]}} [opts] 在册嵌套 worktree 的相对路径集
 */
export async function computeTreeFingerprint(treePath, { nestedExcluded = [] } = {}) {
  const head = gitReadOnly(["rev-parse", "HEAD"], treePath).trim();
  // 工作树 diff（diff ... HEAD）会经 diff.autoRefreshIndex 刷新并写回索引
  //（--no-optional-locks 也拦不住）：改在私有索引副本上跑，真实索引字节不动。
  // --cached 的 diff 不看工作树、不刷新，照旧直跑。
  const indexAbs = resolve(treePath, gitReadOnly(["rev-parse", "--git-path", "index"], treePath).trim());
  const priv = createPrivateIndexCopy(indexAbs);
  let worktreeDiffSha256;
  try {
    worktreeDiffSha256 = await hashGitOutput([
      "--no-optional-locks", "diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD",
    ], treePath, priv === null ? undefined : { ...process.env, ...priv.env });
  } finally {
    priv?.dispose();
  }
  const indexDiffSha256 = await hashGitOutput([
    "--no-optional-locks", "diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "--no-color",
  ], treePath);
  const records = parseStatusZ(gitText([
    "--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching",
  ], treePath));
  return {
    head,
    worktreeDiffSha256,
    indexDiffSha256,
    untrackedIgnoredManifestSha256: sha256Hex(untrackedIgnoredManifest(treePath, records, nestedExcluded)),
    dirty: dirtyFlagsFromStatus(records),
  };
}

/**
 * 转录事实索引：三处枚举（runs/ 平铺 + projects/* 桶 + runs-archive/<yyyy-mm>/
 * 归档面，与 lineageClose 的成员枚举同一文件集）的全部转录**只读、只解析一次**
 *（共享 readMemo），派生：
 *   byRun         runId → { files, twin, events(单文件), state/lastTs/decision/
 *                 packaged(单文件), declared/declaredReal(孪生须全票一致) }
 *   byRoot        rootRunId → 候选文件集（自身 + 绑定该 root 的成员文件；喂给
 *                 enumerateLineageMembers 预筛，成员判据与全量一致）
 *   byDeclaredReal 声明工作树 realpath（小写）→ runId 集（apply 按树找全部成员）
 *   fileStamps    path → {size, mtimeMs}（apply 删树前增量刷新的比对基准）
 *   fileFacts     path → per-file 事实 {ok, runId, declaredPath, declaredReal,
 *                 roots}（刷新时未变的文件直接沿用）
 * 毒化面 poison（全局拒绝全部线系枚举）：任一转录不可读、或归档枚举 skipped
 *（含归档根读不出）——文件内容未知时无法判定它属于哪条线系，只能全局保守，
 * 与 lineageClose 全量候选集下的行为一致。孪生状态冲突**不进全局毒化**：两份
 * 转录都可读，冲突 runId 归属哪条线系是已知的（byRoot 照常收录），只有包含该
 * 孪生的线系会被 enumerateLineageMembers 自己拒绝（twin_state_mismatch），无
 * 关线系照常枚举——同样与 lineageClose 一致。
 */
export async function buildTranscriptFacts(runDirAbs) {
  const { files, skipped: archiveSkipped } = lineageMemberFiles(runDirAbs);
  const readMemo = new Map();
  const readFn = async (path) => {
    if (!readMemo.has(path)) {
      try {
        readMemo.set(path, { ok: true, events: await readTranscript(path) });
      } catch {
        readMemo.set(path, { ok: false });
      }
    }
    return readMemo.get(path);
  };
  const byRun = new Map();
  for (const f of files) {
    const runId = f.name.replace(/\.jsonl$/, "");
    if (!byRun.has(runId)) byRun.set(runId, { runId, files: [] });
    byRun.get(runId).files.push(f);
  }
  const unreadable = new Set();
  const twinMismatch = [];
  const fileStamps = new Map();
  const fileFacts = new Map();
  for (const f of files) {
    const runId = f.name.replace(/\.jsonl$/, "");
    let st = null;
    try {
      st = statSync(f.path);
      fileStamps.set(f.path, { size: st.size, mtimeMs: st.mtimeMs });
    } catch { /* stat 失败：该文件按不可读处理 */ }
    fileFacts.set(f.path, { ok: false, runId, declaredPath: null, declaredReal: null, roots: null });
  }
  for (const entry of byRun.values()) {
    const reads = [];
    for (const f of entry.files) reads.push(await readFn(f.path));
    if (reads.some((r) => !r.ok)) {
      unreadable.add(entry.runId);
      continue;
    }
    entry.twin = entry.files.length > 1;
    const eventsPerFile = reads.map((r) => r.events);
    entry.readsEvents = eventsPerFile;
    const declaredPerFile = eventsPerFile.map((ev) => {
      const started = ev.find((e) => e && e.type === "run.started" && e.runId === entry.runId);
      return typeof started?.worktreePath === "string" ? started.worktreePath : null;
    });
    // per-file 事实（增量刷新的复用单元）：声明绑定与线系归属按文件派生；
    // 聚合（byDeclaredReal/byRoot）由此折叠，与索引构造共用同一语义。
    entry.files.forEach((f, i) => {
      fileFacts.set(f.path, deriveFileFacts(f, eventsPerFile[i], declaredPerFile[i]));
    });
    // 孪生声明的绑定须全票一致；单文件照读。失效声明路径不绑定。
    entry.declared = entry.twin
      ? (declaredPerFile.every((d) => typeof d === "string") && new Set(declaredPerFile).size === 1
        ? declaredPerFile[0]
        : null)
      : declaredPerFile[0];
    if (entry.declared != null) {
      entry.declaredReal = fileFacts.get(entry.files[0].path)?.declaredReal ?? null;
    }
    if (entry.twin) {
      const states = eventsPerFile.map((ev) => lastBoundState(ev, entry.runId));
      if (states.some((s) => s !== states[0])) twinMismatch.push(entry.runId);
    }
  }
  const { byDeclaredReal, byRoot } = aggregateFileFacts(files, fileFacts);
  let poison = null;
  if (unreadable.size > 0) {
    poison = { reason: "transcript_unreadable", detail: [...unreadable][0] };
  } else if (archiveSkipped.length > 0) {
    poison = {
      reason: "archive_enumeration_skipped",
      detail: archiveSkipped[0]?.dir ?? archiveSkipped[0]?.file ?? "",
    };
  }
  // twinMismatch 不进全局毒化（见函数注释）；线系内拒绝由 enumerateLineageMembers
  // 按 byRoot 候选集自己完成。
  return { files, byRun, byRoot, byDeclaredReal, unreadable, twinMismatch, poison, readFn, fileStamps, fileFacts };
}

/** per-file 事实派生：声明绑定（run.started.worktreePath 的 realpath；失效声
 * 明路径不绑定）+ 线系归属（自身 ∪ bound session_reuse / background_submitted
 * 的 rootRunId）。declaredPath 由调用方传入时直接用（孪生 unanimity 判定与
 * per-file 派生共用同一次 find）。 */
function deriveFileFacts(f, events, declaredPath) {
  const runId = f.name.replace(/\.jsonl$/, "");
  const path = typeof declaredPath === "string"
    ? declaredPath
    : (() => {
      const started = events.find((e) => e && e.type === "run.started" && e.runId === runId);
      return typeof started?.worktreePath === "string" ? started.worktreePath : null;
    })();
  let declaredReal = null;
  if (path != null) {
    try {
      declaredReal = realpathSync(resolve(path));
    } catch { /* 声明路径已失效：不绑定 */ }
  }
  const roots = new Set([runId]);
  for (const e of events) {
    if (!e || e.runId !== runId) continue;
    if ((e.type === "run.session_reuse" || e.type === "run.background_submitted")
      && typeof e.rootRunId === "string") roots.add(e.rootRunId);
  }
  return { ok: true, runId, declaredPath: path, declaredReal, roots: [...roots] };
}

/** per-file 事实 → 聚合索引（byDeclaredReal / byRoot）。索引构造与 apply 删树
 * 前的增量刷新共用本折叠，保证两边语义同一：不可读 run 只保留自身归属；声明
 * 绑定须孪生全票一致；线系归属按 run 的全部文件取并集（孪生候选集超集，成
 * 员判据只依赖每个文件自身的事件）。 */
function aggregateFileFacts(files, fileFacts) {
  const byRunFiles = new Map();
  for (const f of files) {
    const runId = fileFacts.get(f.path)?.runId ?? f.name.replace(/\.jsonl$/, "");
    if (!byRunFiles.has(runId)) byRunFiles.set(runId, []);
    byRunFiles.get(runId).push(f);
  }
  const byDeclaredReal = new Map();
  const byRoot = new Map();
  for (const [runId, fs] of byRunFiles) {
    if (fs.some((f) => fileFacts.get(f.path)?.ok !== true)) {
      // 绑定关系读不出来，只保留自身归属；毒化面由调用方另行全局拒绝。
      if (!byRoot.has(runId)) byRoot.set(runId, []);
      byRoot.get(runId).push(...fs);
      continue;
    }
    const declaredPaths = fs.map((f) => fileFacts.get(f.path).declaredPath);
    const unanimous = declaredPaths.every((d) => typeof d === "string")
      && new Set(declaredPaths).size === 1;
    if (unanimous) {
      const real = fileFacts.get(fs[0].path).declaredReal;
      if (real != null) {
        const key = real.toLowerCase();
        if (!byDeclaredReal.has(key)) byDeclaredReal.set(key, []);
        byDeclaredReal.get(key).push(runId);
      }
    }
    const roots = new Set([runId]);
    for (const f of fs) {
      for (const r of fileFacts.get(f.path).roots) roots.add(r);
    }
    for (const root of roots) {
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root).push(...fs);
    }
  }
  return { byDeclaredReal, byRoot };
}

/**
 * apply 删每棵树前的增量刷新（磁盘现状）：现枚举三处文件集，逐文件 stat；
 * 新出现的文件与 size/mtimeMs 变了的文件现读、重算 per-file 事实，未变的沿
 * 用索引事实（转录只追加——size/mtime 不变即内容不变；不做每棵树的全量重
 * 读）。据此重折叠 byDeclaredReal / byRoot：删树前的成员名单与线系枚举候
 * 选集都用它，不用 apply 开头那份（索引建好之后新绑上来的运行/成员只有这里
 * 看得到）。读不出的新文件（或内容变了却读不出的文件）→ 调用方按"无法判
 * 定"跳过这棵树。stat 失败同样如此（返回 statFailed）。
 */
export async function refreshTranscriptFacts(transcripts, runDirAbs) {
  const fresh = lineageMemberFiles(runDirAbs);
  for (const f of fresh.files) {
    let st;
    try {
      st = statSync(f.path);
    } catch {
      return { ...fresh, statFailed: f.path, unreadableNow: [], byDeclaredReal: new Map(), byRoot: new Map() };
    }
    const prev = transcripts.fileStamps.get(f.path);
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs
      && transcripts.fileFacts.get(f.path)?.ok === true) {
      continue; // 未变：沿用索引事实
    }
    let events;
    try {
      events = await readTranscript(f.path);
    } catch {
      return {
        ...fresh,
        statFailed: null,
        unreadableNow: [f.path],
        byDeclaredReal: new Map(),
        byRoot: new Map(),
      };
    }
    transcripts.fileFacts.set(f.path, deriveFileFacts(f, events));
    transcripts.fileStamps.set(f.path, { size: st.size, mtimeMs: st.mtimeMs }); // 后续树的刷新以本次为基准
  }
  const { byDeclaredReal, byRoot } = aggregateFileFacts(fresh.files, transcripts.fileFacts);
  return { ...fresh, statFailed: null, unreadableNow: [], byDeclaredReal, byRoot };
}

function lastBoundState(events, runId) {
  let state = null;
  for (const e of events) {
    if (e && e.type === "run.state_change" && e.runId === runId && typeof e.to === "string") state = e.to;
  }
  return state;
}

function lastBoundEventTs(events, runId) {
  let ts = null;
  for (const e of events) {
    if (e && e.runId === runId && typeof e.ts === "string") ts = e.ts;
  }
  return ts;
}

function deliveryDecision(events, runId) {
  let decision = null;
  for (const e of events) {
    if (!e || e.runId !== runId) continue;
    if (e.type === "run.delivery_accepted") decision = "accepted";
    else if (e.type === "run.delivery_rejected") decision = "rejected";
  }
  return decision;
}

function hasPackagedDelivery(events, runId) {
  return events.some((e) => e && e.type === "run.delivery_created" && e.runId === runId);
}

/** 仓库身份事实（git 为准）。失败 → 抛错（plan 整体失败）。 */
function repoIdentity(repoCwd) {
  const gitCommonDir = commonDirOf(repoCwd);
  const worktrees = parseWorktreePorcelain(gitReadOnly(["worktree", "list", "--porcelain"], repoCwd));
  const main = worktrees[0];
  if (!main) throw new Error(`worktree reclaim: no worktrees listed for ${repoCwd}`);
  const mainWorktreePath = realpathSync(main.path);
  let mainBranch = null;
  if (main.branch && main.branch.startsWith("refs/heads/")) mainBranch = main.branch.slice("refs/heads/".length);
  return { gitCommonDir, mainWorktreePath, mainBranch, mainHead: main.head ?? null, worktrees };
}

/** 从盘根到 path 逐级 lstat：任一级是符号链接/junction（或读不出）即 false。
 * 范围父树的资格判定用——登记路径穿链接的父树不做范围根。 */
function pathFreeOfSymlinks(p) {
  const levels = [];
  let cur = resolve(p);
  for (;;) {
    levels.push(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (const level of levels.reverse()) {
    let st;
    try {
      st = lstatSync(level);
    } catch {
      return false;
    }
    if (st.isSymbolicLink()) return false;
  }
  return true;
}

/**
 * 范围根闭集：主检出的 .wao-worktrees（恒在列，存在与否只影响枚举）+ 每个
 * 满足全部资格的关联工作树 W 的 <W>/.wao-worktrees：在 porcelain 登记、与
 * 主检出同一 common git dir、目录在盘且非链接、登记路径逐级无链接。根的
 * real 用未再解析的 join 形态——范围形状按树真实路径的父目录精确比对，根
 * 自身是链接时其下树的 realpath 会解析到别处而不命中（保守保留）。
 */
function allowedWorktreeRoots(repo) {
  const roots = [{
    real: join(repo.mainWorktreePath, ".wao-worktrees"),
    parentReal: repo.mainWorktreePath,
    gitCommonDir: repo.gitCommonDir,
    linked: false,
  }];
  for (const wt of repo.worktrees.slice(1)) {
    const raw = resolve(wt.path);
    let real;
    try {
      real = realpathSync(raw);
    } catch {
      continue; // 目录缺失：当不了范围父树（该登记自身归 registered_missing）
    }
    if (samePath(real, repo.mainWorktreePath)) continue;
    if (!pathFreeOfSymlinks(raw)) continue;
    let common;
    try {
      common = commonDirOf(raw);
    } catch {
      continue;
    }
    if (!samePath(common, repo.gitCommonDir)) continue;
    const rootRaw = join(real, ".wao-worktrees");
    let st;
    try {
      st = lstatSync(rootRaw);
    } catch {
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    roots.push({ real: rootRaw, parentReal: real, gitCommonDir: repo.gitCommonDir, linked: true });
  }
  return roots;
}

/**
 * 被清退仓库的 docs/、.wao/decisions/、README.md 中出现过的 7 位短 SHA 集合。
 * 只对未并入主分支的分支消费（已并入的分支删掉后提交仍从 main 可达）：任一
 * 文件读不出 → failed=true，未并入分支归 undeterminable
 *（reference_scan_failed），不静默漏检。超过 2MB 的文件按策略跳过（不是失
 * 败）。io：读缝（测试注入读失败用；生产缺省 node:fs）。
 */
function referencedShortShas(repoRoot, io = { lstatSync, readFileSync, readdirSync }) {
  const shas = new Set();
  let failed = false;
  // 目标缺席（ENOENT）是正常形态（没有 docs/ 或 README 的仓库），不算失败；
  // 在场却读不出才算——那会让"未被引用"失去证据。
  const scanFile = (p) => {
    let text = null;
    try {
      const st = io.lstatSync(p);
      if (!st.isFile() || st.size > 2 * 1024 * 1024) return;
      text = io.readFileSync(p, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") failed = true;
      return;
    }
    for (const m of text.matchAll(/\b[0-9a-f]{7,40}\b/g)) {
      // 只收恰好 7 位的形态——冻结文本引用的就是短 SHA；更长的全 SHA 字段
      // （如 deliveryCommit）不构成短引用证据。
      if (m[0].length === 7) shas.add(m[0]);
    }
  };
  const walk = (dir) => {
    let names;
    try {
      names = io.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOENT") failed = true;
      return;
    }
    for (const ent of names) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) scanFile(p);
    }
  };
  walk(join(repoRoot, "docs"));
  walk(join(repoRoot, ".wao", "decisions"));
  scanFile(join(repoRoot, "README.md"));
  return { shas, failed };
}

function isDirEmpty(path) {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false; // 读不了按非空保守处理
  }
}

/**
 * 普查+分类+写计划（只读，除写出计划文件本身）。
 * @param {object} p
 * @param {string} p.repoCwd 被清退仓库（任意目录，git 解析到仓库级事实）
 * @param {string} p.runDir 转录目录（三处枚举的根）
 * @param {string[]} [p.includeRunIds] Owner 点名的 runId（豁免第 6 类）
 * @param {string} [p.outPath] 计划写出路径
 * @param {Function} [p.now] 时钟缝
 * @param {object} [p.referenceScanIo] 引用扫描读缝（测试注入读失败；缺省 node:fs）
 * @returns {Promise<{plan: object, planSha256: string, outPath: string}>}
 */
export async function planWorktreeReclaim({
  repoCwd, runDir, includeRunIds = [], outPath, now = Date.now, referenceScanIo,
}) {
  const repo = repoIdentity(repoCwd);
  const allowedRoots = allowedWorktreeRoots(repo);
  const scopeRootOf = (real) => allowedRoots.find((r) => samePath(dirname(real), r.real)) ?? null;
  const runDirAbs = resolve(runDir);
  const included = new Set(includeRunIds);
  const refScan = referencedShortShas(repo.mainWorktreePath, referenceScanIo);

  const transcripts = await buildTranscriptFacts(runDirAbs);
  const runInfoCache = new Map();
  /** 读一个 runId 的绑定事件事实（事实索引上的缓存视图；twin → 二义性位）。 */
  function runInfo(runId) {
    if (runInfoCache.has(runId)) return runInfoCache.get(runId);
    const entry = transcripts.byRun.get(runId);
    const info = {
      missing: !entry,
      twin: false,
      unreadable: false,
      events: null,
      declared: null,
      declaredReal: null,
    };
    if (!entry) {
      runInfoCache.set(runId, info);
      return info;
    }
    if (transcripts.unreadable.has(runId)) {
      info.unreadable = true;
      runInfoCache.set(runId, info);
      return info;
    }
    info.twin = entry.twin;
    info.declared = entry.declared ?? null;
    info.declaredReal = entry.declaredReal ?? null;
    if (!entry.twin) {
      info.events = entry.readsEvents[0];
      info.state = lastBoundState(info.events, runId);
      info.lastTs = lastBoundEventTs(info.events, runId);
      info.decision = deliveryDecision(info.events, runId);
      info.packaged = hasPackagedDelivery(info.events, runId);
    }
    runInfoCache.set(runId, info);
    return info;
  }

  /** 分支并入缓存（分类门与信息字段共用同一 git 事实）。 */
  const compareBase = repo.mainBranch ? `refs/heads/${repo.mainBranch}` : repo.mainHead;
  const mergedCache = new Map();
  function branchMergedIntoMain(branchRef) {
    if (!mergedCache.has(branchRef)) {
      mergedCache.set(branchRef, gitOk([
        "--no-optional-locks", "merge-base", "--is-ancestor", branchRef, compareBase,
      ], repo.mainWorktreePath));
    }
    return mergedCache.get(branchRef);
  }

  const branches = [];
  for (const line of gitReadOnly(["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/wao/"], repo.mainWorktreePath).split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+([0-9a-f]{40})$/);
    if (m) branches.push({ branch: m[1], tip: m[2] });
  }
  const branchByRunId = new Map(branches.map((b) => [b.branch.replace(/^wao\//, ""), b]));

  // 普查：登记 worktree（登记路径的目录名即 runId 面）∪ 每个允许根下的空壳
  // 目录与未登记链接 ∪ wao/* 分支。raw 路径经 resolve 归一为原生分隔符——git
  // porcelain 在 Windows 输出正斜杠，与 node join 的反斜杠混比会让前缀判定静
  // 默失效。登记指向的目录可能已不存在（批准后有人删了树目录、登记被 --expire
  // 留下等形态）：realpath 失败不崩，该登记单独归类 registered_missing 保留，
  // 不参与真实路径分组与嵌套保护。
  const worktreeEntries = repo.worktrees.map((wt) => {
    const raw = resolve(wt.path);
    let real = null;
    try {
      real = realpathSync(raw);
    } catch { /* 目录缺失：missingDir 标记 */ }
    return { raw, real, missingDir: real === null };
  });
  const registeredReals = worktreeEntries.map((e) => e.real).filter((r) => r != null);
  // 登记身份按真实路径，不按目录名：范围根有多个后，不同父树下的同名目录会
  // 混淆。普查 runId 的树候选（登记/空壳/链接）按目录名小写收集，多于一个就
  // 无法唯一判定是哪棵（重名、同路径多处登记、同名空壳与登记并存），整条保
  // 留（undeterminable/registration_ambiguous），绝不取第一项。
  const candidatesByRunId = new Map();
  const addTreeCandidate = (runId, cand) => {
    const key = runId.toLowerCase();
    if (!candidatesByRunId.has(key)) candidatesByRunId.set(key, []);
    candidatesByRunId.get(key).push(cand);
  };
  for (const e of worktreeEntries) addTreeCandidate(basename(e.raw), { kind: "registered", entry: e });
  const husks = [];
  const looseSymlinks = [];
  for (const root of allowedRoots) {
    let names;
    try {
      names = readdirSync(root.real, { withFileTypes: true });
    } catch {
      continue; // 根读不出（含不存在）：该根下枚举不到目标，不崩计划
    }
    for (const ent of names) {
      const p = join(root.real, ent.name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isFile()) continue;
      if (st.isSymbolicLink()) {
        // 未登记的符号链接/junction 目录条目：保留（不跟随）。realpath 命中某
        // 个在册登记真实路径的是同一棵树的别名，不另立候选。
        let real = null;
        try {
          real = realpathSync(p);
        } catch { /* 目标失效的链接：照常立候选（保留） */ }
        if (real && registeredReals.some((r) => samePath(r, real))) continue;
        looseSymlinks.push({ name: ent.name, path: p, real });
        continue;
      }
      if (!st.isDirectory()) continue;
      let real;
      try {
        real = realpathSync(p);
      } catch {
        continue;
      }
      if (registeredReals.some((r) => samePath(r, real))) continue;
      husks.push({ name: ent.name, path: p, real });
    }
  }
  for (const h of husks) addTreeCandidate(h.name, { kind: "husk", husk: h });
  for (const s of looseSymlinks) addTreeCandidate(s.name, { kind: "loose", loose: s });

  const targetRunIds = new Set();
  for (const e of worktreeEntries) targetRunIds.add(basename(e.raw));
  for (const h of husks) targetRunIds.add(h.name);
  for (const s of looseSymlinks) targetRunIds.add(s.name);
  for (const b of branches) targetRunIds.add(b.branch.replace(/^wao\//, ""));

  // 转录库整体为空却普查到树/空壳目标 → 整体拒绝生成计划：几乎必是 --run-dir
  // 指错了（正确的库里不可能一条转录都没有）。只有分支、没有树的目标不触发
  //（其分类只依赖 git 事实）。
  const nonMainTreeTargets = Math.max(worktreeEntries.length - 1, 0) + husks.length;
  if (nonMainTreeTargets > 0 && transcripts.files.length === 0) {
    throw new Error(
      `worktree reclaim: 转录库为空（${runDirAbs} 下三处枚举到 0 条转录），但普查到 ${nonMainTreeTargets} 个树/空壳目标——多半 --run-dir 不对；确认运行目录后重试`,
    );
  }
  // 库非空但普查目标零命中：不拒绝（缺转录项已归 undeterminable 保留），给出
  // 提示行让操作者核对运行目录。
  let warning = null;
  if (transcripts.files.length > 0 && targetRunIds.size > 0
    && ![...targetRunIds].some((id) => (transcripts.byRun.get(id)?.files?.length ?? 0) > 0)) {
    warning = `普查目标在转录库中零命中——若意外，请核对 --run-dir（当前 ${runDirAbs}）`;
  }

  // 线系枚举缓存（按根；byRoot 预筛文件集，归档面已并入）。毒化面（任一转
  // 录不可读/归档枚举 skipped 含归档根读不出）下成员集不再可信，全部拒绝
  // ——与全量扫描时代"任一文件读不出 → 全部 refuse"的保守面一致。孪生状
  // 态冲突不进毒化面：只拒绝包含该孪生的线系（enumerateLineageMembers 自己
  // 的 twin_state_mismatch），无关线系照常枚举——与 buildTranscriptFacts 的
  // 函数注释同一事实。
  const lineageCache = new Map();
  // 树级 git 事实缓存（按树路径）：共享树的成员不重复跑 git 子进程。
  const treeFactsCache = new Map();
  async function lineageOf(runId, events) {
    if (transcripts.poison) return { root: runId, enumerated: { members: [], refuse: `${transcripts.poison.reason}:${transcripts.poison.detail}` } };
    const root = lineageRootFromEvents(events, runId) ?? runId;
    if (!lineageCache.has(root)) {
      lineageCache.set(root, await enumerateLineageMembers(root, transcripts.byRoot.get(root) ?? [], transcripts.readFn));
    }
    return { root, enumerated: lineageCache.get(root) };
  }

  // ── 逐 runId 分类（顺序即安全顺序，命中即停）──
  // 分类主体从普查目标出发，经线系成员闭包扩展：共享树的成员可能不是普查
  // 目标（无自有树/分支/空壳），但它的保留性（在跑/未裁决/脏）决定整棵树
  // 的去重结果，必须分类。
  const classifications = new Map(); // runId → { category, reason, detail?, keep? }
  const facts = new Map(); // runId → { branch, treePath, treeRealPath, isHusk, isLooseSymlink, treeBranch, treeHead, fingerprint }
  const pendingIds = [...targetRunIds];
  const enqueued = new Set(targetRunIds);
  const classifyRun = async (runId) => {
    const cands = candidatesByRunId.get(runId.toLowerCase()) ?? [];
    const f = {
      branch: branchByRunId.get(runId) ?? null,
      treePath: null,
      treeRealPath: null,
      isHusk: false,
      isLooseSymlink: false,
    };
    facts.set(runId, f);
    const keep = (category, reason, detail) => {
      classifications.set(runId, { category, reason, ...(detail ? { detail } : {}) });
    };

    // 1 undeterminable——最先求值（优先于一切回收类）。
    const info = runInfo(runId);
    f.info = info;

    // 身份无法唯一判定（不同父树下重名 / 同路径多处登记 / 同名空壳·链接与
    // 登记并存）：取任何一方都会让其余同名树静默隐形，整条保留。
    if (cands.length > 1) {
      // 歧义候选都是保留项：记下它们的路径交给下面的嵌套保护，否则含有它们的
      // 可回收外层树会把它们连带删掉。
      f.protectPaths = cands
        .map((c) => c.entry?.real ?? c.husk?.real ?? c.loose?.path ?? c.entry?.raw ?? null)
        .filter(Boolean);
      keep("undeterminable", "registration_ambiguous",
        cands.map((c) => c.entry?.raw ?? c.husk?.path ?? c.loose?.path ?? "").join("；"));
      return;
    }
    const registered = cands[0]?.kind === "registered" ? cands[0].entry : null;
    const husk = cands[0]?.kind === "husk" ? cands[0].husk : null;
    const loose = cands[0]?.kind === "loose" ? cands[0].loose : null;
    f.treePath = registered?.raw ?? husk?.path ?? loose?.path ?? null;
    f.treeRealPath = registered?.real ?? husk?.real ?? null;
    f.isHusk = !registered && !!husk;
    f.isLooseSymlink = !registered && !!loose;

    // 登记指向的目录已不存在：无法指纹、无法判活性（转录说了不算——树可能
    // 是刚被删的）。单独归类保留；分支可否回收交给通用清扫清掉 stale 登记后
    // 的下一轮计划。
    if (registered?.missingDir) { keep("undeterminable", "registered_missing"); return; }

    // 无自有登记树的成员：经转录 run.started.worktreePath 绑定共享树（须与
    // 某个在册 worktree 的 realpath 吻合；失效声明不绑定；孪生声明须全票
    // 一致——事实索引已归一）。**绑定先于一切保留判定**：孪生/不可读/缺转录
    // 的成员也要参与整树分组，否则分组看不到这个保留成员，共享同一路径的树
    // 仍会生成删除动作。树的去重与头门都按树的属主（目录名）求值，成员只
    // 通过共享分组受影响。
    if (!f.treePath && info.declaredReal) {
      const match = worktreeEntries.find((e) => samePath(e.real, info.declaredReal));
      if (match) {
        f.treePath = match.raw;
        f.treeRealPath = match.real;
      }
    }

    if (info.twin) { keep("undeterminable", "twin_transcripts"); return; }
    if (info.unreadable) { keep("undeterminable", "transcript_unreadable"); return; }

    // 线系根与闭态：任何有事件的 run 都求值（第 5/8 类的"线系已关"不限于
    // 复用线系形态）。
    if (info.events) {
      const root = lineageRootFromEvents(info.events, runId) ?? runId;
      const rootInfo = runInfo(root);
      f.lineageClosed = rootInfo.events ? lineageClosedIn(rootInfo.events, root) : false;
    }

    // 2 out_of_scope。
    if (f.isLooseSymlink) { keep("out_of_scope", "symlink_or_junction"); return; }
    if (f.treePath && f.treeRealPath && samePath(f.treeRealPath, repo.mainWorktreePath)) { keep("out_of_scope", "source_worktree"); return; }
    // 范围形状：真实路径须恰好是某个允许根（主检出的 .wao-worktrees，或经核
    // 验关联工作树自己的同名根）下的一级子目录，且目录名是合法 runId。关联
    // 工作树本身、它下面的其它目录、范围根外路径、根下多级嵌套一律保留。
    if (f.treePath) {
      const shapeRoot = f.treeRealPath != null ? scopeRootOf(f.treeRealPath) : null;
      if (!shapeRoot || !isValidRunId(basename(f.treeRealPath))) {
        keep("out_of_scope", "outside_worktrees_dir"); return;
      }
    }
    if (f.treePath && !f.isLooseSymlink) {
      let st;
      try {
        st = lstatSync(f.treePath);
      } catch {
        keep("undeterminable", "git_fact_failed", "tree_lstat"); return;
      }
      if (st.isSymbolicLink()) { keep("out_of_scope", "symlink_or_junction"); return; }
    }
    if (f.isHusk) {
      // 空壳目录里如果还有别的仓库的 git 元数据（common dir 指向别处），不碰。
      try {
        const foreignCommon = commonDirOf(f.treePath);
        if (!samePath(foreignCommon, repo.gitCommonDir)) { keep("out_of_scope", "foreign_worktree"); return; }
      } catch { /* 无 git 元数据的空壳：正常路径 */ }
    }
    // 转录声明绑定（三方绑定的转录腿）：可读转录声明的工作树真实路径须与这条
    // 运行绑定的树一致——声明指向别处时，这棵树不是该运行的树。缺转录/不可
    // 读/孪生已在第 1 类保留；无声明字段的运行不受此限（由其余门裁决）。分
    // 支腿（检出 wao/<runId>）由第 7 类头指针漂移门承担，对主根与嵌套位置同
    // 一套。
    if (f.treePath && info.declared != null
      && !(f.treeRealPath != null && info.declaredReal != null && samePath(f.treeRealPath, info.declaredReal))) {
      keep("undeterminable", "registration_ambiguous"); return;
    }

    // 有树但三处都找不到转录 → 无法判定并保留（缺转录≠不在跑：一个刚开跑、
    // 树还干净、tip==main 的运行会直接落进回收类，在跑的 worker 会被拆掉工作
    // 目录；转录库读错时整个普查都是这个形态）。只有分支、没有树的项不在此列
    //（并入与否是 git 事实，照第 6 类处置）。
    if (info.missing && f.treePath) { keep("undeterminable", "transcript_missing"); return; }

    // git 事实读不出来 → undeterminable。
    if (f.branch) {
      try {
        const live = gitReadOnly(["rev-parse", `refs/heads/${f.branch.branch}`], repo.mainWorktreePath).trim();
        if (live.toLowerCase() !== f.branch.tip.toLowerCase()) {
          keep("undeterminable", "git_fact_failed", "branch_tip_moved_during_plan"); return;
        }
      } catch {
        keep("undeterminable", "git_fact_failed", "branch_tip_unreadable"); return;
      }
    }
    if (f.treePath && !f.isHusk && !f.isLooseSymlink) {
      // 树级 git 事实（HEAD/分支/指纹）按树路径缓存：共享树的成员会重复求值
      // 同一棵树，每成员 5 个 git 子进程在大线系上是平方级放大；同一棵树在同
      // 一份计划里共享同一份事实快照。
      if (!treeFactsCache.has(f.treePath)) {
        try {
          const treeBranch = gitReadOnly(["rev-parse", "--abbrev-ref", "HEAD"], f.treePath).trim();
          const treeHead = gitReadOnly(["rev-parse", "HEAD"], f.treePath).trim();
          // 在册嵌套 worktree 不计入本树清单（它们有自己的条目与指纹），否则
          // 内树先删后外树清单变化，嵌套要两轮 apply 才清得完。
          const nestedExcluded = worktreeEntries
            .filter((e) => e.raw !== f.treePath && isBelow(e.raw, f.treePath))
            .map((e) => relative(f.treePath, e.raw).split(sep).join("/"));
          const fingerprint = await computeTreeFingerprint(f.treePath, { nestedExcluded });
          treeFactsCache.set(f.treePath, { treeBranch, treeHead, fingerprint });
        } catch {
          treeFactsCache.set(f.treePath, null); // 读不出：每个求值方各自归 undeterminable
        }
      }
      const tf = treeFactsCache.get(f.treePath);
      if (!tf) { keep("undeterminable", "git_fact_failed", "tree_head_or_fingerprint_unreadable"); return; }
      f.treeBranch = tf.treeBranch;
      f.treeHead = tf.treeHead;
      f.fingerprint = tf.fingerprint;
    }

    // 3 running。
    if (info.state && !TERMINAL_STATES.includes(info.state)) { keep("running", "non_terminal"); return; }
    if (info.lastTs) {
      const ts = Date.parse(info.lastTs);
      if (Number.isFinite(ts) && now() - ts < RECENT_BOUND_EVENT_MS) { keep("running", "recent_event"); return; }
    }
    if (checkOwnerLiveness(runDirAbs, runId, now()).fresh) { keep("running", "fresh_owner_heartbeat"); return; }

    // 4 reuse_open（只对真有复用关系的运行求值——自身绑过 rootRunId，或线系
    // 里有别的成员；孤立运行的"线系"是平凡的，落到 5/8 处置。判定全部复用
    // lineageClose 的实现）。线系成员同时入列——共享树成员的保留性要在树
    // 去重时可见。
    if (info.events) {
      const { root, enumerated } = await lineageOf(runId, info.events);
      if (enumerated.refuse) { keep("undeterminable", "lineage_refused", enumerated.refuse); return; }
      for (const m of enumerated.members) {
        if (!enqueued.has(m.runId)) {
          enqueued.add(m.runId);
          pendingIds.push(m.runId);
        }
      }
      const hasReuseLineage = lineageRootFromEvents(info.events, runId) !== null
        || enumerated.members.some((m) => m.runId !== root);
      if (hasReuseLineage) {
        f.lineageRoot = root;
        f.lineageMembers = enumerated.members;
        if (enumerated.members.some((m) => !TERMINAL_STATES.includes(m.state ?? ""))) {
          keep("reuse_open", "lineage_member_active"); return;
        }
        const memberIds = new Set(enumerated.members.map((m) => m.runId));
        if ((await lineageSlotClaimBusy(runDirAbs, memberIds, { nowMs: now })).busy) {
          keep("reuse_open", "slot_claim_fresh"); return;
        }
        let lineageAccepted = false;
        for (const m of enumerated.members) {
          const mi = runInfo(m.runId);
          if (mi.decision === "accepted") { lineageAccepted = true; break; }
        }
        if (!f.lineageClosed && !lineageAccepted) { keep("reuse_open", "lineage_not_closed"); return; }
      }
    }

    // 5 pending_lead（无决定的运行一律算未裁决）。
    const decided = info.decision === "accepted" || info.decision === "rejected";
    if (!decided && !f.lineageClosed) {
      if (info.packaged) { keep("pending_lead", "delivery_packaged_undecided"); return; }
      const dirty = f.fingerprint?.dirty ?? null;
      const huskNonEmpty = f.isHusk && !isDirEmpty(f.treePath);
      const hasContent = dirty
        ? dirty.staged || dirty.unstaged || dirty.untracked || dirty.ignored
        : huskNonEmpty;
      if (f.treePath && hasContent) { keep("pending_lead", "undecided_dirty_tree"); return; }
    }

    // 6 owner_nomination（--include 点名豁免）。只对未并入主分支的分支求值：
    // 已并入的分支删掉后提交仍从主分支可达，引用与转录缺口都不受影响——先判
    // 并入，再看引用扫描（扫描失败对已并入分支不生效，照常回收）。对未并入
    // 分支：引用面读不出（任一 docs/decisions/README 文件读失败）时无法断言
    // "未被引用"，归无法判定并保留；tip 短 SHA 被引用、三处无转录同样要 Owner
    // 点名。
    if (!included.has(runId) && f.branch) {
      const merged = branchMergedIntoMain(`refs/heads/${f.branch.branch}`);
      if (!merged) {
        if (refScan.failed) { keep("undeterminable", "reference_scan_failed"); return; }
        if (refScan.shas.has(f.branch.tip.slice(0, 7))) {
          keep("owner_nomination", "referenced_short_sha"); return;
        }
        if (info.missing) { keep("owner_nomination", "transcript_missing_unmerged"); return; }
      }
    }

    // 7 tree_protection：头指针漂移。只对树的属主（目录名 = runId）求值——
    // 共享树的成员不在此门（整树去重时按属主的分类裁决，成员经共享分组
    // 保留或连带回收）。detached HEAD 上的提交不被任何分支引用，bundle 只收
    // 分支，删树即丢——照 lineageClose 的同名门保留。
    if (f.treePath && !f.isHusk && !f.isLooseSymlink && basename(f.treePath) === runId) {
      const onOwnBranch = f.treeBranch === `wao/${runId}` || f.treeBranch === `refs/heads/wao/${runId}`;
      const tipOk = !f.branch || samePath(f.treeHead ?? "", f.branch.tip);
      if (!onOwnBranch || !tipOk) { keep("tree_protection", "head_drift"); return; }
    }

    // 8 reclaim 候选（嵌套保护与空壳空判据在全部主体分类完后统一判定）。
    classifications.set(runId, { category: "reclaim_candidate" });
  };
  while (pendingIds.length > 0) {
    const batch = pendingIds.splice(0, pendingIds.length).sort();
    for (const runId of batch) await classifyRun(runId);
  }

  // 树按真实路径分组：同一路径只要有一个成员落在保留，整棵树就保留。
  const treeGroups = new Map();
  for (const [runId, f] of facts) {
    if (f.treeRealPath && classifications.get(runId)?.category !== "out_of_scope") {
      const key = f.treeRealPath.toLowerCase();
      if (!treeGroups.has(key)) treeGroups.set(key, []);
      treeGroups.get(key).push(runId);
    }
  }
  for (const [, members] of treeGroups) {
    const anyKeep = members.some((r) => classifications.get(r)?.category !== "reclaim_candidate");
    if (anyKeep) {
      for (const r of members) {
        if (classifications.get(r)?.category === "reclaim_candidate") {
          classifications.set(r, { category: "tree_shared", reason: "shared_tree_kept" });
        }
      }
    }
  }

  // 嵌套保护：树内部有任何保留/无法判定的路径，或其他不在删除集的在册 worktree。
  const reclaimTreeReals = new Set(
    [...facts.entries()]
      .filter(([r, f]) => classifications.get(r)?.category === "reclaim_candidate" && f.treeRealPath && !f.isHusk && !f.isLooseSymlink)
      .map(([, f]) => f.treeRealPath.toLowerCase()),
  );
  const blockedPaths = [];
  for (const [, f] of facts) {
    if (f.treeRealPath && !reclaimTreeReals.has(f.treeRealPath.toLowerCase())) blockedPaths.push(f.treeRealPath);
    // 没有可用真实路径的保留项（歧义候选、未登记的链接）按路径本身挡住外层树。
    for (const p of f.protectPaths ?? []) blockedPaths.push(p);
    if (f.isLooseSymlink && f.treePath) blockedPaths.push(f.treePath);
  }
  for (const real of registeredReals) {
    if (!reclaimTreeReals.has(real.toLowerCase())) blockedPaths.push(real);
  }
  for (const [runId, f] of facts) {
    if (classifications.get(runId)?.category !== "reclaim_candidate" || !f.treeRealPath || f.isHusk || f.isLooseSymlink) continue;
    if (blockedPaths.some((b) => isBelow(b, f.treeRealPath))) {
      classifications.set(runId, { category: "tree_protection", reason: "has_kept_descendant" });
    }
  }

  // 空壳目录第 8 类的空判据（非空 → 保留，树级保护类；未裁决的非空空壳已在
  // 第 5 类被 undecided_dirty_tree 拦下，这里只剩已裁决/线系已关的形态）。
  for (const h of husks) {
    if (classifications.get(h.name)?.category === "reclaim_candidate" && !isDirEmpty(h.path)) {
      classifications.set(h.name, { category: "tree_protection", reason: "husk_not_empty" });
    }
  }

  // ── 生成 items ──
  // items[].facts——Owner 按 sha256 批准时要看的审批事实（保留与回收条目都带；
  // 同一 runId 的多条目共享同一份）：
  //   lastDecision        "accepted" | "rejected" | "none"——这条运行最后一个
  //                       交付决定。仅在转录可读且无孪生时在场（缺席 = 事实不
  //                       可知，不作"没有决定"解）
  //   terminalState       运行终态字符串（run.state_change 的最后一个 to，如
  //                       "completed"；无状态事件时为 null）。在场条件同上
  //   transcriptLocations ("archive" | "flat" | "projects")[]——转录副本所在
  //                       （按字母序）。恒在场：空数组 = 三处皆无转录
  // 是否已并入 main 与 cherry 数沿用条目的 info.mergedIntoMain /
  // info.cherryPlus，不在此另造一份。
  const approvalFactsOf = new Map();
  const approvalFacts = (runId) => {
    if (approvalFactsOf.has(runId)) return approvalFactsOf.get(runId);
    const info = runInfo(runId);
    const locations = [];
    for (const loc of ["archive", "flat", "projects"]) {
      if ((transcripts.byRun.get(runId)?.files ?? []).some((f) => (
        loc === "archive" ? f.month != null : loc === "projects" ? f.bucket != null : f.bucket == null && f.month == null
      ))) locations.push(loc);
    }
    const facts = { transcriptLocations: locations };
    if (!info.twin && !info.unreadable && !info.missing) {
      facts.lastDecision = info.decision === "accepted" || info.decision === "rejected" ? info.decision : "none";
      facts.terminalState = info.state ?? null;
    }
    approvalFactsOf.set(runId, facts);
    return facts;
  };
  const items = [];
  const deleteBranchSet = new Set();
  for (const runId of [...facts.keys()].sort()) {
    const f = facts.get(runId);
    const cls = classifications.get(runId) ?? { category: "undeterminable", reason: "git_fact_failed", detail: "no_classification" };
    const notes = included.has(runId) ? ["Owner 点名"] : [];
    const keepItem = (reason, detail) => ({
      runId,
      category: cls.category,
      action: "keep",
      reason,
      ...(detail ? { detail } : {}),
      ...(f.branch ? { branch: f.branch.branch, branchTip: f.branch.tip } : {}),
      ...(f.treePath ? { treePath: f.treePath } : {}),
    });
    if (cls.category !== "reclaim_candidate") {
      items.push({ ...keepItem(cls.reason, cls.detail), facts: approvalFacts(runId) });
      continue;
    }
    // 嵌套项（父树是关联工作树）的范围证明：apply 逐项重证的依据；主根项不
    // 带——其范围由仓库身份与路径位置自证。treeRealPath 同时充当"目标真实
    // 路径"证明腿。
    const rootInfo = f.treeRealPath != null ? scopeRootOf(f.treeRealPath) : null;
    const scopeProof = rootInfo && rootInfo.linked
      ? { scopeRoot: rootInfo.parentReal, scopeGitCommonDir: rootInfo.gitCommonDir }
      : {};
    if (f.isHusk) {
      items.push({
        runId,
        category: "reclaim",
        action: "rmdir_husk",
        treePath: f.treePath,
        treeRealPath: f.treeRealPath,
        ...scopeProof,
        notes,
        facts: approvalFacts(runId),
      });
      continue;
    }
    // 树条目只由属主（目录名 = runId）发出；经转录绑定共享树的成员由属主
    // 条目连带处置，不重复 remove_tree。
    const ownsTree = !!f.treePath && !f.isLooseSymlink && basename(f.treePath) === runId;
    if (ownsTree) {
      const d = f.fingerprint?.dirty ?? { staged: false, unstaged: false, untracked: false, ignored: false };
      const treeNotes = [...notes];
      if (d.staged || d.unstaged || d.untracked || d.ignored) treeNotes.push("脏树：删除即丢弃未提交内容");
      // 记下这棵树当时的全部成员 runId（属主 + 声明绑定到该真实路径的全部
      // runId）。apply 复核"计划里的成员"∪"当前声明这棵树的成员"：只看当前
      // 名单会在成员转录消失时漏掉它（树被整棵误删），计划名单是批准时点的
      // 成员快照。
      const memberIds = new Set([runId]);
      for (const m of transcripts.byDeclaredReal.get(f.treeRealPath?.toLowerCase() ?? "") ?? []) memberIds.add(m);
      items.push({
        runId,
        category: "reclaim",
        action: "remove_tree",
        treePath: f.treePath,
        treeRealPath: f.treeRealPath,
        ...scopeProof,
        treeMembers: [...memberIds].sort(),
        treeBranch: f.treeBranch ?? null,
        branch: f.branch?.branch ?? null,
        branchTip: f.branch?.tip ?? null,
        fingerprint: {
          head: f.fingerprint?.head ?? null,
          worktreeDiffSha256: f.fingerprint?.worktreeDiffSha256 ?? null,
          indexDiffSha256: f.fingerprint?.indexDiffSha256 ?? null,
          untrackedIgnoredManifestSha256: f.fingerprint?.untrackedIgnoredManifestSha256 ?? null,
        },
        dirty: d,
        notes: treeNotes,
        facts: approvalFacts(runId),
      });
    }
    if (f.branch) {
      deleteBranchSet.add(f.branch.branch);
      items.push({
        runId,
        category: "reclaim",
        action: "delete_branch",
        branch: f.branch.branch,
        branchTip: f.branch.tip,
        notes,
        facts: approvalFacts(runId),
      });
    }
    if (!ownsTree && !f.branch) {
      if (f.treePath) continue; // 绑定共享树的成员：树由属主条目处置，无独立目标
      items.push({ ...keepItem("git_fact_failed", "no_actionable_target"), notes, facts: approvalFacts(runId) });
    }
  }

  // 信息字段（不作安全依据）：并入 / cherry+ 行数 / 相对清退后仍保留引用的独有提交。
  const excludeArgs = [...deleteBranchSet].map((b) => `--exclude=${b}`);
  for (const item of items) {
    if (!item.branchTip) continue;
    const ref = `refs/heads/${item.branch}`;
    item.info = { mergedIntoMain: branchMergedIntoMain(ref) };
    try {
      item.info.cherryPlus = gitReadOnly(["cherry", compareBase, ref], repo.mainWorktreePath)
        .split(/\r?\n/).filter((l) => l.startsWith("+")).length;
    } catch {
      item.info.cherryPlus = null;
    }
    try {
      const out = gitReadOnly([
        "rev-list", "--count", ref, "--not", ...excludeArgs, "--branches", ...excludeArgs, "--tags",
      ], repo.mainWorktreePath).trim();
      item.info.uniqueCommitsVsKept = /^\d+$/.test(out) ? Number(out) : null;
    } catch {
      item.info.uniqueCommitsVsKept = null;
    }
  }

  const byCategory = {};
  for (const cat of RECLAIM_CATEGORIES) byCategory[cat] = 0;
  for (const cls of classifications.values()) {
    const cat = cls.category === "reclaim_candidate" ? "reclaim" : cls.category;
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
  }

  const plan = {
    version: 1,
    generatedAt: new Date(now()).toISOString(),
    repo: {
      gitCommonDir: repo.gitCommonDir,
      mainWorktreePath: repo.mainWorktreePath,
      mainBranch: repo.mainBranch,
      mainHead: repo.mainHead,
    },
    runDir: runDirAbs,
    include: [...included].sort(),
    counts: {
      worktrees: repo.worktrees.length,
      waoBranches: branches.length,
      byCategory,
    },
    items,
  };
  const bytes = Buffer.from(JSON.stringify(plan, null, 2) + "\n", "utf8");
  if (outPath) writeFileSync(outPath, bytes);
  return { plan, planSha256: sha256Hex(bytes), outPath, ...(warning ? { warning } : {}) };
}

/** 当前仓库计数（apply 前后对账）。 */
function currentCounts(sourceRepo) {
  let worktrees = 0;
  let waoBranches = 0;
  try {
    worktrees = parseWorktreePorcelain(gitReadOnly(["worktree", "list", "--porcelain"], sourceRepo)).length;
  } catch { /* 计数失败不阻塞 */ }
  try {
    waoBranches = gitReadOnly(["for-each-ref", "refs/heads/wao/"], sourceRepo)
      .split(/\r?\n/).filter((l) => l.trim().length > 0).length;
  } catch { /* 计数失败不阻塞 */ }
  return { worktrees, waoBranches };
}

/**
 * apply 侧"仍不在跑"复核（删树前，对这棵树的每个成员逐个现读磁盘，不用
 * apply 开头建的事实索引——索引建好之后、删除之前，成员可能新增了事件）。
 * 成员自己的转录文件由调用方刚枚举好传入（filesByRun，来自增量刷新后的现
 * 枚举）；线系枚举的候选文件集来自刷新后的 byRoot（成员判据只依赖每个文件
 * 自身的事件），但每个候选文件的内容也现读（不共享 readMemo）。
 * factsView = { byRoot, poison }（poison 仍是索引时点的全局毒化面，调用方已
 * 检查过，这里兜底）。返回 {active:true,detail} | {active:false} |
 * {undetermined:true,detail}：转录此刻缺失/孪生 → undetermined（找不到转录
 * ≠不在跑，按无法判定跳过）；读不出来 → active（保守）；毒化面 → active。
 */
async function stillActiveFromDisk(runId, filesByRun, factsView, runDirAbs, now) {
  try {
    if (checkOwnerLiveness(runDirAbs, runId, now()).fresh) {
      return { active: true, detail: "fresh_owner_heartbeat" };
    }
  } catch { /* 心跳读不了按无心跳 */ }
  const files = filesByRun.get(runId);
  if (!files || files.length === 0) return { undetermined: true, detail: "transcript_missing_now" };
  const reads = [];
  for (const f of files) {
    try {
      reads.push(await readTranscript(f.path));
    } catch {
      return { active: true, detail: "transcript_unreadable_now" };
    }
  }
  if (reads.length > 1) {
    const states = reads.map((ev) => lastBoundState(ev, runId));
    if (states.some((s) => s !== states[0])) return { undetermined: true, detail: "twin_transcripts_now" };
  }
  const events = reads.flat();
  const state = lastBoundState(events, runId);
  if (state && !TERMINAL_STATES.includes(state)) return { active: true, detail: "non_terminal" };
  // 孪生副本各自取最后一条绑定事件的时间，再取各副本的最大值——拼接后取
  // "最后一条"会让排在数组后面的较旧归档副本盖住平铺副本里刚发生的事件，
  // 15 分钟保护失效。终态判断照旧（终态不同仍按无法判定，上方已拒）。
  let ts = null;
  for (const ev of reads) {
    const t = lastBoundEventTs(ev, runId);
    if (t != null && (ts == null || t > ts)) ts = t;
  }
  const parsed = ts ? Date.parse(ts) : NaN;
  if (Number.isFinite(parsed) && now() - parsed < RECENT_BOUND_EVENT_MS) {
    return { active: true, detail: "recent_event" };
  }
  if (factsView.poison) return { active: true, detail: `lineage_refused_now:${factsView.poison.reason}` };
  const root = lineageRootFromEvents(events, runId) ?? runId;
  const freshRead = async (path) => {
    try {
      return { ok: true, events: await readTranscript(path) };
    } catch (error) {
      return { ok: false, error };
    }
  };
  const enumerated = await enumerateLineageMembers(root, factsView.byRoot.get(root) ?? [], freshRead);
  if (enumerated.refuse) return { active: true, detail: `lineage_refused_now:${enumerated.refuse}` };
  if (enumerated.members.some((m) => !TERMINAL_STATES.includes(m.state ?? ""))) {
    return { active: true, detail: "lineage_member_active" };
  }
  if ((await lineageSlotClaimBusy(runDirAbs, new Set(enumerated.members.map((m) => m.runId)), { nowMs: now })).busy) {
    return { active: true, detail: "slot_claim_fresh" };
  }
  return { active: false };
}

/**
 * 嵌套项（父树是关联工作树）的范围重证（apply 删树/删空壳前）。逐项重新证
 * 明：父树仍在册、仍与主检出同一 common git dir、父树真实路径未变（登记里
 * 仍有真实路径等于 scopeRoot 的条目）、目标仍是 <父树>/.wao-worktrees/<runId>、
 * 父树根与中间级（.wao-worktrees）逐级非符号链接/junction。任一不成立、读
 * 不出或证明字段缺席（旧形状计划）→ 闭集跳过理由，树与分支都保留。
 */
function reverifyNestedScope(item, ctx, reg) {
  const scopeRoot = item.scopeRoot;
  const scopeCommonDir = item.scopeGitCommonDir;
  if (typeof scopeRoot !== "string" || !scopeRoot
    || typeof scopeCommonDir !== "string" || !scopeCommonDir
    || typeof item.treeRealPath !== "string" || !item.treeRealPath) {
    return { skip: "scope_proof_missing" };
  }
  const rootReal = join(scopeRoot, ".wao-worktrees");
  if (!samePath(dirname(item.treeRealPath), rootReal)
    || !samePath(basename(item.treeRealPath), item.runId)
    || !isValidRunId(item.runId)) {
    return { skip: "scope_proof_invalid" };
  }
  if (!reg.records.some((r) => r.real != null && samePath(r.real, scopeRoot))) {
    return { skip: "scope_parent_gone", detail: scopeRoot };
  }
  let common;
  try {
    common = commonDirOf(scopeRoot);
  } catch {
    return { skip: "scope_common_dir_mismatch", detail: "unreadable" };
  }
  if (!samePath(common, scopeCommonDir) || !samePath(common, ctx.commonDir)) {
    return { skip: "scope_common_dir_mismatch", detail: common };
  }
  for (const level of [scopeRoot, rootReal]) {
    let st;
    try {
      st = lstatSync(level);
    } catch {
      return { skip: "scope_parent_gone", detail: level };
    }
    if (st.isSymbolicLink()) return { skip: "scope_symlink_now", detail: level };
    if (!st.isDirectory()) return { skip: "scope_parent_gone", detail: level };
  }
  return { ok: true };
}

/** 删树前复核：真实路径、HEAD/分支/tip、指纹（嵌套在册树不计入清单）、嵌套
 * 保护、整树每个成员仍在跑与否（计划成员名单 ∪ apply 索引时点名单 ∪ 增量
 * 刷新后的当前声明名单，逐成员从磁盘现读；线系候选集用刷新后的 byRoot）。
 * 变化 → 闭集理由。嵌套项先重证范围（先于对目标的 lstat——中间级的链接要
 * 在目标路径复核之前拦下）。 */
async function reverifyTreeBeforeRemoval(item, ctx) {
  const reg = ctx.liveRegState("tree_recheck");
  if (ctx.nestedShape(item)) {
    if (reg.unreadable) return { skip: "undeterminable_now", detail: "live_registration_unreadable" };
    const scope = reverifyNestedScope(item, ctx, reg);
    if (scope.skip) return scope;
  }
  const p = item.treePath;
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return { skip: "tree_missing" };
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return { skip: "symlink_now" };
  let real;
  try {
    real = realpathSync(p);
  } catch {
    return { skip: "path_unresolvable" };
  }
  if (item.treeRealPath && !samePath(real, item.treeRealPath)) return { skip: "path_changed" };
  try {
    const branch = gitReadOnly(["rev-parse", "--abbrev-ref", "HEAD"], p).trim();
    const head = gitReadOnly(["rev-parse", "HEAD"], p).trim();
    if (branch !== item.treeBranch) return { skip: "head_changed", detail: branch };
    if (item.branchTip && !samePath(head, item.branchTip)) return { skip: "head_changed", detail: head };
  } catch {
    return { skip: "head_changed" };
  }
  if (reg.unreadable) return { skip: "undeterminable_now", detail: "live_registration_unreadable" };
  try {
    const nestedExcluded = reg.raws
      .filter((raw) => raw !== p && isBelow(raw, p))
      .map((raw) => relative(p, raw).split(sep).join("/"));
    const fp = await computeTreeFingerprint(p, { nestedExcluded });
    if (fp.head !== item.fingerprint.head
      || fp.worktreeDiffSha256 !== item.fingerprint.worktreeDiffSha256
      || fp.indexDiffSha256 !== item.fingerprint.indexDiffSha256
      || fp.untrackedIgnoredManifestSha256 !== item.fingerprint.untrackedIgnoredManifestSha256) {
      return { skip: "content_changed", dirty: fp.dirty };
    }
  } catch {
    return { skip: "content_changed" };
  }
  for (const wt of reg.reals) {
    if (isBelow(wt, item.treeRealPath) && !ctx.reclaimTreeReals.has(wt.toLowerCase())) {
      return { skip: "kept_descendant_now", detail: wt };
    }
  }
  // 转录事实按磁盘现状增量刷新（新出现/size·mtime 变了的文件现读重算，未变
  // 的沿用 apply 开头的索引——转录只追加）。成员名单与线系候选集都用刷新后
  // 的聚合：索引建好之后新声明这棵树/新绑进线系的运行，只有这里看得到。
  let refreshed;
  try {
    refreshed = await refreshTranscriptFacts(ctx.transcripts, ctx.runDirAbs);
  } catch {
    return { skip: "undeterminable_now", detail: "transcript_enumeration_failed" };
  }
  if (refreshed.statFailed != null) {
    return { skip: "undeterminable_now", detail: `transcript_stat_failed:${refreshed.statFailed}` };
  }
  if (refreshed.skipped.length > 0) {
    return { skip: "undeterminable_now", detail: `lineage_refused_now:archive_enumeration_skipped:${refreshed.skipped[0]?.dir ?? refreshed.skipped[0]?.file ?? ""}` };
  }
  if (refreshed.unreadableNow.length > 0) {
    return { skip: "undeterminable_now", detail: `transcript_unreadable_now:${refreshed.unreadableNow[0]}` };
  }
  if (ctx.transcripts.poison) {
    return { skip: "undeterminable_now", detail: `lineage_refused_now:${ctx.transcripts.poison.reason}:${ctx.transcripts.poison.detail}` };
  }
  const filesByRun = new Map();
  for (const f of refreshed.files) {
    const id = f.name.replace(/\.jsonl$/, "");
    if (!filesByRun.has(id)) filesByRun.set(id, []);
    filesByRun.get(id).push(f);
  }
  const factsView = { byRoot: refreshed.byRoot, poison: ctx.transcripts.poison };
  // 共享树按**每个成员**复核：计划名单（item.treeMembers，批准时点快照）∪
  // apply 索引时点的声明名单 ∪ 刷新后的当前声明名单。只看当前名单会在成员
  // 转录消失时漏掉它；只看计划名单会漏掉批准后才绑上来的成员。任一成员在
  // 跑 → 整树跳过；任一成员无法判定（转录缺失/孪生）→ 整树跳过。
  const planMembers = Array.isArray(item.treeMembers) ? item.treeMembers : [];
  const memberIds = new Set([
    item.runId,
    ...planMembers,
    ...(ctx.transcripts.byDeclaredReal.get(item.treeRealPath.toLowerCase()) ?? []),
    ...(refreshed.byDeclaredReal.get(item.treeRealPath.toLowerCase()) ?? []),
  ]);
  for (const memberRunId of memberIds) {
    const a = await stillActiveFromDisk(memberRunId, filesByRun, factsView, ctx.runDirAbs, ctx.now);
    if (a.active) return { skip: "running_now", detail: `${memberRunId}:${a.detail}` };
    if (a.undetermined) return { skip: "undeterminable_now", detail: `${memberRunId}:${a.detail}` };
  }
  return { ok: true };
}

/**
 * 执行已批准计划。任一整体拒绝码 → 不再执行任何删除（bundle_* 三码发生时
 * 保全目录与 bundle 可能已写盘，见 RECLAIM_REFUSAL_CODES 注释）。删除顺序：
 * bundle 保全 → 摘树（嵌套深度降序，逐棵复核）→ 只删本次摘掉的树的管理条目
 *（不做仓库级 prune）→ 删分支（CAS + 检出门）→ 删空壳 → 记录落保全目录。
 * 无论成功、跳过还是中途异常，记录都落盘（finally）；中途异常如实标记
 * （aborted），CLI 以非零退出码结束。
 * @param {Function} [beforeBranchDelete] 测试缝：分支预检与检出判断之后、CAS
 *   删除之前（生产为 null）。
 * @param {Function} [beforeTreeSnapshot] 测试缝：脏树快照写盘之前（生产为 null）。
 * @param {Function} [afterTranscriptIndex] 测试缝：apply 的事实索引建好之后、
 *   摘树之前——用于在索引缓存之后改变磁盘转录，证明删前复核读的是最新内容
 *   （生产为 null）。
 * @param {Function} [removeTreeExec] 测试缝：摘树 git 调用的替身（item =>
 *   执行删除或抛错；生产为 null，用真实 git）。
 * @param {Function} [worktreeListFn] 测试缝：实时登记读取的替身
 *   （(phase: "tree_recheck" | "branch_delete") => `git worktree list
 *   --porcelain` 文本；抛错 = git 失败。生产为 null，用真实 git）。
 * @returns {Promise<object>} { refused } 或 { countsBefore, countsAfter, results, ... }
 */
export async function applyWorktreeReclaim({
  planPath, expectSha256, runDir, now = Date.now, beforeBranchDelete = null, beforeTreeSnapshot = null,
  afterTranscriptIndex = null, removeTreeExec = null, worktreeListFn = null,
}) {
  let planBytes;
  try {
    planBytes = readFileSync(resolve(planPath));
  } catch {
    return { refused: "plan_unreadable" };
  }
  if (sha256Hex(planBytes) !== String(expectSha256).toLowerCase()) {
    return { refused: "sha_mismatch" };
  }
  let plan;
  try {
    plan = JSON.parse(planBytes.toString("utf8"));
  } catch {
    return { refused: "plan_unreadable" };
  }
  if (plan?.version !== 1 || !Array.isArray(plan.items) || !plan.repo?.gitCommonDir
    || !plan.repo?.mainWorktreePath || typeof plan.runDir !== "string") {
    return { refused: "plan_unreadable" };
  }
  const sourceRepo = plan.repo.mainWorktreePath;
  if (!existsSync(sourceRepo)) return { refused: "repo_identity_mismatch" };
  let commonDir;
  try {
    commonDir = commonDirOf(sourceRepo);
  } catch {
    return { refused: "repo_identity_mismatch" };
  }
  if (!samePath(commonDir, plan.repo.gitCommonDir) || !samePath(realpathSync(sourceRepo), plan.repo.mainWorktreePath)) {
    return { refused: "repo_identity_mismatch" };
  }

  // apply 一律用计划里的 runDir（生成与执行必须是同一个转录库）；调用方另传
  // 了不同的目录就整体拒绝——换库复核会把"找不到转录"误判成"不在跑"。
  const planRunDir = resolve(String(plan.runDir ?? ""));
  const runDirAbs = resolve(runDir ?? plan.runDir);
  if (runDir != null && !samePath(runDirAbs, planRunDir)) {
    return { refused: "run_dir_mismatch", detail: `${runDirAbs} != 计划 ${planRunDir}` };
  }
  const treeItems = plan.items.filter((i) => i.action === "remove_tree");
  const branchItems = plan.items.filter((i) => i.action === "delete_branch");
  const huskItems = plan.items.filter((i) => i.action === "rmdir_husk");
  const targets = [...treeItems.map((i) => i.treePath), ...huskItems.map((i) => i.treePath)];

  const stamp = new Date(now());
  const pad = (n) => String(n).padStart(2, "0");
  const month = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}`;
  const repoName = basename(sourceRepo).replace(/[^A-Za-z0-9._-]/g, "_") || "repo";
  const moment = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
  const preserveBase = join(dirname(runDirAbs.replace(/[\\/]+$/, "")), "runs-archive", month, `worktree-reclaim-${repoName}-${moment}`);
  // 越界拒绝（零写盘，先于任何 mkdir；保全目录越界先于 runDir 越界判定）。
  const preserveInsideTarget = (cand) => targets.some((t) => samePath(cand, t) || isBelow(cand, t));
  const firstFree = (() => {
    for (let attempt = 1; attempt <= 99; attempt += 1) {
      const cand = attempt === 1 ? preserveBase : `${preserveBase}-${attempt}`;
      if (!existsSync(cand)) return cand;
    }
    return null;
  })();
  if (!firstFree) throw new Error(`worktree reclaim: 保全目录命名空间耗尽（${preserveBase}）`);
  if (preserveInsideTarget(firstFree)) return { refused: "preserve_dir_inside_target" };
  if (targets.some((t) => isBelow(runDirAbs, t))) return { refused: "run_dir_inside_target" };
  // 保全目录名只精确到秒：同一秒内的两次 apply 不得互相覆盖记录。首次写盘时
  // 原子 mkdir 抢位；同秒竞争者已抢到位就换名（-2、-3…）并重跑越界检查。
  let preserveDir = null;
  const claimPreserveDir = () => {
    if (preserveDir) return preserveDir;
    for (let attempt = 1; attempt <= 99; attempt += 1) {
      const cand = attempt === 1 ? preserveBase : `${preserveBase}-${attempt}`;
      if (existsSync(cand)) continue;
      if (preserveInsideTarget(cand)) throw new Error(`worktree reclaim: 保全目录越界（${cand}）`);
      try {
        mkdirSync(dirname(cand), { recursive: true });
        mkdirSync(cand);
        preserveDir = cand;
        return preserveDir;
      } catch (error) {
        if (error?.code === "EEXIST") continue;
        throw error;
      }
    }
    throw new Error(`worktree reclaim: 保全目录命名空间耗尽（${preserveBase}）`);
  };

  const countsBefore = currentCounts(sourceRepo);
  const results = [];

  // ── 分支预检：ref 已不等计划 tip（被推进或删掉）→ 逐条跳过 ref_moved，
  // 不进 bundle、不毒化整份计划（update-ref -d 的 CAS 是权威门，这里只是
  // 让 bundle 只装仍匹配的分支，使 list-heads 核对对得上计划 tip）。──
  const movedBranches = new Set();
  const bundleBranchItems = [];
  for (const item of branchItems) {
    let live = null;
    try {
      live = gitReadOnly(["rev-parse", `refs/heads/${item.branch}`], sourceRepo).trim();
    } catch { /* ref 已不存在 */ }
    if (!live || live.toLowerCase() !== item.branchTip.toLowerCase()) {
      movedBranches.add(item.branch);
      results.push({ runId: item.runId, action: "delete_branch", outcome: "skipped", reason: "ref_moved", branch: item.branch });
    } else {
      bundleBranchItems.push(item);
    }
  }

  // ── 保全：全部待删分支进一个 bundle（完整历史），verify + list-heads 双核 ──
  let bundleSha256 = null;
  let bundlePath = null;
  if (bundleBranchItems.length > 0) {
    try {
      bundlePath = join(claimPreserveDir(), "branches.bundle");
      gitText(["bundle", "create", bundlePath, ...bundleBranchItems.map((i) => `refs/heads/${i.branch}`)], sourceRepo);
    } catch {
      return { refused: "bundle_create_failed", countsBefore };
    }
    try {
      gitReadOnly(["bundle", "verify", bundlePath], sourceRepo);
    } catch {
      return { refused: "bundle_verify_failed", countsBefore };
    }
    let heads;
    try {
      heads = gitText(["--no-optional-locks", "bundle", "list-heads", bundlePath], sourceRepo);
    } catch {
      return { refused: "bundle_verify_failed", countsBefore };
    }
    const headMap = new Map();
    for (const line of heads.split(/\r?\n/)) {
      const m = line.match(/^([0-9a-f]{40})\s+(\S+)$/);
      if (m) headMap.set(m[2].replace(/^refs\/heads\//, ""), m[1]);
    }
    for (const i of bundleBranchItems) {
      const inBundle = headMap.get(i.branch);
      if (!inBundle || inBundle.toLowerCase() !== i.branchTip.toLowerCase()) {
        return { refused: "bundle_heads_mismatch", countsBefore, detail: i.branch };
      }
    }
    bundleSha256 = sha256Hex(readFileSync(bundlePath));
  }

  // ── 事实索引（apply 全程一份：普查级缓存——线系候选集 byRoot、当前成员
  // byDeclaredReal、全局毒化面。删每棵树前的复核不读它的内容，逐成员现读
  // 磁盘）。──
  const transcripts = await buildTranscriptFacts(runDirAbs);
  // 测试缝：索引建好之后、摘树之前——在缓存之后改变磁盘转录，证明删前复核
  // 读的是最新内容而非索引。生产为 null。
  if (typeof afterTranscriptIndex === "function") await afterTranscriptIndex(transcripts);

  // ── 摘树（嵌套深度降序：最深先）──
  // reclaimTreeReals 是"将被删除"的活集：子树被跳过或删除失败后必须从中拿掉，
  // 否则父树复核会把它当成"本来就要删"的后代而忽略，强删父树把仍在册的子树
  // 一起带走。
  const reclaimTreeReals = new Set(treeItems.map((i) => (i.treeRealPath ?? i.treePath).toLowerCase()));
  // 目录缺失的在册登记（realpath 失败）：不是活的检出，不清（本命令不做仓库
  // 级 prune），累计上报让 CLI 以非零退出码提示操作者走通用清扫。
  const staleRegistrations = new Set();
  // phase 标注读取用途（"tree_recheck" 摘树前复核 / "branch_delete" 删分支
  // 前的检出判断）；worktreeListFn 是测试缝，生产用真实 git。
  const liveRegState = (phase) => {
    const out = { unreadable: false, entries: [], raws: [], reals: [], stale: [], records: [] };
    let entries;
    try {
      const text = typeof worktreeListFn === "function"
        ? worktreeListFn(phase)
        : gitReadOnly(["worktree", "list", "--porcelain"], sourceRepo);
      entries = parseWorktreePorcelain(text);
    } catch {
      out.unreadable = true;
      return out;
    }
    out.entries = entries;
    for (const w of entries) {
      const raw = resolve(w.path);
      out.raws.push(raw);
      let real = null;
      try {
        real = realpathSync(raw);
      } catch {
        out.stale.push(raw);
        staleRegistrations.add(raw);
      }
      out.records.push({ raw, real });
      if (real != null) out.reals.push(real);
    }
    return out;
  };
  // 嵌套项判定：目标真实路径的父目录不是主检出的 .wao-worktrees。这类条目
  // 必须带范围证明字段并逐项重证；旧形状计划里的嵌套回收项不存在（旧分类一
  // 律保留），字段缺席即不动。
  const mainRoot = join(plan.repo.mainWorktreePath, ".wao-worktrees");
  const nestedShape = (item) => {
    const real = typeof item.treeRealPath === "string" && item.treeRealPath
      ? item.treeRealPath
      : resolve(String(item.treePath ?? ""));
    return !samePath(dirname(real), mainRoot);
  };
  const ctx = {
    transcripts,
    runDirAbs,
    now,
    reclaimTreeReals,
    liveRegState,
    nestedShape,
    commonDir,
  };
  const orderedTrees = [...treeItems].sort((a, b) => b.treePath.split(sep).length - a.treePath.split(sep).length);
  const failedBranches = new Set();
  const dirtySnapshots = [];
  const removedTrees = [];
  const missingTreePaths = new Map(); // runId → treePath（tree_missing 跳过的）
  let aborted = null;
  let recordsWriteFailed = false;
  let liveRegistrationUnreadable = false;
  let countsAfter = null;
  let executionCounts = {};
  // 分类计数沿用计划文件里的 byCategory（分类在计划时就已确定；按 runId 计，
  // 含没有独立条目的共享成员——apply 不得另算一套口径）。执行结果按条目单列
  //（executionCounts），两处标签各自写清数的是什么。
  const byCategory = plan.counts?.byCategory ?? {};
  try {
    for (const item of orderedTrees) {
      const check = await reverifyTreeBeforeRemoval(item, ctx);
      if (check.skip) {
        results.push({ runId: item.runId, action: "remove_tree", outcome: "skipped", reason: check.skip, ...(check.detail ? { detail: check.detail } : {}) });
        if (check.skip === "tree_missing") missingTreePaths.set(item.runId, item.treePath);
        if (item.branch && check.skip !== "tree_missing") failedBranches.add(item.branch);
        reclaimTreeReals.delete((item.treeRealPath ?? item.treePath).toLowerCase());
        continue;
      }
      const d = check.dirty ?? item.dirty;
      if (d && (d.staged || d.unstaged || d.untracked || d.ignored)) {
        // 脏树快照（SOP 要求）：记丢了哪些路径，不是内容。快照写失败时这棵树
        // 不删（记为跳过、分支不删）——记录是销毁的审计面，失败不能吞。
        let snapPath = null;
        try {
          const claimed = claimPreserveDir();
          // 测试缝：快照写盘前一刻（保全目录已抢占后）——用于注入快照失败，证明
          // 快照失败会让这棵树跳过而不是继续删除。生产为 null。
          if (typeof beforeTreeSnapshot === "function") await beforeTreeSnapshot(item, claimed);
          mkdirSync(join(claimed, "dirty"), { recursive: true });
          const raw = execFileSync("git", ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"], {
            cwd: item.treePath,
            env: gitChildEnv(),
            windowsHide: true,
            maxBuffer: 64 * 1024 * 1024,
          });
          snapPath = join(claimed, "dirty", `${item.runId.replace(/[^A-Za-z0-9._-]/g, "_")}.status.txt`);
          writeFileSync(snapPath, raw);
          dirtySnapshots.push(snapPath);
        } catch {
          results.push({ runId: item.runId, action: "remove_tree", outcome: "skipped", reason: "dirty_snapshot_failed", branch: item.branch ?? null });
          if (item.branch) failedBranches.add(item.branch);
          reclaimTreeReals.delete((item.treeRealPath ?? item.treePath).toLowerCase());
          continue;
        }
      }
      try {
        // 测试缝：摘树 git 调用的替身（注入"git remove 失败但目录仍在"，代替
        // 独占文件锁）。生产为 null，用真实 git。
        if (typeof removeTreeExec === "function") await removeTreeExec(item);
        else gitText(["worktree", "remove", "--force", item.treePath], sourceRepo);
      } catch { /* 删后复检裁决 */ }
      if (existsSync(item.treePath)) {
        results.push({ runId: item.runId, action: "remove_tree", outcome: "failed_still_present", branch: item.branch ?? null });
        if (item.branch) failedBranches.add(item.branch);
        reclaimTreeReals.delete((item.treeRealPath ?? item.treePath).toLowerCase());
      } else {
        results.push({ runId: item.runId, action: "remove_tree", outcome: "removed", branch: item.branch ?? null });
        removedTrees.push(item);
      }
    }

    // ── 摘树后的登记收尾：只删本次摘掉的树自己的管理条目（git worktree
    // remove 成功时 git 已自清，这里是对 rmSync 兜底等形态的幂等核对）。不做
    // 仓库级 prune——与别的会话正在进行的 `git worktree add` 存在关不掉的竞
    // 争（isolation.WORKTREE_PRUNE_EXPIRE 的 SSOT 注释），其他 stale 登记留给
    // serve 维护 / runs verify-commit 的通用清扫。──
    for (const item of removedTrees) {
      try {
        removeWorktreeAdminEntry(commonDir, item.treePath);
      } catch { /* 定向清理失败不阻塞：登记残留由通用清扫收 */ }
    }

    // ── 删分支（显式名单；CAS 删除 + 检出门 + bundle 已核）──
    const regState = liveRegState("branch_delete");
    if (regState.unreadable) {
      // 检出面读不出时无法证明"没有 worktree 还检出它"，而 update-ref -d 的
      // 比较删除不提供检出保护——本阶段全部分支跳过（预检已记 ref_moved 的
      // 除外），如实记录，CLI 以非零退出码结束。
      liveRegistrationUnreadable = true;
      for (const item of branchItems) {
        if (movedBranches.has(item.branch)) continue; // 预检已记 skipped/ref_moved
        results.push({ runId: item.runId, action: "delete_branch", outcome: "skipped", reason: "live_registration_unreadable", branch: item.branch });
      }
    } else {
      const checkedOutBranches = new Set(
        regState.entries.map((w) => (w.branch ?? "").replace(/^refs\/heads\//, "")).filter(Boolean),
      );
      for (const item of branchItems) {
        if (movedBranches.has(item.branch)) continue; // 预检已记 skipped/ref_moved
        if (failedBranches.has(item.branch)) {
          results.push({ runId: item.runId, action: "delete_branch", outcome: "skipped", reason: "tree_not_removed", branch: item.branch });
          continue;
        }
        // 树目录在批准后被人删了、登记还在（目录缺失的在册登记）：无法证明没有
        // 活检出在用它，分支保守跳过；登记本命令不清，走通用清扫后下一轮计划
        // 再回收该分支。
        const missingPath = missingTreePaths.get(item.runId);
        if (missingPath && regState.raws.some((raw) => samePath(raw, missingPath))) {
          results.push({ runId: item.runId, action: "delete_branch", outcome: "skipped", reason: "registration_stale", branch: item.branch });
          continue;
        }
        if (checkedOutBranches.has(item.branch)) {
          results.push({ runId: item.runId, action: "delete_branch", outcome: "skipped", reason: "checked_out", branch: item.branch });
          continue;
        }
        // 测试缝：预检与检出判断都已过后、CAS 删除前一刻的钩子（证明 update-ref -d
        // 的比较删除门自身起作用，而非只靠预检拦截）。生产为 null。
        if (typeof beforeBranchDelete === "function") await beforeBranchDelete(item);
        try {
          gitText(["update-ref", "-d", `refs/heads/${item.branch}`, item.branchTip], sourceRepo);
        } catch {
          results.push({ runId: item.runId, action: "delete_branch", outcome: "skipped", reason: "ref_moved", branch: item.branch });
          continue;
        }
        // update-ref -d 不清 branch.<名> 配置节；WAO 建的分支不设上游，一般没有
        // 这一节，有的话一并清掉（remove-section 在节缺席时报错——吞掉）。
        try {
          gitText(["config", "--local", "--remove-section", `branch.${item.branch}`], sourceRepo);
        } catch { /* 节缺席或清理失败：不影响删除结果 */ }
        results.push({ runId: item.runId, action: "delete_branch", outcome: "deleted", branch: item.branch });
      }
    }

    // ── 删空壳目录（非递归 rmdir；非空即拒）。嵌套空壳同样先重证范围。──
    for (const item of huskItems) {
      if (nestedShape(item)) {
        let scopeSkip = null;
        const reg = liveRegState("tree_recheck");
        if (reg.unreadable) {
          scopeSkip = { reason: "undeterminable_now", detail: "live_registration_unreadable" };
        } else {
          const scope = reverifyNestedScope(item, ctx, reg);
          if (scope.skip) scopeSkip = { reason: scope.skip, ...(scope.detail ? { detail: scope.detail } : {}) };
        }
        if (scopeSkip) {
          results.push({ runId: item.runId, action: "rmdir_husk", outcome: "skipped", ...scopeSkip });
          continue;
        }
      }
      try {
        rmdirSync(item.treePath);
        results.push({ runId: item.runId, action: "rmdir_husk", outcome: "removed" });
      } catch (error) {
        results.push({ runId: item.runId, action: "rmdir_husk", outcome: "skipped", reason: "husk_not_empty_now", detail: error?.code ?? null });
      }
    }

    for (const item of plan.items) {
      if (item.action === "keep") results.push({ runId: item.runId, action: "keep", outcome: "kept", reason: item.reason });
    }

    countsAfter = currentCounts(sourceRepo);
  } catch (error) {
    aborted = error;
    try {
      countsAfter = currentCounts(sourceRepo);
    } catch { /* 计数失败保持 null，记录如实 */ }
  } finally {
    // 执行结果计数（按条目计：一个 runId 的 remove_tree 与 delete_branch 各计
    // 一次；与分类计数 byCategory——按 runId、沿用计划——口径不同，分别标注）。
    executionCounts = {};
    for (const r of results) {
      const key = `${r.action}:${r.outcome}`;
      executionCounts[key] = (executionCounts[key] ?? 0) + 1;
    }
    // ── 记录落保全目录（计划副本、计划 sha256、逐项结果、脏树快照、bundle
    // sha256）。无论成功、跳过还是中途异常都落盘（finally）——已删除的部分
    // 必须有审计面。写失败不逆转已执行的删除，但必须如实标记——CLI 据此以
    // 非零退出码结束且不打印"完成"。──
    try {
      const dir = claimPreserveDir();
      writeFileSync(join(dir, "plan.json"), planBytes);
      writeFileSync(join(dir, "plan-sha256.txt"), `${sha256Hex(planBytes)}\n`);
      if (bundleSha256) writeFileSync(join(dir, "bundle-sha256.txt"), `${bundleSha256}\n`);
      writeFileSync(join(dir, "results.json"), JSON.stringify({
        appliedAt: new Date(now()).toISOString(),
        countsBefore,
        countsAfter,
        byCategory,
        executionCounts,
        dirtySnapshots,
        ...(staleRegistrations.size > 0 ? { staleRegistrations: [...staleRegistrations].sort() } : {}),
        ...(liveRegistrationUnreadable ? { liveRegistrationUnreadable: true } : {}),
        aborted: aborted ? { message: aborted.message } : null,
        results,
      }, null, 2) + "\n");
    } catch {
      recordsWriteFailed = true;
    }
  }

  return {
    countsBefore, countsAfter, preserveDir, bundlePath, bundleSha256, results,
    byCategory, executionCounts, recordsWriteFailed,
    ...(liveRegistrationUnreadable ? { liveRegistrationUnreadable: true } : {}),
    ...(aborted ? { aborted: { message: aborted.message } } : {}),
    ...(staleRegistrations.size > 0 ? { staleRegistrations: [...staleRegistrations].sort() } : {}),
  };
}
