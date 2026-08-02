// test/runActivityProjection.test.js
//
// M12-8 Package A — runActivityProjection RED→GREEN causal tests.
//
// Pure trust-boundary projector for the shared read-only activity timeline.
// No fs, no git, no MCP SDK: every case feeds an in-memory event snapshot.
// These tests are written BEFORE the implementation (strict RED→GREEN) and
// encode the 15-item Package A matrix at the projection layer (items 1-11, 15;
// workspace binding (#12), real MCP schema (#13), and zero-append over a real
// file (#14) are covered by the service / MCP / smoke tests).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  projectRunActivity,
  ACTIVITY_CATEGORIES,
  encodeActivityCursor,
  decodeActivityCursor,
  LEAD_TEXT_EXCERPT_CAP,
  LEAD_PAGE_DEFAULT,
  LEAD_PAGE_HARD_CAP,
  OWNER_TEXT_EXCERPT_CAP,
  computeEventSnapshotDigestForTest,
} from "../src/application/runActivityProjection.js";

// ===== Helpers =====

const RUN_ID = "run_act_proj";

let SEQ = 0;
function resetSeq() { SEQ = 0; }
function ev(overrides = {}) {
  SEQ += 1;
  return {
    ts: "2026-08-02T00:00:00.000Z",
    seq: SEQ,
    runId: RUN_ID,
    agentId: "coder_low",
    type: "run.event",
    ...overrides,
  };
}

function msgEvent(role, text, overrides = {}) {
  return ev({ kind: "message", role, parts: [{ type: "text", text }], ...overrides });
}
function cmdEvent(exitCode, overrides = {}) {
  return ev({ kind: "command", command: "rm -rf /super/secret/path", ...(exitCode === undefined ? {} : { exitCode }), ...overrides });
}
function toolUseEvent(tool, input, overrides = {}) {
  return ev({ kind: "tool_use", tool, input, ...overrides });
}
function toolResultEvent(isError, output, overrides = {}) {
  return ev({ kind: "tool_result", tool: "Bash", output, isError, ...overrides });
}
function fileWrittenEvent(path, overrides = {}) {
  return ev({ kind: "file_written", path, ...overrides });
}
function stateEvent(to, overrides = {}) {
  return ev({ type: "run.state_change", from: "running", to, reason: "done", ...overrides });
}
function lifecycleEvent(type, overrides = {}) {
  return ev({ type, ...overrides });
}

function snap(events, opts = {}) {
  return {
    events,
    agentId: opts.agentId ?? "coder_low",
    backend: opts.backend ?? "process",
    state: opts.state ?? "running",
    terminal: opts.terminal ?? false,
  };
}

function project(events, opts = {}) {
  return projectRunActivity(snap(events), {
    runId: RUN_ID,
    audience: "lead",
    ...opts,
  });
}

