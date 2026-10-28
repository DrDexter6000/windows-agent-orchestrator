// test/application/runSettle.test.js
//
// `wao runs settle` 的数据逻辑（任务第 3 步）：
//   - 六道门的通过与拒绝各一条（闭集理由）；
//   - owner 租约心跳走真实 readOwnerLease 读文件（TD-316）：有限远未来
//     heartbeatAt 不算新鲜、租约门照走；1e400（解析成 Infinity）判畸形 →
//     owner_lease_corrupt；
//   - dry-run 零写入（转录字节不变）；
//   - --apply 写入的事件形状（failed/process_missing + 确认事实载荷）；
//   - expectedLastSeq 不符 → observed_seq_changed、不写终态；
//   - 先写终态者胜（证明与写入之间他方落了终态 → terminal）；
//   - 非终态运行带确认事实（腐蚀）→ 抛错不写；
//   - 理由空 → 抛错。
//
// 进程探测/时钟/daemon/扫描全部注入；零真实进程、零真实 PowerShell。
// expectedLastSeq"不传选项行为不变"由 test/transcript/transitionExpectedLastSeq.test.js
// 在 transcript 层钉住。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { readTranscript } from "../../src/transcript.js";
import { checkOwnerLiveness, readOwnerLease } from "../../src/application/ownerLiveness.js";
import {
  settleRun,
  listSettleCandidates,
  SETTLE_REJECTION_REASONS,
  SETTLE_QUIET_WINDOW_MS,
  parseRunnerScanOutput,
  defaultRunnerScan,
} from "../../src/application/runSettle.js";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const OLD = "2026-09-01T00:00:00.000Z"; // 远早于 15 分钟静默窗

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeLines(tp, lines) {
  writeFileSync(tp, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
}

const ev = (runId, seq, type, ts, extra = {}) => ({
  runId, agentId: "coder_x", type, seq, ts, ...extra,
});

/** 建会话前死掉的后台运行（任务背景第一类）。 */
function seedNoSession(tp, runId) {
  writeLines(tp, [
    ev(runId, 1, "run.started", OLD, { backend: "claude-code" }),
    ev(runId, 2, "run.background_submitted", OLD, { background: true }),
    ev(runId, 3, "run.state_change", OLD, { from: null, to: "pending", reason: "background_spawned" }),
  ]);
}

/** 中途死掉的 proc 会话运行（任务背景第二类）。 */
function seedProcSession(tp, runId, pid = 4321) {
  writeLines(tp, [
    ev(runId, 1, "run.started", OLD, { backend: "claude-code" }),
    ev(runId, 2, "run.background_submitted", OLD, { background: true }),
    ev(runId, 3, "session.created", OLD, { backend: "process", backendSessionId: `proc_${pid}` }),
    ev(runId, 4, "run.state_change", OLD, { from: null, to: "pending", reason: "background_spawned" }),
    ev(runId, 5, "run.state_change", OLD, { from: "pending", to: "running", reason: "first_event" }),
  ]);
}

/** 全部通过的注入集；各测试按需覆写单门。 */
function settleDeps(overrides = {}) {
  return {
    nowFn: () => NOW,
    ownerLeaseReader: () => ({ present: false }),
    identifyFn: async () => ({ verdict: "gone", basis: "pid_exited" }),
    runnerScanFn: async () => ({ alive: false }),
    handshakeReader: () => null,
    daemonAliveFn: () => false,
    ...overrides,
  };
}

const REASON = "机器 2026-09-30 重启过，runner 与会话进程都不在了，转录无终态记录。";

// ── 拒绝理由闭集 ──────────────────────────────────────────────────────────────

test("SET-00: 拒绝理由闭集与静默窗常量", () => {
  assert.deepEqual(SETTLE_REJECTION_REASONS, [
    "terminal", "unknown_state", "owner_fresh", "owner_lease_corrupt", "owner_alive",
    "runner_alive", "runner_scan_failed", "quiet_window", "foreground_no_session",
    "session_ambiguous", "session_has_stop_route", "process_alive", "process_identity_unknown",
    "daemon_owned", "observed_seq_changed",
  ]);
  assert.equal(SETTLE_QUIET_WINDOW_MS, 15 * 60 * 1000, "静默窗 15 分钟具名常量");
});

// ── 门 1：状态 ────────────────────────────────────────────────────────────────

test("SET-01: 门 1 拒绝——终态运行 → terminal", async () => {
  const dir = tempDir("wao-set-01-");
  try {
    const runId = "run_set01";
    seedProcSession(dir ? join(dir, `${runId}.jsonl`) : "", runId);
    writeLines(join(dir, `${runId}.jsonl`), [
      ev(runId, 1, "run.started", OLD, { backend: "claude-code" }),
      ev(runId, 2, "session.created", OLD, { backend: "process", backendSessionId: "proc_4321" }),
      ev(runId, 3, "run.state_change", OLD, { from: null, to: "running", reason: "first_event" }),
      ev(runId, 4, "run.completed", OLD, {}),
      ev(runId, 5, "run.state_change", OLD, { from: "running", to: "completed", reason: "done" }),
    ]);
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps() });
    assert.equal(r.refused, "terminal");
    assert.ok(Array.isArray(r.gates) && r.gates.length >= 1, "拒绝附已评估门的事实");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-02: 门 1 拒绝——状态不在闭集 → unknown_state", async () => {
  const dir = tempDir("wao-set-02-");
  try {
    const runId = "run_set02";
    writeLines(join(dir, `${runId}.jsonl`), [
      ev(runId, 1, "run.started", OLD, { backend: "claude-code" }),
      ev(runId, 2, "run.state_change", OLD, { from: null, to: "limbo", reason: "future" }),
    ]);
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps() });
    assert.equal(r.refused, "unknown_state");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 门 2：owner 租约 ──────────────────────────────────────────────────────────

test("SET-03: 门 2 通过——租约缺失 + proc 会话判 gone → eligible", async () => {
  const dir = tempDir("wao-set-03-");
  try {
    const runId = "run_set03";
    seedProcSession(join(dir, `${runId}.jsonl`), runId);
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps() });
    assert.equal(r.eligible, true);
    assert.equal(r.sessionShape, "process_session");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-04: 门 2 拒绝——租约新鲜 → owner_fresh", async () => {
  const dir = tempDir("wao-set-04-");
  try {
    const runId = "run_set04";
    seedProcSession(join(dir, `${runId}.jsonl`), runId);
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps({
      ownerLeaseReader: () => ({ present: true, wellFormed: true, fresh: true, heartbeatAt: NOW - 1000, pid: 100 }),
    }) });
    assert.equal(r.refused, "owner_fresh");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-05: 门 2 拒绝——租约损坏 → owner_lease_corrupt", async () => {
  const dir = tempDir("wao-set-05-");
  try {
    const runId = "run_set05";
    seedProcSession(join(dir, `${runId}.jsonl`), runId);
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps({
      ownerLeaseReader: () => ({ present: true, wellFormed: false }),
    }) });
    assert.equal(r.refused, "owner_lease_corrupt");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-06: 门 2 拒绝——过期租约 owner pid 判 same → owner_alive（锚=heartbeatAt）", async () => {
  const dir = tempDir("wao-set-06-");
  try {
    const runId = "run_set06";
    seedProcSession(join(dir, `${runId}.jsonl`), runId);
    let seenPid = null;
    let seenAnchor = null;
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps({
      ownerLeaseReader: () => ({ present: true, wellFormed: true, fresh: false, heartbeatAt: NOW - 3600_000, pid: 777 }),
      identifyFn: async (pid, anchorAt) => {
        seenPid = pid; seenAnchor = anchorAt;
        return { verdict: "same", basis: "identity_confirmed" };
      },
    }) });
    assert.equal(r.refused, "owner_alive");
    assert.equal(seenPid, 777, "owner 身份门探的是租约里的 pid");
    assert.equal(seenAnchor, NOW - 3600_000, "owner 身份门的锚取租约 heartbeatAt");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-07: 门 2 拒绝——过期租约 owner pid 判 unknown → process_identity_unknown", async () => {
  const dir = tempDir("wao-set-07-");
  try {
    const runId = "run_set07";
    seedProcSession(join(dir, `${runId}.jsonl`), runId);
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps({
      ownerLeaseReader: () => ({ present: true, wellFormed: true, fresh: false, heartbeatAt: NOW - 3600_000, pid: 777 }),
      identifyFn: async () => ({ verdict: "unknown", basis: "identity_unknown" }),
    }) });
    assert.equal(r.refused, "process_identity_unknown");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-08: 门 2 通过——过期租约 owner pid 判 gone（锚=heartbeatAt）继续走后续门", async () => {
  const dir = tempDir("wao-set-08-");
  try {
    const runId = "run_set08";
    seedProcSession(join(dir, `${runId}.jsonl`), runId);
    let ownerAnchor = null;
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps({
      ownerLeaseReader: () => ({ present: true, wellFormed: true, fresh: false, heartbeatAt: NOW - 7200_000, pid: 777 }),
      identifyFn: async (pid, anchorAt) => {
        if (pid === 777) { ownerAnchor = anchorAt; return { verdict: "gone", basis: "pid_exited" }; }
        return { verdict: "gone", basis: "rebooted_since_anchor" };
      },
    }) });
    assert.equal(r.eligible, true);
    assert.equal(ownerAnchor, NOW - 7200_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 门 3：无活 runner ─────────────────────────────────────────────────────────

test("SET-09: 门 3 拒绝——扫描发现 runner → runner_alive", async () => {
  const dir = tempDir("wao-set-09-");
  try {
    const runId = "run_set09";
    seedProcSession(join(dir, `${runId}.jsonl`), runId);
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps({
      runnerScanFn: async () => ({ alive: true }),
    }) });
    assert.equal(r.refused, "runner_alive");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-10: 门 3 拒绝——扫描失败 → runner_scan_failed（单凭租约缺失不能证明 runner 已死）", async () => {
  const dir = tempDir("wao-set-10-");
  try {
    const runId = "run_set10";
    seedProcSession(join(dir, `${runId}.jsonl`), runId);
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps({
      runnerScanFn: async () => ({ failed: true }),
    }) });
    assert.equal(r.refused, "runner_scan_failed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 门 4：静默窗 ──────────────────────────────────────────────────────────────

test("SET-11: 门 4 拒绝——最后一条绑定事件太新 → quiet_window（即使 runner 已死也只筛不代）", async () => {
  const dir = tempDir("wao-set-11-");
  try {
    const runId = "run_set11";
    const recent = new Date(NOW - 60_000).toISOString();
    writeLines(join(dir, `${runId}.jsonl`), [
      ev(runId, 1, "run.started", OLD, { backend: "claude-code" }),
      ev(runId, 2, "run.background_submitted", OLD, { background: true }),
      ev(runId, 3, "session.created", OLD, { backend: "process", backendSessionId: "proc_4321" }),
      ev(runId, 4, "run.state_change", OLD, { from: null, to: "running", reason: "first_event" }),
      ev(runId, 5, "run.event", recent, { kind: "message", data: "x" }),
    ]);
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps() });
    assert.equal(r.refused, "quiet_window");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 门 5：会话 ────────────────────────────────────────────────────────────────

test("SET-12: 门 5 通过——无会话但有 background_submitted → no_session（建会话前死亡）", async () => {
  const dir = tempDir("wao-set-12-");
  try {
    const runId = "run_set12";
    seedNoSession(join(dir, `${runId}.jsonl`), runId);
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps() });
    assert.equal(r.eligible, true);
    assert.equal(r.sessionShape, "no_session");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-13: 门 5 拒绝——前台运行（无会话无 background_submitted）→ foreground_no_session", async () => {
  const dir = tempDir("wao-set-13-");
  try {
    const runId = "run_set13";
    writeLines(join(dir, `${runId}.jsonl`), [
      ev(runId, 1, "run.started", OLD, { backend: "claude-code" }),
      ev(runId, 2, "run.state_change", OLD, { from: null, to: "running", reason: "first_event" }),
    ]);
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps() });
    assert.equal(r.refused, "foreground_no_session");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-14: 门 5 拒绝——serveUrl 会话 → session_has_stop_route", async () => {
  const dir = tempDir("wao-set-14-");
  try {
    const runId = "run_set14";
    writeLines(join(dir, `${runId}.jsonl`), [
      ev(runId, 1, "run.started", OLD, { backend: "opencode-serve" }),
      ev(runId, 2, "run.background_submitted", OLD, { background: true }),
      ev(runId, 3, "session.created", OLD, { backend: "opencode-serve", backendSessionId: "ses_1", serveUrl: "http://127.0.0.1:1" }),
      ev(runId, 4, "run.state_change", OLD, { from: null, to: "running", reason: "first_event" }),
    ]);
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps() });
    assert.equal(r.refused, "session_has_stop_route");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-15: 门 5 拒绝——native 会话 id 取不出 pid → session_ambiguous", async () => {
  const dir = tempDir("wao-set-15-");
  try {
    const runId = "run_set15";
    writeLines(join(dir, `${runId}.jsonl`), [
      ev(runId, 1, "run.started", OLD, { backend: "deepseek-acp" }),
      ev(runId, 2, "run.background_submitted", OLD, { background: true }),
      ev(runId, 3, "session.created", OLD, { backend: "deepseek-acp", backendSessionId: "native-uuid" }),
      ev(runId, 4, "run.state_change", OLD, { from: null, to: "running", reason: "first_event" }),
    ]);
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps() });
    assert.equal(r.refused, "session_ambiguous");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-16: 门 5 拒绝——会话进程判 same → process_alive（锚=session.created 的 ts）", async () => {
  const dir = tempDir("wao-set-16-");
  try {
    const runId = "run_set16";
    seedProcSession(join(dir, `${runId}.jsonl`), runId, 4321);
    let seenPid = null;
    let seenAnchor = null;
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps({
      identifyFn: async (pid, anchorAt) => {
        seenPid = pid; seenAnchor = anchorAt;
        return { verdict: "same", basis: "identity_confirmed" };
      },
    }) });
    assert.equal(r.refused, "process_alive");
    assert.equal(seenPid, 4321, "会话身份门探的是 proc_ 解析出的 pid");
    assert.equal(seenAnchor, Date.parse(OLD), "锚取 session.created 的 ts");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-17: 门 5 拒绝——会话进程判 unknown → process_identity_unknown", async () => {
  const dir = tempDir("wao-set-17-");
  try {
    const runId = "run_set17";
    seedProcSession(join(dir, `${runId}.jsonl`), runId);
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps({
      identifyFn: async () => ({ verdict: "unknown", basis: "identity_unknown" }),
    }) });
    assert.equal(r.refused, "process_identity_unknown");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-18: 门 5——重放过：锚取 run.rerun 的 ts、pid 取重放记录（新进程不会被旧锚误判）", async () => {
  const dir = tempDir("wao-set-18-");
  try {
    const runId = "run_set18";
    const rerunTs = "2026-09-20T00:00:00.000Z";
    writeLines(join(dir, `${runId}.jsonl`), [
      ev(runId, 1, "run.started", OLD, { backend: "claude-code" }),
      ev(runId, 2, "run.background_submitted", OLD, { background: true }),
      ev(runId, 3, "session.created", OLD, { backend: "process", backendSessionId: "proc_1111" }),
      ev(runId, 4, "run.state_change", OLD, { from: null, to: "running", reason: "first_event" }),
      ev(runId, 5, "run.rerun", rerunTs, { originalSessionId: "proc_1111", newSessionId: "proc_9999", reason: "replay", hostPid: 8888 }),
    ]);
    let seenPid = null;
    let seenAnchor = null;
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps({
      identifyFn: async (pid, anchorAt) => {
        seenPid = pid; seenAnchor = anchorAt;
        return { verdict: "gone", basis: "pid_reused" };
      },
    }) });
    assert.equal(r.eligible, true, "重放后的新进程判 gone → 可结算");
    assert.equal(seenPid, 9999, "pid 取重放记录的 newSessionId（proc_ 优先于 hostPid）");
    assert.equal(seenAnchor, Date.parse(rerunTs), "锚取 run.rerun 的 ts，不沿用旧 session.created");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 门 6：daemon ──────────────────────────────────────────────────────────────

