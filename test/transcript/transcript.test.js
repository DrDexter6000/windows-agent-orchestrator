import { mkdtemp, readFile, rm, writeFile, open as realOpen } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  JsonlTranscript,
  readTranscript,
  findLatest,
  findState,
  findLastEventSeq,
  validateDeliveryFacts,
  projectReverifyChain,
  acquireAppendLock,
  __setAppendLockFsForTest,
  __resetAppendLockFsForTest,
  RUN_STATES,
  TERMINAL_STATES,
  DELIVERY_DECISION_POLICY_CODES,
  DeliveryDecisionPolicyError,
  REPACKAGE_CAS_POLICY_CODES,
  RepackageCasPolicyError,
} from "../../src/transcript.js";
import { createSecretRedactor } from "../../src/secretRedaction.js";

test("appends normalized JSONL events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-transcript-"));
  const transcript = new JsonlTranscript(join(dir, "run.jsonl"), {
    runId: "run_123",
    agentId: "glm_worker",
  });

  await transcript.append("run.started", { cwd: "D:/projects/worktree" });
  await transcript.append("session.created", { backendSessionId: "ses_abc" });

  const lines = (await readFile(transcript.filePath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);

  const first = JSON.parse(lines[0]);
  assert.equal(first.runId, "run_123");
  assert.equal(first.agentId, "glm_worker");
  assert.equal(first.type, "run.started");
  assert.equal(first.cwd, "D:/projects/worktree");
  assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test("append auto-increments seq monotonically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-transcript-seq-"));
  const transcript = new JsonlTranscript(join(dir, "run.jsonl"), {
    runId: "run_seq",
    agentId: "agent_x",
  });

  await transcript.append("run.started", {});
  await transcript.append("session.created", {});
  await transcript.append("run.state_change", { from: "pending", to: "submitted" });
  await transcript.append("run.completed", {});

  const events = await readTranscript(transcript.filePath);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4]);
});

test("append can continue from an existing max seq", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-transcript-resume-seq-"));
  const transcript = new JsonlTranscript(join(dir, "run.jsonl"), {
    runId: "run_seq",
    agentId: "agent_x",
    initialSeq: 6,
  });

  await transcript.append("run.stop_requested", {});

  const events = await readTranscript(transcript.filePath);
  assert.equal(events[0].seq, 7);
});

test("TD-55: append coordinates seq across multiple transcript instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-transcript-concurrent-seq-"));
  const filePath = join(dir, "run.jsonl");
  const a = new JsonlTranscript(filePath, { runId: "run_seq_race", agentId: "agent_x" });
  const b = new JsonlTranscript(filePath, { runId: "run_seq_race", agentId: "agent_x" });

  await Promise.all(Array.from({ length: 20 }, (_, i) => {
    const writer = i % 2 === 0 ? a : b;
    return writer.append("run.event", { kind: "test", index: i });
  }));

  const events = await readTranscript(filePath);
  const seqs = events.map((e) => e.seq);
  assert.equal(new Set(seqs).size, events.length, "seq values must be unique across writers");
  assert.deepEqual(seqs, Array.from({ length: events.length }, (_, i) => i + 1),
    "seq values must be monotonic in transcript order");
});

test("findState returns pending for empty events", () => {
  assert.equal(findState([]), "pending");
});

test("findState uses last run.state_change.to when present", () => {
  const events = [
    { type: "run.started", seq: 1 },
    { type: "run.state_change", from: "pending", to: "submitted", seq: 2 },
    { type: "run.state_change", from: "submitted", to: "running", seq: 3 },
    { type: "run.state_change", from: "running", to: "completed", seq: 4 },
  ];
  assert.equal(findState(events), "completed");
});

test("findState falls back to legacy event type when no state_change", () => {
  // 旧 transcript 兜底：completed 终态
  assert.equal(findState([{ type: "run.completed" }]), "completed");
  assert.equal(findState([{ type: "workflow.completed" }]), "completed");
  assert.equal(findState([{ type: "run.timed_out" }]), "timed_out");
  assert.equal(findState([{ type: "run.aborted" }]), "aborted");
  assert.equal(findState([{ type: "run.error" }]), "failed");
  assert.equal(findState([{ type: "run.stop_requested" }]), "aborted");
  // 非终态事件 → running（旧行为）
  assert.equal(findState([{ type: "run.started" }]), "running");
  assert.equal(findState([{ type: "messages.collected" }]), "running");
});

test("findState prefers state_change over legacy event", () => {
  // 即使最后有 completed 事件，state_change 更明确
  const events = [
    { type: "run.started", seq: 1 },
    { type: "run.state_change", from: "running", to: "failed", seq: 2 },
    { type: "run.completed", seq: 3 }, // 这条不该覆盖 state_change 的 failed
  ];
  assert.equal(findState(events), "failed");
});

test("findState lets a later terminal legacy event override non-terminal state_change", () => {
  const events = [
    { type: "run.started", seq: 1 },
    { type: "run.state_change", from: "pending", to: "submitted", seq: 2 },
    { type: "run.stop_requested", seq: 3 },
  ];
  assert.equal(findState(events), "aborted");
});

// --- TD-102 Batch 1B: workflow transcript outcome semantics ---

test("TD-102: workflow.completed {completed:true} → findState returns completed", () => {
  const events = [
    { type: "workflow.started" },
    { type: "workflow.completed", completed: true },
  ];
  assert.equal(findState(events), "completed");
});

test("TD-102: workflow.completed {completed:false} → findState returns failed", () => {
  const events = [
    { type: "workflow.started" },
    { type: "workflow.completed", completed: false },
  ];
  assert.equal(findState(events), "failed");
});

test("findLastEventSeq returns max seq", () => {
  const events = [
    { type: "run.started", seq: 1 },
    { type: "run.completed", seq: 5 },
    { type: "run.state_change", seq: 3 },
  ];
  assert.equal(findLastEventSeq(events), 5);
});

test("findLastEventSeq returns 0 when no seq fields (legacy)", () => {
  const events = [
    { type: "run.started" },
    { type: "run.completed" },
  ];
  assert.equal(findLastEventSeq(events), 0);
});

test("RUN_STATES and TERMINAL_STATES constants are correct", () => {
  assert.deepEqual(RUN_STATES, [
    "pending", "submitted", "running",
    "completed", "failed", "aborted", "timed_out",
  ]);
  assert.deepEqual(TERMINAL_STATES, ["completed", "failed", "aborted", "timed_out"]);
  // 终态都是 RUN_STATES 的子集
  for (const t of TERMINAL_STATES) {
    assert.ok(RUN_STATES.includes(t));
  }
});

test("TD-104: transcript redacts nested secret values in append and transition batches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-transcript-redact-"));
  const previous = process.env.WAO_TEST_API_KEY;
  const secret = "wao-test-secret-value-104";
  process.env.WAO_TEST_API_KEY = secret;
  try {
    const transcript = new JsonlTranscript(join(dir, "run.jsonl"), {
      runId: "run_redact",
      agentId: "test_agent",
    });

    await transcript.append("run.event", {
      kind: "tool_result",
      output: { nested: [`before ${secret} after`] },
    });
    await transcript.transitionState("running", "failed", `reason ${secret}`, {
      attemptEvents: [{ type: "run.attempt", payload: { detail: secret } }],
      factEvents: [{ type: "run.error", payload: { error: secret } }],
    });
    await transcript.transitionState("failed", "aborted", `retry ${secret}`);

    const raw = await readFile(transcript.filePath, "utf8");
    assert.equal(raw.includes(secret), false, "raw JSONL must not contain the secret value");
    assert.match(raw, /\[REDACTED:WAO_TEST_API_KEY\]/);
  } finally {
    if (previous === undefined) delete process.env.WAO_TEST_API_KEY;
    else process.env.WAO_TEST_API_KEY = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-104: stream redaction preserves UTF-8 boundaries and proxy credentials", () => {
  const secret = "密钥-test-value";
  const redactor = createSecretRedactor(
    { HTTP_PROXY: "http://user:password@example.invalid", CUSTOM_CHANNEL: secret },
    ["CUSTOM_CHANNEL"],
  );
  const stream = redactor.createStream();
  const bytes = Buffer.from(`prefix ${secret} suffix`, "utf8");
  const split = Buffer.from("prefix 密", "utf8").length - 1;
  const output = stream.write(bytes.subarray(0, split))
    + stream.write(bytes.subarray(split))
    + stream.end();

  assert.equal(output.includes(secret), false);
  assert.match(output, /\[REDACTED:CUSTOM_CHANNEL\]/);
  assert.equal(redactor.redactString("http://user:password@example.invalid"), "[REDACTED:HTTP_PROXY]");
});

test("TD-104: transcript envelope fields cannot be overridden by payload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-transcript-envelope-"));
  try {
    const transcript = new JsonlTranscript(join(dir, "run.jsonl"), {
      runId: "run_authoritative",
      agentId: "agent_authoritative",
    });
    const event = await transcript.append("run.event", {
      ts: "forged",
      seq: 999,
      runId: "run_forged",
      agentId: "agent_forged",
      type: "run.completed",
      kind: "message",
    });

    assert.equal(event.runId, "run_authoritative");
    assert.equal(event.agentId, "agent_authoritative");
    assert.equal(event.type, "run.event");
    assert.equal(event.seq, 1);
    assert.notEqual(event.ts, "forged");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findLatest returns the latest event of a given type", () => {
  const events = [
    { type: "run.state_change", to: "submitted", seq: 1 },
    { type: "run.state_change", to: "running", seq: 2 },
    { type: "run.completed", seq: 3 },
  ];
  const latest = findLatest(events, "run.state_change");
  assert.equal(latest.to, "running");
  assert.equal(findLatest(events, "nonexistent"), undefined);
});

// ============================================================
// M12-1S2: lock-scoped idempotent repackage appends + recovery facts
// ============================================================
//
// tryAppendRepackageCreated / tryAppendRepackageVerification are the lock-scoped
// CAS primitives the model-free repackage service uses. Each appends at most one
// event for the runId under the cross-process append lock (re-reading inside the
// lock so a concurrent/retry caller yields to the existing event). validateDeliveryFacts
// gains an additive `recoveryAcceptable` flag so the decide gate can admit a
// recovery accept for a terminally-failed disallowed_path run WITHOUT drifting
// the normal completed-run accept path.

const M12_RUN = "run_m12s2_transcript";
const M12_AGENT = "coder_hq";
const GOOD_COMMIT = "d".repeat(40);
const BASE_COMMIT = "b".repeat(40);

function m12Ref(overrides = {}) {
  return {
    schemaVersion: 1, kind: "git_commit", runId: M12_RUN,
    baseCommit: BASE_COMMIT, deliveryCommit: GOOD_COMMIT, branch: `wao/${M12_RUN}`,
    worktreePath: "/fake/wt", changedFiles: ["root.txt", "src/a.js"],
    verification: { status: "pending", commands: ["npm test"] },
    acceptance: { status: "pending", reviewerType: "lead_agent" },
    integration: { status: "pending", targetCommit: null },
    ...overrides,
  };
}

