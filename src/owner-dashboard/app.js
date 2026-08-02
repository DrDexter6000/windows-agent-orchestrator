// src/owner-dashboard/app.js
//
// M12-8D Package D — Owner read-only dashboard client.
//
// A zero-dependency browser module. It renders a bounded, read-only view of
// recent runs + selected-run activity by calling the SAME ownerDashboardServer
// HTTP boundary (which reuses the single application SSOTs). It performs NO
// control action, holds NO second parser/classifier/redactor, and renders ONLY
// the safe API fields.
//
// TOKEN DISCIPLINE (hard contract):
//   - The bearer arrives ONLY in the URL fragment (#token=<64hex>).
//   - On boot it is moved to sessionStorage, the fragment is cleared immediately
//     (history.replaceState), and it is NEVER written to the DOM, a log, or an
//     error message. It is sent ONLY as `Authorization: Bearer <token>` to /api/*.
//   - Missing/invalid token → a concise unavailable state (no API calls).
//
// The module is structured so the pure data helpers (below) are exported and
// DOM-free: they are unit-tested directly. The browser bootstrap runs ONLY when
// a DOM is present, so importing this module under node:test is safe.

// ===== Closed sets (mirror the server-side safe contract; client defense-in-depth) =====

export const CATEGORIES = Object.freeze([
  "message", "command", "tool_use", "tool_result", "file_written", "runtime_status", "state", "other",
]);

// Bounded timeline window. Live polling appends newest entries and trims oldest
// beyond this cap; loading older history is bounded by the same cap.
export const TIMELINE_CAP = 500;
export const POLL_MS = 2000;
export const RUNS_REFRESH_MS = 5000;
export const RUNS_LIMIT = 100;
const TOKEN_KEY = "wao_owner_token";
const TOKEN_RE = /^[0-9a-f]{64}$/;

// ===== Pure helpers (DOM-free; the tested contract) =====

/**
 * Validate a bearer token shape: exactly 64 lowercase hex chars.
 * @param {string} t
 * @returns {boolean}
 */
export function isValidToken(t) {
  return typeof t === "string" && TOKEN_RE.test(t);
}

/**
 * Parse the bearer from a location.hash string. Accepts "#token=<64hex>" (the
 * fragment may carry nothing else). Returns the token or null. Never throws.
 * @param {string} hash
 * @returns {string|null}
 */
