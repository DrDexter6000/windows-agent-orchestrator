// test/isolation-infra/ownerDashboardV2.test.js
//
// Batch 142 (decision 0131 A3): the new Owner dashboard front end at /v2 — top bar,
// three-page navigation, EN/中 string table, Overview and Attention. Batch 143a adds the Workers page and
// the worker side panel: their own tests are in ownerDashboardV2Workers.test.js; the guards here
// (closed endpoint set, one fetch, no markup parsing, CSP, static table) cover every v2 module.
//
// Sections:
//   S  server   /v2 routes: status, MIME, headers, closed route table, 404 forms,
//               the retired legacy entry (302 → /v2/), data routes still need the token
//   P  pure     string table, formatting, page fragment, cycle commit, last-visit
//               window, Overview / Attention view models (no DOM)
//   V  views    the DOM builders, run against a tiny in-memory DOM
//   G  guards   closed endpoint set, one network call, no markup parsing, no
//               inline handlers, closed static table, contrast, fonts (the motion guard
//               moved to ownerDashboardV2Activity.test.js in batch 143b)
//
// Deterministic and dependency-free: no network, no browser, no runtime.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createOwnerDashboardServer } from "../../src/ownerDashboardServer.js";
import * as i18n from "../../src/owner-dashboard/v2/i18n.js";
import * as model from "../../src/owner-dashboard/v2/model.js";
import * as api from "../../src/owner-dashboard/v2/api.js";
import * as workers from "../../src/owner-dashboard/v2/workers.js";
import * as store from "../../src/owner-dashboard/v2/store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SRC = join(ROOT, "src", "owner-dashboard");
const V2 = join(SRC, "v2");
const read = (...parts) => readFileSync(join(SRC, ...parts), "utf8");
const readV2 = (name) => read("v2", name);

const V2_JS = [
  "activity.js", "activityview.js", "app.js", "api.js", "artifacts.js", "detail.js", "i18n.js", "model.js", "sidebarview.js", "store.js", "views.js", "workers.js", "workersview.js",
];
const V2_FILES = ["index.html", "styles.css", ...V2_JS];
const JS_TYPE = "text/javascript; charset=utf-8";
const CSS_TYPE = "text/css; charset=utf-8";
const HTML_TYPE = "text/html; charset=utf-8";

// ===== fake request/response drive (the same shape the other dashboard tests use) =====

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
  return Promise.resolve(handler(req, res)).then(() => ({
    status: state.statusCode, headers: state.headers, body: state.body,
  }));
}

function makeServer(extra = {}) {
  return createOwnerDashboardServer({
    runDir: "/server/owned/runs",
    env: {},
    nowFn: () => 1_000_000,
    ...extra,
  });
}

function assertSafeHeaders(r, contentType) {
  assert.equal(r.headers["cache-control"], "no-store", "no-store");
  assert.equal(r.headers["x-content-type-options"], "nosniff", "nosniff");
  assert.equal(r.headers["referrer-policy"], "no-referrer", "no-referrer");
  assert.ok(r.headers["content-security-policy"], "CSP set");
  assert.ok(!("access-control-allow-origin" in r.headers), "no CORS opt-in");
  if (contentType) assert.equal(r.headers["content-type"], contentType);
}

// =====================================================================
// S) SERVER
// =====================================================================

test("S1 /v2 and /v2/ serve v2/index.html as text/html with the base safe headers", async () => {
  const s = makeServer();
  const file = readV2("index.html");
  for (const url of ["/v2", "/v2/", "/v2?x=1", "/v2/?x=1"]) {
    const r = await drive(s.handler, { url });
    assert.equal(r.status, 200, url);
    assertSafeHeaders(r, HTML_TYPE);
    assert.equal(r.body, file, `${url} serves the real v2/index.html bytes`);
    assert.equal(Number(r.headers["content-length"]), Buffer.byteLength(file));
  }
  // 145a: "/" no longer serves a page — it points at this one (S6).
  assert.equal((await drive(s.handler, { url: "/" })).status, 302);
});

test("S2 every v2 module and the stylesheet has one fixed route: status, MIME, exact bytes", async () => {
  const s = makeServer();
  for (const name of V2_FILES.filter((f) => f !== "index.html")) {
    const r = await drive(s.handler, { url: `/v2/${name}` });
    assert.equal(r.status, 200, name);
    assertSafeHeaders(r, name.endsWith(".css") ? CSS_TYPE : JS_TYPE);
    assert.equal(r.body, readV2(name), `${name}: real bytes`);
    assert.equal(Number(r.headers["content-length"]), Buffer.byteLength(readV2(name)));
  }
});

test("S3 the static table is a closed set: source routes, loaded names and the v2 directory listing agree", () => {
  const server = readFileSync(join(ROOT, "src", "ownerDashboardServer.js"), "utf8");
  const table = server.slice(server.indexOf("const STATIC_ASSETS"), server.indexOf("// Preload the fixed assets"));
  const routes = [...table.matchAll(/route: "([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(routes, [
    "/v2", "/v2/", "/v2/activity.js", "/v2/activityview.js", "/v2/api.js", "/v2/app.js", "/v2/artifacts.js", "/v2/detail.js", "/v2/i18n.js", "/v2/model.js", "/v2/sidebarview.js",
    "/v2/store.js", "/v2/styles.css", "/v2/views.js", "/v2/workers.js", "/v2/workersview.js",
  ].sort(), "exactly the v2 routes; /v2/index.html is not a route and no legacy asset is served");
  // The loader is asked for exactly these file names (once each, however many routes share one).
  const asked = [];
  makeServer({ loadAssetFn: (name) => { asked.push(name); return Buffer.from(`/* ${name} */`); } });
  assert.deepEqual([...asked].sort(), V2_FILES.map((f) => `v2/${f}`).sort());
  // Nothing in the v2 directory is left unserved, and nothing served is missing on disk.
  assert.deepEqual(readdirSync(V2).sort(), [...V2_FILES].sort(), "the v2 directory holds exactly the served files");
});

test("S4 traversal, case variants, an extra path level and unlisted names are 404", async () => {
  const s = makeServer();
  const cases = [
    "/v2/index.html", "/v2/index.html/",
    "/V2", "/V2/", "/v2/APP.JS", "/v2/App.js", "/v2/Model.js", "/v2/STYLES.CSS", "/v2/Styles.css",
    "/v2/app.js/", "/v2/app.js.map", "/v2/app.js.bak", "/v2/_app.js",
    "/v2/x/app.js", "/v2/v2/app.js", "/v2//app.js", "/v2/js/app.js", "/v2/assets/model.js",
    "/v2/other.js", "/v2/README.md", "/v2/package.json", "/v2/favicon.ico",
    "/v2/%2e%2e/%2e%2e/etc/passwd",   // collapses to /etc/passwd
    "/v2/..%2fapp.js", "/v2/%2e%2e%2fapp.js", "/v2%2fapp.js", "/v2%2Fapp.js",
    "/v2/app%2ejs", "/v2/%61pp.js",  // percent-encoded letters are different keys
    "/v22", "/v2x", "/v3", "/v2.html",
  ];
  for (const url of cases) {
    const r = await drive(s.handler, { url });
    assert.equal(r.status, 404, `${url} → 404`);
    assert.deepEqual(JSON.parse(r.body), { error: "not_found" }, url);
    assertSafeHeaders(r, "application/json; charset=utf-8");
  }
});

test("S5 forms the URL parser collapses onto an asset (dot segments, encoded dots, backslashes) are 404 for /v2 — the retired legacy paths reach no file", async () => {
  const s = makeServer();
  const collapsing = [
    "/v2/app.js/..",        // -> /v2/        (the v2 page)
    "/v2/../app.js",        // -> /app.js     (the LEGACY script, reached through /v2)
    "/v2/./app.js", "/v2/a/../app.js", "/v2/../v2/app.js", "/./v2/app.js", "/app.js/../v2/app.js", "/v2/app.js/./..",
    "/v2/.", "/v2/..", "/v2/../", "/v2/../index.html",
    "/v2/%2e/app.js", "/v2/%2E%2E/app.js", "/v2/%2e%2e/app.js", "/v2/a/%2e%2e/app.js",
    "/v2\\app.js", "/v2/\\app.js", "/v2/..\\app.js",
    // A backslash right after /v2 turns into a slash when the URL is parsed: the path can then climb out of /v2
    // onto the LEGACY assets ("/v2\..\app.js" parses to "/app.js"). Encoded backslashes are the same boundary.
    "/v2\\..\\app.js", "/v2\\..\\index.html", "/v2\\..\\", "/v2\\app.js\\..", "/v2\\", "/v2%5C..%5Capp.js", "/v2%5c..%5capp.js", "/v2/..%5Capp.js", "/v2%5C",
    "/v2/%2e%2e/%2e%2e/etc/passwd", "/v2/../../package.json",
    // 145a 修正一：原始路径以多个斜杠开头时，URL 解析器会把 //v2 当成 authority；这些形态同样
    // 不得落到 /v2 之外的 redirect / health / 文件。
    "//v2/../app.js", "//v2/../v2/app.js", "//v2/app.js", "///v2/app.js", "//v2//app.js", "//v2/../index.html", "//v2/../health",
  ];
  for (const url of collapsing) {
    const r = await drive(s.handler, { url });
    assert.equal(r.status, 404, `${url} → 404`);
    assert.deepEqual(JSON.parse(r.body), { error: "not_found" }, url);
    assertSafeHeaders(r, "application/json; charset=utf-8");
  }
  // A clean path still works, with or without a query (the query is not part of the path).
  for (const url of ["/v2", "/v2/", "/v2/app.js", "/v2/styles.css", "/v2/app.js?x=1", "/v2?a=b#frag"]) {
    assert.equal((await drive(s.handler, { url })).status, 200, url);
  }
  // The retired legacy paths reach no file: a collapse onto the old "/" is the redirect (S6), and the old
  // assets are not served at all.
  const collapsedHome = await drive(s.handler, { url: "/app.js/.." });
  assert.equal(collapsedHome.status, 302);
  assert.equal(collapsedHome.headers.location, "/v2/");
  assert.equal((await drive(s.handler, { url: "/./app.js" })).status, 404);
  assert.equal((await drive(s.handler, { url: "/index.html/.." })).status, 302);
});
test("S6 (145a) the legacy UI is retired: / and /index.html answer 302 to /v2/ (empty body, safe headers, no token); its assets and data routes are gone", async () => {
  const s = makeServer();
  for (const url of ["/", "/index.html", "/?x=1", "/index.html?x=1"]) {
    const r = await drive(s.handler, { url });
    assert.equal(r.status, 302, url);
    assert.equal(r.headers.location, "/v2/", `${url}: Location is exactly the new entry`);
    assert.equal(r.body, "", `${url}: no body (the browser keeps the fragment across the redirect)`);
    assert.equal(Number(r.headers["content-length"]), 0, `${url}: content-length 0`);
    assertSafeHeaders(r);
    assert.ok(!("access-control-allow-origin" in r.headers), `${url}: no CORS opt-in`);
    assert.ok(!JSON.stringify(r.headers).includes(s.token), `${url}: no token in the redirect`);
  }
  // The retired UI files are no longer served, and the old data routes are the fixed 404 (no auth probe).
  for (const url of ["/app.js", "/styles.css", "/api/runs", "/api/activity", "/api/runs?limit=1", "/api/activity?runId=run_x"]) {
    const r = await drive(s.handler, { url });
    assert.equal(r.status, 404, url);
    assert.deepEqual(JSON.parse(r.body), { error: "not_found" }, url);
    assertSafeHeaders(r);
  }
  // The one entry that serves the page is /v2/.
  assert.equal((await drive(s.handler, { url: "/v2/" })).status, 200);
});

test("S7 assets need no token; every data route answers 401 without one (and with a wrong one)", async () => {
  const s = makeServer();
  for (const url of ["/v2", "/v2/", ...V2_JS.map((f) => `/v2/${f}`), "/v2/styles.css"]) {
    assert.equal((await drive(s.handler, { url })).status, 200, `${url} without auth`);
  }
  const data = [
    "/api/overview", "/api/workers", "/api/attention", "/api/worker", "/api/artifact",
    "/api/worker/activity", "/api/worker/event", "/api/worker/stream",
    "/api/overview?x=1", "/api/workers?project=shop-api",
  ];
  const wrong = { authorization: `Bearer ${"0".repeat(64)}` };
  for (const url of data) {
    for (const headers of [{}, wrong, { authorization: "Bearer" }, { authorization: s.token }]) {
      const r = await drive(s.handler, { url, headers });
      assert.equal(r.status, 401, `${url} with ${JSON.stringify(Object.keys(headers))}`);
      assert.deepEqual(JSON.parse(r.body), { error: "unauthorized" });
    }
  }
  const ok = await drive(s.handler, { url: "/api/overview", headers: { authorization: `Bearer ${s.token}` } });
  assert.equal(ok.status, 200, "the issued token is accepted (loading before the first round)");
});

test("S8 the v2 page has the base CSP plus ONE thing (img-src blob:): no inline script/style, no eval, no wildcard, no external source", async () => {
  const s = makeServer();
  const v2 = (await drive(s.handler, { url: "/v2" })).headers["content-security-policy"];
  // 145a: there is no legacy page any more; every other response (the redirect, /health, JSON) keeps the base policy.
  const base = (await drive(s.handler, { url: "/health" })).headers["content-security-policy"];
  assert.equal(v2, base.replace("img-src 'self' data:", "img-src 'self' data: blob:"), "the base policy with blob: added to img-src, byte for byte otherwise");
  assert.equal((await drive(s.handler, { url: "/" })).headers["content-security-policy"], base, "the redirect carries the base policy");
  assert.match(v2, /img-src 'self' data: blob:/);
  assert.ok(!base.includes("blob:"), "the data responses are not relaxed");
  assert.match(v2, /default-src 'self'/);
  assert.match(v2, /object-src 'none'/);
  assert.match(v2, /base-uri 'none'/);
  assert.match(v2, /frame-ancestors 'none'/);
  assert.ok(!/unsafe-inline|unsafe-eval|\*|https?:/.test(v2), "nothing relaxed, nothing external");
  assert.ok(!/font-src|connect-src|script-src|style-src/.test(v2), "fonts, script and style fall back to 'self'");
});

test("S9 non-GET on a v2 asset is 405; the token is in no v2 body or header", async () => {
  const s = makeServer();
  for (const method of ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
    const r = await drive(s.handler, { method, url: "/v2" });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.allow, "GET");
  }
  for (const url of ["/v2", ...V2_JS.map((f) => `/v2/${f}`), "/v2/styles.css"]) {
    const r = await drive(s.handler, { url });
    assert.ok(!r.body.includes(s.token), `token absent from ${url} body`);
    assert.ok(!JSON.stringify(r.headers).includes(s.token), `token absent from ${url} headers`);
  }
});

test("S10 LOAD: the injected loader gets the v2 names; a missing v2 file fails closed before listen", async () => {
  const asked = [];
  const s = makeServer({ loadAssetFn: (name) => { asked.push(name); return `/* injected:${name} */`; } });
  assert.equal((await drive(s.handler, { url: "/v2/model.js" })).body, "/* injected:v2/model.js */");
  assert.equal((await drive(s.handler, { url: "/v2" })).body, "/* injected:v2/index.html */");
  assert.equal((await drive(s.handler, { url: "/v2/" })).body, "/* injected:v2/index.html */");
  // 145a: the legacy asset names are no longer loaded at all.
  assert.deepEqual(asked.filter((n) => !n.startsWith("v2/")), [], "the loader is asked for v2 names only");
  assert.throws(
    () => makeServer({
      loadAssetFn: (name) => {
        if (name === "v2/views.js") throw new Error("missing");
        return Buffer.from("x");
      },
    }),
    /missing/,
  );
});

test("S11 real HTTP, raw request paths: /v2/../app.js and /v2/app.js/.. are 404 on the wire; clean paths are 200, the retired forms reach no file", async () => {
  const model = { async refresh() {}, snapshot: (args) => ({ generatedAt: new Date(args.now).toISOString(), projects: [], runs: [], consults: [] }) };
  const s = makeServer({ createReadModelFn: () => model });
  const { port } = await s.listen();
  try {
    // http.request sends the path exactly as given (a browser would normalize it first; curl --path-as-is does not).
    const get = (rawPath) => new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET" }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], location: res.headers.location, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal((await get("/v2")).status, 200);
    assert.equal((await get("/v2/app.js")).type, JS_TYPE);
    for (const raw of [
      "/v2/../app.js", "/v2/app.js/..", "/v2/./app.js", "/v2//app.js", "/v2/%2e%2e/app.js", "/v2/..", "/v2/../package.json",
      "/v2\\..\\app.js", "/v2\\..\\index.html", "/v2\\app.js", "/v2%5C..%5Capp.js", "/v2%5c..%5capp.js",
      // 145a 修正一：双斜杠开头的原始路径（new URL 会把 //v2 当 authority）固定 404，不落到 redirect/health。
      "//v2/../app.js", "//v2/../v2/app.js", "//v2/app.js", "///v2/app.js", "//v2//app.js", "//v2/../index.html", "//v2/../health",
    ]) {
      const r = await get(raw);
      assert.equal(r.status, 404, raw);
      assert.deepEqual(JSON.parse(r.body), { error: "not_found" });
    }
    assert.equal((await get("/app.js/..")).status, 302, "a collapsed retired path reaches the redirect, not a file");
    assert.equal((await get("/app.js")).status, 404, "the retired script is not served");
    assert.equal((await get("/styles.css")).status, 404, "the retired stylesheet is not served");
    const root = await get("/");
    assert.equal(root.status, 302);
    assert.equal(root.location, "/v2/");
    assert.equal(root.body, "");
  } finally {
    await s.close();
  }
});
// =====================================================================
// P) PURE LOGIC
// =====================================================================

const placeholdersOf = (text) => [...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]).sort();

test("P1 string table: EN and 中 have exactly the same keys, non-empty values, same placeholders", () => {
  const en = Object.keys(i18n.STRINGS.en).sort();
  const zh = Object.keys(i18n.STRINGS.zh).sort();
  assert.deepEqual(zh, en, "key sets are identical");
  for (const key of en) {
    for (const lang of i18n.LANGS) {
      const value = i18n.STRINGS[lang][key];
      assert.equal(typeof value, "string", `${lang}.${key}`);
      assert.ok(value.length > 0, `${lang}.${key} is not empty`);
    }
    assert.deepEqual(placeholdersOf(i18n.STRINGS.zh[key]), placeholdersOf(i18n.STRINGS.en[key]), `${key}: same placeholders in both languages`);
  }
  assert.deepEqual([...i18n.LANGS], ["en", "zh"]);
  assert.equal(i18n.DEFAULT_LANG, "en");
});

test("P2 data never goes through the table: no placeholder for run numbers, hashes, event codes, titles or refs", () => {
  const allowed = new Set(["n", "d", "m", "h", "ago", "counts", "time", "lane", "name", "in", "total", "state"]);
  for (const lang of i18n.LANGS) {
    for (const [key, value] of Object.entries(i18n.STRINGS[lang])) {
      for (const name of placeholdersOf(value)) assert.ok(allowed.has(name), `${lang}.${key} uses {${name}}`);
      assert.doesNotMatch(value, /\brun_\d|\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b|#\d{4}/, `${lang}.${key} carries no run number / hash / event code`);
    }
  }
  // The UI words for language names are literal, not keys.
  assert.ok(!("lang.en" in i18n.STRINGS.en) && !("lang.zh" in i18n.STRINGS.en));
});

test("P3 A6: the interface says Starting / 启动中, never queued", () => {
  assert.equal(i18n.t("en", "ov.starting", { n: 2 }), "2 starting");
  assert.equal(i18n.t("zh", "ov.starting", { n: 2 }), "2 个启动中");
  assert.ok(!/queue/i.test(JSON.stringify(i18n.STRINGS.en)), "no 'queue' in English");
  assert.ok(!JSON.stringify(i18n.STRINGS.zh).includes("排队"), "no 排队 in Chinese");
});

test("P4 t(): language fallback, key fallback, placeholders; tn(): one / other", () => {
  assert.equal(i18n.t("en", "nav.overview"), "Overview");
  assert.equal(i18n.t("zh", "nav.overview"), "总览");
  assert.equal(i18n.t("fr", "nav.overview"), "Overview", "unknown language -> English");
  assert.equal(i18n.t(undefined, "nav.overview"), "Overview");
  assert.equal(i18n.t("zh", "no.such.key"), "no.such.key", "missing everywhere -> the key");
  assert.equal(i18n.t("en", "fresh.stale", { time: "10:41" }), "Stale since 10:41");
  assert.equal(i18n.t("en", "fresh.stale", {}), "Stale since {time}", "an unfilled placeholder stays visible");
  assert.equal(i18n.t("en", "count.failed", { n: 0 }), "0 failed", "0 is a value, not 'missing'");
  assert.equal(i18n.tn("en", "ov.alert", 1), "1 alert");
  assert.equal(i18n.tn("en", "ov.alert", 2), "2 alerts");
  assert.equal(i18n.tn("en", "ov.alert", 0), "0 alerts");
  assert.equal(i18n.tn("en", "ov.needYou", 1), "1 needs you");
  assert.equal(i18n.tn("en", "ov.needYou", 2), "2 need you");
  assert.equal(i18n.tn("zh", "ov.needYou", 2), "2 项需要你");
  // The English fallback for a key missing from Chinese rests on every zh key existing in en.
  for (const key of Object.keys(i18n.STRINGS.zh)) assert.ok(key in i18n.STRINGS.en, key);
});

test("P5 formatDuration / formatAgo: minutes, hours, days in both languages; unreadable is a dash", () => {
  const M = 60000;
  const cases = [
    [0, "<1m", "不到 1 分钟"], [59_999, "<1m", "不到 1 分钟"], [M, "1m", "1 分钟"], [38 * M, "38m", "38 分钟"],
    [59 * M, "59m", "59 分钟"], [60 * M, "1h", "1 小时"], [65 * M, "1h 5m", "1 小时 5 分钟"], [23 * 60 * M + 59 * M, "23h 59m", "23 小时 59 分钟"],
    [24 * 60 * M, "1d", "1 天"], [24 * 60 * M + 5 * 60 * M, "1d 5h", "1 天 5 小时"], [-5, "<1m", "不到 1 分钟"],
  ];
  for (const [ms, en, zh] of cases) {
    assert.equal(i18n.formatDuration("en", ms), en, `en ${ms}`);
    assert.equal(i18n.formatDuration("zh", ms), zh, `zh ${ms}`);
  }
  for (const bad of [null, undefined, NaN, Infinity, "5"]) assert.equal(i18n.formatDuration("en", bad), "—");
  assert.equal(i18n.formatAgo("en", 3 * 60 * M), "3h ago");
  assert.equal(i18n.formatAgo("zh", 3 * 60 * M), "3 小时前");
  assert.equal(i18n.formatAgo("en", 10_000), "just now");
  assert.equal(i18n.formatAgo("zh", 10_000), "刚刚");
  assert.equal(i18n.formatAgo("en", null), "—");
});

test("P6 formatClock: local HH:MM, zero padded, identical in both languages", () => {
  assert.equal(i18n.formatClock(new Date(2026, 10, 26, 9, 5).getTime()), "09:05");
  assert.equal(i18n.formatClock(new Date(2026, 10, 26, 23, 59).getTime()), "23:59");
  assert.equal(i18n.formatClock(new Date(2026, 10, 26, 0, 0).getTime()), "00:00");
  for (const bad of [null, undefined, NaN, "x", 8.64e15 + 1]) assert.equal(i18n.formatClock(bad), "--:--");
});

test("P7 language and storage: readStored/writeStored swallow every storage failure; default is English", () => {
  const good = new Map();
  const storage = { getItem: (k) => (good.has(k) ? good.get(k) : null), setItem: (k, v) => { good.set(k, v); } };
  assert.equal(store.readStored(() => storage, "k"), null);
  assert.equal(store.writeStored(() => storage, "k", "zh"), true);
  assert.equal(store.readStored(() => storage, "k"), "zh");
  const throwingGetter = () => { throw new Error("SecurityError"); };
  const throwingStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); } };
  assert.equal(store.readStored(throwingGetter, "k"), null, "the getter itself may throw");
  assert.equal(store.writeStored(throwingGetter, "k", "v"), false);
  assert.equal(store.readStored(() => throwingStorage, "k"), null);
  assert.equal(store.writeStored(() => throwingStorage, "k", "v"), false);
  assert.equal(store.readStored(() => ({ getItem: () => 42 }), "k"), null, "a non-string value reads as none");
  // What the app does with them:
  assert.equal(i18n.resolveLang(store.readStored(throwingGetter, i18n.LANG_STORAGE_KEY)), "en", "unreadable -> default English");
  assert.equal(i18n.resolveLang("zh"), "zh");
  assert.equal(i18n.resolveLang("de"), "en");
  assert.equal(i18n.isLang("zh"), true);
  assert.equal(i18n.isLang("ZH"), false);
});

