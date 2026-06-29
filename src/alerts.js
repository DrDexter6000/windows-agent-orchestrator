/**
 * 实时告警（S1-3，事故修复 2026-06-18）。
 *
 * 背景：06-18 事故从 23:38 失控到次日 07:00 被发现，跨度 7.4h，系统侧零感知。
 * 一个花真金白银的系统，无人在场时的失控检测是必需品。本模块把失控事件变成
 * 分钟级弹窗 + 持久日志。
 *
 * 铁律：告警本身绝不能阻塞 run 终态。notify 失败、日志写入失败，都降级处理，
 * 只写 stderr，不抛错。run 终态的正确性优先于告警的可达性。
 *
 * 零依赖：用 Windows 原生 msg.exe 弹窗（不装 notifier 库），符合 AGENTS.md 约束。
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 触发一条告警。
 *
 * @param {"budget"|"stop_unverified"|"leaked_session"} level 告警级别
 * @param {string} message 人读消息
 * @param {{runId?: string, logPath?: string, notify?: () => Promise<void>}} opts
 *   - logPath: ALERTS.log 路径（默认 runs/ALERTS.log）
 *   - notify: 弹窗动作（默认 msg.exe，可注入用于测试）
 */
export async function raiseAlert(level, message, opts = {}) {
  const runId = opts.runId ?? "unknown";
  const logPath = opts.logPath ?? "runs/ALERTS.log";
  const notify = opts.notify ?? defaultNotify;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] runId=${runId} ${message}\n`;

  // 1. 写日志（失败降级 stderr，不抛）
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, line, "utf8");
  } catch (error) {
    console.error(`[alerts] failed to write ${logPath}: ${error.message}`);
    console.error(line.trim());
  }

  // 2. 弹窗（失败降级 stderr，不抛）
  try {
    await notify(level, message, { runId, ts });
  } catch (error) {
    console.error(`[alerts] notify failed: ${error.message}`);
    console.error(line.trim());
  }
}

/**
 * 默认弹窗动作（生产）：Windows msg.exe 弹窗 + TIME:0（直到用户关闭）。
 * 非 Windows 或 msg.exe 不可用时降级为 stderr（不抛）。
 */
async function defaultNotify(level, message, { runId, ts }) {
  if (process.platform !== "win32") {
    console.error(`[alerts:${level}] ${runId}: ${message} @ ${ts}`);
    return;
  }
  const { spawn } = await import("node:child_process");
  const text = `[WAO ${level}] run=${runId}\n${message}`;
  return new Promise((resolve) => {
    // msg * /TIME:0 <text> — 弹窗给当前会话所有用户，TIME:0 不自动消失
    const child = spawn("msg", ["*", "/TIME:0", text], {
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("close", () => resolve());
    child.on("error", () => {
      // msg.exe 不存在（如 Home 版）→ 降级 stderr
      console.error(`[alerts:${level}] ${runId}: ${message} @ ${ts} (msg.exe unavailable)`);
      resolve();
    });
  });
}
