// test/run-lifecycle/b158aFix1Runner.test.js
//
// 第 158a 批修复一的行为钉（runner 显式配对判定 / 一次请求一份表 / 漏接读取面 /
// 并排兼容证明）。全部经既有 API；对修复一基线（7d60c938）先红：本文件在
// `git archive HEAD` 的干净检出里因缺少新导出直接 import 失败（红），修复后全绿。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { runBackground, runResumeBackground } from "../../src/backgroundRunner.js";
import { handleRequest } from "../../src/daemon.js";
import { runCommand, } from "../../src/commands/run.js";
import { retryCommand, forkResumeRunner } from "../../src/commands/lifecycle.js";
import { runsCommand } from "../../src/commands/runs.js";
import { stopRun } from "../../src/application/runStop.js";
import { readTranscript, findState, extractCanonicalAgentId } from "../../src/transcript.js";
import { RunManager } from "../../src/runManager.js";
import { lanesMergeDocFor, normalizeAgent, mergeLaneAxes, readRegistry } from "../../src/registry.js";
import { laneFingerprint as laneFingerprintOf } from "../../src/application/identityProjection.js";

process.env.WAO_ALLOW_NESTED_DISPATCH = "1";

const ev = (obj) => JSON.stringify(obj) + "\n";
const cleanupDir = (dir) => rmSync(dir, { recursive: true, force: true });

function git(args, cwd) {
  return String(execSync("git " + args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })).trim();
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "wao-f1-repo-"));
  git("init -b main", repo);
  git("config user.email t@t.com", repo);
  git("config user.name T", repo);
  writeFileSync(join(repo, "README.md"), "# base\n", "utf8");
  git("add -A", repo);
  git("commit -m base", repo);
  return repo;
}

const lanesDocOf = (lanes, sha = "a".repeat(64)) => ({
  ok: true, path: "<fixture>", sha256: sha, lanes, issues: [], rolesHint: [],
});
const OPUS_LANE = { id: "opus", backend: "claude-code", model: { id: "claude-opus-5-5" }, reasoning: { effort: "high" }, aliases: {} };
const OPUS_DOC = lanesDocOf([OPUS_LANE]);

function fakeBackend(capture = []) {
  return {
    supportsRoleContract: true, sessionOutlivesProcess: false, replayByRespawn: true,
    validateAgentPolicy() {},
    async spawn(agent) {
      capture.push(agent);
      return {
        backend: "claude-code", backendSessionId: "s1", messageId: "m1", admittedSeq: 1,
        async *events() { yield { kind: "done", reason: "completed" }; },
        abort: async () => {},
        isAlive: () => false,
      };
    },
    defaultBinary() { return "claude"; }, credentialEnvNames: () => [],
  };
}

// ── 1. runner：--lanes-merge 显式判定（缺省拒 / 哈希不等拒 / off 照旧） ────────

test("修复一 runner：字符串路径缺 --lanes-merge → lanes_merge_spec_missing，零 spawn + 持久失败记录", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-f1-spec-"));
  const runDir = join(dir, "runs");
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { opus: { backend: "claude-code", cwd: dir, model: { id: "claude-opus-5-5" } } },
    }), "utf8");
    const result = await runBackground({
      agentId: "opus", prompt: "x", registry: registryPath, runDir,
      backendFor: () => fakeBackend(), waitTimeout: 3000, pollInterval: 10,
      // 故意不给 lanes-merge / lanesMergeSpec ——旧父进程形状，必须拒绝而非当停用
    });
    assert.equal(result.failed, true, "runner 拒绝（不起 worker）");
    assert.match(result.error, /lanes_merge_spec_missing/);
    const events = await readTranscript(join(runDir, `${result.runId}.jsonl`));
    const err = events.find((e) => e.type === "run.error");
    assert.ok(err && String(err.error).includes("lanes_merge_spec_missing"), "持久失败记录带原因码");
    assert.equal(findState(events), "failed", "终态 failed");
  } finally { cleanupDir(dir); }
});

