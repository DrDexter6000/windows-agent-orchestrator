import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { JsonlTranscript, TERMINAL_STATES, readTranscript, findState, findLatest } from "./transcript.js";
import { createWorktree, removeWorktree } from "./isolation.js";
import { checkScorecard } from "./scorecard.js";
import { raiseAlert } from "./alerts.js";
import { writeFrictionLog, frictionLogDirFromRunDir } from "./frictionLog.js";
import { assessRunEvidence } from "./runEvidenceAssessment.js";

/**
 * RunManager 持有活跃 run 的生命周期。
 * 显式状态机：pending → submitted → running → {completed|failed|aborted|timed_out}
 *
 * M0 临时桥接：通过 backend.waitForCompletion 驱动状态转移（而非消费 events 流）。
 * M1 会把 waitForCompletion 替换为消费 AsyncIterable<RunEvent>。
 *
 * 状态转移是代码判定的，绝不依赖 LLM 理解（核心原则）。
 */

// 进程级单例 SIGINT handler：无论创建多少个 RunManager，全局只注册一个 listener。
const activeManagers = new Set();
let sigintHandlerInstalled = false;

export async function gracefulShutdown(reason = "SIGINT") {
  await Promise.allSettled([...activeManagers].map((m) => m.abortAll(reason)));
}

function installSigintHandler() {
  if (sigintHandlerInstalled) return;
  sigintHandlerInstalled = true;
  process.on("SIGINT", async () => {
    await gracefulShutdown("SIGINT");
    process.exit(130);
  });
}

export class RunManager {
  constructor({ config, readRegistry, transcriptDir, backendFor }) {
    this.config = config;
    this.readRegistry = readRegistry;
    this.transcriptDir = transcriptDir;
    this.backendFor = backendFor;
    this.activeRuns = new Map();
  }

  _ensureSigintHandler() {
    activeManagers.add(this);
    installSigintHandler();
  }

  async abortAll(reason) {
    if (this.activeRuns.size === 0) return;
    const runs = [...this.activeRuns.values()];
    this.activeRuns.clear();
    await Promise.allSettled(runs.map((run) => run._abortInternal(reason)));
  }

