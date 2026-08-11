// src/owner-dashboard/app.js
//
// M12-8D Package D — Owner read-only dashboard client.
// M12-17 — owner details (backend / terminal flag / activity total / scope
// summary from the SAME safe projections), selected-run retention when the run
// leaves the bounded top-100 list (absence is never reported as terminal),
// opt-in terminal notifications (explicit Owner button; the post-load baseline
// never notifies; at most once per run per page session; fixed safe fields),
// and selection-bound activity commits: a late response from a superseded
// selection is dropped silently and never mutates the current selection's facts.
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

// M12-17: the state-filter closed set — every RUN_STATES member (pending /
// submitted / running / completed / failed / aborted / timed_out) plus the
// server's "unknown" mapping. The nonexistent "stopped" state is NOT a member.
// The HTML state-filter options mirror this set exactly (test-enforced).
export const FILTER_STATES = Object.freeze([
  "pending", "submitted", "running", "completed", "failed", "aborted", "timed_out", "unknown",
]);

// Terminal run states (mirrors the transcript TERMINAL_STATES closed set) —
// client defense-in-depth for notification payloads.
const TERMINAL_RUN_STATES = Object.freeze(["completed", "failed", "aborted", "timed_out"]);
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
 * substring on runId; agent is an exact match; state applies only when it is a
 * FILTER_STATES closed-set member ("" = any; an out-of-set value — e.g. the
 * nonexistent "stopped" — is ignored, never exact-matched).
 * @param {object[]} runs
 * @param {{q?:string, state?:string, agent?:string}} f
 * @returns {object[]}
 */
