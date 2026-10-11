// src/application/serveMaintenance.js
//
// TD-250（决定 0056，2026-10-10）：kimi serve 维护编排（`wao serve status|sweep|
// recycle` 的 application 层）。双席会审（consult_20261010220638436s4gchx）修正案
// 全量落地：
//   - A3 清扫**按会话认领**（WAO 转录 session.created.backendSessionId，扫全部
//     项目桶——不按 wd_* 命名启发式认领）；"worktree 已亡"门 = 形状判定
//     （父目录名 .wao-worktrees）+ 干净 ENOENT + 父目录在场可读（fail-closed：
//     环境可疑整批放弃）。**跨 serve 生效**（会话仓共享）——命令输出明示。
//   - A2 回收门 = WAO 侧（全部项目桶、active-only 心跳投影——runner 死掉的
//     unresolved run 不堵门）+ serve 侧**会话集合 soak**（过门→等≥fork→首POST
//     时差→复探集合**逐 id 相同**且全 !busy——busy-only 复探有 createSession→
//     sendPrompt 间新会话 idle 的洞，集合比对把窗口压到构造上不可命中）。
//   - 杀 = 优雅 POST /api/v1/shutdown 优先（实测全量拆荚零孤儿；完成由端口/
//     进程验证证实，不靠返回值声称）；超时回退 taskkill /T /F。
//   - 重启 env 由命令显式组装（WAO_IN_WORKER=1 恒注入——不继承操作员 shell，
//     消除 0047 env 臂静默失效面）；cwd=--workspace-dir（显式必填，无隐藏默认）。
//   - recycle-vs-recycle 互斥 = wx 锁文件 {pid,ts} + 600s 陈旧回收；**只防回收
//     互撞，不声称防新派发**（残余=秒级窗口内新派发显式红，不静默）。
//   - 清扫台账 = 独立 JSONL（.wao/serve-maintenance/）——不写回 run 转录
//     （ADR 0034 归档/哈希纪律不触碰）。
//
// 分层：kimi 专有 REST/机器事实全部在 backends/kimiServeOps.js（注入 ops）；
// 本模块只含编排/门/台账，不含 kimi 协议细节（不变量 3）。

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn as nodeSpawn, execFile as nodeExecFile } from "node:child_process";
import { listTranscriptsDeep } from "../projectBuckets.js";
import { readTranscript } from "../transcript.js";
import { listRuns } from "./runList.js";
import * as defaultOps from "../backends/kimiServeOps.js";

/** 清扫/回收的共享落点（.dev 语义之外的运维事实面，入 .wao/）。 */
export function serveMaintenanceDir(rootDir) {
  // TD-251/0057：落 .wao/runs/ 槽内（WAO_TOP_LEVEL_SLOTS 锁死顶层——waoLayout 守卫；
// // consults/ 同款先例：运行期操作记录归 runs 槽）。
return join(rootDir, ".wao", "runs", "serve-maintenance");
}

/**
 * 纯门：root 是否"worktree 形状"（**父目录**名 === .wao-worktrees，Windows
 * 大小写折叠、双分隔符、尾分隔符容忍）。形状外的 root（源仓桶/Owner 稳定
 * 目录）永不进入已亡判定。
 */
