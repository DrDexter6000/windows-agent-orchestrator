import { mkdtemp, readFile } from "node:fs/promises";
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
  RUN_STATES,
  TERMINAL_STATES,
} from "../src/transcript.js";

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
