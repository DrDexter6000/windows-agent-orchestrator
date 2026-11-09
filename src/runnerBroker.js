// src/runnerBroker.js
//
// TD-347（第 93 批）：WMI 启动桥——短命进程，把后台 runner 从宿主的
// KILL_ON_JOB_CLOSE 作业里搬出去。
//
// 实测（2026-11-09）：Claude 桌面版把每个 WAO MCP 服务放进一个只有
// KILL_ON_JOB_CLOSE（LimitFlags=0x2000）的作业；宿主重启服务时，服务的全部
// 子进程（含 detached runner 与 runner 之下的进程树）在 3ms 内连坐退出，
// CREATE_BREAKAWAY_FROM_JOB 也被拒（err=5）。同一进程经 WMI Win32_Process.Create
// 起的进程（父进程是 WmiPrvSE.exe）落在另一个允许脱离的作业里，服务重启后存活。
//
// 所以控制面（src/application/runnerLaunch.js）不再直接 spawn runner，而是经
// WMI 起本桥：命令行只有 node、本脚本、--pipe <管道名>、--nonce <握手随机数>、
// --run-id <runId>——不带凭据、不带 runner 的长 argv。桥：
//   1. 连父进程的命名管道，**先发一帧 {nonce}**（第 93 批续修 6：node 起的管道
//      缺省 DACL 给 Everyone 读权限、管道名可被列举——握手不对，父端一个载荷
//      字节都不发，抢先连上的只读客户端拿不到任何东西）；父端核对一致后回一帧
//      载荷 {execPath, args, env, cwd, prompt, stderrPath, deadlineAt}；
//   2. 离 deadlineAt（父端总期限）不足 2 秒就不再起 runner；期限内以 append 打开 stderr
//      文件（失败退回 "ignore"，照第 89 批），detached spawn runner（spawn 抛错
//      **或异步 error 事件**——cwd/execPath 不存在时 Node 不抛、只发 error——都按
//      spawn_failed 收口），spawn 后关闭自己的 fd，prompt 经 stdin 交接
//      （writeRunnerPrompt，超时用 deadlineAt − 2 秒 − 现在）；
//   3. 回一帧 {runnerPid, handoff}，unref runner，退出。
// 任何失败都不回显 env 与 prompt——错误只落固定闭集理由（stderr 文件 / 退出码）。
//
// 契约（adapters 层入口，与 backgroundRunner.js 同层）：
//   - 只导入叶子模块（node 内置 + src/runnerPrompt.js + src/application/runnerFrame.js），
//     不 import 任何会在 import 时读环境的模块；
//   - env（含凭据）只经管道载荷与 runner 进程创建传递，绝不出现在本进程的
//     命令行、stdout、stderr 或退出信息里。

import { spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync } from "node:fs";
import { connect } from "node:net";

import { PROMPT_HANDOFF_TIMEOUT_MS, writeRunnerPrompt } from "./runnerPrompt.js";
import { FrameDecoder, encodeFrame, validateBrokerPayload } from "./application/runnerFrame.js";

// 自己的连接/读帧期限：父端总期限（PROMPT_HANDOFF_TIMEOUT_MS）先到时会拆掉
// 管道，桥在这里到点自动退出——父端关管道后桥拿不到载荷，绝不悬空挂着。
const BROKER_DEADLINE_MS = PROMPT_HANDOFF_TIMEOUT_MS;

// 桥对 deadlineAt 留的余量：交接超时比父端总期限早这么多到点，"timeout" 回帧
// 才赶得上在父端定时器之前到达（父端据此按 runnerPid 结束 runner、报
// handoff_timeout）；剩不到这么多时间就不再起 runner。
const BRIDGE_REPLY_MARGIN_MS = 2000;

// 失败收口：固定闭集理由写进 runner 的 stderr 证据文件（桥唯一的诊断出口——
// WMI 起的进程没有可用的 stdout/stderr），退出码 1。绝不带任何载荷内容。
// 理由闭集：connect_failed / frame_timeout / frame_invalid / spawn_failed。
function fail(reason, stderrPath) {
  if (typeof stderrPath === "string" && stderrPath.length > 0) {
    try {
      appendFileSync(stderrPath, `runnerBroker: ${reason}\n`, "utf8");
    } catch {
      /* 证据文件写不进就只剩退出码 */
    }
  }
  process.exit(1);
}

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--pipe") out.pipe = argv[i + 1];
    else if (argv[i] === "--nonce") out.nonce = argv[i + 1];
    else if (argv[i] === "--run-id") out.runId = argv[i + 1];
  }
  return out;
}

