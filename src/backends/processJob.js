// src/backends/processJob.js
//
// 只观测的作业对象（决定 0121）：zcode 停滞门的进程式证据在 MSYS 断链后失明——
// zcode 跑 `#!/usr/bin/env bash` 脚本（npm/npx 皆此形状）时，bash fork 的子进程
// exec env、env 再 exec bash 后自己退出（几毫秒），新 bash 的父 pid 指向已退出的
// 进程，ParentProcessId 走树挂不上整条链（实测 2026-11-09，第 94 批；复现见
// processActivity.js 文件头）。作业对象补这一跳：进程加入作业是创建时继承的，
// 父进程中途退出不影响；作业累计的 CPU / I/O / 进程总数（含只活几毫秒的进程）
// 都能读到。
//
// 严格边界（Owner 批准的决定 0121；决定 0013 的"不实现自定义 Job Object"针对
// 进程隔离/击杀，本模块不碰）：
//   - **WAO 不主动击杀**：不设 kill-on-close、不调用 SetInformationJobObject、
//     不调用 TerminateJobObject——控制面绝不经这个作业主动结束任何进程。但作业
//     对进程的生死**并非零影响**（opus 会审实测，如实陈述）：runner 不带
//     detached 起 app-server 时，app-server 在 runner 的 libuv 作业里
//     （KILL_ON_JOB_CLOSE + SILENT_BREAKAWAY_OK）——以前 app-server 之后起的
//     子孙会静默脱离那个作业；挂上本模块这个不许脱离的内层作业后，子孙不再
//     脱离任何一层，也留在 runner 的 libuv 作业里，runner 退出时随之结束
//     （实测：不挂作业，detached 叶子与经 Git Bash 起的叶子在 runner 退出后
//     仍活；挂作业，都没了）。加入作业前已起的进程不受影响。Owner 接受这个
//     效果——它把 taskkill /T 漏掉的 MSYS 孤儿也收了，与决定 0013 的"进程死即
//     会话死"同向（真进程钉：test/backends/processJobMsys.test.js 的 runner
//     退出用例）。
//   - **不设任何脱离标志**：不设 JOB_OBJECT_LIMIT_BREAKAWAY_OK /
//     JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK——MSYS 建进程前查当前作业，允许脱离
//     就会主动加 CREATE_BREAKAWAY_FROM_JOB 让被找的进程再逃出去（会审实测）；
//     libuv 起 detached 子进程不加该标志（Node 22 源码与实测一致）；
//   - 名字的存活靠句柄：建好后用 DuplicateHandle 把作业句柄复制进 app-server
//     本身——建作业的 PowerShell 退出后仍能按名打开（会审实测）；app-server
//     退出后名字随之消失，残句柄由 OS 回收，无清理义务。
//
// 实现零第三方依赖：powershell.exe 一次性脚本 + Add-Type P/Invoke（与
// processActivity.js 的取样通道同一纪律）。

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

// 有界：一次性脚本（含 csc 编译 Add-Type）缺省 15 秒，超时结束 PowerShell。
const DEFAULT_ATTACH_TIMEOUT_MS = 15_000;
const ATTACH_MAX_BUFFER = 1024 * 1024;

// 哨兵步骤闭集（脚本里每个 API 查返回值，失败落对应步骤 + Win32 错误号；
// spawn_failed / timeout / no_sentinel 是脚本之外的失败形状）。
const SENTINEL_FAIL_STEPS = Object.freeze(["create", "open_process", "assign", "duplicate"]);

// OpenProcess 访问权：PROCESS_TERMINATE(0x1) | PROCESS_DUP_HANDLE(0x40) |
// PROCESS_SET_QUOTA(0x100) = 0x141——AssignProcessToJobObject 要求 SET_QUOTA 与
// TERMINATE 两位（会审实测：去掉 TERMINATE 后 Assign 失败，Win32 错误 5），
// DuplicateHandle 要 DUP_HANDLE。TERMINATE 位只为满足 Assign 的要求；本模块
// 自己绝不用它击杀任何进程。
const OPEN_PROCESS_ACCESS = 0x141;
// DuplicateHandle 给 app-server 的作业句柄访问权：JOB_OBJECT_QUERY(0x4)——
// 只观测够用；持有句柄本身（不论访问权）即保住作业名字的存活。
const JOB_HANDLE_ACCESS = 0x4;

