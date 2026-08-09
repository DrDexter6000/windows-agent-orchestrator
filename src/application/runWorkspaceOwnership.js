// src/application/runWorkspaceOwnership.js
//
// M10 P0-3 + M12-14: Run workspace ownership SSOT.
//
// The single source of truth for identifying and verifying which workspace
// a run belongs to. TWO unambiguous durable ownership shapes are accepted
// for the REQUESTED run:
//
//   - background: exactly one `run.background_submitted` bound to the
//     requested run, with a valid cwd. When a `run.started` cwd for the SAME
//     run is ALSO present it must agree after the existing
//     proveWorkspace/pathsMatch normalization (realpath + platform
//     case-fold) — a disagreement is a durable conflict, not a silent
//     preference for one fact.
//   - foreground: no `run.background_submitted` for the requested run and
//     exactly one bound `run.started` with a valid cwd (the cwd
//     RunManager.start persists).
//
// Everything else fails closed: missing, malformed, duplicate (background AND
// foreground), cross-run-only, conflicting background-vs-started, unprovable,
// and cross-workspace ownership facts are all rejected with FIXED messages
// that never echo paths or dynamic values.
//
// AUTHORIZATION BOUNDARY (M12-14): ownership facts bind to the requested run
// by EXACT envelope runId equality — `e.runId === requestedRunId` — and the
// candidate filter runs BEFORE any cwd is interpreted. Event ORDER carries no
// authority: the first event is not the transcript's identity. A foreign
// ownership fact (a different runId) is never a candidate for the requested
// run, so it can neither authorize, conflict with, nor poison the requested
// run. Production callers (run list, stop, wait, await-result, activity,
// continue, delivery, review, reverify, repackage) all pass the runId they
// already hold or derive from the transcript filename.
//
// Legacy compatibility: ownership events that GENUINELY lack a runId envelope
// (transcripts written before envelope stamping) are attributed to the
// requested run ONLY when the file's ownership facts are otherwise
// unambiguous — no ownership event in the file carries ANY runId. A file
// mixing bound and unbound ownership facts cannot be attributed safely and
// fails closed (missing) rather than guess. Callers that supply no
// requestedRunId at all (legacy callers) get the pre-M12-14 whole-file
// interpretation without binding.
//
// Both runStop.js and runList.js delegate to this module — no second copy
// of the ownership algorithm exists anywhere.
//
// Architectural contract:
//   - Does NOT import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Reuses proveWorkspace + pathsMatch (and canonicalizeWorkspacePath, the
//     exact normalization proveWorkspace applies) from workspaceBinding.js.
//   - Never reads process.platform or implements path comparison.

import { proveWorkspace, pathsMatch, canonicalizeWorkspacePath } from "./workspaceBinding.js";

/**
 * Find the workspace ownership fact for the requested run from transcript
 * events.
 *
 * Transcript events are flat — payload fields are at the top level alongside
 * envelope fields (ts, seq, runId, agentId, type).
 *
 * With `requestedRunId`, ownership candidates are selected by EXACT envelope
 * equality (e.runId === requestedRunId) BEFORE any cwd is interpreted; a
 * foreign ownership event (any other runId) is not a candidate at all, so it
 * can neither authorize, conflict with, nor poison the requested run. When no
 * candidate exists and NO ownership event in the file carries any runId
 * envelope, the runId-less ownership events are attributed to the requested
 * run (legacy tolerance) and interpreted with the same rules. Without
 * `requestedRunId` (legacy callers), the whole file is interpreted unbounded,
 * as before M12-14.
 *
 * Interpretation (identical for bound, legacy-fallback, and legacy
 * candidates):
 *   - background: one `run.background_submitted` (cwd required, non-empty).
 *     If any `run.started` for the same run carries a cwd it must agree
 *     after canonicalizeWorkspacePath + pathsMatch normalization (identical
 *     strings agree trivially; a started cwd that cannot be normalized to
 *     the same directory is a conflict).
 *   - foreground: NO `run.background_submitted` for the requested run,
 *     exactly one `run.started` carrying a valid cwd. Multiple started
 *     events are ambiguous; a started event without a cwd carries no
 *     ownership fact (returns null).
 *
 * @param {object[]} events
 * @param {string} [requestedRunId] — the caller-requested run; production
 *        callers always supply it (binding is by exact envelope equality)
 * @returns {{cwd: string, via: string}|null} the ownership cwd + fact type,
 *          or null if the requested run has no ownership fact
 * @throws {Error} with a FIXED message for ambiguous / malformed / cross-run /
 *                  conflicting ownership facts (never echoes paths or runIds)
 */