test("M12-1S2-T1: tryAppendRepackageCreated appends created+provenance once, yields on retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "m12s2-t1-"));
  try {
    const filePath = join(dir, `${M12_RUN}.jsonl`);
    const t = new JsonlTranscript(filePath, { runId: M12_RUN, agentId: M12_AGENT });
    await t.append("run.started", {
      delivery: { allowedPaths: ["src"], baseCommit: BASE_COMMIT },
    });
    await t.append("run.delivery_failed", { deliveryCode: "disallowed_path" });
    const first = await t.tryAppendRepackageCreated({
      delivery: m12Ref(), approvedAllowedPaths: ["root.txt", "src"], source: "packaged",
    });
    assert.equal(first.created, true);
    assert.equal(first.ref.deliveryCommit, GOOD_COMMIT);

    const events = await readTranscript(filePath);
    assert.equal(events.filter((e) => e.type === "run.delivery_created").length, 1);
    const prov = events.find((e) => e.type === "run.delivery_repackaged");
    assert.ok(prov, "provenance event appended atomically with created");
    assert.deepEqual(prov.approvedAllowedPaths, ["root.txt", "src"]);
    assert.equal(prov.source, "packaged");
    assert.equal(prov.delivery.deliveryCommit, GOOD_COMMIT);

    // Retry / concurrent caller yields to the existing created event.
    const second = await t.tryAppendRepackageCreated({
      delivery: m12Ref({ deliveryCommit: "e".repeat(40) }), approvedAllowedPaths: ["root.txt", "src"], source: "packaged",
    });
    assert.equal(second.created, false);
    assert.equal(second.ref.deliveryCommit, GOOD_COMMIT, "yields the existing authoritative ref");

    const events2 = await readTranscript(filePath);
    assert.equal(events2.filter((e) => e.type === "run.delivery_created").length, 1, "still exactly one created");
    assert.equal(events2.filter((e) => e.type === "run.delivery_repackaged").length, 1, "still one provenance");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-1S2-T2: tryAppendRepackageVerification records exactly one outcome, yields on retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "m12s2-t2-"));
  try {
    const filePath = join(dir, `${M12_RUN}.jsonl`);
    const t = new JsonlTranscript(filePath, { runId: M12_RUN, agentId: M12_AGENT });
    await t.append("run.started", {
      delivery: { allowedPaths: ["src"], baseCommit: BASE_COMMIT },
    });
    await t.append("run.delivery_failed", { deliveryCode: "disallowed_path" });
    await t.tryAppendRepackageCreated({
      delivery: m12Ref(), approvedAllowedPaths: ["root.txt", "src"], source: "packaged",
    });

    const first = await t.tryAppendRepackageVerification({
      delivery: { ...m12Ref(), verification: { status: "passed", commands: ["npm test"], verifiedCommit: GOOD_COMMIT, results: [] } },
      outcome: "passed",
    });
    assert.equal(first.recorded, true);

    const second = await t.tryAppendRepackageVerification({
      delivery: m12Ref(), outcome: "failed",
    });
    assert.equal(second.recorded, false, "yields to existing outcome");
    assert.equal(second.outcome, "passed", "reports the durable winner, not the losing local outcome");

    const events = await readTranscript(filePath);
    assert.equal(events.filter((e) => e.type === "run.delivery_verification_passed").length, 1);
    assert.equal(events.filter((e) => e.type === "run.delivery_verification_failed").length, 0);

    await assert.rejects(
      () => t.tryAppendRepackageVerification({
        delivery: m12Ref({ deliveryCommit: "e".repeat(40) }),
        outcome: "passed",
      }),
      /another delivery|identity|delivery_created/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-1S2-T2B: tryAppendRepackageVerification rejects an orphan outcome without mutation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "m12s2-t2b-"));
  try {
    const filePath = join(dir, `${M12_RUN}.jsonl`);
    const t = new JsonlTranscript(filePath, { runId: M12_RUN, agentId: M12_AGENT });
    await t.append("run.started", {
      delivery: { allowedPaths: ["src"], baseCommit: BASE_COMMIT },
    });
    await t.append("run.delivery_failed", { deliveryCode: "disallowed_path" });
    const before = await readFile(filePath, "utf8");

    await assert.rejects(
      () => t.tryAppendRepackageVerification({
        delivery: m12Ref(),
        outcome: "passed",
      }),
      (err) => err instanceof RepackageCasPolicyError && err.code === "candidate_ineligible",
    );

    assert.equal(await readFile(filePath, "utf8"), before, "orphan rejection is byte-identical");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-1S2-T3: validateDeliveryFacts recoveryAcceptable true only on the strict recovery chain", () => {
  const created = m12Ref();
  const verified = { ...created, verification: { status: "passed", commands: ["npm test"], verifiedCommit: GOOD_COMMIT, results: [] } };
  const provenance = {
    type: "run.delivery_repackaged",
    runId: M12_RUN,
    delivery: created,
    approvedAllowedPaths: ["root.txt", "src"],
    source: "packaged",
  };

  // Full recovery chain: disallowed_path failed + provenance + passed.
  const ok = [
    {
      type: "run.started",
      runId: M12_RUN,
      delivery: { allowedPaths: ["src"], baseCommit: BASE_COMMIT },
    },
    { type: "run.delivery_failed", runId: M12_RUN, deliveryCode: "disallowed_path" },
    { type: "run.delivery_created", runId: M12_RUN, delivery: created },
    provenance,
    { type: "run.delivery_verification_passed", runId: M12_RUN, delivery: verified },
  ];
  const okFacts = validateDeliveryFacts(ok);
  assert.equal(okFacts.valid, true);
  assert.equal(okFacts.recoveryAcceptable, true);

  // Missing provenance → not recovery-acceptable.
  const noProv = ok.filter((e) => e.type !== "run.delivery_repackaged");
  assert.equal(validateDeliveryFacts(noProv).recoveryAcceptable, false);

  // Non-disallowed failure code → not recovery-acceptable.
  const wrongCode = ok.map((e) => e.type === "run.delivery_failed" ? { ...e, deliveryCode: "empty_diff" } : e);
  assert.equal(validateDeliveryFacts(wrongCode).recoveryAcceptable, false);

  // Verification not passed → not recovery-acceptable.
  const failed = ok.map((e) => e.type === "run.delivery_verification_passed"
    ? { ...e, type: "run.delivery_verification_failed", delivery: { ...verified, verification: { ...verified.verification, status: "failed" } } }
    : e);
  assert.equal(validateDeliveryFacts(failed).recoveryAcceptable, false);

  // Duplicate/malformed provenance cannot authorize recovery acceptance.
  assert.equal(validateDeliveryFacts(ok.concat(provenance)).recoveryAcceptable, false);
  const narrow = ok.map((e) => e.type === "run.delivery_repackaged"
    ? { ...e, approvedAllowedPaths: ["src"] }
    : e);
  assert.equal(validateDeliveryFacts(narrow).recoveryAcceptable, false);

  const originalWider = ok.map((e) => {
    if (e.type === "run.started") {
      return { ...e, delivery: { ...e.delivery, allowedPaths: ["docs", "src"] } };
    }
    if (e.type === "run.delivery_created" || e.type === "run.delivery_verification_passed") {
      return { ...e, delivery: { ...e.delivery, changedFiles: ["src/a.js"] } };
    }
    if (e.type === "run.delivery_repackaged") {
      return {
        ...e,
        delivery: { ...e.delivery, changedFiles: ["src/a.js"] },
        approvedAllowedPaths: ["src"],
      };
    }
    return e;
  });
  assert.equal(
    validateDeliveryFacts(originalWider).recoveryAcceptable,
    false,
    "approved scope must also cover the original delivery contract",
  );
});

// ============================================================
// M12-6: root cause for the runAwaitResult usable-event boundary.
//
// The shared transcript SSOT projections read envelope fields directly. A
// JSON-valid but NON-usable event — null / primitive / array — is not a
// transcript event:
//   - null makes findState / findLastEventSeq throw a TypeError (null.type /
//     null.seq), which is exactly what escaped as a top-level
//     "run_await_result failed" before runAwaitResult reduced every snapshot to
//     its usable events first;
//   - primitive/array do NOT throw but silently derive a wrong state/cursor.
// These tests pin the unsafe-on-non-usable behavior of the SHARED projections
// so the runAwaitResult usable-event boundary is never removed without
// re-exposing the crash.
// ============================================================

test("M12-6 root cause: findState/findLastEventSeq throw TypeError on a null event", () => {
  assert.throws(() => findState([null]), TypeError);
  assert.throws(() => findLastEventSeq([null]), TypeError);
});

test("M12-6 root cause: a null anywhere in the array still throws (no implicit skip)", () => {
  // findState scans every event; a null after a usable event still throws.
  assert.throws(() => findState([{ type: "run.completed" }, null]), TypeError);
  assert.throws(() => findLastEventSeq([{ type: "run.completed", seq: 1 }, null]), TypeError);
});

test("M12-6 root cause: primitive/array events are non-usable (silent wrong derive, not a throw)", () => {
  // A bare primitive/array is JSON-valid but not a transcript event. findState
  // does not throw but silently infers "running" from a non-event;
  // findLastEventSeq silently returns 0. They are non-usable and must be
  // filtered before derive.
  assert.equal(findState([42]), "running");
  assert.equal(findLastEventSeq([42]), 0);
  assert.doesNotThrow(() => findState([[1, 2]]));
  assert.equal(findLastEventSeq([[1, 2]]), 0);
  assert.equal(findState(["str"]), "running");
});

// ============================================================
// M12-6 Package 3B1: fail-closed + identity-bound reverify chain.
//
// The reverify audit chain must fail closed and stay identity-bound:
//   - A reverify event whose ENVELOPE runId differs from the requested run but
//     whose embedded DeliveryRef targets the requested run is a durable
//     CONFLICT — projectReverifyChain must project "malformed", never filter
//     the event away into "none"/"pending"/"complete".
//   - A persisted requested event with an unknown reason, blank/non-string/
//     too-many/too-long setup commands, or a mismatched embedded identity
//     (runId/commit/base/artifact) is malformed and must NEVER project an
//     effective pass, reach decision acceptance, or be reused by the CAS
//     primitives for verification.
//   - The lock-scoped CAS appends consider ALL durable reverify events (any
//     envelope) and refuse to append a second event onto a conflict.
// ============================================================

const REV_RUN = "run_m12p3b1_proj";
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
  // The verification-event contract shape: status agrees EXACTLY with the type,
  // verifiedCommit is canonical + equal to the immutable deliveryCommit, and a
  // failed ref carries a closed-set failureCode while an unavailable ref
  // carries a non-empty unavailableReason. Tests that break one aspect override
  // it independently.
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

test("M12-6-3B1-P1: a foreign-envelope requested event targeting this run is a visible conflict → malformed (never filtered to none)", () => {
  const p = projectReverifyChain(
    [revRequested({ runId: "run_foreign" })],
    REV_RUN,
    revRef(),
  );
  assert.equal(p.status, "malformed", "the foreign-envelope event must never be filtered away");
  assert.equal(p.effectiveStatus, null);
  assert.equal(p.reason, null);
});

test("M12-6-3B1-P2: a foreign-envelope outcome event is a conflict for EACH outcome type independently (never pending/complete)", () => {
  for (const outcome of ["passed", "failed", "unavailable"]) {
    // A valid bound request + a foreign-envelope outcome: the foreign outcome
    // must not be filtered into a clean "pending" chain.
    const p = projectReverifyChain(
      [revRequested(), revOutcome(outcome, { runId: "run_foreign" })],
      REV_RUN,
      revRef(),
    );
    assert.equal(p.status, "malformed", `${outcome}: foreign outcome with valid request`);
    assert.equal(p.effectiveStatus, null, `${outcome}: no effective status may project`);
    // The foreign outcome alone must not look like a clean "none" chain.
    const alone = projectReverifyChain(
      [revOutcome(outcome, { runId: "run_foreign" })],
      REV_RUN,
      revRef(),
    );
    assert.equal(alone.status, "malformed", `${outcome}: foreign outcome alone`);
  }
});

test("M12-6-3B1-P3: a persisted request with an unknown reason is malformed — never projects effective pass, never accepts", () => {
  const p = projectReverifyChain(
    [revRequested({ reason: "not_a_real_reason" }), revOutcome("passed")],
    REV_RUN,
    revRef(),
  );
  assert.equal(p.status, "malformed", "an unknown persisted reason must not make the chain complete");
  assert.equal(p.effectiveStatus, null, "a garbage request must never project an effective pass");

  // Decision acceptance path: validateDeliveryFacts must keep the EFFECTIVE
  // status at the original failure for a malformed chain.
  const facts = validateDeliveryFacts([
    { type: "run.delivery_created", runId: REV_RUN, delivery: revRef() },
    {
      type: "run.delivery_verification_failed",
      runId: REV_RUN,
      delivery: revRef({
        verification: { status: "failed", failureCode: "command_failed", commands: ["assert"], verifiedCommit: REV_COMMIT, results: [] },
      }),
      deliveryCommit: REV_COMMIT,
    },
    revRequested({ reason: "not_a_real_reason" }),
    revOutcome("passed"),
  ]);
  assert.equal(facts.reverifyStatus, "malformed");
  assert.equal(facts.effectiveVerificationStatus, "failed", "effective status stays at the original failure");
});

test("M12-6-3B1-P4: a persisted request with blank/non-string/too-many/too-long/non-array setup commands is malformed", () => {
  const badSetup = [
    ["blank command", ["  "]],
    ["non-string command", ["ok", 7]],
    ["too many commands", Array.from({ length: 33 }, () => "x")],
    ["too long command", ["x".repeat(513)]],
    ["non-array", { cmd: "x" }],
  ];
  for (const [label, setupCommands] of badSetup) {
    const p = projectReverifyChain(
      [revRequested({ setupCommands }), revOutcome("passed")],
      REV_RUN,
      revRef(),
    );
    assert.equal(p.status, "malformed", label);
    assert.equal(p.effectiveStatus, null, `${label}: no effective pass`);
  }
});

test("M12-6-3B1-P5: mismatched embedded identity (runId/commit/base/missing artifact) is malformed and never projects effective pass", () => {
  const mismatches = [
    ["embedded runId", { delivery: revRef({ runId: "run_other" }) }],
    ["embedded deliveryCommit", { delivery: revRef({ deliveryCommit: "e".repeat(40) }) }],
    ["embedded baseCommit", { delivery: revRef({ baseCommit: "f".repeat(40) }) }],
    ["missing artifact (no delivery)", { delivery: undefined }],
  ];
  for (const [label, reqOverrides] of mismatches) {
    const p = projectReverifyChain(
      [revRequested(reqOverrides), revOutcome("passed")],
      REV_RUN,
      revRef(),
    );
    assert.equal(p.status, "malformed", label);
    assert.equal(p.effectiveStatus, null, `${label}: no effective pass`);
  }
});

