// src/owner-dashboard/v2/detail.js
//
// The worker side panel, as pure functions: no DOM, no globals, no network (the fetch is injected).
// Importable from Node: the tests feed it the real /api/worker body (projectWorkerDetail's output).
// Language never enters here; the views pick the words.
//
// Two parts:
//   createDetailFeed   which worker is open and what its detail request says, with the guard that makes
//                      A -> B -> A safe: every selection change starts a new epoch and an answer that
//                      belongs to an older epoch is dropped, even when it is for the same run.
//   buildSidebar       the view model of the open worker: header, health, the two progress axes, the
//                      Deliverable and Brief tabs.
//
// Nothing is made up. A fact the body does not carry is not shown; no deliverable is "none observed",
// never filled in from what the assistant said; a source (system observed / worker reported) comes
// from the body, never from this code.

import { TASK_TYPES, evidenceCode, msOf, shortCommit } from "./model.js";

/** A file list longer than this is folded behind a disclosure. */
export const FILES_FOLD_AFTER = 8;
/** A run still in its starting stage this long is flagged (plan A6: the hand-over may have failed). */
export const STARTING_SLOW_MS = 30_000;

const TERMINAL = new Set(["completed", "failed", "aborted", "timed_out"]);
const isObject = (value) => value !== null && typeof value === "object";
const text = (value) => (typeof value === "string" && value.length > 0 ? value : null);
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

// ===== the feed =====

const IDLE = Object.freeze({ runId: null, epoch: 0, phase: "idle", body: null, problem: null });

/**
 * The detail request state of the one open worker.
 *   phase    idle (nothing open) | loading | ready | notFound | unavailable (server has no data yet) | error
 *   body     the last good /api/worker body of THIS run (kept when a later refresh fails; problem says why)
 *   epoch    +1 on every open / close
 * fetchDetail(runId) -> Promise<{ok: true, body} | {ok: false, reason}> (api.request). An answer is applied only
 * when it belongs to the epoch it was asked in: switching A -> B -> A never shows A's old answer.
 *
 * @param {{fetchDetail: (runId: string) => Promise<object>, onChange: () => void}} io
 */
export function createDetailFeed({ fetchDetail, onChange }) {
  let state = IDLE;
  let epoch = 0;
  let inFlightEpoch = null;

  function apply(runId, result) {
    if (result.ok === true && isObject(result.body)) {
      const body = result.body;
      if (body.status === "loading") return { ...state, phase: "loading", problem: null };
      if (body.status === "unavailable") return { ...state, phase: "unavailable", problem: null };
      if ((body.status === "ready" || body.status === "stale") && body.runId === runId && isObject(body.identity)) {
        return { ...state, phase: "ready", body, problem: null };
      }
      return failure("server");
    }
    if (result.ok === false && result.reason === "notFound") return { ...state, phase: "notFound", body: null, problem: null };
    return failure(result.ok === false ? result.reason : "server");
  }

  /** A failed refresh keeps the last good body of this run; without one it is an error. */
  function failure(reason) {
    return state.body === null ? { ...state, phase: "error", problem: reason } : { ...state, problem: reason };
  }

  function request() {
    if (state.runId === null || inFlightEpoch === epoch) return;
    const mine = epoch;
    const runId = state.runId;
    inFlightEpoch = mine;
    Promise.resolve()
      .then(() => fetchDetail(runId))
      .then((result) => result, () => ({ ok: false, reason: "network" }))
      .then((result) => {
        if (inFlightEpoch === mine) inFlightEpoch = null;
        if (mine !== epoch) return; // the selection moved on: this answer belongs to the past
        state = { ...apply(runId, result), epoch: mine };
        onChange();
      });
  }

  return {
    /** Open a worker (a no-op when it is already the open one). */
    open(runId) {
      if (state.runId === runId) return;
      epoch += 1;
      state = { runId, epoch, phase: "loading", body: null, problem: null };
      onChange();
      request();
    },
    close() {
      if (state.runId === null) return;
      epoch += 1;
      state = { ...IDLE, epoch };
      onChange();
    },
    /** One refresh of the open worker (a poll tick); skipped while a request of this epoch is in flight. */
    refresh: request,
    get: () => state,
  };
}

// ===== references =====

/** The reference an Owner pastes to the Lead: the run number, with the event number when one is known. */
export const workerRef = (runId, seq = null) => evidenceCode({ runId, seq }) ?? String(runId);

