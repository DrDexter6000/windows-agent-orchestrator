// test/run-lifecycle/runnerBroker.test.js
//
// TD-347（第 93 批）：启动桥 src/runnerBroker.js 的真进程测试。
//
// 不经 WMI（wmiSpawnBrokerFn 注入为"直接 spawn 真桥进程"），父端用真命名管道 +
// 真帧协议；runner 是一个小的假 runner 脚本（真 node 子进程），把 argv/env/cwd/
// prompt/stderr 的观测写进文件。证明：
//   - env 逐字到达（含父端独有变量；PATH/Path 大小写都取得到——Windows env 对
//     键名大小写不敏感，桥不得在传递中丢键改键）；
//   - prompt 经 stdin 原样到达（与摘要一致）；
//   - 超 8191 字符的 argv 与含 % ! & ^ " 的参数不经 cmd 原样到达；
//   - runner 写到 stderr 的内容落进 stderr 文件；
//   - 桥回帧后自行退出。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { launchRunner } from "../../src/application/runnerLaunch.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BROKER_PATH = join(REPO_ROOT, "src", "runnerBroker.js");
const IS_WINDOWS = process.platform === "win32";

const FAKE_RUNNER_SCRIPT = `
import { writeFileSync } from "node:fs";
const out = process.argv[2];
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
process.stderr.write("fake-runner-stderr-marker\\n");
writeFileSync(out, JSON.stringify({
  argv: process.argv.slice(3),
  cwd: process.cwd(),
  unique: process.env.WAO_BROKER_TEST_UNIQUE ?? null,
  pathUpper: process.env.PATH ?? null,
  pathMixed: process.env.Path ?? null,
  prompt,
}), "utf8");
`;

function restoreSpawnSwitch(prev) {
  if (prev === undefined) delete process.env.WAO_RUNNER_LAUNCH;
  else process.env.WAO_RUNNER_LAUNCH = prev;
}

function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
}

async function waitUntil(fn, timeoutMs, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => { setTimeout(r, stepMs); });
  }
  return fn();
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

