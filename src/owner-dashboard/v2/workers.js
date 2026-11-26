// src/owner-dashboard/v2/workers.js
//
// The Workers page, as pure functions: no DOM, no globals, no network. Importable from Node (the
// tests feed it the server's real output). Language never enters here: the view models are
// language-free data, the views pick the words (i18n.js).
//
// Input is the three bodies of ONE publication — /api/overview (project and lane names),
// /api/workers (the rows of the default range) and /api/attention (what each row's attentionIds
// stand for) — plus the page's own view state (filters + the open run, kept in the URL fragment).
// Nothing here rewrites worker text and nothing is made up: a fact the row does not carry (a file
// count, a review verdict, how long a delivery has waited) is simply not shown on a card; the side
// panel has it.

import { TASK_TYPES, isValidProject, msOf, shortCommit } from "./model.js";

export const STATUS_VALUES = Object.freeze(["starting", "running", "completed", "failed", "stopped"]);
/** The liveness values a running worker can have; a finished worker has none of them. */
export const HEALTH_VALUES = Object.freeze(["progress", "process_only", "silent", "unknown"]);
export const SEARCH_MAX = 64;
const FILTER_KEYS = Object.freeze(["project", "lane", "type", "status", "health"]);
/** The order the filter row is drawn and written in. */
export const FILTER_ORDER = FILTER_KEYS;

const LANE_RE = /^[A-Za-z0-9._-]{1,128}$/;
const RUN_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

const TERMINAL = new Set(["completed", "failed", "aborted", "timed_out"]);
/** A review seat's verdict: the closed set the server sends. */
const Q1_VALUES = Object.freeze(["PASS", "PASS_WITH_NOTES", "FIX_FIRST"]);
/** Open attention kinds that mean "the delivery / review is not settled yet". */
const UNSETTLED_KINDS = new Set(["consult_split", "verification_failed", "verification_unavailable", "delivery_ambiguous", "awaiting_decision"]);

const text = (value) => (typeof value === "string" && value.length > 0 ? value : null);
const isObject = (value) => value !== null && typeof value === "object";

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

// ===== the view state and its place in the fragment =====

/** No filter, no search, nothing open (the project filter is the one an Overview link brings). */
export const emptyView = (project = null) => ({ project, lane: null, type: null, status: null, health: null, q: "", run: null });

const SHAPES = {
  project: isValidProject,
  lane: (value) => LANE_RE.test(value),
  type: (value) => TASK_TYPES.includes(value),
  status: (value) => STATUS_VALUES.includes(value),
  health: (value) => HEALTH_VALUES.includes(value),
  run: (value) => RUN_ID_RE.test(value),
};

/** A search text: trimmed, no control characters, at most SEARCH_MAX characters; anything else is no search. */
export function cleanQuery(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > SEARCH_MAX || CONTROL_RE.test(trimmed) ? "" : trimmed;
}

/**
 * The Workers state out of a fragment. The query starts at the first "?" or "&" after the page name:
 * "#workers?project=shop-api&lane=glm-pro&run=run_1" (what formatWorkersHash writes) and
 * "#workers&project=shop-api&lane=glm-pro" both read the same. Any other page, an unknown key, a value
 * outside its closed set or a repeated key is simply not part of the state.
 */
export function parseWorkersHash(hash) {
  let raw = typeof hash === "string" ? hash : "";
  if (raw.startsWith("#")) raw = raw.slice(1);
  const cut = raw.search(/[?&]/);
  const name = cut < 0 ? raw : raw.slice(0, cut);
  const view = emptyView();
  if (name !== "workers" || cut < 0) return view;
  const seen = new Set();
  for (const [key, value] of new URLSearchParams(raw.slice(cut + 1))) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (key === "q") view.q = cleanQuery(value);
    else if (Object.hasOwn(SHAPES, key) && SHAPES[key](value)) view[key] = value;
  }
  return view;
}

/** The canonical fragment of a Workers state: the keys in a fixed order, only those that are set. */
export function formatWorkersHash(view) {
  const parts = [];
  for (const key of FILTER_KEYS) {
    const value = view?.[key];
    if (typeof value === "string" && SHAPES[key](value)) parts.push(`${key}=${encodeURIComponent(value)}`);
  }
  const q = cleanQuery(view?.q);
  if (q !== "") parts.push(`q=${encodeURIComponent(q)}`);
  if (typeof view?.run === "string" && SHAPES.run(view.run)) parts.push(`run=${encodeURIComponent(view.run)}`);
  return parts.length === 0 ? "#workers" : `#workers?${parts.join("&")}`;
}

