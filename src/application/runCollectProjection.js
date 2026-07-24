// src/application/runCollectProjection.js
//
// M11-4: SHARED safe-output projection + continuation (pagination) for run_collect.
//
// Both the MCP adapter (src/mcp/server.js) and the CLI adapter
// (src/commands/observe.js) MUST call projectCollectResult — neither may
// return the raw service output directly when operating in projection mode
// (MCP always; CLI when --format json / --cursor is used). The default CLI
// `collect <runId>` keeps its existing raw ops surface for back-compat.
//
// This module owns:
//   - exact-secret redaction of each full assistant message (BEFORE pagination,
//     so a secret spanning a page boundary is already [REDACTED] before slice);
//   - C0/C1/DEL control sanitization (LF/TAB preserved);
//   - per-page caps: ≤8 messages, ≤4000 chars/message, ≤12000 chars/page;
//   - evidenceCounts tally over the FULL snapshot (unchanged semantic);
//   - opaque base64url cursor codec + trust-boundary validation;
//   - snapshot stability: frozen-prefix replay protection (append-only safe,
//     mutation fail-closed).
//
// Architectural contract:
//   - No file I/O, no MCP SDK / zod / command imports.
//   - Reuses createSecretRedactor SSOT and node:crypto (already transitively
//     used by delivery.js). No new dependency.
//   - cursor contains ONLY digests + integers — never raw runId, sessionId,
//     serveUrl, cwd, prompt, path, secret, or worker text.

import { createHash } from "node:crypto";
import { createSecretRedactor } from "../secretRedaction.js";

// ===== Page bounds (must match the legacy projectCollectResult constants) =====

export const COLLECT_MAX_MESSAGES = 8;
export const COLLECT_MAX_TEXT_CHARS = 4000;
export const COLLECT_MAX_TOTAL_CHARS = 12000;

// ===== Cursor codec =====
//
// Token layout (canonical JSON, base64url, no padding):
//   {
//     "v": 1,                 // schema version
//     "r": "<runIdDigest>",   // sha256(runId).slice(0,16) base64url — 16 bytes
//     "s": "<snapDigest>",    // snapshot prefix digest (see computeSnapshotDigest)
//     "n": <eventCount>,      // snapshot prefix length (run.event count)
//     "m": <msgIdx>,          // assistant-message index in the snapshot
//     "o": <charOffset>       // intra-message char offset (0 at msg boundary)
//   }
//
// The token never carries raw runId, snapshot content, or text. A third party
// holding the token learns only two 16-byte digests and two integers.

const CURSOR_VERSION = 1;
const CURSOR_MAX_CHARS = 192;
const DIGEST_BYTES = 16; // 128-bit digests — enough binding, compact token

