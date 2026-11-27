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
// START CODE (batch 145b, decision 0131 section 2): a persistent instance hands the page a
// ONE-TIME start code in the fragment instead of a long-lived token:
//   - #code=<64 lowercase hex> alone, or as one component of a page fragment
//     (#workers?project=<slug>&code=<64 hex>) — the page clears the code component FIRST
//     and synchronously (a project filter sharing the fragment survives), then exchanges
//     it asynchronously; only a successful exchange leads to any data request.
//   - The exchange is GET /api/session with the code in the Authorization header (never a
//     query string), through the same single fetch call; the answer is a session token
//     stored in sessionStorage under the same key as #token=.
//   - A failed exchange means the code is dead: the stored token is cleared and the page
//     shows the fixed "run wao dashboard again" message — it never falls back to an old token.
//
// DATA PLANE: the page may read exactly these nine read-only routes; the request
// functions refuse any other path (and any query that is not the route's own closed,
// shape-checked key set), and this module holds the only direct network call in the v2
// code. Every request is a GET with the bearer, never cached, no referrer.
//   /api/session                                            the one-time start-code exchange
//   /api/overview /api/workers[?project=] /api/attention   the three list pages
//   /api/worker?runId=                                     one worker's detail (JSON)
//   /api/artifact?runId=&commit=&fileIndex=                one delivered image (a blob)
//   /api/worker/activity?runId=&afterSeq=&beforeSeq=&limit=&filter=  one page of the event timeline
//   /api/worker/event?runId=&seq=&part=&page=              one page of an event's full text
//   /api/worker/stream?runId=&afterSeq=&cursor=&filter=    the event timeline as server-sent events
//
// THE STREAM (batch 144, decision 0131 section 4). It goes through the same single fetch call
// with the bearer in the header (a native event source cannot carry one). The stream is read
// here, frame by frame, and handed to the caller; what a frame means is decided in activity.js.
//   - A frame is { id, event, data }: id is the transport cursor of the stream (opaque here —
//     the page only hands it back on a reconnect), event is rows | update | reset | end, data the
//     parsed JSON (null when it is not JSON: the caller drops such a frame).
//   - The request timeout only covers the wait for the response head. After that the stream is
//     given STREAM_IDLE_TIMEOUT_MS per gap: the server sends a comment heartbeat every 15 s, so
//     three missed heartbeats mean the connection is dead.
//   - readStream never throws for a network problem and never reflects the server's text:
//     { ok: true, done: true } when the server closes the stream, else { ok: false, reason } with
//     reason one of "unauthorized" | "notFound" | "network" | "server" | "timeout" | "aborted".

import { readStored, writeStored } from "./store.js";

export const TOKEN_STORAGE_KEY = "wao_v2_token";
export const API_PATHS = Object.freeze([
  "/api/session", "/api/overview", "/api/workers", "/api/attention", "/api/worker", "/api/artifact",
  "/api/worker/activity", "/api/worker/event", "/api/worker/stream",
]);
export const REQUEST_TIMEOUT_MS = 10_000;
/** How long the stream may stay silent (no bytes at all) before it counts as a failed attempt. */
export const STREAM_IDLE_TIMEOUT_MS = 45_000;
/** The frame names the stream may send (the server's closed set). */
export const STREAM_EVENTS = Object.freeze(["rows", "update", "reset", "end"]);

const TOKEN_RE = /^[0-9a-f]{64}$/;

/**
 * 145b 修正一 #14：任一接口 401 都要清掉存储的令牌——处理放进这唯一一处 fetch 的
 * 401 分支（app.js 在启动时绑定具体怎么清）。清除函数只经 app 注入，本模块不碰
 * window/storage。
 */
let clearStoredToken = null;
export const bindTokenClear = (fn) => { clearStoredToken = typeof fn === "function" ? fn : null; };
const TOKEN_FRAGMENT_PREFIX = "#token=";
/** The stream route: the one data route whose answer is not a single JSON body. */
const STREAM_PATH = "/api/worker/stream";

