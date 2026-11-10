// test/backends/processJobMsys.test.js
//
// 只观测作业（决定 0121）的**真进程**形状钉：复现 MSYS env 式断链（zcode 跑
// `#!/usr/bin/env bash` 脚本——npm/npx 皆此形状——时，bash fork 的子进程 exec
// env、env 再 exec bash 后退出，新链的父 pid 指向已退出进程，ParentProcessId
// 走树挂不上），并证明作业证词补上这一跳。全部真实进程、真实 PowerShell。
// 两个用例：
//   1. 断链取证——替身 app-server（node，等 go 文件，不带 detached）→ 真实
//      attachProcessJob 挂嵌套作业 → 写 go → app-server 经 Git bash -c -l
//      "./busy.sh" 跑 #!/usr/bin/env bash 脚本，脚本里 node 忙循环到 stop 文件
//      出现（60s 上限）。断言：真实 snapshotDescendants 不含忙循环进程（含 =
//      此 Git 版本不断链 → skip，不得当通过）；snapshotRunProcesses 两次读数间
//      作业 CPU（扣宿主后）越线；建作业的 PowerShell 退出后仍按名可查。
//   2. 生死如实——替身 runner（node，不带 detached）起替身 app-server → 挂作业
//      → app-server 经同款脚本起长时 node 叶子 → 只杀 runner（不带 /T，树杀不
//      参与）→ 有界等待后断言叶子已不在：挂作业后子孙不再静默脱离 runner 的
//      libuv 作业，随 runner 一起结束（会审 opus 实测，决定 0121 的如实边界）。
// 取样/解析的确定性单测在 test/backends/processJob.test.js；本文件只做真形状。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { attachProcessJob } from "../../src/backends/processJob.js";
import {
  describeProcessJobActivity,
  snapshotDescendants,
  snapshotRunProcesses,
} from "../../src/backends/processActivity.js";

// Git 安装定位：常见路径 → 注册表 HKLM\SOFTWARE\GitForWindows\InstallPath。
// 找不到 = 无法建立 MSYS 断链前置条件，调用方 skip。
function findGitBash() {
  const candidates = [
    "D:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  try {
    const out = execFileSync(
      "reg",
      ["query", "HKLM\\SOFTWARE\\GitForWindows", "/v", "InstallPath"],
      { windowsHide: true, encoding: "utf8", timeout: 5_000 },
    );
    const match = out.match(/InstallPath\s+REG_SZ\s+(\S+)/);
    if (match) {
      const path = join(match[1].trim(), "bin", "bash.exe");
      if (existsSync(path)) return path;
    }
  } catch {
    // 注册表不可读/无 Git——按找不到处理
  }
  return null;
}

async function waitForPidFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const text = readFileSync(file, "utf8").trim();
      const pid = Number(text);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    await delay(50);
  }
  return null;
}

async function waitProcessGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
}

// Windows 上强杀单个 pid（不带 /T——树杀不参与，让作业/退出语义自己起作用）；
// 进程已死时静默。
function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    spawn("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true, stdio: "ignore" });
  } catch {
    // 已退出——无需处理
  }
}

// 替身 app-server：等 go 文件，经 Git bash -c -l 跑指定脚本；90s 硬顶自退。
function appServerCjs(scriptName) {
  return [
    "const { existsSync } = require('fs');",
    "const { spawn } = require('child_process');",
    "const path = require('path');",
    "const dir = __dirname;",
    "const bash = process.argv[2];",
    "const timer = setInterval(() => {",
    "  if (!existsSync(path.join(dir, 'go'))) return;",
    "  clearInterval(timer);",
    "  console.log('go-seen');",
    `  spawn(bash, ['-c', '-l', './${scriptName}'], { cwd: dir, env: process.env, windowsHide: true, stdio: 'ignore' });`,
    "}, 50);",
    "setTimeout(() => process.exit(0), 90000);",
  ].join("\n");
}

// 替身 runner：不带 detached 起替身 app-server（app-server 因此在 runner 的
// libuv 作业里——与生产同款），stdout 报 app-server 的 pid；常驻到被杀。
const RUNNER_CJS = [
  "const { spawn } = require('child_process');",
  "const path = require('path');",
  "const child = spawn(process.execPath, [path.join(__dirname, 'appserver.cjs'), process.argv[2]], {",
  "  cwd: __dirname, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],",
  "});",
  "console.log(JSON.stringify({ appServerPid: child.pid }));",
  "setInterval(() => {}, 1000);",
  "setTimeout(() => process.exit(0), 120000);",
].join("\n");

