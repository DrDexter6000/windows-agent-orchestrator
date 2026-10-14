// test/backends/kimiServeIdleWatch.test.js
//
// 决定 0079：WAO 拉起的 kimi worker serve 空闲时自己退出——跟着 serve 走的
// 看护进程。零真进程：pid 存活、token 读取、会话列表、关停、时钟、锁全部注入（锁用
// 临时目录里的真实文件——与 kimiServeStart.test.js 同款）。
//
// 契约（退出原因闭集 IDLE_WATCH_EXIT_REASONS）：
//   - 空闲满阈值 → 抢启动锁 → 复核两面仍空闲 → 优雅关停恰一次 → 放锁 → idle_shutdown；
//   - 活动 = 任一会话 busy / mainTurnActive，或会话 id 集合与上一拍不同 → 重置计时；
//   - 别人持锁 → 这一拍跳过（不覆盖别人的锁）；
//   - 复核发现有活动 → 不关停，记为有活动继续；
//   - serve 的 pid 不在 → serve_gone；token 连续 3 拍读不到 → token_unreadable；
//     会话列表连续 5 拍读不到 → unobservable（都什么也不做）；
//   - 关停请求失败 → shutdown_failed，绝不强杀、不重试。

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  IDLE_WATCH_EXIT_REASONS,
  IDLE_WATCH_IDLE_THRESHOLD_MS,
  startServeIdleWatch,
  watchServeIdle,
} from "../../src/backends/kimiServeIdleWatch.js";
import { acquireServeStartLock, releaseServeStartLock, serveStartLockPath } from "../../src/backends/kimiServeStart.js";

const PORT = 58998;
const PID = 4242;
const TOKEN = ["idle", "watch", "tok"].join("-");
const BASE_CLOCK = 1_000_000;

/**
 * 一组临时目录 + 注入件。时钟为受控单调钟；只有 sleepFn 前进它（每睡一次 +pollStepMs）。
 * state.faces 是主循环与复核共用的当前会话面（数组）；state.listFail / state.portDown
 * 切换故障形状；pageSize=1 的调用是关停后的端口探活（connection_refused = 端口已死）。
 */
function harness({ idleThresholdMs = 100, pollStepMs = 60 } = {}) {
  const home = mkdtempSync(join(tmpdir(), "wao-idle-home-"));
  writeFileSync(join(home, "server.token"), `${TOKEN}\n`, "utf8");
  const lockDir = mkdtempSync(join(tmpdir(), "wao-idle-lock-"));
  let clock = BASE_CLOCK;
  const calls = { lists: [], shutdowns: [], releases: 0 };
  const state = {
    faces: [],            // 当前会话面（默认空 = 空闲）
    archive: null,        // null = 归档面与主面相同
    listFail: false,
    portDown: false,
    shutdownOutcome: null, // null = { outcome: "requested" }
  };
  const h = {
    home, lockDir, state, calls,
    lockPath: serveStartLockPath(PORT, lockDir),
    nowMs: () => clock,
    advance: (ms) => { clock += ms; },
    sleepFn: async () => { clock += pollStepMs; },
    listSessionsFn: async (args = {}) => {
      calls.lists.push(args);
      if (args.pageSize === 1) {
        return state.portDown ? { ok: false, reason: "connection_refused" } : { ok: true, items: [] };
      }
      if (state.listFail) return { ok: false, reason: "http_error" };
      return { ok: true, items: args.archivedOnly && state.archive !== null ? state.archive : state.faces };
    },
    shutdownFn: async (args) => {
      calls.shutdowns.push({ ...args, atClock: clock });
      return state.shutdownOutcome ?? { outcome: "requested" };
    },
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(lockDir, { recursive: true, force: true });
    },
    args: (overrides = {}) => ({
      port: PORT, pid: PID, kimiHome: home,
      idleThresholdMs, pollMs: 1000,
      nowMs: h.nowMs, sleepFn: h.sleepFn,
      listSessionsFn: h.listSessionsFn, shutdownFn: h.shutdownFn,
      lockDir,
      childAliveFn: () => true,
      readInstancesFn: () => [{ pid: PID, port: PORT }],
      acquireLockFn: acquireServeStartLock, // 真锁（临时目录），放锁走真 release
      releaseLockFn: (lock) => { calls.releases += 1; return releaseServeStartLock(lock); },
      ...overrides,
    }),
  };
  return h;
}

