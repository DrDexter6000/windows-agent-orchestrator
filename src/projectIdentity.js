// src/projectIdentity.js
//
// TD-190 D1（选择无关部分，2026-10-09 批）：run 转录按项目分桶的项目身份
// 判定纯函数。布局接线（写入侧分桶/读取回退/迁移）等 Owner 对命名空间与
// 身份方案的裁定（决策包见 .dev/decisions-draft-2026-10-09.md）；本模块
// 只承载两种候选方案共用的地基：cwd 规范化 + 稳定项目键 + 桶 slug 派生。
//
// 规范化规则（opus 方案会审定稿，对最近 300 条首事件实测分布校准）：
//   R1 分隔符统一（\\ 与 / 混写归一——实测同仓两种写法 153:18 拆桶风险）
//   R2 win32 大小写折叠（仅用于键；displayName 保留原 basename）
//   R3 junction/symlink 解析（realpath——本机 skills/npm 皆 junction 的实况）
//   R4 `.wao-worktrees/<runId>` 回溯到所属仓根（隔离工作树不是项目）
//   R5 系统临时目录（os.tmpdir 形状）→ scratch 桶（一次性探针目录不占项目桶）
//   R6 "."/空/缺失 → unattributed（**身份缺失 ≠ 原路径失效**，两类事实分开，
//      不把无法 realpath 的历史路径静默归入 scratch）
//   R7 外国 harness 沙箱（闭表，当前仅 codex exec）→ _sandbox 桶（词法判定，
//      排在 R3 前=不受沙箱树死活影响；与 scratch 分开——沙箱里是真活不是探针）
//
// 架构契约：core 纯函数；不 import src/commands/*、src/mcp/*、SDK、zod；
// filesystem 只经注入的 realpath（测试可控，生产传 node:fs realpathSync）。

import { createHash } from "node:crypto";
import { basename } from "node:path";

// Windows 保留设备名（slug 首段不得为这些——加哈希后缀已天然避开，表用于
// 显式防御性校验）。runs/ 下的既有保留目录同理（分桶命名空间待 Owner 裁定，
// 这里把两个候选命名空间的保留名都挡掉）。
const WINDOWS_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);
export const RUNS_RESERVED_DIRNAMES = Object.freeze([
  "reliability", "verify", "smoke", "projects", "_unattributed", "_scratch",
  "_sandbox", ".session-reuse", ".lineage-reuse",
]);

const WORKTREE_SEG_RE = /[\\/]\.wao-worktrees[\\/][^\\/]+(?:[\\/].*)?$/;
// R7 外国 harness 沙箱闭表（opus+sol 会审 consult_20261009101128557nyuuys）：
// 一个条目=已实测的 codex exec 沙箱。段锚定（同 R4 对 .wao-worktrees 的先例，
// 不锚 homedir——覆盖".codex 父目录搬迁"形态；注意 CODEX_HOME 整体重定向后
// 路径不含 .codex 段则不命中，届时由生产 io 注入 codexHome 锚点补齐）；两段形状 <worktree>/<repo>（repo 可
// 缺省）。**必须排在 R3 realpath 之前**：沙箱树被 harness 回收后 realpath 会
// 失败，词法判定不受树死活影响（分类确定性——opus 实证两个已死沙箱）。新
// harness 形状（zcode/claude 等）须实测路径后再入表；仓内嵌套形状
//（<repo>/.claude/worktrees/<x> 一类）属 R4 回溯族，不入本表。
const HARNESS_SANDBOX_SEGMENTS = Object.freeze([
  Object.freeze({ harness: "codex", re: /(^|\/)\.codex\/worktrees\/([^/]+)(?:\/([^/]+))?(?:\/.*)?$/i }),
]);
// 净化后显示名长度帽：覆盖常见仓名（如本仓 30 字符）仍留余量；总桶名 =
// 显示名 + '-' + 8 hex，Windows 路径预算内。
const DISPLAY_NAME_MAX = 40;

/**
 * 规范化一个转录首事件 cwd 为项目身份。
 *
 * @param {string|null|undefined} raw 转录首事件的 cwd 值（原样）
 * @param {{platform?: NodeJS.Platform, realpath?: (p:string)=>string, tmpdir?: string}} [io]
 * @returns {{kind:"project", key:string, displayName:string}
 *          |{kind:"scratch", key:string}
 *          |{kind:"unattributed", reason:string}}
 */
