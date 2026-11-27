// test/commands/dashboardServe.test.js
//
// 第 145b 批（修正一 #8/#11 改定）：`dashboard serve` 实例进程的启动期与生命周期
// （注入缝；无真实监听、无 PowerShell、无 WMI——真实链路在 ownerDashboardE2e.test.js）。
//   - 状态目录核对不过 → result(state_dir_rejected)，退出码 1；
//   - 监听 EADDRINUSE → result(port_in_use)；
//   - 监听后每条失败路径统一收尾（读不出创建时间 / 写候选失败 / codes 清空失败）：
//     写 result、有界关服务、退出码 1，不抛错不挂住；
//   - close() 一直不完成 → 停机预算硬出口，退出码 1；
//   - 截止时间过了还没被发布（迟到的失败者）→ 关服务退出，不删别人的记录；
//   - 收到对得上的停机请求 → 优雅退出 + 删自己这一代的 candidate 与 stop 请求，
//     只在记录仍是自己代际时按内容核对地删它；错 nonce 的请求被无视；
//   - 发布后被换成别的代际（被替换的旧代）→ 退出，新记录保留；
//   - 候选携带自己加载的 build；写候选之前先清空 codes 的全部旧码。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dashboardServeCommand } from "../../src/commands/dashboardServe.js";
import { normalizeRunDir, stateDirFor } from "../../src/application/dashboardPaths.js";

const GEN = "0123456789abcdef";

function world(overrides = {}) {
  const w = {
    stateDirOk: true,
    listenError: null,
    port: 9471,
    exits: [],
    closed: 0,
    connectionsClosed: 0,
    instance: null, // 模拟 instance.json 的内容（由测试推进）
    ...overrides,
  };
  const base = mkdtempSync(join(tmpdir(), "wao-serve-unit-"));
  mkdirSync(join(base, "runs"), { recursive: true });
  const runDir = normalizeRunDir(join(base, "runs"));
  const stateRoot = join(base, "state");
  const stateDir = stateDirFor(runDir, stateRoot);
  mkdirSync(stateDir, { recursive: true });
  const args = ["--run-dir", join(base, "runs"), "--state-root", stateRoot, "--generation", GEN];

  const fakeServer = {
    nonce: "ab".repeat(16),
    server: { closeAllConnections() { w.connectionsClosed += 1; } },
    listen: async () => {
      if (w.listenError !== null) throw w.listenError;
      return { port: w.port, host: "127.0.0.1", family: "IPv4" };
    },
    close: async () => { w.closed += 1; },
  };

  return {
    w, base, stateDir, runDir,
    injections: {
      log: () => {},
      createServerFn: () => fakeServer,
      verifyStateDirFn: async () => (w.stateDirOk ? { ok: true } : { ok: false, reason: "acl_rejected" }),
      readCreatedAtFn: async () => 1_700_000_000_000,
      exitFn: (code) => { w.exits.push(code); },
      stopBudgetMs: 250,
    },
    args,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

const readInstance = (stateDir) => {
  try {
    return JSON.parse(readFileSync(join(stateDir, "instance.json"), "utf8"));
  } catch {
    return null;
  }
};
const readResult = (stateDir) => {
  try {
    return JSON.parse(readFileSync(join(stateDir, `result-${GEN}.json`), "utf8"));
  } catch {
    return null;
  }
};

/** 假服务器没有监听句柄：用一个 ref 的定时器撑住事件循环（生产由监听句柄承担）。 */
const holdLoop = () => setInterval(() => {}, 50);

test("serve: a rejected state dir writes result(state_dir_rejected) and exits non-zero", async (t) => {
  const setup = world({ stateDirOk: false });
  t.after(setup.cleanup);
  await dashboardServeCommand(setup.args, {}, setup.injections);
  assert.deepEqual(readResult(setup.stateDir), { reason: "state_dir_rejected" });
  assert.equal(setup.w.exits[0], 1);
});

test("serve: EADDRINUSE writes result(port_in_use) — the squatter is neither adopted nor killed", async (t) => {
  const setup = world({});
  setup.w.listenError = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
  t.after(setup.cleanup);
  await dashboardServeCommand(setup.args, {}, setup.injections);
  assert.deepEqual(readResult(setup.stateDir), { reason: "port_in_use" });
  assert.equal(setup.w.exits[0], 1);
  assert.equal(existsSync(join(setup.stateDir, `candidate-${GEN}.json`)), false, "no candidate for a failed listen");
});

test("serve (145b-fix): an unreadable own creation time is a bounded failure AFTER listen — result written, closed, exit 1, no throw", async (t) => {
  const setup = world({});
  setup.injections.readCreatedAtFn = async () => null;
  t.after(setup.cleanup);
  await dashboardServeCommand(setup.args, {}, setup.injections);
  assert.deepEqual(readResult(setup.stateDir), { reason: "serve_error" });
  assert.deepEqual(setup.w.exits, [1], "exit code 1, exactly once, no hang");
  assert.equal(setup.w.closed, 1, "the listening server was closed");
  assert.equal(existsSync(join(setup.stateDir, `candidate-${GEN}.json`)), false, "no candidate without a creation time");
});

test("serve (145b-fix): a FAILED candidate write is a bounded failure — result written, closed, exit 1", async (t) => {
  const setup = world({});
  setup.injections.writeCandidateFn = async () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };
  t.after(setup.cleanup);
  await dashboardServeCommand(setup.args, {}, setup.injections);
  assert.deepEqual(readResult(setup.stateDir), { reason: "serve_error" });
  assert.deepEqual(setup.w.exits, [1]);
  assert.equal(setup.w.closed, 1, "the poll timer never existed — the unified fail path closed the server");
});

test("serve (145b-fix): a FAILED instance-log write after listen is a bounded failure — result written, closed, exit 1", async (t) => {
  const setup = world({});
  let lines = 0;
  setup.injections.createLoggerFn = () => ({
    line() {
      lines += 1;
      if (lines >= 2) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }); // 第二行（监听成功之后）起写不进
    },
  });
  t.after(setup.cleanup);
  await dashboardServeCommand(setup.args, {}, setup.injections);
  assert.ok(lines >= 2, "the log was actually written to (and failed)");
  assert.deepEqual(readResult(setup.stateDir), { reason: "serve_error" });
  assert.deepEqual(setup.w.exits, [1], "exit code 1, exactly once, no throw, no hang");
  assert.equal(setup.w.closed, 1, "the listening server was closed by the unified failure path");
  assert.equal(existsSync(join(setup.stateDir, `candidate-${GEN}.json`)), false, "no candidate without a working log");
});