/** 按次序回放的会话面脚本（只作用于非探活的读取，归档面为空）。 */
function scriptedFaces(script) {
  let i = 0;
  return async (args = {}) => {
    if (args.pageSize === 1) return { ok: false, reason: "connection_refused" };
    if (args.archivedOnly) return { ok: true, items: [] };
    const items = script[Math.min(i, script.length - 1)];
    i += 1;
    return { ok: true, items };
  };
}

const idle = (ids) => ids.map((id) => ({ id, busy: false, mainTurnActive: false }));

test("idle watch: 空闲满阈值 → 抢锁复核仍空闲 → 优雅关停恰一次 → 放锁 → idle_shutdown", async () => {
  const h = harness();
  try {
    h.state.portDown = true;
    const r = await watchServeIdle(h.args());
    assert.equal(r, "idle_shutdown");
    assert.equal(h.calls.shutdowns.length, 1, "恰一次关停");
    assert.equal(h.calls.shutdowns[0].baseUrl, `http://127.0.0.1:${PORT}`);
    assert.equal(h.calls.shutdowns[0].token, TOKEN);
    // 计时模型锚点：阈值 100、每睡 +60 → 第 3 拍（clock=+120）才够阈值。后续"重置"用例以此为对照。
    assert.equal(h.calls.shutdowns[0].atClock, BASE_CLOCK + 120);
    assert.equal(existsSync(h.lockPath), false, "关停路径放锁");
    assert.ok(h.calls.releases >= 1);
    // token 每拍从主目录文件读（不走环境）——所有请求带的都是文件里的那个值。
    assert.ok(h.calls.lists.length > 0 && h.calls.lists.every((c) => c.token === TOKEN));
  } finally { h.cleanup(); }
});

test("idle watch: busy / mainTurnActive / 会话 id 集合变化都算活动，重置空闲计时", async () => {
  // 对照：无活动时第 3 拍（+120）关停（上一用例钉住）。三种活动各把关停推到 +180。
  for (const [name, busyFrame] of [
    ["busy", [{ id: "s1", busy: true, mainTurnActive: false }]],
    ["mainTurnActive", [{ id: "s1", busy: false, mainTurnActive: true }]],
  ]) {
    const h = harness();
    try {
      const script = [
        idle(["s1"]),          // t1（+0）：空闲基线
        busyFrame,             // t2（+60）：活动 → 计时重置到 +60
        idle(["s1"]),          // t3（+120）：120-60=60 < 100，不该关停
        idle(["s1"]),          // t4（+180）：180-60=120 ≥ 100 → 复核后关停
      ];
      const r = await watchServeIdle(h.args({ listSessionsFn: scriptedFaces(script) }));
      assert.equal(r, "idle_shutdown", name);
      assert.equal(h.calls.shutdowns.length, 1, name);
      assert.equal(h.calls.shutdowns[0].atClock, BASE_CLOCK + 180, `${name}: 计时被活动重置（无重置会在 +120 关停）`);
    } finally { h.cleanup(); }
  }
  // id 集合变化（新增会话，全空闲）：与 busy 同样重置。
  {
    const h = harness();
    try {
      const script = [
        idle([]),              // t1：空集基线
        idle(["s1"]),          // t2（+60）：集合变了 → 活动
        idle(["s1"]),          // t3（+120）：60 < 100 不关停
        idle(["s1"]),          // t4（+180）：≥ 100 → 关停
      ];
      const r = await watchServeIdle(h.args({ listSessionsFn: scriptedFaces(script) }));
      assert.equal(r, "idle_shutdown");
      assert.equal(h.calls.shutdowns.length, 1);
      assert.equal(h.calls.shutdowns[0].atClock, BASE_CLOCK + 180, "集合变化重置计时");
    } finally { h.cleanup(); }
  }
});