export function filterRuns(runs, f = {}) {
  if (!Array.isArray(runs)) return [];
  const q = typeof f.q === "string" ? f.q.trim().toLowerCase() : "";
  const state = typeof f.state === "string" && FILTER_STATES.includes(f.state) ? f.state : "";
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

// ===== M12-17 pure helpers (DOM-free; the tested contract) =====

/**
 * The detail state-pill class for a state string, gated to FILTER_STATES.
 * Arbitrary/unparseable text collapses to "s-na" — never a class injection.
 * @param {*} state
 * @returns {string}
 */
export function statePillClass(state) {
  return (typeof state === "string" && FILTER_STATES.includes(state)) ? "s-" + state : "s-na";
}

/**
 * Resolve the LISTED run facts for the current selection, or null when the
 * selected run is temporarily outside the bounded recent list. Selection
 * retention (M12-17): the caller NEVER clears the selection on a null here —
 * the detail pane keeps refreshing from the activity poll instead.
 * @param {object[]} runs
 * @param {string|null} selectedRunId
 * @returns {object|null}
 */
export function retainSelectedRun(runs, selectedRunId) {
  if (typeof selectedRunId !== "string" || selectedRunId.length === 0) return null;
  const i = runIndex(runs, selectedRunId);
  return i >= 0 ? runs[i] : null;
}

/**
 * The detail state text: prefer the fresher activity-projection state (2s
 * poll), fall back to the listed run state (5s list refresh). Gated to the
 * closed set — an unparseable/arbitrary value collapses to null (rendered as
 * "n/a"), never a raw string.
 * @param {object|null} activity — safe activity page (or null)
 * @param {object|null} listedRun — listed run summary (or null when unlisted)
 * @returns {string|null}
 */
export function detailStateText(activity, listedRun) {
  const fromAct = activity && typeof activity.state === "string" ? activity.state : "";
  const fromList = listedRun && typeof listedRun.state === "string" ? listedRun.state : "";
  const raw = fromAct || fromList;
  return FILTER_STATES.includes(raw) ? raw : null;
}

/** Backend fact text from the safe activity projection, or "" when absent. */
export function backendFact(activity) {
  const b = activity && typeof activity.backend === "string" ? activity.backend : "";
  return b.length ? `backend ${b}` : "";
}

/**
 * Terminal/non-terminal fact text. Prefers the activity projection's terminal
 * flag; falls back to the listed run's. Neither source → "" — a missing fact
 * is never reported as terminal.
 */
export function terminalFact(activity, listedRun) {
  const t = activity && typeof activity.terminal === "boolean"
    ? activity.terminal
    : (listedRun && typeof listedRun.terminal === "boolean" ? listedRun.terminal : null);
  if (t === null) return "";
  return t ? "terminal" : "non-terminal";
}

/** Activity total fact text ("N events"), or "" when no total is available. */
export function activityTotalFact(activity) {
  const t = activity && Number.isInteger(activity.total) ? activity.total : null;
  return t === null ? "" : `${t} events`;
}

/**
 * One-line scopeObservation summary: closed-set status + counts ONLY. Never
 * echoes the outsidePaths list — counts suffice here; redacted relative paths
 * already appear per-entry in the timeline.
 * @param {object|null|undefined} obs
 * @returns {string}
 */
export function scopeObservationSummary(obs) {
  if (!obs || typeof obs !== "object") return "scope n/a";
  const observed = Number.isInteger(obs.observedFileCount) ? obs.observedFileCount : 0;
  if (obs.status === "within_declared_paths") {
    return `scope within declared paths · ${observed} observed`;
  }
  if (obs.status === "outside_declared_paths") {
    const outside = Number.isInteger(obs.outsidePathCount) ? obs.outsidePathCount : 0;
    return `scope outside declared paths · ${outside} of ${observed} observed`;
  }
  return "scope unknown";
}

/**
 * Honest Notification capability: "granted" | "denied" | "default" |
 * "unsupported" (API missing or an unexpected permission value). Used to
 * degrade quietly — never to nag.
 * @param {*} NotificationApi — window.Notification or undefined
 * @returns {string}
 */
export function notificationPermission(NotificationApi) {
  if (!NotificationApi || typeof NotificationApi.permission !== "string") return "unsupported";
  return ["granted", "denied", "default"].includes(NotificationApi.permission)
    ? NotificationApi.permission
    : "unsupported";
}

/**
 * The notify-toggle button descriptor for a (permission, enabled) pair.
 * Enabled → disabled "on" (reload resets). granted/default → clickable
 * "enable". denied/unsupported → quietly disabled.
 * @param {string} permission — from notificationPermission
 * @param {boolean} enabled
 * @returns {{disabled:boolean, label:string}}
 */
export function notifyButtonState(permission, enabled) {
  if (enabled) return { disabled: true, label: "notifications on" };
  if (permission === "granted" || permission === "default") {
    return { disabled: false, label: "enable notifications" };
  }
  if (permission === "denied") return { disabled: true, label: "notifications blocked" };
  return { disabled: true, label: "notifications n/a" };
}

/**
 * Build the fixed-safe-fields notification descriptor for a terminal run, or
 * null when the run is not notifiable (non-terminal / missing runId). The
 * state is gated to the terminal closed set (an unexpected value collapses to
 * "unknown"). The payload carries ONLY runId/agentId/state — never a path,
 * prompt, token, session, or command.
 * @param {object} run — safe run summary ({runId, agentId, state, terminal})
 * @returns {{title:string, body:string, runId:string, agentId:string, state:string}|null}
 */
export function terminalNotification(run) {
  if (!run || run.terminal !== true) return null;
  if (typeof run.runId !== "string" || run.runId.length === 0) return null;
  const state = TERMINAL_RUN_STATES.includes(run.state) ? run.state : "unknown";
  const agentId = typeof run.agentId === "string" && run.agentId.length ? run.agentId : "unknown";
  return {
    title: `run ${state} · ${agentId}`,
    body: run.runId,
    runId: run.runId,
    agentId,
    state,
  };
}

/**
 * THE terminal-transition planner (pure, page-session scoped). Folds a fresh
 * bounded runs snapshot into the observed-terminal map and returns the
 * notifications to fire:
 *   - the FIRST observation of a run (the post-load/reload baseline) records
 *     its terminal flag and NEVER notifies;
 *   - only a run previously observed NON-terminal that is now terminal
 *     notifies — exactly once (terminal is absorbing in the map);
 *   - runs absent from the snapshot keep their prior observation — absence is
 *     never treated as terminal and never resets the baseline.
 * The input map is not mutated; a new map is returned.
 *
 * @param {Object<string,boolean>} observed
 * @param {object[]} runs — safe run summaries ({runId, agentId, state, terminal})
 * @returns {{notifications: object[], observed: Object<string,boolean>}}
 */
export function planTerminalNotifications(observed, runs) {
  const prev = observed && typeof observed === "object" ? observed : {};
  const next = { ...prev };
  const notifications = [];
  if (Array.isArray(runs)) {
    for (const run of runs) {
      if (!run || typeof run.runId !== "string" || run.runId.length === 0) continue;
      const id = run.runId;
      const isTerminal = run.terminal === true;
      if (!(id in next)) {
        next[id] = isTerminal; // baseline: record, never notify
        continue;
      }
      if (next[id] === false && isTerminal) {
        next[id] = true;
        const n = terminalNotification(run);
        if (n) notifications.push(n);
      } else if (isTerminal) {
        next[id] = true; // absorbing: once terminal, never re-notifies
      }
    }
  }
  return { notifications, observed: next };
}

// ===== M12-17 race helpers — selection-bound activity commits (DOM-free) =====
//
// A selection epoch advances on every selection change. An in-flight activity
// request (bootstrap / poll / load-older) captures {runId, epoch} at issue
// time; when its response resolves it commits ONLY when BOTH still equal the
// current selection. A late response from a superseded selection is dropped
// silently — it never mutates the current selection's lastGoodActivity /
// activityFresh / timeline / detail / terminal observation, and a late fetch
// error never marks the current selection stale.

/**
 * Advance the selection to runId: bump the epoch (so every in-flight request
 * for the PREVIOUS selection becomes stale), reset the per-selection activity
 * state, and return the binding the NEW selection's bootstrap captures. Pure
 * (mutates only the given state object's selection/activity fields; no DOM).
 * @param {object} state
 * @param {string} runId
 * @returns {{runId:string, epoch:number}}
 */
export function advanceSelection(state, runId) {
  if (!state || typeof state !== "object") return { runId, epoch: 0 };
  state.selectionEpoch = (Number.isInteger(state.selectionEpoch) ? state.selectionEpoch : 0) + 1;
  state.selectedRunId = runId;
  state.timeline = [];
  state.maxSeq = 0;
  state.olderCursor = null;
  state.lastGoodActivity = null;
  state.unavailableReason = null;
  state.activityFresh = null;
  return { runId, epoch: state.selectionEpoch };
}

/**
 * The commit gate: true ONLY when the captured (runId, epoch) is still the
 * current selection. A late response (the run or the epoch no longer matches)
 * returns false and the caller MUST drop it without mutating anything.
 * @param {{selectedRunId:string|null, selectionEpoch:number}} state
 * @param {{runId:string, epoch:number}} captured
 * @returns {boolean}
 */
export function isCurrentSelection(state, captured) {
  if (!state || !captured) return false;
  if (typeof captured.runId !== "string" || captured.runId.length === 0) return false;
  if (!Number.isInteger(captured.epoch)) return false;
  if (state.selectedRunId !== captured.runId) return false;
  if (state.selectionEpoch !== captured.epoch) return false;
  return true;
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
    detailBackend: $("detail-backend"),
    detailTerminal: $("detail-terminal"),
    detailLiveness: $("detail-liveness"),
    detailTotal: $("detail-total"),
    detailScope: $("detail-scope"),
    detailUnlisted: $("detail-unlisted"),
    detailUnavailable: $("detail-unavailable"),
    refreshRun: $("refresh-run"),
    catFilters: $("cat-filters"),
    timeline: $("timeline"),
    timelineEmpty: $("timeline-empty"),
    loadOlder: $("load-older"),
    notifyToggle: $("notify-toggle"),
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
    // M12-17 selection epoch: advances on every selection change so an in-flight
    // activity request for a SUPERSEDED selection is dropped (isCurrentSelection).
    selectionEpoch: 0,
    // M12-17: opt-in notifications. notifyEnabled flips ONLY from the explicit
    // button click; observedTerminal is the per-page-session terminal map the
    // pure planner folds every runs/activity snapshot into (baseline-safe).
    notifyEnabled: false,
    observedTerminal: {},
  };

  els.app.hidden = false;
  els.unavailable.hidden = true;
  wireUi(state);
  // The toggle is revealed only with a valid session; its state reflects the
  // honest Notification capability (unsupported/denied → quietly disabled).
  els.notifyToggle.hidden = false;
  renderNotifyToggle(state);

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
  // The ONLY notification-enable path: an explicit Owner click (user gesture).
  els.notifyToggle.addEventListener("click", () => enableNotifications(state));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.selectedRunId) pollOnce(state);
  });
}

