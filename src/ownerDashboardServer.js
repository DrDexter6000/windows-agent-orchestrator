// src/ownerDashboardServer.js
//
// M12-8C Package C: ownerDashboardServer — a LOOPBACK-ONLY, read-only HTTP
// boundary that lets a local trusted Owner client observe worker runs in real
// time WITHOUT increasing Lead context cost. It is facts-only: it NEVER stops /
// retries / continues / repackages / decides, and performs NO semantic judgment.
// Every endpoint projects a bounded, read-only view of the Owner read model
// (which reuses the SINGLE application SSOTs).
//
// Trust boundary (enforced fail-closed, in order):
//   - Bind EXACTLY to 127.0.0.1 — any other host is rejected BEFORE listen.
//   - Port 0 (ephemeral) or an integer in 1024..65535 — anything else rejected
//     BEFORE listen.
//   - A random per-process bearer token is required for EVERY /api/* request.
//     Compared in constant time; never echoed in any body or header.
//   - GET only — every other method → 405 (Allow: GET). No CORS opt-in: OPTIONS
//     is NOT preflight-handled and never sets Access-Control-Allow-*.
//   - No client-supplied runDir / host. Server-owned paths are bound at
//     construction from the trusted process config, never from a query.
//   - Strict query bounds + closed-set parameters (project / runId / filter /
//     afterSeq / beforeSeq / limit / page / part) — any unknown key, repeated
//     key or out-of-range value → fixed 400, never a reflection of client input.
//   - The factory accepts ONLY the known config keys (CONFIG_KEYS); an unknown
//     key throws BEFORE any side effect, so a removed legacy key (workspaceRoot,
//     knownAgentIds, getOwnerRunsFn, getOwnerActivityFn, summaryCache, token)
//     cannot silently return.
//   - Any injected service error → fixed 500 {error:"internal"} — NEVER raw
//     exception text, path, token, prompt, command, PID, provider session, or
//     credential.
//   - Every route is a single-snapshot read — this server appends NO transcript
//     and mutates NO worktree.
//
// Batch 140c (decision 0131 §7): /api/overview, /api/workers and /api/attention
// read ONE in-memory publication built from the Owner read model.
//   - One refresh task drives the read model: once the server is listening, a
//     cold refresh, then a setTimeout chain at refreshIntervalMs (rounds never
//     overlap).
//   - Every successful round publishes { generatedAt, snapshot, attention } from
//     the SAME now; all three endpoints read that one publication, so their
//     counts agree. Status is the closed set loading | ready | stale |
//     unavailable: before the first round finishes it is "loading" (200, no data
//     — never "0 runs"); a failed round keeps the previous publication and flips
//     to "stale" (with the first failure time); never published and the latest
//     round failed → "unavailable" (with the first failure time). The error text
//     never crosses the boundary. Any failure (sync throw, rejection, bad clock,
//     snapshot/derivation throw) is a failed round and the chain still re-arms.
//     The clock is validated at the START of every round: a finite value outside
//     the Date range (or a non-finite one) fails the round before the read model
//     is snapshotted or anything is published. Within one failure streak
//     staleSince is set by the FIRST failed round only; if that round's clock is
//     unreadable it stays null until recovery — later rounds never back-fill it.
//   - close() is final and idempotent: repeated calls return the SAME promise
//     (already settled or still in flight). A late "listening" never starts the
//     chain, and after close() nothing is published or re-armed (refreshNow()
//     returns without touching the read model). close() still waits for an
//     in-flight round and for a pending listen() to settle, so a failed listen
//     (e.g. EADDRINUSE) never leaves close() hanging and a successful one is
//     always shut. listen() after close() rejects without opening a socket.
//   - DTOs are whitelists: rows, items, counts and lanes carry only the fields
//     the pages need — the snapshot is never passed through whole. Items carry
//     projectSlugs (an item may belong to more than one project); ?project=X
//     returns the items whose projectSlugs contain X, and Workers attentionIds
//     use the same filter.
//
// Batch 141a (decision 0131 §3): two more read-only routes for the Workers side
// panel of the new front end. Same bearer / GET-only / no-CORS / no-store / fixed
// error / closed-query rules as the read-model routes.
//   - GET /api/worker?runId=            one worker's detail DTO (ownerWorkerDetail):
//     identity, health, run axis, delivery axis, consult axis, deliverable, brief.
//     Authorization is the read model's resolveRun (the run belongs to this run
//     directory and its content is unambiguous) re-checked at REQUEST time against
//     the files on disk (readRunEvents: every copy is inside the real run directory
//     — a junction/symlink out of it is refused — and all copies are identical);
//     anything else answers the fixed 404 and echoes nothing. Before the first
//     publication it answers the status (loading), like the three read-model routes.
//     The DTO is a whitelist
//     assembled field by field — never a whole application object — and carries
//     no repository path, worktree path or unredacted secret.
//   - GET /api/artifact?runId=&commit=&fileIndex=   one image of the run's CURRENT
//     delivery, read from the Git object database only (never the working tree,
//     never a client path). `commit` must equal the run's current delivery commit
//     and `fileIndex` must index its changedFiles, so a changed candidate can never
//     make the same index point at another file. The transcript only CLAIMS the
//     delivery: the commit, its parent and the actual changed-file list are proven
//     against the repository first (createDeliveryProver), then the blob is read.
//     Only png / jpeg / webp by file structure (not just the prefix), bounded size;
//     everything else (incl. SVG) is the fixed 404.
//
// Batch 141c (decision 0131 §3, plan A3): two more read-only routes for the Activity
// tab of the Workers side panel. Same bearer / GET-only / no-CORS / no-store / fixed
// error / closed-query rules, same authorization (loadWorkerSource: the read model's
// resolveRun + the request-time re-read of the transcript), same fixed 404 for a run
// that is not usable. Both are Owner-only projections (ownerWorkerActivity), separate
// from the Lead-side run_activity cursor / path / output contract, which is untouched.
//   - GET /api/worker/activity?runId=&afterSeq=&beforeSeq=&limit=&filter=
//     The latest `limit` (default and max 200) timeline events, or the page before
//     `beforeSeq`; `afterSeq` is a lower bound (only events with a greater seq) and can
//     be used alone or with `beforeSeq` (the latest page inside that interval). filter is
//     the closed set all | messages | commands | errors.
//     Before the first publication it answers the status (loading), like /api/worker.
//   - GET /api/worker/event?runId=&seq=&part=&page=
//     One page of the full text of `runId#seq` (part is the closed set command |
//     output | message | error; page is 1-based, optional, default 1). seq absent,
//     part not applicable to that event, page out of range, or nothing published
//     yet: the fixed 404 (like /api/artifact).
//   Every number is canonical decimal digits (no sign, no leading zeros, bounded
//   length); a missing required key, an extra key or a repeated key is the fixed 400.
//
// Batch 143a (decision 0131 A3): the /v2 Workers page and side panel read this server through the routes
// above; what changed here is small and closed.
//   - A /api/workers row's delivery summary now carries the current delivery commit (the snapshot's
//     bound fact, a canonical id or null; the page shortens it and searches by it) and its file count
//     (a number from the same bound delivery reference); the row carries its continuation round
//     ({ number, complete }, the same count the detail's delivery axis shows); a review seat's
//     consult summary carries the seat's own verdict q1 (closed set, only once it has answered).
//     Still no path, settle time, reverify chain or parent / root run id.
//   - The /v2 static files (and only they) answer with the base CSP plus ONE source: img-src also allows
//     blob:, because the panel shows a delivered image from a blob URL it made with the bearer. Every
//     other response (the redirect, JSON, images) keeps the base policy.
//
// Batch 143b (decision 0131 A3): two small, closed additions on the same read-only boundary.
//   - A /api/workers consult summary also carries `finished`: whether the WHOLE review group has ended
//     (every seat's run in a terminal state), so a lane filter that hides a still-starting seat cannot
//     move the group to Finished on the page. It is a boolean computed from the snapshot, never from the
//     rows that survived a filter.
//   - /api/worker's detail DTO carries `refSeq`: the event number of the run's own bound snapshot fact
//     the Copy ref should name (the failed run's terminal event, or the later capacity observation; the
//     decision / settle event of a delivery; the last real progress; else the terminal event). It stays
//     available after the attention item itself has left the 24-hour window; with no such fact it is
//     null and the page falls back to the bare run number. No new text, no path.
//
// Batch 144 (decision 0131 section 4): the Activity tab's event stream.
//   - GET /api/worker/stream?runId=&afterSeq=&cursor=&filter=   server-sent events over a long
//     response: text/event-stream, the safe headers with no-store. runId is required; afterSeq
//     (0 .. OWNER_SEQ_MAX), filter (the activity closed set) and cursor (an opaque transport
//     cursor of a fixed shape and length) are optional; anything else, a repeated key or a bad
//     shape is the fixed 400. Same bearer / GET-only / no-CORS rules as every /api route.
//     Authorization is the same as /api/worker/activity: the run is in the published snapshot as
//     "ok", and the transcript is located through the read model's request-time copy check
//     (locateRunTranscript) — anything else answers the fixed 404. Before the first publication
//     it answers the fixed 404 (like /api/worker/event). The frames and their content come from
//     src/application/ownerWorkerStream.js (projectWorkerActivity pages); this file only writes
//     the head and the fixed errors. A 503 says the service already holds its maximum number of
//     streams (the page falls back to polling). The authorization does not stop at the head: an
//     open stream asks again every read-model refresh (OWNER_STREAM_AUTH_MS) — the run still in the
//     published snapshot as "ok" (the check handed to the stream below) and its copies still
//     proving out — and a stream that fails it is told to reset and closed.
//   - close() first cuts every open stream (each one closes its watcher and timers), and only
//     then shuts the socket: the streams are long-lived responses that would otherwise hold
//     server.close() open.
//
// Batch 145a (decision 0131 §3): the legacy Owner UI is retired and /v2 is the one page.
//   - STATIC_ASSETS holds ONLY the /v2 files; src/owner-dashboard/{index.html,app.js,styles.css}
//     and the routes "/styles.css" / "/app.js" are gone.
//   - "/" and "/index.html" answer 302 with Location: /v2/, the same safe headers, an empty
//     body and no token. The browser keeps the URL fragment across a redirect, so an old
//     bookmarked /#token=… still lands on /v2/#token=… (the token never enters a query string
//     or the server log).
//   - The legacy-only data routes GET /api/runs and GET /api/activity (and their query
//     parsers, injectable services and run-summary cache) are deleted; the old paths are the
//     fixed 404 like any unknown route.
//   - V2_CSP is still the ONE relaxation (img-src blob:) for /v2 files only; every other
//     response keeps the base policy.
//
// Imports (the import-contract test in ownerDashboardServer.test.js pins it):
// node:http / node:crypto / node:url / node:fs / node:path, the Owner read model
// (createOwnerReadModel + OWNER_LIVENESS_VALUES), the Owner attention derivation
// (ownerAttention), the Owner worker detail (ownerWorkerDetail), activity projection
// (ownerWorkerActivity), the Activity event stream (ownerWorkerStream), artifact
// reader (ownerArtifact), the project slug shape (projectBuckets.SAFE_BUCKET_SLUG_RE)
// and the runId validator (delivery.isValidRunId). No second copy of any closed set
// lives here.

