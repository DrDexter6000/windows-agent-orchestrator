// test/_mcpWorkspaceSmokeHelper.mjs
//
// Bounded wait / read / classification / cleanup helper for
// test/mcp-surface/mcpWorkspaceSmoke.test.js. Test-only plumbing — NOT a
// generic waiting framework.
//
// Rules enforced here:
//   - every wait is bounded by rounds × intervalMs (round budgets, not
//     wall-clock ceilings);
//   - success is declared ONLY from a current successful transcript read. The
//     read is genuinely async (readTranscript returns a Promise) and its
//     rejection is caught; the last GOOD sample is retained for DIAGNOSTICS
//     only and is never reused to satisfy a predicate;
//   - failures stay failures and stay distinguished: wait exhausted, read
//     failure, run failed, packaging failed, verification failed/unavailable,
//     delivery facts missing or duplicated (no skip, no retry, no environment
//     attribution);
//   - diagnostics are bounded and safe (runId, phase, rounds/elapsed, sample
//     time, last state, recent event type/seq/ts, exact key-event counts,
//     runner observation). Never the transcript body, commands, env, secrets;
//   - cleanup deletes ONLY this fixture's temp tree, and only after a direct
//     runner-exit proof: the pid captured from the runner's own owner lease
//     must probe dead via the isPidAlive SSOT (probe only — this helper NEVER
//     kills a process). Without that proof the fixture is KEPT and reported as
//     "unknown". cleanupSmokeFixture never throws, so a cleanup problem can
//     never replace a primary failure.

import { isAbsolute, relative, resolve } from "node:path";
import { readTranscript, findState, TERMINAL_STATES } from "../src/transcript.js";
import { readOwnerLease, isPidAlive } from "../src/application/ownerLiveness.js";
import { stopRun } from "../src/application/runStop.js";
import { rmrfRetry } from "./_rmrfHelper.mjs";

// Round budgets (rounds × intervalMs — NOT wall-clock ceilings). Preserved from
// the previous inline loops: phase 1 = 150 × 200ms, phase 2 = 300 × 200ms.
const SMOKE_TERMINAL_ROUNDS = 150;
const SMOKE_TERMINAL_INTERVAL_MS = 200;
const SMOKE_DELIVERY_ROUNDS = 300;
const SMOKE_DELIVERY_INTERVAL_MS = 200;
const SMOKE_RUNNER_EXIT_ROUNDS = 50;
const SMOKE_RUNNER_EXIT_INTERVAL_MS = 200;

const TERMINAL_SET = new Set(TERMINAL_STATES);
const DIAG_MAX_TOTAL = 2000;
const DIAG_MAX_FIELD = 160;
const RECENT_EVENT_LIMIT = 3;

