// test/isolation-infra/ownerDashboardV2Workers.test.js
//
// Batch 143a (decision 0131 A3): the /v2 Workers page and the worker side panel.
//
// Fixture discipline (the batch's rule): every interface-shaped value the front end reads is the
// SERVER's real output, never a hand-written object posing as one.
//   - the list rows and attention items are the real /api/workers and /api/attention bodies: a snapshot
//     (the shape ownerReadModel.snapshot produces) goes through the real server (selectOwnerWorkers,
//     deriveOwnerAttention and the DTO whitelists);
//   - the side panel body is projectWorkerDetail's real output for fixture transcripts (delivery
//     events, verification outcomes, decisions, final answers), with only the Git proof injected.
// Hand-written values appear only as inputs of the server (snapshot rows, transcript events) and for
// inputs a real server never sends (malformed fragments, a feed answer for the wrong run).
//
// Sections:
//   W  list     fragment <-> filters, search, default range, the two groups, review groups, rounds
//   D  panel    the detail feed (A -> B -> A), progress axes, Deliverable, Brief
//   B  blobs    the image store: every blob URL is revoked, late answers create none
//   K  keys     arrow keys, Esc, outside click
//   V  views    the DOM builders, run against a tiny in-memory DOM
//   G  guards   CSP, closed request set, one fetch, brief reading, no motion
//
// Deterministic and dependency-free: no network, no browser, no runtime, no Git.

import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createOwnerDashboardServer } from "../../src/ownerDashboardServer.js";
import { projectWorkerDetail } from "../../src/application/ownerWorkerDetail.js";
import * as api from "../../src/owner-dashboard/v2/api.js";
import * as model from "../../src/owner-dashboard/v2/model.js";
import * as workers from "../../src/owner-dashboard/v2/workers.js";
import * as detail from "../../src/owner-dashboard/v2/detail.js";
import * as artifacts from "../../src/owner-dashboard/v2/artifacts.js";
import * as i18n from "../../src/owner-dashboard/v2/i18n.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const V2 = join(HERE, "..", "..", "src", "owner-dashboard", "v2");
const readV2 = (name) => readFileSync(join(V2, name), "utf8");
/** Code without // and block comments (the sources hold no "//" inside a string). */
const codeOf = (name) => readV2(name).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// ===== the real server, driven without a socket =====

function drive(handler, { method = "GET", url = "/", headers = {} } = {}) {
  const req = { method, url, headers: { ...headers } };
  const state = { statusCode: 200, headers: {}, body: "" };
  const res = {
    setHeader(k, v) { state.headers[String(k).toLowerCase()] = v; },
    writeHead(status) { state.statusCode = status; },
    write(c) { state.body += typeof c === "string" ? c : Buffer.from(c).toString("utf8"); },
    end(c) { if (c !== undefined) this.write(c); },
  };
  return Promise.resolve(handler(req, res)).then(() => ({ status: state.statusCode, headers: state.headers, body: state.body }));
}

const makeServer = (extra = {}) => createOwnerDashboardServer({
  runDir: "/server/owned/runs",
  workspaceRoot: "/server/owned/ws",
  knownAgentIds: ["coder_low"],
  env: {},
  getOwnerRunsFn: async () => ({ runs: [], returnedCount: 0, matchedCount: 0, truncated: false }),
  getOwnerActivityFn: async () => ({}),
  nowFn: () => 1_000_000,
  ...extra,
});

// ===== time and snapshot rows (inputs of the server) =====

const GEN = "2026-11-26T10:42:18.000Z";
const GEN_MS = Date.parse(GEN);
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(GEN_MS - ms).toISOString();
const COMMIT = (ch) => ch.repeat(40);
/** A commit with no repeated digits at its start, so "from the start" and "from the middle" differ. */
const MIXED_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const NONE = { status: "none", reason: null };

const snapProject = (slug, name = slug) => ({ slug, name, repo: "available", branchesObservedAt: GEN, consultRecords: "available" });

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
    lastHeartbeatAt: null,
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
const snapLive = (runId, over = {}) => snapRun(runId, {
  state: "running", terminal: false, liveness: "progress", stage: "active", terminalAt: null, startedAt: ago(10 * MIN), lastEffectAt: ago(MIN), ...over,
});
const snapDelivery = (over = {}) => ({
  settlement: { status: "settled", reason: "delivery_settled" },
  commit: COMMIT("c"),
  changedCount: 11,
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

/** The three read routes of one publication, exactly as the browser receives them. */
async function chain(snapshot, now = GEN_MS) {
  const readModel = { async refresh() {}, snapshot: (args) => ({ ...snapshot, generatedAt: new Date(args.now).toISOString() }) };
  const s = makeServer({ createReadModelFn: () => readModel, nowFn: () => now });
  assert.equal(await s.refreshNow(), "ready");
  const get = async (url) => {
    const r = await drive(s.handler, { url, headers: { authorization: `Bearer ${s.token}` } });
    assert.equal(r.status, 200, url);
    return JSON.parse(r.body);
  };
  return {
    overview: await get("/api/overview"),
    workers: await get("/api/workers"),
    attention: await get("/api/attention"),
    get,
    server: s,
  };
}

// ===== the Workers shop: a snapshot with every list situation =====
//
//   running   run_quiet  (silent 40m, an open "silent" item) · run_mid (12m without progress) · run_fresh (20s)
//             a delivery review of 3 seats: sol + astra have answered, kimi is still running
//             run_s1, run_s2 are still Starting
//   finished  run_rev     awaiting the Lead 3h (and a split review: consult_split) · run_unres awaiting the Lead 3h
//             run_cont    round 2 of run_root, delivery waiting (30m) · run_fail (failed) · run_stop (stopped) · run_done
//   outside   run_old_done (finished 2 days ago, nothing to settle) · run_root (rejected 2 days ago)

function shopSnapshot() {
  const runs = [
    snapLive("run_quiet", { title: "Migrate orders table", startedAt: ago(50 * MIN), lastEffectAt: ago(40 * MIN), quietSince: ago(40 * MIN), quietSinceSeq: 138, liveness: "silent" }),
    snapLive("run_mid", { laneId: "opus", agentId: "opus", title: "Refactor payment module", startedAt: ago(30 * MIN), lastEffectAt: ago(12 * MIN) }),
    snapLive("run_fresh", { laneId: "opus", agentId: "opus", title: "Add pagination", startedAt: ago(20 * MIN), lastEffectAt: ago(20_000) }),
    snapLive("run_kimi", { taskType: "delivery_review", laneId: "kimi", agentId: "kimi", title: "Delivery review: order export", startedAt: ago(6 * MIN), lastEffectAt: ago(5 * MIN) }),
    snapRun("run_sol", { taskType: "delivery_review", laneId: "sol", agentId: "sol", title: "Delivery review: order export", startedAt: ago(45 * MIN), terminalAt: ago(40 * MIN), terminalSeq: 12 }),
    snapRun("run_astra", { taskType: "delivery_review", laneId: "astra", agentId: "astra", title: "Delivery review: order export", startedAt: ago(35 * MIN), terminalAt: ago(30 * MIN), terminalSeq: 14 }),
    snapLive("run_s1", { taskType: "research", laneId: "deepseek-flash", agentId: "deepseek-flash", title: "Warm up", startedAt: ago(20_000), stage: "starting", lastEffectAt: null }),
    snapLive("run_s2", { taskType: "image", laneId: "sol", agentId: "sol", title: "Hero image", startedAt: ago(2 * MIN), stage: "starting", lastEffectAt: null }),
    snapRun("run_rev", { title: "Order export", startedAt: ago(5 * HOUR), terminalAt: ago(4 * HOUR), deliveryRequested: true, delivery: snapDelivery({ commit: COMMIT("a"), settledAt: ago(3 * HOUR), settledSeq: 7 }) }),
    snapRun("run_unres", { title: "Rate limiter", startedAt: ago(6 * HOUR), terminalAt: ago(5 * HOUR), deliveryRequested: true, delivery: snapDelivery({ commit: MIXED_COMMIT, settledAt: ago(3 * HOUR), settledSeq: 9 }) }),
    snapRun("run_root", { title: "Search index", startedAt: ago(2 * DAY + HOUR), terminalAt: ago(2 * DAY), deliveryRequested: true, delivery: snapDelivery({ commit: COMMIT("d"), acceptance: { status: "rejected", decidedAt: ago(2 * DAY), decidedSeq: 3 } }) }),
    snapRun("run_cont", { title: "Please fix the review notes", lineageRootRunId: "run_root", parentRunId: "run_root", startedAt: ago(2 * HOUR), terminalAt: ago(HOUR), deliveryRequested: true, delivery: snapDelivery({ commit: COMMIT("e"), settledAt: ago(30 * MIN), settledSeq: 11 }) }),
    snapRun("run_fail", { title: "Broke", state: "failed", startedAt: ago(2 * HOUR), terminalAt: ago(30 * MIN), terminalSeq: 90, failure: { category: "provider_error", code: "backend_error" } }),
    snapRun("run_stop", { title: "Stopped by hand", state: "aborted", startedAt: ago(2 * HOUR), terminalAt: ago(HOUR) }),
    snapRun("run_done", { title: "Pagination research", taskType: "research", laneId: "deepseek-flash", agentId: "deepseek-flash", startedAt: ago(4 * HOUR), terminalAt: ago(3 * HOUR) }),
    snapRun("run_old_done", { title: "Long gone", startedAt: ago(3 * DAY), terminalAt: ago(2 * DAY) }),
    snapRun("run_docs", { project: { slug: "docs-site", name: "docs-site" }, title: "Rewrite README", startedAt: ago(3 * HOUR), terminalAt: ago(2 * HOUR) }),
  ];
  const seats = [snapSeat("run_sol", "PASS"), snapSeat("run_astra", "FIX_FIRST"), snapSeat("run_kimi", null)];
  return snapshotOf({
    runs,
    consults: [snapConsult({ consultId: "consult_order", reviewedRunId: "run_rev", seats })],
    projects: [snapProject("shop-api"), snapProject("docs-site")],
  });
}

let shopOnce = null;
const getShop = () => (shopOnce ??= chain(shopSnapshot()));

const listOf = async (view = workers.emptyView(), { refMs = GEN_MS, bodies = null, startingOpen = false } = {}) => {
  const b = bodies ?? await getShop();
  return workers.buildWorkers({ overview: b.overview, workers: b.workers, attention: b.attention }, { refMs, view, startingOpen });
};
const idsOf = (entries) => entries.map((entry) => (entry.kind === "group" ? `group:${entry.cards.map((card) => card.runId).join("+")}` : entry.card.runId));
const cardOf = (vm, runId) => {
  for (const group of [vm.running, vm.finished]) {
    for (const entry of group.entries) {
      const card = entry.kind === "group" ? entry.cards.find((c) => c.runId === runId) : entry.card.runId === runId ? entry.card : undefined;
      if (card !== undefined) return card;
    }
  }
  return vm.starting.cards.find((c) => c.runId === runId);
};

// =====================================================================
// W) THE LIST
// =====================================================================

test("W1 the view state and the fragment restore each other: filters, search and the open run; token fragment first", () => {
  const view = { project: "shop-api", lane: "glm-pro", type: "code", status: "running", health: "silent", q: "a3f9", run: "run_quiet" };
  const hash = "#workers?project=shop-api&lane=glm-pro&type=code&status=running&health=silent&q=a3f9&run=run_quiet";
  assert.equal(workers.formatWorkersHash(view), hash, "the canonical order: filters, search, the open run");
  assert.deepEqual(workers.parseWorkersHash(hash), view);
  // The spelling of the brief ("#workers&project=x&lane=y") reads the same; writing is always canonical.
  assert.deepEqual(workers.parseWorkersHash("#workers&project=shop-api&lane=glm-pro"), { ...workers.emptyView("shop-api"), lane: "glm-pro" });
  assert.deepEqual(model.parseHash("#workers&project=shop-api"), { page: "workers", project: "shop-api", section: null });
  // Every state survives refresh / back / copy: write -> read -> write is a fixed point.
  const views = [
    workers.emptyView(),
    workers.emptyView("docs-site"),
    { ...workers.emptyView(), lane: "kimi", status: "starting" },
    { ...workers.emptyView(), type: "delivery_review", health: "process_only", run: "run_sol" },
    { ...workers.emptyView(), q: "run_2026 a+b%c" },
    { ...workers.emptyView("shop-api"), q: "e".repeat(8), run: "run-1_B" },
  ];
  for (const v of views) {
    const written = workers.formatWorkersHash(v);
    assert.deepEqual(workers.parseWorkersHash(written), v, written);
    assert.equal(workers.formatWorkersHash(workers.parseWorkersHash(written)), written, `fixed point ${written}`);
  }
  assert.equal(workers.formatWorkersHash(workers.emptyView()), "#workers");
  assert.deepEqual(workers.parseWorkersHash("#workers"), workers.emptyView());
  // Only the Workers page has this state; a closed value or a plain id is required for each key.
  for (const other of ["#overview?lane=x", "#attention?project=shop-api&run=run_1", "", "#", undefined, null, "#nope?lane=x", `#token=${"a".repeat(64)}`]) {
    assert.deepEqual(workers.parseWorkersHash(other), workers.emptyView(), String(other));
  }
  const bad = "#workers?project=-x&lane=a%20b&type=nope&status=zzz&health=ok&run=..%2Fx&q=%00&nope=1";
  assert.deepEqual(workers.parseWorkersHash(bad), workers.emptyView(), "unknown keys and values outside their closed set are not state");
  assert.deepEqual(workers.parseWorkersHash("#workers?lane=glm-pro&lane=kimi&type=code&type=research"), { ...workers.emptyView(), lane: "glm-pro", type: "code" }, "of a repeated key the first counts");
  assert.deepEqual(workers.parseWorkersHash("#workers?lane=a%20b&lane=kimi"), workers.emptyView(), "even when the first one is not valid: a repeated key is decided once");
  assert.equal(workers.parseWorkersHash(`#workers?q=${"x".repeat(65)}`).q, "", "an over-long search is no search");
  assert.equal(workers.formatWorkersHash({ ...workers.emptyView(), lane: "a b", type: "nope", q: "  spaced  " }), "#workers?q=spaced", "writing drops what would not read back, and trims the search");
  assert.equal(workers.hasFilters(workers.emptyView()), false);
  assert.equal(workers.hasFilters({ ...workers.emptyView(), run: "run_1" }), false, "the open run is not a filter");
  assert.equal(workers.hasFilters({ ...workers.emptyView(), q: "x" }), true);
  // app.js takes the token fragment BEFORE it reads this state.
  const app = codeOf("app.js");
  assert.ok(app.indexOf("resolveToken(") < app.indexOf("parseWorkersHash("), "token fragment first, then the Workers state");
  assert.ok(app.indexOf("resolveToken(") < app.indexOf("canonical"), "the fragment is cleared before it is canonicalized");
});

test("W2 the row DTO: the current delivery commit (canonical id, no path) and the continuation round — nothing else new", async () => {
  const { workers: body } = await getShop();
  const row = (id) => body.workers.find((r) => r.runId === id);
  assert.equal(row("run_rev").delivery.commit, COMMIT("a"));
  assert.deepEqual(Object.keys(row("run_rev").delivery).sort(), ["acceptance", "branchPresent", "changedCount", "commit", "settlement", "verification"], "exactly these keys: a file COUNT but no path, no settle time, no reverify chain");
  assert.equal(row("run_rev").delivery.changedCount, 11);
  assert.deepEqual(row("run_sol").consult, { groupId: "shop-api:consult_order", seatsIn: 2, seatsTotal: 3, q1: "PASS" }, "a seat that has answered carries its own verdict");
  assert.deepEqual(row("run_astra").consult.q1, "FIX_FIRST");
  assert.equal(row("run_kimi").consult.q1, null, "a seat still running has none");
  assert.equal(row("run_fail").delivery, null, "a run with no delivery has no summary");
  assert.deepEqual(row("run_rev").round, { number: 1, complete: true });
  assert.deepEqual(row("run_cont").round, { number: 2, complete: true }, "a continuation counts its rounds the way the detail does");
  const keys = Object.keys(row("run_rev")).sort();
  assert.deepEqual(keys, ["attentionIds", "consult", "delivery", "failure", "laneKey", "lastEffectAt", "liveness", "project", "quietSince", "roleId", "round", "runId", "stage", "startedAt", "state", "subtitle", "taskType", "terminalAt", "title"].sort());
  // A commit that is not a canonical id never reaches the wire.
  const odd = await chain(snapshotOf({ runs: [snapRun("run_odd", { deliveryRequested: true, delivery: snapDelivery({ commit: "not-a-commit" }) })] }));
  assert.equal(odd.workers.workers[0].delivery.commit, null);
  // A chain that leaves the snapshot says so (the card then reads "Round ≥ N").
  const gone = await chain(snapshotOf({ runs: [snapRun("run_orphan", { parentRunId: "run_gone", lineageRootRunId: "run_gone" })] }));
  assert.deepEqual(gone.workers.workers[0].round, { number: 2, complete: false });
  assert.ok(!/\\|worktree|\.wao-worktrees|repoRoot/i.test(JSON.stringify(body)), "no path of any kind in the rows");
});

test("W3 search by run number or commit hash: prefix of the hash (any length, any case), part of the run number; nothing else", async () => {
  const ids = async (q) => {
    const vm = await listOf({ ...workers.emptyView(), q });
    return [...vm.running.entries, ...vm.finished.entries].flatMap((e) => (e.kind === "group" ? e.cards : [e.card])).map((c) => c.runId).concat(vm.starting.cards.map((c) => c.runId)).sort();
  };
  assert.deepEqual(await ids("aaaaaaaa"), ["run_rev"], "the short hash as the card shows it");
  assert.deepEqual(await ids(COMMIT("a")), ["run_rev"], "the full hash");
  assert.deepEqual(await ids("AAAA"), ["run_rev"], "case does not matter");
  assert.deepEqual(await ids("0123"), ["run_unres"]);
  assert.deepEqual(await ids("0123456789ABCDEF0123"), ["run_unres"], "a longer prefix, upper case");
  assert.deepEqual(await ids("456789abcdef"), [], "a commit is matched from its start, not from its middle");
  assert.deepEqual(await ids("run_unres"), ["run_unres"]);
  assert.deepEqual(await ids("RUN_FRESH"), ["run_fresh"]);
  assert.deepEqual(await ids("_stop"), ["run_stop"], "a part of the run number");
  assert.deepEqual(await ids("aaaaaaaab"), [], "a hash that is not (a prefix of) a commit finds nothing");
  const everything = await ids("run_");
  assert.ok(everything.length >= 14, "the run-number part matches every listed run");
  const vm = await listOf({ ...workers.emptyView(), q: "zzzz" });
  assert.equal(vm.empty, "filtered");
  assert.equal(vm.matched, 0);
  assert.equal(vm.total, (await getShop()).workers.workers.length);
});

test("W4 default range (the server's selectOwnerWorkers): unfinished, unsettled of any age, finished within 24h — a run outside it still opens, marked", async () => {
  const bodies = await getShop();
  const listed = new Set(bodies.workers.workers.map((r) => r.runId));
  for (const id of ["run_quiet", "run_s1", "run_rev", "run_unres", "run_cont", "run_fail", "run_done", "run_docs"]) assert.ok(listed.has(id), `${id} is in the default range`);
  for (const id of ["run_old_done", "run_root"]) assert.ok(!listed.has(id), `${id} is outside it`);
  const note = async (run, extra = {}) => (await listOf({ ...workers.emptyView(), run, ...extra })).open;
  assert.deepEqual(await note("run_old_done"), { runId: "run_old_done", note: "outOfRange", project: null, seq: null }, "directly linked, no filter, list not cut: it is outside the default range — the panel opens and says so");
  assert.deepEqual((await note("run_root")).note, "outOfRange");
  assert.deepEqual((await note("run_quiet")).note, null, "a listed run needs no note");
  assert.deepEqual((await note("run_quiet", { lane: "opus" })).note, "filtered", "listed but hidden by the filters: says that instead");
  assert.equal((await listOf()).open, null, "nothing open, no note");
  // The list was cut at its cap: absence proves nothing, so no claim is made.
  const cut = await listOf({ ...workers.emptyView(), run: "run_old_done" }, { bodies: { ...bodies, workers: { ...bodies.workers, truncated: true } } });
  assert.deepEqual([cut.open.note, cut.open.runId], [null, "run_old_done"]);
  assert.ok(!(await listOf({ ...workers.emptyView(), run: "run_old_done" })).sequence.includes("run_old_done"), "an unlisted run is not in the arrow-key order");
});

test("W5 the two groups (real rows): Running = associated item first, then the longest without progress; Starting is one line, never 'queued'; Finished = unsettled first, then newest end; failed and stopped stay", async () => {
  const vm = await listOf();
  assert.deepEqual(idsOf(vm.running.entries), ["run_quiet", "run_mid", "group:run_astra+run_kimi+run_sol", "run_fresh"],
    "run_quiet has an open silent item; then 12m, 5m (the quietest live seat of the review), 20s without progress");
  assert.equal(vm.running.count, 6, "four entries, the review counts its three seats");
  assert.deepEqual(idsOf(vm.finished.entries), ["run_cont", "run_rev", "run_unres", "run_fail", "run_stop", "run_docs", "run_done"],
    "unsettled (waiting 30m / 3h / 3h) by newest end, then the rest by newest end — failed and stopped are in the list");
  assert.equal(vm.finished.count, 7);
  assert.equal(vm.starting.count, 2, "the Starting runs are a count and a line");
  assert.deepEqual(vm.starting.cards.map((c) => c.runId), ["run_s2", "run_s1"], "listed under the line, the one that has been starting longest first");
  assert.ok(!idsOf(vm.running.entries).includes("run_s1") && !idsOf(vm.finished.entries).includes("run_s1"), "no Starting run among the cards");
  assert.equal(vm.starting.open, false);
  assert.ok(!vm.sequence.includes("run_s1"), "collapsed Starting runs are not in the arrow-key order");
  assert.deepEqual(vm.sequence, ["run_quiet", "run_mid", "run_astra", "run_kimi", "run_sol", "run_fresh", "run_cont", "run_rev", "run_unres", "run_fail", "run_stop", "run_docs", "run_done"], "the visible order, review seats together");
  const starting = await listOf({ ...workers.emptyView(), status: "starting" });
  assert.equal(starting.starting.open, true, "asking for the Starting ones shows them");
  assert.deepEqual(starting.sequence.sort(), ["run_s1", "run_s2"]);
  // Card facts as the rows carry them.
  assert.equal(cardOf(vm, "run_quiet").tone, "amber");
  assert.equal(cardOf(vm, "run_quiet").glyph, "▲");
  assert.equal(cardOf(vm, "run_quiet").associated, true);
  assert.equal(cardOf(vm, "run_fresh").tone, "quiet");
  assert.equal(cardOf(vm, "run_rev").tone, "red");
  assert.equal(cardOf(vm, "run_rev").unsettled, true);
  assert.equal(cardOf(vm, "run_done").glyph, "✓");
  assert.equal(cardOf(vm, "run_stop").glyph, "■");
  assert.equal(cardOf(vm, "run_fail").tone, "amber");
  assert.equal(cardOf(vm, "run_quiet").runningMs, 50 * MIN, "elapsed counts to the publication time");
  assert.equal(cardOf(vm, "run_quiet").progressAgoMs, 40 * MIN);
  assert.equal(cardOf(vm, "run_done").endedAgoMs, 3 * HOUR);
  assert.deepEqual(cardOf(vm, "run_rev").delivery, { commit: "aaaaaaaa", changedCount: 11, verification: "passed", decision: "awaiting", problem: null });
  assert.deepEqual([cardOf(vm, "run_sol").q1, cardOf(vm, "run_astra").q1, cardOf(vm, "run_kimi").q1], ["PASS", "FIX_FIRST", null], "a seat card knows its own verdict");
  assert.equal(cardOf(vm, "run_fail").failure, "backend_error");
  // A run with no real work yet sorts by when it started.
  const lone = await chain(snapshotOf({ runs: [snapLive("run_a", { lastEffectAt: null, startedAt: ago(30 * MIN) }), snapLive("run_b", { lastEffectAt: ago(10 * MIN), startedAt: ago(40 * MIN) })] }));
  const loneVm = workers.buildWorkers(lone, { refMs: GEN_MS, view: workers.emptyView() });
  assert.deepEqual(idsOf(loneVm.running.entries), ["run_a", "run_b"], "30m since its start without any work ranks before 10m since the last real work");
  assert.equal(cardOf(loneVm, "run_a").progressAgoMs, null, "no progress yet is said as such, not as 0");
  // An associated item outranks the wait: a worker with an open item sits above one that has gone longer without
  // progress but has none (run_old_quiet has done no real work for 3h, yet nothing flags it: its quiet clock is fresh).
  const assoc = await chain(snapshotOf({ runs: [
    snapLive("run_flagged", { startedAt: ago(2 * HOUR), lastEffectAt: ago(35 * MIN), quietSince: ago(35 * MIN), liveness: "silent" }),
    snapLive("run_old_quiet", { startedAt: ago(3 * HOUR), lastEffectAt: null, quietSince: ago(MIN) }),
  ] }));
  assert.deepEqual(assoc.workers.workers.map((r) => [r.runId, r.attentionIds.length > 0]).sort(), [["run_flagged", true], ["run_old_quiet", false]], "fixture: only run_flagged has an open item");
  assert.deepEqual(idsOf(workers.buildWorkers(assoc, { refMs: GEN_MS, view: workers.emptyView() }).running.entries), ["run_flagged", "run_old_quiet"], "the associated worker first, whatever the wait");
});

test("W6 review groups and rounds (real rows): the seats of one review are ONE group whose head says how many seats are in; a continuation says which round, 'at least' when the chain is cut", async () => {
  const vm = await listOf();
  const group = vm.running.entries.find((entry) => entry.kind === "group");
  assert.ok(group, "the delivery review is a group");
  assert.deepEqual(group.cards.map((c) => c.lane), ["astra", "kimi", "sol"], "its seats, in lane order — sol and astra have ended, kimi has not, and they stay together");
  assert.deepEqual([group.seatsIn, group.seatsTotal], [2, 3], "the head: two of three seats in (answered AND ended)");
  assert.equal(group.type, "delivery_review");
  assert.equal(group.finished, false, "the group lives in Running while any seat has not ended");
  assert.equal(vm.finished.entries.some((e) => e.kind === "group"), false, "and is not also listed under Finished");
  assert.deepEqual(group.cards.map((c) => c.outcome), ["completed", null, "completed"], "each seat card keeps its own state");
  // When the last seat ends, the group moves to Finished as one entry.
  const doneSnap = shopSnapshot();
  const kimi = doneSnap.runs.find((r) => r.runId === "run_kimi");
  Object.assign(kimi, { state: "completed", terminal: true, liveness: "terminal", stage: "terminal", terminalAt: ago(MIN), lastEffectAt: ago(MIN) });
  doneSnap.consults[0].seats[2] = snapSeat("run_kimi", "PASS");
  const doneVm = workers.buildWorkers(await chain(doneSnap), { refMs: GEN_MS, view: workers.emptyView() });
  assert.ok(doneVm.finished.entries.some((e) => e.kind === "group" && e.seatsIn === 3 && e.seatsTotal === 3), "all three seats in: the group is Finished");
  assert.ok(!doneVm.running.entries.some((e) => e.kind === "group"));
  // Rounds.
  const bodies = await getShop();
  assert.deepEqual(cardOf(vm, "run_cont").round, { number: 2, complete: true });
  assert.equal(cardOf(vm, "run_rev").round, null, "a first round carries no mark");
  const orphan = await chain(snapshotOf({ runs: [snapRun("run_orphan", { parentRunId: "run_gone", lineageRootRunId: "run_gone", title: "Fix" })] }));
  const orphanVm = workers.buildWorkers(orphan, { refMs: GEN_MS, view: workers.emptyView() });
  assert.deepEqual(cardOf(orphanVm, "run_orphan").round, { number: 2, complete: false });
  assert.equal(cardOf(vm, "run_cont").title, "Search index", "a continuation card carries the lineage root's title...");
  assert.equal(cardOf(vm, "run_cont").subtitle, "Please fix the review notes", "...and its own first line as the subtitle");
  assert.ok(bodies.attention.decide.some((item) => item.kind === "consult_split"), "the split review is a real Needs-you item behind these rows");
});

// =====================================================================
// D) THE SIDE PANEL
// =====================================================================

const T0 = GEN_MS - 8 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

function builder(runId, agentId = "glm-pro") {
  const events = [];
  let seq = 0;
  let clock = T0;
  const b = {
    events,
    runId,
    clock(ms) { clock = ms; return b; },
    add(type, payload = {}) {
      seq += 1;
      events.push({ ...payload, seq, ts: iso(clock), type, runId, agentId });
      return b;
    },
  };
  return b;
}

function head(b, { at = T0, deliveryRequested = false, prompt = "# Migrate orders table\nThe task text.", roleId = "coder", laneId = "glm-pro", taskType, continuation = null } = {}) {
  b.clock(at).add("run.background_submitted", {
    background: true,
    cwd: "/fixture/repo",
    deliveryRequested,
    ...(continuation ? { continuation: true, parentRunId: continuation.parentRunId, rootRunId: continuation.rootRunId } : {}),
  });
  b.add("run.state_change", { from: null, to: "pending", reason: "background_spawned" });
  b.clock(at + 1000).add("run.started", {
    backend: "claude-code",
    cwd: "/fixture/repo",
    worktreePath: `/fixture/repo/.wao-worktrees/${b.runId}`,
    worktreeBranch: `wao/${b.runId}`,
    model: { id: "glm-5.3" },
    laneId,
    roleId,
    resolvedFrom: "explicit",
    ...(taskType ? { taskType } : {}),
  });
  if (prompt !== null) b.clock(at + 2000).add("prompt.sent", { prompt });
}

function working(b, at) {
  b.clock(at).add("session.created", { backend: "claude-code", backendSessionId: "proc_4242", serveUrl: null });
  b.add("run.submitted", {});
  b.add("run.state_change", { from: "pending", to: "submitted", reason: "spawned" });
  b.clock(at + 10).add("run.state_change", { from: "submitted", to: "running", reason: "first_event" });
}

const say = (b, at, text) => b.clock(at).add("run.event", { kind: "message", role: "assistant", parts: [{ type: "text", text }] });

function terminal(b, at, state = "completed") {
  const fact = { completed: "run.completed", failed: "run.error", aborted: "run.aborted" }[state];
  b.clock(at).add(fact, state === "failed" ? { phase: "wait", error: "boom" } : {});
  b.clock(at).add("run.state_change", { from: "running", to: state, reason: state });
}

const FILES = ["src/orders/migrate.js", "src/orders/legacy.js", "docs/notes.md"];

function deliveryRef(runId, { commit = COMMIT("c"), files = FILES, verification } = {}) {
  return {
    schemaVersion: 1,
    kind: "git_commit",
    runId,
    baseCommit: COMMIT("0"),
    deliveryCommit: commit,
    branch: `wao/${runId}`,
    worktreePath: `/fixture/repo/.wao-worktrees/${runId}`,
    changedFiles: files,
    verification: verification ?? { status: "pending", commands: ["npm test"], verifiedCommit: commit, results: [] },
    acceptance: { status: "pending", reviewerType: "lead_agent" },
    integration: { status: "pending", targetCommit: null },
  };
}

function verifiedRef(runId, status, opts = {}) {
  const commit = opts.commit ?? COMMIT("c");
  const ok = { index: 0, command: "npm test", exitCode: 0, timedOut: false, durationMs: 4321, stdoutBytes: 12, stderrBytes: 0, stdoutTail: "", stderrTail: "" };
  const verification = {
    passed: { status, commands: ["npm test"], results: [ok], verifiedCommit: commit },
    failed: { status, commands: ["npm test"], results: [{ ...ok, exitCode: 1, durationMs: 777 }], verifiedCommit: commit, failureCode: "command_failed", failedPhase: "assertion", failedCommandIndex: 0 },
    unavailable: { status, unavailableReason: "no runnable verification", commands: [], results: [], verifiedCommit: commit },
  }[status];
  return deliveryRef(runId, { ...opts, verification });
}

/** A coder run that finished, delivered a commit and (optionally) got its verification outcome and a decision. */
function deliveredEvents(runId, { status = "passed", decision = null, files = FILES, commit = COMMIT("c"), verified = true, continuation = null, headOver = {} } = {}) {
  const b = builder(runId);
  head(b, { deliveryRequested: true, continuation, ...headOver });
  working(b, T0 + 3000);
  say(b, T0 + 4000, "I implemented everything and all tests pass.");
  terminal(b, T0 + 5000);
  b.clock(T0 + 6000).add("run.delivery_created", { delivery: deliveryRef(runId, { files, commit }) });
  if (verified) b.clock(T0 + 7000).add(`run.delivery_verification_${status}`, { delivery: verifiedRef(runId, status, { files, commit }) });
  if (decision) {
    b.clock(T0 + 8000).add(`run.delivery_${decision}`, {
      delivery: { ...verifiedRef(runId, "passed", { files, commit }), acceptance: { status: decision, reviewerType: "lead_agent" } },
      deliveryCommit: commit,
      reason: "lead decision",
    });
  }
  return b.events;
}

/** The injected Git proof: per-file line counts (what createDeliveryProver hands back after it proved the commit). */
const proveOk = async ({ changedFiles }) => ({ ok: true, stats: new Map(changedFiles.map((file, i) => [file, { added: 10 + i, deleted: i, binary: false }])) });
const proveGone = async () => ({ ok: false, reason: "git" });

/** The /api/worker body the server answers: status fields + projectWorkerDetail's real DTO. */
async function bodyOf({ run, events, runs = [run], consults = [], prove = proveOk, now = GEN_MS }) {
  const snapshot = snapshotOf({ runs, consults });
  const dto = await projectWorkerDetail({
    run, snapshot, runsById: new Map(runs.map((r) => [r.runId, r])), events, now, env: {}, repoRoot: "/fixture/repo", proveDelivery: prove,
  });
  return { status: "ready", generatedAt: GEN, ...dto };
}

const panelOf = (body, note = null) => detail.buildSidebar({
  feed: { runId: body.runId, epoch: 1, phase: "ready", body, problem: null }, open: { runId: body.runId, note }, nowMs: GEN_MS,
});

/** A finished coder run with a delivery, in the snapshot's shape. */
const finishedRow = (runId, over = {}) => snapRun(runId, {
  startedAt: iso(T0), terminalAt: iso(T0 + 5000), lastEffectAt: iso(T0 + 4000), lastVitalAt: iso(T0 + 5000), deliveryRequested: true, ...over,
});
const markOf = (steps) => Object.fromEntries(steps.map((step) => [step.id, step.mark]));

test("D1 the detail feed: A -> B -> A never shows an old answer — every selection is a new epoch and an older epoch's answer is dropped, even for the same run", async () => {
  const pending = [];
  const feed = detail.createDetailFeed({
    fetchDetail: (runId) => new Promise((resolve) => pending.push({ runId, resolve })),
    onChange: () => {},
  });
  const answer = (runId, title) => ({ ok: true, body: { status: "ready", generatedAt: GEN, runId, identity: { title } } });
  const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); };

  feed.open("run_a");      // request 0 (epoch 1)
  await settle();
  feed.open("run_b");      // request 1 (epoch 2)
  await settle();
  feed.open("run_a");      // request 2 (epoch 3): the same run again, a NEW selection
  await settle();
  assert.deepEqual(pending.map((p) => p.runId), ["run_a", "run_b", "run_a"], "each selection asks again");
  assert.equal(feed.get().body, null, "nothing of the earlier selections is on screen");
  pending[0].resolve(answer("run_a", "STALE A")); // the first A answers late
  await settle();
  assert.equal(feed.get().body, null, "the first A's answer belongs to a past epoch: dropped, though it is for the same run");
  assert.equal(feed.get().phase, "loading");
  pending[1].resolve(answer("run_b", "B"));
  await settle();
  assert.equal(feed.get().body, null, "B's answer is dropped too: B is not the open one");
  pending[2].resolve(answer("run_a", "FRESH A"));
  await settle();
  assert.equal(feed.get().phase, "ready");
  assert.equal(feed.get().body.identity.title, "FRESH A", "only the current selection's answer is applied");
  assert.equal(feed.get().runId, "run_a");

  // Switching away clears the old worker's data at once; a late answer of the old one changes nothing.
  feed.refresh();
  await settle();
  assert.equal(pending.length, 4, "a refresh asks again for the open worker");
  feed.open("run_c");
  assert.equal(feed.get().body, null, "no data of run_a under run_c");
  await settle();
  pending[3].resolve(answer("run_a", "late refresh of A"));
  await settle();
  assert.equal(feed.get().runId, "run_c");
  assert.equal(feed.get().body, null);
  // Closing is a new epoch as well.
  feed.close();
  pending[4].resolve(answer("run_c", "C"));
  await settle();
  assert.deepEqual([feed.get().runId, feed.get().phase, feed.get().body], [null, "idle", null]);
  // A refresh while a request of this epoch is in flight does not stack another one.
  feed.open("run_d");
  await settle();
  feed.refresh();
  feed.refresh();
  await settle();
  assert.equal(pending.length, 6);
  assert.equal(pending[5].runId, "run_d");
});

