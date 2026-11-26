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
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createOwnerDashboardServer } from "../../src/ownerDashboardServer.js";
import { projectWorkerActivity, projectWorkerEvent } from "../../src/application/ownerWorkerActivity.js";
import { projectWorkerDetail } from "../../src/application/ownerWorkerDetail.js";
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
  workspaceRoot: "/server/owned/ws",
  knownAgentIds: ["coder_low"],
  env: {},
  getOwnerRunsFn: async () => ({ runs: [], returnedCount: 0, matchedCount: 0, truncated: false }),
  getOwnerActivityFn: async () => ({}),
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

test("A12 the stream status: Polling 5s while the 5 s poll is healthy, Stale since HH:MM after a failed poll, never Live; a command's exit code appears when its result arrives", async () => {
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
  assert.ok(!root.textContent.includes("Live"), "Live is not claimed before the push batch");
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


const APP_TOKEN = "b".repeat(64);
const BASE_GLOBALS = {
  document: globalThis.document,
  window: globalThis.window,
  fetch: globalThis.fetch,
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
};
let appSerial = 0;

function installAppBrowser({ hash, listBodies, detail, activityEvents, holdOlder = false }) {
  const calls = [];
  const copied = [];
  const held = [];
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
    calls, copied, elements, restore,
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

async function bootActivityApp(t, { runId = "run_live", snapshot, listBodies, detail, activityEvents, holdOlder = false }) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: GEN_MS });
  const browser = installAppBrowser({ hash: `#workers?run=${runId}`, listBodies, detail, activityEvents, holdOlder });
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
