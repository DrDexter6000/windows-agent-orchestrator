// test/run-lifecycle/runnerLaunchJob.test.js
//
// TD-347（第 93 批）核心证明：宿主作业（只有 KILL_ON_JOB_CLOSE）关闭时——
//   - 作业里的"服务"进程死；
//   - 服务直接 detached spawn 的对照子进程死（旧行为：runner 曾这样被连坐）；
//   - 服务经启动模块（WMI 路径：PowerShell → Win32_Process.Create → src/runnerBroker.js）
//     起的假 runner **心跳继续推进**，其孙进程**活着**。
//
// 不经 MCP。步骤：测试用 PowerShell P/Invoke 建一个 LimitFlags=0x2000 的作业 →
// 以挂起方式创建小"服务"进程并加入作业（避免它在加入前起子进程）→ 恢复执行 →
// 服务写 ready 文件（含 launch 结果与各 pid）→ PS 关闭作业最后一个句柄 → 轮询
// 服务退出 → 哨兵回传。node 侧断言：服务/对照死、runner 心跳推进、孙进程活；
// finally 按记录 pid 结束全部实验进程并确认无残留。
//
// 本机 WMI 建进程被拒（如沙箱）时按任务书 t.skip 并写明前置条件不成立。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const IS_WINDOWS = process.platform === "win32";

function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const r = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  return r.status === 0;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

async function waitUntil(fn, timeoutMs, stepMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => { setTimeout(r, stepMs); });
  }
  return fn();
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// 服务进程（在作业里）：起对照子进程 + 经启动模块（WMI 路径）起假 runner，
// 写 ready 文件后保持存活，等作业关闭来杀。
const SERVICE_SCRIPT = (repoRoot) => `
delete process.env.WAO_RUNNER_LAUNCH; // 本测试要的就是 WMI 缺省路径
const { spawn } = await import("node:child_process");
const { appendFileSync, writeFileSync } = await import("node:fs");
const { launchRunner } = await import(${JSON.stringify(pathToFileURL(join(repoRoot, "src", "application", "runnerLaunch.js")).href)});
const [readyFile, heartFile, grandHeartFile, runnerScript, stderrPath, runId, nodeExe] = process.argv.slice(2);
// 服务自己的心跳（作业关闭前活着的证据）。
const serviceHeart = heartFile + ".service";
const beat = () => { try { appendFileSync(serviceHeart, "."); } catch { /* 忽略 */ } };
beat();
setInterval(beat, 200);
// 1) 对照组：本进程直接 detached spawn 的子进程——旧行为，应随作业死。
const control = spawn(nodeExe, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore", windowsHide: true });
control.unref();
// 2) 经启动模块起假 runner（Windows 缺省 = WMI 启动桥）——应活过作业关闭。
let launch;
try {
  launch = await launchRunner({
    execPath: nodeExe,
    args: [runnerScript, heartFile, grandHeartFile, "--run-id", runId],
    env: { ...process.env, WAO_JOB_TEST_UNIQUE: "job-unicorn-42" },
    cwd: process.cwd(),
    prompt: "job-test-prompt",
    stderrPath,
    runId,
    timeoutMs: 30000,
  });
} catch (e) {
  launch = { outcome: "start_failed", reason: "threw", detail: String(e && e.message) };
}
writeFileSync(readyFile, JSON.stringify({
  launch: { outcome: launch.outcome, reason: launch.reason ?? null, detail: launch.detail ?? null, runnerPid: launch.runnerPid ?? null },
  controlPid: control.pid,
  servicePid: process.pid,
}), "utf8");
// 保持存活，直到作业关闭把我们杀掉。
setInterval(() => {}, 60000);
`;

