// test/application/dashboardFiles.test.js
//
// 第 145b 批（决定 0131 第 2 条）：状态目录里的实例记录、启动锁与实例日志。
//
//   - instance.json 先写临时文件再原子改名；读取按闭集形状校验，坏形状读作 null；
//   - launch.lock：wx 独占创建；他人持有时读回 {generation, deadline}；
//     过期接管是"原子改名到 launch.lock.stale-<旧代际>"，两个接管者只有一个赢家；
//   - candidate-/result-/stop- 文件按代际读写；result 原因是闭集；
//   - instance.log 每代重写、256 KiB 上限、到顶写一行固定"日志已截断"后停止追加。
//
// 真实临时目录：无网络、无子进程。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DASHBOARD_RESULT_REASONS,
  readInstanceRecordEx,
  readInstanceRecord,
  publishInstanceRecord,
  writeCandidateRecord,
  readCandidateRecord,
  readResultRecord,
  writeResultRecord,
  removeResultRecord,
  removeOwnGenerationFiles,
  writeStopRequest,
  readStopRequest,
  createLaunchLock,
  readLaunchLock,
  takeOverStaleLock,
  removeInstanceRecordIfGeneration,
  createInstanceLogger,
  instanceFileName,
  lockFileName,
} from "../../src/application/dashboardFiles.js";

const GEN = "0123456789abcdef";
const NONCE = "ab".repeat(16);
const RECORD = Object.freeze({
  protocol: 1,
  runDir: "d:/proj/runs",
  pid: 4242,
  processCreatedAt: 1_700_000_000_000,
  port: 8123,
  nonce: NONCE,
  generation: GEN,
  build: { readable: true, srcTree: "f".repeat(40), dirty: false },
});

function tmpState() {
  const dir = mkdtempSync(join(tmpdir(), "wao-dash-files-"));
  return [dir, () => rmSync(dir, { recursive: true, force: true })];
}

test("instance.json: publish is atomic (tmp + rename) and round-trips through the validator", async () => {
  const [dir, done] = tmpState();
  try {
    await publishInstanceRecord(dir, RECORD);
    assert.deepEqual(await readInstanceRecord(dir), RECORD);
    const leftovers = readdirSync(dir).filter((n) => n.startsWith("instance.json.tmp"));
    assert.equal(leftovers.length, 0, "no tmp residue");
  } finally {
    done();
  }
});

test("instance.json: missing file and malformed shapes read as null (never a guess)", async () => {
  const [dir, done] = tmpState();
  try {
    assert.equal(await readInstanceRecord(dir), null, "no file yet");
    for (const bad of [
      { ...RECORD, protocol: "1" },                     // protocol must be a positive integer
      { ...RECORD, pid: 0 },                            // pid must be positive
      { ...RECORD, port: 70000 },                       // port out of range
      { ...RECORD, nonce: "nothex" },                   // nonce must be 32 lowercase hex
      { ...RECORD, generation: "XYZ" },                 // generation must be 16 lowercase hex
      { ...RECORD, runDir: 5 },                         // runDir must be a string
      { ...RECORD, processCreatedAt: "when" },          // creation time must be a finite number
      { ...RECORD, build: { readable: "yes" } },        // build must be readable/srcTree/dirty shaped
      { ...RECORD, extra: true },                       // unknown key -> rejected (closed set)
      {},                                                // empty
    ]) {
      writeFileSync(instanceFileName(dir), JSON.stringify(bad));
      assert.equal(await readInstanceRecord(dir), null, `malformed record reads as null: ${JSON.stringify(bad).slice(0, 60)}`);
    }
    writeFileSync(instanceFileName(dir), "{not json");
    assert.equal(await readInstanceRecord(dir), null, "corrupt JSON reads as null");
  } finally {
    done();
  }
});

