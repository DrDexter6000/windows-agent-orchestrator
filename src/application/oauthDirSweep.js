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
// 消费者：wao sweep-claude-config（CLI）、wao doctor（advisory 报数，dry-run）。
//
// 纪律：本模块永不读取 .credentials.json 或标记文件以外的任何文件内容（凭据面
// 只数不看）；逐目录失败继续扫描，永不抛出（doctor/CI 不得因清扫崩）。

import { readdirSync, statSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 目录名前缀与 owner 标记文件名——与 backends/claudeCode.js 的创建侧同一约定
// （值同步由 test/backends/claudeOauthDispose.test.js 钉住）。
export const OAUTH_DIR_PREFIX = "wao-claude-oauth-";
export const OWNER_MARKER_FILE = ".wao-owner.json";

// 无标记/标记不可解析的遗留目录：mtime 距今超过该时长才可删。保守窗口防误删
// "刚创建但标记写入前被杀"的目录（标记先于凭据拷贝写入，窗口极小但非零）。
export const SWEEP_LEGACY_AGE_MS = 24 * 60 * 60 * 1000;

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
// 绝不当作合法 owner）一律视为不可解析 → 调用方走遗留规则。
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

/**
 * 扫描（并可删）baseDir 下的 wao-claude-oauth-* 目录。
 *
 * 规则（闭集 reason）：
 *   - 非目录条目 → skip "not-a-dir"
 *   - 标记可解析且 isPidAlive(pid) → skip "owner-alive"；否则可删
 *   - 无标记/标记不可解析 → mtime 距 now ≤ SWEEP_LEGACY_AGE_MS → skip "legacy-young"；
 *     超龄则可删
 *   - apply=false：可删目录 → skip "dry-run"（计数即"将删数"，一律不真删）
 *   - apply=true：rmSync 删除；单目录删除失败 → skip "error"，继续其余
 *
 * @param {object} [input]
 * @param {string} [input.baseDir=tmpdir()] — 扫描根（测试注入自建临时根）
 * @param {number} [input.now=Date.now()] — 判定遗留年龄用的当前时间（测试注入）
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
    if (!name.startsWith(OAUTH_DIR_PREFIX)) continue;
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
    } else if (now - stat.mtimeMs <= SWEEP_LEGACY_AGE_MS) {
      skip(full, "legacy-young");
      continue;
    }

    if (!apply) {
      skip(full, "dry-run");
      continue;
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
