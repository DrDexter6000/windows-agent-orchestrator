// test/application/dashboardControl.test.js
//
// 第 145b 批（修正一改定）：`wao dashboard` 的拉起/复用/停机状态机。
//
// 两层：
//   - 纯注入 io（快照、五查、三态、文案）——probe/health/spawn 假件，判定逻辑全查；
//   - 真文件时序（修正一 #5 要求"真并发、真实文件，不能用比真实实现更强的假件"）——
//     锁/发布/清理走真实的 dashboardFiles 实现（原子建锁、内容核对的接管、按代际删除），
//     只有进程/端口/健康探测与 WMI 是假件（它们不是被测时序）。
// 真实端到端（真 WMI）在 ownerDashboardE2e.test.js。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  launchDashboard,
  dashboardStatus,
  dashboardStop,
  dashboardRestart,
  buildServeCommandLine,
  DASHBOARD_CONTROL_ERRORS,
  dashboardControlErrorText,
} from "../../src/application/dashboardControl.js";
import { normalizeRunDir, stateDirFor } from "../../src/application/dashboardPaths.js";
import {
  readInstanceRecordEx, publishInstanceRecord, readCandidateRecord, readResultRecord, removeResultRecord,
  createLaunchLock, readLaunchLock, takeOverStaleLock, writeStopRequest, codesDirOf, lockFileName,
} from "../../src/application/dashboardFiles.js";

const RUN_DIR = "d:/proj/runs";
const STATE_ROOT = "c:/state";
const GEN_A = "aaaaaaaaaaaaaaaa";
const NONCE = "ab".repeat(16);
const TREE = "f".repeat(40);
const BUILD = { readable: true, srcTree: TREE, dirty: false };

function instanceRecord(overrides = {}) {
  return {
    protocol: 1, runDir: RUN_DIR, pid: 4242, processCreatedAt: 1_700_000_000_000,
    port: 8123, nonce: NONCE, generation: GEN_A, build: BUILD, ...overrides,
  };
}

/**
 * 一个可控的世界（纯注入 io）：所有事实都是闭包里的可变状态，时钟随 sleep 前进。
 * 默认长着一个"完美可复用"的实例；各用例按需改写。readInstanceEx 是三态读取。
 */
function makeWorld(overrides = {}) {
  const w = {
    now: 1_000_000,
    spawned: [],
    published: 0,
    resultsRemoved: 0,
    codes: [],
    readStatus: "present", // absent | error | present
    recordOverride: undefined, // 让 fake 能表达"raw 活着但闭集形状不合"
    candidate: null,
    result: null,
    lock: null,
    stopRequests: [],
    identity: { 4242: "same" },
    listeners: { 8123: [4242] },
    healthByPort: { 8123: { ok: true, nonce: NONCE } },
    spawnOk: true,
    buildNow: BUILD,
    spawnDelayMs: 0,
    onSpawn: null,
    ...overrides,
  };
  const io = {
    now: () => w.now,
    sleep: async (ms) => { w.now += ms; },
    ensureStateDir: async () => ({ ok: true }),
    verifyStateDir: async () => ({ ok: true }),
    readInstanceEx: async () => {
      if (w.readStatus === "absent") return { status: "absent" };
      if (w.readStatus === "error") return { status: "error" };
      const inst = w.instance ?? null;
      if (inst === null) return { status: "present", raw: null, record: null };
      return { status: "present", raw: inst, record: w.recordOverride === undefined ? inst : w.recordOverride };
    },
    publishInstance: async () => { w.published += 1; },
    readCandidate: async () => w.candidate ?? null,
    readResult: async () => w.result ?? null,
    removeResult: async () => { w.resultsRemoved += 1; w.result = null; },
    createLock: async (dir, generation, deadline) => {
      if (w.lock === null) { w.lock = { generation, deadline }; return { ok: true }; }
      return { ok: false, lock: w.lock };
    },
    readLock: async () => w.lock ?? null,
    takeOverStale: async (dir, expectedGeneration) => {
      if (w.lock !== null && w.lock.generation === expectedGeneration) { w.lock = null; return true; }
      return false;
    },
    writeStopRequest: async (dir, generation, nonce) => { w.stopRequests.push({ generation, nonce }); },
    probeIdentity: async (pid) => w.identity[pid] ?? "gone",
    listenerPids: async (port) => w.listeners[port] ?? [],
    health: async (port) => w.healthByPort[port] ?? { ok: false },
    spawnServe: async ({ generation, deadline }) => {
      w.spawned.push({ generation, deadline });
      if (w.onSpawn !== null) await w.onSpawn(generation);
      if (!w.spawnOk) return { ok: false, detail: "WMI ReturnValue=8" };
      w.candidate ??= { port: 9001, pid: 777, nonce: NONCE, processCreatedAt: 1_700_000_001_000, build: BUILD };
      w.identity[777] = "same";
      w.listeners[9001] = [777];
      w.healthByPort[9001] = { ok: true, nonce: NONCE };
      return { ok: true, pid: 777 };
    },
    issueCode: async () => {
      const code = `c${w.codes.length}${"0".repeat(61)}`;
      w.codes.push(code);
      return { code };
    },
    buildSnapshot: async () => w.buildNow,
  };
  return { w, io };
}

