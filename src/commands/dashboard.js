// src/commands/dashboard.js
//
// 第 145b 批（决定 0131 第 2 条）：顶层 `wao dashboard` —— Owner 看板的常驻实例
// 启动器与运维出口。
//
//   wao dashboard [--cwd DIR] [--port N] [--run-dir DIR] [--no-open]
//     找本运行目录已在跑的实例（协议/pid+创建时间/端口归属/health+nonce/runDir 全对
//     才复用）；没有或确定已失效就经 WMI 拉起（dashboardControl 的状态机）。无论复用
//     还是拉起，都签发一个 60 秒一次性启动码，把
//     http://127.0.0.1:<port>/v2/#code=<码>（--cwd 命中已知项目时带上项目筛选）交给
//     浏览器；--no-open 或打开失败时把 URL 打印到终端一次（只进 stdout，不进实例日志）。
//     命令随即退出——实例常驻，属于这个运行目录。
//   wao dashboard serve …   内部入口：实例进程本身（dashboardServe.js）
//   wao dashboard status    pid/端口/启动时间/协议/build（相同|不同|无法确认）/健康
//   wao dashboard stop      写停机请求，等实例自己退出；超时如实报错，不强杀不删记录；活进程配
//                           形状不对的记录（写不出停机请求）如实报"pid N 的看板实例无响应，请先关掉它"
//   wao dashboard restart   先 stop，确认旧代退出才拉起；stop 失败就中止
//
// --cwd 只定初始项目筛选（决定 0131 第 1 条）：目录属于运行目录里某个已知项目时，
// 打开的 URL 带上这个项目的筛选（/v2 现有的 hash 格式）；否则打开不带筛选的总览。
// 不再要求目录在 Git 仓库里；常驻实例本身与 --cwd 无关。
//
// 已知局限（一句话一条）：
//   - 145b 之前的前台实例没有 instance.json，新代码发现不了也停不了它，要手动关闭。
//   - 一次性启动码会短暂出现在浏览器打开器的命令行与浏览器的这一条历史里。
//
// The opener is shell-free by construction: the URL is passed as ONE structured argv
// element to a real executable (rundll32 url.dll,FileProtocolHandler) — no shell
// builtin, no shell string, no URL interpolation.

import { resolve } from "node:path";
import { spawn } from "node:child_process";

import { parseOptions } from "./shared.js";
import { linesError } from "../safeText.js";
import { dashboardServeCommand } from "./dashboardServe.js";
import {
  launchDashboard,
  dashboardStatus,
  dashboardStop,
  dashboardRestart,
  defaultControlIo,
  dashboardControlErrorText,
  STATUS_CHECK_TEXTS,
} from "../application/dashboardControl.js";
import {
  normalizeRunDir,
  stateDirFor,
  defaultDashboardStateRoot,
} from "../application/dashboardPaths.js";
import { identifyProjectFromCwd } from "../projectIdentity.js";
import { loadBucketIndex, SAFE_BUCKET_SLUG_RE } from "../projectBuckets.js";

/**
 * Production Windows default-browser opener: `rundll32 url.dll,FileProtocolHandler`
 * with structured argv — NO shell, NO cmd.exe, and the URL is never interpolated
 * into a shell string (it travels as a single argv element).
 *
 * Lifecycle (M12-8F risk correction): the child is spawned detached with ignored
 * stdio and a hidden console; the promise resolves on the child's SPAWN event,
 * NOT on exit. A lingering default-handler process can therefore never hold the
 * launcher open — after spawn the child is unref()ed. A pre-spawn failure
 * (ENOENT/EACCES/invalid argv) rejects so the advisory print-URL path runs.
 *
 * @param {string} url — the printed start-code dashboard URL
 * @param {{spawnFn?: Function}} [opts] — spawn injection seam (tests)
 * @returns {Promise<void>} resolves on spawn success, rejects on pre-spawn failure
 */
export function openInWindowsDefaultBrowser(url, { spawnFn } = {}) {
  return new Promise((resolveOpen, rejectOpen) => {
    const spawnChild = spawnFn ?? spawn;
    let child;
    try {
      child = spawnChild("rundll32", ["url.dll,FileProtocolHandler", url], {
        detached: true,    // run outside the launcher's process group
        stdio: "ignore",   // no pipes — nothing to feed or read
        windowsHide: true, // no console flash
      });
    } catch (error) {
      rejectOpen(error); // synchronous spawn failure (e.g. invalid argv)
      return;
    }
    child.once("spawn", () => {
      child.unref(); // after spawn the child cannot hold the launcher open
      resolveOpen();
    });
    // Pre-spawn failures (e.g. ENOENT) reject → the advisory print path runs.
    // Errors after spawn are ignored: the promise already settled and the URL
    // was printed.
    child.once("error", (error) => rejectOpen(error));
  });
}

