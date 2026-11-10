// 决定 0093/0122 保持唤醒：引用计数、开关、子进程的参数与环境、代启屏保脚本（读用户
// 屏保设置、空闲满超时代启、"没在跑"的 SPI 与扫进程检查在内层）、三处接线（运行驱动、
// 验证命令、全量入口）。脚本形状用逐字行断言与位置断言钉住——两席变异实验里裸 match
// 抓不住 if 内条件被去掉或整行挪位。全程注入假 spawn，不起真的保持子进程；两个真
// PowerShell 的用例只解析脚本与编译 C#（只调 IdleMs，绝不调 SetThreadExecutionState，
// 也不启动屏保）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { holdAwake, keepAwakeDisabled, keepAwakeScript, KEEP_AWAKE_CS, KEEP_AWAKE_ENV } from "../../src/keepAwake.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const isWindows = process.platform === "win32";
const powershellExe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function fakeSpawn() {
  const calls = [];
  const spawnImpl = (exe, args, opts) => {
    const child = { killed: 0, unrefed: 0, kill() { this.killed += 1; }, unref() { this.unrefed += 1; }, on() {} };
    calls.push({ exe, args, opts, child });
    return child;
  };
  return { calls, spawnImpl };
}

// 前台跑完，隐藏窗口，带超时；命令文本经 -EncodedCommand 传入，绕开 Windows 命令行引号。
function runPowerShell(command) {
  return spawnSync(
    powershellExe,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
    { windowsHide: true, timeout: 90000, encoding: "utf8" },
  );
}

const winEnv = { SystemRoot: "C:\\Windows", TEMP: "C:\\T", PATH: "C:\\bin", ZZ_API_KEY: "secret-value", WAO_IN_WORKER: "1" };

test("非 Windows 与 WAO_KEEP_AWAKE=0 时不起子进程", () => {
  const { calls, spawnImpl } = fakeSpawn();
  holdAwake({ platform: "linux", env: winEnv, spawnImpl }).release();
  holdAwake({ platform: "win32", env: { ...winEnv, [KEEP_AWAKE_ENV]: "0" }, spawnImpl }).release();
  assert.equal(calls.length, 0);
  assert.equal(keepAwakeDisabled({ [KEEP_AWAKE_ENV]: " 0 " }), true);
  assert.equal(keepAwakeDisabled({ [KEEP_AWAKE_ENV]: "1" }), false);
  assert.equal(keepAwakeDisabled({}), false);
});

test("同一进程的持有者共用一个子进程，最后一个释放才结束它；release 可重复调用", () => {
  const { calls, spawnImpl } = fakeSpawn();
  const a = holdAwake({ platform: "win32", env: winEnv, spawnImpl, parentPid: 4242 });
  const b = holdAwake({ platform: "win32", env: winEnv, spawnImpl, parentPid: 4242 });
  assert.equal(calls.length, 1);
  a.release();
  a.release();
  assert.equal(calls[0].child.killed, 0, "还有持有者时不结束");
  b.release();
  assert.equal(calls[0].child.killed, 1);
  const c = holdAwake({ platform: "win32", env: winEnv, spawnImpl, parentPid: 4242 });
  assert.equal(calls.length, 2, "全部释放后再持有会另起一个");
  c.release();
});

test("子进程：隐藏的 Windows PowerShell，工作目录在系统目录，不带调用方的凭据变量", () => {
  const { calls, spawnImpl } = fakeSpawn();
  holdAwake({ platform: "win32", env: winEnv, spawnImpl, parentPid: 4242 }).release();
  const { exe, args, opts, child } = calls[0];
  assert.equal(exe, join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  assert.equal(opts.cwd, "C:\\Windows", "不能落在运行的工作树里，否则挡住树的删除");
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.stdio, "ignore");
  assert.equal(child.unrefed, 1, "不拖住调用方的事件循环");
  assert.deepEqual(opts.env, { SystemRoot: "C:\\Windows", TEMP: "C:\\T", PATH: "C:\\bin" });
  const encoded = args[args.indexOf("-EncodedCommand") + 1];
  assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), keepAwakeScript(4242));
});