  async start(agentId, options = {}) {
    const {
      prompt,
      cwd,
      registry,
      runId,
      runDir,
      tags,
      isolate,
      scorecard,
      // M8-1：默认 scorecard 模式。warn=默认开启(不阻塞,只留痕) | hard=升级硬闸 | off=完全关闭。
      scorecardMode = "warn",
      // fire-and-forget 语义：调用方是否会在 backend 起来后立即返回（不进 waitForCompletion）。
      // 默认 false = 安全（run/workflow/resume 等都会 wait 或由调用方管理生命周期）。
      // 仅 CLI spawnCommand 在不带 --wait 时显式传 true，触发 P0-1 护栏。
      fireAndForget = false,
      // P1-1 认证新鲜度强制门（opt-in，06-18 事故教训"调度安全不能建立在模型行为假设上"）。
      // 启用时：目标 worker 必须在 runDir/reliability-summary.json 里且 status=certified、
      // generatedAt 在 certFreshnessDays 内，否则拒绝派发。默认关（向后兼容 + 不破坏测试）。
      requireCertified = false,
      certFreshnessDays = 30,
    } = options;

    const registryPath = resolve(registry ?? this.config.registry);
    const loaded = await this.readRegistry(registryPath);
    const agent = loaded.getAgent(agentId, { cwd });

    const finalRunId = runId ?? `run_${new Date().toISOString().replace(/[-:.TZ]/g, "")}${Math.random().toString(36).slice(2, 8)}`;
    const dir = resolve(runDir ?? this.config.runDir);
    await mkdir(dir, { recursive: true });

    const transcript = new JsonlTranscript(join(dir, `${finalRunId}.jsonl`), {
      runId: finalRunId,
      agentId,
    });

    // 隔离：isolate flag > agent.isolation > config.defaultIsolation
    const isolationConfig = resolveIsolation(isolate, agent.isolation, this.config.defaultIsolation);
    let worktreeInfo = null;
    let effectiveCwd = agent.cwd;
    let cleanupFn = null;

    if (isolationConfig.type === "worktree") {
      try {
        worktreeInfo = await createWorktree(agent.cwd, finalRunId);
        effectiveCwd = worktreeInfo.path;
        if (isolationConfig.strategy === "ephemeral") {
          cleanupFn = () => removeWorktree(worktreeInfo.path);
        }
      } catch (error) {
        await transcript.append("run.isolation_failed", { error: error.message });
        // 降级：用原 cwd 继续
      }
    }

    // worktree 路径（若有）作为 backend 的 cwd
    const effectiveAgent = { ...agent, cwd: effectiveCwd };

    const tagsPayload = tags ? parseTags(tags) : undefined;
    const scorecardRules = resolveScorecardRules(scorecard, agent.scorecard, scorecardMode);

    await transcript.append("run.started", {
      backend: agent.backend,
      cwd: agent.cwd,
      ...(worktreeInfo ? { worktreePath: worktreeInfo.path, worktreeBranch: worktreeInfo.branch } : {}),
      serveUrl: agent.serveUrl,
      model: agent.model,
      scorecardConfigured: Boolean(scorecardRules),
      ...(tagsPayload ? { tags: tagsPayload } : {}),
    });
    const pendingResult = await this._transition(transcript, null, "pending", "created");
    // TD-99：若 pending rejected（runId 已有终态——如同 runId 复用旧终态 transcript），
    // 不得 spawn backend，立即报已有终态。
    if (!pendingResult.accepted) {
      if (cleanupFn) await safeCleanup(cleanupFn, transcript);
      throw new Error(`Cannot start run ${finalRunId}: transcript already in terminal state "${pendingResult.state}" (first-terminal-wins)`);
    }

    const backend = this.backendFor(effectiveAgent);

    // P1-1 认证新鲜度强制门（opt-in，06-18 事故教训"调度安全不能建立在模型行为假设上"）。
    // 启用时：读 runDir/reliability-summary.json，校验目标 worker。
    // 放行阈值（owner 决策 2026-06-24）：core 全过即放行 —— status ∈ {certified, conditional}。
    //   certified = core+strict+ops 全过；conditional = core 全过、strict/ops 部分。
    //   strict（command/file）是能力画像不是安全闸；core（completion/answer/sentinel）才是安全底线。
    //   draft-only（core 部分过）/rejected（core 失败）= 拒绝。
    // 例外：w.manualOverride === "cleared" 时强制放行（owner 手动背书，绕过 status——如 rate-limit 误判）。
    // opt-in 默认关：不破坏现有测试/使用；CI 或监督派发场景显式启用。
    const DISPATCHABLE = new Set(["certified", "conditional"]);
    if (requireCertified) {
      const summaryPath = join(dir, "reliability-summary.json");
      let summary = null;
      try { summary = JSON.parse(readFileSync(summaryPath, "utf8")); } catch { /* 缺 summary = 未认证 */ }
      const w = summary?.workers?.[agentId];
      const reasons = [];
      if (!summary) reasons.push("reliability-summary.json 不存在");
      else if (!w) reasons.push(`worker "${agentId}" 未在 reliability-summary 中`);
      else if (w.manualOverride === "cleared") {
        // owner 手动背书，放行（不检查 status / 新鲜度——人判断优先）
      } else if (!DISPATCHABLE.has(w.status)) {
        reasons.push(`status=${w.status}（需 core 全过：certified/conditional，或 manualOverride=cleared）`);
      } else {
        const ageDays = (Date.now() - new Date(summary.generatedAt).getTime()) / 86_400_000;
        if (Number.isFinite(ageDays) && ageDays > certFreshnessDays) {
          reasons.push(`认证已过期（generatedAt=${summary.generatedAt}, ${Math.round(ageDays)}天 > ${certFreshnessDays}天）`);
        }
      }
      if (reasons.length > 0) {
        await transcript.append("run.error", { phase: "certification-gate", agentId, reasons });
        await this._transition(transcript, "pending", "failed", "certification_gate");
        if (cleanupFn) await safeCleanup(cleanupFn, transcript);
        throw new Error(
          `Refused dispatch: worker "${agentId}" did not pass core certification — ${reasons.join("; ")}. `
          + `Run \`npm run reliability -- --agent ${agentId}\` to certify, or set manualOverride:"cleared" if owner-backed. `
          + `(06-18 lesson: dispatch safety must not rely on model-behavior assumptions). See docs/team-roles.md.`
        );
      }
    }

    // P0-1 护栏（审计 P0 / TD-39 / 2026-06-18 事故）：
    // fire-and-forget + sessionOutlivesProcess 的 backend = 孤儿 session（不经 waitForCompletion
    // 内的三层防线）= 06-18 事故路径。CLI 已在 P2 改为路由 --background runner 托管（不再裸 fire-and-forget），
    // 此处保留作**深度防御**：直接编程调 RunManager（绕过 CLI）仍不可造孤儿。按 backend 属性判定（runtime-agnostic）。
    if (fireAndForget && backend.sessionOutlivesProcess) {
      await transcript.append("run.error", {
        phase: "fire-and-forget-guard",
        backend: agent.backend,
      });
      await this._transition(transcript, "pending", "failed", "fire_forget_guard");
      if (cleanupFn) await safeCleanup(cleanupFn, transcript);
      throw new Error(
        `Refused fire-and-forget spawn: backend "${agent.backend}" holds sessions outside the WAO process `
        + `(sessionOutlivesProcess=true). Without an owner driving waitForCompletion, this run would bypass `
        + `the token-budget gate, event polling, and cleanup abort — the exact path of the 2026-06-18 quota-drain `
        + `incident (7.4h runaway session). Either call waitForCompletion, or use the detached background runner `
        + `(\`run/spawn --background\`) which owns the lifecycle. See docs/incidents/2026-06-18-glm-quota-drain.md + TD-39.`
      );
    }

    // TD-54 修复（spawn-failure race）：prompt.sent 必须在 backend.spawn 之前持久化。
    // 原 bug：prompt.sent 写在 spawn 之后（下方 line ~206），spawn 失败时 RunManager.start
    // 先写 terminal failed（spawn_error）再 throw，prompt.sent 永远不会从这里写——
    // 靠 backgroundRunner 的 writeStartupFailureTranscript 兜底，但那时 failed 已落盘，
    // 测试（及任何轮询 transcript 的消费者）可能在 failed 之后、prompt.sent 之前快照，
    // 拿不到 prompt。修复：spawn 前先写 prompt.sent {prompt}（不含 messageId，spawn 前还没有），
    // spawn 成功后再写第二条含 messageId/admittedSeq 的 prompt.sent；resume/retry 用 findLatest
    // 取最后一条（含 messageId），保证 opencode-serve resume 拿得到 messageId。
    await transcript.append("prompt.sent", { prompt });

    let result;
    try {
      result = await backend.spawn(effectiveAgent, { prompt });
    } catch (error) {
      await transcript.append("run.error", { phase: "spawn", error: error.message });
      await this._transition(transcript, "pending", "failed", "spawn_error");
      if (cleanupFn) await safeCleanup(cleanupFn, transcript);
      throw error;
    }
    await transcript.append("session.created", {
      backend: result.backend,
      backendSessionId: result.backendSessionId,
      serveUrl: agent.serveUrl,
    });
    // spawn 成功后补写带 messageId/admittedSeq 的 prompt.sent（resume opencode-serve 流需要 messageId）。
    // 此时已过 spawn 失败分支，不会产生"terminal 先于 prompt.sent"的 race。
    await transcript.append("prompt.sent", {
      messageId: result.messageId,
      admittedSeq: result.admittedSeq,
      prompt,
    });
    await transcript.append("run.submitted", {});
    const submittedResult = await this._transition(transcript, "pending", "submitted", "spawned");
    // TD-99：若 submitted rejected（spawn 期间外部写了终态，如 stop/abort），best-effort
    // abort 新 handle、执行 cleanup、不注册 activeRuns、抛明确错误。
    if (!submittedResult.accepted) {
      try { await result.abort?.(); } catch { /* best-effort */ }
      if (cleanupFn) await safeCleanup(cleanupFn, transcript);
      throw new Error(`Run ${finalRunId} became terminal "${submittedResult.state}" during spawn (first-terminal-wins); new handle aborted`);
    }

    const run = new Run({
      runId: finalRunId,
      agentId,
      agent,
      backend,
      handle: result,
      transcript,
      result,
      config: this.config,
      onRemove: () => this.activeRuns.delete(finalRunId),
      cleanup: cleanupFn,
      effectiveCwd,
      scorecardRules,
    });
    this.activeRuns.set(finalRunId, run);
    this._ensureSigintHandler();
    return run;
  }

