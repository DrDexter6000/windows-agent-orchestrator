// test/backends/kimiServeStart.test.js
//
// 决定 0075：kimi worker serve 的按需拉起（ensureServeRunning）。零真进程——fetch、spawn、
// 睡眠、时钟全部注入；锁目录与 serve 工作目录用系统临时目录下的真实目录。
//
// 契约：
//   - serve 有应答 / 车道没声明工作目录 / 非回环地址 → 什么都不做（null）；
//   - 连接被拒 → 持锁者拉起一次（args / cwd / env / detached），等到应答后返回并放锁；
//   - 别的进程持锁 → 不拉起，只等；陈旧锁可接手；
//   - 拉不起来、等不到应答 → 固定文案的错误（不含 token），锁不残留。

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureServeRunning,
  kimiServeChildEnv,
  serveStartLockPath,
} from "../../src/backends/kimiServeStart.js";

const SERVE_URL = "http://127.0.0.1:58999";
const TOKEN = ["serve", "start", "tok", "0075"].join("-");

function refusedError() {
  const error = new TypeError("fetch failed");
  error.cause = { code: "ECONNREFUSED" };
  return error;
}

/** 假 serve：state.mode = refused | ok | unauthorized；记录每次请求。 */
function fakeServe(initialMode = "refused") {
  const state = { mode: initialMode, calls: [] };
  const fetchImpl = async (url, init) => {
    state.calls.push({ url, authorization: init?.headers?.authorization });
    if (state.mode === "refused") throw refusedError();
    if (state.mode === "unauthorized") {
      return { status: 401, text: async () => JSON.stringify({ code: 40100, msg: "unauthorized" }) };
    }
    return { status: 200, text: async () => JSON.stringify({ code: 0, msg: "ok", data: { items: [], has_more: false } }) };
  };
  return { state, fetchImpl };
}