test("SET-19: 门 6 拒绝——活 daemon → daemon_owned", async () => {
  const dir = tempDir("wao-set-19-");
  try {
    const runId = "run_set19";
    seedNoSession(join(dir, `${runId}.jsonl`), runId);
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps({
      handshakeReader: () => ({ pid: 1, pipe: "p", startedAt: NOW, heartbeatAt: NOW - 1000 }),
      daemonAliveFn: () => true,
    }) });
    assert.equal(r.refused, "daemon_owned");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-20: 门 6 通过——daemon 握手不在/不新鲜 → 算满足", async () => {
  const dir = tempDir("wao-set-20-");
  try {
    const runId = "run_set20";
    seedNoSession(join(dir, `${runId}.jsonl`), runId);
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps({
      handshakeReader: () => ({ pid: 1, heartbeatAt: NOW - 3600_000 }),
      daemonAliveFn: (h, now) => now - h.heartbeatAt <= 10_000, // 真实判法：过期 = 死
    }) });
    assert.equal(r.eligible, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── dry-run 与 apply ──────────────────────────────────────────────────────────

test("SET-21: dry-run 零写入（转录字节不变）", async () => {
  const dir = tempDir("wao-set-21-");
  try {
    const runId = "run_set21";
    const tp = join(dir, `${runId}.jsonl`);
    seedNoSession(tp, runId);
    const before = readFileSync(tp, "utf8");
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, apply: false, deps: settleDeps() });
    assert.equal(r.eligible, true);
    assert.equal(readFileSync(tp, "utf8"), before, "dry-run 转录字节不变");
    assert.equal(r.note.includes("dry-run"), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-22: apply 写入事件形状——failed/process_missing + 确认事实载荷", async () => {
  const dir = tempDir("wao-set-22-");
  try {
    const runId = "run_set22";
    const tp = join(dir, `${runId}.jsonl`);
    seedNoSession(tp, runId);
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, apply: true, deps: settleDeps() });
    assert.equal(r.settled, true);
    assert.equal(r.sessionShape, "no_session");
    assert.equal(r.reasonSha256, createHash("sha256").update(REASON, "utf8").digest("hex"));

    const after = await readTranscript(tp);
    const confirm = after.find((e) => e.type === "run.process_missing_confirmed");
    assert.ok(confirm, "写入确认事实");
    assert.equal(confirm.settledBy, "lead_settle");
    assert.equal(confirm.sessionShape, "no_session");
    assert.equal(confirm.reason, REASON);
    assert.equal(confirm.reasonSha256, createHash("sha256").update(REASON, "utf8").digest("hex"));
    assert.equal(confirm.runId, runId);
    const terminal = after.find((e) => e.type === "run.state_change" && e.to === "failed");
    assert.ok(terminal, "写入终态");
    assert.equal(terminal.reason, "process_missing");
    assert.equal(terminal.from, "pending");
    assert.equal(confirm.seq, terminal.seq - 1, "确认事实与终态转移原子同批（连续 seq）");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-23: apply——proc 会话运行：sessionShape=process_session", async () => {
  const dir = tempDir("wao-set-23-");
  try {
    const runId = "run_set23";
    const tp = join(dir, `${runId}.jsonl`);
    seedProcSession(tp, runId);
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, apply: true, deps: settleDeps() });
    assert.equal(r.settled, true);
    assert.equal(r.sessionShape, "process_session");
    const after = await readTranscript(tp);
    assert.equal(after.find((e) => e.type === "run.process_missing_confirmed").sessionShape, "process_session");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-24: expectedLastSeq 不符 → observed_seq_changed、不写终态（证明后转录长过）", async () => {
  const dir = tempDir("wao-set-24-");
  try {
    const runId = "run_set24";
    const tp = join(dir, `${runId}.jsonl`);
    seedNoSession(tp, runId);
    // 门评估读到的是"少了最后一条"的快照（证明时刻的视图），锁内实读多一条
    // ——等价于证明之后他方（例如 daemon 重放）追加了事件。
    let reads = 0;
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, apply: true, deps: settleDeps({
      readTranscriptFn: async (p) => {
        reads += 1;
        const all = await readTranscript(p);
        return reads === 1 ? all.slice(0, -1) : all;
      },
    }) });
    assert.equal(r.refused, "observed_seq_changed");
    const after = await readTranscript(tp);
    assert.ok(!after.some((e) => e.type === "run.state_change" && e.to === "failed"), "不写终态");
    assert.ok(!after.some((e) => e.type === "run.process_missing_confirmed"), "不写确认事实");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-25: 先写终态者胜——终态后被复活的转录（findState 非终态、锁内已有终态，seq 未变）→ terminal", async () => {
  const dir = tempDir("wao-set-25-");
  try {
    const runId = "run_set25";
    const tp = join(dir, `${runId}.jsonl`);
    // 终态后又错误复活到 running：findState（门 1 用）= running 非终态 → 过门；
    // transitionState 锁内的 _detectExistingTerminal 认得 completed（防复活）→
    // first_terminal_wins。seq 没变，走的不是 observed_seq_changed 分支。
    writeLines(tp, [
      ev(runId, 1, "run.started", OLD, { backend: "claude-code" }),
      ev(runId, 2, "run.background_submitted", OLD, { background: true }),
      ev(runId, 3, "run.state_change", OLD, { from: null, to: "pending", reason: "background_spawned" }),
      ev(runId, 4, "run.state_change", OLD, { from: "pending", to: "completed", reason: "done" }),
      ev(runId, 5, "run.state_change", OLD, { from: "completed", to: "running", reason: "evil_revival" }),
    ]);
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, apply: true, deps: settleDeps() });
    assert.equal(r.refused, "terminal");
    const after = await readTranscript(tp);
    assert.ok(!after.some((e) => e.type === "run.process_missing_confirmed"), "败者不写确认事实");
    assert.ok(!after.some((e) => e.type === "run.state_change" && e.to === "failed"), "不写终态");
    // 拒绝按既有契约落一条审计事件（不静默消失），且只此一条新事件。
    assert.equal(after.length, 6);
    assert.equal(after.at(-1).type, "run.state_change_rejected");
    assert.equal(after.at(-1).reason, "first_terminal_wins");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-26: 非终态运行带确认事实（持久记录腐蚀）→ 抛错、不写", async () => {
  const dir = tempDir("wao-set-26-");
  try {
    const runId = "run_set26";
    const tp = join(dir, `${runId}.jsonl`);
    writeLines(tp, [
      ev(runId, 1, "run.started", OLD, { backend: "claude-code" }),
      ev(runId, 2, "run.background_submitted", OLD, { background: true }),
      ev(runId, 3, "run.state_change", OLD, { from: null, to: "pending", reason: "background_spawned" }),
      ev(runId, 4, "run.process_missing_confirmed", OLD, { settledBy: "lead_settle" }),
    ]);
    await assert.rejects(
      () => settleRun({ runId, runDir: dir, reasonText: REASON, apply: true, deps: settleDeps() }),
      /confirmation in a nonterminal state/,
    );
    const after = await readTranscript(tp);
    assert.equal(after.length, 4, "未追加任何事件");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-27: 理由空 → 抛错；runId/转录缺失的输入面", async () => {
  const dir = tempDir("wao-set-27-");
  try {
    await assert.rejects(
      () => settleRun({ runId: "run_set27", runDir: dir, reasonText: "   ", deps: settleDeps() }),
      /reasonText must be non-empty/,
    );
    await assert.rejects(
      () => settleRun({ runId: "../escape", runDir: dir, reasonText: REASON, deps: settleDeps() }),
      /invalid runId/,
    );
    await assert.rejects(
      () => settleRun({ runId: "run_nope", runDir: dir, reasonText: REASON, deps: settleDeps() }),
      /no transcript/,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 列候选（只读） ────────────────────────────────────────────────────────────

test("SET-28: 列候选——非终态且无新鲜心跳逐条给结论；终态/新鲜心跳不列；坏转录跳过", async () => {
  const dir = tempDir("wao-set-28-");
  try {
    seedNoSession(join(dir, "run_cand_a.jsonl"), "run_cand_a");
    seedProcSession(join(dir, "run_cand_b.jsonl"), "run_cand_b");
    // 终态：不列。
    writeLines(join(dir, "run_done.jsonl"), [
      ev("run_done", 1, "run.state_change", OLD, { from: null, to: "completed", reason: "done" }),
    ]);
    // 新鲜 owner 心跳：不列。
    seedProcSession(join(dir, "run_fresh.jsonl"), "run_fresh");
    writeFileSync(join(dir, ".owner-run_fresh"), JSON.stringify({ pid: 1, heartbeatAt: NOW - 1000 }), "utf8");
    // 坏转录：跳过。
    writeFileSync(join(dir, "run_broken.jsonl"), "{not json}\n", "utf8");

    const result = await listSettleCandidates({
      runDir: dir,
      deps: settleDeps({
        // 与生产同判：真实 checkOwnerLiveness 读 .owner 文件判新鲜。
        ownerHeartbeatReader: (runDir2, runId, now) => checkOwnerLiveness(runDir2, runId, now),
      }),
    });
    assert.equal(result.runDir, dir);
    const ids = result.candidates.map((c) => c.runId);
    assert.deepEqual(ids, ["run_cand_a", "run_cand_b"], "只列非终态且无新鲜心跳的运行");
    const a = result.candidates.find((c) => c.runId === "run_cand_a");
    assert.equal(a.eligible, true);
    assert.equal(a.sessionShape, "no_session");
    assert.ok(Array.isArray(a.gates) && a.gates.length === 6, "通过运行给全部六道门的事实");
    const b = result.candidates.find((c) => c.runId === "run_cand_b");
    assert.equal(b.eligible, true);
    assert.equal(b.state, "running");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 门 2 租约心跳（TD-316，端到端：真实 readOwnerLease 读磁盘租约文件） ────────

test("SET-32: 门 2——有限远未来 heartbeatAt 不算新鲜（TD-316）：租约门照走，eligible", async () => {
  const dir = tempDir("wao-set-32-");
  try {
    const runId = "run_set32";
    seedProcSession(join(dir, `${runId}.jsonl`), runId);
    // settleDeps 默认带 present:false 的租约桩——显式换回真实 readOwnerLease
    // （同 SET-28 给 ownerHeartbeatReader 注真实 checkOwnerLiveness 的做法），
    // 让门 2 端到端读磁盘上的租约文件。pid 等其余字段合法、heartbeatAt 是
    // 有限数字但在阈值外的远未来：wellFormed:true 且 fresh:false（TD-316 前
    // 这里会读成 fresh:true）。
    writeFileSync(join(dir, `.owner-${runId}`), JSON.stringify({ pid: 100, heartbeatAt: NOW + 3600_000 }), "utf8");
    assert.equal(readOwnerLease(dir, runId, NOW).fresh, false, "自证：有限远未来按 TD-316 判不新鲜");
    let ownerAnchor = null;
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps({
      ownerLeaseReader: readOwnerLease,
      identifyFn: async (pid, anchorAt) => {
        if (pid === 100) ownerAnchor = anchorAt;
        return { verdict: "gone", basis: "pid_exited" };
      },
    }) });
    assert.equal(r.eligible, true, "远未来心跳不再触发 owner_fresh；租约过门后其余门全过");
    assert.equal(ownerAnchor, NOW + 3600_000, "身份门以租约 heartbeatAt 为锚——租约确实被读到且判 wellFormed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-33: 门 2 拒绝——租约写 1e400（JSON 解析成 Infinity）→ owner_lease_corrupt（保守拒绝）", async () => {
  const dir = tempDir("wao-set-33-");
  try {
    const runId = "run_set33";
    seedProcSession(join(dir, `${runId}.jsonl`), runId);
    // JSON.stringify 写不出 1e400（Infinity 会序列化成 null），必须落原始 JSON
    // 文本；ownerLeaseReader 同样显式换回真实 readOwnerLease（见 SET-32）。
    writeFileSync(join(dir, `.owner-${runId}`), '{"pid":100,"heartbeatAt":1e400}', "utf8");
    assert.equal(readOwnerLease(dir, runId, NOW).wellFormed, false, "自证：非有限 heartbeatAt 判畸形");
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps({
      ownerLeaseReader: readOwnerLease,
    }) });
    assert.equal(r.refused, "owner_lease_corrupt", "畸形租约保守拒绝——既有正确行为，钉住");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-29: 列候选——被拒运行给闭集拒绝理由（不 eligible）", async () => {
  const dir = tempDir("wao-set-29-");
  try {
    // 前台运行 → foreground_no_session。
    writeLines(join(dir, "run_fg.jsonl"), [
      ev("run_fg", 1, "run.started", OLD, { backend: "claude-code" }),
      ev("run_fg", 2, "run.state_change", OLD, { from: null, to: "running", reason: "first_event" }),
    ]);
    const result = await listSettleCandidates({ runDir: dir, deps: settleDeps() });
    const fg = result.candidates.find((c) => c.runId === "run_fg");
    assert.equal(fg.eligible, false);
    assert.equal(fg.refusal, "foreground_no_session");
    assert.equal(fg.sessionShape, undefined, "被拒运行不给 sessionShape");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-30: runner 扫描判读只认哨兵行——扫描失败绝不读成没有 runner", () => {
  // 旧形状：CIM 出非终止错误时计数照样是 0、退出码 0。没有哨兵 = 失败。
  assert.deepEqual(parseRunnerScanOutput("0"), { failed: true });
  assert.deepEqual(parseRunnerScanOutput(""), { failed: true });
  assert.deepEqual(parseRunnerScanOutput(undefined), { failed: true });
  assert.deepEqual(parseRunnerScanOutput("wao-scan-ok:0"), { failed: true }, "缺第二段也不算成功");
  assert.deepEqual(parseRunnerScanOutput("wao-scan-ok:0:0\r\n"), { alive: false });
  assert.deepEqual(parseRunnerScanOutput("WARNING: x\nwao-scan-ok:0:0"), { alive: false }, "哨兵前有别的行照样认");
  assert.deepEqual(parseRunnerScanOutput("wao-scan-ok:1:0"), { alive: true });
  assert.deepEqual(parseRunnerScanOutput("wao-scan-ok:1:2"), { alive: true }, "命中优先于盲区");
  // 读不到命令行的 node 进程（如提权运行的）：证明不了 runner 不在。
  assert.deepEqual(parseRunnerScanOutput("wao-scan-ok:0:2"), { failed: true });
});

test("SET-31: 默认 runner 扫描——进程出错、旧式裸计数都判失败；脚本把 CIM 错误升级为终止错误", async () => {
  const calls = [];
  const fakeExec = (stdout, err = null) => (file, args, opts, cb) => {
    calls.push({ file, command: args[args.length - 1] });
    cb(err, stdout);
  };
  assert.deepEqual(await defaultRunnerScan("run_20260101000000000abcdef", fakeExec("0")), { failed: true });
  assert.deepEqual(await defaultRunnerScan("run_20260101000000000abcdef", fakeExec("", new Error("exit 1"))), { failed: true });
  assert.deepEqual(await defaultRunnerScan("run_20260101000000000abcdef", fakeExec("wao-scan-ok:0:0")), { alive: false });
  assert.deepEqual(await defaultRunnerScan("run_20260101000000000abcdef", fakeExec("wao-scan-ok:1:0")), { alive: true });
  const throwing = () => { throw new Error("spawn failed"); };
  assert.deepEqual(await defaultRunnerScan("run_20260101000000000abcdef", throwing), { failed: true });
  assert.equal(calls[0].file, "powershell.exe");
  assert.match(calls[0].command, /^\$ErrorActionPreference='Stop';/, "CIM 的非终止错误必须升级为终止错误");
  assert.match(calls[0].command, /--run-id run_20260101000000000abcdef/);
  assert.match(calls[0].command, /--resume-run-id run_20260101000000000abcdef/);
});
