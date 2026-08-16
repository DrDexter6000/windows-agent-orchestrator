// test/isolation-infra/installPs1.test.js
//
// install.ps1（R5-A 薄壳安装器）的解析级 + 参数解析冒烟测试。不真装：
//   1. PS 5.1 下 [scriptblock]::Create 解析不抛（与验收命令一致的 PARSE-OK 检查；
//      install.ps1 带 UTF-8 BOM，PS 5.1 才能正确解码中文文案）
//   2. -WhatIf 冒烟：预检照跑（真实前置检查），clone/npm ci/doctor 只打印不执行，
//      目标目录不被创建（显式 -Ref main，不做 ls-remote 网络调用）
//   3. 非法参数被 param 绑定层拒绝（exit 1）——证明 -File 传参生效
//   4. -Purge 不带 -Uninstall 被拒绝（exit 1）——防误删护栏
//   5. 源级不变量：无语句位 exit（要求 1）、TLS12 存在（要求 2）、
//      不执行 npm link（要求 7）、无 PATH/注册表写入（要求 8）
//
// 归组说明：本文件 spawn 真实 powershell 子进程（读仓库文件 + 前置探测），
// 按 canonical 分波语义归 process 组（与 waoNodeShim.test.js 同波）。
//
// 编码注意：PS 5.1 重定向输出走 OEM 代码页（中文机器=GBK），node 按 utf8 解码会
// 乱码。故所有 -Command 调用先设 [Console]::OutputEncoding=UTF8 再执行脚本——
// 这样中文断言（要求文案逐字可检）与退出码都可靠。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { rmrfRetry } from "../_rmrfHelper.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const PS1 = join(REPO_ROOT, "install.ps1");
// Windows 自带 PS 5.1（固定路径，不依赖 PATH）。
const PS51 = join(
  process.env.SystemRoot || "C:\\Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
);

const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// UTF-8 输出的脚本调用：& '<install.ps1>' <args>。退出码语义与 -File 一致
//（绑定错误/throw → 1，正常结束 → 0，已实测）。
function runInstallPs1(scriptArgs, timeout = 120_000) {
  return spawnSync(PS51, [
    "-NoProfile",
    "-Command",
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; & " + psQuote(PS1) + " " + scriptArgs,
  ], { encoding: "utf8", timeout, windowsHide: true });
}

// ===== 1. PS 5.1 解析级检查（对应验收命令 3）=====
test("install.ps1 在 PS 5.1 下 [scriptblock]::Create 解析不抛（UTF-8 BOM 保证中文文案可解码）", () => {
  assert.ok(existsSync(PS51), `测试环境缺少 powershell.exe：${PS51}`);
  const r = spawnSync(PS51, [
    "-NoProfile",
    "-Command",
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; [scriptblock]::Create((Get-Content -Raw ${psQuote(PS1)})) | Out-Null; 'PARSE-OK'`,
  ], { encoding: "utf8", timeout: 60_000, windowsHide: true });
  assert.equal(r.status, 0, `解析失败：${r.stderr || r.stdout}`);
  assert.match(r.stdout, /PARSE-OK/);
});

// ===== 2. -WhatIf 参数解析冒烟（不真装、无网络）=====
test("-WhatIf：预检照跑，clone/npm ci/doctor 只打印不执行，目录不创建", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wao-ps1-whatif-"));
  try {
    const dest = join(tmp, "never-created");
    const r = runInstallPs1(`-Dest ${psQuote(dest)} -Ref main -WhatIf`);
    assert.equal(r.status, 0, `WhatIf 冒烟应 exit 0：\nstdout:${r.stdout}\nstderr:${r.stderr}`);
    assert.match(r.stdout, /前置检查/, "预检应照跑（只读）");
    assert.match(r.stdout, /\[WhatIf\].*git clone/, "clone 应被 WhatIf 跳过");
    assert.match(r.stdout, /\[WhatIf\].*npm ci/, "npm ci 应被 WhatIf 跳过");
    assert.ok(!existsSync(dest), "-WhatIf 不得创建目标目录");
  } finally {
    rmrfRetry(tmp);
  }
});

// ===== 3. 非法参数被拒绝（param 绑定生效）=====
test("非法参数 -BogusParam → exit 1（参数绑定层拒绝，证明传参对 param 块生效）", () => {
  const r = runInstallPs1("-BogusParam");
  assert.notEqual(r.status, 0, "非法参数必须非零退出");
  assert.match(
    (r.stdout || "") + (r.stderr || ""),
    /BogusParam/,
    "错误输出应点名未知参数（参数绑定层拒绝，而非脚本内部崩溃）"
  );
});

// ===== 4. -Purge 防误删护栏 =====
test("-Purge 不带 -Uninstall → exit 1 并说明仅配合 -Uninstall 使用", () => {
  const r = runInstallPs1("-Purge");
  assert.notEqual(r.status, 0, "-Purge 单独使用必须非零退出");
  assert.match((r.stdout || "") + (r.stderr || ""), /-Purge 仅在与 -Uninstall 配合时有效/);
});

// ===== 5. 源级不变量（要求 1/2/7/8 的机械化钉死）=====
test("源级不变量：无语句位 exit / TLS12 存在 / 不执行 npm link / 无 PATH/注册表写入", () => {
  assert.ok(existsSync(PS1));
  const raw = readFileSync(PS1, "utf8");
  // BOM（PS 5.1 正确解码中文的必要条件）
  assert.ok(raw.charCodeAt(0) === 0xfeff, "install.ps1 必须带 UTF-8 BOM");

  // 先去掉 <# ... #> 块注释（头部说明含"npm link"等纯文案），再取代码行：
  // 代码行 = 非 # 注释行、非 Write-* 输出行（引号内文案不算执行体）。
  const noBlockComments = raw.replace(/<#[\s\S]*?#>/g, "");
  const codeLines = noBlockComments.split(/\r?\n/).filter((l) => {
    const t = l.trim();
    return t && !t.startsWith("#") && !/^(Write-Host|Write-WaoInfo|Write-WaoWarn|Write-WaoStep)/.test(t);
  });
  const code = codeLines.join("\n");

  // 要求 1：禁用语句位 exit（irm|iex 在调用者作用域执行，exit 会杀掉调用方会话）
  for (const l of codeLines) {
    assert.ok(!/^\s*exit\b/.test(l), `发现语句位 exit（禁止）：${l.trim()}`);
  }
  // 要求 2：TLS12 兜底存在
  assert.match(code, /ServicePointManager\]::SecurityProtocol/, "应有 ServicePointManager TLS 设置");
  assert.match(code, /Tls12/, "应显式设 Tls12");
  // 要求 7：不执行 npm link（"unlink -g" 是卸载路径，不在此限）
  const linkCall = code.match(/.*npm(?:\.cmd)?\s+link.*/i)?.[0] ?? null;
  assert.equal(linkCall, null, `不得出现 npm link 调用：${linkCall}`);
  assert.match(code, /unlink -g/, "卸载路径应尝试 npm unlink -g（要求 11）");
  // 要求 8：无 PATH/注册表/环境变量写入
  assert.ok(
    !/Set-ItemProperty|SetEnvironmentVariable|HKCU:|HKLM:|\breg\.exe\s+add/i.test(code),
    "不得出现 PATH/注册表/环境变量写入（要求 8：不改 PATH）"
  );
});
