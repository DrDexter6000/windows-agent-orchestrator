// src/application/runStop.js
//
// M10 P0-2A: Shared run stop application service.
//
// Extracted from src/commands/stop.js to share between CLI and MCP.
// Both CLI stop and MCP run_stop call this service. The service owns:
//   - first-terminal-wins claim via transitionState (TD-99/TD-100)
//   - winner-only destructive side effect (kill/abort)
//   - process exit verification (verified/unverified)
//   - workspace ownership authorization (MCP path only)
//
// Architectural contract:
//   - Does NOT import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Does NOT parse argv, console.log, or shell-out CLI.
//   - Reuses transcript, process/opencode stop primitives, verification, alert.
//   - Returns structured results; CLI/MCP adapters format output.
//
// Workspace authorization (MCP path):
//   When authorizedWorkspaceRoot is provided (MCP), the service verifies the
//   run's dispatch cwd (run.background_submitted.cwd) matches the authorized
//   root's canonical Git top-level BEFORE any terminal claim or side effect.
//   Authorization failure = zero events, zero side effects, fixed error.
//   CLI path (authorizedWorkspaceRoot absent) skips authorization — CLI is
//   human/ops and can stop any run in the specified runDir.

import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";

import { JsonlTranscript, readTranscript, findState, findLatestBound, STATE_CHANGE_REASON, findLastEventSeq } from "../transcript.js";
import { resolveTranscriptPath } from "../projectBuckets.js";
import { OpenCodeServeBackend } from "../backends/opencodeServe.js";
import { executeStopWithVerification } from "../backends/opencodeStopVerify.js";
import { raiseAlert } from "../alerts.js";
import { isValidRunId } from "../delivery.js";
// R21（TD-128 W3）：已拒路径回显 terminalState 的绑定作用域——metrics.js
// 单一定义处（runList.js 同款 import 族）。
import { boundReportScope } from "../metrics.js";
import { findRunWorkspaceOwnership, verifyRunWorkspaceOwnership } from "./runWorkspaceOwnership.js";
// M12-19: the conservative process-alive probe now lives in ownerLiveness (the
// liveness SSOT), shared with the process_missing recovery proof. Imported here
// and re-exported below so commands/stop.js and existing tests keep working.
import { isPidAlive } from "./ownerLiveness.js";

// ── Process primitives (owned here, not in commands/) ────────────────────────

/**
 * Kill a process tree on Windows using taskkill /T /F.
 * Returns { called, exitCode } — never throws.
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
 * Bounded poll: wait for PID to exit.
 */
async function waitForPidExit(pid, isAliveFn, sleep, pollConfig = {}) {
  const rounds = pollConfig.rounds ?? 5;
  const intervalMs = pollConfig.intervalMs ?? 200;
  for (let i = 0; i < rounds; i += 1) {
    if (!isAliveFn(pid)) return false;
    if (i < rounds - 1) await sleep(intervalMs);
  }
  return isAliveFn(pid);
}

// ── Workspace ownership verification (delegated to runWorkspaceOwnership SSOT) ─

// The ownership algorithm lives in src/application/runWorkspaceOwnership.js.
// runStop.js delegates to it — no second copy of the logic.
// Re-export for backward compatibility with existing test imports.


// ── Main service ─────────────────────────────────────────────────────────────

/**
 * Stop a run with first-terminal-wins semantics.
 *
 * @param {object} input
 * @param {string} input.runId
 * @param {string} input.runDir
 * @param {string} [input.authorizedWorkspaceRoot] — MCP workspace binding (optional)
 * @param {object} [input.deps] — test injection (kill, isAlive, executeStop, alert, etc.)
 * @returns {Promise<object>} structured result (see below)
 *
 * Result shape:
 *   {
 *     runId, terminalAccepted, terminalState,
 *     sideEffectAttempted, stopVerified,
 *     backend, outcome?, pid?, taskkillCalled?, taskkillExitCode?,
 *     processAliveBefore?, processAliveAfter?,
 *     // loser path:
 *     rejected?: true,
 *     // invalid PID:
 *     invalidPid?: true,
 *     // auth failure:
 *     authorized?: false, authorizationError?: string,
 *   }
 */
