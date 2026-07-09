// src/commands/daemon.js
//
// TD-98 阶段 1：daemon 命令族从 cli.js 拆出（行为不变，纯搬迁）。
//
// 依赖：
//   - 外部模块：./daemon.js（connectDaemon/readDaemonHandshake/isDaemonAlive/...）、
//     ./daemonSupervisor.js（readSupervisorState）
//   - 共享工具：./shared.js（parseOptions/loadPrompt，纯函数/低风险 I/O）
//   - node built-in：child_process（spawn/spawnSync）、fs（readFileSync/unlinkSync/existsSync）、
//     path（join/resolve/dirname）、url（fileURLToPath）
//
// daemon 族零跨 family 共享——resolveDaemonPipe 只被 daemon 用，自包含。

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
async function daemonHealthCommand(args, config) {
  const options = parseOptions(args);
  const runDir = resolve(options.runDir ?? config.runDir);
  const healthPath = join(runDir, "daemon-health.json");
  try {
    const data = JSON.parse(readFileSync(healthPath, "utf8"));
    console.log(JSON.stringify(data, null, 2));
  } catch {
    console.log(JSON.stringify({ ok: false, note: "no daemon-health.json（daemon 未运行或尚未采样，30s 后首次采样）。Start: daemon start。" }, null, 2));
  }
}

function resolveDaemonPipe(options) {
  return options.pipe ?? DEFAULT_PIPE;
}

async function daemonStartCommand(args, config) {
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
  const daemonArgs = [
    daemonPath,
    "--run-dir", runDir,
    "--registry", registry,
    "--pipe", pipe,
    "--wait-timeout", String(options.waitTimeout ?? config.waitTimeout ?? 120000),
    "--poll-interval", String(options.pollInterval ?? config.pollInterval ?? 1000),
    ...(options.resumeOnStart ? ["--resume-on-start", "true"] : []),
  ];
  // detached + stdio ignore + windowsHide：daemon 脱离 CLI 进程组，CLI 退出不杀它，不弹窗。
  spawn(process.execPath, daemonArgs, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  console.log(JSON.stringify({
    ok: true, started: true, pipe,
    runDir,
    note: "detached daemon owning worker lifecycle. Poll with `daemon ping`/`daemon status`.",
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
    const transcript = join(runDir, `${res.runId}.jsonl`);
    console.log(JSON.stringify({
      ok: true, runId: res.runId, transcript, ownedBy: "daemon",
      note: "run owned by daemon. Poll with `daemon list`/`daemon status`/`tail`.",
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
    console.log(JSON.stringify({ ok: false, error: "status requires --run-id <id>" }, null, 2));
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
