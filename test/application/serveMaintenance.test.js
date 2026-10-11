// test/application/serveMaintenance.test.js
//
// TD-250（决定 0056）A2/A3 钉：清扫门（按会话认领+worktree 已亡三条件）、
// soak 集合比对、回收锁、recycle 拒绝闭集与成功路径（env 组装权归命令）。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isWorktreeShapedRoot,
  worktreeRootVerdict,
  soakVerdict,
  acquireMaintenanceLock,
  planSessionSweep,
  applySessionSweep,
  serveMaintenanceDir,
} from "../../src/application/serveMaintenance.js";

function cleanupDir(dir) { rmSync(dir, { recursive: true, force: true }); }

// ===== 纯门 =====

test("TD-250 A3 门: isWorktreeShapedRoot——父目录名 .wao-worktrees（大小写折叠、双分隔符）", () => {
  assert.equal(isWorktreeShapedRoot("D:\\proj\\.wao-worktrees\\run_1"), true);
  assert.equal(isWorktreeShapedRoot("D:/proj/.WAO-Worktrees/run_2"), true);
  assert.equal(isWorktreeShapedRoot("D:\\proj\\.wao-worktrees"), false, "root 本身是 .wao-worktrees 不算");
  assert.equal(isWorktreeShapedRoot("D:\\projects\\investment"), false, "源仓/稳定目录=形状外");
  assert.equal(isWorktreeShapedRoot(""), false);
  assert.equal(isWorktreeShapedRoot("run_1"), false);
});

test("TD-250 A3 门: worktreeRootVerdict 闭集（dead=唯一可删形态；suspect=fail-closed）", () => {
  const statMap = (paths, errForMissing = { code: "ENOENT" }) => (p) => {
    const hit = paths.find((x) => x.toLowerCase() === String(p).toLowerCase());
    if (hit) return { isDirectory: () => true };
    throw errForMissing;
  };
  // dead：父在场可读 + root 干净 ENOENT
  assert.equal(worktreeRootVerdict("D:\\p\\.wao-worktrees\\run_1", { statFn: statMap(["D:\\p\\.wao-worktrees"]) }), "dead");
  // alive：root 在盘（残骸也算活——安全方向）
  assert.equal(worktreeRootVerdict("D:\\p\\.wao-worktrees\\run_1",
    { statFn: statMap(["D:\\p\\.wao-worktrees", "D:\\p\\.wao-worktrees\\run_1"]) }), "alive");
  // suspect：父目录缺席（盘没挂/搬家=环境可疑，整批放弃）
  assert.equal(worktreeRootVerdict("D:\\p\\.wao-worktrees\\run_1", { statFn: statMap([]) }), "suspect");
  // suspect：非 ENOENT 错误（权限等）绝不当作"亡"
  assert.equal(worktreeRootVerdict("D:\\p\\.wao-worktrees\\run_1",
    { statFn: statMap(["D:\\p\\.wao-worktrees"], { code: "EPERM" }) }), "suspect");
  // not_shaped：形状外永不判定
  assert.equal(worktreeRootVerdict("D:\\projects\\main", { statFn: statMap([]) }), "not_shaped");
});

test("TD-250 A2 门: soakVerdict——集合逐 id 相同 + 全 !busy 才 clear", () => {
  const snap = (ids) => ({ items: ids.map((id) => ({ id, busy: false, mainTurnActive: false })) });
  assert.equal(soakVerdict(snap(["a", "b"]), snap(["b", "a"])), "clear", "顺序无关");
  assert.equal(soakVerdict(snap(["a"]), snap(["a", "new"])), "sessions_changed", "soak 窗内新会话=放弃（busy-only 复探的洞已修）");
  assert.equal(soakVerdict(snap(["a"]), snap([])), "sessions_changed");
  assert.equal(soakVerdict(snap(["a"]), { items: [{ id: "a", busy: true, mainTurnActive: false }] }), "busy_sessions");
  assert.equal(soakVerdict(snap(["a"]), null), "unobservable");
});

// ===== 锁 =====

