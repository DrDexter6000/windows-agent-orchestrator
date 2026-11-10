// 保持唤醒（决定 0093；决定 0122 修订）：WAO 有活在跑时，向 Windows 申请"系统与显示
// 都需要"的执行状态。显示请求挡住的是两条实测入睡路径——用电池合盖，以及屏幕熄灭时
// 停电（拉各斯常停电）：机器几秒内就会睡过去，持有显示请求时这两条都没有入睡
// （决定 0122）。睡眠会冻住 worker、全量测试与交付验证，醒来后它们被误判成停滞或超时。
//
// 做法：起一个隐藏的 Windows PowerShell 子进程调用 SetThreadExecutionState
// （ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED），然后轮询等启动它的
// WAO 进程退出。申请随子进程的线程一起失效，WAO 崩溃也不会把机器一直撑着。同一进程里
// 的持有者共用一个子进程，最后一个释放时结束它。不改任何电源设置；用户自己选"睡眠"
// 照样会睡。尽力而为：子进程起不来就不保持，绝不影响调用方。
//
// 代启屏保（决定 0122）：显示请求在这台机器上同时挡住了灭屏和屏保，而 WAO 运行频繁，
// 画面会长时间停在原地，有烧屏风险。所以子进程持有期间每一轮都重读用户在
// HKCU:\Control Panel\Desktop 的屏保设置（开关、超时、屏保文件；用户改了下一轮就生效），
// 空闲满超时、屏保开着、文件在、且当前没有屏保在跑时，代用户启动一次屏保
// （Start-Process <SCRNSAVE.EXE> /s，照常被键鼠输入关掉；父进程退出时不去结束它）。
// 整个循环体包在 try/catch 里，任何失败只跳过该轮，绝不影响保持本身。空闲毫秒数在
// Add-Type 的 C# 里算（GetLastInputInfo + GetTickCount，unchecked 让 uint 回绕安全）：
// Windows PowerShell 5.1 跑在 .NET Framework 上没有 Environment.TickCount64，
// 有符号与无符号的转换不放在 PowerShell 里做。
//
// 关闭：环境变量 WAO_KEEP_AWAKE=0（两个测试入口给测试子进程设了它）。非 Windows 不做事。
import { spawn } from "node:child_process";
import { join } from "node:path";

export const KEEP_AWAKE_ENV = "WAO_KEEP_AWAKE";

// ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x1) | ES_DISPLAY_REQUIRED (0x2)。
// 写成十进制：PowerShell 把 0x80000003 读成负的 Int32，转不成 uint32。
const ES_HOLD = 2147483651;

// 子进程脚本里 Add-Type 的 C# 成员定义，脚本与测试共用一份。测试只编译它、只调
// IdleMs（GetLastInputInfo + GetTickCount 在 C# 里算空闲毫秒，unchecked 让 uint 回绕
// 安全），绝不调 SetThreadExecutionState，也不启动屏保。
export const KEEP_AWAKE_CS = [
  '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);',
  "[StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }",
  '[DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);',
  '[DllImport("kernel32.dll")] public static extern uint GetTickCount();',
  '[DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, ref bool pvParam, uint fWinIni);',
  "public static uint IdleMs() { LASTINPUTINFO li = new LASTINPUTINFO(); li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)); if (!GetLastInputInfo(ref li)) { return 0; } return unchecked(GetTickCount() - li.dwTime); }",
].join("\n");

// 子进程只拿这几个变量：PowerShell 与 Add-Type 编译要用的系统路径和临时目录，
// 不带调用方环境里的凭据。
const HELPER_ENV_NAMES = ["SystemRoot", "SystemDrive", "windir", "TEMP", "TMP", "PATH", "PATHEXT", "ComSpec"];

let shared = null; // { child, holders }

export function keepAwakeDisabled(env = process.env) {
  return String(env[KEEP_AWAKE_ENV] ?? "").trim() === "0";
}

/**
 * 开始保持唤醒，返回 { release() }；release 可重复调用。持有到进程退出的调用方可以不 release。
 * @param {{env?: object, platform?: string, spawnImpl?: Function, parentPid?: number}} [opts] — 测试注入缝
 */
