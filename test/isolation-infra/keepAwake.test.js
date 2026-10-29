// 决定 0093 保持唤醒：引用计数、开关、子进程的参数与环境、三处接线（运行驱动、验证命令、全量入口）。
// 全程注入假 spawn，不起真的 PowerShell。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { holdAwake, keepAwakeDisabled, keepAwakeScript, KEEP_AWAKE_ENV } from "../../src/keepAwake.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function fakeSpawn() {
  const calls = [];
  const spawnImpl = (exe, args, opts) => {
    const child = { killed: 0, unrefed: 0, kill() { this.killed += 1; }, unref() { this.unrefed += 1; }, on() {} };
    calls.push({ exe, args, opts, child });
    return child;
  };
  return { calls, spawnImpl };
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

test("脚本：申请系统与显示都需要的持续状态，等父进程退出", () => {
  const script = keepAwakeScript(4242);
  assert.match(script, /SetThreadExecutionState\(\[uint32\]2147483651\)/);
  assert.equal(2147483651, (0x80000000 | 0x1 | 0x2) >>> 0);
  assert.match(script, /Get-Process -Id 4242 -ErrorAction Stop\)\.WaitForExit\(\)/);
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
