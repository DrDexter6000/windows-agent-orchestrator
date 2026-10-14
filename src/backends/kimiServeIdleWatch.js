// src/backends/kimiServeIdleWatch.js
//
// 决定 0079：WAO 拉起的 kimi worker serve 在空闲时自己退出。kimi web 本身
// 没有空闲超时选项，WAO 也没有常驻进程——做法是一个跟着 serve 走的看护进程（detached
// node，windowsHide），由拉起者（ensureServeRunning / recycleServe）在 serve 就绪后启动。
//
// 边界（与决定 0075 的取向一致）：
//   - **只优雅关停，绝不杀进程**：关停走 POST /api/v1/shutdown；请求失败就放锁退出，
//     不重试、不强杀。
//   - 空闲必须是连续观察到的：token 或会话列表读不到的那一拍不算空闲（计时重新开始）。
//   - 关停前必须抢到同一把启动锁：抢不到 = 别的派发或 recycle 正在动这个端口，这一拍跳过；
//     陈旧的锁只在确认持锁进程已不在时才接管，持锁者活着或认不出来都不碰。
//   - 关停前再核对目标：被看护的 pid 还是活着的 kimi 进程，且这个端口的实例记录属于它；
//     不是就退出（serve_gone / serve_replaced），不关端口上别的 serve。
//   - 抢到锁后复核两面会话列表（默认 + 归档，与 recycle 的 soak 相同）；仍然空闲、集合
//     也没变才关停。证不了空闲就不动手。
//   - 观察面连续读不到（token 3 拍 / 会话列表 5 拍）→ 退出，什么也不做。serve 的 pid 不
//     在了（同一 kimi 进程的核验）→ 退出。
//   - 手动脚本 scripts/kimi-serve.ps1 拉起的 serve 不带看护，一直运行到有人关掉；serve
//     退出后的下一次派发会重新拉起（车道声明了 serveWorkspaceDir 的话）。

import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listServeSessions, readServeInstances, shutdownServe } from "./kimiServeOps.js";
import {
  acquireServeStartLock,
  isKimiProcessAlive,
  isProcessAlive,
  releaseServeStartLock,
  serveStartLockPath,
  stripServeEnvVars,
} from "./kimiServeStart.js";

// 缺省常量：空闲阈值 30 分钟，轮询 60 秒。
export const IDLE_WATCH_IDLE_THRESHOLD_MS = 30 * 60_000;
export const IDLE_WATCH_POLL_MS = 60_000;
// token / 会话列表连续读不到的拍数上界（到界退出，什么也不做）。
const TOKEN_UNREADABLE_TICKS = 3;
const UNOBSERVABLE_TICKS = 5;
// 关停请求发出后，确认端口不再监听（连接被拒）的有界等待。
const PORT_DOWN_CONFIRM_MS = 15_000;
const PORT_DOWN_PROBE_INTERVAL_MS = 1000;

/** 退出原因闭集（测试断言面）。 */
export const IDLE_WATCH_EXIT_REASONS = Object.freeze([
  "serve_gone",       // serve 的 pid 已不在（不是同一个 kimi 进程）
  "serve_replaced",   // 端口上的实例已不是被看护的 pid（不关别人的 serve）
  "idle_shutdown",    // 空闲满阈值，优雅关停已请求
  "shutdown_failed",  // 关停请求失败（不强杀、不重试）
  "token_unreadable", // server.token 连续读不到
  "unobservable",     // 会话列表连续读不到
]);