// base64url alphabet (RFC 4648 §5) — no '=' padding.
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str) {
  if (typeof str !== "string" || str.length === 0 || !BASE64URL_RE.test(str)) {
    throw new Error("invalid cursor: not base64url");
  }
  // Convert base64url → base64, pad to multiple of 4.
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function sha256Base64url(input) {
  return base64url(createHash("sha256").update(input, "utf8").digest().subarray(0, DIGEST_BYTES));
}

/**
 * Compute a 128-bit snapshot digest over the COMPLETE worker-authored raw
 * item sequence (every kind: message, command, tool_use, tool_result,
 * file_written, unknown). The same algorithm runs for process and serve
 * paths — it is shape-driven (operates on the raw item list), NOT
 * runtime-name-driven. No branching by backend in shared code.
 *
 * M11-4 CTO rework (Fix C): the OLD digest only covered redacted assistant
 * text, so adding command/tool/file events after page 1 was invisible to
 * the cursor — evidenceCounts/itemCount drifted (RED-2). The NEW digest
 * covers every raw item so ANY mutation of the snapshot (new evidence,
 * edited message, deleted event) changes the digest and fails the cursor
 * binding closed.
 *
 * Each item is canonicalized to a stable string form (kind + sorted
 * non-sensitive keys) before hashing. Sensitive fields (command argv, tool
 * input/output, file path) are INCLUDED in the digest input — the digest
 * never leaves the server (it's a 16-byte hash in the cursor), so including
 * them does not leak data, and excluding them would let evidence silently
 * change without invalidating the cursor.
 *
 * Exported as computeSnapshotDigestForTest so tests can forge valid-shape
 * tokens to exercise the deeper position/binding checks. Not intended for
 * production callers — the projection layer is the only consumer.
 *
 * @param {Array<object>} rawItems — the full reconstructed item list
 * @returns {string} base64url digest (16 bytes)
 */
export function computeSnapshotDigestForTest(rawItems) {
  return computeRawSnapshotDigest(rawItems);
}

function computeRawSnapshotDigest(rawItems) {
  const hash = createHash("sha256");
  const items = Array.isArray(rawItems) ? rawItems : [];
  for (const item of items) {
    // Canonicalize: stable key order, deterministic value serialization.
    // kind is the primary discriminator; the full JSON of the item (sorted
    // keys) captures every field. Length-prefixed framing prevents
    // concatenation ambiguity.
    const canon = canonicalizeItem(item);
    hash.update(String(canon.length));
    hash.update("\u241f"); // unit separator frame
    hash.update(canon, "utf8");
  }
  return base64url(hash.digest().subarray(0, DIGEST_BYTES));
}

/**
 * Canonicalize a raw item into a deterministic string for digesting.
 * Uses JSON.stringify with a stable key order (sorted recursively) so the
 * same logical item always produces the same digest input regardless of
 * key insertion order.
 */
function canonicalizeItem(item) {
  if (item === null || typeof item !== "object") return JSON.stringify(item);
  const sorted = sortKeysDeep(item);
  return JSON.stringify(sorted);
}

function sortKeysDeep(obj) {
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  if (obj === null || typeof obj !== "object") return obj;
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = sortKeysDeep(obj[k]);
  return sorted;
}

/**
 * Encode a cursor payload object into a canonical base64url token.
 * Canonical: keys in fixed order, no whitespace. Idempotent under re-encode.
 *
 * @param {object} payload — {v, r, s, n, m, o}
 * @returns {string} base64url token ≤192 chars
 */
export function encodeCollectCursor(payload) {
  if (!payload || typeof payload !== "object") throw new Error("invalid cursor payload");
  const { v, r, s, n, m, o } = payload;
  if (v !== CURSOR_VERSION) throw new Error("unsupported cursor version");
  if (typeof r !== "string" || typeof s !== "string") throw new Error("invalid cursor digests");
  if (!Number.isInteger(n) || !Number.isInteger(m) || !Number.isInteger(o)) {
    throw new Error("invalid cursor offsets");
  }
  // Canonical JSON — fixed key order, no spaces.
  const json = `{"v":${v},"r":"${r}","s":"${s}","n":${n},"m":${m},"o":${o}}`;
  const tok = base64url(Buffer.from(json, "utf8"));
  if (tok.length > CURSOR_MAX_CHARS) throw new Error("cursor too long");
  return tok;
}

/**
 * Decode and structurally validate a base64url cursor token.
 * Does NOT perform runId/snapshot binding — that happens in projectCollectResult
 * which has the live runId + snapshot. Only structural validation here.
 *
 * @param {string} token
 * @returns {object} {v, r, s, n, m, o}
 */
export function decodeCollectCursor(token) {
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
  const { v, r, s, n, m, o } = parsed;
  if (v !== CURSOR_VERSION) throw new Error("unsupported cursor version");
  if (typeof r !== "string" || r.length !== 22) throw new Error("invalid cursor runId digest"); // 16 bytes → 22 b64url chars
  if (typeof s !== "string" || s.length !== 22) throw new Error("invalid cursor snapshot digest");
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000) throw new Error("invalid cursor eventCount");
  if (!Number.isInteger(m) || m < 0 || m > 1_000_000) throw new Error("invalid cursor msgIdx");
  // Offset is the absolute intra-message position — it can exceed the
  // per-page total cap when a single message is longer than 12000 chars
  // (pagination resumes mid-message across many pages). Bound it to a
  // generous absolute ceiling that still fits the 192-char token budget.
  const MAX_MSG_OFFSET = 1_000_000;
  if (!Number.isInteger(o) || o < 0 || o > MAX_MSG_OFFSET) throw new Error("invalid cursor charOffset");
  // Reject extra keys — no silent passthrough.
  const allowed = new Set(["v", "r", "s", "n", "m", "o"]);
  for (const k of Object.keys(parsed)) {
    if (!allowed.has(k)) throw new Error("invalid cursor: unknown key");
  }
  return { v, r, s, n, m, o };
}