test("启动桥真进程：argv（超长/特殊字符）、env（含大小写 PATH）、prompt（stdin）、stderr（文件）全部原样到达", { skip: !IS_WINDOWS && "真桥仅 Windows" }, async (t) => {
  const prevSwitch = process.env.WAO_RUNNER_LAUNCH;
  delete process.env.WAO_RUNNER_LAUNCH; // 本测试走 WMI 路径的父端交换（桥本身不经 WMI）
  const dir = mkdtempSync(join(tmpdir(), "wao-broker-e2e-"));
  let brokerPid = null;
  let runnerPidFromLaunch = null;
  try {
    const runnerScript = join(dir, "fake-runner.mjs");
    const outFile = join(dir, "observed.json");
    const stderrPath = join(dir, ".runner-run_broker_e2e.stderr");
    writeFileSync(runnerScript, FAKE_RUNNER_SCRIPT, "utf8");

    const specialArg = 'a%b!c&d^e"f';
    const longArg = "L".repeat(9000); // 远超 cmd 的 8191 字符命令行上限
    const prompt = "任务书：do the work — 中文 + % ! & ^ \" quotes";
    const unique = `broker-e2e-${Date.now()}`;

    // 直接 spawn 真桥（替代 PowerShell+WMI 那一跳；父端管道/帧/收口全是真实现）。
    const spawnRealBroker = (pipeName) => new Promise((resolveSpawn) => {
      const child = spawn(process.execPath, [BROKER_PATH, "--pipe", pipeName, "--run-id", "run_broker_e2e"], {
        windowsHide: true,
        stdio: "ignore",
      });
      brokerPid = child.pid;
      child.on("error", () => resolveSpawn({ ok: false, detail: "broker spawn failed" }));
      resolveSpawn({ ok: true, pid: child.pid });
    });
    const killCalls = [];
    const killDeps = {
      taskkillFn: (pid) => { killCalls.push(pid); killTree(pid); return { called: true, exitCode: 0 }; },
      scanFn: async () => ({ ok: true, pids: [] }),
      isAliveFn: (pid) => pidAlive(pid),
      sleepFn: (ms) => new Promise((r) => { setTimeout(r, ms); }),
    };

    const launch = await launchRunner({
      execPath: process.execPath,
      args: [runnerScript, outFile, "--flag", specialArg, "--long", longArg, "--run-id", "run_broker_e2e"],
      env: { ...process.env, WAO_BROKER_TEST_UNIQUE: unique },
      cwd: dir,
      prompt,
      stderrPath,
      runId: "run_broker_e2e",
      timeoutMs: 20000,
      wmiSpawnBrokerFn: spawnRealBroker,
      killDeps,
    });
    runnerPidFromLaunch = launch.runnerPid;
    t.diagnostic(`launch outcome=${launch.outcome} reason=${launch.reason ?? "-"} runnerPid=${launch.runnerPid ?? "-"}`);
    assert.equal(launch.outcome, "started", `reason=${launch.reason} detail=${launch.detail ?? "-"}`);
    assert.ok(Number.isInteger(launch.runnerPid) && launch.runnerPid > 0, "回帧带回真实 runner pid");

    // 假 runner 的观测文件（读完 stdin 才写）。
    const observed = JSON.parse(await new Promise((resolve2, reject2) => {
      const deadline = Date.now() + 10000;
      (function poll() {
        if (existsSync(outFile)) {
          try { resolve2(readFileSync(outFile, "utf8")); return; } catch { /* 写到一半 */ }
        }
        if (Date.now() > deadline) { reject2(new Error("runner observation file never appeared")); return; }
        setTimeout(poll, 100);
      })();
    }));

    // argv：超长参数与特殊字符原样到达（没经过 cmd）。
    assert.deepEqual(observed.argv, ["--flag", specialArg, "--long", longArg, "--run-id", "run_broker_e2e"]);
    // env：父端独有变量逐字到达；Windows 下 PATH/Path 大小写都取得到。
    assert.equal(observed.unique, unique, "env 逐字到达");
    assert.ok(typeof observed.pathUpper === "string" && observed.pathUpper.length > 0, "process.env.PATH 可取");
    assert.ok(typeof observed.pathMixed === "string" && observed.pathMixed.length > 0, "process.env.Path 也可取");
    // cwd：载荷里的 cwd 生效。
    assert.equal(observed.cwd, dir);
    // prompt：stdin 原样到达。
    assert.equal(observed.prompt, prompt);
    // stderr：runner 写的 stderr 落进证据文件。
    await waitUntil(() => existsSync(stderrPath) && String(readFileSync(stderrPath, "utf8")).includes("fake-runner-stderr-marker"), 5000);
    assert.ok(String(readFileSync(stderrPath, "utf8")).includes("fake-runner-stderr-marker"), "stderr 落 .runner-<runId>.stderr");

    // 桥回帧后自行退出（不赖着）。
    const brokerGone = await waitUntil(() => !pidAlive(brokerPid), 5000);
    assert.ok(brokerGone, "桥自行退出");
    assert.deepEqual(killCalls, [], "成功路径零兜底结束");

    // runner 自己退出（脚本写完文件就结束）；到点没退也收掉，不留进程。
    await waitUntil(() => !pidAlive(launch.runnerPid), 5000) || killTree(launch.runnerPid);
  } finally {
    restoreSpawnSwitch(prevSwitch);
    if (brokerPid) killTree(brokerPid);
    if (runnerPidFromLaunch) killTree(runnerPidFromLaunch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("启动桥真进程：resume 形（prompt=null）——stdin=ignore 也照常起、照常回帧", { skip: !IS_WINDOWS && "真桥仅 Windows" }, async (t) => {
  const prevSwitch = process.env.WAO_RUNNER_LAUNCH;
  delete process.env.WAO_RUNNER_LAUNCH;
  const dir = mkdtempSync(join(tmpdir(), "wao-broker-resume-"));
  let brokerPid = null;
  let runnerPidFromLaunch = null;
  try {
    // resume 形假 runner：不读 stdin（本来就是 ignore），写个标记文件就退出。
    const runnerScript = join(dir, "resume-runner.mjs");
    const marker = join(dir, "started.txt");
    writeFileSync(runnerScript, [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(marker)}, "started pid=" + process.pid, "utf8");`,
    ].join("\n"), "utf8");

    const spawnRealBroker = (pipeName) => new Promise((resolveSpawn) => {
      const child = spawn(process.execPath, [BROKER_PATH, "--pipe", pipeName, "--run-id", "run_broker_resume"], {
        windowsHide: true,
        stdio: "ignore",
      });
      brokerPid = child.pid;
      child.on("error", () => resolveSpawn({ ok: false, detail: "broker spawn failed" }));
      resolveSpawn({ ok: true, pid: child.pid });
    });

    const launch = await launchRunner({
      execPath: process.execPath,
      args: [runnerScript, "--resume-run-id", "run_broker_resume"],
      env: { ...process.env, WAO_BROKER_TEST_UNIQUE: "resume-unique" },
      cwd: dir,
      prompt: null,
      stderrPath: join(dir, ".runner-run_broker_resume.stderr"),
      runId: "run_broker_resume",
      timeoutMs: 20000,
      wmiSpawnBrokerFn: spawnRealBroker,
      killDeps: {
        taskkillFn: (pid) => { killTree(pid); return { called: true, exitCode: 0 }; },
        scanFn: async () => ({ ok: true, pids: [] }),
        isAliveFn: (pid) => pidAlive(pid),
        sleepFn: (ms) => new Promise((r) => { setTimeout(r, ms); }),
      },
    });
    runnerPidFromLaunch = launch.runnerPid;
    t.diagnostic(`resume launch outcome=${launch.outcome} reason=${launch.reason ?? "-"}`);
    assert.equal(launch.outcome, "started");
    const started = await waitUntil(() => existsSync(marker), 5000);
    assert.ok(started, "resume 形 runner 起来了（stdin=ignore 不挡启动）");
    await waitUntil(() => !pidAlive(brokerPid), 5000);
    await waitUntil(() => !pidAlive(launch.runnerPid), 5000) || killTree(launch.runnerPid);
  } finally {
    restoreSpawnSwitch(prevSwitch);
    if (brokerPid) killTree(brokerPid);
    if (runnerPidFromLaunch) killTree(runnerPidFromLaunch);
    rmSync(dir, { recursive: true, force: true });
  }
});
