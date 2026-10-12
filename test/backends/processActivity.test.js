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