// ===== Control-char sanitization =====
//
// LF (\n, 0x0A) and TAB (\t, 0x09) are preserved (legitimate formatting in
// assistant text). All other C0 (0x00-0x1F except \t \n), DEL (0x7F), and
// C1 (0x80-0x9F) are replaced with U+FFFD REPLACEMENT CHARACTER so they
// cannot corrupt downstream JSON/terminal parsers or smuggle control into
// the model context. Applied AFTER redaction, BEFORE pagination slicing.

// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

function sanitizeControls(text) {
  // String.replace with a regex containing the global flag advances lastIndex
  // correctly per spec; this is safe (no stateful reuse).
  return String(text).replace(UNSAFE_CONTROL_RE, "\uFFFD");
}

// ===== Assistant-text extraction (shared by both paths) =====
//
// Walk the raw items, classify each into evidenceCounts, and extract the
// list of assistant-authored text strings (already redacted + sanitized).
// This list is the pagination substrate; evidenceCounts covers the full set.
//
// Returns { evidenceCounts, redactedTexts, itemCount }.

function extractAssistantTexts(rawResult, redactor) {
  const items = Array.isArray(rawResult.data) ? rawResult.data : [];
  const evidenceCounts = { message: 0, command: 0, toolUse: 0, toolResult: 0, fileWritten: 0, other: 0 };
  const redactedTexts = [];

  for (const item of items) {
    const kind = item?.kind;
    const isServeMessage = !kind && item?.info && Array.isArray(item.parts);
    if (kind === "message" || isServeMessage) evidenceCounts.message += 1;
    else if (kind === "command") evidenceCounts.command += 1;
    else if (kind === "tool_use") evidenceCounts.toolUse += 1;
    else if (kind === "tool_result") evidenceCounts.toolResult += 1;
    else if (kind === "file_written") evidenceCounts.fileWritten += 1;
    else evidenceCounts.other += 1;

    if (kind !== "message" && !isServeMessage) continue;
    const role = item.role ?? item.info?.role;
    if (role !== "assistant") continue;

    const parts = Array.isArray(item.parts) ? item.parts : [];
    const textParts = parts
      .filter((p) => p && p.type === "text" && typeof p.text === "string" && p.text.length > 0)
      .map((p) => p.text);
    if (textParts.length === 0) continue;

    // Redact the FULL message before any pagination. Sanitize controls after.
    const redacted = sanitizeControls(redactor.redactString(textParts.join("\n")));
    redactedTexts.push(redacted);
  }

  return { evidenceCounts, redactedTexts, itemCount: items.length };
}

// ===== Pagination =====
//
// Given the full list of redacted assistant texts and a starting position
// (msgIdx, charOffset), produce one page of ≤8 messages, ≤4000 chars each,
// ≤12000 chars total. Returns { messages, pageTruncated, endMsgIdx, endOffset,
// hasMore }.
//
// `hasMore` is true iff there is any unread text (either we stopped mid-message
// or there are more messages after endMsgIdx).

