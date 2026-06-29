// src/daemonSupervisor.js
//
// P5 / TD-45：daemon 自愈——独立 supervisor 进程。
//
// 背景：daemon 不能自拉自（引导悖论）。supervisor 是正交守护者（detached 进程，由 CLI 一次性
// spawn），轮询 daemon 心跳（复用 daemon.json 的 isDaemonAlive），判死 → 重启 daemon + 退避防风暴。
// resume-on-start（scanResumableRuns）已在 daemon 侧就绪，所以"自愈"=判死+重启 daemon，新 daemon
// 重启时自动接管未完成 run。
//
// 边界（明示不做）：supervisor 自身被杀（如机器重启）无法自拉——那种"重生引导"需 Windows 服务/
// 计划任务，留 v2。supervisor 由 CLI spawn 一次即自包含。
//
// 纯函数 decideSupervisorAction 可单测；进程主体（轮询/spawn 重启/IPC）归真实 smoke。

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDaemonAlive, readHandshake, scanAllRuns, connectDaemon, DEFAULT_LIVENESS_THRESHOLD_MS } from "./daemon.js";

/**
 * 决策纯函数：supervisor 这一轮该做什么。
 * 优先级：风暴退避（最高，防无限重启）→ 判死重启 → 空闲自退 → noop。
 *
 * @param {object} p
 * @param {object|null} p.handshake - readHandshake(runDir) 的返回（{pid,heartbeatAt,...}|null）
 * @param {Array<{runId,owner,state}>} p.ownedRuns - scanAllRuns 的返回（含 owner 分类）
 * @param {number} p.consecutiveRestarts - 连续重启计数（成功保活后归零）
 * @param {object} p.config
 * @param {number} [p.config.now] - 当前时间戳
 * @param {number} [p.config.livenessThresholdMs] - 判活阈值（与 daemon 一致，默认 10000）
 * @param {number} [p.config.maxConsecutiveRestarts] - 连续重启上限，超此转 backoff
 * @param {number} [p.config.idleExitMs] - 无 daemon-owned run 且超此空闲 → idle-exit
 * @param {number} [p.config.lastActivityAt] - 上次有 daemon-owned run 的时间戳
 * @returns {{action:"noop"|"restart"|"backoff"|"idle-exit", reason?:string}}
 */
export function decideSupervisorAction({ handshake, ownedRuns, consecutiveRestarts, config }) {
  const {
    now = Date.now(),
    livenessThresholdMs = 10000,
    maxConsecutiveRestarts = 3,
    idleExitMs = 60000,
    lastActivityAt = now,
  } = config;

  const alive = isDaemonAlive(handshake, now, livenessThresholdMs);

  // 1) 风暴退避：daemon 仍死（心跳超时），且连续重启已达上限 → 不再无限拉起，退避+告警。
  //    防止 daemon 起不来时 supervisor 疯狂重启烧 CPU/日志。
  if (!alive && consecutiveRestarts >= maxConsecutiveRestarts) {
    return {
      action: "backoff",
      reason: `daemon 连续重启 ${consecutiveRestarts} 次仍判死（心跳超 ${livenessThresholdMs}ms），转退避防风暴；需人工介入（见告警）`,
    };
  }

  // 2) 判死 → restart（首次/未达上限）。daemon handshake null（从未起/被清）也算需起。
  if (!alive) {
    return {
      action: "restart",
      reason: handshake
        ? `daemon pid=${handshake.pid} 判死（心跳 ${now - handshake.heartbeatAt}ms 前超阈值）`
        : "daemon handshake 不存在（未起/已清），supervisor 启动 daemon",
    };
  }

  // 3) daemon 活着。判断空闲自退：无 daemon-owned run（external/orphan 不算）+ 空闲超阈值 → 自退。
  const hasDaemonOwned = (ownedRuns ?? []).some(
    (r) => r.owner === "daemon" && r.state !== "completed" && r.state !== "failed" && r.state !== "timed_out",
  );
  if (!hasDaemonOwned && now - lastActivityAt >= idleExitMs) {
    return {
      action: "idle-exit",
      reason: `无 daemon-owned run 且空闲 ${now - lastActivityAt}ms（超 ${idleExitMs}ms），supervisor 停 daemon + 自退`,
    };
  }

  // 4) 活着且忙，或刚 idle 未超阈值 → 什么都不做，下一轮再判。
  return { action: "noop" };
}

// ============================================================
// 进程主体：detached supervisor（轮询 daemon 心跳，判死重启，空闲自退）
// ============================================================

// supervisor 自身的状态文件（lead 用 `supervisor status` 读）。放 runDir（同 daemon.json 性质）。
const SUPERVISOR_FILE = "daemon-supervisor.json";

function writeSupervisorState(runDir, state) {
  try {
    writeFileSync(join(runDir, SUPERVISOR_FILE), JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2), "utf8");
  } catch { /* runDir 被删等不杀 supervisor */ }
}

function readSupervisorState(runDir) {
  try { return JSON.parse(readFileSync(join(runDir, SUPERVISOR_FILE), "utf8")); } catch { return null; }
}

/**
 * supervisor 进程入口（detached）。轮询 daemon，按 decideSupervisorAction 行事。
 * @param {object} opts
 * @param {string} opts.runDir
 * @param {string} [opts.registry]
 * @param {string} [opts.pipe]
 * @param {number} [opts.pollIntervalMs] - 轮询间隔（默认 livenessThreshold 的 1.5x，避免抖动）
 * @param {number} [opts.livenessThresholdMs]
 * @param {number} [opts.maxConsecutiveRestarts]
 * @param {number} [opts.idleExitMs]
 * @param {boolean} [opts.startDaemonIfMissing] - 启动时若 daemon 不在，是否立即拉起（默认 true）
 */
