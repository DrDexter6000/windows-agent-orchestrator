// test/nodeVersionGuard.test.js
//
// TD-40：Node 版本校验守卫。在零依赖约束下，靠 engines+启动校验守住 v22 的 OS 级进程隔离
// （Node 自 v18+ 内置 spawn 子进程进 Job Object，KILL_ON_JOB_CLOSE；v24 是该内置机制回归）。
// 行业最佳实践 = taskkill /T/F（WAO 现状，主动 abort）+ 复用内置 Job Object（被动：父死全杀）。
// 自定义 Job Object 违反零依赖且业界无人这样做。故 TD-40 重定义为 engines+启动校验。
//
// 决策：v22 全放行（内置 Job Object 正常）；v24 全拒（回归，等官方修复版后移入放行清单）。
// 纯函数 checkNodeVersion(versionString) → {ok, blocked?, reason?}，数据驱动便于未来维护。

import test from "node:test";
import assert from "node:assert/strict";
import { checkNodeVersion } from "../src/nodeVersionGuard.js";

// ===== v22 全放行（主力版本，内置 Job Object 正常工作）=====
test("v22 任意小版本放行", () => {
  for (const v of ["v22.0.0", "v22.11.0", "v22.13.1", "v22.20.0"]) {
    const r = checkNodeVersion(v);
    assert.equal(r.ok, true, `${v} 应放行`);
    assert.equal(r.blocked, undefined);
  }
});

test("v22 无 v 前缀也放行", () => {
  const r = checkNodeVersion("22.13.1");
  assert.equal(r.ok, true);
});

// ===== v24 全拒（Job Object 回归，截至 2026-06 无官方修复版）=====
test("v24 任意小版本拒绝（Job Object 内置回归）", () => {
  for (const v of ["v24.0.0", "v24.13.1", "v24.20.0"]) {
    const r = checkNodeVersion(v);
    assert.equal(r.ok, false, `${v} 应拒绝`);
    assert.ok(r.blocked, `${v} 应标 blocked`);
    assert.ok(/v24|Job Object|回归/i.test(r.reason), `${v} reason 应提及 v24/Job Object`);
    assert.ok(/v22/.test(r.reason), "reason 应指引 v22");
  }
});

test("v24 拒绝的 reason 含修复版就绪的指引（数据驱动维护说明）", () => {
  const r = checkNodeVersion("v24.13.1");
  // reason 应提到：等官方修复版后在放行清单放行（让维护者知道怎么解锁）
  assert.match(r.reason, /修复版|fix|放行/i, "reason 应提示未来修复版如何放行");
});

// ===== 未来修复版放行（数据驱动：ALLOWED_FIXED_VERSIONS）=====
test("未来官方发 v24 修复版 → 加入放行清单后该版本放行", () => {
  // 模拟：假设官方在 v24.30.0 修复。checkNodeVersion 应认 ALLOWED_FIXED 里的版本。
  // 初始清单为空（无修复版），故 v24.30.0 当前仍拒；这个测试验证"加入清单后放行"的机制存在。
  // 用 checkNodeVersion(v, {allowedFixed:["v24.30.0"]}) 验证可注入。
  const r = checkNodeVersion("v24.30.0", { allowedFixed: ["v24.30.0"] });
  assert.equal(r.ok, true, "在 allowedFixed 清单里的 v24 修复版应放行");
});

// ===== v23 语义（odd = 不稳定，本就不该用于生产）=====
test("v23（奇数不稳定版）拒绝——不是生产 lane", () => {
  const r = checkNodeVersion("v23.5.0");
  assert.equal(r.ok, false, "v23 不稳定版应拒");
  assert.ok(/v23|stable|不稳定|奇数/i.test(r.reason), "reason 应说明 v23 是不稳定版");
});

// ===== 低于 v22 拒绝（engines 已声明 >=22，但守卫冗余校验）=====
test("v21 及更低拒绝（低于 engines 下限）", () => {
  for (const v of ["v20.18.0", "v21.7.0", "v18.0.0"]) {
    const r = checkNodeVersion(v);
    assert.equal(r.ok, false, `${v} 应拒（低于 v22）`);
    assert.ok(/v22|最低|>=22/i.test(r.reason), `${v} reason 应指引 v22+`);
  }
});

// ===== 坏输入不崩 =====
test("坏版本字符串 → ok:false（不抛错）", () => {
  for (const v of ["", "notaversion", "v", "abc", null, undefined]) {
    const r = checkNodeVersion(v);
    assert.equal(r.ok, false, `${JSON.stringify(v)} 应 ok:false`);
    assert.ok(r.reason, "坏输入也应有 reason");
  }
});