test("D2 the detail feed outcomes: ready, not found, not published yet, a failed refresh keeps the last good data, an answer for another run is no data", async () => {
  const run = finishedRow("run_x");
  const good = await bodyOf({ run, events: deliveredEvents("run_x") });
  const next = [];
  const feed = detail.createDetailFeed({ fetchDetail: () => new Promise((resolve) => next.push(resolve)), onChange: () => {} });
  const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); };
  const give = async (result) => { feed.refresh(); await settle(); next.shift()(result); await settle(); };
  feed.open("run_x");
  await settle();
  next.shift()({ ok: true, body: good });
  await settle();
  assert.equal(feed.get().phase, "ready");
  assert.equal(feed.get().body, good);
  await give({ ok: false, reason: "network" });
  assert.deepEqual([feed.get().phase, feed.get().problem], ["ready", "network"], "the refresh failed: the last good body stays, the problem is named");
  assert.equal(feed.get().body, good);
  assert.equal(detail.buildSidebar({ feed: feed.get(), open: { runId: "run_x", note: null }, nowMs: GEN_MS }).stale, true, "and the panel says the data is the one from before");
  await give({ ok: true, body: good });
  assert.equal(feed.get().problem, null, "a good refresh clears it");
  await give({ ok: false, reason: "notFound" });
  assert.deepEqual([feed.get().phase, feed.get().body], ["notFound", null], "the worker went away: no old data kept");
  await give({ ok: true, body: { status: "loading" } });
  assert.equal(feed.get().phase, "loading");
  await give({ ok: true, body: { status: "unavailable", staleSince: GEN } });
  assert.equal(feed.get().phase, "unavailable");
  // Inputs a real server never sends: another run's body, no identity, a rejected token.
  await give({ ok: true, body: { ...good, runId: "run_other" } });
  assert.deepEqual([feed.get().phase, feed.get().problem], ["error", "server"], "a body for another run is never shown");
  await give({ ok: true, body: { status: "ready", runId: "run_x" } });
  assert.equal(feed.get().phase, "error");
  await give({ ok: false, reason: "unauthorized" });
  assert.deepEqual([feed.get().phase, feed.get().problem], ["error", "unauthorized"]);
  const message = detail.buildSidebar({ feed: feed.get(), open: { runId: "run_x", note: "outOfRange" }, nowMs: GEN_MS });
  assert.deepEqual([message.kind, message.message, message.problem, message.note, message.ref], ["message", "error", "unauthorized", "outOfRange", "run_x"]);
  // The panel follows the fragment, not the feed: a feed still on the previous run reads as loading.
  assert.equal(detail.buildSidebar({ feed: feed.get(), open: { runId: "run_y", note: null }, nowMs: GEN_MS }).message, "loading");
  assert.equal(detail.buildSidebar({ feed: feed.get(), open: null, nowMs: GEN_MS }), null, "nothing open: no panel");
  feed.close();
  feed.open("run_x");
  assert.equal(feed.get().phase, "loading");
});

test("D3 the Run axis (real bodies): Starting -> Running -> Completed / Failed / Stopped, every state, nothing claimed that was not observed", async () => {
  const axisOf = async (row, events = null) => (panelOf(await bodyOf({ run: row, events: events ?? (() => { const b = builder(row.runId); head(b); return b.events; })() }))).axes.run;
  // Starting: the stage binding says so; over 30s is flagged; no stage binding is said as such.
  const starting = await axisOf(snapLive("run_st", { state: "pending", stage: "starting", stageSince: ago(45_000), lastEffectAt: null }));
  assert.deepEqual(markOf(starting.steps), { starting: "current", running: "future" });
  assert.deepEqual([starting.startingAgeMs, starting.startingSlow, starting.stageUnknown], [45_000, true, false]);
  const fresh = await axisOf(snapLive("run_st2", { state: "submitted", stage: "starting", stageSince: ago(10_000), lastEffectAt: null }));
  assert.deepEqual([fresh.startingAgeMs, fresh.startingSlow], [10_000, false], "10s is not flagged");
  const unbound = await axisOf(snapLive("run_st3", { state: "pending", stage: "stage_unknown", stageSince: null, lastEffectAt: null }));
  assert.deepEqual([markOf(unbound.steps), unbound.stageUnknown, unbound.startingAgeMs, unbound.startingSlow], [{ starting: "unknown", running: "future" }, true, null, false], "pending with no bound stage: Starting is NOT lit, it says 'stage unknown', and no start is made up");
  // Running.
  const running = await axisOf(snapLive("run_rn"));
  assert.deepEqual(markOf(running.steps), { starting: "done", running: "current" });
  assert.deepEqual([running.startingAgeMs, running.startingSlow], [null, false]);
  // Ended.
  const ended = (state, over = {}) => axisOf(finishedRow(`run_${state}`, { state, deliveryRequested: false, ...over }));
  assert.deepEqual(markOf((await ended("completed")).steps), { starting: "done", running: "done", completed: "done" });
  assert.deepEqual(markOf((await ended("failed")).steps), { starting: "done", running: "done", failed: "bad" }, "it did real work before it failed");
  assert.deepEqual(markOf((await ended("failed", { lastEffectAt: null })).steps), { starting: "done", running: "unknown", failed: "bad" }, "no work observed: Running is not claimed");
  assert.deepEqual(markOf((await ended("aborted")).steps), { starting: "done", running: "done", stopped: "ended" });
  assert.deepEqual(markOf((await ended("timed_out")).steps), { starting: "done", running: "done", timed_out: "bad" });
  // A state the transcript cannot tell.
  const unknown = await axisOf(snapRun("run_unk", { state: "unknown", terminal: false, stage: "stage_unknown", liveness: "unknown", terminalAt: null }));
  assert.deepEqual(markOf(unknown.steps), { starting: "unknown", running: "unknown" });
});

test("D4 the Delivery axis (real bodies): Commit -> Verify -> Awaiting Lead -> Adopted / Rejected, each state; a continuation says its round and which run it continues", async () => {
  const axisOf = async (row, events, runs) => (panelOf(await bodyOf({ run: row, events, runs: runs ?? [row] }))).axes;
  const delivered = (id, opts = {}, rowOver = {}) => axisOf(finishedRow(id, rowOver), deliveredEvents(id, opts));
  // Requested, ended, nothing committed yet.
  const bare = builder("run_bare");
  head(bare, { deliveryRequested: true });
  working(bare, T0 + 3000);
  terminal(bare, T0 + 5000);
  const before = (await axisOf(finishedRow("run_bare"), bare.events)).delivery;
  assert.deepEqual(markOf(before.steps), { commit: "current", verify: "future", awaiting: "future" }, "undecided: the axis stops at Awaiting Lead (the last step appears when the Lead has decided)");
  assert.equal(before.decision, null);
  // Committed, verification still running (no outcome event yet).
  const pending = (await delivered("run_pend", { verified: false })).delivery;
  assert.deepEqual(markOf(pending.steps), { commit: "done", verify: "current", awaiting: "future" });
  // Passed: waiting for the Lead, since the later of the end and the verification result.
  const passed = (await delivered("run_pass")).delivery;
  assert.deepEqual(markOf(passed.steps), { commit: "done", verify: "done", awaiting: "current" });
  assert.equal(passed.steps[1].detail, "passed");
  assert.equal(passed.decision, "awaiting");
  assert.equal(passed.awaitingForMs, GEN_MS - (T0 + 7000), "the wait is counted from the settle time to the publication time");
  assert.equal(passed.round, null, "a first round is not marked");
  // Failed / unavailable verification.
  assert.deepEqual(markOf((await delivered("run_vf", { status: "failed" })).delivery.steps), { commit: "done", verify: "bad", awaiting: "current" });
  assert.deepEqual(markOf((await delivered("run_vu", { status: "unavailable" })).delivery.steps), { commit: "done", verify: "bad", awaiting: "current" });
  // The Lead's decision.
  const adopted = (await delivered("run_ok", { decision: "accepted" })).delivery;
  assert.deepEqual(markOf(adopted.steps), { commit: "done", verify: "done", awaiting: "done", adopted: "done" });
  assert.equal(adopted.decision, "adopted");
  const rejected = (await delivered("run_no", { decision: "rejected" })).delivery;
  assert.deepEqual(markOf(rejected.steps), { commit: "done", verify: "done", awaiting: "done", rejected: "ended" });
  assert.equal(rejected.decision, "rejected");
  // Replaced by a later candidate without a decision.
  const superseded = (await delivered("run_sup", {}, { supersededByRunId: "run_next" })).delivery;
  assert.deepEqual(markOf(superseded.steps), { commit: "done", verify: "done", awaiting: "ended", superseded: "ended" });
  assert.deepEqual([superseded.decision, superseded.supersededBy], ["superseded", "run_next"]);
  // Round 2 continues round 1, which the Lead rejected.
  const first = finishedRow("run_r1", { delivery: snapDelivery({ acceptance: { status: "rejected", decidedAt: ago(2 * HOUR), decidedSeq: 3 } }) });
  const second = finishedRow("run_r2", { parentRunId: "run_r1", lineageRootRunId: "run_r1" });
  const cont = (await axisOf(second, deliveredEvents("run_r2", { continuation: { parentRunId: "run_r1", rootRunId: "run_r1" } }), [first, second])).delivery;
  assert.deepEqual(cont.round, { number: 2, complete: true, continues: "run_r1", continuesDecision: "rejected" });
  const cut = (await axisOf(finishedRow("run_r3", { parentRunId: "run_gone", lineageRootRunId: "run_gone" }), deliveredEvents("run_r3"))).delivery;
  assert.deepEqual([cut.round.number, cut.round.complete, cut.round.continues, cut.round.continuesDecision], [2, false, "run_gone", null], "a chain cut off by the snapshot is 'at least 2', and does not guess the parent's fate");
  // A run that asked for no delivery has no delivery axis at all.
  const plain = await axisOf(finishedRow("run_plain", { deliveryRequested: false }), (() => { const b = builder("run_plain"); head(b); working(b, T0 + 3000); terminal(b, T0 + 5000); return b.events; })());
  assert.equal(plain.delivery, null);
  assert.equal(plain.consult, null);
});

test("D5 the Review axis (real bodies): this seat's state and the whole group's 'N of M seats in' and whether it is complete", async () => {
  const seatRows = [finishedRow("run_sol", { deliveryRequested: false, taskType: "delivery_review" }), finishedRow("run_astra", { deliveryRequested: false, taskType: "delivery_review" }), snapLive("run_kimi", { taskType: "delivery_review" })];
  const seats = (kimi) => [snapSeat("run_sol", "PASS"), snapSeat("run_astra", "FIX_FIRST"), kimi];
  const events = (id) => { const b = builder(id); head(b, { prompt: "# Delivery review\nReview it.\n" }); working(b, T0 + 3000); return b.events; };
  const open = panelOf(await bodyOf({ run: seatRows[2], events: events("run_kimi"), runs: seatRows, consults: [snapConsult({ seats: seats(snapSeat("run_kimi", null)) })] })).axes.consult;
  assert.deepEqual([open.seatState, open.replied, open.seatsIn, open.seatsTotal, open.complete, open.reviewedRunId], ["running", false, 2, 3, false, "run_rev"]);
  const done = panelOf(await bodyOf({ run: seatRows[0], events: events("run_sol"), runs: seatRows, consults: [snapConsult({ seats: seats(snapSeat("run_kimi", "PASS")) })] })).axes.consult;
  assert.deepEqual([done.seatState, done.replied, done.seatsIn, done.complete], ["completed", true, 3, true]);
  // Completed without an answer is not "in"; the seat's state and its answer are separate facts.
  const mute = panelOf(await bodyOf({ run: seatRows[0], events: events("run_sol"), runs: seatRows, consults: [snapConsult({ seats: [snapSeat("run_sol", null, { runState: "completed", replied: false }), snapSeat("run_astra", "PASS")] })] })).axes.consult;
  assert.deepEqual([mute.seatState, mute.replied, mute.seatsIn, mute.seatsTotal, mute.complete], ["completed", false, 1, 2, false]);
  assert.equal(panelOf(await bodyOf({ run: seatRows[0], events: events("run_sol"), runs: seatRows, consults: [] })).axes.consult, null, "not a seat: no review axis");
});

