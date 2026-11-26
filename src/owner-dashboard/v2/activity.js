// src/owner-dashboard/v2/activity.js
//
// The Activity tab of the worker side panel, as pure functions: no DOM, no globals, no network (the two
// fetches are injected). Importable from Node: the tests feed it the REAL output of
// projectWorkerActivity / projectWorkerEvent (the server's two read-only routes), never a hand-written
// object posing as one.
//
// Two parts:
//   createActivityFeed  the open run, its pages and its polling cursor. Every open / filter change starts
//                       a new epoch and an answer of an older epoch is dropped, even for the same run
//                       (A -> B -> A). The cursor is the last seq RECEIVED: a poll asks the route for the
//                       page after `afterSeq` and pages backwards with `afterSeq + beforeSeq = page start`
//                       until a page's range covers cursor+1. The pages are therefore disjoint: hidden
//                       events are inside a page's range (never mistaken for a hole), and merging never
//                       needs a seq-span estimate. If the catch-up needs more than
//                       ACTIVITY_CATCHUP_PAGE_MAX pages, an explicit "not loaded" row marks the uncovered
//                       range and a reload starts the tail over; paused, the count is then inexact and
//                       shown as "N+".
//                       Following is a state, not a side effect: while paused (scrolled up, a selection, an
//                       expanded row) the caught-up rows wait aside and only the count changes, and only
//                       "↓ N new events" / a scroll back to the bottom puts them in front of the Owner.
//                       A transcript without event numbers has no cursor: every poll replaces the newest
//                       page whole (never merge) so its folded counts cannot grow on their own. A page
//                       with an unnumbered timeline row switches the whole session to that replace mode.
//                       The hidden count belongs to the loaded range (it is added per new page and never
//                       cleared by an empty poll); "N+" belongs only to the pause that hit the catch-up cap.
//   buildActivityView   the rows in display order (events, folded runtime activity, gap / not-loaded
//                       lines), what is expanded, the full-text page, and the stream status
//                       (Polling 5s / Stale since / ended with the run's own event total).
//
// Nothing is made up. seq numbers, ranges, gaps and counts are the server's; a missing or conflicting seq
// keeps its mark and is never renumbered. A folded run that overlaps or touches an already shown one is
// merged by range (never added end to end), so a sliding page window cannot inflate its count.

import { evidenceCode } from "./model.js";

/** The interface's filter set, in the order the row is drawn. */
export const ACTIVITY_FILTERS = Object.freeze(["all", "messages", "commands", "errors"]);
/** The first page (and each page) asks for at most this many units: the route's own maximum. */
export const ACTIVITY_PAGE_LIMIT = 200;
/** How many pages one catch-up may fetch before it stops and marks the unloaded hole. */
export const ACTIVITY_CATCHUP_PAGE_MAX = 8;

const isObject = (value) => value !== null && typeof value === "object";
const validSeq = (value) => Number.isInteger(value) && value > 0;

/** Errors start open (and stay open); everything else starts as a one-liner (Out rows show their count). */
export function isDefaultOpen(row) {
  return isObject(row) && row.row === "event" && (row.code === "ERR" || (row.code === "OUT" && row.isError === true));
}

/** The weight of one unit in "N events": a row is one event, a folded run how many it swallowed, a hole none. */
const weightOf = (row) => {
  if (row.row === "fold") return Math.max(0, row.count ?? 0);
  return row.row === "event" ? 1 : 0;
};
const totalWeight = (units) => (Array.isArray(units) ? units.reduce((sum, unit) => sum + (unit.weight ?? weightOf(unit)), 0) : 0);

function pageFrom(body) {
  return isObject(body?.range) && validSeq(body.range.fromSeq) ? body.range.fromSeq : null;
}

function pageTo(body) {
  return isObject(body?.range) && validSeq(body.range.toSeq) ? body.range.toSeq : null;
}

/**
 * Server rows -> display units with a stable key. An ok seq is unique in a transcript, so it IS the
 * key; a missing / conflicting row gets a key from its own facts plus its ordinal among identical ones.
 */