// ===== the two progress axes =====

/**
 * Step marks: done (✓), current (●), future (○), unknown (?: the body cannot tell), bad (▲: a problem on
 * this step), ended (■: stopped on purpose).
 */
function runAxis(run, lastEffectAt) {
  const state = text(run?.state);
  const terminal = TERMINAL.has(state);
  const stage = text(run?.stage);
  const stageAgeMs = count(run?.stageAgeMs);
  // Starting is lit ONLY by the stage the server bound ("starting"). A run that is pending / submitted with no
  // bound stage is "stage unknown" (plan A6): Starting is not lit and no start is made up (no age).
  const starting = !terminal && stage === "starting";
  const stageUnknown = !terminal && stage !== "starting" && stage !== "active";
  const steps = [];
  if (terminal) {
    // Ended: it started; it ran when it completed or did real work. A run that failed or was stopped without
    // any observed work is not claimed to have reached Running.
    const ran = state === "completed" || text(lastEffectAt) !== null;
    steps.push({ id: "starting", mark: "done" }, { id: "running", mark: ran ? "done" : "unknown" });
    const endId = state === "completed" ? "completed" : state === "aborted" ? "stopped" : state === "timed_out" ? "timed_out" : "failed";
    steps.push({ id: endId, mark: endId === "completed" ? "done" : endId === "stopped" ? "ended" : "bad" });
  } else if (starting) {
    steps.push({ id: "starting", mark: "current" }, { id: "running", mark: "future" });
  } else if (state === "running" || stage === "active") {
    steps.push({ id: "starting", mark: "done" }, { id: "running", mark: "current" });
  } else if (state === "pending" || state === "submitted") {
    // Not running yet, but how far it got is not known: Starting is "not observed", Running is still ahead.
    steps.push({ id: "starting", mark: "unknown" }, { id: "running", mark: "future" });
  } else {
    steps.push({ id: "starting", mark: "unknown" }, { id: "running", mark: "unknown" });
  }
  return {
    steps,
    // Starting only: how long, and whether that is long enough to flag; stage unknown: said as such.
    startingAgeMs: starting ? stageAgeMs : null,
    startingSlow: starting && stageAgeMs !== null && stageAgeMs > STARTING_SLOW_MS,
    stageUnknown,
  };
}
const VERIFY_WORDS = new Set(["passed", "failed", "unavailable", "pending"]);

function deliveryAxis(delivery, run, refMs) {
  if (!isObject(delivery)) return null;
  const terminal = TERMINAL.has(text(run?.state));
  const status = VERIFY_WORDS.has(delivery.verification?.status) ? delivery.verification.status : null;
  const result = text(delivery.decision?.result);
  const awaiting = delivery.awaitingDecision;
  const settled = delivery.settlement?.status === "settled" && delivery.settlement?.reason === "delivery_settled";
  const problem = text(delivery.packagingFailure) !== null || isObject(delivery.isolationFailure) || delivery.ambiguous === true;
  const commit = text(delivery.commit) !== null;

  const commitMark = commit ? "done" : problem ? "bad" : terminal ? "current" : "future";
  let verifyMark = "future";
  if (status === "passed") verifyMark = "done";
  else if (status === "failed" || status === "unavailable") verifyMark = "bad";
  else if (commit) verifyMark = "current";
  let awaitMark = "future";
  if (awaiting === true) awaitMark = "current";
  else if (result === "accepted" || result === "rejected") awaitMark = "done";
  else if (result === "superseded") awaitMark = "ended";
  else if (awaiting === null && settled) awaitMark = "unknown";
  // The last step appears when the Lead has decided (adopted / rejected / superseded) — like the Run axis, which
  // shows how it ended only once it has ended; until then the axis stops at "Awaiting Lead".
  const final = result === "accepted" ? { id: "adopted", mark: "done" } : result === "rejected" ? { id: "rejected", mark: "ended" } : result === "superseded" ? { id: "superseded", mark: "ended" } : null;

  const round = isObject(delivery.round) ? delivery.round : {};
  const number = Number.isInteger(round.number) && round.number >= 1 ? round.number : 1;
  const continues = text(round.continuesRunId);
  const settledMs = msOf(delivery.settledAt);
  return {
    steps: [
      { id: "commit", mark: commitMark },
      { id: "verify", mark: verifyMark, detail: status },
      { id: "awaiting", mark: awaitMark },
      ...(final === null ? [] : [final]),
    ],
    // Marked only when this run is a continuation (a later round, or one that names the run it continues).
    round: number > 1 || continues !== null
      ? { number, complete: round.complete !== false, continues, continuesDecision: text(round.continuesDecision) }
      : null,
    decision: result === "accepted" ? "adopted" : result === "rejected" ? "rejected" : result === "superseded" ? "superseded" : awaiting === true ? "awaiting" : null,
    supersededBy: text(delivery.decision?.supersededByRunId),
    awaitingForMs: awaiting === true && settledMs !== null ? Math.max(0, refMs - settledMs) : null,
    reverify: text(delivery.verification?.reverify?.status) !== null && delivery.verification.reverify.status !== "none" ? delivery.verification.reverify.status : null,
    problem: text(delivery.packagingFailure) !== null ? "packaging_failed" : isObject(delivery.isolationFailure) ? "isolation_failed" : delivery.ambiguous === true ? "ambiguous" : null,
  };
}