  async resume(runId, options = {}) {
    const { runDir } = options;
    const dir = resolve(runDir ?? this.config.runDir);
    const transcript = new JsonlTranscript(join(dir, `${runId}.jsonl`), {
      runId,
      agentId: "unknown",
    });
    const events = await readTranscript(transcript.filePath);
    if (events.length === 0) {
      return null;
    }
    transcript.context.agentId = events[0]?.agentId ?? "unknown";
    transcript.seq = events.at(-1)?.seq ?? 0;

    const state = findState(events);
    if (TERMINAL_STATES.includes(state)) {
      return null;
    }

    const session = events.find((e) => e.type === "session.created");
    const runStarted = events.find((e) => e.type === "run.started");
    if (!session?.backendSessionId || !runStarted) {
      return null;
    }

    const registryPath = resolve(options.registry ?? this.config.registry);
    const loaded = await this.readRegistry(registryPath);
    const agent = loaded.getAgent(transcript.context.agentId, { cwd: runStarted.cwd });
    const backend = this.backendFor(agent);

    // 进程式 backend（进程已死）→ 重放 prompt 重新 spawn
    const isProcess = runStarted.backend === "claude-code" || runStarted.backend === "codex" || runStarted.backend === "kimi-code";
    if (isProcess) {
      // TD-54：prompt.sent 可能写两条，取最后一条（两条都有 .prompt，无差别）。
      const promptEvent = findLatest(events, "prompt.sent");
      if (!promptEvent?.prompt) return null;
      const originalSessionId = session.backendSessionId;
      // 重新 spawn 新进程
      const newResult = await backend.spawn(agent, { prompt: promptEvent.prompt });
      await transcript.append("run.rerun", {
        originalSessionId,
        newSessionId: newResult.backendSessionId,
        reason: "replay",
      });
      await this._transition(transcript, state, "submitted", "replay_respawned");
      const run = new Run({
        runId,
        agentId: transcript.context.agentId,
        agent,
        backend,
        handle: newResult,
        transcript,
        result: newResult,
        config: this.config,
        onRemove: () => this.activeRuns.delete(runId),
        initialState: "submitted",
      });
      this.activeRuns.set(runId, run);
      this._ensureSigintHandler();
      return run;
    }

    // HTTP 类 backend（opencode-serve）→ attach 到已有 session
    const serveUrl = agent.serveUrl;
    const sessionId = session.backendSessionId;
    const cwd = runStarted.cwd;
    const handle = {
      backend: session.backend,
      backendSessionId: sessionId,
      // TD-54 修复：prompt.sent 现在可能写两条（spawn 前 {prompt} + spawn 后 {messageId,...}），
      // resume 取最后一条才有 messageId（opencode-serve resume 流需要）。
      messageId: findLatest(events, "prompt.sent")?.messageId,
      admittedSeq: findLatest(events, "prompt.sent")?.admittedSeq,
      events: (signal, opts) => backend.streamEvents(serveUrl, sessionId, { cwd, signal, interval: opts?.pollInterval }),
      abort: async () => backend.abort(serveUrl, sessionId),
    };

    const run = new Run({
      runId,
      agentId: transcript.context.agentId,
      agent,
      backend,
      handle,
      transcript,
      result: handle,
      config: this.config,
      onRemove: () => this.activeRuns.delete(runId),
      initialState: state,
    });
    this.activeRuns.set(runId, run);
    this._ensureSigintHandler();
    return run;
  }