test("脚本：申请系统与显示都需要的持续状态，按用户屏保设置代启屏保，等父进程退出", () => {
  const script = keepAwakeScript(4242);
  const lines = script.split("\n");
  // 逐字行断言：两席变异实验里裸 match 抓不住 if 内条件被去掉、改比较符或整行挪位。
  const exact = (want, name) => {
    const at = lines.indexOf(want);
    assert.ok(at !== -1, `${name}不在脚本里或逐字不符`);
    return at;
  };
  // 静态成员按全名调用（成员定义里有嵌套 struct 时 -PassThru 返回类型数组，$k:: 会 MethodNotFound）
  exact("[void][Wao.WaoKeepAwake]::SetThreadExecutionState([uint32]2147483651)", "申请持续状态行");
  assert.equal(2147483651, (0x80000000 | 0x1 | 0x2) >>> 0);
  exact("try { $parent = Get-Process -Id 4242 -ErrorAction Stop } catch { exit 0 }", "取父进程行");
  exact("while (-not $parent.WaitForExit(15000)) {", "轮询行");
  exact("    $desk = Get-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -ErrorAction Stop", "读注册表行");
  exact("    [int]$timeoutSec = $desk.ScreenSaveTimeOut", "注册表超时行");
  exact("    $saverExe = [Environment]::ExpandEnvironmentVariables([string]$desk.'SCRNSAVE.EXE')", "展开环境变量行");
  exact("    $mine = ($null -ne $saver) -and (-not $saver.HasExited)", "上次代启检查行");
  exact("    $idleOk = [uint64]([Wao.WaoKeepAwake]::IdleMs()) -ge ([uint64]$timeoutSec * 1000)", "空闲比较行");
  const outer = exact("    if ([Environment]::UserInteractive -and (\"$($desk.ScreenSaveActive)\" -eq '1') -and ($timeoutSec -gt 0) -and ($saverExe.Length -gt 0) -and $idleOk -and (-not $mine) -and (Test-Path -LiteralPath $saverExe -PathType Leaf)) {", "外层条件行");
  const inner = exact("      if ((-not $spi) -and ($scr -eq 0)) {", "内层条件行");
  const spi = exact("      [void][Wao.WaoKeepAwake]::SystemParametersInfo(0x0072, 0, [ref]$spi, 0)", "SPI 行");
  const scr = exact("      $scr = @(Get-Process | Where-Object { $_.Path -and $_.Path -like '*.scr' }).Count", "扫进程行");
  assert.ok(spi > outer && spi < inner, "SPI 行应在外层 if 之后、内层 if 之前");
  assert.ok(scr > outer && scr < inner, "扫进程行应在外层 if 之后、内层 if 之前");
  exact("        $saver = Start-Process -FilePath $saverExe -ArgumentList '/s' -PassThru", "代启行");
  exact("  } catch {}", "循环体 try/catch 收尾行");
  // 空闲毫秒在 C# 里算，uint 回绕安全；脚本内嵌的 C# 与测试共用同一常量
  assert.ok(script.includes(KEEP_AWAKE_CS));
  assert.match(KEEP_AWAKE_CS, /unchecked\(GetTickCount\(\) - li\.dwTime\)/);
  // opts 反映进脚本：pollMs 进循环间隔，saverIdleSec 顶替注册表超时
  const custom = keepAwakeScript(4242, { pollMs: 1000, saverIdleSec: 3 });
  const customLines = custom.split("\n");
  assert.ok(customLines.includes("while (-not $parent.WaitForExit(1000)) {"));
  assert.ok(customLines.includes("    [int]$timeoutSec = 3"));
  assert.doesNotMatch(custom, /\$desk\.ScreenSaveTimeOut/);
});

