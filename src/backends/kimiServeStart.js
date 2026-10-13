// src/backends/kimiServeStart.js
//
// 决定 0075（2026-10-13）：kimi worker serve 的启动原语，以及"派发时发现 serve 没在跑
// 就把它拉起来"。
//
// 启动原语（exe 解析、工作目录门、子进程环境、detached spawn 与 'error' 仲裁）原在
// application/serveMaintenance.js 的 recycle 重启段；迁到 backend 层是为了让 kimi-web
// backend 用同一份——"WAO 怎么启动一个 kimi serve"只有一个定义，recycle 与按需拉起共用。
//
// 按需拉起（ensureServeRunning）的边界：
//   - 只在车道声明了 serveWorkspaceDir 时发生（serve 的工作目录没有隐藏默认——沿用
//     recycle 的纪律；声明这个字段就是允许 WAO 拉起 serve）；
//   - 只在回环地址上、且探测结果是"连接被拒"时发生（主动拒绝是唯一可证"此端点无监听"
//     的信号）。有任何应答（含鉴权失败）一律不动，照常由请求路径报错；
//   - 同一端口同时只有一个进程在拉（系统临时目录下按端口的锁文件），其余只等就绪；
//   - 只拉起，不关、不重启、不清扫——那些仍是 `wao serve` 的手动命令（决定 0056）。
//
// spawn 形状（2026-10-13 实测，kimi 2.1.1 / Node 22）：`detached: true, stdio: "ignore"`
// 起的 serve 在拉起它的进程退出后继续运行，worker 跑命令时没有可见窗口；只给
// `windowsHide: true`、不给 detached 的 serve 随父进程退出而消失——不可用。

import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isSecretEnvName } from "../secretRedaction.js";
import { serveRequest } from "./kimiServeOps.js";

/**
 * TD-261b（0063，opus/sol 会审合订）：重启 exe 的**前置**解析（shutdown 之前——
 * 杀了旧 serve 才发现没 exe 是最糟形状）。返回 { exe, candidates } 或
 * { refused: "kimi_exe_unresolvable", tried }。
 * 显式路径（含分隔符/.exe 后缀）= 指定执行器：existsSync 不过即拒，不降级（sol）；
 * 默认短名 "kimi" = 候选链降级：kimiHome/bin → PATH 扫描（.exe/.com，libuv 规则
 * 不认 .cmd——opus）→ homedir/.kimi-code/bin/kimi.exe。
 */
export function resolveKimiExe({ kimiExe = "kimi", kimiHome = null, env = process.env, existsFn = existsSync, homeDirFn = homedir }) {
  const isExplicitPath = typeof kimiExe === "string" && (/[\\/]/.test(kimiExe) || kimiExe.toLowerCase().endsWith(".exe"));
  if (isExplicitPath) {
    if (existsFn(kimiExe)) return { exe: kimiExe, candidates: [kimiExe] };
    return { refused: "kimi_exe_unresolvable", tried: [kimiExe] };
  }
  const tried = [];
  const candidates = [];
  if (typeof kimiHome === "string" && kimiHome.length > 0) {
    const p = join(kimiHome, "bin", "kimi.exe");
    tried.push(p);
    if (existsFn(p)) candidates.push(p);
  }
  const pathDirs = String(env?.PATH ?? "").split(";").filter(Boolean);
  for (const ext of [".exe", ".com"]) {
    for (const dir of pathDirs) {
      const p = join(dir, `kimi${ext}`);
      if (!tried.includes(p)) {
        tried.push(p);
        if (existsFn(p)) candidates.push(p);
      }
    }
  }
  const fallback = join(homeDirFn(), ".kimi-code", "bin", "kimi.exe");
  tried.push(fallback);
  if (existsFn(fallback)) candidates.push(fallback);
  if (candidates.length > 0) return { exe: candidates[0], candidates };
  return { refused: "kimi_exe_unresolvable", tried };
}

/**
 * serve 工作目录的形状门：给了、且是目录。返回拒绝名或 null。
 * TD-261b（0063，opus 实锤）：目录缺失会让放置门的 git -C 失败被误读为"不在工作树内
 * =通过"，spawn 的 ENOENT 再被误归因于 exe——显式 isDirectory 门。
 */
export function serveWorkspaceShapeRefusal(workspaceDir) {
  if (typeof workspaceDir !== "string" || workspaceDir.length === 0) return "workspace_dir_required";
  try {
    if (!statSync(workspaceDir).isDirectory()) return "workspace_dir_invalid";
  } catch { return "workspace_dir_invalid"; }
  return null;
}

/**
 * serve 工作目录的放置门（TD-253，opus Q5）：cwd 句柄钉目录（W1c 实证）+ 项目发现面 +
 * 家内污染——不在 .wao-worktrees 下、不在 kimi 主目录内、不在任何 git 工作树内。
 * 返回拒绝名或 null。
 */
