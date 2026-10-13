// test/backends/processActivity.test.js
//
// 进程树活跃度（决定 0067）的纯函数与取样缝：零真实 PowerShell、零真实进程。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseProcessTable,
  descendantsOf,
  snapshotDescendants,
  describeProcessActivity,
  fingerprintWorkingTree,
  PROCESS_ACTIVE_CPU_MS_PER_S,
  PROCESS_ACTIVE_IO_BYTES_PER_S,
} from "../../src/backends/processActivity.js";

// pid,ppid,cpu(100ns),io
const TABLE = [
  "0,0,999,0",
  "100,4,50000000,1000",   // 宿主
  "200,100,10000000,500",  // 子
  "300,200,20000000,700",  // 孙
  "400,4,90000000,9999",   // 无关进程
  "500,500,1,1",           // 自指（System Idle 形状）——不得进入遍历
  "garbage line",
  "600,100,abc,5",         // 坏行跳过
  "",
].join("\r\n");

test("parseProcessTable: 逐行解析，坏行与空行跳过", () => {
  const table = parseProcessTable(TABLE);
  assert.deepEqual([...table.keys()], [0, 100, 200, 300, 400, 500]);
  assert.deepEqual(table.get(200), { ppid: 100, cpu100ns: 10000000, ioBytes: 500 });
});

test("descendantsOf: 只取后代、不含宿主自身与无关进程；宿主不在表里 → null", () => {
  const table = parseProcessTable(TABLE);
  const found = descendantsOf(table, 100);
  assert.deepEqual([...found.keys()].sort(), [200, 300]);
  assert.deepEqual(found.get(300), { cpu100ns: 20000000, ioBytes: 700 });
  assert.equal(descendantsOf(table, 12345), null);
  assert.equal(descendantsOf(table, 400).size, 0, "没有后代 = 空集（不是 null）");
});

test("descendantsOf: 父子环不会死循环", () => {
  const table = parseProcessTable(["10,20,1,1", "20,10,1,1", "30,10,1,1"].join("\n"));
  assert.deepEqual([...descendantsOf(table, 10).keys()].sort(), [20, 30]);
});

test("snapshotDescendants: 不适用（非 Windows / 非法 pid）→ null；命令失败或结果里找不到宿主 → 抛错（瞬时，可重取）", async () => {
  const run = async () => TABLE;
  assert.equal(await snapshotDescendants(100, { run, platform: "linux" }), null);
  assert.equal(await snapshotDescendants(0, { run, platform: "win32" }), null);
  assert.equal(await snapshotDescendants(undefined, { run, platform: "win32" }), null);
  await assert.rejects(
    () => snapshotDescendants(100, { run: async () => { throw new Error("boom"); }, platform: "win32" }),
    /boom/,
  );
  // 宿主进程明明在跑（调用方正在轮询它）却不在表里 = 这次快照不可信，不是"不适用"
  await assert.rejects(() => snapshotDescendants(777, { run, platform: "win32" }), /host process not found/);
  await assert.rejects(() => snapshotDescendants(100, { run: async () => "", platform: "win32" }), /host process not found/);
  const ok = await snapshotDescendants(100, { run, platform: "win32" });
  assert.deepEqual([...ok.keys()].sort(), [200, 300]);
});

const snap = (rows) => new Map(rows.map(([pid, cpuMs, ioBytes]) => [pid, { cpu100ns: cpuMs * 10_000, ioBytes }]));

