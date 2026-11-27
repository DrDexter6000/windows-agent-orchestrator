// src/owner-dashboard/v2/model.js
//
// Everything the v2 dashboard decides, as pure functions: no DOM, no globals, no
// network. Importable from Node (the tests do exactly that). The DOM code in
// views.js and app.js only draws what these return.
//
// The server already redacted and bounded every text; nothing here rewrites worker
// text. Times are epoch-ms numbers (null when the server value is unreadable), and
// "now" for every duration is the publication's own generatedAt, so the numbers on
// screen belong to one moment even while the data is stale.
//
// Language never enters here: the view models are language-free data, the views
// pick the words (i18n.js). That is also why a language switch cannot change a
// filter, a selection or an expansion.

import { workersPath } from "./api.js";

export const POLL_MS = 5000;
export const PAGES = Object.freeze(["overview", "workers", "attention"]);
export const DEFAULT_PAGE = "overview";
export const DAY_MS = 86_400_000;
/** Attention items older than this fold into one "older" group per section. */
export const LEGACY_AFTER_MS = 7 * DAY_MS;
/** "Since your last visit" counts at most this far back (the server lists only this much). */
export const VISIT_WINDOW_MS = DAY_MS;
/** An item row lists at most this many workers; the rest is a "+N more" count. */
export const WORKER_LIST_MAX = 5;
/** A publication older than this (by its own generatedAt) reads as stale, even while the server keeps answering. */
export const STALE_AFTER_MS = 30_000;
/** A commit is shown as its first this-many hex digits. */
export const COMMIT_SHORT_LENGTH = 8;

export const TASK_TYPES = Object.freeze(["research", "code", "test", "plan_review", "delivery_review", "image", "untyped"]);
const RUNNING_STATES = new Set(["pending", "submitted", "running"]);
const STATUSES = new Set(["loading", "ready", "stale", "unavailable"]);
/** Alerts, most severe first (quota exhausted blocks dispatch). A kind outside the list ranks last. */
export const ALERT_SEVERITY = Object.freeze(["quota_exhausted", "failed", "silent", "process_only", "rate_limited"]);
export const ATTENTION_SECTIONS = Object.freeze(["decide", "anomalies"]);
const LANE_KINDS = new Set(["quota_exhausted", "rate_limited"]);

const PROJECT_SLUG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const PROJECT_SLUG_MAX = 128;

// ===== small helpers =====

const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const text = (value) => (typeof value === "string" && value.length > 0 ? value : null);

/** ISO string -> epoch ms; anything unreadable -> null. */
export function msOf(value) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

const openAndUnknown = (counts) => num(counts?.open) + num(counts?.unknown);

