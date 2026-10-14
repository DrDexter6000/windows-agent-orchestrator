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
//     的信号）。首探是别的任何结果（HTTP 应答、超时、其它传输错误）一律不动，照常由请求
//     路径报错；
//   - 启动锁（系统临时目录下按端口的文件）让同时到来的派发只有一个去拉、其余等待；它是
//     去重，不是严格互斥——严格互斥是端口绑定。recycle 在关旧起新的窗口里占同一把锁；
//   - 有活着的 serve 进程（心跳新鲜的实例记录，或上一次拉起后一直没应答的那个）就不再拉，
//     只等，等不到就报错并点名 pid；绝不杀进程；
//   - 只拉起，不关、不重启、不清扫——那些仍是 `wao serve` 的手动命令（决定 0056）。唯一的
//     例外是空闲看护：本进程拉起的 serve 会带一个看护进程，空闲满阈值时抢锁复核后**优雅**
//     关停它（决定 0079；见 kimiServeIdleWatch.js）——绝不强杀。
//
// spawn 形状（2026-10-13 实测，kimi 2.1.1 / Node 22）：`detached: true, stdio: "ignore"`
// 起的 serve 在拉起它的进程退出后继续运行，worker 跑命令时没有可见窗口；只给
// `windowsHide: true`、不给 detached 的 serve 随父进程退出而消失——不可用。

import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { NESTED_DISPATCH_BYPASS_ENV } from "../envPolicy.js";
import { isSecretEnvName } from "../secretRedaction.js";
import { readServeInstances, serveRequest, shutdownServe } from "./kimiServeOps.js";

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
 * serve 及其看护进程共用的环境**剔除规则**（不注入任何东西——注入归各自的组装方）：
 *   - WAO 自己的变量（`WAO_*`，不分大小写）与嵌套派发豁免变量：拉起者进程的控制面状态
 *     不进长命子进程（决定 0075 会审——豁免跟进 serve 会成为此后所有 worker 的常驻豁免）；
 *   - 密钥类变量（决定 0074；代理变量保留，联网要用）；
 *   - Lead 宿主的会话变量（`CLAUDE*` / `ANTHROPIC*`，不分大小写）：拉起者是 Claude Code
 *     等宿主时，宿主的会话变量会跟进 serve 与此后所有 worker 的工具进程——与手动脚本
 *     scripts/kimi-serve.ps1 的规则 `^(CLAUDE|ANTHROPIC|WAO_)` 对齐。
 * 其余变量原样继承。
 */
export function stripServeEnvVars(baseEnv) {
  const out = { ...baseEnv };
  const bypassUpper = NESTED_DISPATCH_BYPASS_ENV.toUpperCase();
  for (const name of Object.keys(out)) {
    const upper = name.toUpperCase();
    if (upper.startsWith("WAO_") || upper === bypassUpper) delete out[name];
    else if (upper.startsWith("CLAUDE") || upper.startsWith("ANTHROPIC")) delete out[name];
    else if (isSecretEnvName(name) && !/_PROXY$/i.test(name)) delete out[name];
  }
  return out;
}

/**
 * serve 子进程的环境。WAO_IN_WORKER=1 恒注入（0047 env 臂）。
 * TD-253（决定 0058，双席修正）：effective home 纪律——kimiHome 在场显式注入
 * KIMI_CODE_HOME；缺席则**删除**继承来的 KIMI_CODE_HOME（否则在设了新家的 shell 里
 * 重启默认家的 serve，会把它起到新家去）。
 * 决定 0074：serve 把自己的环境传给工具 shell 与 MCP 子进程，worker 读得到——serve 用的
 * 是主目录里的登录态，不需要调用方环境里的密钥（剔除规则见 stripServeEnvVars）。
 * 其余变量原样继承：serve 的环境因此仍取决于是谁把它拉起来的（登记在决定 0075）。
 */
