// src/application/runScopeObservation.js
//
// M12-14: the SINGLE pure, provider-neutral advisory scope-observation
// projector.
//
// run_activity tells the Lead whether the confirmed file_written events
// observed in the SAME frozen transcript snapshot are still within the
// persisted delivery.allowedPaths contract — an advisory early-warning that
// reduces repeated disallowed_path delivery waste WITHOUT weakening Lead
// authority or final delivery containment.
//
// This module turns ONE frozen transcript event prefix (the SAME prefix that
// drives the activity page/cursor in runActivityProjection) into one additive,
// closed-set, Host-neutral fact consumed by run_activity:
//
//   scopeObservation : {
//     status: within_declared_paths | outside_declared_paths | unknown,
//     source: "transcript_file_events",
//     complete: boolean,          // terminal snapshot AND fully evaluable
//     observedFileCount: number,  // unique evaluable derived relative paths
//     outsidePaths: string[],     // bounded, sorted, redacted+sanitized
//     outsidePathCount: number,   // full bounded observation truth
//     outsidePathsTruncated: boolean, // outsidePathCount > shared cap
//   }
//
// Architectural contract:
//   - PURE. No MCP SDK, no zod, no src/commands/*, no src/mcp/*, no backend
//     name, no process spawn, no filesystem, no network. The only imports are
//     the createSecretRedactor SSOT and the delivery.js path SSOTs
//     (isValidRepoRelativePath, isPathAllowed).
//   - FACTS ONLY. The authority is exactly ONE run.started event bound to this
//     run with an absolute worktreePath and a non-empty delivery.allowedPaths.
//     Only confirmed run.event kind=file_written events from the frozen
//     snapshot are considered — never commands, tool_use, worker text, Git
//     status, or filesystem scans.
//   - DERIVATION RULE. A relative path is derived ONLY when the event path is
//     proven lexically inside the persisted worktreePath (pure lexical
//     normalization — no fs, no resolve). Separators are normalized to POSIX,
//     the derived path is validated with the existing projected-path SSOT
//     (isValidRepoRelativePath), and compared with the exported
//     delivery.isPathAllowed segment-boundary SSOT.
//   - FAIL-CLOSED. Valid contract + all observed paths evaluable + none
//     outside => within_declared_paths. Any confirmed evaluable path outside
//     => outside_declared_paths. Missing/ambiguous/malformed contract or ANY
//     unevaluable file-written path => unknown. NEVER throws solely because
//     scope facts are absent — historical transcripts and non-delivery runs
//     stay readable as status=unknown.
//   - COMPLETE. true ONLY when the snapshot is terminal AND the observation is
//     fully evaluable; false while running and for unknown. It does NOT mean
//     semantic task completion.
//   - SAFE. Every dynamic path is redacted (exact-secret SSOT) then C0/C1/DEL-
//     sanitized then bounded BEFORE it crosses the projection boundary. Never
//     exposes worktree absolute paths, credentials, prompt, command, tool
//     input, PID, provider payload, session id, or a raw malformed path.
//   - ADVISORY ONLY. No transcript append, no filesystem read/scan, no stop/
//     retry/continue/repackage/allowedPaths mutation, no semantic decision.
//   - CURSOR TRUTH (via projectRunActivity). A continuation cursor projects
//     scopeObservation from its frozen prefix; appending a later outside file
//     cannot alter an existing cursor result while a fresh page-1 call may
//     observe it.
//
// The exported *_CAP / STATUSES / SOURCE constants are the SINGLE source for
// the MCP output schema bounds (src/mcp/server.js imports them) — schema and
// projector can never drift.

import { createSecretRedactor } from "../secretRedaction.js";
import { isPathAllowed, isValidRepoRelativePath } from "../delivery.js";

// ===== Closed-set statuses + shared wire constants (SSOT for the MCP schema) =====

export const SCOPE_OBSERVATION_STATUSES = Object.freeze([
  "within_declared_paths",
  "outside_declared_paths",
  "unknown",
]);

export const SCOPE_OBSERVATION_SOURCE = "transcript_file_events";

// The ONE exported cap shared by the projector and the MCP output schema:
// outsidePaths is a bounded display list; outsidePathCount retains the full
// bounded observation truth and outsidePathsTruncated is truthful.
export const SCOPE_OBSERVATION_OUTSIDE_PATHS_CAP = 25;

