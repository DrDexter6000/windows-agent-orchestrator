// test/backends/kimiServeStart.test.js
//
// 决定 0075：kimi worker serve 的按需拉起（ensureServeRunning）与启动锁。零真进程——fetch、
// spawn、睡眠、时钟、实例表、进程存活判定全部注入；锁目录与 serve 工作目录用系统临时目录
// 下的真实目录。
//
// 契约：
//   - 首探不是"连接被拒"/ 车道没声明工作目录 / 非回环地址 → 什么都不做（null）；
//   - 连接被拒 → 持锁者拉起一次（args / cwd / env / detached），等到应答后返回并放锁；
//   - 不拉的三种情形：别人持有未陈旧的锁、serve 进程活着但没在监听、上一次拉起的进程
//     还活着却没应答——只等，等不到报错并点名；
//   - 锁：只删自己的；陈旧可接手；坏锁按修改时间算陈旧；写不了不挡路；
//   - 起了进程却等不到应答 → 锁留下并记着那个进程；
//   - 错误文案取自闭集，不含 token 与 serveUrl。

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireServeStartLock,
  ensureServeRunning,
  holdServeStartLock,
  kimiServeChildEnv,
  releaseServeStartLock,
  serveStartLockPath,
} from "../../src/backends/kimiServeStart.js";

const PORT = 58999;
const SERVE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = ["serve", "start", "tok", "0075"].join("-");

function refusedError() {
  const error = new TypeError("fetch failed");
  error.cause = { code: "ECONNREFUSED" };
  return error;
}

/** 假 serve：state.mode = refused | ok | unauthorized | hang | transport；记录每次请求。 */
function fakeServe(initialMode = "refused") {
  const state = { mode: initialMode, calls: [] };
  const fetchImpl = async (url, init) => {
    state.calls.push({ url, authorization: init?.headers?.authorization });
    if (state.mode === "refused") throw refusedError();
    if (state.mode === "hang") throw Object.assign(new Error("aborted"), { name: "AbortError" });
    if (state.mode === "transport") throw new TypeError("socket hang up");
    if (state.mode === "unauthorized") {
      return { status: 401, text: async () => JSON.stringify({ code: 40100, msg: "unauthorized" }) };
    }
    return { status: 200, text: async () => JSON.stringify({ code: 0, msg: "ok", data: { items: [], has_more: false } }) };
  };
  return { state, fetchImpl };
}