test("idle watch: 别人持有启动锁 → 这一拍跳过（不覆盖别人的锁），锁空出来才复核关停", async () => {
  const h = harness();
  try {
    // 别人的新鲜锁（另一条派发 / recycle 正在动这个端口）。
    writeFileSync(h.lockPath, JSON.stringify({ pid: 1, nonce: "other", ts: BASE_CLOCK + 3_600_000 }));
    let sleeps = 0;
    let lockOwnerAtSkip = null;
    const r = await watchServeIdle(h.args({
      sleepFn: async () => {
        sleeps += 1;
        h.advance(60);
        if (sleeps === 3) {
          // 第 3 次睡 = 第 3 拍（阈值已满）抢锁失败后的跳过：此刻锁仍是别人的（没被覆盖）。
          if (existsSync(h.lockPath)) lockOwnerAtSkip = JSON.parse(readFileSync(h.lockPath, "utf8")).nonce;
          rmSync(h.lockPath, { force: true }); // 模拟别的进程放锁
        }
      },
    }));
    assert.equal(r, "idle_shutdown");
    assert.equal(lockOwnerAtSkip, "other", "跳过的那一拍没有覆盖别人的锁");
    // t3（+120，阈值满）抢锁失败跳过；t4（+180）才抢到 → 关停发生在 +180 而非 +120。
    assert.equal(h.calls.shutdowns.length, 1);
    assert.equal(h.calls.shutdowns[0].atClock, BASE_CLOCK + 180, "抢不到锁的那一拍跳过了");
    assert.equal(existsSync(h.lockPath), false, "自己的锁用完即放");
  } finally { h.cleanup(); }
});

test("idle watch: 抢到锁后复核发现有活动 → 不关停、放锁、记为有活动继续", async () => {
  const h = harness();
  try {
    const script = [
      idle([]),               // t1（+0）：基线
      idle([]),               // t2（+60）
      idle([]),               // t3（+120）：阈值满 → 抢锁 → 复核读下一帧
      [{ id: "s1", busy: true, mainTurnActive: false }], // 复核帧：有活动 → 不关停
      idle(["s1"]),           // t4（+180）：60 < 100 不关停
      idle(["s1"]),           // t5（+240）：120 ≥ 100 → 复核（clamp 本帧）仍空闲 → 关停
    ];
    const r = await watchServeIdle(h.args({ listSessionsFn: scriptedFaces(script) }));
    assert.equal(r, "idle_shutdown");
    assert.equal(h.calls.shutdowns.length, 1);
    // 没有在 +120（复核发现活动的那一拍）关停，而是重置到 +120 后在 +240 关停。
    assert.equal(h.calls.shutdowns[0].atClock, BASE_CLOCK + 240, "复核发现活动 → 计时重置，未关停");
  } finally { h.cleanup(); }
});

test("idle watch: serve 的 pid 不在（不是同一个 kimi 进程）→ serve_gone，零请求", async () => {
  const h = harness();
  try {
    const r = await watchServeIdle(h.args({ childAliveFn: () => false }));
    assert.equal(r, "serve_gone");
    assert.equal(h.calls.lists.length, 0);
    assert.equal(h.calls.shutdowns.length, 0);
    assert.equal(existsSync(h.lockPath), false);
  } finally { h.cleanup(); }
});

test("idle watch: 会话列表连续 5 拍读不到 → unobservable，什么也不做", async () => {
  const h = harness();
  try {
    h.state.listFail = true;
    const r = await watchServeIdle(h.args());
    assert.equal(r, "unobservable");
    assert.equal(h.calls.lists.length, 5, "第 5 拍退出（主面失败即短路，归档面不再读）");
    assert.equal(h.calls.shutdowns.length, 0);
    assert.equal(existsSync(h.lockPath), false);
  } finally { h.cleanup(); }
});

test("idle watch: token 连续 3 拍读不到 → token_unreadable，不发任何请求", async () => {
  const h = harness();
  try {
    const r = await watchServeIdle(h.args({ readFileFn: () => { throw Object.assign(new Error("enoent"), { code: "ENOENT" }); } }));
    assert.equal(r, "token_unreadable");
    assert.equal(h.calls.lists.length, 0, "token 读不到就不打会话面");
    assert.equal(h.calls.shutdowns.length, 0);
  } finally { h.cleanup(); }
});