  async abort(runId, reason = "user") {
    const run = this.activeRuns.get(runId);
    if (!run) return false;
    this.activeRuns.delete(runId);
    await run._abortInternal(reason);
    return true;
  }

  list() {
    return [...this.activeRuns.values()];
  }

  async _transition(transcript, from, to, reason) {
    // TD-99：走原子终态仲裁。accepted 才触发 friction hook；rejected 同步不触发。
    const result = await transcript.transitionState(from, to, reason);
    if (result.accepted) {
      // TD-92 debug mode：预生成失败（certification_gate/fire_forget_guard/spawn_error）也捕获 friction
      if (to === "failed" || to === "timed_out" || to === "aborted") {
        const ctx = transcript.context ?? {};
        _maybeWriteFrictionLogFromTranscript(transcript, ctx.runId, ctx.agentId, this.config).catch(() => {});
      }
    }
    return result;
  }
}

/**
 * TD-92：RunManager 层的 friction 捕获（预生成失败路径，无 Run 实例）。
 * 从 transcript 读 events + 调 writeFrictionLog。fire-and-forget，不阻塞。
 */
async function _maybeWriteFrictionLogFromTranscript(transcript, runId, agentId, config) {
  const events = await readTranscript(transcript.filePath);
  const frictionLogDir = frictionLogDirFromRunDir(config.runDir);
  await writeFrictionLog(runId ?? "unknown", agentId ?? "unknown", events, {
    frictionLogDir,
    debugMode: config.debugMode,
  });
}

function parseTags(tags) {
  const arr = Array.isArray(tags) ? tags : [tags];
  return arr.reduce((acc, t) => {
    const [key, ...rest] = t.split("=");
    acc[key] = rest.join("=");
    return acc;
  }, {});
}

/**
 * 解析隔离配置。优先级：isolate flag > agent.isolation > config default。
 * isolate flag: true=worktree(persistent), false=none
 * agent.isolation: "worktree" | "none" | { type, strategy }
 * 返回 { type: "worktree"|"none", strategy: "persistent"|"ephemeral" }
 */
function resolveIsolation(isolate, agentIsolation, defaultIsolation) {
  // flag 最高优先
  if (isolate === true) return { type: "worktree", strategy: "persistent" };
  if (isolate === false) return { type: "none", strategy: "persistent" };
  // agent 配置
  if (agentIsolation) {
    if (typeof agentIsolation === "string") {
      return { type: agentIsolation, strategy: "persistent" };
    }
    return {
      type: agentIsolation.type ?? "none",
      strategy: agentIsolation.strategy ?? "persistent",
    };
  }
  // config 默认
  return { type: defaultIsolation ?? "none", strategy: "persistent" };
}

/** 安全执行 cleanup，失败只记 transcript 不抛错 */
async function safeCleanup(cleanupFn, transcript) {
  try {
    await cleanupFn();
  } catch (error) {
    await transcript.append("run.cleanup_error", { phase: "spawn_fail", error: error.message });
  }
}

/**
 * 解析 scorecard rules（M6-6 + M8-1 默认 warn）。优先级：
 *   显式 options.scorecard > agent.scorecard > scorecardMode 决定的默认 > null
 *
 * M8-1：未传显式 rules 时，按 scorecardMode 决定默认行为（把"防伪完成"从 opt-in 升级为默认）：
 *   - "warn"（默认）：返回 { requireEvidence:true, mode:"warn" } —— 不阻塞完成，只记留痕
 *   - "hard"：返回 { requireEvidence:true, mode:"hard" } —— 无证据 → failed（升级硬闸）
 *   - "off"：返回 null —— 完全关闭（恢复旧 opt-in 行为，向后兼容）
 * 显式 scorecard 不受默认影响（显式优先）。
 *
 * null 表示不开启 scorecard（无 rules = 当前行为不变）。
 * @returns {object|null} rules 对象，或 null（不门控）
 */
function resolveScorecardRules(optionsScorecard, agentScorecard, scorecardMode = "warn") {
  if (optionsScorecard) return optionsScorecard.rules ?? {};
  if (agentScorecard) return agentScorecard.rules ?? {};
  // M8-1：无显式 rules 时按 scorecardMode 决定默认。off = 完全关闭（向后兼容）。
  if (scorecardMode === "off") return null;
  const mode = scorecardMode === "hard" ? "hard" : "warn"; // 默认 + 未知值都降级为 warn
  return { requireEvidence: true, mode };
}

/**
 * Run 是单个运行的句柄。M1 起通过消费 handle.events 流驱动状态机。
 */
