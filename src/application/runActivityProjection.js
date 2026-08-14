// src/application/runActivityProjection.js
//
// M12-8 Package A: SHARED read-only activity timeline projector.
//
// Both the Lead-view MCP tool (run_activity, via src/mcp/server.js) and the
// internal owner view call projectRunActivity. Neither may return raw service
// output. The projector owns:
//   - exact run binding: EVERY object event in the snapshot must carry
//     runId === the requested runId; missing/mismatched/conflicting envelope
//     facts fail closed BEFORE any structured activity result — never degrade
//     agentId to unknown while still projecting content;
//   - shape-driven classification of every transcript event into a closed set
//     of 8 activity categories (NO backend/runtime branching);
//   - uniform dynamic-string safety: EVERY transcript-derived dynamic string
//     that crosses output (ts, role, message text, tool name, relative path,
//     backend, state, unknown-event label) goes through ONE redact -> sanitize
//     -> bound path, or a stricter closed-set/sentinel (terminal target is
//     TERMINAL_STATES-gated; unknown event labels are a fixed sentinel and
//     never echo arbitrary kind/type text);
//   - exact-secret redaction of each full text/payload BEFORE sanitization,
//     excerpt, and pagination (a secret spanning an excerpt or page boundary is
//     already [REDACTED] before any slice);
//   - C0/C1/DEL control sanitization (LF/TAB preserved);
//   - closed-set safe activity facts ONLY — never raw command text, tool input,
//     tool output, error text, credentials, PID/session id, absolute path, or
//     unknown payload; NO semantic summary/recommendation/progress estimate;
//   - per-page caps (entries + text excerpt) bounded per audience; an
//     explicitly provided invalid pageSize is REJECTED, never silently clamped;
//   - opaque base64url cursor codec binding runId digest + frozen raw-snapshot
//     digest + event count + view (audience + canonicalized unique sorted
//     filter set + afterSeq) digest + position — so a Lead cursor can never be
//     accepted by the owner view or vice versa;
//   - frozen-prefix replay protection: append-only safe, mutation/shrink/
//     cross-run/cross-view/cross-audience/malformed/noncanonical/oversized/
//     out-of-range all fail closed.
//
// Architectural contract:
//   - No file I/O, no MCP SDK / zod / command imports.
//   - Reuses createSecretRedactor SSOT, safeProjectAgentId SSOT,
//     assertEventsBoundToRunId SSOT, and the TERMINAL_STATES closed set from
//     transcript.js; isValidRunId SSOT from delivery.js. The cursor/digest/
//     sanitize helpers are re-implemented locally (mirroring the collect
//     projection's proven algorithm) so this module stays self-contained and
//     the collect projection is not perturbed (zero regression risk).
//   - The cursor carries ONLY digests + integers — never raw runId, sessionId,
//     serveUrl, cwd, prompt, path, secret, or worker text.
//
// The exported *_CAP constants are the SINGLE source for the MCP output
// schema bounds (src/mcp/server.js imports them) — schema and projector can
// never drift.

import { createHash } from "node:crypto";

import { createSecretRedactor } from "../secretRedaction.js";
import { safeProjectAgentId } from "../canonicalAgentId.js";
import { TERMINAL_STATES, assertEventsBoundToRunId } from "../transcript.js";
import { isValidRunId } from "../delivery.js";
import { RUNTIME_ACTIVITY_STATUSES } from "../runEvent.js";
// M12-14: advisory scope observation. The pure projector derives the
// scopeObservation fact from the SAME frozenEvents prefix that drives the
// activity page/cursor, so a continuation cursor never sees later appends
// while a fresh page-1 call may observe them.
import { projectScopeObservation } from "./runScopeObservation.js";

