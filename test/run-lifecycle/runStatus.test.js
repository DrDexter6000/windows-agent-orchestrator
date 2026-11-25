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
    describeActivity(ev, { priorEvents }),
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
      { priorEvents: [{ kind: "file_written", path: "D:/proj/src/a.txt" }, tr(2), { kind: "file_written", path: "D:/proj/docs/b.txt" }] },
    ),
    { lastActivityKind: "在写文件", lastActivitySummary: "写 b.txt ×1（最近）" },
    "不同 path 即断 → ×1",
  );
  // (b) A → A → B 收尾：B 仍 ×1（前面的 A/A 与 B 不同名，不续）。
  assert.deepEqual(
    describeActivity(
      { kind: "file_written", path: "D:/proj/docs/b.txt" },
      { priorEvents: [{ kind: "file_written", path: "D:/proj/src/a.txt" }, { kind: "file_written", path: "D:/proj/src/a.txt" }, { kind: "file_written", path: "D:/proj/docs/b.txt" }] },
    ),
    { lastActivityKind: "在写文件", lastActivitySummary: "写 b.txt ×1（最近）" },
  );
  // (c) 同 basename、不同目录：path 全文不同 → 不算同名续写。
  assert.deepEqual(
    describeActivity(
      { kind: "file_written", path: "D:/other/src/a.txt" },
      { priorEvents: [{ kind: "file_written", path: "D:/proj/src/a.txt" }, { kind: "file_written", path: "D:/other/src/a.txt" }] },
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
    // 250 条连续 file_written(A)。连续是合成极端形状（真实全量语料 6683 次写
    // 中仅 17 对相邻）——真实交错形状的有效上限由 TD-113-3b 钉住；本测试钉
    // 的是"检视 200 条事件"这个机械上界本身。
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

test("TD-113-3b: 真实交错形状的有效上限 — 3:1 交错远早于 200 次写饱和（auditor F2 补钉）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td113-3b-"));
  try {
    const runDir = join(dir, "runs");
    const runId = "run_td113_3b";
    const A = "D:/proj/big/report.md";
    // 250 组 [file_written(A), tool_result, tool_use, message]（每次写隔 3 条
    // 交错事件 = 每次写耗 4 条检视）：检视上界 200 ⇒ 有效计数上限 50，远低于
    // 连续形状的 200——真实语料同 path 间距中位 7（≈有效 28）。钉住口径差。
    let body = "";
    for (let i = 0; i < 250; i += 1) {
      body += ev({ type: "run.event", kind: "file_written", path: A, ts: `2026-08-20T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`, runId, agentId: "coder_hq", seq: i * 4 + 2 });
      body += ev({ type: "run.event", kind: "tool_result", tool: "Write", ts: `2026-08-20T00:01:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`, runId, agentId: "coder_hq", seq: i * 4 + 3 });
      body += ev({ type: "run.event", kind: "tool_use", tool: "Read", ts: `2026-08-20T00:02:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`, runId, agentId: "coder_hq", seq: i * 4 + 4 });
      body += ev({ type: "run.event", kind: "message", role: "assistant", ts: `2026-08-20T00:03:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`, runId, agentId: "coder_hq", seq: i * 4 + 5 });
    }
    writeTranscript(runDir, runId,
      ev({ type: "run.submitted", ts: "2026-08-20T00:00:00.000Z", runId, agentId: "coder_hq", seq: 1 }) + body
      // 末条必须是 file_written（计数器只在末活动为写时触发；组内顺序故为
      // fw→tr→tool_use→message，末尾补一条收束写）。
      + ev({ type: "run.event", kind: "file_written", path: A, ts: "2026-08-20T00:05:00.000Z", runId, agentId: "coder_hq", seq: 250 * 4 + 2 }),
    );
    const result = await getRunStatus({ runId, runDir, nowFn: () => new Date("2026-08-20T00:10:00.000Z").getTime() });
    assert.equal(result.lastActivitySummary, "写 report.md ×50（最近）", "3:1 交错下检视上界 200 ⇒ 有效计数 50（非连续形状的 200）");
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

// ---------------------------------------------------------------------
// TD-150 批B（T1）: scorecard 可见面 — 最近一条绑定 scorecard.checked 投影为
// { passed, failedChecks }；无 scorecard 事件的 run 字段 absent 非 null；
// failedChecks 只含检查 name，绝不透传 evidence/detail 自由文本。
// ---------------------------------------------------------------------

const SC_RUN = "run_sc_td150b";

function scEvents(extra = []) {
  return [
    ev({ type: "run.submitted", ts: "2026-08-24T00:00:00.000Z", runId: SC_RUN, agentId: "w", seq: 1 }),
    ev({ type: "run.state_change", to: "running", reason: "started", ts: "2026-08-24T00:00:01.000Z", runId: SC_RUN, agentId: "w", seq: 2 }),
    ...extra,
  ].join("");
}

test("TD150B-S1: scorecardSummary 投影最近一条 scorecard.checked（passed/failedChecks 形状）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td150b-s1-"));
  try {
    const runDir = join(dir, "runs");
    // warn 形态：completed + scorecard 未过（hasEvidence 失败，带 evidence/detail）。
    writeTranscript(runDir, SC_RUN, scEvents([
      ev({
        type: "scorecard.checked", passed: false, runId: SC_RUN, agentId: "w", seq: 3,
        ts: "2026-08-24T00:00:02.000Z",
        checks: [
          { name: "hasDoneEvent", passed: true, evidence: "run.completed present" },
          { name: "hasEvidence", passed: false, evidence: "0 evidence event(s) found", detail: "completed_empty: backend produced no model work" },
        ],
      }),
      ev({ type: "scorecard.warn", detail: "hasEvidence: completed_empty", runId: SC_RUN, agentId: "w", seq: 4, ts: "2026-08-24T00:00:02.500Z" }),
      ev({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-08-24T00:00:03.000Z", runId: SC_RUN, agentId: "w", seq: 5 }),
    ]));
    const result = await getRunStatus({ runId: SC_RUN, runDir });
    assert.deepEqual(result.scorecardSummary, { passed: false, failedChecks: ["hasEvidence"] },
      "投影 = 未过检查的 name 列表（不含 evidence/detail 自由文本）");
    assert.deepEqual(Object.keys(result.scorecardSummary).sort(), ["failedChecks", "passed"],
      "字段恰为 passed/failedChecks 两键");
  } finally {
    cleanupDir(dir);
  }
});

test("TD150B-S2: 无 scorecard.checked 的 run 字段 absent（非 null），既有输出形状不变", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td150b-s2-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, SAMPLE_RUN, sampleEvents());
    const result = await getRunStatus({ runId: SAMPLE_RUN, runDir });
    assert.equal("scorecardSummary" in result, false, "absent，不是 null 占位");
    assert.equal(result.scorecardSummary, undefined);
  } finally {
    cleanupDir(dir);
  }
});

test("TD150B-S3: 多条 scorecard.checked 时末条胜出（correction/续跑多次门控取最近）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td150b-s3-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, SC_RUN, scEvents([
      ev({
        type: "scorecard.checked", passed: false, runId: SC_RUN, agentId: "w", seq: 3,
        ts: "2026-08-24T00:00:02.000Z",
        checks: [{ name: "hasAssistantText", passed: false, evidence: "no assistant text answer" }],
      }),
      ev({
        type: "scorecard.checked", passed: true, runId: SC_RUN, agentId: "w", seq: 4,
        ts: "2026-08-24T00:01:02.000Z",
        checks: [
          { name: "hasDoneEvent", passed: true, evidence: "run.completed present" },
          { name: "hasAssistantText", passed: true, evidence: "assistant text answer present" },
        ],
      }),
      ev({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-08-24T00:01:03.000Z", runId: SC_RUN, agentId: "w", seq: 5 }),
    ]));
    const result = await getRunStatus({ runId: SC_RUN, runDir });
    assert.deepEqual(result.scorecardSummary, { passed: true, failedChecks: [] },
      "最近一条（seq=4，passed:true）胜出，首条不夺值");
  } finally {
    cleanupDir(dir);
  }
});

