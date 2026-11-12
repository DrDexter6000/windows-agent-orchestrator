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
  isFreshHeartbeat,
  machineBootTimeMs,
  rebootedSinceLastActivity,
  DEFAULT_OWNER_LIVENESS_THRESHOLD_MS,
  PID_IDENTITY_TOLERANCE_MS,
  PID_IDENTITY_VERDICTS,
  PID_IDENTITY_BASES,
} from "../../src/application/ownerLiveness.js";

const NOW = 1_800_000_000_000;
const ANCHOR = NOW - 3 * 24 * 60 * 60 * 1000; // 三天前记录的 pid

// =====================================================================
// TD-316: isFreshHeartbeat——心跳判活的唯一规矩。
// 有限数字 且 |now - heartbeatAt| ≤ 阈值 才 fresh；比阈值更靠未来的心跳
// 同样判死（活进程每 2s 重写心跳，只有时钟回拨超阈值那一两秒碰未来侧）。
// =====================================================================

const HB_NOW = 1_000_000;
const HB_TH = 2000;

test("TD-316 HB-01: 非有限值与非数字（Infinity/NaN/字符串/undefined）一律不 fresh", () => {
  assert.equal(isFreshHeartbeat(Infinity, HB_NOW, HB_TH), false, "Infinity（JSON 文本 1e400 解析而来）");
  assert.equal(isFreshHeartbeat(-Infinity, HB_NOW, HB_TH), false);
  assert.equal(isFreshHeartbeat(NaN, HB_NOW, HB_TH), false);
  assert.equal(isFreshHeartbeat("990000", HB_NOW, HB_TH), false, "字符串数字不 fresh");
  assert.equal(isFreshHeartbeat(undefined, HB_NOW, HB_TH), false);
});

test("TD-316 HB-02: 过去侧——阈值内 fresh，超阈值不 fresh（边界 |Δ|=阈值 含）", () => {
  assert.equal(isFreshHeartbeat(HB_NOW - 1000, HB_NOW, HB_TH), true);
  assert.equal(isFreshHeartbeat(HB_NOW - HB_TH, HB_NOW, HB_TH), true, "边界取 <=，含");
  assert.equal(isFreshHeartbeat(HB_NOW - HB_TH - 1, HB_NOW, HB_TH), false);
});

test("TD-316 HB-03: 未来侧——阈值内 fresh，超阈值不 fresh（时钟微回拨容差）", () => {
  assert.equal(isFreshHeartbeat(HB_NOW + 1000, HB_NOW, HB_TH), true);
  assert.equal(isFreshHeartbeat(HB_NOW + HB_TH, HB_NOW, HB_TH), true, "边界取 <=，含");
  assert.equal(isFreshHeartbeat(HB_NOW + HB_TH + 1, HB_NOW, HB_TH), false, "远未来 = 死");
});

test("TD-316 HB-04: 缺省阈值 = DEFAULT_OWNER_LIVENESS_THRESHOLD_MS", () => {
  assert.equal(isFreshHeartbeat(HB_NOW - DEFAULT_OWNER_LIVENESS_THRESHOLD_MS, HB_NOW), true);
  assert.equal(isFreshHeartbeat(HB_NOW - DEFAULT_OWNER_LIVENESS_THRESHOLD_MS - 1, HB_NOW), false);
});

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

// =====================================================================
// 第 107 批：machineBootTimeMs（开机时刻算式）与 rebootedSinceLastActivity
//（重启关系纯陈述）。全部注入，零真实时钟/零真实 uptime。
// =====================================================================

test("BOOT-01: machineBootTimeMs = nowFn() - uptimeFn() * 1000（注入算式）", () => {
  assert.equal(machineBootTimeMs({ nowFn: () => 1_000_000, uptimeFn: () => 12.5 }), 1_000_000 - 12_500);
  assert.equal(machineBootTimeMs({ nowFn: () => 500, uptimeFn: () => 0 }), 500, "uptime 0 = 刚开机");
});

