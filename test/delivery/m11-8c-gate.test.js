// test/m11-8c-gate.test.js
//
// M11-8C final release-gate micro-closeout.
//
// Four gaps from the CTO verdict on 47c4ad2:
//   G1: diagnoseFailure still fell back to ANY run.delivery_failed when
//       expectedRunId was absent; frictionLog.js and run.js did not pass runId.
//   G2: the frozen-set assertion was `Object.isFrozen(codes) || true` (vacuous).
//   G3: the SSOT was over-claimed (delivery.js codes are not derived from it).
//   G4: a trailing blank line at EOF in roleContract.js failed the cumulative
//       git diff --check origin/main...HEAD.

import { test } from "node:test";
import assert from "node:assert/strict";

const ev = (o) => JSON.stringify(o);

// =====================================================================
// G1: diagnoseFailure must require a valid expectedRunId for delivery classification
// =====================================================================

test("GATE-G1a: diagnoseFailure WITHOUT expectedRunId ignores run.delivery_failed (fail-closed)", async () => {
  const { diagnoseFailure } = await import("../../src/diagnosis.js");
  // A transcript that reaches terminal completed, then has a delivery_failed.
  // With NO expectedRunId, delivery_packaging_failed must NOT be returned —
  // an unbound caller must not consume any run.delivery_failed.
  const events = [
    JSON.parse(ev({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-07-25T00:00:00.000Z", runId: "r1", agentId: "a", seq: 1 })),
    JSON.parse(ev({ type: "run.delivery_failed", deliveryCode: "base_commit_mismatch", message: "x", ts: "2026-07-25T00:00:01.000Z", runId: "r1", agentId: "a", seq: 2 })),
  ];
  const noId = diagnoseFailure(events);
  assert.notEqual(noId.category, "delivery_packaging_failed",
    "without expectedRunId, delivery_packaging_failed is NOT returned (fail-closed)");
});

test("GATE-G1b: diagnoseFailure WITH matching expectedRunId classifies correctly", async () => {
  const { diagnoseFailure } = await import("../../src/diagnosis.js");
  const events = [
    JSON.parse(ev({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-07-25T00:00:00.000Z", runId: "r1", agentId: "a", seq: 1 })),
    JSON.parse(ev({ type: "run.delivery_failed", deliveryCode: "base_commit_mismatch", message: "x", ts: "2026-07-25T00:00:01.000Z", runId: "r1", agentId: "a", seq: 2 })),
  ];
  const bound = diagnoseFailure(events, "r1");
  assert.equal(bound.category, "delivery_packaging_failed", "bound call classifies");
});

test("GATE-G1c: diagnoseFailure WITH non-matching expectedRunId ignores cross-run event", async () => {
  const { diagnoseFailure } = await import("../../src/diagnosis.js");
  const events = [
    JSON.parse(ev({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-07-25T00:00:00.000Z", runId: "r1", agentId: "a", seq: 1 })),
    JSON.parse(ev({ type: "run.delivery_failed", deliveryCode: "base_commit_mismatch", message: "x", ts: "2026-07-25T00:00:01.000Z", runId: "OTHER", agentId: "a", seq: 2 })),
  ];
  const cross = diagnoseFailure(events, "r1");
  assert.notEqual(cross.category, "delivery_packaging_failed",
    "cross-run delivery_failed does not classify");
});

test("GATE-G1d: writeFrictionLog binds runId into diagnoseFailure", async () => {
  // The friction log path must pass its runId argument into diagnoseFailure so
  // a cross-run event cannot pollute the auto-captured category. Probe the
  // source: the call site must thread runId.
  const fs = await import("node:fs");
  const src = fs.readFileSync("src/frictionLog.js", "utf8");
  assert.ok(/diagnoseFailure\(\s*events\s*,\s*runId/.test(src),
    "writeFrictionLog passes runId into diagnoseFailure");
});

test("GATE-G1e: commands/run.js binds run.transcript.context.runId into diagnoseFailure", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("src/commands/run.js", "utf8");
  assert.ok(/diagnoseFailure\(\s*events\s*,\s*run\.transcript\.context\.runId/.test(src),
    "run.js passes run.transcript.context.runId into diagnoseFailure");
});

// =====================================================================
// G2: frozen-set assertion is real (not vacuous)
// =====================================================================

test("GATE-G2: PACKAGING_FAILURE_CODES is actually frozen", async () => {
  const { PACKAGING_FAILURE_CODES } = await import("../../src/deliveryFailureCodes.js");
  assert.equal(Object.isFrozen(PACKAGING_FAILURE_CODES), true,
    "PACKAGING_FAILURE_CODES is frozen (real assertion, not vacuous)");
});

// =====================================================================
// G3: SSOT described accurately (shared safe-projection allowlist, not a
//     claim that delivery.js producer codes derive from it)
// =====================================================================

test("GATE-G3: module doc does not claim delivery.js is derived from this list", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("src/deliveryFailureCodes.js", "utf8");
  // It should describe itself as the shared application+MCP safe-projection
  // contract, NOT claim the producer (delivery.js) is fully derived from it.
  assert.ok(/safe projection|allowlist|application.*MCP|MCP.*application/i.test(src),
    "describes itself as the shared safe-projection contract");
  assert.ok(!/all production code|complete SSOT for.*producer|delivery\.js is derived/i.test(src),
    "does NOT over-claim that delivery.js producer codes derive from it");
});