function consultAxis(consult) {
  if (!isObject(consult)) return null;
  return {
    seatState: text(consult.thisSeat?.runState),
    replied: typeof consult.thisSeat?.replied === "boolean" ? consult.thisSeat.replied : null,
    seatsIn: count(consult.seatsArrived) ?? 0,
    seatsTotal: count(consult.seatsTotal) ?? 0,
    complete: consult.complete === true,
    reviewedRunId: text(consult.reviewedRunId),
  };
}

// ===== health =====

function healthOf(body, refMs) {
  const run = isObject(body.run) ? body.run : {};
  const health = isObject(body.health) ? body.health : {};
  const state = text(run.state);
  const terminal = TERMINAL.has(state);
  const ago = (iso) => {
    const ms = msOf(iso);
    return ms === null ? null : Math.max(0, refMs - ms);
  };
  const failure = isObject(health.failure) ? health.failure : null;
  const outcome = state === "completed" ? "completed" : state === "aborted" ? "stopped" : state === "timed_out" ? "timed_out" : state === "failed" ? "failed" : null;
  const liveness = ["progress", "process_only", "silent", "unknown"].includes(health.liveness) ? health.liveness : "unknown";
  const tone = terminal ? (outcome === "failed" || outcome === "timed_out" ? "amber" : "gray") : liveness === "silent" || liveness === "process_only" ? "amber" : "gray";
  return {
    terminal,
    word: terminal ? outcome : liveness,
    tone,
    glyph: tone === "amber" ? "▲" : "●",
    progressAgoMs: ago(health.lastEffectAt),
    heartbeatAgoMs: ago(health.lastHeartbeatAt),
    failure: failure === null
      ? null
      : {
        category: text(failure.category),
        code: text(failure.code),
        evidence: (Array.isArray(failure.evidence) ? failure.evidence : [])
          .filter(isObject)
          .map((entry) => ({ eventType: text(entry.eventType), fact: text(entry.fact) }))
          .filter((entry) => entry.eventType !== null || entry.fact !== null),
        isolation: isObject(failure.isolation)
          ? {
            reason: text(failure.isolation.reason),
            destination: text(failure.isolation.destination),
            reportedPath: text(failure.isolation.reportedPath),
            resolvedPath: text(failure.isolation.resolvedPath),
            escapedAt: text(failure.isolation.escapedAt),
          }
          : null,
      },
  };
}

// ===== Deliverable =====

function seatsOf(rows, runId) {
  return (Array.isArray(rows) ? rows : []).filter(isObject).map((row) => ({
    runId: text(row.runId),
    lane: text(row.laneKey) ?? text(row.agentId),
    q1: text(row.q1),
    runState: text(row.runState),
    replied: typeof row.replied === "boolean" ? row.replied : null,
    source: text(row.source),
    current: text(row.runId) !== null && row.runId === runId,
  }));
}

const reviewOf = (review, runId) => ({
  consultId: text(review.consultId),
  afterCurrentDelivery: typeof review.afterCurrentDelivery === "boolean" ? review.afterCurrentDelivery : null,
  q1Declared: review.q1Declared === true,
  verdictsDiffer: typeof review.verdictsDiffer === "boolean" ? review.verdictsDiffer : null,
  anyFixFirst: typeof review.anyFixFirst === "boolean" ? review.anyFixFirst : null,
  rowsTruncated: review.rowsTruncated === true,
  seats: seatsOf(review.rows, runId),
});