const launched = (world) => world.published === 1 && world.spawned.length === 1;

// ===== 复用（三态 + 先判活） =====

test("reuse: every check passes -> reused, no spawn, a code is issued, build note same", async () => {
  const { w, io } = makeWorld({ instance: instanceRecord() });
  const out = await launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io });
  assert.equal(out.outcome, "reused");
  assert.equal(out.port, 8123);
  assert.equal(out.code, w.codes[0]);
  assert.equal(out.buildNote, "same");
  assert.equal(w.spawned.length, 0);
  assert.equal(w.published, 0);
});

test("reuse (145b-fix): a LIVE instance with a foreign protocol refuses (restart hint, no code)", async () => {
  const { w, io } = makeWorld({ instance: instanceRecord({ protocol: 2 }) });
  await assert.rejects(
    () => launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io }),
    (error) => {
      assert.equal(error.code, "protocol_incompatible");
      assert.match(error.message, /restart/);
      return true;
    },
  );
  assert.equal(w.codes.length, 0, "no code issued");
});

test("reuse (145b-fix): a DEAD record with a foreign protocol is stale — both launch and restart may replace it", async () => {
  const dead = makeWorld({ instance: instanceRecord({ protocol: 2 }), identity: {} }); // pid 4242 不在
  const out = await launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io: dead.io });
  assert.equal(out.outcome, "launched", "a dead protocol-2 record does not wedge the command forever");
  assert.ok(launched(dead.w));
  const dead2 = makeWorld({ instance: instanceRecord({ protocol: 2 }), identity: {} });
  const restarted = await dashboardRestart({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io: dead2.io });
  assert.equal(restarted.outcome, "launched", "restart flows through stop(no_instance) into a fresh launch");
});

test("reuse (145b-fix): an UNREADABLE record is instance_unresponsive — never treated as an empty dir", async () => {
  const { w, io } = makeWorld({ readStatus: "error" });
  await assert.rejects(
    () => launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io }),
    (error) => error.code === "instance_unresponsive",
  );
  assert.equal(w.spawned.length, 0, "no launch on an unreadable record");
});

test("reuse (145b-fix): a LIVE record whose shape is not the closed set is unresponsive, not launchable", async () => {
  const { io } = makeWorld({ instance: { ...instanceRecord(), extra: 1 }, recordOverride: null, identity: { 4242: "same" } });
  await assert.rejects(
    () => launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io }),
    (error) => error.code === "instance_unresponsive",
  );
});

test("reuse: an explicit --port that differs from the record is a fixed error", async () => {
  const { io } = makeWorld({ instance: instanceRecord() });
  await assert.rejects(
    () => launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, port: 9999, io }),
    (error) => error.code === "port_conflict",
  );
});

test("reuse: pid/port fine but /health silent -> instance_unresponsive, never a second instance", async () => {
  const { w, io } = makeWorld({ instance: instanceRecord(), healthByPort: { 8123: { ok: false } } });
  await assert.rejects(
    () => launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io }),
    (error) => {
      assert.equal(error.code, "instance_unresponsive");
      assert.match(error.message, /restart/);
      return true;
    },
  );
  assert.equal(w.spawned.length, 0);
});

test("reuse: a nonce mismatch on /health is unresponsive too", async () => {
  const { io } = makeWorld({ instance: instanceRecord(), healthByPort: { 8123: { ok: true, nonce: "cd".repeat(16) } } });
  await assert.rejects(
    () => launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io }),
    (error) => error.code === "instance_unresponsive",
  );
});