const TOKEN = "ab".repeat(32);

test("P8 token: only #token=<64 lowercase hex> is read; stored once; the fragment is always cleared", () => {
  assert.equal(api.parseTokenFromHash(`#token=${TOKEN}`), TOKEN);
  for (const bad of ["", "#", "#token=", "#token=short", `#token=${TOKEN}&x=1`, `#token=${TOKEN.toUpperCase()}`, `#${TOKEN}`, `#foo=${TOKEN}`, `token=${TOKEN}`, null, undefined, 5]) {
    assert.equal(api.parseTokenFromHash(bad), null, String(bad));
  }
  assert.equal(api.isValidToken(TOKEN), true);
  assert.equal(api.isValidToken("g".repeat(64)), false);
  assert.equal(api.authorizationHeader(TOKEN), `Bearer ${TOKEN}`);

  const mem = new Map();
  const getStorage = () => ({ getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, v); } });
  let cleared = 0;
  const clearFragment = () => { cleared += 1; };
  assert.equal(api.resolveToken({ hash: `#token=${TOKEN}`, getStorage, clearFragment }), TOKEN);
  assert.equal(cleared, 1, "fragment cleared at once");
  assert.equal(mem.get(api.TOKEN_STORAGE_KEY), TOKEN, "stored for reloads");
  // A later load without the fragment reads the stored token and clears nothing.
  assert.equal(api.resolveToken({ hash: "#attention", getStorage, clearFragment }), TOKEN);
  assert.equal(cleared, 1);
  // A malformed token fragment is cleared too, and does not hide the stored token.
  assert.equal(api.resolveToken({ hash: "#token=nope", getStorage, clearFragment }), TOKEN);
  assert.equal(cleared, 2);
  // No token anywhere: null; and a throwing storage is just "none".
  assert.equal(api.resolveToken({ hash: "", getStorage: () => ({ getItem: () => null, setItem() {} }), clearFragment }), null);
  const blocked = () => { throw new Error("blocked"); };
  assert.equal(api.resolveToken({ hash: `#token=${TOKEN}`, getStorage: blocked, clearFragment }), TOKEN, "usable for this load even when it cannot be stored");
  assert.equal(api.resolveToken({ hash: "", getStorage: blocked, clearFragment }), null);
  assert.equal(api.resolveToken({ hash: "", getStorage: () => ({ getItem: () => "bad", setItem() {} }), clearFragment }), null, "a stored value that is not a token is ignored");
});