test("D6 header and health (real bodies): title, type, lane, project, elapsed; liveness with the last progress and the last heartbeat; the default tab follows the state", async () => {
  const quiet = panelOf(await bodyOf({
    run: snapLive("run_hd", { liveness: "silent", title: "Migrate orders table", startedAt: ago(38 * MIN), lastEffectAt: ago(11 * MIN), lastHeartbeatAt: ago(4 * MIN), project: { slug: "shop-api", name: "Shop API" } }),
    events: (() => { const b = builder("run_hd"); head(b, { prompt: "# Migrate orders table\nbody" }); return b.events; })(),
  }));
  assert.deepEqual([quiet.kind, quiet.title, quiet.subtitle, quiet.type, quiet.lane, quiet.projectName, quiet.elapsedMs], ["detail", "Migrate orders table", null, "code", "glm-pro", "Shop API", 38 * MIN]);
  assert.deepEqual([quiet.health.word, quiet.health.tone, quiet.health.glyph, quiet.health.terminal], ["silent", "amber", "▲", false]);
  assert.deepEqual([quiet.health.progressAgoMs, quiet.health.heartbeatAgoMs], [11 * MIN, 4 * MIN], "two separate times, counted to the publication time");
  assert.equal(quiet.defaultTab, "activity", "still running opens on Activity");
  assert.equal(quiet.ref, "run_hd", "the reference carries the run number");
  assert.equal(detail.workerRef("run_hd", 137), "run_hd#0137", "and the event number when one is known");
  assert.equal(detail.workerRef("run_hd", 0), "run_hd");
  const calm = panelOf(await bodyOf({ run: snapLive("run_ok2"), events: (() => { const b = builder("run_ok2"); head(b); return b.events; })() }));
  assert.deepEqual([calm.health.word, calm.health.tone], ["progress", "gray"]);
  assert.equal(calm.health.heartbeatAgoMs, null, "no heartbeat on record: no time is made up");
  const noBeat = panelOf(await bodyOf({ run: snapLive("run_po", { liveness: "process_only" }), events: (() => { const b = builder("run_po"); head(b); return b.events; })() }));
  assert.deepEqual([noBeat.health.word, noBeat.health.tone], ["process_only", "amber"]);
  const done = panelOf(await bodyOf({ run: finishedRow("run_dn"), events: deliveredEvents("run_dn") }));
  assert.deepEqual([done.health.word, done.health.terminal, done.health.tone, done.defaultTab], ["completed", true, "gray", "deliverable"], "ended opens on Deliverable");
  assert.equal(done.elapsedMs, 5000, "an ended run's duration is start to end, not up to now");
  // The title of a continuation is the lineage root's, with this round's first line as the subtitle.
  const root = finishedRow("run_root2", { title: "Search index" });
  const next = finishedRow("run_next2", { title: "Please fix the notes", parentRunId: "run_root2", lineageRootRunId: "run_root2" });
  const cont = panelOf(await bodyOf({ run: next, events: deliveredEvents("run_next2"), runs: [root, next] }));
  assert.deepEqual([cont.title, cont.subtitle], ["Search index", "Please fix the notes"]);
  // Failure: the closed category / code the server derived; an isolation violation through the shared projection.
  const failB = builder("run_bad");
  head(failB, { deliveryRequested: true });
  working(failB, T0 + 3000);
  terminal(failB, T0 + 5000, "failed");
  failB.clock(T0 + 6000).add("run.isolation_violation", {
    code: "workdir_escape", reason: "file_written_physical_outside", destination: "main_checkout",
    reportedPath: "..\\escape\\a.txt", resolvedPath: "D:\\outside\\main\\a.txt", escapedAt: "D:\\outside\\link",
  });
  const failed = panelOf(await bodyOf({ run: finishedRow("run_bad", { state: "failed", failure: { category: "workdir_escape", code: "file_written_physical_outside" } }), events: failB.events }));
  assert.equal(failed.health.word, "failed");
  assert.equal(failed.health.tone, "amber");
  assert.equal(failed.health.failure.category, "workdir_escape");
  assert.deepEqual(failed.health.failure.isolation, {
    reason: "file_written_physical_outside", destination: "main_checkout", reportedPath: "..\\escape\\a.txt", resolvedPath: "D:\\outside\\main\\a.txt", escapedAt: "D:\\outside\\link",
  });
  assert.ok(failed.health.failure.evidence.length >= 1);
  assert.equal(done.health.failure, null, "no diagnosis for a run that did not fail");
});

test("D7 Deliverable, a code delivery (real body): the commit, its files, line counts, the verification with its commands — each marked system observed and bound to this commit", async () => {
  const run = finishedRow("run_code");
  const panel = panelOf(await bodyOf({ run, events: deliveredEvents("run_code") }));
  const d = panel.deliverable;
  assert.deepEqual([d.kind, d.state, d.reason], ["code", "bound", null]);
  assert.deepEqual(d.commit, { hash: COMMIT("c"), short: "cccccccc", source: "system_observed" });
  assert.deepEqual([d.files.total, d.files.collapsed, d.files.truncated, d.files.source], [3, false, false, "system_observed"]);
  assert.deepEqual(d.files.items, [
    { path: "src/orders/migrate.js", added: 10, deleted: 0, binary: false },
    { path: "src/orders/legacy.js", added: 11, deleted: 1, binary: false },
    { path: "docs/notes.md", added: 12, deleted: 2, binary: false },
  ]);
  assert.deepEqual([d.files.added, d.files.deleted], [33, 3], "added / deleted lines, summed over files that are all known");
  assert.deepEqual(
    [d.verification.status, d.verification.source, d.verification.boundCommit, d.verification.failure],
    ["passed", "system_observed", "cccccccc", null],
    "the result is the system's, and says which commit it is bound to",
  );
  assert.deepEqual(d.verification.commands, [{ index: 0, command: "npm test", ran: true, exitCode: 0, timedOut: false, durationMs: 4321 }]);
  assert.deepEqual(d.decision, { result: "awaiting", supersededBy: null, awaitingForMs: GEN_MS - (T0 + 7000) });
  assert.deepEqual(d.reviews, []);
  // Failed verification: which command, which phase.
  const failed = panelOf(await bodyOf({ run: finishedRow("run_vfail"), events: deliveredEvents("run_vfail", { status: "failed" }) })).deliverable.verification;
  assert.deepEqual([failed.status, failed.failure, failed.commands[0].exitCode], ["failed", { code: "command_failed", phase: "assertion", commandIndex: 0 }, 1]);
  // Not verifiable: the reason, no invented result.
  const unavailable = panelOf(await bodyOf({ run: finishedRow("run_vna"), events: deliveredEvents("run_vna", { status: "unavailable" }) })).deliverable.verification;
  assert.deepEqual([unavailable.status, unavailable.unavailableReason, unavailable.commands], ["unavailable", "no runnable verification", []]);
  // Committed, no verification outcome yet: the declared command, no result.
  const pending = panelOf(await bodyOf({ run: finishedRow("run_vpend"), events: deliveredEvents("run_vpend", { verified: false }) })).deliverable.verification;
  assert.deepEqual([pending.status, pending.commands.map((c) => [c.command, c.ran, c.exitCode])], ["pending", [["npm test", false, null]]]);
  // The object cannot be read any more: the transcript's facts are shown, the line counts are not invented.
  const gone = panelOf(await bodyOf({ run: finishedRow("run_gone2"), events: deliveredEvents("run_gone2"), prove: proveGone })).deliverable;
  assert.deepEqual([gone.kind, gone.state, gone.reason, gone.commit.short, gone.files.total], ["code", "unavailable", "git_read_failed", "cccccccc", 3]);
  assert.deepEqual([gone.files.items[0].added, gone.files.added], [null, null], "no counts, no sum");
  assert.equal(gone.verification.status, "passed", "the transcript's facts stay");
});

test("D8 the file list folds above 8 files: 8 is listed as it is, 9 and more sit behind a count; the list is capped honestly", async () => {
  assert.equal(detail.FILES_FOLD_AFTER, 8);
  const filesOf = async (n) => panelOf(await bodyOf({ run: finishedRow(`run_f${n}`), events: deliveredEvents(`run_f${n}`, { files: Array.from({ length: n }, (_, i) => `src/file${String(i).padStart(2, "0")}.js`) }) })).deliverable.files;
  const eight = await filesOf(8);
  assert.deepEqual([eight.total, eight.items.length, eight.collapsed], [8, 8, false]);
  const nine = await filesOf(9);
  assert.deepEqual([nine.total, nine.items.length, nine.collapsed], [9, 9, true]);
  const eleven = await filesOf(11);
  assert.deepEqual([eleven.total, eleven.items.length, eleven.collapsed], [11, 11, true]);
  assert.equal(eleven.items[10].path, "src/file10.js");
  const many = await filesOf(520);
  assert.deepEqual([many.total, many.items.length, many.truncated, many.collapsed], [520, 500, true, true], "520 files: the first 500 are listed, the total and the cut are stated");
  assert.deepEqual([many.added, many.deleted], [null, null], "no sum over a cut list");
  // A path the server withholds (not a repository path) stays withheld.
  const odd = panelOf(await bodyOf({ run: finishedRow("run_fodd"), events: deliveredEvents("run_fodd", { files: ["ok/a.js", "../escape.txt"] }) })).deliverable.files;
  assert.deepEqual(odd.items.map((i) => i.path), ["ok/a.js", "[path_withheld]"]);
});

test("D9 Deliverable, a review: one row per seat (lane, verdict), the split is marked; on the reviewed run the review sits next to the delivery", async () => {
  const seatRows = [finishedRow("run_sol", { deliveryRequested: false, taskType: "delivery_review", laneId: "sol", agentId: "sol" }), finishedRow("run_astra", { deliveryRequested: false, taskType: "delivery_review", laneId: "astra", agentId: "astra" }), snapLive("run_kimi", { taskType: "delivery_review", laneId: "kimi", agentId: "kimi" })];
  const quick = (id) => { const b = builder(id); head(b, { prompt: "# Delivery review\nReview it." }); working(b, T0 + 3000); return b.events; };
  const consultOf = (q1s, over = {}) => snapConsult({ seats: [snapSeat("run_sol", q1s[0]), snapSeat("run_astra", q1s[1]), snapSeat("run_kimi", q1s[2])], ...over });
  const seat = async (q1s, over, who = "run_sol") => panelOf(await bodyOf({ run: seatRows.find((r) => r.runId === who), events: quick(who), runs: seatRows, consults: [consultOf(q1s, over)] })).deliverable;
  const split = await seat(["PASS", "FIX_FIRST", null]);
  assert.deepEqual([split.kind, split.consultId, split.reviewedRunId, split.q1Declared, split.verdictsDiffer, split.anyFixFirst], ["consult", "consult_order", "run_rev", true, true, true]);
  assert.deepEqual(split.seats.map((s) => [s.lane, s.q1, s.runState, s.replied, s.runId, s.current]), [
    ["sol", "PASS", "completed", true, "run_sol", true],
    ["astra", "FIX_FIRST", "completed", true, "run_astra", false],
    ["kimi", null, "running", false, "run_kimi", false],
  ], "each seat: lane, verdict, state, and which one is this seat");
  assert.deepEqual(split.seats.map((s) => s.source), ["worker_reported", "worker_reported", "worker_reported"], "a verdict is the worker's word");
  const agree = await seat(["PASS", "PASS", "PASS"]);
  assert.deepEqual([agree.verdictsDiffer, agree.anyFixFirst], [false, false]);
  const allFix = await seat(["FIX_FIRST", "FIX_FIRST", "FIX_FIRST"]);
  assert.deepEqual([allFix.verdictsDiffer, allFix.anyFixFirst], [false, true], "all FIX_FIRST is not a split, but FIX_FIRST is there");
  const noQ1 = await seat(["PASS", "PASS", "PASS"], { q1Declared: false });
  assert.deepEqual([noQ1.q1Declared, noQ1.verdictsDiffer, noQ1.anyFixFirst], [false, null, null], "no verdict fields declared: no verdict claims");
  // On the reviewed run: the review beside the delivery (an earlier candidate's review is flagged).
  const reviewed = finishedRow("run_rev");
  const asReviewed = async (over) => panelOf(await bodyOf({ run: reviewed, events: deliveredEvents("run_rev"), runs: [reviewed, ...seatRows], consults: [consultOf(["PASS", "FIX_FIRST", "PASS"], over)] })).deliverable;
  const fresh = await asReviewed({ createdAt: ago(25 * MIN) });
  assert.equal(fresh.kind, "code");
  assert.equal(fresh.reviews.length, 1);
  assert.deepEqual([fresh.reviews[0].consultId, fresh.reviews[0].verdictsDiffer, fresh.reviews[0].anyFixFirst, fresh.reviews[0].afterCurrentDelivery], ["consult_order", true, true, true]);
  assert.deepEqual(fresh.reviews[0].seats.map((s) => [s.lane, s.q1]), [["sol", "PASS"], ["astra", "FIX_FIRST"], ["kimi", "PASS"]]);
  assert.equal(fresh.reviews[0].seats.every((s) => s.current === false), true, "none of them is the reviewed run itself");
  const early = await asReviewed({ createdAt: iso(T0) });
  assert.equal(early.reviews[0].afterCurrentDelivery, false, "a review made before this commit reviewed an earlier candidate");
});

test("D10 Deliverable, research and none: the answer text as sent, cut and said so when long; no deliverable is 'not observed' — never filled from what the assistant said", async () => {
  const researchRun = (id, over = {}) => finishedRow(id, { taskType: "research", deliveryRequested: false, ...over });
  const answerEvents = (id, text) => { const b = builder(id); head(b, { prompt: "# Pagination research\nLook it up." }); working(b, T0 + 3000); say(b, T0 + 4000, text); terminal(b, T0 + 5000); return b.events; };
  const short = panelOf(await bodyOf({ run: researchRun("run_rs"), events: answerEvents("run_rs", "Use keyset pagination.\nIt scales.") })).deliverable;
  assert.deepEqual([short.kind, short.answer.source, short.answer.text, short.answer.truncated], ["research", "worker_reported", "Use keyset pagination.\nIt scales.", false]);
  const long = "x".repeat(70_000);
  const cut = panelOf(await bodyOf({ run: researchRun("run_rl"), events: answerEvents("run_rl", long) })).deliverable;
  assert.deepEqual([cut.answer.truncated, cut.answer.keptChars, cut.answer.totalChars, cut.answer.text.length], [true, 65536, 70_000, 65536], "cut, and it says where");
  const silent = panelOf(await bodyOf({ run: researchRun("run_rz"), events: answerEvents("run_rz", "   ") })).deliverable;
  assert.deepEqual(silent, { kind: "none" }, "no answer text: nothing observed");
  // A coder that SAYS it committed, with no delivery event: nothing observed.
  const talker = builder("run_talk");
  head(talker, { deliveryRequested: true });
  working(talker, T0 + 3000);
  say(talker, T0 + 4000, "I committed everything and all tests pass. Delivery is done.");
  terminal(talker, T0 + 5000);
  const none = panelOf(await bodyOf({ run: finishedRow("run_talk"), events: talker.events }));
  assert.deepEqual(none.deliverable, { kind: "none" });
  assert.ok(!JSON.stringify(none).includes("I committed everything"), "the assistant's claim appears nowhere in the panel");
  assert.equal(none.axes.delivery.steps[0].mark, "current", "the delivery axis says the commit has not been seen");
  // A run that is still going has none yet either.
  assert.deepEqual(panelOf(await bodyOf({ run: snapLive("run_going"), events: (() => { const b = builder("run_going"); head(b); working(b, T0 + 3000); return b.events; })() })).deliverable, { kind: "none" });
});

test("D11 Deliverable, images: the image files with their index in the delivery; the wanted set binds commit AND index, only for a bound delivery on its tab", async () => {
  const files = ["assets/logo.png", "docs/readme.md", "assets/photo.JPG", "assets/pic.webp", "assets/icon.svg"];
  const run = finishedRow("run_img", { taskType: "image" });
  const panel = panelOf(await bodyOf({ run, events: deliveredEvents("run_img", { files, headOver: { taskType: "image" } }) }));
  const d = panel.deliverable;
  assert.deepEqual([d.kind, d.state], ["image", "bound"]);
  assert.deepEqual(d.images, [{ index: 0, path: "assets/logo.png" }, { index: 2, path: "assets/photo.JPG" }, { index: 3, path: "assets/pic.webp" }], "png / jpeg / webp only, each with its index in changedFiles (SVG is no image here)");
  assert.deepEqual(d.files.items.map((i) => i.path), files, "the whole file list is still there");
  const wanted = detail.imagesWanted(panel, "deliverable");
  assert.deepEqual(wanted, [
    { id: `run_img|${COMMIT("c")}|0`, runId: "run_img", commit: COMMIT("c"), fileIndex: 0 },
    { id: `run_img|${COMMIT("c")}|2`, runId: "run_img", commit: COMMIT("c"), fileIndex: 2 },
    { id: `run_img|${COMMIT("c")}|3`, runId: "run_img", commit: COMMIT("c"), fileIndex: 3 },
  ], "each image is bound to the delivery commit and to its index");
  assert.deepEqual(detail.imagesWanted(panel, "brief"), [], "another tab: no image is on screen");
  assert.deepEqual(detail.imagesWanted(panel, "activity"), []);
  assert.deepEqual(detail.imagesWanted(null, "deliverable"), []);
  assert.deepEqual(detail.imagesWanted({ kind: "message" }, "deliverable"), []);
  // A new candidate commit is a different image id: the old URL is not reused for it.
  const moved = panelOf(await bodyOf({ run, events: deliveredEvents("run_img", { files, commit: COMMIT("d"), headOver: { taskType: "image" } }) }));
  assert.ok(detail.imagesWanted(moved, "deliverable").every((w, i) => w.id !== wanted[i].id && w.commit === COMMIT("d")));
  // The delivery object is gone: nothing to fetch (an unavailable delivery is not asked for images).
  const gone = panelOf(await bodyOf({ run, events: deliveredEvents("run_img", { files, headOver: { taskType: "image" } }), prove: proveGone }));
  assert.equal(gone.deliverable.state, "unavailable");
  assert.deepEqual(detail.imagesWanted(gone, "deliverable"), []);
  // Code and research deliveries want none.
  assert.deepEqual(detail.imagesWanted(panelOf(await bodyOf({ run: finishedRow("run_c3"), events: deliveredEvents("run_c3", { files }) })), "deliverable"), []);
  // An image run with no delivery yet: no images, nothing claimed.
  const bare = panelOf(await bodyOf({ run: snapLive("run_ib", { taskType: "image" }), events: (() => { const b = builder("run_ib"); head(b, { taskType: "image" }); return b.events; })() }));
  assert.deepEqual([bare.deliverable.kind, detail.imagesWanted(bare, "deliverable")], ["none", []]);
});

test("D12 Brief: the bound brief text as sent; a missing brief is said to be missing; a long one says where it was cut", async () => {
  const withPrompt = (id, prompt) => { const b = builder(id); head(b, { prompt }); return b.events; };
  const present = panelOf(await bodyOf({ run: snapLive("run_b1"), events: withPrompt("run_b1", "# Migrate orders table\nStep 1.\nStep 2.") })).brief;
  assert.deepEqual(present, { present: true, text: "# Migrate orders table\nStep 1.\nStep 2.", truncated: false, keptChars: 38, totalChars: 38 });
  const missing = panelOf(await bodyOf({ run: snapLive("run_b2"), events: withPrompt("run_b2", null) })).brief;
  assert.deepEqual(missing, { present: false, text: "", truncated: false, keptChars: 0, totalChars: 0 });
  const long = panelOf(await bodyOf({ run: snapLive("run_b3"), events: withPrompt("run_b3", `# Long\n${"y".repeat(70_000)}`) })).brief;
  assert.deepEqual([long.present, long.truncated, long.keptChars, long.totalChars], [true, true, 65536, 70_007]);
});

// =====================================================================
// B) BLOBS AND THE REQUESTS THAT FILL THEM
// =====================================================================

const settle = () => new Promise((resolve) => setImmediate(resolve));

function storeRig(over = {}) {
  const loads = [];
  const created = [];
  const revoked = [];
  const changes = [];
  const store = artifacts.createImageStore({
    load: (spec) => new Promise((resolve, reject) => loads.push({ spec, resolve, reject })),
    createUrl: (blob) => { const url = `blob:fixture/${created.length}`; created.push({ blob, url }); return url; },
    revokeUrl: (url) => revoked.push(url),
    onChange: () => changes.push(1),
    ...over,
  });
  return { store, loads, created, revoked, changes };
}
const spec = (index) => ({ id: `run_i|${COMMIT("c")}|${index}`, runId: "run_i", commit: COMMIT("c"), fileIndex: index });
const PNG = (n = 1) => new Blob([new Uint8Array(n)], { type: "image/png" });

test("B1 image blob URLs: made when an image arrives, revoked the moment it is no longer wanted; a late answer makes none; created === revoked at the end", async () => {
  const rig = storeRig();
  rig.store.want([spec(0)]);
  assert.equal(rig.loads.length, 1);
  assert.deepEqual(rig.store.view(), { [spec(0).id]: { state: "loading", url: null } });
  rig.loads[0].resolve({ ok: true, blob: PNG() });
  await settle();
  assert.deepEqual(rig.created.map((c) => c.url), ["blob:fixture/0"]);
  assert.deepEqual(rig.store.view(), { [spec(0).id]: { state: "ready", url: "blob:fixture/0" } });
  assert.equal(rig.changes.length, 1, "the page is told once, to draw it");
  rig.store.want([spec(0)]);
  assert.equal(rig.loads.length, 1, "wanting what is already here asks for nothing");
  assert.deepEqual(rig.revoked, []);
  // Leaving the tab (nothing wanted any more): the URL is revoked at once.
  rig.store.want([]);
  assert.deepEqual(rig.revoked, ["blob:fixture/0"]);
  assert.equal(rig.store.size(), 0);
  // Two images; one stays, one goes (a new delivery commit has other ids).
  rig.store.want([spec(1), spec(2)]);
  rig.loads[1].resolve({ ok: true, blob: PNG() });
  rig.loads[2].resolve({ ok: true, blob: PNG() });
  await settle();
  assert.equal(rig.created.length, 3);
  rig.store.want([spec(2)]);
  assert.deepEqual(rig.revoked, ["blob:fixture/0", "blob:fixture/1"], "only the image that left is revoked");
  rig.store.release();
  assert.deepEqual(rig.revoked, ["blob:fixture/0", "blob:fixture/1", "blob:fixture/2"]);
  assert.equal(rig.created.length, rig.revoked.length, "every URL ever made has been revoked");
  assert.equal(rig.store.size(), 0);
});

test("B2 a late answer creates no URL: for an image that is no longer wanted, and for the same image asked again after it left (A -> B -> A)", async () => {
  const rig = storeRig();
  rig.store.want([spec(0)]);
  rig.store.want([]);                       // gone before the answer
  rig.loads[0].resolve({ ok: true, blob: PNG() });
  await settle();
  assert.equal(rig.created.length, 0, "nothing was made for an image nobody wants");
  assert.deepEqual(rig.store.view(), {});
  assert.equal(rig.changes.length, 0, "and the page is not told");
  // A -> B -> A: the first A request is a different entry from the second.
  rig.store.want([spec(0)]);                // load 1
  rig.store.want([spec(1)]);                // load 2 (A dropped)
  rig.store.want([spec(0)]);                // load 3: A again
  assert.deepEqual(rig.loads.slice(1).map((l) => l.spec.fileIndex), [0, 1, 0]);
  rig.loads[1].resolve({ ok: true, blob: PNG() });   // the OLD A answers
  rig.loads[2].resolve({ ok: true, blob: PNG() });   // B answers, not wanted
  await settle();
  assert.equal(rig.created.length, 0, "neither the old A nor the dropped B made a URL");
  rig.loads[3].resolve({ ok: true, blob: PNG() });   // the NEW A
  await settle();
  assert.deepEqual(rig.created.map((c) => c.url), ["blob:fixture/0"]);
  assert.deepEqual(Object.values(rig.store.view()).map((v) => v.state), ["ready"]);
  rig.store.release();
  assert.equal(rig.created.length, rig.revoked.length);
});

test("B3 a failed image is a failed entry (no URL, no throw); a rejected load too; release() on an empty store is fine", async () => {
  const rig = storeRig();
  rig.store.want([spec(0), spec(1)]);
  rig.loads[0].resolve({ ok: false, reason: "notFound" });
  rig.loads[1].reject(new Error("boom"));
  await settle();
  assert.deepEqual(Object.values(rig.store.view()), [{ state: "failed", url: null }, { state: "failed", url: null }]);
  assert.equal(rig.created.length, 0);
  rig.store.release();
  assert.deepEqual(rig.revoked, [], "nothing was made, nothing to revoke");
  storeRig().store.release();
  // With the browser's own functions: the URL resolves while it is wanted and not after.
  const { resolveObjectURL } = await import("node:buffer");
  const real = artifacts.createImageStore({
    load: () => Promise.resolve({ ok: true, blob: PNG(8) }),
    createUrl: (blob) => URL.createObjectURL(blob),
    revokeUrl: (url) => URL.revokeObjectURL(url),
    onChange: () => {},
  });
  real.want([spec(0)]);
  await settle();
  const url = real.view()[spec(0).id].url;
  assert.match(url, /^blob:/);
  assert.ok(resolveObjectURL(url) instanceof Blob, "alive while the image is on screen");
  real.want([]);
  assert.equal(resolveObjectURL(url), undefined, "gone the moment it is not");
});

