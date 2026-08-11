// src/application/runStageProjection.js
//
// M12-17: submitted-stage execution semantics — the SINGLE pure SSOT
// executionStage projector.
//
// One read-only transcript snapshot (the run's own event array) is projected
// into ONE bounded closed-set stage over the submitted-run lifecycle:
//
//   accepted — the control plane accepted the run (run.submitted /
//              run.background_submitted present) but no worker process was
//              spawned yet.
//   spawned  — a worker process was spawned (run.started present) but emitted
//              no worker activity yet.
//   active   — the worker emitted at least one run.event (any kind).
//   terminal — a CONSISTENT terminal fact exists (see below).
//   unknown  — no consistent basis: no recognizable stage facts at all, OR
//              distinct conflicting terminal claims.
//
// The projection is pure over ONE snapshot: it never reads the filesystem,
// never probes liveness, never stops/retries/reassigns, never makes a semantic
// judgment, never echoes event payloads, and never branches on backend or
// runtime. It only classifies which closed-set stage the transcript's own
// facts establish, plus the deterministic age of that stage.
//
// Terminal-wins semantics (the consistency contract):
//   - The terminal basis is the union of TWO closed-set terminal claim kinds:
//       (a) run.state_change with `to` ∈ TERMINAL_STATES (the authoritative
//           transition), and
//       (b) legacy terminal FACT types without a state_change — run.completed
//           (completed), run.timed_out (timed_out), run.aborted (aborted),
//           run.error (failed) — the same fallback family findState uses for
//           pre-transition transcripts. In the real runner (TD-99) terminal
//           facts are written ATOMICALLY paired with their terminal
//           state_change, so the union is exactly one state in every
//           production flow.
//   - All terminal claims must AGREE on the terminal state. The union of the
//     claimed states being exactly one state → phase "terminal". Distinct
//     claimed states (e.g. completed + failed, aborted then failed, a terminal
//     state_change + a conflicting legacy fact) → phase "unknown" — the stage
//     NEVER picks a winner between conflicting terminals.
//   - Once a consistent terminal exists, LATER activity never moves the stage:
//     later run.event worker activity (malformed replay noise), later
//     non-terminal state_change (resurrection: terminal then running), and
//     later malformed state_change (missing/unknown `to`) are all ignored.
//   - run.stop_requested is an INTENT, not a fact — it never establishes
//     terminal. workflow.completed, session/delivery/correction bookkeeping,
//     and every other event type are outside the bounded basis and cannot
//     move the stage.
//
// Fail-closed cross-run binding:
//   - The requested runId is validated with isValidRunId (throw) BEFORE any
//     event is considered.
//   - An event whose envelope runId is a non-null value DIFFERENT from the
//     requested runId is FOREIGN and can never influence the stage (a foreign
//     terminal claim cannot make this run terminal; a foreign activity cannot
//     make it active). This preserves the status path's existing tolerance —
//     a legacy event with NO runId envelope stays in-scope (older transcripts
//     and hand-seeded fixtures have no envelope), so nothing regresses.
//   - Non-object lines (null / numbers / arrays / primitives) are corrupt
//     replay noise and are skipped — they cannot influence the stage.
//
// Deterministic age:
//   - sinceTs is the RAW ts string of the FIRST event (causal order) that
//     established the stage; null when the establishing event carries no
//     usable ts. secondsSince is the rounded deterministic age
//     (now - sinceTs) computed with the injectable nowFn (default Date.now),
//     null when no ts or an unparseable ts is available.
//
// Architectural contract:
//   - No file I/O, no MCP SDK / zod / commands / backend imports, no state
//     mutation, no liveness probe. Reuses the TERMINAL_STATES closed set and
//     isValidRunId SSOT — no second copy of either.
//
// The exported EXECUTION_STAGES constant is the SINGLE source for the MCP
// run_status output schema (src/mcp/server.js imports it) — schema and
// projector can never drift.

import { TERMINAL_STATES } from "../transcript.js";
import { isValidRunId } from "../delivery.js";

// ===== Closed-set stages (SSOT for the MCP run_status output schema) =====

export const EXECUTION_STAGES = Object.freeze([
  "accepted",
  "spawned",
  "active",
  "terminal",
  "unknown",
]);

// ===== Bounded closed-set basis (event types that can move the stage) =====
//
// Every type outside these four closed sets — session/delivery/correction/
// scorecard/stop bookkeeping, workflow events, unknown types — cannot move
// the stage (no semantic judgment, no payload echo).

// accepted basis: the control plane accepted the run.
const ACCEPTED_BASIS_TYPES = new Set(["run.submitted", "run.background_submitted"]);
// spawned basis: a worker process was spawned.
const SPAWNED_BASIS_TYPES = new Set(["run.started"]);
// active basis: worker activity (any kind).
const ACTIVE_BASIS_TYPES = new Set(["run.event"]);

// Legacy terminal FACT types → the terminal state they prove. This projector
// intentionally uses a narrower terminal-fact subset than findState: only
// durable completion/error/timeout/abort facts establish this stage.
// run.stop_requested is deliberately NOT here: it is a stop INTENT, not a
// terminal fact (no semantic judgment about its effect).
const LEGACY_TERMINAL_FACT_STATES = Object.freeze({
  "run.completed": "completed",
  "run.timed_out": "timed_out",
  "run.aborted": "aborted",
  "run.error": "failed",
});