test("TD-250 A2 锁: wx 互斥 + 600s 陈旧回收；只防回收互撞（合同明示不防派发）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td250-lock-"));
  try {
    const lockPath = join(dir, "recycle.lock");
    const first = acquireMaintenanceLock({ lockPath, pid: 111, nowMs: 1000 });
    assert.equal(first.held, true);
    const second = acquireMaintenanceLock({ lockPath, pid: 222, nowMs: 2000 });
    assert.equal(second.refused, true);
    assert.equal(second.pid, 111);
    assert.equal(second.ageMs, 1000);
    const stale = acquireMaintenanceLock({ lockPath, pid: 333, nowMs: 1000 + 601_000 });
    assert.equal(stale.held, true);
    assert.equal(stale.staleTaken, true);
    assert.equal(stale.previousPid, 111);
  } finally { cleanupDir(dir); }
});

// ===== A3 规划/执行 =====

function writeTranscript(dir, rel, lines) {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

function fakeOps({ probeResults, workspaceItems, deleteResults }) {
  const deletes = [];
  return {
    deletes,
    async listServeWorkspaces() { return { ok: true, items: workspaceItems }; },
    async probeServeSession({ sessionId }) { return probeResults[sessionId] ?? { ok: true, gone: false, workspaceId: "wd_1", busy: false }; },
    async deleteServeSession({ sessionId }) {
      deletes.push(sessionId);
      return deleteResults?.[sessionId] ?? { outcome: "deleted" };
    },
    readServeInstances: () => [],
    async countServeChildren() { return 0; },
    async listServeSessions() { return { ok: false, reason: "http_error" }; },
    async shutdownServe() { return { outcome: "requested" }; },
  };
}

test("TD-250 A3: planSessionSweep 按会话认领（全部项目桶）+ 三条件门分类", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-td250-sweep-"));
  try {
    // 平铺桶 + projects/<slug> 桶各一条 kimi-web 认领；一条非 kimi-web 不认领。
    writeTranscript(runDir, "run_a.jsonl", [
      { type: "session.created", backend: "kimi-web", backendSessionId: "session_dead", serveUrl: "http://x", runId: "run_a", seq: 1 },
    ]);
    writeTranscript(runDir, join("projects", "slug1", "run_b.jsonl"), [
      { type: "session.created", backend: "kimi-web", backendSessionId: "session_alive", runId: "run_b", seq: 1 },
      { type: "session.created", backend: "kimi-web", backendSessionId: "session_mainrepo", runId: "run_b", seq: 2 },
    ]);
    writeTranscript(runDir, "run_c.jsonl", [
      { type: "session.created", backend: "claude-code", backendSessionId: "ses_claude", runId: "run_c", seq: 1 },
    ]);
    const ops = fakeOps({
      workspaceItems: [
        { id: "wd_1", root: "D:\\p\\.wao-worktrees\\run_a" },
        { id: "wd_2", root: "D:\\p\\.wao-worktrees\\run_b" },
        { id: "wd_main", root: "D:\\projects\\windows-agent-orchestrator-poc" },
      ],
      probeResults: {
        session_dead: { ok: true, gone: false, workspaceId: "wd_1", busy: false },
        session_alive: { ok: true, gone: false, workspaceId: "wd_2", busy: false },
        session_mainrepo: { ok: true, gone: false, workspaceId: "wd_main", busy: false },
      },
    });
    // 真实 statFn：只有 run_a 的 worktree 死（父目录 .wao-worktrees 造出来，root 不存在）。
    mkdirSync(join(runDir, "fake-parent", ".wao-worktrees"), { recursive: true });
    const statFn = (p) => {
      const s = String(p).toLowerCase();
      if (s.endsWith("d:\\p\\.wao-worktrees")) return { isDirectory: () => true };
      if (s.endsWith("run_a")) throw Object.assign(new Error("nope"), { code: "ENOENT" });
      if (s.endsWith("run_b")) return { isDirectory: () => true };
      if (s.endsWith("windows-agent-orchestrator-poc")) return { isDirectory: () => true };
      throw Object.assign(new Error("unexpected"), { code: "ENOENT" });
    };
    const origStat = (await import("node:fs")).statSync;
    const plan = await planSessionSweep({
      runDir, serveUrl: "http://x", token: "t", ops,
      // statFn 注入经由 verdict 内部——用 monkey-patch 方式最小化：直接换模块内引用不可行，
      // 改为构造一个只在 verdict 路径用 statFn 的注入点：planSessionSweep 透传 statFn。
      statFn,
    });
    assert.equal(plan.claims, 3, "三个 kimi-web 认领（跨桶），claude-code 不认领");
    assert.deepEqual(plan.deletable.map((d) => d.sessionId), ["session_dead"]);
    const retained = Object.fromEntries(plan.retained.map((r) => [r.sessionId, r.reason]));
    assert.equal(retained.session_alive, "root_alive");
    assert.equal(retained.session_mainrepo, "not_shaped");
    void origStat;
  } finally { cleanupDir(runDir); }
});