import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { URL, fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isValidRunId } from "./delivery.js";
import { createOwnerReadModel, OWNER_LIVENESS_VALUES } from "./application/ownerReadModel.js";
import { createSessionStore } from "./application/dashboardSession.js";
import { redeemStartCode, CODE_HEX_RE } from "./application/dashboardCodes.js";
import { deriveOwnerAttention, ownerLanes, selectOwnerWorkers } from "./application/ownerAttention.js";
import {
  createDeliveryProver,
  isCanonicalCommitId,
  isValidRepoRelativePath,
  readCommitImage,
} from "./application/ownerArtifact.js";
import { continuationRound, currentDelivery, projectWorkerDetail } from "./application/ownerWorkerDetail.js";
import {
  OWNER_ACTIVITY_FILTERS,
  OWNER_ACTIVITY_LIMIT_MAX,
  OWNER_EVENT_PARTS,
  OWNER_SEQ_MAX,
  createFullTextCache,
  projectWorkerActivity,
  projectWorkerEvent,
} from "./application/ownerWorkerActivity.js";
import { OWNER_STREAM_CURSOR_RE, createWorkerStreams } from "./application/ownerWorkerStream.js";
import { SAFE_BUCKET_SLUG_RE } from "./projectBuckets.js";

const LOOPBACK_HOST = "127.0.0.1";
const PORT_MIN = 1024;
const PORT_MAX = 65535;
const TOKEN_BYTES = 32; // 256-bit bearer → exactly 64 lowercase hex chars
// Issued token contract: derived from exactly 32 bytes → 64 lowercase hex.
const TOKEN_HEX_RE = /^[0-9a-f]{64}$/;
// Batch 140c: how often the Owner read model is refreshed (default), and the
// row cap of /api/workers (the response says truncated:true when exceeded).
const DEFAULT_REFRESH_INTERVAL_MS = 5000;
const WORKERS_ROWS_MAX = 500;

// The complete configuration surface (145a + 145b): the legacy-only knobs are gone. An unknown key
// must fail closed — a test or caller that still passes workspaceRoot / knownAgentIds / getOwnerRunsFn /
// getOwnerActivityFn / summaryCache / token would otherwise be silently ignored.
const CONFIG_KEYS = Object.freeze(new Set([
  "runDir", "env", "host", "port", "randomBytesFn", "nowFn", "loadAssetFn",
  "createReadModelFn", "createWorkerStreamsFn", "refreshIntervalMs",
  // 145b: the one-time start-code directory (persistent mode) and the session-store knobs.
  "codesDir", "sessionTtlMs", "sessionMax",
]));

/**
 * Issue the per-process bearer token. In production this is ALWAYS 32 bytes
 * from node:crypto's cryptographically secure randomBytes → exactly 64 lowercase
 * hex chars. The public arbitrary config.token knob was REMOVED; tests instead
 * inject a `randomBytesFn(size)` entropy source (same shape as crypto.randomBytes)
 * so they can both assert the deterministic bytes→hex contract and probe fail-closed
 * rejection of a malformed generator. The generator output is validated BEFORE any
 * server object or side effect: it must be a Buffer/Uint8Array of exactly 32 bytes,
 * and the derived token must match TOKEN_HEX_RE. Anything else throws fail-closed.
 */
function issueToken(randomBytesFn) {
  const rand = typeof randomBytesFn === "function" ? randomBytesFn : randomBytes;
  let raw;
  try {
    raw = rand(TOKEN_BYTES);
  } catch {
    throw new Error("invalid random source");
  }
  if (!Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) {
    throw new Error("invalid random source");
  }
  const bytes = Buffer.from(raw);
  if (bytes.length !== TOKEN_BYTES) {
    throw new Error("invalid random source");
  }
  const token = bytes.toString("hex");
  if (!TOKEN_HEX_RE.test(token)) {
    throw new Error("invalid token");
  }
  return token;
}

/**
 * 145b：签发一个 N 字节的十六进制随机串（nonce 一类身份值；不承载凭据语义）。
 * 与 issueToken 同一注入熵源、同一 fail-closed 纪律：不是 Buffer 或不足 N 字节抛错；
 * 注入源一次给多过 N 字节（测试的 32 字节定源）取前 N 字节。
 */
function issueHex(randomBytesFn, bytes) {
  const rand = typeof randomBytesFn === "function" ? randomBytesFn : randomBytes;
  let raw;
  try {
    raw = rand(bytes);
  } catch {
    throw new Error("invalid random source");
  }
  if (!Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) throw new Error("invalid random source");
  const buffer = Buffer.from(raw);
  if (buffer.length < bytes) throw new Error("invalid random source");
  const out = buffer.subarray(0, bytes).toString("hex");
  if (out.length !== bytes * 2 || !/^[0-9a-f]+$/.test(out)) throw new Error("invalid random source");
  return out;
}

// Fixed safe response bodies. Never raw text, never token, never path.
// `unavailable` (batch 144) is the 503 of the event stream: the service already holds its
// maximum number of streams.
const ERR = Object.freeze({
  unauthorized: { error: "unauthorized" },
  method_not_allowed: { error: "method_not_allowed" },
  not_found: { error: "not_found" },
  bad_request: { error: "bad_request" },
  unavailable: { error: "unavailable" },
  internal: { error: "internal" },
});

// Mandatory safe headers for EVERY response. No CORS opt-in (no ACAO / ACRM /
// ACAH). Strict same-origin CSP — the dashboard ships ONLY same-origin static
// assets (no inline scripts/styles, no remote assets, no fetch beyond /api/*).
// The single least-privilege exception is img-src data:, which permits the one
// inline data-image favicon so the browser never auto-requests /favicon.ico and
// never logs a CSP console error; no 'unsafe-inline'/'unsafe-eval' is granted.
const SAFE_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
});

// Batch 144: the head of an event stream — the same safe headers, with the content type of
// server-sent events (never cached).
const STREAM_HEADERS = Object.freeze({ ...SAFE_HEADERS, "content-type": "text/event-stream" });

// Batch 143a (decision 0131 A3): the /v2 files — and only they — carry ONE more image source:
// img-src also allows blob:, because the side panel reads a delivered image with the bearer
// (fetch), turns it into a blob URL for an <img> and revokes the URL when it is done. Nothing else
// is relaxed: same default-src, same base-uri / object-src / frame-ancestors, no script or style
// relaxation. Every JSON / image / redirect response keeps the policy above.
const V2_CSP = SAFE_HEADERS["content-security-policy"].replace("img-src 'self' data:", "img-src 'self' data: blob:");