export function findRunWorkspaceOwnership(events, requestedRunId) {
  const requested = typeof requestedRunId === "string" && requestedRunId.length > 0 ? requestedRunId : null;
  const allSubmitted = events.filter((e) => e.type === "run.background_submitted");
  const allStarted = events.filter((e) => e.type === "run.started");

  let submitted = allSubmitted;
  let started = allStarted;
  if (requested !== null) {
    submitted = allSubmitted.filter((e) => e.runId === requested);
    started = allStarted.filter((e) => e.runId === requested);
    if (submitted.length === 0 && started.length === 0) {
      // Legacy tolerance: attributing runId-less ownership events is safe ONLY
      // when no ownership event in the file carries any runId envelope.
      // Otherwise an unbound fact could belong to another run and must not be
      // attributed — fail closed (missing) rather than guess.
      const anyBoundOwnership = allSubmitted.some((e) => typeof e.runId === "string" && e.runId.length > 0)
        || allStarted.some((e) => typeof e.runId === "string" && e.runId.length > 0);
      if (!anyBoundOwnership) {
        submitted = allSubmitted;
        started = allStarted;
      }
    }
  }

  if (submitted.length > 1) {
    throw new Error("ambiguous ownership: multiple run.background_submitted events");
  }

  if (submitted.length === 1) {
    // ── background: run.background_submitted is the ownership authority ──
    const cwd = submitted[0].cwd;
    if (typeof cwd !== "string" || cwd.length === 0) {
      throw new Error("malformed ownership: run.background_submitted.cwd is missing or empty");
    }
    for (const s of started) {
      if (s.cwd === undefined) continue; // backgroundRunner shape: no cwd recorded
      if (typeof s.cwd !== "string" || s.cwd.length === 0) {
        throw new Error("malformed ownership: run.started.cwd is missing or empty");
      }
      if (!cwdsAgree(cwd, s.cwd)) {
        throw new Error("conflicting ownership: run.started cwd does not agree with run.background_submitted cwd");
      }
    }
    return { cwd, via: "run.background_submitted" };
  }

  // ── foreground: no background_submitted — run.started is the authority ──
  if (started.length === 0) return null; // no ownership fact at all
  if (started.length > 1) {
    throw new Error("ambiguous ownership: multiple run.started events without run.background_submitted");
  }
  const cwd = started[0].cwd;
  if (typeof cwd !== "string" || cwd.length === 0) {
    // A started event without a cwd records no ownership fact (missing).
    return null;
  }
  return { cwd, via: "run.started" };
}

/**
 * Do two cwd facts refer to the same directory, using the exact normalization
 * proveWorkspace applies (canonicalizeWorkspacePath + pathsMatch)?
 *
 * Identical strings agree trivially (no filesystem access). Differing strings
 * are realpath-normalized and compared with pathsMatch (platform case-fold).
 * Either cwd that cannot be normalized cannot be shown to agree — fail closed
 * as a conflict (a real submitted cwd always realpaths; an unnormalizable one
 * would be rejected by proveWorkspace anyway, so no production case is lost).
 *
 * @private
 */
function cwdsAgree(submittedCwd, startedCwd) {
  if (submittedCwd === startedCwd) return true;
  let submittedNorm;
  try {
    submittedNorm = canonicalizeWorkspacePath(submittedCwd);
  } catch {
    return false;
  }
  let startedNorm;
  try {
    startedNorm = canonicalizeWorkspacePath(startedCwd);
  } catch {
    return false; // started cwd cannot be shown to agree — fail closed
  }
  return pathsMatch(submittedNorm, startedNorm);
}

/**
 * Create a query-scoped workspace verifier.
 *
 * The authorized root is proved once. Each distinct ownership cwd is then
 * proved at most once for the lifetime of this verifier. This preserves the
 * existing Git-top-level and realpath checks while avoiding repeated Git
 * subprocesses when a run inventory contains many runs from the same project.
 *
 * @param {string} authorizedWorkspaceRoot
 * @param {{proveWorkspaceFn?: Function}} [opts]
 * @returns {(events: object[], requestedRunId?: string) => {authorized: true, ownershipCwd: string}}
 */
export function createRunWorkspaceVerifier(authorizedWorkspaceRoot, opts = {}) {
  const prove = opts.proveWorkspaceFn ?? proveWorkspace;
  const authorizedProof = prove(authorizedWorkspaceRoot);
  const proofCache = new Map([
    [authorizedWorkspaceRoot, authorizedProof],
    [authorizedProof.root, authorizedProof],
  ]);
  const failedProofs = new Set();

  return function verify(events, requestedRunId) {
    const fact = findRunWorkspaceOwnership(events, requestedRunId);
    if (!fact) {
      throw new Error("missing ownership: no run.background_submitted or run.started ownership event");
    }

    if (failedProofs.has(fact.cwd)) {
      throw new Error("unprovable ownership workspace");
    }

    let ownershipProof = proofCache.get(fact.cwd);
    if (!ownershipProof) {
      try {
        ownershipProof = prove(fact.cwd);
      } catch {
        failedProofs.add(fact.cwd);
        throw new Error("unprovable ownership workspace");
      }
      proofCache.set(fact.cwd, ownershipProof);
      proofCache.set(ownershipProof.root, ownershipProof);
    }

    if (!pathsMatch(ownershipProof.root, authorizedProof.root)) {
      throw new Error("workspace mismatch: run ownership does not match authorized workspace");
    }
    return { authorized: true, ownershipCwd: fact.cwd };
  };
}

/**
 * Verify that the requested run's workspace ownership matches the authorized
 * root.
 *
 * Accepts the two unambiguous durable shapes for the requested run
 * (background_submitted; foreground run.started), each bound to
 * `requestedRunId` by exact envelope equality, and rejects everything else
 * with fixed messages. Uses proveWorkspace SSOT to canonicalize both paths
 * (rejects subdirectories, non-existent paths, non-Git dirs). Uses pathsMatch
 * SSOT for platform-aware comparison (case-insensitive on win32).
 *
 * @param {object[]} events
 * @param {string} authorizedWorkspaceRoot — canonical Git root from server binding
 * @param {string} [requestedRunId] — the caller-requested run; production
 *        callers always supply it (binding is by exact envelope equality)
 * @returns {{authorized: true, ownershipCwd: string}}
 * @throws {Error} if ownership is missing, malformed, ambiguous, cross-run,
 *                  conflicting, unprovable, or mismatched
 */
export function verifyRunWorkspaceOwnership(events, authorizedWorkspaceRoot, requestedRunId) {
  return createRunWorkspaceVerifier(authorizedWorkspaceRoot)(events, requestedRunId);
}
