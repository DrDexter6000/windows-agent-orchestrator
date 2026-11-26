// test/isolation-infra/ownerDashboardV2Activity.test.js
//
// Batch 143b (decision 0131 A3): the /v2 side panel's Activity tab and the /v2 motion.
//
// Fixture discipline (the batch's rule): every interface-shaped value the front end reads is the
// SERVER's real output, never a hand-written object posing as one. The Activity rows are the output of
// projectWorkerActivity, the full-text pages the output of projectWorkerEvent, and the Attention view
// model is built from the real /api/attention and /api/workers answers of the server chain (a snapshot
// goes through deriveOwnerAttention and the DTO whitelists).
//
// Sections:
//   A  activity  four columns and every type code's default display; filters; older pages; gaps; old
//                archives; follow / pause; the incremental poll; the terminal stop; A -> B -> A;
//                Open full; the event-code copy
//   M  motion    the design's curve and durations; reduced motion; only new Attention rows reveal; only
//                new Activity rows fade; no reflow-triggering property moves
//
// Deterministic and dependency-free: no network, no browser, no runtime, no Git.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createOwnerDashboardServer } from "../../src/ownerDashboardServer.js";
import { projectWorkerActivity, projectWorkerEvent } from "../../src/application/ownerWorkerActivity.js";
import { projectWorkerDetail } from "../../src/application/ownerWorkerDetail.js";
import { encodeStreamFrame } from "../../src/application/ownerWorkerStream.js";
import * as model from "../../src/owner-dashboard/v2/model.js";
import * as api from "../../src/owner-dashboard/v2/api.js";
import * as activity from "../../src/owner-dashboard/v2/activity.js";
import { formatClock, formatClockSeconds } from "../../src/owner-dashboard/v2/i18n.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const V2 = join(HERE, "..", "..", "src", "owner-dashboard", "v2");
const readV2 = (name) => readFileSync(join(V2, name), "utf8");

const T0 = Date.parse("2026-11-25T09:00:00.000Z");
const GEN = "2026-11-26T10:42:18.000Z";
const GEN_MS = Date.parse(GEN);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(GEN_MS - ms).toISOString();
const iso = (ms) => new Date(ms).toISOString();
const WORKTREE = "/fixture/repo/.wao-worktrees/run_x";
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

// ===== fixture transcripts (inputs of the server) =====

/** A transcript builder: seq is the real event number unless `over.seq` says otherwise. */
function transcript(runId, { worktree = WORKTREE } = {}) {
  const events = [];
  let seq = 0;
  let clock = T0;
  const b = {
    events,
    runId,
    clock(ms) { clock = ms; return b; },
    skip(n) { seq += n; return b; },
    add(type, payload = {}, over = {}) {
      if (over.noSeq !== true) {
        if (over.seq !== undefined) seq = over.seq;
        else seq += 1;
      }
      const event = { ...payload, ts: iso(clock), type, runId, agentId: "glm-pro" };
      if (over.noSeq !== true) event.seq = over.seq === undefined ? seq : over.seq;
      events.push(event);
      return b;
    },
  };
  b.add("run.started", { cwd: "/fixture/repo", worktreePath: worktree, backend: "claude-code" });
  return b;
}

const say = (b, at, text) => b.clock(at).add("run.event", { kind: "message", role: "assistant", parts: [{ type: "text", text }] });

/** The full four-column fixture: one row of every type code, a folded run, a real gap and an error. */
function everyType(runId = "run_x") {
  const b = transcript(runId);
  b.clock(T0 + 1000);
  say(b, T0 + 1000, "Line one\nLine two\nLine three\nLine four\nLine five\nLine six\nLine seven");
  b.clock(T0 + 2000).add("run.event", { kind: "command", command: "npm test -- orders", toolCallId: "call-1", exitCode: 1 });
  b.clock(T0 + 3000).add("run.event", {
    kind: "tool_result", tool: "call-1", output: Array.from({ length: 50 }, (_, i) => `out ${i + 1}`).join("\n"),
  });
  b.clock(T0 + 4000).add("run.event", { kind: "tool_use", tool: "Read", input: { file_path: `${WORKTREE}/src/a.js` } });
  b.clock(T0 + 5000).add("run.event", { kind: "file_written", path: `${WORKTREE}/src/orders/migrate.js` });
  b.clock(T0 + 6000).add("run.state_change", { from: "running", to: "completed", reason: "completed" });
  b.clock(T0 + 7000).add("run.event", { kind: "runtime_activity", status: "process_active" });
  b.add("run.event", { kind: "runtime_activity", status: "process_active" });
  b.clock(T0 + 8000).add("run.error", { phase: "wait", error: "upstream 429, retrying in 60s" });
  b.skip(2); // #11, #12 really missing
  b.clock(T0 + 9000).add("run.error", { phase: "deliver", error: "second failure", detail: { code: "boom" } });
  return b.events;
}

function liveTranscript(runId = "run_live") {
  const b = transcript(runId);
  b.clock(T0 + 1000);
  say(b, T0 + 1000, "first line");
  b.clock(T0 + 2000).add("run.state_change", { from: "pending", to: "running", reason: "first_event" });
  return b;
}

function finishedTranscript(runId = "run_done") {
  const b = transcript(runId);
  b.clock(T0 + 1000);
  say(b, T0 + 1000, "all done");
  b.clock(T0 + 2000).add("run.completed", {});
  b.add("run.state_change", { from: "running", to: "completed", reason: "completed" });
  return b.events;
}

const pageOf = (runId, events, query = {}) => projectWorkerActivity({ runId, events, env: {}, ...query });

/** One feed wired to the real projections. `events` may be replaced by the test between polls. */
function feedOf(runId, events, { onChange = () => {}, fullEvents = null } = {}) {
  const pages = [];
  const fulls = [];
  const feed = activity.createActivityFeed({
    fetchPage: async (query) => {
      pages.push(query);
      const body = pageOf(runId, events, query);
      return { ok: true, body };
    },
    fetchFull: async (query) => {
      fulls.push(query);
      const body = projectWorkerEvent({ runId, events: fullEvents ?? events, env: {}, ...query });
      return body === null ? { ok: false, reason: "notFound" } : { ok: true, body };
    },
    onChange,
    now: () => GEN_MS,
  });
  return { feed, pages, fulls };
}

async function openedFeed(runId, events, options = {}) {
  const made = feedOf(runId, events, options);
  made.feed.open(runId);
  await settle();
  return made;
}

// ===== a tiny in-memory DOM (text nodes and the few methods the views use) =====

class FakeText {
  constructor(text) { this.nodeType = 3; this.textContent = text; this.parent = null; }
  get parentNode() { return this.parent; }
}

class FakeNode {
  constructor(tag) {
    this.tag = tag; this.children = []; this.attrs = new Map(); this.listeners = new Map();
    this.parent = null; this.className = ""; this.ownText = null; this.nodeType = 1; this.value = "";
    this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0; this.moves = 0;
  }
  get parentNode() { return this.parent; }
  get textContent() { return this.ownText !== null ? this.ownText : this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  append(...nodes) {
    for (const node of nodes) {
      assert.ok(node instanceof FakeNode || node instanceof FakeText, `only nodes can be appended, got ${String(node)}`);
      node.parent = this;
      this.children.push(node);
    }
  }
  insertBefore(node, before) {
    assert.ok(node instanceof FakeNode || node instanceof FakeText, `only nodes can be inserted, got ${String(node)}`);
    this.moves += 1;
    if (node.parent !== null) {
      const old = node.parent.children.indexOf(node);
      if (old >= 0) node.parent.children.splice(old, 1);
    }
    const index = before === null || before === undefined ? this.children.length : this.children.indexOf(before);
    assert.ok(index >= 0, "insertBefore: the reference child is not here");
    node.parent = this;
    this.children.splice(index, 0, node);
  }
  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) {
      this.children.splice(index, 1);
      node.parent = null;
    }
    return node;
  }
  get offsetTop() {
    if (this.parent === null) return 0;
    return Math.max(0, this.parent.children.indexOf(this)) * 20;
  }
  getBoundingClientRect() {
    // Viewport coordinates: layout offset minus the sidebar's scroll, like a real fixed panel.
    let scroll = 0;
    for (let node = this.parent; node !== null && node !== undefined; node = node.parent) {
      if (node.getAttribute !== undefined && node.getAttribute("id") === "sidebar") { scroll = node.scrollTop; break; }
    }
    const top = this.offsetTop - scroll;
    return { top, bottom: top + 20, height: 20, left: 0, right: 0 };
  }
  replaceChildren(...nodes) {
    if (fakeDocument.activeElement !== null && this.contains(fakeDocument.activeElement)) fakeDocument.activeElement = null;
    // A real selection whose anchor lives in a node that disappears collapses; model that so a test
    // cannot pass while the list was silently rebuilt.
    const hadSelection = fakeSelection.anchorNode !== null && (this.contains(fakeSelection.anchorNode) || this.contains(fakeSelection.focusNode));
    const kept = (node) => node !== null && node !== undefined
      && nodes.some((next) => next === node || (next instanceof FakeNode && next.contains(node)));
    for (const old of this.children) old.parent = null;
    this.children = [];
    this.ownText = null;
    this.append(...nodes);
    if (hadSelection && (!kept(fakeSelection.anchorNode) || !kept(fakeSelection.focusNode))) fakeSelection.removeAllRanges();
  }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  removeAttribute(name) { this.attrs.delete(name); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name) { return this.attrs.has(name); }
  addEventListener(event, fn) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]); }
  click() { for (const fn of this.listeners.get("click") ?? []) fn({ type: "click" }); }
  contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false; }
  closest(selector) {
    const tests = selector.split(",").map((s) => s.trim()).map((s) => (n) => (s.startsWith("#") ? n.attrs.get("id") === s.slice(1) : s.startsWith(".") ? n.className.split(" ").includes(s.slice(1)) : s.startsWith("[") ? n.attrs.has(s.slice(1, -1)) : n.tag === s));
    for (let n = this; n; n = n.parent) if (tests.some((t) => t(n))) return n;
    return null;
  }
  focus() { if (this.attrs.has("disabled")) return; fakeDocument.activeElement = this; }
  walk(visit) { for (const child of this.children) { if (child instanceof FakeNode) { visit(child); child.walk(visit); } } }
  querySelectorAll(selector) {
    const attr = /^\[([a-z-]+)\]$/.exec(selector)?.[1];
    assert.ok(attr, `fake DOM supports only [attr] selectors, got ${selector}`);
    const out = [];
    this.walk((node) => { if (node.attrs.has(attr)) out.push(node); });
    return out;
  }
}

const fakeSelection = {
  rangeCount: 0, isCollapsed: true, anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, ranges: [],
  removeAllRanges() {
    this.ranges = []; this.rangeCount = 0; this.isCollapsed = true;
    this.anchorNode = null; this.anchorOffset = 0; this.focusNode = null; this.focusOffset = 0;
  },
  addRange(range) { this.ranges.push(range); this.rangeCount = 1; this.isCollapsed = false; this.anchorNode = range.node; this.focusNode = range.node; },
};
const fakeDocument = {
  activeElement: null,
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => new FakeText(text),
  createRange: () => ({ node: null, selectNodeContents(node) { this.node = node; } }),
};
globalThis.document = fakeDocument;
globalThis.window = { getSelection: () => fakeSelection };
after(() => { delete globalThis.document; delete globalThis.window; });

const { renderActivity: paintActivity } = await import("../../src/owner-dashboard/v2/activityview.js");
const { renderMain, renderTopbar, selectRefText } = await import("../../src/owner-dashboard/v2/views.js");

const find = (root, pred) => { const out = []; root.walk((n) => { if (pred(n)) out.push(n); }); return out; };
const byClass = (root, cls) => find(root, (n) => n.className.split(" ").includes(cls));
const byTag = (root, tag) => find(root, (n) => n.tag === tag);
const region = (tag = "div") => { const node = new FakeNode(tag); fakeDocument.activeElement = null; return node; };
const recorder = () => {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); };
  return {
    calls,
    ...Object.fromEntries(["copyEventCode", "resumeActivity", "setActivityFilter", "toggleActivityRow", "openActivityFull", "activityFullPage", "closeActivityFull", "reloadActivity"].map((name) => [name, rec(name)])),
  };
};
const SUI = (over = {}) => ({ tab: "activity", filesOpen: false, imageOpen: null, copy: null, eventCopy: null, ...over });
const renderActivity = (vm, lang = "en", actions = recorder(), sui = SUI(), root = region()) => {
  paintActivity(root, vm, lang, sui, actions);
  return { root, actions };
};
const rowsOf = (root) => byClass(root, "act-row");
const rowByKey = (root, key) => rowsOf(root).find((node) => node.getAttribute("data-act-key") === key);

// ===== the real server chain (for the Attention motion test) =====

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
  env: {},
  nowFn: () => GEN_MS,
  ...extra,
});

const snapProject = (slug) => ({ slug, name: slug, repo: "available", branchesObservedAt: GEN, consultRecords: "available" });
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
const snapshotOf = ({ runs = [], consults = [] } = {}) => ({ generatedAt: GEN, projects: [snapProject("shop-api")], runs, consults });

async function chain(snapshot) {
  const readModel = { async refresh() {}, snapshot: (args) => ({ ...snapshot, generatedAt: new Date(args.now).toISOString() }) };
  const s = makeServer({ createReadModelFn: () => readModel });
  assert.equal(await s.refreshNow(), "ready");
  const get = async (url) => {
    const r = await drive(s.handler, { url, headers: { authorization: `Bearer ${s.token}` } });
    assert.equal(r.status, 200, url);
    return JSON.parse(r.body);
  };
  return { overview: await get("/api/overview"), workers: await get("/api/workers"), attention: await get("/api/attention") };
}

// =====================================================================
// A) THE ACTIVITY TAB
// =====================================================================

