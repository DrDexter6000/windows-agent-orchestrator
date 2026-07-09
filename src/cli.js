#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlTranscript, readTranscript } from "./transcript.js";
import {
  connectDaemon,
  readHandshake as readDaemonHandshake,
  isDaemonAlive,
  HANDSHAKE_FILE as DAEMON_HANDSHAKE_FILE,
  DEFAULT_PIPE,
  DEFAULT_LIVENESS_THRESHOLD_MS,
} from "./daemon.js";
import { renderRunSummary } from "./cliRunSummary.js";
import { checkNodeVersion } from "./nodeVersionGuard.js";
import { readSupervisorState } from "./daemonSupervisor.js";
// TD-98 阶段 1：daemon/registry 命令族拆到 src/commands/（行为不变，纯搬迁）。
import { daemonCommand } from "./commands/daemon.js";
import { registryCommand } from "./commands/registry.js";
// TD-98 阶段 2b：runs 命令族拆到 src/commands/runs.js（行为不变，纯搬迁）。
import { runsCommand, buildDashboard, runsDashboardCommand } from "./commands/runs.js";
// TD-98 阶段 2c：workflow + worktree 命令族拆到 src/commands/（行为不变，纯搬迁）。
import { workflowCommand } from "./commands/workflow.js";
import { worktreeCommand } from "./commands/worktree.js";
// TD-98 阶段 2d：wao + doctor 命令族拆到 src/commands/（行为不变，纯搬迁）。
// wao.js 的 waoCommand 接受 deps.askHandler（= cli.js 的 waoAskCommand，内部复用 runCommand），
// 保持依赖方向 cli.js -> wao.js（wao ask 不反向 import cli.js）。
import { waoCommand as waoCommandCore, resolveArtifactPath } from "./commands/wao.js";
// TD-98 阶段 2e-1a：只读 observe 命令族（status/tail/collect）拆到 src/commands/observe.js。
import { statusCommand, tailCommand, collectCommand } from "./commands/observe.js";
// TD-98 阶段 2e-1b：stop 命令拆到 src/commands/stop.js（杀进程 + verification + alert，非只读）。
import { stopCommand } from "./commands/stop.js";
// TD-98 阶段 2e-2：retry/resume 命令拆到 src/commands/lifecycle.js。
import { retryCommand, resumeCommand } from "./commands/lifecycle.js";
// TD-98 阶段 2a/2b/2c/2e：parseOptions/loadPrompt/displayModel/extractFlag/resolveTargetCwd/
// resolveIsolateFlag/newRunManager 抽到 commands/shared.js，消除 commands/*.js 对 cli.js
// 的反向依赖。cli.js re-export 以保持 test/cli.test.js 的 `from "../src/cli.js"` 导入行不变。
import { parseOptions, loadPrompt, displayModel, extractFlag, resolveTargetCwd, resolveIsolateFlag, newRunManager } from "./commands/shared.js";
// Re-export：保持外部 import 路径（test/cli.test.js）不变。
export { parseOptions, loadPrompt, displayModel, resolveTargetCwd };
// buildDashboard / runsDashboardCommand 从 runs.js re-export（test/cli.test.js 依赖）。
export { buildDashboard, runsDashboardCommand };
// resolveArtifactPath 从 wao.js re-export（原 cli.js export，保持符号可见）。
export { resolveArtifactPath };
// statusCommand / collectCommand 从 observe.js re-export（test/cli.test.js 依赖）。
export { statusCommand, collectCommand };

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

// _doctorParseSmoke / isProviderWrappedClaudeCodeWorker / hasClaudeOauthCredentials /
// whichCli 已移至 src/commands/doctor.js（TD-98 阶段 2d，随 doctor 族搬迁）。

/**
 * waoCommand 派遣器包装：注入 askHandler（= waoAskCommand，复用 cli.js 的 runCommand）。
 * wao.js 的 waoCommandCore 不 import ../cli.js，ask 子命令靠这里注入，保持依赖方向。
 */
async function waoCommand(args, config) {
  await waoCommandCore(args, config, { askHandler: waoAskCommand });
}

// TD-98 阶段 2c：newRunManager / resolveIsolateFlag / backendFor 已移至 commands/shared.js
//（上方 import + re-export；cli.js 的 spawn/run 命令仍用 newRunManager/resolveIsolateFlag，
// workflow.js 也从 shared.js import，避免反向依赖）。

// TD-98 阶段 1：daemon 命令族已拆到 src/commands/daemon.js（行为不变）。

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

// TD-98 阶段 1：registry 命令族已拆到 src/commands/registry.js（行为不变）。

// TD-98 阶段 2e-2：retry/resume 命令已移至 src/commands/lifecycle.js（上方 import）。


// TD-98 阶段 1：registryCheck/Validate 已拆到 src/commands/registry.js（行为不变）。

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

// TD-98 阶段 2e-1a：只读 observe 命令族（statusCommand/tailCommand/collectCommand +
// describeActivity/summarizeToolInput/truncate/reconstructProcessEvent）已移至
// src/commands/observe.js（上方 import + re-export statusCommand/collectCommand）。
// stop/retry/resume/run/spawn 仍在下方（非只读，单独拆）。