/** Ascending compare of two nullable numbers, null last. */
function ascNullLast(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/** Descending compare of two nullable numbers, null last. */
function descNullLast(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ===== page fragment =====

export function isValidProject(value) {
  return typeof value === "string" && value.length <= PROJECT_SLUG_MAX && PROJECT_SLUG_RE.test(value);
}

/**
 * "#attention?project=shop-api&section=decide" -> { page, project, section }.
 * An unknown or missing page is the Overview. A project filter counts on the Workers and
 * Attention pages (and only with the slug shape); a landing section (decide | anomalies,
 * the red / amber part of Attention) only on Attention. The query starts at the first "?" or
 * "&" ("#workers&project=x" reads like "#workers?project=x"); the rest of the Workers state
 * (lane, type, status, health, search, the open run) is workers.js's parseWorkersHash.
 */
export function parseHash(hash) {
  let raw = typeof hash === "string" ? hash : "";
  if (raw.startsWith("#")) raw = raw.slice(1);
  const cut = raw.search(/[?&]/);
  const name = cut < 0 ? raw : raw.slice(0, cut);
  const query = cut < 0 ? "" : raw.slice(cut + 1);
  const page = PAGES.includes(name) ? name : DEFAULT_PAGE;
  let project = null;
  let section = null;
  if (page !== "overview" && PAGES.includes(name)) {
    const params = new URLSearchParams(query);
    const candidate = params.get("project");
    if (isValidProject(candidate)) project = candidate;
    const landing = params.get("section");
    if (page === "attention" && ATTENTION_SECTIONS.includes(landing)) section = landing;
  }
  return { page, project, section };
}

/** The canonical fragment of a page (+ its project filter and landing section). */
export function formatHash(page, project = null, section = null) {
  const name = PAGES.includes(page) ? page : DEFAULT_PAGE;
  const parts = [];
  if (name !== "overview" && isValidProject(project)) parts.push(`project=${encodeURIComponent(project)}`);
  if (name === "attention" && ATTENTION_SECTIONS.includes(section)) parts.push(`section=${section}`);
  return parts.length === 0 ? `#${name}` : `#${name}?${parts.join("&")}`;
}
// ===== what each page reads =====

const PATHS_BY_PAGE = Object.freeze({
  overview: Object.freeze(["/api/overview", "/api/workers"]),
  attention: Object.freeze(["/api/overview", "/api/attention", "/api/workers"]),
});

/**
 * The read routes a page polls. Every page includes /api/overview: the top bar counts come from it.
 * The Workers page reads the rows (narrowed to one project by the server when the project filter is set,
 * so the row cap applies to that project alone) and the attention items its rows point at. The path IS
 * the key of the retained body: data fetched for another project is never mistaken for this one's.
 */
export function endpointsFor(page, project = null) {
  if (page === "workers") return ["/api/overview", workersPath(isValidProject(project) ? project : null), "/api/attention"];
  return PATHS_BY_PAGE[PAGES.includes(page) ? page : DEFAULT_PAGE];
}

// ===== counts =====

/** Needs you / Alerts: open + unknown items of the whole run directory (never filtered). */
export function topbarCounts(overview) {
  const counts = overview?.counts;
  if (counts === null || typeof counts !== "object") return null;
  return { needsYou: openAndUnknown(counts.decide), alerts: openAndUnknown(counts.anomalies) };
}

/** red / amber only while the count is above zero; zero (or no data) is gray. */
export function countTone(kind, n) {
  if (!Number.isFinite(n) || n <= 0) return "gray";
  return kind === "needsYou" ? "red" : "amber";
}

// ===== one polling cycle -> what the page may show =====

/**
 * The page state:
 *   pages          page -> { generatedAt, bodies }: the last COMPLETE, consistent cycle of that
 *                  page. Kept when the page is left and when the server goes away, so a page seen
 *                  before still shows (marked stale) after a disconnect.
 *   failingSinceMs the first failed cycle of the current failure streak (null: not failing)
 *   serverStale    { sinceMs } while the server itself says "stale" / "unavailable", else null
 *   problem        the last problem seen: unauthorized | network | server | unavailable | noToken
 *                  | codeExpired (145b: the one-time start code did not redeem), or null
 * Freshness is NOT stored: freshnessOf derives it from this and the clock.
 */
export const INITIAL_NET = Object.freeze({
  pages: Object.freeze({}),
  failingSinceMs: null,
  serverStale: null,
  problem: null,
});

/** A body is usable only when its shape is what the page reads (the server contract). */
function shapeOk(path, body) {
  if (body === null || typeof body !== "object" || !STATUSES.has(body.status)) return false;
  if (body.status === "loading" || body.status === "unavailable") return true;
  const route = path.split("?")[0];
  if (route === "/api/overview") {
    return body.counts !== null && typeof body.counts === "object" && Array.isArray(body.projects) && Array.isArray(body.lanes);
  }
  if (route === "/api/workers") return Array.isArray(body.workers);
  if (route === "/api/attention") return Array.isArray(body.decide) && Array.isArray(body.anomalies) && Array.isArray(body.resolved);
  return false;
}

const FAILURE_ORDER = ["unauthorized", "network", "server"];

/** A failed cycle: keep every page's last data; the failure streak starts at its FIRST failure. */
function failedCycle(prev, reason, nowMs) {
  return { ...prev, failingSinceMs: prev.failingSinceMs ?? nowMs, problem: reason };
}

/**
 * Fold one polling cycle of `page` into the state.
 *
 * A cycle is the answers of every route the page reads, taken together: the page's data is
 * replaced only when ALL of them came back with data from the SAME publication (equal
 * generatedAt), so the numbers of one screen always agree. Otherwise:
 *   - any request failed (or sent an unusable body): keep every page's last data and start
 *     (or continue) the failure streak;
 *   - the server is "loading" / "unavailable": nothing new to show (the streak ends: the
 *     server answered);
 *   - the answers came from two different publications: return `prev` unchanged (the caller
 *     sees the identical object and retries soon). Staleness is still judged by the age of
 *     the data (freshnessOf), so a loop of mismatches cannot look healthy forever.
 *
 * @param {object} prev — the state (see INITIAL_NET)
 * @param {{page: string, paths: string[], results: Array<{ok: boolean, body?: object, reason?: string}>}} cycle
 * @param {number} nowMs — the client clock at the end of the cycle
 */
export function applyCycle(prev, { page, paths, results }, nowMs) {
  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    const reason = FAILURE_ORDER.find((candidate) => failures.some((f) => f.reason === candidate)) ?? "server";
    return failedCycle(prev, reason, nowMs);
  }
  const bodies = results.map((result) => result.body);
  for (let i = 0; i < bodies.length; i += 1) {
    if (!shapeOk(paths[i], bodies[i])) return failedCycle(prev, "server", nowMs);
  }
  const unavailable = bodies.find((body) => body.status === "unavailable");
  if (unavailable !== undefined) {
    const sinceMs = msOf(unavailable.staleSince) ?? prev.serverStale?.sinceMs ?? nowMs;
    return { ...prev, failingSinceMs: null, serverStale: { sinceMs }, problem: "unavailable" };
  }
  if (bodies.some((body) => body.status === "loading")) return { ...prev, failingSinceMs: null, problem: null };
  const generatedAt = bodies[0].generatedAt;
  if (typeof generatedAt !== "string" || bodies.some((body) => body.generatedAt !== generatedAt)) return prev;
  const stale = bodies.find((body) => body.status === "stale");
  return {
    pages: { ...prev.pages, [page]: { generatedAt, bodies: Object.fromEntries(paths.map((path, i) => [path, bodies[i]])) } },
    failingSinceMs: null,
    serverStale: stale === undefined ? null : { sinceMs: msOf(stale.staleSince) ?? msOf(generatedAt) },
    problem: null,
  };
}

/** The newest retained publication across all pages (what the top bar counts come from), or null. */
export function latestGeneration(net) {
  let best = null;
  let bestMs = -Infinity;
  for (const generation of Object.values(net.pages)) {
    const ms = msOf(generation.generatedAt) ?? -Infinity;
    if (best === null || ms > bestMs) {
      best = generation;
      bestMs = ms;
    }
  }
  return best;
}

/**
 * What the freshness label says, derived from the state and the clock. With a `page` it judges the data
 * that page SHOWS (its own retained publication), not the newest one anywhere:
 *   loading  nothing shown yet            idle  no token, nothing will load
 *   stale    the first moment it went stale (sinceMs; null when it cannot be told)
 *   polling  fresh
 * Stale when ANY of: requests are failing (since the first failure); the server says stale /
 * unavailable (since its staleSince); the newest publication is older than STALE_AFTER_MS by its
 * own generatedAt (since generatedAt + STALE_AFTER_MS — the same snapshot coming back again and
 * again is stale too); the publication time is unreadable. With several, the earliest moment wins.
 */
export function freshnessOf(net, nowMs, page = null) {
  const latest = latestGeneration(net);
  if (latest === null) return { kind: net.problem === "noToken" ? "idle" : "loading", sinceMs: null };
  const shown = page === null ? null : net.pages[page] ?? null;
  const generation = shown ?? latest;
  const marks = [];
  let stale = false;
  if (net.failingSinceMs !== null) {
    stale = true;
    marks.push(net.failingSinceMs);
  }
  if (net.serverStale !== null) {
    stale = true;
    if (net.serverStale.sinceMs !== null) marks.push(net.serverStale.sinceMs);
  }
  const generatedMs = msOf(generation.generatedAt);
  if (generatedMs === null) stale = true;
  else if (nowMs - generatedMs > STALE_AFTER_MS) {
    stale = true;
    marks.push(generatedMs + STALE_AFTER_MS);
  }
  // The shown page is older than a publication another page already received: what is on screen is outdated
  // from the moment that newer publication existed, until this page gets its own cycle.
  const latestMs = msOf(latest.generatedAt);
  if (shown !== null && generatedMs !== null && latestMs !== null && generatedMs < latestMs) {
    stale = true;
    marks.push(latestMs);
  }
  return stale ? { kind: "stale", sinceMs: marks.length === 0 ? null : Math.min(...marks) } : { kind: "polling", sinceMs: null };
}

// ===== "since your last visit" =====

/** The stored last-visit value ("1764150000000") -> epoch ms, or null when it is not one. */
export function parseStoredVisit(raw) {
  if (typeof raw !== "string" || !/^[0-9]{1,16}$/.test(raw)) return null;
  const ms = Number(raw);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}

/**
 * The cut-off for "since your last visit": the visit read when the page opened, fixed for the whole
 * page load (polling never moves it). A readable earlier visit (not in the future) is the cut-off;
 * otherwise the last 24 hours before the page opened (kind "first").
 * The 24-hour limit is NOT applied here: the server lists only the last 24 hours of finished work
 * (plus unresolved deliveries of any age), so what can be counted is limited per PUBLICATION —
 * buildOverview takes the later of this cut-off and `generatedAt - 24h` on every round.
 */
export function visitWindow({ storedMs, nowMs }) {
  if (typeof storedMs === "number" && Number.isFinite(storedMs) && storedMs > 0 && storedMs <= nowMs) {
    return { kind: "visit", cutoffMs: storedMs };
  }
  return { kind: "first", cutoffMs: nowMs - VISIT_WINDOW_MS };
}
// ===== Overview =====

const isRunningRow = (row) => RUNNING_STATES.has(row?.state);

/** Finished / failed / stopped from `fromMs` on, from the Workers rows. */
function countSince(rows, fromMs) {
  const out = { finished: 0, failed: 0, stopped: 0 };
  for (const row of rows) {
    const at = msOf(row?.terminalAt);
    if (at === null || at < fromMs) continue;
    if (row.state === "completed") out.finished += 1;
    else if (row.state === "failed" || row.state === "timed_out") out.failed += 1;
    else if (row.state === "aborted") out.stopped += 1;
  }
  return out;
}

/** One row per task type of a project's running workers. */
function typeRowsOf(runningRows, refMs) {
  const groups = new Map();
  for (const row of runningRows) {
    const type = TASK_TYPES.includes(row.taskType) ? row.taskType : "untyped";
    let group = groups.get(type);
    if (group === undefined) {
      group = { type, count: 0, lanes: new Set(), longestMs: null, starting: 0, unhealthy: [], consults: new Map() };
      groups.set(type, group);
    }
    group.count += 1;
    // Seats: each review group once (its summary comes from the server, not from the rows listed).
    const consult = row.consult;
    if (consult !== null && typeof consult === "object" && typeof consult.groupId === "string"
      && Number.isFinite(consult.seatsIn) && Number.isFinite(consult.seatsTotal)) {
      group.consults.set(consult.groupId, { in: consult.seatsIn, total: consult.seatsTotal });
    }
    const lane = text(row.laneKey);
    if (lane !== null) group.lanes.add(lane);
    const startedMs = msOf(row.startedAt);
    if (startedMs !== null) {
      const age = Math.max(0, refMs - startedMs);
      if (group.longestMs === null || age > group.longestMs) group.longestMs = age;
    }
    if (row.stage === "starting") group.starting += 1;
    if (row.liveness === "silent" || row.liveness === "process_only") {
      const quietMs = msOf(row.quietSince);
      group.unhealthy.push({
        runId: row.runId,
        health: row.liveness,
        ageMs: quietMs === null ? null : Math.max(0, refMs - quietMs),
      });
    }
  }
  const out = [...groups.values()].map((group) => ({
    type: group.type,
    count: group.count,
    lanes: [...group.lanes].sort(byText),
    longestMs: group.longestMs,
    starting: group.starting,
    // "N of M seats in" over the review groups this row is waiting on; null without any group record.
    seats: group.consults.size === 0
      ? null
      : [...group.consults.values()].reduce((sum, c) => ({ in: sum.in + c.in, total: sum.total + c.total }), { in: 0, total: 0 }),
    unhealthy: group.unhealthy.sort((a, b) => descNullLast(a.ageMs, b.ageMs) || byText(a.runId, b.runId)),
  }));
  // Rows with an unhealthy worker first, then the longest running, then the fixed type order.
  return out.sort((a, b) => (Number(b.unhealthy.length > 0) - Number(a.unhealthy.length > 0))
    || descNullLast(a.longestMs, b.longestMs)
    || (TASK_TYPES.indexOf(a.type) - TASK_TYPES.indexOf(b.type)));
}

function blockOf(project, rows, refMs) {
  const counts = project.counts ?? {};
  const running = rows.filter(isRunningRow);
  const idle = num(counts.running) === 0;
  let activityMs = null;
  if (idle) {
    for (const row of rows) {
      const at = msOf(row?.terminalAt);
      if (at !== null && (activityMs === null || at > activityMs)) activityMs = at;
    }
  } else {
    for (const row of running) {
      const at = msOf(row.lastEffectAt) ?? msOf(row.startedAt);
      if (at !== null && (activityMs === null || at > activityMs)) activityMs = at;
    }
  }
  return {
    slug: project.slug,
    name: text(project.name) ?? project.slug,
    decide: openAndUnknown(counts.decide),
    anomalies: openAndUnknown(counts.anomalies),
    idle,
    runningCount: num(counts.running),
    typeRows: idle ? [] : typeRowsOf(running, refMs),
    // Idle only: how long ago the latest of its listed runs finished (null: none listed).
    lastFinishedAgoMs: idle && activityMs !== null ? Math.max(0, refMs - activityMs) : null,
    activityMs,
  };
}

/**
 * PRD §2: projects with something that needs you first, then those with alerts, then by the most
 * recent real progress, newest first. Projects with the same marks are never separated by being idle:
 * an idle project with items is ordered by its progress like a running one. Only projects with NEITHER
 * mark sink — the idle ones as one line at the bottom.
 */
export function compareBlocks(a, b) {
  // After the first two terms a and b have the same marks, so one of them being marked means both are.
  const marked = a.decide > 0 || a.anomalies > 0;
  return (Number(b.decide > 0) - Number(a.decide > 0))
    || (Number(b.anomalies > 0) - Number(a.anomalies > 0))
    || (marked ? 0 : Number(a.idle) - Number(b.idle))
    || descNullLast(a.activityMs, b.activityMs)
    || byText(a.slug, b.slug);
}

/**
 * The Overview view model. `overview` and `workers` are the two response bodies of
 * one publication; `refMs` is its generatedAt in ms; `visit` is visitWindow(...).
 */
export function buildOverview({ overview, workers }, { refMs, visit }) {
  const counts = overview.counts ?? {};
  const projects = Array.isArray(overview.projects) ? overview.projects : [];
  const lanes = Array.isArray(overview.lanes) ? overview.lanes : [];
  const rows = Array.isArray(workers?.workers) ? workers.workers : [];
  const truncated = workers?.truncated === true;

  const bySlug = new Map();
  for (const row of rows) {
    const slug = row?.project?.slug;
    if (typeof slug !== "string") continue;
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug).push(row);
  }

  const starting = num(counts.starting);
  const windowStartMs = refMs - VISIT_WINDOW_MS;
  const throttled = lanes
    .filter((lane) => lane?.capacity !== null && lane?.capacity !== undefined && typeof lane.laneKey === "string")
    .map((lane) => ({
      laneKey: lane.laneKey,
      quota: lane.capacity.kind === "quota_exhausted",
      observedAtMs: msOf(lane.capacity.observedAt),
    }));

  const blocks = projects
    .filter((project) => typeof project?.slug === "string")
    .map((project) => blockOf(project, bySlug.get(project.slug) ?? [], refMs))
    .sort(compareBlocks);

  return {
    headline: { projects: blocks.length, running: Math.max(0, num(counts.running) - starting), starting },
    // Counting starts at the later of the visit read at load and THIS publication's generatedAt - 24h, so the
    // window slides with every round: a delivery the list keeps past 24 hours leaves the count when it turns 24h
    // old. A visit that has fallen out of that window is flagged (the text says only the last 24h are counted);
    // "ago" follows the publication. The Workers list is capped: when it was cut, the counts are a lower bound.
    since: {
      kind: visit.kind,
      truncated: visit.kind === "visit" && visit.cutoffMs < windowStartMs,
      agoMs: visit.kind === "visit" ? Math.max(0, refMs - visit.cutoffMs) : null,
      lowerBound: truncated,
      ...countSince(rows, Math.max(visit.cutoffMs, windowStartMs)),
    },
    truncated,
    blocks,
    lanes: throttled.length === 0
      ? null
      : { inUse: lanes.filter((lane) => num(lane?.running) > 0).length, throttled },
  };
}

