// test/ownerDashboardWeb.test.js
//
// M12-8D Package D — Owner read-only dashboard (TDD).
//
// Two deterministic, dependency-free surfaces are covered here:
//
//   A) SERVER STATIC / CSP / TRAVERSAL — the ownerDashboardServer HTTP boundary
//      serves EXACTLY the three fixed dashboard assets with strict safe headers,
//      rejects every other path (traversal impossible: the pathname is never used
//      as a filesystem path), stays GET-only, requires NO auth on assets (the
//      bearer lives only in the URL fragment), and never leaks the token.
//      Driven via the request handler with a fake req/res (no real socket/fs/git).
//
//   B) CLIENT CONTRACT / PURE HELPERS — the DOM-free pure helpers exported by
//      src/owner-dashboard/app.js (token parsing, chronological merge, bounded
//      trim, safe-entry projection, liveness, run/category filters, poll params).
//      Plus static assertions that the HTML ships NO inline/remote assets and
//      that app.js sends ONLY an Authorization header to /api/*.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createOwnerDashboardServer } from "../src/ownerDashboardServer.js";
import * as app from "../src/owner-dashboard/app.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src", "owner-dashboard");
const readAsset = (name) => readFileSync(join(SRC, name), "utf8");

// ===== Fake req/res drive (pure, in-memory) — same shape as the server test =====

function drive(handler, { method = "GET", url = "/", headers = {} } = {}) {
  const req = { method, url, headers: { ...headers } };
  const state = { statusCode: 200, headers: {}, body: "", ended: false };
  const res = {
    setHeader(k, v) { state.headers[String(k).toLowerCase()] = v; },
    writeHead(status) { state.statusCode = status; },
    write(c) { state.body += typeof c === "string" ? c : Buffer.from(c).toString("utf8"); },
    end(c) { if (c !== undefined) this.write(c); state.ended = true; },
    getHeader(k) { return state.headers[String(k).toLowerCase()]; },
  };
  const p = handler(req, res);
  return Promise.resolve(p).then(() => ({
    status: state.statusCode, headers: state.headers, body: state.body, ended: state.ended,
  }));
}

// A server with deterministic service fakes (no fs/git/transcript). It preloads
// the REAL three fixed assets from src/owner-dashboard/ at construction.
function makeServer() {
  return createOwnerDashboardServer({
    runDir: "/server/owned/runs",
    workspaceRoot: "/server/owned/ws",
    knownAgentIds: ["coder_low"],
    env: {},
    getOwnerRunsFn: async () => ({ runs: [], returnedCount: 0, matchedCount: 0, truncated: false }),
    getOwnerActivityFn: async () => ({
      runId: "run_x", available: true, unavailableReason: null,
      activity: { entries: [], total: 0, counts: {}, nextCursor: null },
      liveness: { ownerHeartbeat: "n/a", secondsSinceHeartbeat: null },
    }),
    nowFn: () => 1_000_000,
  });
}

function assertStrictSafeHeaders(r, contentType) {
  assert.equal(r.headers["cache-control"], "no-store", "no-store");
  assert.equal(r.headers["x-content-type-options"], "nosniff", "nosniff");
  assert.equal(r.headers["referrer-policy"], "no-referrer", "no-referrer");
  assert.ok(r.headers["content-security-policy"], "CSP set");
  assert.ok(!("access-control-allow-origin" in r.headers), "no CORS opt-in");
  if (contentType) assert.equal(r.headers["content-type"], contentType);
}

// =====================================================================
// A1) THE THREE FIXED ASSETS — served with the correct media type + safe headers
// =====================================================================
test("STATIC: / and /index.html serve the real index.html as text/html", async () => {
  const s = makeServer();
  const root = await drive(s.handler, { url: "/" });
  const idx = await drive(s.handler, { url: "/index.html" });
  assert.equal(root.status, 200);
  assert.equal(idx.status, 200);
  assertStrictSafeHeaders(root, "text/html; charset=utf-8");
  assertStrictSafeHeaders(idx, "text/html; charset=utf-8");
  // The served bytes are the REAL file (not a placeholder).
  const file = readAsset("index.html");
  assert.equal(root.body, file, "/ serves the real index.html bytes");
  assert.equal(idx.body, file, "/index.html serves the same bytes");
  // Content-length is the exact byte length (compared numerically: the in-memory
  // fake stores the number; a real socket would coerce to a string — same value).
  assert.equal(Number(root.headers["content-length"]), Buffer.byteLength(file));
  // Sanity: the real HTML has the expected structure.
  assert.ok(root.body.includes("<title>WAO Owner Dashboard</title>"));
});

test("STATIC: /styles.css served as text/css (real bytes)", async () => {
  const s = makeServer();
  const r = await drive(s.handler, { url: "/styles.css" });
  assert.equal(r.status, 200);
  assertStrictSafeHeaders(r, "text/css; charset=utf-8");
  assert.equal(r.body, readAsset("styles.css"));
  assert.ok(r.body.includes("--bg"), "real CSS served");
});

test("STATIC: /app.js served as text/javascript (real bytes)", async () => {
  const s = makeServer();
  const r = await drive(s.handler, { url: "/app.js" });
  assert.equal(r.status, 200);
  assertStrictSafeHeaders(r, "text/javascript; charset=utf-8");
  assert.equal(r.body, readAsset("app.js"));
  assert.ok(r.body.includes("parseTokenFromHash"), "real app.js served");
  assert.ok(r.body.includes("authorizationHeader"), "app.js uses the auth header");
});

// =====================================================================
// A2) TRAVERSAL / UNKNOWN — every other path → fixed 404 (no fs reach)
// =====================================================================
test("TRAVERSAL: unknown + traversal path forms → 404 (pathname never reaches fs)", async () => {
  const s = makeServer();
  // Every path here is NOT one of the three fixed routes, so it matches no key
  // and falls through to the fixed 404. The pathname is never used as a
  // filesystem path, so traversal is structurally impossible.
  const cases = [
    "/unknown",
    "/foo/bar",
    "/etc/passwd",
    "/index.html/",            // trailing slash → not a fixed route key
    "/%2e%2e/secret",          // encoded dots collapse to "/secret" → unknown
    "/images/logo.png",
    "/app.js.bak",
    "/_app.js",
    "/api",                    // no trailing slash → 404 (only /api/runs|activity)
    "/run", "/runs", "/activity",
  ];
  for (const url of cases) {
    const r = await drive(s.handler, { url });
    assert.equal(r.status, 404, `${url} → 404`);
    assert.deepEqual(JSON.parse(r.body), { error: "not_found" });
  }
});

test("TRAVERSAL: dot-segment forms that the URL parser collapses resolve ONLY to a fixed asset (never to disk)", async () => {
  const s = makeServer();
  // "/app.js/.." normalizes to "/" (a fixed route → index.html), and "/./app.js"
  // normalizes to "/app.js" (a fixed route). Both serve a fixed asset, never an
  // arbitrary file — there is no pathname→fs mapping to escape.
  const a = await drive(s.handler, { url: "/app.js/.." });
  assert.equal(a.status, 200);
  assert.equal(a.headers["content-type"], "text/html; charset=utf-8");
  const b = await drive(s.handler, { url: "/./app.js" });
  assert.equal(b.status, 200);
  assert.equal(b.headers["content-type"], "text/javascript; charset=utf-8");
});

// =====================================================================
// A3) METHOD + AUTH — assets are GET-only and need NO auth (token in fragment)
// =====================================================================
test("STATIC: non-GET on an asset → 405 (method gate is first)", async () => {
  const s = makeServer();
  for (const method of ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
    const r = await drive(s.handler, { method, url: "/" });
    assert.equal(r.status, 405, `${method} / → 405`);
    assert.equal(r.headers.allow, "GET");
  }
});

test("STATIC: assets served WITHOUT Authorization (token is fragment-only)", async () => {
  const s = makeServer();
  for (const url of ["/", "/index.html", "/styles.css", "/app.js"]) {
    const r = await drive(s.handler, { url }); // no auth header
    assert.equal(r.status, 200, `${url} served without auth`);
  }
});