test("instance.json read: absent / unreadable / present are three different answers", async () => {
  const [dir, done] = tmpState();
  try {
    assert.deepEqual(await readInstanceRecordEx(dir), { status: "absent" }, "no file");
    // 读得出文件但内容坏：present + null record。
    writeFileSync(instanceFileName(dir), "{oops");
    let read = await readInstanceRecordEx(dir);
    assert.equal(read.status, "present");
    assert.equal(read.raw, null);
    assert.equal(read.record, null);
    // 形状不对但 JSON 合法：present，raw 保留（调用方要先取 pid 判活性）。
    writeFileSync(instanceFileName(dir), JSON.stringify({ pid: 42, processCreatedAt: 1, protocol: 2 }));
    read = await readInstanceRecordEx(dir);
    assert.equal(read.status, "present");
    assert.equal(read.raw.pid, 42, "raw keeps the partial facts");
    assert.equal(read.record, null, "the closed-set record is null");
    // 完整记录：record 即 raw。
    await publishInstanceRecord(dir, RECORD);
    read = await readInstanceRecordEx(dir);
    assert.equal(read.status, "present");
    assert.deepEqual(read.record, RECORD);
  } finally {
    done();
  }
});

test("cleanup: the launcher deletes the result it read; the instance deletes its own candidate and stop request by generation", async () => {
  const [dir, done] = tmpState();
  try {
    await writeResultRecord(dir, GEN, "port_in_use");
    assert.deepEqual(await readResultRecord(dir, GEN), { reason: "port_in_use" });
    await removeResultRecord(dir, GEN);
    assert.equal(await readResultRecord(dir, GEN), null, "read-once: the launcher cleans up");
    // 别的代际的 result 不动。
    await writeResultRecord(dir, "1111222233334444", "serve_error");
    await removeResultRecord(dir, GEN);
    assert.deepEqual(await readResultRecord(dir, "1111222233334444"), { reason: "serve_error" });

    await writeCandidateRecord(dir, GEN, { port: 1, pid: 2, nonce: NONCE, processCreatedAt: 3, build: { readable: false, srcTree: null, dirty: null } });
    await writeStopRequest(dir, GEN, NONCE);
    await writeStopRequest(dir, "1111222233334444", NONCE);
    await removeOwnGenerationFiles(dir, GEN);
    assert.equal(await readCandidateRecord(dir, GEN), null, "own candidate removed");
    assert.equal(await readStopRequest(dir, GEN), null, "own stop request removed");
    assert.equal(await readStopRequest(dir, "1111222233334444"), NONCE, "another generation's stop request survives");
  } finally {
    done();
  }
});

test("candidate/result/stop: per-generation files, closed result reasons, stop carries the nonce", async () => {
  const [dir, done] = tmpState();
  try {
    assert.equal(await readCandidateRecord(dir, GEN), null);
    assert.equal(await readResultRecord(dir, GEN), null);
    assert.equal(await readStopRequest(dir, GEN), null);

    const candidate = { port: 9001, pid: 99, nonce: NONCE, processCreatedAt: 1234567890123, build: { readable: true, srcTree: "f".repeat(40), dirty: false } };
    await writeCandidateRecord(dir, GEN, candidate);
    assert.deepEqual(await readCandidateRecord(dir, GEN), candidate);
    writeFileSync(join(dir, `candidate-${GEN}.json`), JSON.stringify({ ...candidate, build: "nope" }));
    assert.equal(await readCandidateRecord(dir, GEN), null, "a malformed build key rejects the whole shape (closed set)");
    assert.equal(await readCandidateRecord(dir, "ffffffffffffffff"), null, "another generation sees nothing");

    for (const reason of DASHBOARD_RESULT_REASONS) {
      await writeResultRecord(dir, "aaaabbbbccccdddd", reason);
      assert.deepEqual(await readResultRecord(dir, "aaaabbbbccccdddd"), { reason });
    }
    await assert.rejects(() => writeResultRecord(dir, "aaaabbbbccccdddd", "not_a_reason"), /reason/, "closed set enforced");
    await writeStopRequest(dir, GEN, NONCE);
    assert.equal(await readStopRequest(dir, GEN), NONCE);
  } finally {
    done();
  }
});

test("lock: wx creation is exclusive; the loser reads the holder's {generation, deadline}", async () => {
  const [dir, done] = tmpState();
  try {
    const first = await createLaunchLock(dir, GEN, 1000);
    assert.deepEqual(first, { ok: true });
    const second = await createLaunchLock(dir, "1111222233334444", 2000);
    assert.equal(second.ok, false);
    assert.deepEqual(second.lock, { generation: GEN, deadline: 1000 });
    assert.deepEqual(await readLaunchLock(dir), { generation: GEN, deadline: 1000 });
    // A corrupt lock file reads as null (unknown shape -> the caller may take over).
    writeFileSync(lockFileName(dir), "{oops");
    assert.equal(await readLaunchLock(dir), null);
  } finally {
    done();
  }
});

