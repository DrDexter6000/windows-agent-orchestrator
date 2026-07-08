// src/backgroundRunner.js
//
// P2（M7）：后台生命周期接管 / detached runner。
//
// 06-18 事故架构洞：fire-and-forget spawn 的孤儿会话脱离任何 WAO 进程——所有防线
// （token 闸门 S1-1 / 事件轮询 / 兜底 abort）全活在 waitForCompletion() 内部，
// 孤儿会话无人消费事件流 → 状态不推进 → 失控烧 token（06-18：7.4h，半周 quota）。
// 当前的"拒绝裸 spawn"护栏（runManager.js TD-39）只是"拒绝脚枪"，堵了无人值守。
//
// 本模块是正解：detached runner 进程**拥有** worker handle，驱动 waitForCompletion
// （含 token 闸门 + 超时 + 兜底 abort），写共享 transcript（文件，跨进程）。
// CLI 用 --background flag fork 一个跑本模块的 detached 子进程，拿 runId 立即返回，
// runner 独立活到 run 结束。process 死即会话死；opencode 类由 waitForCompletion 内的
// 三层防线兜底。runtime-agnostic（不按 backend 名分支）。
//
// 进程内核心函数 runBackground 可单测；CLI 入口 runMain 解析 argv 后调它。

import { RunManager } from "./runManager.js";
import { OpenCodeServeBackend } from "./backends/opencodeServe.js";
import { ClaudeCodeBackend } from "./backends/claudeCode.js";
import { CodexBackend } from "./backends/codex.js";
import { KimiCodeBackend } from "./backends/kimiCode.js";
import { getWaoCliPath } from "./waoCliPath.js";
import { readRegistry } from "./registry.js";
import { normalizeAgent } from "./registry.js";
import { JsonlTranscript, findLastEventSeq, findState, readTranscript, TERMINAL_STATES } from "./transcript.js";
import { checkNodeVersion } from "./nodeVersionGuard.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";

// D-F3 修复：ownership 心跳文件。daemon --resume-on-start 用它判活，
// 避免劫持 P2 runner 还在驱动的 run（双所有者 = 06-18 孤儿变体）。
// runner 启动写 .owner-<runId> {pid, heartbeatAt}，存活期间更新心跳，退出删。
// ownership 是短命进程注册表（同 daemon.json 性质），不存 run 状态（transcript 是真相源）。
const OWNER_HEARTBEAT_INTERVAL_MS = 2000;

function writeOwnerHeartbeat(runDir, runId) {
  try {
    writeFileSync(join(runDir, `.owner-${runId}`), JSON.stringify({ pid: process.pid, heartbeatAt: Date.now() }), "utf8");
  } catch {
    // 写失败（runDir 被删等）不杀 runner
  }
}

function clearOwner(runDir, runId) {
  try { unlinkSync(join(runDir, `.owner-${runId}`)); } catch { /* 已不在 */ }
}

// 测试用：registry 以对象形式注入时，构造一个内存 readRegistry（与 registry.js 同结构）。
function makeObjectRegistry(registryObj) {
  const agents = registryObj.agents ?? {};
  return async () => ({
    listAgents() {
      return Object.entries(agents).map(([id, agent]) => normalizeAgent(id, agent));
    },
    getAgent(id, overrides = {}) {
      if (!agents[id]) throw new Error(`Unknown agent: ${id}`);
      const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
      return normalizeAgent(id, { ...agents[id], ...defined });
    },
  });
}

// 与 cli.js 的 backendFor 同款构造（runner 独立进程，不复用 cli.js 避免循环依赖）。
function backendFor(agent, { fetchImpl, waoCliPath } = {}) {
  if (agent.backend === "opencode-serve") {
    return new OpenCodeServeBackend(fetchImpl ? { fetchImpl } : {});
  }
  if (agent.backend === "claude-code") return new ClaudeCodeBackend({ waoCliPath });
  if (agent.backend === "codex") return new CodexBackend({ waoCliPath });
  if (agent.backend === "kimi-code") return new KimiCodeBackend({ waoCliPath });
  throw new Error(`Unsupported backend: ${agent.backend}`);
}

