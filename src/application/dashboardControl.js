// src/application/dashboardControl.js
//
// 第 145b 批（决定 0131 第 2 条；修正一改定）：`wao dashboard` 的拉起/复用/停机状态机。
//
// 流程（先读决策 0131 第 2 条与本批任务书）：
//   1. 复用检查（不取锁）：instance.json 三态读取（不存在/读不出/在），在的话先取
//      pid+创建时间判活性，再查协议/形状/runDir/端口归属/health+nonce——全对才复用。
//      死记录（pid 不在或创建时间对不上）按失效处理、可以拉起覆盖；活而协议不同
//      拒发码提示 restart；活而形状不对或读不出按"实例无响应"；读不出不拉起。
//   2. 拉起：原子建锁（临时文件 + linkSync）；他人持锁有界等待（反复复用检查，等到了
//      就复用，绝不等待结束直接拉起）；等待中发现锁换了代就回到竞争起点，**不拿旧
//      代际去接管**；锁过期由"内容核对的移除原语"（removeFileWhen）的唯一赢家接管；
//      拿到锁后第二次复用检查。
//   3. WMI 创建层起 `dashboard serve`（命令行由 buildServeCommandLine 纯函数拼装，
//      路径值加引号、含 `"` 拒绝拉起）；一个截止时间贯穿等候选、核对与发布；**发布前
//      复核**（仍在截止内 + 锁仍是自己这一代），不满足就不发布、回到等待与复用检查。
//   4. stop：先核对状态目录（不过不写停机请求）；只有旧 pid 确实不在或创建时间对不上
//      才算"没有实例/已退出"；记录消失、pid 还活着就继续等到超时。restart 在 stop
//      失败时中止。
//   5. status：与复用检查同一口径，逐项报告哪一项没对上（不打印启动码与令牌）。
//
// 已知局限（一句话一条）：
//   - 145b 之前的前台实例没有 instance.json，这里发现不了也停不了它，要手动关闭。
//   - 拉起中、尚未发布时运行 stop，会报"没有实例"（实例还没记录可停）。
//   - 同一账户、管理员、SYSTEM 不防（威胁模型）。
//
// 架构契约：不 import src/commands/*、src/mcp/*、MCP SDK 或 zod；不 console、不
// process.exit。所有外部事实经 io 注入（缺省件在本文件底部组装）。

import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  DASHBOARD_PROTOCOL_VERSION,
  DASHBOARD_LAUNCH_DEADLINE_MS,
  DASHBOARD_STOP_WAIT_MS,
  DASHBOARD_LOCK_POLL_MS,
  DASHBOARD_CHILD_POLL_MS,
  DASHBOARD_HEALTH_TIMEOUT_MS,
  stateDirFor,
} from "./dashboardPaths.js";
import {
  readInstanceRecordEx,
  publishInstanceRecord,
  readCandidateRecord,
  readResultRecord,
  removeResultRecord,
  createLaunchLock,
  readLaunchLock,
  takeOverStaleLock,
  writeStopRequest,
  codesDirOf,
  stateDirPresent,
} from "./dashboardFiles.js";
import { ensureDashboardStateDir, verifyDashboardStateDir } from "./dashboardAcl.js";
import { probeProcessIdentity, listenerPidsOfPort } from "./dashboardWinFacts.js";
import { issueStartCode } from "./dashboardCodes.js";
import { buildSnapshotFromFacts, compareDashboardBuild } from "./dashboardBuild.js";
import { readServerBuildFacts } from "./serverBuildFacts.js";
import { defaultWmiSpawnBroker } from "./runnerLaunch.js";

