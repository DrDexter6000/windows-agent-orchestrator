// test/application/serveReviveAndHusk.test.js
//
// TD-261/262（决定 0063）钉：
//   261a——死实例复活（双面 connection_refused×两探 + pid 死 → 跳杀直接重启；
//          pid 活/混合结果维持拒绝）；
//   261b——重启健壮性（exe 前置解析/候选链/ENOENT 降级/结构化失败+台账+锁释放/
//          workspaceDir 显式校验/CLI 未就绪非零退出的数据面）；
//   262a——已删壳名的转录门控分支回收（交付壳/非终态/无转录/路径不匹配保留；
//          prune 先行）。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  recycleServe as recycleServeImpl,
  resolveKimiExe,
  pickInstanceByPort,
  recycleHuskBranches,
  serveMaintenanceDir,
} from "../../src/application/serveMaintenance.js";

// 启动锁按用例隔离：缺省借用例自己的 lockRootDir。生产缺省是系统临时目录，
// 并行的测试文件用同一端口时会抢同一把锁文件。
const recycleServe = (opts) => recycleServeImpl({ startLockDir: opts.lockRootDir, ...opts });

function cleanupDir(dir) { rmSync(dir, { recursive: true, force: true }); }

function makeRecycleEnv(roots) {
  const root = mkdtempSync(join(tmpdir(), "wao-rec-env-"));
  roots.push(root);
  const wsDir = join(root, "ws");
  mkdirSync(wsDir, { recursive: true });
  const kimiExe = join(root, "kimi.exe");
  writeFileSync(kimiExe, "", "utf8");
  return { workspaceDir: wsDir, kimiExe };
}

function recycleOps({ sessionsScript, archivedScript = null, instances = [{ serverId: "s1", pid: 4242, port: 58628 }] } = {}) {
  let sessionCalls = 0;
  return {
    readServeInstances: () => instances,
    async listServeSessions({ archivedOnly } = {}) {
      if (archivedOnly) return archivedScript ?? { ok: true, items: [] };
      sessionCalls += 1;
      return sessionsScript[Math.min(sessionCalls - 1, sessionsScript.length - 1)];
    },
    async shutdownServe() { return { outcome: "requested" }; },
    async countServeChildren() { return 0; },
  };
}

