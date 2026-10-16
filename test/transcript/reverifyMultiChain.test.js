// test/transcript/reverifyMultiChain.test.js
//
// The reverify chain projection with EXPLICIT attempts (at most two chains).
//
// Hard contract exercised:
//   - A requested event may carry attempt ∈ {1, 2} (absent = 1; a legacy
//     transcript has no attempt field and projects byte-identically on every
//     pre-existing field).
//   - projectReverifyChain keeps its existing return shape for the LATEST
//     chain and adds `attempt` (the latest chain's number) + `links`
//     ([{attempt, status, reason, effectiveStatus}, ...]).
//   - Fail-closed malformed shapes: two attempt-1 requests; an attempt-2
//     request without a qualifying failed first chain (absent / pending /
//     passed / unavailable / artifact_mutated); an outcome without its
//     request; order violations; more than two chains; an out-of-range
//     attempt value on a persisted request.
//   - The decision gate backs a nonpending decision with the NEAREST complete
//     reverify chain in the decision's prefix — a chain appended after the
//     decision never retroactively supports it.
//
// Pure in-memory projections + one lock-scoped CAS group; fixtures under
// os.tmpdir(); zero network, zero git, zero provider.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JsonlTranscript,
  readTranscript,
  validateDeliveryFacts,
  projectReverifyChain,
} from "../../src/transcript.js";

const REV_RUN = "run_rv2_proj";
const REV_AGENT = "coder_hq";
const REV_COMMIT = "a".repeat(40);
const REV_BASE = "b".repeat(40);

function revRef(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "git_commit",
    runId: REV_RUN,
    baseCommit: REV_BASE,
    deliveryCommit: REV_COMMIT,
    branch: `wao/${REV_RUN}`,
    worktreePath: "/fake/wt",
    changedFiles: ["src/a.js"],
    verification: { status: "pending", commands: ["assert"] },
    acceptance: { status: "pending", reviewerType: "lead_agent" },
    integration: { status: "pending", targetCommit: null },
    ...overrides,
  };
}

function revRequested(overrides = {}) {
  return {
    type: "run.delivery_reverification_requested",
    runId: REV_RUN,
    delivery: revRef(),
    deliveryCommit: REV_COMMIT,
    reason: "tooling_invalid",
    ...overrides,
  };
}

function revOutcome(outcome, overrides = {}) {
  const type = outcome === "passed"
    ? "run.delivery_reverification_passed"
    : outcome === "failed"
      ? "run.delivery_reverification_failed"
      : "run.delivery_reverification_unavailable";
  const verification = outcome === "passed"
    ? { status: "passed", commands: ["assert"], verifiedCommit: REV_COMMIT, results: [] }
    : outcome === "failed"
      ? { status: "failed", commands: ["assert"], failureCode: "command_failed", verifiedCommit: REV_COMMIT, results: [] }
      : { status: "unavailable", commands: [], unavailableReason: "no_assertions", verifiedCommit: REV_COMMIT, results: [] };
  return {
    type,
    runId: REV_RUN,
    delivery: revRef({ verification }),
    deliveryCommit: REV_COMMIT,
    ...overrides,
  };
}

/** A failed reverify outcome whose failureCode the caller picks. */
function revFailedWith(failureCode) {
  return revOutcome("failed", {
    delivery: revRef({
      verification: {
        status: "failed",
        commands: ["assert"],
        failureCode,
        verifiedCommit: REV_COMMIT,
        results: [],
      },
    }),
  });
}

function decisionEvent(type, claimed, overrides = {}) {
  return {
    type,
    runId: REV_RUN,
    delivery: revRef({
      verification: { status: claimed, commands: ["assert"], verifiedCommit: REV_COMMIT, results: [] },
      acceptance: { status: type === "run.delivery_accepted" ? "accepted" : "rejected", reviewerType: "lead_agent" },
    }),
    deliveryCommit: REV_COMMIT,
    reason: "lead decision",
    ...overrides,
  };
}

// =====================================================================
// Group 1: legacy (no attempt field) projection is byte-identical
// =====================================================================

