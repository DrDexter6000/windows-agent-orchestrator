// src/owner-dashboard/v2/app.js
//
// Entry point of the v2 Owner dashboard (served at /v2). Wires the pieces and owns
// the page state; every decision lives in model.js / workers.js / detail.js / activity.js, every
// word in i18n.js, every DOM node in views.js / workersview.js / sidebarview.js / activityview.js,
// the token and the network in api.js, the blob URLs of delivered images in artifacts.js.
//
// Boot order: token fragment first (stored, fragment cleared), then the page
// fragment (#overview | #workers | #attention, optionally ?project=<slug> and, on
// Attention, &section=decide|anomalies; on Workers also the filters, the search and the open
// worker: &lane= &type= &status= &health= &q= &run=), then language and the "last visit"
// cut-off from localStorage, then polling.
//
// Read-only: the page only reads the /api routes (the three list routes every 5 seconds, the open
// worker's detail with them, the Activity tab's page after its cursor on the same tick while that tab is
// open and the run has not ended, and a delivered image when its tab is open) and shows them. There is
// no control that changes anything on the server.

import {
  INITIAL_NET, POLL_MS, applyCycle, buildMain, buildTopbar, endpointsFor, formatHash, parseHash, parseStoredVisit, visitWindow,
} from "./model.js";
import { LANG_STORAGE_KEY, isLang, resolveLang } from "./i18n.js";
import { readStored, writeStored } from "./store.js";
import { activityPath, artifactPath, eventPath, request, requestImage, resolveToken, workerPath } from "./api.js";
import { activeTab, buildSidebar, createDetailFeed, imagesWanted } from "./detail.js";
import { activityRef, buildActivityView, createActivityFeed } from "./activity.js";
import { createImageStore } from "./artifacts.js";
import { closesSidebar, formatWorkersHash, neighborRun, parseWorkersHash, sidebarKeyAction, workersPage } from "./workers.js";
import { addContentIn, focusCard, focusSection, renderMain, renderTopbar, selectRefText } from "./views.js";
import { renderWorkersPage } from "./workersview.js";
import { renderSidebar } from "./sidebarview.js";

const VISIT_STORAGE_KEY = "wao_v2_last_visit";
/** After a cycle whose answers came from two publications: ask again soon. */
const SKIPPED_RETRY_MS = 1000;

const freshUi = () => ({ selected: null, legacyOpen: { decide: false, anomalies: false }, resolvedOpen: false, copy: null, startingOpen: false });
/** The side panel's own state: the tab picked (null: the default of the worker's state), folds, the open image, the copy results. */
const freshSui = () => ({ tab: null, filesOpen: false, imageOpen: null, copy: null, eventCopy: null });

/** The fragment of a page: the Workers page carries its whole view state, the others page + project + section. */
const fragmentOf = (page, project, section, view) => (page === "workers" ? formatWorkersHash(view) : formatHash(page, project, section));