// =====================================================================
// A4) STRICT CSP on the HTML — least-privilege img-src data: (favicon) ONLY;
//     no inline/eval; no unsafe script/style; assets same-origin only
// =====================================================================
test("CSP: least-privilege img-src data: only (favicon); no unsafe-inline/eval/script/style", async () => {
  const s = makeServer();
  const root = await drive(s.handler, { url: "/" });
  const csp = root.headers["content-security-policy"];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  // The one least-privilege exception: an explicit img-src allows 'self' and
  // inline data: images — solely so the inline data-image favicon loads without
  // a CSP console error (and the browser never auto-requests /favicon.ico).
  assert.match(csp, /img-src 'self' data:/, "explicit img-src 'self' data:");
  // data: is image-ONLY: it must not appear in any non-img directive.
  for (const d of csp.split(";").map((x) => x.trim())) {
    if (d.includes("data:")) {
      assert.equal(d.split(/\s+/)[0], "img-src", "data: allowed only inside img-src");
    }
  }
  // No script/style relaxation and no wildcard — anywhere.
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp), "no unsafe-inline/unsafe-eval");
  assert.ok(!/\*/.test(csp), "no wildcard source");
  assert.doesNotMatch(csp, /script-src[^;]*unsafe/, "no unsafe script-src");
  assert.doesNotMatch(csp, /style-src[^;]*unsafe/, "no unsafe style-src");
});

test("CSP: token never appears in any static asset response", async () => {
  const s = makeServer();
  for (const url of ["/", "/index.html", "/styles.css", "/app.js"]) {
    const r = await drive(s.handler, { url });
    assert.ok(!r.body.includes(s.token), `token absent from ${url} body`);
    assert.ok(!JSON.stringify(r.headers).includes(s.token), `token absent from ${url} headers`);
  }
});

// =====================================================================
// A5) FAIL-CLOSED LOAD — a missing fixed asset rejects the whole server
// =====================================================================
test("LOAD: missing fixed asset → factory throws BEFORE listen (fail-closed)", () => {
  assert.throws(
    () => createOwnerDashboardServer({
      runDir: "/x", workspaceRoot: "/y",
      loadAssetFn: (name) => {
        if (name === "app.js") throw new Error("missing");
        return readFileSync(join(SRC, name));
      },
    }),
    /missing|asset|ENOENT/i,
  );
});

test("LOAD: loadAssetFn injector returns the injected bytes (deterministic)", async () => {
  const s = createOwnerDashboardServer({
    runDir: "/x", workspaceRoot: "/y",
    loadAssetFn: (name) => `/* injected:${name} */`,
  });
  const r = await drive(s.handler, { url: "/app.js" });
  assert.equal(r.status, 200);
  assert.equal(r.body, "/* injected:app.js */");
});

// =====================================================================
// B1) TOKEN HELPERS — fragment parsing, validation, header
// =====================================================================
test("CLIENT TOKEN: isValidToken accepts exactly 64 lowercase hex, rejects the rest", () => {
  assert.equal(app.isValidToken("ab".repeat(32)), true);
  assert.equal(app.isValidToken("0".repeat(64)), true);
  for (const bad of ["", "ab".repeat(31), "ab".repeat(33), "AB".repeat(32), "z".repeat(64), null, 1234, "g".repeat(64)]) {
    assert.equal(app.isValidToken(bad), false);
  }
});

test("CLIENT TOKEN: parseTokenFromHash reads only #token=<64hex>", () => {
  const tok = "cd".repeat(32);
  assert.equal(app.parseTokenFromHash(`#token=${tok}`), tok);
  assert.equal(app.parseTokenFromHash(""), null);
  assert.equal(app.parseTokenFromHash("#token=short"), null);
  assert.equal(app.parseTokenFromHash("#foo=bar"), null);
  assert.equal(app.parseTokenFromHash(`#${tok}`), null); // missing key
  assert.equal(app.parseTokenFromHash(`#token=${tok}&x=1`), null); // extra fragment content
});

test("CLIENT TOKEN: authorizationHeader yields the single Bearer header", () => {
  assert.equal(app.authorizationHeader("ab".repeat(32)), "Bearer " + "ab".repeat(32));
});

// =====================================================================
// B2) TIMELINE MERGE — chronological order, dedup, bounded trim
// =====================================================================
test("CLIENT MERGE: chronological sorts ascending by seq (stable, non-mutating)", () => {
  const input = [
    { seq: 3, category: "message", ts: "c" },
    { seq: 1, category: "message", ts: "a" },
    { seq: 2, category: "command", ts: "b" },
  ];
  const out = app.chronological(input);
  assert.deepEqual(out.map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(input.map((e) => e.seq), [3, 1, 2], "input not mutated");
  // Non-integer seq treated as 0 and ordered first.
  const mixed = app.chronological([{ seq: 5, category: "x", ts: "z" }, { category: "y", ts: "a" }]);
  assert.equal(mixed[0].category, "y");
});

test("CLIENT MERGE: highestSeq returns max integer seq, else 0", () => {
  assert.equal(app.highestSeq([{ seq: 7 }, { seq: 3 }, { seq: 9 }]), 9);
  assert.equal(app.highestSeq([]), 0);
  assert.equal(app.highestSeq([{ category: "x" }]), 0);
});

test("CLIENT MERGE: appendNewer dedups overlapping fetches and stays chronological", () => {
  const existing = [
    { seq: 1, category: "message", ts: "a" },
    { seq: 2, category: "message", ts: "b" },
  ];
  const incoming = [
    { seq: 2, category: "message", ts: "b" }, // duplicate
    { seq: 3, category: "command", ts: "c" }, // newer
  ];
  const out = app.appendNewer(existing, incoming);
  assert.deepEqual(out.map((e) => e.seq), [1, 2, 3]);
  assert.equal(out.length, 3, "duplicate dropped");
});

test("CLIENT MERGE: trimOldest keeps the newest cap, drops oldest", () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ seq: i, category: "x", ts: String(i) }));
  const out = app.trimOldest(entries, 4);
  assert.deepEqual(out.map((e) => e.seq), [6, 7, 8, 9]);
  // cap not exceeded → unchanged (chronological)
  assert.equal(app.trimOldest(entries.slice(0, 3), 4).length, 3);
});

// =====================================================================
// B3) SAFE ENTRY PROJECTION — reads ONLY known safe keys per category
// =====================================================================
test("CLIENT SAFE: describeEntry reads only safe fields per category", () => {
  assert.deepEqual(app.describeEntry({ category: "message", role: "assistant", text: "hi", truncated: false, ts: "t", seq: 1 }),
    { category: "message", ts: "t", body: "assistant: hi", mono: false });
  assert.deepEqual(app.describeEntry({ category: "message", role: "assistant", text: "hi", truncated: true, ts: "t", seq: 1 }),
    { category: "message", ts: "t", body: "assistant: hi …[truncated]", mono: false });
  for (const st of ["ok", "failed", "unknown"]) {
    const d = app.describeEntry({ category: "command", exitStatus: st, ts: "t", seq: 1 });
    assert.equal(d.body, `command · exit ${st}`);
    assert.equal(d.mono, true);
  }
  // Unknown exitStatus collapses to the closed set, never echoes raw.
  assert.equal(app.describeEntry({ category: "command", exitStatus: 137, ts: "t", seq: 1 }).body, "command · exit unknown");
  assert.equal(app.describeEntry({ category: "tool_use", tool: "Read", ts: "t", seq: 1 }).body, "tool · Read");
  assert.equal(app.describeEntry({ category: "tool_result", isError: true, ts: "t", seq: 1 }).body, "tool result · error");
  assert.equal(app.describeEntry({ category: "tool_result", isError: false, ts: "t", seq: 1 }).body, "tool result · ok");
  assert.equal(app.describeEntry({ category: "file_written", path: "src/x.js", ts: "t", seq: 1 }).body, "wrote · src/x.js");
  assert.equal(app.describeEntry({ category: "runtime_status", status: "provider_retry", ts: "t", seq: 1 }).body,
    "runtime · provider retry");
  assert.equal(app.describeEntry({ category: "runtime_status", status: "SECRET", ts: "t", seq: 1 }).body,
    "runtime · unknown");
  assert.equal(app.describeEntry({ category: "state", to: "completed", ts: "t", seq: 1 }).body, "state → completed");
  assert.equal(app.describeEntry({ category: "other", ts: "t", seq: 1 }).body, "[unknown_event]");
});

