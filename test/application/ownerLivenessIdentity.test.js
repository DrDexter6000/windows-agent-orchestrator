// test/application/ownerLivenessIdentity.test.js
//
// identifyProcessIdentity 的判定表测试（任务第 1 步）：
//   - ESRCH（isPidAlive 现有判据）→ gone/pid_exited
//   - 开机时刻晚于锚 → gone/rebooted_since_anchor
//   - 创建时间晚于锚+容差 → gone/pid_reused
//   - 创建时间在容差内 / 早于锚 → same/identity_confirmed
//   - 探测失败 / 解析失败 / 畸形输入 → unknown/identity_unknown
//
// 全部注入（探针/开机时刻/创建时间/spawn 原语/时钟），零真实进程、零真实
// PowerShell。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  identifyProcessIdentity,
  PID_IDENTITY_TOLERANCE_MS,
  PID_IDENTITY_VERDICTS,
  PID_IDENTITY_BASES,
} from "../../src/application/ownerLiveness.js";

const NOW = 1_800_000_000_000;
const ANCHOR = NOW - 3 * 24 * 60 * 60 * 1000; // 三天前记录的 pid

function deps(overrides = {}) {
  return {
    nowFn: () => NOW,
    // 默认：机器在锚之前开机（未重启）。
    bootTimeFn: () => ANCHOR - 24 * 60 * 60 * 1000,
    // 默认：pid 当前持有者创建于锚之前（同一进程）。
    creationTimeFn: async () => ANCHOR - 60 * 1000,
    ...overrides,
  };
}

test("闭集导出：verdicts 与 bases 是冻结清单", () => {
  assert.deepEqual(PID_IDENTITY_VERDICTS, ["gone", "same", "unknown"]);
  assert.deepEqual(PID_IDENTITY_BASES, [
    "pid_exited", "rebooted_since_anchor", "pid_reused", "identity_confirmed", "identity_unknown",
  ]);
});

test("ID-01: signal-0 探活 ESRCH → gone/pid_exited（不再探测开机与创建时间）", async () => {
  let creationProbed = false;
  const r = await identifyProcessIdentity(4242, ANCHOR, deps({
    isAliveFn: () => false,
    creationTimeFn: async () => { creationProbed = true; return ANCHOR; },
  }));
  assert.deepEqual(r, { verdict: "gone", basis: "pid_exited" });
  assert.equal(creationProbed, false, "ESRCH 已定论，不必再探测创建时间");
});

test("ID-02: 开机时刻晚于锚 → gone/rebooted_since_anchor（不探测创建时间）", async () => {
  let creationProbed = false;
  const r = await identifyProcessIdentity(4242, ANCHOR, deps({
    isAliveFn: () => true,
    bootTimeFn: () => ANCHOR + 60 * 1000, // 锚之后 1 分钟开的机
    creationTimeFn: async () => { creationProbed = true; return ANCHOR - 1000; },
  }));
  assert.deepEqual(r, { verdict: "gone", basis: "rebooted_since_anchor" });
  assert.equal(creationProbed, false);
});

test("ID-03: 开机时刻早于锚 → 落到创建时间探测", async () => {
  const r = await identifyProcessIdentity(4242, ANCHOR, deps({
    isAliveFn: () => true,
    bootTimeFn: () => ANCHOR - 1000,
    creationTimeFn: async () => ANCHOR - 2000,
  }));
  assert.deepEqual(r, { verdict: "same", basis: "identity_confirmed" });
});

test("ID-04: 创建时间晚于锚+容差 → gone/pid_reused", async () => {
  const r = await identifyProcessIdentity(4242, ANCHOR, deps({
    isAliveFn: () => true,
    creationTimeFn: async () => ANCHOR + PID_IDENTITY_TOLERANCE_MS + 1,
  }));
  assert.deepEqual(r, { verdict: "gone", basis: "pid_reused" });
});

test("ID-05: 创建时间恰在锚+容差边界（含） → same（容差是具名常量）", async () => {
  assert.equal(PID_IDENTITY_TOLERANCE_MS, 5000, "容差 = 5 秒具名常量");
  const r = await identifyProcessIdentity(4242, ANCHOR, deps({
    isAliveFn: () => true,
    creationTimeFn: async () => ANCHOR + PID_IDENTITY_TOLERANCE_MS,
  }));
  assert.deepEqual(r, { verdict: "same", basis: "identity_confirmed" });
});

