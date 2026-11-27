// src/application/dashboardAcl.js
//
// 第 145b 批（决定 0131 第 2 条；修正一 #10 改定）：看板状态目录的建立与核对。
//
// 威胁模型：防别的 Windows 账户读到能进看板的凭据（状态目录里有一次性的启动码）。
// 手段：dashboard 根、实例目录、codes 目录三层的继承都关闭，属主与唯一的 ACE 都是
// 当前用户 SID、完全控制。同一账户的其他进程/登录会话、管理员与 SYSTEM 不防。
//
// 修正一的三个硬点：
//   - 读回用 .NET 访问器（[IO.DirectoryInfo]::GetAccessControl()），不用 Get-Acl 这个
//     cmdlet——node 由 pwsh 7 启动时，子进程继承 PS7 的 PSModulePath 会让 Get-Acl 加载
//     错模块而失败（Lead 本机复现）。本文件起的每个 powershell.exe 都从子进程环境里
//     去掉 PSModulePath，让 Windows PowerShell 用自己的缺省值。
//   - 判定按结构核对（RawSecurityDescriptor 的 DiscretionaryAcl 逐条核对 ACE 数量、
//     类型、继承标志、掩码与 SID；S: 段根本不进解析），不用正则解析 SDDL——条件 ACE、
//     SACL 段、嵌套括号都数不准。
//   - 先核对、后使用：ensure 逐层进行（根核对通过之前不在它下面建任何子项、不改
//     ACL）；codes\ 与实例目录同一套建立与核对（不是重解析点、ACL 闭集相同）。
//
// 输出是结构化哨兵（JSON 经 base64 单行），不解析任何本地化文本：
//   wao-me:<当前用户 SID>
//   wao-acl:<base64({"reparse":..,"protected":..,"owner":..,"aces":[{allow,oi,ci,inherited,mask,sid}..]})>
//
// 已知局限（一句话一条）：目录创建与设 ACL 之间有一个极短的半保护窗口（本机单用户
// 威胁模型接受；同账户本就能读这个用户的一切）。
//
// 架构契约：不 import src/commands/*、src/mcp/*、MCP SDK 或 zod；非 Windows 平台
// 只做存在性/符号链接核对（本产品 Windows 原生）。

import { execFile } from "node:child_process";
import { mkdirSync, lstatSync, existsSync } from "node:fs";

const PROBE_TIMEOUT_MS = 25_000;

/** 目录完全控制的访问掩码（FILE_ALL_ACCESS）。 */
export const FULL_CONTROL_MASK = 0x1F01FF;

/**
 * 子进程环境：去掉 PSModulePath（修正一 #10）。node 由 pwsh 7 启动时，powershell.exe
 * 会继承 PS7 的模块路径，Get-Acl / CIM 一类 cmdlet 因此加载错模块而失败；去掉后
 * Windows PowerShell 用自己的缺省值（Get-Item / Get-CimInstance 不受影响）。
 */
function childEnv(env = process.env) {
  const clean = { ...env };
  delete clean.PSModulePath;
  return clean;
}

const b64 = (value) => Buffer.from(String(value), "utf8").toString("base64");
const unb64 = (value) => Buffer.from(String(value), "base64").toString("utf8");

/** 哨兵 JSON 的判定（纯函数，导出供测试）：结构与闭集核对，不用正则碰 SDDL。 */
export function verdictOfReport(reportJson, me) {
  if (reportJson === null || typeof reportJson !== "object") return { ok: false, reason: "acl_rejected" };
  if (reportJson.reparse === true) return { ok: false, reason: "reparse_point" };
  if (reportJson.protected !== true) return { ok: false, reason: "acl_rejected" };
  if (reportJson.owner !== me) return { ok: false, reason: "acl_rejected" };
  const aces = Array.isArray(reportJson.aces) ? reportJson.aces : [];
  if (aces.length !== 1) return { ok: false, reason: "acl_rejected" };
  const ace = aces[0];
  if (ace === null || typeof ace !== "object") return { ok: false, reason: "acl_rejected" };
  if (ace.allow !== true) return { ok: false, reason: "acl_rejected" };
  if (ace.oi !== true || ace.ci !== true) return { ok: false, reason: "acl_rejected" }; // OICI
  if (ace.inherited === true) return { ok: false, reason: "acl_rejected" };
  if (ace.mask !== FULL_CONTROL_MASK) return { ok: false, reason: "acl_rejected" };
  if (ace.sid !== me) return { ok: false, reason: "acl_rejected" };
  return { ok: true };
}

