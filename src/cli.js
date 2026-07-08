#!/usr/bin/env node
import { readFile, readdir, unlink, mkdir } from "node:fs/promises";
import { existsSync, watchFile, unwatchFile, unlinkSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { readRegistry, normalizeAgent } from "./registry.js";
import { findLatest, findState, findLastEventSeq, JsonlTranscript, readTranscript } from "./transcript.js";
import { RunManager } from "./runManager.js";
import { OpenCodeServeBackend } from "./backends/opencodeServe.js";
import { ClaudeCodeBackend } from "./backends/claudeCode.js";
import { CodexBackend } from "./backends/codex.js";
import { KimiCodeBackend } from "./backends/kimiCode.js";
import { executeStopWithVerification } from "./backends/opencodeStopVerify.js";
import { raiseAlert } from "./alerts.js";
import { listWorktrees, removeWorktree } from "./isolation.js";
import { initWaoDir, validateWaoDir, getWaoDir } from "./waoDir.js";
import { writeStateSnapshot, readCurrentState } from "./waoState.js";
import { addDecision, listDecisions, readDecision } from "./waoDecisions.js";
import { addDeclare, listDeclares, summarizeDeclares, REASON_CODES } from "./waoDeclare.js";
import { addStage, listStages, summarizeStages, STAGE_NUMBERS } from "./waoStage.js";
import { writeHandoff, readHandoff } from "./waoHandoff.js";
import {
  connectDaemon,
  readHandshake as readDaemonHandshake,
  isDaemonAlive,
  HANDSHAKE_FILE as DAEMON_HANDSHAKE_FILE,
  DEFAULT_PIPE,
  DEFAULT_LIVENESS_THRESHOLD_MS,
} from "./daemon.js";
import { aggregateRunMetrics, aggregateSummary, formatDuration } from "./metrics.js";
import { diagnoseFailure } from "./diagnosis.js";
import { forecastCost } from "./costForecast.js";
import { loadWorkflow, applyTemplate } from "./workflow/loader.js";
import { WorkflowEngine } from "./workflow/engine.js";
import { renderRunSummary } from "./cliRunSummary.js";
import { checkNodeVersion } from "./nodeVersionGuard.js";
import { readSupervisorState } from "./daemonSupervisor.js";

const hardcodedDefaults = {
  registry: "config/agents.json",
  runDir: "runs",
  pollInterval: 5000,
  waitTimeout: 300000,
  timeout: 30000,
  retries: 2,
  defaultIsolation: "none",
  worktreeDir: null,
  portRange: [30000, 31000],
  stateDir: ".wao",
};

async function loadConfig() {
  const configPath = resolve("config/default.json");
  if (!existsSync(configPath)) return { ...hardcodedDefaults };
  try {
    const raw = await readFile(configPath, "utf8");
    return { ...hardcodedDefaults, ...JSON.parse(raw) };
  } catch {
    return { ...hardcodedDefaults };
  }
}

let configCache = null;
async function getConfig() {
  if (!configCache) configCache = await loadConfig();
  return configCache;
}

function newRunManager(config) {
  return new RunManager({
    config,
    // 测试钩子：允许 config 注入 mock readRegistry / backendFor（生产路径不传，用模块默认）。
    readRegistry: config.readRegistry ?? readRegistry,
    transcriptDir: config.runDir,
    backendFor: config.backendFor ?? backendFor,
  });
}

/** 解析 --isolate / --no-isolate flag → true | false | undefined(不覆盖配置) */
function resolveIsolateFlag(options) {
  if (options.isolate === true) return true;
  if (options.noIsolate === true) return false;
  return undefined;
}

// daemon 命令族：start/stop/status/ping/list。常驻 daemon（P3-T1，ADR 0012 命名管道 IPC）。
// start: fork detached node src/daemon.js；ping/status/list/stop: 经 IPC 连 daemon。
async function daemonCommand(args, config) {
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
  const supervisorPath = join(dirname(fileURLToPath(import.meta.url)), "daemonSupervisor.js");
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
  const daemonPath = join(dirname(fileURLToPath(import.meta.url)), "daemon.js");
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

async function main(argv) {
  // TD-40：启动校验 Node 版本——守住 v22 的内置 Windows Job Object 进程隔离。
  // help 例外（用户始终能查帮助），其余命令在 v24/v23/过低版本上拒绝并指引 v22。
  // WAO_SKIP_VERSION_GUARD=1 绕过（仅测试用：测试在任意 Node 上跑，不依赖真实进程隔离）。
  const [firstArg] = argv;
  const isHelp = !firstArg || firstArg === "help" || firstArg === "--help" || firstArg === "-h";
  if (!isHelp && process.env.WAO_SKIP_VERSION_GUARD !== "1") {
    const guard = checkNodeVersion(process.version);
    if (!guard.ok) {
      console.error(`WAO 拒绝启动：${guard.reason}`);
      console.error("（进程隔离依赖 Node v22 的内置 Job Object；详见 docs/02-architecture.md §4.3 + ADR 0013）");
      process.exitCode = 1;
      return;
    }
  }
  const config = await getConfig();
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "registry") {
    await registryCommand(rest, config);
    return;
  }
  if (command === "spawn") {
    await spawnCommand(rest, config);
    return;
  }
  if (command === "retry") {
    await retryCommand(rest, config);
    return;
  }
  if (command === "resume") {
    await resumeCommand(rest, config);
    return;
  }
  if (command === "run") {
    await runCommand(rest, config);
    return;
  }
  if (command === "status") {
    await statusCommand(rest, config);
    return;
  }
  if (command === "tail") {
    await tailCommand(rest, config);
    return;
  }
  if (command === "collect") {
    await collectCommand(rest, config);
    return;
  }
  if (command === "stop") {
    await stopCommand(rest, config);
    return;
  }
  if (command === "runs") {
    await runsCommand(rest, config);
    return;
  }
  if (command === "workflow") {
    await workflowCommand(rest, config);
    return;
  }
  if (command === "worktree") {
    await worktreeCommand(rest, config);
    return;
  }
  if (command === "wao") {
    await waoCommand(rest, config);
    return;
  }
  if (command === "daemon") {
    await daemonCommand(rest, config);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

async function registryCommand(args, config) {
  const [sub, ...tail] = args;
  if (sub === "check") {
    await registryCheckCommand(tail, config);
    return;
  }
  if (sub === "validate") {
    await registryValidateCommand(tail, config);
    return;
  }
  const options = parseOptions(args);
  const registry = await readRegistry(resolve(options.registry ?? config.registry));
  // N1 修复：合并认证状态列。读 runDir/reliability-summary.json.workers[id].status，
  // 让 lead 一眼看清 worker 列表 + 认证状态（原要跑两命令脑内 join）。summary 缺则显示 -。
  const runDir = resolve(options.runDir ?? config.runDir);
  let certMap = {};
  try {
    const summary = JSON.parse(await readFile(join(runDir, "reliability-summary.json"), "utf8"));
    for (const [id, w] of Object.entries(summary?.workers ?? {})) {
      certMap[id] = w.status ?? "-";
    }
  } catch {
    // 无 summary 或解析失败 = 未认证，全显示 -
  }
  // F5: model 列，让 lead 选型时有模型信息。
  // F17: --format json 输出机器可读 JSON（dogfood round 4 实证：原接受参数但静默忽略）。
  const agents = registry.listAgents().map((agent) => ({
    id: agent.id,
    backend: agent.backend,
    model: displayModel(agent),
    certification: certMap[agent.id] ?? null,
    cwd: agent.cwd,
  }));
  if (options.format === "json") {
    console.log(JSON.stringify(agents, null, 2));
    return;
  }
  for (const agent of agents) {
    console.log(`${agent.id}\t${agent.backend}\t${agent.model}\t${agent.certification ?? "-"}\t${agent.cwd}`);
  }
}

async function retryCommand(args, config) {
  const [runId, ...tail] = args;
  if (!runId) {
    throw new Error("retry requires <runId>");
  }
  const options = parseOptions(tail);
  const { events } = await loadRun(runId, options, config);
  const agentId = events[0]?.agentId;
  if (!agentId) {
    throw new Error(`Run ${runId} has no agentId`);
  }
  const promptEvent = findLatest(events, "prompt.sent");
  if (!promptEvent?.prompt) {
    throw new Error(`Run ${runId} has no stored prompt (runs before v0.0.2 may not store prompts)`);
  }
  const manager = newRunManager(config);
  const run = await manager.start(agentId, {
    prompt: promptEvent.prompt,
    registry: options.registry,
    runDir: options.runDir,
    tags: options.tag,
    cwd: options.cwd,
    isolate: resolveIsolateFlag(options),
  });
  console.log(JSON.stringify({ originalRunId: runId, newRunId: run.transcript.context.runId, transcript: run.transcript.filePath, ...run.result }, null, 2));
  if (options.wait) {
    const waitResult = await run.waitForCompletion(options);
    console.log(JSON.stringify({ completed: waitResult.completed }, null, 2));
  }
}

async function resumeCommand(args, config) {
  const [runId, ...tail] = args;
  if (!runId) {
    throw new Error("resume requires <runId>");
  }
  const options = parseOptions(tail);
  const manager = newRunManager(config);
  const run = await manager.resume(runId, { runDir: options.runDir, registry: options.registry });
  if (!run) {
    console.log(JSON.stringify({ runId, resumed: false, reason: "terminal or not found" }));
    return;
  }
  console.log(JSON.stringify({ runId, resumed: true, state: run.state, sessionId: run.result?.backendSessionId }));
  if (options.wait) {
    const waitResult = await run.waitForCompletion(options);
    console.log(JSON.stringify({ runId, completed: waitResult.completed }));
  }
}

async function registryCheckCommand(args, config) {
  const options = parseOptions(args);
  const registry = await readRegistry(resolve(options.registry ?? config.registry));
  const agents = registry.listAgents();
  if (agents.length === 0) {
    console.log("No agents in registry.");
    return;
  }
  let allOk = true;
  for (const agent of agents) {
    if (agent.backend === "opencode-serve") {
      const backend = new OpenCodeServeBackend({ timeout: 5000, retries: 0 });
      const result = await backend.healthCheck(agent.serveUrl);
      if (result.ok) {
        console.log(`${agent.id}\tok\t${agent.serveUrl}`);
      } else {
        console.log(`${agent.id}\tFAIL\t${agent.serveUrl}\t${result.error ?? `HTTP ${result.status}`}`);
        allOk = false;
      }
    } else {
      console.log(`${agent.id}\tSKIP\tunknown backend: ${agent.backend}`);
    }
  }
  if (!allOk) {
    process.exitCode = 1;
  }
}

/**
 * registry validate（M6 worker 配置）：
 * 配置完整性检查（不连服务，纯静态校验）。
 *
 * 检查三层：
 *   1. JSON 可解析
 *   2. 每个 agent 字段齐全（复用 normalizeAgent）
 *   3. scorecard rules 形状正确（如有配置）
 */
async function registryValidateCommand(args, config) {
  const options = parseOptions(args);
  const registryPath = resolve(options.registry ?? config.registry);
  const raw = await readFile(registryPath, "utf8");

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.log(`✖ JSON parse error: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  const agents = parsed.agents ?? {};
  const ids = Object.keys(agents);
  if (ids.length === 0) {
    console.log("⚠  No agents in registry.");
    return;
  }

  const KNOWN_BACKENDS = ["opencode-serve", "claude-code", "codex", "kimi-code"];
  let allOk = true;
  let checked = 0;

  for (const id of ids) {
    const agent = agents[id];
    const issues = [];

    // 1. backend 必填且合法
    if (!agent.backend) {
      issues.push("missing backend");
    } else if (!KNOWN_BACKENDS.includes(agent.backend)) {
      issues.push(`unknown backend "${agent.backend}" (known: ${KNOWN_BACKENDS.join("/")})`);
    }

    // 2. cwd 必填
    if (!agent.cwd) {
      issues.push("missing cwd");
    }

    // 3. opencode-serve 专属字段
    if (agent.backend === "opencode-serve") {
      if (!agent.serveUrl) issues.push("missing serveUrl");
      if (!agent.agent) issues.push('missing agent (e.g. "build")');
      if (!agent.model) {
        issues.push("missing model");
      } else {
        if (!agent.model.providerID) issues.push("missing model.providerID");
        if (!agent.model.id) issues.push("missing model.id");
      }
      // C3（审计 P0）：opencode worker 必须配 tokenBudget（06-18 事故防线，硬门）。
      // 未配 → registry validate 报错，阻止派发（stop 虚假成功 + 无预算上限 = 06-18 复现）。
      if (typeof agent.tokenBudget !== "number") {
        issues.push("missing tokenBudget (opencode worker 必须配，06-18 事故防线；进程式 worker 可不配)");
      }
    }

    // 4. scorecard rules 形状（如有）
    if (agent.scorecard) {
      const rules = agent.scorecard.rules ?? {};
      if (rules.requireCommands !== undefined && !Array.isArray(rules.requireCommands)) {
        issues.push("scorecard.rules.requireCommands must be an array");
      }
      if (rules.requireFiles !== undefined && !Array.isArray(rules.requireFiles)) {
        issues.push("scorecard.rules.requireFiles must be an array");
      }
      if (rules.requireEvidence !== undefined && typeof rules.requireEvidence !== "boolean") {
        issues.push("scorecard.rules.requireEvidence must be boolean");
      }
    }

    // 5. args 形状（如有）
    if (agent.args !== undefined && !Array.isArray(agent.args)) {
      issues.push("args must be an array");
    }

    if (agent.prependArgs !== undefined && !Array.isArray(agent.prependArgs)) {
      issues.push("prependArgs must be an array");
    }

    // TD-79：env 字段形状校验（worker 声明的子进程 env 注入，如 PIP_REQUIRE_VIRTUALENV）。
    // 必须是 {string:string} 对象——key/value 都得是 string（spawn env 契约）。
    if (agent.env !== undefined) {
      if (typeof agent.env !== "object" || agent.env === null || Array.isArray(agent.env)) {
        issues.push("env must be an object");
      } else {
        for (const [k, v] of Object.entries(agent.env)) {
          if (typeof v !== "string") {
            issues.push(`env.${k} value must be a string`);
          }
        }
      }
    }

    // 6. 跑一遍 normalizeAgent 做最终校验（它会 throw 如果有硬错误）
    try {
      normalizeAgent(id, agent);
    } catch (e) {
      issues.push(e.message);
    }

    checked += 1;
    if (issues.length === 0) {
      const model = agent.model ? `${agent.model.id}` : (agent.backend === "claude-code" ? "claude" : "default");
      console.log(`✔ ${id}\t${agent.backend}\t${model}`);
      // TD-87（kimi tokenBudget 静默无效陷阱）：kimi stream-json 无 usage 字段，
      // 配 tokenBudget 不报错但不生效。warn 提示用户别误以为有保护（dogfood round 2 发现）。
      if (agent.backend === "kimi-code" && typeof agent.tokenBudget === "number") {
        console.log(`  ⚠ ${id}: kimi-code 配了 tokenBudget 但不生效（stream-json 无 usage 字段）—— kimi 靠自带 max_steps/timeout 兜底，不靠 WAO tokenBudget`);
      }
      // TD-89（systemPrompt 静默失效）：agent.systemPrompt 只有 claude-code backend 消费
      // （claudeCode.js:35-40 用 --append-system-prompt-file 注入）。kimi-code/codex 的
      // buildArgs 完全不引用该字段——写了角色契约路径但被忽略，角色边界（身份/纪律）不进 worker。
      // dogfood round 5 发现：6 agent 全声明 systemPrompt，但 coder_mm(tester)/tester(codex) 死配。
      if (agent.systemPrompt && agent.backend !== "claude-code") {
        console.log(`  ⚠ ${id}: ${agent.backend} 不消费 systemPrompt（只有 claude-code 用 --append-system-prompt-file 注入）—— 角色契约 ${agent.systemPrompt} 未生效，角色边界需在 task prompt 里手写兜底`);
      }
    } else {
      console.log(`✖ ${id}\t${issues.join("; ")}`);
      allOk = false;
    }
  }

  console.log(`\n${checked} agent(s) checked, ${allOk ? "all valid" : "has errors"}`);
  if (!allOk) process.exitCode = 1;
}

async function spawnCommand(args, config) {
  const { agents, options } = parseAgentList(args);
  const manager = newRunManager(config);
  // P2（M7）：单 agent spawn 不带 --wait = 后台托管（detached runner）。
  // 替代旧 TD-39 "拒绝裸 spawn"——现在不拒，而是托管：runner 拥有 handle 驱动 wait+gate+abort，
  // 不再产生孤儿会话（06-18 事故架构洞的正解）。多 agent spawn 仍要求 --wait（并行 background 留 P3 daemon）。
  if (agents.length === 1 && !options.wait) {
    options.prompt = await loadPrompt(options);
    await loadScorecardRules(options);
    return spawnBackgroundRunner(agents[0], options, config);
  }
  await loadScorecardRules(options);
  if (agents.length === 1) {
    const run = await manager.start(agents[0], {
      prompt: await loadPrompt(options),
      registry: options.registry,
      runDir: options.runDir,
      tags: options.tag,
      cwd: options.cwd,
      isolate: resolveIsolateFlag(options),
      ...(options.scorecardRules ? { scorecard: { rules: parseScorecardRules(options.scorecardRules, options.scorecardRulesSource) } } : {}),
      // P0-1 护栏：不带 --wait = fire-and-forget。遇 sessionOutlivesProcess 的 backend 会被
      // RunManager.start 拒绝（06-18 事故防线）。带 --wait 时 fireAndForget=false，护栏放行。
      fireAndForget: !options.wait,
    });
    console.log(JSON.stringify({ runId: run.transcript.context.runId, transcript: run.transcript.filePath, ...run.result }, null, 2));
    if (options.wait) {
      const waitResult = await runAndWait(run, options);
      console.log(JSON.stringify(waitResult, null, 2));
    }
    return;
  }
  const spawned = await Promise.all(agents.map((id) =>
    manager.start(id, {
      prompt: options.prompt,
      registry: options.registry,
      runDir: options.runDir,
      tags: options.tag,
      cwd: options.cwd,
      isolate: resolveIsolateFlag(options),
      ...(options.scorecardRules ? { scorecard: { rules: parseScorecardRules(options.scorecardRules, options.scorecardRulesSource) } } : {}),
      fireAndForget: !options.wait, // P0-1 护栏（同单 agent 路径）
    }),
  ));
  for (const run of spawned) {
    console.log(JSON.stringify({ runId: run.transcript.context.runId, transcript: run.transcript.filePath, ...run.result }, null, 2));
  }
  if (options.wait) {
    const results = await Promise.all(spawned.map((run) =>
      runAndWait(run, options).then((w) => ({ run, ...w })),
    ));
    console.log("--- parallel wait complete ---");
    for (const r of results) {
      const status = r.failed ? "failed" : (r.completed ? "completed" : "timed out");
      const detail = r.failed ? ` (${r.error})` : "";
      console.log(`${r.run.transcript.context.runId}: ${status}${detail}`);
    }
  }
}

// P2（M7）：fork detached runner 托管一个 background run。
// CLI 预生成 runId（与 RunManager 同款格式），fork node backgroundRunner.js 传过去，
// detached + unref → CLI 进程退出后 runner 独立存活到 run 结束。立即返回 runId。
async function spawnBackgroundRunner(agentId, options, config) {
  if (options.scorecardRules) {
    parseScorecardRules(options.scorecardRules, options.scorecardRulesSource);
  }
  const runnerPath = join(dirname(fileURLToPath(import.meta.url)), "backgroundRunner.js");
  const runId = options.runId ?? `run_${new Date().toISOString().replace(/[-:.TZ]/g, "")}${Math.random().toString(36).slice(2, 8)}`;
  const runDir = resolve(options.runDir ?? config.runDir);
  const transcriptPath = join(runDir, `${runId}.jsonl`);
  const transcript = new JsonlTranscript(transcriptPath, { runId, agentId });
  await transcript.append("run.background_submitted", {
    background: true,
    cwd: options.cwd,
    scorecardConfigured: Boolean(options.scorecardRules),
  });
  await transcript.append("run.state_change", { from: null, to: "pending", reason: "background_spawned" });
  const runnerArgs = [
    runnerPath, agentId,
    "--prompt", options.prompt ?? "",
    "--run-dir", runDir,
    "--run-id", runId,
    "--wait-timeout", String(options.waitTimeout ?? config.waitTimeout ?? 120000),
    "--poll-interval", String(options.pollInterval ?? config.pollInterval ?? 1000),
  ];
  runnerArgs.push("--registry", options.registry ?? config.registry);
  if (options.cwd) runnerArgs.push("--cwd", options.cwd);
  if (options.scorecardRules) runnerArgs.push("--scorecard-rules", options.scorecardRules);
  // M8-1：把 --scorecard-mode 透传给 background runner（默认 warn；hard/off 由 Lead 显式传）。
  if (options.scorecardMode) runnerArgs.push("--scorecard-mode", options.scorecardMode);
  // detached: runner 脱离 CLI 进程组，CLI 退出不杀它；stdio ignore（runner 自写 transcript）。
  spawn(process.execPath, runnerArgs, { detached: true, stdio: "ignore" }).unref();
  console.log(JSON.stringify({
    runId,
    transcript: transcriptPath,
    background: true,
    note: "detached runner owns lifecycle (token gate / abort / state). Poll with `status`/`tail`.",
  }, null, 2));
}

// P4 决策A：从 transcript 取已落盘的 scorecard.checked 事件（runManager 无论通过/失败
// 都 append）。无 scorecard（run 没配规则）→ null，renderRunSummary 不输出 scorecard 段。
async function loadScorecardFromTranscript(transcriptPath) {
  try {
    const events = await readTranscript(transcriptPath);
    const sc = events.find((e) => e.type === "scorecard.checked");
    return sc ? { passed: sc.passed, checks: sc.checks } : null;
  } catch {
    return null; // transcript 读失败不阻断 header 渲染
  }
}

export async function runCommand(args, config) {
  const [agentId, ...tail] = args;
  if (!agentId) {
    throw new Error("run requires <agentId>");
  }
  const options = parseOptions(tail);
  // P2（M7）：--background = detached runner 托管。CLI 预生成 runId、fork runner、立即返回。
  // runner 拥有 worker handle，驱动 waitForCompletion（含 token 闸门/超时/兜底 abort），
  // 写共享 transcript。这是 06-18 事故架构洞的正解——把"拒绝裸 spawn"换"托管生命周期"。
  if (options.background) {
    options.prompt = await loadPrompt(options);
    await loadScorecardRules(options);
    return spawnBackgroundRunner(agentId, options, config);
  }
  options.wait = true;
  await loadScorecardRules(options);
  const manager = newRunManager(config);
  const run = await manager.start(agentId, {
    prompt: await loadPrompt(options),
    registry: options.registry,
    runDir: options.runDir,
    tags: options.tag,
    cwd: options.cwd,
    isolate: resolveIsolateFlag(options),
    requireCertified: Boolean(options.requireCertified),
    // M8-1：默认 scorecard 模式。warn(默认)=开启留痕不阻塞 | hard=升级硬闸 | off=完全关闭。
    ...(options.scorecardMode ? { scorecardMode: options.scorecardMode } : {}),
    ...(options.scorecardRules ? { scorecard: { rules: parseScorecardRules(options.scorecardRules, options.scorecardRulesSource) } } : {}),
  });
  const format = options.format ?? "text";
  const waitResult = await runAndWait(run, options);
  // P4 决策A：scorecard 从 transcript 的 scorecard.checked 事件取（runManager 无论通过/失败都落盘）。
  // TD-53 修复：注入前置于格式分支之前——原 json 分支 early-return 在注入之前，丢字段。
  // 现 json 与 text 两路都带 scorecard（renderRunSummary 读 waitResult.scorecard，行为不变）。
  const scorecard = await loadScorecardFromTranscript(run.transcript.filePath);
  if (scorecard) waitResult.scorecard = scorecard;
  if (format === "json") {
    console.log(JSON.stringify(waitResult, null, 2));
    return;
  }
  console.log(renderRunSummary(waitResult, { agentId }));
  // 失败时 header 已含 error，不再 dump assistant 文本。
  if (waitResult.failed) return;
  // 成功：header 之下打印 worker 的 assistant 文本（保留既有产出可见性）。
  if (waitResult.messages) {
    for (const msg of waitResult.messages) {
      if (msg.info?.role === "assistant" && msg.parts) {
        for (const part of msg.parts) {
          if (part.type === "text" && part.text) {
            console.log(part.text);
          }
        }
      }
    }
  }
}

export async function statusCommand(args, config) {
  const [runId, ...tail] = args;
  const { events } = await loadRun(runId, parseOptions(tail), config);
  const last = events.at(-1);
  const state = findState(events);
  // TD-75 worker 心跳：lastActivityTs = 最后一条 run.event 的 ts。
  // appendFile 每 event flush（transcript.js），故这是实时的"生命体征"——
  // Lead 据此判 worker 活性：< 120s 还活着别动（守"宁慢勿杀"）；≥120s 才是掉链子信号。
  // 只算 run.event（thinking/text/tool_use/tool_result/command/file_written），不计
  // state_change/error/metrics 等编排事件——心跳要反映"worker 在产出"。
  // 无 run.event（纯启动失败）→ null。终态 run 也输出（Lead 看死前是否还在跳）。
  //
  // TD-75 补全：同一条事件还带 kind（message/command/tool_use/tool_result/file_written），
  // 映射成 lastActivityKind（人类可读活动类型）+ lastActivitySummary（带具体内容，如命令名/
  // 工具名/文件名）。让 Lead 从"47s 前还活着"升级到"47s 前在跑 npm test"——掌握 worker 在干啥，
  // 减少因"不知道在干啥"而误判停（守"宁慢勿杀"）。
  const lastActivity = [...events].reverse().find((e) => e.type === "run.event");
  const lastActivityTs = lastActivity?.ts ?? null;
  const secondsSinceActivity = lastActivityTs
    ? Math.round((Date.now() - new Date(lastActivityTs).getTime()) / 1000)
    : null;
  const { lastActivityKind, lastActivitySummary } = describeActivity(lastActivity);
  console.log(JSON.stringify({ runId, state, last, lastActivityTs, secondsSinceActivity, lastActivityKind, lastActivitySummary }, null, 2));
}

/**
 * TD-75 补全：把最后一条 run.event 映射成 Lead 可读的活动类型 + 摘要。
 * 只给"在干啥"的人类可读描述，不泄露完整内容（summary 截断/取关键标识，防 token 膨胀）。
 * @param {Object} ev - 最后一条 run.event（可为 null）
 * @returns {{lastActivityKind: string|null, lastActivitySummary: string|null}}
 */
function describeActivity(ev) {
  if (!ev) return { lastActivityKind: null, lastActivitySummary: null };
  switch (ev.kind) {
    case "message":
      return { lastActivityKind: "在说话", lastActivitySummary: `worker 发言（${ev.role ?? "?"}）` };
    case "thinking":
      // TD-76：思考期间心跳持续，Lead 知道"在想"而非"假死"（不存内容）
      return { lastActivityKind: "在思考", lastActivitySummary: "worker 正在 reasoning" };
    case "command":
      return { lastActivityKind: "跑命令", lastActivitySummary: truncate(ev.command ?? "", 80) };
    case "tool_use":
      return { lastActivityKind: `用工具 ${ev.tool ?? "?"}`, lastActivitySummary: summarizeToolInput(ev.tool, ev.input) };
    case "tool_result":
      return { lastActivityKind: "收工具结果", lastActivitySummary: `${ev.tool ?? "?"} 返回${ev.isError ? "（错误）" : ""}` };
    case "file_written":
      return { lastActivityKind: "在写文件", lastActivitySummary: basename(ev.path ?? "") };
    default:
      return { lastActivityKind: ev.kind ?? "未知", lastActivitySummary: "" };
  }
}

function summarizeToolInput(tool, input) {
  if (!input || typeof input !== "object") return "";
  // 取最能标识"在干啥"的字段：路径/命令/pattern 优先
  const key = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.query;
  return key ? truncate(String(key), 80) : "";
}

function truncate(s, n) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

async function tailCommand(args, config) {
  const [runId, ...tail] = args;
  const options = parseOptions(tail);
  const { transcript } = await loadRun(runId, options, config);
  const filePath = transcript.filePath;
  const limit = Number(options.limit ?? 20);
  if (options.follow) {
    let lastSize = 0;
    let lastLineCount = 0;
    const events = await readTranscript(filePath);
    for (const event of events.slice(-limit)) {
      console.log(JSON.stringify(event));
    }
    lastLineCount = events.length;
    lastSize = (await readFile(filePath, "utf8")).length;
    console.log(`--- following ${filePath} (Ctrl+C to stop) ---`);
    await new Promise((resolve) => {
      const watcher = () => {
        readFile(filePath, "utf8").then((content) => {
          if (content.length < lastSize) return;
          const allLines = content.split(/\r?\n/).filter(Boolean);
          if (allLines.length > lastLineCount) {
            for (let i = lastLineCount; i < allLines.length; i += 1) {
              try {
                console.log(JSON.stringify(JSON.parse(allLines[i])));
              } catch {
                console.log(allLines[i]);
              }
            }
            lastLineCount = allLines.length;
          }
          lastSize = content.length;
        });
      };
      watchFile(filePath, { interval: 1000 }, watcher);
      process.on("SIGINT", () => {
        unwatchFile(filePath);
        resolve();
      });
    });
  } else {
    const { events } = await loadRun(runId, options, config);
    for (const event of events.slice(-limit)) {
      console.log(JSON.stringify(event));
    }
  }
}

/**
 * TD-77 子项 A：把一条 run.event 还原成 collect 输出的时间线条目。
 * 按 runEvent.js 的字段表映射各 kind。thinking 不持久化故不重建（返回 null 被过滤）。
 * 未知 kind 透传原样（向前兼容未来新增的 run.event kind）。
 * @param {Object} ev - transcript 里的一条 run.event
 * @returns {Object|null} 重建条目，或 null（不重建的 kind）
 */
function reconstructProcessEvent(ev) {
  switch (ev.kind) {
    case "message":
      return { kind: "message", role: ev.role, parts: ev.parts };
    case "command":
      return { kind: "command", command: ev.command, ...(ev.exitCode !== undefined ? { exitCode: ev.exitCode } : {}) };
    case "tool_use":
      return { kind: "tool_use", tool: ev.tool, input: ev.input };
    case "tool_result":
      return { kind: "tool_result", tool: ev.tool, output: ev.output, isError: ev.isError };
    case "file_written":
      return { kind: "file_written", path: ev.path };
    case "thinking":
      // runManager 未把 thinking 持久化到 transcript，无东西可重建。
      return null;
    default:
      // 未知 kind（如未来新增）透传 kind + 原始字段，不丢信号。
      return { kind: ev.kind ?? "unknown", ...ev };
  }
}

export async function collectCommand(args, config) {
  const [runId, ...tail] = args;
  const options = parseOptions(tail);
  const { transcript, events } = await loadRun(runId, options, config);
  const session = findLatest(events, "session.created");
  if (!session?.backendSessionId) {
    throw new Error(`Run ${runId} has no session metadata (no session.created event)`);
  }

  // TD-77 子项 A：进程型 run（backendSessionId=proc_<pid>，无 serveUrl）无服务端 session 可查询，
  // 从 transcript 的 run.event 重建 worker 的"做了什么"时间线返回。
  // 旧实现只重建 kind==="message" → 崩在无最终 message 的 run 返回 data:[]，让 Lead
  // 验收失败 run 时两手空空（实测 run_20260628203352049lf1n0l：144 条证据事件全丢）。
  // 现重建所有 run.event kind（message/command/tool_use/tool_result/file_written），
  // 按 runEvent.js 字段表还原。thinking 不重建（runManager 未持久化 thinking 到 transcript）。
  // 与 opencode 路径分流——按 session 标志判定，runtime-agnostic。
  if (!session.serveUrl) {
    const limit = Number(options.limit ?? 50);
    const reconstructed = events
      .filter((e) => e.type === "run.event")
      .map(reconstructProcessEvent)
      .filter((e) => e !== null)
      .slice(-limit);
    await transcript.append("messages.collected", {
      backendSessionId: session.backendSessionId,
      backend: "process",
      count: reconstructed.length,
      reconstructed: true,
    });
    console.log(JSON.stringify({ data: reconstructed, reconstructed: true, backend: "process" }, null, 2));
    return;
  }

  const runStarted = findLatest(events, "run.started");
  const backend = new OpenCodeServeBackend();
  const messages = await backend.messages(session.serveUrl, session.backendSessionId, {
    cwd: runStarted?.cwd,
    limit: Number(options.limit ?? 50),
  });
  await transcript.append("messages.collected", {
    backendSessionId: session.backendSessionId,
    count: messages.data?.length ?? 0,
  });
  console.log(JSON.stringify(messages, null, 2));
}

// F5: 从 args 数组里取 --flag <value> 的 value，取不到返回 undefined。
function extractFlag(args, flag) {
  if (!Array.isArray(args)) return undefined;
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function displayModel(agent) {
  if (typeof agent.model === "string") return agent.model;
  return agent.model?.id
    ?? agent.provider?.model
    ?? extractFlag(agent.args, "--model")
    ?? extractFlag(agent.args, "--default-model")
    ?? extractFlag(agent.prependArgs, "--model")
    ?? extractFlag(agent.prependArgs, "--default-model")
    ?? (["claude-code", "codex", "kimi-code"].includes(agent.backend) ? "(default)" : "-");
}

// C1: 进程型 run 的 stop 走 taskkill 杀进程树（/T 整树 /F 强杀）。
// 复用 processBackend._kill 的同款逻辑。PID 不存在/已退出 → 返回 false（调用方据此标 unverified）。
function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function stopCommand(args, config) {
  const [runId, ...tail] = args;
  const { transcript, events } = await loadRun(runId, parseOptions(tail), config);
  const session = findLatest(events, "session.created");
  if (!session?.backendSessionId) {
    throw new Error(`Run ${runId} has no session metadata (no session.created event)`);
  }

  // C1（F2 修复）：进程型 run（backendSessionId=proc_<pid>）无服务端 session 可 abort，
  // 走 taskkill 路径。进程死即会话死（OS 保证），taskkill 成功即 verified。
  // 与 opencode 路径分流——按 session 标志判定，不按 backend 名分支（runtime-agnostic）。
  if (session.backendSessionId.startsWith("proc_")) {
    const pid = Number(session.backendSessionId.slice("proc_".length));
    const fromState = findState(events);
    await transcript.append("run.stop_requested", { backendSessionId: session.backendSessionId, backend: "process" });
    const killed = killProcessTree(pid);
    await transcript.append("run.aborted", {
      backendSessionId: session.backendSessionId,
      backend: "process",
      reason: "stop_requested",
      verified: killed,
    });
    await transcript.append("run.state_change", { from: fromState, to: "aborted", reason: "stop_requested" });
    if (!killed) {
      await transcript.append("run.stop_unverified", { backendSessionId: session.backendSessionId, reason: "process not found / already exited" });
    }
    console.log(JSON.stringify({
      runId,
      stopped: true,
      backend: "process",
      pid,
      taskkillCalled: true,
      verified: killed,
      note: killed ? "process killed (process death = session death)" : "process not found (may have already exited)",
    }, null, 2));
    return;
  }

  if (!session?.serveUrl) {
    throw new Error(`Run ${runId} session ${session.backendSessionId} has no serveUrl (opencode path needs one)`);
  }
  const backend = new OpenCodeServeBackend();
  const fromState = findState(events);
  await transcript.append("run.stop_requested", { backendSessionId: session.backendSessionId });

  // S1-2（TD-37 落地）：abort 后验证后台是否真停。
  // 06-18 事故证明 abort HTTP 调用可能虚假成功——transcript 写 aborted 但 serve 端继续烧。
  // 现在：abort → verifyStopQuiet → quiet=false 强制 taskkill 兜底，不再只信 HTTP 返回。
  const stopResult = await executeStopWithVerification(
    backend, session.serveUrl, session.backendSessionId,
    { cwd: session.cwd, rounds: 3, intervalMs: 2000 },
  );

  if (stopResult.verified) {
    await transcript.append("run.stop_verified", { backendSessionId: session.backendSessionId });
  } else {
    await transcript.append("run.stop_unverified", {
      backendSessionId: session.backendSessionId,
      taskkillCalled: stopResult.taskkillCalled,
      delta: stopResult.verifyResult?.delta,
      metric: stopResult.verifyResult?.metric,
    });
    // S1-3 告警：stop 未验证 = 后台可能仍在烧 token（06-18 事故复现路径），立即弹窗
    raiseAlert("stop_unverified",
      `stop ${runId} not verified: backend may still be running (taskkill=${stopResult.taskkillCalled})`,
      { runId, logPath: join(config.runDir, "ALERTS.log") },
    ).catch(() => { /* 告警失败不影响终态 */ });
  }
  await transcript.append("run.aborted", {
    backendSessionId: session.backendSessionId,
    reason: "stop_requested",
    verified: stopResult.verified,
    taskkillCalled: stopResult.taskkillCalled,
  });
  await transcript.append("run.state_change", {
    from: fromState,
    to: "aborted",
    reason: "stop_requested",
  });
  console.log(JSON.stringify({
    runId,
    stopped: true,
    verified: stopResult.verified,
    taskkillCalled: stopResult.taskkillCalled,
  }, null, 2));
}

async function runsCommand(args, config) {
  const [sub, ...tail] = args;
  if (sub === "summary") {
    await runsSummaryCommand(tail, config);
    return;
  }
  if (sub === "prune") {
    await runsPruneCommand(tail, config);
    return;
  }
  if (sub === "grep") {
    await runsGrepCommand(tail, config);
    return;
  }
  if (sub === "metrics") {
    await runsMetricsCommand(tail, config);
    return;
  }
  if (sub === "scorecard") {
    await runsScorecardCommand(tail, config);
    return;
  }
  if (sub === "dashboard") {
    await runsDashboardCommand(tail, config);
    return;
  }
  if (sub === "diagnose") {
    await runsDiagnoseCommand(tail, config);
    return;
  }
  if (sub === "forecast") {
    await runsForecastCommand(tail, config);
    return;
  }
  await runsListCommand(args, config);
}

async function loadRunFiles(runDir) {
  if (!existsSync(runDir)) return [];
  const files = await readdir(runDir);
  return files.filter((f) => f.endsWith(".jsonl")).sort();
}

/**
 * M8-2 实时仪表盘聚合（🟢 工具域：纯只读聚合，绝不 retry/stop/改状态）。
 *
 * 把散落在多个 run transcript 里的状态/token/费用/证据聚合成单一视图，省 Lead
 * 在 status/tail/collect/metrics 四个命令间轮询的精力与 token。
 *
 * @param {Array<{runId, events}>} runs - 每个 run 的 runId + 已解析的事件数组。
 * @returns {{rows, summary}} rows 每行含 runId/agentId/state/tokens/costUsd/flagged/ageMs；
 *   summary 含 total/byState/totalCost/running/flagged。
 *
 * flagged（异常标红，提示 Lead 关注，不替 Lead 行动）：
 *   - failed / timed_out
 *   - completed 但 scorecard.warn 无证据（与 M8-1 默认 warn 联动）
 */
export function buildDashboard(runs, selfDeclared = null, stageProgress = null) {
  const rows = runs.map(({ runId, events }) => {
    const agentId = events[0]?.agentId ?? "(unknown)";
    const state = findState(events);
    const metricsEv = events.find((e) => e.type === "run.metrics");
    const tokens = metricsEv?.tokens ?? {};
    const costUsd = typeof metricsEv?.costUsd === "number" ? metricsEv.costUsd : undefined;

    // 证据：scorecard.checked.passed === true → 有证据；否则看 warn 事件判定。
    const scChecked = events.find((e) => e.type === "scorecard.checked");
    const hasWarn = events.some((e) => e.type === "scorecard.warn");
    const evidence = scChecked ? (scChecked.passed ? "✓" : (hasWarn ? "⚠" : "✗")) : "-";

    // age：从首个事件 ts 到最后一个事件 ts 的时长（ms）；无 ts → undefined。
    const firstTs = events[0]?.ts;
    const lastTs = events.at(-1)?.ts;
    let ageMs;
    if (firstTs && lastTs) {
      const a = new Date(firstTs).getTime();
      const b = new Date(lastTs).getTime();
      if (!Number.isNaN(a) && !Number.isNaN(b)) ageMs = b - a;
    }

    // flagged：终态异常 / completed 但 scorecard warn 无证据（M8-1 联动）。
    let flagged = false;
    if (state === "failed" || state === "timed_out") flagged = true;
    if (state === "completed" && hasWarn) flagged = true;

    return { runId, agentId, state, tokens, costUsd, evidence, ageMs, flagged };
  });

  const byState = {};
  let totalCost = 0;
  let running = 0;
  let flagged = 0;
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
    if (row.state === "running") running += 1;
    if (typeof row.costUsd === "number") totalCost += row.costUsd;
    if (row.flagged) flagged += 1;
  }

  return {
    rows,
    summary: {
      total: rows.length,
      byState,
      totalCost,
      running,
      flagged,
      // TD-82：Lead 自做声明（曝光机制——让"没派工"对用户可见）。
      // selfDeclared 来自 .wao/decisions/ 的 DECL- 文件（runsDashboardCommand 注入），
      // 不是 run events——WAO 看不见 Lead 的非 WAO 工具调用，只能靠 Lead 主动声明。
      selfDeclared: selfDeclared ?? { count: 0, byReason: {} },
      // TD-83：Lead 阶段声明（pipeline 进度曝光——让"跳过 spec/plan/汇总/总结"对用户可见）。
      // stageProgress 来自 .wao/decisions/ 的 STAGE- 文件（runsDashboardCommand 注入）。
      // declared 是已声明阶段号的 Set，count 是已声明阶段数。
      stageProgress: stageProgress ?? { declared: [], count: 0 },
    },
  };
}

async function runsListCommand(args, config) {
  const options = parseOptions(args);
  const runDir = resolve(options.runDir ?? config.runDir);
  const jsonlFiles = await loadRunFiles(runDir);
  if (jsonlFiles.length === 0) {
    console.log("No runs found.");
    return;
  }
  // N3/N5 修复：加 --agent（按 agentId 过滤）和 --latest N（取最近 N 个，按最新事件 ts 倒序）。
  // 原 bug：runs list 列历史所有 run，lead 找"刚才那次"费劲。
  const agentFilter = options.agent;
  const latestN = options.latest ? Number(options.latest) : null;

  // 收集每个 run 的摘要（runId + state + agentId + 最新 ts）
  const summaries = [];
  for (const file of jsonlFiles) {
    const runId = file.replace(/\.jsonl$/, "");
    const events = await readTranscript(join(runDir, file));
    const agentId = events[0]?.agentId;
    if (agentFilter && agentId !== agentFilter) continue;
    const state = findState(events);
    const lastTs = events.at(-1)?.ts ?? "";
    summaries.push({ runId, state, agentId, lastTs });
  }

  // --latest N：按最新事件 ts 倒序取 N 个（ts 不可比时退回 runId 字典序）
  if (latestN && latestN > 0) {
    summaries.sort((a, b) => (b.lastTs ?? "").localeCompare(a.lastTs ?? ""));
    summaries.splice(latestN);
  }

  if (summaries.length === 0) {
    console.log(agentFilter ? `No runs found for agent "${agentFilter}".` : "No runs found.");
    return;
  }
  for (const s of summaries) {
    console.log(`${s.runId}\t${s.state}`);
  }
}

async function runsSummaryCommand(args, config) {
  const options = parseOptions(args);
  const runDir = resolve(options.runDir ?? config.runDir);
  const jsonlFiles = await loadRunFiles(runDir);
  if (jsonlFiles.length === 0) {
    console.log("No runs found.");
    return;
  }
  const counts = {};
  let latestTs = null;
  for (const file of jsonlFiles) {
    const events = await readTranscript(join(runDir, file));
    const state = findState(events);
    counts[state] = (counts[state] ?? 0) + 1;
    const last = events.at(-1);
    if (last?.ts && (!latestTs || last.ts > latestTs)) {
      latestTs = last.ts;
    }
  }
  console.log(`Total runs: ${jsonlFiles.length}`);
  for (const [state, count] of Object.entries(counts).sort()) {
    console.log(`${state}: ${count}`);
  }
  if (latestTs) {
    console.log(`Latest: ${latestTs}`);
  }
}

async function runsPruneCommand(args, config) {
  const options = parseOptions(args);
  if (!options.olderThan) {
    throw new Error("runs prune requires --older-than <duration> (e.g. 7d, 24h, 30m)");
  }
  const cutoff = Date.now() - parseDuration(options.olderThan);
  const runDir = resolve(options.runDir ?? config.runDir);
  const jsonlFiles = await loadRunFiles(runDir);
  if (jsonlFiles.length === 0) {
    console.log("No runs found.");
    return;
  }
  let pruned = 0;
  let kept = 0;
  for (const file of jsonlFiles) {
    const events = await readTranscript(join(runDir, file));
    const last = events.at(-1);
    const ts = last?.ts ? new Date(last.ts).getTime() : 0;
    if (ts < cutoff) {
      await unlink(join(runDir, file));
      console.log(`Pruned ${file}`);
      pruned += 1;
    } else {
      kept += 1;
    }
  }
  console.log(`Pruned ${pruned}, kept ${kept}`);
}

async function runsGrepCommand(args, config) {
  const [pattern, ...tail] = args;
  if (!pattern) {
    throw new Error("runs grep requires <pattern>");
  }
  const options = parseOptions(tail);
  const runDir = resolve(options.runDir ?? config.runDir);
  const jsonlFiles = await loadRunFiles(runDir);
  if (jsonlFiles.length === 0) {
    console.log("No runs found.");
    return;
  }
  const re = new RegExp(pattern, "i");
  let matches = 0;
  for (const file of jsonlFiles) {
    const runId = file.replace(/\.jsonl$/, "");
    const events = await readTranscript(join(runDir, file));
    for (const event of events) {
      if (re.test(JSON.stringify(event))) {
        console.log(`${runId}\t${event.type}\t${event.ts ?? ""}`);
        matches += 1;
        break;
      }
    }
  }
  console.log(`Matched ${matches} run(s)`);
}

async function runsMetricsCommand(args, config) {
  const options = parseOptions(args);
  const runDir = resolve(options.runDir ?? config.runDir);

  // --summary: 跨 run 聚合
  if (options.summary) {
    const jsonlFiles = await loadRunFiles(runDir);
    if (jsonlFiles.length === 0) {
      console.log("No runs found.");
      return;
    }
    const allEvents = await Promise.all(
      jsonlFiles.map((f) => readTranscript(join(runDir, f))),
    );
    const s = aggregateSummary(allEvents);
    if (options.format === "json") {
      console.log(JSON.stringify(s, null, 2));
      return;
    }
    console.log(`Total runs: ${s.totalRuns}`);
    console.log(`Success rate: ${(s.successRate * 100).toFixed(0)}%`);
    for (const [state, count] of Object.entries(s.byState).sort()) {
      console.log(`  ${state}: ${count}`);
    }
    console.log(`Avg duration: ${formatDuration(s.avgDurationMs)}`);
    const t = s.totalTokens;
    if (Object.keys(t).length > 0) {
      console.log(`Tokens: input=${t.input ?? 0} output=${t.output ?? 0} reasoning=${t.reasoning ?? 0}`);
    }
    return;
  }

  // 单 run: runs metrics <runId>
  const [runId] = args.filter((a) => !a.startsWith("--"));
  if (!runId) {
    throw new Error("runs metrics requires <runId> (or --summary for aggregate)");
  }
  const filePath = join(runDir, `${runId}.jsonl`);
  const events = await readTranscript(filePath);
  const m = aggregateRunMetrics(events);
  if (options.format === "json") {
    console.log(JSON.stringify({ runId, ...m }, null, 2));
    return;
  }
  console.log(`runId:    ${runId}`);
  console.log(`state:    ${m.state}`);
  console.log(`duration: ${formatDuration(m.durationMs)}`);
  const t = m.tokens;
  if (Object.keys(t).length > 0) {
    console.log(`tokens:   input=${t.input ?? 0} output=${t.output ?? 0} reasoning=${t.reasoning ?? 0}`);
  } else {
    console.log(`tokens:   (none recorded)`);
  }
  if (m.costUsd !== undefined) {
    console.log(`cost:     ${m.costUsd.toFixed(4)}`);
  }
}

async function runsScorecardCommand(args, config) {
  const options = parseOptions(args);
  const runDir = resolve(options.runDir ?? config.runDir);
  const [runId] = args.filter((a) => !a.startsWith("--"));
  if (!runId) {
    throw new Error("runs scorecard requires <runId>");
  }
  const filePath = join(runDir, `${runId}.jsonl`);
  const events = await readTranscript(filePath);
  const scEvent = events.find((e) => e.type === "scorecard.checked");
  if (!scEvent) {
    const started = events.find((e) => e.type === "run.started");
    const reason = started?.scorecardConfigured ? "failed_before_scorecard" : "no_rules";
    if (options.format === "json") {
      console.log(JSON.stringify({ runId, scorecard: null, reason }, null, 2));
      return;
    }
    console.log(`runId:      ${runId}`);
    console.log(`scorecard:  (none — ${reason === "failed_before_scorecard" ? "run failed before scorecard gate" : "run had no scorecard rules"})`);
    return;
  }
  if (options.format === "json") {
    console.log(JSON.stringify({ runId, ...scEvent }, null, 2));
    return;
  }
  console.log(`runId:      ${runId}`);
  console.log(`passed:     ${scEvent.passed ? "yes" : "no"}`);
  for (const c of scEvent.checks ?? []) {
    const mark = c.passed ? "✔" : "✖";
    console.log(`  ${mark} ${c.name}: ${c.evidence}${c.detail ? ` — ${c.detail}` : ""}`);
  }
}

/**
 * M8-3 故障诊断：runs diagnose <runId>（🔵 工具起草域——给证据，不给处方）。
 * 处方权（retry/换 worker/接管/放弃）全在 Lead。本命令只打印【事实证据】，
 * 绝不打印"建议/应该"。详见 src/diagnosis.js 铁律。
 */
async function runsDiagnoseCommand(args, config) {
  const options = parseOptions(args);
  const runDir = resolve(options.runDir ?? config.runDir);
  const [runId] = args.filter((a) => !a.startsWith("--"));
  if (!runId) {
    throw new Error("runs diagnose requires <runId>");
  }
  const filePath = join(runDir, `${runId}.jsonl`);
  const events = await readTranscript(filePath);
  const d = diagnoseFailure(events);
  if (options.format === "json") {
    console.log(JSON.stringify({ runId, ...d }, null, 2));
    return;
  }
  console.log(`runId:    ${runId}`);
  console.log(`category: ${d.category}`);
  if (d.evidence.length > 0) {
    console.log(`evidence:`);
    for (const e of d.evidence) {
      console.log(`  [${e.eventType}] ${e.fact}`);
    }
  } else if (d.category === "none") {
    console.log(`(no failure to diagnose — run completed successfully)`);
  } else {
    console.log(`(no concrete evidence signal; review transcript manually)`);
  }
}

/**
 * M8-4 成本预演：runs forecast --agents a,b [--run-dir DIR]（🟢 工具域 bonus）。
 * 基于历史 run 的 token/cost/duration 中位数 ± 区间，给 Lead 发射前估费/估时。
 * 不阻断发射，只算账。无历史 → insufficient_data（不编造）。
 */
async function runsForecastCommand(args, config) {
  const options = parseOptions(args);
  const runDir = resolve(options.runDir ?? config.runDir);
  const agentIds = options.agents
    ? String(options.agents).split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  if (agentIds.length === 0) {
    throw new Error("runs forecast requires --agents a,b (comma-separated agent ids)");
  }

  // 从 runs 目录构建 history：读每个 jsonl，按 agentId 分组，算 aggregateRunMetrics。
  const jsonlFiles = await loadRunFiles(runDir);
  const history = {};
  for (const f of jsonlFiles) {
    const events = await readTranscript(join(runDir, f));
    const agentId = events[0]?.agentId;
    if (!agentId) continue;
    const m = aggregateRunMetrics(events);
    (history[agentId] ??= []).push(m);
  }

  const r = forecastCost({ agentIds, history });
  if (options.format === "json") {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  for (const id of agentIds) {
    const a = r.agents[id];
    if (a.insufficient_data) {
      console.log(`${id}: (insufficient data — no history)`);
      continue;
    }
    const c = a.cost?.unavailable ? "n/a" : `$${a.cost.median.toFixed(4)} [${a.cost.min.toFixed(4)}–${a.cost.max.toFixed(4)}]`;
    const t = a.tokens?.input ? `${a.tokens.input.median} [${a.tokens.input.min}–${a.tokens.input.max}]` : "n/a";
    console.log(`${id}: cost=${c}  tokens(in)=${t}  samples=${a.sampleSize}`);
  }
  const tot = r.total;
  if (tot.insufficient_data) {
    console.log(`total: (insufficient data)`);
  } else {
    const parts = [];
    if (tot.medianCostUsd !== undefined) parts.push(`cost=$${tot.medianCostUsd.toFixed(4)}`);
    if (tot.medianTokens !== undefined) parts.push(`tokens=${tot.medianTokens}`);
    console.log(`total: ${parts.join("  ")}`);
  }
}

/**
 * M8-2 实时仪表盘：单一视图聚合所有 run 的状态/token/费用/证据，异常标红。
 * 🟢 工具域：只读聚合，绝不 retry/stop/改状态。省 Lead 在多命令间轮询的精力。
 * 支持：--watch N（N 秒重刷）/ --format json / --agent <id> 过滤 / --latest N 取最近 N 个。
 */
export async function runsDashboardCommand(args, config) {
  const options = parseOptions(args);
  const runDir = resolve(options.runDir ?? config.runDir);
  const agentFilter = options.agent;
  const latestN = options.latest ? Number(options.latest) : null;
  const watchSec = options.watch ? Number(options.watch) : null;
  const asJson = options.format === "json";

  const renderOnce = async () => {
    const jsonlFiles = await loadRunFiles(runDir);
    let runs = await Promise.all(
      jsonlFiles.map(async (f) => ({
        runId: f.replace(/\.jsonl$/, ""),
        events: await readTranscript(join(runDir, f)),
      })),
    );
    if (agentFilter) runs = runs.filter((r) => r.events[0]?.agentId === agentFilter);
    if (latestN && latestN > 0) {
      runs.sort((a, b) => (b.events.at(-1)?.ts ?? "").localeCompare(a.events.at(-1)?.ts ?? ""));
      runs = runs.slice(0, latestN);
    }
    // TD-82：读 .wao/decisions/ 下的 Lead 自做声明，注入 dashboard（曝光机制）。
    // .wao/ 未 init 时静默跳过（count:0），不阻塞 dashboard。
    let selfDeclared = null;
    let stageProgress = null;
    const cwd = resolveTargetCwd(options);
    const waoDir = getWaoDir(cwd, options.stateDir ?? config.stateDir);
    try {
      selfDeclared = await summarizeDeclares(waoDir);
    } catch { /* .wao/ 未 init，无声明——dashboard 照常显示 */ }
    try {
      const stageSummary = await summarizeStages(waoDir);
      stageProgress = {
        declared: [...stageSummary.declared].sort((a, b) => a - b),
        count: stageSummary.count,
      };
    } catch { /* .wao/ 未 init——pipeline 进度留空 */ }
    const dash = buildDashboard(runs, selfDeclared, stageProgress);
    if (asJson) {
      console.log(JSON.stringify(dash, null, 2));
      return;
    }
    if (dash.rows.length === 0) {
      console.log("No runs found.");
      return;
    }
    const tableRows = dash.rows.map((row) => {
      const ti = row.tokens?.input ?? 0;
      const to = row.tokens?.output ?? 0;
      return {
        runId: row.runId,
        agentId: row.agentId,
        state: row.state,
        tokens: `${ti}/${to}`,
        cost: row.costUsd !== undefined ? `$${row.costUsd.toFixed(4)}` : "-",
        evidence: row.evidence,
        age: row.ageMs !== undefined ? formatDuration(row.ageMs) : "-",
        flag: row.flagged ? "  ⚠" : "",
      };
    });
    const widths = {
      runId: Math.max("RUN_ID".length, ...tableRows.map((r) => r.runId.length)),
      agentId: Math.max("AGENT".length, ...tableRows.map((r) => r.agentId.length)),
      state: Math.max("STATE".length, ...tableRows.map((r) => r.state.length)),
      tokens: Math.max("TOKENS(i/o)".length, ...tableRows.map((r) => r.tokens.length)),
      cost: Math.max("COST".length, ...tableRows.map((r) => r.cost.length)),
      evidence: Math.max("EVIDENCE".length, ...tableRows.map((r) => r.evidence.length)),
    };
    console.log(`${"RUN_ID".padEnd(widths.runId)} ${"AGENT".padEnd(widths.agentId)} ${"STATE".padEnd(widths.state)} ${"TOKENS(i/o)".padEnd(widths.tokens)} ${"COST".padEnd(widths.cost)} ${"EVIDENCE".padEnd(widths.evidence)} AGE`);
    for (const row of tableRows) {
      console.log(`${row.runId.padEnd(widths.runId)} ${row.agentId.padEnd(widths.agentId)} ${row.state.padEnd(widths.state)} ${row.tokens.padEnd(widths.tokens)} ${row.cost.padEnd(widths.cost)} ${row.evidence.padEnd(widths.evidence)} ${row.age}${row.flag}`);
    }
    const s = dash.summary;
    console.log(`[summary] total=${s.total} running=${s.running} flagged=${s.flagged} cost=$${s.totalCost.toFixed(4)}` +
      (s.selfDeclared.count > 0
        ? ` | Lead自做=${s.selfDeclared.count} 理由分布=${JSON.stringify(s.selfDeclared.byReason)}`
        : ""));
    // TD-83：pipeline 阶段进度行——让"跳过 spec/plan/汇总/总结"对用户可见（曝光机制）。
    if (s.stageProgress.count > 0 || s.stageProgress.declared.length === 0) {
      const stageNames = ["", "spec", "plan", "派发", "验收", "汇总", "总结"];
      const line = [1, 2, 3, 4, 5, 6]
        .map((n) => `[${n}]${stageNames[n]}${s.stageProgress.declared.includes(n) ? "✓" : "—"}`)
        .join(" ");
      console.log(`[pipeline] ${line}`);
    }
  };

  await renderOnce();
  // --watch N：定时重刷（Lead 用 Ctrl-C 退出）。不做 top 式常驻进程（用户已否决）。
  if (watchSec && watchSec > 0) {
    // 定时器保持进程存活（不 unref）；下面的 never-resolving Promise 是双保险，
    // 确保 setInterval 的回调持续触发直到 SIGINT。Ctrl-C 退出。
    const timer = setInterval(renderOnce, watchSec * 1000);
    await new Promise(() => {});
    clearInterval(timer);
  }
}

async function workflowCommand(args, config) {
  const [sub, ...tail] = args;
  if (sub === "run") {
    await workflowRunCommand(tail, config);
    return;
  }
  if (sub === "list") {
    await workflowListCommand(config);
    return;
  }
  throw new Error(`Unknown workflow subcommand: ${sub ?? "(none)"}. Try: workflow run <name|file.mjs> | workflow list`);
}

/**
 * workflow list：列出可用模板（TD-88 模板库）。
 * 扫描 workflows/templates/ 目录，列出 .mjs 模板名 + 用法提示。
 */
async function workflowListCommand(config) {
  const templatesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "workflows", "templates");
  let files = [];
  try {
    files = (await readdir(templatesDir)).filter((f) => f.endsWith(".mjs"));
  } catch {
    // templates 目录不存在 = 无模板
  }
  if (files.length === 0) {
    console.log("No workflow templates found. 用 workflow run <file.mjs> 跑自定义 workflow。");
    return;
  }
  console.log("可用模板（workflow run <名字> --vars ...）：");
  for (const f of files) {
    const name = f.replace(/\.mjs$/, "");
    // 读文件头注释找用法（前 8 行的"用法"或"模板"字样）
    let usage = "";
    try {
      const content = await readFile(join(templatesDir, f), "utf8");
      const lines = content.split("\n").slice(0, 8);
      const usageLine = lines.find((l) => l.includes("用法") || l.includes("workflow run"));
      if (usageLine) usage = usageLine.replace(/^\/\/\s*/, "").trim();
    } catch {}
    console.log(`  ${name}${usage ? `\t${usage}` : ""}`);
  }
  console.log("");
  console.log("用法：workflow run <名字> --vars key=value [--vars ...]");
  console.log("也可传完整路径：workflow run workflows/templates/<名字>.mjs");
}

/**
 * wao 命令族：.wao/ 文档状态管理（阶段 3）。
 * 子命令：init / state / decision / handoff。
 * init 显式创建 .wao/ 骨架；state/decision/handoff 读写各槽位（命令强制，agent 不直接 touch 文件）。
 */
async function waoCommand(args, config) {
  const [sub, ...tail] = args;
  if (sub === "init") {
    await waoInitCommand(tail, config);
    return;
  }
  if (sub === "state") {
    await waoStateCommand(tail, config);
    return;
  }
  if (sub === "decision") {
    await waoDecisionCommand(tail, config);
    return;
  }
  if (sub === "handoff") {
    await waoHandoffCommand(tail, config);
    return;
  }
  if (sub === "declare") {
    await waoDeclareCommand(tail, config);
    return;
  }
  if (sub === "stage") {
    await waoStageCommand(tail, config);
    return;
  }
  if (sub === "ask") {
    await waoAskCommand(tail, config);
    return;
  }
  if (sub === "doctor") {
    await waoDoctorCommand(tail, config);
    return;
  }
  throw new Error(`Unknown wao subcommand: ${sub ?? "(none)"}. Try: wao init | wao state | wao decision | wao handoff | wao declare | wao stage | wao ask | wao doctor`);
}

/**
 * wao doctor：部署前/定期体检。检查环境是否满足安全派发条件。
 * 主控装上 WAO skill 后应先跑一次 doctor，确认环境齐 + 安全配置到位。
 */
async function waoDoctorCommand(args, config) {
  const options = parseOptions(args);
  const cwd = resolveTargetCwd(options);
  const checks = [];

  // 1. Node 版本（WAO 需 22+）
  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  checks.push({
    name: "node_version",
    pass: nodeMajor >= 22,
    detail: `Node ${process.versions.node} (需要 >=22)`,
  });

  // 2. 各 CLI 在 PATH（claude/codex/kimi/opencode）
  for (const cli of ["claude", "codex", "kimi", "opencode"]) {
    const found = await whichCli(cli);
    checks.push({ name: `cli_${cli}`, pass: found, detail: found ? "在 PATH" : "未找到（该 backend 不可用）" });
  }

  // 3. provider key 在 env
  for (const key of ["ZHIPU_API_KEY", "DEEPSEEK_API_KEY", "KIMI_API_KEY"]) {
    const present = Boolean(process.env[key]);
    checks.push({ name: `key_${key}`, pass: present, detail: present ? "已设置" : "未设置（对应 provider 会 401）" });
  }

  // 4. agents.json 完整性：opencode worker 是否都配了 tokenBudget
  const registryPath = resolve(options.registry ?? config.registry);
  if (existsSync(registryPath)) {
    try {
      const raw = await readFile(registryPath, "utf8");
      const reg = JSON.parse(raw);
      const agents = reg.agents ?? {};
      const providerClaudeWorkers = Object.entries(agents)
        .filter(([, agent]) => isProviderWrappedClaudeCodeWorker(agent))
        .map(([id]) => id);
      if (providerClaudeWorkers.length > 0 && await hasClaudeOauthCredentials()) {
        checks.push({
          name: "claude_oauth_provider_workers",
          pass: true,
          level: "warn",
          detail: `claude-code OAuth 登录态存在；provider worker (${providerClaudeWorkers.join(",")}) 必须通过 wrapper 的 CLAUDE_CONFIG_DIR 隔离，避免 OAuth token 覆盖 provider key`,
        });
      }
      for (const [id, agent] of Object.entries(agents)) {
        if (agent.backend === "opencode-serve" && !agent.tokenBudget) {
          checks.push({
            name: `budget_${id}`,
            pass: false,
            detail: `opencode worker ${id} 未配 tokenBudget（06-18 事故风险，必须配）`,
          });
        }
      }
      checks.push({ name: "registry_loads", pass: true, detail: `${Object.keys(agents).length} agents` });
    } catch (error) {
      checks.push({ name: "registry_loads", pass: false, detail: `agents.json 解析失败: ${error.message}` });
    }
  } else {
    checks.push({ name: "registry_loads", pass: false, detail: `agents.json 不存在: ${registryPath}` });
  }

  // 5. .wao/ 是否 init
  // 三态：已初始化(OK) / 未初始化(WARN，fresh-agent preflight 第一步的"正常初态"，不该判失败)
  //      / 结构异常(FAIL，缺槽位或多余文件才是真不健康)。
  // doctor 是 onboarding §4d 的 preflight 第一道——"还没 init"是 run wao init 之前的预期状态，
  // 不应与 401/key 缺/CLI 缺同列让 exit=1，否则 fresh agent 在第一步就误判环境坏了。
  const waoCheck = validateWaoDir(cwd, options.stateDir ?? config.stateDir);
  if (waoCheck.ok) {
    checks.push({ name: "wao_init", pass: true, detail: ".wao/ 已初始化" });
  } else if (waoCheck.initialized) {
    checks.push({
      name: "wao_init",
      pass: false,
      detail: `.wao/ 结构异常: 缺[${waoCheck.missing.join(",")}] / 多余[${waoCheck.unexpected.join(",")}]`,
    });
  } else {
    checks.push({
      name: "wao_init",
      pass: true,
      level: "warn",
      detail: ".wao/ 未初始化（run wao init；这是 preflight 的正常初态，不计入 HEALTHY 判定）",
    });
  }

  // 6. invocation_method（TD-72 延伸，info 级，永不计入 HEALTHY 判定）：
  // fresh agent 易把"PATH 里没有 wao"误读成安装缺失——但 WAO 故意不进 PATH
  // （v22 约束：链进 PATH 会被系统默认 v24 node 拉起被 version guard 拒）。
  // doctor 主动告知正确调用方式，堵住认知 friction。
  checks.push({
    name: "invocation_method",
    pass: true,
    level: "info",
    detail: "WAO 是本地仓内工具，故意不进 PATH——用 `npm run cli -- <command>` 调（走 v22 shim）。PATH 里没有 wao 命令是正常的，不是安装缺失。",
  });

  const failed = checks.filter((c) => !c.pass);
  const verdict = failed.length === 0 ? "HEALTHY" : `${failed.length} ISSUE(S)`;

  if (options.format === "json") {
    console.log(JSON.stringify({ verdict, checks }, null, 2));
  } else {
    console.log(`WAO Doctor: ${verdict}`);
    for (const c of checks) {
      const label = c.level === "warn" ? "WARN" : (c.level === "info" ? "INFO" : (c.pass ? "OK" : "FAIL"));
      console.log(`  [${label}] ${c.name}: ${c.detail}`);
    }
  }
  if (failed.length > 0) process.exitCode = 1;
}

function isProviderWrappedClaudeCodeWorker(agent) {
  if (agent?.backend !== "claude-code") return false;
  if (agent.provider?.baseUrl && agent.provider?.apiKeyEnv) return true;
  const prependArgs = Array.isArray(agent.prependArgs) ? agent.prependArgs : [];
  return prependArgs.includes("--base-url") && prependArgs.includes("--api-key-env");
}

async function hasClaudeOauthCredentials(env = process.env) {
  const base = env.USERPROFILE || env.HOME;
  if (!base) return false;
  const credentialsPath = join(base, ".claude", ".credentials.json");
  try {
    const raw = await readFile(credentialsPath, "utf8");
    const parsed = JSON.parse(raw);
    return Boolean(parsed?.claudeAiOauth);
  } catch {
    return false;
  }
}

/** 检查 CLI 是否在 PATH（where/which）。*/
async function whichCli(name) {
  const { execSync } = await import("node:child_process");
  try {
    execSync(process.platform === "win32" ? `where ${name}` : `which ${name}`, { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function waoInitCommand(args, config) {
  const options = parseOptions(args);
  const cwd = resolveTargetCwd(options);
  const override = options.stateDir ?? config.stateDir;
  await initWaoDir(cwd, override);
  const waoDir = getWaoDir(cwd, override);
  console.log(JSON.stringify({
    initialized: true,
    waoDir,
    slots: ["project.md", "state/", "decisions/", "handoff/", "runs/"],
  }, null, 2));
}

async function waoHandoffCommand(args, config) {
  const [sub, ...tail] = args;
  const options = parseOptions(tail);
  const cwd = resolveTargetCwd(options);
  const waoDir = getWaoDir(cwd, options.stateDir ?? config.stateDir);

  if (sub === "write") {
    if (!options.from || !options.to) throw new Error("wao handoff write requires --from and --to");
    if (!options.summary) throw new Error("wao handoff write requires --summary");
    const path = await writeHandoff(waoDir, {
      from: options.from,
      to: options.to,
      summary: options.summary,
      artifacts: options.artifacts ? options.artifacts.split(",") : [],
      claims: [],
    });
    console.log(JSON.stringify({ written: true, path }, null, 2));
    return;
  }
  if (sub === "read") {
    const role = tail[0];
    if (!role) throw new Error("wao handoff read requires <role>");
    const body = await readHandoff(waoDir, role);
    if (!body) { console.log(JSON.stringify({ found: false }, null, 2)); return; }
    console.log(body);
    return;
  }
  throw new Error(`Unknown wao handoff subcommand: ${sub ?? "(none)"}. Try: write | read`);
}

async function waoDecisionCommand(args, config) {
  const [sub, ...tail] = args;
  const options = parseOptions(tail);
  const cwd = resolveTargetCwd(options);
  const waoDir = getWaoDir(cwd, options.stateDir ?? config.stateDir);

  if (sub === "add") {
    if (!options.title) throw new Error("wao decision add requires --title");
    let body = options.body ?? "";
    if (options.bodyFile) body = await readFile(resolve(options.bodyFile), "utf8");
    const path = await addDecision(waoDir, {
      title: options.title,
      body,
      context: options.context,
    });
    console.log(JSON.stringify({ added: true, id: path.split(/[\\/]/).pop().slice(0, 4), path }, null, 2));
    return;
  }
  if (sub === "list") {
    const list = await listDecisions(waoDir);
    for (const line of list) console.log(line);
    return;
  }
  if (sub === "show") {
    const id = tail[0];
    if (!id) throw new Error("wao decision show requires <id> (e.g. 0001)");
    const body = await readDecision(waoDir, id);
    console.log(body);
    return;
  }
  throw new Error(`Unknown wao decision subcommand: ${sub ?? "(none)"}. Try: add | list | show`);
}

/**
 * wao declare：Lead 自做声明（TD-82）。
 * Lead 自己完成一个本可派发的任务时，用此命令声明理由，让自做行为对用户/dashboard 可见。
 * 强制力 = 曝光（可见），不是拦截。Lead 仍全权可自做。
 * reason 必须是枚举值（REASON_CODES），防"声明"退化成自由文本失去约束力。
 */
async function waoDeclareCommand(args, config) {
  const options = parseOptions(args);
  const cwd = resolveTargetCwd(options);
  const waoDir = getWaoDir(cwd, options.stateDir ?? config.stateDir);

  if (options.task) {
    // add：写一条声明。--task 必填，--reason 必填且需在枚举内。
    if (!options.reason) {
      throw new Error(`wao declare requires --reason <code>。合法值：[${REASON_CODES.join(", ")}]`);
    }
    const path = await addDeclare(waoDir, {
      task: options.task,
      reason: options.reason,
      note: options.note,
    });
    console.log(JSON.stringify({ declared: true, path, reason: options.reason }, null, 2));
    return;
  }
  // 无 --task → 默认列出现有声明（裸 "wao declare" = 自省视图）。
  const summary = await summarizeDeclares(waoDir);
  const declares = await listDeclares(waoDir);
  console.log(JSON.stringify({ ...summary, declares }, null, 2));
}

/**
 * wao stage：Lead 阶段声明（TD-83）。
 * Lead 走完 pipeline 的一个阶段时，用此命令声明产物，让 pipeline 进度对用户/dashboard 可见。
 * 强制力 = 曝光（可见），不是拦截。Lead 仍全权可跳过任意阶段，但跳过会在 dashboard 留缺口。
 * stage 必须是枚举值（STAGE_NUMBERS = 1..6），防跳号或自造阶段逃避门控。
 *
 * 用法：
 *   wao stage 1 --task "起草 auth 契约" --artifacts docs/01-prd.md
 *   wao stage 3 --task "派发实现" --artifacts runs/run_xxx.jsonl,runs/run_yyy.jsonl
 *   wao stage              # 裸跑：列出已声明阶段 + 缺口（自省视图）
 */
async function waoStageCommand(args, config) {
  // 阶段号是位置参数（纯数字），不能用"第一个非 -- 开头"——那会误匹配 --cwd <path> 的路径值。
  // 用正则匹配首个纯数字 token，防 parseOptions 的值（如 /tmp/x、docs/y.md）被当成阶段号。
  const stageArg = args.find((a) => /^\d+$/.test(a));
  const options = parseOptions(args);
  const cwd = resolveTargetCwd(options);
  const waoDir = getWaoDir(cwd, options.stateDir ?? config.stateDir);

  if (stageArg !== undefined) {
    const stage = Number(stageArg);
    if (!options.task) {
      throw new Error(`wao stage requires --task <描述>。阶段 ${stageArg} 的产物描述是可见性的核心。`);
    }
    const artifacts = options.artifacts
      ? options.artifacts.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const path = await addStage(waoDir, {
      stage,
      task: options.task,
      artifacts,
      note: options.note,
    });
    console.log(JSON.stringify({ staged: true, stage, path }, null, 2));
    return;
  }
  // 无阶段号 → 默认列出已声明阶段 + 缺口（裸 "wao stage" = pipeline 自省视图）。
  const summary = await summarizeStages(waoDir);
  const progress = STAGE_NUMBERS.map((n) => `[${n}]${summary.declared.has(n) ? "✓" : "—"}`).join(" ");
  // 注意：declared 是 Set，JSON.stringify(Set) → {}。转数组输出，便于人读 + pipeline 解析。
  console.log(JSON.stringify({
    declared: [...summary.declared].sort((a, b) => a - b),
    count: summary.count,
    stages: summary.stages,
    progress,
  }, null, 2));
}

/**
 * wao ask：快捷派工（TD-88 派工摩擦反转）。
 * 降低单次派工的命令构造成本——Lead 不用每次拼 run <agentId> --prompt "..." + 手写边界声明。
 *
 * 用法：
 *   wao ask researcher "读 src/foo.js 给摘要"              # 默认只读边界（注入禁写/禁装声明）
 *   wao ask coder_hq "修 src/foo.js 的 bug" --mode write   # 写模式（不注入只读边界）
 *   wao ask researcher "..." --cwd D:/projects/xxx          # 跨项目（走 resolveTargetCwd）
 *
 * 内部：构造带边界模板的 prompt，调 runCommand（复用，不重写 run 逻辑）。
 */
async function waoAskCommand(args, config) {
  const [agentId, ...rest] = args;
  if (!agentId) {
    throw new Error('wao ask requires <agentId> "<一句话任务>". 例：wao ask researcher "读 src/foo.js 给摘要"');
  }
  // 提取一句话任务（第一个非 -- 的位置参数，agentId 之后的）
  const task = rest.find((a) => !a.startsWith("--"));
  if (!task) {
    throw new Error(`wao ask requires 一句话任务. 例：wao ask ${agentId} "读 src/foo.js 给摘要"`);
  }
  const options = parseOptions(rest);
  const mode = options.mode ?? "readonly";

  // 只读模式：注入边界声明（来自 SKILL.md 安全铁律 + 派工边界要求）
  // 写模式（--mode write）：不注入，让 worker 能改文件
  let prompt = task;
  if (mode === "readonly") {
    prompt = [
      task,
      "",
      "—— 只读边界（wao ask 自动注入）——",
      "本任务只读：不得修改任何文件，不得安装依赖（pip install/npm install 等），不得改变环境。",
      "如有需要，结果直接在回复里给出，不要写文件。",
    ].join("\n");
  }

  // 构造 run 命令的参数，复用 runCommand
  const runArgs = [agentId];
  runArgs.push("--prompt", prompt);
  // 透传 Lead 给的 --cwd / --registry / --format 等（resolveTargetCwd 在 runCommand 内生效）
  for (const opt of ["cwd", "registry", "format", "run-dir"]) {
    const flag = `--${opt}`;
    if (rest.includes(flag)) {
      const idx = rest.indexOf(flag);
      runArgs.push(flag, rest[idx + 1]);
    }
  }
  await runCommand(runArgs, config);
}

async function waoStateCommand(args, config) {
  const [sub, ...tail] = args;
  if (sub === "read") {
    const options = parseOptions(tail);
    const cwd = resolveTargetCwd(options);
    const waoDir = getWaoDir(cwd, options.stateDir ?? config.stateDir);
    const state = await readCurrentState(waoDir);
    if (!state) {
      console.log(JSON.stringify({ initialized: false, message: ".wao/ not initialized or no current state" }, null, 2));
      return;
    }
    if (options.format === "text" || !options.format) {
      console.log(`workflow: ${state.workflowId}`);
      console.log(`updated: ${state.updated}`);
      console.log(`status: ${state.status}`);
      console.log("steps:");
      for (const s of state.steps) {
        console.log(`  ${s.node}\t${s.status}\t${s.runId}`);
      }
    } else {
      console.log(JSON.stringify(state, null, 2));
    }
    return;
  }
  if (sub === "snapshot") {
    const options = parseOptions(tail);
    const cwd = resolveTargetCwd(options);
    const waoDir = getWaoDir(cwd, options.stateDir ?? config.stateDir);
    // 手动快照：需 workflowId（必填），其余可选
    if (!options.workflowId) throw new Error("wao state snapshot requires --workflow-id");
    await writeStateSnapshot(waoDir, {
      workflowId: options.workflowId,
      executed: [],
      skipped: [],
      completedResults: new Map(),
      allNodes: [],
      predecessors: {},
    });
    console.log(JSON.stringify({ snapshot: true, waoDir }, null, 2));
    return;
  }
  throw new Error(`Unknown wao state subcommand: ${sub ?? "(none)"}. Try: wao state read | wao state snapshot`);
}

async function workflowRunCommand(args, config) {
  const [filePath, ...tail] = args;
  if (!filePath) {
    throw new Error("workflow run requires <name|file.mjs>. 用 workflow list 看可用模板。");
  }
  const options = parseOptions(tail);

  // TD-88 模板库：名字解析。若 filePath 不像路径（无分隔符 / 不是已存在文件），
  // 查 workflows/templates/<名字>.mjs。找到用它；找不到 fallback 到原路径逻辑。
  let absolutePath = resolve(filePath);
  const looksLikePath = /[\\/]/.test(filePath) || existsSync(absolutePath);
  if (!looksLikePath) {
    const templatesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "workflows", "templates");
    const templatePath = join(templatesDir, `${filePath}.mjs`);
    if (existsSync(templatePath)) {
      absolutePath = templatePath;
    }
  }

  // 加载 workflow
  const wfDef = await loadWorkflow(absolutePath);

  // 参数式 DAG：--vars key=value 注入模板变量（可多次）
  const templateVars = parseTemplateVars(tail);
  const effectiveDef = Object.keys(templateVars).length > 0
    ? applyTemplate(wfDef, templateVars)
    : wfDef;

  // workflow 级 transcript
  const runDir = resolve(options.runDir ?? config.runDir);
  await mkdir(runDir, { recursive: true });
  const workflowRunId = `wf_${new Date().toISOString().replace(/[-:.TZ]/g, "")}`;
  const transcript = new JsonlTranscript(join(runDir, `${workflowRunId}.jsonl`), {
    runId: workflowRunId,
    agentId: effectiveDef.id,
  });

  // 执行
  const manager = newRunManager(config);
  const engine = new WorkflowEngine({ runManager: manager, transcript });
  const result = await engine.execute(effectiveDef, {
    input: options.input,
    isolate: resolveIsolateFlag(options),
    ...(options.registry ? { registry: options.registry } : {}),
    runDir,
    ...(options.waitTimeout ? { waitTimeout: Number(options.waitTimeout) } : {}),
  });

  console.log(JSON.stringify({
    workflowRunId,
    workflowId: wfDef.id,
    completed: result.completed,
    nodes: Object.fromEntries(
      Object.entries(result.nodeResults).map(([id, r]) => [id, {
        completed: r.completed,
        runId: r.runId,
      }]),
    ),
  }, null, 2));
}

function parseDuration(input) {
  const match = input.match(/^(\d+)(d|h|m|s)$/);
  if (!match) {
    throw new Error(`Invalid duration: ${input}. Use <number><d|h|m|s> (e.g. 7d, 24h, 30m)`);
  }
  const value = Number(match[1]);
  const unit = match[2];
  const multipliers = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
  return value * multipliers[unit];
}

async function loadRun(runId, options, config) {
  if (!runId) {
    throw new Error("runId is required");
  }
  const runDir = resolve(options.runDir ?? config.runDir);
  const filePath = join(runDir, `${runId}.jsonl`);
  const events = await readTranscript(filePath);
  const transcript = new JsonlTranscript(filePath, {
    runId,
    agentId: events[0]?.agentId ?? "unknown",
    initialSeq: findLastEventSeq(events),
  });
  return { transcript, events };
}

function backendFor(agent) {
  // WAO CLI 路径（注入 worker env，让 worker 能调 wao 命令记录状态）
  const waoCliPath = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  if (agent.backend === "opencode-serve") {
    return new OpenCodeServeBackend();
  }
  if (agent.backend === "claude-code") {
    return new ClaudeCodeBackend({ waoCliPath });
  }
  if (agent.backend === "codex") {
    return new CodexBackend({ waoCliPath });
  }
  if (agent.backend === "kimi-code") {
    return new KimiCodeBackend({ waoCliPath });
  }
  throw new Error(`Unsupported backend: ${agent.backend}`);
}

function parseAgentList(args) {
  const agents = [];
  let i = 0;
  while (i < args.length && !args[i].startsWith("--")) {
    agents.push(args[i]);
    i += 1;
  }
  const options = parseOptions(args.slice(i));
  if (agents.length === 0) {
    throw new Error("requires at least one <agentId>");
  }
  return { agents, options };
}

export async function loadPrompt(options) {
  if (options.promptFile) {
    return readFile(resolve(options.promptFile), "utf8");
  }
  if (options.prompt) {
    return options.prompt;
  }
  throw new Error("Provide --prompt or --prompt-file");
}

async function loadScorecardRules(options) {
  if (options.scorecardRules && options.scorecardRulesFile) {
    throw new Error("--scorecard-rules and --scorecard-rules-file are mutually exclusive");
  }
  if (options.scorecardRulesFile) {
    options.scorecardRules = await readFile(resolve(options.scorecardRulesFile), "utf8");
    options.scorecardRulesSource = "--scorecard-rules-file";
  } else if (options.scorecardRules) {
    options.scorecardRulesSource = "--scorecard-rules";
  }
  return options;
}

/**
 * 解析 wao 命令的目标项目 cwd（TD-84：跨项目 scope 修复）。
 *
 * 回退链（优先级高→低）：
 *   1. 显式 --cwd 参数（options.cwd）——调用方明确指定，最优先
 *   2. WAO_TARGET_CWD env——worker 子进程被注入的目标项目（processBackend.js 注入，
 *      值 = agent.cwd）。让 worker 调 wao 命令时自动写进干活的项目，不靠角色 prompt
 *      显式传 --cwd $WAO_TARGET_CWD（那个变成冗余安全网）。
 *   3. process.cwd()——Lead 裸跑 / 本地单项目场景的默认。
 *
 * 注意：Lead 进程没有 WAO_TARGET_CWD（只注入给 worker 子进程），所以 Lead 跨项目
 * 派工时调 wao stage/declare 仍需显式带 --cwd 指向目标项目（SKILL 纪律约束）。
 */
export function resolveTargetCwd(options) {
  if (options.cwd) return resolve(options.cwd);
  if (process.env.WAO_TARGET_CWD) return resolve(process.env.WAO_TARGET_CWD);
  return resolve(process.cwd());
}

export function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

/**
 * 包装 waitForCompletion：捕获 failed 抛错，转为结构化结果返回。
 * 让主控能看到 worker 失败的证据（runId/failed/error），决定是否接手，
 * 而不是 CLI 崩溃 exit 1 什么也不输出。
 */
export async function runAndWait(run, options) {
  try {
    const result = await run.waitForCompletion(options);
    return { runId: run.transcript.context.runId, ...result };
  } catch (error) {
    // waitForCompletion 在 done(failed) 时抛错。转为结构化失败结果，
    // 让调用方（主控/CLI）能看到失败原因，而非裸 crash。
    return {
      runId: run.transcript.context.runId,
      completed: false,
      failed: true,
      timedOut: false,
      error: error.message ?? String(error),
    };
  }
}

/**
 * 解析 --scorecard-rules 的值（JSON 字符串）。
 * 例：'{"requireCommands":["npm test"],"requireFiles":["out.js"]}'
 */
function parseScorecardRules(raw, source = "--scorecard-rules") {
  if (typeof raw !== "string") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${source} must be valid JSON, got: ${raw}`);
  }
}

/**
 * 解析 --vars key=value 参数（可多次出现）。
 * 例：--vars coder=glm_worker --vars feature=登录
 * → { coder: "glm_worker", feature: "登录" }
 */
function parseTemplateVars(args) {
  const vars = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--vars" && i + 1 < args.length) {
      const pair = args[i + 1];
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) {
        throw new Error(`--vars requires key=value format, got: ${pair}`);
      }
      const key = pair.slice(0, eqIdx);
      const value = pair.slice(eqIdx + 1);
      vars[key] = value;
      i += 1;
    }
  }
  return vars;
}

