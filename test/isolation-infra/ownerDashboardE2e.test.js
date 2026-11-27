// test/isolation-infra/ownerDashboardE2e.test.js
//
// 第 145b 批（决定 0131 第 2 条）：常驻看板的本机端到端——真实 WMI 子进程、
// 临时状态根（--state-root 显式传给子进程链，绝不碰真实 %LOCALAPPDATA%）、临时
// 运行目录。WMI 用例不跳过；跳过不算通过。
//
//   1. `wao dashboard --no-open` 经 WMI 拉起实例；启动它的命令进程退出后实例仍在服务；
//   2. 再运行一次复用同一实例（同 pid、同端口），新的启动码兑换后能读 /api/overview；
//   3. 两个 `wao dashboard` 同时运行，只有一个实例；
//   4. 固定端口被占，立即报 port_in_use（不把占用者当看板、不动它）；
//   5. status 如实；stop 优雅退出，instance.json 被删；
//   6. restart 换新的 nonce 与 pid，旧会话令牌失效；
//   7. 记录里的协议版本不一致时拒绝发码（非零退出、restart 提示）。
//
// 测试结束前一定把起过的实例 stop；stop 不掉就按记录里的 pid 结束这个测试自己
// 起的进程，并让测试失败。启动器输出里的 URL/启动码只进测试进程内存，不落盘。

process.env.WAO_ALLOW_NESTED_DISPATCH = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

import { normalizeRunDir, stateDirFor } from "../../src/application/dashboardPaths.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CLI = join(ROOT, "src", "cli.js");

