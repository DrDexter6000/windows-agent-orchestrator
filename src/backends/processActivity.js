// src/backends/processActivity.js
//
// 停滞门取证用的两项本机读数（决定 0067，Owner 2026-10-12："没有任何生命体征才由
// 控制面收口；输出交付物、进程活跃度/变化都算生命体征"）：
//
//   1. 进程树活跃度（Windows）：某个宿主进程的**后代进程**在一段时间窗内有没有
//      在干活——CPU 时间有没有涨、I/O 字节有没有涨、有没有进程新生或退出。
//   2. 工作树变化：运行的工作目录里，已改动/未跟踪文件的集合与其 mtime、大小
//      在窗内有没有变。
//
// 真实转录普查：109 次经 app-server 驱动的运行里 12 次被停滞门收掉，其中 7 次死时
// 有工具调用在途（`npm test`、等后台任务输出等）——那段时间模型不出 token、快照
// 不长 part，还在动的只有工具的子进程和它写出的文件。
//
// 进程项只看后代、不看宿主进程自身：控制面每拍都在经 stdio 向宿主进程要快照，
// 宿主进程自己的 I/O 计数因此恒涨，不能作证。长时间在跑的东西（shell 命令、测试、
// 构建、后台任务）都是它的子孙。
//
// 诚实边界：
//   - 父子关系取自 Win32_Process.ParentProcessId。父进程退出后子进程仍带着旧父
//     pid：祖先链断了的活跃后代看不到；旧父 pid 被系统复用时树的归属可能错判
//     ——未做创建时间校验。两次取样之间出生又退出的短命进程也看不到。
//   - 后代读数是全体求和：与任务无关的插件进程持续耗 CPU / I/O、反复崩溃重启
//     的 helper，都会被读成"有活动"。
//   - 取不到分两种：不适用（非 Windows、pid 非法）返回 null——调用方当作"没有
//     这项证词"，不当作"有活动"；快照命令失败、超时或结果里找不到宿主进程（它
//     明明在跑）则抛错——那是瞬时故障，调用方应重取，不该据此下结论。
//   - 工作树项只看 git 认得的已改动/未跟踪文件（被 .gitignore 排除的写入看不
//     到）；非 git 目录或 git 不可用时返回 null。
//   - 阈值来自 2026-10-12 的一次真机探针（读数见决定 0067），不是长期统计。
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
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

