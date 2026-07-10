// src/commands/stop.js
//
// TD-100：stop 副作用所有权与真实验证。
//
// 核心不变量：先 claim 终态（transitionState），只有 accepted winner 才执行
// 破坏性副作用（taskkill / backend.abort）。rejected loser 零副作用。
//
// 命令族：stop <runId>
//
// 依赖：
//   - 外部模块：../transcript.js（findLatest/findState）、../backends/opencodeServe.js
//     （opencode 路径的 backend.abort/messages）、../backends/opencodeStopVerify.js
//     （S1-2 abort 后验证 + taskkill 兜底）、../alerts.js（S1-3 stop_unverified 告警）
//   - 共享工具：./shared.js（parseOptions/loadRun）
//   - node built-in：child_process（spawnSync for killProcessTree）、path（join for ALERTS.log）
//
// TD-100 依赖注入（deps 参数，测试 mock 用）：
//   - kill(pid): 替代 killProcessTree，返回 {called, exitCode}
//   - isAlive(pid): 检查 PID 是否存活
//   - executeStop(backend, url, sid, opts): 替代 executeStopWithVerification
//   - alert(level, msg, opts): 替代 raiseAlert

import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { findLatest, findState } from "../transcript.js";
import { OpenCodeServeBackend } from "../backends/opencodeServe.js";
import { executeStopWithVerification } from "../backends/opencodeStopVerify.js";
import { raiseAlert } from "../alerts.js";
import { parseOptions, loadRun } from "./shared.js";

/**
 * taskkill 杀进程树。TD-100：返回结构化结果（不只 true/false）。
 * @returns {{called: boolean, exitCode: number|null}}
 */
function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { called: false, exitCode: null };
  try {
    const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "pipe" });
    return { called: true, exitCode: result.status };
  } catch {
    return { called: true, exitCode: null };
  }
}

/**
 * 检查 PID 是否存活。用 process.kill(pid, 0) 探测（不实际发信号，只检查存在性）。
 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true; // 存活
  } catch {
    return false; // 不存在或无权限（Windows 上 EPERM 也算"存在"——但我们保守取 false）
  }
}

/**
 * TD-100 process 路径：先 claim，只有 winner 才 kill。
 *
 * 判定表（verified = processAliveAfter === false）：
 *   PID 调用前已死（isAlive=false）→ 不调 taskkill → outcome=already_exited, verified=true
 *   taskkill 后 PID 死了           → outcome=killed, verified=true
 *   taskkill exit=0 但 PID 仍活     → outcome=still_running, verified=false
 *   taskkill 非零但 PID 最终死了   → outcome=already_exited, verified=true（不宣称 killed）
 *   taskkill 抛异常                → outcome=taskkill_error, verified=depends(isAlive)
 */
async function processStop({ transcript, session, fromState, runId, deps }) {
  const pid = Number(session.backendSessionId.slice("proc_".length));
  const kill = deps.kill ?? ((p) => killProcessTree(p));
  const isAlive = deps.isAlive ?? ((p) => isPidAlive(p));
  const alert = deps.alert ?? (async (level, msg, opts) => raiseAlert(level, msg, opts));

  // TD-100：先 claim 终态。
  const termResult = await transcript.transitionState(fromState, "aborted", "stop_requested", {
    factEvents: [{
      type: "run.aborted",
      payload: {
        backendSessionId: session.backendSessionId,
        backend: "process",
        reason: "stop_requested",
        verification: "pending",
      },
    }],
  });

  if (!termResult.accepted) {
    // rejected loser：零副作用，立即返回。
    console.log(JSON.stringify({
      runId,
      stopped: false,
      backend: "process",
      pid,
      sideEffectAttempted: false,
      terminalAccepted: false,
      terminalState: termResult.state,
    }, null, 2));
    return;
  }

  // accepted winner：执行停止副作用。
  const aliveBefore = isAlive(pid);
  let killResult = { called: false, exitCode: null };
  if (aliveBefore) {
    killResult = kill(pid);
  }
  // 后置存活检查（唯一 verified 判定依据）。
  const aliveAfter = isAlive(pid);
  const verified = aliveAfter === false;

  // 判定 outcome。
  let outcome;
  if (!aliveBefore) {
    outcome = "already_exited";
  } else if (aliveAfter) {
    outcome = killResult.called ? "still_running" : "still_running";
  } else {
    // kill 后死了。
    outcome = killResult.exitCode === 0 ? "killed" : "already_exited";
    // taskkill 非零但 PID 死了 → 不是本次 kill 杀的（可能同时自己退了）→ already_exited
    if (killResult.exitCode !== 0 && killResult.exitCode !== null) {
      outcome = "already_exited";
    }
    if (killResult.exitCode === null && killResult.called) {
      outcome = "taskkill_error";
    }
  }

  if (verified) {
    await transcript.append("run.stop_verified", { backendSessionId: session.backendSessionId, backend: "process", outcome });
  } else {
    await transcript.append("run.stop_unverified", {
      backendSessionId: session.backendSessionId,
      backend: "process",
      outcome,
      taskkillCalled: killResult.called,
      taskkillExitCode: killResult.exitCode,
      processAliveBefore: aliveBefore,
      processAliveAfter: aliveAfter,
    });
    // TD-100 补全：process 路径 unverified 也必须 raiseAlert（原实现漏了）。
    await alert("stop_unverified",
      `stop ${runId} not verified: process may still be running (pid=${pid}, outcome=${outcome})`,
      { runId, logPath: join(deps.config?.runDir ?? ".", "ALERTS.log") },
    ).catch(() => { /* 告警失败不影响终态 */ });
  }

  console.log(JSON.stringify({
    runId,
    stopped: verified,
    backend: "process",
    pid,
    sideEffectAttempted: true,
    terminalAccepted: true,
    terminalState: "aborted",
    verified,
    outcome,
    taskkillCalled: killResult.called,
    taskkillExitCode: killResult.exitCode,
    processAliveBefore: aliveBefore,
    processAliveAfter: aliveAfter,
  }, null, 2));
}