test("RV2-P0: a legacy single chain (no attempt field) projects the exact legacy shape + attempt 1", () => {
  const req = revRequested({ setupCommands: ["fix env"] });
  const out = revOutcome("passed");
  const p = projectReverifyChain([req, out], REV_RUN, revRef());
  // Every PRE-EXISTING field keeps its exact value (legacy consumers see zero
  // drift); the attempt field reads 1; links carries the single legacy chain.
  assert.deepEqual(
    {
      status: p.status,
      requestedEvent: p.requestedEvent,
      outcomeEvent: p.outcomeEvent,
      reason: p.reason,
      effectiveStatus: p.effectiveStatus,
    },
    {
      status: "complete",
      requestedEvent: req,
      outcomeEvent: out,
      reason: "tooling_invalid",
      effectiveStatus: "passed",
    },
  );
  assert.equal(p.attempt, 1);
  assert.deepEqual(p.links, [
    { attempt: 1, status: "complete", reason: "tooling_invalid", effectiveStatus: "passed" },
  ]);

  // Pending legacy chain: same zero-drift claim for the pending shape.
  const pend = projectReverifyChain([revRequested()], REV_RUN, revRef());
  assert.equal(pend.status, "pending");
  assert.equal(pend.attempt, 1);
  assert.deepEqual(pend.links, [
    { attempt: 1, status: "pending", reason: "tooling_invalid", effectiveStatus: null },
  ]);

  // None chain keeps the empty shape.
  const none = projectReverifyChain([], REV_RUN, revRef());
  assert.equal(none.status, "none");
  assert.equal(none.attempt, null);
  assert.deepEqual(none.links, []);
});

// =====================================================================
// Group 2: valid two-chain projections
// =====================================================================

test("RV2-P1: two complete chains project the LATEST chain + ordered links", () => {
  const p = projectReverifyChain(
    [
      revRequested({ reason: "tooling_invalid" }),
      revFailedWith("command_timeout"),
      revRequested({ reason: "environment_contaminated", attempt: 2, setupCommands: ["free the gate"] }),
      revOutcome("passed"),
    ],
    REV_RUN,
    revRef(),
  );
  assert.equal(p.status, "complete");
  assert.equal(p.attempt, 2);
  assert.equal(p.reason, "environment_contaminated", "latest chain's reason wins");
  assert.equal(p.effectiveStatus, "passed");
  assert.deepEqual(p.links, [
    { attempt: 1, status: "complete", reason: "tooling_invalid", effectiveStatus: "failed" },
    { attempt: 2, status: "complete", reason: "environment_contaminated", effectiveStatus: "passed" },
  ]);
});

test("RV2-P2: a pending second chain projects status pending + both links", () => {
  const p = projectReverifyChain(
    [
      revRequested(),
      revFailedWith("command_failed"),
      revRequested({ reason: "dependency_setup_missing", attempt: 2 }),
    ],
    REV_RUN,
    revRef(),
  );
  assert.equal(p.status, "pending");
  assert.equal(p.attempt, 2);
  assert.equal(p.reason, "dependency_setup_missing");
  assert.equal(p.effectiveStatus, null);
  assert.deepEqual(p.links, [
    { attempt: 1, status: "complete", reason: "tooling_invalid", effectiveStatus: "failed" },
    { attempt: 2, status: "pending", reason: "dependency_setup_missing", effectiveStatus: null },
  ]);
});

// =====================================================================
// Group 3: malformed shapes — one test per shape, all fail-closed
// =====================================================================

function assertMalformed(events, label) {
  const p = projectReverifyChain(events, REV_RUN, revRef());
  assert.equal(p.status, "malformed", label);
  assert.equal(p.effectiveStatus, null, `${label}: no effective status may project`);
  assert.equal(p.attempt, null, `${label}: no attempt may project`);
  assert.deepEqual(p.links, [], `${label}: no links may project`);
}