function withDeadline(ms, onTimeout) {
  const timer = setTimeout(onTimeout, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  if (typeof opts.pipe !== "string" || opts.pipe.length === 0
    || typeof opts.nonce !== "string" || opts.nonce.length === 0
    || typeof opts.runId !== "string" || opts.runId.length === 0) {
    // 连 stderrPath 都没有——没有证据位，只能裸退出。
    process.exit(1);
    return;
  }
  // --run-id 只为让 settle 的进程扫描在启动窗口内也认得出本桥；桥自身不用它。

  // 1. 连父进程的管道，先发握手帧 {nonce}（载荷没到之前 stderrPath 未知——
  //    这段失败只有退出码）。
  const socket = connect(opts.pipe);
  const connected = await new Promise((resolve) => {
    const cancel = withDeadline(BROKER_DEADLINE_MS, () => resolve(false));
    socket.once("connect", () => { cancel(); resolve(true); });
    socket.once("error", () => { cancel(); try { socket.destroy(); } catch { /* 已关 */ } resolve(false); });
  });
  if (!connected) {
    process.exit(1); // connect_failed
    return;
  }
  try {
    socket.write(encodeFrame({ nonce: opts.nonce }));
  } catch {
    try { socket.destroy(); } catch { /* 已关 */ }
    process.exit(1); // 连上了却发不出握手帧：父端等不到正确 nonce，同样按未验证收口
    return;
  }

  // 2. 读一帧载荷（半包凑帧由 FrameDecoder 处理）。
  const payload = await new Promise((resolve) => {
    const decoder = new FrameDecoder();
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      cancel();
      resolve(value);
    };
    const cancel = withDeadline(BROKER_DEADLINE_MS, () => settle(undefined));
    socket.on("data", (chunk) => {
      try {
        const r = decoder.push(chunk);
        if (r.status === "frame") settle(r.value);
      } catch {
        settle(null); // 帧坏了：null 区别于 undefined（超时）
      }
    });
    socket.once("error", () => settle(undefined));
    socket.once("close", () => settle(undefined));
  });
  if (payload === undefined) {
    try { socket.destroy(); } catch { /* 已关 */ }
    process.exit(1); // frame_timeout / 管道先断——载荷没到，没有 stderrPath，裸退出
    return;
  }
  if (payload === null) {
    try { socket.destroy(); } catch { /* 已关 */ }
    process.exit(1); // frame_invalid：帧解析失败，拿不到任何字段，裸退出
    return;
  }
  let validated;
  try {
    validated = validateBrokerPayload(payload);
  } catch {
    // 载荷形状不对：stderrPath 若恰好可读就留一条证据，否则裸退出。
    try { socket.destroy(); } catch { /* 已关 */ }
    fail("frame_invalid", payload !== null && typeof payload === "object" && typeof payload.stderrPath === "string"
      ? payload.stderrPath : null);
    return;
  }
  // 按父端的期限办事（续修 3）：离 deadlineAt 不足余量就不再起 runner。
  if (Date.now() > validated.deadlineAt - BRIDGE_REPLY_MARGIN_MS) {
    try { socket.destroy(); } catch { /* 已关 */ }
    fail("frame_timeout", validated.stderrPath);
    return;
  }

  // 3. 打开 stderr 证据文件（失败退回 "ignore"，不阻止启动——照第 89 批）。
  let stderrFd = null;
  try {
    stderrFd = openSync(validated.stderrPath, "a");
  } catch {
    stderrFd = null;
  }

  // 4. detached spawn runner：env/cwd 在创建进程时就生效（NODE_OPTIONS、import
  //    时读的变量都对）；argv 不过 cmd（% ! & ^ " 与超长参数原样到达）。
  //    cwd/execPath 不存在时 Node 不抛错、异步发 error 事件（续修 4）——必须
  //    接住，否则桥带着未处理 error 事件崩掉，谁都不知道为什么。
  let runner;
  try {
    runner = spawn(validated.execPath, validated.args, {
      detached: true,
      windowsHide: true,
      stdio: [validated.prompt !== null ? "pipe" : "ignore", "ignore", stderrFd === null ? "ignore" : stderrFd],
      env: validated.env,
      cwd: validated.cwd,
    });
  } catch {
    if (stderrFd !== null) { try { closeSync(stderrFd); } catch { /* 已随句柄关闭 */ } }
    fail("spawn_failed", validated.stderrPath);
    return;
  }
  runner.once("error", () => {
    // 异步 spawn 失败（ENOENT / cwd 不存在等）：写证据退出（幂等——fail 只走一次）。
    fail("spawn_failed", validated.stderrPath);
  });
  if (stderrFd !== null) {
    try { closeSync(stderrFd); } catch { /* runner 已继承句柄，本进程的副本关掉 */ }
  }

  // 5. prompt 经 stdin 交接（与派发方直起时同一实现）；超时用父端期限减去余量
  //    后的剩余时间（至少 1 毫秒）——桥不替父端另设时限。
  const handoff = await writeRunnerPrompt(runner, validated.prompt ?? "", {
    timeoutMs: Math.max(1, validated.deadlineAt - BRIDGE_REPLY_MARGIN_MS - Date.now()),
  });

  // 6. 回帧 → unref → 退出。handoff 为 "timeout" 时 runner 还活着不读提示词，
  //    结束权在父端（父端按 runnerPid taskkill /T /F——桥不该替父端做决定）。
  const reply = { runnerPid: Number.isInteger(runner.pid) && runner.pid > 0 ? runner.pid : null, handoff };
  runner.unref();
  await new Promise((resolve) => {
    const done = () => resolve();
    withDeadline(3000, done); // 回帧写出但对端迟迟不关：到点照常退出
    try {
      socket.end(encodeFrame(reply), done);
    } catch {
      done(); // 回帧写不进（父端已拆管道）：退出码照常 0——runner 已起，事实在父端判读
    }
  });
  process.exit(0);
}

main().catch(() => {
  // 兜底：任何未分类异常都不回显内容，固定退出码。
  process.exit(1);
});