function paginate(redactedTexts, startMsgIdx, startOffset) {
  const messages = [];
  let totalChars = 0;
  let pageTruncated = false;
  let msgIdx = startMsgIdx;
  let offset = startOffset;

  while (msgIdx < redactedTexts.length && messages.length < COLLECT_MAX_MESSAGES) {
    const full = redactedTexts[msgIdx];
    const remaining = full.length - offset;
    if (remaining <= 0) {
      // Defensive: should not happen (offset only set to full.length when
      // advancing). Skip to next message.
      msgIdx += 1;
      offset = 0;
      continue;
    }

    // Per-message cap (4000 chars from current offset).
    const perSlice = remaining > COLLECT_MAX_TEXT_CHARS ? COLLECT_MAX_TEXT_CHARS : remaining;
    const perTruncated = perSlice < remaining;

    // Total-page cap (12000 chars across all messages on this page).
    const budgetLeft = COLLECT_MAX_TOTAL_CHARS - totalChars;
    if (budgetLeft <= 0) {
      pageTruncated = true;
      break;
    }
    let take = perSlice;
    let totalHit = false;
    if (take > budgetLeft) {
      take = budgetLeft;
      totalHit = true;
    }

    // UTF-16-safe slicing: never split a surrogate pair. If the char at
    // `offset + take` is a high surrogate, back up by one so the pair stays
    // intact on the next page. (Standard string slice operates on UTF-16
    // code units; a lone surrogate would corrupt the output.)
    const text = safeSliceUtf16(full, offset, offset + take);

    messages.push({ role: "assistant", text, truncated: perTruncated || totalHit });
    totalChars += text.length;
    if (perTruncated || totalHit) pageTruncated = true;

    offset += text.length;
    if (offset >= full.length) {
      msgIdx += 1;
      offset = 0;
    }
    if (totalHit) break; // budget exhausted; next page continues here or later
  }

  // If the loop exited at the 8-message cap while there are still messages
  // to read, this page cut something → truncated (legacy semantic).
  if (messages.length >= COLLECT_MAX_MESSAGES && msgIdx < redactedTexts.length) {
    pageTruncated = true;
  }

  const consumedAllMessages = msgIdx >= redactedTexts.length;
  const atMessageBoundary = offset === 0;
  const hasMore = !consumedAllMessages || !atMessageBoundary;

  // If we stopped because of the message-count cap or page-truncate, the
  // resume position is (msgIdx, offset). If we naturally finished, no resume.
  return {
    messages,
    pageTruncated,
    endMsgIdx: hasMore ? msgIdx : redactedTexts.length,
    endOffset: hasMore ? offset : 0,
    hasMore,
  };
}

/**
 * UTF-16-safe slice: if slicing would land between a surrogate pair, shorten
 * the slice by one code unit so the pair is not split. The dropped code unit
 * moves to the next page.
 */
function safeSliceUtf16(str, start, end) {
  let adjustedEnd = end;
  if (adjustedEnd < str.length) {
    const cc = str.charCodeAt(adjustedEnd - 1);
    if (cc >= 0xD800 && cc <= 0xDBFF) {
      // The char just before adjustedEnd is a high surrogate; its low
      // surrogate is at adjustedEnd. Back up so neither half is split.
      adjustedEnd -= 1;
    }
  }
  return str.slice(start, adjustedEnd);
}

// ===== Public projection entry point =====

/**
 * Project an untrusted collect service result into a safe, validated,
 * paginated payload.
 *
 * @param {object} rawResult — {data, reconstructed?, backend?} (UNTRUSTED)
 * @param {object} opts
 * @param {string} opts.runId — the caller-requested runId
 * @param {string} [opts.cursor] — opaque continuation token (null/undefined for page 1)
 * @param {object} [opts.env] — env for the secret redactor (default: process.env)
 * @returns {object} safe payload with messages, evidenceCounts, itemCount,
 *                   truncated, nextCursor (null | opaque token)
 */
