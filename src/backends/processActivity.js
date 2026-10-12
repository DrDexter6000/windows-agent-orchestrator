// src/backends/processActivity.js
//
// 进程树活跃度（Windows）：某个宿主进程的**后代进程**在一段时间窗内有没有在
// 干活——CPU 时间有没有涨、I/O 字节有没有涨、有没有进程新生或退出。
//
// 来由（决定 0067，Owner 2026-10-12）："没有任何生命体征才由控制面收口；进程
// 活跃度/变化也算生命体征"。真实转录普查：109 次经 app-server 驱动的运行里 12 次
// 被停滞门收掉，其中 7 次死时有工具调用在途（`npm test`、等后台任务输出等）——
// 那段时间模型不出 token、快照不长 part，唯一还在动的是工具的子进程。
//
// 只看后代、不看宿主进程自身：控制面每拍都在经 stdio 向宿主进程要快照，宿主
// 进程自己的 I/O 计数因此恒涨，不能作证。长时间在跑的东西（shell 命令、测试、
// 构建、后台任务）都是它的子孙。
//
// 诚实边界：
//   - 父子关系取自 Win32_Process.ParentProcessId。父进程退出后子进程仍带着旧
//     父 pid，该 pid 被系统复用时树的归属可能错判——未做创建时间校验。
//   - 取不到分两种：不适用（非 Windows、pid 非法、宿主进程不在表里）返回 null
//     ——调用方当作"没有这项证词"，不当作"有活动"；快照命令失败或超时则抛错
//     ——那是瞬时故障，调用方应重取，不该据此下结论。
//   - 阈值来自 2026-10-12 的一次真机探针（读数见决定 0067），不是长期统计。
import { execFile } from "node:child_process";
import { join } from "node:path";

const SNAPSHOT_TIMEOUT_MS = 10_000;

// 每行：pid,ppid,CPU 时间(100ns),I/O 字节(读+写+其他)
const SNAPSHOT_COMMAND = "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,KernelModeTime,UserModeTime,ReadTransferCount,WriteTransferCount,OtherTransferCount | "
  + "ForEach-Object { '{0},{1},{2},{3}' -f $_.ProcessId,$_.ParentProcessId,($_.KernelModeTime+$_.UserModeTime),($_.ReadTransferCount+$_.WriteTransferCount+$_.OtherTransferCount) }";

/** 解析快照文本 → Map<pid, {ppid, cpu100ns, ioBytes}>（纯函数；坏行跳过）。 */
export function parseProcessTable(text) {
  const table = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const cells = line.trim().split(",");
    if (cells.length !== 4) continue;
    const [pid, ppid, cpu100ns, ioBytes] = cells.map(Number);
    if (![pid, ppid, cpu100ns, ioBytes].every((n) => Number.isFinite(n) && n >= 0)) continue;
    table.set(pid, { ppid, cpu100ns, ioBytes });
  }
  return table;
}

/**
 * 某宿主进程的全部后代（不含宿主自身）的逐进程读数。
 * @returns {Map<number, {cpu100ns: number, ioBytes: number}>|null} 宿主不在表里 → null
 */
export function descendantsOf(table, rootPid) {
  if (!table.has(rootPid)) return null;
  const children = new Map();
  for (const [pid, row] of table) {
    if (pid === row.ppid) continue;
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(pid);
  }
  const found = new Map();
  const queue = [...(children.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === rootPid || found.has(pid)) continue;
    const row = table.get(pid);
    found.set(pid, { cpu100ns: row.cpu100ns, ioBytes: row.ioBytes });
    queue.push(...(children.get(pid) ?? []));
  }
  return found;
}

function defaultRun(command) {
  const shell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve, reject) => {
    execFile(shell, ["-NoProfile", "-NonInteractive", "-Command", command], {
      windowsHide: true,
      timeout: SNAPSHOT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

/**
 * 取一次某宿主进程后代的快照。
 * @returns {Promise<Map<number, {cpu100ns: number, ioBytes: number}>|null>} 不适用 → null
 * @throws 快照命令失败或超时（瞬时故障，可重取）
 */
export async function snapshotDescendants(rootPid, { run = defaultRun, platform = process.platform } = {}) {
  if (platform !== "win32" || !Number.isInteger(rootPid) || rootPid <= 0) return null;
  return descendantsOf(parseProcessTable(await run(SNAPSHOT_COMMAND)), rootPid);
}

// 活跃判据（任一成立即算有活动）。探针里空闲后代 CPU 0-2.5 ms/s、I/O 4.2-8.7 KB/s，
// 忙循环 CPU ≈990 ms/s——阈值取在空闲读数的数倍之上。
export const PROCESS_ACTIVE_CPU_MS_PER_S = 20;
export const PROCESS_ACTIVE_IO_BYTES_PER_S = 65536;

/**
 * 两次快照之间后代进程的活动量。
 * @returns {{active: boolean, cpuMs: number, ioBytes: number, born: number, exited: number, windowMs: number}}
 */
export function describeProcessActivity(before, after, windowMs) {
  let cpu100ns = 0;
  let ioBytes = 0;
  let born = 0;
  for (const [pid, row] of after) {
    const prior = before.get(pid);
    if (!prior) born += 1;
    cpu100ns += Math.max(0, row.cpu100ns - (prior?.cpu100ns ?? 0));
    ioBytes += Math.max(0, row.ioBytes - (prior?.ioBytes ?? 0));
  }
  let exited = 0;
  for (const pid of before.keys()) if (!after.has(pid)) exited += 1;
  const cpuMs = cpu100ns / 10_000;
  const seconds = Math.max(windowMs, 1) / 1000;
  const active = born + exited > 0
    || cpuMs / seconds >= PROCESS_ACTIVE_CPU_MS_PER_S
    || ioBytes / seconds >= PROCESS_ACTIVE_IO_BYTES_PER_S;
  return { active, cpuMs: Math.round(cpuMs), ioBytes, born, exited, windowMs: Math.round(windowMs) };
}