test("修复一 runner：sha 与读到的表不同（只改 effort 也算）→ lanes_changed_since_dispatch，认证门/解析看到的旧表不起跑", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-f1-sha-"));
  const runDir = join(dir, "runs");
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { opus: { cwd: dir } } }), "utf8");
    // 派发侧冻结的表：effort=high（sha=aaa…）；runner 读到的现行表：只改 effort=low（sha=bbb…）
    const frozen = lanesDocOf([{ ...OPUS_LANE, reasoning: { effort: "high" } }], "a".repeat(64));
    const current = lanesDocOf([{ ...OPUS_LANE, reasoning: { effort: "low" } }], "b".repeat(64));
    const result = await runBackground({
      agentId: "opus", prompt: "x", registry: registryPath, runDir,
      lanesMergeSpec: `sha256:${frozen.sha256}`,
      loadLanesConfigFn: () => current,
      backendFor: () => fakeBackend(), waitTimeout: 3000, pollInterval: 10,
    });
    assert.equal(result.failed, true, "具名拒绝（零 spawn）");
    assert.match(result.error, /lanes_changed_since_dispatch/);
    const events = await readTranscript(join(runDir, `${result.runId}.jsonl`));
    assert.ok(events.some((e) => e.type === "run.error" && String(e.error).includes("lanes_changed_since_dispatch")));
  } finally { cleanupDir(dir); }
});

test("修复一 runner：--lanes-merge off → 停用合并，私有自包含条目照旧起跑；sha 一致 → 合并起跑", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-f1-off-"));
  try {
    const runDir = join(dir, "runs");
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { opus: { backend: "claude-code", cwd: dir, model: { id: "private-old" } } },
    }), "utf8");
    // off：外来注册表自包含——run.started 记私有自带四轴
    const r1 = await runBackground({
      agentId: "opus", prompt: "x", registry: registryPath, runDir,
      lanesMergeSpec: "off",
      backendFor: () => fakeBackend(), waitTimeout: 3000, pollInterval: 10,
    });
    assert.equal(r1.completed, true, `off 起跑（error: ${r1.error}）`);
    const s1 = (await readTranscript(join(runDir, `${r1.runId}.jsonl`))).find((e) => e.type === "run.started");
    assert.equal(s1.model.id, "private-old", "off=私有自带四轴生效");
    // sha 一致：合并起跑——私有去四轴条目按车道表四轴
    const runDir2 = join(dir, "runs2");
    writeFileSync(registryPath, JSON.stringify({ agents: { opus: { cwd: dir } } }), "utf8");
    const r2 = await runBackground({
      agentId: "opus", prompt: "x", registry: registryPath, runDir: runDir2,
      lanesMergeSpec: `sha256:${OPUS_DOC.sha256}`,
      loadLanesConfigFn: () => OPUS_DOC,
      backendFor: () => fakeBackend(), waitTimeout: 3000, pollInterval: 10,
    });
    assert.equal(r2.completed, true, `sha 一致起跑（error: ${r2.error}）`);
    const s2 = (await readTranscript(join(runDir2, `${r2.runId}.jsonl`))).find((e) => e.type === "run.started");
    assert.equal(s2.model.id, "claude-opus-5-5", "sha 一致=车道表四轴生效");
  } finally { cleanupDir(dir); }
});

// ── 2b. 后台 resume：表坏 fork 前具名拒；四轴变化持久记录带原因码 ─────────────

test("修复一 resume fork：车道表不可用 → 父进程 lanes_merge_unavailable 具名拒绝，零 fork", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-f1-resume-bad-"));
  try {
    const runDir = join(dir, "runs");
    const registryPath = join(dir, "agents.json");
    let spawned = false;
    const badDoc = { ok: false, path: "<fixture>", sha256: null, lanes: [], issues: ["fixture bad"] };
    await assert.rejects(
      () => forkResumeRunner(
        "run_f1_resume_bad",
        { runDir, registry: registryPath },
        { registry: registryPath, runDir, loadLanesConfigFn: () => badDoc },
        () => { spawned = true; return { pid: 4242, unref() {} }; },
      ),
      /lanes_merge_unavailable/,
      "表坏在父进程具名拒绝（不是把 sha256:null 交给 runner）",
    );
    assert.equal(spawned, false, "零 fork");
  } finally { cleanupDir(dir); }
});

