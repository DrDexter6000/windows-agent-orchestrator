// src/application/runReadOnlyObservation.js
//
// Round 4 Bundle B: the SINGLE pure, provider-neutral advisory read-only
// observation projector.
//
// A run dispatched with a read-only declaration (run_dispatch readOnly /
// `run --read-only`) persists exactly one `run.read_only_declared` durable
// fact at RunManager.start. This module turns ONE frozen transcript event
// prefix (the SAME prefix that drives the activity page/cursor in
// runActivityProjection) into one additive, closed-set, Host-neutral fact
// consumed by run_activity:
//
//   readOnlyObservation : {
//     status: no_writes_observed | writes_observed | unknown,
//     source: "transcript_file_events",
//     complete: boolean,          // terminal snapshot AND fully evaluable
//     observedFileCount: number,  // unique evaluable derived relative paths
//     writtenPaths: string[],     // bounded, sorted, redacted+sanitized
//     writtenPathCount: number,   // full bounded observation truth
//     writtenPathsTruncated: boolean, // writtenPathCount > shared cap
//   }
//
// HONEST semantics (Owner constraint — advisory observation, NEVER a gate):
//   - status reports what the CURRENT snapshot OBSERVES, not what the world
//     is. A non-terminal snapshot may already be writes_observed — that is
//     the in-flight alert; presentation is NOT action. WAO never stops,
//     retries, fails, or rewrites the terminal state of a run because writes
//     were observed; final judgment stays with the Lead.
//   - no_writes_observed means "no writes were OBSERVED (tool-reported
//     evidence only)" — it does NOT mean "nothing was written". Observation
//     is based on the worker's confirmed file_written reporting channel, not
//     an omniscient filesystem scan.
//   - readOnly is a DECLARATION, not an OS sandbox: forced worktree isolation
//     and out-of-bound write detection are detection mechanisms, not
//     confinement guarantees.
//
// Architectural contract (mirrors runScopeObservation.js / M12-14):
//   - PURE. No MCP SDK, no zod, no src/commands/*, no src/mcp/*, no backend
//     name, no process spawn, no filesystem, no network. The only imports
//     are the createSecretRedactor SSOT and the delivery.js path SSOT
//     (isValidRepoRelativePath).
//   - FACTS ONLY. The authority is exactly ONE run.started event bound to
//     this run with an absolute worktreePath (read-only runs are NON-delivery
//     — no delivery.allowedPaths is required or consulted), PLUS exactly ONE
//     bound run.read_only_declared event. Only confirmed run.event
//     kind=file_written events from the frozen snapshot are considered —
//     never commands, tool_use, worker text, Git status, or filesystem scans.
//   - DERIVATION RULE. A relative path is derived ONLY when the event path
//     is proven lexically inside the persisted worktreePath (pure lexical
//     normalization — no fs, no resolve). Separators are normalized to POSIX
//     and the derived path is validated with the existing projected-path SSOT
//     (isValidRepoRelativePath).
//   - FAIL-CLOSED. Valid authority + single declaration + all observed paths
//     evaluable + zero unique writes => no_writes_observed; any unique write
//     => writes_observed. Missing/ambiguous authority, missing/duplicate/
//     malformed declaration, or ANY unevaluable file-written path => unknown.
//   - COMPLETE. true ONLY when the snapshot is terminal AND the observation
//     is fully evaluable; false while running and for unknown. It does NOT
//     mean semantic task completion.
//   - SAFE. Every dynamic path is redacted (exact-secret SSOT) then C0/C1/DEL-
//     sanitized then bounded BEFORE it crosses the projection boundary. Never
//     exposes worktree absolute paths, credentials, prompt, command, tool
//     input, PID, provider payload, session id, or a raw malformed path.
//   - ADVISORY ONLY. No transcript append, no filesystem read/scan, no stop/
//     retry/continue mutation, no semantic decision, no hard failure gate.
//   - CURSOR TRUTH (via projectRunActivity). A continuation cursor projects
//     readOnlyObservation from its frozen prefix; appending a later written
//     file cannot alter an existing cursor result while a fresh page-1 call
//     may observe it.
//
// The exported *_CAP / STATUSES / SOURCE constants are the SINGLE source for
// the MCP output schema bounds (src/mcp/server.js imports them) — schema and
// projector can never drift.

import { createSecretRedactor } from "../secretRedaction.js";
import { isValidRepoRelativePath } from "../delivery.js";

// ===== Closed-set statuses + shared wire constants (SSOT for the MCP schema) =====

export const READ_ONLY_OBSERVATION_STATUSES = Object.freeze([
  "no_writes_observed",
  "writes_observed",
  "unknown",
]);