function boot() {
  const topbarEl = document.getElementById("topbar");
  const mainEl = document.getElementById("main");
  const sidebarEl = document.getElementById("sidebar");
  const local = () => window.localStorage;

  // 1. Token first: stored, then the fragment is cleared before anything else reads it.
  const token = resolveToken({
    hash: window.location.hash,
    getStorage: () => window.sessionStorage,
    clearFragment: () => window.history.replaceState(null, "", window.location.pathname + window.location.search),
  });

  // 2. The page fragment, canonicalized so a refresh lands on the same page.
  const fromHash = parseHash(window.location.hash);
  const fromView = parseWorkersHash(window.location.hash);
  const canonical = fragmentOf(fromHash.page, fromHash.project, fromHash.section, fromView);
  if (window.location.hash !== canonical) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search + canonical);
  }

  // 3. The "since your last visit" cut-off: fixed for this page load; this visit becomes the next one's.
  const loadedAtMs = Date.now();
  const visit = visitWindow({ storedMs: parseStoredVisit(readStored(local, VISIT_STORAGE_KEY)), nowMs: loadedAtMs });
  writeStored(local, VISIT_STORAGE_KEY, String(loadedAtMs));

  const state = {
    lang: resolveLang(readStored(local, LANG_STORAGE_KEY)),
    page: fromHash.page,
    project: fromHash.project,
    section: fromHash.section,
    // The Workers page's own state (filters, search, the open worker): it lives in the fragment too.
    view: fromView,
    // The part of Attention to land on once it is drawn (a marker / count was clicked); applied once.
    landing: fromHash.section,
    // The card to put the focus on once it is drawn (the arrow keys moved to it); applied once.
    focusRun: null,
    // The visible cards in order, from the last draw (what the arrow keys walk through).
    sequence: [],
    net: token === null ? { ...INITIAL_NET, problem: "noToken" } : INITIAL_NET,
    ui: freshUi(),
    sui: freshSui(),
  };

  // ----- the open worker: its detail, the images of its Deliverable, and the Activity stream -----
  const detail = createDetailFeed({
    fetchDetail: (runId) => (token === null ? Promise.resolve({ ok: false, reason: "unauthorized" }) : request(workerPath(runId), token)),
    onChange: () => render(),
  });
  // One controller per Activity epoch (a selection or filter change): the previous epoch's requests are
  // aborted, and the feed drops any answer that still arrives for it (A -> B -> A never shows A's past).
  let activityController = new AbortController();
  const activitySignal = () => activityController.signal;
  const activity = createActivityFeed({
    fetchPage: (query) => (token === null ? Promise.resolve({ ok: false, reason: "unauthorized" }) : request(activityPath(query), token, activitySignal())),
    fetchFull: (query) => (token === null ? Promise.resolve({ ok: false, reason: "unauthorized" }) : request(eventPath(query), token, activitySignal())),
    onEpoch: () => {
      activityController.abort();
      activityController = new AbortController();
    },
    onChange: () => render(),
  });
  const images = createImageStore({
    load: (spec) => requestImage(artifactPath({ runId: spec.runId, commit: spec.commit, fileIndex: spec.fileIndex }), token),
    createUrl: (blob) => URL.createObjectURL(blob),
    revokeUrl: (url) => URL.revokeObjectURL(url),
    onChange: () => render(),
  });

  /** The panel follows the fragment: open on the Workers page with a run, closed everywhere else. */
  function syncDetail() {
    const wanted = state.page === "workers" ? state.view.run : null;
    if (wanted === detail.get().runId) return;
    state.sui = freshSui();
    activity.close();
    if (wanted === null) detail.close();
    else detail.open(wanted);
  }

  /** True while the Activity tab is the one on screen (set by render; the poll reads it). */
  const activityShowing = () => state.activityShowing === true;

  /** Put the panel's scroll at the bottom (following) — a browser scroll, no layout change of the list. */
  function scrollActivityToBottom() {
    sidebarEl.scrollTop = Math.max(0, sidebarEl.scrollHeight - sidebarEl.clientHeight);
  }

  /** The Activity list (its stable node) or null. */
  const activityList = () => sidebarEl.querySelectorAll("[data-act-list]")[0] ?? null;

  /**
   * The row visible at the top of the panel and its viewport offset, taken before asking for an older
   * page. The row (not the request-time scrollTop) is the anchor: the Owner may keep scrolling while the
   * page is on its way.
   */
  function captureActivityAnchor() {
    const list = activityList();
    if (list === null) return null;
    const top = sidebarEl.getBoundingClientRect().top;
    for (const row of list.children) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > top + 1) {
        const rawFrom = row.getAttribute("data-range-from");
        const rawTo = row.getAttribute("data-range-to");
        const from = rawFrom === null ? null : Number(rawFrom);
        const to = rawTo === null ? null : Number(rawTo);
        return {
          key: row.getAttribute("data-act-key"),
          offset: rect.top - top,
          ...(Number.isInteger(from) && Number.isInteger(to) ? { fromSeq: from, toSeq: to } : {}),
        };
      }
    }
    return null;
  }

  /** The row the anchor became after a fold merge: exact key first, then the range that contains it. */
  function findAnchorRow(list, anchor) {
    for (const row of list.children) {
      if (row.getAttribute("data-act-key") === anchor.key) return row;
    }
    if (!Number.isInteger(anchor.fromSeq) || !Number.isInteger(anchor.toSeq)) return null;
    for (const row of list.children) {
      const rawFrom = row.getAttribute("data-range-from");
      const rawTo = row.getAttribute("data-range-to");
      const from = rawFrom === null ? null : Number(rawFrom);
      const to = rawTo === null ? null : Number(rawTo);
      if (Number.isInteger(from) && Number.isInteger(to) && from <= anchor.fromSeq && to >= anchor.toSeq) return row;
    }
    return null;
  }

  /** Put the anchored row back at the same viewport offset after older rows were inserted above it. */
  function restoreActivityAnchor(anchor) {
    if (anchor === null) return;
    const list = activityList();
    if (list === null) return;
    const row = findAnchorRow(list, anchor);
    if (row === null) return;
    const moved = row.getBoundingClientRect().top - sidebarEl.getBoundingClientRect().top - anchor.offset;
    if (moved !== 0) sidebarEl.scrollTop += moved;
  }

  /** Is `node` inside the Activity list (the only place a selection pauses following)? */
  function insideActivity(node) {
    for (let current = node; current !== null && current !== undefined; current = current.parentNode) {
      if (typeof current.className === "string" && current.className.split(" ").includes("act-list")) return true;
      if (current === sidebarEl) return false;
    }
    return false;
  }

  /** A poll that starts while an old selection's answer is still on the wire: the epoch wins. */
  function pollActivity() {
    return activityShowing() ? activity.poll().catch(() => false) : Promise.resolve(false);
  }

  function render() {
    document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
    const nowMs = Date.now();
    renderTopbar(topbarEl, buildTopbar(state.net, state.page, nowMs), state.lang, actions);
    const body = buildMain({ net: state.net, page: state.page, project: state.project, visit, nowMs });
    const loadingNow = body.page === "message" && body.kind === "loading";
    const wasLoading = state.mainLoading === true;
    let open = null;
    if (body.page === "workers") {
      const vm = workersPage(body, state.view, state.ui.startingOpen);
      state.sequence = vm.sequence;
      renderWorkersPage(mainEl, vm, state.lang, actions);
      open = vm.open;
    } else {
      state.sequence = [];
      renderMain(mainEl, body, state.lang, state.ui, actions);
      // The list has not arrived (loading, an error): a worker linked in the fragment still opens.
      if (state.page === "workers" && state.view.run !== null) open = { runId: state.view.run, note: null, project: state.view.project, seq: null };
    }
    if (wasLoading && body.page !== "message") addContentIn(mainEl);
    state.mainLoading = loadingNow;
    if (state.landing !== null && body.page === "attention" && focusSection(mainEl, state.landing)) state.landing = null;
    if (state.focusRun !== null && focusCard(mainEl, state.focusRun)) state.focusRun = null;
    const sidebar = buildSidebar({ feed: detail.get(), open, nowMs });
    // The default tab is decided ONCE, when this worker first opens: a run that ends while its Activity
    // tab is open stays there for the last batch and the "ended" line (it does not jump to Deliverable).
    if (sidebar !== null && sidebar.kind === "detail" && state.sui.tab === null) {
      state.sui = { ...state.sui, tab: sidebar.defaultTab };
    }
    const tab = sidebar !== null && sidebar.kind === "detail" ? activeTab(state.sui.tab, sidebar.defaultTab) : null;
    const wanted = imagesWanted(sidebar, tab);
    images.want(wanted);
    // The Activity tab draws (and polls) only while it is the open tab of a ready detail.
    state.activityShowing = sidebar !== null && sidebar.kind === "detail" && tab === "activity";
    const activityView = state.activityShowing ? buildActivityView(activity.get()) : null;
    const sidebarWasLoading = state.sidebarLoading === true;
    state.sidebarLoading = sidebar !== null && sidebar.kind === "message" && sidebar.message === "loading";
    renderSidebar(sidebarEl, sidebar, state.lang, state.sui, wanted, images.view(), actions, activityView);
    if (sidebarWasLoading && sidebar !== null && sidebar.kind === "detail") addContentIn(sidebarEl);
    if (state.activityShowing) {
      // The tab just became visible (or the worker just opened): load its first page.
      if (activity.get().runId !== sidebar.runId) activity.open(sidebar.runId);
      if (activity.takeScrollRequest()) scrollActivityToBottom();
      const anchor = activity.takePrependAnchor();
      if (anchor !== null) restoreActivityAnchor(anchor);
    } else {
      activity.takeScrollRequest();
      activity.takePrependAnchor();
    }
  }

  // ----- polling: one round at a time, every POLL_MS -----
  let timer = null;
  let polling = false;
  let pollAgain = false;

  function schedule(delayMs) {
    clearTimeout(timer);
    timer = setTimeout(poll, delayMs);
  }

  function pollSoon() {
    if (token === null) return;
    if (polling) pollAgain = true;
    else schedule(0);
  }

  async function poll() {
    if (token === null || polling) return;
    polling = true;
    let delayMs = POLL_MS;
    try {
      const page = state.page;
      const paths = endpointsFor(page, state.project);
      // The open worker's detail is refreshed with the lists (its own request, its own answer); the
      // Activity tab's own poll starts on the same tick (its answer renders itself) and stops itself
      // once the run has ended — the list cycle never waits for it.
      detail.refresh();
      pollActivity();
      const results = await Promise.all(paths.map((path) => request(path, token)));
      const before = state.net;
      state.net = applyCycle(before, { page, paths, results }, Date.now());
      if (state.net === before && results.every((result) => result.ok)) delayMs = SKIPPED_RETRY_MS;
      render();
    } finally {
      polling = false;
      if (pollAgain) {
        pollAgain = false;
        delayMs = 0;
      }
      schedule(delayMs);
    }
  }

  // ----- what the controls do -----
  /** Write the Workers state to the fragment: a new history entry, or (typing) the current one. */
  function writeView(next, replace = false) {
    const hash = formatWorkersHash(next);
    if (!replace) {
      window.location.hash = hash;
      return;
    }
    window.history.replaceState(null, "", window.location.pathname + window.location.search + hash);
    applyLocation();
  }
  // The fragment is the truth: two writes in a row (two arrow keys) must not both start from the state the
  // first one has not been drawn into yet.
  const baseView = () => parseWorkersHash(window.location.hash);

  const actions = {
    navigate(page, project, section = null) {
      window.location.hash = formatHash(page, project, section);
    },
    clearFilter() {
      window.location.hash = formatHash(state.page, null, null);
    },
    setLang(code) {
      if (!isLang(code) || code === state.lang) return;
      state.lang = code;
      writeStored(local, LANG_STORAGE_KEY, code);
      render();
    },
    select(id) {
      state.ui = { ...state.ui, selected: state.ui.selected === id ? null : id, copy: null };
      render();
    },
    toggleLegacy(kind) {
      state.ui = { ...state.ui, legacyOpen: { ...state.ui.legacyOpen, [kind]: !state.ui.legacyOpen[kind] } };
      render();
    },
    toggleResolved() {
      state.ui = { ...state.ui, resolvedOpen: !state.ui.resolvedOpen };
      render();
    },
    async copyRef(item) {
      let copied = false;
      try {
        await navigator.clipboard.writeText(item.ref);
        copied = true;
      } catch {
        copied = false;
      }
      state.ui = { ...state.ui, copy: { id: item.id, result: copied ? "ok" : "fail" } };
      render();
      if (!copied) selectRefText(mainEl, item.id);
    },
    // ----- Workers page and side panel -----
    setFilter(key, value) {
      writeView({ ...baseView(), [key]: value });
    },
    setQuery(value) {
      writeView({ ...baseView(), q: value }, true);
    },
    toggleStarting() {
      state.ui = { ...state.ui, startingOpen: !state.ui.startingOpen };
      render();
    },
    openWorker(runId) {
      writeView({ ...baseView(), run: runId });
    },
    closeWorker() {
      writeView({ ...baseView(), run: null });
    },
    setTab(id) {
      state.sui = { ...state.sui, tab: id };
      render();
    },
    toggleFiles() {
      state.sui = { ...state.sui, filesOpen: !state.sui.filesOpen };
      render();
    },
    toggleImage(id) {
      state.sui = { ...state.sui, imageOpen: state.sui.imageOpen === id ? null : id };
      render();
    },
    async copyWorkerRef(sidebar) {
      let copied = false;
      try {
        await navigator.clipboard.writeText(sidebar.ref);
        copied = true;
      } catch {
        copied = false;
      }
      state.sui = { ...state.sui, copy: copied ? "ok" : "fail" };
      render();
      if (!copied) selectRefText(sidebarEl, `worker:${sidebar.runId}`);
    },
    // ----- Activity tab -----
    setActivityFilter(filter) {
      if (activity.setFilter(filter)) render();
    },
    toggleActivityRow(key) {
      if (activity.toggleRow(key)) render();
    },
    openActivityFull(key) {
      if (activity.openFull(key)) render();
    },
    activityFullPage(key, delta) {
      if (activity.fullPage(key, delta)) render();
    },
    closeActivityFull(key) {
      if (activity.closeFull(key)) render();
    },
    /** The "not loaded" marker's way out: drop the shown stream and load the newest page again. */
    reloadActivity() {
      if (activity.reload()) render();
    },
    resumeActivity() {
      if (activity.follow()) render();
    },
    /** The event code copies "runId#seq"; when the clipboard refuses, the full reference is selected. */
    async copyEventCode(runId, seq, key) {
      const ref = activityRef(runId, seq);
      if (ref === null) return;
      let copied = false;
      try {
        await navigator.clipboard.writeText(ref);
        copied = true;
      } catch {
        copied = false;
      }
      state.sui = { ...state.sui, eventCopy: { key, result: copied ? "ok" : "fail", ref } };
      render();
      if (!copied) selectRefText(sidebarEl, `event-copy:${key}`);
    },
  };

  /** The fragment changed (a link, back / forward, a control that wrote it): take it over and draw. */
  function applyLocation() {
    const next = parseHash(window.location.hash);
    const nextView = parseWorkersHash(window.location.hash);
    const viewChanged = JSON.stringify(nextView) !== JSON.stringify(state.view);
    if (next.page !== state.page || next.project !== state.project || next.section !== state.section || viewChanged) {
      const pageChanged = next.page !== state.page;
      const projectChanged = next.project !== state.project;
      // Another page or another project filter starts a fresh selection; only landing elsewhere on
      // the same page keeps what is open.
      if (pageChanged || next.project !== state.project) state.ui = freshUi();
      state.page = next.page;
      state.project = next.project;
      state.section = next.section;
      state.view = nextView;
      state.landing = next.section;
      syncDetail();
      render();
      if (pageChanged) pollSoon();
      else if (projectChanged && state.page === "workers") pollSoon();
    }
  }

  window.addEventListener("hashchange", () => {
    // A new token link pasted into this tab changes only the fragment, which the browser does not
    // reload for: reload so the boot sequence takes the token and clears the fragment.
    if (window.location.hash.startsWith("#token=")) {
      window.location.reload();
      return;
    }
    applyLocation();
  });

  // The open panel: Esc closes it, the arrow keys walk the list, a click on the empty page closes it.
  document.addEventListener("keydown", (event) => {
    if (state.page !== "workers" || state.view.run === null) return;
    const target = event.target;
    const action = sidebarKeyAction({
      key: event.key,
      tag: target?.tagName ?? "",
      editable: target?.isContentEditable === true,
      alt: event.altKey,
      ctrl: event.ctrlKey,
      meta: event.metaKey,
      shift: event.shiftKey,
    });
    if (action === null) return;
    event.preventDefault();
    if (action === "close") {
      actions.closeWorker();
      return;
    }
    const next = neighborRun(state.sequence, parseWorkersHash(window.location.hash).run, action === "next" ? 1 : -1);
    if (next === null) return;
    state.focusRun = next;
    actions.openWorker(next);
  });

  document.addEventListener("click", (event) => {
    if (state.page !== "workers" || state.view.run === null) return;
    const target = event.target;
    const inside = (selector) => typeof target?.closest === "function" && target.closest(selector) !== null;
    if (closesSidebar({ inSidebar: inside("#sidebar"), inTopbar: inside("#topbar"), keep: inside("button, select, input, [data-keep]") })) actions.closeWorker();
  });

  // The Activity stream: at the bottom it follows; scrolling up pauses it and asks for the next older
  // page when the top is reached (the panel is the scroll container).
  sidebarEl.addEventListener("scroll", () => {
    if (!state.activityShowing) return;
    const atBottom = sidebarEl.scrollTop + sidebarEl.clientHeight >= sidebarEl.scrollHeight - 2;
    if (atBottom) {
      if (activity.follow()) render();
      return;
    }
    if (activity.pause("scroll")) render();
    if (sidebarEl.scrollTop <= 0 && activity.canLoadOlder()) {
      // The anchor is taken when the answer arrives (before the old page is inserted), not now.
      activity.loadOlder(() => captureActivityAnchor());
    }
  });

  // A selected line in the Activity list pauses following too (the Owner is copying something).
  document.addEventListener("selectionchange", () => {
    if (!state.activityShowing) return;
    const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
    if (selection === null || selection === undefined || selection.rangeCount === 0 || selection.isCollapsed) return;
    if (!insideActivity(selection.anchorNode)) return;
    if (activity.pause("selection")) render();
  });

  // A blob URL lives only while its image is on screen; leaving the page ends them all.
  window.addEventListener("pagehide", () => images.release());

  syncDetail();
  render();
  pollSoon();
}

boot();