test("A1 the four columns and every type code's default display, from the server's real rows: seq / time / code / summary; messages 6 lines, commands one line with an exit code, outputs folded with a line count, tools one line, writes a path and unknown counts, states a rule, RT folded, errors open", async () => {
  const events = everyType();
  const { feed } = await openedFeed("run_x", events);
  const vm = activity.buildActivityView(feed.get());
  assert.equal(vm.phase, "ready");
  assert.deepEqual(vm.rows.map((row) => (row.row === "gap" ? "gap" : row.code)), ["MSG", "CMD", "OUT", "TOOL", "WRITE", "STATE", "RT", "ERR", "gap", "ERR"]);
  assert.deepEqual(vm.rows.map((row) => row.row), ["event", "event", "event", "event", "event", "event", "fold", "event", "gap", "event"]);

  const [msg, cmd, out, tool, write, state, fold, err, gap] = vm.rows;
  assert.equal(msg.seq, 2);
  assert.equal(msg.expanded, false, "a message starts folded to its first six lines");
  assert.deepEqual(msg.body.head, ["Line one", "Line two", "Line three", "Line four", "Line five", "Line six"]);
  assert.equal(msg.body.totalLines, 7);
  assert.equal(msg.part, "message", "the full text is addressable by runId#seq");
  assert.equal(cmd.summary, "npm test -- orders");
  assert.equal(cmd.exitCode, 1, "the result's exit code supplements the command line");
  assert.equal(cmd.part, "command");
  assert.equal(out.expanded, false, "an output starts as one line");
  assert.equal(out.body.totalLines, 50);
  assert.equal(out.outputOf, "command");
  assert.equal(out.part, "output");
  assert.equal(tool.summary, "Read …/a.js");
  assert.equal(tool.part, null, "a tool call has no full-text part of its own");
  assert.equal(write.path, "src/orders/migrate.js", "a path inside the bound worktree is shown relative");
  assert.deepEqual([write.added, write.deleted], [null, null], "no backend bound line counts: unknown, never invented");
  assert.deepEqual([state.from, state.to], ["running", "completed"]);
  assert.deepEqual([fold.fromSeq, fold.toSeq, fold.count, fold.status], [8, 9, 2, "process_active"]);
  assert.equal(err.expanded, true, "an error is always open by default");
  assert.equal(err.text, "upstream 429, retrying in 60s");
  assert.deepEqual([gap.fromSeq, gap.toSeq, gap.count], [11, 12, 2], "the server's real gap");

  // The drawn tab: four cells per row, event numbers and times aligned, the state on a rule, the gap a line.
  const { root } = renderActivity(vm);
  const rows = rowsOf(root);
  assert.equal(rows.length, vm.rows.length - 1, "the gap is a line of its own");
  for (const row of rows) assert.equal(byClass(row, "act-c").length, 4, row.getAttribute("data-act-key"));
  const cells = (key) => byClass(rowByKey(root, key), "act-c").map((cell) => cell.textContent);
  assert.deepEqual(cells("event:2").slice(0, 3), ["#0002", formatClockSeconds(T0 + 1000), "MSG"]);
  assert.deepEqual(cells("event:3").slice(0, 3), ["#0003", formatClockSeconds(T0 + 2000), "CMD"]);
  assert.match(cells("event:3")[3], /npm test -- orders · exit 1/);
  const outToggle = byClass(rowByKey(root, "event:4"), "act-fold-btn")[0];
  assert.equal(outToggle.textContent, "50 lines", "the output is folded to its line count");
  assert.equal(byClass(outToggle, "chev").length, 1, "with the disclosure's own arrow");
  assert.match(cells("event:6")[3], /src\/orders\/migrate\.js · line counts unknown/);
  assert.ok(rowByKey(root, "event:7").className.includes("act-state"), "a state change is the same four cells on a rule");
  assert.match(cells("fold:ok:8")[3], /▸ 2 events · process active/);
  assert.match(cells("event:10")[3], /upstream 429, retrying in 60s/, "the error text is on screen without opening anything");
  assert.equal(find(rowByKey(root, "event:10"), (node) => node.getAttribute("data-fk") === "act-open:event:10").length, 0, "an error has no collapse control");
  assert.match(byClass(root, "act-gap")[0].textContent, /#0011–0012 missing/);
  // Message lines: exactly the server's head.
  assert.deepEqual(byClass(rowByKey(root, "event:2"), "act-line").map((n) => n.textContent), ["Line one", "Line two", "Line three", "Line four", "Line five", "Line six"]);
  // Keyboard only: every control is a real button with its own focus key.
  const buttons = byTag(root, "button");
  assert.ok(buttons.length > 4);
  for (const node of buttons) {
    assert.equal(node.getAttribute("type"), "button");
    assert.ok(node.getAttribute("data-fk"), "a focus key, so a redraw can put the focus back");
  }
  const keys = buttons.map((node) => node.getAttribute("data-fk"));
  assert.equal(new Set(keys).size, keys.length, "focus keys are unique in the tab");
  // The same rows in Chinese differ only in interface words.
  const zh = renderActivity(vm, "zh").root;
  assert.match(byClass(zh, "act-gap")[0].textContent, /#0011–0012 缺失/);
  assert.match(byClass(rowByKey(zh, "fold:ok:8"), "act-c")[3].textContent, /2 条 · 进程在动/);
});

test("A2 filters are the server's own: All / Messages / Commands / Errors, each page re-read from the latest cursor and the hidden count shown", async () => {
  const events = everyType();
  events.push({ type: "run.event", runId: "run_x", agentId: "glm-pro", seq: 14, ts: iso(T0 + 9500), kind: "tool_result", tool: "other", isError: true, output: "bad tool output" });
  const { feed, pages } = await openedFeed("run_x", events);
  assert.deepEqual(activity.ACTIVITY_FILTERS, ["all", "messages", "commands", "errors"]);

  assert.equal(feed.setFilter("messages"), true);
  await settle();
  let vm = activity.buildActivityView(feed.get());
  assert.equal(vm.filter, "messages");
  assert.deepEqual(vm.rows.map((row) => (row.row === "gap" ? "gap" : row.code)), ["MSG", "gap"], "only messages — and the real gap line, which is never filtered out");
  assert.equal(pages.at(-1).filter, "messages", "the route gets the filter, not a client-side slice");
  assert.ok(vm.hiddenFiltered > 0);
  const { root } = renderActivity(vm);
  assert.equal(byClass(root, "act-hidden")[0].textContent, `${vm.hiddenFiltered} events hidden by this filter.`);
  assert.deepEqual(byClass(root, "act-filter-btn").map((n) => [n.textContent, n.getAttribute("aria-pressed")]), [["All", "false"], ["Messages", "true"], ["Commands", "false"], ["Errors", "false"]]);

  feed.setFilter("commands");
  await settle();
  vm = activity.buildActivityView(feed.get());
  assert.deepEqual(vm.rows.map((row) => (row.row === "gap" ? "gap" : row.code)), ["CMD", "OUT", "gap"], "commands = the command and its own output, as the route defines them");
  feed.setFilter("errors");
  await settle();
  vm = activity.buildActivityView(feed.get());
  assert.deepEqual(vm.rows.map((row) => (row.row === "gap" ? "gap" : row.code)), ["ERR", "gap", "ERR", "OUT"], "errors = run errors and outputs marked as errors");
  assert.ok(vm.rows.some((row) => row.outputOf === "tool" && row.isError === true), "a failed tool result is an error output");

  // Each filter change starts from the newest page again (no beforeSeq, the same limit).
  for (const query of pages) assert.deepEqual([query.limit, "beforeSeq" in query], [200, false]);
  const apiPaths = [api.activityPath({ runId: "run_x", filter: "messages" }), api.eventPath({ runId: "run_x", seq: 2, part: "message", page: 1 })];
  assert.deepEqual(apiPaths, ["/api/worker/activity?runId=run_x&filter=messages", "/api/worker/event?runId=run_x&seq=2&part=message&page=1"]);
  for (const path of apiPaths) assert.equal(api.isDataPath(path), true, path);
});

test("A3 older pages go ABOVE what is on screen, with no duplicate and no hole: the page's own beforeSeq is used and the old rows are kept as they were", async () => {
  const b = transcript("run_many");
  b.clock(T0 + 1000);
  for (let i = 0; i < 230; i += 1) {
    b.clock(T0 + 1000 + i * 10);
    say(b, T0 + 1000 + i * 10, `message ${i + 1}`);
  }
  const { feed, pages } = await openedFeed("run_many", b.events);
  let vm = activity.buildActivityView(feed.get());
  assert.equal(vm.rows.length, 200, "the first page is the latest 200 units");
  assert.deepEqual([vm.rows[0].seq, vm.rows.at(-1).seq], [32, 231]);
  assert.equal(vm.older.available, true);
  const firstRow = feed.get().rows[0];
  const firstKey = firstRow.key;
  const anchor = { key: firstKey, offset: 0 };

  assert.equal(feed.loadOlder(anchor), true);
  await settle();
  vm = activity.buildActivityView(feed.get());
  assert.equal(pages.at(-1).beforeSeq, 32, "the page above is cut at the first event number shown, as the route answered");
  assert.equal(vm.rows.length, 230, "nothing is fetched twice and nothing is lost");
  const seqs = vm.rows.map((row) => row.seq);
  assert.deepEqual(seqs, Array.from({ length: 230 }, (_, i) => i + 2), "every event exactly once, in order");
  assert.equal(new Set(vm.rows.map((row) => row.key)).size, 230);
  const at = feed.get().rows.findIndex((row) => row.key === firstKey);
  assert.equal(at, 30, "the previously first row now sits below the 30 older events");
  assert.equal(feed.get().rows[at], firstRow, "and it is the same view-model object: the rows on screen were not rebuilt");
  assert.deepEqual(feed.takePrependAnchor(), anchor, "the visible-row anchor comes back for the app to restore");
  assert.equal(vm.older.available, false, "the transcript's first event is reached");
});

test("A4 a real gap is drawn as the server reports it and it interrupts a fold; old archives keep their missing / reused event numbers as marks", async () => {
  const b = transcript("run_gap");
  b.clock(T0 + 1000);
  b.add("run.event", { kind: "runtime_activity", status: "streaming" });
  b.add("run.event", { kind: "runtime_activity", status: "streaming" });
  b.skip(3); // #4, #5, #6 missing
  b.clock(T0 + 2000).add("run.event", { kind: "runtime_activity", status: "process_active" });
  b.clock(T0 + 3000).add("run.event", { kind: "runtime_activity", status: "process_active" });
  const { feed } = await openedFeed("run_gap", b.events);
  const vm = activity.buildActivityView(feed.get());
  assert.deepEqual(vm.rows.filter((row) => row.row === "gap").map((row) => [row.fromSeq, row.toSeq, row.count]), [[4, 6, 3]]);
  assert.equal(vm.rows.filter((row) => row.row === "fold").length, 2, "the gap splits the runtime activity into two folded rows");
  const { root } = renderActivity(vm);
  assert.match(byClass(root, "act-gap")[0].textContent, /#0004–0006 missing/);

  // An old archive: one event without a number, two events with the same number.
  const old = transcript("run_old_archive");
  old.clock(T0 + 1000);
  old.clock(T0 + 1000).add("run.event", { kind: "message", role: "assistant", parts: [{ type: "text", text: "no number" }] }, { noSeq: true });
  old.clock(T0 + 2000).add("run.event", { kind: "message", role: "assistant", parts: [{ type: "text", text: "reused A" }] }, { seq: 2 });
  old.clock(T0 + 3000).add("run.event", { kind: "message", role: "assistant", parts: [{ type: "text", text: "reused B" }] }, { seq: 2 });
  const oldFeed = await openedFeed("run_old_archive", old.events);
  const oldVm = activity.buildActivityView(oldFeed.feed.get());
  const states = oldVm.rows.map((row) => [row.summary, row.seqState]);
  assert.deepEqual(states, [["no number", "missing"], ["reused A", "conflict"], ["reused B", "conflict"]]);
  const oldRoot = renderActivity(oldVm).root;
  assert.equal(byClass(oldRoot, "act-seq")[0].textContent, "#?", "a missing event number is not invented");
  assert.deepEqual(byClass(oldRoot, "tag").map((n) => n.textContent), ["no event number", "event number reused", "event number reused"]);
  assert.equal(byTag(oldRoot, "button").filter((n) => n.getAttribute("data-fk").startsWith("act-seq:")).length, 0, "only an addressable (ok seq) code is a copy button");
});

test("A5 following and pausing: at the bottom new events follow; scrolling up, selecting text and expanding a row pause it; N new events wait, resume on click, and the state never uses 'stop' wording", async () => {
  const b = liveTranscript();
  let events = b.events;
  const made = await openedFeed("run_live", events);
  const { feed } = made;
  assert.equal(feed.get().following, true);
  assert.equal(feed.pause("scroll"), true, "scrolling up pauses");
  assert.equal(feed.get().pausedBy, "scroll");
  assert.equal(feed.get().newCount, 0);
  const firstCount = activity.buildActivityView(feed.get()).rows.length;

  say(b, T0 + 3000, "second line");
  events = b.events;
  await feed.poll();
  let vm = activity.buildActivityView(feed.get());
  assert.equal(vm.rows.length, firstCount, "while paused the stream does not move");
  assert.equal(vm.newCount, 1, "the new event waits as a count");

  say(b, T0 + 4000, "third line");
  events = b.events;
  await feed.poll();
  vm = activity.buildActivityView(feed.get());
  assert.equal(vm.newCount, 2);
  assert.equal(vm.rows.length, firstCount);

  const { root, actions } = renderActivity(vm);
  const button = byClass(root, "act-new-btn")[0];
  assert.equal(button.textContent, "↓ 2 new events");
  button.click();
  assert.deepEqual(actions.calls.pop(), ["resumeActivity"]);
  assert.equal(feed.follow(), true);
  vm = activity.buildActivityView(feed.get());
  assert.equal(vm.following, true);
  assert.equal(vm.newCount, 0);
  assert.equal(vm.rows.length, firstCount + 2, "resuming applies everything that waited");
  assert.equal(feed.takeScrollRequest(), true, "and asks the view to go back to the bottom");
  assert.ok(!/stop/i.test(readV2("activityview.js")), "the pause wording is not the stop-worker wording");
  assert.match(readV2("i18n.js"), /"sb\.a\.paused": "Paused following"/);
  assert.match(readV2("i18n.js"), /"sb\.a\.paused": "已暂停跟随"/);

  // Every trigger, each starting from a following feed.
  const fresh = async () => { const made2 = await openedFeed("run_live", events); return made2.feed; };
  let f = await fresh();
  assert.equal(f.scrolled(true), true);
  assert.equal(f.get().pausedBy, "scroll");
  f = await fresh();
  assert.equal(f.pause("selection"), true, "a text selection pauses");
  assert.equal(f.get().pausedBy, "selection");
  f = await fresh();
  const firstKey = f.get().rows[0].key;
  assert.equal(f.toggleRow(firstKey), true, "expanding a row pauses");
  assert.equal(f.get().pausedBy, "expand");
  assert.equal(f.isOpen(firstKey), true);
  assert.equal(f.toggleRow(firstKey), true, "collapsing it again does not resume by itself");
  assert.equal(f.get().following, false);
  assert.equal(f.follow(), true);
});

test("A6 the 5 s poll is an incremental cursor: it re-reads the latest page with the SAME filter and appends only what is new — never a second copy, never a re-fetched older page", async () => {
  const b = liveTranscript();
  let events = b.events;
  const { feed, pages } = await openedFeed("run_live", events);
  const before = activity.buildActivityView(feed.get()).rows.map((row) => row.key);
  say(b, T0 + 3000, "second line");
  events = b.events;
  assert.equal(await feed.poll(), true);
  const after = activity.buildActivityView(feed.get());
  assert.deepEqual(after.rows.map((row) => row.key), [...before, "event:4"], "exactly one new row, after the ones already shown");
  assert.equal(after.newCount, 0, "following applies it at once");
  assert.equal(pages.at(-1).filter, "all", "the same cursor");
  assert.equal(pages.at(-1).limit, 200);
  assert.equal("beforeSeq" in pages.at(-1), false, "the newest page, not an older one");
  assert.equal(await feed.poll(), true, "a quiet poll still succeeds");
  assert.deepEqual(activity.buildActivityView(feed.get()).rows.map((row) => row.key), after.rows.map((row) => row.key), "and changes nothing");
  const quiet = activity.buildActivityView(feed.get());
  await feed.poll();
  assert.deepEqual(activity.buildActivityView(feed.get()), quiet, "a poll with no new event produces the identical view model, so the panel is not redrawn");
});

test("A7 a terminal run: the last page is taken once, polling stops, and the footer says how many events the run has", async () => {
  const events = finishedTranscript();
  const { feed, pages } = await openedFeed("run_done", events);
  let vm = activity.buildActivityView(feed.get());
  assert.equal(vm.terminal, true);
  assert.equal(vm.total, pageOf("run_done", events).total);
  assert.equal(vm.freshness.kind, "ended");
  const { root } = renderActivity(vm);
  assert.equal(byClass(root, "act-status")[0].textContent, `Ended · ${vm.total} events`);
  const asked = pages.length;
  assert.equal(await feed.poll(), false, "no more requests for a run that has ended");
  assert.equal(pages.length, asked);
  assert.match(readV2("i18n.js"), /"sb\.a\.ended": "已结束，共 \{n\} 条"/);
});

test("A26 (145a migration) the page that ends the run repairs an in-place exit code: the command row shown without one gains its exit code from the terminal page's update, with no duplicate row and no further request", async () => {
  const b = transcript("run_end_exit");
  b.clock(T0 + 500).add("session.created", { backend: "claude-code", backendSessionId: "proc_1", serveUrl: null });
  b.clock(T0 + 1000).add("run.event", { kind: "command", command: "npm test", toolCallId: "call-9" });
  const before = [...b.events];
  b.clock(T0 + 2000).add("run.event", { kind: "tool_result", tool: "call-9", output: "1 failing test", isError: true });
  b.clock(T0 + 3000).add("run.completed", {});
  const after = [...b.events];

  let served = before;
  const pages = [];
  const feed = activity.createActivityFeed({
    fetchPage: async (query) => {
      pages.push(query);
      return { ok: true, body: pageOf("run_end_exit", served, query) };
    },
    fetchFull: async () => ({ ok: false, reason: "notFound" }),
    now: () => GEN_MS,
  });
  feed.open("run_end_exit");
  await settle();
  let vm = activity.buildActivityView(feed.get());
  assert.equal(vm.rows.find((row) => row.code === "CMD").exitCode, null, "the command was read before its result existed");
  assert.equal(vm.terminal, false);

  served = after; // the result and the terminal event land together
  await feed.poll();
  vm = activity.buildActivityView(feed.get());
  assert.equal(vm.terminal, true, "the run has ended");
  const command = vm.rows.find((row) => row.code === "CMD");
  assert.deepEqual([command.exitCode, command.exitSource], [1, "inferred"], "the same command row caught up from the terminal page's update");
  assert.equal(vm.rows.filter((row) => row.code === "CMD").length, 1, "no second copy of the command");
  assert.equal(vm.freshness.kind, "ended");
  const asked = pages.length;
  assert.equal(await feed.poll(), false, "a run that has ended is not asked again");
  assert.equal(pages.length, asked);
});


test("A8 A -> B -> A: every open starts a new epoch; an answer for the old A (or for B) is dropped even when it arrives after the Owner is back on A", async () => {
  const aEvents = everyType("run_a");
  const bEvents = everyType("run_b");
  const gates = [];
  const feed = activity.createActivityFeed({
    fetchPage: (query) => new Promise((resolve) => gates.push({ query, resolve })),
    fetchFull: async () => ({ ok: false, reason: "notFound" }),
    onChange: () => {},
  });
  feed.open("run_a");
  await Promise.resolve();
  assert.equal(gates.length, 1);
  feed.open("run_b");
  await Promise.resolve();
  assert.equal(gates.length, 2);
  feed.open("run_a");
  await Promise.resolve();
  assert.equal(gates.length, 3);
  assert.deepEqual(gates.map((gate) => gate.query.runId), ["run_a", "run_b", "run_a"], "a third selection asks A again");

  gates[0].resolve({ ok: true, body: pageOf("run_a", aEvents) }); // the FIRST A answers last-but-one
  await settle();
  assert.equal(activity.buildActivityView(feed.get()).rows.length, 0, "the old A answer is dropped");

  gates[1].resolve({ ok: true, body: pageOf("run_b", bEvents) }); // B answers while A is the open one
  await settle();
  assert.equal(feed.get().runId, "run_a");
  assert.equal(activity.buildActivityView(feed.get()).rows.length, 0, "B's answer never lands on A");

  gates[2].resolve({ ok: true, body: pageOf("run_a", aEvents) });
  await settle();
  const vm = activity.buildActivityView(feed.get());
  assert.equal(vm.runId, "run_a");
  assert.ok(vm.rows.length > 0, "the fresh A answer is shown");
  assert.equal(vm.rows.find((row) => row.code === "MSG").summary, "Line one", "the fresh A page, not the old or B's");
});

test("A9 Open full: a row's whole text is fetched by runId#seq in pages through /api/worker/event, and the pager stops at the route's own page count", async () => {
  const b = transcript("run_big");
  b.clock(T0 + 1000).add("run.event", {
    kind: "tool_result", tool: "big", output: Array.from({ length: 600 }, (_, i) => `line ${i + 1} ${"x".repeat(60)}`).join("\n"),
  });
  const { feed, fulls } = await openedFeed("run_big", b.events);
  let vm = activity.buildActivityView(feed.get());
  const out = vm.rows.find((row) => row.code === "OUT");
  assert.equal(out.truncated, true);
  assert.equal(out.part, "output");

  assert.equal(feed.openFull(out.key), true);
  assert.equal(feed.get().following, false, "opening a row pauses following");
  await settle();
  vm = activity.buildActivityView(feed.get());
  const full = vm.rows.find((row) => row.key === out.key).full;
  assert.equal(full.state, "ready");
  assert.equal(full.page, 1);
  assert.ok(full.totalPages > 1, `600 long lines span several pages (${full.totalPages})`);
  assert.deepEqual(fulls[0], { runId: "run_big", seq: out.seq, part: "output", page: 1 });
  const page1 = projectWorkerEvent({ runId: "run_big", events: b.events, env: {}, seq: out.seq, part: "output", page: 1 });
  assert.equal(full.text, page1.text, "the page is exactly the server's page 1");

  assert.equal(feed.fullPage(out.key, 1), true);
  await settle();
  vm = activity.buildActivityView(feed.get());
  const page2 = vm.rows.find((row) => row.key === out.key).full;
  assert.equal(page2.page, 2);
  assert.deepEqual(fulls.at(-1), { runId: "run_big", seq: out.seq, part: "output", page: 2 });
  assert.equal(page2.text, projectWorkerEvent({ runId: "run_big", events: b.events, env: {}, seq: out.seq, part: "output", page: 2 }).text);

  // The last page: forward is refused, and the previous page works again.
  while (feed.get().full.get(out.key).page < page2.totalPages) {
    assert.equal(feed.fullPage(out.key, 1), true);
    await settle();
  }
  assert.equal(feed.fullPage(out.key, 1), false, "past the last page: no request");
  assert.equal(feed.fullPage(out.key, -1), true);
  await settle();
  assert.equal(feed.closeFull(out.key), true);
  vm = activity.buildActivityView(feed.get());
  assert.equal(vm.rows.find((row) => row.key === out.key).full, null);

  // The drawn pager: one button per direction, the page count, and a way back to the excerpt.
  const reopened = feed.openFull(out.key);
  assert.equal(reopened, true);
  await settle();
  const { root, actions } = renderActivity(activity.buildActivityView(feed.get()));
  const pager = byClass(root, "act-pager")[0];
  assert.ok(pager, "the pager appears for a multi-page text");
  assert.match(byClass(pager, "act-page")[0].textContent, /^\d+ \/ \d+$/);
  byClass(pager, "act-page-btn")[2].click();
  assert.deepEqual(actions.calls.pop(), ["closeActivityFull", out.key]);
});

test("A10 the event code copies runId#seq and carries the same text for the clipboard fallback", async () => {
  const { feed } = await openedFeed("run_x", everyType());
  const vm = activity.buildActivityView(feed.get());
  const { root, actions } = renderActivity(vm);
  const msg = vm.rows.find((row) => row.code === "MSG");
  const button = byClass(root, "act-seq-btn").find((node) => node.getAttribute("data-fk") === `act-seq:${msg.key}`);
  assert.ok(button, "an ok event number is a button");
  assert.equal(button.textContent, "#0002");
  assert.equal(activity.activityRef("run_x", msg.seq), "run_x#0002");
  button.click();
  assert.deepEqual(actions.calls.pop(), ["copyEventCode", "run_x", 2, msg.key]);
  // The clipboard refused: the full reference is shown and selected (the batch 142 fallback).
  const failed = renderActivity(vm, "en", recorder(), SUI({ eventCopy: { key: msg.key, result: "fail", ref: "run_x#0002" } }));
  const code = byClass(failed.root, "ref")[0];
  assert.equal(code.textContent, "run_x#0002");
  fakeSelection.removeAllRanges();
  assert.equal(selectRefText(failed.root, `event-copy:${msg.key}`), true);
  assert.equal(fakeSelection.anchorNode, code);
  // A successful copy says so instead.
  const copied = renderActivity(vm, "en", recorder(), SUI({ eventCopy: { key: msg.key, result: "ok", ref: "run_x#0002" } }));
  assert.equal(byClass(copied.root, "copy-status")[0].textContent, "Copied");
  // A reused / missing number is not addressable, so it is no button (A4 draws the marks).
  assert.equal(activity.activitySeqLabel(null), null);
  assert.equal(activity.activitySeqLabel(7), "#0007");
  // Worker text is still text: markup in a message or a command is drawn literally, never parsed.
  const evil = "<img src=x onerror=alert(1)> & <script>alert(2)</script>";
  const b = transcript("run_evil");
  b.clock(T0 + 1000);
  say(b, T0 + 1000, evil);
  b.clock(T0 + 2000).add("run.event", { kind: "command", command: evil, toolCallId: "evil-1", exitCode: 0 });
  const evilFeed = await openedFeed("run_evil", b.events);
  const evilRoot = renderActivity(activity.buildActivityView(evilFeed.feed.get())).root;
  assert.equal(byTag(evilRoot, "img").length, 0);
  assert.equal(byTag(evilRoot, "script").length, 0);
  assert.ok(evilRoot.textContent.includes(evil), "the characters are shown, not interpreted");
});

test("A12 the stream status: Polling 5s while the 5 s poll is healthy, Stale since HH:MM after a failed poll, and never Live for a feed that has no stream (Live is the stream's, S1); a command's exit code appears when its result arrives", async () => {
  // Status labels: the Activity stream has its own status line (Live is batch 144's, not this one).
  const events = liveTranscript().events;
  let fail = false;
  const pages = [];
  const feed = activity.createActivityFeed({
    fetchPage: async (query) => {
      pages.push(query);
      return fail ? { ok: false, reason: "network" } : { ok: true, body: pageOf("run_live", events, query) };
    },
    fetchFull: async () => ({ ok: false, reason: "notFound" }),
    onChange: () => {},
    now: () => GEN_MS,
  });
  feed.open("run_live");
  await settle();
  let vm = activity.buildActivityView(feed.get());
  assert.deepEqual(vm.freshness, { kind: "polling", sinceMs: null });
  let { root } = renderActivity(vm);
  assert.equal(byClass(root, "act-status")[0].textContent, "Polling 5s");
  assert.ok(!root.textContent.includes("Live"), "a feed without a stream never claims Live");
  fail = true;
  await feed.poll();
  vm = activity.buildActivityView(feed.get());
  assert.equal(vm.freshness.kind, "stale");
  assert.equal(vm.freshness.sinceMs, GEN_MS, "stale since the first failed poll");
  ({ root } = renderActivity(vm, "en", recorder(), SUI(), region()));
  assert.equal(byClass(root, "act-status")[0].textContent, `Stale since ${formatClock(GEN_MS)}`);
  fail = false;
  await feed.poll();
  assert.equal(activity.buildActivityView(feed.get()).freshness.kind, "polling", "a good answer clears the stale mark");

  // A command listed before its result shows no exit code; the result arrives, the same row gains it.
  const b = transcript("run_cmd");
  b.clock(T0 + 500).add("session.created", { backend: "claude-code", backendSessionId: "proc_1", serveUrl: null });
  b.clock(T0 + 1000).add("run.event", { kind: "command", command: "npm test", toolCallId: "call-9" });
  const made = await openedFeed("run_cmd", b.events);
  let command = activity.buildActivityView(made.feed.get()).rows.find((row) => row.code === "CMD");
  assert.equal(command.exitCode, null, "no result yet: no exit code is invented");
  b.clock(T0 + 2000).add("run.event", { kind: "tool_result", tool: "call-9", isError: true, output: "1 failing test" });
  await made.feed.poll();
  command = activity.buildActivityView(made.feed.get()).rows.find((row) => row.code === "CMD");
  assert.deepEqual([command.exitCode, command.exitSource], [1, "inferred"], "the result completes the same command row");
});



test("A13 paused catch-up: while paused the stream holds, but the cursor still fetches EVERY new event — 260 new events are all counted, and resume shows all of them without a hole or a duplicate", async () => {
  const b = transcript("run_catchup");
  b.clock(T0 + 1000);
  for (let i = 0; i < 20; i += 1) say(b, T0 + 1000 + i, `first ${i + 1}`);
  const made = await openedFeed("run_catchup", b.events);
  const { feed, pages } = made;
  const before = activity.buildActivityView(feed.get());
  assert.equal(before.rows.length, 20);
  const lastBefore = feed.get().lastSeq;
  assert.equal(feed.pause("scroll"), true);
  for (let i = 0; i < 260; i += 1) say(b, T0 + 5000 + i, `late ${i + 1}`);
  assert.equal(await feed.poll(), true);
  const paused = activity.buildActivityView(feed.get());
  assert.equal(paused.rows.length, 20, "the visible stream does not move while paused");
  assert.equal(paused.newCount, 260, "every new event is counted, not just one page");
  assert.ok(feed.get().lastSeq > lastBefore, "the cursor advanced to the newest received event");
  assert.ok(pages.some((query) => Number.isInteger(query.beforeSeq)), "the catch-up paged back with beforeSeq to join the old prefix");
  assert.ok(pages.filter((query) => Number.isInteger(query.beforeSeq)).every((query) => query.afterSeq === lastBefore), "every older page keeps the same afterSeq lower bound");

  assert.equal(feed.follow(), true);
  const resumed = activity.buildActivityView(feed.get());
  assert.equal(resumed.rows.length, 280, "all 20 + 260 rows are there after resume");
  assert.deepEqual(resumed.rows.map((row) => row.seq), Array.from({ length: 280 }, (_, i) => i + 2), "no duplicate, no hole");
  assert.equal(new Set(resumed.rows.map((row) => row.key)).size, 280);
  assert.equal(resumed.newCount, 0);
});

test("A14 a burst between two polls: 250 new events in one tick are all caught up (one newest page plus the older pages back to the cursor), never silently cut at 200", async () => {
  const b = transcript("run_burst");
  b.clock(T0 + 1000);
  for (let i = 0; i < 20; i += 1) say(b, T0 + 1000 + i, `first ${i + 1}`);
  const made = await openedFeed("run_burst", b.events);
  const { feed, pages } = made;
  const lastBefore = feed.get().lastSeq;
  for (let i = 0; i < 250; i += 1) say(b, T0 + 5000 + i, `burst ${i + 1}`);
  await feed.poll();
  assert.ok(pages.some((query) => query.afterSeq === lastBefore && Number.isInteger(query.beforeSeq)), "the burst was caught up with afterSeq + beforeSeq, not a fresh newest page");
  const vm = activity.buildActivityView(feed.get());
  assert.equal(vm.rows.length, 270, "20 + 250");
  assert.deepEqual(vm.rows.map((row) => row.seq), Array.from({ length: 270 }, (_, i) => i + 2));
  assert.equal(vm.rows.some((row) => row.row === "unloaded"), false);
});

test("A15 a catch-up longer than the page cap stops with an explicit not-loaded line (its range and a reload), and reload starts a fresh newest page", async () => {
  const b = transcript("run_hole");
  b.clock(T0 + 1000);
  for (let i = 0; i < 20; i += 1) say(b, T0 + 1000 + i, `first ${i + 1}`);
  const made = await openedFeed("run_hole", b.events);
  const lastBefore = made.feed.get().lastSeq;
  for (let i = 0; i < 2000; i += 1) say(b, T0 + 5000 + i, `bulk ${i + 1}`);
  await made.feed.poll();
  const vm = activity.buildActivityView(made.feed.get());
  const hole = vm.rows.find((row) => row.row === "unloaded");
  assert.ok(hole, "the cap produces a not-loaded marker instead of a silent jump");
  assert.equal(hole.fromSeq, lastBefore + 1);
  assert.ok(hole.toSeq > hole.fromSeq, "the marker names the missing range");
  assert.ok(vm.rows.filter((row) => row.row === "event").length >= 200, "the newest pages that were fetched are still shown");

  const { root, actions } = renderActivity(vm);
  const line = byClass(root, "act-unloaded")[0];
  assert.ok(line);
  assert.match(line.textContent, new RegExp(`#${String(hole.fromSeq).padStart(4, "0")}–${String(hole.toSeq).padStart(4, "0")}`));
  assert.match(line.textContent, /not loaded/);
  const reload = byClass(line, "act-reload-btn")[0];
  reload.click();
  assert.deepEqual(actions.calls.pop(), ["reloadActivity"]);

  assert.equal(made.feed.reload(), true);
  await settle();
  const fresh = activity.buildActivityView(made.feed.get());
  assert.equal(fresh.rows.length, 200, "reload comes back with the newest page only");
  assert.equal(fresh.rows.some((row) => row.row === "unloaded"), false);
  assert.ok(fresh.rows.every((row) => row.row === "event"));
  assert.equal(fresh.lastSeq, lastBefore + 2000);
});

test("A15b while paused, a catch-up stopped at the page cap says ↓ 1600+ (not an exact number) and says some events in between were not loaded", async () => {
  const b = transcript("run_hicap");
  b.clock(T0 + 1000);
  for (let i = 0; i < 20; i += 1) say(b, T0 + 1000 + i, `first ${i + 1}`);
  const { feed } = await openedFeed("run_hicap", b.events);
  assert.equal(feed.pause("scroll"), true);
  for (let i = 0; i < 2000; i += 1) say(b, T0 + 5000 + i, `bulk ${i + 1}`);
  await feed.poll();
  const vm = activity.buildActivityView(feed.get());
  assert.equal(vm.newCount, 1600, "eight pages of 200 visible events");
  assert.equal(vm.newCountExact, false);
  const { root } = renderActivity(vm);
  assert.equal(byClass(root, "act-new-btn")[0].textContent, "↓ 1600+ new events");
  assert.equal(byClass(root, "act-new-note")[0].textContent, "some events in between were not loaded");
  assert.equal(feed.follow(), true);
  const resumed = activity.buildActivityView(feed.get());
  assert.ok(resumed.rows.some((row) => row.row === "unloaded"));
});


test("A22 hidden count is for the whole loaded range: an unchanged poll keeps it, a newly hidden event adds to it", async () => {
  const b = transcript("run_hiddencount");
  b.clock(T0 + 1000);
  say(b, T0 + 1000, "only message");
  b.add("run.event", { kind: "runtime_activity", status: "process_active" });
  const { feed } = await openedFeed("run_hiddencount", b.events);
  assert.equal(feed.setFilter("messages"), true);
  await settle();
  const hidden = () => activity.buildActivityView(feed.get()).hiddenFiltered;
  assert.equal(hidden(), 1, "the RT event is hidden by the Messages filter");
  await feed.poll();
  assert.equal(hidden(), 1, "an unchanged poll must not clear the hidden count");
  await feed.poll();
  assert.equal(hidden(), 1);
  b.clock(T0 + 2000).add("run.event", { kind: "runtime_activity", status: "streaming" });
  await feed.poll();
  assert.equal(hidden(), 2, "a newly loaded hidden event adds to the loaded range");
  await feed.poll();
  assert.equal(hidden(), 2);
});

test("A23 the + belongs only to the pause that hit the cap: after resume and a new pause with one fully caught-up event, the count is exactly ↓ 1", async () => {
  const b = transcript("run_plus");
  b.clock(T0 + 1000);
  for (let i = 0; i < 20; i += 1) say(b, T0 + 1000 + i, `first ${i + 1}`);
  const { feed } = await openedFeed("run_plus", b.events);
  assert.equal(feed.pause("scroll"), true);
  for (let i = 0; i < 1601; i += 1) say(b, T0 + 5000 + i, `bulk ${i + 1}`);
  await feed.poll();
  assert.equal(feed.get().newCount, 1600);
  assert.equal(feed.get().newCountExact, false, "this pause hit the cap");
  assert.equal(feed.follow(), true);
  assert.ok(feed.get().rows.some((row) => row.row === "unloaded"), "the old gap stays visible as a marker");
  assert.equal(feed.pause("scroll"), true);
  say(b, T0 + 9000, "one after resume");
  await feed.poll();
  assert.equal(feed.get().newCount, 1);
  assert.equal(feed.get().newCountExact, true, "the old marker is not this pause's gap");
  const { root } = renderActivity(activity.buildActivityView(feed.get()));
  assert.equal(byClass(root, "act-new-btn")[0].textContent, "↓ 1 new events");
  assert.equal(byClass(root, "act-new-note").length, 0);
});

test("A24 a mixed stream that grows an unnumbered tail switches the whole feed to replace mode: empty polls keep the fold count flat instead of adding the same 1,000 rows again", async () => {
  const b = transcript("run_mixedtail");
  b.clock(T0 + 1000);
  say(b, T0 + 1000, "to #2");
  const { feed } = await openedFeed("run_mixedtail", b.events);
  say(b, T0 + 2000, "numbered #3");
  for (let i = 0; i < 1001; i += 1) b.add("run.event", { kind: "runtime_activity", status: "process_active" }, { noSeq: true });
  await feed.poll();
  assert.equal(feed.get().replaceWhole, true, "an unnumbered timeline row puts this session on whole-page replace");
  assert.equal(feed.get().lastSeq, null);
  await feed.poll();
  const first = activity.buildActivityView(feed.get());
  await feed.poll();
  const second = activity.buildActivityView(feed.get());
  const folds = (vm) => vm.rows.filter((row) => row.code === "RT").map((row) => row.count);
  assert.deepEqual(folds(second), folds(first), "the same page is not merged into itself on every poll");
  assert.ok(folds(second).length > 0 && folds(second)[0] > 0);
  assert.equal(second.rows.some((row) => row.row === "unloaded"), false, "replace mode does not pretend there is a cursor gap");
});


test("A16 a folded run keeps the server's count across a page seam with a hidden event in between: 300 RT + a hidden prompt.sent + one RT is 201, not 202", async () => {
  const b = transcript("run_fold");
  b.clock(T0 + 1000);
  for (let i = 0; i < 300; i += 1) b.add("run.event", { kind: "runtime_activity", status: "process_active" });
  const made = await openedFeed("run_fold", b.events);
  const { feed } = made;
  let vm = activity.buildActivityView(feed.get());
  const initial = vm.rows.find((row) => row.code === "RT");
  assert.ok(initial, "the long run is folded");
  const count = initial.count;
  assert.ok(count > 0);
  assert.equal(feed.pause("scroll"), true);

  // #302 is a control-plane fact (not on the timeline, filtered out); #303 is the next RT event.
  b.clock(T0 + 2000).add("prompt.sent", { prompt: "# hidden\nnot shown" });
  b.add("run.event", { kind: "runtime_activity", status: "process_active" });
  await feed.poll();
  vm = activity.buildActivityView(feed.get());
  assert.equal(vm.newCount, 1, "one new visible event");
  assert.equal(vm.newCountExact, true);
  const pendingFolds = feed.get().pendingRows.filter((row) => row.code === "RT");
  assert.equal(pendingFolds.length, 1, "the page seam is one row in the held-back tail, not two");
  assert.equal(pendingFolds[0].count, count + 1, "the hidden event is not counted as runtime activity");
  assert.equal(feed.follow(), true);
  const resumed = activity.buildActivityView(feed.get());
  const folds = resumed.rows.filter((row) => row.code === "RT");
  assert.equal(folds.length, 1);
  assert.equal(folds[0].count, count + 1);
});

test("A16b a transcript without event numbers replaces the newest page each poll: the folded count stays 3 instead of growing to 6 / 9", async () => {
  const events = Array.from({ length: 3 }, (_, i) => ({
    type: "run.event", runId: "run_unseq", agentId: "glm-pro",
    ts: iso(T0 + 1000 + i), kind: "runtime_activity", status: "process_active",
  }));
  const { feed } = await openedFeed("run_unseq", events);
  const count = () => activity.buildActivityView(feed.get()).rows.find((row) => row.code === "RT").count;
  assert.equal(count(), 3);
  await feed.poll();
  assert.equal(count(), 3, "first empty poll does not merge the same page again");
  await feed.poll();
  assert.equal(count(), 3, "second empty poll too");
});


test("A18 Open full on a long command replaces the summary with the fetched text: page 1 is shown, the pager reaches page 2, and a single-page text still has a way back", async () => {
  const long = `npm test -- ${"x".repeat(70_000)}`;
  const b = transcript("run_bigcmd");
  b.clock(T0 + 1000).add("run.event", { kind: "command", command: long, toolCallId: "big-1", exitCode: 0 });
  const made = await openedFeed("run_bigcmd", b.events);
  let vm = activity.buildActivityView(made.feed.get());
  const cmd = vm.rows.find((row) => row.code === "CMD");
  assert.equal(cmd.truncated, true, "the command summary is clipped");
  assert.equal(cmd.part, "command");
  assert.equal(made.feed.openFull(cmd.key), true);
  await settle();
  vm = activity.buildActivityView(made.feed.get());
  const fullRow = vm.rows.find((row) => row.key === cmd.key);
  assert.equal(fullRow.full.state, "ready");
  assert.ok(fullRow.full.totalPages > 1, "the text spans more than one page");
  const page1 = projectWorkerEvent({ runId: "run_bigcmd", events: b.events, env: {}, seq: cmd.seq, part: "command", page: 1 });
  assert.equal(fullRow.full.text, page1.text);

  let { root, actions } = renderActivity(vm);
  const block = byClass(root, "act-full-block")[0];
  assert.ok(block, "the full text is drawn");
  assert.equal(byClass(root, "act-summary").length, 0, "the summary was replaced, not shown beside it");
  assert.equal(byClass(block, "act-full-text")[0].textContent, page1.text);
  assert.match(byClass(block, "act-page")[0].textContent, /^1 \/ \d+$/);

  assert.equal(made.feed.fullPage(cmd.key, 1), true);
  await settle();
  vm = activity.buildActivityView(made.feed.get());
  const page2 = projectWorkerEvent({ runId: "run_bigcmd", events: b.events, env: {}, seq: cmd.seq, part: "command", page: 2 });
  assert.equal(vm.rows.find((row) => row.key === cmd.key).full.text, page2.text);
  ({ root, actions } = renderActivity(vm, "en", recorder(), SUI(), region()));
  assert.match(byClass(root, "act-page")[0].textContent, /^2 \/ \d+$/);

  // A single-page text has the close button too (the pager is not conditional on page count).
  const short = transcript("run_shortcmd");
  short.clock(T0 + 1000).add("run.event", { kind: "command", command: `echo ${"y".repeat(2000)}`, toolCallId: "short-1", exitCode: 0 });
  const shortFeed = await openedFeed("run_shortcmd", short.events);
  const shortRow = activity.buildActivityView(shortFeed.feed.get()).rows.find((row) => row.code === "CMD");
  assert.equal(shortFeed.feed.openFull(shortRow.key), true);
  await settle();
  const single = activity.buildActivityView(shortFeed.feed.get()).rows.find((row) => row.key === shortRow.key);
  assert.equal(single.full.totalPages, 1);
  const singleRender = renderActivity(activity.buildActivityView(shortFeed.feed.get()));
  const close = find(singleRender.root, (node) => node.getAttribute("data-fk") === `act-close-full:${shortRow.key}`)[0];
  assert.ok(close, "a single-page full text can be closed");
  close.click();
  assert.deepEqual(singleRender.actions.calls.pop(), ["closeActivityFull", shortRow.key]);
});

test("A21 hidden events are covered by the page range, not by the displayed rows: 1,600 messages interleaved with hidden RT events at the catch-up limit leave no false not-loaded row and count exactly 1,600", async () => {
  const b = transcript("run_hidden");
  b.clock(T0 + 1000);
  say(b, T0 + 1000, "start");
  const made = await openedFeed("run_hidden", b.events);
  const { feed } = made;
  assert.equal(feed.setFilter("messages"), true);
  await settle();
  assert.equal(feed.pause("scroll"), true);
  for (let i = 0; i < 1600; i += 1) {
    b.clock(T0 + 2000 + i * 2).add("run.event", { kind: "runtime_activity", status: "process_active" });
    b.clock(T0 + 2001 + i * 2);
    say(b, T0 + 2001 + i * 2, `msg ${i + 1}`);
  }
  await feed.poll();
  const vm = activity.buildActivityView(feed.get());
  assert.equal(vm.rows.some((row) => row.row === "unloaded"), false, "the hidden RT events are inside the ranges, so there is no hole");
  assert.equal(vm.newCount, 1600, "exactly the visible new messages");
  assert.equal(vm.newCountExact, true);
  assert.equal(feed.follow(), true);
  const shown = activity.buildActivityView(feed.get());
  assert.equal(shown.rows.filter((row) => row.row === "event").length, 1601, "the old message plus 1,600 new ones");
  assert.equal(shown.rows.some((row) => row.row === "unloaded"), false);
});


// =====================================================================
// S) THE EVENT STREAM (batch 144, decision 0131 section 4)
// =====================================================================
//
// The feed reads the stream through an injected fetchStream (the app wires api.js's readStream to
// it; S13 does that through the app, S14 tests readStream itself). The frames are what the server
// sends: the page of projectWorkerActivity after the cursor (ownerDashboardV2Stream.test.js pins
// the server to that), so the rows that arrive here are the server's real ones.

/** A fake event stream: fetchStream answers from here; the test pushes frames into an open stream or ends it. */
function streamHub({ failWith = null } = {}) {
  const calls = [];
  const open = [];
  const hub = {
    calls,
    open,
    failure: failWith,
    fetchStream(query) {
      calls.push(query);
      if (hub.failure !== null) return Promise.resolve({ ok: false, reason: hub.failure });
      return new Promise((resolve) => {
        const attempt = { query, resolve, ended: false };
        open.push(attempt);
        query.signal.addEventListener("abort", () => {
          attempt.ended = true;
          resolve({ ok: false, reason: "aborted" });
        }, { once: true });
      });
    },
    /** One frame from the server into open stream number `at`. */
    frame(at, event, data, id = `k${at}`) { open[at].query.onFrame({ id, event, data }); },
    end(at, result = { ok: true, done: true }) {
      const attempt = open[at];
      if (attempt.ended) return;
      attempt.ended = true;
      attempt.resolve(result);
    },
  };
  return hub;
}

/** A feed over one run whose transcript `eventsOf()` may grow, reading the stream through `hub`. */
function streamFeed(hub, runId, eventsOf) {
  const pages = [];
  const feed = activity.createActivityFeed({
    fetchPage: async (query) => { pages.push(query); return { ok: true, body: pageOf(runId, eventsOf(), query) }; },
    fetchFull: async () => ({ ok: false, reason: "notFound" }),
    fetchStream: hub.fetchStream,
  });
  return { feed, pages };
}
const statusText = (vm, lang = "en") => byClass(renderActivity(vm, lang, recorder(), SUI(), region()).root, "act-status")[0].textContent;

test("S1 the stream goes Live on its first frame: the first page starts it with runId, filter, afterSeq = the last seq received and a cancellable signal; frames take the same merge path; nothing is polled while Live; both languages say Live", async () => {
  const b = liveTranscript();
  let events = b.events;
  const hub = streamHub();
  const { feed, pages } = streamFeed(hub, "run_live", () => events);
  feed.open("run_live");
  await settle();
  assert.equal(hub.calls.length, 1, "the first page starts the stream");
  const query = hub.calls[0];
  const lastSeq = feed.get().lastSeq;
  assert.deepEqual([query.runId, query.filter, query.afterSeq, "cursor" in query, typeof query.onFrame], ["run_live", "all", lastSeq, false, "function"]);
  assert.equal(query.signal.aborted, false, "the feed hands out a signal it can cancel");
  let vm = activity.buildActivityView(feed.get());
  assert.deepEqual(vm.freshness, { kind: "polling", sinceMs: null }, "not Live before the first frame");

  // The server's first frame: the page after the position it was asked for (no new row here).
  hub.frame(0, "rows", pageOf("run_live", events, { afterSeq: lastSeq }));
  vm = activity.buildActivityView(feed.get());
  assert.deepEqual(vm.freshness, { kind: "live", sinceMs: null });
  assert.equal(statusText(vm), "Live");
  assert.equal(statusText(vm, "zh"), "实时");

  // A new event arrives through the stream: appended by the same merge path, and no poll is made.
  const before = vm.rows.map((row) => row.key);
  say(b, T0 + 3000, "second line");
  events = b.events;
  hub.frame(0, "rows", pageOf("run_live", events, { afterSeq: lastSeq }));
  vm = activity.buildActivityView(feed.get());
  assert.deepEqual(vm.rows.map((row) => row.key), [...before, "event:4"], "exactly one new row, after the ones already shown");
  assert.equal(vm.newCount, 0, "following applies it at once");
  assert.equal(feed.get().lastSeq, 4, "the seq cursor moved with the frame");
  const asked = pages.length;
  assert.equal(await feed.poll(), false, "a tick while Live polls nothing");
  assert.equal(pages.length, asked);
  assert.deepEqual(activity.buildActivityView(feed.get()).freshness, { kind: "live", sinceMs: null });
  assert.equal(hub.calls.length, 1, "and does not open a second stream");
});

test("S2 an update frame swaps the row already shown (a command gains its exit code): it adds no row and moves no cursor", async () => {
  const b = transcript("run_cmd");
  b.clock(T0 + 500).add("session.created", { backend: "claude-code", backendSessionId: "proc_1", serveUrl: null });
  b.clock(T0 + 1000).add("run.event", { kind: "command", command: "npm test", toolCallId: "call-9" });
  b.clock(T0 + 2000).add("run.event", { kind: "message", role: "assistant", parts: [{ type: "text", text: "working" }] });
  let events = b.events;
  const hub = streamHub();
  const { feed } = streamFeed(hub, "run_cmd", () => events);
  feed.open("run_cmd");
  await settle();
  hub.frame(0, "rows", pageOf("run_cmd", events, { afterSeq: feed.get().lastSeq }));
  let vm = activity.buildActivityView(feed.get());
  assert.equal(vm.freshness.kind, "live");
  assert.equal(vm.rows.find((row) => row.code === "CMD").exitCode, null, "no result yet: no exit code is invented");
  const shown = vm.rows.length;
  const cursor = feed.get().lastSeq;

  b.clock(T0 + 3000).add("run.event", { kind: "tool_result", tool: "call-9", output: "1 failing test", isError: true });
  events = b.events;
  const page = projectWorkerActivity({ runId: "run_cmd", events, env: {}, afterSeq: cursor });
  assert.equal(page.updates.length, 1, "the server's page carries the changed command as an update");
  hub.frame(0, "rows", { ...page, updates: [] }, "k1"); // the server's rows frame carries no updates
  hub.frame(0, "update", { runId: "run_cmd", updates: page.updates }, "k1"); // they are their own frame, same cursor
  vm = activity.buildActivityView(feed.get());
  const command = vm.rows.find((row) => row.code === "CMD");
  assert.deepEqual([command.exitCode, command.exitSource], [1, "inferred"], "the same command row, completed in place");
  assert.equal(vm.rows.filter((row) => row.code === "CMD").length, 1, "no second copy of the command");
  assert.equal(vm.rows.length, shown + 1, "only the output row was added");
  assert.equal(feed.get().lastSeq, cursor + 1);
  assert.equal(vm.freshness.kind, "live");
});

test("S3 three stream failures in a row turn the tab back to polling: each poll is followed by one more try, the third failure ends the tries; the 5 s poll keeps asking after its cursor the whole time; coming back to the tab tries again", async () => {
  const b = liveTranscript();
  let events = b.events;
  const hub = streamHub({ failWith: "network" });
  const { feed, pages } = streamFeed(hub, "run_live", () => events);
  feed.open("run_live");
  await settle();
  assert.equal(hub.calls.length, 1, "the first try follows the first page");
  say(b, T0 + 3000, "second line");
  events = b.events;
  assert.equal(await feed.poll(), true);
  assert.equal(hub.calls.length, 2, "the second try follows that poll");
  assert.equal(pages.at(-1).afterSeq, 3, "the poll asks after its own cursor");
  assert.deepEqual(activity.buildActivityView(feed.get()).rows.map((row) => row.key).slice(-1), ["event:4"], "and the event arrived by polling");
  // (A real tick is 5 s after the last: the failed try is long over. A try still on the wire would keep the tick quiet.)
  await settle();
  await feed.poll();
  assert.equal(hub.calls.length, 3, "the third try");
  await settle();
  await feed.poll();
  await settle();
  await feed.poll();
  assert.equal(hub.calls.length, 3, "three in a row: no more tries");
  assert.equal(pages.filter((query) => Number.isInteger(query.afterSeq)).length, 4, "the 5 s poll went on the whole time, once per tick");
  let vm = activity.buildActivityView(feed.get());
  assert.equal(vm.freshness.kind, "polling");
  assert.equal(statusText(vm), "Polling 5s");

  feed.setVisible(false);
  assert.equal(feed.setVisible(true), true, "coming back to the tab restarts the stream");
  await settle();
  assert.equal(hub.calls.length, 4, "a fresh try, with no cursor");
  assert.equal("cursor" in hub.calls[3], false);

  // Giving up is per worker too: another worker opens, and its stream is tried again.
  const hub2 = streamHub({ failWith: "network" });
  const second = activity.createActivityFeed({
    fetchPage: async (query) => ({ ok: true, body: pageOf(query.runId, liveTranscript(query.runId).events, query) }),
    fetchFull: async () => ({ ok: false, reason: "notFound" }),
    fetchStream: hub2.fetchStream,
  });
  second.open("run_other");
  await settle();
  for (let i = 0; i < 4; i += 1) await second.poll();
  assert.deepEqual([hub2.calls.length, hub2.calls.every((call) => call.runId === "run_other")], [3, true], "run_other: three tries, then polling only");
  second.open("run_live");
  await settle();
  assert.deepEqual([hub2.calls.length, hub2.calls[3].runId, "cursor" in hub2.calls[3]], [4, "run_live", false], "switching the worker tries the stream again, for the new one and with no cursor");
});

test("S4 a read timeout is a failed try like any other; a rejected token (401) is not counted and is not retried until the tab comes back", async () => {
  for (const reason of ["timeout", "server", "notFound"]) {
    const hub = streamHub({ failWith: reason });
    const { feed } = streamFeed(hub, "run_live", () => liveTranscript().events);
    feed.open("run_live");
    await settle();
    for (let i = 0; i < 4; i += 1) await feed.poll();
    assert.equal(hub.calls.length, 3, `${reason} counts: three tries, then polling only`);
  }
  const hub = streamHub({ failWith: "unauthorized" });
  const { feed } = streamFeed(hub, "run_live", () => liveTranscript().events);
  feed.open("run_live");
  await settle();
  for (let i = 0; i < 4; i += 1) await feed.poll();
  assert.equal(hub.calls.length, 1, "401 is not a dropped stream: it is not retried on every tick");
  feed.setVisible(false);
  feed.setVisible(true);
  await settle();
  assert.equal(hub.calls.length, 2, "but the tab coming back tries once more");
});

test("S6 A -> B -> A: switching the worker cancels the old stream; a late frame of the old A, of B, or of another run never lands on the current one", async () => {
  const hub = streamHub();
  const a = liveTranscript("run_a").events;
  // The same run A, one message later: what a late or a current frame of A could carry.
  const aLater = [...a, { type: "run.event", runId: "run_a", agentId: "glm-pro", seq: 4, ts: iso(T0 + 20_000), kind: "message", role: "assistant", parts: [{ type: "text", text: "late A row" }] }];
  const bEvents = liveTranscript("run_b").events;
  const bLater = [...bEvents, { type: "run.event", runId: "run_b", agentId: "glm-pro", seq: 4, ts: iso(T0 + 20_000), kind: "message", role: "assistant", parts: [{ type: "text", text: "late B row" }] }];
  const feed = activity.createActivityFeed({
    fetchPage: async (query) => ({ ok: true, body: pageOf(query.runId, query.runId === "run_a" ? a : bEvents, query) }),
    fetchFull: async () => ({ ok: false, reason: "notFound" }),
    fetchStream: hub.fetchStream,
  });
  feed.open("run_a");
  await settle();
  assert.equal(hub.calls[0].runId, "run_a");
  hub.frame(0, "rows", pageOf("run_a", a, { afterSeq: feed.get().lastSeq }));
  assert.equal(activity.buildActivityView(feed.get()).freshness.kind, "live");

  feed.open("run_b");
  await settle();
  assert.equal(hub.calls[0].signal.aborted, true, "A's stream was cancelled when B opened");
  assert.equal(hub.calls[1].runId, "run_b");
  hub.frame(1, "rows", pageOf("run_b", bEvents, { afterSeq: feed.get().lastSeq }));

  feed.open("run_a");
  await settle();
  assert.equal(hub.calls[1].signal.aborted, true, "B's stream was cancelled when A opened again");
  assert.equal(hub.calls[2].runId, "run_a", "a third selection opens a third stream");
  assert.equal(activity.buildActivityView(feed.get()).freshness.kind, "polling", "not Live until the new stream's first frame");
  assert.equal(activity.buildActivityView(feed.get()).rows.find((row) => row.code === "MSG").summary, "first line", "the fresh A page, not B's");

  // Late frames: the FIRST A stream (its own run, but a past attempt), B's stream, and a frame of another run on the current stream.
  const shown = activity.buildActivityView(feed.get()).rows.map((row) => row.key);
  hub.frame(0, "rows", pageOf("run_a", aLater, { afterSeq: 3 })); // the first A stream: its own run, but a past attempt
  hub.frame(1, "rows", pageOf("run_b", bLater, { afterSeq: 3 })); // B's stream
  hub.frame(2, "rows", pageOf("run_b", bLater, { afterSeq: 3 })); // the current A stream, but a frame of another run
  let vm = activity.buildActivityView(feed.get());
  assert.deepEqual(vm.rows.map((row) => row.key), shown, "none of them lands on A");
  assert.equal(vm.freshness.kind, "polling");

  hub.frame(2, "rows", pageOf("run_a", aLater, { afterSeq: 3 }));
  vm = activity.buildActivityView(feed.get());
  assert.deepEqual(vm.rows.map((row) => row.key).slice(-1), ["event:4"], "the current A stream's own frame does");
  assert.equal(vm.freshness.kind, "live");
});

test("S7 paused: the stream keeps arriving, but nothing is drawn and the count of new events grows; resume applies what waited", async () => {
  const b = liveTranscript();
  let events = b.events;
  const hub = streamHub();
  const { feed } = streamFeed(hub, "run_live", () => events);
  feed.open("run_live");
  await settle();
  const lastSeq = feed.get().lastSeq;
  hub.frame(0, "rows", pageOf("run_live", events, { afterSeq: lastSeq }));
  const shown = activity.buildActivityView(feed.get()).rows.length;
  assert.equal(feed.pause("selection"), true);
  say(b, T0 + 3000, "held back 1");
  events = b.events;
  hub.frame(0, "rows", pageOf("run_live", events, { afterSeq: lastSeq }));
  say(b, T0 + 4000, "held back 2");
  events = b.events;
  hub.frame(0, "rows", pageOf("run_live", events, { afterSeq: 4 }));
  let vm = activity.buildActivityView(feed.get());
  assert.equal(vm.rows.length, shown, "while paused the stream does not move");
  assert.equal(vm.newCount, 2, "both events are counted");
  assert.equal(feed.get().lastSeq, 5, "and the cursor still moves on");
  assert.equal(vm.freshness.kind, "live");
  assert.equal(feed.follow(), true);
  vm = activity.buildActivityView(feed.get());
  assert.equal(vm.rows.length, shown + 2, "resume applies everything that waited");
  assert.equal(vm.newCount, 0);
});

test("S8 end: the run's last rows arrive, then the end frame ends the stream for good — the tab stays with how many events the run has and never reconnects", async () => {
  const b = liveTranscript("run_done");
  let events = b.events;
  const hub = streamHub();
  const { feed } = streamFeed(hub, "run_done", () => events);
  feed.open("run_done");
  await settle();
  const lastSeq = feed.get().lastSeq;
  hub.frame(0, "rows", pageOf("run_done", events, { afterSeq: lastSeq }));
  b.clock(T0 + 3000).add("run.event", { kind: "message", role: "assistant", parts: [{ type: "text", text: "last words" }] });
  b.clock(T0 + 4000).add("run.completed", {});
  b.add("run.state_change", { from: "running", to: "completed", reason: "completed" });
  events = b.events;
  hub.frame(0, "rows", pageOf("run_done", events, { afterSeq: lastSeq }), "k9");
  hub.frame(0, "end", { runId: "run_done", state: "completed", terminal: true, total: events.length }, "k9");
  let vm = activity.buildActivityView(feed.get());
  assert.equal(vm.terminal, true);
  assert.deepEqual(vm.freshness, { kind: "ended", sinceMs: null });
  assert.equal(vm.total, events.length, "the count is the run's own event total, as the end frame gives it");
  assert.equal(statusText(vm), `Ended · ${events.length} events`);
  assert.equal(statusText(vm, "zh"), `已结束，共 ${events.length} 条`);
  assert.equal(hub.calls[0].signal.aborted, true, "the stream is let go");
  assert.equal(await feed.poll(), false, "no more polling");
  feed.setVisible(false);
  feed.setVisible(true);
  await settle();
  assert.equal(hub.calls.length, 1, "and no reconnect");
});

test("S9 reset: the cursor is no good any more — the feed takes a fresh newest page in its place, then reconnects without a cursor; paused, only the held-back copy is replaced", async () => {
  const b = liveTranscript("run_reset");
  let events = b.events;
  const hub = streamHub();
  const { feed, pages } = streamFeed(hub, "run_reset", () => events);
  feed.open("run_reset");
  await settle();
  const lastSeq = feed.get().lastSeq;
  hub.frame(0, "rows", pageOf("run_reset", events, { afterSeq: lastSeq }), "k5");
  assert.equal(activity.buildActivityView(feed.get()).freshness.kind, "live");
  // The transcript is replaced by a different, longer one.
  const fresh = transcript("run_reset");
  fresh.clock(T0 + 1000);
  say(fresh, T0 + 1000, "the replacement file, row one");
  say(fresh, T0 + 2000, "the replacement file, row two");
  events = fresh.events;
  const asked = pages.length;
  hub.frame(0, "reset", { runId: "run_reset", reason: "changed" });
  await settle();
  assert.equal(pages.length, asked + 1, "a new newest page was asked for");
  assert.equal("afterSeq" in pages.at(-1), false, "a snapshot, not a page after a cursor");
  let vm = activity.buildActivityView(feed.get());
  assert.deepEqual(vm.rows.map((row) => row.summary), ["the replacement file, row one", "the replacement file, row two"], "the shown table is the fresh page");
  assert.equal(vm.freshness.kind, "polling");
  await feed.poll();
  assert.equal(hub.calls.length, 2, "the stream is opened again");
  assert.deepEqual(["cursor" in hub.calls[1], hub.calls[1].afterSeq], [false, feed.get().lastSeq], "from the new page, with no cursor");

  // Paused: what is on screen stays; what resume will show is the fresh page.
  const second = streamHub();
  let shown = liveTranscript("run_paused_reset").events;
  const other = streamFeed(second, "run_paused_reset", () => shown);
  other.feed.open("run_paused_reset");
  await settle();
  second.frame(0, "rows", pageOf("run_paused_reset", shown, { afterSeq: other.feed.get().lastSeq }));
  other.feed.pause("scroll");
  const visible = activity.buildActivityView(other.feed.get()).rows.map((row) => row.key);
  shown = everyType("run_paused_reset");
  second.frame(0, "reset", { runId: "run_paused_reset", reason: "cursor" });
  await settle();
  vm = activity.buildActivityView(other.feed.get());
  assert.deepEqual(vm.rows.map((row) => row.key), visible, "paused: the visible rows do not move");
  assert.equal(other.feed.get().pendingRows.length, 10, "the held-back copy is the fresh page");
});

test("S10 leaving the Activity tab cancels the stream and coming back reconnects from the last frame's cursor; a hidden tab opens no stream at all", async () => {
  const hub = streamHub();
  const { feed } = streamFeed(hub, "run_live", () => liveTranscript().events);
  feed.setVisible(false);
  feed.open("run_live");
  await settle();
  assert.equal(hub.calls.length, 0, "a hidden tab opens no stream");
  assert.equal(feed.setVisible(true), true);
  await settle();
  assert.equal(hub.calls.length, 1);
  const lastSeq = feed.get().lastSeq;
  hub.frame(0, "rows", pageOf("run_live", liveTranscript().events, { afterSeq: lastSeq }), "k7");
  assert.equal(activity.buildActivityView(feed.get()).freshness.kind, "live");
  assert.equal(feed.setVisible(false), true);
  assert.equal(hub.calls[0].signal.aborted, true, "the stream is cancelled with an AbortController");
  let vm = activity.buildActivityView(feed.get());
  assert.equal(vm.freshness.kind, "polling");
  // A frame of the cancelled stream that was already on the wire: dropped — that try is over, even though
  // the run and the epoch are still the same.
  const shown = vm.rows.map((row) => row.key);
  const later = [...liveTranscript("run_live").events, { type: "run.event", runId: "run_live", agentId: "glm-pro", seq: 4, ts: iso(T0 + 4000), kind: "message", role: "assistant", parts: [{ type: "text", text: "too late" }] }];
  hub.frame(0, "rows", pageOf("run_live", later, { afterSeq: 3 }), "k8");
  vm = activity.buildActivityView(feed.get());
  assert.deepEqual([vm.rows.map((row) => row.key), vm.freshness.kind, feed.get().lastSeq], [shown, "polling", 3], "the cancelled stream's late frame never lands");
  assert.equal(feed.setVisible(false), false, "already hidden");
  assert.equal(feed.setVisible(true), true);
  await settle();
  assert.equal(hub.calls.length, 2);
  assert.deepEqual([hub.calls[1].cursor, hub.calls[1].afterSeq], ["k7", lastSeq], "reconnects from the last frame's cursor");
  assert.equal(hub.calls[1].signal.aborted, false);
});

test("S11 a stream that drops hands its last cursor to the next try", async () => {
  const hub = streamHub();
  const { feed } = streamFeed(hub, "run_live", () => liveTranscript().events);
  feed.open("run_live");
  await settle();
  hub.frame(0, "rows", pageOf("run_live", liveTranscript().events, { afterSeq: feed.get().lastSeq }), "k3");
  assert.equal(activity.buildActivityView(feed.get()).freshness.kind, "live");
  hub.end(0, { ok: false, reason: "network" });
  await settle();
  assert.equal(activity.buildActivityView(feed.get()).freshness.kind, "polling", "no longer Live");
  await feed.poll();
  assert.equal(hub.calls.length, 2, "the next try follows the poll");
  assert.equal(hub.calls[1].cursor, "k3", "and carries the cursor of the last frame it received");
});

test("S12 reconcile: every twelfth tick re-reads the newest page and swaps the event rows the table already shows (a command whose exit code never arrived), in polling mode and in Live mode alike; it adds no row and never moves the seq cursor past a row the table does not have yet", async () => {
  assert.equal(activity.ACTIVITY_RECONCILE_EVERY_POLLS, 12, "once a minute at the 5 s tick");
  const withResult = () => {
    const b = transcript("run_rec");
    b.clock(T0 + 500).add("session.created", { backend: "claude-code", backendSessionId: "proc_1", serveUrl: null });
    b.clock(T0 + 1000).add("run.event", { kind: "command", command: "npm test", toolCallId: "call-9" });
    b.clock(T0 + 2000).add("run.event", { kind: "message", role: "assistant", parts: [{ type: "text", text: "working" }] });
    const before = [...b.events];
    b.clock(T0 + 3000).add("run.event", { kind: "tool_result", tool: "call-9", output: "1 failing test", isError: true });
    return { before, after: b.events };
  };
  /**
   * A feed whose pages after a cursor bring their rows but never an update (as if the update were dropped by
   * a full page); only a newest page — served from whatever `transcriptOf()` holds at that moment — carries
   * the exit code.
   */
  const wired = (hub, transcriptOf) => {
    const snapshots = [];
    const increments = [];
    const feed = activity.createActivityFeed({
      fetchPage: async (query) => {
        (Number.isInteger(query.afterSeq) ? increments : snapshots).push(query);
        const full = pageOf("run_rec", transcriptOf(), query);
        return { ok: true, body: Number.isInteger(query.afterSeq) ? { ...full, updates: [] } : full };
      },
      fetchFull: async () => ({ ok: false, reason: "notFound" }),
      fetchStream: hub.fetchStream,
    });
    return { feed, snapshots, increments };
  };
  const commandOf = (feed) => activity.buildActivityView(feed.get()).rows.find((row) => row.code === "CMD");
  const codesOf = (feed) => feed.get().rows.map((row) => row.code);
  const events = withResult();

  // Shape 1 — the result row already arrived (its update was dropped): the reconcile swaps the exit code in.
  let servedEarly = events.before;
  const polling = wired(streamHub({ failWith: "network" }), () => servedEarly);
  polling.feed.open("run_rec");
  await settle();
  assert.equal(commandOf(polling.feed).exitCode, null, "the first page was read before the result existed");
  servedEarly = events.after; // the result lands after the first page was read
  await polling.feed.poll(); // the result row arrives, but its update was dropped
  await settle(); // (the failed stream try is over before the next 5 s tick)
  const shown = activity.buildActivityView(polling.feed.get()).rows.length;
  const lastSeq = polling.feed.get().lastSeq;
  assert.deepEqual([shown, commandOf(polling.feed).exitCode], [3, null]);
  for (let tick = 2; tick <= 11; tick += 1) {
    await polling.feed.poll();
    await settle();
  }
  assert.deepEqual([polling.snapshots.length, commandOf(polling.feed).exitCode], [1, null], "eleven ticks: no snapshot yet, the row still lacks its exit code");
  await polling.feed.poll();
  assert.deepEqual([polling.snapshots.length, polling.increments.length, commandOf(polling.feed).exitCode], [2, 11, 1], "the twelfth tick re-read the newest page (instead of a page after the cursor) and the row caught up");
  assert.equal(polling.increments.filter((query) => "beforeSeq" in query).length, 0, "no catch-up paging: the transcript did not grow");
  assert.deepEqual(
    [activity.buildActivityView(polling.feed.get()).rows.length, polling.feed.get().lastSeq],
    [shown, lastSeq],
    "the reconcile adds no row and moves no cursor",
  );

  // Shape 2 (polling) — the transcript grows right before the reconcile tick, so the newest page holds a row the
  // table does not have yet. The reconcile still only swaps what the table shows: that row is not added, and
  // the cursor is not moved past it (it would never arrive then). The next page after the cursor brings it.
  let served = events.before;
  const late = wired(streamHub({ failWith: "network" }), () => served);
  late.feed.open("run_rec");
  await settle();
  for (let tick = 1; tick <= 11; tick += 1) {
    await late.feed.poll();
    await settle();
  }
  assert.deepEqual([codesOf(late.feed), late.feed.get().lastSeq, commandOf(late.feed).exitCode], [["CMD", "MSG"], 4, null]);
  served = events.after; // the result lands between the eleventh tick and the twelfth
  await late.feed.poll(); // the twelfth tick: the reconcile
  assert.deepEqual(
    [late.snapshots.length, codesOf(late.feed), late.feed.get().lastSeq, commandOf(late.feed).exitCode],
    [2, ["CMD", "MSG"], 4, 1],
    "the newest page had the result row and the exit code: only the shown command row was swapped, no row was added and the cursor stayed",
  );
  await late.feed.poll(); // the thirteenth tick: a page after the cursor
  assert.deepEqual([codesOf(late.feed), late.feed.get().lastSeq], [["CMD", "MSG", "OUT"], 5], "the result row arrives the normal way, after a cursor that was left alone");

  // Live mode — the same tick and the same reconcile for both shapes; the other ticks read nothing at all.
  let servedLive = events.before;
  const liveHub = streamHub();
  const live = wired(liveHub, () => servedLive);
  live.feed.open("run_rec");
  await settle();
  servedLive = events.after; // the result lands after the first page was read
  liveHub.frame(0, "rows", { ...projectWorkerActivity({ runId: "run_rec", events: servedLive, env: {}, afterSeq: live.feed.get().lastSeq }), updates: [] });
  assert.equal(commandOf(live.feed).exitCode, null, "the stream brought the result row without its update");
  for (let tick = 1; tick <= 11; tick += 1) await live.feed.poll();
  assert.deepEqual([live.snapshots.length, live.increments.length, commandOf(live.feed).exitCode], [1, 0, null], "while Live the other ticks read nothing at all (the one newest page is the first page)");
  await live.feed.poll();
  assert.deepEqual([live.snapshots.length, live.increments.length, commandOf(live.feed).exitCode], [2, 0, 1]);
  assert.equal(activity.buildActivityView(live.feed.get()).freshness.kind, "live", "still Live");

  let servedLive2 = events.before;
  const liveHub2 = streamHub();
  const live2 = wired(liveHub2, () => servedLive2);
  live2.feed.open("run_rec");
  await settle();
  liveHub2.frame(0, "rows", { ...projectWorkerActivity({ runId: "run_rec", events: servedLive2, env: {}, afterSeq: live2.feed.get().lastSeq }), updates: [] });
  assert.equal(activity.buildActivityView(live2.feed.get()).freshness.kind, "live");
  for (let tick = 1; tick <= 11; tick += 1) await live2.feed.poll();
  servedLive2 = events.after;
  await live2.feed.poll(); // the twelfth tick: the reconcile
  assert.deepEqual(
    [live2.snapshots.length, codesOf(live2.feed), live2.feed.get().lastSeq, commandOf(live2.feed).exitCode],
    [2, ["CMD", "MSG"], 4, 1],
    "Live: the newest page had the result row — nothing added, the cursor stayed, the shown command row caught up",
  );
  // The stream's own page after the cursor then brings the result row.
  liveHub2.frame(0, "rows", { ...projectWorkerActivity({ runId: "run_rec", events: servedLive2, env: {}, afterSeq: 4 }), updates: [] });
  assert.deepEqual(
    [codesOf(live2.feed), live2.feed.get().lastSeq, activity.buildActivityView(live2.feed.get()).freshness.kind],
    [["CMD", "MSG", "OUT"], 5, "live"],
  );
});

// ===== batch 144, fix 1: where the stream and the poll meet =====

/**
 * A feed whose page requests can be held or failed. The answer of a held request is the transcript AS IT WAS
 * WHEN IT WAS ASKED (a real server answers from the file at request time); it is delivered when released.
 */
function gatedFeed(hub, runId, eventsOf) {
  const pages = [];
  const held = [];
  const heldFull = [];
  const gate = { hold: () => false, fail: false, holdFull: false };
  const feed = activity.createActivityFeed({
    fetchPage: (query) => {
      pages.push(query);
      if (gate.fail) {
        gate.fail = false;
        return Promise.resolve({ ok: false, reason: "network" });
      }
      const answer = { ok: true, body: pageOf(runId, eventsOf(), query) };
      if (!gate.hold(query)) return Promise.resolve(answer);
      return new Promise((resolve) => held.push({ query, release: () => resolve(answer) }));
    },
    fetchFull: (query) => {
      const body = projectWorkerEvent({ runId, events: eventsOf(), env: {}, ...query });
      const answer = body === null ? { ok: false, reason: "notFound" } : { ok: true, body };
      if (!gate.holdFull) return Promise.resolve(answer);
      return new Promise((resolve) => heldFull.push({ query, release: () => resolve(answer) }));
    },
    fetchStream: hub.fetchStream,
  });
  return { feed, pages, held, heldFull, gate };
}

const runtimeRow = (b) => b.add("run.event", { kind: "runtime_activity", status: "process_active" });
/** run.started (#1, not on the timeline) and two runtime events (#2, #3): one folded row of two. */
function foldTranscript(runId) {
  const b = transcript(runId);
  b.clock(T0 + 1000);
  runtimeRow(b);
  runtimeRow(b);
  return b;
}
const foldsOf = (feed) => feed.get().rows.filter((row) => row.row === "fold").map((row) => [row.fromSeq, row.toSeq, row.count]);

test("S15 the stream request is out and its first frame has not come: the tick reads nothing after the cursor — the same runtime events reach the page by one path only, so a folded row's count is never added twice", async () => {
  // (a) Opus: the request is on the wire, the poll comes first, the first frame second.
  const b = foldTranscript("run_fold");
  let events = b.events;
  const hub = streamHub();
  const { feed, pages } = streamFeed(hub, "run_fold", () => events);
  feed.open("run_fold");
  await settle();
  assert.deepEqual([hub.calls.length, foldsOf(feed)], [1, [[2, 3, 2]]]);
  runtimeRow(b);
  runtimeRow(b);
  events = b.events; // #4 and #5
  const asked = pages.length;
  assert.equal(await feed.poll(), false, "the stream is on its way: the tick has nothing to ask");
  assert.equal(pages.length, asked, "no page after the cursor was fetched");
  hub.frame(0, "rows", pageOf("run_fold", events, { afterSeq: 3 }));
  assert.deepEqual(foldsOf(feed), [[2, 5, 4]], "four runtime events, folded once — not six");
  assert.equal(activity.buildActivityView(feed.get()).freshness.kind, "live");
});

test("S15b the other order: the tab comes back while a poll is on its way, or while the first page is still loading — no stream opens until it is done, and the rows still arrive by one path only", async () => {
  const c = foldTranscript("run_fold2");
  let eventsC = c.events;
  const hubC = streamHub();
  const gated = gatedFeed(hubC, "run_fold2", () => eventsC);
  gated.feed.setVisible(false);
  gated.feed.open("run_fold2");
  await settle();
  assert.equal(hubC.calls.length, 0, "a hidden tab opens no stream");
  runtimeRow(c);
  runtimeRow(c);
  eventsC = c.events;
  gated.gate.hold = (query) => Number.isInteger(query.afterSeq);
  const polled = gated.feed.poll();
  await settle();
  assert.equal(gated.held.length, 1, "the poll's page is on its way");
  gated.feed.setVisible(true);
  await settle();
  assert.equal(hubC.calls.length, 0, "no stream while a poll is in flight");
  gated.held[0].release();
  await polled;
  await settle();
  assert.deepEqual([hubC.calls.length, foldsOf(gated.feed)], [1, [[2, 5, 4]]], "the poll carried the rows, then the stream opened");
  assert.equal(hubC.calls[0].afterSeq, 5, "from the cursor the poll reached");
  hubC.frame(0, "rows", pageOf("run_fold2", eventsC, { afterSeq: 5 }));
  assert.deepEqual(foldsOf(gated.feed), [[2, 5, 4]]);

  // (c) the first page itself is still loading: no stream until it is in hand.
  const hubD = streamHub();
  const loading = gatedFeed(hubD, "run_fold3", () => foldTranscript("run_fold3").events);
  loading.gate.hold = () => true;
  loading.feed.open("run_fold3");
  await settle();
  loading.feed.setVisible(false);
  loading.feed.setVisible(true);
  await settle();
  assert.equal(hubD.calls.length, 0, "a first load in flight opens no stream");
  loading.held[0].release();
  await settle();
  assert.equal(hubD.calls.length, 1, "the first page is in: now the stream opens");
});

test("S16 safety net: a stream frame whose range does not start after the cursor (range.fromSeq <= lastSeq) is never merged — the stream is let go for the poll, the next try starts from the new cursor, and such frames count as failed tries", async () => {
  const b = foldTranscript("run_overlap");
  let events = b.events;
  const hub = streamHub();
  const { feed, pages } = streamFeed(hub, "run_overlap", () => events);
  feed.open("run_overlap");
  await settle();
  runtimeRow(b);
  runtimeRow(b);
  events = b.events;
  const frame = pageOf("run_overlap", events, { afterSeq: 3 }); // #4–#5
  hub.frame(0, "rows", frame, "k1");
  assert.deepEqual([foldsOf(feed), feed.get().lastSeq], [[[2, 5, 4]], 5]);
  hub.frame(0, "rows", frame, "k2"); // the same page again: it starts at #4, the cursor is already at #5
  assert.deepEqual([foldsOf(feed), feed.get().lastSeq], [[[2, 5, 4]], 5], "not merged: the count stays four");
  assert.equal(hub.calls[0].signal.aborted, true, "the stream was let go");
  assert.equal(activity.buildActivityView(feed.get()).freshness.kind, "polling");
  assert.equal(await feed.poll(), true, "the poll carries on");
  assert.equal(pages.at(-1).afterSeq, 5);
  assert.deepEqual([hub.calls.length, hub.calls[1].afterSeq, hub.calls[1].cursor], [2, 5, "k1"], "and the next try starts from the new cursor, with the last good frame's id");
  // Frames of this kind are failed tries: three in a row and the tab stays with the poll.
  hub.frame(1, "rows", frame, "k3");
  await feed.poll();
  assert.equal(hub.calls.length, 3);
  hub.frame(2, "rows", frame, "k4");
  await feed.poll();
  await feed.poll();
  assert.equal(hub.calls.length, 3, "given up after three");
});

/** The transcript of run_r after it was replaced by a different file. */
function replacedTranscript() {
  const fresh = transcript("run_r");
  fresh.clock(T0 + 1000);
  say(fresh, T0 + 1000, "replacement one");
  say(fresh, T0 + 2000, "replacement two");
  return fresh.events;
}
const summariesOf = (feed) => feed.get().rows.map((row) => row.summary);

test("S17 reset makes the answers asked before it void (a): the reconcile page of the OLD file, read at the twelfth tick, arrives after the snapshot and never lands on the replaced table", async () => {
  const replaced = replacedTranscript;
  const summaries = summariesOf;
  let events = liveTranscript("run_r").events;
  const hub = streamHub();
  const g = gatedFeed(hub, "run_r", () => events);
  g.feed.open("run_r");
  await settle();
  hub.frame(0, "rows", pageOf("run_r", events, { afterSeq: g.feed.get().lastSeq }));
  for (let tick = 1; tick <= 11; tick += 1) await g.feed.poll();
  g.gate.hold = (query) => !Number.isInteger(query.afterSeq);
  const reconcile = g.feed.poll();
  await settle();
  assert.equal(g.held.length, 1, "the reconcile page of the old file is on its way");
  events = replaced();
  hub.frame(0, "reset", { runId: "run_r", reason: "changed" });
  await settle();
  assert.equal(g.held.length, 2, "the reset asked its own snapshot");
  g.held[1].release();
  await settle();
  assert.deepEqual(summaries(g.feed), ["replacement one", "replacement two"], "the fresh page replaced the table");
  g.held[0].release(); // the old file's page arrives late
  await reconcile;
  await settle();
  assert.deepEqual([summaries(g.feed), g.feed.get().lastSeq], [["replacement one", "replacement two"], 3], "the late answer of the old file never lands");
});

test("S17b reset makes the answers asked before it void (b): an older page of the OLD file, asked before the reset, arrives after the snapshot and is not put above the new table", async () => {
  const replaced = replacedTranscript;
  const summaries = summariesOf;
  let events;
  const long = transcript("run_r");
  long.clock(T0 + 1000);
  for (let i = 1; i <= 450; i += 1) say(long, T0 + 1000 + i, `old message ${i}`);
  events = long.events;
  const hub = streamHub();
  const g = gatedFeed(hub, "run_r", () => events);
  g.feed.open("run_r");
  await settle();
  hub.frame(0, "rows", pageOf("run_r", events, { afterSeq: g.feed.get().lastSeq }));
  assert.equal(g.feed.canLoadOlder(), true);
  g.gate.hold = () => true;
  assert.equal(g.feed.loadOlder(), true);
  await settle();
  events = replaced();
  hub.frame(0, "reset", { runId: "run_r", reason: "changed" });
  await settle();
  assert.equal(g.held.length, 2);
  g.held[1].release();
  await settle();
  g.held[0].release(); // the older page of the OLD file
  await settle();
  assert.deepEqual(summaries(g.feed), ["replacement one", "replacement two"], "the old file's older page is not put above the new table");
  assert.equal(g.feed.canLoadOlder(), false, "and 'older' is the new table's own answer");
  assert.equal(g.feed.loadOlder(), false);
});

test("S17c reset makes the answers asked before it void (c): the snapshot is held — no poll, no new stream, the old stream's late frame is dropped; once it is back the stream opens from it and its first rows stay on the table", async () => {
  const replaced = replacedTranscript;
  const summaries = summariesOf;
  let events = liveTranscript("run_r").events;
  const hub = streamHub();
  const g = gatedFeed(hub, "run_r", () => events);
  g.feed.open("run_r");
  await settle();
  hub.frame(0, "rows", pageOf("run_r", events, { afterSeq: g.feed.get().lastSeq }), "k1");
  g.gate.hold = () => true;
  events = replaced();
  hub.frame(0, "reset", { runId: "run_r", reason: "cursor" });
  await settle();
  assert.equal(g.held.length, 1, "the snapshot is on its way");
  const asked = g.pages.length;
  const ticked = g.feed.poll();
  await settle();
  assert.equal(g.pages.length, asked, "no poll: nothing is asked while the snapshot is on its way");
  assert.equal(await ticked, false);
  g.feed.setVisible(false);
  g.feed.setVisible(true);
  await settle();
  assert.equal(hub.calls.length, 1, "no new stream");
  const before = summaries(g.feed);
  const oldLater = [...liveTranscript("run_r").events, { type: "run.event", runId: "run_r", agentId: "glm-pro", seq: 4, ts: iso(T0 + 8000), kind: "message", role: "assistant", parts: [{ type: "text", text: "late row of the old stream" }] }];
  hub.frame(0, "rows", pageOf("run_r", oldLater, { afterSeq: 3 }), "k2"); // the old stream's late frame
  assert.deepEqual(summaries(g.feed), before, "is dropped: it belongs to a stream that was let go");
  g.held[0].release();
  await settle();
  assert.deepEqual(summaries(g.feed), ["replacement one", "replacement two"]);
  assert.deepEqual([hub.calls.length, hub.calls[1].afterSeq, "cursor" in hub.calls[1]], [2, 3, false], "the snapshot is in: the stream opens from it, with no cursor");
  const more = [...events, { type: "run.event", runId: "run_r", agentId: "glm-pro", seq: 4, ts: iso(T0 + 9000), kind: "message", role: "assistant", parts: [{ type: "text", text: "from the new stream" }] }];
  hub.frame(1, "rows", pageOf("run_r", more, { afterSeq: 3 }), "n1");
  assert.deepEqual([summaries(g.feed).at(-1), g.feed.get().lastSeq], ["from the new stream", 4], "the new stream's row is on the table, and nothing older overwrote it");
});

test("S17d reset makes the answers asked before it void (d): the snapshot FAILED — the old cursor is no good either, so the next tick asks for a snapshot again, never for a page after the old file's cursor", async () => {
  const replaced = replacedTranscript;
  const summaries = summariesOf;
  let events = liveTranscript("run_r").events;
  const hub = streamHub();
  const g = gatedFeed(hub, "run_r", () => events);
  g.feed.open("run_r");
  await settle();
  hub.frame(0, "rows", pageOf("run_r", events, { afterSeq: g.feed.get().lastSeq }));
  events = replaced();
  g.gate.fail = true;
  hub.frame(0, "reset", { runId: "run_r", reason: "changed" });
  await settle();
  assert.deepEqual([g.feed.get().problem, hub.calls.length], ["network", 1], "failed: stale, and still no stream");
  assert.equal(await g.feed.poll(), true);
  assert.equal("afterSeq" in g.pages.at(-1), false, "the retry is a snapshot — never a page after the old file's cursor");
  assert.deepEqual([summaries(g.feed), g.feed.get().problem, hub.calls.length], [["replacement one", "replacement two"], null, 2], "recovered, and the stream is back");
});

test("S18 paused, an update frame leaves the picture alone: it changes only the copy that resume will show (made from the shown rows when none is held yet); following, it changes the shown table", async () => {
  const b = transcript("run_upd");
  b.clock(T0 + 500).add("session.created", { backend: "claude-code", backendSessionId: "proc_1", serveUrl: null });
  b.clock(T0 + 1000).add("run.event", { kind: "command", command: "npm test", toolCallId: "call-9" });
  b.clock(T0 + 2000).add("run.event", { kind: "message", role: "assistant", parts: [{ type: "text", text: "working" }] });
  let events = b.events;
  const hub = streamHub();
  const { feed } = streamFeed(hub, "run_upd", () => events);
  feed.open("run_upd");
  await settle();
  const cursor = feed.get().lastSeq;
  hub.frame(0, "rows", pageOf("run_upd", events, { afterSeq: cursor }), "k1");
  const command = () => feed.get().rows.find((row) => row.code === "CMD");
  const held = () => feed.get().pendingRows?.find((row) => row.code === "CMD");
  b.clock(T0 + 3000).add("run.event", { kind: "tool_result", tool: "call-9", output: "1 failing test", isError: true });
  events = b.events;
  const page = projectWorkerActivity({ runId: "run_upd", events, env: {}, afterSeq: cursor });
  assert.equal(page.updates.length, 1);

  // Paused, nothing held yet: the shown row stays as it is.
  assert.equal(feed.pause("selection"), true);
  const shownRows = feed.get().rows;
  hub.frame(0, "update", { runId: "run_upd", updates: page.updates }, "k1");
  assert.equal(feed.get().rows, shownRows, "the visible table is the very same one");
  assert.equal(command().exitCode, null, "the visible command row did not move");
  assert.deepEqual([held().exitCode, feed.get().newCount], [1, 0], "the exit code waits for resume; it is not a new event");
  // Then the page's rows: held back too, counted.
  hub.frame(0, "rows", { ...page, updates: [] }, "k2");
  assert.deepEqual([feed.get().rows === shownRows, feed.get().newCount, command().exitCode], [true, 1, null]);
  assert.equal(feed.follow(), true);
  assert.deepEqual([command().exitCode, command().exitSource, feed.get().rows.filter((row) => row.code === "OUT").length], [1, "inferred", 1], "resume shows the exit code and the new row");

  // Following: the update frame changes the shown table at once.
  const c = transcript("run_upd2");
  c.clock(T0 + 500).add("session.created", { backend: "claude-code", backendSessionId: "proc_1", serveUrl: null });
  c.clock(T0 + 1000).add("run.event", { kind: "command", command: "npm test", toolCallId: "call-1" });
  let eventsC = c.events;
  const hub2 = streamHub();
  const second = streamFeed(hub2, "run_upd2", () => eventsC);
  second.feed.open("run_upd2");
  await settle();
  const cursor2 = second.feed.get().lastSeq;
  hub2.frame(0, "rows", pageOf("run_upd2", eventsC, { afterSeq: cursor2 }));
  c.clock(T0 + 3000).add("run.event", { kind: "tool_result", tool: "call-1", output: "ok", isError: false });
  eventsC = c.events;
  hub2.frame(0, "update", { runId: "run_upd2", updates: projectWorkerActivity({ runId: "run_upd2", events: eventsC, env: {}, afterSeq: cursor2 }).updates });
  assert.equal(second.feed.get().rows.find((row) => row.code === "CMD").exitCode, 0, "following: the shown row changed");
  assert.equal(second.feed.get().pendingRows, null);
});

test("S19 a rows frame with terminal:true only says the run is over — the stream still owes its end frame: when it drops first, the page asks once more after its cursor, takes the rows written after the terminal event, and only then stops", async () => {
  const b = liveTranscript("run_done2");
  let events = b.events;
  const hub = streamHub();
  const g = gatedFeed(hub, "run_done2", () => events);
  g.feed.open("run_done2");
  await settle();
  const lastSeq = g.feed.get().lastSeq;
  hub.frame(0, "rows", pageOf("run_done2", events, { afterSeq: lastSeq }));
  b.clock(T0 + 4000).add("run.completed", {});
  b.add("run.state_change", { from: "running", to: "completed", reason: "completed" });
  events = b.events;
  hub.frame(0, "rows", pageOf("run_done2", events, { afterSeq: lastSeq }), "k9");
  assert.equal(activity.buildActivityView(g.feed.get()).terminal, true);
  const cursor = g.feed.get().lastSeq;
  // The line written right behind the terminal event; the stream drops before it can say `end`.
  b.clock(T0 + 5000).add("run.event", { kind: "message", role: "assistant", parts: [{ type: "text", text: "settled after the terminal event" }] });
  events = b.events;
  g.gate.fail = true; // the first catch-up fails: it is tried again on the next tick
  hub.end(0, { ok: false, reason: "network" });
  await settle();
  const after = () => g.pages.filter((query) => Number.isInteger(query.afterSeq));
  assert.equal(after().at(-1)?.afterSeq, cursor, "the page asked after its cursor, at once");
  assert.equal(g.feed.get().rows.some((row) => row.summary === "settled after the terminal event"), false, "that read failed");
  assert.equal(await g.feed.poll(), true, "the next tick asks again");
  assert.equal(g.feed.get().rows.at(-1).summary, "settled after the terminal event", "the row behind the terminal event is on the table");
  assert.equal(g.feed.get().terminal, true);
  const asked = g.pages.length;
  assert.equal(await g.feed.poll(), false, "and then it stops");
  assert.equal(g.pages.length, asked);
  g.feed.setVisible(false);
  g.feed.setVisible(true);
  await settle();
  assert.equal(hub.calls.length, 1, "no reconnect either");

  // The normal ending is unchanged: the end frame closes it, no catch-up is asked.
  const done = liveTranscript("run_done3");
  const hub2 = streamHub();
  const second = gatedFeed(hub2, "run_done3", () => done.events);
  second.feed.open("run_done3");
  await settle();
  const seq = second.feed.get().lastSeq;
  done.clock(T0 + 4000).add("run.completed", {});
  done.add("run.state_change", { from: "running", to: "completed", reason: "completed" });
  hub2.frame(0, "rows", pageOf("run_done3", done.events, { afterSeq: seq }), "k5");
  hub2.frame(0, "end", { runId: "run_done3", state: "completed", terminal: true, total: done.events.length }, "k5");
  const calls = second.pages.length;
  assert.equal(await second.feed.poll(), false);
  assert.equal(second.pages.length, calls, "end: nothing more is asked");
});

test("S20 a failed reconcile read while the stream is Live and frames keep arriving only voids that one check — the status bar stays Live; with no stream the same failure still says Stale since", async () => {
  const b = liveTranscript("run_rec2");
  const events = b.events;
  const hub = streamHub();
  const g = gatedFeed(hub, "run_rec2", () => events);
  g.feed.open("run_rec2");
  await settle();
  hub.frame(0, "rows", pageOf("run_rec2", events, { afterSeq: g.feed.get().lastSeq }));
  for (let tick = 1; tick <= 11; tick += 1) await g.feed.poll();
  g.gate.fail = true;
  assert.equal(await g.feed.poll(), false, "the twelfth tick: the check failed");
  const vm = activity.buildActivityView(g.feed.get());
  assert.deepEqual([vm.freshness.kind, vm.problem], ["live", null], "still Live: only this check is void");
  await g.feed.poll(); // the next tick is quiet again, and the stream is as it was
  assert.equal(activity.buildActivityView(g.feed.get()).freshness.kind, "live");

  // No stream: the failure is the old one.
  const hub2 = streamHub({ failWith: "network" });
  const polling = gatedFeed(hub2, "run_rec2", () => events);
  polling.feed.open("run_rec2");
  await settle();
  for (let tick = 1; tick <= 11; tick += 1) await polling.feed.poll();
  polling.gate.fail = true;
  await polling.feed.poll();
  assert.equal(activity.buildActivityView(polling.feed.get()).freshness.kind, "stale", "no stream: Stale since, as before");
});

// ===== batch 144, fix 2: the last crossings =====

test("S21 the read after a stream that died before its end frame is always a page after the cursor — even on the twelfth tick, the reconcile never takes its place and the row written behind the terminal event arrives", async () => {
  const b = liveTranscript("run_final");
  let events = b.events;
  const hub = streamHub();
  const g = gatedFeed(hub, "run_final", () => events);
  g.feed.open("run_final");
  await settle();
  const lastSeq = g.feed.get().lastSeq;
  hub.frame(0, "rows", pageOf("run_final", events, { afterSeq: lastSeq }));
  for (let tick = 1; tick <= 11; tick += 1) await g.feed.poll(); // Live: eleven quiet ticks
  b.clock(T0 + 4000).add("run.completed", {});
  b.add("run.state_change", { from: "running", to: "completed", reason: "completed" });
  events = b.events;
  hub.frame(0, "rows", pageOf("run_final", events, { afterSeq: lastSeq }), "k9");
  const cursor = g.feed.get().lastSeq;
  b.clock(T0 + 5000).add("run.event", { kind: "message", role: "assistant", parts: [{ type: "text", text: "written behind the terminal event" }] });
  events = b.events;
  hub.end(0, { ok: false, reason: "network" }); // the stream drops before `end`: the catch-up is the twelfth tick
  await settle();
  assert.equal("afterSeq" in g.pages.at(-1), true, "the catch-up is a page after the cursor, not the reconcile's newest page");
  assert.equal(g.pages.at(-1).afterSeq, cursor);
  assert.equal(g.feed.get().rows.at(-1).summary, "written behind the terminal event");
  assert.equal(await g.feed.poll(), false, "and then it stops");
});

test("S22 a reconcile page asked before the end was learned never undoes it: terminal, the total and the closed stream stay as the end frame left them, and a row's exit code from an update frame is not taken back", async () => {
  // (a) the end
  const b = liveTranscript("run_late");
  let events = b.events;
  const hub = streamHub();
  const g = gatedFeed(hub, "run_late", () => events);
  g.feed.open("run_late");
  await settle();
  const lastSeq = g.feed.get().lastSeq;
  hub.frame(0, "rows", pageOf("run_late", events, { afterSeq: lastSeq }));
  for (let tick = 1; tick <= 11; tick += 1) await g.feed.poll();
  g.gate.hold = (query) => !Number.isInteger(query.afterSeq);
  const tick12 = g.feed.poll(); // the newest page of the RUNNING run, on its way
  await settle();
  assert.equal(g.held.length, 1);
  b.clock(T0 + 4000).add("run.completed", {});
  b.add("run.state_change", { from: "running", to: "completed", reason: "completed" });
  events = b.events;
  hub.frame(0, "rows", pageOf("run_late", events, { afterSeq: lastSeq }), "k9");
  hub.frame(0, "end", { runId: "run_late", state: "completed", terminal: true, total: events.length }, "k9");
  let vm = activity.buildActivityView(g.feed.get());
  assert.deepEqual([vm.terminal, vm.total, vm.freshness.kind], [true, 5, "ended"]);
  const shown = g.feed.get().rows;
  g.held[0].release(); // the older answer arrives
  await tick12;
  await settle();
  vm = activity.buildActivityView(g.feed.get());
  assert.deepEqual([vm.terminal, vm.total, vm.freshness.kind], [true, 5, "ended"], "the end stands");
  assert.equal(g.feed.get().rows, shown, "and so does the table");
  assert.equal(hub.calls.length, 1, "no stream is opened again");

  // (b) a command's exit code that an update frame brought
  const c = transcript("run_cmd2");
  c.clock(T0 + 500).add("session.created", { backend: "claude-code", backendSessionId: "proc_1", serveUrl: null });
  c.clock(T0 + 1000).add("run.event", { kind: "command", command: "npm test", toolCallId: "call-7" });
  let eventsC = c.events;
  const hub2 = streamHub();
  const g2 = gatedFeed(hub2, "run_cmd2", () => eventsC);
  g2.feed.open("run_cmd2");
  await settle();
  const cursor = g2.feed.get().lastSeq;
  hub2.frame(0, "rows", pageOf("run_cmd2", eventsC, { afterSeq: cursor }));
  for (let tick = 1; tick <= 11; tick += 1) await g2.feed.poll();
  g2.gate.hold = (query) => !Number.isInteger(query.afterSeq);
  const tick12b = g2.feed.poll(); // the newest page before the result existed
  await settle();
  c.clock(T0 + 3000).add("run.event", { kind: "tool_result", tool: "call-7", output: "1 failing test", isError: true });
  eventsC = c.events;
  const page = projectWorkerActivity({ runId: "run_cmd2", events: eventsC, env: {}, afterSeq: cursor });
  hub2.frame(0, "update", { runId: "run_cmd2", updates: page.updates }, "k1");
  hub2.frame(0, "rows", { ...page, updates: [] }, "k2");
  const exit = () => g2.feed.get().rows.find((row) => row.code === "CMD").exitCode;
  assert.equal(exit(), 1);
  g2.held[0].release();
  await tick12b;
  await settle();
  assert.equal(exit(), 1, "the older page does not take the exit code back");
});

test("S23 a reset while paused: the table in front of the Owner is the old transcript's and stays read-only — no older page (with the new table's boundary, nor with the old one's while the snapshot is on its way) is mixed into it; at resume the new table brings its own boundary", async () => {
  const many = (label) => {
    const b = transcript("run_r2");
    b.clock(T0 + 1000);
    for (let i = 1; i <= 450; i += 1) say(b, T0 + 1000 + i, `${label} message ${i}`);
    return b.events;
  };
  const summaries = (feed) => feed.get().rows.map((row) => row.summary);
  const olderAsked = (g) => g.pages.filter((query) => "beforeSeq" in query).length;
  let events = many("old");
  let hub = streamHub();
  let g = gatedFeed(hub, "run_r2", () => events);
  g.feed.open("run_r2");
  await settle();
  hub.frame(0, "rows", pageOf("run_r2", events, { afterSeq: g.feed.get().lastSeq }));
  assert.equal(g.feed.canLoadOlder(), true);
  g.feed.pause("scroll");
  events = many("new");
  g.gate.hold = () => true;
  hub.frame(0, "reset", { runId: "run_r2", reason: "changed" });
  await settle();
  // the snapshot is on its way: the old table's boundary must not be used
  assert.deepEqual([g.feed.canLoadOlder(), g.feed.loadOlder(), olderAsked(g)], [false, false, 0], "snapshot in flight: no older page");
  g.held[0].release();
  await settle();
  assert.ok(summaries(g.feed).every((text) => text.startsWith("old ")), "paused: what is shown is still the old transcript");
  assert.ok(g.feed.get().pendingRows.every((unit) => unit.summary.startsWith("new ")), "the new table waits aside");
  assert.deepEqual([g.feed.canLoadOlder(), g.feed.loadOlder(), olderAsked(g)], [false, false, 0], "the snapshot is back, the old table is still shown: still no older page");
  assert.equal(activity.buildActivityView(g.feed.get()).older, null, "and the view offers none");
  g.gate.hold = () => false;
  assert.equal(g.feed.follow(), true);
  assert.ok(summaries(g.feed).every((text) => text.startsWith("new ")), "resume: the new table");
  assert.equal(g.feed.canLoadOlder(), true, "now its own boundary is open");
  assert.equal(g.feed.loadOlder(), true);
  await settle();
  assert.ok(summaries(g.feed).length > 200 && summaries(g.feed).every((text) => text.startsWith("new ")), "the older page is the new transcript's: nothing of the old one is mixed in");

  // following: a reset's snapshot in flight blocks the old boundary too
  events = many("old");
  hub = streamHub();
  g = gatedFeed(hub, "run_r2", () => events);
  g.feed.open("run_r2");
  await settle();
  hub.frame(0, "rows", pageOf("run_r2", events, { afterSeq: g.feed.get().lastSeq }));
  events = many("new");
  g.gate.hold = () => true;
  hub.frame(0, "reset", { runId: "run_r2", reason: "changed" });
  await settle();
  assert.deepEqual([g.feed.canLoadOlder(), g.feed.loadOlder(), olderAsked(g)], [false, false, 0], "following, snapshot in flight: no older page either");
  g.held[0].release();
  await settle();
  g.gate.hold = () => false;
  assert.deepEqual([g.feed.canLoadOlder(), summaries(g.feed).every((text) => text.startsWith("new "))], [true, true]);
});

test("S24 a reset voids the full texts: one asked for a row of the old transcript lands on nothing, a full text shown is not carried to the new table's row, and while the old table is shown nothing is asked about its rows", async () => {
  const withOutput = (label) => {
    const b = transcript("run_f2");
    b.clock(T0 + 1000).add("run.event", {
      kind: "tool_result", tool: "big", output: Array.from({ length: 600 }, (_, i) => `${label} line ${i + 1} ${"x".repeat(60)}`).join("\n"),
    });
    return b.events;
  };
  let events = withOutput("OLD");
  const hub = streamHub();
  const g = gatedFeed(hub, "run_f2", () => events);
  g.feed.open("run_f2");
  await settle();
  hub.frame(0, "rows", pageOf("run_f2", events, { afterSeq: g.feed.get().lastSeq }));
  const key = g.feed.get().rows.find((row) => row.code === "OUT").key;
  g.gate.holdFull = true;
  assert.equal(g.feed.openFull(key), true, "asked for the old transcript's row");
  await settle();
  assert.equal(g.heldFull.length, 1);
  events = withOutput("NEW");
  hub.frame(0, "reset", { runId: "run_f2", reason: "changed" });
  await settle();
  // the old table is still shown (paused by the open full text): nothing may be asked about its rows
  assert.equal(g.feed.get().stale, true);
  assert.deepEqual([g.feed.openFull(key), g.feed.fullPage(key, 1), g.heldFull.length], [false, false, 1]);
  assert.equal(g.feed.get().full.size, 0, "the full text asked so far is gone with the old table");
  assert.equal(g.feed.follow(), true);
  assert.equal(g.feed.get().full.size, 0, "the new table starts with no full text open");
  // The new table's row opens: its request is on the wire (same key, same seq) when the OLD transcript's text
  // finally arrives. The old text must not take the new request's place.
  assert.equal(g.feed.openFull(key), true);
  await settle();
  assert.equal(g.heldFull.length, 2);
  g.heldFull[0].release(); // the old transcript's text
  await settle();
  assert.equal(g.feed.get().full.get(key).state, "loading", "still waiting for its own answer: the old text landed on nothing");
  g.heldFull[1].release();
  await settle();
  const shown = activity.buildActivityView(g.feed.get()).rows.find((row) => row.key === key).full;
  assert.ok(shown.state === "ready" && shown.text.includes("NEW line 1") && !shown.text.includes("OLD"), "the text is the new transcript's");
});

test("S25 the poll's occupation belongs to the poll that took it: an older poll that ends after the worker was closed and opened again frees nothing of the newer one, and opens no stream beside it", async () => {
  const b = foldTranscript("run_own");
  const long = [...b.events];
  runtimeRow(b);
  runtimeRow(b);
  const grown = [...b.events]; // #1 ... #5
  let events = grown;
  const hub = streamHub();
  const g = gatedFeed(hub, "run_own", () => events);
  g.feed.setVisible(false);
  events = long; // #1 ... #3
  g.feed.open("run_own");
  await settle();
  events = grown;
  g.gate.hold = (query) => Number.isInteger(query.afterSeq);
  const oldPoll = g.feed.poll();
  await settle();
  assert.equal(g.held.length, 1, "the old poll is on its way");
  // The Owner closes the worker and opens it again; its first page is the short one.
  g.feed.close();
  events = long;
  g.feed.open("run_own");
  await settle();
  events = grown;
  const newPoll = g.feed.poll();
  await settle();
  assert.equal(g.held.length, 2, "the new poll is on its way");
  g.held[0].release(); // the OLD poll ends first
  await oldPoll;
  await settle();
  g.feed.setVisible(true);
  await settle();
  assert.equal(hub.calls.length, 0, "the new poll still holds the occupation: no stream beside it");
  g.held[1].release();
  await newPoll;
  await settle();
  assert.deepEqual([foldsOf(g.feed), hub.calls.length, hub.calls[0]?.afterSeq], [[[2, 5, 4]], 1, 5], "four runtime events, once; the stream opens after the poll, from its cursor");
  hub.frame(0, "rows", pageOf("run_own", events, { afterSeq: 5 }));
  assert.deepEqual(foldsOf(g.feed), [[2, 5, 4]]);
});

// ===== batch 144, fix 3: owed reconcile, one-segment landing, short tables, serial resets, owner-only stream try, the end on a reconcile tick =====

/** One more message row delivered by the stream: the transcript grows and the frame is the page after the cursor. */
function pushFrame(b, g, hub, n, at = 0) {
  b.clock(T0 + 20_000 + n * 1000).add("run.event", { kind: "message", role: "assistant", parts: [{ type: "text", text: `streamed ${n}` }] });
  hub.frame(at, "rows", pageOf(b.runId, b.events, { afterSeq: g.feed.get().lastSeq }), `p${n}`);
}

test("S26 a reconcile page that was dropped as older than the table is owed: the next tick asks again — every tick until one lands — and then the twelve-tick rhythm starts over", async () => {
  const b = liveTranscript("run_owed");
  const hub = streamHub();
  const g = gatedFeed(hub, "run_owed", () => b.events);
  g.feed.open("run_owed");
  await settle();
  hub.frame(0, "rows", pageOf("run_owed", b.events, { afterSeq: g.feed.get().lastSeq }));
  const snapshots = () => g.pages.filter((query) => !Number.isInteger(query.afterSeq)).length;
  for (let tick = 1; tick <= 11; tick += 1) await g.feed.poll(); // eleven quiet ticks
  const base = snapshots();
  g.gate.hold = (query) => !Number.isInteger(query.afterSeq);
  // Three reconcile pages in a row, each overtaken by a frame while it is on its way.
  for (let drop = 0; drop < 3; drop += 1) {
    const tick = g.feed.poll();
    await settle();
    assert.equal(g.held.length, drop + 1, `tick ${drop + 12}: the reconcile is asked again at once, not twelve ticks later`);
    pushFrame(b, g, hub, drop + 1);
    g.held[drop].release();
    await tick;
    await settle();
  }
  assert.equal(snapshots() - base, 3);
  // The fourth time nothing comes in between: it lands.
  const fourth = g.feed.poll();
  await settle();
  assert.equal(g.held.length, 4);
  g.held[3].release();
  await fourth;
  await settle();
  // Back to the rhythm: eleven quiet ticks read nothing, the twelfth asks.
  g.gate.hold = () => false;
  const before = snapshots();
  for (let tick = 1; tick <= 11; tick += 1) await g.feed.poll();
  assert.equal(snapshots(), before, "no snapshot while the rhythm runs");
  await g.feed.poll();
  assert.equal(snapshots(), before + 1, "the twelfth tick since the last one that landed");
});

test("S27 a reconcile page is checked against the table in the very segment that applies it: a frame that lands in the microtask between the first check and the apply wins — terminal, total and the closed stream stay", async () => {
  const b = liveTranscript("run_micro");
  const hub = streamHub();
  const g = gatedFeed(hub, "run_micro", () => b.events);
  g.feed.open("run_micro");
  await settle();
  const lastSeq = g.feed.get().lastSeq;
  hub.frame(0, "rows", pageOf("run_micro", b.events, { afterSeq: lastSeq }));
  for (let tick = 1; tick <= 11; tick += 1) await g.feed.poll();
  g.gate.hold = (query) => !Number.isInteger(query.afterSeq);
  const tick12 = g.feed.poll(); // the newest page of the RUNNING run
  await settle();
  assert.equal(g.held.length, 1);
  b.clock(T0 + 4000).add("run.completed", {});
  b.add("run.state_change", { from: "running", to: "completed", reason: "completed" });
  const rows = pageOf("run_micro", b.events, { afterSeq: lastSeq });
  const total = b.events.length;
  g.held[0].release();
  // One microtask later: after the page's first version check, before it is applied.
  queueMicrotask(() => {
    hub.frame(0, "rows", rows, "k9");
    hub.frame(0, "end", { runId: "run_micro", state: "completed", terminal: true, total }, "k9");
  });
  await tick12;
  await settle();
  const vm = activity.buildActivityView(g.feed.get());
  assert.deepEqual([vm.terminal, vm.total, vm.freshness.kind, hub.calls.length], [true, total, "ended", 1], "the end stands and no stream is opened again");
});

test("S28 paused, a reset replaced the transcript with a table of the same length (a page that does not scroll): the status bar offers a click that puts the new table in front of the Owner", async () => {
  const two = (label) => {
    const b = transcript("run_short");
    b.clock(T0 + 1000);
    say(b, T0 + 1000, `${label} one`);
    say(b, T0 + 2000, `${label} two`);
    return b.events;
  };
  let events = two("old");
  const hub = streamHub();
  const g = gatedFeed(hub, "run_short", () => events);
  g.feed.open("run_short");
  await settle();
  hub.frame(0, "rows", pageOf("run_short", events, { afterSeq: g.feed.get().lastSeq }));
  assert.equal(g.feed.pause("selection"), true);
  events = two("new");
  hub.frame(0, "reset", { runId: "run_short", reason: "changed" });
  await settle();
  let vm = activity.buildActivityView(g.feed.get());
  assert.deepEqual([vm.newCount, vm.replaced, vm.rows.map((row) => row.summary)], [0, true, ["old one", "old two"]], "same number of rows: nothing counts as new, the old table is still shown");
  const en = renderActivity(vm, "en");
  const button = byClass(en.root, "act-new-btn")[0];
  assert.equal(button.textContent, "Transcript updated — click to view");
  assert.equal(button.getAttribute("data-fk"), "act-resume");
  assert.equal(byClass(renderActivity(vm, "zh").root, "act-new-btn")[0].textContent, "转录已更新，点击查看");
  button.click();
  assert.deepEqual(en.actions.calls.pop(), ["resumeActivity"], "the click is the resume");
  assert.equal(g.feed.follow(), true);
  vm = activity.buildActivityView(g.feed.get());
  assert.deepEqual([vm.replaced, vm.rows.map((row) => row.summary)], [false, ["new one", "new two"]], "the new table is in front");
  assert.equal(byClass(renderActivity(vm, "en").root, "act-new-btn").length, 0, "and the entry is gone");
  // Not a reset: a paused table with nothing new offers nothing.
  const quiet = streamHub();
  const second = gatedFeed(quiet, "run_short", () => two("old"));
  second.feed.open("run_short");
  await settle();
  second.feed.pause("selection");
  assert.equal(activity.buildActivityView(second.feed.get()).replaced, false);
});

test("S29 every reset voids the one before it: the replacement the first reset brought (its table aside and its paging boundary) never reaches the Owner after the second reset; paging uses only the boundary of the snapshot of the current generation", async () => {
  const many = (label) => {
    const b = transcript("run_abc");
    b.clock(T0 + 1000);
    for (let i = 1; i <= 450; i += 1) say(b, T0 + 1000 + i, `${label} message ${i}`);
    return b.events;
  };
  const summaries = (feed) => feed.get().rows.map((row) => row.summary);
  const only = (feed, label) => summaries(feed).length > 0 && summaries(feed).every((text) => text.startsWith(`${label} `));
  let events = many("alpha");
  const hub = streamHub();
  const g = gatedFeed(hub, "run_abc", () => events);
  g.feed.open("run_abc");
  await settle();
  hub.frame(0, "rows", pageOf("run_abc", events, { afterSeq: g.feed.get().lastSeq }));
  g.feed.pause("scroll");
  events = many("beta");
  hub.frame(0, "reset", { runId: "run_abc", reason: "changed" });
  await settle();
  assert.equal(hub.calls.length, 2, "the first reset's snapshot is back and the stream is open again");
  assert.ok(g.feed.get().replacement !== null && g.feed.get().pendingRows.every((unit) => unit.summary.startsWith("beta ")), "B waits aside");
  // The second reset: C replaces B before the Owner looked at it; C's snapshot is held.
  events = many("gamma");
  g.gate.hold = () => true;
  hub.frame(1, "reset", { runId: "run_abc", reason: "changed" });
  await settle();
  assert.equal(g.held.length, 1);
  assert.equal(g.feed.follow(), true);
  assert.ok(only(g.feed, "alpha"), "resume shows nothing of B — what is on screen is still the old table, read-only");
  assert.deepEqual([g.feed.canLoadOlder(), g.feed.loadOlder(), g.pages.filter((query) => "beforeSeq" in query).length], [false, false, 0], "no older page with B's boundary");
  g.held[0].release();
  await settle();
  g.gate.hold = () => false;
  assert.ok(only(g.feed, "gamma"), "C's snapshot is the table");
  assert.equal(g.feed.canLoadOlder(), true);
  assert.equal(g.feed.loadOlder(), true);
  await settle();
  assert.ok(summaries(g.feed).length > 200 && only(g.feed, "gamma"), "the older page is C's: B and A are nowhere in the table");
});

test("S30 a poll of an older table generation never opens a stream: when it ends after a reset it frees nothing and tries nothing — the new generation's own tick does", async () => {
  const b = liveTranscript("run_gen");
  let events = b.events;
  const hub = streamHub();
  const g = gatedFeed(hub, "run_gen", () => events);
  g.feed.open("run_gen");
  await settle();
  hub.frame(0, "rows", pageOf("run_gen", events, { afterSeq: g.feed.get().lastSeq }));
  for (let tick = 1; tick <= 11; tick += 1) await g.feed.poll();
  g.gate.hold = (query) => !Number.isInteger(query.afterSeq);
  const tick12 = g.feed.poll(); // the reconcile page of the old generation
  await settle();
  assert.equal(g.held.length, 1);
  g.gate.hold = () => false;
  const fresh = transcript("run_gen");
  fresh.clock(T0 + 1000);
  say(fresh, T0 + 1000, "replacement one");
  events = fresh.events;
  hub.frame(0, "reset", { runId: "run_gen", reason: "changed" });
  await settle();
  assert.equal(hub.calls.length, 2, "the snapshot is back: the second stream is open");
  hub.end(1, { ok: false, reason: "network" }); // it drops; its next try belongs to the next tick
  await settle();
  assert.equal(hub.calls.length, 2);
  g.held[0].release(); // the old generation's poll ends now
  await tick12;
  await settle();
  assert.equal(hub.calls.length, 2, "it opened no stream");
  await g.feed.poll(); // the current generation's own tick
  await settle();
  assert.equal(hub.calls.length, 3, "the stream is tried after that one");
});

test("S31 polling: the end shows up on the reconcile tick while the cursor is behind — the rows after the cursor (the command's result, its exit code) are read first, and only then is the run shown as ended; with a stream up it carries them and nothing is asked", async () => {
  const b = transcript("run_poll_end");
  b.clock(T0 + 500).add("session.created", { backend: "claude-code", backendSessionId: "proc_1", serveUrl: null });
  b.clock(T0 + 1000).add("run.event", { kind: "command", command: "npm test", toolCallId: "call-1" });
  const { feed, pages } = await openedFeed("run_poll_end", b.events);
  const command = () => feed.get().rows.find((row) => row.code === "CMD");
  assert.equal(command().exitCode, null);
  for (let i = 1; i <= 220; i += 1) say(b, T0 + 2000 + i, `message ${i}`);
  await feed.poll(); // tick 1: two pages catch the 220 up
  for (let tick = 2; tick <= 11; tick += 1) await feed.poll();
  const cursor = feed.get().lastSeq;
  b.clock(T0 + 9000).add("run.event", { kind: "tool_result", tool: "call-1", output: "1 failing test", isError: true });
  b.clock(T0 + 10_000).add("run.completed", {});
  b.add("run.state_change", { from: "running", to: "completed", reason: "completed" });
  const total = b.events.length;
  await feed.poll(); // tick 12: the reconcile reads the newest page and sees the end
  assert.equal(pages.filter((query) => query.afterSeq === cursor && !("beforeSeq" in query)).length >= 1, true, "the rows after the cursor were asked for");
  const vm = activity.buildActivityView(feed.get());
  assert.deepEqual([vm.terminal, vm.total, feed.get().lastSeq, command().exitCode], [true, total, b.events.at(-1).seq, 1], "ended only after the cursor reached the end; the command has its exit code");
  assert.equal(await feed.poll(), false, "and then it stops");

  // With the stream up: the reconcile page that says "ended" only swaps rows in; the stream brings the rest and the end.
  const c = liveTranscript("run_live_end");
  const hub = streamHub();
  const g = gatedFeed(hub, "run_live_end", () => c.events);
  g.feed.open("run_live_end");
  await settle();
  const lastSeq = g.feed.get().lastSeq;
  hub.frame(0, "rows", pageOf("run_live_end", c.events, { afterSeq: lastSeq }));
  for (let tick = 1; tick <= 11; tick += 1) await g.feed.poll();
  c.clock(T0 + 4000).add("run.completed", {});
  c.add("run.state_change", { from: "running", to: "completed", reason: "completed" });
  const asked = g.pages.length;
  await g.feed.poll(); // tick 12: the page already says ended; the cursor is behind it
  assert.equal(g.pages.length, asked + 1, "only the newest page was read — the stream carries the rest");
  assert.equal(activity.buildActivityView(g.feed.get()).terminal, false, "not ended yet: the rows and the end come by the stream");
  hub.frame(0, "rows", pageOf("run_live_end", c.events, { afterSeq: lastSeq }), "k9");
  hub.frame(0, "end", { runId: "run_live_end", state: "completed", terminal: true, total: c.events.length }, "k9");
  const done = activity.buildActivityView(g.feed.get());
  assert.deepEqual([done.terminal, done.total, g.feed.get().lastSeq], [true, c.events.length, c.events.at(-1).seq]);
});
// ===== api.js: the stream route in the closed set, and the one reader of server-sent events =====

const TOKEN_S = "c".repeat(64);

/** A server-sent-event response whose body yields the given chunks, one read at a time. */
function sseResponse(chunks, { type = "text/event-stream", status = 200 } = {}) {
  const encoder = new TextEncoder();
  const queue = [...chunks];
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? type : null) },
    body: { getReader: () => ({ read: async () => (queue.length > 0 ? { value: encoder.encode(queue.shift()), done: false } : { value: undefined, done: true }), releaseLock() {} }) },
  };
}

