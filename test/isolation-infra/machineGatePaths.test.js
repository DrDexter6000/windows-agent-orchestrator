// test/isolation-infra/machineGatePaths.test.js
//
// R23-F/B Round B：
//   · F2 审计项 —— 把 Round A 落地的 src/machineGatePaths.js 的三条契约钉进测试：
//     (1) 环境覆写免疫：TMP/TEMP/TMPDIR 永不参与解析（这是该模块存在的理由——
//         验证子进程会被注入全新 per-attempt 临时目录到这三个变量）；
//     (2) LOCALAPPDATA 覆写调用期即时生效；缺失时回落 ~/.wao-machine；
//     (3) 目录按需幂等创建（重复调用不抛错、目录存在）；
//     (4) verification lease 与 inflight marker 同一机器级基座目录。
//   · B1 —— 同机全量验证串行化闸（verification lease）的状态测试（第二部分，
//     RED 先行：src/verificationGate.js 尚不存在）。
//
// 这些测试只触碰 mkdtemp 出来的临时目录（或只读断言路径字符串）；绝不向真实
// %LOCALAPPDATA%\wao 写入任何闸状态文件。

import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  INFLIGHT_MARKER_FILENAME,
  VERIFICATION_LEASE_FILENAME,
  inflightMarkerPath,
  verificationLeasePath,
  waoMachineStateDir,
} from "../../src/machineGatePaths.js";
import {
  CORRUPT_GRACE_MS,
  HEARTBEAT_INTERVAL_MS,
  MAX_HOLD_MS,
  STALE_MS,
  VERIFICATION_GATE_HELD_ENV,
  VERIFICATION_GATE_OFF_ENV,
  WAIT_LOG_INTERVAL_MS,
  createVerificationGate,
  defaultLeaseFs,
  gateDisabled,
} from "../../src/verificationGate.js";

/** 临时改写 process.env 跑一个断言体，结束后无条件还原（含删除 undefined 键）。 */
function withEnv(overrides, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of saved.entries()) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

// =====================================================================
// F2①：环境覆写免疫
// =====================================================================

test("F2①: TMP/TEMP/TMPDIR 覆写不影响任何 gate 路径解析（env 免疫）", () => {
  const junk = join(tmpdir(), "wao-f2-must-never-appear");
  withEnv({ TMP: junk, TEMP: junk, TMPDIR: junk }, () => {
    for (const p of [waoMachineStateDir(), inflightMarkerPath(), verificationLeasePath()]) {
      assert.ok(!p.includes("wao-f2-must-never-appear"),
        `gate 路径不得派生自 TMP/TEMP/TMPDIR: ${p}`);
    }
  });
});

test("F2②: LOCALAPPDATA 覆写调用期即时生效（win32 → %LOCALAPPDATA%\\wao）", () => {
  const fakeAppData = mkdtempSync(join(tmpdir(), "wao-f2-appdata-"));
  try {
    withEnv({ LOCALAPPDATA: fakeAppData }, () => {
      if (process.platform === "win32") {
        assert.equal(waoMachineStateDir(), join(fakeAppData, "wao"));
        assert.equal(inflightMarkerPath(), join(fakeAppData, "wao", INFLIGHT_MARKER_FILENAME));
        assert.equal(verificationLeasePath(), join(fakeAppData, "wao", VERIFICATION_LEASE_FILENAME));
      } else {
        // 非 win32 主机约定：无论 LOCALAPPDATA 与否都走 ~/.wao-machine。
        assert.equal(waoMachineStateDir(), join(homedir(), ".wao-machine"));
      }
    });
  } finally {
    rmSync(fakeAppData, { recursive: true, force: true });
  }
});

test("F2③: LOCALAPPDATA 缺失时回落 ~/.wao-machine", () => {
  withEnv({ LOCALAPPDATA: undefined }, () => {
    assert.equal(waoMachineStateDir(), join(homedir(), ".wao-machine"));
  });
});

// =====================================================================
// F2②(续)：目录按需幂等创建
// =====================================================================

