// src/commands/daemon.js
//
// TD-98 阶段 1：daemon 命令族从 cli.js 拆出（行为不变，纯搬迁）。
//
// 依赖：
//   - 外部模块：./daemon.js（connectDaemon/readDaemonHandshake/isDaemonAlive/...）、
//     ./daemonSupervisor.js（readSupervisorState）
//   - 共享工具：./shared.js（parseOptions/loadPrompt，纯函数/低风险 I/O）
//   - node built-in：child_process（spawn/spawnSync）、fs（readFileSync/unlinkSync/existsSync/statSync）、
//     path（join/resolve/dirname）、url（fileURLToPath）
//
// daemon 族零跨 family 共享——resolveDaemonPipe 只被 daemon 用，自包含。

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// M10-pre3 final gate: test-injectable spawn. Production reads `spawn`; tests
// override via _setSpawnForTest to observe spawn count/args without detaching a
// real daemon child. null restores the production import.
let _spawnImpl = null;
function _spawnForTest(fn) { _spawnImpl = fn; }
function resolveSpawn() { return _spawnImpl ?? spawn; }

import {
  connectDaemon,
  readHandshake as readDaemonHandshake,
  isDaemonAlive,
  HANDSHAKE_FILE as DAEMON_HANDSHAKE_FILE,
  DEFAULT_PIPE,
  DEFAULT_LIVENESS_THRESHOLD_MS,
} from "../daemon.js";
import { readSupervisorState } from "../daemonSupervisor.js";
// TD-98 阶段 2a：parseOptions/loadPrompt 从 cli.js 抽到 ./shared.js，消除 ESM 循环 import。
import { parseOptions, loadPrompt } from "./shared.js";
import { validateBoundedWaitTimeout } from "../application/timeoutPolicy.js";
import { transcriptPathFor } from "../transcript.js";
import { resolveTranscriptPath } from "../projectBuckets.js";

// daemon 命令族：start/stop/status/ping/list。常驻 daemon（P3-T1，ADR 0012 命名管道 IPC）。
// start: fork detached node src/daemon.js；ping/status/list/stop: 经 IPC 连 daemon。
export async function daemonCommand(args, config) {
  const [sub, ...tail] = args;
  if (sub === "start") { await daemonStartCommand(tail, config); return; }
  if (sub === "run") { await daemonRunCommand(tail, config); return; }
  if (sub === "stop") { await daemonStopCommand(tail, config); return; }
  if (sub === "status") { await daemonStatusCommand(tail, config); return; }
  if (sub === "list") { await daemonListCommand(tail, config); return; }
  if (sub === "ping") { await daemonPingCommand(tail, config); return; }
  if (sub === "supervise") { await daemonSuperviseCommand(tail, config); return; }
  if (sub === "supervisor") { await daemonSupervisorCommand(tail, config); return; }
  if (sub === "health") { await daemonHealthCommand(tail, config); return; }
  throw new Error(`Unknown daemon subcommand: ${sub ?? ""}. Try: daemon start | run | stop | status | list | ping | supervise | health`);
}