test("S14 api.js: the stream route is in the closed set with its own query shapes, the JSON request refuses it, and readStream reports what happened and hands the frames over in order", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const cursor = "1.0123456789abcdef.fedcba9876543210.1799.3t.0f1e2d3c4b5a6978";
  assert.equal(api.streamPath({ runId: "run_1" }), "/api/worker/stream?runId=run_1");
  assert.equal(api.streamPath({ runId: "run_1", afterSeq: 42, cursor, filter: "commands" }), `/api/worker/stream?runId=run_1&afterSeq=42&cursor=${cursor}&filter=commands`);
  assert.equal(api.streamPath({ runId: "run_1", afterSeq: 0 }), "/api/worker/stream?runId=run_1&afterSeq=0");
  for (const path of [
    "/api/worker/stream?runId=run_1", `/api/worker/stream?runId=run_1&afterSeq=999999999&cursor=${cursor}&filter=errors`,
    `/api/worker/stream?runId=run-1_B&cursor=${cursor}`,
  ]) assert.equal(api.isDataPath(path), true, path);
  for (const path of [
    "/api/worker/stream", "/api/worker/stream?runId=", "/api/worker/stream?runId=run_1&x=1", "/api/worker/stream?runId=run_1&runId=run_2",
    "/api/worker/stream?runId=run_1&beforeSeq=3", "/api/worker/stream?runId=run_1&limit=5", "/api/worker/stream?runId=run_1&afterSeq=-1",
    "/api/worker/stream?runId=run_1&afterSeq=01", `/api/worker/stream?runId=run_1&cursor=${encodeURIComponent("a b")}`,
    `/api/worker/stream?runId=run_1&cursor=${"a".repeat(200)}`, `/api/worker/stream?runId=run_1&cursor=${cursor}&cursor=${cursor}`,
    "/api/worker/stream?runId=run_1&filter=nope", "/api/worker/stream?runId=run_1&filter=ALL", "/api/worker/streams?runId=run_1", "/api/worker/Stream?runId=run_1",
  ]) assert.equal(api.isDataPath(path), false, path);
  for (const bad of [{ runId: "run_1", cursor: "a b" }, { runId: "run_1", filter: "nope" }, { runId: "run_1", afterSeq: -1 }, { runId: "run_1", afterSeq: 1_000_000_000 }, {}]) {
    assert.throws(() => api.streamPath(bad), /not one of the dashboard routes/, JSON.stringify(bad));
  }
  assert.ok([...api.API_PATHS].includes("/api/worker/stream"), "the route is one of the page's closed set");
  await assert.rejects(() => api.request("/api/worker/stream?runId=run_1", TOKEN_S), /not one of the dashboard routes/, "the JSON request refuses the stream route");
  await assert.rejects(() => api.requestImage("/api/worker/stream?runId=run_1", TOKEN_S), /not one of the dashboard routes/);
  await assert.rejects(() => api.readStream("/api/overview", TOKEN_S, { onFrame() {} }), /not one of the dashboard routes/);

  // What readStream reports: the server's text never shows up in a reason.
  const seen = [];
  const frames = [];
  const read = async (response) => {
    globalThis.fetch = async (url, init) => { seen.push({ url, init }); return typeof response === "function" ? response(init) : response; };
    return api.readStream(api.streamPath({ runId: "run_1", cursor }), TOKEN_S, { onFrame: (frame) => frames.push(frame) });
  };
  assert.deepEqual(await read({ status: 401, ok: false, headers: { get: () => "application/json" } }), { ok: false, reason: "unauthorized" });
  assert.deepEqual(await read({ status: 404, ok: false, headers: { get: () => "application/json" } }), { ok: false, reason: "notFound" });
  assert.deepEqual(await read({ status: 503, ok: false, headers: { get: () => "application/json" } }), { ok: false, reason: "server" });
  assert.deepEqual(await read({ status: 500, ok: false }), { ok: false, reason: "server" });
  assert.deepEqual(await read(sseResponse(["data: {}\n\n"], { type: "application/json" })), { ok: false, reason: "server" }, "not an event stream");
  assert.deepEqual(await read({ status: 200, ok: true, headers: { get: () => "text/event-stream" } }), { ok: false, reason: "server" }, "no body to read");
  assert.deepEqual(await read(async () => { throw new TypeError("Failed to fetch: http://x/?token=leak"); }), { ok: false, reason: "network" });
  // A body that dies in the middle of the read is a network failure too, never a throw; the half frame is not handed over.
  frames.length = 0;
  let reads = 0;
  globalThis.fetch = async () => ({
    status: 200, ok: true, headers: { get: () => "text/event-stream" },
    body: { getReader: () => ({ read: async () => { reads += 1; if (reads === 1) return { value: new TextEncoder().encode("event: rows\ndata: {"), done: false }; throw new TypeError("terminated"); }, releaseLock() {} }) },
  });
  assert.deepEqual(await api.readStream(api.streamPath({ runId: "run_1" }), TOKEN_S, { onFrame: (frame) => frames.push(frame) }), { ok: false, reason: "network" });
  assert.deepEqual(frames, []);
  assert.ok(!seen.some(({ init }) => JSON.stringify(init).includes("leak")), "the error text of a request never reaches a reason");
  assert.ok(seen.every(({ init }) => init.headers.authorization === `Bearer ${TOKEN_S}` && init.headers.accept === "text/event-stream" && init.cache === "no-store"), "every try carries the bearer and is never cached");
  assert.ok(seen.every(({ init }) => init.signal instanceof AbortSignal), "and can be cancelled");

  // The frames, in order, across arbitrary chunking; the heartbeat comment is not a frame.
  const text = `${encodeStreamFrame("rows", { runId: "run_1", rows: [] }, cursor)}: hb\n\n${encodeStreamFrame("update", { runId: "run_1", updates: [{ seq: 4 }] }, cursor)}${encodeStreamFrame("end", { runId: "run_1", terminal: true }, cursor)}`;
  frames.length = 0;
  seen.length = 0;
  const result = await read(sseResponse([...text].map((char) => char)));
  assert.deepEqual(result, { ok: true, done: true }, "the server closed the stream");
  assert.deepEqual(frames.map((frame) => frame.event), ["rows", "update", "end"], "one character per chunk still gives the frames in order");
  assert.deepEqual(frames[1], { id: cursor, event: "update", data: { runId: "run_1", updates: [{ seq: 4 }] } }, "the cursor of the frame, and its parsed data");
  assert.deepEqual(frames.map((frame) => frame.id), [cursor, cursor, cursor], "each frame names the transport cursor it leaves the stream at");
  // Data that is not JSON is handed over as null; the caller drops it.
  frames.length = 0;
  await read(sseResponse(["event: rows\ndata: <html>\n\n"]));
  assert.deepEqual(frames, [{ id: null, event: "rows", data: null }]);

  // The caller's cancel ends a pending read.
  frames.length = 0;
  const controller = new AbortController();
  globalThis.fetch = async (url, init) => ({
    status: 200, ok: true, headers: { get: () => "text/event-stream" },
    body: { getReader: () => ({ read: () => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })), releaseLock() {} }) },
  });
  const cancelled = api.readStream(api.streamPath({ runId: "run_1" }), TOKEN_S, { signal: controller.signal, onFrame: (frame) => frames.push(frame) });
  await settle();
  controller.abort();
  assert.deepEqual(await cancelled, { ok: false, reason: "aborted" });

  // A silent stream is a failed try: the head must come within the request timeout, each gap within the idle
  // timeout. (A real fetch and a real body reject when their signal fires; the fakes below do the same.)
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    globalThis.fetch = (url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    const slowSignal = new AbortController();
    const slowHead = api.readStream(api.streamPath({ runId: "run_1" }), TOKEN_S, { signal: slowSignal.signal, onFrame() {} });
    t.mock.timers.tick(api.REQUEST_TIMEOUT_MS - 1);
    await settle();
    let settled = false;
    slowHead.then(() => { settled = true; });
    await settle();
    assert.equal(settled, false, "still waiting one ms before the request timeout");
    t.mock.timers.tick(1);
    assert.deepEqual(await slowHead, { ok: false, reason: "timeout" }, "no response head within the request timeout");
    // Every way out lets go of the caller's signal: nothing stays registered on it.
    assert.equal(getEventListeners(slowSignal.signal, "abort").length, 0, "the caller's signal is released after a failed head");
    const silentSignal = new AbortController();
    globalThis.fetch = async (url, init) => ({
      status: 200, ok: true, headers: { get: () => "text/event-stream" },
      body: { getReader: () => ({ read: () => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })), releaseLock() {} }) },
    });
    const silent = api.readStream(api.streamPath({ runId: "run_1" }), TOKEN_S, { signal: silentSignal.signal, onFrame() {} });
    await settle();
    assert.equal(getEventListeners(silentSignal.signal, "abort").length, 1, "while the stream is being read the caller's cancel is wired up");
    t.mock.timers.tick(api.STREAM_IDLE_TIMEOUT_MS - 1);
    await settle();
    settled = false;
    silent.then(() => { settled = true; });
    await settle();
    assert.equal(settled, false, "one ms before the idle timeout it is still reading");
    t.mock.timers.tick(1);
    assert.deepEqual(await silent, { ok: false, reason: "timeout" }, "no bytes for the whole idle timeout");
    assert.equal(getEventListeners(silentSignal.signal, "abort").length, 0, "and released after the idle timeout");
  } finally {
    t.mock.timers.reset();
  }
});

