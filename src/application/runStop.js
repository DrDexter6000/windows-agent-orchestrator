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

import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

import { JsonlTranscript, readTranscript, findState, findLatest } from "../transcript.js";
import { executeStopWithVerification } from "../backends/opencodeStopVerify.js";
import { raiseAlert } from "../alerts.js";
import { isValidRunId } from "../delivery.js";
import { proveWorkspace } from "./workspaceBinding.js";

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
 * Check if a PID is alive. Conservative: ESRCH = dead, EPERM/unknown = alive.
 */
function isPidAlive(pid, probe = process.kill) {
  try {
    probe(pid, 0);
    return true;
  } catch (e) {
    if (/^(Error: )?.*ESRCH/.test(e.message)) return false;
    return true;
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

// ── Workspace ownership verification (FIX-B: reuse proveWorkspace SSOT) ─────

/**
 * Find the workspace ownership fact from transcript events.
 * Transcript events are flat — payload fields are at the top level.
 */
function findOwnershipFact(events) {
  const submitted = events.filter((e) => e.type === "run.background_submitted");
  if (submitted.length === 0) return null;
  if (submitted.length > 1) {
    throw new Error("ambiguous ownership: multiple run.background_submitted events");
  }
  const cwd = submitted[0].cwd;
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("malformed ownership: run.background_submitted.cwd is missing or empty");
  }
  return { cwd };
}

/**
 * Verify that a run's workspace ownership matches the authorized root.
 * Uses proveWorkspace SSOT — rejects subdirectories, non-existent paths,
 * other repos. No hand-written path comparison.
 */
function verifyWorkspaceOwnership(events, authorizedWorkspaceRoot) {
  const fact = findOwnershipFact(events);
  if (!fact) {
    throw new Error("missing ownership: no run.background_submitted event");
  }
  // Prove the ownership cwd is a real Git top-level (rejects subdirectories)
  const ownershipProof = proveWorkspace(fact.cwd);
  // Prove the authorized root is a real Git top-level
  const authorizedProof = proveWorkspace(authorizedWorkspaceRoot);
  // Compare canonical roots using the SSOT's platform-aware normalization
  // proveWorkspace returns root in normalized form (realpath + forward slashes)
  if (ownershipProof.root !== authorizedProof.root) {
    // On Windows, pathsMatch is case-insensitive — proveWorkspace normalizes
    // via realpath which preserves original casing. Use toLowerCase for win32.
    const IS_WIN32 = process.platform === "win32";
    const match = IS_WIN32
      ? ownershipProof.root.toLowerCase() === authorizedProof.root.toLowerCase()
      : ownershipProof.root === authorizedProof.root;
    if (!match) {
      throw new Error("workspace mismatch: run ownership does not match authorized workspace");
    }
  }
  return { authorized: true, ownershipCwd: fact.cwd };
}

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
  const transcriptPath = join(resolvedRunDir, `${runId}.jsonl`);

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
      verifyWorkspaceOwnership(events, authorizedWorkspaceRoot);
    } catch (err) {
      return {
        runId,
        authorized: false,
        authorizationError: err.message,
        terminalAccepted: false,
        terminalState: findState(events) ?? "unknown",
        sideEffectAttempted: false,
        stopVerified: null,
      };
    }
  }

  // ── Session lookup ────────────────────────────────────────────────────────
  const session = findLatest(events, "session.created");
  if (!session?.backendSessionId) {
    throw new Error(`Run ${runId} has no session metadata (no session.created event)`);
  }

  const fromState = findState(events);
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
    agentId: findLatest(events, "run.started")?.agentId ?? "unknown",
  });

  // ── Process path ──────────────────────────────────────────────────────────
  if (session.backendSessionId.startsWith("proc_")) {
    const rawPid = session.backendSessionId.slice("proc_".length);
    const pid = Number(rawPid);
    if (!Number.isInteger(pid) || pid <= 0) {
      return await invalidPidStop({
        transcript, session, fromState, runId, deps, stopRequestedAttempt, rawPid,
      });
    }
    return await processStop({
      transcript, session, fromState, runId, pid, deps, stopRequestedAttempt,
    });
  }

  // ── Opencode path ─────────────────────────────────────────────────────────
  if (!session?.serveUrl) {
    throw new Error(`Run ${runId} session has no serveUrl (opencode path needs one)`);
  }
  return await opencodeStop({
    transcript, session, fromState, runId, config: deps.config ?? {}, deps, stopRequestedAttempt,
  });
}

// ── processStop (extracted from stop.js) ─────────────────────────────────────

async function processStop({ transcript, session, fromState, runId, pid, deps, stopRequestedAttempt }) {
  const kill = deps.kill ?? ((p) => killProcessTree(p));
  const isAlive = deps.isAlive ?? ((p) => isPidAlive(p));
  const alert = deps.alert ?? (async (level, msg, opts) => raiseAlert(level, msg, opts));

  // Claim terminal state (first-terminal-wins)
  const termResult = await transcript.transitionState(fromState, "aborted", "stop_requested", {
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
    await alert("stop_unverified",
      `stop ${runId} not verified: process may still be running (pid=${pid}, outcome=${outcome})`,
      { runId, logPath: join(deps.config?.runDir ?? ".", "ALERTS.log") },
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

async function opencodeStop({ transcript, session, fromState, runId, config, deps, stopRequestedAttempt }) {
  const executeStop = deps.executeStop ?? ((b, url, sid, opts) => executeStopWithVerification(b, url, sid, opts));
  const alert = deps.alert ?? (async (level, msg, opts) => raiseAlert(level, msg, opts));

  const termResult = await transcript.transitionState(fromState, "aborted", "stop_requested", {
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
  const stopResult = await executeStop(
    null, session.serveUrl, session.backendSessionId,
    { cwd: session.cwd, rounds: 3, intervalMs: 2000 },
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
    await alert("stop_unverified",
      `stop ${runId} not verified: opencode session may still be active`,
      { runId, logPath: join(config.runDir ?? ".", "ALERTS.log") },
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

async function invalidPidStop({ transcript, session, fromState, runId, deps, stopRequestedAttempt, rawPid }) {
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
  await alert("stop_unverified",
    `Run ${runId} has invalid PID: ${rawPid}`,
    { runId, logPath: join(deps.config?.runDir ?? ".", "ALERTS.log") },
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

function resolveRunDir(runDir) {
  if (!runDir) return join(process.cwd(), "runs");
  return resolve(runDir);
}

export { findOwnershipFact, verifyWorkspaceOwnership, killProcessTree, isPidAlive, waitForPidExit };