// TD-45 daemon 自愈：spawn detached supervisor 进程，它轮询 daemon 心跳，判死重启（带退避）+ 空闲自退。
// 用法：daemon supervise [--run-dir DIR] [--registry FILE] [--idle-exit-ms MS]。一次 spawn 即自包含。
async function daemonSuperviseCommand(args, config) {
  const options = parseOptions(args);
  const runDir = resolve(options.runDir ?? config.runDir);
  const supervisorPath = join(dirname(fileURLToPath(import.meta.url)), "..", "daemonSupervisor.js");
  const supArgs = [
    supervisorPath,
    "--run-dir", runDir,
    "--pipe", resolveDaemonPipe(options),
    ...(options.registry ? ["--registry", options.registry ?? config.registry] : ["--registry", config.registry]),
    ...(options.idleExitMs ? ["--idle-exit-ms", String(options.idleExitMs)] : []),
  ];
  spawn(process.execPath, supArgs, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  console.log(JSON.stringify({
    ok: true, started: true, runDir,
    note: "detached supervisor owning daemon self-heal. Status: `daemon supervisor status`. Stop: SIGTERM the supervisor pid or let it idle-exit.",
  }, null, 2));
}

// supervisor 状态/控制（读 daemon-supervisor.json；stop 暂走信号，未实现 IPC）。
async function daemonSupervisorCommand(args, config) {
  const [sub, ...tail] = args;
  const options = parseOptions(tail);
  const runDir = resolve(options.runDir ?? config.runDir);
  const state = readSupervisorState(runDir);
  if (sub === "status") {
    if (!state) {
      console.log(JSON.stringify({ ok: false, running: false, note: "no supervisor running (daemon-supervisor.json absent). Start with `daemon supervise`." }, null, 2));
      return;
    }
    console.log(JSON.stringify({ ok: true, ...state }, null, 2));
    return;
  }
  if (sub === "stop") {
    if (!state) { console.log(JSON.stringify({ ok: false, note: "no supervisor running" })); return; }
    try { process.kill(state.pid, "SIGTERM"); } catch { /* 已退 */ }
    try { unlinkSync(join(runDir, "daemon-supervisor.json")); } catch { /* 已清 */ }
    console.log(JSON.stringify({ ok: true, stopped: true, pid: state.pid, note: "SIGTERM sent to supervisor（daemon 不受影响，独立存活）" }, null, 2));
    return;
  }
  throw new Error(`Unknown supervisor subcommand: ${sub ?? ""}. Try: daemon supervisor status | stop`);
}

// P5 TD-46：dump daemon 最新健康采样（daemon 周期写 daemon-health.json）。无文件→无运行/未采样。
// 读侧新鲜度：daemon 停掉后残留的旧采样不代表当前状态（宿主实机踩过：11 天前的
// worktree 残留告警，当时实际为 0）——daemon 不在跑、采样超期、采样时间戳在未来、
// 或采样早于当前 daemon 启动（上一轮残留）都整体改判 stale（staleReason 给机读原因），
// 原结论降级进 lastSample。纯阈值判定仍在 src/daemonHealth.js 不动。
const STALE_SAMPLE_AFTER_MS = 10 * 60 * 1000; // daemon 每 30s 采样一次（src/daemon.js healthIntervalMs），10 分钟无新采样即过期
// 时钟偏差容差：sampledAt 比 now 略微超前（采样与读取之间的时钟微调）仍算新鲜；
// 超前超过 60s 视为未来采样（时间戳异常），不判新鲜。
const FUTURE_SAMPLE_TOLERANCE_MS = 60 * 1000;
async function daemonHealthCommand(args, config) {
  const options = parseOptions(args);
  const runDir = resolve(options.runDir ?? config.runDir);
  const healthPath = join(runDir, "daemon-health.json");
  if (!existsSync(healthPath)) {
    console.log(JSON.stringify({ ok: false, note: "no daemon-health.json（daemon 未运行或尚未采样，30s 后首次采样）。Start: daemon start。" }, null, 2));
    return;
  }
  // 读不出 / 坏 JSON / 不是普通对象（null、数组、标量）都视为无效采样，与"文件缺失"分开提示。
  let data;
  let mtimeMs;
  try {
    data = JSON.parse(readFileSync(healthPath, "utf8"));
    mtimeMs = statSync(healthPath).mtimeMs;
  } catch {
    data = undefined;
  }
  const isPlainObject = data !== null && typeof data === "object" && !Array.isArray(data);
  if (!isPlainObject) {
    console.log(JSON.stringify({
      ok: false,
      note: "daemon-health.json 存在但不是有效的采样对象（可能正写到一半或已损坏）；daemon 在跑时每 30 s 重写，稍后再查",
    }, null, 2));
    return;
  }
  // 采样时间：优先采样自带的 sampledAt；只有"有限数字且落在 Date 可表示范围内"才采用
  // （1e20 / 8.64e15+1 这类值会让 new Date(...).toISOString() 抛 RangeError），否则退回文件 mtime。
  // 先校验后换算：命令对任何文件内容都不抛异常。
  const hasSampledAt = typeof data.sampledAt === "number"
    && Number.isFinite(data.sampledAt)
    && Number.isFinite(new Date(data.sampledAt).getTime());
  const sampledAt = hasSampledAt ? data.sampledAt : mtimeMs;
  const sampledAtSource = hasSampledAt ? "sample" : "mtime";
  const now = Date.now();
  const ageMs = now - sampledAt;
  const sampledAtIso = new Date(sampledAt).toISOString();
  const hs = readDaemonHandshake(runDir);
  const daemonRunning = isDaemonAlive(hs, now, DEFAULT_LIVENESS_THRESHOLD_MS);
  // 握手 startedAt 是有限数字时，采样必须不早于它（采样属于当前这一轮 daemon；
  // 新 daemon 已起、首次采样前，上一轮留下的采样不判新鲜）。
  const hasStartedAt = hs !== null && typeof hs === "object"
    && typeof hs.startedAt === "number" && Number.isFinite(hs.startedAt);
  const fromPreviousDaemon = hasStartedAt && sampledAt < hs.startedAt;
  const fresh = daemonRunning
    && ageMs <= STALE_SAMPLE_AFTER_MS
    && ageMs >= -FUTURE_SAMPLE_TOLERANCE_MS
    && !fromPreviousDaemon;
  if (!fresh) {
    let staleReason;
    if (!daemonRunning) staleReason = "daemon_not_running";
    else if (ageMs < -FUTURE_SAMPLE_TOLERANCE_MS) staleReason = "sample_in_future";
    else if (fromPreviousDaemon) staleReason = "sample_from_previous_daemon";
    else staleReason = "sample_too_old";
    // 分钟数一律写正数：过旧写"N 分钟前"，未来写"N 分钟后"，不出现"约 -N 分钟前"。
    const minutes = Math.round(Math.abs(ageMs) / 60000);
    const reasonNote = {
      daemon_not_running: `daemon 未运行；原结论放在 lastSample，不代表当前状态`,
      sample_in_future: `采样时间戳在未来（约 ${minutes} 分钟后），不可信；原结论放在 lastSample，不代表当前状态`,
      sample_from_previous_daemon: `采样属于上一轮 daemon（早于当前 daemon 启动）；原结论放在 lastSample，不代表当前状态`,
      sample_too_old: `这是约 ${minutes} 分钟前的旧采样（采样过旧）；原结论放在 lastSample，不代表当前状态`,
    }[staleReason];
    console.log(JSON.stringify({
      level: "stale",
      fresh: false,
      staleReason,
      daemonRunning,
      sampledAtIso,
      ageMs,
      sampledAtSource,
      note: reasonNote,
      lastSample: data,
    }, null, 2));
    return;
  }
  console.log(JSON.stringify({ ...data, fresh: true, daemonRunning, sampledAtIso, ageMs, sampledAtSource }, null, 2));
}

function resolveDaemonPipe(options) {
  return options.pipe ?? DEFAULT_PIPE;
}

export async function daemonStartCommand(args, config) {
  const options = parseOptions(args);
  const runDir = resolve(options.runDir ?? config.runDir);
  const pipe = resolveDaemonPipe(options);
  // 幂等：若已有活 daemon，不重复起（避 pipe EADDRINUSE）。
  const hs = readDaemonHandshake(runDir);
  if (hs && isDaemonAlive(hs, Date.now(), DEFAULT_LIVENESS_THRESHOLD_MS)) {
    console.log(JSON.stringify({ ok: true, alreadyRunning: true, pid: hs.pid, pipe }, null, 2));
    return;
  }
  const daemonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "daemon.js");
  const registry = options.registry ?? config.registry;
  // M10-pre3 final gate (F1): validate explicit waitTimeout BEFORE spawn. The
  // detached child validates too (defense in depth), but the CLI must not print
  // {started:true} and return success for an invalid timeout that will kill the
  // child moments later. Both CLI options.waitTimeout and config.waitTimeout are
  // range-checked via the SSOT (1000..600000). Omitted/null → disabled (no flag).
  // This rejects empty/whitespace/NaN/fractional/below-min/above-max.
  const cliWaitTimeout = options.waitTimeout;
  const cfgWaitTimeout = config.waitTimeout;
  // Distinguish truly omitted (undefined/null) from present-but-invalid.
  // Omitted → disabled (no flag, no error). Present in any form (even empty/
  // whitespace/garbage) → MUST validate and reject if invalid; never silently
  // treat a malformed value as omitted (that would print success then kill the
  // child).
  let validatedWaitTimeout = null;
  const cliPresent = cliWaitTimeout !== undefined && cliWaitTimeout !== null;
  const cfgPresent = cfgWaitTimeout !== undefined && cfgWaitTimeout !== null;
  if (cliPresent) {
    // A present CLI value is always validated (even if it's "" / "  " / "abc");
    // Number("") and Number("  ") are 0 → below min → rejected by the SSOT.
    validatedWaitTimeout = validateBoundedWaitTimeout(Number(cliWaitTimeout));
  } else if (cfgPresent) {
    validatedWaitTimeout = validateBoundedWaitTimeout(Number(cfgWaitTimeout));
  }
  const daemonArgs = [
    daemonPath,
    "--run-dir", runDir,
    "--registry", registry,
    "--pipe", pipe,
    ...(validatedWaitTimeout !== null
      ? ["--wait-timeout", String(validatedWaitTimeout)]
      : []),
    "--poll-interval", String(options.pollInterval ?? config.pollInterval ?? 1000),
    ...(options.resumeOnStart ? ["--resume-on-start", "true"] : []),
  ];
  // detached + stdio ignore + windowsHide：daemon 脱离 CLI 进程组，CLI 退出不杀它，不弹窗。
  resolveSpawn()(process.execPath, daemonArgs, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  console.log(JSON.stringify({
    ok: true, started: true, pipe,
    runDir,
    note: "detached daemon owning worker lifecycle. Health: `daemon ping`/`daemon status`; per-run settlement: `wao runs wait <runId> --until-settled`.",
  }, null, 2));
}

// D-F1 修复（dogfood research/14）：daemon run = 通过 daemon 派发 worker。
// daemon 的 start IPC handler 一直存在，但之前无 CLI 入口——agent 起 daemon 后够不到派发能力。
// 本命令经命名管道发 {cmd:"start"}，run 由 daemon 持有 → 出现在 `daemon list`（统一视图，解 D-F2）。
// 与 `run --background` 的区别：那个 fork 独立 runner（不经 daemon），daemon list 看不到。
async function daemonRunCommand(args, config) {
  const [agentId, ...tail] = args;
  if (!agentId) throw new Error("daemon run requires <agentId>");
  const options = parseOptions(tail);
  const runDir = resolve(options.runDir ?? config.runDir);
  const pipe = resolveDaemonPipe(options);
  const hs = readDaemonHandshake(runDir);
  if (!hs || !isDaemonAlive(hs, Date.now(), DEFAULT_LIVENESS_THRESHOLD_MS)) {
    console.log(JSON.stringify({ ok: false, running: false, note: "daemon not running. Start with `daemon start`." }, null, 2));
    process.exitCode = 1;
    return;
  }
  const prompt = await loadPrompt(options);
  try {
    const res = await connectDaemon(pipe, { cmd: "start", agentId, prompt }, { timeoutMs: Number(options.timeout ?? 10000) });
    const transcript = resolveTranscriptPath(runDir, res.runId);
    console.log(JSON.stringify({
      ok: true, runId: res.runId, transcript, ownedBy: "daemon",
      note: "run owned by daemon. Health: `daemon list`/`daemon status`; wait to settlement: `wao runs wait <runId> --until-settled`.",
    }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
    process.exitCode = 1;
  }
}

async function daemonPingCommand(args, config) {
  const options = parseOptions(args);
  const runDir = resolve(options.runDir ?? config.runDir);
  const pipe = resolveDaemonPipe(options);
  const hs = readDaemonHandshake(runDir);
  if (!hs || !isDaemonAlive(hs, Date.now(), DEFAULT_LIVENESS_THRESHOLD_MS)) {
    console.log(JSON.stringify({ ok: false, running: false, note: "daemon not running. Start with `daemon start`." }, null, 2));
    process.exitCode = 1;
    return;
  }
  try {
    const res = await connectDaemon(pipe, { cmd: "ping" }, { timeoutMs: Number(options.timeout ?? 5000) });
    console.log(JSON.stringify(res, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, running: false, error: e.message }, null, 2));
    process.exitCode = 1;
  }
}

async function daemonStopCommand(args, config) {
  const options = parseOptions(args);
  const runDir = resolve(options.runDir ?? config.runDir);
  const pipe = resolveDaemonPipe(options);
  const hs = readDaemonHandshake(runDir);
  if (!hs || !isDaemonAlive(hs, Date.now(), DEFAULT_LIVENESS_THRESHOLD_MS)) {
    console.log(JSON.stringify({ ok: false, running: false, note: "daemon not running." }, null, 2));
    return;
  }
  // daemon 级优雅退出：发 shutdown IPC，daemon 自行 daemon.stop() + exit（删 handshake）。
  // 优雅优于 taskkill /F（强杀会跳过 stop()，handshake 残留 + 可能留 worker 子进程）。
  try {
    await connectDaemon(pipe, { cmd: "shutdown" }, { timeoutMs: Number(options.timeout ?? 5000) });
  } catch { /* daemon 退出会断连接，正常 */ }
  // 轮询 handshake 消失（daemon.stop() 异步删）。
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && readDaemonHandshake(runDir)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  let stillThere = readDaemonHandshake(runDir);
  // 兜底：handshake 仍在 → taskkill /T /F 强清（防止 detached 进程僵尸化，06-18 教训）。
  if (stillThere && hs.pid) {
    try {
      spawnSync("taskkill", ["/pid", String(hs.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch { /* 尽力 */ }
    await new Promise((r) => setTimeout(r, 300));
    stillThere = readDaemonHandshake(runDir);
    if (!stillThere) { try { unlinkSync(join(runDir, DAEMON_HANDSHAKE_FILE)); } catch { /* */ } }
  }
  console.log(JSON.stringify({ ok: !stillThere, stopped: !stillThere, pid: hs.pid, pipe }, null, 2));
  if (stillThere) process.exitCode = 1;
}

async function daemonStatusCommand(args, config) {
  const options = parseOptions(args);
  const runDir = resolve(options.runDir ?? config.runDir);
  const pipe = resolveDaemonPipe(options);
  const positional = args.filter((a) => !a.startsWith("--"));
  const runId = options.runId ?? positional[0];
  if (!runId) {
    // F-④（2026-10-10 摩擦处置批）：`daemon status` 查的是单个 run 的守护状态，
    // 与直觉的"守护进程自身状态"不符（那是 ping/list）——报错里直接讲清两者。
    console.log(JSON.stringify({
      ok: false,
      error: "status requires --run-id <id>",
      hint: "daemon status 按 runId 查单个 run 的守护状态；守护进程自身健康/清单用 `daemon ping` / `daemon list`",
    }, null, 2));
    process.exitCode = 1;
    return;
  }
  try {
    const res = await connectDaemon(pipe, { cmd: "status", runId }, { timeoutMs: Number(options.timeout ?? 5000) });
    console.log(JSON.stringify(res, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
    process.exitCode = 1;
  }
}

async function daemonListCommand(args, config) {
  const options = parseOptions(args);
  const runDir = resolve(options.runDir ?? config.runDir);
  const pipe = resolveDaemonPipe(options);
  const hs = readDaemonHandshake(runDir);
  if (!hs || !isDaemonAlive(hs, Date.now(), DEFAULT_LIVENESS_THRESHOLD_MS)) {
    console.log(JSON.stringify({ ok: false, running: false, note: "daemon not running." }, null, 2));
    process.exitCode = 1;
    return;
  }
  try {
    const res = await connectDaemon(pipe, { cmd: "list" }, { timeoutMs: Number(options.timeout ?? 5000) });
    console.log(JSON.stringify(res, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
    process.exitCode = 1;
  }
}

// Test-only hook: override the spawn implementation to observe spawn count/args
// without detaching a real daemon child. Pass null to restore production spawn.
export { _spawnForTest as _setSpawnForTest };
