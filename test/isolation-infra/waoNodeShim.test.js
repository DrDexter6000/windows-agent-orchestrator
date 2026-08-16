// test/isolation-infra/waoNodeShim.test.js
//
// scripts/wao-node.cjs shim 探测链契约测试（R5-A 交付物 3）。
//
// 探测顺序（唯一权威 = shim 自身）：
//   腿 1  env WAO_NODE
//   腿 2  %LOCALAPPDATA%\Programs\nodejs-v22\node.exe（约定路径）
//   腿 3  PATH 上 node 的版本经 src/nodeVersionGuard.js 判定放行才用（v23/v24 拒）
//   兜底  exit 127 + 中文指引（不静默回退）
//
// 覆盖（真实 spawn + temp 环境，不用 mock）：
//   (a) WAO_NODE 命中优先于约定路径，且前两腿不加任何输出（stdout/stderr 纯净）
//   (b) 三腿全不命中 → exit 127 + 指引在 stderr（stdout 纯净）
//   (c) PATH 上是 v24 → 拒绝（exit 127 + guard reason；用 csc.exe 编译一个打印
//       v24 版本串的假 node.exe——.NET Framework csc 是 Windows 组件，零外部依赖）
//   (d) PATH 上是 v22 → 成功转发 argv + stderr 打 using-from-PATH 行
//
// 环境构造要点：spawn 时用最小 env 整体替换（不带真实 PATH/LOCALAPPDATA/WAO_NODE，
// 本机默认 node 是 v24，不隔离会误触腿 3 拒绝分支）。node 可执行文件用硬链接
// （同卷零拷贝），跨卷回退 copyFileSync；清理复用 test/_rmrfHelper.mjs。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { checkNodeVersion } from "../../src/nodeVersionGuard.js";
import { rmrfRetry } from "../_rmrfHelper.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const SHIM = join(REPO_ROOT, "scripts", "wao-node.cjs");
const SYSTEM_ROOT = process.env.SystemRoot || "C:\\Windows";
const SYSTEM32 = join(SYSTEM_ROOT, "System32");

// 在 dir 里放置一个当前测试运行 node 的可执行副本（硬链接优先，跨卷回退拷贝）。
function placeNodeExe(dir, name = "node.exe") {
  const dest = join(dir, name);
  try {
    linkSync(process.execPath, dest);
  } catch {
    copyFileSync(process.execPath, dest);
  }
  return dest;
}

// 最小 env：足够 Windows 子进程跑起来，但绝不含真实 PATH / LOCALAPPDATA / WAO_NODE /
// APPDATA。调用方按场景覆盖 PATH / LOCALAPPDATA / WAO_NODE。
function minimalEnv(overrides = {}) {
  return {
    SystemRoot: SYSTEM_ROOT,
    SystemDrive: process.env.SystemDrive || "C:",
    windir: SYSTEM_ROOT,
    ComSpec: process.env.ComSpec || join(SYSTEM32, "cmd.exe"),
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS,
    PATH: SYSTEM32, // System32 没有 node.exe——默认"PATH 上无 node"
    ...overrides,
  };
}

// 用 shim 跑一个子进程（shim 自身由当前测试运行 node 启动——canonical 全量套件
// 经 wao-node.cjs 执行，故 process.execPath 即 v22）。
function runShim(env, args) {
  return spawnSync(process.execPath, [SHIM, ...args], {
    env,
    encoding: "utf8",
    timeout: 90_000,
    windowsHide: true,
  });
}

