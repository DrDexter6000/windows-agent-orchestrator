// test/m12-18-runSummaryCache.test.js
//
// M12-18: bounded in-memory run-transcript cache for the long-lived MCP query
// handlers (lead_preflight + runs_list).
//
// Confirmed design contract (v2 — facts cache):
//   - runs/<runId>.jsonl remains the SOLE truth. The cache is a process-memory
//     read cache shared only by the MCP query handlers; there is no disk
//     sidecar, no schema, no new dependency, and the transcript writers never
//     change.
//   - The cache stores the SMALLEST exact static run facts listRuns needs
//     (extractRunFacts: raw agentId, state, terminal, updatedAt, and the exact
//     run.background_submitted / run.started ownership events the workspace
//     verifier consumes) — never full parsed event arrays, so a realistic
//     ~1800-transcript inventory costs a few MB, not hundreds. The facts are
//     derived from the full exact parse, not a selective parser.
//   - Key/validation: the file's pre/post stat metadata (size, mtimeMs, ino)
//     must AGREE around the read, which detects an append during the read. An
//     entry is stored ONLY when both snapshots agree; a torn read (including a
//     delete between read and post-stat) is never cached but the facts are
//     still returned, so behavior is identical to an uncached read.
//   - A throwing read (missing file, corrupt JSON) propagates to the caller —
//     listRuns skips the run exactly as it would without a cache — and is
//     NEVER cached.
//   - The cache stores per-file facts ONLY. Every query re-applies workspace
//     authorization against the current binding, knownAgentIds validation,
//     owner heartbeat, active/unresolved, activeOnly, sorting and limit, so
//     the cache can never freeze a query result.
//   - Deterministic bounded eviction: LRU via insertion-ordered Map (delete +
//     re-set on hit, evict the head when over the cap). No wall clock, no
//     randomness — the same call sequence evicts the same entries. The default
//     cap covers realistic inventories (≈1800 transcripts with headroom)
//     because the per-entry facts are ~200 B instead of full event arrays.
//
// Test files belong to the manifest `git` group (the server-level tests need a
// real Git repo for the workspace binding, same as runsList.test.js).
//
// Every cache-backed listRuns call passes BOTH readTranscriptFn (the
// pre-M12-18 events path, which reads the cache as the raw reader during the
// RED phase) and readSummaryFn (the M12-18 facts path, which wins once
// implemented) — one suite drives both phases with the same fixtures.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { listRuns } from "../../src/application/runList.js";
import { createRunSummaryCache } from "../../src/application/runSummaryCache.js";
import { readTranscript, JsonlTranscript } from "../../src/transcript.js";
import { createWaoMcpServer } from "../../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const M18_NOW = 1_700_000_000_000; // fixed ms snapshot for liveness determinism
const ROOT = "C:\\Target\\Repo";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "R.md"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: dir });
}

async function seedRun(runDir, runId, workspaceCwd, state = "running", agentId = "coder_low") {
  const tp = join(runDir, `${runId}.jsonl`);
  const t = new JsonlTranscript(tp, { runId, agentId });
  await t.append("run.started", { backend: "claude-code" });
  await t.append("run.background_submitted", { background: true, cwd: workspaceCwd });
  await t.append("session.created", { backend: "process", backendSessionId: "proc_99999" });
  await t.transitionState(null, "pending", "created");
  await t.transitionState("pending", "running", "first_event");
  if (state === "completed") {
    await t.append("run.completed", {});
    await t.transitionState("running", "completed", "done");
  }
  return tp;
}

async function buildClient(server) {
  const [c1, s1] = InMemoryTransport.createLinkedPair();
  await server.connect(s1);
  const client = new Client({ name: "test", version: "0" }, { version: "0" });
  await client.connect(c1);
  return client;
}

// Envelope-complete transcript events for a run (workspace ownership cwd =
// background_submitted, M12-14 binding shape).
function m18Events(runId, cwd, state, agentId = "coder_low") {
  const ts = "2026-08-01T00:00:00Z";
  const ev = [
    { type: "run.started", runId, agentId, ts, seq: 1 },
    { type: "run.background_submitted", runId, agentId, cwd, background: true, ts, seq: 2 },
  ];
  if (state === "running" || state === "completed") {
    ev.push({ type: "run.state_change", runId, agentId, from: "pending", to: "running", reason: "go", ts, seq: 3 });
  }
  if (state === "completed") {
    ev.push({ type: "run.state_change", runId, agentId, from: "running", to: "completed", reason: "done", ts: "2026-08-01T00:05:00Z", seq: 4 });
  }
  if (state === "unknown") {
    // "paused" is not in RUN_STATES → maps to "unknown"
    ev.push({ type: "run.state_change", runId, agentId, from: "pending", to: "paused", reason: "evil", ts, seq: 3 });
  }
  return ev;
}

// Authorized-root verifier: authorizes runs whose ownership cwd equals ROOT,
// throws (fail-closed) for any other workspace — mirrors m12-5/m12-15 spies.
function m18Verifier(authorizedRoot) {
  return (events) => {
    const cwd = events.find((e) => e.type === "run.background_submitted")?.cwd;
    if (cwd !== authorizedRoot) throw new Error("workspace mismatch");
    return { authorized: true, ownershipCwd: cwd };
  };
}

