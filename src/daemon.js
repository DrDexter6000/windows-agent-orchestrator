// src/daemon.js
//
// P3-T1（M7）：持久 daemon + 命名管道 IPC。
//
// 定位：P2 detached runner 的常驻化。daemon 是一个长期存活的 detached 进程，
// 持有 N 个 in-flight run（复用 runBackground 核心驱动 waitForCompletion，
// 不重写生命周期逻辑），通过命名管道（ADR 0012）暴露窄协议 IPC。
//
// 06-18 事故教训的直接投射：daemon 不只"能起"，还得"能知道它还活着"——
// 心跳写 handshake，CLI 重连时判活；优雅退出清 handshake + 关 pipe。
//
// 边界（划给 P5 长跑 hardening，见 docs/tech-debt.md TD-45/46/47）：
//   - daemon 自重启（死掉自动拉起）—— T1 只判活+报告，不自愈
//   - 进程组累积清理 / 句柄泄漏监控
//   - tail 流式 IPC（v1 用文件轮询替代，IPC 只做请求-响应）
//
// 纪律：本模块不 import cli.js（避免循环依赖，照 backgroundRunner.js 同款）。
// runtime-agnostic：start IPC 内部调 runBackground，不按 backend 名分支。

import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createServer, createConnection as netCreateConnection } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { readTranscript, findState, TERMINAL_STATES } from "./transcript.js";
import { RunManager } from "./runManager.js";
import { readRegistry, normalizeAgent } from "./registry.js";
import { ownerFilePath, checkOwnerLiveness, DEFAULT_OWNER_LIVENESS_THRESHOLD_MS } from "./application/ownerLiveness.js";

// Re-export for backward compatibility with daemon tests/supervisor imports
export const DEFAULT_LIVENESS_THRESHOLD_MS = DEFAULT_OWNER_LIVENESS_THRESHOLD_MS;
import { checkNodeVersion } from "./nodeVersionGuard.js";
import { assessDaemonHealth } from "./daemonHealth.js";

// P5 TD-46：粗略数 worktree 残留（.wao-worktrees 子目录数）作健康信号。
// 不依赖 isolation.js（避免循环依赖）；worktree 累积是长跑泄漏的文件面信号。
function countWorktrees(worktreeDir) {
  try {
    const dir = worktreeDir || ".wao-worktrees";
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter((n) => !n.startsWith(".")).length;
  } catch {
    return 0;
  }
}
import { OpenCodeServeBackend } from "./backends/opencodeServe.js";
import { ClaudeCodeBackend } from "./backends/claudeCode.js";
import { CodexBackend } from "./backends/codex.js";
import { KimiCodeBackend } from "./backends/kimiCode.js";
import { getWaoCliPath } from "./waoCliPath.js";

// handshake 文件名。放 runDir/（与 transcript 同目录）——不能放 .wao/，
// .wao/ 是锁死 5 槽位结构（waoDir.js WAO_TOP_LEVEL_SLOTS），有 layout 守卫负向断言。
export const HANDSHAKE_FILE = "daemon.json";

// 默认命名管道（ADR 0012）。Windows 本机 IPC，不可远程触达。
export const DEFAULT_PIPE = "\\\\.\\pipe\\wao-daemon";

// 心跳/判活默认参数。
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 2000;
// M10-pre3: liveness threshold imported from application/ownerLiveness.js (top of file)

// ============================================================
// 纯函数（无 IO 副作用的逻辑，最先做，最稳，可单测）
// ============================================================

/**
 * 读 runDir/daemon.json。文件不存在/坏 JSON 返回 null（= 无 daemon）。
 * @returns {{pid:number, pipe:string, startedAt:number, heartbeatAt:number}|null}
 */