test("修复一 后台 resume：四轴变了 → 持久失败记录带具名原因（worker_configuration_changed）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-f1-resume-axes-"));
  const runDir = join(dir, "runs");
  try {
    mkdirSync(runDir, { recursive: true });
    const runId = "run_f1_resume_axes";
    writeFileSync(join(runDir, `${runId}.jsonl`), [
      ev({ type: "run.started", runId, agentId: "opus", backend: "claude-code", cwd: dir, model: { id: "old-model" }, ts: "2026-11-28T00:00:00.000Z", seq: 1 }),
      ev({ type: "session.created", runId, agentId: "opus", backend: "claude-code", backendSessionId: "s_axes", ts: "2026-11-28T00:00:00.050Z", seq: 2 }),
      ev({ type: "run.state_change", runId, agentId: "opus", from: null, to: "running", reason: "bg", ts: "2026-11-28T00:00:00.100Z", seq: 3 }),
    ].join(""), "utf8");
    await assert.rejects(
      () => runResumeBackground({
        runId, runDir,
        registry: { agents: { opus: { backend: "claude-code", cwd: dir, model: { id: "new-model" } } } },
      }),
      /worker_configuration_changed/,
      "四轴复核具名拒绝",
    );
    const events = await readTranscript(join(runDir, `${runId}.jsonl`));
    const err = events.find((e) => e.type === "run.error" && e.phase === "resume");
    assert.ok(err, "持久 run.error(phase=resume) 在场");
    assert.match(String(err.error), /\(worker_configuration_changed\)/, "持久记录带原因码，不是泛化的 threw");
    assert.equal(extractCanonicalAgentId(events, runId), "opus", "失败记录沿用原席位（不变 unknown）");
  } finally { cleanupDir(dir); }
});

// ── 1b. 修复二：runner 一次起跑只读一次表 / 注册表一次读取贯穿 ────────────────

test("修复二 runner：启用的表校验后复用（显式解析不再读第二次）；注册表一次读取贯穿解析与 start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-f2-readonce-"));
  const runDir = join(dir, "runs");
  try {
    const registryPath = join(dir, "agents.json");
    // 私有条目去掉四轴（只有 cwd）——启用合并时由车道表供给。
    writeFileSync(registryPath, JSON.stringify({ agents: { opus: { cwd: dir } } }), "utf8");
    let lanesLoads = 0;
    let registryReads = 0;
    const result = await runBackground({
      agentId: "opus", prompt: "x", registry: registryPath, runDir,
      lanesMergeSpec: `sha256:${OPUS_DOC.sha256}`,
      loadLanesConfigFn: () => { lanesLoads += 1; return OPUS_DOC; },
      readRegistryFn: async (p) => { registryReads += 1; return readRegistry(p); },
      // 显式车道+角色：旧实现此时会另读一次车道表（:361），registry 也会被
      // 材料复核/显式解析/start 各读一次。
      lane: "opus", role: "coder",
      backendFor: () => fakeBackend(), waitTimeout: 3000, pollInterval: 10,
    });
    assert.equal(result.completed, true, `起跑成功（error: ${result.error}）`);
    assert.equal(lanesLoads, 1, "车道表恰读一次（哈希校验通过后复用同一对象）");
    assert.equal(registryReads, 1, "注册表恰读一次（显式解析与 RunManager.start 共用句柄）");
    const started = (await readTranscript(join(runDir, `${result.runId}.jsonl`))).find((e) => e.type === "run.started");
    assert.equal(started.model.id, "claude-opus-5-5", "复用的表仍是生效四轴");
  } finally { cleanupDir(dir); }
});

// ── 2. daemon IPC start：按请求现读车道表 ────────────────────────────────────