test("reuse: a dead pid (or a port owned by someone else) means the record is stale -> launch", async () => {
  const dead = makeWorld({ instance: instanceRecord(), identity: {} });
  assert.equal((await launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io: dead.io })).outcome, "launched");
  assert.ok(launched(dead.w));

  const hijacked = makeWorld({ instance: instanceRecord(), listeners: { 8123: [1337] } });
  assert.equal((await launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io: hijacked.io })).outcome, "launched");
});

test("reuse: build notes — different tree warns, dirty/unknown stays unknown", async () => {
  const diff = makeWorld({ instance: instanceRecord(), buildNow: { readable: true, srcTree: "e".repeat(40), dirty: false } });
  assert.equal((await launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io: diff.io })).buildNote, "different");
  const dirty = makeWorld({ instance: instanceRecord(), buildNow: { readable: true, srcTree: TREE, dirty: true } });
  assert.equal((await launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io: dirty.io })).buildNote, "unknown");
});

// ===== 命令行纯函数（修正一 #2） =====

test("buildServeCommandLine: paths are quoted; spaces survive; a double quote refuses (path_quote)", () => {
  const base = { nodePath: "C:/Program Files/node/node.exe", cliJsPath: "D:/wao/src/cli.js", generation: "0123456789abcdef", deadline: 123456 };
  const ok = buildServeCommandLine({ ...base, runDir: "D:/my runs/data", stateRoot: "C:/Users/Some One/AppData/Local/wao/dashboard", port: 8080 });
  assert.equal(ok.ok, true);
  assert.equal(
    ok.commandLine,
    '"C:/Program Files/node/node.exe" "D:/wao/src/cli.js" dashboard serve '
    + '--run-dir "D:/my runs/data" --state-root "C:/Users/Some One/AppData/Local/wao/dashboard" '
    + '--generation 0123456789abcdef --deadline 123456 --port 8080',
  );
  const noPort = buildServeCommandLine({ ...base, runDir: "D:/r", stateRoot: "C:/s" });
  assert.ok(!noPort.commandLine.includes("--port"), "no --port when none given");
  for (const bad of [
    { ...base, runDir: 'D:/evil"quote' },
    { ...base, stateRoot: 'C:/evil"quote' },
    { ...base, nodePath: 'x"' },
    { ...base, cliJsPath: "" },
  ]) {
    const refused = buildServeCommandLine(bad);
    assert.deepEqual([refused.ok, refused.reason], [false, "path_quote"], JSON.stringify(bad));
  }
});

// ===== 拉起 =====

test("launch: candidate verified then published with the CANDIDATE's build; buildNote is computed, never hardcoded", async () => {
  const { w, io } = makeWorld();
  w.candidate = { port: 9001, pid: 777, nonce: NONCE, processCreatedAt: 1_700_000_001_000, build: { readable: true, srcTree: "e".repeat(40), dirty: false } };
  w.identity[777] = "same";
  w.listeners[9001] = [777];
  w.healthByPort[9001] = { ok: true, nonce: NONCE };
  const out = await launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io });
  assert.equal(out.outcome, "launched");
  assert.equal(out.port, 9001);
  assert.equal(out.buildNote, "different", "the child-reported build is compared against the parent's snapshot");
  assert.equal(w.resultsRemoved, 0);
});

test("launch: a failed WMI create is wmi_create_failed", async () => {
  const { io } = makeWorld({ spawnOk: false });
  await assert.rejects(
    () => launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io }),
    (error) => error.code === "wmi_create_failed",
  );
});

test("launch: the child's port_in_use result is reported verbatim and the result file is REMOVED after reading", async () => {
  const { w, io } = makeWorld();
  io.spawnServe = async () => { w.result = { reason: "port_in_use" }; return { ok: true, pid: 777 }; };
  await assert.rejects(
    () => launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, port: 8080, io }),
    (error) => error.code === "port_in_use",
  );
  assert.equal(w.published, 0);
  assert.equal(w.resultsRemoved, 1, "read-once: the launcher cleaned the result file");
});

