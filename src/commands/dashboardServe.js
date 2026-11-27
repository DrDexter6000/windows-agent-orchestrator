// src/commands/dashboardServe.js
//
// 第 145b 批（决定 0131 第 2 条；修正一 #8/#11 改定）：常驻看板实例进程
// （`wao dashboard serve`——内部入口，由 `wao dashboard` 经 WMI 创建层拉起）。
//
// 生命周期：
//   - 三层状态目录（根/实例/codes）核对通过后监听；会话存储（内存）与 codes\ 就绪后
//     /health 回本实例 nonce；写候选之前先**清空** codes\ 的全部旧码与 claim（上一代
//     没用掉的码，换代后一律不能兑换；有条数上限，清不完按 serve_error 失败）；
//   - 候选记录端口、pid、nonce、OS 创建时间与**自己加载的 build**（instance.json 记
//     录的是它，不是父进程的快照）；
//   - 每秒轮询：截止时间过了还没被发布（迟到的失败者）、或发布后被换成别的代际
//     （被替换的旧代）→ 收尾退出；发现 nonce 对得上的 stop-<g>.request → 优雅退出；
//   - 每条失败路径（监听前与监听后）都走同一个收尾：写 result-<g>.json、有界关服务、
//     按退出码退出——包括读不出自己的创建时间、写候选失败、日志写失败；
//   - 优雅退出：停接收、先断流、server.close() + closeAllConnections()；close() 与
//     整体预算 DASHBOARD_STOP_BUDGET_MS 赛跑，**到点无论 close() 是否完成都退出**
//     （退出码 1；正常停机退出码 0）；最后只在 instance.json 仍是自己代际时按内容
//     核对地删掉它，并删掉自己这一代的 candidate-<g>.json 与 stop-<g>.request；
//   - 低频清理过期的启动码（启动时 + 每分钟一次，有条数上限）；
//   - 不开机自启、不设闲置退出。
//
// 已知局限（一句话一条）：
//   - 145b 之前的前台实例没有 instance.json，新代码发现不了也停不了它，要手动关闭。
//   - 拉起中、尚未发布时运行 `wao dashboard stop`，会报"没有实例"（还没有记录可停）。
//   - 同一账户、管理员、SYSTEM 不防（威胁模型）。
//   - 一次性启动码会短暂出现在浏览器打开器的命令行与浏览器的这一条历史里。

import { resolve } from "node:path";

import { parseOptions } from "./shared.js";
import { createOwnerDashboardServer } from "../ownerDashboardServer.js";
import {
  normalizeRunDir,
  stateDirFor,
  DASHBOARD_INSTANCE_POLL_MS,
  DASHBOARD_CODE_SWEEP_INTERVAL_MS,
  DASHBOARD_LAUNCH_DEADLINE_MS,
  DASHBOARD_STOP_BUDGET_MS,
} from "../application/dashboardPaths.js";
import { verifyDashboardStateDir } from "../application/dashboardAcl.js";
import {
  writeResultRecord,
  writeCandidateRecord,
  readInstanceRecordEx,
  readStopRequest,
  removeInstanceRecordIfGeneration,
  removeOwnGenerationFiles,
  createInstanceLogger,
  codesDirOf,
  instanceLogFileOf,
} from "../application/dashboardFiles.js";
import { sweepExpiredStartCodes, purgeAllStartCodes } from "../application/dashboardCodes.js";
import { readProcessCreatedAt } from "../application/dashboardWinFacts.js";
import { buildSnapshotFromFacts } from "../application/dashboardBuild.js";
import { readServerBuildFacts } from "../application/serverBuildFacts.js";

const GENERATION_RE = /^[0-9a-f]{16}$/;

/**
 * `wao dashboard serve --run-dir <abs> --state-root <abs> --generation <16hex>
 * [--port N] [--deadline <epochMs>]`（内部入口）。
 *
 * @param {string[]} args — serve 之后的参数
 * @param {object} config — 进程配置（serve 只用显式参数，不读 config 的路径）
 * @param {object} [injections] — { createServerFn, verifyStateDirFn, readCreatedAtFn, exitFn, log,
 *   stopBudgetMs, writeCandidateFn, createLoggerFn, purgeFn, buildSnapshotFn }（测试缝；
 *   exitFn 缺省是 process.exit）
 */