export function readHandshake(runDir) {
  const filePath = join(runDir, HANDSHAKE_FILE);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 判 daemon 是否活着：heartbeatAt 在阈值内 = 活。
 * @param {object|null} handshake - readHandshake 的返回
 * @param {number} now - 当前时间戳（ms）
 * @param {number} thresholdMs - 心跳超时阈值
 */
export function isDaemonAlive(handshake, now, thresholdMs = DEFAULT_LIVENESS_THRESHOLD_MS) {
  if (!handshake || typeof handshake.heartbeatAt !== "number") return false;
  return (now - handshake.heartbeatAt) <= thresholdMs;
}

/**
 * 扫 runDir/*.jsonl，返回非终态 run 的 runId 列表（daemon 重启时接管用）。
 * 纯磁盘读：用 findState 判态，TERMINAL_STATES 过滤。
 */
export function scanResumableRuns(runDir, now = Date.now(), thresholdMs = DEFAULT_LIVENESS_THRESHOLD_MS) {
  if (!existsSync(runDir)) return [];
  const files = readdirSync(runDir);
  const resumable = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const runId = file.replace(/\.jsonl$/, "");
    try {
      const raw = readFileSync(join(runDir, file), "utf8");
      const events = raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      const state = findState(events);
      if (TERMINAL_STATES.includes(state)) continue;
      // D-F3：有活 owner 的 run 不 resume（防双所有者劫持）。
      // ownership 心跳判活，不依赖 run 输出节奏（RunMaestro 教训：长任务沉默不等于死）。
      if (isRunOwned(runDir, runId, now, thresholdMs)) continue;
      resumable.push(runId);
    } catch {
      // 坏 transcript 跳过（不影响其它 run 的 resume）
    }
  }
  return resumable;
}

// ============================================================
// D-F2 修复：统一视图（daemon list 看到所有非终态 run，标 owner）
// ============================================================
// D-F2 痛点（research/14）：daemon list 只报 in-memory（daemon-owned）run，
// P2 `run --background` runner 派发的 run（有活 owner 文件但不在 daemon 内存）不可见。
// 正解（统一视图，forward-compatible）：scanAllRuns 扫 runDir 全部非终态 run，按 owner 分类：
//   - "daemon"   ：daemon in-memory 拥有（传 daemonOwnedSet 判定）
//   - "external" ：有活 owner 文件（D-F3 isRunOwned=true）但不在 daemon 内存 → 别人驱动，可见不劫持
//   - "orphan"   ：非终态无 owner（owner 死了/没写）→ resume 候选
// 不动两套所有者模型（彻底统一是 P4 范围的设计决策，handoff §5 明示），只补可见性。
// 复用 D-F3 的 owner 文件机制（ownerFilePath/isRunOwned），纯函数可单测。

/**
 * 扫 runDir 所有非终态 run，按 owner 来源分类标记。
 * @param {string} runDir
 * @param {number} [now] - 当前时间戳（ms），默认 Date.now()
 * @param {number} [thresholdMs] - owner 心跳超时阈值，默认 DEFAULT_LIVENESS_THRESHOLD_MS
 * @param {Set<string>} [daemonOwnedSet] - daemon in-memory 拥有的 runId 集合（标 "daemon"）
 * @returns {Array<{runId:string, agentId:string, state:string, owner:"daemon"|"external"|"orphan"}>}
 */
export function scanAllRuns(runDir, now = Date.now(), thresholdMs = DEFAULT_LIVENESS_THRESHOLD_MS, daemonOwnedSet = new Set()) {
  if (!existsSync(runDir)) return [];
  const files = readdirSync(runDir);
  const runs = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const runId = file.replace(/\.jsonl$/, "");
    try {
      const raw = readFileSync(join(runDir, file), "utf8");
      const events = raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      const state = findState(events);
      if (TERMINAL_STATES.includes(state)) continue; // 终态跳过
      const agentId = events.find((e) => e.agentId)?.agentId ?? "unknown";
      let owner;
      if (daemonOwnedSet.has(runId)) {
        owner = "daemon";
      } else if (isRunOwned(runDir, runId, now, thresholdMs)) {
        owner = "external"; // 有活 owner 文件但不在 daemon 内存 → 别人（如 P2 runner）在驱动
      } else {
        owner = "orphan"; // 无 owner 或 owner 死了
      }
      runs.push({ runId, agentId, state, owner });
    } catch {
      // 坏 transcript 跳过（不影响其它 run）
    }
  }
  return runs;
}

