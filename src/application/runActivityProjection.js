// src/application/runActivityProjection.js
//
// M12-8 Package A: SHARED read-only activity timeline projector.
//
// Both the Lead-view MCP tool (run_activity, via src/mcp/server.js) and the
// internal owner view call projectRunActivity. Neither may return raw service
// output. The projector owns:
//   - shape-driven classification of every transcript event into a closed set
//     of 7 activity categories (NO backend/runtime branching);
//   - exact-secret redaction of each full text/payload BEFORE sanitization,
//     excerpt, and pagination (a secret spanning an excerpt or page boundary is
//     already [REDACTED] before any slice);
//   - C0/C1/DEL control sanitization (LF/TAB preserved);
//   - closed-set safe activity facts ONLY — never raw command text, tool input,
//     tool output, error text, credentials, PID/session id, absolute path, or
//     unknown payload; NO semantic summary/recommendation/progress estimate;
//   - per-page caps (entries + text excerpt) bounded per audience;
//   - opaque base64url cursor codec binding runId digest + frozen raw-snapshot
//     digest + event count + view (filter+afterSeq) digest + position;
//   - frozen-prefix replay protection: append-only safe, mutation/shrink/
//     cross-run/cross-filter/malformed/noncanonical/oversized/out-of-range all
//     fail closed.
//
// Architectural contract:
//   - No file I/O, no MCP SDK / zod / command imports.
//   - Reuses createSecretRedactor SSOT, safeProjectAgentId SSOT, and the
//     TERMINAL_STATES closed set from transcript.js. The cursor/digest/
//     sanitize helpers are re-implemented locally (mirroring the collect
//     projection's proven algorithm) so this module stays self-contained and
//     the collect projection is not perturbed (zero regression risk).
//   - The cursor carries ONLY digests + integers — never raw runId, sessionId,
//     serveUrl, cwd, prompt, path, secret, or worker text.

import { createHash } from "node:crypto";

import { createSecretRedactor } from "../secretRedaction.js";
import { safeProjectAgentId } from "../canonicalAgentId.js";
import { TERMINAL_STATES } from "../transcript.js";

// ===== Closed-set activity categories (drives BOTH the service and the MCP
// input schema — single source, no drift). =====

export const ACTIVITY_CATEGORIES = Object.freeze([
  "message",
  "command",
  "tool_use",
  "tool_result",
  "file_written",
  "state",
  "other",
]);