test("serve (145b-fix): an incomplete codes purge refuses to serve (bounded, result written)", async (t) => {
  const setup = world({});
  setup.injections.purgeFn = async () => ({ ok: false, purged: 2, remaining: 3 });
  t.after(setup.cleanup);
  await dashboardServeCommand(setup.args, {}, setup.injections);
  assert.deepEqual(readResult(setup.stateDir), { reason: "serve_error" });
  assert.deepEqual(setup.w.exits, [1]);
  assert.equal(setup.w.closed, 1);
  assert.equal(existsSync(join(setup.stateDir, `candidate-${GEN}.json`)), false, "no candidate before a clean codes dir");
});

test("serve (145b-fix): a stuck server.close() hits the stop-budget hard exit — code 1, no hang", async (t) => {
  const setup = world({});
  const stuckServer = {
    nonce: "ab".repeat(16),
    server: { closeAllConnections() { setup.w.connectionsClosed += 1; } },
    listen: async () => ({ port: setup.w.port, host: "127.0.0.1", family: "IPv4" }),
    close: () => new Promise(() => {}), // 在途刷新永远不完成
  };
  setup.injections.createServerFn = () => stuckServer;
  const hold = holdLoop();
  const args = [...setup.args, "--deadline", String(Date.now() + 1200)];
  const started = Date.now();
  await dashboardServeCommand(args, {}, setup.injections);
  clearInterval(hold);
  assert.deepEqual(setup.w.exits, [1], "the budget exit fired with code 1");
  assert.equal(readResult(setup.stateDir), null, "a late-loser exit is not a failure result");
  assert.ok(Date.now() - started < 5000, "bounded: far below the test timeout");
});

test("serve (145b-fix): the codes dir is PURGED (previous generation's codes die with the generation) before the candidate is written", async (t) => {
  const setup = world({});
  const order = [];
  setup.injections.purgeFn = async (dir) => { order.push("purge"); return { ok: true, purged: 1, remaining: 0 }; };
  let capturedCandidate = null;
  setup.injections.writeCandidateFn = async (...a) => { order.push("candidate"); capturedCandidate = a[2]; return (await import("../../src/application/dashboardFiles.js")).writeCandidateRecord(...a); };
  t.after(setup.cleanup);
  const hold = holdLoop();
  const args = [...setup.args, "--deadline", String(Date.now() + 60_000)];
  const command = dashboardServeCommand(args, {}, setup.injections);
  await new Promise((r) => setTimeout(r, 300));
  writeFileSync(join(setup.stateDir, `stop-${GEN}.request`), JSON.stringify({ nonce: "ab".repeat(16) }));
  await command;
  clearInterval(hold);
  assert.deepEqual(order, ["purge", "candidate"], "purge happens before the candidate exists");
  assert.ok(capturedCandidate.build && typeof capturedCandidate.build.readable === "boolean", "the candidate carries the serve's own build");
  assert.equal(existsSync(join(setup.stateDir, `candidate-${GEN}.json`)), false, "the exited instance cleaned its own candidate");
});