test("CLIENT SAFE: describeEntry never surfaces raw command / prompt / payload", () => {
  // A hostile entry carrying dangerous fields: only the closed-set label is used.
  const hostile = app.describeEntry({
    category: "other", label: "[unknown_event]", ts: "t", seq: 1,
    rawCommand: "rm -rf /", prompt: "secret", token: "leak", pid: 1234,
  });
  assert.equal(hostile.body, "[unknown_event]");
  assert.ok(!hostile.body.includes("rm -rf"));
  assert.ok(!hostile.body.includes("secret"));
  // Unknown category collapses to other (closed set).
  const unknownCat = app.describeEntry({ category: "bogus", ts: "t", seq: 1 });
  assert.equal(unknownCat.category, "other");
});

// =====================================================================
// B4) LIVENESS — relative age only, never PID/path/session
// =====================================================================
test("CLIENT LIVENESS: livenessDescription renders relative age only", () => {
  assert.equal(app.livenessDescription({ ownerHeartbeat: "fresh", secondsSinceHeartbeat: 4 }), "liveness fresh · 4s");
  assert.equal(app.livenessDescription({ ownerHeartbeat: "stale", secondsSinceHeartbeat: 130 }), "liveness stale · 2m");
  assert.equal(app.livenessDescription({ ownerHeartbeat: "n/a", secondsSinceHeartbeat: null }), "liveness n/a");
  assert.equal(app.livenessDescription(null), "liveness n/a");
});

// =====================================================================
// B5) FILTERS + POLL PARAMS
// =====================================================================
test("CLIENT FILTER: runIndex exact match; filterRuns by q/state/agent", () => {
  const runs = [
    { runId: "run_a", agentId: "coder_low", state: "running" },
    { runId: "run_b", agentId: "coder_hq", state: "completed" },
  ];
  assert.equal(app.runIndex(runs, "run_b"), 1);
  assert.equal(app.runIndex(runs, "run_x"), -1);
  assert.deepEqual(app.filterRuns(runs, { q: "A" }).map((r) => r.runId), ["run_a"]); // case-insensitive
  assert.deepEqual(app.filterRuns(runs, { state: "completed" }).map((r) => r.runId), ["run_b"]);
  assert.deepEqual(app.filterRuns(runs, { agent: "coder_low" }).map((r) => r.runId), ["run_a"]);
  assert.deepEqual(app.filterRuns(runs, {}).map((r) => r.runId), ["run_a", "run_b"]);
});

test("CLIENT FILTER: filterByCategories — empty set means all", () => {
  const entries = [{ category: "message" }, { category: "command" }, { category: "state" }];
  assert.equal(app.filterByCategories(entries, new Set()).length, 3);
  assert.equal(app.filterByCategories(entries, new Set(["message"])).length, 1);
});

test("CLIENT POLL: pollParams yields afterSeq+asc for the visible poll", () => {
  assert.deepEqual(app.pollParams(42), { afterSeq: 42, order: "asc" });
  assert.deepEqual(app.pollParams(0), { afterSeq: 0, order: "asc" });
  assert.deepEqual(app.pollParams(-5), { afterSeq: 0, order: "asc" });
});

test("CLIENT AGE: relativeAge from ISO updatedAt vs injected now", () => {
  const now = Date.parse("2026-08-02T12:00:00Z");
  assert.equal(app.relativeAge("2026-08-02T11:59:58Z", now), "now"); // 2s
  assert.equal(app.relativeAge("2026-08-02T11:59:50Z", now), "10s"); // 10s
  assert.equal(app.relativeAge("2026-08-02T11:58:00Z", now), "2m"); // 120s
  assert.equal(app.relativeAge("2026-08-02T10:00:00Z", now), "2h"); // 7200s
  assert.equal(app.relativeAge(null, now), "—");
  assert.equal(app.relativeAge("not-a-date", now), "—");
});