// ===== Attention =====

/**
 * The code of one piece of evidence: "<runId>#<seq, 4+ digits>"; the bare runId when no event
 * number is known (seq absent or not a positive integer — never a made-up one).
 */
export function evidenceCode(entry) {
  const runId = text(entry?.runId);
  if (runId === null) return null;
  return Number.isInteger(entry.seq) && entry.seq > 0 ? `${runId}#${String(entry.seq).padStart(4, "0")}` : runId;
}

/**
 * The reference an Owner pastes to the Lead: the item id plus its evidence codes.
 * Language never enters, so both languages copy the identical string.
 */
export function refOf(item) {
  const codes = [...new Set((Array.isArray(item?.evidence) ? item.evidence : []).map(evidenceCode).filter((code) => code !== null))];
  return codes.length > 0 ? `${item.id} [${codes.join(" ")}]` : String(item.id);
}

/**
 * The workers an item involves: the runs it hangs on (runIds — for a split review the reviewed run)
 * plus, for a split review, ALL of its seat runs (seatRunIds). De-duplicated, runIds first.
 */
const involvedOf = (item) => new Set([
  ...(Array.isArray(item.runIds) ? item.runIds : []),
  ...(Array.isArray(item.seatRunIds) ? item.seatRunIds : []),
].filter((id) => typeof id === "string"));