test("B4 the image request: authenticated GET of the artifact route bound to commit and index, a blob back only for png / jpeg / webp; request() never takes the image route", async (t) => {
  const calls = [];
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const reply = (status, blob, throws = false) => async (url, init) => {
    calls.push({ url, init });
    if (throws) throw new TypeError("Failed to fetch http://x/?token=leak");
    return { status, ok: status >= 200 && status < 300, blob: async () => blob, json: async () => ({ ok: 1 }) };
  };
  const TOKEN = "a".repeat(64);
  const path = api.artifactPath({ runId: "run_i", commit: COMMIT("c"), fileIndex: 2 });
  assert.equal(path, `/api/artifact?runId=run_i&commit=${COMMIT("c")}&fileIndex=2`);
  globalThis.fetch = reply(200, PNG());
  const ok = await api.requestImage(path, TOKEN);
  assert.equal(ok.ok, true);
  assert.equal(ok.blob.type, "image/png");
  assert.equal(calls[0].url, path, "the token is never in the URL");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.match(calls[0].init.headers.accept, /image\/png/);
  assert.deepEqual([calls[0].init.method, calls[0].init.cache, calls[0].init.credentials, calls[0].init.referrerPolicy], ["GET", "no-store", "omit", "no-referrer"]);
  for (const type of ["image/jpeg", "image/webp"]) {
    globalThis.fetch = reply(200, new Blob([new Uint8Array(1)], { type }));
    assert.equal((await api.requestImage(path, TOKEN)).ok, true, type);
  }
  for (const type of ["image/svg+xml", "text/html", "application/json", ""]) {
    globalThis.fetch = reply(200, new Blob([new Uint8Array(1)], { type }));
    assert.deepEqual(await api.requestImage(path, TOKEN), { ok: false, reason: "server" }, `a ${type || "typeless"} answer is not an image`);
  }
  globalThis.fetch = reply(404, null);
  assert.deepEqual(await api.requestImage(path, TOKEN), { ok: false, reason: "notFound" });
  globalThis.fetch = reply(401, null);
  assert.deepEqual(await api.requestImage(path, TOKEN), { ok: false, reason: "unauthorized" });
  globalThis.fetch = reply(500, null);
  assert.deepEqual(await api.requestImage(path, TOKEN), { ok: false, reason: "server" });
  globalThis.fetch = reply(200, null, true);
  assert.deepEqual(await api.requestImage(path, TOKEN), { ok: false, reason: "network" }, "a network error never reflects its text");
  const before = calls.length;
  for (const bad of ["/api/overview", "/api/worker?runId=run_1", "/api/artifact", `/api/artifact?runId=run_i&commit=${COMMIT("c")}`, "/api/artifact?runId=../x&commit=" + COMMIT("c") + "&fileIndex=0"]) {
    await assert.rejects(() => api.requestImage(bad, TOKEN), /not one of the dashboard routes/, bad);
  }
  await assert.rejects(() => api.request(path, TOKEN), /not one of the dashboard routes/, "the JSON request never takes the image route");
  assert.equal(calls.length, before, "a refused path never reaches the network");
  // The detail route: JSON, 404 told apart from a server fault.
  globalThis.fetch = reply(200, null);
  assert.deepEqual(await api.request(api.workerPath("run_1"), TOKEN), { ok: true, body: { ok: 1 } });
  assert.equal(calls.at(-1).url, "/api/worker?runId=run_1");
  globalThis.fetch = reply(404, null);
  assert.deepEqual(await api.request(api.workerPath("run_1"), TOKEN), { ok: false, reason: "notFound" });
});

test("B5 the closed request set: each route has only its own query keys, each of a fixed shape; builders refuse the rest", () => {
  const C = COMMIT("c");
  const good = [
    "/api/overview", "/api/workers", "/api/workers?project=shop-api", "/api/attention", "/api/attention?project=shop-api",
    "/api/worker?runId=run_1", `/api/artifact?runId=run_1&commit=${C}&fileIndex=0`, `/api/artifact?runId=run-1_B&commit=${"f".repeat(64)}&fileIndex=1234567`,
  ];
  for (const path of good) assert.equal(api.isDataPath(path), true, path);
  const bad = [
    "/api/worker", "/api/worker?runId=", "/api/worker?runId=run_1&runId=run_2", "/api/worker?runId=run_1&x=1", "/api/worker?x=1", "/api/worker?runId=../x", "/api/worker?runId=run%201",
    "/api/worker?runId=-bad", "/api/worker/activity?runId=run_1", "/api/worker/event?runId=run_1&seq=1&part=output", `/api/worker?runId=${"a".repeat(129)}`,
    "/api/artifact", "/api/artifact?runId=run_1", `/api/artifact?runId=run_1&commit=${C}`, `/api/artifact?runId=run_1&commit=${C.toUpperCase()}&fileIndex=0`,
    `/api/artifact?runId=run_1&commit=${"c".repeat(39)}&fileIndex=0`, `/api/artifact?runId=run_1&commit=${C}&fileIndex=01`, `/api/artifact?runId=run_1&commit=${C}&fileIndex=-1`,
    `/api/artifact?runId=run_1&commit=${C}&fileIndex=12345678`, `/api/artifact?runId=run_1&commit=${C}&fileIndex=0&x=1`,
    "/api/overview?x=1", "/api/overview?", "/api/workers?project=", "/api/workers?project=-x", "/api/workers?project=a&project=b", "/api/workers?lane=x",
    "/api/runs", "/api/activity?runId=run_1", "/api/session?code=1", "/", "", "https://example.com/api/overview", "//example.com/api/overview", "/api/overview#x", null, undefined, 5,
  ];
  for (const path of bad) assert.equal(api.isDataPath(path), false, String(path));
  assert.equal(api.workersPath(), "/api/workers");
  assert.equal(api.workersPath("shop-api"), "/api/workers?project=shop-api");
  assert.equal(api.workerPath("run_1"), "/api/worker?runId=run_1");
  assert.throws(() => api.workersPath("bad slug"), /not one of the dashboard routes/);
  assert.throws(() => api.workerPath("a&b=c"), /not one of the dashboard routes/);
  assert.throws(() => api.artifactPath({ runId: "run_1", commit: "abc", fileIndex: 0 }), /not one of the dashboard routes/);
  assert.throws(() => api.artifactPath({ runId: "run_1", commit: C0(), fileIndex: -1 }), /not one of the dashboard routes/);
  function C0() { return COMMIT("c"); }
});

// =====================================================================
// K) KEYS AND CLICKS
// =====================================================================