/** 控制面失败闭集（错误对象的 code；固定文案见 dashboardControlErrorText）。 */
export const DASHBOARD_CONTROL_ERRORS = Object.freeze([
  "state_dir_rejected",       // 状态目录 ACL/重解析点核对不过
  "protocol_incompatible",    // 活实例协议不一致：不签发、不打开，提示 restart
  "port_conflict",            // 显式 --port 与实例端口不同
  "instance_unresponsive",    // 活实例核对不过（读不出/身份/端口查询/健康/nonce/形状/运行目录）
  "lock_wait_failed",         // 有界等待结束仍无实例可用
  "wmi_create_failed",        // WMI 建不了 serve 子进程
  "port_in_use",              // serve 子进程报固定端口被占
  "assets_missing",           // serve 子进程报静态资源缺失
  "serve_state_dir_rejected", // serve 子进程报状态目录核对不过
  "candidate_mismatch",       // 候选核对不过（pid/创建时间/端口/nonce）
  "launch_failed",            // 其余 serve 失败结果 / 总预算耗尽
  "launch_timeout",           // 期限内没有候选也没有失败结果
  "stop_failed",              // restart 的 stop 阶段没有按时退出：中止，不另起
  "path_quote",               // 路径含无法安全引用的字符（"），拒绝拉起
]);

/** 各失败码的固定中文文案（不回显任何动态值）。 */
export function dashboardControlErrorText(code) {
  const texts = {
    state_dir_rejected: "看板状态目录核对不过（属主/继承/权限或重解析点），拒绝使用；请检查后重试，或换 --state-root。",
    protocol_incompatible: "正在运行的看板实例用的是不兼容的启动协议，不能给它签发启动码；请运行 wao dashboard restart。",
    port_conflict: "正在运行的看板实例不在指定的端口上；请用实例自己的端口，或运行 wao dashboard restart。",
    instance_unresponsive: "看板实例无响应（健康检查超时或身份对不上）；请运行 wao dashboard restart。",
    lock_wait_failed: "另一个看板启动正在进行的等待没有结果；请稍后重试，或运行 wao dashboard status 查看。",
    wmi_create_failed: "WMI 起不了看板实例进程；请检查 PowerShell/WMI 可用性后重试。",
    port_in_use: "指定端口已被占用，看板实例没有启动（WAO 不会动占用端口的进程）。",
    assets_missing: "看板静态资源缺失，实例没有启动。",
    serve_state_dir_rejected: "看板实例核对状态目录不过，没有启动。",
    candidate_mismatch: "看板实例启动了，但候选核对（pid/创建时间/端口/nonce）没有通过；请重试。",
    launch_failed: "看板实例启动失败。",
    launch_timeout: "看板实例在期限内没有报告监听结果；请运行 wao dashboard status 查看后再试。",
    stop_failed: "旧看板实例没有按时退出，restart 已中止（没有另起实例，现场已保留）；请先处理它（wao dashboard stop / status）。",
    path_quote: "运行目录或状态根的路径包含无法安全引用的字符（英文双引号），已拒绝拉起；请修正路径后重试。",
  };
  return texts[code];
}

function controlError(code) {
  const error = new Error(dashboardControlErrorText(code) ?? code);
  error.code = code;
  return error;
}

/** 子进程 result 原因 → 控制面错误码。 */
const RESULT_TO_ERROR = Object.freeze({
  port_in_use: "port_in_use",
  assets_missing: "assets_missing",
  state_dir_rejected: "serve_state_dir_rejected",
  listen_failed: "launch_failed",
  serve_error: "launch_failed",
});

/** 等待锁的总预算：两代启动截止时间（防锁代际活锁）。 */
const LOCK_WAIT_TOTAL_MS = 2 * DASHBOARD_LAUNCH_DEADLINE_MS;
/** 整次 launchDashboard 的总预算（等待 + 拉起 + 发布复核重试）。 */
const OVERALL_LAUNCH_BUDGET_MS = 3 * DASHBOARD_LAUNCH_DEADLINE_MS;

/**
 * serve 子进程命令行的纯拼装（修正一 #2）：
 *   `"<node>" "<cli>" dashboard serve --run-dir "<abs>" --state-root "<abs>"
 *    --generation <16hex> --deadline <ms> [--port <n>]`
 * 路径值一律加引号；任何一个路径含 `"` 都拒绝（path_quote）——不靠转义。工作目录由
 * 调用方给安装根（src/ 的上一级）。
 *
 * @returns {{ok: true, commandLine: string}|{ok: false, reason: "path_quote"}}
 */