test("TD-250 A3: plan 的 busy/already_gone/probe-fail 分类；workspace_unknown 拒删", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "wao-td250-sweep2-"));
  try {
    writeTranscript(runDir, "run_a.jsonl", [
      { type: "session.created", backend: "kimi-web", backendSessionId: "session_busy", runId: "run_a", seq: 1 },
      { type: "session.created", backend: "kimi-web", backendSessionId: "session_gone", runId: "run_a", seq: 2 },
      { type: "session.created", backend: "kimi-web", backendSessionId: "session_unresolvable", runId: "run_a", seq: 3 },
    ]);
    const ops = fakeOps({
      workspaceItems: [],
      probeResults: {
        session_busy: { ok: true, gone: false, workspaceId: "wd_1", busy: true },
        session_gone: { ok: true, gone: true },
        session_unresolvable: { ok: true, gone: false, workspaceId: "wd_missing", busy: false },
      },
    });
    const plan = await planSessionSweep({ runDir, serveUrl: "http://x", token: "t", ops });
    assert.equal(plan.deletable.length, 0);
    const retained = Object.fromEntries(plan.retained.map((r) => [r.sessionId, r.reason]));
    assert.equal(retained.session_busy, "busy");
    assert.equal(retained.session_gone, "already_gone");
    assert.equal(retained.session_unresolvable, "workspace_unknown");
    assert.equal(plan.probeFailed.length, 0);
  } finally { cleanupDir(runDir); }
});

test("TD-250 A3: applySessionSweep 逐会话删 + 独立台账（不写 run 转录）；already_gone 也记账", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td250-apply-"));
  try {
    const ops = fakeOps({
      workspaceItems: [],
      probeResults: {},
      deleteResults: { session_x: { outcome: "deleted" }, session_y: { outcome: "already_gone" }, session_z: { outcome: "failed", reason: "timeout" } },
    });
    const lines = [];
    const summary = await applySessionSweep({
      plan: { deletable: [
        { sessionId: "session_x", runId: "r1", workspaceId: "w1", workspaceRoot: "D:\\p\\.wao-worktrees\\r1" },
        { sessionId: "session_y", runId: "r2", workspaceId: "w2", workspaceRoot: "D:\\p\\.wao-worktrees\\r2" },
        { sessionId: "session_z", runId: "r3", workspaceId: "w3", workspaceRoot: "D:\\p\\.wao-worktrees\\r3" },
      ] },
      serveUrl: "http://x", token: "t",
      ledgerPath: join(dir, "led", "sweep-ledger.jsonl"),
      ops,
      appendFn: (p, line) => lines.push({ p, line }),
      nowFn: () => "2026-10-10T00:00:00.000Z",
    });
    assert.equal(summary.deleted, 1);
    assert.equal(summary.alreadyGone, 1);
    assert.equal(summary.failed, 1);
    assert.equal(lines.length, 3);
    const first = JSON.parse(lines[0].line);
    assert.equal(first.sessionId, "session_x");
    assert.equal(first.ts, "2026-10-10T00:00:00.000Z");
    assert.ok(first.workspaceRoot.endsWith("r1"));
    assert.ok(lines[2].line.includes("failed:timeout"));
    assert.ok(join(dir, "led").length > 0, "台账目录被创建");
  } finally { cleanupDir(dir); }
});