function makeGitRepo(dir) {
  execSync("git init -q", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "t@t"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "t"', { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "a.txt"), "a\n", "utf8");
  execSync("git add . && git commit -qm init", { cwd: dir, stdio: "ignore" });
}

// ===== resolveKimiExe / pickInstanceByPort =====

test("TD-261b: resolveKimiExe——显式指定执行器缺席即拒不降级；默认链 kimiHome > PATH > homedir", () => {
  const root = mkdtempSync(join(tmpdir(), "wao-261-exe-"));
  try {
    const home = join(root, "kh");
    const homeExe = join(home, "bin", "kimi.exe");
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(homeExe, "", "utf8");
    const hd = join(root, "hd");
    mkdirSync(join(hd, ".kimi-code", "bin"), { recursive: true });
    const hdExe = join(hd, ".kimi-code", "bin", "kimi.exe");
    writeFileSync(hdExe, "", "utf8");
    assert.deepEqual(resolveKimiExe({ kimiExe: homeExe, existsFn: existsSync }), { exe: homeExe, candidates: [homeExe] });
    assert.equal(resolveKimiExe({ kimiExe: join(root, "gone.exe"), existsFn: existsSync }).refused, "kimi_exe_unresolvable",
      "显式缺席不降级（sol 条款）");
    assert.equal(resolveKimiExe({ kimiExe: "kimi", kimiHome: home, env: { PATH: "" }, existsFn: existsSync }).exe, homeExe,
      "kimiHome/bin 优先");
    assert.equal(resolveKimiExe({ kimiExe: "kimi", env: { PATH: "" }, existsFn: existsSync, homeDirFn: () => hd }).exe, hdExe,
      "homedir/.kimi-code/bin 兜底");
    const pathDir = join(root, "pd");
    mkdirSync(pathDir, { recursive: true });
    const pathExe = join(pathDir, "kimi.exe");
    writeFileSync(pathExe, "", "utf8");
    assert.equal(resolveKimiExe({ kimiExe: "kimi", env: { PATH: pathDir }, existsFn: existsSync }).exe, pathExe,
      "PATH 扫描优先于 homedir");
    assert.equal(resolveKimiExe({ kimiExe: "kimi", env: { PATH: "" }, existsFn: () => false }).refused, "kimi_exe_unresolvable");
  } finally { cleanupDir(root); }
});

test("TD-261a: pickInstanceByPort——pid 存活者胜出；无存活取最新心跳；空集 null", () => {
  const live = process.pid;
  assert.equal(pickInstanceByPort([
    { pid: 111, port: 58628, startedAt: 100, heartbeatAt: 900 },
    { pid: live, port: 58628, startedAt: 50, heartbeatAt: 500 },
  ], 58628).pid, live, "复活后新旧 json 并存——存活者胜出");
  assert.equal(pickInstanceByPort([
    { pid: 111, port: 58628, heartbeatAt: 900 },
    { pid: 222, port: 58628, heartbeatAt: 500 },
  ], 58628).pid, 111, "无存活者取最新心跳");
  assert.equal(pickInstanceByPort([], 58628), null);
});

// ===== 261a 复活路径 =====

test("TD-261a: 死实例复活——双面 connection_refused×两探 + pid 死 → 跳过 soak/shutdown 直接重启", async () => {
  const lockRoot = mkdtempSync(join(tmpdir(), "wao-261-rev-"));
  const roots = [lockRoot];
  const spawns = [];
  const shutdowns = [];
  try {
    const env = makeRecycleEnv(roots);
    let listCalls = 0;
    const result = await recycleServe({
      port: 58628, serveUrl: "http://127.0.0.1:58628", token: "t", ...env,
      runDir: join(tmpdir(), "wao-261-fake-rundir"), kimiAgentIds: ["kimi"],
      lockRootDir: lockRoot, soakMs: 1,
      ops: {
        readServeInstances: () => [{ serverId: "stale", pid: 990001, port: 58628, startedAt: 1, heartbeatAt: 2 }],
        async listServeSessions() {
          listCalls += 1;
          // 4 次拒绝（两探×双面），之后（就绪轮询）转 ok
          return listCalls <= 4 ? { ok: false, reason: "connection_refused" } : { ok: true, items: [] };
        },
        async shutdownServe(...a) { shutdowns.push(a); return { outcome: "requested" }; },
        async countServeChildren() { return 0; },
      },
      listRunsFn: async () => ({ runs: [] }),
      sleepFn: async () => {},
      fetchImpl: async () => { throw new Error("down"); },
      spawnFn: (exe, args, opts) => { spawns.push({ exe, args, opts }); return { once() {}, unref() {} }; },
      execFileFn: () => { throw new Error("revive path must not taskkill"); },
    });
    assert.equal(result.recycled, true);
    assert.equal(result.revived, true, "revived 只在 ready 确认后置真（sol 条款）");
    assert.equal(result.ready, true);
    assert.equal(shutdowns.length, 0, "复活路径绝不 shutdown（无可杀者）");
    assert.equal(spawns.length, 1, "直接重启");
    assert.equal(result.killFallback, null);
  } finally { for (const d of roots) cleanupDir(d); }
});

test("TD-261a: pid 活着但端口拒绝 → serve_not_listening_pid_alive（防启动中/端口被抢误判死）", async () => {
  const lockRoot = mkdtempSync(join(tmpdir(), "wao-261-pidalive-"));
  const roots = [lockRoot];
  try {
    const env = makeRecycleEnv(roots);
    const r = await recycleServe({
      port: 58628, serveUrl: "http://127.0.0.1:58628", token: "t", ...env,
      runDir: join(tmpdir(), "wao-261-fake-rundir"), kimiAgentIds: ["kimi"],
      lockRootDir: lockRoot, soakMs: 1,
      ops: {
        readServeInstances: () => [{ serverId: "booting", pid: process.pid, port: 58628, startedAt: 1, heartbeatAt: Date.now() }],
        async listServeSessions() { return { ok: false, reason: "connection_refused" }; },
        async shutdownServe() { throw new Error("must not reach shutdown"); },
        async countServeChildren() { return 0; },
      },
      listRunsFn: async () => ({ runs: [] }),
      sleepFn: async () => {},
      fetchImpl: async () => { throw new Error("down"); },
      spawnFn: () => { throw new Error("must not spawn"); },
      execFileFn: () => { throw new Error("must not kill"); },
    });
    assert.equal(r.refused, "serve_not_listening_pid_alive");
    assert.equal(r.pid, process.pid);
  } finally { for (const d of roots) cleanupDir(d); }
});

test("TD-261a: 混合结果不复活——normal refused / archived 超时 → 维持 serve_unobservable 拒绝", async () => {
  const lockRoot = mkdtempSync(join(tmpdir(), "wao-261-mixed-"));
  const roots = [lockRoot];
  try {
    const env = makeRecycleEnv(roots);
    const r = await recycleServe({
      port: 58628, serveUrl: "http://127.0.0.1:58628", token: "t", ...env,
      runDir: join(tmpdir(), "wao-261-fake-rundir"), kimiAgentIds: ["kimi"],
      lockRootDir: lockRoot, soakMs: 1,
      ops: {
        readServeInstances: () => [{ serverId: "x", pid: 990011, port: 58628, startedAt: 1, heartbeatAt: 2 }],
        async listServeSessions({ archivedOnly }) { return { ok: false, reason: archivedOnly ? "timeout" : "connection_refused" }; },
        async shutdownServe() { throw new Error("must not reach"); },
        async countServeChildren() { return 0; },
      },
      listRunsFn: async () => ({ runs: [] }),
      sleepFn: async () => {},
      fetchImpl: async () => { throw new Error("down"); },
      spawnFn: () => { throw new Error("must not spawn"); },
    });
    assert.equal(r.refused, "serve_unobservable");
    assert.equal(r.reason, "connection_refused");
  } finally { for (const d of roots) cleanupDir(d); }
});

// ===== 261b 重启健壮性 =====

test("TD-261b: 重启全候选 ENOENT → 结构化失败+台账+锁释放（绝不崩、绝不静默留死 serve）", async () => {
  const lockRoot = mkdtempSync(join(tmpdir(), "wao-261-restartfail-"));
  const roots = [lockRoot];
  try {
    const env = makeRecycleEnv(roots);
    const spawns = [];
    const attempt = {
      port: 58628, serveUrl: "http://127.0.0.1:58628", token: "t", ...env,
      runDir: join(tmpdir(), "wao-261-fake-rundir"), kimiAgentIds: ["kimi"],
      lockRootDir: lockRoot, soakMs: 1,
      ops: recycleOps({ sessionsScript: [{ ok: true, items: [] }] }),
      listRunsFn: async () => ({ runs: [] }),
      sleepFn: async () => {},
      fetchImpl: async () => { throw new Error("down"); },
      spawnFn: (exe) => { spawns.push(exe); const e = new Error("spawn kimi ENOENT"); e.code = "ENOENT"; throw e; },
      execFileFn: () => { throw new Error("graceful path must not taskkill"); },
    };
    const r = await recycleServe(attempt);
    assert.equal(r.recycled, false);
    assert.equal(r.restart, "failed");
    assert.equal(r.reason, "kimi_spawn_failed");
    assert.equal(r.errorCode, "ENOENT");
    assert.ok(Array.isArray(r.triedCandidates) && r.triedCandidates.length >= 1);
    assert.match(r.manualRecipe, /docs\/usage\/lanes\.md「kimi 车道的 worker serve」/);
    assert.match(r.note, /no_instance/, "善后态说明：重跑救不回、走手动配方（opus 条款）");
    const ledger = readFileSync(join(serveMaintenanceDir(lockRoot), "recycle-ledger.jsonl"), "utf8").trim().split("\n");
    assert.equal(JSON.parse(ledger[ledger.length - 1]).event, "restart_failed");
    // 锁已释放：立即重跑不再 lock_held
    const r2 = await recycleServe(attempt);
    assert.notEqual(r2.refused, "lock_held", "失败路径必须释放锁");
    assert.equal(r2.restart, "failed");
  } finally { for (const d of roots) cleanupDir(d); }
});

test("TD-261b: 前置校验——workspaceDir 缺席/exe 解析不到 → 零副作用拒绝（不触锁不触探测）", async () => {
  const lockRoot = mkdtempSync(join(tmpdir(), "wao-261-pre-"));
  const roots = [lockRoot];
  try {
    const env = makeRecycleEnv(roots);
    let probed = 0;
    const base = {
      port: 58628, serveUrl: "http://127.0.0.1:58628", token: "t", ...env,
      runDir: join(tmpdir(), "wao-261-fake-rundir"), kimiAgentIds: ["kimi"],
      lockRootDir: lockRoot, soakMs: 1,
      ops: {
        readServeInstances: () => { probed += 1; return [{ serverId: "x", pid: 1, port: 58628 }]; },
        async listServeSessions() { probed += 1; return { ok: true, items: [] }; },
        async shutdownServe() { probed += 1; return { outcome: "requested" }; },
        async countServeChildren() { return 0; },
      },
      listRunsFn: async () => ({ runs: [] }), sleepFn: async () => {},
      fetchImpl: async () => { throw new Error("down"); },
      spawnFn: () => { throw new Error("must not spawn"); },
    };
    const r1 = await recycleServe({ ...base, workspaceDir: join(lockRoot, "gone-ws") });
    assert.equal(r1.refused, "workspace_dir_invalid");
    const r2 = await recycleServe({ ...base, kimiExe: join(lockRoot, "gone-kimi.exe") });
    assert.equal(r2.refused, "kimi_exe_unresolvable");
    assert.equal(probed, 0, "前置校验零副作用");
  } finally { for (const d of roots) cleanupDir(d); }
});

// ===== 262a 壳扫收分支（转录门控） =====

test("TD-262a: recycleHuskBranches 转录门控——只读终态壳回收+台账；交付/非终态/无转录/路径不匹配保留", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-262-husk-"));
  try {
    makeGitRepo(root);
    const runDir = join(root, "runs");
    const bucket = join(runDir, "projects", "wao-262-husk-proj");
    mkdirSync(bucket, { recursive: true });
    const mkTranscript = (runId, { readOnly = true, terminal = true, delivery = false, worktreeBasename = runId } = {}) => {
      const lines = [
        JSON.stringify({ type: "run.started", runId, cwd: root, backend: "claude-code", worktreePath: join(root, ".wao-worktrees", worktreeBasename), ...(delivery ? { delivery: { mode: "git_commit_v1" } } : {}), ts: "2026-10-12T00:00:00.000Z", seq: 1 }),
      ];
      if (readOnly) lines.push(JSON.stringify({ type: "run.read_only_declared", runId, ts: "2026-10-12T00:00:00.100Z", seq: 2 }));
      if (terminal) lines.push(JSON.stringify({ type: "run.state_change", from: "running", to: "failed", reason: "backend_error", runId, ts: "2026-10-12T00:00:01.000Z", seq: 3 }));
      writeFileSync(join(bucket, `${runId}.jsonl`), lines.join("\n") + "\n", "utf8");
    };
    mkTranscript("run_262_ro_ok");
    mkTranscript("run_262_delivery", { delivery: true });
    mkTranscript("run_262_alive", { terminal: false });
    mkTranscript("run_262_mismatch", { worktreeBasename: "run_other" });
    for (const id of ["run_262_ro_ok", "run_262_delivery", "run_262_alive", "run_262_mismatch"]) {
      execSync(`git branch wao/${id}`, { cwd: root, stdio: "ignore" });
    }
    const results = await recycleHuskBranches(
      ["run_262_ro_ok", "run_262_delivery", "run_262_alive", "run_262_mismatch", "run_262_notranscript"],
      { lockRootDir: root, runDir },
    );
    const byId = Object.fromEntries(results.map((r) => [r.runId, r]));
    assert.equal(byId.run_262_ro_ok.outcome, "recycled", "只读终态零独有壳→分支回收");
    assert.match(byId.run_262_ro_ok.tipSha, /^[0-9a-f]{40}$/, "台账带删除前 tipSha（可机器复原——opus 条款）");
    assert.equal(byId.run_262_delivery.reason, "delivery_run", "交付壳分支永不删（0058——sol 反例）");
    assert.equal(byId.run_262_alive.reason, "not_terminal");
    assert.equal(byId.run_262_mismatch.reason, "worktree_path_mismatch");
    assert.equal(byId.run_262_notranscript.reason, "no_transcript");
    execSync("git rev-parse refs/heads/wao/run_262_delivery", { cwd: root, stdio: "ignore" });
    let gone = false;
    try { execSync("git rev-parse refs/heads/wao/run_262_ro_ok", { cwd: root, stdio: "ignore" }); } catch { gone = true; }
    assert.ok(gone, "合格壳分支已物理删除");
    const ledger = readFileSync(join(serveMaintenanceDir(root), "husk-branch-ledger.jsonl"), "utf8").trim().split("\n");
    assert.equal(ledger.length, 5, "逐壳一行台账");
  } finally { cleanupDir(root); }
});

