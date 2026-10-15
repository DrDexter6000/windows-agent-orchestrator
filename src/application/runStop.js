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
// The pid-identity judgment (is the pid still the process the session record
// refers to?) lives there too — the kill lane consumes it below.
import { isPidAlive, identifyProcessIdentity } from "./ownerLiveness.js";

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


// ── Lead justification (决定 0069) ───────────────────────────────────────────
//
// Owner 2026-10-13：要中止一个运行，Lead 必须先探明 worker 的最新状态，并说明
// 理由。两个 Lead 面（MCP run_stop、CLI stop）都带 justification 调本服务：
//   - reason：为什么要停（记进 run.stop_requested，不做语义判断）；
//   - observedSeq：Lead 做决定时看到的转录位置（run_activity 最新一条的 seq /
//     CLI status 的 observedSeq）。在它之后落下的 worker 事件若已超过
//     STOP_OBSERVATION_MAX_AGE_SECONDS，说明这个决定是照着过时的状态做的——
//     拒绝，零事件、零副作用，让 Lead 重新看过再决定。刚落下的事件不算过时
//     （否则话多的 worker 永远停不掉）；位置之后运行被重放过（停止目标换了）
//     则不论多久都拒绝。
//   这是"决定不能照着过时的状态做"的校验，不是"调用过 run_activity"的证明：
//   run_activity 零写入，控制面无从得知；一个刚派发两分钟的运行，位置填 0 也过。
// 不带 justification 的调用是内部 / 机制测试路径，不做这项检查。
export const STOP_REASON_MIN_LEN = 6;
export const STOP_REASON_MAX_LEN = 400;
export const STOP_OBSERVATION_MAX_AGE_SECONDS = 2 * 60;
export const STOP_PRECONDITION_CODES = Object.freeze([
  "reason_required",
  "observation_required",
  "observation_unknown",
  "observation_stale",
  "target_changed",
]);

function checkStopJustification(justification, scope, nowMs) {
  const reason = typeof justification?.reason === "string"
    ? justification.reason.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").replace(/\s+/g, " ").trim()
    : "";
  if (reason.length < STOP_REASON_MIN_LEN || reason.length > STOP_REASON_MAX_LEN) {
    return { ok: false, code: "reason_required" };
  }
  const observedSeq = justification?.observedSeq;
  if (!Number.isInteger(observedSeq) || observedSeq < 0) {
    return { ok: false, code: "observation_required" };
  }
  // 位置必须真的是这个运行转录里的一条（0 = 还没有任何条目时的起点）。
  if (observedSeq !== 0 && !scope.some((e) => e.seq === observedSeq)) {
    return { ok: false, code: "observation_unknown" };
  }
  // 看到的位置之后运行被重放过（run.rerun）——停止目标已经换成 Lead 没看过的
  // 进程，不论过去多久都得重新看。
  if (scope.some((e) => e.type === "run.rerun" && Number.isInteger(e.seq) && e.seq > observedSeq)) {
    return { ok: false, code: "target_changed" };
  }
  const workerEvents = scope.filter((e) => e.type === "run.event");
  const newer = workerEvents.filter((e) => Number.isInteger(e.seq) && e.seq > observedSeq);
  if (newer.length > 0) {
    const oldestNewerMs = new Date(newer[0].ts).getTime();
    // 时间戳在未来（时钟回拨）按刚落下处理；读不出时间戳的按过时处理。
    const ageSeconds = Number.isFinite(oldestNewerMs) ? Math.max(0, Math.round((nowMs - oldestNewerMs) / 1000)) : Infinity;
    if (ageSeconds > STOP_OBSERVATION_MAX_AGE_SECONDS) {
      return { ok: false, code: "observation_stale", newerEventCount: newer.length };
    }
  }
  const lastWorkerMs = workerEvents.length > 0 ? new Date(workerEvents.at(-1).ts).getTime() : NaN;
  return {
    ok: true,
    facts: {
      statedReason: reason,
      observedSeq,
      newerEventCount: newer.length,
      // 最近一条 worker 事件（含 runtime_activity）距今多久——"有生命体征的 10
      // 分钟内不建议中止"这条建议的事实侧；没有任何 worker 事件时为 null。
      // 这几项取自认领之前读到的快照：并发增长时不保证覆盖到落盘那一刻。
      secondsSinceVitalSign: Number.isFinite(lastWorkerMs) ? Math.max(0, Math.round((nowMs - lastWorkerMs) / 1000)) : null,
    },
  };
}