test("F2④: 目录按需幂等创建——覆写 LOCALAPPDATA 后连续两次调用不抛错且目录存在", () => {
  const fakeAppData = mkdtempSync(join(tmpdir(), "wao-f2-mkdir-"));
  try {
    withEnv({ LOCALAPPDATA: fakeAppData }, () => {
      if (process.platform !== "win32") return; // 该分支仅 win32 语义
      const first = waoMachineStateDir();
      const second = waoMachineStateDir(); // 幂等：重复创建不得抛错
      assert.equal(first, second);
      assert.ok(existsSync(first), "调用后机器状态目录必须存在");
      assert.ok(existsSync(join(fakeAppData, "wao")));
    });
  } finally {
    rmSync(fakeAppData, { recursive: true, force: true });
  }
});

test("F2④b: 目录已存在时重复调用同样不抛错（mkdirSync recursive 幂等）", () => {
  const fakeAppData = mkdtempSync(join(tmpdir(), "wao-f2-mkdir2-"));
  try {
    withEnv({ LOCALAPPDATA: fakeAppData }, () => {
      if (process.platform !== "win32") return;
      mkdirSync(join(fakeAppData, "wao"), { recursive: true });
      assert.doesNotThrow(() => waoMachineStateDir());
    });
  } finally {
    rmSync(fakeAppData, { recursive: true, force: true });
  }
});

// =====================================================================
// F2③：lease 路径与 marker 路径同一机器级基座
// =====================================================================

test("F2⑤: verificationLeasePath 与 inflightMarkerPath 同基座目录、文件名各自钉死", () => {
  const fakeAppData = mkdtempSync(join(tmpdir(), "wao-f2-base-"));
  try {
    withEnv({ LOCALAPPDATA: fakeAppData }, () => {
      const base = waoMachineStateDir();
      assert.equal(inflightMarkerPath(), join(base, INFLIGHT_MARKER_FILENAME));
      assert.equal(verificationLeasePath(), join(base, VERIFICATION_LEASE_FILENAME));
      assert.equal(verificationLeasePath(), join(base, "verification.lease"));
    });
  } finally {
    rmSync(fakeAppData, { recursive: true, force: true });
  }
});

test("F2⑤b: 基座随 LOCALAPPDATA 覆写同步移动（两路径永远同进退）", () => {
  const appDataA = mkdtempSync(join(tmpdir(), "wao-f2-baseA-"));
  const appDataB = mkdtempSync(join(tmpdir(), "wao-f2-baseB-"));
  try {
    withEnv({ LOCALAPPDATA: appDataA }, () => {
      if (process.platform !== "win32") return;
      const baseA = verificationLeasePath();
      withEnv({ LOCALAPPDATA: appDataB }, () => {
        const baseB = verificationLeasePath();
        assert.notEqual(baseA, baseB, "覆写切换后 lease 路径必须跟着基座走");
        assert.equal(baseB, join(appDataB, "wao", VERIFICATION_LEASE_FILENAME));
      });
    });
  } finally {
    rmSync(appDataA, { recursive: true, force: true });
    rmSync(appDataB, { recursive: true, force: true });
  }
});

