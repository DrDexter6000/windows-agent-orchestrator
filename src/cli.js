#!/usr/bin/env node
import { readFile, unlink } from "node:fs/promises";
import { existsSync, watchFile, unwatchFile, unlinkSync, readdirSync, statSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { join, resolve, dirname, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findLatest, findState, findLastEventSeq, JsonlTranscript, readTranscript } from "./transcript.js";
import { OpenCodeServeBackend } from "./backends/opencodeServe.js";
import { executeStopWithVerification } from "./backends/opencodeStopVerify.js";
import { raiseAlert } from "./alerts.js";
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
// TD-98 阶段 2a/2b/2c：parseOptions/loadPrompt/displayModel/extractFlag/resolveTargetCwd/
// resolveIsolateFlag/newRunManager 抽到 commands/shared.js，消除 commands/*.js 对 cli.js
// 的反向依赖。cli.js re-export 以保持 test/cli.test.js 的 `from "../src/cli.js"` 导入行不变。
import { parseOptions, loadPrompt, displayModel, extractFlag, resolveTargetCwd, resolveIsolateFlag, newRunManager } from "./commands/shared.js";
// Re-export：保持外部 import 路径（test/cli.test.js）不变。
export { parseOptions, loadPrompt, displayModel, resolveTargetCwd };
// buildDashboard / runsDashboardCommand 从 runs.js re-export（test/cli.test.js 依赖）。
export { buildDashboard, runsDashboardCommand };

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

/**
 * TD-95 #11：doctor --strict 的 JS parse smoke。
 * 对 src/ 下所有 .js 跑 node --check，防注释/语法错误漏到运行时（复盘 #3 教训）。
 * 返回 {pass, detail}——失败时列出哪些文件解析失败。
 */
function _doctorParseSmoke() {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  if (!existsSync(srcDir)) return { pass: true, detail: "src/ 不存在（跳过 parse smoke）" };
  const failures = [];
  const collectJs = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) collectJs(full);
      else if (entry.endsWith(".js")) {
        const result = spawnSync(process.execPath, ["--check", full], { encoding: "utf8", timeout: 10_000 });
        if (result.status !== 0) failures.push(full.replace(srcDir + sep, ""));
      }
    }
  };
  collectJs(srcDir);
  if (failures.length === 0) return { pass: true, detail: `src/ 所有 .js 解析通过` };
  return { pass: false, detail: `${failures.length} 个文件解析失败: ${failures.join(", ")}` };
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

// TD-98 阶段 2a：extractFlag/displayModel 已移至 commands/shared.js（上方 import）。

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

// TD-98 阶段 2b：runs 命令族（runsCommand + buildDashboard + runsDashboardCommand +
// list/summary/prune/grep/metrics/scorecard/diagnose/forecast + loadRunFiles + parseDuration）
// 已移至 src/commands/runs.js（上方 import + re-export）。


// TD-98 阶段 2c：workflow 命令族（workflowCommand + workflowListCommand）已移至
// src/commands/workflow.js（上方 import）。workflowRunCommand + parseTemplateVars 也在那里。


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
    // TD-95 #1：多余目录时给迁移建议（不只报异常），帮 Lead 知道怎么处理
    let detail = `.wao/ 结构异常: 缺[${waoCheck.missing.join(",")}] / 多余[${waoCheck.unexpected.join(",")}]`;
    if (waoCheck.unexpected.length > 0) {
      detail += ` — 多余目录可能是旧版遗留，建议迁移到 .dev/wao-legacy/<日期>/ 后删除`;
    }
    checks.push({ name: "wao_init", pass: false, detail });
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

  // 7. TD-95 #11 --strict：JS parse smoke（防注释崩溃漏到运行时，复盘 #3 教训）。
  //    对 src/*.js 跑 node --check。非 strict 模式跳过（保持 doctor 快速）。
  if (options.strict) {
    const parseResult = _doctorParseSmoke();
    checks.push({
      name: "parse_smoke",
      pass: parseResult.pass,
      detail: parseResult.detail,
    });
  }

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
    slots: ["project.md", "state/", "decisions/", "pipeline/", "handoff/", "runs/"],
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
    const rawArtifacts = options.artifacts
      ? options.artifacts.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    // TD-95 #7：run 路径 artifact 解析为绝对路径（跨项目时可解析）。
    // transcript 物理在 WAO repo 的 runDir，不在 --cwd 目标项目。裸 runs/run_xxx.jsonl
    // 从目标项目不可解析——解析为绝对路径让审计者能找到。
    const waoRunDir = resolve(options.runDir ?? config.runDir);
    const artifacts = rawArtifacts?.map((a) => resolveArtifactPath(a, waoRunDir));
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

// workflowRunCommand 已移至 src/commands/workflow.js（TD-98 阶段 2c，随 workflow 族搬迁）。


// parseDuration 已移至 src/commands/runs.js（runs prune 专用 helper，随 runs 族搬迁）。

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

/**
 * TD-95 #7：解析 stage artifact 路径。
 *
 * run 路径（runs/run_xxx.jsonl）的物理位置在 WAO repo 的 runDir，不在 --cwd 目标项目。
 * 裸相对路径从目标项目不可解析——解析为绝对路径让审计者能找到。
 *
 * 规则：
 *   - 已是绝对路径 → 原样返回
 *   - 匹配 runs/ 前缀（run transcript）→ 相对 WAO runDir 解析为绝对
 *   - 其他（docs/xxx.md 等项目内路径）→ 相对 process.cwd() 解析（保持原行为）
 */
export function resolveArtifactPath(artifact, waoRunDir) {
  // 已是绝对路径（含盘符或以 / 开头）→ 不动
  if (/^[A-Za-z]:[\\/]/.test(artifact) || artifact.startsWith("/")) {
    return artifact;
  }
  // run transcript 路径 → 相对 WAO runDir（transcript 物理位置）
  if (artifact.startsWith("runs/")) {
    return resolve(waoRunDir, "..", artifact);
  }
  // 其他（docs/ 等）→ 保持原样（相对目标项目，addStage 只存字符串不解析）
  return artifact;
}

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
