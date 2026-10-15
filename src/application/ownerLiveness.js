// src/application/ownerLiveness.js
//
// M10-pre3: Owner heartbeat liveness SSOT.
//
// Extracted from daemon.js to share between daemon, runWait, and future
// supervision code. The owner file (.owner-<runId>) is written by
// backgroundRunner every 2 seconds while the runner process is alive,
// and deleted on exit.
//
// This module owns the ONLY freshness algorithm — no third copy.
//
// Architectural contract:
//   - Does NOT import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Uses only node builtins (fs/path for the lease read; child_process/os
//     for the pid-identity judgment below).

import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import { join } from "node:path";

/**
 * Default owner heartbeat staleness threshold (10 seconds).
 * backgroundRunner updates every 2 seconds, so 10s = 5 missed heartbeats.
 */
export const DEFAULT_OWNER_LIVENESS_THRESHOLD_MS = 10000;

/**
 * Get the owner heartbeat file path for a run.
 * @param {string} runDir
 * @param {string} runId
 * @returns {string}
 */
export function ownerFilePath(runDir, runId) {
  return join(runDir, `.owner-${runId}`);
}

/**
 * Check owner heartbeat freshness.
 *
 * @param {string} runDir
 * @param {string} runId
 * @param {number} now — current timestamp (ms)
 * @param {number} [thresholdMs] — staleness threshold (default 10000)
 * @returns {{fresh: boolean, heartbeatAt: number|null}}
 *   fresh=true if owner file exists and heartbeat is within threshold.
 *   fresh=false if file missing, corrupt, or heartbeat stale.
 */
export function checkOwnerLiveness(runDir, runId, now, thresholdMs = DEFAULT_OWNER_LIVENESS_THRESHOLD_MS) {
  const filePath = ownerFilePath(runDir, runId);
  if (!existsSync(filePath)) return { fresh: false, heartbeatAt: null };
  try {
    const owner = JSON.parse(readFileSync(filePath, "utf8"));
    if (typeof owner.heartbeatAt !== "number") return { fresh: false, heartbeatAt: null };
    const fresh = (now - owner.heartbeatAt) <= thresholdMs;
    return { fresh, heartbeatAt: owner.heartbeatAt };
  } catch {
    return { fresh: false, heartbeatAt: null };
  }
}

/**
 * M12-19: the conservative process-alive probe.
 *
 * Consolidated here (the liveness SSOT) so the read-only candidate projection,
 * the repackage settlement, and runStop share ONE algorithm — no second copy.
 * Re-exported by runStop.js for backward-compatible imports (commands/stop.js,
 * tests).
 *
 * Conservative by contract: the thrown error's `code` field is the ONLY
 * authority. ESRCH (no such process) is the ONLY signal treated as "dead" —
 * message text is NEVER authority (a misleading "ESRCH" message without
 * code, or a different code, still means alive). EPERM (permission denied —
 * the process exists but is not ours), any other code, a missing/unknown
 * code, or a probe that does not throw all mean "alive" (unknown). It is
 * always safe to NOT recover; it is never safe to falsely claim dead.
 *
 * @param {number} pid — positive integer PID
 * @param {Function} [probe] — injectable signal-0 probe (default process.kill)
 * @returns {boolean} true if the process appears alive (or unknown), false only on error.code === "ESRCH"
 */
export function isPidAlive(pid, probe = process.kill) {
  try {
    probe(pid, 0);
    return true;
  } catch (e) {
    if (e && typeof e.code === "string" && e.code === "ESRCH") return false;
    return true;
  }
}