test("describeProcessActivity: 空闲基线不算活动，CPU / I/O / 进程生灭任一越线即算", () => {
  // 2026-10-12 真机探针的空闲读数量级：CPU 0-2.5ms/s、I/O 4.2-8.7KB/s、无生灭。
  const idleBefore = snap([[200, 1000, 100_000], [300, 2000, 200_000]]);
  const idleAfter = snap([[200, 1000, 230_000], [300, 2075, 330_000]]); // 30s：+75ms CPU、+260KB I/O
  const idle = describeProcessActivity(idleBefore, idleAfter, 30_000);
  assert.deepEqual(idle, { active: false, cpuMs: 75, ioBytes: 260_000, born: 0, exited: 0, windowMs: 30_000 });

  const cpuBusy = describeProcessActivity(idleBefore, snap([[200, 1000 + PROCESS_ACTIVE_CPU_MS_PER_S * 30, 100_000], [300, 2000, 200_000]]), 30_000);
  assert.equal(cpuBusy.active, true, "CPU 增量恰到阈值即算活动");

  const ioBusy = describeProcessActivity(idleBefore, snap([[200, 1000, 100_000 + PROCESS_ACTIVE_IO_BYTES_PER_S * 30], [300, 2000, 200_000]]), 30_000);
  assert.equal(ioBusy.active, true, "I/O 增量恰到阈值即算活动");

  const born = describeProcessActivity(idleBefore, snap([[200, 1000, 100_000], [300, 2000, 200_000], [301, 0, 0]]), 30_000);
  assert.deepEqual([born.active, born.born, born.exited], [true, 1, 0], "新生进程即活动");

  const exited = describeProcessActivity(idleBefore, snap([[200, 1000, 100_000]]), 30_000);
  assert.deepEqual([exited.active, exited.born, exited.exited], [true, 0, 1], "进程退出即变化");
});

test("describeProcessActivity: 累计读数回退 = 该 pid 换了进程——计一次退出加一次新生，不产生负增量", () => {
  const a = describeProcessActivity(snap([[200, 5000, 900_000]]), snap([[200, 10, 10]]), 30_000);
  assert.deepEqual(a, { active: true, cpuMs: 10, ioBytes: 10, born: 1, exited: 1, windowMs: 30_000 });
});

test("fingerprintWorkingTree: 清单、mtime、大小任一变化即指纹不同；列不出清单 → null", async () => {
  const stats = { "a.txt": { mtimeMs: 1000, size: 10 }, "new.txt": { mtimeMs: 2000, size: 5 } };
  const statFile = async (full) => {
    const rel = full.replace(/\\/g, "/").split("/").pop();
    if (!stats[rel]) throw new Error("ENOENT");
    return stats[rel];
  };
  const listing = (...names) => async () => names.map((n) => `${n}\0`).join("");
  const print = (names) => fingerprintWorkingTree("X:/tree", { listChanged: listing(...names), statFile });

  const base = await print(["a.txt"]);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(await print(["a.txt"]), base, "没有变化 = 指纹相同");
  stats["a.txt"] = { mtimeMs: 1500, size: 10 };
  const touched = await print(["a.txt"]);
  assert.notEqual(touched, base, "同一文件被重写（mtime 变）");
  stats["a.txt"] = { mtimeMs: 1500, size: 11 };
  assert.notEqual(await print(["a.txt"]), touched, "大小变");
  assert.notEqual(await print(["a.txt", "new.txt"]), await print(["a.txt"]), "多了一个未跟踪文件");
  assert.match(await print(["gone.txt"]), /^[0-9a-f]{64}$/, "清单里的文件 stat 不到不抛错");

  assert.equal(await fingerprintWorkingTree("X:/tree", { listChanged: async () => { throw new Error("not a git repository"); }, statFile }), null);
  assert.equal(await fingerprintWorkingTree("", { listChanged: listing("a.txt"), statFile }), null);
  assert.equal(await fingerprintWorkingTree(undefined, { listChanged: listing("a.txt"), statFile }), null);
});

// ===== 决定 0070：静默期取样器（只供观察） =====

