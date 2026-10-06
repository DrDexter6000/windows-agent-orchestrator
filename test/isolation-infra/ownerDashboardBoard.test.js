// test/isolation-infra/ownerDashboardBoard.test.js
//
// Board view (seat swimlane board) — the second PRESENTATION of the SAME
// current-scope /api/runs data the list view shows. The board adds no endpoint,
// no field, and no fetch; switching list ⇄ board is presentation-only.
//
// Deterministic, dependency-free surfaces covered (same pattern as
// ownerDashboardWeb.test.js — pure DOM-free helpers + static asset contracts):
//
//   R1  entry + scope independence (view toggle; board shows the scope label;
//       switching never refetches / never resets the window)
//   R2  data plane frozen (still ONLY /api/runs + /api/activity; one fetch)
//   R3  swimlane layout (per-agentId lanes; cards reuse selectRun)
//   R4  deterministic identity colors (fixed palette; first-fit collision
//       yield; pairwise-distinct for any <=palette seat set)
//   R5  lane ordering (freshest seat first; tie → agentId; no manual order)
//   R6  explicit unknown lane (pinned last; named; data-limit note)
//   R7  honesty lines (scope label; truncation notice; standing caveat)
//   R8  accessibility hard pins (WCAG AA text contrast computed numerically;
//       text labels so nothing is color-only; focus-visible; no motion)
//   R9  the five render states (normal / loading / empty / error /
//       stale-data-plus-error)
//
// R10 (the pre-existing 105-test contract) is enforced by
// ownerDashboardWeb.test.js itself, which this file does not modify.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as app from "../../src/owner-dashboard/app.js";

test("TD-220 BOARD: thinking and envelope survive category filtering and safe description", () => {
  const entries = [{ category: "thinking" }, { category: "envelope", kind: "stop_verified" }, { category: "other" }];
  const selected = app.filterByCategories(entries, new Set(["thinking", "envelope"]));
  assert.deepEqual(selected.map((e) => app.describeEntry(e).category), ["thinking", "envelope"]);
  assert.deepEqual(selected.map((e) => app.describeEntry(e).body), ["思考中", "envelope · stop_verified"]);
});

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "../..", "src", "owner-dashboard");
const readAsset = (name) => readFileSync(join(SRC, name), "utf8");