export async function dashboardServeCommand(args, config, injections = {}) {
  const options = parseOptions(args);
  const log = injections.log ?? (() => {});
  const createServerFn = injections.createServerFn ?? createOwnerDashboardServer;
  const verifyStateDirFn = injections.verifyStateDirFn ?? verifyDashboardStateDir;
  const readCreatedAtFn = injections.readCreatedAtFn ?? readProcessCreatedAt;
  const exitFn = injections.exitFn ?? ((code) => process.exit(code));
  const stopBudgetMs = injections.stopBudgetMs ?? DASHBOARD_STOP_BUDGET_MS;
  const writeCandidateFn = injections.writeCandidateFn ?? writeCandidateRecord;
  const createLoggerFn = injections.createLoggerFn ?? createInstanceLogger;
  const purgeFn = injections.purgeFn ?? purgeAllStartCodes;
  const buildSnapshotFn = injections.buildSnapshotFn ?? (() => buildSnapshotFromFacts(readServerBuildFacts()));

  const runDirArg = options.runDir;
  const stateRootArg = options.stateRoot;
  const generation = options.generation;
  if (typeof runDirArg !== "string" || typeof stateRootArg !== "string" || typeof generation !== "string" || !GENERATION_RE.test(generation)) {
    throw new Error("dashboard serve 需要 --run-dir、--state-root 与 16 位十六进制的 --generation");
  }
  let port = 0;
  if (options.port !== undefined && options.port !== null && options.port !== true) {
    const n = Number(options.port);
    if (!Number.isInteger(n)) throw new Error("--port must be an integer");
    port = n;
  }
  const deadline = Number.isInteger(Number(options.deadline)) && Number(options.deadline) > 0
    ? Number(options.deadline)
    : Date.now() + DASHBOARD_LAUNCH_DEADLINE_MS;

  const runDir = normalizeRunDir(resolve(runDirArg));
  const stateRoot = resolve(stateRootArg);
  const stateDir = stateDirFor(runDir, stateRoot);
  const codesDir = codesDirOf(stateDir);

  let server = null; // 监听成功后非空；fail() 需要在声明前引用它，所以提前声明
  let serveExitCode = 0; // 本命令自己的退出码（process.exitCode 是进程级全局，测试同进程复用会串味）
  let logger = null;
  let sweepTimer = null;

  /**
   * 写一行实例日志；写失败返回 false（绝不把一次日志故障变成未捕获异常）。
   * 修正一 #8：日志写失败也是启动期失败，要走统一的收尾（写结果、关服务、按退出码退出）。
   */
  const say = (text) => {
    if (logger === null) return false;
    try {
      logger.line(text);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * 统一失败收尾（修正一 #8）：写本代际的失败结果（尽力）、有界关掉已起的服务、按
   * 退出码 1 退出。监听前与监听后的每条失败路径都走这里——不抛错、不挂住。
   */
  const fail = async (reason, note) => {
    serveExitCode = 1;
    try {
      await writeResultRecord(stateDir, generation, reason);
    } catch {
      // 结果写不进（极端）：父进程按超时收口
    }
    say(`serve failed: ${reason}${note ? ` (${note})` : ""}`);
    log(`serve failed: ${reason}${note ? ` (${note})` : ""}`);
    if (server !== null) {
      await boundedClose();
    }
    exitFn(serveExitCode); // 生产：process.exit 不返回；测试缝：返回后命令收口
  };

  /** 启动期的日志：写失败按 serve_error 收口（返回 false 时调用方直接 return）。 */
  const logOrFail = async (text) => {
    if (say(text)) return true;
    await fail("serve_error", "instance log");
    return false;
  };

  /** 有界关服务：close() 与预算赛跑，到点硬断连接（真正解不开的是在途刷新的等待）。 */
  const boundedClose = async () => {
    let timer = null;
    const hard = new Promise((resolveHard) => {
      // 不 unref：close() 卡在在途刷新上时，事件循环里可能只剩这个定时器——它必须能
      // 到点把预算用尽这件事落定（否则进程会带着没关完的服务静默退出）。
      timer = setTimeout(() => {
        try { server.server?.closeAllConnections?.(); } catch { /* 已关 */ }
        resolveHard("budget");
      }, stopBudgetMs);
    });
    const closing = Promise.resolve()
      .then(() => server.close()) // 同步 throw 也归到 "closed"（关不掉不改变退出路径）
      .then(() => "closed", () => "closed");
    try {
      return await Promise.race([closing, hard]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };

  // 1. 三层状态目录核对（只核对不修改；不过即拒绝）。
  const verified = await verifyStateDirFn(stateRoot, stateDir, codesDir);
  if (verified.ok !== true) {
    await fail("state_dir_rejected", verified.reason);
    return;
  }

  // 2. 日志（每代重写；绝不记录 URL、请求头、启动码、会话令牌——只喂事件词与数字）。
  try {
    logger = createLoggerFn(instanceLogFileOf(stateDir));
  } catch {
    await fail("serve_error", "instance log");
    return;
  }
  // 修正一 #8：实例日志写不进去也是启动失败——同一条收尾，不抛错、不挂住。
  if (!await logOrFail(`serve start generation ${generation} port ${port}`)) return;

  // 3. 服务（构造即校验固定静态资源，缺了起不来）。
  try {
    server = createServerFn({ runDir, port, codesDir });
  } catch {
    say("server construction failed");
    await fail("assets_missing");
    return;
  }

  // 4. 监听（端口被占 → port_in_use；不把占用者当看板，也不杀它）。
  let address;
  try {
    address = await server.listen();
  } catch (error) {
    say(`listen failed: ${typeof error?.code === "string" ? error.code : "unknown"}`);
    await fail(error?.code === "EADDRINUSE" ? "port_in_use" : "listen_failed");
    return;
  }
  if (!await logOrFail(`listening port ${address.port}`)) return;

  // 5. 换代清空旧码（上一代没用掉的码，换代后一律不能兑换；清不完就失败）。
  const purged = await purgeFn(codesDir);
  if (purged.ok !== true) {
    say(`codes purge incomplete: ${purged.remaining} left`);
    await fail("serve_error", "codes purge");
    return;
  }
  if (purged.purged > 0) say(`codes purged: ${purged.purged}`);

  // 6. 过期启动码的低频清理（启动时一次 + 每分钟一次，有条数上限）。
  const sweep = () => { sweepExpiredStartCodes(codesDir).catch(() => {}); };
  sweep();
  sweepTimer = setInterval(sweep, DASHBOARD_CODE_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  // 7. 候选：创建时间读得出、build 快照读得出才写得出（父进程按候选核对身份）。
  const processCreatedAt = await readCreatedAtFn(process.pid);
  if (typeof processCreatedAt !== "number" || !Number.isFinite(processCreatedAt)) {
    say("own creation time unreadable");
    await fail("serve_error", "creation time");
    return;
  }
  const build = await buildSnapshotFn();
  try {
    await writeCandidateFn(stateDir, generation, {
      port: address.port,
      pid: process.pid,
      nonce: server.nonce,
      processCreatedAt,
      build, // 修正一 #11：实际服务的子进程自己报告 build
    });
  } catch (error) {
    say(`candidate write failed: ${typeof error?.code === "string" ? error.code : "unknown"}`);
    await fail("serve_error", "candidate write");
    return;
  }
  // 候选写出之后日志再坏也不该杀掉一个已经能服务的实例：只静默，不再把日志当启动门。
  say(`candidate written pid ${process.pid}`);

  // 8. 代际轮询：截止前没被发布、发布后被替换、或收到对得上的停机请求 → 退出。
  let published = false;
  let stopping = false;
  let pollTimer = null;

  let settleStopped;
  const stopped = new Promise((resolveStopped) => { settleStopped = resolveStopped; });

  async function poll() {
    if (stopping) return;
    try {
      const stopNonce = await readStopRequest(stateDir, generation);
      if (stopNonce === server.nonce) {
        await gracefulStop("stop-request", 0);
        return;
      }
      const read = await readInstanceRecordEx(stateDir);
      if (read.status === "present" && read.record !== null && read.record.generation === generation) published = true;
      if (!published && Date.now() >= deadline) {
        await gracefulStop("deadline-passed-unpublished", 0);
        return;
      }
      if (published && (read.status !== "present" || read.record === null || read.record.generation !== generation)) {
        await gracefulStop("superseded", 0);
      }
    } catch {
      // 一次轮询读失败下一轮再看（文件在换写的瞬间会出现）
    }
  }

  /**
   * 优雅退出（修正一 #8）：停接收、先断流（server.close 内部先 closeAll 流连接），
   * close() 与整体预算赛跑——到点无论 close() 是否完成都退出（退出码 1；正常路径 0）。
   * 最后：只在 instance.json 仍是自己代际时按内容核对地删它；删掉自己这一代的
   * candidate-<g>.json 与 stop-<g>.request。
   */
  async function gracefulStop(reason, code) {
    if (stopping) return;
    stopping = true;
    if (pollTimer !== null) clearInterval(pollTimer);
    if (sweepTimer !== null) clearInterval(sweepTimer);
    say(`stopping: ${reason}`);
    const outcome = await boundedClose();
    if (outcome === "budget") {
      say("stop budget exhausted");
      serveExitCode = 1;
    } else {
      serveExitCode = code;
    }
    try {
      await removeInstanceRecordIfGeneration(stateDir, generation);
    } catch {
      // 删不掉：留下记录，下次启动按失效处理
    }
    try {
      await removeOwnGenerationFiles(stateDir, generation);
    } catch {
      // 同上
    }
    say("stopped");
    exitFn(serveExitCode); // 生产：到此为止；测试缝：返回后落定 stopped
    settleStopped();
  }

  pollTimer = setInterval(() => { poll(); }, DASHBOARD_INSTANCE_POLL_MS);
  pollTimer.unref?.();

  // 主流程等停机：真实进程由监听句柄与定时器撑着，优雅停机经上面的收口退出。
  await stopped;
}
