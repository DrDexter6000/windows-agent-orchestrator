// src/application/oauthDirSweep.js
//
// TD-223（2026-10-07）：claude-code native OAuth 临时配置目录的存量清扫（纯函数模块）。
// 背景：backends/claudeCode.js 的 prepareClaudeOauthConfigDir 每次 spawn 在
// os.tmpdir() 建 wao-claude-oauth-* 目录（含 ~/.claude/.credentials.json 副本），
// 修复前 run 终态无任何删除——%TEMP% 实测堆积 1308 个（docs/tech-debt.md TD-223）。
// 修复后 backend.dispose() 在 run 终态删除本进程创建的目录；本模块负责**进程外
// 视角**的存量清扫：带 .wao-owner.json 标记的目录按 pid 存活判定（创建者进程还
// 活着就不删——那是活 run 的目录）；无标记/标记不可解析（修复前的遗留目录）按
// mtime > 24h 保守判定。
//
// 决定 0114：复用/续修使用 wao-claude-session-* 稳定会话目录（目录名 = opaque
// uuid 的 sha256 摘要）。这类目录跨 run 存活，不能按 owner pid 死亡删除——CLI 的
// 会话记录在里面，删了下一轮就接不回。规则改为按**最近使用时间**：标记里的
// usedAt（每次 spawn 刷新；缺席时回落到标记/目录 mtime）距今超过
// SESSION_DIR_MAX_IDLE_MS（14 天）才删；owner pid 还活着（正在跑的那一轮在用）
// 一律不删。
//
// 消费者：wao sweep-claude-config（CLI）、wao doctor（advisory 报数，dry-run）。
//
// 纪律：本模块永不读取 .credentials.json 或标记文件以外的任何文件内容（凭据面
// 只数不看）；逐目录失败继续扫描，永不抛出（doctor/CI 不得因清扫崩）。

import { readdirSync, statSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 目录名前缀与 owner 标记文件名——与 backends/claudeCode.js 的创建侧同一约定
// （值同步由 test/backends/claudeOauthDispose.test.js 与
// test/backends/claudeSessionConfigDir.test.js 钉住）。
export const OAUTH_DIR_PREFIX = "wao-claude-oauth-";
export const SESSION_DIR_PREFIX = "wao-claude-session-";
export const OWNER_MARKER_FILE = ".wao-owner.json";

// 无标记/标记不可解析的普通遗留目录：mtime 距今超过该时长才可删。保守窗口防误删
// "刚创建但标记写入前被杀"的目录（标记先于凭据拷贝写入，窗口极小但非零）。
export const SWEEP_LEGACY_AGE_MS = 24 * 60 * 60 * 1000;

// 决定 0114：会话目录的最近使用窗口——超过 14 天没有任何一轮使用才删。常量而非
// 配置项（Owner 只批这一个口径）。
export const SESSION_DIR_MAX_IDLE_MS = 14 * 24 * 60 * 60 * 1000;

// 默认 pid 存活探测：signal 0 只探测不发送。验收修（2026-10-07 sol 会审 Q1）：
// 判死唯一依据 = ESRCH（进程确证不存在）；EPERM（存在但无权限）与任何未知探测
// 错误一律按存活保守处理——宁可漏删不误删，漏删的下轮清扫还有机会。若反过来
// 只认 EPERM 判活，未知探测错误会被当死、误删活 run 的目录。
export function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code !== "ESRCH";
  }
}