test("P8b start code (145b): the fragment forms, the exchange, and the boot order", async (t) => {
  // 片段形态：独占、与筛选共处、形状不对、没有码。
  assert.deepEqual(api.splitCodeFromHash("#code=" + TOKEN), { code: TOKEN, remaining: "" });
  assert.deepEqual(api.splitCodeFromHash("#workers?project=shop-api&code=" + TOKEN), { code: TOKEN, remaining: "#workers?project=shop-api" }, "the project filter survives");
  assert.deepEqual(api.splitCodeFromHash("#workers?code=" + TOKEN + "&project=shop-api"), { code: TOKEN, remaining: "#workers?project=shop-api" }, "any component position");
  assert.deepEqual(api.splitCodeFromHash("#code=nope"), { code: null, remaining: "" }, "malformed still reports (so the page clears it)");
  assert.deepEqual(api.splitCodeFromHash("#workers?project=shop-api&code=zz"), { code: null, remaining: "#workers?project=shop-api" });
  assert.equal(api.splitCodeFromHash("#workers?project=shop-api"), null, "no code component: the fragment is untouched");
  assert.equal(api.splitCodeFromHash(""), null);
  assert.equal(api.splitCodeFromHash(null), null);

  // 兑换：码走 Authorization 头，绝不进 URL；成功换回会话令牌。
  const calls = [];
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const stub = (fn) => async (url, init) => { calls.push({ url, init }); return fn(); };
  globalThis.fetch = stub(async () => ({ status: 200, ok: true, json: async () => ({ token: "cd".repeat(32), expiresAt: 123 }) }));
  assert.deepEqual(await api.exchangeSession(TOKEN), { ok: true, token: "cd".repeat(32), expiresAt: 123 });
  assert.equal(calls[0].url, "/api/session", "no query string, no code in the URL");
  assert.equal(calls[0].init.headers.authorization, "Bearer " + TOKEN, "the code rides the Authorization header");
  assert.equal(calls[0].init.method, "GET");
  // 失败闭集：401 / 坏体 / 网络错；形状不对的码不出门。
  globalThis.fetch = stub(async () => ({ status: 401, ok: false }));
  assert.deepEqual(await api.exchangeSession(TOKEN), { ok: false, reason: "unauthorized" });
  globalThis.fetch = stub(async () => ({ status: 200, ok: true, json: async () => { throw new Error("bad"); } }));
  assert.deepEqual(await api.exchangeSession(TOKEN), { ok: false, reason: "server" });
  globalThis.fetch = stub(async () => ({ status: 200, ok: true, json: async () => ({ token: "nope" }) }));
  assert.deepEqual(await api.exchangeSession(TOKEN), { ok: false, reason: "server" }, "a body without a token shape is not accepted");
  globalThis.fetch = stub(async () => { throw new TypeError("offline"); });
  assert.deepEqual(await api.exchangeSession(TOKEN), { ok: false, reason: "network" });
  assert.deepEqual(await api.exchangeSession("not-a-code"), { ok: false, reason: "unauthorized" });
  assert.equal(calls.length, 5, "a malformed code never left the page");

  // boot 顺序（G5 的 145b 延伸）：先清码片段，再兑换，然后才 resolveToken/页面片段。
  const appCode = codeOf("app.js");
  assert.ok(appCode.indexOf("splitCodeFromHash(") < appCode.indexOf("exchangeSession("), "the fragment is split (and cleared) before the exchange starts");
  assert.ok(appCode.indexOf("splitCodeFromHash(") < appCode.indexOf("resolveToken("), "the start code is handled before the token path");
  assert.ok(appCode.indexOf("await exchangeSession(") !== -1, "the exchange is awaited before any request is built");
  assert.match(appCode, /codeProblem \?\? "noToken"/, "a dead code shows its own message, not the token-less one");
  assert.ok(appCode.includes("codeExpired"), "the dead-code problem kind exists in app.js");
  // 修正一 #14：存储令牌的清除与清片段同一同步步骤（兑换途中的刷新不会读到旧令牌）。
  assert.ok(appCode.includes('writeStored(session, TOKEN_STORAGE_KEY, "");'), "the stored token is cleared in the same synchronous step as the fragment");
  // 修正一 #14：401 清令牌在 api.js 那唯一一处 fetch 的 401 分支（含详情/Activity/全文/图片/流握手）。
  const apiCode = codeOf("api.js");
  assert.match(apiCode, /response\.status === 401[\s\S]{0,400}clearStoredToken/, "the single fetch 401 branch clears the stored token");
  assert.match(apiCode, /export const bindTokenClear/, "api.js exposes the binding");
  assert.match(appCode, /bindTokenClear\(\(\) => [\s\S]{0,80}writeStored\(session, TOKEN_STORAGE_KEY, ""\)/, "app.js binds the concrete clear at boot");
  assert.doesNotMatch(appCode, /result\.reason === "unauthorized"[\s\S]{0,120}writeStored/, "the poll no longer carries its own duplicate 401 clear");
});

test("P9 request(): closed route set, bearer header only, outcomes without any server text", async (t) => {
  const calls = [];
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const reply = (status, body) => async (url, init) => {
    calls.push({ url, init });
    return { status, ok: status >= 200 && status < 300, json: async () => { if (body === undefined) throw new Error("bad json"); return body; } };
  };
  globalThis.fetch = reply(200, { status: "ready" });
  assert.deepEqual(await api.request("/api/overview", TOKEN), { ok: true, body: { status: "ready" } });
  const { url, init } = calls[0];
  assert.equal(url, "/api/overview", "the token is never in the URL");
  assert.equal(init.method, "GET");
  assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(init.cache, "no-store");
  assert.equal(init.credentials, "omit");
  assert.equal(init.referrerPolicy, "no-referrer");
  assert.ok(init.signal, "a timeout signal");
  globalThis.fetch = reply(401, { error: "unauthorized", secret: "x" });
  assert.deepEqual(await api.request("/api/workers", TOKEN), { ok: false, reason: "unauthorized" });
  globalThis.fetch = reply(500, { error: "internal" });
  assert.deepEqual(await api.request("/api/attention", TOKEN), { ok: false, reason: "server" });
  globalThis.fetch = reply(200, undefined);
  assert.deepEqual(await api.request("/api/attention", TOKEN), { ok: false, reason: "server" }, "an unreadable body");
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch: http://x/?token=leak"); };
  assert.deepEqual(await api.request("/api/overview", TOKEN), { ok: false, reason: "network" });
  const before = calls.length;
  for (const path of ["/api/runs", "/api/activity", "/api/worker", "/api/artifact", "/api/overview?x=1", "/", "https://example.com/api/overview", "/api/worker/stream?runId=run_1"]) {
    await assert.rejects(() => api.request(path, TOKEN), /not one of the dashboard routes/, path);
  }
  assert.equal(calls.length, before, "a refused path never reaches the network");
  assert.deepEqual([...api.API_PATHS], ["/api/session", "/api/overview", "/api/workers", "/api/attention", "/api/worker", "/api/artifact", "/api/worker/activity", "/api/worker/event", "/api/worker/stream"]);
  // 145b: /api/session belongs to the set but only exchangeSession() reads it — request() keeps refusing it.
  await assert.rejects(() => api.request("/api/session", TOKEN), /not one of the dashboard routes/);
  // Batch 143b: the two Activity routes are now part of the set and go through the same request function.
  globalThis.fetch = reply(200, { status: "ready" });
  assert.deepEqual(await api.request(api.activityPath({ runId: "run_1", filter: "messages" }), TOKEN), { ok: true, body: { status: "ready" } });
  assert.deepEqual(await api.request(api.eventPath({ runId: "run_1", seq: 2, part: "message" }), TOKEN), { ok: true, body: { status: "ready" } });
  assert.match(calls.at(-1).url, /^\/api\/worker\/event\?runId=run_1&seq=2&part=message$/);
});

test("P10 page fragment: three pages, default Overview, project filter only on Workers/Attention", () => {
  assert.deepEqual(model.parseHash("#overview"), { page: "overview", project: null, section: null });
  assert.deepEqual(model.parseHash("#workers"), { page: "workers", project: null, section: null });
  assert.deepEqual(model.parseHash("#attention"), { page: "attention", project: null, section: null });
  assert.deepEqual(model.parseHash("#workers?project=shop-api"), { page: "workers", project: "shop-api", section: null });
  assert.deepEqual(model.parseHash("#attention?project=docs.site_2"), { page: "attention", project: "docs.site_2", section: null });
  for (const open of ["", "#", undefined, null, "#nope", "#Overview", "#ATTENTION", `#token=${TOKEN}`, "#overview?project=x"]) {
    assert.deepEqual(model.parseHash(open), { page: "overview", project: null, section: null }, String(open));
  }
  for (const bad of ["#workers?project=", "#workers?project=-x", "#workers?project=a/b", "#workers?project=a b", "#workers?project=%3Cb%3E", `#workers?project=${"a".repeat(129)}`]) {
    assert.deepEqual(model.parseHash(bad), { page: "workers", project: null, section: null }, bad);
  }
  assert.equal(model.formatHash("overview"), "#overview");
  assert.equal(model.formatHash("workers", "shop-api"), "#workers?project=shop-api");
  assert.equal(model.formatHash("attention", "shop-api"), "#attention?project=shop-api");
  assert.equal(model.formatHash("overview", "shop-api"), "#overview", "Overview carries no filter");
  assert.equal(model.formatHash("workers", "bad slug"), "#workers", "an invalid slug is dropped");
  assert.equal(model.formatHash("nope"), "#overview");
  for (const page of model.PAGES) {
    for (const project of [null, "shop-api"]) {
      const hash = model.formatHash(page, project);
      assert.equal(model.formatHash(model.parseHash(hash).page, model.parseHash(hash).project), hash, `round trip ${hash}`);
    }
  }
  assert.deepEqual([...model.PAGES], ["overview", "workers", "attention"]);
  assert.deepEqual([...model.endpointsFor("overview")], ["/api/overview", "/api/workers"]);
  assert.deepEqual([...model.endpointsFor("workers")], ["/api/overview", "/api/workers", "/api/attention"], "Workers reads the rows and the items they point at");
  assert.deepEqual([...model.endpointsFor("workers", "shop-api")], ["/api/overview", "/api/workers?project=shop-api", "/api/attention"], "the server narrows the rows to the project (its row cap then applies to that project alone)");
  assert.deepEqual([...model.endpointsFor("workers", "bad slug")], ["/api/overview", "/api/workers", "/api/attention"], "an invalid slug is no filter");
  assert.deepEqual([...model.endpointsFor("attention", "shop-api")], ["/api/overview", "/api/attention", "/api/workers"], "Attention filters on the page, not in the request");
  assert.deepEqual([...model.endpointsFor("attention")], ["/api/overview", "/api/attention", "/api/workers"]);
  assert.deepEqual([...model.endpointsFor("junk")], ["/api/overview", "/api/workers"]);
  assert.equal(model.POLL_MS, 5000, "lists poll every 5 seconds (A4)");
});

test("P11 top bar counts: open + unknown of the whole directory; red/amber only above zero", () => {
  const body = (decide, anomalies) => ({ counts: { decide, anomalies } });
  assert.deepEqual(model.topbarCounts(body({ open: 2, unknown: 1 }, { open: 0, unknown: 3 })), { needsYou: 3, alerts: 3 });
  assert.deepEqual(model.topbarCounts(body({ open: 0, unknown: 0 }, {})), { needsYou: 0, alerts: 0 });
  assert.equal(model.topbarCounts({}), null);
  assert.equal(model.topbarCounts(undefined), null);
  assert.equal(model.countTone("needsYou", 2), "red");
  assert.equal(model.countTone("needsYou", 0), "gray", "zero: label and number go gray together");
  assert.equal(model.countTone("alerts", 1), "amber");
  assert.equal(model.countTone("alerts", 0), "gray");
  for (const bad of [null, undefined, NaN, -1]) {
    assert.equal(model.countTone("needsYou", bad), "gray");
    assert.equal(model.countTone("alerts", bad), "gray");
  }
});

// ----- fixtures: a read-model snapshot, derived and served by the REAL server -----
//
// Everything that is about interface data goes through the real chain: a snapshot in the shape of
// ownerReadModel.snapshot -> the server's deriveOwnerAttention + DTO whitelists -> the three JSON
// bodies -> the v2 model. Hand-written bodies are used only for malformed / edge input a real
// server never sends (and are named as such).

const GEN = "2026-11-26T10:42:18.000Z";
const GEN_MS = Date.parse(GEN);
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(GEN_MS - ms).toISOString();
const COMMIT = (ch) => ch.repeat(40);

const OK = (body) => ({ ok: true, body });
const OVERVIEW = "/api/overview";
const WORKERS = "/api/workers";
const ATTENTION = "/api/attention";
const PAGE_PATHS = { overview: [OVERVIEW, WORKERS], workers: [OVERVIEW, WORKERS, ATTENTION], attention: [OVERVIEW, ATTENTION, WORKERS] };

const NONE = { status: "none", reason: null };
const snapProject = (slug, name = slug) => ({ slug, name, repo: "available", branchesObservedAt: GEN, consultRecords: "available" });

/** A readable run row (ownerReadModel.projectRun's shape); defaults to a finished root run of shop-api. */
function snapRun(runId, over = {}) {
  return {
    runId,
    project: { slug: "shop-api", name: "shop-api" },
    availability: "ok",
    state: "completed",
    terminal: true,
    liveness: "terminal",
    stage: "terminal",
    agentId: "glm-pro",
    laneId: "glm-pro",
    roleId: "coder",
    readOnly: false,
    deliveryRequested: false,
    title: `title of ${runId}`,
    titleBasis: "first_line",
    taskType: "code",
    typeBasis: "persisted",
    startedAt: ago(5 * HOUR),
    terminalAt: ago(4 * HOUR),
    terminalSeq: null,
    stageSince: ago(5 * HOUR),
    lastEffectAt: ago(4 * HOUR),
    quietSince: ago(5 * HOUR),
    quietSinceSeq: null,
    lastVitalAt: ago(4 * HOUR),
    lastProcessActiveAt: null,
    retryOf: null,
    parentRunId: null,
    delivery: null,
    failure: null,
    capacity: null,
    lineageRootRunId: runId,
    lineageRootConflict: false,
    supersessionUndeterminable: false,
    legalDecision: null,
    supersededByRunId: null,
    ...over,
  };
}
/** A run still going. */
const snapLive = (runId, over = {}) => snapRun(runId, {
  state: "running", terminal: false, liveness: "progress", stage: "active", terminalAt: null, startedAt: ago(10 * MIN), lastEffectAt: ago(MIN), ...over,
});
/** A delivery (projectDelivery's shape); defaults to settled 1h ago, verification passed, awaiting a decision, branch present. */
const snapDelivery = (over = {}) => ({
  settlement: { status: "settled", reason: "delivery_settled" },
  commit: COMMIT("c"),
  verification: { status: "passed", reverify: NONE },
  acceptance: { status: "pending", decidedAt: null, decidedSeq: null },
  settledAt: ago(HOUR),
  settledSeq: null,
  ambiguous: false,
  packagingFailure: null,
  isolationFailure: null,
  branchPresent: true,
  ...over,
});
const snapSeat = (runId, q1, over = {}) => ({ agentId: `seat_${runId}`, runId, runState: q1 === null ? "running" : "completed", q1, replied: q1 !== null, ...over });
const snapConsult = (over = {}) => ({
  consultId: "consult_order", projectSlug: "shop-api", createdAt: ago(25 * MIN), reviewedRunId: "run_rev", q1Declared: true, declaredFields: null, seats: [], ...over,
});
const snapshotOf = ({ runs = [], consults = [], projects = [snapProject("shop-api")] } = {}) => ({ generatedAt: GEN, projects, runs, consults });

/**
 * Run a snapshot through the real server: refresh once at `now`, then GET the three read routes.
 * Returns the three bodies exactly as the browser would receive them.
 */
async function chain(snapshot, now = GEN_MS) {
  const model = { async refresh() {}, snapshot: (args) => ({ ...snapshot, generatedAt: new Date(args.now).toISOString() }) };
  const s = makeServer({ createReadModelFn: () => model, nowFn: () => now });
  assert.equal(await s.refreshNow(), "ready");
  const get = async (url) => {
    const r = await drive(s.handler, { url, headers: { authorization: `Bearer ${s.token}` } });
    assert.equal(r.status, 200, url);
    return JSON.parse(r.body);
  };
  return { overview: await get(OVERVIEW), workers: await get(WORKERS), attention: await get(ATTENTION), server: s };
}

/** The page state after the page's own polling cycle(s), from bodies of one publication. */
function netOf(bodies, pages = ["overview", "workers", "attention"], prev = model.INITIAL_NET, nowMs = GEN_MS, project = null) {
  const byPath = { [OVERVIEW]: bodies.overview, [WORKERS]: bodies.workers, [ATTENTION]: bodies.attention };
  let net = prev;
  for (const page of pages) {
    // The Workers page asks for its rows narrowed to the project filter: the path is the key of the body.
    const paths = page === "workers" ? model.endpointsFor("workers", project) : PAGE_PATHS[page];
    net = model.applyCycle(net, { page, paths, results: paths.map((path) => OK(byPath[path.split("?")[0]])) }, nowMs);
  }
  return net;
}

const visitFirst = () => model.visitWindow({ storedMs: null, nowMs: GEN_MS });
const visitAgo = (ms) => model.visitWindow({ storedMs: GEN_MS - ms, nowMs: GEN_MS });
const mainOf = (net, page, extra = {}) => model.buildMain({ net, page, project: null, visit: visitFirst(), nowMs: GEN_MS, ...extra });

/**
 * The shop: shop-api (running work of several types, one silent, a split delivery review with three
 * seats, a failed verification, a waiting delivery that is 9 days old, kimi throttled, a failure),
 * docs-site (a coding and two starting image workers), mobile-app (idle for 5h).
 */
function shopSnapshot() {
  const runs = [
    snapLive("run_r1", { laneId: "glm-pro", agentId: "glm-pro", title: "Migrate orders table", startedAt: ago(38 * MIN), liveness: "silent", quietSince: ago(40 * MIN), quietSinceSeq: 138, lastEffectAt: ago(40 * MIN) }),
    snapLive("run_r2", { laneId: "opus", agentId: "opus", title: "Refactor payment module", startedAt: ago(20 * MIN) }),
    snapLive("run_r3", { title: "Add pagination", startedAt: ago(5 * MIN) }),
    snapLive("run_r4", { taskType: "delivery_review", laneId: "kimi", agentId: "kimi", title: "Delivery review: order export", startedAt: ago(6 * MIN) }),
    snapLive("run_r5", { taskType: "research", laneId: "deepseek-flash", agentId: "deepseek-flash", title: "Pagination research", startedAt: ago(12 * MIN) }),
    snapLive("run_r6", { taskType: "research", laneId: "deepseek-flash", agentId: "deepseek-flash", title: "Warm up", startedAt: ago(20_000), stage: "starting", lastEffectAt: null }),
    // finished work (the Since-your-last-visit counts)
    snapRun("run_f1", { title: "Done one", terminalAt: ago(HOUR) }),
    snapRun("run_f2", { title: "Done two", terminalAt: ago(2 * HOUR) }),
    snapRun("run_f3", { title: "Broke", state: "failed", terminalAt: ago(30 * MIN), terminalSeq: 90, failure: { category: "provider_error", code: "backend_error" } }),
    // the reviewed delivery of the split review, seats 1 and 2 (done), seat 3 is run_r4 (still running)
    snapRun("run_rev", { title: "Order export", deliveryRequested: true, terminalAt: ago(2 * HOUR), delivery: snapDelivery({ commit: COMMIT("a"), settledAt: ago(HOUR) }) }),
    snapRun("run_s1", { title: "Seat one", laneId: "sol", agentId: "sol", taskType: "delivery_review", terminalAt: ago(40 * MIN), terminalSeq: 12 }),
    snapRun("run_s2", { title: "Seat two", laneId: "astra", agentId: "astra", taskType: "delivery_review", terminalAt: ago(30 * MIN), terminalSeq: 14 }),
    // a failed verification
    snapRun("run_pay", { title: "Refactor payment module", deliveryRequested: true, terminalAt: ago(HOUR), delivery: snapDelivery({ commit: COMMIT("b"), verification: { status: "failed", reverify: NONE }, settledAt: ago(12 * MIN), settledSeq: 52 }) }),
    // a delivery waiting for 9 days
    snapRun("run_old", { title: "Old delivery", deliveryRequested: true, terminalAt: ago(9 * DAY), delivery: snapDelivery({ commit: COMMIT("e"), settledAt: ago(9 * DAY), settledSeq: 7 }) }),
    // kimi throttled (a failed run with a rate-limit observation)
    snapRun("run_rl", { title: "Throttled", laneId: "kimi", agentId: "kimi", state: "failed", terminalAt: ago(35 * MIN), failure: { category: "provider_capacity", code: "rate_limited" }, capacity: { code: "rate_limited", observedAt: ago(35 * MIN), observedSeq: 33 } }),
    // docs-site
    snapLive("run_d1", { project: { slug: "docs-site", name: "docs-site" }, laneId: "fable", agentId: "fable", title: "Rewrite README", startedAt: ago(9 * MIN) }),
    snapLive("run_d2", { project: { slug: "docs-site", name: "docs-site" }, taskType: "image", laneId: "sol", agentId: "sol", title: "Hero image", startedAt: ago(2 * MIN), stage: "starting", lastEffectAt: null }),
    snapLive("run_d3", { project: { slug: "docs-site", name: "docs-site" }, taskType: "image", laneId: "sol", agentId: "sol", title: "Alt text", startedAt: ago(30_000), stage: "starting", lastEffectAt: null }),
    // mobile-app: idle, last finished 5h ago
    snapRun("run_m1", { project: { slug: "mobile-app", name: "mobile-app" }, title: "Old", startedAt: ago(6 * HOUR), terminalAt: ago(5 * HOUR) }),
  ];
  return snapshotOf({
    runs,
    consults: [snapConsult({ seats: [snapSeat("run_s1", "PASS"), snapSeat("run_s2", "FIX_FIRST"), snapSeat("run_r4", null)] })],
    projects: [snapProject("shop-api"), snapProject("docs-site"), snapProject("mobile-app")],
  });
}

const shopChain = () => chain(shopSnapshot());

// ----- state: one polling cycle per page, retained per page, freshness derived from the clock -----

test("P12 applyCycle: a consistent cycle stores that page's data; freshness reads Polling", async () => {
  const bodies = await shopChain();
  const net = netOf(bodies, ["overview"], model.INITIAL_NET, GEN_MS + 5000);
  assert.deepEqual(Object.keys(net.pages), ["overview"]);
  assert.equal(net.pages.overview.generatedAt, GEN);
  assert.deepEqual(Object.keys(net.pages.overview.bodies).sort(), [OVERVIEW, WORKERS]);
  assert.equal(net.failingSinceMs, null);
  assert.equal(net.serverStale, null);
  assert.equal(net.problem, null);
  assert.deepEqual(model.freshnessOf(net, GEN_MS + 5000), { kind: "polling", sinceMs: null });
  assert.deepEqual(Object.keys(model.INITIAL_NET.pages), [], "the initial state is not mutated");
});

test("P13 applyCycle: a failed cycle keeps every page's data and goes stale from the FIRST failure; recovery clears it", async () => {
  const bodies = await shopChain();
  const good = netOf(bodies, ["overview", "attention"], model.INITIAL_NET, GEN_MS);
  const fail = (reason, page = "overview") => ({ page, paths: PAGE_PATHS[page], results: PAGE_PATHS[page].map(() => ({ ok: false, reason })) });
  const first = model.applyCycle(good, fail("network"), GEN_MS + 1000);
  assert.deepEqual(first.pages, good.pages, "every page's numbers and content are kept");
  assert.equal(first.failingSinceMs, GEN_MS + 1000);
  assert.equal(first.problem, "network");
  assert.deepEqual(model.freshnessOf(first, GEN_MS + 1000), { kind: "stale", sinceMs: GEN_MS + 1000 });
  const second = model.applyCycle(first, fail("server"), GEN_MS + 6000);
  assert.equal(second.failingSinceMs, GEN_MS + 1000, "the streak starts at the first failure");
  assert.equal(second.problem, "server");
  assert.deepEqual(model.freshnessOf(second, GEN_MS + 6000), { kind: "stale", sinceMs: GEN_MS + 1000 });
  const recovered = model.applyCycle(second, { page: "overview", paths: PAGE_PATHS.overview, results: [OK(bodies.overview), OK(bodies.workers)] }, GEN_MS + 11000);
  assert.equal(recovered.failingSinceMs, null);
  assert.equal(recovered.problem, null);
  assert.deepEqual(model.freshnessOf(recovered, GEN_MS + 11000), { kind: "polling", sinceMs: null });
  // Several failures in one cycle: unauthorized outranks network outranks server.
  const mixed = model.applyCycle(good, { page: "overview", paths: PAGE_PATHS.overview, results: [{ ok: false, reason: "server" }, { ok: false, reason: "unauthorized" }] }, GEN_MS + 7);
  assert.equal(mixed.problem, "unauthorized");
  // Nothing loaded yet: nothing can be stale; the label stays "loading" and the problem is remembered.
  const cold = model.applyCycle(model.INITIAL_NET, fail("network"), GEN_MS + 9);
  assert.deepEqual(cold.pages, {});
  assert.equal(cold.problem, "network");
  assert.deepEqual(model.freshnessOf(cold, GEN_MS + 9), { kind: "loading", sinceMs: null });
  assert.deepEqual(model.freshnessOf({ ...model.INITIAL_NET, problem: "noToken" }, GEN_MS), { kind: "idle", sinceMs: null });
});

test("P14 applyCycle: the server's own stale status keeps the data, stale since staleSince (else the data's own time)", async () => {
  const bodies = await shopChain();
  const stale = (staleSince) => ({ ...bodies.overview, status: "stale", staleSince });
  const at = new Date(GEN_MS - 2000).toISOString();
  const net = model.applyCycle(model.INITIAL_NET, { page: "workers", paths: PAGE_PATHS.workers, results: [OK(stale(at))] }, GEN_MS + 100);
  assert.deepEqual(net.serverStale, { sinceMs: GEN_MS - 2000 });
  assert.ok(net.pages.workers, "the last publication is still shown");
  assert.deepEqual(model.freshnessOf(net, GEN_MS + 100), { kind: "stale", sinceMs: GEN_MS - 2000 });
  const noTime = model.applyCycle(model.INITIAL_NET, { page: "workers", paths: PAGE_PATHS.workers, results: [OK(stale(null))] }, GEN_MS + 100);
  assert.deepEqual(model.freshnessOf(noTime, GEN_MS + 100), { kind: "stale", sinceMs: GEN_MS });
  // The server recovers (ready again): the mark goes away.
  const ready = model.applyCycle(net, { page: "workers", paths: PAGE_PATHS.workers, results: [OK(bodies.overview)] }, GEN_MS + 200);
  assert.equal(ready.serverStale, null);
});

test("P15 applyCycle: loading / unavailable carry no data; answers from two publications are not committed", async () => {
  const bodies = await shopChain();
  const loading = model.applyCycle(model.INITIAL_NET, { page: "workers", paths: PAGE_PATHS.workers, results: [OK({ status: "loading" })] }, GEN_MS);
  assert.deepEqual(loading.pages, {});
  assert.equal(loading.problem, null);
  assert.equal(model.freshnessOf(loading, GEN_MS).kind, "loading");
  const unavailable = model.applyCycle(model.INITIAL_NET, { page: "workers", paths: PAGE_PATHS.workers, results: [OK({ status: "unavailable", staleSince: GEN })] }, GEN_MS);
  assert.deepEqual(unavailable.pages, {});
  assert.equal(unavailable.problem, "unavailable");
  assert.deepEqual(unavailable.serverStale, { sinceMs: GEN_MS });
  // Two publications within one cycle: the previous state comes back as the SAME object.
  const prev = netOf(bodies, ["overview"]);
  const newer = new Date(GEN_MS + 5000).toISOString();
  const cycle = { page: "overview", paths: PAGE_PATHS.overview, results: [OK(bodies.overview), OK({ ...bodies.workers, generatedAt: newer })] };
  assert.equal(model.applyCycle(prev, cycle, GEN_MS + 9), prev, "no half-old, half-new screen");
  assert.equal(model.applyCycle(model.INITIAL_NET, cycle, GEN_MS + 9), model.INITIAL_NET);
});

test("P16 applyCycle (malformed bodies a real server never sends): an unusable body is a failure, not data", async () => {
  const bodies = await shopChain();
  const good = netOf(bodies, ["overview"]);
  const bad = [
    OK(null), OK("x"), OK({}), OK({ status: "weird" }),
    OK({ status: "ready", generatedAt: GEN }),                                          // overview without counts / projects / lanes
    OK({ status: "ready", generatedAt: GEN, counts: {}, projects: {}, lanes: [] }),
  ];
  for (const result of bad) {
    const next = model.applyCycle(good, { page: "workers", paths: PAGE_PATHS.workers, results: [result] }, GEN_MS + 100);
    assert.deepEqual(next.pages, good.pages, JSON.stringify(result));
    assert.equal(next.problem, "server");
    assert.equal(next.failingSinceMs, GEN_MS + 100);
  }
  const workers = (body) => model.applyCycle(model.INITIAL_NET, { page: "overview", paths: [WORKERS], results: [OK(body)] }, 1);
  assert.equal(workers({ status: "ready", generatedAt: GEN, workers: {} }).problem, "server");
  const attention = model.applyCycle(model.INITIAL_NET, { page: "attention", paths: [ATTENTION], results: [OK({ status: "ready", generatedAt: GEN, decide: [], anomalies: [] })] }, 1);
  assert.equal(attention.problem, "server");
});

test("P36 freshness by age: a snapshot that stops being renewed reads Stale 30s after it was published — even when the server keeps answering", async () => {
  assert.equal(model.STALE_AFTER_MS, 30_000);
  const bodies = await shopChain();
  const net = netOf(bodies, ["overview"], model.INITIAL_NET, GEN_MS);
  assert.deepEqual(model.freshnessOf(net, GEN_MS + 30_000), { kind: "polling", sinceMs: null }, "exactly the limit is still fresh");
  assert.deepEqual(model.freshnessOf(net, GEN_MS + 30_001), { kind: "stale", sinceMs: GEN_MS + 30_000 }, "since the moment it crossed the limit");
  assert.deepEqual(model.freshnessOf(net, GEN_MS + 2 * MIN), { kind: "stale", sinceMs: GEN_MS + 30_000 }, "two minutes later: still since the first moment");
  // The same "ready" publication answered again and again (the server's refresh chain is stuck): every
  // poll commits an identical cycle, and the age still runs.
  let again = net;
  for (let i = 1; i <= 60; i += 1) again = netOf(bodies, ["overview"], again, GEN_MS + i * 5000);
  assert.deepEqual(model.freshnessOf(again, GEN_MS + 60 * 5000), { kind: "stale", sinceMs: GEN_MS + 30_000 });
  // Answers that keep coming from two different publications (nothing is ever committed): the state is
  // the identical object each time, and the age still makes it stale — 60 cycles of that never look healthy.
  let mismatching = net;
  for (let i = 1; i <= 60; i += 1) {
    const newer = new Date(GEN_MS + i * 5000).toISOString();
    mismatching = model.applyCycle(mismatching, { page: "overview", paths: PAGE_PATHS.overview, results: [OK(bodies.overview), OK({ ...bodies.workers, generatedAt: newer })] }, GEN_MS + i * 5000);
  }
  assert.equal(mismatching, net);
  assert.equal(model.freshnessOf(mismatching, GEN_MS + 60 * 5000).kind, "stale");
  // A fresh publication clears it.
  const renewed = { ...bodies, overview: { ...bodies.overview, generatedAt: new Date(GEN_MS + 3 * MIN).toISOString() }, workers: { ...bodies.workers, generatedAt: new Date(GEN_MS + 3 * MIN).toISOString() } };
  const next = netOf(renewed, ["overview"], again, GEN_MS + 3 * MIN);
  assert.deepEqual(model.freshnessOf(next, GEN_MS + 3 * MIN + 1000), { kind: "polling", sinceMs: null });
  // Failing requests and an old snapshot together: the EARLIEST moment is the "since".
  const failing = model.applyCycle(net, { page: "overview", paths: PAGE_PATHS.overview, results: [{ ok: false, reason: "network" }, { ok: false, reason: "network" }] }, GEN_MS + 20_000);
  assert.deepEqual(model.freshnessOf(failing, GEN_MS + 40_000), { kind: "stale", sinceMs: GEN_MS + 20_000 });
  // An unreadable publication time cannot be judged fresh.
  const odd = netOf({ ...bodies, overview: { ...bodies.overview, generatedAt: "not a time" }, workers: { ...bodies.workers, generatedAt: "not a time" } }, ["overview"]);
  assert.deepEqual(model.freshnessOf(odd, GEN_MS), { kind: "stale", sinceMs: null });
});

test("P37 each page keeps its last complete data: Attention → Workers → Attention, then the server goes away — both still show, marked stale", async () => {
  const bodies = await shopChain();
  // The Owner visited Attention, then Workers (a different route set), and the page is on Attention again.
  let net = netOf(bodies, ["attention", "workers"]);
  assert.deepEqual(Object.keys(net.pages).sort(), ["attention", "workers"]);
  // The next poll fails.
  net = model.applyCycle(net, { page: "attention", paths: PAGE_PATHS.attention, results: PAGE_PATHS.attention.map(() => ({ ok: false, reason: "network" })) }, GEN_MS + 5000);
  const attention = mainOf(net, "attention");
  assert.equal(attention.page, "attention", "the Attention page still shows what it showed before");
  assert.ok(attention.decide.total > 0);
  assert.equal(mainOf(net, "workers").page, "workers", "so does the page visited in between");
  assert.deepEqual(model.buildTopbar(net, "attention", GEN_MS + 5000).freshness, { kind: "stale", sinceMs: GEN_MS + 5000 });
  assert.deepEqual(model.buildTopbar(net, "attention", GEN_MS + 5000).counts, { needsYou: 3, alerts: 4 }, "the counts of the last data");
  // A page never loaded has nothing to show: the problem.
  assert.deepEqual(mainOf(net, "overview"), { page: "message", kind: "network" });
  // Recovery clears the mark (and refills the page just polled).
  const back = model.applyCycle(net, { page: "overview", paths: PAGE_PATHS.overview, results: [OK(bodies.overview), OK(bodies.workers)] }, GEN_MS + 10_000);
  assert.deepEqual(model.freshnessOf(back, GEN_MS + 10_000), { kind: "polling", sinceMs: null });
  assert.equal(mainOf(back, "overview").page, "overview");
  assert.equal(mainOf(back, "attention").page, "attention", "the others are still there");
});

test("P38 top bar and body are one publication: a cached page shows ITS OWN counts and is Stale while a newer snapshot exists elsewhere", async () => {
  // The Owner looked at Attention (publication A, 3 needs-you). Then Workers got a NEWER publication B (2 needs-you).
  const A = await shopChain();
  const snapB = shopSnapshot();
  snapB.runs = snapB.runs.filter((run) => run.runId !== "run_pay");            // one needs-you item fewer
  const B = await chain(snapB, GEN_MS + 10_000);
  let net = netOf(A, ["attention"], model.INITIAL_NET, GEN_MS);
  net = netOf(B, ["workers"], net, GEN_MS + 10_000);
  assert.equal(model.latestGeneration(net).generatedAt, new Date(GEN_MS + 10_000).toISOString());
  // Back on Attention: the body is publication A's (3 items) …
  const body = mainOf(net, "attention");
  assert.equal(body.decide.total, 3);
  // … and so is the top bar: the same counts, and it says Stale (A is older than B) from the moment B existed — not "Polling".
  const bar = model.buildTopbar(net, "attention", GEN_MS + 10_500);
  assert.deepEqual(bar.counts, { needsYou: 3, alerts: 4 }, "the counts of the data on screen, not of the newest publication elsewhere");
  assert.deepEqual(bar.freshness, { kind: "stale", sinceMs: GEN_MS + 10_000 });
  assert.equal(bar.counts.needsYou, body.decide.total, "bar = body");
  // The page whose data IS the newest is fresh and shows its own numbers.
  const workersBar = model.buildTopbar(net, "workers", GEN_MS + 10_500);
  assert.deepEqual(workersBar.counts, { needsYou: 2, alerts: 4 });
  assert.deepEqual(workersBar.freshness, { kind: "polling", sinceMs: null });
  // Once Attention's own cycle for B arrives, everything agrees and the mark is gone.
  const back = netOf(B, ["attention"], net, GEN_MS + 11_000);
  assert.deepEqual(model.buildTopbar(back, "attention", GEN_MS + 11_000).counts, { needsYou: 2, alerts: 4 });
  assert.deepEqual(model.buildTopbar(back, "attention", GEN_MS + 11_000).freshness, { kind: "polling", sinceMs: null });
  assert.equal(mainOf(back, "attention").decide.total, 2);
  // A page with nothing cached has no body to disagree with: the bar uses the newest publication.
  const cold = netOf(B, ["workers"], model.INITIAL_NET, GEN_MS + 10_000);
  assert.deepEqual(model.buildTopbar(cold, "attention", GEN_MS + 10_500).counts, { needsYou: 2, alerts: 4 });
  assert.deepEqual(model.buildTopbar(model.INITIAL_NET, "overview", GEN_MS).counts, null);
  // A failure on top of an outdated page: the EARLIEST moment is the "since".
  const failing = model.applyCycle(net, { page: "attention", paths: PAGE_PATHS.attention, results: PAGE_PATHS.attention.map(() => ({ ok: false, reason: "network" })) }, GEN_MS + 10_700);
  assert.deepEqual(model.buildTopbar(failing, "attention", GEN_MS + 10_800).freshness, { kind: "stale", sinceMs: GEN_MS + 10_000 });
  // freshnessOf without a page keeps judging the newest publication (the old behavior is still available).
  assert.deepEqual(model.freshnessOf(net, GEN_MS + 10_500), { kind: "polling", sinceMs: null });
  assert.equal(model.buildTopbar.length, 3);
});
test("P17 last visit: the cut-off is the visit read when the page opened (fixed per load); an unusable record is the first visit", () => {
  const now = Date.parse("2026-11-26T12:00:00Z");
  const three = now - 3 * HOUR;
  assert.deepEqual(model.visitWindow({ storedMs: three, nowMs: now }), { kind: "visit", cutoffMs: three });
  assert.deepEqual(model.visitWindow({ storedMs: now - 24 * HOUR, nowMs: now }), { kind: "visit", cutoffMs: now - 24 * HOUR });
  assert.deepEqual(model.visitWindow({ storedMs: now - 3 * 24 * HOUR, nowMs: now }), { kind: "visit", cutoffMs: now - 3 * 24 * HOUR }, "an old visit is still the visit; the 24h limit is applied per publication");
  const first = { kind: "first", cutoffMs: now - 24 * HOUR };
  for (const stored of [null, undefined, NaN, 0, -5, now + 1, "x", Infinity]) {
    assert.deepEqual(model.visitWindow({ storedMs: stored, nowMs: now }), first, `unusable ${String(stored)} -> first visit`);
  }
  assert.deepEqual(model.visitWindow({ storedMs: now, nowMs: now }), { kind: "visit", cutoffMs: now });
  assert.equal(model.parseStoredVisit("1764151200000"), 1764151200000);
  for (const bad of [null, undefined, "", "abc", "-5", "1.5", "0", "12345678901234567", " 5", "5 ", 5]) {
    assert.equal(model.parseStoredVisit(bad), null, String(bad));
  }
});
// ----- Overview -----

test("P18 Overview headline (real counts): Starting is taken out of running; zero Starting is left out", async () => {
  const { overview, workers } = await shopChain();
  assert.equal(overview.counts.running, 9);
  assert.equal(overview.counts.starting, 3);
  const vm = model.buildOverview({ overview, workers }, { refMs: GEN_MS, visit: visitFirst() });
  assert.deepEqual(vm.headline, { projects: 3, running: 6, starting: 3 });
  const calm = await chain(snapshotOf({ runs: [snapLive("run_x")] }));
  assert.deepEqual(model.buildOverview(calm, { refMs: GEN_MS, visit: visitFirst() }).headline, { projects: 1, running: 1, starting: 0 });
});

test("P19 Overview blocks (real chain): order, markers, type rows, lanes, longest, the unhealthy named, seats in", async () => {
  const { overview, workers } = await shopChain();
  const vm = model.buildOverview({ overview, workers }, { refMs: GEN_MS, visit: visitFirst() });
  assert.deepEqual(vm.blocks.map((b) => b.slug), ["shop-api", "docs-site", "mobile-app"]);
  const shop = vm.blocks[0];
  assert.equal(shop.decide, 3, "split review, failed verification, the 9-day-old waiting delivery");
  assert.equal(shop.anomalies, 4, "silent, throttled lane, two failures");
  assert.equal(shop.idle, false);
  assert.deepEqual(shop.typeRows.map((r) => r.type), ["code", "research", "delivery_review"], "unhealthy row first, then the longest running");
  const code = shop.typeRows[0];
  assert.equal(code.count, 3);
  assert.deepEqual(code.lanes, ["glm-pro", "opus"]);
  assert.equal(code.longestMs, 38 * MIN);
  assert.deepEqual(code.unhealthy, [{ runId: "run_r1", health: "silent", ageMs: 40 * MIN }]);
  assert.equal(code.seats, null, "no review group, no seats");
  assert.equal(shop.typeRows[1].unhealthy.length, 0, "healthy rows are only counted");
  assert.equal(shop.typeRows[1].starting, 1, "a starting worker is counted, not named unhealthy");
  assert.deepEqual(shop.typeRows[2].seats, { in: 2, total: 3 }, "the review row: 2 of 3 seats in (from the review group, not from the rows listed)");
  assert.deepEqual(vm.blocks[1].typeRows.map((r) => r.type), ["code", "image"]);
  assert.equal(vm.blocks[1].typeRows[1].starting, 2);
  const idle = vm.blocks[2];
  assert.equal(idle.idle, true);
  assert.deepEqual(idle.typeRows, []);
  assert.equal(idle.lastFinishedAgoMs, 5 * HOUR, "idle · last run finished 5h ago");
  assert.deepEqual(vm.lanes, { inUse: 6, throttled: [{ laneKey: "kimi", quota: false, observedAtMs: GEN_MS - 35 * MIN }] });
});

test("P20 Overview lane row: only with a throttled or exhausted lane (real chain); quota reads as quota", async () => {
  const calm = await chain(snapshotOf({ runs: [snapLive("run_x")] }));
  assert.equal(model.buildOverview(calm, { refMs: GEN_MS, visit: visitFirst() }).lanes, null);
  const quota = await chain(snapshotOf({ runs: [snapRun("run_q", {
    laneId: "sol", agentId: "sol", state: "failed", failure: { category: "provider_capacity", code: "quota_exhausted" },
    capacity: { code: "quota_exhausted", observedAt: ago(HOUR) }, terminalAt: ago(HOUR),
  })] }));
  assert.deepEqual(model.buildOverview(quota, { refMs: GEN_MS, visit: visitFirst() }).lanes, { inUse: 0, throttled: [{ laneKey: "sol", quota: true, observedAtMs: GEN_MS - HOUR }] });
});

test("P21 Overview block order (real chain): needs-you first, then alerts, then latest progress; idle one-liners last — an idle project with items is ordered by its items", async () => {
  const proj = (slug) => ({ slug, name: slug });
  const live = (slug, effectAgo, over = {}) => snapLive(`run_${slug}`, { project: proj(slug), lastEffectAt: ago(effectAgo), ...over });
  const waiting = (slug) => snapRun(`run_wait_${slug}`, { project: proj(slug), deliveryRequested: true, terminalAt: ago(4 * HOUR), delivery: snapDelivery({ settledAt: ago(3 * HOUR) }) });
  const snap = snapshotOf({
    projects: ["a", "b", "c", "d", "e", "f", "g"].map((slug) => snapProject(slug)),
    runs: [
      live("a", 5 * MIN),
      live("b", MIN),
      live("c", 20 * MIN, { liveness: "silent", quietSince: ago(40 * MIN) }), // running + an alert
      live("d", 10 * MIN), waiting("d"),                                       // running + needs you
      waiting("e"),                                                            // idle + needs you
      snapRun("run_f", { project: proj("f"), terminalAt: ago(HOUR) }),         // idle, finished 1h ago
    ],
  });
  const vm = model.buildOverview(await chain(snap), { refMs: GEN_MS, visit: visitFirst() });
  // d (running, needs you) > e (idle, needs you — NOT sunk) > c (alert) > b (latest progress) > a; idle without items: f (1h) > g.
  assert.deepEqual(vm.blocks.map((b) => b.slug), ["d", "e", "c", "b", "a", "f", "g"]);
  assert.deepEqual(vm.blocks.map((b) => b.idle), [false, true, false, false, false, true, true]);
  assert.equal(vm.blocks[1].decide, 1, "the idle project keeps its marker");
  assert.equal(vm.blocks[6].lastFinishedAgoMs, null, "an idle project with no listed run says so (no invented time)");
});

test("P21b same tier (real chain): projects with the same marks go by the most recent real progress, newest first — an idle project is NOT sunk behind a running one; sinking is only for projects with neither mark", async () => {
  const proj = (slug) => ({ slug, name: slug });
  const waiting = (slug) => snapRun(`run_wait_${slug}`, { project: proj(slug), deliveryRequested: true, terminalAt: ago(4 * HOUR), delivery: snapDelivery({ settledAt: ago(3 * HOUR) }) });
  const finished = (slug, agoMs) => snapRun(`run_fin_${slug}`, { project: proj(slug), terminalAt: ago(agoMs) });
  const running = (slug, effectAgo, over = {}) => snapLive(`run_${slug}`, { project: proj(slug), lastEffectAt: ago(effectAgo), ...over });
  const order = async (runs, slugs) => {
    const vm = model.buildOverview(await chain(snapshotOf({ projects: slugs.map((slug) => snapProject(slug)), runs })), { refMs: GEN_MS, visit: visitFirst() });
    return vm.blocks.map((b) => b.slug);
  };
  // Red only. x: running, last action 10s ago. y: idle, finished 1s ago. y is the newer: y first.
  assert.deepEqual(await order([running("x", 10_000), waiting("x"), waiting("y"), finished("y", 1000)], ["x", "y"]), ["y", "x"]);
  // The other way round: the running project's action is newer than the idle one's finish: x first.
  assert.deepEqual(await order([running("x", 1000), waiting("x"), waiting("y"), finished("y", 10_000)], ["x", "y"]), ["x", "y"]);
  // Amber only (a silent run / a failed run), same rule.
  const silentRunning = running("p", 40 * MIN, { liveness: "silent", quietSince: ago(40 * MIN) });
  const failedIdle = snapRun("run_fail_q", { project: proj("q"), state: "failed", terminalAt: ago(30 * MIN), failure: { category: "provider_error", code: "backend_error" } });
  assert.deepEqual(await order([silentRunning, failedIdle], ["p", "q"]), ["q", "p"]);
  // Red > amber still decides first, whatever the progress: r (red, idle, old) before p (amber, running, new).
  assert.deepEqual(await order([running("p", 1000, { liveness: "silent", quietSince: ago(40 * MIN) }), waiting("r"), finished("r", 20 * HOUR)], ["p", "r"]), ["r", "p"]);
  // Neither mark: running before idle, even when the idle one finished more recently.
  assert.deepEqual(await order([running("a", 20 * MIN), finished("b", 1000)], ["a", "b"]), ["a", "b"]);
  // Both tiers together: marked projects by progress, then unmarked running, then unmarked idle by finish time.
  assert.deepEqual(
    await order([running("m", 5 * MIN), waiting("m"), waiting("n"), finished("n", MIN), running("o", 2 * MIN), finished("p", HOUR), finished("q", 30 * MIN)], ["m", "n", "o", "p", "q"]),
    ["n", "m", "o", "q", "p"],
  );
});
test("P22 Overview type rows with equal health: longest running first, then the fixed type order; unknown types are Untyped", async () => {
  const snap = snapshotOf({ runs: [
    snapLive("run_1", { taskType: "test", startedAt: ago(10 * MIN) }),
    snapLive("run_2", { taskType: "plan_review", startedAt: ago(10 * MIN) }),
    snapLive("run_3", { taskType: "research", startedAt: ago(30 * MIN) }),
    snapLive("run_4", { taskType: "untyped", startedAt: ago(MIN), laneId: null, agentId: null }),
  ] });
  const vm = model.buildOverview(await chain(snap), { refMs: GEN_MS, visit: visitFirst() });
  assert.deepEqual(vm.blocks[0].typeRows.map((r) => r.type), ["research", "test", "plan_review", "untyped"]);
  // A type value the closed set does not know (hand-made body: the real server only sends the set).
  const odd = model.buildOverview({
    overview: { status: "ready", generatedAt: GEN, counts: { running: 1, starting: 0 }, projects: [{ slug: "shop-api", name: "shop-api", counts: { running: 1 } }], lanes: [] },
    workers: { status: "ready", generatedAt: GEN, truncated: false, workers: [{ runId: "run_m", project: { slug: "shop-api" }, state: "running", taskType: "mystery", laneKey: null, startedAt: null }] },
  }, { refMs: GEN_MS, visit: visitFirst() });
  assert.deepEqual(odd.blocks[0].typeRows.map((r) => [r.type, r.lanes, r.longestMs]), [["untyped", [], null]], "a missing lane is left out, not invented");
});

test("P23 Overview unhealthy workers: process-only too; several are listed quietest first; no quiet time is a dash", async () => {
  const snap = snapshotOf({ runs: [
    snapLive("run_p", { liveness: "process_only", quietSince: ago(3 * MIN) }),
    snapLive("run_s", { liveness: "silent", quietSince: ago(9 * MIN) }),
    snapLive("run_u", { liveness: "silent", quietSince: null }),
    snapLive("run_k", { liveness: "unknown" }),
  ] });
  const vm = model.buildOverview(await chain(snap), { refMs: GEN_MS, visit: visitFirst() });
  assert.deepEqual(vm.blocks[0].typeRows[0].unhealthy.map((u) => [u.runId, u.health, u.ageMs]), [
    ["run_s", "silent", 9 * MIN], ["run_p", "process_only", 3 * MIN], ["run_u", "silent", null],
  ]);
  // A row with an unhealthy worker goes above a healthier row that has been running longer.
  const mixed = snapshotOf({ runs: [
    snapLive("run_h", { taskType: "research", startedAt: ago(30 * MIN) }),
    snapLive("run_q", { taskType: "test", startedAt: ago(5 * MIN), liveness: "silent", quietSince: ago(MIN) }),
  ] });
  assert.deepEqual(model.buildOverview(await chain(mixed), { refMs: GEN_MS, visit: visitFirst() }).blocks[0].typeRows.map((r) => r.type), ["test", "research"]);
});

test("P24 Overview 'since your last visit' (real chain): counts from the cut-off; never before now - 24h; old kept deliveries are not counted", async () => {
  const bodies = await shopChain();
  const since = (visit) => model.buildOverview(bodies, { refMs: GEN_MS, visit }).since;
  // Visited 3h ago: the six finished deliveries / runs of the last 3h and the two failures; run_old (a 9-day-old
  // delivery the list keeps because it is still waiting) and run_m1 (5h ago) are not in the window.
  assert.deepEqual(since(visitAgo(3 * HOUR)), { kind: "visit", truncated: false, agoMs: 3 * HOUR, lowerBound: false, finished: 6, failed: 2, stopped: 0 });
  // First visit: the last 24h (run_m1 joins; run_old still does not).
  assert.deepEqual(since(visitFirst()), { kind: "first", truncated: false, agoMs: null, lowerBound: false, finished: 7, failed: 2, stopped: 0 });
  // Visited 3 days ago: counting starts 24h ago, not 3 days ago — the 9-day-old delivery is out, and the
  // text says only the last 24h are counted.
  const old = since(visitAgo(3 * DAY));
  assert.equal(old.truncated, true);
  assert.equal(old.agoMs, 3 * DAY);
  assert.deepEqual([old.finished, old.failed], [7, 2]);
  // A delivery that finished two days ago and is still waiting, with a visit three days ago: not counted.
  const waiting = await chain(snapshotOf({ runs: [snapRun("run_two", { deliveryRequested: true, terminalAt: ago(2 * DAY), delivery: snapDelivery({ settledAt: ago(2 * DAY) }) })] }));
  assert.equal(waiting.workers.workers.length, 1, "the list keeps it (an unresolved delivery)");
  assert.deepEqual(model.buildOverview(waiting, { refMs: GEN_MS, visit: visitAgo(3 * DAY) }).since.finished, 0);
  // Exactly at a finish time counts; failed / timed out / stopped are kept apart (hand-made rows: the states).
  const rows = (states) => ({
    overview: { status: "ready", generatedAt: GEN, counts: {}, projects: [], lanes: [] },
    workers: { status: "ready", generatedAt: GEN, truncated: false, workers: states.map(([state, agoMs], i) => ({ runId: `run_${i}`, state, terminalAt: ago(agoMs) })) },
  });
  const states = [["completed", 10 * MIN], ["completed", 2 * HOUR], ["failed", HOUR], ["timed_out", 30 * MIN], ["aborted", 20 * MIN], ["running", 0]];
  assert.deepEqual(model.buildOverview(rows(states), { refMs: GEN_MS, visit: visitAgo(2 * HOUR) }).since, { kind: "visit", truncated: false, agoMs: 2 * HOUR, lowerBound: false, finished: 2, failed: 2, stopped: 1 });
});

test("P24b the 24h counting window moves with every publication (real chain): a delivery kept in the list slides out of the count as the hours pass, while the visit stays the one read at load", async () => {
  // A delivery that finished 23h50m before the first publication and is still waiting for a decision: the list keeps it.
  const kept = (terminalAgo) => snapRun("run_kept", { title: "Kept delivery", deliveryRequested: true, terminalAt: ago(terminalAgo), delivery: snapDelivery({ settledAt: ago(terminalAgo) }) });
  const snap = snapshotOf({ runs: [kept(23 * HOUR + 50 * MIN)] });
  const at = (offsetMs, visit) => model.buildOverview(chainBodies.get(offsetMs), { refMs: GEN_MS + offsetMs, visit }).since;
  const chainBodies = new Map();
  for (const offset of [0, 5 * MIN, 9 * MIN + 59_000, 10 * MIN, HOUR, 90 * MIN]) chainBodies.set(offset, await chain(snap, GEN_MS + offset));
  const load = visitFirst();                                       // read once, when the page opened (at GEN)
  assert.equal(chainBodies.get(HOUR).workers.workers.length, 1, "the list still keeps it an hour later");
  assert.equal(at(0, load).finished, 1, "when the page opened it was inside the window");
  assert.equal(at(5 * MIN, load).finished, 1);
  assert.equal(at(9 * MIN + 59_000, load).finished, 1, "10 seconds before it turns 24h old");
  assert.equal(at(10 * MIN, load).finished, 1, "exactly 24h old is still counted");
  assert.equal(at(HOUR, load).finished, 0, "an hour on, it is 24h50m old: not counted any more (it used to stay forever)");
  assert.equal(at(HOUR, load).kind, "first");
  assert.equal(at(HOUR, load).truncated, false, "a first visit has no 'visit ago' text to qualify");
  // A real earlier visit, 23h before the page opened: fine at load, then the window (24h) cuts into it.
  const visit = visitAgo(23 * HOUR);
  assert.deepEqual([at(0, visit).truncated, at(0, visit).agoMs], [false, 23 * HOUR]);
  assert.equal(model.buildOverview(chainBodies.get(HOUR), { refMs: GEN_MS + HOUR, visit }).since.truncated, false, "an hour on the visit is exactly 24h old: still inside the window");
  const old = model.buildOverview(chainBodies.get(90 * MIN), { refMs: GEN_MS + 90 * MIN, visit }).since;
  assert.equal(old.truncated, true, "90 minutes on the visit is 24h30m old: only the last 24h are counted, and the text says so");
  assert.equal(old.agoMs, 24.5 * HOUR, "the ago text follows the snapshot, not the load time");
  assert.equal(old.finished, 0);
  // A visit read at load stays the cut-off: a late publication never moves it, the count lower bound is max(visit, publication - 24h).
  const recent = visitAgo(2 * HOUR);
  const finishedBefore = await chain(snapshotOf({ runs: [kept(3 * HOUR)] }), GEN_MS + 3 * HOUR);
  assert.equal(model.buildOverview(finishedBefore, { refMs: GEN_MS + 3 * HOUR, visit: recent }).since.finished, 0, "finished before the visit: not 'since your last visit'");
  assert.equal(model.buildOverview(await chain(snapshotOf({ runs: [kept(90 * MIN)] })), { refMs: GEN_MS, visit: recent }).since.finished, 1, "…but finished after it: counted");
});
test("P25 Overview: a capped Workers list makes the counts a lower bound; an idle project does not claim 'no run'", async () => {
  const bodies = await shopChain();
  const capped = { ...bodies, workers: { ...bodies.workers, truncated: true } };
  const vm = model.buildOverview(capped, { refMs: GEN_MS, visit: visitAgo(3 * HOUR) });
  assert.equal(vm.truncated, true);
  assert.equal(vm.since.lowerBound, true);
  assert.equal(model.buildOverview(bodies, { refMs: GEN_MS, visit: visitAgo(3 * HOUR) }).since.lowerBound, false);
  // A project the server counts as running but whose rows were cut away.
  const none = model.buildOverview({ overview: bodies.overview, workers: { ...bodies.workers, workers: [], truncated: true } }, { refMs: GEN_MS, visit: visitFirst() });
  const shop = none.blocks.find((b) => b.slug === "shop-api");
  assert.equal(shop.runningCount, 6);
  assert.deepEqual(shop.typeRows, [], "counted by the server, rows not returned: the view says '6 running'");
  assert.equal(none.blocks.find((b) => b.slug === "mobile-app").lastFinishedAgoMs, null);
});

test("P26 Overview (edge input): names fall back to the slug; rows without a project slug are left out", () => {
  const vm = model.buildOverview({
    overview: { status: "ready", generatedAt: GEN, counts: { running: 1 }, projects: [{ slug: "slug-only", name: null, counts: { running: 1 } }, { slug: 5 }], lanes: [] },
    workers: { status: "ready", generatedAt: GEN, truncated: false, workers: [{ runId: "run_x", project: { slug: "slug-only" }, state: "running" }, { runId: "run_y", project: null, state: "running" }] },
  }, { refMs: GEN_MS, visit: visitFirst() });
  assert.equal(vm.blocks.length, 1);
  assert.equal(vm.blocks[0].name, "slug-only");
  assert.equal(vm.blocks[0].typeRows[0].count, 1);
});

// ----- Attention -----

const ids = (list) => list.map((i) => i.id);
const attentionOf = (bodies, project = null, names = new Map([["shop-api", "shop-api"]])) =>
  model.buildAttention({ attention: bodies.attention, workers: bodies.workers, projectNames: names }, { refMs: GEN_MS, project });
const itemById = (vm, id) => [...vm.decide.items, ...vm.decide.legacy, ...vm.anomalies.items, ...vm.anomalies.legacy, ...vm.resolved].find((i) => i.id === id);

/** A split review with `seatCount` seats (all gave a verdict, one FIX_FIRST) on its own reviewed run. */
function splitReview(prefix, seatCount, over = {}) {
  const seats = Array.from({ length: seatCount }, (_, i) => snapSeat(`run_${prefix}${i + 1}`, i === 0 ? "FIX_FIRST" : "PASS"));
  return {
    runs: [
      snapRun(`run_${prefix}rev`, { title: `Reviewed ${prefix}`, deliveryRequested: true, delivery: snapDelivery() }),
      ...seats.map((seat, i) => snapRun(seat.runId, { title: `Seat ${i + 1}`, terminalAt: ago((10 + i) * MIN), terminalSeq: 10 + i, deliveryRequested: false })),
    ],
    consult: snapConsult({ consultId: `consult_${prefix}`, reviewedRunId: `run_${prefix}rev`, seats, ...over }),
  };
}

test("P27 Needs you order (real chain): involved workers first, then longest lasting, then id — a 3-seat split goes before an item involving 2 runs", async () => {
  const split = splitReview("x", 3, { createdAt: ago(5 * MIN) });       // reviewed run + 3 seats = 4 workers, the NEWEST item
  const waiting = (id, since) => snapRun(`run_${id}`, { title: `Waiting ${id}`, deliveryRequested: true, delivery: snapDelivery({ settledAt: ago(since) }) });
  // Two runs involved: a quota item observed by two failed runs on one lane.
  const quota = (runId, at) => snapRun(runId, { laneId: "kimi", agentId: "kimi", state: "failed", terminalAt: ago(at), failure: { category: "provider_capacity", code: "quota_exhausted" }, capacity: { code: "quota_exhausted", observedAt: ago(at) } });
  const snap = snapshotOf({
    runs: [...split.runs, waiting("a", 3 * HOUR), waiting("b", 5 * HOUR), waiting("c", 5 * HOUR), quota("run_q1", HOUR), quota("run_q2", 2 * HOUR)],
    consults: [split.consult],
  });
  const vm = attentionOf(await chain(snap));
  const involved = Object.fromEntries(vm.decide.items.map((i) => [i.id, i.involved]));
  assert.equal(involved["consult_split:shop-api:consult_x"], 4, "the reviewed run plus its three seats");
  assert.equal(involved["capacity:kimi"], 2);
  // 4 > 2 > 1; among the one-worker items the longest waiting first, ties by id.
  assert.deepEqual(ids(vm.decide.items), [
    "consult_split:shop-api:consult_x", "capacity:kimi", "awaiting_decision:run_b", "awaiting_decision:run_c", "awaiting_decision:run_a",
  ]);
  assert.equal(vm.decide.total, 5);
});

test("P28 Alerts order (real chain): no follow-up running first, then severity (quota first), then longest lasting", async () => {
  const failed = (id, at, over = {}) => snapRun(`run_${id}`, { state: "failed", terminalAt: ago(at), failure: { category: "provider_error", code: "backend_error" }, ...over });
  const snap = snapshotOf({ runs: [
    failed("a", 3 * HOUR, { lineageRootRunId: "run_a" }),
    snapLive("run_a2", { lineageRootRunId: "run_a", startedAt: ago(2 * HOUR) }),                       // a follow-up RUNNING after run_a failed
    failed("d", 20 * MIN),
    snapLive("run_c", { liveness: "silent", quietSince: ago(40 * MIN) }),
    snapLive("run_f", { liveness: "silent", quietSince: ago(90 * MIN) }),
    snapLive("run_e", { liveness: "process_only", quietSince: ago(HOUR) }),
    snapRun("run_b", { laneId: "opus", agentId: "opus", state: "failed", terminalAt: ago(2 * HOUR), failure: { category: "provider_capacity", code: "rate_limited" }, capacity: { code: "rate_limited", observedAt: ago(2 * HOUR) } }),
    snapRun("run_q", { laneId: "kimi", agentId: "kimi", state: "failed", terminalAt: ago(30 * MIN), failure: { category: "provider_capacity", code: "quota_exhausted" }, capacity: { code: "quota_exhausted", observedAt: ago(30 * MIN) } }),
  ] });
  const vm = attentionOf(await chain(snap));
  const order = ids(vm.anomalies.items);
  const confirmed = order.indexOf("failed:run_a");
  assert.equal(confirmed, order.length - 1, "the failure whose follow-up is confirmed running sorts last");
  assert.equal(itemById(vm, "failed:run_a").followUp, "exists");
  assert.deepEqual(itemById(vm, "failed:run_a").followUpRuns, [{ runId: "run_a2", state: "running" }]);
  assert.equal(itemById(vm, "failed:run_a").followUpRunning, true);
  assert.equal(itemById(vm, "failed:run_d").followUp, "none", "a complete census and no linked run: there is none");
  assert.equal(itemById(vm, "failed:run_d").followUpRunning, false);
  // Among the rest: severity quota_exhausted › failed › silent › process_only › rate_limited; within one kind longest first.
  const rest = order.slice(0, -1).map((id) => id.split(":")[0]);
  const rank = ["capacity_alert", "failed", "silent", "process_only", "rate_limited"];
  assert.deepEqual([...rest].sort((a, b) => rank.indexOf(a) - rank.indexOf(b)), rest, `severity order: ${rest.join(" > ")}`);
  assert.ok(order.indexOf("silent:run_f") < order.indexOf("silent:run_c"), "the longer silent one first");
  assert.deepEqual(model.ALERT_SEVERITY, ["quota_exhausted", "failed", "silent", "process_only", "rate_limited"]);
});

test("P29 older than 7 days (real chain): ONE group per section; exactly 7 days and an unknown age stay in the list", async () => {
  assert.equal(model.LEGACY_AFTER_MS, 7 * DAY);
  const waiting = (id, since) => snapRun(`run_${id}`, { title: id, deliveryRequested: true, delivery: snapDelivery({ settledAt: ago(since) }) });
  const snap = snapshotOf({ runs: [
    waiting("fresh", 3 * HOUR), waiting("edge", 7 * DAY), waiting("old1", 7 * DAY + MIN), waiting("old2", 30 * DAY),
    snapLive("run_zombie", { liveness: "silent", quietSince: ago(15 * DAY) }),
    snapLive("run_recent", { liveness: "silent", quietSince: ago(40 * MIN) }),
  ] });
  const vm = attentionOf(await chain(snap));
  assert.deepEqual(ids(vm.decide.items).sort(), ["awaiting_decision:run_edge", "awaiting_decision:run_fresh"]);
  assert.deepEqual(ids(vm.decide.legacy), ["awaiting_decision:run_old2", "awaiting_decision:run_old1"], "listed when opened, longest first");
  assert.equal(vm.decide.legacy.length, 2, "the group shows its count");
  assert.equal(vm.decide.total, 4, "the section count still includes them (it matches the top bar)");
  assert.deepEqual(ids(vm.anomalies.items), ["silent:run_recent"]);
  assert.deepEqual(ids(vm.anomalies.legacy), ["silent:run_zombie"], "alerts fold the same way, in their own group");
  // An item whose time is unreadable (a hand-made body: the server always has one) is never "old".
  const odd = model.buildAttention({
    attention: { status: "ready", generatedAt: GEN, decide: [{ id: "x:1", kind: "awaiting_decision", state: "unknown", runIds: ["run_1"], projectSlugs: [], since: null, evidence: [] }], anomalies: [], resolved: [] },
    workers: { workers: [] },
  }, { refMs: GEN_MS, project: null });
  assert.deepEqual(odd.decide.items.map((i) => i.id), ["x:1"]);
  assert.equal(odd.decide.items[0].durationMs, null);
});

test("P30 project filter and names (real chain): the filter narrows the lists by slug; people read the NAME; counts stay with the Overview", async () => {
  const slug = "carloha-8629bc9a";
  const proj = (s, name) => ({ slug: s, name });
  const wait = (id, project) => snapRun(`run_${id}`, { project, deliveryRequested: true, delivery: snapDelivery({ settledAt: ago(3 * HOUR) }) });
  const split = splitReview("s", 2, { projectSlug: slug, reviewedRunId: "run_srev" });
  const snap = snapshotOf({
    projects: [snapProject(slug, "Carloha Agent"), snapProject("docs-site", "docs-site")],
    runs: [
      ...split.runs.map((run) => ({ ...run, project: proj(slug, "Carloha Agent") })),
      wait("a", proj(slug, "Carloha Agent")), wait("c", proj("docs-site", "docs-site")),
    ],
    consults: [split.consult],
  });
  const bodies = await chain(snap);
  const names = new Map(bodies.overview.projects.map((p) => [p.slug, p.name]));
  assert.deepEqual([...names], [["carloha-8629bc9a", "Carloha Agent"], ["docs-site", "docs-site"]]);
  const all = attentionOf(bodies, null, names);
  const filtered = attentionOf(bodies, slug, names);
  assert.deepEqual(ids(all.decide.items).sort(), ["awaiting_decision:run_a", "awaiting_decision:run_c", "consult_split:carloha-8629bc9a:consult_s"]);
  assert.deepEqual(ids(filtered.decide.items).sort(), ["awaiting_decision:run_a", "consult_split:carloha-8629bc9a:consult_s"]);
  // Display carries the NAME, the slug stays the key.
  assert.deepEqual(itemById(filtered, "awaiting_decision:run_a").projects, [{ slug, name: "Carloha Agent" }]);
  // A name the Overview does not give falls back to the slug.
  assert.deepEqual(itemById(attentionOf(bodies, null, new Map()), "awaiting_decision:run_a").projects, [{ slug, name: slug }]);
  // The page body says which project it is filtered to, by name.
  const net = netOf(bodies);
  const main = model.buildMain({ net, page: "attention", project: slug, visit: visitFirst(), nowMs: GEN_MS });
  assert.equal(main.project, slug);
  assert.equal(main.projectName, "Carloha Agent");
  // The Workers page asks the server for the project's rows: its data is keyed by that very request.
  const slugNet = netOf(bodies, ["workers"], model.INITIAL_NET, GEN_MS, slug);
  assert.equal(model.buildMain({ net: slugNet, page: "workers", project: slug, visit: visitFirst(), nowMs: GEN_MS }).projectName, "Carloha Agent");
  const unknownNet = netOf(bodies, ["workers"], model.INITIAL_NET, GEN_MS, "unknown-slug");
  assert.equal(model.buildMain({ net: unknownNet, page: "workers", project: "unknown-slug", visit: visitFirst(), nowMs: GEN_MS }).projectName, "unknown-slug");
  assert.deepEqual(model.buildMain({ net, page: "workers", project: slug, visit: visitFirst(), nowMs: GEN_MS }), { page: "message", kind: "loading" }, "rows fetched for no project are not this project's rows");
  // The top bar reads the Overview only: its counts are the directory-wide numbers whatever the list shows.
  const top = model.buildTopbar(net, "attention", GEN_MS).counts;
  assert.deepEqual(top, { needsYou: all.decide.total, alerts: all.anomalies.total });
  assert.ok(filtered.decide.total < all.decide.total, "the page list is narrower than the bar count");
  assert.equal(model.buildTopbar.length, 3, "the top bar takes the state, the page and the clock — no filter");
});

test("P31 involved workers (real chain): a split review involves the reviewed run + ALL its seats; the title stays the reviewed run's", async () => {
  const split = splitReview("v", 3);
  // A fourth seat that has not concluded (no verdict, still running): involved too, though not in the evidence.
  const seats = [...split.consult.seats, snapSeat("run_v4", null)];
  const snap = snapshotOf({ runs: [...split.runs, snapLive("run_v4", { title: "Seat four" })], consults: [{ ...split.consult, seats }] });
  const bodies = await chain(snap);
  const raw = bodies.attention.decide.find((i) => i.kind === "consult_split");
  assert.deepEqual(raw.runIds, ["run_vrev"], "the wire keeps runIds as the runs the item hangs on");
  assert.equal(raw.seatRunIds.length, 4);
  const item = itemById(attentionOf(bodies), "consult_split:shop-api:consult_v");
  assert.equal(item.involved, 5);
  assert.deepEqual(item.workers.map((w) => w.runId), ["run_vrev", "run_v1", "run_v2", "run_v3", "run_v4"], "reviewed run first, then seats in order");
  assert.equal(item.moreWorkers, 0);
  assert.equal(item.headline, "Reviewed v", "the title is the reviewed run's");
  assert.deepEqual(item.workers[0], { runId: "run_vrev", title: "Reviewed v", lane: "glm-pro" });
  // More than the list cap: the rest is a count.
  const big = splitReview("w", 7);
  const bigItem = itemById(attentionOf(await chain(snapshotOf({ runs: big.runs, consults: [big.consult] }))), "consult_split:shop-api:consult_w");
  assert.equal(bigItem.involved, 8);
  assert.equal(bigItem.workers.length, model.WORKER_LIST_MAX);
  assert.equal(bigItem.moreWorkers, 3);
  // A lane item is headed by its lane; a worker the list does not carry shows its run number only (hand-made).
  const lane = itemById(attentionOf(await shopChain()), "rate_limited:kimi");
  assert.equal(lane.headline, "kimi");
  const gone = model.buildAttention({
    attention: { status: "ready", generatedAt: GEN, decide: [{ id: "g", kind: "awaiting_decision", state: "open", runIds: ["run_not_listed"], projectSlugs: ["shop-api"], since: ago(HOUR), evidence: [] }], anomalies: [], resolved: [] },
    workers: { workers: [] },
  }, { refMs: GEN_MS, project: null });
  assert.equal(gone.decide.items[0].headline, null);
  assert.deepEqual(gone.decide.items[0].workers, [{ runId: "run_not_listed", title: null, lane: null }]);
});

test("P32 references (real chain): 'item id [event codes]' with the REAL event numbers; without one the bare run number; same string in both languages", async () => {
  assert.equal(model.evidenceCode({ runId: "run_a", seq: 138 }), "run_a#0138");
  assert.equal(model.evidenceCode({ runId: "run_a", seq: 12345 }), "run_a#12345");
  for (const seq of [null, undefined, 0, -1, 1.5, "7", NaN]) assert.equal(model.evidenceCode({ runId: "run_a", seq }), "run_a", `seq ${String(seq)} is not an event number`);
  assert.equal(model.evidenceCode({ runId: "", seq: 1 }), null);
  assert.equal(model.evidenceCode(null), null);
  const vm = attentionOf(await shopChain());
  // Silent: the event quietSince was taken from; failed: the failing terminal event; verification: the settled event;
  // the split review: its seats' terminal events; rate limited: the observed run.error.
  assert.equal(itemById(vm, "silent:run_r1").ref, "silent:run_r1 [run_r1#0138]");
  assert.equal(itemById(vm, "failed:run_f3").ref, "failed:run_f3 [run_f3#0090]");
  assert.equal(itemById(vm, "verification_failed:run_pay").ref, "verification_failed:run_pay [run_pay#0052]");
  assert.equal(itemById(vm, "consult_split:shop-api:consult_order").ref, "consult_split:shop-api:consult_order [run_s1#0012 run_s2#0014]");
  assert.equal(itemById(vm, "rate_limited:kimi").ref, "rate_limited:kimi [run_rl#0033]");
  assert.equal(itemById(vm, "awaiting_decision:run_old").ref, "awaiting_decision:run_old [run_old#0007]");
  // An item whose evidence has no event number (a run row without one): the bare run, flagged on screen.
  const bare = await chain(snapshotOf({ runs: [snapRun("run_nb", { state: "failed", terminalAt: ago(HOUR), failure: { category: "provider_error", code: "backend_error" } })] }));
  const bareItem = itemById(attentionOf(bare), "failed:run_nb");
  assert.equal(bareItem.ref, "failed:run_nb [run_nb]");
  assert.deepEqual(bareItem.evidence, [{ code: "run_nb", atMs: GEN_MS - HOUR, hasSeq: false }]);
  assert.equal(model.refOf({ id: "y" }), "y");
  assert.equal(model.refOf.length, 1, "no language parameter: both languages copy the identical string");
  // Duplicates collapse.
  assert.equal(model.refOf({ id: "z", evidence: [{ runId: "run_a", seq: 3 }, { runId: "run_a", seq: 3 }, { runId: "run_b", seq: null }] }), "z [run_a#0003 run_b]");
});

test("P33 evidence rows (real chain): time, event number, failure reason and follow-up come through", async () => {
  const vm = attentionOf(await shopChain());
  const failed = itemById(vm, "failed:run_f3");
  assert.deepEqual(failed.evidence, [{ code: "run_f3#0090", atMs: GEN_MS - 30 * MIN, hasSeq: true }]);
  assert.deepEqual(failed.failure, { category: "provider_error", code: "backend_error" });
  assert.equal(failed.followUp, "none");
  assert.deepEqual(failed.followUpRuns, []);
  assert.deepEqual(itemById(vm, "silent:run_r1").evidence, [{ code: "run_r1#0138", atMs: GEN_MS - 40 * MIN, hasSeq: true }]);
});

test("P34 resolved (real chain): the resolution and how long ago come through; the quota mirror is listed once", async () => {
  // run_ok finishes on the lane after the quota observation: both quota items resolve, one row in Resolved.
  const quota = snapRun("run_q", { laneId: "kimi", agentId: "kimi", state: "failed", terminalAt: ago(2 * HOUR), failure: { category: "provider_capacity", code: "quota_exhausted" }, capacity: { code: "quota_exhausted", observedAt: ago(2 * HOUR) } });
  const ok = snapRun("run_ok", { laneId: "kimi", agentId: "kimi", terminalAt: ago(30 * MIN), terminalSeq: 77 });
  const vm = attentionOf(await chain(snapshotOf({ runs: [quota, ok] })));
  assert.deepEqual(vm.resolved.map((i) => [i.id, i.resolution, i.resolvedAgoMs]), [["capacity:kimi", "later_success", 30 * MIN]]);
  assert.equal(vm.resolved[0].ref, "capacity:kimi [run_q run_ok#0077]", "the solving run's own event number is in the reference");
  assert.deepEqual(ids(vm.anomalies.items), ["failed:run_q"]);
  // A resolution with no time (hand-made): ago is unknown, order falls back to the id.
  const odd = model.buildAttention({
    attention: { status: "ready", generatedAt: GEN, decide: [], anomalies: [], resolved: [{ id: "r2", kind: "failed", state: "resolved", runIds: [], projectSlugs: [], since: null, resolvedAt: null, resolution: "superseded", evidence: [] }] },
    workers: { workers: [] },
  }, { refMs: GEN_MS, project: null });
  assert.deepEqual(odd.resolved.map((i) => [i.resolution, i.resolvedAgoMs]), [["superseded", null]]);
});

test("P39 delivery version (real chain): delivery items carry the SHORT commit; unknown is null; other kinds have none", async () => {
  const vm = attentionOf(await shopChain());
  assert.equal(model.COMMIT_SHORT_LENGTH, 8);
  assert.equal(itemById(vm, "verification_failed:run_pay").commit, "bbbbbbbb");
  assert.equal(itemById(vm, "consult_split:shop-api:consult_order").commit, "aaaaaaaa", "the reviewed run's commit");
  assert.equal(itemById(vm, "awaiting_decision:run_old").commit, "eeeeeeee");
  for (const id of ["silent:run_r1", "failed:run_f3", "rate_limited:kimi"]) assert.equal(itemById(vm, id).commit, undefined, `${id}: not a delivery item`);
  // The commit the transcript could not bind uniquely: unknown (null), not blank and not a guess.
  const unknown = await chain(snapshotOf({ runs: [snapRun("run_nc", { deliveryRequested: true, delivery: snapDelivery({
    settlement: { status: "undeterminable", reason: "delivery_facts_malformed" }, commit: null, verification: null, acceptance: { status: null, decidedAt: null }, settledAt: null, ambiguous: true,
  }) })] }));
  assert.equal(itemById(attentionOf(unknown), "delivery_ambiguous:run_nc").commit, null);
  // Not a commit shape (hand-made): unknown rather than shown.
  const odd = model.buildAttention({
    attention: { status: "ready", generatedAt: GEN, decide: [{ id: "x", kind: "awaiting_decision", state: "open", runIds: [], projectSlugs: [], since: ago(HOUR), commit: "not a commit", evidence: [] }], anomalies: [], resolved: [] },
    workers: { workers: [] },
  }, { refMs: GEN_MS, project: null });
  assert.equal(odd.decide.items[0].commit, null);
});

test("P40 quota exhausted counts in BOTH places, the same everywhere (real chain): top bar, project marker, both sections", async () => {
  const quota = (runId, laneId, at) => snapRun(runId, { laneId, agentId: laneId, state: "failed", terminalAt: ago(at), failure: { category: "provider_capacity", code: "quota_exhausted" }, capacity: { code: "quota_exhausted", observedAt: ago(at) } });
  const limited = snapRun("run_rl", { laneId: "opus", agentId: "opus", state: "failed", terminalAt: ago(HOUR), failure: { category: "provider_capacity", code: "rate_limited" }, capacity: { code: "rate_limited", observedAt: ago(HOUR) } });
  const check = async (runs, expected) => {
    const bodies = await chain(snapshotOf({ runs }));
    const net = netOf(bodies);
    const vm = attentionOf(bodies);
    const top = model.buildTopbar(net, "attention", GEN_MS).counts;
    const block = model.buildOverview(bodies, { refMs: GEN_MS, visit: visitFirst() }).blocks[0];
    // One number everywhere: bar = project marker = the rows of the section.
    assert.deepEqual([top.needsYou, block.decide, vm.decide.total], [expected.needsYou, expected.needsYou, expected.needsYou]);
    assert.deepEqual([top.alerts, block.anomalies, vm.anomalies.total], [expected.alerts, expected.alerts, expected.alerts]);
    return vm;
  };
  // Only quota exhausted: Needs you 1; Alerts = the failed run + the quota mirror.
  const onlyQuota = await check([quota("run_q", "kimi", HOUR)], { needsYou: 1, alerts: 2 });
  assert.deepEqual(onlyQuota.anomalies.items.map((i) => i.id).sort(), ["capacity_alert:kimi", "failed:run_q"]);
  assert.equal(itemById(onlyQuota, "capacity_alert:kimi").kind, "quota_exhausted");
  assert.notEqual(ids(onlyQuota.decide.items)[0], "capacity_alert:kimi");
  // Quota exhausted AND throttled: Needs you counts the quota only; Alerts adds the throttling.
  const both = await check([quota("run_q", "kimi", HOUR), limited], { needsYou: 1, alerts: 4 });
  assert.deepEqual(both.anomalies.items.map((i) => i.id).filter((id) => !id.startsWith("failed:")).sort(), ["capacity_alert:kimi", "rate_limited:opus"]);
  // The Overview lane row names both lanes (once each).
  const lanes = model.buildOverview(await chain(snapshotOf({ runs: [quota("run_q", "kimi", HOUR), limited] })), { refMs: GEN_MS, visit: visitFirst() }).lanes;
  assert.deepEqual(lanes.throttled.map((l) => [l.laneKey, l.quota]), [["kimi", true], ["opus", false]]);
  // The two rows have different ids: selecting one does not select the other.
  assert.notEqual(itemById(both, "capacity:kimi").id, itemById(both, "capacity_alert:kimi").id);
});

test("P35 buildMain: a page without its own retained data is a message (the problem, else loading)", async () => {
  const bodies = await shopChain();
  assert.deepEqual(mainOf(model.INITIAL_NET, "overview"), { page: "message", kind: "loading" });
  assert.deepEqual(mainOf({ ...model.INITIAL_NET, problem: "network" }, "overview"), { page: "message", kind: "network" });
  assert.deepEqual(mainOf({ ...model.INITIAL_NET, problem: "noToken" }, "overview"), { page: "message", kind: "noToken" });
  // After the Overview's own cycle: Workers (rows + items) has not been polled yet, so it has no data of its own.
  const net = netOf(bodies, ["overview"]);
  assert.equal(mainOf(net, "overview").page, "overview");
  assert.deepEqual(mainOf(net, "workers"), { page: "message", kind: "loading" });
  assert.deepEqual(mainOf(net, "attention"), { page: "message", kind: "loading" });
  const all = netOf(bodies);
  assert.equal(mainOf(all, "workers").page, "workers");
  const filtered = netOf(bodies, ["workers"], model.INITIAL_NET, GEN_MS, "shop-api");
  const workers = mainOf(filtered, "workers", { project: "shop-api" });
  assert.deepEqual([workers.page, workers.project, workers.projectName], ["workers", "shop-api", "shop-api"]);
  assert.deepEqual(Object.keys(workers.bodies).sort(), ["attention", "overview", "workers"], "the page body carries the three bodies of its publication");
  assert.deepEqual(mainOf(all, "workers", { project: "shop-api" }), { page: "message", kind: "loading" }, "data fetched for another filter is not this filter's data");
  const stale = model.applyCycle(all, { page: "overview", paths: PAGE_PATHS.overview, results: [{ ok: false, reason: "network" }, { ok: false, reason: "network" }] }, GEN_MS + 5000);
  assert.equal(mainOf(stale, "overview").page, "overview", "stale data is still shown");
});

test("P41 landing on Attention: the fragment carries an optional section, only for Attention, and round-trips", () => {
  assert.deepEqual([...model.ATTENTION_SECTIONS], ["decide", "anomalies"]);
  assert.deepEqual(model.parseHash("#attention?section=decide"), { page: "attention", project: null, section: "decide" });
  assert.deepEqual(model.parseHash("#attention?project=shop-api&section=anomalies"), { page: "attention", project: "shop-api", section: "anomalies" });
  assert.deepEqual(model.parseHash("#attention?section=resolved"), { page: "attention", project: null, section: null }, "only the two sections");
  assert.deepEqual(model.parseHash("#workers?section=decide"), { page: "workers", project: null, section: null }, "Attention only");
  assert.deepEqual(model.parseHash("#overview?section=decide"), { page: "overview", project: null, section: null });
  assert.deepEqual(model.parseHash("#attention?section=decide&section=anomalies"), { page: "attention", project: null, section: "decide" });
  assert.equal(model.formatHash("attention", "shop-api", "decide"), "#attention?project=shop-api&section=decide");
  assert.equal(model.formatHash("attention", null, "anomalies"), "#attention?section=anomalies");
  assert.equal(model.formatHash("attention", "shop-api"), "#attention?project=shop-api");
  assert.equal(model.formatHash("workers", "shop-api", "decide"), "#workers?project=shop-api", "a section is Attention-only");
  assert.equal(model.formatHash("attention", null, "bogus"), "#attention");
  for (const [page, project, section] of [["attention", "shop-api", "decide"], ["attention", null, "anomalies"], ["workers", "docs-site", null], ["overview", null, null]]) {
    const hash = model.formatHash(page, project, section);
    const parsed = model.parseHash(hash);
    assert.equal(model.formatHash(parsed.page, parsed.project, parsed.section), hash, hash);
  }
});

// =====================================================================
// V) VIEWS — against a tiny in-memory DOM
// =====================================================================

class FakeText {
  constructor(text) { this.nodeType = 3; this.textContent = text; this.parent = null; }
  get parentNode() { return this.parent; }
}

class FakeNode {
  constructor(tag) {
    this.tag = tag; this.children = []; this.attrs = new Map(); this.listeners = new Map();
    this.parent = null; this.className = ""; this.ownText = null; this.nodeType = 1;
  }
  get parentNode() { return this.parent; }
  get textContent() {
    return this.ownText !== null ? this.ownText : this.children.map((c) => c.textContent).join("");
  }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  append(...nodes) {
    for (const node of nodes) {
      // The real DOM turns null / arrays into the text "null" / "[object …]": refuse them here.
      assert.ok(node instanceof FakeNode || node instanceof FakeText, `only nodes can be appended, got ${String(node)}`);
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    // Like a browser: removed nodes are detached, focus inside them falls back to nothing and a
    // selection anchored inside them is gone.
    if (fakeDocument.activeElement !== null && this.contains(fakeDocument.activeElement)) fakeDocument.activeElement = null;
    if (fakeSelection.ranges.length > 0 && this.contains(fakeSelection.anchorNode)) fakeSelection.ranges = [];
    for (const old of this.children) old.parent = null;
    this.children = [];
    this.ownText = null;
    this.append(...nodes);
  }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  removeAttribute(name) { this.attrs.delete(name); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  addEventListener(event, fn) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]); }
  click() { for (const fn of this.listeners.get("click") ?? []) fn({ type: "click" }); }
  contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false; }
  focus() { fakeDocument.activeElement = this; }
  walk(visit) { for (const child of this.children) { if (child instanceof FakeNode) { visit(child); child.walk(visit); } } }
  querySelectorAll(selector) {
    const attr = /^\[([a-z-]+)\]$/.exec(selector)?.[1];
    assert.ok(attr, `fake DOM supports only [attr] selectors, got ${selector}`);
    const out = [];
    this.walk((node) => { if (node.attrs.has(attr)) out.push(node); });
    return out;
  }
}