test("RV2-M1: two attempt-1 requests are malformed (duplicate first chain)", () => {
  assertMalformed(
    [revRequested(), revFailedWith("command_failed"), revRequested({ reason: "tooling_invalid" })],
    "second request without attempt after a complete first chain",
  );
  assertMalformed(
    [revRequested(), revRequested()],
    "two open attempt-1 requests back to back",
  );
});

test("RV2-M2: an attempt-2 request without a qualifying failed first chain is malformed", () => {
  assertMalformed([revRequested({ attempt: 2 })], "no first chain at all");
  assertMalformed(
    [revRequested(), revRequested({ attempt: 2 })],
    "first chain still pending",
  );
  assertMalformed(
    [revRequested(), revOutcome("passed"), revRequested({ attempt: 2 })],
    "first chain passed",
  );
  assertMalformed(
    [revRequested(), revOutcome("unavailable"), revRequested({ attempt: 2 })],
    "first chain unavailable",
  );
  assertMalformed(
    [revRequested(), revFailedWith("artifact_mutated"), revRequested({ attempt: 2 })],
    "first chain failed artifact_mutated",
  );
});

test("RV2-M3: an outcome without its request is malformed (orphan)", () => {
  assertMalformed([revOutcome("passed")], "outcome with no request at all");
  assertMalformed(
    [revRequested(), revFailedWith("command_failed"), revRequested({ attempt: 2 }), revOutcome("passed"), revOutcome("passed")],
    "a second outcome for the second chain (orphan once the link closed)",
  );
});

test("RV2-M4: order violations are malformed", () => {
  assertMalformed(
    [revOutcome("passed"), revRequested()],
    "outcome before its request",
  );
  assertMalformed(
    [revRequested(), revFailedWith("command_failed"), revOutcome("passed"), revRequested({ attempt: 2 })],
    "second-chain outcome before the second request",
  );
});

test("RV2-M5: more than two chains are malformed", () => {
  assertMalformed(
    [
      revRequested(),
      revFailedWith("command_failed"),
      revRequested({ attempt: 2 }),
      revFailedWith("command_timeout"),
      revRequested({ reason: "tooling_invalid" }),
    ],
    "a third request (as a stray attempt-1)",
  );
});

test("RV2-M6: an out-of-range or non-integer attempt on a persisted request is malformed", () => {
  for (const bad of [3, 0, -1, 1.5, "2", true]) {
    assertMalformed(
      [revRequested({ attempt: bad })],
      `persisted attempt ${JSON.stringify(bad)}`,
    );
  }
});

// =====================================================================
// Group 4: the decision gate — nearest complete chain in the prefix
// =====================================================================

const FACTS_OPTS = { expectedRunId: REV_RUN, allowVerificationPending: true };

function baseDeliveryEvents() {
  return [
    { type: "run.delivery_created", runId: REV_RUN, delivery: revRef() },
    {
      type: "run.delivery_verification_failed",
      runId: REV_RUN,
      delivery: revRef({
        verification: { status: "failed", failureCode: "command_failed", commands: ["assert"], verifiedCommit: REV_COMMIT, results: [] },
      }),
      deliveryCommit: REV_COMMIT,
    },
  ];
}

test("RV2-D1: after the second chain passed, an accept claiming passed is valid and effective is the latest outcome", () => {
  const facts = validateDeliveryFacts(
    [
      ...baseDeliveryEvents(),
      revRequested(),
      revFailedWith("command_failed"),
      revRequested({ reason: "environment_contaminated", attempt: 2 }),
      revOutcome("passed"),
      decisionEvent("run.delivery_accepted", "passed"),
    ],
    FACTS_OPTS,
  );
  assert.equal(facts.valid, true);
  assert.equal(facts.verificationStatus, "failed", "original truth unchanged");
  assert.equal(facts.effectiveVerificationStatus, "passed", "effective is the LATEST chain's outcome");
  assert.equal(facts.reverifyStatus, "complete");
  assert.equal(facts.decisionEvent?.type, "run.delivery_accepted");
});