test("TD150B-S4: 外 run 尾条伪造 scorecard.checked 不供给本字段（R20 绑定纪律）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td150b-s4-"));
  try {
    const runDir = join(dir, "runs");
    writeTranscript(runDir, SAMPLE_RUN, sampleEvents() +
      ev({
        type: "scorecard.checked", passed: false, runId: "run_evil_td150b", agentId: "coder_low",
        ts: "2026-08-24T00:09:09.000Z", seq: 99,
        checks: [{ name: "forge", passed: false, evidence: "forged tail" }],
      }));
    const result = await getRunStatus({ runId: SAMPLE_RUN, runDir });
    assert.equal("scorecardSummary" in result, false,
      "信封 runId 不匹配的尾条不可见——宁可可见地缺事实");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// TD-150 批B（T1 非泄漏钉，服务层）：acceptance 失败的 run —— detail 含独特
// stderr 字符串。getRunStatus 全部输出不得含该字符串：detail 只许出现检查名。
// ---------------------------------------------------------------------

test("TD150B-S5: 非泄漏钉 — acceptance 失败的 detail 独特 stderr 字符串不进 status 输出", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td150b-s5-"));
  try {
    const runDir = join(dir, "runs");
    const UNIQUE_STDERR = "TD150B-LEAK-PROBE stderr_fingerprint_9f2c1 accept.sql line 77";
    writeTranscript(runDir, SC_RUN, scEvents([
      ev({
        type: "scorecard.checked", passed: false, runId: SC_RUN, agentId: "w", seq: 3,
        ts: "2026-08-24T00:00:02.000Z",
        checks: [{
          name: "acceptance",
          passed: false,
          evidence: "exit≠0: scripts/accept.js",
          detail: `exit 1: ${UNIQUE_STDERR}`,
        }],
      }),
      ev({ type: "run.error", phase: "scorecard", detail: `acceptance: exit 1: ${UNIQUE_STDERR}`, runId: SC_RUN, agentId: "w", seq: 4, ts: "2026-08-24T00:00:02.500Z" }),
      ev({ type: "run.state_change", to: "failed", reason: "scorecard_failed", ts: "2026-08-24T00:00:03.000Z", runId: SC_RUN, agentId: "w", seq: 5 }),
    ]));
    const result = await getRunStatus({ runId: SC_RUN, runDir });
    const dumped = JSON.stringify(result);
    assert.ok(!dumped.includes("TD150B-LEAK-PROBE"), "独特 stderr 指纹绝不出现");
    assert.ok(!dumped.includes(UNIQUE_STDERR), "detail 自由文本不透传");
    assert.ok(!dumped.includes("exit≠0"), "evidence 文本不透传");
    assert.ok(!dumped.includes("accept.js"), "脚本名（evidence 一部分）不透传");
    assert.deepEqual(result.scorecardSummary, { passed: false, failedChecks: ["acceptance"] },
      "只有检查名可见");
  } finally {
    cleanupDir(dir);
  }
});

// ===== Utility =====

import { existsSync } from "node:fs";
function existsSyncSafe(p) {
  try { return existsSync(p); } catch { return false; }
}

// ===== 决定 0067：很久没有新动作/正文的未终态 run 附 Lead advisory =====

const ADV_RUN = "run_adv_0067";
function advisoryTranscript({ terminal = false } = {}) {
  const base = { runId: ADV_RUN, agentId: "glm-pro" };
  const lines = [
    { type: "run.submitted", ts: "2026-10-12T10:00:00.000Z", seq: 1, ...base },
    { type: "run.state_change", to: "running", reason: "first_event", ts: "2026-10-12T10:00:02.000Z", seq: 2, ...base },
    { type: "run.event", kind: "command", command: "npm test", ts: "2026-10-12T10:05:00.000Z", seq: 3, ...base },
    { type: "run.event", kind: "runtime_activity", status: "streaming", ts: "2026-10-12T10:35:40.000Z", seq: 4, ...base },
  ];
  if (terminal) lines.push({ type: "run.state_change", from: "running", to: "failed", reason: "backend_error", ts: "2026-10-12T10:35:50.000Z", seq: 5, ...base });
  return lines.map(ev).join("");
}

test("0067-S1: 未终态且 ≥30 分钟没有新动作/正文 → 附 advisory（事实 + 去留由 Lead 定 + stop 命令）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-status-adv-"));
  try {
    writeTranscript(dir, ADV_RUN, advisoryTranscript());
    const status = await getRunStatus({ runId: ADV_RUN, runDir: dir, nowFn: () => Date.parse("2026-10-12T10:36:00.000Z") });
    assert.equal(status.secondsSinceEffect, 31 * 60);
    assert.equal(status.secondsSinceActivity, 20, "运行时还在动——最近活动 20s 前");
    assert.equal(
      status.leadAdvisory,
      // 决定 0069：10 分钟内有生命体征 → 多一句"建议不要随意中止"；出口带上看到的位置与理由两项。
      `转录里已 31 分钟没有新的动作或正文（最近活动：provider 正在输出，20s 前）。最近 10 分钟内有生命体征，建议不要随意中止。是否继续等待由 Lead 决定；要中止，先看最新状态，再带理由执行：wao stop ${ADV_RUN} --observed-seq 4 --reason "<理由>"`,
    );
    // 决定 0068：同一条 advisory 的 MCP 面文本（固定英文模板 + 整数 + 闭集标签）。
    assert.equal(
      status.leadAdvisoryWire,
      "No new worker action or text in the transcript for 31 min (last activity: runtime_activity/streaming, 20s ago). "
        + "A vital sign was seen within the last 10 min: WAO advises against stopping now without a specific reason. "
        + "Whether to keep waiting is the Lead's decision. Before stopping: read run_activity, then run_stop with observedSeq and a reason.",
    );
  } finally { cleanupDir(dir); }
});

test("0067-S2: 不满 30 分钟 / 已到终态 → 字段缺席（既有形状不变）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-status-adv-"));
  try {
    writeTranscript(dir, ADV_RUN, advisoryTranscript());
    const early = await getRunStatus({ runId: ADV_RUN, runDir: dir, nowFn: () => Date.parse("2026-10-12T10:34:59.000Z") });
    assert.equal("leadAdvisory" in early, false);
    assert.equal("leadAdvisoryWire" in early, false);
    assert.equal("secondsSinceEffect" in early, false);
    writeTranscript(dir, ADV_RUN, advisoryTranscript({ terminal: true }));
    const done = await getRunStatus({ runId: ADV_RUN, runDir: dir, nowFn: () => Date.parse("2026-10-12T12:00:00.000Z") });
    assert.equal(done.terminal, true);
    assert.equal("leadAdvisory" in done, false);
  } finally { cleanupDir(dir); }
});

test("0067-S3: 从未有过动作 → 从 run.submitted 起算", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-status-adv-"));
  try {
    const base = { runId: ADV_RUN, agentId: "glm-pro" };
    writeTranscript(dir, ADV_RUN, [
      { type: "run.submitted", ts: "2026-10-12T10:00:00.000Z", seq: 1, ...base },
      { type: "run.state_change", to: "running", reason: "first_event", ts: "2026-10-12T10:00:02.000Z", seq: 2, ...base },
      { type: "run.event", kind: "thinking", ts: "2026-10-12T10:00:03.000Z", seq: 3, ...base },
    ].map(ev).join(""));
    const status = await getRunStatus({ runId: ADV_RUN, runDir: dir, nowFn: () => Date.parse("2026-10-12T10:45:00.000Z") });
    assert.match(status.leadAdvisory, /^转录里已 45 分钟没有新的动作或正文（最近活动：在思考，2697s 前）/);
  } finally { cleanupDir(dir); }
});

test("0067-S4: 恰满 30 分钟出现、差 1 秒不出现", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-status-adv-"));
  try {
    writeTranscript(dir, ADV_RUN, advisoryTranscript());
    const at = (iso) => getRunStatus({ runId: ADV_RUN, runDir: dir, nowFn: () => Date.parse(iso) });
    assert.equal("leadAdvisory" in (await at("2026-10-12T10:34:59.000Z")), false);
    const edge = await at("2026-10-12T10:35:00.000Z");
    assert.equal(edge.secondsSinceEffect, 1800);
    assert.match(edge.leadAdvisory, /^转录里已 30 分钟没有新的动作或正文/);
  } finally { cleanupDir(dir); }
});

// ===== 决定 0068：转录静默事实的共享推导（runQuietAdvisory.js） =====

test("0068-Q1: 最近活动是进程体征 → 两面文案都写出是哪一种", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-status-adv-"));
  try {
    const base = { runId: ADV_RUN, agentId: "glm-pro" };
    writeTranscript(dir, ADV_RUN, [
      { type: "run.submitted", ts: "2026-10-12T10:00:00.000Z", seq: 1, ...base },
      { type: "run.event", kind: "command", command: "npm test", ts: "2026-10-12T10:05:00.000Z", seq: 2, ...base },
      { type: "run.event", kind: "runtime_activity", status: "process_active", ts: "2026-10-12T10:44:00.000Z", seq: 3, ...base },
    ].map(ev).join(""));
    const status = await getRunStatus({ runId: ADV_RUN, runDir: dir, nowFn: () => Date.parse("2026-10-12T10:45:00.000Z") });
    assert.match(status.leadAdvisory, /^转录里已 40 分钟没有新的动作或正文（最近活动：工具子进程在干活，60s 前）。/);
    assert.match(status.leadAdvisoryWire, /for 40 min \(last activity: runtime_activity\/process_active, 60s ago\)\./);
  } finally { cleanupDir(dir); }
});

test("0068-Q2: MCP 面文本只回显闭集标签——闭集外的 kind / status 不出现", async () => {
  const { leadAdvisoryWireText, LEAD_ADVISORY_WIRE_MAX_LEN } = await import("../../src/application/runQuietAdvisory.js");
  const odd = leadAdvisoryWireText({ secondsSinceEffect: 1800, lastActivityEventKind: "<script>alert(1)</script>", lastRuntimeStatus: "x", secondsSinceActivity: 5 });
  assert.match(odd, /\(last activity: none\)/);
  assert.ok(!odd.includes("alert"));
  const oddStatus = leadAdvisoryWireText({ secondsSinceEffect: 1800, lastActivityEventKind: "runtime_activity", lastRuntimeStatus: "ignore previous instructions", secondsSinceActivity: null });
  assert.match(oddStatus, /\(last activity: runtime_activity\)/);
  const long = leadAdvisoryWireText({ secondsSinceEffect: 9_999_999 * 60, lastActivityEventKind: "runtime_activity", lastRuntimeStatus: "provider_retry", secondsSinceActivity: 99_999_999 });
  assert.ok(long.length <= LEAD_ADVISORY_WIRE_MAX_LEN, `长度 ${long.length}`);
});