test("idle watch: 关停请求失败 → shutdown_failed，放锁退出，不强杀、不重试", async () => {
  const h = harness();
  try {
    h.state.shutdownOutcome = { outcome: "failed", reason: "timeout" };
    const r = await watchServeIdle(h.args());
    assert.equal(r, "shutdown_failed");
    assert.equal(h.calls.shutdowns.length, 1, "只试一次，不重试");
    assert.equal(h.calls.lists.filter((c) => c.pageSize === 1).length, 0, "失败后连端口确认探活都不做（直接退出）");
    assert.equal(existsSync(h.lockPath), false, "失败路径也放锁");
  } finally { h.cleanup(); }
});

test("idle watch: kimiHome 缺省 → token 取默认主目录 ~/.kimi-code/server.token（与 readServeInstances 同规则）", async () => {
  const fakeUserHome = mkdtempSync(join(tmpdir(), "wao-idle-hd-"));
  try {
    const defaultHome = join(fakeUserHome, ".kimi-code");
    mkdirSync(defaultHome, { recursive: true });
    writeFileSync(join(defaultHome, "server.token"), ["default", "home", "tok"].join("-") + "\n", "utf8");
    const reads = [];
    const lists = [];
    let n = 0;
    const h = harness();
    try {
      // 第 3 拍起列表读不到 → 有界退出（unobservable），期间已证明 token 的取法。
      const r = await watchServeIdle(h.args({
        kimiHome: undefined,
        homedirFn: () => fakeUserHome,
        readFileFn: (p, enc) => { reads.push(p); return readFileSync(p, enc); },
        listSessionsFn: async (args = {}) => {
          lists.push(args);
          n += 1;
          return n <= 4 ? { ok: true, items: [] } : { ok: false, reason: "http_error" };
        },
      }));
      assert.equal(r, "unobservable");
      assert.ok(reads.length > 0 && reads.every((p) => p === join(defaultHome, "server.token")), "token 每拍从默认主目录文件读");
      assert.equal(lists.length, 9, "前两拍各两面（4 次）+ 之后连续 5 拍失败（第 5 拍退出）");
    } finally { h.cleanup(); }
  } finally { rmSync(fakeUserHome, { recursive: true, force: true }); }
});

test("idle watch: 退出原因是闭集；缺省阈值 30 分钟", () => {
  assert.deepEqual([...IDLE_WATCH_EXIT_REASONS], ["serve_gone", "serve_replaced", "idle_shutdown", "shutdown_failed", "token_unreadable", "unobservable"]);
  assert.equal(IDLE_WATCH_IDLE_THRESHOLD_MS, 30 * 60_000);
});

// ===== startServeIdleWatch（看护进程的启动面，spawn 注入）=====