test("lock takeover: content is verified — a NEW generation's lock is restored untouched; a corrupt lock is taken; the staging name is cleaned", async () => {
  const [dir, done] = tmpState();
  try {
    // 别人的新锁（有效形状、不同代际）：接管失败，锁原样还在，staging 清干净。
    await createLaunchLock(dir, "1111222233334444", 5000);
    assert.equal(await takeOverStaleLock(dir, GEN), false, "the lock belongs to ANOTHER generation");
    assert.deepEqual(await readLaunchLock(dir), { generation: "1111222233334444", deadline: 5000 }, "restored byte-for-byte");
    assert.equal(readdirSync(dir).filter((n) => n.includes(".rm-")).length, 0, "no staging residue");
    // 预期的旧代际：接管成功，锁消失（staging 已删，不再留 stale-* 名）。
    assert.equal(await takeOverStaleLock(dir, "1111222233334444"), true);
    assert.equal(await readLaunchLock(dir), null);
    assert.equal(readdirSync(dir).filter((n) => n.startsWith("launch.lock")).length, 0, "no lock-family residue at all");
    // 坏形状的锁：仍可接管（读回来仍是坏形状才算数）。
    writeFileSync(lockFileName(dir), "{not json");
    assert.equal(await takeOverStaleLock(dir, GEN), true, "a corrupt lock is takeable");
    // 赢家可以另建自己的锁。
    assert.deepEqual(await createLaunchLock(dir, GEN, 3000), { ok: true });
  } finally {
    done();
  }
});

test("removeInstanceRecordIfGeneration: the OLD generation removes only its own record — a record swapped to a new generation survives", async () => {
  const [dir, done] = tmpState();
  try {
    await publishInstanceRecord(dir, RECORD);
    // 记录已被换成别的代际：删除失败，新记录原样保留。
    await publishInstanceRecord(dir, { ...RECORD, generation: "9999888877776666", nonce: "cd".repeat(16) });
    assert.equal(await removeInstanceRecordIfGeneration(dir, GEN), false);
    const kept = await readInstanceRecord(dir);
    assert.equal(kept.generation, "9999888877776666", "the NEW generation's record is untouched");
    // 自己的代际：删除成功。
    assert.equal(await removeInstanceRecordIfGeneration(dir, "9999888877776666"), true);
    assert.equal(await readInstanceRecord(dir), null);
  } finally {
    done();
  }
});

test("instance log: rewritten each generation, capped, one fixed truncation line, then silence", () => {
  const [dir, done] = tmpState();
  try {
    const file = join(dir, "instance.log");
    writeFileSync(file, "old generation content that must disappear\n");
    let tick = 0;
    const logger = createInstanceLogger(file, { maxBytes: 120, now: () => 1_700_000_000_000 + tick });
    assert.equal(readFileSync(file, "utf8"), "", "a new generation rewrites (truncates) the log");
    for (tick = 0; tick < 40; tick += 1) logger.line(`generation event number ${tick}`);
    const text = readFileSync(file, "utf8");
    assert.ok(Buffer.byteLength(text) <= 120, `never beyond the cap (${Buffer.byteLength(text)} bytes)`);
    assert.ok(text.includes("日志已截断"), "the fixed truncation line is present");
    const sizeAtCap = Buffer.byteLength(text);
    logger.line("one more line after the cap");
    assert.equal(Buffer.byteLength(readFileSync(file, "utf8")), sizeAtCap, "nothing is appended after the marker");
    const written = text.split("\n").filter((l) => l.includes("generation event")).length;
    assert.ok(written < 40, `the cap dropped some lines (${written} of 40 kept)`);
    // Every written line carries the injected timestamp prefix.
    assert.match(text.split("\n").find((l) => l.length > 0), /^\[.*\]/, "lines are timestamp-prefixed");
  } finally {
    done();
  }
});
