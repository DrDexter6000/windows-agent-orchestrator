// test/delivery/runDeliveryReadBinding.test.js
//
// R20（2026-08-19，TD-128 读绑定家族末簇收口）：delivery lane 的读绑定探针。
//
//   M5 runDelivery.js —— point-in-time 查询（原 :842）、readiness 握手初始读
//      （原 :1080）与等待循环每次 poll（原 :1147）的 terminalState 改绑定过滤
//      （R15 范式 `findState(events.filter(bound))`，projectDeliveryReadiness
//      :364 文件内既有先例）。语义 = 不可归属 → "pending" 非终态路径。顾问裁
//      定登记的三个面：
//        ① isolation 投影门（gatherDeliveryView :588）同受绑定保护——比原登记
//           更宽的面（外 run 伪终态不再武装隔离结算）；
//        ② 候选"恢复出现"效应两个方向——绑定前外 run completed 尾条曾把真实
//           failed run 读成 completed、压制 backend_failed 候选分支；外 run
//           failed 尾条曾为非 failed run 凭空打开该门（process_missing 非终态
//           门同理）——候选投影自 R20 起只由本 run 自身事件门控；
//        ③ usage.md 行为变更条（候选门控）。
//   M6 runManager.js —— _externalTerminalState 绑定到本 run runId
//      （this.transcript.context.runId）；不可归属 → 不采纳（null），落既有
//      自身终态化路径（fail-closed 方向，R18 W3 注释先例）。:2192 的无绑定
//      采纳曾是交付丢失向量（伪终态 → 跳过 _finalizeDelivery → run 以
//      completed-ish 收场而交付物从未打包）——绑定即关闭。
//
// 探针诚实口径（对齐 boundReadSweep.test.js 既有各节）：只验跨 run/无信封
// 形状；同 runId 追加伪造 = runs/ 写权限攻击面，读侧无解。篡改尾条用
// 【外 run 信封的 legacy 终态 fact】（run.completed/run.aborted——findState 的
// legacy 推断路径）而非外 run state_change：这样尾部伪终态在修复前的无绑定
// findState 下真实可达（state_change 末条胜出或 legacy fact 反查），而 L2
// 登记不修的写侧 CAS（_detectExistingTerminal 只认 state_change，见
// TD-128 L2 顾问论证）不被同时武装——读侧篡改面单独钉住，不被未修面遮蔽。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getRunDelivery, getRunDeliveryReadiness } from "../../src/application/runDelivery.js";
import { RunManager } from "../../src/runManager.js";

// ----- helpers -----