export class Run {
  constructor({
    runId,
    agentId,
    agent,
    backend,
    handle,
    transcript,
    result,
    config,
    onRemove,
    initialState = "submitted",
    cleanup = null,
    effectiveCwd = null,
    scorecardRules = null,
  }) {
    this.runId = runId;
    this.agentId = agentId;
    this.agent = agent;
    this.backend = backend;
    this.handle = handle;
    this.transcript = transcript;
    this.result = result;
    this.config = config;
    this.onRemove = onRemove;
    this.state = initialState;
    this._aborted = false;
    this._removed = false;
    this._cleanup = cleanup;
    this._cleaned = false;
    // 会话兜底 abort 标志（事故修复 2026-06-17）：HTTP 类 backend 的 serve session
    // 在 run 结束后可能继续生成。对无限多轮模型（DeepSeek-v4-flash）是 quota 黑洞。
    // _runCleanup 必须兜底调一次 handle.abort，此 flag 保证只调一次（user-abort 路径
    // 已通过 _abortInternal 调过，不重复）。注意：这只证明已发送 abort，不证明后台静默。
    this._sessionKilled = false;
    this.effectiveCwd = effectiveCwd ?? agent.cwd;
    this.scorecardRules = scorecardRules;
  }

  /**
   * 消费 handle.events 流驱动状态机（M1：events 驱动，替代 M0 桥接）。
   *
   * 职责分工（M1 决策）：
   *   - done 事件由 backend emit（backend 知道何时完成）
   *   - 超时由 RunManager 管（AbortController 打断 events 流）
   */
  async waitForCompletion(options = {}) {
    const waitTimeout = Number(options.waitTimeout ?? this.config.waitTimeout);
    const pollInterval = Number(options.pollInterval ?? this.config.pollInterval);
    // silentTimeout：静默无响应早失败（Kimi 白名单 / 不存在的 model）。
    // 来源优先级：options（CLI flag）> agent.silentTimeout（registry）> config > undefined（不启用）
    const silentTimeout = options.silentTimeout ?? this.agent?.silentTimeout ?? this.config.silentTimeout;

    // token 预算硬闸门（S1-1，事故修复 2026-06-18）：唯一不依赖 abort 是否生效的防线。
    // opencode session.tokens 比 provider 账单偏小 1-2 数量级（cache read/context 重发不计），
    // 故用 multiplier（默认 100，来自 06-18 事故 DB 172万 vs 账单 1.25亿 ≈ ×73，取 100 留余量）逼近。
    // 未配 tokenBudget → 闸门不启用（向后兼容）。触发即终态 failed，不可恢复。
    const tokenBudget = options.tokenBudget ?? this.agent?.tokenBudget ?? this.config.tokenBudget;
    const tokenBudgetMultiplier = options.tokenBudgetMultiplier
      ?? this.agent?.tokenBudgetMultiplier ?? this.config.tokenBudgetMultiplier ?? 100;

    // RunManager 持有超时计时器，到点 abort signal 打断 events 流。
    // 调用方可传外部 signal（如 daemon 的 per-run 控制器）：外部 abort 同样打断 events 流。
    // 用 AbortSignal.any 合并 waitTimeout 控制器与外部 signal（Node 20+ 原生）。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), waitTimeout);
    if (options.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }

    const messages = [];
    const evidence = [];
    let doneReason = null;
    let doneError = null;
    let timedOut = false;
    let metrics = null;
    let budgetExceeded = false;
    let budgetUsed = 0;
    const markRunningOnce = async (reason) => {
      if (this.state !== "running" && !TERMINAL_STATES.includes(this.state)) {
        await this._transition(this.state, "running", reason);
      }
    };

    try {
      for await (const ev of this.handle.events(controller.signal, { pollInterval, silentTimeout })) {
        // 若已被 abort，停止处理后续事件（避免覆盖 aborted 状态）
        if (this._aborted) break;
        // TD-99：若 _transition 把内存 state 同步为终态（外部写了终态，仲裁 rejected），
        // 不再消费后续 backend events。
        if (TERMINAL_STATES.includes(this.state)) {
          doneReason = null;
          break;
        }
        if (ev.kind === "message") {
          // 首个 message → 转 running
          await markRunningOnce("first_message");
          messages.push({ info: { role: ev.role }, parts: ev.parts });
          // N4 修复：message 事件落 transcript（run.event, kind=message）。
          // 原 bug：只 push 内存数组不落盘 → transcript（source of truth）重建不出
          // worker 文字产出（collect/事后审计拿不到 assistant text）。tool 证据早就在落，
          // 这里补齐文字产出，使 transcript 完整可重建。影响所有 backend。
          const { kind, ...msgRest } = ev;
          await this.transcript.append("run.event", { kind, ...msgRest });
        } else if (ev.kind === "metrics") {
          await markRunningOnce("first_event");
          metrics = ev;
          await this.transcript.append("run.metrics", { tokens: ev.tokens, ...(ev.costUsd !== undefined ? { costUsd: ev.costUsd } : {}) });
          // 预算闸门检查：累计 effective tokens，超限即标记并打断循环。
          // tokens 是 session 级累计值（非增量），直接比对即可。
          if (typeof tokenBudget === "number" && ev.tokens) {
            const t = ev.tokens;
            budgetUsed = (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0);
            const effective = budgetUsed * tokenBudgetMultiplier;
            if (effective > tokenBudget) {
              budgetExceeded = true;
              break;
            }
          }
        } else if (ev.kind === "done") {
          doneReason = ev.reason;
          doneError = ev.error;
          break;
        } else if (
          ev.kind === "command" ||
          ev.kind === "file_written" ||
          ev.kind === "tool_use" ||
          ev.kind === "tool_result"
        ) {
          await markRunningOnce("first_event");
          // 证据链事件（M6-2）：落盘到 transcript run.event，收集供 scorecard 核验。
          // 不触发状态转移（和 metrics 一样是旁路信息）。
          const { kind, ...rest } = ev;
          await this.transcript.append("run.event", { kind, ...rest });
          evidence.push(ev);
        }
      }
      // 流自然结束（非 break）= signal 被 abort = 超时
      if (doneReason === null && controller.signal.aborted) {
        timedOut = true;
      }
    } finally {
      clearTimeout(timer);
    }

    this._removeFromManager();

    if (this._aborted) {
      await this._runCleanup();
      return { completed: false, messages, evidence, timedOut: false, metrics };
    }

    const externalTerminalState = await this._externalTerminalState();
    if (externalTerminalState) {
      this.state = externalTerminalState;
      await this._runCleanup();
      return {
        completed: externalTerminalState === "completed",
        failed: externalTerminalState === "failed",
        aborted: externalTerminalState === "aborted",
        messages,
        evidence,
        timedOut: externalTerminalState === "timed_out",
        metrics,
      };
    }

    // 预算硬闸门（S1-1）：超限即转 failed + 兜底 abort。独立于 done/timeout，
    // 优先级最高——即使 backend 想报 completed，超预算就是超预算。
    if (budgetExceeded) {
      await this.transcript.append("run.budget_exceeded", {
        budget: tokenBudget,
        used: budgetUsed,
        multiplier: tokenBudgetMultiplier,
        backendSessionId: this.result.backendSessionId,
      });
      // S1-3 告警：超预算是重大事件，立即弹窗 + 写 ALERTS.log（告警失败不阻塞终态）
      raiseAlert("budget",
        `token budget exceeded: used ${budgetUsed}×${tokenBudgetMultiplier} > ${tokenBudget}`,
        { runId: this.runId, logPath: join(this.config.runDir, "ALERTS.log") },
      ).catch(() => { /* 告警失败不影响终态 */ });
      const tResult = await this._transition(this.state, "failed", "budget_exceeded");
      await this._runCleanup();
      // TD-99：若输给先到的终态（如外部 abort），返回与现有终态一致的结果。
      if (!tResult.accepted) return _loserResult(tResult.state, { messages, evidence, metrics, budgetExceeded: true });
      return { completed: false, messages, evidence, timedOut: false, metrics, budgetExceeded: true };
    }

    if (doneReason === "completed") {
      // scorecard 门控（M6-6，opt-in）：有 rules 才检查。
      // agent 自报完成只是必要条件，scorecard 验过证据才是充分条件。
      // 不通过 → 转 failed（gate 默认）；P4 决策C：rules.mode==="warn" 时仅记 scorecard.warn
      // 不阻断，run 仍 completed（渐进引导而非硬拦；防伪完成的 requireEvidence 默认可走 warn）。
      if (this.scorecardRules) {
        // 证据事件转成 scorecard 需要的 transcript 事件格式
        const scorecardEvents = [
          ...evidence.map((e) => ({ type: "run.event", ...e })),
          // 附带 messages 供 requireAssistantText 检查（纵深防御：防 completed 但无 text 答案）
          ...messages.map((m) => ({ type: "run.message", role: m.info?.role, parts: m.parts })),
          { type: "run.completed" },
        ];
        const scResult = await checkScorecard({
          events: scorecardEvents,
          cwd: this.effectiveCwd,
          rules: this.scorecardRules,
        });
        await this.transcript.append("scorecard.checked", {
          passed: scResult.passed,
          checks: scResult.checks,
        });
        if (!scResult.passed) {
          const detail = scResult.checks
            .filter((c) => !c.passed)
            .map((c) => `${c.name}: ${c.detail ?? "failed"}`)
            .join("; ");
          // P4 决策C：warn-only。记 warn 事件但不转 failed，继续走 completed。
          if (this.scorecardRules.mode === "warn") {
            await this.transcript.append("scorecard.warn", { detail, checks: scResult.checks });
          } else {
            await this.transcript.append("run.error", { phase: "scorecard", detail });
            const tResult = await this._transition(this.state, "failed", "scorecard_failed");
            await this._runCleanup();
            if (!tResult.accepted) return _loserResult(tResult.state, { messages, evidence, metrics, scorecard: scResult });
            return { completed: false, messages, evidence, timedOut: false, metrics, scorecard: scResult };
          }
        }
      }
      // TD-99：run.completed 与 completed state_change 同批原子提交（factEvents）。
      // rejected 时不留 run.completed fact。
      const tResult = await this._transition(this.state, "completed", "done", {
        factEvents: [{
          type: "run.completed",
          payload: {
            backendSessionId: this.result.backendSessionId,
            messageCount: messages.length,
          },
        }],
      });
      await this._runCleanup();
      // TD-99：若输给先到的终态，返回与现有终态一致的结果。
      if (!tResult.accepted) return _loserResult(tResult.state, { messages, evidence, metrics });
      return { completed: true, messages, evidence, timedOut: false, metrics };
    }
    if (doneReason === "failed") {
      // TD-95 #5 复盘：backend 崩了但证据可能已齐（worker 写了文件 + 跑了测试 exit0）。
      // 终态仍 failed（不撒谎——backend 确实崩了），但写 run.evidence_audit 让 Lead 知道
      // "证据其实通过了，任务可能做对了，需人工确认"。诊断靠 Lead，不自动改终态。
      const auditResult = _auditEvidenceOnFailure(evidence, messages);
      if (auditResult.passed) {
        await this.transcript.append("run.evidence_audit", {
          passed: true,
          note: "backend failed but evidence passed (file_written/command exit0 present) — task may be correct, verify manually",
          checks: auditResult.checks,
        });
      }
      await this.transcript.append("run.error", { phase: "wait", error: doneError ?? "unknown" });
      const tResult = await this._transition(this.state, "failed", "backend_error");
      await this._runCleanup();
      // TD-99：failed claim 若输给先到的 aborted/completed/timed_out，不再 throw failed；
      // 返回与现有终态一致的结构化结果（loser 不改终态）。
      if (!tResult.accepted) return _loserResult(tResult.state, { messages, evidence, metrics });
      throw new Error(doneError ?? "backend reported failure");
    }
    // timedOut（controller abort 导致流结束，无 done 事件）
    // TD-99：run.timed_out 与 timed_out state_change 同批原子提交（factEvents）。
    const tResult = await this._transition(this.state, "timed_out", "timeout", {
      factEvents: [{
        type: "run.timed_out",
        payload: { backendSessionId: this.result.backendSessionId },
      }],
    });
    await this._runCleanup();
    if (!tResult.accepted) return _loserResult(tResult.state, { messages, evidence, metrics });
    return { completed: false, messages, evidence, timedOut: true, metrics };
  }

