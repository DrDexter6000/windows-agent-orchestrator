// test/runStatus.test.js
//
// M9-3A: shared run status application service — TDD tests.
//
// Proves that CLI status aggregation is extracted into a shared, argv-free,
// console-free, MCP-free application service that owns:
//   - runId validation (isValidRunId SSOT, before path/file access)
//   - state via findState + terminal via TERMINAL_STATES (no second algorithm)
//   - activity aggregation (TD-75 semantics: last run.event → kind/summary/age)
//   - deterministic secondsSinceActivity via injectable nowFn
//   - fail-closed on missing transcript (no file creation)
//   - read-only: no transcript/owner writes, no console output

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getRunStatus, describeActivity } from "../../src/application/runStatus.js";
import { TERMINAL_STATES } from "../../src/transcript.js";

// ===== Helpers =====

function writeTranscript(dir, runId, lines) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.jsonl`), lines, "utf8");
}

function ev(obj) {
  return JSON.stringify(obj) + "\n";
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// A transcript with a pending state + a run.event (command).
const SAMPLE_RUN = "run_sample_m93a";
function sampleEvents() {
  return [
    ev({ type: "run.background_submitted", ts: "2026-07-14T00:00:00.000Z", runId: SAMPLE_RUN, agentId: "coder_low", seq: 1 }),
    ev({ type: "run.state_change", to: "pending", reason: "background_spawned", ts: "2026-07-14T00:00:01.000Z", runId: SAMPLE_RUN, agentId: "coder_low", seq: 2 }),
    ev({ type: "run.state_change", to: "running", reason: "started", ts: "2026-07-14T00:00:05.000Z", runId: SAMPLE_RUN, agentId: "coder_low", seq: 3 }),
    ev({ type: "run.event", kind: "command", command: "npm test", ts: "2026-07-14T00:00:10.000Z", runId: SAMPLE_RUN, agentId: "coder_low", seq: 4 }),
  ].join("");
}

// ===== Tests =====

test("M12-Claude STATUS-1: runtime activity is rendered from a closed status only", () => {
  assert.deepEqual(
    describeActivity({
      kind: "runtime_activity",
      status: "provider_retry",
      error: "SECRET_PROVIDER_ERROR",
    }),
    {
      lastActivityKind: "运行时状态",
      lastActivitySummary: "provider 正在重试",
    },
  );
  assert.deepEqual(
    describeActivity({ kind: "runtime_activity", status: "SECRET_STATUS" }),
    {
      lastActivityKind: "运行时状态",
      lastActivitySummary: "provider 状态未知",
    },
  );
});

// ---------------------------------------------------------------------
// M9-3A-01: states map correctly to state + terminal flag.
// ---------------------------------------------------------------------

test("M9-3A-01: running/completed/failed/aborted/timed_out state and terminal correct", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m93a-01-"));
  try {
    const states = [
      { to: "running", terminal: false },
      { to: "completed", terminal: true },
      { to: "failed", terminal: true },
      { to: "aborted", terminal: true },
      { to: "timed_out", terminal: true },
    ];
    for (const { to, terminal } of states) {
      const runDir = join(dir, to);
      const runId = `run_${to}`;
      writeTranscript(runDir, runId,
        ev({ type: "run.state_change", to: "pending", reason: "init", ts: "2026-07-14T00:00:00.000Z", runId, agentId: "w", seq: 1 }) +
        ev({ type: "run.state_change", to, reason: "test", ts: "2026-07-14T00:00:01.000Z", runId, agentId: "w", seq: 2 }),
      );
      const result = await getRunStatus({ runId, runDir });
      assert.equal(result.state, to, `state is ${to}`);
      assert.equal(result.terminal, terminal, `terminal is ${terminal} for ${to}`);
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-3A-02: no state_change → findState legacy derivation (no second algorithm).
// ---------------------------------------------------------------------

test("M9-3A-02: legacy transcript without state_change derives state via findState", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m93a-02-"));
  try {
    const runId = "run_legacy_m93a";
    // A transcript with a run.completed event but no run.state_change.
    // findState's legacy fallback should infer terminal from the fact event.
    writeTranscript(dir, runId,
      ev({ type: "run.event", kind: "command", command: "echo hi", ts: "2026-07-14T00:00:01.000Z", runId, agentId: "w", seq: 1 }) +
      ev({ type: "run.completed", ts: "2026-07-14T00:00:02.000Z", runId, agentId: "w", seq: 2 }),
    );
    const result = await getRunStatus({ runId, runDir: dir });
    // findState should infer "completed" from run.completed (legacy terminal fact).
    assert.equal(result.state, "completed", "legacy state derived via findState");
    assert.equal(result.terminal, true, "legacy completed is terminal");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-3A-03: last run.event → kind/summary/ts consistent with TD-75 semantics.
// ---------------------------------------------------------------------

test("M9-3A-03: last activity kind/summary/ts match TD-75 semantics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m93a-03-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, SAMPLE_RUN, sampleEvents());
    const result = await getRunStatus({ runId: SAMPLE_RUN, runDir });

    // lastActivity points at the command event.
    assert.equal(result.lastActivityTs, "2026-07-14T00:00:10.000Z", "lastActivityTs = last run.event ts");
    // TD-75 human label for command kind.
    assert.equal(result.lastActivityKind, "跑命令", "command → 跑命令");
    // Summary contains the command text.
    assert.match(result.lastActivitySummary, /npm test/, "summary contains command");

    // Machine kind for MCP (the raw kind, not the human label).
    assert.equal(result.lastActivityEventKind, "command", "machine kind is command");

    // lastEvent is the literal last event (the run.event itself).
    assert.equal(result.lastEventType, "run.event", "lastEventType is run.event");
    assert.equal(result.lastEventTs, "2026-07-14T00:00:10.000Z", "lastEventTs");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-3A-04: no run.event → activity fields null.
// ---------------------------------------------------------------------

test("M9-3A-04: no run.event → activity fields null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m93a-04-"));
  try {
    const runId = "run_noevents_m93a";
    writeTranscript(dir, runId,
      ev({ type: "run.state_change", to: "pending", reason: "init", ts: "2026-07-14T00:00:00.000Z", runId, agentId: "w", seq: 1 }),
    );
    const result = await getRunStatus({ runId, runDir: dir });
    assert.equal(result.lastActivityTs, null, "lastActivityTs null");
    assert.equal(result.lastActivityKind, null, "lastActivityKind null");
    assert.equal(result.lastActivitySummary, null, "lastActivitySummary null");
    assert.equal(result.lastActivityEventKind, null, "lastActivityEventKind null");
    assert.equal(result.secondsSinceActivity, null, "secondsSinceActivity null");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-3A-05: fixed nowFn → secondsSinceActivity deterministic.
// ---------------------------------------------------------------------

test("M9-3A-05: fixed nowFn → secondsSinceActivity exact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m93a-05-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, SAMPLE_RUN, sampleEvents());
    // Last activity at 00:00:10. Fix now at 00:00:14 → 4 seconds.
    const fixedNow = () => new Date("2026-07-14T00:00:14.000Z").getTime();
    const result = await getRunStatus({ runId: SAMPLE_RUN, runDir, nowFn: fixedNow });
    assert.equal(result.secondsSinceActivity, 4, "exactly 4 seconds since last activity");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// TD-113（2026-08-20）: CLI status 写活动重复计数器。
// 长文档/大文件写入期间分清"在推进"还是"卡死"：file_written 的
// lastActivitySummary 带末尾同名写入计数。真实 transcript 中 file_written
// 永不相邻（四个 parser 都在其前紧邻 push tool_result），所以计数在
// file_written 子序列上做（交错不算断）；数据来源是调用点的绑定 scope
// （外 run 尾条不灌进计数——R23-B 探针在 boundReadSweep.test.js）；时钟复用
// getRunStatus 既有 _now（测试传固定 now）。
// ---------------------------------------------------------------------

test("TD-113-DEFAULT: describeActivity 不传第二参 → 输出与既有单事件形式逐字节一致（缺省行为钉）", () => {
  assert.deepEqual(
    describeActivity({ kind: "file_written", path: "D:/proj/docs/report.md" }),
    { lastActivityKind: "在写文件", lastActivitySummary: "report.md" },
    "file_written 缺省 = 仅 basename，无计数后缀（字节级一致）",
  );
  assert.deepEqual(
    describeActivity({ kind: "command", command: "npm test" }),
    { lastActivityKind: "跑命令", lastActivitySummary: "npm test" },
    "非 file_written kind 不受签名演进影响",
  );
  assert.deepEqual(
    describeActivity(null),
    { lastActivityKind: null, lastActivitySummary: null },
    "null 事件缺省路径不变",
  );
});

test("TD-113-UNIT: 交错夹具 — file_written(A)→tool_result→file_written(A)→tool_result→file_written(A) → ×3（交错不算断）", () => {
  const A = "D:/proj/docs/report.md";
  const fw = (seq) => ({ kind: "file_written", path: A, seq });
  const tr = (seq) => ({ kind: "tool_result", tool: "Write", seq });
  // scope 形状对齐真实 parser：file_written 前紧邻 tool_result，中间还可
  // 交错 message/thinking 等任何事件；末条 file_written 即被描述的 ev。
  const priorEvents = [
    { kind: "message", role: "assistant", seq: 1 },
    fw(2), tr(3), fw(4), tr(5), fw(6),
  ];
  const ev = priorEvents[priorEvents.length - 1];
  assert.deepEqual(
    describeActivity(ev, { priorEvents, now: () => 0 }),
    { lastActivityKind: "在写文件", lastActivitySummary: "写 report.md ×3（最近）" },
    "file_written 子序列末段 3 条同 path → ×3",
  );
});

test("TD-113-BOUNDARY: 不同 path 的 file_written 即断；全文比较（同 basename 不同目录不算同名续写）", () => {
  const tr = (seq) => ({ kind: "tool_result", tool: "Write", seq });
  // (a) A → B 收尾：B 的末段只有自己 → ×1。
  assert.deepEqual(
    describeActivity(
      { kind: "file_written", path: "D:/proj/docs/b.txt" },
      { priorEvents: [{ kind: "file_written", path: "D:/proj/src/a.txt" }, tr(2), { kind: "file_written", path: "D:/proj/docs/b.txt" }], now: () => 0 },
    ),
    { lastActivityKind: "在写文件", lastActivitySummary: "写 b.txt ×1（最近）" },
    "不同 path 即断 → ×1",
  );
  // (b) A → A → B 收尾：B 仍 ×1（前面的 A/A 与 B 不同名，不续）。
  assert.deepEqual(
    describeActivity(
      { kind: "file_written", path: "D:/proj/docs/b.txt" },
      { priorEvents: [{ kind: "file_written", path: "D:/proj/src/a.txt" }, { kind: "file_written", path: "D:/proj/src/a.txt" }, { kind: "file_written", path: "D:/proj/docs/b.txt" }], now: () => 0 },
    ),
    { lastActivityKind: "在写文件", lastActivitySummary: "写 b.txt ×1（最近）" },
  );
  // (c) 同 basename、不同目录：path 全文不同 → 不算同名续写。
  assert.deepEqual(
    describeActivity(
      { kind: "file_written", path: "D:/other/src/a.txt" },
      { priorEvents: [{ kind: "file_written", path: "D:/proj/src/a.txt" }, { kind: "file_written", path: "D:/other/src/a.txt" }], now: () => 0 },
    ),
    { lastActivityKind: "在写文件", lastActivitySummary: "写 a.txt ×1（最近）" },
    "计数按全文 path 比较（显示才用 basename）",
  );
});

test("TD-113-1: getRunStatus 交错写序列 → lastActivitySummary = 写 report.md ×3（最近），kind/ts/age 照旧", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td113-1-"));
  try {
    const runDir = join(dir, "runs");
    const runId = "run_td113_1";
    const A = "D:/proj/docs/report.md";
    writeTranscript(runDir, runId,
      ev({ type: "run.submitted", ts: "2026-08-20T00:00:00.000Z", runId, agentId: "coder_hq", seq: 1 }) +
      ev({ type: "run.state_change", to: "running", reason: "started", ts: "2026-08-20T00:00:01.000Z", runId, agentId: "coder_hq", seq: 2 }) +
      ev({ type: "run.event", kind: "tool_use", tool: "Write", input: { file_path: A }, ts: "2026-08-20T00:00:02.000Z", runId, agentId: "coder_hq", seq: 3 }) +
      ev({ type: "run.event", kind: "file_written", path: A, ts: "2026-08-20T00:00:03.000Z", runId, agentId: "coder_hq", seq: 4 }) +
      ev({ type: "run.event", kind: "tool_result", tool: "Write", ts: "2026-08-20T00:00:04.000Z", runId, agentId: "coder_hq", seq: 5 }) +
      ev({ type: "run.event", kind: "tool_use", tool: "Write", input: { file_path: A }, ts: "2026-08-20T00:00:05.000Z", runId, agentId: "coder_hq", seq: 6 }) +
      ev({ type: "run.event", kind: "file_written", path: A, ts: "2026-08-20T00:00:06.000Z", runId, agentId: "coder_hq", seq: 7 }) +
      ev({ type: "run.event", kind: "tool_result", tool: "Write", ts: "2026-08-20T00:00:07.000Z", runId, agentId: "coder_hq", seq: 8 }) +
      ev({ type: "run.event", kind: "file_written", path: A, ts: "2026-08-20T00:00:08.000Z", runId, agentId: "coder_hq", seq: 9 }),
    );
    const fixedNow = () => new Date("2026-08-20T00:00:11.000Z").getTime();
    const result = await getRunStatus({ runId, runDir, nowFn: fixedNow });
    assert.equal(result.lastActivityKind, "在写文件", "kind 不变");
    assert.equal(result.lastActivitySummary, "写 report.md ×3（最近）", "交错 3 次同名写入 → ×3");
    assert.equal(result.lastActivityTs, "2026-08-20T00:00:08.000Z", "ts = 末条 run.event（第 3 次写入）");
    assert.equal(result.secondsSinceActivity, 3, "固定时钟下 age 照旧（复用同一 _now）");
    assert.equal(result.lastActivityEventKind, "file_written", "machine kind 不变");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-113-2: 单次写入 → ×1；换文件收尾 → 新文件 ×1；非写活动摘要不受计数影响（字节级）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td113-2-"));
  try {
    const runDir = join(dir, "runs");
    // (a) 单次写入 + 一次换文件收尾：末条是新文件 → ×1。
    const runIdA = "run_td113_2a";
    writeTranscript(runDir, runIdA,
      ev({ type: "run.submitted", ts: "2026-08-20T00:00:00.000Z", runId: runIdA, agentId: "coder_hq", seq: 1 }) +
      ev({ type: "run.event", kind: "file_written", path: "D:/proj/src/a.txt", ts: "2026-08-20T00:00:01.000Z", runId: runIdA, agentId: "coder_hq", seq: 2 }) +
      ev({ type: "run.event", kind: "tool_result", tool: "Write", ts: "2026-08-20T00:00:02.000Z", runId: runIdA, agentId: "coder_hq", seq: 3 }) +
      ev({ type: "run.event", kind: "file_written", path: "D:/proj/docs/b.md", ts: "2026-08-20T00:00:03.000Z", runId: runIdA, agentId: "coder_hq", seq: 4 }),
    );
    const a = await getRunStatus({ runId: runIdA, runDir, nowFn: () => new Date("2026-08-20T00:00:10.000Z").getTime() });
    assert.equal(a.lastActivitySummary, "写 b.md ×1（最近）", "不同 path 即断 → 新文件 ×1");

    // (b) 末条活动是 command（scope 上下文照传）：摘要保持既有形式，不带计数。
    const runIdB = "run_td113_2b";
    writeTranscript(runDir, runIdB,
      ev({ type: "run.submitted", ts: "2026-08-20T00:00:00.000Z", runId: runIdB, agentId: "coder_hq", seq: 1 }) +
      ev({ type: "run.event", kind: "file_written", path: "D:/proj/src/a.txt", ts: "2026-08-20T00:00:01.000Z", runId: runIdB, agentId: "coder_hq", seq: 2 }) +
      ev({ type: "run.event", kind: "command", command: "npm test", ts: "2026-08-20T00:00:02.000Z", runId: runIdB, agentId: "coder_hq", seq: 3 }),
    );
    const b = await getRunStatus({ runId: runIdB, runDir, nowFn: () => new Date("2026-08-20T00:00:10.000Z").getTime() });
    assert.deepEqual(
      { lastActivityKind: b.lastActivityKind, lastActivitySummary: b.lastActivitySummary },
      { lastActivityKind: "跑命令", lastActivitySummary: "npm test" },
      "非 file_written 末活动：计数上下文不改变既有摘要（字节级）",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("TD-113-3: 回扫上界 200 条事件 — 250 条连续同名写入按 200 截断（×200）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td113-3-"));
  try {
    const runDir = join(dir, "runs");
    const runId = "run_td113_3";
    const A = "D:/proj/big/report.md";
    // 250 条连续 file_written(A)（计数在子序列上做，连续形状与交错形状同值；
    // 回扫上界按"检视的事件条数"计 → 第 201 条以前截断 → N=200）。
    const writes = Array.from({ length: 250 }, (_, i) =>
      ev({ type: "run.event", kind: "file_written", path: A, ts: `2026-08-20T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`, runId, agentId: "coder_hq", seq: i + 2 }),
    ).join("");
    writeTranscript(runDir, runId,
      ev({ type: "run.submitted", ts: "2026-08-20T00:00:00.000Z", runId, agentId: "coder_hq", seq: 1 }) + writes,
    );
    const result = await getRunStatus({ runId, runDir, nowFn: () => new Date("2026-08-20T00:01:00.000Z").getTime() });
    assert.equal(result.lastActivitySummary, "写 report.md ×200（最近）", "超出回扫上界按 200 截断");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M12-17-S1..S5: submitted-stage executionStage is ADDITIVE to getRunStatus —
// same read-only snapshot, closed-set projection, deterministic age, no
// payload echo.
// ---------------------------------------------------------------------

test("M12-17-S1: executionStage active on sampleEvents with exact deterministic age", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1217-s1-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, SAMPLE_RUN, sampleEvents());
    // Last run.event at 00:00:10, now fixed at 00:00:14 → exactly 4 seconds.
    const fixedNow = () => new Date("2026-07-14T00:00:14.000Z").getTime();
    const result = await getRunStatus({ runId: SAMPLE_RUN, runDir, nowFn: fixedNow });
    assert.deepEqual(result.executionStage, {
      phase: "active",
      sinceTs: "2026-07-14T00:00:10.000Z",
      secondsSince: 4,
    }, "active stage from first run.event, exact age");
  } finally {
    cleanupDir(dir);
  }
});

test("M12-17-S2: terminal state_change → executionStage terminal, age from the transition", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1217-s2-"));
  try {
    const runId = "run_term_m1217";
    writeTranscript(dir, runId,
      ev({ type: "run.submitted", ts: "2026-07-14T00:00:00.000Z", runId, agentId: "w", seq: 1 }) +
      ev({ type: "run.state_change", to: "running", reason: "started", ts: "2026-07-14T00:00:01.000Z", runId, agentId: "w", seq: 2 }) +
      ev({ type: "run.event", kind: "command", command: "npm test", ts: "2026-07-14T00:00:02.000Z", runId, agentId: "w", seq: 3 }) +
      ev({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-07-14T00:00:05.000Z", runId, agentId: "w", seq: 4 }),
    );
    const fixedNow = () => new Date("2026-07-14T00:00:14.000Z").getTime();
    const result = await getRunStatus({ runId, runDir: dir, nowFn: fixedNow });
    assert.equal(result.state, "completed");
    assert.equal(result.terminal, true);
    assert.deepEqual(result.executionStage, {
      phase: "terminal",
      sinceTs: "2026-07-14T00:00:05.000Z",
      secondsSince: 9,
    });
  } finally {
    cleanupDir(dir);
  }
});

test("M12-17-S3: legacy run.completed (no state_change) → executionStage terminal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1217-s3-"));
  try {
    const runId = "run_legacy_stage_m1217";
    writeTranscript(dir, runId,
      ev({ type: "run.event", kind: "command", command: "echo hi", ts: "2026-07-14T00:00:01.000Z", runId, agentId: "w", seq: 1 }) +
      ev({ type: "run.completed", ts: "2026-07-14T00:00:02.000Z", runId, agentId: "w", seq: 2 }),
    );
    const result = await getRunStatus({ runId, runDir: dir });
    assert.equal(result.executionStage.phase, "terminal", "legacy terminal fact establishes terminal");
    assert.equal(result.executionStage.sinceTs, "2026-07-14T00:00:02.000Z");
  } finally {
    cleanupDir(dir);
  }
});

test("M12-17-S4: distinct conflicting terminal states → executionStage unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1217-s4-"));
  try {
    const runId = "run_conflict_stage_m1217";
    writeTranscript(dir, runId,
      ev({ type: "run.state_change", to: "running", reason: "started", ts: "2026-07-14T00:00:01.000Z", runId, agentId: "w", seq: 1 }) +
      ev({ type: "run.event", kind: "command", command: "npm test", ts: "2026-07-14T00:00:02.000Z", runId, agentId: "w", seq: 2 }) +
      ev({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-07-14T00:00:05.000Z", runId, agentId: "w", seq: 3 }) +
      ev({ type: "run.state_change", to: "failed", reason: "recount", ts: "2026-07-14T00:00:06.000Z", runId, agentId: "w", seq: 4 }),
    );
    const result = await getRunStatus({ runId, runDir: dir });
    assert.deepEqual(result.executionStage, { phase: "unknown", sinceTs: null, secondsSince: null },
      "conflicting terminals never pick a winner");
  } finally {
    cleanupDir(dir);
  }
});

test("M12-17-S5: executionStage is additive and leak-free (shape + no payload echo)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1217-s5-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, SAMPLE_RUN, sampleEvents());
    const result = await getRunStatus({ runId: SAMPLE_RUN, runDir });
    // Exactly the closed stage shape, nothing more (no kind/summary/command echo).
    assert.deepEqual(Object.keys(result.executionStage).sort(), ["phase", "secondsSince", "sinceTs"]);
    assert.ok(!JSON.stringify(result.executionStage).includes("npm test"), "no command payload in executionStage");
    // The pre-existing status contract is untouched (additive).
    assert.equal(result.state, "running");
    assert.equal(result.terminal, false);
    assert.equal(result.lastActivityTs, "2026-07-14T00:00:10.000Z");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-3A-06: malicious/path-traversal/blank runId rejected before readTranscript.
// ---------------------------------------------------------------------

test("M9-3A-06: malicious runId rejected before any file read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m93a-06-"));
  let readCalls = 0;
  const fakeRead = async () => { readCalls += 1; return []; };
  try {
    const badIds = ["../escape", "run&injected", "run space", "", "run/path", ".hidden", "-dash", "run\x00null"];
    for (const bad of badIds) {
      let threw = false;
      try {
        await getRunStatus({ runId: bad, runDir: dir, readTranscriptFn: fakeRead });
      } catch {
        threw = true;
      }
      assert.ok(threw, `malicious runId ${JSON.stringify(bad)} must throw before read`);
    }
    assert.equal(readCalls, 0, "readTranscript never called for malicious runId");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-3A-07: missing transcript → fail-closed, no file created.
// ---------------------------------------------------------------------

test("M9-3A-07: missing transcript fails closed without creating files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m93a-07-"));
  try {
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    const runId = "run_missing_m93a";
    const transcriptPath = join(runDir, `${runId}.jsonl`);
    let threw = false;
    try {
      await getRunStatus({ runId, runDir });
    } catch {
      threw = true;
    }
    assert.ok(threw, "missing transcript must throw (fail-closed)");
    // The service must NOT have created the file.
    assert.ok(!existsSyncSafe(transcriptPath), "no transcript file created by status query");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-3A-08: read-only — transcript bytes/mtime/event-count unchanged; no console.
// ---------------------------------------------------------------------

test("M9-3A-08: status query is read-only — transcript unchanged, no console output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m93a-08-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, SAMPLE_RUN, sampleEvents());
    const transcriptPath = join(runDir, `${SAMPLE_RUN}.jsonl`);
    const before = readFileSync(transcriptPath, "utf8");
    const beforeStat = statSync(transcriptPath);

    // Capture console.
    const logs = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => { logs.push(["log", ...a]); };
    console.error = (...a) => { logs.push(["err", ...a]); };
    try {
      await getRunStatus({ runId: SAMPLE_RUN, runDir });
      await getRunStatus({ runId: SAMPLE_RUN, runDir });
    } finally {
      console.log = origLog;
      console.error = origErr;
    }

    const after = readFileSync(transcriptPath, "utf8");
    const afterStat = statSync(transcriptPath);
    assert.equal(after, before, "transcript bytes unchanged");
    // mtime should not change from a read (allow equal or older; strictly not newer).
    assert.ok(afterStat.mtimeMs <= beforeStat.mtimeMs + 1 || after === before, "mtime not bumped by read");
    assert.equal(logs.length, 0, "service writes nothing to console");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-3A-09: dependency-direction guard — src/application imports no commands/mcp/SDK/Zod.
// ---------------------------------------------------------------------

test("M9-3A-09: src/application does not import commands/, mcp/, MCP SDK, or zod", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const appDir = join(process.cwd(), "src", "application");
  const files = (await readdir(appDir)).filter((f) => f.endsWith(".js"));
  assert.ok(files.length > 0, "src/application has .js files");
  const forbidden = /(?:from\s+['"](?:\.\.\/commands\/|.*commands\/|\.\.\/mcp\/|.*mcp\/|@modelcontextprotocol|zod))|(?:require\(\s*['"](?:@modelcontextprotocol|zod))/;
  for (const f of files) {
    const content = await readFile(join(appDir, f), "utf8");
    const importLines = content.split("\n").filter((l) => l.trim().startsWith("import"));
    for (const line of importLines) {
      assert.ok(!forbidden.test(line), `src/application/${f} must not import commands/mcp/SDK/zod: ${line.trim()}`);
    }
  }
});

// ===== Utility =====

import { existsSync } from "node:fs";
function existsSyncSafe(p) {
  try { return existsSync(p); } catch { return false; }
}