test("serve: an unpublished generation past its deadline is a late loser — it closes and exits, touching no record", async (t) => {
  const setup = world({});
  t.after(setup.cleanup);
  const others = { protocol: 1, runDir: setup.runDir, pid: 1, processCreatedAt: 1, port: 1, nonce: "cd".repeat(16), generation: "ffffffffffffffff", build: { readable: false, srcTree: null, dirty: null } };
  writeFileSync(join(setup.stateDir, "instance.json"), JSON.stringify(others));
  const args = [...setup.args, "--deadline", String(Date.now() + 1200)];
  const hold = holdLoop();
  await dashboardServeCommand(args, {}, setup.injections);
  clearInterval(hold);
  assert.deepEqual(setup.w.exits, [0]);
  assert.equal(setup.w.closed, 1, "the server was closed");
  assert.deepEqual(readInstance(setup.stateDir), others, "another generation's record is untouched");
  assert.equal(existsSync(join(setup.stateDir, `candidate-${GEN}.json`)), false, "its own candidate was cleaned up on exit");
});

test("serve: a matching stop request stops it gracefully; its OWN record, candidate and stop request are removed; a wrong nonce is ignored", async (t) => {
  const setup = world({});
  t.after(setup.cleanup);
  const args = [...setup.args, "--deadline", String(Date.now() + 60_000)];
  const hold = holdLoop();
  const command = dashboardServeCommand(args, {}, setup.injections);
  await new Promise((r) => setTimeout(r, 300));
  const mine = { protocol: 1, runDir: setup.runDir, pid: process.pid, processCreatedAt: 1_700_000_000_000, port: setup.w.port, nonce: "ab".repeat(16), generation: GEN, build: { readable: true, srcTree: "f".repeat(40), dirty: false } };
  writeFileSync(join(setup.stateDir, "instance.json"), JSON.stringify(mine));
  // 先来一个错 nonce 的请求：必须被无视。
  writeFileSync(join(setup.stateDir, `stop-${GEN}.request`), JSON.stringify({ nonce: "ff".repeat(16) }));
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(setup.w.exits, [], "a wrong-nonce request never stops the instance");
  // 对得上的请求：优雅退出并清理。
  writeFileSync(join(setup.stateDir, `stop-${GEN}.request`), JSON.stringify({ nonce: "ab".repeat(16) }));
  await command;
  clearInterval(hold);
  assert.deepEqual(setup.w.exits, [0]);
  assert.equal(setup.w.closed, 1);
  assert.equal(readInstance(setup.stateDir), null, "its own instance.json was removed (content-verified)");
  assert.equal(existsSync(join(setup.stateDir, `candidate-${GEN}.json`)), false, "own candidate removed");
  assert.equal(existsSync(join(setup.stateDir, `stop-${GEN}.request`)), false, "own stop request removed");
});

test("serve: once published, being superseded by another generation exits the old one; the NEW record and ITS files survive", async (t) => {
  const setup = world({});
  t.after(setup.cleanup);
  const args = [...setup.args, "--deadline", String(Date.now() + 60_000)];
  const hold = holdLoop();
  const command = dashboardServeCommand(args, {}, setup.injections);
  await new Promise((r) => setTimeout(r, 300));
  const mine = { protocol: 1, runDir: setup.runDir, pid: process.pid, processCreatedAt: 1_700_000_000_000, port: setup.w.port, nonce: "ab".repeat(16), generation: GEN, build: { readable: true, srcTree: "f".repeat(40), dirty: false } };
  writeFileSync(join(setup.stateDir, "instance.json"), JSON.stringify(mine));
  await new Promise((r) => setTimeout(r, 1500)); // 等一轮轮询先"看到"自己的发布
  writeFileSync(join(setup.stateDir, "instance.json"), JSON.stringify({ ...mine, generation: "9999888877776666", nonce: "cd".repeat(16) }));
  await command;
  clearInterval(hold);
  assert.deepEqual(setup.w.exits, [0]);
  const kept = readInstance(setup.stateDir);
  assert.notEqual(kept, null, "the NEW generation's record is kept");
  assert.equal(kept.generation, "9999888877776666");
  assert.equal(existsSync(join(setup.stateDir, `candidate-${GEN}.json`)), false, "the OLD generation's candidate was still cleaned (own name only)");
});