// ===== Opt-in terminal notifications (M12-17) =====
//
// Enable ONLY from the explicit Owner button click (a user gesture). The
// post-load baseline never notifies; the pure planner fires at most one
// notification per run per page session; unsupported/denied degrades quietly.

function renderNotifyToggle(state) {
  const el = state.els.notifyToggle;
  const perm = notificationPermission(typeof Notification !== "undefined" ? Notification : undefined);
  const b = notifyButtonState(perm, state.notifyEnabled);
  el.disabled = b.disabled;
  el.textContent = b.label;
}

function enableNotifications(state) {
  if (state.notifyEnabled) return;
  const perm = notificationPermission(typeof Notification !== "undefined" ? Notification : undefined);
  if (perm === "granted") {
    state.notifyEnabled = true;
    renderNotifyToggle(state);
    return;
  }
  if (perm !== "default") { renderNotifyToggle(state); return; } // denied/unsupported — quiet
  let settled = false;
  const done = (p) => {
    if (settled) return;
    settled = true;
    state.notifyEnabled = p === "granted";
    renderNotifyToggle(state);
  };
  try {
    // Called ONLY from the button click — a genuine user gesture. Handles both
    // the promise and the legacy callback form; settled guards double-firing.
    const req = Notification.requestPermission(done);
    if (req && typeof req.then === "function") req.then(done, () => done("denied"));
  } catch {
    done("denied"); // quiet degrade
  }
}