/**
 * M12-19: the ONE owner-lease freshness/lease SSOT for process_missing recovery.
 *
 * Unlike checkOwnerLiveness (which conflates missing + corrupt into fresh:false
 * for the daemon/dashboard consumer), this distinguishes the three durable
 * states a recovery proof must reason about, because they have different
 * eligibility semantics:
 *   - missing  → { present: false }              — allowed (the runner may have
 *                  exited and deleted its lease); the remaining proofs carry it.
 *   - corrupt  → { present: true, wellFormed: false }  — NEVER eligible. A
 *                  malformed lease is ambiguous and must fail closed.
 *   - valid    → { present: true, wellFormed: true, fresh, heartbeatAt, pid } —
 *                  fresh:true  → NEVER eligible (the owner is actively heartbeating).
 *                  fresh:false → eligible only if the owner PID is ALSO proven
 *                                  dead (see proveProcessMissing); a stale lease
 *                                  alone is not a death proof.
 *
 * A valid lease requires an object body with a finite numeric heartbeatAt AND a
 * positive-integer pid — exactly what backgroundRunner writes. Anything else is
 * corrupt (wellFormed:false). No PID/path text is returned beyond the integer
 * pid the caller needs to probe; the heartbeatAt is an absolute epoch the caller
 * uses only for the freshness comparison.
 *
 * @param {string} runDir
 * @param {string} runId
 * @param {number} now — current timestamp (ms)
 * @param {number} [thresholdMs] — staleness threshold (default 10000)
 * @returns {{present:false}|{present:true,wellFormed:false}|{present:true,wellFormed:true,fresh:boolean,heartbeatAt:number,pid:number}}
 */
export function readOwnerLease(runDir, runId, now, thresholdMs = DEFAULT_OWNER_LIVENESS_THRESHOLD_MS) {
  const filePath = ownerFilePath(runDir, runId);
  if (!existsSync(filePath)) return { present: false };
  let owner;
  try {
    owner = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return { present: true, wellFormed: false };
  }
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) {
    return { present: true, wellFormed: false };
  }
  if (typeof owner.heartbeatAt !== "number" || !Number.isFinite(owner.heartbeatAt)) {
    return { present: true, wellFormed: false };
  }
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) {
    return { present: true, wellFormed: false };
  }
  const fresh = (now - owner.heartbeatAt) <= thresholdMs;
  return {
    present: true,
    wellFormed: true,
    fresh,
    heartbeatAt: owner.heartbeatAt,
    pid: owner.pid,
  };
}

// ===== Pid identity judgment (SSOT beside the liveness probe) =================
//
// A signal-0 probe alone cannot tell "the process died" from "the pid was
// reused by an unrelated process". The judgment below answers THAT question:
// given a pid and the moment (anchorAt) the pid was recorded, is the process
// currently holding that pid the same one the record refers to?
//
// Known limits (both directions are documented, not fixed here):
//   - Both comparisons use wall-clock time. A large clock adjustment between
//     the two moments (the anchor and the boot/creation reading) can mislead
//     the boot and creation-time criteria.
//   - Windows Fast Startup shutdowns do not reset os.uptime(), so the
//     "machine rebooted since the anchor" criterion does not fire after one;
//     the judgment then falls through to the creation-time probe, whose
//     direction is conservative (a reused pid is still detected by its
//     creation time).

/**
 * Creation-time tolerance: a pid whose current process was created at most
 * this long after the anchor still counts as the same process (clock skew
 * between the record and the OS reading).
 */
export const PID_IDENTITY_TOLERANCE_MS = 5000;

const PROCESS_CREATION_TIME_TIMEOUT_MS = 10000;

export const PID_IDENTITY_VERDICTS = Object.freeze(["gone", "same", "unknown"]);

export const PID_IDENTITY_BASES = Object.freeze([
  "pid_exited",
  "rebooted_since_anchor",
  "pid_reused",
  "identity_confirmed",
  "identity_unknown",
]);

/**
 * Read a process creation time (epoch ms) on Windows via PowerShell.
 * Resolves null on ANY failure (missing process, non-zero exit, timeout,
 * unparseable output) — the caller maps null to "unknown", never to a guess.
 * The spawn is injectable for tests (execFileFn); it never gets a shell and
 * never receives anything but the numeric pid.
 */