// =====================================================================
// B1：同机全量验证串行化闸（verification lease）状态测试。
//
// 被测对象 src/verificationGate.js 的契约（Round B 设计定稿）：
//   · createVerificationGate({leasePath, logPath?, sink?, now?, sleep?,
//     identity?, pid?}) → {acquire, status, breakLock}
//   · acquire() 永不 reject：拿到 handle（{token, release(), lost()}）、
//     或基础设施故障时 fail-open 返回 null（调用方无闸继续跑，绝不新增失败码）
//   · 租约记录 JSON {schemaVersion:1, token, owner, runId?, sessionId?,
//     agentId?, pid(仅信息性), startedAt, heartbeatAt}；存活判定只用
//     heartbeatAt 新鲜度（~90s 陈旧回收），绝不做 PID 探活
//   · 心跳 ~30s 续期；持有者侧周期复核 token——发现被接管则记 "lease lost"，
//     不抛错、绝不删别人的锁
//   · 释放只认 token 匹配（gitLocalExclude 先例）：token 不匹配 = no-op
//   · 损坏文件有宽限窗（~15s），过后按损坏回收
//   · 等待者每 ~30s 向 sink 打一条含持有者身份的等待日志
//   · startedAt 超过硬上限 45min ⇒ 即使心跳仍新鲜也判定弃置、允许接管
//     （"活着但挂死"是本轮的主症状）
//   · 并发原子认领：open(wx) O_EXCL + EEXIST→重读确认循环；回收一律走
//     "内容未变才删" 的 CAS（绝不误删竞态中胜出的新主人租约）
//   · kill switch：WAO_VERIFICATION_GATE=off（仅由调用方经 gateDisabled 判定）
//
// 时钟/睡眠/日志全部注入：共享假钟 + 手动 tick 的睡眠队列，零真实等待。
// =====================================================================

/** 手动推进的假钟。 */
function makeClock(startMs = 1_000_000) {
  const clock = { time: startMs };
  clock.now = () => clock.time;
  return clock;
}

/**
 * 可手动 tick 的 sleep 注入：每次 tick 弹出最早挂起的睡眠、把假钟推进相应
 * 毫秒再放行。tick 内部冲若干轮微任务，保证闸的循环体完整走到下一次挂起。
 */
function makeSleepControl(clock) {
  const queue = [];
  const sleep = (ms) =>
    new Promise((resolve) => {
      queue.push({ ms, resolve });
    });
  const flushMicro = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  const tick = async (n = 1) => {
    for (let i = 0; i < n; i += 1) {
      const entry = queue.shift();
      if (!entry) return false;
      clock.time += entry.ms;
      entry.resolve();
      await flushMicro();
    }
    return true;
  };
  return { sleep, tick, hasPending: () => queue.length > 0 };
}

function isSettled(promise) {
  const probe = Symbol("probe");
  return Promise.race([promise, Promise.resolve(probe)]).then(
    (value) => value !== probe,
  );
}

let pidCounter = 0;

/** 在同一假钟/同一租约文件上造一个闸（各自独立睡眠队列与 sink 行前缀）。 */
function makeGate(dir, id, { identity = {}, lines, clock } = {}) {
  const ctl = makeSleepControl(clock);
  const gate = createVerificationGate({
    leasePath: join(dir, VERIFICATION_LEASE_FILENAME),
    now: clock.now,
    sleep: ctl.sleep,
    sink: (line) => lines.push(`[${id}] ${line}`),
    identity: { owner: id, ...identity },
    pid: 10000 + (pidCounter += 1),
  });
  return { gate, ctl };
}

function seedLease(leasePath, content) {
  writeFileSync(leasePath, typeof content === "string" ? content : JSON.stringify(content), "utf8");
}

function readLeaseRaw(leasePath) {
  try {
    return readFileSync(leasePath, "utf8");
  } catch {
    return null;
  }
}

function extRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    token: `tok-ext-${Math.random().toString(16).slice(2)}`,
    owner: "ext-seeder",
    pid: 424242,
    startedAt: 0,
    heartbeatAt: 0,
    ...overrides,
  };
}

async function tickUntilSettled(ctl, promise, maxTicks = 300) {
  for (let i = 0; i < maxTicks; i += 1) {
    if (await isSettled(promise)) return true;
    if (!ctl.hasPending()) {
      throw new Error("waiter stalled: no pending sleep and still unresolved");
    }
    await ctl.tick(1);
  }
  return isSettled(promise);
}