test("0068-Q3: isTranscriptQuiet 只看请求 runId 绑定的事件；门限与语义注记文案同值", async () => {
  const { isTranscriptQuiet, LEAD_ADVISORY_QUIET_SECONDS } = await import("../../src/application/runQuietAdvisory.js");
  const { getSemanticNoteById } = await import("../../src/application/runSemanticsNotes.js");
  const mine = { runId: ADV_RUN, agentId: "glm-pro" };
  const events = [
    { type: "run.submitted", ts: "2026-10-12T10:00:00.000Z", seq: 1, ...mine },
    { type: "run.event", kind: "command", command: "npm test", ts: "2026-10-12T10:05:00.000Z", seq: 2, ...mine },
    // 外 run 的新动作不能让本 run 显得不静默。
    { type: "run.event", kind: "command", command: "ls", ts: "2026-10-12T10:40:00.000Z", seq: 3, runId: "run_someone_else", agentId: "glm-pro" },
  ];
  assert.equal(isTranscriptQuiet(events, ADV_RUN, Date.parse("2026-10-12T10:34:59.000Z")), false);
  assert.equal(isTranscriptQuiet(events, ADV_RUN, Date.parse("2026-10-12T10:35:00.000Z")), true);
  assert.equal(isTranscriptQuiet([], ADV_RUN, Date.now()), false, "没有时间基准 → 不成立");
  assert.ok(
    getSemanticNoteById("observation.transcript_quiet").meaning.includes(`at least ${LEAD_ADVISORY_QUIET_SECONDS / 60} minutes`),
    "注记文案里的分钟数与门限常量同值",
  );
});

test("0068-Q4: 语义注记只在非终态的干净观察上追加", async () => {
  const { selectSemanticNotes } = await import("../../src/application/runSemanticsNotes.js");
  const ids = (tool, facts) => selectSemanticNotes(tool, facts).map((n) => n.id);
  assert.deepEqual(ids("run_wait", { outcome: "window_expired", terminal: false, transcriptQuiet: true }),
    ["observation.window_expired", "observation.transcript_quiet"]);
  assert.deepEqual(ids("run_wait", { outcome: "window_expired", terminal: false, transcriptQuiet: false }),
    ["observation.window_expired"]);
  assert.deepEqual(ids("run_wait", { outcome: "window_expired", terminal: false }), ["observation.window_expired"]);
  assert.deepEqual(ids("run_await_result", { outcome: "point_in_time", terminal: false, transcriptQuiet: true }),
    ["observation.point_in_time", "observation.transcript_quiet"]);
  assert.ok(!ids("run_await_result", { outcome: "terminal", terminal: true, terminationSource: "completion", transcriptQuiet: true })
    .includes("observation.transcript_quiet"));
  assert.deepEqual(ids("run_wait", { outcome: "read_failure", transcriptQuiet: true }), ["observation.read_failure"]);
});

test("0068-Q5: 卡在 pending、连 run.submitted 都没有的运行 → 从第一条事件起算", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-status-adv-"));
  try {
    const base = { runId: ADV_RUN, agentId: "glm-pro" };
    writeTranscript(dir, ADV_RUN, [
      { type: "run.state_change", to: "pending", reason: "background_spawned", ts: "2026-10-12T10:00:00.000Z", seq: 1, ...base },
      { type: "run.started", ts: "2026-10-12T10:00:01.000Z", seq: 2, ...base },
    ].map(ev).join(""));
    const early = await getRunStatus({ runId: ADV_RUN, runDir: dir, nowFn: () => Date.parse("2026-10-12T10:29:59.000Z") });
    assert.equal("leadAdvisory" in early, false);
    const late = await getRunStatus({ runId: ADV_RUN, runDir: dir, nowFn: () => Date.parse("2026-10-12T11:00:00.000Z") });
    assert.match(late.leadAdvisory, /^转录里已 60 分钟没有新的动作或正文（最近活动：无）。/);
    assert.match(late.leadAdvisoryWire, /for 60 min \(last activity: none\)\./);
  } finally { cleanupDir(dir); }
});

// ===== 决定 0069：10 分钟内有生命体征的建议 + 看到的转录位置 =====

