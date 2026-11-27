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
//   - 候选携带自己加载的 build；实例启动**不碰 codes\**（没有换代清空）：没被发布的候选不会
//     误伤当前实例已发出的码，过期/别代的码只由已发布实例的低频清理收走；
//   - 实例轮询只在"读到别的代际"或"连续两次确实不存在"时判定被替换，读出错下一轮再看；
//     到截止时刻没看到发布，要再读一次记录确实不是自己才退出（修正二第 4、5 条）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { dashboardServeCommand } from "../../src/commands/dashboardServe.js";
import { normalizeRunDir, stateDirFor, DASHBOARD_LAUNCH_DEADLINE_MS } from "../../src/application/dashboardPaths.js";
import { issueStartCode, redeemStartCode } from "../../src/application/dashboardCodes.js";
import { codesDirOf } from "../../src/application/dashboardFiles.js";

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

const OTHER_GEN = "fedcba9876543210";
const NONCE = "ab".repeat(16);

const ownRecord = (setup, extra = {}) => ({
  protocol: 1, runDir: setup.runDir, pid: process.pid, processCreatedAt: 1_700_000_000_000,
  port: setup.w.port, nonce: NONCE, generation: GEN, build: { readable: true, srcTree: "f".repeat(40), dirty: false }, ...extra,
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 有上限的条件等待：条件一成立立刻返回；上限只是机器很忙时的兜底，不是要等的时间。
async function waitFor(predicate, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await sleep(10);
  }
  return false;
}
const candidateUp = (setup) => existsSync(join(setup.stateDir, `candidate-${GEN}.json`));
const writeStop = (setup) => writeFileSync(join(setup.stateDir, `stop-${GEN}.request`), JSON.stringify({ nonce: NONCE }));

test("serve (145b-fix2): an UNPUBLISHED candidate never touches codes\\ — the live instance's codes stay redeemable (no startup purge), and the server is handed its generation", async (t) => {
  const setup = world({});
  t.after(setup.cleanup);
  setup.injections.pollMs = 25;
  const codesDir = codesDirOf(setup.stateDir);
  // 当前实例（另一代）刚发出去的码，以及一张已过期的别代码：一个没被发布的候选两样都不该碰。
  const live = issueStartCode(codesDir, OTHER_GEN);
  const expired = issueStartCode(codesDir, OTHER_GEN, { now: () => Date.now() - 10 * 60_000 });
  const created = [];
  const original = setup.injections.createServerFn;
  setup.injections.createServerFn = (input) => { created.push(input); return original(input); };
  let sweeps = 0;
  setup.injections.sweepFn = async () => { sweeps += 1; return 0; };
  const hold = holdLoop();
  await dashboardServeCommand([...setup.args, "--deadline", String(Date.now() + 600)], {}, setup.injections);
  clearInterval(hold);
  assert.deepEqual(setup.w.exits, [0], "the unpublished candidate exited as a late loser");
  assert.equal(created[0].generation, GEN, "the server is told which generation's codes it may redeem");
  assert.equal(created[0].codesDir, codesDir);
  assert.equal(sweeps, 0, "an unpublished candidate never sweeps");
  assert.ok(existsSync(live.file) && existsSync(expired.file), "codes\\ is exactly as it was: nothing purged, nothing swept");
  assert.equal(await redeemStartCode(codesDir, live.code, { generation: OTHER_GEN }), true, "the live instance's code still redeems");
});

test("serve (145b-fix2): the low-frequency code sweep starts only once the instance SEES its own record published", async (t) => {
  const setup = world({});
  t.after(setup.cleanup);
  setup.injections.pollMs = 20;
  let sweeps = 0;
  setup.injections.sweepFn = async () => { sweeps += 1; return 0; };
  const hold = holdLoop();
  const command = dashboardServeCommand([...setup.args, "--deadline", String(Date.now() + 60_000)], {}, setup.injections);
  assert.equal(await waitFor(() => candidateUp(setup)), true, "the instance is up and polling");
  await sleep(100); // 反向断言：给它几个轮询周期的机会去（错误地）清理
  assert.equal(sweeps, 0, "before publication: no sweep");
  writeFileSync(join(setup.stateDir, "instance.json"), JSON.stringify(ownRecord(setup)));
  assert.equal(await waitFor(() => sweeps >= 1), true, "after publication the sweep runs");
  writeStop(setup);
  await command;
  clearInterval(hold);
  assert.deepEqual(setup.w.exits, [0]);
});

/** 按脚本回放 instance.json 的读取结果（脚本读完后一律回"自己的记录"）。 */
function scriptedReads(setup, script) {
  let at = 0;
  const own = ownRecord(setup);
  return {
    consumed: () => at,
    fn: async () => {
      const item = at < script.length ? script[at] : "own";
      at += 1;
      if (item === "absent") return { status: "absent" };
      if (item === "error") return { status: "error" };
      if (item === "garbled") return { status: "present", raw: null, record: null }; // 在，但内容不认识（外部非原子写到一半等）
      if (item === "other") { const rec = ownRecord(setup, { generation: "9999888877776666", nonce: "cd".repeat(16) }); return { status: "present", raw: rec, record: rec }; }
      return { status: "present", raw: own, record: own };
    },
  };
}

async function runScripted(script) {
  const setup = world({});
  setup.injections.pollMs = 15;
  const reads = scriptedReads(setup, script);
  setup.injections.readInstanceFn = reads.fn;
  const hold = holdLoop();
  const command = dashboardServeCommand([...setup.args, "--deadline", String(Date.now() + 60_000)], {}, setup.injections);
  await waitFor(() => reads.consumed() >= script.length + 6 || setup.w.exits.length > 0);
  const exitedBeforeStop = [...setup.w.exits];
  if (exitedBeforeStop.length === 0) writeStop(setup);
  await command;
  clearInterval(hold);
  setup.cleanup();
  return { exitedBeforeStop, consumed: reads.consumed() };
}

test("serve (145b-fix2): one absent read — or absent / error / absent — is NOT 'replaced'; only another generation or two CONSECUTIVE absences are", async () => {
  for (const script of [
    ["own", "absent", "own", "absent", "own"],
    ["own", "absent", "error", "absent", "own"],
    ["own", "error", "error", "error", "own"],
    ["own", "garbled", "garbled", "garbled", "own"], // 内容不认识 ≠ 别的代际：下一轮再看
  ]) {
    const run = await runScripted(script);
    assert.deepEqual(run.exitedBeforeStop, [], `still serving after ${JSON.stringify(script)}`);
    assert.ok(run.consumed >= script.length, "the script really ran");
  }
  for (const script of [["own", "absent", "absent"], ["own", "other"]]) {
    const run = await runScripted(script);
    assert.deepEqual(run.exitedBeforeStop, [0], `replaced (clean exit) after ${JSON.stringify(script)}`);
  }
  // 还没被发布时，"不存在"本来就是常态：不判定任何事。
  const unpublished = await runScripted(["absent", "absent", "absent"]);
  assert.deepEqual(unpublished.exitedBeforeStop, [], "absence before publication is not a replacement");
});

test("serve (145b-fix2): at the deadline the instance reads the record ONE MORE time — only a record that is truly not its own makes it exit", async (t) => {
  const keepAlive = async (secondRead) => {
    const setup = world({});
    setup.injections.pollMs = 15;
    const deadline = Date.now() + 60_000;
    setup.injections.nowFn = () => deadline + 10; // 钟已过截止
    let reads = 0;
    const own = ownRecord(setup);
    setup.injections.readInstanceFn = async () => {
      reads += 1;
      if (reads % 2 === 1) return { status: "absent" }; // 每轮第一次读：还没看到发布
      return secondRead === "own" ? { status: "present", raw: own, record: own } : { status: secondRead };
    };
    const hold = holdLoop();
    const command = dashboardServeCommand([...setup.args, "--deadline", String(deadline)], {}, setup.injections);
    // 等到"该发生的事"发生（有上限的条件等待，不靠固定睡眠）：
    //   要退出的那一支等退出；要活着的两支等到至少两个完整轮询（每轮读两次）之后再断言还活着。
    if (secondRead === "absent") await waitFor(() => setup.w.exits.length > 0);
    else await waitFor(() => reads >= 4 || setup.w.exits.length > 0);
    const alive = setup.w.exits.length === 0;
    if (alive) writeStop(setup);
    await command;
    clearInterval(hold);
    setup.cleanup();
    return { alive, reads };
  };
  const published = await keepAlive("own");
  assert.equal(published.alive, true, "a publication that landed just before the deadline keeps the instance alive");
  assert.ok(published.reads >= 2);
  const unknown = await keepAlive("error");
  assert.equal(unknown.alive, true, "an unreadable second read is 'look again next round', not an exit");
  const gone = await keepAlive("absent");
  assert.equal(gone.alive, false, "two absent reads at the deadline: truly unpublished, it exits");
});

/** 一个真子进程，在 ms 毫秒内反复调用 dashboardFiles 的移除原语（旧代的收尾）。 */
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
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir, fnName, arg, String(ms)], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  const done = new Promise((resolve) => {
    child.once("exit", () => resolve(Number(out.trim()) || 0));
    child.once("error", () => resolve(0));
  });
  return { done, kill: () => { try { child.kill(); } catch { /* 已退出 */ } } };
}