// ============================================================
// D-F3 修复：ownership 心跳判活
// ============================================================
// RunMaestro 教训：纯事件时间（staleness）判活对长任务（全量 CI 沉默 40min）误判。
// 正解：owner 进程心跳——P2 background runner 写 .owner-<runId> {pid, heartbeatAt}，
// daemon resume 前查 owner 活则 skip（哪怕 run 沉默，owner 在更新心跳就不劫持）。
// ownership 文件是短命进程注册表（同 daemon.json 性质），不存 run 状态，不与 transcript
// 真相源竞争。

/** owner 文件路径：runDir/.owner-<runId> */
// M10-pre3: owner heartbeat logic delegated to application/ownerLiveness.js SSOT
// (imported at top of file). ownerFilePath is re-exported for test compatibility.
export { ownerFilePath };

/**
 * 判 run 是否有活的所有者。Delegates to ownerLiveness SSOT.
 */
export function isRunOwned(runDir, runId, now, thresholdMs = DEFAULT_LIVENESS_THRESHOLD_MS) {
  return checkOwnerLiveness(runDir, runId, now, thresholdMs).fresh;
}
// IPC 客户端（请求-响应：发 1 行 JSON 请求，读 1 行 JSON 响应，关连接）
// ============================================================

/**
 * 连 daemon 命名管道，发一个请求，拿一个响应。
 * @param {string} pipe - 命名管道路径（如 DEFAULT_PIPE）
 * @param {object} request - 请求体（{cmd, ...}）
 * @param {{timeoutMs?:number}} [opts] - 连接/读取超时（默认 5000ms）
 * @returns {Promise<object>} 响应体（已 JSON.parse）
 * @throws 连不上 / 超时 / 响应坏 JSON
 */
export function connectDaemon(pipe, request, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const sock = netCreateConnection(pipe);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error(`daemon connect/read timeout after ${timeoutMs}ms (pipe=${pipe})`));
    }, timeoutMs);

    sock.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });

    sock.on("connect", () => {
      sock.write(JSON.stringify(request) + "\n");
    });

    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        try {
          const res = JSON.parse(line);
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          sock.end();
          resolve(res);
        } catch (e) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          sock.destroy();
          reject(new Error(`daemon response not JSON: ${line}`));
        }
      }
    });
  });
}

// ============================================================
// daemon 进程内部：backend / registry 构造（照 backgroundRunner.js，避免 import cli.js）
// ============================================================

// 测试用：registry 以对象注入时，构造内存 readRegistry。
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

function backendFor(agent, { fetchImpl, waoCliPath } = {}) {
  if (agent.backend === "opencode-serve") {
    return new OpenCodeServeBackend(fetchImpl ? { fetchImpl } : {});
  }
  if (agent.backend === "claude-code") return new ClaudeCodeBackend({ waoCliPath });
  if (agent.backend === "codex") return new CodexBackend({ waoCliPath });
  if (agent.backend === "kimi-code") return new KimiCodeBackend({ waoCliPath });
  throw new Error(`Unsupported backend: ${agent.backend}`);
}

// ============================================================
// IPC server + run 追踪（thin control plane）
// ============================================================

/**
 * 起 daemon。持有 1 个长生命周期 RunManager，listen 命名管道，派发窄协议请求。
 * @param {object} opts
 * @param {string} opts.runDir - transcript/handshake 目录
 * @param {string} [opts.pipe] - 命名管道（默认 DEFAULT_PIPE）
 * @param {object|string} opts.registry - registry 对象（测试）或路径（生产）
 * @param {Function} [opts.fetchImpl] - opencode fetch 注入（测试）
 * @param {number} [opts.waitTimeout]
 * @param {number} [opts.pollInterval]
 * @param {number} [opts.heartbeatIntervalMs]
 * @returns {Promise<{server, manager, stop:Function}>}
 */