// ===== M12-19: structured cursor-rejection signal =====
//
// When a syntactically-valid cursor is stale / cross-run / cross-view /
// snapshot-changed / out-of-range (or malformed as a token), the projector
// throws THIS typed application-layer signal — NEVER a generic Error, and the
// MCP layer classifies it by TYPE (instanceof), never by matching error
// strings. The internal message is descriptive (for tests/diagnostics) but is
// NEVER surfaced across the MCP boundary: the handler folds every
// CursorRejectedError into the SAME bounded recovery payload (cursor_rejected +
// static choices), so the mismatch subtype, the raw cursor, and any dynamic
// detail never leak. Every NON-cursor failure (bad snapshot, invalid envelope,
// invalid pageSize/order/afterSeq/categories, output validation, unexpected
// internal error) stays a generic Error so the MCP layer can contain it as the
// fixed generic error with NO structuredContent.
export class CursorRejectedError extends Error {
  constructor(message) {
    super(message);
    this.name = "CursorRejectedError";
  }
}

// ===== Closed-set activity categories (drives BOTH the service and the MCP
// input schema — single source, no drift). =====

export const ACTIVITY_CATEGORIES = Object.freeze([
  "message",
  "command",
  "tool_use",
  "tool_result",
  "file_written",
  "runtime_status",
  "state",
  "correction",
  "other",
]);

// Fixed sentinel for unrecognized event shapes. `other` entries NEVER echo the
// raw type/kind (arbitrary transcript text) — the label is this constant only.
export const OTHER_EVENT_LABEL = "[unknown_event]";

// M12-16: correction lifecycle visibility. Each run.correction_* transcript type
// maps to a FIXED closed-set status derived ONLY from the event type — never from
// the payload. The prompt/body/reason are NEVER emitted; only the closed-set
// status (from the type) and a bounded, redacted correctionId (Lead-authored id
// for correlation, NOT the prompt). classifyEvent gates this category, so the
// resolved status is always a member of CORRECTION_ACTIVITY_STATUSES.
export const CORRECTION_ACTIVITY_STATUSES = Object.freeze([
  "requested",
  "claimed",
  "delivered",
  "delivery_failed",
  "rejected",
]);
const CORRECTION_TYPE_TO_STATUS = Object.freeze({
  "run.correction_requested": "requested",
  "run.correction_claimed": "claimed",
  "run.correction_delivered": "delivered",
  "run.correction_delivery_failed": "delivery_failed",
  "run.correction_rejected": "rejected",
});

function emptyCounts() {
  return {
    message: 0,
    command: 0,
    tool_use: 0,
    tool_result: 0,
    file_written: 0,
    runtime_status: 0,
    state: 0,
    correction: 0,
    other: 0,
  };
}

// ===== Per-audience caps. Owner sees a larger excerpt + larger default page;
// both reuse the SAME classifier / redaction / cursor machinery. =====

export const LEAD_TEXT_EXCERPT_CAP = 4000;
export const LEAD_PAGE_DEFAULT = 8;
export const LEAD_PAGE_HARD_CAP = 50;

export const OWNER_TEXT_EXCERPT_CAP = 8000;
export const OWNER_PAGE_DEFAULT = 50;
// Owner and Lead share the same absolute page hard cap (the cursor/replay bound).
const PAGE_HARD_CAP = LEAD_PAGE_HARD_CAP;

// Dynamic-string caps (exported so the MCP output schema reuses the EXACT
// same bounds — no hand-maintained second copy).
export const ACTIVITY_ROLE_CAP = 32;
export const ACTIVITY_LABEL_CAP = 64;
export const ACTIVITY_TOOL_NAME_CAP = 64;
export const ACTIVITY_PATH_CAP = 256;
export const ACTIVITY_TS_CAP = 64;

// ===== Cursor codec =====
//
// Token layout (canonical JSON, base64url, no padding):
//   {
//     "v": 1,                 // schema version
//     "r": "<runIdDigest>",   // sha256(runId).slice(0,16) base64url — 16 bytes
//     "s": "<snapDigest>",    // raw-event snapshot prefix digest
//     "n": <eventCount>,      // raw-event count of the frozen prefix
//     "f": "<viewDigest>",    // digest of the view (audience + filter set + afterSeq)
//     "p": <position>         // index into the filtered+ordered entry list
//   }
//
// Never carries raw runId, snapshot content, filter list, or text.

const CURSOR_VERSION = 1;
// Opaque cursor token bound: base64url, ≤ 256 chars. Exported so the MCP
// input/output schemas declare the EXACT same bound.
export const ACTIVITY_CURSOR_MAX_CHARS = 256;
const CURSOR_MAX_CHARS = ACTIVITY_CURSOR_MAX_CHARS;
const DIGEST_BYTES = 16; // 128-bit digests — enough binding, compact token
const DIGEST_B64_LEN = 22; // ceil(16/3)*4 without padding → 22 base64url chars