async function cleanupDir(dir) {
  try { await rm(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function cleanupDirSync(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

let seqCounter = 0;
function boundLine(runId, obj) {
  seqCounter += 1;
  return JSON.stringify({ runId, agentId: "coder_low", ts: "2026-08-19T00:00:00.000Z", seq: seqCounter, ...obj });
}

function foreignLine(obj) {
  return JSON.stringify({ ts: "2026-08-19T00:00:00.900Z", seq: 999, runId: "run_evil", agentId: "coder_low", ...obj });
}

function writeRun(dir, runId, lines) {
  writeFileSync(join(dir, `${runId}.jsonl`), `${lines.join("\n")}\n`, "utf8");
}

function appendForeign(dir, runId, obj) {
  appendFileSync(join(dir, `${runId}.jsonl`), `${foreignLine(obj)}\n`, "utf8");
}

// delivery 意图事实（_deliveryWasRequested 认 run.started.delivery.mode）。
function startedWithDelivery(runId) {
  return boundLine(runId, {
    type: "run.started",
    backend: "claude-code",
    delivery: { mode: "git_commit_v1", allowedPaths: ["src"] },
  });
}

// =====================================================================
// M5-a：point-in-time 查询（原 :842）——候选"恢复出现"效应两个方向
// =====================================================================

test("R20-DLV-1: 篡改探针 — terminalState 双向绑定：外 run completed 尾条不再压制真实 failed（backend_failed 候选门输入）；外 run failed 尾条不再凭空武装该门", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20-dlv1-"));
  try {
    // (a) 真实 failed（backend_error）+ 外 run completed 尾条：修复前 findState
    //     末条胜出读成 completed → :863 的 failed 门永不成立（候选被压制）。
    const runA = "run_r20_dlv1a";
    writeRun(dir, runA, [
      startedWithDelivery(runA),
      boundLine(runA, { type: "run.state_change", from: "running", to: "failed", reason: "backend_error" }),
    ]);
    appendForeign(dir, runA, { type: "run.completed" });
    const viewA = await getRunDelivery({ runId: runA, runDir: dir });
    assert.equal(viewA.terminalState, "failed", "终态只由本 run 绑定事件计算（修复前 completed——backend_failed 候选门输入被外 run 尾条压制）");
    assert.equal(viewA.deliveryRequested, true, "delivery 意图来自本 run 绑定 run.started");

    // (b) 真实在飞（running）+ 外 run failed 尾条：修复前读成 failed → :863
    //     的 failed 门凭空成立（无中生有的候选）。绑定后保持非终态路径。
    const runB = "run_r20_dlv1b";
    writeRun(dir, runB, [
      startedWithDelivery(runB),
      boundLine(runB, { type: "run.state_change", from: "pending", to: "running", reason: "first_event" }),
    ]);
    appendForeign(dir, runB, { type: "run.error", phase: "wait", error: "process exited with code 1" });
    appendForeign(dir, runB, { type: "run.failed" });
    const viewB = await getRunDelivery({ runId: runB, runDir: dir });
    assert.equal(viewB.terminalState, "running", "在飞 run 不被外 run 伪 failed 尾条翻成终态（修复前 failed——候选门凭空武装）");
    assert.equal(viewB.deliveryAvailable, false);
  } finally { cleanupDirSync(dir); }
});

// =====================================================================
// M5-b：isolation 投影门（gatherDeliveryView :588，登记点 ①）
// =====================================================================

test("R20-DLV-2: 篡改探针 — isolation 投影门同受绑定保护：外 run 伪终态不再把非终态 run 武装成隔离结算", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20-dlv2-"));
  try {
    // 本 run 在飞（running）+ 绑定的 workdir_escape 违规事实 + 外 run completed
    // 尾条。修复前 terminalState 读成 completed → :588 的 TERMINAL gate 成立 →
    // isolationFailure 在 run 并未终态时浮出（比原登记更宽的面）。
    const runId = "run_r20_dlv2";
    writeRun(dir, runId, [
      startedWithDelivery(runId),
      boundLine(runId, { type: "run.state_change", from: "pending", to: "running", reason: "first_event" }),
      boundLine(runId, { type: "run.isolation_violation", code: "workdir_escape", reason: "file_written_lexical_outside" }),
    ]);
    appendForeign(dir, runId, { type: "run.completed" });

    const view = await getRunDelivery({ runId, runDir: dir });
    assert.equal(view.terminalState, "running", "本 run 自身非终态");
    assert.equal(view.isolationFailure, undefined,
      "isolation 投影门以绑定后的 terminalState 为输入——外 run 伪终态不再武装隔离结算（run 未终态，保持 waiting 形状）");
    assert.equal(view.deliveryAvailable, false);

    // 对照（合法语义回归）：本 run 自身终态 + 绑定违规 → 隔离结算照常浮出
    // （绑定不改变 :588 门在诚实事实上的行为）。
    const runId2 = "run_r20_dlv2b";
    writeRun(dir, runId2, [
      startedWithDelivery(runId2),
      boundLine(runId2, { type: "run.state_change", from: "running", to: "failed", reason: "workdir_escape" }),
      boundLine(runId2, { type: "run.isolation_violation", code: "workdir_escape" }),
    ]);
    const view2 = await getRunDelivery({ runId: runId2, runDir: dir });
    assert.equal(view2.terminalState, "failed");
    assert.deepEqual(view2.isolationFailure, { code: "workdir_escape", reason: null }, "诚实终态 + 绑定违规 → 隔离结算照常（合法路径零变化）");
  } finally { cleanupDirSync(dir); }
});

// =====================================================================
// M5-c：readiness 握手（原 :1080 初始读 + 原 :1147 poll）
// =====================================================================

test("R20-DLV-3: 篡改探针 — readiness 初始读与 poll 快照的 terminalState 同款绑定（伪终态尾条不进入等待结果）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20-dlv3-"));
  try {
    // (a) 初始读快照即带外 run completed 尾条：readiness 本身经 :364 既有绑定
    //     保持 waiting；terminalState 不再被尾条读成 completed。
    const runA = "run_r20_dlv3a";
    writeRun(dir, runA, [
      startedWithDelivery(runA),
      boundLine(runA, { type: "run.state_change", from: "pending", to: "running", reason: "first_event" }),
    ]);
    appendForeign(dir, runA, { type: "run.completed" });
    let clock = 1_000_000;
    const outA = await getRunDeliveryReadiness({
      runId: runA, runDir: dir, waitMs: 1000,
      nowFn: () => clock, sleepFn: async (ms) => { clock += ms; }, pollIntervalMs: 600,
    });
    assert.equal(outA.readiness, "waiting_for_packaging", "readiness 只由绑定事件投影（:364 既有绑定，恒定）");
    assert.equal(outA.terminalState, "running", "初始读的 terminalState 绑定（修复前 completed）");
    assert.equal(outA.waitReturnedEarly, false, "等待窗如实耗尽");

    // (b) poll 内出现外 run 伪终态尾条（第一次读干净、后续读带尾条）：等待
    //     结果的 terminalState 不被 poll 快照里的尾条翻转。
    const runB = "run_r20_dlv3b";
    const cleanLines = [
      startedWithDelivery(runB),
      boundLine(runB, { type: "run.state_change", from: "pending", to: "running", reason: "first_event" }),
    ];
    let readCalls = 0;
    const filePath = join(dir, `${runB}.jsonl`);
    const readTranscriptFn = async () => {
      readCalls += 1;
      if (readCalls === 1) return cleanLines.map((l) => JSON.parse(l));
      return [...cleanLines.map((l) => JSON.parse(l)), JSON.parse(foreignLine({ type: "run.completed" }))];
    };
    clock = 1_000_000;
    const outB = await getRunDeliveryReadiness({
      runId: runB, runDir: dir, waitMs: 1000,
      nowFn: () => clock, sleepFn: async (ms) => { clock += ms; }, pollIntervalMs: 400,
      readTranscriptFn,
    });
    assert.ok(readCalls >= 2, "至少一次 poll 读到带伪尾条的快照");
    assert.equal(outB.readiness, "waiting_for_packaging");
    assert.equal(outB.terminalState, "running", "poll 快照的 terminalState 同款绑定（修复前 completed）");
    assert.equal(outB.waitReturnedEarly, false);
    // 静态 lint：未读文件不存在也不影响注入路径（readTranscriptFn 全程接管）。
    assert.equal(typeof filePath, "string");
  } finally { cleanupDirSync(dir); }
});

