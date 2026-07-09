// TD-99：跨进程原子终态仲裁测试。
//
// transitionState 是 JsonlTranscript 的新方法，在已有 append lock 内一次完成
// "读事件 → 检查既有终态 → 分配 seq → 批量 append"。契约：
//   - first terminal wins：已有终态后任何转移被拒。
//   - 被拒写 run.state_change_rejected 审计事件（不静默消失）。
//   - 返回 {accepted:true, state, transition} 或 {accepted:false, state, rejection}。
//
// 这些测试不依赖 sleep；并发用 Promise.all + 两实例同文件。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  JsonlTranscript,
  readTranscript,
  findState,
  TERMINAL_STATES,
} from "../src/transcript.js";

async function makeDir() {
  return mkdtemp(join(tmpdir(), "wao-terminal-arb-"));
}

function twoInstancesOnSameFile(dir) {
  const filePath = join(dir, "run_test.jsonl");
  const ctx = { runId: "run_test", agentId: "test_agent" };
  return [
    new JsonlTranscript(filePath, ctx),
    new JsonlTranscript(filePath, { ...ctx }),
  ];
}

/** 统计有效的 terminal state_change（不含 rejected 的）。 */
function countTerminalStateChanges(events) {
  return events.filter(
    (e) => e.type === "run.state_change" && TERMINAL_STATES.includes(e.to),
  ).length;
}