/** 运行一次真实的 `wao dashboard …`（本测试选中的 node 直接跑 cli.js）。 */
function runDashboard(args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [CLI, "dashboard", ...args], {
      cwd: ROOT,
      env: { ...process.env, WAO_ALLOW_NESTED_DISPATCH: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读出状态目录里所有 candidate-*.json 的 pid（含未发布的输家）。 */
function collectCandidatePids(stateDir) {
  const out = [];
  try {
    for (const name of readdirSync(stateDir)) {
      if (!/^candidate-[0-9a-f]{16}.json$/.test(name)) continue;
      try {
        const value = JSON.parse(readFileSync(join(stateDir, name), "utf8"));
        if (Number.isInteger(value?.pid) && value.pid > 0) out.push(value.pid);
      } catch { /* 半写/坏文件跳过 */ }
    }
  } catch { /* 目录不在 */ }
  return [...new Set(out)];
}

/** 读状态目录里的 instance.json（缺失给 null）。 */
function readInstance(stateDir) {
  try {
    return JSON.parse(readFileSync(join(stateDir, "instance.json"), "utf8"));
  } catch {
    return null;
  }
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body };
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 这个测试文件自己起过的实例 pid（收尾兜底用）。 */
const startedPids = new Set();

/** 收尾：先试真正的 stop；还有活着的（含未发布的候选进程）就按 pid 结束并让测试失败。
 *  修正一 #16：兜底强杀只用来防止泄漏，用到它本身就是红——不能“杀掉了所以绿”。 */
async function stopEverything(stateDir, stateRootLabel) {
  for (const pid of collectCandidatePids(stateDir)) startedPids.add(pid);
  const stopped = await runDashboard(["stop", "--state-root", stateRootLabel, "--run-dir", RUN_DIR]);
  const stubborn = [...startedPids].filter((pid) => pidAlive(pid));
  for (const pid of stubborn) {
    // 只按记录里取得的具体 pid 结束（本测试自己经命令链起起来的进程）。
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15_000 });
  }
  assert.deepEqual(
    stubborn,
    [],
    `收尾需要强杀 pid [${stubborn.join(", ")}] 才算失败：stop 之后它们本该自己退出（已按 pid 结束以免泄漏）`,
  );
  return stopped;
}

// 一个共享的世界：一个临时运行目录 + 一个临时状态根。
const RUN_DIR = mkdtempSync(join(tmpdir(), "wao-dash-e2e-runs-"));
mkdirSync(RUN_DIR, { recursive: true });
// 状态根必须是一个“还不存在”的目录（生产首次运行即如此）：ensure 只对新建目录设
// ACL，已存在而核对不过的目录按契约拒绝——所以这里给到 wao/dashboard 这一级。
// 修正一 #2/#16：目录名带空格（用户名带空格是常见形态，命令行要引用得住）。
const STATE_BASE = mkdtempSync(join(tmpdir(), "wao dash e2e state-"));
const STATE_ROOT = join(STATE_BASE, "wao dashboard root");
const STATE_DIR = stateDirFor(normalizeRunDir(resolve(RUN_DIR)), STATE_ROOT);
const DASH = ["--state-root", STATE_ROOT, "--run-dir", RUN_DIR];

const URL_LINE = /http:\/\/127\.0\.0\.1:(\d+)\/v2\/#(?:workers\?project=[A-Za-z0-9._-]+&)?code=([0-9a-f]{64})/;

/** 从一次启动器输出里拿 URL 行。 */
function urlOf(run) {
  const m = URL_LINE.exec(run.stdout);
  return m === null ? null : { port: Number(m[1]), code: m[2] };
}

test("E2E-1 WMI 拉起 + 命令进程退出后仍在服务；E2E-2 复用与兑换", async (t) => {
  const first = await runDashboard(["--no-open", ...DASH]);
  assert.equal(first.code, 0, `launcher exits 0 (stdout: ${first.stdout}\nstderr: ${first.stderr})`);
  const firstUrl = urlOf(first);
  assert.notEqual(firstUrl, null, "the start-code URL is printed once for --no-open");
  assert.ok(first.stdout.includes("#code=") && !first.stdout.includes("?code="), "the code rides the fragment only");

  const record = readInstance(STATE_DIR);
  assert.notEqual(record, null, "instance.json published");
  assert.equal(record.protocol, 1);
  startedPids.add(record.pid);
  assert.ok(pidAlive(record.pid), "the serve process is alive after the launcher exited");
  const health = await fetchJson(`http://127.0.0.1:${record.port}/health`);
  assert.deepEqual([health.status, health.body.nonce], [200, record.nonce], "health answers with the recorded nonce");

  // E2E-2：再跑一次复用同一实例；新的启动码兑换成会话令牌，能读 /api/overview。
  const second = await runDashboard(["--no-open", ...DASH]);
  assert.equal(second.code, 0);
  const secondUrl = urlOf(second);
  assert.notEqual(secondUrl, null);
  assert.equal(secondUrl.port, record.port, "same port");
  assert.notEqual(secondUrl.code, firstUrl.code, "a fresh code is issued for the reuse");
  const after = readInstance(STATE_DIR);
  assert.equal(after.pid, record.pid, "same pid — reused, not restarted");

  const exchanged = await fetchJson(`http://127.0.0.1:${record.port}/api/session`, {
    host: `127.0.0.1:${record.port}`,
    authorization: `Bearer ${secondUrl.code}`,
  });
  assert.equal(exchanged.status, 200, `the fresh code redeems (body: ${JSON.stringify(exchanged.body)})`);
  assert.match(exchanged.body.token, /^[0-9a-f]{64}$/);
  const overview = await fetchJson(`http://127.0.0.1:${record.port}/api/overview`, {
    authorization: `Bearer ${exchanged.body.token}`,
  });
  assert.equal(overview.status, 200, "the session token reads /api/overview");
  assert.equal(exchanged.body.token === firstUrl.code, false, "session token is not the start code");
});

test("E2E-3 (145b-fix) 冷启动争锁：空状态目录并行两个 wao dashboard，最后只有一个实例", async () => {
  // 全新的运行目录 + 全新的状态根：两边都走"拉起"分支（真锁竞争）。
  const runDir2 = mkdtempSync(join(tmpdir(), "wao-dash-e2e-cold-"));
  mkdirSync(runDir2, { recursive: true });
  const stateBase2 = mkdtempSync(join(tmpdir(), "wao dash e2e cold-"));
  const stateRoot2 = join(stateBase2, "wao dashboard root");
  const stateDir2 = stateDirFor(normalizeRunDir(resolve(runDir2)), stateRoot2);
  const dash2 = ["--state-root", stateRoot2, "--run-dir", runDir2];
  const both = await Promise.all([
    runDashboard(["--no-open", ...dash2]),
    runDashboard(["--no-open", ...dash2]),
  ]);
  assert.ok(both.every((r) => r.code === 0), `both callers succeed (codes: ${both.map((r) => r.code)}, out: ${both.map((r) => r.stdout.slice(0, 160) + " | err: " + r.stderr.slice(0, 240))})`);
  const record = readInstance(stateDir2);
  assert.notEqual(record, null, "exactly one instance.json");
  startedPids.add(record.pid);
  const urls = both.map((r) => URL_LINE.exec(r.stdout)).filter((m) => m !== null).map((m) => Number(m[1]));
  assert.equal(urls.length, 2, "both printed a start-code URL");
  assert.deepEqual([...new Set(urls)], [record.port], "both URLs point at the ONE instance port");
  const candidatePids = collectCandidatePids(stateDir2);
  for (const pid of candidatePids) startedPids.add(pid);
  if (candidatePids.filter((x) => x !== record.pid).length > 0) {
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      if (candidatePids.filter((x) => x !== record.pid && pidAlive(x)).length === 0) break;
      await sleep(1000);
    }
    const leftover = candidatePids.filter((x) => x !== record.pid && pidAlive(x));
    assert.deepEqual(leftover, [], "the unpublished candidate exited by itself after its deadline");
  }
  const stop = await runDashboard(["stop", ...dash2]);
  assert.equal(stop.code, 0, `stop after the cold race (stdout: ${stop.stdout})`);
  rmSync(runDir2, { recursive: true, force: true });
  rmSync(stateBase2, { recursive: true, force: true });
});