// =====================================================================
// M5-d：合法路径回归（全绑定输入 → 过滤器恒等 → 输出零变化）
// =====================================================================

test("R20-DLV-4: 合法路径回归 — 全绑定 delivery 事实照常投影（packaging_failed 结算与 failed 终态零变化）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-r20-dlv4-"));
  try {
    const runId = "run_r20_dlv4";
    writeRun(dir, runId, [
      startedWithDelivery(runId),
      boundLine(runId, { type: "run.state_change", from: "running", to: "failed", reason: "delivery_failed" }),
      boundLine(runId, { type: "run.delivery_failed", deliveryCode: "base_commit_mismatch", message: "HEAD moved" }),
    ]);
    const view = await getRunDelivery({ runId, runDir: dir });
    assert.equal(view.terminalState, "failed");
    assert.equal(view.deliveryAvailable, false);
    assert.equal(view.deliveryRequested, true);
    assert.equal(view.deliveryFailure.code, "base_commit_mismatch", "绑定事实照常投影 packaging failure");
    const out = await getRunDeliveryReadiness({ runId, runDir: dir, waitMs: 1000 });
    assert.equal(out.readiness, "packaging_failed", "非 waiting readiness 立即返回（合法路径零变化）");
    assert.equal(out.terminalState, "failed");
  } finally { cleanupDirSync(dir); }
});

// =====================================================================
// M6：runManager._externalTerminalState —— 交付丢失向量（:2192 无绑定采纳）
// =====================================================================

async function makeRepo(prefix = "wao-r20-rm-repo-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@test"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "test"', { cwd: dir, stdio: "ignore" });
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "a.js"), "const a = 1;\n");
  await writeFile(join(dir, ".gitignore"), "node_modules/\n*.env\n.wao-worktrees/\n");
  execSync("git add .", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });
  const baseCommit = execSync("git rev-parse HEAD", {
    cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  }).trim();
  return { repo: dir, baseCommit };
}

