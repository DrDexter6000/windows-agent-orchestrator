// src/owner-dashboard/v2/api.js
//
// The one place the v2 dashboard handles the access token and talks to the
// server.
//
// TOKEN DISCIPLINE (hard contract, same as the legacy UI):
//   - The bearer arrives ONLY in the URL fragment (#token=<64 lowercase hex>).
//   - resolveToken stores it in sessionStorage and clears the fragment at once.
//     A fragment that starts with #token= is cleared even when it is malformed.
//   - It is NEVER written to the page, a log or an error. It leaves this module
//     only as the Authorization header of a request to /api/*.
//
// DATA PLANE: the page may read exactly these seven read-only routes; the request
// functions refuse any other path (and any query that is not the route's own closed,
// shape-checked key set), and this module holds the only direct network call in the v2
// code. Every request is a GET with the bearer, never cached, no referrer.
//   /api/overview /api/workers[?project=] /api/attention   the three list pages
//   /api/worker?runId=                                     one worker's detail (JSON)
//   /api/artifact?runId=&commit=&fileIndex=                one delivered image (a blob)
//   /api/worker/activity?runId=&afterSeq=&beforeSeq=&limit=&filter=  one page of the event timeline
//   /api/worker/event?runId=&seq=&part=&page=              one page of an event's full text

import { readStored, writeStored } from "./store.js";

export const TOKEN_STORAGE_KEY = "wao_v2_token";
export const API_PATHS = Object.freeze([
  "/api/overview", "/api/workers", "/api/attention", "/api/worker", "/api/artifact",
  "/api/worker/activity", "/api/worker/event",
]);
export const REQUEST_TIMEOUT_MS = 10_000;

const TOKEN_RE = /^[0-9a-f]{64}$/;
const TOKEN_FRAGMENT_PREFIX = "#token=";

export const isValidToken = (value) => typeof value === "string" && TOKEN_RE.test(value);

/** The token of a fragment that is exactly #token=<64 lowercase hex>, else null. */
export function parseTokenFromHash(hash) {
  if (typeof hash !== "string" || !hash.startsWith(TOKEN_FRAGMENT_PREFIX)) return null;
  const candidate = hash.slice(TOKEN_FRAGMENT_PREFIX.length);
  return isValidToken(candidate) ? candidate : null;
}

export const authorizationHeader = (token) => `Bearer ${token}`;

/**
 * The token for this page load: from the fragment (stored, fragment cleared), else
 * from sessionStorage, else null. Page-fragment handling happens AFTER this.
 *
 * @param {{hash: string, getStorage: () => Storage, clearFragment: () => void}} io
 */
export function resolveToken({ hash, getStorage, clearFragment }) {
  if (typeof hash === "string" && hash.startsWith(TOKEN_FRAGMENT_PREFIX)) {
    const fromHash = parseTokenFromHash(hash);
    if (fromHash !== null) writeStored(getStorage, TOKEN_STORAGE_KEY, fromHash);
    clearFragment();
    if (fromHash !== null) return fromHash;
  }
  const stored = readStored(getStorage, TOKEN_STORAGE_KEY);
  return isValidToken(stored) ? stored : null;
}

// ===== the closed route table =====

const SLUG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const RUN_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const FILE_INDEX_RE = /^(?:0|[1-9][0-9]{0,6})$/;
const SEQ_RE = /^[1-9][0-9]{0,8}$/;
const BEFORE_SEQ_RE = /^(?:0|[1-9][0-9]{0,8})$/;
const LIMIT_RE = /^(?:[1-9][0-9]?|1[0-9][0-9]|200)$/;
const PAGE_RE = /^(?:[1-9][0-9]{0,5})$/;
const ACTIVITY_FILTER_RE = /^(?:all|messages|commands|errors)$/;
const EVENT_PART_RE = /^(?:command|output|message|error)$/;

/** Per route: the closed query keys, each with its shape and whether it is required. */
const QUERY_SHAPES = Object.freeze({
  "/api/overview": {},
  "/api/workers": { project: { re: SLUG_RE, required: false } },
  "/api/attention": { project: { re: SLUG_RE, required: false } },
  "/api/worker": { runId: { re: RUN_ID_RE, required: true } },
  "/api/artifact": {
    runId: { re: RUN_ID_RE, required: true },
    commit: { re: COMMIT_RE, required: true },
    fileIndex: { re: FILE_INDEX_RE, required: true },
  },
  "/api/worker/activity": {
    runId: { re: RUN_ID_RE, required: true },
    afterSeq: { re: BEFORE_SEQ_RE, required: false },
    beforeSeq: { re: BEFORE_SEQ_RE, required: false },
    limit: { re: LIMIT_RE, required: false },
    filter: { re: ACTIVITY_FILTER_RE, required: false },
  },
  "/api/worker/event": {
    runId: { re: RUN_ID_RE, required: true },
    seq: { re: SEQ_RE, required: true },
    part: { re: EVENT_PART_RE, required: true },
    page: { re: PAGE_RE, required: false },
  },
});

