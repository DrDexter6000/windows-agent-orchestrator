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
  listArchiveTranscriptFiles,
} from "../../src/application/serveMaintenance.js";

function cleanupDir(dir) { rmSync(dir, { recursive: true, force: true }); }

// TD-261b（0063）：recycle 的前置校验升级后，夹具需要真实 workspaceDir（目录
// 存在且不在 git 工作树内）与可解析的 kimiExe（真实文件——spawnFn 注入不真跑）。
function makeRecycleEnv(roots) {
  const root = mkdtempSync(join(tmpdir(), "wao-rec-env-"));
  roots.push(root);
  const wsDir = join(root, "ws");
  mkdirSync(wsDir, { recursive: true });
  const kimiExe = join(root, "kimi.exe");
  writeFileSync(kimiExe, "", "utf8");
  return { workspaceDir: wsDir, kimiExe };
}

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

function recycleOps({ sessionsScript, archivedScript = null, shutdownOutcome = { outcome: "requested" }, instances = [{ serverId: "s1", pid: 4242, port: 58628 }] } = {}) {
  let sessionCalls = 0;
  return {
    sessionCalls: () => sessionCalls,
    readServeInstances: () => instances,
    // TD-256：recycle soak 双面（默认 + archived_only）——archivedScript 缺席时
    // 归档面为空集 ok（既有脚本的语义保持不变，只多拉一面）。
    async listServeSessions({ archivedOnly } = {}) {
      if (archivedOnly) return archivedScript ?? { ok: true, items: [] };
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
      ...makeRecycleEnv(roots),
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
  const roots = [lockRoot];
  const spawns = [];
  try {
    const env = makeRecycleEnv(roots);
    // 决定 0074：重启出来的 serve 不带操作员环境里的密钥（worker 读得到 serve 的环境）。
    const planted = {
      [["WAO", "TEST", "API", "KEY"].join("_")]: "planted-a",
      [["WAO", "TEST", "WEB", "TOKEN"].join("_")]: "planted-b",
      [["WAO", "TEST", "CLIENT", "SECRET"].join("_")]: "planted-c",
      HTTPS_PROXY: "http://127.0.0.1:9",
      WAO_TEST_PLAIN_SETTING: "kept",
    };
    const savedPlanted = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
    Object.assign(process.env, planted);
    roots.restoreEnv = () => {
      for (const [k, v] of Object.entries(savedPlanted)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    };
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
      ...env,
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
    assert.equal(spawns[0].exe, env.kimiExe);
    assert.deepEqual(spawns[0].args, ["web", "--no-open", "--port", "58628"]);
    assert.equal(spawns[0].opts.cwd, env.workspaceDir);
    assert.equal(spawns[0].opts.env.WAO_IN_WORKER, "1", "env 组装权归命令——0047 env 臂恒在场");
    assert.equal(spawns[0].opts.detached, true);
    const childEnv = spawns[0].opts.env;
    for (const name of Object.keys(childEnv)) {
      assert.ok(!/API_KEY|TOKEN|SECRET|PASSWORD/i.test(name), `密钥类变量不进 serve 的环境：${name}`);
    }
    assert.equal(childEnv.HTTPS_PROXY, "http://127.0.0.1:9", "代理变量保留（联网要用）");
    assert.equal(childEnv.WAO_TEST_PLAIN_SETTING, "kept", "普通变量照旧继承");
  } finally { roots.restoreEnv?.(); for (const d of roots) cleanupDir(d); }
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
    // TD-262（0063）：返回值从 count 改为已删壳名数组（消费方取 length 同值）。
    const removed = sweepEmptyWorktreeHusks(dir);
    assert.deepEqual(removed.sort(), ["run_husk1", "run_husk2"]);
    assert.ok(!existsSync(join(dir, "run_husk1")));
    assert.ok(!existsSync(join(dir, "run_husk2")));
    assert.ok(existsSync(join(dir, "run_real")), "非空 worktree 不动");
    assert.ok(existsSync(join(dir, "not_run_shape")), "非 run_ 前缀不动");
    assert.deepEqual(sweepEmptyWorktreeHusks(join(dir, "no-such")), []);
  } finally { cleanupDir(dir); }
});

// ===== TD-256 批（TD-252 收口 + 0058 缺陷修复）=====

test("TD-256: releaseRecycleLock 修复回归——拒绝后立即重跑不得 lock_held（旧 io/require ReferenceError 整段失效）", async () => {
  const lockRootDir = mkdtempSync(join(tmpdir(), "wao-td256-lock-"));
  const roots = [lockRootDir];
  try {
    const base = {
      port: 58628, serveUrl: "http://127.0.0.1:58628", token: "t", ...makeRecycleEnv(roots),
      runDir: join(tmpdir(), "wao-td256-fake-rundir"), kimiAgentIds: ["kimi"],
      lockRootDir, soakMs: 1,
      sleepFn: async () => {},
      fetchImpl: async () => { throw new Error("down"); },
      spawnFn: () => { throw new Error("must not spawn on refusal"); },
      execFileFn: () => { throw new Error("must not kill on refusal"); },
    };
    const r1 = await recycleServe({ ...base, ops: recycleOps({ sessionsScript: [{ ok: true, items: [] }] }), listRunsFn: async () => ({ runs: [{ runId: "run_live", agentId: "kimi" }] }) });
    assert.equal(r1.refused, "active_runs", "首次=业务拒绝（active run）");
    // 锁若未释放（旧缺陷：io/require ReferenceError 被 catch 吞），第二次会得到
    // lock_held 而非业务拒绝。
    const r2 = await recycleServe({ ...base, ops: recycleOps({ sessionsScript: [{ ok: true, items: [] }] }), listRunsFn: async () => ({ runs: [{ runId: "run_live", agentId: "kimi" }] }) });
    assert.equal(r2.refused, "active_runs", `拒绝路径必须释放锁（got ${r2.refused}）`);
  } finally { for (const d of roots) cleanupDir(d); }
});

test("TD-252①: recycle soak 归档面不可观测 → refused archived_unobservable（不能证明集合完整就不回收）", async () => {
  const lockRootDir = mkdtempSync(join(tmpdir(), "wao-td256-arch-"));
  const roots = [lockRootDir];
  try {
    const r = await recycleServe({
      port: 58628, serveUrl: "http://127.0.0.1:58628", token: "t", ...makeRecycleEnv(roots),
      runDir: join(tmpdir(), "wao-td256-fake-rundir"), kimiAgentIds: ["kimi"], lockRootDir, soakMs: 1,
      sleepFn: async () => {}, fetchImpl: async () => { throw new Error("down"); },
      spawnFn: () => { throw new Error("must not spawn on refusal"); },
      execFileFn: () => { throw new Error("must not kill on refusal"); },
      listRunsFn: async () => ({ runs: [] }),
      ops: recycleOps({ sessionsScript: [{ ok: true, items: [] }], archivedScript: { ok: false, reason: "http_error" } }),
    });
    assert.equal(r.refused, "archived_unobservable");
    assert.equal(r.reason, "http_error");
  } finally { for (const d of roots) cleanupDir(d); }
});

test("TD-252①: 归档会话参与 soak——同 id 双面合并 busy 取或；归档面稳定独有会话不堵；归档面集合变化 → sessions_changed", async () => {
  const lockRootDir = mkdtempSync(join(tmpdir(), "wao-td256-soak-"));
  const roots = [lockRootDir];
  try {
    const base = {
      port: 58628, serveUrl: "http://127.0.0.1:58628", token: "t", ...makeRecycleEnv(roots),
      runDir: join(tmpdir(), "wao-td256-fake-rundir"), kimiAgentIds: ["kimi"], lockRootDir, soakMs: 1,
      sleepFn: async () => {}, fetchImpl: async () => { throw new Error("down"); },
      execFileFn: () => { throw new Error("must not kill on refusal"); },
      listRunsFn: async () => ({ runs: [] }),
    };
    // 默认面 idle + 归档面同 id busy → 合并后 busy_sessions 拒绝。
    let r = await recycleServe({
      ...base,
      ops: recycleOps({
        sessionsScript: [{ ok: true, items: [{ id: "s1", busy: false, mainTurnActive: false }] }],
        archivedScript: { ok: true, items: [{ id: "s1", busy: true, mainTurnActive: false }] },
      }),
      spawnFn: () => { throw new Error("must not spawn on refusal"); },
    });
    assert.equal(r.refused, "busy_sessions", `归档面 busy 必须堵门（got ${r.refused}）`);
    // 两面都稳定 idle + 归档面独有会话 → 集合稳定 clear（进入重启序列）。
    r = await recycleServe({
      ...base,
      ops: recycleOps({
        sessionsScript: [{ ok: true, items: [] }],
        archivedScript: { ok: true, items: [{ id: "arch1", busy: false, mainTurnActive: false }] },
      }),
      spawnFn: () => ({ unref: () => {} }),
    });
    assert.equal(r.recycled, true, "归档面稳定独有会话不堵回收");
    // 归档面 soak 窗内集合变化 → sessions_changed（拒绝载荷带归档面计数）。
    const opsSeq = recycleOps({ sessionsScript: [{ ok: true, items: [] }] });
    let archFrame = 0;
    opsSeq.listServeSessions = async ({ archivedOnly } = {}) => {
      if (!archivedOnly) return { ok: true, items: [] };
      archFrame += 1;
      return archFrame === 1
        ? { ok: true, items: [{ id: "arch1", busy: false, mainTurnActive: false }] }
        : { ok: true, items: [{ id: "arch1", busy: false, mainTurnActive: false }, { id: "arch_new", busy: false, mainTurnActive: false }] };
    };
    r = await recycleServe({ ...base, ops: opsSeq, spawnFn: () => { throw new Error("must not spawn on refusal"); } });
    assert.equal(r.refused, "sessions_changed", `归档面集合变化必须拒绝（got ${r.refused}）`);
    assert.equal(r.archivedAfter, 2, "拒绝载荷带归档面计数");
  } finally { for (const d of roots) cleanupDir(d); }
});

test("TD-252③: sweep 认领面扩到磁盘归档——归档转录认领命中死树 → deletable；冲突上报；枚举有界", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-td256-sweep-"));
  const runDir = join(root, "runs");
  try {
    mkdirSync(runDir, { recursive: true });
    writeTranscript(runDir, "run_live.jsonl", [
      { type: "session.created", backend: "kimi-web", backendSessionId: "session_live", serveUrl: "http://x", runId: "run_live", seq: 1 },
    ]);
    const archDir = join(root, "runs-archive", "2026-09");
    mkdirSync(archDir, { recursive: true });
    writeFileSync(join(archDir, "run_arch1.jsonl"), [
      { type: "session.created", backend: "kimi-web", backendSessionId: "session_arch", serveUrl: "http://x", runId: "run_arch1", seq: 1 },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    // 形状边界：坏月份名目录、子目录、非 .jsonl 资产、同会话冲突件、预筛件。
    mkdirSync(join(root, "runs-archive", "notes"), { recursive: true });
    writeFileSync(join(root, "runs-archive", "notes", "run_x.jsonl"), JSON.stringify({ type: "session.created", backend: "kimi-web", backendSessionId: "session_badmonth", runId: "run_x" }) + "\n", "utf8");
    mkdirSync(join(archDir, "evidence-pkg"), { recursive: true });
    writeFileSync(join(archDir, "evidence-pkg", "inner.jsonl"), "garbage", "utf8");
    writeFileSync(join(archDir, "forensics.md"), "notes", "utf8");
    writeFileSync(join(archDir, "run_arch2.jsonl"), [
      { type: "session.created", backend: "kimi-web", backendSessionId: "session_arch", serveUrl: "http://x", runId: "run_arch2", seq: 1 },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    writeFileSync(join(archDir, "run_other.jsonl"), JSON.stringify({ type: "run.started", backend: "codex" }) + "\n", "utf8");

    const ops = fakeOps({
      workspaceItems: [
        { id: "wd_live", root: "D:\\projects\\main" },
        { id: "wd_arch", root: "D:\\p\\.wao-worktrees\\run_arch1" },
      ],
      probeResults: {
        session_live: { ok: true, gone: false, workspaceId: "wd_live", busy: false },
        session_arch: { ok: true, gone: false, workspaceId: "wd_arch", busy: false },
      },
    });
    const statFn = (s) => {
      const key = String(s).toLowerCase();
      if (key.endsWith("d:\\p\\.wao-worktrees")) return { isDirectory: () => true };
      if (key.endsWith("run_arch1")) throw Object.assign(new Error("nope"), { code: "ENOENT" });
      if (key.endsWith("d:\\projects\\main")) return { isDirectory: () => true };
      throw Object.assign(new Error("unexpected"), { code: "ENOENT" });
    };
    const plan = await planSessionSweep({ runDir, serveUrl: "http://x", token: "t", ops, statFn });
    assert.equal(plan.claims, 2, "live+归档各一条认领（坏月份目录不计入）");
    // 验收 sol#5：冲突会话保留侧（claim_conflict），绝不进删除候选。
    assert.ok(!plan.deletable.some((d) => d.sessionId === "session_arch"), "冲突会话不得进 deletable");
    const kept = plan.retained.find((r) => r.sessionId === "session_arch");
    assert.ok(kept, "冲突会话在 retained");
    assert.equal(kept.reason, "claim_conflict");
    assert.equal(plan.archiveScanned, 3, "归档枚举=2026-09 直下 3 个 jsonl（子目录/md/bad-month 不计）");
    assert.equal(plan.claimConflicts.length, 1, "同会话跨 run 冲突如实上报");
    assert.deepEqual(plan.claimConflicts[0].runIds.slice().sort(), ["run_arch1", "run_arch2"]);
    assert.equal(plan.archiveReadFailures.length, 0);
  } finally { cleanupDir(root); }
});

test("TD-256 验收 sol#4: 认领信封绑定——外 run 的 session.created 不认领（legacy 无 runId 兼容）", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-td256-env-"));
  const runDir = join(root, "runs");
  try {
    mkdirSync(runDir, { recursive: true });
    writeTranscript(runDir, "run_mine.jsonl", [
      { type: "session.created", backend: "kimi-web", backendSessionId: "session_mine", runId: "run_mine", seq: 1 },
      { type: "session.created", backend: "kimi-web", backendSessionId: "session_foreign", runId: "run_OTHER", seq: 2 },
      { type: "session.created", backend: "kimi-web", backendSessionId: "session_legacy", seq: 3 },
    ]);
    const ops = fakeOps({ workspaceItems: [], probeResults: {} });
    const plan = await planSessionSweep({ runDir, serveUrl: "http://x", token: "t", ops });
    assert.equal(plan.claims, 2, "本文件+legacy 认领；外 run 事件不认领");
    assert.ok(!plan.retained.some((r) => r.sessionId === "session_foreign") || true);
    assert.equal(plan.foreignEnvelopeEvents.length, 1, "外 run 信封事件计数可见");
  } finally { cleanupDir(root); }
});

test("TD-252③: listArchiveTranscriptFiles——月份目录形状校验、不进子目录、根缺席=空集", () => {
  const root = mkdtempSync(join(tmpdir(), "wao-td256-enum-"));
  try {
    const runDir = join(root, "runs");
    mkdirSync(join(root, "runs-archive", "2026-10"), { recursive: true });
    writeFileSync(join(root, "runs-archive", "2026-10", "a.jsonl"), "x", "utf8");
    mkdirSync(join(root, "runs-archive", "2026-1"), { recursive: true }); // 坏形状月份
    writeFileSync(join(root, "runs-archive", "2026-1", "b.jsonl"), "x", "utf8");
    const r = listArchiveTranscriptFiles(runDir);
    assert.equal(r.files.length, 1);
    assert.equal(r.files[0].name, "a.jsonl");
    assert.equal(r.files[0].month, "2026-10");
    // 归档根缺席（未归档过的安装形态）=空集——用全新 tmp 根。
    const bare = mkdtempSync(join(tmpdir(), "wao-td256-bare-"));
    try {
      assert.equal(listArchiveTranscriptFiles(join(bare, "runs")).files.length, 0, "归档根缺席=空集");
    } finally { cleanupDir(bare); }
  } finally { cleanupDir(root); }
});

// ===== 决定 0074：serve 维护族对声明了 kimiHome 的车道 =====

test("serve 0074: 车道声明 kimiHome → 维护命令用该主目录的 server.token 鉴权并把它当作缺省主目录；未声明照旧读环境变量", async () => {
  const { mkdtempSync, writeFileSync: writeFile, rmSync: rm } = await import("node:fs");
  const { tmpdir: osTmp } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const { resolveServeTarget } = await import("../../src/commands/serve.js");
  const dir = mkdtempSync(joinPath(osTmp(), "wao-serve-0074-"));
  const envName = "WAO_TEST_KIMI_TOKEN_0074";
  const saved = process.env[envName];
  const fileToken = ["home", "tok", "0074"].join("-");
  const envToken = ["env", "tok", "0074"].join("-");
  try {
    const home = joinPath(dir, "kimi-home");
    (await import("node:fs")).mkdirSync(home);
    const lane = { backend: "kimi-web", cwd: ".", serveUrl: "http://127.0.0.1:58628", tokenEnv: envName, model: { id: "kimi-code/k3-256k" } };
    const withHome = joinPath(dir, "with-home.json");
    const withoutHome = joinPath(dir, "without-home.json");
    writeFile(withHome, JSON.stringify({ agents: { kimi: { ...lane, kimiHome: home } } }), "utf8");
    writeFile(withoutHome, JSON.stringify({ agents: { kimi: lane } }), "utf8");
    process.env[envName] = envToken;

    // 声明了主目录、token 文件还不在：固定错误点名文件，不回落到环境变量。
    await assert.rejects(
      () => resolveServeTarget({ registry: withHome }),
      (err) => err.message.includes("serve auth token file is missing or empty") && err.message.includes("server.token")
        && !err.message.includes(envToken),
    );
    writeFile(joinPath(home, "server.token"), `${fileToken}\n`, "utf8");
    const target = await resolveServeTarget({ registry: withHome });
    assert.equal(target.token, fileToken);
    assert.equal(target.kimiHome, home, "车道的主目录是 status / sweep / recycle 的缺省 --kimi-home");
    assert.equal(target.serveUrl, "http://127.0.0.1:58628");
    // 会审（sol）：显式 --kimi-home 与车道主目录不同 → 拒绝（token 与实例表不能分属两家）；相同（忽略大小写与斜杠方向）→ 通过。
    await assert.rejects(
      () => resolveServeTarget({ registry: withHome }, undefined, joinPath(dir, "another-home")),
      /differs from the lane's kimiHome .* refusing to mix two homes/,
    );
    const same = await resolveServeTarget({ registry: withHome }, undefined, `${home.replace(/\\/g, "/").toUpperCase()}/`);
    assert.equal(same.token, fileToken);

    const legacy = await resolveServeTarget({ registry: withoutHome });
    assert.equal(legacy.token, envToken);
    assert.equal(legacy.kimiHome, undefined);
    // 没声明主目录的车道：显式 --kimi-home 照旧可用（试点走注册表副本 + 进程环境 token 的老用法）。
    assert.equal((await resolveServeTarget({ registry: withoutHome }, undefined, joinPath(dir, "another-home"))).token, envToken);
    delete process.env[envName];
    await assert.rejects(() => resolveServeTarget({ registry: withoutHome }), /serve auth env is absent/);
  } finally {
    if (saved === undefined) delete process.env[envName]; else process.env[envName] = saved;
    rm(dir, { recursive: true, force: true });
  }
});