test("startServeIdleWatch: 用 process.execPath 跑本模块（detached / ignore / windowsHide → unref），环境同套剔除；失败不抛错", () => {
  const spawns = [];
  const env = {
    PATH: "C:\\windows",
    CLAUDECODE: "1",
    Claude_Code_Session: "s",
    ANTHROPICBASE: "x",
    anthropic_any: "y",
    ZZ_TEST_API_KEY: "k",
    WAO_TARGET_CWD: "D:\\lead",
    NORMAL: "1",
  };
  let unrefCalled = 0;
  const spawnFn = (exe, args, opts) => {
    spawns.push({ exe, args, opts });
    return { pid: 9001, once() {}, unref() { unrefCalled += 1; } };
  };
  const home = "D:\\kimi-home";
  const r = startServeIdleWatch({ port: 58630, pid: 4242, kimiHome: home, env, spawnFn });
  assert.deepEqual(r, { started: true, pid: 9001 });
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].exe, process.execPath);
  assert.equal(spawns[0].args[0], fileURLToPath(new URL("../../src/backends/kimiServeIdleWatch.js", import.meta.url)));
  assert.deepEqual(spawns[0].args.slice(1), ["--port", "58630", "--pid", "4242", "--kimi-home", home]);
  assert.equal(spawns[0].opts.detached, true);
  assert.equal(spawns[0].opts.stdio, "ignore");
  assert.equal(spawns[0].opts.windowsHide, true);
  // 中立工作目录：不继承拉起者的 cwd——Windows 不删正被某进程用作工作目录的
  // 目录，看护若占住派发工作树，该树要等看护退出（≥空闲阈值）才能删。
  assert.equal(spawns[0].opts.cwd, tmpdir(), "spawn cwd = os.tmpdir()（不占拉起者的工作树）");
  // 环境剔除与 serve 同一套：不带密钥、WAO_*、CLAUDE*、ANTHROPIC*；普通变量保留。
  const childEnv = spawns[0].opts.env;
  for (const gone of ["CLAUDECODE", "Claude_Code_Session", "ANTHROPICBASE", "anthropic_any", "ZZ_TEST_API_KEY", "WAO_TARGET_CWD"]) {
    assert.equal(gone in childEnv, false, gone);
  }
  assert.equal(childEnv.PATH, "C:\\windows");
  assert.equal(childEnv.NORMAL, "1");
  assert.equal("WAO_IN_WORKER" in childEnv, false, "看护不是 worker，不注入 worker 标记");
  assert.equal(unrefCalled, 1);

  // kimiHome 缺省 → 不带 --kimi-home。
  spawns.length = 0;
  startServeIdleWatch({ port: 58630, pid: 4242, env, spawnFn });
  assert.deepEqual(spawns[0].args, [spawns[0].args[0], "--port", "58630", "--pid", "4242"]);

  // 参数形状不对 / spawn 抛错 / 子进程没有 pid → 失败结果，不抛错。
  assert.equal(startServeIdleWatch({ port: 0, pid: 4242, spawnFn }).started, false);
  assert.equal(startServeIdleWatch({ port: 58630, pid: null, spawnFn }).started, false);
  assert.deepEqual(
    startServeIdleWatch({ port: 58630, pid: 4242, spawnFn: () => { throw new Error("nope"); } }),
    { started: false, reason: "spawn_failed" },
  );
  assert.deepEqual(
    startServeIdleWatch({ port: 58630, pid: 4242, spawnFn: () => ({ once() {}, unref() {} }) }),
    { started: false, reason: "spawn_failed" },
  );
});

test("idle watch: 读不到的拍不算空闲——恢复后要重新攒满阈值才关停（会审 sol Q2）", async () => {
  const h = harness();
  try {
    h.state.portDown = true;
    let reads = 0;
    const flaky = async (args = {}) => {
      if (args.pageSize === 1) return { ok: false, reason: "connection_refused" };
      reads += 1;
      // 第 1–4 次主面读取失败（每拍主面先读），之后恢复。
      if (!args.archivedOnly && reads <= 4) return { ok: false, reason: "http_error" };
      return { ok: true, items: [] };
    };
    const r = await watchServeIdle(h.args({ listSessionsFn: flaky }));
    assert.equal(r, "idle_shutdown");
    // 失败四拍各推进 60，第 4 拍把计时记在 +180；恢复的第一拍（+240）只攒了 60 < 100，
    // 第二拍（+300）才够阈值。旧行为计时从 +0 起算，会在恢复的第一拍（+240）就关停。
    assert.equal(h.calls.shutdowns[0].atClock, BASE_CLOCK + 300);
  } finally { h.cleanup(); }
});

test("idle watch: 关停前被看护的 pid 已不在 → serve_gone，不关停（会审 sol Q2）", async () => {
  const h = harness();
  try {
    let checks = 0;
    // 每拍开头核一次；复核之后、关停之前再核一次——让第二次核验为假。
    const alive = () => { checks += 1; return checks < 3; };
    const r = await watchServeIdle(h.args({ childAliveFn: alive, idleThresholdMs: 50 }));
    assert.equal(r, "serve_gone");
    assert.equal(h.calls.shutdowns.length, 0);
  } finally { h.cleanup(); }
});

