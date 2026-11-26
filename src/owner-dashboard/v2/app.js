// src/owner-dashboard/v2/app.js
//
// Entry point of the v2 Owner dashboard (served at /v2). Wires the pieces and owns
// the page state; every decision lives in model.js, every word in i18n.js, every
// DOM node in views.js, the token and the network in api.js.
//
// Boot order: token fragment first (stored, fragment cleared), then the page
// fragment (#overview | #workers | #attention, optionally ?project=<slug> and, on
// Attention, &section=decide|anomalies), then language and the "last visit" cut-off
// from localStorage, then polling.
//
// Read-only: the page only reads the three /api routes every 5 seconds and shows
// them. There is no control that changes anything on the server.

import {
  INITIAL_NET, POLL_MS, applyCycle, buildMain, buildTopbar, endpointsFor, formatHash, parseHash, parseStoredVisit, visitWindow,
} from "./model.js";
import { LANG_STORAGE_KEY, isLang, resolveLang } from "./i18n.js";
import { readStored, writeStored } from "./store.js";
import { request, resolveToken } from "./api.js";
import { focusSection, renderMain, renderTopbar, selectRefText } from "./views.js";

const VISIT_STORAGE_KEY = "wao_v2_last_visit";
/** After a cycle whose answers came from two publications: ask again soon. */
const SKIPPED_RETRY_MS = 1000;

const freshUi = () => ({ selected: null, legacyOpen: { decide: false, anomalies: false }, resolvedOpen: false, copy: null });

function boot() {
  const topbarEl = document.getElementById("topbar");
  const mainEl = document.getElementById("main");
  const local = () => window.localStorage;

  // 1. Token first: stored, then the fragment is cleared before anything else reads it.
  const token = resolveToken({
    hash: window.location.hash,
    getStorage: () => window.sessionStorage,
    clearFragment: () => window.history.replaceState(null, "", window.location.pathname + window.location.search),
  });

  // 2. The page fragment, canonicalized so a refresh lands on the same page.
  const fromHash = parseHash(window.location.hash);
  const canonical = formatHash(fromHash.page, fromHash.project, fromHash.section);
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
    // The part of Attention to land on once it is drawn (a marker / count was clicked); applied once.
    landing: fromHash.section,
    net: token === null ? { ...INITIAL_NET, problem: "noToken" } : INITIAL_NET,
    ui: freshUi(),
  };

  function render() {
    document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
    const nowMs = Date.now();
    renderTopbar(topbarEl, buildTopbar(state.net, state.page, nowMs), state.lang, actions);
    const body = buildMain({ net: state.net, page: state.page, project: state.project, visit, nowMs });
    renderMain(mainEl, body, state.lang, state.ui, actions);
    if (state.landing !== null && body.page === "attention" && focusSection(mainEl, state.landing)) state.landing = null;
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
      const paths = endpointsFor(page);
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
  };

  window.addEventListener("hashchange", () => {
    // A new token link pasted into this tab changes only the fragment, which the browser does not
    // reload for: reload so the boot sequence takes the token and clears the fragment.
    if (window.location.hash.startsWith("#token=")) {
      window.location.reload();
      return;
    }
    const next = parseHash(window.location.hash);
    if (next.page !== state.page || next.project !== state.project || next.section !== state.section) {
      const pageChanged = next.page !== state.page;
      // Another page or another project filter starts a fresh selection; only landing elsewhere on
      // the same page keeps what is open.
      if (pageChanged || next.project !== state.project) state.ui = freshUi();
      state.page = next.page;
      state.project = next.project;
      state.section = next.section;
      state.landing = next.section;
      render();
      if (pageChanged) pollSoon();
    }
  });

  render();
  pollSoon();
}

boot();