function clip(value, max = DIAG_MAX_FIELD) {
  const s = typeof value === "string" ? value : String(value ?? "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function clipCode(error) {
  if (!error) return null;
  const code = typeof error.code === "string" && error.code.length > 0 ? error.code : "error";
  return { code, message: clip(error.message) };
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

/** True only when `target` resolves strictly INSIDE `baseDir` (no .. escape). */
function insideBase(baseDir, target) {
  if (typeof target !== "string" || target.length === 0 || !isAbsolute(target)) return false;
  const rel = relative(resolve(baseDir), resolve(target));
  if (rel === "" || isAbsolute(rel)) return false;
  const firstSegment = rel.split(/[\\/]/)[0];
  return firstSegment !== "..";
}

/** Exact counts of the key events the smoke assertions reason about. */
export function countKeyEvents(events) {
  const list = Array.isArray(events) ? events : [];
  const count = (type) => list.filter((e) => e && e.type === type).length;
  return {
    deliveryCreated: count("run.delivery_created"),
    verificationPassed: count("run.delivery_verification_passed"),
    verificationFailed: count("run.delivery_verification_failed"),
    verificationUnavailable: count("run.delivery_verification_unavailable"),
    deliveryFailed: count("run.delivery_failed"),
    completedTransitions: list.filter(
      (e) => e && e.type === "run.state_change" && e.to === "completed").length,
    runErrors: count("run.error"),
  };
}

/**
 * ONE async read of the current run facts. Never throws: a read problem is
 * reported as ok:false (code + bounded message) so a caller can keep polling
 * AND can never mistake a failed read for a satisfied predicate.
 */
export async function readSmokeSample({ transcriptPath, runDir, runId, deps = {} }) {
  const readTranscriptFn = deps.readTranscriptFn ?? readTranscript;
  const readLeaseFn = deps.readLeaseFn ?? ((dir, id, nowMs) => readOwnerLease(dir, id, nowMs));
  const now = deps.now ?? Date.now;
  const sampledAtMs = now();
  const lease = readLeaseFn(runDir, runId, sampledAtMs) ?? { present: false };
  const runnerPid = lease && lease.wellFormed === true && isPositiveInt(lease.pid) ? lease.pid : null;
  let events = null;
  let readError = null;
  try {
    events = await readTranscriptFn(transcriptPath);
  } catch (error) {
    readError = clipCode(error);
  }
  const ok = readError === null && Array.isArray(events);
  return {
    ok,
    readError,
    events: ok ? events : null,
    state: ok ? findState(events) : null,
    lease,
    runnerPid,
    sampledAtMs,
  };
}

/**
 * The ONE bounded polling loop (shared by both waits below — no duplicated
 * waiting logic). Each round takes a fresh sample; `decide` returns a partial
 * result object when the wait's own predicate is satisfied by that CURRENT
 * sample, or null to keep polling.
 */
async function pollRunFacts({ transcriptPath, runDir, runId, rounds, intervalMs, deps, decide }) {
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const startedAtMs = now();
  let lastSample = null;
  let lastGoodSample = null;
  let runnerPid = null;
  let roundsUsed = 0;
  let decided = null;
  for (let i = 0; i < rounds && decided === null; i += 1) {
    roundsUsed = i + 1;
    const sample = await readSmokeSample({ transcriptPath, runDir, runId, deps });
    lastSample = sample;
    if (sample.runnerPid != null) runnerPid = sample.runnerPid;
    if (sample.ok) {
      lastGoodSample = sample;
      decided = decide(sample, countKeyEvents(sample.events));
    }
    if (decided === null && i < rounds - 1) await sleep(intervalMs);
  }
  return Object.freeze({
    completed: decided !== null,
    ...(decided ?? {}),
    sample: lastSample,
    lastGoodSample,
    roundsUsed,
    elapsedMs: now() - startedAtMs,
    runnerPid,
    rounds,
    intervalMs,
  });
}

/**
 * Phase 1 — bounded wait for a terminal state (150 rounds × 200ms). The result
 * is frozen: later transcript changes cannot rewrite a consumed snapshot.
 */
export async function waitForSmokeTerminal({
  transcriptPath, runDir, runId,
  rounds = SMOKE_TERMINAL_ROUNDS, intervalMs = SMOKE_TERMINAL_INTERVAL_MS, deps = {},
}) {
  const result = await pollRunFacts({
    transcriptPath, runDir, runId, rounds, intervalMs, deps,
    decide: (sample) => (TERMINAL_SET.has(sample.state)
      ? { kind: "terminal", state: sample.state }
      : null),
  });
  if (result.completed) return result;
  return Object.freeze({
    ...result,
    kind: result.sample && result.sample.ok ? "terminal_wait_exhausted" : "read_failure",
    state: result.lastGoodSample ? result.lastGoodSample.state : null,
  });
}

/**
 * Phase 2 — bounded wait (300 rounds × 200ms) for ONE durable delivery outcome
 * (verification passed/failed/unavailable, or delivery_failed).
 *
 * No non-delivery inference: the smoke always requests delivery, and
 * run.delivery_created is written in the SAME atomic batch as the terminal
 * completed transition (runManager.js _finalizeDelivery -> transitionState
 * attemptEvents), so "completed without delivery_created" is a classified
 * failure, never a reason to shorten or skip this wait.
 *
 * Precedence when several outcomes appear in one read: delivery_failed >
 * verification_failed > verification_unavailable > verification_passed — an
 * ordering, not a mask (the caller's exact count assertions still reject
 * duplicates independently).
 */
export async function waitForSmokeDeliveryOutcome({
  transcriptPath, runDir, runId,
  rounds = SMOKE_DELIVERY_ROUNDS, intervalMs = SMOKE_DELIVERY_INTERVAL_MS, deps = {},
}) {
  const result = await pollRunFacts({
    transcriptPath, runDir, runId, rounds, intervalMs, deps,
    decide: (sample, counts) => {
      if (counts.deliveryFailed > 0) return { kind: "delivery_outcome", outcome: "delivery_failed" };
      if (counts.verificationFailed > 0) return { kind: "delivery_outcome", outcome: "failed" };
      if (counts.verificationUnavailable > 0) return { kind: "delivery_outcome", outcome: "unavailable" };
      if (counts.verificationPassed > 0) return { kind: "delivery_outcome", outcome: "passed" };
      return null;
    },
  });
  if (result.completed) return result;
  return Object.freeze({
    ...result,
    outcome: null,
    kind: result.sample && result.sample.ok ? "delivery_wait_exhausted" : "read_failure",
  });
}

/** Map a (terminal, delivery) wait pair onto a fixed status vocabulary. */
export function classifySmokeOutcome({ terminal, delivery } = {}) {
  if (!terminal || terminal.kind !== "terminal") {
    return {
      status: terminal && terminal.kind === "read_failure"
        ? "terminal_read_failure" : "terminal_wait_exhausted",
      state: terminal ? terminal.state : null,
    };
  }
  if (terminal.state !== "completed") {
    const counts = countKeyEvents(terminal.sample && terminal.sample.events);
    return {
      status: counts.deliveryFailed > 0 ? "packaging_failed" : "run_failed",
      state: terminal.state,
    };
  }
  if (!delivery || delivery.kind !== "delivery_outcome") {
    return {
      status: delivery && delivery.kind === "read_failure"
        ? "delivery_read_failure" : "delivery_wait_exhausted",
      state: "completed",
    };
  }
  if (delivery.outcome === "delivery_failed") return { status: "packaging_failed", state: "completed" };
  if (delivery.outcome === "failed") return { status: "verification_failed", state: "completed" };
  if (delivery.outcome === "unavailable") return { status: "verification_unavailable", state: "completed" };
  const counts = countKeyEvents(delivery.sample && delivery.sample.events);
  return {
    status: counts.deliveryCreated === 1 ? "ok" : "delivery_created_missing_or_duplicate",
    state: "completed",
  };
}

function recentEvents(events) {
  const list = Array.isArray(events) ? events : [];
  const picked = list.slice(-RECENT_EVENT_LIMIT).reverse();
  return picked.map((e) => e && typeof e.type === "string"
    ? `${clip(e.type, 64)}#${e.seq ?? "?"}@${clip(e.ts, 32)}`
    : "(malformed event)").join("; ");
}

function waitLine(label, wait) {
  if (!wait) return `  ${label}: not reached`;
  const readError = wait.sample && wait.sample.readError ? wait.sample.readError.code : "-";
  const good = wait.lastGoodSample ? "yes" : "no";
  return `  ${label}: kind=${wait.kind} state=${wait.state ?? "-"} outcome=${wait.outcome ?? "-"} `
    + `rounds=${wait.roundsUsed}/${wait.rounds} elapsedMs=${wait.elapsedMs} `
    + `lastReadOk=${wait.sample && wait.sample.ok ? "yes" : "no"} lastReadError=${readError} `
    + `lastGood=${good} sampledAt=${wait.sample ? new Date(wait.sample.sampledAtMs).toISOString() : "-"}`;
}

/**
 * Bounded, safe failure diagnostics, built only from the frozen wait results
 * (plus an optional cleanup record). When the current read failed, the counts
 * and recent events come from the LAST GOOD sample and are labelled as such —
 * diagnostic context, never treated as the current outcome.
 */
export function formatSmokeFailure({ runId, phase, status, terminal, delivery, cleanup } = {}) {
  const current = (delivery && delivery.sample) || (terminal && terminal.sample) || null;
  const lastGood = (delivery && delivery.lastGoodSample)
    || (terminal && terminal.lastGoodSample) || null;
  const source = current && current.ok ? current : lastGood;
  const events = source ? source.events : [];
  const counts = countKeyEvents(events);
  const runnerPid = (delivery && delivery.runnerPid) || (terminal && terminal.runnerPid) || null;
  const lines = [
    `[smoke-failure] runId=${clip(runId, 64)} phase=${clip(phase, 32)} status=${clip(status, 48)}`,
    waitLine("terminal", terminal),
    waitLine("delivery", delivery),
    `  counts(source=${current && current.ok ? "current" : "lastGoodDiagnosticOnly"}): `
      + `created=${counts.deliveryCreated} verificationPassed=${counts.verificationPassed} `
      + `verificationFailed=${counts.verificationFailed} `
      + `verificationUnavailable=${counts.verificationUnavailable} `
      + `deliveryFailed=${counts.deliveryFailed} `
      + `completedTransitions=${counts.completedTransitions} runErrors=${counts.runErrors}`,
    `  recentEvents(newest first): ${recentEvents(events) || "-"}`,
    `  runner: pid=${runnerPid ?? "unobserved"}`,
  ];
  if (cleanup) {
    lines.push(`  cleanup: status=${cleanup.status} reason=${cleanup.reason ?? "-"} `
      + `keptDir=${cleanup.keptDir ? clip(cleanup.keptDir) : "-"} `
      + `error=${cleanup.error ? clip(cleanup.error.message) : "-"}`);
  }
  const text = lines.join("\n");
  return text.length > DIAG_MAX_TOTAL ? `${text.slice(0, DIAG_MAX_TOTAL)}…[clipped]` : text;
}

/**
 * The ONE failure-note attachment shared by the real smoke's catch and the
 * helper tests (no second formatting layer — it reuses formatSmokeFailure).
 *
 * Appends to (never replaces) the ORIGINAL Error, so the original message stays
 * first, and:
 *   - never attaches a second block — an error that already carries one (the
 *     phase waits fail via assert.fail(formatSmokeFailure(...))) is returned
 *     untouched;
 *   - when the waits classified "ok" but a later exact assertion failed, the
 *     status is "assertion_failed" — never "ok";
 *   - any other classified failure keeps its own status.
 *
 * Returns the same Error (a non-Error or a pre-failure input is unchanged).
 */
export function attachFailureDiagnostics(error, { runId, terminal, delivery } = {}) {
  if (!(error instanceof Error) || !terminal) return error;
  if (error.message.includes("[smoke-failure]")) return error;
  const classified = classifySmokeOutcome({ terminal, delivery });
  const status = classified.status === "ok" ? "assertion_failed" : classified.status;
  error.message = `${error.message}\n${formatSmokeFailure({
    runId: runId ?? null,
    phase: delivery ? "assertions" : "terminal-wait",
    status,
    terminal,
    delivery,
  })}`;
  return error;
}

/** Liveness probe that never throws: any probe error counts as alive. */function safeProbe(isAliveFn, pid) {
  try {
    return isAliveFn(pid) === true;
  } catch {
    return true;
  }
}

async function cleanupInside({
  baseDir, runDir, runId, workspaceDir, runnerPid, terminalState,
  authorizedWorkspaceRoot, expectRunner = true,
  rounds = SMOKE_RUNNER_EXIT_ROUNDS, intervalMs = SMOKE_RUNNER_EXIT_INTERVAL_MS,
  deps = {},
}) {
  const stopRunFn = deps.stopRunFn ?? stopRun;
  const isAliveFn = deps.isAliveFn ?? isPidAlive;
  const rmrf = deps.rmrf ?? ((dir, opts) => rmrfRetry(dir, opts));
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  // (1) Scope guard — only ever touch paths strictly inside this fixture's
  // absolute temp root (resolve/relative, not a string prefix check).
  if (typeof baseDir !== "string" || baseDir.length === 0 || !isAbsolute(baseDir)) {
    return { status: "error", reason: "fixture_scope_mismatch", error: "baseDir not absolute", keptDir: baseDir ?? null };
  }
  if ((runDir != null && !insideBase(baseDir, runDir))
    || (workspaceDir != null && !insideBase(baseDir, workspaceDir))) {
    return { status: "error", reason: "fixture_scope_mismatch", error: "runDir/workspaceDir outside baseDir", keptDir: baseDir };
  }

  // (2) Production worker stop — only when the run never reached a terminal
  // state (stopRun refuses side effects on terminal runs anyway) and only with
  // the MCP workspace authorization. Never a runner-exit proof.
  let stopRunObserved = null;
  if (runId && runDir && authorizedWorkspaceRoot && !(terminalState && TERMINAL_SET.has(terminalState))) {
    try {
      const result = await stopRunFn({ runId, runDir, authorizedWorkspaceRoot });
      stopRunObserved = {
        terminalAccepted: result?.terminalAccepted ?? null,
        sideEffectAttempted: result?.sideEffectAttempted ?? null,
        stopVerified: result?.stopVerified ?? null,
        ...(result?.outcome ? { outcome: clip(result.outcome, 48) } : {}),
        ...(result?.rejected ? { rejected: true } : {}),
        ...(result?.authorized === false ? { authorized: false } : {}),
      };
    } catch (error) {
      stopRunObserved = { threw: clipCode(error) };
    }
  }

  // (3) Direct runner-exit proof before any deletion: probe (never kill) the
  // pid the runner's own owner lease recorded.
  if (expectRunner) {
    if (!isPositiveInt(runnerPid)) {
      return {
        status: "unknown", reason: "runner_pid_unobserved", runnerPid: null,
        stopRun: stopRunObserved, keptDir: baseDir,
      };
    }
    let exited = !safeProbe(isAliveFn, runnerPid);
    let polls = 0;
    while (!exited && polls < rounds - 1) {
      await sleep(intervalMs);
      polls += 1;
      exited = !safeProbe(isAliveFn, runnerPid);
    }
    if (!exited) {
      return {
        status: "unknown", reason: "runner_still_alive", runnerPid,
        stopRun: stopRunObserved, keptDir: baseDir,
      };
    }
  }

  // (4) Delete exactly the fixture root (TD-107 retry helper — no second rm
  // framework). A heartbeat file disappearing is NOT accepted as proof.
  try {
    const rmAttempts = rmrf(baseDir, { rm: deps.rm, sleep: deps.rmSleep });
    return {
      status: "clean",
      rmAttempts: typeof rmAttempts === "number" ? rmAttempts : null,
      stopRun: stopRunObserved,
    };
  } catch (error) {
    return {
      status: "error", reason: "rm_failed", error: clipCode(error),
      keptDir: baseDir, stopRun: stopRunObserved,
    };
  }
}

/**
 * Conservative fixture cleanup. NEVER throws — every failure path (scope
 * mismatch, stopRun throw, probe throw, rm failure, unexpected throw) is
 * returned as a structured record so it can never replace a primary failure.
 */
export async function cleanupSmokeFixture(options) {
  try {
    return await cleanupInside(options);
  } catch (error) {
    return {
      status: "error",
      reason: "cleanup_threw",
      error: clipCode(error),
      keptDir: typeof options?.baseDir === "string" ? options.baseDir : null,
    };
  }
}

/**
 * Cleanup reporting that can never mask a primary failure:
 *   - clean                 -> null (nothing to report)
 *   - not clean + primary   -> the note is APPENDED to the SAME primary Error
 *                              (still the original failure) and null is
 *                              returned — never throws
 *   - not clean, no primary -> an Error is returned for the caller to throw, so
 *                              a cleanup problem on the success path is never
 *                              silently hidden.
 */
export function resolveCleanupReporting(cleanupResult, primaryError) {
  if (!cleanupResult || cleanupResult.status === "clean") return null;
  const note = `[cleanup] status=${cleanupResult.status} reason=${cleanupResult.reason ?? "-"} `
    + `runnerPid=${cleanupResult.runnerPid ?? "-"} `
    + `keptDir=${cleanupResult.keptDir ? clip(cleanupResult.keptDir) : "-"} `
    + `error=${cleanupResult.error && cleanupResult.error.message ? clip(cleanupResult.error.message) : "-"}`;
  if (primaryError instanceof Error) {
    primaryError.message = primaryError.message
      ? `${primaryError.message}\n${note}`
      : note;
    return null;
  }
  return new Error(note);
}