// 假 runner（WMI 桥起的，作业外）：读 stdin 提示词，每 200ms 心跳一次，再起一个
// 孙进程同样心跳。首行 JSON 带 grandPid 与 promptLen。
const RUNNER_SCRIPT = `
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
const [heartFile, grandHeartFile] = process.argv.slice(2);
let prompt = "";
for await (const c of process.stdin) prompt += c;
const grand = spawn(process.execPath, ["-e",
  'const fs=require("fs");const f=' + JSON.stringify(grandHeartFile) + ';let n=0;setInterval(()=>{try{fs.appendFileSync(f,"g"+(++n)+"\\\\n")}catch{}},200);setInterval(()=>{},1<<30);'],
  { stdio: "ignore", windowsHide: true });
appendFileSync(heartFile, JSON.stringify({ grandPid: grand.pid, promptLen: prompt.length, unique: process.env.WAO_JOB_TEST_UNIQUE ?? null }) + "\\n");
let n = 0;
setInterval(() => { try { appendFileSync(heartFile, "h" + (++n) + "\\n"); } catch { /* 忽略 */ } }, 200);
setInterval(() => {}, 1 << 30);
`;

// P/Invoke：建作业（仅 KILL_ON_JOB_CLOSE）、挂起创建服务、加入作业、恢复执行、
// 等 ready、关最后一个作业句柄、等服务死。
// 结构体封送全部收在 C# 里（PowerShell 直接传 ref/out 结构体不可靠——实测
// CreateProcessW 报 123/3）；C# 侧把 null/空 cwd 归一为真 null（PS 的 $null 传给
// string 参数会封送成空串，CreateProcessW 报 ERROR_INVALID_NAME）。
const PS_JOB_SOURCE = `
$ErrorActionPreference='Stop'
$svcCmd=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__SVC_CMD__'))
$svcDir=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__SVC_DIR__'))
$readyFile=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__READY__'))
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WaoJob {
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit;
    public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct STARTUPINFOW { public int cb; public IntPtr lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inh, uint flags, IntPtr env, string cwd, ref STARTUPINFOW si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int cb);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool CloseHandle(IntPtr h);

  static IntPtr _job = IntPtr.Zero;
  static IntPtr _proc = IntPtr.Zero;
  public static int Pid = 0;

  // 建作业（仅 KILL_ON_JOB_CLOSE=0x2000）→ CREATE_SUSPENDED|CREATE_NO_WINDOW 创建
  // 服务 → 加入作业 → 恢复主线程。返回 "ok" 或 "err:<win32>"。
  public static string Setup(string cmdLine, string cwd) {
    _job = CreateJobObjectW(IntPtr.Zero, null);
    if (_job == IntPtr.Zero) return "err:jobobject:" + Marshal.GetLastWin32Error();
    var li = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    li.BasicLimitInformation.LimitFlags = 0x2000;
    if (!SetInformationJobObject(_job, 9, ref li, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
      return "err:setinfo:" + Marshal.GetLastWin32Error();
    var si = new STARTUPINFOW();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFOW));
    PROCESS_INFORMATION pi;
    if (!CreateProcessW(null, new StringBuilder(cmdLine), IntPtr.Zero, IntPtr.Zero, false,
        0x08000004, IntPtr.Zero, String.IsNullOrEmpty(cwd) ? null : cwd, ref si, out pi))
      return "err:create:" + Marshal.GetLastWin32Error();
    if (!AssignProcessToJobObject(_job, pi.hProcess))
      return "err:assign:" + Marshal.GetLastWin32Error();
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    _proc = pi.hProcess;
    Pid = pi.dwProcessId;
    return "ok";
  }

  // 关闭作业与服务进程句柄——作业最后一个句柄关闭即触发 KILL_ON_JOB_CLOSE。
  public static int CloseAll() {
    int err = 0;
    if (_job != IntPtr.Zero && !CloseHandle(_job)) err = Marshal.GetLastWin32Error();
    if (_proc != IntPtr.Zero && !CloseHandle(_proc) && err == 0) err = Marshal.GetLastWin32Error();
    _job = IntPtr.Zero; _proc = IntPtr.Zero;
    return err;
  }
}
'@
$setup=[WaoJob]::Setup($svcCmd, $svcDir)
if ($setup -ne 'ok') { 'wao-job:setup-' + $setup; exit 1 }
$svcPid=[WaoJob]::Pid
'wao-job:created:' + $svcPid
$deadline=[DateTime]::UtcNow.AddSeconds(35)
while ([DateTime]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath $readyFile)) { Start-Sleep -Milliseconds 200 }
if (-not (Test-Path -LiteralPath $readyFile)) {
  'wao-job:not-ready'
  [WaoJob]::CloseAll() | Out-Null
  exit 1
}
'wao-job:ready'
# 关闭作业的最后一个句柄 → KILL_ON_JOB_CLOSE 生效（与宿主重启 MCP 服务同机制）。
$closeErr=[WaoJob]::CloseAll()
if ($closeErr -ne 0) { 'wao-job:close-failed:' + $closeErr; exit 1 }
$deadline2=[DateTime]::UtcNow.AddSeconds(10)
while ([DateTime]::UtcNow -lt $deadline2) {
  if (-not (Get-Process -Id $svcPid -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 200
}
$alive=[bool](Get-Process -Id $svcPid -ErrorAction SilentlyContinue)
'wao-job:done:' + $alive
`;