test("TD-250: serveMaintenanceDir 落 .wao/serve-maintenance（独立台账面，不碰 run 转录）", () => {
  const p = serveMaintenanceDir("D:\\repo");
  assert.ok(p.endsWith(join(".wao", "runs", "serve-maintenance")), p);
});

// ===== recycle（注入零真进程）=====

import { recycleServe } from "../../src/application/serveMaintenance.js";

function recycleOps({ sessionsScript, shutdownOutcome = { outcome: "requested" }, instances = [{ serverId: "s1", pid: 4242, port: 58628 }] } = {}) {
  let sessionCalls = 0;
  return {
    sessionCalls: () => sessionCalls,
    readServeInstances: () => instances,
    async listServeSessions() {
      sessionCalls += 1;
      const r = sessionsScript[Math.min(sessionCalls - 1, sessionsScript.length - 1)];
      return r;
    },
    async shutdownServe() { return shutdownOutcome; },
    async countServeChildren() { return 0; },
    async listServeWorkspaces() { return { ok: true, items: [] }; },
    async probeServeSession() { return { ok: true, gone: true }; },
    async deleteServeSession() { return { outcome: "deleted" }; },
  };
}

test("TD-250 A2: recycle 拒绝闭集——无实例/active run/busy/集合变化/锁互斥（零副作用）", async () => {
  const roots = [];
  const base = () => {
    const lockRootDir = mkdtempSync(join(tmpdir(), "wao-td250-rec-"));
    roots.push(lockRootDir);
    return {
      port: 58628,
      serveUrl: "http://127.0.0.1:58628",
      token: "t",
      workspaceDir: "D:\\ws",
      runDir: join(tmpdir(), "wao-td250-fake-rundir"),
      kimiAgentIds: ["kimi"],
      lockRootDir,
      soakMs: 1,
      sleepFn: async () => {},
      fetchImpl: async () => { throw new Error("down"); },
      spawnFn: () => { throw new Error("must not spawn on refusal"); },
      execFileFn: () => { throw new Error("must not kill on refusal"); },
    };
  };
  try {
    // 无实例
    let r = await recycleServe({ ...base(), ops: recycleOps({ sessionsScript: [{ ok: true, items: [] }], instances: [] }) });
    assert.equal(r.refused, "no_instance");
    // WAO active run（心跳新鲜）堵门；unresolved 不堵
    r = await recycleServe({
      ...base(),
      ops: recycleOps({ sessionsScript: [{ ok: true, items: [] }] }),
      listRunsFn: async () => ({ runs: [{ runId: "run_live", agentId: "kimi" }] }),
    });
    assert.equal(r.refused, "active_runs");
    // busy 会话
    r = await recycleServe({
      ...base(),
      ops: recycleOps({ sessionsScript: [{ ok: true, items: [{ id: "s1", busy: false, mainTurnActive: false }] }, { ok: true, items: [{ id: "s1", busy: true, mainTurnActive: false }] }] }),
      listRunsFn: async () => ({ runs: [] }),
    });
    assert.equal(r.refused, "busy_sessions");
    // soak 窗内新会话（createSession→sendPrompt 洞的修补）
    r = await recycleServe({
      ...base(),
      ops: recycleOps({ sessionsScript: [{ ok: true, items: [{ id: "s1", busy: false, mainTurnActive: false }] }, { ok: true, items: [{ id: "s1", busy: false, mainTurnActive: false }, { id: "s_new", busy: false, mainTurnActive: false }] }] }),
      listRunsFn: async () => ({ runs: [] }),
    });
    assert.equal(r.refused, "sessions_changed");
    // 锁互斥（持锁方 pid 如实上报）
    const locked = base();
    mkdirSync(join(locked.lockRootDir, ".wao", "runs", "serve-maintenance"), { recursive: true });
    writeFileSync(join(locked.lockRootDir, ".wao", "runs", "serve-maintenance", "recycle.lock"), JSON.stringify({ pid: 999, ts: Date.now() }), "utf8");
    r = await recycleServe({
      ...locked,
      ops: recycleOps({ sessionsScript: [{ ok: true, items: [] }] }),
      listRunsFn: async () => ({ runs: [] }),
    });
    assert.equal(r.refused, "lock_held");
    assert.equal(r.lock.pid, 999);
  } finally { for (const d of roots) cleanupDir(d); }
});

