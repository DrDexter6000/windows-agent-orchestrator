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
// DATA PLANE: the page may read exactly these three read-only routes; request()
// refuses any other path, and it holds the only direct network call in the v2
// code. Every request is a GET with the bearer, never cached, no referrer.

import { readStored, writeStored } from "./store.js";

export const TOKEN_STORAGE_KEY = "wao_v2_token";
export const API_PATHS = Object.freeze(["/api/overview", "/api/workers", "/api/attention"]);
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

/**
 * GET one of the three read routes. Never throws and never reflects the server's
 * text: the result is { ok: true, body } or { ok: false, reason } with reason one
 * of "unauthorized" | "network" | "server".
 */
export async function request(path, token) {
  if (!API_PATHS.includes(path)) throw new Error("request: path is not one of the dashboard routes");
  let response;
  try {
    response = await fetch(path, {
      method: "GET",
      headers: { authorization: authorizationHeader(token), accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "network" };
  }
  if (response.status === 401) return { ok: false, reason: "unauthorized" };
  if (!response.ok) return { ok: false, reason: "server" };
  try {
    return { ok: true, body: await response.json() };
  } catch {
    return { ok: false, reason: "server" };
  }
}