  async abort(reason = "user") {
    this._removeFromManager();
    await this._abortInternal(reason);
  }

  /**
   * 从 RunManager 的 activeRuns 移除自己。幂等：只执行一次。
   * 防止 waitForCompletion 错误路径与 abort 路径同时触发导致 onRemove 被调两次。
   */
  _removeFromManager() {
    if (this._removed) return;
    this._removed = true;
    if (this.onRemove) this.onRemove();
  }

  async _externalTerminalState() {
    try {
      const events = await readTranscript(this.transcript.filePath);
      const state = findState(events);
      return TERMINAL_STATES.includes(state) ? state : null;
    } catch {
      return null;
    }
  }

  /** 终态时清理 worktree（ephemeral 策略）。幂等，失败不阻塞。 */
  async _runCleanup() {
    // 会话兜底 abort（事故修复 2026-06-17）：无论哪条终态路径（completed/failed/
    // timed_out/user-abort），清理时都必须向 serve 端 session 发送 abort。
    // HTTP 类 backend（opencode-serve）的 session 不一定随 run 结束自行死——
    // 对无限多轮模型（DeepSeek-v4-flash）会持续烧 token 直到 quota 耗尽。
    // handle.abort 幂等：user-abort 路径已调过则 _sessionKilled 挡住重复调用；
    // 进程式 backend abort 是 no-op（进程已死），不报错。
    if (!this._sessionKilled) {
      this._sessionKilled = true;
      try {
        await this.handle?.abort?.();
      } catch {
        // 兜底 abort 失败不影响已定的终态（和 _abortInternal 一致：状态机以意图为准）
      }
      // C6（TD-38，审计 P0 收口）：opencode 类 backend 的 abort 可能虚假成功（06-18 事故根因）。
      // _runCleanup 是 waitForCompletion 终态后的兜底路径（TD-35 修），此处的 abort 同样要验证。
      // 复用 verifyStopQuiet：abort 后轮询 session/message，未停则标记 + 告警（不阻断终态）。
      // 只对有 session/messages 方法的 backend（opencode 类）验证；进程式（claude-code/kimi/codex）
      // abort 是 no-op 且进程已死，跳过验证。
      await this._verifyStopQuietIfCapable().catch(() => { /* 验证失败不影响终态 */ });
    }
    if (this._cleaned || !this._cleanup) return;
    this._cleaned = true;
    try {
      await this._cleanup();
      await this.transcript.append("run.cleanup_done", {});
    } catch (error) {
      await this.transcript.append("run.cleanup_error", { error: error.message });
    }
  }

