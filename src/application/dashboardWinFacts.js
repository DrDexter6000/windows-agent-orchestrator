// src/application/dashboardWinFacts.js
//
// 第 145b 批（决定 0131 第 2 条）：复用检查要的三个 Windows 事实，全部走结构化
// PowerShell（哨兵输出，不解析本地化文本）：
//   - readProcessCreatedAt(pid) — 操作系统的进程创建时间（Win32_Process.CreationDate，
//     DMTF → DateTime → 'o' → epoch ms）。同一活进程两次读取给出同一个值，所以
//     复用检查用严格相等比对 instance.json 里的 processCreatedAt——不是容差近似。
//   - listenerPidsOfPort(port) — TCP 监听表（Get-NetTCPConnection -State Listen，
//     127.0.0.1）里占住这个端口的 pid 集合；探测失败给 null（读作“查不出”，不猜）。
//     145b 修正一 #7 / 修正二 #6：只有“查无结果”（错误编号 CmdletizationQuery_NotFound，
//     不是 ObjectNotFound 类别——命令找不到、模块加载失败也在那个类别里）才是真的空表 []；
//     其余错误是 null——“查询报错”绝不能被读成“没人监听”。
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
 * 监听探测的 PowerShell 外壳（导出给测试：把 body 换成一个“必定报错”的查询，就能在
 * 真实 Windows PowerShell 上验证 catch 的两条分支）。
 *
 * 145b 修正一 #7：旧脚本用 `-ErrorAction SilentlyContinue`，查询报错（权限、CIM 故障）
 * 也退出 0 并输出空哨兵，JS 读成 []，控制器就把“查不出”当成“端口没人监听”。
 * 修正二 #6：现在只有 FullyQualifiedErrorId 以 CmdletizationQuery_NotFound 开头（Get-NetTCPConnection
 * 查无结果）才输出空表；其余错误（含“命令找不到”“模块加载失败”这类同属 ObjectNotFound
 * 类别的）输出 wao-port-error（解析不出 → null）。
 *
 * @param {string} body — 成功时输出 `wao-port:<pid...>` 的 PowerShell 片段
 * @returns {string}
 */
export function buildPortProbeScript(body) {
  return "$ErrorActionPreference='Stop';"
    + "try {"
    + body
    + "} catch {"
    // 只有“查询确实没有结果”才是空表（Get-NetTCPConnection 查无结果的固定错误编号
    // CmdletizationQuery_NotFound）；任何别的错误都保留为 unknown。不能按 ObjectNotFound
    // 类别判：“命令找不到”“模块加载失败”也归在这个类别里。
    + "if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') { 'wao-port:' }"
    + "else { 'wao-port-error:' }"
    + "}";
}

/**
 * 解析监听探测输出：空表 []、pid 列表、或 null（出错/形状不符）。导出给测试。
 *
 * @param {string} stdout
 * @returns {number[]|null}
 */
export function parsePortProbeOutput(stdout) {
  if (typeof stdout !== "string") return null;
  const m = /^wao-port:([0-9 ]*)$/m.exec(stdout.trim());
  if (m === null) return null;
  const text = m[1].trim();
  if (text.length === 0) return [];
  const pids = text.split(/\s+/).map(Number);
  return pids.every((p) => Number.isInteger(p) && p > 0) ? pids : null;
}

/**
 * 占住 127.0.0.1:<port> 监听的 pid 集合；探测失败给 null（绝不当成空表）。
 *
 * @param {number} port — 1..65535
 * @param {object} [deps] — { execFileFn, timeoutMs }
 * @returns {Promise<number[]|null>}
 */
export async function listenerPidsOfPort(port, deps = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const out = await runPowerShell(
    buildPortProbeScript(
      "$c=@(Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort "
      + `${port} | Select-Object -ExpandProperty OwningProcess);`
      + "'wao-port:' + ((@($c | ForEach-Object { [uint32]$_ })) -join ' ')",
    ),
    deps,
  );
  return out === null ? null : parsePortProbeOutput(out);
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