export const isValidToken = (value) => typeof value === "string" && TOKEN_RE.test(value);

/** The token of a fragment that is exactly #token=<64 lowercase hex>, else null. */
export function parseTokenFromHash(hash) {
  if (typeof hash !== "string" || !hash.startsWith(TOKEN_FRAGMENT_PREFIX)) return null;
  const candidate = hash.slice(TOKEN_FRAGMENT_PREFIX.length);
  return isValidToken(candidate) ? candidate : null;
}

export const authorizationHeader = (token) => `Bearer ${token}`;

const CODE_FRAGMENT_PREFIX = "#code=";

/**
 * 145b：片段里的启动码。三种形态：
 *   #code=<64hex>                    —— 独占片段（无筛选）
 *   #<page>?[…&]code=<64hex>[&…]     —— 与页面筛选共处（--cwd 定初始项目筛选时用）
 *   其它                              —— null（没有码，不动片段）
 * 返回 { code, remaining }：code 是合法形状的码或 null（形状不对也返回，让调用方清片段）；
 * remaining 是清掉码之后应保留的片段（独占形态为 ""，共处形态去掉 code 组件）。
 *
 * @param {string} hash
 * @returns {{code: string|null, remaining: string}|null}
 */
export function splitCodeFromHash(hash) {
  if (typeof hash !== "string" || !hash.startsWith("#")) return null;
  if (hash.startsWith(CODE_FRAGMENT_PREFIX)) {
    const candidate = hash.slice(CODE_FRAGMENT_PREFIX.length);
    return { code: isValidToken(candidate) ? candidate : null, remaining: "" };
  }
  const cut = hash.indexOf("?");
  if (cut < 0) return null;
  const params = new URLSearchParams(hash.slice(cut + 1));
  if (!params.has("code")) return null;
  const value = params.get("code");
  params.delete("code");
  const rest = params.toString();
  return {
    code: isValidToken(value) ? value : null,
    remaining: rest.length === 0 ? hash.slice(0, cut) : `${hash.slice(0, cut)}?${rest}`,
  };
}

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
/**
 * The transport cursor of the stream, as the server writes it: a fixed shape of six dot-separated
 * fields (version, stream generation, file tag, byte offset, event position, hash chain), all in
 * base 36 or hex. Opaque to the page: it is only handed back on a reconnect. The shape here is the
 * route's closed set (the relation guard in ownerDashboardV2Stream.test.js feeds this check with
 * what the server encodes, including the longest cursor).
 */
const STREAM_CURSOR_RE = /^1\.[0-9a-f]{16}\.[0-9a-f]{16}\.[0-9a-z]{1,11}\.[0-9a-z]{1,6}\.[0-9a-f]{16}$/;