test("K1 moving between workers: the arrow keys walk the visible order, Esc closes, text fields keep their keys, a click on the empty page closes", async () => {
  const vm = await listOf();
  const seq = vm.sequence;
  assert.equal(workers.neighborRun(seq, "run_quiet", 1), "run_mid");
  assert.equal(workers.neighborRun(seq, "run_mid", -1), "run_quiet");
  assert.equal(workers.neighborRun(seq, seq[0], -1), null, "up from the first: stay");
  assert.equal(workers.neighborRun(seq, seq.at(-1), 1), null, "down from the last: stay");
  assert.equal(workers.neighborRun(seq, "run_kimi", 1), "run_sol", "a review's seats are walked together, in their order");
  assert.equal(workers.neighborRun(seq, "run_old_done", 1), seq[0], "an open worker that is not in the list: down starts at the top");
  assert.equal(workers.neighborRun(seq, "run_old_done", -1), seq.at(-1), "up starts at the bottom");
  assert.equal(workers.neighborRun([], "run_x", 1), null);
  assert.equal(workers.neighborRun(undefined, "run_x", 1), null);
  const key = (extra) => workers.sidebarKeyAction({ key: "ArrowDown", tag: "BUTTON", ...extra });
  assert.equal(key({}), "next");
  assert.equal(key({ key: "ArrowUp" }), "prev");
  assert.equal(key({ key: "Escape" }), "close");
  assert.equal(key({ key: "Enter" }), null);
  assert.equal(key({ key: "Home" }), null);
  for (const tag of ["INPUT", "SELECT", "TEXTAREA", "input"]) {
    assert.equal(key({ tag }), null, `${tag}: the arrows belong to the field`);
    assert.equal(key({ tag, key: "ArrowUp" }), null);
    assert.equal(key({ tag, key: "Escape" }), "close", `${tag}: Esc still closes`);
  }
  assert.equal(key({ tag: "DIV", editable: true }), null, "an editable region keeps its arrows");
  for (const mod of ["alt", "ctrl", "meta", "shift"]) assert.equal(key({ [mod]: true }), null, `${mod} held`);
  // Clicks: only the empty page closes (the language switch in the top bar keeps it open; a card or a control acts on its own).
  assert.equal(workers.closesSidebar({}), true);
  assert.equal(workers.closesSidebar({ inSidebar: true }), false);
  assert.equal(workers.closesSidebar({ inTopbar: true }), false);
  assert.equal(workers.closesSidebar({ keep: true }), false);
  // The app wires exactly this: key handler on the document, preventDefault on a handled key, card focus after the move.
  const app = codeOf("app.js");
  assert.match(app, /document\.addEventListener\("keydown"[\s\S]*?sidebarKeyAction\(\{[\s\S]*?event\.preventDefault\(\)[\s\S]*?neighborRun\(state\.sequence, parseWorkersHash\(window\.location\.hash\)\.run, action === "next" \? 1 : -1\)/);
  assert.match(app, /state\.focusRun = next;\s*actions\.openWorker\(next\)/, "the move goes through the fragment (so back / copy-link follow it) and focuses the new card");
  assert.match(app, /document\.addEventListener\("click"[\s\S]*?closesSidebar\(\{ inSidebar: inside\("#sidebar"\), inTopbar: inside\("#topbar"\), keep: inside\("button, select, input, \[data-keep\]"\) \}\)\) actions\.closeWorker\(\)/);
  assert.match(app, /if \(state\.page !== "workers" \|\| state\.view\.run === null\) return;/, "nothing happens unless a worker is open");
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
    this.parent = null; this.className = ""; this.ownText = null; this.nodeType = 1; this.value = "";
  }
  get parentNode() { return this.parent; }
  get textContent() { return this.ownText !== null ? this.ownText : this.children.map((c) => c.textContent).join(""); }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  append(...nodes) {
    for (const node of nodes) {
      assert.ok(node instanceof FakeNode || node instanceof FakeText, `only nodes can be appended, got ${String(node)}`);
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    if (fakeDocument.activeElement !== null && this.contains(fakeDocument.activeElement)) fakeDocument.activeElement = null;
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
  fire(event, payload) { for (const fn of this.listeners.get(event) ?? []) fn({ type: event, target: this, ...payload }); }
  contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false; }
  closest(selector) {
    const tests = selector.split(",").map((s) => s.trim()).map((s) => (n) => (s.startsWith("#") ? n.attrs.get("id") === s.slice(1) : s.startsWith(".") ? n.className.split(" ").includes(s.slice(1)) : s.startsWith("[") ? n.attrs.has(s.slice(1, -1)) : n.tag === s));
    for (let n = this; n; n = n.parent) if (tests.some((t) => t(n))) return n;
    return null;
  }
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
};
const fakeSelection = { rangeCount: 0, isCollapsed: true, anchorNode: null };
globalThis.document = fakeDocument;
globalThis.window = { getSelection: () => fakeSelection };
after(() => { delete globalThis.document; delete globalThis.window; });

const { renderWorkersPage } = await import("../../src/owner-dashboard/v2/workersview.js");
const { renderSidebar } = await import("../../src/owner-dashboard/v2/sidebarview.js");
const { renderMain } = await import("../../src/owner-dashboard/v2/views.js");

const find = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const byClass = (root, cls) => find(root, (n) => n.className.split(" ").includes(cls));
const byTag = (root, tag) => find(root, (n) => n.tag === tag);
const region = (tag = "div") => { const node = new FakeNode(tag); fakeDocument.activeElement = null; return node; };
const recorder = () => {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); };
  return {
    calls,
    ...Object.fromEntries(["setFilter", "setQuery", "toggleStarting", "openWorker", "closeWorker", "setTab", "toggleFiles", "toggleImage", "copyWorkerRef", "navigate", "clearFilter"].map((n) => [n, rec(n)])),
  };
};
const SUI = (over = {}) => ({ tab: null, filesOpen: false, imageOpen: null, copy: null, ...over });
const pageOf = (vm, lang = "en", actions = recorder()) => { const root = region(); renderWorkersPage(root, vm, lang, actions); return { root, actions }; };
const cardsIn = (root) => byClass(root, "wcard-btn");
const cardByRun = (root, runId) => cardsIn(root).find((n) => n.getAttribute("data-fk") === `card:${runId}`);
const line = (card, n) => byClass(card, n === 1 ? "wcard-l1" : "wcard-l2")[0].textContent;

test("V1 the Workers page (real rows): two groups with counts, single-column cards of exactly two lines, words in both languages, no live output on a card", async () => {
  const vm = await listOf();
  const { root, actions } = pageOf(vm);
  assert.deepEqual(byClass(root, "section-title").map((n) => n.textContent), ["Running6", "Finished7"]);
  assert.deepEqual(byClass(root, "sort-hint").map((n) => n.textContent), ["longest without progress first", "unsettled first"]);
  const cards = cardsIn(root);
  assert.equal(cards.length, vm.sequence.length, "one card per listed worker (Starting ones are folded)");
  for (const card of cards) {
    assert.equal(byClass(card, "wcard-l1").length, 1);
    assert.equal(byClass(card, "wcard-l2").length, 1);
    assert.equal(card.children.length, 2, "exactly two lines");
    assert.equal(card.tag, "button");
    assert.equal(card.getAttribute("type"), "button");
  }
  // Line one: health symbol, title, type · lane, run number — left to right, the run number last.
  assert.equal(line(cardByRun(root, "run_quiet"), 1), "▲Migrate orders tableCodingglm-prorun_quiet", "symbol, title, then the type / lane / run number columns");
  assert.equal(line(cardByRun(root, "run_cont"), 1), "●Search indexRound 2Codingglm-prorun_cont", "a continuation says its round");
  // Line two, running: stage, running time, last progress, the worrying word.
  assert.equal(line(cardByRun(root, "run_quiet"), 2), "Running 50m · last progress 40m ago · silent");
  assert.equal(line(cardByRun(root, "run_fresh"), 2), "Running 20m · last progress just now");
  assert.equal(line(cardByRun(root, "run_kimi"), 2), "Running 6m · last progress 5m ago");
  // Line two, finished: how it ended, when, and what it delivered.
  assert.equal(line(cardByRun(root, "run_rev"), 2), "Done 4h ago · aaaaaaaa · 11 files · verify passed · awaiting Lead", "the commit, how many files, the verification, where the Lead stands");
  assert.equal(line(cardByRun(root, "run_fail"), 2), "Failed 30m ago · backend_error");
  assert.equal(line(cardByRun(root, "run_stop"), 2), "Stopped 1h ago");
  assert.equal(line(cardByRun(root, "run_done"), 2), "Done 3h ago");
  assert.equal(line(cardByRun(root, "run_sol"), 2), "Done 40m ago · PASS", "a seat that has answered says its verdict");
  assert.equal(line(cardByRun(root, "run_astra"), 2), "Done 30m ago · FIX_FIRST");
  assert.ok(byClass(cardByRun(root, "run_astra"), "tone-red").some((n) => n.textContent === "FIX_FIRST"), "FIX_FIRST is red and a word");
  // Review group: head with the seats count, the seat cards under it.
  const heads = byClass(root, "wgroup-head");
  assert.equal(heads.length, 1);
  assert.equal(heads[0].textContent, "Delivery review · Delivery review: order export2 of 3 seats in");
  assert.deepEqual(byClass(byClass(root, "wgroup")[0], "wcard-run").map((n) => n.textContent), ["run_astra", "run_kimi", "run_sol"]);
  // Starting: one line, closed; the Starting run is not a card.
  const disclosure = byClass(root, "disclosure")[0];
  assert.equal(disclosure.textContent, "2 starting");
  assert.equal(disclosure.getAttribute("aria-expanded"), "false");
  assert.equal(cardByRun(root, "run_s1"), undefined);
  assert.ok(!/queued/i.test(root.textContent), "never 'queued'");
  disclosure.click();
  assert.deepEqual(actions.calls.pop(), ["toggleStarting"]);
  const open = pageOf(await listOf(workers.emptyView(), { startingOpen: true })).root;
  assert.equal(byClass(open, "disclosure")[0].getAttribute("aria-expanded"), "true");
  assert.equal(line(cardByRun(open, "run_s1"), 2), "Starting <1m · no progress yet");
  assert.equal(line(cardByRun(open, "run_s2"), 2), "Starting 2m · no progress yet");
  // A card opens its worker.
  cardByRun(root, "run_mid").click();
  assert.deepEqual(actions.calls.pop(), ["openWorker", "run_mid"]);
  // Nothing scrolls on a card: no output / log / stream element anywhere in the list.
  assert.equal(find(root, (n) => /output|log|stream|tail|ticker/.test(n.className)).length, 0);
  // The same list in Chinese: only interface words change; titles, lanes, run numbers and hashes do not.
  const zh = pageOf(vm, "zh").root;
  assert.deepEqual(byClass(zh, "section-title").map((n) => n.textContent), ["运行中6", "已结束7"]);
  assert.equal(line(cardByRun(zh, "run_quiet"), 2), "运行中 50 分钟 · 最后进展 40 分钟前 · 静默");
  assert.equal(line(cardByRun(zh, "run_rev"), 2), "完成 4 小时前 · aaaaaaaa · 11 个文件 · 验证通过 · 等 Lead 裁决");
  assert.equal(line(cardByRun(zh, "run_cont"), 1), "●Search index第 2 轮写代码glm-prorun_cont");
  assert.equal(line(cardByRun(zh, "run_sol"), 2), "完成 40 分钟前 · PASS", "the verdict is data: the same word in both languages");
  assert.equal(line(cardByRun(zh, "run_quiet"), 1).includes("run_quiet"), true);
  assert.equal(byClass(zh, "wgroup-seats")[0].textContent, "已到 2 / 3 席");
  assert.equal(byClass(zh, "disclosure")[0].textContent, "2 个启动中");
  const cut = workers.buildWorkers({ ...await getShop(), workers: { ...(await getShop()).workers, truncated: true } }, { refMs: GEN_MS, view: workers.emptyView() });
  assert.ok(pageOf(cut).root.textContent.includes("Only the most recent workers were returned"), "a capped list says so");
});

test("V2 the open card is marked; the selected card follows the fragment and a language switch changes nothing else", async () => {
  const vm = await listOf({ ...workers.emptyView(), run: "run_mid" });
  const { root } = pageOf(vm);
  const selected = cardsIn(root).filter((n) => n.getAttribute("aria-pressed") === "true");
  assert.deepEqual(selected.map((n) => n.getAttribute("data-fk")), ["card:run_mid"]);
  assert.ok(byClass(root, "wcard-selected").length === 1);
  const zh = pageOf(vm, "zh").root;
  assert.deepEqual(cardsIn(zh).filter((n) => n.getAttribute("aria-pressed") === "true").map((n) => n.getAttribute("data-fk")), ["card:run_mid"]);
  assert.equal(cardsIn(zh).length, cardsIn(root).length, "same cards in the same grid");
});

test("V3 the filter row: unset filters are selects, set ones are labelled chips that clear one by one; both languages; the search is not a filter chip", async () => {
  const bare = pageOf(await listOf()).root;
  assert.deepEqual(byTag(bare, "select").map((n) => n.getAttribute("aria-label")), ["Project", "Lane", "Type", "Status", "Health"]);
  assert.equal(byClass(bare, "chip").length, 0);
  const lane = byTag(bare, "select")[1];
  assert.deepEqual(find(lane, (n) => n.tag === "option").map((n) => n.textContent), ["Lane", "astra", "deepseek-flash", "glm-pro", "kimi", "opus", "sol"], "the lanes that are listed, sorted");
  assert.deepEqual(find(byTag(bare, "select")[0], (n) => n.tag === "option").map((n) => n.textContent), ["Project", "docs-site", "shop-api"]);
  assert.deepEqual(find(byTag(bare, "select")[2], (n) => n.tag === "option").map((n) => n.textContent), ["Type", "Research", "Coding", "Testing", "Plan review", "Delivery review", "Image", "Untyped"]);
  assert.deepEqual(find(byTag(bare, "select")[3], (n) => n.tag === "option").map((n) => n.textContent), ["Status", "Starting", "Running", "Completed", "Failed", "Stopped"]);
  assert.deepEqual(find(byTag(bare, "select")[4], (n) => n.tag === "option").map((n) => n.textContent), ["Health", "progressing", "process only", "silent", "unknown"]);
  // Choosing writes the filter; choosing the label again clears it.
  const actions = recorder();
  const withActions = region();
  renderWorkersPage(withActions, await listOf(), "en", actions);
  const typeSelect = byTag(withActions, "select")[2];
  typeSelect.fire("change", { target: { value: "research" } });
  typeSelect.fire("change", { target: { value: "" } });
  assert.deepEqual(actions.calls.splice(0), [["setFilter", "type", "research"], ["setFilter", "type", null]]);
  // Set filters are chips (by NAME for a project), one clear button each.
  const view = { ...workers.emptyView("shop-api"), lane: "opus", status: "running", health: "silent", type: "code" };
  const vm = await listOf(view);
  const { root, actions: a2 } = pageOf(vm);
  assert.deepEqual(byClass(root, "chip").map((n) => n.textContent), ["Project: shop-api✕", "Lane: opus✕", "Type: Coding✕", "Status: Running✕", "Health: silent✕"]);
  assert.equal(byTag(root, "select").length, 0, "every filter is set: no select left");
  const clears = byClass(root, "chip-x");
  assert.deepEqual(clears.map((n) => n.getAttribute("aria-label")), ["Clear this filter (Project)", "Clear this filter (Lane)", "Clear this filter (Type)", "Clear this filter (Status)", "Clear this filter (Health)"]);
  clears[1].click();
  clears[3].click();
  assert.deepEqual(a2.calls.splice(0), [["setFilter", "lane", null], ["setFilter", "status", null]], "each chip clears only itself");
  const zh = pageOf(vm, "zh").root;
  assert.deepEqual(byClass(zh, "chip").map((n) => n.textContent), ["项目：shop-api✕", "车道：opus✕", "类型：写代码✕", "状态：运行中✕", "健康：静默✕"]);
  assert.equal(workers.hasFilters(view), true);
  // A filtered list says how much of it is shown, and an empty result says so.
  assert.match(root.textContent, /\d+ of \d+ shown/);
  const none = pageOf(await listOf({ ...workers.emptyView(), lane: "sol", status: "failed" })).root;
  assert.ok(none.textContent.includes("No worker matches the filters."));
  assert.equal(byClass(none, "section").length, 0, "no empty groups under an empty result");
});

test("V4 filters narrow the list for real: lane, type, status, health (rows from the server), and they combine", async () => {
  const ids = async (view) => { const vm = await listOf(view); return [...new Set([...vm.sequence, ...vm.starting.cards.map((c) => c.runId)])].sort(); };
  assert.deepEqual(await ids({ ...workers.emptyView(), lane: "opus" }), ["run_fresh", "run_mid"]);
  assert.deepEqual(await ids({ ...workers.emptyView(), type: "research" }), ["run_done", "run_s1"]);
  assert.deepEqual(await ids({ ...workers.emptyView(), type: "delivery_review" }), ["run_astra", "run_kimi", "run_sol"]);
  assert.deepEqual(await ids({ ...workers.emptyView(), status: "failed" }), ["run_fail"]);
  assert.deepEqual(await ids({ ...workers.emptyView(), status: "stopped" }), ["run_stop"]);
  assert.deepEqual(await ids({ ...workers.emptyView(), status: "starting" }), ["run_s1", "run_s2"]);
  assert.deepEqual(await ids({ ...workers.emptyView(), health: "silent" }), ["run_quiet"], "health is the liveness of a worker that has not ended");
  assert.deepEqual(await ids({ ...workers.emptyView(), status: "completed", type: "code" }), ["run_cont", "run_docs", "run_rev", "run_unres"]);
  assert.deepEqual(await ids({ ...workers.emptyView(), lane: "opus", status: "completed" }), [], "filters combine");
  assert.deepEqual(await ids({ ...workers.emptyView("docs-site") }), ["run_docs"]);
});

test("V5 the search box is built once and never rebuilt under the typist: it keeps its text while focused, follows the fragment when it is not, and its words follow the language", async () => {
  const vm = await listOf({ ...workers.emptyView(), q: "aaaa" });
  const root = region();
  const actions = recorder();
  renderWorkersPage(root, vm, "en", actions);
  const input = byTag(root, "input")[0];
  assert.deepEqual([input.getAttribute("type"), input.getAttribute("placeholder"), input.getAttribute("aria-label"), input.getAttribute("maxlength")], ["search", "Search run / commit", "Search run / commit", "64"]);
  assert.equal(input.value, "aaaa", "built with the search of the fragment");
  input.fire("input", { target: { value: "aaaab" } });
  assert.deepEqual(actions.calls.pop(), ["setQuery", "aaaab"], "each keystroke goes to the state");
  // The user is typing: the state catches up, the box is not touched.
  input.value = "aaaab";
  fakeDocument.activeElement = input;
  const typing = await listOf({ ...workers.emptyView(), q: "aaaa" });
  renderWorkersPage(root, typing, "en", actions);
  assert.equal(byTag(root, "input")[0], input, "the very same box");
  assert.equal(input.value, "aaaab", "a focused box is never overwritten");
  // Redrawing the rest (filters, list) does not rebuild it either.
  renderWorkersPage(root, await listOf({ ...workers.emptyView(), q: "aaaa", lane: "opus" }), "en", actions);
  assert.equal(byTag(root, "input")[0], input);
  assert.equal(byClass(root, "chip").length, 1, "the chip changed, the box did not");
  // Not focused (back / forward / a pasted link changed the fragment): the box follows.
  fakeDocument.activeElement = null;
  renderWorkersPage(root, await listOf({ ...workers.emptyView(), q: "" }), "en", actions);
  assert.equal(byTag(root, "input")[0], input);
  assert.equal(input.value, "");
  // Language: the words change, the box and its text do not.
  input.value = "cccc";
  fakeDocument.activeElement = input;
  renderWorkersPage(root, await listOf({ ...workers.emptyView(), q: "cccc" }), "zh", actions);
  assert.equal(byTag(root, "input")[0], input);
  assert.deepEqual([input.getAttribute("placeholder"), input.value], ["搜索 run 号 / 提交", "cccc"]);
  // Leaving the Workers page and coming back builds a fresh page (and a fresh box).
  const other = await getShop();
  renderMain(root, { page: "message", kind: "network" }, "en", { selected: null, legacyOpen: {}, resolvedOpen: false, copy: null }, actions);
  assert.equal(byTag(root, "input").length, 0);
  renderWorkersPage(root, vm, "en", actions);
  assert.equal(byTag(root, "input").length, 1);
  assert.notEqual(byTag(root, "input")[0], input);
  assert.ok(other, "fixture");
});

test("V6 the side panel header and health (real body): title, run number, type · lane · project, time; health with both times; a close button; read-only", async () => {
  const body = await bodyOf({
    run: snapLive("run_hd", { liveness: "silent", title: "Migrate orders table", startedAt: ago(38 * MIN), lastEffectAt: ago(11 * MIN), lastHeartbeatAt: ago(4 * MIN), project: { slug: "shop-api", name: "Shop API" } }),
    events: (() => { const b = builder("run_hd"); head(b, { prompt: "# Migrate orders table\nbody" }); return b.events; })(),
  });
  const vm = panelOf(body);
  const root = region("aside");
  const actions = recorder();
  renderSidebar(root, vm, "en", SUI(), [], {}, actions);
  assert.equal(root.attrs.has("hidden"), false, "shown while a worker is open");
  assert.equal(root.getAttribute("aria-label"), "Worker detail");
  assert.equal(byClass(root, "sb-title")[0].textContent, "Migrate orders table");
  assert.equal(byClass(root, "sb-run")[0].textContent, "run_hd");
  assert.equal(byClass(root, "sb-sub")[0].textContent, "Coding · glm-pro · Shop APIRunning 38m");
  assert.equal(byClass(root, "sb-health")[0].textContent, "▲silent · last progress 11m ago · last heartbeat 4m ago");
  assert.ok(byClass(root, "sb-health")[0].className.includes("tone-amber"));
  const close = byClass(root, "sb-close")[0];
  assert.equal(close.tag, "button");
  assert.equal(close.getAttribute("aria-label"), "Close");
  close.click();
  assert.deepEqual(actions.calls.pop(), ["closeWorker"]);
  // The footer: the reference, and the copy button (carrying the whole panel vm, whose ref is the run number).
  assert.equal(byClass(root, "ref")[0].textContent, "run_hd");
  assert.equal(byClass(root, "ref")[0].getAttribute("data-ref"), "worker:run_hd");
  byClass(root, "btn")[0].click();
  assert.deepEqual(actions.calls.pop(), ["copyWorkerRef", vm]);
  assert.equal(byClass(root, "btn")[0].textContent, "Copy ref");
  renderSidebar(root, vm, "en", SUI({ copy: "ok" }), [], {}, actions);
  assert.equal(byClass(root, "btn")[0].textContent, "Copied");
  renderSidebar(root, vm, "en", SUI({ copy: "fail" }), [], {}, actions);
  assert.match(byClass(root, "copy-status")[0].textContent, /Copy failed/);
  // Read-only: nothing that stops, re-dispatches or answers.
  const words = find(root, (n) => n.tag === "button").map((n) => `${n.textContent} ${n.getAttribute("aria-label") ?? ""}`).join("|");
  assert.doesNotMatch(words, /stop|abort|retry|re-?dispatch|reply|answer|resume|kill|cancel|停止|重派|答复|终止/i);
  assert.equal(find(root, (n) => ["form", "textarea"].includes(n.tag) || (n.tag === "input")).length, 0, "no form control in the panel");
  // Same panel in Chinese.
  const zh = region("aside");
  renderSidebar(zh, vm, "zh", SUI(), [], {}, recorder());
  assert.equal(byClass(zh, "sb-sub")[0].textContent, "写代码 · glm-pro · Shop API已运行 38 分钟");
  assert.equal(byClass(zh, "sb-health")[0].textContent, "▲静默 · 最后进展 11 分钟前 · 最后心跳 4 分钟前");
  assert.equal(byClass(zh, "sb-title")[0].textContent, "Migrate orders table", "the title is data");
  assert.equal(byClass(zh, "ref")[0].textContent, "run_hd", "the reference is the same string in both languages");
  // Closed: hidden and empty.
  renderSidebar(root, null, "en", SUI(), [], {}, actions);
  assert.equal(root.attrs.has("hidden"), true);
  assert.equal(root.children.length, 0);
});

test("V7 the progress axes drawn (real bodies): marks as glyph + word, the delivery steps with the verification result, the round with a way back to the previous one", async () => {
  const first = finishedRow("run_r1", { delivery: snapDelivery({ acceptance: { status: "rejected", decidedAt: ago(2 * HOUR), decidedSeq: 3 } }) });
  const second = finishedRow("run_r2", { parentRunId: "run_r1", lineageRootRunId: "run_r1" });
  const vm = panelOf(await bodyOf({ run: second, events: deliveredEvents("run_r2", { continuation: { parentRunId: "run_r1", rootRunId: "run_r1" } }), runs: [first, second] }));
  const root = region("aside");
  const actions = recorder();
  renderSidebar(root, vm, "en", SUI(), [], {}, actions);
  const axes = byClass(root, "axis");
  assert.deepEqual(axes.map((a) => byClass(a, "axis-name")[0].textContent), ["RUN", "DELIVERY"]);
  const stepsOf = (axis) => byClass(axis, "step").map((s) => s.textContent);
  assert.deepEqual(stepsOf(axes[0]), ["✓Starting (done)", "✓Running (done)", "✓Completed (done)"]);
  assert.deepEqual(stepsOf(axes[1]), ["✓Commit (done)", "✓Verify · Passed (done)", "●Awaiting Lead (now)"], "undecided: three steps, as in the design (the last one comes with the decision)");
  const decided = region("aside");
  renderSidebar(decided, panelOf(await bodyOf({ run: finishedRow("run_ok"), events: deliveredEvents("run_ok", { decision: "accepted" }) })), "en", SUI(), [], {}, recorder());
  assert.deepEqual(stepsOf(byClass(decided, "axis")[1]), ["✓Commit (done)", "✓Verify · Passed (done)", "✓Awaiting Lead (done)", "✓Adopted (done)"]);
  const refused = region("aside");
  renderSidebar(refused, panelOf(await bodyOf({ run: finishedRow("run_no"), events: deliveredEvents("run_no", { decision: "rejected" }) })), "en", SUI(), [], {}, recorder());
  assert.deepEqual(stepsOf(byClass(refused, "axis")[1]).slice(2), ["✓Awaiting Lead (done)", "■Rejected (ended)"]);
  const round = byClass(root, "axis-round")[0];
  assert.equal(round.textContent, "Round 2 · continues run_r1 (rejected)");
  const back = find(round, (n) => n.tag === "button")[0];
  assert.equal(back.textContent, "run_r1");
  back.click();
  assert.deepEqual(actions.calls.pop(), ["openWorker", "run_r1"], "the previous round is one click away");
  const zh = region("aside");
  renderSidebar(zh, vm, "zh", SUI(), [], {}, recorder());
  assert.equal(byClass(zh, "axis-round")[0].textContent, "第 2 轮 · 接续 run_r1 (已拒收)");
  assert.deepEqual(byClass(zh, "axis").map((a) => byClass(a, "axis-name")[0].textContent), ["运行", "交付"]);
  assert.deepEqual(stepsOf(byClass(zh, "axis")[0]), ["✓启动 (已完成)", "✓运行 (已完成)", "✓完成 (已完成)"]);
  // Problem and unknown marks keep a word (never colour alone).
  const bad = panelOf(await bodyOf({ run: finishedRow("run_vf"), events: deliveredEvents("run_vf", { status: "failed" }) }));
  const badRoot = region("aside");
  renderSidebar(badRoot, bad, "en", SUI(), [], {}, recorder());
  assert.ok(stepsOf(byClass(badRoot, "axis")[1]).includes("▲Verify · Failed (problem)"));
  const failedRun = panelOf(await bodyOf({ run: finishedRow("run_fl", { state: "failed", lastEffectAt: null, deliveryRequested: false }), events: (() => { const b = builder("run_fl"); head(b); working(b, T0 + 3000); terminal(b, T0 + 5000, "failed"); return b.events; })() }));
  const flRoot = region("aside");
  renderSidebar(flRoot, failedRun, "en", SUI(), [], {}, recorder());
  assert.deepEqual(stepsOf(byClass(flRoot, "axis")[0]), ["✓Starting (done)", "?Running (not observed)", "▲Failed (problem)"]);
  // Starting: how long, amber when over 30s; a run with no stage binding says so.
  const st = panelOf(await bodyOf({ run: snapLive("run_st", { state: "pending", stage: "starting", stageSince: ago(45_000), lastEffectAt: null }), events: (() => { const b = builder("run_st"); head(b); return b.events; })() }));
  const stRoot = region("aside");
  renderSidebar(stRoot, st, "en", SUI(), [], {}, recorder());
  assert.equal(byClass(stRoot, "axis-notes")[0].textContent, "starting for <1m");
  assert.ok(byClass(stRoot, "tone-amber").some((n) => n.textContent === "starting for <1m"), "over 30s is flagged");
  // Review axis.
  const seatRows = [finishedRow("run_sol", { deliveryRequested: false, taskType: "delivery_review" }), snapLive("run_kimi", { taskType: "delivery_review" })];
  const seat = panelOf(await bodyOf({ run: seatRows[1], events: (() => { const b = builder("run_kimi"); head(b); working(b, T0 + 3000); return b.events; })(), runs: seatRows, consults: [snapConsult({ seats: [snapSeat("run_sol", "PASS"), snapSeat("run_kimi", null)] })] }));
  const seatRoot = region("aside");
  const seatActions = recorder();
  renderSidebar(seatRoot, seat, "en", SUI(), [], {}, seatActions);
  assert.equal(byClass(seatRoot, "axis-review")[0].textContent, "REVIEWThis seat: running · no reply yet · 1 of 2 seats in · waiting for seats · Reviews run_rev");
  find(byClass(seatRoot, "axis-review")[0], (n) => n.tag === "button")[0].click();
  assert.deepEqual(seatActions.calls.pop(), ["openWorker", "run_rev"]);
});

const textsOf = (root, cls) => byClass(root, cls).map((n) => n.textContent);
const panelRoot = (vm, lang = "en", sui = SUI(), wanted = [], views = {}, actions = recorder()) => { const root = region("aside"); renderSidebar(root, vm, lang, sui, wanted, views, actions); return { root, actions }; };

test("V8 Deliverable, a code delivery drawn (real body): commit, source, files, sums, verification bound to the commit, the Lead's decision, the review beside it; tabs; default tab by state", async () => {
  const run = finishedRow("run_code");
  const reviewedSeats = [snapSeat("run_sol", "PASS"), snapSeat("run_astra", "FIX_FIRST")];
  const seatRows = [finishedRow("run_sol", { deliveryRequested: false, taskType: "delivery_review", laneId: "sol", agentId: "sol" }), finishedRow("run_astra", { deliveryRequested: false, taskType: "delivery_review", laneId: "astra", agentId: "astra" })];
  const vm = panelOf(await bodyOf({ run, events: deliveredEvents("run_code"), runs: [run, ...seatRows], consults: [snapConsult({ reviewedRunId: "run_code", seats: reviewedSeats })] }));
  assert.equal(vm.defaultTab, "deliverable");
  const { root, actions } = panelRoot(vm);
  assert.deepEqual(find(root, (n) => n.tag === "button" && n.className === "sb-tab").map((n) => [n.textContent, n.getAttribute("aria-pressed")]), [["Activity", "false"], ["Deliverable", "true"], ["Brief", "false"]], "an ended worker opens on Deliverable");
  assert.deepEqual(textsOf(root, "sb-h"), ["Commit cccccccc", "Verification", "Delivery review consult_order"]);
  const panel = byClass(root, "sb-panel")[0];
  const text = panel.textContent;
  assert.ok(text.includes("System observed"), "the source of the commit and of the verification is said");
  assert.deepEqual(textsOf(root, "file-path"), FILES);
  assert.deepEqual(textsOf(root, "file-stats"), ["+10 −0", "+11 −1", "+12 −2"]);
  assert.ok(text.includes("3 files · +33 −3"));
  assert.ok(text.includes("Awaiting Lead") && text.includes("7h 59m"), "the decision line, with how long it has waited");
  assert.ok(text.includes("Passed · cccccccc"), "the verification result is bound to the commit it ran on");
  assert.deepEqual(textsOf(root, "cmd"), ["npm test"]);
  assert.deepEqual(textsOf(root, "cmd-result"), ["exit 0 · 4s".replace("4s", "<1m")], "exit code and duration of the command");
  // The review beside the delivery: one row per seat, the split marked, each seat opens its own panel.
  assert.deepEqual(textsOf(root, "tag").filter((t) => /split|FIX_FIRST/.test(t)), ["verdicts split", "FIX_FIRST present"]);
  const seatButtons = byClass(root, "seat-btn");
  assert.deepEqual(seatButtons.map((n) => n.textContent), ["solPASScompleted · replied", "astraFIX_FIRSTcompleted · replied"]);
  seatButtons[1].click();
  assert.deepEqual(actions.calls.pop(), ["openWorker", "run_astra"]);
  // The tabs.
  find(root, (n) => n.tag === "button" && n.className === "sb-tab")[2].click();
  assert.deepEqual(actions.calls.pop(), ["setTab", "brief"]);
  const brief = panelRoot(vm, "en", SUI({ tab: "brief" })).root;
  assert.equal(byClass(brief, "sb-text")[0].textContent, "# Migrate orders table\nThe task text.", "the brief, as the server bound it");
  assert.equal(byClass(brief, "sb-panel")[0].textContent.includes("Commit"), false, "one tab at a time");
  const activity = panelRoot(vm, "en", SUI({ tab: "activity" })).root;
  assert.equal(byClass(activity, "empty")[0].textContent, "The live timeline comes in the next batch.");
  // A running worker opens on Activity; the Owner's pick sticks over the default.
  const running = panelOf(await bodyOf({ run: snapLive("run_live"), events: (() => { const b = builder("run_live"); head(b); working(b, T0 + 3000); return b.events; })() }));
  assert.equal(running.defaultTab, "activity");
  assert.equal(find(panelRoot(running).root, (n) => n.className === "sb-tab" && n.getAttribute("aria-pressed") === "true")[0].textContent, "Activity");
  assert.equal(find(panelRoot(running, "en", SUI({ tab: "deliverable" })).root, (n) => n.className === "sb-tab" && n.getAttribute("aria-pressed") === "true")[0].textContent, "Deliverable");
  assert.equal(detail.activeTab("nonsense", "activity"), "activity");
  assert.equal(detail.activeTab(null, "deliverable"), "deliverable");
  // Chinese: same panel, interface words only.
  const zh = panelRoot(vm, "zh").root;
  assert.deepEqual(textsOf(zh, "sb-h"), ["提交 cccccccc", "验证", "交付会审 consult_order"]);
  assert.ok(byClass(zh, "sb-panel")[0].textContent.includes("系统观测"));
  assert.deepEqual(textsOf(zh, "file-path"), FILES, "paths are data");
  assert.deepEqual(find(zh, (n) => n.className === "sb-tab").map((n) => n.textContent), ["实时事件", "交付物", "任务书"]);
});

test("V9 the file list folds above 8: a count behind a disclosure (closed by default, opens on request), no fold at 8 or fewer; a cut list says so", async () => {
  const bodyWith = async (n) => panelOf(await bodyOf({ run: finishedRow(`run_n${n}`), events: deliveredEvents(`run_n${n}`, { files: Array.from({ length: n }, (_, i) => `src/file${String(i).padStart(3, "0")}.js`) }) }));
  const eight = panelRoot(await bodyWith(8)).root;
  assert.equal(byClass(eight, "file-row").length, 8, "8 files: listed as they are");
  assert.equal(byClass(eight, "disclosure").length, 0);
  const eleven = await bodyWith(11);
  const closed = panelRoot(eleven);
  assert.equal(byClass(closed.root, "file-row").length, 0, "11 files: folded behind a count");
  const toggle = byClass(closed.root, "disclosure")[0];
  assert.equal(toggle.textContent, "11 files+165 −55", "the count is on the fold (with the sums)");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  toggle.click();
  assert.deepEqual(closed.actions.calls.pop(), ["toggleFiles"]);
  const open = panelRoot(eleven, "en", SUI({ filesOpen: true })).root;
  assert.equal(byClass(open, "file-row").length, 11);
  assert.equal(byClass(open, "disclosure")[0].getAttribute("aria-expanded"), "true");
  const many = panelRoot(await bodyWith(520), "en", SUI({ filesOpen: true })).root;
  assert.equal(byClass(many, "file-row").length, 500);
  assert.ok(many.textContent.includes("Showing the first 500 of 520 files."));
  // The fold survives a language switch (it lives in the panel state, not in the words).
  assert.equal(byClass(panelRoot(eleven, "zh", SUI({ filesOpen: true })).root, "file-row").length, 11);
  assert.equal(byClass(panelRoot(eleven, "zh").root, "disclosure")[0].textContent, "11 个文件+165 −55");
});

test("V10 Deliverable, review seats / research / none / unavailable / images drawn (real bodies)", async () => {
  // A seat: one row per seat, the split marked, other seats open their panel, this seat is plain text.
  const seatRows = [finishedRow("run_sol", { deliveryRequested: false, taskType: "delivery_review", laneId: "sol", agentId: "sol" }), finishedRow("run_astra", { deliveryRequested: false, taskType: "delivery_review", laneId: "astra", agentId: "astra" }), snapLive("run_kimi", { taskType: "delivery_review", laneId: "kimi", agentId: "kimi" })];
  const quick = (id) => { const b = builder(id); head(b, { prompt: "# Delivery review\nReview it." }); working(b, T0 + 3000); return b.events; };
  const consult = snapConsult({ seats: [snapSeat("run_sol", "PASS"), snapSeat("run_astra", "FIX_FIRST"), snapSeat("run_kimi", null)] });
  const seat = panelOf(await bodyOf({ run: seatRows[0], events: quick("run_sol"), runs: seatRows, consults: [consult] }));
  const seatView = panelRoot(seat);
  assert.deepEqual(textsOf(seatView.root, "seat-row"), ["solPASScompleted · repliedthis seat", "astraFIX_FIRSTcompleted · replied", "kimino verdictrunning · no reply yet"]);
  assert.deepEqual(byClass(seatView.root, "seat-btn").length, 2, "this seat is not a link to itself");
  assert.deepEqual(textsOf(seatView.root, "tag"), ["verdicts split", "FIX_FIRST present", "this seat"]);
  find(seatView.root, (n) => n.className === "link-btn mono")[0].click();
  assert.deepEqual(seatView.actions.calls.pop(), ["openWorker", "run_rev"], "the reviewed run opens too");
  byClass(seatView.root, "seat-btn")[0].click();
  assert.deepEqual(seatView.actions.calls.pop(), ["openWorker", "run_astra"], "a click on a seat opens THAT seat's panel");
  assert.ok(byClass(seatView.root, "seat-q1").some((n) => n.className.includes("tone-red") && n.textContent === "FIX_FIRST"), "FIX_FIRST carries the red tone and the word");
  // Research: the answer text as sent (and only as text), the source.
  const answer = (id, textValue) => { const b = builder(id); head(b); working(b, T0 + 3000); say(b, T0 + 4000, textValue); terminal(b, T0 + 5000); return b.events; };
  const research = panelOf(await bodyOf({ run: finishedRow("run_rs", { taskType: "research", deliveryRequested: false }), events: answer("run_rs", "Use <b>keyset</b> pagination.\n- it scales") }));
  const researchView = panelRoot(research).root;
  assert.equal(byClass(researchView, "sb-text")[0].textContent, "Use <b>keyset</b> pagination.\n- it scales", "markup characters are drawn as text, verbatim");
  assert.equal(byTag(researchView, "b").length, 0, "and never become elements");
  assert.ok(byClass(researchView, "sb-panel")[0].textContent.includes("Worker reported"));
  const longAnswer = panelOf(await bodyOf({ run: finishedRow("run_rl", { taskType: "research", deliveryRequested: false }), events: answer("run_rl", "z".repeat(70_000)) }));
  assert.ok(panelRoot(longAnswer).root.textContent.includes("Showing the first 65536 of 70000 characters."));
  // None: said plainly, in both languages; the assistant's claim is not shown.
  const talker = builder("run_talk");
  head(talker, { deliveryRequested: true });
  working(talker, T0 + 3000);
  say(talker, T0 + 4000, "I committed everything and all tests pass.");
  terminal(talker, T0 + 5000);
  const none = panelOf(await bodyOf({ run: finishedRow("run_talk"), events: talker.events }));
  assert.equal(byClass(panelRoot(none).root, "empty")[0].textContent, "No deliverable observed yet.");
  assert.equal(byClass(panelRoot(none, "zh").root, "empty")[0].textContent, "尚未观测到交付物。");
  assert.ok(!panelRoot(none).root.textContent.includes("I committed everything"));
  // Unavailable: the transcript's facts stay, the reason is named, no line counts, no images.
  const gone = panelRoot(panelOf(await bodyOf({ run: finishedRow("run_g"), events: deliveredEvents("run_g"), prove: proveGone }))).root;
  assert.ok(byClass(gone, "tone-amber")[0].textContent.startsWith("The delivery object is unavailable; the facts below are as the transcript recorded them."));
  assert.ok(gone.textContent.includes("Git could not be read, or the object is gone."));
  assert.deepEqual(textsOf(gone, "file-stats"), ["—", "—", "—"], "no counts are invented");
  // Images: a thumbnail per image file, the path beside it, bound to its blob URL; states are words.
  const imgRun = finishedRow("run_img", { taskType: "image" });
  const imgPanel = panelOf(await bodyOf({ run: imgRun, events: deliveredEvents("run_img", { files: ["assets/logo.png", "docs/readme.md", "assets/photo.jpg"], headOver: { taskType: "image" } }) }));
  const wanted = detail.imagesWanted(imgPanel, "deliverable");
  const views = { [wanted[0].id]: { state: "ready", url: "blob:fixture/0" }, [wanted[1].id]: { state: "loading", url: null } };
  const imgView = panelRoot(imgPanel, "en", SUI(), wanted, views);
  const imgs = byTag(imgView.root, "img");
  assert.equal(imgs.length, 1, "only a loaded image is an <img>");
  assert.deepEqual([imgs[0].getAttribute("src"), imgs[0].getAttribute("alt")], ["blob:fixture/0", "assets/logo.png"]);
  assert.deepEqual(textsOf(imgView.root, "image-row"), ["assets/logo.png", "Loading image…assets/photo.jpg"]);
  const thumb = byClass(imgView.root, "thumb-btn")[0];
  assert.equal(thumb.getAttribute("aria-pressed"), "false");
  thumb.click();
  assert.deepEqual(imgView.actions.calls.pop(), ["toggleImage", wanted[0].id]);
  assert.ok(byClass(panelRoot(imgPanel, "en", SUI({ imageOpen: wanted[0].id }), wanted, views).root, "thumb-open").length === 1, "a clicked thumbnail is shown larger");
  const failed = panelRoot(imgPanel, "en", SUI(), wanted, { [wanted[0].id]: { state: "failed", url: null }, [wanted[1].id]: { state: "failed", url: null } }).root;
  assert.equal(byTag(failed, "img").length, 0);
  assert.ok(failed.textContent.includes("The image could not be loaded."));
  assert.equal(byClass(panelRoot(imgPanel, "en", SUI(), [], {}).root, "image-row").length, 0, "no wanted image, none drawn");
});

test("V11 messages and notes: loading / not found / rejected token as text with a close button; the 'not in the default range' note; a stale refresh is said; the failure diagnosis with its isolation fields", async () => {
  const feed = (phase, problem = null) => ({ runId: "run_m", epoch: 1, phase, body: null, problem });
  const msg = (phase, problem, note, lang = "en") => {
    const { root, actions } = panelRoot(detail.buildSidebar({ feed: feed(phase, problem), open: { runId: "run_m", note }, nowMs: GEN_MS }), lang);
    return { root, actions, text: byClass(root, "message")[0].textContent };
  };
  assert.equal(msg("loading", null, null).text, "Loading…");
  assert.match(msg("notFound", null, null).text, /not available/);
  assert.match(msg("unavailable", null, null).text, /No data yet/);
  assert.match(msg("error", "server", null).text, /could not be read/);
  assert.match(msg("error", "unauthorized", null).text, /access token was rejected/);
  assert.match(msg("error", "unauthorized", null, "zh").text, /令牌被拒绝/);
  const loading = msg("loading", null, "outOfRange");
  assert.equal(byClass(loading.root, "sb-title")[0].textContent, "run_m", "even before the detail arrives the panel names the run");
  assert.match(byClass(loading.root, "sb-note")[0].textContent, /Not in the default range/);
  byClass(loading.root, "sb-close")[0].click();
  assert.deepEqual(loading.actions.calls.pop(), ["closeWorker"]);
  // With data: the notes sit under the header; both languages.
  const body = await bodyOf({ run: finishedRow("run_old", { terminalAt: ago(3 * DAY) }), events: deliveredEvents("run_old") });
  const withNote = (note) => panelRoot(detail.buildSidebar({ feed: { runId: "run_old", epoch: 1, phase: "ready", body, problem: null }, open: { runId: "run_old", note }, nowMs: GEN_MS }));
  assert.match(textsOf(withNote("outOfRange").root, "sb-note")[0], /Not in the default range: it finished more than 24 hours ago/);
  assert.match(textsOf(withNote("filtered").root, "sb-note")[0], /Hidden from the list by the current filters/);
  assert.equal(byClass(withNote(null).root, "sb-note").length, 0);
  assert.match(textsOf(panelRoot(detail.buildSidebar({ feed: { runId: "run_old", epoch: 1, phase: "ready", body, problem: null }, open: { runId: "run_old", note: "outOfRange" }, nowMs: GEN_MS }), "zh").root, "sb-note")[0], /不在默认范围内/);
  const stale = panelRoot(detail.buildSidebar({ feed: { runId: "run_old", epoch: 1, phase: "ready", body, problem: "network" }, open: { runId: "run_old", note: null }, nowMs: GEN_MS }));
  assert.match(textsOf(stale.root, "sb-note")[0], /last refresh failed/);
  // The failure diagnosis (closed category / code, the isolation fields through the shared projection).
  const failB = builder("run_bad");
  head(failB, { deliveryRequested: true });
  working(failB, T0 + 3000);
  terminal(failB, T0 + 5000, "failed");
  failB.clock(T0 + 6000).add("run.isolation_violation", { code: "workdir_escape", reason: "file_written_physical_outside", destination: "main_checkout", reportedPath: "..\\escape\\a.txt", resolvedPath: "D:\\outside\\main\\a.txt", escapedAt: "D:\\outside\\link" });
  const failed = panelRoot(panelOf(await bodyOf({ run: finishedRow("run_bad", { state: "failed", failure: { category: "workdir_escape", code: "file_written_physical_outside" } }), events: failB.events })));
  const rows = byClass(failed.root, "detail-row").map((n) => n.textContent);
  for (const expected of ["Diagnosisworkdir_escape", "Violationfile_written_physical_outside", "Went tomain_checkout", "Reported path..\\escape\\a.txt", "Resolved pathD:\\outside\\main\\a.txt", "Escaped atD:\\outside\\link"]) {
    assert.ok(rows.includes(expected), `${expected} in ${JSON.stringify(rows)}`);
  }
  assert.equal(byClass(failed.root, "sb-health")[0].textContent.startsWith("▲Failed"), true);
  assert.ok(byClass(panelRoot(panelOf(await bodyOf({ run: finishedRow("run_bad2", { state: "failed", failure: { category: "workdir_escape", code: "x" } }), events: failB.events.map((e) => ({ ...e, runId: "run_bad2" })) })), "zh").root, "detail-row").map((n) => n.textContent).some((t) => t.startsWith("诊断")));
});

test("V12 text only, keyboard only: markup in a title / brief / answer is drawn as text; every click handler is on a <button>; every button is type=button with a unique focus key; no tabindex", async () => {
  const evil = "<img src=x onerror=alert(1)> & <script>alert(2)</script>";
  const b = builder("run_ev");
  head(b, { prompt: `# ${evil}\n${evil}`, deliveryRequested: true });
  working(b, T0 + 3000);
  terminal(b, T0 + 5000);
  b.clock(T0 + 6000).add("run.delivery_created", { delivery: deliveryRef("run_ev") });
  const vm = panelOf(await bodyOf({ run: finishedRow("run_ev", { title: evil }), events: b.events }));
  for (const tab of ["activity", "deliverable", "brief"]) {
    const { root } = panelRoot(vm, "en", SUI({ tab }));
    assert.equal(byTag(root, "img").length, 0, `${tab}: no element made from worker text`);
    assert.equal(byTag(root, "script").length, 0);
  }
  const brief = panelRoot(vm, "en", SUI({ tab: "brief" })).root;
  assert.equal(byClass(brief, "sb-title")[0].textContent, evil);
  assert.equal(byClass(brief, "sb-text")[0].textContent, `# ${evil}\n${evil}`);
  // Every control, on every drawn thing.
  const drawn = [];
  const list = await listOf({ ...workers.emptyView(), run: "run_mid" });
  drawn.push(pageOf(await listOf({ ...workers.emptyView(), run: "run_mid" }, { startingOpen: true })).root);
  drawn.push(pageOf(await listOf({ ...workers.emptyView("shop-api"), lane: "opus", status: "running" }), "zh").root);
  const running = panelOf(await bodyOf({ run: snapLive("run_live"), events: (() => { const e = builder("run_live"); head(e); working(e, T0 + 3000); return e.events; })() }));
  for (const tab of ["activity", "deliverable", "brief"]) drawn.push(panelRoot(vm, "en", SUI({ tab })).root, panelRoot(running, "zh", SUI({ tab })).root);
  const seatRows = [finishedRow("run_sol", { deliveryRequested: false, taskType: "delivery_review" }), snapLive("run_kimi", { taskType: "delivery_review" })];
  const seat = panelOf(await bodyOf({ run: seatRows[1], events: (() => { const e = builder("run_kimi"); head(e); working(e, T0 + 3000); return e.events; })(), runs: seatRows, consults: [snapConsult({ seats: [snapSeat("run_sol", "PASS"), snapSeat("run_kimi", null)] })] }));
  drawn.push(panelRoot(seat).root);
  drawn.push(panelRoot(detail.buildSidebar({ feed: { runId: "run_m", epoch: 1, phase: "notFound", body: null, problem: null }, open: { runId: "run_m", note: null }, nowMs: GEN_MS })).root);
  const clickable = drawn.flatMap((root) => find(root, (n) => n.listeners.has("click")).map((n) => n.tag));
  assert.ok(clickable.length > 40, `plenty of controls drawn (${clickable.length})`);
  assert.ok(clickable.every((tag) => tag === "button"), `click handlers only on buttons, got ${[...new Set(clickable)]}`);
  for (const root of drawn) {
    const buttons = byTag(root, "button");
    for (const button of buttons) {
      assert.equal(button.getAttribute("type"), "button");
      assert.ok(button.getAttribute("data-fk"), "a focus key, so a redraw can put the focus back");
    }
    const keys = buttons.map((n) => n.getAttribute("data-fk"));
    assert.equal(new Set(keys).size, keys.length, `focus keys are unique in a region: ${keys.join(",")}`);
    assert.equal(find(root, (n) => n.attrs.has("tabindex")).length, 0, "no tabindex");
  }
});

// =====================================================================
// A) THE APP — the real app.js, booted against a fake browser
// =====================================================================
//
// The fetch behind the page answers with the server's real bodies (the list routes through the real
// server chain; a worker's detail is projectWorkerDetail's real output for a fixture transcript).
// Timers and the clock are the test runner's mock ones, so a poll happens when the test says so.

const TOKEN = "a".repeat(64);
const shopRows = () => shopSnapshot().runs;

/** The real detail body of any run of the Workers shop (a head-only transcript; finished runs end). */
async function shopDetail(runId, over = {}) {
  const snap = shopSnapshot();
  const row = { ...snap.runs.find((r) => r.runId === runId), ...over };
  const b = builder(runId);
  head(b, { prompt: `# ${row.title}\nBrief of ${runId}.` });
  if (!row.terminal) working(b, T0 + 3000);
  return bodyOf({ run: row, events: b.events, runs: snap.runs.map((r) => (r.runId === runId ? row : r)), consults: snap.consults });
}

/** What the globals were before any app booted: every restore goes back to exactly this. */
const BASE = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator") };

function installBrowser({ hash, details, artifacts = new Map(), lang = null, shop: shopChainOverride = null }) {
  const calls = [];
  const copied = [];
  const history = { replaced: [], pushed: [] };
  const topbar = new FakeNode("header"); topbar.setAttribute("id", "topbar");
  const main = new FakeNode("main"); main.setAttribute("id", "main");
  const sidebar = new FakeNode("aside"); sidebar.setAttribute("id", "sidebar"); sidebar.setAttribute("hidden", "");
  const elements = { topbar, main, sidebar };
  const listeners = { window: new Map(), document: new Map() };
  const on = (side) => (type, fn) => side.set(type, [...(side.get(type) ?? []), fn]);
  const fire = (side, type, event) => { for (const fn of side.get(type) ?? []) fn(event); };
  const store = (initial) => { const m = new Map(Object.entries(initial)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } }; };
  const location = {
    _hash: hash,
    pathname: "/v2",
    search: "",
    get hash() { return this._hash; },
    set hash(value) {
      const next = String(value).startsWith("#") ? String(value) : `#${value}`;
      if (next === this._hash) return;
      history.pushed.push(next);
      this._hash = next;
      queueMicrotask(() => fire(listeners.window, "hashchange", {}));
    },
    reload() { calls.push({ reload: true }); },
  };
  globalThis.document = {
    ...fakeDocument,
    get activeElement() { return fakeDocument.activeElement; },
    getElementById: (id) => elements[id] ?? null,
    addEventListener: on(listeners.document),
    documentElement: { lang: "" },
  };
  globalThis.window = {
    getSelection: () => fakeSelection,
    location,
    history: { replaceState: (_s, _t, url) => { const i = String(url).indexOf("#"); location._hash = i < 0 ? "" : String(url).slice(i); history.replaced.push(location._hash); } },
    sessionStorage: store({ wao_v2_token: TOKEN }),
    localStorage: store(lang === null ? {} : { wao_v2_lang: lang }),
    addEventListener: on(listeners.window),
  };
  Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async (text) => { copied.push(text); } } }, configurable: true });
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, blob: async () => body });
    const bare = String(url).split("?")[0];
    const shop = shopChainOverride ?? await getShop();
    // The list routes are answered by the real server route of that chain, query included: /api/workers?project=
    // narrows the rows exactly as the server does (not a canned full list).
    if (bare === "/api/overview" || bare === "/api/workers" || bare === "/api/attention") return reply(200, await shop.get(url));
    if (bare === "/api/worker") {
      const id = new URL(url, "http://x").searchParams.get("runId");
      const provider = details.get(id);
      return provider === undefined ? reply(404, { error: "not_found" }) : reply(200, await provider());
    }
    if (bare === "/api/artifact") {
      const provider = artifacts.get(url);
      return provider === undefined ? reply(404, { error: "not_found" }) : provider();
    }
    return reply(404, { error: "not_found" });
  };
  const restore = () => {
    globalThis.document = BASE.document;
    globalThis.window = BASE.window;
    globalThis.fetch = BASE.fetch;
    if (BASE.navigator) Object.defineProperty(globalThis, "navigator", BASE.navigator); else delete globalThis.navigator;
  };
  return {
    calls, copied, history, location, elements, restore,
    key: (keyName, target = { tagName: "BODY" }) => { const e = { key: keyName, target, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, prevented: false, preventDefault() { this.prevented = true; } }; fire(listeners.document, "keydown", e); return e; },
    clickOn: (node) => { node.click(); fire(listeners.document, "click", { target: node }); },
    back: (to) => { location._hash = to; fire(listeners.window, "hashchange", {}); },
    pagehide: () => fire(listeners.window, "pagehide", {}),
  };
}