/** 一组临时目录 + 注入件。clockStepMs：每读一次时钟前进多少。 */
function harness({ clockStepMs = 500 } = {}) {
  const lockDir = mkdtempSync(join(tmpdir(), "wao-serve-lock-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "wao-serve-ws-"));
  const kimiHome = mkdtempSync(join(tmpdir(), "wao-serve-home-"));
  let clock = 1_000_000;
  const spawns = [];
  return {
    lockDir,
    workspaceDir,
    kimiHome,
    spawns,
    nowMs: () => { clock += clockStepMs; return clock; },
    sleepFn: async () => {},
    lockPath: serveStartLockPath(58999, lockDir),
    cleanup: () => {
      for (const dir of [lockDir, workspaceDir, kimiHome]) rmSync(dir, { recursive: true, force: true });
    },
  };
}

const BASE_ENV = Object.freeze({
  PATH: "",
  HTTPS_PROXY: "http://proxy.invalid:8080",
  FOO_API_KEY: "k-value",
  SOME_TOKEN: "t-value",
  KIMI_CODE_HOME: "X:\\inherited-home",
  NORMAL_VARIABLE: "1",
});

test("0075: serve 有应答 → null，不拉起、不留锁；没声明工作目录或非回环地址 → 连探测都不发", async () => {
  const h = harness();
  try {
    const up = fakeServe("ok");
    const r = await ensureServeRunning({
      serveUrl: SERVE_URL, token: TOKEN, workspaceDir: h.workspaceDir, kimiHome: h.kimiHome, kimiExe: process.execPath,
      env: BASE_ENV, fetchImpl: up.fetchImpl, spawnFn: () => { throw new Error("must not spawn"); },
      sleepFn: h.sleepFn, nowMs: h.nowMs, lockDir: h.lockDir,
    });
    assert.equal(r, null);
    assert.equal(up.state.calls.length, 1, "只探一次");
    assert.equal(up.state.calls[0].authorization, `Bearer ${TOKEN}`);
    assert.equal(existsSync(h.lockPath), false);

    // 鉴权被拒也是"有应答"：不动，交给请求路径去报。
    const rejecting = fakeServe("unauthorized");
    assert.equal(await ensureServeRunning({
      serveUrl: SERVE_URL, token: TOKEN, workspaceDir: h.workspaceDir, fetchImpl: rejecting.fetchImpl,
      spawnFn: () => { throw new Error("must not spawn"); }, sleepFn: h.sleepFn, nowMs: h.nowMs, lockDir: h.lockDir,
    }), null);

    const down = fakeServe("refused");
    for (const args of [
      { serveUrl: SERVE_URL, workspaceDir: undefined },
      { serveUrl: SERVE_URL, workspaceDir: "" },
      { serveUrl: "http://10.1.2.3:58999", workspaceDir: h.workspaceDir },
      { serveUrl: "not a url", workspaceDir: h.workspaceDir },
    ]) {
      assert.equal(await ensureServeRunning({
        ...args, token: TOKEN, fetchImpl: down.fetchImpl, spawnFn: () => { throw new Error("must not spawn"); },
        sleepFn: h.sleepFn, nowMs: h.nowMs, lockDir: h.lockDir,
      }), null, JSON.stringify(args));
    }
    assert.equal(down.state.calls.length, 0, "不满足前提时不发请求");
  } finally { h.cleanup(); }
});

test("0075: 连接被拒 → 拉起一次（args / cwd / env / detached），等到应答后返回 started 并放锁", async () => {
  const h = harness();
  try {
    const serve = fakeServe("refused");
    const spawnFn = (exe, args, opts) => {
      h.spawns.push({ exe, args, opts });
      serve.state.mode = "ok"; // serve 起来了
      return { pid: 4242, unref() {} };
    };
    const r = await ensureServeRunning({
      serveUrl: SERVE_URL, token: TOKEN, workspaceDir: h.workspaceDir, kimiHome: h.kimiHome, kimiExe: process.execPath,
      env: BASE_ENV, fetchImpl: serve.fetchImpl, spawnFn, sleepFn: h.sleepFn, nowMs: h.nowMs, lockDir: h.lockDir,
    });
    assert.equal(r.started, true);
    assert.equal(r.pid, 4242);
    assert.ok(r.waitedMs > 0);
    assert.equal(h.spawns.length, 1);
    const [s] = h.spawns;
    assert.equal(s.exe, process.execPath);
    assert.deepEqual(s.args, ["web", "--no-open", "--port", "58999"]);
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
    assert.equal(existsSync(h.lockPath), false, "锁已释放");

    // 没声明 kimiHome 的车道：继承来的 KIMI_CODE_HOME 被删（不把默认家的 serve 起到别处）。
    const env = kimiServeChildEnv(BASE_ENV, null);
    assert.equal("KIMI_CODE_HOME" in env, false);
    assert.equal(env.WAO_IN_WORKER, "1");
  } finally { h.cleanup(); }
});

test("0075: 别的进程持锁 → 不拉起，只等到应答（started:false），不动别人的锁；陈旧锁 → 接手并拉起", async () => {
  const h = harness();
  try {
    // 新鲜锁（别人正在拉）。
    writeFileSync(h.lockPath, JSON.stringify({ pid: 1, ts: h.nowMs() }));
    const serve = fakeServe("refused");
    let sleeps = 0;
    const r = await ensureServeRunning({
      serveUrl: SERVE_URL, token: TOKEN, workspaceDir: h.workspaceDir, kimiHome: h.kimiHome, kimiExe: process.execPath,
      env: BASE_ENV, fetchImpl: serve.fetchImpl, spawnFn: () => { throw new Error("must not spawn"); },
      sleepFn: async () => { sleeps += 1; if (sleeps >= 2) serve.state.mode = "ok"; },
      nowMs: h.nowMs, lockDir: h.lockDir,
    });
    assert.deepEqual({ started: r.started, pid: r.pid }, { started: false, pid: null });
    assert.equal(existsSync(h.lockPath), true, "别人的锁留在原处");
    assert.equal(JSON.parse(readFileSync(h.lockPath, "utf8")).pid, 1);

    // 陈旧锁（持锁进程早就没了）。
    writeFileSync(h.lockPath, JSON.stringify({ pid: 1, ts: 0 }));
    const serve2 = fakeServe("refused");
    const r2 = await ensureServeRunning({
      serveUrl: SERVE_URL, token: TOKEN, workspaceDir: h.workspaceDir, kimiHome: h.kimiHome, kimiExe: process.execPath,
      env: BASE_ENV, fetchImpl: serve2.fetchImpl,
      spawnFn: (exe, args, opts) => { h.spawns.push({ exe, args, opts }); serve2.state.mode = "ok"; return { pid: 99, unref() {} }; },
      sleepFn: h.sleepFn, nowMs: h.nowMs, lockDir: h.lockDir,
    });
    assert.equal(r2.started, true);
    assert.equal(h.spawns.length, 1);
    assert.equal(existsSync(h.lockPath), false, "接手的锁用完即放");
  } finally { h.cleanup(); }
});

test("0075: 拉不起来 → 固定文案的错误（点名原因，不含 token），零残留锁", async () => {
  const h = harness({ clockStepMs: 10_000 });
  try {
    const common = {
      serveUrl: SERVE_URL, token: TOKEN, kimiHome: h.kimiHome, env: BASE_ENV,
      sleepFn: h.sleepFn, nowMs: h.nowMs, lockDir: h.lockDir,
    };
    const expectStartError = async (overrides, reason, { spawnsExpected = 0 } = {}) => {
      const serve = fakeServe("refused");
      const spawns = [];
      await assert.rejects(
        () => ensureServeRunning({
          ...common, workspaceDir: h.workspaceDir, kimiExe: process.execPath, fetchImpl: serve.fetchImpl,
          spawnFn: (exe) => { spawns.push(exe); return { pid: 5, unref() {} }; },
          ...overrides,
        }),
        (err) => err.message.includes("is not running and could not be started")
          && err.message.includes(reason) && err.message.includes(SERVE_URL) && !err.message.includes(TOKEN),
        reason,
      );
      assert.equal(spawns.length, spawnsExpected, `${reason}: spawn 次数`);
      assert.equal(existsSync(h.lockPath), false, `${reason}: 锁不残留`);
    };
    // serve 起了进程但一直不应答。
    await expectStartError({}, "not_ready_in_time", { spawnsExpected: 1 });
    // 工作目录不存在 / 在 kimi 主目录内；exe 解析不到；spawn 自身失败。
    await expectStartError({ workspaceDir: join(h.workspaceDir, "missing") }, "workspace_dir_invalid");
    await expectStartError({ workspaceDir: h.kimiHome }, "workspace_dir_inside_kimi_home");
    await expectStartError({ kimiExe: join(h.workspaceDir, "no-such-kimi.exe") }, "kimi_exe_unresolvable");
    await expectStartError(
      { spawnFn: () => { const e = new Error("spawn ENOENT"); e.code = "ENOENT"; throw e; } },
      "kimi_spawn_failed ENOENT",
    );
    // 别的进程在拉、但一直没起来：等到上界后同样报错，别人的锁不动。
    writeFileSync(h.lockPath, JSON.stringify({ pid: 1, ts: h.nowMs() }));
    const serve = fakeServe("refused");
    await assert.rejects(
      () => ensureServeRunning({
        ...common, workspaceDir: h.workspaceDir, kimiExe: process.execPath, fetchImpl: serve.fetchImpl,
        spawnFn: () => { throw new Error("must not spawn"); },
      }),
      /not_ready_in_time_while_another_run_was_starting_it/,
    );
    assert.equal(existsSync(h.lockPath), true);
  } finally { h.cleanup(); }
});

test("0075: 拉起后端口有应答但不认这个 token（别的主目录的 serve 占着端口）→ 数拍后交回请求路径，不在这里卡到超时", async () => {
  const h = harness({ clockStepMs: 100 });
  try {
    const serve = fakeServe("refused");
    const r = await ensureServeRunning({
      serveUrl: SERVE_URL, token: TOKEN, workspaceDir: h.workspaceDir, kimiHome: h.kimiHome, kimiExe: process.execPath,
      env: BASE_ENV, fetchImpl: serve.fetchImpl,
      spawnFn: () => { serve.state.mode = "unauthorized"; return { pid: 7, unref() {} }; },
      sleepFn: h.sleepFn, nowMs: h.nowMs, lockDir: h.lockDir,
    });
    assert.equal(r.started, true);
    // 首探 1 + 持锁复探 1 + 连续 5 拍"有应答但不是 code 0"。
    assert.equal(serve.state.calls.length, 7);
    assert.equal(existsSync(h.lockPath), false);
  } finally { h.cleanup(); }
});
