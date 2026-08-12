// src/application/processRecovery.js
//
// M12-19: the ONE application-level liveness/proof SSOT for Lead-authorized,
// zero-model delivery recovery after the detached runner/provider process
// disappears. Reused by run_delivery (read-only candidate projection) and
// run_delivery_repackage (atomic settlement). No MCP tool; no model, backend, or
// session resume; no automatic retry/stop/re-scope/acceptance.
//
// Two layers:
//   - classifyProcessMissingCandidate(events, runId): PURE transcript projection.
//     Durable facts only — never reads Git, the owner lease, or probes a PID.
//   - proveProcessMissing(events, runId, deps): runtime liveness proof. Calls the
//     classifier, then inspects ONLY safe runtime facts: the owner lease SSOT and
//     the conservative process probe. Never returns PID/path/error text — only a
//     boolean eligibility.
//
// Architectural contract:
//   - Does NOT import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Depends on transcript.js (closed-set constants + state helpers),
//     ownerLiveness.js (readOwnerLease + isPidAlive), and delivery.js
//     (isCanonicalCommitId). No Git, no backend.

import {
  findState,
  RUN_STATES,
  TERMINAL_STATES,
} from "../transcript.js";
import {
  readOwnerLease,
  isPidAlive,
  DEFAULT_OWNER_LIVENESS_THRESHOLD_MS,
} from "./ownerLiveness.js";
import { isCanonicalCommitId } from "../delivery.js";

// Durable facts that, if present, mean a delivery has already been created,
// settled, decided, or recovered — none is compatible with a fresh
// process_missing orphan projection. Includes run.process_missing_confirmed
// (M12-19 correction): the safe confirmation fact is only ever written
// atomically WITH the terminal settlement, so a run carrying one is already
// recovered (or its durable record is corrupt) — never a fresh orphan.
const DELIVERY_FACT_TYPES = new Set([
  "run.delivery_created",
  "run.delivery_verification_passed",
  "run.delivery_verification_failed",
  "run.delivery_verification_unavailable",
  "run.delivery_accepted",
  "run.delivery_rejected",
  "run.delivery_repackaged",
  "run.process_missing_confirmed",
]);

// Mirrors transcript.BACKEND_RECOVERY_CONFLICT_TYPES: any of these is a
// conflicting recovery outcome that disqualifies a process_missing candidate.
const CONFLICT_TYPES = new Set([
  "run.isolation_violation",
  "run.budget_exceeded",
  "run.timed_out",
  "run.aborted",
]);