// Per-path bound for the redacted output list (same spirit as the activity
// entry path cap — applied AFTER redaction, so a secret straddling the bound
// is already [REDACTED] before any slice).
export const SCOPE_OBSERVATION_PATH_CAP = 256;

// ===== Pure lexical path helpers (no fs, no node:path) =====

function toPosix(p) {
  return String(p).replace(/\\/g, "/");
}

/** Absolute-path-text detection: POSIX root/UNC or Windows drive. */
function isAbsPathText(s) {
  if (s.startsWith("/")) return true;
  return /^[A-Za-z]:[\\/]/.test(s);
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
    // Absolute event path: proven inside ONLY when it equals the worktree or
    // is a descendant on a segment boundary. The worktree itself is not a
    // file write.
    if (norm === wt || !norm.startsWith(wt + "/")) return null;
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
 * event bound to this run, with an absolute worktreePath and a non-empty
 * delivery.allowedPaths of valid repo-relative paths. Anything else — missing,
 * ambiguous (duplicates), malformed, cross-run — collapses to null (unknown).
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
  const delivery = bound.delivery;
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) return null;
  if (!Array.isArray(delivery.allowedPaths) || delivery.allowedPaths.length === 0) return null;
  const allowed = [];
  for (const p of delivery.allowedPaths) {
    if (typeof p !== "string") return null;
    const norm = toPosix(p);
    if (!isValidRepoRelativePath(norm)) return null;
    allowed.push(norm);
  }
  return { worktreePath: bound.worktreePath, allowedPaths: [...new Set(allowed)].sort() };
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
  return sanitized.length <= SCOPE_OBSERVATION_PATH_CAP
    ? sanitized
    : safeSliceUtf16(sanitized, 0, SCOPE_OBSERVATION_PATH_CAP);
}

// ===== Public projection entry point =====

/**
 * Project the advisory scope observation from ONE frozen transcript event
 * prefix. TOTAL and fail-closed: any unexpected input collapses to a safe
 * status=unknown observation — this NEVER throws and NEVER breaks the caller
 * (historical transcripts and non-delivery runs stay readable as unknown).
 *
 * @param {object[]} events — the FROZEN raw-event prefix (untrusted)
 * @param {object} opts
 * @param {string} opts.runId — the caller-requested runId (cross-run binding)
 * @param {boolean} [opts.terminal] — whether the snapshot is terminal
 *        (complete=true gate; NOT semantic task completion)
 * @param {object} [opts.env] — env for the secret redactor (default process.env)
 * @returns {object} the safe scopeObservation fact
 */
export function projectScopeObservation(events, { runId, terminal, env } = {}) {
  const unknown = {
    status: "unknown",
    source: SCOPE_OBSERVATION_SOURCE,
    complete: false,
    observedFileCount: 0,
    outsidePaths: [],
    outsidePathCount: 0,
    outsidePathsTruncated: false,
  };
  try {
    if (!Array.isArray(events)) return unknown;
    if (typeof runId !== "string" || runId.length === 0) return unknown;

    // Authority: exactly one bound run.started with a usable contract.
    const authority = extractAuthority(events, runId);
    if (!authority) return unknown;

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

    const outside = actual.filter((rel) => !isPathAllowed(rel, authority.allowedPaths));
    const outsidePathCount = outside.length;
    const status = outsidePathCount > 0 ? "outside_declared_paths" : "within_declared_paths";

    // Output list: redact -> sanitize -> bound, then dedupe + sort + cap.
    const safeList = [];
    const seen = new Set();
    for (const rel of outside) {
      const safe = safePath(rel, redactor);
      if (seen.has(safe)) continue;
      seen.add(safe);
      safeList.push(safe);
    }
    safeList.sort();

    return {
      status,
      source: SCOPE_OBSERVATION_SOURCE,
      complete: Boolean(terminal),
      observedFileCount: actual.length,
      outsidePaths: safeList.slice(0, SCOPE_OBSERVATION_OUTSIDE_PATHS_CAP),
      outsidePathCount,
      outsidePathsTruncated: outsidePathCount > SCOPE_OBSERVATION_OUTSIDE_PATHS_CAP,
    };
  } catch {
    return unknown;
  }
}