function _defaultProcessCreationTime(execFileFn, pid) {
  return new Promise((resolve) => {
    try {
      execFileFn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
        ],
        { timeout: PROCESS_CREATION_TIME_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => {
          if (err) {
            resolve(null);
            return;
          }
          const parsed = Date.parse(String(stdout ?? "").trim());
          resolve(Number.isFinite(parsed) ? parsed : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * Decide whether the process currently holding `pid` is the one that was
 * recorded at `anchorAt` (epoch ms — must come from the SAME record the pid
 * came from; see runStop/runSettle for the anchor selection).
 *
 * Verdicts:
 *   - "gone"  — the recorded process is provably no longer running:
 *     signal-0 returns ESRCH (the existing isPidAlive criterion), OR the
 *     machine booted after the anchor (boot = now - os.uptime()), OR the
 *     pid's current process was created after anchor + tolerance (pid reused).
 *   - "same"  — the current process was created no later than
 *     anchor + tolerance.
 *   - "unknown" — everything else: probe failure, unparseable readings,
 *     malformed input. It is always safe to NOT act on "unknown".
 *
 * `basis` is the closed-set fact behind the verdict (PID_IDENTITY_BASES) —
 * callers persist it verbatim in stop/settle facts.
 *
 * Every input is injectable: signal-0 probe (isAliveFn), boot-time reading
 * (bootTimeFn), creation-time probe (creationTimeFn — the whole PowerShell
 * read), clock (nowFn), and the spawn primitive (execFileFn, used only when
 * creationTimeFn is not supplied).
 *
 * @param {number} pid — positive integer
 * @param {number} anchorAt — epoch ms when the pid was recorded
 * @param {{isAliveFn?:Function, bootTimeFn?:Function, creationTimeFn?:Function, nowFn?:Function, execFileFn?:Function}} [deps]
 * @returns {Promise<{verdict:"gone"|"same"|"unknown", basis:string}>}
 */
export async function identifyProcessIdentity(pid, anchorAt, deps = {}) {
  const unknown = { verdict: "unknown", basis: "identity_unknown" };
  if (!Number.isInteger(pid) || pid <= 0) return unknown;
  if (typeof anchorAt !== "number" || !Number.isFinite(anchorAt)) return unknown;

  const nowFn = typeof deps.nowFn === "function" ? deps.nowFn : Date.now;
  const isAliveFn = typeof deps.isAliveFn === "function" ? deps.isAliveFn : isPidAlive;

  // 1) Cheapest and strongest: ESRCH means no such process at all.
  let alive;
  try {
    alive = isAliveFn(pid);
  } catch {
    return unknown;
  }
  if (alive !== true && alive !== false) return unknown;
  if (!alive) return { verdict: "gone", basis: "pid_exited" };

  // 2) A boot after the anchor means every process from before the anchor is
  // gone, whatever holds the pid now.
  if (typeof deps.bootTimeFn !== "function") {
    if (typeof nowFn !== "function") return unknown;
    deps = { ...deps, bootTimeFn: () => nowFn() - os.uptime() * 1000 };
  }
  let bootAt;
  try {
    bootAt = deps.bootTimeFn();
  } catch {
    return unknown;
  }
  if (typeof bootAt === "number" && Number.isFinite(bootAt)) {
    if (bootAt > anchorAt) return { verdict: "gone", basis: "rebooted_since_anchor" };
  }

  // 3) Creation time of whatever holds the pid now: a process created after
  // the anchor (+ tolerance) cannot be the recorded one.
  const creationTimeFn = typeof deps.creationTimeFn === "function"
    ? deps.creationTimeFn
    : (p) => _defaultProcessCreationTime(deps.execFileFn ?? execFile, p);
  let createdAt;
  try {
    createdAt = await creationTimeFn(pid);
  } catch {
    return unknown;
  }
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return unknown;
  if (createdAt > anchorAt + PID_IDENTITY_TOLERANCE_MS) {
    return { verdict: "gone", basis: "pid_reused" };
  }
  return { verdict: "same", basis: "identity_confirmed" };
}
