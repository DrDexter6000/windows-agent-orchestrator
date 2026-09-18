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
// （含 token 闸门 + 观察到期通知 + 兜底 abort），写共享 transcript（文件，跨进程）。
// CLI 用 --background flag fork 一个跑本模块的 detached 子进程，拿 runId 立即返回，
// runner 独立活到 run 结束。process 死即会话死；opencode 类由 waitForCompletion 内的
// 三层防线兜底。runtime-agnostic（不按 backend 名分支）。
//
// ADR-0030（TD-151）：等待窗到期在 runner 内同样 = 通知不杀——waitForCompletion 只落
// run.observation_deadline_reached 事实，runner 继续监督到自然终态（TD-148 主害的钉）。
//
// 进程内核心函数 runBackground 可单测；CLI 入口 runMain 解析 argv 后调它。
// resume 模式（--resume-run-id）：`resume` 不带 --wait 的接管通道——CLI fork 本 runner
// 以 detached 形状持有续跑 worker（修复 TD-148 姊妹脸 (a)：CLI 进程被 ref'd 子管道
// 吊住静默挂起），runner 驱动续跑到自然终态。

import { RunManager } from "./runManager.js";
import { backendFor } from "./backends/factory.js";
import { getWaoCliPath } from "./waoCliPath.js";
import { readRegistry } from "./registry.js";
import { normalizeAgent } from "./registry.js";
import { JsonlTranscript, findLastEventSeq, findState, readTranscript, TERMINAL_STATES, STATE_CHANGE_REASON } from "./transcript.js";
import { checkNodeVersion } from "./nodeVersionGuard.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import { validateSessionReuseRouting } from "./application/sessionReuse.js";

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