// ===== M12-19: bounded cursor-rejection recovery SSOT =====
//
// The SINGLE source for the structured recovery payload a rejected cursor
// returns. Closed-set fact + static choices only — WAO presents facts and
// choices, it NEVER auto-retries, NEVER auto-restarts pagination, and NEVER
// decides for the caller. The status is a small closed set (today one member,
// cursor_rejected); the choices are the EXACT two static recovery paths. The
// MCP output schema (server.js) is built from these exported constants so the
// wire enum cannot drift from what buildCursorRecovery emits.
export const ACTIVITY_CURSOR_RECOVERY_STATUSES = Object.freeze(["cursor_rejected"]);
export const ACTIVITY_CURSOR_RECOVERY_CHOICES = Object.freeze([
  // Re-request the first page WITHOUT a cursor — starts a fresh cursor chain.
  "request_page_1_without_cursor",
  // Re-enter via afterSeq sourced from a KNOWN wait/activity sequence
  // (e.g. a numeric cursor from run_wait / run_await_result).
  "use_afterSeq_from_known_sequence",
]);

/**
 * Build the bounded structured recovery payload for a rejected cursor.
 * Carries ONLY the closed-set fact + the static choices — never the raw cursor,
 * never the mismatch subtype, never a run/workspace path, never dynamic error
 * text, and never an auto-fallback page-1 result. The caller must explicitly
 * re-request. Pure + side-effect free; the MCP layer parses the result through
 * a strict emitted-shape parser built from the SAME exported constants.
 *
 * @returns {{status: string, choices: string[]}}
 */