const fakeDocument = {
  activeElement: null,
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => new FakeText(text),
  createRange: () => ({ selectNodeContents(node) { this.node = node; } }),
};
/** One window selection: a list of ranges, each anchored on the node that was selected. */
const fakeSelection = {
  ranges: [],
  get rangeCount() { return this.ranges.length; },
  get isCollapsed() { return this.ranges.length === 0; },
  get anchorNode() { return this.ranges[0]?.node ?? null; },
  removeAllRanges() { this.ranges = []; },
  addRange(range) { this.ranges.push(range); },
};
const fakeWindow = { getSelection: () => fakeSelection };
globalThis.document = fakeDocument;
globalThis.window = fakeWindow;
after(() => { delete globalThis.document; delete globalThis.window; });

const { renderTopbar, renderMain, selectRefText, focusSection } = await import("../../src/owner-dashboard/v2/views.js");
const { renderWorkersPage } = await import("../../src/owner-dashboard/v2/workersview.js");

const find = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const byClass = (root, cls) => find(root, (n) => n.className.split(" ").includes(cls));
const byTag = (root, tag) => find(root, (n) => n.tag === tag);
const withText = (root, text) => find(root, (n) => n.textContent === text);
const region = () => { const node = new FakeNode("div"); fakeDocument.activeElement = null; fakeSelection.ranges = []; return node; };
const noopActions = () => {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); };
  return {
    calls,
    navigate: rec("navigate"), clearFilter: rec("clearFilter"), setLang: rec("setLang"), select: rec("select"),
    toggleLegacy: rec("toggleLegacy"), toggleResolved: rec("toggleResolved"), copyRef: rec("copyRef"),
    openWorker: rec("openWorker"), setFilter: rec("setFilter"), setQuery: rec("setQuery"), toggleStarting: rec("toggleStarting"),
    closeWorker: rec("closeWorker"), setTab: rec("setTab"), toggleFiles: rec("toggleFiles"), toggleImage: rec("toggleImage"), copyWorkerRef: rec("copyWorkerRef"),
  };
};
const UI0 = () => ({ selected: null, legacyOpen: { decide: false, anomalies: false }, resolvedOpen: false, copy: null, startingOpen: false });
/** The Workers page vm of a net: buildMain's body plus the view state (filters live in the fragment). */
const workersVmOf = (net, view = workers.emptyView()) => workers.workersPage(mainOf(net, "workers", { project: view.project }), view);