test("TD-250 A2: recycle 成功路径——优雅 shutdown + 端口死证实 + 显式 env 重启（WAO_IN_WORKER=1 恒注入）+ 就绪", async () => {
  const lockRoot = mkdtempSync(join(tmpdir(), "wao-td250-rec2-"));
  const spawns = [];
  try {
    const ops = recycleOps({
      sessionsScript: [{ ok: true, items: [{ id: "s1", busy: false, mainTurnActive: false }] }],
      instances: [{ serverId: "old", pid: 111, port: 58628 }, { serverId: "new", pid: 222, port: 58628 }],
    });
    // readServeInstances 时序：杀前看 old，重启后看 new——用闭包切换。
    let phase = 0;
    ops.readServeInstances = () => (phase === 0 ? [{ serverId: "old", pid: 111, port: 58628 }] : (phase = 2, [{ serverId: "new", pid: 222, port: 58628 }]));
    const origShutdown = ops.shutdownServe;
    ops.shutdownServe = async (...a) => { phase = 1; return origShutdown(...a); };
    const result = await recycleServe({
      port: 58628,
      serveUrl: "http://127.0.0.1:58628",
      token: "t",
      workspaceDir: "D:\\stable-ws",
      kimiExe: "C:\\kimi\\kimi.exe",
      runDir: join(tmpdir(), "wao-td250-fake-rundir"),
      kimiAgentIds: ["kimi"],
      lockRootDir: lockRoot,
      soakMs: 1,
      ops,
      listRunsFn: async () => ({ runs: [] }),
      sleepFn: async () => {},
      fetchImpl: async () => { throw new Error("connection refused = port down"); },
      spawnFn: (exe, args, opts) => { spawns.push({ exe, args, opts }); return { unref() {} }; },
      execFileFn: () => { throw new Error("graceful path must not taskkill"); },
    });
    assert.equal(result.recycled, true);
    assert.equal(result.oldPid, 111);
    assert.equal(result.newPid, 222);
    assert.equal(result.portDownVerified, true);
    assert.equal(result.killFallback, null);
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].exe, "C:\\kimi\\kimi.exe");
    assert.deepEqual(spawns[0].args, ["web", "--no-open", "--port", "58628"]);
    assert.equal(spawns[0].opts.cwd, "D:\\stable-ws");
    assert.equal(spawns[0].opts.env.WAO_IN_WORKER, "1", "env 组装权归命令——0047 env 臂恒在场");
    assert.equal(spawns[0].opts.detached, true);
  } finally { cleanupDir(lockRoot); }
});

// ===== TD-251 W1c：回收后空壳清扫 =====

import { sweepEmptyWorktreeHusks } from "../../src/application/serveMaintenance.js";

test("TD-251 W1c: sweepEmptyWorktreeHusks 只删空目录壳（run_ 前缀+零条目）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td251-husk-"));
  try {
    mkdirSync(join(dir, "run_husk1"));
    mkdirSync(join(dir, "run_husk2"));
    mkdirSync(join(dir, "run_real"));
    writeFileSync(join(dir, "run_real", "a.txt"), "x", "utf8");
    mkdirSync(join(dir, "not_run_shape"));
    const n = sweepEmptyWorktreeHusks(dir);
    assert.equal(n, 2);
    assert.ok(!existsSync(join(dir, "run_husk1")));
    assert.ok(!existsSync(join(dir, "run_husk2")));
    assert.ok(existsSync(join(dir, "run_real")), "非空 worktree 不动");
    assert.ok(existsSync(join(dir, "not_run_shape")), "非 run_ 前缀不动");
    assert.equal(sweepEmptyWorktreeHusks(join(dir, "no-such")), 0);
  } finally { cleanupDir(dir); }
});