// Extract the full source of one top-level function (from its declaration to
// the next "\nfunction " at column 0) so behavior can be asserted on the exact
// body without grepping unrelated code.
function fnBody(js, name) {
  const start = js.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} exists`);
  const next = js.indexOf("\nfunction ", start + 1);
  return js.slice(start, next < 0 ? js.length : next);
}

// ===== WCAG 2.x relative luminance / contrast (pure, computed — not asserted
// on faith): every text pair the board renders must measure >= 4.5:1. =====
function luminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(m, `hex token ${hex}`);
  const n = parseInt(m[1], 16);
  const chan = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan((n >> 16) & 255) + 0.7152 * chan((n >> 8) & 255) + 0.0722 * chan(n & 255);
}
function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}
function cssVar(css, name) {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"));
  assert.ok(m, `token --${name} defined`);
  return m[1];
}

// =====================================================================
// R4) DETERMINISTIC IDENTITY COLORS
// =====================================================================

test("BOARD R4 PALETTE: fixed frozen palette of >=8 distinct hex colors", () => {
  assert.ok(Array.isArray(app.BOARD_PALETTE), "BOARD_PALETTE exported");
  assert.ok(Object.isFrozen(app.BOARD_PALETTE), "palette frozen");
  assert.ok(app.BOARD_PALETTE.length >= 8, "at least 8 slots");
  assert.equal(new Set(app.BOARD_PALETTE).size, app.BOARD_PALETTE.length, "all colors distinct");
  for (const hex of app.BOARD_PALETTE) assert.match(hex, /^#[0-9a-f]{6}$/i);
});

test("BOARD R4 COLOR: 8 diverse seat ids (superlong + look-alike shapes) get pairwise-distinct slots", () => {
  const ids = [
    "coder_hq",
    "auditor_x",
    "a",
    "aa",
    "A",                               // case-shape look-alike of "a"
    "seat_" + "z".repeat(180),         // superlong id
    "dev.01",
    "dev-01",                          // separator-shape look-alike of "dev.01"
  ];
  assert.equal(new Set(ids).size, 8, "precondition: 8 distinct ids");
  const slots = app.boardColorSlots(ids);
  assert.deepEqual(Object.keys(slots).sort(), [...ids].sort(), "every id assigned");
  const values = Object.values(slots);
  assert.equal(new Set(values).size, 8, "8 visible seats → 8 pairwise-distinct colors on screen");
  for (const v of values) {
    assert.ok(Number.isInteger(v) && v >= 0 && v < app.BOARD_PALETTE.length, `slot ${v} in range`);
  }
});

test("BOARD R4 COLOR: deterministic across refreshes — same set, any input order, repeated calls", () => {
  const ids = ["coder_hq", "auditor_x", "reviewer_1", "watchdog"];
  const a = app.boardColorSlots(ids);
  const b = app.boardColorSlots([...ids].reverse()); // arrival order must not matter
  const again = app.boardColorSlots(ids);            // a later refresh keeps colors
  assert.deepEqual(a, b, "assignment is a pure function of the id SET");
  assert.deepEqual(a, again, "same set → same slots on every refresh");
  // A single id keeps its PREFERRED slot when nothing collides.
  const solo = app.boardColorSlots(["coder_hq"]);
  assert.equal(solo.coder_hq, app.seatColorIndex("coder_hq"));
});

test("BOARD R4 COLOR: first-fit at capacity (palette-size set distinct) + documented overflow fallback", () => {
  const ten = Array.from({ length: 10 }, (_, i) => `seat_${i}`);
  const slots = app.boardColorSlots(ten);
  assert.equal(Object.keys(slots).length, 10);
  assert.equal(new Set(Object.values(slots)).size, app.BOARD_PALETTE.length,
    "a set exactly at palette capacity is still pairwise-distinct");
  // One MORE seat than slots: every id still gets a valid index (the overflow
  // falls back to its preferred slot — the only allowed same-color case).
  const eleven = app.boardColorSlots([...ten, "seat_overflow"]);
  assert.equal(Object.keys(eleven).length, 11, "overflow still assigned");
  for (const v of Object.values(eleven)) {
    assert.ok(Number.isInteger(v) && v >= 0 && v < app.BOARD_PALETTE.length, `slot ${v} in range`);
  }
  assert.ok(new Set(Object.values(eleven)).size <= app.BOARD_PALETTE.length,
    "distinct colors are bounded by the palette (documented fallback)");
});

test("BOARD R4 COLOR: unknown-lane ids never take a palette slot", () => {
  const slots = app.boardColorSlots(["unknown", "", "coder_hq", null, 42]);
  assert.deepEqual(Object.keys(slots), ["coder_hq"], "only real seats are assigned");
  assert.ok(app.isUnknownAgent("unknown") && app.isUnknownAgent("") && app.isUnknownAgent(null));
  assert.ok(!app.isUnknownAgent("coder_hq"));
});

test("BOARD R4 PAIRING: styles.css .seat-N track rules carry the exact BOARD_PALETTE hexes", () => {
  const css = readAsset("styles.css");
  app.BOARD_PALETTE.forEach((hex, i) => {
    assert.match(css, new RegExp(`\\.lane-track\\.seat-${i}\\s*\\{[^}]*${hex}`),
      `seat-${i} lane track = ${hex} (JS palette and CSS cannot drift)`);
  });
});

// =====================================================================
// R3/R5/R6) LANES — grouping, ordering, unknown lane
// =====================================================================

const T0 = "2026-10-03T09:00:00Z";
const iso = (h, m = 0) => `2026-10-03T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;

test("BOARD R3/R5 LANES: groups runs per seat; freshest seat first; tie → agentId order", () => {
  const runs = [
    { runId: "run_a1", agentId: "alpha", state: "running", terminal: false, updatedAt: iso(10) },
    { runId: "run_b1", agentId: "beta", state: "completed", terminal: true, updatedAt: iso(12) },
    { runId: "run_a2", agentId: "alpha", state: "completed", terminal: true, updatedAt: iso(12) },
    { runId: "run_c1", agentId: "gamma", state: "running", terminal: false, updatedAt: iso(11) },
  ];
  const lanes = app.boardLanes(runs);
  // alpha and beta both have latest activity at 12:00 → tie breaks by agentId;
  // gamma (11:00) is older and ordered after both.
  assert.deepEqual(lanes.map((l) => l.agentId), ["alpha", "beta", "gamma"]);
  assert.equal(lanes[0].latestMs, Date.parse(iso(12)), "a lane's recency is its FRESHEST run, not its first");
  assert.deepEqual(lanes[1].runs.map((r) => r.runId), ["run_b1"]);
  assert.deepEqual(lanes[0].runs.map((r) => r.runId).sort(), ["run_a1", "run_a2"], "alpha holds both its runs");
  assert.ok(lanes.every((l) => l.isUnknown === false));
});