// ── Main service ─────────────────────────────────────────────────────────────

/**
 * Stop a run with first-terminal-wins semantics.
 *
 * @param {object} input
 * @param {string} input.runId
 * @param {string} input.runDir
 * @param {string} [input.authorizedWorkspaceRoot] — MCP workspace binding (optional)
 * @param {{reason: string, observedSeq: number}} [input.justification] — Lead 面必带
 *   （决定 0069）；不满足时返回 { preconditionFailed: <STOP_PRECONDITION_CODES> }，
 *   零事件、零副作用
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
  const created = findLatestBound(events, "session.created", runId);
  if (!created?.backendSessionId) {
    throw new Error(`Run ${runId} has no session metadata (no session.created event)`);
  }
  // resume 以新进程重放之后（run.rerun 晚于 session.created），承载运行的是重放
  // 记录的新会话与新进程——停止目标取它，不取 session.created 里已被替换的旧
  // 进程（此前重放后的 stop 仍指向旧 pid：旧进程已退出时会报"已核验停止"而新
  // worker 还在跑）。重放记录没带 hostPid 时该字段置空，不沿用旧值。同为 runId
  // 绑定读取。
  const rerun = findLatestBound(events, "run.rerun", runId);
  const replayed = typeof rerun?.newSessionId === "string" && rerun.newSessionId.length > 0
    && Number.isInteger(rerun.seq) && Number.isInteger(created.seq) && rerun.seq > created.seq;
  const session = replayed
    ? { ...created, backendSessionId: rerun.newSessionId, hostPid: rerun.hostPid }
    : created;
  // pid 身份门的时刻锚：与 pid 同一条记录的 ts——重放过取 run.rerun 那条的 ts，
  // 否则取 session.created 的 ts。上方合成的 session 对象沿用了旧 session.created
  // 的其余字段，不能从它反推锚。
  const identityAnchorAt = Date.parse(replayed ? rerun.ts : created.ts);

  // R18 (TD-128 W3)：fromState 投影绑定到请求 runId（R15 范式——
  // `findState(events.filter(bound))`）。fromState 落进 transitionState 写出的
  // run.state_change.from 字段（审计事实）：外 run 尾条不再供给该审计值。
  // legacy 无信封 transcript 到达不了这里——上方 session 查找（findLatestBound）
  // 已按 "no session metadata" 拒绝（R13-C），故本处无需 legacy 分支（空绑定集
  // → findState([]) = "pending" 的保守默认仅在理论形状可达）。
  const boundScope = events.filter((e) => e && e.runId === runId);
  const fromState = findState(boundScope);
  // 决定 0069：Lead 面的 stop 先过理由 + 观察位置这一关（在任何终态认领、事件
  // 追加、击杀之前；不通过 = 零事件、零副作用）。
  let leadFacts = {};
  if (input.justification !== undefined) {
    const nowFn = deps.nowFn ?? Date.now;
    const verdict = checkStopJustification(input.justification, boundScope, nowFn());
    if (!verdict.ok) {
      return {
        runId,
        preconditionFailed: verdict.code,
        ...(verdict.newerEventCount !== undefined ? { newerEventCount: verdict.newerEventCount } : {}),
        terminalAccepted: false,
        terminalState: fromState,
        sideEffectAttempted: false,
        stopVerified: null,
      };
    }
    leadFacts = verdict.facts;
  }
  // TD-265：停止走哪条路由由会话记录的事实决定，不按后端名分支——proc_<pid>
  // 占位 id，以及"provider 原生会话 id + session.created.hostPid（承载会话的本机
  // 进程）"，都走进程树击杀；有 serveUrl 的走服务端中止。此前非 proc_ 一律被当
  // 成 serveUrl 路由，原生会话 id 的进程式后端因此停不掉。
  const isProcPlaceholder = session.backendSessionId.startsWith("proc_");
  const hostPid = !isProcPlaceholder && !session.serveUrl
    && Number.isInteger(session.hostPid) && session.hostPid > 0
    ? session.hostPid
    : null;
  const hostBackend = typeof session.backend === "string" && session.backend.length > 0 ? session.backend : "process";
  const stopRequestedAttempt = {
    type: "run.stop_requested",
    payload: {
      backendSessionId: session.backendSessionId,
      ...(isProcPlaceholder ? { backend: "process" } : hostPid !== null ? { backend: hostBackend } : {}),
      reason: "user",
      ...leadFacts,
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
      runDir: resolvedRunDir, anchorAt: identityAnchorAt,
    });
  }

  // ── Host-process path ─────────────────────────────────────────────────────
  if (hostPid !== null) {
    return await processStop({
      transcript, session, fromState, runId, pid: hostPid, deps, stopRequestedAttempt,
      runDir: resolvedRunDir, backend: hostBackend, anchorAt: identityAnchorAt,
    });
  }

  // ── Opencode path ─────────────────────────────────────────────────────────
  if (!session?.serveUrl) {
    throw new Error(
      `Run ${runId} has no stop route: its session (backend ${session.backend ?? "unknown"}) records neither a host process id nor a serveUrl — `
      + "the worker process has to be ended manually (runs dispatched before the host process was recorded are in this state)",
    );
  }
  return await opencodeStop({
    transcript, session, fromState, runId, deps, stopRequestedAttempt,
    runDir: resolvedRunDir,
  });
}

// ── processStop (extracted from stop.js) ─────────────────────────────────────

async function processStop({ transcript, session, fromState, runId, pid, deps, stopRequestedAttempt, runDir, backend = "process", anchorAt }) {
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
        backend,
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
      backend,
      pid,
    };
  }

  // Winner: identity gate BEFORE any kill. The session record is often days
  // old and the machine may have rebooted since — a bare signal-0 probe would
  // happily taskkill an unrelated process tree that reused the pid. The
  // judgment shares this lane's isAlive probe (one liveness truth); the
  // posture mirrors the serve-recycle precedent: when the identity cannot be
  // verified, give up the hard kill and report honestly rather than risk
  // killing the wrong process.
  const identify = deps.identify
    ?? ((p, anchor) => identifyProcessIdentity(p, anchor, { isAliveFn: (q) => isAlive(q) }));
  const identity = await identify(pid, anchorAt);

  // Winner: execute side effect
  const aliveBefore = identity.verdict === "gone" ? false : isAlive(pid);
  let killResult = { called: false, exitCode: null };
  if (aliveBefore && identity.verdict !== "unknown") {
    killResult = kill(pid);
  }

  const waitForExit = deps.waitForExit ?? ((p, ia, sl, pc) => waitForPidExit(p, ia, sl, pc));
  const sleepFn = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollConfig = deps.pollConfig ?? {};
  let aliveAfter;
  if (identity.verdict === "gone") {
    // The recorded process is provably gone — whatever holds the pid now (a
    // reuser) is not this run's process and must not be waited on or killed.
    aliveAfter = false;
  } else if (aliveBefore) {
    aliveAfter = killResult.called
      ? await waitForExit(pid, isAlive, sleepFn, pollConfig)
      : isAlive(pid);
  } else {
    aliveAfter = isAlive(pid);
  }
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
      backend,
      outcome,
      pidIdentity: identity.basis,
      taskkillCalled: killResult.called,
      taskkillExitCode: killResult.exitCode,
      processAliveBefore: aliveBefore,
      processAliveAfter: aliveAfter,
    });
  } else {
    await transcript.append("run.stop_unverified", {
      backendSessionId: session.backendSessionId,
      backend,
      outcome,
      pidIdentity: identity.basis,
      taskkillCalled: killResult.called,
      taskkillExitCode: killResult.exitCode,
      processAliveBefore: aliveBefore,
      processAliveAfter: aliveAfter,
    });
    // TD-233（告警落点收口）：告警跟随本调用实际解析出的 runDir（与转录同一
    // 来源，stopRun 传入的 resolvedRunDir），绝不回落到进程 cwd。
    const identityNote = identity.verdict === "unknown"
      ? ", pid identity could not be verified — kill skipped"
      : "";
    await alert("stop_unverified",
      `stop ${runId} not verified: process may still be running (pid=${pid}, outcome=${outcome}${identityNote})`,
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
    backend,
    pid,
    outcome,
    pidIdentity: identity.basis,
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
  // 与认领路径同一份载荷（含 Lead 的理由与观察位置，决定 0069）。
  await transcript.append("run.stop_requested", { ...stopRequestedAttempt.payload });
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