test("RV2-D2: after the second chain failed, an accept claiming passed is invalid (fail closed)", () => {
  const facts = validateDeliveryFacts(
    [
      ...baseDeliveryEvents(),
      revRequested(),
      revFailedWith("command_failed"),
      revRequested({ reason: "environment_contaminated", attempt: 2 }),
      revFailedWith("command_timeout"),
      decisionEvent("run.delivery_accepted", "passed"),
    ],
    FACTS_OPTS,
  );
  assert.equal(facts.valid, false);
  assert.equal(facts.code, "delivery_malformed");
  assert.match(facts.error, /no earlier matching original outcome or valid reverify backing/);
});

test("RV2-D3: the decision is backed by the NEAREST complete chain before it — a later chain cannot retroactively support it", () => {
  // A reject claiming failed sits BETWEEN the two chains: the nearest complete
  // chain in its prefix is chain 1 (failed) → valid. Chain 2 (appended after
  // the decision) does not retroactively legalize or invalidate it.
  const facts = validateDeliveryFacts(
    [
      ...baseDeliveryEvents(),
      revRequested(),
      revFailedWith("command_failed"),
      decisionEvent("run.delivery_rejected", "failed"),
      revRequested({ reason: "environment_contaminated", attempt: 2 }),
      revOutcome("passed"),
    ],
    FACTS_OPTS,
  );
  assert.equal(facts.valid, true, "the reject was backed by chain 1 at decide time");
  assert.equal(facts.decisionEvent?.type, "run.delivery_rejected");

  // An accept claiming passed BEFORE the (passing) second chain has no
  // backing in its prefix: chain 1 failed is the nearest complete chain.
  const early = validateDeliveryFacts(
    [
      ...baseDeliveryEvents(),
      revRequested(),
      revFailedWith("command_failed"),
      decisionEvent("run.delivery_accepted", "passed"),
      revRequested({ attempt: 2 }),
      revOutcome("passed"),
    ],
    FACTS_OPTS,
  );
  assert.equal(early.valid, false, "a request appended after the decision cannot back it");
  assert.equal(early.code, "delivery_malformed");
});

test("RV2-D4: a decision while the second chain is still pending is backed by the first chain (nearest complete)", () => {
  const facts = validateDeliveryFacts(
    [
      ...baseDeliveryEvents(),
      revRequested(),
      revFailedWith("command_failed"),
      revRequested({ reason: "environment_contaminated", attempt: 2 }),
      decisionEvent("run.delivery_rejected", "failed"),
    ],
    FACTS_OPTS,
  );
  assert.equal(facts.valid, true, "pending second chain does not unback a chain-1-backed reject");
  assert.equal(facts.effectiveVerificationStatus, "failed", "a pending latest chain leaves effective at the original");
});

// =====================================================================
// Group 5: lock-scoped CAS — the two-chain append guards
// =====================================================================