test("E2E-5 status 如实；stop 优雅退出且 instance.json 被删", async () => {
  const record = readInstance(STATE_DIR);
  assert.notEqual(record, null);
  const status = await runDashboard(["status", ...DASH]);
  assert.equal(status.code, 0);
  assert.ok(status.stdout.includes(`pid ${record.pid}`) && status.stdout.includes(`端口 ${record.port}`), `status prints facts (got: ${status.stdout})`);
  assert.ok(!/[0-9a-f]{64}/.test(status.stdout), "no code or token in status output");

  const stop = await runDashboard(["stop", ...DASH]);
  assert.equal(stop.code, 0, `stop exits 0 (stdout: ${stop.stdout}\nstderr: ${stop.stderr})`);
  assert.ok(!existsSync(join(STATE_DIR, "instance.json")), "instance.json removed by the instance itself");
  assert.equal(pidAlive(record.pid), false, "the serve process exited gracefully");
  // 修正一 #8：一次拉起加 stop 之后，状态目录只剩 instance.log、launch.lock（如有）与 codes。
  const leftovers = readdirSync(STATE_DIR).filter((n) => !["instance.log", "launch.lock", "codes"].includes(n));
  assert.deepEqual(leftovers, [], `no candidate/result/stop/stale residue (got: ${leftovers})`);
});

test("E2E-6 restart 换新的 pid 与 nonce；旧会话令牌失效", async (t) => {
  // 先起一个实例并兑换一张会话令牌。
  const up = await runDashboard(["--no-open", ...DASH]);
  assert.equal(up.code, 0);
  const upUrl = urlOf(up);
  assert.notEqual(upUrl, null);
  const old = readInstance(STATE_DIR);
  startedPids.add(old.pid);
  const exchanged = await fetchJson(`http://127.0.0.1:${old.port}/api/session`, {
    host: `127.0.0.1:${old.port}`,
    authorization: `Bearer ${upUrl.code}`,
  });
  assert.equal(exchanged.status, 200);
  const oldToken = exchanged.body.token;

  const restarted = await runDashboard(["restart", "--no-open", ...DASH], { timeoutMs: 90_000 });
  assert.equal(restarted.code, 0, `restart exits 0 (stdout: ${restarted.stdout}\nstderr: ${restarted.stderr})`);
  const fresh = readInstance(STATE_DIR);
  assert.notEqual(fresh, null);
  startedPids.add(fresh.pid);
  assert.notEqual(fresh.pid, old.pid, "a new process");
  assert.notEqual(fresh.nonce, old.nonce, "a fresh nonce");
  assert.equal(pidAlive(old.pid), false, "the old generation exited before the new one started");

  // 旧会话令牌在新实例上无效（会话只在实例内存里）。
  const refused = await fetchJson(`http://127.0.0.1:${fresh.port}/api/overview`, {
    authorization: `Bearer ${oldToken}`,
  });
  assert.equal(refused.status, 401, "the old session token died with the old instance");
  // 修正一 #3：上一代签发、没用掉的码，换代后一律不能兑换。
  const staleExchange = await fetchJson(`http://127.0.0.1:${fresh.port}/api/session`, {
    host: `127.0.0.1:${fresh.port}`,
    authorization: `Bearer ${upUrl.code}`,
  });
  assert.equal(staleExchange.status, 401, "the PREVIOUS generation's unused code is dead after restart");
  // 收尾：停掉新代。
  const stop = await runDashboard(["stop", ...DASH]);
  assert.equal(stop.code, 0);
});