export async function startDaemon(opts = {}) {
  // TD-40：daemon 派发进程式 worker 前先校验 Node 版本（守住 v22 内置 Job Object 进程隔离）。
  // daemon 是长驻派发点，必须在 v24（回归）上拒绝起，否则 worker 子进程树可能被 OS 误杀。
  // WAO_SKIP_VERSION_GUARD=1 绕过（仅测试用）。
  if (process.env.WAO_SKIP_VERSION_GUARD !== "1") {
    const versionGuard = checkNodeVersion(process.version);
    if (!versionGuard.ok) {
      throw new Error(`daemon 拒绝启动：${versionGuard.reason}（见 docs/02-architecture.md §4.3）`);
    }
  }
  const { runDir } = opts;
  if (!runDir) throw new Error("startDaemon: runDir required");
  const pipe = opts.pipe ?? DEFAULT_PIPE;
  // TD-90: Windows 上指向 scripts/wao-cli.cmd（v22 shim），避免 worker shell 默认 v24 触发 guard
  const waoCliPath = getWaoCliPath();

  // registry 解析：对象 → 内存 readRegistry；字符串 → readRegistry
  const registryResolver = typeof opts.registry === "object" && opts.registry !== null
    ? makeObjectRegistry(opts.registry)
    : readRegistry;
  const registryPath = typeof opts.registry === "string" ? opts.registry : undefined;
  const waitTimeout = opts.waitTimeout ?? 120000;
  const pollInterval = opts.pollInterval ?? 1000;

  const manager = new RunManager({
    config: {
      runDir,
      registry: registryPath ?? (typeof opts.registry === "object" ? "." : undefined),
      pollInterval,
      waitTimeout,
      timeout: waitTimeout + 5000,
      retries: 0,
    },
    readRegistry: registryResolver,
    transcriptDir: runDir,
    backendFor: (agent) => backendFor(agent, { fetchImpl: opts.fetchImpl, waoCliPath }),
  });

  // 写 handshake
  const handshake = {
    pid: process.pid,
    pipe,
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
  };
  writeFileSync(join(runDir, HANDSHAKE_FILE), JSON.stringify(handshake, null, 2), "utf8");

  // 心跳：定期更新 heartbeatAt
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimer = setInterval(() => {
    handshake.heartbeatAt = Date.now();
    try {
      writeFileSync(join(runDir, HANDSHAKE_FILE), JSON.stringify(handshake, null, 2), "utf8");
    } catch {
      // runDir 被删等：心跳写失败不杀 daemon（下个 tick 再试）
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  // P5 TD-46 长跑可观测性：周期采样健康（内存/在飞 run/worktree 残留），写 daemon-health.json，
  // 超阈→记 daemon.health_warn 事件（眼睛，不自动修根因——根因靠长跑暴露后针对性修）。
  const healthIntervalMs = opts.healthIntervalMs ?? 30000; // 30s 采样一次
  const healthTimer = setInterval(() => {
    try {
      const mem = process.memoryUsage();
      const sample = {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        activeRuns: (typeof runControllers !== "undefined" ? runControllers.size : 0),
        worktreeCount: countWorktrees(opts.worktreeDir),
        uptimeMs: Date.now() - (handshake.startedAt ?? Date.now()),
        sampledAt: Date.now(),
      };
      const health = assessDaemonHealth(sample);
      writeFileSync(join(runDir, "daemon-health.json"), JSON.stringify({ ...sample, level: health.level, issues: health.issues }, null, 2), "utf8");
      if (health.level === "warn") {
        // 记 health_warn 事件到 transcript？daemon 无单一 transcript；先写 health 文件，CLI health 可读。
        // （告警通道：lead 轮询 daemon health 命令 / 监控 daemon-health.json level）
      }
    } catch {
      // 采样失败不杀 daemon
    }
  }, healthIntervalMs);
  healthTimer.unref?.();

  // per-run AbortController：daemon 拥有 waitForCompletion 的中断权（06-18 教训：
  // 不能让 run 循环脱离 daemon 控制空转烧 token）。stop 一个 run = abort 它的 controller。
  const runControllers = new Map();

  // daemon 级优雅退出（shutdown IPC 触发）。先响应再 stop+exit。
  let shuttingDown = false;
  const requestShutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    setImmediate(async () => {
      try { await stop(); } catch { /* 尽力 */ }
      process.exit(0);
    });
  };

  // IPC server：每连接一个请求-响应
  const server = createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          sock.write(JSON.stringify({ ok: false, error: "request not JSON" }) + "\n");
          continue;
        }
        handleRequest(req, manager, { runDir, waitTimeout, pollInterval, registryPath, runControllers, requestShutdown })
          .then((res) => {
            sock.write(JSON.stringify(res) + "\n");
          })
          .catch((e) => {
            sock.write(JSON.stringify({ ok: false, error: e.message }) + "\n");
          });
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipe, resolve);
  });

  // resume-scan（daemon 重启接管未完成 run）：扫 runDir 非终态 run，
  // 逐个 resume 并驱动到终态。失败不阻塞 daemon 启动（坏 run 跳过）。
  if (opts.resumeOnStart) {
    const resumable = scanResumableRuns(runDir);
    for (const runId of resumable) {
      try {
        const run = await manager.resume(runId, { runDir, registry: registryPath });
        if (!run) continue;
        const controller = new AbortController();
        runControllers.set(runId, controller);
        run.waitForCompletion({ waitTimeout, pollInterval, signal: controller.signal })
          .catch(() => { /* resume 失败已在 transcript 记录 */ })
          .finally(() => { runControllers.delete(runId); });
      } catch {
        // 单个 run resume 失败不拖垮整个 daemon
      }
    }
  }

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeatTimer);
    clearInterval(healthTimer);
    // 先删 handshake（无论后续 server.close 是否挂起，handshake 必须清，否则 CLI 判活误报）。
    try { unlinkSync(join(runDir, HANDSHAKE_FILE)); } catch { /* 已不在 */ }
    // abort 所有 per-run controller（打断 waitForCompletion 的事件轮询循环），
    // 再 abortAll（清理 session）。顺序重要：controller.abort 让 events 流终止，
    // 否则被弃的 async iterator 会在后台继续轮询（06-18 孤儿换皮）。
    for (const c of runControllers.values()) c.abort();
    runControllers.clear();
    await manager.abortAll("daemon_stop");
    // server.close 带 2s 超时兜底（Windows 命名管道 close 偶发不 resolve）。
    await new Promise((r) => {
      const t = setTimeout(() => { server.close(); r(); }, 2000);
      server.close(() => { clearTimeout(t); r(); });
    });
  }

  return { server, manager, stop, runControllers };
}