// 忙循环脚本：#!/usr/bin/env bash（断链的源头形状）。node 先落自己的 Windows
// pid，然后烧 CPU 直到 <prefix>.stop 出现（60s 总上限兜底），结束落 done 文件。
// 逐行 join——绝不引入 \r\n（CRLF 会打断 shebang）。
function burnerSh(nodeExe, prefix) {
  return [
    "#!/usr/bin/env bash",
    `"${nodeExe}" -e "const fs = require('fs'); fs.writeFileSync('${prefix}.pid', String(process.pid)); const t0 = Date.now(); while (!fs.existsSync('${prefix}.stop')) { if (Date.now() - t0 > 60000) break; const sliceEnd = Date.now() + 100; while (Date.now() < sliceEnd) {} } fs.writeFileSync('${prefix}.done', 'done')"`,
    "",
  ].join("\n");
}

test("processJobMsys: MSYS env 断链的忙循环走树不可见，作业证词（扣宿主）读到 CPU；PowerShell 退出后作业仍可查（决定 0121）", async (t) => {
  if (process.platform !== "win32") {
    t.skip("非 Windows——作业证词不适用");
    return;
  }
  const bashExe = findGitBash();
  if (bashExe === null) {
    t.skip("无法建立 MSYS 断链前置条件：找不到 Git 的 bin\\bash.exe（常见路径与注册表都查过）");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "wao-job-msys-"));
  const log = (stage) => console.log(`[processJobMsys] ${stage}`);
  log(`tmpdir=${dir} bash=${bashExe}`);
  let appServer = null;
  let busyPid = null;
  let attached = null;
  // 正文原始失败先记下来——清场与残留断言不得掩盖它。
  let bodyError = null;
  try {
    writeFileSync(join(dir, "busy.sh"), burnerSh(process.execPath, "busy"), "utf8");
    writeFileSync(join(dir, "appserver.cjs"), appServerCjs("busy.sh"), "utf8");
    // 替身 runner（本测试进程）不带 detached 起替身 app-server——与生产同款：
    // app-server 先进本进程的 libuv 作业，attachProcessJob 再挂嵌套作业。
    appServer = spawn(process.execPath, [join(dir, "appserver.cjs"), bashExe], {
      cwd: dir,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    appServer.stdout.on("data", () => {});
    appServer.stderr.on("data", () => {});
    await new Promise((resolve) => appServer.once("spawn", resolve));
    log(`app-server pid=${appServer.pid}`);

    attached = await attachProcessJob(appServer.pid);
    log(`attach=${JSON.stringify(attached)}`);
    assert.ok(attached?.ok === true, `attach 必须成功：${JSON.stringify(attached)}`);

    writeFileSync(join(dir, "go"), "1");
    log("go written");
    busyPid = await waitForPidFile(join(dir, "busy.pid"), 10_000);
    assert.ok(busyPid !== null, "忙循环进程 10 秒内没落 pid（脚本没跑起来）");
    log(`busy pid=${busyPid}`);

    // ① 断链复现前置检查：真实走树快照**不含**忙循环进程。含 = 此 Git 版本不再
    // 断链——前置条件不成立，skip，不得当通过。
    const tree = await snapshotDescendants(appServer.pid);
    if (tree.has(busyPid)) {
      t.skip("目标断链未复现：此 Git 版本的 bash 链挂在树上——作业证词的前提（走树失明）不成立");
      return;
    }
    log(`走树 ${tree.size} 个后代，不含 busy pid=${busyPid}——断链已复现`);

    // ② 两次合并快照（各在独立的 PowerShell 进程里——建作业的那个早已退出）：
    // 作业 CPU（扣宿主后）越阈值即有活动。
    const readStartedAt = Date.now();
    const a = await snapshotRunProcesses(appServer.pid, { jobName: attached.name });
    await delay(1_500);
    const b = await snapshotRunProcesses(appServer.pid, { jobName: attached.name });
    const windowMs = Date.now() - readStartedAt;
    assert.ok(!existsSync(join(dir, "busy.done")), "忙循环在读数窗内就结束（60s 上限被击穿或脚本未跑）——窗口没盖住活动段");
    log(`job read1=${JSON.stringify(a.job)} read2=${JSON.stringify(b.job)} window=${windowMs}ms`);
    assert.notEqual(a.job, null, "建作业的 PowerShell 退出后仍按名可查（第一次读）");
    assert.notEqual(b.job, null, "建作业的 PowerShell 退出后仍按名可查（第二次读）");
    const verdict = describeProcessJobActivity(a, b, windowMs);
    log(`verdict=${JSON.stringify(verdict)}`);
    assert.equal(verdict.available, true);
    assert.equal(verdict.active, true, `忙循环在作业里——扣宿主后的 CPU 增量必须越线（${JSON.stringify(verdict)}）`);
    assert.ok(verdict.cpuMs > 100, `忙循环 CPU 远超阈值（20ms/s）：实际 +${verdict.cpuMs}ms / ${Math.round(windowMs / 1000)}s`);
    assert.equal(b.tree.has(busyPid), false, "合并快照的走树部分同样看不到断链进程");

    // ③ 读数完毕：写 stop 文件让忙循环自己收尾（finally 里再兜底按 pid 收）。
    writeFileSync(join(dir, "busy.stop"), "1");
    log("busy.stop written");
  } catch (error) {
    bodyError = error;
  } finally {
    // 清场：stop 文件（幂等）→ 按记录 pid 结束实验进程 → 确认无残留 → 删临时目录。
    // 清场/残留断言的失败不得掩盖正文原始失败（有原始失败时只记日志）。
    try {
      try {
        writeFileSync(join(dir, "busy.stop"), "1");
      } catch { /* 目录可能已不可写——pid 兜底在后面 */ }
      if (appServer !== null && appServer.exitCode === null) killPid(appServer.pid);
      if (busyPid !== null) killPid(busyPid);
      if (appServer !== null) {
        await new Promise((resolve) => {
          if (appServer.exitCode !== null) { resolve(); return; }
          const timer = setTimeout(resolve, 5_000);
          appServer.once("close", () => { clearTimeout(timer); resolve(); });
        });
      }
      if (busyPid !== null) {
        const gone = await waitProcessGone(busyPid, 5_000);
        assert.ok(gone, `忙循环进程 pid=${busyPid} 清场后仍存活——实验进程残留`);
      }
      rmSync(dir, { recursive: true, force: true });
      log("cleanup done");
    } catch (cleanupError) {
      if (bodyError === null) bodyError = cleanupError;
      else console.log(`[processJobMsys] cleanup error suppressed by body failure: ${cleanupError}`);
    }
  }
  if (bodyError !== null) throw bodyError;
});

// 一套"runner 退出看叶子"的场景（对照臂与正向臂共用）：替身 runner（不带
// detached）起替身 app-server → 可选挂作业 → app-server 经 Git bash -c -l
// "./leaf.sh" 起长时 node 叶子（env 式脚本，断链后成孤儿）→ 只杀 runner（不带
// /T）→ 有界等叶子消失。返回 { attached, leafGone, leafDone }；清场在内部做完。
async function runnerExitLeafScenario({ bashExe, attach, goneWaitMs, label }) {
  const dir = await mkdtemp(join(tmpdir(), "wao-job-leaf-"));
  const log = (stage) => console.log(`[processJobMsys-leaf:${label}] ${stage}`);
  log(`tmpdir=${dir}`);
  let runner = null;
  let appServerPid = null;
  let leafPid = null;
  let bodyError = null;
  let result = null;
  try {
    writeFileSync(join(dir, "leaf.sh"), burnerSh(process.execPath, "leaf"), "utf8");
    writeFileSync(join(dir, "appserver.cjs"), appServerCjs("leaf.sh"), "utf8");
    writeFileSync(join(dir, "runner.cjs"), RUNNER_CJS, "utf8");
    // 替身 runner（不带 detached）起替身 app-server——app-server 进 runner 的
    // libuv 作业（KILL_ON_JOB_CLOSE + SILENT_BREAKAWAY_OK，生产同款拓扑）。
    runner = spawn(process.execPath, [join(dir, "runner.cjs"), bashExe], {
      cwd: dir,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    appServerPid = await new Promise((resolve) => {
      let buffer = "";
      const timer = setTimeout(() => resolve(null), 10_000);
      runner.stdout.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        for (const line of buffer.split(/\r?\n/)) {
          let parsed = null;
          try { parsed = JSON.parse(line); } catch { continue; }
          if (parsed && Number.isInteger(parsed.appServerPid)) {
            clearTimeout(timer);
            resolve(parsed.appServerPid);
            return;
          }
        }
      });
    });
    assert.ok(appServerPid !== null, "runner 10 秒内没报出 app-server 的 pid");
    log(`runner pid=${runner.pid} app-server pid=${appServerPid}`);

    let attached = null;
    if (attach) {
      // 真实 attachProcessJob——加入作业前不起叶子。
      attached = await attachProcessJob(appServerPid);
      log(`attach=${JSON.stringify(attached)}`);
      assert.ok(attached?.ok === true, `attach 必须成功：${JSON.stringify(attached)}`);
    }

    writeFileSync(join(dir, "go"), "1");
    leafPid = await waitForPidFile(join(dir, "leaf.pid"), 10_000);
    assert.ok(leafPid !== null, "叶子 10 秒内没落 pid（脚本没跑起来）");
    log(`leaf pid=${leafPid}`);
    assert.equal(await waitProcessGone(leafPid, 0), false, "前置条件：叶子确实在跑");

    // 只杀 runner（taskkill /F 单进程，不带 /T——树杀不参与）。
    killPid(runner.pid);
    await new Promise((resolve) => {
      if (runner.exitCode !== null) { resolve(); return; }
      const timer = setTimeout(resolve, 5_000);
      runner.once("close", () => { clearTimeout(timer); resolve(); });
    });
    log("runner killed (no /T)");
    const leafGone = await waitProcessGone(leafPid, goneWaitMs);
    // 叶子自己跑完（stop 文件 / 60 秒上限）会写 leaf.done；被作业带走则不会。
    const leafDone = existsSync(join(dir, "leaf.done"));
    log(`leaf gone=${leafGone} done=${leafDone}`);
    result = { attached, leafGone, leafDone };
  } catch (error) {
    bodyError = error;
  } finally {
    try {
      try {
        writeFileSync(join(dir, "leaf.stop"), "1");
      } catch { /* 目录可能已不可写——pid 兜底在后面 */ }
      if (runner !== null && runner.exitCode === null) killPid(runner.pid);
      if (appServerPid !== null) killPid(appServerPid);
      if (leafPid !== null) killPid(leafPid);
      if (leafPid !== null) {
        const gone = await waitProcessGone(leafPid, 5_000);
        assert.ok(gone, `叶子 pid=${leafPid} 清场后仍存活——实验进程残留`);
      }
      rmSync(dir, { recursive: true, force: true });
      log("cleanup done");
    } catch (cleanupError) {
      if (bodyError === null) bodyError = cleanupError;
      else console.log(`[processJobMsys-leaf:${label}] cleanup error suppressed by body failure: ${cleanupError}`);
    }
  }
  if (bodyError !== null) throw bodyError;
  return result;
}

test("processJobMsys: 挂作业后 runner 退出 ⇒ MSYS 断链叶子随之结束（不再静默脱离 libuv 作业，决定 0121 如实边界）", async (t) => {
  if (process.platform !== "win32") {
    t.skip("非 Windows——作业不适用");
    return;
  }
  const bashExe = findGitBash();
  if (bashExe === null) {
    t.skip("无法建立前置条件：找不到 Git 的 bin\\bash.exe（常见路径与注册表都查过）");
    return;
  }
  // 对照臂：不挂作业时叶子静默脱离 runner 的 libuv 作业，runner 退出后仍活着。
  // 对照不成立（叶子也死了），正向臂就证明不了因果——如实 skip，不当通过。
  const control = await runnerExitLeafScenario({ bashExe, attach: false, goneWaitMs: 5_000, label: "control" });
  if (control.leafGone) {
    t.skip(`对照不成立：不挂作业时叶子也随 runner 结束了（done=${control.leafDone}）——无法证明作业的效果`);
    return;
  }
  // 正向臂：挂作业后叶子不再脱离，runner 退出时随之结束，且不是自己跑完。
  const attached = await runnerExitLeafScenario({ bashExe, attach: true, goneWaitMs: 10_000, label: "attached" });
  assert.ok(attached.leafGone, "挂作业后 runner 退出 10 秒内叶子应已结束（决定 0121 的如实边界）");
  assert.equal(attached.leafDone, false, "叶子是被带走的，不是自己跑完（没有 leaf.done）");
});