// Fire one already-planned notification. Payload fields are fixed + safe
// (title = state · agentId; body/tag = runId). tag dedups at the platform
// level; renotify stays off. Any failure degrades quietly.
function fireNotification(n) {
  if (typeof Notification === "undefined") return;
  if (notificationPermission(Notification) !== "granted") return;
  try {
    new Notification(n.title, { body: n.body, tag: n.runId, renotify: false });
  } catch { /* quiet degrade */ }
}

// Feed the selected run's activity-page terminal fact into the SAME planner
// (the activity page carries runId/agentId/state/terminal). Keeps the
// observation current even while the selected run is outside the bounded runs
// list. An unavailable page contributes nothing — absence is not terminal.
// Called ONLY for the current selection (the race gate has already dropped any
// late response from a superseded selection).
function observeActivityTerminal(state, page) {
  if (!page || page.available === false || !page.activity) return;
  const act = page.activity;
  if (typeof act.runId !== "string" || act.runId.length === 0) return;
  const plan = planTerminalNotifications(state.observedTerminal, [{
    runId: act.runId, agentId: act.agentId, state: act.state, terminal: act.terminal,
  }]);
  state.observedTerminal = plan.observed;
  if (state.notifyEnabled) for (const n of plan.notifications) fireNotification(n);
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
    // Terminal-transition observation (M12-17): the pure planner folds the new
    // list into the per-session observed map. The map updates whether or not
    // notifications are enabled (enabling later never fires a backlog), the
    // post-load baseline never notifies, and absence from the bounded list is
    // never treated as terminal.
    const plan = planTerminalNotifications(state.observedTerminal, state.runs);
    state.observedTerminal = plan.observed;
    if (state.notifyEnabled) for (const n of plan.notifications) fireNotification(n);
    renderAgentFilter(state);
    renderRunList(state);
    // Selection retention (M12-17): a selected run that falls out of the
    // bounded list STAYS selected — the detail keeps refreshing via the
    // activity poll, and "not in the list" is never reported as terminal.
    if (state.selectedRunId) renderDetail(state);
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
  span.className = "state-pill " + statePillClass(state);
  span.textContent = typeof state === "string" && state.length ? state : "n/a";
  return span;
}

// ===== Selection + activity =====

function selectRun(state, runId) {
  if (state.selectedRunId === runId) return;
  advanceSelection(state, runId);
  renderRunList(state);
  bootstrapActivity(state);
}