function commandsOf(list) {
  return (Array.isArray(list) ? list : []).filter(isObject).map((entry) => ({
    index: count(entry.index),
    command: text(entry.command),
    ran: isObject(entry.result),
    exitCode: Number.isInteger(entry.result?.exitCode) ? entry.result.exitCode : null,
    timedOut: entry.result?.timedOut === true,
    durationMs: count(entry.result?.durationMs),
  }));
}

function filesOf(files) {
  if (!isObject(files)) return null;
  const items = (Array.isArray(files.items) ? files.items : []).filter(isObject).map((item) => ({
    path: text(item.path) ?? "",
    added: count(item.added),
    deleted: count(item.deleted),
    binary: item.binary === true,
  }));
  const known = items.length > 0 && items.every((item) => item.binary || (item.added !== null && item.deleted !== null));
  return {
    source: text(files.source),
    total: count(files.total) ?? items.length,
    truncated: files.truncated === true,
    items,
    collapsed: (count(files.total) ?? items.length) > FILES_FOLD_AFTER,
    // The sums only when every listed file is known (a missing count would make the sum a lie).
    added: known && !files.truncated ? items.reduce((sum, item) => sum + (item.added ?? 0), 0) : null,
    deleted: known && !files.truncated ? items.reduce((sum, item) => sum + (item.deleted ?? 0), 0) : null,
  };
}

function verificationOf(verification) {
  if (!isObject(verification)) return null;
  return {
    source: text(verification.source),
    boundCommit: shortCommit(verification.boundCommit),
    status: VERIFY_WORDS.has(verification.status) ? verification.status : null,
    unavailableReason: text(verification.unavailableReason),
    commands: commandsOf(verification.commands),
    setupCommands: commandsOf(verification.setupCommands),
    failure: isObject(verification.failure)
      ? { code: text(verification.failure.code), phase: text(verification.failure.phase), commandIndex: count(verification.failure.commandIndex) }
      : null,
  };
}

/** The Deliverable tab: one of none | research | consult | code | image (a git delivery, bound or unavailable). */
function deliverableOf(body, axis) {
  const d = isObject(body.deliverable) ? body.deliverable : { kind: "none", state: "none" };
  const runId = body.runId;
  if (d.kind === "consult") {
    return {
      kind: "consult",
      consultId: text(d.consultId),
      reviewedRunId: text(d.reviewedRunId),
      q1Declared: d.q1Declared === true,
      verdictsDiffer: typeof d.verdictsDiffer === "boolean" ? d.verdictsDiffer : null,
      anyFixFirst: typeof d.anyFixFirst === "boolean" ? d.anyFixFirst : null,
      rowsTruncated: d.rowsTruncated === true,
      seats: seatsOf(d.rows, runId),
    };
  }
  if (d.kind === "research" && d.state === "bound" && isObject(d.answer)) {
    return {
      kind: "research",
      answer: {
        source: text(d.answer.source),
        text: typeof d.answer.text === "string" ? d.answer.text : "",
        truncated: d.answer.truncated === true,
        keptChars: count(d.answer.keptChars) ?? 0,
        totalChars: count(d.answer.totalChars) ?? 0,
      },
    };
  }
  if ((d.kind === "code" || d.kind === "image") && (d.state === "bound" || d.state === "unavailable")) {
    // The delivery facts that contradict each other come with no commit at all (state unavailable, reason
    // delivery_facts_conflict): that is a delivery that cannot be trusted, NOT "no deliverable". The reason
    // is always kept; the commit, the files and the verification are there only when the server gave them.
    const hash = isObject(d.commit) ? text(d.commit.hash) : null;
    return {
      kind: d.kind,
      state: d.state,
      reason: text(d.reason),
      commit: isObject(d.commit) ? { hash, short: shortCommit(hash), source: text(d.commit.source) } : null,
      files: filesOf(d.files),
      verification: verificationOf(d.verification),
      reviews: (Array.isArray(d.reviews) ? d.reviews : []).filter(isObject).map((review) => reviewOf(review, runId)),
      images: d.kind === "image"
        ? (Array.isArray(d.images) ? d.images : []).filter(isObject).map((image) => ({ index: count(image.index), path: text(image.path) ?? "" }))
        : [],
      decision: axis === null ? null : { result: axis.decision, supersededBy: axis.supersededBy, awaitingForMs: axis.awaitingForMs },
    };
  }
  return { kind: "none" };
}

