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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  launchDashboard,
  dashboardStatus,
  dashboardStop,
  dashboardRestart,
  buildServeCommandLine,
  defaultControlIo,
  DASHBOARD_CONTROL_ERRORS,
  dashboardControlErrorText,
} from "../../src/application/dashboardControl.js";
import {
  normalizeRunDir, stateDirFor, DASHBOARD_PUBLISH_MARGIN_MS, DASHBOARD_INSTANCE_POLL_MS, DASHBOARD_LAUNCH_DEADLINE_MS,
  DASHBOARD_LOCK_FUTURE_TOLERANCE_MS, DASHBOARD_STOP_BUDGET_MS,
} from "../../src/application/dashboardPaths.js";
import {
  readInstanceRecordEx, publishInstanceRecord, readCandidateRecord, readResultRecord, removeResultRecord,
  createLaunchLock, readLaunchLock, takeOverStaleLock, writeStopRequest, codesDirOf, lockFileName,
  removeLaunchLockIfGeneration, removeCandidateRecord, sweepStateDirLeftovers,
} from "../../src/application/dashboardFiles.js";
import { issueStartCode, redeemStartCode } from "../../src/application/dashboardCodes.js";

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
    codeGenerations: [], // issueCode 收到的代际（码绑定签发时核对过的代际）
    released: [],        // releaseLock 收到的代际
    swept: [],           // sweepLeftovers 收到的参数
    candidatesRemoved: [],
    ...overrides,
  };
  const io = {
    now: () => w.now,
    sleep: async (ms) => { w.now += ms; },
    ensureStateDir: async () => ({ ok: true }),
    verifyStateDir: async () => ({ ok: true }),
    stateDirPresent: async () => true,
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
    releaseLock: async (dir, generation) => {
      w.released.push(generation);
      if (w.lock !== null && w.lock.generation === generation) { w.lock = null; return true; }
      return false;
    },
    sweepLeftovers: async (dir, opts) => { w.swept.push(opts); return 0; },
    removeCandidate: async (dir, generation) => { w.candidatesRemoved.push(generation); },
    writeStopRequest: async (dir, generation, nonce) => { w.stopRequests.push({ generation, nonce }); },
    probeIdentity: async (pid) => w.identity[pid] ?? "gone",
    listenerPids: async (port) => w.listeners[port] ?? [],
    health: async (port) => w.healthByPort[port] ?? { ok: false },
    spawnServe: async ({ generation, deadline }) => {
      w.spawned.push({ generation, deadline, at: w.now, lock: w.lock === null ? null : { ...w.lock } }); // lock：spawn 那一刻的锁（用完即删，事后看不到）；at：spawn 的时刻
      if (w.onSpawn !== null) await w.onSpawn(generation);
      if (!w.spawnOk) return { ok: false, detail: "WMI ReturnValue=8" };
      w.candidate ??= { port: 9001, pid: 777, nonce: NONCE, processCreatedAt: 1_700_000_001_000, build: BUILD };
      w.identity[777] = "same";
      w.listeners[9001] = [777];
      w.healthByPort[9001] = { ok: true, nonce: NONCE };
      return { ok: true, pid: 777 };
    },
    issueCode: async (dir, generation) => {
      const code = `c${w.codes.length}${"0".repeat(61)}`;
      w.codes.push(code);
      w.codeGenerations.push(generation);
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
  const ok = buildServeCommandLine({ ...base, runDir: "D:/my runs/data", stateRoot: "C:/Users/<you>/App Data/Local/wao/dashboard", port: 8080 });
  assert.equal(ok.ok, true);
  assert.equal(
    ok.commandLine,
    '"C:/Program Files/node/node.exe" "D:/wao/src/cli.js" dashboard serve '
    + '--run-dir "D:/my runs/data" --state-root "C:/Users/<you>/App Data/Local/wao/dashboard" '
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

test("defaultControlIo (145b-fix): the serve child is quoted and its cwd is the INSTALL ROOT (src/'s parent)", async () => {
  const calls = [];
  const io = defaultControlIo({
    wmiBroker: async (input) => { calls.push(input); return { ok: true, pid: 4321 }; },
  });
  const out = await io.spawnServe({
    runDir: "d:/my runs/project",
    stateRoot: "c:/Users/<you>/App Data/Local/wao/dashboard",
    generation: "0123456789abcdef",
    port: 8080,
    deadline: Date.now() + 20_000,
  });
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  const installRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  assert.equal(calls[0].cwd.toLowerCase(), installRoot.toLowerCase(), "the child runs from the install root, not src/");
  assert.ok(calls[0].commandLine.includes('--run-dir "d:/my runs/project"'), "a run dir with spaces survives quoting");
  assert.ok(
    calls[0].commandLine.includes('--state-root "c:/Users/<you>/App Data/Local/wao/dashboard"'),
    "a state root with spaces survives quoting",
  );
  assert.match(calls[0].commandLine, /^".*node\.exe"\s+".*cli\.js"\s+dashboard\s+serve\s/, "node and the CLI travel as quoted argv");
});

test("defaultControlIo (145b-fix): an unquotable path is the fixed path_quote reason, never handed to WMI", async () => {
  let brokerCalls = 0;
  const io = defaultControlIo({ wmiBroker: async () => { brokerCalls += 1; return { ok: true, pid: 1 }; } });
  const out = await io.spawnServe({
    runDir: 'd:/evil"quote',
    stateRoot: "c:/state",
    generation: "0123456789abcdef",
    deadline: Date.now() + 20_000,
  });
  assert.deepEqual(out, { ok: false, reason: "path_quote" });
  assert.equal(brokerCalls, 0, "no process is created for an unquotable command line");
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

test("launch (145b-fix): an unquotable path is path_quote (a fixed configuration error), not wmi_create_failed", async () => {
  const { w, io } = makeWorld();
  io.spawnServe = async () => ({ ok: false, reason: "path_quote" });
  await assert.rejects(
    () => launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io }),
    (error) => error.code === "path_quote",
  );
  assert.equal(w.published, 0);
});

test("locking (145b-fix): the deadline a serve receives IS the deadline of this generation's lock", async () => {
  const { w, io } = makeWorld();
  let reads = 0;
  io.readInstanceEx = async () => {
    reads += 1;
    if (reads === 2) w.now += 5_000; // 锁内第二次复用检查耗掉 5 秒
    return { status: "absent" };
  };
  const out = await launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io });
  assert.equal(out.outcome, "launched");
  assert.equal(
    w.spawned[0].deadline,
    w.spawned[0].lock.deadline,
    "the child is bounded by the lock's deadline — spawn does not invent a later one",
  );
  assert.ok(w.spawned[0].deadline < w.now + 20_000, "no fresh 20 s deadline was started at spawn time");
});

test("locking (145b-fix): a second reuse check that crosses the lock deadline does NOT spawn — it goes back to reuse", async () => {
  const { w, io } = makeWorld();
  let reads = 0;
  io.readInstanceEx = async () => {
    reads += 1;
    if (reads === 2) { // 锁内第二次复用检查：一查就跨过这一代锁的截止
      w.now += 21_000;
      return { status: "absent" };
    }
    if (reads >= 3) return { status: "present", raw: instanceRecord(), record: instanceRecord() };
    return { status: "absent" };
  };
  const out = await launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io });
  assert.equal(out.outcome, "reused");
  assert.equal(w.spawned.length, 0, "an expired lock never produces a serve process");
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
  const { w, io } = makeWorld({ lock: { generation: "bbbbbbbbbbbbbbbb", deadline: 1_015_000 } }); // 活锁：期限不超过 now + 一代拉起期限
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
  assert.equal(w.spawned[0].lock.generation, w.spawned[0].generation, "the winner spawned under its OWN live lock");
  assert.equal(w.lock, null, "and released it afterwards");
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
    stateDirPresent: async () => true,
    readInstanceEx: () => readInstanceRecordEx(stateDir),
    publishInstance: (dir, record) => publishInstanceRecord(stateDir, record),
    readCandidate: (dir, gen) => readCandidateRecord(stateDir, gen),
    readResult: (dir, gen) => readResultRecord(stateDir, gen),
    removeResult: (dir, gen) => removeResultRecord(stateDir, gen),
    createLock: (dir, gen, dl) => createLaunchLock(stateDir, gen, dl),
    readLock: () => readLaunchLock(stateDir),
    takeOverStale: (dir, gen) => takeOverStaleLock(stateDir, gen),
    releaseLock: (dir, gen) => removeLaunchLockIfGeneration(stateDir, gen),
    sweepLeftovers: (dir, opts) => sweepStateDirLeftovers(stateDir, { ...opts, now: () => world.wall ?? Date.now() }),
    removeCandidate: (dir, gen) => removeCandidateRecord(stateDir, gen),
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
    issueCode: async (dir, generation) => {
      world.codeGenerations?.push(generation);
      return issueStartCode(codesDirOf(stateDir), generation, { now: () => world.wall ?? Date.now() });
    },
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

// ===== 修正二：坏锁形状、锁用完要删、过远的期限按过期、截止余量、码绑定代际、残余清理 =====

const stateOf = (base) => {
  const stateRoot = join(base, "state");
  const stateDir = stateDirFor(RUN_DIR, stateRoot);
  mkdirSync(stateDir, { recursive: true });
  return { stateRoot, stateDir };
};

test("REAL FILES (145b-fix2): a lock that is not the closed shape — {} / [1] / an extra key / a non-hex generation — is taken over and the launch goes through (no spin until launch_failed)", async () => {
  const bad = [
    "{}",
    "[1]",
    JSON.stringify({ generation: "0123456789abcdef", deadline: 5, pid: 1 }),
    JSON.stringify({ generation: "NOT-HEX-GENERATE", deadline: 5 }),
    JSON.stringify({ generation: "0123456789abcdef", deadline: "later" }),
  ];
  for (const content of bad) {
    const base = mkdtempSync(join(tmpdir(), "wao-dash-badlock-"));
    try {
      const { stateRoot, stateDir } = stateOf(base);
      writeFileSync(lockFileName(stateDir), content);
      const world = { now: 1_000_000, spawned: [], onSpawn: null, identity: {}, listeners: {}, health: {} };
      const out = await launchDashboard({ runDir: RUN_DIR, stateRoot, io: realFilesIo(world, stateDir) });
      assert.equal(out.outcome, "launched", `a bad lock (${content.slice(0, 40)}) never wedges the launcher`);
      assert.equal(world.spawned.length, 1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
});

test("REAL FILES (145b-fix2): the launcher deletes its own lock after publishing, after a failure and after abandoning — and never another generation's lock", async () => {
  const base = mkdtempSync(join(tmpdir(), "wao-dash-release-"));
  try {
    const { stateRoot, stateDir } = stateOf(base);
    // 成功：发布后锁没了。
    const ok = { now: 1_000_000, spawned: [], onSpawn: null, identity: {}, listeners: {}, health: {} };
    assert.equal((await launchDashboard({ runDir: RUN_DIR, stateRoot, io: realFilesIo(ok, stateDir) })).outcome, "launched");
    assert.equal(existsSync(lockFileName(stateDir)), false, "published: the lock is released");

    // 失败：子进程报告 port_in_use，启动器抛错，锁也没了。
    rmSync(join(stateDir, "instance.json"), { force: true });
    const failed = { now: 2_000_000, spawned: [], onSpawn: null, identity: {}, listeners: {}, health: {} };
    const failIo = realFilesIo(failed, stateDir);
    failIo.spawnServe = async ({ generation }) => {
      failed.spawned.push(generation);
      writeFileSync(join(stateDir, `result-${generation}.json`), JSON.stringify({ reason: "port_in_use" }));
      return { ok: true, pid: 1 };
    };
    await assert.rejects(() => launchDashboard({ runDir: RUN_DIR, stateRoot, io: failIo }), (e) => e.code === "port_in_use");
    assert.equal(existsSync(lockFileName(stateDir)), false, "failed: the lock is released too");

    // 放弃（发布前锁已被别人接管）：别人的锁原样保留，最后自己的重试成功并清掉自己的锁。
    rmSync(join(stateDir, "instance.json"), { force: true });
    const stolen = { now: 3_000_000, spawned: [], identity: {}, listeners: {}, health: {} };
    const stolenIo = realFilesIo(stolen, stateDir);
    let thief = null;
    stolen.onSpawn = async () => {
      stolen.onSpawn = null;
      thief = { generation: "eeeeeeeeeeeeeeee", deadline: stolen.now + 1 };
      writeFileSync(lockFileName(stateDir), JSON.stringify(thief)); // 别人偷换了锁（期限很近）
    };
    const realSleep = stolenIo.sleep;
    let thiefStillThereAtFirstDefer = null;
    stolenIo.sleep = async (ms) => {
      if (thiefStillThereAtFirstDefer === null && thief !== null) thiefStillThereAtFirstDefer = (await readLaunchLock(stateDir))?.generation === "eeeeeeeeeeeeeeee";
      await realSleep(ms);
    };
    assert.equal((await launchDashboard({ runDir: RUN_DIR, stateRoot, io: stolenIo })).outcome, "launched");
    assert.equal(thiefStillThereAtFirstDefer, true, "the abandoning launcher never deleted the foreign lock");
    assert.equal(existsSync(lockFileName(stateDir)), false, "and the final winner released its own");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/** 状态目录里躺着别人的活锁（代际不同、期限 = 现在 + offsetMs），启动器要拉起：返回假时钟走过了多久。 */
async function launchedUnderForeignLock(offsetMs) {
  const base = mkdtempSync(join(tmpdir(), "wao-dash-future-"));
  try {
    const { stateRoot, stateDir } = stateOf(base);
    const world = { now: 5_000_000, spawned: [], onSpawn: null, identity: {}, listeners: {}, health: {} };
    writeFileSync(lockFileName(stateDir), JSON.stringify({ generation: "bbbbbbbbbbbbbbbb", deadline: world.now + offsetMs }));
    const out = await launchDashboard({ runDir: RUN_DIR, stateRoot, io: realFilesIo(world, stateDir) });
    assert.equal(out.outcome, "launched");
    return world.now - 5_000_000;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test("REAL FILES (145b-fix2/3): a lock whose deadline is beyond now + the launch deadline + a 1 s tolerance (a clock set back) counts as EXPIRED; anything within is a live lock", async () => {
  assert.equal(DASHBOARD_LOCK_FUTURE_TOLERANCE_MS, 1_000);
  // 回拨前签下的锁：期限落在"当前时间 + 1 小时"——立刻接管，不等一小时。
  assert.ok(await launchedUnderForeignLock(3_600_000) < DASHBOARD_LAUNCH_DEADLINE_MS, "taken over at once instead of waiting an hour");
  // 边界：别人刚建的锁（期限 = 它的 now + 一代拉起期限）即使我们的钟比它的钟早了 1 秒以内，仍是活锁。
  assert.ok(await launchedUnderForeignLock(DASHBOARD_LAUNCH_DEADLINE_MS) >= DASHBOARD_LAUNCH_DEADLINE_MS, "exactly now + deadline: a live lock, waited out");
  const edge = DASHBOARD_LAUNCH_DEADLINE_MS + DASHBOARD_LOCK_FUTURE_TOLERANCE_MS;
  assert.ok(await launchedUnderForeignLock(edge) >= edge, "a clock that jumped back by up to the tolerance does not turn a fresh lock into a 'future' lock");
  assert.ok(await launchedUnderForeignLock(edge + 1) < DASHBOARD_LAUNCH_DEADLINE_MS, "one millisecond beyond the tolerance: expired, taken over at once");
});
test("REAL FILES (145b-fix2): a failed launch then a second launch leaves ONLY instance.json, instance.log and codes\\ — no result / candidate / tmp / rm / lock.new residue", async () => {
  const base = mkdtempSync(join(tmpdir(), "wao-dash-residue-"));
  try {
    const { stateRoot, stateDir } = stateOf(base);
    mkdirSync(join(stateDir, "codes"));
    writeFileSync(join(stateDir, "instance.log"), "log\n");
    // 第一次：候选核对不过（候选 nonce 对不上）→ 失败；"子进程"随后（启动器已走）才写出自己的 result。
    const first = { now: 1_000_000, spawned: [], onSpawn: null, identity: {}, listeners: {}, health: {} };
    const firstIo = realFilesIo(first, stateDir);
    const innerSpawn = firstIo.spawnServe;
    firstIo.spawnServe = async (input) => {
      const out = await innerSpawn(input);
      first.health[9001] = { ok: true, nonce: "ff".repeat(16) }; // 与候选里的 nonce 对不上
      return out;
    };
    await assert.rejects(() => launchDashboard({ runDir: RUN_DIR, stateRoot, io: firstIo }), (e) => e.code === "candidate_mismatch");
    const g1 = first.spawned[0];
    writeFileSync(join(stateDir, `result-${g1}.json`), JSON.stringify({ reason: "serve_error" })); // 启动器已离开后才落下的
    // 原子写失败的瞬态残留（早已没人在用）。老文件不靠回退 mtime 造（utimes 会刷新 ctime，清理按
    // max(mtime, ctime) 算年龄）——下面第二次拉起把清理用的"现在"（world.wall）往后拨两分钟。
    for (const name of ["instance.json.tmp-123-0123456789ab", "launch.lock.new-123-0123456789ab", "instance.json.rm-123-0123456789ab", `candidate-${g1}.json.tmp-1-0123456789ab`]) {
      writeFileSync(join(stateDir, name), "x");
    }
    assert.ok(readdirSync(stateDir).length > 3, "the residue is really there");
    // 第二次：成功。
    const second = { now: 9_000_000, wall: Date.now() + 120_000, spawned: [], onSpawn: null, identity: {}, listeners: {}, health: {} };
    assert.equal((await launchDashboard({ runDir: RUN_DIR, stateRoot, io: realFilesIo(second, stateDir) })).outcome, "launched");
    assert.deepEqual(readdirSync(stateDir).sort(), ["codes", "instance.json", "instance.log"], "nothing but the live files");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("residue sweep (145b-fix2): runs after the lock is held and the second reuse check came back empty; keeps the own and the stale record's generation; a reuse in the lock sweeps nothing", async () => {
  const { w, io } = makeWorld({ instance: instanceRecord({ generation: "abababababababab" }), identity: {} }); // 死记录
  const out = await launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io });
  assert.equal(out.outcome, "launched");
  assert.equal(w.swept.length, 1);
  assert.deepEqual([...w.swept[0].keepGenerations].sort(), ["abababababababab", w.spawned[0].generation].sort(), "the own generation and the stale record's generation are kept");
  assert.deepEqual(w.candidatesRemoved, [w.spawned[0].generation], "the candidate the launcher consumed is removed after publishing");

  const reuse = makeWorld({ instance: instanceRecord() });
  let firstCheck = true;
  const real = reuse.io.readInstanceEx;
  reuse.io.readInstanceEx = async (...a) => { if (firstCheck) { firstCheck = false; return { status: "absent" }; } return real(...a); };
  assert.equal((await launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io: reuse.io })).outcome, "reused");
  assert.equal(reuse.w.swept.length, 0, "a launcher that found a live instance in the lock sweeps nothing");
});

test("locks (145b-fix2): the launcher releases its lock by ITS generation on publish, failure and deferral alike", async () => {
  const published = makeWorld();
  await launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io: published.io });
  assert.deepEqual(published.w.released, [published.w.spawned[0].generation]);
  assert.equal(published.w.lock, null);

  const failed = makeWorld();
  failed.io.spawnServe = async () => { failed.w.result = { reason: "port_in_use" }; return { ok: true, pid: 777 }; };
  await assert.rejects(() => launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, port: 8080, io: failed.io }));
  assert.equal(failed.w.released.length, 1, "released on the failure path");
  assert.equal(failed.w.lock, null);

  const wmi = makeWorld({ spawnOk: false });
  await assert.rejects(() => launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io: wmi.io }), (e) => e.code === "wmi_create_failed");
  assert.equal(wmi.w.released.length, 1, "released when the process could not even be created");
  assert.equal(wmi.w.lock, null);
});

test("publish margin (145b-fix2): the time is checked AFTER the lock read, and a publication needs at least one child poll + 1 s before the deadline", async () => {
  assert.equal(DASHBOARD_PUBLISH_MARGIN_MS, DASHBOARD_INSTANCE_POLL_MS + 1_000);
  const shortBy = async (remainingMs) => {
    const { w, io } = makeWorld();
    let armed = false;
    let fired = false;
    const innerSpawn = io.spawnServe;
    io.spawnServe = async (...a) => { const out = await innerSpawn(...a); armed = true; return out; };
    const innerReadLock = io.readLock;
    io.readLock = async (...a) => {
      const lock = await innerReadLock(...a);
      if (armed && !fired) { fired = true; w.now = w.lock.deadline - remainingMs; } // 读锁这一下耗到只剩 remainingMs
      return lock;
    };
    await launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io });
    return w;
  };
  const justShort = await shortBy(DASHBOARD_PUBLISH_MARGIN_MS - 1);
  assert.equal(justShort.spawned.length, 2, "one millisecond short of the margin: NOT published — back to waiting, then a clean second launch");
  assert.equal(justShort.published, 1, "only the second (comfortable) attempt published");
  const exactly = await shortBy(DASHBOARD_PUBLISH_MARGIN_MS);
  assert.equal(exactly.spawned.length, 1, "exactly the margin is enough");
  assert.equal(exactly.published, 1);
});