function emptyCounts() {
  return { message: 0, command: 0, tool_use: 0, tool_result: 0, file_written: 0, state: 0, other: 0 };
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

const ROLE_CAP = 32;
const LABEL_CAP = 64;
const TOOL_NAME_CAP = 64;
const PATH_CAP = 256;
const TS_CAP = 64;

// ===== Cursor codec =====
//
// Token layout (canonical JSON, base64url, no padding):
//   {
//     "v": 1,                 // schema version
//     "r": "<runIdDigest>",   // sha256(runId).slice(0,16) base64url — 16 bytes
//     "s": "<snapDigest>",    // raw-event snapshot prefix digest
//     "n": <eventCount>,      // raw-event count of the frozen prefix
//     "f": "<viewDigest>",    // digest of the view (category filter + afterSeq)
//     "p": <position>         // index into the filtered+ordered entry list
//   }
//
// Never carries raw runId, snapshot content, filter list, or text.

const CURSOR_VERSION = 1;
const CURSOR_MAX_CHARS = 256;
const DIGEST_BYTES = 16; // 128-bit digests — enough binding, compact token
const DIGEST_B64_LEN = 22; // ceil(16/3)*4 without padding → 22 base64url chars

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str) {
  if (typeof str !== "string" || str.length === 0 || !BASE64URL_RE.test(str)) {
    throw new Error("invalid cursor: not base64url");
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

// ===== View digest (category filter + afterSeq) =====
//
// Binds the continuation to the EXACT view page 1 used. A different category
// set or a different afterSeq is a different view → reject (cross-filter).
// null/undefined categories ≡ "all" (canonical null); a provided subset is the
// sorted joined list.

function computeViewDigest(categories, afterSeq) {
  const c = categories == null ? null : categories.slice().sort();
  const a = afterSeq == null ? null : afterSeq;
  return sha256Base64url(JSON.stringify({ c, a }));
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
  if (typeof token !== "string") throw new Error("invalid cursor: not a string");
  if (token.length === 0 || token.length > CURSOR_MAX_CHARS) throw new Error("invalid cursor length");
  if (!BASE64URL_RE.test(token)) throw new Error("invalid cursor: not base64url");
  let parsed;
  try {
    parsed = JSON.parse(base64urlDecode(token).toString("utf8"));
  } catch {
    throw new Error("invalid cursor: not decodable JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("invalid cursor: not an object");
  const { v, r, s, n, f, p } = parsed;
  if (v !== CURSOR_VERSION) throw new Error("unsupported cursor version");
  if (typeof r !== "string" || r.length !== DIGEST_B64_LEN) throw new Error("invalid cursor runId digest");
  if (typeof s !== "string" || s.length !== DIGEST_B64_LEN) throw new Error("invalid cursor snapshot digest");
  if (typeof f !== "string" || f.length !== DIGEST_B64_LEN) throw new Error("invalid cursor view digest");
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000) throw new Error("invalid cursor eventCount");
  if (!Number.isInteger(p) || p < 0 || p > 1_000_000) throw new Error("invalid cursor position");
  const allowed = new Set(["v", "r", "s", "n", "f", "p"]);
  for (const k of Object.keys(parsed)) {
    if (!allowed.has(k)) throw new Error("invalid cursor: unknown key");
  }
  // Canonical-form enforcement: re-encode the parsed payload and require it
  // equals the input token. Rejects any non-canonical encoding (reordered keys,
  // whitespace, etc.) — defense against tampered/foreign tokens.
  const recanonical = encodeActivityCursor({ v, r, s, n, f, p });
  if (recanonical !== token) throw new Error("invalid cursor: noncanonical");
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

function cap(text, max) {
  const s = sanitizeControls(text);
  return s.length <= max ? s : safeSliceUtf16(s, 0, max);
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
  const s = sanitizeControls(raw);
  // Absolute (windows drive / posix / UNC) or traversal → never cross.
  if (/^[A-Za-z]:[\\/]/.test(s)) return "[path_withheld]";
  if (s.startsWith("/") || s.startsWith("\\")) return "[path_withheld]";
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(s)) return "[path_withheld]";
  // Relative + safe: redact any embedded secret, then cap. Redaction happens
  // BEFORE the cap so a secret straddling the cap boundary cannot leak.
  const redacted = redactor.redactString(s);
  return redacted.length <= PATH_CAP ? redacted : safeSliceUtf16(redacted, 0, PATH_CAP);
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
    if (k === "message" || k === "command" || k === "tool_use"
      || k === "tool_result" || k === "file_written") return k;
    return "other";
  }
  if (typeof t === "string" && SKIP_TYPES.has(t)) return null;
  return "other";
}

/**
 * Build the closed-set safe entry for one event. Redaction is applied to the
 * FULL text/payload BEFORE excerpt/sanitization. Only safe fields are emitted.
 */
function buildEntry(event, category, redactor, textCap) {
  const ts = cap(event.ts ?? "", TS_CAP);
  const seq = Number.isInteger(event.seq) ? event.seq : 0;
  switch (category) {
    case "message": {
      const role = cap(event.role ?? "", ROLE_CAP);
      const parts = Array.isArray(event.parts) ? event.parts : [];
      const textParts = parts
        .filter((p) => p && p.type === "text" && typeof p.text === "string" && p.text.length > 0)
        .map((p) => p.text);
      const full = textParts.length > 0 ? textParts.join("\n") : "";
      // Redact the FULL message, then sanitize, THEN excerpt (truncation last).
      const safe = sanitizeControls(redactor.redactString(full));
      const truncated = safe.length > textCap;
      const text = truncated ? safeSliceUtf16(safe, 0, textCap) : safe;
      return { category, ts, seq, role, text, truncated };
    }
    case "command":
      return { category, ts, seq, exitStatus: commandExitStatus(event) };
    case "tool_use":
      return { category, ts, seq, tool: cap(event.tool ?? event.name ?? "unknown", TOOL_NAME_CAP) };
    case "tool_result":
      // tool_result.tool is often an opaque callId (unreliable) — emit isError only.
      return { category, ts, seq, isError: Boolean(event.isError) };
    case "file_written":
      return { category, ts, seq, path: safeFilePath(event.path, redactor) };
    case "state":
      return { category, ts, seq, to: cap(event.to ?? "", LABEL_CAP), terminal: TERMINAL_STATES.includes(event.to) };
    default: {
      // `other`: bounded label derived from the event's own type/kind name only.
      // NEVER echo the payload (command/input/output/error/deep fields).
      const label = cap(event.kind ?? event.type ?? "unknown", LABEL_CAP);
      return { category: "other", ts, seq, label };
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
 * @param {number} [opts.pageSize] — entries per page (default per audience; clamped to hard cap)
 * @param {object} [opts.env] — env for the secret redactor (default process.env)
 * @returns {object} safe payload: runId, agentId, backend, state, terminal,
 *                   counts, total, entries, pageSize, truncated, nextCursor
 */
export function projectRunActivity(rawSnapshot, {
  runId, cursor, categories, afterSeq, audience, pageSize, env,
} = {}) {
  if (!rawSnapshot || typeof rawSnapshot !== "object") throw new Error("invalid activity snapshot");
  if (!runId || typeof runId !== "string") throw new Error("runId required");
  if (!Array.isArray(rawSnapshot.events)) throw new Error("invalid activity snapshot: events must be an array");

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
  const size = clampInt(pageSize == null ? pageDefault : pageSize, 1, PAGE_HARD_CAP);

  const redactor = createSecretRedactor(env ?? process.env);
  const events = rawSnapshot.events;

  // View digest (page-1 emission + continuation binding share this).
  const viewDigest = computeViewDigest(categories, afterSeq);

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
    // Binding 1: runId (compare digest, never raw runId).
    if (cursorObj.r !== sha256Base64url(runId)) throw new Error("cursor runId mismatch");
    // Binding 2: raw-event snapshot prefix (append-only safe, mutation/shrink fail closed).
    if (liveCount === cursorObj.n) {
      if (cursorObj.s !== liveDigest) throw new Error("cursor snapshot mismatch");
    } else if (liveCount > cursorObj.n) {
      const prefix = events.slice(0, cursorObj.n);
      const prefixDigest = computeRawEventDigest(prefix);
      if (cursorObj.s !== prefixDigest) throw new Error("cursor snapshot prefix mismatch");
      frozenEvents = prefix;
      frozenDigest = cursorObj.s;
    } else {
      throw new Error("cursor snapshot shrunk");
    }
    // Binding 3: view (category filter + afterSeq). Different view → fail closed.
    if (cursorObj.f !== viewDigest) throw new Error("cursor view/filter mismatch");
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

  // Position binding + pagination.
  let start = 0;
  if (cursorObj) {
    start = cursorObj.p;
    if (start > total) throw new Error("cursor position out of range");
  }
  const end = Math.min(start + size, total);
  const pageEntries = allEntries.slice(start, end);
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

  return {
    runId,
    agentId: safeProjectAgentId(rawSnapshot.agentId),
    backend: cap(rawSnapshot.backend ?? "unknown", LABEL_CAP),
    state: cap(rawSnapshot.state ?? "unknown", LABEL_CAP),
    terminal: Boolean(rawSnapshot.terminal),
    counts,
    total,
    entries: pageEntries,
    pageSize: size,
    truncated,
    nextCursor,
  };
}

function clampInt(value, min, max) {
  if (!Number.isInteger(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