/**
 * 进程内核心：驱动一个 run 到终态。可单测，也可被 detached 进程入口调用。
 * 拥有 worker handle 的完整生命周期（waitForCompletion 内的闸门/abort 都生效）。
 *
 * @param {object} opts
 * @param {string} opts.agentId
 * @param {string} opts.prompt
 * @param {object|string} opts.registry - registry 对象或路径
 * @param {string} opts.runDir
 * @param {Function} [opts.fetchImpl] - 测试注入（opencode）
 * @param {number} [opts.waitTimeout]
 * @param {number} [opts.pollInterval]
 * @param {object} [opts.scorecardRules]
 * @returns {Promise<{runId, completed, failed, timedOut, error}>}
 */
export async function runBackground(opts = {}) {
  const { agentId, prompt, runDir } = opts;
  const runId = opts.runId ?? `run_${new Date().toISOString().replace(/[-:.TZ]/g, "")}${Math.random().toString(36).slice(2, 8)}`;
  if (!agentId) throw new Error("runBackground: agentId required");
  if (!prompt) throw new Error("runBackground: prompt required");
  if (!runDir) throw new Error("runBackground: runDir required");

  // TD-90: Windows 上指向 scripts/wao-cli.cmd（v22 shim），避免 worker shell 默认 v24 触发 guard
  const waoCliPath = getWaoCliPath();
  // registry 可是路径（生产）或对象（测试注入）。对象时构造一个内存 readRegistry。
  const registryResolver = typeof opts.registry === "object" && opts.registry !== null
    ? makeObjectRegistry(opts.registry)
    : readRegistry;
  const registryPath = typeof opts.registry === "string" ? opts.registry : (opts.registry ? undefined : "config/agents.json");

  const manager = new RunManager({
    config: {
      runDir,
      // 对象 registry 时给个占位 path（readRegistry 忽略它，从闭包对象取）；
      // 字符串时用真实路径。避免 start() 里 resolve(undefined) 抛错。
      registry: registryPath ?? (typeof opts.registry === "object" ? "." : undefined),
      pollInterval: opts.pollInterval ?? 1000,
      waitTimeout: opts.waitTimeout ?? 120000,
      timeout: (opts.waitTimeout ?? 120000) + 5000,
      retries: 0,
    },
    readRegistry: registryResolver,
    transcriptDir: runDir,
    backendFor: (agent) => backendFor(agent, { fetchImpl: opts.fetchImpl, waoCliPath }),
  });

  let run;
  try {
    run = await manager.start(agentId, {
      prompt,
      registry: registryPath,
      runDir,
      cwd: opts.cwd,
      // fireAndForget=false：runner 自己驱动 waitForCompletion，不触发护栏，不是孤儿。
      fireAndForget: false,
      // CLI --background 模式预生成 runId，传给 runner 保持一致。
      runId,
      ...(opts.scorecardRules ? { scorecard: { rules: opts.scorecardRules } } : {}),
      // M8-1：透传 --scorecard-mode（默认 warn；hard/off 由 Lead 显式传）。
      ...(opts.scorecardMode ? { scorecardMode: opts.scorecardMode } : {}),
    });
  } catch (error) {
    await writeStartupFailureTranscript({ runDir, runId, agentId, prompt, error });
    return {
      runId,
      completed: false,
      failed: true,
      timedOut: false,
      error: error.message ?? String(error),
    };
  }

  // D-F3：写 ownership 心跳（daemon resume 判活用），存活期间更新，finally 删。
  writeOwnerHeartbeat(runDir, run.runId);
  const heartbeatTimer = setInterval(() => writeOwnerHeartbeat(runDir, run.runId), OWNER_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  let waitResult;
  try {
    waitResult = await run.waitForCompletion({
      waitTimeout: opts.waitTimeout ?? 120000,
      pollInterval: opts.pollInterval ?? 1000,
    });
  } finally {
    clearInterval(heartbeatTimer);
    clearOwner(runDir, run.runId);
  }

  return {
    runId: run.runId,
    completed: waitResult.completed ?? false,
    failed: waitResult.failed ?? false,
    timedOut: waitResult.timedOut ?? false,
    error: waitResult.error,
  };
}

async function writeStartupFailureTranscript({ runDir, runId, agentId, prompt, error }) {
  const transcriptPath = join(runDir, `${runId}.jsonl`);
  let events = [];
  try {
    events = await readTranscript(transcriptPath);
  } catch {
    events = [];
  }
  const transcript = new JsonlTranscript(transcriptPath, {
    runId,
    agentId,
    initialSeq: findLastEventSeq(events),
  });

  if (!events.some((event) => event.type === "run.started")) {
    await transcript.append("run.started", { backend: "backgroundRunner" });
  }
  if (!events.some((event) => event.type === "run.state_change")) {
    await transcript.append("run.state_change", { from: null, to: "pending", reason: "created" });
  }
  if (prompt && !events.some((event) => event.type === "prompt.sent")) {
    await transcript.append("prompt.sent", { prompt });
  }
  if (TERMINAL_STATES.includes(findState(events))) {
    return;
  }
  await transcript.append("run.error", { phase: "start", error: error.message ?? String(error) });
  await transcript.append("run.state_change", { from: "pending", to: "failed", reason: "startup_error" });
}

/**
 * CLI 入口：解析 argv 调 runBackground。供 detached 子进程调用。
 * argv 形如：node backgroundRunner.js <agentId> --prompt "..." --run-dir D --registry F [--wait-timeout N]
 */
export async function runMain(argv = process.argv.slice(2)) {
  // TD-40：detached runner 是直接 spawn worker 子进程的点，必须在 v24（回归）上拒绝——
  // 否则子进程树可能被 OS Job Object bug 误杀，产生半完成的孤儿 transcript。
  // WAO_SKIP_VERSION_GUARD=1 绕过（仅测试用）。
  if (process.env.WAO_SKIP_VERSION_GUARD !== "1") {
    const versionGuard = checkNodeVersion(process.version);
    if (!versionGuard.ok) {
      process.stderr.write(`backgroundRunner 拒绝启动：${versionGuard.reason}（见 docs/02-architecture.md §4.3）\n`);
      process.exit(1);
    }
  }
  const args = argv.filter((a) => !a.startsWith("--"));
  const opts = parseSimpleFlags(argv);
  const agentId = args[0];
  const result = await runBackground({
    agentId,
    prompt: opts.prompt,
    registry: opts.registry,
    runDir: opts["run-dir"],
    runId: opts["run-id"],
    cwd: opts.cwd,
    waitTimeout: Number(opts["wait-timeout"] ?? 120000),
    pollInterval: Number(opts["poll-interval"] ?? 1000),
    scorecardRules: opts["scorecard-rules"] ? JSON.parse(opts["scorecard-rules"]) : undefined,
    scorecardMode: opts["scorecard-mode"],
  });
  // detached runner 把最终结果写 stdout 一行 JSON（供调试/日志；CLI 已返回，不依赖此）
  process.stdout.write(JSON.stringify(result) + "\n");
}

function parseSimpleFlags(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        opts[key] = next;
        i += 1;
      }
    }
  }
  return opts;
}

// 直接作为入口运行时（detached 子进程）：node backgroundRunner.js ...
// Windows 上 process.argv[1] 是普通路径，import.meta.url 是 file:///，须 pathToFileURL 比对。
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runMain().catch((e) => {
    process.stderr.write(`backgroundRunner error: ${e.message}\n`);
    process.exit(1);
  });
}
