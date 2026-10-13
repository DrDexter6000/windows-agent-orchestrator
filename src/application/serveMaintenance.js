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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync, appendFileSync, unlinkSync, lstatSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { execFile as nodeExecFile, execFileSync } from "node:child_process";
import { listTranscriptsDeep } from "../projectBuckets.js";
import { readTranscript, listTranscriptFiles, findState, TERMINAL_STATES } from "../transcript.js";
import { listRuns } from "./runList.js";
import { recycleRunBranch } from "../isolation.js";
import { gitChildEnv } from "../delivery.js";
import * as defaultOps from "../backends/kimiServeOps.js";
import {
  resolveKimiExe,
  serveWorkspaceShapeRefusal,
  serveWorkspacePlacementRefusal,
  kimiServeChildEnv,
  spawnServeDetached,
  holdServeStartLock,
  releaseServeStartLock,
} from "../backends/kimiServeStart.js";

// 决定 0075：exe 解析随启动原语迁到 backends/kimiServeStart.js（kimi-web backend 的
// 按需拉起共用同一份）；这里原名再导出，既有消费方不动。
export { resolveKimiExe };

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
const ARCHIVE_MONTH_DIR_RE = /^\d{4}-\d{2}$/;

/**
 * TD-252③（TD-256 批）：磁盘归档面的有界转录枚举。归档根从 runDir 推导
 * （决定 0050：dirname(runDir)/runs-archive——不从桶内 dirname 反推）；只取
 * <yyyy-mm>/ 直下 *.jsonl（月份目录形状校验 /^\d{4}-\d{2}$/；不进子目录——
 * 归档树里有取证目录/bundle/md 等非转录资产；逐文件 lstat 拒 symlink/junction；
 * 枚举失败如实上报（skipped），不静默。根缺席=空集（未归档过的安装形态）。
 * 逐目录文件名枚举经 listTranscriptFiles 唯一入口（TD-190 D0 守卫域内合规）。
 */
export function listArchiveTranscriptFiles(runDir) {
  const out = { files: [], skipped: [] };
  const root = join(dirname(String(runDir).replace(/[\\/]+$/, "")), "runs-archive");
  let months = [];
  try { months = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const m of months) {
    if (!m.isDirectory() || !ARCHIVE_MONTH_DIR_RE.test(m.name)) continue;
    const dir = join(root, m.name);
    let names = [];
    try { names = listTranscriptFiles(dir); } catch { out.skipped.push({ dir, reason: "readdir_failed" }); continue; }
    for (const name of names) {
      const pf = join(dir, name);
      let st = null;
      try { st = lstatSync(pf); } catch { out.skipped.push({ file: pf, reason: "lstat_failed" }); continue; }
      if (st.isSymbolicLink()) { out.skipped.push({ file: pf, reason: "symlink_not_followed" }); continue; }
      if (!st.isFile()) continue; // 名字长得像转录的目录——跳过
      out.files.push({ path: pf, name, month: m.name });
    }
  }
  return out;
}