// backend 构造收敛于共享工厂 src/backends/factory.js（daemon / runner / shared 共用）。
// 不复用 cli.js 的真实约束：cli.js 顶层无条件执行 main() 且拉入整棵命令树，不可被
// import；本模块是被 CLI 按路径 fork 的 detached 独立进程入口，从工厂 import 构造器。

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
 * @param {number} [opts.waitTimeout] - explicit override (becomes "explicit" tier)
 * @param {number} [opts.globalWaitTimeout] - server-owned global config.waitTimeout
 * @param {number} [opts.pollInterval]
 * @param {object} [opts.scorecardRules]
 * @param {string} [opts.modelOverride] — R10-A per-dispatch model id (--model);
 *   RunManager.start synthesizes it over the registry model policy
 * @param {string} [opts.reasoningOverride] — R11-1 per-dispatch reasoning
 *   effort (--reasoning); RunManager.start synthesizes it over the registry
 *   reasoning policy (only `.effort` replaced)
 * @returns {Promise<{runId, completed, failed, timedOut, error, observationDeadlineReached}>}
 *   ADR-0030（TD-151）：observationDeadlineReached=true 表示等待窗到期事实已落盘
 *   （run.observation_deadline_reached）——到期不杀 worker，completed/failed 是
 *   自然终态；timedOut 只对 legacy 终态转录为 true（新 run 恒 false）。
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
      // M10-pre3: execution deadline (waitTimeout) is now separate from backend
      // request/poll timeout. waitTimeout may be null (disabled) — that's correct:
      // RunManager.waitForCompletion will skip the total-duration timer.
      // The backend request timeout (config.timeout) stays at its own independent
      // finite value — it bounds a single HTTP poll, not the total run duration.
      waitTimeout: opts.globalWaitTimeout ?? opts.waitTimeout,
      timeout: 30000, // independent backend request/poll timeout (not derived from deadline)
      retries: 0,
    },
    readRegistry: registryResolver,
    transcriptDir: runDir,
    // M11-11C: test seam — an injected backendFor overrides the default
    // runtime construction (used by the causal chain test to capture the
    // compiled claude argv). Production leaves this unset.
    backendFor: opts.backendFor
      ? (agent) => opts.backendFor(agent, { fetchImpl: opts.fetchImpl, waoCliPath })
      : (agent) => backendFor(agent, { fetchImpl: opts.fetchImpl, waoCliPath }),
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
      // M9-2A：透传 --require-certified（CLI/MCP background 路径不再静默忽略认证门）。
      requireCertified: Boolean(opts.requireCertified),
      // M9-7A: delivery runs force persistent worktree isolation.
      ...(opts.isolate ? { isolate: true } : {}),
      ...(opts.delivery ? { delivery: opts.delivery } : {}),
      // M11-11C: thread the resolved reuse routing (opaque {mode, opaqueUuid,
      // turn}) to RunManager. The capability check + argv compilation happen
      // there; the opaque uuid is the only identifier reaching the provider.
      ...(opts.sessionReuse ? { sessionReuse: opts.sessionReuse } : {}),
      // M12-6 (P1-A): thread the server-proven frozen HEAD so RunManager.start
      // revalidates the source HEAD and pins the worktree base. Absent for CLI.
      ...(opts.frozenGitHead ? { frozenGitHead: opts.frozenGitHead } : {}),
      // M12-7: thread the retained parent worktree {path, branch} for a
      // Lead-authorized continuation. RunManager.start adopts it as effectiveCwd
      // (no fresh worktree). Absent for ordinary dispatch.
      ...(opts.reuseWorktree ? { reuseWorktree: opts.reuseWorktree } : {}),
      // M12-16: thread the correctable opt-in so RunManager.start spawns the
      // child with a piped stdin + stream-json input and drains the correction
      // queue in waitForCompletion. Absent for ordinary dispatch.
      ...(opts.correctable ? { correctable: true } : {}),
      // Round 4 Bundle B: thread the read-only declaration so RunManager.start
      // forces isolation, fails closed when the worktree cannot be created, and
      // persists the exactly-once run.read_only_declared fact. Absent for
      // ordinary dispatch (byte-compatible).
      ...(opts.readOnly ? { readOnly: true } : {}),
      // R10-A: thread the per-dispatch model override (--model <id> from
      // dispatchRun's argv) so RunManager.start synthesizes model.id over the
      // registry policy (siblings preserved) and persists the explicit
      // modelOverride fact on run.started. Absent for ordinary dispatch
      // (byte-compatible). The SSOT shape gate (runManager.js) forbids a
      // "--"-prefixed value, so parseSimpleFlags restores the pair exactly.
      ...(opts.modelOverride !== undefined && opts.modelOverride !== null
        ? { modelOverride: opts.modelOverride }
        : {}),
      // R11-1: thread the per-dispatch reasoning effort override (--reasoning
      // <effort> from dispatchRun's argv) so RunManager.start synthesizes
      // reasoning.effort over the registry policy (siblings preserved) and
      // persists the explicit reasoningOverride fact on run.started. Absent
      // for ordinary dispatch (byte-compatible). The closed-set gate
      // (runManager.js SSOT) forbids a "--"-prefixed value by membership, so
      // parseSimpleFlags restores the pair exactly.
      ...(opts.reasoningOverride !== undefined && opts.reasoningOverride !== null
        ? { reasoningOverride: opts.reasoningOverride }
        : {}),
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
      waitTimeout: opts.waitTimeout,
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
    // ADR-0030（TD-151）：到期事实的结构化可见性（后台不杀钉：到期后终态仍是
    // 自然 completed/failed，不是 timed_out）。
    observationDeadlineReached: run.observationDeadlineReached === true,
  };
}

/**
 * TD-148 姊妹脸 (a) 修复（ADR-0030 实施批）：`resume` 不带 --wait 的接管通道。
 * 旧行为：CLI 进程内 respawn worker 子进程（ref'd stdout/stderr 管道）→ CLI 打印
 * 后被管道吊住静默挂起，且无人消费事件流。新行为：CLI 以 detached+stdio-ignore+unref
 * 形状 fork 本 runner（对齐 dispatchRun 的 spawn 形状），由 runner 持有续跑 handle、
 * 驱动 waitForCompletion（token 闸门 / 观察到期通知 / 自然终态）并写 ownership 心跳。
 * CLI 立即返回，不再持有任何 worker 管道。
 *
 * @param {object} opts
 * @param {string} opts.runId - 要续接的 run
 * @param {object|string} opts.registry - registry 对象或路径
 * @param {string} opts.runDir
 * @returns {Promise<{runId, resumed: boolean, reason?: string, completed, failed, timedOut, error?, observationDeadlineReached}>}
 */
