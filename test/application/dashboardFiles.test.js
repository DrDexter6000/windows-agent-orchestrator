// test/application/dashboardFiles.test.js
//
// 第 145b 批（决定 0131 第 2 条）：状态目录里的实例记录、启动锁与实例日志。
//
//   - instance.json 先写临时文件再原子改名；读取按闭集形状校验，坏形状读作 null；
//   - launch.lock：wx 独占创建；他人持有时读回 {generation, deadline}；
//     过期接管 = 内容核对的移除（先读、对不上不碰文件；对得上才改名-读回-再核对），任何不符合
//     闭集形状的内容都是坏锁；启动器用完按自己的代际删自己的锁；真双进程用例钉"读到的
//     活记录/活锁不会因别人的收尾而短暂消失"；残余文件清理认名字形状、不递归、有上限；
//   - candidate-/result-/stop- 文件按代际读写；result 原因是闭集；
//   - instance.log 每代重写、256 KiB 上限、到顶写一行固定"日志已截断"后停止追加。
//
// 真实临时目录：无网络、无子进程。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync, utimesSync, renameSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import {
  removeLaunchLockIfGeneration,
  removeCandidateRecord,
  sweepStateDirLeftovers,
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

test("lock takeover (145b-fix2): ANY content that is not the closed lock shape is a bad lock and is taken — {}, [1], an extra key, a non-hex generation", async () => {
  const [dir, done] = tmpState();
  try {
    const badContents = [
      "{}",
      "[1]",
      JSON.stringify({ generation: "0123456789abcdef", deadline: 5, pid: 1 }), // 多一个键
      JSON.stringify({ generation: "not-hex-not-hex!", deadline: 5 }),            // generation 不是 16 位十六进制
      JSON.stringify({ generation: "0123456789abcdef", deadline: "soon" }),       // deadline 不是数
      JSON.stringify({ generation: "0123456789abcdef" }),                         // 少一个键
      "null",
      '"a string"',
    ];
    for (const content of badContents) {
      writeFileSync(lockFileName(dir), content);
      assert.equal(await takeOverStaleLock(dir, null), true, `a bad lock is taken: ${content.slice(0, 50)}`);
      assert.equal(await readLaunchLock(dir), null, "and it is gone");
      assert.equal(existsSync(lockFileName(dir)), false);
    }
    // 形状合法、代际不同的锁，哪怕调用方不知道代际（null），也一个字节都不动。
    await createLaunchLock(dir, "1111222233334444", 7000);
    assert.equal(await takeOverStaleLock(dir, null), false, "a well-formed lock is never taken with an unknown generation");
    assert.deepEqual(await readLaunchLock(dir), { generation: "1111222233334444", deadline: 7000 });
  } finally {
    done();
  }
});

test("lock release: a launcher deletes ONLY its own generation's lock", async () => {
  const [dir, done] = tmpState();
  try {
    await createLaunchLock(dir, "1111222233334444", 7000);
    assert.equal(await removeLaunchLockIfGeneration(dir, GEN), false, "another generation's lock stays");
    assert.deepEqual(await readLaunchLock(dir), { generation: "1111222233334444", deadline: 7000 });
    assert.equal(await removeLaunchLockIfGeneration(dir, "1111222233334444"), true, "own lock goes");
    assert.equal(existsSync(lockFileName(dir)), false);
    assert.equal(await removeLaunchLockIfGeneration(dir, GEN), false, "nothing to remove");
    assert.equal(readdirSync(dir).length, 0, "no residue");
  } finally {
    done();
  }
});

/**
 * 起一个真子进程，在 ms 毫秒内反复调用 dashboardFiles 的某个移除原语（参数 = 目录、一个代际）。
 * 与测试进程是两个真进程——文件系统上的时序不是同一进程里的异步交替。
 */