/** Needs you: more involved workers first, then the longer lasting (earlier since), then id. */
export function compareDecide(a, b) {
  return (b.involved - a.involved) || ascNullLast(a.sinceMs, b.sinceMs) || byText(a.id, b.id);
}

const severityRank = (kind) => {
  const index = ALERT_SEVERITY.indexOf(kind);
  return index < 0 ? ALERT_SEVERITY.length : index;
};

/**
 * Alerts: those whose follow-up is not RUNNING first (no follow-up, an unknown one, or one that
 * already failed / stopped: none of those is a disposition in progress), then severity, then the
 * longer lasting, then id.
 */
export function compareAnomalies(a, b) {
  return (Number(a.followUpRunning) - Number(b.followUpRunning))
    || (severityRank(a.kind) - severityRank(b.kind))
    || ascNullLast(a.sinceMs, b.sinceMs)
    || byText(a.id, b.id);
}

function itemOf(raw, section, rowsById, projectNames, refMs) {
  const runIds = [...involvedOf(raw)];
  const workers = runIds.slice(0, WORKER_LIST_MAX).map((runId) => {
    const row = rowsById.get(runId);
    return { runId, title: text(row?.title) ?? text(row?.subtitle), lane: text(row?.laneKey) };
  });
  const sinceMs = msOf(raw.since);
  const resolvedAtMs = msOf(raw.resolvedAt);
  const laneItem = LANE_KINDS.has(raw.kind);
  const followUpRuns = (Array.isArray(raw.followUpRuns) ? raw.followUpRuns : [])
    .filter((entry) => entry !== null && typeof entry === "object" && text(entry.runId) !== null)
    .map((entry) => ({ runId: entry.runId, state: text(entry.state) }));
  return {
    id: String(raw.id),
    section,
    kind: String(raw.kind),
    state: raw.state === "unknown" ? "unknown" : raw.state === "resolved" ? "resolved" : "open",
    headline: laneItem ? text(raw.laneKey) : workers[0]?.title ?? null,
    // Projects by NAME for display; the slug stays the filter key.
    projects: (Array.isArray(raw.projectSlugs) ? raw.projectSlugs : [])
      .filter((slug) => typeof slug === "string")
      .map((slug) => ({ slug, name: projectNames.get(slug) ?? slug })),
    // Delivery items only: the short commit; null = unknown; undefined (key absent) = not a delivery item.
    commit: raw.commit === undefined ? undefined : shortCommit(raw.commit),
    involved: runIds.length,
    workers,
    moreWorkers: Math.max(0, runIds.length - workers.length),
    sinceMs,
    durationMs: sinceMs === null ? null : Math.max(0, refMs - sinceMs),
    resolution: text(raw.resolution),
    resolvedAgoMs: resolvedAtMs === null ? null : Math.max(0, refMs - resolvedAtMs),
    resolvedAtMs,
    laneKey: text(raw.laneKey),
    capacityCode: text(raw.capacityCode),
    // failed items: exists | none | unknown, plus the follow-up runs with their current state.
    followUp: raw.followUp === "exists" || raw.followUp === "none" || raw.followUp === "unknown" ? raw.followUp : null,
    followUpRuns,
    followUpRunning: followUpRuns.some((entry) => RUNNING_STATES.has(entry.state)),
    failure: raw.failure !== null && typeof raw.failure === "object"
      ? { category: text(raw.failure.category), code: text(raw.failure.code) }
      : null,
    evidence: (Array.isArray(raw.evidence) ? raw.evidence : [])
      .map((entry) => ({ code: evidenceCode(entry), atMs: msOf(entry?.at), hasSeq: Number.isInteger(entry?.seq) && entry.seq > 0 }))
      .filter((entry) => entry.code !== null),
    ref: refOf(raw),
  };
}