test("M12-6-3B1-P6: valid chains still project none/pending/complete (regression)", () => {
  assert.equal(projectReverifyChain([], REV_RUN, revRef()).status, "none");
  const pending = projectReverifyChain([revRequested()], REV_RUN, revRef());
  assert.equal(pending.status, "pending");
  assert.equal(pending.reason, "tooling_invalid");
  const complete = projectReverifyChain([revRequested(), revOutcome("passed")], REV_RUN, revRef());
  assert.equal(complete.status, "complete");
  assert.equal(complete.effectiveStatus, "passed");
});

test("M12-6-3B1-C1: tryAppendReverifyRequested never appends a second request onto a foreign-envelope requested event (fail closed, one chain maximum)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "m12p3b1-c1-"));
  try {
    const filePath = join(dir, `${REV_RUN}.jsonl`);
    // A foreign-envelope requested event whose embedded DeliveryRef targets
    // THIS run — the CAS must see it and refuse to start a second chain.
    await writeFile(filePath, JSON.stringify({
      ts: "2026-08-01T00:00:00.000Z",
      seq: 1,
      runId: "run_foreign",
      agentId: REV_AGENT,
      type: "run.delivery_reverification_requested",
      delivery: revRef(),
      deliveryCommit: REV_COMMIT,
      reason: "tooling_invalid",
    }) + "\n", "utf8");
    const t = new JsonlTranscript(filePath, { runId: REV_RUN, agentId: REV_AGENT });
    const before = await readFile(filePath, "utf8");
    await assert.rejects(
      () => t.tryAppendReverifyRequested({ delivery: revRef(), reason: "tooling_invalid" }),
      /malformed|conflict|chain/i,
      "must fail closed instead of appending a second request",
    );
    assert.equal(await readFile(filePath, "utf8"), before, "no second request appended");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-6-3B1-C2: tryAppendReverifyRequested refuses to yield/reuse a persisted request with unknown reason or malformed setup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "m12p3b1-c2-"));
  try {
    const filePath = join(dir, `${REV_RUN}.jsonl`);
    const seed = (payload) => writeFile(filePath, JSON.stringify({
      ts: "2026-08-01T00:00:00.000Z",
      seq: 1,
      runId: REV_RUN,
      agentId: REV_AGENT,
      type: "run.delivery_reverification_requested",
      delivery: revRef(),
      deliveryCommit: REV_COMMIT,
      ...payload,
    }) + "\n", "utf8");

    for (const [label, payload] of [
      ["unknown reason", { reason: "not_a_real_reason" }],
      ["blank setup command", { reason: "tooling_invalid", setupCommands: ["  "] }],
      ["non-string setup command", { reason: "tooling_invalid", setupCommands: ["ok", 7] }],
      ["too many setup commands", { reason: "tooling_invalid", setupCommands: Array.from({ length: 33 }, () => "x") }],
      ["too long setup command", { reason: "tooling_invalid", setupCommands: ["x".repeat(513)] }],
    ]) {
      await seed(payload);
      const t = new JsonlTranscript(filePath, { runId: REV_RUN, agentId: REV_AGENT });
      await assert.rejects(
        () => t.tryAppendReverifyRequested({ delivery: revRef(), reason: "tooling_invalid" }),
        /malformed|reason|setup|chain/i,
        label,
      );
      assert.equal((await readFile(filePath, "utf8")).trim().split("\n").length, 1, `${label}: nothing appended`);
      await rm(filePath, { force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-6-3B1-C3: tryAppendReverifyOutcome never appends onto a foreign-envelope conflict or a garbage request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "m12p3b1-c3-"));
  try {
    const filePath = join(dir, `${REV_RUN}.jsonl`);
    const seedLine = (ev) => JSON.stringify({
      ts: "2026-08-01T00:00:00.000Z",
      seq: 1,
      runId: REV_RUN,
      agentId: REV_AGENT,
      ...ev,
    });

    // 1. A foreign-envelope passed outcome (identity targets this run) exists.
    await writeFile(filePath, seedLine({
      type: "run.delivery_reverification_passed",
      runId: "run_foreign",
      delivery: revRef({ verification: { status: "passed", commands: ["assert"], verifiedCommit: REV_COMMIT, results: [] } }),
      deliveryCommit: REV_COMMIT,
    }) + "\n", "utf8");
    let t = new JsonlTranscript(filePath, { runId: REV_RUN, agentId: REV_AGENT });
    await assert.rejects(
      () => t.tryAppendReverifyOutcome({ delivery: revRef(), outcome: "passed" }),
      /malformed|exactly one|chain/i,
      "must not append a second outcome onto the foreign-envelope conflict",
    );
    assert.equal((await readFile(filePath, "utf8")).trim().split("\n").length, 1, "no outcome appended");
    await rm(filePath, { force: true });

    // 2. A foreign-envelope requested event + a valid request: the exactly-one
    //    count must span ALL durable events, so appending must be refused.
    await writeFile(filePath, [
      seedLine({ type: "run.delivery_reverification_requested", delivery: revRef(), deliveryCommit: REV_COMMIT, reason: "tooling_invalid" }),
      seedLine({ type: "run.delivery_reverification_requested", runId: "run_foreign", delivery: revRef(), deliveryCommit: REV_COMMIT, reason: "tooling_invalid" }),
    ].join("\n") + "\n", "utf8");
    t = new JsonlTranscript(filePath, { runId: REV_RUN, agentId: REV_AGENT });
    await assert.rejects(
      () => t.tryAppendReverifyOutcome({ delivery: revRef(), outcome: "passed" }),
      /malformed|exactly one|chain/i,
      "must not append an outcome onto a duplicated request chain",
    );
    assert.equal((await readFile(filePath, "utf8")).trim().split("\n").length, 2, "no outcome appended");
    await rm(filePath, { force: true });

    // 3. A garbage-shaped persisted request (unknown reason): never append an
    //    outcome onto it.
    await writeFile(filePath, seedLine({
      type: "run.delivery_reverification_requested",
      reason: "not_a_real_reason",
      delivery: revRef(),
      deliveryCommit: REV_COMMIT,
    }) + "\n", "utf8");
    t = new JsonlTranscript(filePath, { runId: REV_RUN, agentId: REV_AGENT });
    await assert.rejects(
      () => t.tryAppendReverifyOutcome({ delivery: revRef(), outcome: "passed" }),
      /malformed|reason|chain/i,
      "must not append an outcome onto a garbage request",
    );
    assert.equal((await readFile(filePath, "utf8")).trim().split("\n").length, 1, "no outcome appended");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-6-3B1-C4: CAS regression — valid persisted chains still yield the recorded reason/setup/outcome without duplicates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "m12p3b1-c4-"));
  try {
    const filePath = join(dir, `${REV_RUN}.jsonl`);
    await writeFile(filePath, [
      JSON.stringify({
        ts: "2026-08-01T00:00:00.000Z", seq: 1, runId: REV_RUN, agentId: REV_AGENT,
        type: "run.delivery_reverification_requested", delivery: revRef(),
        deliveryCommit: REV_COMMIT, reason: "environment_contaminated",
        setupCommands: ["setup-prepare"],
      }),
      JSON.stringify({
        ts: "2026-08-01T00:00:00.000Z", seq: 2, runId: REV_RUN, agentId: REV_AGENT,
        type: "run.delivery_reverification_passed", delivery: revRef({
          verification: { status: "passed", commands: ["assert"], verifiedCommit: REV_COMMIT, results: [] },
        }),
        deliveryCommit: REV_COMMIT,
      }),
    ].join("\n") + "\n", "utf8");
    const t = new JsonlTranscript(filePath, { runId: REV_RUN, agentId: REV_AGENT });
    const req = await t.tryAppendReverifyRequested({ delivery: revRef(), reason: "tooling_invalid" });
    assert.equal(req.requested, false);
    assert.equal(req.reason, "environment_contaminated", "yields the RECORDED reason, never the caller's");
    assert.deepEqual(req.setupCommands, ["setup-prepare"], "yields the RECORDED setup, never the caller's");
    const out = await t.tryAppendReverifyOutcome({ delivery: revRef(), outcome: "failed" });
    assert.equal(out.recorded, false);
    assert.equal(out.outcome, "passed", "yields the durable winner outcome");
    assert.equal((await readFile(filePath, "utf8")).trim().split("\n").length, 2, "no duplicate events");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-6-3B1-C5: CAS regression — identity-mismatched persisted reverify events fail closed (no reuse, no extension)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "m12p3b1-c5-"));
  try {
    const filePath = join(dir, `${REV_RUN}.jsonl`);
    // Persisted request whose embedded deliveryCommit is a DIFFERENT canonical
    // commit than the candidate.
    await writeFile(filePath, JSON.stringify({
      ts: "2026-08-01T00:00:00.000Z", seq: 1, runId: REV_RUN, agentId: REV_AGENT,
      type: "run.delivery_reverification_requested",
      delivery: revRef({ deliveryCommit: "e".repeat(40) }),
      deliveryCommit: "e".repeat(40),
      reason: "tooling_invalid",
    }) + "\n", "utf8");
    const t = new JsonlTranscript(filePath, { runId: REV_RUN, agentId: REV_AGENT });
    await assert.rejects(
      () => t.tryAppendReverifyRequested({ delivery: revRef(), reason: "tooling_invalid" }),
      /malformed|another delivery|identity|chain/i,
    );
    assert.equal((await readFile(filePath, "utf8")).trim().split("\n").length, 1, "no second request appended");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// M12-6 Package 3B1 (correction): top-level deliveryCommit +
// outcome verification-event contract.
//
// The reverify audit chain must fail closed on TWO additional durable
// conflicts, independently for requested and EVERY outcome type:
//   - TOP-LEVEL COMMIT BINDING: the event's top-level `deliveryCommit` must be
//     canonical AND equal to the embedded DeliveryRef.deliveryCommit (hence the
//     created commit). Missing / noncanonical / different → malformed. The CAS
//     must never reuse such a request (yielding its recorded setup for
//     verification) and must never extend such a chain, and the decision path
//     must never see an effective pass from it.
//   - OUTCOME VERIFICATION-EVENT CONTRACT: an outcome event's type must agree
//     EXACTLY with its embedded delivery.verification.status (closed-set
//     agreement), its verifiedCommit must be canonical + equal to the immutable
//     deliveryCommit, and its failure/unavailable shape must be closed-set
//     (failed → closed-set failureCode; unavailable → non-empty
//     unavailableReason) — the same verification event contract, with a single
//     shared allowlist (no duplication).
// ============================================================

test("M12-6-3B1-P7: a missing/noncanonical/different top-level deliveryCommit is malformed for the requested event AND each outcome type (never complete, never effective pass)", () => {
  const badTop = [
    ["missing", undefined],
    ["noncanonical", "not-a-commit"],
    ["different canonical", "e".repeat(40)],
  ];
  for (const [label, top] of badTop) {
    // Requested event with the bad top-level commit + a fully valid passed
    // outcome: the request must not bind, so the chain is malformed.
    const withReq = projectReverifyChain(
      [revRequested({ deliveryCommit: top }), revOutcome("passed")],
      REV_RUN,
      revRef(),
    );
    assert.equal(withReq.status, "malformed", `${label} top-level on requested: malformed`);
    assert.equal(withReq.effectiveStatus, null, `${label} requested: no effective pass`);
    // Outcome event with the bad top-level commit + a valid request: for EACH
    // outcome type independently.
    for (const outcome of ["passed", "failed", "unavailable"]) {
      const withOut = projectReverifyChain(
        [revRequested(), revOutcome(outcome, { deliveryCommit: top })],
        REV_RUN,
        revRef(),
      );
      assert.equal(withOut.status, "malformed", `${label} top-level on ${outcome} outcome: malformed`);
      assert.equal(withOut.effectiveStatus, null, `${label} ${outcome}: no effective pass`);
    }
  }
});

test("M12-6-3B1-P8: outcome type must agree exactly with the embedded delivery.verification.status — passed-with-failed-ref, failed-with-passed-ref, unavailable-with-passed-ref each malformed independently", () => {
  const mismatches = [
    ["passed event with failed ref", "passed", { status: "failed", commands: ["assert"], failureCode: "command_failed", verifiedCommit: REV_COMMIT, results: [] }],
    ["failed event with passed ref", "failed", { status: "passed", commands: ["assert"], verifiedCommit: REV_COMMIT, results: [] }],
    ["unavailable event with passed ref", "unavailable", { status: "passed", commands: ["assert"], verifiedCommit: REV_COMMIT, results: [] }],
  ];
  for (const [label, outcome, verification] of mismatches) {
    const p = projectReverifyChain(
      [revRequested(), revOutcome(outcome, { delivery: revRef({ verification }) })],
      REV_RUN,
      revRef(),
    );
    assert.equal(p.status, "malformed", label);
    assert.equal(p.effectiveStatus, null, `${label}: no effective status may project`);
    // The mismatched outcome ALONE (no request) must also be a conflict, never
    // a clean "none".
    const alone = projectReverifyChain(
      [revOutcome(outcome, { delivery: revRef({ verification }) })],
      REV_RUN,
      revRef(),
    );
    assert.equal(alone.status, "malformed", `${label}: alone`);
  }
});

test("M12-6-3B1-P8b: a missing/noncanonical/mismatched verifiedCommit is malformed for each outcome type (never complete, never effective pass)", () => {
  const badVC = [
    ["missing", undefined],
    ["noncanonical", "HEAD"],
    ["mismatched canonical", "e".repeat(40)],
  ];
  for (const [label, vc] of badVC) {
    for (const outcome of ["passed", "failed", "unavailable"]) {
      const verification = { status: outcome, commands: ["assert"], verifiedCommit: vc, results: [] };
      if (outcome === "failed") verification.failureCode = "command_failed";
      if (outcome === "unavailable") verification.unavailableReason = "no_assertions";
      const p = projectReverifyChain(
        [revRequested(), revOutcome(outcome, { delivery: revRef({ verification }) })],
        REV_RUN,
        revRef(),
      );
      assert.equal(p.status, "malformed", `${label} verifiedCommit on ${outcome} outcome`);
      assert.equal(p.effectiveStatus, null, `${label} ${outcome}: no effective pass`);
    }
  }
});

test("M12-6-3B1-P8c: failed outcomes need a closed-set failureCode; unavailable outcomes need a non-empty unavailableReason (same verification event contract, one shared allowlist)", () => {
  // failed with an unknown failureCode
  const unknownCode = projectReverifyChain(
    [revRequested(), revOutcome("failed", { delivery: revRef({ verification: { status: "failed", commands: ["assert"], failureCode: "not_a_real_code", verifiedCommit: REV_COMMIT, results: [] } }) })],
    REV_RUN,
    revRef(),
  );
  assert.equal(unknownCode.status, "malformed", "failed with unknown failureCode");
  assert.equal(unknownCode.effectiveStatus, null);
  // failed with a MISSING failureCode
  const missingCode = projectReverifyChain(
    [revRequested(), revOutcome("failed", { delivery: revRef({ verification: { status: "failed", commands: ["assert"], verifiedCommit: REV_COMMIT, results: [] } }) })],
    REV_RUN,
    revRef(),
  );
  assert.equal(missingCode.status, "malformed", "failed with missing failureCode");
  assert.equal(missingCode.effectiveStatus, null);
  // unavailable with a MISSING unavailableReason
  const missingReason = projectReverifyChain(
    [revRequested(), revOutcome("unavailable", { delivery: revRef({ verification: { status: "unavailable", commands: [], verifiedCommit: REV_COMMIT, results: [] } }) })],
    REV_RUN,
    revRef(),
  );
  assert.equal(missingReason.status, "malformed", "unavailable with missing unavailableReason");
  assert.equal(missingReason.effectiveStatus, null);
  // unavailable with a BLANK unavailableReason
  const blankReason = projectReverifyChain(
    [revRequested(), revOutcome("unavailable", { delivery: revRef({ verification: { status: "unavailable", commands: [], unavailableReason: "   ", verifiedCommit: REV_COMMIT, results: [] } }) })],
    REV_RUN,
    revRef(),
  );
  assert.equal(blankReason.status, "malformed", "unavailable with blank unavailableReason");
  assert.equal(blankReason.effectiveStatus, null);
  // Regression: contract-valid failed / unavailable chains stay complete.
  const failedOk = projectReverifyChain([revRequested(), revOutcome("failed")], REV_RUN, revRef());
  assert.equal(failedOk.status, "complete");
  assert.equal(failedOk.effectiveStatus, "failed");
  const unavailableOk = projectReverifyChain([revRequested(), revOutcome("unavailable")], REV_RUN, revRef());
  assert.equal(unavailableOk.status, "complete");
  assert.equal(unavailableOk.effectiveStatus, "unavailable");
});

test("M12-6-3B1-P9: decision acceptance never sees an effective pass for top-level commit mismatch, type/status disagreement, or verifiedCommit mismatch", () => {
  const originalFailed = {
    type: "run.delivery_verification_failed",
    runId: REV_RUN,
    delivery: revRef({
      verification: { status: "failed", failureCode: "command_failed", commands: ["assert"], verifiedCommit: REV_COMMIT, results: [] },
    }),
    deliveryCommit: REV_COMMIT,
  };
  const cases = [
    ["top-level outcome commit differs", [revRequested(), revOutcome("passed", { deliveryCommit: "e".repeat(40) })]],
    ["passed event with failed ref", [revRequested(), revOutcome("passed", { delivery: revRef({ verification: { status: "failed", failureCode: "command_failed", commands: ["assert"], verifiedCommit: REV_COMMIT, results: [] } }) })]],
    ["verifiedCommit differs", [revRequested(), revOutcome("passed", { delivery: revRef({ verification: { status: "passed", commands: ["assert"], verifiedCommit: "e".repeat(40), results: [] } }) })]],
  ];
  for (const [label, chain] of cases) {
    const facts = validateDeliveryFacts([
      { type: "run.delivery_created", runId: REV_RUN, delivery: revRef() },
      originalFailed,
      ...chain,
    ]);
    assert.equal(facts.reverifyStatus, "malformed", label);
    assert.equal(
      facts.effectiveVerificationStatus,
      "failed",
      `${label}: the effective status must stay at the original failure — acceptance must fail closed`,
    );
  }
});

test("M12-6-3B1-C6: CAS refuses to reuse or extend a chain whose top-level deliveryCommit is missing/noncanonical/different (requested + outcome)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "m12p3b1-c6-"));
  try {
    const filePath = join(dir, `${REV_RUN}.jsonl`);
    // A full-looking chain: valid request + passed outcome, but BOTH top-level
    // deliveryCommit values differ from the embedded immutable commit. The
    // embedded identity targets this run — the CAS must neither yield the
    // garbage request nor extend the garbage chain.
    await writeFile(filePath, [
      JSON.stringify({
        ts: "2026-08-01T00:00:00.000Z", seq: 1, runId: REV_RUN, agentId: REV_AGENT,
        type: "run.delivery_reverification_requested", delivery: revRef(),
        deliveryCommit: "e".repeat(40), reason: "tooling_invalid",
      }),
      JSON.stringify({
        ts: "2026-08-01T00:00:00.000Z", seq: 2, runId: REV_RUN, agentId: REV_AGENT,
        type: "run.delivery_reverification_passed", delivery: revRef({
          verification: { status: "passed", commands: ["assert"], verifiedCommit: REV_COMMIT, results: [] },
        }),
        deliveryCommit: "e".repeat(40),
      }),
    ].join("\n") + "\n", "utf8");
    const t = new JsonlTranscript(filePath, { runId: REV_RUN, agentId: REV_AGENT });
    await assert.rejects(
      () => t.tryAppendReverifyRequested({ delivery: revRef(), reason: "tooling_invalid" }),
      /malformed|commit|chain/i,
      "must not yield/reuse the request with the mismatched top-level commit",
    );
    await assert.rejects(
      () => t.tryAppendReverifyOutcome({ delivery: revRef(), outcome: "passed" }),
      /malformed|commit|chain/i,
      "must not extend the chain with the mismatched top-level commit",
    );
    assert.equal((await readFile(filePath, "utf8")).trim().split("\n").length, 2, "nothing appended to the malformed chain");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M12-6-3B1-C7: tryAppendReverifyOutcome never writes a self-poisoning outcome (type/status disagreement, missing verifiedCommit, unknown failureCode)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "m12p3b1-c7-"));
  try {
    const filePath = join(dir, `${REV_RUN}.jsonl`);
    // A valid persisted request — the chain is pending, so the CAS would append.
    await writeFile(filePath, JSON.stringify({
      ts: "2026-08-01T00:00:00.000Z", seq: 1, runId: REV_RUN, agentId: REV_AGENT,
      type: "run.delivery_reverification_requested", delivery: revRef(),
      deliveryCommit: REV_COMMIT, reason: "tooling_invalid",
    }) + "\n", "utf8");

    // 1. Declared outcome "passed" but the ref's embedded status is "failed".
    {
      const t = new JsonlTranscript(filePath, { runId: REV_RUN, agentId: REV_AGENT });
      await assert.rejects(
        () => t.tryAppendReverifyOutcome({
          delivery: revRef({ verification: { status: "failed", failureCode: "command_failed", commands: ["assert"], verifiedCommit: REV_COMMIT, results: [] } }),
          outcome: "passed",
        }),
        /status|agree|verification|contract|outcome/i,
        "must refuse a passed outcome whose ref says failed",
      );
      assert.equal((await readFile(filePath, "utf8")).trim().split("\n").length, 1, "no self-poisoning event appended");
    }
    // 2. Declared outcome "passed" with a MISSING verifiedCommit.
    {
      const t = new JsonlTranscript(filePath, { runId: REV_RUN, agentId: REV_AGENT });
      await assert.rejects(
        () => t.tryAppendReverifyOutcome({
          delivery: revRef({ verification: { status: "passed", commands: ["assert"], results: [] } }),
          outcome: "passed",
        }),
        /verifiedCommit|commit|verification|contract/i,
      );
      assert.equal((await readFile(filePath, "utf8")).trim().split("\n").length, 1, "no event without verifiedCommit appended");
    }
    // 3. Declared outcome "failed" with an UNKNOWN failureCode.
    {
      const t = new JsonlTranscript(filePath, { runId: REV_RUN, agentId: REV_AGENT });
      await assert.rejects(
        () => t.tryAppendReverifyOutcome({
          delivery: revRef({ verification: { status: "failed", failureCode: "not_a_real_code", commands: ["assert"], verifiedCommit: REV_COMMIT, results: [] } }),
          outcome: "failed",
        }),
        /failureCode|closed|contract|failure/i,
      );
      assert.equal((await readFile(filePath, "utf8")).trim().split("\n").length, 1, "no event with an unknown failureCode appended");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// M12-9: typed delivery-decision policy codes (machine protocol)
//
// The decision authority produces a typed, closed-set rejection CODE — never a
// parsed human message. validateDeliveryFacts returns the structured fact
// category per invalid branch; tryAppendDecision throws the dedicated
// DeliveryDecisionPolicyError carrying that code. The human message is kept
// ONLY for internal diagnostics and is NOT the machine protocol.
// ============================================================

const DEC_RUN = "run_decision_codes";
const DEC_BASE = "b".repeat(40);
const DEC_COMMIT = "d".repeat(40);
const DEC_OTHER_COMMIT = "e".repeat(40);

function decRef(overrides = {}) {
  return {
    schemaVersion: 1, kind: "git_commit", runId: DEC_RUN,
    baseCommit: DEC_BASE, deliveryCommit: DEC_COMMIT,
    branch: "wao/x", worktreePath: "/fake", changedFiles: ["a.js"],
    verification: { status: "passed", commands: [], verifiedCommit: DEC_COMMIT, results: [] },
    acceptance: { status: "pending" }, integration: { status: "pending", targetCommit: null },
    ...overrides,
  };
}

test("M12-9-T1: DELIVERY_DECISION_POLICY_CODES is the frozen closed set of policy codes", () => {
  assert.deepEqual(DELIVERY_DECISION_POLICY_CODES, [
    "verification_failed",
    "delivery_malformed",
    "terminal_not_eligible",
    "delivery_unavailable",
  ]);
  assert.equal(Object.isFrozen(DELIVERY_DECISION_POLICY_CODES), true);
  assert.equal(
    new Set(DELIVERY_DECISION_POLICY_CODES).size,
    DELIVERY_DECISION_POLICY_CODES.length,
    "no duplicates",
  );
});

test("M12-9-T2: DeliveryDecisionPolicyError carries a machine code + a human message", () => {
  const err = new DeliveryDecisionPolicyError("verification_failed", "human diagnostics only");
  assert.ok(err instanceof DeliveryDecisionPolicyError);
  assert.ok(err instanceof Error);
  assert.equal(err.code, "verification_failed");
  assert.equal(err.message, "human diagnostics only");
});

test("M12-9-T3: every invalid validateDeliveryFacts branch returns the structured fact category", () => {
  const cases = [
    ["missing delivery_created", [], "delivery_unavailable"],
    ["missing verification outcome", [
      { type: "run.delivery_created", runId: DEC_RUN, delivery: decRef() },
    ], "delivery_unavailable"],
    ["multiple delivery_created", [
      { type: "run.delivery_created", runId: DEC_RUN, delivery: decRef() },
      { type: "run.delivery_created", runId: DEC_RUN, delivery: decRef() },
    ], "delivery_malformed"],
    ["multiple verification outcomes", [
      { type: "run.delivery_created", runId: DEC_RUN, delivery: decRef() },
      { type: "run.delivery_verification_passed", runId: DEC_RUN, delivery: decRef() },
      { type: "run.delivery_verification_failed", runId: DEC_RUN, delivery: decRef() },
    ], "delivery_malformed"],
    ["non-canonical commit", [
      { type: "run.delivery_created", runId: DEC_RUN, delivery: decRef({ deliveryCommit: "HEAD" }) },
      { type: "run.delivery_verification_passed", runId: DEC_RUN, delivery: decRef({ deliveryCommit: "HEAD" }) },
    ], "delivery_malformed"],
    ["commit mismatch", [
      { type: "run.delivery_created", runId: DEC_RUN, delivery: decRef() },
      { type: "run.delivery_verification_passed", runId: DEC_RUN, delivery: decRef({ deliveryCommit: DEC_OTHER_COMMIT }) },
    ], "delivery_malformed"],
  ];
  for (const [label, events, code] of cases) {
    const facts = validateDeliveryFacts(events);
    assert.equal(facts.valid, false, label);
    assert.equal(facts.code, code, `${label}: structured category`);
    assert.equal(typeof facts.error, "string", `${label}: human diagnostics kept`);
    assert.ok(facts.error.length > 0, `${label}: human message non-empty`);
  }
});

test("M12-9-T4: tryAppendDecision throws the dedicated type with the machine code, appends nothing", async () => {
  const cases = [
    ["missing delivery_created", [], "delivery_unavailable"],
    ["multiple delivery_created", [
      ["run.delivery_created", { delivery: decRef() }],
      ["run.delivery_created", { delivery: decRef() }],
    ], "delivery_malformed"],
    ["commit mismatch", [
      ["run.delivery_created", { delivery: decRef() }],
      ["run.delivery_verification_passed", { delivery: decRef({ deliveryCommit: DEC_OTHER_COMMIT }) }],
    ], "delivery_malformed"],
  ];
  for (const [label, seed, expectedCode] of cases) {
    // A benign run.started seeds the file first (so the transcript exists even
    // for the no-created case); it never counts as a delivery fact.
    seed.unshift(["run.started", { backend: "claude-code" }]);
    const dir = await mkdtemp(join(tmpdir(), "m12-9-t4-"));
    try {
      const filePath = join(dir, `${DEC_RUN}.jsonl`);
      const t = new JsonlTranscript(filePath, { runId: DEC_RUN, agentId: "test" });
      for (const [type, payload] of seed) await t.append(type, payload);
      await assert.rejects(
        () => t.tryAppendDecision({ decision: "accepted", reason: "x" }),
        (err) => {
          assert.ok(err instanceof DeliveryDecisionPolicyError, `${label}: dedicated type`);
          assert.equal(err.code, expectedCode, `${label}: machine code`);
          assert.equal(typeof err.message, "string", `${label}: human message retained`);
          assert.ok(err.message.length > 0, `${label}: human message non-empty`);
          return true;
        },
      );
      const events = await readTranscript(filePath);
      assert.equal(
        events.filter((e) => e.type === "run.delivery_accepted" || e.type === "run.delivery_rejected").length,
        0,
        `${label}: no decision event appended`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("M12-9-T5: tryAppendDecision verification/terminal gates throw the dedicated type; reject stays reachable on unavailable", async () => {
  // Verification gate: accept requires passed (effective) verification.
  {
    const dir = await mkdtemp(join(tmpdir(), "m12-9-t5a-"));
    try {
      const filePath = join(dir, `${DEC_RUN}.jsonl`);
      const t = new JsonlTranscript(filePath, { runId: DEC_RUN, agentId: "test" });
      await t.append("run.delivery_created", { delivery: decRef() });
      // TD-179: the outcome event's embedded status must agree with its type
      // (the production appenders always write the matching status).
      await t.append("run.delivery_verification_failed", {
        delivery: decRef({
          verification: { status: "failed", failureCode: "command_failed", commands: [], verifiedCommit: DEC_COMMIT, results: [] },
        }),
      });
      await t.append("run.state_change", { from: "running", to: "completed", reason: "done" });
      await assert.rejects(
        () => t.tryAppendDecision({ decision: "accepted", reason: "x" }),
        (err) => {
          assert.ok(err instanceof DeliveryDecisionPolicyError, "verification gate: dedicated type");
          assert.equal(err.code, "verification_failed", "verification gate: machine code");
          assert.match(err.message, /Cannot accept: delivery verification is failed/, "human message kept");
          return true;
        },
      );
      const events = await readTranscript(filePath);
      assert.equal(
        events.filter((e) => e.type === "run.delivery_accepted" || e.type === "run.delivery_rejected").length,
        0,
        "verification gate: no decision event appended",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  // Terminal gate: passed verification but the run never reached a terminal state.
  {
    const dir = await mkdtemp(join(tmpdir(), "m12-9-t5b-"));
    try {
      const filePath = join(dir, `${DEC_RUN}.jsonl`);
      const t = new JsonlTranscript(filePath, { runId: DEC_RUN, agentId: "test" });
      await t.append("run.delivery_created", { delivery: decRef() });
      await t.append("run.delivery_verification_passed", { delivery: decRef() });
      await assert.rejects(
        () => t.tryAppendDecision({ decision: "accepted", reason: "x" }),
        (err) => {
          assert.ok(err instanceof DeliveryDecisionPolicyError, "terminal gate: dedicated type");
          assert.equal(err.code, "terminal_not_eligible", "terminal gate: machine code");
          assert.match(err.message, /Cannot accept: run terminal state is running/, "human message kept");
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  // Reject with an unavailable verification is ALLOWED (no bogus code thrown).
  {
    const dir = await mkdtemp(join(tmpdir(), "m12-9-t5c-"));
    try {
      const filePath = join(dir, `${DEC_RUN}.jsonl`);
      const t = new JsonlTranscript(filePath, { runId: DEC_RUN, agentId: "test" });
      await t.append("run.delivery_created", { delivery: decRef() });
      // TD-179: the outcome event's embedded status must agree with its type.
      await t.append("run.delivery_verification_unavailable", {
        delivery: decRef({
          verification: { status: "unavailable", unavailableReason: "no assertions", commands: [], verifiedCommit: DEC_COMMIT, results: [] },
        }),
      });
      await t.append("run.state_change", { from: "running", to: "completed", reason: "done" });
      const result = await t.tryAppendDecision({ decision: "rejected", reason: "bad" });
      assert.equal(result.accepted, true, "reject on unavailable verification succeeds");
      assert.equal(result.event.type, "run.delivery_rejected");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

// ============================================================
// TD-71: Windows append-lock transient EPERM/EBUSY bounded retry.
//
// On Windows, creating runs/<runId>.jsonl.seq.lock can fail TRANSIENTLY with
// EPERM or EBUSY (antivirus / search indexer / filesystem filter briefly
// blocking the new path) even when no other process holds the lock. The pre-fix
// acquireAppendLock retried ONLY EEXIST, so a single transient EPERM/EBUSY
// aborted an otherwise healthy append. These tests pin the bounded-retry fix:
//   - EPERM/EBUSY are retried within the SAME append-lock timeout/poll budget
//     (no second timeout source);
//   - EPERM/EBUSY never reach the stale-lock deletion path (EEXIST-only) — a
//     live lock is never deleted to paper over a transient filesystem error;
//   - a transient blip followed by success appends EXACTLY ONCE with correct seq;
//   - repeated transient failure exhausts at the existing bound and throws the
//     stable timeout, preserving the causal error (no infinite retry, nothing
//     hidden);
//   - any non-transient error throws immediately and preserves its causal code.
//
// Determinism: the OS is NEVER relied on to reproduce a lock. The append-lock
// filesystem/clock seam (__setAppendLockFsForTest) injects synthetic EPERM/EBUSY
// and a controllable clock so the retry bound is exercised in microseconds; each
// test resets the seam in a finally block so it cannot leak.
// ============================================================

// A lock-path-shaped string used by the direct (fully-fake-FS) tests; no real
// file is created because open is fully faked.
const TD71_LOCK_FILE = join(tmpdir(), "td71-direct.jsonl");
const TD71_LOCK_PATH = `${TD71_LOCK_FILE}.seq.lock`;

function transientLockError(code) {
  const err = new Error(code === "EPERM" ? "operation not permitted" : "resource busy");
  err.code = code;
  return err;
}

function fakeHandle() {
  return { writeFile: async () => {}, close: async () => {} };
}

test("TD-71: a transient EPERM on lock create is retried and then succeeds (never throws the raw EPERM)", async () => {
  const reads = [];
  let openCalls = 0;
  __setAppendLockFsForTest({
    open: async () => {
      openCalls += 1;
      if (openCalls === 1) throw transientLockError("EPERM");
      return fakeHandle();
    },
    readFile: async (p) => { reads.push(p); return "{}"; },
    unlink: async () => {},
    now: () => 0,
    sleep: async () => {},
  });
  try {
    const release = await acquireAppendLock(TD71_LOCK_FILE);
    assert.equal(openCalls, 2, "lock create retried exactly once after the transient EPERM");
    await release();
    assert.deepEqual(reads, [], "EPERM never triggered stale-lock readFile (no live-lock deletion)");
  } finally {
    __resetAppendLockFsForTest();
  }
});

test("TD-71: a transient EBUSY on lock create is retried and then succeeds", async () => {
  let openCalls = 0;
  __setAppendLockFsForTest({
    open: async () => {
      openCalls += 1;
      if (openCalls === 1) throw transientLockError("EBUSY");
      return fakeHandle();
    },
    now: () => 0,
    sleep: async () => {},
  });
  try {
    const release = await acquireAppendLock(TD71_LOCK_FILE);
    assert.equal(openCalls, 2, "lock create retried exactly once after the transient EBUSY");
    await release();
  } finally {
    __resetAppendLockFsForTest();
  }
});

test("TD-71: a real append after one transient EPERM writes exactly one event with seq 1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "td71-append-once-"));
  try {
    const filePath = join(dir, "run.jsonl");
    let openCalls = 0;
    // Only the lock `open` is faked; the first attempt fails EPERM, the second
    // delegates to the real FS. Everything else (mkdir, appendFile, readMaxSeq,
    // stale handling) keeps using the real FS.
    __setAppendLockFsForTest({
      open: async (path, flags) => {
        openCalls += 1;
        if (openCalls === 1) throw transientLockError("EPERM");
        return realOpen(path, flags);
      },
    });
    try {
      const t = new JsonlTranscript(filePath, { runId: "run_td71", agentId: "agent_td71" });
      const event = await t.append("run.started", { cwd: "D:/projects/worktree" });
      assert.equal(openCalls, 2, "lock create retried once after the transient EPERM");
      assert.equal(event.seq, 1);
      const events = await readTranscript(filePath);
      assert.equal(events.length, 1, "exactly one event appended (no double-append from the retry)");
      assert.equal(events[0].seq, 1);
      assert.equal(events[0].type, "run.started");
    } finally {
      __resetAppendLockFsForTest();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-71: repeated EPERM exhausts at the existing bound and throws the stable timeout, preserving the causal error, never deleting the lock", async () => {
  const lockReads = [];
  const lockUnlinks = [];
  let openCalls = 0;
  let clock = 0;
  __setAppendLockFsForTest({
    open: async () => {
      openCalls += 1;
      throw transientLockError("EPERM");
    },
    readFile: async (p) => { lockReads.push(p); return "{}"; },
    unlink: async (p) => { lockUnlinks.push(p); },
    // Advance the fake clock 1s per bound check; the existing bound is 5000ms,
    // so the retry exhausts in a small bounded number of iterations.
    now: () => { clock += 1000; return clock; },
    sleep: async () => {},
  });
  try {
    await assert.rejects(
      () => acquireAppendLock(TD71_LOCK_FILE),
      (err) => {
        assert.match(err.message, /Timed out waiting for transcript append lock/,
          "bound exhaustion throws the stable timeout message");
        assert.equal(err.code, undefined,
          "the exhaustion failure is the stable timeout, NOT the raw EPERM");
        assert.equal(err.cause?.code, "EPERM",
          "the causal transient error is preserved as .cause — a real permission problem is not hidden");
        return true;
      },
    );
    assert.ok(openCalls > 1, "the lock was retried within the bound before exhausting (no immediate abort)");
    assert.deepEqual(lockReads, [], "EPERM never triggered stale-lock readFile");
    assert.deepEqual(lockUnlinks, [], "EPERM never deleted the lock file");
  } finally {
    __resetAppendLockFsForTest();
  }
});

test("TD-71: a non-transient error throws immediately and preserves its causal code (no retry)", async () => {
  let openCalls = 0;
  __setAppendLockFsForTest({
    open: async () => {
      openCalls += 1;
      const err = new Error("no space left on device");
      err.code = "ENOSPC";
      throw err;
    },
    now: () => 0,
    sleep: async () => {},
  });
  try {
    await assert.rejects(
      () => acquireAppendLock(TD71_LOCK_FILE),
      (err) => {
        assert.equal(err.code, "ENOSPC", "causal code preserved verbatim");
        return true;
      },
    );
    assert.equal(openCalls, 1, "a non-transient error is never retried");
  } finally {
    __resetAppendLockFsForTest();
  }
});

test("TD-71: EEXIST still routes to stale-lock handling (regression — retry set must not widen stale deletion)", async () => {
  const lockReads = [];
  let openCalls = 0;
  __setAppendLockFsForTest({
    open: async () => {
      openCalls += 1;
      if (openCalls <= 2) {
        const err = new Error("file exists");
        err.code = "EEXIST";
        throw err;
      }
      return fakeHandle();
    },
    readFile: async (p) => { lockReads.push(p); return JSON.stringify({ pid: 1, ts: 0 }); },
    unlink: async () => {},
    now: () => 0,
    sleep: async () => {},
  });
  try {
    const release = await acquireAppendLock(TD71_LOCK_FILE);
    assert.ok(openCalls >= 2, "EEXIST is retried within the bound (unchanged behavior)");
    assert.equal(lockReads.length, 2,
      "EEXIST triggers the stale-lock read on each retry — stale handling is preserved for EEXIST only");
    await release();
  } finally {
    __resetAppendLockFsForTest();
  }
});

test("TD-71: multi-process ordering preserved under transient EPERM — concurrent writers still get unique monotonic seqs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "td71-concurrent-"));
  try {
    const filePath = join(dir, "run.jsonl");
    let transientRemaining = 3; // inject a few transient blips, then real FS
    __setAppendLockFsForTest({
      open: async (path, flags) => {
        if (transientRemaining > 0) {
          transientRemaining -= 1;
          throw transientLockError("EPERM");
        }
        return realOpen(path, flags);
      },
      sleep: async () => {}, // instant poll — keeps the contended race fast and deterministic
    });
    try {
      const a = new JsonlTranscript(filePath, { runId: "run_td71_race", agentId: "agent_x" });
      const b = new JsonlTranscript(filePath, { runId: "run_td71_race", agentId: "agent_x" });
      await Promise.all(Array.from({ length: 10 }, (_, i) => {
        const writer = i % 2 === 0 ? a : b;
        return writer.append("run.event", { kind: "test", index: i });
      }));
      const events = await readTranscript(filePath);
      const seqs = events.map((e) => e.seq);
      assert.equal(new Set(seqs).size, events.length, "seq values must be unique across writers");
      assert.deepEqual(seqs, Array.from({ length: events.length }, (_, i) => i + 1),
        "seq values must be monotonic in transcript order");
    } finally {
      __resetAppendLockFsForTest();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================
// TD-71 (Lead correction): metadata-write ownership bug.
//
// fs.open(lockPath, "wx") and handle.writeFile(metadata) must NOT share one
// try/catch. If open SUCCEEDS, this invocation OWNS/created the lock, so a
// metadata-write failure (any code) is NOT a retryable open failure: it must
// close the owned handle, unlink ONLY the lock path it just created, and throw
// the original causal error unchanged — no second open, no retry, no stale
// logic. The pre-fix code reclassified a metadata-write EPERM as a transient
// OPEN failure, leaking the handle and the lock it had just created (which then
// surfaced as self-inflicted EEXIST/timeout on the next open).
// ============================================================

test("TD-71: a metadata-write EPERM after a successful open cleans up the owned handle and rethrows (no open retry)", async () => {
  let openCalls = 0;
  let closeCalls = 0;
  const unlinkPaths = [];
  let clock = 0;
  __setAppendLockFsForTest({
    open: async () => {
      openCalls += 1;
      return {
        writeFile: async () => { throw transientLockError("EPERM"); },
        close: async () => { closeCalls += 1; },
      };
    },
    unlink: async (p) => { unlinkPaths.push(p); },
    // Advance the clock so a buggy "retry-open-on-metadata-failure" implementation
    // still terminates at the bound instead of hanging the suite.
    now: () => { clock += 1000; return clock; },
    sleep: async () => {},
  });
  try {
    await assert.rejects(
      () => acquireAppendLock(TD71_LOCK_FILE),
      (err) => {
        assert.equal(err.code, "EPERM", "original causal code preserved unchanged");
        return true;
      },
    );
    assert.equal(openCalls, 1, "no second open — a metadata-write failure is not a retryable open failure");
    assert.equal(closeCalls, 1, "the owned handle was closed exactly once");
    assert.deepEqual(unlinkPaths, [TD71_LOCK_PATH],
      "unlinked exactly once, only the lock path this handle created");
  } finally {
    __resetAppendLockFsForTest();
  }
});

test("TD-71: a metadata-write non-transient error after a successful open cleans up the owned handle and rethrows the original code", async () => {
  let openCalls = 0;
  let closeCalls = 0;
  const unlinkPaths = [];
  let clock = 0;
  __setAppendLockFsForTest({
    open: async () => {
      openCalls += 1;
      return {
        writeFile: async () => {
          const err = new Error("i/o error");
          err.code = "EIO";
          throw err;
        },
        close: async () => { closeCalls += 1; },
      };
    },
    unlink: async (p) => { unlinkPaths.push(p); },
    now: () => { clock += 1000; return clock; },
    sleep: async () => {},
  });
  try {
    await assert.rejects(
      () => acquireAppendLock(TD71_LOCK_FILE),
      (err) => {
        assert.equal(err.code, "EIO", "original causal code preserved (not swallowed or reclassified)");
        return true;
      },
    );
    assert.equal(openCalls, 1, "no second open");
    assert.equal(closeCalls, 1, "owned handle closed exactly once");
    assert.deepEqual(unlinkPaths, [TD71_LOCK_PATH],
      "unlinked exactly once, only the owned lock path");
  } finally {
    __resetAppendLockFsForTest();
  }
});

// ============================================================
// TD-179: bounded delivery settlement — the shared pure facts
// authority (validateDeliveryFacts runId-bound mode) and the
// in-lock decision writer (tryAppendDecision).
//
// Contract under test (docs/02-architecture.md delivery-decision
// section + TD-179):
//   - Core created/original-outcome/decision facts are bound to the
//     requested runId; foreign-envelope events in these core categories are
//     IGNORED, but ALL bound events are counted before payload checks — a
//     duplicate or malformed bound fact (incl. a decision without a usable
//     same-identity ref) is delivery_malformed.
//   - Created alone with an EXPLICIT verification.status "pending" is valid
//     waiting in the pending-aware mode; legacy absent status (or a claimed
//     final status with no backing outcome) never gains pending validity.
//   - A pending-verification decision can ONLY be a reject, explicitly stamped
//     rejected, on a created that explicitly declared pending, with a bound
//     completed state_change EARLIER in append order and no original outcome
//     before the decision. A late real outcome (passed/failed/unavailable)
//     stays a legal display fact; acceptance stays rejected.
//   - A nonpending decision needs earlier matching original or valid reverify
//     backing; accepted must be passed. Legacy tolerance ONLY: a missing or
//     "pending" acceptance stamp on a backed nonpending snapshot, and missing
//     top-level deliveryCommit/seq/verifiedCommit historical optional values.
//   - tryAppendDecision validates facts BEFORE returning already_decided and
//     returns a validated existing decision BEFORE the new-action gates; the
//     ONLY new rejection path is completed + explicit pending + no outcome.
// ============================================================

const TDD_RUN = "run_td179_facts";
const TDD_BASE = "b".repeat(40);
const TDD_COMMIT = "d".repeat(40);
const TDD_OTHER = "e".repeat(40);

function tddCreatedRef(over = {}) {
  return {
    schemaVersion: 1,
    kind: "git_commit",
    runId: TDD_RUN,
    baseCommit: TDD_BASE,
    deliveryCommit: TDD_COMMIT,
    branch: "wao/x",
    worktreePath: "/fake",
    changedFiles: ["a.js"],
    verification: { status: "pending", commands: ["npm test"] },
    acceptance: { status: "pending", reviewerType: "lead_agent" },
    integration: { status: "pending", targetCommit: null },
    ...over,
  };
}

function tddOutcomeRef(status) {
  const verification = status === "failed"
    ? { status, failureCode: "command_failed", commands: ["npm test"], verifiedCommit: TDD_COMMIT, results: [] }
    : status === "unavailable"
      ? { status, unavailableReason: "env gone", commands: [], verifiedCommit: TDD_COMMIT, results: [] }
      : { status, commands: ["npm test"], verifiedCommit: TDD_COMMIT, results: [] };
  return tddCreatedRef({ verification });
}

function tddCreated() {
  return { type: "run.delivery_created", runId: TDD_RUN, delivery: tddCreatedRef() };
}

function tddOutcome(status, over = {}) {
  return {
    type: `run.delivery_verification_${status}`,
    runId: TDD_RUN,
    delivery: tddOutcomeRef(status),
    ...over,
  };
}

function tddCompleted() {
  return { type: "run.state_change", runId: TDD_RUN, from: "running", to: "completed", reason: "done" };
}

function tddRunning() {
  return { type: "run.state_change", runId: TDD_RUN, from: "submitted", to: "running", reason: "first_event" };
}

/** A legal TD-179 pending rejection, stamped from the (pending) created ref. */
function tddPendingRejected(over = {}) {
  return {
    type: "run.delivery_rejected",
    runId: TDD_RUN,
    delivery: tddCreatedRef({ acceptance: { status: "rejected", reviewerType: "lead_agent" } }),
    deliveryCommit: TDD_COMMIT,
    reason: "settling without an outcome",
    ...over,
  };
}

/** A conventional nonpending decision stamped from an outcome ref. */
function tddDecision(type, claimedStatus, over = {}) {
  return {
    type: `run.delivery_${type}`,
    runId: TDD_RUN,
    delivery: {
      ...tddOutcomeRef(claimedStatus),
      acceptance: { status: type, reviewerType: "lead_agent" },
    },
    deliveryCommit: TDD_COMMIT,
    reason: "decision",
    ...over,
  };
}

const TDD_PENDING_OPTS = { expectedRunId: TDD_RUN, allowVerificationPending: true };

test("TD-179-closeout: new decisions from legacy outcomes remain readable and idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "td179-closure-"));
  try {
    for (const status of ["passed", "failed", "unavailable"]) {
      for (const embedded of [undefined, "pending", status]) {
        for (const decision of status === "passed" ? ["accepted", "rejected"] : ["rejected"]) {
          const label = `${status}-${embedded}-${decision}`;
          const filePath = join(dir, `${label}.jsonl`);
          const outcome = tddOutcome(status);
          outcome.delivery.verification.status = embedded;
          const original = [tddCompleted(), tddCreated(), outcome];
          await writeFile(filePath, original.map(e => JSON.stringify(e)).join("\n") + "\n");
          const transcript = new JsonlTranscript(filePath, { runId: TDD_RUN, agentId: "test" });
          const result = await transcript.tryAppendDecision({ decision, reason: label });
          assert.equal(result.accepted, true, label);
          assert.equal(result.event.delivery.verification.status, status, label);
          const events = await readTranscript(filePath);
          assert.equal(validateDeliveryFacts(events, TDD_PENDING_OPTS).valid, true, label);
          assert.deepEqual(events.slice(0, 3), JSON.parse(JSON.stringify(original)), "history unchanged");
          const retry = await transcript.tryAppendDecision({ decision, reason: "retry" });
          assert.equal(retry.accepted, false, label);
          assert.equal((await readTranscript(filePath)).length, 4, "exactly one append");
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-179-closeout: created commit conflicts and unsuperseded failures refuse without append", async () => {
  const dir = await mkdtemp(join(tmpdir(), "td179-created-"));
  const seeds = [
    [tddCompleted(), { ...tddCreated(), deliveryCommit: TDD_OTHER }],
    [tddCompleted(), { ...tddCreated(), delivery: tddCreatedRef({ verification: { status: "pending", verifiedCommit: TDD_OTHER } }) }],
    [tddCompleted(), tddCreated(), tddOutcome("passed"), { type: "run.delivery_failed", runId: TDD_RUN, deliveryCode: "commit_failed" }],
  ];
  try {
    for (const [index, events] of seeds.entries()) {
      const filePath = join(dir, `${index}.jsonl`);
      const bytes = events.map(e => JSON.stringify(e)).join("\n") + "\n";
      await writeFile(filePath, bytes);
      const transcript = new JsonlTranscript(filePath, { runId: TDD_RUN, agentId: "test" });
      await assert.rejects(() => transcript.tryAppendDecision({ decision: "rejected", reason: "conflict" }),
        err => err.code === "delivery_malformed", `case ${index}`);
      assert.equal(await readFile(filePath, "utf8"), bytes, "zero append on conflict");
    }
    for (const status of ["pending", "passed"]) {
      const created = { ...tddCreated(), deliveryCommit: TDD_COMMIT,
        delivery: tddCreatedRef({ verification: { status: "pending", verifiedCommit: TDD_COMMIT } }) };
      const events = [tddCompleted(), created, ...(status === "passed" ? [tddOutcome(status)] : [])];
      assert.equal(validateDeliveryFacts(events, TDD_PENDING_OPTS).valid, true, "matching optional fields allowed");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-179-closeout: future facts cannot back an earlier decision", () => {
  const original = [tddCompleted(), tddCreated(), tddOutcome("passed"), tddDecision("accepted", "passed")];
  assert.equal(validateDeliveryFacts(original, TDD_PENDING_OPTS).valid, true, "no seq required");
  const lateCreated = [original[0], original[2], original[3], original[1]];
  assert.equal(validateDeliveryFacts(lateCreated, TDD_PENDING_OPTS).code, "delivery_malformed");
  const latePendingCreated = [tddCompleted(), tddPendingRejected(), tddCreated()];
  assert.equal(validateDeliveryFacts(latePendingCreated, TDD_PENDING_OPTS).code, "delivery_malformed");
  const passed = revOutcome("passed");
  const decision = { type: "run.delivery_accepted", runId: REV_RUN, deliveryCommit: REV_COMMIT,
    delivery: { ...passed.delivery, acceptance: { status: "accepted" } } };
  const prefix = [{ type: "run.delivery_created", runId: REV_RUN, delivery: revRef() },
    { type: "run.delivery_verification_failed", runId: REV_RUN, delivery: revRef({ verification: { status: "failed" } }) }];
  const opts = { expectedRunId: REV_RUN, allowVerificationPending: true };
  assert.equal(validateDeliveryFacts([...prefix, revRequested(), passed, decision], opts).valid, true);
  assert.equal(validateDeliveryFacts([...prefix, passed, decision, revRequested()], opts).code, "delivery_malformed");
});

test("TD-179-closeout: foreign terminal states cannot grant or deny acceptance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "td179-terminal-"));
  try {
    for (const local of ["running", "completed"]) {
      const filePath = join(dir, `${local}.jsonl`);
      const events = [{ ...tddCompleted(), to: local }, tddCreated(), tddOutcome("passed"),
        { ...tddCompleted(), runId: "run_foreign", to: local === "running" ? "completed" : "running" }];
      await writeFile(filePath, events.map(e => JSON.stringify(e)).join("\n") + "\n");
      const transcript = new JsonlTranscript(filePath, { runId: TDD_RUN, agentId: "test" });
      if (local === "running") {
        await assert.rejects(() => transcript.tryAppendDecision({ decision: "accepted", reason: "local state" }),
          err => err.code === "terminal_not_eligible");
        assert.equal((await readTranscript(filePath)).length, events.length);
      } else {
        assert.equal((await transcript.tryAppendDecision({ decision: "accepted", reason: "local state" })).accepted, true);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-179-A1: the shared facts authority matrix (runId-bound mode)", () => {
  const cases = [
    {
      label: "created alone (explicit pending) — valid waiting ONLY in pending-aware mode",
      events: [tddCreated()],
      defaultCode: "delivery_unavailable",
      pending: { valid: true, verificationStatus: "pending", decisionType: null },
    },
    {
      label: "legacy created with ABSENT verification status gains no pending validity",
      events: [{ type: "run.delivery_created", runId: TDD_RUN, delivery: tddCreatedRef({ verification: undefined }) }],
      defaultCode: "delivery_unavailable",
      pending: { valid: false, code: "delivery_unavailable" },
    },
    {
      label: "created claiming a FINAL status with no backing outcome gains no pending validity",
      events: [{
        type: "run.delivery_created",
        runId: TDD_RUN,
        delivery: tddCreatedRef({ verification: { status: "passed", commands: ["npm test"] } }),
      }],
      defaultCode: "delivery_unavailable",
      pending: { valid: false, code: "delivery_unavailable" },
    },
    {
      label: "legal pending reject (completed before, explicitly stamped rejected)",
      events: [tddCreated(), tddCompleted(), tddPendingRejected()],
      defaultCode: "delivery_unavailable",
      pending: { valid: true, verificationStatus: "pending", decisionType: "run.delivery_rejected" },
    },
    {
      label: "pending reject followed by a LATE passed outcome — displays passed, stays rejected",
      events: [tddCreated(), tddCompleted(), tddPendingRejected(), tddOutcome("passed")],
      pending: { valid: true, verificationStatus: "passed", decisionType: "run.delivery_rejected" },
    },
    {
      label: "pending reject followed by a LATE failed outcome — displays failed, stays rejected",
      events: [tddCreated(), tddCompleted(), tddPendingRejected(), tddOutcome("failed")],
      pending: { valid: true, verificationStatus: "failed", decisionType: "run.delivery_rejected" },
    },
    {
      label: "pending reject followed by a LATE unavailable outcome — displays unavailable, stays rejected",
      events: [tddCreated(), tddCompleted(), tddPendingRejected(), tddOutcome("unavailable")],
      pending: { valid: true, verificationStatus: "unavailable", decisionType: "run.delivery_rejected" },
    },
    {
      label: "pending reject WITHOUT completed-before is malformed",
      events: [tddCreated(), tddPendingRejected()],
      pending: { valid: false, code: "delivery_malformed" },
    },
    {
      label: "pending reject with only a nonterminal bound state_change is malformed",
      events: [tddCreated(), tddRunning(), tddPendingRejected()],
      pending: { valid: false, code: "delivery_malformed" },
    },
    {
      label: "pending reject whose completed state_change comes AFTER the decision is malformed",
      events: [tddCreated(), tddPendingRejected(), tddCompleted()],
      pending: { valid: false, code: "delivery_malformed" },
    },
    {
      label: "pending decision with an EARLIER original outcome is malformed",
      events: [tddCreated(), tddCompleted(), tddOutcome("passed"), tddPendingRejected()],
      pending: { valid: false, code: "delivery_malformed" },
    },
    {
      label: "pending reject not explicitly stamped rejected is malformed",
      events: [tddCreated(), tddCompleted(), { type: "run.delivery_rejected", runId: TDD_RUN, delivery: tddCreatedRef(), reason: "x" }],
      pending: { valid: false, code: "delivery_malformed" },
    },
    {
      label: "pending ACCEPTED can never be legalized — not even by a later pass",
      events: [
        tddCreated(),
        tddCompleted(),
        {
          type: "run.delivery_accepted",
          runId: TDD_RUN,
          delivery: tddCreatedRef({ acceptance: { status: "accepted", reviewerType: "lead_agent" } }),
          deliveryCommit: TDD_COMMIT,
          reason: "x",
        },
        tddOutcome("passed"),
      ],
      pending: { valid: false, code: "delivery_malformed" },
    },
    {
      label: "duplicate bound decisions are malformed",
      events: [tddCreated(), tddCompleted(), tddPendingRejected(), tddPendingRejected()],
      pending: { valid: false, code: "delivery_malformed" },
    },
    {
      label: "orphan bound outcome (no created) is malformed in bound mode",
      events: [tddOutcome("passed")],
      defaultCode: "delivery_unavailable",
      pending: { valid: false, code: "delivery_malformed" },
    },
    {
      label: "orphan bound decision (no created) is malformed in bound mode",
      events: [tddCompleted(), tddPendingRejected()],
      defaultCode: "delivery_unavailable",
      pending: { valid: false, code: "delivery_malformed" },
    },
    {
      label: "decision with canonical-but-different base commit is malformed",
      events: [
        tddCreated(),
        tddCompleted(),
        tddOutcome("passed"),
        tddDecision("accepted", "passed", {
          delivery: {
            ...tddOutcomeRef("passed"),
            baseCommit: TDD_OTHER,
            acceptance: { status: "accepted", reviewerType: "lead_agent" },
          },
        }),
      ],
      pending: { valid: false, code: "delivery_malformed" },
    },
    {
      label: "decision with canonical-but-different delivery commit is malformed",
      events: [
        tddCreated(),
        tddCompleted(),
        tddOutcome("passed"),
        tddDecision("accepted", "passed", {
          delivery: {
            ...tddOutcomeRef("passed"),
            deliveryCommit: TDD_OTHER,
            verification: { status: "passed", commands: ["npm test"], verifiedCommit: TDD_OTHER, results: [] },
            acceptance: { status: "accepted", reviewerType: "lead_agent" },
          },
        }),
      ],
      pending: { valid: false, code: "delivery_malformed" },
    },
    {
      label: "decision top-level deliveryCommit drift is malformed",
      events: [tddCreated(), tddCompleted(), tddOutcome("passed"), tddDecision("accepted", "passed", { deliveryCommit: TDD_OTHER })],
      pending: { valid: false, code: "delivery_malformed" },
    },
    {
      label: "decision MISSING top-level deliveryCommit is allowed (legacy)",
      events: [tddCreated(), tddCompleted(), tddOutcome("passed"), (() => {
        const d = tddDecision("accepted", "passed");
        delete d.deliveryCommit;
        return d;
      })()],
      pending: { valid: true, verificationStatus: "passed", decisionType: "run.delivery_accepted" },
    },
    {
      label: "explicit OPPOSITE acceptance stamp is malformed",
      events: [
        tddCreated(),
        tddCompleted(),
        tddOutcome("passed"),
        tddDecision("accepted", "passed", {
          delivery: { ...tddOutcomeRef("passed"), acceptance: { status: "rejected", reviewerType: "lead_agent" } },
        }),
      ],
      pending: { valid: false, code: "delivery_malformed" },
    },
    {
      label: "MISSING decision verification status is malformed",
      events: [
        tddCreated(),
        tddCompleted(),
        tddOutcome("passed"),
        (() => {
          const ref = { ...tddOutcomeRef("passed"), acceptance: { status: "accepted", reviewerType: "lead_agent" } };
          delete ref.verification;
          return { type: "run.delivery_accepted", runId: TDD_RUN, delivery: ref, deliveryCommit: TDD_COMMIT, reason: "x" };
        })(),
      ],
      pending: { valid: false, code: "delivery_malformed" },
    },
    {
      label: "UNKNOWN decision verification status is malformed",
      events: [
        tddCreated(),
        tddCompleted(),
        tddOutcome("passed"),
        tddDecision("accepted", "passed", {
          delivery: {
            ...tddOutcomeRef("passed"),
            verification: { status: "maybe", commands: ["npm test"] },
            acceptance: { status: "accepted", reviewerType: "lead_agent" },
          },
        }),
      ],
      pending: { valid: false, code: "delivery_malformed" },
    },
    {
      label: "unbacked claimed decision status is malformed",
      events: [tddCreated(), tddCompleted(), tddOutcome("failed"), tddDecision("rejected", "passed")],
      pending: { valid: false, code: "delivery_malformed" },
    },
    {
      label: "accepted must be passed — accepted claiming failed is malformed",
      events: [tddCreated(), tddCompleted(), tddOutcome("failed"), tddDecision("accepted", "failed")],
      pending: { valid: false, code: "delivery_malformed" },
    },
    {
      label: "nonpending rejected backed by an earlier matching unavailable outcome is valid",
      events: [tddCreated(), tddCompleted(), tddOutcome("unavailable"), tddDecision("rejected", "unavailable")],
      pending: { valid: true, verificationStatus: "unavailable", decisionType: "run.delivery_rejected" },
    },
    {
      label: "legacy missing acceptance stamp is valid on a backed nonpending snapshot",
      events: [tddCreated(), tddCompleted(), tddOutcome("passed"), (() => {
        const d = tddDecision("accepted", "passed");
        delete d.delivery.acceptance;
        return d;
      })()],
      pending: { valid: true, verificationStatus: "passed", decisionType: "run.delivery_accepted" },
    },
    {
      label: "legacy 'pending' acceptance stamp is valid on a backed nonpending snapshot",
      events: [tddCreated(), tddCompleted(), tddOutcome("passed"), tddDecision("accepted", "passed", { delivery: tddOutcomeRef("passed") })],
      pending: { valid: true, verificationStatus: "passed", decisionType: "run.delivery_accepted" },
    },
    {
      label: "outcome embedding a CONFLICTING final status is malformed (bound mode)",
      events: [tddCreated(), tddCompleted(), tddOutcome("passed", { delivery: tddOutcomeRef("failed") })],
      pending: { valid: false, code: "delivery_malformed" },
    },
    {
      label: "outcome embedding an UNKNOWN verification status is malformed (bound mode)",
      events: [tddCreated(), tddCompleted(), tddOutcome("passed", {
        delivery: {
          ...tddOutcomeRef("passed"),
          verification: { status: "maybe", commands: ["npm test"], verifiedCommit: TDD_COMMIT, results: [] },
        },
      })],
      pending: { valid: false, code: "delivery_malformed" },
    },
    {
      label: "outcome whose snapshot ref still says pending defers to the event TYPE (Lead-approved narrow exception)",
      events: [tddCreated(), tddCompleted(), tddOutcome("passed", { delivery: tddCreatedRef() })],
      pending: { valid: true, verificationStatus: "passed", decisionType: null },
    },
    {
      label: "outcome whose snapshot ref has NO verification object defers to the event TYPE (Lead-approved narrow exception)",
      events: [tddCreated(), tddCompleted(), tddOutcome("passed", { delivery: (() => { const r = tddCreatedRef(); delete r.verification; return r; })() })],
      pending: { valid: true, verificationStatus: "passed", decisionType: null },
    },
    {
      label: "the outcome TYPE exception NEVER extends to decisions — pending-snapshot accepted stays malformed",
      events: [
        tddCreated(),
        tddCompleted(),
        tddOutcome("passed", { delivery: tddCreatedRef() }),
        {
          type: "run.delivery_accepted",
          runId: TDD_RUN,
          delivery: tddCreatedRef({ acceptance: { status: "accepted", reviewerType: "lead_agent" } }),
          deliveryCommit: TDD_COMMIT,
          reason: "x",
        },
      ],
      pending: { valid: false, code: "delivery_malformed" },
    },
    {
      label: "outcome verifiedCommit drift is malformed (bound mode)",
      events: [tddCreated(), tddCompleted(), tddOutcome("passed", {
        delivery: {
          ...tddOutcomeRef("passed"),
          verification: { status: "passed", commands: ["npm test"], verifiedCommit: TDD_OTHER, results: [] },
        },
      })],
      pending: { valid: false, code: "delivery_malformed" },
    },
    {
      label: "outcome base drift vs created is malformed (bound mode)",
      events: [tddCreated(), tddCompleted(), tddOutcome("passed", { delivery: { ...tddOutcomeRef("passed"), baseCommit: TDD_OTHER } })],
      pending: { valid: false, code: "delivery_malformed" },
    },
    {
      label: "outcome top-level deliveryCommit drift is malformed (bound mode)",
      events: [tddCreated(), tddCompleted(), tddOutcome("passed", { deliveryCommit: TDD_OTHER })],
      pending: { valid: false, code: "delivery_malformed" },
    },
    {
      label: "foreign-envelope core events are IGNORED (not conflicts)",
      events: [
        tddCreated(),
        tddCompleted(),
        tddPendingRejected(),
        {
          type: "run.delivery_accepted",
          runId: "run_FOREIGN",
          delivery: {
            ...tddCreatedRef(),
            runId: "run_FOREIGN",
            acceptance: { status: "accepted", reviewerType: "lead_agent" },
          },
          deliveryCommit: TDD_OTHER,
          reason: "foreign",
        },
      ],
      pending: { valid: true, verificationStatus: "pending", decisionType: "run.delivery_rejected" },
    },
  ];

  for (const c of cases) {
    if (c.defaultCode !== undefined) {
      const legacy = validateDeliveryFacts(c.events);
      assert.equal(legacy.valid, false, `${c.label}: legacy default mode invalid`);
      assert.equal(legacy.code, c.defaultCode, `${c.label}: legacy default code`);
    }
    const facts = validateDeliveryFacts(c.events, TDD_PENDING_OPTS);
    if (c.pending.valid) {
      assert.equal(facts.valid, true, `${c.label}: valid`);
      assert.equal(facts.code, null, `${c.label}: no code`);
      assert.equal(facts.verificationStatus, c.pending.verificationStatus, `${c.label}: verificationStatus`);
      assert.equal(facts.decisionEvent?.type ?? null, c.pending.decisionType, `${c.label}: decisionEvent`);
    } else {
      assert.equal(facts.valid, false, `${c.label}: invalid`);
      assert.equal(facts.code, c.pending.code, `${c.label}: code`);
      assert.equal(typeof facts.error === "string" && facts.error.length > 0, true, `${c.label}: human message kept`);
    }
  }
});

test("TD-179-A2: legal reverify-pass acceptance stays valid through the authority (no drift)", () => {
  const failedRef = revRef({
    verification: { status: "failed", failureCode: "command_failed", commands: ["assert"], verifiedCommit: REV_COMMIT, results: [] },
  });
  const reverifyOutcomeRef = revRef({
    verification: { status: "passed", commands: ["assert"], verifiedCommit: REV_COMMIT, results: [] },
    acceptance: { status: "accepted", reviewerType: "lead_agent" },
  });
  const events = [
    { type: "run.delivery_created", runId: REV_RUN, delivery: revRef() },
    { type: "run.delivery_verification_failed", runId: REV_RUN, delivery: failedRef },
    revRequested(),
    revOutcome("passed"),
    {
      type: "run.delivery_accepted",
      runId: REV_RUN,
      delivery: reverifyOutcomeRef,
      deliveryCommit: REV_COMMIT,
      reason: "reverify passed",
    },
  ];
  const facts = validateDeliveryFacts(events, { expectedRunId: REV_RUN, allowVerificationPending: true });
  assert.equal(facts.valid, true);
  assert.equal(facts.verificationStatus, "failed", "original verification truth unchanged");
  assert.equal(facts.effectiveVerificationStatus, "passed", "effective is the reverify outcome");
  assert.equal(facts.reverifyStatus, "complete");
  assert.equal(facts.decisionEvent?.type, "run.delivery_accepted");
});

test("TD-179-W1: tryAppendDecision — the ONLY new rejection path is completed + explicit pending + no outcome", async () => {
  const dir = await mkdtemp(join(tmpdir(), "td179-w1-"));
  try {
    const filePath = join(dir, `${TDD_RUN}.jsonl`);
    const t = new JsonlTranscript(filePath, { runId: TDD_RUN, agentId: "test" });
    await t.append("run.started", { delivery: { mode: "git_commit_v1" } });
    await t.append("run.delivery_created", { delivery: tddCreatedRef() });
    await t.append("run.state_change", { from: "running", to: "completed", reason: "done" });

    // Accept still requires effective passed — a pending verification refuses.
    await assert.rejects(
      () => t.tryAppendDecision({ decision: "accepted", reason: "nope" }),
      (err) => {
        assert.ok(err instanceof DeliveryDecisionPolicyError);
        assert.equal(err.code, "verification_failed");
        assert.match(err.message, /pending/);
        return true;
      },
    );

    // The bounded pending rejection settles the delivery.
    const result = await t.tryAppendDecision({ decision: "rejected", reason: "verification never produced an outcome" });
    assert.equal(result.accepted, true, "pending reject succeeds");
    assert.equal(result.event.type, "run.delivery_rejected");
    assert.equal(result.event.deliveryCommit, TDD_COMMIT);
    assert.equal(result.event.delivery.verification.status, "pending", "decision snapshot keeps verification pending");
    assert.equal(result.event.delivery.acceptance.status, "rejected", "explicitly stamped rejected");

    // First-decision-wins BEFORE the new-action gates: a later ACCEPT is a
    // loser (already_decided), NOT a verification_failed throw.
    const later = await t.tryAppendDecision({ decision: "accepted", reason: "changed my mind" });
    assert.equal(later.accepted, false);
    assert.equal(later.existing.status, "rejected");
    assert.equal(later.existing.type, "run.delivery_rejected");

    const events = await readTranscript(filePath);
    assert.equal(events.filter((e) => e.type === "run.delivery_rejected").length, 1, "exactly one decision event");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-179-W2: pending reject refusals — non-completed run, legacy inferred completed, legacy absent status", async () => {
  const cases = [
    {
      label: "running run (bound state_change running)",
      seed: [
        ["run.started", { delivery: { mode: "git_commit_v1" } }],
        ["run.delivery_created", { delivery: tddCreatedRef() }],
        ["run.state_change", { from: "submitted", to: "running", reason: "first_event" }],
      ],
      code: "terminal_not_eligible",
    },
    {
      label: "legacy completed inferred from the last event only (no bound state_change)",
      seed: [
        ["run.started", { delivery: { mode: "git_commit_v1" } }],
        ["run.delivery_created", { delivery: tddCreatedRef() }],
        ["run.completed", {}],
      ],
      code: "terminal_not_eligible",
    },
    {
      label: "legacy created with ABSENT verification status gains no rejection eligibility",
      seed: [
        ["run.started", { delivery: { mode: "git_commit_v1" } }],
        ["run.delivery_created", { delivery: tddCreatedRef({ verification: undefined }) }],
        ["run.state_change", { from: "running", to: "completed", reason: "done" }],
      ],
      code: "delivery_unavailable",
    },
    {
      label: "created claiming a final status with no backing outcome gains no rejection eligibility",
      seed: [
        ["run.started", { delivery: { mode: "git_commit_v1" } }],
        ["run.delivery_created", { delivery: tddCreatedRef({ verification: { status: "passed", commands: ["npm test"] } }) }],
        ["run.state_change", { from: "running", to: "completed", reason: "done" }],
      ],
      code: "delivery_unavailable",
    },
  ];
  for (const c of cases) {
    const dir = await mkdtemp(join(tmpdir(), "td179-w2-"));
    try {
      const filePath = join(dir, `${TDD_RUN}.jsonl`);
      const t = new JsonlTranscript(filePath, { runId: TDD_RUN, agentId: "test" });
      for (const [type, payload] of c.seed) await t.append(type, payload);
      await assert.rejects(
        () => t.tryAppendDecision({ decision: "rejected", reason: "x" }),
        (err) => {
          assert.ok(err instanceof DeliveryDecisionPolicyError, `${c.label}: dedicated type`);
          assert.equal(err.code, c.code, `${c.label}: code`);
          return true;
        },
      );
      const events = await readTranscript(filePath);
      assert.equal(
        events.filter((e) => e.type === "run.delivery_accepted" || e.type === "run.delivery_rejected").length,
        0,
        `${c.label}: nothing appended`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("TD-179-W3: an impossible pending ACCEPTED on disk is a durable conflict — never an already_decided loser", async () => {
  const dir = await mkdtemp(join(tmpdir(), "td179-w3-"));
  try {
    const filePath = join(dir, `${TDD_RUN}.jsonl`);
    const t = new JsonlTranscript(filePath, { runId: TDD_RUN, agentId: "test" });
    await t.append("run.started", { delivery: { mode: "git_commit_v1" } });
    await t.append("run.delivery_created", { delivery: tddCreatedRef() });
    await t.append("run.state_change", { from: "running", to: "completed", reason: "done" });
    await t.append("run.delivery_accepted", {
      delivery: tddCreatedRef({ acceptance: { status: "accepted", reviewerType: "lead_agent" } }),
      deliveryCommit: TDD_COMMIT,
      reason: "forged",
    });
    await t.append("run.delivery_verification_passed", { delivery: tddOutcomeRef("passed") });

    for (const decision of ["accepted", "rejected"]) {
      await assert.rejects(
        () => t.tryAppendDecision({ decision, reason: "x" }),
        (err) => {
          assert.ok(err instanceof DeliveryDecisionPolicyError, `${decision}: dedicated type`);
          assert.equal(err.code, "delivery_malformed", `${decision}: a pending accepted is malformed even after a late pass`);
          return true;
        },
      );
    }
    const events = await readTranscript(filePath);
    assert.equal(events.filter((e) => e.type === "run.delivery_rejected").length, 0, "nothing appended");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-231 CAS policy codes are a frozen application subset", async () => {
  const { REPACKAGE_REJECTION_CODES } = await import("../../src/application/runDeliveryRepackage.js");
  assert.equal(Object.isFrozen(REPACKAGE_CAS_POLICY_CODES), true);
  assert.deepEqual(REPACKAGE_CAS_POLICY_CODES, [
    "durable_chain_inconsistent", "scope_violation", "candidate_ineligible", "candidate_contract_malformed",
  ]);
  assert.ok(REPACKAGE_CAS_POLICY_CODES.every((code) => REPACKAGE_REJECTION_CODES.includes(code)));
  const error = new RepackageCasPolicyError("scope_violation", "human diagnostics");
  assert.ok(error instanceof Error);
  assert.equal(error.name, "RepackageCasPolicyError");
  assert.equal(error.code, "scope_violation");
});

test("TD-231 missing transcript is a read error in both CAS primitives, never empty facts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "td231-read-"));
  try {
    const filePath = join(dir, "missing.jsonl");
    const t = new JsonlTranscript(filePath, { runId: M12_RUN, agentId: M12_AGENT });
    const input = { delivery: m12Ref(), approvedAllowedPaths: ["root.txt", "src"], source: "packaged", outcome: "passed" };
    for (const method of ["tryAppendRepackageCreated", "tryAppendRepackageVerification"]) {
      await assert.rejects(t[method](input), (err) => err.code === "ENOENT" && !(err instanceof RepackageCasPolicyError));
      await assert.rejects(readFile(filePath), { code: "ENOENT" });
      // A second call can acquire the same lock: the read failure released it.
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