/** 一组临时目录 + 注入件。时钟以真实时间为基（坏锁用文件修改时间），每读一次前进 clockStepMs。 */
function harness({ clockStepMs = 500 } = {}) {
  const lockDir = mkdtempSync(join(tmpdir(), "wao-serve-lock-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "wao-serve-ws-"));
  const kimiHome = mkdtempSync(join(tmpdir(), "wao-serve-home-"));
  let clock = Date.now();
  const h = {
    lockDir,
    workspaceDir,
    kimiHome,
    spawns: [],
    nowMs: () => { clock += clockStepMs; return clock; },
    sleepFn: async () => {},
    lockPath: serveStartLockPath(PORT, lockDir),
    readLock: () => JSON.parse(readFileSync(serveStartLockPath(PORT, lockDir), "utf8")),
    cleanup: () => {
      for (const dir of [lockDir, workspaceDir, kimiHome]) rmSync(dir, { recursive: true, force: true });
    },
  };
  /** ensureServeRunning 的缺省入参：实例表为空、没有活着的旧进程、spawn 即视为 serve 起来。 */
  h.args = (serve, overrides = {}) => ({
    serveUrl: SERVE_URL, token: TOKEN, workspaceDir, kimiHome, kimiExe: process.execPath,
    env: BASE_ENV, fetchImpl: serve.fetchImpl,
    spawnFn: (exe, args, opts) => { h.spawns.push({ exe, args, opts }); serve.state.mode = "ok"; return { pid: 4242, unref() {} }; },
    sleepFn: h.sleepFn, nowMs: h.nowMs, lockDir,
    readInstancesFn: () => [], childAliveFn: () => false,
    ...overrides,
  });
  return h;
}

const NO_SPAWN = () => { throw new Error("must not spawn"); };

const BASE_ENV = Object.freeze({
  PATH: "",
  HTTPS_PROXY: "http://proxy.invalid:8080",
  FOO_API_KEY: "k-value",
  SOME_TOKEN: "t-value",
  KIMI_CODE_HOME: "X:\\inherited-home",
  NORMAL_VARIABLE: "1",
  WAO_ALLOW_NESTED_DISPATCH: "1",
  wao_allow_nested_dispatch: "1",
  WAO_TARGET_CWD: "D:\\lead-workspace",
  Wao_Verification_Gate: "1",
  WAO_IN_WORKER: "0",
});

test("0075: 首探不是连接被拒 → null，不拉起、不留锁；没声明工作目录或非回环地址 → 连探测都不发", async () => {
  const h = harness();
  try {
    // code 0、鉴权被拒、超时、其它传输错误：都不能证明端口上没有监听——不动，交给请求路径。
    for (const mode of ["ok", "unauthorized", "hang", "transport"]) {
      const serve = fakeServe(mode);
      assert.equal(await ensureServeRunning(h.args(serve, { spawnFn: NO_SPAWN })), null, mode);
      assert.equal(serve.state.calls.length, 1, `${mode}: 只探一次`);
      assert.equal(serve.state.calls[0].authorization, `Bearer ${TOKEN}`);
      assert.equal(existsSync(h.lockPath), false, mode);
    }
    const down = fakeServe("refused");
    for (const overrides of [
      { workspaceDir: undefined },
      { workspaceDir: "" },
      { serveUrl: "http://10.1.2.3:58999" },
      { serveUrl: "not a url" },
    ]) {
      assert.equal(await ensureServeRunning(h.args(down, { spawnFn: NO_SPAWN, ...overrides })), null, JSON.stringify(overrides));
    }
    assert.equal(down.state.calls.length, 0, "不满足前提时不发请求");
  } finally { h.cleanup(); }
});

test("0075: 连接被拒 → 拉起一次（args / cwd / env / detached），等到应答后返回 started 并放锁", async () => {
  const h = harness();
  try {
    const serve = fakeServe("refused");
    const r = await ensureServeRunning(h.args(serve));
    assert.deepEqual({ started: r.started, pid: r.pid, answer: r.answer }, { started: true, pid: 4242, answer: "ok" });
    assert.ok(r.waitedMs > 0);
    assert.equal(h.spawns.length, 1);
    const [s] = h.spawns;
    assert.equal(s.exe, process.execPath);
    assert.deepEqual(s.args, ["web", "--no-open", "--port", String(PORT)]);
    assert.equal(s.opts.cwd, h.workspaceDir);
    assert.equal(s.opts.detached, true);
    assert.equal(s.opts.stdio, "ignore");
    // 环境：worker 标记恒注入；主目录显式指定；密钥类变量不带；代理与普通变量保留。
    assert.equal(s.opts.env.WAO_IN_WORKER, "1");
    assert.equal(s.opts.env.KIMI_CODE_HOME, h.kimiHome);
    assert.equal("FOO_API_KEY" in s.opts.env, false);
    assert.equal("SOME_TOKEN" in s.opts.env, false);
    assert.equal(s.opts.env.HTTPS_PROXY, BASE_ENV.HTTPS_PROXY);
    assert.equal(s.opts.env.NORMAL_VARIABLE, "1");
    // 会审（sol / kimi）：WAO 自己的变量不进长命 serve——嵌套派发的命令级豁免（否则成了所有
    // worker 的常驻豁免）、验证闸门、目标工作区指向；名字不分大小写。worker 标记是注入的，
    // 不取继承来的值。
    assert.deepEqual(Object.keys(s.opts.env).filter((n) => /^WAO_/i.test(n)), ["WAO_IN_WORKER"]);
    assert.equal(existsSync(h.lockPath), false, "锁已释放");

    // 没声明 kimiHome 的车道：继承来的 KIMI_CODE_HOME 被删（不把默认家的 serve 起到别处）。
    const env = kimiServeChildEnv(BASE_ENV, null);
    assert.equal("KIMI_CODE_HOME" in env, false);
    assert.equal(env.WAO_IN_WORKER, "1");
  } finally { h.cleanup(); }
});

test("0075: 别的进程持有未陈旧的锁 → 不拉起，只等到应答（started:false），不动别人的锁；陈旧锁 → 接手并拉起", async () => {
  const h = harness();
  try {
    writeFileSync(h.lockPath, JSON.stringify({ pid: 1, nonce: "other", ts: h.nowMs() }));
    const serve = fakeServe("refused");
    let sleeps = 0;
    const r = await ensureServeRunning(h.args(serve, {
      spawnFn: NO_SPAWN,
      sleepFn: async () => { sleeps += 1; if (sleeps >= 2) serve.state.mode = "ok"; },
    }));
    assert.deepEqual({ started: r.started, pid: r.pid, answer: r.answer }, { started: false, pid: null, answer: "ok" });
    assert.equal(h.readLock().nonce, "other", "别人的锁留在原处");

    // 陈旧锁（持锁进程早就没了，也没有记着活着的子进程）。
    writeFileSync(h.lockPath, JSON.stringify({ pid: 1, nonce: "old", ts: 0 }));
    const serve2 = fakeServe("refused");
    const r2 = await ensureServeRunning(h.args(serve2));
    assert.equal(r2.started, true);
    assert.equal(h.spawns.length, 1);
    assert.equal(existsSync(h.lockPath), false, "接手的锁用完即放");
  } finally { h.cleanup(); }
});

test("0075 会审: 坏锁（空文件）按修改时间算陈旧——新鲜的照等，过期的可接手，不会永久挡路；锁文件写不了不挡路", async () => {
  const h = harness();
  try {
    // 新鲜的空锁：别人可能正在写——按别人持有处理。
    writeFileSync(h.lockPath, "");
    assert.deepEqual(acquireServeStartLock({ lockPath: h.lockPath, now: Date.now(), childAliveFn: () => false }), { held: false });
    // 修改时间在陈旧界之外的空锁：接手。
    const tenMinutesAgo = (Date.now() - 600_000) / 1000;
    utimesSync(h.lockPath, tenMinutesAgo, tenMinutesAgo);
    const taken = acquireServeStartLock({ lockPath: h.lockPath, now: Date.now(), childAliveFn: () => false });
    assert.equal(taken.held, true);
    assert.equal(h.readLock().nonce, taken.nonce);
    releaseServeStartLock(taken);
    assert.equal(existsSync(h.lockPath), false);

    // 端到端：过期的坏锁不挡拉起。
    writeFileSync(h.lockPath, "{ truncated");
    utimesSync(h.lockPath, tenMinutesAgo, tenMinutesAgo);
    const serve = fakeServe("refused");
    assert.equal((await ensureServeRunning(h.args(serve))).started, true);

    // 锁目录不存在（写不了）：没有去重就不拉——重复拉起的 serve 不会自己消失（它会改绑下一个
    // 端口继续运行）。报错点名锁文件位置。
    const serve2 = fakeServe("refused");
    const spawnsBefore = h.spawns.length;
    await assert.rejects(
      () => ensureServeRunning(h.args(serve2, { lockDir: join(h.lockDir, "missing-dir") })),
      (err) => err.message.includes("(start_lock_unavailable ") && err.message.includes("missing-dir") && !err.message.includes(TOKEN),
    );
    assert.equal(h.spawns.length, spawnsBefore, "零 spawn");
  } finally { h.cleanup(); }
});

test("0075 会审: 放锁只删自己的；recycle 占锁期间到来的派发只等", async () => {
  const h = harness();
  try {
    const mine = acquireServeStartLock({ lockPath: h.lockPath, now: Date.now(), childAliveFn: () => false });
    assert.equal(mine.held, true);
    // 别人（例如 recycle）覆盖了这把锁：我放锁时不能把它删掉。
    const theirs = holdServeStartLock({ port: PORT, lockDir: h.lockDir, now: Date.now() });
    releaseServeStartLock(mine);
    assert.equal(h.readLock().nonce, theirs.nonce, "不是自己的锁不删");

    // recycle 占着锁、serve 正在重启：派发不拉，等它应答。
    const serve = fakeServe("refused");
    let sleeps = 0;
    const r = await ensureServeRunning(h.args(serve, {
      spawnFn: NO_SPAWN,
      sleepFn: async () => { sleeps += 1; if (sleeps >= 3) serve.state.mode = "ok"; },
    }));
    assert.equal(r.started, false);
    releaseServeStartLock(theirs);
    assert.equal(existsSync(h.lockPath), false);
  } finally { h.cleanup(); }
});

test("0075 会审: 起了进程却等不到应答 → 报错并留下记着子进程的锁；那个进程还活着时后来的派发不再拉，死了且锁过期才接手", async () => {
  const h = harness({ clockStepMs: 10_000 });
  try {
    const serve = fakeServe("refused");
    const spawned = [];
    await assert.rejects(
      () => ensureServeRunning(h.args(serve, { spawnFn: (exe) => { spawned.push(exe); return { pid: 555, unref() {} }; } })),
      (err) => err.message.includes("could not be started (not_ready_in_time started pid 555, left running)")
        && !err.message.includes(TOKEN) && !err.message.includes(SERVE_URL),
    );
    assert.equal(spawned.length, 1);
    assert.equal(h.readLock().childPid, 555, "锁留下，里面记着那个进程");

    // 那个 kimi 进程还活着：不再拉，等不到就点名它——即使锁已经过了陈旧界。
    const stale = { ...h.readLock(), ts: 0 };
    writeFileSync(h.lockPath, JSON.stringify(stale));
    const serve2 = fakeServe("refused");
    await assert.rejects(
      () => ensureServeRunning(h.args(serve2, { spawnFn: NO_SPAWN, childAliveFn: (pid) => pid === 555 })),
      /not_ready_in_time waiting on earlier_start_still_running_without_answering pid 555/,
    );
    assert.equal(h.readLock().childPid, 555, "别人的锁不动");

    // 进程没了、锁也过期：接手并拉起。
    const serve3 = fakeServe("refused");
    const r = await ensureServeRunning(h.args(serve3, { childAliveFn: () => false }));
    assert.equal(r.started, true);
    assert.equal(existsSync(h.lockPath), false);
  } finally { h.cleanup(); }
});

test("0075 会审: serve 进程活着但没在监听（实例心跳新鲜且 pid 是活着的 kimi）→ 不拉、不建锁，等不到点名；记录是崩溃留下的 → 照常拉起", async () => {
  const h = harness({ clockStepMs: 10_000 });
  try {
    const instances = () => [{ serverId: "x", pid: 4321, port: PORT, startedAt: Date.now(), heartbeatAt: Date.now() + 3_600_000 }];
    const serve = fakeServe("refused");
    await assert.rejects(
      () => ensureServeRunning(h.args(serve, { spawnFn: NO_SPAWN, readInstancesFn: instances, childAliveFn: (pid) => pid === 4321 })),
      /not_ready_in_time waiting on serve_alive_not_listening pid 4321/,
    );
    assert.equal(existsSync(h.lockPath), false);

    // 同一条记录，但那个 pid 已经不是活着的 kimi 进程（崩溃 / 断电留下的记录）。
    const serve2 = fakeServe("refused");
    const r = await ensureServeRunning(h.args(serve2, { readInstancesFn: instances, childAliveFn: () => false }));
    assert.equal(r.started, true);
    // 别的端口的记录不相干。
    const serve3 = fakeServe("refused");
    const other = () => [{ serverId: "y", pid: 4321, port: PORT + 1, startedAt: Date.now(), heartbeatAt: Date.now() + 3_600_000 }];
    assert.equal((await ensureServeRunning(h.args(serve3, { readInstancesFn: other, childAliveFn: () => true }))).started, true);
  } finally { h.cleanup(); }
});

test("0075: 拉不起来 → 固定文案的错误（原因取自闭集，不含 token 与 serveUrl），自己的锁不残留", async () => {
  const h = harness({ clockStepMs: 10_000 });
  try {
    const expectStartError = async (overrides, reason) => {
      const serve = fakeServe("refused");
      const spawns = [];
      await assert.rejects(
        () => ensureServeRunning(h.args(serve, { spawnFn: (exe) => { spawns.push(exe); return { pid: 5, unref() {} }; }, ...overrides })),
        (err) => err.message.includes("is not running and could not be started")
          && err.message.includes(`(${reason})`) && !err.message.includes(SERVE_URL) && !err.message.includes(TOKEN),
        reason,
      );
      assert.equal(spawns.length, 0, `${reason}: 零 spawn`);
      assert.equal(existsSync(h.lockPath), false, `${reason}: 锁不残留`);
    };
    await expectStartError({ workspaceDir: join(h.workspaceDir, "missing") }, "workspace_dir_invalid");
    await expectStartError({ workspaceDir: h.kimiHome }, "workspace_dir_inside_kimi_home");
    await expectStartError({ kimiExe: join(h.workspaceDir, "no-such-kimi.exe") }, "kimi_exe_unresolvable");
    // spawn 自身失败：错误码只在形如 ENOENT 的闭集形状时带出。
    const serve = fakeServe("refused");
    await assert.rejects(
      () => ensureServeRunning(h.args(serve, { spawnFn: () => { const e = new Error("spawn ENOENT secret-path"); e.code = "ENOENT"; throw e; } })),
      (err) => err.message.includes("(kimi_spawn_failed ENOENT)") && !err.message.includes("secret-path"),
    );
    assert.equal(existsSync(h.lockPath), false);
    const serve2 = fakeServe("refused");
    await assert.rejects(
      () => ensureServeRunning(h.args(serve2, { spawnFn: () => { const e = new Error("x"); e.code = "weird code with spaces"; throw e; } })),
      (err) => err.message.includes("(kimi_spawn_failed)"),
    );
    // 别的进程在拉、但一直没起来：等到上界后报错，别人的锁不动。
    writeFileSync(h.lockPath, JSON.stringify({ pid: 1, nonce: "other", ts: h.nowMs() + 3_600_000 }));
    const serve3 = fakeServe("refused");
    await assert.rejects(
      () => ensureServeRunning(h.args(serve3, { spawnFn: NO_SPAWN })),
      (err) => err.message.includes("not_ready_in_time waiting on another_starter, lock file ") && err.message.includes(h.lockPath),
    );
    assert.equal(h.readLock().nonce, "other");
  } finally { h.cleanup(); }
});

test("0075 会审: 等待中的探测结果——HTTP 应答但不是 code 0 连续数拍 → 交回（answer=rejected）；超时与传输错误不算应答，继续等", async () => {
  const h = harness({ clockStepMs: 100 });
  try {
    // 拉起后端口有应答但不认这个 token（别的主目录的 serve 占了端口）。
    const serve = fakeServe("refused");
    const r = await ensureServeRunning(h.args(serve, { spawnFn: () => { serve.state.mode = "unauthorized"; return { pid: 7, unref() {} }; } }));
    assert.deepEqual({ started: r.started, answer: r.answer }, { started: true, answer: "rejected" });
    // 首探 1 + 循环首拍 1 + 持锁复探 1 + 连续 5 拍"有应答但不是 code 0"。
    assert.equal(serve.state.calls.length, 8);
    assert.equal(existsSync(h.lockPath), false);

    // 拉起后先是超时、再是传输错误（各若干拍），最后才 code 0：不提前交回。
    for (const flaky of ["hang", "transport"]) {
      const s = fakeServe("refused");
      let sleeps = 0;
      const r2 = await ensureServeRunning(h.args(s, {
        spawnFn: () => { s.state.mode = flaky; return { pid: 8, unref() {} }; },
        sleepFn: async () => { sleeps += 1; if (sleeps >= 9) s.state.mode = "ok"; },
      }));
      assert.deepEqual({ started: r2.started, answer: r2.answer }, { started: true, answer: "ok" }, flaky);
      assert.ok(s.state.calls.length >= 12, `${flaky}: 一直等到真的应答`);
    }
  } finally { h.cleanup(); }
});

test("0075 会审: 自己拉起的 serve 落在了别的端口（目标端口期间被别人占了）→ 请它优雅退出，本次不算拉起者；落在目标端口 → 不动", async () => {
  const h = harness();
  try {
    // 实测（kimi 2.1.1）：端口被占时第二个 kimi web 不退出，改绑下一个端口并登记实例。
    const serve = fakeServe("refused");
    const shutdowns = [];
    const displacedArgs = h.args(serve, {
      readInstancesFn: () => (h.spawns.length > 0 ? [{ serverId: "dup", pid: 4242, port: PORT + 1, startedAt: 1, heartbeatAt: 1 }] : []),
      shutdownFn: async (args) => { shutdowns.push(args); return { outcome: "requested" }; },
    });
    const r = await ensureServeRunning(displacedArgs);
    assert.deepEqual(
      { started: r.started, pid: r.pid, answer: r.answer, displaced: r.displaced },
      { started: false, pid: null, answer: "ok", displaced: { pid: 4242, port: PORT + 1, shutdown: "requested" } },
    );
    assert.equal(shutdowns.length, 1);
    assert.equal(shutdowns[0].baseUrl, `http://127.0.0.1:${PORT + 1}`, "只关自己拉起的那个（它所在的端口）");
    assert.equal(shutdowns[0].token, TOKEN, "同一主目录的 token");
    assert.equal(existsSync(h.lockPath), false);

    // 请不动：如实带回 failed。
    const serve2 = fakeServe("refused");
    const r2 = await ensureServeRunning(h.args(serve2, {
      readInstancesFn: () => [{ serverId: "dup", pid: 4242, port: PORT + 1, startedAt: 1, heartbeatAt: 1 }],
      shutdownFn: async () => ({ outcome: "failed", reason: "timeout" }),
      childAliveFn: () => false,
    }));
    assert.equal(r2.displaced.shutdown, "failed");

    // 自己的子进程就在目标端口上：不发任何关停请求。
    const serve3 = fakeServe("refused");
    const r3 = await ensureServeRunning(h.args(serve3, {
      readInstancesFn: () => (serve3.state.mode === "ok" ? [{ serverId: "mine", pid: 4242, port: PORT, startedAt: 1, heartbeatAt: 1 }] : []),
      shutdownFn: async () => { throw new Error("must not shut down"); },
    }));
    assert.deepEqual({ started: r3.started, pid: r3.pid, displaced: r3.displaced }, { started: true, pid: 4242, displaced: undefined });
  } finally { h.cleanup(); }
});