test("REBOOT-01: 晚于/等于/早于三向——严格大于才算成立（等于不算，无容差）", () => {
  const facts = { lastEventAt: 1_000_000, heartbeatAt: 900_000, now: 2_000_000 };
  // 晚于 → 成立，返回 { bootAt, lastActivityAt }。
  assert.deepEqual(
    rebootedSinceLastActivity({ ...facts, bootAt: 1_200_000 }),
    { bootAt: 1_200_000, lastActivityAt: 1_000_000 },
    "最后活动取事件（较晚者）",
  );
  // 等于最后活动 → null（严格大于，把 > 写成 >= 会被这条抓红）。
  assert.equal(rebootedSinceLastActivity({ ...facts, bootAt: 1_000_000 }), null);
  // 早于最后活动 → null。
  assert.equal(rebootedSinceLastActivity({ ...facts, bootAt: 999_999 }), null);
  // 心跳晚于事件时取心跳：开机晚于事件但早于心跳 → null。
  assert.equal(rebootedSinceLastActivity({
    bootAt: 950_000, lastEventAt: 900_000, heartbeatAt: 1_000_000, now: 2_000_000,
  }), null);
  assert.deepEqual(
    rebootedSinceLastActivity({
      bootAt: 1_000_500, lastEventAt: 900_000, heartbeatAt: 1_000_000, now: 2_000_000,
    }),
    { bootAt: 1_000_500, lastActivityAt: 1_000_000 },
    "最后活动取心跳（较晚者）",
  );
});

test("REBOOT-02: 只有事件 / 只有心跳 / 两者都无效", () => {
  // 只有事件（心跳 undefined）→ 可成立。
  assert.deepEqual(
    rebootedSinceLastActivity({ bootAt: 1_100, lastEventAt: 1_000, heartbeatAt: undefined, now: 2_000 }),
    { bootAt: 1_100, lastActivityAt: 1_000 },
  );
  // 只有心跳（事件 NaN）→ 可成立。
  assert.deepEqual(
    rebootedSinceLastActivity({ bootAt: 1_100, lastEventAt: NaN, heartbeatAt: 1_050, now: 2_000 }),
    { bootAt: 1_100, lastActivityAt: 1_050 },
  );
  // 两者都无效（NaN/字符串/undefined）→ null（没有可比较的最后活动）。
  assert.equal(rebootedSinceLastActivity({ bootAt: 1_100, lastEventAt: NaN, heartbeatAt: "soon", now: 2_000 }), null);
  assert.equal(rebootedSinceLastActivity({ bootAt: 1_100, lastEventAt: undefined, heartbeatAt: undefined, now: 2_000 }), null);
});

test("REBOOT-03: bootAt 非有限 / 晚于 now / now 非有限 → null（bootAt == now 不算晚于）", () => {
  const base = { lastEventAt: 1_000, heartbeatAt: 900, now: 2_000 };
  assert.equal(rebootedSinceLastActivity({ ...base, bootAt: NaN }), null);
  assert.equal(rebootedSinceLastActivity({ ...base, bootAt: Infinity }), null);
  assert.equal(rebootedSinceLastActivity({ ...base, bootAt: "2026" }), null, "字符串数字不算");
  assert.equal(rebootedSinceLastActivity({ ...base, bootAt: 2_001 }), null, "开机晚于 now（时钟未跟上）");
  // 规格只拒"晚于 now"：等于 now 且晚于最后活动 → 成立（边界按字面实现）。
  assert.deepEqual(
    rebootedSinceLastActivity({ ...base, bootAt: 2_000 }),
    { bootAt: 2_000, lastActivityAt: 1_000 },
    "等于 now 不算晚于 now",
  );
  assert.equal(rebootedSinceLastActivity({ bootAt: 1_500, lastEventAt: 1_000, heartbeatAt: 900, now: NaN }), null);
});