test("BOARD R3 CARDS: non-terminal first (freshest within group); terminal after; tie by runId", () => {
  const runs = [
    { runId: "t_fresh", agentId: "s", terminal: true, updatedAt: iso(11) },
    { runId: "live_old", agentId: "s", terminal: false, updatedAt: iso(9) },
    { runId: "live_new", agentId: "s", terminal: false, updatedAt: iso(10, 30) },
    { runId: "live_tie_b", agentId: "s", terminal: false, updatedAt: iso(9) },
    { runId: "t_old", agentId: "s", terminal: true, updatedAt: iso(8) },
  ];
  const [lane] = app.boardLanes(runs);
  assert.deepEqual(lane.runs.map((r) => r.runId),
    ["live_new", "live_old", "live_tie_b", "t_fresh", "t_old"],
    "live runs first (freshest, then runId tie-break), terminal runs last (freshest first)");
});

test("BOARD R6 UNKNOWN: unknown/empty/absent identities merge into ONE explicit lane pinned last, never hidden", () => {
  const runs = [
    { runId: "u1", agentId: "unknown", state: "running", terminal: false, updatedAt: iso(12) },
    { runId: "u2", agentId: "", state: "completed", terminal: true, updatedAt: iso(11) },
    { runId: "u3", state: "failed", terminal: true, updatedAt: iso(10) }, // agentId absent
    { runId: "r1", agentId: "alpha", state: "running", terminal: false, updatedAt: iso(9) },
  ];
  const lanes = app.boardLanes(runs);
  assert.equal(lanes.length, 2, "one real seat lane + ONE unknown lane (merged, never split)");
  const last = lanes[lanes.length - 1];
  assert.equal(last.agentId, app.BOARD_UNKNOWN_LANE);
  assert.equal(last.isUnknown, true);
  assert.equal(last.runs.length, 3, "all three unknown-identity runs kept visible (not hidden)");
  assert.equal(lanes[0].agentId, "alpha");
  // The unknown lane is pinned last even when it is the FRESHEST activity.
  assert.ok(last.latestMs >= lanes[0].latestMs, "precondition: unknown lane is fresher, yet still last");
});

test("BOARD R6 SOURCE: the unknown lane is named and carries the data-limit note (not a real seat)", () => {
  const js = readAsset("app.js");
  assert.match(js, /"unknown seats"/, "the lane has an explicit human name");
  assert.match(js, /not a real seat — identity not registry-verified or the seat was removed/,
    "the header states the data limitation");
  // It never takes a palette slot: the track class is only added for real seats.
  assert.match(js, /lane\.isUnknown \? "" : " seat-"/);
});

test("BOARD ROBUST: malformed runs dropped; unparseable updatedAt sorts oldest; empty/absent input → []", () => {
  assert.deepEqual(app.boardLanes([]), []);
  assert.deepEqual(app.boardLanes(null), []);
  assert.deepEqual(app.boardLanes([{ state: "running" }]), [], "no usable runId → dropped");
  const lanes = app.boardLanes([
    { runId: "ok", agentId: "alpha", terminal: false, updatedAt: iso(9) },
    { runId: "bad_ts", agentId: "beta", terminal: false, updatedAt: "not-a-date" },
    { runId: "bad_ts2", agentId: "beta", terminal: false },
  ]);
  assert.deepEqual(lanes.map((l) => l.agentId), ["alpha", "beta"],
    "a lane with no parseable updatedAt (latestMs -1) orders after any real one; tie → agentId");
  assert.equal(lanes[1].latestMs, -1);
  // Within the beta lane the parseable-timestamp run is absent (both bad) — the
  // tie breaks by runId, deterministic.
  assert.deepEqual(lanes[1].runs.map((r) => r.runId), ["bad_ts", "bad_ts2"]);
});

// =====================================================================
// R3/R7) DENSE CARD + HONESTY LINES
// =====================================================================

