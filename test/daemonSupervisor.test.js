// test/daemonSupervisor.test.js
//
// P5 / TD-45：daemon 自愈——独立 supervisor 进程的决策纯函数。
//
// daemon 不能自拉自（引导悖论），所以 supervisor 是正交的守护者（detached 进程）。
// 其决策逻辑（判死→restart / 风暴退避 / 空闲自退 / 活着不动）是纯函数，可单测。
// 进程主体（轮询/重启/IPC）单测覆盖不到，归真实 smoke。
//
// 纯函数 decideSupervisorAction({handshake, ownedRuns, now, consecutiveRestarts, config})
//   → {action: "noop"|"restart"|"backoff"|"idle-exit", reason?}

import test from "node:test";
import assert from "node:assert/strict";
import { decideSupervisorAction } from "../src/daemonSupervisor.js";

const NOW = 100000;
const THRESHOLD = 10000; // 与 daemon DEFAULT_LIVENESS_THRESHOLD_MS 一致
const cfg = (o = {}) => ({
  now: NOW,
  livenessThresholdMs: THRESHOLD,
  maxConsecutiveRestarts: 3, // 连续重启超此 → backoff（防风暴）
  idleExitMs: 60000, // 无在飞 run 且这么久无新派发 → idle-exit
  ...o,
});

// ===== 活着 → noop =====
test("daemon 活着（心跳新鲜）+ 有在飞 run → noop", () => {
  const handshake = { pid: 123, heartbeatAt: NOW - 2000 }; // 2s 前，阈值内
  const ownedRuns = [{ runId: "r1", owner: "daemon", state: "running" }];
  const r = decideSupervisorAction({ handshake, ownedRuns, consecutiveRestarts: 0, config: cfg() });
  assert.equal(r.action, "noop");
});

test("daemon 活着但无在飞 run（已 idle）→ noop（除非超 idleExit 才 exit，见下）", () => {
  const handshake = { pid: 123, heartbeatAt: NOW - 2000 };
  const ownedRuns = []; // 无在飞 run
  const r = decideSupervisorAction({ handshake, ownedRuns, consecutiveRestarts: 0, config: cfg({ now: NOW }) });
  // 刚 idle（lastActivityAt=now）→ noop，等 idleExitMs
  assert.equal(r.action, "noop");
});

// ===== 判死 → restart =====
test("daemon 心跳超时（判死）→ restart（首次，无风暴）", () => {
  const handshake = { pid: 123, heartbeatAt: NOW - THRESHOLD - 5000 }; // 15s 前，超阈值
  const ownedRuns = [{ runId: "r1", owner: "daemon", state: "running" }];
  const r = decideSupervisorAction({ handshake, ownedRuns, consecutiveRestarts: 0, config: cfg() });
  assert.equal(r.action, "restart", "判死且有在飞 run → 重启 daemon");
  assert.ok(r.reason, "restart 应带 reason");
});

test("daemon handshake 不存在（null）→ restart", () => {
  const r = decideSupervisorAction({ handshake: null, ownedRuns: [], consecutiveRestarts: 0, config: cfg() });
  // 无 handshake（daemon 从未起/被清）——supervisor 首职责是确保 daemon 在，故 restart
  assert.equal(r.action, "restart");
});

// ===== 风暴退避（连续重启超限）=====
test("连续重启达上限 → backoff（防风暴，不无限重启）", () => {
  const handshake = { pid: 123, heartbeatAt: NOW - THRESHOLD - 5000 }; // 死的
  const ownedRuns = [];
  const r = decideSupervisorAction({ handshake, ownedRuns, consecutiveRestarts: 3, config: cfg({ maxConsecutiveRestarts: 3 }) });
  assert.equal(r.action, "backoff", "连续重启达上限 → 退避（记告警，不无限拉起）");
  assert.match(r.reason, /风暴|storm|backoff|告警/i, "应说明风暴退避");
});

// ===== 空闲自退（无在飞 run + 长时间无活动）=====
test("无在飞 run 且 idle 超 idleExitMs → idle-exit（任务结束自关）", () => {
  const handshake = { pid: 123, heartbeatAt: NOW - 2000 }; // 活着
  const ownedRuns = []; // 无在飞
  const r = decideSupervisorAction({
    handshake, ownedRuns, consecutiveRestarts: 0,
    config: cfg({ now: NOW, idleExitMs: 60000, lastActivityAt: NOW - 70000 }), // idle 70s > 60s
  });
  assert.equal(r.action, "idle-exit", "空闲超阈值 → 停 daemon + 自退");
});

test("无在飞 run 但 idle 未超 idleExitMs → noop（再等）", () => {
  const handshake = { pid: 123, heartbeatAt: NOW - 2000 };
  const ownedRuns = [];
  const r = decideSupervisorAction({
    handshake, ownedRuns, consecutiveRestarts: 0,
    config: cfg({ now: NOW, idleExitMs: 60000, lastActivityAt: NOW - 30000 }), // idle 30s < 60s
  });
  assert.equal(r.action, "noop");
});

// ===== 坏输入 =====
test("ownedRuns 含非 daemon-owned run（external/orphan）不计入空闲判定", () => {
  // external/orphan run 不归 daemon 管，supervisor 不该因它们而认为 daemon 在忙
  const handshake = { pid: 123, heartbeatAt: NOW - 2000 };
  const ownedRuns = [
    { runId: "re", owner: "external", state: "running" },
    { runId: "ro", owner: "orphan", state: "running" },
  ];
  const r = decideSupervisorAction({
    handshake, ownedRuns, consecutiveRestarts: 0,
    config: cfg({ now: NOW, idleExitMs: 60000, lastActivityAt: NOW - 70000 }),
  });
  assert.equal(r.action, "idle-exit", "external/orphan 不算 daemon-owned，仍判空闲");
});