let shopBodiesOnce = null;
const getShop = () => (shopBodiesOnce ??= shopChain());
async function overviewVm(visit = visitAgo(3 * HOUR)) {
  return mainOf(netOf(await getShop()), "overview", { visit });
}
async function attentionVm(project = null) {
  return mainOf(netOf(await getShop()), "attention", { project });
}
const topbarOf = (net, page = "overview", nowMs = GEN_MS) => model.buildTopbar(net, page, nowMs);

test("V1 top bar: WAO, three real nav buttons, counts with symbols, freshness, EN | 中 last; a count lands on its own section", async () => {
  const net = netOf(await getShop());
  const root = region();
  const actions = noopActions();
  renderTopbar(root, topbarOf(net, "attention"), "en", actions);
  assert.deepEqual(withText(root, "WAO").map((n) => n.className), ["brand"]);
  const nav = byTag(root, "nav")[0];
  const buttons = byTag(nav, "button");
  assert.deepEqual(buttons.map((b) => b.textContent), ["Overview", "Workers", "Attention"]);
  for (const b of buttons) assert.equal(b.getAttribute("type"), "button", "a real button, keyboard reachable");
  assert.deepEqual(buttons.map((b) => b.getAttribute("aria-current")), [null, null, "page"]);
  buttons[1].click();
  assert.deepEqual(actions.calls.pop(), ["navigate", "workers", null]);
  // Counts: red circle + words + number; amber triangle + words + number (the real counts: 3 and 4).
  const needs = byClass(root, "badge-needsYou")[0];
  const alerts = byClass(root, "badge-alerts")[0];
  assert.equal(needs.textContent, "●Needs you3");
  assert.equal(alerts.textContent, "▲Alerts4");
  assert.ok(needs.className.split(" ").includes("badge-red"));
  assert.ok(alerts.className.split(" ").includes("badge-amber"));
  assert.equal(byClass(needs, "sym")[0].getAttribute("aria-hidden"), "true");
  needs.click();
  assert.deepEqual(actions.calls.pop(), ["navigate", "attention", null, "decide"], "Needs you lands on the red section");
  alerts.click();
  assert.deepEqual(actions.calls.pop(), ["navigate", "attention", null, "anomalies"], "Alerts lands on the amber section");
  // Freshness and language, language switch last.
  assert.equal(byClass(root, "fresh")[0].textContent, "Polling 5s");
  assert.equal(byClass(root, "fresh")[0].getAttribute("role"), "status");
  const side = byClass(root, "topbar-side")[0];
  const lastGroup = side.children[side.children.length - 1];
  assert.equal(lastGroup.getAttribute("aria-label"), "Language");
  assert.deepEqual(byTag(lastGroup, "button").map((b) => [b.textContent, b.getAttribute("aria-pressed")]), [["EN", "true"], ["中", "false"]]);
  byTag(lastGroup, "button")[1].click();
  assert.deepEqual(actions.calls.pop(), ["setLang", "zh"]);
});