/** 命令族的公共输入：规范化运行目录身份与状态根。 */
function resolveTargets(options, config) {
  const runDirRaw = resolve(options.runDir ?? config.runDir);
  const runDir = normalizeRunDir(runDirRaw); // 不存在即固定报错
  const stateRoot = typeof options.stateRoot === "string" && options.stateRoot.length > 0
    ? resolve(options.stateRoot)
    : defaultDashboardStateRoot();
  return { runDir, stateRoot };
}

/** --port 的 CLI 强制转换（0 = 随机；服务端再验全范围）。 */
function coercePort(options) {
  if (options.port === undefined || options.port === null || options.port === true) return 0;
  const n = Number(options.port);
  if (!Number.isInteger(n)) throw new Error("--port must be an integer");
  return n;
}

/** 控制面错误的 CLI 呈现：固定文案（含 restart 提示），不回显动态值。 */
function rethrowControlError(error) {
  if (error && typeof error.code === "string" && dashboardControlErrorText(error.code) !== undefined) {
    throw linesError([error.message]);
  }
  throw error;
}

/**
 * Top-level `wao dashboard …` 分发：serve/status/stop/restart 之外是启动器。
 *
 * @param {string[]} args — CLI args after `dashboard`
 * @param {object} config — process config (runDir/stateDir)
 * @param {object} [injections]
 * @param {Function} [injections.openUrlFn] — browser opener (tests)
 * @param {Function} [injections.spawnFn] — spawn factory for the production opener (tests)
 * @param {object} [injections.controlIo] — dashboardControl io seam (tests)
 * @param {object} [injections.filterIo] — { identifyFn, bucketIndexFn } for the --cwd filter (tests)
 * @param {Function} [injections.log] — stdout sink
 */
export async function dashboardCommand(args, config, injections = {}) {
  const [first] = args;
  if (first === "serve") return dashboardServeCommand(args.slice(1), config, injections);
  if (first === "status") return statusCommand(args, config, injections);
  if (first === "stop") return stopCommand(args, config, injections);
  if (first === "restart") return restartCommand(args, config, injections);
  return launchCommand(args, config, injections);
}

/** `wao dashboard [--cwd DIR] [--port N] [--run-dir DIR] [--no-open]`：复用或拉起。 */
async function launchCommand(args, config, injections = {}) {
  const options = parseOptions(args);
  const log = injections.log ?? ((s) => console.log(s));
  let targets;
  try {
    targets = resolveTargets(options, config);
  } catch (error) {
    throw linesError([error.message]);
  }
  const port = coercePort(options);
  const io = injections.controlIo ?? defaultControlIo();

  let outcome;
  try {
    outcome = await launchDashboard({ runDir: targets.runDir, stateRoot: targets.stateRoot, port, io });
  } catch (error) {
    rethrowControlError(error);
  }

  // 启动码进 URL 片段（绝不进查询串）；--cwd 命中已知项目时片段带筛选。
  const filter = filterFragmentOf(targets.runDir, options, injections);
  const fragment = filter === "" ? `#code=${outcome.code}` : `${filter}&code=${outcome.code}`;
  const url = `http://127.0.0.1:${outcome.port}/v2/${fragment}`;

  log(outcome.outcome === "reused" ? "看板已在运行，复用本运行目录的实例。" : "看板实例已启动。");
  if (outcome.buildNote === "different") log("实例运行的是旧版本代码，请运行 wao dashboard restart。");
  if (outcome.buildNote === "unknown") log("无法确认实例版本，建议 restart。");
  if (options.noOpen) {
    log(url);
    return { ...outcome, url };
  }
  const openUrl = injections.openUrlFn
    ?? ((u) => openInWindowsDefaultBrowser(u, { spawnFn: injections.spawnFn }));
  try {
    await openUrl(url);
  } catch {
    // 打开失败：把 URL 打印到终端一次（只进 stdout；绝不进实例日志）。
    log(`⚠ 无法自动打开浏览器——请手动打开：${url}`);
  }
  return { ...outcome, url };
}