function powershellPath() {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * attach 的一次性 PowerShell 脚本（模块私有；测试经注入 run 捕获脚本文本断言
 * 红线）。步骤与哨兵一一对应，每个 API 查返回值。
 */
function buildAttachScript(hostPid, jobName) {
  const source = "using System; using System.Runtime.InteropServices; "
    + "public static class WaoJobAttach { "
    + "[DllImport(\"kernel32.dll\", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName); "
    + "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId); "
    + "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess); "
    + "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool DuplicateHandle(IntPtr hSourceProcessHandle, IntPtr hSourceHandle, IntPtr hTargetProcessHandle, out IntPtr lpTargetHandle, uint dwDesiredAccess, bool bInheritHandle, uint dwOptions); "
    + "[DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool CloseHandle(IntPtr hObject); "
    + "[DllImport(\"kernel32.dll\")] public static extern IntPtr GetCurrentProcess(); }";
  return "$ErrorActionPreference = 'Stop'\n"
    + `Add-Type -TypeDefinition '${source}'\n`
    + "$name = '" + jobName + "'\n"
    + "$job = [WaoJobAttach]::CreateJobObjectW([IntPtr]::Zero, $name)\n"
    + "if ($job -eq [IntPtr]::Zero) {\n"
    + "  'wao-job:fail:create:' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()\n"
    + "} else {\n"
    + `  $proc = [WaoJobAttach]::OpenProcess(${OPEN_PROCESS_ACCESS}, $false, ${hostPid})\n`
    + "  if ($proc -eq [IntPtr]::Zero) {\n"
    + "    'wao-job:fail:open_process:' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()\n"
    + "    [void][WaoJobAttach]::CloseHandle($job)\n"
    + "  } elseif (-not [WaoJobAttach]::AssignProcessToJobObject($job, $proc)) {\n"
    + "    'wao-job:fail:assign:' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()\n"
    + "    [void][WaoJobAttach]::CloseHandle($proc)\n"
    + "    [void][WaoJobAttach]::CloseHandle($job)\n"
    + "  } else {\n"
    + "    $dup = [IntPtr]::Zero\n"
    + `    if (-not [WaoJobAttach]::DuplicateHandle([WaoJobAttach]::GetCurrentProcess(), $job, $proc, [ref]$dup, ${JOB_HANDLE_ACCESS}, $false, 0)) {\n`
    + "      'wao-job:fail:duplicate:' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()\n"
    + "      [void][WaoJobAttach]::CloseHandle($proc)\n"
    + "      [void][WaoJobAttach]::CloseHandle($job)\n"
    + "    } else {\n"
    + "      [void][WaoJobAttach]::CloseHandle($proc)\n"
    + "      [void][WaoJobAttach]::CloseHandle($job)\n"
    + "      'wao-job:ok:' + $name\n"
    + "    }\n"
    + "  }\n"
    + "}\n"
    // 关自己的句柄只作整洁：进程退出时 OS 一律回收；复制进 app-server 的那份
    // （$dup）属于 app-server 的句柄表，绝不能在本进程里 CloseHandle（值碰巧撞上
    // 本进程的其它句柄会误关）。保名字存活靠 app-server 那一份。
    + "# duplicate lives in the target process; never close it here";
}

// PowerShell -EncodedCommand 吃 UTF-16LE 的 base64。
function encodeCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

// 缺省执行器：有界；超时/被杀 → 带 timedOut 标记的拒绝（注入的 run 模拟超时
// 用同一标记拒绝即可）。其余拒绝（起不来等）原样上抛，由 attachProcessJob 归为
// spawn_failed。
function runAttachScript(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(powershellPath(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodeCommand(script)], {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: ATTACH_MAX_BUFFER,
    }, (error, stdout) => {
      if (error) {
        // killed 只来自 timeout（输出恒一行，maxBuffer 触不到）
        reject(Object.assign(new Error(`powershell attach script failed: ${error.message}`), {
          timedOut: error.killed === true,
        }));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * 解析哨兵行（纯函数）。成功 `wao-job:ok:<name>`；失败
 * `wao-job:fail:<step>:<win32>`；出现 wao-job: 前缀但形状不合法、或全文无哨兵
 * → code "no_sentinel"。
 */
export function parseAttachSentinel(text) {
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("wao-job:")) continue;
    const rest = trimmed.slice("wao-job:".length);
    if (rest.startsWith("ok:")) {
      const name = rest.slice("ok:".length);
      return { ok: true, name };
    }
    if (rest.startsWith("fail:")) {
      const cells = rest.slice("fail:".length).split(":");
      if (cells.length === 2 && SENTINEL_FAIL_STEPS.includes(cells[0]) && /^\d+$/.test(cells[1])) {
        return { ok: false, code: cells[0], win32: Number(cells[1]) };
      }
      return { ok: false, code: "no_sentinel", win32: null };
    }
    return { ok: false, code: "no_sentinel", win32: null };
  }
  return { ok: false, code: "no_sentinel", win32: null };
}

/**
 * 给已在跑的宿主进程挂一个只观测的嵌套作业（决定 0121；合同见文件头）。
 *
 * @param {number} hostPid — app-server 进程（已在 libuv 作业里，嵌套作业合法）
 * @param {object} [opts]
 * @param {(script: string) => Promise<string>} [opts.run] — 执行器注入缝：收脚本
 *   全文、回 stdout；模拟超时用 `timedOut: true` 的错误拒绝
 * @param {string} [opts.platform] — 非 win32 → 不适用
 * @param {number} [opts.timeoutMs] — 缺省 15 秒
 * @returns {Promise<{ok:true, name:string} | {ok:false, code:string, win32:number|null} | null>}
 *   null = 不适用（非 Windows / pid 非法）；code 闭集 =
 *   create|open_process|assign|duplicate|spawn_failed|timeout|no_sentinel
 */
export async function attachProcessJob(hostPid, { run, platform = process.platform, timeoutMs = DEFAULT_ATTACH_TIMEOUT_MS } = {}) {
  if (platform !== "win32" || !Number.isInteger(hostPid) || hostPid <= 0) return null;
  const name = `Local\\wao-job-${hostPid}-${randomBytes(16).toString("hex")}`;
  const script = buildAttachScript(hostPid, name);
  const runner = run ?? ((text) => runAttachScript(text, timeoutMs));
  let stdout;
  try {
    stdout = await runner(script);
  } catch (error) {
    return { ok: false, code: error?.timedOut === true ? "timeout" : "spawn_failed", win32: null };
  }
  const parsed = parseAttachSentinel(stdout);
  if (parsed.ok === true && parsed.name !== name) {
    // 哨兵回的名字不是本次请求的名字——不可信，按无有效哨兵处理
    return { ok: false, code: "no_sentinel", win32: null };
  }
  return parsed;
}
