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

  // Delegate to shared application service
  const { stopRun } = await import("../application/runStop.js");
  const result = await stopRun({
    runId,
    runDir,
    deps: { ...deps, config },
  });

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
  // Process winner
  if (r.terminalAccepted && r.backend === "process") {
    return {
      runId: r.runId,
      stopped: r.stopVerified,
      backend: "process",
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
  if (r.rejected && r.backend === "process") {
    return {
      runId: r.runId,
      stopped: false,
      backend: "process",
      pid: r.pid,
      sideEffectAttempted: false,
      terminalAccepted: false,
      terminalState: r.terminalState,
    };
  }
  // Opencode winner
  if (r.terminalAccepted && r.backend !== "process") {
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