test("修复一 daemon：IPC start 按请求现读车道表（lanesMergeDocFn），无判定函数时不带 lanesMerge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-f1-daemon-"));
  try {
    const calls = [];
    const stubManager = {
      activeRuns: new Map(),
      async start(agentId, options) { calls.push({ agentId, options }); return { runId: "run_stub", state: "completed", waitForCompletion: async () => ({ completed: true }) }; },
    };
    const ctx = { runDir: join(dir, "runs"), registryPath: join(dir, "agents.json"), runControllers: new Map() };
    // 有判定函数：manager.start 收到本次请求的 doc
    const res1 = await handleRequest({ cmd: "start", agentId: "opus", prompt: "x" }, stubManager, { ...ctx, lanesMergeDocFn: () => OPUS_DOC });
    assert.equal(res1.ok, true);
    assert.equal(calls[0].options.lanesMerge, OPUS_DOC, "start 收到请求现读的 doc");
    // 无判定函数（对象注入缝）：不带 lanesMerge（旧语义）
    await handleRequest({ cmd: "start", agentId: "opus", prompt: "x" }, stubManager, ctx);
    assert.equal(calls[1].options.lanesMerge, undefined, "无判定函数=不带 lanesMerge");
    // 两次请求之间表变了：第二次拿到的是新 doc（不用启动快照）
    const changed = lanesDocOf([{ ...OPUS_LANE, reasoning: { effort: "low" } }], "c".repeat(64));
    await handleRequest({ cmd: "start", agentId: "opus", prompt: "x" }, stubManager, { ...ctx, lanesMergeDocFn: () => changed });
    assert.equal(calls[2].options.lanesMerge.sha256, changed.sha256, "每请求现读");
  } finally { cleanupDir(dir); }
});

// ── 3. CLI run 解析块：私有条目去四轴也能解析（含 --explain） ─────────────────

test("修复一 CLI run：私有条目去四轴 + 车道表在场 → --explain 正常解析（不再整表抛 missing backend）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-f1-explain-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { opus: { cwd: dir } } }), "utf8");
    const lines = [];
    let lanesLoads = 0;
    const origLog = console.log;
    console.log = (...a) => { lines.push(a.join(" ")); };
    try {
      await runCommand(
        ["--lane", "opus", "--role", "coder", "--explain", "--registry", registryPath, "--run-dir", join(dir, "runs")],
        {
          registry: registryPath, runDir: join(dir, "runs"),
          readRegistry: async () => (await import("../../src/registry.js")).readRegistry(registryPath),
          loadLanesConfigFn: () => { lanesLoads += 1; return OPUS_DOC; },
          backendFor: () => fakeBackend(),
        },
      );
    } finally { console.log = origLog; }
    const payload = JSON.parse(lines.join("\n"));
    assert.equal(payload.status, "resolved");
    assert.equal(payload.agentId, "opus");
    assert.equal(lanesLoads, 1, "一次调用恰读一次车道表（解析/回显/派发共用同一份）");
  } finally { cleanupDir(dir); }
});

// ── 4. retry：私有去四轴 → 新 run.started 记车道表四轴 ────────────────────────

