// 保持唤醒（决定 0093）：WAO 有活在跑时，向 Windows 申请"系统与显示都需要"的执行
// 状态，免得屏幕空闲超时把笔记本送进新型待机。待机会冻住 worker、全量测试与交付
// 验证，醒来后它们被误判成停滞或超时。
//
// 做法：起一个隐藏的 Windows PowerShell 子进程调用 SetThreadExecutionState
// （ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED），然后等启动它的 WAO
// 进程退出。申请随子进程的线程一起失效，WAO 崩溃也不会把机器一直撑着。同一进程里
// 的持有者共用一个子进程，最后一个释放时结束它。不改任何电源设置；用户自己选"睡眠"
// 照样会睡。尽力而为：子进程起不来就不保持，绝不影响调用方。
//
// 关闭：环境变量 WAO_KEEP_AWAKE=0（两个测试入口给测试子进程设了它）。非 Windows 不做事。
import { spawn } from "node:child_process";
import { join } from "node:path";

export const KEEP_AWAKE_ENV = "WAO_KEEP_AWAKE";

// ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x1) | ES_DISPLAY_REQUIRED (0x2)。
// 写成十进制：PowerShell 把 0x80000003 读成负的 Int32，转不成 uint32。
const ES_HOLD = 2147483651;

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

export function keepAwakeScript(parentPid) {
  return [
    "$k = Add-Type -Name WaoKeepAwake -Namespace Wao -PassThru -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
    `[void]$k::SetThreadExecutionState([uint32]${ES_HOLD})`,
    `try { (Get-Process -Id ${parentPid} -ErrorAction Stop).WaitForExit() } catch {}`,
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
