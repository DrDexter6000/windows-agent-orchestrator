// test/m11-12a-deliveryReviewPending.test.js
//
// M11-12A: delivery-review readiness truth.
//
// When a Lead calls run_delivery_review while exact delivery verification is
// still pending (the runId-bound readiness `waiting_for_verification`), WAO
// returns a truthful STRUCTURED not-yet-reviewable result instead of the generic
// `run_delivery_review failed` error. Pending exposes ZERO diff bytes and NULL
// proof-backed metadata, and does NOT weaken final-artifact review eligibility.
// Every other non-reviewable state remains a fail-closed error.
//
// Coverage:
//   A. Application service (getRunDeliveryReview):
//      - waiting_for_verification → structured pending result; ZERO Git diff/
//        numstat reader calls and NO commit proof / changed-path resolution.
//      - pending rejects a supplied cursor (artifact not paginated) and a
//        negative/non-integer fileIndex.
//      - packaging_failed / not_requested / waiting_for_packaging / ambiguous
//        (cross-run injection) remain fail-closed (throw).
//   P. Shared projection (projectReviewResult):
//      - valid verification_pending accepted with the exact null/empty shape.
//      - rejects injected proof-backed metadata / fragment / cursor / unknown
//        key / invalid runId / mismatched runId / invalid fileIndex.
//      - binary / diff_too_large / available=true shapes unchanged (non-null).
//   M. Real MCP adapter:
//      - valid pending → structuredContent (NOT isError), correct shape.
//      - malformed pending (injected metadata) → fixed error, no structuredContent.
//   C. CLI parity: JSON deepEqual MCP pending result; text mode advisory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { packageDelivery } from "../../src/delivery.js";
import { getRunDeliveryReview } from "../../src/application/runDeliveryReview.js";
import { projectReviewResult } from "../../src/application/deliveryReviewProjection.js";
import { createWaoMcpServer } from "../../src/mcp/server.js";

// ===== Helpers =====

const PENDING_RUN_ID = "run_m11_12a_pending_0001";

async function makeRepo(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "t@t"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "t"', { cwd: dir, stdio: "ignore" });
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "a.js"), "const a = 1;\n");
  execSync("git add . && git commit -m init", { cwd: dir, stdio: "ignore" });
  const baseCommit = execSync("git rev-parse HEAD", {
    cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  }).trim();
  return { repo: dir, baseCommit };
}

async function cleanup(dir) {
  try { execSync("git worktree prune", { cwd: dir, stdio: "ignore" }); } catch { /* best effort */ }
  for (let i = 0; i < 5; i += 1) {
    try { await rm(dir, { recursive: true, force: true }); return; }
    catch { if (i === 4) return; await new Promise((r) => setTimeout(r, 40 * (i + 1))); }
  }
}