test("E2E-7 (145b-fix) 活实例的记录协议改成 2：拒绝发码、非零退出、restart 提示；恢复后正常", async () => {
  // 起一个真实例，把它的记录协议字段改成 2（pid/创建时间/端口/nonce 都是真的——活的）。
  const up = await runDashboard(["--no-open", ...DASH]);
  assert.equal(up.code, 0, "instance up");
  const live = readInstance(STATE_DIR);
  assert.notEqual(live, null);
  startedPids.add(live.pid);
  writeFileSync(join(STATE_DIR, "instance.json"), JSON.stringify({ ...live, protocol: 2 }));
  const refused = await runDashboard(["--no-open", ...DASH]);
  assert.notEqual(refused.code, 0, "non-zero exit for a LIVE incompatible instance");
  assert.ok(refused.stdout.includes("restart") || refused.stderr.includes("restart"), "the fixed restart hint");
  assert.ok(!refused.stdout.includes("#code="), "NO start code is issued");
  // 恢复协议字段后照常复用。
  writeFileSync(join(STATE_DIR, "instance.json"), JSON.stringify(live));
  const okRun = await runDashboard(["--no-open", ...DASH]);
  assert.equal(okRun.code, 0, "restored protocol reuses the live instance");
  assert.ok(okRun.stdout.includes("#code="), "a code IS issued after restore");
  const stop = await runDashboard(["stop", ...DASH]);
  assert.equal(stop.code, 0);
});

test("E2E-4 固定端口被占：立即报 port_in_use，不动占用者", async (t) => {
  // 清干净旧状态，保证这次必然走“拉起”分支。
  await stopEverything(STATE_DIR, STATE_ROOT);
  rmSync(join(STATE_DIR, "instance.json"), { force: true });

  const squatter = createServer();
  await new Promise((r) => squatter.listen(0, "127.0.0.1", r));
  const { port } = squatter.address();
  const squatterPid = process.pid; // 占端口的是本测试进程
  t.after(() => new Promise((r) => squatter.close(r)));

  const refused = await runDashboard(["--no-open", "--port", String(port), ...DASH], { timeoutMs: 90_000 });
  assert.notEqual(refused.code, 0, "non-zero exit");
  assert.ok(refused.stdout.includes("端口已被占用") || refused.stderr.includes("端口已被占用"),
    `the fixed port_in_use text is printed (stdout: ${refused.stdout}\nstderr: ${refused.stderr})`);
  assert.ok(pidAlive(squatterPid), "the port squatter was neither killed nor adopted");
  assert.equal(readInstance(STATE_DIR), null, "no instance.json was published");
  // 修正一 #5：启动器读到 result-<g>.json 后即删（读后即清），这里不再断言它残留；
  // 语义由 dashboardControl 单测钉住（removeResult 被调用）。
});

test("E2E 收尾：没有实例残留（含候选进程；强杀兜底即失败）", async () => {
  for (const pid of collectCandidatePids(STATE_DIR)) startedPids.add(pid);
  const stopped = await stopEverything(STATE_DIR, STATE_ROOT);
  assert.equal(readInstance(STATE_DIR), null, "no instance record left behind");
  for (const pid of startedPids) {
    assert.equal(pidAlive(pid), false, `pid ${pid} (started by this test) is gone`);
  }
  rmSync(RUN_DIR, { recursive: true, force: true });
  rmSync(STATE_BASE, { recursive: true, force: true });
});