// TD-98 阶段 2a：extractFlag/displayModel 已移至 commands/shared.js（上方 import）。

// TD-98 阶段 2e-1b：stop 命令（stopCommand + killProcessTree）已移至 src/commands/stop.js
//（上方 import）。stop 非只读——杀进程 + stop verification + alert，单独成族。


// TD-98 阶段 2b：runs 命令族（runsCommand + buildDashboard + runsDashboardCommand +
// list/summary/prune/grep/metrics/scorecard/diagnose/forecast + loadRunFiles + parseDuration）
// 已移至 src/commands/runs.js（上方 import + re-export）。


// TD-98 阶段 2c：workflow 命令族（workflowCommand + workflowListCommand）已移至
// src/commands/workflow.js（上方 import）。workflowRunCommand + parseTemplateVars 也在那里。


// TD-98 阶段 2d：wao 命令族（waoCommand 派遣器 + waoDoctorCommand + waoInit/Handoff/Decision/
// Declare/Stage/State 子命令 + doctor 专用 helper）已移至 src/commands/wao.js + doctor.js。
// 仅 waoAskCommand 留在 cli.js（内部复用 runCommand，run 命令族不拆）。


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

// waoStateCommand 已移至 src/commands/wao.js（TD-98 阶段 2d，随 wao 族搬迁）。

// workflowRunCommand 已移至 src/commands/workflow.js（TD-98 阶段 2c，随 workflow 族搬迁）。


// parseDuration 已移至 src/commands/runs.js（runs prune 专用 helper，随 runs 族搬迁）。

// loadRun 已移至 commands/shared.js（TD-98 阶段 2e-1a：status/tail/collect 迁出后，
// stop/retry 仍暂留 cli.js 继续共用 loadRun；上方 import）。

// backendFor 已移至 commands/shared.js（TD-98 阶段 2c：newRunManager 的后端选择器，随
// newRunManager 一起搬走；cli.js 不再直接调用，但 OpenCodeServeBackend 仍被 stop/spawn 用）。

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

// TD-98 阶段 2a：loadPrompt 已移至 commands/shared.js（上方 import 即 re-export）。

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

// resolveTargetCwd 已移至 commands/shared.js（TD-98 阶段 2b：runs/wao 多 family 共用，
// 上方 import + re-export）。

// resolveArtifactPath 已移至 commands/wao.js（TD-98 阶段 2d，随 wao stage 搬迁；
// 上方 import + re-export，保持符号可见）。

// TD-98 阶段 2a：parseOptions 已移至 commands/shared.js（上方 import 即 re-export）。

/**
 * 包装 waitForCompletion：捕获 failed 抛错，转为结构化结果返回。
 * 让主控能看到 worker 失败的证据（runId/failed/error），决定是否接手，
 * 而不是 CLI 崩溃 exit 1 什么也不输出。
 *
 * TD-95 #6（复盘）：error 截断到 500 字符（后端 raw stderr 最多 4000 字符，噪声高）；
 * failed 时注入 diagnosis 字段（复用 diagnoseFailure，帮 Lead 快速分类不用读 raw error）。
 */
export async function runAndWait(run, options) {
  try {
    const result = await run.waitForCompletion(options);
    return { runId: run.transcript.context.runId, ...result };
  } catch (error) {
    // waitForCompletion 在 done(failed) 时抛错。转为结构化失败结果，
    // 让调用方（主控/CLI）能看到失败原因，而非裸 crash。
    const rawError = error.message ?? String(error);
    // TD-95 #6：截断 error 到 500 字符（含后缀）+ 附 transcript path
    const MAX_ERROR = 500;
    const SUFFIX = `... (truncated, ${rawError.length} chars total — see transcript)`;
    const truncatedError = rawError.length > MAX_ERROR
      ? rawError.slice(0, MAX_ERROR - SUFFIX.length) + SUFFIX
      : rawError;
    // TD-95 #6：注入 diagnosis（读 transcript 分类）。transcript 不存在也给 unknown（不崩）。
    let diagnosis = null;
    try {
      const { diagnoseFailure } = await import("./diagnosis.js");
      const { readTranscript } = await import("./transcript.js");
      let events = [];
      try { events = await readTranscript(run.transcript.filePath); } catch {}
      diagnosis = diagnoseFailure(events);
    } catch {
      // diagnoseFailure 本身崩（不该发生）→ diagnosis 留 null
    }
    return {
      runId: run.transcript.context.runId,
      completed: false,
      failed: true,
      timedOut: false,
      error: truncatedError,
      transcript: run.transcript.filePath,
      ...(diagnosis ? { diagnosis } : {}),
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

// parseTemplateVars + worktreeCommand 已移至 src/commands/（TD-98 阶段 2c：
// parseTemplateVars 是 workflow run 专用 helper，worktreeCommand 是 worktree 族，
// 分别搬到 commands/workflow.js 和 commands/worktree.js，上方 import）。


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