// 编译一个"假 node.exe"：无论参数如何，stdout 打印指定版本串后退出 0。
// 用于腿 3 的版本判定分支（真机无法提供真 v24 二进制，也不该依赖机器状态）。
function compileFakeNode(dir, versionString) {
  const candidates = [
    join(SYSTEM_ROOT, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(SYSTEM_ROOT, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  const csc = candidates.find((c) => existsSync(c));
  assert.ok(csc, `测试环境缺少 .NET Framework csc.exe（Windows 组件）：${candidates[0]}`);
  const srcPath = join(dir, "fake-node.cs");
  writeFileSync(
    srcPath,
    "using System;class F{static int Main(){Console.WriteLine(\"" +
      versionString +
      "\");return 0;}}\n",
    "utf8"
  );
  const out = join(dir, "node.exe");
  const r = spawnSync(csc, ["/nologo", `/out:${out}`, srcPath], {
    encoding: "utf8",
    timeout: 90_000,
    windowsHide: true,
  });
  assert.equal(r.status, 0, `csc 编译假 node 失败：${r.stderr || r.stdout}`);
  return out;
}

const lower = (s) => String(s || "").toLowerCase();
// 路径 → 字面正则（Windows 路径含反斜杠/括号，需转义；大小写不敏感匹配）。
const pathRe = (p) => new RegExp(String(p).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

// ===== (a) 腿 1 优先于腿 2，且前两腿零额外输出 =====
test("(a) WAO_NODE 命中优先于约定路径；腿 1/2 命中时 stdout/stderr 均无 shim 自身输出", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wao-shim-leg1-"));
  try {
    const legADir = join(tmp, "leg-a");
    mkdirSync(legADir);
    const exeA = placeNodeExe(legADir);
    // 约定路径也放一份（腿 2 同样命中）——若腿序错误会跑到这一份。
    const laRoot = join(tmp, "localappdata");
    mkdirSync(join(laRoot, "Programs", "nodejs-v22"), { recursive: true });
    const exeB = placeNodeExe(join(laRoot, "Programs", "nodejs-v22"));

    const r = runShim(
      minimalEnv({ WAO_NODE: exeA, LOCALAPPDATA: laRoot }),
      ["-e", "console.log(process.execPath)"]
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(
      lower(r.stdout.trim()),
      lower(exeA),
      "赢的应是 WAO_NODE 指向的那份 node，而不是约定路径的 exeB"
    );
    assert.notEqual(lower(r.stdout.trim()), lower(exeB), "约定路径那份不应被执行");
    assert.equal(r.stderr, "", "腿 1/2 命中不打印任何 shim 输出（using-from-PATH 行只属腿 3）");
  } finally {
    rmrfRetry(tmp);
  }
});

// ===== (b) 三腿全不命中 → exit 127 + 中文指引（stderr）=====
test("(b) WAO_NODE 未设、约定路径不存在、PATH 无 node → exit 127，指引在 stderr，stdout 纯净", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wao-shim-miss-"));
  try {
    const laRoot = join(tmp, "localappdata"); // 存在但没有 Programs\nodejs-v22
    mkdirSync(laRoot);
    const r = runShim(
      minimalEnv({ LOCALAPPDATA: laRoot }),
      ["-e", "console.log('should-not-run')"]
    );
    assert.equal(r.status, 127, `应 exit 127，实际 ${r.status}；stderr: ${r.stderr}`);
    assert.equal(r.stdout, "", "不静默回退：目标脚本绝不能被执行");
    assert.match(r.stderr, /WAO 需要 Node v22/, "指引文案（中文）应在 stderr");
    assert.match(r.stderr, /WAO_NODE/, "指引应列出腿 1（env WAO_NODE）");
    assert.match(r.stderr, /nodejs-v22/, "指引应列出腿 2（约定路径）");
    assert.match(r.stderr, /或安装 Node 22 到 PATH/, "指引应包含腿 3 的补救（安装到 PATH）");
  } finally {
    rmrfRetry(tmp);
  }
});

// ===== (c) PATH 上是 v24 → 拒绝 =====
test("(c) 最小 PATH 上是 v24 的 node → exit 127 + guard 拒绝文案（不转发）", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wao-shim-v24-"));
  try {
    const fakeDir = join(tmp, "fake-node-dir");
    mkdirSync(fakeDir);
    const fake = compileFakeNode(fakeDir, "v24.1.0");
    const laRoot = join(tmp, "localappdata");
    mkdirSync(laRoot);

    const r = runShim(
      minimalEnv({ LOCALAPPDATA: laRoot, PATH: [fakeDir, SYSTEM32].join(";") }),
      ["-e", "console.log('should-not-run')"]
    );
    assert.equal(r.status, 127, `v24 应 exit 127，实际 ${r.status}；stderr: ${r.stderr}`);
    assert.equal(r.stdout, "", "v24 被拒时目标脚本绝不能被执行");
    assert.match(r.stderr, /PATH 上的 node 版本被拒绝/, "拒绝分支应指明是 PATH 腿");
    assert.match(r.stderr, /v24\.1\.0/, "应打印探测到的版本");
    assert.match(r.stderr, pathRe(fake), "应打印实际解析到的 node 路径");
    // 单一真相：reason 直接来自 guard 的判定文案（含 libuv 回归说明）。
    assert.match(r.stderr, /Job Object|回归/, "guard 的 v24 拒绝原因应原样出现");
  } finally {
    rmrfRetry(tmp);
  }
});

// ===== (d) PATH 上是 v22 → 成功转发 argv + stderr 打 using-from-PATH 行 =====
test("(d) PATH 上是 v22 → exit 0、argv 透传、stderr 打 using-from-PATH 行（stdout 纯净）", () => {
  // 前置：canonical 套件经 wao-node.cjs 运行，process.execPath 即 guard 放行的 v22。
  // 用 guard 单一真相断言前置成立（而非硬编码 major === 22）。
  const selfVer = spawnSync(process.execPath, ["--version"], { encoding: "utf8" }).stdout.trim();
  assert.ok(
    checkNodeVersion(selfVer).ok,
    `前置失败：测试运行 node ${selfVer} 应被 versionGuard 放行（canonical 下应为 v22）`
  );

  const tmp = mkdtempSync(join(tmpdir(), "wao-shim-v22-"));
  try {
    const legDir = join(tmp, "leg-path");
    mkdirSync(legDir);
    const exe = placeNodeExe(legDir);
    const laRoot = join(tmp, "localappdata");
    mkdirSync(laRoot);

    const env = minimalEnv({ LOCALAPPDATA: laRoot, PATH: [legDir, SYSTEM32].join(";") });
    // 转发 + argv 透传：子进程应看到腿 3 的 node，且额外参数原样到达。
    const r = runShim(env, [
      "-e",
      "console.log(process.execPath); console.log(JSON.stringify(process.argv.slice(1)))",
      "wao-arg-1",
      "wao-arg-2",
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const lines = r.stdout.trim().split(/\r?\n/);
    assert.equal(lower(lines[0]), lower(exe), "执行的应是 PATH 腿解析到的 node");
    assert.equal(lines[1], JSON.stringify(["wao-arg-1", "wao-arg-2"]), "argv 应逐个透传");

    const m = r.stderr.match(/wao-node: using node (v\d+\.\d+\.\d+) from PATH \((.+)\)/);
    assert.ok(m, `stderr 应含 using-from-PATH 行，实际 stderr: ${r.stderr}`);
    assert.ok(checkNodeVersion(m[1]).ok, `行内版本 ${m[1]} 应是 guard 放行版本（v22）`);
    assert.equal(lower(m[2]), lower(exe), "行内路径应是实际解析到的 node.exe");
    // stdout 纯净：using 行绝不能进 stdout（管道消费方解析 stdout）。
    assert.equal(r.stdout.indexOf("wao-node: using"), -1, "using-from-PATH 行不得进 stdout");
  } finally {
    rmrfRetry(tmp);
  }
});