  /**
   * C6（TD-38）：_runCleanup 的 abort 后静默验证（仅 opencode 类 backend）。
   * 判断 handle 是否有 session/messages 方法（opencode 有，进程式无）。
   * 有则复用 verifyStopQuiet 验证后台是否真停；未停写 run.stop_unverified + 告警。
   * 失败/无能力 → 降级，不阻断终态。
   */
  async _verifyStopQuietIfCapable() {
    const h = this.handle;
    if (!h || typeof h.session !== "function" || typeof h.messages !== "function") {
      return; // 进程式 backend（无 session endpoint），进程已死，无需验证
    }
    // opencode 类：取 serveUrl + sessionId 用于验证
    const serveUrl = this.result?.serveUrl;
    const sessionId = this.result?.backendSessionId;
    if (!serveUrl || !sessionId) return;
    const { verifyStopQuiet } = await import("./backends/opencodeStopVerify.js");
    const result = await verifyStopQuiet(h, serveUrl, sessionId, {
      cwd: this.result?.cwd, rounds: 3, intervalMs: 2000,
    });
    if (result.quiet) {
      await this.transcript.append("run.stop_verified", { backendSessionId: sessionId, path: "_runCleanup" });
    } else {
      await this.transcript.append("run.stop_unverified", {
        backendSessionId: sessionId, path: "_runCleanup", delta: result.delta, metric: result.metric,
      });
      // 告警：_runCleanup 路径的 abort 未验证，后台可能仍在烧（TD-38 缺口）
      raiseAlert("stop_unverified",
        `_runCleanup stop not verified (run ${this.runId}): backend may still be running`,
        { runId: this.runId, logPath: join(this.config.runDir, "ALERTS.log") },
      ).catch(() => { /* 告警失败不影响终态 */ });
    }
  }