/** Per route: the closed query keys, each with its shape and whether it is required. */
const QUERY_SHAPES = Object.freeze({
  "/api/session": {},
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
  "/api/worker/stream": {
    runId: { re: RUN_ID_RE, required: true },
    afterSeq: { re: BEFORE_SEQ_RE, required: false },
    cursor: { re: STREAM_CURSOR_RE, required: false },
    filter: { re: ACTIVITY_FILTER_RE, required: false },
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
/** The event stream of one run: after the seq cursor, or after the transport cursor of a dropped stream. */
export const streamPath = ({ runId, afterSeq = null, cursor = null, filter = null }) => build(STREAM_PATH, [
  ["runId", runId], ["afterSeq", afterSeq], ["cursor", cursor], ["filter", filter],
]);

// ===== reading server-sent events =====

/**
 * Parses server-sent events out of the text as it arrives, whatever the chunking: push(text)
 * returns the frames that text completed, end() drops a frame that never got its blank line.
 * A frame is { id, event, data }: id is the transport cursor named by the last `id:` line
 * (null before any), event the `event:` line ("message" when absent), data the `data:` lines
 * joined with newlines. Comment lines (a leading colon — the heartbeat) are skipped: they neither
 * end a frame nor join two frames. LF, CRLF and a lone CR all end a line; a CR that is the last
 * character received waits for the next one, so a CRLF split across two chunks is one line break.
 */
export function createSseParser() {
  let pending = ""; // the tail that has not become a line yet
  let id = null;
  let event = null;
  let data = [];
  const frames = [];
  const line = (text) => {
    if (text === "") {
      // A blank line hands over the frame — but only one that has data.
      if (data.length > 0) frames.push({ id, event: event ?? "message", data: data.join("\n") });
      event = null;
      data = [];
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id" && value !== "" && !value.includes("\u0000")) id = value;
  };
  return {
    push(text) {
      pending += text;
      for (;;) {
        const at = pending.search(/[\r\n]/);
        if (at < 0 || (pending[at] === "\r" && at === pending.length - 1)) break;
        const width = pending[at] === "\r" && pending[at + 1] === "\n" ? 2 : 1;
        line(pending.slice(0, at));
        pending = pending.slice(at + width);
      }
      return frames.splice(0);
    },
    /** The stream ended: a frame still waiting for its blank line is not delivered. */
    end() {
      pending = "";
      return frames.splice(0);
    },
  };
}

/** The abort reason of a read that timed out (told apart from the caller's own cancel). */
const READ_TIMEOUT = new Error("stream read timeout");

// ===== the one network call =====

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** The caller's cancel signal combined with the request timeout (one request, one bounded wait). */
function timedSignal(signal, ms = REQUEST_TIMEOUT_MS) {
  const timeout = AbortSignal.timeout(ms);
  return signal !== null && typeof AbortSignal.any === "function" ? AbortSignal.any([timeout, signal]) : timeout;
}

/**
 * GET one route with the bearer. Never throws on a network problem and never reflects the server's text:
 * { ok: true, response } or { ok: false, reason } with reason one of "unauthorized" | "notFound" |
 * "network" | "server". The signal is the caller's: a selection / filter change, the request
 * timeout, or — for the stream — the read timeout below. This is the one network call of the v2 code.
 */
async function get(path, token, accept, signal = null) {
  let response;
  try {
    response = await fetch(path, {
      method: "GET",
      headers: { authorization: authorizationHeader(token), accept },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
    });
  } catch {
    return { ok: false, reason: "network" };
  }
  if (response.status === 401) {
    // 详情、Activity、全文、图片、流的握手与列表轮询共用这一个 401 分支：存储的令牌
    // 已死，清掉，让重载去要新的启动码。
    try { clearStoredToken?.(); } catch { /* 存储不可用就只当作没有 */ }
    return { ok: false, reason: "unauthorized" };
  }
  if (response.status === 404) return { ok: false, reason: "notFound" };
  if (!response.ok) return { ok: false, reason: "server" };
  return { ok: true, response };
}

/**
 * 145b：把一次性启动码换成会话令牌（GET /api/session，码走 Authorization 头，绝不进查询串；
 * 也走这唯一一处 fetch）。成功 { ok: true, token, expiresAt }；失败 { ok: false, reason }
 *（reason 同 request 的闭集；形状不对的码在出发前就拒）。
 */
export async function exchangeSession(code, signal = null) {
  if (!isValidToken(code)) return { ok: false, reason: "unauthorized" };
  const got = await get("/api/session", code, "application/json", timedSignal(signal));
  if (!got.ok) return got;
  try {
    const body = await got.response.json();
    if (body === null || typeof body !== "object" || !isValidToken(body.token)) {
      return { ok: false, reason: "server" };
    }
    return { ok: true, token: body.token, expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : null };
  } catch {
    return { ok: false, reason: "server" };
  }
}
/**
 * GET one of the JSON read routes. The result is { ok: true, body } or { ok: false, reason } with reason
 * one of "unauthorized" | "notFound" | "network" | "server". A route outside the closed set, the
 * image route and the stream route are refused before anything leaves the page.
 */
export async function request(path, token, signal = null) {
  if (!isDataPath(path) || path.startsWith("/api/artifact") || path.startsWith(STREAM_PATH) || path.startsWith("/api/session")) throw new Error("request: path is not one of the dashboard routes");
  const got = await get(path, token, "application/json", timedSignal(signal));
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
  const got = await get(path, token, "image/png, image/jpeg, image/webp", timedSignal(signal));
  if (!got.ok) return got;
  try {
    const blob = await got.response.blob();
    return IMAGE_TYPES.has(blob.type) ? { ok: true, blob } : { ok: false, reason: "server" };
  } catch {
    return { ok: false, reason: "server" };
  }
}

/**
 * Read the event stream (the stream route only) through the one network call. Each completed frame
 * is handed to onFrame({ id, event, data }) in arrival order (data is the parsed JSON, null when it is
 * not JSON; a frame of an unknown name is handed over too — the caller decides). Resolves when the
 * stream is over: { ok: true, done: true } when the server closed it, otherwise { ok: false, reason }
 * with reason one of "unauthorized" | "notFound" | "network" | "server" | "timeout" | "aborted"
 * (aborted: the caller's own signal ended it). Never throws for a network problem.
 *
 * @param {string} path
 * @param {string} token
 * @param {{signal?: AbortSignal|null, onFrame: (frame: object) => void}} io
 */
export async function readStream(path, token, { signal = null, onFrame }) {
  if (!isDataPath(path) || !path.startsWith(STREAM_PATH)) throw new Error("request: path is not one of the dashboard routes");
  const own = new AbortController(); // the read timeout and the caller's cancel both end the fetch through it
  const takeOver = () => own.abort(signal.reason);
  if (signal !== null) {
    if (signal.aborted) takeOver();
    else signal.addEventListener("abort", takeOver, { once: true });
  }
  // Until the response head arrives the request timeout applies; after it, each gap gets the idle timeout.
  const head = setTimeout(() => own.abort(READ_TIMEOUT), REQUEST_TIMEOUT_MS);
  let idle = null;
  const bump = () => {
    clearTimeout(idle);
    idle = setTimeout(() => own.abort(READ_TIMEOUT), STREAM_IDLE_TIMEOUT_MS);
  };
  /** Why the read ended by our own controller, or null when it did not. */
  const stopped = () => (own.signal.aborted ? (own.signal.reason === READ_TIMEOUT ? "timeout" : "aborted") : null);
  const parser = createSseParser();
  const decoder = new TextDecoder();
  let reader = null;
  let consumerError = null; // the consumer's own exception: it ends the read and is handed back below
  const deliver = (frame) => {
    let data = null;
    try {
      data = JSON.parse(frame.data);
    } catch {
      data = null;
    }
    try {
      onFrame({ id: frame.id, event: frame.event, data });
    } catch (error) {
      consumerError = error;
      own.abort(); // release the connection; the exception is rethrown once the reader is released
    }
  };
  try {
    let got;
    try {
      got = await get(path, token, "text/event-stream", own.signal);
    } finally {
      clearTimeout(head);
    }
    if (!got.ok) return { ok: false, reason: stopped() ?? got.reason };
    const response = got.response;
    const type = typeof response.headers?.get === "function" ? String(response.headers.get("content-type")) : "";
    reader = typeof response.body?.getReader === "function" ? response.body.getReader() : null;
    if (!type.startsWith("text/event-stream") || reader === null) return { ok: false, reason: "server" };
    bump();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bump();
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) deliver(frame);
    }
    if (consumerError !== null) throw consumerError;
    return { ok: true, done: true };
  } catch (error) {
    if (consumerError !== null) throw consumerError;
    // A read that ended because our controller fired is a timeout or the caller's cancel; anything
    // else (the connection dropped) is a network failure. The text of the error never leaves.
    return { ok: false, reason: stopped() ?? "network" };
  } finally {
    // Every way out lets go of the same things: both timers, the caller's signal, the reader.
    clearTimeout(head);
    clearTimeout(idle);
    if (signal !== null) signal.removeEventListener("abort", takeOver);
    parser.end();
    try {
      reader?.releaseLock();
    } catch {
      // already released
    }
  }
}
