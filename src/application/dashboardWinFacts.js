// src/application/dashboardWinFacts.js
//
// 第 145b 批（决定 0131 第 2 条）：复用检查要的三个 Windows 事实，全部走结构化
// PowerShell（哨兵输出，不解析本地化文本）：
//   - readProcessCreatedAt(pid) — 操作系统的进程创建时间（Win32_Process.CreationDate，
//     DMTF → DateTime → 'o' → epoch ms）。同一活进程两次读取给出同一个值，所以
//     复用检查用严格相等比对 instance.json 里的 processCreatedAt——不是容差近似。
//   - listenerPidsOfPort(port) — TCP 监听表（Get-NetTCPConnection -State Listen，
//     127.0.0.1）里占住这个端口的 pid 集合；探测失败给 null（读作“查不出”，不猜）。
//   - probeProcessIdentity(pid, processCreatedAt) — 三值：same（活着且创建时间严格
//     相等）/ gone（pid 不在，或创建时间读得出但对不上=复用）/ unknown（活着但读不出）。
//
// 架构契约：不 import src/commands/*、src/mcp/*、MCP SDK 或 zod；子进程只有
// powershell.exe，参数是结构化 argv（pid/port 先过整数校验再嵌入 -Filter）。

import { execFile } from "node:child_process";
import { isPidAlive } from "./ownerLiveness.js";

const PROBE_TIMEOUT_MS = 20_000;

/**
 * 子进程环境：去掉 PSModulePath（145b 修正一 #10）。node 由 pwsh 7 启动时，
 * powershell.exe 会继承 PS7 的模块路径，Get-Acl/CIM 一类 cmdlet 因此加载错模块而失败；
 * 去掉后 Windows PowerShell 用自己的缺省值。Get-Item/Get-CimInstance 等不受影响。
 */
function childEnv(env = process.env) {
  const clean = { ...env };
  delete clean.PSModulePath;
  return clean;
}

const runPowerShell = (script, { execFileFn = execFile, timeoutMs = PROBE_TIMEOUT_MS } = {}) => new Promise((resolve) => {
  try {
    execFileFn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, env: childEnv() },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        resolve(String(stdout ?? ""));
      },
    );
  } catch {
    resolve(null);
  }
});

/**
 * 操作系统的进程创建时间（epoch ms）；任何失败给 null（调用方映射 unknown，不猜）。
 *
 * @param {number} pid
 * @param {object} [deps] — { execFileFn, timeoutMs }
 * @returns {Promise<number|null>}
 */
export async function readProcessCreatedAt(pid, deps = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const out = await runPowerShell(
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().ToString('o')`,
    deps,
  );
  if (out === null) return null;
  const parsed = Date.parse(out.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 占住 127.0.0.1:<port> 监听的 pid 集合；探测失败给 null。
 *
 * @param {number} port — 1..65535
 * @param {object} [deps] — { execFileFn, timeoutMs }
 * @returns {Promise<number[]|null>}
 */
export async function listenerPidsOfPort(port, deps = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const out = await runPowerShell(
    "$c=@(Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort "
    + `${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess);`
    + "'wao-port:' + ((@($c | ForEach-Object { [uint32]$_ })) -join ' ')",
    deps,
  );
  if (out === null) return null;
  const m = /^wao-port:([0-9 ]*)$/m.exec(out.trim());
  if (m === null) return null;
  const text = m[1].trim();
  if (text.length === 0) return [];
  const pids = text.split(/\s+/).map(Number);
  return pids.every((p) => Number.isInteger(p) && p > 0) ? pids : null;
}

/**
 * 复用检查的进程身份：三值闭集 same | gone | unknown。
 *   gone  — signal-0 查无此 pid，或创建时间读得出但与记录不相等（pid 被复用）；
 *   same  — 活着且创建时间与记录严格相等；
 *   unknown — 活着但创建时间读不出（宁可不复用也不猜）。
 *
 * @param {number} pid
 * @param {number} processCreatedAt — instance.json 记录的创建时间（epoch ms）
 * @param {object} [deps] — { isAliveFn, readCreatedAtFn, execFileFn }
 * @returns {Promise<"same"|"gone"|"unknown">}
 */
export async function probeProcessIdentity(pid, processCreatedAt, deps = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  if (typeof processCreatedAt !== "number" || !Number.isFinite(processCreatedAt)) return "unknown";
  const isAliveFn = typeof deps.isAliveFn === "function" ? deps.isAliveFn : isPidAlive;
  let alive;
  try {
    alive = isAliveFn(pid);
  } catch {
    return "unknown";
  }
  if (alive !== true && alive !== false) return "unknown";
  if (!alive) return "gone";
  const readCreatedAtFn = typeof deps.readCreatedAtFn === "function"
    ? deps.readCreatedAtFn
    : (p) => readProcessCreatedAt(p, deps);
  let createdAt;
  try {
    createdAt = await readCreatedAtFn(pid);
  } catch {
    return "unknown";
  }
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return "unknown";
  return createdAt === processCreatedAt ? "same" : "gone";
}