export function parseTokenFromHash(hash) {
  if (typeof hash !== "string" || hash.length === 0) return null;
  const m = hash.match(/^#token=([0-9a-f]{64})$/);
  return m ? m[1] : null;
}

/**
 * Build the single Authorization header value. The token is used ONLY here.
 * @param {string} token
 * @returns {string}
 */
export function authorizationHeader(token) {
  return "Bearer " + token;
}

/**
 * A stable identity key for an activity entry, used to dedup across overlapping
 * fetches (bootstrap desc + asc polls can overlap). seq alone is not unique when
 * entries lack an integer seq (mapped to 0); category+ts disambiguates.
 * @param {object} e
 * @returns {string}
 */
export function entryKey(e) {
  const seq = Number.isInteger(e && e.seq) ? e.seq : 0;
  const cat = typeof (e && e.category) === "string" ? e.category : "?";
  const ts = typeof (e && e.ts) === "string" ? e.ts : "";
  return `${seq}|${cat}|${ts}`;
}

/**
 * Sort a copy of entries chronologically (ascending by seq; stable for ties).
 * Non-integer seq is treated as 0. The input array is not mutated.
 * @param {object[]} entries
 * @returns {object[]}
 */
export function chronological(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((e) => ({ e, s: Number.isInteger(e && e.seq) ? e.seq : 0 }))
    .sort((a, b) => (a.s - b.s) || (entryKey(a.e) < entryKey(b.e) ? -1 : 1))
    .map((x) => x.e);
}

/**
 * Highest integer seq in the entries, or 0 if none. Drives afterSeq polling.
 * @param {object[]} entries
 * @returns {number}
 */
export function highestSeq(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return 0;
  let max = 0;
  for (const e of entries) if (Number.isInteger(e && e.seq) && e.seq > max) max = e.seq;
  return max;
}

/**
 * Merge incoming entries into existing, dropping duplicates (by entryKey) and
 * returning a chronological array. Used to append newer activity on each poll.
 * Bounds-conscious callers trim the result with trimOldest.
 * @param {object[]} existing
 * @param {object[]} incoming
 * @returns {object[]}
 */
export function appendNewer(existing, incoming) {
  const ex = Array.isArray(existing) ? existing : [];
  const inc = Array.isArray(incoming) ? incoming : [];
  const seen = new Set(ex.map(entryKey));
  const merged = ex.slice();
  for (const e of inc) {
    const k = entryKey(e);
    if (!seen.has(k)) { seen.add(k); merged.push(e); }
  }
  return chronological(merged);
}

/**
 * Keep the newest `cap` entries (chronological), dropping the oldest. Caps the
 * timeline to a bounded window.
 * @param {object[]} entries
 * @param {number} cap
 * @returns {object[]}
 */
export function trimOldest(entries, cap) {
  const arr = chronological(entries);
  if (!Number.isInteger(cap) || cap <= 0 || arr.length <= cap) return arr;
  return arr.slice(arr.length - cap);
}

/**
 * Project ONE activity entry to a safe render descriptor, reading ONLY the known
 * safe keys for its category. This is client-side defense-in-depth: even if the
// server already redacted, the client never touches token/credential/prompt/raw
// command/absolute path/PID/provider session/unknown payload.
 * @param {object} entry
 * @returns {{category:string, ts:string, body:string, mono:boolean}}
 */
export function describeEntry(entry) {
  const e = entry || {};
  const cat = CATEGORIES.includes(e.category) ? e.category : "other";
  const ts = typeof e.ts === "string" ? e.ts : "";
  let body = "";
  let mono = false;
  switch (cat) {
    case "message": {
      const role = typeof e.role === "string" && e.role.length ? e.role : "message";
      const text = typeof e.text === "string" ? e.text : "";
      const trunc = e.truncated === true ? " …[truncated]" : "";
      body = `${role}: ${text}${trunc}`;
      break;
    }
    case "command": {
      const status = ["ok", "failed", "unknown"].includes(e.exitStatus) ? e.exitStatus : "unknown";
      body = `command · exit ${status}`;
      mono = true;
      break;
    }
    case "tool_use": {
      const tool = typeof e.tool === "string" && e.tool.length ? e.tool : "unknown";
      body = `tool · ${tool}`;
      mono = true;
      break;
    }
    case "tool_result": {
      body = `tool result · ${e.isError === true ? "error" : "ok"}`;
      mono = true;
      break;
    }
    case "file_written": {
      const path = typeof e.path === "string" && e.path.length ? e.path : "[path_withheld]";
      body = `wrote · ${path}`;
      mono = true;
      break;
    }
    case "runtime_status": {
      const labels = {
        initialized: "initialized",
        streaming: "streaming",
        provider_retry: "provider retry",
      };
      body = `runtime · ${labels[e.status] ?? "unknown"}`;
      break;
    }
    case "state": {
      const to = typeof e.to === "string" && e.to.length ? e.to : "unknown";
      body = `state → ${to}`;
      break;
    }
    default: {
      // `other` never echoes raw type/kind — only the closed-set label.
      body = typeof e.label === "string" && e.label.length ? e.label : "[unknown_event]";
      break;
    }
  }
  return { category: cat, ts, body, mono };
}

/**
 * Render-safe liveness text from the safe liveness shape. Relative age only;
 * never PID/path/session/absolute time.
 * @param {{ownerHeartbeat:string, secondsSinceHeartbeat:number|null}} live
 * @returns {string}
 */
export function livenessDescription(live) {
  if (!live || typeof live !== "object") return "liveness n/a";
  const hb = live.ownerHeartbeat;
  const sec = live.secondsSinceHeartbeat;
  if (hb === "fresh") return `liveness fresh · ${formatSec(sec)}`;
  if (hb === "stale") return `liveness stale · ${formatSec(sec)}`;
  return "liveness n/a";
}

function formatSec(sec) {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec < 0) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

/**
 * Index of a runId in the run list (exact match), or -1.
 * @param {object[]} runs
 * @param {string} runId
 * @returns {number}
 */
export function runIndex(runs, runId) {
  if (!Array.isArray(runs) || typeof runId !== "string") return -1;
  for (let i = 0; i < runs.length; i += 1) if (runs[i] && runs[i].runId === runId) return i;
  return -1;
}

/**
 * Client-side run filters over the bounded recent list. q is a case-insensitive
 * substring on runId; state/agent are exact matches ("" = any).
 * @param {object[]} runs
 * @param {{q?:string, state?:string, agent?:string}} f
 * @returns {object[]}
 */
export function filterRuns(runs, f = {}) {
  if (!Array.isArray(runs)) return [];
  const q = typeof f.q === "string" ? f.q.trim().toLowerCase() : "";
  const state = typeof f.state === "string" ? f.state : "";
  const agent = typeof f.agent === "string" ? f.agent : "";
  return runs.filter((r) => {
    if (!r || typeof r.runId !== "string") return false;
    if (q && !r.runId.toLowerCase().includes(q)) return false;
    if (state && r.state !== state) return false;
    if (agent && r.agentId !== agent) return false;
    return true;
  });
}

/**
 * Filter timeline entries by an enabled-category set. An empty/missing set means
 * "all categories".
 * @param {object[]} entries
 * @param {Set<string>} enabled
 * @returns {object[]}
 */
export function filterByCategories(entries, enabled) {
  if (!Array.isArray(entries)) return [];
  if (!enabled || enabled.size === 0) return entries;
  return entries.filter((e) => e && enabled.has(e.category));
}

/**
 * Build the visible-poll query params: only entries newer than maxSeq, ascending.
 * @param {number} maxSeq
 * @returns {{afterSeq:number, order:"asc"}}
 */
export function pollParams(maxSeq) {
  return { afterSeq: Number.isInteger(maxSeq) && maxSeq > 0 ? maxSeq : 0, order: "asc" };
}

/**
 * Build the URL for ONE page of a live-poll snapshot. EVERY page in the same
 * snapshot — page 1 and each cursor continuation — carries the IDENTICAL
 * afterSeq + order=asc binding that pollParams(maxSeq) established for that
 * snapshot. Dropping afterSeq on a continuation page would let older entries
 * (seq <= afterSeq) leak into a view page 1 filtered to seq > afterSeq — a
 * cursor view/filter mismatch.
 *
 * Page 1 also carries pageSize=50 (the continuation loop's full-page threshold).
 * Continuation pages carry only the cursor + the snapshot binding; pageSize is
 * intentionally omitted there so a cursor read uses the same server default as
 * before (only afterSeq is added — the fix), leaving paging behavior unchanged.
 *
 * @param {string} runId
 * @param {{afterSeq:number, order:string}} params  snapshot binding (from pollParams)
 * @param {string|null} [cursor]                    continuation cursor, or null/"" for page 1
 * @returns {string}
 */
export function pollRequestUrl(runId, params, cursor) {
  const afterSeq = (params && Number.isInteger(params.afterSeq) && params.afterSeq > 0) ? params.afterSeq : 0;
  const rid = encodeURIComponent(runId);
  const base = `/api/activity?runId=${rid}&afterSeq=${afterSeq}&order=asc`;
  if (cursor && typeof cursor === "string" && cursor.length) {
    return `${base}&cursor=${encodeURIComponent(cursor)}`;
  }
  return `${base}&pageSize=50`;
}

/**
 * Aggregate the dashboard status from TWO independent freshness signals — the
 * runs list (runsFresh) and the selected-run activity (activityFresh) — plus the
 * token/session state. This is the pure state machine the polling + runs-refresh
 * surface reduces to (via setStatus) before it touches the DOM.
 *
 * The separation is load-bearing (M12-8): a failed or unavailable activity read
 * (activityFresh === false) keeps the last-good evidence visibly stale and
 * CANNOT be healed by a successful runs-list refresh, which owns only runsFresh.
 * A subsequent successful activity read (activityFresh === true) may restore
 * "live". activityFresh === null means "no selection / loading" — neither stale
 * nor live, so selecting a run never flashes a false "refresh failed".
 *
 * State coverage: normal (both fresh), loading (activityFresh null), error
 * (either source === false), and stale-data-plus-error (one fresh, one stale).
 * "missing"/"unparseable" reduce to the error branch: a non-available payload is
 * treated as activityFresh === false, and an unparseable response throws →
 * onFetchError → activityFresh === false.
 *
 * @param {{runsFresh?:boolean, activityFresh?:boolean|null, sessionEnded?:boolean, runSelected?:boolean}} s
 * @returns {{stale:boolean, text:string}}
 */
export function deriveStatus(s) {
  const st = s || {};
  if (st.sessionEnded) {
    return { stale: true, text: "session ended — reopen from CLI" };
  }
  const runsStale = st.runsFresh === false;
  // Activity freshness is meaningful only while a run is selected.
  const activityStale = st.runSelected === true && st.activityFresh === false;
  if (runsStale || activityStale) {
    return { stale: true, text: "refresh failed — showing last view" };
  }
  if (st.runSelected === true && st.activityFresh === true) {
    return { stale: false, text: "live" };
  }
  return { stale: false, text: "connected" };
}

/**
 * Relative age label ("now", "12s", "3m", "2h", "—") from an ISO updatedAt and a
 * current epoch-ms. Pure (clock injected) for deterministic tests.
 * @param {string|null|undefined} updatedAt
 * @param {number} nowMs
 * @returns {string}
 */
export function relativeAge(updatedAt, nowMs) {
  if (typeof updatedAt !== "string" || updatedAt.length === 0) return "—";
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return "—";
  const base = Number.isFinite(nowMs) ? nowMs : Date.now();
  let d = Math.max(0, Math.round((base - t) / 1000));
  if (d < 5) return "now";
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.round(d / 60)}m`;
  if (d < 86400) return `${Math.round(d / 3600)}h`;
  return `${Math.round(d / 86400)}d`;
}

// ===== Browser bootstrap (runs ONLY with a DOM present) =====

if (typeof document !== "undefined" && typeof window !== "undefined") {
  // Defer to DOMContentLoaded so all elements above are parsed.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { boot(); }, { once: true });
  } else {
    boot();
  }
}

function $(id) { return document.getElementById(id); }

function boot() {
  const token = resolveToken();
  const els = {
    app: $("app"),
    unavailable: $("unavailable"),
    statusLine: $("status-line"),
    search: $("search"),
    stateFilter: $("state-filter"),
    agentFilter: $("agent-filter"),
    runList: $("run-list"),
    runsEmpty: $("runs-empty"),
    noSelection: $("no-selection"),
    detail: $("detail"),
    detailRunid: $("detail-runid"),
    detailState: $("detail-state"),
    detailAgent: $("detail-agent"),
    detailLiveness: $("detail-liveness"),
    detailUnavailable: $("detail-unavailable"),
    refreshRun: $("refresh-run"),
    catFilters: $("cat-filters"),
    timeline: $("timeline"),
    timelineEmpty: $("timeline-empty"),
    loadOlder: $("load-older"),
  };

  if (!isValidToken(token)) {
    showUnavailable(els);
    return;
  }

  const state = {
    token,
    els,
    nowMs: () => Date.now(),
    runs: [],
    selectedRunId: null,
    timeline: [],
    maxSeq: 0,
    olderCursor: null,
    enabledCats: new Set(),
    filters: { q: "", state: "", agent: "" },
    lastGoodActivity: null,
    unavailableReason: null,
    // Two INDEPENDENT freshness signals (M12-8): a runs-list refresh owns only
    // runsFresh, the selected-run poll owns only activityFresh. Neither heals the
    // other; deriveStatus (via setStatus) aggregates them into the visible status.
    runsFresh: true,
    activityFresh: null,
    sessionEnded: false,
  };

  els.app.hidden = false;
  els.unavailable.hidden = true;
  wireUi(state);

  refreshRuns(state);
  state.runsTimer = setInterval(() => refreshRuns(state), RUNS_REFRESH_MS);
  startPolling(state);
}

// Move the token fragment → sessionStorage, clear the fragment, return token.
// The token string is NEVER placed in the DOM, a log, or an error here.
function resolveToken() {
  try {
    const fromHash = parseTokenFromHash(window.location.hash);
    if (fromHash) {
      try { sessionStorage.setItem(TOKEN_KEY, fromHash); } catch { /* storage disabled */ }
      // Immediately clear the fragment so the token is not retained in the
      // address bar / session history. Path+search never carry the token.
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      return fromHash;
    }
    const stored = sessionStorage.getItem(TOKEN_KEY);
    if (isValidToken(stored)) return stored;
  } catch { /* no storage / no location */ }
  return null;
}

function showUnavailable(els) {
  if (els.app) els.app.hidden = true;
  if (els.unavailable) els.unavailable.hidden = false;
  if (els.statusLine) {
    els.statusLine.textContent = "unavailable";
    els.statusLine.classList.remove("live");
    els.statusLine.classList.add("stale");
  }
}

function wireUi(state) {
  const els = state.els;
  els.search.addEventListener("input", () => {
    state.filters.q = els.search.value;
    renderRunList(state);
  });
  els.stateFilter.addEventListener("change", () => {
    state.filters.state = els.stateFilter.value;
    renderRunList(state);
  });
  els.agentFilter.addEventListener("change", () => {
    state.filters.agent = els.agentFilter.value;
    renderRunList(state);
  });
  els.refreshRun.addEventListener("click", () => bootstrapActivity(state, { force: true }));
  els.loadOlder.addEventListener("click", () => loadOlder(state));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.selectedRunId) pollOnce(state);
  });
}

// ===== Run list =====

async function refreshRuns(state) {
  try {
    const data = await fetchJson(state.token, `/api/runs?limit=${RUNS_LIMIT}`);
    state.runs = data && Array.isArray(data.runs) ? data.runs : [];
    // Runs-list freshness owns ONLY runsFresh + sessionEnded. It must NOT touch
    // activityFresh: a successful runs refresh cannot heal a failed/unavailable
    // activity read (M12-8 separation). A 200 also proves the token still works.
    state.runsFresh = true;
    state.sessionEnded = false;
    renderAgentFilter(state);
    renderRunList(state);
    // Preserve selection unless the selected run is gone.
    if (state.selectedRunId && runIndex(state.runs, state.selectedRunId) < 0) {
      state.selectedRunId = null;
      state.timeline = [];
      state.maxSeq = 0;
      state.olderCursor = null;
      renderDetail(state);
    }
    setStatus(state);
  } catch (err) {
    onFetchError(state, err, "runs");
    renderRunList(state);
  }
}

function renderAgentFilter(state) {
  const sel = state.els.agentFilter;
  const current = state.filters.agent;
  const ids = Array.from(new Set(state.runs.map((r) => r && r.agentId).filter((a) => typeof a === "string" && a))).sort();
  // Rebuild options preserving selection when still present.
  sel.textContent = "";
  sel.appendChild(option("", "all"));
  for (const id of ids) sel.appendChild(option(id, id));
  sel.value = ids.includes(current) ? current : "";
  state.filters.agent = sel.value;
}

function option(value, label) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

function renderRunList(state) {
  const ul = state.els.runList;
  const filtered = filterRuns(state.runs, state.filters);
  ul.textContent = "";
  if (filtered.length === 0) {
    state.els.runsEmpty.hidden = false;
    return;
  }
  state.els.runsEmpty.hidden = true;
  for (const r of filtered) ul.appendChild(runRow(state, r));
}

function runRow(state, r) {
  const li = document.createElement("li");
  li.className = "run-row";
  if (r.runId === state.selectedRunId) li.classList.add("selected");
  li.setAttribute("role", "listitem");
  li.dataset.runId = r.runId;

  const rid = document.createElement("span");
  rid.className = "rid";
  rid.textContent = r.runId;

  const meta = document.createElement("span");
  meta.className = "meta";
  const pill = statePill(r.state);
  const ago = document.createElement("span");
  ago.className = "ago";
  ago.textContent = relativeAge(r.updatedAt, state.nowMs());
  meta.appendChild(pill);
  if (typeof r.agentId === "string" && r.agentId.length) {
    const a = document.createElement("span");
    a.textContent = r.agentId;
    meta.appendChild(a);
  }
  meta.appendChild(ago);

  li.appendChild(rid);
  li.appendChild(meta);
  li.addEventListener("click", () => selectRun(state, r.runId));
  return li;
}

function statePill(state) {
  const span = document.createElement("span");
  span.className = "state-pill s-" + (typeof state === "string" && state.length ? state : "na");
  span.textContent = typeof state === "string" && state.length ? state : "n/a";
  return span;
}

// ===== Selection + activity =====

function selectRun(state, runId) {
  if (state.selectedRunId === runId) return;
  state.selectedRunId = runId;
  state.timeline = [];
  state.maxSeq = 0;
  state.olderCursor = null;
  state.lastGoodActivity = null;
  state.unavailableReason = null;
  state.activityFresh = null;
  renderRunList(state);
  bootstrapActivity(state);
}

async function bootstrapActivity(state, opts = {}) {
  const runId = state.selectedRunId;
  if (!runId) return;
  try {
    const page = await fetchJson(
      state.token,
      `/api/activity?runId=${encodeURIComponent(runId)}&order=desc&pageSize=50`,
    );
    applyBootstrapPage(state, page);
    // Activity freshness follows THIS read's availability: available:false keeps
    // the evidence visibly stale/unavailable; an available read restores live.
    if (page && page.available !== false) {
      state.activityFresh = true;
      state.sessionEnded = false;
    } else {
      state.activityFresh = false;
    }
    renderDetail(state);
    setStatus(state);
  } catch (err) {
    onFetchError(state, err, "activity");
    renderDetail(state);
  }
}

function applyBootstrapPage(state, page) {
  if (!page || page.available === false) {
    state.lastGoodActivity = null;
    state.unavailableReason = (page && typeof page.unavailableReason === "string") ? page.unavailableReason : "unavailable";
    state.timeline = [];
    state.maxSeq = 0;
    state.olderCursor = null;
    return;
  }
  const act = page.activity;
  state.lastGoodActivity = page;
  state.unavailableReason = null;
  const entries = chronological(act && Array.isArray(act.entries) ? act.entries : []);
  state.timeline = trimOldest(entries, TIMELINE_CAP);
  state.maxSeq = highestSeq(state.timeline);
  state.olderCursor = (act && typeof act.nextCursor === "string" && act.nextCursor.length) ? act.nextCursor : null;
}

// ===== Visible polling (2s, afterSeq+asc; pause hidden / resume immediately) =====

function startPolling(state) {
  state.pollTimer = setInterval(() => { pollOnce(state); }, POLL_MS);
}

async function pollOnce(state) {
  // Pause while hidden; visibilitychange resumes immediately on focus.
  if (document.hidden) return;
  const runId = state.selectedRunId;
  if (!runId) return;
  const params = pollParams(state.maxSeq);
  try {
    // Every page in this snapshot — page 1 and each cursor continuation — is
    // built by pollRequestUrl so it carries the SAME afterSeq + order=asc
    // binding. A cursor follow can no longer drop afterSeq and widen the
    // "seq > afterSeq" view page 1 established.
    let url = pollRequestUrl(runId, params, null);
    let page = await fetchJson(state.token, url);
    applyPollPage(state, page);
    // Follow cursors mechanically while a full page indicates more new entries
    // may exist — bounded by a small safety counter so a burst can't loop.
    let guard = 0;
    while (page && page.activity && typeof page.activity.nextCursor === "string"
      && page.activity.nextCursor.length
      && Array.isArray(page.activity.entries) && page.activity.entries.length >= 50
      && guard < 4) {
      url = pollRequestUrl(runId, params, page.activity.nextCursor);
      page = await fetchJson(state.token, url);
      applyPollPage(state, page);
      guard += 1;
    }
    // Activity freshness follows the read's availability: available:false keeps
    // the last-good evidence visibly stale/unavailable; an available read is live.
    if (page && page.available !== false) {
      state.activityFresh = true;
      state.sessionEnded = false;
    } else {
      state.activityFresh = false;
    }
    renderDetail(state);
    setStatus(state);
  } catch (err) {
    onFetchError(state, err, "activity");
    renderDetail(state);
  }
}

function applyPollPage(state, page) {
  if (!page || page.available === false) {
    // Not readable now — keep last good snapshot + stale indicator.
    state.unavailableReason = (page && typeof page.unavailableReason === "string") ? page.unavailableReason : null;
    return;
  }
  const act = page.activity;
  if (!act) return;
  state.lastGoodActivity = page;
  state.unavailableReason = null;
  const incoming = Array.isArray(act.entries) ? act.entries : [];
  state.timeline = trimOldest(appendNewer(state.timeline, incoming), TIMELINE_CAP);
  state.maxSeq = highestSeq(state.timeline);
}

async function loadOlder(state) {
  if (!state.olderCursor || !state.selectedRunId) return;
  try {
    const url = `/api/activity?runId=${encodeURIComponent(state.selectedRunId)}`
      + `&cursor=${encodeURIComponent(state.olderCursor)}&order=desc`;
    const page = await fetchJson(state.token, url);
    if (page && page.available !== false && page.activity) {
      const older = chronological(Array.isArray(page.activity.entries) ? page.activity.entries : []);
      state.timeline = trimOldest(older.concat(state.timeline), TIMELINE_CAP);
      state.olderCursor = (typeof page.activity.nextCursor === "string" && page.activity.nextCursor.length)
        ? page.activity.nextCursor : null;
      renderDetail(state);
    }
  } catch (err) {
    onFetchError(state, err, "activity");
    renderDetail(state);
  }
}

// ===== Error handling: preserve last good snapshot + stale indicator =====

function onFetchError(state, err, source) {
  if (err && err.code === "unauthorized") {
    // Token invalid/revoked → session ended. Keep last view + concise note; the
    // token itself is never surfaced.
    state.sessionEnded = true;
  }
  // Mark ONLY the failing source not-fresh: a runs-list error touches runsFresh,
  // an activity error touches activityFresh. The two never heal each other
  // (M12-8 separation); deriveStatus aggregates them into the visible status.
  if (source === "runs") state.runsFresh = false;
  else state.activityFresh = false; // "activity" (poll / bootstrap / loadOlder)
  setStatus(state);
}

// ===== Render: detail =====

function renderDetail(state) {
  const els = state.els;
  if (!state.selectedRunId) {
    els.detail.hidden = true;
    els.noSelection.hidden = false;
    return;
  }
  els.detail.hidden = false;
  els.noSelection.hidden = true;

  const run = (state.runs.find((r) => r && r.runId === state.selectedRunId)) || null;
  els.detailRunid.textContent = state.selectedRunId;

  // Facts
  els.detailState.textContent = "";
  els.detailState.className = "state-pill";
  if (run) {
    els.detailState.classList.add("s-" + (typeof run.state === "string" && run.state.length ? run.state : "na"));
    els.detailState.textContent = run.state || "n/a";
  } else {
    els.detailState.classList.add("s-na");
    els.detailState.textContent = "n/a";
  }
  els.detailAgent.textContent = run && typeof run.agentId === "string" ? run.agentId : "";

  // Liveness (safe shape only)
  const live = state.lastGoodActivity && state.lastGoodActivity.liveness;
  els.detailLiveness.textContent = live ? livenessDescription(live) : "";

  // Unavailable reason (closed set, never raw)
  if (state.unavailableReason) {
    els.detailUnavailable.hidden = false;
    els.detailUnavailable.textContent = `run ${state.unavailableReason}`;
  } else {
    els.detailUnavailable.hidden = true;
    els.detailUnavailable.textContent = "";
  }

  renderCategoryChips(state);
  renderTimeline(state);

  els.loadOlder.hidden = !state.olderCursor;
}

function renderCategoryChips(state) {
  const wrap = state.els.catFilters;
  const counts = (state.lastGoodActivity && state.lastGoodActivity.activity
    && state.lastGoodActivity.activity.counts) || {};
  wrap.textContent = "";
  for (const cat of CATEGORIES) {
    const n = Number.isInteger(counts[cat]) ? counts[cat] : 0;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (state.enabledCats.has(cat) ? " on" : "");
    chip.dataset.cat = cat;
    const label = document.createElement("span");
    label.textContent = `${cat}`;
    const num = document.createElement("span");
    num.className = "n";
    num.textContent = ` ${n}`;
    chip.appendChild(label);
    chip.appendChild(num);
    chip.addEventListener("click", () => {
      if (state.enabledCats.has(cat)) state.enabledCats.delete(cat);
      else state.enabledCats.add(cat);
      renderCategoryChips(state);
      renderTimeline(state);
    });
    wrap.appendChild(chip);
  }
}

function renderTimeline(state) {
  const ol = state.els.timeline;
  const view = filterByCategories(state.timeline, state.enabledCats);
  ol.textContent = "";
  if (view.length === 0) {
    state.els.timelineEmpty.hidden = false;
    return;
  }
  state.els.timelineEmpty.hidden = true;
  for (const e of view) ol.appendChild(timelineRow(e));
}

function timelineRow(entry) {
  const d = describeEntry(entry);
  const li = document.createElement("li");
  li.className = "tl-row";
  li.setAttribute("role", "listitem");

  const ts = document.createElement("span");
  ts.className = "tl-ts";
  ts.textContent = shortTs(d.ts);

  const cat = document.createElement("span");
  cat.className = "tl-cat";
  cat.textContent = d.category;

  const body = document.createElement("span");
  body.className = "tl-body" + (d.mono ? " mono" : "");
  body.textContent = d.body; // textContent only — never innerHTML

  li.appendChild(ts);
  li.appendChild(cat);
  li.appendChild(body);
  return li;
}

// Render a compact, relative-ish timestamp from the safe ts string. Shows only
// the time portion when ISO; never reveals anything beyond the server-provided ts.
function shortTs(ts) {
  if (typeof ts !== "string" || ts.length === 0) return "—";
  // ISO-like: keep up to the seconds fragment (YYYY-MM-DDTHH:MM:SS) if present.
  const m = ts.match(/(\d{4}-\d{2}-\d{2})?[T ]?(\d{2}:\d{2}:\d{2})?/);
  if (m && m[2]) return m[2];
  return ts.slice(0, 19);
}

function setStatus(state) {
  // The visible status is the pure aggregation of the two independent freshness
  // signals (deriveStatus) — never re-derived ad hoc at a call site, so a runs
  // refresh can never overwrite a stale/unavailable activity read.
  const { stale, text } = deriveStatus(state);
  const el = state.els.statusLine;
  el.classList.toggle("stale", stale);
  el.classList.toggle("live", !stale && text === "live");
  el.textContent = stale ? text : (text || "connected");
}

// ===== HTTP: Authorization header only; fixed safe errors, never token =====

async function fetchJson(token, path) {
  let res;
  try {
    res = await fetch(path, { headers: { authorization: authorizationHeader(token) }, redirect: "error" });
  } catch (e) {
    throw tagged("network", e);
  }
  if (res.status === 401) throw tagged("unauthorized", null);
  if (!res.ok) throw tagged("bad_response", null);
  try {
    return await res.json();
  } catch (e) {
    throw tagged("bad_response", e);
  }
}

function tagged(code, _e) {
  // The error carries ONLY a closed-set code; never the token, path, or raw text.
  const err = new Error(code);
  err.code = code;
  return err;
}