/**
 * 处理单个 IPC 请求。纯逻辑（可单测：直接调）。
 * 协议：ping / list / status / start / stop
 */
export async function handleRequest(req, manager, ctx = {}) {
  const { cmd } = req;
  if (cmd === "ping") {
    return { ok: true, pid: process.pid, runs: manager.activeRuns.size };
  }
  if (cmd === "list") {
    // D-F2 统一视图：不只报 in-memory（daemon-owned）run，扫 runDir 全部非终态 run，
    // 按 owner 分类标记（daemon/external/orphan）。external = 别的 owner（如 P2 --background
    // runner）在驱动 → 可见但不劫持（D-F3 ownership 心跳保证）。这是 D-F2 的核心补全：
    // 让 lead 在一处看到所有在飞的 run，无论谁拥有。彻底统一两套所有者模型是 P4 范围。
    const daemonOwnedIds = new Set(manager.list().map((run) => run.runId));
    let runs = scanAllRuns(ctx.runDir, Date.now(), DEFAULT_LIVENESS_THRESHOLD_MS, daemonOwnedIds);
    // daemon in-memory 但 transcript 还没落盘的非终态 run（刚 start、events 尚未 flush）
    // 也补进列表（标 daemon），避免 list 在 start 后短暂空窗。
    for (const run of manager.list()) {
      if (!runs.some((r) => r.runId === run.runId)) {
        runs.push({ runId: run.runId, agentId: run.agentId, state: run.state ?? "running", owner: "daemon" });
      }
    }
    return { ok: true, runs };
  }
  if (cmd === "status") {
    const runId = req.runId;
    if (!runId) return { ok: false, error: "status requires runId" };
    const run = manager.activeRuns.get(runId);
    if (run) {
      return { ok: true, runId, state: run.state ?? "running", live: true };
    }
    // 不在内存：读 transcript 兜底
    const { runDir } = ctx;
    const filePath = join(runDir, `${runId}.jsonl`);
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf8");
      const events = raw.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
      return { ok: true, runId, state: findState(events), live: false };
    }
    return { ok: false, error: `unknown runId: ${runId}` };
  }
  if (cmd === "start") {
    const { agentId, prompt } = req;
    if (!agentId || !prompt) return { ok: false, error: "start requires agentId + prompt" };
    const run = await manager.start(agentId, {
      prompt,
      registry: ctx.registryPath,
      runDir: ctx.runDir,
      fireAndForget: false, // daemon 自己驱动 waitForCompletion，不触发护栏
    });
    // per-run controller：daemon 拿中断权。传给 waitForCompletion 作外部 signal。
    const controller = new AbortController();
    ctx.runControllers?.set(run.runId, controller);
    // 后台驱动到终态（不 await：IPC start 立即返回 runId，run 在 daemon 内继续）
    run.waitForCompletion({
      waitTimeout: ctx.waitTimeout ?? 120000,
      pollInterval: ctx.pollInterval ?? 1000,
      signal: controller.signal,
    })
      .catch((e) => { process.stderr.write(`daemon: waitForCompletion failed for ${run.runId}: ${e?.message ?? e}\n`); })
      .finally(() => { ctx.runControllers?.delete(run.runId); });
    return { ok: true, runId: run.runId };
  }
  if (cmd === "stop") {
    const { runId } = req;
    if (!runId) return { ok: false, error: "stop requires runId" };
    // 先 abort controller（打断 waitForCompletion 事件轮询），再 abort session。
    ctx.runControllers?.get(runId)?.abort();
    ctx.runControllers?.delete(runId);
    const stopped = await manager.abort(runId, "ipc_stop");
    return { ok: true, stopped, runId };
  }
  if (cmd === "shutdown") {
    // daemon 级优雅退出：标记后异步 daemon.stop() + exit。先回响应再退。
    if (typeof ctx.requestShutdown === "function") ctx.requestShutdown();
    return { ok: true, shuttingDown: true, pid: process.pid };
  }
  return { ok: false, error: `unknown cmd: ${cmd}` };
}