/** `wao dashboard status [--run-dir DIR]`：如实打印实例事实（不含启动码与令牌）。 */
async function statusCommand(args, config, injections = {}) {
  const options = parseOptions(args);
  const log = injections.log ?? ((s) => console.log(s));
  const { runDir, stateRoot } = resolveTargets(options, config);
  const io = injections.controlIo ?? defaultControlIo();
  const s = await dashboardStatus({ runDir, stateRoot, io });
  if (s.present !== true) {
    log("没有正在运行的看板实例。");
    return s;
  }
  const startedAt = new Date(s.startedAt);
  const closeFirst = s.failedCheck === "record-shape" && s.pid !== null; // 见下：这种情形不提示 restart
  const buildText = s.build === "same"
    ? "与当前代码相同"
    : s.build === "different" ? "与当前代码不同（建议 restart）" : closeFirst ? "无法确认" : "无法确认（建议 restart）";
  log(`看板实例：pid ${s.pid}，端口 ${s.port}，启动于 ${Number.isFinite(startedAt.valueOf()) ? startedAt.toISOString() : "unknown"}，协议版本 ${s.protocol}。`);
  // 145b 修正一 #12：健康判定与复用检查同一口径，哪一项没对上如实说。
  // 活进程配形状不对的记录：restart 的 stop 阶段写不出停机请求，只会回到同一个错误——
  // 这种情形只提示先关掉进程，不提示 restart（修正二 #9）。
  const advice = closeFirst
    ? `请先关掉 pid ${s.pid} 的看板实例`
    : "建议 wao dashboard restart";
  const healthText = s.health === "ok"
    ? "正常"
    : `${s.health === "incompatible" ? "协议不兼容" : "无响应"}${s.failedCheck !== null && STATUS_CHECK_TEXTS[s.failedCheck] !== undefined ? `（${STATUS_CHECK_TEXTS[s.failedCheck]}）` : ""}；${advice}`;
  log(`健康：${healthText}；build：${buildText}。`);
  return s;
}

/** `wao dashboard stop [--run-dir DIR]`：优雅停机；超时不强杀、不删记录。 */
async function stopCommand(args, config, injections = {}) {
  const options = parseOptions(args);
  const log = injections.log ?? ((s) => console.log(s));
  const { runDir, stateRoot } = resolveTargets(options, config);
  const io = injections.controlIo ?? defaultControlIo();
  let out;
  try {
    out = await dashboardStop({ runDir, stateRoot, io });
  } catch (error) {
    rethrowControlError(error); // 固定文案（含"pid N 的看板实例无响应，请先关掉它"）
  }
  if (out.outcome === "no_instance") {
    log("没有正在运行的看板实例。");
    return out;
  }
  if (out.outcome === "stopped") {
    log("看板实例已退出。");
    return out;
  }
  throw linesError([
    "实例没有按时退出；现场已保留（没有强杀、没有删记录）。",
    "可再试 wao dashboard stop，或用 wao dashboard status 查看后处理。",
  ]);
}

/** `wao dashboard restart [--cwd DIR] [--port N] [--run-dir DIR] [--no-open]`：先停后起。 */
async function restartCommand(args, config, injections = {}) {
  const options = parseOptions(args);
  const log = injections.log ?? ((s) => console.log(s));
  const { runDir, stateRoot } = resolveTargets(options, config);
  const port = coercePort(options);
  const io = injections.controlIo ?? defaultControlIo();
  let outcome;
  try {
    outcome = await dashboardRestart({ runDir, stateRoot, port, io });
  } catch (error) {
    rethrowControlError(error);
  }
  const filter = filterFragmentOf(runDir, options, injections);
  const fragment = filter === "" ? `#code=${outcome.code}` : `${filter}&code=${outcome.code}`;
  const url = `http://127.0.0.1:${outcome.port}/v2/${fragment}`;
  log("看板实例已重启。");
  if (outcome.buildNote === "different") log("实例运行的是旧版本代码，请运行 wao dashboard restart。");
  if (outcome.buildNote === "unknown") log("无法确认实例版本，建议 restart。");
  if (options.noOpen) {
    log(url);
    return { ...outcome, url };
  }
  const openUrl = injections.openUrlFn
    ?? ((u) => openInWindowsDefaultBrowser(u, { spawnFn: injections.spawnFn }));
  try {
    await openUrl(url);
  } catch {
    log(`⚠ 无法自动打开浏览器——请手动打开：${url}`);
  }
  return { ...outcome, url };
}

/** --cwd 筛选片段（可注入 identify/bucketIndex 的读法）。 */
function filterFragmentOf(runDir, options, injections) {
  const identifyFn = injections.filterIo?.identifyFn ?? identifyProjectFromCwd;
  const bucketIndexFn = injections.filterIo?.bucketIndexFn ?? loadBucketIndex;
  const cwd = typeof options.cwd === "string" && options.cwd.length > 0 ? resolve(options.cwd) : process.cwd();
  try {
    const identity = identifyFn(cwd);
    if (identity === null || typeof identity !== "object" || identity.kind !== "project") return "";
    const { entries } = bucketIndexFn(runDir);
    const slug = entries?.[identity.key];
    if (typeof slug !== "string" || !SAFE_BUCKET_SLUG_RE.test(slug)) return "";
    return `#workers?project=${encodeURIComponent(slug)}`;
  } catch {
    return "";
  }
}