test("RV2-C1: tryAppendReverifyRequested refuses an attempt-2 request without a qualifying failed first chain (in-lock)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rv2-c1-"));
  try {
    const filePath = join(dir, `${REV_RUN}.jsonl`);
    const t = new JsonlTranscript(filePath, { runId: REV_RUN, agentId: REV_AGENT });
    await t.append("run.delivery_created", { delivery: revRef() });
    // No reverify chain at all → attempt 2 refused.
    await assert.rejects(
      () => t.tryAppendReverifyRequested({ delivery: revRef(), reason: "tooling_invalid", attempt: 2 }),
      /second attempt requires a complete first reverify chain/,
    );
    // A pending first chain does not qualify either.
    await t.tryAppendReverifyRequested({ delivery: revRef(), reason: "tooling_invalid" });
    await assert.rejects(
      () => t.tryAppendReverifyRequested({ delivery: revRef(), reason: "tooling_invalid", attempt: 2 }),
      /second attempt requires a complete first reverify chain/,
    );
    // Nothing beyond the legitimate request was appended.
    const events = await readTranscript(filePath);
    assert.equal(events.filter((e) => e.type === "run.delivery_reverification_requested").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RV2-C2: attempt input shape is validated in-lock (integer 1 or 2)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rv2-c2-"));
  try {
    const filePath = join(dir, `${REV_RUN}.jsonl`);
    const t = new JsonlTranscript(filePath, { runId: REV_RUN, agentId: REV_AGENT });
    await t.append("run.delivery_created", { delivery: revRef() });
    for (const bad of [3, 0, -1, 1.5, "2"]) {
      await assert.rejects(
        () => t.tryAppendReverifyRequested({ delivery: revRef(), reason: "tooling_invalid", attempt: bad }),
        /attempt must be the integer 1 or 2/,
        `attempt ${JSON.stringify(bad)} rejected`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RV2-C3: a late attempt-1 outcome never closes the second chain (it yields to the first chain's outcome)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rv2-c3-"));
  try {
    const filePath = join(dir, `${REV_RUN}.jsonl`);
    const t = new JsonlTranscript(filePath, { runId: REV_RUN, agentId: REV_AGENT });
    await t.append("run.delivery_created", { delivery: revRef() });
    await t.tryAppendReverifyRequested({ delivery: revRef(), reason: "tooling_invalid" });
    const first = await t.tryAppendReverifyOutcome({ delivery: revFailedWith("command_timeout").delivery, outcome: "failed" });
    assert.equal(first.recorded, true);
    await t.tryAppendReverifyRequested({ delivery: revRef(), reason: "environment_contaminated", attempt: 2 });
    // A second attempt-1 caller that was still verifying now reports a pass.
    const passedRef = revOutcome("passed").delivery;
    const late = await t.tryAppendReverifyOutcome({ delivery: passedRef, outcome: "passed" });
    assert.equal(late.recorded, false, "the late attempt-1 outcome yields");
    assert.equal(late.outcome, "failed", "it reports the first chain's durable outcome");
    const pending = projectReverifyChain(await readTranscript(filePath), REV_RUN, revRef());
    assert.equal(pending.attempt, 2);
    assert.equal(pending.status, "pending", "the second chain is still open");
    // The attempt-2 outcome closes the second chain.
    const second = await t.tryAppendReverifyOutcome({ delivery: passedRef, outcome: "passed", attempt: 2 });
    assert.equal(second.recorded, true);
    const closed = projectReverifyChain(await readTranscript(filePath), REV_RUN, revRef());
    assert.equal(closed.status, "complete");
    assert.equal(closed.effectiveStatus, "passed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RV2-C4: once a Lead decision is recorded, no new reverify chain opens (in-lock recheck)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rv2-c4-"));
  try {
    const filePath = join(dir, `${REV_RUN}.jsonl`);
    const t = new JsonlTranscript(filePath, { runId: REV_RUN, agentId: REV_AGENT });
    await t.append("run.delivery_created", { delivery: revRef() });
    await t.tryAppendReverifyRequested({ delivery: revRef(), reason: "tooling_invalid" });
    await t.tryAppendReverifyOutcome({ delivery: revFailedWith("command_failed").delivery, outcome: "failed" });
    const { type, runId, ...decisionPayload } = decisionEvent("run.delivery_rejected", "failed");
    await t.append(type, decisionPayload);
    await assert.rejects(
      () => t.tryAppendReverifyRequested({ delivery: revRef(), reason: "environment_contaminated", attempt: 2 }),
      /a Lead decision is already recorded/,
    );
    const events = await readTranscript(filePath);
    assert.equal(events.filter((e) => e.type === "run.delivery_reverification_requested").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const dir2 = await mkdtemp(join(tmpdir(), "rv2-c4b-"));
  try {
    const filePath = join(dir2, `${REV_RUN}.jsonl`);
    const t = new JsonlTranscript(filePath, { runId: REV_RUN, agentId: REV_AGENT });
    await t.append("run.delivery_created", { delivery: revRef() });
    const { type, runId, ...decisionPayload } = decisionEvent("run.delivery_rejected", "failed");
    await t.append(type, decisionPayload);
    await assert.rejects(
      () => t.tryAppendReverifyRequested({ delivery: revRef(), reason: "tooling_invalid" }),
      /a Lead decision is already recorded/,
      "the first chain cannot open after a decision either",
    );
  } finally {
    await rm(dir2, { recursive: true, force: true });
  }
});
