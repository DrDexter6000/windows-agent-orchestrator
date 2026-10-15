// test/transcript/transitionExpectedLastSeq.test.js
//
// transitionState 的 expectedLastSeq 选项（runs settle 的写入守卫）：
//   - 锁内最后 seq 与证明时记下的不一致 → 拒绝（observed_seq_changed）、不写终态；
//   - 一致 → 正常结算（factEvents 与 state_change 原子同批）；
//   - 不传该选项 → 行为逐字节不变（含既有 first-terminal-wins 拒绝路径）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonlTranscript, readTranscript } from "../../src/transcript.js";

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function seedPending(tp, runId) {
  const t = new JsonlTranscript(tp, { runId, agentId: "a" });
  await t.append("run.background_submitted", { background: true });
  await t.transitionState(null, "pending", "created");
  return t;
}

test("SEQ-01: expectedLastSeq 不符 → accepted:false、rejection.reason=observed_seq_changed、不写终态", async () => {
  const dir = tempDir("wao-seq01-");
  try {
    const tp = join(dir, "run_seq01.jsonl");
    await seedPending(tp, "run_seq01");
    const events = await readTranscript(tp);
    const staleSeq = events.at(-1).seq; // 证明时刻
    // 证明之后、写入之前：转录长过（daemon 重放追加了一条）。
    const grow = new JsonlTranscript(tp, { runId: "run_seq01", agentId: "a", initialSeq: staleSeq });
    await grow.append("session.created", { backend: "process", backendSessionId: "proc_123" });

    const t = new JsonlTranscript(tp, { runId: "run_seq01", agentId: "a", initialSeq: staleSeq + 1 });
    const result = await t.transitionState("pending", "failed", "process_missing", {
      expectedLastSeq: staleSeq,
      factEvents: [{ type: "run.process_missing_confirmed", payload: { settledBy: "lead_settle" } }],
    });
    assert.equal(result.accepted, false);
    assert.equal(result.rejection.reason, "observed_seq_changed");
    assert.equal(result.rejection.observedLastSeq, staleSeq + 1);
    assert.equal(result.rejection.expectedLastSeq, staleSeq);

    const after = await readTranscript(tp);
    assert.ok(!after.some((e) => e.type === "run.state_change" && e.to === "failed"), "不写终态");
    assert.ok(!after.some((e) => e.type === "run.process_missing_confirmed"), "不写确认事实");
    assert.ok(after.some((e) => e.type === "run.state_change_rejected"
      && e.reason === "observed_seq_changed"), "拒绝有审计事件（不静默消失）");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SEQ-02: expectedLastSeq 相符 → 正常接受，factEvents 与 state_change 原子同批", async () => {
  const dir = tempDir("wao-seq02-");
  try {
    const tp = join(dir, "run_seq02.jsonl");
    await seedPending(tp, "run_seq02");
    const events = await readTranscript(tp);
    const expectedLastSeq = events.at(-1).seq;

    const t = new JsonlTranscript(tp, { runId: "run_seq02", agentId: "a", initialSeq: expectedLastSeq });
    const result = await t.transitionState("pending", "failed", "process_missing", {
      expectedLastSeq,
      factEvents: [{ type: "run.process_missing_confirmed", payload: { settledBy: "lead_settle" } }],
    });
    assert.equal(result.accepted, true);
    assert.equal(result.state, "failed");
    assert.deepEqual(result.facts.map((f) => f.type), ["run.process_missing_confirmed"]);

    const after = await readTranscript(tp);
    const confirmed = after.find((e) => e.type === "run.process_missing_confirmed");
    const terminal = after.find((e) => e.type === "run.state_change" && e.to === "failed");
    assert.equal(confirmed.seq, terminal.seq - 1, "确认事实紧邻终态转移（同批连续 seq）");
    assert.equal(terminal.reason, "process_missing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SEQ-03: 不传 expectedLastSeq → 行为不变：既有终态仍 first_terminal_wins，正常路径照写", async () => {
  const dir = tempDir("wao-seq03-");
  try {
    const tp = join(dir, "run_seq03.jsonl");
    await seedPending(tp, "run_seq03");
    const t1 = new JsonlTranscript(tp, { runId: "run_seq03", agentId: "a" });
    await t1.transitionState("pending", "failed", "backend_error", {});

    // 不传选项 + 已有终态 → 既有拒绝（first_terminal_wins），审计事件形状不变。
    const t2 = new JsonlTranscript(tp, { runId: "run_seq03", agentId: "a", initialSeq: 3 });
    const rejected = await t2.transitionState("pending", "aborted", "user", {
      attemptEvents: [{ type: "run.stop_requested", payload: { reason: "user" } }],
    });
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.rejection.reason, "first_terminal_wins");
    assert.equal(rejected.state, "failed");
    assert.deepEqual(rejected.attempts.map((a) => a.type), ["run.stop_requested"]);

    const raw = readFileSync(tp, "utf8");
    const rejection = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .find((e) => e.type === "run.state_change_rejected");
    assert.ok(rejection.existingTerminal, "拒绝载荷仍带 existingTerminal（既有形状）");
    assert.equal(rejection.expectedLastSeq, undefined, "不出现新载荷字段");
    assert.equal(rejection.observedLastSeq, undefined);

    // 不传选项 + 无终态 → 正常接受（字节形状不变）。
    const tp2 = join(dir, "run_seq03b.jsonl");
    await seedPending(tp2, "run_seq03b");
    const t3 = new JsonlTranscript(tp2, { runId: "run_seq03b", agentId: "a" });
    const okResult = await t3.transitionState("pending", "failed", "process_missing", {});
    assert.equal(okResult.accepted, true);
    assert.deepEqual(okResult.facts, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SEQ-04: observed_seq_changed 拒绝也同批写 attemptEvents（无论成败都落盘的既有契约）", async () => {
  const dir = tempDir("wao-seq04-");
  try {
    const tp = join(dir, "run_seq04.jsonl");
    await seedPending(tp, "run_seq04");
    const events = await readTranscript(tp);
    const staleSeq = events.at(-1).seq;
    const t = new JsonlTranscript(tp, { runId: "run_seq04", agentId: "a", initialSeq: staleSeq });
    const result = await t.transitionState("pending", "failed", "process_missing", {
      expectedLastSeq: staleSeq - 1, // 永远不符
      attemptEvents: [{ type: "run.stop_requested", payload: { reason: "user" } }],
    });
    assert.equal(result.accepted, false);
    assert.equal(result.rejection.reason, "observed_seq_changed");
    assert.deepEqual(result.attempts.map((a) => a.type), ["run.stop_requested"]);
    const after = await readTranscript(tp);
    assert.ok(!after.some((e) => e.type === "run.state_change" && e.to === "failed"), "终态仍不写");
    assert.ok(after.some((e) => e.type === "run.stop_requested"), "attempt 事实落盘");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
