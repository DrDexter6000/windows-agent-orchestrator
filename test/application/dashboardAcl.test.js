// test/application/dashboardAcl.test.js
//
// 第 145b 批（修正一 #10 改定）：状态目录 ACL 的建立与核对。
//   - 判定是结构化的（RawSecurityDescriptor 的 JSON 投影）：多一条 ACE、条件 ACE、
//     继承未关、属主不是自己、掩码不全、SID 不是自己，逐项用构造的投影钉死；
//   - ensure 建出的三层（根/实例/codes）通过 verify（关继承、属主=当前用户、唯一
//     ACE=允许+OICI+非继承+完全控制+me）；已存在的目录只核对不修复；
//   - 读回走 .NET（无 Get-Acl cmdlet），且每个 powershell 子进程都去掉 PSModulePath
//     ——在"父进程带 PS7 模块路径"的条件下整条链照样绿；
//   - 先核对后使用：根目录是 junction 时，拒绝之前没有创建任何子项、没有改过 ACL；
//     codes\ 与实例目录同一套建立与核对。
// 真 PowerShell 子进程（进程组）+ 注入 execFileFn 的纯判定用例。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";

import {
  ensureDashboardStateDir,
  verifyDashboardStateDir,
  verdictOfReport,
  FULL_CONTROL_MASK,
} from "../../src/application/dashboardAcl.js";

const IS_WIN = process.platform === "win32";
const ME = "S-1-5-21-test-me";
const goodAce = () => ({ allow: true, oi: true, ci: true, inherited: false, mask: FULL_CONTROL_MASK, sid: ME });
const goodReport = () => ({ reparse: false, protected: true, owner: ME, aces: [goodAce()] });

function freshLayers(prefix) {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const root = join(base, "dashboard");
  const inst = join(root, "0123456789abcdef");
  const codes = join(inst, "codes");
  return [root, inst, codes, () => rmSync(base, { recursive: true, force: true })];
}

// ===== 判定（纯函数，注入构造的 JSON 投影） =====

test("verdict: the closed set — every deviation is rejected by name", () => {
  assert.deepEqual(verdictOfReport(goodReport(), ME), { ok: true });
  const deviations = [
    [{ ...goodReport(), protected: false }, "inheritance not protected"],
    [{ ...goodReport(), owner: "S-1-5-21-other" }, "owner is someone else"],
    [{ ...goodReport(), aces: [goodAce(), goodAce()] }, "two ACEs"],
    [{ ...goodReport(), aces: [] }, "no ACE"],
    [{ ...goodReport(), aces: [{ ...goodAce(), allow: false }] }, "deny ACE"],
    [{ ...goodReport(), aces: [{ ...goodAce(), mask: 0x1200A9 }] }, "read-only mask"],
    [{ ...goodReport(), aces: [{ ...goodAce(), sid: "S-1-5-21-other" }] }, "someone else's SID"],
    [{ ...goodReport(), aces: [{ ...goodAce(), inherited: true }] }, "inherited ACE"],
    [{ ...goodReport(), aces: [{ ...goodAce(), oi: false }] }, "missing object-inherit"],
    [{ ...goodReport(), aces: [{ ...goodAce(), ci: false }] }, "missing container-inherit"],
    [{ ...goodReport(), reparse: true }, "reparse point"],
    [null, "unreadable report"],
  ];
  for (const [report, label] of deviations) {
    const verdict = verdictOfReport(report, ME);
    assert.equal(verdict.ok, false, label);
    if (report && report.reparse === true) assert.equal(verdict.reason, "reparse_point", label);
    else assert.equal(verdict.reason, "acl_rejected", label);
  }
});

test("verdict: a CONDITIONAL ace is just another ace record — extra rights for Everyone still reject", () => {
  // 条件 ACE 在结构化投影里不再能靠括号正则漏数：它多一条就是 aces.length !== 1。
  const conditional = { ...goodAce(), sid: "S-1-1-0" }; // Everyone（带条件的允许）
  assert.equal(verdictOfReport({ ...goodReport(), aces: [goodAce(), conditional] }, ME).ok, false);
});

// ===== 真实目录（Windows） =====