test("0069-A1: 最近一次生命体征已过 10 分钟 → advisory 不带\"建议不要随意中止\"那一句；observedSeq 始终在场", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-status-adv-"));
  try {
    const base = { runId: ADV_RUN, agentId: "glm-pro" };
    writeTranscript(dir, ADV_RUN, [
      { type: "run.submitted", ts: "2026-10-12T10:00:00.000Z", seq: 1, ...base },
      { type: "run.event", kind: "command", command: "npm test", ts: "2026-10-12T10:05:00.000Z", seq: 2, ...base },
      { type: "run.event", kind: "runtime_activity", status: "process_active", ts: "2026-10-12T10:30:00.000Z", seq: 3, ...base },
    ].map(ev).join(""));
    // 10:39:59 —— 体征 9 分 59 秒前：带建议。
    const recent = await getRunStatus({ runId: ADV_RUN, runDir: dir, nowFn: () => Date.parse("2026-10-12T10:39:59.000Z") });
    assert.equal(recent.observedSeq, 3);
    assert.ok(recent.leadAdvisory.includes("最近 10 分钟内有生命体征，建议不要随意中止。"));
    assert.ok(recent.leadAdvisoryWire.includes("A vital sign was seen within the last 10 min"));
    assert.ok(recent.leadAdvisory.includes(`wao stop ${ADV_RUN} --observed-seq 3 --reason`));
    // 10:40:00 —— 恰满 10 分钟：不带。
    const old = await getRunStatus({ runId: ADV_RUN, runDir: dir, nowFn: () => Date.parse("2026-10-12T10:40:00.000Z") });
    assert.ok(!old.leadAdvisory.includes("建议不要随意中止"));
    assert.ok(!old.leadAdvisoryWire.includes("vital sign was seen"));
    assert.ok(old.leadAdvisoryWire.endsWith("Before stopping: read run_activity, then run_stop with observedSeq and a reason."));
    // 没到 advisory 门限的运行也给 observedSeq（stop 要用）。
    const early = await getRunStatus({ runId: ADV_RUN, runDir: dir, nowFn: () => Date.parse("2026-10-12T10:06:00.000Z") });
    assert.equal(early.observedSeq, 3);
    assert.equal("leadAdvisory" in early, false);
  } finally { cleanupDir(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// TD-341（第 89 批 C1）：runner 已不在 → run_status 说出它。证明一律注入桩
//（daemon 读器 + 全套 settle 读器），不跑真实进程扫描。
// ═══════════════════════════════════════════════════════════════════════════

import { createRunnerGoneProofCache } from "../../src/application/runnerGoneProof.js";

const RG_RUN = "run_td341_c1";

/** 非终态、有后台派发、静默已满结算窗的夹具（lastBoundTs 决定静默分钟数）。 */
function rgEvents({ lastTs = "2026-10-12T10:00:00.000Z", quietTs = null } = {}) {
  const base = { runId: RG_RUN, agentId: "coder_low" };
  const quiet = quietTs ?? lastTs;
  return [
    ev({ type: "run.background_submitted", ts: quiet, seq: 1, ...base }),
    ev({ type: "run.state_change", to: "pending", reason: "background_spawned", ts: quiet, seq: 2, ...base }),
    ev({ type: "run.state_change", to: "running", reason: "started", ts: quiet, seq: 3, ...base }),
    ev({ type: "run.event", kind: "command", command: "npm test", ts: lastTs, seq: 4, ...base }),
  ].join("");
}

/** 全过的证明 deps（daemon 读器 + settle 读器全桩；心跳读器桩不新鲜）。 */
function rgProofDeps({ eligible = true, refusal = "owner_fresh" } = {}) {
  return {
    handshakeReader: () => ({ present: false }),
    daemonAliveFn: () => false,
    heartbeatReader: () => ({ fresh: false }),
    ownerLeaseReader: () => ({ present: false }),
    identifyFn: async () => ({ verdict: "gone", basis: "pid_exited" }),
    runnerScanFn: async () => (eligible ? { alive: false } : { alive: true }),
    _refusalForTest: refusal,
  };
}

test("TD-341-C1: 证明成立且重读仍非终态 → 新模板（第 15–30 分钟也给）+ runnerGone 机器字段", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rgc1-a-"));
  try {
    // lastBound = 10:00，now = 10:20 —— 静默 20 分钟：≥15 分钟证明窗、<30 分钟
    // 普通 advisory 门槛。不改成 quiet||runnerGone 就不会返回。
    writeTranscript(dir, RG_RUN, rgEvents({ lastTs: "2026-10-12T10:00:00.000Z" }));
    const status = await getRunStatus({
      runId: RG_RUN,
      runDir: dir,
      nowFn: () => Date.parse("2026-10-12T10:20:00.000Z"),
      runnerGoneDeps: rgProofDeps(),
    });
    assert.equal(status.runnerGone, true, "runnerGone 机器字段在场");
    assert.equal(status.leadAdvisory,
      "观察时没有 WAO 进程能继续驱动这个运行（owner 心跳已不在、本机无 runner 进程、转录静默已满 20 分钟），继续等待不会自行收口。"
      + `是否结算由 Lead 决定：先干跑 wao runs settle --run-id ${RG_RUN} --reason-file <文件>，确认后再加 --apply。`,
      "CLI 面中文固定模板（整数分钟 + runId）");
    assert.equal(status.leadAdvisoryWire,
      "At observation time no WAO process can still drive this run (owner heartbeat gone, no runner process on this machine, transcript quiet for 20 min). "
      + "Continued waiting will not settle it on its own. Whether to settle is the Lead's decision: "
      + "first dry-run wao runs settle --run-id <id> --reason-file <file>, then add --apply.",
      "MCP 面英文固定模板（整数分钟 + <id> 占位）");
    assert.ok(status.leadAdvisoryWire.length <= 480, "wire 模板 ≤480 字符（LEAD_ADVISORY_WIRE_MAX_LEN）");
  } finally {
    cleanupDir(dir);
  }
});

// B92 续修 1：静默分钟数与证明门 4 同一取法（lastQuietWindowBoundMs）——最后一条
// 绑定事件是被拒的重打包审计（不算活动）时，分钟数从更早的计入事件算起。
test("B92 续修 1: 最后一条是被拒的重打包审计 → 静默分钟数从更早的计入事件算", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rgc1-quiet-"));
  try {
    // 计入静默窗的最后一条是 09:20 的 run.event；10:19 追加被拒重打包审计。
    // now = 10:20 —— 证明成立（门 4 按计入事件放行），静默分钟数 = 60，不是 1。
    writeTranscript(dir, RG_RUN, rgEvents({ lastTs: "2026-10-12T09:20:00.000Z" })
      + ev({
        type: "run.delivery_repackage_rejected", ts: "2026-10-12T10:19:00.000Z", seq: 5,
        runId: RG_RUN, agentId: "coder_low", rejectionReason: "lease_held",
      }));
    const status = await getRunStatus({
      runId: RG_RUN,
      runDir: dir,
      nowFn: () => Date.parse("2026-10-12T10:20:00.000Z"),
      runnerGoneDeps: rgProofDeps(),
    });
    assert.equal(status.runnerGone, true, "被拒审计不重置证明窗——证明照常成立");
    assert.match(status.leadAdvisory, /转录静默已满 60 分钟/, "分钟数从计入事件（09:20）算起");
    assert.ok(!status.leadAdvisory.includes("已满 1 分钟"), "不是从被拒审计（10:19）算的 1 分钟");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-341-C1: 证明后重读已终态 → 退回普通投影（无 advisory、无 runnerGone）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rgc1-b-"));
  try {
    writeTranscript(dir, RG_RUN, rgEvents());
    let reads = 0;
    const readTranscriptFn = async () => {
      reads += 1;
      // 首读（含证明内部干跑前的快照）非终态；证明成立后的重读已终态。
      if (reads === 1) {
        return [{ type: "run.background_submitted", ts: "2026-10-12T10:00:00.000Z", seq: 1, runId: RG_RUN, agentId: "coder_low" },
          { type: "run.state_change", to: "running", reason: "started", ts: "2026-10-12T10:00:01.000Z", seq: 2, runId: RG_RUN, agentId: "coder_low" }];
      }
      return [{ type: "run.background_submitted", ts: "2026-10-12T10:00:00.000Z", seq: 1, runId: RG_RUN, agentId: "coder_low" },
        { type: "run.state_change", to: "running", reason: "started", ts: "2026-10-12T10:00:01.000Z", seq: 2, runId: RG_RUN, agentId: "coder_low" },
        { type: "run.state_change", from: "running", to: "failed", reason: "backend_error", ts: "2026-10-12T10:01:00.000Z", seq: 3, runId: RG_RUN, agentId: "coder_low" }];
    };
    const status = await getRunStatus({
      runId: RG_RUN,
      runDir: dir,
      readTranscriptFn,
      nowFn: () => Date.parse("2026-10-12T10:20:00.000Z"),
      runnerGoneDeps: rgProofDeps(),
    });
    assert.equal("runnerGone" in status, false, "重读已终态 → 不算数");
    assert.equal("leadAdvisory" in status, false, "首读快照未满 30 分钟 → 无 advisory");
    // 退回普通投影 = 首读快照的形状（非终态照实）；重读的终态只用于否决证明。
    assert.equal(status.state, "running");
    assert.equal(status.terminal, false);
  } finally {
    cleanupDir(dir);
  }
});

test("TD-341-C1: 证明不成立（扫描见活 runner）→ 旧安静模板逐字不变", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rgc1-c-"));
  try {
    // 静默 31 分钟（≥30 分钟门槛）：证明拒于 runner_alive，advisory 落回安静模板。
    writeTranscript(dir, RG_RUN, rgEvents({ lastTs: "2026-10-12T09:45:00.000Z" }));
    const now = Date.parse("2026-10-12T10:20:00.000Z");
    const status = await getRunStatus({
      runId: RG_RUN,
      runDir: dir,
      nowFn: () => now,
      runnerGoneDeps: rgProofDeps({ eligible: false }),
    });
    assert.equal("runnerGone" in status, false, "证明不成立 → 无机器字段");
    assert.ok(status.leadAdvisory.startsWith("转录里已 35 分钟没有新的动作或正文"), "旧安静模板照旧");
    assert.equal(status.leadAdvisoryWire,
      "No new worker action or text in the transcript for 35 min (last activity: command, 2100s ago). "
      + "Whether to keep waiting is the Lead's decision. Before stopping: read run_activity, then run_stop with observedSeq and a reason.",
      "wire 面旧模板逐字不变（无生命体征近窗提示段）");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-341-C1: 节流命中不重复调证明；心跳新鲜根本不进证明", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rgc1-d-"));
  try {
    writeTranscript(dir, RG_RUN, rgEvents());
    const cache = createRunnerGoneProofCache();
    let scans = 0;
    const deps = rgProofDeps();
    deps.runnerScanFn = async () => { scans += 1; return { alive: false }; };
    const now = () => Date.parse("2026-10-12T10:20:00.000Z");
    const first = await getRunStatus({ runId: RG_RUN, runDir: dir, nowFn: now, runnerGoneDeps: deps, runnerGoneCache: cache });
    assert.equal(first.runnerGone, true);
    assert.equal(scans, 1, "第一次调用真实证明一次");
    const second = await getRunStatus({ runId: RG_RUN, runDir: dir, nowFn: now, runnerGoneDeps: deps, runnerGoneCache: cache });
    assert.equal(second.runnerGone, true);
    assert.equal(scans, 1, "缓存命中（同 seq、TTL 内）不再证明");
    // 心跳新鲜（监督进程还在）→ 前置筛直接不调证明（缓存也不咨询）。
    const freshDeps = rgProofDeps();
    freshDeps.heartbeatReader = () => ({ fresh: true });
    freshDeps.runnerScanFn = async () => { scans += 1; return { alive: false }; };
    const third = await getRunStatus({ runId: RG_RUN, runDir: dir, nowFn: now, runnerGoneDeps: freshDeps, runnerGoneCache: cache });
    assert.equal("runnerGone" in third, false, "心跳新鲜 → 不声称 runner 已不在（缓存里旧的 gone 不复活）");
    assert.equal(scans, 1, "心跳新鲜连证明都不发起");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-341-C1: 不注入证明 deps → 证明不跑（advisory 在场条件不受影响）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rgc1-e-"));
  try {
    writeTranscript(dir, RG_RUN, rgEvents({ lastTs: "2026-10-12T09:45:00.000Z" }));
    const status = await getRunStatus({
      runId: RG_RUN,
      runDir: dir,
      nowFn: () => Date.parse("2026-10-12T10:20:00.000Z"),
    });
    assert.equal("runnerGone" in status, false);
    assert.ok(status.leadAdvisory.startsWith("转录里已 35 分钟"), "无 deps → 旧路径（安静模板）");
  } finally {
    cleanupDir(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 第 119 批续修 1（会审必改）：runner 缺席证明的重读快照同样过归属核验。
// 首读归属 A 并通过；证明成立后的重读换成同一 runId、归属 B 的转录——服务
// 必须抛 code="workspace_not_authorized"，绝不用 B 的快照投影 state/runnerGone。
// ═══════════════════════════════════════════════════════════════════════════

test("119 续修 1: 首读归属 A、重读归属 B → workspace_not_authorized（不输出 B 的事实）", async () => {
  const { execFileSync } = await import("node:child_process");
  const repoA = mkdtempSync(join(tmpdir(), "wao-a4repoA-"));
  const repoB = mkdtempSync(join(tmpdir(), "wao-a4repoB-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-a4rd-"));
  try {
    for (const d of [repoA, repoB]) {
      execFileSync("git", ["init", "-q"], { cwd: d, stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: d, stdio: "pipe" });
      execFileSync("git", ["config", "user.name", "T"], { cwd: d, stdio: "pipe" });
      writeFileSync(join(d, "R.md"), "x\n");
      execFileSync("git", ["add", "-A"], { cwd: d, stdio: "pipe" });
      execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: d, stdio: "pipe" });
    }
    // A 所属转录落盘：settle 六门可过（后台派发、非终态、静默满窗），归属事实
    //（run.background_submitted.cwd 与 run.started.cwd，各恰一条）都指向 A。
    //（不用 rgEvents——它的 background_submitted 不带 cwd，补一条会变重复。）
    writeTranscript(runDir, RG_RUN, [
      ev({ type: "run.background_submitted", background: true, cwd: repoA, ts: "2026-10-12T10:00:00.000Z", seq: 1, runId: RG_RUN, agentId: "coder_low" }),
      ev({ type: "run.state_change", to: "pending", reason: "background_spawned", ts: "2026-10-12T10:00:00.000Z", seq: 2, runId: RG_RUN, agentId: "coder_low" }),
      ev({ type: "run.state_change", to: "running", reason: "started", ts: "2026-10-12T10:00:00.000Z", seq: 3, runId: RG_RUN, agentId: "coder_low" }),
      ev({ type: "run.started", backend: "claude-code", cwd: repoA, ts: "2026-10-12T10:00:00.000Z", seq: 4, runId: RG_RUN, agentId: "coder_low" }),
      ev({ type: "run.event", kind: "command", command: "npm test", ts: "2026-10-12T10:00:00.000Z", seq: 5, runId: RG_RUN, agentId: "coder_low" }),
    ].join(""));
    const { readTranscript } = await import("../../src/transcript.js");
    const aEventsOnDisk = await readTranscript(join(runDir, `${RG_RUN}.jsonl`));
    // 重读快照：同一 runId、同一形状，但两条 cwd 归属事实都指向项目 B。
    const bEvents = aEventsOnDisk.map((e) => (
      e.type === "run.started" || e.type === "run.background_submitted" ? { ...e, cwd: repoB } : e
    ));
    let reads = 0;
    const readTranscriptFn = async () => {
      reads += 1;
      return reads === 1 ? aEventsOnDisk : bEvents;
    };
    await assert.rejects(
      getRunStatus({
        runId: RG_RUN,
        runDir,
        readTranscriptFn,
        nowFn: () => Date.parse("2026-10-12T10:20:00.000Z"),
        runnerGoneDeps: rgProofDeps(),
        authorizedWorkspaceRoot: repoA,
      }),
      (e) => e.code === "workspace_not_authorized",
      "重读快照归属 B → 与首读同款的 workspace_not_authorized",
    );
    assert.equal(reads, 2, "首读 + 证明后的重读都被消费（重读确实发生）");
  } finally {
    cleanupDir(repoA); cleanupDir(repoB); cleanupDir(runDir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 第 107 批：重启关系陈述——非终态、普通静默 advisory 已在场（≥30 分钟）、
// runner 未被证明不在、且 rebootedSinceLastActivity 成立时，中文 advisory 末尾
// 加一句、wire 换用固定英文变体模板。开机时刻经 runnerGoneDeps.bootTimeFn 注入。
// ═══════════════════════════════════════════════════════════════════════════

test("第 107 批: 重启晚于最后活动且 runner 未被证明不在 → 中文加句、wire 换变体模板", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-reboot-adv-"));
  try {
    // lastBound = 09:45，now = 10:20 —— 静默 35 分钟；证明拒于 runner_alive
    //（未证明不在）；开机 10:15（晚于最后活动 09:45，早于 now）。
    writeTranscript(dir, RG_RUN, rgEvents({ lastTs: "2026-10-12T09:45:00.000Z" }));
    const status = await getRunStatus({
      runId: RG_RUN,
      runDir: dir,
      nowFn: () => Date.parse("2026-10-12T10:20:00.000Z"),
      runnerGoneDeps: {
        ...rgProofDeps({ eligible: false }),
        bootTimeFn: () => Date.parse("2026-10-12T10:15:00.000Z"),
      },
    });
    assert.equal("runnerGone" in status, false, "证明不成立 → 无机器字段");
    assert.equal(
      status.leadAdvisory,
      "转录里已 35 分钟没有新的动作或正文（最近活动：跑命令，2100s 前）。"
        + "本机 5 分钟前开机，晚于该运行最后活动（35 分钟前）；重启前的 runner 活不过重启，是否有开机后续跑的进程未经证明。"
        + "是否继续等待由 Lead 决定；要中止，先看最新状态，再带理由执行："
        + `wao stop ${RG_RUN} --observed-seq 4 --reason "<理由>"`,
      "重启关系句放在\"是否继续等待\"之前，停止命令仍在末尾",
    );
    assert.equal(
      status.leadAdvisoryWire,
      "No new worker action or text in the transcript for 35 min (last activity: command, 2100s ago). "
        + "This machine booted 5 min ago, after the run's last activity 35 min ago; a pre-reboot runner cannot have survived it, but a runner started after the boot is not ruled out. "
        + "Whether to keep waiting is the Lead's decision. Before stopping: read run_activity, then run_stop with observedSeq and a reason.",
      "wire 换用重启变体模板（不叠加普通模板的完整正文）",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("第 107 批: 重启成立时替下\"最近 10 分钟内有生命体征\"的建议（两面同一取舍）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-reboot-vital-"));
  try {
    // 最后动作 09:45（静默 35 分钟）；生命体征 10:13（7 分钟前，旧模板会建议别停）；
    // 开机 10:15（晚于体征）——重启前的体征不再说明 runner 还活着。
    const base = { runId: RG_RUN, agentId: "coder_low" };
    writeTranscript(dir, RG_RUN, rgEvents({ lastTs: "2026-10-12T09:45:00.000Z" })
      + ev({ type: "run.event", kind: "runtime_activity", status: "streaming", ts: "2026-10-12T10:13:00.000Z", seq: 5, ...base }));
    const status = await getRunStatus({
      runId: RG_RUN,
      runDir: dir,
      nowFn: () => Date.parse("2026-10-12T10:20:00.000Z"),
      runnerGoneDeps: {
        ...rgProofDeps({ eligible: false }),
        bootTimeFn: () => Date.parse("2026-10-12T10:15:00.000Z"),
      },
    });
    assert.ok(status.leadAdvisory.includes("本机 5 分钟前开机"), status.leadAdvisory);
    assert.ok(!status.leadAdvisory.includes("建议不要随意中止"), "重启后不再建议别停");
    assert.ok(status.leadAdvisoryWire.includes("This machine booted 5 min ago"), status.leadAdvisoryWire);
    assert.ok(!status.leadAdvisoryWire.includes("advises against stopping"), "wire 面同样不建议别停");
  } finally {
    cleanupDir(dir);
  }
});

test("第 107 批: 重启不成立（开机早于最后活动）→ 两面 advisory 与旧模板逐字节相同", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-reboot-adv-neg-"));
  try {
    writeTranscript(dir, RG_RUN, rgEvents({ lastTs: "2026-10-12T09:45:00.000Z" }));
    const status = await getRunStatus({
      runId: RG_RUN,
      runDir: dir,
      nowFn: () => Date.parse("2026-10-12T10:20:00.000Z"),
      runnerGoneDeps: {
        ...rgProofDeps({ eligible: false }),
        bootTimeFn: () => Date.parse("2026-10-12T09:00:00.000Z"),
      },
    });
    assert.equal(
      status.leadAdvisory,
      "转录里已 35 分钟没有新的动作或正文（最近活动：跑命令，2100s 前）。是否继续等待由 Lead 决定；要中止，先看最新状态，再带理由执行："
        + `wao stop ${RG_RUN} --observed-seq 4 --reason "<理由>"`,
      "中文不带重启句（逐字节与旧模板一致）",
    );
    assert.equal(
      status.leadAdvisoryWire,
      "No new worker action or text in the transcript for 35 min (last activity: command, 2100s ago). "
        + "Whether to keep waiting is the Lead's decision. Before stopping: read run_activity, then run_stop with observedSeq and a reason.",
      "wire 用普通模板（逐字节一致）",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("第 107 批: runner 已被证明不在时不叠加——沿用 runnerGone 模板，重启句不出现", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-reboot-adv-gone-"));
  try {
    // 证明成立（eligible）且开机晚于最后活动：advisory 仍是 runnerGone 双语模板。
    writeTranscript(dir, RG_RUN, rgEvents({ lastTs: "2026-10-12T09:45:00.000Z" }));
    const status = await getRunStatus({
      runId: RG_RUN,
      runDir: dir,
      nowFn: () => Date.parse("2026-10-12T10:20:00.000Z"),
      runnerGoneDeps: {
        ...rgProofDeps(),
        bootTimeFn: () => Date.parse("2026-10-12T10:15:00.000Z"),
      },
    });
    assert.equal(status.runnerGone, true);
    assert.equal(status.leadAdvisory,
      "观察时没有 WAO 进程能继续驱动这个运行（owner 心跳已不在、本机无 runner 进程、转录静默已满 35 分钟），继续等待不会自行收口。"
      + `是否结算由 Lead 决定：先干跑 wao runs settle --run-id ${RG_RUN} --reason-file <文件>，确认后再加 --apply。`);
    assert.ok(!status.leadAdvisory.includes("重启"), "runnerGone 模板不叠加重启句");
    assert.ok(!status.leadAdvisoryWire.includes("reboot"), "wire 面 runnerGone 模板同样不叠加");
  } finally {
    cleanupDir(dir);
  }
});

test("第 107 批: 租约心跳晚于事件时最后活动取心跳；wire 变体极端整数仍 ≤480", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-reboot-adv-hb-"));
  try {
    // 事件 09:45；租约心跳 10:19:55（新鲜——第 149 批起心跳过期会改走"心跳已停"
    // 模板，重启句只在租约缺失/损坏/心跳新鲜时出现）；开机 10:19:58 → 晚于两者才
    // 成立；10:19:50 开机晚于事件但早于心跳 → 不成立。
    writeTranscript(dir, RG_RUN, rgEvents({ lastTs: "2026-10-12T09:45:00.000Z" }));
    const lease = { present: true, wellFormed: true, fresh: true, heartbeatAt: Date.parse("2026-10-12T10:19:55.000Z"), pid: 4242 };
    const base = { ...rgProofDeps({ eligible: false }), ownerLeaseReader: () => lease };
    const holds = await getRunStatus({
      runId: RG_RUN, runDir: dir,
      nowFn: () => Date.parse("2026-10-12T10:20:00.000Z"),
      runnerGoneDeps: { ...base, bootTimeFn: () => Date.parse("2026-10-12T10:19:58.000Z") },
    });
    assert.ok(holds.leadAdvisory.includes("本机 0 分钟前开机，晚于该运行最后活动（0 分钟前）"),
      `分钟数从心跳（10:19:55）起算，不是从事件（09:45）: ${holds.leadAdvisory}`);
    const notHolds = await getRunStatus({
      runId: RG_RUN, runDir: dir,
      nowFn: () => Date.parse("2026-10-12T10:20:00.000Z"),
      runnerGoneDeps: { ...base, bootTimeFn: () => Date.parse("2026-10-12T10:19:50.000Z") },
    });
    assert.ok(!notHolds.leadAdvisory.includes("重启"), "开机晚于事件但早于心跳 → 不成立，不加句");
  } finally {
    cleanupDir(dir);
  }
  // 变体模板长度上限：极端整数（分/秒取最大位数）也在 LEAD_ADVISORY_WIRE_MAX_LEN 内。
  const { leadAdvisoryRebootWireText, LEAD_ADVISORY_WIRE_MAX_LEN } = await import("../../src/application/runQuietAdvisory.js");
  const long = leadAdvisoryRebootWireText({
    secondsSinceEffect: 9_999_999 * 60,
    lastActivityEventKind: "runtime_activity",
    lastRuntimeStatus: "provider_retry",
    secondsSinceActivity: 99_999_999,
    bootMinutesAgo: 99_999_999,
    activityMinutesAgo: 99_999_999,
  });
  assert.ok(long.length <= LEAD_ADVISORY_WIRE_MAX_LEN, `长度 ${long.length}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 第 149 批：owner 心跳已停（租约在、格式正确、心跳不新鲜）+ 普通静默 advisory 在场
// + runner 未被证明不在 → advisory 改指 settle 干跑，不再建议 stop。其余情形输出
// 逐字节不变。租约经 runnerGoneDeps.ownerLeaseReader 注入；时钟 10:20，转录最后
// 动作 09:45（静默 35 分钟）。
// ═══════════════════════════════════════════════════════════════════════════

const B149_NOW = Date.parse("2026-10-12T10:20:00.000Z");
const B149_CLI_HEAD = "转录里已 35 分钟没有新的动作或正文（最近活动：跑命令，2100s 前）。";
const B149_WIRE_HEAD = "No new worker action or text in the transcript for 35 min (last activity: command, 2100s ago). ";
const B149_QUIET_CLI = `${B149_CLI_HEAD}是否继续等待由 Lead 决定；要中止，先看最新状态，再带理由执行：wao stop ${RG_RUN} --observed-seq 4 --reason "<理由>"`;
const B149_QUIET_WIRE = `${B149_WIRE_HEAD}Whether to keep waiting is the Lead's decision. Before stopping: read run_activity, then run_stop with observedSeq and a reason.`;
// 第 149 批修正一：心跳时间戳在未来 / 年龄算不出安全整数分钟时，两面用固定的时间异常句
// 取代"停在 N 分钟前"；其后的干跑出口与"是否继续等待"逐字不变。
const B149_CLI_ANOMALY = "owner 心跳的时间戳在未来或不可信，已按不新鲜处理。";
const B149_CLI_TAIL = `下一步先干跑 wao runs settle --run-id ${RG_RUN} --reason-file <文件>，看各道门；runner 是否还在，以干跑结果为准。是否继续等待由 Lead 决定。`;
const B149_WIRE_ANOMALY = "The owner heartbeat timestamp is in the future or not trustworthy and was treated as not fresh. ";
const B149_WIRE_TAIL = "Next, dry-run wao runs settle --run-id <id> --reason-file <file> and read its gates; whether a runner still exists is decided by the dry-run result. Whether to keep waiting is the Lead's decision.";
const b149Lease = (heartbeatAgoMs, extra = {}) => ({
  present: true, wellFormed: true, fresh: heartbeatAgoMs <= 10_000, heartbeatAt: B149_NOW - heartbeatAgoMs, pid: 4242, ...extra,
});
async function b149Status(dir, runnerGoneDeps) {
  return getRunStatus({ runId: RG_RUN, runDir: dir, nowFn: () => B149_NOW, runnerGoneDeps });
}

test("第 149 批: 心跳过期 + 静默 → 两面换新模板（指向 settle 干跑，不含 stop），长度 ≤480", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b149-stale-"));
  try {
    writeTranscript(dir, RG_RUN, rgEvents({ lastTs: "2026-10-12T09:45:00.000Z" }));
    const status = await b149Status(dir, { ...rgProofDeps({ eligible: false }), ownerLeaseReader: () => b149Lease(12 * 60_000) });
    assert.equal("runnerGone" in status, false, "证明不成立：仍不声称 runner 已不在");
    assert.equal(
      status.leadAdvisory,
      `${B149_CLI_HEAD}owner 心跳停在 12 分钟前。`
        + `下一步先干跑 wao runs settle --run-id ${RG_RUN} --reason-file <文件>，看各道门；runner 是否还在，以干跑结果为准。`
        + "是否继续等待由 Lead 决定。",
    );
    assert.equal(
      status.leadAdvisoryWire,
      `${B149_WIRE_HEAD}The owner heartbeat stopped 12 min ago. `
        + "Next, dry-run wao runs settle --run-id <id> --reason-file <file> and read its gates; whether a runner still exists is decided by the dry-run result. "
        + "Whether to keep waiting is the Lead's decision.",
    );
    for (const text of [status.leadAdvisory, status.leadAdvisoryWire]) {
      assert.ok(!/wao stop|run_stop/.test(text), `不再建议 stop：${text}`);
    }
    assert.ok(status.leadAdvisoryWire.length <= 480, `wire ${status.leadAdvisoryWire.length} ≤ 480`);
    assert.ok(!status.leadAdvisoryWire.includes(RG_RUN), "wire 面用 <id> 占位，不带 runId");
    // 极端整数（分/秒取大位数）也守 wire 上限。
    const { ownerHeartbeatStoppedWireText, LEAD_ADVISORY_WIRE_MAX_LEN } = await import("../../src/application/runQuietAdvisory.js");
    const long = ownerHeartbeatStoppedWireText({
      secondsSinceEffect: 9_999_999 * 60,
      lastActivityEventKind: "runtime_activity",
      lastRuntimeStatus: "provider_retry",
      secondsSinceActivity: 99_999_999,
      heartbeatMinutes: 99_999_999,
    });
    assert.ok(long.length <= LEAD_ADVISORY_WIRE_MAX_LEN, `极端整数 ${long.length}`);
  } finally { cleanupDir(dir); }
});

test("第 149 批: 心跳过期时同样不带生命体征建议，也不叠加重启句", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b149-stale-extra-"));
  try {
    // 近 5 分钟有生命体征（旧模板会建议别停）+ 开机晚于最后活动（旧路径会叠加重启句）。
    const base = { runId: RG_RUN, agentId: "coder_low" };
    writeTranscript(dir, RG_RUN, rgEvents({ lastTs: "2026-10-12T09:45:00.000Z" })
      + ev({ type: "run.event", kind: "runtime_activity", status: "streaming", ts: "2026-10-12T10:15:00.000Z", seq: 5, ...base }));
    const status = await b149Status(dir, {
      ...rgProofDeps({ eligible: false }),
      ownerLeaseReader: () => b149Lease(12 * 60_000),
      bootTimeFn: () => Date.parse("2026-10-12T10:18:00.000Z"),
    });
    assert.ok(status.leadAdvisory.includes("owner 心跳停在 12 分钟前"), status.leadAdvisory);
    assert.ok(status.leadAdvisory.includes("最近活动：provider 正在输出，300s 前"), "最近活动照现有提示写出");
    assert.ok(!status.leadAdvisory.includes("建议不要随意中止"), "不带生命体征建议");
    assert.ok(!status.leadAdvisory.includes("开机"), "不叠加重启句");
    assert.ok(status.leadAdvisoryWire.includes("(last activity: runtime_activity/streaming, 300s ago)"), status.leadAdvisoryWire);
    assert.ok(!status.leadAdvisoryWire.includes("advises against stopping"), "wire 面不带生命体征建议");
    assert.ok(!status.leadAdvisoryWire.includes("booted"), "wire 面不叠加重启句");
  } finally { cleanupDir(dir); }
});

test("第 149 批: 心跳新鲜 → 两面与旧模板逐字节相同；门限同口径（isFreshHeartbeat，10 秒）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b149-fresh-"));
  try {
    writeTranscript(dir, RG_RUN, rgEvents({ lastTs: "2026-10-12T09:45:00.000Z" }));
    const withLease = (heartbeatAgoMs) => b149Status(dir, {
      ...rgProofDeps({ eligible: false }), ownerLeaseReader: () => b149Lease(heartbeatAgoMs),
    });
    for (const agoMs of [0, 1000, 10_000]) {
      const status = await withLease(agoMs);
      assert.equal(status.leadAdvisory, B149_QUIET_CLI, `心跳 ${agoMs}ms 前 → 旧模板`);
      assert.equal(status.leadAdvisoryWire, B149_QUIET_WIRE, `心跳 ${agoMs}ms 前 → wire 旧模板`);
    }
    const justStale = await withLease(10_001);
    assert.ok(justStale.leadAdvisory.includes("owner 心跳停在 0 分钟前"), "恰过门限一毫秒 → 新模板");
    // 远未来的心跳同样不新鲜（TD-316 同一条规则）——但"停在 N 分钟前"在未来时间戳下不是
    // 事实：两面改用固定的时间异常句，不写分钟数；干跑出口不变。
    const future = await withLease(-3_600_000);
    assert.equal(future.leadAdvisory, B149_CLI_HEAD + B149_CLI_ANOMALY + B149_CLI_TAIL);
    assert.equal(future.leadAdvisoryWire, B149_WIRE_HEAD + B149_WIRE_ANOMALY + B149_WIRE_TAIL);
    for (const text of [future.leadAdvisory, future.leadAdvisoryWire]) {
      assert.ok(!/0 分钟前|stopped 0 min/.test(text), `未来心跳不报"0 分钟前"：${text}`);
      assert.ok(!/wao stop|run_stop/.test(text), "仍不建议 stop");
    }
  } finally { cleanupDir(dir); }
});

test("第 149 批修正一: 极端有限心跳时间戳 → 不输出科学计数法；算不出安全整数分钟就写时间异常句", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b149-extreme-"));
  try {
    writeTranscript(dir, RG_RUN, rgEvents({ lastTs: "2026-10-12T09:45:00.000Z" }));
    const statusAt = (heartbeatAt) => b149Status(dir, {
      ...rgProofDeps({ eligible: false }),
      ownerLeaseReader: () => ({ present: true, wellFormed: true, fresh: false, heartbeatAt, pid: 4242 }),
    });
    // 过去方向与未来方向的极端有限值：分钟数超出安全整数（或为负）→ 一律异常句。
    for (const heartbeatAt of [-1e300, 1e300, -Number.MAX_VALUE, Number.MAX_VALUE, -1e21, 1e21]) {
      const status = await statusAt(heartbeatAt);
      for (const text of [status.leadAdvisory, status.leadAdvisoryWire]) {
        assert.ok(!text.includes("e+") && !text.includes("e-") && !/\d[eE][+-]?\d/.test(text), `${heartbeatAt}: 不含科学计数法：${text}`);
      }
      assert.equal(status.leadAdvisory, B149_CLI_HEAD + B149_CLI_ANOMALY + B149_CLI_TAIL, `${heartbeatAt}: CLI 异常句`);
      assert.equal(status.leadAdvisoryWire, B149_WIRE_HEAD + B149_WIRE_ANOMALY + B149_WIRE_TAIL, `${heartbeatAt}: wire 异常句`);
    }
    // 很大但仍是安全整数分钟的过去时间戳：照写十进制整数，不出异常句。
    const bigPast = await statusAt(-9e15);
    assert.match(bigPast.leadAdvisory, /owner 心跳停在 \d+ 分钟前。/);
    assert.match(bigPast.leadAdvisoryWire, /The owner heartbeat stopped \d+ min ago\./);
    assert.ok(!/\d[eE][+-]?\d/.test(bigPast.leadAdvisory + bigPast.leadAdvisoryWire), "十进制整数");
  } finally { cleanupDir(dir); }
});

test("第 149 批修正一: 新模板的整数一律十进制文本——心跳分钟数不可信 → 异常句；静默分钟与活动秒数钳在安全上限", async () => {
  const { ownerHeartbeatStoppedAdvisoryText, ownerHeartbeatStoppedWireText, LEAD_ADVISORY_WIRE_MAX_LEN } =
    await import("../../src/application/runQuietAdvisory.js");
  const base = {
    runId: RG_RUN,
    secondsSinceEffect: 2100,
    lastActivityLabel: "跑命令",
    lastActivityEventKind: "command",
    lastRuntimeStatus: null,
    secondsSinceActivity: 2100,
  };
  // 心跳分钟数：负数 / 非有限 / 超安全整数 / 缺席 → 异常句；0 与正常整数照写。
  for (const bad of [-1, NaN, Infinity, 1e300, Number.MAX_SAFE_INTEGER + 1, 2.5e21, null, undefined]) {
    assert.ok(ownerHeartbeatStoppedAdvisoryText({ ...base, heartbeatMinutes: bad }).includes(B149_CLI_ANOMALY), `CLI ${String(bad)}`);
    assert.ok(ownerHeartbeatStoppedWireText({ ...base, heartbeatMinutes: bad }).includes(B149_WIRE_ANOMALY), `wire ${String(bad)}`);
  }
  assert.ok(ownerHeartbeatStoppedAdvisoryText({ ...base, heartbeatMinutes: 0 }).includes("owner 心跳停在 0 分钟前。"));
  assert.ok(ownerHeartbeatStoppedWireText({ ...base, heartbeatMinutes: 0 }).includes("The owner heartbeat stopped 0 min ago."));
  const huge = ownerHeartbeatStoppedWireText({ ...base, heartbeatMinutes: Number.MAX_SAFE_INTEGER });
  assert.ok(huge.includes(`stopped ${Number.MAX_SAFE_INTEGER} min ago`), "安全整数上界照写十进制");
  // 静默分钟数与最近活动秒数：不可信的大值也只出十进制整数。
  for (const extreme of [1e300, Infinity, Number.MAX_VALUE, 2.5e21]) {
    const cli = ownerHeartbeatStoppedAdvisoryText({ ...base, secondsSinceEffect: extreme, secondsSinceActivity: extreme, heartbeatMinutes: 5 });
    const wire = ownerHeartbeatStoppedWireText({
      ...base, secondsSinceEffect: extreme, secondsSinceActivity: extreme,
      lastActivityEventKind: "runtime_activity", lastRuntimeStatus: "provider_retry", heartbeatMinutes: 5,
    });
    for (const text of [cli, wire]) {
      assert.ok(!text.includes("e+") && !text.includes("e-") && !/\d[eE][+-]?\d/.test(text), `${extreme}: 不含科学计数法：${text}`);
      assert.ok(!text.includes("Infinity") && !text.includes("NaN"), `${extreme}: 不含 Infinity/NaN`);
    }
    assert.ok(wire.length <= LEAD_ADVISORY_WIRE_MAX_LEN, `${extreme}: wire ${wire.length} ≤ 480`);
  }
  // 最长异常句 + 最长闭集活动回显 + 最大整数仍守 wire 上限。
  const longest = ownerHeartbeatStoppedWireText({
    ...base,
    secondsSinceEffect: Number.MAX_SAFE_INTEGER,
    secondsSinceActivity: Number.MAX_SAFE_INTEGER,
    lastActivityEventKind: "runtime_activity",
    lastRuntimeStatus: "provider_retry",
    heartbeatMinutes: 1e300,
  });
  assert.ok(longest.length <= LEAD_ADVISORY_WIRE_MAX_LEN, `最长 ${longest.length} ≤ 480`);
});

// 第 149 批修正二：运行时状态的标签表查找必须是严格成员判断——对象下标会读到原型链
//（"constructor" → 函数源码文本、"__proto__" → "[object Object]"）并把数组键转成字符串
//（["streaming"] → "streaming" 的标签）。新分支用 RUNTIME_ACTIVITY_STATUSES / RUN_EVENT_KINDS
// 的成员判断，没命中一律固定文案。
test("第 149 批修正二: 新 CLI 提示的 status / kind 走严格闭集——原型链键、数组、对象都落固定文案", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b149-strict-"));
  try {
    const base = { runId: RG_RUN, agentId: "coder_low" };
    const staleDeps = { ...rgProofDeps({ eligible: false }), ownerLeaseReader: () => b149Lease(12 * 60_000) };
    const freshDeps = { ...rgProofDeps({ eligible: false }), ownerLeaseReader: () => b149Lease(1000) };
    const lastAdvisory = async (event, deps) => {
      writeTranscript(dir, RG_RUN, rgEvents({ lastTs: "2026-10-12T09:45:00.000Z" })
        + ev({ type: "run.event", ...event, ts: "2026-10-12T09:45:00.000Z", seq: 5, ...base }));
      return b149Status(dir, deps);
    };
    // 运行时状态：闭集成员照给固定文案；其余（含原型链键、数组、对象、空值）一律"provider 状态未知"。
    for (const [status, expected] of [
      ["initialized", "provider 已初始化"],
      ["streaming", "provider 正在输出"],
      ["provider_retry", "provider 正在重试"],
      ["process_active", "工具子进程在干活"],
      ["files_changed", "工作目录有文件变化"],
      ["serve_active", "serve 报告本轮仍在跑"],
      ["constructor", "provider 状态未知"],
      ["__proto__", "provider 状态未知"],
      ["toString", "provider 状态未知"],
      ["hasOwnProperty", "provider 状态未知"],
      ["valueOf", "provider 状态未知"],
      [["streaming"], "provider 状态未知"],
      [{ streaming: true }, "provider 状态未知"],
      [null, "provider 状态未知"],
      [42, "provider 状态未知"],
      ["", "provider 状态未知"],
    ]) {
      const status_ = await lastAdvisory({ kind: "runtime_activity", status }, staleDeps);
      assert.ok(status_.leadAdvisory.includes(`最近活动：${expected}，2100s 前）。owner 心跳停在 12 分钟前。`),
        `status=${JSON.stringify(status)}: ${status_.leadAdvisory}`);
      assert.ok(!/function|native code|\[object|undefined/.test(status_.leadAdvisory), `status=${JSON.stringify(status)}: 不回显内建值`);
    }
    // kind 同样走成员判断：原型链键、数组、对象 → "未知"。
    for (const kind of ["constructor", "__proto__", "toString", "hasOwnProperty", ["tool_use"], ["runtime_activity"], {}, 7]) {
      const out = await lastAdvisory({ kind }, staleDeps);
      assert.ok(out.leadAdvisory.includes("最近活动：未知，2100s 前）。"), `kind=${JSON.stringify(kind)}: ${out.leadAdvisory}`);
      assert.ok(!/function|native code|\[object|undefined/.test(out.leadAdvisory), `kind=${JSON.stringify(kind)}: 不回显内建值`);
    }
    // 旧回退模板（心跳新鲜）对合法状态逐字节不变。
    const old = await lastAdvisory({ kind: "runtime_activity", status: "streaming" }, freshDeps);
    assert.equal(old.leadAdvisory,
      "转录里已 35 分钟没有新的动作或正文（最近活动：provider 正在输出，2100s 前）。是否继续等待由 Lead 决定；要中止，先看最新状态，再带理由执行："
      + `wao stop ${RG_RUN} --observed-seq 5 --reason "<理由>"`);
  } finally { cleanupDir(dir); }
});

test("第 149 批修正一: 新 CLI 提示的最近活动只用闭集类别——tool_use 的工具名与未知 kind 不进提示；旧模板字节不变", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b149-closed-"));
  try {
    const MARK_TOOL = "MARK_TOOL_a1b2c3_do_not_echo";
    const MARK_KIND = "MARK_KIND_d4e5f6_do_not_echo";
    const base = { runId: RG_RUN, agentId: "coder_low" };
    const staleDeps = { ...rgProofDeps({ eligible: false }), ownerLeaseReader: () => b149Lease(12 * 60_000) };
    const freshDeps = { ...rgProofDeps({ eligible: false }), ownerLeaseReader: () => b149Lease(1000) };
    // ① 最后事件是 tool_use，工具名带标记。
    writeTranscript(dir, RG_RUN, rgEvents({ lastTs: "2026-10-12T09:45:00.000Z" })
      + ev({ type: "run.event", kind: "tool_use", tool: MARK_TOOL, input: { command: "x" }, ts: "2026-10-12T09:45:00.000Z", seq: 5, ...base }));
    const stale = await b149Status(dir, staleDeps);
    assert.ok(!stale.leadAdvisory.includes(MARK_TOOL), `新提示不回显工具名：${stale.leadAdvisory}`);
    assert.ok(stale.leadAdvisory.startsWith("转录里已 35 分钟没有新的动作或正文（最近活动：用工具，2100s 前）。owner 心跳停在 12 分钟前。"), stale.leadAdvisory);
    assert.ok(!stale.leadAdvisoryWire.includes(MARK_TOOL), "wire 面本来就是闭集");
    // 旧回退模板（心跳新鲜）逐字节兼容：仍带"用工具 <名>"。
    const fresh = await b149Status(dir, freshDeps);
    assert.ok(fresh.leadAdvisory.startsWith(`转录里已 35 分钟没有新的动作或正文（最近活动：用工具 ${MARK_TOOL}，2100s 前）。是否继续等待由 Lead 决定；要中止`), fresh.leadAdvisory);
    // ② 最后事件的 kind 不在闭集内（转录里的自由文本）。
    writeTranscript(dir, RG_RUN, rgEvents({ lastTs: "2026-10-12T09:45:00.000Z" })
      + ev({ type: "run.event", kind: MARK_KIND, ts: "2026-10-12T09:45:00.000Z", seq: 5, ...base }));
    const unknownKind = await b149Status(dir, staleDeps);
    assert.ok(!unknownKind.leadAdvisory.includes(MARK_KIND), `未知 kind 不回显：${unknownKind.leadAdvisory}`);
    assert.ok(unknownKind.leadAdvisory.includes("最近活动：未知，"), unknownKind.leadAdvisory);
    assert.ok(!unknownKind.leadAdvisoryWire.includes(MARK_KIND));
    // ③ 闭集内的其余 kind 与运行时状态照旧给出固定类别。
    for (const [kind, extra, expected] of [
      ["message", { role: "assistant" }, "在说话"],
      ["thinking", {}, "在思考"],
      ["command", { command: "x" }, "跑命令"],
      ["tool_result", { tool: MARK_TOOL }, "收工具结果"],
      ["file_written", { path: "a/b.js" }, "在写文件"],
      ["runtime_activity", { status: "streaming" }, "provider 正在输出"],
    ]) {
      writeTranscript(dir, RG_RUN, rgEvents({ lastTs: "2026-10-12T09:45:00.000Z" })
        + ev({ type: "run.event", kind, ...extra, ts: "2026-10-12T09:45:00.000Z", seq: 5, ...base }));
      const status = await b149Status(dir, staleDeps);
      assert.ok(status.leadAdvisory.includes(`最近活动：${expected}，`), `${kind}: ${status.leadAdvisory}`);
      assert.ok(!status.leadAdvisory.includes(MARK_TOOL), `${kind}: 不回显自由文本`);
    }
  } finally { cleanupDir(dir); }
});

test("第 149 批: 租约缺失 / 损坏 / 读取失败 → 两面与旧模板逐字节相同", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b149-nolease-"));
  try {
    writeTranscript(dir, RG_RUN, rgEvents({ lastTs: "2026-10-12T09:45:00.000Z" }));
    for (const [label, lease] of [
      ["缺失", { present: false }],
      ["损坏", { present: true, wellFormed: false }],
    ]) {
      const status = await b149Status(dir, { ...rgProofDeps({ eligible: false }), ownerLeaseReader: () => lease });
      assert.equal(status.leadAdvisory, B149_QUIET_CLI, `租约${label} → 旧模板`);
      assert.equal(status.leadAdvisoryWire, B149_QUIET_WIRE, `租约${label} → wire 旧模板`);
    }
    // 状态读取处的租约读取抛错（证明内部的读取放行）→ 不陈述，输出不变。
    let reads = 0;
    const thrown = await b149Status(dir, {
      ...rgProofDeps({ eligible: false }),
      ownerLeaseReader: () => { reads += 1; if (reads > 1) throw new Error("boom"); return { present: false }; },
    });
    assert.equal(thrown.leadAdvisory, B149_QUIET_CLI, "读取失败 → 旧模板");
    assert.equal(thrown.leadAdvisoryWire, B149_QUIET_WIRE);
  } finally { cleanupDir(dir); }
});

test("第 149 批: runner 已被证明不在 → 仍走 runnerGone 模板（心跳过期不改变优先级）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b149-gone-"));
  try {
    writeTranscript(dir, RG_RUN, rgEvents({ lastTs: "2026-10-12T09:45:00.000Z" }));
    const status = await b149Status(dir, { ...rgProofDeps(), ownerLeaseReader: () => b149Lease(12 * 60_000) });
    assert.equal(status.runnerGone, true);
    assert.equal(status.leadAdvisory,
      "观察时没有 WAO 进程能继续驱动这个运行（owner 心跳已不在、本机无 runner 进程、转录静默已满 35 分钟），继续等待不会自行收口。"
      + `是否结算由 Lead 决定：先干跑 wao runs settle --run-id ${RG_RUN} --reason-file <文件>，确认后再加 --apply。`);
    assert.ok(status.leadAdvisoryWire.startsWith("At observation time no WAO process can still drive this run"));
    assert.ok(!status.leadAdvisory.includes("owner 心跳停在"), "不叠加新模板");
  } finally { cleanupDir(dir); }
});

test("第 149 批: 真读 owner 租约文件——过期 → 新模板；新鲜 / 损坏 → 旧模板；无 deps 同样生效", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b149-file-"));
  try {
    writeTranscript(dir, RG_RUN, rgEvents({ lastTs: "2026-10-12T09:45:00.000Z" }));
    const ownerFile = join(dir, `.owner-${RG_RUN}`);
    // 过期租约（真实 readOwnerLease 缺省读器；deps 缺席 = 证明不跑）。
    writeFileSync(ownerFile, JSON.stringify({ heartbeatAt: B149_NOW - 12 * 60_000, pid: 4242 }), "utf8");
    const stale = await b149Status(dir, undefined);
    assert.ok(stale.leadAdvisory.includes("owner 心跳停在 12 分钟前"), stale.leadAdvisory);
    assert.ok(stale.leadAdvisoryWire.includes("The owner heartbeat stopped 12 min ago."), stale.leadAdvisoryWire);
    // 新鲜租约。开机时刻钉在 epoch 0（重启句永不成立，旧模板字节稳定）。
    writeFileSync(ownerFile, JSON.stringify({ heartbeatAt: B149_NOW - 1000, pid: 4242 }), "utf8");
    const fresh = await b149Status(dir, { bootTimeFn: () => 0 });
    assert.equal(fresh.leadAdvisory, B149_QUIET_CLI);
    assert.equal(fresh.leadAdvisoryWire, B149_QUIET_WIRE);
    // 损坏租约（pid 缺失 = 格式不对）。
    writeFileSync(ownerFile, JSON.stringify({ heartbeatAt: B149_NOW - 12 * 60_000 }), "utf8");
    const corrupt = await b149Status(dir, { bootTimeFn: () => 0 });
    assert.equal(corrupt.leadAdvisory, B149_QUIET_CLI);
    assert.equal(corrupt.leadAdvisoryWire, B149_QUIET_WIRE);
  } finally { cleanupDir(dir); }
});