/** True when any filter or search is set (the open run is not a filter). */
export const hasFilters = (view) => FILTER_KEYS.some((key) => view[key] !== null) || cleanQuery(view.q) !== "";

// ===== rows =====

/**
 * The status of a row, from what the server bound. Starting is the server's own stage ("starting");
 * Running needs the state "running" (or the stage "active"). A run that is pending / submitted — or of a
 * state the transcript cannot tell — with NO bound stage is none of them: "unknown" (plan A6: no stage is
 * made up, and no start is invented). No filter option matches "unknown"; it stays in the Running group.
 */
const statusOf = (row) => {
  if (row.state === "completed") return "completed";
  if (row.state === "failed" || row.state === "timed_out") return "failed";
  if (row.state === "aborted") return "stopped";
  if (row.stage === "starting") return "starting";
  if (row.state === "running" || row.stage === "active") return "running";
  return "unknown";
};

/** A running-group row is one that has not ended; a state the transcript cannot tell stays there, unclaimed. */
const isFinished = (row) => TERMINAL.has(row.state);

function matches(row, view) {
  if (view.project !== null && row.project?.slug !== view.project) return false;
  if (view.lane !== null && row.laneKey !== view.lane) return false;
  if (view.type !== null && (TASK_TYPES.includes(row.taskType) ? row.taskType : "untyped") !== view.type) return false;
  if (view.status !== null && statusOf(row) !== view.status) return false;
  if (view.health !== null && row.liveness !== view.health) return false;
  const q = cleanQuery(view.q).toLowerCase();
  if (q !== "") {
    const commit = typeof row.delivery?.commit === "string" ? row.delivery.commit : "";
    if (!String(row.runId).toLowerCase().includes(q) && !(commit !== "" && commit.startsWith(q))) return false;
  }
  return true;
}

/** id -> { section, kind } of the open attention items (what a row's attentionIds stand for). */
function attentionIndex(attention) {
  const index = new Map();
  for (const section of ["decide", "anomalies"]) {
    for (const item of Array.isArray(attention?.[section]) ? attention[section] : []) {
      if (isObject(item) && typeof item.id === "string" && !index.has(item.id)) index.set(item.id, { section, kind: String(item.kind) });
    }
  }
  return index;
}

/** The delivery summary of a finished card (only facts the row carries). */
function deliveryOf(row) {
  const delivery = row.delivery;
  if (!isObject(delivery)) return null;
  const acceptance = delivery.acceptance?.status ?? null;
  const settledForLead = delivery.settlement?.status === "settled" && delivery.settlement?.reason === "delivery_settled";
  let decision = null;
  if (acceptance === "accepted") decision = "adopted";
  else if (acceptance === "rejected") decision = "rejected";
  else if (acceptance === "pending" && settledForLead && delivery.branchPresent !== false) decision = "awaiting";
  const reason = delivery.settlement?.reason;
  return {
    commit: shortCommit(delivery.commit),
    changedCount: Number.isInteger(delivery.changedCount) && delivery.changedCount >= 0 ? delivery.changedCount : null,
    verification: text(delivery.verification?.status),
    decision,
    problem: reason === "packaging_failed" || reason === "isolation_failed" ? reason : null,
  };
}