export function buildServeCommandLine({ nodePath, cliJsPath, runDir, stateRoot, generation, port, deadline }) {
  const paths = [nodePath, cliJsPath, runDir, stateRoot];
  if (paths.some((value) => typeof value !== "string" || value.length === 0 || value.includes("\""))) {
    return { ok: false, reason: "path_quote" };
  }
  if (typeof generation !== "string" || !/^[0-9a-f]{16}$/.test(generation)) {
    throw new TypeError("buildServeCommandLine: invalid generation");
  }
  const parts = [
    `"${nodePath}"`, `"${cliJsPath}"`,
    "dashboard", "serve",
    "--run-dir", `"${runDir}"`,
    "--state-root", `"${stateRoot}"`,
    "--generation", generation,
    "--deadline", String(Math.trunc(deadline)),
  ];
  if (Number.isInteger(port) && port > 0) parts.push("--port", String(port));
  return { ok: true, commandLine: parts.join(" ") };
}

/**
 * 复用检查（每处共用）。instance.json 三态 + 先判活（修正一 #6）：
 *   absent / 坏文件 / pid 不在 / 创建时间对不上 / 端口归属不是它 → none（可拉起覆盖）；
 *   读不出 → instance_unresponsive(record-unreadable)（不拉起）；
 *   活 + 协议不同 → protocol_incompatible；活 + 协议同 + 形状不对 → unresponsive(record-shape)；
 *   活 + 协议同 + 形状好 → runDir/端口参数/端口归属/health+nonce 全查。
 * reason 记录哪一项没对上（status 打印用；闭集字符串）。
 */
async function probeReusable(io, stateDir, runDir, explicitPort) {
  const read = await io.readInstanceEx(stateDir);
  if (read.status === "absent") return { kind: "none", reason: "absent" };
  if (read.status === "error") return { kind: "instance_unresponsive", reason: "record-unreadable" };
  const raw = read.raw;
  const pid = raw !== null && Number.isInteger(raw.pid) && raw.pid > 0 ? raw.pid : null;
  const createdAt = raw !== null && typeof raw.processCreatedAt === "number" && Number.isFinite(raw.processCreatedAt)
    ? raw.processCreatedAt
    : null;
  if (pid === null || createdAt === null) return { kind: "none", reason: "malformed-record" }; // 坏文件按失效（原子发布下只能是坏文件）
  const identity = await io.probeIdentity(pid, createdAt);
  if (identity === "gone") return { kind: "none", reason: "stale-process" }; // 死记录：可拉起覆盖
  if (identity !== "same") return { kind: "instance_unresponsive", reason: "identity" };
  const protocol = raw.protocol;
  if (protocol !== DASHBOARD_PROTOCOL_VERSION) return { kind: "protocol_incompatible", reason: "protocol" };
  if (read.record === null) return { kind: "instance_unresponsive", reason: "record-shape" };
  const inst = read.record;
  if (inst.runDir !== runDir) return { kind: "instance_unresponsive", reason: "run-dir" }; // 活实例换了身份：保守拒绝（stop 有出口）
  if (explicitPort !== undefined && explicitPort !== 0 && inst.port !== explicitPort) {
    return { kind: "port_conflict", reason: "explicit-port" };
  }
  const owners = await io.listenerPids(inst.port);
  if (owners === null) return { kind: "instance_unresponsive", reason: "port-probe" };
  if (!owners.includes(inst.pid)) return { kind: "none", reason: "port-owner" }; // 端口归属对不上：确定失效
  const health = await io.health(inst.port);
  if (health === null || health.ok !== true) return { kind: "instance_unresponsive", reason: "health" };
  if (health.nonce !== inst.nonce) return { kind: "instance_unresponsive", reason: "nonce" };
  return { kind: "ok", instance: inst };
}