// 读 owner 标记。pid 非正整数（缺字段/类型错/负数/0——pid 0 会探测整个进程组，
// 绝不当作合法 owner）一律视为不可解析 → 调用方走对应前缀的兜底规则。
function readOwnerMarker(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, OWNER_MARKER_FILE), "utf8"));
    if (parsed && typeof parsed === "object" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

// 会话目录的"最近使用"时间：标记里的 usedAt（每次 spawn 刷新）优先；标记缺席/
// usedAt 不可解析时回落到标记文件 mtime，再回落到目录 mtime。runtime 会在目录里
// 写会话状态，但根目录 mtime 不一定随每轮刷新，所以标记文件是主证据。
function sessionLastUsedMs(dir, dirStat, marker) {
  if (marker && typeof marker.usedAt === "string") {
    const usedAt = Date.parse(marker.usedAt);
    if (Number.isFinite(usedAt)) return usedAt;
  }
  try {
    return statSync(join(dir, OWNER_MARKER_FILE)).mtimeMs;
  } catch {
    return dirStat.mtimeMs;
  }
}

// 删除前的复读：清扫读旧标记并判定可删后，续修轮可能已刷新同一目录的标记
// （pid/usedAt 变了）。只读一次会在跨进程交错里误删活目录——复读发现变化即跳过。
function sessionMarkerRefreshed(previous, current) {
  if (previous === null && current === null) return false;
  if (previous === null || current === null) return true;
  return previous.pid !== current.pid || previous.usedAt !== current.usedAt;
}

/**
 * 扫描（并可删）baseDir 下的 wao-claude-oauth-* 与 wao-claude-session-* 目录。
 *
 * 规则（闭集 reason）：
 *   - 非目录条目 → skip "not-a-dir"
 *   - 普通 OAuth 目录（wao-claude-oauth-*）：
 *     · 标记可解析且 isPidAlive(pid) → skip "owner-alive"；否则可删
 *     · 无标记/标记不可解析 → mtime 距 now ≤ SWEEP_LEGACY_AGE_MS → skip
 *       "legacy-young"；超龄则可删
 *   - 会话目录（wao-claude-session-*）：
 *     · 标记可解析且 isPidAlive(pid) → skip "owner-alive"（正在跑的那一轮在用）
 *     · 最近使用（usedAt，缺席回落标记/目录 mtime）距 now ≤
 *       SESSION_DIR_MAX_IDLE_MS → skip "session-recent"；否则可删
 *     · apply 删除前复读标记；pid/usedAt 已变（续修轮刚刷新）→ skip
 *       "session-refreshed"，不删
 *   - apply=false：可删目录 → skip "dry-run"（计数即"将删数"，一律不真删）
 *   - apply=true：rmSync 删除；单目录删除失败 → skip "error"，继续其余
 *
 * @param {object} [input]
 * @param {string} [input.baseDir=tmpdir()] — 扫描根（测试注入自建临时根）
 * @param {number} [input.now=Date.now()] — 判定年龄用的当前时间（测试注入）
 * @param {(pid: number) => boolean} [input.isPidAlive] — 存活探测注入（测试注入假判定）
 * @param {boolean} [input.apply=false] — true 才真删；默认 dry-run 只报告
 * @returns {{scanned: number, deleted: number, skipped: Array<{dir: string, reason: string}>, byReason: Record<string, number>}}
 *   scanned = 前缀匹配条目总数；deleted = 实际删除数（dry-run 恒 0）；
 *   skipped/byReason = 跳过明细与按 reason 计数（dry-run 的"将删数"在 byReason["dry-run"]）。
 */
export function sweepClaudeOauthDirs({
  baseDir = tmpdir(),
  now = Date.now(),
  isPidAlive = defaultIsPidAlive,
  apply = false,
} = {}) {
  const skipped = [];
  const byReason = Object.create(null);
  let deleted = 0;
  let scanned = 0;
  const skip = (dir, reason) => {
    skipped.push({ dir, reason });
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  };

  let entries;
  try {
    entries = readdirSync(baseDir);
  } catch {
    // baseDir 缺席/不可读（干净机器等）：空报告，不抛。
    return { scanned: 0, deleted: 0, skipped, byReason };
  }

  for (const name of entries) {
    const isSession = name.startsWith(SESSION_DIR_PREFIX);
    const isOauth = name.startsWith(OAUTH_DIR_PREFIX);
    if (!isSession && !isOauth) continue;
    scanned += 1;
    const full = join(baseDir, name);

    let stat;
    try {
      stat = statSync(full);
    } catch {
      skip(full, "error");
      continue;
    }
    if (!stat.isDirectory()) {
      skip(full, "not-a-dir");
      continue;
    }

    const marker = readOwnerMarker(full);
    if (isSession) {
      if (marker) {
        let alive;
        try {
          alive = isPidAlive(marker.pid) === true;
        } catch {
          alive = true; // 探测器异常按存活保守（宁可漏删不误删）
        }
        if (alive) {
          skip(full, "owner-alive");
          continue;
        }
      }
      if (now - sessionLastUsedMs(full, stat, marker) <= SESSION_DIR_MAX_IDLE_MS) {
        skip(full, "session-recent");
        continue;
      }
    } else if (marker) {
      let alive;
      try {
        alive = isPidAlive(marker.pid) === true;
      } catch {
        alive = true; // 探测器异常按存活保守（宁可漏删不误删）
      }
      if (alive) {
        skip(full, "owner-alive");
        continue;
      }
    } else if (now - stat.mtimeMs <= SWEEP_LEGACY_AGE_MS) {
      skip(full, "legacy-young");
      continue;
    }

    if (!apply) {
      skip(full, "dry-run");
      continue;
    }
    // 决定 0114：会话目录删除前复读标记——判定可删到真正删除之间，续修轮可能
    // 已刷新 pid/usedAt。标记变了就说明目录刚被活的一轮接手，跳过。
    if (isSession) {
      const currentMarker = readOwnerMarker(full);
      if (sessionMarkerRefreshed(marker, currentMarker)) {
        skip(full, "session-refreshed");
        continue;
      }
    }
    try {
      rmSync(full, { recursive: true, force: true });
      deleted += 1;
    } catch {
      skip(full, "error");
    }
  }
  return { scanned, deleted, skipped, byReason };
}