/** True when `path` is one of the routes with only its own closed, shape-checked query. */
export function isDataPath(path) {
  if (typeof path !== "string") return false;
  const cut = path.indexOf("?");
  const base = cut < 0 ? path : path.slice(0, cut);
  const shapes = Object.hasOwn(QUERY_SHAPES, base) ? QUERY_SHAPES[base] : null;
  if (shapes === null) return false;
  const query = cut < 0 ? "" : path.slice(cut + 1);
  if (cut >= 0 && query === "") return false;
  const seen = new Set();
  const params = new URLSearchParams(query);
  // A query that does not survive a round trip (stray characters, bad escapes) is not ours.
  if (params.toString() !== query) return false;
  for (const [key, value] of params) {
    if (seen.has(key) || !Object.hasOwn(shapes, key) || !shapes[key].re.test(value)) return false;
    seen.add(key);
  }
  return Object.entries(shapes).every(([key, shape]) => !shape.required || seen.has(key));
}

function build(base, entries) {
  const params = new URLSearchParams();
  for (const [key, value] of entries) if (value !== null && value !== undefined) params.set(key, String(value));
  const query = params.toString();
  const path = query === "" ? base : `${base}?${query}`;
  if (!isDataPath(path)) throw new Error("request: path is not one of the dashboard routes");
  return path;
}

/** /api/workers, narrowed to one project (the server filters before its row cap) when given. */
export const workersPath = (project = null) => build("/api/workers", [["project", project]]);
/** One worker's detail. */
export const workerPath = (runId) => build("/api/worker", [["runId", runId]]);
/** One delivered image, bound to the delivery commit and the file's index in the changed list. */
export const artifactPath = ({ runId, commit, fileIndex }) => build("/api/artifact", [["runId", runId], ["commit", commit], ["fileIndex", fileIndex]]);
/** One page of the event timeline; `afterSeq` is a lower bound, `beforeSeq` pages upwards. */
export const activityPath = ({ runId, afterSeq = null, beforeSeq = null, limit = null, filter = null }) => build("/api/worker/activity", [
  ["runId", runId], ["afterSeq", afterSeq], ["beforeSeq", beforeSeq], ["limit", limit], ["filter", filter],
]);
/** One page of one event's full text (part is command | output | message | error). */
export const eventPath = ({ runId, seq, part, page = null }) => build("/api/worker/event", [
  ["runId", runId], ["seq", seq], ["part", part], ["page", page],
]);

// ===== the one network call =====

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * GET one route with the bearer. Never throws on a network problem and never reflects the server's text:
 * { ok: true, response } or { ok: false, reason } with reason one of "unauthorized" | "notFound" |
 * "network" | "server". An optional caller signal (a selection / filter change) cancels the request; the
 * timeout still applies.
 */
async function get(path, token, accept, signal = null) {
  let response;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal !== null && typeof AbortSignal.any === "function" ? AbortSignal.any([timeout, signal]) : timeout;
  try {
    response = await fetch(path, {
      method: "GET",
      headers: { authorization: authorizationHeader(token), accept },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: combined,
    });
  } catch {
    return { ok: false, reason: "network" };
  }
  if (response.status === 401) return { ok: false, reason: "unauthorized" };
  if (response.status === 404) return { ok: false, reason: "notFound" };
  if (!response.ok) return { ok: false, reason: "server" };
  return { ok: true, response };
}

/**
 * GET one of the JSON read routes. The result is { ok: true, body } or { ok: false, reason } with reason
 * one of "unauthorized" | "notFound" | "network" | "server". A route outside the closed set, or the
 * image route, is refused before anything leaves the page.
 */
export async function request(path, token, signal = null) {
  if (!isDataPath(path) || path.startsWith("/api/artifact")) throw new Error("request: path is not one of the dashboard routes");
  const got = await get(path, token, "application/json", signal);
  if (!got.ok) return got;
  try {
    return { ok: true, body: await got.response.json() };
  } catch {
    return { ok: false, reason: "server" };
  }
}

/**
 * GET one delivered image (the /api/artifact route only) as a Blob. Only png / jpeg / webp come back as
 * data; anything else is a "server" failure. The caller turns the blob into an object URL and revokes it.
 */
export async function requestImage(path, token, signal = null) {
  if (!isDataPath(path) || !path.startsWith("/api/artifact")) throw new Error("request: path is not one of the dashboard routes");
  const got = await get(path, token, "image/png, image/jpeg, image/webp", signal);
  if (!got.ok) return got;
  try {
    const blob = await got.response.blob();
    return IMAGE_TYPES.has(blob.type) ? { ok: true, blob } : { ok: false, reason: "server" };
  } catch {
    return { ok: false, reason: "server" };
  }
}