export function identifyProjectFromCwd(raw, io = {}) {
  const platform = io.platform ?? process.platform;
  const realpath = io.realpath ?? ((p) => p);
  if (typeof raw !== "string" || raw.length === 0) {
    return { kind: "unattributed", reason: "cwd missing or empty" };
  }
  // R1 分隔符统一（win32 与 posix 都按 / 归一；盘符保留）+ 尾斜杠归一
  //（保留纯盘符根 "D:/" 形状）。
  let p = raw.replace(/\\/g, "/");
  if (!/^[A-Za-z]:\/$/.test(p)) p = p.replace(/\/+$/, "");
  // R6 相对路径无路径身份——不猜进程 cwd（opus 终审 M4：realpath 按进程 cwd
  // 解析相对路径，归属会随进程漂移；"." 是历史实测 12 条的特例，其它相对
  // 形状同判）。
  if (p === "." || p === "./" || p.length === 0) {
    return { kind: "unattributed", reason: "cwd is a bare relative '.' — no path identity" };
  }
  // R4 隔离工作树回溯到所属仓根（worktree 段本身可含子路径）。裸相对形态
  //（无前导分隔符，实测存量出现过 `.wao-worktrees/run_x`）剥离后没有可归因
  // 的仓根——如实 unattributed（相对 worktree 路径推不出所属项目，不猜 cwd）。
  // ——特例判定在 M4 通相对门**之前**（更具体的事实先行）。
  if (/^\.wao-worktrees[\\/][^\\/]+(?:[\\/].*)?$/i.test(p)) {
    return { kind: "unattributed", reason: "cwd is a bare relative .wao-worktrees path — owning repo root not derivable" };
  }
  if (!/^[A-Za-z]:[\/]/.test(p) && !p.startsWith("/")) {
    return { kind: "unattributed", reason: `cwd is a relative path (${raw}) — identity would depend on the resolving process cwd` };
  }
  p = p.replace(WORKTREE_SEGRE_SAFE(platform), "");
  // R7 外国 harness 沙箱（词法、闭表、先于 R5/R3=确定性——沙箱树被 harness
  // 回收后 realpath 必失败，词法判定不受树死活影响）：命中即 sandbox 桶，携带
  // harness/worktreeName/repoHint（repoHint=纯词法第二段 basename，是 hint 不是
  // 归属——所属仓无法从词法证明，按 R4 裸相对先例"不猜"）。
  for (const entry of HARNESS_SANDBOX_SEGMENTS) {
    const m = p.match(entry.re);
    if (m) {
      return {
        kind: "sandbox",
        key: "_sandbox",
        harness: entry.harness,
        worktreeName: m[2],
        repoHint: m[3] ?? null,
      };
    }
  }
  // R5 系统临时目录 → scratch（一次性探针目录不占项目桶）
  const tmp = (io.tmpdir ?? defaultTmpdir(platform)).replace(/\\/g, "/").toLowerCase();
  const folded = p.toLowerCase();
  if (tmp.length > 0 && (folded === tmp || folded.startsWith(tmp + "/"))) {
    return { kind: "scratch", key: "_scratch" };
  }
  // R3 junction/symlink 解析（解析失败如实 unattributed——不静默用未解析路径
  // 当键：junction 目标才是稳定身份）
  let resolved = p;
  try {
    resolved = realpath(p).replace(/\\/g, "/");
  } catch {
    return { kind: "unattributed", reason: `realpath failed (original path no longer resolvable): ${raw}` };
  }
  // R4 在 realpath 之后重放（junction 可能揭示 worktree 段）
  resolved = resolved.replace(WORKTREE_SEGRE_SAFE(platform), "");
  // R2 win32 大小写折叠（键）；displayName 取 **resolved** 路径的 basename
  //（opus 终审 M5：取 realpath 之前的 basename 时，同 key 因原始写法/junction
  // 别名分出两个桶——桶名确定性要求 displayName 与 key 同源）。
  const key = platform === "win32" ? resolved.toLowerCase() : resolved;
  const displayNameRaw = basename(resolved.replace(/\/+$/, "")) || "project";
  return { kind: "project", key, displayName: sanitizeDisplayName(displayNameRaw) };
}