test("serve (145b-fix2) REAL TWO PROCESSES: an old generation hammering its own cleanup never makes the LIVE instance conclude it was replaced", async (t) => {
  const setup = world({});
  t.after(setup.cleanup);
  setup.injections.pollMs = 10;
  let sweeps = 0; // 低频清理只在实例看到自己的发布之后才开始——借它观察"轮询已经看到发布"
  setup.injections.sweepFn = async () => { sweeps += 1; return 0; };
  const hold = holdLoop();
  const command = dashboardServeCommand([...setup.args, "--deadline", String(Date.now() + 60_000)], {}, setup.injections);
  assert.equal(await waitFor(() => candidateUp(setup)), true, "the instance is up");
  writeFileSync(join(setup.stateDir, "instance.json"), JSON.stringify(ownRecord(setup)));
  assert.equal(await waitFor(() => sweeps >= 1), true, "the poll has SEEN its own publication");
  // 另一个真进程：旧代反复收尾（删"自己的"记录——代际对不上，它什么都不该碰）。
  const old = hammer(setup.stateDir, "removeInstanceRecordIfGeneration", OTHER_GEN, 1800);
  try {
    const calls = await old.done;
    assert.ok(calls > 20, `the other process really hammered (${calls} calls)`);
    assert.deepEqual(setup.w.exits, [], "the live instance never judged itself replaced while the old generation was cleaning up");
    assert.equal(readInstance(setup.stateDir)?.generation, GEN, "its record was never taken");
  } finally {
    old.kill();
    writeStop(setup);
    await command;
    clearInterval(hold);
  }
});