// ===== Package D: the Owner read-only dashboard UI =====
//
// The server serves a CLOSED list of fixed static assets (the /v2 UI — 145a
// retired the legacy files).
// There is no second HTTP framework and no client-supplied path is ever read
// from disk: the request pathname is matched against a FIXED route→asset table
// whose bodies are preloaded ONCE at server creation. A request for any other
// path (including every traversal form, a case variant, an extra path level or
// an unlisted file name — the pathname is never used as a filesystem path)
// simply matches no key and falls through to the fixed 404.
//
// Batch 142 (decision 0131 A3): the Owner dashboard is served from "/v2" and
// "/v2/" (src/owner-dashboard/v2/index.html) plus one fixed route per module:
// src/owner-dashboard/v2/app.js, api.js, i18n.js, model.js, store.js, views.js,
// styles.css, activity.js, activityview.js, workers.js, detail.js, artifacts.js,
// workersview.js and sidebarview.js. "/v2/index.html" is NOT a route.
// 145a: "/" and "/index.html" are redirects to "/v2/" (LEGACY_REDIRECTS) and
// the legacy index.html / app.js / styles.css are no longer loaded or served.
// A /v2 file is served only when the RAW request path is clean (equal to the parsed
// pathname: no "." / ".." segments, no repeated slashes, no backslashes); see the handler.
//
// The assets are loaded relative to this module (src/owner-dashboard/), by the
// name written in `file` ("v2/app.js" is joined under that directory).
// Loading is EAGER and FAIL-CLOSED at createOwnerDashboardServer time: if any
// fixed asset is missing/unreadable the factory throws BEFORE any token is
// issued or socket opened — a dashboard that cannot serve its own UI never
// starts. Tests may inject `loadAssetFn(name)` to avoid the disk.
const STATIC_DIR = fileURLToPath(new URL("./owner-dashboard/", import.meta.url));
const HTML = "text/html; charset=utf-8";
const CSS = "text/css; charset=utf-8";
const JS = "text/javascript; charset=utf-8";
const STATIC_ASSETS = Object.freeze([
  { route: "/v2", file: "v2/index.html", type: HTML },
  { route: "/v2/", file: "v2/index.html", type: HTML },
  { route: "/v2/styles.css", file: "v2/styles.css", type: CSS },
  { route: "/v2/activity.js", file: "v2/activity.js", type: JS },
  { route: "/v2/activityview.js", file: "v2/activityview.js", type: JS },
  { route: "/v2/app.js", file: "v2/app.js", type: JS },
  { route: "/v2/api.js", file: "v2/api.js", type: JS },
  { route: "/v2/artifacts.js", file: "v2/artifacts.js", type: JS },
  { route: "/v2/detail.js", file: "v2/detail.js", type: JS },
  { route: "/v2/i18n.js", file: "v2/i18n.js", type: JS },
  { route: "/v2/model.js", file: "v2/model.js", type: JS },
  { route: "/v2/sidebarview.js", file: "v2/sidebarview.js", type: JS },
  { route: "/v2/store.js", file: "v2/store.js", type: JS },
  { route: "/v2/views.js", file: "v2/views.js", type: JS },
  { route: "/v2/workers.js", file: "v2/workers.js", type: JS },
  { route: "/v2/workersview.js", file: "v2/workersview.js", type: JS },
]);

// Batch 145a: the retired legacy entry. Both paths answer 302 to the one page.
// The body is empty and no token is ever written: the browser keeps the URL
// fragment across a redirect, so a bookmarked /#token=… still reaches
// /v2/#token=… and the token stays out of every query string and log line.
const LEGACY_REDIRECTS = Object.freeze(new Map([["/", "/v2/"], ["/index.html", "/v2/"]]));

// Preload the fixed assets into an immutable route→{body,type} map. The
// bodies are Buffers (exact bytes served verbatim; content-length is the byte
// length). A fixed map keyed by the EXACT pathname makes traversal impossible:
// "/../x", "/%2e", "/foo" match no key → 404, and no client input reaches fs.
function loadStaticAssets(loadAssetFn) {
  const read = typeof loadAssetFn === "function"
    ? loadAssetFn
    : (name) => readFileSync(join(STATIC_DIR, name));
  const map = new Map();
  for (const a of STATIC_ASSETS) {
    // Skip re-reading a file already loaded under another route (e.g. "/v2" and
    // "/v2/" share v2/index.html) — same bytes, one read.
    let body = null;
    for (const existing of map.values()) {
      if (existing.file === a.file) { body = existing.body; break; }
    }
    if (body === null) body = Buffer.from(read(a.file));
    if (!Buffer.isBuffer(body)) body = Buffer.from(body);
    map.set(a.route, { file: a.file, type: a.type, body });
  }
  return map;
}

// Strict query parse failures throw this sentinel; the handler maps it to 400.
class BadRequest extends Error {}

function sendJson(res, status, payload, extra) {
  const body = JSON.stringify(payload);
  for (const [k, v] of Object.entries(SAFE_HEADERS)) res.setHeader(k, v);
  res.setHeader("content-length", Buffer.byteLength(body));
  if (extra) for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.writeHead(status);
  res.end(body);
}

// Serve a preloaded fixed asset. Same strict safe headers as JSON (no-store /
// nosniff / no-referrer / strict CSP); only the content-type is overridden to
// the asset's real media type (required under nosniff). The body is the exact
// preloaded Buffer — no disk read, no client path, no reflection.
function sendAsset(res, asset) {
  for (const [k, v] of Object.entries(SAFE_HEADERS)) res.setHeader(k, v);
  if (asset.file.startsWith("v2/")) res.setHeader("content-security-policy", V2_CSP);
  res.setHeader("content-type", asset.type);
  res.setHeader("content-length", asset.body.length);
  res.writeHead(200);
  res.end(asset.body);
}

// Batch 145a: the retired legacy entry → the one page. Same safe headers, an
// empty body, and never a token: the browser carries the URL fragment across.
function sendRedirect(res, location) {
  for (const [k, v] of Object.entries(SAFE_HEADERS)) res.setHeader(k, v);
  res.setHeader("location", location);
  res.setHeader("content-length", 0);
  res.writeHead(302);
  res.end();
}

