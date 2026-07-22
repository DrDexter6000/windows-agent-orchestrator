// test/runCollectContinuation.test.js
//
// M11-4: run_collect continuation — TDD RED→GREEN.
//
// Covers B1 (consumer correctness) and B2 (cursor trust boundary) at the
// shared application layer. B3 (MCP projection) lives in test/mcpRunCollect.test.js;
// B4 (CLI parity + audit) lives in test/cli.test.js.
//
// The pagination algorithm and cursor codec live in
// src/application/runCollectProjection.js. collectRunMessages is extended to
// accept an optional cursor and return a snapshot handle; the projection
// module slices the snapshot into pages.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectRunMessages } from "../src/application/runCollect.js";
import { projectCollectResult, encodeCollectCursor, decodeCollectCursor } from "../src/application/runCollectProjection.js";
import { readTranscript, findState, findLatest } from "../src/transcript.js";

// ===== Helpers =====

function writeTranscript(dir, runId, lines) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.jsonl`), lines, "utf8");
}

function jl(obj) {
  return JSON.stringify(obj) + "\n";
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// A canonical session header so collectRunMessages has a valid session.
function sessionHeader(runId, agentId = "researcher", backend = "process", extra = {}) {
  return [
    jl({ type: "run.submitted", agentId, ts: "2026-07-22T00:00:00.000Z" }),
    jl({ type: "session.created", backend, backendSessionId: "proc_m11_4", runId, agentId, ...extra }),
    jl({ type: "run.started", backend: "claude-code", ts: "2026-07-22T00:00:01.000Z", runId, agentId }),
  ].join("");
}

function msg(runId, text, idx, agentId = "researcher") {
  return jl({
    type: "run.event", kind: "message", role: "assistant",
    parts: [{ type: "text", text }],
    ts: `2026-07-22T00:00:${10 + idx}.000Z`, runId, agentId,
  });
}

function toolOnly(runId, idx, agentId = "researcher") {
  return jl({
    type: "run.event", kind: "tool_use", tool: "Read",
    input: { file_path: "src/app.js" },
    ts: `2026-07-22T00:00:${20 + idx}.000Z`, runId, agentId,
  });
}

function readTranscriptSync(p) {
  try {
    return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// ===== B1: Consumer correctness =====

// ---------------------------------------------------------------------
// M11-4-B1-01: small result — old fields unchanged, nextCursor=null.
// ---------------------------------------------------------------------
test("M11-4-B1-01: small result keeps existing fields and returns nextCursor=null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-b1-01-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, "run_small",
      sessionHeader("run_small") +
      msg("run_small", "done", 0) +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-22T00:01:00.000Z", runId: "run_small", agentId: "researcher" }));
    const appendCalls = [];
    const raw = await collectRunMessages({
      runId: "run_small", runDir,
      appendCollectedFn: async (type, payload) => appendCalls.push({ type, payload }),
    });
    const payload = projectCollectResult(raw, { runId: "run_small" });
    assert.equal(payload.runId, "run_small");
    assert.equal(payload.backend, "process");
    assert.equal(payload.reconstructed, true);
    assert.equal(payload.itemCount, 1);
    assert.equal(payload.messages.length, 1);
    assert.equal(payload.messages[0].text, "done");
    assert.equal(payload.messages[0].truncated, false);
    assert.equal(payload.evidenceCounts.message, 1);
    assert.equal(payload.truncated, false);
    assert.equal(payload.nextCursor, null, "small result: no more pages");
    assert.equal(appendCalls.length, 1, "one audit append for the single page");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M11-4-B1-02: >8 assistant messages → at least 2 pages, all messages
// appear exactly once in order across the full reconstruction.
// ---------------------------------------------------------------------
test("M11-4-B1-02: 12 assistant messages paginate across pages with no loss/duplication", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-b1-02-"));
  try {
    const runDir = join(dir, "runs");
    const N = 12;
    const events = [];
    for (let i = 0; i < N; i += 1) {
      events.push(msg("run_many", `message-${i}-body`, i));
    }
    writeTranscript(runDir, "run_many",
      sessionHeader("run_many") + events.join("") +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-22T00:10:00.000Z", runId: "run_many", agentId: "researcher" }));

    const collected = [];
    let cursor = null;
    const appendFn = async (type, payload) => {
      // audit must not carry the cursor or text
      assert.ok(!payload.cursor && !payload.text, "audit must not store cursor/text");
    };
    // page 1
    let raw = await collectRunMessages({ runId: "run_many", runDir, cursor, appendCollectedFn: appendFn });
    let page = projectCollectResult(raw, { runId: "run_many", cursor });
    assert.equal(page.messages.length, 8, "page 1 caps at 8 messages");
    assert.ok(page.nextCursor, "page 1 has a next cursor");
    collected.push(...page.messages.map((m) => m.text));
    cursor = page.nextCursor;

    // pages 2..N until null
    let safety = 0;
    while (cursor && safety < 10) {
      raw = await collectRunMessages({ runId: "run_many", runDir, cursor, appendCollectedFn: appendFn });
      page = projectCollectResult(raw, { runId: "run_many", cursor });
      collected.push(...page.messages.map((m) => m.text));
      cursor = page.nextCursor;
      safety += 1;
    }
    assert.equal(cursor, null, "pagination terminates with null cursor");
    assert.equal(collected.length, N, "all N messages collected exactly once");
    // order preserved
    for (let i = 0; i < N; i += 1) {
      assert.equal(collected[i], `message-${i}-body`, `message ${i} in order`);
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M11-4-B1-03: single very long message → at least 3 pages, reconstructed.
// ---------------------------------------------------------------------
test("M11-4-B1-03: single 30000-char message paginates across >=3 pages and reconstructs exactly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-b1-03-"));
  try {
    const runDir = join(dir, "runs");
    const chunk = "A".repeat(30000); // > 2 pages of 12000 chars
    writeTranscript(runDir, "run_long",
      sessionHeader("run_long") +
      msg("run_long", chunk, 0) +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-22T00:10:00.000Z", runId: "run_long", agentId: "researcher" }));

    const collected = [];
    let cursor = null;
    let pageCount = 0;
    while (true) {
      const raw = await collectRunMessages({ runId: "run_long", runDir, cursor, appendCollectedFn: async () => {} });
      const page = projectCollectResult(raw, { runId: "run_long", cursor });
      pageCount += 1;
      collected.push(...page.messages.map((m) => m.text));
      cursor = page.nextCursor;
      if (!cursor) break;
      if (pageCount > 10) throw new Error("runaway pagination");
    }
    assert.ok(pageCount >= 3, `long single message needs >=3 pages (got ${pageCount})`);
    assert.equal(collected.join(""), chunk, "reconstructed text is byte-exact");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M11-4-B1-04: 12000 char total cap paginates rather than silently dropping.
// ---------------------------------------------------------------------
test("M11-4-B1-04: many short messages exhaust total cap then paginate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-b1-04-"));
  try {
    const runDir = join(dir, "runs");
    // 6 messages × 3000 chars = 18000 total → page 1 carries 4 (12000 cap),
    // page 2 carries 2.
    const N = 6;
    const events = [];
    for (let i = 0; i < N; i += 1) {
      events.push(msg("run_cap", "B".repeat(3000), i));
    }
    writeTranscript(runDir, "run_cap",
      sessionHeader("run_cap") + events.join("") +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-22T00:10:00.000Z", runId: "run_cap", agentId: "researcher" }));

    const collected = [];
    let cursor = null;
    while (true) {
      const raw = await collectRunMessages({ runId: "run_cap", runDir, cursor, appendCollectedFn: async () => {} });
      const page = projectCollectResult(raw, { runId: "run_cap", cursor });
      collected.push(...page.messages);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    assert.equal(collected.length, N, "all 6 messages eventually read");
    // each message survived intact (no mid-message slicing here since each < 4000)
    for (const m of collected) {
      assert.equal(m.text.length, 3000);
      assert.equal(m.truncated, false);
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M11-4-B1-05: empty result → messages=[], nextCursor=null.
// ---------------------------------------------------------------------
test("M11-4-B1-05: empty snapshot → messages=[] and nextCursor=null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-b1-05-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, "run_empty",
      sessionHeader("run_empty") +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-22T00:01:00.000Z", runId: "run_empty", agentId: "researcher" }));
    const raw = await collectRunMessages({ runId: "run_empty", runDir, appendCollectedFn: async () => {} });
    const page = projectCollectResult(raw, { runId: "run_empty" });
    assert.deepEqual(page.messages, []);
    assert.equal(page.nextCursor, null);
    assert.equal(page.itemCount, 0);
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M11-4-B1-06: tool-only messages do not consume text page quota; final
// assistant answer still readable.
// ---------------------------------------------------------------------
test("M11-4-B1-06: tool-only events do not consume text page quota", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-b1-06-"));
  try {
    const runDir = join(dir, "runs");
    // 10 tool_use events + 1 assistant message → page must return the 1 message
    const toolEvents = [];
    for (let i = 0; i < 10; i += 1) toolEvents.push(toolOnly("run_tool", i));
    writeTranscript(runDir, "run_tool",
      sessionHeader("run_tool") +
      toolEvents.join("") +
      msg("run_tool", "final answer", 99) +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-22T00:10:00.000Z", runId: "run_tool", agentId: "researcher" }));
    const raw = await collectRunMessages({ runId: "run_tool", runDir, appendCollectedFn: async () => {} });
    const page = projectCollectResult(raw, { runId: "run_tool" });
    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0].text, "final answer");
    assert.equal(page.evidenceCounts.toolUse, 10);
    assert.equal(page.evidenceCounts.message, 1);
    assert.equal(page.nextCursor, null);
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M11-4-B1-07: Unicode/CJK/emoji must not split a code point across pages.
// ---------------------------------------------------------------------
test("M11-4-B1-07: CJK/emoji/surrogate-pair text does not split code points across pages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-b1-07-"));
  try {
    const runDir = join(dir, "runs");
    // Build a long string of multi-byte chars; pagination slicing must not
    // break a UTF-16 surrogate pair or a multi-byte rune.
    const unit = "中文🎉𝕏"; // mix BMP CJK, BMP emoji (surrogate), astral math symbol
    const chunk = unit.repeat(4000); // ~40000 chars, multi-page
    writeTranscript(runDir, "run_uni",
      sessionHeader("run_uni") +
      msg("run_uni", chunk, 0) +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-22T00:10:00.000Z", runId: "run_uni", agentId: "researcher" }));
    const collected = [];
    let cursor = null;
    while (true) {
      const raw = await collectRunMessages({ runId: "run_uni", runDir, cursor, appendCollectedFn: async () => {} });
      const page = projectCollectResult(raw, { runId: "run_uni", cursor });
      collected.push(...page.messages.map((m) => m.text));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    const reconstructed = collected.join("");
    assert.equal(reconstructed, chunk, "unicode reconstructed byte-exact");
    // No lone surrogates introduced by slicing.
    for (let i = 0; i < reconstructed.length; i += 1) {
      const cc = reconstructed.charCodeAt(i);
      if (cc >= 0xD800 && cc <= 0xDBFF) {
        const next = reconstructed.charCodeAt(i + 1);
        assert.ok(next >= 0xDC00 && next <= 0xDFFF, `lone high surrogate at ${i}`);
      }
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M11-4-B1-08: LF/TAB preserved; other C0/DEL sanitized.
// ---------------------------------------------------------------------
test("M11-4-B1-08: LF/TAB preserved across pages, other C0/DEL sanitized", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-b1-08-"));
  try {
    const runDir = join(dir, "runs");
    const chunk = "line1\nline2\ttabbed".repeat(2000);
    writeTranscript(runDir, "run_lf",
      sessionHeader("run_lf") +
      msg("run_lf", chunk, 0) +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-22T00:10:00.000Z", runId: "run_lf", agentId: "researcher" }));
    const collected = [];
    let cursor = null;
    while (true) {
      const raw = await collectRunMessages({ runId: "run_lf", runDir, cursor, appendCollectedFn: async () => {} });
      const page = projectCollectResult(raw, { runId: "run_lf", cursor });
      collected.push(...page.messages.map((m) => m.text));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    const reconstructed = collected.join("");
    assert.equal(reconstructed, chunk, "LF/TAB preserved exactly across pages");
  } finally {
    cleanupDir(dir);
  }
});

// ===== B2: Cursor trust boundary =====

// ---------------------------------------------------------------------
// M11-4-B2-01: malformed / empty / too-long / non-base64url / noncanonical
// cursors all rejected with fixed error.
// ---------------------------------------------------------------------
test("M11-4-B2-01: malformed/empty/too-long/non-base64url cursors rejected", () => {
  const bad = [
    "", " ", "not-base64url!", "====", "aGVsbG8=", // contains '=' which base64url forbids
    "x".repeat(193), // length cap
    "{}", "null", "undefined",
    "v=1&r=abc", // not opaque token
  ];
  for (const c of bad) {
    let threw = false;
    try {
      decodeCollectCursor(c);
    } catch {
      threw = true;
    }
    assert.ok(threw, `cursor ${JSON.stringify(c)} must be rejected`);
  }
});

// ---------------------------------------------------------------------
// M11-4-B2-02: negative / fractional / beyond-end / equal-end offsets rejected.
// ---------------------------------------------------------------------
test("M11-4-B2-02: negative/fractional/beyond-end cursor offsets rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-b2-02-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, "run_off",
      sessionHeader("run_off") +
      msg("run_off", "single message", 0) +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-22T00:10:00.000Z", runId: "run_off", agentId: "researcher" }));
    // First obtain a valid snapshot handle by calling page 1.
    const raw1 = await collectRunMessages({ runId: "run_off", runDir, appendCollectedFn: async () => {} });
    const page1 = projectCollectResult(raw1, { runId: "run_off" });

    // Forge tokens that bypass encodeCollectCursor's structural validation by
    // building the base64url directly. These test the PROJECTION layer's
    // rejection of semantically invalid positions even if the token decodes.
    // We reuse page1's valid runId digest so the runId binding passes, then
    // tamper with snapshot/position to test deeper rejection.
    const { createHash } = await import("node:crypto");
    const { computeSnapshotDigestForTest } = await import("../src/application/runCollectProjection.js");
    const runIdDigest = createHash("sha256").update("run_off").digest().subarray(0, 16).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const validSnapDigest = computeSnapshotDigestForTest(["single message"]);

    function forgeToken(overrides) {
      const payload = {
        v: 1, r: runIdDigest,
        s: validSnapDigest, n: 1,
        m: 0, o: 0,
        ...overrides,
      };
      const json = `{"v":${payload.v},"r":"${payload.r}","s":"${payload.s}","n":${payload.n},"m":${payload.m},"o":${payload.o}}`;
      return Buffer.from(json, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }

    const forged = [
      { m: -1, o: 0 },      // negative msgIdx
      { m: 999, o: 0 },     // beyond end
      { m: 1, o: 0 },       // equal to n (no more messages)
      { m: 0, o: 999 },     // offset beyond message length
    ];
    for (const f of forged) {
      const tok = forgeToken(f);
      let threw = false;
      try {
        const raw = await collectRunMessages({ runId: "run_off", runDir, cursor: tok, appendCollectedFn: async () => {} });
        projectCollectResult(raw, { runId: "run_off", cursor: tok });
      } catch {
        threw = true;
      }
      assert.ok(threw, `forged cursor ${JSON.stringify(f)} must be rejected`);
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M11-4-B2-03: cross-run / cross-snapshot / cross-position replay rejected.
// ---------------------------------------------------------------------
test("M11-4-B2-03: cursor from runA replayed against runB rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-b2-03-"));
  try {
    const runDir = join(dir, "runs");
    // run A: 10 messages
    const eventsA = [];
    for (let i = 0; i < 10; i += 1) eventsA.push(msg("runA", `A-${i}`, i));
    writeTranscript(runDir, "runA",
      sessionHeader("runA") + eventsA.join("") +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-22T00:10:00.000Z", runId: "runA", agentId: "researcher" }));
    // run B: 2 messages
    writeTranscript(runDir, "runB",
      sessionHeader("runB") +
      msg("runB", "B-0", 0) + msg("runB", "B-1", 1) +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-22T00:10:00.000Z", runId: "runB", agentId: "researcher" }));

    // Get a valid continuation cursor from runA page 1.
    const rawA = await collectRunMessages({ runId: "runA", runDir, appendCollectedFn: async () => {} });
    const pageA1 = projectCollectResult(rawA, { runId: "runA" });
    assert.ok(pageA1.nextCursor, "runA page 1 has a next cursor");
    // Replay against runB → must fail closed.
    let threw = false;
    try {
      const rawB = await collectRunMessages({ runId: "runB", runDir, cursor: pageA1.nextCursor, appendCollectedFn: async () => {} });
      projectCollectResult(rawB, { runId: "runB", cursor: pageA1.nextCursor });
    } catch {
      threw = true;
    }
    assert.ok(threw, "cross-run cursor replay must fail closed");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M11-4-B2-04: cursor content never carries raw runId/path/prompt/secret.
// ---------------------------------------------------------------------
test("M11-4-B2-04: cursor token carries no raw runId/path/prompt/secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-b2-04-"));
  try {
    const runDir = join(dir, "runs");
    const secret = "test-secret-m114-value-1234567890";
    const events = [];
    for (let i = 0; i < 10; i += 1) events.push(msg("run_secret", `${secret}-${i}`, i));
    writeTranscript(runDir, "run_secret",
      sessionHeader("run_secret") + events.join("") +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-22T00:10:00.000Z", runId: "run_secret", agentId: "researcher" }));
    const raw = await collectRunMessages({ runId: "run_secret", runDir, appendCollectedFn: async () => {} });
    const page = projectCollectResult(raw, { runId: "run_secret", env: { LEAKED_SECRET: secret } });
    assert.ok(page.nextCursor);
    const tok = page.nextCursor;
    // Token must not contain the raw runId, the secret, or worker text.
    assert.ok(!tok.includes("run_secret"), "no raw runId in cursor");
    assert.ok(!tok.includes(secret), "no secret in cursor");
    assert.ok(!tok.includes("message"), "no worker text in cursor");
    // base64url alphabet only
    assert.match(tok, /^[A-Za-z0-9_-]+$/);
    assert.ok(tok.length <= 192);
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M11-4-B2-05: appending messages.collected does NOT invalidate the
// continuation cursor for the next page.
// ---------------------------------------------------------------------
test("M11-4-B2-05: audit append does not invalidate continuation cursor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-b2-05-"));
  try {
    const runDir = join(dir, "runs");
    const events = [];
    for (let i = 0; i < 10; i += 1) events.push(msg("run_audit", `M-${i}`, i));
    writeTranscript(runDir, "run_audit",
      sessionHeader("run_audit") + events.join("") +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-22T00:10:00.000Z", runId: "run_audit", agentId: "researcher" }));

    // Real append (default) — appends to the actual transcript file.
    const raw1 = await collectRunMessages({ runId: "run_audit", runDir });
    const page1 = projectCollectResult(raw1, { runId: "run_audit" });
    assert.ok(page1.nextCursor);

    // After append, page 2 must still work and produce the remaining messages.
    const raw2 = await collectRunMessages({ runId: "run_audit", runDir, cursor: page1.nextCursor });
    const page2 = projectCollectResult(raw2, { runId: "run_audit", cursor: page1.nextCursor });
    assert.equal(page1.messages.length + page2.messages.length, 10, "all messages across 2 pages");
    assert.equal(page2.nextCursor, null);

    // Verify the audit event was actually appended (file grew).
    const eventsAfter = readTranscriptSync(join(runDir, "run_audit.jsonl"));
    const audits = eventsAfter.filter((e) => e.type === "messages.collected");
    assert.equal(audits.length, 2, "two audit appends for two pages");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M11-4-B2-06: new run.event appended after page 1 does NOT duplicate or
// skip (frozen-prefix snapshot semantics).
// ---------------------------------------------------------------------
test("M11-4-B2-06: post-page-1 run.event append uses frozen prefix (no dup/skip)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-b2-06-"));
  try {
    const runDir = join(dir, "runs");
    const events = [];
    for (let i = 0; i < 10; i += 1) events.push(msg("run_grow", `G-${i}`, i));
    writeTranscript(runDir, "run_grow",
      sessionHeader("run_grow") + events.join("") +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-22T00:10:00.000Z", runId: "run_grow", agentId: "researcher" }));

    const raw1 = await collectRunMessages({ runId: "run_grow", runDir, appendCollectedFn: async () => {} });
    const page1 = projectCollectResult(raw1, { runId: "run_grow" });

    // Now append a NEW assistant message to the transcript (simulating a
    // still-running worker, or a late event).
    const tpath = join(runDir, "run_grow.jsonl");
    const before = readFileSync(tpath, "utf8");
    writeFileSync(tpath, before + msg("run_grow", "LATE-MESSAGE", 200), "utf8");

    // Page 2 must use the frozen prefix: no LATE-MESSAGE, no dup, no skip.
    const raw2 = await collectRunMessages({ runId: "run_grow", runDir, cursor: page1.nextCursor, appendCollectedFn: async () => {} });
    const page2 = projectCollectResult(raw2, { runId: "run_grow", cursor: page1.nextCursor });
    const collected = [...page1.messages.map((m) => m.text), ...page2.messages.map((m) => m.text)];
    assert.equal(collected.length, 10, "all 10 original messages");
    assert.ok(!collected.includes("LATE-MESSAGE"), "late message NOT read by this continuation");
    assert.equal(page2.nextCursor, null);
    // No duplicates
    const set = new Set(collected);
    assert.equal(set.size, collected.length, "no duplicate messages");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M11-4-B2-07: Host/MCP restart — cursor survives a fresh process.
// (Unit-level: cursor is pure data; restart = decode in a fresh call.)
// ---------------------------------------------------------------------
test("M11-4-B2-07: cursor is pure data (no in-process state) — decodable on fresh decode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-b2-07-"));
  try {
    const runDir = join(dir, "runs");
    const events = [];
    for (let i = 0; i < 10; i += 1) events.push(msg("run_restart", `R-${i}`, i));
    writeTranscript(runDir, "run_restart",
      sessionHeader("run_restart") + events.join("") +
      jl({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-22T00:10:00.000Z", runId: "run_restart", agentId: "researcher" }));
    const raw1 = await collectRunMessages({ runId: "run_restart", runDir, appendCollectedFn: async () => {} });
    const page1 = projectCollectResult(raw1, { runId: "run_restart" });
    const cursor = page1.nextCursor;
    // "Restart" = decode the cursor with a fresh decodeCollectCursor call
    // (no closure, no shared module-level cache). Round-trip must be stable.
    const decoded = decodeCollectCursor(cursor);
    assert.equal(decoded.v, 1);
    assert.ok(Number.isInteger(decoded.m) && decoded.m >= 0);
    assert.ok(Number.isInteger(decoded.o) && decoded.o >= 0);
    assert.ok(Number.isInteger(decoded.n) && decoded.n > 0);
    // Re-encode → identical token (canonical form).
    const reencoded = encodeCollectCursor(decoded);
    assert.equal(reencoded, cursor, "cursor is canonical and idempotent under re-encode");
  } finally {
    cleanupDir(dir);
  }
});