test("TD-262a: git worktree 登记残留 → prune 先行后 -d 可过（opus 待实测点）", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-262-prune-"));
  try {
    makeGitRepo(root);
    const id = "run_262_prune1";
    const wt = join(root, ".wao-worktrees", id);
    execSync(`git worktree add -b wao/${id} "${wt}"`, { cwd: root, stdio: "ignore" });
    const runDir = join(root, "runs");
    const bucket = join(runDir, "projects", "wao-262-prune-proj");
    mkdirSync(bucket, { recursive: true });
    writeFileSync(join(bucket, `${id}.jsonl`), [
      JSON.stringify({ type: "run.started", runId: id, cwd: root, worktreePath: wt, ts: "t", seq: 1 }),
      JSON.stringify({ type: "run.read_only_declared", runId: id, ts: "t", seq: 2 }),
      JSON.stringify({ type: "run.state_change", from: "running", to: "completed", reason: "natural", runId: id, ts: "t", seq: 3 }),
    ].join("\n") + "\n", "utf8");
    // 模拟"壳目录已删、.git/worktrees 登记残留"（W1c 真实形态）。prune 带
    // --expire 判龄（admin index mtime）：刚删的登记仍新鲜，拨到窗外再回收。
    rmSync(wt, { recursive: true, force: true });
    const adminIndex = join(root, ".git", "worktrees", id, "index");
    const aged = new Date(Date.now() - 11 * 60_000);
    utimesSync(adminIndex, aged, aged);
    const results = await recycleHuskBranches([id], { lockRootDir: root, runDir });
    assert.equal(results[0].outcome, "recycled", "prune 先行——登记残留不再让 -d 恒拒（opus 实测点闭合）");
    let gone = false;
    try { execSync(`git rev-parse refs/heads/wao/${id}`, { cwd: root, stdio: "ignore" }); } catch { gone = true; }
    assert.ok(gone);
  } finally { cleanupDir(root); }
});