export function holdAwake({ env = process.env, platform = process.platform, spawnImpl = spawn, parentPid = process.pid } = {}) {
  if (platform !== "win32" || keepAwakeDisabled(env)) return { release() {} };
  if (!shared) shared = { child: startHelper({ env, spawnImpl, parentPid }), holders: 0 };
  const mine = shared;
  mine.holders += 1;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      mine.holders -= 1;
      if (mine.holders === 0 && shared === mine) {
        shared = null;
        try { mine.child?.kill(); } catch { /* 已退出 */ }
      }
    },
  };
}

/**
 * 生成保持唤醒子进程的脚本：持显示请求、按用户屏保设置代启屏保、轮询等父进程退出。
 * opts 只给测试与 Lead 冒烟用（pollMs：轮询间隔；saverIdleSec：代替注册表里的屏保超时）；
 * holdAwake 不传，生产只走缺省（每轮 15 秒，超时每轮读注册表）。
 * @param {number} parentPid
 * @param {{pollMs?: number, saverIdleSec?: number}} [opts]
 */
export function keepAwakeScript(parentPid, { pollMs = 15000, saverIdleSec } = {}) {
  const timeoutLine = saverIdleSec === undefined
    ? "[int]$timeoutSec = $desk.ScreenSaveTimeOut"
    : `[int]$timeoutSec = ${Number(saverIdleSec)}`;
  return [
    "$cs = @'",
    ...KEEP_AWAKE_CS.split("\n"),
    "'@",
    "Add-Type -Name WaoKeepAwake -Namespace Wao -MemberDefinition $cs",
    // 静态成员按全名调用，不用 -PassThru 的返回值：成员定义里有嵌套 struct 时它
    // 是类型数组（Object[]），$k::Method 会报 MethodNotFound。
    `[void][Wao.WaoKeepAwake]::SetThreadExecutionState([uint32]${ES_HOLD})`,
    `try { $parent = Get-Process -Id ${parentPid} -ErrorAction Stop } catch { exit 0 }`,
    "$saver = $null",
    `while (-not $parent.WaitForExit(${pollMs})) {`,
    "  try {",
    "    $desk = Get-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -ErrorAction Stop",
    `    ${timeoutLine}`,
    "    $saverExe = [Environment]::ExpandEnvironmentVariables([string]$desk.'SCRNSAVE.EXE')",
    "    $mine = ($null -ne $saver) -and (-not $saver.HasExited)",
    "    $idleOk = [uint64]([Wao.WaoKeepAwake]::IdleMs()) -ge ([uint64]$timeoutSec * 1000)",
    // 便宜的条件先判（-and 从左到右短路）；扫进程表一次约 0.2–0.4 秒（11-10 实测），
    // 只在前面都成立时才做，用户在用电脑时每轮几乎零开销。
    "    if ([Environment]::UserInteractive -and (\"$($desk.ScreenSaveActive)\" -eq '1') -and ($timeoutSec -gt 0) -and ($saverExe.Length -gt 0) -and $idleOk -and (-not $mine) -and (Test-Path -LiteralPath $saverExe -PathType Leaf)) {",
    "      $spi = $false",
    "      [void][Wao.WaoKeepAwake]::SystemParametersInfo(0x0072, 0, [ref]$spi, 0)",
    "      $scr = @(Get-Process | Where-Object { $_.Path -and $_.Path -like '*.scr' }).Count",
    "      if ((-not $spi) -and ($scr -eq 0)) {",
    "        $saver = Start-Process -FilePath $saverExe -ArgumentList '/s' -PassThru",
    "      }",
    "    }",
    "  } catch {}",
    "}",
  ].join("\n");
}

function startHelper({ env, spawnImpl, parentPid }) {
  const systemRoot = env.SystemRoot ?? "C:\\Windows";
  const helperEnv = {};
  for (const name of HELPER_ENV_NAMES) {
    if (env[name] !== undefined) helperEnv[name] = env[name];
  }
  try {
    const child = spawnImpl(
      join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-EncodedCommand", Buffer.from(keepAwakeScript(parentPid), "utf16le").toString("base64")],
      {
        // 工作目录不跟调用方：它若在运行的工作树里，这个子进程会挡住树的删除。
        cwd: systemRoot,
        env: helperEnv,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.on?.("error", () => {});
    // 不拖住调用方的事件循环：调用方照常退出，子进程随之退出。
    child.unref?.();
    return child;
  } catch {
    return null;
  }
}