test("idle watch: 端口上的实例已不是被看护的 pid → serve_replaced，不关别人的 serve（会审 sol Q2）", async () => {
  const h = harness();
  try {
    const r = await watchServeIdle(h.args({ readInstancesFn: () => [{ pid: PID + 1, port: PORT }] }));
    assert.equal(r, "serve_replaced");
    assert.ok(IDLE_WATCH_EXIT_REASONS.includes("serve_replaced"));
    assert.equal(h.calls.shutdowns.length, 0);
    assert.equal(existsSync(h.lockPath), false, "退出时放锁");
  } finally { h.cleanup(); }
});

test("idle watch: 陈旧锁的持锁进程还活着 → 不接管、不关停；持锁进程已不在 → 接管后关停（会审 sol Q2）", async () => {
  const live = harness();
  try {
    // 一份超过 120 秒的陈旧锁，持锁者是本测试进程（活着）。
    writeFileSync(live.lockPath, JSON.stringify({ pid: process.pid, nonce: "other", ts: BASE_CLOCK - 10 * 60_000 }), "utf8");
    let ticks = 0;
    const r = await watchServeIdle(live.args({ childAliveFn: () => { ticks += 1; return ticks < 8; } }));
    assert.equal(r, "serve_gone", "一直抢不到锁，直到 serve 自己没了");
    assert.equal(live.calls.shutdowns.length, 0, "持锁者活着就绝不关停");
    assert.equal(JSON.parse(readFileSync(live.lockPath, "utf8")).nonce, "other", "别人的锁原样留着");
  } finally { live.cleanup(); }
  const dead = harness();
  try {
    dead.state.portDown = true;
    writeFileSync(dead.lockPath, JSON.stringify({ pid: 2147483646, nonce: "gone", ts: BASE_CLOCK - 10 * 60_000 }), "utf8");
    const r = await watchServeIdle(dead.args());
    assert.equal(r, "idle_shutdown", "持锁进程不在：陈旧锁可以接管");
    assert.equal(dead.calls.shutdowns.length, 1);
  } finally { dead.cleanup(); }
});

test("idle watch: 陈旧锁认不出持锁者（缺 pid / 内容损坏）→ 不接管、不关停（会审 sol 复核）", async () => {
  const { utimesSync } = await import("node:fs");
  for (const [label, body] of [["缺 pid", JSON.stringify({ nonce: "x", ts: BASE_CLOCK - 10 * 60_000 })], ["内容损坏", "{not json"]]) {
    const h = harness();
    try {
      writeFileSync(h.lockPath, body, "utf8");
      // 损坏正文按修改时间算陈旧：把修改时间放到受控时钟的十分钟之前。
      utimesSync(h.lockPath, (BASE_CLOCK - 10 * 60_000) / 1000, (BASE_CLOCK - 10 * 60_000) / 1000);
      let ticks = 0;
      const r = await watchServeIdle(h.args({ childAliveFn: () => { ticks += 1; return ticks < 8; } }));
      assert.equal(r, "serve_gone", `${label}：一直不接管，直到 serve 自己没了`);
      assert.equal(h.calls.shutdowns.length, 0, `${label}：没有证据证明持锁者已死就不关停`);
      assert.equal(readFileSync(h.lockPath, "utf8"), body, `${label}：别人的锁原样留着`);
    } finally { h.cleanup(); }
  }
});

test("acquireServeStartLock: 不传 holderAliveFn 时仍是陈旧即接管（按需拉起的行为不变）；传了且持锁者认不出来则不接管", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lock-holder-"));
  try {
    const lockPath = join(dir, "lock");
    const stale = JSON.stringify({ nonce: "old", ts: BASE_CLOCK - 10 * 60_000 });
    writeFileSync(lockPath, stale, "utf8");
    const strict = acquireServeStartLock({ lockPath, now: BASE_CLOCK, childAliveFn: () => false, holderAliveFn: () => false });
    assert.equal(strict.held, false, "持锁者认不出来：不接管");
    assert.equal(readFileSync(lockPath, "utf8"), stale);
    const loose = acquireServeStartLock({ lockPath, now: BASE_CLOCK, childAliveFn: () => false });
    assert.equal(loose.held, true, "不传 holderAliveFn：陈旧即接管");
    releaseServeStartLock(loose);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