function verifyScript(paths) {
  const lines = ["$ErrorActionPreference='Stop';"];
  for (const path of paths) {
    lines.push(
      `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(path)}'));`,
      "$d=[IO.DirectoryInfo]::new($p);",
      "$rp=[bool]($d.Attributes -band [IO.FileAttributes]::ReparsePoint);",
      "$sec=$d.GetAccessControl();",
      "$sddl=$sec.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner);",
      "$raw=[Security.AccessControl.RawSecurityDescriptor]::new($sddl);",
      "$aces=@();",
      "if ($null -ne $raw.DiscretionaryAcl) { $aces=@($raw.DiscretionaryAcl | ForEach-Object { @{",
      "  allow=([int]$_.AceType -eq 0);",
      // KnownAce（Windows PowerShell 5.1 的 RawACL 项类型）：掩码属性是 AccessMask。
      "  oi=[bool]([int]$_.AceFlags -band 1);",
      "  ci=[bool]([int]$_.AceFlags -band 2);",
      "  inherited=[bool]([int]$_.AceFlags -band 16);",
      "  mask=[int][uint32]$_.AccessMask;",
      "  sid=$_.SecurityIdentifier.Value;",
      "} }) }",
      "$j=@{ reparse=$rp; protected=[bool]($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected); owner=$raw.Owner.Value; aces=$aces } | ConvertTo-Json -Compress -Depth 4;",
      "'wao-acl:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))",
    );
  }
  return lines.join("\n");
}

function protectScript(path) {
  return [
    "$ErrorActionPreference='Stop';",
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(path)}'));`,
    "$d=[IO.Directory]::CreateDirectory($p);",
    "$acl=$d.GetAccessControl();",
    "$me=[Security.Principal.WindowsIdentity]::GetCurrent().User;",
    "$acl.SetOwner($me);",
    "$acl.SetAccessRuleProtection($true,$false);",
    "$rule=New-Object Security.AccessControl.FileSystemAccessRule($me,'FullControl','ContainerInherit,ObjectInherit','None','Allow');",
    "$acl.AddAccessRule($rule);",
    "$d.SetAccessControl($acl);",
  ].join("\n");
}

const ME_SCRIPT = "'wao-me:' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value";

const runPowerShell = (script, { execFileFn = execFile, timeoutMs = PROBE_TIMEOUT_MS } = {}) => new Promise((resolve) => {
  try {
    execFileFn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, env: childEnv() },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, tail: String(stderr ?? "").slice(0, 256) });
          return;
        }
        resolve({ ok: true, stdout: String(stdout ?? "") });
      },
    );
  } catch (error) {
    resolve({ ok: false, tail: String(error?.message ?? "").slice(0, 256) });
  }
});

/** 解析一次 verify 输出（wao-me + N 行 wao-acl），逐目录核对；第一个不过的原因带回。 */
async function evaluateReports(combined, paths) {
  const me = /^wao-me:([A-Z0-9*\-]+)$/m.exec(combined);
  if (me === null) return { ok: false, reason: "acl_rejected" };
  const sid = me[1];
  const lines = [...combined.matchAll(/^wao-acl:([A-Za-z0-9+/=]+)$/gm)];
  if (lines.length !== paths.length) return { ok: false, reason: "acl_rejected" };
  for (const [, payload] of lines) {
    let json = null;
    try {
      json = JSON.parse(unb64(payload));
    } catch {
      json = null;
    }
    const verdict = verdictOfReport(json, sid);
    if (verdict.ok !== true) return verdict;
  }
  return { ok: true };
}

