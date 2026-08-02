// src/ownerDashboardServer.js
//
// M12-8C Package C: ownerDashboardServer — a LOOPBACK-ONLY, read-only HTTP
// boundary that lets a local trusted Owner client observe worker runs in real
// time WITHOUT increasing Lead context cost. It is facts-only: it NEVER stops /
// retries / continues / repackages / decides, and performs NO semantic judgment.
// Every endpoint projects a bounded, read-only view via the ownerDashboard
// composition service (which reuses the SINGLE application SSOTs).
//
// Trust boundary (enforced fail-closed, in order):
//   - Bind EXACTLY to 127.0.0.1 — any other host is rejected BEFORE listen.
//   - Port 0 (ephemeral) or an integer in 1024..65535 — anything else rejected
//     BEFORE listen.
//   - A random per-process bearer token is required for EVERY /api/* request.
//     Compared in constant time; never echoed in any body or header.
//   - GET only — every other method → 405 (Allow: GET). No CORS opt-in: OPTIONS
//     is NOT preflight-handled and never sets Access-Control-Allow-*.
//   - No client-supplied runDir / workspaceRoot / host. Server-owned paths are
//     bound at construction from the trusted process config, never from a query.
//   - Strict query bounds + closed-set categories/order/cursor — any unknown or
//     out-of-range parameter → fixed 400, never a reflection of client input.
//   - Any injected service error → fixed 500 {error:"internal"} — NEVER raw
//     exception text, path, token, prompt, command, PID, provider session, or
//     credential.
//   - readRunActivity / projectRunActivity are single-snapshot reads — this
//     server appends NO transcript and mutates NO worktree.
//
// The server module imports ONLY node:http / node:crypto / node:url + the
// ownerDashboard service (which is the single surface for the closed-set caps
// and the runId validator — no second copy of any closed set lives here).

import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { URL, fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  getOwnerRuns,
  getOwnerActivity,
  OWNER_RUNS_LIMIT_MAX,
  ACTIVITY_CATEGORIES,
  ACTIVITY_CURSOR_MAX_CHARS,
  LEAD_PAGE_HARD_CAP,
  isValidRunId,
} from "./application/ownerDashboard.js";

const LOOPBACK_HOST = "127.0.0.1";
const PORT_MIN = 1024;
const PORT_MAX = 65535;
const TOKEN_BYTES = 32; // 256-bit bearer → exactly 64 lowercase hex chars
// Issued token contract: derived from exactly 32 bytes → 64 lowercase hex.
const TOKEN_HEX_RE = /^[0-9a-f]{64}$/;

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