// R4 的正则按平台构造（posix 上 .wao-worktrees 段同样回溯——跨平台语义一致，
// 只是分隔符已统一为 /）。
function WORKTREE_SEGRE_SAFE(_platform) {
  return WORKTREE_SEG_RE;
}

function defaultTmpdir(_platform) {
  // 未显式传 tmpdir 时**不启用** scratch 判定（返回空串=不命中）——宁缺勿错：
  // 一个错误的兜底 tmpdir 会把整棵用户目录误判成 scratch（自查 caught：曾写
  // "c:/users" 兜底，恰是该事故形状）。生产调用方必须显式传 os.tmpdir()。
  return "";
}

function sanitizeDisplayName(name) {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, DISPLAY_NAME_MAX);
  return cleaned.length > 0 ? cleaned : "project";
}

// 桶归属事实的规则版本（与 planProjectsMigration 的 rulesVersion 同源——
// 写入首事件的归属事实携带版本，未来规则演进可区分新旧事实）。
export const PROJECT_IDENTITY_RULES_VERSION = "td190-r2";

// 生产 IO 组装（写侧调用方用；测试注入自己的 io）。集中一处避免各调用点
// 自行拼装造成 realpath/tmpdir 口径漂移。
// M5：win32 下 native 形态返回盘上规范大小写（普通形态原样返回输入的
// 大小写——displayName 派生会漂）；非 win32 两者同义。
import { realpathSync as _realpathSync } from "node:fs";
import { tmpdir as _tmpdir } from "node:os";
export function productionProjectIo() {
  // M5 Round-2 必改（双席复核出首轮空操作）：win32 必须用函数属性
  // realpathSync.native（盘上规范大小写）——它不是命名导出，首轮误当双命名
  // 导入导致两分支执行同一普通版（大写 cwd → key/bucket 漂移 + R4 大小写
  // 敏感剥离失效 → 错误事实永久入档）。非 win32 两者同义。
  const useNative = typeof process !== "undefined" && process.platform === "win32"
    && typeof _realpathSync?.native === "function";
  return {
    realpath: useNative
      ? (p) => _realpathSync.native(p)
      : (p) => _realpathSync(p),
    tmpdir: _tmpdir(),
  };
}

/**
 * TD-190 D2-②a（opus 补强#1，2026-10-09 断点续接项②的前半）：把首事件 cwd
 * 判定结果构造成**有界可序列化归属事实**，随 run.started / run.background_submitted
 * 一并落档。读侧（迁移计划器/未来查询）以记录事实为准、不再重推导——规则
 * 演进不会悄悄拆旧桶。形状（按 kind 收敛，全闭集）：
 *   project  → {kind, rulesVersion, key, bucket}
 *   sandbox  → {kind, rulesVersion, key:"_sandbox", harness, worktreeName, repoHint}
 *   scratch  → {kind, rulesVersion, key:"_scratch"}
 *   unattributed → {kind, rulesVersion, reason}
 */
export function projectFactFromCwd(rawCwd, io = productionProjectIo()) {
  const id = identifyProjectFromCwd(rawCwd, io);
  const base = { kind: id.kind, rulesVersion: PROJECT_IDENTITY_RULES_VERSION };
  if (id.kind === "project") return { ...base, key: id.key, bucket: deriveProjectBucketSlug(id) };
  if (id.kind === "sandbox") return { ...base, key: id.key, harness: id.harness, worktreeName: id.worktreeName, repoHint: id.repoHint };
  if (id.kind === "scratch") return { ...base, key: id.key };
  return { ...base, reason: id.reason };
}

// 终审 M3/F3：在档归属事实的校验闭集。bucket 安全形状=净化名段+短哈希后缀
//（^[A-Za-z0-9._-]+-[0-9a-f]{8,}$）且非保留名——事实将来就是迁移清单的 to
// 路径成分，不校验即注入面（opus 探针：kind:"remote" 产出 slug:null 桶、
// bucket:"../../evil" 原样进计划）。
export const PROJECT_FACT_KINDS = Object.freeze(["project", "sandbox", "scratch", "unattributed"]);
const FACT_BUCKET_RE = /^[A-Za-z0-9._-]+-[0-9a-f]{8,}$/;