test("launch: a candidate that fails verification is candidate_mismatch, never published", async () => {
  const mismatch = makeWorld();
  mismatch.io.spawnServe = async ({ generation }) => {
    mismatch.w.candidate = { port: 9001, pid: 777, nonce: "ff".repeat(16), processCreatedAt: 1_700_000_001_000, build: BUILD };
    mismatch.w.identity[777] = "same";
    mismatch.w.listeners[9001] = [777];
    mismatch.w.healthByPort[9001] = { ok: true, nonce: NONCE };
    return { ok: true, pid: 777 };
  };
  await assert.rejects(
    () => launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io: mismatch.io }),
    (error) => error.code === "candidate_mismatch",
  );
  assert.equal(mismatch.w.published, 0);
});

test("launch: no candidate and no result before the deadline -> launch_timeout", async () => {
  const { io } = makeWorld();
  io.spawnServe = async () => ({ ok: true, pid: 777 });
  await assert.rejects(
    () => launchDashboard({ runId: undefined, runDir: RUN_DIR, stateRoot: STATE_ROOT, io }),
    (error) => error.code === "launch_timeout",
  );
});

test("launch (145b-fix): verification crossing the deadline defers publication — nothing is published, no dead record", async () => {
  const { w, io } = makeWorld();
  io.probeIdentity = async () => { await io.sleep(21_000); return "same"; }; // 核对跨过截止
  const firstCandidate = { port: 9001, pid: 777, nonce: NONCE, processCreatedAt: 1, build: BUILD };
  io.spawnServe = async ({ generation }) => {
    if (w.candidate === null) w.candidate = firstCandidate;
    return { ok: true, pid: 777 };
  };
  w.identity[777] = "same";
  w.listeners[9001] = [777];
  w.healthByPort[9001] = { ok: true, nonce: NONCE };
  await assert.rejects(
    () => launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io }),
    (error) => ["launch_failed", "lock_wait_failed", "launch_timeout"].includes(error.code),
    "deferred publication retries within the overall budget and eventually reports a bounded failure",
  );
  assert.equal(w.published, 0, "the expired candidate was NEVER published — instance.json cannot point at a dying serve");
});

// ===== 锁 =====

test("lock: the second reuse check inside the lock catches an instance that appeared meanwhile", async () => {
  const { w, io } = makeWorld();
  let firstCheck = true;
  io.readInstanceEx = async () => {
    if (firstCheck) { firstCheck = false; return { status: "absent" }; }
    return { status: "present", raw: instanceRecord(), record: instanceRecord() };
  };
  const out = await launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io });
  assert.equal(out.outcome, "reused");
  assert.equal(w.spawned.length, 0);
});

test("lock: someone else holds an unexpired lock -> bounded wait, reuse when the instance appears, never launch-after-wait", async () => {
  const { w, io } = makeWorld({ lock: { generation: "bbbbbbbbbbbbbbbb", deadline: 1_060_000 } });
  io.spawnServe = async () => { throw new Error("must not spawn while waiting"); };
  const realSleep = io.sleep;
  io.sleep = async (ms) => {
    await realSleep(ms);
    if (w.now >= 1_003_000) {
      w.instance = instanceRecord();
      w.readStatus = "present";
    }
    return undefined;
  };
  const out = await launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io });
  assert.equal(out.outcome, "reused");
  assert.equal(w.spawned.length, 0);
});

test("lock: an expired lock is taken over by the content-verified winner, who then launches", async () => {
  const { w, io } = makeWorld({ lock: { generation: "bbbbbbbbbbbbbbbb", deadline: 500 } });
  const out = await launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io });
  assert.equal(out.outcome, "launched");
  assert.ok(launched(w));
  assert.equal(w.lock.generation, w.spawned[0].generation, "the winner's own lock is live");
});

test("lock (145b-fix): a rotated lock during the wait is NOT taken over with the stale generation", async () => {
  const { w, io } = makeWorld({ lock: { generation: "bbbbbbbbbbbbbbbb", deadline: 1_010_000 } });
  let rotations = 0;
  const realSleep = io.sleep;
  io.sleep = async (ms) => {
    await realSleep(ms);
    if (rotations === 0 && w.now >= 1_001_000) {
      rotations += 1;
      w.lock = { generation: "cccccccccccccccc", deadline: w.now + 500 }; // 等待中锁被换成新一代
    }
    return undefined;
  };
  const out = await launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io });
  // 锁换了代：回到竞争起点；新一代过期后按其内容接管，照常拉起。
  assert.equal(out.outcome, "launched");
  assert.ok(launched(w));
});