/** 复用/报错的公共收口：ok → 签码返回；坏结局照实抛；none → null（调用方继续）。 */
async function settleReusable(io, stateDir, probe) {
  if (probe.kind === "none") return null;
  if (probe.kind !== "ok") throw controlError(probe.kind);
  const { code } = await io.issueCode(stateDir);
  const buildNote = compareDashboardBuild(probe.instance.build, await io.buildSnapshot());
  return { outcome: "reused", port: probe.instance.port, code, buildNote };
}

/**
 * 拉起或复用一个常驻看板实例。
 *
 * @param {object} input
 * @param {string} input.runDir — normalizeRunDir 的身份串
 * @param {string} input.stateRoot — 状态根（绝对路径）
 * @param {number} [input.port] — 显式端口（0 = 随机）
 * @param {object} [input.io] — 注入件（缺省见 defaultControlIo）
 * @returns {Promise<{outcome: "reused"|"launched", port: number, code: string, buildNote: string}>}
 */
export async function launchDashboard({ runDir, stateRoot, port, io }) {
  const dep = { ...defaultControlIo(), ...io };
  const stateDir = stateDirFor(runDir, stateRoot);
  const codesDir = codesDirOf(stateDir);
  const explicitPort = port === undefined || port === 0 ? undefined : port;

  const dir = await dep.ensureStateDir(stateRoot, stateDir, codesDir);
  if (dir.ok !== true) throw controlError("state_dir_rejected");

  const overallStart = dep.now();
  for (;;) {
    // 1. 复用检查（不取锁）。
    const settled = await settleReusable(dep, stateDir, await probeReusable(dep, stateDir, runDir, explicitPort));
    if (settled !== null) return settled;
    // 总预算在复用检查之后再判：一次被推迟的发布仍有机会先复用别人的成功实例。
    if (dep.now() - overallStart > OVERALL_LAUNCH_BUDGET_MS) throw controlError("launch_failed");

    // 2. 启动锁（原子建锁；等待；内容核对的过期接管）。
    const generation = randomBytes(8).toString("hex");
    // 修正一 #5：锁的期限要覆盖等候选、核对、发布的全程。每次成功建锁都记下这一代的
    // 截止，拉起与发布复核都用它——不再在 spawn 时另起一个更晚的期限。
    let lockDeadline = 0;
    const acquireLock = async () => {
      const until = dep.now() + DASHBOARD_LAUNCH_DEADLINE_MS;
      const result = await dep.createLock(stateDir, generation, until);
      if (result.ok === true) lockDeadline = until;
      return result;
    };
    let acquired = await acquireLock();
    let lockRotated = false;
    while (!acquired.ok) {
      if (dep.now() - overallStart > OVERALL_LAUNCH_BUDGET_MS) throw controlError("launch_failed");
      const existing = acquired.lock; // {generation, deadline} | null（消失/坏形状）
      if (existing === null) {
        // 锁文件在但读不出形状（坏锁）：按坏锁接管，再重新竞争。
        await dep.takeOverStale(stateDir, "0000000000000000");
        await dep.sleep(DASHBOARD_LOCK_POLL_MS);
        acquired = await acquireLock();
        continue;
      }
      // 有界等待：至多到持有者的截止时间；其间反复复用检查（等到了就复用）。
      while (dep.now() < existing.deadline && dep.now() - overallStart <= LOCK_WAIT_TOTAL_MS) {
        await dep.sleep(DASHBOARD_LOCK_POLL_MS);
        const probe = await probeReusable(dep, stateDir, runDir, explicitPort);
        const found = await settleReusable(dep, stateDir, probe);
        if (found !== null) return found;
        const current = await dep.readLock(stateDir);
        if (current === null || current.generation !== existing.generation) {
          lockRotated = true; // 锁被接管/消失：回到竞争起点，绝不拿旧代际去接管
          break;
        }
      }
      if (lockRotated) {
        lockRotated = false;
        acquired = await acquireLock();
        continue;
      }
      if (dep.now() - overallStart > LOCK_WAIT_TOTAL_MS) throw controlError("lock_wait_failed");
      // 截止已到：过期接管——内容核对的移除原语，成功的那一个接管，失败者回等待。
      await dep.takeOverStale(stateDir, existing.generation);
      await dep.sleep(DASHBOARD_LOCK_POLL_MS);
      acquired = await acquireLock();
    }

    // 3. 锁内第二次复用检查（拿到锁之前别人可能已发布）。
    const inLock = await settleReusable(dep, stateDir, await probeReusable(dep, stateDir, runDir, explicitPort));
    if (inLock !== null) return inLock;

    // 4. 一个截止时间贯穿等候选、核对与发布：就是这一代锁的截止（修正一 #5）。
    // spawn 前复核：仍在期限之内、并且锁仍是自己这一代；任一不满足就不拉起——
    // 回到等待与复用检查（这个启动器会按锁的期限自然退出，绝不在过期后还起进程）。
    const deadline = lockDeadline;
    const lockNow = await dep.readLock(stateDir);
    if (dep.now() >= deadline || lockNow === null || lockNow.generation !== generation) {
      continue;
    }
    const spawned = await dep.spawnServe({ runDir, stateRoot, generation, port, deadline });
    if (spawned.ok !== true) {
      // 路径含 `"` 是配置错误（固定失败码），不是 WMI 故障。
      if (spawned.reason === "path_quote") throw controlError("path_quote");
      throw controlError("wmi_create_failed");
    }

    let deferred = false;
    while (dep.now() < deadline) {
      const candidate = await dep.readCandidate(stateDir, generation);
      if (candidate !== null) {
        const identity = await dep.probeIdentity(candidate.pid, candidate.processCreatedAt);
        const owners = await dep.listenerPids(candidate.port);
        const health = await dep.health(candidate.port);
        if (identity !== "same" || owners === null || !owners.includes(candidate.pid)
          || health === null || health.ok !== true || health.nonce !== candidate.nonce) {
          throw controlError("candidate_mismatch");
        }
        // 发布前复核（修正一 #5）：仍在截止内，且锁仍是自己这一代。
        const stillInTime = dep.now() < deadline;
        const lock = await dep.readLock(stateDir);
        const stillMine = lock !== null && lock.generation === generation;
        if (!stillInTime || !stillMine) {
          deferred = true; // 不发布：这个子进程没被发布，会在截止后自己退出
          break;
        }
        await dep.publishInstance(stateDir, {
          protocol: DASHBOARD_PROTOCOL_VERSION,
          runDir,
          pid: candidate.pid,
          processCreatedAt: candidate.processCreatedAt,
          port: candidate.port,
          nonce: candidate.nonce,
          generation,
          build: candidate.build, // 修正一 #11：记录实际服务的子进程报告的 build
        });
        const { code } = await dep.issueCode(stateDir);
        const buildNote = compareDashboardBuild(candidate.build, await dep.buildSnapshot());
        return { outcome: "launched", port: candidate.port, code, buildNote };
      }
      const result = await dep.readResult(stateDir, generation);
      if (result !== null) {
        await dep.removeResult(stateDir, generation); // 修正一 #5：读到 result，读后即清
        throw controlError(RESULT_TO_ERROR[result.reason] ?? "launch_failed");
      }
      await dep.sleep(DASHBOARD_CHILD_POLL_MS);
    }
    if (deferred) continue; // 回到等待与复用检查
    throw controlError("launch_timeout");
  }
}