test("BOARD TAIL: runIdTail keeps short ids whole, ellipsis-prefixes long ones", () => {
  assert.equal(app.runIdTail("run_ab"), "run_ab");
  const long = "run_20261003094617447bqyhql";
  assert.equal(app.runIdTail(long), "…" + long.slice(-10), "long ids show the last 10 chars, ellipsis-prefixed");
  assert.equal(app.runIdTail(null), "");
  assert.equal(app.runIdTail(42), "");
  assert.equal(app.runIdTail("abcdefghijklmnop", 4), "…" + "mnop");
  assert.equal(app.runIdTail("abc", 0), "abc", "non-positive keep degrades to default, keeps short id");
});

test("BOARD R1 SCOPE: boardScopeLabel mirrors the list scope (active / preset / custom / degenerate)", () => {
  const fmt = (ms) => `L(${ms})`;
  assert.equal(app.boardScopeLabel({ scope: "active" }), "active");
  assert.equal(app.boardScopeLabel(null), "active");
  assert.equal(app.boardScopeLabel(app.historyPresetMode("24h", 10_000_000_000)), "last 24h");
  assert.equal(app.boardScopeLabel({ scope: "history", fromMs: 100, toMs: 200 }, fmt), "L(100) – L(200)");
  assert.equal(app.boardScopeLabel({ scope: "history" }, fmt), "history", "degenerate history collapses, never arbitrary text");
});

test("BOARD R7 TRUNCATION: notice only when truncated; matched vs returned; malformed counts degrade bounded", () => {
  assert.equal(app.boardTruncationNotice({ truncated: false, matchedCount: 137, returnedCount: 100 }), "");
  assert.equal(app.boardTruncationNotice(null), "");
  assert.equal(app.boardTruncationNotice({}), "");
  assert.equal(app.boardTruncationNotice({ truncated: true, matchedCount: 137, returnedCount: 100 }),
    "window truncated — matched 137 runs, showing 100");
  assert.equal(app.boardTruncationNotice({ truncated: true }),
    "window truncated — list is bounded", "malformed counts still say truncated, nothing raw");
  assert.equal(app.boardTruncationNotice({ truncated: true, matchedCount: "x", returnedCount: 3 }),
    "window truncated — list is bounded");
});

test("BOARD R7 CAVEAT: single-source standing sentence (app.js constant; NOT duplicated in HTML)", () => {
  const js = readAsset("app.js");
  const html = readAsset("index.html");
  assert.ok(app.BOARD_IDLE_CAVEAT.length > 0);
  assert.match(app.BOARD_IDLE_CAVEAT, /^[A-Z].*\.$/, "one plain-English sentence");
  assert.ok(!app.BOARD_IDLE_CAVEAT.includes("\n"));
  assert.ok(!html.includes("No runs in this window"), "the sentence lives ONLY in app.js (no HTML duplicate)");
  assert.match(js, /els\.boardCaveat\.textContent = BOARD_IDLE_CAVEAT/, "rendered from the constant");
});

// =====================================================================
// R9) THE FIVE RENDER STATES
// =====================================================================

test("BOARD R9 STATES: normal / loading / empty / error / stale-data-plus-error", () => {
  const r1 = { runId: "run_a", agentId: "alpha", state: "running", terminal: false, updatedAt: T0 };
  // normal — fresh data → lanes render.
  const ready = app.boardViewState({ runs: [r1], runsFresh: true });
  assert.equal(ready.status, "ready");
  assert.equal(ready.lanes.length, 1);
  // loading — a mode switch cleared the list; the first response is pending.
  assert.deepEqual(app.boardViewState({ runs: [], runsFresh: null }), { status: "loading" });
  // empty — the window genuinely returned zero runs.
  assert.deepEqual(app.boardViewState({ runs: [], runsFresh: true }), { status: "empty" });
  // error — the refresh failed with NO current data (missing/unparseable
  // responses reduce here: an unparseable body throws in fetchJson).
  assert.deepEqual(app.boardViewState({ runs: [], runsFresh: false }), { status: "error" });
  // stale-data-plus-error — refresh failed, the last good lanes STAY on screen.
  const stale = app.boardViewState({ runs: [r1], runsFresh: false });
  assert.equal(stale.status, "stale");
  assert.equal(stale.lanes.length, 1, "last good data is preserved, not cleared");
});

test("BOARD R9 STATUS TEXT: closed-set bounded messages; unknown status → empty", () => {
  for (const st of ["loading", "empty", "error", "stale"]) {
    assert.ok(app.boardStatusText(st).length > 0, `${st} has a bounded message`);
  }
  assert.equal(app.boardStatusText("ready"), "", "ready renders lanes, not a status line");
  assert.equal(app.boardStatusText("garbage"), "");
  assert.equal(app.boardStatusText(null), "");
});