/** The first COMMIT_SHORT_LENGTH hex digits of a commit id; anything else is unknown (null). */
export const shortCommit = (value) => (typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value) ? value.slice(0, COMMIT_SHORT_LENGTH) : null);

/** Split a sorted section into the recent items and the ones older than seven days. */
function foldLegacy(items) {
  const legacy = [];
  const recent = [];
  for (const item of items) (item.durationMs !== null && item.durationMs > LEGACY_AFTER_MS ? legacy : recent).push(item);
  return { items: recent, legacy, total: items.length };
}

/**
 * The Attention view model. `project` (or null) filters what is listed; it never
 * touches the top-bar counts (those come from the Overview body). `projectNames` maps slug -> name.
 */
export function buildAttention({ attention, workers, projectNames = new Map() }, { refMs, project }) {
  const rows = Array.isArray(workers?.workers) ? workers.workers : [];
  const rowsById = new Map(rows.map((row) => [row?.runId, row]));
  const inProject = (raw) => project === null || (Array.isArray(raw.projectSlugs) && raw.projectSlugs.includes(project));
  const objects = (list) => list.filter((entry) => entry !== null && typeof entry === "object");
  const listOf = (rawList, section, compare) => foldLegacy(
    objects(rawList).filter(inProject).map((raw) => itemOf(raw, section, rowsById, projectNames, refMs)).sort(compare),
  );
  const resolved = objects(attention.resolved)
    .filter(inProject)
    .map((raw) => itemOf(raw, "resolved", rowsById, projectNames, refMs))
    .sort((a, b) => descNullLast(a.resolvedAtMs, b.resolvedAtMs) || byText(a.id, b.id));
  return {
    decide: listOf(attention.decide, "decide", compareDecide),
    anomalies: listOf(attention.anomalies, "anomalies", compareAnomalies),
    resolved,
  };
}