async function writeTranscript(runDir, runId, events) {
  await writeFile(join(runDir, `${runId}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

/**
 * Build a real pending scenario: real repo + linked worktree + a packaged
 * delivery, with `delivery_created` recorded but NO final verification outcome.
 * projectDeliveryReadiness → waiting_for_verification.
 */
async function buildPendingScenario({ runId = PENDING_RUN_ID, prefix = "wao-m11-12a-pend-" } = {}) {
  const { repo, baseCommit } = await makeRepo(prefix);
  const wt = join(repo, ".wao-worktrees", runId);
  execSync(`git worktree add "${wt}" -b wao/${runId}`, { cwd: repo, stdio: "ignore" });
  await writeFile(join(wt, "src", "a.js"), "const a = 2;\n");
  const ref = packageDelivery({
    runId, worktreePath: wt, baseCommit, allowedPaths: ["src"],
    isolation: { type: "worktree", strategy: "persistent" },
    verificationCommands: ["npm test"],
  });
  const runDir = await mkdtemp(join(tmpdir(), prefix + "td-"));
  await writeTranscript(runDir, runId, [
    { type: "run.started", runId, ts: "2026-01-01T00:00:00Z", seq: 1 },
    { type: "run.background_submitted", runId, ts: "2026-01-01T00:00:00Z", seq: 1, cwd: repo, background: true, deliveryRequested: true },
    { type: "run.delivery_created", runId, ts: "2026-01-01T00:00:01Z", seq: 2, delivery: ref },
    // NO verification outcome → waiting_for_verification
  ]);
  return { repo, baseCommit, wt, ref, runDir, runId };
}

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-m11-12a", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

// =====================================================================
// A. Application service (getRunDeliveryReview)
// =====================================================================

test("M11-12A-A1: waiting_for_verification → structured pending result; ZERO Git reader calls", async () => {
  const s = await buildPendingScenario();
  try {
    // Inject the projection Git executor (numstat + diff) as a hard counter.
    // On the pending path it MUST NEVER be called — pending returns before any
    // diff/numstat read.
    let gitReaderCalls = 0;
    const r = await getRunDeliveryReview(
      { runId: s.runId, runDir: s.runDir, authorizedWorkspaceRoot: s.repo, fileIndex: 0 },
      {
        gitExecFileSyncFn: () => { gitReaderCalls += 1; throw new Error("git reader must not be called for pending"); },
      },
    );
    // Pending shape: available=false, reason=verification_pending, zero diff bytes.
    assert.equal(r.available, false);
    assert.equal(r.unavailableReason, "verification_pending");
    assert.equal(r.fragment, "");
    assert.equal(r.fragmentBytes, 0);
    assert.equal(r.nextCursor, null);
    assert.equal(r.truncated, false);
    // Honest nulls — NO fabricated proof-backed metadata.
    assert.equal(r.deliveryCommit, null);
    assert.equal(r.changedFileCount, null);
    assert.equal(r.changedPath, null);
    assert.equal(r.contentFormat, null);
    assert.equal(r.artifactTextTrust, null);
    // runId + requested non-negative fileIndex remain present.
    assert.equal(r.runId, s.runId);
    assert.equal(r.fileIndex, 0);
    // Git diff/numstat reader call count is zero.
    assert.equal(gitReaderCalls, 0, "no Git numstat/diff reader call for pending");
    // No commit proof / changed-path resolution: a pending result with
    // deliveryCommit=null is only producible by the pending path — the
    // eligibility resolver would otherwise set deliveryCommit or throw.
  } finally {
    await cleanup(s.repo);
    await cleanup(s.runDir);
  }
});

test("M11-12A-A2: pending rejects a supplied cursor and a negative fileIndex", async () => {
  const s = await buildPendingScenario();
  try {
    // A cursor for a not-yet-paginated artifact is a replay/mismatch.
    await assert.rejects(
      () => getRunDeliveryReview(
        { runId: s.runId, runDir: s.runDir, authorizedWorkspaceRoot: s.repo, fileIndex: 0, cursor: "abc" },
      ),
      /cursor|paginated|invalid/i,
      "a cursor for a pending artifact must be rejected",
    );
    // Negative fileIndex is rejected (fileIndex must be a non-negative integer).
    await assert.rejects(
      () => getRunDeliveryReview(
        { runId: s.runId, runDir: s.runDir, authorizedWorkspaceRoot: s.repo, fileIndex: -1 },
      ),
      /fileIndex/i,
      "negative fileIndex must be rejected on the pending path",
    );
  } finally {
    await cleanup(s.repo);
    await cleanup(s.runDir);
  }
});

test("M11-12A-A3: packaging_failed / not_requested / waiting_for_packaging / ambiguous remain fail-closed", async () => {
  const cases = [
    {
      label: "packaging_failed",
      runId: "run_m11_12a_failed",
      events: (repo) => [
        { type: "run.started", runId: "run_m11_12a_failed", ts: "2026-01-01T00:00:00Z", seq: 1 },
        { type: "run.background_submitted", runId: "run_m11_12a_failed", ts: "2026-01-01T00:00:00Z", seq: 1, cwd: repo, background: true, deliveryRequested: true },
        { type: "run.delivery_failed", runId: "run_m11_12a_failed", ts: "2026-01-01T00:00:01Z", seq: 2, deliveryCode: "empty_diff" },
      ],
    },
    {
      label: "not_requested",
      runId: "run_m11_12a_notreq",
      events: (repo) => [
        { type: "run.started", runId: "run_m11_12a_notreq", ts: "2026-01-01T00:00:00Z", seq: 1 },
        { type: "run.background_submitted", runId: "run_m11_12a_notreq", ts: "2026-01-01T00:00:00Z", seq: 1, cwd: repo, background: true },
      ],
    },
    {
      label: "waiting_for_packaging",
      runId: "run_m11_12a_waitpkg",
      events: (repo) => [
        { type: "run.started", runId: "run_m11_12a_waitpkg", ts: "2026-01-01T00:00:00Z", seq: 1 },
        { type: "run.background_submitted", runId: "run_m11_12a_waitpkg", ts: "2026-01-01T00:00:00Z", seq: 1, cwd: repo, background: true, deliveryRequested: true },
      ],
    },
  ];
  for (const c of cases) {
    const { repo } = await makeRepo("wao-m11-12a-" + c.label + "-");
    const runDir = await mkdtemp(join(tmpdir(), "wao-m11-12a-" + c.label + "-td-"));
    await writeTranscript(runDir, c.runId, c.events(repo));
    try {
      await assert.rejects(
        () => getRunDeliveryReview({ runId: c.runId, runDir, authorizedWorkspaceRoot: repo, fileIndex: 0 }),
        /delivery|review|facts|not reviewable|invalid/i,
        `${c.label}: must fail closed (throw), not return a pending result`,
      );
    } finally {
      await cleanup(repo);
      await cleanup(runDir);
    }
  }

  // ambiguous: a bound delivery_created whose DeliveryRef.runId disagrees with
  // its envelope (cross-run injection) → projectDeliveryReadiness collapses to
  // ambiguous; the eligibility resolver fail-closes it.
  {
    const { repo, baseCommit } = await makeRepo("wao-m11-12a-amb-");
    const runDir = await mkdtemp(join(tmpdir(), "wao-m11-12a-amb-td-"));
    const crossRef = {
      runId: "run_OTHER_run", // envelope runId disagrees → durable conflict
      baseCommit,
      deliveryCommit: "b".repeat(40),
      changedFiles: ["src/a.js"],
    };
    await writeTranscript(runDir, "run_m11_12a_amb", [
      { type: "run.started", runId: "run_m11_12a_amb", ts: "2026-01-01T00:00:00Z", seq: 1 },
      { type: "run.background_submitted", runId: "run_m11_12a_amb", ts: "2026-01-01T00:00:00Z", seq: 1, cwd: repo, background: true, deliveryRequested: true },
      { type: "run.delivery_created", runId: "run_m11_12a_amb", ts: "2026-01-01T00:00:01Z", seq: 2, delivery: crossRef },
    ]);
    try {
      await assert.rejects(
        () => getRunDeliveryReview({ runId: "run_m11_12a_amb", runDir, authorizedWorkspaceRoot: repo, fileIndex: 0 }),
        /delivery|review|facts|mismatch|ambiguous|invalid/i,
        "ambiguous (cross-run injection): must fail closed (throw)",
      );
    } finally {
      await cleanup(repo);
      await cleanup(runDir);
    }
  }
});

test("M11-12A-A4: reviewable still succeeds (no regression from the pending gate)", async () => {
  const s = await buildPendingScenario();
  try {
    // Add the missing verification outcome → readiness becomes reviewable.
    const events = [
      { type: "run.started", runId: s.runId, ts: "2026-01-01T00:00:00Z", seq: 1 },
      { type: "run.background_submitted", runId: s.runId, ts: "2026-01-01T00:00:00Z", seq: 1, cwd: s.repo, background: true, deliveryRequested: true },
      { type: "run.delivery_created", runId: s.runId, ts: "2026-01-01T00:00:01Z", seq: 2, delivery: s.ref },
      { type: "run.delivery_verification_passed", runId: s.runId, ts: "2026-01-01T00:00:02Z", seq: 3, delivery: s.ref },
    ];
    await writeTranscript(s.runDir, s.runId, events);
    const r = await getRunDeliveryReview({
      runId: s.runId, runDir: s.runDir, authorizedWorkspaceRoot: s.repo, fileIndex: 0,
    });
    assert.equal(r.available, true, "reviewable delivery still projects a text fragment");
    assert.equal(r.unavailableReason, null);
    assert.equal(r.deliveryCommit, s.ref.deliveryCommit);
    assert.equal(r.changedPath, "src/a.js");
  } finally {
    await cleanup(s.repo);
    await cleanup(s.runDir);
  }
});

test("M11-12A-A5: bound created ref with a malformed commit literal fails closed (NOT pending)", async () => {
  // Causal (M11-12A P1) at the application service: a bound delivery_created
  // (DeliveryRef.runId === envelope runId, so NOT cross-run) whose commit literal
  // is non-canonical makes readiness=ambiguous, so getRunDeliveryReview skips the
  // pending return, falls through to the fail-closed resolver, and THROWS. It
  // must NOT return a verification_pending result; zero diff/proof metadata
  // crosses the boundary.
  const cases = [
    { label: "HEAD",      deliveryCommit: "HEAD" },
    { label: "short SHA", deliveryCommit: "d".repeat(7) },
    { label: "uppercase", deliveryCommit: "D".repeat(40) },
    { label: "non-hex",   deliveryCommit: "z".repeat(40) },
  ];
  for (const c of cases) {
    const { repo, baseCommit } = await makeRepo("wao-m11-12a-a5-" + c.label + "-");
    const runDir = await mkdtemp(join(tmpdir(), "wao-m11-12a-a5-td-"));
    const runId = "run_m11_12a_a5";
    const malformedRef = {
      runId, // bound — matches envelope (NOT a cross-run ref)
      baseCommit,
      deliveryCommit: c.deliveryCommit, // non-canonical trigger
      changedFiles: ["src/a.js"],
    };
    await writeTranscript(runDir, runId, [
      { type: "run.started", runId, ts: "2026-01-01T00:00:00Z", seq: 1 },
      { type: "run.background_submitted", runId, ts: "2026-01-01T00:00:00Z", seq: 1, cwd: repo, background: true, deliveryRequested: true },
      { type: "run.delivery_created", runId, ts: "2026-01-01T00:00:01Z", seq: 2, delivery: malformedRef },
    ]);
    try {
      await assert.rejects(
        () => getRunDeliveryReview({ runId, runDir, authorizedWorkspaceRoot: repo, fileIndex: 0 }),
        /delivery|facts|review|not reviewable|invalid/i,
        `${c.label}: malformed-commit created ref must fail closed (throw), not return pending`,
      );
    } finally {
      await cleanup(repo);
      await cleanup(runDir);
    }
  }
});

// =====================================================================
// P. Shared projection (projectReviewResult) — pure, no git
// =====================================================================

const PROJ_RUN = "run_proj_pending_0001";

function pendingRaw(overrides = {}) {
  return {
    runId: PROJ_RUN,
    deliveryCommit: null,
    fileIndex: 0,
    changedFileCount: null,
    changedPath: null,
    contentFormat: null,
    artifactTextTrust: null,
    available: false,
    unavailableReason: "verification_pending",
    fragment: "",
    fragmentBytes: 0,
    nextCursor: null,
    truncated: false,
    ...overrides,
  };
}

test("M11-12A-P1: valid verification_pending accepted with the exact null/empty shape", () => {
  const out = projectReviewResult(pendingRaw(), { runId: PROJ_RUN });
  assert.deepEqual(out, pendingRaw(), "projected pending equals the strict pending shape");
});

test("M11-12A-P2: pending rejects injected proof-backed metadata", () => {
  const injections = [
    { deliveryCommit: "a".repeat(40) },
    { changedFileCount: 1 },
    { changedPath: "src/a.js" },
    { contentFormat: "unified_diff_v1" },
    { artifactTextTrust: "untrusted_repository_text" },
  ];
  for (const inj of injections) {
    assert.throws(
      () => projectReviewResult(pendingRaw(inj), { runId: PROJ_RUN }),
      /pending|metadata|null|carry|invalid/i,
      `pending must reject injected ${Object.keys(inj)[0]}`,
    );
  }
});

test("M11-12A-P3: pending rejects non-empty fragment / cursor / truncated", () => {
  assert.throws(() => projectReviewResult(pendingRaw({ fragment: "x", fragmentBytes: 1 }), { runId: PROJ_RUN }), /fragment/i);
  assert.throws(() => projectReviewResult(pendingRaw({ nextCursor: "abc" }), { runId: PROJ_RUN }), /cursor/i);
  assert.throws(() => projectReviewResult(pendingRaw({ truncated: true }), { runId: PROJ_RUN }), /truncat/i);
  assert.throws(() => projectReviewResult(pendingRaw({ fragmentBytes: 1 }), { runId: PROJ_RUN }), /fragmentBytes/i);
});

test("M11-12A-P4: pending rejects unknown key and an invalid unavailableReason", () => {
  assert.throws(
    () => projectReviewResult({ ...pendingRaw(), injected: "leak" }, { runId: PROJ_RUN }),
    /unknown/i,
    "unknown key rejected",
  );
  assert.throws(
    () => projectReviewResult(pendingRaw({ unavailableReason: "not_a_reason" }), { runId: PROJ_RUN }),
    /unavailableReason|reason/i,
    "invalid unavailableReason rejected",
  );
});

test("M11-12A-P5: pending rejects invalid runId / mismatched runId / invalid fileIndex", () => {
  assert.throws(() => projectReviewResult(pendingRaw({ runId: "run_IMPOSTOR" }), { runId: PROJ_RUN }), /runId|mismatch/i);
  assert.throws(() => projectReviewResult(pendingRaw(), { runId: "run_OTHER" }), /runId|mismatch/i);
  assert.throws(() => projectReviewResult(pendingRaw({ fileIndex: -1 }), { runId: PROJ_RUN }), /fileIndex/i);
  assert.throws(() => projectReviewResult(pendingRaw({ fileIndex: 1.5 }), { runId: PROJ_RUN }), /fileIndex/i);
});

test("M11-12A-P6: binary / diff_too_large / available=true shapes unchanged (non-null metadata)", () => {
  // available=true text artifact — unchanged non-null shape.
  const text = projectReviewResult({
    runId: PROJ_RUN, deliveryCommit: "a".repeat(40), fileIndex: 0, changedFileCount: 1,
    changedPath: "src/a.js", contentFormat: "unified_diff_v1", artifactTextTrust: "untrusted_repository_text",
    available: true, unavailableReason: null, fragment: "diff\n", fragmentBytes: 5, nextCursor: null, truncated: false,
  }, { runId: PROJ_RUN });
  assert.equal(text.available, true);
  assert.equal(text.deliveryCommit, "a".repeat(40));
  assert.equal(text.changedFileCount, 1);
  assert.equal(text.changedPath, "src/a.js");
  assert.equal(text.contentFormat, "unified_diff_v1");
  assert.equal(text.artifactTextTrust, "untrusted_repository_text");

  // binary — proof-backed metadata present, no fragment.
  for (const reason of ["binary", "diff_too_large"]) {
    const bin = projectReviewResult({
      runId: PROJ_RUN, deliveryCommit: "a".repeat(40), fileIndex: 0, changedFileCount: 1,
      changedPath: "src/a.js", contentFormat: "unified_diff_v1", artifactTextTrust: "untrusted_repository_text",
      available: false, unavailableReason: reason, fragment: "", fragmentBytes: 0, nextCursor: null, truncated: false,
    }, { runId: PROJ_RUN });
    assert.equal(bin.unavailableReason, reason);
    assert.equal(bin.deliveryCommit, "a".repeat(40), `${reason}: deliveryCommit stays non-null`);
    assert.equal(bin.changedPath, "src/a.js", `${reason}: changedPath stays non-null`);
    assert.equal(bin.contentFormat, "unified_diff_v1", `${reason}: contentFormat stays non-null`);
  }
});

// =====================================================================
// M. Real MCP adapter
// =====================================================================

test("M11-12A-M1: valid pending → structuredContent (NOT isError), correct shape", async () => {
  const s = await buildPendingScenario();
  try {
    const server = createWaoMcpServer({ registryPath: "/x", runDir: s.runDir, workspaceRoot: s.repo });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_delivery_review",
        arguments: { runId: s.runId, fileIndex: 0 },
      });
      assert.equal(res.isError, undefined, "valid pending must NOT be flagged as an error");
      assert.ok(res.structuredContent, "pending returns structuredContent");
      const sc = res.structuredContent;
      assert.equal(sc.available, false);
      assert.equal(sc.unavailableReason, "verification_pending");
      assert.equal(sc.fragment, "");
      assert.equal(sc.fragmentBytes, 0);
      assert.equal(sc.nextCursor, null);
      assert.equal(sc.truncated, false);
      assert.equal(sc.deliveryCommit, null);
      assert.equal(sc.changedFileCount, null);
      assert.equal(sc.changedPath, null);
      assert.equal(sc.contentFormat, null);
      assert.equal(sc.artifactTextTrust, null);
      assert.equal(sc.runId, s.runId);
      assert.equal(sc.fileIndex, 0);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await cleanup(s.repo);
    await cleanup(s.runDir);
  }
});

test("M11-12A-M2: malformed pending (injected metadata) → fixed error, no structuredContent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-m11-12a-m2-"));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "t@t"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "t"', { cwd: dir, stdio: "ignore" });
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "a.js"), "1\n");
  execSync("git add . && git commit -m init", { cwd: dir, stdio: "ignore" });
  const FAKE_COMMIT = "a".repeat(40);
  try {
    // Service returns a pending result that FABRICATES proof-backed metadata.
    // projectReviewResult must reject it → fixed generic error.
    const server = createWaoMcpServer({
      registryPath: "/x", runDir: dir, workspaceRoot: dir,
      getRunDeliveryReviewFn: async () => ({
        runId: "run_m11_12a_m2",
        deliveryCommit: FAKE_COMMIT, // INJECTED — must not cross the boundary
        fileIndex: 0,
        changedFileCount: null, changedPath: null, contentFormat: null, artifactTextTrust: null,
        available: false, unavailableReason: "verification_pending",
        fragment: "", fragmentBytes: 0, nextCursor: null, truncated: false,
      }),
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_delivery_review",
        arguments: { runId: "run_m11_12a_m2", fileIndex: 0 },
      });
      assert.equal(res.isError, true, "fabricated pending metadata must be a fixed error");
      assert.ok(!res.structuredContent, "no structuredContent on a trust-boundary failure");
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes(FAKE_COMMIT), "injected commit must not leak");
      const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
      assert.equal(text, "run_delivery_review failed", "fixed generic error text");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await cleanup(dir);
  }
});

test("M11-12A-M3: bound created ref with a malformed commit literal → fixed error, no structuredContent, no pending", async () => {
  // Causal (M11-12A P1) end-to-end through the real MCP adapter + DEFAULT
  // service (no service override): a transcript whose bound delivery_created
  // carries a non-canonical commit literal makes readiness=ambiguous, so the
  // service fail-closes and the adapter returns the fixed error — NOT a
  // verification_pending result. The malformed literal must not leak.
  const { repo } = await makeRepo("wao-m11-12a-m3-");
  const runDir = await mkdtemp(join(tmpdir(), "wao-m11-12a-m3-td-"));
  const runId = "run_m11_12a_m3";
  const malformedRef = {
    runId, // bound — matches envelope (NOT cross-run)
    baseCommit: "b".repeat(40),
    deliveryCommit: "HEAD", // non-canonical → readiness ambiguous, never pending
    changedFiles: ["src/a.js"],
  };
  await writeTranscript(runDir, runId, [
    { type: "run.started", runId, ts: "2026-01-01T00:00:00Z", seq: 1 },
    { type: "run.background_submitted", runId, ts: "2026-01-01T00:00:00Z", seq: 1, cwd: repo, background: true, deliveryRequested: true },
    { type: "run.delivery_created", runId, ts: "2026-01-01T00:00:01Z", seq: 2, delivery: malformedRef },
  ]);
  const server = createWaoMcpServer({ registryPath: "/x", runDir, workspaceRoot: repo });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({
      name: "run_delivery_review",
      arguments: { runId, fileIndex: 0 },
    });
    assert.equal(res.isError, true, "malformed-commit created ref must be a fixed error");
    assert.ok(!res.structuredContent, "no structuredContent — no pending result crosses the boundary");
    const dumped = JSON.stringify(res);
    assert.ok(!/verification_pending/.test(dumped), "must not surface a verification_pending result");
    assert.ok(!dumped.includes("HEAD"), "malformed commit literal must not leak");
    const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
    assert.equal(text, "run_delivery_review failed", "fixed generic error text");
  } finally {
    await client.close();
    await server.close();
    await cleanup(repo);
    await cleanup(runDir);
  }
});

// =====================================================================
// C. CLI parity
// =====================================================================

test("M11-12A-C1: CLI JSON deepEqual MCP pending; text mode advisory (no File:null)", async () => {
  const { runsDeliveryCommand } = await import("../../src/commands/runs.js");
  const s = await buildPendingScenario();
  try {
    // MCP pending result (default service).
    const server = createWaoMcpServer({ registryPath: "/x", runDir: s.runDir, workspaceRoot: s.repo });
    const client = await buildInMemoryClient(server);
    let mcpPending;
    try {
      const res = await client.callTool({
        name: "run_delivery_review",
        arguments: { runId: s.runId, fileIndex: 0 },
      });
      mcpPending = res.structuredContent;
    } finally {
      await client.close();
      await server.close();
    }

    // CLI JSON mode — consumes the SAME projected result (no raw service bypass).
    const orig = console.log;
    let cliJson = "";
    console.log = (...a) => { cliJson += a.join("\t") + "\n"; };
    try {
      await runsDeliveryCommand(
        ["review", s.runId, "--file-index", "0", "--format", "json", "--cwd", s.repo],
        { runDir: s.runDir },
      );
    } finally { console.log = orig; }
    assert.deepEqual(JSON.parse(cliJson), mcpPending, "CLI JSON deepEqual MCP pending result");

    // CLI text mode — advisory, no raw diff, no "File: null".
    let cliText = "";
    console.log = (...a) => { cliText += a.join("\n") + "\n"; };
    try {
      await runsDeliveryCommand(
        ["review", s.runId, "--file-index", "0", "--cwd", s.repo],
        { runDir: s.runDir },
      );
    } finally { console.log = orig; }
    assert.ok(/verification|pending|retry|wait/i.test(cliText),
      "text mode mentions pending/wait/retry (advisory)");
    assert.ok(!/File:\s*null/i.test(cliText), "text mode must not print 'File: null'");
    assert.ok(!/1\/null/i.test(cliText), "text mode must not print a null file count");
  } finally {
    await cleanup(s.repo);
    await cleanup(s.runDir);
  }
});
