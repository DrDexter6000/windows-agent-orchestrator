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
import { readHandshakeDetailed } from "../../src/daemon.js";
import { checkOwnerLiveness, readOwnerLease } from "../../src/application/ownerLiveness.js";
import {
  settleRun,
  listSettleCandidates,
  proveVerifierGone,
  SETTLE_REJECTION_REASONS,
  VERIFIER_GONE_REFUSALS,
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

/** 全部通过的注入集；各测试按需覆写单门。handshakeReader 是三态读器契约。 */
function settleDeps(overrides = {}) {
  return {
    nowFn: () => NOW,
    ownerLeaseReader: () => ({ present: false }),
    identifyFn: async () => ({ verdict: "gone", basis: "pid_exited" }),
    runnerScanFn: async () => ({ alive: false }),
    handshakeReader: () => ({ present: false }),
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
      handshakeReader: () => ({ present: true, unreadable: false, handshake: { pid: 1, pipe: "p", startedAt: NOW, heartbeatAt: NOW - 1000 } }),
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
      handshakeReader: () => ({ present: true, unreadable: false, handshake: { pid: 1, heartbeatAt: NOW - 3600_000 } }),
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

// ═══════════════════════════════════════════════════════════════════════════
// 决定 0096：proveVerifierGone——终态 completed + 验证显式 pending 的后台运行，
// 其验证者是否已不在。全部探测注入；零真实进程、零真实 PowerShell。
// ═══════════════════════════════════════════════════════════════════════════

const BASE = "b".repeat(40);
const DELIVERED = "d".repeat(40);

function makePendingRef(runId, over = {}) {
  return {
    schemaVersion: 1,
    kind: "git_commit",
    runId,
    baseCommit: BASE,
    deliveryCommit: DELIVERED,
    branch: `wao/${runId}`,
    worktreePath: "D:/fake/wt",
    changedFiles: ["src/a.js"],
    verification: { status: "pending", commands: [], verifiedCommit: DELIVERED, results: [] },
    acceptance: { status: "pending", reviewerType: "lead_agent" },
    integration: { status: "pending", targetCommit: null },
    ...over,
  };
}

/**
 * 后台派发、已完成、交付显式 pending 的运行（验证者形状的基线）。
 * opts.rerun / opts.backgroundCount / opts.noBackground / opts.completed 可改前提。
 */
function seedVerifierGoneRun(tp, runId, opts = {}) {
  const ref = opts.ref ?? makePendingRef(runId);
  const events = [
    ev(runId, 1, "run.started", OLD, { backend: "claude-code" }),
    ev(runId, 2, "run.background_submitted", OLD, { background: true }),
    ev(runId, 3, "session.created", OLD, { backend: "process", backendSessionId: "proc_4321" }),
    ev(runId, 4, "run.state_change", OLD, { from: null, to: "pending", reason: "background_spawned" }),
    ev(runId, 5, "run.delivery_created", OLD, { delivery: ref }),
    ev(runId, 6, "run.state_change", OLD, { from: "running", to: "completed", reason: "done" }),
  ];
  if (opts.noBackground) events.splice(1, 1);
  if (opts.doubleBackground) events.splice(2, 0, ev(runId, 50, "run.background_submitted", OLD, { background: true }));
  if (opts.rerun) {
    events.push(ev(runId, 7, "run.rerun", OLD, {
      originalSessionId: "proc_4321", newSessionId: "proc_9999", reason: "replay", hostPid: 9999,
    }));
  }
  if (opts.extra) events.push(...opts.extra.map((e, i) => ev(runId, 100 + i, e.type, e.ts ?? OLD, e.extra ?? {})));
  writeLines(tp, events);
  return ref;
}

/** 前提取快照：读出已落盘的转录（prove 接收 events，不自己读）。 */
async function readSeed(tp) {
  return readTranscript(tp);
}

function proofDeps(overrides = {}) {
  return settleDeps(overrides);
}

test("SET-34: VERIFIER_GONE_REFUSALS 闭集", () => {
  assert.deepEqual(VERIFIER_GONE_REFUSALS, [
    "not_pending", "foreground_verifier", "resumed",
    "owner_lease_corrupt", "owner_fresh", "owner_alive",
    "process_identity_unknown", "quiet_window", "daemon_owned",
    "runner_scan_failed", "runner_alive",
  ]);
});

test("SET-35: 证明成立——租约缺失 → gone，basis=lease_missing", async () => {
  const dir = tempDir("wao-vg-35-");
  try {
    const runId = "run_vg35";
    const tp = join(dir, `${runId}.jsonl`);
    seedVerifierGoneRun(tp, runId);
    const events = await readSeed(tp);
    const r = await proveVerifierGone({ events, runId, runDir: dir, deps: proofDeps() });
    assert.deepEqual(r, { gone: true, basis: "lease_missing" });
    assert.equal(Object.hasOwn(r, "pid"), false, "不回显 pid");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-36: 证明成立——过期租约 + 身份判定三种 gone basis", async () => {
  const dir = tempDir("wao-vg-36-");
  try {
    for (const basis of ["pid_exited", "rebooted_since_anchor", "pid_reused"]) {
      const runId = `run_vg36_${basis}`;
      const tp = join(dir, `${runId}.jsonl`);
      seedVerifierGoneRun(tp, runId);
      const events = await readSeed(tp);
      let seen = null;
      const r = await proveVerifierGone({ events, runId, runDir: dir, deps: proofDeps({
        ownerLeaseReader: () => ({ present: true, wellFormed: true, fresh: false, heartbeatAt: NOW - 3600_000, pid: 777 }),
        identifyFn: async (pid, anchorAt) => {
          seen = { pid, anchorAt };
          return { verdict: "gone", basis };
        },
      }) });
      assert.deepEqual(r, { gone: true, basis }, basis);
      assert.deepEqual(seen, { pid: 777, anchorAt: NOW - 3600_000 }, "探的是租约 pid 与 heartbeatAt 锚");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-37: not_pending——有结果 / 有 reverify 事实 / legacy 未显式 pending / 非终态", async () => {
  const dir = tempDir("wao-vg-37-");
  try {
    // ① 原始验证已有结果。
    {
      const runId = "run_vg37_result";
      const tp = join(dir, `${runId}.jsonl`);
      const ref = seedVerifierGoneRun(tp, runId);
      const events = await readSeed(tp);
      events.push(ev(runId, 200, "run.delivery_verification_passed", OLD, {
        delivery: { ...ref, verification: { status: "passed", commands: [], verifiedCommit: DELIVERED, results: [] } },
      }));
      const r = await proveVerifierGone({ events, runId, runDir: dir, deps: proofDeps() });
      assert.deepEqual(r, { gone: false, refusal: "not_pending" });
    }
    // ② 原始验证 pending 却有 reverify 事实（断链）。
    {
      const runId = "run_vg37_reverify";
      const tp = join(dir, `${runId}.jsonl`);
      const ref = seedVerifierGoneRun(tp, runId);
      const events = await readSeed(tp);
      events.push(ev(runId, 200, "run.delivery_reverification_requested", OLD, {
        delivery: ref, deliveryCommit: DELIVERED, reason: "tooling_invalid",
      }));
      const r = await proveVerifierGone({ events, runId, runDir: dir, deps: proofDeps() });
      assert.deepEqual(r, { gone: false, refusal: "not_pending" });
    }
    // ③ legacy created 未显式声明 pending（没有拒绝资格，也就没有这项证明）。
    {
      const runId = "run_vg37_legacy";
      const tp = join(dir, `${runId}.jsonl`);
      const legacyRef = makePendingRef(runId, { verification: { commands: [], verifiedCommit: DELIVERED, results: [] } });
      seedVerifierGoneRun(tp, runId, { ref: legacyRef });
      const events = await readSeed(tp);
      const r = await proveVerifierGone({ events, runId, runDir: dir, deps: proofDeps() });
      assert.deepEqual(r, { gone: false, refusal: "not_pending" });
    }
    // ④ 非终态。
    {
      const runId = "run_vg37_running";
      const tp = join(dir, `${runId}.jsonl`);
      seedVerifierGoneRun(tp, runId);
      const events = (await readSeed(tp)).filter((e) => !(e.type === "run.state_change" && e.to === "completed"));
      const r = await proveVerifierGone({ events, runId, runDir: dir, deps: proofDeps() });
      assert.deepEqual(r, { gone: false, refusal: "not_pending" });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-38: foreground_verifier——前台运行（无 background_submitted）", async () => {
  const dir = tempDir("wao-vg-38-");
  try {
    const runId = "run_vg38";
    const tp = join(dir, `${runId}.jsonl`);
    seedVerifierGoneRun(tp, runId, { noBackground: true });
    const events = await readSeed(tp);
    const r = await proveVerifierGone({ events, runId, runDir: dir, deps: proofDeps() });
    assert.deepEqual(r, { gone: false, refusal: "foreground_verifier" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-39: resumed——有绑定的 run.rerun（驱动进程换过）", async () => {
  const dir = tempDir("wao-vg-39-");
  try {
    const runId = "run_vg39";
    const tp = join(dir, `${runId}.jsonl`);
    seedVerifierGoneRun(tp, runId, { rerun: true });
    const events = await readSeed(tp);
    const r = await proveVerifierGone({ events, runId, runDir: dir, deps: proofDeps() });
    assert.deepEqual(r, { gone: false, refusal: "resumed" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

async function proveWith(seedOpts, depsOverrides) {
  const dir = tempDir("wao-vg-gate-");
  const runId = "run_vg_gate";
  try {
    const tp = join(dir, `${runId}.jsonl`);
    seedVerifierGoneRun(tp, runId, seedOpts);
    const events = await readSeed(tp);
    return await proveVerifierGone({ events, runId, runDir: dir, deps: proofDeps(depsOverrides) });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("SET-40: owner 租约门——损坏 / 新鲜 / 判 alive / 判 unknown", async () => {
  assert.deepEqual(await proveWith({}, {
    ownerLeaseReader: () => ({ present: true, wellFormed: false }),
  }), { gone: false, refusal: "owner_lease_corrupt" });
  assert.deepEqual(await proveWith({}, {
    ownerLeaseReader: () => ({ present: true, wellFormed: true, fresh: true, heartbeatAt: NOW - 1000, pid: 100 }),
  }), { gone: false, refusal: "owner_fresh" });
  assert.deepEqual(await proveWith({}, {
    ownerLeaseReader: () => ({ present: true, wellFormed: true, fresh: false, heartbeatAt: NOW - 3600_000, pid: 100 }),
    identifyFn: async () => ({ verdict: "same", basis: "identity_confirmed" }),
  }), { gone: false, refusal: "owner_alive" });
  assert.deepEqual(await proveWith({}, {
    ownerLeaseReader: () => ({ present: true, wellFormed: true, fresh: false, heartbeatAt: NOW - 3600_000, pid: 100 }),
    identifyFn: async () => ({ verdict: "unknown", basis: "identity_unknown" }),
  }), { gone: false, refusal: "process_identity_unknown" });
});

test("SET-41: quiet_window——最后一条绑定事件太新", async () => {
  const dir = tempDir("wao-vg-41-");
  try {
    const runId = "run_vg41";
    const tp = join(dir, `${runId}.jsonl`);
    seedVerifierGoneRun(tp, runId);
    const events = await readSeed(tp);
    events.push(ev(runId, 200, "run.event", new Date(NOW - 60_000).toISOString(), { kind: "message" }));
    const r = await proveVerifierGone({ events, runId, runDir: dir, deps: proofDeps() });
    assert.deepEqual(r, { gone: false, refusal: "quiet_window" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-42: daemon 可能在驱动 → daemon_owned（completed 前启动的新鲜握手；之前启动、过期、pid 判 same）", async () => {
  const beforeCompleted = Date.parse(OLD) - 3600_000;
  // 新鲜握手，completed 之前启动。
  assert.deepEqual(await proveWith({}, {
    handshakeReader: () => ({ present: true, unreadable: false, handshake: { pid: 900, startedAt: beforeCompleted, heartbeatAt: NOW - 1000 } }),
    daemonAliveFn: (h, now) => now - h.heartbeatAt <= 10_000,
  }), { gone: false, refusal: "daemon_owned" });
  // 过期握手，completed 之前启动，pid 判 same。
  let seenPid = null;
  let seenAnchor = null;
  const r = await proveWith({}, {
    handshakeReader: () => ({ present: true, unreadable: false, handshake: { pid: 901, startedAt: beforeCompleted, heartbeatAt: NOW - 3600_000 } }),
    daemonAliveFn: () => false,
    identifyFn: async (pid, anchorAt) => {
      seenPid = pid; seenAnchor = anchorAt;
      return { verdict: "same", basis: "identity_confirmed" };
    },
  });
  assert.deepEqual(r, { gone: false, refusal: "daemon_owned" });
  assert.equal(seenPid, 901, "探的是握手 pid");
  assert.equal(seenAnchor, beforeCompleted, "锚取握手 startedAt");
});

test("SET-43: daemon 不拒——completed 之后才启动的新鲜握手；过期且 pid 判 gone", async () => {
  const beforeCompleted = Date.parse(OLD) - 3600_000;
  // 晚于 completed 启动：daemon 跳过终态运行，不可能是验证者。
  assert.deepEqual(await proveWith({}, {
    handshakeReader: () => ({ present: true, unreadable: false, handshake: { pid: 902, startedAt: NOW - 1000, heartbeatAt: NOW - 500 } }),
    daemonAliveFn: () => true,
  }), { gone: true, basis: "lease_missing" });
  // 早于 completed 启动但已过期且 pid 判 gone。
  assert.deepEqual(await proveWith({}, {
    handshakeReader: () => ({ present: true, unreadable: false, handshake: { pid: 903, startedAt: beforeCompleted, heartbeatAt: NOW - 3600_000 } }),
    daemonAliveFn: () => false,
    identifyFn: async () => ({ verdict: "gone", basis: "pid_exited" }),
  }), { gone: true, basis: "lease_missing" });
});

test("SET-44: 进程扫描门——扫描失败 / 命中", async () => {
  assert.deepEqual(await proveWith({}, {
    runnerScanFn: async () => ({ failed: true }),
  }), { gone: false, refusal: "runner_scan_failed" });
  assert.deepEqual(await proveWith({}, {
    runnerScanFn: async () => ({ alive: true }),
  }), { gone: false, refusal: "runner_alive" });
});

test("SET-45: 有界 pending 拒绝之后同样成立", async () => {
  const dir = tempDir("wao-vg-45-");
  try {
    const runId = "run_vg45";
    const tp = join(dir, `${runId}.jsonl`);
    const ref = seedVerifierGoneRun(tp, runId);
    const decisionRef = {
      ...ref,
      verification: { status: "pending", commands: [], verifiedCommit: DELIVERED, results: [] },
      acceptance: { status: "rejected", reviewerType: "lead_agent" },
    };
    const events = await readSeed(tp);
    events.push(ev(runId, 200, "run.delivery_rejected", OLD, {
      delivery: decisionRef,
      deliveryCommit: DELIVERED,
      reviewerType: "lead_agent",
      reason: "验证不会完成，先有界拒收",
    }));
    const r = await proveVerifierGone({ events, runId, runDir: dir, deps: proofDeps() });
    assert.deepEqual(r, { gone: true, basis: "lease_missing" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-46: runner 扫描命令含三种 -like 匹配（--run-id / --resume-run-id / resume），仍排除自身祖先链", async () => {
  const calls = [];
  const fakeExec = (stdout) => (file, args, opts, cb) => {
    calls.push({ file, command: args[args.length - 1] });
    cb(null, stdout);
  };
  const runId = "run_20260101000000000abcdef";
  assert.deepEqual(await defaultRunnerScan(runId, fakeExec("wao-scan-ok:0:0")), { alive: false });
  const command = calls[0].command;
  assert.match(command, new RegExp(`\\*--run-id ${runId}\\*`), "--run-id 匹配");
  assert.match(command, new RegExp(`\\*--resume-run-id ${runId}\\*`), "--resume-run-id 匹配");
  assert.match(command, new RegExp(`\\*resume ${runId}\\*`), "前台 resume <runId> 匹配");
  assert.match(command, /\$ex=\@\(\); \$pp=\$PID;/, "从扫描进程自身开始建祖先链");
  assert.match(command, /\$pp=\$q\.ParentProcessId/, "沿父链上溯");
  assert.match(command, /\$ex -notcontains \[string\]\$_.ProcessId/, "排除祖先链上的进程");
});

test("SET-47: settle 门 3——前台 resume 续跑中的非终态运行被扫描命中 → runner_alive", async () => {
  const dir = tempDir("wao-vg-47-");
  try {
    const runId = "run_vg47";
    writeLines(join(dir, `${runId}.jsonl`), [
      ev(runId, 1, "run.started", OLD, { backend: "claude-code" }),
      ev(runId, 2, "session.created", OLD, { backend: "process", backendSessionId: "proc_4321" }),
      ev(runId, 3, "run.state_change", OLD, { from: null, to: "running", reason: "first_event" }),
      ev(runId, 4, "run.rerun", OLD, { originalSessionId: "proc_1111", newSessionId: "proc_4321", reason: "replay", hostPid: 4321 }),
    ]);
    const r = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps({
      // 前台 `wao resume <runId>` 正在续跑：默认扫描会命中（新匹配），结算必须拒。
      runnerScanFn: async () => ({ alive: true }),
    }) });
    assert.equal(r.refused, "runner_alive");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// 第 51 批修正轮（会审必改 1/2/3 + 建议 7 + 会审缺口）。
// ═══════════════════════════════════════════════════════════════════════════

test("SET-48: 门 6（真实 readHandshakeDetailed）——文件不在放行；在但空/半截/null/数组 → daemon_owned；读出但不新鲜放行", async () => {
  const dir = tempDir("wao-set-48-");
  try {
    const runId = "run_set48";
    const tp = join(dir, `${runId}.jsonl`);
    seedNoSession(tp, runId);
    // 文件不在：放行。
    const r0 = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps({
      handshakeReader: readHandshakeDetailed,
    }) });
    assert.equal(r0.eligible, true, "无握手文件照旧视为没有 daemon");
    // 文件在但读不出：四种形状都拒 daemon_owned（空串、半截 JSON、JSON null、数组）。
    for (const [name, content] of [
      ["空串", ""],
      ["半截", '{"pid":12'],
      ["null", "null"],
      ["数组", "[1,2]"],
    ]) {
      writeFileSync(join(dir, "daemon.json"), content, "utf8");
      const r = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps({
        handshakeReader: readHandshakeDetailed,
      }) });
      assert.equal(r.refused, "daemon_owned", `握手文件在但读不出（${name}）不能当成没有 daemon`);
      const daemonFact = r.gates.find((g) => g.gate === "daemon");
      assert.match(daemonFact.detail, /握手文件在但读不出/, `${name}: 拒绝事实写明读不出`);
    }
    // 读出了但不新鲜（过期握手 = 死 daemon）：放行。
    writeFileSync(join(dir, "daemon.json"), JSON.stringify({ pid: 1, heartbeatAt: NOW - 3600_000 }), "utf8");
    const r1 = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps({
      handshakeReader: readHandshakeDetailed,
      daemonAliveFn: (h, now) => now - h.heartbeatAt <= 10_000,
    }) });
    assert.equal(r1.eligible, true, "读出的过期握手照旧放行");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-49: proveVerifierGone——握手文件在但读不出（真实 readHandshakeDetailed）→ daemon_owned", async () => {
  const dir = tempDir("wao-vg-49-");
  try {
    const runId = "run_vg49";
    const tp = join(dir, `${runId}.jsonl`);
    seedVerifierGoneRun(tp, runId);
    const events = await readSeed(tp);
    for (const content of ["", '{"pid":12', "null", "[1,2]"]) {
      writeFileSync(join(dir, "daemon.json"), content, "utf8");
      const r = await proveVerifierGone({ events, runId, runDir: dir, deps: proofDeps({
        handshakeReader: readHandshakeDetailed,
      }) });
      assert.deepEqual(r, { gone: false, refusal: "daemon_owned" }, `内容 ${JSON.stringify(content)} 不能当成无 daemon`);
    }
    // 文件不在：照旧放行。
    rmSync(join(dir, "daemon.json"), { force: true });
    const r = await proveVerifierGone({ events, runId, runDir: dir, deps: proofDeps({
      handshakeReader: readHandshakeDetailed,
    }) });
    assert.deepEqual(r, { gone: true, basis: "lease_missing" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-50: 同一时刻不算\"之后\"——startedAt === completedAt 且握手新鲜 → daemon_owned；completedAt+1 → 放行", async () => {
  const completedAt = Date.parse(OLD);
  assert.deepEqual(await proveWith({}, {
    handshakeReader: () => ({ present: true, unreadable: false, handshake: { pid: 910, startedAt: completedAt, heartbeatAt: NOW - 1000 } }),
    daemonAliveFn: (h, now) => now - h.heartbeatAt <= 10_000,
  }), { gone: false, refusal: "daemon_owned" }, "startedAt === completedAt 按\"之前启动\"继续判：新鲜即拒");
  assert.deepEqual(await proveWith({}, {
    handshakeReader: () => ({ present: true, unreadable: false, handshake: { pid: 911, startedAt: completedAt + 1, heartbeatAt: NOW - 1000 } }),
    daemonAliveFn: () => true,
  }), { gone: true, basis: "lease_missing" }, "completedAt+1 才算晚于 completed 启动");
});

test("SET-51: legacy completed（只有 run.completed、没有绑定 state_change→completed）→ not_pending", async () => {
  const dir = tempDir("wao-vg-51-");
  try {
    const runId = "run_vg51";
    const tp = join(dir, `${runId}.jsonl`);
    writeLines(tp, [
      ev(runId, 1, "run.started", OLD, { backend: "claude-code" }),
      ev(runId, 2, "run.background_submitted", OLD, { background: true }),
      ev(runId, 3, "run.delivery_created", OLD, { delivery: makePendingRef(runId) }),
      ev(runId, 4, "run.completed", OLD, {}),
    ]);
    const events = await readSeed(tp);
    const r = await proveVerifierGone({ events, runId, runDir: dir, deps: proofDeps() });
    assert.deepEqual(r, { gone: false, refusal: "not_pending" },
      "有界 pending 拒绝要求绑定的 completed state_change；没有它证明不成立");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-52: 扫描命令——notBeforeMs 给出时按 CreationDate 收窄；缺省时命令文本与旧版逐字节相同", async () => {
  const calls = [];
  const fakeExec = (stdout) => (file, args, opts, cb) => {
    calls.push({ file, command: args[args.length - 1] });
    cb(null, stdout);
  };
  const runId = "run_20260101000000000abcdef";
  // 缺省：与收窄前的命令逐字节相同（含旧版 blind 行、无 $cut）。
  const legacyCommand = [
    "$ErrorActionPreference='Stop';",
    "$ex=@(); $pp=$PID; $n=0;",
    "while ($pp -and ($ex -notcontains [string]$pp) -and $n -lt 64) { $ex+=[string]$pp; $n++;",
    "  $q=Get-CimInstance Win32_Process -Filter ('ProcessId='+$pp);",
    "  if (-not $q) { break }; $pp=$q.ParentProcessId };",
    "$all=@(Get-CimInstance Win32_Process | Where-Object { $ex -notcontains [string]$_.ProcessId });",
    `$hit=@($all | Where-Object { $_.CommandLine -like '*--run-id ${runId}*' -or $_.CommandLine -like '*--resume-run-id ${runId}*' -or $_.CommandLine -like '*resume ${runId}*' }).Count;`,
    "$blind=@($all | Where-Object { $_.Name -like 'node*' -and -not $_.CommandLine }).Count;",
    "'wao-scan-ok:' + $hit + ':' + $blind",
  ].join(" ");
  await defaultRunnerScan(runId, fakeExec("wao-scan-ok:0:0"));
  assert.equal(calls[0].command, legacyCommand, "notBeforeMs 缺省 = 旧命令逐字节");
  // 收窄：$cut 用 epoch ms − 5000 换算；blind 行按 CreationDate（转 UTC）过滤，
  // 读不到 CreationDate 的照旧计入；命令行原文仍不出 PowerShell，回传仍只有计数。
  const notBefore = Date.parse("2026-10-30T08:00:00.000Z");
  await defaultRunnerScan(runId, fakeExec("wao-scan-ok:0:1"), notBefore);
  const narrowed = calls[1].command;
  assert.match(narrowed, /\$cut=\[DateTimeOffset\]::FromUnixTimeMilliseconds\((\d+)\)\.UtcDateTime;/);
  assert.equal(
    Number(/\$cut=\[DateTimeOffset\]::FromUnixTimeMilliseconds\((\d+)\)/.exec(narrowed)[1]),
    notBefore - 5000,
    "换算带 5 秒时钟偏差余量",
  );
  assert.match(narrowed, /\$null -eq \$\_\.CreationDate\) -or \(\$\_\.CreationDate\.ToUniversalTime\(\) -ge \$cut/, "读不到 CreationDate 的照旧计入");
  assert.ok(!narrowed.includes("-and -not $_.CommandLine }).Count;"), "旧版 blind 行不再出现");
  assert.match(narrowed, /'wao-scan-ok:' \+ \$hit \+ ':' \+ \$blind/, "回传仍只有计数");
  assert.match(narrowed, /CommandLine -like/, "匹配仍在 PowerShell 内做");
});

test("SET-53: 扫描的收窄锚只取那条 run.background_submitted 的时刻；前台运行、多条或读不出就不传", async () => {
  const dir = tempDir("wao-vg-53-");
  try {
    const runId = "run_vg53";
    const tp = join(dir, `${runId}.jsonl`);
    // run.started 比派发事实早一分钟：锚必须是派发事实，不是最早一条事件。
    const submittedMs = Date.parse(OLD);
    const startedIso = new Date(submittedMs - 60_000).toISOString();
    writeLines(tp, [
      ev(runId, 1, "run.started", startedIso, { backend: "claude-code" }),
      ev(runId, 2, "run.background_submitted", OLD, { background: true }),
      ev(runId, 3, "run.state_change", OLD, { from: null, to: "pending", reason: "background_spawned" }),
    ]);
    const seen = [];
    const scanStub = async (id, notBeforeMs) => {
      seen.push(notBeforeMs);
      return { alive: false };
    };
    await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps({ runnerScanFn: scanStub }) });
    assert.equal(seen[0], submittedMs, "settle 门 3 传派发事实的时刻");
    // 证明部分用验证者形状（终态 completed + 交付显式 pending）才会走到扫描。
    const proofId = "run_vg53_proof";
    seedVerifierGoneRun(join(dir, `${proofId}.jsonl`), proofId);
    const events = await readSeed(join(dir, `${proofId}.jsonl`));
    seen.length = 0;
    await proveVerifierGone({ events, runId: proofId, runDir: dir, deps: proofDeps({ runnerScanFn: scanStub }) });
    assert.equal(seen[0], submittedMs, "证明的扫描同样传派发事实的时刻");
    // 前台运行（会审复现：前台驱动先启动、后写 run.started，比首条事件早，命令行
    // 读不到）：没有派发事实就不收窄，读不到命令行的进程照旧让扫描判失败。
    writeLines(tp, [
      ev(runId, 1, "run.started", OLD, { backend: "claude-code" }),
      ev(runId, 2, "session.created", OLD, { backend: "process", backendSessionId: "proc_4321" }),
      ev(runId, 3, "run.state_change", OLD, { from: null, to: "running", reason: "first_message" }),
    ]);
    seen.length = 0;
    await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps({ runnerScanFn: scanStub }) });
    assert.equal(seen.length, 1, "前台运行同样走到门 3");
    assert.equal(seen[0], undefined, "前台运行不传锚");
    // 结果层面：扫描桩模拟"有读不到命令行、且早于首事件创建的活驱动"——不传锚时
    // 它仍在盲区（失败），传锚才会被排除。前台运行不传锚，结算必须拒。
    const blindDriverScan = async (id, notBeforeMs) => (notBeforeMs === undefined ? { failed: true } : { alive: false });
    const refused = await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps({ runnerScanFn: blindDriverScan }) });
    assert.equal(refused.refused, "runner_scan_failed", "前台运行的盲区活驱动不能被收窄排除");
    // 两条派发事实 → 不传。
    writeLines(tp, [
      ev(runId, 1, "run.started", OLD, { backend: "claude-code" }),
      ev(runId, 2, "run.background_submitted", OLD, { background: true }),
      ev(runId, 3, "run.background_submitted", OLD, { background: true }),
      ev(runId, 4, "run.state_change", OLD, { from: null, to: "pending", reason: "background_spawned" }),
    ]);
    seen.length = 0;
    await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps({ runnerScanFn: scanStub }) });
    assert.equal(seen[0], undefined, "两条派发事实不传锚");
    // 派发事实的 ts 读不出 → 不传。
    writeLines(tp, [
      ev(runId, 1, "run.started", OLD, { backend: "claude-code" }),
      ev(runId, 2, "run.background_submitted", "not-a-timestamp", { background: true }),
      ev(runId, 3, "run.state_change", OLD, { from: null, to: "pending", reason: "background_spawned" }),
    ]);
    seen.length = 0;
    await settleRun({ runId, runDir: dir, reasonText: REASON, deps: settleDeps({ runnerScanFn: scanStub }) });
    assert.equal(seen[0], undefined, "读不出锚就不传");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SET-54: 前面的门拒绝后不再起扫描（证明顺序：租约→静默→daemon→扫描）", async () => {
  const scanThrows = async () => { throw new Error("scan must not run after an earlier gate refused"); };
  // 前提拒绝（两条 background_submitted）也不进探测。
  assert.deepEqual(await proveWith({ doubleBackground: true }, {
    runnerScanFn: scanThrows,
  }), { gone: false, refusal: "foreground_verifier" });
  // 租约门拒绝：扫描不起。
  assert.deepEqual(await proveWith({}, {
    ownerLeaseReader: () => ({ present: true, wellFormed: false }),
    runnerScanFn: scanThrows,
  }), { gone: false, refusal: "owner_lease_corrupt" });
  // daemon 门拒绝：扫描不起。
  const beforeCompleted = Date.parse(OLD) - 3600_000;
  assert.deepEqual(await proveWith({}, {
    handshakeReader: () => ({ present: true, unreadable: false, handshake: { pid: 920, startedAt: beforeCompleted, heartbeatAt: NOW - 1000 } }),
    daemonAliveFn: () => true,
    runnerScanFn: scanThrows,
  }), { gone: false, refusal: "daemon_owned" });
});

test("SET-55: daemon 握手 pid 判 unknown → daemon_owned", async () => {
  const beforeCompleted = Date.parse(OLD) - 3600_000;
  assert.deepEqual(await proveWith({}, {
    handshakeReader: () => ({ present: true, unreadable: false, handshake: { pid: 921, startedAt: beforeCompleted, heartbeatAt: NOW - 3600_000 } }),
    daemonAliveFn: () => false,
    identifyFn: async () => ({ verdict: "unknown", basis: "identity_unknown" }),
  }), { gone: false, refusal: "daemon_owned" });
});

test("SET-56: 两条 background_submitted → foreground_verifier（恰好一条的前提）", async () => {
  assert.deepEqual(await proveWith({ doubleBackground: true }, {}), { gone: false, refusal: "foreground_verifier" });
});