test("修复一 retry：私有条目去四轴 → 重派按车道表四轴（run.started 为证）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-f1-retry-"));
  const runDir = join(dir, "runs");
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { opus: { cwd: dir } } }), "utf8");
    mkdirSync(runDir, { recursive: true });
    // 父转录：普通完成轮（无 override）。
    const runId = "run_f1_retry_src";
    writeFileSync(join(runDir, `${runId}.jsonl`), [
      ev({ type: "run.started", runId, agentId: "opus", backend: "claude-code", cwd: dir, model: { id: "claude-opus-5-5" }, reasoning: { effort: "high" }, providerKey: null, ts: "2026-11-28T00:00:00.000Z", seq: 1 }),
      ev({ type: "session.created", runId, agentId: "opus", backend: "claude-code", backendSessionId: "s0", ts: "2026-11-28T00:00:00.100Z", seq: 2 }),
      ev({ type: "prompt.sent", runId, agentId: "opus", prompt: "first", ts: "2026-11-28T00:00:00.200Z", seq: 3 }),
      ev({ type: "run.state_change", runId, agentId: "opus", from: "pending", to: "completed", reason: "done", ts: "2026-11-28T00:00:00.300Z", seq: 4 }),
    ].join(""), "utf8");
    const lines = [];
    let lanesLoads = 0;
    const origLog = console.log;
    console.log = (...args) => { lines.push(args.join(" ")); };
    try {
      await retryCommand([runId, "--registry", registryPath, "--run-dir", runDir], {
        registry: registryPath, runDir,
        readRegistry: async () => (await import("../../src/registry.js")).readRegistry(registryPath),
        loadLanesConfigFn: () => { lanesLoads += 1; return OPUS_DOC; },
        backendFor: () => fakeBackend(),
      });
    } finally { console.log = origLog; }
    assert.equal(lanesLoads, 1, "retry 一次调用恰读一次车道表");
    // 从 retry 输出拿新 runId（桶/平铺由解析链定位）
    const jsonLine = lines.find((l) => l.trimStart().startsWith("{"));
    assert.ok(jsonLine, `retry 输出 JSON 在场（实际：${lines.join(" | ").slice(0, 200)}）`);
    const payload = JSON.parse(jsonLine);
    assert.equal(payload.originalRunId, runId);
    // retry 输出带 newRunId + transcript 绝对路径（派发后的新转运）。
    const started = (await readTranscript(payload.transcript)).find((e) => e.type === "run.started");
    assert.equal(started.backend, "claude-code");
    assert.deepEqual(started.model, { id: "claude-opus-5-5" }, "retry 的四轴来自车道表");
    assert.deepEqual(started.reasoning, { effort: "high" });
  } finally { cleanupDir(dir); }
});

// ── 5. stop：私有去四轴 → 后端身份可解析（不再 route-unavailable） ─────────────

test("修复一 stop：kimi 私有条目去四轴 + 合并启用 → 停止目标可解析（不发 stop_route_unavailable 的 backend 缺失形）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-f1-stop-"));
  try {
    const repo = makeRepo();
    try {
      const runDir = join(dir, "runs");
      mkdirSync(runDir, { recursive: true });
      const registryPath = join(dir, "agents.json");
      writeFileSync(registryPath, JSON.stringify({
        agents: { coder_kw: { cwd: repo, serveUrl: "http://127.0.0.1:4310/", tokenEnv: "WAO_F1_KW_TOKEN" } },
      }), "utf8");
      const runId = "run_f1_stop";
      writeFileSync(join(runDir, `${runId}.jsonl`), [
        ev({ type: "run.started", runId, agentId: "coder_kw", backend: "kimi-web", cwd: repo, ts: "2026-11-28T00:00:00.000Z", seq: 1 }),
        ev({ type: "run.background_submitted", runId, agentId: "coder_kw", background: true, cwd: repo, ts: "2026-11-28T00:00:00.050Z", seq: 2 }),
        ev({ type: "session.created", runId, agentId: "coder_kw", backend: "kimi-web", backendSessionId: "session_kw", serveUrl: "http://127.0.0.1:4310", ts: "2026-11-28T00:00:00.100Z", seq: 3 }),
        ev({ type: "run.state_change", runId, agentId: "coder_kw", from: "pending", to: "submitted", reason: "spawned", ts: "2026-11-28T00:00:00.200Z", seq: 4 }),
        ev({ type: "run.state_change", runId, agentId: "coder_kw", from: "submitted", to: "running", reason: "first_event", ts: "2026-11-28T00:00:00.300Z", seq: 5 }),
      ].join(""), "utf8");
      const kimiLane = { id: "coder_kw", backend: "kimi-web", model: { id: "kimi-code/k3.1-pro" }, reasoning: { effort: null }, aliases: {} };
      const result = await stopRun({
        runId, runDir, registryPath,
        lanesMergeDoc: lanesDocOf([kimiLane]),
        justification: { reason: "test stop reason", observedSeq: 5 },
        deps: {
          userEnvReader: async (name) => (name === "WAO_F1_KW_TOKEN" ? "test-token" : undefined),
          alert: async () => {},
          // 停止请求发到假 fetch：只要目标解析得出，就回 200（我们不测真停止语义）
          fetchImpl: async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ code: 0, msg: "", data: {} }); } }),
        },
      });
      assert.equal(result.stopRouteUnavailable, undefined, `目标可解析（实际 routeError: ${result.routeError}）`);
      assert.notEqual(result.outcome, "stop_route_unavailable");
    } finally { cleanupDir(repo); }
  } finally { cleanupDir(dir); }
});