function cardOf(row, refMs, index) {
  const attached = (Array.isArray(row.attentionIds) ? row.attentionIds : []).map((id) => index.get(id) ?? null);
  const finished = isFinished(row);
  const delivery = finished ? deliveryOf(row) : null;
  const unsettled = attached.some((entry) => entry !== null && UNSETTLED_KINDS.has(entry.kind)) || delivery?.decision === "awaiting";
  const startedMs = msOf(row.startedAt);
  const effectMs = msOf(row.lastEffectAt);
  const terminalMs = msOf(row.terminalAt);
  const status = statusOf(row);
  let tone = "quiet";
  let glyph = "·";
  if (finished) {
    if (unsettled || attached.some((entry) => entry?.section === "decide")) [tone, glyph] = ["red", "●"];
    else if (status === "failed" || attached.length > 0) [tone, glyph] = ["amber", "▲"];
    else if (status === "stopped") [tone, glyph] = ["gray", "■"];
    else [tone, glyph] = ["gray", "✓"];
  } else if (attached.some((entry) => entry?.section === "decide")) [tone, glyph] = ["red", "●"];
  else if (attached.length > 0 || row.liveness === "silent" || row.liveness === "process_only") [tone, glyph] = ["amber", "▲"];
  const round = isObject(row.round) && Number.isInteger(row.round.number) && row.round.number > 1
    ? { number: row.round.number, complete: row.round.complete !== false }
    : null;
  return {
    runId: row.runId,
    title: text(row.title) ?? text(row.subtitle) ?? row.runId,
    subtitle: text(row.title) === null ? null : text(row.subtitle),
    type: TASK_TYPES.includes(row.taskType) ? row.taskType : "untyped",
    lane: text(row.laneKey),
    projectSlug: text(row.project?.slug),
    status,
    state: text(row.state),
    stage: text(row.stage),
    health: text(row.liveness),
    tone,
    glyph,
    associated: attached.length > 0,
    unsettled,
    round,
    // The group facts are the server's: the whole group's seat count / how many arrived / whether it has
    // ended (every seat's run terminal, whether or not that seat survived the page's filters).
    consult: isObject(row.consult) && typeof row.consult.groupId === "string"
      ? {
        groupId: row.consult.groupId,
        seatsIn: Number(row.consult.seatsIn) || 0,
        seatsTotal: Number(row.consult.seatsTotal) || 0,
        finished: typeof row.consult.finished === "boolean" ? row.consult.finished : null,
      }
      : null,
    // A review seat that has answered: its own verdict (closed set), shown on the finished card.
    q1: isObject(row.consult) && Q1_VALUES.includes(row.consult.q1) ? row.consult.q1 : null,
    // Running: how long it has run and how long ago it last did real work (null: none seen yet).
    runningMs: startedMs === null || finished ? null : Math.max(0, refMs - startedMs),
    progressAgoMs: effectMs === null ? null : Math.max(0, refMs - effectMs),
    // Finished: how it ended, how long ago, and the delivery it left.
    outcome: finished ? status : null,
    failure: finished && isObject(row.failure) ? text(row.failure.code) ?? text(row.failure.category) : null,
    endedAgoMs: terminalMs === null ? null : Math.max(0, refMs - terminalMs),
    delivery,
    // Sort keys.
    progressMs: effectMs ?? startedMs,
    terminalMs,
  };
}

// ===== the two groups =====

/** Running: rows with an associated item first, then the longest without real progress, then run id. */
const compareRunning = (a, b) => (Number(b.associated) - Number(a.associated))
  || ascNullLast(a.progressMs, b.progressMs)
  || byText(a.key, b.key);

/** Finished: the unsettled first, then the most recently ended, then run id. */
const compareFinished = (a, b) => (Number(b.unsettled) - Number(a.unsettled))
  || descNullLast(a.terminalMs, b.terminalMs)
  || byText(a.key, b.key);

const compareSeats = (a, b) => byText(a.lane ?? "", b.lane ?? "") || byText(a.runId, b.runId);

/**
 * One entry per solo card and per review group. Seats of one review (same consult groupId) sit together in
 * ONE entry that lives in Running while any seat has not ended, else in Finished; its sort keys are those
 * of its members (any associated / unsettled one; the quietest running seat; the latest end).
 *
 * Whether the group has ended is the SERVER's fact (consult.finished over ALL seats): filtering a
 * still-starting seat out of the page must not move the remaining, ended seats to Finished. Only when the
 * server does not state it (an older body) does the old "no visible live seat" rule apply.
 */
function entriesOf(cards) {
  const groups = new Map();
  const entries = [];
  for (const card of cards) {
    if (card.consult === null) {
      entries.push({ kind: "card", key: card.runId, finished: card.outcome !== null, card });
      continue;
    }
    let group = groups.get(card.consult.groupId);
    if (group === undefined) {
      group = { kind: "group", key: card.consult.groupId, groupId: card.consult.groupId, seatsIn: card.consult.seatsIn, seatsTotal: card.consult.seatsTotal, cards: [] };
      groups.set(group.key, group);
      entries.push(group);
    }
    group.cards.push(card);
  }
  for (const entry of entries) {
    if (entry.kind === "card") {
      Object.assign(entry, { associated: entry.card.associated, unsettled: entry.card.unsettled, progressMs: entry.card.progressMs, terminalMs: entry.card.terminalMs });
      continue;
    }
    entry.cards.sort(compareSeats);
    const live = entry.cards.filter((card) => card.outcome === null);
    // The server's whole-group fact first; the visible seats only decide when it is absent.
    const declared = entry.cards.map((card) => card.consult?.finished).find((value) => typeof value === "boolean");
    entry.finished = declared === undefined ? live.length === 0 : declared;
    entry.associated = entry.cards.some((card) => card.associated);
    entry.unsettled = entry.cards.some((card) => card.unsettled);
    const progress = (live.length > 0 ? live : entry.cards).map((card) => card.progressMs).filter((ms) => ms !== null);
    entry.progressMs = progress.length === 0 ? null : Math.min(...progress);
    const ended = entry.cards.map((card) => card.terminalMs).filter((ms) => ms !== null);
    entry.terminalMs = ended.length === 0 ? null : Math.max(...ended);
    entry.type = entry.cards[0].type;
    entry.title = entry.cards[0].title;
    entry.seatsTotal = Math.max(entry.seatsTotal, entry.cards.length);
  }
  return entries;
}