function unitsFromRows(rows) {
  const seen = new Map();
  return (Array.isArray(rows) ? rows : []).filter(isObject).map((row) => {
    let key;
    if (row.row === "gap") {
      key = `gap:${row.fromSeq}:${row.toSeq}`;
    } else if (row.row === "fold") {
      key = `fold:${row.seqState}:${row.fromSeq ?? row.fromTs ?? "x"}`;
    } else if (row.seqState === "ok" && validSeq(row.seq)) {
      key = `event:${row.seq}`;
    } else {
      const base = `event:${row.seqState ?? "-"}:${row.seq ?? "-"}:${row.ts ?? "-"}:${row.code ?? "-"}:${row.summary ?? ""}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      key = `${base}:${n}`;
    }
    return { ...row, key, weight: weightOf(row) };
  });
}

function unitsOf(body) {
  return unitsFromRows(body?.rows);
}

/** Changed rows of earlier seqs (a command completed by a later result); never appended, only swapped in. */
function updatesOf(body) {
  return unitsFromRows(body?.updates);
}

/** A marker for a hole the catch-up did not reach (the range it could not load). */
export function unloadedUnit(fromSeq, toSeq) {
  return {
    row: "unloaded", fromSeq, toSeq, count: toSeq - fromSeq + 1,
    key: `unloaded:${fromSeq}:${toSeq}`, weight: 0,
  };
}

const reweigh = (unit) => ({ ...unit, weight: weightOf(unit) });

/**
 * Merge chronological units whose seq intervals do not overlap (the client only ever appends the range
 * after its cursor, and older pages are cut at the current first seq). Two folded runs that end up next
 * to each other in the list are one runtime run as far as the projection is concerned — even when a
 * hidden event sat between them — so their server counts add and the range is the union. No seq-span
 * estimation: a hidden event is never counted as an RT event.
 */
function mergeUnits(units) {
  const out = [];
  const byKey = new Map();
  for (const unit of units) {
    if (!isObject(unit)) continue;
    const last = out[out.length - 1];
    if (unit.row === "fold" && last !== undefined && last.row === "fold"
      && last.seqState === unit.seqState && unit.seqState !== "conflict") {
      out[out.length - 1] = reweigh({
        ...last,
        toSeq: validSeq(unit.toSeq) ? unit.toSeq : last.toSeq,
        toTs: unit.toTs ?? last.toTs,
        status: unit.status ?? last.status,
        count: last.count + unit.count,
      });
      continue;
    }
    if (unit.key !== undefined && byKey.has(unit.key)) {
      out[byKey.get(unit.key)] = unit;
      continue;
    }
    if (unit.key !== undefined) byKey.set(unit.key, out.length);
    out.push(unit);
  }
  return out;
}

/**
 * Swap in changed rows that already exist (a command whose later result supplied an exit code). Never
 * append an update: an update is not part of the caught-up interval and must not affect the count.
 */
function applyUpdates(units, updates) {
  if (!Array.isArray(updates) || updates.length === 0) return units;
  const byKey = new Map(updates.map((unit) => [unit.key, unit]));
  return units.map((unit) => byKey.get(unit.key) ?? unit);
}

const IDLE = Object.freeze({
  runId: null, epoch: 0, filter: "all", phase: "idle",
  rows: [], oldestOlder: null, tailHidden: 0, olderHidden: 0,
  total: 0, terminal: false, following: true, pausedBy: null,
  pendingRows: null, newCount: 0, newCountExact: true, problem: null, staleSinceMs: null,
  lastSeq: null, replaceWhole: false, toggled: new Map(), full: new Map(),
});

/** A missing-severity timeline row means this session cannot use the seq cursor (old / mixed archive). */
const hasUnnumbered = (units) => units.some((unit) => (
  (unit.row === "event" || unit.row === "fold") && unit.seqState === "missing"
));

const hiddenOf = (body) => (Number.isInteger(body?.hidden?.filtered) ? body.hidden.filtered : 0);
/**
 * The Activity feed of the one open worker.
 *
 * @param {object} io
 * @param {(query: {runId: string, filter: string, limit: number, afterSeq?: number, beforeSeq?: number}) => Promise<{ok: boolean, body?: object, reason?: string}>} io.fetchPage
 * @param {(query: {runId: string, seq: number, part: string, page: number}) => Promise<{ok: boolean, body?: object, reason?: string}>} io.fetchFull
 * @param {() => void} [io.onChange] — called after an answer was applied (or a poll failed); not called by
 *   the synchronous operations (open / filter / expand / page requests start), so the app can render once.
 * @param {() => number} [io.now] — the clock a failed poll's "stale since" starts from
 * @param {(epoch: number) => void} [io.onEpoch] — a new epoch started: the app cancels the requests of the
 *   previous one (the answers would be dropped here anyway; this stops them on the wire too)
 */
export function createActivityFeed({ fetchPage, fetchFull, onChange = () => {}, now = () => Date.now(), onEpoch = () => {} }) {
  if (typeof fetchPage !== "function" || typeof fetchFull !== "function") throw new TypeError("createActivityFeed: fetchPage and fetchFull are required");
  let state = { ...IDLE, toggled: new Map(), full: new Map() };
  let epoch = 0;
  let loadingPage = false;
  let loadingOlder = false;
  let polling = false;
  let scrollRequest = false;
  let prependAnchor = null;

  const set = (patch) => { state = { ...state, ...patch }; };

  /** Pause following (scrolled up / a selection / an expanded row). False when already paused. */
  function pause(reason) {
    if (!state.following) return false;
    set({ following: false, pausedBy: reason });
    return true;
  }

  /** Resume following: the rows held aside are applied, the view is asked to go to the bottom. */
  function follow() {
    if (state.following) return false;
    const pending = state.pendingRows;
    set({
      following: true,
      pausedBy: null,
      rows: pending ?? state.rows,
      pendingRows: null,
      newCount: 0,
      newCountExact: true,
    });
    if (pending !== null) scrollRequest = true;
    return true;
  }

  /** A body is usable only when it is this run's page with a rows array. */
  const pageOk = (body) => isObject(body) && body.runId === state.runId && Array.isArray(body.rows);
  /** A body's status is one of the read-model answers; loading / unavailable carry no data. */
  const hasData = (body) => isObject(body) && body.status !== "loading" && body.status !== "unavailable" && Array.isArray(body.rows);

  function pageQuery({ afterSeq, beforeSeq } = {}) {
    return {
      runId: state.runId, filter: state.filter, limit: ACTIVITY_PAGE_LIMIT,
      ...(afterSeq === undefined ? {} : { afterSeq }),
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    };
  }

  /** The last seq a page reaches: its own range, else the greatest seq among its rows. */
  function lastSeqOf(body, units) {
    const fromRange = pageTo(body);
    if (fromRange !== null) return fromRange;
    let best = null;
    for (const unit of units) {
      const end = unit.row === "event"
        ? (unit.seqState === "ok" && validSeq(unit.seq) ? unit.seq : null)
        : (validSeq(unit.toSeq) ? unit.toSeq : null);
      if (end !== null && (best === null || end > best)) best = end;
    }
    return best;
  }

  function applyInitial(body) {
    const units = applyUpdates(unitsOf(body), updatesOf(body));
    const replaceWhole = hasUnnumbered(units);
    set({
      phase: "ready",
      rows: units,
      lastSeq: replaceWhole ? null : lastSeqOf(body, units),
      replaceWhole,
      oldestOlder: isObject(body.older) ? body.older : null,
      olderHidden: 0,
      tailHidden: hiddenOf(body),
      total: Number.isInteger(body.total) ? body.total : 0,
      terminal: body.terminal === true,
      pendingRows: null,
      newCount: 0,
      newCountExact: true,
      problem: null,
      staleSinceMs: null,
    });
    scrollRequest = true;
  }

  /**
   * Everything after the cursor, in non-overlapping pages. The first request is ALREADY bounded by
   * `afterSeq`: its range is the newest page of the interval. When that range starts after cursor+1,
   * every older page is asked with the same `afterSeq` plus `beforeSeq = that page's start`, so pages
   * never overlap. A page whose range covers cursor+1 closes the interval. Returns null when the epoch
   * moved on; a failed page throws and leaves the cursor untouched.
   *
   * No event number on the transcript (old archive): there is no cursor to page with, so the newest page
   * is returned with replace=true; the caller swaps it in whole instead of merging.
   */
  async function collectAfter(mine) {
    const replace = state.replaceWhole || state.lastSeq === null;
    const firstQuery = replace ? pageQuery() : pageQuery({ afterSeq: state.lastSeq });
    const first = await fetchPage(firstQuery);
    if (mine !== epoch) return null;
    if (first.ok !== true || !pageOk(first.body) || !hasData(first.body)) throw new Error("latest page");
    const latest = first.body;
    if (replace) {
      return {
        replace: true, pages: [latest], units: unitsOf(latest), updates: updatesOf(latest),
        hiddenFiltered: hiddenOf(latest), latest, hole: false, replaceWhole: state.replaceWhole,
      };
    }
    const pages = [latest];
    const updates = new Map();
    for (const update of updatesOf(latest)) updates.set(update.key, update);
    let earliest = pageFrom(latest);
    let connected = earliest !== null && earliest <= state.lastSeq + 1;
    while (!connected && Number.isInteger(earliest) && pages.length < ACTIVITY_CATCHUP_PAGE_MAX) {
      const result = await fetchPage(pageQuery({ afterSeq: state.lastSeq, beforeSeq: earliest }));
      if (mine !== epoch) return null;
      if (result.ok !== true || !pageOk(result.body) || !hasData(result.body)) throw new Error("catch-up page");
      pages.unshift(result.body);
      for (const update of updatesOf(result.body)) updates.set(update.key, update);
      const from = pageFrom(result.body);
      if (from === null) break;
      earliest = from;
      connected = earliest <= state.lastSeq + 1;
    }
    const units = [];
    const hole = !connected && Number.isInteger(earliest);
    // Only the part the pages did not cover is "not loaded"; the pages themselves are disjoint above it.
    if (hole) units.push(unloadedUnit(state.lastSeq + 1, earliest - 1));
    let hiddenFiltered = 0;
    for (const page of pages) {
      hiddenFiltered += hiddenOf(page);
      units.push(...unitsOf(page));
    }
    const replaceWhole = hasUnnumbered(units);
    return {
      replace: replaceWhole, pages, units, updates: [...updates.values()], hiddenFiltered, latest,
      hole: replaceWhole ? false : hole, replaceWhole,
    };
  }

  function statusOf(latest) {
    return {
      total: Number.isInteger(latest.total) ? latest.total : state.total,
      terminal: latest.terminal === true,
      problem: null,
      staleSinceMs: null,
    };
  }

  function applyFollowing({ units, latest, replace = false, updates = [], hiddenFiltered = 0, replaceWhole = false }) {
    const rows = applyUpdates(replace ? mergeUnits(units) : mergeUnits([...state.rows, ...units]), updates);
    const added = totalWeight(rows) - totalWeight(state.rows);
    set({
      phase: "ready",
      rows,
      lastSeq: replace ? null : (Math.max(state.lastSeq ?? 0, pageTo(latest) ?? 0) || null),
      replaceWhole: state.replaceWhole || replaceWhole,
      ...(replace ? { oldestOlder: isObject(latest.older) ? latest.older : null, olderHidden: 0 } : {}),
      ...statusOf(latest),
      tailHidden: replace ? hiddenFiltered : state.tailHidden + hiddenFiltered,
      pendingRows: null,
      newCount: 0,
      newCountExact: true,
    });
    if (replace || added > 0) scrollRequest = true;
  }

  function applyPaused({ units, latest, replace = false, hole = false, updates = [], hiddenFiltered = 0, replaceWhole = false }) {
    let pendingRows;
    if (replace) pendingRows = mergeUnits(units);
    else if (units.length === 0) pendingRows = state.pendingRows;
    else pendingRows = mergeUnits([...(state.pendingRows ?? state.rows), ...units]);
    if (pendingRows !== null) pendingRows = applyUpdates(pendingRows, updates);
    const nextCount = pendingRows === null ? state.newCount : Math.max(0, totalWeight(pendingRows) - totalWeight(state.rows));
    // "N+" belongs only to the pause that actually hit the cap. A marker already in the visible rows from
    // an earlier pause does not make a later, fully caught-up pause inexact.
    const startingPause = state.pendingRows === null;
    const nextExact = startingPause ? !hole : (hole ? false : state.newCountExact);
    set({
      ...statusOf(latest),
      lastSeq: replace ? null : (Math.max(state.lastSeq ?? 0, pageTo(latest) ?? 0) || null),
      replaceWhole: state.replaceWhole || replaceWhole,
      tailHidden: replace ? hiddenFiltered : state.tailHidden + hiddenFiltered,
      ...(pendingRows === null ? {} : { pendingRows, newCount: nextCount, newCountExact: nextExact }),
    });
  }

  /** One poll: the newest page after the cursor, then as many older pages as it takes to cover it. */
  function poll() {
    if (state.runId === null || state.phase === "idle" || loadingPage || loadingOlder || polling) return Promise.resolve(false);
    if (state.terminal) return Promise.resolve(false);
    polling = true;
    const mine = epoch;
    return Promise.resolve()
      .then(() => collectAfter(mine))
      .then((collected) => {
        if (collected === null) return false;
        if (state.phase !== "ready") applyInitial(collected.latest);
        else if (state.following) applyFollowing(collected);
        else applyPaused(collected);
        onChange();
        return true;
      })
      .catch(() => {
        if (mine === epoch) {
          set({ problem: "network", staleSinceMs: state.staleSinceMs ?? now() });
          onChange();
        }
        return false;
      })
      .finally(() => { polling = false; });
  }

  /** Start a fresh initial load of the current run / filter (open, filter change, reload). */
  function loadInitial(mine) {
    loadingPage = true;
    loadingOlder = false;
    Promise.resolve()
      .then(() => fetchPage(pageQuery()))
      .then((result) => result, () => ({ ok: false, reason: "network" }))
      .then((result) => {
        if (mine !== epoch) return;
        if (result.ok === true && pageOk(result.body) && hasData(result.body)) applyInitial(result.body);
        else set({ phase: "error", problem: result.ok === false ? result.reason : "server", staleSinceMs: state.staleSinceMs ?? now() });
        onChange();
      })
      .finally(() => { if (mine === epoch) loadingPage = false; });
  }

  return {
    /** Open a worker (a no-op when it already is the open one). A new epoch: older answers are dropped. */
    open(runId) {
      if (state.runId === runId && state.phase !== "idle") return false;
      epoch += 1;
      onEpoch(epoch);
      const mine = epoch;
      state = { ...IDLE, runId, epoch: mine, phase: "loading", toggled: new Map(), full: new Map() };
      loadInitial(mine);
      return true;
    },

    /** Close the worker: every answer still in flight belongs to a past epoch. */
    close() {
      if (state.runId === null) return false;
      epoch += 1;
      onEpoch(epoch);
      state = { ...IDLE, epoch, toggled: new Map(), full: new Map() };
      loadingPage = false;
      loadingOlder = false;
      polling = false;
      scrollRequest = false;
      prependAnchor = null;
      return true;
    },

    /** Another filter restarts at the latest page. */
    setFilter(filter) {
      if (!ACTIVITY_FILTERS.includes(filter) || (filter === state.filter && state.phase !== "idle")) return false;
      if (state.runId === null) return false;
      epoch += 1;
      onEpoch(epoch);
      const mine = epoch;
      state = { ...IDLE, runId: state.runId, filter, epoch: mine, phase: "loading", toggled: new Map(), full: new Map() };
      loadInitial(mine);
      return true;
    },

    /** Drop the shown stream and load the newest page again (the "not loaded" marker's way out). */
    reload() {
      if (state.runId === null) return false;
      epoch += 1;
      onEpoch(epoch);
      const mine = epoch;
      state = { ...IDLE, runId: state.runId, filter: state.filter, epoch: mine, phase: "loading", toggled: new Map(), full: new Map() };
      scrollRequest = false;
      loadInitial(mine);
      return true;
    },

    /**
     * Fetch the page above the oldest one shown (the server's own `older.beforeSeq`). `anchor` may be a
     * function: it is called when the answer is about to be applied (before the old page is inserted) and
     * its return value comes back from takePrependAnchor().
     */
    loadOlder(anchor = null) {
      if (state.phase !== "ready" || loadingOlder || loadingPage) return false;
      const older = state.oldestOlder;
      if (!isObject(older) || older.available !== true || !Number.isInteger(older.beforeSeq)) return false;
      loadingOlder = true;
      const mine = epoch;
      const beforeSeq = older.beforeSeq;
      Promise.resolve()
        .then(() => fetchPage(pageQuery({ beforeSeq })))
        .then((result) => result, () => ({ ok: false, reason: "network" }))
        .then((result) => {
          if (mine !== epoch) return;
          if (result.ok === true && pageOk(result.body) && hasData(result.body)) {
            const olderUnits = unitsOf(result.body);
            // The anchor is taken NOW, before the old page is inserted: the Owner may have scrolled
            // while the request was in flight, and the coordinate must belong to that moment.
            let currentAnchor = null;
            try {
              currentAnchor = typeof anchor === "function" ? anchor() : anchor;
            } catch {
              currentAnchor = null;
            }
            // While paused the held-back tail must keep the newly inserted older prefix too.
            const rows = mergeUnits([...olderUnits, ...state.rows]);
            const pendingRows = state.pendingRows === null ? null : mergeUnits([...olderUnits, ...state.pendingRows]);
            set({
              rows,
              ...(pendingRows === null ? {} : { pendingRows }),
              oldestOlder: isObject(result.body.older) ? result.body.older : { available: false, beforeSeq: null, reason: null },
              olderHidden: state.olderHidden + (Number.isInteger(result.body.hidden?.filtered) ? result.body.hidden.filtered : 0),
            });
            if (currentAnchor !== null && typeof currentAnchor === "object") prependAnchor = currentAnchor;
          } else {
            set({ problem: result.ok === false ? result.reason : "server", staleSinceMs: state.staleSinceMs ?? now() });
          }
          onChange();
        })
        .finally(() => { if (mine === epoch) loadingOlder = false; });
      return true;
    },

    poll,
    get: () => state,

    /** True when there is an older page the route can address. */
    canLoadOlder: () => state.phase === "ready" && isObject(state.oldestOlder) && state.oldestOlder.available === true && Number.isInteger(state.oldestOlder.beforeSeq),

    pause,
    follow,

    /** The Owner scrolled: up pauses, back at the bottom resumes. Returns true when the state changed. */
    scrolled(up) {
      return up ? pause("scroll") : follow();
    },

    /** Expand / collapse one row; expanding pauses following (the Owner is reading it). */
    toggleRow(key) {
      const row = state.rows.find((unit) => unit.key === key);
      if (row === undefined || row.row !== "event" || row.code === "ERR") return false;
      const current = state.toggled.has(key) ? state.toggled.get(key) : isDefaultOpen(row);
      const next = !current;
      const toggled = new Map(state.toggled);
      toggled.set(key, next);
      set({ toggled });
      if (next) pause("expand");
      return true;
    },

    /** Is this row open right now (default or the Owner's pick)? */
    isOpen(key) {
      const row = state.rows.find((unit) => unit.key === key);
      if (row === undefined || row.row !== "event") return false;
      return state.toggled.has(key) ? state.toggled.get(key) : isDefaultOpen(row);
    },

    /** Fetch page 1 of one row's full text ("Open full", the long-output route). */
    openFull(key) {
      const row = state.rows.find((unit) => unit.key === key);
      if (row === undefined || row.row !== "event" || row.seqState !== "ok" || !Number.isInteger(row.seq) || typeof row.part !== "string") return false;
      const mine = epoch;
      const full = new Map(state.full);
      full.set(key, { state: "loading", page: 1, totalPages: null, text: "", totalBytes: null, part: row.part, seq: row.seq });
      set({ full });
      pause("expand");
      loadFull(mine, key, row.seq, row.part, 1);
      return true;
    },

    /** Turn the page of an already opened full text. */
    fullPage(key, delta) {
      const entry = state.full.get(key);
      if (entry === undefined || entry.state === "loading") return false;
      const target = entry.page + delta;
      if (!Number.isInteger(target) || target < 1 || (entry.totalPages !== null && target > entry.totalPages)) return false;
      const full = new Map(state.full);
      full.set(key, { ...entry, state: "loading", page: target });
      set({ full });
      loadFull(epoch, key, entry.seq, entry.part, target);
      return true;
    },

    closeFull(key) {
      if (!state.full.has(key)) return false;
      const full = new Map(state.full);
      full.delete(key);
      set({ full });
      return true;
    },

    /** Take (and clear) the "go to the bottom" request set by an applied page or a resumed follow. */
    takeScrollRequest() {
      if (!scrollRequest) return false;
      scrollRequest = false;
      return true;
    },

    /** Take (and clear) the visible-row anchor of the page that was just prepended. */
    takePrependAnchor() {
      const anchor = prependAnchor;
      prependAnchor = null;
      return anchor;
    },
  };

  function loadFull(mine, key, seq, part, page) {
    Promise.resolve()
      .then(() => fetchFull({ runId: state.runId, seq, part, page }))
      .then((result) => result, () => ({ ok: false, reason: "network" }))
      .then((result) => {
        if (mine !== epoch) return;
        // The Owner may have closed this full text while the request was in flight: do not bring it back.
        if (!state.full.has(key)) return;
        const full = new Map(state.full);
        const body = result.ok === true ? result.body : null;
        if (body === null || body.runId !== state.runId || body.seq !== seq || body.part !== part
          || typeof body.text !== "string" || !Number.isInteger(body.page) || body.page !== page) {
          full.set(key, { state: "failed", page, totalPages: null, text: "", totalBytes: null, part, seq });
        } else {
          full.set(key, {
            state: "ready",
            page: body.page,
            totalPages: Number.isInteger(body.totalPages) && body.totalPages >= 1 ? body.totalPages : 1,
            text: body.text,
            totalBytes: Number.isInteger(body.totalBytes) && body.totalBytes >= 0 ? body.totalBytes : null,
            part,
            seq,
          });
        }
        set({ full });
        onChange();
      });
  }
}

/**
 * The Activity view model: what the view draws, in display order.
 *
 * @param {object} state — createActivityFeed().get()
 */
export function buildActivityView(state) {
  const rows = state.rows.map((unit) => {
    if (unit.row !== "event") return unit;
    return {
      ...unit,
      expanded: unit.code === "ERR" ? true : (state.toggled.has(unit.key) ? state.toggled.get(unit.key) : isDefaultOpen(unit)),
      full: state.full.get(unit.key) ?? null,
    };
  });
  const freshness = state.problem !== null
    ? { kind: "stale", sinceMs: state.staleSinceMs }
    : state.terminal
      ? { kind: "ended", sinceMs: null }
      : state.phase === "loading" || state.phase === "idle"
        ? { kind: "loading", sinceMs: null }
        : { kind: "polling", sinceMs: null };
  return {
    runId: state.runId,
    phase: state.phase,
    filter: state.filter,
    rows,
    following: state.following,
    pausedBy: state.pausedBy,
    newCount: state.newCount,
    newCountExact: state.newCountExact !== false,
    terminal: state.terminal,
    total: state.total,
    freshness,
    // The server's own "older" answer for the OLDEST page shown (why paging stops, when it does).
    older: state.oldestOlder,
    hiddenFiltered: state.olderHidden + state.tailHidden,
    problem: state.problem,
    lastSeq: state.lastSeq,
  };
}

/** The reference an event-code click copies: "<runId>#<seq, at least four digits>", or null without a seq. */
export const activityRef = (runId, seq) => (Number.isInteger(seq) && seq > 0 ? evidenceCode({ runId, seq }) : null);

/** The label of one event number (four digits at least), or null for a missing one. */
export const activitySeqLabel = (seq) => (Number.isInteger(seq) && seq > 0 ? `#${String(seq).padStart(4, "0")}` : null);

/** A seq range ("#0139–0171"), or a single number when both ends are the same. */
export function activityRangeLabel(fromSeq, toSeq) {
  if (!Number.isInteger(fromSeq) || !Number.isInteger(toSeq)) return null;
  const from = activitySeqLabel(fromSeq);
  const to = activitySeqLabel(toSeq);
  return from === to ? from : `${from}–${String(toSeq).padStart(4, "0")}`;
}