/** 第一次候选就绪时，读锁这一下把假时钟耗到"离截止只剩 remainingMs"——启动器要推迟发布。 */
function deferringWorld(remainingMs, overrides = {}) {
  const { w, io } = makeWorld(overrides);
  let armed = false;
  let fired = false;
  const innerSpawn = io.spawnServe;
  io.spawnServe = async (...a) => { const out = await innerSpawn(...a); armed = true; return out; };
  const innerReadLock = io.readLock;
  io.readLock = async (...a) => {
    const lock = await innerReadLock(...a);
    if (armed && !fired) { fired = true; w.now = w.lock.deadline - remainingMs; }
    return lock;
  };
  return { w, io };
}

test("deferred publication (145b-fix3): the launcher first waits for its OWN unpublished child to be gone — no second spawn before old deadline + one instance poll + the stop budget", async () => {
  const { w, io } = deferringWorld(DASHBOARD_PUBLISH_MARGIN_MS - 1);
  const out = await launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, port: 8080, io });
  assert.equal(out.outcome, "launched");
  assert.equal(w.spawned.length, 2, "deferred once, then a clean second launch");
  const notBefore = w.spawned[0].deadline + DASHBOARD_INSTANCE_POLL_MS + DASHBOARD_STOP_BUDGET_MS;
  assert.ok(
    w.spawned[1].at >= notBefore,
    `the second child (same --port!) starts only after the first one has surely exited: ${w.spawned[1].at} >= ${notBefore}`,
  );
});