  async _abortInternal(reason) {
    this._aborted = true;
    // 标记会话已被显式 abort，_runCleanup 兜底时不再重复调（幂等）
    this._sessionKilled = true;
    let abortError;
    try {
      // 优先用 handle.abort（封装了 serveUrl/sessionId），fallback 到 backend.abort
      if (this.handle?.abort) {
        await this.handle.abort();
      } else {
        await this.backend.abort(this.agent.serveUrl, this.result.backendSessionId);
      }
    } catch (error) {
      abortError = error.message ?? "abort_failed";
    }
    // TD-99：run.aborted 与 aborted state_change 同批原子提交（factEvents）。
    // rejected 时不留 run.aborted fact（输给先到的终态）。
    // 无论 backend.abort 成功与否，run 都进入 aborted 状态（状态机以意图为准，不以后端成败为准）。
    await this._transition(this.state, "aborted", reason, {
      factEvents: [{
        type: "run.aborted",
        payload: {
          backendSessionId: this.result.backendSessionId,
          reason,
          ...(abortError ? { error: abortError } : {}),
        },
      }],
    });
    await this._runCleanup();
  }

  async _transition(from, to, reason, options = {}) {
    // TD-99：走原子终态仲裁（first-terminal-wins）。
    // accepted：this.state = to + 触发 friction hook。terminal fact（run.completed/
    //   run.timed_out/run.aborted）通过 options.factEvents 与 state_change 同批原子提交。
    // rejected：this.state 同步为现有终态（不复活），不写任何 terminal fact，返回结果
    //   让调用方据现有终态分支。
    const result = await this.transcript.transitionState(from, to, reason, options);
    if (result.accepted) {
      this.state = to;
      // TD-92 debug mode：失败终态自动捕获 friction（镜像 raiseAlert，fire-and-forget 不阻塞终态）
      if (to === "failed" || to === "timed_out" || to === "aborted") {
        _maybeWriteFrictionLog(this).catch(() => {});
      }
    } else {
      // 输给先到的终态——同步 this.state，不改终态。
      this.state = result.state;
    }
    return result;
  }
}

/**
 * TD-99：构造"loser 结果"——当 _transition rejected（输给先到的终态）时，
 * waitForCompletion 各终态路径返回与现有终态一致的结构化结果。
 * 不改终态，不 throw failed——loser 尊重 first-terminal-wins。
 */
function _loserResult(existingTerminal, base) {
  return {
    ...base,
    completed: existingTerminal === "completed",
    failed: existingTerminal === "failed",
    aborted: existingTerminal === "aborted",
    timedOut: existingTerminal === "timed_out",
  };
}

/**
 * TD-92：读 transcript + 调 writeFrictionLog。fire-and-forget，失败降级不阻塞终态。
 * 在 Run._transition 的失败终态路径调用。不抛——friction 捕获失败只是少一个 log 文件。
 */
async function _maybeWriteFrictionLog(run) {
  const events = await readTranscript(run.transcript.filePath);
  const frictionLogDir = frictionLogDirFromRunDir(run.config.runDir);
  // metrics 从 transcript 提取（最后一条 run.metrics）
  const metricsEvent = [...events].reverse().find((e) => e.type === "run.metrics");
  const metrics = metricsEvent ? {
    costUsd: metricsEvent.costUsd,
    tokens: metricsEvent.tokens?.total,
    durationMs: metricsEvent.durationMs,
  } : {};
  await writeFrictionLog(run.runId, run.agentId, events, {
    frictionLogDir,
    debugMode: run.config.debugMode,
    metrics,
  });
}

/**
 * TD-95 #5 / TD-97：backend done(failed) 时审计已累积的证据。
 *
 * TD-97：复用 assessRunEvidence（SSOT），不再自己判 file_written/command/assistant text。
 * 不跑完整 scorecard（hasDoneEvent 会 fail——failed 路径无 run.completed 事件）。
 * 只查"正面证据信号"：有 file_written 或 command(exitCode===0) → passed:true。
 *
 * 目的：worker 可能写对了文件 + 跑对了测试，只是 backend 进程退出码非零。
 * 让 Lead 知道"证据其实通过了"，而非被迫从 raw transcript 手动翻找。
 *
 * @param {object[]} evidence — waitForCompletion 累积的 evidence 数组（RunEvent 形状 {kind,...}）
 * @param {object[]} messages — 累积的 messages（内存形状 {info:{role},parts}）
 * @returns {{passed: boolean, checks: object[]}}
 */
function _auditEvidenceOnFailure(evidence, messages) {
  // TD-97：合并 evidence + messages 后调统一评估（assessRunEvidence 兼容三种形状）
  const all = [...(evidence ?? []), ...(messages ?? [])];
  const a = assessRunEvidence(all);
  const checks = [
    { name: "evidence_file_written", passed: a.hasFileWritten },
    { name: "evidence_command_exit0", passed: a.hasCommandExit0 },
    { name: "evidence_assistant_text", passed: a.hasAssistantText },
  ];
  // passed = 有产出证据（文件写入 或 命令成功）——任一即说明 worker 做了实事
  const passed = a.hasFileWritten || a.hasCommandExit0;
  return { passed, checks };
}