function sameIds(a, b) {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/**
 * 核心循环（依赖全部可注入）。每一拍：先看 serve 的 pid 还活着吗（核验方式与
 * isKimiProcessAlive 相同——pid 会被复用，镜像名必须还是 kimi）→ 每拍重读
 * <主目录>/server.token（不从环境取）→ 两面会话列表。活动 = 任一会话 busy /
 * main_turn_active 为真，或会话 id 集合与上一拍不同。距最后活动满阈值 → 抢启动锁复核
 * → 仍空闲才优雅关停 → 最多等 15 秒确认端口不再监听 → 放锁退出。返回退出原因（闭集）。
 */
export async function watchServeIdle({
  port,
  pid,
  kimiHome = null,
  idleThresholdMs = IDLE_WATCH_IDLE_THRESHOLD_MS,
  pollMs = IDLE_WATCH_POLL_MS,
  nowMs = Date.now,
  sleepFn = (ms) => new Promise((r) => { setTimeout(r, ms); }),
  fetchImpl = globalThis.fetch,
  readFileFn = readFileSync,
  homedirFn = homedir,
  listSessionsFn = listServeSessions,
  shutdownFn = shutdownServe,
  acquireLockFn = acquireServeStartLock,
  releaseLockFn = releaseServeStartLock,
  lockDir = tmpdir(),
  childAliveFn = isKimiProcessAlive,
  holderAliveFn = isProcessAlive,
  readInstancesFn = readServeInstances,
  requestTimeoutMs = 8000,
}) {
  // 主目录缺省 = 默认主目录 ~/.kimi-code（与 readServeInstances 的规则相同）。
  const home = typeof kimiHome === "string" && kimiHome.length > 0 ? kimiHome : join(homedirFn(), ".kimi-code");
  const baseUrl = `http://127.0.0.1:${port}`;
  const lockPath = serveStartLockPath(port, lockDir);
  const readToken = () => {
    try {
      const value = String(readFileFn(join(home, "server.token"), "utf8")).trim();
      return value.length > 0 ? value : null;
    } catch { return null; }
  };
  // 两面会话列表（默认 + 归档），按 id 合并、busy 取或——与 recycle 的 soak 同一语义。
  // 任一面读不到 → null（证不了就当不可观测）。
  const readFaces = async (token) => {
    const normal = await listSessionsFn({ baseUrl, token, fetchImpl, timeoutMs: requestTimeoutMs });
    if (!normal.ok) return null;
    const archived = await listSessionsFn({ baseUrl, token, fetchImpl, timeoutMs: requestTimeoutMs, archivedOnly: true });
    if (!archived.ok) return null;
    const byId = new Map();
    for (const it of [...normal.items, ...archived.items]) {
      const prev = byId.get(it.id);
      byId.set(it.id, prev
        ? { ...prev, busy: prev.busy || it.busy, mainTurnActive: prev.mainTurnActive || it.mainTurnActive }
        : it);
    }
    return { items: [...byId.values()], ids: new Set(byId.keys()) };
  };
  let tokenMisses = 0;
  let listMisses = 0;
  let lastActiveAt = nowMs();
  let prevIds = null;
  for (;;) {
    if (!childAliveFn(pid)) return "serve_gone";
    const token = readToken();
    if (token === null) {
      tokenMisses += 1;
      if (tokenMisses >= TOKEN_UNREADABLE_TICKS) return "token_unreadable";
      lastActiveAt = nowMs(); // 看不见的一拍不算空闲
      await sleepFn(pollMs);
      continue;
    }
    tokenMisses = 0;
    const faces = await readFaces(token);
    if (faces === null) {
      listMisses += 1;
      if (listMisses >= UNOBSERVABLE_TICKS) return "unobservable";
      lastActiveAt = nowMs(); // 看不见的一拍不算空闲
      await sleepFn(pollMs);
      continue;
    }
    listMisses = 0;
    const now = nowMs();
    const busy = faces.items.some((s) => s.busy || s.mainTurnActive);
    const idsChanged = prevIds !== null && !sameIds(faces.ids, prevIds);
    if (busy || idsChanged) lastActiveAt = now;
    prevIds = faces.ids;
    if (now - lastActiveAt < idleThresholdMs) {
      await sleepFn(pollMs);
      continue;
    }
    // 空闲满阈值：抢启动锁复核。抢不到 = 别的派发或 recycle 正在动这个端口——这一拍跳过；
    // 陈旧锁只在持锁进程已不在时接管（holderAliveFn）。
    const lock = acquireLockFn({ lockPath, now, childAliveFn, holderAliveFn });
    if (!lock.held) {
      await sleepFn(pollMs);
      continue;
    }
    try {
      const recheck = await readFaces(token);
      if (recheck === null) {
        listMisses += 1;
        if (listMisses >= UNOBSERVABLE_TICKS) return "unobservable";
        lastActiveAt = nowMs(); // 看不见的一拍不算空闲
        await sleepFn(pollMs);
        continue;
      }
      listMisses = 0;
      const recheckActive = recheck.items.some((s) => s.busy || s.mainTurnActive)
        || !sameIds(recheck.ids, prevIds);
      if (recheckActive) {
        // 复核发现有活动：放锁、记为有活动、继续。
        lastActiveAt = nowMs();
        prevIds = recheck.ids;
        await sleepFn(pollMs);
        continue;
      }
      // 关停按端口发出：先核对端口上的 serve 仍是被看护的那一个（pid 还活着、实例记录属于它）。
      if (!childAliveFn(pid)) return "serve_gone";
      if (!readInstancesFn({ kimiHome }).some((x) => x.port === port && x.pid === pid)) return "serve_replaced";
      const r = await shutdownFn({ baseUrl, token, fetchImpl, timeoutMs: requestTimeoutMs });
      if (r?.outcome !== "requested") return "shutdown_failed";
      // 最多等 15 秒确认端口不再监听（连接被拒）；确认与否都到此为止——关停已请求，
      // 看护的职责结束（不杀、不重试）。
      for (let waited = 0; waited < PORT_DOWN_CONFIRM_MS; waited += PORT_DOWN_PROBE_INTERVAL_MS) {
        await sleepFn(PORT_DOWN_PROBE_INTERVAL_MS);
        const probe = await listSessionsFn({ baseUrl, token, fetchImpl, timeoutMs: 3000, pageSize: 1 });
        if (!probe.ok && probe.reason === "connection_refused") break;
      }
      return "idle_shutdown";
    } finally {
      releaseLockFn(lock);
    }
  }
}

/**
 * 拉起看护进程：用 process.execPath 跑本模块（detached + windowsHide + ignore stdio，
 * 然后 unref——实测只给 windowsHide、不给 detached 的子进程会随父进程退出而消失，见
 * 决定 0075 的启动方式表）。环境按 serve 的同一套剔除规则（stripServeEnvVars——不带
 * 密钥、WAO_*、CLAUDE*、ANTHROPIC*），主目录经命令行参数传给看护，不经环境。
 * 启动失败不抛错（看护起不来不能让派发失败），返回 { started, pid } 或 { started: false, reason }。
 */
export function startServeIdleWatch({ port, pid, kimiHome = null, env = process.env, spawnFn = nodeSpawn }) {
  if (!Number.isInteger(port) || port <= 0 || !Number.isInteger(pid) || pid <= 0) {
    return { started: false, reason: "bad_args" };
  }
  const args = [
    fileURLToPath(import.meta.url),
    "--port", String(port),
    "--pid", String(pid),
    ...(typeof kimiHome === "string" && kimiHome.length > 0 ? ["--kimi-home", kimiHome] : []),
  ];
  let child;
  try {
    child = spawnFn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: stripServeEnvVars(env),
      // 中立工作目录：不继承拉起者的 cwd——Windows 不允许删除某进程正用作
      // 工作目录的目录，看护若占住派发工作树，该树要等看护退出（至少空闲
      // 阈值那半小时）才能删。tmpdir 恒在、恒可写，且与任何工作树无关。
      cwd: tmpdir(),
    });
  } catch {
    return { started: false, reason: "spawn_failed" };
  }
  // 异步 'error'（如可执行文件消失）不得打崩派发进程：静默吞掉，看护没起来如实反映在返回值。
  if (typeof child?.once === "function") child.once("error", () => {});
  child?.unref?.();
  const watcherPid = Number.isInteger(child?.pid) ? child.pid : null;
  if (watcherPid === null) return { started: false, reason: "spawn_failed" };
  return { started: true, pid: watcherPid };
}

// 入口：node src/backends/kimiServeIdleWatch.js --port N --pid P [--kimi-home DIR]。
// 用真实依赖跑核心循环；结束时退出码 0（看护退出不是错误——原因在返回值里，调用方
// 已经拿过 startServeIdleWatch 的结果）。参数形状不对（唯一调用方不会发生）→ 什么都不
// 做直接退出 0。异常也退出 0：看护是 best-effort，serve 不因看护崩溃而受影响。
const invokedDirectly = (() => {
  try {
    return typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch { return false; }
})();
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const port = Number.parseInt(String(flag("--port") ?? ""), 10);
  const pid = Number.parseInt(String(flag("--pid") ?? ""), 10);
  const kimiHome = flag("--kimi-home");
  try {
    if (Number.isInteger(port) && port > 0 && Number.isInteger(pid) && pid > 0) {
      await watchServeIdle({
        port, pid,
        ...(typeof kimiHome === "string" && kimiHome.length > 0 ? { kimiHome } : {}),
      });
    }
  } catch { /* 看护 best-effort：异常不改变退出码 */ }
  process.exit(0);
}