export const READ_ONLY_OBSERVATION_SOURCE = "transcript_file_events";

// The ONE exported cap shared by the projector and the MCP output schema:
// writtenPaths is a bounded display list; writtenPathCount retains the full
// bounded observation truth and writtenPathsTruncated is truthful.
export const READ_ONLY_WRITTEN_PATHS_CAP = 25;

// Per-path bound for the redacted output list (same spirit as the activity
// entry path cap — applied AFTER redaction, so a secret straddling the bound
// is already [REDACTED] before any slice).
export const READ_ONLY_OBSERVATION_PATH_CAP = 256;

// ===== Pure lexical path helpers (no fs, no node:path) =====

function toPosix(p) {
  return String(p).replace(/\\/g, "/");
}

/** Absolute-path-text detection: POSIX root/UNC or Windows drive. */
function isAbsPathText(s) {
  if (s.startsWith("/")) return true;
  return /^[A-Za-z]:[\\/]/.test(s);
}

function isWindowsAbsPathText(s) {
  return /^[A-Za-z]:\//.test(s) || s.startsWith("//");
}

/**
 * Pure lexical POSIX normalization ("." / ".." / empty segments) with NO
 * filesystem. Returns null when the segments escape the root — ".." with
 * nothing left to pop — which is the only escape a relative path can perform.
 */