// Fixed safe response bodies. Never raw text, never token, never path.
const ERR = Object.freeze({
  unauthorized: { error: "unauthorized" },
  method_not_allowed: { error: "method_not_allowed" },
  not_found: { error: "not_found" },
  bad_request: { error: "bad_request" },
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

// ===== Package D: the Owner read-only dashboard UI =====
//
// The server serves EXACTLY three fixed static assets (the dashboard UI). There
// is no second HTTP framework and no client-supplied path is ever read from
// disk: the request pathname is matched against a FIXED route→asset table whose
// bodies are preloaded ONCE at server creation. A request for any other path
// (including every traversal form — the pathname is never used as a filesystem
// path) simply matches no key and falls through to the fixed 404.
//
// The three assets are loaded relative to this module (src/owner-dashboard/).
// Loading is EAGER and FAIL-CLOSED at createOwnerDashboardServer time: if any of
// the three fixed assets is missing/unreadable the factory throws BEFORE any
// token is issued or socket opened — a dashboard that cannot serve its own UI
// never starts. Tests may inject `loadAssetFn(name)` to avoid the disk.
const STATIC_DIR = fileURLToPath(new URL("./owner-dashboard/", import.meta.url));
const STATIC_ASSETS = Object.freeze([
  { route: "/", file: "index.html", type: "text/html; charset=utf-8" },
  { route: "/index.html", file: "index.html", type: "text/html; charset=utf-8" },
  { route: "/styles.css", file: "styles.css", type: "text/css; charset=utf-8" },
  { route: "/app.js", file: "app.js", type: "text/javascript; charset=utf-8" },
]);

// Preload the three fixed assets into an immutable route→{body,type} map. The
// bodies are Buffers (exact bytes served verbatim; content-length is the byte
// length). A fixed map keyed by the EXACT pathname makes traversal impossible:
// "/../x", "/%2e", "/foo" match no key → 404, and no client input reaches fs.
function loadStaticAssets(loadAssetFn) {
  const read = typeof loadAssetFn === "function"
    ? loadAssetFn
    : (name) => readFileSync(join(STATIC_DIR, name));
  const map = new Map();
  for (const a of STATIC_ASSETS) {
    // Skip re-reading a file already loaded under another route (e.g. "/" and
    // "/index.html" share index.html) — same bytes, one read.
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
  res.setHeader("content-type", asset.type);
  res.setHeader("content-length", asset.body.length);
  res.writeHead(200);
  res.end(asset.body);
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

function parseCategories(raw) {
  if (raw.length === 0) throw new BadRequest();
  const out = [];
  const seen = new Set();
  for (const part of raw.split(",")) {
    if (!ACTIVITY_CATEGORIES.includes(part)) throw new BadRequest();
    if (seen.has(part)) throw new BadRequest();
    seen.add(part);
    out.push(part);
  }
  return out;
}

function parseCursor(raw) {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new BadRequest();
  if (raw.length > ACTIVITY_CURSOR_MAX_CHARS) throw new BadRequest();
  return raw;
}

function parseOrder(raw) {
  if (raw !== "asc" && raw !== "desc") throw new BadRequest();
  return raw;
}

function parseRunsQuery(sp) {
  assertStrictKeys(sp, new Set(["limit"]));
  const q = {};
  if (sp.has("limit")) q.latest = parseBoundedInt(sp.get("limit"), 1, OWNER_RUNS_LIMIT_MAX);
  return q;
}

function parseActivityQuery(sp) {
  assertStrictKeys(sp, new Set(["runId", "cursor", "categories", "afterSeq", "pageSize", "order"]));
  const runId = sp.get("runId");
  if (!isValidRunId(runId)) throw new BadRequest();
  const q = { runId };
  if (sp.has("cursor")) q.cursor = parseCursor(sp.get("cursor"));
  if (sp.has("categories")) q.categories = parseCategories(sp.get("categories"));
  if (sp.has("afterSeq")) q.afterSeq = parseBoundedInt(sp.get("afterSeq"), 0, 1_000_000);
  if (sp.has("pageSize")) q.pageSize = parseBoundedInt(sp.get("pageSize"), 1, LEAD_PAGE_HARD_CAP);
  if (sp.has("order")) q.order = parseOrder(sp.get("order"));
  return q;
}

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

    if (u.pathname === "/health") {
      return sendJson(res, 200, { status: "ok" });
    }

    // Package D: the three fixed dashboard assets. NO auth — the bearer lives
    // only in the URL fragment (client-side, never sent to the server), so a
    // browser navigation cannot carry it. The pathname is matched against a
    // fixed preloaded map; any other path (incl. traversal forms) → 404 below.
    const asset = ctx.assets.get(u.pathname);
    if (asset) {
      return sendAsset(res, asset);
    }

    if (u.pathname === "/api/runs") {
      if (!bearerOk(req.headers.authorization, ctx.token)) {
        return sendJson(res, 401, ERR.unauthorized);
      }
      let query;
      try {
        query = parseRunsQuery(sp);
      } catch (e) {
        if (!(e instanceof BadRequest)) return sendJson(res, 500, ERR.internal);
        return sendJson(res, 400, ERR.bad_request);
      }
      try {
        const result = await ctx.getOwnerRuns({
          runDir: ctx.runDir,
          workspaceRoot: ctx.workspaceRoot,
          knownAgentIds: ctx.knownAgentIds,
          ...(query.latest !== undefined ? { latest: query.latest } : {}),
        });
        return sendJson(res, 200, result);
      } catch {
        return sendJson(res, 500, ERR.internal);
      }
    }

    if (u.pathname === "/api/activity") {
      if (!bearerOk(req.headers.authorization, ctx.token)) {
        return sendJson(res, 401, ERR.unauthorized);
      }
      let query;
      try {
        query = parseActivityQuery(sp);
      } catch (e) {
        if (!(e instanceof BadRequest)) return sendJson(res, 500, ERR.internal);
        return sendJson(res, 400, ERR.bad_request);
      }
      try {
        const result = await ctx.getOwnerActivity({
          runId: query.runId,
          runDir: ctx.runDir,
          workspaceRoot: ctx.workspaceRoot,
          knownAgentIds: ctx.knownAgentIds,
          // Server-owned env authority: when the trusted config PROVIDES env, it
          // is threaded to the redactor; when omitted, NOTHING is threaded so the
          // service + projector fall through to process.env (the single SSOT
          // default at runActivityProjection's createSecretRedactor(env ?? process.env)).
          ...(ctx.env !== undefined ? { env: ctx.env } : {}),
          now: ctx.now(),
          ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
          ...(query.categories !== undefined ? { categories: query.categories } : {}),
          ...(query.afterSeq !== undefined ? { afterSeq: query.afterSeq } : {}),
          ...(query.pageSize !== undefined ? { pageSize: query.pageSize } : {}),
          ...(query.order !== undefined ? { order: query.order } : {}),
        });
        return sendJson(res, 200, result);
      } catch {
        return sendJson(res, 500, ERR.internal);
      }
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
 * @param {string} config.workspaceRoot — server-owned canonical Git root (trusted)
 * @param {string[]} [config.knownAgentIds] — registry ids for agentId validation
 * @param {object} [config.env] — server-owned env for the secret redactor. When
 *   OMITTED (production) the service+projector fall through to process.env; when
 *   PROVIDED it overrides exactly (deterministic tests). Never defaulted to {}.
 * @param {string} [config.host="127.0.0.1"] — must be exactly 127.0.0.1
 * @param {number} [config.port=0] — 0 (ephemeral) or integer 1024..65535
 * @param {Function} [config.getOwnerRunsFn] — injectable (testing)
 * @param {Function} [config.getOwnerActivityFn] — injectable (testing)
 * @param {Function} [config.randomBytesFn] — injectable entropy source
 *   `(size:number) => Buffer|Uint8Array` for tests; default crypto.randomBytes.
 *   Output is validated fail-closed (exactly 32 bytes → 64 lowercase hex).
 * @param {Function} [config.nowFn] — clock (ms) for liveness (testing)
 * @param {Function} [config.loadAssetFn] — injectable fixed-asset loader
 *   `(name:string) => Buffer|Uint8Array|string` for tests; default reads the
 *   three fixed assets from src/owner-dashboard/ relative to this module.
 *   Loading is eager + fail-closed: a missing asset throws BEFORE listen.
 * @returns {{token: string, handler: Function, server: http.Server,
 *   listen: Function, close: Function, address: Function}}
 */
export function createOwnerDashboardServer(config) {
  const {
    runDir, workspaceRoot, knownAgentIds = [], env,
    host = LOOPBACK_HOST, port,
    getOwnerRunsFn, getOwnerActivityFn,
    randomBytesFn, nowFn, loadAssetFn,
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

  // Package D: preload the three fixed dashboard assets EAGER and FAIL-CLOSED
  // BEFORE the token is issued or any socket opened. A dashboard that cannot
  // serve its own UI never starts. The map is immutable for the server lifetime.
  const assets = loadStaticAssets(loadAssetFn);

  // Issue + fail-closed-validate the bearer BEFORE constructing the server
  // object (no side effect, no listen). Public arbitrary config.token was
  // removed; only the injectable randomBytesFn entropy source is accepted.
  const issuedToken = issueToken(randomBytesFn);

  const ctx = {
    runDir,
    workspaceRoot,
    knownAgentIds,
    env,
    token: issuedToken,
    assets,
    getOwnerRuns: getOwnerRunsFn ?? getOwnerRuns,
    getOwnerActivity: getOwnerActivityFn ?? getOwnerActivity,
    now: typeof nowFn === "function" ? nowFn : () => Date.now(),
  };

  const handler = createHandler(ctx);
  const server = http.createServer(handler);

  return {
    token: issuedToken,
    handler,
    server,
    listen() {
      return new Promise((resolve, reject) => {
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
    },
    close() {
      return new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
      });
    },
    address() {
      const a = server.address();
      return a && typeof a === "object" ? { host: a.address, port: a.port } : null;
    },
  };
}