export async function stopRun(input) {
  const { runId, runDir, authorizedWorkspaceRoot } = input;
  const deps = input.deps ?? {};

  // ── FIX-A: runId validation BEFORE any path join or file read ─────────────
  // Prevents path traversal (../, absolute paths, separators, shell chars).
  // Uses the existing isValidRunId SSOT from delivery.js.
  if (!isValidRunId(runId)) {
    throw new Error(`invalid runId: ${JSON.stringify(runId)}`);
  }

  // Resolve runDir
  const resolvedRunDir = resolveRunDir(runDir);
  // 验收批 S2：跨层未命中映射回既有 not-found 拒绝（同 catch 内 ENOENT 语义）；
  // 孪生冲突等损坏形态如实上抛。
  let transcriptPath;
  try {
    transcriptPath = resolveTranscriptPath(resolvedRunDir, runId, { forAppend: true });
  } catch (e) {
    if (e?.code === "transcript-not-found") {
      throw new Error(`cannot read transcript for run ${runId}: transcript missing in any layer`);
    }
    throw e;
  }

  // Read transcript
  let events;
  try {
    events = await readTranscript(transcriptPath);
  } catch (err) {
    throw new Error(`cannot read transcript for run ${runId}: ${err.message}`);
  }

  // ── Workspace authorization (MCP path only) ───────────────────────────────
  // This is the FIRST check — before any terminal claim, attempt event, kill,
  // HTTP stop, or alert. Authorization failure = zero events, zero side effects.
  if (authorizedWorkspaceRoot !== undefined) {
    try {
      verifyRunWorkspaceOwnership(events, authorizedWorkspaceRoot, runId);
    } catch (err) {
      return {
        runId,
        authorized: false,
        authorizationError: err.message,
        terminalAccepted: false,
        // R21（TD-128 W3）：已拒路径回显的 terminalState 绑定到请求 runId——
        // 外 run 尾条终态不再供给该回显（同文件 fromState（原 :168）已绑的纪律
        // 补齐）。与该处 plain filter 不同，此处取 boundReportScope（?? events
        // legacy 回退）：授权检查先于 session 查找，全无信封的 pre-envelope
        // transcript 可达本路径（ownership 的 legacy 容忍可先失败）——保持历史
        // 回显；任一事件带信封即严格绑定（合法全绑定路径恒等）。
        terminalState: findState(boundReportScope(events, runId) ?? events) ?? "unknown",
        sideEffectAttempted: false,
        stopVerified: null,
      };
    }
  }

  // ── Session lookup ────────────────────────────────────────────────────────
  // R13-C (TD-127 family sweep, auditor P1-2): the kill lane's session lookup
  // is BOUND to the requested runId. An unbound findLatest let a tail-appended
  // FOREIGN-run session.created win the kill: its backendSessionId became
  // proc_<pid> and stop killed THAT pid (auditor probe: real proc_1111 +
  // forged proc_2222 tail → KILLED 2222) — a destructive side effect escaping
  // the WAO trust domain onto an arbitrary local process. LAST-bound keeps the
  // lane's established order semantics (latest session wins, same as before
  // and as runCollect.js:184); binding only removes foreign lines. Same-family
  // sweep in this file: the run.started agentId read below is bound the same
  // way. Legacy no-envelope transcripts (events without a runId field) now
  // fall into the existing "no session metadata" refusal right below — the
  // same error face a transcript with no session.created at all gets.
  const session = findLatestBound(events, "session.created", runId);
  if (!session?.backendSessionId) {
    throw new Error(`Run ${runId} has no session metadata (no session.created event)`);
  }

  // R18 (TD-128 W3)：fromState 投影绑定到请求 runId（R15 范式——
  // `findState(events.filter(bound))`）。fromState 落进 transitionState 写出的
  // run.state_change.from 字段（审计事实）：外 run 尾条不再供给该审计值。
  // legacy 无信封 transcript 到达不了这里——上方 session 查找（findLatestBound）
  // 已按 "no session metadata" 拒绝（R13-C），故本处无需 legacy 分支（空绑定集
  // → findState([]) = "pending" 的保守默认仅在理论形状可达）。
  const fromState = findState(events.filter((e) => e && e.runId === runId));
  const stopRequestedAttempt = {
    type: "run.stop_requested",
    payload: {
      backendSessionId: session.backendSessionId,
      ...(session.backendSessionId.startsWith("proc_") ? { backend: "process" } : {}),
      reason: "user",
    },
  };

  // Re-open transcript for writing
  const transcript = new JsonlTranscript(transcriptPath, {
    runId,
    // TD-234 验收修（opus C3，2026-10-08）：既有账本的 last seq 必须随构造传入
    // ——否则本实例 seq=0，若账本在预读与加锁之间被删，transitionState 的
    // ENOENT 豁免会把既有账本误判成空账本（孤儿 stop 事实）。与
    // commands/shared.js:161 同款。
    initialSeq: findLastEventSeq(events),
    // R13-C: bound read (same sweep as the session lookup above) — a foreign
    // tail run.started never supplies the writer context's agentId.
    agentId: findLatestBound(events, "run.started", runId)?.agentId ?? "unknown",
  });

  // ── Process path ──────────────────────────────────────────────────────────
  if (session.backendSessionId.startsWith("proc_")) {
    const rawPid = session.backendSessionId.slice("proc_".length);
    const pid = Number(rawPid);
    if (!Number.isInteger(pid) || pid <= 0) {
      return await invalidPidStop({
        transcript, session, fromState, runId, deps, stopRequestedAttempt, rawPid,
        runDir: resolvedRunDir,
      });
    }
    return await processStop({
      transcript, session, fromState, runId, pid, deps, stopRequestedAttempt,
      runDir: resolvedRunDir,
    });
  }

  // ── Opencode path ─────────────────────────────────────────────────────────
  if (!session?.serveUrl) {
    throw new Error(`Run ${runId} session has no serveUrl (opencode path needs one)`);
  }
  return await opencodeStop({
    transcript, session, fromState, runId, deps, stopRequestedAttempt,
    runDir: resolvedRunDir,
  });
}