test("lock: a lost takeover goes back to waiting; a persistent foreign lock ends in lock_wait_failed", async () => {
  const { w, io } = makeWorld({ lock: { generation: "bbbbbbbbbbbbbbbb", deadline: 1_000 } });
  io.takeOverStale = async () => false;
  io.readLock = async () => ({ generation: "cccccccccccccccc", deadline: w.now + 60_000 });
  await assert.rejects(
    () => launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io }),
    (error) => error.code === "lock_wait_failed",
  );
  assert.equal(w.spawned.length, 0, "waiting NEVER ends in a direct launch");
});

// ===== 真文件时序（修正一 #5：真并发、真实 dashboardFiles，不用更强假件） =====

/** 真实文件层的 io：锁/记录/候选/result 全走 dashboardFiles 真实现。 */
function realFilesIo(world, stateDir) {
  return {
    now: () => world.now,
    sleep: async (ms) => { world.now += ms; },
    ensureStateDir: async () => ({ ok: true }),
    verifyStateDir: async () => ({ ok: true }),
    readInstanceEx: () => readInstanceRecordEx(stateDir),
    publishInstance: (dir, record) => publishInstanceRecord(stateDir, record),
    readCandidate: (dir, gen) => readCandidateRecord(stateDir, gen),
    readResult: (dir, gen) => readResultRecord(stateDir, gen),
    removeResult: (dir, gen) => removeResultRecord(stateDir, gen),
    createLock: (dir, gen, dl) => createLaunchLock(stateDir, gen, dl),
    readLock: () => readLaunchLock(stateDir),
    takeOverStale: (dir, gen) => takeOverStaleLock(stateDir, gen),
    writeStopRequest: (dir, gen, nonce) => writeStopRequest(stateDir, gen, nonce),
    probeIdentity: async (pid) => world.identity[pid] ?? "gone",
    listenerPids: async (port) => (world.listeners[port] ?? []),
    health: async (port) => (world.health[port] ?? { ok: false }),
    spawnServe: async ({ generation }) => {
      world.spawned.push(generation);
      if (world.onSpawn !== null) await world.onSpawn(generation);
      const pid = 500 + world.spawned.length;
      const candidate = { port: 9001, pid, nonce: NONCE, processCreatedAt: 1_700_000_000_000 + world.spawned.length, build: BUILD };
      world.identity[pid] = "same";
      world.listeners[9001] = [pid];
      world.health[9001] = { ok: true, nonce: NONCE };
      writeFileSync(join(stateDir, `candidate-${generation}.json`), JSON.stringify(candidate));
      return { ok: true, pid };
    },
    issueCode: async () => ({ code: "0f".repeat(32) }),
    buildSnapshot: async () => BUILD,
  };
}