export async function planSessionSweep({
  runDir,
  serveUrl,
  token,
  kimiHome = null,
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

  // 信封纪律（验收 sol#4）：session.created 必须绑定文件 runId（文件名 stem 是
  // 权威 runId——R20-C 同款）；事件自带 runId 且≠文件 runId=外 run 信封行，跳过
  // 并计数（legacy 无 runId 字段的事件按既有兼容接受）。认领归属不能被外 run
  // 事件冒名。
  const foreignEnvelopeEvents = [];
  const claimOf = (e, runId) => {
    if (typeof e?.runId === "string" && e.runId !== runId) { foreignEnvelopeEvents.push({ file: runId, eventRunId: e.runId, type: e.type }); return null; }
    if (!(e && e.type === "session.created" && e.backend === "kimi-web"
      && typeof e.backendSessionId === "string" && e.backendSessionId.length > 0)) return null;
    return e;
  };
  const claims = new Map(); // sessionId -> { runId, serveUrl, fromArchive? }
  for (const t of listTranscriptsDeep(runDir, io ? { io } : {})) {
    let events;
    try {
      events = await readTranscriptFn(t.path);
    } catch {
      continue; // 单转录不可读跳过（认领面少读不误删——fail-safe 方向）
    }
    const runId = t.name.replace(/\.jsonl$/, "");
    for (const e of events) {
      const ev = claimOf(e, runId);
      if (ev && !claims.has(ev.backendSessionId)) {
        claims.set(ev.backendSessionId, {
          runId,
          serveUrl: typeof ev.serveUrl === "string" ? ev.serveUrl : null,
        });
      }
    }
  }

  // TD-252③（TD-256 批）：认领面扩到磁盘归档——runs prune --archive 移走的 run
  // 其会话仍活在 serve 上，认领面丢了就永远扫不到。字节级预筛（不含
  // kimi-web 字串的文件不进解析——认领面只多不少方向）；live 位（runDir）优先于
  // 归档位；同会话跨 run 归属冲突**保留并退出删除候选**（验收 sol#5：冲突会话
  // 的归属不可证，靠首见决定删除=未证先删）。
  const claimConflicts = [];
  const conflictedSessionIds = new Set();
  const archiveReadFailures = [];
  const archive = listArchiveTranscriptFiles(runDir);
  for (const f of archive.files) {
    let raw;
    try { raw = readFileSync(f.path, "utf8"); } catch { archiveReadFailures.push({ file: f.path, reason: "read_failed" }); continue; }
    if (!raw.includes("kimi-web")) continue; // 预筛：认领键只可能出现在含该串的文件里
    let events;
    try { events = await readTranscriptFn(f.path); } catch { archiveReadFailures.push({ file: f.path, reason: "parse_failed" }); continue; }
    const runId = f.name.replace(/\.jsonl$/, "");
    for (const e of events) {
      const ev = claimOf(e, runId);
      if (!ev) continue;
      const prior = claims.get(ev.backendSessionId);
      if (prior) {
        if (prior.runId !== runId) {
          claimConflicts.push({ sessionId: ev.backendSessionId, runIds: [prior.runId, runId] });
          conflictedSessionIds.add(ev.backendSessionId);
        }
        continue;
      }
      claims.set(ev.backendSessionId, {
        runId,
        serveUrl: typeof ev.serveUrl === "string" ? ev.serveUrl : null,
        fromArchive: true,
      });
    }
  }

  const deletable = [];
  const retained = [];
  const probeFailed = [];
  const foreignHome = [];
  for (const [sessionId, claim] of claims) {
    // 冲突会话：归属不可证 → 永远保留侧，绝不进入删除候选（sol#5 必改）。
    if (conflictedSessionIds.has(sessionId)) {
      retained.push({ sessionId, runId: claim.runId, reason: "claim_conflict" });
      continue;
    }
    // TD-253（决定 0058，opus）：分家后按 claim.serveUrl 过滤——跨家会话在目标
    // serve 上 404 会被误记 already_gone 污染台账。legacy 无 serveUrl 认领仅
    // 默认家（kimiHome 缺席）纳入。
    if (kimiHome ? claim.serveUrl !== serveUrl : (claim.serveUrl !== null && claim.serveUrl !== serveUrl)) {
      foreignHome.push({ sessionId, runId: claim.runId, serveUrl: claim.serveUrl });
      continue;
    }
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
    foreignHome,
    workspaces: workspaces.items.length,
    archiveScanned: archive.files.length,
    archiveSkipped: archive.skipped,
    archiveReadFailures,
    claimConflicts,
    foreignEnvelopeEvents,
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
    return { held: true, lockPath };
  } catch (error) {
    if (error?.code !== "EEXIST") return { refused: true, reason: "lock_io_error" };
  }
  try {
    const prev = JSON.parse(_read(lockPath, "utf8"));
    const age = nowMs - (Number.isFinite(prev?.ts) ? prev.ts : 0);
    if (age > staleMs) {
      _write(lockPath, JSON.stringify({ pid, ts: nowMs }));
      return { held: true, staleTaken: true, previousPid: prev?.pid ?? null, lockPath };
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
// TD-251 W1c / TD-262（0063 审核修订）：空壳清扫。返回**已删壳名数组**（旧返回
// count——消费方取 length 同值）；删除改 rmdirSync **非递归**（目录变非空即拒绝，
// 不吞新文件——sol 会审条款）+ lstat 防符号链接/junction（rmSync 递归会穿透目标）。
export function sweepEmptyWorktreeHusks(worktreesDir, { io = null } = {}) {
  const _readdir = io?.readdirSync ?? readdirSync;
  const _rmdir = io?.rmdirSync ?? rmdirSync;
  const _exists = io?.existsSync ?? existsSync;
  const _lstat = io?.lstatSync ?? lstatSync;
  if (typeof worktreesDir !== "string" || !_exists(worktreesDir)) return [];
  const removed = [];
  for (const name of _readdir(worktreesDir)) {
    if (!/^run_/.test(name)) continue;
    const p = join(worktreesDir, name);
    try {
      if (_lstat(p).isSymbolicLink()) continue; // junction/symlink 壳不碰（穿透风险）
      if (_readdir(p).length === 0) {
        _rmdir(p); // 非递归：检查为空后出现新文件 → ENOTEMPTY 拒绝，下次再试
        if (!_exists(p)) removed.push(name);
      }
    } catch {
      // 单壳失败跳过（下次回收再试）。
    }
  }
  return removed;
}

// ── TD-261/262（0063）辅助 ────────────────────────────────────────────────────

/** pid 判活（Windows 下 process.kill(pid,0)：ESRCH=死；EPERM=活着但无权限=活）。 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

/**
 * TD-261a（opus 会审条款）：同端口多实例记录（复活后新旧 json 并存是常态）——
 * 取"pid 存活者中最新心跳"，无存活者取最新心跳（杀路径对死者核验镜像名后才动手）。
 */
export function pickInstanceByPort(instances, port) {
  const c = (Array.isArray(instances) ? instances : []).filter((i) => i && i.port === port);
  if (c.length === 0) return null;
  const freshest = (a, b) => (b.heartbeatAt ?? b.startedAt ?? 0) - (a.heartbeatAt ?? a.startedAt ?? 0);
  const alive = c.filter((i) => pidAlive(i.pid)).sort(freshest);
  return alive[0] ?? c.sort(freshest)[0];
}

/**
 * TD-262a（0063，opus/sol 会审合订）：已删壳名的**转录门控**分支回收。资格全链
 * 从绑定转录证明（sol 反例：accepted 交付轮同样留空壳且分支须保留——空目录不是
 * 资格证据）：转录在场+终态+run.read_only_declared+无 delivery+worktreePath
 * basename===壳名。runId=壳名原样（含 run_ 前缀——opus 纠错：finalRunId 本就带
 * 前缀）。git worktree prune 先行（壳目录已删但 .git/worktrees 残留会让 -d 恒拒）。
 * 每壳一行台账（tipSha 删除前取——`git branch wao/<id> <sha>` 可机器复原）。
 * 无 run 转录可写事件（run 已终态）——台账 JSONL 即证据落点（与 sweep 台账同先例）。
 */
export async function recycleHuskBranches(huskNames, { lockRootDir, runDir, execFn = execFileSync, appendFn = appendFileSync, ledgerDir = null }) {
  const results = [];
  if (!Array.isArray(huskNames) || huskNames.length === 0) return results;
  const git = (args) => execFn("git", args, { cwd: lockRootDir, env: gitChildEnv(), stdio: "pipe", windowsHide: true });
  const ledger = ledgerDir ?? serveMaintenanceDir(lockRootDir);
  const appendLedger = (entry) => {
    try {
      mkdirSync(ledger, { recursive: true });
      appendFn(join(ledger, "husk-branch-ledger.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
    } catch { /* 台账失败不阻断回收（输出面仍携带逐壳结果） */ }
  };
  // 转录索引：runId -> 路径（listTranscriptsDeep 覆盖项目桶；根层平铺由
  // listTranscriptsDeep 的既有语义覆盖）。
  let transcripts = [];
  try { transcripts = listTranscriptsDeep(runDir) ?? []; } catch { transcripts = []; }
  const byRunId = new Map(transcripts.map((t) => [basename(String(t?.path ?? "")).replace(/\.jsonl$/, ""), t.path]));
  for (const name of huskNames) {
    const entry = { runId: name, huskPath: join(lockRootDir, ".wao-worktrees", name), sourceCwd: lockRootDir, branch: `wao/${name}` };
    try {
      const tPath = byRunId.get(name);
      if (!tPath) { entry.outcome = "skip"; entry.reason = "no_transcript"; results.push(entry); appendLedger(entry); continue; }
      const events = await readTranscript(tPath);
      const state = findState(events);
      if (!TERMINAL_STATES.includes(state)) { entry.outcome = "skip"; entry.reason = "not_terminal"; results.push(entry); appendLedger(entry); continue; }
      const started = events.find((e) => e && e.type === "run.started");
      if (!events.some((e) => e && e.type === "run.read_only_declared")) { entry.outcome = "skip"; entry.reason = "not_read_only"; results.push(entry); appendLedger(entry); continue; }
      if (started?.delivery?.mode != null || started?.deliveryRequested === true) { entry.outcome = "skip"; entry.reason = "delivery_run"; results.push(entry); appendLedger(entry); continue; }
      if (basename(String(started?.worktreePath ?? "")) !== name) { entry.outcome = "skip"; entry.reason = "worktree_path_mismatch"; results.push(entry); appendLedger(entry); continue; }
      // prune 先行（opus 条款）：壳目录已删，.git/worktrees 残留会让 -d 恒拒。
      try { git(["worktree", "prune"]); } catch { /* prune 失败不阻断——-d 自会拒 */ }
      try { entry.tipSha = String(git(["rev-parse", `refs/heads/${entry.branch}`])).trim() || null; } catch { entry.tipSha = null; }
      const r = recycleRunBranch(lockRootDir, name);
      entry.outcome = r.outcome;
      if (r.uniqueCommits != null) entry.uniqueCommits = r.uniqueCommits;
      if (r.reason != null) entry.reason = r.reason;
    } catch {
      entry.outcome = "skip";
      entry.reason = "error";
    }
    results.push(entry);
    appendLedger(entry);
  }
  return results;
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
  kimiHome = null,
  ops = defaultOps,
  fetchImpl = globalThis.fetch,
  timeoutMs,
  listRunsFn = listRuns,
  spawnFn = null,
  execFileFn = null,
  sleepFn = (ms) => new Promise((r) => { setTimeout(r, ms); }),
  nowMs = Date.now,
}) {
  // 工作目录的形状门与放置门、exe 解析：与按需拉起共用（backends/kimiServeStart.js），
  // 次序不变——形状门 → exe → 放置门。
  const shapeRefusal = serveWorkspaceShapeRefusal(workspaceDir);
  if (shapeRefusal) return { refused: shapeRefusal };
  // TD-261b（0063，opus/sol 合订）：exe 解析**前移到一切副作用之前**（锁/杀/探
  // 测都不碰）——解析不到=零副作用拒绝，绝不出现"杀了旧的才发现没 exe"。
  const exeResolution = resolveKimiExe({ kimiExe, kimiHome });
  if (exeResolution.refused) {
    return { refused: exeResolution.refused, tried: exeResolution.tried };
  }
  // TD-253（opus Q5）：serve cwd 三拒——cwd 句柄钉目录（W1c 实证）+项目发现面+家内污染。
  const placementRefusal = serveWorkspacePlacementRefusal(workspaceDir, kimiHome);
  if (placementRefusal) return { refused: placementRefusal };
  const recycleLockPath = join(serveMaintenanceDir(lockRootDir), "recycle.lock");
  const lock = acquireMaintenanceLock({ lockPath: recycleLockPath, nowMs: nowMs() });
  if (lock.refused) return { refused: "lock_held", lock };
  // dogfood 修正：拒绝/完成路径都释放锁（旧实现只靠 600s 陈旧回收——神秘占锁者来源）。
  // TD-256 修复（opus 会审实锤）：旧实现写 `io?.unlinkSync ?? require("node:fs").unlinkSync`——
  // 本函数作用域无 io、ESM 无 require → ReferenceError 被 catch 吞掉，"拒绝/完成
  // 都释放锁"整段失效（锁只能等 600s 陈旧回收）。修法：直接用顶部具名导入的
  // unlinkSync；回归形状=拒绝后立即重跑不得 lock_held。
  const releaseRecycleLock = () => { try { unlinkSync(recycleLockPath); } catch { /* 已不在场 */ } };
  const instances = ops.readServeInstances({ kimiHome });
  // TD-261a（0063，opus 条款）：同端口多实例记录（复活后新旧并存是常态）——取
  // pid 存活者中最新心跳（否则最新心跳）；taskkill 回退前再核验镜像名。
  const instance = pickInstanceByPort(instances, port);
  if (!instance) { releaseRecycleLock(); return { refused: "no_instance", port }; }

  // WAO 侧门：全部项目桶、active-only（新鲜 owner 心跳的非终态 run）。unresolved
  // （非终态但心跳死）不堵门——其上游活轮由 serve 侧 busy/集合 soak 兜底。
  const active = await listRunsFn({ runDir, activeOnly: true });
  const activeKimi = (active?.runs ?? active?.items ?? [])
    .filter((r) => Array.isArray(kimiAgentIds) && kimiAgentIds.includes(r.agentId));
  if (activeKimi.length > 0) {
    releaseRecycleLock();
    return { refused: "active_runs", runs: activeKimi.map((r) => ({ runId: r.runId, agentId: r.agentId })) };
  }

  // serve 侧门：快照 → soak → 集合比对复探。TD-252①（TD-256 批）：快照面
  // 同时覆盖默认列表与归档列表——0057 W2 用 `sessions:archive` 归档的会话在
  // 默认列表隐藏（归档≠不可运行），只拉默认面的 soak 看不见它们。两面任一
  // 不可观测即拒绝（不能证明集合完整就不回收）；按 id 合并去重，同 id 双面
  // 出现时 busy 取或（保守方向）。
  // TD-261a（0063）：双面**都实际探测**（旧实现 normal 面失败即早退，拿不到
  // 归档面证据——sol 条款）；首探无拒即**复用为 before 快照**（调用次序与旧
  // 代码逐调用一致——脚本化测试的帧语义保持）；连接拒绝单列分类。
  const probeFaces = async () => {
    const normal = await ops.listServeSessions({ baseUrl: serveUrl, token, fetchImpl, timeoutMs });
    const archived = await ops.listServeSessions({ baseUrl: serveUrl, token, fetchImpl, timeoutMs, archivedOnly: true });
    return { normal, archived };
  };
  const facesRefusal = ({ normal, archived }) => {
    // 拒绝名保持既有闭集（serve_unobservable/archived_unobservable）——连接拒绝
    // 细节 ride 在 reason 上（revive 判定读 faces.*.reason 原值，不改拒绝身份）。
    if (!normal.ok) return { refused: "serve_unobservable", reason: normal.reason };
    if (!archived.ok) return { refused: "archived_unobservable", reason: archived.reason };
    return null;
  };
  const mergeFaces = ({ normal, archived }) => {
    const byId = new Map();
    for (const it of [...normal.items, ...archived.items]) {
      const prev = byId.get(it.id);
      byId.set(it.id, prev
        ? { ...prev, busy: prev.busy || it.busy, mainTurnActive: prev.mainTurnActive || it.mainTurnActive }
        : it);
    }
    return { items: [...byId.values()], normalCount: normal.items.length, archivedCount: archived.items.length };
  };
  // TD-261a（0063，opus/sol 合订）：**死实例复活路径**——首探双面均 connection_
  // refused（主动拒绝=唯一可证"此端点无监听"的传输信号）+ 实例 pid 已死（区分
  // "serve 已死"与"正在启动未 bind"）+ 隔数秒复探仍双拒 → 保护前提（活会话）为
  // 空，跳过 soak/shutdown/杀步直接重启。混合结果/其它 reason 维持既有拒绝。
  let revived = false;
  let before = null;
  {
    const faces1 = await probeFaces();
    const refusal1 = facesRefusal(faces1);
    if (refusal1) {
      const bothRefused = faces1.normal.reason === "connection_refused" && faces1.archived.reason === "connection_refused";
      if (!bothRefused) { releaseRecycleLock(); return { refused: refusal1.refused, reason: refusal1.reason }; }
      if (pidAlive(instance.pid)) {
        releaseRecycleLock();
        return { refused: "serve_not_listening_pid_alive", reason: "connection refused but instance pid is alive (serve may be starting or port taken)", pid: instance.pid };
      }
      await sleepFn(3000); // 两次探测隔开（opus 条款——双面同刻打同一死端口不是独立证据）
      const faces2 = await probeFaces();
      const refusal2 = facesRefusal(faces2);
      const stillBothRefused = faces2.normal.reason === "connection_refused" && faces2.archived.reason === "connection_refused";
      if (!stillBothRefused) {
        releaseRecycleLock();
        return { refused: refusal2 ? refusal2.refused : "serve_recovered_mid_probe", reason: refusal2?.reason ?? "second probe no longer connection-refused" };
      }
      revived = true;
    } else {
      before = mergeFaces(faces1);
    }
  }
  await sleepFn(soakMs);
  let after = null;
  if (!revived) {
    const facesA = await probeFaces();
    const refusalA = facesRefusal(facesA);
    if (refusalA) { releaseRecycleLock(); return { refused: refusalA.refused, reason: refusalA.reason }; }
    after = mergeFaces(facesA);
  }
  const verdict = revived ? "clear" : soakVerdict(before, after);
  if (verdict !== "clear") {
    releaseRecycleLock();
    return {
      refused: verdict,
      sessionsBefore: before.items.length,
      sessionsAfter: after.items.length,
      archivedBefore: before.archivedCount,
      archivedAfter: after.archivedCount,
    };
  }

  // 杀：优雅 shutdown 优先；完成由端口死亡证实，超时回退 taskkill /T /F。
  // 复活路径跳过（无可杀者；且不得凭陈旧实例 pid 调 taskkill——sol 条款）。
  // 决定 0075 会审（sol）：从这里到重启就绪，端口上会有一段没有监听——占住按需拉起用的
  // 启动锁，让这段窗口里到来的派发只等、不抢着拉第二个。放锁点：下方三个出口。
  const startLock = holdServeStartLock({ port, now: nowMs() });
  let portDown = revived;
  let killFallback = null;
  if (!revived) {
    const shutdown = await ops.shutdownServe({ baseUrl: serveUrl, token, fetchImpl, timeoutMs });
    if (shutdown.outcome !== "requested") {
      releaseServeStartLock(startLock);
      releaseRecycleLock();
      return { refused: "shutdown_rejected", reason: shutdown.reason, ...(shutdown.code !== undefined ? { code: shutdown.code } : {}) };
    }
    for (let i = 0; i < 15; i += 1) {
      await sleepFn(1000);
      // 探活只看传输层生死（连接拒绝=已死；任何 HTTP 应答=还活着——含 401）。
      // 3s 有界：挂起连接不能拖住回收序列。（此探针语义=杀后死亡证实，与复活
      // 资格判定的严格双面 connection_refused 不同——sol 条款。）
      portDown = await Promise.race([
        fetchFn(fetchImpl, `${serveUrl}/api/v1/sessions`, 3000).then(() => false, () => true),
        sleepFn(3500).then(() => true),
      ]);
      if (portDown) break;
    }
    if (!portDown) {
      // TD-261a（0063，opus 条款）：taskkill 前核验镜像名——pid 复用会打到无关
      // 进程树；非 kimi 镜像即放弃强杀（如实上报，端口仍活=后续门自会拒）。
      killFallback = await new Promise((resolve) => {
        const exec = execFileFn ?? nodeExecFile;
        exec(
          "tasklist", ["/FI", `PID eq ${instance.pid}`, "/FO", "CSV", "/NH"],
          { timeout: 10_000, windowsHide: true },
          (err, stdout) => {
            if (err) return resolve({ ok: false, reason: "image_check_failed" });
            const image = String(stdout ?? "").split(",")[0]?.replace(/"/g, "").toLowerCase() ?? "";
            if (!image.includes("kimi")) return resolve({ ok: false, reason: "pid_image_mismatch", image });
            exec(
              "taskkill", ["/PID", String(instance.pid), "/T", "/F"],
              { timeout: 15_000, windowsHide: true },
              (error) => resolve(error ? { ok: false } : { ok: true }),
            );
          },
        );
      });
      await sleepFn(3000);
    }
  }

  // 重启：env 由命令显式组装——WAO_IN_WORKER=1 恒注入（0047 env 臂），绝不继承
  // 操作员 shell 的偶然值；detached + ignore stdio（长命 serve 不挂 CLI 生命周期）。
  // TD-261b（0063，opus/sol 合订）：spawn 的 'error' 事件**同步挂上并仲裁**
  //（unhandled 'error' event 是当日进程崩根因）；ENOENT 按候选链降级重试；全部
  // 候选失败=结构化失败+台账行——绝不崩、绝不静默留死 serve。exe 已在一切副作用
  // 之前解析（exeResolution），运行期失败（文件被删等）走候选降级兜底。
  // 环境组装（WAO_IN_WORKER、effective home 纪律、剔密钥类变量——决定 0058 / 0074）与
  // detached spawn 仲裁都在 backends/kimiServeStart.js，与按需拉起共用一份。
  const { child, error: restartError, triedCandidates } = await spawnServeDetached({
    candidates: exeResolution.candidates,
    port,
    workspaceDir,
    env: kimiServeChildEnv(process.env, kimiHome),
    spawnFn,
    sleepFn,
  });
  if (!child) {
    // 全候选失败：台账+锁释放+结构化失败（CLI 侧非零退出）。
    try {
      const ledgerDir = serveMaintenanceDir(lockRootDir);
      mkdirSync(ledgerDir, { recursive: true });
      appendFileSync(join(ledgerDir, "recycle-ledger.jsonl"), JSON.stringify({
        ts: new Date().toISOString(), event: "restart_failed", oldPid: instance.pid, revived,
        triedCandidates, errorCode: restartError?.code ?? null,
      }) + "\n", "utf8");
    } catch { /* 台账失败不掩盖主结果 */ }
    releaseServeStartLock(startLock);
    releaseRecycleLock();
    return {
      recycled: false,
      restart: "failed",
      reason: "kimi_spawn_failed",
      errorCode: restartError?.code ?? null,
      triedCandidates,
      oldPid: instance.pid,
      revived,
      manualRecipe: "docs/usage.md TD-250 节（手动配方：PowerShell Start-Process 全路径 + --port <port> + worker ws + WAO_IN_WORKER=1）",
      note: "shutdown 已执行——kimi 自清实例文件，重跑 recycle 将 no_instance 拒绝；按 manualRecipe 手动拉起",
    };
  }
  child.unref?.();

  // 就绪：轮询会话面 code===0，有界 30s。
  let ready = false;
  for (let i = 0; i < 15; i += 1) {
    await sleepFn(2000);
    const check = await ops.listServeSessions({ baseUrl: serveUrl, token, fetchImpl, timeoutMs: 4000 });
    if (check.ok) { ready = true; break; }
  }
  const newInstance = pickInstanceByPort(ops.readServeInstances({ kimiHome }), port);
  const children = newInstance ? await ops.countServeChildren({ pid: newInstance.pid, execFileFn }) : -1;
  // TD-251 W1c + TD-262a（0063）：荚已死、句柄已释——补扫本工作区的空 worktree 壳，
  // 已删壳走**转录门控**分支回收（accepted 交付壳/非只读壳保留——sol 反例条款）。
  const husks = sweepEmptyWorktreeHusks(join(lockRootDir, ".wao-worktrees"));
  const huskBranches = await recycleHuskBranches(husks, { lockRootDir, runDir });
  releaseServeStartLock(startLock);
  releaseRecycleLock();
  return {
    recycled: true,
    ready,
    ...(revived && ready ? { revived: true } : {}),
    oldPid: instance.pid,
    newPid: newInstance?.pid ?? null,
    portDownVerified: portDown,
    killFallback,
    newServeChildren: children,
    ...(husks.length > 0 ? { emptyWorktreeHusksSwept: husks.length } : {}),
    ...(huskBranches.length > 0 ? { huskBranches } : {}),
  };
}

/** status：实例元数据 + 荚规模 + 会话面（零副作用观察）。 */
export async function serveStatusReport({ port, serveUrl, token, ops = defaultOps, fetchImpl = globalThis.fetch, timeoutMs, nowMs = Date.now, execFileFn = null, kimiHome = null }) {
  const instances = ops.readServeInstances({ kimiHome });
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