let appSerial = 0;
/** Boot a fresh app instance on `hash`; returns the browser controls and `tick()` (one poll + all that follows). */
async function bootApp(t, opts) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: GEN_MS });
  const browser = installBrowser(opts);
  t.after(() => browser.restore());
  appSerial += 1;
  await import(`../../src/owner-dashboard/v2/app.js?instance=${appSerial}`);
  // First let what the page has queued (a hashchange) happen, then fire the timers (a poll it asked for), then let the answers land.
  const tick = async (ms = 0) => { await settle(); t.mock.timers.tick(ms); for (let i = 0; i < 12; i += 1) await settle(); };
  await tick();
  return { ...browser, tick };
}
const sidebarTitle = (b) => byClass(b.elements.sidebar, "sb-title")[0]?.textContent ?? null;
const detailsOf = async (ids) => new Map(await Promise.all(ids.map(async (id) => { const body = await shopDetail(id); return [id, async () => body]; })));
const SHOP_IDS = ["run_quiet", "run_mid", "run_fresh", "run_astra", "run_kimi", "run_sol", "run_rev", "run_cont", "run_fail", "run_stop", "run_done", "run_unres", "run_docs"];

test("A1 a link with a worker opens its panel on load: list and panel are drawn from the real answers, the card is marked, the fragment stays canonical", async (t) => {
  const b = await bootApp(t, { hash: "#workers&run=run_mid&lane=opus", details: await detailsOf(SHOP_IDS) });
  assert.equal(b.location.hash, "#workers?lane=opus&run=run_mid", "the fragment was canonicalized (spelling, order)");
  assert.equal(b.elements.sidebar.attrs.has("hidden"), false);
  assert.equal(sidebarTitle(b), "Refactor payment module");
  assert.equal(byClass(b.elements.sidebar, "sb-run")[0].textContent, "run_mid");
  assert.deepEqual(cardsIn(b.elements.main).map((n) => n.getAttribute("data-fk")), ["card:run_mid", "card:run_fresh"], "lane=opus narrows the list");
  assert.equal(cardsIn(b.elements.main).find((n) => n.getAttribute("aria-pressed") === "true").getAttribute("data-fk"), "card:run_mid");
  assert.deepEqual(byClass(b.elements.main, "chip").map((n) => n.textContent), ["Lane: opus✕"]);
  const asked = b.calls.map((c) => c.url);
  assert.ok(asked.includes("/api/overview") && asked.includes("/api/workers") && asked.includes("/api/attention") && asked.includes("/api/worker?runId=run_mid"));
  assert.ok(b.calls.every((c) => c.init?.headers?.authorization === `Bearer ${TOKEN}` && !String(c.url).includes(TOKEN)), "every request carries the bearer in the header only");
  assert.equal(byClass(b.elements.topbar, "nav-btn").length, 3, "the top bar is there");
  // The next poll refreshes the open worker with the lists (and leaves the page alone).
  const before = b.calls.length;
  await b.tick(5000);
  assert.ok(b.calls.slice(before).some((c) => c.url === "/api/worker?runId=run_mid"), "the open worker is refreshed with every poll");
});

test("A2 the panel follows the fragment: a card opens it, the arrow keys walk the visible order (focusing the card), Esc and the close button close it, back reopens it", async (t) => {
  const b = await bootApp(t, { hash: "#workers", details: await detailsOf(SHOP_IDS) });
  assert.equal(b.elements.sidebar.attrs.has("hidden"), true, "no run in the fragment: no panel");
  b.clickOn(cardsIn(b.elements.main).find((n) => n.getAttribute("data-fk") === "card:run_quiet"));
  await b.tick();
  assert.equal(b.location.hash, "#workers?run=run_quiet");
  assert.equal(sidebarTitle(b), "Migrate orders table");
  // Arrow down / up: the next / previous visible worker, through the fragment, with the focus on its card.
  const down = b.key("ArrowDown");
  assert.equal(down.prevented, true, "a handled key is not left to scroll the page");
  await b.tick();
  assert.equal(b.location.hash, "#workers?run=run_mid");
  assert.equal(sidebarTitle(b), "Refactor payment module");
  assert.equal(fakeDocument.activeElement?.getAttribute("data-fk"), "card:run_mid", "the focus follows the open card");
  b.key("ArrowDown");
  await b.tick();
  assert.equal(b.location.hash, "#workers?run=run_astra", "a review's seats are walked in turn (astra, kimi, sol)");
  b.key("ArrowUp");
  b.key("ArrowUp");
  await b.tick();
  assert.equal(b.location.hash, "#workers?run=run_quiet");
  const stay = b.key("ArrowUp");
  await b.tick();
  assert.equal(b.location.hash, "#workers?run=run_quiet", "up from the first: stay");
  assert.equal(stay.prevented, true);
  // A text field keeps its arrows; keys with modifiers and other keys do nothing.
  const typing = b.key("ArrowDown", { tagName: "INPUT" });
  assert.equal(typing.prevented, false);
  assert.equal(b.key("a").prevented, false);
  await b.tick();
  assert.equal(b.location.hash, "#workers?run=run_quiet");
  // Esc closes (back removes the run from the fragment but keeps the page and the filters).
  b.key("Escape");
  await b.tick();
  assert.equal(b.location.hash, "#workers");
  assert.equal(b.elements.sidebar.attrs.has("hidden"), true);
  assert.equal(b.key("Escape").prevented, false, "nothing open: Esc is left alone");
  // Back: the panel is open again, from the fragment alone.
  b.back("#workers?run=run_fresh");
  await b.tick();
  assert.equal(sidebarTitle(b), "Add pagination");
  const closeBtn = byClass(b.elements.sidebar, "sb-close")[0];
  b.clickOn(closeBtn);
  await b.tick();
  assert.equal(b.location.hash, "#workers");
});

test("A3 A -> B -> A over real timing: an old answer for A that arrives after the user went to B and back never shows", async (t) => {
  const gate = [];
  const slow = (title) => new Promise((resolve) => gate.push({ title, resolve }));
  const staleBody = await shopDetail("run_quiet", { title: "STALE A" });
  const freshBody = await shopDetail("run_quiet", { title: "FRESH A" });
  const detailsMap = await detailsOf(SHOP_IDS);
  let askedA = 0;
  detailsMap.set("run_quiet", () => { askedA += 1; return slow(askedA === 1 ? "first" : "second"); });
  const b = await bootApp(t, { hash: "#workers?run=run_quiet", details: detailsMap });
  assert.equal(gate.length, 1, "the first A is on its way");
  b.clickOn(cardsIn(b.elements.main).find((n) => n.getAttribute("data-fk") === "card:run_mid"));
  await b.tick();
  assert.equal(sidebarTitle(b), "Refactor payment module", "B answered at once");
  b.clickOn(cardsIn(b.elements.main).find((n) => n.getAttribute("data-fk") === "card:run_quiet"));
  await b.tick();
  assert.equal(gate.length, 2, "A is asked for again: a new selection");
  assert.match(byClass(b.elements.sidebar, "message")[0]?.textContent ?? "", /Loading/, "nothing of B (or of the first A) is shown under A");
  gate[0].resolve(staleBody);              // the FIRST A answers last
  await b.tick();
  assert.match(byClass(b.elements.sidebar, "message")[0]?.textContent ?? "", /Loading/, "the old answer is dropped");
  assert.ok(!b.elements.sidebar.textContent.includes("STALE A"));
  gate[1].resolve(freshBody);
  await b.tick();
  assert.equal(sidebarTitle(b), "FRESH A");
  assert.ok(!b.elements.sidebar.textContent.includes("STALE A"));
});

test("A4 clicks: the empty page closes the panel; a card, a control, the panel itself and the top bar do not (the language switch keeps the panel, its tab and the filters)", async (t) => {
  const b = await bootApp(t, { hash: "#workers?run=run_rev&lane=glm-pro", details: await detailsOf(SHOP_IDS) });
  assert.equal(sidebarTitle(b), "Order export");
  // Pick the Brief tab, then switch the language from the top bar: everything stays.
  find(b.elements.sidebar, (n) => n.className === "sb-tab")[2].click();
  await b.tick();
  assert.equal(byClass(b.elements.sidebar, "sb-text")[0].textContent, "# Order export\nBrief of run_rev.");
  const zhButton = byClass(b.elements.topbar, "lang-btn")[1];
  b.clickOn(zhButton);
  await b.tick();
  assert.equal(b.location.hash, "#workers?lane=glm-pro&run=run_rev", "the language switch touches no fragment");
  assert.equal(b.elements.sidebar.attrs.has("hidden"), false, "the panel stays open");
  assert.equal(byClass(b.elements.sidebar, "sb-text")[0].textContent, "# Order export\nBrief of run_rev.", "and so does its tab");
  assert.equal(byClass(b.elements.sidebar, "sb-tab")[2].textContent, "任务书");
  assert.equal(byClass(b.elements.main, "chip")[0].textContent, "车道：glm-pro✕", "and the filter");
  // Inside the panel, on a card, on a chip button: no close.
  b.clickOn(byClass(b.elements.sidebar, "sb-title")[0]);
  b.clickOn(byClass(b.elements.sidebar, "ref")[0]);
  await b.tick();
  assert.equal(b.elements.sidebar.attrs.has("hidden"), false, "a click inside the panel keeps it");
  b.clickOn(cardsIn(b.elements.main).find((n) => n.getAttribute("data-fk") === "card:run_unres"));
  await b.tick();
  assert.equal(b.location.hash, "#workers?lane=glm-pro&run=run_unres", "a card switches the worker (it does not close and reopen)");
  assert.equal(b.elements.sidebar.attrs.has("hidden"), false);
  // On the empty page: closed.
  b.clickOn(byClass(b.elements.main, "wk-list")[0]);
  await b.tick();
  assert.equal(b.location.hash, "#workers?lane=glm-pro");
  assert.equal(b.elements.sidebar.attrs.has("hidden"), true);
});

test("A5 filters and search through the app: every change is a fragment (a history entry), typing replaces the entry, back restores the earlier state, the search follows it", async (t) => {
  const b = await bootApp(t, { hash: "#workers", details: await detailsOf(SHOP_IDS) });
  const ids = () => cardsIn(b.elements.main).map((n) => n.getAttribute("data-fk").slice(5));
  const all = ids().length;
  assert.ok(all >= 13);
  // A select writes its filter.
  byTag(b.elements.main, "select")[1].fire("change", { target: { value: "opus" } });
  await b.tick();
  assert.equal(b.location.hash, "#workers?lane=opus");
  assert.deepEqual(ids(), ["run_mid", "run_fresh"]);
  assert.equal(b.history.pushed.at(-1), "#workers?lane=opus");
  // A second filter, then clearing the first chip only.
  byTag(b.elements.main, "select").find((n) => n.getAttribute("aria-label") === "Status").fire("change", { target: { value: "running" } });
  await b.tick();
  assert.equal(b.location.hash, "#workers?lane=opus&status=running");
  byClass(b.elements.main, "chip-x")[0].click();
  await b.tick();
  assert.equal(b.location.hash, "#workers?status=running", "one chip clears itself only");
  // Typing: the fragment is REPLACED (no history entry per keystroke) and the list follows.
  const pushes = b.history.pushed.length;
  const input = byTag(b.elements.main, "input")[0];
  input.value = "run_mi";
  input.fire("input", { target: input });
  input.value = "run_mid";
  input.fire("input", { target: input });
  await b.tick();
  assert.equal(b.location.hash, "#workers?status=running&q=run_mid");
  assert.equal(b.history.pushed.length, pushes, "typing adds no history entry");
  assert.ok(b.history.replaced.includes("#workers?status=running&q=run_mid"));
  assert.deepEqual(ids(), ["run_mid"]);
  assert.equal(byTag(b.elements.main, "input")[0], input, "the box survived all of it");
  assert.equal(input.value, "run_mid");
  // Back to an earlier state: filters and search both follow the fragment.
  b.back("#workers?lane=opus");
  await b.tick();
  assert.deepEqual(ids(), ["run_mid", "run_fresh"]);
  assert.equal(byTag(b.elements.main, "input")[0].value, "", "the search box follows the fragment when it is not being typed in");
  // A pasted link with search and a worker: both are restored at once.
  b.back("#workers?q=run_s&run=run_quiet");
  await b.tick();
  assert.equal(byTag(b.elements.main, "input")[0].value, "run_s");
  assert.equal(sidebarTitle(b), "Migrate orders table");
});

test("A6 a delivered image: fetched with the bearer when its tab is shown, drawn from a blob URL, and the URL is revoked when the panel closes, the worker changes, the tab changes or the page goes", async (t) => {
  const imgRun = finishedRow("run_img", { taskType: "image", title: "Hero image" });
  const files = ["assets/logo.png", "docs/readme.md", "assets/photo.jpg"];
  const imgBody = await bodyOf({ run: imgRun, events: deliveredEvents("run_img", { files, headOver: { taskType: "image" } }) });
  const path = (i) => `/api/artifact?runId=run_img&commit=${COMMIT("c")}&fileIndex=${i}`;
  const blobs = new Map([[path(0), () => ({ status: 200, ok: true, blob: async () => new Blob([new Uint8Array(4)], { type: "image/png" }) })], [path(2), () => ({ status: 200, ok: true, blob: async () => new Blob([new Uint8Array(4)], { type: "image/jpeg" }) })]]);
  const details = await detailsOf(SHOP_IDS);
  details.set("run_img", async () => imgBody);
  const created = [];
  const revoked = [];
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => { const url = realCreate.call(URL, blob); created.push(url); return url; };
  URL.revokeObjectURL = (url) => { revoked.push(url); return realRevoke.call(URL, url); };
  t.after(() => { URL.createObjectURL = realCreate; URL.revokeObjectURL = realRevoke; });
  const b = await bootApp(t, { hash: "#workers?run=run_img", details, artifacts: blobs });
  const asked = b.calls.filter((c) => String(c.url).startsWith("/api/artifact"));
  assert.deepEqual(asked.map((c) => c.url), [path(0), path(2)], "one request per image file, bound to the commit and the index");
  assert.ok(asked.every((c) => c.init.headers.authorization === `Bearer ${TOKEN}` && !String(c.url).includes(TOKEN)));
  assert.equal(created.length, 2);
  const imgs = byTag(b.elements.sidebar, "img");
  assert.deepEqual(imgs.map((n) => n.getAttribute("src")).sort(), [...created].sort(), "drawn from the blob URLs");
  assert.deepEqual(imgs.map((n) => n.getAttribute("alt")).sort(), ["assets/logo.png", "assets/photo.jpg"]);
  // Another tab: no image on screen, every URL revoked.
  find(b.elements.sidebar, (n) => n.className === "sb-tab")[2].click();
  await b.tick();
  assert.equal(byTag(b.elements.sidebar, "img").length, 0);
  assert.deepEqual([...revoked].sort(), [...created].sort(), "leaving the tab revokes them");
  // Back to the tab: fetched again, new URLs; closing the panel revokes those too.
  find(b.elements.sidebar, (n) => n.className === "sb-tab")[1].click();
  await b.tick();
  assert.equal(created.length, 4);
  b.key("Escape");
  await b.tick();
  assert.equal(created.length, revoked.length, "every URL made has been revoked once the panel is closed");
  assert.equal(new Set(revoked).size, revoked.length, "and none twice");
  // Open it again and leave the page: they go as well.
  b.back("#workers?run=run_img");
  await b.tick();
  assert.equal(created.length, 6);
  b.pagehide();
  assert.equal(created.length, revoked.length, "pagehide releases every URL");
  const { resolveObjectURL } = await import("node:buffer");
  assert.ok(created.every((url) => resolveObjectURL(url) === undefined), "none of the URLs resolves any more");
});