// Parse backendSessionId "proc_<positive integer>" → positive integer pid.
// Anything else (non-string, wrong prefix, zero/non-numeric) → null.
function _parseProcPid(backendSessionId) {
  if (typeof backendSessionId !== "string") return null;
  const m = /^proc_(\d+)$/.exec(backendSessionId);
  if (!m) return null;
  const pid = Number(m[1]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

/**
 * Pure transcript projection of a process_missing recovery candidate.
 *
 * Inspects durable facts ONLY. Returns { eligible: true, pid } when ALL hold:
 *   - the run's authoritative state is a known NONTERMINAL run state —
 *     process_missing is the only NONTERMINAL recovery kind (disallowed_scope and
 *     backend_failed are terminal-failed); a terminal or unknown state is not an
 *     orphan to recover;
 *   - every consulted event belongs to runId;
 *   - original delivery was requested (run.background_submitted.deliveryRequested
 *     or a run.started carrying a delivery mode);
 *   - exactly one bound run.started carries a canonical baseCommit, a non-empty
 *     allowedPaths array, a non-empty worktreePath, AND a verification
 *     declaration (commands or unavailableReason);
 *   - NO delivery_created / verification outcome / decision / repackaged /
 *     delivery_failed / process_missing_confirmed facts, NO conflicting recovery
 *     facts, and NO existing terminal transition;
 *   - exactly one bound session.created with backendSessionId exactly
 *     "proc_<positive integer>".
 *
 * The returned pid is the detached child process PID the runtime proof must show
 * is dead. It is internal — never surfaced on MCP by the caller.
 *
 * @param {object[]} events
 * @param {string} runId
 * @returns {{eligible:true,pid:number}|{eligible:false}}
 */
export function classifyProcessMissingCandidate(events, runId) {
  if (!Array.isArray(events) || typeof runId !== "string" || runId.length === 0) {
    return { eligible: false };
  }
  const bound = events.filter((e) => e && e.runId === runId);

  const state = findState(bound);
  if (typeof state !== "string" || !RUN_STATES.includes(state) || TERMINAL_STATES.includes(state)) {
    return { eligible: false };
  }

  const requested = bound.some((e) => (
    (e.type === "run.background_submitted" && e.deliveryRequested === true)
    || (e.type === "run.started" && e.delivery && typeof e.delivery.mode === "string" && e.delivery.mode.length > 0)
  ));
  if (!requested) return { eligible: false };

  if (bound.some((e) => DELIVERY_FACT_TYPES.has(e.type))) return { eligible: false };
  if (bound.some((e) => e.type === "run.delivery_failed")) return { eligible: false };
  if (bound.some((e) => CONFLICT_TYPES.has(e.type))) return { eligible: false };
  if (bound.some((e) => e.type === "run.state_change" && TERMINAL_STATES.includes(e.to))) {
    return { eligible: false };
  }

  const started = bound.filter((e) => e.type === "run.started");
  if (started.length !== 1) return { eligible: false };
  const s = started[0];
  const delivery = s.delivery;
  if (!delivery || typeof delivery !== "object") return { eligible: false };
  if (!isCanonicalCommitId(delivery.baseCommit)) return { eligible: false };
  if (!Array.isArray(delivery.allowedPaths) || delivery.allowedPaths.length === 0) return { eligible: false };
  if (typeof s.worktreePath !== "string" || s.worktreePath.length === 0) return { eligible: false };
  const hasCommands = Array.isArray(delivery.verificationCommands) && delivery.verificationCommands.length > 0
    && delivery.verificationCommands.every((c) => typeof c === "string" && c.trim().length > 0);
  const hasReason = typeof delivery.verificationUnavailableReason === "string"
    && delivery.verificationUnavailableReason.trim().length > 0;
  if (!hasCommands && !hasReason) return { eligible: false };

  const sessions = bound.filter((e) => e.type === "session.created");
  if (sessions.length !== 1) return { eligible: false };
  const pid = _parseProcPid(sessions[0].backendSessionId);
  if (pid === null) return { eligible: false };

  return { eligible: true, pid };
}

/**
 * Runtime liveness proof for a process_missing recovery candidate.
 *
 * Calls classifyProcessMissingCandidate, then inspects ONLY safe runtime facts:
 *   - owner lease (readOwnerLease SSOT): MISSING is allowed (the runner may have
 *     exited and deleted its lease); CORRUPT/malformed is NOT eligible; FRESH is
 *     NOT eligible (the owner is actively heartbeating); a STALE-VALID lease
 *     requires the owner PID to ALSO be proven dead;
 *   - the child PID (proc_<pid>) MUST be proven dead via the conservative probe
 *     (error.code === "ESRCH" only; EPERM/unknown/missing code/probe-error all
 *     mean alive → NOT eligible).
 *
 * Conservative by contract: it is always safe to NOT recover. A single
 * "unknown" never settles an orphan. Never returns PID/path/error text — only a
 * boolean eligibility the caller turns into a closed-set candidate kind.
 *
 * @param {object[]} events
 * @param {string} runId
 * @param {{runDir:string, now?:number, isAliveFn?:Function, ownerLeaseReader?:Function, thresholdMs?:number}} deps
 * @returns {{eligible:true}|{eligible:false}}
 */
export function proveProcessMissing(events, runId, deps = {}) {
  const candidate = classifyProcessMissingCandidate(events, runId);
  if (!candidate.eligible) return { eligible: false };

  const { runDir } = deps;
  if (typeof runDir !== "string" || runDir.length === 0) return { eligible: false };
  const now = typeof deps.now === "number" && Number.isFinite(deps.now) ? deps.now : Date.now();
  const isAliveFn = typeof deps.isAliveFn === "function" ? deps.isAliveFn : isPidAlive;
  const ownerLeaseReader = typeof deps.ownerLeaseReader === "function" ? deps.ownerLeaseReader : readOwnerLease;
  const thresholdMs = typeof deps.thresholdMs === "number" && Number.isFinite(deps.thresholdMs)
    ? deps.thresholdMs
    : DEFAULT_OWNER_LIVENESS_THRESHOLD_MS;

  const lease = ownerLeaseReader(runDir, runId, now, thresholdMs);
  if (lease.present && !lease.wellFormed) return { eligible: false };
  if (lease.present && lease.wellFormed && lease.fresh) return { eligible: false };
  if (lease.present && lease.wellFormed && !lease.fresh) {
    // Stale but well-formed: the owner PID must also be proven dead.
    if (isAliveFn(lease.pid)) return { eligible: false };
  }
  // Missing lease: nothing to refute — fall through to the child-PID proof.

  // The detached child PID must be PROVEN dead (ESRCH code only).
  if (isAliveFn(candidate.pid)) return { eligible: false };

  return { eligible: true };
}