/**
 * 终审 M2/F3/F4 共享入口：首事件的归属判定——在档 project 事实优先（校验后
 * 采用），坏事实显式报错（不静默回退掩盖损坏），legacy 无事实回退 cwd 推导。
 * 计划器与 list --project 共用同一语义（规则改版两者不再分叉）。
 *
 * @returns {{identity: object, factError: string|null}}
 *   identity = 四 kind 身份（与 identifyProjectFromCwd 输出同构）；
 *   factError 非空 = 在档事实损坏（调用方决定入 parseFailures / 计数上报）。
 */
export function identityOfFirstEvent(first, io) {
  const fact = first?.project;
  // Round-2 M3/F3（sol 复核）：project 字段**在场**即是事实主张——对象形但缺
  // kind/坏形状一律 factError，不得静默回退 cwd 推导（掩盖损坏）；只有字段
  // 缺省（legacy run）才走推导。
  if (fact !== undefined && fact !== null) {
    if (typeof fact !== "object" || Array.isArray(fact) || typeof fact.kind !== "string") {
      return { identity: { kind: "unattributed", reason: "recorded project fact malformed (not a kinded object)" }, factError: "malformed fact shape (missing kind)" };
    }
  }
  if (fact && typeof fact === "object" && typeof fact.kind === "string") {
    if (!PROJECT_FACT_KINDS.includes(fact.kind)) {
      return { identity: { kind: "unattributed", reason: `recorded project fact has unknown kind ${JSON.stringify(fact.kind)}` }, factError: `unknown fact kind ${JSON.stringify(fact.kind)}` };
    }
    if (fact.kind === "project") {
      if (typeof fact.key !== "string" || fact.key.length === 0
        || typeof fact.bucket !== "string" || !FACT_BUCKET_RE.test(fact.bucket)) {
        return { identity: { kind: "unattributed", reason: "recorded project fact malformed (key/bucket shape)" }, factError: "malformed project fact (key/bucket)" };
      }
      if (isReservedBucketSlug(fact.bucket)) {
        return { identity: { kind: "unattributed", reason: `recorded bucket ${fact.bucket} is a reserved name` }, factError: "reserved bucket name in fact" };
      }
      return { identity: { ...fact }, factError: null };
    }
    if (fact.kind === "sandbox") {
      if (fact.key !== "_sandbox" || typeof fact.harness !== "string" || typeof fact.worktreeName !== "string") {
        return { identity: { kind: "unattributed", reason: "recorded sandbox fact malformed" }, factError: "malformed sandbox fact" };
      }
      return { identity: { ...fact }, factError: null };
    }
    if (fact.kind === "scratch") {
      if (fact.key !== "_scratch") {
        return { identity: { kind: "unattributed", reason: "recorded scratch fact malformed" }, factError: "malformed scratch fact" };
      }
      return { identity: { ...fact }, factError: null };
    }
    return { identity: { kind: "unattributed", reason: typeof fact.reason === "string" ? fact.reason : "unattributed (recorded fact)" }, factError: null };
  }
  return { identity: identifyProjectFromCwd(first?.cwd, io ?? productionProjectIo()), factError: null };
}

/**
 * 从稳定项目键派生桶 slug：`<displayName>-<sha256(key)[0:8]>`。
 * 哈希绑定完整规范化路径——项目改名/移动=新键=新桶（别名关联由中央索引
 * 承载，不在此模块）；同名不同路径的项目由哈希区分；同 slug 的哈希碰撞
 * （不同键同 8 hex）由桶创建方校验 full key 并拒绝/扩长（astra 裁定）。
 */
export function deriveProjectBucketSlug(identity) {
  if (identity?.kind !== "project") {
    throw new Error("deriveProjectBucketSlug: identity must be kind=project");
  }
  const hash8 = createHash("sha256").update(identity.key, "utf8").digest("hex").slice(0, 8);
  return `${identity.displayName}-${hash8}`;
}

/**
 * 桶 slug 的保留名防御：slug 整体不得等于 runs/ 保留目录名；displayName
 * 段不得是 Windows 保留设备名（哈希后缀使其天然不等，这里显式拒绝裸名）。
 */
export function isReservedBucketSlug(slug) {
  if (RUNS_RESERVED_DIRNAMES.includes(slug)) return true;
  const head = String(slug).split("-")[0]?.toLowerCase() ?? "";
  return WINDOWS_RESERVED.has(head);
}