/** 复用检查 reason → status 的中文短语（闭集；不打印启动码与令牌）。 */
export const STATUS_CHECK_TEXTS = Object.freeze({
  "record-unreadable": "实例记录读不出",
  identity: "进程创建时间对不上",
  protocol: "协议版本不兼容",
  "record-shape": "实例记录形状不对",
  "run-dir": "运行目录对不上",
  "port-probe": "端口监听查询失败",
  health: "健康检查无响应",
  nonce: "健康口令（nonce）对不上",
});

/**
 * 看板实例状态（只读；与复用检查同一口径，逐项报告——修正一 #12）。
 *
 * @returns {Promise<{present: false}|{present: true, pid: number|null, port: number|null,
 *   startedAt: number|null, protocol: number|null, build: "same"|"different"|"unknown",
 *   health: "ok"|"unresponsive"|"incompatible", failedCheck: string|null, runDir: string|null}>}
 */
export async function dashboardStatus({ runDir, stateRoot, io }) {
  const dep = { ...defaultControlIo(), ...io };
  const stateDir = stateDirFor(runDir, stateRoot);
  const codesDir = codesDirOf(stateDir);
  // 状态目录从未建立过：没有实例，也没什么可核对/可读的（如实说“没有”）。
  if (await dep.stateDirPresent(stateDir) !== true) return { present: false };
  const verified = await dep.verifyStateDir(stateRoot, stateDir, codesDir);
  if (verified.ok !== true) throw controlError("state_dir_rejected");
  const probe = await probeReusable(dep, stateDir, runDir, undefined);
  if (probe.kind === "none") return { present: false };
  const read = await dep.readInstanceEx(stateDir);
  const raw = read.status === "present" ? read.raw : null;
  const base = {
    present: true,
    pid: Number.isInteger(raw?.pid) && raw.pid > 0 ? raw.pid : null,
    port: Number.isInteger(raw?.port) && raw.port > 0 ? raw.port : null,
    startedAt: typeof raw?.processCreatedAt === "number" ? raw.processCreatedAt : null,
    protocol: Number.isInteger(raw?.protocol) ? raw.protocol : null,
    runDir: typeof raw?.runDir === "string" ? raw.runDir : null,
    failedCheck: probe.reason ?? null,
    health: probe.kind === "ok" ? "ok" : probe.kind === "protocol_incompatible" ? "incompatible" : "unresponsive",
    build: probe.kind === "ok"
      ? compareDashboardBuild(probe.instance.build, await dep.buildSnapshot())
      : "unknown",
  };
  return base;
}