/**
 * The images the open Deliverable needs on screen: an image delivery that is bound, on its Deliverable tab.
 * Each is { id, runId, commit, fileIndex }: bound to the delivery commit AND the file's index, so a changed
 * candidate can never make the same index point at another file. Anything else needs no image.
 */
export function imagesWanted(sidebar, tab) {
  if (sidebar === null || sidebar.kind !== "detail" || tab !== "deliverable") return [];
  const d = sidebar.deliverable;
  if (d.kind !== "image" || d.state !== "bound" || d.commit === null || d.commit.hash === null) return [];
  return d.images
    .filter((image) => image.index !== null)
    .map((image) => ({ id: `${sidebar.runId}|${d.commit.hash}|${image.index}`, runId: sidebar.runId, commit: d.commit.hash, fileIndex: image.index }));
}

// ===== the panel =====

const TABS = Object.freeze(["activity", "deliverable", "brief"]);

/**
 * The side panel view model.
 *
 * @param {{feed: object, open: {runId: string, note: string|null, project?: string|null, seq?: number|null}|null, nowMs: number}} input
 *   feed is detailFeed.get(); open is the Workers page's `open` (the run in the fragment, where it stands
 *   against the default range / filters, the project filter in force and the latest event number the evidence
 *   names for it); nowMs is the client clock (only the fallback of the publication time)
 * @returns {object|null} null when no worker is open
 */
export function buildSidebar({ feed, open, nowMs }) {
  if (open === null || open === undefined) return null;
  const seq = Number.isInteger(open.seq) && open.seq > 0 ? open.seq : null;
  const base = { runId: open.runId, note: open.note ?? null, ref: workerRef(open.runId, seq) };
  if (feed.runId !== open.runId || feed.phase !== "ready" || feed.body === null) {
    const message = feed.runId !== open.runId || feed.phase === "idle" ? "loading" : feed.phase;
    return { kind: "message", ...base, message, problem: feed.problem };
  }
  const body = feed.body;
  const refMs = msOf(body.generatedAt) ?? nowMs;
  const identity = isObject(body.identity) ? body.identity : {};
  const health = healthOf(body, refMs);
  const axisDelivery = deliveryAxis(body.delivery, body.run, refMs);
  // The Copy ref follows the detail's own bound event number (the snapshot fact, which survives the
  // attention item's 24-hour window); only with none does it fall back to the event the attention
  // evidence named, then to the bare run number.
  const boundSeq = Number.isInteger(body.refSeq) && body.refSeq > 0 ? body.refSeq : seq;
  // "Not in the current list" is all a missing row proves while a filter is set. Once the detail shows that the
  // worker belongs to ANOTHER project than the project filter, say that: the filter is what hides it.
  const ownProject = text(identity.project?.slug);
  const note = base.note === "unlisted" && text(open.project) !== null && ownProject !== null && ownProject !== open.project ? "projectHidden" : base.note;
  return {
    kind: "detail",
    ...base,
    ref: workerRef(open.runId, boundSeq),
    note,
    title: text(identity.title) ?? open.runId,
    subtitle: text(identity.subtitle),
    type: TASK_TYPES.includes(identity.taskType) ? identity.taskType : "untyped",
    lane: text(identity.laneKey),
    projectName: text(identity.project?.name) ?? text(identity.project?.slug),
    elapsedMs: count(identity.elapsedMs),
    health,
    axes: {
      run: runAxis(body.run, body.health?.lastEffectAt),
      delivery: axisDelivery,
      consult: consultAxis(body.consult),
    },
    // Still running opens on Activity, ended on Deliverable (until the Owner picks a tab).
    defaultTab: health.terminal ? "deliverable" : "activity",
    deliverable: deliverableOf(body, axisDelivery),
    brief: isObject(body.brief)
      ? {
        present: body.brief.state === "present",
        text: typeof body.brief.text === "string" ? body.brief.text : "",
        truncated: body.brief.truncated === true,
        keptChars: count(body.brief.keptChars) ?? 0,
        totalChars: count(body.brief.totalChars) ?? 0,
      }
      : { present: false, text: "", truncated: false, keptChars: 0, totalChars: 0 },
    // A failed refresh: the data on screen is the last good one.
    stale: feed.problem !== null,
  };
}

/** The tab shown: the Owner's pick when it is one of the three, else the default. */
export const activeTab = (picked, defaultTab) => (TABS.includes(picked) ? picked : defaultTab);
export { TABS };