test("V2 top bar: zero turns label AND number gray (symbol stays); no data reads as dashes", async () => {
  const empty = await chain(snapshotOf({ runs: [snapRun("run_calm")] }));
  const root = region();
  renderTopbar(root, topbarOf(netOf(empty)), "en", noopActions());
  for (const cls of ["badge-needsYou", "badge-alerts"]) {
    const badge = byClass(root, cls)[0];
    assert.ok(badge.className.split(" ").includes("badge-gray"), `${cls} is gray at zero`);
    assert.ok(!/badge-(red|amber)/.test(badge.className));
    assert.match(badge.textContent, /^[●▲]/, "the symbol is still there");
    assert.match(badge.textContent, /0$/);
  }
  const cold = region();
  renderTopbar(cold, topbarOf(model.INITIAL_NET), "en", noopActions());
  assert.equal(byClass(cold, "badge-needsYou")[0].textContent, "●Needs you—");
  assert.equal(byClass(cold, "fresh")[0].textContent, "Loading…");
});

test("V3 top bar freshness: Polling 5s / Stale since HH:MM / plain Stale / nothing for a missing token", () => {
  const text = (freshness, lang = "en") => {
    const root = region();
    renderTopbar(root, { page: "overview", counts: null, tones: { needsYou: "gray", alerts: "gray" }, freshness }, lang, noopActions());
    return byClass(root, "fresh")[0].textContent;
  };
  const at = new Date(2026, 10, 26, 10, 41).getTime();
  assert.equal(text({ kind: "polling", sinceMs: null }), "Polling 5s");
  assert.equal(text({ kind: "stale", sinceMs: at }), "Stale since 10:41");
  assert.equal(text({ kind: "stale", sinceMs: at }, "zh"), "过期自 10:41");
  assert.equal(text({ kind: "stale", sinceMs: null }), "Stale");
  assert.equal(text({ kind: "idle", sinceMs: null }), "");
  assert.equal(text({ kind: "polling", sinceMs: null }, "zh"), "轮询 5 秒");
});

test("V3b a snapshot that stops being renewed turns the label to Stale since the moment it crossed 30s (from the real state)", async () => {
  const net = netOf(await getShop(), ["overview"], model.INITIAL_NET, GEN_MS);
  const label = (nowMs) => {
    const root = region();
    renderTopbar(root, topbarOf(net, "overview", nowMs), "en", noopActions());
    return byClass(root, "fresh")[0].textContent;
  };
  assert.equal(label(GEN_MS + 5000), "Polling 5s");
  assert.equal(label(GEN_MS + 30_000), "Polling 5s");
  assert.equal(label(GEN_MS + 31_000), `Stale since ${i18n.formatClock(GEN_MS + 30_000)}`);
  assert.equal(label(GEN_MS + 10 * MIN), `Stale since ${i18n.formatClock(GEN_MS + 30_000)}`, "the first moment, however long it lasts");
});

test("V4 Overview (real chain): headline, since-line, project blocks, markers and rows as drawn text", async () => {
  const root = region();
  renderMain(root, await overviewVm(), "en", UI0(), noopActions());
  assert.equal(byClass(root, "headline")[0].textContent, "3 projects · 6 workers running · 3 starting");
  assert.equal(byClass(root, "since")[0].textContent, "Since your last visit (3h ago): 6 finished · 2 failed");
  assert.deepEqual(byClass(root, "project-name").map((n) => n.textContent), ["shop-api", "docs-site", "mobile-app"]);
  assert.deepEqual(byClass(root, "marker").map((n) => n.textContent), ["●3 need you", "▲4 alerts"]);
  assert.match(byClass(root, "idle-note")[0].textContent, /^idle · last run finished 5h ago$/);
  assert.deepEqual(byClass(root, "type-row").map((n) => byClass(n, "c-type")[0].textContent), ["Coding", "Research", "Delivery review", "Coding", "Image"]);
  const [code, research, review, , image] = byClass(root, "type-row");
  assert.equal(byClass(code, "c-count")[0].textContent, "3");
  assert.equal(byClass(code, "c-lanes")[0].textContent, "glm-pro, opus");
  assert.equal(byClass(code, "c-longest")[0].textContent, "longest 38m");
  assert.equal(byClass(code, "flag")[0].textContent, "▲run_r1silent 40m");
  assert.equal(byClass(research, "flag")[0].textContent, "1 starting", "Starting, not queued");
  assert.equal(byClass(review, "flag")[0].textContent, "2 of 3 seats in", "a review row says how many seats have arrived");
  assert.equal(byClass(image, "flag")[0].textContent, "2 starting");
  const lane = byClass(root, "lanes")[0];
  assert.equal(byClass(lane, "lanes-title")[0].textContent, "Lanes");
  assert.equal(byClass(lane, "lanes-use")[0].textContent, "6 in use");
  assert.match(byClass(lane, "flag")[0].textContent, /^▲kimi throttled, last seen \d\d:\d\d$/);
  assert.ok(!/queued/i.test(root.textContent), "never 'queued'");
});

test("V5 Overview: a project name opens Workers with its filter; the red marker lands on Needs you, the amber one on Alerts", async () => {
  const root = region();
  const actions = noopActions();
  renderMain(root, await overviewVm(), "en", UI0(), actions);
  const nameButtons = byTag(byClass(root, "project-name")[0], "button");
  assert.equal(nameButtons.length, 1, "the project name is a real button");
  assert.equal(nameButtons[0].getAttribute("type"), "button");
  nameButtons[0].click();
  assert.deepEqual(actions.calls.pop(), ["navigate", "workers", "shop-api"]);
  const [needs, alert] = byClass(root, "marker");
  assert.equal(needs.tag, "button");
  needs.click();
  assert.deepEqual(actions.calls.pop(), ["navigate", "attention", "shop-api", "decide"], "red → the Needs you section");
  alert.click();
  assert.deepEqual(actions.calls.pop(), ["navigate", "attention", "shop-api", "anomalies"], "amber → the Alerts section");
  byTag(byClass(root, "project-name")[2], "button")[0].click();
  assert.deepEqual(actions.calls.pop(), ["navigate", "workers", "mobile-app"], "an idle project too");
});

test("V6 Overview in 中文 (real chain): interface words change, data does not; same grid, same blocks; seats read 已到 2 / 3 席", async () => {
  const vm = await overviewVm();
  const en = region();
  const zh = region();
  renderMain(en, vm, "en", UI0(), noopActions());
  renderMain(zh, vm, "zh", UI0(), noopActions());
  assert.equal(byClass(zh, "headline")[0].textContent, "3 个项目 · 6 个 worker 运行中 · 3 个启动中");
  assert.equal(byClass(zh, "since")[0].textContent, "上次来访（3 小时前）后：完成 6 项 · 失败 2 项");
  assert.deepEqual(byClass(zh, "marker").map((n) => n.textContent), ["●3 项需要你", "▲4 项异常"]);
  assert.deepEqual(byClass(zh, "type-row").map((n) => byClass(n, "c-type")[0].textContent), ["写代码", "调研", "交付会审", "写代码", "生图"]);
  assert.equal(byClass(byClass(zh, "type-row")[2], "flag")[0].textContent, "已到 2 / 3 席");
  assert.match(byClass(zh, "idle-note")[0].textContent, /^空闲 · 上次运行结束于 5 小时前$/);
  assert.match(byClass(zh, "lanes")[0].textContent, /车道6 条在用▲kimi 限流，最近观测于/);
  // Verbatim data: project names, lane names, run numbers.
  const data = (root) => ({
    names: byClass(root, "project-name").map((n) => n.textContent),
    lanes: byClass(root, "c-lanes").map((n) => n.textContent),
    runs: find(root, (n) => n.className.split(" ").includes("flag") && /run_/.test(n.textContent)).map((n) => byClass(n, "mono")[0].textContent),
  });
  assert.deepEqual(data(zh), data(en));
  const shape = (root) => JSON.stringify([byClass(root, "project").length, byClass(root, "type-row").length, byClass(root, "marker").length, byTag(root, "button").length]);
  assert.equal(shape(zh), shape(en));
});

test("V7 Overview: first visit says so; a capped list writes '≥ N'; empty directory; truncated notice", async () => {
  const bodies = await getShop();
  const first = region();
  renderMain(first, mainOf(netOf(bodies, ["overview"]), "overview", { visit: visitFirst() }), "en", UI0(), noopActions());
  assert.equal(byClass(first, "since")[0].textContent, "No earlier visit on record · last 24h: 7 finished · 2 failed");
  assert.equal(byClass(first, "note").length, 0, "no notice when the list is complete");
  // The Workers list was capped: the counts are a lower bound, the notice is shown.
  const capped = { ...bodies, workers: { ...bodies.workers, truncated: true } };
  const root = region();
  renderMain(root, mainOf(netOf(capped, ["overview"]), "overview", { visit: visitAgo(3 * HOUR) }), "en", UI0(), noopActions());
  assert.equal(byClass(root, "since")[0].textContent, "Since your last visit (3h ago): ≥ 6 finished · ≥ 2 failed");
  assert.equal(byClass(root, "note").length, 1, "the truncation notice");
  const zh = region();
  renderMain(zh, mainOf(netOf(capped, ["overview"]), "overview", { visit: visitAgo(3 * HOUR) }), "zh", UI0(), noopActions());
  assert.equal(byClass(zh, "since")[0].textContent, "上次来访（3 小时前）后：完成 ≥ 6 项 · 失败 ≥ 2 项");
  // Visited three days ago: the text says only the last 24h are counted.
  const old = region();
  renderMain(old, mainOf(netOf(bodies, ["overview"]), "overview", { visit: visitAgo(3 * DAY) }), "en", UI0(), noopActions());
  assert.equal(byClass(old, "since")[0].textContent, "Since your last visit (3d ago; only the last 24h are counted): 7 finished · 2 failed");
  // Empty directory.
  const nothing = await chain(snapshotOf({ projects: [], runs: [] }));
  const root2 = region();
  renderMain(root2, mainOf(netOf(nothing, ["overview"]), "overview"), "en", UI0(), noopActions());
  assert.equal(byClass(root2, "headline")[0].textContent, "0 projects · 0 workers running");
  assert.equal(byClass(root2, "empty")[0].textContent, "No projects yet.");
  assert.equal(byClass(root2, "lanes").length, 0, "no lane row when nothing is throttled");
});

test("V8 Attention (real chain): two sections with symbol + words + count; collapsed rows; resolved and the older group folded", async () => {
  const root = region();
  renderMain(root, await attentionVm(), "en", UI0(), noopActions());
  const [needs, alerts, resolved] = byClass(root, "section");
  assert.equal(byClass(needs, "section-title")[0].textContent, "Needs you●3", "the count includes the older group");
  assert.equal(byClass(alerts, "section-title")[0].textContent, "Alerts▲4");
  assert.equal(byClass(needs, "sort-hint")[0].textContent, "involved workers › duration");
  const rowTitles = (section) => byClass(section, "item-title").map((n) => n.textContent);
  assert.deepEqual(rowTitles(needs), ["Delivery review split · Order export", "Verification failed · Refactor payment module"], "the older group is not listed until opened");
  assert.deepEqual(byClass(needs, "item-meta").map((n) => n.textContent), ["shop-api · 4 workers · 25m", "shop-api · 12m"], "4 = the reviewed run and its three seats");
  assert.deepEqual(rowTitles(alerts), ["Failed · Throttled", "Failed · Broke", "Silent · Migrate orders table", "Lane throttled · kimi"]);
  const legacy = byClass(needs, "legacy")[0];
  assert.equal(byClass(legacy, "disclosure")[0].textContent, "Older than 7 days (1)", "only the count");
  assert.equal(byClass(legacy, "item").length, 0);
  assert.equal(byClass(resolved, "disclosure")[0].getAttribute("aria-expanded"), "false");
  assert.equal(byClass(resolved, "item").length, 0, "collapsed by default");
  for (const b of byClass(root, "item-btn")) {
    assert.equal(b.tag, "button");
    assert.equal(b.getAttribute("type"), "button");
    assert.equal(b.getAttribute("aria-expanded"), "false");
  }
});

test("V8b Alerts rows show run, lane and follow-up in the row itself — and invent nothing", async () => {
  const root = region();
  renderMain(root, await attentionVm(), "en", UI0(), noopActions());
  const alerts = byClass(root, "section")[1];
  const meta = Object.fromEntries(byClass(alerts, "item").map((li) => [byClass(li, "item-btn")[0].getAttribute("data-fk"), byClass(li, "item-meta")[0].textContent]));
  // run_rl failed on kimi (its lane), no follow-up known; run_f3 on glm-pro.
  assert.equal(meta["item:failed:run_rl"], "shop-api · kimi · run_rl · no follow-up · 35m");
  assert.equal(meta["item:failed:run_f3"], "shop-api · glm-pro · run_f3 · no follow-up · 30m");
  // A silent run has no follow-up fact in the data: none is written (no "no follow-up").
  assert.equal(meta["item:silent:run_r1"], "shop-api · glm-pro · run_r1 · 40m");
  // A lane item is about the lane: its title names it; the row shows projects and duration.
  assert.equal(meta["item:rate_limited:kimi"], "shop-api · 35m");
  assert.ok(!/follow-up/i.test(meta["item:silent:run_r1"] + meta["item:rate_limited:kimi"]), "only a failure has a follow-up fact");
  // A failure with a follow-up already running says so.
  const rerun = await chain(snapshotOf({ runs: [
    snapRun("run_a", { title: "A", state: "failed", terminalAt: ago(3 * HOUR), failure: { category: "provider_error", code: "backend_error" } }),
    snapLive("run_a2", { lineageRootRunId: "run_a", startedAt: ago(2 * HOUR) }),
  ] }));
  const root2 = region();
  renderMain(root2, mainOf(netOf(rerun), "attention"), "zh", UI0(), noopActions());
  assert.equal(byClass(byClass(root2, "section")[1], "item-meta")[0].textContent, "shop-api · glm-pro · run_a · 后续：运行中 · 3 小时");
});

