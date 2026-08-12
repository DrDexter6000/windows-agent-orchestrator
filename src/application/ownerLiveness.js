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
//   - Uses only node:fs and node:path (synchronous read for liveness check).

import { existsSync, readFileSync } from "node:fs";
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