function runFile(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      windowsHide: true,
      timeout: SNAPSHOT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

function defaultRun(command) {
  const shell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return runFile(shell, ["-NoProfile", "-NonInteractive", "-Command", command]);
}

/**
 * 取一次某宿主进程后代的快照。
 * @returns {Promise<Map<number, {cpu100ns: number, ioBytes: number}>|null>} 不适用 → null
 * @throws 快照命令失败/超时，或结果里找不到宿主进程（瞬时故障，可重取）
 */
export async function snapshotDescendants(rootPid, { run = defaultRun, platform = process.platform } = {}) {
  if (platform !== "win32" || !Number.isInteger(rootPid) || rootPid <= 0) return null;
  const found = descendantsOf(parseProcessTable(await run(SNAPSHOT_COMMAND)), rootPid);
  if (found === null) throw new Error("host process not found in the process table");
  return found;
}

// 活跃判据（任一成立即算有活动）。探针里空闲后代 CPU 0-2.5 ms/s、I/O 4.2-8.7 KB/s，
// 忙循环 CPU ≈990 ms/s——阈值取在空闲读数的数倍之上。
export const PROCESS_ACTIVE_CPU_MS_PER_S = 20;
export const PROCESS_ACTIVE_IO_BYTES_PER_S = 65536;

/**
 * 两次快照之间后代进程的活动量。同一 pid 的累计读数回退 = 该 pid 已换了进程
 * （原进程退出、pid 被复用）——计一次退出加一次新生。
 * @returns {{active: boolean, cpuMs: number, ioBytes: number, born: number, exited: number, windowMs: number}}
 */
export function describeProcessActivity(before, after, windowMs) {
  let cpu100ns = 0;
  let ioBytes = 0;
  let born = 0;
  let exited = 0;
  for (const [pid, row] of after) {
    const prior = before.get(pid);
    const replaced = prior !== undefined && (row.cpu100ns < prior.cpu100ns || row.ioBytes < prior.ioBytes);
    if (prior === undefined || replaced) born += 1;
    if (replaced) exited += 1;
    const base = prior === undefined || replaced ? { cpu100ns: 0, ioBytes: 0 } : prior;
    cpu100ns += row.cpu100ns - base.cpu100ns;
    ioBytes += row.ioBytes - base.ioBytes;
  }
  for (const pid of before.keys()) if (!after.has(pid)) exited += 1;
  const cpuMs = cpu100ns / 10_000;
  const seconds = Math.max(windowMs, 1) / 1000;
  const active = born + exited > 0
    || cpuMs / seconds >= PROCESS_ACTIVE_CPU_MS_PER_S
    || ioBytes / seconds >= PROCESS_ACTIVE_IO_BYTES_PER_S;
  return { active, cpuMs: Math.round(cpuMs), ioBytes, born, exited, windowMs: Math.round(windowMs) };
}

// 逐文件取 mtime/大小的上限：超出部分只以文件名清单参与指纹。
const WORKING_TREE_STAT_LIMIT = 5000;

function defaultListChanged(cwd) {
  return runFile("git", ["-C", cwd, "ls-files", "-m", "-o", "--exclude-standard", "-z"]);
}

/**
 * 工作树变化指纹：已改动 + 未跟踪（未被忽略）文件的清单，连同各自的 mtime 与
 * 大小。两次指纹不同 = 窗内有文件被写、新建或删除。
 * @returns {Promise<string|null>} 非 git 目录 / git 不可用 → null（没有这项证词）
 */
export async function fingerprintWorkingTree(cwd, { listChanged = defaultListChanged, statFile = stat } = {}) {
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  let listing;
  try {
    listing = String(await listChanged(cwd));
  } catch {
    return null;
  }
  const hash = createHash("sha256").update(listing);
  for (const rel of listing.split("\0").filter(Boolean).slice(0, WORKING_TREE_STAT_LIMIT)) {
    try {
      const info = await statFile(join(cwd, rel));
      hash.update(`${rel}\0${info.mtimeMs}\0${info.size}\0`);
    } catch {
      hash.update(`${rel}\0gone\0`);
    }
  }
  return hash.digest("hex");
}

// ── 静默期取样器（决定 0070）────────────────────────────────────────────────
//
// 只供观察：进程式后端没有"等不到进展"的收口门，但长工具调用 / 长思考期间转录
// 是空的，Lead 下钻看不到"进程在干活"。转录静默满 quietMs 之后取一次基线（后代
// 进程快照 + 工作树指纹），windowMs 后再取一次比对，读到体征就返回对应的
// runtime status；然后从头再等 quietMs。任何一步取不到都只是这一轮不出事实——
// 取样器绝不影响运行的去留。
export const QUIET_SAMPLE_AFTER_MS = 5 * 60_000;
export const QUIET_SAMPLE_WINDOW_MS = 30_000;

/**
 * @param {object} opts
 * @param {number} opts.rootPid — worker 运行时进程（只看它的后代）
 * @param {string} opts.cwd — worker 的工作目录
 * @param {(pid: number) => Promise<Map|null>} opts.processProbe — 不适用返回 null，失败可抛
 * @param {(cwd: string) => Promise<string|null>} opts.deliverableProbe — 不适用返回 null
 * @param {() => number} opts.now — 单调钟（ms）
 * @returns {{ noteEvent(): void, nextWakeMs(): number, poll(): Promise<string[]> }}
 */
export function createQuietSampler({
  rootPid, cwd, processProbe, deliverableProbe, now,
  quietMs = QUIET_SAMPLE_AFTER_MS, windowMs = QUIET_SAMPLE_WINDOW_MS,
}) {
  let quietSince = now();
  let baseline = null;
  const probe = async (fn, arg) => {
    try { return await fn(arg); } catch { return null; }
  };
  return {
    // worker 落了事件：静默重新起算，丢掉取到一半的基线。
    noteEvent() {
      quietSince = now();
      baseline = null;
    },
    // 距下一次需要醒来还有多久。
    nextWakeMs() {
      const due = baseline === null ? quietSince + quietMs : baseline.at + windowMs;
      return Math.max(0, due - now());
    },
    // 到点才取样；返回这次读到的体征（闭集 runtime status，常为空数组）。
    async poll() {
      if (baseline === null) {
        if (now() - quietSince < quietMs) return [];
        const tree = await probe(processProbe, rootPid);
        const files = await probe(deliverableProbe, cwd);
        if (tree === null && files === null) {
          quietSince = now();
          return [];
        }
        baseline = { at: now(), tree, files };
        return [];
      }
      if (now() - baseline.at < windowMs) return [];
      const signs = [];
      if (baseline.tree !== null) {
        const tree = await probe(processProbe, rootPid);
        if (tree !== null && describeProcessActivity(baseline.tree, tree, now() - baseline.at).active) {
          signs.push("process_active");
        }
      }
      if (baseline.files !== null) {
        const files = await probe(deliverableProbe, cwd);
        if (files !== null && files !== baseline.files) signs.push("files_changed");
      }
      baseline = null;
      quietSince = now();
      return signs;
    },
  };
}