// Constant-time bearer comparison. Accepts ONLY the exact "Bearer <token>"
// form (single space, case-sensitive scheme). Length mismatch is rejected
// before timingSafeEqual (which requires equal-length buffers). The token is
// NEVER written to the response under any path.
function bearerOk(authHeader, expected) {
  if (typeof authHeader !== "string") return false;
  const sp = authHeader.indexOf(" ");
  if (sp < 0) return false;
  const scheme = authHeader.slice(0, sp);
  const rest = authHeader.slice(sp + 1);
  if (scheme !== "Bearer") return false; // case-sensitive, exact scheme
  if (rest.length === 0 || rest.includes(" ")) return false; // single value, no spaces
  const got = Buffer.from(rest);
  const want = Buffer.from(expected);
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

/** The value of a well-formed "Bearer <value>" header, else null (145b: /api/session 与流的复核取值)。 */
function bearerValue(authHeader) {
  if (typeof authHeader !== "string") return null;
  const sp = authHeader.indexOf(" ");
  if (sp < 0) return null;
  if (authHeader.slice(0, sp) !== "Bearer") return null;
  const rest = authHeader.slice(sp + 1);
  return rest.length === 0 || rest.includes(" ") ? null : rest;
}

/**
 * 145b：请求级 bearer 判定——进程令牌（前台/测试）或一个未过期的会话令牌
 * （常驻模式；timingSafeEqual 逐条扫描，见 dashboardSession）。
 */
function ctxAuth(ctx, authHeader) {
  if (bearerOk(authHeader, ctx.token)) return true;
  const value = bearerValue(authHeader);
  return value !== null && ctx.sessions.valid(value);
}

// Reject unknown keys AND repeated keys (strict, no reflection).
function assertStrictKeys(sp, allowed) {
  const seen = new Set();
  for (const key of sp.keys()) {
    if (!allowed.has(key)) throw new BadRequest();
    if (seen.has(key)) throw new BadRequest();
    seen.add(key);
  }
}

function parseBoundedInt(raw, min, max) {
  if (!/^-?\d+$/.test(raw)) throw new BadRequest();
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new BadRequest();
  return n;
}

// ===== Batch 140c: Overview / Workers / Attention — DTO whitelists =====
//
// The snapshot is already path-free (ownerReadModel), but the DTOs still pick
// fields explicitly: only own properties under the listed keys are copied, so a
// field that is not on the page's list can never reach the wire — not even by
// accident, and not from a hostile extra key on the in-memory object.
const COUNT_KEYS = Object.freeze(["running", "starting", "verifying", "deliveryUnobservable"]);
const ITEM_KEYS = Object.freeze([
  "id", "kind", "state", "runIds", "projectSlugs", "since", "resolvedAt", "resolution", "evidence",
  "laneKey", "capacityCode", "followUp", "failure",
  // 142 修正一：交付类事项的当前交付提交；会审事项的全部席位运行（牵涉的 worker）。
  "commit", "seatRunIds",
  // 142 修正二：failed 事项的后续运行（只给 runId 与当前 state）。
  "followUpRuns",
]);
const FOLLOW_UP_RUN_KEYS = Object.freeze(["runId", "state"]);
const CONSULT_KEYS = Object.freeze(["groupId", "seatsIn", "seatsTotal", "finished", "q1"]);
const EVIDENCE_KEYS = Object.freeze(["runId", "at", "seq"]);
const FAILURE_KEYS = Object.freeze(["category", "code"]);
const CAPACITY_KEYS = Object.freeze(["kind", "state", "observedAt"]);

function pick(source, keys) {
  const out = {};
  if (source === null || typeof source !== "object") return out;
  for (const key of keys) if (Object.hasOwn(source, key)) out[key] = source[key];
  return out;
}

// NOTE: no key-list array may contain a "status" element — the git-optional-locks
// guard (gitOptionalLocksGuard.test.js) reads ANY such array literal as a git
// status argument array. The whitelists that involve a status field are therefore
// written as explicit object fields below (same shape as ownerReadModel.projectDelivery).
const failureDto = (failure) => (failure === null || failure === undefined ? null : pick(failure, FAILURE_KEYS));
/** A `{ status }` projection; a missing fact stays null (never an empty object). */
const statusDto = (fact) => (fact === null || fact === undefined ? null : { status: fact.status });
const settlementDto = (settlement) => (settlement === null || settlement === undefined
  ? null
  : { status: settlement.status, reason: settlement.reason });

/** Counts of one scope (global or one project): the same field set for both. */
function countsDto(counts) {
  const out = pick(counts, COUNT_KEYS);
  out.liveness = pick(counts.liveness, OWNER_LIVENESS_VALUES);
  out.decide = pick(counts.decide, ["open", "unknown"]);
  out.anomalies = pick(counts.anomalies, ["open", "unknown"]);
  return out;
}

function itemDto(item) {
  const out = pick(item, ITEM_KEYS);
  if (out.failure !== undefined) out.failure = failureDto(item.failure);
  if (out.evidence !== undefined) out.evidence = item.evidence.map((entry) => pick(entry, EVIDENCE_KEYS));
  if (out.seatRunIds !== undefined) out.seatRunIds = [...item.seatRunIds];
  if (out.followUpRuns !== undefined) out.followUpRuns = item.followUpRuns.map((entry) => pick(entry, FOLLOW_UP_RUN_KEYS));
  return out;
}

/**
 * One /api/workers row. `round` is the continuation round of the run (continuationRound, the same
 * count the detail's delivery axis shows): a list card marks a continuation by it. Numbers only;
 * no parent / root run ids and no paths.
 */
function workerRowDto(row, round) {
  const run = row.run;
  const delivery = run.delivery;
  return {
    runId: run.runId,
    project: run.project === null || run.project === undefined ? null : pick(run.project, ["slug", "name"]),
    title: row.title,
    subtitle: row.subtitle,
    taskType: run.taskType,
    laneKey: row.laneKey,
    roleId: run.roleId,
    state: run.state,
    liveness: run.liveness,
    stage: run.stage,
    startedAt: run.startedAt,
    terminalAt: run.terminalAt,
    lastEffectAt: run.lastEffectAt,
    quietSince: run.quietSince,
    // Delivery summary only: the current delivery commit (the snapshot's bound fact, canonical id or
    // null; the page shortens it and searches it) and how many files it changed (a count, never a path),
    // no settle time, no reverify chain.
    delivery: delivery === null || delivery === undefined ? null : {
      commit: typeof delivery.commit === "string" && isCanonicalCommitId(delivery.commit) ? delivery.commit : null,
      changedCount: Number.isInteger(delivery.changedCount) && delivery.changedCount >= 0 ? delivery.changedCount : null,
      settlement: settlementDto(delivery.settlement),
      verification: statusDto(delivery.verification),
      acceptance: statusDto(delivery.acceptance),
      branchPresent: delivery.branchPresent,
    },
    round: { number: round.number, complete: round.complete },
    failure: failureDto(run.failure),
    attentionIds: [...row.attentionIds],
    // 会审席位所在组的摘要（几席已到 / 总席数）与本席已给出的结论 q1（闭集，没答复为 null）；不是会审席位就是 null。
    consult: row.consult === null || row.consult === undefined ? null : pick(row.consult, CONSULT_KEYS),
  };
}

// The three read-model routes: the closed set of query keys each accepts
// (empty = no parameters) and the DTO built from one publication. Every payload
// receives { pub, project, status }: pub is the publication, project the parsed
// slug filter (null = all projects), status the common { status, generatedAt,
// staleSince? } fields.
const READ_MODEL_ROUTES = new Map([
  ["/api/overview", {
    keys: [],
    payload: ({ pub, status }) => {
      const projectFacts = new Map(pub.snapshot.projects.map((p) => [p.slug, p]));
      return {
        ...status,
        counts: countsDto(pub.attention.counts),
        // One row per counted project (deriveOwnerAttention seeds every snapshot project).
        projects: pub.attention.counts.projects.map((entry) => {
          const facts = projectFacts.get(entry.slug);
          return {
            slug: entry.slug,
            name: facts?.name ?? null,
            repo: facts?.repo ?? "unknown",
            // repo 与观测时刻要一起读：才分得清"从没观测过"（null）与"上次观测失败"。
            branchesObservedAt: facts?.branchesObservedAt ?? null,
            consultRecords: facts?.consultRecords ?? "unknown",
            counts: countsDto(entry),
          };
        }),
        lanes: ownerLanes(pub.snapshot, pub.attention).map((lane) => ({
          laneKey: lane.laneKey,
          running: lane.running,
          capacity: lane.capacity === null ? null : pick(lane.capacity, CAPACITY_KEYS),
        })),
      };
    },
  }],
  ["/api/workers", {
    keys: ["project"],
    payload: ({ pub, project, status, runsById }) => {
      const rows = selectOwnerWorkers(pub.snapshot, pub.attention, { now: pub.now, project });
      return {
        ...status,
        truncated: rows.length > WORKERS_ROWS_MAX,
        workers: rows.slice(0, WORKERS_ROWS_MAX).map((row) => workerRowDto(row, continuationRound(row.run, runsById))),
      };
    },
  }],
  ["/api/attention", {
    keys: ["project"],
    payload: ({ pub, project, status }) => {
      // 事项带 projectSlugs（可跨项目）：/api/attention?project=X 只返回含 X 的事项。
      const inProject = (item) => project === null || item.projectSlugs.includes(project);
      return {
        ...status,
        decide: pub.attention.decide.filter(inProject).map(itemDto),
        anomalies: pub.attention.anomalies.filter(inProject).map(itemDto),
        resolved: pub.attention.resolved.filter(inProject).map(itemDto),
      };
    },
  }],
]);

// Serve one read-model route: bearer → strict query keys (+ slug shape) →
// loading → the current publication. The bearer is checked FIRST, so an
// unauthenticated caller learns nothing (not even the loading state).
function serveReadModelRoute(ctx, req, res, sp, route) {
  if (!ctxAuth(ctx, req.headers.authorization)) {
    return sendJson(res, 401, ERR.unauthorized);
  }
  let project = null;
  try {
    assertStrictKeys(sp, new Set(route.keys));
    if (sp.has("project")) {
      const raw = sp.get("project");
      if (!SAFE_BUCKET_SLUG_RE.test(raw)) throw new BadRequest();
      project = raw;
    }
  } catch (e) {
    if (!(e instanceof BadRequest)) return sendJson(res, 500, ERR.internal);
    return sendJson(res, 400, ERR.bad_request);
  }
  const pub = ctx.published();
  // Never published: "loading" (first round still running / not started) or "unavailable"
  // (never published and the latest round failed) — 200, no data, never "0 runs".
  if (pub === null) return sendJson(res, 200, ctx.status());
  try {
    return sendJson(res, 200, route.payload({ pub, project, status: ctx.status(), runsById: ctx.runsById(pub) }));
  } catch {
    return sendJson(res, 500, ERR.internal);
  }
}

// ===== Batch 141a: /api/worker and /api/artifact =====

// fileIndex: canonical decimal digits only (no sign, no leading zeros, ≤ 7 digits).
const FILE_INDEX_RE = /^(0|[1-9][0-9]{0,6})$/;

function parseWorkerQuery(sp) {
  assertStrictKeys(sp, new Set(["runId"]));
  const runId = sp.get("runId");
  if (!isValidRunId(runId)) throw new BadRequest();
  return { runId };
}

function parseArtifactQuery(sp) {
  assertStrictKeys(sp, new Set(["runId", "commit", "fileIndex"]));
  const runId = sp.get("runId");
  const commit = sp.get("commit");
  const rawIndex = sp.get("fileIndex");
  if (!isValidRunId(runId) || !isCanonicalCommitId(commit) || rawIndex === null || !FILE_INDEX_RE.test(rawIndex)) {
    throw new BadRequest();
  }
  return { runId, commit, fileIndex: Number(rawIndex) };
}

/**
 * The run's snapshot row + its transcript events as read just now — or null when
 * the run is not usable: not in the published snapshot, not "ok", or the read
 * model's resolveRun / read says no (unreadable, conflicting copies, not in this
 * run directory). Nothing about WHY crosses the boundary.
 */
async function loadWorkerSource(ctx, pub, runId, { withIdentity = false } = {}) {
  const model = ctx.readModel;
  const run = ctx.runsById(pub).get(runId);
  // The full-text route also needs the transcript's identity (content hash) for its cache key; a read
  // model without readRunTranscript simply gives no identity (the route then does not cache).
  if (withIdentity && typeof model?.readRunTranscript === "function") {
    if (run === undefined || run.availability !== "ok") return null;
    const transcript = await model.readRunTranscript(runId);
    return transcript === null ? null : { run, events: transcript.events, identity: transcript.identity };
  }
  if (typeof model?.readRunEvents !== "function") return null;
  if (run === undefined || run.availability !== "ok") return null;
  const events = await model.readRunEvents(runId);
  return events === null ? null : { run, events, identity: null };
}

/** The project's repository root, held server-side only (never in a response). */
function repoRootOf(ctx, run) {
  const slug = run.project?.slug;
  return typeof slug === "string" && typeof ctx.readModel?.projectRepoRoot === "function"
    ? ctx.readModel.projectRepoRoot(slug)
    : null;
}

/** Shared prologue of both routes: bearer → closed query. Returns the query, or null once it has answered. */
function authorizeAndParse(ctx, req, res, sp, parse) {
  if (!ctxAuth(ctx, req.headers.authorization)) {
    sendJson(res, 401, ERR.unauthorized);
    return null;
  }
  try {
    return parse(sp);
  } catch (e) {
    sendJson(res, e instanceof BadRequest ? 400 : 500, e instanceof BadRequest ? ERR.bad_request : ERR.internal);
    return null;
  }
}

async function serveWorker(ctx, req, res, sp) {
  const query = authorizeAndParse(ctx, req, res, sp, parseWorkerQuery);
  if (query === null) return;
  const pub = ctx.published();
  // Never published: same loading / unavailable answer as the read-model routes.
  if (pub === null) return sendJson(res, 200, ctx.status());
  try {
    const source = await loadWorkerSource(ctx, pub, query.runId);
    if (source === null) return sendJson(res, 404, ERR.not_found);
    const detail = await projectWorkerDetail({
      run: source.run,
      snapshot: pub.snapshot,
      runsById: ctx.runsById(pub),
      events: source.events,
      now: pub.now, // the SAME now the publication was built with
      ...(ctx.env !== undefined ? { env: ctx.env } : {}),
      repoRoot: repoRootOf(ctx, source.run),
      proveDelivery: ctx.proveDelivery,
    });
    return sendJson(res, 200, { ...ctx.status(), ...detail });
  } catch {
    return sendJson(res, 500, ERR.internal);
  }
}

// ===== Batch 141c: /api/worker/activity and /api/worker/event =====

// Canonical decimal digits only (no sign, no leading zeros, bounded length). The nine-digit bound is
// OWNER_SEQ_MAX (999999999) — the same bound the projection applies to the event numbers in a
// transcript, so a list never hands out an afterSeq / beforeSeq this route would reject.
const SEQ_RE = /^[1-9][0-9]{0,8}$/; // an event number: 1 .. OWNER_SEQ_MAX
const BEFORE_SEQ_RE = /^(0|[1-9][0-9]{0,8})$/; // 0 is allowed: "before everything" is an empty page
const LIMIT_RE = /^[1-9][0-9]{0,2}$/; // then bounded by OWNER_ACTIVITY_LIMIT_MAX
const PAGE_RE = /^[1-9][0-9]{0,5}$/; // 1-based page number

function parseWorkerActivityQuery(sp) {
  assertStrictKeys(sp, new Set(["runId", "afterSeq", "beforeSeq", "limit", "filter"]));
  const runId = sp.get("runId");
  if (!isValidRunId(runId)) throw new BadRequest();
  const query = { runId };
  if (sp.has("afterSeq")) {
    const raw = sp.get("afterSeq");
    if (!BEFORE_SEQ_RE.test(raw) || Number(raw) > OWNER_SEQ_MAX) throw new BadRequest();
    query.afterSeq = Number(raw);
  }
  if (sp.has("beforeSeq")) {
    const raw = sp.get("beforeSeq");
    if (!BEFORE_SEQ_RE.test(raw) || Number(raw) > OWNER_SEQ_MAX) throw new BadRequest();
    query.beforeSeq = Number(raw);
  }
  if (sp.has("limit")) {
    const raw = sp.get("limit");
    if (!LIMIT_RE.test(raw) || Number(raw) > OWNER_ACTIVITY_LIMIT_MAX) throw new BadRequest();
    query.limit = Number(raw);
  }
  if (sp.has("filter")) {
    const raw = sp.get("filter");
    if (!OWNER_ACTIVITY_FILTERS.includes(raw)) throw new BadRequest();
    query.filter = raw;
  }
  return query;
}

function parseWorkerEventQuery(sp) {
  assertStrictKeys(sp, new Set(["runId", "seq", "part", "page"]));
  const runId = sp.get("runId");
  const seq = sp.get("seq");
  const part = sp.get("part");
  if (!isValidRunId(runId) || seq === null || !SEQ_RE.test(seq) || Number(seq) > OWNER_SEQ_MAX || !OWNER_EVENT_PARTS.includes(part)) {
    throw new BadRequest();
  }
  const query = { runId, seq: Number(seq), part };
  if (sp.has("page")) {
    const raw = sp.get("page");
    if (!PAGE_RE.test(raw)) throw new BadRequest();
    query.page = Number(raw);
  }
  return query;
}

async function serveWorkerActivity(ctx, req, res, sp) {
  const query = authorizeAndParse(ctx, req, res, sp, parseWorkerActivityQuery);
  if (query === null) return;
  const pub = ctx.published();
  // Never published: same loading / unavailable answer as /api/worker.
  if (pub === null) return sendJson(res, 200, ctx.status());
  try {
    const source = await loadWorkerSource(ctx, pub, query.runId);
    if (source === null) return sendJson(res, 404, ERR.not_found);
    const page = projectWorkerActivity({
      runId: query.runId,
      events: source.events,
      ...(query.afterSeq !== undefined ? { afterSeq: query.afterSeq } : {}),
      ...(query.beforeSeq !== undefined ? { beforeSeq: query.beforeSeq } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.filter !== undefined ? { filter: query.filter } : {}),
      ...(ctx.env !== undefined ? { env: ctx.env } : {}),
    });
    return sendJson(res, 200, { ...ctx.status(), ...page });
  } catch {
    return sendJson(res, 500, ERR.internal);
  }
}

async function serveWorkerEvent(ctx, req, res, sp) {
  const query = authorizeAndParse(ctx, req, res, sp, parseWorkerEventQuery);
  if (query === null) return;
  const pub = ctx.published();
  if (pub === null) return sendJson(res, 404, ERR.not_found);
  try {
    const source = await loadWorkerSource(ctx, pub, query.runId, { withIdentity: true });
    if (source === null) return sendJson(res, 404, ERR.not_found);
    const full = projectWorkerEvent({
      runId: query.runId,
      events: source.events,
      seq: query.seq,
      part: query.part,
      cache: ctx.fullTextCache, // processed full texts, keyed by the transcript's content hash
      identity: source.identity,
      ...(query.page !== undefined ? { page: query.page } : {}),
      ...(ctx.env !== undefined ? { env: ctx.env } : {}),
    });
    if (full === null) return sendJson(res, 404, ERR.not_found);
    return sendJson(res, 200, { ...ctx.status(), ...full });
  } catch {
    return sendJson(res, 500, ERR.internal);
  }
}

// ===== Batch 145b: /api/session — the one-time start code exchange =====
//
// GET /api/session with the start code in the Authorization header (never a query string):
//   - strict loopback Host (127.0.0.1:<the port this server actually answers on>) and, when the
//     browser sends Sec-Fetch-Site, same-origin only;
//   - a missing/malformed header answers the fixed 401 WITHOUT touching the file system;
//   - exactly ONE file is probed per request (codes\<sha256(code)>): exists, fresh (60 s) and
//     unlinked atomically → a session token is issued { token, expiresAt }; anything else is
//     the fixed 401 (concurrent redemptions have exactly one winner);
//   - any query key at all is the fixed 400 (the closed-parameter rule of every data route).
// No codesDir configured (foreground / tests): always the fixed 401.
async function serveSession(ctx, req, res, sp) {
  const port = ctx.effectivePort();
  const host = req.headers.host;
  if (port === null || typeof host !== "string" || host !== `127.0.0.1:${port}`) {
    return sendJson(res, 401, ERR.unauthorized);
  }
  const secFetchSite = req.headers["sec-fetch-site"];
  if (secFetchSite !== undefined && secFetchSite !== "same-origin") {
    return sendJson(res, 401, ERR.unauthorized);
  }
  const code = bearerValue(req.headers.authorization);
  if (code === null || !CODE_HEX_RE.test(code)) {
    return sendJson(res, 401, ERR.unauthorized);
  }
  // 有查询串就 400：连一个裸的 “?” 也算（参数闭集是“完全没有查询”）。
  if (sp.size > 0 || String(req.url ?? "").split("#", 1)[0].includes("?")) {
    return sendJson(res, 400, ERR.bad_request);
  }
  if (ctx.redeem === null) return sendJson(res, 401, ERR.unauthorized);
  let redeemed = false;
  try {
    redeemed = await ctx.redeem(code) === true;
  } catch {
    redeemed = false;
  }
  if (!redeemed) return sendJson(res, 401, ERR.unauthorized);
  const session = ctx.sessions.issue();
  return sendJson(res, 200, { token: session.token, expiresAt: session.expiresAt });
}

// ===== Batch 144: /api/worker/stream =====

/**
 * GET /api/worker/stream?runId=&afterSeq=&cursor=&filter= — the Activity tab's event stream.
 * runId (required) and afterSeq / filter as on /api/worker/activity (beforeSeq and limit are not
 * here: a frame is always the route's default page); cursor is an opaque transport cursor of a
 * fixed shape (never parsed here). Anything else, a repeated key or a bad shape is the fixed 400.
 */
function parseWorkerStreamQuery(sp) {
  assertStrictKeys(sp, new Set(["runId", "afterSeq", "cursor", "filter"]));
  const runId = sp.get("runId");
  if (!isValidRunId(runId)) throw new BadRequest();
  const query = { runId };
  if (sp.has("afterSeq")) {
    const raw = sp.get("afterSeq");
    if (!BEFORE_SEQ_RE.test(raw) || Number(raw) > OWNER_SEQ_MAX) throw new BadRequest();
    query.afterSeq = Number(raw);
  }
  if (sp.has("cursor")) {
    const raw = sp.get("cursor");
    if (!OWNER_STREAM_CURSOR_RE.test(raw)) throw new BadRequest();
    query.cursor = raw;
  }
  if (sp.has("filter")) {
    const raw = sp.get("filter");
    if (!OWNER_ACTIVITY_FILTERS.includes(raw)) throw new BadRequest();
    query.filter = raw;
  }
  return query;
}

async function serveWorkerStream(ctx, req, res, sp) {
  const query = authorizeAndParse(ctx, req, res, sp, parseWorkerStreamQuery);
  if (query === null) return;
  const pub = ctx.published();
  // Nothing published yet: the fixed 404, like /api/worker/event and /api/artifact.
  if (pub === null) return sendJson(res, 404, ERR.not_found);
  // The run must be usable exactly as for /api/worker/activity: in the published snapshot as "ok",
  // then located through the read model's request-time copy check (inside open()).
  const run = ctx.runsById(pub).get(query.runId);
  if (run === undefined || run.availability !== "ok") return sendJson(res, 404, ERR.not_found);
  if (ctx.streams.full()) return sendJson(res, 503, ERR.unavailable);
  try {
    const opened = await ctx.streams.open({
      runId: query.runId,
      res,
      headers: STREAM_HEADERS,
      // 145b：这条流开流时的 bearer（进程令牌或某个会话令牌）——开流后的复核除了
      // 运行与副本，还要核对会话令牌是否仍然有效（过期就 reset(revoked)）。
      token: bearerValue(req.headers.authorization),
      ...(query.afterSeq !== undefined ? { afterSeq: query.afterSeq } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      ...(query.filter !== undefined ? { filter: query.filter } : {}),
    });
    // ok: the 200 head is written and the frames are the stream's own. not_found: the transcript
    // could not be located or read (nothing about why crosses the boundary). gone: the client left
    // while the transcript was being read — there is nobody to answer. Anything else (the hub
    // filled up or closed meanwhile, the service shut down): retry later.
    if (opened.ok) return;
    if (opened.reason === "gone") return;
    if (opened.reason === "not_found") return sendJson(res, 404, ERR.not_found);
    return sendJson(res, 503, ERR.unavailable);
  } catch {
    // The head is already on the wire when the stream fails after it: open() has cut the
    // connection, and the page reconnects or falls back to polling. Only a failure before the
    // head is the fixed 500.
    if (res.headersSent !== true) return sendJson(res, 500, ERR.internal);
    return undefined;
  }
}

// An image response: the safe headers, with the content type the MAGIC NUMBER
// decided (nosniff keeps the browser from second-guessing it).
function sendImage(res, contentType, bytes) {
  for (const [k, v] of Object.entries(SAFE_HEADERS)) res.setHeader(k, v);
  res.setHeader("content-type", contentType);
  res.setHeader("content-length", bytes.length);
  res.writeHead(200);
  res.end(bytes);
}

async function serveArtifact(ctx, req, res, sp) {
  const query = authorizeAndParse(ctx, req, res, sp, parseArtifactQuery);
  if (query === null) return;
  const pub = ctx.published();
  if (pub === null) return sendJson(res, 404, ERR.not_found);
  try {
    const source = await loadWorkerSource(ctx, pub, query.runId);
    if (source === null) return sendJson(res, 404, ERR.not_found);
    // The commit must be the run's CURRENT delivery commit (from the transcript read just
    // now — the same generation the detail uses) and the index one of its changedFiles: a
    // changed candidate can never make the same index point elsewhere.
    const delivery = currentDelivery(source.events, query.runId);
    if (delivery.state !== "bound" || delivery.commit !== query.commit) return sendJson(res, 404, ERR.not_found);
    const path = delivery.changedFiles[query.fileIndex];
    const repoRoot = repoRootOf(ctx, source.run);
    if (repoRoot === null || typeof path !== "string" || !isValidRepoRelativePath(path)) {
      return sendJson(res, 404, ERR.not_found);
    }
    // The transcript only CLAIMS the delivery: prove the commit object, its parent, the actual
    // changed-file list, the "wao-delivery: <runId>" message and the WAO packaging identity
    // against the repository before any blob is read by index.
    const proof = await ctx.proveDelivery({
      runId: query.runId, repoRoot, baseCommit: delivery.baseCommit, commit: delivery.commit, changedFiles: delivery.changedFiles,
    });
    if (!proof.ok) return sendJson(res, 404, ERR.not_found);
    const image = await readCommitImage({ repoRoot, commit: delivery.commit, path });
    if (!image.ok) return sendJson(res, 404, ERR.not_found);
    return sendImage(res, image.contentType, image.bytes);
  } catch {
    return sendJson(res, 500, ERR.internal);
  }
}

/** The request path exactly as sent (no query, no fragment, nothing normalized). */
const rawPathOf = (req) => String(req.url || "/").split(/[?#]/, 1)[0];

/** "/v2" itself or anything below it (a parsed pathname). */
const isV2Path = (path) => path === "/v2" || path.startsWith("/v2/");

/**
 * A RAW request path that starts at /v2 with one OR MORE leading slashes: "/v2", "/v2/…", "/v2\…",
 * "/v2%5C…" and the double-slash forms ("//v2/…") — the URL parser treats "//v2" as an authority, so
 * the collapsed pathname can otherwise land on another route (a redirect, /health or a fixed asset)
 * while the raw path never matched a "/v2" prefix. An encoded backslash is the same boundary.
 */
const isV2RawPath = (path) => /^\/+v2(?:$|[\/\\]|%5c)/i.test(path);

function createHandler(ctx) {
  return async function handler(req, res) {
    // Method-first: GET only. Every other method (incl. OPTIONS) → 405, with NO
    // CORS opt-in. Evaluated before any routing so no method reveals routes.
    if (req.method !== "GET") {
      return sendJson(res, 405, ERR.method_not_allowed, { allow: "GET" });
    }

    let u;
    try {
      u = new URL(req.url || "/", "http://127.0.0.1");
    } catch {
      return sendJson(res, 400, ERR.bad_request);
    }
    const sp = u.searchParams;

    // Package D: the fixed dashboard assets. NO auth — the bearer lives
    // only in the URL fragment (client-side, never sent to the server), so a
    // browser navigation cannot carry it. The pathname is matched against a
    // fixed preloaded map; any other path (incl. traversal forms) → 404 below.
    const asset = ctx.assets.get(u.pathname);
    // Batch 142 fix 1 / 145a fix 1: the /v2 files are only served for a RAW request path that is
    // already clean. The URL parser collapses "." / ".." segments, turns backslashes into slashes,
    // drops tabs / newlines and reads a leading "//v2" as an authority, so a collapsed path can land
    // on a fixed asset, the redirect entry or /health ("/v2/../app.js", "/v2/app.js/..",
    // "//v2/../index.html", "//v2/../health"). Whenever the raw path is under /v2 (one or more leading
    // slashes), or the collapsed path is a /v2 asset, the raw path must equal the collapsed one —
    // otherwise the fixed 404. This runs BEFORE /health and the redirect.
    if (isV2RawPath(rawPathOf(req)) || (asset && isV2Path(u.pathname))) {
      if (rawPathOf(req) !== u.pathname) return sendJson(res, 404, ERR.not_found);
    }

    if (u.pathname === "/health") {
      // 145b：health 带上实例 nonce——复用检查用它核对“这个端口上就是记录里那个实例”。
      // 无凭据、GET、固定形状；nonce 不是秘密。
      return sendJson(res, 200, { status: "ok", nonce: ctx.nonce });
    }

    // Batch 145b: the one-time start-code exchange (see serveSession).
    if (u.pathname === "/api/session") return serveSession(ctx, req, res, sp);

    // Batch 145a: the retired legacy entry redirects to the one page. No auth (the
    // bearer lives only in the URL fragment, which the browser carries across).
    const redirect = LEGACY_REDIRECTS.get(u.pathname);
    if (redirect !== undefined) {
      return sendRedirect(res, redirect);
    }

    if (asset) {
      return sendAsset(res, asset);
    }

    // Batch 141c: the Activity tab's timeline page and one event's full text.
    if (u.pathname === "/api/worker/activity") return serveWorkerActivity(ctx, req, res, sp);
    if (u.pathname === "/api/worker/event") return serveWorkerEvent(ctx, req, res, sp);
    // Batch 144: the Activity tab's event stream.
    if (u.pathname === "/api/worker/stream") return serveWorkerStream(ctx, req, res, sp);

    // Batch 141a: one worker's detail and one image of its current delivery.
    if (u.pathname === "/api/worker") return serveWorker(ctx, req, res, sp);
    if (u.pathname === "/api/artifact") return serveArtifact(ctx, req, res, sp);

    // Batch 140c: Overview / Workers / Attention — all three read one publication.
    const readModelRoute = READ_MODEL_ROUTES.get(u.pathname);
    if (readModelRoute !== undefined) {
      return serveReadModelRoute(ctx, req, res, sp, readModelRoute);
    }

    // Unknown route — fixed 404, no auth required (do not reveal which routes
    // exist or that a token is in play).
    return sendJson(res, 404, ERR.not_found);
  };
}

/**
 * Construct the loopback Owner dashboard HTTP boundary. Validates host + port
 * BEFORE listen so a misconfiguration throws synchronously rather than binding
 * to an unsafe interface.
 *
 * @param {object} config
 * @param {string} config.runDir — server-owned runs/ directory (trusted)
 * @param {object} [config.env] — server-owned env for the secret redactor. When
 *   OMITTED (production) the service+projector fall through to process.env; when
 *   PROVIDED it overrides exactly (deterministic tests). Never defaulted to {}.
 * @param {string} [config.host="127.0.0.1"] — must be exactly 127.0.0.1
 * @param {number} [config.port=0] — 0 (ephemeral) or integer 1024..65535
 * @param {Function} [config.randomBytesFn] — injectable entropy source
 *   `(size:number) => Buffer|Uint8Array` for tests; default crypto.randomBytes.
 *   Output is validated fail-closed (exactly 32 bytes → 64 lowercase hex).
 * @param {Function} [config.nowFn] — clock (ms) for liveness (testing)
 * @param {Function} [config.loadAssetFn] — injectable fixed-asset loader
 *   `(name:string) => Buffer|Uint8Array|string` for tests; default reads the
 *   fixed assets (the "v2/…" files) from src/owner-dashboard/ relative to this module.
 *   Loading is eager + fail-closed: a missing asset throws BEFORE listen.
 * @param {Function} [config.createReadModelFn] — injectable (testing) Owner
 *   read-model factory `() => {refresh, snapshot}`; default
 *   `createOwnerReadModel({ runDir, nowFn })` (same runDir, same clock).
 * @param {Function} [config.createWorkerStreamsFn] — injectable (testing) factory of
 *   the Activity event-stream hub `({ readModel, env, authorize }) => hub`; default
 *   `createWorkerStreams({ readModel, env })`.
 * @param {number} [config.refreshIntervalMs=5000] — interval of the read-model
 *   refresh chain; must be a positive integer (rejected BEFORE listen).
 * @returns {{token: string, handler: Function, server: http.Server,
 *   listen: Function, close: Function, address: Function, refreshNow: Function}}
 *   refreshNow() — run ONE refresh round and resolve to the status afterwards
 *   (tests drive rounds with it instead of real timing; it never rejects).
 *   A closed server returns its current status without touching the read model.
 *   The refresh chain itself starts when the http server emits "listening",
 *   i.e. after listen() succeeds; a "listening" that arrives after close() does
 *   not start it.
 *   listen() — one attempt per server; rejects after close() without opening a
 *   socket, and rejects on bind errors (e.g. EADDRINUSE).
 *   close() — idempotent; every call returns the SAME promise. It cuts every open
 *   event stream at once, waits for an in-flight round and for a pending listen()
 *   to settle, resolves immediately after a failed listen(), and shuts the socket
 *   after a successful one.
 */
export function createOwnerDashboardServer(config) {
  if (config === null || typeof config !== "object") {
    throw new TypeError("invalid config: an object is required");
  }
  // Fail closed on removed / misspelled keys BEFORE host, port or any asset/token side effect.
  const unknownKeys = Object.keys(config).filter((key) => !CONFIG_KEYS.has(key)).sort();
  if (unknownKeys.length > 0) {
    throw new TypeError(`unknown owner dashboard config key(s): ${unknownKeys.join(", ")}`);
  }
  const {
    runDir, env,
    host = LOOPBACK_HOST, port,
    randomBytesFn, nowFn, loadAssetFn,
    createReadModelFn, createWorkerStreamsFn, refreshIntervalMs,
    codesDir, sessionTtlMs, sessionMax,
  } = config;

  // Reject any non-loopback host BEFORE listen.
  if (host !== LOOPBACK_HOST) {
    throw new Error(`invalid host: owner dashboard binds only to ${LOOPBACK_HOST}`);
  }

  // Port: undefined → default 0 (ephemeral); else 0 or integer 1024..65535.
  let resolvedPort;
  if (port === undefined) {
    resolvedPort = 0;
  } else {
    if (!Number.isInteger(port) || port < 0 || port > PORT_MAX || (port !== 0 && port < PORT_MIN)) {
      throw new Error(`invalid port: must be 0 or an integer in ${PORT_MIN}..${PORT_MAX}`);
    }
    resolvedPort = port;
  }

  // Batch 140c: read-model wiring knobs are validated here too — BEFORE any
  // asset load or token issuance (a bad interval throws as "refreshIntervalMs",
  // not as whatever the next step happens to trip over).
  if (createReadModelFn !== undefined && typeof createReadModelFn !== "function") {
    throw new TypeError("invalid createReadModelFn: must be a function");
  }
  if (createWorkerStreamsFn !== undefined && typeof createWorkerStreamsFn !== "function") {
    throw new TypeError("invalid createWorkerStreamsFn: must be a function");
  }
  const intervalMs = refreshIntervalMs === undefined ? DEFAULT_REFRESH_INTERVAL_MS : refreshIntervalMs;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error(`invalid refreshIntervalMs: must be a positive integer (default ${DEFAULT_REFRESH_INTERVAL_MS})`);
  }

  // Batch 145b: the start-code directory (persistent mode) and the session knobs are validated here
  // too — BEFORE any asset load or token issuance.
  if (codesDir !== undefined && (typeof codesDir !== "string" || codesDir.length === 0)) {
    throw new TypeError("invalid codesDir: must be a non-empty string when given");
  }
  for (const [name, value] of Object.entries({ sessionTtlMs, sessionMax })) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`invalid ${name}: must be a positive integer`);
    }
  }

  // Package D: preload the fixed dashboard assets EAGER and FAIL-CLOSED
  // BEFORE the token is issued or any socket opened. A dashboard that cannot
  // serve its own UI never starts. The map is immutable for the server lifetime.
  const assets = loadStaticAssets(loadAssetFn);

  // Issue + fail-closed-validate the bearer BEFORE constructing the server
  // object (no side effect, no listen). Public arbitrary config.token was
  // removed; only the injectable randomBytesFn entropy source is accepted.
  const issuedToken = issueToken(randomBytesFn);

  const ctxNow = typeof nowFn === "function" ? nowFn : () => Date.now();
  const ctx = {
    env,
    token: issuedToken,
    assets,
    now: ctxNow,
    // Batch 145b: the instance nonce (health identity) and the in-memory session store. The nonce
    // rides the same injectable entropy source as the token (validated fail-closed, 32 hex).
    nonce: issueHex(randomBytesFn, 16),
    sessions: createSessionStore({
      now: ctxNow,
      ...(sessionTtlMs !== undefined ? { ttlMs: sessionTtlMs } : {}),
      ...(sessionMax !== undefined ? { max: sessionMax } : {}),
      ...(typeof randomBytesFn === "function" ? { randomBytesFn } : {}),
    }),
    // One start-code redemption probe per request; null when no codesDir is configured
    // (foreground / tests — the route then always answers the fixed 401).
    redeem: codesDir === undefined ? null : (code) => redeemStartCode(codesDir, code, { now: ctxNow }),
    // Batch 141a: proves a run's delivery objects against its repository (commit type,
    // parent = base, actual changed files = changedFiles, message + author/committer identity)
    // and hands back the per-file line
    // counts. The counts are cached per (repo, base, commit) — objects are immutable — but
    // the proof itself runs on every request, so a pruned object is never reported bound.
    proveDelivery: createDeliveryProver(),
    // Batch 141c: the processed full texts of /api/worker/event (bounded by bytes, LRU, keyed by the
    // transcript's content hash — a changed transcript never serves a stale text).
    fullTextCache: createFullTextCache(),
  };

  // runId → snapshot row, built once per publication (the snapshot object is the key).
  const runsByIdCache = new WeakMap();
  ctx.runsById = (pub) => {
    let map = runsByIdCache.get(pub.snapshot);
    if (map === undefined) {
      map = new Map((Array.isArray(pub.snapshot.runs) ? pub.snapshot.runs : []).map((run) => [run.runId, run]));
      runsByIdCache.set(pub.snapshot, map);
    }
    return map;
  };

  const handler = createHandler(ctx);
  const server = http.createServer(handler);
  // 145b：/api/session 的严格 Host 核对要“本服务实际应答的端口”：显式端口直接用，
  // 随机端口（0）在 listening 之后从 address() 读。
  ctx.effectivePort = () => {
    if (resolvedPort !== 0) return resolvedPort;
    const a = server.address();
    return a && typeof a === "object" && Number.isInteger(a.port) ? a.port : null;
  };

  // ===== Batch 140c: the read model + its refresh chain =====
  //
  // ONE publication { now, generatedAt, snapshot, attention } serves all three
  // read-model routes. A round = readModel.refresh() → one clock read →
  // snapshot({ now }) → deriveOwnerAttention(snapshot, { now }); the snapshot
  // and the attention therefore always come from the SAME now. Rounds never
  // overlap: a second refreshNow() while one is in flight joins it.
  //
  // Failure handling: ANY failure of a round — an unusable clock (non-finite or
  // outside the Date range, validated BEFORE anything is read), a synchronous
  // throw from an injected readModel.refresh(), a rejection, a snapshot() throw,
  // a derivation throw — is a failed round: the clock failure never reaches
  // snapshot() and nothing is published; the previous publication is kept, the
  // status flips to "stale" (or "unavailable" when nothing was ever published),
  // and the chain still arms the next round. Status is the closed set loading |
  // ready | stale | unavailable. staleSince belongs to the failure STREAK: only
  // the first failed round sets it (null when that round's clock is unreadable);
  // later failures in the same streak never back-fill it.
  //
  // close() is final and IDEMPOTENT: the `closed` flag is set first and the
  // close promise is cached, so every later call returns the SAME promise. A
  // late "listening" must NOT start the chain; a timer callback, refreshNow()
  // and the end of an in-flight round all check the flag, so nothing is
  // published or re-armed after close(). close() waits for an in-flight round
  // and for a pending listen() to settle (a failed listen resolves it; a
  // successful one is then shut). listen() after close() rejects without
  // opening a socket.
  const readModel = (createReadModelFn ?? ((input) => createOwnerReadModel(input)))({
    runDir, nowFn: ctx.now, ...(env !== undefined ? { env } : {}),
  });
  ctx.readModel = readModel; // 141a: /api/worker and /api/artifact read through it
  // Batch 144: the Activity event streams of this service (the connection cap and closeAll live there).
  ctx.streams = (createWorkerStreamsFn ?? createWorkerStreams)({
    readModel, ...(env !== undefined ? { env } : {}),
    // 145b 修正一 #13：流的时钟用服务的 nowFn（缺省等价 Date.now；测试可拨钟驱动复核）。
    io: { now: ctx.now },
    // The stream's re-authorization (every refresh while it is open): the run is still in the published
    // snapshot and still "ok", exactly the check serveWorkerStream makes at the head. The copy check is
    // the stream's own (readModel.locateRunTranscript). 145b 修正一 #13: the bearer this stream opened
    // with is re-checked STRICTLY — the process token passes (timingSafeEqual), a live session passes,
    // EVERYTHING else (null/absent/unknown) is refused; an expired session resets the stream (revoked).
    authorize: (runId, token) => {
      const pub = ctx.published();
      if (pub === null || ctx.runsById(pub).get(runId)?.availability !== "ok") return false;
      if (typeof token === "string" && bearerOk(`Bearer ${token}`, ctx.token)) return true;
      if (typeof token === "string" && ctx.sessions.valid(token)) return true;
      return false;
    },
  });

  let published = null;
  let failing = false; // the latest round failed
  let staleSince = null; // first failure of the current failure streak (ISO|null)
  let timer = null;
  let loopOn = false;
  let closed = false;
  let listenPromise = null; // the one listen() promise (idempotent)
  let listenDone = null; // resolves true/false when listen() settles; never rejects
  let closePromise = null; // the one close() promise (idempotent)
  let inflight = null;

  /** The clock, never throwing: a broken injected clock reads as "unknown". */
  function clockNow() {
    try {
      const at = ctx.now();
      return Number.isFinite(at) ? at : null;
    } catch {
      return null;
    }
  }

  /** A representable epoch ms for this round, or null (never throws). */
  function representableNow() {
    const at = clockNow();
    return at !== null && Math.abs(at) <= 8.64e15 ? at : null;
  }

  /** epoch ms → ISO; anything the Date range cannot represent → null (never throws). */
  function isoOf(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
    return new Date(ms).toISOString();
  }

  function status() {
    if (published !== null) return failing ? "stale" : "ready";
    return failing ? "unavailable" : "loading";
  }

  // Common response fields; staleSince only while stale / unavailable (cleared on recovery).
  ctx.status = () => {
    const out = { status: status() };
    if (published !== null) out.generatedAt = published.generatedAt;
    if (out.status === "stale" || out.status === "unavailable") out.staleSince = staleSince;
    return out;
  };
  ctx.published = () => published;

  /** One round; never rejects. Publication happens only when still open. */
  function runRound() {
    return (async () => {
      try {
        // Validate the clock at the START of the round: an unusable value is a
        // failed round and must never reach snapshot() / the publication.
        const now = representableNow();
        if (now === null) throw new TypeError("owner dashboard: now is not a representable epoch ms");
        await readModel.refresh();
        if (closed) return; // closed while refreshing: publish nothing
        const snapshot = readModel.snapshot({ now });
        const attention = deriveOwnerAttention(snapshot, { now });
        if (closed) return;
        published = { now, generatedAt: snapshot.generatedAt, snapshot, attention };
        failing = false;
        staleSince = null;
      } catch {
        if (closed) return;
        const firstFailure = !failing;
        failing = true;
        // The failure streak's start is the FIRST failed round; if its clock is
        // unreadable it stays null until recovery (never back-filled later).
        if (firstFailure) staleSince = isoOf(clockNow());
      }
    })();
  }

  function refreshNow() {
    if (closed) return Promise.resolve(status()); // closed: never touch the read model again
    if (inflight === null) {
      const round = runRound();
      inflight = round;
      round.then(() => {
        if (inflight === round) inflight = null;
        armNext(); // a failed round re-arms too; never overlaps
      });
    }
    return inflight.then(() => status());
  }

  function armNext() {
    if (!loopOn || closed) return; // stopped (close) — never re-arm
    if (timer !== null) return; // one pending timer at a time
    timer = setTimeout(() => {
      timer = null;
      if (closed) return; // no publication after close
      refreshNow();
    }, intervalMs);
    // The HTTP server (not this timer) holds the process open while listening.
    if (typeof timer.unref === "function") timer.unref();
  }

  /** Start the chain: a cold round now, then one round per interval. Idempotent. */
  function startRefresh() {
    if (loopOn || closed) return; // a late "listening" after close() must not start it
    loopOn = true;
    refreshNow();
  }

  // Refreshing begins exactly when the server starts listening — nothing reads
  // the run directory before listen() succeeds.
  server.on("listening", startRefresh);

  return {
    token: issuedToken,
    nonce: ctx.nonce, // 145b：实例身份（/health 回显；复用检查核对）
    handler,
    server,
    refreshNow,
    listen() {
      if (closed) return Promise.reject(new Error("owner dashboard server is closed"));
      if (listenPromise !== null) return listenPromise; // one listen attempt per server
      listenPromise = new Promise((resolve, reject) => {
        const onError = (err) => { server.off("listening", onListening); reject(err); };
        const onListening = () => {
          server.off("error", onError);
          const a = server.address();
          resolve(a && typeof a === "object"
            ? { host: a.address, port: a.port, family: a.family }
            : a);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(resolvedPort, LOOPBACK_HOST);
      });
      // Settles either way and never rejects: close() awaits this before deciding
      // whether there is a socket to shut (a failed listen must not hang close).
      listenDone = listenPromise.then(() => true, () => false);
      return listenPromise;
    },
    close() {
      if (closePromise !== null) return closePromise; // idempotent: same promise every call
      closed = true; // first: a late "listening" and any timer callback must see it
      loopOn = false; // an in-flight round must not re-arm the chain
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      // Batch 144: cut every open event stream NOW (each one closes its watcher and timers).
      // They are long-lived responses: left open they would hold server.close() below forever,
      // and their watchers and timers would keep working while the socket is still up.
      ctx.streams.closeAll();
      closePromise = (async () => {
        if (inflight !== null) await inflight; // never rejects; publishes nothing after close
        // Let a pending listen() settle first: on failure there is no socket and
        // close resolves immediately; on success the socket is then shut.
        if (listenDone !== null) await listenDone;
        if (server.listening) {
          await new Promise((resolve) => server.close(() => resolve()));
        }
      })();
      return closePromise;
    },
    address() {
      const a = server.address();
      return a && typeof a === "object" ? { host: a.address, port: a.port } : null;
    },
  };
}