// ============================================================
// 进程入口（detached daemon 子进程）：node src/daemon.js --run-dir ... --registry ...
// ============================================================

/**
 * daemon 进程入口：解析 argv（run-dir/registry/pipe/wait-timeout/poll-interval/
 * resume-on-start/heartbeat），起 startDaemon，常驻到 SIGINT/SIGTERM 或 pipe 关闭。
 */
export async function daemonMain(argv = process.argv.slice(2)) {
  const opts = parseDaemonFlags(argv);
  if (!opts["run-dir"]) throw new Error("daemonMain: --run-dir required");

  const daemon = await startDaemon({
    runDir: opts["run-dir"],
    pipe: opts.pipe ?? DEFAULT_PIPE,
    registry: opts.registry,
    waitTimeout: Number(opts["wait-timeout"] ?? 120000),
    pollInterval: Number(opts["poll-interval"] ?? 1000),
    heartbeatIntervalMs: Number(opts["heartbeat"] ?? DEFAULT_HEARTBEAT_INTERVAL_MS),
    resumeOnStart: opts["resume-on-start"] === "true" || opts["resume-on-start"] === true,
  });

  // 优雅退出：SIGINT/SIGTERM → daemon.stop() → exit 0。
  let exiting = false;
  const shutdown = async (sig) => {
    if (exiting) return;
    exiting = true;
    try { await daemon.stop(); } catch { /* 尽力 */ }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // daemon 的 pipe server 关闭（异常）也退出，不留僵尸。
  daemon.server.on("close", () => { if (!exiting) process.exit(0); });
}

// 简单 flag 解析（kebab-case key，照 backgroundRunner.parseSimpleFlags）。
export function parseDaemonFlags(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        opts[key] = next;
        i += 1;
      } else {
        opts[key] = true;
      }
    }
  }
  return opts;
}

// 直接作为入口运行时（detached daemon 子进程）。
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  daemonMain().catch((e) => {
    process.stderr.write(`daemon error: ${e.message}\n`);
    process.exit(1);
  });
}