/**
 * 停掉本运行目录的看板实例。先核对状态目录（不过不写停机请求）；只有旧 pid 确实
 * 不在或创建时间对不上才算没有实例/已退出；记录消失、pid 还活着就继续等到超时
 * （修正一 #9）。超时如实报告；不强杀、不删记录——清理一律由实例按代际自己做。
 *
 * @returns {Promise<{outcome: "stopped"|"no_instance"|"timeout"}>}
 */
export async function dashboardStop({ runDir, stateRoot, io }) {
  const dep = { ...defaultControlIo(), ...io };
  const stateDir = stateDirFor(runDir, stateRoot);
  const codesDir = codesDirOf(stateDir);
  // 状态目录从未建立过：没有实例可停，也不该往不存在的目录写停机请求。
  if (await dep.stateDirPresent(stateDir) !== true) return { outcome: "no_instance" };
  const verified = await dep.verifyStateDir(stateRoot, stateDir, codesDir);
  if (verified.ok !== true) throw controlError("state_dir_rejected");
  const read = await dep.readInstanceEx(stateDir);
  if (read.status === "error") throw controlError("instance_unresponsive");
  if (read.status === "absent") return { outcome: "no_instance" };
  const raw = read.raw;
  const pid = raw !== null && Number.isInteger(raw.pid) && raw.pid > 0 ? raw.pid : null;
  const createdAt = raw !== null && typeof raw.processCreatedAt === "number" && Number.isFinite(raw.processCreatedAt)
    ? raw.processCreatedAt
    : null;
  if (pid === null || createdAt === null) return { outcome: "no_instance" }; // 坏文件：没有可停的实例
  const inst = read.record; // 可能 null（形状不合）——停机请求要 nonce/代际，取不到就按无实例
  if (inst === null || typeof inst.generation !== "string" || typeof inst.nonce !== "string") {
    return { outcome: "no_instance" };
  }
  const before = await dep.probeIdentity(pid, createdAt);
  if (before === "gone") return { outcome: "no_instance" };
  if (before !== "same") throw controlError("instance_unresponsive");
  await dep.writeStopRequest(stateDir, inst.generation, inst.nonce);
  const deadline = dep.now() + DASHBOARD_STOP_WAIT_MS;
  for (;;) {
    const identity = await dep.probeIdentity(pid, createdAt);
    if (identity === "gone") return { outcome: "stopped" }; // 只有进程确实不在才 stopped
    if (dep.now() >= deadline) return { outcome: "timeout" };
    await dep.sleep(DASHBOARD_LOCK_POLL_MS);
  }
}

