// src/backends/stallBudget.js
//
// TD-197① (2026-10-03, dual-seat consult revised): observed-gap adaptive
// stall budget — the ONE shared pure algorithm for backend no-progress gates.
//
// Problem being fixed (six false kills in one week, all Lead-verified):
//   - zcode NO_PROGRESS gate (was 60 polls ≈ 60s): GLM-5.3 batches arrive in
//     bursts; intra-turn silence legitimately exceeds the 2026-10-01 measured
//     8-14s step gaps (2026-10-02 ×3 report-phase kills; 2026-10-03 kill
//     during the long pre-implementation reasoning of run_20261003093816570xtkvw4).
//   - kimiWeb no-progress gate (was 8 polls ≈ 8s): a freshly submitted turn
//     legitimately sits queued/server-side-starting for tens of seconds
//     (2026-10-03 ×3 kills incl. two consult seats reviewing this very design:
//     run_202610030913306635cko6a / run_20261003113532551q8oyps /
//     run_202610031138135415ap6e2 — every one had session.created first, zero
//     auth errors).
//
// Design (auditor FAIL verdict on v1 incorporated — v1's adaptive-only budget
// could never learn from a first-long-silence it had already killed):
//   1. RAISED STATIC FLOORS fix the first-long-silence class directly
//      (zcode 120s, kimiWeb 60s — backend-wired constants, not here).
//   2. The budget then GROWS with the largest silent gap THIS turn has
//      recovered from: budget = min(CEILING, max(FLOOR, FACTOR × maxGap)) —
//      self-tuning to the run's real burst cadence without any config.
//   3. A HARD CEILING keeps the bounded-exit contract: a truly hung provider
//      session still terminates. NOTE (auditor Q4): the ceiling bounds the
//      SILENT-STRETCH, not wall-clock — each poll also spends request/retry/
//      sleep time on top; messages must not claim a strict wall-clock bound.
//
// Consumers wire per-backend constants and their own progress definition
// (zcode: parts growth; kimiWeb: turn signature change). ONLY the pure
// algorithm lives here — no shared loop structure is imposed (auditor Q5).
//
// Security/robustness contract: the tracker uses a MONOTONIC clock (default
// performance.now()); non-finite readings collapse to safe defaults and can
// never enlarge a budget or crash a poll loop; diagnostics expose ONLY
// numeric constants/observations (no signature, no payload, no paths).
// Malformed constants throw at construction — fail-closed, never silent.

import { performance } from "node:perf_hooks";

/**
 * The pure budget computation (unit-testable without a clock).
 *   budget = min(ceilingMs, max(floorMs, factor × maxObservedGapMs))
 * A non-finite/non-positive observed gap collapses to 0 (budget = floor).
 * @param {{floorMs:number, ceilingMs:number, factor:number, maxObservedGapMs?:number}} input
 * @returns {number} the stall budget in ms
 */
export function computeStallBudgetMs({ floorMs, ceilingMs, factor, maxObservedGapMs = 0 }) {
  const gap = Number.isFinite(maxObservedGapMs) && maxObservedGapMs > 0 ? maxObservedGapMs : 0;
  return Math.min(ceilingMs, Math.max(floorMs, factor * gap));
}

/**
 * Per-turn stall tracker. One instance per turn/event-stream; call
 * noteProgress() whenever the backend's own progress definition fires, then
 * gate on stallMs() >= budgetMs(). The first silent stretch is bounded by the
 * FLOOR (nothing learned yet — v1's first-kill defect is impossible); later
 * stretches can grow the budget up to the ceiling.
 * @param {{floorMs:number, ceilingMs:number, factor:number, now?:(()=>number)}} opts
 * @returns {{noteProgress:()=>void, stallMs:()=>number, budgetMs:()=>number, diagnostics:()=>{floorMs:number,ceilingMs:number,factor:number,maxObservedGapMs:number}}}
 */
export function createStallTracker({ floorMs, ceilingMs, factor, now = () => performance.now() }) {
  if (!Number.isFinite(floorMs) || floorMs <= 0) throw new Error("stall tracker requires a positive finite floorMs");
  if (!Number.isFinite(ceilingMs) || ceilingMs < floorMs) throw new Error("stall tracker requires ceilingMs >= floorMs");
  if (!Number.isFinite(factor) || factor < 1) throw new Error("stall tracker requires factor >= 1");
  if (typeof now !== "function") throw new Error("stall tracker requires a clock function");

  let lastProgressAt = now();
  let maxObservedGapMs = 0;
  // Priming: the FIRST progress observation ESTABLISHES the baseline without
  // recording a gap (kimiWeb R9's 首见拍建立基线 semantics, formalized). The
  // pre-first-progress wait is the zero-part/submit-lag phase — governed by
  // its own gates, never an "observed recovered silence" (recording it would
  // permanently inflate the budget off a phase the no-progress gate doesn't
  // even own — caught by the zcode ⑥d loop test: a 60s zero-part phase would
  // have lifted the budget to 180s forever).
  let primed = false;

  return {
    noteProgress() {
      const t = now();
      if (!primed) {
        if (Number.isFinite(t)) lastProgressAt = t;
        primed = true;
        return;
      }
      const gap = t - lastProgressAt;
      if (Number.isFinite(gap) && gap > maxObservedGapMs) maxObservedGapMs = gap;
      if (Number.isFinite(t)) lastProgressAt = t;
    },
    stallMs() {
      const g = now() - lastProgressAt;
      return Number.isFinite(g) && g > 0 ? g : 0;
    },
    budgetMs() {
      return computeStallBudgetMs({ floorMs, ceilingMs, factor, maxObservedGapMs });
    },
    diagnostics() {
      return { floorMs, ceilingMs, factor, maxObservedGapMs };
    },
  };
}