test("A7 the run numbers named on Overview and Attention open the panel on the Workers page", async (t) => {
  const b = await bootApp(t, { hash: "#overview", details: await detailsOf(SHOP_IDS) });
  const named = find(b.elements.main, (n) => n.tag === "button" && n.getAttribute("data-fk")?.startsWith("run:"));
  assert.deepEqual(named.map((n) => n.textContent), ["run_quiet"], "the unhealthy worker the Overview names");
  b.clickOn(named[0]);
  await b.tick();
  assert.equal(b.location.hash, "#workers?run=run_quiet");
  assert.equal(sidebarTitle(b), "Migrate orders table");
  // From an Attention row's workers.
  b.back("#attention");
  await b.tick();
  const row = find(b.elements.main, (n) => n.tag === "button" && n.className === "item-btn")[0];
  row.click();
  await b.tick();
  const open = find(b.elements.main, (n) => n.tag === "button" && n.getAttribute("data-fk")?.startsWith("open:"));
  assert.ok(open.length >= 1, "the selected item's workers are links");
  const target = open[0].textContent;
  b.clickOn(open[0]);
  await b.tick();
  assert.equal(b.location.hash, `#workers?run=${target}`);
  assert.equal(b.elements.sidebar.attrs.has("hidden"), false);
  // A run outside the default range, linked directly: the panel opens and says so.
  const outside = await bootApp(t, { hash: "#workers?run=run_old_done", details: new Map([["run_old_done", async () => shopDetail("run_old_done")]]) });
  assert.equal(sidebarTitle(outside), "Long gone");
  assert.match(byClass(outside.elements.sidebar, "sb-note")[0].textContent, /Not in the default range/);
  assert.equal(cardsIn(outside.elements.main).filter((n) => n.getAttribute("aria-pressed") === "true").length, 0, "no card is marked: it is not listed");
});

// =====================================================================
// G) GUARDS (decision 0131 A3: the /v2 migration of the old guards)
// =====================================================================

const directives = (csp) => new Map(csp.split(";").map((d) => d.trim()).filter(Boolean).map((d) => { const [name, ...values] = d.split(/\s+/); return [name, values]; }));

test("G1 CSP: the /v2 files get the legacy policy plus ONE source — blob: in img-src; the legacy page and every data response are not relaxed", async () => {
  const s = makeServer();
  const legacy = (await drive(s.handler, { url: "/" })).headers["content-security-policy"];
  const base = directives(legacy);
  assert.deepEqual(base.get("img-src"), ["'self'", "data:"]);
  const v2Urls = ["/v2", "/v2/", ...["app.js", "api.js", "artifacts.js", "detail.js", "i18n.js", "model.js", "sidebarview.js", "store.js", "views.js", "workers.js", "workersview.js", "styles.css"].map((f) => `/v2/${f}`)];
  for (const url of v2Urls) {
    const csp = (await drive(s.handler, { url })).headers["content-security-policy"];
    const got = directives(csp);
    assert.deepEqual([...got.keys()], [...base.keys()], `${url}: the same directives, nothing added`);
    for (const [name, values] of base) {
      if (name === "img-src") assert.deepEqual(got.get(name), [...values, "blob:"], `${url}: img-src gains exactly blob:`);
      else assert.deepEqual(got.get(name), values, `${url}: ${name} is untouched`);
    }
    assert.ok(!/unsafe-inline|unsafe-eval|\*|https?:|data:[^ ;]*script/.test(csp), url);
    assert.ok(!/script-src|style-src|connect-src|font-src|frame-src|media-src/.test(csp), `${url}: no further source list`);
  }
  // Not relaxed: the legacy page and its files, the 404, the data routes (JSON and 401), the health route.
  const auth = { authorization: `Bearer ${s.token}` };
  for (const [url, headers] of [["/", {}], ["/app.js", {}], ["/styles.css", {}], ["/nothing", {}], ["/health", {}], ["/api/overview", auth], ["/api/workers", auth], ["/api/attention", auth], ["/api/worker?runId=run_1", auth], ["/api/overview", {}]]) {
    const csp = (await drive(s.handler, { url, headers })).headers["content-security-policy"];
    assert.equal(csp, legacy, `${url} keeps the base policy`);
    assert.ok(!csp.includes("blob:"), url);
  }
});

test("G2 reading the brief (the migrated 'no .prompt' guard): /v2 may show the bound brief the server sends — and still reads no session, path, cwd or raw-command field; the legacy guard stays in ownerDashboardWeb.test.js", () => {
  const v2Code = ["app.js", "api.js", "artifacts.js", "detail.js", "model.js", "sidebarview.js", "store.js", "views.js", "workers.js", "workersview.js"].map(codeOf).join("\n");
  assert.match(codeOf("detail.js"), /body\.brief\.text/, "the brief reaches the panel as the server's brief.text");
  assert.match(codeOf("sidebarview.js"), /vm\.brief\.text/, "and is drawn as text");
  assert.doesNotMatch(v2Code, /\.(sessionId|serveUrl|worktreePath|cwd|rawCommand|argv|pid|transcriptPath)\b/, "no session, path or raw-command field is read in /v2");
  assert.doesNotMatch(v2Code, /\.prompt\b/, "the brief is read from the DTO's brief, never from a prompt field");
  // The legacy file is the one under the old guard, and it is a different file.
  assert.notEqual(readFileSync(join(V2, "..", "app.js"), "utf8"), readV2("app.js"));
});