export function serveWorkspacePlacementRefusal(workspaceDir, kimiHome) {
  const wsNorm = workspaceDir.replace(/[\\]/g, "/").toLowerCase().replace(/\/+$/, "");
  if (wsNorm.includes("/.wao-worktrees/")) return "workspace_dir_inside_worktrees";
  if (typeof kimiHome === "string" && kimiHome.length > 0) {
    const khNorm = kimiHome.replace(/[\\]/g, "/").toLowerCase().replace(/\/+$/, "");
    if (wsNorm === khNorm || wsNorm.startsWith(khNorm + "/")) return "workspace_dir_inside_kimi_home";
  }
  try {
    execFileSync("git", ["-C", workspaceDir, "rev-parse", "--is-inside-work-tree"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5000 });
    return "workspace_dir_inside_git_worktree";
  } catch { /* 不在 git 工作树内=通过 */ }
  return null;
}

/**
 * serve 子进程的环境。WAO_IN_WORKER=1 恒注入（0047 env 臂）。
 * TD-253（决定 0058，双席修正）：effective home 纪律——kimiHome 在场显式注入
 * KIMI_CODE_HOME；缺席则**删除**继承来的 KIMI_CODE_HOME（否则在设了新家的 shell 里
 * 重启默认家的 serve，会把它起到新家去）。
 * 决定 0074：serve 把自己的环境传给工具 shell 与 MCP 子进程，worker 读得到——serve 用的
 * 是主目录里的登录态，不需要调用方环境里的密钥：按名字规则剔除（代理变量保留，联网要用）。
 */
export function kimiServeChildEnv(baseEnv, kimiHome) {
  const childEnv = { ...baseEnv, WAO_IN_WORKER: "1" };
  if (typeof kimiHome === "string" && kimiHome.length > 0) childEnv.KIMI_CODE_HOME = kimiHome;
  else delete childEnv.KIMI_CODE_HOME;
  for (const name of Object.keys(childEnv)) {
    if (isSecretEnvName(name) && !/_PROXY$/i.test(name)) delete childEnv[name];
  }
  return childEnv;
}

/**
 * 按候选链 detached 拉起 `kimi web`（长命 serve 不挂调用方的生命周期）。
 * TD-261b（0063，opus/sol 合订）：spawn 的 'error' 事件**同步挂上并仲裁**（unhandled
 * 'error' event 是当日进程崩根因）；ENOENT 按候选链降级重试，非 ENOENT（权限/损坏等）
 * 不降级（sol 条款）。返回 { child, error, triedCandidates }——child 为 null 即全部失败。
 */
export async function spawnServeDetached({ candidates, port, workspaceDir, env, spawnFn = null, sleepFn }) {
  const spawn = spawnFn ?? nodeSpawn;
  const spawnArgs = ["web", "--no-open", "--port", String(port)];
  const spawnOne = (exe) => new Promise((resolveSpawn) => {
    let child = null;
    let spawnErr = null;
    try {
      child = spawn(exe, spawnArgs, { cwd: workspaceDir, env, detached: true, stdio: "ignore" });
    } catch (e) { spawnErr = e; }
    if (spawnErr) return resolveSpawn({ err: spawnErr });
    if (typeof child?.once !== "function") return resolveSpawn({ child }); // 注入缝（测试假 spawn）：无事件面=按旧语义视为已发
    let settled = false;
    const settle = (err) => { if (settled) return; settled = true; resolveSpawn({ child, err: err ?? null }); };
    child.once("error", (e) => settle(e));
    child.once("spawn", () => settle(null));
    sleepFn(2000).then(() => settle(null)); // 仲裁有界：2s 内无 error 即放行进就绪轮询
  });
  let child = null;
  let error = null;
  const triedCandidates = [];
  for (const cand of candidates) {
    triedCandidates.push(cand);
    const r = await spawnOne(cand);
    if (!r.err) { child = r.child; error = null; break; }
    error = r.err;
    if (r.err?.code !== "ENOENT") break;
  }
  return { child, error, triedCandidates };
}

// ── 按需拉起 ─────────────────────────────────────────────────────────────

// 锁的陈旧界：拉起 + 就绪等待的上界之外再留余量。持锁进程崩了，下一次派发在此之后接手。
const START_LOCK_STALE_MS = 120_000;
// 就绪等待上界（实测冷启动到会话面应答约 3–7 秒）。
const READY_TIMEOUT_MS = 45_000;
const READY_POLL_MS = 1_000;
// 有应答但会话面不是 code 0（例如鉴权被拒）连续这么多拍 → 不再等，交回请求路径去报。
const ANSWERING_NOT_OK_POLLS = 5;

