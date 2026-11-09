// test/application/ownerLeaseWrite.test.js
//
// B91（TD-337/TD-345）：owner 心跳租约的写与释放（ownerLeaseWrite.js）。
//   - 写是原子替换（同目录临时文件再改名）：写后读回格式正确，无临时文件残留；
//   - 释放只删本进程的租约：别的 pid 不动、读不出的文件不动；
//   - createOwnerLeaseHolder：start 写租约、intervalMs 注入下续写推进
//     heartbeatAt、stop 释放；未 start 就 stop 是 no-op。
// 全部走真实文件（os.tmpdir() 下的临时目录），零真实子进程。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  writeOwnerHeartbeat,
  clearOwner,
  createOwnerLeaseHolder,
  OWNER_HEARTBEAT_INTERVAL_MS,
} from "../../src/application/ownerLeaseWrite.js";
import { ownerFilePath, readOwnerLease } from "../../src/application/ownerLiveness.js";

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

const RUN_ID = "run_olw_test";

test("OLW-00: 心跳间隔常量 2000 ms（runner 与验证持租约同一节拍）", () => {
  assert.equal(OWNER_HEARTBEAT_INTERVAL_MS, 2000);
});

test("OLW-01: 写是原子替换——写后读回 {pid, heartbeatAt} 格式正确，无临时文件残留", () => {
  const dir = tempDir("wao-olw-01-");
  try {
    writeOwnerHeartbeat(dir, RUN_ID);
    const raw = readFileSync(ownerFilePath(dir, RUN_ID), "utf8");
    const lease = JSON.parse(raw);
    assert.equal(lease.pid, process.pid, "租约记本进程 pid");
    assert.equal(typeof lease.heartbeatAt, "number");
    assert.ok(Number.isFinite(lease.heartbeatAt), "heartbeatAt 是有限数");
    // 原子替换的痕迹只允许落在目标文件上：同目录不残留 .wao-tmp-* 临时文件。
    const leftovers = readdirSync(dir).filter((name) => name.startsWith(".wao-tmp-"));
    assert.deepEqual(leftovers, [], "写完不残留临时文件");
    // 与读侧 SSOT 对得上：格式正确、心跳新鲜。
    const read = readOwnerLease(dir, RUN_ID, Date.now());
    assert.equal(read.present, true);
    assert.equal(read.wellFormed, true);
    assert.equal(read.fresh, true, "刚写的心跳按租约读法是新鲜的");
    // 重复写（续写路径）同样不残留、覆盖推进。
    writeOwnerHeartbeat(dir, RUN_ID);
    const second = JSON.parse(readFileSync(ownerFilePath(dir, RUN_ID), "utf8"));
    assert.ok(second.heartbeatAt >= lease.heartbeatAt);
    assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith(".wao-tmp-")), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("OLW-02: 释放只删本进程租约——别的 pid 不动、读不出（畸形）不动、本进程的删、不在即静默", () => {
  const dir = tempDir("wao-olw-02-");
  try {
    // 别的进程的租约：不动。
    const foreign = ownerFilePath(dir, "run_olw_foreign");
    writeFileSync(foreign, JSON.stringify({ pid: process.pid + 1_000_000, heartbeatAt: Date.now() }), "utf8");
    clearOwner(dir, "run_olw_foreign");
    assert.equal(existsSync(foreign), true, "别的 pid 的租约不删");
    // 读不出（非 JSON）：不动。
    const corrupt = ownerFilePath(dir, "run_olw_corrupt");
    writeFileSync(corrupt, "not-json{", "utf8");
    clearOwner(dir, "run_olw_corrupt");
    assert.equal(existsSync(corrupt), true, "读不出的文件不删");
    // 格式正确但 pid 不是本进程（缺 pid 字段）：不动。
    const malformed = ownerFilePath(dir, "run_olw_nopid");
    writeFileSync(malformed, JSON.stringify({ heartbeatAt: Date.now() }), "utf8");
    clearOwner(dir, "run_olw_nopid");
    assert.equal(existsSync(malformed), true, "格式不正确的租约不删");
    // 本进程的租约：删。
    writeOwnerHeartbeat(dir, RUN_ID);
    assert.equal(existsSync(ownerFilePath(dir, RUN_ID)), true);
    clearOwner(dir, RUN_ID);
    assert.equal(existsSync(ownerFilePath(dir, RUN_ID)), false, "本进程的租约被删");
    // 已不在：静默（不抛）。
    clearOwner(dir, RUN_ID);
    assert.equal(existsSync(ownerFilePath(dir, RUN_ID)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("OLW-03: createOwnerLeaseHolder——start 写租约、续写推进 heartbeatAt、stop 释放", async () => {
  const dir = tempDir("wao-olw-03-");
  try {
    const holder = createOwnerLeaseHolder({ runDir: dir, runId: RUN_ID, intervalMs: 25 });
    holder.start();
    assert.equal(existsSync(ownerFilePath(dir, RUN_ID)), true, "start 即写租约");
    const first = readOwnerLease(dir, RUN_ID, Date.now());
    assert.equal(first.fresh, true);
    assert.equal(first.pid, process.pid);
    // 续写：注入的短 interval 下，heartbeatAt 必须被定时器推进（首拍之外 ≥1 次）。
    await new Promise((resolve) => setTimeout(resolve, 120));
    const second = readOwnerLease(dir, RUN_ID, Date.now());
    assert.equal(second.present, true);
    assert.ok(second.heartbeatAt > first.heartbeatAt, "intervalMs 注入下租约被定时器续写");
    holder.stop();
    assert.equal(existsSync(ownerFilePath(dir, RUN_ID)), false, "stop 释放租约");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("OLW-04: 未 start 就 stop 是 no-op——不写也不删（没有租约可释放）", async () => {
  const dir = tempDir("wao-olw-04-");
  try {
    const holder = createOwnerLeaseHolder({ runDir: dir, runId: RUN_ID });
    holder.stop();
    assert.equal(existsSync(ownerFilePath(dir, RUN_ID)), false, "stop 前没有写过租约，目录里也没有租约");
    // start → stop → stop：二次 stop 同样安全。
    holder.start();
    holder.stop();
    holder.stop();
    assert.equal(existsSync(ownerFilePath(dir, RUN_ID)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