test("deferred publication (145b-fix3): the wait keeps reuse-checking — an instance that shows up meanwhile is reused, nothing more is spawned", async () => {
  const { w, io } = deferringWorld(DASHBOARD_PUBLISH_MARGIN_MS - 1);
  const innerSleep = io.sleep;
  io.sleep = async (ms) => {
    await innerSleep(ms);
    if (w.spawned.length === 1 && w.now >= w.spawned[0].deadline) w.instance = instanceRecord(); // 别的启动器这时发布了一个实例
  };
  const out = await launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io });
  assert.equal(out.outcome, "reused");
  assert.equal(w.spawned.length, 1, "no second child");
  assert.equal(w.published, 0);
});

test("deferred publication (145b-fix3): the wait counts against the overall budget — a late deferral ends in launch_failed, not in another spawn", async () => {
  // 别人的锁一把接一把：我们 ~38.7 s 才拿到锁，这一代截止 ~58.7 s；推迟后要等到截止 + 6 s，超出 60 s 总预算。
  const { w, io } = deferringWorld(DASHBOARD_PUBLISH_MARGIN_MS - 1, { lock: { generation: "bbbbbbbbbbbbbbbb", deadline: 1_019_000 } });
  let takeovers = 0;
  io.takeOverStale = async (dir, expectedGeneration) => {
    if (w.lock === null || w.lock.generation !== expectedGeneration) return false;
    takeovers += 1;
    w.lock = takeovers === 1 ? { generation: "cccccccccccccccc", deadline: w.now + 19_000 } : null; // 另一个启动器抢先建了下一把
    return true;
  };
  await assert.rejects(
    () => launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io }),
    (error) => error.code === "launch_failed",
  );
  assert.equal(w.spawned.length, 1, "the budget ran out while waiting — no second child was started");
});
test("codes (145b-fix2): a launched instance's code is bound to the PUBLISHED generation; a reused one to the generation the reuse check read", async () => {
  const launchedWorld = makeWorld();
  await launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io: launchedWorld.io });
  assert.deepEqual(launchedWorld.w.codeGenerations, [launchedWorld.w.spawned[0].generation]);

  const reusedWorld = makeWorld({ instance: instanceRecord() });
  await launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io: reusedWorld.io });
  assert.deepEqual(reusedWorld.w.codeGenerations, [GEN_A]);
});