// =====================================================================
// B6) HTML CONTRACT — NO inline scripts/styles, NO remote assets, NO handlers
// =====================================================================
test("HTML CONTRACT: no inline <script>/<style>, no on* handlers, no remote URLs", () => {
  const html = readAsset("index.html");
  // The only script must be the external module.
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
  assert.equal(scripts.length, 1, "exactly one script tag");
  assert.match(scripts[0], /src="app\.js"/, "script is external app.js");
  assert.ok(!/src="[^"]*":|^src="\/\//.test(scripts[0]), "no absolute script src");
  assert.doesNotMatch(scripts[0], /type="text\/(javascript|ecmascript)"/, "module, not classic-inline");
  // No inline style block, no style= attributes, no inline event handlers.
  assert.doesNotMatch(html, /<style[\s>]/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=\s*"/i);
  // No remote http(s) assets (everything is same-origin relative).
  assert.doesNotMatch(html, /https?:\/\//i);
  // CSS/JS are referenced relatively.
  assert.match(html, /<link[^>]+href="styles\.css"/);
});

test("CSS CONTRACT: no remote url()/imports", () => {
  const css = readAsset("styles.css");
  assert.doesNotMatch(css, /url\(/i);
  assert.doesNotMatch(css, /@import/i);
  assert.doesNotMatch(css, /https?:\/\//i);
});

// =====================================================================
// B7) APP.JS CONTRACT — token used ONLY in Authorization; never DOM/log/error
// =====================================================================
test("APP.JS CONTRACT: token is sent only as Authorization; never innerHTML", () => {
  const js = readAsset("app.js");
  // Authorization is built in exactly one place (authorizationHeader).
  const authUsages = js.match(/authorizationHeader\(/g) || [];
  assert.ok(authUsages.length >= 1, "uses authorizationHeader");
  // Dynamic rendering uses textContent, never innerHTML with data.
  assert.doesNotMatch(js, /\.innerHTML\s*=/, "never assigns innerHTML");
  // Token is never logged or concatenated into an error message.
  assert.doesNotMatch(js, /console\.(log|error|warn|info)\([^)]*token/i, "token never logged");
  assert.doesNotMatch(js, /new Error\([^)]*token/i, "token never in Error text");
  // Only the Authorization header carries the token to /api/*.
  const fetchHeaders = js.match(/headers:\s*{\s*authorization:[^}]*}/gi) || [];
  assert.ok(fetchHeaders.length >= 1, "fetch sends only authorization header");
});

// =====================================================================
// B8) BROWSER-ACCEPTANCE CORRECTIONS — two observed UI defects
// =====================================================================

// Defect #1: at a narrow viewport (e.g. 390x844) the 100-item Recent runs list
// rendered at full height and pushed the selected-run activity below every run,
// so the activity was unreachable without scrolling past all 100 runs. The causal
// fix bounds the runs list in the stacked (narrow) media query so it scrolls
// internally; the detail pane stays reachable in the same viewport flow.
test("RESPONSIVE (defect #1): narrow run list is bounded + independently scrollable; desktop preserved", () => {
  const css = readAsset("styles.css");
  const mediaAt = css.indexOf("@media");
  assert.ok(mediaAt > 0, "a responsive media query exists");
  const base = css.slice(0, mediaAt);
  const narrow = css.slice(mediaAt);
  // Narrow: the run list is height-bounded (a viewport fraction, not a runaway
  // value) and scrolls internally, so it cannot push the detail below all runs.
  assert.match(narrow, /\.run-list\s*\{[^}]*max-height\s*:\s*([\d.]+vh)/,
    "run-list has a vh max-height on narrow viewports");
  assert.match(narrow, /\.run-list\s*\{[^}]*overflow-y\s*:\s*(?:auto|scroll)/,
    "run-list scrolls internally on narrow viewports");
  const vh = parseFloat(narrow.match(/\.run-list\s*\{[^}]*max-height\s*:\s*([\d.]+vh)/)[1]);
  assert.ok(vh > 0 && vh < 60, `run-list bound (${vh}vh) leaves room for the detail pane`);
  // Desktop is unchanged: the base .run-list rule must NOT cap height, so the
  // two-column layout behaves exactly as before.
  const baseRule = base.match(/\.run-list\s*\{([\s\S]*?)\}/);
  assert.ok(baseRule, "base .run-list rule exists");
  assert.doesNotMatch(baseRule[1], /max-height/, "desktop run list is not height-bounded");
});

// Defect #2: the browser auto-requests /favicon.ico whenever no in-page icon is
// declared, producing a 404 against the read-only static boundary. The causal fix
// declares an inline data favicon in the HTML, so the browser resolves the icon
// in-page and never issues the /favicon.ico request — no binary asset, no new
// path/endpoint, no remote URL, and no server-behavior change.
test("FAVICON (defect #2): HTML declares an inline data IMAGE favicon (loads under img-src data:; no /favicon.ico)", () => {
  const html = readAsset("index.html");
  const iconLinks = [...html.matchAll(/<link\b[^>]*\brel\s*=\s*["']icon["'][^>]*>/gi)];
  assert.ok(iconLinks.length >= 1, "an <link rel=\"icon\"> is declared");
  const icon = iconLinks[0][0];
  // A data IMAGE (not empty data:,) renders as a real favicon and is exactly what
  // img-src data: permits — so the browser is satisfied in-page and never issues
  // the automatic /favicon.ico request (no 404) and no CSP console error.
  assert.match(icon, /href\s*=\s*["']data:image\//i, "favicon href is an inline data IMAGE");
  assert.doesNotMatch(icon, /https?:\/\//i, "favicon carries no remote URL");
});

test("FAVICON (defect #2): no /favicon.ico server route — fix is client-side only", async () => {
  const s = makeServer();
  const r = await drive(s.handler, { url: "/favicon.ico" });
  assert.equal(r.status, 404, "/favicon.ico is not a server route (no endpoint/path added)");
  assert.deepEqual(JSON.parse(r.body), { error: "not_found" });
});

// =====================================================================
// B9) M12-8 POLLING-TRUTH CORRECTIONS
//   M1: every continuation page in a live-poll snapshot preserves the exact
//       afterSeq + order=asc binding (cursor-follow used to drop afterSeq).
//   M2: runs-list freshness and selected-activity freshness are separate; a
//       failed/unavailable activity read stays visibly stale/unavailable and
//       cannot be healed by a successful runs-list refresh. A later successful
//       activity poll may restore live.
// Deterministic tests over the pure state machine / URL builder the polling
// surface reduces to (no DOM, no source-text assertions).
// =====================================================================

// ---- M1: pollRequestUrl preserves the snapshot afterSeq on every page ----

test("M1 POLL URL: page 1 carries afterSeq+order+pageSize and no cursor", () => {
  const u = app.pollRequestUrl("run_x", app.pollParams(42), null);
  assert.match(u, /^\/api\/activity\?runId=run_x/);
  assert.match(u, /afterSeq=42/);
  assert.match(u, /order=asc/);
  assert.match(u, /pageSize=50/);
  assert.doesNotMatch(u, /cursor=/);
});

test("M1 POLL URL: every cursor continuation carries the SAME afterSeq binding", () => {
  // The defect: cursor-follow requests dropped afterSeq, so a continuation page
  // was no longer bound to the snapshot's "seq > afterSeq" view — a cursor
  // view/filter mismatch. Every page in the snapshot must carry the identical
  // afterSeq + order=asc that page 1 established.
  const params = app.pollParams(77);
  const first = app.pollRequestUrl("run_a", params, null);
  const cont1 = app.pollRequestUrl("run_a", params, "cur-1");
  const cont2 = app.pollRequestUrl("run_a", params, "cur-2");
  for (const u of [first, cont1, cont2]) {
    assert.match(u, /afterSeq=77/, "page carries the snapshot afterSeq");
    assert.match(u, /order=asc/, "page carries order=asc");
  }
  assert.doesNotMatch(first, /cursor=/, "page 1 has no cursor");
  assert.match(cont1, /cursor=cur-1/);
  assert.match(cont2, /cursor=cur-2/);
  // The afterSeq value is byte-identical across the whole snapshot.
  const seq = (u) => u.match(/afterSeq=(\d+)/)[1];
  assert.equal(seq(first), "77");
  assert.equal(seq(cont1), "77", "continuation preserves the exact afterSeq");
  assert.equal(seq(cont2), "77", "continuation preserves the exact afterSeq");
});

test("M1 POLL URL: continuation omits pageSize (cursor paging behavior unchanged; only afterSeq is added)", () => {
  // Continuation pages intentionally omit pageSize so a cursor read uses the
  // same server default as before — the fix adds ONLY afterSeq, leaving paging
  // behavior unchanged. Page 1 still carries pageSize=50.
  const params = app.pollParams(5);
  const first = app.pollRequestUrl("run_b", params, null);
  const cont = app.pollRequestUrl("run_b", params, "abc");
  assert.match(first, /pageSize=50/);
  assert.doesNotMatch(cont, /pageSize=/, "continuation has no pageSize (unchanged)");
});

test("M1 POLL URL: simulates the pollOnce cursor-follow loop — every URL preserves afterSeq", () => {
  // Mirrors pollOnce: page 1 then up to 4 cursor continuations. The collected
  // URL list is the exact request sequence the surface issues; every URL must
  // carry the snapshot's afterSeq. The old inline builder dropped afterSeq on
  // continuations, so this loop would emit afterSeq-less URLs and fail here.
  function snapshot(maxSeq, cursors) {
    const params = app.pollParams(maxSeq);
    const urls = [app.pollRequestUrl("run_c", params, null)];
    for (const c of cursors) urls.push(app.pollRequestUrl("run_c", params, c));
    return urls;
  }
  const urls = snapshot(99, ["c1", "c2", "c3", "c4"]); // guard < 4 mirrors the loop cap
  assert.equal(urls.length, 5);
  for (const u of urls) {
    assert.match(u, /afterSeq=99/, "every continuation preserves afterSeq");
    assert.match(u, /order=asc/);
  }
  // Snapshot binding invariant: one identical afterSeq across all pages.
  const vals = new Set(urls.map((u) => u.match(/afterSeq=(\d+)/)[1]));
  assert.deepEqual([...vals], ["99"]);
});

test("M1 POLL URL: afterSeq clamped to 0 on every page (matches pollParams)", () => {
  for (const bad of [0, -5, NaN, "x", undefined]) {
    const params = { afterSeq: bad, order: "asc" };
    const first = app.pollRequestUrl("run_d", params, null);
    const cont = app.pollRequestUrl("run_d", params, "z");
    assert.match(first, /afterSeq=0/, `page 1 clamps afterSeq=${String(bad)}`);
    assert.match(cont, /afterSeq=0/, `continuation clamps afterSeq=${String(bad)}`);
  }
});

// ---- M2: deriveStatus — the pure status state machine the surface uses ----

test("M2 STATUS: both fresh + run selected + activity live → live", () => {
  assert.deepEqual(
    app.deriveStatus({ runsFresh: true, activityFresh: true, sessionEnded: false, runSelected: true }),
    { stale: false, text: "live" },
  );
});

test("M2 STATUS: no run selected, runs fresh → connected", () => {
  assert.deepEqual(
    app.deriveStatus({ runsFresh: true, activityFresh: null, sessionEnded: false, runSelected: false }),
    { stale: false, text: "connected" },
  );
});

test("M2 STATUS: unavailable/failed activity is stale EVEN when runs are fresh (the defect)", () => {
  // The defect: an unavailable/failed activity read preserved last-good entries
  // but the shared status was reset to live/connected. With separated freshness,
  // activityFresh === false keeps the evidence visibly stale regardless of runs.
  for (const runsFresh of [true, false]) {
    const s = app.deriveStatus({ runsFresh, activityFresh: false, sessionEnded: false, runSelected: true });
    assert.equal(s.stale, true, `stale when runsFresh=${runsFresh}`);
    assert.equal(s.text, "refresh failed — showing last view");
  }
});

test("M2 STATUS: a successful runs-list refresh CANNOT heal a stale activity", () => {
  // Sequence over the pure state machine the polling surface reduces to:
  //   1) activity read unavailable/failed → stale
  //   2) runs-list refresh succeeds (runsFresh true; activityFresh unchanged)
  //      → STILL stale. The old shared-flag code healed at step 2 (refreshRuns
  //      set stale=false and status "connected").
  let st = { runsFresh: true, activityFresh: false, sessionEnded: false, runSelected: true };
  assert.equal(app.deriveStatus(st).stale, true);
  // Runs-list refresh owns ONLY runsFresh.
  st = { ...st, runsFresh: true };
  const after = app.deriveStatus(st);
  assert.equal(after.stale, true, "runs refresh does not heal activity staleness");
  assert.equal(after.text, "refresh failed — showing last view");
});

test("M2 STATUS: a subsequent successful activity poll RESTORES live", () => {
  let st = { runsFresh: true, activityFresh: false, sessionEnded: false, runSelected: true };
  assert.equal(app.deriveStatus(st).stale, true);
  st = { ...st, activityFresh: true };
  assert.deepEqual(app.deriveStatus(st), { stale: false, text: "live" });
});

test("M2 STATUS: runs-list failure is stale even with activity live (stale if EITHER source stale)", () => {
  const s = app.deriveStatus({ runsFresh: false, activityFresh: true, sessionEnded: false, runSelected: true });
  assert.equal(s.stale, true);
  assert.equal(s.text, "refresh failed — showing last view");
});

test("M2 STATUS: runs-list failure with no run selected → stale", () => {
  const s = app.deriveStatus({ runsFresh: false, activityFresh: null, sessionEnded: false, runSelected: false });
  assert.equal(s.stale, true);
  assert.equal(s.text, "refresh failed — showing last view");
});

test("M2 STATUS: session ended overrides everything (token revoked)", () => {
  for (const runSelected of [true, false]) {
    for (const activityFresh of [true, false, null]) {
      const s = app.deriveStatus({ runsFresh: true, activityFresh, sessionEnded: true, runSelected });
      assert.equal(s.stale, true, `stale (runSelected=${runSelected}, activityFresh=${activityFresh})`);
      assert.equal(s.text, "session ended — reopen from CLI");
    }
  }
});

test("M2 STATUS: a freshly-selected run (activity loading) is NOT falsely stale", () => {
  // Selecting a run resets activity and starts bootstrap; during that in-flight
  // read the status must not flash "refresh failed". activityFresh === null is
  // "unknown/loading", not "failed".
  const loading = app.deriveStatus({ runsFresh: true, activityFresh: null, sessionEnded: false, runSelected: true });
  assert.equal(loading.stale, false);
  assert.equal(loading.text, "connected");
});

test("M2 STATUS: end-to-end state walk over the polling/refresh surface (deterministic)", () => {
  // Walks the exact freshness transitions the dashboard's polling + runs-refresh
  // surface produces, reducing each via deriveStatus (the pure machine setStatus
  // applies to the DOM). Proves the corrected truth: an unavailable activity
  // stays stale across a runs refresh, then restores live on the next good poll.
  let s = { runsFresh: true, activityFresh: null, sessionEnded: false, runSelected: false };
  assert.equal(app.deriveStatus(s).text, "connected");        // boot, no selection
  s = { ...s, runSelected: true };                             // user selects a run
  assert.equal(app.deriveStatus(s).text, "connected");        // loading — not stale
  s = { ...s, activityFresh: true };                           // bootstrap ok
  assert.equal(app.deriveStatus(s).text, "live");
  s = { ...s, activityFresh: false };                          // poll available:false / fails
  assert.equal(app.deriveStatus(s).stale, true);
  s = { ...s, runsFresh: true };                               // runs-list refresh succeeds
  assert.equal(app.deriveStatus(s).stale, true, "runs refresh cannot heal activity");
  s = { ...s, runsFresh: false };                              // runs refresh fails too
  assert.equal(app.deriveStatus(s).stale, true);
  s = { ...s, runsFresh: true, activityFresh: true };          // activity poll succeeds again
  assert.equal(app.deriveStatus(s).text, "live");             // restored
});

// =====================================================================
// C) M12-17 — OWNER DETAILS + OPT-IN TERMINAL NOTIFICATION
//   1. state-filter closed set matches RUN_STATES + "unknown" (no "stopped").
//   2. A selected run that falls out of the bounded top-100 list stays
//      selected and keeps refreshing; absence is NEVER reported as terminal.
//   3. The detail pane renders ONLY the safe /api/runs + /api/activity
//      projection fields (backend, terminal flag, activity total/counts,
//      liveness, scopeObservation summary) — never prompt/token/session/
//      absolute path/raw command.
//   4. Browser notifications are opt-in via an explicit button (user
//      gesture); the post-load baseline never notifies; only a run observed
//      non-terminal THEN terminal notifies, at most once per run per page
//      session; unsupported/denied degrades quietly.
//   5. Notification payloads carry ONLY fixed safe fields (terminal state,
//      agentId, runId).
// =====================================================================

// ---- C1) STATE FILTER CLOSED SET ----

test("M12-17 STATES: FILTER_STATES is the exact closed set (RUN_STATES + unknown); no stopped", () => {
  assert.ok(Array.isArray(app.FILTER_STATES), "FILTER_STATES exported");
  assert.deepEqual([...app.FILTER_STATES], [
    "pending", "submitted", "running", "completed", "failed", "aborted", "timed_out", "unknown",
  ]);
  assert.ok(Object.isFrozen(app.FILTER_STATES), "closed set is frozen");
  assert.ok(!app.FILTER_STATES.includes("stopped"), "nonexistent stopped state is gone");
});

test("M12-17 STATES: HTML state-filter options equal the closed set exactly (all + 8 states, in order)", () => {
  const html = readAsset("index.html");
  const sel = html.match(/<select id="state-filter"[\s\S]*?<\/select>/);
  assert.ok(sel, "state-filter select exists");
  const values = [...sel[0].matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(values, ["", ...app.FILTER_STATES], "options = all + closed set, in closed-set order");
  assert.ok(!values.includes("stopped"), "stopped option removed from the HTML");
});

test("M12-17 STATES: filterRuns applies only closed-set states; an out-of-set value is ignored", () => {
  const runs = ["pending", "submitted", "running", "completed", "failed", "aborted", "timed_out", "unknown"]
    .map((st) => ({ runId: `r_${st}`, state: st, agentId: "a" }));
  for (const st of app.FILTER_STATES) {
    assert.deepEqual(app.filterRuns(runs, { state: st }).map((r) => r.runId), [`r_${st}`],
      `state=${st} filters exactly`);
  }
  // "stopped" matches no real state (server never emits it): the filter must
  // not silently filter by an arbitrary out-of-set string — it is ignored.
  assert.equal(app.filterRuns(runs, { state: "stopped" }).length, runs.length,
    "out-of-set state filter is ignored, not exact-matched");
});

// ---- C2) SELECTION RETENTION (selected run outside the bounded list) ----

test("M12-17 RETENTION: retainSelectedRun resolves the listed run or null — selection itself survives", () => {
  const runs = [{ runId: "run_a", state: "running" }, { runId: "run_b", state: "completed" }];
  assert.equal(app.retainSelectedRun(runs, "run_a").state, "running", "listed → the run facts");
  assert.equal(app.retainSelectedRun(runs, "run_z"), null, "unlisted → null (detail keeps polling)");
  assert.equal(app.retainSelectedRun([], "run_a"), null);
  assert.equal(app.retainSelectedRun(runs, null), null);
  assert.equal(app.retainSelectedRun(null, "run_a"), null);
});

test("M12-17 RETENTION: no code path clears the selection on a runs-list refresh", () => {
  const js = readAsset("app.js");
  // The old defect cleared state.selectedRunId when the run left the bounded
  // top-100. Boot initialization uses the object literal `selectedRunId: null`
  // (a colon) — an assignment `selectedRunId = null` must not exist anywhere.
  assert.doesNotMatch(js, /selectedRunId\s*=\s*null/, "selection is never cleared after boot");
  assert.match(js, /retainSelectedRun\(/, "detail render resolves listed facts via the pure helper");
});

test("M12-17 RETENTION: selected run unlisted + activity unavailable degrades to n/a, NEVER terminal", () => {
  // High-risk combination (WQ-02): the selected run fell out of the bounded
  // list AND the last activity read failed/been unavailable. Every fact helper
  // must degrade to blank/n-a — "missing" is never misreported as terminal.
  assert.equal(app.retainSelectedRun([], "run_gone"), null);
  assert.equal(app.detailStateText(null, null), null, "no state → n/a pill, not a terminal label");
  assert.equal(app.terminalFact(null, null), "", "no terminal fact → blank, not terminal");
  assert.equal(app.backendFact(null), "");
  assert.equal(app.activityTotalFact(null), "");
  assert.equal(app.scopeObservationSummary(undefined), "scope n/a");
});

// ---- C3) DETAIL PANEL — safe projection fields only ----

test("M12-17 DETAIL: statePillClass gates class names to the closed set", () => {
  assert.equal(app.statePillClass("pending"), "s-pending");
  assert.equal(app.statePillClass("submitted"), "s-submitted");
  assert.equal(app.statePillClass("aborted"), "s-aborted");
  assert.equal(app.statePillClass("running"), "s-running");
  assert.equal(app.statePillClass("unknown"), "s-unknown");
  assert.equal(app.statePillClass("garbage state"), "s-na", "unparseable/arbitrary → s-na");
  assert.equal(app.statePillClass(""), "s-na");
  assert.equal(app.statePillClass(null), "s-na");
});

test("M12-17 DETAIL: detailStateText prefers the fresher activity state, falls back to the listed run", () => {
  const listed = { runId: "r", state: "running" };
  assert.equal(app.detailStateText({ state: "completed" }, listed), "completed",
    "activity poll (2s) is fresher than the runs list (5s)");
  assert.equal(app.detailStateText(null, listed), "running", "activity loading → listed run state");
  assert.equal(app.detailStateText({ state: "garbage" }, null), null, "out-of-set collapses to n/a");
  assert.equal(app.detailStateText(null, null), null);
  assert.equal(app.detailStateText({ state: 42 }, { state: "unknown" }), "unknown");
});

test("M12-17 DETAIL: backend/terminal/total facts come from the safe activity projection only", () => {
  const act = { backend: "stream-json", terminal: true, total: 42 };
  assert.equal(app.backendFact(act), "backend stream-json");
  assert.equal(app.backendFact(null), "");
  assert.equal(app.backendFact({}), "");
  assert.equal(app.terminalFact(act, null), "terminal");
  assert.equal(app.terminalFact({ terminal: false }, null), "non-terminal");
  assert.equal(app.terminalFact(null, { terminal: true }), "terminal", "activity missing → listed run fact");
  assert.equal(app.terminalFact(null, { terminal: false }), "non-terminal");
  assert.equal(app.terminalFact(null, null), "", "neither source → blank (missing, not terminal)");
  assert.equal(app.activityTotalFact(act), "42 events");
  assert.equal(app.activityTotalFact({ total: 0 }), "0 events");
  assert.equal(app.activityTotalFact({}), "");
  assert.equal(app.activityTotalFact(null), "");
});

test("M12-17 DETAIL: scopeObservationSummary is closed-set and never echoes any path", () => {
  assert.equal(app.scopeObservationSummary(null), "scope n/a");
  assert.equal(app.scopeObservationSummary({}), "scope unknown");
  assert.equal(app.scopeObservationSummary({ status: "unknown" }), "scope unknown");
  assert.equal(app.scopeObservationSummary({ status: "garbage", outsidePaths: ["D:/x"] }), "scope unknown",
    "out-of-set status collapses to unknown");
  const within = app.scopeObservationSummary({ status: "within_declared_paths", observedFileCount: 7 });
  assert.match(within, /within declared paths · 7/, "within summary carries the observed count");
  const out = app.scopeObservationSummary({
    status: "outside_declared_paths", observedFileCount: 5, outsidePathCount: 2,
    outsidePaths: ["D:/secret/abs", "prompt text"], outsidePathsTruncated: false,
  });
  assert.match(out, /outside declared paths · 2 of 5/, "outside summary carries counts only");
  assert.ok(!out.includes("D:/secret"), "never an absolute path");
  assert.ok(!out.includes("prompt text"), "never the path list content");
});

test("M12-17 HTML: detail pane exposes backend/terminal/total/scope/unlisted safe slots", () => {
  const html = readAsset("index.html");
  for (const id of ["detail-backend", "detail-terminal", "detail-total", "detail-scope", "detail-unlisted"]) {
    assert.ok(html.includes(`id="${id}"`), `#${id} present`);
  }
});

test("M12-17 APP: detail render composes the pure fact helpers (no ad-hoc DOM derivation)", () => {
  const js = readAsset("app.js");
  for (const fn of [
    "detailStateText", "backendFact", "terminalFact", "activityTotalFact", "scopeObservationSummary", "statePillClass",
  ]) {
    assert.match(js, new RegExp(fn + "\\("), `${fn} used`);
  }
});

test("M12-17 SAFE: app.js never reads prompt/session/absolute-path/raw-command fields", () => {
  const js = readAsset("app.js");
  assert.doesNotMatch(js, /\.(prompt|sessionId|serveUrl|worktreePath|cwd|rawCommand|argv|pid)\b/,
    "detail/notification rendering reads only fixed safe fields");
});

// ---- C4) OPT-IN TERMINAL NOTIFICATIONS ----

test("M12-17 NOTIFY: notificationPermission maps the capability honestly (quiet degrade)", () => {
  assert.equal(app.notificationPermission(undefined), "unsupported");
  assert.equal(app.notificationPermission(null), "unsupported");
  assert.equal(app.notificationPermission({}), "unsupported");
  assert.equal(app.notificationPermission({ permission: "garbage" }), "unsupported");
  assert.equal(app.notificationPermission({ permission: "granted" }), "granted");
  assert.equal(app.notificationPermission({ permission: "denied" }), "denied");
  assert.equal(app.notificationPermission({ permission: "default" }), "default");
});

test("M12-17 NOTIFY: notifyButtonState — enable only by click; denied/unsupported quiet", () => {
  assert.deepEqual(app.notifyButtonState("granted", true), { disabled: true, label: "notifications on" });
  assert.deepEqual(app.notifyButtonState("default", true), { disabled: true, label: "notifications on" });
  assert.deepEqual(app.notifyButtonState("granted", false), { disabled: false, label: "enable notifications" });
  assert.deepEqual(app.notifyButtonState("default", false), { disabled: false, label: "enable notifications" });
  assert.deepEqual(app.notifyButtonState("denied", false), { disabled: true, label: "notifications blocked" });
  assert.deepEqual(app.notifyButtonState("unsupported", false), { disabled: true, label: "notifications n/a" });
});

test("M12-17 NOTIFY: reload baseline — already-terminal runs at first observation NEVER notify", () => {
  const plan = app.planTerminalNotifications({}, [
    { runId: "run_a", agentId: "coder_low", state: "completed", terminal: true },
    { runId: "run_b", agentId: "coder_low", state: "failed", terminal: true },
    { runId: "run_c", agentId: "coder_low", state: "running", terminal: false },
  ]);
  assert.deepEqual(plan.notifications, [], "first observation is the baseline — zero notifications");
  assert.deepEqual(plan.observed, { run_a: true, run_b: true, run_c: false });
});

test("M12-17 NOTIFY: running→terminal notifies EXACTLY once; repeated terminal polls never re-notify", () => {
  let plan = app.planTerminalNotifications({}, [
    { runId: "run_a", agentId: "coder_low", state: "running", terminal: false },
  ]);
  assert.equal(plan.notifications.length, 0, "baseline: running observed");
  plan = app.planTerminalNotifications(plan.observed, [
    { runId: "run_a", agentId: "coder_low", state: "completed", terminal: true },
  ]);
  assert.equal(plan.notifications.length, 1, "the observed transition fires exactly one notification");
  const n = plan.notifications[0];
  assert.equal(n.runId, "run_a");
  assert.equal(n.agentId, "coder_low");
  assert.equal(n.state, "completed");
  assert.equal(n.body, "run_a");
  assert.equal(typeof n.title, "string");
  for (let i = 0; i < 3; i += 1) {
    plan = app.planTerminalNotifications(plan.observed, [
      { runId: "run_a", agentId: "coder_low", state: "completed", terminal: true },
    ]);
    assert.equal(plan.notifications.length, 0, `repeat poll ${i + 1} must not re-notify`);
  }
});

test("M12-17 NOTIFY: non-terminal→non-terminal never notifies; the input observed map is not mutated", () => {
  const observed = { run_a: false };
  const plan = app.planTerminalNotifications(observed, [
    { runId: "run_a", agentId: "a", state: "running", terminal: false },
  ]);
  assert.deepEqual(plan.notifications, []);
  assert.deepEqual(observed, { run_a: false }, "input object untouched (pure)");
  assert.notEqual(plan.observed, observed, "a new map is returned");
});

test("M12-17 NOTIFY: absence from the bounded list is NEVER terminal; a later observed re-entry transition notifies", () => {
  let plan = app.planTerminalNotifications({}, [
    { runId: "run_a", agentId: "a", state: "running", terminal: false },
  ]);
  // The run falls out of the bounded top-100: no observation, no notification,
  // and the prior non-terminal observation is PRESERVED (not reset, not terminal).
  plan = app.planTerminalNotifications(plan.observed, []);
  assert.deepEqual(plan.notifications, [], "absence notifies nothing");
  assert.deepEqual(plan.observed, { run_a: false }, "absence never marks terminal");
  // The run re-enters the list as terminal: the transition (from the last
  // observed non-terminal state) is exactly what must notify — once.
  plan = app.planTerminalNotifications(plan.observed, [
    { runId: "run_a", agentId: "a", state: "failed", terminal: true },
  ]);
  assert.equal(plan.notifications.length, 1);
  assert.equal(plan.notifications[0].state, "failed");
});

test("M12-17 NOTIFY: payload carries ONLY runId/agentId/state — never prompt/path/token/session/command", () => {
  const plan = app.planTerminalNotifications({ run_a: false }, [{
    runId: "run_a", agentId: "coder_mm", state: "completed", terminal: true,
    prompt: "SECRET PROMPT", path: "D:/abs/secret", token: "deadbeef",
    sessionId: "sess-1", command: "rm -rf /", worktreePath: "D:/wt",
  }]);
  assert.equal(plan.notifications.length, 1);
  const s = JSON.stringify(plan.notifications[0]);
  for (const bad of ["SECRET PROMPT", "D:/abs", "deadbeef", "sess-1", "rm -rf", "D:/wt"]) {
    assert.ok(!s.includes(bad), `notification must not contain ${bad}`);
  }
});

test("M12-17 NOTIFY: terminalNotification gates the state to the terminal closed set", () => {
  assert.equal(app.terminalNotification({ runId: "r", agentId: "a", state: "running", terminal: false }), null,
    "non-terminal → no notification descriptor");
  assert.equal(app.terminalNotification({ terminal: true, state: "completed" }), null, "runId required");
  assert.equal(app.terminalNotification(null), null);
  const weird = app.terminalNotification({ runId: "r", agentId: "a", state: "garbage", terminal: true });
  assert.equal(weird.state, "unknown", "out-of-set terminal state collapses to unknown");
  const ok = app.terminalNotification({ runId: "r", agentId: "a", state: "timed_out", terminal: true });
  assert.equal(ok.state, "timed_out");
  assert.ok(ok.title.includes("timed_out"), "title carries the terminal state");
  assert.ok(ok.title.includes("a"), "title carries the agentId");
  assert.equal(ok.body, "r", "body is the runId");
});

test("M12-17 HTML: notification enable control is an explicit button (user gesture), initially hidden", () => {
  const html = readAsset("index.html");
  const btn = html.match(/<button id="notify-toggle"[^>]*>/);
  assert.ok(btn, "notify-toggle button exists");
  assert.match(btn[0], /type="button"/);
  assert.match(btn[0], /hidden/, "starts hidden until boot validates the session");
});

test("M12-17 APP: Notification is feature-detected; permission is requested ONLY from the click gesture", () => {
  const js = readAsset("app.js");
  assert.match(js, /typeof Notification/, "Notification access is feature-detected");
  assert.match(js, /requestPermission/, "a permission request path exists");
  assert.match(js, /notifyToggle\.addEventListener\("click",\s*\(\)\s*=>\s*enableNotifications\(state\)\)/,
    "the ONLY enable path is the explicit button click");
  assert.match(js, /planTerminalNotifications\(/, "transition planning goes through the pure planner");
});

// ---- C5) CSS — state pills cover the whole closed set ----

test("M12-17 CSS: state pill styles cover the full closed set; the stopped style is gone", () => {
  const css = readAsset("styles.css");
  for (const st of ["pending", "submitted", "running", "completed", "failed", "aborted", "timed_out", "unknown"]) {
    assert.match(css, new RegExp(`\\.state-pill\\.s-${st}\\b`), `pill style for ${st}`);
  }
  assert.doesNotMatch(css, /s-stopped/, "stopped style removed with the nonexistent state");
});

// =====================================================================
// D) M12-17 RACE — selection-bound activity commits (the late-response fix)
//   A selection epoch advances on every selection change. An in-flight
//   activity request captures (runId, epoch) at issue time; its response
//   commits ONLY when BOTH still equal the current selection. A late
//   response from a superseded selection is dropped silently and never
//   mutates the current selection's lastGoodActivity / activityFresh /
//   timeline / detail / terminal observation. BOTH bootstrap and poll (and
//   load-older) are bound; a late fetch error never marks the current
//   selection stale/error.
//   States covered (WQ-02): normal (current response committed), loading
//   (captured, unresolved), late-success, late-unavailable (available:false),
//   late-error (fetch rejected), and the epoch-vs-runId distinction (a
//   superseded binding for the SAME runId is still dropped).
// Deterministic over the pure binding gate + advanceSelection the commit
// surface reduces to (no DOM, no fetch, no timers).
// =====================================================================

// A selection-shaped state object with ONLY the fields the binding reads or
// the commit mutates — the same shape selectRun/bootstrapActivity/pollOnce use.
function freshSelectionState() {
  return {
    selectedRunId: null,
    selectionEpoch: 0,
    lastGoodActivity: null,
    unavailableReason: null,
    activityFresh: null,
    sessionEnded: false,
    timeline: [],
    maxSeq: 0,
    olderCursor: null,
    observedTerminal: {},
  };
}

// Mirrors the commit site in bootstrapActivity/pollOnce/loadOlder exactly:
// the page is applied ONLY when the captured binding is still the current
// selection. A dropped late response performs NO mutation.
function commit(state, captured, apply) {
  if (app.isCurrentSelection(state, captured)) apply(state);
}

// ---- D1) THE BINDING GATE (pure) ----

test("RACE GATE: isCurrentSelection accepts only an exact (runId, epoch) match", () => {
  const state = { selectedRunId: "run_b", selectionEpoch: 2 };
  assert.equal(app.isCurrentSelection(state, { runId: "run_b", epoch: 2 }), true, "exact match → current");
  assert.equal(app.isCurrentSelection(state, { runId: "run_a", epoch: 1 }), false, "late A (different run + epoch)");
  assert.equal(app.isCurrentSelection(state, { runId: "run_b", epoch: 1 }), false, "same run, superseded epoch");
  assert.equal(app.isCurrentSelection(state, { runId: "run_a", epoch: 2 }), false, "different run, same epoch");
  assert.equal(app.isCurrentSelection(state, null), false, "missing capture");
  assert.equal(app.isCurrentSelection(null, { runId: "run_b", epoch: 2 }), false, "missing state");
  assert.equal(app.isCurrentSelection(state, { runId: "run_b" }), false, "missing epoch");
  assert.equal(app.isCurrentSelection(state, { runId: "run_b", epoch: "x" }), false, "non-integer epoch");
  assert.equal(app.isCurrentSelection(state, { runId: "", epoch: 2 }), false, "empty runId");
  assert.equal(app.isCurrentSelection({ selectedRunId: null, selectionEpoch: 0 }, { runId: "run_a", epoch: 1 }),
    false, "no current selection");
});

test("RACE GATE: advanceSelection bumps the epoch, resets activity state, returns the new binding", () => {
  const state = freshSelectionState();
  state.lastGoodActivity = { stale: true };
  state.timeline = [{ seq: 9 }];
  state.maxSeq = 9;
  const capA = app.advanceSelection(state, "run_a");
  assert.equal(state.selectedRunId, "run_a");
  assert.equal(state.selectionEpoch, 1);
  assert.equal(state.lastGoodActivity, null, "activity reset on selection change");
  assert.deepEqual(state.timeline, []);
  assert.equal(state.maxSeq, 0);
  assert.equal(state.activityFresh, null);
  assert.deepEqual(capA, { runId: "run_a", epoch: 1 }, "returns the captured binding for the new bootstrap");
  // A second selection advances the epoch again — capA is now stale.
  const capB = app.advanceSelection(state, "run_b");
  assert.equal(state.selectionEpoch, 2);
  assert.deepEqual(capB, { runId: "run_b", epoch: 2 });
  assert.equal(app.isCurrentSelection(state, capA), false, "capA is stale after advancing to B");
  assert.equal(app.isCurrentSelection(state, capB), true);
});

// ---- D2) THE FOUR SCENARIOS (A late success / unavailable / error; B normal) ----

test("RACE: A late SUCCESS after select B is dropped — B's lastGoodActivity/timeline/activityFresh untouched", () => {
  const state = freshSelectionState();
  const capA = app.advanceSelection(state, "run_a"); // bootstrap A in flight
  const capB = app.advanceSelection(state, "run_b"); // Owner switches to B; bootstrap B in flight
  // A's late SUCCESS page resolves first (would poison B if committed):
  commit(state, capA, (s) => {
    s.lastGoodActivity = { runId: "run_a", activity: { total: 999, backend: "A", state: "running", terminal: false } };
    s.timeline = [{ seq: 1, poison: true }];
    s.activityFresh = true;
  });
  assert.equal(state.lastGoodActivity, null, "A's late success did NOT write B's lastGoodActivity");
  assert.deepEqual(state.timeline, [], "A's late success did NOT append to B's timeline");
  assert.equal(state.activityFresh, null, "A's late success did NOT flip B's activityFresh");
  // B's own SUCCESS commits normally:
  commit(state, capB, (s) => {
    s.lastGoodActivity = { runId: "run_b", activity: { runId: "run_b", total: 3, backend: "B", state: "running", terminal: false } };
    s.activityFresh = true;
  });
  assert.equal(state.lastGoodActivity.activity.runId, "run_b", "B's facts are B's");
  assert.equal(state.activityFresh, true);
});

test("RACE: A late UNAVAILABLE (available:false) after select B is dropped — B not marked stale/unavailable", () => {
  const state = freshSelectionState();
  const capA = app.advanceSelection(state, "run_a");
  const capB = app.advanceSelection(state, "run_b");
  // A's late read returned available:false (would poison B if committed):
  commit(state, capA, (s) => {
    s.lastGoodActivity = null;
    s.unavailableReason = "unavailable";
    s.activityFresh = false;
  });
  assert.equal(state.unavailableReason, null, "A's unavailable did NOT set B's unavailableReason");
  assert.equal(state.activityFresh, null, "A's unavailable did NOT mark B stale");
  assert.equal(state.lastGoodActivity, null);
  // B's own read commits normally:
  commit(state, capB, (s) => { s.activityFresh = true; });
  assert.equal(state.activityFresh, true);
});

test("RACE: A late ERROR (fetch rejected) after select B is dropped — B not marked stale/session-ended", () => {
  const state = freshSelectionState();
  const capA = app.advanceSelection(state, "run_a");
  const capB = app.advanceSelection(state, "run_b");
  // A's late fetch rejected — onFetchError would mark the source stale / a 401
  // would set sessionEnded. Neither may touch the current (B) selection.
  commit(state, capA, (s) => {
    s.activityFresh = false; // onFetchError(state, err, "activity")
    s.sessionEnded = true;   // the unauthorized branch
  });
  assert.equal(state.activityFresh, null, "A's late error did NOT mark B stale");
  assert.equal(state.sessionEnded, false, "A's late error did NOT end B's session");
  // B's own successful read commits normally:
  commit(state, capB, (s) => { s.activityFresh = true; s.sessionEnded = false; });
  assert.equal(state.activityFresh, true);
  assert.equal(state.sessionEnded, false);
});

test("RACE: a fresh, current B response IS committed (no false drops on the live path)", () => {
  const state = freshSelectionState();
  const capB = app.advanceSelection(state, "run_b");
  let applied = false;
  commit(state, capB, () => { applied = true; });
  assert.equal(applied, true, "the current selection's response is accepted");
  // No further selection change → a later B response (same epoch) is still current.
  assert.equal(app.isCurrentSelection(state, capB), true);
});

test("RACE: epoch (not runId alone) distinguishes superseded bindings for the SAME run", () => {
  // selectRun early-outs when the SAME runId is re-clicked, but a B→A→B round
  // trip advances the epoch, so a response captured for the FIRST B selection
  // must NOT be applied against the SECOND B selection (its timeline/maxSeq
  // were captured under the older bootstrap).
  const state = freshSelectionState();
  const capB1 = app.advanceSelection(state, "run_b");   // epoch 1
  app.advanceSelection(state, "run_a");                 // epoch 2
  const capB2 = app.advanceSelection(state, "run_b");   // epoch 3 — back to B
  assert.equal(state.selectedRunId, "run_b");
  assert.equal(app.isCurrentSelection(state, capB1), false, "first B binding is stale (epoch advanced)");
  assert.equal(app.isCurrentSelection(state, capB2), true, "second B binding is current");
  commit(state, capB1, (s) => { s.lastGoodActivity = { poison: "B1" }; });
  assert.equal(state.lastGoodActivity, null, "the stale B1 binding did not commit");
});

test("RACE: stale-data-plus-error — A's late error does not corrupt a live B snapshot", () => {
  // High-risk combination (WQ-02): B already has good data, then A's late error
  // resolves. The error must not flip B stale nor clear B's good snapshot.
  const state = freshSelectionState();
  const capA = app.advanceSelection(state, "run_a");
  const capB = app.advanceSelection(state, "run_b");
  commit(state, capB, (s) => {
    s.lastGoodActivity = { runId: "run_b", activity: { total: 5 } };
    s.activityFresh = true;
  });
  // A's late error arrives AFTER B is already live:
  commit(state, capA, (s) => { s.activityFresh = false; });
  assert.equal(state.activityFresh, true, "B stays live — A's late error ignored");
  assert.equal(state.lastGoodActivity.activity.total, 5, "B's good snapshot preserved");
});

// ---- D3) WIRING CONTRACT — the gate guards every commit site ----

test("RACE WIRING: bootstrap/poll/loadOlder each capture the binding and gate success AND error", () => {
  const js = readAsset("app.js");
  // selectRun advances the epoch via the pure helper (the binding source).
  assert.match(js, /advanceSelection\(state,\s*runId\)/, "selectRun advances the epoch");
  // Each of the three activity-fetch paths captures the SAME binding shape.
  const captures = js.match(/const captured\s*=\s*\{\s*runId,\s*epoch:\s*state\.selectionEpoch\s*\}/g) || [];
  assert.ok(captures.length >= 3,
    `bootstrap/poll/loadOlder each capture the binding (found ${captures.length})`);
  // Every capture is guarded in BOTH the try (success) and catch (error):
  // ≥ 2 isCurrentSelection guards per capture.
  const guards = js.match(/isCurrentSelection\(state,\s*captured\)/g) || [];
  assert.ok(guards.length >= captures.length * 2,
    `every path guards success AND error (guards ${guards.length} >= ${captures.length * 2})`);
  // The protected commit sites are reached ONLY after a guard (late → return).
  assert.match(js, /isCurrentSelection\(state,\s*captured\)\)\s*return;[\s\S]*?applyBootstrapPage/,
    "applyBootstrapPage is guarded");
  assert.match(js, /isCurrentSelection\(state,\s*captured\)\)\s*return;[\s\S]*?applyPollPage/,
    "applyPollPage is guarded");
  assert.match(js, /isCurrentSelection\(state,\s*captured\)\)\s*return;[\s\S]*?onFetchError/,
    "the error path's onFetchError is guarded");
  // The boot state carries the epoch counter.
  assert.match(js, /selectionEpoch:\s*0/, "boot state initializes the epoch");
});