test("REAL FILES: two launchers racing on an empty state dir publish exactly ONE instance (true concurrency)", async () => {
  const base = mkdtempSync(join(tmpdir(), "wao-dash-race-"));
  try {
    const stateRoot = join(base, "state");
    const stateDir = stateDirFor(RUN_DIR, stateRoot);
    mkdirSync(stateDir, { recursive: true });
    const world = { now: 0, spawned: [], onSpawn: null, identity: {}, listeners: {}, health: {} };
    const io = realFilesIo(world, stateDir);
    const sleepReal = io.sleep;
    let wall = 0;
    io.sleep = async (ms) => { await new Promise((r) => setTimeout(r, Math.min(ms, 25))); wall += ms; sleepReal(ms); };
    // 两个启动器真并发（真锁文件、真候选、真发布）。
    const outcomes = await Promise.allSettled([
      launchDashboard({ runDir: RUN_DIR, stateRoot, io }),
      launchDashboard({ runDir: RUN_DIR, stateRoot, io }),
    ]);
    const values = outcomes.map((o) => (o.status === "fulfilled" ? o.value.outcome : `ERR:${o.reason?.code}`));
    const record = JSON.parse(readFileSync(join(stateDir, "instance.json"), "utf8"));
    assert.equal(record.protocol, 1);
    const successes = values.filter((v) => v === "launched" || v === "reused").length;
    assert.equal(successes, 2, `both callers end fine (${JSON.stringify(values)})`);
    assert.equal(values.filter((v) => v === "launched").length, 1, `exactly one launched (${JSON.stringify(values)})`);
    assert.equal(values.filter((v) => v === "reused").length, 1, `the other reused the winner (${JSON.stringify(values)})`);
    const publishedPorts = new Set(values.map((v) => v));
    assert.ok(record.pid >= 501 && record.pid <= 502, `one of the two candidates (${record.pid})`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("REAL FILES: a corrupt (half-written-shaped) lock is takeable; a NEW generation's lock is never stolen", async () => {
  const base = mkdtempSync(join(tmpdir(), "wao-dash-lockgen-"));
  try {
    const stateRoot = join(base, "state");
    const stateDir = stateDirFor(RUN_DIR, stateRoot);
    mkdirSync(stateDir, { recursive: true });
    // 坏形状的锁（半写在原子建锁下不存在，坏内容仍可能由外部出现）：可接管。
    writeFileSync(lockFileName(stateDir), "{half-writt");
    assert.equal(await takeOverStaleLock(stateDir, "0000000000000000"), true, "corrupt lock is takeable");
    // 有效的新锁：任何旧代际的接管都必须失败且锁内容原样保留。
    await createLaunchLock(stateDir, "1111222233334444", 9_999_999);
    assert.equal(await takeOverStaleLock(stateDir, "aaaaaaaaaaaaaaaa"), false, "another generation's lock is NOT stolen");
    const lock = await readLaunchLock(stateDir);
    assert.deepEqual(lock, { generation: "1111222233334444", deadline: 9_999_999 });
    // 接管者确认后无残迹（staging 已删）。
    assert.equal(await takeOverStaleLock(stateDir, "1111222233334444"), true);
    assert.equal(await readLaunchLock(stateDir), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("REAL FILES: publication re-checks the lock — a lock stolen before publication defers, then retries into a good launch", async () => {
  const base = mkdtempSync(join(tmpdir(), "wao-dash-pub-"));
  try {
    const stateRoot = join(base, "state");
    const stateDir = stateDirFor(RUN_DIR, stateRoot);
    mkdirSync(stateDir, { recursive: true });
    const world = { now: 0, spawned: [], identity: {}, listeners: {}, health: {} };
    // 第一次 spawn 时，等待者"接管"了锁（换成别人的有效锁，截止很近）。
    world.onSpawn = async () => {
      world.onSpawn = null; // 只偷一次
      writeFileSync(lockFileName(stateDir), JSON.stringify({ generation: "eeeeeeeeeeeeeeee", deadline: 1 }));
    };
    const io = realFilesIo(world, stateDir);
    const realSleep = io.sleep;
    io.sleep = async (ms) => { await new Promise((r) => setTimeout(r, Math.min(ms, 20))); realSleep(ms); };
    const out = await launchDashboard({ runDir: RUN_DIR, stateRoot, io });
    assert.equal(out.outcome, "launched", "deferred once (lock not mine at publish time), then retried into a clean launch");
    assert.ok(world.spawned.length >= 2, `at least two spawns happened (${world.spawned.length})`);
    const record = JSON.parse(readFileSync(join(stateDir, "instance.json"), "utf8"));
    assert.equal(record.generation, world.spawned.at(-1), "the published record is the LAST (verified) generation");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ===== status / stop / restart =====

test("status: same facts as the reuse check — it names WHICH check failed; no code or token", async () => {
  const { io } = makeWorld({ instance: instanceRecord() });
  const s = await dashboardStatus({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io });
  assert.equal(s.present, true);
  assert.equal(s.pid, 4242);
  assert.equal(s.port, 8123);
  assert.equal(s.protocol, 1);
  assert.equal(s.build, "same");
  assert.equal(s.health, "ok");
  assert.equal(s.failedCheck, null);
  assert.equal("code" in s, false);
  assert.equal("nonce" in s, false);

  const nonceBad = makeWorld({ instance: instanceRecord(), healthByPort: { 8123: { ok: true, nonce: "cd".repeat(16) } } });
  const s2 = await dashboardStatus({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io: nonceBad.io });
  assert.equal(s2.health, "unresponsive");
  assert.equal(s2.failedCheck, "nonce", "the failing check is named");

  const proto = makeWorld({ instance: instanceRecord({ protocol: 2 }) });
  const s3 = await dashboardStatus({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io: proto.io });
  assert.equal(s3.health, "incompatible");
  assert.equal(s3.failedCheck, "protocol");

  const none = await dashboardStatus({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io: makeWorld().io });
  assert.equal(none.present, false);
});

test("status/stop verify the state dir first — a rejected dir throws before any read or write", async () => {
  const { io } = makeWorld({ instance: instanceRecord() });
  const calls = [];
  const wrapped = { ...io, verifyStateDir: async (...a) => { calls.push("verify"); return { ok: false, reason: "reparse_point" }; }, readInstanceEx: async (...a) => { calls.push("read"); return { status: "absent" }; }, writeStopRequest: async (...a) => { calls.push("write"); } };
  await assert.rejects(() => dashboardStatus({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io: wrapped }), (e) => e.code === "state_dir_rejected");
  await assert.rejects(() => dashboardStop({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io: wrapped }), (e) => e.code === "state_dir_rejected");
  assert.deepEqual(calls, ["verify", "verify"], "no read, no stop-request write after a rejected dir");
});

test("stop (145b-fix): a vanished record with a LIVE pid waits until timeout — stopped only when the process is truly gone", async () => {
  const { w, io } = makeWorld({ instance: instanceRecord(), identity: { 4242: "same" } });
  const inst = instanceRecord();
  io.readInstanceEx = async () => (w.stopRequests.length > 0
    ? { status: "absent" } // 停机请求写入后，实例先删了记录
    : { status: "present", raw: inst, record: inst });
  const out = await dashboardStop({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io });
  assert.equal(out.outcome, "timeout", "record gone but the pid lives on -> keep waiting");
  assert.equal(w.stopRequests.length, 1, "the request WAS written while the record existed");
});

test("stop: writes the stop request with the record's nonce; the instance's exit settles it", async () => {
  const { w, io } = makeWorld({ instance: instanceRecord() });
  const realSleep = io.sleep;
  io.sleep = async (ms) => {
    await realSleep(ms);
    if (w.now >= 1_001_000) w.identity[4242] = "gone"; // 实例随后退出
    return undefined;
  };
  assert.equal((await dashboardStop({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io })).outcome, "stopped");
  assert.deepEqual(w.stopRequests, [{ generation: GEN_A, nonce: NONCE }]);
});

test("stop: no live instance -> no_instance (dead record, absent record, malformed record)", async () => {
  for (const setup of [
    makeWorld({ instance: instanceRecord(), identity: {} }), // pid 不在
    makeWorld({ readStatus: "absent" }),
    makeWorld({ instance: { pid: 42, processCreatedAt: 1 } }), // 连 pid 形状都不完整
  ]) {
    assert.equal((await dashboardStop({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io: setup.io })).outcome, "no_instance");
    assert.equal(setup.w.stopRequests.length, 0);
  }
});

test("stop: a timeout keeps the record and never kills anything", async () => {
  const { w, io } = makeWorld({ instance: instanceRecord(), identity: { 4242: "same" } });
  assert.equal((await dashboardStop({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io })).outcome, "timeout");
  assert.notEqual(w.instance, null, "the record is kept");
  assert.equal(w.stopRequests.length, 1);
});

test("restart: stop failure aborts — no spawn, the fixed stop-failed text", async () => {
  const { w, io } = makeWorld({ instance: instanceRecord(), identity: { 4242: "same" } });
  let spawned = 0;
  io.spawnServe = async () => { spawned += 1; return { ok: true, pid: 1 }; };
  await assert.rejects(
    () => dashboardRestart({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io }),
    (error) => error.code === "stop_failed",
  );
  assert.equal(spawned, 0, "restart never starts a second instance when stop failed");
});

test("restart: a successful stop flows into a normal launch", async () => {
  const { w, io } = makeWorld({ instance: instanceRecord({ pid: 4243 }) });
  w.identity = { 4243: "gone" };
  const out = await dashboardRestart({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io });
  assert.equal(out.outcome, "launched");
  assert.ok(launched(w));
});

// ===== 文案闭集 =====

test("error texts: every closed-set code has a fixed Chinese text; unknown codes are programming errors", () => {
  for (const code of DASHBOARD_CONTROL_ERRORS) {
    assert.ok(typeof dashboardControlErrorText(code) === "string" && dashboardControlErrorText(code).length > 0, code);
  }
  assert.equal(dashboardControlErrorText("no_such_code"), undefined);
});