// ===== the two regions the app draws =====

/** slug -> project name, from the Overview body (the name is what people read; the slug is the key). */
function projectNamesOf(overview) {
  const names = new Map();
  for (const project of Array.isArray(overview?.projects) ? overview.projects : []) {
    if (typeof project?.slug === "string") names.set(project.slug, text(project.name) ?? project.slug);
  }
  return names;
}

/**
 * The top bar: page, counts (null while there is no data), tones and freshness. The bar and the body
 * come from ONE publication: the counts are the Overview body of the data the page shows (its own
 * retained cycle), and freshness judges that same data against `nowMs` — a cached page older than a
 * newer publication elsewhere reads Stale until it has its own new cycle. A page with nothing cached
 * has no body to disagree with: the newest publication is used.
 */
export function buildTopbar(net, page, nowMs) {
  const overview = (net.pages[page] ?? latestGeneration(net))?.bodies["/api/overview"];
  const counts = overview === undefined ? null : topbarCounts(overview);
  return {
    page,
    counts,
    tones: {
      needsYou: countTone("needsYou", counts === null ? null : counts.needsYou),
      alerts: countTone("alerts", counts === null ? null : counts.alerts),
    },
    freshness: freshnessOf(net, nowMs, page),
  };
}

/**
 * The page body, from the page's own retained cycle. Without it (never loaded, or only some of its
 * routes) it is a message: the problem when there is one, otherwise "loading".
 */
export function buildMain({ net, page, project, visit, nowMs }) {
  const paths = endpointsFor(page, project);
  const generation = net.pages[page] ?? null;
  if (generation === null || !paths.every((path) => generation.bodies[path] !== undefined)) {
    return { page: "message", kind: net.problem ?? "loading" };
  }
  const refMs = msOf(generation.generatedAt) ?? nowMs;
  const bodies = generation.bodies;
  const projectNames = projectNamesOf(bodies["/api/overview"]);
  const projectName = project === null ? null : projectNames.get(project) ?? project;
  if (page === "overview") {
    return { page, ...buildOverview({ overview: bodies["/api/overview"], workers: bodies["/api/workers"] }, { refMs, visit }) };
  }
  if (page === "attention") {
    return {
      page, project, projectName,
      ...buildAttention({ attention: bodies["/api/attention"], workers: bodies["/api/workers"], projectNames }, { refMs, project }),
    };
  }
  // The list itself is workers.js's workersPage(): it needs the view state (filters, the open run), which
  // lives in the URL fragment next to the page, not in the polled data.
  return {
    page: "workers",
    project,
    projectName,
    refMs,
    bodies: { overview: bodies[paths[0]], workers: bodies[paths[1]], attention: bodies[paths[2]] },
  };
}