// base64url encode of a raw UTF-8 string (for forging non-canonical cursors).
function b64urlRaw(str) {
  return Buffer.from(str, "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// =====================================================================
// #1 normal ordered activity page + terminal facts
// =====================================================================
test("#1 normal ordered activity page preserves seq order and surfaces terminal facts", () => {
  resetSeq();
  const events = [
    msgEvent("assistant", "hello one"),
    cmdEvent(0),
    toolUseEvent("Read", { command: "rm -rf /" }),
    toolResultEvent(false, "raw output"),
    fileWrittenEvent("src/a.js"),
    stateEvent("completed"),
  ];
  const r = project(events);
  assert.equal(r.runId, RUN_ID);
  assert.equal(r.state, "running");
  assert.equal(r.terminal, false);
  // entries ordered by seq ascending.
  const seqs = r.entries.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "entries seq-ordered");
  // categories present in order.
  assert.deepEqual(r.entries.map((e) => e.category), ["message", "command", "tool_use", "tool_result", "file_written", "state"]);
  // the state entry carries the terminal fact.
  const st = r.entries.at(-1);
  assert.equal(st.to, "completed");
  assert.equal(st.terminal, true);
  // counts cover the frozen filtered snapshot, not just the page.
  assert.deepEqual(r.counts, {
    message: 1, command: 1, tool_use: 1, tool_result: 1, file_written: 1, state: 1, other: 0,
  });
  assert.equal(r.total, 6);
  // assistant text excerpt surfaced.
  assert.equal(r.entries[0].role, "assistant");
  assert.equal(r.entries[0].text, "hello one");
});

// =====================================================================
// #2 empty transcript activity
// =====================================================================
test("#2 empty snapshot yields empty entries and zero counts, no cursor", () => {
  resetSeq();
  const r = project([]);
  assert.deepEqual(r.entries, []);
  assert.equal(r.total, 0);
  assert.equal(r.truncated, false);
  assert.equal(r.nextCursor, null);
  assert.deepEqual(r.counts, {
    message: 0, command: 0, tool_use: 0, tool_result: 0, file_written: 0, state: 0, other: 0,
  });
});

// =====================================================================
// #3 pagination reconstructs exact ordered safe entries
// =====================================================================
test("#3 paginating the whole chain reconstructs every safe entry in order", () => {
  resetSeq();
  const events = [];
  for (let i = 0; i < 25; i += 1) events.push(msgEvent("assistant", `m${i}`));
  events.push(stateEvent("completed"));
  let cursor = null;
  const collected = [];
  let guard = 0;
  while (true) {
    const page = project(events, { cursor, pageSize: 10 });
    collected.push(...page.entries);
    cursor = page.nextCursor;
    if (!cursor) break;
    guard += 1;
    if (guard > 10) throw new Error("runaway pagination");
  }
  // exact reconstruction: 25 assistant texts + 1 state.
  assert.equal(collected.length, 26);
  for (let i = 0; i < 25; i += 1) assert.equal(collected[i].text, `m${i}`, `msg ${i} in order`);
  assert.equal(collected[25].category, "state");
  assert.equal(collected[25].to, "completed");
});

// =====================================================================
// #4 append-after-page-1 keeps frozen reconstruction/counts stable
// =====================================================================
test("#4 append-only growth after page 1 keeps frozen counts + reconstruction stable", () => {
  resetSeq();
  const base = [];
  for (let i = 0; i < 15; i += 1) base.push(msgEvent("assistant", `m${i}`));
  // page 1 over the original 15-message snapshot.
  const page1 = project(base, { pageSize: 5 });
  assert.ok(page1.nextCursor, "page 1 has a cursor");
  const frozenTotal = page1.total;
  assert.equal(frozenTotal, 15);

  // simulate append-only growth: add 10 more assistant messages after page 1.
  const grown = [...base];
  for (let i = 15; i < 25; i += 1) grown.push(msgEvent("assistant", `m${i}`));
  const page2 = project(grown, { cursor: page1.nextCursor, pageSize: 5 });
  // counts/total describe the FROZEN page-1 snapshot, not the grown file.
  assert.equal(page2.total, frozenTotal, "total frozen at page-1 prefix");
  assert.deepEqual(page2.counts.message, 15, "message count frozen at page-1 prefix");
  // reconstruction continues the frozen prefix exactly (m5..m9), never grown m15+.
  assert.deepEqual(page2.entries.map((e) => e.text), ["m5", "m6", "m7", "m8", "m9"]);
});

// =====================================================================
// #5 historical mutation/shrink rejects cursor
// =====================================================================
test("#5a mutating history after page 1 rejects the cursor (fail closed)", () => {
  resetSeq();
  const base = [];
  for (let i = 0; i < 15; i += 1) base.push(msgEvent("assistant", `m${i}`));
  const page1 = project(base, { pageSize: 5 });
  // mutate an event in the frozen prefix.
  const mutated = base.map((e, i) => (i === 2 ? { ...e, parts: [{ type: "text", text: "TAMPERED" }] } : e));
  assert.throws(() => project(mutated, { cursor: page1.nextCursor, pageSize: 5 }), /snapshot/);
});

test("#5b shrinking history after page 1 rejects the cursor (fail closed)", () => {
  resetSeq();
  const base = [];
  for (let i = 0; i < 15; i += 1) base.push(msgEvent("assistant", `m${i}`));
  const page1 = project(base, { pageSize: 5 });
  const shrunk = base.slice(0, 8); // fewer than the frozen prefix length
  assert.throws(() => project(shrunk, { cursor: page1.nextCursor, pageSize: 5 }), /shrink|shrunk|snapshot/);
});

// =====================================================================
// #6 cross-run and cross-filter cursor reject
// =====================================================================
test("#6a cross-run cursor rejects (runId digest mismatch)", () => {
  resetSeq();
  const events = [];
  for (let i = 0; i < 15; i += 1) events.push(msgEvent("assistant", `m${i}`));
  const page1 = project(events, { pageSize: 5 });
  assert.throws(
    () => projectRunActivity(snap(events), { runId: "run_OTHER", cursor: page1.nextCursor, pageSize: 5 }),
    /runId/,
  );
});

test("#6b cross-filter cursor rejects (view digest mismatch)", () => {
  resetSeq();
  const events = [];
  for (let i = 0; i < 15; i += 1) events.push(msgEvent("assistant", `m${i}`));
  for (let i = 0; i < 5; i += 1) events.push(cmdEvent(0));
  // page 1 filtered to messages only.
  const page1 = project(events, { categories: ["message"], pageSize: 5 });
  assert.ok(page1.nextCursor);
  // continuation with a DIFFERENT filter set must fail closed.
  assert.throws(
    () => project(events, { categories: ["command"], cursor: page1.nextCursor, pageSize: 5 }),
    /filter|view/,
  );
});

// =====================================================================
// #7 malformed / noncanonical / oversized cursor reject
// =====================================================================
test("#7 malformed cursors reject (charset, structure, extra keys, wrong types)", () => {
  resetSeq();
  const events = [msgEvent("assistant", "x")];
  const bad = [
    "not-base64url!!!", // bad charset
    b64urlRaw("not json{"), // non-JSON
    b64urlRaw(JSON.stringify({ v: 1, r: "x".repeat(22), s: "y".repeat(22), n: 1, f: "z".repeat(22), p: 0, extra: "boom" })), // extra key
    b64urlRaw(JSON.stringify({ v: 99, r: "x".repeat(22), s: "y".repeat(22), n: 1, f: "z".repeat(22), p: 0 })), // bad version
    b64urlRaw(JSON.stringify({ v: 1, r: "x".repeat(22), s: "y".repeat(22), n: -1, f: "z".repeat(22), p: 0 })), // bad n
    b64urlRaw(JSON.stringify({ v: 1, r: "x".repeat(22), s: "y".repeat(22), n: 1, f: "z".repeat(22), p: -3 })), // bad p
  ];
  for (const c of bad) {
    assert.throws(() => project(events, { cursor: c }), /cursor/i, `rejects ${c.slice(0, 16)}`);
  }
});

test("#7b noncanonical cursor rejects (re-encoded with different key order / whitespace)", () => {
  resetSeq();
  const events = [];
  for (let i = 0; i < 15; i += 1) events.push(msgEvent("assistant", `m${i}`));
  const page1 = project(events, { pageSize: 5 });
  // decode the valid token, then forge a semantically-equal but NON-canonical token
  // (keys reordered + whitespace). decode must reject it as noncanonical.
  const payload = decodeActivityCursor(page1.nextCursor);
  const nonCanonical = b64urlRaw(JSON.stringify({ p: payload.p, f: payload.f, n: payload.n, s: payload.s, r: payload.r, v: payload.v }));
  assert.throws(() => project(events, { cursor: nonCanonical }), /noncanonical|canonical|cursor/i);
});

test("#7c oversized cursor rejects", () => {
  resetSeq();
  const events = [msgEvent("assistant", "x")];
  // a token longer than the hard cap (256).
  const oversized = "A".repeat(300);
  assert.throws(() => project(events, { cursor: oversized }), /cursor|length|long/i);
});

test("#7d out-of-range cursor position rejects", () => {
  resetSeq();
  const events = [];
  for (let i = 0; i < 5; i += 1) events.push(msgEvent("assistant", `m${i}`));
  const page1 = project(events, { pageSize: 3 });
  const dec = decodeActivityCursor(page1.nextCursor);
  // the cursor's snapshot digest must match the raw-event test export (binding proof).
  assert.equal(dec.s, computeEventSnapshotDigestForTest(events), "snapshot digest bound to raw events");
  // forge a continuation cursor whose position p exceeds the filtered total.
  const outOfRange = encodeActivityCursor({ ...dec, p: 999 });
  assert.throws(() => project(events, { cursor: outOfRange }), /range|position|cursor/i);
});

// =====================================================================
// #8 secret spanning projection boundary is redacted before truncation/pagination
// =====================================================================
test("#8 a secret near the excerpt boundary is redacted before truncation (no raw leak)", () => {
  resetSeq();
  const SECRET = "test-secret-boundary-m128"; // >=8 chars, in env below
  // place the secret so its redaction marker fully fits inside the excerpt,
  // proving redaction runs BEFORE truncation (the marker survives, not the secret).
  const text = "a".repeat(LEAD_TEXT_EXCERPT_CAP - 100) + SECRET + "b".repeat(200);
  const events = [msgEvent("assistant", text)];
  const r = project(events, { env: { LEAK_TOKEN: SECRET } });
  const entry = r.entries[0];
  assert.equal(entry.role, "assistant");
  assert.ok(!entry.text.includes(SECRET), "raw secret must not appear in the excerpt");
  assert.ok(entry.text.includes("[REDACTED"), "secret was redacted before truncation");
  // excerpt still bounded to the lead cap.
  assert.ok(entry.text.length <= LEAD_TEXT_EXCERPT_CAP, "excerpt bounded to lead cap");
  assert.equal(entry.truncated, true);
});

test("#8b a secret in a message that only appears on page 2 is still redacted", () => {
  resetSeq();
  const SECRET = "test-secret-page2-m128b";
  const events = [];
  // page 1 fills with safe messages.
  for (let i = 0; i < LEAD_PAGE_DEFAULT; i += 1) events.push(msgEvent("assistant", `safe-${i}`));
  // page 2 carries the secret.
  events.push(msgEvent("assistant", `prefix ${SECRET} suffix`));
  const page1 = project(events, { env: { LEAK_TOKEN: SECRET } });
  const page2 = project(events, { cursor: page1.nextCursor, env: { LEAK_TOKEN: SECRET } });
  const all = [...page1.entries, ...page2.entries].map((e) => e.text || "").join("\n");
  assert.ok(!all.includes(SECRET), "secret redacted across the page boundary");
  assert.ok(all.includes("[REDACTED"), "redaction marker present");
});

// =====================================================================
// #9 C0/C1/DEL neutralized while LF/TAB policy remains explicit
// =====================================================================
test("#9 control chars neutralized; LF and TAB preserved", () => {
  resetSeq();
  // BEL, backspace, DEL, C1 (0x85) must become U+FFFD; \n and \t preserved.
  const text = "line1\tcol\nline2\u0007back\u0008space\u007F\u0085done";
  const events = [msgEvent("assistant", text)];
  const r = project(events);
  const t = r.entries[0].text;
  assert.ok(t.includes("\n"), "LF preserved");
  assert.ok(t.includes("\t"), "TAB preserved");
  assert.ok(!t.includes("\u0007"), "BEL neutralized");
  assert.ok(!t.includes("\u0008"), "backspace neutralized");
  assert.ok(!t.includes("\u007F"), "DEL neutralized");
  assert.ok(!t.includes("\u0085"), "C1 neutralized");
  assert.ok(t.includes("\uFFFD"), "replacement char used");
});

// =====================================================================
// #10 command/tool/file/error raw payloads + absolute paths do not cross
// =====================================================================
test("#10 raw command/tool/file payloads and absolute paths never cross the lead schema", () => {
  resetSeq();
  const SECRET = "test-secret-payload-m128c";
  const events = [
    cmdEvent(0), // raw command text + secret in argv must NOT cross
    toolUseEvent("Bash", { command: "echo " + SECRET }), // input must NOT cross
    toolResultEvent(true, "stderr " + SECRET), // output must NOT cross
    fileWrittenEvent("C:\\Users\\leak\\secret.txt"), // absolute path must NOT cross
    fileWrittenEvent("/etc/passwd"), // posix absolute must NOT cross
    fileWrittenEvent("src/../etc/escape.txt"), // traversal must NOT cross
    lifecycleEvent("run.error", { error: "raw error " + SECRET }), // raw error must NOT cross -> other
  ];
  void SECRET;
  const r = project(events, { env: { LEAK_TOKEN: SECRET } });
  const json = JSON.stringify(r.entries);
  // none of the raw payloads may appear.
  assert.ok(!json.includes("rm -rf"), "no raw command text");
  assert.ok(!json.includes(SECRET), "no secret anywhere");
  assert.ok(!json.includes("C:\\"), "no absolute windows path");
  assert.ok(!json.includes("/etc/passwd"), "no absolute posix path");
  assert.ok(!json.includes(".."), "no traversal path");
  assert.ok(!json.includes("raw error"), "no raw error text");
  // command entry only carries a closed-set exitStatus.
  const cmd = r.entries.find((e) => e.category === "command");
  assert.deepEqual(Object.keys(cmd).sort(), ["category", "exitStatus", "seq", "ts"]);
  assert.ok(["ok", "failed", "unknown"].includes(cmd.exitStatus));
  // tool_use carries only a bounded tool name (no input).
  const tu = r.entries.find((e) => e.category === "tool_use");
  assert.equal(tu.tool, "Bash");
  assert.ok(!("input" in tu), "no tool input field");
  // tool_result carries only isError (no output, no opaque callId as tool name).
  const tr = r.entries.find((e) => e.category === "tool_result");
  assert.deepEqual(Object.keys(tr).sort(), ["category", "isError", "seq", "ts"]);
  // file_written paths are withheld markers (never the absolute/traversal raw).
  const fw = r.entries.filter((e) => e.category === "file_written").map((e) => e.path);
  assert.ok(fw.every((p) => p === "[path_withheld]" || p === "[REDACTED]"), "unsafe paths withheld");
  // run.error becomes a bounded `other` (label only), never the raw error.
  const other = r.entries.find((e) => e.category === "other");
  assert.ok(other.label, "other has a bounded label");
  assert.ok(!JSON.stringify(other).includes("raw error"), "no raw error payload echoed");
});

test("#10b exitStatus maps ok/failed/unknown without leaking the raw exit code", () => {
  resetSeq();
  const r = project([
    cmdEvent(0), // ok
    cmdEvent(9009), // failed (real windows code) -> label only, not the number
    ev({ kind: "command", command: "x" }), // unknown (no exitCode)
  ]);
  const statuses = r.entries.map((e) => e.exitStatus);
  assert.deepEqual(statuses, ["ok", "failed", "unknown"]);
  assert.ok(!JSON.stringify(r.entries).includes("9009"), "raw exit code not surfaced");
});

// =====================================================================
// #11 unknown/legacy event shapes become bounded `other` or fail closed, never echo
// =====================================================================
test("#11 unknown run.event kinds + unknown top-level types become bounded other, never echo payload", () => {
  resetSeq();
  const events = [
    ev({ kind: "weird_future_kind", deep: { secret: "leak" }, blob: "x".repeat(2000) }),
    ev({ type: "future.durable_event", payload: { hidden: "leak" }, whatever: 42 }),
    // null / primitive lines (corrupt) must not crash or echo.
    null,
    42,
    "raw-string-line",
  ];
  const r = project(events);
  const others = r.entries.filter((e) => e.category === "other");
  assert.equal(others.length, 2, "two object-shaped unknown events -> other; non-objects skipped");
  const json = JSON.stringify(r.entries);
  assert.ok(!json.includes("leak"), "unknown payload never echoed");
  assert.ok(!json.includes("hidden"), "unknown payload never echoed");
  // each `other` entry is bounded: only seq/ts/category/label.
  for (const o of others) {
    assert.deepEqual(Object.keys(o).sort(), ["category", "label", "seq", "ts"]);
    assert.ok(o.label.length <= 64, "label bounded");
  }
});

// =====================================================================
// #15 owner and lead modes share classifiers/cursor/redaction but expose different caps
// =====================================================================
test("#15 owner and lead share classification+redaction+cursor; differ only in caps", () => {
  resetSeq();
  const longText = "z".repeat(OWNER_TEXT_EXCERPT_CAP + 50);
  const events = [
    msgEvent("assistant", longText),
    cmdEvent(1),
    fileWrittenEvent("src/a.js"),
    stateEvent("completed"),
  ];
  const lead = projectRunActivity(snap(events), { runId: RUN_ID, audience: "lead" });
  const owner = projectRunActivity(snap(events), { runId: RUN_ID, audience: "owner" });
  // SAME closed-set categories/order/counts (shared classifier).
  assert.deepEqual(lead.entries.map((e) => e.category), owner.entries.map((e) => e.category));
  assert.deepEqual(lead.counts, owner.counts);
  assert.equal(lead.total, owner.total);
  // SAME redaction policy (no raw payload in either).
  assert.equal(lead.entries[2].path, owner.entries[2].path);
  // DIFFERENT text caps: owner excerpt is strictly larger than lead.
  assert.ok(owner.entries[0].text.length > lead.entries[0].text.length, "owner text cap larger");
  assert.ok(lead.entries[0].text.length <= LEAD_TEXT_EXCERPT_CAP);
  assert.ok(owner.entries[0].text.length <= OWNER_TEXT_EXCERPT_CAP);
  assert.equal(lead.entries[0].truncated, true);
  // cursor machinery shared: a lead page-1 cursor is structurally valid and the
  // codec round-trips identically for both audiences.
  const leadMulti = projectRunActivity(snap([...events, ...events]), { runId: RUN_ID, audience: "lead", pageSize: 2 });
  assert.ok(leadMulti.nextCursor, "cursor emitted for multi-page lead view");
  const dec = decodeActivityCursor(leadMulti.nextCursor);
  assert.equal(dec.v, 1);
  assert.ok(Number.isInteger(dec.p));
});

// =====================================================================
// Sanity: closed-set category filter narrows entries and counts together.
// =====================================================================
test("category filter narrows entries + counts consistently", () => {
  resetSeq();
  const events = [
    msgEvent("assistant", "a"),
    cmdEvent(0),
    cmdEvent(1),
    stateEvent("completed"),
  ];
  const r = project(events, { categories: ["command"] });
  assert.deepEqual(r.entries.map((e) => e.category), ["command", "command"]);
  assert.equal(r.counts.command, 2);
  assert.equal(r.counts.message, 0, "filtered-out category counted 0 in the filtered view");
  assert.equal(r.total, 2);
});

// =====================================================================
// Sanity: afterSeq filters by seq (> afterSeq), never wall-clock.
// =====================================================================
test("afterSeq filters events with seq > afterSeq", () => {
  resetSeq();
  const events = [
    msgEvent("assistant", "a"), // seq 1
    msgEvent("assistant", "b"), // seq 2
    msgEvent("assistant", "c"), // seq 3
  ];
  const r = project(events, { afterSeq: 1 });
  assert.deepEqual(r.entries.map((e) => e.text), ["b", "c"]);
  assert.equal(r.total, 2);
});