test("REAL FILES (145b-fix2): the reuse check read generation A; the record became generation B before the code was written — B refuses the code, A would honour it", async () => {
  const base = mkdtempSync(join(tmpdir(), "wao-dash-codegen-"));
  try {
    const { stateRoot, stateDir } = stateOf(base);
    const GEN_B = "bbbbbbbbbbbbbbbb";
    const world = { now: 1_000_000, spawned: [], onSpawn: null, identity: { 4242: "same" }, listeners: { 8123: [4242] }, health: { 8123: { ok: true, nonce: NONCE } }, codeGenerations: [] };
    await publishInstanceRecord(stateDir, instanceRecord()); // generation A
    const io = realFilesIo(world, stateDir);
    const innerHealth = io.health;
    io.health = async (port) => {
      const result = await innerHealth(port); // 复用检查最后一项刚过……
      await publishInstanceRecord(stateDir, instanceRecord({ generation: GEN_B, nonce: "cd".repeat(16) })); // ……记录就换代了
      return result;
    };
    const out = await launchDashboard({ runDir: RUN_DIR, stateRoot, io });
    assert.equal(out.outcome, "reused");
    assert.deepEqual(world.codeGenerations, [GEN_A], "the code was bound to what the reuse check READ, not to a later re-read");
    const codes = codesDirOf(stateDir);
    assert.equal(await redeemStartCode(codes, out.code, { generation: GEN_B }), false, "the new generation refuses the old generation's code");
    assert.equal(await redeemStartCode(codes, out.code, { generation: GEN_A }), true, "and it was never consumed by that refusal");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ===== 活进程配坏形状记录：不绕成死圈（修正二第 9 条） =====

test("live process + malformed record (145b-fix2): launch says 'pid N is unresponsive, close it first' (no restart hint); stop and restart say the same and write nothing", async () => {
  const bad = () => makeWorld({ instance: { ...instanceRecord(), extra: 1 }, recordOverride: null, identity: { 4242: "same" } });
  const noRestartHint = (error) => {
    assert.equal(error.code, "instance_unresponsive");
    assert.match(error.message, /pid 4242/);
    assert.match(error.message, /请先关掉/);
    assert.doesNotMatch(error.message, /restart/, "restart would only come back to the same error");
    return true;
  };
  const a = bad();
  await assert.rejects(() => launchDashboard({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io: a.io }), noRestartHint);
  assert.equal(a.w.spawned.length, 0);

  const b = bad();
  await assert.rejects(() => dashboardStop({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io: b.io }), noRestartHint);
  assert.equal(b.w.stopRequests.length, 0, "no stop request is written for a record that cannot name a nonce");

  const c = bad();
  await assert.rejects(() => dashboardRestart({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io: c.io }), noRestartHint);
  assert.equal(c.w.stopRequests.length, 0);
  assert.equal(c.w.spawned.length, 0, "restart stops at the same error instead of looping or starting a second instance");

  const status = await dashboardStatus({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io: bad().io });
  assert.equal(status.present, true);
  assert.equal(status.failedCheck, "record-shape");
  assert.equal(status.pid, 4242);
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

test("status/stop on a NEVER-created state dir say 'no instance' — nothing to verify, read or write", async () => {
  const calls = [];
  const io = {
    ...makeWorld().io,
    stateDirPresent: async () => false,
    verifyStateDir: async () => { calls.push("verify"); return { ok: true }; },
    readInstanceEx: async () => { calls.push("read"); return { status: "absent" }; },
    writeStopRequest: async () => { calls.push("write"); },
  };
  assert.deepEqual(await dashboardStatus({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io }), { present: false });
  assert.deepEqual(await dashboardStop({ runDir: RUN_DIR, stateRoot: STATE_ROOT, io }), { outcome: "no_instance" });
  assert.deepEqual(calls, [], "an absent state dir is reported as no instance, never verified/read/written");
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