test("V8c a failure whose retry has already started and failed again says so — in the row and in the detail, in both languages (never 'unknown')", async () => {
  const bodies = await chain(snapshotOf({ runs: [
    snapRun("run_first", { title: "Export orders", state: "failed", terminalAt: ago(3 * HOUR), terminalSeq: 21, failure: { category: "provider_error", code: "backend_error" } }),
    snapRun("run_retry1", { title: "Export orders (retry)", retryOf: "run_first", state: "failed", startedAt: ago(2 * HOUR), terminalAt: ago(100 * MIN), failure: { category: "provider_error", code: "backend_error" } }),
    snapLive("run_retry2", { title: "Export orders (retry 2)", retryOf: "run_first", startedAt: ago(30 * MIN) }),
  ] }));
  const vm = mainOf(netOf(bodies), "attention");
  const first = vm.anomalies.items.find((i) => i.id === "failed:run_first");
  assert.equal(first.followUp, "exists");
  assert.deepEqual(first.followUpRuns, [{ runId: "run_retry1", state: "failed" }, { runId: "run_retry2", state: "running" }]);
  // The newest retry is running: the row says "running"; the detail lists both retries with their states.
  const en = region();
  renderMain(en, vm, "en", { ...UI0(), selected: "failed:run_first" }, noopActions());
  assert.match(byClass(en, "item-meta").map((n) => n.textContent).find((m) => m.includes("run_first")), /follow-up: running/);
  assert.match(byClass(en, "row-detail")[0].textContent, /Follow-upfollow-up: running.*run_retry1 · failed.*run_retry2 · running/);
  const zh = region();
  renderMain(zh, vm, "zh", { ...UI0(), selected: "failed:run_first" }, noopActions());
  assert.match(byClass(zh, "row-detail")[0].textContent, /后续后续：运行中.*run_retry1 · 失败.*run_retry2 · 运行中/);
  // Only the failed retry is left (the other one is gone): the row says it failed.
  const onlyFailed = await chain(snapshotOf({ runs: [
    snapRun("run_first", { title: "Export orders", state: "failed", terminalAt: ago(3 * HOUR), failure: { category: "provider_error", code: "backend_error" } }),
    snapRun("run_retry1", { title: "Export orders (retry)", retryOf: "run_first", state: "failed", startedAt: ago(2 * HOUR), terminalAt: ago(100 * MIN), failure: { category: "provider_error", code: "backend_error" } }),
  ] }));
  const rowOf = (lang) => {
    const root = region();
    renderMain(root, mainOf(netOf(onlyFailed), "attention"), lang, UI0(), noopActions());
    return byClass(root, "item").map((li) => byClass(li, "item-meta")[0].textContent).find((m) => m.includes("run_first"));
  };
  assert.equal(rowOf("en"), "shop-api · glm-pro · run_first · follow-up: failed · 3h");
  assert.equal(rowOf("zh"), "shop-api · glm-pro · run_first · 后续：失败 · 3 小时");
  // A failed retry is not a disposition in progress: it does not push the item down the list.
  const sortSnap = await chain(snapshotOf({ runs: [
    snapRun("run_a", { state: "failed", terminalAt: ago(5 * HOUR), failure: { category: "provider_error", code: "backend_error" } }),
    snapRun("run_a_retry", { retryOf: "run_a", state: "failed", startedAt: ago(4 * HOUR), terminalAt: ago(3 * HOUR), failure: { category: "provider_error", code: "backend_error" } }),
    snapRun("run_b", { state: "failed", terminalAt: ago(2 * HOUR), failure: { category: "provider_error", code: "backend_error" } }),
    snapRun("run_c", { state: "failed", terminalAt: ago(4 * HOUR), failure: { category: "provider_error", code: "backend_error" } }),
    snapLive("run_c_retry", { retryOf: "run_c", startedAt: ago(3 * HOUR) }),
  ] }));
  const order = ids(attentionOf(sortSnap).anomalies.items).filter((id) => id.startsWith("failed:run_") && !id.includes("retry"));
  // run_a (5h, its retry failed) and run_b (2h, none) come before run_c (its retry is RUNNING), longest first.
  assert.deepEqual(order, ["failed:run_a", "failed:run_b", "failed:run_c"]);
});
test("V9 Attention: rows are buttons; selecting expands one row — project, delivery version, workers incl. seats, evidence with event numbers, Copy ref", async () => {
  const vm = await attentionVm();
  const root = region();
  const actions = noopActions();
  const first = vm.decide.items[0];
  assert.equal(first.id, "consult_split:shop-api:consult_order");
  renderMain(root, vm, "en", { ...UI0(), selected: first.id }, actions);
  const open = byClass(root, "item-selected");
  assert.equal(open.length, 1, "only the selected row is open");
  const btn = byClass(open[0], "item-btn")[0];
  assert.equal(btn.getAttribute("aria-expanded"), "true");
  const detail = byClass(open[0], "row-detail")[0];
  assert.equal(btn.getAttribute("aria-controls"), detail.getAttribute("id"));
  assert.deepEqual(byTag(detail, "dt").map((n) => n.textContent), ["Project", "Delivery version", "Workers", "Since", "Lasting", "Involved workers", "Observed from", "Reference"]);
  const text = detail.textContent;
  assert.match(text, /Delivery versionaaaaaaaa/, "the reviewed run's commit, short");
  for (const runId of ["run_rev", "run_s1", "run_s2", "run_r4"]) assert.ok(text.includes(runId), `${runId} is listed`);
  assert.match(text, /run_rev · Order export · glm-pro/);
  assert.match(text, /run_s1#0012 · \d\d:\d\d/, "the evidence carries the real event number");
  assert.match(text, /run_s2#0014 · \d\d:\d\d/);
  assert.ok(!text.includes("no event number"));
  assert.equal(byTag(detail, "code")[0].textContent, "consult_split:shop-api:consult_order [run_s1#0012 run_s2#0014]");
  const copy = byClass(detail, "btn")[0];
  assert.equal(copy.textContent, "Copy ref");
  copy.click();
  assert.deepEqual(actions.calls.pop(), ["copyRef", first]);
  assert.equal(byClass(detail, "btn").length, 1, "no Open worker button in this batch");
  assert.ok(!/Open worker/i.test(root.textContent));
  btn.click();
  assert.deepEqual(actions.calls.pop(), ["select", first.id]);
});

test("V9b a failed row's detail: reason and follow-up; evidence without an event number is flagged", async () => {
  const bare = await chain(snapshotOf({ runs: [snapRun("run_nb", { title: "No number", state: "failed", terminalAt: ago(HOUR), failure: { category: "provider_error", code: "backend_error" } })] }));
  const vm = mainOf(netOf(bare), "attention");
  const root = region();
  renderMain(root, vm, "en", { ...UI0(), selected: "failed:run_nb" }, noopActions());
  const detail = byClass(root, "row-detail")[0];
  assert.deepEqual(byTag(detail, "dt").map((n) => n.textContent), ["Project", "Workers", "Reason", "Follow-up", "Since", "Lasting", "Involved workers", "Observed from", "Reference"]);
  assert.match(detail.textContent, /Reasonprovider_error · backend_error/);
  assert.match(detail.textContent, /Follow-upno follow-up/);
  assert.match(detail.textContent, /run_nb · \d\d:\d\d · no event number/);
  assert.equal(byTag(detail, "code")[0].textContent, "failed:run_nb [run_nb]");
  // The same item with a real event number: no flag, and the code carries it.
  const numbered = await getShop();
  const vm2 = mainOf(netOf(numbered), "attention");
  const root2 = region();
  renderMain(root2, vm2, "en", { ...UI0(), selected: "failed:run_f3" }, noopActions());
  assert.match(root2.textContent, /run_f3#0090 · \d\d:\d\d/);
  assert.ok(!root2.textContent.includes("no event number"));
});

test("V9c delivery version: the short commit; 'unknown' when the commit could not be told; no row for other kinds", async () => {
  const unknown = await chain(snapshotOf({ runs: [snapRun("run_nc", { title: "No commit", deliveryRequested: true, delivery: snapDelivery({
    settlement: { status: "undeterminable", reason: "delivery_facts_malformed" }, commit: null, verification: null, acceptance: { status: null, decidedAt: null }, settledAt: null, ambiguous: true,
  }) })] }));
  const root = region();
  renderMain(root, mainOf(netOf(unknown), "attention"), "en", { ...UI0(), selected: "delivery_ambiguous:run_nc" }, noopActions());
  assert.match(byClass(root, "row-detail")[0].textContent, /Delivery versionunknown/);
  const zh = region();
  renderMain(zh, mainOf(netOf(unknown), "attention"), "zh", { ...UI0(), selected: "delivery_ambiguous:run_nc" }, noopActions());
  assert.match(byClass(zh, "row-detail")[0].textContent, /交付版本未知/);
  const shop = region();
  renderMain(shop, await attentionVm(), "en", { ...UI0(), selected: "silent:run_r1" }, noopActions());
  assert.ok(!byTag(byClass(shop, "row-detail")[0], "dt").map((n) => n.textContent).includes("Delivery version"), "a silent worker has no delivery");
  const pay = region();
  renderMain(pay, await attentionVm(), "en", { ...UI0(), selected: "verification_failed:run_pay" }, noopActions());
  assert.match(byClass(pay, "row-detail")[0].textContent, /Delivery versionbbbbbbbb/);
});

test("V10 the reference is the same string in both languages; event codes and run numbers are verbatim", async () => {
  const vm = await attentionVm();
  const target = vm.anomalies.items.find((i) => i.id === "silent:run_r1");
  assert.equal(target.ref, "silent:run_r1 [run_r1#0138]");
  const en = region();
  const zh = region();
  renderMain(en, vm, "en", { ...UI0(), selected: target.id }, noopActions());
  renderMain(zh, vm, "zh", { ...UI0(), selected: target.id }, noopActions());
  const refOf = (root) => byTag(root, "code")[0].textContent;
  assert.equal(refOf(en), refOf(zh));
  assert.equal(refOf(en), target.ref);
  const evidence = (root) => byClass(root, "evidence-line").map((n) => byClass(n, "mono")[0].textContent);
  assert.deepEqual(evidence(zh), evidence(en), "event codes are verbatim");
  assert.deepEqual(evidence(en), ["run_r1#0138"]);
  assert.equal(byTag(zh, "dt").map((n) => n.textContent).includes("观测依据"), true);
  assert.equal(byClass(zh, "btn")[0].textContent, "复制引用");
});

test("V11 Attention: the older group and Resolved open on request; unknown state is tagged, not hidden", async () => {
  const vm = await attentionVm();
  const root = region();
  renderMain(root, vm, "en", { ...UI0(), legacyOpen: { decide: true, anomalies: false }, resolvedOpen: true }, noopActions());
  const legacy = byClass(root, "legacy")[0];
  assert.equal(byClass(legacy, "disclosure")[0].getAttribute("aria-expanded"), "true");
  const rows = byClass(legacy, "item");
  assert.equal(rows.length, 1);
  assert.equal(byClass(rows[0], "item-title")[0].textContent, "Awaiting Lead decision · Old delivery");
  assert.equal(byClass(rows[0], "item-meta")[0].textContent, "shop-api · 9d");
  assert.equal(byClass(root, "section-resolved").length, 1);
  const actions = noopActions();
  const root2 = region();
  renderMain(root2, vm, "en", UI0(), actions);
  byTag(byClass(root2, "legacy")[0], "button")[0].click();
  assert.deepEqual(actions.calls.pop(), ["toggleLegacy", "decide"]);
  byTag(byClass(root2, "section-resolved")[0], "button")[0].click();
  assert.deepEqual(actions.calls.pop(), ["toggleResolved"]);
  // A resolved row: how it ended and how long ago (a quota resolved by a later success).
  const quota = snapRun("run_q", { laneId: "kimi", agentId: "kimi", state: "failed", terminalAt: ago(2 * HOUR), failure: { category: "provider_capacity", code: "quota_exhausted" }, capacity: { code: "quota_exhausted", observedAt: ago(2 * HOUR) } });
  const ok = snapRun("run_ok", { laneId: "kimi", agentId: "kimi", terminalAt: ago(30 * MIN) });
  const bodies = await chain(snapshotOf({ runs: [quota, ok] }));
  const root3 = region();
  renderMain(root3, mainOf(netOf(bodies), "attention"), "en", { ...UI0(), resolvedOpen: true }, noopActions());
  const row = byClass(byClass(root3, "section-resolved")[0], "item")[0];
  assert.equal(byClass(row, "item-title")[0].textContent, "Lane quota exhausted · kimi");
  assert.equal(byClass(row, "item-meta")[0].textContent, "a later run succeeded · 30m ago");
  // An unconfirmed item (hand-made state): tagged.
  const odd = region();
  const unknownItem = { ...vm, decide: { ...vm.decide, items: [{ ...vm.decide.items[1], state: "unknown" }, ...vm.decide.items.slice(2)] } };
  renderMain(odd, unknownItem, "en", UI0(), noopActions());
  assert.equal(byClass(odd, "tag")[0].textContent, "unconfirmed");
});

test("V12 Attention: empty sections say so; the project chip shows the project NAME (never the slug) and clears the filter", async () => {
  const calm = await chain(snapshotOf({ runs: [snapRun("run_calm")] }));
  const root = region();
  renderMain(root, mainOf(netOf(calm), "attention"), "en", UI0(), noopActions());
  assert.deepEqual(byClass(root, "empty").map((n) => n.textContent), ["Nothing needs your decision.", "No alerts."]);
  assert.deepEqual(byClass(root, "section-count").map((n) => n.className), ["section-count tone-gray", "section-count tone-gray"]);
  // A project whose slug carries a hash: the page shows the name.
  const slug = "carloha-8629bc9a";
  const snap = snapshotOf({
    projects: [snapProject(slug, "Carloha Agent")],
    runs: [snapRun("run_w", { project: { slug, name: "Carloha Agent" }, title: "Waiting one", deliveryRequested: true, delivery: snapDelivery({ settledAt: ago(3 * HOUR) }) })],
  });
  const bodies = await chain(snap);
  const root2 = region();
  const actions = noopActions();
  const vm = mainOf(netOf(bodies), "attention", { project: slug });
  renderMain(root2, vm, "en", { ...UI0(), selected: "awaiting_decision:run_w" }, actions);
  assert.equal(byClass(root2, "chip")[0].textContent, "Project: Carloha Agent✕");
  assert.ok(!root2.textContent.includes("8629bc9a"), "the slug's hash is nowhere on the page");
  assert.equal(byClass(byClass(root2, "item")[0], "item-meta")[0].textContent, "Carloha Agent · 3h");
  assert.match(byClass(root2, "row-detail")[0].textContent, /ProjectCarloha Agent/);
  const clear = byClass(root2, "chip-x")[0];
  assert.equal(clear.tag, "button");
  assert.equal(clear.getAttribute("aria-label"), "Clear filter");
  clear.click();
  assert.deepEqual(actions.calls.pop(), ["clearFilter"]);
});

test("V13 Workers page: the project filter chip shows the NAME, clears itself and survives the language switch (the page itself: ownerDashboardV2Workers.test.js)", async () => {
  const slug = "carloha-8629bc9a";
  const bodies = await chain(snapshotOf({ projects: [snapProject(slug, "Carloha Agent")], runs: [snapRun("run_c", { project: { slug, name: "Carloha Agent" } })] }));
  const net = netOf(bodies, ["workers"], model.INITIAL_NET, GEN_MS, slug);
  const vm = workersVmOf(net, workers.emptyView(slug));
  const root = region();
  const actions = noopActions();
  renderWorkersPage(root, vm, "en", actions);
  assert.equal(byClass(root, "placeholder").length, 0, "no placeholder line any more");
  assert.equal(byClass(root, "chip")[0].textContent, "Project: Carloha Agent✕");
  byClass(root, "chip-x")[0].click();
  assert.deepEqual(actions.calls.pop(), ["setFilter", "project", null]);
  const zh = region();
  renderWorkersPage(zh, vm, "zh", noopActions());
  assert.equal(byClass(zh, "chip")[0].textContent, "项目：Carloha Agent✕", "the filter survives the language switch");
  const bare = region();
  renderWorkersPage(bare, workersVmOf(netOf(bodies, ["workers"])), "en", noopActions());
  assert.equal(byClass(bare, "chip").length, 0);
});

test("V14 messages: loading, no token, rejected token, unreachable — as text, in both languages", () => {
  const msg = (kind, lang) => {
    const root = region();
    renderMain(root, { page: "message", kind }, lang, UI0(), noopActions());
    return byClass(root, "message")[0].textContent;
  };
  assert.equal(msg("loading", "en"), "Loading…");
  assert.match(msg("noToken", "en"), /dashboard link/);
  assert.match(msg("unauthorized", "en"), /access token was rejected/);
  assert.match(msg("network", "en"), /Cannot reach/);
  assert.match(msg("unavailable", "en"), /No data yet/);
  assert.match(msg("server", "en"), /unusable/);
  assert.equal(msg("loading", "zh"), "载入中…");
  assert.match(msg("unauthorized", "zh"), /令牌被拒绝/);
});

test("V15 a quiet poll leaves the DOM alone; a real change redraws and keeps the focused button", async () => {
  const root = region();
  const actions = noopActions();
  const vm = await attentionVm();
  const ui = { ...UI0(), selected: vm.decide.items[0].id };
  assert.equal(renderMain(root, vm, "en", ui, actions), true, "first draw");
  const before = root.children[0];
  assert.equal(renderMain(root, await attentionVm(), "en", { ...ui }, actions), false, "same data, same language, same UI: untouched");
  assert.equal(root.children[0], before, "the very same nodes");
  // A change of UI state does redraw.
  assert.equal(renderMain(root, vm, "en", { ...ui, resolvedOpen: true }, actions), true, "a toggle redraws");
  assert.equal(renderMain(root, vm, "en", { ...ui, resolvedOpen: true, selected: null }, actions), true, "a selection change redraws");
  assert.equal(renderMain(root, vm, "en", { ...ui }, actions), true);
  // Focus the selected row's button, then change the language: it is redrawn and focused again.
  const key = `item:${vm.decide.items[0].id}`;
  byClass(root, "item-btn")[0].focus();
  assert.equal(fakeDocument.activeElement.getAttribute("data-fk"), key);
  assert.equal(renderMain(root, vm, "zh", ui, actions), true);
  assert.equal(fakeDocument.activeElement.getAttribute("data-fk"), key, "focus found again by key");
  assert.ok(root.contains(fakeDocument.activeElement), "and it is the new node");
});

test("V15b the copy fallback's selection survives the next poll's redraw: a changed duration redraws the row, the reference stays selected", async () => {
  const bodies = await getShop();
  const at = (nowMs) => mainOf(netOf(bodies, ["overview", "workers", "attention"], model.INITIAL_NET, nowMs), "attention");
  // Same data one minute later: the durations moved, so the page is redrawn.
  const later = async () => {
    const newer = await chain(shopSnapshot(), GEN_MS + MIN);
    return mainOf(netOf(newer, ["overview", "workers", "attention"], model.INITIAL_NET, GEN_MS + MIN), "attention");
  };
  const vm = at(GEN_MS);
  const id = "silent:run_r1";
  const root = region();
  const ui = { ...UI0(), selected: id, copy: { id, result: "fail" } };
  renderMain(root, vm, "en", ui, noopActions());
  assert.equal(selectRefText(root, id), true, "the clipboard refused: the reference text is selected");
  const selected = fakeSelection.ranges[0].node;
  assert.equal(selected.getAttribute("data-ref"), id);
  // A quiet poll: nothing redrawn, selection untouched.
  assert.equal(renderMain(root, at(GEN_MS), "en", { ...ui }, noopActions()), false);
  assert.equal(fakeSelection.ranges[0].node, selected);
  // A poll that changes what is shown: the region is rebuilt, the selection is put back on the NEW node.
  const newer = await later();
  assert.equal(renderMain(root, newer, "en", { ...ui }, noopActions()), true, "the minute tick redraws");
  assert.equal(fakeSelection.ranges.length, 1, "the reference is still selected");
  const now = fakeSelection.ranges[0].node;
  assert.notEqual(now, selected, "on the redrawn node, not the detached one");
  assert.ok(root.contains(now));
  assert.equal(now.getAttribute("data-ref"), id);
  assert.equal(now.textContent, "silent:run_r1 [run_r1#0138]");
  // When the row is gone, nothing is selected (no stray selection left behind).
  assert.equal(renderMain(root, newer, "en", { ...ui, selected: null }, noopActions()), true);
  assert.equal(fakeSelection.ranges.length, 0);
  // A selection somewhere else (not a reference) is not touched by the restore logic.
  const other = region();
  renderMain(other, newer, "en", { ...ui }, noopActions());
  fakeSelection.ranges = [{ node: byClass(other, "headline")[0] ?? other }];
  renderMain(other, newer, "zh", { ...ui }, noopActions());
  assert.equal(fakeSelection.ranges.length, 0, "only a selected reference is restored");
});

test("V16 switching language keeps the page, the filter, the selection and every expansion", async () => {
  const vm = await attentionVm("shop-api");
  const ui = { selected: vm.decide.items[0].id, legacyOpen: { decide: true, anomalies: false }, resolvedOpen: true, copy: { id: vm.decide.items[0].id, result: "ok" } };
  const en = region();
  const zh = region();
  renderMain(en, vm, "en", ui, noopActions());
  renderMain(zh, vm, "zh", ui, noopActions());
  const state = (root) => ({
    chip: byClass(root, "chip").length,
    selected: byClass(root, "item-selected").map((n) => byClass(n, "item-btn")[0].getAttribute("data-fk")),
    expanded: byClass(root, "item-btn").map((n) => n.getAttribute("aria-expanded")),
    legacy: byClass(root, "legacy")[0].children.length,
    resolved: byClass(root, "item").length,
    sections: byClass(root, "section").length,
  });
  assert.deepEqual(state(zh), state(en));
  assert.equal(byClass(en, "btn")[0].textContent, "Copied");
  assert.equal(byClass(zh, "btn")[0].textContent, "已复制");
});

test("V17 text only: server text with markup characters is drawn as text, verbatim", async () => {
  const evil = "<img src=x onerror=alert(1)>&amp;";
  const bodies = await chain(snapshotOf({ runs: [snapRun("run_evil", { title: evil, deliveryRequested: true, delivery: snapDelivery({ settledAt: ago(3 * HOUR) }) })] }));
  const root = region();
  renderMain(root, mainOf(netOf(bodies), "attention"), "en", { ...UI0(), selected: "awaiting_decision:run_evil" }, noopActions());
  assert.ok(root.textContent.includes(evil), "shown exactly as received");
  assert.equal(find(root, (n) => n.tag === "img" || n.tag === "script").length, 0, "no element was created from it");
});

test("V18 landing: focusSection puts the focus on the heading of the section; false when that page part is not drawn", async () => {
  const root = region();
  renderMain(root, await attentionVm(), "en", UI0(), noopActions());
  assert.equal(focusSection(root, "anomalies"), true);
  assert.equal(fakeDocument.activeElement.getAttribute("data-section-title"), "anomalies");
  assert.equal(fakeDocument.activeElement.tag, "h2");
  assert.equal(fakeDocument.activeElement.getAttribute("tabindex"), "-1", "focusable by code, never a tab stop");
  assert.equal(focusSection(root, "decide"), true);
  assert.equal(fakeDocument.activeElement.getAttribute("data-section-title"), "decide");
  const overview = region();
  renderMain(overview, await overviewVm(), "en", UI0(), noopActions());
  assert.equal(focusSection(overview, "decide"), false, "the Overview has no such section");
  assert.equal(fakeDocument.activeElement, null);
  // A redraw keeps the landing: the section title is data-driven, present on every Attention draw.
  const again = region();
  renderMain(again, await attentionVm("shop-api"), "zh", UI0(), noopActions());
  assert.equal(focusSection(again, "decide"), true);
});

// =====================================================================
// G) GUARDS
// =====================================================================

const sourceOf = (name) => readV2(name);
const allJs = () => V2_JS.map((name) => [name, sourceOf(name)]);
/** Code without // and block comments (the sources hold no "//" inside a string). */
const codeOf = (name) => sourceOf(name).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// Decision 0131 A3 (batch 143b): the closed endpoint set grew by the Activity tab's two routes. They are
// read-only pages of the same worker transcript and go through the same single request function.
// Batch 144 (decision 0131 section 4) adds the Activity tab's event stream: read through that same single
// fetch call too (its reading and the feed's use of the frames are in ownerDashboardV2Activity.test.js).
test("G1 the page may read ONLY /api/session, /api/overview, /api/workers, /api/attention, /api/worker, /api/artifact, /api/worker/activity, /api/worker/event, /api/worker/stream", () => {
  const found = new Set();
  for (const [, text] of allJs()) for (const m of text.matchAll(/\/api\/([A-Za-z0-9_-]+)(\/[A-Za-z0-9_-]+)?/g)) found.add(m[1] + (m[2] ?? ""));
  assert.deepEqual([...found].sort(), ["artifact", "attention", "overview", "session", "worker", "worker/activity", "worker/event", "worker/stream", "workers"], "no other endpoint anywhere in the v2 code");
  // No query string is spelled out in code: the only queries are the ones api.js builds for its own closed key sets.
  assert.ok(!/\/api\/[A-Za-z]+\?/.test(allJs().map(([name]) => codeOf(name)).join("\n")), "no query string literal on a data route");
  assert.doesNotMatch(readV2("index.html"), /\/api\//);
  assert.deepEqual([...api.API_PATHS].sort(), ["/api/artifact", "/api/attention", "/api/overview", "/api/session", "/api/worker", "/api/worker/activity", "/api/worker/event", "/api/worker/stream", "/api/workers"]);
  // The pages ask for no route outside the set.
  for (const page of model.PAGES) for (const path of [...model.endpointsFor(page), ...model.endpointsFor(page, "shop-api")]) assert.ok(api.isDataPath(path), `${page}: ${path}`);
});

test("G2 exactly ONE direct network call in the v2 code, and it is in api.js", () => {
  const calls = allJs().flatMap(([name, text]) => [...text.matchAll(/(?<![A-Za-z0-9_$.])fetch\s*\(/g)].map(() => name));
  assert.deepEqual(calls, ["api.js"]);
  for (const [name, text] of allJs()) {
    assert.doesNotMatch(text, /XMLHttpRequest|EventSource|WebSocket|sendBeacon|importScripts|navigator\.serviceWorker/, `${name}: no other transport`);
  }
  assert.equal(allJs().filter(([, t]) => /\bAuthorization\b|authorization:/i.test(t)).map(([n]) => n).join(), "api.js", "the bearer header is built in one place");
});

test("G3 no markup parsing, no eval, no inline handlers anywhere in v2", () => {
  const banned = /innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser|\beval\s*\(|new\s+Function\b|setTimeout\s*\(\s*["'`]|setInterval\s*\(\s*["'`]|srcdoc|\.src\s*=/;
  for (const [name, text] of allJs()) {
    assert.doesNotMatch(text, banned, `${name}: no markup-parsing or code-from-string API`);
    assert.doesNotMatch(text, /\.on[a-z]+\s*=[^=]/, `${name}: no handler property assignment`);
    assert.doesNotMatch(text, /setAttribute\(\s*["']on/i, `${name}: no inline handler attribute`);
    assert.doesNotMatch(text, /javascript:/i, `${name}: no javascript: URL`);
  }
  const html = readV2("index.html");
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "no inline handler attribute in the page");
  assert.doesNotMatch(html, /<style|\sstyle\s*=/i, "no inline style");
  assert.doesNotMatch(html, /javascript:/i);
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
  assert.deepEqual(scripts, ['<script type="module" src="/v2/app.js">'], "one external module script, none inline");
  assert.doesNotMatch(html, /<script\b[^>]*>[^<]+<\/script>/i, "no inline script body");
  // The only DOM-building text API is textContent / createTextNode.
  assert.match(sourceOf("views.js"), /textContent = value/);
  assert.match(sourceOf("views.js"), /createTextNode/);
});

test("G4 same-origin only: every reference in the page is under /v2/ (or the data: favicon); no external URL anywhere", () => {
  const html = readV2("index.html");
  const refs = [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(refs.sort(), ["/v2/app.js", "/v2/styles.css", refs.find((r) => r.startsWith("data:image/png")) ].sort());
  // Batch 143b: the stylesheet's motion credit names the motion-prompt library once, in a comment (the
  // design requires the attribution). It is the ONLY external URL a /v2 file may contain.
  const MOTION_CREDIT = "https://showheyohtaki.github.io/motion-prompt/";
  for (const name of V2_FILES) {
    const source = readV2(name).split(MOTION_CREDIT).join("");
    assert.doesNotMatch(source, /https?:\/\/|\/\/[a-z0-9.-]+\.[a-z]{2,}/i, `${name}: no external URL`);
  }
  assert.equal(readV2("styles.css").split(MOTION_CREDIT).length - 1, 1, "the credit URL appears once (a comment) in the stylesheet");
  assert.doesNotMatch(readV2("styles.css"), /@import|@font-face|url\(/i, "the stylesheet loads nothing");
  // Every import resolves to a v2 file that the server serves.
  const served = new Set(V2_JS);
  for (const [name, text] of allJs()) {
    for (const m of text.matchAll(/from\s+"([^"]+)"/g)) {
      assert.match(m[1], /^\.\/[a-z0-9]+\.js$/, `${name}: import ${m[1]} is a sibling v2 module`);
      assert.ok(served.has(m[1].slice(2)), `${name}: ${m[1]} is a served file`);
    }
    assert.doesNotMatch(text, /import\s*\(/, `${name}: no dynamic import`);
  }
});

test("G5 the token never reaches the page, a URL, a log, a message or storage other than sessionStorage", () => {
  for (const [name, text] of allJs()) {
    assert.doesNotMatch(text, /console\./, `${name}: no logging`);
    assert.doesNotMatch(text, /localStorage\.|sessionStorage\./, `${name}: storage only through store.js getters`);
    if (name !== "store.js") assert.doesNotMatch(text, /\.getItem\(|\.setItem\(/, `${name}: direct storage access`);
  }
  const app = sourceOf("app.js");
  assert.match(app, /window\.sessionStorage/, "the token goes to sessionStorage (getter)");
  assert.match(app, /window\.localStorage/, "language and last visit go to localStorage (getter)");
  assert.doesNotMatch(codeOf("app.js"), /location\.(search|href)\s*=|location\.assign|location\.replace/, "no navigation that could carry it");
  // The token is read before the page fragment, and the page fragment is read from what is left.
  const appCode = codeOf("app.js");
  assert.ok(appCode.indexOf("resolveToken(") < appCode.indexOf("parseHash("), "token fragment first, page fragment after");
  assert.ok(appCode.indexOf("resolveToken(") < appCode.indexOf("canonical"), "the fragment is cleared before the page fragment is canonicalized");
  // A token link pasted into a tab that already shows the page changes only the fragment: reload to take it.
  assert.match(appCode, /hashchange[\s\S]{0,400}location\.hash\.startsWith\("#token="\)[\s\S]{0,80}location\.reload\(\)/);
  // 145b 修正一 #14：带项目筛选的 #workers?project=…&code=… 形态粘进已打开页面也重载（splitCodeFromHash 判定）。
  assert.match(appCode, /hashchange[\s\S]{0,460}splitCodeFromHash\(window\.location\.hash\) !== null[\s\S]{0,60}location\.reload\(\)/);
  // Only the Authorization header carries it: one use, in api.js.
  assert.equal([...codeOf("api.js").matchAll(/authorizationHeader\(/g)].length, 1, "used once, in the request");
  for (const name of V2_JS.filter((n) => n !== "api.js")) assert.doesNotMatch(codeOf(name), /authorizationHeader/, name);
});

test("G6 DOM-free modules never touch the DOM or browser globals", () => {
  for (const name of ["activity.js", "model.js", "i18n.js", "store.js", "workers.js", "detail.js", "artifacts.js"]) {
    assert.doesNotMatch(codeOf(name), /\b(document|window|navigator|localStorage|sessionStorage|location|history|fetch|setTimeout)\b/, name);
  }
  assert.doesNotMatch(codeOf("api.js"), /\b(document|window|navigator|localStorage|sessionStorage|location)\b/, "api.js talks through injected getters");
});

// Batch 143b moves the motion guard to ownerDashboardV2Activity.test.js (curve, durations, reduced motion,
// reflow-free properties). What stays here is that /v2 has no SCRIPTED motion: every move is CSS.
test("G7 no scripted motion in v2: no element.animate, no requestAnimationFrame, no smooth scroll; the CSS guard lives in ownerDashboardV2Activity.test.js", () => {
  for (const [name, text] of allJs()) {
    assert.doesNotMatch(text, /\.animate\s*\(|requestAnimationFrame|behavior\s*:\s*["']smooth|scrollIntoView|scrollTo\s*\(|classList/, `${name}: no scripted motion`);
  }
  assert.match(readV2("styles.css"), /@media \(prefers-reduced-motion: reduce\)/, "the stylesheet turns its motion off for reduced motion (the full guard is the Activity test's)");
});

test("G8 the static table and the old guard: v2 files are all reachable only through fixed routes", async () => {
  const s = makeServer();
  const served = [];
  for (const name of V2_FILES) {
    const url = name === "index.html" ? "/v2" : `/v2/${name}`;
    const r = await drive(s.handler, { url });
    served.push(r.status === 200 && r.body === readV2(name));
  }
  assert.ok(served.every(Boolean), "every v2 file is served, byte for byte");
  // No v2 route exists for any other file name that could be on disk.
  for (const name of readdirSync(V2)) assert.ok(V2_FILES.includes(name), `unexpected file in v2/: ${name}`);
});

// ----- visual spec -----

const cssVar = (css, name) => {
  const m = new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(css);
  assert.ok(m, `css variable --${name}`);
  return m[1];
};

function luminance(hex) {
  const channel = (i) => {
    const v = parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("G9 the palette is CSS variables with the designed values", () => {
  const css = readV2("styles.css");
  const expected = {
    ink: "#20252B", "ink-2": "#5F6873", line: "#D8DDE3", red: "#B4232C", "red-bg": "#FAEAEB", amber: "#895300", "amber-bg": "#FFF4DB",
    page: "#F6F7F8", surface: "#FFFFFF", selected: "#ECEFF2", skeleton: "#E9E7E5",
  };
  for (const [name, hex] of Object.entries(expected)) assert.equal(cssVar(css, name).toUpperCase(), hex, `--${name}`);
  // Colors are written once, as variables (the rest of the stylesheet refers to them). Comments are
  // stripped first: batch 143b's motion attribution names the motion-prompt issue numbers (#068 …), which
  // are not colors.
  const outsideRoot = css.replace(/:root\s*\{[^}]*\}/, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(outsideRoot, /#[0-9A-Fa-f]{3,8}\b/, "no color literal outside :root");
});

test("G10 layout numbers: 64px top bar, 48px page margins, 3px charcoal section rules, 4px radius, no shadows", () => {
  const css = readV2("styles.css");
  assert.match(css, /--topbar-h:\s*64px/);
  assert.match(css, /--gutter:\s*48px/);
  assert.match(css, /\.topbar\s*\{[^}]*padding:\s*0 var\(--gutter\)/);
  assert.match(css, /\.page\s*\{[^}]*padding:\s*32px var\(--gutter\)/);
  assert.match(css, /\.project\s*\{[^}]*border-top:\s*3px solid var\(--ink\)/);
  assert.match(css, /\.section\s*\{[^}]*border-top:\s*3px solid var\(--ink\)/);
  assert.match(css, /\.item\s*\{[^}]*border-bottom:\s*1px solid var\(--line\)/);
  assert.match(css, /\.btn\s*\{[^}]*border-radius:\s*4px/);
  assert.doesNotMatch(css, /box-shadow|text-shadow|drop-shadow/);
  // Type scale: serif titles, sans body, mono figures.
  assert.match(css, /\.headline\s*\{[^}]*font:\s*600 36px\/48px var\(--serif\)/);
  assert.match(css, /\.section-title\s*\{[^}]*font:\s*600 26px\/34px var\(--serif\)/);
  assert.match(css, /\.project-name\s*\{[^}]*font:\s*600 22px\/30px var\(--serif\)/);
  assert.match(css, /body\s*\{[^}]*font:\s*400 15px\/22px var\(--sans\)/);
  assert.match(css, /\.mono\s*\{[^}]*font-size:\s*13px;[^}]*line-height:\s*20px/);
});

test("G11 fonts: system fallback stacks only; LATIN faces first, then the CJK faces (so English headings never land on SimSun)", () => {
  const css = readV2("styles.css");
  const stack = (name) => new RegExp(`--${name}:\\s*([^;]+);`).exec(css)[1].trim();
  assert.equal(stack("serif"), 'Georgia, Cambria, "Times New Roman", "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", "SimSun", serif');
  assert.equal(stack("sans"), '"Segoe UI", "Helvetica Neue", Arial, "Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif');
  assert.equal(stack("mono"), '"IBM Plex Mono", "Cascadia Mono", Consolas, monospace');
  for (const name of ["serif", "sans"]) {
    const members = stack(name).split(",").map((m) => m.trim().replace(/^"|"$/g, ""));
    const firstCjk = members.findIndex((m) => /Source Han|Noto .* CJK|Songti|SimSun|YaHei|PingFang/.test(m));
    assert.ok(firstCjk > 0, `${name}: a Latin face comes before the first CJK face`);
    assert.ok(members.slice(0, firstCjk).every((m) => !/SimSun|YaHei|PingFang|Songti|CJK|Source Han/.test(m)), `${name}: nothing CJK among the Latin faces`);
    assert.equal(members.indexOf("SimSun") === -1 || members.indexOf("SimSun") > firstCjk - 1, true);
  }
  assert.match(css, /\.headline\s*\{[^}]*font:\s*600 /, "the headings keep weight 600");
  assert.doesNotMatch(css, /@font-face|url\(|fonts\.googleapis|woff/i);
  const fontFamilies = [...css.matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(fontFamilies.every((f) => f === "var(--mono)"), "font-family only through the variables");
});

test("G12 WCAG AA: every text pair measures >= 4.5:1; focus ring and chevron >= 3:1", () => {
  const css = readV2("styles.css");
  const c = (name) => cssVar(css, name);
  const pairs = [
    ["ink on page", c("ink"), c("page")], ["ink on surface", c("ink"), c("surface")], ["ink on selected row", c("ink"), c("selected")],
    ["secondary on page", c("ink-2"), c("page")], ["secondary on surface", c("ink-2"), c("surface")], ["secondary on selected row", c("ink-2"), c("selected")],
    ["red on page", c("red"), c("page")], ["red on surface", c("red"), c("surface")], ["red on selected row", c("red"), c("selected")], ["red on its tint", c("red"), c("red-bg")],
    ["amber on page", c("amber"), c("page")], ["amber on surface", c("amber"), c("surface")], ["amber on selected row", c("amber"), c("selected")], ["amber on its tint", c("amber"), c("amber-bg")],
  ];
  for (const [what, fg, bg] of pairs) assert.ok(contrast(fg, bg) >= 4.5, `${what}: ${contrast(fg, bg).toFixed(2)}:1`);
  assert.ok(contrast(c("focus"), c("page")) >= 3 && contrast(c("focus"), c("selected")) >= 3, "focus ring");
  assert.ok(contrast(c("ink-2"), c("selected")) >= 3, "chevron");
  // Keyboard: a visible focus style on every button.
  assert.match(css, /button:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus\)/);
  assert.doesNotMatch(css, /outline:\s*(none|0)\b/);
});

test("G13 English sets the minimum widths: nav, counts and the type column; Chinese stays left-aligned in them", () => {
  const css = readV2("styles.css");
  assert.match(css, /\.nav-btn\s*\{[^}]*min-width:\s*96px[^}]*text-align:\s*left/s);
  assert.match(css, /\.badge-needsYou\s*\{\s*min-width:\s*128px/);
  assert.match(css, /\.badge-alerts\s*\{\s*min-width:\s*108px/);
  assert.match(css, /\.type-row\s*\{[^}]*grid-template-columns:\s*minmax\(176px, 220px\)/);
  assert.doesNotMatch(css, /text-align:\s*justify/, "no justified text");
  assert.doesNotMatch(css, /:lang\(|\[lang/, "one layout for both languages: no per-language rules");
});

test("G14 keyboard-first: only <button>s are clickable, whatever the page; no fake buttons; the only tabindex is the code-only -1 of a section heading", async () => {
  const clickable = (root) => find(root, (n) => n.listeners.has("click")).map((n) => n.tag);
  const attention = await attentionVm();
  const uiOpen = { selected: attention.decide.items[0].id, legacyOpen: { decide: true, anomalies: true }, resolvedOpen: true, copy: null };
  const drawn = [];
  const top = region();
  renderTopbar(top, topbarOf(netOf(await getShop())), "en", noopActions());
  drawn.push(top);
  const pages = [
    [await overviewVm(), UI0()], [attention, UI0()], [await attentionVm("shop-api"), uiOpen],
  ];
  for (const [vm, ui] of pages) {
    const root = region();
    renderMain(root, vm, "zh", ui, noopActions());
    drawn.push(root);
  }
  // The Workers page (its own renderer: the search box lives outside the redrawn parts).
  for (const view of [workers.emptyView(), workers.emptyView("shop-api"), { ...workers.emptyView(), status: "starting" }]) {
    const root = region();
    renderWorkersPage(root, workers.workersPage(mainOf(netOf(await getShop(), ["workers"], model.INITIAL_NET, GEN_MS, view.project), "workers", { project: view.project }), view, true), "zh", noopActions());
    drawn.push(root);
  }
  const tags = drawn.flatMap(clickable);
  assert.ok(tags.length > 20, `plenty of controls drawn (${tags.length})`);
  assert.ok(tags.every((tag) => tag === "button"), `click handlers only on buttons, got ${[...new Set(tags)]}`);
  // Every button is type=button with focus kept findable (data-fk), so a redraw can restore focus.
  for (const root of drawn) {
    for (const b of byTag(root, "button")) {
      assert.equal(b.getAttribute("type"), "button");
      assert.ok(b.getAttribute("data-fk"), "focus key");
    }
    const keys = byTag(root, "button").map((b) => b.getAttribute("data-fk"));
    assert.equal(new Set(keys).size, keys.length, "focus keys are unique within a region");
    // Nothing but the section headings carries a tabindex, and only the code-only -1.
    for (const node of find(root, (n) => n.attrs.has("tabindex"))) {
      assert.equal(node.getAttribute("tabindex"), "-1");
      assert.ok(node.attrs.has("data-section-title"), "only a section heading is focusable by code");
    }
  }
  const views = sourceOf("views.js");
  assert.doesNotMatch(views, /role:\s*"(button|link|tab|menuitem)"/, "no fake buttons");
  assert.deepEqual([...codeOf("views.js").matchAll(/tabindex[^,}]*/g)].map((m) => m[0].trim()), ['tabindex: "-1"'], "one tabindex in the code");
  assert.doesNotMatch(readV2("index.html"), /tabindex/i, "no tabindex in the page");
  assert.match(readV2("index.html"), /<html lang="en">/, "English is the default document language");
});
test("G15 app.js: the clipboard failure falls back to selecting the text; no write to the server exists", () => {
  const app = sourceOf("app.js");
  assert.match(app, /try\s*\{\s*await navigator\.clipboard\.writeText\(item\.ref\);[\s\S]*?\}\s*catch\s*\{[\s\S]*?copied = false/);
  assert.match(app, /if \(!copied\) selectRefText\(mainEl, item\.id\)/);
  assert.match(app, /item\.ref/);
  assert.doesNotMatch(app, /method:\s*["'](POST|PUT|PATCH|DELETE)/i);
  assert.doesNotMatch(sourceOf("api.js"), /method:\s*["'](?!GET)/);
  // Polling every 5 seconds with one round at a time.
  assert.match(app, /POLL_MS/);
  assert.match(app, /if \(token === null \|\| polling\) return/);
});

test("G16 (145a) the legacy UI is gone from the tree: src/owner-dashboard holds only v2/, so the v2 guard reads the only client there is", () => {
  for (const name of ["index.html", "styles.css", "app.js"]) {
    assert.equal(existsSync(join(SRC, name)), false, `the retired legacy ${name} is removed`);
  }
  assert.deepEqual(readdirSync(SRC).sort(), ["v2"], "only the v2 directory remains under src/owner-dashboard/");
  assert.ok(existsSync(join(V2, "app.js")), "the v2 client is the one UI");
  assert.doesNotMatch(readV2("app.js"), /\/api\/(runs|activity)\b/, "the v2 client never speaks the retired routes");
});

test("G17 the marker / count landing is wired end to end: top bar and project markers pick the section, the fragment carries it, the app focuses it once drawn", () => {
  const views = codeOf("views.js");
  assert.match(views, /actions\.navigate\("attention", null, needs \? "decide" : "anomalies"\)/, "the top-bar counts");
  assert.match(views, /actions\.navigate\("attention", block\.slug, "decide"\)/, "the red marker");
  assert.match(views, /actions\.navigate\("attention", block\.slug, "anomalies"\)/, "the amber marker");
  const app = codeOf("app.js");
  assert.match(app, /state\.landing !== null && body\.page === "attention" && focusSection\(mainEl, state\.landing\)\) state\.landing = null/, "applied once, after the section is drawn");
  assert.match(app, /formatHash\(page, project, section\)/);
  assert.match(app, /next\.section !== state\.section/, "landing elsewhere on the same page counts as a change");
  assert.match(app, /if \(pageChanged \|\| next\.project !== state\.project\) state\.ui = freshUi\(\)/, "landing in the other section keeps what is open");
});

test("G18 the section counts keep the monospaced face (only size and line height follow the heading); project NAMES, not slugs, are displayed", () => {
  const css = readV2("styles.css");
  const rule = /\.section-count \.mono\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, "the rule exists");
  assert.doesNotMatch(rule[1], /font:\s*inherit/, "no shorthand that would reset the family");
  assert.doesNotMatch(rule[1], /font-family/, "the family stays the one .mono sets");
  assert.match(rule[1], /font-size:\s*inherit/);
  assert.match(rule[1], /line-height:\s*inherit/);
  assert.match(css, /\.mono\s*\{[^}]*font-family:\s*var\(--mono\)/);
  // Views read names from the view model; no view prints a raw project slug.
  const views = codeOf("views.js");
  assert.doesNotMatch(views, /project\.slug|\.projectSlugs|projects\.join/, "a slug is a key, never display text (except the Overview block's own name fallback in the model)");
  assert.match(views, /item\.projects\.map\(\(project\) => project\.name\)/);
  assert.match(views, /t\(lang, "filter\.project", \{ name: projectName \}\)/);
});

test("G19 freshness is derived from the clock at every redraw (never frozen in the state)", async () => {
  const app = codeOf("app.js");
  assert.match(app, /buildTopbar\(state\.net, state\.page, nowMs\)/);
  assert.ok(!("freshness" in model.INITIAL_NET), "the state holds no freshness field: freshnessOf derives it");
  const net = netOf(await getShop(), ["overview"]);
  assert.deepEqual(Object.keys(net).sort(), ["failingSinceMs", "pages", "problem", "serverStale"]);
  const m = codeOf("model.js");
  assert.match(m, /export const STALE_AFTER_MS = 30_000/);
  assert.match(m, /nowMs - generatedMs > STALE_AFTER_MS/);
  // A switch to another page fetches that page at once (a cached page older than the newest publication is Stale until then).
  assert.match(app, /if \(pageChanged\) pollSoon\(\);/);
  assert.match(app, /if \(polling\) pollAgain = true;/, "a switch during a round is not lost: the next round starts right after it");
});