export async function runSupervisor(opts = {}) {
  const { runDir } = opts;
  if (!runDir) throw new Error("runSupervisor: runDir required");
  const livenessThresholdMs = opts.livenessThresholdMs ?? DEFAULT_LIVENESS_THRESHOLD_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? Math.round(livenessThresholdMs * 1.5);
  const maxConsecutiveRestarts = opts.maxConsecutiveRestarts ?? 3;
  const idleExitMs = opts.idleExitMs ?? 60000;
  const daemonPath = join(dirname(fileURLToPath(import.meta.url)), "daemon.js");

  let consecutiveRestarts = 0;
  let lastActivityAt = Date.now();
  let exiting = false;
  writeSupervisorState(runDir, { pid: process.pid, status: "supervising", consecutiveRestarts });

  function spawnDaemon() {
    const args = [
      daemonPath, "--run-dir", runDir,
      "--pipe", opts.pipe ?? `\\\\.\\pipe\\wao-daemon`,
      ...(opts.registry ? ["--registry", opts.registry] : []),
      "--resume-on-start", "true", // 重启的 daemon 接管未完成 run（TD-45 自愈核心）
    ];
    spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  }

  async function pollOnce() {
    if (exiting) return;
    const handshake = readHandshake(runDir);
    const alive = isDaemonAlive(handshake, Date.now(), livenessThresholdMs);
    const ownedRuns = existsSync(runDir) ? scanAllRuns(runDir, Date.now(), livenessThresholdMs) : [];
    const hasDaemonOwned = ownedRuns.some((r) => r.owner === "daemon" && !["completed", "failed", "timed_out"].includes(r.state));
    if (hasDaemonOwned) lastActivityAt = Date.now();

    const decision = decideSupervisorAction({
      handshake, ownedRuns, consecutiveRestarts,
      config: { now: Date.now(), livenessThresholdMs, maxConsecutiveRestarts, idleExitMs, lastActivityAt },
    });

    switch (decision.action) {
      case "restart":
        consecutiveRestarts += 1;
        writeSupervisorState(runDir, { pid: process.pid, status: "restarting", consecutiveRestarts, lastReason: decision.reason });
        console.error(`[supervisor] ${decision.reason}（第 ${consecutiveRestarts} 次）→ 重启 daemon`);
        spawnDaemon();
        break;
      case "backoff":
        // 风暴：写告警状态后退出（不再无限轮询）。lead 看到状态介入。
        writeSupervisorState(runDir, { pid: process.pid, status: "backoff", consecutiveRestarts, lastReason: decision.reason });
        console.error(`[supervisor] ${decision.reason} → 退出，需人工介入`);
        exiting = true;
        break;
      case "idle-exit":
        // 任务结束自关：让 daemon 优雅停（IPC shutdown），再自退。
        console.error(`[supervisor] ${decision.reason}`);
        try {
          if (alive) await connectDaemon(opts.pipe ?? `\\\\.\\pipe\\wao-daemon`, { cmd: "shutdown" });
        } catch { /* daemon 已停或连不上，尽力 */ }
        writeSupervisorState(runDir, { pid: process.pid, status: "idle-exit", lastReason: decision.reason });
        exiting = true;
        break;
      case "noop":
      default:
        // daemon 活着时，连续重启计数归零（说明上次重启成功了）。
        if (alive && consecutiveRestarts > 0) consecutiveRestarts = 0;
        writeSupervisorState(runDir, { pid: process.pid, status: "supervising", consecutiveRestarts, daemonAlive: alive });
        break;
    }
  }

  // 启动时若 daemon 不在且配置要求，立即拉起（不等第一轮判死）。
  if (opts.startDaemonIfMissing !== false) {
    const hs = readHandshake(runDir);
    if (!isDaemonAlive(hs, Date.now(), livenessThresholdMs)) {
      console.error("[supervisor] 启动时 daemon 不在，立即拉起");
      consecutiveRestarts += 1;
      spawnDaemon();
    }
  }

  const timer = setInterval(pollOnce, pollIntervalMs);
  timer.unref?.();

  // 优雅退出：SIGINT/SIGTERM → 清 supervisor 状态文件后退（不杀 daemon——daemon 独立存活）。
  const shutdown = (sig) => {
    if (exiting) return;
    exiting = true;
    clearInterval(timer);
    try { unlinkSync(join(runDir, SUPERVISOR_FILE)); } catch { /* 已不在 */ }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// 直接作为入口运行时（detached 子进程）。
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const opts = parseSupervisorFlags(process.argv.slice(2));
  runSupervisor(opts).catch((e) => {
    process.stderr.write(`supervisor error: ${e.message}\n`);
    process.exit(1);
  });
}

// 简单 flag 解析（照 daemon.parseDaemonFlags 同款）+ kebab→camel 转换（--run-dir → runDir）。
export function parseSupervisorFlags(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const rawKey = a.slice(2);
      const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); // run-dir → runDir
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { opts[key] = next; i += 1; }
      else { opts[key] = true; }
    }
  }
  return opts;
}

export { SUPERVISOR_FILE, readSupervisorState };