function lexNormalizePosix(p) {
  const out = [];
  for (const seg of String(p).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.join("/");
}

/**
 * Derive the worktree-relative POSIX path for one event path, or null when the
 * event path cannot be PROVEN lexically inside the persisted worktreePath (or
 * is not a valid repo-relative path). PURE lexical reasoning — the worktree
 * root is a string, never a filesystem probe.
 */
function deriveRelativePath(eventPath, worktreePath) {
  if (typeof eventPath !== "string" || eventPath.length === 0) return null;
  if (eventPath.includes("\0")) return null;
  const norm = toPosix(eventPath);
  const wt = toPosix(worktreePath).replace(/\/+$/, ""); // root without trailing slash
  if (isAbsPathText(norm)) {
    // Absolute event path: proven inside ONLY when it is a descendant of the
    // worktree on a segment boundary. Windows drive and UNC paths use
    // Windows' case-insensitive absolute-path semantics for this containment
    // proof only; the derived Git path still goes through the case-sensitive
    // isValidRepoRelativePath SSOT below.
    const windowsComparison = isWindowsAbsPathText(norm) && isWindowsAbsPathText(wt);
    const normForContainment = windowsComparison ? norm.toLowerCase() : norm;
    const wtForContainment = windowsComparison ? wt.toLowerCase() : wt;
    // The worktree itself is not a file write.
    if (normForContainment === wtForContainment
      || !normForContainment.startsWith(wtForContainment + "/")) return null;
    const rel = norm.slice(wt.length + 1);
    if (rel.length === 0) return null;
    return isValidRepoRelativePath(rel) ? rel : null;
  }
  // Relative event path: normalize — an escape to outside the root yields
  // null (unevaluable). Then validate with the projected-path SSOT.
  const rel = lexNormalizePosix(norm);
  if (rel === null || rel.length === 0) return null;
  return isValidRepoRelativePath(rel) ? rel : null;
}

/**
 * Extract the authority from the frozen snapshot: exactly ONE run.started
 * event bound to this run with an absolute worktreePath. Anything else —
 * missing, ambiguous (duplicates), malformed, cross-run — collapses to null
 * (unknown). Read-only runs are non-delivery: no delivery contract is
 * required or consulted.
 */
function extractAuthority(events, runId) {
  const started = [];
  for (const event of events) {
    if (event !== null && typeof event === "object" && !Array.isArray(event)
      && event.type === "run.started" && event.runId === runId) {
      started.push(event);
    }
  }
  if (started.length !== 1) return null;
  const bound = started[0];
  if (typeof bound.worktreePath !== "string" || !isAbsPathText(toPosix(bound.worktreePath))) {
    return null;
  }
  return { worktreePath: bound.worktreePath };
}

/**
 * Count the bound read-only declarations. Exactly ONE is the usable
 * declaration; zero (the projector is mounted only when a declaration exists,
 * but stays total), duplicates, or malformed payloads collapse to null
 * (unknown) — a duplicated durable declaration is ambiguous, never averaged.
 */
function extractDeclaration(events, runId) {
  const declared = [];
  for (const event of events) {
    if (event !== null && typeof event === "object" && !Array.isArray(event)
      && event.type === "run.read_only_declared" && event.runId === runId) {
      declared.push(event);
    }
  }
  return declared.length === 1 ? declared[0] : null;
}

// ===== Dynamic-string safety (mirrors the activity projection's uniform path) =====

// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

function sanitizeControls(text) {
  return String(text).replace(UNSAFE_CONTROL_RE, "�");
}

function safeSliceUtf16(str, start, end) {
  let adjustedEnd = end;
  if (adjustedEnd < str.length) {
    const cc = str.charCodeAt(adjustedEnd - 1);
    if (cc >= 0xD800 && cc <= 0xDBFF) adjustedEnd -= 1; // don't split a surrogate pair
  }
  return str.slice(start, adjustedEnd);
}

/** Redact -> sanitize -> bound: THE single output path for a dynamic path. */
function safePath(raw, redactor) {
  const redacted = redactor.redactString(raw);
  const sanitized = sanitizeControls(redacted);
  return sanitized.length <= READ_ONLY_OBSERVATION_PATH_CAP
    ? sanitized
    : safeSliceUtf16(sanitized, 0, READ_ONLY_OBSERVATION_PATH_CAP);
}

// ===== Public projection entry point =====

/**
 * Project the advisory read-only observation from ONE frozen transcript event
 * prefix. TOTAL and fail-closed: any unexpected input collapses to a safe
 * status=unknown observation — this NEVER throws and NEVER breaks the caller
 * (historical transcripts and undeclared runs stay readable as unknown).
 *
 * @param {object[]} events — the FROZEN raw-event prefix (untrusted)
 * @param {object} opts
 * @param {string} opts.runId — the caller-requested runId (cross-run binding)
 * @param {boolean} [opts.terminal] — whether the snapshot is terminal
 *        (complete=true gate; NOT semantic task completion)
 * @param {object} [opts.env] — env for the secret redactor (default process.env)
 * @returns {object} the safe readOnlyObservation fact
 */
export function projectReadOnlyObservation(events, { runId, terminal, env } = {}) {
  const unknown = {
    status: "unknown",
    source: READ_ONLY_OBSERVATION_SOURCE,
    complete: false,
    observedFileCount: 0,
    writtenPaths: [],
    writtenPathCount: 0,
    writtenPathsTruncated: false,
  };
  try {
    if (!Array.isArray(events)) return unknown;
    if (typeof runId !== "string" || runId.length === 0) return unknown;

    // Authority: exactly one bound run.started with an absolute worktreePath,
    // plus exactly one bound read-only declaration.
    const authority = extractAuthority(events, runId);
    if (!authority) return unknown;
    if (!extractDeclaration(events, runId)) return unknown;

    // Redactor for the OUTPUT transform only — status/counts decide on the
    // ACTUAL derived paths (a secret is an output concern, not a fact).
    const redactor = createSecretRedactor(env ?? process.env);

    // Confirmed file_written events bound to this run, from the frozen
    // snapshot only. Never inferred from commands/tool_use/text/Git/fs.
    const written = [];
    for (const event of events) {
      if (event !== null && typeof event === "object" && !Array.isArray(event)
        && event.type === "run.event" && event.kind === "file_written"
        && event.runId === runId) {
        written.push(event);
      }
    }

    // Dedupe ACTUAL derived relative paths before counts (redaction is an
    // output transform only — the status/counts decide on the actual paths).
    const unique = new Set();
    let unevaluable = false;
    for (const event of written) {
      const rel = deriveRelativePath(event.path, authority.worktreePath);
      if (rel === null) {
        unevaluable = true;
        continue;
      }
      unique.add(rel);
    }
    const actual = [...unique].sort();

    if (unevaluable) {
      // ANY unevaluable file-written path voids the observation: unknown.
      return { ...unknown, observedFileCount: actual.length };
    }

    const writtenPathCount = actual.length;
    const status = writtenPathCount > 0 ? "writes_observed" : "no_writes_observed";

    // Output list: redact -> sanitize -> bound, then sort + cap. Do NOT dedupe
    // after redaction: two distinct actual paths can intentionally collapse to
    // the same safe placeholder, and each remains a distinct observed fact.
    const safeList = actual.map((rel) => safePath(rel, redactor));
    safeList.sort();

    const writtenPaths = safeList.slice(0, READ_ONLY_WRITTEN_PATHS_CAP);

    return {
      status,
      source: READ_ONLY_OBSERVATION_SOURCE,
      complete: Boolean(terminal),
      observedFileCount: actual.length,
      writtenPaths,
      writtenPathCount,
      writtenPathsTruncated: writtenPathCount > writtenPaths.length,
    };
  } catch {
    return unknown;
  }
}