export function buildCursorRecovery() {
  return {
    status: ACTIVITY_CURSOR_RECOVERY_STATUSES[0],
    choices: [...ACTIVITY_CURSOR_RECOVERY_CHOICES],
  };
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str) {
  if (typeof str !== "string" || str.length === 0 || !BASE64URL_RE.test(str)) {
    throw new CursorRejectedError("invalid cursor: not base64url");
  }
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function sha256Base64url(input) {
  return base64url(createHash("sha256").update(input, "utf8").digest().subarray(0, DIGEST_BYTES));
}

// ===== Raw-event snapshot digest (frozen-prefix binding) =====
//
// Covers the COMPLETE raw event sequence (every type/kind) so ANY mutation of
// history (edited message, inserted evidence, deleted event) changes the digest
// and fails the cursor closed. Each event is canonicalized (sorted keys, length-
// prefixed framing) before hashing. Sensitive fields are INCLUDED in the digest
// input — the digest is a 16-byte hash that never leaves the server, so
// including them does not leak data, and excluding them would let history
// silently change without invalidating the cursor.
//
// Exported as computeEventSnapshotDigestForTest so tests can forge valid-shape
// tokens to exercise the deeper position/binding checks.

export function computeEventSnapshotDigestForTest(events) {
  return computeRawEventDigest(events);
}

function computeRawEventDigest(events) {
  const hash = createHash("sha256");
  const list = Array.isArray(events) ? events : [];
  for (const item of list) {
    const canon = canonicalizeForDigest(item);
    hash.update(String(canon.length));
    hash.update("␟"); // unit separator frame — prevents concatenation ambiguity
    hash.update(canon, "utf8");
  }
  return base64url(hash.digest().subarray(0, DIGEST_BYTES));
}

function canonicalizeForDigest(item) {
  if (item === null || typeof item !== "object") return JSON.stringify(item);
  return JSON.stringify(sortKeysDeep(item));
}

function sortKeysDeep(obj) {
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  if (obj === null || typeof obj !== "object") return obj;
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = sortKeysDeep(obj[k]);
  return sorted;
}

// ===== View digest (audience + category filter + afterSeq + order) =====
//
// Binds the continuation to the EXACT view page 1 used. A different audience
// (lead vs owner), a different category set, a different afterSeq, or a
// different order is a different view → reject (cross-view). null/undefined
// categories ≡ "all" (canonical null); a provided subset is canonicalized to
// its UNIQUE sorted set (duplicates collapse — ["message","message"] ≡
// ["message"]).
//
// The audience is part of the digest so a Lead-view cursor can never be
// accepted by the owner view (or vice versa).
//
// M12-8C Package C — order binding. The asc DEFAULT MUST preserve the EXACT
// legacy digest ({c,a,u}) so every existing asc cursor — Lead view, every wild
// token issued before order existed — stays byte-valid under the SAME digest
// algorithm. desc is a distinct view ({c,a,u,o:"desc"}), so a desc cursor can
// never be accepted by an asc view (or vice versa): a desc Owner bootstrap is
// cursor-bound and rejects cross-order continuation.

function computeViewDigest(categories, afterSeq, audience, order) {
  const c = categories == null ? null : [...new Set(categories)].sort();
  const a = afterSeq == null ? null : afterSeq;
  const u = audience === "owner" ? "owner" : "lead";
  if (order !== "desc") {
    return sha256Base64url(JSON.stringify({ c, a, u }));
  }
  return sha256Base64url(JSON.stringify({ c, a, u, o: "desc" }));
}

/**
 * Encode a cursor payload object into a canonical base64url token.
 * Canonical: keys in fixed order, no whitespace. Idempotent under re-encode.
 */
export function encodeActivityCursor(payload) {
  if (!payload || typeof payload !== "object") throw new Error("invalid cursor payload");
  const { v, r, s, n, f, p } = payload;
  if (v !== CURSOR_VERSION) throw new Error("unsupported cursor version");
  if (typeof r !== "string" || typeof s !== "string" || typeof f !== "string") {
    throw new Error("invalid cursor digests");
  }
  if (!Number.isInteger(n) || !Number.isInteger(p)) throw new Error("invalid cursor offsets");
  const json = `{"v":${v},"r":"${r}","s":"${s}","n":${n},"f":"${f}","p":${p}}`;
  const tok = base64url(Buffer.from(json, "utf8"));
  if (tok.length > CURSOR_MAX_CHARS) throw new Error("cursor too long");
  return tok;
}

/**
 * Decode and structurally validate a base64url cursor token, enforcing the
 * canonical encoding (rejects semantically-equal but non-canonical forms).
 * Does NOT perform runId/snapshot/view binding — that happens in
 * projectRunActivity which has the live runId + snapshot + view.
 */
export function decodeActivityCursor(token) {
  if (typeof token !== "string") throw new CursorRejectedError("invalid cursor: not a string");
  if (token.length === 0 || token.length > CURSOR_MAX_CHARS) throw new CursorRejectedError("invalid cursor length");
  if (!BASE64URL_RE.test(token)) throw new CursorRejectedError("invalid cursor: not base64url");
  let parsed;
  try {
    parsed = JSON.parse(base64urlDecode(token).toString("utf8"));
  } catch (e) {
    // base64urlDecode already throws CursorRejectedError for charset failures;
    // a JSON parse failure on otherwise-base64url bytes is also a malformed
    // cursor token → the same safe rejection signal.
    if (e instanceof CursorRejectedError) throw e;
    throw new CursorRejectedError("invalid cursor: not decodable JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new CursorRejectedError("invalid cursor: not an object");
  const { v, r, s, n, f, p } = parsed;
  if (v !== CURSOR_VERSION) throw new CursorRejectedError("unsupported cursor version");
  if (typeof r !== "string" || r.length !== DIGEST_B64_LEN) throw new CursorRejectedError("invalid cursor runId digest");
  if (typeof s !== "string" || s.length !== DIGEST_B64_LEN) throw new CursorRejectedError("invalid cursor snapshot digest");
  if (typeof f !== "string" || f.length !== DIGEST_B64_LEN) throw new CursorRejectedError("invalid cursor view digest");
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000) throw new CursorRejectedError("invalid cursor eventCount");
  if (!Number.isInteger(p) || p < 0 || p > 1_000_000) throw new CursorRejectedError("invalid cursor position");
  const allowed = new Set(["v", "r", "s", "n", "f", "p"]);
  for (const k of Object.keys(parsed)) {
    if (!allowed.has(k)) throw new CursorRejectedError("invalid cursor: unknown key");
  }
  // Canonical-form enforcement: re-encode the parsed payload and require it
  // equals the input token. Rejects any non-canonical encoding (reordered keys,
  // whitespace, etc.) — defense against tampered/foreign tokens.
  const recanonical = encodeActivityCursor({ v, r, s, n, f, p });
  if (recanonical !== token) throw new CursorRejectedError("invalid cursor: noncanonical");
  return { v, r, s, n, f, p };
}

// ===== Control-char sanitization (LF/TAB preserved) =====

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

/**
 * THE single dynamic-string safety path: redact → sanitize → bound.
 *
 * Every transcript-derived dynamic string that crosses output (ts, role,
 * message text, tool name, backend, state, label) goes through this one
 * helper: exact-secret redaction FIRST (a secret straddling a cap boundary is
 * already [REDACTED:NAME] before any slice), then C0/C1/DEL sanitization, then
 * the surrogate-safe bound. Fields with a stricter guarantee (terminal target
 * via the TERMINAL_STATES gate, unknown-event label via OTHER_EVENT_LABEL,
 * relative paths via safeFilePath) do NOT pass through here.
 */
function safeDynamicText(raw, redactor, max) {
  return boundText(raw, redactor, max).text;
}

/** Same path, but also reports whether the bound truncated the safe text. */
function boundText(raw, redactor, max) {
  const redacted = redactor.redactString(raw);
  const sanitized = sanitizeControls(redacted);
  const truncated = sanitized.length > max;
  return { text: truncated ? safeSliceUtf16(sanitized, 0, max) : sanitized, truncated };
}

// ===== Closed-set safe field derivations =====

function commandExitStatus(event) {
  const c = event.exitCode;
  if (c === 0) return "ok";
  if (Number.isInteger(c)) return "failed";
  return "unknown";
}

function safeFilePath(raw, redactor) {
  if (typeof raw !== "string" || raw.length === 0) return "[path_withheld]";
  // Redact FIRST (same order as safeDynamicText — a secret is replaced before
  // any sanitization/slice can mangle or straddle it).
  const redacted = redactor.redactString(raw);
  const s = sanitizeControls(redacted);
  // Absolute (windows drive / posix / UNC) or traversal → never cross.
  if (/^[A-Za-z]:[\\/]/.test(s)) return "[path_withheld]";
  if (s.startsWith("/") || s.startsWith("\\")) return "[path_withheld]";
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(s)) return "[path_withheld]";
  // Relative + safe: bound. Redaction happened BEFORE the cap so a secret
  // straddling the cap boundary cannot leak.
  return s.length <= ACTIVITY_PATH_CAP ? s : safeSliceUtf16(s, 0, ACTIVITY_PATH_CAP);
}

// Bookkeeping envelope types are NOT worker activity — skipped (never counted,
// never emitted). Unknown run.event kinds and any other non-bookkeeping type
// become a bounded `other` entry (label only, never the payload).
const SKIP_TYPES = new Set([
  "run.submitted",
  "run.started",
  "run.background_submitted",
  "session.created",
  "session.ended",
  "run.completed",
]);

/**
 * Classify one event into its activity category, or null to skip.
 * Shape-driven only (type/kind fields) — never branches on backend/runtime.
 */
function classifyEvent(event) {
  if (event === null || typeof event !== "object") return null;
  const t = event.type;
  // state_change surfaces TERMINAL facts only (matrix framing). Non-terminal
  // transitions (pending/running) are control-plane bookkeeping — skipped.
  if (t === "run.state_change") {
    return TERMINAL_STATES.includes(event.to) ? "state" : null;
  }
  if (t === "run.event") {
    const k = event.kind;
    if (k === "runtime_activity") return "runtime_status";
    if (k === "message" || k === "command" || k === "tool_use"
      || k === "tool_result" || k === "file_written") return k;
    return "other";
  }
  if (typeof t === "string" && SKIP_TYPES.has(t)) return null;
  // M12-16: correction lifecycle — a meaningful closed-set status (not the
  // opaque `other` sentinel). The prompt/body/reason never reach the surface.
  if (CORRECTION_TYPE_TO_STATUS[t]) return "correction";
  return "other";
}

/**
 * Build the closed-set safe entry for one event. Redaction is applied to the
 * FULL text/payload BEFORE excerpt/sanitization. Only safe fields are emitted.
 * Every transcript-derived dynamic string uses the uniform
 * safeDynamicText path or a stricter closed-set/sentinel.
 */
function buildEntry(event, category, redactor, textCap) {
  const ts = safeDynamicText(event.ts ?? "", redactor, ACTIVITY_TS_CAP);
  const seq = Number.isInteger(event.seq) ? event.seq : 0;
  switch (category) {
    case "message": {
      const role = safeDynamicText(event.role ?? "", redactor, ACTIVITY_ROLE_CAP);
      const parts = Array.isArray(event.parts) ? event.parts : [];
      const textParts = parts
        .filter((p) => p && p.type === "text" && typeof p.text === "string" && p.text.length > 0)
        .map((p) => p.text);
      const full = textParts.length > 0 ? textParts.join("\n") : "";
      // Uniform path: redact the FULL message, then sanitize, THEN excerpt.
      const { text: safe, truncated } = boundText(full, redactor, textCap);
      return { category, ts, seq, role, text: safe, truncated };
    }
    case "command":
      return { category, ts, seq, exitStatus: commandExitStatus(event) };
    case "tool_use":
      return {
        category, ts, seq,
        tool: safeDynamicText(event.tool ?? event.name ?? "unknown", redactor, ACTIVITY_TOOL_NAME_CAP),
      };
    case "tool_result":
      // tool_result.tool is often an opaque callId (unreliable) — emit isError only.
      return { category, ts, seq, isError: Boolean(event.isError) };
    case "file_written":
      return { category, ts, seq, path: safeFilePath(event.path, redactor) };
    case "runtime_status": {
      const status = RUNTIME_ACTIVITY_STATUSES.includes(event.status)
        ? event.status
        : "unknown";
      return { category, ts, seq, status };
    }
    case "state": {
      // Closed-set gate: classification only surfaces TERMINAL_STATES here;
      // the guard keeps the set closed even if the classifier ever widens.
      const to = TERMINAL_STATES.includes(event.to) ? event.to : OTHER_EVENT_LABEL;
      return { category, ts, seq, to, terminal: to !== OTHER_EVENT_LABEL };
    }
    case "correction": {
      // M12-16: closed-set status derived ONLY from the event type. correctionId
      // is a bounded Lead-authored id (redacted + sanitized + capped) surfaced
      // for correlation — it is NOT the prompt. The prompt/body/reason payload
      // is NEVER emitted (classifyEvent gates the type → status is always valid).
      const status = CORRECTION_TYPE_TO_STATUS[event.type] ?? "requested";
      return {
        category, ts, seq, status,
        correctionId: safeDynamicText(event.correctionId ?? "", redactor, ACTIVITY_LABEL_CAP),
      };
    }
    default: {
      // `other`: FIXED sentinel label. NEVER echoes the event's own type/kind
      // (arbitrary transcript text) and NEVER the payload.
      return { category: "other", ts, seq, label: OTHER_EVENT_LABEL };
    }
  }
}

// ===== Public projection entry point =====

/**
 * Project an untrusted read-only activity snapshot into a safe, validated,
 * paginated payload.
 *
 * @param {object} rawSnapshot — {events, agentId?, backend?, state?, terminal?} (UNTRUSTED)
 * @param {object} opts
 * @param {string} opts.runId — the caller-requested runId
 * @param {string} [opts.cursor] — opaque continuation token (null/undefined for page 1)
 * @param {string[]|null} [opts.categories] — closed-set category filter (null/undefined ≡ all)
 * @param {number} [opts.afterSeq] — only events with seq > afterSeq (null/undefined ≡ none)
 * @param {"lead"|"owner"} [opts.audience] — caps selector (default "lead")
 * @param {number} [opts.pageSize] — entries per page (default per audience;
 *        an explicitly provided invalid pageSize is REJECTED, never clamped)
 * @param {"asc"|"desc"} [opts.order] — closed-set entry order (default "asc").
 *        asc preserves every existing Lead behavior AND old asc cursor digest
 *        compatibility; desc gives latest-first Owner bootstrap. desc is
 *        cursor-bound, stable on an append-only frozen snapshot, and rejects
 *        cross-order/cross-audience/cross-run/filter cursors. desc NEVER changes
 *        the classifier, redaction-before-bound, caps, counts, or total — it
 *        only reverses the filtered safe-entry list before pagination. NOT
 *        exposed on the MCP run_activity tool (Lead view stays asc-only).
 * @param {object} [opts.env] — env for the secret redactor (default process.env)
 * @returns {object} safe payload: runId, agentId, backend, state, terminal,
 *                   scopeObservation (M12-14 advisory, from the frozen prefix),
 *                   counts, total, entries, pageSize, truncated, nextCursor
 */
export function projectRunActivity(rawSnapshot, {
  runId, cursor, categories, afterSeq, audience, pageSize, order, env,
} = {}) {
  if (!rawSnapshot || typeof rawSnapshot !== "object") throw new Error("invalid activity snapshot");
  if (!isValidRunId(runId)) throw new Error("invalid runId");
  if (!Array.isArray(rawSnapshot.events)) throw new Error("invalid activity snapshot: events must be an array");

  // Exact run binding (fail closed BEFORE any structured result): every object
  // event must carry runId exactly equal to the requested runId. Missing/
  // mismatched/conflicting envelope facts throw — no degrade-and-project.
  const events = rawSnapshot.events;
  assertEventsBoundToRunId(events, runId);

  // Closed-set category filter (null/undefined ≡ all). Validate membership.
  let catSet = null;
  if (categories !== undefined && categories !== null) {
    if (!Array.isArray(categories)) throw new Error("invalid categories filter");
    catSet = new Set();
    for (const c of categories) {
      if (!ACTIVITY_CATEGORIES.includes(c)) throw new Error("invalid activity category");
      catSet.add(c);
    }
    if (catSet.size === 0) catSet = null;
  }
  if (afterSeq !== undefined && afterSeq !== null) {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new Error("invalid afterSeq");
  }

  const isOwner = audience === "owner";
  const textCap = isOwner ? OWNER_TEXT_EXCERPT_CAP : LEAD_TEXT_EXCERPT_CAP;
  const pageDefault = isOwner ? OWNER_PAGE_DEFAULT : LEAD_PAGE_DEFAULT;
  // Reject invalid explicitly-provided pageSize rather than silently clamp:
  // the MCP schema already rejects out-of-range values, and a direct caller
  // must get an error, not a surprise page size (project convention: invalid
  // values are nulled/rejected, never clamped/masked).
  let size = pageDefault;
  if (pageSize !== undefined && pageSize !== null) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > PAGE_HARD_CAP) {
      throw new Error("invalid pageSize");
    }
    size = pageSize;
  }

  // Closed-set order (default asc). An invalid value is REJECTED, never
  // silently treated as asc (project convention: invalid values are rejected,
  // not masked). asc is byte-compatible with every existing cursor; desc is a
  // distinct, cursor-bound view.
  let ord = "asc";
  if (order !== undefined && order !== null) {
    if (order !== "asc" && order !== "desc") throw new Error("invalid order");
    ord = order;
  }

  const redactor = createSecretRedactor(env ?? process.env);

  // View digest (page-1 emission + continuation binding share this). Binds
  // audience + canonicalized unique sorted filter set + afterSeq + order, so a
  // Lead cursor can never be accepted by an owner view, and an asc cursor can
  // never be accepted by a desc view (or vice versa).
  const viewDigest = computeViewDigest(categories, afterSeq, audience, ord);

  // Cursor decode + binding (runId / frozen snapshot / view / position).
  let cursorObj = null;
  if (cursor !== undefined && cursor !== null) {
    cursorObj = decodeActivityCursor(cursor);
  }

  const liveCount = events.length;
  const liveDigest = computeRawEventDigest(events);
  let frozenEvents = events;
  let frozenDigest = liveDigest;

  if (cursorObj) {
    // Binding 1: runId (compare digest, never raw runId). M12-19: a mismatch is
    // a cross-run cursor → typed CursorRejectedError (structured recovery).
    if (cursorObj.r !== sha256Base64url(runId)) throw new CursorRejectedError("cursor runId mismatch");
    // Binding 2: raw-event snapshot prefix (append-only safe, mutation/shrink
    // fail closed). M12-19: a stale/snapshot-changed cursor → CursorRejectedError.
    if (liveCount === cursorObj.n) {
      if (cursorObj.s !== liveDigest) throw new CursorRejectedError("cursor snapshot mismatch");
    } else if (liveCount > cursorObj.n) {
      const prefix = events.slice(0, cursorObj.n);
      const prefixDigest = computeRawEventDigest(prefix);
      if (cursorObj.s !== prefixDigest) throw new CursorRejectedError("cursor snapshot prefix mismatch");
      frozenEvents = prefix;
      frozenDigest = cursorObj.s;
    } else {
      throw new CursorRejectedError("cursor snapshot shrunk");
    }
    // Binding 3: view (category filter + afterSeq). Different view → fail closed.
    // M12-19: a cross-view cursor → CursorRejectedError.
    if (cursorObj.f !== viewDigest) throw new CursorRejectedError("cursor view/filter mismatch");
  }

  // Build the ordered filtered safe-entry list from the FROZEN snapshot so
  // counts + pagination are stable across pages. The view filter (category +
  // afterSeq) narrows the set; counts describe exactly this filtered timeline.
  const allEntries = [];
  const counts = emptyCounts();
  for (const event of frozenEvents) {
    const category = classifyEvent(event);
    if (category === null) continue;
    if (catSet !== null && !catSet.has(category)) continue;
    if (afterSeq !== undefined && afterSeq !== null) {
      const s = Number.isInteger(event?.seq) ? event.seq : 0;
      if (!(s > afterSeq)) continue;
    }
    allEntries.push(buildEntry(event, category, redactor, textCap));
    counts[category] += 1;
  }
  const total = allEntries.length;

  // Closed-set entry order. desc reverses the filtered safe-entry list BEFORE
  // pagination so the Owner bootstrap is latest-first. counts/total describe the
  // SAME filtered timeline (order-independent); only the entry order differs.
  // The reversal is over the FROZEN snapshot's filtered entries, so it is
  // deterministic and append-only stable (a continuation cursor binds the frozen
  // prefix + the desc view, so the reversed page is stable across appends).
  const orderedEntries = ord === "desc" ? allEntries.slice().reverse() : allEntries;

  // Position binding + pagination.
  let start = 0;
  if (cursorObj) {
    start = cursorObj.p;
    // M12-19: an out-of-range continuation position → CursorRejectedError.
    if (start > total) throw new CursorRejectedError("cursor position out of range");
  }
  const end = Math.min(start + size, total);
  const pageEntries = orderedEntries.slice(start, end);
  const truncated = end < total;

  let nextCursor = null;
  if (truncated) {
    nextCursor = encodeActivityCursor({
      v: CURSOR_VERSION,
      r: sha256Base64url(runId),
      s: frozenDigest,
      n: frozenEvents.length,
      f: viewDigest,
      p: end,
    });
  }

  // M12-14: advisory scope observation over the SAME frozenEvents prefix that
  // drives the page/cursor above — a continuation cursor projects its frozen
  // prefix (append-only stable), while a fresh page-1 call observes the full
  // current snapshot. Facts only, fail-closed, never throws.
  const scopeObservation = projectScopeObservation(frozenEvents, {
    runId,
    terminal: Boolean(rawSnapshot.terminal),
    env,
  });

  return {
    runId,
    agentId: safeProjectAgentId(rawSnapshot.agentId),
    // backend/state are transcript-derived dynamic strings (not closed-set) —
    // uniform redact → sanitize → bound path.
    backend: safeDynamicText(rawSnapshot.backend ?? "unknown", redactor, ACTIVITY_LABEL_CAP),
    state: safeDynamicText(rawSnapshot.state ?? "unknown", redactor, ACTIVITY_LABEL_CAP),
    terminal: Boolean(rawSnapshot.terminal),
    scopeObservation,
    counts,
    total,
    entries: pageEntries,
    pageSize: size,
    truncated,
    nextCursor,
  };
}