test("B1-13: 设计常量与 env 名钉死；gateDisabled 只认 off（trim/大小写不敏感）", async () => {
  // 规格 fixed 值：心跳 ~30s、陈旧 ~90s、硬上限 45min。
  assert.equal(HEARTBEAT_INTERVAL_MS, 30_000);
  assert.equal(STALE_MS, 90_000);
  assert.equal(MAX_HOLD_MS, 45 * 60_000);
  assert.ok(CORRUPT_GRACE_MS > 0 && CORRUPT_GRACE_MS <= STALE_MS);
  assert.ok(WAIT_LOG_INTERVAL_MS > 0 && WAIT_LOG_INTERVAL_MS <= HEARTBEAT_INTERVAL_MS * 2);
  assert.equal(VERIFICATION_GATE_HELD_ENV, "WAO_VERIFICATION_GATE_HELD");
  assert.equal(VERIFICATION_GATE_OFF_ENV, "WAO_VERIFICATION_GATE");
  assert.equal(gateDisabled({ [VERIFICATION_GATE_OFF_ENV]: "off" }), true);
  assert.equal(gateDisabled({ [VERIFICATION_GATE_OFF_ENV]: " OFF " }), true);
  assert.equal(gateDisabled({}), false);
  assert.equal(gateDisabled({ [VERIFICATION_GATE_OFF_ENV]: undefined }), false);
  assert.equal(gateDisabled({ [VERIFICATION_GATE_OFF_ENV]: "on" }), false);
});