const cardsOf = (entries) => entries.flatMap((entry) => (entry.kind === "card" ? [entry.card] : entry.cards));

// ===== the page =====

function optionsOf(overview, rows, view) {
  const projects = (Array.isArray(overview?.projects) ? overview.projects : [])
    .filter((project) => typeof project?.slug === "string")
    .map((project) => ({ value: project.slug, name: text(project.name) ?? project.slug }))
    .sort((a, b) => byText(a.name, b.name) || byText(a.value, b.value));
  const lanes = new Set();
  for (const lane of Array.isArray(overview?.lanes) ? overview.lanes : []) if (typeof lane?.laneKey === "string") lanes.add(lane.laneKey);
  for (const row of rows) if (typeof row.laneKey === "string") lanes.add(row.laneKey);
  if (view.lane !== null) lanes.add(view.lane);
  return {
    project: projects,
    lane: [...lanes].sort(byText).map((value) => ({ value, name: value })),
    type: TASK_TYPES.map((value) => ({ value, name: null })),
    status: STATUS_VALUES.map((value) => ({ value, name: null })),
    health: HEALTH_VALUES.map((value) => ({ value, name: null })),
  };
}

/**
 * The Workers page view model.
 *
 * @param {{overview: object, workers: object, attention: object}} bodies — the three bodies of one publication
 * @param {{refMs: number, view: object, startingOpen?: boolean}} context — the publication time (every duration
 *   counts to it), the view state (parseWorkersHash) and whether the Owner opened the Starting line by hand
 *   (asking for status "starting" opens it too)
 */
export function buildWorkers({ overview, workers, attention }, { refMs, view, startingOpen = false }) {
  const rows = (Array.isArray(workers?.workers) ? workers.workers : []).filter((row) => isObject(row) && typeof row.runId === "string");
  const truncated = workers?.truncated === true;
  const index = attentionIndex(attention);
  const options = optionsOf(overview, rows, view);
  const nameOf = (key, value) => options[key]?.find((option) => option.value === value)?.name ?? null;

  const shown = rows.filter((row) => matches(row, view));
  // Only a Starting run that belongs to no review folds into the Starting line; a seat stays in its group
  // (the group lives in Running while any seat has not ended, Starting or not).
  const folds = (row) => statusOf(row) === "starting" && !(isObject(row.consult) && typeof row.consult.groupId === "string");
  const startingCards = shown.filter(folds).map((row) => cardOf(row, refMs, index));
  // Entries are built over ALL other listed cards at once, so the seats of one review are one entry even when
  // some have ended and some have not.
  const entries = entriesOf(shown.filter((row) => !folds(row)).map((row) => cardOf(row, refMs, index)));
  const running = entries.filter((entry) => !entry.finished).sort(compareRunning);
  const finished = entries.filter((entry) => entry.finished).sort(compareFinished);
  startingCards.sort((a, b) => ascNullLast(a.progressMs, b.progressMs) || byText(a.runId, b.runId));

  const starting = { count: startingCards.length, cards: startingCards, open: startingOpen || view.status === "starting" };
  // THE visible order: what the page draws, top to bottom, and so what the arrow keys walk. The page draws
  // exactly these three parts in this order (Running, the Starting line's cards when it is open, Finished).
  const sequence = [
    ...cardsOf(running).map((card) => card.runId),
    ...(starting.open ? startingCards.map((card) => card.runId) : []),
    ...cardsOf(finished).map((card) => card.runId),
  ];

  // The open run: where it stands relative to the filters and the default range.
  //   listed but hidden by the filters        -> "filtered"
  //   not listed, and a filter is set          -> "unlisted" (the project filter alone makes the server cut the
  //                                               rows: absence says nothing about the default range; the panel
  //                                               upgrades it to "projectHidden" once the detail shows another project)
  //   not listed, no filter, list not cut      -> "outOfRange" (the only case that proves it is outside the default range)
  const rowOf = (runId) => rows.find((row) => row.runId === runId);
  let note = null;
  if (view.run !== null) {
    const row = rowOf(view.run);
    if (row !== undefined) note = matches(row, view) ? null : "filtered";
    else if (hasFilters(view)) note = "unlisted";
    else note = truncated ? null : "outOfRange";
  }

  const chips = [
    ...FILTER_KEYS.filter((key) => view[key] !== null).map((key) => ({ key, value: view[key], name: nameOf(key, view[key]) ?? (key === "project" ? view[key] : null) })),
    ...(cleanQuery(view.q) !== "" ? [{ key: "q", value: cleanQuery(view.q), name: cleanQuery(view.q) }] : []),
  ];

  return {
    view,
    chips,
    options,
    q: cleanQuery(view.q),
    truncated,
    total: rows.length,
    matched: shown.length,
    running: { count: cardsOf(running).length, entries: running },
    starting,
    finished: { count: cardsOf(finished).length, entries: finished },
    sequence,
    empty: rows.length === 0 ? "none" : shown.length === 0 ? "filtered" : null,
    // project: the project filter in force (the panel compares it with the worker's own project); seq: the
    // latest event number the attention evidence names for this run (the Copy ref carries it), or null.
    open: view.run === null ? null : { runId: view.run, note, project: view.project, seq: evidenceSeqFor(attention, view.run) },
  };
}