// ── processStop (extracted from stop.js) ─────────────────────────────────────

async function processStop({ transcript, session, fromState, runId, pid, deps, stopRequestedAttempt, runDir }) {
  const kill = deps.kill ?? ((p) => killProcessTree(p));
  const isAlive = deps.isAlive ?? ((p) => isPidAlive(p));
  const alert = deps.alert ?? (async (level, msg, opts) => raiseAlert(level, msg, opts));

  // Claim terminal state (first-terminal-wins)
  const termResult = await transcript.transitionState(fromState, "aborted", STATE_CHANGE_REASON.stop_requested, {
    attemptEvents: stopRequestedAttempt ? [stopRequestedAttempt] : [],
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
    return {
      runId, rejected: true,
      terminalAccepted: false,
      terminalState: termResult.state,
      sideEffectAttempted: false,
      stopVerified: null,
      backend: "process",
      pid,
    };
  }

  // Winner: execute side effect
  const aliveBefore = isAlive(pid);
  let killResult = { called: false, exitCode: null };
  if (aliveBefore) {
    killResult = kill(pid);
  }

  const waitForExit = deps.waitForExit ?? ((p, ia, sl, pc) => waitForPidExit(p, ia, sl, pc));
  const sleepFn = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollConfig = deps.pollConfig ?? {};
  const aliveAfter = aliveBefore
    ? await waitForExit(pid, isAlive, sleepFn, pollConfig)
    : isAlive(pid);
  const verified = aliveAfter === false;

  // Determine outcome
  let outcome;
  if (!aliveBefore) {
    outcome = "already_exited";
  } else if (aliveAfter) {
    outcome = "still_running";
  } else if (killResult.called && killResult.exitCode === 0) {
    outcome = "killed";
  } else if (killResult.called && killResult.exitCode === null) {
    outcome = "taskkill_error";
  } else {
    outcome = "already_exited";
  }

  // Write verification fact
  if (verified) {
    await transcript.append("run.stop_verified", {
      backendSessionId: session.backendSessionId,
      backend: "process",
      outcome,
      taskkillCalled: killResult.called,
      taskkillExitCode: killResult.exitCode,
      processAliveBefore: aliveBefore,
      processAliveAfter: aliveAfter,
    });
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
    // TD-233（告警落点收口）：告警跟随本调用实际解析出的 runDir（与转录同一
    // 来源，stopRun 传入的 resolvedRunDir），绝不回落到进程 cwd。
    await alert("stop_unverified",
      `stop ${runId} not verified: process may still be running (pid=${pid}, outcome=${outcome})`,
      { runId, logPath: join(dirname(transcript.filePath), "ALERTS.log") },
    ).catch(() => { /* alert failure doesn't affect terminal state */ });
  }

  return {
    runId,
    terminalAccepted: true,
    terminalState: "aborted",
    // FIX-C: sideEffectAttempted reflects whether the destructive primitive was
    // actually called. If the process was already dead (aliveBefore=false), no
    // kill was attempted — report false. Only report true when kill was called.
    sideEffectAttempted: killResult.called,
    stopVerified: verified,
    backend: "process",
    pid,
    outcome,
    taskkillCalled: killResult.called,
    taskkillExitCode: killResult.exitCode,
    processAliveBefore: aliveBefore,
    processAliveAfter: aliveAfter,
  };
}

// ── opencodeStop (extracted from stop.js) ────────────────────────────────────

async function opencodeStop({ transcript, session, fromState, runId, deps, stopRequestedAttempt, runDir }) {
  const executeStop = deps.executeStop ?? ((b, url, sid, opts) => executeStopWithVerification(b, url, sid, opts));
  const alert = deps.alert ?? (async (level, msg, opts) => raiseAlert(level, msg, opts));
  const backend = deps.opencodeBackend ?? new OpenCodeServeBackend({
    fetchImpl: deps.fetchImpl ?? globalThis.fetch,
  });

  const termResult = await transcript.transitionState(fromState, "aborted", STATE_CHANGE_REASON.stop_requested, {
    attemptEvents: stopRequestedAttempt ? [stopRequestedAttempt] : [],
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
    return {
      runId, rejected: true,
      terminalAccepted: false,
      terminalState: termResult.state,
      sideEffectAttempted: false,
      stopVerified: null,
    };
  }

  // Winner: execute backend abort
  const stopVerify = deps.stopVerify ?? {};
  const stopResult = await executeStop(
    backend, session.serveUrl, session.backendSessionId,
    {
      cwd: session.cwd,
      rounds: stopVerify.rounds ?? 3,
      intervalMs: stopVerify.intervalMs ?? 2000,
      ...(typeof deps.taskkill === "function" ? { taskkill: deps.taskkill } : {}),
    },
  );

  if (stopResult.verified) {
    await transcript.append("run.stop_verified", {
      backendSessionId: session.backendSessionId,
      backend: "opencode-serve",
      method: "abort+verify",
      taskkillCalled: stopResult.taskkillCalled ?? false,
    });
  } else {
    await transcript.append("run.stop_unverified", {
      backendSessionId: session.backendSessionId,
      backend: "opencode-serve",
      method: "abort+verify",
      taskkillCalled: stopResult.taskkillCalled ?? false,
    });
    // TD-233（告警落点收口）：同 processStop——告警跟随实际写转录的 runDir。
    await alert("stop_unverified",
      `stop ${runId} not verified: opencode session may still be active`,
      { runId, logPath: join(dirname(transcript.filePath), "ALERTS.log") },
    ).catch(() => { /* alert failure doesn't affect terminal state */ });
  }

  return {
    runId,
    terminalAccepted: true,
    terminalState: "aborted",
    // FIX-C: sideEffectAttempted reflects whether the destructive primitive
    // (executeStop) was actually called. Since we reach here only after a
    // successful executeStop call, this is true. If executeStop threw, the
    // error would propagate (no swallow) — so reaching this line means it ran.
    sideEffectAttempted: true,
    stopVerified: stopResult.verified ?? false,
    taskkillCalled: stopResult.taskkillCalled ?? false,
  };
}

// ── invalidPidStop (extracted from stop.js) ──────────────────────────────────

async function invalidPidStop({ transcript, session, fromState, runId, deps, stopRequestedAttempt, rawPid, runDir }) {
  const alert = deps.alert ?? (async (level, msg, opts) => raiseAlert(level, msg, opts));

  // Does NOT claim terminal state — records stop_requested + stop_unverified
  await transcript.append("run.stop_requested", {
    backendSessionId: session.backendSessionId,
    backend: "process",
    reason: "user",
  });
  await transcript.append("run.stop_unverified", {
    backendSessionId: session.backendSessionId,
    backend: "process",
    outcome: "invalid_pid",
    taskkillCalled: false,
    taskkillExitCode: null,
    processAliveBefore: false,
    processAliveAfter: false,
  });
  // TD-233（告警落点收口）：同 processStop——告警跟随实际写转录的 runDir。
  await alert("stop_unverified",
    `Run ${runId} has invalid PID: ${rawPid}`,
    { runId, logPath: join(dirname(transcript.filePath), "ALERTS.log") },
  ).catch(() => { /* alert failure doesn't affect terminal state */ });

  return {
    runId,
    invalidPid: true,
    terminalAccepted: false,
    terminalState: fromState ?? "unknown",
    sideEffectAttempted: false,
    stopVerified: false,
    backend: "process",
    outcome: "invalid_pid",
    taskkillCalled: false,
    taskkillExitCode: null,
    processAliveBefore: false,
    processAliveAfter: false,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// TD-233（告警落点收口）：本函数的返回值是转录与告警的共同落点 SSOT。
// 缺省时落到 <cwd>/runs（非裸 cwd）——转录从这个目录读，告警就写到这个目录，
// 两者永不分离；返回值恒为绝对路径，因此告警路径 join(runDir, "ALERTS.log")
// 不存在"落到进程 cwd"的缺省形态（alerts.js 的相对缺省仅在其直接调用方不传
// logPath 时可达，runStop 不属于该形态）。
function resolveRunDir(runDir) {
  if (!runDir) return join(process.cwd(), "runs");
  return resolve(runDir);
}

// Re-export ownership helpers for backward compatibility with tests that
// import from runStop.js. The canonical implementation is in runWorkspaceOwnership.js.
export { findRunWorkspaceOwnership as findOwnershipFact, verifyRunWorkspaceOwnership as verifyWorkspaceOwnership } from "./runWorkspaceOwnership.js";
export { killProcessTree, isPidAlive, waitForPidExit };