function hammer(dir, fnName, arg, ms) {
  const filesUrl = new URL("../../src/application/dashboardFiles.js", import.meta.url).href;
  const script = `
    import * as files from ${JSON.stringify(filesUrl)};
    const [dir, fnName, arg, ms] = process.argv.slice(1);
    const end = Date.now() + Number(ms);
    let calls = 0;
    while (Date.now() < end) { await files[fnName](dir, arg); calls += 1; }
    console.log(calls);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir, fnName, arg, String(ms)], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  let finished = false;
  const done = new Promise((resolve) => {
    child.once("exit", () => { finished = true; resolve(Number(out.trim()) || 0); });
    child.once("error", () => { finished = true; resolve(0); });
  });
  return { done, isFinished: () => finished, kill: () => { try { child.kill(); } catch { /* 已退出 */ } } };
}

test("REAL TWO PROCESSES: a takeover attempt with the WRONG generation never moves the lock — a third launcher cannot slip in", async () => {
  const [dir, done] = tmpState();
  const holder = "1111222233334444";
  const third = "5555666677778888";
  await createLaunchLock(dir, holder, 9_999_999);
  const other = hammer(dir, "takeOverStaleLock", GEN, 1500); // 预期代际 ≠ 持有者：什么都不该动
  try {
    let attempts = 0;
    let slipped = 0;
    while (!other.isFinished()) {
      const result = await createLaunchLock(dir, third, 9_999_999);
      attempts += 1;
      if (result.ok === true) { slipped += 1; break; }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(attempts > 20, `the race really ran (${attempts} attempts)`);
    assert.equal(slipped, 0, "the lock never vanished: no third launcher ever created one");
    assert.deepEqual(await readLaunchLock(dir), { generation: holder, deadline: 9_999_999 }, "the holder's lock is intact");
    assert.ok(await other.done > 20, "the other process really hammered");
  } finally {
    other.kill();
    await other.done;
    done();
  }
});

test("REAL TWO PROCESSES: an old generation removing 'its' record never makes the LIVE record vanish for a reader", async () => {
  const [dir, done] = tmpState();
  await publishInstanceRecord(dir, RECORD);
  const other = hammer(dir, "removeInstanceRecordIfGeneration", "9999888877776666", 1500); // 旧代的收尾
  try {
    let reads = 0;
    let absent = 0;
    let unreadable = 0;
    while (!other.isFinished()) {
      const read = await readInstanceRecordEx(dir);
      reads += 1;
      if (read.status === "absent") absent += 1;
      else if (read.status === "error") unreadable += 1;
      else assert.equal(read.record?.generation, GEN, "every read sees the live generation");
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(reads > 20, `the race really ran (${reads} reads)`);
    assert.equal(absent, 0, "the live record was never even momentarily absent (read first, touch only on a match)");
    assert.equal(unreadable, 0);
    assert.ok(await other.done > 20, "the other process really hammered");
    assert.equal((await readInstanceRecord(dir)).generation, GEN);
  } finally {
    other.kill();
    await other.done;
    done();
  }
});

test("candidate cleanup: the launcher removes the candidate it consumed — own generation only", async () => {
  const [dir, done] = tmpState();
  try {
    const candidate = { port: 1024, pid: 2, nonce: NONCE, processCreatedAt: 3, build: { readable: false, srcTree: null, dirty: null } };
    await writeCandidateRecord(dir, GEN, candidate);
    await writeCandidateRecord(dir, "1111222233334444", candidate);
    await removeCandidateRecord(dir, GEN);
    await removeCandidateRecord(dir, GEN); // 已不在：不抛
    assert.equal(await readCandidateRecord(dir, GEN), null);
    assert.deepEqual(await readCandidateRecord(dir, "1111222233334444"), candidate, "another generation's candidate stays");
  } finally {
    done();
  }
});

test("sweepStateDirLeftovers: only recognisable residue of OTHER generations goes; instance.log, codes\\, the live files and anything unrecognised stay", async () => {
  const [dir, done] = tmpState();
  try {
    const OLD = "aaaabbbbccccdddd";
    const OWN = "1111222233334444";
    const CUR = "9999888877776666";
    // 老文件不能靠回退 mtime 造（NTFS 上 utimes 会把 ctime 刷成现在，清理按 max(mtime, ctime) 算年龄）：
    // 改成把清理的"现在"往后拨两分钟，刚写的文件就都成了老文件；"很新"的文件把 mtime 定在清理的现在。
    const sweepNow = () => Date.now() + 120_000;
    const put = (name, { fresh = false, content = "x" } = {}) => {
      writeFileSync(join(dir, name), content);
      if (fresh) utimesSync(join(dir, name), new Date(sweepNow()), new Date(sweepNow()));
    };
    const removable = [
      `result-${OLD}.json`, `candidate-${OLD}.json`, `stop-${OLD}.request`,
      "instance.json.tmp-123-0123456789ab", `candidate-${OLD}.json.tmp-1-0123456789ab`, `result-${OLD}.json.tmp-1-0123456789ab`, `stop-${OLD}.request.tmp-1-0123456789ab`,
      "launch.lock.new-123-0123456789ab", "instance.json.rm-123-0123456789ab", "launch.lock.rm-123-0123456789ab",
    ];
    for (const name of removable) put(name);
    // 留下的：当前实例与自己这一代的文件、活文件、没有认得出形状的名字、还很新的瞬态名字。
    const kept = [
      "instance.json", "instance.log", "launch.lock",
      `result-${OWN}.json`, `candidate-${OWN}.json`, `stop-${OWN}.request`, `candidate-${OWN}.json.tmp-1-0123456789ab`,
      `result-${CUR}.json`, `candidate-${CUR}.json`, `stop-${CUR}.request`,
      "result-nothex.json", "notes.txt", "result-" + OLD + ".json.bak", "instance.json.tmp-xyz", "launch.lock.new-1",
    ];
    for (const name of kept) put(name);
    put("launch.lock.new-9-aabbccddeeff", { fresh: true }); // 刚建的瞬态文件：可能是别的启动器正在建锁
    kept.push("launch.lock.new-9-aabbccddeeff");
    mkdirSync(join(dir, "codes"));
    writeFileSync(join(dir, "codes", "a".repeat(64)), "x");
    mkdirSync(join(dir, `result-${OLD}.json.d`)); // 不递归：目录一律不碰
    mkdirSync(join(dir, `candidate-${"cccc".repeat(4)}.json`)); // 形状对但它是目录：不碰
    kept.push("codes", `result-${OLD}.json.d`, `candidate-${"cccc".repeat(4)}.json`);

    const removed = await sweepStateDirLeftovers(dir, { keepGenerations: [OWN, CUR], now: sweepNow });
    assert.equal(removed, removable.length, "exactly the recognisable residue");
    assert.deepEqual(readdirSync(dir).sort(), [...kept].sort(), "everything else is untouched");
    assert.ok(existsSync(join(dir, "codes", "a".repeat(64))), "codes\\ is never entered");

    // 条数有上限。
    for (let i = 0; i < 5; i += 1) put(`result-${(OLD.slice(0, 15) + i)}.json`);
    assert.equal(await sweepStateDirLeftovers(dir, { keepGenerations: [OWN, CUR], max: 3, now: sweepNow }), 3, "bounded by max");
    const left = readdirSync(dir).filter((n) => n.startsWith(`result-${OLD.slice(0, 15)}`) && n.endsWith(".json") && n.length === `result-${OLD}.json`.length);
    assert.equal(left.length, 2, "the rest waits for the next round");
  } finally {
    done();
  }
});

test("sweepStateDirLeftovers (145b-fix3): a *.rm-* staging file is protected by its CTIME — NTFS keeps the OLD mtime across a rename", async () => {
  const [dir, done] = tmpState();
  try {
    const record = join(dir, "instance.json");
    writeFileSync(record, JSON.stringify(RECORD));
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(record, hourAgo, hourAgo); // 一小时前写的记录
    const staging = join(dir, "instance.json.rm-123-0123456789ab");
    renameSync(record, staging); // 另一个进程的 removeFileWhen 正处在"改名 → 读回"之间
    assert.ok(Date.now() - statSync(staging).mtimeMs > 3_000_000, "precondition: the rename kept the old mtime");
    assert.equal(await sweepStateDirLeftovers(dir), 0, "an mtime-only age check would delete it; the ctime (set by the rename) protects it");
    assert.ok(existsSync(staging), "the staging file is still there for its owner to read back");
    assert.equal(await sweepStateDirLeftovers(dir, { now: () => Date.now() + 120_000 }), 1, "once the clock has really moved on it is residue like any other");
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