const APP_TOKEN = "b".repeat(64);
const BASE_GLOBALS = {
  document: globalThis.document,
  window: globalThis.window,
  fetch: globalThis.fetch,
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
};
let appSerial = 0;

function installAppBrowser({ hash, listBodies, detail, activityEvents, holdOlder = false, stream = null }) {
  const calls = [];
  const copied = [];
  const held = [];
  /** The event streams the page opened (only with stream: "open"): the test pushes frames or ends them. */
  const streams = [];
  const topbar = new FakeNode("header");
  topbar.setAttribute("id", "topbar");
  const main = new FakeNode("main");
  main.setAttribute("id", "main");
  const sidebar = new FakeNode("aside");
  sidebar.setAttribute("id", "sidebar");
  sidebar.setAttribute("hidden", "");
  const elements = { topbar, main, sidebar };
  const listeners = { window: new Map(), document: new Map() };
  const on = (side) => (type, fn) => side.set(type, [...(side.get(type) ?? []), fn]);
  const fire = (side, type, event) => { for (const fn of side.get(type) ?? []) fn(event); };
  const store = (initial) => {
    const memory = new Map(Object.entries(initial));
    return { getItem: (key) => (memory.has(key) ? memory.get(key) : null), setItem: (key, value) => { memory.set(key, String(value)); } };
  };
  const location = {
    _hash: hash,
    pathname: "/v2",
    search: "",
    get hash() { return this._hash; },
    set hash(value) {
      const next = String(value).startsWith("#") ? String(value) : `#${value}`;
      if (next === this._hash) return;
      this._hash = next;
      queueMicrotask(() => fire(listeners.window, "hashchange", {}));
    },
    reload() {},
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
    history: { replaceState: (_state, _title, url) => { const i = String(url).indexOf("#"); location._hash = i < 0 ? "" : String(url).slice(i); } },
    sessionStorage: store({ wao_v2_token: APP_TOKEN }),
    localStorage: store({}),
    addEventListener: on(listeners.window),
  };
  Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async (text) => { copied.push(text); } } }, configurable: true });
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, blob: async () => body });
    const bare = String(url).split("?")[0];
    const params = new URLSearchParams(String(url).split("?")[1] ?? "");
    if (bare === "/api/overview" || bare === "/api/workers" || bare === "/api/attention") return reply(200, listBodies.get(bare));
    if (bare === "/api/worker") return reply(200, detail);
    if (bare === "/api/worker/activity") {
      const body = {
        status: "ready", generatedAt: GEN,
        ...pageOf(params.get("runId"), activityEvents, {
          filter: params.get("filter") ?? "all",
          limit: Number(params.get("limit") ?? 200),
          ...(params.has("beforeSeq") ? { beforeSeq: Number(params.get("beforeSeq")) } : {}),
        }),
      };
      // One test keeps an older-page request in flight to move the viewport before it lands.
      if (holdOlder && params.has("beforeSeq")) return new Promise((resolve) => held.push(() => resolve(reply(200, body))));
      return reply(200, body);
    }
    if (bare === "/api/worker/event") {
      const body = projectWorkerEvent({
        runId: params.get("runId"), events: activityEvents, env: {},
        seq: Number(params.get("seq")), part: params.get("part"), page: Number(params.get("page") ?? 1),
      });
      return body === null ? reply(404, { error: "not_found" }) : reply(200, { status: "ready", generatedAt: GEN, ...body });
    }
    if (bare === "/api/worker/stream" && stream === "open") {
      // A real event-stream body the test can push frames into; cancelling works through the request's signal.
      const entry = { url: String(url), queued: [], waiting: [], ended: false, aborted: false };
      streams.push(entry);
      const abort = () => {
        entry.aborted = true;
        entry.ended = true;
        for (const waiter of entry.waiting.splice(0)) waiter.reject(init.signal.reason);
      };
      if (init.signal.aborted) abort();
      else init.signal.addEventListener("abort", abort, { once: true });
      return {
        status: 200, ok: true,
        headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "text/event-stream" : null) },
        body: {
          getReader: () => ({
            read: () => {
              if (entry.queued.length > 0) return Promise.resolve({ value: entry.queued.shift(), done: false });
              if (entry.ended) return Promise.resolve({ value: undefined, done: true });
              return new Promise((resolve, reject) => entry.waiting.push({ resolve, reject }));
            },
            releaseLock() {},
          }),
        },
      };
    }
    return reply(404, { error: "not_found" });
  };
  const restore = () => {
    globalThis.document = BASE_GLOBALS.document;
    globalThis.window = BASE_GLOBALS.window;
    globalThis.fetch = BASE_GLOBALS.fetch;
    if (BASE_GLOBALS.navigator) Object.defineProperty(globalThis, "navigator", BASE_GLOBALS.navigator);
    else delete globalThis.navigator;
  };
  return {
    calls, copied, elements, restore, streams,
    /** Server frames into an open stream, in the server's own wire format. */
    pushFrames: (entry, frames) => {
      entry.queued.push(new TextEncoder().encode(frames.map((frame) => encodeStreamFrame(frame.event, frame.data, frame.id ?? null)).join("")));
      for (const waiter of entry.waiting.splice(0)) waiter.resolve({ value: entry.queued.shift(), done: false });
    },
    /** The server closes the stream. */
    endStream: (entry) => {
      entry.ended = true;
      for (const waiter of entry.waiting.splice(0)) waiter.resolve({ value: undefined, done: true });
    },
    releaseOlder: () => { while (held.length > 0) held.shift()(); },
    clickOn: (node) => { node.click(); fire(listeners.document, "click", { target: node }); },
    scroll: () => { for (const fn of sidebar.listeners.get("scroll") ?? []) fn({ type: "scroll" }); },
    selectIn: (node) => {
      fakeSelection.rangeCount = 1;
      fakeSelection.isCollapsed = false;
      fakeSelection.anchorNode = node;
      fakeSelection.anchorOffset = 0;
      fakeSelection.focusNode = node;
      fakeSelection.focusOffset = 0;
      fire(listeners.document, "selectionchange", {});
    },
  };
}