// =====================================================================
// R1/R2/R3) HTML + WIRING CONTRACTS
// =====================================================================

test("BOARD R1 HTML: list/board toggle buttons in the mode bar (type=button, no scope-attr collisions)", () => {
  const html = readAsset("index.html");
  const bar = html.match(/<div id="mode-bar"[\s\S]*?<\/div>/);
  assert.ok(bar, "mode bar present");
  for (const v of ["list", "board"]) {
    const btn = html.match(new RegExp(`<button[^>]*data-view="${v}"[^>]*>`));
    assert.ok(btn, `data-view=${v} button exists`);
    assert.match(btn[0], /type="button"/);
    assert.doesNotMatch(btn[0], /data-preset|data-mode/, "view buttons are not scope controls");
  }
  assert.match(html, /data-default-mode="active"/, "active remains the declared default scope");
});

test("BOARD R1 HTML: board container slots exist; the caveat element starts empty", () => {
  const html = readAsset("index.html");
  for (const id of ["board", "board-scope", "board-truncated", "board-caveat", "board-status", "board-lanes"]) {
    assert.ok(html.includes(`id="${id}"`), `#${id} present`);
  }
  const caveat = html.match(/<p id="board-caveat"[^>]*>([\s\S]*?)<\/p>/);
  assert.ok(caveat);
  assert.equal(caveat[1].trim(), "", "caveat text is filled from the app.js constant, not hardcoded");
  assert.match(html, /id="board"[^>]*hidden/, "board starts hidden (list is the default view)");
});