export function isWorktreeShapedRoot(root) {
  if (typeof root !== "string" || root.length === 0) return false;
  const norm = root.replace(/\//g, "\\").replace(/\\+$/, "");
  const idx = norm.lastIndexOf("\\");
  if (idx <= 0) return false;
  const parent = norm.slice(0, idx);
  const pidx = parent.lastIndexOf("\\");
  const parentName = pidx >= 0 ? parent.slice(pidx + 1) : parent;
  return parentName.toLowerCase() === ".wao-worktrees";
}

/** root 的父目录路径（.wao-worktrees 那一层），规范化同 isWorktreeShapedRoot。 */
function worktreeParentDir(root) {
  const norm = String(root).replace(/\//g, "\\").replace(/\\+$/, "");
  const idx = norm.lastIndexOf("\\");
  return idx > 0 ? norm.slice(0, idx) : null;
}

/**
 * 纯门：worktree root 的"已亡"判定（kimi 席 Q4 反例清单的全量收口）。
 * 返回闭集 verdict：
 *   dead          —— 形状内 + 父目录在场可读 + root 干净 ENOENT（唯一可删形态）
 *   alive         —— root 在盘（安全方向：rmSync 删一半留下的残骸也算活）
 *   not_shaped    —— 形状外，永不判定死亡
 *   suspect       —— 环境可疑（父目录缺席/不可读、或非 ENOENT stat 错误）：
 *                    fail-closed 整批放弃的信号
 * statSync 注入（测试）；默认真实 fs。
 */
export function worktreeRootVerdict(root, { statFn = statSync } = {}) {
  if (!isWorktreeShapedRoot(root)) return "not_shaped";
  const parent = worktreeParentDir(root);
  let parentStat;
  try {
    parentStat = statFn(parent);
  } catch {
    return "suspect";
  }
  if (!parentStat?.isDirectory()) return "suspect";
  try {
    statFn(String(root).replace(/\//g, "\\").replace(/\\+$/, ""));
    return "alive";
  } catch (error) {
    if (error?.code === "ENOENT") return "dead";
    return "suspect";
  }
}

/**
 * A3 规划（纯读，零副作用）：扫全部项目桶转录，按 session.created 认领
 * kimi-web 会话；对仍在 serve 的会话按工作区 root 已亡门分类。
 * 返回 { claims, uniqueSessions, deletable[], retained[], probeFailed[] }。
 */
export async function planSessionSweep({
  runDir,
  serveUrl,
  token,
  io = null,
  readTranscriptFn = readTranscript,
  ops = defaultOps,
  fetchImpl = globalThis.fetch,
  timeoutMs,
  statFn = statSync,
}) {
  const probe = ops.probeServeSession;
  const workspaces = await ops.listServeWorkspaces({ baseUrl: serveUrl, token, fetchImpl, timeoutMs });
  if (!workspaces.ok) {
    return { error: `workspace table unavailable (${workspaces.reason}) — refusing to plan` };
  }
  const rootById = new Map(workspaces.items.map((w) => [w.id, w.root]));

  const claims = new Map(); // sessionId -> { runId, serveUrl }
  for (const t of listTranscriptsDeep(runDir, io ? { io } : {})) {
    let events;
    try {
      events = await readTranscriptFn(t.path);
    } catch {
      continue; // 单转录不可读跳过（认领面少读不误删——fail-safe 方向）
    }
    const runId = t.name.replace(/\.jsonl$/, "");
    for (const e of events) {
      if (e && e.type === "session.created" && e.backend === "kimi-web"
        && typeof e.backendSessionId === "string" && e.backendSessionId.length > 0
        && !claims.has(e.backendSessionId)) {
        claims.set(e.backendSessionId, {
          runId,
          serveUrl: typeof e.serveUrl === "string" ? e.serveUrl : null,
        });
      }
    }
  }

  const deletable = [];
  const retained = [];
  const probeFailed = [];
  for (const [sessionId, claim] of claims) {
    const p = await probe({ baseUrl: serveUrl, token, sessionId, fetchImpl, timeoutMs });
    if (!p.ok) {
      probeFailed.push({ sessionId, runId: claim.runId, reason: p.reason });
      continue;
    }
    if (p.gone) {
      retained.push({ sessionId, runId: claim.runId, reason: "already_gone" });
      continue;
    }
    if (p.busy) {
      retained.push({ sessionId, runId: claim.runId, reason: "busy" });
      continue;
    }
    const root = p.workspaceId ? rootById.get(p.workspaceId) ?? null : null;
    if (root === null) {
      retained.push({ sessionId, runId: claim.runId, reason: "workspace_unknown" });
      continue;
    }
    const verdict = worktreeRootVerdict(root, { statFn });
    if (verdict === "dead") {
      deletable.push({ sessionId, runId: claim.runId, workspaceId: p.workspaceId, workspaceRoot: root });
    } else {
      retained.push({ sessionId, runId: claim.runId, reason: verdict === "alive" ? "root_alive" : verdict });
    }
  }
  return {
    claims: claims.size,
    deletable,
    retained,
    probeFailed,
    workspaces: workspaces.items.length,
  };
}

/**
 * A3 执行（--apply）：逐会话 :delete + 台账追加（独立 JSONL，不写 run 转录）。
 * already_gone 也记台账（幂等重跑可审计）。
 */
export async function applySessionSweep({
  plan,
  serveUrl,
  token,
  ledgerPath,
  ops = defaultOps,
  fetchImpl = globalThis.fetch,
  timeoutMs,
  appendFn = appendFileSync,
  nowFn = () => new Date().toISOString(),
}) {
  if (!Array.isArray(plan?.deletable)) throw new Error("applySessionSweep: plan.deletable required");
  const results = [];
  mkdirSync(dirname(ledgerPath), { recursive: true });
  for (const item of plan.deletable) {
    // TD-251 批 sol 会审修正：apply 时逐项复探（planning 到 apply 的窗口里会话
    // 可能转忙——冷会话跨实例活性探针覆盖不了的残余，至少本实例视角复验）。
    const reprobe = await ops.probeServeSession({ baseUrl: serveUrl, token, sessionId: item.sessionId, fetchImpl, timeoutMs });
    let outcome;
    if (!reprobe.ok) {
      outcome = `failed:reprobe_${reprobe.reason ?? "unknown"}`;
    } else if (reprobe.busy) {
      outcome = "skipped_busy";
    } else {
      const res = await ops.deleteServeSession({ baseUrl: serveUrl, token, sessionId: item.sessionId, fetchImpl, timeoutMs });
      outcome = res?.outcome === "deleted" || res?.outcome === "already_gone"
        ? res.outcome : `failed:${res?.reason ?? "unknown"}`;
    }
    const line = {
      ts: nowFn(),
      sessionId: item.sessionId,
      runId: item.runId,
      workspaceId: item.workspaceId,
      workspaceRoot: item.workspaceRoot,
      outcome,
    };
    appendFn(ledgerPath, `${JSON.stringify(line)}\n`, "utf8");
    results.push(line);
  }
  return {
    deleted: results.filter((r) => r.outcome === "deleted").length,
    alreadyGone: results.filter((r) => r.outcome === "already_gone").length,
    skippedBusy: results.filter((r) => r.outcome === "skipped_busy").length,
    failed: results.filter((r) => r.outcome.startsWith("failed:")).length,
    results,
  };
}

/** 纯门：recycle 的 serve 侧 soak 复探判定（集合逐 id 相同 + 全 !busy）。 */
export function soakVerdict(before, after) {
  if (!Array.isArray(before?.items) || !Array.isArray(after?.items)) return "unobservable";
  if (after.items.some((s) => s.busy || s.mainTurnActive)) return "busy_sessions";
  const a = before.items.map((s) => s.id).sort().join("\n");
  const b = after.items.map((s) => s.id).sort().join("\n");
  return a === b ? "clear" : "sessions_changed";
}

/** 有界 GET 探活（端口生死探针；任何应答=活着，拒绝/超时=死）。 */
function fetchFn(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetchImpl(url, { method: "GET", signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

/** wx 锁 + 陈旧回收。返回 {held:true} | {refused:true, pid, ageMs}。 */
export function acquireMaintenanceLock({ lockPath, pid = process.pid, nowMs = Date.now(), staleMs = 600_000, io = null }) {
  const _read = io?.readFileSync ?? readFileSync;
  const _write = io?.writeFileSync ?? writeFileSync;
  const _mkdir = io?.mkdirSync ?? mkdirSync;
  _mkdir(dirname(lockPath), { recursive: true });
  try {
    _write(lockPath, JSON.stringify({ pid, ts: nowMs }), { flag: "wx" });
    return { held: true };
  } catch (error) {
    if (error?.code !== "EEXIST") return { refused: true, reason: "lock_io_error" };
  }
  try {
    const prev = JSON.parse(_read(lockPath, "utf8"));
    const age = nowMs - (Number.isFinite(prev?.ts) ? prev.ts : 0);
    if (age > staleMs) {
      _write(lockPath, JSON.stringify({ pid, ts: nowMs }));
      return { held: true, staleTaken: true, previousPid: prev?.pid ?? null };
    }
    return { refused: true, pid: prev?.pid ?? null, ageMs: age };
  } catch {
    return { refused: true, reason: "lock_unreadable" };
  }
}

/**
 * TD-251 W1c（决定 0057）：回收后空壳清扫。真实 dogfood 发现：readOnly 席位树
 * 的内容与 git 元数据在终态清理时即被删净，但**空目录壳**会被泄漏荚的工具壳
 * （cmd.exe 以会话 worktree 为 cwd）占住句柄（Windows EPERM）——荚不死句柄不
 * 释。recycle 杀荚后句柄释放，此刻补扫即可闭环。门（保守）：目录名 /^run_/ +
 * **完全为空**（readdir 零条目——真 worktree 恒有文件；recycle 双门已保证无
 * 活跃 run，不存在"创建中"竞争）。
 * @returns {number} 清掉的壳数
 */
export function sweepEmptyWorktreeHusks(worktreesDir, { io = null } = {}) {
  const _readdir = io?.readdirSync ?? readdirSync;
  const _rm = io?.rmSync ?? rmSync;
  const _exists = io?.existsSync ?? existsSync;
  if (typeof worktreesDir !== "string" || !_exists(worktreesDir)) return 0;
  let removed = 0;
  for (const name of _readdir(worktreesDir)) {
    if (!/^run_/.test(name)) continue;
    const p = join(worktreesDir, name);
    try {
      if (_readdir(p).length === 0) {
        _rm(p, { recursive: true, force: true });
        if (!_exists(p)) removed += 1;
      }
    } catch {
      // 单壳失败跳过（下次回收再试）。
    }
  }
  return removed;
}

/**
 * A2 回收（手动 CLI 专用；门不过=结构化拒绝，零副作用）。步骤：
 * 实例解析 → WAO active 门 → serve 快照 → soak → 复探 → shutdown → 端口/
 * 进程死亡验证（回退 taskkill /T /F）→ 显式 env 重启 → 就绪轮询 → 后验证。
 * kill/spawn/时钟全注入（单测零真进程）。
 */
export async function recycleServe({
  port,
  serveUrl,
  token,
  workspaceDir,
  kimiExe = "kimi",
  runDir,
  kimiAgentIds,
  soakMs = 12_000,
  lockRootDir,
  ops = defaultOps,
  fetchImpl = globalThis.fetch,
  timeoutMs,
  listRunsFn = listRuns,
  spawnFn = null,
  execFileFn = null,
  sleepFn = (ms) => new Promise((r) => { setTimeout(r, ms); }),
  nowMs = Date.now,
}) {
  if (typeof workspaceDir !== "string" || workspaceDir.length === 0) {
    return { refused: "workspace_dir_required" };
  }
  const lock = acquireMaintenanceLock({
    lockPath: join(serveMaintenanceDir(lockRootDir), "recycle.lock"),
    nowMs: nowMs(),
  });
  if (lock.refused) return { refused: "lock_held", lock };
  const instances = ops.readServeInstances();
  const instance = instances.find((i) => i.port === port) ?? null;
  if (!instance) return { refused: "no_instance", port };

  // WAO 侧门：全部项目桶、active-only（新鲜 owner 心跳的非终态 run）。unresolved
  // （非终态但心跳死）不堵门——其上游活轮由 serve 侧 busy/集合 soak 兜底。
  const active = await listRunsFn({ runDir, activeOnly: true, authorizedWorkspaceRoot: null });
  const activeKimi = (active?.runs ?? active?.items ?? [])
    .filter((r) => Array.isArray(kimiAgentIds) && kimiAgentIds.includes(r.agentId));
  if (activeKimi.length > 0) {
    return { refused: "active_runs", runs: activeKimi.map((r) => ({ runId: r.runId, agentId: r.agentId })) };
  }

  // serve 侧门：快照 → soak → 集合比对复探。
  const before = await ops.listServeSessions({ baseUrl: serveUrl, token, fetchImpl, timeoutMs });
  if (!before.ok) return { refused: "serve_unobservable", reason: before.reason };
  await sleepFn(soakMs);
  const after = await ops.listServeSessions({ baseUrl: serveUrl, token, fetchImpl, timeoutMs });
  if (!after.ok) return { refused: "serve_unobservable", reason: after.reason };
  const verdict = soakVerdict(before, after);
  if (verdict !== "clear") {
    return {
      refused: verdict,
      sessionsBefore: before.items.length,
      sessionsAfter: after.items.length,
    };
  }

  // 杀：优雅 shutdown 优先；完成由端口死亡证实，超时回退 taskkill /T /F。
  const shutdown = await ops.shutdownServe({ baseUrl: serveUrl, token, fetchImpl, timeoutMs });
  if (shutdown.outcome !== "requested") {
    return { refused: "shutdown_rejected", reason: shutdown.reason, ...(shutdown.code !== undefined ? { code: shutdown.code } : {}) };
  }
  let portDown = false;
  for (let i = 0; i < 15; i += 1) {
    await sleepFn(1000);
    // 探活只看传输层生死（连接拒绝=已死；任何 HTTP 应答=还活着——含 401）。
    // 3s 有界：挂起连接不能拖住回收序列。
    portDown = await Promise.race([
      fetchFn(fetchImpl, `${serveUrl}/api/v1/sessions`, 3000).then(() => false, () => true),
      sleepFn(3500).then(() => true),
    ]);
    if (portDown) break;
  }
  let killFallback = null;
  if (!portDown) {
    killFallback = await new Promise((resolve) => {
      const exec = execFileFn ?? nodeExecFile;
      exec(
        "taskkill", ["/PID", String(instance.pid), "/T", "/F"],
        { timeout: 15_000, windowsHide: true },
        (error) => resolve(error ? { ok: false } : { ok: true }),
      );
    });
    await sleepFn(3000);
  }

  // 重启：env 由命令显式组装——WAO_IN_WORKER=1 恒注入（0047 env 臂），绝不继承
  // 操作员 shell 的偶然值；detached + ignore stdio（长命 serve 不挂 CLI 生命周期）。
  const spawn = spawnFn ?? nodeSpawn;
  const child = spawn(kimiExe, ["web", "--no-open", "--port", String(port)], {
    cwd: workspaceDir,
    env: { ...process.env, WAO_IN_WORKER: "1" },
    detached: true,
    stdio: "ignore",
  });
  child.unref?.();

  // 就绪：轮询会话面 code===0，有界 30s。
  let ready = false;
  for (let i = 0; i < 15; i += 1) {
    await sleepFn(2000);
    const check = await ops.listServeSessions({ baseUrl: serveUrl, token, fetchImpl, timeoutMs: 4000 });
    if (check.ok) { ready = true; break; }
  }
  const newInstance = (ops.readServeInstances()).find((i) => i.port === port) ?? null;
  const children = newInstance ? await ops.countServeChildren({ pid: newInstance.pid, execFileFn }) : -1;
  // TD-251 W1c：荚已死、句柄已释——补扫本工作区的空 worktree 壳（dogfood 实证
  // 的 still_present 残渣在此闭环）。
  const husksSwept = sweepEmptyWorktreeHusks(join(lockRootDir, ".wao-worktrees"));
  return {
    recycled: true,
    ready,
    oldPid: instance.pid,
    newPid: newInstance?.pid ?? null,
    portDownVerified: portDown,
    killFallback,
    newServeChildren: children,
    ...(husksSwept > 0 ? { emptyWorktreeHusksSwept: husksSwept } : {}),
  };
}

/** status：实例元数据 + 荚规模 + 会话面（零副作用观察）。 */
export async function serveStatusReport({ port, serveUrl, token, ops = defaultOps, fetchImpl = globalThis.fetch, timeoutMs, nowMs = Date.now, execFileFn = null }) {
  const instances = ops.readServeInstances();
  const instance = instances.find((i) => i.port === port) ?? null;
  const children = instance ? await ops.countServeChildren({ pid: instance.pid, execFileFn }) : null;
  const sessions = await ops.listServeSessions({ baseUrl: serveUrl, token, fetchImpl, timeoutMs });
  return {
    instance: instance
      ? {
        pid: instance.pid,
        startedAt: instance.startedAt,
        heartbeatAgeMs: instance.heartbeatAt !== null ? nowMs() - instance.heartbeatAt : null,
      }
      : null,
    children,
    sessions: sessions.ok
      ? { total: sessions.items.length, busy: sessions.items.filter((s) => s.busy || s.mainTurnActive).length }
      : { unavailable: sessions.reason },
  };
}