test("createQuietSampler: 静默满 quietMs 才取基线，窗口满再比对；CPU 在涨落 process_active，指纹变了落 files_changed", async () => {
  const { createQuietSampler } = await import("../../src/backends/processActivity.js");
  let clock = 0;
  let cpu = 0;
  let print = "fp-0";
  let probes = 0;
  const sampler = createQuietSampler({
    rootPid: 4321,
    cwd: "/work",
    processProbe: async () => { probes += 1; return snap([[5001, cpu, 0]]); },
    deliverableProbe: async () => print,
    now: () => clock,
    quietMs: 300_000,
    windowMs: 30_000,
  });
  assert.equal(sampler.nextWakeMs(), 300_000);
  clock = 299_000;
  assert.deepEqual(await sampler.poll(), [], "没到静默门限，不取样");
  assert.equal(probes, 0);
  clock = 300_000;
  assert.deepEqual(await sampler.poll(), [], "取基线这一拍不出事实");
  assert.equal(probes, 1);
  assert.equal(sampler.nextWakeMs(), 30_000);
  clock = 315_000;
  assert.deepEqual(await sampler.poll(), [], "窗口没满");
  assert.equal(probes, 1);
  // 窗口满：CPU +5000ms / 30s，指纹不变 → 只有 process_active。
  cpu = 5000;
  clock = 330_000;
  assert.deepEqual(await sampler.poll(), ["process_active"]);
  // 下一轮从现在起再等 quietMs。
  assert.equal(sampler.nextWakeMs(), 300_000);
  clock = 630_000;
  await sampler.poll();
  print = "fp-1";
  clock = 660_000;
  assert.deepEqual(await sampler.poll(), ["files_changed"], "进程没动（累计读数不变），文件变了");
  // 两项都动。
  clock = 960_000;
  await sampler.poll();
  cpu = 9000;
  print = "fp-2";
  clock = 990_000;
  assert.deepEqual(await sampler.poll(), ["process_active", "files_changed"]);
});

test("createQuietSampler: worker 落了事件 → 静默重新起算，取到一半的基线作废", async () => {
  const { createQuietSampler } = await import("../../src/backends/processActivity.js");
  let clock = 0;
  let cpu = 0;
  const sampler = createQuietSampler({
    rootPid: 4321, cwd: "/work",
    processProbe: async () => snap([[5001, cpu, 0]]),
    deliverableProbe: async () => null,
    now: () => clock, quietMs: 300_000, windowMs: 30_000,
  });
  clock = 300_000;
  await sampler.poll();
  clock = 310_000;
  sampler.noteEvent();
  cpu = 99_000;
  clock = 330_000;
  assert.deepEqual(await sampler.poll(), [], "基线已作废——不拿事件之前的读数比对");
  assert.equal(sampler.nextWakeMs(), 280_000, "从事件时刻起再等 quietMs");
});

test("createQuietSampler: 探针抛错 / 不适用 → 这一轮不出事实，下一个周期再试，绝不抛出", async () => {
  const { createQuietSampler } = await import("../../src/backends/processActivity.js");
  let clock = 0;
  let mode = "throw";
  let cpu = 0;
  const sampler = createQuietSampler({
    rootPid: 4321, cwd: "/work",
    processProbe: async () => {
      if (mode === "throw") throw new Error("snapshot failed");
      return snap([[5001, cpu, 0]]);
    },
    deliverableProbe: async () => null,
    now: () => clock, quietMs: 300_000, windowMs: 30_000,
  });
  clock = 300_000;
  assert.deepEqual(await sampler.poll(), [], "两项都取不到");
  assert.equal(sampler.nextWakeMs(), 300_000, "等下一个周期，不空转");
  mode = "ok";
  clock = 600_000;
  await sampler.poll();
  mode = "throw";
  clock = 630_000;
  assert.deepEqual(await sampler.poll(), [], "比对时取不到 → 这一轮没有读数");
  mode = "ok";
  clock = 930_000;
  await sampler.poll();
  cpu = 5000;
  clock = 960_000;
  assert.deepEqual(await sampler.poll(), ["process_active"], "之后恢复正常");
});