const dummyVerifier = async (deliveryRef) => ({
  delivery: {
    ...deliveryRef,
    verification: { ...deliveryRef.verification, status: "passed", verifiedCommit: deliveryRef.deliveryCommit, results: [] },
  },
  outcome: "passed",
});

// done-only backend：事件流只 yield done(completed)，零 message/metrics 事件。
// 这使 waitForCompletion 不写 "running" state_change（markRunningOnce 只由
// message/metrics/thinking/证据事件触发）——start 后追加的伪终态尾条在本 run
// 自身最后一条 state_change（submitted）之后，修复前的无绑定 findState 真实
// 读到它（legacy fact 反查），探针确定性可达。声明 role-contract 支持以满足
// M11-8C delivery 合同注入门（与 runDelivery.test.js 3A 套件同款接线）。
function makeDoneOnlyBackend() {
  return {
    supportsRoleContract: true,
    validateRoleContractTransport: async () => {},
    async spawn() {
      return {
        backend: "process",
        backendSessionId: "proc_r20_done",
        async *events() {
          yield { kind: "done", reason: "completed" };
        },
        abort: async () => {},
        isAlive: () => false,
      };
    },
  };
}

function makeManagerWithPackager(runDir, repoDir, packageDeliveryFn) {
  const config = { registry: "x", runDir, pollInterval: 10, waitTimeout: 5000, timeout: 5000, retries: 0, defaultIsolation: "none" };
  const readRegistry = async () => ({
    getAgent(id, overrides = {}) {
      const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
      // 无结构化 policy（model/reasoning/provider）——绕开 validateAgentPolicy
      // 能力门（boundReadSweep.makeManager 同款最小 agent 形状）。
      return { id, backend: "claude-code", cwd: repoDir, ...defined };
    },
    listAgents() { return []; },
  });
  return new RunManager({
    config,
    readRegistry,
    backendFor: () => makeDoneOnlyBackend(),
    packageDeliveryFn,
    verifyDeliveryFn: dummyVerifier,
  });
}

test("R20-RM-DLV-1: 篡改探针 — 外 run 伪终态尾条不再造成交付丢失（_finalizeDelivery 照常执行、打包器恰被调用一次、run 诚实 completed）", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "wao-r20-rm-runs-"));
  let packageCount = 0;
  try {
    const fakeRef = {
      runId: "run_r20_rm1",
      worktreePath: join(repo, ".wao-worktrees", "run_r20_rm1"),
      baseCommit,
      deliveryCommit: "a".repeat(40),
      changedFiles: ["src/a.js"],
      verification: { status: "pending" },
    };
    const mgr = makeManagerWithPackager(runDir, repo, () => {
      packageCount += 1;
      return fakeRef;
    });
    const runId = "run_r20_rm1";
    const run = await mgr.start("test", {
      prompt: "hi", isolate: true, runId,
      delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"] },
    });
    assert.ok(run.deliveryContext, "delivery 上下文就绪");

    // 交付丢失向量形状：尾部追加【外 run 信封】的 legacy 终态 fact。修复前
    // _externalTerminalState 的无绑定 findState 经 legacy 反查读到 "aborted" →
    // :2192 采纳 preTerminal → 跳过 _finalizeDelivery → 交付物从未打包、run 以
    // aborted loser 收场。绑定后外 run 行不可见 → null → 打包照常。
    // （fact 形状同时避开 L2 登记不修的写侧 CAS——_detectExistingTerminal 只认
    // state_change，见文件头诚实口径。）
    appendFileSync(join(runDir, `${runId}.jsonl`), `${foreignLine({ type: "run.aborted", reason: "evil" })}\n`, "utf8");

    const result = await run.waitForCompletion({ waitTimeout: 5000, pollInterval: 50 });
    assert.equal(packageCount, 1, "打包器恰被调用一次（修复前 0——伪终态采纳跳过 _finalizeDelivery，交付物从未打包）");
    assert.equal(result.completed, true, "run 以自身完成路径诚实收场（修复前采纳外 run aborted）");
    assert.ok(result.delivery, "结果携带交付 DeliveryRef（修复前 loser 结果无交付）");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});