const m18Fresh = () => ({ fresh: true, heartbeatAt: M18_NOW - 500 });
const m18Stale = () => ({ fresh: false, heartbeatAt: M18_NOW - 99999 });

// Build an isolated fixture: run files on disk (empty), an events map, a
// mutable stat map (fake pre/post metadata), and a counting reader wired into
// a REAL createRunSummaryCache. `reads` counts UNDERLYING transcript reads
// (cache-internal), which is the warm-query parsing metric.
function m18Fixture(runDir, specs) {
  const eventsByFile = new Map();
  const stats = new Map();
  const reads = [];
  for (const s of specs) {
    const file = `${s.runId}.jsonl`;
    writeFileSync(join(runDir, file), "", "utf8");
    stats.set(resolve(join(runDir, file)), s.stat ?? { size: 100, mtimeMs: 1000, ino: 7 });
    if (s.corrupt) {
      eventsByFile.set(file, null); // sentinel → reader throws (parse failure)
    } else {
      eventsByFile.set(file, m18Events(s.runId, s.cwd, s.state, s.agentId ?? "coder_low"));
    }
  }
  const cache = createRunSummaryCache({
    readTranscriptFn: async (fp) => {
      reads.push(fp);
      const ev = eventsByFile.get(basename(fp));
      if (ev === null) throw new Error("Unexpected token, unexpected end of JSON input");
      if (ev === undefined) throw new Error("ENOENT: no such file");
      return ev;
    },
    statFn: async (fp) => {
      const st = stats.get(fp);
      if (!st) throw new Error("ENOENT: no such file");
      return st;
    },
  });
  return { eventsByFile, stats, reads, cache };
}

// Every cache-backed query in this suite passes both reader options (see
// header comment): readSummaryFn is the M12-18 facts path; readTranscriptFn
// keeps the same suite driving the pre-M12-18 events path during the RED phase.
function m18Query(runDir, extra) {
  return listRuns({
    runDir,
    authorizedWorkspaceRoot: ROOT,
    knownAgentIds: ["coder_low"],
    nowMs: M18_NOW,
    checkLivenessFn: m18Fresh,
    readTranscriptFn: (fp) => extra.cache.read(fp),
    readSummaryFn: (fp) => extra.cache.read(fp),
    createWorkspaceVerifierFn: () => m18Verifier(ROOT),
  });
}

// ── E00 (RED): inventory > capacity — the second full scan must not thrash ────