test("serve (145b-fix3): an unpublished candidate whose reads keep failing past the deadline does not live forever — it exits once the failure has lasted a launch deadline", async (t) => {
  const setup = world({});
  t.after(setup.cleanup);
  setup.injections.pollMs = 15;
  const deadline = Date.now() + 60_000;
  let clock = deadline + 1_000; // 刚过截止
  setup.injections.nowFn = () => clock;
  let reads = 0;
  setup.injections.readInstanceFn = async () => { reads += 1; return { status: "error" }; }; // 一直读不出
  const hold = holdLoop();
  const command = dashboardServeCommand([...setup.args, "--deadline", String(deadline)], {}, setup.injections);
  try {
    assert.equal(await waitFor(() => reads >= 6), true, "several polls ran");
    assert.deepEqual(setup.w.exits, [], "just past the deadline an unreadable record is 'look again next round', not an exit");
    clock = deadline + DASHBOARD_LAUNCH_DEADLINE_MS + 1; // 读不出已持续超过一个拉起期限
    assert.equal(await waitFor(() => setup.w.exits.length > 0), true, "it gave up: nobody could ever name this process, so it must not outlive its deadline for good");
    assert.deepEqual(setup.w.exits, [0], "the same clean 'deadline passed, never published' exit");
  } finally {
    if (setup.w.exits.length === 0) writeStop(setup); // 断言失败时也别把进程挂住
    await command;
    clearInterval(hold);
  }
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
  setup.injections.pollMs = 20;
  let sweeps = 0; // 低频清理只在实例看到自己的发布之后才开始——借它观察"轮询已经看到发布"
  setup.injections.sweepFn = async () => { sweeps += 1; return 0; };
  const args = [...setup.args, "--deadline", String(Date.now() + 60_000)];
  const hold = holdLoop();
  const command = dashboardServeCommand(args, {}, setup.injections);
  assert.equal(await waitFor(() => candidateUp(setup)), true, "the instance is up");
  const mine = { protocol: 1, runDir: setup.runDir, pid: process.pid, processCreatedAt: 1_700_000_000_000, port: setup.w.port, nonce: "ab".repeat(16), generation: GEN, build: { readable: true, srcTree: "f".repeat(40), dirty: false } };
  writeFileSync(join(setup.stateDir, "instance.json"), JSON.stringify(mine));
  assert.equal(await waitFor(() => sweeps >= 1), true, "the poll has SEEN its own publication before it is replaced");
  writeFileSync(join(setup.stateDir, "instance.json"), JSON.stringify({ ...mine, generation: "9999888877776666", nonce: "cd".repeat(16) }));
  await command;
  clearInterval(hold);
  assert.deepEqual(setup.w.exits, [0]);
  const kept = readInstance(setup.stateDir);
  assert.notEqual(kept, null, "the NEW generation's record is kept");
  assert.equal(kept.generation, "9999888877776666");
  assert.equal(existsSync(join(setup.stateDir, `candidate-${GEN}.json`)), false, "the OLD generation's candidate was still cleaned (own name only)");
});
