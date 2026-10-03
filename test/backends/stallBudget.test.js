// test/backends/stallBudget.test.js
//
// TD-197① (2026-10-03): the shared observed-gap adaptive stall budget —
// pure-function + tracker unit pins (no backend wiring; the loop-level
// contracts live in zcode.test.js ⑥d / kimiWeb.test.js ⑤).

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeStallBudgetMs, createStallTracker } from "../../src/backends/stallBudget.js";

// ===== computeStallBudgetMs: floor / factor / ceiling =====

test("budget: no observation → floor; small gaps never shrink below floor", () => {
  assert.equal(computeStallBudgetMs({ floorMs: 300_000, ceilingMs: 600_000, factor: 3 }), 300_000);
  assert.equal(computeStallBudgetMs({ floorMs: 300_000, ceilingMs: 600_000, factor: 3, maxObservedGapMs: 10_000 }), 300_000);
  assert.equal(computeStallBudgetMs({ floorMs: 60_000, ceilingMs: 240_000, factor: 3, maxObservedGapMs: 5_000 }), 60_000);
});

test("budget: factor × observed gap lifts the budget above the floor", () => {
  assert.equal(computeStallBudgetMs({ floorMs: 300_000, ceilingMs: 600_000, factor: 3, maxObservedGapMs: 120_000 }), 360_000);
  assert.equal(computeStallBudgetMs({ floorMs: 60_000, ceilingMs: 240_000, factor: 3, maxObservedGapMs: 40_000 }), 120_000);
});

test("budget: the ceiling is a hard cap (bounded exit preserved)", () => {
  assert.equal(computeStallBudgetMs({ floorMs: 300_000, ceilingMs: 600_000, factor: 3, maxObservedGapMs: 276_000 }), 600_000);
  assert.equal(computeStallBudgetMs({ floorMs: 60_000, ceilingMs: 240_000, factor: 3, maxObservedGapMs: 1_000_000 }), 240_000);
});

test("budget: non-finite / non-positive observed gaps collapse to 0 (floor)", () => {
  assert.equal(computeStallBudgetMs({ floorMs: 300_000, ceilingMs: 600_000, factor: 3, maxObservedGapMs: NaN }), 300_000);
  assert.equal(computeStallBudgetMs({ floorMs: 300_000, ceilingMs: 600_000, factor: 3, maxObservedGapMs: -5 }), 300_000);
});

// ===== tracker: priming / observation / monotonic clock =====

test("tracker: FIRST progress PRIMES the baseline — the pre-first-progress wait is never an observed gap", () => {
  let t = 0;
  const clock = () => t;
  const tr = createStallTracker({ floorMs: 300_000, ceilingMs: 600_000, factor: 3, now: clock });
  t = 500_000; // a 500s zero-part phase BEFORE the first progress observation
  tr.noteProgress();
  // Primed — the 500s wait must NOT lift the budget (it belongs to the
  // zero-part/submit-lag gates, not the no-progress gate).
  assert.equal(tr.budgetMs(), 300_000);
  assert.equal(tr.diagnostics().maxObservedGapMs, 0);
});

test("tracker: recovered gaps are observed (max kept), stallMs grows, budget amplifies", () => {
  let t = 0;
  const clock = () => t;
  const tr = createStallTracker({ floorMs: 300_000, ceilingMs: 600_000, factor: 3, now: clock });
  tr.noteProgress(); // prime at 0
  t = 120_000;
  tr.noteProgress(); // 120s recovered silence observed
  assert.equal(tr.diagnostics().maxObservedGapMs, 120_000);
  assert.equal(tr.budgetMs(), 360_000);
  t = 90_000; // a SMALLER later gap must not shrink the max
  tr.noteProgress();
  assert.equal(tr.diagnostics().maxObservedGapMs, 120_000);
  t = 90_000 + 200_000;
  assert.equal(tr.stallMs(), 200_000);
});

test("tracker: malformed constants throw at construction (fail-closed, never silent)", () => {
  assert.throws(() => createStallTracker({ floorMs: 0, ceilingMs: 1, factor: 1 }), /positive finite floorMs/);
  assert.throws(() => createStallTracker({ floorMs: 100, ceilingMs: 50, factor: 1 }), /ceilingMs >= floorMs/);
  assert.throws(() => createStallTracker({ floorMs: 100, ceilingMs: 200, factor: 0.5 }), /factor >= 1/);
  assert.throws(() => createStallTracker({ floorMs: 100, ceilingMs: 200, factor: 1, now: "not-a-fn" }), /clock function/);
});

test("tracker: non-finite clock readings degrade safe (never enlarge, never NaN-poison)", () => {
  let t = 0;
  let bad = false;
  const clock = () => (bad ? NaN : t);
  const tr = createStallTracker({ floorMs: 60_000, ceilingMs: 240_000, factor: 3, now: clock });
  tr.noteProgress();
  t = 100_000;
  tr.noteProgress();
  bad = true;
  // NaN stall collapses to 0; budget stays a finite number.
  assert.equal(tr.stallMs(), 0);
  assert.ok(Number.isFinite(tr.budgetMs()));
});