test("M12-18-E00: inventory larger than cache capacity — second full scan performs ZERO transcript reads (no cyclic LRU thrash)", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1218-e00-"));
  // 256 runs > the former default cap (128): on a full sequential rescan, a
  // cap-sized LRU evicts every retained tail entry before it is reached, so
  // the warm query re-parses the whole inventory. The facts cache must keep
  // the whole inventory resident and serve the warm scan with zero reads.
  const COUNT = 256;
  const runIds = Array.from({ length: COUNT }, (_, i) => `run_2026080100${String(i).padStart(4, "0")}scan`);
  try {
    const { cache, reads } = m18Fixture(
      runDir,
      runIds.map((id) => ({ runId: id, cwd: ROOT, state: "running" })),
    );
    const query = () => m18Query(runDir, { cache });
    const cold = await query();
    const readsAfterCold = reads.length;
    assert.equal(readsAfterCold, COUNT, "cold full scan reads every transcript");
    const warm = await query();
    assert.equal(
      reads.length,
      readsAfterCold,
      `warm full scan performs ZERO transcript reads (actual: ${reads.length - readsAfterCold} re-reads)`,
    );
    assert.deepEqual(warm, cold, "warm output identical to cold");
    assert.equal(cache.size, COUNT, "the whole inventory fits the bounded cache");
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

// ── E01: two identical list calls — second performs ZERO transcript reads ──

test("M12-18-E01: two identical list calls — second performs zero underlying transcript reads", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1218-e01-"));
  const runIds = [
    "run_20260801000000001alpha",
    "run_20260801000000002bravo",
    "run_20260801000000003charlie",
  ];
  try {
    const { cache, reads } = m18Fixture(
      runDir,
      runIds.map((id) => ({ runId: id, cwd: ROOT, state: "running" })),
    );
    const query = () => m18Query(runDir, { cache });
    const first = await query();
    const afterFirst = reads.length;
    assert.equal(afterFirst, runIds.length, "cold call reads every run transcript");
    const second = await query();
    assert.equal(reads.length, afterFirst, "second identical call must not read any transcript");
    assert.deepEqual(second, first, "warm output is identical to the cold output");
    assert.equal(second.runs.length, runIds.length);
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

// ── E02: append invalidates exactly one file and updates state/updatedAt ──────

test("M12-18-E02: append invalidates exactly one file and updates state/updatedAt", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1218-e02-"));
  const idA = "run_20260801000000004delta";
  const idB = "run_20260801000000005echo";
  try {
    const { eventsByFile, stats, cache, reads } = m18Fixture(runDir, [
      { runId: idA, cwd: ROOT, state: "running", stat: { size: 100, mtimeMs: 1000, ino: 10 } },
      { runId: idB, cwd: ROOT, state: "running", stat: { size: 200, mtimeMs: 2000, ino: 20 } },
    ]);
    const query = () => m18Query(runDir, { cache });
    const before = await query();
    const readsBeforeAppend = reads.length;
    assert.equal(readsBeforeAppend, 2);

    // Append a terminal transition to run A ONLY: the file's size + mtime move.
    const appended = [
      ...m18Events(idA, ROOT, "running"),
      { type: "run.state_change", runId: idA, agentId: "coder_low", from: "running", to: "completed", reason: "done", ts: "2026-08-01T00:07:00Z", seq: 4 },
    ];
    eventsByFile.set(`${idA}.jsonl`, appended);
    stats.set(resolve(join(runDir, `${idA}.jsonl`)), { size: 201, mtimeMs: 2000, ino: 10 });

    const after = await query();
    assert.equal(reads.length, readsBeforeAppend + 1, "append invalidates exactly ONE file (run A re-read; run B served from cache)");
    const aAfter = after.runs.find((r) => r.runId === idA);
    const bAfter = after.runs.find((r) => r.runId === idB);
    const aBefore = before.runs.find((r) => r.runId === idA);
    const bBefore = before.runs.find((r) => r.runId === idB);
    assert.equal(aAfter.state, "completed", "appended state_change is visible");
    assert.equal(aAfter.terminal, true);
    assert.equal(aAfter.updatedAt, "2026-08-01T00:07:00.000Z", "updatedAt reflects the appended event");
    assert.equal(bAfter.state, "running", "untouched run keeps its cached state");
    assert.deepEqual(bAfter, bBefore, "untouched run's summary is byte-identical");
    assert.notEqual(aAfter.updatedAt, aBefore.updatedAt);
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

// ── E03: metadata changes during read (mtimeMs) ⇒ no reusable cache entry ────

test("M12-18-E03: metadata changes during read (mtimeMs) → no reusable cache entry", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1218-e03-"));
  const id = "run_20260801000000006foxtrot";
  try {
    // The fake stat alternates snapshots per call: pre (odd) = X, post (even) = Y.
    // Every read therefore observes an append-during-read and must not be cached.
    const snapX = { size: 100, mtimeMs: 1000, ino: 1 };
    const snapY = { size: 100, mtimeMs: 2000, ino: 1 };
    const calls = new Map();
    const eventsByFile = new Map([[`${id}.jsonl`, m18Events(id, ROOT, "running")]]);
    writeFileSync(join(runDir, `${id}.jsonl`), "", "utf8"); // listRuns scans the dir
    const reads = [];
    const cache = createRunSummaryCache({
      readTranscriptFn: async (fp) => { reads.push(fp); return eventsByFile.get(basename(fp)); },
      statFn: async (fp) => {
        const n = (calls.get(fp) ?? 0) + 1;
        calls.set(fp, n);
        return n % 2 === 1 ? snapX : snapY;
      },
    });
    const query = () => m18Query(runDir, { cache });
    const r1 = await query();
    assert.equal(reads.length, 1, "first call reads the transcript once");
    assert.equal(r1.runs.length, 1, "the torn snapshot is still usable for THIS query (behavior parity)");
    assert.equal(cache.size, 0, "a torn read is never cached");

    const r2 = await query();
    assert.equal(reads.length, 2, "second call re-reads — no reusable cache entry exists");
    assert.equal(r2.runs.length, 1);
    assert.equal(cache.size, 0, "still never cached");

    const r3 = await query();
    assert.equal(reads.length, 3, "third call re-reads again — the cache stays empty");
    assert.equal(r3.runs.length, 1);
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

// ── E04: cached non-terminal run flips active→unresolved from live heartbeat ──

test("M12-18-E04: cached non-terminal run still flips active→unresolved from live heartbeat/nowMs", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1218-e04-"));
  const id = "run_20260801000000007golf";
  try {
    const { cache, reads } = m18Fixture(runDir, [{ runId: id, cwd: ROOT, state: "running" }]);
    const query = (nowMs, liveness) => listRuns({
      runDir,
      authorizedWorkspaceRoot: ROOT,
      knownAgentIds: ["coder_low"],
      nowMs,
      checkLivenessFn: liveness,
      readTranscriptFn: (fp) => cache.read(fp),
      readSummaryFn: (fp) => cache.read(fp),
      createWorkspaceVerifierFn: () => m18Verifier(ROOT),
    });
    const fresh = await query(M18_NOW, m18Fresh);
    assert.equal(fresh.runs[0].activityStatus, "active");
    assert.equal(fresh.runs[0].activityBasis, "fresh_owner_heartbeat");
    assert.equal(fresh.unresolvedCount, 0);
    const readsAfterFresh = reads.length;
    assert.equal(readsAfterFresh, 1);

    // Same cached facts; the live heartbeat snapshot says stale now.
    const stale = await query(M18_NOW + 60_000, m18Stale);
    assert.equal(stale.runs[0].activityStatus, "unresolved", "cache must never freeze activity");
    assert.equal(stale.runs[0].activityBasis, "no_fresh_owner_heartbeat");
    assert.equal(stale.unresolvedCount, 1);
    assert.equal(reads.length, readsAfterFresh, "the flip comes from the live heartbeat, not a re-read");
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

// ── E05: knownAgentIds change (registry) revalidates identity ─────────────────

test("M12-18-E05: registry change (knownAgentIds) revalidates identity on cached facts", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1218-e05-"));
  const id = "run_20260801000000008hotel";
  try {
    const { cache, reads } = m18Fixture(runDir, [{ runId: id, cwd: ROOT, state: "running", agentId: "coder_low" }]);
    const query = (knownAgentIds) => listRuns({
      runDir,
      authorizedWorkspaceRoot: ROOT,
      knownAgentIds,
      nowMs: M18_NOW,
      checkLivenessFn: m18Fresh,
      readTranscriptFn: (fp) => cache.read(fp),
      readSummaryFn: (fp) => cache.read(fp),
      createWorkspaceVerifierFn: () => m18Verifier(ROOT),
    });
    const unknown = await query([]);
    assert.equal(unknown.runs[0].agentId, "unknown", "unregistered agentId must map to 'unknown'");
    const readsAfterFirst = reads.length;
    const known = await query(["coder_low"]);
    assert.equal(known.runs[0].agentId, "coder_low", "agentId revalidated against the CURRENT registry set");
    assert.equal(reads.length, readsAfterFirst, "identity revalidation needs no re-read");
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

// ── E06: workspace root switch rechecks ownership ─────────────────────────────

test("M12-18-E06: workspace root switch rechecks ownership on cached facts", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1218-e06-"));
  const id = "run_20260801000000009india";
  try {
    const { cache, reads } = m18Fixture(runDir, [{ runId: id, cwd: "C:\\Alpha\\Repo", state: "running" }]);
    const query = (authorizedWorkspaceRoot) => listRuns({
      runDir,
      authorizedWorkspaceRoot,
      knownAgentIds: ["coder_low"],
      nowMs: M18_NOW,
      checkLivenessFn: m18Fresh,
      readTranscriptFn: (fp) => cache.read(fp),
      readSummaryFn: (fp) => cache.read(fp),
      createWorkspaceVerifierFn: (root) => m18Verifier(root),
    });
    const underAlpha = await query("C:\\Alpha\\Repo");
    assert.equal(underAlpha.runs.length, 1, "run visible under its owning workspace");
    const readsAfterFirst = reads.length;
    const underBeta = await query("C:\\Beta\\Repo");
    assert.equal(underBeta.runs.length, 0, "workspace switch rechecks ownership — cached facts fail the new binding");
    assert.equal(reads.length, readsAfterFirst, "the ownership recheck reuses the cached facts (zero re-reads)");
    const underAlphaAgain = await query("C:\\Alpha\\Repo");
    assert.equal(underAlphaAgain.runs.length, 1, "switching back restores visibility without a re-read");
    assert.equal(reads.length, readsAfterFirst);
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

// ── E07: corrupt/torn transcript skipped + retried, never cached ──────────────

test("M12-18-E07: corrupt/torn transcript is skipped and retried, never cached", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1218-e07-"));
  const idGood = "run_20260801000000010juliet";
  const idBad = "run_20260801000000011kilo";
  const idTorn = "run_20260801000000012lima";
  try {
    const snapX = { size: 100, mtimeMs: 1000, ino: 3 };
    const snapY = { size: 100, mtimeMs: 2000, ino: 3 };
    const calls = new Map();
    const eventsByFile = new Map([
      [`${idGood}.jsonl`, m18Events(idGood, ROOT, "running")],
      [`${idBad}.jsonl`, null], // corrupt: parse throws forever
      [`${idTorn}.jsonl`, m18Events(idTorn, ROOT, "running")],
    ]);
    // listRuns scans the dir: every file must exist on disk.
    for (const file of eventsByFile.keys()) writeFileSync(join(runDir, file), "", "utf8");
    const reads = [];
    const cache = createRunSummaryCache({
      readTranscriptFn: async (fp) => {
        reads.push(fp);
        const ev = eventsByFile.get(basename(fp));
        if (ev === null) throw new Error("Unexpected token in JSON");
        if (ev === undefined) throw new Error("ENOENT");
        return ev;
      },
      statFn: async (fp) => {
        const base = basename(fp);
        if (base === `${idTorn}.jsonl`) {
          const n = (calls.get(fp) ?? 0) + 1;
          calls.set(fp, n);
          return n % 2 === 1 ? snapX : snapY; // pre ≠ post every read
        }
        return { size: 100, mtimeMs: 1000, ino: 3 };
      },
    });
    const query = () => m18Query(runDir, { cache });
    const r1 = await query();
    assert.ok(r1.runs.some((r) => r.runId === idGood), "healthy run listed");
    assert.ok(r1.runs.some((r) => r.runId === idTorn), "torn snapshot still usable for THIS query (parity)");
    assert.ok(!r1.runs.some((r) => r.runId === idBad), "corrupt transcript skipped silently (fail-closed)");
    const readsAfterFirst = reads.length;
    assert.equal(readsAfterFirst, 3, "one read attempt per file on the cold call");

    const r2 = await query();
    assert.equal(reads.length, readsAfterFirst + 2, "corrupt + torn files are RETRIED on the next call");
    assert.ok(!r2.runs.some((r) => r.runId === idBad), "corrupt transcript still skipped");
    assert.equal(cache.size, 1, "only the healthy file is cached; corrupt/torn never cached");
    assert.equal(cache.stats.tornReads, 2, "both torn reads recorded");
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

// ── E08: deterministic bounded eviction ───────────────────────────────────────

test("M12-18-E08: deterministic bounded eviction (LRU, cap enforced, no wall clock)", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1218-e08-"));
  const ids = ["run_20260801000000013mike", "run_20260801000000014november", "run_20260801000000015oscar", "run_20260801000000016papa"];
  const files = ids.map((id) => resolve(join(runDir, `${id}.jsonl`)));
  try {
    const eventsByFile = new Map(ids.map((id) => [`${id}.jsonl`, m18Events(id, ROOT, "running")]));
    const reads = [];
    const cache = createRunSummaryCache({
      maxEntries: 2,
      readTranscriptFn: async (fp) => { reads.push(basename(fp)); return eventsByFile.get(basename(fp)); },
      statFn: async (fp) => ({ size: 100, mtimeMs: 1000, ino: 1 }),
    });
    // Insert A, B, C with cap 2 → A evicted at C's insert.
    await cache.read(files[0]); // 1
    await cache.read(files[1]); // 2
    await cache.read(files[2]); // 3 → evicts A
    assert.equal(cache.size, 2);
    // Touch B (hit), then insert D → the least-recently-used (C) is evicted.
    await cache.read(files[1]); // hit
    await cache.read(files[3]); // 4 → evicts C (B was most recently used)
    assert.equal(cache.size, 2);
    assert.equal(reads.length, 4);
    // B and D are the surviving entries: hits, no re-reads.
    await cache.read(files[1]);
    await cache.read(files[3]);
    assert.equal(reads.length, 4, "surviving entries (B, D) serve from cache");
    // A and C were evicted deterministically: re-reads.
    await cache.read(files[0]); // 5
    await cache.read(files[2]); // 6
    assert.equal(reads.length, 6, "evicted entries (A, C) are re-read");
    // After the evicted A and C are re-read the cap stays enforced, so those
    // re-inserts evict the then-least-recent entries (B, then D): 4 evictions
    // total across the whole deterministic sequence.
    assert.deepEqual(cache.stats, { hits: 3, misses: 6, tornReads: 0, evictions: 4 });

    // Determinism: a fresh cache over the same sequence yields the same outcome.
    const reads2 = [];
    const cache2 = createRunSummaryCache({
      maxEntries: 2,
      readTranscriptFn: async (fp) => { reads2.push(basename(fp)); return eventsByFile.get(basename(fp)); },
      statFn: async (fp) => ({ size: 100, mtimeMs: 1000, ino: 1 }),
    });
    for (const f of [files[0], files[1], files[2], files[1], files[3], files[1], files[3], files[0], files[2]]) {
      await cache2.read(f);
    }
    assert.equal(reads2.length, 6, "the same call sequence evicts the same entries");
    assert.deepEqual(cache2.stats, cache.stats);
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

// ── E09: cached vs uncached deep-equal for activeOnly true/false ──────────────

test("M12-18-E09: cached facts vs uncached events outputs deep-equal for activeOnly true and false", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1218-e09-"));
  const active = "run_20260801000000017quebec";
  const stale = "run_20260801000000018romeo";
  const done = "run_20260801000000019sierra";
  const evil = "run_20260801000000020tango";
  const foreign = "run_20260801000000021uniform";
  try {
    const { eventsByFile, cache } = m18Fixture(runDir, [
      { runId: active, cwd: ROOT, state: "running" },
      { runId: stale, cwd: ROOT, state: "running" },
      { runId: done, cwd: ROOT, state: "completed" },
      { runId: evil, cwd: ROOT, state: "unknown" },
      { runId: foreign, cwd: "D:\\Other\\Repo", state: "running" },
    ]);
    const liveness = (_runDir, runId) => (
      { fresh: runId === active, heartbeatAt: M18_NOW - 500 }
    );
    const uncached = (activeOnly) => listRuns({
      runDir,
      activeOnly,
      authorizedWorkspaceRoot: ROOT,
      knownAgentIds: ["coder_low"],
      nowMs: M18_NOW,
      checkLivenessFn: liveness,
      readTranscriptFn: async (fp) => eventsByFile.get(basename(fp)),
      createWorkspaceVerifierFn: () => m18Verifier(ROOT),
    });
    const cached = (activeOnly) => listRuns({
      runDir,
      activeOnly,
      authorizedWorkspaceRoot: ROOT,
      knownAgentIds: ["coder_low"],
      nowMs: M18_NOW,
      checkLivenessFn: liveness,
      readTranscriptFn: (fp) => cache.read(fp),
      readSummaryFn: (fp) => cache.read(fp),
      createWorkspaceVerifierFn: () => m18Verifier(ROOT),
    });
    for (const activeOnly of [false, true]) {
      const plain = await uncached(activeOnly);
      const cold = await cached(activeOnly);
      const warm = await cached(activeOnly);
      assert.deepEqual(cold, plain, `activeOnly=${activeOnly}: cold cached facts output equals uncached`);
      assert.deepEqual(warm, plain, `activeOnly=${activeOnly}: warm cached facts output equals uncached`);
    }
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

// ── E10: M12-5 zero per-run Git proof remains true with the cache active ──────

test("M12-18-E10: M12-5 zero per-run Git proof remains true with the cache active", async () => {
  const ownership = await import("../../src/application/runWorkspaceOwnership.js");
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1218-e10-"));
  const AUTHORIZED = "C:\\Target\\Repo";
  const ALIAS_CWDS = [
    "C:\\Target\\Repo", "C:\\TARGET\\REPO", "C:\\target\\repo",
    "C:/Target/Repo", "C:/TARGET/REPO/", "C:\\Target\\Repo\\",
  ];
  const runIds = Array.from({ length: 24 }, (_, i) => `run_2026080100000${String(30 + i).padStart(3, "0")}git`);
  try {
    const { cache, reads } = m18Fixture(
      runDir,
      runIds.map((id, i) => ({ runId: id, cwd: ALIAS_CWDS[i % ALIAS_CWDS.length], state: "running" })),
    );
    const proofCalls = [];
    const canonicalCalls = [];
    const query = () => listRuns({
      runDir,
      authorizedWorkspaceRoot: AUTHORIZED,
      knownAgentIds: ["coder_low"],
      nowMs: M18_NOW,
      checkLivenessFn: m18Fresh,
      readTranscriptFn: (fp) => cache.read(fp),
      readSummaryFn: (fp) => cache.read(fp),
      createWorkspaceVerifierFn: (root) => ownership.createRunWorkspaceVerifier(root, {
        proveWorkspaceFn: (p) => {
          proofCalls.push(p);
          if (p === AUTHORIZED) return { root: "C:/Target/Repo", gitHead: "a".repeat(40), dirty: false };
          throw new Error("probe sentinel: per-run Git proof must not happen");
        },
        canonicalizeWorkspacePathFn: (p) => {
          canonicalCalls.push(p);
          const norm = p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
          if (norm === "c:/target/repo") return "C:/Target/Repo";
          throw new Error("unrealpathable probe sentinel");
        },
      }),
    });
    const r1 = await query();
    assert.equal(r1.matchedCount, runIds.length);
    assert.equal(reads.length, runIds.length, "cold call reads every transcript");
    assert.deepEqual(proofCalls, [AUTHORIZED], "the ONLY Git proof is the authorized root at construction");
    const readsAfterCold = reads.length;
    const r2 = await query();
    assert.equal(reads.length, readsAfterCold, "warm call: zero transcript reads");
    // M12-5 invariant: exactly ONE Git proof per QUERY (the verifier is built
    // per listRuns call), never per run — 24 runs × 2 queries add zero
    // per-run proofs; the cache adds none either.
    assert.deepEqual(proofCalls, [AUTHORIZED, AUTHORIZED], "one proof per query, zero per run, zero from the cache");
    assert.deepEqual(r2, r1);
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

// ── E11: real transcript-copy smoke — cold/warm deep-equal, source unmutated ──

test("M12-18-E11: real transcript-copy smoke — cold and warm outputs deep-equal without mutating source transcripts", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1218-e11-"));
  try {
    // Hand-write REAL JSONL transcripts (the cache's default statFn reads real
    // file metadata; the reader is the real readTranscript behind a counter).
    const lines = (runId, state) => {
      const out = [
        { type: "run.started", runId, agentId: "coder_low", ts: "2026-08-01T00:00:00Z", seq: 1 },
        { type: "run.background_submitted", runId, agentId: "coder_low", cwd: runDir, background: true, ts: "2026-08-01T00:00:00Z", seq: 2 },
        { type: "run.state_change", runId, agentId: "coder_low", from: "pending", to: "running", reason: "go", ts: "2026-08-01T00:00:00Z", seq: 3 },
      ];
      if (state === "completed") {
        out.push({ type: "run.state_change", runId, agentId: "coder_low", from: "running", to: "completed", reason: "done", ts: "2026-08-01T00:05:00Z", seq: 4 });
      }
      return out.map((e) => JSON.stringify(e)).join("\n") + "\n";
    };
    writeFileSync(join(runDir, "run_e11alpha.jsonl"), lines("run_e11alpha", "running"), "utf8");
    writeFileSync(join(runDir, "run_e11bravo.jsonl"), lines("run_e11bravo", "completed"), "utf8");
    const bytesBefore = readFileSync(join(runDir, "run_e11alpha.jsonl"));

    const reads = [];
    const cache = createRunSummaryCache({
      readTranscriptFn: async (fp) => { reads.push(fp); return readTranscript(fp); },
      // statFn omitted → the REAL node:fs/promises stat (real size/mtimeMs/ino)
    });
    const query = () => listRuns({
      runDir,
      knownAgentIds: ["coder_low"],
      nowMs: M18_NOW,
      checkLivenessFn: m18Fresh,
      readTranscriptFn: (fp) => cache.read(fp),
      readSummaryFn: (fp) => cache.read(fp),
    });
    const cold = await query();
    const readsAfterCold = reads.length;
    assert.equal(readsAfterCold, 2, "cold call reads both real transcripts");
    assert.equal(cold.runs.length, 2);
    assert.equal(cold.runs.find((r) => r.runId === "run_e11bravo").state, "completed");

    const warm = await query();
    assert.equal(reads.length, readsAfterCold, "warm call reads zero transcripts (real metadata validated)");
    assert.deepEqual(warm, cold, "warm output is byte-identical to cold");
    assert.deepEqual(readFileSync(join(runDir, "run_e11alpha.jsonl")), bytesBefore, "source transcript bytes unmutated");
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

// ── E12: delete/post-stat race — facts still served, never cached, retried ────

test("M12-18-E12: delete/post-stat race — facts still served this query, never cached, retried next query", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1218-e12-"));
  const id = "run_20260801000000022victor";
  try {
    const eventsByFile = new Map([[`${id}.jsonl`, m18Events(id, ROOT, "running")]]);
    writeFileSync(join(runDir, `${id}.jsonl`), "", "utf8");
    const reads = [];
    const calls = new Map();
    const cache = createRunSummaryCache({
      readTranscriptFn: async (fp) => {
        reads.push(fp);
        return eventsByFile.get(basename(fp));
      },
      statFn: async (fp) => {
        // Alternating: odd call = pre-read stat (succeeds), even call =
        // post-read stat (the file was deleted mid-read → ENOENT).
        const n = (calls.get(fp) ?? 0) + 1;
        calls.set(fp, n);
        if (n % 2 === 0) throw new Error("ENOENT: no such file");
        return { size: 100, mtimeMs: 1000, ino: 1 };
      },
    });
    const query = () => m18Query(runDir, { cache });
    const r1 = await query();
    assert.equal(r1.runs.length, 1, "a delete-after-read must NOT drop the run from THIS query (parity with an uncached read)");
    assert.equal(reads.length, 1);
    assert.equal(cache.size, 0, "a delete/post-stat race is never cached");
    const r2 = await query();
    assert.equal(r2.runs.length, 1);
    assert.equal(reads.length, 2, "next query re-reads — no reusable entry exists");
    assert.equal(cache.size, 0);
    assert.equal(cache.stats.tornReads, 2, "every raced read counted as torn");
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

// ── E13: same-size replacement detected via inode change ──────────────────────

test("M12-18-E13: same-size replacement detected via inode change — torn, never cached", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1218-e13-"));
  const id = "run_20260801000000023whiskey";
  try {
    // pre/post snapshots have IDENTICAL size and mtimeMs — only the inode
    // differs (a file replaced in place, same length, same clock resolution).
    const snapA = { size: 100, mtimeMs: 1000, ino: 1 };
    const snapB = { size: 100, mtimeMs: 1000, ino: 2 };
    const calls = new Map();
    const eventsByFile = new Map([[`${id}.jsonl`, m18Events(id, ROOT, "running")]]);
    writeFileSync(join(runDir, `${id}.jsonl`), "", "utf8");
    const reads = [];
    const cache = createRunSummaryCache({
      readTranscriptFn: async (fp) => { reads.push(fp); return eventsByFile.get(basename(fp)); },
      statFn: async (fp) => {
        const n = (calls.get(fp) ?? 0) + 1;
        calls.set(fp, n);
        return n % 2 === 1 ? snapA : snapB;
      },
    });
    const query = () => m18Query(runDir, { cache });
    const r1 = await query();
    assert.equal(r1.runs.length, 1, "the same-size replacement snapshot is still usable for THIS query (parity)");
    assert.equal(reads.length, 1);
    assert.equal(cache.size, 0, "inode-detected replacement is never cached");
    const r2 = await query();
    assert.equal(r2.runs.length, 1);
    assert.equal(reads.length, 2, "next query re-reads — no reusable entry exists");
    assert.equal(cache.size, 0);
    assert.equal(cache.stats.tornReads, 2);
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

// ── E14: ~1800 real transcripts — warm query performs ZERO transcript reads ───

test("M12-18-E14: ~1800 real transcripts — warm query performs ZERO transcript reads (benchmark-style, deterministic)", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1218-e14-"));
  const COUNT = 1800; // a realistic full inventory, far above the old cap (128)
  try {
    const runIds = Array.from({ length: COUNT }, (_, i) => `run_20260801${String(i).padStart(6, "0")}bench`);
    runIds.forEach((runId, i) => {
      const out = [
        { type: "run.started", runId, agentId: "coder_low", ts: "2026-08-01T00:00:00Z", seq: 1 },
        { type: "run.background_submitted", runId, agentId: "coder_low", cwd: runDir, background: true, ts: "2026-08-01T00:00:00Z", seq: 2 },
        { type: "run.state_change", runId, agentId: "coder_low", from: "pending", to: "running", reason: "go", ts: "2026-08-01T00:00:00Z", seq: 3 },
      ];
      if (i % 3 === 0) {
        out.push({ type: "run.state_change", runId, agentId: "coder_low", from: "running", to: "completed", reason: "done", ts: "2026-08-01T00:05:00Z", seq: 4 });
      }
      writeFileSync(join(runDir, `${runId}.jsonl`), out.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    });

    const reads = [];
    const cache = createRunSummaryCache({
      readTranscriptFn: async (fp) => { reads.push(fp); return readTranscript(fp); },
      // statFn omitted → the REAL node:fs/promises stat (real metadata validation)
    });
    const query = () => listRuns({
      runDir,
      knownAgentIds: ["coder_low"],
      nowMs: M18_NOW,
      checkLivenessFn: m18Fresh,
      readTranscriptFn: (fp) => cache.read(fp),
      readSummaryFn: (fp) => cache.read(fp),
    });
    const cold = await query();
    const readsAfterCold = reads.length;
    assert.equal(readsAfterCold, COUNT, "cold: every transcript read+parsed exactly once");
    assert.equal(cold.runs.length, COUNT);

    const warm = await query();
    // PRIMARY benchmark assertion: the number of transcript reads/parses, not
    // a wall-clock threshold (deterministic — the exact metric the cache must
    // eliminate on warm rescans).
    assert.equal(reads.length, readsAfterCold, `warm: ZERO of ${COUNT} transcripts re-read — retained facts serve the full rescan`);
    assert.deepEqual(warm, cold, "warm output byte-identical to cold");
    assert.equal(cache.size, COUNT, "the whole inventory is resident (bounded by the cap)");
    assert.equal(cache.stats.tornReads, 0, "real metadata never produced a torn snapshot");

    // Structural memory bound: the cache retains the MINIMAL facts projection,
    // never full parsed event arrays (which at this inventory size would be
    // hundreds of MB).
    const fact = await cache.read(join(runDir, `${runIds[0]}.jsonl`));
    assert.deepEqual(Object.keys(fact).sort(), ["agentId", "ownershipEvents", "state", "terminal", "updatedAt"]);
    assert.ok(
      fact.ownershipEvents.every((e) => e.type === "run.background_submitted" || e.type === "run.started"),
      "cached facts carry only the verifier's ownership projection, never the full event list",
    );
  } finally { rmSync(runDir, { recursive: true, force: true }); }
});

// ── Server wiring: one shared cache for lead_preflight + runs_list ────────────

test("M12-18-SRV-01: two identical runs_list calls — second performs zero transcript reads (server-owned cache)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1218-srv01-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1218-srv01-rd-"));
  try {
    makeGitRepo(dir);
    await seedRun(runDir, "run_srv01a", dir, "running", "coder_low");
    await seedRun(runDir, "run_srv01b", dir, "completed", "coder_low");
    const reads = [];
    const cache = createRunSummaryCache({
      readTranscriptFn: async (fp) => { reads.push(fp); return readTranscript(fp); },
    });
    const server = createWaoMcpServer({
      registryPath: join(dir, "registry.json"),
      runDir,
      workspaceRoot: dir,
      runSummaryCache: cache,
    });
    const client = await buildClient(server);
    try {
      const res1 = await client.callTool({ name: "runs_list", arguments: {} });
      assert.ok(!res1.isError, "first runs_list succeeds");
      const afterFirst = reads.length;
      assert.equal(afterFirst, 2, "cold runs_list reads every run transcript");
      const res2 = await client.callTool({ name: "runs_list", arguments: {} });
      assert.equal(reads.length, afterFirst, "second identical runs_list performs zero transcript reads");
      assert.deepEqual(JSON.parse(res2.content[0].text), JSON.parse(res1.content[0].text));
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});

test("M12-18-SRV-02: lead_preflight and runs_list share ONE cache — runs_list after preflight performs zero reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1218-srv02-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-m1218-srv02-rd-"));
  try {
    makeGitRepo(dir);
    await seedRun(runDir, "run_srv02a", dir, "running", "coder_low");
    await seedRun(runDir, "run_srv02b", dir, "completed", "coder_low");
    const reads = [];
    const cache = createRunSummaryCache({
      readTranscriptFn: async (fp) => { reads.push(fp); return readTranscript(fp); },
    });
    const server = createWaoMcpServer({
      registryPath: join(dir, "registry.json"),
      runDir,
      workspaceRoot: dir,
      runSummaryCache: cache,
    });
    const client = await buildClient(server);
    try {
      const res1 = await client.callTool({ name: "lead_preflight", arguments: {} });
      assert.ok(!res1.isError, "lead_preflight succeeds");
      const parsed1 = JSON.parse(res1.content[0].text);
      assert.equal(parsed1.workspace.bound, true, "binding from server_config");
      assert.ok(Array.isArray(parsed1.activeRuns), "activeRuns section settled (readable, not null)");
      const readsAfterPreflight = reads.length;
      assert.equal(readsAfterPreflight, 2, "preflight reads every run transcript exactly once");

      const res2 = await client.callTool({ name: "runs_list", arguments: {} });
      assert.ok(!res2.isError, "runs_list succeeds");
      const parsed2 = JSON.parse(res2.content[0].text);
      assert.equal(parsed2.runs.length, 2);
      assert.equal(reads.length, readsAfterPreflight, "runs_list after preflight performs ZERO transcript reads — one shared cache");
    } finally { await client.close(); await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); }
});