export function kimiServeChildEnv(baseEnv, kimiHome) {
  const childEnv = stripServeEnvVars(baseEnv);
  childEnv.WAO_IN_WORKER = "1";
  if (typeof kimiHome === "string" && kimiHome.length > 0) childEnv.KIMI_CODE_HOME = kimiHome;
  else delete childEnv.KIMI_CODE_HOME;
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

// ── 启动锁 ───────────────────────────────────────────────────────────────
//
// 系统临时目录下按端口的一个文件：{ pid, nonce, ts, childPid? }。
// 为什么要它（2026-10-13 实测，kimi 2.1.1）：端口被占时第二个 `kimi web --port N` **不退出**，
// 而是改绑 N+1 并照常登记实例、一直运行。重复拉起不会自己消失，会留下没人管的 serve——
// 所以拉起必须去重，拉起者事后还要核对自己的子进程落在了哪个端口（见 ensureServeRunning）。
//   - wx 独占创建；放锁时核对 nonce，只删自己的；
//   - 陈旧（120 秒）接手：先删再 wx 重建，同时接手的几个进程里只有一个建得成。"读到陈旧"
//     与"删"之间别人恰好建了新锁的窗口仍在（文件系统给不了原子的"比较后删除"），那时会
//     多拉一个——由拉起者的事后核对收拾；
//   - 内容读不出来（空文件、写到一半）按文件修改时间算陈旧，不会永久挡路；
//   - 拉起过子进程就把它的 pid 记进锁；等不到应答时锁**留下**，后来的派发看到那个 kimi
//     进程还活着就不再拉（见 ensureServeRunning）；
//   - 锁文件写不了（临时目录异常）= 不拉，报错点名：没有去重就不冒留下多余 serve 的险。

// 陈旧界：拉起 + 等待应答的上界之外再留余量。
const START_LOCK_STALE_MS = 120_000;

/** 按端口的启动锁位置（锁属于这台机器上的这个端口，不属于某个项目）。 */
export function serveStartLockPath(port, lockDir = tmpdir()) {
  return join(lockDir, `wao-kimi-serve-start-${port}.lock`);
}

function lockBody(nonce, now, childPid) {
  return JSON.stringify({ pid: process.pid, nonce, ts: now, ...(Number.isInteger(childPid) ? { childPid } : {}) });
}

// 返回 null = 文件不在；否则 { raw, ts, pid, nonce, childPid }（内容读不出来时 ts 取修改时间）。
function readStartLock(lockPath) {
  let raw;
  try { raw = readFileSync(lockPath, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return null;
    raw = "";
  }
  try {
    const parsed = JSON.parse(raw);
    if (Number.isFinite(parsed?.ts)) {
      return { raw, ts: parsed.ts, pid: Number.isInteger(parsed.pid) ? parsed.pid : null, nonce: typeof parsed.nonce === "string" ? parsed.nonce : null, childPid: Number.isInteger(parsed.childPid) ? parsed.childPid : null };
    }
  } catch { /* 走修改时间 */ }
  try { return { raw, ts: statSync(lockPath).mtimeMs, pid: null, nonce: null, childPid: null }; } catch { return null; }
}

/** 某个 pid 是否还是一个活着的进程（不核镜像名；拿不到权限也算活着）。 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

/**
 * 某个 pid 是否是一个还活着的 kimi 进程。pid 会被复用，所以核验镜像名（与 recycle 强杀前
 * 的核验同一做法）；查不出来按"不是"处理——宁可多拉一次，不让一个无关进程永久挡路。
 */
export function isKimiProcessAlive(pid, { execFileSyncFn = execFileSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (error) { if (error?.code !== "EPERM") return false; }
  try {
    const out = String(execFileSyncFn("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }));
    return (out.split(",")[0] ?? "").replace(/"/g, "").toLowerCase().includes("kimi");
  } catch { return false; }
}

/**
 * 试着成为拉起者。返回：
 *   { held: true, nonce, lockPath }            —— 拿到了
 *   { held: false }                            —— 别人持有且未陈旧
 *   { held: false, unavailable: true }         —— 锁文件写不了
 *   { held: false, blockedByChildPid }         —— 上一次拉起的 kimi 进程还活着
 * holderAliveFn（可选）：给了就只在确认持锁进程已不在时接管陈旧锁——空闲看护用它。持锁者
 * 活着、或认不出来（锁里没有 pid、内容读不出来）都不删别人的锁；按需拉起不传，沿用「陈旧即
 * 接管」（决定 0075）。
 */
export function acquireServeStartLock({ lockPath, now, childAliveFn = isKimiProcessAlive, holderAliveFn = null, nonce = randomUUID() }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockPath, lockBody(nonce, now), { flag: "wx" });
      return { held: true, nonce, lockPath };
    } catch (error) {
      if (error?.code !== "EEXIST") return { held: false, unavailable: true };
    }
    const prev = readStartLock(lockPath);
    if (prev === null) continue; // 刚被放掉：再抢一次
    if (prev.childPid !== null && childAliveFn(prev.childPid)) return { held: false, blockedByChildPid: prev.childPid };
    if (now - prev.ts <= START_LOCK_STALE_MS) return { held: false };
    if (typeof holderAliveFn === "function" && (prev.pid === null || holderAliveFn(prev.pid))) return { held: false };
    // 陈旧：确认还是刚才读到的那一份再删，然后回到 wx 去抢。
    const again = readStartLock(lockPath);
    if (again !== null && again.raw === prev.raw) { try { unlinkSync(lockPath); } catch { /* 别人先删了 */ } }
  }
  return { held: false };
}

/** 放锁：只删自己的（nonce 对得上）。 */
export function releaseServeStartLock(lock) {
  if (!lock?.held || typeof lock.nonce !== "string") return;
  const current = readStartLock(lock.lockPath);
  if (current !== null && current.nonce === lock.nonce) { try { unlinkSync(lock.lockPath); } catch { /* 已不在场 */ } }
}

/**
 * recycle 用：在"关旧的、起新的"这段窗口里占住启动锁，让同时到来的派发只等、不抢着拉。
 * 无条件写入（recycle 是执行重启的一方），返回的句柄交给 releaseServeStartLock。
 */
export function holdServeStartLock({ port, lockDir = tmpdir(), now = Date.now() }) {
  const lockPath = serveStartLockPath(port, lockDir);
  const nonce = randomUUID();
  try { writeFileSync(lockPath, lockBody(nonce, now)); } catch { return { held: false, nonce: null, lockPath }; }
  return { held: true, nonce, lockPath };
}

// ── 按需拉起 ─────────────────────────────────────────────────────────────

// 等待应答的上界，自首探之后起算（实测冷启动到会话面应答约 2 秒）。单次探测另有 4 秒超时，
// 所以整个调用的墙钟上界比它略长。
const READY_TIMEOUT_MS = 45_000;
const READY_POLL_MS = 1_000;
const PROBE_TIMEOUT_MS = 4_000;
// 端口有 HTTP 应答、但会话面不是 code 0（例如不认这个 token）连续这么多拍 → 不再等，
// 交回请求路径去报。探测超时 / 传输错误不算应答，继续等。
const ANSWERED_NOT_OK_POLLS = 5;
// 实例记录的心跳在这个时间内、且那个 pid 确是活着的 kimi 进程 = serve 进程还在（实测心跳
// 间隔不超过约 15 秒；崩溃或断电留下的记录过不了 pid 核验）。
const INSTANCE_HEARTBEAT_FRESH_MS = 60_000;

function isLoopbackUrl(serveUrl) {
  try {
    const host = new URL(serveUrl).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch { return false; }
}

function startError(reason) {
  return new Error(
    `kimi-web backend: the worker serve is not running and could not be started (${reason}) `
    + "— check the lane's serveWorkspaceDir / kimiHome, or start it by hand (docs/usage/lanes.md, kimi worker serve)",
  );
}

/**
 * 核对本次拉起的子进程落在哪个端口（按需拉起与 recycle 共用的一份）。kimi 在端口被占时
 * 不退出而是改绑下一个端口并照常登记实例（决定 0075 实测）——实例记录不在目标端口上 =
 * 多拉了一个（目标端口在此期间被别人占了）→ 用同一主目录的 token 请它优雅退出。
 * 只动本次拉起的这一个；没有它的记录（没登记就退出了，或还没写）→ 无从判断，不动。
 * 返回 null（在目标端口 / 无从判断）或 displaced 事实 { pid, port, shutdown }。
 */
export async function settleOwnServeChild({
  pid, port, token, kimiHome = null,
  readInstancesFn = readServeInstances,
  shutdownFn = shutdownServe,
  fetchImpl = globalThis.fetch,
  sleepFn,
  pollMs = READY_POLL_MS,
  polls = 5,
}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  for (let i = 0; i < polls; i += 1) {
    const record = readInstancesFn({ kimiHome }).find((x) => x.pid === pid);
    if (record) {
      if (record.port === port) return null;
      const r = await shutdownFn({ baseUrl: `http://127.0.0.1:${record.port}`, token, fetchImpl, timeoutMs: 8000 });
      return { pid, port: record.port, shutdown: r?.outcome === "requested" ? "requested" : "failed" };
    }
    if (i < polls - 1) await sleepFn(pollMs);
  }
  return null;
}

/**
 * 派发前的 serve 在场保证。
 * 返回 null = 什么都没做（车道没声明工作目录 / 非回环地址 / 首探不是"连接被拒"）。
 * 返回 { started, pid, waitedMs, answer } = 首探连接被拒，之后等到了应答。started=false
 * 表示是别的进程拉的；answer 为 "ok"（会话面 code 0）或 "rejected"（端口有 HTTP 应答但
 * 不是 code 0——交回请求路径去报）。本进程拉起且应答 ok 且未被挤走时，返回值另带
 * idleWatch（空闲看护的启动结果——看护起不来不报错，结果如实带回）。
 * displaced 在场 = 本进程拉起的那个 serve 落在了别的端口（目标端口在此期间被别人占了），
 * 已请它优雅退出（shutdown: requested | failed）——此时 started 为 false。
 * 拉不起来或等不到应答 → 抛固定文案的错误：原因取自闭集，不含 token、serveUrl 与上游正文。
 *
 * 不拉的三种情形（都只等，等不到就报错，绝不杀任何进程）：
 *   - 别的进程持有未陈旧的启动锁（另一条派发或 recycle 正在拉）；
 *   - 这个端口的实例记录心跳新鲜——serve 进程活着但没在监听（正在退出，或挂住了）；
 *   - 上一次拉起的 kimi 进程还活着却一直没应答（pid 记在留下的锁里）。
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
  readInstancesFn = readServeInstances,
  childAliveFn = isKimiProcessAlive,
  shutdownFn = shutdownServe,
  // 空闲看护的启动函数（调用方注入；不注入就不起——kimi-web 传 startServeIdleWatch）。
  startWatchFn = null,
}) {
  if (typeof workspaceDir !== "string" || workspaceDir.length === 0) return null;
  if (!isLoopbackUrl(serveUrl)) return null;
  const port = Number(new URL(serveUrl).port);
  if (!Number.isInteger(port) || port <= 0) return null;
  // 探针四态：refused（无监听）/ ok（code 0）/ answered（有 HTTP 应答但不是 code 0）/
  // unknown（超时、其它传输错误——既不能证明无监听，也不是应答）。
  const probe = async () => {
    const r = await serveRequest({ baseUrl: serveUrl, token, method: "GET", path: "/api/v1/sessions?page_size=1", fetchImpl, timeoutMs: PROBE_TIMEOUT_MS });
    if (r.connectionRefused) return "refused";
    if (r.aborted || r.transportError) return "unknown";
    return r.code === 0 ? "ok" : "answered";
  };
  if ((await probe()) !== "refused") return null;

  const startedAt = nowMs();
  const lockPath = serveStartLockPath(port, lockDir);
  let lock = null;
  let started = false;
  let pid = null;
  let answer = null;
  let waitingOn = "another_starter";
  let answeredNotOk = 0;
  let displaced = null;
  const liveInstancePid = () => {
    const now = nowMs();
    const live = readInstancesFn({ kimiHome })
      .find((i) => i.port === port && Number.isFinite(i.heartbeatAt) && now - i.heartbeatAt <= INSTANCE_HEARTBEAT_FRESH_MS && childAliveFn(i.pid));
    return live ? live.pid : null;
  };
  try {
    for (;;) {
      const state = await probe();
      if (state === "ok") { answer = "ok"; break; }
      if (state === "answered") {
        answeredNotOk += 1;
        if (answeredNotOk >= ANSWERED_NOT_OK_POLLS) { answer = "rejected"; break; }
      } else {
        answeredNotOk = 0;
      }
      // 还没人应答、本进程也还没拉过：每一拍重新看能不能轮到自己（别人放了锁、旧进程退
      // 干净了，都可能发生在等待途中）。
      if (state === "refused" && !started) {
        const instancePid = liveInstancePid();
        if (instancePid !== null) {
          waitingOn = `serve_alive_not_listening pid ${instancePid}`;
        } else {
          if (lock === null || !lock.held) lock = acquireServeStartLock({ lockPath, now: nowMs(), childAliveFn });
          if (lock.unavailable) throw startError(`start_lock_unavailable ${lockPath}`);
          if (!lock.held) {
            waitingOn = Number.isInteger(lock.blockedByChildPid)
              ? `earlier_start_still_running_without_answering pid ${lock.blockedByChildPid}`
              : `another_starter, lock file ${lockPath}`;
          } else if ((await probe()) === "refused") { // 拿到锁之后复探：上一个持锁者可能刚拉完
            const shapeRefusal = serveWorkspaceShapeRefusal(workspaceDir);
            if (shapeRefusal) throw startError(shapeRefusal);
            const exeResolution = resolveKimiExe({ kimiExe, kimiHome, env });
            if (exeResolution.refused) throw startError(exeResolution.refused);
            const placementRefusal = serveWorkspacePlacementRefusal(workspaceDir, kimiHome);
            if (placementRefusal) throw startError(placementRefusal);
            const spawned = await spawnServeDetached({
              candidates: exeResolution.candidates, port, workspaceDir, env: kimiServeChildEnv(env, kimiHome), spawnFn, sleepFn,
            });
            if (!spawned.child) {
              const code = typeof spawned.error?.code === "string" && /^[A-Z0-9_]{1,24}$/.test(spawned.error.code) ? ` ${spawned.error.code}` : "";
              throw startError(`kimi_spawn_failed${code}`);
            }
            spawned.child.unref?.();
            started = true;
            pid = Number.isInteger(spawned.child.pid) ? spawned.child.pid : null;
            // 把子进程 pid 记进自己的锁：等不到应答时锁会留下，后来的派发据此不再重复拉。
            try { writeFileSync(lockPath, lockBody(lock.nonce, nowMs(), pid)); } catch { /* 记不上不影响本次 */ }
          }
        }
      }
      if (nowMs() - startedAt > readyTimeoutMs) {
        if (!started) throw startError(`not_ready_in_time waiting on ${waitingOn}`);
        displaced = await settleOwnServeChild({ pid, port, token, kimiHome, readInstancesFn, shutdownFn, fetchImpl, sleepFn });
        throw startError(displaced
          ? `not_ready_in_time started pid ${displaced.pid} landed on port ${displaced.port}, exit ${displaced.shutdown}`
          : `not_ready_in_time started pid ${pid ?? "unknown"}, left running`);
      }
      await sleepFn(READY_POLL_MS);
    }
    displaced = await settleOwnServeChild({ pid, port, token, kimiHome, readInstancesFn, shutdownFn, fetchImpl, sleepFn });
  } finally {
    // 起了进程、没等到应答、它也没落到别处：锁留下（里面记着那个进程）。其余情形放掉自己的锁。
    if (!(started && answer === null && displaced === null)) releaseServeStartLock(lock);
  }
  if (displaced) return { started: false, pid: null, waitedMs: nowMs() - startedAt, answer, displaced };
  // 自己拉起、应答 ok、没被挤走：给它配一个空闲看护（决定 0079——WAO 拉起的
  // serve 空闲时自己退出；kimi 无空闲超时选项，做法是跟着 serve 走的看护进程，见
  // kimiServeIdleWatch.js）。别的进程拉起的、被挤走的，都不配。看护起不来不能让派发失败：
  // 失败结果如实放进返回值。
  let idleWatch = null;
  if (started && answer === "ok" && Number.isInteger(pid) && typeof startWatchFn === "function") {
    try { idleWatch = startWatchFn({ port, pid, kimiHome }); } catch { idleWatch = { started: false, reason: "start_failed" }; }
  }
  return { started, pid, waitedMs: nowMs() - startedAt, answer, ...(idleWatch ? { idleWatch } : {}) };
}
