// src/commands/stop.js
//
// TD-100：stop 副作用所有权与真实验证。
//
// 核心不变量：先 claim 终态（transitionState），只有 accepted winner 才执行
// 破坏性副作用（taskkill / backend.abort）。rejected loser 零副作用。
//
// M10 P0-2A: processStop/opencodeStop/invalidPidStop logic extracted to
// src/application/runStop.js. This module now owns only:
//   - CLI adapter (argv parsing + JSON output formatting)
//   - Primitive helpers exported for the service: killProcessTree, isPidAlive, waitForPidExit
//
// 命令族：stop <runId>
//
// 依赖注入（deps 参数，测试 mock 用）：
//   - kill(pid): 替代 killProcessTree，返回 {called, exitCode}
//   - isAlive(pid): 检查 PID 是否存活
//   - executeStop(backend, url, sid, opts): 替代 executeStopWithVerification
//   - alert(level, msg, opts): 替代 raiseAlert

import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { parseOptions } from "./shared.js";

// ── Primitive helpers (re-exported from runStop.js for test compatibility) ──
// The canonical implementations live in src/application/runStop.js.
// They are re-exported here so existing test imports from stop.js still work.
export { killProcessTree, isPidAlive, waitForPidExit } from "../application/runStop.js";

// ── CLI adapter ──────────────────────────────────────────────────────────────

/**
 * stop 命令。CLI human/ops fallback — 无 workspace 授权限制。
 * 委托 stopRun service（M10 P0-2A），输出保持既有 JSON 格式兼容。
 */
export async function stopCommand(args, config, deps = {}) {
  const [runId, ...tail] = args;
  const options = parseOptions(tail);
  const runDir = options.runDir ?? config.runDir;

  // 决定 0069：中止前先看最新状态、并说明理由——两项都是必填。
  const observedSeq = /^\d+$/.test(String(options.observedSeq ?? "")) ? Number(options.observedSeq) : null;
  const reason = typeof options.reason === "string" ? options.reason : "";
  const protocol = `先看最新状态：status ${runId}（输出里的 observedSeq），再执行：stop ${runId} --observed-seq <observedSeq> --reason "<为什么要停>"`;
  if (observedSeq === null || reason.trim().length === 0) {
    throw new Error(`stop 需要 --observed-seq 与 --reason。${protocol}`);
  }

  // Delegate to shared application service
  const { stopRun, STOP_REASON_MIN_LEN, STOP_REASON_MAX_LEN, STOP_OBSERVATION_MAX_AGE_SECONDS } = await import("../application/runStop.js");
  const result = await stopRun({
    runId,
    runDir,
    justification: { reason, observedSeq },
    deps: { ...deps, config },
  });
  if (result.preconditionFailed) {
    const why = {
      reason_required: `--reason 需要 ${STOP_REASON_MIN_LEN}–${STOP_REASON_MAX_LEN} 个字符`,
      observation_unknown: "--observed-seq 不是这个运行转录里的位置",
      observation_stale: `worker 在你看到的位置之后又有了动作，且已过去超过 ${STOP_OBSERVATION_MAX_AGE_SECONDS / 60} 分钟（${result.newerEventCount} 条新事件）`,
    }[result.preconditionFailed] ?? result.preconditionFailed;
    throw new Error(`stop 未执行（零副作用）：${why}。${protocol}`);
  }

  // Convert structured result to backward-compatible CLI JSON
  console.log(JSON.stringify(stopResultToCliJson(result), null, 2));
}

/**
 * Convert the structured stopRun result to backward-compatible CLI JSON shape.
 */
function stopResultToCliJson(r) {
  // Authorization failure (MCP-only path; CLI never hits this)
  if (r.authorized === false) {
    return {
      runId: r.runId,
      stopped: false,
      sideEffectAttempted: false,
      terminalAccepted: false,
      terminalState: r.terminalState,
    };
  }
  // 进程树击杀路由的结果带 pid（proc_<pid> 占位 id 或 session.created.hostPid，
  // TD-265）——按结果形状区分路由，不按后端名；backend 如实回显会话记录的值。
  const viaProcess = typeof r.pid === "number";
  // Process winner
  if (r.terminalAccepted && viaProcess) {
    return {
      runId: r.runId,
      stopped: r.stopVerified,
      backend: r.backend,
      pid: r.pid,
      sideEffectAttempted: r.sideEffectAttempted,
      terminalAccepted: true,
      terminalState: "aborted",
      verified: r.stopVerified,
      outcome: r.outcome,
      taskkillCalled: r.taskkillCalled,
      taskkillExitCode: r.taskkillExitCode,
      processAliveBefore: r.processAliveBefore,
      processAliveAfter: r.processAliveAfter,
    };
  }
  // Process loser
  if (r.rejected && viaProcess) {
    return {
      runId: r.runId,
      stopped: false,
      backend: r.backend,
      pid: r.pid,
      sideEffectAttempted: false,
      terminalAccepted: false,
      terminalState: r.terminalState,
    };
  }
  // Opencode winner
  if (r.terminalAccepted && !viaProcess) {
    return {
      runId: r.runId,
      stopped: r.stopVerified,
      sideEffectAttempted: true,
      terminalAccepted: true,
      terminalState: "aborted",
      verified: r.stopVerified,
      taskkillCalled: r.taskkillCalled,
    };
  }
  // Opencode loser
  if (r.rejected) {
    return {
      runId: r.runId,
      stopped: false,
      sideEffectAttempted: false,
      terminalAccepted: false,
      terminalState: r.terminalState,
    };
  }
  // Invalid PID
  if (r.invalidPid) {
    return {
      runId: r.runId,
      stopped: false,
      backend: "process",
      sideEffectAttempted: false,
      terminalAccepted: false,
      terminalState: r.terminalState,
      verified: false,
      outcome: "invalid_pid",
      taskkillCalled: false,
      taskkillExitCode: null,
      processAliveBefore: false,
      processAliveAfter: false,
    };
  }
  // Fallback
  return r;
}