/**
 * restart：先 stop，确认旧代退出才拉起；stop 失败就中止，不另起。
 *
 * @returns {Promise<{outcome: "reused"|"launched", port, code, buildNote}>}
 */
export async function dashboardRestart({ runDir, stateRoot, port, io }) {
  const stopped = await dashboardStop({ runDir, stateRoot, io });
  if (stopped.outcome === "timeout") {
    throw controlError("stop_failed");
  }
  return launchDashboard({ runDir, stateRoot, port, io });
}

// ── 缺省 io：真实文件/PowerShell/WMI/fetch ──────────────────────────────────

/** src/cli.js 的绝对路径（serve 子进程的入口；从本模块位置推导，两种安装形态都对）。 */
function defaultCliJsPath() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
}

/**
 * 真实的缺省依赖件。WMI 子进程不继承调用方环境：node/CLI/runDir/stateRoot/generation/
 * deadline 全部作为命令行参数显式传入（路径值加引号；含 `"` 由 buildServeCommandLine
 * 拒绝），工作目录为安装根（src/ 的上一级）；子进程的脱敏环境就是用户默认环境。
 */
export function defaultControlIo(overrides = {}) {
  const cliJs = defaultCliJsPath();
  // 安装根 = src/ 的上一级（从 cli.js 的位置推）；WMI 子进程的工作目录就是它。
  const installRoot = resolve(dirname(cliJs), "..");
  // 测试缝：WMI 创建层可注入（验证命令行与工作目录，不真起进程）。
  const wmiBroker = typeof overrides.wmiBroker === "function" ? overrides.wmiBroker : defaultWmiSpawnBroker;
  return {
    now: Date.now,
    // 这里的定时器必须保持引用：启动器等锁/等候选时事件循环里只剩这一个等待，
    // unref 会让进程带着未完成的等待直接退出（静默"成功"——E2E 实测抓到过）。
    sleep: (ms) => new Promise((r) => { setTimeout(r, ms); }),
    ensureStateDir: ensureDashboardStateDir,
    verifyStateDir: verifyDashboardStateDir,
    readInstanceEx: readInstanceRecordEx,
    publishInstance: publishInstanceRecord,
    readCandidate: readCandidateRecord,
    readResult: readResultRecord,
    removeResult: removeResultRecord,
    createLock: createLaunchLock,
    readLock: readLaunchLock,
    takeOverStale: takeOverStaleLock,
    writeStopRequest,
    stateDirPresent,
    probeIdentity: probeProcessIdentity,
    listenerPids: listenerPidsOfPort,
    async health(port) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(DASHBOARD_HEALTH_TIMEOUT_MS),
          headers: { accept: "application/json" },
        });
        if (!response.ok) return null;
        const body = await response.json();
        if (body === null || typeof body !== "object" || body.status !== "ok" || typeof body.nonce !== "string") return null;
        return { ok: true, nonce: body.nonce };
      } catch {
        return null;
      }
    },
    async spawnServe({ runDir, stateRoot, generation, port, deadline }) {
      const built = buildServeCommandLine({
        nodePath: process.execPath,
        cliJsPath: cliJs,
        runDir,
        stateRoot,
        generation,
        ...(Number.isInteger(port) && port > 0 ? { port } : {}),
        deadline,
      });
      if (built.ok !== true) return { ok: false, reason: built.reason }; // path_quote：配置错误，固定失败码
      const created = await wmiBroker({
        commandLine: built.commandLine,
        cwd: installRoot,
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
      return created.ok === true ? { ok: true, pid: created.pid } : { ok: false, detail: created.detail };
    },
    async issueCode(stateDir) {
      return issueStartCode(codesDirOf(stateDir));
    },
    async buildSnapshot() {
      return buildSnapshotFromFacts(readServerBuildFacts());
    },
    ...overrides,
  };
}