export function projectCollectResult(rawResult, { runId, cursor, env } = {}) {
  if (!rawResult || typeof rawResult !== "object") throw new Error("invalid collect result");
  if (!runId || typeof runId !== "string") throw new Error("runId required");
  // M11-8B: canonical agentId from the transcript envelope, threaded by the
  // collect service. Defensive: a non-string/empty value collapses to
  // "unknown" so the projection never fabricates or omits identity. This is
  // data carried verbatim — the agentId is a registry id (closed vocabulary),
  // not worker free-text, so it cannot carry prompt-injection control.
  const agentId = typeof rawResult.agentId === "string" && rawResult.agentId.length > 0
    ? rawResult.agentId
    : "unknown";
  // Fix A (CTO rework): the service MUST hand the projection layer the full
  // raw item list. A non-array data is a contract violation — fail closed
  // rather than silently treating it as an empty snapshot (which masks
  // service bugs and lets projection succeed when it should not).
  if (!Array.isArray(rawResult.data)) throw new Error("invalid collect result: data must be an array");

  const redactor = createSecretRedactor(env ?? process.env);
  const rawItems = rawResult.data;

  // Decode + validate cursor (if any). Structural only; binding below.
  let cursorObj = null;
  if (cursor !== undefined && cursor !== null) {
    cursorObj = decodeCollectCursor(cursor);
  }

  // M11-4 CTO rework (Fix C): snapshot binding now covers the COMPLETE raw
  // item sequence (every kind), not just assistant text. The cursor's `n`
  // is the raw item count at page-1 time. On continuation:
  //   (a) liveRawCount === cursorObj.n → compare full raw digest directly.
  //   (b) liveRawCount > cursorObj.n   → snapshot grew (append-only); slice
  //       raw items to the frozen prefix, recompute digest, compare. Any
  //       mutation of history (new evidence inserted, edited message) changes
  //       the prefix digest → fail closed.
  //   (c) liveRawCount < cursorObj.n   → history shrank → fail closed.
  // After binding, the frozen prefix is what drives BOTH evidenceCounts and
  // pagination — so adding command/tool/file events after page 1 can NEVER
  // drift the statistics (RED-2 fix).
  const liveRawDigest = computeRawSnapshotDigest(rawItems);
  const liveRawCount = rawItems.length;

  let frozenItems = rawItems;
  let frozenRawCount = liveRawCount;
  let frozenRawDigest = liveRawDigest;

  if (cursorObj) {
    // Binding check 1: runId. Compare digest, never raw runId.
    const expectedRunIdDigest = sha256Base64url(runId);
    if (cursorObj.r !== expectedRunIdDigest) {
      throw new Error("cursor runId mismatch");
    }

    // Binding check 2: raw snapshot prefix.
    if (liveRawCount === cursorObj.n) {
      if (cursorObj.s !== liveRawDigest) throw new Error("cursor snapshot mismatch");
    } else if (liveRawCount > cursorObj.n) {
      const prefix = rawItems.slice(0, cursorObj.n);
      const prefixDigest = computeRawSnapshotDigest(prefix);
      if (cursorObj.s !== prefixDigest) throw new Error("cursor snapshot prefix mismatch");
      frozenItems = prefix;
      frozenRawCount = cursorObj.n;
      frozenRawDigest = cursorObj.s;
    } else {
      throw new Error("cursor snapshot shrunk");
    }
  }

  // Extract assistant texts + evidenceCounts from the FROZEN snapshot so
  // statistics are stable across pages. (For page 1, frozenItems === rawItems.)
  const { evidenceCounts, redactedTexts } = extractAssistantTexts({ data: frozenItems }, redactor);
  const itemCount = frozenRawCount;

  let startMsgIdx = 0;
  let startOffset = 0;

  if (cursorObj) {
    // Binding check 3: position validity. m is the assistant-message index
    // (not raw item index) — pagination only walks assistant texts. The
    // cursor was emitted only when hasMore=true, so the resume position is
    // strictly inside the frozen assistant-text sequence.
    startMsgIdx = cursorObj.m;
    startOffset = cursorObj.o;
    if (startMsgIdx >= redactedTexts.length) {
      throw new Error("cursor position at or past frozen assistant-text end");
    }
    const msgAtPos = redactedTexts[startMsgIdx];
    if (startOffset > msgAtPos.length) {
      throw new Error("cursor offset beyond message length");
    }
  }

  const page = paginate(redactedTexts, startMsgIdx, startOffset);

  // Build nextCursor if there is more to read. The cursor binds to the
  // FROZEN raw snapshot (n = raw item count, s = raw digest) so evidence
  // stability is guaranteed across pages.
  let nextCursor = null;
  if (page.hasMore) {
    nextCursor = encodeCollectCursor({
      v: CURSOR_VERSION,
      r: sha256Base64url(runId),
      s: frozenRawDigest,
      n: frozenRawCount,
      m: page.endMsgIdx,
      o: page.endOffset,
    });
  }

  return {
    runId,
    agentId,
    backend: rawResult.backend ?? "unknown",
    reconstructed: Boolean(rawResult.reconstructed),
    itemCount,
    messages: page.messages,
    evidenceCounts,
    truncated: page.pageTruncated,
    nextCursor,
  };
}