test("真作业证明：KILL_ON_JOB_CLOSE 作业关闭 → 服务与直起对照子进程死，WMI 桥起的 runner 心跳推进、孙进程活", { skip: !IS_WINDOWS && "真作业 P/Invoke 仅 Windows" }, async (t) => {
  const t0 = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "wao-job-proof-"));
  const runId = "run_jobproof_1";
  const readyFile = join(dir, "ready.json");
  const heartFile = join(dir, "runner-heart.log");
  const grandHeartFile = join(dir, "grand-heart.log");
  const runnerScript = join(dir, "fake-runner-job.mjs");
  const serviceScript = join(dir, "service.mjs");
  const stderrPath = join(dir, `.runner-${runId}.stderr`);
  writeFileSync(runnerScript, RUNNER_SCRIPT, "utf8");
  writeFileSync(serviceScript, SERVICE_SCRIPT(REPO_ROOT), "utf8");

  // 服务命令行：每个参数都加引号（路径含空格也安全）。
  const q = (s) => `"${s}"`;
  const svcCmd = [process.execPath, serviceScript, readyFile, heartFile, grandHeartFile, runnerScript, stderrPath, runId, process.execPath]
    .map(q).join(" ");
  const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
  const psScript = PS_JOB_SOURCE
    .replace("__SVC_CMD__", b64(svcCmd))
    .replace("__SVC_DIR__", b64(dir))
    .replace("__READY__", b64(readyFile));
  const encoded = Buffer.from(psScript, "utf16le").toString("base64");

  let ready = null;
  let runnerPid = null;
  let controlPid = null;
  let servicePid = null;
  try {
    const ps = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 55000,
    });
    t.diagnostic(`PS orchestrator exit=${ps.status} in ${Date.now() - t0}ms; stdout=${JSON.stringify(String(ps.stdout ?? "").trim().slice(0, 400))}; stderr=${JSON.stringify(String(ps.stderr ?? "").trim().slice(0, 400))}`);
    assert.equal(ps.status, 0, "PowerShell 编排器正常退出");
    assert.ok(existsSync(readyFile), "服务写出了 ready 文件（服务已在作业里跑起来）");

    ready = JSON.parse(readFileSync(readyFile, "utf8"));
    runnerPid = ready.launch.runnerPid;
    controlPid = ready.controlPid;
    servicePid = ready.servicePid;
    t.diagnostic(`ready: launch=${JSON.stringify(ready.launch)} controlPid=${controlPid} servicePid=${servicePid} at +${Date.now() - t0}ms`);

    // 本机 WMI 建进程被拒（如沙箱）→ 前置条件不成立，按任务书 skip 并写明原因。
    if (ready.launch.outcome !== "started" && ready.launch.reason === "wmi_create_failed") {
      killTree(controlPid);
      killTree(servicePid);
      t.skip(`前置条件不成立：本机 WMI 建进程被拒（detail=${ready.launch.detail}），无法证明桥路径`);
      return;
    }
    assert.equal(ready.launch.outcome, "started", `launch reason=${ready.launch.reason} detail=${ready.launch.detail}`);
    assert.ok(Number.isInteger(runnerPid) && runnerPid > 0, "拿到 runner pid");

    // 服务确实活着过（有自己的心跳），PS 哨兵报告它已被作业关闭杀死。
    const serviceHeart = heartFile + ".service";
    assert.ok(existsSync(serviceHeart) && statSync(serviceHeart).size > 0, "服务在作业里活过（心跳存在）");
    assert.ok(String(ps.stdout).includes("wao-job:done:False"), `作业关闭杀死了服务（哨兵=${String(ps.stdout).trim().split("\n").pop()})`);
    assert.ok(!pidAlive(servicePid), "服务进程已死");
    assert.ok(!pidAlive(controlPid), "对照组：服务直接 detached spawn 的子进程被作业连坐（旧行为复现）");
    t.diagnostic(`服务与对照子进程已死 at +${Date.now() - t0}ms`);

    // 假 runner 首行：grandPid + prompt 经 stdin 到达。
    const firstLine = await waitUntil(() => existsSync(heartFile), 10000)
      ? String(readFileSync(heartFile, "utf8")).split("\n", 1)[0]
      : null;
    assert.ok(firstLine, "runner 心跳文件出现");
    const header = JSON.parse(firstLine);
    assert.equal(header.promptLen, "job-test-prompt".length, "prompt 经桥的 stdin 交接到达 runner");
    assert.equal(header.unique, "job-unicorn-42", "env 经桥逐字到达 runner");
    const grandPid = header.grandPid;
    t.diagnostic(`runner pid=${runnerPid} grandPid=${grandPid} at +${Date.now() - t0}ms`);

    // 核心：runner 心跳继续推进；孙进程活着且心跳推进。
    const heartSize = () => (existsSync(heartFile) ? statSync(heartFile).size : 0);
    const grandSize = () => (existsSync(grandHeartFile) ? statSync(grandHeartFile).size : 0);
    const h0 = heartSize();
    const g0 = grandSize();
    await sleep(800);
    const h1 = heartSize();
    const g1 = grandSize();
    t.diagnostic(`heartbeat after job close: runner ${h0}->${h1}, grand ${g0}->${g1} at +${Date.now() - t0}ms`);
    assert.ok(h1 > h0, `runner 心跳继续推进（${h0} → ${h1} 字节）——不随宿主作业关闭而死`);
    assert.ok(pidAlive(runnerPid), "runner 进程活着");
    assert.ok(g1 > g0, `孙进程心跳继续推进（${g0} → ${g1} 字节）`);
    assert.ok(pidAlive(grandPid), "孙进程活着");
    // stderr 证据文件（TD-341 语义在桥路径下保持）。
    assert.ok(existsSync(stderrPath), "stderr 证据文件已创建（哪怕本 runner 未写 stderr）");
  } finally {
    // 收尾：结束全部实验进程并确认无残留。
    const leftovers = [];
    for (const pid of [runnerPid, controlPid, servicePid]) {
      if (pidAlive(pid)) {
        killTree(pid);
        if (pidAlive(pid)) leftovers.push(pid);
      }
    }
    if (ready && typeof ready.launch === "object") {
      // runner 的孙进程随 runner 树结束；单独确认一次首行里的 grandPid。
      try {
        const header = JSON.parse(String(readFileSync(heartFile, "utf8")).split("\n", 1)[0]);
        if (pidAlive(header.grandPid)) {
          killTree(header.grandPid);
          if (pidAlive(header.grandPid)) leftovers.push(header.grandPid);
        }
      } catch { /* 心跳文件没写成：无孙进程可收 */ }
    }
    assert.deepEqual(leftovers, [], `实验进程全部收掉（残留=${JSON.stringify(leftovers)}）`);
    t.diagnostic(`cleanup done at +${Date.now() - t0}ms`);
    rmSync(dir, { recursive: true, force: true });
  }
});