async function bootActivityApp(t, { runId = "run_live", snapshot, listBodies, detail, activityEvents, holdOlder = false, stream = null }) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: GEN_MS });
  const browser = installAppBrowser({ hash: `#workers?run=${runId}`, listBodies, detail, activityEvents, holdOlder, stream });
  t.after(() => browser.restore());
  appSerial += 1;
  await import(`../../src/owner-dashboard/v2/app.js?activity=${appSerial}`);
  const tick = async (ms = 0) => {
    await settle();
    t.mock.timers.tick(ms);
    for (let i = 0; i < 20; i += 1) await settle();
  };
  await tick();
  return { ...browser, tick };
}

test("A11 the app wiring: the Activity tab polls every 5 s while the run is live; scrolling, selecting and expanding pause it with N new events; the selection, expansion and scroll survive polls; the code copies runId#seq; a terminal detail report does not move the tab and the stream ends on Activity", async (t) => {
  const run = snapRun("run_live", {
    state: "running", terminal: false, liveness: "progress", stage: "active",
    startedAt: ago(10 * MIN), terminalAt: null, lastEffectAt: ago(MIN),
  });
  const snapshot = snapshotOf({ runs: [run] });
  const bodies = await chain(snapshot);
  const listBodies = new Map([["/api/overview", bodies.overview], ["/api/workers", bodies.workers], ["/api/attention", bodies.attention]]);
  const detailEvents = liveTranscript().events;
  const detail = { status: "ready", generatedAt: GEN, ...(await projectWorkerDetail({ run, snapshot, runsById: new Map([[run.runId, run]]), events: detailEvents, now: GEN_MS, env: {} })) };
  const activityEvents = liveTranscript().events;
  // seq 4: a short tool output, folded to its line count; seq 5 keeps a row after it for the
  // "unchanged rows are not re-inserted" assertion.
  activityEvents.push({ type: "run.event", runId: "run_live", agentId: "glm-pro", seq: 4, ts: iso(T0 + 2500), kind: "tool_result", tool: "cmd", output: Array.from({ length: 10 }, (_, i) => `out ${i + 1}`).join("\n") });
  activityEvents.push({ type: "run.event", runId: "run_live", agentId: "glm-pro", seq: 5, ts: iso(T0 + 2600), kind: "message", role: "assistant", parts: [{ type: "text", text: "before polls" }] });
  const b = await bootActivityApp(t, { snapshot, listBodies, detail, activityEvents });
  const sidebar = b.elements.sidebar;

  assert.equal(sidebar.getAttribute("hidden"), null, "a running worker opens its panel");
  assert.deepEqual(byClass(sidebar, "act-filter-btn").map((n) => n.textContent), ["All", "Messages", "Commands", "Errors"]);
  assert.ok(rowsOf(sidebar).length > 0, "the Activity tab is the default for a running worker and its first page is drawn");
  assert.ok(b.calls.some((call) => String(call.url).startsWith("/api/worker/activity?runId=run_live")), "the first page went through the closed builder");

  // The 5 s poll picks up one appended event and keeps following.
  activityEvents.push({ type: "run.event", runId: "run_live", agentId: "glm-pro", seq: 6, ts: iso(T0 + 3000), kind: "message", role: "assistant", parts: [{ type: "text", text: "second line" }] });
  await b.tick(5000);
  assert.match(sidebar.textContent, /second line/, "the new event is appended");
  assert.equal(byClass(sidebar, "act-new-btn").length, 0, "following applies it straight away");

  // Scrolling up pauses; a new event waits as a count; the pause state is not a stop.
  sidebar.scrollTop = 0;
  sidebar.scrollHeight = 1000;
  sidebar.clientHeight = 100;
  b.scroll();
  await settle();
  assert.match(byClass(sidebar, "act-paused")[0].textContent, /Paused following/);
  activityEvents.push({ type: "run.event", runId: "run_live", agentId: "glm-pro", seq: 7, ts: iso(T0 + 4000), kind: "message", role: "assistant", parts: [{ type: "text", text: "third line" }] });
  await b.tick(5000);
  const waiting = byClass(sidebar, "act-new-btn")[0];
  assert.equal(waiting.textContent, "↓ 1 new events");
  assert.ok(!sidebar.textContent.includes("third line"), "what the Owner is reading does not move");

  // The button resumes and puts the stream back at the bottom.
  b.clickOn(waiting);
  await b.tick();
  assert.match(sidebar.textContent, /third line/);
  assert.equal(byClass(sidebar, "act-new-btn").length, 0);
  assert.equal(sidebar.scrollTop, sidebar.scrollHeight - sidebar.clientHeight, "anchored at the bottom again");

  // Selecting a line pauses it too — and the next poll must not replace the selected node.
  const list = byClass(sidebar, "act-list")[0];
  const selectedLine = byClass(list, "act-line")[0] ?? byClass(list, "act-c")[0];
  b.selectIn(selectedLine);
  await settle();
  assert.match(byClass(sidebar, "act-paused")[0].textContent, /Paused following/);
  activityEvents.push({ type: "run.event", runId: "run_live", agentId: "glm-pro", seq: 8, ts: iso(T0 + 4500), kind: "message", role: "assistant", parts: [{ type: "text", text: "selection survives" }] });
  await b.tick(5000);
  assert.equal(fakeSelection.rangeCount, 1);
  assert.equal(fakeSelection.isCollapsed, false);
  assert.equal(fakeSelection.anchorNode, selectedLine, "the anchor is still the selected node");
  assert.equal(fakeSelection.focusNode, selectedLine, "and so is the focus end");
  assert.deepEqual([fakeSelection.anchorOffset, fakeSelection.focusOffset], [0, 0]);
  assert.ok(sidebar.contains(fakeSelection.anchorNode), "the selection is still in the document (the list was not replaced)");
  assert.ok(sidebar.contains(fakeSelection.focusNode));
  assert.match(byClass(sidebar, "act-new-btn")[0].textContent, /↓ 1 new events/);

  // Expanding an output keeps its state and the scroll position across a poll too; the keyboard focus
  // follows the same control into the rebuilt row, and the rows after it are not re-inserted.
  const outRow = rowByKey(sidebar, "event:4");
  const outToggle = find(outRow, (node) => node.getAttribute("data-fk") === "act-open:event:4")[0];
  assert.ok(outToggle, "the folded output is there");
  const laterRow = list.children[list.children.indexOf(outRow) + 1];
  outToggle.focus();
  const movesBefore = list.moves;
  sidebar.scrollTop = 30;
  b.clickOn(outToggle);
  await b.tick();
  assert.equal(byClass(sidebar, "act-out").length, 1, "the output is open");
  assert.equal(sidebar.scrollTop, 30, "expanding did not move the view");
  assert.equal(list.moves - movesBefore, 1, "only the replaced row was inserted; the unchanged rows after it were not re-inserted");
  assert.equal(fakeDocument.activeElement?.getAttribute("data-fk"), "act-open:event:4", "focus went to the same control in the new row");
  assert.notEqual(fakeDocument.activeElement, outToggle, "the old node was replaced");
  assert.equal(list.children[list.children.indexOf(rowByKey(sidebar, "event:4")) + 1], laterRow, "the unchanged row after it was not re-inserted");
  activityEvents.push({ type: "run.event", runId: "run_live", agentId: "glm-pro", seq: 9, ts: iso(T0 + 4600), kind: "message", role: "assistant", parts: [{ type: "text", text: "while expanded" }] });
  await b.tick(5000);
  assert.equal(byClass(sidebar, "act-out").length, 1, "the expanded row is still open after the poll");
  assert.equal(sidebar.scrollTop, 30, "and the view did not move");
  assert.match(byClass(sidebar, "act-new-btn")[0].textContent, /↓ 2 new events/);

  // The event code copies runId#seq.
  const seqButton = byClass(sidebar, "act-seq-btn")[0];
  b.clickOn(seqButton);
  await b.tick();
  assert.match(b.copied.at(-1), /^run_live#\d{4}$/);

  // The DETAIL reports the terminal state first; the Activity stream has not ended yet. The tab was
  // decided when the worker opened, so it stays on Activity (it must not jump to Deliverable).
  detail.run.state = "completed";
  await b.tick(5000);
  assert.equal(find(sidebar, (n) => n.className === "sb-tab" && n.getAttribute("aria-pressed") === "true")[0].textContent, "Activity");
  assert.doesNotMatch(byClass(sidebar, "act-status")[0].textContent, /^Ended/);

  // Then the stream's last batch arrives: it is taken and the status says the run has ended.
  activityEvents.push({ type: "run.completed", runId: "run_live", agentId: "glm-pro", seq: 10, ts: iso(T0 + 5000) });
  activityEvents.push({ type: "run.state_change", runId: "run_live", agentId: "glm-pro", seq: 11, ts: iso(T0 + 5001), from: "running", to: "completed", reason: "completed" });
  await b.tick(5000);
  assert.match(byClass(sidebar, "act-status")[0].textContent, /^Ended · \d+ events$/);
  assert.equal(find(sidebar, (n) => n.className === "sb-tab" && n.getAttribute("aria-pressed") === "true")[0].textContent, "Activity", "the ended run finishes on Activity");
  const asked = b.calls.filter((call) => String(call.url).startsWith("/api/worker/activity")).length;
  await b.tick(5000);
  assert.equal(b.calls.filter((call) => String(call.url).startsWith("/api/worker/activity")).length, asked, "a terminal run stops the Activity poll");
});


test("A17 the visible row is the anchor of an older page even when the Owner keeps scrolling while the request is in flight: the row keeps its node and its viewport offset", async (t) => {
  const run = snapRun("run_anchor", {
    state: "running", terminal: false, liveness: "progress", stage: "active",
    startedAt: ago(10 * MIN), terminalAt: null, lastEffectAt: ago(MIN),
  });
  const snapshot = snapshotOf({ runs: [run] });
  const bodies = await chain(snapshot);
  const listBodies = new Map([["/api/overview", bodies.overview], ["/api/workers", bodies.workers], ["/api/attention", bodies.attention]]);
  const detailEvents = liveTranscript("run_anchor").events;
  const detail = { status: "ready", generatedAt: GEN, ...(await projectWorkerDetail({ run, snapshot, runsById: new Map([[run.runId, run]]), events: detailEvents, now: GEN_MS, env: {} })) };
  const history = transcript("run_anchor");
  history.clock(T0 + 1000);
  for (let i = 0; i < 230; i += 1) say(history, T0 + 1000 + i, `old ${i + 1}`);
  const b = await bootActivityApp(t, { runId: "run_anchor", snapshot, listBodies, detail, activityEvents: history.events, holdOlder: true });
  const sidebar = b.elements.sidebar;
  const list = byClass(sidebar, "act-list")[0];
  assert.equal(rowsOf(sidebar).length, 200, "the newest page is on screen");
  sidebar.scrollTop = 0;
  sidebar.scrollHeight = 1000;
  sidebar.clientHeight = 100;
  b.scroll();
  await settle();
  assert.ok(b.calls.some((call) => String(call.url).includes("beforeSeq=")), "the older page request started and is held");
  sidebar.scrollTop = 40; // the Owner keeps scrolling while it is in flight
  const visibleRow = list.children[2];
  const anchorKey = visibleRow.getAttribute("data-act-key");
  b.releaseOlder();
  await b.tick();
  assert.equal(rowsOf(sidebar).length, 230, "the older page was inserted above");
  const still = find(sidebar, (node) => node.getAttribute("data-act-key") === anchorKey)[0];
  assert.equal(still, visibleRow, "the row visible when the answer arrived was not rebuilt");
  assert.equal(sidebar.scrollTop, 640, "40 (where the Owner had scrolled) + 30 inserted rows * 20px");
});

test("A17b a folded row that is merged with the older page is found again by its old seq range, even though its key changes", async (t) => {
  const run = snapRun("run_foldanchor", {
    state: "running", terminal: false, liveness: "progress", stage: "active",
    startedAt: ago(10 * MIN), terminalAt: null, lastEffectAt: ago(MIN),
  });
  const snapshot = snapshotOf({ runs: [run] });
  const bodies = await chain(snapshot);
  const listBodies = new Map([["/api/overview", bodies.overview], ["/api/workers", bodies.workers], ["/api/attention", bodies.attention]]);
  const detailEvents = liveTranscript("run_foldanchor").events;
  const detail = { status: "ready", generatedAt: GEN, ...(await projectWorkerDetail({ run, snapshot, runsById: new Map([[run.runId, run]]), events: detailEvents, now: GEN_MS, env: {} })) };
  const history = transcript("run_foldanchor");
  history.clock(T0 + 1000);
  for (let i = 0; i < 300; i += 1) history.add("run.event", { kind: "runtime_activity", status: "process_active" });
  const b = await bootActivityApp(t, { runId: "run_foldanchor", snapshot, listBodies, detail, activityEvents: history.events, holdOlder: true });
  const sidebar = b.elements.sidebar;
  const list = byClass(sidebar, "act-list")[0];
  const before = byClass(list, "act-fold")[0];
  assert.ok(before, "the latest page is one folded row");
  const oldKey = before.getAttribute("data-act-key");
  const oldFrom = before.getAttribute("data-range-from");
  sidebar.scrollTop = 0;
  sidebar.scrollHeight = 1000;
  sidebar.clientHeight = 100;
  b.scroll();
  await settle();
  b.releaseOlder();
  await b.tick();
  const folds = byClass(sidebar, "act-fold");
  assert.equal(folds.length, 1, "the page seam is one fold, not two");
  assert.notEqual(folds[0].getAttribute("data-act-key"), oldKey, "the merge changed the key");
  assert.ok(Number(folds[0].getAttribute("data-range-from")) < Number(oldFrom), "the range now covers the older run");
  assert.equal(byClass(sidebar, "act-in").length, 0, "a merged / extended row does not replay the fade");
  assert.equal(sidebar.scrollTop, 0, "the anchor was found by its old range and kept in place");
});

test("A25 full-text paging keeps the keyboard focus on the same control while the next page loads", async () => {
  const b = transcript("run_pager");
  b.clock(T0 + 1000).add("run.event", { kind: "command", command: `npm test -- ${"x".repeat(70_000)}`, toolCallId: "pager-1", exitCode: 0 });
  const { feed } = await openedFeed("run_pager", b.events);
  const row = activity.buildActivityView(feed.get()).rows.find((item) => item.code === "CMD");
  assert.equal(feed.openFull(row.key), true);
  await settle();
  const host = region();
  const base = recorder();
  const actions = { ...base };
  const draw = () => renderActivity(activity.buildActivityView(feed.get()), "en", actions, SUI(), host);
  actions.activityFullPage = (key, delta) => {
    base.activityFullPage(key, delta);
    if (feed.fullPage(key, delta)) draw();
  };
  draw();
  const next = () => find(host, (node) => node.getAttribute("data-fk") === `act-next:${row.key}`)[0];
  const first = next();
  assert.ok(first);
  assert.equal(first.getAttribute("disabled"), null);
  first.focus();
  assert.equal(fakeDocument.activeElement, first);
  first.click();
  const loading = next();
  assert.notEqual(loading, first, "the row was rebuilt for the loading state");
  assert.equal(loading.getAttribute("disabled"), null, "the loading-state button stays focusable");
  assert.equal(fakeDocument.activeElement, loading, "focus followed the same data-fk control through loading");
  await settle();
  draw();
  const page2 = next();
  assert.equal(fakeDocument.activeElement, page2, "and after page 2 arrived");
  assert.equal(byClass(host, "act-page")[0].textContent, "2 / 3");
});


test("A20 tab switching in any order always shows the selected tab's body: Brief -> Activity -> Brief and Deliverable -> Activity -> Brief", async (t) => {
  const run = snapRun("run_tabs", {
    state: "running", terminal: false, liveness: "progress", stage: "active",
    startedAt: ago(10 * MIN), terminalAt: null, lastEffectAt: ago(MIN),
  });
  const snapshot = snapshotOf({ runs: [run] });
  const bodies = await chain(snapshot);
  const listBodies = new Map([["/api/overview", bodies.overview], ["/api/workers", bodies.workers], ["/api/attention", bodies.attention]]);
  const detailEvents = liveTranscript("run_tabs").events;
  detailEvents.push({ type: "prompt.sent", runId: "run_tabs", agentId: "glm-pro", seq: 50, ts: iso(T0 + 100), prompt: "# Tab brief\nBrief body." });
  const detail = { status: "ready", generatedAt: GEN, ...(await projectWorkerDetail({ run, snapshot, runsById: new Map([[run.runId, run]]), events: detailEvents, now: GEN_MS, env: {} })) };
  const b = await bootActivityApp(t, { runId: "run_tabs", snapshot, listBodies, detail, activityEvents: liveTranscript("run_tabs").events });
  const sidebar = b.elements.sidebar;
  const tab = (name) => find(sidebar, (node) => node.className === "sb-tab" && node.textContent === name)[0];
  const pressed = () => find(sidebar, (node) => node.className === "sb-tab" && node.getAttribute("aria-pressed") === "true")[0].textContent;
  const briefShown = () => byClass(sidebar, "act-list").length === 0 && sidebar.textContent.includes("Brief body.");

  b.clickOn(tab("Brief"));
  await b.tick();
  assert.equal(pressed(), "Brief");
  assert.equal(briefShown(), true);

  b.clickOn(tab("Activity"));
  await b.tick();
  assert.equal(pressed(), "Activity");
  assert.ok(byClass(sidebar, "act-list").length > 0);

  b.clickOn(tab("Brief"));
  await b.tick();
  assert.equal(pressed(), "Brief");
  assert.equal(briefShown(), true, "Brief -> Activity -> Brief shows the Brief body again");

  b.clickOn(tab("Deliverable"));
  await b.tick();
  assert.equal(pressed(), "Deliverable");
  assert.equal(byClass(sidebar, "act-list").length, 0);

  b.clickOn(tab("Activity"));
  await b.tick();
  assert.ok(byClass(sidebar, "act-list").length > 0);

  b.clickOn(tab("Brief"));
  await b.tick();
  assert.equal(pressed(), "Brief");
  assert.equal(briefShown(), true, "Deliverable -> Activity -> Brief shows the Brief body again");
});

/** A transport cursor of the server's shape (opaque to the page: it only hands it back on a reconnect). */
const cursorFor = (offset) => `1.0123456789abcdef.fedcba9876543210.${BigInt(offset).toString(36)}.3.0f1e2d3c4b5a6978`;

test("S13 the app wiring: the Activity tab is Live while its stream is up and a pushed frame shows without a tick; leaving the tab cancels the stream and coming back reconnects from the cursor; end keeps the tab on Activity with the run's own count", async (t) => {
  const run = snapRun("run_live", {
    state: "running", terminal: false, liveness: "progress", stage: "active",
    startedAt: ago(10 * MIN), terminalAt: null, lastEffectAt: ago(MIN),
  });
  const snapshot = snapshotOf({ runs: [run] });
  const bodies = await chain(snapshot);
  const listBodies = new Map([["/api/overview", bodies.overview], ["/api/workers", bodies.workers], ["/api/attention", bodies.attention]]);
  const detailEvents = liveTranscript().events;
  const detail = { status: "ready", generatedAt: GEN, ...(await projectWorkerDetail({ run, snapshot, runsById: new Map([[run.runId, run]]), events: detailEvents, now: GEN_MS, env: {} })) };
  const activityEvents = liveTranscript().events;
  const b = await bootActivityApp(t, { snapshot, listBodies, detail, activityEvents, stream: "open" });
  const sidebar = b.elements.sidebar;
  const status = () => byClass(sidebar, "act-status")[0].textContent;
  const tab = (name) => find(sidebar, (node) => node.className === "sb-tab" && node.textContent === name)[0];
  const pressed = () => find(sidebar, (node) => node.className === "sb-tab" && node.getAttribute("aria-pressed") === "true")[0].textContent;
  const push = (entry, seq, text) => {
    activityEvents.push({ type: "run.event", runId: "run_live", agentId: "glm-pro", seq, ts: iso(T0 + seq * 1000), kind: "message", role: "assistant", parts: [{ type: "text", text }] });
    b.pushFrames(entry, [{ id: cursorFor(seq), event: "rows", data: { ...pageOf("run_live", activityEvents, { afterSeq: seq - 1 }), updates: [] } }]);
  };

  assert.equal(b.streams.length, 1, "the Activity tab opened one stream");
  const first = b.streams[0];
  assert.match(first.url, /^\/api\/worker\/stream\?runId=run_live&afterSeq=\d+&filter=all$/, "through the closed builder, after the first page's cursor");
  const call = b.calls.find((c) => c.url === first.url);
  assert.equal(call.init.headers.authorization, `Bearer ${APP_TOKEN}`, "with the bearer in the header");
  assert.doesNotMatch(status(), /^Live/, "not Live before the first frame");
  b.pushFrames(first, [{ id: cursorFor(3), event: "rows", data: pageOf("run_live", activityEvents, { afterSeq: 3 }) }]);
  await settle();
  assert.equal(status(), "Live");

  // A new event arrives through the stream: it shows at once, with no 5 s tick.
  push(first, 4, "pushed by the stream");
  await settle();
  assert.match(sidebar.textContent, /pushed by the stream/);
  assert.equal(status(), "Live");
  const polls = b.calls.filter((c) => String(c.url).startsWith("/api/worker/activity")).length;
  await b.tick(5000);
  assert.equal(b.calls.filter((c) => String(c.url).startsWith("/api/worker/activity")).length, polls, "while Live the 5 s tick does not poll the timeline");

  // Leaving the tab cancels the stream; coming back reconnects from the last frame's cursor.
  b.clickOn(tab("Deliverable"));
  await b.tick();
  assert.equal(pressed(), "Deliverable");
  assert.equal(first.aborted, true, "the old stream was cancelled");
  b.clickOn(tab("Activity"));
  await b.tick();
  assert.equal(pressed(), "Activity");
  assert.equal(b.streams.length, 2, "a new stream");
  assert.ok(b.streams[1].url.includes(`&cursor=${cursorFor(4)}&`), `from the cursor of the last frame it received: ${b.streams[1].url}`);
  assert.doesNotMatch(status(), /^Live/, "not Live until the new stream's first frame");

  // The run ends: the last rows, then end. The tab stays on Activity and says how many events the run has.
  const second = b.streams[1];
  push(second, 5, "last words");
  await settle();
  assert.equal(status(), "Live");
  b.pushFrames(second, [{ id: cursorFor(6), event: "end", data: { runId: "run_live", state: "completed", terminal: true, total: 7 } }]);
  await settle();
  assert.equal(status(), "Ended · 7 events");
  assert.equal(pressed(), "Activity", "the ended run finishes on Activity");
  await b.tick(5000);
  await b.tick(5000);
  assert.equal(b.streams.length, 2, "no reconnect after end");
});


test("M5 the top counts: nothing on a cold bar, 200 ms when the first number arrives, 300 ms on +1, 250 ms when a count clears to gray — and the number's cell never changes width", () => {
  const vmOf = (needsYou, alerts) => ({
    page: "overview",
    counts: { needsYou, alerts },
    tones: { needsYou: needsYou > 0 ? "red" : "gray", alerts: alerts > 0 ? "amber" : "gray" },
    freshness: { kind: "polling", sinceMs: null },
  });
  const classesOf = (root, kind) => byClass(root, `badge-${kind}`)[0].className;
  const root = region();
  renderTopbar(root, { ...vmOf(null, null), counts: null, tones: { needsYou: "gray", alerts: "gray" } }, "en", recorder());
  assert.doesNotMatch(byClass(root, "badge-needsYou")[0].className, /badge-(first|bump|clear)/, "a cold bar has no number to animate");
  renderTopbar(root, vmOf(2, 3), "en", recorder());
  assert.match(classesOf(root, "needsYou"), /badge-first/);
  assert.match(classesOf(root, "alerts"), /badge-first/);
  renderTopbar(root, vmOf(3, 4), "en", recorder());
  assert.match(classesOf(root, "needsYou"), /badge-bump/, "+1");
  assert.match(classesOf(root, "alerts"), /badge-bump/);
  renderTopbar(root, vmOf(0, 4), "en", recorder());
  assert.match(classesOf(root, "needsYou"), /badge-(gray|clear)/, "clearing recedes to gray");
  assert.match(classesOf(root, "needsYou"), /badge-clear/);
  assert.match(classesOf(root, "needsYou"), /badge-gray/);
  assert.match(MOTION, /\.badge-first \.badge-n \{ animation: badge-first 200ms var\(--ease\); \}/);
  assert.match(MOTION, /\.badge-bump \.badge-n \{ animation: badge-bump 300ms var\(--ease\); \}/);
  assert.match(MOTION, /\.badge-needsYou\.badge-clear \{ animation: badge-clear-red 250ms var\(--ease\); \}/);
  assert.match(MOTION, /\.badge-alerts\.badge-clear \{ animation: badge-clear-amber 250ms var\(--ease\); \}/);
});

test("M6 the run / delivery axes grow their line in 300 ms only when a step's mark actually changes; a plain redraw never replays it", async () => {
  // The view marks a step whose mark changed since the previous draw. This is driven by the real panel view
  // model: the first draw is quiet, a state change animates, and a redraw with the same marks does not.
  const { renderSidebar } = await import("../../src/owner-dashboard/v2/sidebarview.js");
  const vm = {
    kind: "detail",
    runId: "run_anim",
    note: null,
    ref: "run_anim",
    title: "Animated",
    subtitle: null,
    type: "code",
    lane: "glm-pro",
    projectName: "shop-api",
    elapsedMs: 1000,
    health: { terminal: false, word: "progress", tone: "gray", glyph: "●", progressAgoMs: 1000, heartbeatAgoMs: null, failure: null },
    axes: {
      run: { steps: [{ id: "starting", mark: "done" }, { id: "running", mark: "current" }], startingAgeMs: null, startingSlow: false, stageUnknown: false },
      delivery: null,
      consult: null,
    },
    defaultTab: "activity",
    deliverable: { kind: "none" },
    brief: { present: false, text: "", truncated: false, keptChars: 0, totalChars: 0 },
    stale: false,
  };
  const root = region("aside");
  assert.equal(renderSidebar(root, vm, "en", SUI({ tab: "brief" }), [], {}, recorder()), true);
  assert.equal(byClass(root, "step-arrive").length, 0, "the panel opening is not a state arrival");
  const next = { ...vm, axes: { ...vm.axes, run: { ...vm.axes.run, steps: [{ id: "starting", mark: "done" }, { id: "running", mark: "done" }, { id: "completed", mark: "current" }] } } };
  assert.equal(renderSidebar(root, next, "en", SUI({ tab: "brief" }), [], {}, recorder()), true);
  assert.deepEqual(byClass(root, "step-arrive").map((node) => node.getAttribute("data-step")), ["run:running", "run:completed"], "the step that got its tick and the one that became current");
  assert.equal(renderSidebar(root, next, "en", SUI({ tab: "brief" }), [], {}, recorder()), false, "same data: no redraw, no replay");
  assert.match(MOTION, /\.step-arrive::before \{ animation: step-line 300ms var\(--ease\); \}/);
  assert.match(MOTION, /\.step-arrive \.step-glyph \{ animation: step-mark 300ms var\(--ease\); \}/);
});


// =====================================================================
// M) MOTION
// =====================================================================

const CSS = readV2("styles.css");
const MOTION_START = CSS.indexOf("/* ===== motion");
const MOTION = CSS.slice(MOTION_START);
const cssRule = (selector) => new RegExp(`(?:^|\\n)${selector.replace(/[.[\]()|*+?^$\\/]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1] ?? "";
const EASE = "cubic-bezier(0.215, 0.61, 0.355, 1)";

test("M1 the motion: the design's durations on ONE ease-out curve, the required attribution, and a reduced-motion rule that turns it all off", () => {
  assert.ok(MOTION_START > 0, "the motion section exists");
  assert.match(MOTION, /#068/);
  assert.match(MOTION, /#071/);
  assert.match(MOTION, /#005/);
  assert.match(MOTION, /#050/);
  assert.match(MOTION, /#069/);
  assert.match(MOTION, /#081/);
  assert.match(MOTION, /MIT License, © 2026 Shohei Ohtaki, https:\/\/showheyohtaki\.github\.io\/motion-prompt\//);
  assert.match(CSS, new RegExp(`--ease: ${EASE.replace(/[.()]/g, "\\$&")}`), "one curve, declared once");
  // Every transition / animation declaration in the motion section uses the curve — the reduced-motion
  // block's `none` is the only exception.
  const reducedAt = MOTION.indexOf("@media (prefers-reduced-motion: reduce)");
  assert.ok(reducedAt > 0, "a reduced-motion rule exists");
  const moving = MOTION.slice(0, reducedAt);
  const declarations = [...moving.matchAll(/(?:transition|animation):\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(declarations.length >= 10, `every scene declares its move (${declarations.length})`);
  for (const value of declarations) assert.match(value, /var\(--ease\)/, value);
  assert.ok(!/animation:\s*none|transition:\s*none/.test(moving), "no 'off' rule before the reduced-motion block");
  const reduced = MOTION.slice(reducedAt);
  assert.match(reduced, /animation:\s*none\s*!important/);
  assert.match(reduced, /transition:\s*none\s*!important/);
  // The table's durations.
  for (const [what, ms] of [["step", 300], ["badge first", 200], ["badge +1", 300], ["badge clear", 250], ["attention reveal", 650], ["drawer open", 380], ["drawer close", 350], ["skeleton in", 150], ["skeleton sweep", 900], ["content in", 300], ["hover", 300], ["event append", 120]]) {
    assert.match(moving, new RegExp(`[\\s:]${ms}ms`), `${what}: ${ms} ms`);
  }
  // Page switches are 0 ms: nothing on the page body transitions.
  assert.doesNotMatch(cssRule(".page"), /transition|animation/);
  // The counts keep a fixed width.
  assert.match(CSS, /\.badge-n\s*\{[^}]*width:\s*2ch/, "the count keeps its width, so +1 never moves the bar");
});

test("M2 only properties that do not trigger reflow move: transitions never name width/height/top/left/margin/padding, and keyframes only touch transform / opacity / clip-path / color", () => {
  assert.ok(MOTION_START > 0);
  const declarations = [...MOTION.matchAll(/(?:transition|animation):\s*([^;]+);/g)].map((m) => m[1]);
  for (const value of declarations) {
    assert.doesNotMatch(value, /\b(width|height|top|left|right|bottom|margin|padding|inset)\b/, value);
  }
  // Every @keyframes body: only the properties that cannot reflow.
  const allowed = new Set(["transform", "opacity", "clip-path", "color"]);
  for (const match of MOTION.matchAll(/@keyframes\s+[a-z-]+\s*\{([\s\S]*?)\n\}/g)) {
    for (const decl of match[1].matchAll(/(?:^|[;{]\s*)([a-z-]+)\s*:/g)) {
      assert.ok(allowed.has(decl[1]), `keyframes animate ${decl[1]}`);
    }
  }
  // The sidebar opens with a transform, not by moving the layout; the lift uses an outline, not a border.
  const sidebar = cssRule(".sidebar");
  assert.doesNotMatch(sidebar, /transition|animation/, "the layout rule itself keeps its geometry");
  assert.match(MOTION, /\.sidebar \{ animation: drawer-open 380ms var\(--ease\); \}/);
  assert.match(MOTION, /\.sidebar\.sb-closing \{ animation: drawer-close 350ms var\(--ease\) forwards; \}/);
  assert.match(MOTION, /\.wcard:hover \{ transform: translateY\(-1px\); outline-color: var\(--line\); \}/);
  assert.doesNotMatch(CSS, /box-shadow|text-shadow|drop-shadow/, "the lift is an outline; nothing gets a shadow");
});

test("M3 only a NEW Attention row gets the 650 ms mask reveal: a redraw of the same items (or a poll that changes something else) never replays it", async () => {
  const first = await chain(snapshotOf({ runs: [snapRun("run_a", { state: "failed", title: "Failed A", terminalAt: ago(HOUR), terminalSeq: 40, failure: { category: "provider_error", code: "backend_error" } })] }));
  const vmOf = (bodies) => ({ page: "attention", project: null, projectName: null, ...model.buildAttention({ attention: bodies.attention, workers: bodies.workers }, { refMs: GEN_MS, project: null }) });
  const root = region();
  const ui = { selected: null, legacyOpen: { decide: false, anomalies: false }, resolvedOpen: false, copy: null };
  assert.equal(renderMain(root, vmOf(first), "en", ui, recorder()), true);
  assert.equal(byClass(root, "item-new").length, 0, "the first draw is not an arrival: nothing replays on load");
  assert.equal(byTag(root, "button").length > 0, true);

  // A poll of the same publication: untouched.
  assert.equal(renderMain(root, vmOf(first), "en", ui, recorder()), false, "same data: no redraw at all, so no reveal");
  assert.equal(byClass(root, "item-new").length, 0);

  // A new failed run appears: only its row carries the class.
  const second = await chain(snapshotOf({
    runs: [
      snapRun("run_a", { state: "failed", title: "Failed A", terminalAt: ago(HOUR), terminalSeq: 40, failure: { category: "provider_error", code: "backend_error" } }),
      snapRun("run_b", { state: "failed", title: "Failed B", terminalAt: ago(10 * MIN), terminalSeq: 50, failure: { category: "provider_error", code: "backend_error" } }),
    ],
  }));
  assert.equal(renderMain(root, vmOf(second), "en", ui, recorder()), true);
  const fresh = byClass(root, "item-new");
  assert.equal(fresh.length, 1, "exactly one new row");
  assert.match(fresh[0].textContent, /Failed B/);
  assert.equal(fresh[0].tag, "li");
  // The previous row is still there, without the class.
  assert.ok(byClass(root, "item").some((node) => /Failed A/.test(node.textContent) && !node.className.includes("item-new")));

  // The CSS: clip reveal, no opacity animation, at most one line of movement.
  assert.match(MOTION, /\.item-new \{ animation: item-reveal 650ms var\(--ease\); \}/);
  const reveal = /@keyframes item-reveal \{([\s\S]*?)\n\}/.exec(MOTION)[1];
  assert.match(reveal, /clip-path: inset\(0 0 calc\(100% - 1px\) 0\)/);
  assert.match(reveal, /translateY\(-8px\)/);
  assert.doesNotMatch(reveal, /opacity/, "the text stays opaque; only the clip and a small slide move it");
});

test("M4 the sidebar's appended events: only the rows new since the last draw carry the 120 ms fade (no stagger), and the follow state keeps the stream at the bottom", async () => {
  const b = liveTranscript();
  const events = b.events;
  const { feed } = await openedFeed("run_live", events);
  const root = region();
  const first = activity.buildActivityView(feed.get());
  renderActivity(first, "en", recorder(), SUI(), root);
  assert.ok(rowsOf(root).length > 0);
  assert.equal(byClass(root, "act-in").length, rowsOf(root).length, "the first draw may fade in as a whole");

  say(b, T0 + 3000, "second line");
  await feed.poll();
  const second = activity.buildActivityView(feed.get());
  renderActivity(second, "en", recorder(), SUI(), root);
  const fresh = byClass(root, "act-in");
  assert.equal(fresh.length, 1, "exactly the appended row fades");
  assert.match(fresh[0].textContent, /second line/);
  assert.ok(!MOTION.includes("animation-delay"), "no stagger: every row starts at once");
  assert.match(MOTION, /\.act-in \{ animation: act-in 120ms var\(--ease\); \}/);
  assert.equal(feed.takeScrollRequest(), true, "a following append asks to stay anchored at the bottom");

  // A redraw with no new rows: nothing carries the class again.
  renderActivity(second, "en", recorder(), SUI(), root);
  assert.equal(byClass(root, "act-in").length, 0, "only the draw that added the row animates it");
});