test("ID-06: 创建时间早于锚 → same", async () => {
  const r = await identifyProcessIdentity(4242, ANCHOR, deps({
    isAliveFn: () => true,
    creationTimeFn: async () => ANCHOR - 3600 * 1000,
  }));
  assert.deepEqual(r, { verdict: "same", basis: "identity_confirmed" });
});

test("ID-07: 创建时间探测失败（null）→ unknown/identity_unknown", async () => {
  const r = await identifyProcessIdentity(4242, ANCHOR, deps({
    isAliveFn: () => true,
    creationTimeFn: async () => null,
  }));
  assert.deepEqual(r, { verdict: "unknown", basis: "identity_unknown" });
});

test("ID-08: 创建时间探测抛错 → unknown", async () => {
  const r = await identifyProcessIdentity(4242, ANCHOR, deps({
    isAliveFn: () => true,
    creationTimeFn: async () => { throw new Error("probe blew up"); },
  }));
  assert.deepEqual(r, { verdict: "unknown", basis: "identity_unknown" });
});

test("ID-09: 默认 PowerShell 解析链——经 execFileFn 注入验证（成功/垃圾输出/非零退出）", async () => {
  // 不给 creationTimeFn，逼默认实现走 execFileFn（注入的 spawn 原语）。
  const makeDeps = (impl) => ({
    nowFn: () => NOW,
    isAliveFn: () => true,
    bootTimeFn: () => ANCHOR - 24 * 60 * 60 * 1000,
    execFileFn: impl,
  });
  // 成功：ISO 'o' 格式（7 位小数秒）→ 解析为 ms。
  const ok = await identifyProcessIdentity(4242, ANCHOR, makeDeps((cmd, args, opts, cb) => {
    assert.equal(cmd, "powershell.exe");
    assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
    assert.equal(opts.windowsHide, true);
    assert.equal(opts.timeout, 10000);
    cb(null, "2026-01-01T00:00:00.1234567Z\n");
  }));
  assert.equal(ok.verdict, "same", "1970 早于锚 → same（解析成功）");
  // 垃圾输出 → null → unknown。
  const garbage = await identifyProcessIdentity(4242, ANCHOR, makeDeps((c, a, o, cb) => cb(null, "not a date")));
  assert.deepEqual(garbage, { verdict: "unknown", basis: "identity_unknown" });
  // 非零退出（Get-Process -ErrorAction Stop 找不到进程）→ null → unknown。
  const dead = await identifyProcessIdentity(4242, ANCHOR, makeDeps((c, a, o, cb) => cb(new Error("no process"))));
  assert.deepEqual(dead, { verdict: "unknown", basis: "identity_unknown" });
});

test("ID-10: 探针抛错 / 返回非布尔 → unknown", async () => {
  const thrown = await identifyProcessIdentity(4242, ANCHOR, deps({ isAliveFn: () => { throw new Error("x"); } }));
  assert.deepEqual(thrown, { verdict: "unknown", basis: "identity_unknown" });
  const weird = await identifyProcessIdentity(4242, ANCHOR, deps({ isAliveFn: () => "yes" }));
  assert.deepEqual(weird, { verdict: "unknown", basis: "identity_unknown" });
});

test("ID-11: 畸形输入（pid/锚）→ unknown，不探测任何东西", async () => {
  let probed = 0;
  const d = deps({
    isAliveFn: () => { probed += 1; return true; },
    creationTimeFn: async () => { probed += 1; return ANCHOR; },
  });
  assert.deepEqual(await identifyProcessIdentity(0, ANCHOR, d), { verdict: "unknown", basis: "identity_unknown" });
  assert.deepEqual(await identifyProcessIdentity(-5, ANCHOR, d), { verdict: "unknown", basis: "identity_unknown" });
  assert.deepEqual(await identifyProcessIdentity(4242, NaN, d), { verdict: "unknown", basis: "identity_unknown" });
  assert.deepEqual(await identifyProcessIdentity(4242, "3d ago", d), { verdict: "unknown", basis: "identity_unknown" });
  assert.equal(probed, 0, "畸形输入在任何探测之前拒绝");
});

test("ID-12: 开机时刻读不出（非有限值）→ 跳过该判据、落到创建时间探测", async () => {
  const r = await identifyProcessIdentity(4242, ANCHOR, deps({
    isAliveFn: () => true,
    bootTimeFn: () => NaN,
    creationTimeFn: async () => ANCHOR + PID_IDENTITY_TOLERANCE_MS + 1,
  }));
  assert.deepEqual(r, { verdict: "gone", basis: "pid_reused" });
});