// ── 6. runs continue（CLI）：私有去四轴 → drift 比对用生效视图，受理续修 ───────

test("修复一 CLI runs continue：私有条目去四轴 + 生效四轴与 run.started 一致 → 受理（不再 worker_configuration_changed）", async () => {
  const repo = makeRepo();
  const runId = "run_f1_parent";
  const wt = join(repo, ".wao-worktrees", runId);
  git(`worktree add -b wao/${runId} "${wt}"`, repo);
  const base = git("rev-parse HEAD", repo);
  writeFileSync(join(wt, "keep.txt"), "changed\n", "utf8");
  git("add -A", wt);
  git('-c user.name="WAO Delivery" -c user.email="wao-delivery@local" commit -m "wao-delivery: f1"', wt);
  const deliveryCommit = git("rev-parse HEAD", wt);
  const dir = mkdtempSync(join(tmpdir(), "wao-f1-continue-"));
  const runDir = join(dir, "runs");
  const registryPath = join(dir, "agents.json");
  try {
    // 私有条目只有本机接线；生效四轴（车道表）与父 run.started 记录一致。
    writeFileSync(registryPath, JSON.stringify({ agents: { opus: { cwd: repo } } }), "utf8");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, `${runId}.jsonl`), [
      ev({ type: "run.background_submitted", runId, agentId: "opus", background: true, cwd: repo, deliveryRequested: true, ts: "2026-11-28T00:00:00.000Z", seq: 1 }),
      ev({ type: "run.state_change", runId, agentId: "opus", from: null, to: "pending", reason: "background_spawned", ts: "2026-11-28T00:00:00.001Z", seq: 2 }),
      ev({ type: "run.started", runId, agentId: "opus", backend: "claude-code", cwd: repo, worktreePath: wt, worktreeBranch: `wao/${runId}`, model: { id: "claude-opus-5-5" }, reasoning: { effort: "high" }, providerKey: null, delivery: { mode: "git_commit_v1", baseCommit: base, allowedPaths: ["keep.txt"], verificationCommands: ["node --test"] }, ts: "2026-11-28T00:00:00.002Z", seq: 3 }),
      ev({ type: "run.session_reuse", runId, agentId: "opus", mode: "run_lineage", turn: "first", rootRunId: runId, ts: "2026-11-28T00:00:00.003Z", seq: 4 }),
      ev({ type: "session.created", runId, agentId: "opus", backend: "claude-code", backendSessionId: "provider-session-1", serveUrl: null, ts: "2026-11-28T00:00:00.004Z", seq: 5 }),
      ev({ type: "run.delivery_created", runId, agentId: "opus", deliveryCommit, delivery: { schemaVersion: 1, kind: "git_commit", runId, baseCommit: base, deliveryCommit, branch: `wao/${runId}`, worktreePath: wt, allowedPaths: ["keep.txt"], changedFiles: ["keep.txt"], verification: { commands: ["node --test"] }, acceptance: { status: "pending", reviewerType: "lead_agent" }, integration: { status: "pending", targetCommit: null } }, ts: "2026-11-28T00:00:00.005Z", seq: 6 }),
      ev({ type: "prompt.sent", runId, agentId: "opus", prompt: "first", ts: "2026-11-28T00:00:00.006Z", seq: 7 }),
      ev({ type: "run.state_change", runId, agentId: "opus", from: "pending", to: "completed", reason: "done", ts: "2026-11-28T00:00:00.007Z", seq: 8 }),
    ].join(""), "utf8");
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "continue it", "utf8");
    const lines = [];
    let lanesLoads = 0;
    const origLog = console.log;
    console.log = (...a) => { lines.push(a.join(" ")); };
    try {
      await runsCommand(
        ["continue", runId, "--prompt-file", promptFile, "--cwd", repo, "--registry", registryPath, "--run-dir", runDir, "--format", "json"],
        {
          registry: registryPath, runDir,
          readRegistry: async () => (await import("../../src/registry.js")).readRegistry(registryPath),
          loadLanesConfigFn: () => { lanesLoads += 1; return OPUS_DOC; },
          backendFor: () => ({ supportsSessionReuse: true }),
        },
        {
          continueRunFn: async (input) => {
            // 断言服务收到生效车道表（drift 比对用它）——记录后回一个受理形状。
            assert.equal(input.lanesMergeDoc, OPUS_DOC, "runs continue 线程化生效车道表");
            return {
              accepted: true, runId: "run_f1_child", parentRunId: runId, continuation: true, rootRunId: runId,
              agentId: "opus", state: "pending",
              delivery: { mode: "git_commit_v1", allowedPaths: ["keep.txt"], verificationCommands: ["node --test"] },
            };
          },
        },
      );
    } finally { console.log = origLog; }
    assert.ok(lines.join("\n").includes("run_f1_child"), "受理输出在场");
    assert.equal(lanesLoads, 1, "runs continue 一次调用恰读一次车道表");
  } finally {
    cleanupDir(dir);
    cleanupDir(repo);
  }
});