test("脚本：真实 PowerShell 解析整段脚本零语法错误", { skip: !isWindows }, () => {
  const scriptPath = join(tmpdir(), `wao-keepawake-script-${process.pid}.ps1`);
  try {
    writeFileSync(scriptPath, keepAwakeScript(4242), "utf8");
    const quoted = scriptPath.replace(/'/g, "''");
    const out = runPowerShell([
      "$tokens = $null; $errors = $null",
      `[void][System.Management.Automation.Language.Parser]::ParseFile('${quoted}', [ref]$tokens, [ref]$errors)`,
      "if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Output ($_.Extent.StartLineNumber.ToString() + ': ' + $_.Message) }; exit 1 }",
      "Write-Output 'PARSE_OK'",
    ].join("\n"));
    assert.equal(out.error, undefined, `powershell 没能运行：${out.error}`);
    assert.equal(out.status, 0, `status=${out.status}\nstdout=${out.stdout}\nstderr=${out.stderr}`);
    assert.ok((out.stdout ?? "").includes("PARSE_OK"), out.stdout);
  } finally {
    rmSync(scriptPath, { force: true });
  }
});

test("C#：Add-Type 编译通过，空闲毫秒函数返回非负整数（不调 SetThreadExecutionState，不启动屏保）", { skip: !isWindows }, () => {
  const csPath = join(tmpdir(), `wao-keepawake-cs-${process.pid}.txt`);
  try {
    writeFileSync(csPath, KEEP_AWAKE_CS, "utf8");
    const quoted = csPath.replace(/'/g, "''");
    const out = runPowerShell([
      `$cs = Get-Content -LiteralPath '${quoted}' -Raw`,
      // 生产形态：不带 -PassThru，全名调用
      "Add-Type -Name WaoKeepAwake -Namespace Wao -MemberDefinition $cs",
      "$v = [Wao.WaoKeepAwake]::IdleMs()",
      "Write-Output ('IDLE=' + $v.ToString())",
    ].join("\n"));
    assert.equal(out.error, undefined, `powershell 没能运行：${out.error}`);
    assert.equal(out.status, 0, `status=${out.status}\nstdout=${out.stdout}\nstderr=${out.stderr}`);
    const m = /IDLE=(\d+)/.exec(out.stdout ?? "");
    assert.ok(m, `stdout=${out.stdout}`);
    assert.ok(Number(m[1]) >= 0, `空闲毫秒应为非负整数，得到 ${m?.[1]}`);
  } finally {
    rmSync(csPath, { force: true });
  }
});

test("子进程起不来也不抛：返回的句柄照常可释放", () => {
  const spawnImpl = () => { throw new Error("ENOENT"); };
  const h = holdAwake({ platform: "win32", env: winEnv, spawnImpl });
  assert.doesNotThrow(() => h.release());
});

test("测试入口给测试子进程关掉保持唤醒", async () => {
  const { buildCanonicalChildEnv } = await import("../../scripts/canonical-test.mjs");
  assert.equal(buildCanonicalChildEnv({ PATH: "keep" }, { gateHeld: false })[KEEP_AWAKE_ENV], "0");
});

test("接线：驱动运行到终态、验证命令与全量入口都保持唤醒", () => {
  // 前台运行、后台 runner 与 daemon 都经 waitForCompletion 驱动。
  const manager = readFileSync(join(repoRoot, "src", "runManager.js"), "utf8");
  assert.match(manager, /async waitForCompletion\(options = \{\}\) \{\n\s*const awake = holdAwake\(\);\n\s*try \{\n\s*return await this\._waitForCompletion\(options\);\n\s*\} finally \{\n\s*awake\.release\(\);/);
  const verification = readFileSync(join(repoRoot, "src", "deliveryVerification.js"), "utf8");
  const body = verification.slice(verification.indexOf("export async function runVerificationCommand"));
  assert.match(body.slice(0, body.indexOf("\n}\n")), /const awake = holdAwake\(\);[\s\S]*\}\)\.finally\(\(\) => awake\.release\(\)\);$/);
  const canonical = readFileSync(join(repoRoot, "scripts", "canonical-test.mjs"), "utf8");
  const main = canonical.slice(canonical.indexOf("async function main() {"));
  assert.ok(main.indexOf("holdAwake();") < main.indexOf("isolateSuiteTemp();"), "先于临时目录隔离");
});