/**
 * Deterministic age of an establishing event: the raw ts string + the rounded
 * seconds since it (injectable clock). An absent or unparseable ts yields
 * sinceTs null / secondsSince null — the stage itself still holds (the fact is
 * the fact; only the age is unknowable).
 * @param {object|null} event
 * @param {number} now
 * @returns {{sinceTs: string|null, secondsSince: number|null}}
 */
function stageAge(event, now) {
  const ts = typeof event?.ts === "string" && event.ts.length > 0 ? event.ts : null;
  const ms = ts ? new Date(ts).getTime() : NaN;
  const secondsSince = Number.isFinite(ms) ? Math.round((now - ms) / 1000) : null;
  return { sinceTs: ts, secondsSince };
}

/**
 * Project ONE read-only transcript snapshot into the closed-set execution
 * stage (M12-17 submitted-stage semantics).
 *
 * @param {object} rawSnapshot — { events: object[] } (UNTRUSTED)
 * @param {object} opts
 * @param {string} opts.runId — the caller-requested runId (isValidRunId SSOT)
 * @param {Function} [opts.nowFn] — injectable clock for deterministic age
 * @returns {{phase: string, sinceTs: string|null, secondsSince: number|null}}
 *          phase ∈ EXECUTION_STAGES; sinceTs/secondsSince null when no
 *          establishing basis or age is computable.
 * @throws {Error} on an invalid snapshot shape or an invalid runId (fail
 *         closed before any event is considered).
 */
export function projectExecutionStage(rawSnapshot, { runId, nowFn } = {}) {
  if (!rawSnapshot || typeof rawSnapshot !== "object" || Array.isArray(rawSnapshot)) {
    throw new Error("invalid execution-stage snapshot");
  }
  if (!Array.isArray(rawSnapshot.events)) {
    throw new Error("invalid execution-stage snapshot: events must be an array");
  }
  if (!isValidRunId(runId)) {
    throw new Error("invalid runId");
  }
  const now = typeof nowFn === "function" ? nowFn() : Date.now();

  // Causal-order single pass over the bounded closed-set basis. first* keeps
  // the FIRST event (causal order) that establishes each basis, so sinceTs is
  // the deterministic stage-establishment moment.
  let firstAccepted = null;
  let firstStarted = null;
  let firstActive = null;
  let firstTerminalEvent = null;
  const terminalStates = new Set();

  for (const event of rawSnapshot.events) {
    // Corrupt primitive replay lines (null/numbers/arrays/raw strings) cannot
    // influence the stage.
    if (event === null || typeof event !== "object" || Array.isArray(event)) continue;
    // Fail-closed cross-run: an envelope runId that is present (non-null) and
    // different from the requested runId is FOREIGN — it can never influence
    // the stage. Missing-envelope events stay in-scope legacy content.
    if (event.runId !== undefined && event.runId !== null && event.runId !== runId) {
      continue;
    }
    const type = typeof event.type === "string" ? event.type : null;

    if (type === "run.state_change") {
      // Terminal-wins: only `to` values inside TERMINAL_STATES are terminal
      // claims. Non-terminal and malformed transitions (missing/unknown `to`)
      // are control-plane noise — a consistent terminal already claims the
      // stage and later transitions cannot override it.
      if (TERMINAL_STATES.includes(event.to)) {
        terminalStates.add(event.to);
        if (firstTerminalEvent === null) firstTerminalEvent = event;
      }
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(LEGACY_TERMINAL_FACT_STATES, type)) {
      terminalStates.add(LEGACY_TERMINAL_FACT_STATES[type]);
      if (firstTerminalEvent === null) firstTerminalEvent = event;
      continue;
    }
    if (ACTIVE_BASIS_TYPES.has(type)) {
      if (firstActive === null) firstActive = event;
      continue;
    }
    if (SPAWNED_BASIS_TYPES.has(type)) {
      if (firstStarted === null) firstStarted = event;
      continue;
    }
    if (ACCEPTED_BASIS_TYPES.has(type)) {
      if (firstAccepted === null) firstAccepted = event;
      continue;
    }
    // Everything else is outside the bounded basis — never moves the stage.
  }

  // Consistency union: every terminal claim (transition + legacy fact) must
  // agree on ONE terminal state. Distinct conflicting terminal states degrade
  // to unknown — the stage never picks a winner between conflicting terminals.
  if (terminalStates.size >= 2) {
    return { phase: "unknown", sinceTs: null, secondsSince: null };
  }
  if (terminalStates.size === 1) {
    return { phase: "terminal", ...stageAge(firstTerminalEvent, now) };
  }
  if (firstActive !== null) {
    return { phase: "active", ...stageAge(firstActive, now) };
  }
  if (firstStarted !== null) {
    return { phase: "spawned", ...stageAge(firstStarted, now) };
  }
  if (firstAccepted !== null) {
    return { phase: "accepted", ...stageAge(firstAccepted, now) };
  }
  // No recognizable stage basis at all — honest unknown, never fabricated.
  return { phase: "unknown", sinceTs: null, secondsSince: null };
}