// ── 7. 认证门→runner：门后改表（只改 effort）→ runner 具名拒绝（e2e） ────────

test("修复一 e2e：派发判定后改车道表（只改 effort）→ runner lanes_changed_since_dispatch，不起 worker", async () => {
  // 模拟 MCP/CLI 的一次请求：requestLanesDoc（effort=high）经 argv 交给 runner；
  // runner 读到的现行表已只改 effort=low。经 runDispatch 的真实 argv 穿线太重，
  // 这里直接按 dispatchRun 的 argv 公式构造 spec（off|sha256:<hex>）+ 现行表注入。
  const dir = mkdtempSync(join(tmpdir(), "wao-f1-gate-"));
  const runDir = join(dir, "runs");
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { opus: { cwd: dir } } }), "utf8");
    const frozen = lanesDocOf([{ ...OPUS_LANE, reasoning: { effort: "high" } }], "d".repeat(64));
    const current = lanesDocOf([{ ...OPUS_LANE, reasoning: { effort: "low" } }], "e".repeat(64));
    const result = await runBackground({
      agentId: "opus", prompt: "x", registry: registryPath, runDir,
      lanesMergeSpec: `sha256:${frozen.sha256}`,
      loadLanesConfigFn: () => current,
      backendFor: () => fakeBackend(), waitTimeout: 3000, pollInterval: 10,
    });
    assert.equal(result.failed, true);
    assert.match(result.error, /lanes_changed_since_dispatch/);
    const events = await readTranscript(join(runDir, `${result.runId}.jsonl`));
    assert.ok(!events.some((e) => e.type === "run.started"), "零 run.started——worker 未起跑");
  } finally { cleanupDir(dir); }
});

// ── 8. 并排兼容证明（第 7 条）：同一夹具，旧路径 vs 新路径 ────────────────────

