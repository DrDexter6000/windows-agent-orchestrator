// src/commands/stop.js
//
// TD-98 阶段 2e-1b：stop 命令从 cli.js 拆出（行为不变，纯搬迁）。
//
// stop 不是只读 observe——它杀进程、做 stop verification、触发 alert。单独成族。
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
// 本模块内部 helper（command-local，只 stop 用）：killProcessTree（进程型 run 的 taskkill 杀进程树）。

import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { findLatest, findState } from "../transcript.js";
import { OpenCodeServeBackend } from "../backends/opencodeServe.js";
import { executeStopWithVerification } from "../backends/opencodeStopVerify.js";
import { raiseAlert } from "../alerts.js";
import { parseOptions, loadRun } from "./shared.js";

// C1: 进程型 run 的 stop 走 taskkill 杀进程树（/T 整树 /F 强杀）。
// 复用 processBackend._kill 的同款逻辑。PID 不存在/已退出 → 返回 false（调用方据此标 unverified）。
function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function stopCommand(args, config) {
  const [runId, ...tail] = args;
  const { transcript, events } = await loadRun(runId, parseOptions(tail), config);
  const session = findLatest(events, "session.created");
  if (!session?.backendSessionId) {
    throw new Error(`Run ${runId} has no session metadata (no session.created event)`);
  }

  // C1（F2 修复）：进程型 run（backendSessionId=proc_<pid>）无服务端 session 可 abort，
  // 走 taskkill 路径。进程死即会话死（OS 保证），taskkill 成功即 verified。
  // 与 opencode 路径分流——按 session 标志判定，不按 backend 名分支（runtime-agnostic）。
  if (session.backendSessionId.startsWith("proc_")) {
    const pid = Number(session.backendSessionId.slice("proc_".length));
    const fromState = findState(events);
    await transcript.append("run.stop_requested", { backendSessionId: session.backendSessionId, backend: "process" });
    const killed = killProcessTree(pid);
    // TD-99：run.aborted + aborted state_change 同一次 terminal transition commit（first-terminal-wins）。
    // 若 run 已终态（failed/completed/timed_out），transitionState rejected，不覆盖终态。
    const termResult = await transcript.transitionState(fromState, "aborted", "stop_requested", {
      factEvents: [{
        type: "run.aborted",
        payload: {
          backendSessionId: session.backendSessionId,
          backend: "process",
          reason: "stop_requested",
          verified: killed,
        },
      }],
    });
    if (!killed && termResult.accepted) {
      await transcript.append("run.stop_unverified", { backendSessionId: session.backendSessionId, reason: "process not found / already exited" });
    }
    console.log(JSON.stringify({
      runId,
      stopped: true,
      backend: "process",
      pid,
      taskkillCalled: true,
      verified: killed,
      terminalAccepted: termResult.accepted,
      terminalState: termResult.state,
      note: killed ? "process killed (process death = session death)" : "process not found (may have already exited)",
    }, null, 2));
    return;
  }

  if (!session?.serveUrl) {
    throw new Error(`Run ${runId} session ${session.backendSessionId} has no serveUrl (opencode path needs one)`);
  }
  const backend = new OpenCodeServeBackend();
  const fromState = findState(events);
  await transcript.append("run.stop_requested", { backendSessionId: session.backendSessionId });

  // S1-2（TD-37 落地）：abort 后验证后台是否真停。
  // 06-18 事故证明 abort HTTP 调用可能虚假成功——transcript 写 aborted 但 serve 端继续烧。
  // 现在：abort → verifyStopQuiet → quiet=false 强制 taskkill 兜底，不再只信 HTTP 返回。
  const stopResult = await executeStopWithVerification(
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
    // S1-3 告警：stop 未验证 = 后台可能仍在烧 token（06-18 事故复现路径），立即弹窗
    raiseAlert("stop_unverified",
      `stop ${runId} not verified: backend may still be running (taskkill=${stopResult.taskkillCalled})`,
      { runId, logPath: join(config.runDir, "ALERTS.log") },
    ).catch(() => { /* 告警失败不影响终态 */ });
  }
  // TD-99：run.aborted + aborted state_change 同一次 terminal transition commit。
  const termResult = await transcript.transitionState(fromState, "aborted", "stop_requested", {
    factEvents: [{
      type: "run.aborted",
      payload: {
        backendSessionId: session.backendSessionId,
        reason: "stop_requested",
        verified: stopResult.verified,
        taskkillCalled: stopResult.taskkillCalled,
      },
    }],
  });
  console.log(JSON.stringify({
    runId,
    stopped: true,
    verified: stopResult.verified,
    taskkillCalled: stopResult.taskkillCalled,
    terminalAccepted: termResult.accepted,
    terminalState: termResult.state,
  }, null, 2));
}