test("TD-99: 并发 failed/aborted 恰好一个 accepted，只有一个 terminal state_change", async () => {
  const dir = await makeDir();
  try {
    const [a, b] = twoInstancesOnSameFile(dir);
    // 先建一个非终态基线（running），让两个 claim 都从非终态出发。
    await a.transitionState(null, "running", "first_message");

    const [ra, rb] = await Promise.all([
      a.transitionState("running", "failed", "backend_error"),
      b.transitionState("running", "aborted", "stop_requested"),
    ]);

    const accepted = [ra, rb].filter((r) => r.accepted);
    const rejected = [ra, rb].filter((r) => !r.accepted);
    assert.equal(accepted.length, 1, "恰好一个 accepted");
    assert.equal(rejected.length, 1, "恰好一个 rejected");

    // loser 拿到现有终态
    assert.equal(rejected[0].accepted, false);
    assert.ok(TERMINAL_STATES.includes(rejected[0].state), "loser.state 是现有终态");
    assert.ok(rejected[0].rejection, "loser 带 rejection 审计信息");

    // transcript 只有一个 terminal state_change
    const events = await readTranscript(a.filePath);
    assert.equal(countTerminalStateChanges(events), 1, "只有一个 terminal state_change");
    // winner 的终态生效
    assert.ok(TERMINAL_STATES.includes(findState(events)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-99: terminal 后再尝试 running 必须被拒（状态不能复活）", async () => {
  const dir = await makeDir();
  try {
    const [a] = twoInstancesOnSameFile(dir);
    await a.transitionState(null, "running", "first_message");
    const won = await a.transitionState("running", "failed", "backend_error");
    assert.equal(won.accepted, true);

    const revive = await a.transitionState("failed", "running", "late_revive");
    assert.equal(revive.accepted, false, "terminal 后 running 必须被拒");
    assert.equal(revive.state, "failed", "终态保持 failed");

    const events = await readTranscript(a.filePath);
    assert.equal(findState(events), "failed", "findState 仍 failed，没复活");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-99: running 后先 append run.stop_requested，再 claim aborted 必须 accepted（防自拒绝）", async () => {
  const dir = await makeDir();
  try {
    const [a] = twoInstancesOnSameFile(dir);
    await a.transitionState(null, "running", "first_message");
    // stop_requested 是前置事实（非终态 state_change），不应被当成已 claim 的终态
    await a.append("run.stop_requested", { backendSessionId: "ses1", reason: "user" });

    const r = await a.transitionState("running", "aborted", "stop_requested");
    assert.equal(r.accepted, true, "stop_requested 后 claim aborted 必须 accepted");
    assert.equal(r.state, "aborted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-99: running 后先 append run.error，再 claim failed 必须 accepted", async () => {
  const dir = await makeDir();
  try {
    const [a] = twoInstancesOnSameFile(dir);
    await a.transitionState(null, "running", "first_message");
    await a.append("run.error", { phase: "wait", error: "boom" });

    const r = await a.transitionState("running", "failed", "backend_error");
    assert.equal(r.accepted, true, "run.error 后 claim failed 必须 accepted");
    assert.equal(r.state, "failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-99: running 后先 append run.completed，再 claim completed 必须 accepted", async () => {
  const dir = await makeDir();
  try {
    const [a] = twoInstancesOnSameFile(dir);
    await a.transitionState(null, "running", "first_message");
    await a.append("run.completed", { backendSessionId: "ses1", messageCount: 1 });

    const r = await a.transitionState("running", "completed", "done");
    assert.equal(r.accepted, true, "run.completed 后 claim completed 必须 accepted");
    assert.equal(r.state, "completed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-99: 无 state_change 的旧 transcript 若已有 legacy terminal fact，新 claim 必须 rejected", async () => {
  const dir = await makeDir();
  try {
    const [a] = twoInstancesOnSameFile(dir);
    // 模拟旧 transcript：直接 append run.aborted（legacy terminal fact），无 state_change
    await a.append("run.aborted", { backendSessionId: "ses1", reason: "user" });

    const r = await a.transitionState("running", "failed", "backend_error");
    assert.equal(r.accepted, false, "legacy terminal fact 存在时新 claim 必须被拒");
    assert.equal(r.state, "aborted", "现有终态是 aborted（legacy fallback）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-99: rejected 必须写 run.state_change_rejected 审计事件", async () => {
  const dir = await makeDir();
  try {
    const [a] = twoInstancesOnSameFile(dir);
    await a.transitionState(null, "running", "first_message");
    await a.transitionState("running", "failed", "backend_error");

    const r = await a.transitionState("failed", "aborted", "stop_requested");
    assert.equal(r.accepted, false);

    const events = await readTranscript(a.filePath);
    const rejectedEv = events.find((e) => e.type === "run.state_change_rejected");
    assert.ok(rejectedEv, "必须有 run.state_change_rejected 审计事件");
    assert.equal(rejectedEv.attemptedTo, "aborted");
    assert.equal(rejectedEv.existingTerminal, "failed");
    assert.ok(rejectedEv.reason, "rejection 带 reason");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- TD-99 审计收尾：边界修复测试 ---

test("TD-99 边界: failed 后错误 running 不复活，再尝试 aborted 必须 rejected/state=failed", async () => {
  const dir = await makeDir();
  try {
    const [a] = twoInstancesOnSameFile(dir);
    await a.transitionState(null, "running", "first_message");
    await a.transitionState("running", "failed", "backend_error");
    // 模拟"终态后错误地写了非终态 running"（旧 race 产物或 bug）。
    // _detectExistingTerminal 从后向前扫，发现历史有 terminal failed → 仍拒绝。
    await a.append("run.state_change", { from: "failed", to: "running", reason: "erroneous_revive" });

    const r = await a.transitionState("running", "aborted", "stop_requested");
    assert.equal(r.accepted, false, "终态被错误 running 覆盖后，新转移仍必须 rejected");
    assert.equal(r.state, "failed", "state=failed（最近的 terminal）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-99 边界: aborted 已赢时迟到 completed 不得留下 run.completed fact", async () => {
  const dir = await makeDir();
  try {
    const [a] = twoInstancesOnSameFile(dir);
    await a.transitionState(null, "running", "first_message");
    await a.transitionState("running", "aborted", "stop_requested", {
      factEvents: [{ type: "run.aborted", payload: { reason: "user" } }],
    });
    // 迟到的 completed 带 factEvent——rejected 不得写 run.completed。
    const r = await a.transitionState("aborted", "completed", "done", {
      factEvents: [{ type: "run.completed", payload: { messageCount: 1 } }],
    });
    assert.equal(r.accepted, false);
    const events = await readTranscript(a.filePath);
    const completedFact = events.find((e) => e.type === "run.completed");
    assert.equal(completedFact, undefined, "rejected 不得留 run.completed fact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-99 边界: failed 已赢时迟到 timed_out 不得留下 run.timed_out fact", async () => {
  const dir = await makeDir();
  try {
    const [a] = twoInstancesOnSameFile(dir);
    await a.transitionState(null, "running", "first_message");
    await a.transitionState("running", "failed", "backend_error");
    const r = await a.transitionState("failed", "timed_out", "timeout", {
      factEvents: [{ type: "run.timed_out", payload: {} }],
    });
    assert.equal(r.accepted, false);
    const events = await readTranscript(a.filePath);
    const timedOutFact = events.find((e) => e.type === "run.timed_out");
    assert.equal(timedOutFact, undefined, "rejected 不得留 run.timed_out fact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-99 边界: failed 已赢时迟到 internal abort 不得留下 run.aborted fact", async () => {
  const dir = await makeDir();
  try {
    const [a] = twoInstancesOnSameFile(dir);
    await a.transitionState(null, "running", "first_message");
    await a.transitionState("running", "failed", "backend_error");
    const r = await a.transitionState("failed", "aborted", "user", {
      factEvents: [{ type: "run.aborted", payload: { reason: "user" } }],
    });
    assert.equal(r.accepted, false);
    const events = await readTranscript(a.filePath);
    // 只应有 aborted 的 state_change_rejected，不应有 run.aborted fact。
    const abortedFacts = events.filter((e) => e.type === "run.aborted");
    assert.equal(abortedFacts.length, 0, "rejected 不得留 run.aborted fact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-99 边界: accepted 时 fact event 与 state_change seq 连续", async () => {
  const dir = await makeDir();
  try {
    const [a] = twoInstancesOnSameFile(dir);
    await a.transitionState(null, "running", "first_message");
    const r = await a.transitionState("running", "completed", "done", {
      factEvents: [{ type: "run.completed", payload: { messageCount: 5 } }],
    });
    assert.equal(r.accepted, true);
    assert.ok(r.facts.length === 1, "一个 fact event");
    const factSeq = r.facts[0].seq;
    const stateSeq = r.transition.seq;
    assert.equal(stateSeq - factSeq, 1, "fact 与 state_change seq 连续（+1）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-99 边界: rejection 审计字段完整（attemptedReason + reason=first_terminal_wins）", async () => {
  const dir = await makeDir();
  try {
    const [a] = twoInstancesOnSameFile(dir);
    await a.transitionState(null, "running", "first_message");
    await a.transitionState("running", "failed", "backend_error");
    const r = await a.transitionState("failed", "aborted", "stop_requested");
    assert.equal(r.accepted, false);
    assert.equal(r.rejection.attemptedTo, "aborted");
    assert.equal(r.rejection.attemptedReason, "stop_requested");
    assert.equal(r.rejection.existingTerminal, "failed");
    assert.equal(r.rejection.reason, "first_terminal_wins");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
