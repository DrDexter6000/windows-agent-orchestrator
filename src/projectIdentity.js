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
// 不锚 homedir——CODEX_HOME 可重定向）；两段形状 <worktree>/<repo>（repo 可
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
  // R6 显式相对当前目录 "."（历史转录实测 12 条）——无路径身份，不猜 cwd
  if (p === "." || p === "./" || p.length === 0) {
    return { kind: "unattributed", reason: "cwd is a bare relative '.' — no path identity" };
  }
  // R4 隔离工作树回溯到所属仓根（worktree 段本身可含子路径）。裸相对形态
  //（无前导分隔符，实测存量出现过 `.wao-worktrees/run_x`）剥离后没有可归因
  // 的仓根——如实 unattributed（相对 worktree 路径推不出所属项目，不猜 cwd）。
  if (/^\.wao-worktrees[\\/][^\\/]+(?:[\\/].*)?$/i.test(p)) {
    return { kind: "unattributed", reason: "cwd is a bare relative .wao-worktrees path — owning repo root not derivable" };
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
  // R2 win32 大小写折叠（键）；displayName 取原 basename
  const key = platform === "win32" ? resolved.toLowerCase() : resolved;
  const displayNameRaw = basename(p.replace(/\/+$/, "")) || "project";
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