test("G3 the closed request set and the single network call, with the panel's two routes: /api/worker and /api/artifact", () => {
  const app = codeOf("app.js");
  assert.match(app, /request\(workerPath\(runId\), token\)/, "the detail goes through the closed builder");
  assert.match(app, /requestImage\(artifactPath\(\{ runId: spec\.runId, commit: spec\.commit, fileIndex: spec\.fileIndex \}\), token\)/, "an image is bound to commit and index");
  assert.match(app, /request\(path, token\)/, "the list routes come from endpointsFor");
  assert.deepEqual([...codeOf("api.js").matchAll(/(?<![A-Za-z0-9_$.])fetch\s*\(/g)].length, 1, "ONE direct network call in api.js, shared by the JSON and the image request");
  assert.equal([...codeOf("api.js").matchAll(/await get\(/g)].length, 2, "...used by exactly those two");
  const all = ["app.js", "api.js", "artifacts.js", "detail.js", "model.js", "sidebarview.js", "store.js", "views.js", "workers.js", "workersview.js", "i18n.js"].map((n) => [n, codeOf(n)]);
  for (const [name, code] of all) {
    if (name !== "api.js") assert.doesNotMatch(code, /(?<![A-Za-z0-9_$.])fetch\s*\(/, `${name}: no network call`);
    assert.doesNotMatch(code, /\/api\/worker\/(activity|event)/, `${name}: the Activity routes are not open yet`);
  }
  assert.equal(readV2("api.js").match(/method:\s*["']([A-Z]+)["']/g).join(), 'method: "GET"');
});

test("G4 blob URLs are made and revoked in one place (app.js, through the store); nothing else makes a URL, a Blob or sets a source", () => {
  for (const name of ["api.js", "artifacts.js", "detail.js", "model.js", "sidebarview.js", "store.js", "views.js", "workers.js", "workersview.js"]) {
    const code = codeOf(name);
    assert.doesNotMatch(code, /createObjectURL|revokeObjectURL|new Blob|FileReader|URL\.|window\.open|location\.href/, `${name}: no URL made here`);
    assert.doesNotMatch(code, /\.src\s*=|setAttribute\(\s*["']srcdoc/, `${name}: no assignment to a source`);
  }
  const app = codeOf("app.js");
  assert.equal([...app.matchAll(/URL\.createObjectURL\(blob\)/g)].length, 1);
  assert.equal([...app.matchAll(/URL\.revokeObjectURL\(url\)/g)].length, 1);
  assert.match(app, /window\.addEventListener\("pagehide", \(\) => images\.release\(\)\)/, "leaving the page revokes every one");
  assert.match(app, /images\.want\(wanted\);\s*renderSidebar\(/, "what is on screen is what the store holds: asked at every draw");
  assert.match(codeOf("sidebarview.js"), /h\("img", \{ class: "thumb", src: view\.url, alt: image\.path \}\)/, "an <img> only from a store URL, with the path as its alt text");
  assert.ok(!/<img/i.test(readV2("index.html")), "no image in the page itself");
});

test("G5 the layout of the spec: panel from below the top bar, 45% wide, 1px seam, 24-32px padding, the list stays in the left 55% (cards of two fixed lines, about 64px)", () => {
  const css = readV2("styles.css");
  const rule = (selector) => new RegExp(`${selector.replace(/[.[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  const sidebar = rule(".sidebar");
  assert.match(sidebar, /position:\s*fixed/);
  assert.match(sidebar, /top:\s*var\(--topbar-h\)/, "it starts below the top bar, which stays in place");
  assert.match(sidebar, /right:\s*0/);
  assert.match(sidebar, /bottom:\s*0/);
  assert.match(sidebar, /width:\s*45%/);
  assert.match(sidebar, /display:\s*flex;\s*flex-direction:\s*column/, "a column, so the footer sits at the bottom of the panel even when the content is short");
  assert.match(rule(".sb-foot"), /margin-top:\s*auto/);
  assert.match(css, /\.link-btn\.mono\s*\{\s*font:\s*400 13px\/20px var\(--mono\)/, "a run number that is a button keeps the monospaced face");
  assert.match(sidebar, /padding:\s*24px 32px 0/);
  assert.match(sidebar, /border-left:\s*1px solid var\(--line\)/);
  assert.match(sidebar, /background:\s*var\(--surface\)/);
  assert.match(rule(".sidebar[hidden]"), /display:\s*none/);
  assert.match(rule(".wk-page"), /max-width:\s*calc\(55vw - var\(--gutter\)\)/, "the list never grows under the panel and never re-lays out when it opens");
  assert.match(rule(".wcard-btn"), /min-height:\s*64px/);
  assert.match(rule(".wcard-l1"), /display:\s*grid/, "line one is a grid: fixed columns, nothing wraps");
  assert.match(rule(".wcard-l2"), /white-space:\s*nowrap/);
  assert.match(rule(".wcard-title"), /text-overflow:\s*ellipsis/, "the title is what gives way");
  assert.match(rule(".sb-foot"), /position:\s*sticky/);
  assert.match(css, /@media \(max-width: 1000px\)[\s\S]*\.sidebar \{ width: 100%/, "a narrow window gives the panel the whole width");
  const html = readV2("index.html");
  assert.match(html, /<aside class="sidebar" id="sidebar" hidden><\/aside>/);
  assert.ok(html.indexOf('id="main"') < html.indexOf('id="sidebar"'));
  assert.doesNotMatch(css, /transition|animation|@keyframes|scroll-behavior|will-change|box-shadow/i, "no motion and no shadow (the panel opens and closes at once in this batch)");
});

test("G6 the sources are clean: no control characters, UTF-8 only, and every backslash in a regular expression is a backslash", () => {
  const files = ["app.js", "api.js", "artifacts.js", "detail.js", "i18n.js", "model.js", "sidebarview.js", "store.js", "views.js", "workers.js", "workersview.js", "styles.css", "index.html"];
  for (const name of files) {
    const bytes = readFileSync(join(V2, name));
    const text = bytes.toString("utf8");
    assert.ok(!text.includes(String.fromCharCode(0xfffd)), `${name}: valid UTF-8`);
    // eslint-disable-next-line no-control-regex
    assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text), false, `${name}: no control character (a \\b in a regex written as a backspace byte, for one)`);
  }
  const mine = readFileSync(join(HERE, "ownerDashboardV2Workers.test.js"), "utf8");
  // eslint-disable-next-line no-control-regex
  assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(mine), false, "this test file is clean too");
});

test("G7 the batch's own words: no placeholder left, no 'queued', and the new text exists in both languages (the same keys, the same placeholders)", () => {
  assert.ok(!("workers.soon" in i18n.STRINGS.en) && !("workers.soon" in i18n.STRINGS.zh));
  for (const lang of i18n.LANGS) {
    for (const [key, value] of Object.entries(i18n.STRINGS[lang])) assert.doesNotMatch(value, /queued|排队/i, `${lang}.${key}`);
  }
  for (const prefix of ["wk.", "sb."]) {
    const en = Object.keys(i18n.STRINGS.en).filter((k) => k.startsWith(prefix)).sort();
    const zh = Object.keys(i18n.STRINGS.zh).filter((k) => k.startsWith(prefix)).sort();
    assert.ok(en.length > 30, `${prefix}: the batch's words are there (${en.length})`);
    assert.deepEqual(zh, en, `${prefix}: both languages carry the same keys`);
  }
});

test("G8 the new test file is registered in test/manifest.json exactly once", () => {
  const manifest = readFileSync(join(HERE, "..", "manifest.json"), "utf8");
  assert.equal(manifest.split('"isolation-infra/ownerDashboardV2Workers.test.js"').length - 1, 1);
});

// =====================================================================
// F) BATCH 143a, FIX 1 — the review's findings, each with a test that failed before the change
// =====================================================================

const variantChain = (mutate) => { const snap = shopSnapshot(); mutate(snap); return chain(snap); };
const rowOfRun = (snap, runId) => snap.runs.find((r) => r.runId === runId);
const domOrder = (root) => cardsIn(root).map((n) => n.getAttribute("data-fk").slice("card:".length));

test("F1 a delivery whose facts contradict each other is NOT 'no deliverable': the server's conflict DTO (no commit at all) shows its reason and invents nothing", async () => {
  const events = deliveredEvents("run_cf");
  const created = events.find((e) => e.type === "run.delivery_created");
  events.push({ ...created, seq: events.length + 1, ts: iso(T0 + 6500), delivery: structuredClone(created.delivery) }); // a second, contradicting delivery_created
  const body = await bodyOf({ run: finishedRow("run_cf"), events });
  assert.deepEqual(body.deliverable, {
    kind: "code", state: "unavailable", reason: "delivery_facts_conflict", commit: null, files: null, verification: null, reviews: [],
  }, "fixture: this is the server's own conflict answer");
  const vm = panelOf(body);
  assert.deepEqual([vm.deliverable.kind, vm.deliverable.state, vm.deliverable.reason, vm.deliverable.commit, vm.deliverable.files, vm.deliverable.verification],
    ["code", "unavailable", "delivery_facts_conflict", null, null, null], "an unavailable delivery does not depend on a commit");
  const { root } = panelRoot(vm);
  const text = byClass(root, "sb-panel")[0].textContent;
  assert.ok(text.includes("A delivery was recorded, but it cannot be shown."), text);
  assert.ok(text.includes("The delivery facts contradict each other, or the repository."), `the closed reason, in words: ${text}`);
  assert.ok(!text.includes("No deliverable observed yet."), "never 'not observed': something WAS recorded");
  assert.equal(textsOf(root, "sb-h").length, 0, "no Commit / Verification block without a commit or a verification");
  assert.equal(byClass(root, "file-row").length, 0);
  const zh = panelRoot(vm, "zh").root;
  assert.ok(byClass(zh, "sb-panel")[0].textContent.includes("记录里有交付，但无法显示。交付事实自相矛盾，或与仓库对不上。"), byClass(zh, "sb-panel")[0].textContent);
  assert.ok(!byClass(zh, "sb-panel")[0].textContent.includes("尚未观测到交付物"));
  // An image delivery in conflict: same, and no image is asked for.
  const imgEvents = deliveredEvents("run_cfi", { files: ["assets/a.png"], headOver: { taskType: "image" } });
  const imgCreated = imgEvents.find((e) => e.type === "run.delivery_created");
  imgEvents.push({ ...imgCreated, seq: imgEvents.length + 1, ts: iso(T0 + 6500), delivery: structuredClone(imgCreated.delivery) });
  const img = panelOf(await bodyOf({ run: finishedRow("run_cfi", { taskType: "image" }), events: imgEvents }));
  assert.deepEqual([img.deliverable.kind, img.deliverable.state, img.deliverable.commit], ["image", "unavailable", null]);
  assert.deepEqual(detail.imagesWanted(img, "deliverable"), []);
  assert.ok(!panelRoot(img).root.textContent.includes("No deliverable observed yet."));
  // The same reason when a commit IS known (the object just cannot be read) keeps the commit block.
  const gone = panelRoot(panelOf(await bodyOf({ run: finishedRow("run_g3"), events: deliveredEvents("run_g3"), prove: proveGone }))).root;
  assert.ok(textsOf(gone, "sb-h").includes("Commit cccccccc"));
  // And a delivery that is simply not there yet is still 'not observed'.
  assert.equal(panelOf(await bodyOf({ run: snapLive("run_nx"), events: (() => { const b = builder("run_nx"); head(b); return b.events; })() })).deliverable.kind, "none");
});

test("F2 finished cards say how many files a delivery changed and the verdict of an answered review seat — from the server's snapshot facts, never a path", async () => {
  const bodies = await variantChain((snap) => {
    rowOfRun(snap, "run_rev").delivery.changedCount = 1;
    rowOfRun(snap, "run_unres").delivery.changedCount = null;
    rowOfRun(snap, "run_cont").delivery.changedCount = 0;
    // the review: three answered seats with the three verdicts, a fourth that is done but silent
    const kimi = rowOfRun(snap, "run_kimi");
    Object.assign(kimi, { state: "completed", terminal: true, liveness: "terminal", stage: "terminal", terminalAt: ago(MIN), lastEffectAt: ago(MIN) });
    snap.runs.push(snapRun("run_mute", { taskType: "delivery_review", laneId: "mute", agentId: "mute", title: "Delivery review: order export", terminalAt: ago(20 * MIN) }));
    snap.consults[0].seats = [snapSeat("run_sol", "PASS_WITH_NOTES"), snapSeat("run_astra", "FIX_FIRST"), snapSeat("run_kimi", "PASS"), snapSeat("run_mute", null, { runState: "completed", replied: false })];
  });
  const vm = workers.buildWorkers(bodies, { refMs: GEN_MS, view: workers.emptyView() });
  const { root } = pageOf(vm);
  const l2 = (id) => line(cardByRun(root, id), 2);
  assert.equal(l2("run_rev"), "Done 4h ago · aaaaaaaa · 1 file · verify passed · awaiting Lead", "one file is singular");
  assert.equal(l2("run_unres"), "Done 5h ago · 01234567 · verify passed · awaiting Lead", "no count on record: none is shown, none invented");
  assert.equal(l2("run_cont"), "Done 1h ago · eeeeeeee · 0 files · verify passed · awaiting Lead", "zero is a count too");
  assert.equal(l2("run_sol"), "Done 40m ago · PASS_WITH_NOTES");
  assert.equal(l2("run_astra"), "Done 30m ago · FIX_FIRST");
  assert.equal(l2("run_kimi"), "Done 1m ago · PASS");
  assert.equal(l2("run_mute"), "Done 20m ago", "a seat that finished without answering has no verdict");
  assert.equal(l2("run_fail"), "Failed 30m ago · backend_error", "a run with no delivery or review has neither");
  const zh = pageOf(vm, "zh").root;
  assert.equal(line(cardByRun(zh, "run_rev"), 2), "完成 4 小时前 · aaaaaaaa · 1 个文件 · 验证通过 · 等 Lead 裁决");
  // The row carries a number and a closed word, nothing path-like.
  const row = bodies.workers.workers.find((r) => r.runId === "run_rev");
  assert.equal(typeof row.delivery.changedCount, "number");
  assert.ok(!/[\\/]/.test(JSON.stringify(row.delivery)), "no path in the delivery summary");
});

test("F3 the note for a worker that is not in the list: with a filter it says 'not in the current list'; the detail upgrades it to 'hidden by the project filter' for another project; only no-filter + uncut list says 'outside the default range' (real project queries)", async () => {
  const bodies = await variantChain((snap) => {
    snap.runs.push(snapLive("run_docs_live", { project: { slug: "docs-site", name: "docs-site" }, title: "Live docs work", laneId: "fable", agentId: "fable" }));
  });
  const filtered = await bodies.get("/api/workers?project=shop-api");
  assert.ok(!filtered.workers.some((r) => r.runId === "run_docs_live"), "fixture: the real project query leaves the other project out");
  assert.ok((await bodies.get("/api/workers")).workers.some((r) => r.runId === "run_docs_live"), "while it IS in the default range, still running");
  const vmFor = (view, body = filtered) => workers.buildWorkers({ overview: bodies.overview, workers: body, attention: bodies.attention }, { refMs: GEN_MS, view });
  const messageFor = (open) => detail.buildSidebar({ feed: { runId: open.runId, epoch: 1, phase: "loading", body: null, problem: null }, open, nowMs: GEN_MS });

  // 1. A project filter, and a run of ANOTHER project that is still running: not out of range!
  const crossView = { ...workers.emptyView("shop-api"), run: "run_docs_live" };
  const cross = vmFor(crossView);
  assert.deepEqual([cross.open.note, cross.open.project], ["unlisted", "shop-api"], "the list cannot say why it is missing");
  assert.equal(messageFor(cross.open).note, "unlisted");
  const docsRow = snapLive("run_docs_live", { project: { slug: "docs-site", name: "docs-site" }, title: "Live docs work" });
  const docsBody = await bodyOf({ run: docsRow, events: (() => { const b = builder("run_docs_live"); head(b); working(b, T0 + 3000); return b.events; })() });
  const crossPanel = detail.buildSidebar({ feed: { runId: "run_docs_live", epoch: 1, phase: "ready", body: docsBody, problem: null }, open: cross.open, nowMs: GEN_MS });
  assert.equal(crossPanel.note, "projectHidden", "once the detail shows another project, say that the project filter hides it");
  const crossText = byClass(panelRoot(crossPanel).root, "sb-note")[0].textContent;
  assert.equal(crossText, "Hidden by the project filter: this worker belongs to another project.");
  assert.ok(!crossText.includes("24 hours") && !/default range/.test(crossText), "no claim that it is old or out of range — it is running");
  assert.equal(byClass(panelRoot(crossPanel, "zh").root, "sb-note")[0].textContent, "被项目筛选隐藏：这个 worker 属于另一个项目。");
  // 2. A project filter, a run of the SAME project that is just not listed (old): all that is known is "not in the list".
  const sameView = { ...workers.emptyView("shop-api"), run: "run_old_done" };
  const same = vmFor(sameView);
  assert.equal(same.open.note, "unlisted");
  const oldBody = await shopDetail("run_old_done");
  const samePanel = detail.buildSidebar({ feed: { runId: "run_old_done", epoch: 1, phase: "ready", body: oldBody, problem: null }, open: same.open, nowMs: GEN_MS });
  assert.equal(samePanel.note, "unlisted", "same project: the filter is not what hides it");
  assert.equal(byClass(panelRoot(samePanel).root, "sb-note")[0].textContent, "Not in the current list (the filters or the default range).");
  assert.equal(byClass(panelRoot(samePanel, "zh").root, "sb-note")[0].textContent, "不在当前列表里（筛选或默认范围）。");
  // 3. Any other filter: the same plain statement (never 'outside the default range').
  assert.equal(vmFor({ ...workers.emptyView(), lane: "opus", run: "run_old_done" }, bodies.workers).open.note, "unlisted");
  assert.equal(vmFor({ ...workers.emptyView(), q: "zzz", run: "run_old_done" }, bodies.workers).open.note, "unlisted");
  // 4. No filter, list not cut: only now it is outside the default range. List cut: no claim.
  assert.equal(vmFor({ ...workers.emptyView(), run: "run_old_done" }, bodies.workers).open.note, "outOfRange");
  assert.equal(vmFor({ ...workers.emptyView(), run: "run_old_done" }, { ...bodies.workers, truncated: true }).open.note, null);
  // 5. Listed but hidden by a filter stays its own note; listed and shown has none.
  assert.equal(vmFor({ ...workers.emptyView(), lane: "opus", run: "run_quiet" }, bodies.workers).open.note, "filtered");
  assert.equal(vmFor({ ...workers.emptyView("shop-api"), run: "run_quiet" }).open.note, null);
});

test("F4 a review stays ONE group while any seat is unfinished — Starting or not; only a Starting run that belongs to no review folds into the Starting line; the arrow keys walk exactly the order that is drawn", async () => {
  const bodies = await variantChain((snap) => {
    Object.assign(rowOfRun(snap, "run_kimi"), { stage: "starting", lastEffectAt: null }); // the last seat has just been handed over
  });
  const vm = workers.buildWorkers(bodies, { refMs: GEN_MS, view: workers.emptyView() });
  const group = vm.running.entries.find((e) => e.kind === "group");
  assert.deepEqual(group.cards.map((c) => [c.runId, c.outcome === null ? "unfinished" : "ended"]), [["run_astra", "ended"], ["run_kimi", "unfinished"], ["run_sol", "ended"]],
    "the two answered seats stay with the review, and so does the seat that is still Starting");
  assert.equal(group.finished, false);
  assert.ok(!vm.finished.entries.some((e) => e.kind === "group" || (e.kind === "card" && ["run_sol", "run_astra"].includes(e.card.runId))), "the answered seats are not pulled to Finished");
  assert.deepEqual(vm.starting.cards.map((c) => c.runId), ["run_s2", "run_s1"], "the Starting line holds only the runs that belong to no review");
  assert.equal(vm.starting.count, 2);
  assert.equal(cardOf(vm, "run_kimi").status, "starting");
  assert.equal(line(cardByRun(pageOf(vm).root, "run_kimi"), 2), "Starting 6m · no progress yet");
  // One order for the page and for the keys: the drawn cards ARE the sequence — closed, hand-opened, filtered.
  for (const [what, options, view] of [
    ["closed", {}, workers.emptyView()],
    ["opened by hand", { startingOpen: true }, workers.emptyView()],
    ["opened by the status filter", {}, { ...workers.emptyView(), status: "starting" }],
    ["a lane filter", { startingOpen: true }, { ...workers.emptyView(), lane: "sol" }],
    ["a project filter", { startingOpen: true }, workers.emptyView("shop-api")],
  ]) {
    const v = await listOf(view, { bodies, ...options });
    assert.deepEqual(domOrder(pageOf(v).root), v.sequence, `${what}: the page draws the cards in the order the arrow keys walk`);
  }
  // Open the Starting line by hand: from the last running card, Down goes to the first Starting card — not to Finished.
  const opened = await listOf(workers.emptyView(), { bodies, startingOpen: true });
  const lastRunning = opened.running.entries.flatMap((e) => (e.kind === "group" ? e.cards : [e.card])).at(-1).runId;
  assert.equal(workers.neighborRun(opened.sequence, lastRunning, 1), "run_s2", "the next card on screen");
  assert.equal(workers.neighborRun(opened.sequence, "run_s1", 1), opened.finished.entries[0].card.runId, "and after the Starting cards, the first Finished one");
  const closed = await listOf(workers.emptyView(), { bodies });
  assert.equal(workers.neighborRun(closed.sequence, lastRunning, 1), closed.finished.entries[0].card.runId, "a closed Starting line is not in the walk");
  // When the Starting seat is the only one left, the review moves with it; and with all seats ended it is Finished.
  const allDone = await variantChain((snap) => {
    Object.assign(rowOfRun(snap, "run_kimi"), { state: "completed", terminal: true, liveness: "terminal", stage: "terminal", terminalAt: ago(MIN), lastEffectAt: ago(MIN) });
    snap.consults[0].seats[2] = snapSeat("run_kimi", "PASS");
  });
  const done = workers.buildWorkers(allDone, { refMs: GEN_MS, view: workers.emptyView() });
  assert.ok(done.finished.entries.some((e) => e.kind === "group" && e.cards.length === 3));
});

test("F5 a run with no bound stage is 'stage unknown' (plan A6), the same in the list and the panel: not Starting, no invented start; Running group; the filter 'starting' does not match it", async () => {
  const combos = [
    ["pending", "starting"], ["submitted", "starting"], ["pending", "stage_unknown"], ["submitted", "stage_unknown"], ["running", "active"], ["running", "stage_unknown"],
  ];
  const rows = combos.map(([state, stage], i) => snapLive(`run_c${i}`, {
    state, stage, title: `${state}/${stage}`, startedAt: ago(5 * MIN), stageSince: stage === "starting" ? ago(20_000) : null, lastEffectAt: null, quietSince: ago(MIN),
  }));
  const bodies = await chain(snapshotOf({ runs: rows }));
  const vm = workers.buildWorkers(bodies, { refMs: GEN_MS, view: workers.emptyView() });
  const inStartingLine = new Set(vm.starting.cards.map((c) => c.runId));
  const inRunning = new Set(vm.running.entries.map((e) => e.card.runId));
  assert.deepEqual([...inStartingLine].sort(), ["run_c0", "run_c1"], "only the server's bound stage 'starting' folds into the Starting line");
  assert.deepEqual([...inRunning].sort(), ["run_c2", "run_c3", "run_c4", "run_c5"], "pending / submitted without a stage stay in Running, unclaimed");
  assert.deepEqual(combos.map((_, i) => cardOf(vm, `run_c${i}`).status), ["starting", "starting", "unknown", "unknown", "running", "running"]);
  // The filters: 'starting' is the bound stage only; 'running' is a running worker only; nothing matches 'unknown'.
  const ids = async (status) => { const v = workers.buildWorkers(bodies, { refMs: GEN_MS, view: { ...workers.emptyView(), status } }); return [...new Set([...v.sequence, ...v.starting.cards.map((c) => c.runId)])].sort(); };
  assert.deepEqual(await ids("starting"), ["run_c0", "run_c1"]);
  assert.deepEqual(await ids("running"), ["run_c4", "run_c5"]);
  // The card: the word, no duration, no 'Starting'.
  const { root } = pageOf(vm);
  assert.equal(line(cardByRun(root, "run_c2"), 2), "Stage unknown · no progress yet", "no time since an unobserved stage began");
  assert.equal(line(cardByRun(root, "run_c4"), 2), "Running 5m · no progress yet");
  assert.equal(line(cardByRun(root, "run_c3"), 2), "Stage unknown · no progress yet", "submitted with no stage: the same");
  assert.equal(line(cardByRun(pageOf(workers.buildWorkers(bodies, { refMs: GEN_MS, view: workers.emptyView(), startingOpen: true })).root, "run_c0"), 2), "Starting 5m · no progress yet");
  assert.equal(line(cardByRun(pageOf(vm, "zh").root, "run_c2"), 2), "阶段未知 · 还没有实质进展");
  // The panel agrees: Starting is lit exactly where the list folded the run into the Starting line.
  for (let i = 0; i < combos.length; i += 1) {
    const row = rows[i];
    const panel = panelOf(await bodyOf({ run: row, events: (() => { const b = builder(row.runId); head(b); return b.events; })() }));
    const axis = panel.axes.run;
    assert.equal(axis.steps[0].mark === "current", inStartingLine.has(row.runId), `${combos[i].join("/")}: Starting lit in the panel <=> in the Starting line`);
    assert.equal(axis.stageUnknown, combos[i][1] === "stage_unknown", `${combos[i].join("/")}: the panel says 'stage unknown' for the same runs`);
    assert.equal(axis.startingAgeMs !== null, combos[i][1] === "starting", "an age only where a stage start is bound");
  }
  const unknownPanel = panelOf(await bodyOf({ run: rows[2], events: (() => { const b = builder("run_c2"); head(b); return b.events; })() }));
  const unknownRoot = panelRoot(unknownPanel).root;
  const steps = byClass(byClass(unknownRoot, "axis")[0], "step").map((s) => s.textContent);
  assert.deepEqual(steps, ["?Starting (not observed)", "○Running (not yet)"]);
  assert.equal(byClass(unknownRoot, "axis-notes")[0].textContent, "stage unknown");
  assert.ok(!unknownRoot.textContent.includes("starting for"), "no age is made up");
  assert.equal(byClass(panelRoot(unknownPanel, "zh").root, "axis-notes")[0].textContent, "阶段未知");
});

test("F6 Copy ref carries the event number the evidence names for THIS run (the greatest one); without evidence it stays the bare run number", async () => {
  const bodies = await variantChain((snap) => {
    // a rate-limited failure: the failed item's evidence (terminal event 40) and the lane item's (observed at 33)
    snap.runs.push(snapRun("run_cap", { state: "failed", laneId: "kimi", agentId: "kimi", terminalAt: ago(35 * MIN), terminalSeq: 40, failure: { category: "provider_capacity", code: "rate_limited" }, capacity: { code: "rate_limited", observedAt: ago(35 * MIN), observedSeq: 33 } }));
    snap.runs.push(snapRun("run_cap2", { state: "failed", laneId: "kimi", agentId: "kimi", terminalAt: ago(34 * MIN), terminalSeq: 30, failure: { category: "provider_capacity", code: "rate_limited" }, capacity: { code: "rate_limited", observedAt: ago(34 * MIN), observedSeq: 36 } }));
  });
  const refOf = async (runId) => {
    const vm = workers.buildWorkers(bodies, { refMs: GEN_MS, view: { ...workers.emptyView(), run: runId } });
    const row = rowOfRun(shopSnapshot(), runId) ?? snapRun(runId);
    const body = await bodyOf({ run: row, events: (() => { const b = builder(runId); head(b); return b.events; })() });
    return detail.buildSidebar({ feed: { runId, epoch: 1, phase: "ready", body, problem: null }, open: vm.open, nowMs: GEN_MS }).ref;
  };
  assert.equal(await refOf("run_fail"), "run_fail#0090", "a failed run: its terminal event");
  assert.equal(await refOf("run_quiet"), "run_quiet#0138", "a silent run: the last real action");
  assert.equal(await refOf("run_rev"), "run_rev#0007", "a delivery waiting for the Lead: the settle event — not the seats' events of the review of it");
  assert.equal(await refOf("run_sol"), "run_sol#0012", "a review seat: the event the split names for it");
  assert.equal(await refOf("run_mid"), "run_mid", "nothing observed for it: the bare run number");
  assert.equal(await refOf("run_done"), "run_done");
  // The evidence of the same run in two items: the latest event number wins, whichever item names it.
  assert.equal(workers.evidenceSeqFor(bodies.attention, "run_cap"), 40);
  assert.equal(workers.evidenceSeqFor(bodies.attention, "run_cap2"), 36);
  assert.equal(await refOf("run_cap2"), "run_cap2#0036");
  // Evidence of another run, no evidence at all, or no number (an old transcript) gives nothing.
  assert.equal(workers.evidenceSeqFor(bodies.attention, "run_nope"), null);
  assert.equal(workers.evidenceSeqFor({ decide: [], anomalies: [], resolved: [] }, "run_fail"), null);
  assert.equal(workers.evidenceSeqFor(undefined, "run_fail"), null);
  assert.equal(workers.evidenceSeqFor({ anomalies: [{ evidence: [{ runId: "run_x", at: GEN, seq: null }, { runId: "run_x", at: GEN, seq: 0 }, { runId: "run_x", at: GEN, seq: -3 }, { runId: "run_y", seq: 9 }] }] }, "run_x"), null);
  // The footer shows exactly the string that is copied.
  const ready = async (runId) => { const vm = workers.buildWorkers(bodies, { refMs: GEN_MS, view: { ...workers.emptyView(), run: runId } }); return detail.buildSidebar({ feed: { runId, epoch: 1, phase: "ready", body: await shopDetail(runId), problem: null }, open: vm.open, nowMs: GEN_MS }); };
  const failedPanel = await ready("run_fail");
  const { root, actions } = panelRoot(failedPanel);
  assert.equal(byClass(root, "ref")[0].textContent, "run_fail#0090");
  byClass(root, "btn")[0].click();
  assert.equal(actions.calls.pop()[1].ref, "run_fail#0090");
  // A message state (detail not here yet) carries it too.
  const vmFail = workers.buildWorkers(bodies, { refMs: GEN_MS, view: { ...workers.emptyView(), run: "run_fail" } });
  assert.equal(detail.buildSidebar({ feed: { runId: "run_fail", epoch: 1, phase: "loading", body: null, problem: null }, open: vmFail.open, nowMs: GEN_MS }).ref, "run_fail#0090");
  // The same string in both languages.
  assert.equal(byClass(panelRoot(failedPanel, "zh").root, "ref")[0].textContent, "run_fail#0090");
});

// ----- layout (the CSS the review measured; the real wrapping is looked at in a browser) -----

const cssSource = readV2("styles.css");
const cssRule = (selector) => new RegExp(`(?:^|\\n)${selector.replace(/[.[\]()|*+?^$\\/]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(cssSource)?.[1] ?? "";
const px = (text, pattern) => { const m = pattern.exec(text); assert.ok(m, `${pattern} in ${JSON.stringify(text)}`); return Number(m[1]); };

test("F7a the filter row (five selects + the search box) is ONE row at 1440px: fixed-basis selects that may shrink, an upper limit, a search box from 160px; only a narrower window wraps", () => {
  const gutter = px(cssSource, /--gutter:\s*(\d+)px/);
  const listWidth = Math.round(1440 * 0.55) - gutter;   // .wk-page: calc(55vw - var(--gutter))
  assert.match(cssRule(".wk-page"), /max-width:\s*calc\(55vw - var\(--gutter\)\)/);
  assert.equal(listWidth, 744);
  const select = cssRule(".wk-select");
  const filters = cssRule(".wk-filters");
  const basis = px(filters, /--wk-select:\s*(\d+)px/);
  assert.match(select, /flex:\s*0 1 var\(--wk-select\)/, "each select has the one fixed basis");
  assert.match(select, /min-width:\s*0\b/, "a select may shrink below its content");
  const max = px(select, /max-width:\s*(\d+)px/);
  assert.ok(max >= basis && max <= 160, "and has an upper limit");
  const search = cssRule(".wk-search");
  const searchMin = px(search, /min-width:\s*(\d+)px/);
  assert.ok(searchMin >= 150 && searchMin <= 180, `the search box starts at about 160px (${searchMin})`);
  assert.match(search, /flex:\s*1 1 \d+px/, "and takes what is left");
  const gap = px(filters, /gap:\s*(\d+)px/);
  const topGap = px(cssRule(".wk-top"), /gap:\s*\d+px (\d+)px/);
  assert.match(filters, new RegExp(`flex:\\s*0 1 calc\\(5 \\* var\\(--wk-select\\) \\+ 4 \\* ${gap}px\\)`), "the block of five selects is as wide as five selects and four gaps — and no wider");
  assert.match(filters, /flex-wrap:\s*nowrap/, "the five never wrap inside their block (a narrower window moves the search box, not a select)");
  assert.match(filters, /min-width:\s*0/);
  const needed = 5 * basis + 4 * gap + topGap + searchMin;
  assert.ok(needed <= listWidth, `five selects + search need ${needed}px of the ${listWidth}px column: one row at 1440`);
  // Nothing about the content can widen a select: no auto / content-sized width, whatever the language or the longest option.
  assert.doesNotMatch(select, /width:\s*(auto|max-content|min-content|fit-content)/);
  const labels = [...i18n.LANGS].flatMap((lang) => ["project", "lane", "type", "status", "health"].map((k) => i18n.t(lang, `wk.filter.${k}`)));
  const widest = Math.max(...labels.map((label) => [...label].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 14 : 8), 0)));
  assert.ok(widest + 2 * 10 + 24 <= basis, `the closed select shows its label (an estimate: ${widest}px + padding + arrow) inside ${basis}px, in both languages`);
  // Narrower windows wrap instead of overflowing.
  assert.match(cssRule(".wk-top"), /flex-wrap:\s*wrap/);
  // The chips (a set filter) are bounded as well.
  assert.match(cssRule(".wk-filters .chip"), /max-width:\s*\d+px/);
});

test("F7a2 a set filter is a chip as wide as its words: the block may then wrap (the search box moves down) instead of cutting the chip", async () => {
  const none = pageOf(await listOf()).root;
  assert.equal(byClass(none, "wk-filters")[0].className, "wk-filters", "no chip: the fixed one-row block");
  const set = pageOf(await listOf({ ...workers.emptyView("shop-api"), lane: "opus" })).root;
  assert.equal(byClass(set, "wk-filters")[0].className, "wk-filters wk-filters-chips");
  assert.match(cssRule(".wk-filters-chips"), /flex:\s*0 1 auto/);
  assert.match(cssRule(".wk-filters-chips"), /flex-wrap:\s*wrap/);
  // Clearing the last chip returns to the fixed block, on the same element.
  const root = region();
  renderWorkersPage(root, await listOf({ ...workers.emptyView("shop-api") }), "en", recorder());
  const block = byClass(root, "wk-filters")[0];
  assert.equal(block.className, "wk-filters wk-filters-chips");
  renderWorkersPage(root, await listOf(), "en", recorder());
  assert.equal(byClass(root, "wk-filters")[0], block, "the same element");
  assert.equal(block.className, "wk-filters");
});
test("F7b the card: type, lane and run number own FIXED columns (English sets the width) so the run number never moves with the language; the title is serif 600 22/30 and the card stays 64px", async () => {
  const l1 = cssRule(".wcard-l1");
  assert.match(l1, /display:\s*grid/);
  const tracks = /grid-template-columns:\s*([^;]+);/.exec(l1)[1].trim();
  const m = /^(\d+)px minmax\(0, 1fr\) (\d+)px (\d+)px (\d+)px$/.exec(tracks);
  assert.ok(m, `five tracks: symbol, title, type, lane, run number — all but the title fixed px (${tracks})`);
  const [symbolCol, typeCol, laneCol, runCol] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  const gap = px(l1, /column-gap:\s*(\d+)px/);
  // English decides (an estimate of the widest English word at 14px sans / 13px mono):
  const widestType = Math.max(...model.TASK_TYPES.map((type) => i18n.t("en", `type.${type}`).length));
  assert.ok(typeCol >= widestType * 7, `the type column holds the longest English type (${widestType} chars)`);
  assert.ok(laneCol >= "deepseek-flash".length * 7, "the lane column holds a long lane name");
  assert.ok(runCol >= "run_20261124120411173esiy9d".length * 7.8, "the run column holds a whole run number");
  assert.match(cssRule(".wcard-l2"), new RegExp(`padding-left:\\s*${symbolCol + gap}px`), "line two starts under the title");
  assert.match(cssRule(".wcard-title"), /font:\s*600 22px\/30px var\(--serif\)/, "the title: the serif 'item title' level of the README");
  assert.match(cssRule(".wcard-run"), /white-space:\s*nowrap/);
  // 64px: title line + line two + padding.
  const titleLine = px(cssRule(".wcard-title"), /font:\s*600 22px\/(\d+)px/);
  const lineTwo = px(cssRule(".wcard-l2"), /font:\s*400 14px\/(\d+)px/);
  const pad = px(cssRule(".wcard-btn"), /padding:\s*(\d+)px \d+px/);
  assert.equal(titleLine + lineTwo + 2 * pad, 64, "two lines + padding = the 64px card");
  assert.match(cssRule(".wcard-btn"), /min-height:\s*64px/);
  // In the DOM: five cells in both languages — even without a lane — and the run number is the last, in a cell of its own.
  const bodies = await variantChain((snap) => { snap.runs.push(snapLive("run_nolane", { laneId: null, agentId: null, title: "No lane", startedAt: ago(3 * MIN) })); });
  const vm = workers.buildWorkers(bodies, { refMs: GEN_MS, view: workers.emptyView() });
  for (const lang of ["en", "zh"]) {
    const { root } = pageOf(vm, lang);
    for (const id of ["run_quiet", "run_nolane", "run_kimi", "run_rev"]) {
      const cells = byClass(cardByRun(root, id), "wcard-l1")[0].children.map((n) => n.className.split(" ")[0]);
      assert.deepEqual(cells, ["sym", "wcard-head", "wcard-type", "wcard-lane", "wcard-run"], `${lang}/${id}: the same five cells, run number last`);
    }
    assert.equal(byClass(cardByRun(root, "run_nolane"), "wcard-lane")[0].textContent, "");
  }
});

test("F8 Deliverable reads Commit -> Verification -> the Lead's decision (-> the review), the ticks of finished steps are the secondary grey, and a tab that is not picked is weight 400", async () => {
  const run = finishedRow("run_code");
  const seatRows = [finishedRow("run_sol", { deliveryRequested: false, taskType: "delivery_review", laneId: "sol", agentId: "sol" }), finishedRow("run_astra", { deliveryRequested: false, taskType: "delivery_review", laneId: "astra", agentId: "astra" })];
  const vm = panelOf(await bodyOf({ run, events: deliveredEvents("run_code"), runs: [run, ...seatRows], consults: [snapConsult({ reviewedRunId: "run_code", seats: [snapSeat("run_sol", "PASS"), snapSeat("run_astra", "FIX_FIRST")] })] }));
  const { root } = panelRoot(vm);
  const order = [];
  byClass(root, "sb-panel")[0].walk((n) => {
    const cls = n.className.split(" ");
    if (cls.includes("sb-h")) order.push(`h:${n.textContent.trim()}`);
    else if (cls.includes("sb-decision")) order.push("decision");
    else if (cls.includes("files")) order.push("files");
  });
  assert.deepEqual(order, ["h:Commit cccccccc", "files", "h:Verification", "decision", "h:Delivery review consult_order"], "Commit (with its files), Verification, the Lead's decision, then the review of it");
  // The design's ticks: grey, not ink; the current dot and a problem keep their own look.
  assert.match(cssRule(".step-done .step-glyph"), /color:\s*var\(--ink-2\)/);
  assert.match(cssRule(".step-bad .step-glyph"), /color:\s*var\(--amber\)/);
  assert.doesNotMatch(cssRule(".step-current"), /--ink-2/);
  // Tabs: 400 until picked, 600 when picked.
  assert.match(cssRule(".sb-tab"), /font:\s*400 16px\/24px var\(--sans\)/);
  assert.match(cssRule('.sb-tab[aria-pressed="true"]'), /font-weight:\s*600/);
  // The footer has ONE margin-top (the pinning `auto`); a later 8px used to cancel it.
  assert.equal([...cssRule(".sb-foot").matchAll(/margin-top:/g)].length, 1);
  assert.match(cssRule(".sb-foot"), /margin-top:\s*auto/);
});

test("F9a the app, a project filter and a worker of ANOTHER project that is still running (real project query): the panel opens and says the project filter hides it — never 'outside the default range'", async (t) => {
  const shop = await variantChain((snap) => { snap.runs.push(snapLive("run_docs_live", { project: { slug: "docs-site", name: "docs-site" }, title: "Live docs work", laneId: "fable", agentId: "fable" })); });
  const details = await detailsOf(SHOP_IDS);
  const docsBody = await bodyOf({ run: snapLive("run_docs_live", { project: { slug: "docs-site", name: "docs-site" }, title: "Live docs work" }), events: (() => { const b = builder("run_docs_live"); head(b, { prompt: "# Live docs work\nBrief." }); working(b, T0 + 3000); return b.events; })() });
  details.set("run_docs_live", async () => docsBody);
  const b = await bootApp(t, { hash: "#workers?project=shop-api&run=run_docs_live", details, shop });
  assert.ok(b.calls.some((c) => c.url === "/api/workers?project=shop-api"), "the page asked the server for the project's rows");
  assert.ok(!cardsIn(b.elements.main).some((n) => ["card:run_docs_live", "card:run_docs"].includes(n.getAttribute("data-fk"))), "the other project's runs are not listed");
  assert.equal(sidebarTitle(b), "Live docs work");
  const note = byClass(b.elements.sidebar, "sb-note")[0].textContent;
  assert.equal(note, "Hidden by the project filter: this worker belongs to another project.");
  assert.ok(!/default range|24 hours/.test(b.elements.sidebar.textContent));
  // Clear the project filter: now the run IS in the list (still running): no note, its card is marked.
  byClass(b.elements.main, "chip-x")[0].click();
  await b.tick();
  assert.equal(b.location.hash, "#workers?run=run_docs_live");
  assert.equal(byClass(b.elements.sidebar, "sb-note").length, 0);
  assert.deepEqual(cardsIn(b.elements.main).filter((n) => n.getAttribute("aria-pressed") === "true").map((n) => n.getAttribute("data-fk")), ["card:run_docs_live"]);
  // A lane filter and a run that is not listed: the plain statement.
  b.back("#workers?lane=opus&run=run_old_done");
  await b.tick();
  assert.equal(byClass(b.elements.sidebar, "sb-note")[0].textContent, "Not in the current list (the filters or the default range).");
});

test("F9b the app, the Starting line opened by hand: Down from the last running card lands on the first Starting card (what is drawn next), not on Finished", async (t) => {
  const b = await bootApp(t, { hash: "#workers?run=run_fresh", details: await detailsOf([...SHOP_IDS, "run_s1", "run_s2"]) });
  const before = domOrder(b.elements.main);
  assert.ok(!before.includes("run_s2"), "closed: the Starting cards are not drawn");
  b.clickOn(byClass(b.elements.main, "disclosure")[0]);
  await b.tick();
  const opened = domOrder(b.elements.main);
  assert.deepEqual(opened.slice(opened.indexOf("run_fresh") + 1, opened.indexOf("run_fresh") + 3), ["run_s2", "run_s1"], "drawn right after the last running card");
  b.key("ArrowDown");
  await b.tick();
  assert.equal(b.location.hash, "#workers?run=run_s2", "the very next card on screen");
  b.key("ArrowDown");
  await b.tick();
  assert.equal(b.location.hash, "#workers?run=run_s1");
  b.key("ArrowDown");
  await b.tick();
  assert.equal(b.location.hash, `#workers?run=${opened[opened.indexOf("run_s1") + 1]}`, "then the first Finished card");
  // Closing the line again takes its cards out of the walk.
  b.clickOn(byClass(b.elements.main, "disclosure")[0]);
  await b.tick();
  assert.ok(!domOrder(b.elements.main).includes("run_s1"));
});

test("F9c the app, Copy ref: the clipboard gets runId#seq when the evidence names an event of this run, the bare run number when not", async (t) => {
  const b = await bootApp(t, { hash: "#workers?run=run_fail", details: await detailsOf(SHOP_IDS) });
  assert.equal(byClass(b.elements.sidebar, "ref")[0].textContent, "run_fail#0090");
  b.clickOn(byClass(b.elements.sidebar, "btn")[0]);
  await b.tick();
  assert.deepEqual(b.copied, ["run_fail#0090"]);
  assert.equal(byClass(b.elements.sidebar, "btn")[0].textContent, "Copied");
  b.back("#workers?run=run_mid");
  await b.tick();
  b.clickOn(byClass(b.elements.sidebar, "btn")[0]);
  await b.tick();
  assert.deepEqual(b.copied, ["run_fail#0090", "run_mid"], "no evidence for run_mid: its run number");
  b.back("#workers?run=run_quiet");
  await b.tick();
  b.clickOn(byClass(b.elements.sidebar, "btn")[0]);
  await b.tick();
  assert.equal(b.copied.at(-1), "run_quiet#0138");
});