function isLoopbackUrl(serveUrl) {
  try {
    const host = new URL(serveUrl).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch { return false; }
}

/** 按端口的启动锁位置（系统临时目录——锁属于这台机器上的这个端口，不属于某个项目）。 */
export function serveStartLockPath(port, lockDir = tmpdir()) {
  return join(lockDir, `wao-kimi-serve-start-${port}.lock`);
}

// 尽力而为的互斥：wx 独占创建；已存在则读时间戳，超过陈旧界即接手。锁文件写不了
// （临时目录异常）不挡路——按持有者继续（代价至多是两个进程各拉一次，后到者绑不上端口）。
function acquireStartLock(lockPath, now) {
  const body = JSON.stringify({ pid: process.pid, ts: now });
  try {
    writeFileSync(lockPath, body, { flag: "wx" });
    return { held: true, release: true };
  } catch (error) {
    if (error?.code !== "EEXIST") return { held: true, release: false };
  }
  try {
    const prev = JSON.parse(readFileSync(lockPath, "utf8"));
    if (now - (Number.isFinite(prev?.ts) ? prev.ts : 0) > START_LOCK_STALE_MS) {
      writeFileSync(lockPath, body);
      return { held: true, release: true };
    }
  } catch { /* 读不出来=别人正在写，按别人持有处理 */ }
  return { held: false, release: false };
}

function startError(serveUrl, reason) {
  return new Error(
    `kimi-web backend: the worker serve at ${serveUrl} is not running and could not be started (${reason}) `
    + "— check the lane's serveWorkspaceDir / kimiHome, or start it by hand (docs/usage.md, kimi worker serve recipe)",
  );
}

/**
 * 派发前的 serve 在场保证。
 * 返回 null = 什么都没做（车道没声明工作目录 / 非回环地址 / serve 有应答）。
 * 返回 { started, pid, waitedMs } = 探到连接被拒之后等到了应答；started=false 表示
 * 是别的进程在拉、本进程只等。拉不起来或等不到应答 → 抛固定文案的错误（不含 token）。
 */
export async function ensureServeRunning({
  serveUrl,
  token,
  workspaceDir,
  kimiHome = null,
  kimiExe = "kimi",
  env = process.env,
  fetchImpl = globalThis.fetch,
  spawnFn = null,
  sleepFn = (ms) => new Promise((r) => { setTimeout(r, ms); }),
  nowMs = Date.now,
  lockDir = tmpdir(),
  readyTimeoutMs = READY_TIMEOUT_MS,
}) {
  if (typeof workspaceDir !== "string" || workspaceDir.length === 0) return null;
  if (!isLoopbackUrl(serveUrl)) return null;
  const port = Number(new URL(serveUrl).port);
  if (!Number.isInteger(port) || port <= 0) return null;
  // 探针：会话面取一条。三态——refused（无监听）/ ok（code 0）/ answering（其它任何结果）。
  const probe = async () => {
    const r = await serveRequest({ baseUrl: serveUrl, token, method: "GET", path: "/api/v1/sessions?page_size=1", fetchImpl, timeoutMs: 4000 });
    if (r.connectionRefused) return "refused";
    return r.code === 0 ? "ok" : "answering";
  };
  if ((await probe()) !== "refused") return null;

  const startedAt = nowMs();
  const lockPath = serveStartLockPath(port, lockDir);
  const lock = acquireStartLock(lockPath, startedAt);
  let started = false;
  let pid = null;
  try {
    // 拿到锁之后复探：上一个持锁者可能刚拉完。
    if (lock.held && (await probe()) === "refused") {
      const shapeRefusal = serveWorkspaceShapeRefusal(workspaceDir);
      if (shapeRefusal) throw startError(serveUrl, shapeRefusal);
      const exeResolution = resolveKimiExe({ kimiExe, kimiHome, env });
      if (exeResolution.refused) throw startError(serveUrl, exeResolution.refused);
      const placementRefusal = serveWorkspacePlacementRefusal(workspaceDir, kimiHome);
      if (placementRefusal) throw startError(serveUrl, placementRefusal);
      const spawned = await spawnServeDetached({
        candidates: exeResolution.candidates, port, workspaceDir, env: kimiServeChildEnv(env, kimiHome), spawnFn, sleepFn,
      });
      if (!spawned.child) {
        throw startError(serveUrl, `kimi_spawn_failed${spawned.error?.code ? ` ${spawned.error.code}` : ""}`);
      }
      spawned.child.unref?.();
      started = true;
      pid = Number.isInteger(spawned.child.pid) ? spawned.child.pid : null;
    }
    let answeringNotOk = 0;
    for (;;) {
      const state = await probe();
      if (state === "ok") break;
      if (state === "answering") {
        answeringNotOk += 1;
        if (answeringNotOk >= ANSWERING_NOT_OK_POLLS) break;
      } else {
        answeringNotOk = 0;
      }
      if (nowMs() - startedAt > readyTimeoutMs) {
        throw startError(serveUrl, started ? "not_ready_in_time" : "not_ready_in_time_while_another_run_was_starting_it");
      }
      await sleepFn(READY_POLL_MS);
    }
  } finally {
    if (lock.release) { try { unlinkSync(lockPath); } catch { /* 已不在场 */ } }
  }
  return { started, pid, waitedMs: nowMs() - startedAt };
}