/**
 * 逐层建立并核对（修正一 #10：先核对、后使用）。顺序固定为 stateRoot → instanceDir →
 * codesDir；每一层：已存在 → 只核对（不过即拒绝，绝不改写、不自动修复）；不存在 →
 * 创建 + 设 ACL（关继承、属主与唯一 ACE 都是当前用户、完全控制）再读回报对。任何
 * 一层拒绝时，后面的层不动。
 *
 * @param {string} stateRoot — 状态根（绝对路径）
 * @param {string} instanceDir — 实例目录（绝对路径）
 * @param {string} codesDir — codes 目录（绝对路径）
 * @param {object} [deps] — { execFileFn, platform }
 * @returns {Promise<{ok: true}|{ok: false, reason: "reparse_point"|"acl_rejected"|"create_failed"}>}
 */
export async function ensureDashboardStateDir(stateRoot, instanceDir, codesDir, deps = {}) {
  return layeredEnsureOrVerify({ stateRoot, instanceDir, codesDir, create: true, deps });
}

/**
 * 只核对不建立（serve / status / stop 用；status 与 stop 在读写状态目录之前先核对，
 * stop 核对不过就不写停机请求）。
 */
export async function verifyDashboardStateDir(stateRoot, instanceDir, codesDir, deps = {}) {
  return layeredEnsureOrVerify({ stateRoot, instanceDir, codesDir, create: false, deps });
}

async function layeredEnsureOrVerify({ stateRoot, instanceDir, codesDir, create, deps = {} }) {
  const platform = deps.platform ?? process.platform;
  const paths = [stateRoot, instanceDir, codesDir];
  if (platform !== "win32") {
    // 非 Windows：只保证目录存在且不是符号链接（ACL 是 Windows 概念）。
    try {
      for (const dir of paths) {
        if (create) mkdirSync(dir, { recursive: true });
        if (!existsSync(dir)) return { ok: false, reason: "acl_rejected" };
        if (lstatSync(dir).isSymbolicLink()) return { ok: false, reason: "reparse_point" };
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: "create_failed" };
    }
  }
  const me = await runPowerShell(ME_SCRIPT, deps);
  if (me.ok !== true) return { ok: false, reason: "acl_rejected" };
  // 冷启动争锁（E2E 实测）：两个启动器同时建同一层目录，后到者 existsSync 时目录"已在"
  // 但先行者的 protect 还没跑完——核对会读到仍是继承的 ACL。ensure 模式对 acl_rejected
  // 做【只读的有界重试】（等并发创建者把保护做完再读一次；绝不自己改写已有目录的
  // ACL），预算耗尽仍不过才拒绝。reparse_point 不重试（junction 不会自己变没）。
  const retryBudgetMs = create ? (deps.retryBudgetMs ?? 8000) : 0;
  for (const dir of paths) {
    let ownCreate = false;
    if (create && !existsSync(dir)) {
      ownCreate = true;
      try {
        // 根允许补父链（%LOCALAPPDATA%\wao\dashboard 的 wao/ 一级）；子层不 recursive：
        // 父层此刻已核对过，中途被换掉就让它失败。
        mkdirSync(dir, { recursive: dir === stateRoot });
      } catch (error) {
        // 两个启动器同时建同一层，后到者的 mkdir 会撞 EEXIST——目录已在就继续走
        // protect（幂等）+ 核对；其余错误才失败。
        if (error?.code !== "EEXIST") return { ok: false, reason: "create_failed" };
      }
      const applied = await runPowerShell(protectScript(dir), deps);
      if (applied.ok !== true) return { ok: false, reason: "create_failed" };
    }
    // 每层独立读回报对——上一层通过之前，不在它下面动任何东西。
    const deadline = Date.now() + (ownCreate ? 0 : retryBudgetMs);
    for (;;) {
      const report = await runPowerShell(verifyScript([dir]), deps);
      if (report.ok !== true) return { ok: false, reason: "acl_rejected" };
      const verdict = await evaluateReports(me.stdout + "\n" + report.stdout, [dir]);
      if (verdict.ok === true) break;
      if (verdict.reason !== "acl_rejected" || Date.now() >= deadline) return verdict;
      await new Promise((r) => { setTimeout(r, 300); });
    }
  }
  return { ok: true };
}