test("BOARD R1 WIRING: switching views is presentation-only — no refetch, no window reset", () => {
  const js = readAsset("app.js");
  const body = fnBody(js, "switchView");
  assert.match(body, /state\.view = view/, "only the presentation flag changes");
  assert.doesNotMatch(body, /refreshRuns|fetchJson|setRunsMode|runsQuery|runsEpoch|selectedRunId/,
    "a view switch never fetches, never changes mode/epoch, never touches selection");
  // The toggle is wired addEventListener-only (CSP: no inline handlers).
  assert.match(js, /querySelectorAll\("\[data-view\]"\)/);
  assert.match(js, /addEventListener\("click", \(\) => switchView\(state, btn\.dataset\.view\)\)/);
  // Both surfaces render from the SAME committed data on every commit path.
  assert.match(js, /function renderRunsSurfaces\(state\) \{\s*\n\s*renderRunList\(state\);\s*\n\s*renderBoard\(state\);/,
    "the single commit path renders list AND board");
});

test("BOARD R2 DATA: app.js still speaks ONLY /api/runs + /api/activity; exactly one direct fetch", () => {
  const js = readAsset("app.js");
  const endpoints = [...new Set([...js.matchAll(/\/api\/([a-z]+)/g)].map((m) => m[1]))];
  assert.deepEqual([...endpoints].sort(), ["activity", "runs"], "no new endpoint anywhere in the client");
  const direct = js.match(/await fetch\(/g) || [];
  assert.equal(direct.length, 1, "the single direct fetch remains fetchJson — the board adds none");
});

test("BOARD R3 WIRING: cards are real buttons reusing selectRun; pills + lane names carry TEXT", () => {
  const js = readAsset("app.js");
  const card = fnBody(js, "boardCardNode");
  assert.match(card, /createElement\("button"\)/, "a card is a real <button> (keyboard focusable, Enter opens)");
  assert.match(card, /card\.type = "button"/);
  assert.match(card, /selectRun\(state, r\.runId\)/, "click reuses the existing detail path — no new navigation");
  assert.match(card, /const pill = statePill\(r\.state\)/, "state renders through the TEXT-bearing pill helper");
  assert.match(card, /aria-label/, "the accessible name carries the full runId + facts");
  const lane = fnBody(js, "boardLaneNode");
  assert.match(lane, /name\.textContent = lane\.isUnknown \? "unknown seats" : lane\.agentId/,
    "identity is carried by the seat NAME text, never color-only");
});

// =====================================================================
// R8) ACCESSIBILITY HARD PINS
// =====================================================================

test("BOARD R8 A11Y CSS: visible focus style on cards; no motion introduced", () => {
  const css = readAsset("styles.css");
  assert.match(css, /\.board-card:focus-visible\s*\{[^}]*outline/,
    "keyboard focus on a card is visibly styled");
  assert.doesNotMatch(css, /transition|animation|@keyframes/i,
    "the dashboard stays motion-free (board adds none)");
  // Terminal de-emphasis must not lower text contrast: no opacity anywhere in
  // the board section (contrast is preserved structurally, not via alpha).
  assert.ok(css.indexOf(".board") > 0, "board section exists");
  assert.doesNotMatch(css.slice(css.indexOf(".board")), /opacity/,
    "no opacity tricks on board text");
});

test("BOARD R8 A11Y CONTRAST: every text pair the board renders measures >= 4.5:1 (WCAG AA)", () => {
  const css = readAsset("styles.css");
  const text = cssVar(css, "text");
  const muted = cssVar(css, "muted");
  const surface = cssVar(css, "surface");
  const warn = cssVar(css, "warn");
  const pairs = [
    [text, surface, "lane names / live card ids (--text on --surface)"],
    [muted, surface, "counts / caveat / terminal ids (--muted on --surface)"],
    [warn, surface, "truncation + stale lines (--warn on --surface)"],
  ];
  for (const [fg, bg, what] of pairs) {
    const ratio = contrast(fg, bg);
    assert.ok(ratio >= 4.5, `${what}: ${ratio.toFixed(2)}:1 >= 4.5:1`);
  }
  // The state pills the cards carry: every closed-set fg/bg pair is AA too.
  for (const st of app.FILTER_STATES) {
    const fg = cssVar(css, `${st}-fg`);
    const bg = cssVar(css, `${st}-bg`);
    const ratio = contrast(fg, bg);
    assert.ok(ratio >= 4.5, `pill ${st}: ${ratio.toFixed(2)}:1 >= 4.5:1`);
  }
});

test("BOARD R8 A11Y NON-TEXT: seat track colors + focus outline >= 3:1 against the surface", () => {
  const css = readAsset("styles.css");
  const surface = cssVar(css, "surface");
  for (const hex of app.BOARD_PALETTE) {
    const ratio = contrast(hex, surface);
    assert.ok(ratio >= 3, `seat track ${hex}: ${ratio.toFixed(2)}:1 >= 3:1 (non-text)`);
  }
  const accent = cssVar(css, "accent");
  assert.ok(contrast(accent, surface) >= 3, "focus outline accent >= 3:1");
});


// ── 0045 §1.4：explicit（车道+角色组合）run 的独立泳道 ────────────────────────

test("boardLanes 0045：explicit run 进自己的 lane/role 泳道（不占接线席位泳道）；alias 注解随席位", () => {
  const runs = [
    { runId: "run_a", agentId: "coder_low", state: "completed", terminal: true },
    { runId: "run_b", agentId: "coder_low", state: "completed", terminal: true, resolvedFrom: "explicit", laneId: "glm-flash", roleId: "researcher" },
    { runId: "run_c", agentId: "researcher", state: "completed", terminal: true, resolvedFrom: "alias", laneId: "glm-flash", roleId: "researcher" },
  ];
  const lanes = app.boardLanes(runs);
  const keys = lanes.map((l) => l.agentId);
  assert.ok(keys.includes("coder_low"), "接线席位泳道仍在");
  assert.ok(keys.includes("glm-flash/researcher"), "explicit 泳道=lane/role");
  assert.ok(keys.includes("researcher"), "alias 注解 run 随席位泳道（H1 注解不执行）");
  const explicitLane = lanes.find((l) => l.agentId === "glm-flash/researcher");
  assert.equal(explicitLane.isExplicit, true);
  assert.deepEqual(explicitLane.runs.map((r) => r.runId), ["run_b"]);
  const wiringLane = lanes.find((l) => l.agentId === "coder_low");
  assert.deepEqual(wiringLane.runs.map((r) => r.runId), ["run_a"], "explicit run 不占接线席位泳道");
});

test("boardLanes 0045：explicit 字段残缺（缺 laneId/roleId）→ 回落席位泳道不炸", () => {
  const runs = [
    { runId: "run_x", agentId: "coder_low", state: "completed", terminal: true, resolvedFrom: "explicit", laneId: null },
  ];
  const lanes = app.boardLanes(runs);
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].agentId, "coder_low");
  assert.equal(lanes[0].isExplicit, false);
});