test("ensure -> verify: all three layers (root / instance / codes) are built and verified alike", async () => {
  if (!IS_WIN) return;
  const [root, inst, codes, done] = freshLayers("wao-dash-acl3-");
  try {
    assert.deepEqual(await ensureDashboardStateDir(root, inst, codes), { ok: true });
    assert.deepEqual(await verifyDashboardStateDir(root, inst, codes), { ok: true }, "verify-only agrees");
    for (const dir of [root, inst, codes]) assert.ok(!readdirSync(dir === root ? root : dir).includes("dummy"), "no stray entries");
    // 再 ensure 一遍（目录已存在）也通过——只核对，不改写。
    assert.deepEqual(await ensureDashboardStateDir(root, inst, codes), { ok: true });
  } finally {
    done();
  }
});

test("the child env drops PSModulePath — the chain works under a pwsh-7-style parent environment", async () => {
  if (!IS_WIN) return;
  const [root, inst, codes, done] = freshLayers("wao-dash-acl-ps7-");
  try {
    // 父进程带一个假的 PS7 模块路径（真实故障形态），ensure/verify 仍要绿。
    const prev = process.env.PSModulePath;
    process.env.PSModulePath = "C:\\fake\\pwsh7\\modules;" + (prev ?? "");
    try {
      assert.deepEqual(await ensureDashboardStateDir(root, inst, codes), { ok: true }, "the .NET read path does not need Get-Acl");
      assert.deepEqual(await verifyDashboardStateDir(root, inst, codes), { ok: true });
    } finally {
      if (prev === undefined) delete process.env.PSModulePath;
      else process.env.PSModulePath = prev;
    }
    // 且发给 powershell.exe 的环境里确实没有 PSModulePath。
    const seen = [];
    await verifyDashboardStateDir(root, inst, codes, {
      execFileFn: (cmd, args, opts, cb) => {
        seen.push(opts?.env ?? null);
        cb(null, "");
      },
    }).catch(() => {});
  } finally {
    done();
  }
});

test("every powershell child env drops PSModulePath (unit, injected execFileFn)", async () => {
  const seen = [];
  const execFileFn = (cmd, args, opts, cb) => {
    seen.push(opts?.env ?? null);
    cb(null, "");
  };
  await verifyDashboardStateDir("C:/r", "C:/r/i", "C:/r/i/codes", { execFileFn });
  assert.ok(seen.length >= 1);
  for (const env of seen) {
    assert.ok(env !== null, "env is constructed explicitly");
    assert.equal("PSModulePath" in env, false, "PSModulePath dropped");
  }
});

test("a junction as the ROOT is refused with zero side effects: no children created, no ACL touched", async () => {
  if (!IS_WIN) return;
  const base = mkdtempSync(join(tmpdir(), "wao-dash-acl-jr-"));
  try {
    const target = mkdtempSync(join(tmpdir(), "wao-dash-acl-jt-"));
    const root = join(base, "dashboard");
    symlinkSync(target, root, "junction"); // 根本身就是 junction
    const inst = join(root, "0123456789abcdef");
    const codes = join(inst, "codes");
    // 真实 PowerShell 判 reason；同时断言拒绝前零副作用（不建子项、不改 ACL）。
    const before = readdirSync(base);
    const verdict = await ensureDashboardStateDir(root, inst, codes);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "reparse_point");
    assert.deepEqual(readdirSync(base), before, "nothing was created under the base");
    assert.ok(!existsSync(inst) && !existsSync(codes), "neither the instance dir nor codes was created");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("an existing violated dir is refused, never auto-repaired; codes uses the same discipline", async () => {
  if (!IS_WIN) return;
  const [root, inst, codes, done] = freshLayers("wao-dash-acl-tamper-");
  try {
    assert.deepEqual(await ensureDashboardStateDir(root, inst, codes), { ok: true });
    // 动 codes 目录（多一条 Everyone 只读 ACE）——同一闭集核对。
    await new Promise((resolveTamper) => {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `$p='${codes.replace(/'/g, "''")}'; $a=[IO.DirectoryInfo]::new($p).GetAccessControl(); `
        + `$r=New-Object Security.AccessControl.FileSystemAccessRule('Everyone','Read','ContainerInherit,ObjectInherit','None','Allow'); `
        + `$a.AddAccessRule($r); [IO.DirectoryInfo]::new($p).SetAccessControl($a)`],
        { windowsHide: true }, () => resolveTamper());
    });
    const verdict = await verifyDashboardStateDir(root, inst, codes);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "acl_rejected");
    // ensure 也不修复。
    assert.equal((await ensureDashboardStateDir(root, inst, codes)).ok, false);
  } finally {
    done();
  }
});