test("B1-01: 空闲认领——立即拿到 handle，租约落盘含身份与时间戳，release 后回到 free", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b1-01-"));
  try {
    const clock = makeClock();
    const lines = [];
    const { gate } = makeGate(dir, "solo", { clock, lines });
    const leasePath = join(dir, VERIFICATION_LEASE_FILENAME);

    const handle = await gate.acquire(); // 空闲：无需任何 tick 即成功
    assert.ok(handle, "空闲基线上 acquire 必须成功");
    assert.match(handle.token, /^tok-/);
    assert.equal(handle.lost(), false);

    const raw = readLeaseRaw(leasePath);
    assert.ok(raw, "认领后租约文件必须存在");
    const record = JSON.parse(raw);
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.token, handle.token);
    assert.equal(record.owner, "solo");
    assert.equal(record.startedAt, clock.time);
    assert.equal(record.heartbeatAt, clock.time);
    assert.equal(typeof record.pid, "number");

    const status = await gate.status();
    assert.equal(status.free, false);
    assert.equal(status.holder.owner, "solo");

    assert.equal(await handle.release(), true);
    assert.equal(readLeaseRaw(leasePath), null, "释放后租约必须删除");
    assert.deepEqual(await gate.status(), { free: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1-02: 他者持有时第二方等待而非抢夺；对方 release 后下一拍获得全新租约", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b1-02-"));
  try {
    const clock = makeClock();
    const lines = [];
    const a = makeGate(dir, "holder-a", { clock, lines });
    const b = makeGate(dir, "waiter-b", { clock, lines });

    const hA = await a.gate.acquire();
    assert.ok(hA);

    const pB = b.gate.acquire(); // 循环体同步推进到第一次睡眠挂起
    assert.equal(await isSettled(pB), false, "他人新鲜持有时不得放行");
    await b.ctl.tick(5); // 等 5 拍（5s）
    assert.equal(await isSettled(pB), false, "仍在等待期内");

    assert.equal(await hA.release(), true);
    await b.ctl.tick(3); // 唤醒后的下一拍重新尝试认领
    assert.equal(await isSettled(pB), true, "锁释放后等待者必须拿到闸");
    const hB = await pB;
    assert.match(hB.token, /^tok-/);
    assert.notEqual(hB.token, hA.token);
    const record = JSON.parse(readLeaseRaw(join(dir, VERIFICATION_LEASE_FILENAME)));
    assert.equal(record.token, hB.token);
    // 新主人 startedAt 是取得瞬间的全新时刻（等待期推进过假钟），且不早于该
    // 时刻被后续心跳继续刷新（上面 tick(3) 的后两拍驱动了 B 自己的心跳）。
    assert.ok(record.startedAt > 1_000_000 && record.startedAt <= clock.time,
      "新主人 startedAt 必须是取得时的全新时刻（排队时间不计入其持有窗口）");
    assert.ok(record.heartbeatAt >= record.startedAt);

    await hB.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1-03: 心跳持续续期期间不得回收（新鲜 heartbeat 压住 90s 陈旧线）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b1-03-"));
  try {
    const clock = makeClock();
    const lines = [];
    const a = makeGate(dir, "beating-a", { clock, lines });
    const b = makeGate(dir, "waiter-b", { clock, lines });

    const hA = await a.gate.acquire();
    const pB = b.gate.acquire();
    await new Promise((r) => setImmediate(r));

    // 两轮心跳（+60s），随后等待者轮询 20 拍（+20s）：距上次心跳 ≤20s+，
    // 全程远低于 STALE_MS。
    await a.ctl.tick(1);
    await b.ctl.tick(20);
    await a.ctl.tick(1);
    await b.ctl.tick(20);

    assert.equal(await isSettled(pB), false, "心跳存活的持有者不得被接管");
    const record = JSON.parse(readLeaseRaw(join(dir, VERIFICATION_LEASE_FILENAME)));
    assert.equal(record.token, hA.token, "租约仍是原持有者的");
    assert.ok(record.heartbeatAt > 1_000_000, "heartbeatAt 已被心跳刷新");

    await hA.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1-04: 心跳停跳超过 90s ⇒ 等待者按陈旧回收并接管", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b1-04-"));
  try {
    const clock = makeClock();
    const lines = [];
    const a = makeGate(dir, "dead-a", { clock, lines });
    const b = makeGate(dir, "taker-b", { clock, lines });

    const hA = await a.gate.acquire();
    const pB = b.gate.acquire();
    await new Promise((r) => setImmediate(r));

    // A 从此不再心跳；B 一拍一拍推过 STALE_MS（90s / 1s 每拍）。
    const got = await tickUntilSettled(b.ctl, pB, 200);
    assert.ok(got, "陈旧租约必须在 ~90s 内被回收放行");
    const hB = await pB;
    assert.notEqual(hB.token, hA.token);
    const record = JSON.parse(readLeaseRaw(join(dir, VERIFICATION_LEASE_FILENAME)));
    assert.equal(record.token, hB.token);

    // 回收决策必须带持有者身份进日志（取证线索）。
    assert.ok(lines.some((l) => l.includes("stale") && l.includes("dead-a")),
      `回收日志须含 stale 与原持有者身份: ${JSON.stringify(lines)}`);

    assert.ok(await hB.release());
    assert.equal(await hA.release(), false, "原持有者此刻释放必须是 no-op");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1-05: 释放只认 token 匹配——租约已易主或已消失时 release 是 no-op", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b1-05-"));
  try {
    const clock = makeClock();
    const lines = [];
    const a = makeGate(dir, "stale-owner", { clock, lines });
    const leasePath = join(dir, VERIFICATION_LEASE_FILENAME);

    const hA = await a.gate.acquire();

    // 外部把租约换成新主人 N（模拟已被接管的现场）。
    const nRecord = extRecord({ startedAt: clock.time, heartbeatAt: clock.time });
    seedLease(leasePath, nRecord);
    assert.equal(await hA.release(), false, "token 不匹配 ⇒ 不得删除新主人的租约");
    const after = JSON.parse(readLeaseRaw(leasePath));
    assert.equal(after.token, nRecord.token, "新主人租约必须原样保留");

    // 租约已消失：release 同样 no-op 且不抛错。
    rmSync(leasePath, { force: true });
    assert.equal(await hA.release(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1-06: 损坏租约有宽限窗——窗内不抢，超过 ~15s 后按损坏回收", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b1-06-"));
  try {
    const clock = makeClock();
    const lines = [];
    const b = makeGate(dir, "corrupt-waiter", { clock, lines });
    const leasePath = join(dir, VERIFICATION_LEASE_FILENAME);

    seedLease(leasePath, "{oops 这不是 JSON");
    const pB = b.gate.acquire();
    await new Promise((r) => setImmediate(r));

    await b.ctl.tick(5); // 宽限窗内（<15s）
    assert.equal(await isSettled(pB), false, "宽限窗内不得抢删损坏文件");
    assert.equal(readLeaseRaw(leasePath), "{oops 这不是 JSON", "损坏文件原样保留");

    const got = await tickUntilSettled(b.ctl, pB, 100);
    assert.ok(got, "宽限窗过后必须按损坏回收放行");
    const hB = await pB;
    const record = JSON.parse(readLeaseRaw(leasePath));
    assert.equal(record.token, hB.token, "回收后写入了完好租约");
    assert.ok(lines.some((l) => l.includes("corrupt")), "回收损坏文件须留日志");
    assert.ok(await hB.release());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1-07: 等待日志携带持有者身份且按 ~30s 节律重复（首条立即打）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b1-07-"));
  try {
    const clock = makeClock();
    const lines = [];
    const a = makeGate(dir, "rich-holder", {
      clock,
      lines,
      identity: { runId: "run_XYZ", sessionId: "sess_Q", agentId: "coder_low" },
    });
    const b = makeGate(dir, "logged-waiter", { clock, lines });

    assert.ok(await a.gate.acquire());
    const pB = b.gate.acquire();
    await new Promise((r) => setImmediate(r));

    await b.ctl.tick(40); // 推 40s：应至少有 首条 + 30s 节律第二条

    const waits = lines.filter((l) => l.includes("[logged-waiter]") && l.includes("waiting"));
    assert.ok(waits.length >= 2, `等待日志须≥2 条（首条+节律）: ${JSON.stringify(lines)}`);
    for (const line of waits) {
      assert.match(line, /run_XYZ/, "等待日志须含 runId");
      assert.match(line, /coder_low/, "等待日志须含 agentId");
      assert.match(line, /sess_Q/, "等待日志须含 sessionId");
      assert.match(line, /heartbeat|age/i, "等待日志须含持有者心跳/年龄信息");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1-08: 租约路径不可写 ⇒ fail-open：WARNING 进 sink、acquire 得 null、绝不抛错", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b1-08-"));
  try {
    const clock = makeClock();
    const lines = [];
    // 把一个【文件】当父目录用 ⇒ claim 的 open(wx) 必得 ENOTDIR/EACCES 类错误。
    const blocker = join(dir, "blocker-file");
    writeFileSync(blocker, "not a directory", "utf8");
    const gate = createVerificationGate({
      leasePath: join(blocker, "verification.lease"),
      now: clock.now,
      sleep: makeSleepControl(clock).sleep,
      sink: (line) => lines.push(line),
      identity: { owner: "doomed" },
    });

    let handle = Symbol("unset");
    await assert.doesNotReject(async () => {
      handle = await gate.acquire();
    }, "基础设施故障路径绝不允许 reject");
    assert.equal(handle, null, "不可写 ⇒ fail-open 返回 null（调用方无闸继续）");
    assert.ok(lines.some((l) => /fail-open|WARNING/i.test(l)),
      `fail-open 必须留 WARNING 日志: ${JSON.stringify(lines)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1-09: 心跳仍新鲜但 startedAt 超 45min 硬上限 ⇒ 判定弃置并接管（活着但挂死）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b1-09-"));
  try {
    const clock = makeClock();
    const lines = [];
    const a = makeGate(dir, "hung-a", { clock, lines });
    const b = makeGate(dir, "cap-taker", { clock, lines });

    assert.ok(await a.gate.acquire()); // startedAt = t0
    const pB = b.gate.acquire();
    await new Promise((r) => setImmediate(r));

    // 心跳一直跳（每轮 +30s），等待者穿插轮询（每轮 +3s）：
    // heartbeatAge 恒 <90s（永不成 stale），只有 MAX_HOLD 能触发接管。
    for (let round = 0; round < 40; round += 1) {
      await a.ctl.tick(1);
      await b.ctl.tick(3);
    }
    assert.equal(await isSettled(pB), false,
      "1320s < 45min：心跳新鲜 + 未超上限 ⇒ 不得接管");

    let settled = false;
    for (let round = 0; round < 120 && !settled; round += 1) {
      await a.ctl.tick(1); // +30s 心跳
      await b.ctl.tick(3); // +3s 轮询
      settled = await isSettled(pB);
    }
    assert.ok(settled, "超 45min 后即使心跳新鲜也必须放行接管");
    const hB = await pB;
    const record = JSON.parse(readLeaseRaw(join(dir, VERIFICATION_LEASE_FILENAME)));
    assert.equal(record.token, hB.token);
    assert.ok(lines.some((l) => /max-hold/i.test(l)),
      `接管日志须标注 max-hold 弃置原因: ${JSON.stringify(lines.slice(-5))}`);
    assert.ok(await hB.release());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1-10: 并发认领 EEXIST 二次确认——CAS 回收绝不误删竞态胜出的新主人租约", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b1-10-"));
  try {
    const clock = makeClock();
    const lines = [];
    const leasePath = join(dir, VERIFICATION_LEASE_FILENAME);

    // 预置一份心跳早已陈旧的 H 租约。
    const staleH = extRecord({
      owner: "stale-h",
      startedAt: clock.time - 600_000,
      heartbeatAt: clock.time - 200_000,
    });
    seedLease(leasePath, staleH);

    // 包装真实 fsOps：B 第一次读到 H 之后、"决定回收"之前，新主人 N 抢先
    // 重写了租约（模拟并发竞态）。B 的回收必须因内容 CAS 不匹配而放弃。
    const realFs = defaultLeaseFs(leasePath);
    let swapped = false;
    const freshN = extRecord({
      owner: "fresh-n",
      startedAt: clock.time,
      heartbeatAt: clock.time,
    });
    const bCtl = makeSleepControl(clock);
    const fsOps = {
      ...realFs,
      readRaw() {
        const raw = realFs.readRaw();
        if (!swapped && raw === JSON.stringify(staleH)) {
          swapped = true;
          realFs.overwrite(JSON.stringify(freshN)); // N 在 B 回收前抢先重建
        }
        return raw;
      },
    };

    const gate = createVerificationGate({
      leasePath,
      fsOps,
      now: clock.now,
      sleep: bCtl.sleep,
      sink: (line) => lines.push(line),
      identity: { owner: "cas-waiter" },
    });
    const pB = gate.acquire();
    await new Promise((r) => setImmediate(r));
    await bCtl.tick(3);

    assert.ok(swapped, "夹层注入必须生效");
    assert.equal(await isSettled(pB), false,
      "CAS 失配 ⇒ 放弃回收、继续等新主人");
    const after = JSON.parse(readLeaseRaw(leasePath));
    assert.equal(after.token, freshN.token, "新主人租约必须原样保留（防双取核心）");

    // 新主人正常退场后 B 才能上位。
    rmSync(leasePath, { force: true });
    const got = await tickUntilSettled(bCtl, pB, 50);
    assert.ok(got, "锁真正空出后 B 必须拿到闸");
    const hB = await pB;
    assert.ok(await hB.release());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1-11: 持有者发现租约被换 ⇒ 记 'lease lost'、停止续约、不删他人锁、不抛错", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b1-11-"));
  try {
    const clock = makeClock();
    const lines = [];
    const a = makeGate(dir, "unlucky-a", { clock, lines });
    const leasePath = join(dir, VERIFICATION_LEASE_FILENAME);

    const hA = await a.gate.acquire();

    // 外部接管：删除并写入新主人 N 的全新租约。
    const nRecord = extRecord({ owner: "new-n", startedAt: clock.time, heartbeatAt: clock.time });
    seedLease(leasePath, nRecord);

    await a.ctl.tick(1); // 推一次 A 的心跳 ⇒ 复核 token 失配
    assert.ok(lines.some((l) => l.includes("lease lost")),
      `必须记录 lease lost: ${JSON.stringify(lines)}`);
    assert.equal(hA.lost(), true, "handle 必须进入 lost 状态");
    assert.equal(JSON.parse(readLeaseRaw(leasePath)).token, nRecord.token,
      "绝不删除别人的租约");

    assert.equal(await hA.release(), false, "lost 句柄的释放是 no-op");
    assert.equal(JSON.parse(readLeaseRaw(leasePath)).token, nRecord.token);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1-12: 接管发生后旧持有者才醒来：心跳报 lost、release no-op、新主人租约无损", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b1-12-"));
  try {
    const clock = makeClock();
    const lines = [];
    const a = makeGate(dir, "old-a", { clock, lines });
    const b = makeGate(dir, "new-b", { clock, lines });

    const hA = await a.gate.acquire();
    const pB = b.gate.acquire();
    await new Promise((r) => setImmediate(r));

    // A 从此不再心跳；等待者独占推进假钟（每拍 +20s），~90s 时按陈旧回收。
    let settled = false;
    for (let round = 0; round < 150 && !settled; round += 1) {
      await b.ctl.tick(20); // 只推等待者侧，A 无心跳
      settled = await isSettled(pB);
    }
    assert.ok(settled, "陈旧租约必须被接管");
    const hB = await pB;
    const leasePath = join(dir, VERIFICATION_LEASE_FILENAME);
    assert.equal(JSON.parse(readLeaseRaw(leasePath)).token, hB.token);

    // 旧持有者此刻才醒来：心跳发现失配 → lost；释放 no-op。
    await a.ctl.tick(1);
    assert.ok(lines.filter((l) => l.includes("[old-a]")).some((l) => l.includes("lease lost")));
    assert.equal(hA.lost(), true);
    assert.equal(await hA.release(), false);
    assert.equal(JSON.parse(readLeaseRaw(leasePath)).token, hB.token,
      "新主人租约必须毫发无损");
    assert.ok(await hB.release());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B1-14: status 三态（free/held/corrupt）与 breakLock 玻璃破断语义", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b1-14-"));
  try {
    const clock = makeClock();
    const lines = [];
    const gate = createVerificationGate({
      leasePath: join(dir, VERIFICATION_LEASE_FILENAME),
      now: clock.now,
      sleep: makeSleepControl(clock).sleep,
      sink: (line) => lines.push(line),
      identity: { owner: "observer" },
    });
    const leasePath = join(dir, VERIFICATION_LEASE_FILENAME);

    // free
    assert.deepEqual(await gate.status(), { free: true });

    // held：holder 字段齐备，ageMs 反映心跳年龄
    seedLease(leasePath, extRecord({
      owner: "harness",
      runId: "run_R",
      sessionId: "sess_S",
      agentId: "coder_high",
      startedAt: clock.time - 120_000,
      heartbeatAt: clock.time - 5_000,
    }));
    const held = await gate.status();
    assert.equal(held.free, false);
    assert.equal(held.corrupt, undefined);
    assert.equal(held.holder.runId, "run_R");
    assert.equal(held.holder.sessionId, "sess_S");
    assert.equal(held.holder.agentId, "coder_high");
    assert.equal(held.holder.startedAt, clock.time - 120_000);
    assert.equal(held.holder.heartbeatAt, clock.time - 5_000);
    assert.equal(held.holder.ageMs, 5_000);

    // corrupt
    seedLease(leasePath, "}} garbage {{");
    const corrupt = await gate.status();
    assert.deepEqual(corrupt, { free: false, corrupt: true, holder: null });

    // breakLock：对现存（哪怕损坏）租约强制移除
    const broke = await gate.breakLock();
    assert.deepEqual(broke, { hadLock: true, released: true });
    assert.equal(readLeaseRaw(leasePath), null);
    assert.ok(lines.some((l) => /break-lock/i.test(l)));

    // breakLock：本就无锁
    assert.deepEqual(await gate.breakLock(), { hadLock: false, released: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