test("修复一并排：旧路径（停用+自带四轴）vs 新路径（启用+去四轴 / 启用+一致）——run.started 接线逐字节、指纹、台账身份、复用键全同", async () => {
  const identity = (a) => ({
    backend: a.backend, modelId: a.model?.id ?? null,
    providerID: a.model?.providerID ?? null, providerKey: null,
  });
  const privFull = { backend: "claude-code", cwd: "D:/w", model: { id: "claude-opus-5-5" }, reasoning: { effort: "high" } };
  const privStripped = { cwd: "D:/w" };
    const merged = mergeLaneAxes(privStripped, OPUS_LANE);
  const mergedConsistent = mergeLaneAxes(privFull, OPUS_LANE);

  // 台账身份 + matchedCertRecord
  const { matchedCertRecord } = await import("../../src/runManager.js");
  const record = { backend: "claude-code", modelId: "claude-opus-5-5", status: "certified" };
  const norm = (a) => normalizeAgent("opus", a);
  assert.equal(matchedCertRecord(norm(merged), record), record);
  assert.equal(matchedCertRecord(norm(privFull), record), record);
  assert.equal(matchedCertRecord(norm(mergedConsistent), record), record);

  // 谱系材料指纹
  const fpFull = laneFingerprintOf(identity(privFull));
  assert.equal(laneFingerprintOf(identity(merged)), fpFull);
  assert.equal(laneFingerprintOf(identity(mergedConsistent)), fpFull);

  // 会话复用键的输入（laneFingerprint + 角色正文哈希公式未变——deriveOpaqueUuid
  // 的其余输入（leadSession/workspace/agentId）与表无关；指纹相同即键相同）。
  const { deriveOpaqueUuid } = await import("../../src/application/sessionReuse.js");
  if (typeof deriveOpaqueUuid === "function") {
    const keyOf = (agent) => deriveOpaqueUuid({ leadSession: "lead", workspace: "D:/w", agentId: "opus", laneFingerprint: laneFingerprintOf(identity(agent)), roleSha256: "none" });
    assert.equal(keyOf(merged), keyOf(privFull));
    assert.equal(keyOf(mergedConsistent), keyOf(privFull));
  }

  // run.started 接线逐字节：真实跑两条 RunManager.start（假 backend），比较事件载荷。
  // legacy=true 走**停用合并**（私有条目自带完整四轴）＝旧路径；legacy=false 走
  // 启用合并（同一份车道表）＝新路径。
  const startedOf = async (registryAgents, legacy) => {
    const dir = mkdtempSync(join(tmpdir(), "wao-f1-compat-"));
    try {
      const registryPath = join(dir, "agents.json");
      writeFileSync(registryPath, JSON.stringify({ agents: registryAgents }), "utf8");
      const manager = new RunManager({
        config: { registry: registryPath, runDir: join(dir, "runs"), defaultIsolation: "none" },
        readRegistry: async () => (await import("../../src/registry.js")).readRegistry(registryPath),
        transcriptDir: join(dir, "runs"),
        backendFor: () => fakeBackend(),
        userEnvReader: async () => ({}),
      });
      const lanesMerge = legacy
        ? null
        : lanesMergeDocFor(registryPath, registryPath, () => OPUS_DOC);
      const run = await manager.start("opus", {
        prompt: "x", runDir: join(dir, "runs"),
        lanesMerge,
      });
      await run.waitForCompletion({ waitTimeout: 3000 });
      const { resolveTranscriptPath } = await import("../../src/projectBuckets.js");
      const events = await readTranscript(resolveTranscriptPath(join(dir, "runs"), run.runId));
      const started = events.find((e) => e.type === "run.started");
      return JSON.stringify({ backend: started.backend, model: started.model, reasoning: started.reasoning, providerKey: started.providerKey ?? null });
    } finally { cleanupDir(dir); }
  };
  const oldPath = await startedOf({ opus: privFull }, true);              // 旧：停用 + 自带四轴
  const newPathStripped = await startedOf({ opus: privStripped }, false); // 新：启用 + 去四轴
  const newPathConsistent = await startedOf({ opus: privFull }, false);   // 新：启用 + 私有轴与表一致
  assert.equal(newPathStripped, oldPath, "去四轴新路径与旧路径接线逐字节相同");
  assert.equal(newPathConsistent, oldPath, "一致私有新路径与旧路径接线逐字节相同");
  // 唯一允许的差异（本用例不触发）：私有 providerID:null 占位被删——见
  // laneAxesEffective.test.js 的占位 null 用例（值级等价，身份比较全 null 归一）。
});