async function bootstrapActivity(state, opts = {}) {
  const runId = state.selectedRunId;
  if (!runId) return;
  // M12-17 race binding: capture the selection at issue time. If the Owner
  // selects another run while this read is in flight, the late response is
  // dropped — it must NEVER mutate the current selection's facts or freshness.
  const captured = { runId, epoch: state.selectionEpoch };
  try {
    const page = await fetchJson(
      state.token,
      `/api/activity?runId=${encodeURIComponent(runId)}&order=desc&pageSize=50`,
    );
    if (!isCurrentSelection(state, captured)) return; // late — drop, never mutate
    applyBootstrapPage(state, page);
    observeActivityTerminal(state, page);
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
    if (!isCurrentSelection(state, captured)) return; // late error — drop, never mark stale
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
  // M12-17 race binding: the snapshot (afterSeq + every cursor page) belongs to
  // THIS selection. A selection change mid-snapshot drops the whole poll — a
  // late page never mutates the current selection's timeline/freshness.
  const captured = { runId, epoch: state.selectionEpoch };
  const params = pollParams(state.maxSeq);
  try {
    // Every page in this snapshot — page 1 and each cursor continuation — is
    // built by pollRequestUrl so it carries the SAME afterSeq + order=asc
    // binding. A cursor follow can no longer drop afterSeq and widen the
    // "seq > afterSeq" view page 1 established.
    let url = pollRequestUrl(runId, params, null);
    let page = await fetchJson(state.token, url);
    if (!isCurrentSelection(state, captured)) return; // late — drop, never mutate
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
      if (!isCurrentSelection(state, captured)) return; // late mid-snapshot — drop
      applyPollPage(state, page);
      guard += 1;
    }
    observeActivityTerminal(state, page);
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
    if (!isCurrentSelection(state, captured)) return; // late error — drop, never mark stale
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
  const runId = state.selectedRunId;
  if (!runId || !state.olderCursor) return;
  // M12-17 race binding: a selection change while loading older drops the
  // late page — it never mutates the current selection's timeline/cursor.
  const captured = { runId, epoch: state.selectionEpoch };
  try {
    const url = `/api/activity?runId=${encodeURIComponent(runId)}`
      + `&cursor=${encodeURIComponent(state.olderCursor)}&order=desc`;
    const page = await fetchJson(state.token, url);
    if (!isCurrentSelection(state, captured)) return; // late — drop, never mutate
    if (page && page.available !== false && page.activity) {
      const older = chronological(Array.isArray(page.activity.entries) ? page.activity.entries : []);
      state.timeline = trimOldest(older.concat(state.timeline), TIMELINE_CAP);
      state.olderCursor = (typeof page.activity.nextCursor === "string" && page.activity.nextCursor.length)
        ? page.activity.nextCursor : null;
      renderDetail(state);
    }
  } catch (err) {
    if (!isCurrentSelection(state, captured)) return; // late error — drop, never mark stale
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

  // Selection retention (M12-17): listed facts resolve via the pure helper; an
  // unlisted (but still selected) run yields null — never a terminal claim.
  const listed = retainSelectedRun(state.runs, state.selectedRunId);
  const page = state.lastGoodActivity;
  const act = page && page.available !== false && page.activity ? page.activity : null;
  els.detailRunid.textContent = state.selectedRunId;

  // Facts — ONLY the safe /api/runs + /api/activity projection fields. The
  // activity poll (2s) is fresher than the runs list (5s); listed facts are
  // the fallback while activity is loading/stale or the run is unlisted.
  const stateText = detailStateText(act, listed);
  els.detailState.textContent = "";
  els.detailState.className = "state-pill";
  els.detailState.classList.add(statePillClass(stateText));
  els.detailState.textContent = stateText || "n/a";
  els.detailAgent.textContent = (act && typeof act.agentId === "string" && act.agentId)
    || (listed && typeof listed.agentId === "string" ? listed.agentId : "");
  els.detailBackend.textContent = backendFact(act);
  els.detailTerminal.textContent = terminalFact(act, listed);
  els.detailTotal.textContent = activityTotalFact(act);
  els.detailScope.textContent = act ? scopeObservationSummary(act.scopeObservation) : "";

  // Liveness (safe shape only)
  const live = page && page.liveness;
  els.detailLiveness.textContent = live ? livenessDescription(live) : "";

  // Retention is explicit: a selected run outside the bounded list keeps
  // refreshing — say so instead of implying it vanished.
  if (!listed) {
    els.detailUnlisted.hidden = false;
    els.detailUnlisted.textContent = "not in the recent runs list — still refreshing";
  } else {
    els.detailUnlisted.hidden = true;
    els.detailUnlisted.textContent = "";
  }

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