export async function runResumeBackground(opts = {}) {
  const { runId, runDir } = opts;
  if (!runId) throw new Error("runResumeBackground: runId required");
  if (!runDir) throw new Error("runResumeBackground: runDir required");

  const waoCliPath = getWaoCliPath();
  const registryResolver = typeof opts.registry === "object" && opts.registry !== null
    ? makeObjectRegistry(opts.registry)
    : readRegistry;
  const registryPath = typeof opts.registry === "string" ? opts.registry : (opts.registry ? undefined : "config/agents.json");

  const manager = new RunManager({
    config: {
      runDir,
      registry: registryPath ?? (typeof opts.registry === "object" ? "." : undefined),
      pollInterval: opts.pollInterval ?? 1000,
      // ADR-0030：waitTimeout 到期在 resume 续跑里同样是观察通知，不是终止。
      waitTimeout: opts.globalWaitTimeout ?? opts.waitTimeout,
      timeout: 30000,
      retries: 0,
    },
    readRegistry: registryResolver,
    transcriptDir: runDir,
    // M11-11C 同款注入缝：生产走共享工厂，测试可注入。
    backendFor: opts.backendFor
      ? (agent) => opts.backendFor(agent, { fetchImpl: opts.fetchImpl, waoCliPath })
      : (agent) => backendFor(agent, { fetchImpl: opts.fetchImpl, waoCliPath }),
  });

  const run = await manager.resume(runId, {});
  if (!run) {
    return {
      runId,
      resumed: false,
      reason: "terminal or not found",
      completed: false,
      failed: false,
      timedOut: false,
    };
  }

  // D-F3：与 runBackground 同款 ownership 心跳（daemon resume 判活用）。
  writeOwnerHeartbeat(runDir, run.runId);
  const heartbeatTimer = setInterval(() => writeOwnerHeartbeat(runDir, run.runId), OWNER_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  let waitResult;
  try {
    waitResult = await run.waitForCompletion({
      waitTimeout: opts.waitTimeout,
      pollInterval: opts.pollInterval ?? 1000,
    });
  } finally {
    clearInterval(heartbeatTimer);
    clearOwner(runDir, run.runId);
  }

  return {
    runId: run.runId,
    resumed: true,
    completed: waitResult.completed ?? false,
    failed: waitResult.failed ?? false,
    timedOut: waitResult.timedOut ?? false,
    error: waitResult.error,
    observationDeadlineReached: run.observationDeadlineReached === true,
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
    // TD-99：pending 初始化走 transitionState（first-terminal-wins 仲裁）。
    // 若 rejected（runId 复用了旧终态 transcript），立即返回，不追加 startup error。
    const pendingResult = await transcript.transitionState(null, "pending", STATE_CHANGE_REASON.created);
    if (!pendingResult.accepted) return;
  }
  if (prompt && !events.some((event) => event.type === "prompt.sent")) {
    await transcript.append("prompt.sent", { prompt });
  }
  // R20 (TD-128 L3)：启动失败落盘前的终态检查绑定到本 run runId——append-only
  // 尾部的外 run 伪终态尾条不再压制启动失败的 run.error/failed 落盘（修复前
  // findState 末条胜出 → 提前 return，启动失败被静默吞掉）。不可归属（全无
  // 信封 legacy）→ pending 非终态 → 失败照常落盘（fail-closed 方向：宁可落盘
  // 失败事实，不静默吞掉）。
  if (TERMINAL_STATES.includes(findState(events.filter((event) => event && event.runId === runId)))) {
    return;
  }
  await transcript.append("run.error", { phase: "start", error: error.message ?? String(error) });
  // TD-99：failed 终态走 transitionState——若已被外部 abort（竞态），此处 rejected，不覆盖。
  await transcript.transitionState("pending", "failed", STATE_CHANGE_REASON.startup_error);
}

/**
 * CLI 入口：解析 argv 调 runBackground（或 resume 模式的 runResumeBackground）。
 * 供 detached 子进程调用。argv 形如：
 *   node backgroundRunner.js <agentId> --prompt "..." --run-dir D --registry F [--wait-timeout N]
 *   node backgroundRunner.js --resume-run-id <runId> --run-dir D --registry F [--wait-timeout N]
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

  // ADR-0030 实施批（TD-148 姊妹脸 (a)）：resume 接管模式。`resume <runId>` 不带
  // --wait 时 CLI 以 detached 形状 fork 本入口（--resume-run-id <runId>），runner
  // 持有续跑 handle 到自然终态。无需 delivery/reuse-worktree 解析（那是 start 派发
  // 面的输入校验；resume 的形状权威在既有 transcript）。
  if (opts["resume-run-id"]) {
    const result = await runResumeBackground({
      runId: opts["resume-run-id"],
      registry: opts.registry,
      runDir: opts["run-dir"],
      waitTimeout: opts["wait-timeout"] !== undefined ? Number(opts["wait-timeout"]) : undefined,
      globalWaitTimeout: opts["global-wait-timeout"] !== undefined ? Number(opts["global-wait-timeout"]) : undefined,
      pollInterval: Number(opts["poll-interval"] ?? 1000),
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  // M9-7A closeout: parse delivery JSON before entering runBackground. If it
  // fails, fail-closed — write a safe run.error + transition to failed. Never
  // leave a pending transcript, never spawn a worker with corrupt input.
  let parsedDelivery;
  if (opts["delivery-json"]) {
    try {
      parsedDelivery = JSON.parse(opts["delivery-json"]);
    } catch {
      // Malformed delivery JSON — fail closed with a fixed safe reason.
      const runDir = opts["run-dir"];
      const runId = opts["run-id"];
      if (runDir && runId) {
        const transcriptPath = join(runDir, `${runId}.jsonl`);
        try {
          let events = [];
          try { events = await readTranscript(transcriptPath); } catch { events = []; }
          const t = new JsonlTranscript(transcriptPath, {
            runId, agentId: agentId ?? "unknown",
            initialSeq: findLastEventSeq(events),
          });
          // R20 (TD-128 L3)：delivery-json 解析失败落盘前的终态检查绑定到本
          // run runId——外 run 伪终态尾条不再压制 run.error/failed 落盘。
          if (!TERMINAL_STATES.includes(findState(events.filter((e) => e && e.runId === runId)))) {
            await t.append("run.error", { phase: "delivery_parse", error: "malformed delivery JSON in runner argv" });
            await t.transitionState("pending", "failed", STATE_CHANGE_REASON.delivery_parse_error);
          }
        } catch { /* best effort — don't mask the original error */ }
      }
      const failResult = {
        runId: opts["run-id"] ?? "unknown",
        completed: false, failed: true, timedOut: false,
        error: "malformed delivery JSON in runner argv",
      };
      process.stdout.write(JSON.stringify(failResult) + "\n");
      return;
    }
  }

  // M12-7: parse + shape-validate the retained-worktree descriptor for a
  // Lead-authorized continuation. Malformed input fails closed — the child
  // transcript must not be left pending and no worker may spawn against a
  // corrupt descriptor. Mirrors the delivery-json fail-closed discipline.
  let parsedReuseWorktree;
  if (opts["reuse-worktree-json"]) {
    try {
      const parsed = JSON.parse(opts["reuse-worktree-json"]);
      if (!parsed || typeof parsed.path !== "string" || parsed.path.length === 0
        || typeof parsed.branch !== "string" || parsed.branch.length === 0) {
        throw new Error("shape");
      }
      parsedReuseWorktree = { path: parsed.path, branch: parsed.branch };
    } catch {
      const runDir = opts["run-dir"];
      const runId = opts["run-id"];
      if (runDir && runId) {
        const transcriptPath = join(runDir, `${runId}.jsonl`);
        try {
          let events = [];
          try { events = await readTranscript(transcriptPath); } catch { events = []; }
          const t = new JsonlTranscript(transcriptPath, {
            runId, agentId: agentId ?? "unknown",
            initialSeq: findLastEventSeq(events),
          });
          // R20 (TD-128 L3)：reuse-worktree 解析失败落盘前的终态检查同款绑定
          // （外 run 伪终态尾条不再压制 run.error/failed 落盘）。
          if (!TERMINAL_STATES.includes(findState(events.filter((e) => e && e.runId === runId)))) {
            await t.append("run.error", { phase: "reuse_worktree_parse", error: "malformed reuse-worktree JSON in runner argv" });
            await t.transitionState("pending", "failed", STATE_CHANGE_REASON.reuse_worktree_parse_error);
          }
        } catch { /* best effort — don't mask the original error */ }
      }
      const reuseFailResult = {
        runId: opts["run-id"] ?? "unknown",
        completed: false, failed: true, timedOut: false,
        error: "malformed reuse-worktree JSON in runner argv",
      };
      process.stdout.write(JSON.stringify(reuseFailResult) + "\n");
      return;
    }
  }

  const result = await runBackground({
    agentId,
    prompt: opts.prompt,
    registry: opts.registry,
    runDir: opts["run-dir"],
    runId: opts["run-id"],
    cwd: opts.cwd,
    waitTimeout: opts["wait-timeout"] !== undefined ? Number(opts["wait-timeout"]) : undefined,
    // M10-pre closeout: server-owned global config.waitTimeout (from --global-wait-timeout).
    // Never disguised as --wait-timeout — RunManager resolves precedence internally.
    globalWaitTimeout: opts["global-wait-timeout"] !== undefined ? Number(opts["global-wait-timeout"]) : undefined,
    pollInterval: Number(opts["poll-interval"] ?? 1000),
    scorecardRules: opts["scorecard-rules"] ? JSON.parse(opts["scorecard-rules"]) : undefined,
    scorecardMode: opts["scorecard-mode"],
    requireCertified: argv.includes("--require-certified"),
    delivery: parsedDelivery,
    isolate: argv.includes("--isolate"),
    // M11-11C: opaque reuse routing threaded from dispatchRun. A malformed
    // internal envelope fails closed: requested reuse must never silently turn
    // into a fresh conversation.
    sessionReuse: parseSessionReuseJson(opts["session-reuse-json"]),
    // M12-6 (P1-A): server-proven frozen HEAD threaded from dispatchRun. Absent
    // for CLI runs; present for MCP dispatch so RunManager.start can revalidate/
    // pin the base against a frozen-base TOCTOU.
    frozenGitHead: opts["frozen-git-head"],
    // M12-7: retained parent worktree descriptor {path, branch} for a
    // Lead-authorized continuation. Absent for ordinary dispatch.
    reuseWorktree: parsedReuseWorktree,
    // M12-16: correctable opt-in (boolean flag threaded from dispatchRun). The
    // runner tells RunManager.start to spawn a correctable child + drain the
    // correction queue. Absent for ordinary dispatch (byte-compatible).
    correctable: argv.includes("--correctable"),
    // Round 4 Bundle B: read-only declaration (boolean flag threaded from
    // dispatchRun --isolate --read-only). The runner tells RunManager.start to
    // force isolation + persist the declaration fact. Absent for ordinary
    // dispatch (byte-compatible).
    readOnly: argv.includes("--read-only"),
    // R10-A: per-dispatch model override (value flag threaded from dispatchRun
    // --model <id>). parseSimpleFlags yields undefined when the pair is absent
    // — the ordinary dispatch stays byte-compatible. RunManager.start owns the
    // shape re-check (SSOT) and the synthesis.
    modelOverride: opts.model,
    // R11-1: per-dispatch reasoning effort override (value flag threaded from
    // dispatchRun --reasoning <effort>). Same parseSimpleFlags semantics;
    // RunManager.start owns the closed-set re-check (SSOT) and the synthesis.
    reasoningOverride: opts.reasoning,
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

// M11-11C: parse + shape-validate the opaque reuse routing from the runner
// argv. Absence means a normal non-reuse run. A supplied value must match the
// closed routing shape or the runner fails with a fixed safe error.
function parseSessionReuseJson(raw) {
  if (!raw) return undefined;
  try {
    return validateSessionReuseRouting(JSON.parse(raw));
  } catch {
    throw new Error("sessionReuse: invalid internal routing envelope");
  }
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