/**
 * worktree 命令：列出/删除 worktree（TD-22）。
 *   worktree list [--cwd DIR]
 *   worktree remove <path> [--cwd DIR]
 * 能力层（listWorktrees/removeWorktree）早已实现，本命令只是 CLI 暴露。
 */
async function worktreeCommand(args, config) {
  const [sub, ...rest] = args;
  const options = parseOptions(rest);
  const cwd = resolve(options.cwd ?? config.cwd ?? process.cwd());
  if (sub === "list") {
    const wts = await listWorktrees(cwd);
    console.log(JSON.stringify(wts, null, 2));
    return;
  }
  if (sub === "remove") {
    const target = rest.find((a) => !a.startsWith("--"));
    if (!target) throw new Error("worktree remove requires <path>");
    await removeWorktree(resolve(target));
    console.log(JSON.stringify({ removed: resolve(target) }));
    return;
  }
  throw new Error(`Unknown worktree subcommand: ${sub ?? "(none)"} (expected: list | remove)`);
}

function printHelp() {
  console.log(`Windows Agent Orchestrator PoC

Commands:
  registry list --registry config/agents.json
  registry check [--registry config/agents.json]
  registry validate [--registry FILE]
  spawn <agentId> [agentId2 ...] --prompt "..." [--cwd DIR] [--registry FILE] [--run-dir DIR] [--wait] [--background] [--poll-interval MS] [--wait-timeout MS] [--tag key=value] [--isolate] [--scorecard-rules-file FILE]
  run <agentId> --prompt "..." [--prompt-file FILE] [--cwd DIR] [--registry FILE] [--run-dir DIR] [--poll-interval MS] [--wait-timeout MS] [--format json|text] [--isolate] [--require-certified] [--background] [--scorecard-rules-file FILE]
  status <runId> [--run-dir DIR] [--format json]
  tail <runId> [--limit N] [--follow] [--run-dir DIR]
  collect <runId> [--limit N] [--run-dir DIR]
  stop <runId> [--run-dir DIR]
  retry <runId> [--wait] [--run-dir DIR]
  resume <runId> [--wait] [--run-dir DIR]
  runs list [--run-dir DIR] [--agent AGENT_ID] [--latest N]
  runs summary [--run-dir DIR]
  runs prune --older-than <duration> [--run-dir DIR]
  runs grep <pattern> [--run-dir DIR]
  runs metrics <runId> [--run-dir DIR] [--format json]
  runs metrics --summary [--run-dir DIR] [--format json]
  runs scorecard <runId> [--run-dir DIR] [--format json]
  runs dashboard [--watch N] [--agent ID] [--latest N] [--format json] [--run-dir DIR]
  runs diagnose <runId> [--run-dir DIR] [--format json]
  runs forecast --agents a,b [--run-dir DIR] [--format json]
  workflow run <name|file.mjs> [--input TEXT] [--registry FILE] [--isolate] [--wait-timeout MS] [--run-dir DIR] [--vars key=value...]
  workflow list                  # 列出可用模板（workflows/templates/）
  worktree list [--cwd DIR]
  worktree remove <path> [--cwd DIR]
  daemon start [--run-dir DIR] [--registry FILE] [--pipe PIPE] [--resume-on-start]
  daemon run <agentId> --prompt "..." [--run-dir DIR] [--registry FILE] [--prompt-file FILE]
  daemon stop [--run-dir DIR]
  daemon ping [--run-dir DIR] [--pipe PIPE]
  daemon status <runId> [--run-dir DIR] [--pipe PIPE]
  daemon list [--run-dir DIR] [--pipe PIPE]
  daemon supervise [--run-dir DIR] [--registry FILE] [--idle-exit-ms MS]
  daemon supervisor status|stop [--run-dir DIR]
  daemon health [--run-dir DIR]

Project state (.wao/):
  wao init [--cwd DIR] [--state-dir DIR]
  wao state read [--format text|json]
  wao state snapshot --workflow-id ID [--cwd DIR]
  wao decision add --title T [--body B | --body-file F] [--context C]
  wao decision list
  wao decision show <id>
  wao declare --task T --reason <code> [--note N]  # Lead 自做声明（reason: too-coupled|too-small|high-constitutional-risk|verification-cheaper|needs-global-context）
  wao declare                                       # 列出已有声明 + 理由分布
  wao stage <n> --task T [--artifacts a,b] [--note N]  # Lead 阶段声明（n: 1=spec 2=plan 3=派发 4=验收 5=汇总 6=总结）
  wao stage                                            # 列出已声明阶段 + 缺口（pipeline 自省）
  wao ask <agentId> "<一句话任务>" [--mode write] [--cwd DIR]  # 快捷派工（只读默认注入边界；--mode write 不注入）
  wao handoff write --from R --to R --summary S [--artifacts a,b]
  wao handoff read <role>  # latest incoming handoff addressed to role
  wao doctor [--cwd DIR] [--format json]
`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