/**
 * The event number to put in a reference to `runId`: the latest (greatest) event number among the evidence
 * the attention items name for THAT run — a failed run's terminal event, a silent run's last real action, a
 * delivery's settle event. Evidence without a number (an old transcript) counts for nothing; no evidence at
 * all is null and the reference stays the bare run number. Nothing is made up.
 */
export function evidenceSeqFor(attention, runId) {
  let best = null;
  for (const section of ["decide", "anomalies", "resolved"]) {
    for (const item of Array.isArray(attention?.[section]) ? attention[section] : []) {
      for (const entry of isObject(item) && Array.isArray(item.evidence) ? item.evidence : []) {
        if (isObject(entry) && entry.runId === runId && Number.isInteger(entry.seq) && entry.seq > 0 && (best === null || entry.seq > best)) best = entry.seq;
      }
    }
  }
  return best;
}

/**
 * The page vm of buildMain's Workers result plus the view state. The publication time stays out of the
 * result: what is drawn is the durations, so a poll that changes nothing visible redraws nothing.
 */
export function workersPage(main, view, startingOpen = false) {
  const { bodies, refMs, ...rest } = main;
  return { ...rest, ...buildWorkers(bodies, { refMs, view, startingOpen }) };
}

// ===== moving between workers =====

/** The runId next to `current` in the visible order (`delta` +1 / -1); not in the list: down starts at the top, up at the bottom. */
export function neighborRun(sequence, current, delta) {
  if (!Array.isArray(sequence) || sequence.length === 0) return null;
  const at = sequence.indexOf(current);
  if (at < 0) return delta > 0 ? sequence[0] : sequence[sequence.length - 1];
  const next = at + delta;
  return next < 0 || next >= sequence.length ? null : sequence[next];
}

const TEXT_ENTRY_TAGS = new Set(["input", "select", "textarea"]);

/**
 * What a key does to an open side panel: "close" (Escape), "prev" / "next" (arrow up / down), or null.
 * Nothing happens while a text field or a select has the key, or with a modifier held.
 */
export function sidebarKeyAction({ key, tag = "", editable = false, alt = false, ctrl = false, meta = false, shift = false }) {
  if (alt || ctrl || meta || shift) return null;
  if (TEXT_ENTRY_TAGS.has(String(tag).toLowerCase()) || editable) return key === "Escape" ? "close" : null;
  if (key === "Escape") return "close";
  if (key === "ArrowUp") return "prev";
  if (key === "ArrowDown") return "next";
  return null;
}

/**
 * Does a click close the open side panel? Only a click on the empty page: not inside the panel, not in the
 * top bar (the language switch keeps it open), and not on a worker card or the filter bar (they have their own
 * meaning).
 */
export const closesSidebar = ({ inSidebar = false, inTopbar = false, keep = false }) => !inSidebar && !inTopbar && !keep;