/**
 * TD-100 opencode 路径：先 claim，只有 winner 才 abort+verify。
 */
async function opencodeStop({ transcript, session, fromState, runId, config, deps }) {
  const backend = new OpenCodeServeBackend();
  const executeStop = deps.executeStop ?? ((b, url, sid, opts) => executeStopWithVerification(b, url, sid, opts));
  const alert = deps.alert ?? (async (level, msg, opts) => raiseAlert(level, msg, opts));

  // TD-100：先 claim 终态。
  const termResult = await transcript.transitionState(fromState, "aborted", "stop_requested", {
    factEvents: [{
      type: "run.aborted",
      payload: {
        backendSessionId: session.backendSessionId,
        backend: "opencode-serve",
        reason: "stop_requested",
        verification: "pending",
      },
    }],
  });

  if (!termResult.accepted) {
    console.log(JSON.stringify({
      runId,
      stopped: false,
      sideEffectAttempted: false,
      terminalAccepted: false,
      terminalState: termResult.state,
    }, null, 2));
    return;
  }

  // accepted winner：执行 abort + verification。
  const stopResult = await executeStop(
    backend, session.serveUrl, session.backendSessionId,
    { cwd: session.cwd, rounds: 3, intervalMs: 2000 },
  );

  if (stopResult.verified) {
    await transcript.append("run.stop_verified", { backendSessionId: session.backendSessionId });
  } else {
    await transcript.append("run.stop_unverified", {
      backendSessionId: session.backendSessionId,
      taskkillCalled: stopResult.taskkillCalled,
      delta: stopResult.verifyResult?.delta,
      metric: stopResult.verifyResult?.metric,
    });
    await alert("stop_unverified",
      `stop ${runId} not verified: backend may still be running (taskkill=${stopResult.taskkillCalled})`,
      { runId, logPath: join(config.runDir, "ALERTS.log") },
    ).catch(() => { /* 告警失败不影响终态 */ });
  }

  console.log(JSON.stringify({
    runId,
    stopped: stopResult.verified,
    sideEffectAttempted: true,
    terminalAccepted: true,
    terminalState: "aborted",
    verified: stopResult.verified,
    taskkillCalled: stopResult.taskkillCalled,
  }, null, 2));
}

/**
 * stop 命令。
 *
 * @param {string[]} args
 * @param {object} config
 * @param {{kill?, isAlive?, executeStop?, alert?, config?}} [deps] TD-100 依赖注入（测试 mock）
 */
export async function stopCommand(args, config, deps = {}) {
  const [runId, ...tail] = args;
  const { transcript, events } = await loadRun(runId, parseOptions(tail), config);
  const session = findLatest(events, "session.created");
  if (!session?.backendSessionId) {
    throw new Error(`Run ${runId} has no session metadata (no session.created event)`);
  }

  // TD-100：stop_requested 在 claim 之前写（记录意图），必须含 reason。
  const fromState = findState(events);
  await transcript.append("run.stop_requested", {
    backendSessionId: session.backendSessionId,
    ...(session.backendSessionId.startsWith("proc_") ? { backend: "process" } : {}),
    reason: "user",
  });

  // TD-100：按 session 标志分流（runtime-agnostic）。
  if (session.backendSessionId.startsWith("proc_")) {
    await processStop({ transcript, session, fromState, runId, deps: { ...deps, config } });
    return;
  }

  if (!session?.serveUrl) {
    throw new Error(`Run ${runId} session ${session.backendSessionId} has no serveUrl (opencode path needs one)`);
  }

  await opencodeStop({ transcript, session, fromState, runId, config, deps });
}
